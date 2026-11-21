/**
 * The published bundle must carry the two pinned Darwin pi-tui prebuilds at
 * the fixed `dist/native/darwin/prebuilds/<arch>/` paths, byte-for-byte.
 *
 * This exercises the real build step (`scripts/copy-pi-darwin-native.mjs`)
 * against a fixture package root: the positive case proves the copy and its
 * idempotent re-run; the negative cases prove the pinned Git blob, the exact
 * file size, the no-symlink rule and the exact-target-tree rule are enforced
 * BEFORE a mutated/foreign file can be published.
 *
 * @module darwin-native-copy.test
 */

import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { DARWIN_PREBUILDS, copyPiDarwinNative } from '../../scripts/copy-pi-darwin-native.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const SOURCE_ROOT = join(ROOT, 'packages', 'pi-tui', 'native', 'darwin', 'prebuilds')

function sourcePath(root, arch) {
  return join(root, 'packages', 'pi-tui', 'native', 'darwin', 'prebuilds', `darwin-${arch}`, 'darwin-platform.node')
}

function targetPath(root, arch) {
  return join(root, 'dist', 'native', 'darwin', 'prebuilds', `darwin-${arch}`, 'darwin-platform.node')
}

/** Seed a fixture root with the real pinned source assets. */
function seedSources(root) {
  for (const expected of DARWIN_PREBUILDS) {
    const target = sourcePath(root, expected.arch)
    mkdirSync(join(target, '..'), { recursive: true })
    copyFileSync(join(SOURCE_ROOT, `darwin-${expected.arch}`, 'darwin-platform.node'), target)
  }
}

test('copies both pinned Darwin addons byte-for-byte and re-runs idempotently', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('darwin-native-copy-')
  seedSources(root)

  const copied = copyPiDarwinNative({ root })
  assert.deepEqual(copied, DARWIN_PREBUILDS.map((expected) =>
    join('dist', 'native', 'darwin', 'prebuilds', `darwin-${expected.arch}`, 'darwin-platform.node')))
  for (const expected of DARWIN_PREBUILDS) {
    const bytes = readFileSync(targetPath(root, expected.arch))
    assert.equal(bytes.length, expected.size)
    assert.deepEqual(bytes, readFileSync(sourcePath(root, expected.arch)))
  }

  // A second build over the same dist must reproduce the exact bytes.
  const before = DARWIN_PREBUILDS.map((expected) => readFileSync(targetPath(root, expected.arch)))
  copyPiDarwinNative({ root })
  for (const [index, expected] of DARWIN_PREBUILDS.entries()) {
    assert.deepEqual(readFileSync(targetPath(root, expected.arch)), before[index])
  }
})

test('rejects a mutated or symlinked source asset before copying', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('darwin-native-copy-bad-source-')
  seedSources(root)

  const arm64 = sourcePath(root, 'arm64')
  const original = readFileSync(arm64)

  // Same size, different bytes: only the pinned Git blob can catch this.
  const mutated = Buffer.from(original)
  mutated[mutated.length - 1] ^= 0xff
  writeFileSync(arm64, mutated)
  assert.throws(() => copyPiDarwinNative({ root }), /pinned upstream Git blob/u)
  writeFileSync(arm64, original)

  // A different size is rejected explicitly.
  writeFileSync(arm64, Buffer.concat([original, Buffer.from([0])]))
  assert.throws(() => copyPiDarwinNative({ root }), /has \d+ bytes, expected 52024/u)
  writeFileSync(arm64, original)

  // A symlink must never be treated as the pinned asset.
  const real = join(root, 'real-arm64.node')
  writeFileSync(real, original)
  rmSync(arm64)
  symlinkSync(real, arm64)
  assert.throws(() => copyPiDarwinNative({ root }), /must not be a symlink/u)
})

test('refuses a foreign target and an extra file in the copied tree', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('darwin-native-copy-bad-target-')
  seedSources(root)

  // A target symlink could redirect the copy outside dist: refuse before copying.
  const outside = join(root, 'outside.node')
  writeFileSync(outside, 'untouched')
  const target = targetPath(root, 'x64')
  mkdirSync(join(target, '..'), { recursive: true })
  symlinkSync(outside, target)
  assert.throws(() => copyPiDarwinNative({ root }), /refusing to copy through a target symlink/u)
  assert.equal(readFileSync(outside, 'utf8'), 'untouched')

  // The copied tree is exactly two files; an extra .node is a packaging leak.
  rmSync(target)
  copyPiDarwinNative({ root })
  writeFileSync(join(root, 'dist', 'native', 'darwin', 'prebuilds', 'rogue.node'), 'extra')
  assert.throws(() => copyPiDarwinNative({ root }), /unexpected file\(s\) under dist\/native/u)
})

test('refuses a symlinked target parent before writing outside dist', (t) => {
  const life = testLifecycle(t)
  // Every existing component under the package root is checked, not only the
  // final file: a link at dist, prebuilds or the architecture directory must
  // fail BEFORE mkdir/copy can follow it.
  for (const shape of ['dist', 'prebuilds', 'arch']) {
    const root = life.tempDir(`darwin-native-copy-parent-${shape}-`)
    seedSources(root)
    const outside = life.tempDir(`darwin-native-copy-outside-${shape}-`)
    const dist = join(root, 'dist')
    if (shape === 'dist') {
      symlinkSync(outside, dist)
    } else {
      const darwin = join(dist, 'native', 'darwin')
      const prebuilds = join(darwin, 'prebuilds')
      mkdirSync(shape === 'prebuilds' ? darwin : prebuilds, { recursive: true })
      if (shape === 'prebuilds') symlinkSync(outside, prebuilds)
      else symlinkSync(outside, join(prebuilds, 'darwin-arm64'))
    }
    assert.throws(() => copyPiDarwinNative({ root }),
      /refusing to copy through target symlink/u, `${shape}: the copier must refuse the parent symlink`)
    assert.deepEqual(readdirSync(outside), [],
      `${shape}: no file may be written outside the package root`)
  }
})
