/**
 * Deterministic rules v1. The same streams, markers and rule version produce
 * byte-identical output; there is no clock or randomness in this module.
 *
 * Priority: anomalies (errors, stacks, denied/refused/timeouts) with a few
 * continuation lines, then head/tail context, then sampled timestamp lines.
 * Repeated identical anomalies collapse to one occurrence plus counts and
 * line references. A soft byte budget is honoured by dropping the least
 * informative ranges first; if even that cannot fit, the caller keeps the
 * original output.
 */

export const RULE_VERSION = 1

const MAX_LINE = 140
const MAX_RANGE = 360

const ANOMALY_PATTERNS = [
  /^\s*(?:fatal|panic|error|err|warn|warning|failed|failure)\b/i,
  /\b(?:Error|Exception|Traceback|SIGSEGV|segmentation fault|core dumped)\b/,
  /^\s+at\s+\S/,
  /^\s+File\s+".*",\s+line\s+\d+/,
  /^\s*Caused by:/i,
  /(?:No such file|Permission denied|Connection refused|timed out|command not found)/i,
  /^\s*[\w.-]+:\s+(?:fatal|error|failed|failure)\b/i,
]

const TIMESTAMP_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/,
  /^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/,
  /^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/,
  /^\d{2}:\d{2}:\d{2}[.,]\d{3}\s/,
]

function isAnomaly(line) {
  return ANOMALY_PATTERNS.some(pattern => pattern.test(line))
}

function isContinuation(line) {
  return /^\s{2,}\S/.test(line) || /^\s+at\s/.test(line) || /^\s+File\s+"/.test(line) || /^\s+\.\.\./.test(line) || /^\s*Caused by:/i.test(line)
}

function isTimestamp(line) {
  return TIMESTAMP_PATTERNS.some(pattern => pattern.test(line))
}

function clipLine(line) {
  const text = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} …(+${line.length - MAX_LINE} chars)` : line
  return text
}

const KIND_PRIORITY = { anomaly: 3, head: 2, tail: 1, time: 0 }

function pushRange(ranges, start, end, kind, note = null) {
  ranges.push({ start, end, kind, note })
}

function buildRanges(lines) {
  const count = lines.length
  if (count === 0) return []
  const ranges = []
  pushRange(ranges, 0, Math.min(2, count - 1), 'head')
  pushRange(ranges, Math.max(0, count - 5), count - 1, 'tail')

  const anomalies = []
  for (let index = 0; index < count; index += 1) {
    if (isAnomaly(lines[index])) anomalies.push(index)
  }
  const groups = new Map()
  for (const index of anomalies) {
    const key = lines[index].trim()
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [index])
    else list.push(index)
  }
  const repeated = new Set()
  const repeats = new Map()
  for (const [key, indexes] of groups) {
    if (indexes.length < 3) continue
    const first = indexes[0]
    for (const index of indexes.slice(1)) repeated.add(index)
    repeats.set(first, { count: indexes.length, refs: indexes.slice(0, 6), key })
  }
  for (const index of anomalies) {
    if (repeated.has(index)) continue
    let end = index
    while (end + 1 < count && end - index < 4 && isContinuation(lines[end + 1])) end += 1
    const repeat = repeats.get(index)
    pushRange(ranges, index, end, 'anomaly', repeat === undefined ? null : `repeated ×${repeat.count} (lines ${repeat.refs.map(item => item + 1).join(',')})`)
  }

  const stamps = []
  for (let index = 0; index < count; index += 1) {
    if (isTimestamp(lines[index])) stamps.push(index)
  }
  if (stamps.length > 0) {
    const positions = stamps.length <= 6
      ? stamps
      : [0, Math.floor((stamps.length - 1) / 3), Math.floor((2 * (stamps.length - 1)) / 3), stamps.length - 1]
        .map(position => stamps[position])
    for (const index of new Set(positions)) pushRange(ranges, index, index, 'time')
  }

  ranges.sort((left, right) => left.start - right.start || left.end - right.end)
  const merged = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last !== undefined && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end)
      if (KIND_PRIORITY[range.kind] > KIND_PRIORITY[last.kind]) last.kind = range.kind
      if (range.note !== null) last.notes.push(range.note)
    } else {
      merged.push({ start: range.start, end: range.end, kind: range.kind, notes: range.note === null ? [] : [range.note] })
    }
  }
  return merged
}

function renderRange(streamName, lines, range) {
  const body = lines.slice(range.start, range.end + 1).map(clipLine).join(' ⏎ ')
  const clipped = body.length > MAX_RANGE ? `${body.slice(0, MAX_RANGE)} …` : body
  const note = range.notes.length > 0 ? ` (${range.notes.join('; ')})` : ''
  return `${streamName} ${range.start + 1}-${range.end + 1}: ${clipped}${note}`
}

function bytesOf(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Render a summary that fits the budget, dropping the least informative ranges
 * in a fixed order. Returns null when even a minimal summary is too large.
 * @param {{streams: {name: string, text: string}[], markers: string[], targetBytes: number, maxBytes: number}} input
 * @returns {{text: string, ranges: object[], omitted: number}|null}
 */
export function summarize({ streams, markers = [], targetBytes, maxBytes }) {
  const prepared = streams.map(stream => {
    const lines = String(stream.text ?? '').replace(/\r\n/g, '\n').split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return { name: stream.name, lines, bytes: bytesOf(stream.text ?? ''), ranges: buildRanges(lines) }
  })

  const headerParts = prepared.map(stream => `${stream.name} ${stream.bytes}B/${stream.lines.length}L`)
  const header = `tool-output-compress v${RULE_VERSION} · ${headerParts.join(' · ')}${markers.length > 0 ? ` · ${markers.join(' ')}` : ''}`

  const all = []
  for (const stream of prepared) {
    for (const range of stream.ranges) all.push({ stream, range })
  }

  let kept = all
  const dropOrder = ['time', 'tail', 'head']
  const render = () => {
    const body = kept.map(item => renderRange(item.stream.name, item.stream.lines, item.range)).join('\n')
    const keptLines = kept.reduce((total, item) => total + (item.range.end - item.range.start + 1), 0)
    const totalLines = prepared.reduce((total, stream) => total + stream.lines.length, 0)
    const omitted = Math.max(0, totalLines - keptLines)
    const footer = omitted === 0 ? 'complete' : `omitted ${omitted} lines; full output stored in the artifact directory`
    return `${header}\n${body}${body === '' ? '' : '\n'}${footer}`
  }

  let text = render()
  for (const kind of dropOrder) {
    if (bytesOf(text) <= maxBytes) break
    kept = kept.filter(item => item.range.kind !== kind)
    text = render()
  }
  // Keep one anomaly per stream as the last resort.
  for (const stream of prepared) {
    if (bytesOf(text) <= maxBytes) break
    let seen = 0
    kept = kept.filter(item => {
      if (item.stream !== stream || item.range.kind !== 'anomaly') return true
      seen += 1
      return seen === 1
    })
    text = render()
  }
  if (bytesOf(text) > maxBytes) return null

  const omitted = Math.max(0,
    prepared.reduce((total, stream) => total + stream.lines.length, 0)
    - kept.reduce((total, item) => total + (item.range.end - item.range.start + 1), 0))
  return {
    text,
    omitted,
    ranges: kept.map(item => ({ stream: item.stream.name, start: item.range.start, end: item.range.end, kind: item.range.kind })),
  }
}
