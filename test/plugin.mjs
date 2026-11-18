import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { apply } from '../index.js'
import { longStdout, rendered, tempDir } from './support/fixtures.mjs'

function fakeCtx() {
  const handlers = {}
  return {
    handlers,
    logger: { warn() {} },
    // Deliberately no register(): this plugin must add no model-facing tool.
    tools: {},
    on(event, handler) {
      handlers[event] = handler
      return () => {}
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
}

function nextOf(text) {
  return async () => ({ kind: 'accept', content: [{ type: 'text', text }] })
}

test('apply registers one post-execute hook and a heartbeat with a passing self-test', () => {
  const stateDir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { stateDir, tools: ['bash'] })
  assert.equal(typeof ctx.handlers['tools/post-execute'], 'function')
  const loaded = JSON.parse(fs.readFileSync(path.join(stateDir, 'plugin-loaded.json'), 'utf8'))
  assert.equal(loaded.plugin, 'tool-output-compress')
  assert.equal(loaded.hooks.postExecute, true)
  assert.equal(loaded.selfTest.ok, true)
  assert.deepEqual(loaded.tools, ['bash'])
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('the hook replaces long bash output with a summary and pointer', async () => {
  const stateDir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { stateDir, tools: ['bash'] })
  const handler = ctx.handlers['tools/post-execute']
  const big = rendered({ stdout: longStdout(), stderr: 'fatal: x', markers: ['[exit code: 2]'] })
  const decision = await handler(
    { name: 'bash', callId: 'call-1', agent: { id: 'session-1' } },
    { isError: false, content: [{ type: 'text', text: big }] },
    nextOf(big),
  )
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content.length, 1)
  assert.ok(decision.content[0].text.includes('tool-output-compress v1'))
  assert.ok(decision.content[0].text.includes('full output: '))
  assert.ok(Buffer.byteLength(decision.content[0].text) < 4_096)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('small, error, non-allowlisted, value and multi-block results are untouched', async () => {
  const stateDir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { stateDir, tools: ['bash'] })
  const handler = ctx.handlers['tools/post-execute']
  const exec = { name: 'bash', callId: 'call-2', agent: { id: 'session-1' } }
  const big = rendered({ stdout: longStdout() })

  const small = await handler(exec, { isError: false, content: [{ type: 'text', text: 'short' }] }, nextOf('short'))
  assert.equal(small.content[0].text, 'short')

  const failed = await handler(exec, { isError: true, content: [{ type: 'text', text: big }] }, nextOf(big))
  assert.equal(failed.content[0].text, big)

  const other = await handler({ ...exec, name: 'read' }, { isError: false, content: [{ type: 'text', text: big }] }, nextOf(big))
  assert.equal(other.content[0].text, big)

  const value = await handler(exec, { isError: false, content: [] }, async () => ({ kind: 'accept', value: { ok: true } }))
  assert.deepEqual(value, { kind: 'accept', value: { ok: true } })

  const blocks = [{ type: 'text', text: big }, { type: 'text', text: 'extra' }]
  const multi = await handler(exec, { isError: false, content: blocks }, async () => ({ kind: 'accept', content: blocks }))
  assert.deepEqual(multi.content, blocks)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('a blocking decision is passed through unchanged', async () => {
  const stateDir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { stateDir, tools: ['bash'] })
  const handler = ctx.handlers['tools/post-execute']
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] }
  const result = await handler({ name: 'bash', callId: 'c', agent: { id: 's' } }, { isError: false, content: [] }, async () => blocked)
  assert.deepEqual(result, blocked)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('enabled:false registers nothing', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: false, stateDir: tempDir(), tools: ['bash'] })
  assert.equal(ctx.handlers['tools/post-execute'], undefined)
})
