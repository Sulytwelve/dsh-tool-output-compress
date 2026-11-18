#!/usr/bin/env node
/**
 * `dsh-tool-output-compress` — read the artifacts, inspect retention, and
 * benchmark the deterministic summarizer. The hook never calls this file.
 */

import fs from 'node:fs'
import path from 'node:path'
import { defaultStateDir, statePaths } from '../lib/paths.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { createArtifactStore } from '../lib/artifacts.mjs'
import { summarize } from '../lib/summarize.mjs'
import { readJson } from '../lib/read.mjs'
import { ownVersion } from '../lib/version.mjs'

const EXIT = { ok: 0, error: 1, warn: 2 }
const POINTER_PLACEHOLDER = '[full output: <artifact dir> (stdout.raw, stderr.raw, summary.txt, manifest.json) · rule v1]'

function usage() {
  return `dsh-tool-output-compress ${ownVersion()}

Usage:
  dsh-tool-output-compress status [--json] [--state-dir DIR]
  dsh-tool-output-compress list [--limit N] [--json]
  dsh-tool-output-compress show <ref> [--stream stdout|stderr] [--lines A-B] [--json]
  dsh-tool-output-compress path <ref> [--json]
  dsh-tool-output-compress pin <ref> --for <owner>
  dsh-tool-output-compress gc [--dry-run] [--json]
  dsh-tool-output-compress bench --stdout FILE [--stderr FILE] [--exit N] [--target N] [--json]
  dsh-tool-output-compress doctor [--json]
  dsh-tool-output-compress version

Exit codes: 0 ok, 2 warning (quota pressure), 1 failure.`
}

function parseArgs(argv) {
  const flags = { command: undefined, arg: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--json') flags.json = true
    else if (value === '--dry-run') flags.dryRun = true
    else if (value === '--help' || value === '-h') flags.help = true
    else if (value === '--state-dir' || value === '--root') flags.stateDir = argv[++index]
    else if (value === '--limit') flags.limit = Number(argv[++index])
    else if (value === '--stream') flags.stream = argv[++index]
    else if (value === '--lines') flags.lines = argv[++index]
    else if (value === '--for') flags.owner = argv[++index]
    else if (value === '--stdout') flags.stdout = argv[++index]
    else if (value === '--stderr') flags.stderr = argv[++index]
    else if (value === '--exit') flags.exitCode = Number(argv[++index])
    else if (value === '--target') flags.target = Number(argv[++index])
    else if (!value.startsWith('-') && flags.command === undefined) flags.command = value
    else if (!value.startsWith('-') && flags.arg === undefined) flags.arg = value
  }
  return flags
}

function resolveState(flags) {
  return flags.stateDir === undefined ? defaultStateDir() : path.resolve(flags.stateDir)
}

function context(flags) {
  const stateDir = resolveState(flags)
  const { config } = normalizeConfig({})
  return { stateDir, config, store: createArtifactStore({ stateDir, config }) }
}

function bytesText(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function parseLines(spec) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(spec ?? ''))
  if (match === null) return null
  const start = Number(match[1])
  const end = match[2] === undefined ? start : Number(match[2])
  if (start < 1 || end < start) return null
  return { start, end }
}

function cmdStatus(flags) {
  const { stateDir, config, store } = context(flags)
  const loaded = readJson(statePaths(stateDir).loaded).value
  const rows = store.list({ limit: 1_000_000 })
  const bytes = store.directorySize(statePaths(stateDir).artifacts) + store.directorySize(statePaths(stateDir).pinned)
  const quotaUsed = config.quotaBytes === 0 ? 0 : bytes / config.quotaBytes
  const report = {
    stateDir,
    loaded,
    artifacts: { count: rows.length, bytes, quotaBytes: config.quotaBytes, quotaUsed },
    defaults: { thresholdBytes: config.thresholdBytes, targetBytes: config.targetBytes, retentionDays: config.retentionDays },
  }
  if (flags.json) printJson(report)
  else {
    process.stdout.write(`tool-output-compress ${ownVersion()} · state ${stateDir}\n`)
    process.stdout.write(loaded === null
      ? 'host hook  : no plugin-loaded.json (the Host row has not loaded with this state directory)\n'
      : `host hook  : loaded v${loaded.version} pid ${loaded.pid}; post-execute=${loaded.hooks?.postExecute === true ? 'yes' : 'no'}; self-test=${loaded.selfTest?.ok === true ? 'ok' : 'failed'}\n`)
    process.stdout.write(`artifacts  : ${rows.length} · ${bytesText(bytes)} / ${bytesText(config.quotaBytes)} (${(quotaUsed * 100).toFixed(1)}%)\n`)
    process.stdout.write(`defaults   : threshold ${config.thresholdBytes}B · target ${config.targetBytes}B · retention ${config.retentionDays}d (calibrate-required)\n`)
  }
  return quotaUsed > 0.9 ? EXIT.warn : EXIT.ok
}

function cmdList(flags) {
  const { store } = context(flags)
  const rows = store.list({ limit: Number.isFinite(flags.limit) ? flags.limit : 20 })
  if (flags.json) printJson(rows)
  else if (rows.length === 0) process.stdout.write('no artifacts\n')
  else {
    for (const row of rows) {
      process.stdout.write(`${row.ref} · ${row.tool} · stdout ${row.streams?.find(stream => stream.name === 'stdout')?.bytes ?? 0}B · ${row.createdAt} · rule v${row.ruleVersion}\n`)
    }
  }
  return EXIT.ok
}

function cmdShow(flags) {
  const ref = flags.arg
  if (ref === undefined) {
    process.stderr.write('show: pass an artifact ref (session/call) or directory\n')
    return EXIT.error
  }
  const { store } = context(flags)
  const dir = store.resolve(ref)
  if (dir === null) {
    process.stderr.write(`show: artifact not found or expired: ${ref}\n`)
    return EXIT.error
  }
  const manifest = readJson(path.join(dir, 'manifest.json')).value
  const range = flags.lines === undefined ? null : parseLines(flags.lines)
  if (flags.lines !== undefined && range === null) {
    process.stderr.write('show: --lines expects A or A-B with A>=1\n')
    return EXIT.error
  }
  if (range === null) {
    const summary = fs.readFileSync(path.join(dir, 'summary.txt'), 'utf8')
    if (flags.json) printJson({ dir, manifest, summary })
    else process.stdout.write(`${summary}\n`)
    return EXIT.ok
  }
  const stream = flags.stream === 'stderr' ? 'stderr' : 'stdout'
  const file = path.join(dir, `${stream}.raw`)
  if (!fs.existsSync(file)) {
    process.stderr.write(`show: no ${stream} stream in ${dir}\n`)
    return EXIT.error
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const slice = lines.slice(range.start - 1, range.end)
  if (flags.json) printJson({ dir, stream, start: range.start, end: range.start + slice.length - 1, lines: slice })
  else slice.forEach((line, index) => process.stdout.write(`${range.start + index}: ${line}\n`))
  return EXIT.ok
}

function cmdPath(flags) {
  const ref = flags.arg
  const { store } = context(flags)
  const dir = ref === undefined ? null : store.resolve(ref)
  if (dir === null) {
    process.stderr.write(`path: artifact not found or expired: ${ref ?? '(none)'}\n`)
    return EXIT.error
  }
  if (flags.json) printJson({ dir, stdout: path.join(dir, 'stdout.raw'), stderr: path.join(dir, 'stderr.raw'), manifest: path.join(dir, 'manifest.json') })
  else {
    process.stdout.write(`${dir}\nstdout: ${path.join(dir, 'stdout.raw')}\nstderr: ${path.join(dir, 'stderr.raw')}\nmanifest: ${path.join(dir, 'manifest.json')}\n`)
  }
  return EXIT.ok
}

function cmdPin(flags) {
  const ref = flags.arg
  if (ref === undefined || flags.owner === undefined) {
    process.stderr.write('pin: usage: pin <ref> --for <owner>\n')
    return EXIT.error
  }
  const { store } = context(flags)
  try {
    const pinned = store.pin({ ref, owner: flags.owner })
    if (flags.json) printJson(pinned)
    else process.stdout.write(`pinned ${ref} → ${pinned.dir} (owner ${pinned.owner})\n`)
    return EXIT.ok
  } catch (error) {
    process.stderr.write(`pin: ${error.message}\n`)
    return EXIT.error
  }
}

function cmdGc(flags) {
  const { store } = context(flags)
  const result = store.gc({ dryRun: flags.dryRun === true })
  if (flags.json) printJson(result)
  else process.stdout.write(`${result.dryRun ? 'would remove' : 'removed'} ${result.removed} artifact dir(s), ${bytesText(result.freedBytes)}; kept ${result.kept} (retention ${result.retentionDays}d)\n`)
  return EXIT.ok
}

function cmdBench(flags) {
  if (typeof flags.stdout !== 'string') {
    process.stderr.write('bench: --stdout FILE is required (use --stderr FILE for the second stream)\n')
    return EXIT.error
  }
  const read = file => fs.readFileSync(file, 'utf8')
  let stdout
  let stderr = ''
  try {
    stdout = read(flags.stdout)
    if (typeof flags.stderr === 'string') stderr = read(flags.stderr)
  } catch (error) {
    process.stderr.write(`bench: ${error.message}\n`)
    return EXIT.error
  }
  const config = normalizeConfig({ targetBytes: flags.target }).config
  const beforeBytes = Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8')
  const startedAt = process.hrtime.bigint()
  const summary = summarize({
    streams: [{ name: 'stdout', text: stdout }, { name: 'stderr', text: stderr }],
    markers: flags.exitCode === undefined ? [] : [`[exit code: ${flags.exitCode}]`],
    targetBytes: config.targetBytes,
    maxBytes: config.maxSummaryBytes,
  })
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  if (summary === null) {
    process.stderr.write('bench: summary exceeded maxSummaryBytes; the hook would keep the original output\n')
    return EXIT.error
  }
  const afterBytes = Buffer.byteLength(summary.text, 'utf8') + Buffer.byteLength(POINTER_PLACEHOLDER, 'utf8') + 1
  const tokens = bytes => Math.ceil(bytes / 4)
  const report = {
    files: { stdout: flags.stdout, stderr: flags.stderr ?? null },
    before: { bytes: beforeBytes, lines: (stdout + stderr).split('\n').length, estTokens: tokens(beforeBytes) },
    after: { bytes: afterBytes, lines: summary.text.split('\n').length, estTokens: tokens(afterBytes) },
    saved: { bytes: beforeBytes - afterBytes, estTokens: tokens(beforeBytes) - tokens(afterBytes), ratio: beforeBytes === 0 ? 0 : 1 - afterBytes / beforeBytes },
    ranges: summary.ranges.length,
    omittedLines: summary.omitted,
    elapsedMs,
    tokenizer: 'dsh-token-meter heuristic: 4 chars/token (harness estimate, not the provider tokenizer)',
    ruleVersion: 1,
  }
  if (flags.json) printJson(report)
  else {
    process.stdout.write(`before ${beforeBytes} B / ${report.before.lines} L / ~${report.before.estTokens} tok (heuristic)\n`)
    process.stdout.write(`after  ${afterBytes} B / ${report.after.lines} L / ~${report.after.estTokens} tok (incl. pointer)\n`)
    process.stdout.write(`saved  ${report.saved.bytes} B (${(report.saved.ratio * 100).toFixed(1)}%) · ~${report.saved.estTokens} tok · ${report.ranges} ranges · ${elapsedMs.toFixed(2)} ms\n`)
  }
  return EXIT.ok
}

function cmdDoctor(flags) {
  const { stateDir, config, store } = context(flags)
  const checks = []
  const add = (name, level, detail) => checks.push({ name, level, detail })
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const probe = path.join(stateDir, `.doctor-${process.pid}`)
    fs.writeFileSync(probe, 'ok', { mode: 0o600 })
    fs.rmSync(probe, { force: true })
    add('state directory', 'ok', `${stateDir} is writable`)
  } catch (error) {
    add('state directory', 'fail', `${stateDir}: ${error.message}`)
  }
  const loaded = readJson(statePaths(stateDir).loaded).value
  if (loaded === null) add('host hook', 'warn', 'no plugin-loaded.json; the Host row has not loaded here')
  else {
    add('host hook', loaded.selfTest?.ok === true ? 'ok' : 'fail',
      `v${loaded.version} pid ${loaded.pid}; self-test ${loaded.selfTest?.ok === true ? 'ok' : 'failed'}; tools ${(loaded.tools ?? []).join(',') || '(none)'}`)
  }
  const bytes = store.directorySize(statePaths(stateDir).artifacts) + store.directorySize(statePaths(stateDir).pinned)
  const ratio = bytes / config.quotaBytes
  add('quota', ratio > 0.9 ? 'warn' : 'ok', `${bytesText(bytes)} / ${bytesText(config.quotaBytes)} (${(ratio * 100).toFixed(1)}%)`)
  add('policy', 'ok', `threshold ${config.thresholdBytes}B · target ${config.targetBytes}B · retention ${config.retentionDays}d · rule v1 (all calibrate-required)`)
  const failed = checks.filter(check => check.level === 'fail').length
  if (flags.json) printJson({ stateDir, checks, ok: failed === 0 })
  else {
    for (const check of checks) process.stdout.write(`[${check.level}] ${check.name}: ${check.detail}\n`)
    process.stdout.write(`doctor: ${failed === 0 ? 'no failures' : `${failed} failure(s)`}\n`)
  }
  return failed === 0 ? EXIT.ok : EXIT.error
}

function main() {
  const flags = parseArgs(process.argv.slice(2))
  if (flags.help) {
    process.stdout.write(`${usage()}\n`)
    return EXIT.ok
  }
  switch (flags.command ?? 'status') {
    case 'status': return cmdStatus(flags)
    case 'list': return cmdList(flags)
    case 'show': return cmdShow(flags)
    case 'path': return cmdPath(flags)
    case 'pin': return cmdPin(flags)
    case 'gc': return cmdGc(flags)
    case 'bench': return cmdBench(flags)
    case 'doctor': return cmdDoctor(flags)
    case 'version':
      process.stdout.write(`dsh-tool-output-compress ${ownVersion()} (node ${process.version})\n`)
      return EXIT.ok
    default:
      process.stderr.write(`unknown command: ${flags.command}\n\n${usage()}\n`)
      return EXIT.error
  }
}

process.exitCode = main()
