/**
 * Pure input qualification for the two-artifact Split Upgrade pair.
 *
 * These fixtures contain ONLY `package/package.json`. They prove the preflight
 * accepts and rejects the declared input classes before any work root, install
 * or Host process exists; they are never a qualification pairing.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/split-upgrade-pair.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, linkSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { npmDshVersion } from '../../scripts/lib/dsh-distribution.mjs'
import {
  assertSplitUpgradePairStillQualified,
  inspectSplitUpgradePair,
  NEW_TARBALL_ENV,
  OLD_TARBALL_ENV,
  readSplitUpgradePairEnvironment,
  UPGRADE_PACKAGE_NAME,
} from '../support/split-upgrade-pair.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const TARGET_PIN = npmDshVersion()
const OTHER_PIN = '0.2.1-rc.4'
const DSH_AGENT = '@deepseek-ai/dsh-agent'

function manifestOf(version, pin, extra = {}) {
  const manifest = { name: UPGRADE_PACKAGE_NAME, version, ...extra, devDependencies: {} }
  if (pin !== undefined) manifest.devDependencies[DSH_AGENT] = pin
  return manifest
}

/** One synthetic npm-layout artifact holding only the manifest preflight reads. */
function syntheticTarball(root, name, manifest) {
  const stage = join(root, `${name}-stage`)
  mkdirSync(join(stage, 'package'), { recursive: true })
  writeFileSync(join(stage, 'package', 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const path = join(root, `${name}.tgz`)
  const packed = spawnSync('tar', ['-czf', path, '-C', stage, 'package'], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  assert.equal(packed.status, 0, `the synthetic fixture could not be packed: ${packed.stderr}`)
  return path
}

function validPair(root, overrides = {}) {
  return {
    oldPath: syntheticTarball(root, 'old', manifestOf(overrides.oldVersion ?? '0.5.7', overrides.oldPin ?? TARGET_PIN)),
    newPath: syntheticTarball(root, 'new', manifestOf(overrides.newVersion ?? '0.5.8', overrides.newPin ?? TARGET_PIN, overrides.newExtra ?? {})),
  }
}

function expectInputError(run, code) {
  assert.throws(run, error => {
    assert.equal(error?.name, 'SplitSmokeInputError')
    assert.equal(error?.category, 'INPUT_UNQUALIFIED')
    assert.equal(error?.code, code)
    return true
  })
}

test('a valid old/new pair is accepted with distinct versions, bytes and exact pins', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('split-upgrade-pair-')
  const { oldPath, newPath } = validPair(root)
  const pair = inspectSplitUpgradePair(oldPath, newPath)
  assert.equal(pair.policy, 'default')
  assert.equal(pair.old.version, '0.5.7')
  assert.equal(pair.new.version, '0.5.8')
  assert.equal(pair.old.manifestPin, TARGET_PIN)
  assert.equal(pair.new.manifestPin, TARGET_PIN)
  assert.equal(pair.targetDshVersion, TARGET_PIN)
  assert.match(pair.old.sha256, /^[0-9a-f]{64}$/u)
  assert.match(pair.new.sha256, /^[0-9a-f]{64}$/u)
  assert.notEqual(pair.old.sha256, pair.new.sha256)
  assert.ok(!('manifest' in pair.old), 'raw manifest text must not leak into facts')
})

test('a same-SemVer pair passes only the trusted native policy', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('split-upgrade-pair-')
  const oldPath = syntheticTarball(root, 'native-old', manifestOf('0.5.8', TARGET_PIN, { description: 'old' }))
  const newPath = syntheticTarball(root, 'native-new', manifestOf('0.5.8', TARGET_PIN, { description: 'new' }))
  const pair = inspectSplitUpgradePair(oldPath, newPath, { policy: 'native' })
  assert.equal(pair.policy, 'native')
  assert.equal(pair.old.version, pair.new.version)
  assert.notEqual(pair.old.sha256, pair.new.sha256)
  expectInputError(() => inspectSplitUpgradePair(oldPath, newPath), 'INPUT_PAIR_SAME_VERSION')
})

test('an environment flag cannot make the default pairing policy native', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('split-upgrade-pair-')
  const oldPath = syntheticTarball(root, 'env-old', manifestOf('0.5.8', TARGET_PIN, { description: 'old' }))
  const newPath = syntheticTarball(root, 'env-new', manifestOf('0.5.8', TARGET_PIN, { description: 'new' }))
  process.env.SPLIT_UPGRADE_POLICY = 'native'
  try {
    expectInputError(() => inspectSplitUpgradePair(oldPath, newPath), 'INPUT_PAIR_SAME_VERSION')
  } finally {
    delete process.env.SPLIT_UPGRADE_POLICY
  }
})

test('missing, relative and unknown-policy inputs fail closed', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('split-upgrade-pair-')
  const { oldPath, newPath } = validPair(root)
  expectInputError(() => inspectSplitUpgradePair(undefined, newPath), 'INPUT_TARBALL_PATH_UNQUALIFIED')
  expectInputError(() => inspectSplitUpgradePair('relative-old.tgz', newPath), 'INPUT_TARBALL_PATH_UNQUALIFIED')
  expectInputError(() => inspectSplitUpgradePair(oldPath, undefined), 'INPUT_TARBALL_PATH_UNQUALIFIED')
  expectInputError(() => inspectSplitUpgradePair(oldPath, newPath, { policy: 'force' }), 'INPUT_PAIR_POLICY_INVALID')
})

test('same path and same bytes are rejected', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('split-upgrade-pair-')
  const { oldPath, newPath } = validPair(root)
  expectInputError(() => inspectSplitUpgradePair(oldPath, oldPath), 'INPUT_PAIR_SAME_PATH')
  const sameBytes = join(root, 'same-bytes.tgz')
  copyFileSync(oldPath, sameBytes)
  expectInputError(() => inspectSplitUpgradePair(oldPath, sameBytes), 'INPUT_PAIR_SAME_SHA')
})

test('wrong package name, invalid SemVer and a malformed tarball are input errors', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('split-upgrade-pair-')
  const wrongName = syntheticTarball(root, 'wrong-name', { name: 'other-package', version: '1.2.3', devDependencies: { [DSH_AGENT]: TARGET_PIN } })
  const invalidVersion = syntheticTarball(root, 'bad-version', manifestOf('1.2', TARGET_PIN))
  const corrupted = join(root, 'corrupted.tgz')
  writeFileSync(corrupted, 'this is not a gzip tar archive\n')
  const good = syntheticTarball(root, 'good', manifestOf('0.5.7', TARGET_PIN))
  expectInputError(() => inspectSplitUpgradePair(wrongName, good), 'INPUT_PACKAGE_NAME_MISMATCH')
  expectInputError(() => inspectSplitUpgradePair(invalidVersion, good), 'INPUT_PACKAGE_VERSION_INVALID')
  expectInputError(() => inspectSplitUpgradePair(corrupted, good), 'INPUT_TARBALL_MANIFEST_INVALID')
})

test('missing, ranged and mismatched exact DSH pins are input errors', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('split-upgrade-pair-')
  const missing = syntheticTarball(root, 'pin-missing', manifestOf('0.5.7', undefined))
  const ranged = syntheticTarball(root, 'pin-ranged', manifestOf('0.5.7', `^${TARGET_PIN}`))
  const other = syntheticTarball(root, 'pin-other', manifestOf('0.5.8', OTHER_PIN))
  const good = syntheticTarball(root, 'pin-good', manifestOf('0.5.7', TARGET_PIN))
  expectInputError(() => inspectSplitUpgradePair(missing, good), 'INPUT_DSH_PIN_MISSING_OR_INVALID')
  expectInputError(() => inspectSplitUpgradePair(ranged, good), 'INPUT_DSH_PIN_MISSING_OR_INVALID')
  expectInputError(() => inspectSplitUpgradePair(good, other), 'INPUT_DSH_PIN_MISMATCH')
})

test('symlinked and multi-hard-link artifacts are rejected', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('split-upgrade-pair-')
  const { oldPath, newPath } = validPair(root)
  const symlinkPath = join(root, 'symlink.tgz')
  symlinkSync(oldPath, symlinkPath)
  expectInputError(() => inspectSplitUpgradePair(symlinkPath, newPath), 'INPUT_TARBALL_FILE_UNQUALIFIED')
  const hardlinkPath = join(root, 'hardlink.tgz')
  linkSync(oldPath, hardlinkPath)
  expectInputError(() => inspectSplitUpgradePair(hardlinkPath, newPath), 'INPUT_TARBALL_HARDLINK_UNQUALIFIED')
})

test('a changed artifact is refused at install-time re-verification', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('split-upgrade-pair-')
  const { oldPath, newPath } = validPair(root)
  const pair = inspectSplitUpgradePair(oldPath, newPath)
  const replacement = syntheticTarball(root, 'replacement', manifestOf('0.5.8', TARGET_PIN, { description: 'replaced' }))
  copyFileSync(replacement, newPath)
  expectInputError(() => assertSplitUpgradePairStillQualified(pair), 'INPUT_PAIR_CHANGED')
})

test('the environment inputs are required and never discovered implicitly', () => {
  const old = process.env[OLD_TARBALL_ENV]
  const updated = process.env[NEW_TARBALL_ENV]
  delete process.env[OLD_TARBALL_ENV]
  delete process.env[NEW_TARBALL_ENV]
  try {
    expectInputError(() => readSplitUpgradePairEnvironment(), 'INPUT_TARBALL_PATH_UNQUALIFIED')
  } finally {
    if (old !== undefined) process.env[OLD_TARBALL_ENV] = old
    if (updated !== undefined) process.env[NEW_TARBALL_ENV] = updated
  }
})

test('a rejected pair creates no Scene root or install transaction', t => {
  const life = testLifecycle(t)
  const tmpBase = life.tempDir('split-upgrade-pair-base-')
  const root = life.tempDir('split-upgrade-pair-')
  const { oldPath, newPath } = validPair(root, { newVersion: '0.5.7', newExtra: { description: 'different bytes' } })
  expectInputError(() => inspectSplitUpgradePair(oldPath, newPath), 'INPUT_PAIR_SAME_VERSION')
  assert.deepEqual(readdirSync(tmpBase), [], 'a rejected pairing must create no Scene root')
})
