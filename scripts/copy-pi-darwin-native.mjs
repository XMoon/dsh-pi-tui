#!/usr/bin/env node
/**
 * Copy the pinned Darwin pi-tui N-API prebuilds into the published bundle.
 *
 * `packages/pi-tui/native/darwin/prebuilds/` is the single source asset
 * (vendored byte-for-byte from the pinned upstream commit in UPSTREAM.json).
 * The published `@xmoon76/dsh-pi-tui` tarball only ships `dist`, so this
 * build step copies the two files into `dist/native/darwin/prebuilds/<arch>/`,
 * where the bundled fork's `getNativeModuleCandidates()` resolves them from
 * the installed package. It runs AFTER both tsdown configs (see
 * `build:bundle`), never at install time: the tarball is packed with
 * `--config.ignore-scripts=true`.
 *
 * The fixed object IDs are the upstream Git blob IDs of the two files. The
 * copy is intentionally not configurable: exactly two architectures, no
 * glob, URL, version or architecture discovery.
 *
 * @module copy-pi-darwin-native
 */

import { createHash } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The two pinned Mach-O addons, by their upstream Git blob IDs. */
export const DARWIN_PREBUILDS = [
  { arch: 'arm64', size: 52_024, gitBlob: '3294b6bffd36eaab70d61134e9955992f31f9a8f' },
  { arch: 'x64', size: 22_784, gitBlob: '014383575508654d9f898ee25631b88db8d9740c' },
]

const SOURCE_ROOT = join('packages', 'pi-tui', 'native', 'darwin', 'prebuilds')
const TARGET_ROOT = join('dist', 'native', 'darwin', 'prebuilds')

function relativeAsset(arch) {
  return join(`darwin-${arch}`, 'darwin-platform.node')
}

/** Git's blob object ID: `sha1("blob <bytes>\\0" + content)`. */
function gitBlobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

/**
 * A present, regular, non-symlink file whose exact bytes are the pinned
 * upstream blob. `label` names the location in the failure so a missing
 * source asset and a mutated target are distinguishable.
 */
function assertPinnedFile(path, expected, label) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    throw new Error(`${label} is missing: ${path} (${error.code ?? error.message})`)
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`)
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`)
  const bytes = readFileSync(path)
  if (bytes.length !== expected.size) {
    throw new Error(`${label} has ${bytes.length} bytes, expected ${expected.size}: ${path}`)
  }
  const gitBlob = gitBlobSha(bytes)
  if (gitBlob !== expected.gitBlob) {
    throw new Error(`${label} does not match pinned upstream Git blob ${expected.gitBlob} (got ${gitBlob}): ${path}`)
  }
}

function assertNoForeignTarget(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error(`refusing to copy through a target symlink: ${path}`)
  if (!stat.isFile()) throw new Error(`target exists and is not a regular file: ${path}`)
}

/** Reject any extra file under the copied prebuild tree (the tree is exactly two assets). */
function assertExactTargetTree(targetRoot) {
  const expected = new Set(DARWIN_PREBUILDS.map((entry) => relativeAsset(entry.arch)))
  const found = []
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry)
      const relativePath = prefix === '' ? entry : join(prefix, entry)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) throw new Error(`unexpected symlink under dist/native: ${full}`)
      if (stat.isDirectory()) walk(full, relativePath)
      else if (stat.isFile()) found.push(relativePath)
      else throw new Error(`unexpected non-regular entry under dist/native: ${full}`)
    }
  }
  walk(targetRoot, '')
  const extra = found.filter((path) => !expected.has(path))
  if (extra.length > 0) {
    throw new Error(`unexpected file(s) under dist/native/darwin/prebuilds: ${extra.join(', ')}`)
  }
  const missing = [...expected].filter((path) => !found.includes(path))
  if (missing.length > 0) {
    throw new Error(`missing copied prebuild(s): ${missing.join(', ')}`)
  }
}

/**
 * Copy both pinned addons into `dist/native/darwin/prebuilds/` after
 * verifying the source bytes before and the target bytes after the copy.
 *
 * @param {{root?: string}} [options] the package root (tests use a fixture root)
 * @returns {string[]} the copied paths relative to the package root
 */
export function copyPiDarwinNative({ root = ROOT } = {}) {
  const sourceRoot = join(root, SOURCE_ROOT)
  const targetRoot = join(root, TARGET_ROOT)
  const copied = []
  for (const expected of DARWIN_PREBUILDS) {
    const source = join(sourceRoot, relativeAsset(expected.arch))
    const target = join(targetRoot, relativeAsset(expected.arch))
    assertPinnedFile(source, expected, 'source prebuild')
    assertNoForeignTarget(target)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    assertPinnedFile(target, expected, 'copied prebuild')
    copied.push(relative(root, target))
  }
  assertExactTargetTree(targetRoot)
  return copied
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    for (const path of copyPiDarwinNative()) console.log(`copy-pi-darwin-native: copied ${path}`)
  } catch (error) {
    console.error(`COPY_PI_DARWIN_NATIVE_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
