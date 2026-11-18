/** The running package version, also inside an installed runtime copy. */

import fs from 'node:fs'

let cached

export function ownVersion() {
  if (cached !== undefined) return cached
  try {
    cached = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    cached = '0.0.0'
  }
  return cached
}
