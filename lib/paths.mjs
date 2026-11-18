/** Paths this plugin owns. Nothing points at another plugin's data. */

import os from 'node:os'
import path from 'node:path'

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
export function defaultStateDir(env = process.env, platform = process.platform) {
  if (typeof env.DSH_TOOL_OUTPUT_COMPRESS_STATE_DIR === 'string' && env.DSH_TOOL_OUTPUT_COMPRESS_STATE_DIR.trim() !== '') {
    return path.resolve(env.DSH_TOOL_OUTPUT_COMPRESS_STATE_DIR.trim())
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'dsh-tool-output-compress')
  }
  if (typeof env.XDG_STATE_HOME === 'string' && env.XDG_STATE_HOME.trim() !== '') {
    return path.join(path.resolve(env.XDG_STATE_HOME.trim()), 'dsh-tool-output-compress')
  }
  return path.join(os.homedir(), '.local', 'state', 'dsh-tool-output-compress')
}

/**
 * @param {string} stateDir
 */
export function statePaths(stateDir) {
  return {
    dir: stateDir,
    artifacts: path.join(stateDir, 'artifacts'),
    pinned: path.join(stateDir, 'pinned'),
    loaded: path.join(stateDir, 'plugin-loaded.json'),
  }
}

/**
 * A filesystem-safe segment for a session id or call id.
 * @param {string} value
 */
export function safeSegment(value) {
  const text = typeof value === 'string' ? value : String(value ?? 'unknown')
  const safe = text.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 96)
  return safe === '' ? 'unknown' : safe
}

/**
 * `sessionId/callId` reference for one artifact directory.
 * @param {string} sessionId
 * @param {string} callId
 */
export function artifactRef(sessionId, callId) {
  return `${safeSegment(sessionId)}/${safeSegment(callId)}`
}
