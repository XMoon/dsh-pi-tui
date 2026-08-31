import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import test from 'node:test'

const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
const expectedWindow = '>=0.1.2-alpha.2'
const dshPeerEntries = Object.entries(packageJson.peerDependencies ?? {})
  .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))

// This is a package-family contract, not a string-only policy check. The
// boundary assertions use npm's semver evaluator so prerelease behavior is
// tested with the same range semantics consumers use.
test('all DSH runtime peers use the open-ended 0.1.2 lower bound', () => {
  assert.ok(dshPeerEntries.length > 0, 'the bundle must declare DSH runtime peers')
  for (const [name, range] of dshPeerEntries) {
    assert.equal(range, expectedWindow, `${name} must use the open-ended support lower bound`)
    assert.equal(semver.validRange(range) !== null, true, `${name} peer range must be valid semver syntax`)
    assert.equal(semver.satisfies('0.1.2-alpha.2', range), true, `${name} must include the target alpha`)
    assert.equal(semver.satisfies('0.1.2', range), true, `${name} must include the target stable release`)
    assert.equal(semver.satisfies('0.1.2-alpha.0', range), false, `${name} must exclude the earlier alpha`)
    assert.equal(semver.satisfies('0.1.3-alpha.1', range), false, `${name} must not opt into an unrelated prerelease line`)
    assert.equal(semver.satisfies('0.1.3', range), true, `${name} must remain open to later compatible releases`)
  }
})

test('all DSH development packages stay pinned to the exact target alpha', () => {
  const dshDevEntries = Object.entries(packageJson.devDependencies ?? {})
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh'))
  assert.ok(dshDevEntries.length > 0, 'the bundle must have target DSH development packages')
  for (const [name, version] of dshDevEntries) {
    assert.equal(version, '0.1.2-alpha.3', `${name} must stay exact`)
  }
})
