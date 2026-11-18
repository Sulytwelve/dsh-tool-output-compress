/**
 * Parse the bash tool's rendered text without reimplementing its shell.
 *
 * The installed renderer produces: stdout tail, a `[stderr]` separator,
 * stderr tail, then trailing status markers. A truncated stream carries
 * `[output truncated; full output: <spill>]`. stdout/stderr identity is kept;
 * no cross-stream order is claimed.
 */

/** A stream's own truncation notice; the path is the complete stream when available. */
export const POINTER_PATTERN = /^\[output truncated; full output: (.*)\]$/

/** Trailing status markers emitted by the bash/pwsh renderers. */
export const MARKER_PATTERN = /^\[(?:exit code: -?\d+|killed by signal: .+|timed out after \d+ms|stopped: .+|sandbox: .+)\]$/

/**
 * @param {string} text
 */
function linesOf(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Split a stream section into its text and its pointer, when present.
 * `(unavailable)` means the executor could not produce a complete stream.
 * @param {string[]} lines
 */
function takePointer(lines) {
  let pointer = null
  const kept = []
  for (const line of lines) {
    const match = POINTER_PATTERN.exec(line)
    if (match === null) {
      kept.push(line)
      continue
    }
    const target = match[1]
    pointer = target === '(unavailable)' ? { path: null, available: false } : { path: target, available: true }
  }
  return { lines: kept, pointer }
}

/**
 * @param {string} text
 * @returns {{
 *   stdout: {text: string, pointer: {path: string|null, available: boolean}|null},
 *   stderr: {text: string, pointer: {path: string|null, available: boolean}|null},
 *   markers: string[],
 *   truncated: boolean,
 * }}
 */
export function splitRendered(text) {
  const lines = linesOf(text)
  const markers = []
  while (lines.length > 0 && MARKER_PATTERN.test(lines[lines.length - 1])) {
    markers.unshift(lines.pop())
  }
  const separator = lines.indexOf('[stderr]')
  let stdoutLines = lines
  let stderrLines = []
  if (separator !== -1) {
    stdoutLines = lines.slice(0, separator)
    stderrLines = lines.slice(separator + 1)
  }
  const out = takePointer(stdoutLines)
  const err = takePointer(stderrLines)
  return {
    stdout: { text: out.lines.join('\n'), pointer: out.pointer },
    stderr: { text: err.lines.join('\n'), pointer: err.pointer },
    markers,
    truncated: out.pointer !== null || err.pointer !== null,
  }
}
