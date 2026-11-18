/** Deterministic fixtures for the compression tests. */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function tempDir(prefix = 'ms-t3-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * Build the bash renderer's model-visible text.
 * @param {{stdout?: string, stderr?: string, markers?: string[], stdoutPointer?: string|null, stderrPointer?: string|null}} input
 */
export function rendered({ stdout = '', stderr = '', markers = [], stdoutPointer = null, stderrPointer = null } = {}) {
  let text = stdout
  if (stdoutPointer !== null) text += `${text === '' ? '' : '\n'}[output truncated; full output: ${stdoutPointer}]`
  if (stderr !== '' || stderrPointer !== null) text += `${text === '' ? '' : '\n'}[stderr]\n${stderr}`
  if (stderrPointer !== null) text += `${stderr !== '' ? '\n' : ''}[output truncated; full output: ${stderrPointer}]`
  if (markers.length > 0) text += `${text === '' ? '' : '\n'}${markers.join('\n')}`
  return text
}

/** A realistic long stdout: 1200 timestamped lines, one stack trace, one late error. */
export function longStdout({ lines = 1200 } = {}) {
  const out = []
  for (let index = 0; index < lines; index += 1) {
    if (index === 499) out.push('Traceback (most recent call last):')
    else if (index === 500) out.push('  File "app.py", line 7, in main')
    else if (index === 900) out.push('ERROR: connection refused')
    else out.push(`2026-11-18T09:00:${String(index % 60).padStart(2, '0')} step ${index + 1} ok`)
  }
  return out.join('\n')
}

/** Three identical warning lines plus one late fatal error. */
export function repeatedWarnings() {
  const out = []
  for (let index = 0; index < 200; index += 1) {
    out.push(index % 50 === 10 ? 'WARN retrying in 5s' : `progress ${index}`)
  }
  out.push('ERROR: gave up after retries')
  return out.join('\n')
}

/** One line larger than the default threshold. */
export function hugeSingleLine(size = 40_000) {
  return `START ${'x'.repeat(size)} END`
}

export function findFile(dir, name) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findFile(full, name)
      if (nested !== null) return nested
    } else if (entry.name === name) {
      return full
    }
  }
  return null
}
