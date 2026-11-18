import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const root = fileURLToPath(new URL('..', import.meta.url))

function sources() {
  return [
    'index.js',
    'lib/transform.mjs',
    'lib/parse.mjs',
    'lib/summarize.mjs',
    'lib/artifacts.mjs',
  ].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n')
}

test('the hook path spawns nothing and imports no process API', () => {
  const text = sources()
  assert.doesNotMatch(text, /child_process/)
  assert.doesNotMatch(text, /\bspawnSync?\b/)
  assert.doesNotMatch(text, /\bexecFile(?:Sync)?\b/)
  assert.doesNotMatch(text, /\bexecSync\b/)
})

test('the package has no runtime dependencies and ships its tests', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies, undefined)
  assert.ok(manifest.files.includes('test'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})

test('apply registers no model-facing tool', () => {
  const handlers = {}
  let registeredTool = false
  const ctx = {
    logger: { warn() {} },
    tools: {
      register() {
        registeredTool = true
        return () => {}
      },
    },
    on(event, handler) {
      handlers[event] = handler
      return () => {}
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  apply(ctx, { stateDir: path.join(root, '.tmp-nosample-state'), tools: ['bash'] })
  assert.equal(registeredTool, false)
  assert.equal(typeof handlers['tools/post-execute'], 'function')
  fs.rmSync(path.join(root, '.tmp-nosample-state'), { recursive: true, force: true })
})
