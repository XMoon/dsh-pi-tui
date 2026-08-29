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
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
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

/** Record every existing canonical directory ancestor from the deepest anchor. */
function directoryAncestors(anchor) {
  const ancestors = []
  let current = anchor
  while (true) {
    const info = lstatSync(current)
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`source pack output ancestor must be a real directory: ${current}`)
    ancestors.push({ path: current, dev: info.dev, ino: info.ino })
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return ancestors
}

/**
 * Validate an output path before the packer claims it. Existing directories
 * are never replaced: callers must choose a fresh dedicated output path whose
 * parent already exists, so cleanup cannot destroy an arbitrary filesystem tree.
 */
export function validateSourcePackOutputInfo(outputPath, dshDir) {
  const requested = resolve(outputPath)
  const source = resolve(dshDir)
  const requestedInfo = existsSync(requested) ? lstatSync(requested) : undefined
  if (requestedInfo?.isSymbolicLink()) fail(`source pack output must not be a symlink: ${requested}`)
  const canonicalOutput = canonicalPath(requested)
  const outputExists = existsSync(canonicalOutput)
  const parent = dirname(canonicalOutput)
  if (!existsSync(parent)) fail(`source pack output parent must already exist: ${requested}`)
  const ancestors = directoryAncestors(parent)
  const canonicalSource = canonicalPath(source)
  const canonicalTui = canonicalPath(PACKAGE_ROOT)
  if (pathInside(canonicalOutput, canonicalSource)) fail(`source pack output must not be inside the DSH checkout: ${requested}`)
  if (pathInside(canonicalOutput, canonicalTui)) fail(`source pack output must not be inside the TUI checkout: ${requested}`)
  if (parent === canonicalOutput || dirname(parent) === parent) {
    fail(`source pack output must be a dedicated child directory: ${requested}`)
  }
  if (!outputExists) return { path: canonicalOutput, ancestors }

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

export function validateSourcePackOutput(outputPath, dshDir) {
  return validateSourcePackOutputInfo(outputPath, dshDir).path
}

/** Confirm that every canonical ancestor still has its validated inode. */
function verifyAncestors(ancestors, action) {
  for (const ancestor of ancestors) {
    let info
    try {
      info = lstatSync(ancestor.path)
    } catch (error) {
      if (error?.code === 'ENOENT') fail(`source pack output ancestor disappeared during ${action}: ${ancestor.path}`)
      throw error
    }
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== ancestor.dev || info.ino !== ancestor.ino) {
      fail(`source pack output ancestor changed during ${action}: ${ancestor.path}`)
    }
  }
}

/** Atomically claim an absent output directory before any packer writes to it. */
export function claimSourcePackOutput(output, validation = undefined) {
  const parentPath = dirname(output)
  const expectedAncestors = validation?.ancestors ?? directoryAncestors(parentPath)
  verifyAncestors(expectedAncestors, 'claim')
  const parent = lstatSync(parentPath)
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail(`source pack output parent is not a real directory: ${parentPath}`)
  verifyAncestors(expectedAncestors, 'claim')
  mkdirSync(output)
  const info = lstatSync(output)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`source pack output claim is not a real directory: ${output}`)
  const ancestors = directoryAncestors(parentPath)
  verifyAncestors(expectedAncestors, 'claim')
  return { path: output, parentPath, ancestors, parentDev: parent.dev, parentIno: parent.ino, dev: info.dev, ino: info.ino }
}

/** Create a private root that the official packer can freely replace below. */
export function claimSourcePackStaging() {
  const path = mkdtempSync(join(tmpdir(), `dsh-source-pack-stage-${process.pid}-`))
  const parentPath = dirname(path)
  const ancestors = directoryAncestors(parentPath)
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`source pack staging root is not a real directory: ${path}`)
  return { path, parentPath, ancestors, parentDev: lstatSync(parentPath).dev, parentIno: lstatSync(parentPath).ino, dev: info.dev, ino: info.ino }
}

function ownerState(owner) {
  try {
    for (const ancestor of owner.ancestors) {
      const info = lstatSync(ancestor.path)
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== ancestor.dev || info.ino !== ancestor.ino) return false
    }
    const info = lstatSync(owner.path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== owner.dev || info.ino !== owner.ino) return false
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Verify that the process still owns the claimed output and every ancestor. */
function assertClaimedSourcePackOutput(owner, action) {
  const state = ownerState(owner)
  if (state === undefined) fail(`source pack output disappeared during ${action}: ${owner.path}`)
  if (!state) fail(`source pack output ownership changed during ${action}: ${owner.path}`)
}

/** Quarantine and remove only the directory inode this process claimed. */
export function removeClaimedSourcePackOutput(owner) {
  const state = ownerState(owner)
  if (state === undefined) return true
  if (!state) return false
  // The private quarantine prevents a raced destination path from becoming a
  // recursive-delete target. If the source path was replaced before rename,
  // the moved inode fails the proof and this private tree is intentionally kept.
  const quarantineRoot = mkdtempSync(join(tmpdir(), `dsh-source-pack-cleanup-${process.pid}-`))
  const quarantine = join(quarantineRoot, 'claimed')
  try {
    renameSync(owner.path, quarantine)
  } catch (error) {
    rmdirSync(quarantineRoot)
    if (error?.code === 'ENOENT') return true
    throw error
  }
  const moved = lstatSync(quarantine)
  if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== owner.dev || moved.ino !== owner.ino) return false
  rmSync(quarantine, { recursive: true, force: true })
  rmdirSync(quarantineRoot)
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

  const validation = validateSourcePackOutputInfo(values.out ?? DEFAULT_OUTPUT, identity.directory)
  const output = validation.path
  const staging = claimSourcePackStaging()
  let outputOwner
  let stagingRemoved = false
  try {
    const stageOutput = join(staging.path, 'output')
    assertClaimedSourcePackOutput(staging, 'initialization')
    await runOfficial(identity.directory, ['install', '--frozen-lockfile'], OFFICIAL_TIMEOUTS.install)
    // Local source checkouts can retain ignored tsbuildinfo/lib state from an
    // earlier build. Clean only generated repository-owned outputs so the same
    // official build is reproducible without requiring a pristine local tree.
    await runOfficial(identity.directory, ['clean'], OFFICIAL_TIMEOUTS.clean)
    await runOfficial(identity.directory, ['build:official'], OFFICIAL_TIMEOUTS.build)
    await runOfficial(identity.directory, ['release:pack', '--family', 'dsh', '--out', stageOutput], OFFICIAL_TIMEOUTS.pack)
    assertClaimedSourcePackOutput(staging, 'official release pack')

    const stageInfo = lstatSync(stageOutput)
    if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink()) fail(`source pack produced an invalid output directory: ${stageOutput}`)
    // The official packer writes publish-order.txt for registry publishing. Source
    // mode only needs immutable tarballs plus its generated distribution manifest;
    // discard every other top-level output before the artifact is uploaded.
    const packedEntries = readdirSync(stageOutput)
    assertClaimedSourcePackOutput(staging, 'listing packed output')
    for (const entry of packedEntries) {
      if (entry.endsWith('.tgz')) continue
      assertClaimedSourcePackOutput(staging, `filtering ${entry}`)
      const path = join(stageOutput, entry)
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink()) fail(`source pack produced a non-regular disposable entry: ${path}`)
      unlinkSync(path)
    }
    assertClaimedSourcePackOutput(staging, 'post-pack filtering')

    const packageEntries = packageMapFromTarballs(stageOutput, effective.expectedVersion)
    assertClaimedSourcePackOutput(staging, 'package map validation')
    const manifestFor = owner => ({
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
    })
    const stageManifest = manifestFor(stageInfo)
    assertClaimedSourcePackOutput(staging, 'staged manifest write')
    writeFileSync(join(stageOutput, SOURCE_MANIFEST_NAME), `${JSON.stringify(stageManifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    assertClaimedSourcePackOutput(staging, 'staged distribution validation')
    validateSourceDistribution({ manifest: stageManifest, directory: stageOutput })
    assertClaimedSourcePackOutput(staging, 'staged final validation')

    // Reserve the caller's final path only after the complete source pack is
    // validated. mkdir is exclusive, so an output that appeared meanwhile is
    // never replaced; all packer-owned work remains in the private staging root.
    outputOwner = claimSourcePackOutput(output, validation)
    const finalManifest = manifestFor(outputOwner)
    for (const entry of packedEntries) {
      if (!entry.endsWith('.tgz')) continue
      assertClaimedSourcePackOutput(staging, `staged copy ${entry}`)
      assertClaimedSourcePackOutput(outputOwner, `final copy ${entry}`)
      const source = join(stageOutput, entry)
      const info = lstatSync(source)
      if (!info.isFile() || info.isSymbolicLink()) fail(`source pack staged tarball is not a regular file: ${source}`)
      copyFileSync(source, join(output, entry), constants.COPYFILE_EXCL)
      assertClaimedSourcePackOutput(outputOwner, `final copy ${entry}`)
      assertClaimedSourcePackOutput(staging, `staged unlink ${entry}`)
      unlinkSync(source)
    }
    assertClaimedSourcePackOutput(staging, 'final artifact transfer')
    assertClaimedSourcePackOutput(outputOwner, 'final manifest write')
    writeFileSync(join(output, SOURCE_MANIFEST_NAME), `${JSON.stringify(finalManifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    assertClaimedSourcePackOutput(outputOwner, 'distribution validation')
    const distribution = validateSourceDistribution({ manifest: finalManifest, directory: output })
    assertClaimedSourcePackOutput(outputOwner, 'final distribution validation')
    if (!removeClaimedSourcePackOutput(staging)) fail(`source pack staging ownership changed; refusing cleanup: ${staging.path}`)
    stagingRemoved = true
    printDshProvenance(distribution)
    console.log(`DSH source distribution written to ${output}`)
    return output
  } catch (error) {
    const cleanupErrors = []
    if (outputOwner !== undefined) {
      try {
        if (!removeClaimedSourcePackOutput(outputOwner)) cleanupErrors.push(new Error(`source pack output ownership changed; refusing cleanup: ${output}`))
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (!stagingRemoved) {
      try {
        if (!removeClaimedSourcePackOutput(staging)) cleanupErrors.push(new Error(`source pack staging ownership changed; refusing cleanup: ${staging.path}`))
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], `failed to clean incomplete source pack ${output}`)
    throw error
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`DSH_SOURCE_PACK_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
