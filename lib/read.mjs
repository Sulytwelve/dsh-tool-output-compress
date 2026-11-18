/** Small read helpers that never throw on a missing or damaged file. */

import fs from 'node:fs'

/**
 * @param {string} file
 * @param {{fs?: typeof fs}} options
 */
export function readJson(file, { fs: fileSystem = fs } = {}) {
  try {
    const stat = fileSystem.statSync(file)
    return { value: JSON.parse(fileSystem.readFileSync(file, 'utf8')), mtimeMs: stat.mtimeMs, bytes: stat.size, error: null }
  } catch (error) {
    return { value: null, mtimeMs: null, bytes: null, error: { code: error?.code ?? 'ERR_READ', message: error?.message ?? String(error) } }
  }
}

/**
 * @param {string} file
 * @param {{fs?: typeof fs}} options
 */
export function readText(file, { fs: fileSystem = fs } = {}) {
  try {
    return { text: fileSystem.readFileSync(file, 'utf8'), error: null }
  } catch (error) {
    return { text: null, error: { code: error?.code ?? 'ERR_READ', message: error?.message ?? String(error) } }
  }
}
