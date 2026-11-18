import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeTransform } from '../lib/transform.mjs'
import { createArtifactStore } from '../lib/artifacts.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { longStdout, rendered, tempDir } from './support/fixtures.mjs'

function setup(overrides = {}) {
  const stateDir = tempDir()
  const { config } = normalizeConfig({})
  const effective = { ...config, ...overrides }
  const warnings = []
  const store = createArtifactStore({ stateDir, config: effective })
  const transform = makeTransform({ config: effective, store, logger: { warn: message => warnings.push(message) } })
  return { stateDir, config: effective, store, transform, warnings }
}

function exec(callId = 'call-1') {
  return { name: 'bash', callId, agent: { id: 'session-1' } }
}

test('long inline output becomes a deterministic summary plus an artifact', () => {
  const { transform, stateDir } = setup()
  const text = rendered({ stdout: longStdout(), stderr: 'fatal: upstream unavailable', markers: ['[exit code: 2]'] })
  const result = transform({ exec: exec(), text })
  assert.ok(result !== null)
  assert.ok(result.text.includes('tool-output-compress v1'))
  assert.ok(result.text.includes('full output: '))
  assert.ok(Buffer.byteLength(result.text) < Buffer.byteLength(text) / 10)
  const manifest = JSON.parse(fs.readFileSync(path.join(result.artifactDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.streams[0].source, 'rendered')
  assert.equal(fs.readFileSync(path.join(result.artifactDir, 'stdout.raw'), 'utf8'), longStdout())
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('a truncated stream is read from its spill path, head included', () => {
  const { transform, stateDir } = setup({ thresholdBytes: 32 })
  const complete = `${Array.from({ length: 800 }, (_, index) => `head ${index + 1}`).join('\n')}\nERROR: at line 801\n...tail marker`
  const spill = path.join(stateDir, 'spill-out.log')
  fs.writeFileSync(spill, complete)
  const tail = complete.split('\n').slice(-5).join('\n')
  const text = rendered({ stdout: tail, stdoutPointer: spill, markers: ['[exit code: 1]'] })
  const result = transform({ exec: exec(), text })
  assert.ok(result !== null)
  const manifest = JSON.parse(fs.readFileSync(path.join(result.artifactDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.streams[0].source, 'spill')
  assert.equal(fs.readFileSync(path.join(result.artifactDir, 'stdout.raw'), 'utf8'), complete)
  assert.match(result.summary, /head 1/)
  assert.match(result.summary, /ERROR: at line 801/)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('a missing or unavailable source keeps the original result', () => {
  const { transform, stateDir, warnings } = setup({ thresholdBytes: 8 })
  const missing = rendered({ stdout: 'tail', stdoutPointer: path.join(stateDir, 'nope.log') })
  assert.equal(transform({ exec: exec(), text: missing }), null)
  assert.ok(warnings.some(line => line.includes('unreadable')))

  const unavailable = rendered({ stdout: 'tail', stdoutPointer: '(unavailable)' })
  assert.equal(transform({ exec: exec(), text: unavailable }), null)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('short output is untouched', () => {
  const { transform, stateDir } = setup()
  assert.equal(transform({ exec: exec(), text: 'short output' }), null)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('a quota failure keeps the original result and warns', () => {
  const { transform, stateDir, warnings } = setup({ quotaBytes: 128 })
  const text = rendered({ stdout: longStdout(), stderr: 'err', markers: ['[exit code: 1]'] })
  assert.equal(transform({ exec: exec(), text }), null)
  assert.ok(warnings.some(line => line.includes('artifact write failed')))
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('session and call ids are filesystem-safe', () => {
  const { transform, stateDir } = setup()
  const text = rendered({ stdout: longStdout() })
  const result = transform({ exec: { name: 'bash', callId: 'call/../x', agent: { id: 'sess/../y' } }, text })
  assert.ok(result !== null)
  const relative = path.relative(stateDir, result.artifactDir)
  assert.ok(relative.startsWith(`artifacts${path.sep}`))
  assert.ok(!relative.split(path.sep).includes('..'))
  fs.rmSync(stateDir, { recursive: true, force: true })
})
