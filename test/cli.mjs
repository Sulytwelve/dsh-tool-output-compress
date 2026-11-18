import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createArtifactStore } from '../lib/artifacts.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { longStdout, rendered, tempDir } from './support/fixtures.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = path.join(root, 'bin', 'cli.mjs')

function run(args, stateDir) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DSH_TOOL_OUTPUT_COMPRESS_STATE_DIR: stateDir },
  })
}

function seed(stateDir) {
  const { config } = normalizeConfig({})
  const store = createArtifactStore({ stateDir, config })
  const stdout = rendered({ stdout: longStdout(), stderr: 'fatal: x', markers: ['[exit code: 2]'] })
  return store.store({
    sessionId: 'session-1',
    callId: 'call-1',
    tool: 'bash',
    streams: [
      { name: 'stdout', text: 'line one\nline two\nline three\n', source: 'rendered' },
      { name: 'stderr', text: 'fatal: x\n', source: 'rendered' },
    ],
    summary: 'tool-output-compress v1 · test summary',
    markers: ['[exit code: 2]'],
    ranges: [{ stream: 'stdout', start: 0, end: 2, kind: 'head' }],
  })
}

test('list and show read the artifact', () => {
  const stateDir = tempDir()
  seed(stateDir)
  const list = run(['list', '--json'], stateDir)
  assert.equal(list.status, 0, list.stderr)
  const rows = JSON.parse(list.stdout)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ref, 'session-1/call-1')

  const show = run(['show', 'session-1/call-1'], stateDir)
  assert.equal(show.status, 0)
  assert.match(show.stdout, /test summary/)

  const lines = run(['show', 'session-1/call-1', '--lines', '2-3', '--stream', 'stdout'], stateDir)
  assert.equal(lines.status, 0)
  assert.match(lines.stdout, /^2: line two$/m)
  assert.match(lines.stdout, /^3: line three$/m)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('path, pin and gc behave', () => {
  const stateDir = tempDir()
  seed(stateDir)
  const pathResult = run(['path', 'session-1/call-1'], stateDir)
  assert.equal(pathResult.status, 0)
  assert.match(pathResult.stdout, /stdout\.raw/)

  const pin = run(['pin', 'session-1/call-1', '--for', 'operator'], stateDir)
  assert.equal(pin.status, 0)
  assert.match(pin.stdout, /owner operator/)

  const gc = run(['gc', '--json'], stateDir)
  assert.equal(gc.status, 0)
  assert.equal(JSON.parse(gc.stdout).removed, 0)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('a missing artifact is an error, not a crash', () => {
  const stateDir = tempDir()
  const result = run(['show', 'nobody/nothing'], stateDir)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not found or expired/)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('bench reports byte and heuristic-token savings', () => {
  const stateDir = tempDir()
  const file = path.join(stateDir, 'stdout.log')
  fs.writeFileSync(file, `${longStdout()}\n[stderr]\nfatal: x`)
  const result = run(['bench', '--stdout', file, '--exit', '2', '--json'], stateDir)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.ok(report.after.bytes < report.before.bytes)
  assert.ok(report.saved.estTokens > 0)
  assert.match(report.tokenizer, /4 chars\/token/)
  assert.equal(report.ruleVersion, 1)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('doctor and version run without a loaded host', () => {
  const stateDir = tempDir()
  const doctor = run(['doctor'], stateDir)
  assert.equal(doctor.status, 0)
  assert.match(doctor.stdout, /host hook: no plugin-loaded\.json/)
  const version = run(['version'], stateDir)
  assert.equal(version.status, 0)
  assert.match(version.stdout, /dsh-tool-output-compress 0\.1\.2/)
  fs.rmSync(stateDir, { recursive: true, force: true })
})
