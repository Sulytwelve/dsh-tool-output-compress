/**
 * The post-execute transform. It reads the complete streams when the bash
 * renderer left a spill path, summarizes deterministically, stores an
 * artifact, and returns the replacement text — or `null` to keep the host's
 * original result. It never executes a command.
 */

import fs from 'node:fs'
import { splitRendered } from './parse.mjs'
import { RULE_VERSION, summarize } from './summarize.mjs'

/**
 * @param {{
 *   config: object,
 *   store: object,
 *   fs?: typeof fs,
 *   now?: () => number,
 *   logger?: {warn?: Function},
 * }} options
 */
export function makeTransform({ config, store, fs: fileSystem = fs, now = Date.now, logger = undefined }) {
  function readStream(path, streamName) {
    try {
      const stat = fileSystem.statSync(path)
      if (stat.size > config.maxRawBytes) return { ok: false, reason: `${streamName} spill exceeds maxRawBytes` }
      return { ok: true, text: fileSystem.readFileSync(path, 'utf8'), source: 'spill' }
    } catch (error) {
      return { ok: false, reason: `${streamName} spill unreadable: ${error?.code ?? error?.message ?? 'error'}` }
    }
  }

  /**
   * @param {{exec: object, text: string}} input
   * @returns {{text: string, artifactDir: string, summary: string, pointer: string}|null}
   */
  return function transform({ exec, text }) {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') <= config.thresholdBytes) return null
    const parsed = splitRendered(text)

    if (parsed.stdout.pointer !== null && !parsed.stdout.pointer.available) return null
    if (parsed.stderr.pointer !== null && !parsed.stderr.pointer.available) return null

    const streams = []
    for (const name of ['stdout', 'stderr']) {
      const section = parsed[name]
      if (section.pointer !== null) {
        const read = readStream(section.pointer.path, name)
        if (!read.ok) {
          logger?.warn?.(`tool-output-compress: ${read.reason}; keeping the original result`)
          return null
        }
        streams.push({ name, text: read.text, source: read.source })
      } else {
        streams.push({ name, text: section.text, source: 'rendered' })
      }
    }
    if (streams.every(stream => stream.text.trim() === '') && parsed.markers.length === 0) return null

    const summary = summarize({
      streams,
      markers: parsed.markers,
      targetBytes: config.targetBytes,
      maxBytes: config.maxSummaryBytes,
    })
    if (summary === null) {
      logger?.warn?.('tool-output-compress: summary would exceed maxSummaryBytes; keeping the original result')
      return null
    }

    const sessionId = exec?.agent?.id ?? 'unknown'
    const callId = exec?.callId ?? 'unknown'
    let stored
    try {
      stored = store.store({
        sessionId,
        callId,
        tool: exec?.name ?? 'unknown',
        streams,
        summary: summary.text,
        markers: parsed.markers,
        ranges: summary.ranges,
      })
    } catch (error) {
      logger?.warn?.(`tool-output-compress: artifact write failed (${error?.code ?? error?.message}); keeping the original result`)
      return null
    }

    const pointer = `full output: ${stored.dir} (stdout.raw, stderr.raw, summary.txt, manifest.json) · rule v${RULE_VERSION}`
    return {
      text: `${summary.text}\n${pointer}`,
      artifactDir: stored.dir,
      summary: summary.text,
      pointer,
      manifest: stored.manifest,
      reused: stored.reused,
    }
  }
}
