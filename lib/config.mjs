/**
 * Configuration defaults.
 *
 * Every numeric default here is **calibrate-required** (starting policy from
 * the implementation brief), except the spill cap copied from the installed
 * bash executor. See README.md for provenance.
 */

export const DEFAULT_CONFIG = Object.freeze({
  schema: 1,
  enabled: true,
  tools: ['bash'],
  thresholdBytes: 16_384,
  targetBytes: 2_048,
  maxSummaryBytes: 8_192,
  maxRawBytes: 64 * 1024 * 1024,
  retentionDays: 7,
  quotaBytes: 256 * 1024 * 1024,
  summaryRules: 1,
})

function finite(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function toolList(value) {
  if (!Array.isArray(value)) return DEFAULT_CONFIG.tools.slice()
  const names = value
    .filter(item => typeof item === 'string' && item.trim() !== '')
    .map(item => item.trim().slice(0, 64))
  return names.length === 0 ? DEFAULT_CONFIG.tools.slice() : [...new Set(names)].slice(0, 8)
}

/**
 * Merge caller config over defaults and coerce ranges. Never throws: a bad
 * value falls back with a diagnostic.
 * @param {unknown} raw
 */
export function normalizeConfig(raw = {}) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const config = {
    schema: 1,
    enabled: input.enabled !== false,
    tools: toolList(input.tools),
    thresholdBytes: finite(input.thresholdBytes, DEFAULT_CONFIG.thresholdBytes, { min: 1_024, max: 16 * 1024 * 1024 }),
    targetBytes: finite(input.targetBytes, DEFAULT_CONFIG.targetBytes, { min: 256, max: 1024 * 1024 }),
    maxSummaryBytes: finite(input.maxSummaryBytes, DEFAULT_CONFIG.maxSummaryBytes, { min: 512, max: 4 * 1024 * 1024 }),
    maxRawBytes: finite(input.maxRawBytes, DEFAULT_CONFIG.maxRawBytes, { min: 65_536, max: 512 * 1024 * 1024 }),
    retentionDays: finite(input.retentionDays, DEFAULT_CONFIG.retentionDays, { min: 1, max: 365 }),
    quotaBytes: finite(input.quotaBytes, DEFAULT_CONFIG.quotaBytes, { min: 1024 * 1024, max: 100 * 1024 * 1024 * 1024 }),
    summaryRules: 1,
  }
  const diagnostics = []
  if (config.maxSummaryBytes < config.targetBytes) {
    config.maxSummaryBytes = config.targetBytes
    diagnostics.push('maxSummaryBytes was smaller than targetBytes; raised to targetBytes')
  }
  return { config, diagnostics }
}
