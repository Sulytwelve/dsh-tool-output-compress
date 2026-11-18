import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitRendered } from '../lib/parse.mjs'
import { rendered } from './support/fixtures.mjs'

test('separates stdout and stderr and keeps their order-independent identity', () => {
  const parsed = splitRendered(rendered({ stdout: 'out line', stderr: 'err line', markers: ['[exit code: 2]'] }))
  assert.equal(parsed.stdout.text, 'out line')
  assert.equal(parsed.stderr.text, 'err line')
  assert.deepEqual(parsed.markers, ['[exit code: 2]'])
  assert.equal(parsed.truncated, false)
})

test('captures a stdout spill pointer and removes the notice line', () => {
  const parsed = splitRendered(rendered({ stdout: 'tail', stdoutPointer: '/tmp/spill-out.log' }))
  assert.deepEqual(parsed.stdout.pointer, { path: '/tmp/spill-out.log', available: true })
  assert.equal(parsed.stdout.text, 'tail')
  assert.equal(parsed.truncated, true)
})

test('an unavailable pointer is reported, not invented', () => {
  const parsed = splitRendered(rendered({ stdout: 'tail', stdoutPointer: '(unavailable)' }))
  assert.deepEqual(parsed.stdout.pointer, { path: null, available: false })
})

test('stderr-only truncation keeps stdout untouched', () => {
  const parsed = splitRendered(rendered({ stdout: 'out', stderr: 'err tail', stderrPointer: '/tmp/spill-err.log' }))
  assert.equal(parsed.stdout.pointer, null)
  assert.deepEqual(parsed.stderr.pointer, { path: '/tmp/spill-err.log', available: true })
})

test('timeout, signal, stop and sandbox markers stay separate from the streams', () => {
  const parsed = splitRendered(rendered({
    stdout: 'body',
    markers: ['[timed out after 120000ms]', '[killed by signal: SIGKILL]'],
  }))
  assert.deepEqual(parsed.markers, ['[timed out after 120000ms]', '[killed by signal: SIGKILL]'])
  assert.equal(parsed.stdout.text, 'body')
})

test('CRLF input is normalized before classification', () => {
  const parsed = splitRendered('line one\r\n[stderr]\r\nfatal: x\r\n[exit code: 1]\r\n')
  assert.equal(parsed.stdout.text, 'line one')
  assert.equal(parsed.stderr.text, 'fatal: x')
  assert.deepEqual(parsed.markers, ['[exit code: 1]'])
})
