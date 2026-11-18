/**
 * Artifact storage: one directory per session/call with the complete stdout and
 * stderr bytes, the rendered summary, and a manifest. The plugin owns cleanup;
 * writes are atomic and a quota failure makes the caller keep the original
 * output instead.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { artifactRef, safeSegment, statePaths } from './paths.mjs'
import { readJson } from './read.mjs'
import { writeFileAtomic, writeJsonAtomic } from './write.mjs'

export const ARTIFACT_SCHEMA = 'dsh.tool-output-compress/artifact@1'
export const PIN_SCHEMA = 'dsh.tool-output-compress/pin@1'
export const RULE_VERSION = 1

const IN_FLIGHT_MS = 10 * 60_000

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function lineCount(text) {
  if (text === '') return 0
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/** Total bytes of every regular file under `dir`; 0 when absent. */
export function directorySize(dir, { fs: fileSystem = fs } = {}) {
  let total = 0
  const walk = current => {
    let entries
    try {
      entries = fileSystem.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        try { total += fileSystem.statSync(full).size } catch { /* vanished */ }
      }
    }
  }
  walk(dir)
  return total
}

function callDirectories(root, { fs: fileSystem = fs } = {}) {
  const found = []
  let sessions
  try {
    sessions = fileSystem.readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const session of sessions) {
    if (!session.isDirectory()) continue
    const sessionDir = path.join(root, session.name)
    let calls
    try {
      calls = fileSystem.readdirSync(sessionDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const call of calls) {
      if (!call.isDirectory()) continue
      const dir = path.join(sessionDir, call.name)
      let mtimeMs = 0
      try { mtimeMs = fileSystem.statSync(dir).mtimeMs } catch { /* vanished */ }
      found.push({ dir, session: session.name, call: call.name, mtimeMs })
    }
  }
  return found
}

/**
 * @param {{stateDir: string, config: object, fs?: typeof fs, now?: () => number}} options
 */
export function createArtifactStore({ stateDir, config, fs: fileSystem = fs, now = Date.now }) {
  const paths = statePaths(stateDir)

  function quotaError() {
    const error = new Error('artifact quota exceeded')
    error.code = 'QUOTA'
    return error
  }

  function gcInternal() {
    const cutoff = now() - config.retentionDays * 24 * 60 * 60 * 1000
    const protectAfter = now() - IN_FLIGHT_MS
    let removed = 0
    let freedBytes = 0
    let kept = 0
    for (const entry of callDirectories(paths.artifacts, { fs: fileSystem })) {
      const size = directorySize(entry.dir, { fs: fileSystem })
      if (entry.mtimeMs !== 0 && entry.mtimeMs < cutoff && entry.mtimeMs < protectAfter) {
        try {
          fileSystem.rmSync(entry.dir, { recursive: true, force: true })
          removed += 1
          freedBytes += size
        } catch {
          kept += 1
        }
      } else {
        kept += 1
      }
    }
    return { removed, freedBytes, kept }
  }

  function gc({ dryRun = false } = {}) {
    const cutoff = now() - config.retentionDays * 24 * 60 * 60 * 1000
    const protectAfter = now() - IN_FLIGHT_MS
    let removed = 0
    let freedBytes = 0
    let kept = 0
    for (const entry of callDirectories(paths.artifacts, { fs: fileSystem })) {
      const size = directorySize(entry.dir, { fs: fileSystem })
      const expired = entry.mtimeMs !== 0 && entry.mtimeMs < cutoff && entry.mtimeMs < protectAfter
      if (!expired) {
        kept += 1
        continue
      }
      if (dryRun) {
        removed += 1
        freedBytes += size
        continue
      }
      try {
        fileSystem.rmSync(entry.dir, { recursive: true, force: true })
        removed += 1
        freedBytes += size
      } catch {
        kept += 1
      }
    }
    return { removed, freedBytes, kept, dryRun, retentionDays: config.retentionDays }
  }

  /**
   * Persist one artifact set. Rejects on quota or storage failure; the caller
   * degrades to the original tool result.
   */
  function store({ sessionId, callId, tool, streams, summary, markers, ranges }) {
    const ref = artifactRef(sessionId, callId)
    const finalDir = path.join(paths.artifacts, safeSegment(sessionId), safeSegment(callId))
    const incoming = streams.reduce((total, stream) => total + Buffer.byteLength(stream.text, 'utf8'), 0)
      + Buffer.byteLength(summary, 'utf8') + 4096
    const used = directorySize(paths.artifacts, { fs: fileSystem }) + directorySize(paths.pinned, { fs: fileSystem })
    if (used + incoming > config.quotaBytes) {
      gcInternal()
      const after = directorySize(paths.artifacts, { fs: fileSystem }) + directorySize(paths.pinned, { fs: fileSystem })
      if (after + incoming > config.quotaBytes) throw quotaError()
    }

    const manifest = {
      schema: ARTIFACT_SCHEMA,
      ruleVersion: RULE_VERSION,
      tool,
      callId,
      sessionId,
      ref,
      createdAtMs: now(),
      createdAt: new Date(now()).toISOString(),
      streams: streams.map(stream => ({
        name: stream.name,
        file: `${stream.name}.raw`,
        bytes: Buffer.byteLength(stream.text, 'utf8'),
        lines: lineCount(stream.text),
        sha256: sha256(stream.text),
        source: stream.source,
      })),
      markers,
      summary: { file: 'summary.txt', bytes: Buffer.byteLength(summary, 'utf8'), lines: lineCount(summary), sha256: sha256(summary) },
      ranges,
    }

    const previous = readJson(path.join(finalDir, 'manifest.json'), { fs: fileSystem }).value
    if (previous !== null
      && previous.summary?.sha256 === manifest.summary.sha256
      && previous.streams?.length === manifest.streams.length
      && previous.streams.every((stream, index) => stream.sha256 === manifest.streams[index].sha256)) {
      return { dir: finalDir, manifest: previous, reused: true }
    }

    const temporary = `${finalDir}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
    fileSystem.mkdirSync(temporary, { recursive: true, mode: 0o700 })
    try {
      for (const stream of streams) {
        writeFileAtomic(path.join(temporary, `${stream.name}.raw`), stream.text, { fs: fileSystem })
      }
      writeFileAtomic(path.join(temporary, 'summary.txt'), summary, { fs: fileSystem })
      writeJsonAtomic(path.join(temporary, 'manifest.json'), manifest, { fs: fileSystem })
      fileSystem.rmSync(finalDir, { recursive: true, force: true })
      fileSystem.renameSync(temporary, finalDir)
    } catch (error) {
      try { fileSystem.rmSync(temporary, { recursive: true, force: true }) } catch { /* best effort */ }
      throw error
    }
    return { dir: finalDir, manifest, reused: false }
  }

  function resolve(ref) {
    if (typeof ref !== 'string' || ref.trim() === '') return null
    const base = path.resolve(paths.dir)
    if (path.isAbsolute(ref)) {
      const resolved = path.resolve(ref)
      if (!resolved.startsWith(`${base}${path.sep}`)) return null
      return fileSystem.existsSync(resolved) ? resolved : null
    }
    const parts = ref.split('/').filter(part => part !== '')
    if (parts.length < 2) return null
    const dir = path.join(paths.artifacts, parts.map(part => safeSegment(part)).slice(0, 2).join(path.sep))
    return fileSystem.existsSync(dir) ? dir : null
  }

  function pin({ ref, owner }) {
    const source = resolve(ref)
    if (source === null) throw Object.assign(new Error(`artifact not found: ${ref}`), { code: 'ENOENT' })
    const manifest = readJson(path.join(source, 'manifest.json'), { fs: fileSystem }).value
    const target = path.join(paths.pinned, `${safeSegment(ref.replace(/\//g, '__'))}-${now()}`)
    fileSystem.mkdirSync(paths.pinned, { recursive: true, mode: 0o700 })
    fileSystem.cpSync(source, target, { recursive: true })
    writeJsonAtomic(path.join(target, 'pin.json'), {
      schema: PIN_SCHEMA,
      ref,
      owner,
      pinnedAtMs: now(),
      pinnedAt: new Date(now()).toISOString(),
      artifactSha256: manifest?.summary?.sha256 ?? null,
    }, { fs: fileSystem })
    return { dir: target, ref, owner }
  }

  function list({ limit = 50 } = {}) {
    const rows = []
    for (const entry of callDirectories(paths.artifacts, { fs: fileSystem })) {
      const manifest = readJson(path.join(entry.dir, 'manifest.json'), { fs: fileSystem }).value
      if (manifest === null) continue
      rows.push({ ...manifest, dir: entry.dir, mtimeMs: entry.mtimeMs })
    }
    rows.sort((left, right) => right.createdAtMs - left.createdAtMs)
    return Number.isFinite(limit) ? rows.slice(0, limit) : rows
  }

  return { paths, store, gc, pin, resolve, list, directorySize }
}
