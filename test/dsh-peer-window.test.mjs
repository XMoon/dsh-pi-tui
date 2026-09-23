import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import test from 'node:test'

const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
const expectedWindow = '>=0.1.6-alpha.2'
const newFamilyWindow = '>=0.1.7-alpha.2'
const expectedDevVersion = Object.entries(packageJson.devDependencies ?? {})
  .find(([name]) => name.startsWith('@deepseek-ai/dsh'))?.[1]
const expectedNpmTarget = process.env.DSH_NPM_VERIFY_TARGET ?? '0.1.7-alpha.2'
const dshPeerEntries = Object.entries(packageJson.peerDependencies ?? {})
  .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))

// This is a package-family contract, not a string-only policy check. The
// boundary assertions use npm's semver evaluator so prerelease behavior is
// tested with the same range semantics consumers use.
test('all DSH runtime peers use the published npm lower bound', () => {
  assert.ok(dshPeerEntries.length > 0, 'the bundle must declare DSH runtime peers')
  // The 0.1.7 preset packages (PR A) exist only in the 0.1.7 family; the
  // legacy family keeps the published 0.1.6 floor until the compatibility
  // train's closure PR unifies the whole peer policy deliberately.
  const newFamily = new Set(['@deepseek-ai/dsh-agent-preset-registry'])
  for (const [name, range] of dshPeerEntries) {
    const window = newFamily.has(name) ? newFamilyWindow : expectedWindow
    const floor = newFamily.has(name) ? '0.1.7-alpha.2' : '0.1.6-alpha.2'
    assert.equal(range, window, `${name} must use the open-ended support lower bound`)
    assert.equal(semver.validRange(range) !== null, true, `${name} peer range must be valid semver syntax`)
    assert.equal(semver.satisfies(floor, range), true, `${name} must include its published npm floor`)
    assert.equal(semver.satisfies('0.1.6-alpha.1', range), false, `${name} must reject the previous alpha, which lacks the alpha.2 Client contract`)
    assert.equal(semver.satisfies('0.1.5-rc.2', range), false, `${name} must reject the previous rc line`)
    assert.equal(semver.satisfies('0.1.5-rc.1', range), false, `${name} must reject the previous rc line`)
    assert.equal(semver.satisfies('0.1.5', range), false, `${name} must reject the previous stable line`)
    assert.equal(semver.satisfies('0.1.6-alpha.0', range), false, `${name} must exclude the earlier alpha`)
    assert.equal(semver.satisfies('0.1.6', range), !newFamily.has(name), `${name} stable openness follows its family floor`)
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
