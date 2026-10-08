import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import test from 'node:test'

import { COMPAT_MATRIX } from '../scripts/lib/dsh-compat.mjs'

const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
const expectedWindow = '>=0.2.0-rc.2'
const expectedDevVersion = Object.entries(packageJson.devDependencies ?? {})
  .find(([name]) => name.startsWith('@deepseek-ai/dsh'))?.[1]
const expectedNpmTarget = process.env.DSH_NPM_VERIFY_TARGET ?? expectedDevVersion
const dshPeerEntries = Object.entries(packageJson.peerDependencies ?? {})
  .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))

// This is a package-family contract, not a string-only policy check. The
// boundary assertions use npm's semver evaluator so prerelease behavior is
// tested with the same range semantics consumers use.
test('all DSH runtime peers use the published npm lower bound', () => {
  assert.ok(dshPeerEntries.length > 0, 'the bundle must declare DSH runtime peers')
  // The M3-3B closure lifted the whole peer policy onto the 0.2.0-rc.2
  // floor: M3-3B's Question lifecycle consumes rc.2-only published contracts
  // (`userQuestions.attachWait`/`answer` + the `userQuestions` Session
  // projection), so claiming the rc.1 family would be a false compatibility
  // statement — rc.1 does not publish that contract. The window stays
  // open-ended above rc.2; only the lower bound moved.
  for (const [name, range] of dshPeerEntries) {
    assert.equal(range, expectedWindow, `${name} must use the open-ended support lower bound`)
    assert.equal(semver.validRange(range) !== null, true, `${name} peer range must be valid semver syntax`)
    assert.equal(semver.satisfies('0.2.0-rc.2', range), true, `${name} must include its published npm floor`)
    assert.equal(semver.satisfies('0.2.0-rc.1', range), false, `${name} must reject the previous rc.1 line, which does not publish the rc.2 userQuestions contract`)
    assert.equal(semver.satisfies('0.1.7-rc.2', range), false, `${name} must reject the legacy 0.1.7 line below the M3-3B floor`)
    assert.equal(semver.satisfies('0.2.0-alpha.1', range), false, `${name} must reject the alpha line below the floor`)
    assert.equal(semver.satisfies('0.1.6', range), false, `${name} stable releases predate the rc.2 family contract`)
    assert.equal(semver.satisfies('0.2.0', range), true, `${name} must remain open to later compatible releases`)
  }
})

test('all DSH development packages stay pinned to the exact declared target', () => {
  const dshDevEntries = Object.entries(packageJson.devDependencies ?? {})
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh'))
  assert.ok(dshDevEntries.length > 0, 'the bundle must have target DSH development packages')
  assert.equal(expectedDevVersion, expectedNpmTarget, 'the package must keep the declared npm target')
  assert.equal(typeof expectedDevVersion, 'string', 'the bundle must declare the primary DSH development target')
  for (const [name, version] of dshDevEntries) {
    assert.equal(version, expectedDevVersion, `${name} must stay exact`)
  }
})

test('the package version reserves one consistent release identity across manifest and matrix', () => {
  // Version-coupled fields move ATOMICALLY: an untagged promotion candidate
  // reserves its identity in package.json, matrix current.since, and the
  // current compatibility row's `tui` (see docs/releasing.md — the version is
  // consumed when the corresponding release tag is published). A partial move (e.g.
  // version 0.5.1 with since 0.5.0, or a current row still naming the
  // previous TUI) must fail here instead of shipping a mixed identity.
  const version = packageJson.version
  assert.equal(typeof version, 'string', 'the package must declare a version')
  assert.equal(COMPAT_MATRIX.current.since, version, 'compat matrix current.since must equal the package version')
  const currentRows = COMPAT_MATRIX.matrix
    .filter(row => row.versions.includes(COMPAT_MATRIX.current.upgradeDsh))
  assert.equal(currentRows.length, 1, 'exactly one matrix row must cover the current DSH target')
  assert.equal(currentRows[0].tui, version, 'the current compatibility row must carry the package version as its TUI identity')
})
