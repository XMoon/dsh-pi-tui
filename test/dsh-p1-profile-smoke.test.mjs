/**
 * Static/argument checks for the P1 isolated-profile smoke script. The real
 * profile run is an explicit release gate (`pnpm smoke:p1-profile`), not part
 * of the routine suite; this pins the script's wiring and target resolution.
 * @module @xmoon76/dsh-pi-tui/dsh-p1-profile-smoke.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { join } from 'node:path'

const ROOT = process.cwd()

test('the P1 profile smoke is registered and resolves the declared npm target', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts['smoke:p1-profile'], 'node scripts/dsh-p1-profile-smoke.mjs')
  const source = readFileSync(join(ROOT, 'scripts/dsh-p1-profile-smoke.mjs'), 'utf8')
  assert.ok(source.includes('npmDshVersion()'), 'the smoke must resolve the declared npm target dynamically')
  assert.doesNotMatch(source, /0\.1\.7-rc\.1/u, 'the smoke must not pin a stale DSH target')
  assert.ok(source.includes('PI2DSH_P1_PROFILE_EVIDENCE'), 'the probe evidence channel must stay wired')
  assert.ok(source.includes('attachController'), 'the probe must own a job-registry controller for its scratch job')
  assert.ok(source.includes("controller.follow("), 'the probe must exercise the official follow() observer')
  assert.ok(source.includes('jobs.read('), 'the probe must prove the model cursor is untouched')
})
