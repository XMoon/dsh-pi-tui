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
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_SOURCE_CONFIG,
  PACKAGE_ROOT,
  SOURCE_MANIFEST_NAME,
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

function entryExists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function pathInside(child, parent) {
  const relativePath = relative(parent, child)
  return relativePath === '' || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
}

/**
 * Validate the destination before building. The output must be new and must
 * not be placed inside either checkout, so a failed build cannot pollute the
 * source tree or the TUI workspace.
 */
export function validateSourcePackOutput(outputPath, dshDir) {
  const requested = resolve(outputPath)
  const source = realpathSync(resolve(dshDir))
  const tui = realpathSync(PACKAGE_ROOT)
  const parent = dirname(requested)
  if (!existsSync(parent)) fail(`source pack output parent is missing: ${requested}`)
  if (entryExists(requested)) fail(`source pack output already exists; remove it before packing: ${requested}`)
  const canonicalOutput = join(realpathSync(parent), basename(requested))
  if (pathInside(canonicalOutput, source)) fail(`source pack output must not be inside the DSH checkout: ${requested}`)
  if (pathInside(canonicalOutput, tui)) fail(`source pack output must not be inside the TUI checkout: ${requested}`)
  return canonicalOutput
}

function sourcePackOutputParentOwner(output) {
  const path = dirname(output)
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`source pack output parent must be a real directory: ${path}`)
  return { path, dev: info.dev, ino: info.ino }
}

function sourcePackOutputParentState(owner) {
  try {
    const info = lstatSync(owner.path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== owner.dev || info.ino !== owner.ino) return false
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Create a disposable build directory beside the final output. */
function sourcePackStaging(parent) {
  return mkdtempSync(join(parent, `.dsh-source-pack-${process.pid}-`))
}

function sourcePackStagingOwner(path) {
  const info = lstatSync(path)
  const parentPath = dirname(path)
  const parentInfo = lstatSync(parentPath)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`source pack staging must be a real directory: ${path}`)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail(`source pack staging parent must be a real directory: ${parentPath}`)
  return { path, dev: info.dev, ino: info.ino, parentPath, parentDev: parentInfo.dev, parentIno: parentInfo.ino }
}

function sourcePackStagingState(owner) {
  try {
    const parent = lstatSync(owner.parentPath)
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== owner.parentDev || parent.ino !== owner.parentIno) return false
    const info = lstatSync(owner.path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== owner.dev || info.ino !== owner.ino) return false
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Remove only the original unpublished staging inode; leave replacements untouched. */
function removeUnpublishedSourcePackStaging(owner) {
  const state = sourcePackStagingState(owner)
  if (state !== true) return
  const quarantineRoot = join(owner.parentPath, `.dsh-source-pack-cleanup-${process.pid}-${randomUUID()}`)
  const quarantine = join(quarantineRoot, 'staging')
  mkdirSync(quarantineRoot, { mode: 0o700 })
  let moved = false
  let completed = false
  try {
    renameSync(owner.path, quarantine)
    moved = true
    const movedInfo = lstatSync(quarantine)
    if (!movedInfo.isDirectory() || movedInfo.isSymbolicLink() || movedInfo.dev !== owner.dev || movedInfo.ino !== owner.ino) return
    const parentInfo = lstatSync(owner.parentPath)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.dev !== owner.parentDev || parentInfo.ino !== owner.parentIno) return
    const confirmed = lstatSync(quarantine)
    if (!confirmed.isDirectory() || confirmed.isSymbolicLink() || confirmed.dev !== owner.dev || confirmed.ino !== owner.ino) return
    rmSync(quarantine, { recursive: true, force: false })
    rmdirSync(quarantineRoot)
    completed = true
  } catch {
    // Leave the quarantine in place whenever ownership or cleanup is uncertain.
  } finally {
    if (!completed && !moved) {
      try {
        rmdirSync(quarantineRoot)
      } catch {
        // The empty quarantine root is disposable; never remove it recursively.
      }
    }
  }
}

const ALLOWED_AUXILIARY_OUTPUT = new Set(['publish-order.txt'])

function cleanPackOutput(path) {
  if (!existsSync(path)) fail(`official DSH pack output is missing: ${path}`)
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`official DSH pack output must be a directory: ${path}`)
  for (const entry of readdirSync(path)) {
    if (entry.endsWith('.tgz')) continue
    if (!ALLOWED_AUXILIARY_OUTPUT.has(entry)) fail(`official DSH pack output contains unknown entry: ${entry}`)
    const auxiliaryPath = join(path, entry)
    const auxiliaryInfo = lstatSync(auxiliaryPath)
    if (!auxiliaryInfo.isFile() || auxiliaryInfo.isSymbolicLink() || auxiliaryInfo.nlink !== 1) {
      fail(`official DSH auxiliary output must be a regular file: ${auxiliaryPath}`)
    }
    rmSync(auxiliaryPath)
  }
}

/**
 * Reserve the final name immediately before publication without clobbering a
 * new entry already present. Source-pack callers serialize cache writers; Node
 * has no portable no-replace directory rename, so an uncooperative process
 * that removes this empty reservation can still race the final rename. That is
 * outside this script's trust boundary and does not justify restoring the old
 * descriptor/inode transaction engine. The output parent is checked again
 * before reservation and before rename; an uncooperative process that swaps it
 * in the final check-to-rename window remains outside this Node-only boundary.
 */
function reserveSourcePackOutput(output) {
  try {
    mkdirSync(output)
  } catch (error) {
    if (error?.code === 'EEXIST') fail(`source pack output appeared before atomic publish: ${output}`)
    throw error
  }
  const info = lstatSync(output)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`source pack output reservation is not a real directory: ${output}`)
  return { path: output, dev: info.dev, ino: info.ino }
}

function sourcePackOutputReservationState(reservation) {
  try {
    const info = lstatSync(reservation.path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== reservation.dev || info.ino !== reservation.ino) return false
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Remove only our empty unpublished reservation; never recursively remove a final output. */
function releaseSourcePackOutputReservation(reservation) {
  if (reservation === undefined) return
  try {
    const info = lstatSync(reservation.path)
    if (info.isDirectory() && !info.isSymbolicLink() && info.dev === reservation.dev && info.ino === reservation.ino) {
      rmdirSync(reservation.path)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') return
  }
}

export function sourcePackPlatformSupported(platform = process.platform) {
  return platform !== 'win32'
}

export function officialCommandEnvironment(base = process.env) {
  return {
    ...base,
    CI: base.CI ?? 'true',
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
    pnpm_config_verify_deps_before_run: 'false',
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false',
    pnpm_config_manage_package_manager_versions: 'false',
  }
}

export function assertSourceIdentityUnchanged(before, after) {
  if (before.directory !== after.directory || before.head !== after.head || before.expectedVersion !== after.expectedVersion
    || before.dirty !== after.dirty || before.reproducible !== after.reproducible) {
    fail('DSH source identity changed during official build; refusing to publish the source pack')
  }
  return after
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

function parseCli() {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  const { values } = parseArgs({
    args,
    options: {
      'dsh-dir': { type: 'string' },
      ref: { type: 'string' },
      'expected-version': { type: 'string' },
      'allow-dirty': { type: 'boolean' },
      out: { type: 'string' },
      config: { type: 'string' },
    },
    allowPositionals: false,
  })
  return values
}

async function main() {
  if (!sourcePackPlatformSupported()) fail('DSH source pack is unsupported on Windows')
  const values = parseCli()
  const configPath = values.config ?? DEFAULT_SOURCE_CONFIG
  const tracked = loadDshSourceConfig(configPath)
  const effective = validateDshSourceConfig({
    ...tracked,
    ref: values.ref ?? tracked.ref,
    expectedVersion: values['expected-version'] ?? tracked.expectedVersion,
  })
  const dshDir = values['dsh-dir'] ?? process.env.DSH_DIR
  if (typeof dshDir !== 'string' || dshDir.trim() === '') fail('--dsh-dir is required (or set DSH_DIR)')
  const allowDirty = values['allow-dirty'] === true
  const identity = validateSourceIdentity(dshDir, effective, {
    ci: process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true',
    allowDirty,
  })
  if (identity.dirty) console.error('WARNING: DIRTY DSH SOURCE TREE (reproducible = false)')

  const output = validateSourcePackOutput(values.out ?? DEFAULT_OUTPUT, identity.directory)
  const outputParentOwner = sourcePackOutputParentOwner(output)
  const staging = sourcePackStaging(dirname(output))
  const stagingOwner = sourcePackStagingOwner(staging)
  const stageOutput = join(staging, 'output')
  let outputReservation
  let published = false
  try {
    await runOfficial(identity.directory, ['install', '--frozen-lockfile'], OFFICIAL_TIMEOUTS.install)
    await runOfficial(identity.directory, ['clean'], OFFICIAL_TIMEOUTS.clean)
    await runOfficial(identity.directory, ['build:official'], OFFICIAL_TIMEOUTS.build)
    await runOfficial(identity.directory, ['release:pack', '--family', 'dsh', '--out', stageOutput], OFFICIAL_TIMEOUTS.pack)
    const after = validateSourceIdentity(identity.directory, effective, {
      ci: process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true',
      allowDirty,
    })
    assertSourceIdentityUnchanged(identity, after)

    cleanPackOutput(stageOutput)
    const leakScanOptions = {
      sourcePaths: [identity.directory],
      tempRoots: [staging],
      distributionPaths: [stageOutput],
      scanArchive: false,
    }
    const packageEntries = packageMapFromTarballs(stageOutput, effective.expectedVersion, leakScanOptions)
    const manifest = {
      schemaVersion: 1,
      mode: 'source-pack',
      repository: effective.repository,
      sourceRef: identity.head,
      sourceSha: identity.head,
      version: effective.expectedVersion,
      dirty: identity.dirty,
      reproducible: identity.reproducible,
      packages: Object.fromEntries([...packageEntries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, entry]) => [name, entry.fileName])),
    }
    writeFileSync(join(stageOutput, SOURCE_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`)
    const distribution = validateSourceDistribution({ manifest, directory: stageOutput }, {
      allowDirty: identity.dirty,
      ...leakScanOptions,
    })

    if (sourcePackOutputParentState(outputParentOwner) !== true) {
      fail(`source pack output parent changed before atomic publish: ${outputParentOwner.path}`)
    }
    outputReservation = reserveSourcePackOutput(output)
    if (sourcePackOutputParentState(outputParentOwner) !== true
      || sourcePackOutputReservationState(outputReservation) !== true) {
      fail(`source pack output publication target changed: ${output}`)
    }
    renameSync(stageOutput, output)
    published = true
    printDshProvenance(distribution)
    console.log(`DSH source distribution written to ${output}`)
    return output
  } finally {
    if (!published) releaseSourcePackOutputReservation(outputReservation)
    removeUnpublishedSourcePackStaging(stagingOwner)
  }
}

export const _test = {
  cleanPackOutput,
  sourcePackStaging,
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`DSH_SOURCE_PACK_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
