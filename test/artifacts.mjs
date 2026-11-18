import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createArtifactStore } from '../lib/artifacts.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { tempDir } from './support/fixtures.mjs'

function makeStore(dir, overrides = {}) {
  const { config } = normalizeConfig({})
  return createArtifactStore({ stateDir: dir, config: { ...config, ...overrides } })
}

function streams() {
  return [
    { name: 'stdout', text: 'line one\nline two\n', source: 'rendered' },
    { name: 'stderr', text: 'fatal: x\n', source: 'spill' },
  ]
}

function storeOne(store, callId = 'call-1') {
  return store.store({
    sessionId: 'session-1',
    callId,
    tool: 'bash',
    streams: streams(),
    summary: 'summary text',
    markers: ['[exit code: 2]'],
    ranges: [{ stream: 'stdout', start: 0, end: 1, kind: 'head' }],
  })
}

test('an artifact keeps complete streams, summary and a manifest with hashes', () => {
  const dir = tempDir()
  const store = makeStore(dir)
  const stored = storeOne(store)
  assert.ok(fs.existsSync(path.join(stored.dir, 'stdout.raw')))
  assert.ok(fs.existsSync(path.join(stored.dir, 'stderr.raw')))
  assert.ok(fs.existsSync(path.join(stored.dir, 'summary.txt')))
  const manifest = JSON.parse(fs.readFileSync(path.join(stored.dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 'dsh.tool-output-compress/artifact@1')
  assert.equal(manifest.ruleVersion, 1)
  assert.equal(manifest.streams[0].lines, 2)
  assert.equal(manifest.streams[0].sha256.length, 64)
  assert.equal(manifest.streams[1].source, 'spill')
  assert.equal(manifest.summary.sha256.length, 64)
  assert.equal(fs.readFileSync(path.join(stored.dir, 'stdout.raw'), 'utf8'), 'line one\nline two\n')
  assert.equal(store.list().length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the same artifact is reused instead of rewritten', () => {
  const dir = tempDir()
  const store = makeStore(dir)
  const first = storeOne(store)
  const second = storeOne(store)
  assert.equal(first.reused, false)
  assert.equal(second.reused, true)
  assert.equal(second.dir, first.dir)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('refs resolve and pinning copies the artifact out of the GC path', () => {
  const dir = tempDir()
  const store = makeStore(dir)
  const stored = storeOne(store)
  assert.equal(store.resolve('session-1/call-1'), stored.dir)
  assert.equal(store.resolve('session-1/missing'), null)
  const pinned = store.pin({ ref: 'session-1/call-1', owner: 'operator' })
  assert.ok(fs.existsSync(path.join(pinned.dir, 'pin.json')))
  const pin = JSON.parse(fs.readFileSync(path.join(pinned.dir, 'pin.json'), 'utf8'))
  assert.equal(pin.owner, 'operator')
  assert.equal(pin.schema, 'dsh.tool-output-compress/pin@1')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('gc removes only expired artifacts and reports what it kept', () => {
  const dir = tempDir()
  const store = makeStore(dir, { retentionDays: 1 })
  const old = storeOne(store, 'old-call')
  const current = storeOne(store, 'current-call')
  const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  fs.utimesSync(old.dir, past, past)
  const result = store.gc()
  assert.equal(result.removed, 1)
  assert.equal(result.kept, 1)
  assert.equal(fs.existsSync(old.dir), false)
  assert.equal(fs.existsSync(current.dir), true)
  const dry = store.gc({ dryRun: true })
  assert.equal(dry.removed, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a quota failure rejects so the caller can keep the original result', () => {
  const dir = tempDir()
  const store = makeStore(dir, { quotaBytes: 64 })
  assert.throws(() => storeOne(store), /quota/i)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('artifact directories are private', () => {
  const dir = tempDir()
  const store = makeStore(dir)
  const stored = storeOne(store)
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(stored.dir, 'stdout.raw')).mode & 0o777
    assert.equal(mode, 0o600)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})
