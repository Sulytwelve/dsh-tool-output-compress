/** Atomic writes for artifacts and diagnostics. */

import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {string} file
 * @param {string | Buffer} data
 * @param {{fs?: typeof fs, mode?: number}} options
 */
export function writeFileAtomic(file, data, { fs: fileSystem = fs, mode = 0o600 } = {}) {
  const directory = path.dirname(file)
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  try {
    fileSystem.writeFileSync(temporary, data, { mode })
    fileSystem.renameSync(temporary, file)
  } catch (error) {
    try { fileSystem.unlinkSync(temporary) } catch { /* no temporary to clean */ }
    throw error
  }
}

/**
 * @param {string} file
 * @param {unknown} value
 * @param {{fs?: typeof fs}} options
 */
export function writeJsonAtomic(file, value, { fs: fileSystem = fs } = {}) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { fs: fileSystem })
}
