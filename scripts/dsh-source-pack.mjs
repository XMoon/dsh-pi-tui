#!/usr/bin/env node
/**
 * Build the pinned DeepSeek Harness source checkout through its official build
 * and release-pack commands, then validate and describe the complete local
 * DSH tarball family.
 *
 * This script deliberately owns no TUI build or runtime smoke logic.
 *
 * Usage:
 *   node scripts/dsh-source-pack.mjs --dsh-dir /path/to/deepseek-harness \
 *     --out /tmp/dsh-source-pack
 *
 * @module dsh-source-pack
 */

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_SOURCE_CONFIG,
  DSH_CLI_PACKAGE,
  PACKAGE_ROOT,
  SOURCE_MANIFEST_NAME,
  loadDshDistributionManifest,
  packageMapFromTarballs,
  loadDshSourceConfig,
  validateDshSourceConfig,
  printDshProvenance,
  validateSourceDistribution,
  validateSourceIdentity,
} from './lib/dsh-distribution.mjs'
import { pnpmExecutable, runBounded } from './lib/process.mjs'

const PNPM_COMMAND = pnpmExecutable()
const DEFAULT_OUTPUT = join(process.env.RUNNER_TEMP ?? '/tmp', 'dsh-source-pack')
const OFFICIAL_TIMEOUTS = {
  install: 20 * 60 * 1000,
  clean: 10 * 60 * 1000,
  build: 45 * 60 * 1000,
  pack: 45 * 60 * 1000,
}

function fail(message) {
  throw new Error(message)
}

function pathInside(child, parent) {
  const relativePath = relative(parent, child)
  return relativePath === '' || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
}

/** Resolve existing path components so symlinked parents cannot bypass roots. */
function canonicalPath(path) {
  const missing = []
  let current = resolve(path)
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return current
    missing.unshift(basename(current))
    current = parent
  }
  return missing.reduce((parent, entry) => join(parent, entry), realpathSync(current))
}

/**
 * Validate an output path before the packer claims it. Existing directories
 * are never replaced: callers must choose a fresh dedicated output path so
 * cleanup cannot destroy an arbitrary filesystem tree.
 */
export function validateSourcePackOutput(outputPath, dshDir) {
  const requested = resolve(outputPath)
  const source = resolve(dshDir)
  const requestedInfo = existsSync(requested) ? lstatSync(requested) : undefined
  if (requestedInfo?.isSymbolicLink()) fail(`source pack output must not be a symlink: ${requested}`)
  const canonicalOutput = canonicalPath(requested)
  const canonicalSource = canonicalPath(source)
  const canonicalTui = canonicalPath(PACKAGE_ROOT)
  if (pathInside(canonicalOutput, canonicalSource)) fail(`source pack output must not be inside the DSH checkout: ${requested}`)
  if (pathInside(canonicalOutput, canonicalTui)) fail(`source pack output must not be inside the TUI checkout: ${requested}`)
  const parent = dirname(canonicalOutput)
  if (parent === canonicalOutput || dirname(parent) === parent) {
    fail(`source pack output must be a dedicated child directory: ${requested}`)
  }
  if (!existsSync(canonicalOutput)) return canonicalOutput

  const info = lstatSync(canonicalOutput)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`source pack output must be a real directory: ${requested}`)
  const entries = readdirSync(canonicalOutput)
  if (entries.length === 0) fail(`source pack output already exists; remove it before packing: ${requested}`)
  if (!entries.includes(SOURCE_MANIFEST_NAME)) {
    fail(`refusing to use non-source-pack directory: ${requested}`)
  }
  const allowed = entries.every(entry => {
    if (!(entry === SOURCE_MANIFEST_NAME || /^[A-Za-z0-9@._+-]+\.tgz$/u.test(entry))) return false
    return lstatSync(join(canonicalOutput, entry)).isFile()
  })
  if (!allowed) fail(`refusing to use a source-pack directory with unexpected files: ${requested}`)
  try {
    loadDshDistributionManifest(canonicalOutput, {
      packageJson: {},
      requiredPackages: [DSH_CLI_PACKAGE],
    })
  } catch (error) {
    fail(`refusing to use an invalid source-pack directory: ${requested}${error instanceof Error ? `: ${error.message}` : ''}`)
  }
  fail(`source pack output already exists; remove it before packing: ${requested}`)
}

/** Atomically claim an absent output directory before any packer writes to it. */
export function claimSourcePackOutput(output) {
  const parentPath = dirname(output)
  mkdirSync(parentPath, { recursive: true })
  const parent = lstatSync(parentPath)
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail(`source pack output parent is not a real directory: ${parentPath}`)
  mkdirSync(output)
  const info = lstatSync(output)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`source pack output claim is not a real directory: ${output}`)
  return { path: output, parentPath, parentDev: parent.dev, parentIno: parent.ino, dev: info.dev, ino: info.ino }
}

/** Verify that the process still owns the claimed output and its parent. */
function assertClaimedSourcePackOutput(owner, action) {
  let parent
  let info
  try {
    parent = lstatSync(owner.parentPath)
    info = lstatSync(owner.path)
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`source pack output disappeared during ${action}: ${owner.path}`)
    throw error
  }
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== owner.parentDev || parent.ino !== owner.parentIno
    || !info.isDirectory() || info.isSymbolicLink() || info.dev !== owner.dev || info.ino !== owner.ino) {
    fail(`source pack output ownership changed during ${action}: ${owner.path}`)
  }
  return info
}

/** Quarantine and remove only the directory inode this process claimed. */
export function removeClaimedSourcePackOutput(owner) {
  let parent
  let info
  try {
    parent = lstatSync(owner.parentPath)
    info = lstatSync(owner.path)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== owner.parentDev || parent.ino !== owner.parentIno
    || !info.isDirectory() || info.isSymbolicLink() || info.dev !== owner.dev || info.ino !== owner.ino) return false
  const quarantine = join(owner.parentPath, `.dsh-source-pack-cleanup-${process.pid}-${randomUUID()}`)
  try {
    renameSync(owner.path, quarantine)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
  const moved = lstatSync(quarantine)
  if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== owner.dev || moved.ino !== owner.ino) return false
  rmSync(quarantine, { recursive: true, force: true })
  return true
}

function parseCli() {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  const { values } = parseArgs({
    args,
    options: {
      'dsh-dir': { type: 'string' },
      ref: { type: 'string' },
      'expected-version': { type: 'string' },
      out: { type: 'string' },
      config: { type: 'string' },
    },
    allowPositionals: false,
  })
  return values
}

export function officialCommandEnvironment(base = process.env) {
  return {
    ...base,
    CI: base.CI ?? 'true',
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false',
  }
}

async function runOfficial(dshDir, args, timeoutMs) {
  console.log(`DSH source command: pnpm ${args.join(' ')}`)
  const result = await runBounded(PNPM_COMMAND, args, {
    cwd: dshDir,
    env: officialCommandEnvironment(),
    timeoutMs,
    label: `official DSH command: pnpm ${args.join(' ')}`,
  })
  if (result.status !== 0 || result.timedOut) {
    fail(`official DSH command failed${result.error ? `: ${result.error.message}` : ` with exit ${result.status ?? 'unknown'}`}`)
  }
}

async function main() {
  const values = parseCli()
  const configPath = values.config ?? DEFAULT_SOURCE_CONFIG
  const tracked = loadDshSourceConfig(configPath)
  const effective = validateDshSourceConfig({
    ...tracked,
    ref: values.ref ?? tracked.ref,
    expectedVersion: values['expected-version'] ?? tracked.expectedVersion,
  })
  const dshDir = values['dsh-dir'] ?? process.env.DSH_DIR
  if (typeof dshDir !== 'string' || dshDir.trim() === '') {
    fail('--dsh-dir is required (or set DSH_DIR)')
  }
  const identity = validateSourceIdentity(dshDir, effective, {
    ci: process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true',
  })
  if (identity.dirty) console.error('WARNING: DIRTY DSH SOURCE TREE (reproducible = false)')

  const output = validateSourcePackOutput(values.out ?? DEFAULT_OUTPUT, identity.directory)
  const owner = claimSourcePackOutput(output)
  try {
    assertClaimedSourcePackOutput(owner, 'initialization')
    await runOfficial(identity.directory, ['install', '--frozen-lockfile'], OFFICIAL_TIMEOUTS.install)
    // Local source checkouts can retain ignored tsbuildinfo/lib state from an
    // earlier build. Clean only generated repository-owned outputs so the same
    // official build is reproducible without requiring a pristine local tree.
    await runOfficial(identity.directory, ['clean'], OFFICIAL_TIMEOUTS.clean)
    await runOfficial(identity.directory, ['build:official'], OFFICIAL_TIMEOUTS.build)
    await runOfficial(identity.directory, ['release:pack', '--family', 'dsh', '--out', output], OFFICIAL_TIMEOUTS.pack)
    assertClaimedSourcePackOutput(owner, 'official release pack')

    // The official packer writes publish-order.txt for registry publishing. Source
    // mode only needs immutable tarballs plus its generated distribution manifest;
    // discard every other top-level output before the artifact is uploaded.
    const packedEntries = readdirSync(output)
    assertClaimedSourcePackOutput(owner, 'listing packed output')
    for (const entry of packedEntries) {
      if (entry.endsWith('.tgz')) continue
      assertClaimedSourcePackOutput(owner, `filtering ${entry}`)
      const path = join(output, entry)
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink()) fail(`source pack produced a non-regular disposable entry: ${path}`)
      unlinkSync(path)
    }
    assertClaimedSourcePackOutput(owner, 'post-pack filtering')

    const packageEntries = packageMapFromTarballs(output, effective.expectedVersion)
    assertClaimedSourcePackOutput(owner, 'package map validation')
    const manifest = {
      schemaVersion: 1,
      mode: 'source-pack',
      repository: effective.repository,
      sourceRef: identity.head,
      sourceSha: identity.head,
      version: effective.expectedVersion,
      dirty: identity.dirty,
      reproducible: identity.reproducible,
      outputIdentity: { dev: String(owner.dev), ino: String(owner.ino) },
      packages: Object.fromEntries([...packageEntries.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => [name, entry.fileName])),
    }
    assertClaimedSourcePackOutput(owner, 'manifest write')
    writeFileSync(join(output, 'dsh-source-distribution.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    assertClaimedSourcePackOutput(owner, 'distribution validation')
    const distribution = validateSourceDistribution({ manifest, directory: output })
    assertClaimedSourcePackOutput(owner, 'final distribution validation')
    printDshProvenance(distribution)
    console.log(`DSH source distribution written to ${output}`)
    return output
  } catch (error) {
    try {
      if (!removeClaimedSourcePackOutput(owner)) {
        throw new Error(`source pack output ownership changed; refusing cleanup: ${output}`)
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `failed to clean incomplete source pack ${output}`)
    }
    throw error
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`DSH_SOURCE_PACK_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
