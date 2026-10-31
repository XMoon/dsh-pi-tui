/**
 * M4-C2-D split-process upgrade smoke wiring guard.
 *
 * The real dual-artifact lane is `scripts/split-process-upgrade-smoke.mjs`.
 * It needs two genuinely packaged `.tgz` payloads and a real DSH rc.4
 * installation, so it stays an explicit manual qualification lane. This test
 * only prevents its argument contract and package wiring from rotting; it is
 * NOT evidence that U02–U06 passed.
 *
 * @module split-process-upgrade-smoke-wiring.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseUpgradeArguments } from '../../scripts/split-process-upgrade-smoke.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'split-process-upgrade-smoke.mjs')

test('the upgrade smoke is a package script and parses as ESM', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts?.['smoke:split-upgrade'], 'node scripts/split-process-upgrade-smoke.mjs')
  const result = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('the upgrade smoke requires two different old/new artifact paths', () => {
  const oldPath = join(ROOT, 'temp', 'old.tgz')
  const newPath = join(ROOT, 'temp', 'new.tgz')
  assert.deepEqual(
    (() => {
      const parsed = parseUpgradeArguments(['--', '--old', oldPath, '--new', newPath])
      return { old: parsed.old, new: parsed.new, evidence: parsed.evidence }
    })(),
    { old: oldPath, new: newPath, evidence: undefined },
  )
  assert.throws(() => parseUpgradeArguments(['--old', 'old.tgz']), /both --old <tgz> and --new <tgz> are required/u)
  assert.throws(() => parseUpgradeArguments(['--old', 'same.tgz', '--new', 'same.tgz']), /must name different artifacts/u)
  assert.throws(() => parseUpgradeArguments(['--old', 'old.tgz', '--new', 'new.tgz', '--bogus']), /unknown argument/u)
  assert.throws(() => parseUpgradeArguments(['--old', '--new', 'new.tgz']), /--old requires a path/u)
})

test('the upgrade smoke refuses to treat one artifact as both builds', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.match(source, /oldArtifact\.sha256 === newArtifact\.sha256/u)
  assert.match(source, /newBuildId !== oldBuildId/u)
  assert.match(source, /HOST_BUILD_INCOMPATIBLE/u)
  assert.match(source, /SPLIT_UPGRADE_SMOKE_PASS/u)
  assert.match(source, /SPLIT_UPGRADE_KEEP/u)
  // The lane must never derive the old artifact by mutating the new one.
  assert.doesNotMatch(source, /writeFileSync\(.*newArtifact\.path/u)
})
