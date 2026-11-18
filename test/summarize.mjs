import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarize } from '../lib/summarize.mjs'
import { hugeSingleLine, longStdout, repeatedWarnings } from './support/fixtures.mjs'

const targetBytes = 2_048
const maxBytes = 8_192

function run(stdout, stderr = '', markers = []) {
  return summarize({ streams: [{ name: 'stdout', text: stdout }, { name: 'stderr', text: stderr }], markers, targetBytes, maxBytes })
}

test('a failing stack trace and late error survive with line references', () => {
  const stdout = longStdout()
  const summary = run(stdout, 'fatal: upstream unavailable', ['[exit code: 2]'])
  assert.ok(summary !== null)
  assert.ok(Buffer.byteLength(summary.text) <= maxBytes)
  assert.match(summary.text, /Traceback \(most recent call last\):/)
  assert.match(summary.text, /File "app\.py", line 7, in main/)
  assert.match(summary.text, /ERROR: connection refused/)
  assert.match(summary.text, /stderr 27B\/1L/)
  assert.match(summary.text, /stdout 500-501:/)
  assert.match(summary.text, /stdout 901-901:/)
  assert.match(summary.text, /\[exit code: 2\]/)
  assert.match(summary.text, /omitted \d+ lines/)
})

test('repeated warning lines collapse to one occurrence with a count', () => {
  const summary = run(repeatedWarnings())
  assert.ok(summary !== null)
  assert.match(summary.text, /WARN retrying in 5s/)
  assert.match(summary.text, /repeated ×4/)
  assert.match(summary.text, /ERROR: gave up after retries/)
})

test('a single huge line is clipped and still fits', () => {
  const summary = run(hugeSingleLine())
  assert.ok(summary !== null)
  assert.ok(Buffer.byteLength(summary.text) <= maxBytes)
  assert.match(summary.text, /…\(\+\d+ chars\)/)
})

test('the same bytes and markers produce byte-identical output', () => {
  const stdout = longStdout()
  const first = run(stdout, 'err', ['[exit code: 1]'])
  const second = run(stdout, 'err', ['[exit code: 1]'])
  assert.equal(first.text, second.text)
})

test('a tiny budget degrades to null instead of an oversized summary', () => {
  const summary = summarize({
    streams: [{ name: 'stdout', text: longStdout() }, { name: 'stderr', text: 'err' }],
    markers: [],
    targetBytes: 150,
    maxBytes: 150,
  })
  assert.equal(summary, null)
})

test('dangerous lines are not rewritten: the original text is kept verbatim', () => {
  const weird = 'ERROR \u0000 binary-ish \u001b[31mred\u001b[0m'
  const summary = run(`${longStdout()}\n${weird}`)
  assert.ok(summary !== null)
  assert.ok(summary.text.includes('\u001b[31mred'))
})

test('an empty stream still renders a stable summary', () => {
  const summary = run('')
  assert.ok(summary !== null)
  assert.match(summary.text, /stdout 0B\/0L/)
})
