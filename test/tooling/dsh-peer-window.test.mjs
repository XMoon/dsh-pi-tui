import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import test from 'node:test'

import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

import { COMPAT_MATRIX } from '../../scripts/lib/dsh-compat.mjs'

const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
// The support floor is the newest matrix row's `dshFrom` — the boundary below
// which src/startup.ts still reports an incompatible runtime. `current.upgradeDsh`
// is the recommended install target, derived independently from that floor; it is
// deliberately not consulted here, so a floor move and a target move stay
// separate decisions.
const supportedFloor = COMPAT_MATRIX.matrix.at(-1).dshFrom
const expectedWindow = `>=${supportedFloor}`
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
  // The 0.2.2-rc.1 adaptation lifts the whole peer policy onto the 0.2.2-rc.1
  // floor: the 0.5.6 line is qualified against that exact published family and
  // no longer claims the 0.2.1-rc.* family (npm semver excludes a
  // different-major.minor.patch prerelease). The window stays open-ended above
  // 0.2.2-rc.1; only the lower bound moved.
  for (const [name, range] of dshPeerEntries) {
    assert.equal(range, expectedWindow, `${name} must use the open-ended support lower bound`)
    assert.equal(semver.validRange(range) !== null, true, `${name} peer range must be valid semver syntax`)
    assert.equal(semver.satisfies('0.2.2-rc.1', range), true, `${name} must include its published npm floor`)
    // A later prerelease of the SAME major.minor.patch tuple orders above the
    // floor; a different tuple's prerelease is excluded by npm range semantics
    // (this is why the previous 0.2.1-rc.* family drops out entirely).
    assert.equal(semver.satisfies('0.2.2-rc.2', range), true, `${name} must accept a later rc of the same tuple`)
    assert.equal(semver.satisfies('0.2.2-rc.0', range), false, `${name} must reject the prerelease below the floor`)
    assert.equal(semver.satisfies('0.2.2-alpha.3', range), false, `${name} must reject the alpha line below the floor`)
    assert.equal(semver.satisfies('0.2.1-rc.5', range), false, `${name} must reject the previous 0.2.1-rc.5 family`)
    assert.equal(semver.satisfies('0.2.1', range), false, `${name} must reject the previous stable 0.2.1 line`)
    assert.equal(semver.satisfies('0.2.0-rc.2', range), false, `${name} must reject the previous 0.2.0-rc.2 line`)
    assert.equal(semver.satisfies('0.1.7-rc.2', range), false, `${name} must reject the legacy 0.1.7 line below the floor`)
    assert.equal(semver.satisfies('0.2.2', range), true, `${name} must remain open to the floor tuple's stable release`)
    assert.equal(semver.satisfies('0.2.3', range), true, `${name} must remain open to later compatible releases`)
    assert.equal(semver.satisfies('1.0.0', range), true, `${name} must remain open to later major lines`)
    assert.equal(semver.satisfies('0.2.3-alpha.1', range), false, `${name} must not claim an unqualified cross-tuple prerelease`)
  }
})

test('engines.dsh restates the matrix support floor and the official evaluator enforces it', () => {
  const engines = packageJson.engines
  assert.ok(engines !== null && typeof engines === 'object' && !Array.isArray(engines),
    'package.json engines must be an object')
  assert.equal(typeof engines.node, 'string', 'the existing Node engine requirement must stay declared')
  assert.equal(engines.dsh, expectedWindow, 'engines.dsh must equal the matrix support floor')
  assert.equal(semver.validRange(engines.dsh) !== null, true, 'engines.dsh must be valid semver syntax')
  assert.equal(engines.dsh.startsWith('workspace:'), false,
    'engines.dsh must be a registry range, never a workspace protocol')
  for (const [name, range] of dshPeerEntries) {
    assert.equal(engines.dsh, range, `engines.dsh must restate the ${name} peer range`)
  }

  // The official app-boot evaluator — never a local classifier — decides the
  // runtime contract: an own `engines.dsh` range decides alone (peer ranges are
  // ignored) and prereleases participate in the range.
  assert.equal(evaluatePluginCompatibility(packageJson, {}, supportedFloor), undefined,
    `the official evaluator must admit its own floor ${supportedFloor}`)
  for (const rejected of ['0.2.2-rc.0', '0.2.1-rc.5', '0.2.1', '0.2.0-rc.2']) {
    const issue = evaluatePluginCompatibility(packageJson, {}, rejected)
    assert.notEqual(issue, undefined, `the official evaluator must reject ${rejected}`)
    assert.deepEqual(Object.keys(issue.requirements), ['engines.dsh'],
      `the ${rejected} rejection must be reported under engines.dsh, not as a peer`)
    assert.equal(issue.requirements['engines.dsh'], expectedWindow)
  }
})

test('engines.node declares the target Node floor, not a floating major', () => {
  // Node's own engine semantics decide support: the DSH 0.2.2-rc.1 CLI declares
  // `>=24.9.0`, so the TUI restates that exact floor instead of a floating
  // `24` major that a CI image happens to provide.
  const range = packageJson.engines.node
  assert.equal(range, '>=24.9.0')
  assert.equal(semver.validRange(range) !== null, true, 'engines.node must be valid semver syntax')
  assert.equal(semver.satisfies('24.8.0', range), false, 'the Node floor must reject 24.8.0')
  assert.equal(semver.satisfies('24.9.0', range), true, 'the Node floor must admit 24.9.0')
  assert.equal(semver.satisfies('24.22.2', range), true, 'the locked development Node must be supported')
  assert.equal(semver.satisfies('26.0.0', range), true, 'a later major must stay supported')
  assert.equal(semver.satisfies('22.19.0', range), false, 'the retired Node 22 line must be rejected')
  assert.equal(semver.satisfies('24.0.0', range), false, 'Node 24.0.0 predates the floor')
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
  // current compatibility row's `tui` (see docs/guides/releasing.md — the version is
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
