/**
 * `tool-output-compress` — a deterministic `tools/post-execute` listener.
 *
 * It owns no tool, no command execution, and no approval path. Registered
 * without `prepend`, so the shipped spill-policy row (`prepend: true`) sees the
 * short summary and does not retain it again.
 */

import path from 'node:path'
import { normalizeConfig } from './lib/config.mjs'
import { defaultStateDir, statePaths } from './lib/paths.mjs'
import { createArtifactStore } from './lib/artifacts.mjs'
import { makeTransform } from './lib/transform.mjs'
import { summarize } from './lib/summarize.mjs'
import { splitRendered } from './lib/parse.mjs'
import { writeJsonAtomic } from './lib/write.mjs'
import { ownVersion } from './lib/version.mjs'

export const name = 'tool-output-compress'

/** The tool registry is required to observe post-execute; nothing else is. */
export const inject = ['tools']

const LOADED_SCHEMA = 'dsh.tool-output-compress/plugin-loaded@1'

function selfTest(config) {
  try {
    const stdout = Array.from({ length: 400 }, (_, index) => {
      if (index === 120) return 'Traceback (most recent call last):'
      if (index === 121) return '  File "app.py", line 7, in main'
      if (index === 300) return 'ERROR: connection refused'
      return `step ${index + 1} ok`
    }).join('\n')
    const text = `${stdout}\n[stderr]\nfatal: upstream unavailable\n[exit code: 1]`
    const parsed = splitRendered(text)
    const summary = summarize({
      streams: [
        { name: 'stdout', text: parsed.stdout.text },
        { name: 'stderr', text: parsed.stderr.text },
      ],
      markers: parsed.markers,
      targetBytes: config.targetBytes,
      maxBytes: config.maxSummaryBytes,
    })
    return {
      ok: summary !== null && summary.text.includes('Traceback') && summary.text.includes('connection refused'),
      summaryBytes: summary === null ? null : Buffer.byteLength(summary.text, 'utf8'),
      rules: config.summaryRules,
    }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}

function writeHeartbeat({ ctx, config, stateDir, diagnostics }) {
  try {
    writeJsonAtomic(statePaths(stateDir).loaded, {
      schema: LOADED_SCHEMA,
      plugin: 'tool-output-compress',
      version: ownVersion(),
      pid: process.pid,
      loadedAtMs: Date.now(),
      loadedAt: new Date().toISOString(),
      stateDir,
      hooks: { postExecute: true },
      tools: config.tools,
      config: {
        thresholdBytes: config.thresholdBytes,
        targetBytes: config.targetBytes,
        maxSummaryBytes: config.maxSummaryBytes,
        maxRawBytes: config.maxRawBytes,
        retentionDays: config.retentionDays,
        quotaBytes: config.quotaBytes,
      },
      diagnostics,
      selfTest: selfTest(config),
    })
  } catch {
    // A diagnostic file that cannot be written must not block the row.
  }
}

/**
 * @param {object} ctx Cordis context with the required `tools` service.
 * @param {object} rawConfig the row's config.
 */
export function apply(ctx, rawConfig = {}) {
  const { config, diagnostics } = normalizeConfig(rawConfig)
  if (!config.enabled) return
  const stateDir = typeof rawConfig.stateDir === 'string' && rawConfig.stateDir.trim() !== ''
    ? path.resolve(rawConfig.stateDir.trim())
    : defaultStateDir()
  const store = createArtifactStore({ stateDir, config })
  const transform = makeTransform({ config, store, logger: ctx.logger })

  const listener = async (exec, result, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
      if (result.isError) return decision
      if (!config.tools.includes(exec?.name)) return decision
      const content = decision.content ?? result.content
      if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text') return decision
      const transformed = transform({ exec, text: content[0].text })
      if (transformed === null) return decision
      return { ...decision, content: [{ type: 'text', text: transformed.text }] }
    } catch (error) {
      try { ctx.logger?.warn?.(`tool-output-compress: ${error?.message ?? String(error)}; keeping the original result`) } catch { /* logger absent */ }
      return decision
    }
  }

  ctx.effect(() => ctx.on('tools/post-execute', listener))
  ctx.effect(() => {
    writeHeartbeat({ ctx, config, stateDir, diagnostics })
    return () => {}
  })
}
