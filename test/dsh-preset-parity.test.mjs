/**
 * Byte-parity gate for the generated DSH preset mirror: the mirror under
 * generated/dsh-presets/ must be byte-identical to the preset patch assets
 * exported by the officially installed @deepseek-ai/dsh-web-app package.
 * Any drift — a hand-edited mirror, a stale mirror after a dependency
 * update, or a missing mirror — fails the suite.
 * @module @xmoon76/dsh-pi-tui/dsh-preset-parity.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIRROR_DIR = join(REPO_ROOT, 'generated', 'dsh-presets')
const OFFICIAL_PACKAGE = '@deepseek-ai/dsh-web-app'
const PRESETS = ['standard', 'ptc', 'minimal', 'cordis']

function officialAssetPath(name) {
  return fileURLToPath(import.meta.resolve(`${OFFICIAL_PACKAGE}/presets/${name}.patch.yml`))
}

test('the generated preset mirror is byte-identical to the official exported assets', () => {
  for (const name of PRESETS) {
    const official = readFileSync(officialAssetPath(name))
    const mirror = readFileSync(join(MIRROR_DIR, `${name}.patch.yml`))
    assert.ok(official.equals(mirror),
      `${name}.patch.yml drifted from ${OFFICIAL_PACKAGE} — regenerate with pnpm gen:dsh-presets; the mirror must never be hand-edited`)
  }
})

test('the mirror carries its do-not-edit provenance marker', () => {
  const readme = readFileSync(join(MIRROR_DIR, 'README.md'), 'utf8')
  assert.match(readme, /GENERATED/iu)
  assert.match(readme, /DO NOT EDIT/iu)
  assert.match(readme, new RegExp(OFFICIAL_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'))
})
