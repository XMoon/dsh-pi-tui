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
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeSync,
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

const ALLOWED_AUXILIARY_OUTPUT = new Set(['publish-order.txt'])

/** Remove the official packer's disposable metadata, rejecting unknown files. */
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

/** Create a disposable build directory beside the final output. */
function sourcePackStaging(parent) {
  return mkdtempSync(join(parent, `.dsh-source-pack-${process.pid}-`))
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

function preciseBirthtime(pathOrFd, descriptor = false) {
  const info = descriptor
    ? fstatSync(pathOrFd, { bigint: true })
    : lstatSync(pathOrFd, { bigint: true })
  return String(info.birthtimeNs ?? info.birthtimeMs)
}

function sameNode(info, expected, birthtime) {
  return info.dev === expected.dev
    && info.ino === expected.ino
    && (expected.birthtime === undefined || birthtime === expected.birthtime)
}

/** Record every existing canonical directory ancestor from the deepest anchor. */
function directoryAncestors(anchor) {
  const ancestors = []
  let current = anchor
  while (true) {
    const info = lstatSync(current)
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`source pack output ancestor must be a real directory: ${current}`)
    ancestors.push({ path: current, dev: info.dev, ino: info.ino, birthtime: preciseBirthtime(current) })
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
  let requestedInfo
  try {
    // lstatSync observes dangling symlinks; existsSync alone incorrectly
    // treats them as absent and would allow an unsafe output claim.
    requestedInfo = lstatSync(requested)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (requestedInfo?.isSymbolicLink()) fail(`source pack output already exists and must not be a symlink: ${requested}`)
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
    const info = lstatSync(join(canonicalOutput, entry))
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1
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
    if (!info.isDirectory() || info.isSymbolicLink() || !sameNode(info, ancestor, preciseBirthtime(ancestor.path))) {
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
  return {
    path: output,
    parentPath,
    ancestors,
    parentDev: parent.dev,
    parentIno: parent.ino,
    parentBirthtime: preciseBirthtime(parentPath),
    dev: info.dev,
    ino: info.ino,
    birthtime: preciseBirthtime(output),
  }
}

/** Create a private root that the official packer can freely replace below. */
export function claimSourcePackStaging() {
  const path = mkdtempSync(join(tmpdir(), `dsh-source-pack-stage-${process.pid}-`))
  const parentPath = dirname(path)
  const ancestors = directoryAncestors(parentPath)
  const parent = lstatSync(parentPath)
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`source pack staging root is not a real directory: ${path}`)
  return {
    path,
    parentPath,
    ancestors,
    parentDev: parent.dev,
    parentIno: parent.ino,
    parentBirthtime: preciseBirthtime(parentPath),
    dev: info.dev,
    ino: info.ino,
    birthtime: preciseBirthtime(path),
  }
}

function ownerState(owner) {
  try {
    for (const ancestor of owner.ancestors) {
      const info = lstatSync(ancestor.path)
      if (!info.isDirectory() || info.isSymbolicLink() || !sameNode(info, ancestor, preciseBirthtime(ancestor.path))) return false
    }
    const info = lstatSync(owner.path)
    if (!info.isDirectory() || info.isSymbolicLink() || !sameNode(info, owner, preciseBirthtime(owner.path))) return false
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Claim an output directory already created by the official packer. */
export function claimProducedDirectory(path) {
  const parentPath = dirname(path)
  const ancestors = directoryAncestors(parentPath)
  const parent = lstatSync(parentPath)
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`source pack produced an invalid output directory: ${path}`)
  return {
    path,
    parentPath,
    ancestors,
    parentDev: parent.dev,
    parentIno: parent.ino,
    parentBirthtime: preciseBirthtime(parentPath),
    dev: info.dev,
    ino: info.ino,
    birthtime: preciseBirthtime(path),
  }
}

/** Open a directory through a stable descriptor where the platform exposes one. */
export function openDirectoryHandle(path) {
  if (process.platform === 'win32') return { fd: undefined, path }
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
  const fd = openSync(path, flags)
  const descriptorPath = process.platform === 'linux' ? join('/proc/self/fd', String(fd)) : join('/dev/fd', String(fd))
  return { fd, path: descriptorPath }
}

export function closeDirectoryHandle(handle) {
  if (handle?.fd !== undefined) {
    closeSync(handle.fd)
    handle.fd = undefined
  }
}

/** Move a proved directory through held parent descriptors, never a raced path. */
// The optional hook exists only for deterministic race regression tests.
export function renameClaimedDirectory(owner, destinationOwner, destinationName = 'claimed', hooks = undefined) {
  if (process.platform === 'win32') return false
  const sourceParent = openDirectoryHandle(owner.parentPath)
  const destinationParent = openDirectoryHandle(destinationOwner.path)
  try {
    if (sourceParent.fd === undefined || destinationParent.fd === undefined) return false
    const parent = fstatSync(sourceParent.fd)
    if (parent.dev !== owner.parentDev || parent.ino !== owner.parentIno
      || (owner.parentBirthtime !== undefined && preciseBirthtime(sourceParent.fd, true) !== owner.parentBirthtime)) return false
    if (ownerState(owner) !== true || ownerState(destinationOwner) !== true) return false
    hooks?.beforeRename?.()
    const currentParent = fstatSync(sourceParent.fd)
    if (currentParent.dev !== owner.parentDev || currentParent.ino !== owner.parentIno
      || (owner.parentBirthtime !== undefined && preciseBirthtime(sourceParent.fd, true) !== owner.parentBirthtime)) return false
    if (ownerState(owner) !== true || ownerState(destinationOwner) !== true) return false
    renameSync(
      join(sourceParent.path, basename(owner.path)),
      join(destinationParent.path, destinationName),
    )
    return true
  } finally {
    closeDirectoryHandle(sourceParent)
    closeDirectoryHandle(destinationParent)
  }
}

/** Remove an empty proved directory through its held parent descriptor. */
export function removeEmptyClaimedDirectory(owner) {
  if (process.platform === 'win32') return false
  if (ownerState(owner) !== true) return false
  const parentHandle = openDirectoryHandle(owner.parentPath)
  try {
    if (parentHandle.fd === undefined) return false
    const parent = fstatSync(parentHandle.fd)
    if (parent.dev !== owner.parentDev || parent.ino !== owner.parentIno
      || (owner.parentBirthtime !== undefined && preciseBirthtime(parentHandle.fd, true) !== owner.parentBirthtime)
      || ownerState(owner) !== true) return false
    try {
      rmdirSync(join(parentHandle.path, basename(owner.path)))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return ownerState(owner) === undefined
  } finally {
    closeDirectoryHandle(parentHandle)
  }
}

function writeAll(fd, buffer) {
  let offset = 0
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset)
    if (written <= 0) fail('source pack file write made no progress')
    offset += written
  }
}

function exactlyOneLink(info) {
  return info.nlink === 1 || info.nlink === 1n
}

function expectedBirthtime(expected) {
  if (typeof expected.birthtime === 'string') return expected.birthtime
  if (expected.birthtimeNs !== undefined) return String(expected.birthtimeNs)
  return undefined
}

function matchesExpectedFile(info, expected, birthtime) {
  const expectedTime = expectedBirthtime(expected)
  return String(info.dev) === String(expected.dev)
    && String(info.ino) === String(expected.ino)
    && exactlyOneLink(info)
    && (expectedTime === undefined || birthtime === expectedTime)
}

/** Copy a regular source file through an opened source descriptor. */
export function copyOwnedFile(source, destination, expected) {
  const sourceFd = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let destinationFd
  try {
    const opened = fstatSync(sourceFd)
    if (!opened.isFile() || opened.isSymbolicLink() || !matchesExpectedFile(opened, expected, preciseBirthtime(sourceFd, true))) {
      fail(`source pack staged file changed or is hardlinked before copy: ${source}`)
    }
    destinationFd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644)
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytes
    do {
      bytes = readSync(sourceFd, buffer, 0, buffer.length, null)
      if (bytes > 0) writeAll(destinationFd, buffer.subarray(0, bytes))
    } while (bytes > 0)
    const after = fstatSync(sourceFd)
    if (!matchesExpectedFile(after, expected, preciseBirthtime(sourceFd, true)) || after.size !== opened.size) {
      fail(`source pack staged file changed or is hardlinked during copy: ${source}`)
    }
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd)
    closeSync(sourceFd)
  }
}

function writeExclusiveFile(path, content) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644)
  try {
    writeAll(fd, Buffer.from(content, 'utf8'))
  } finally {
    closeSync(fd)
  }
}

/** Verify that the process still owns the claimed output and every ancestor. */
export function assertClaimedSourcePackOutput(owner, action) {
  const state = ownerState(owner)
  if (state === undefined) fail(`source pack output disappeared during ${action}: ${owner.path}`)
  if (!state) fail(`source pack output ownership changed during ${action}: ${owner.path}`)
}

function assertStageOwnership(staging, stageOutput, action) {
  assertClaimedSourcePackOutput(staging, action)
  if (stageOutput !== undefined) assertClaimedSourcePackOutput(stageOutput, action)
}

/** Quarantine and remove only the directory inode this process claimed. */
export function removeClaimedSourcePackOutput(owner) {
  if (process.platform === 'win32') return false
  const state = ownerState(owner)
  if (state === undefined) return true
  if (!state) return false
  // The private quarantine prevents a raced destination path from becoming a
  // recursive-delete target. The held parent descriptor also prevents an
  // ancestor replacement from redirecting the rename.
  const quarantineRoot = mkdtempSync(join(tmpdir(), `dsh-source-pack-cleanup-${process.pid}-`))
  const quarantineOwner = claimProducedDirectory(quarantineRoot)
  if (!renameClaimedDirectory(owner, quarantineOwner)) return false
  const quarantineHandle = openDirectoryHandle(quarantineRoot)
  try {
    const quarantine = join(quarantineHandle.path, 'claimed')
    const moved = lstatSync(quarantine)
    if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== owner.dev || moved.ino !== owner.ino) return false
    rmSync(quarantine, { recursive: true, force: true })
  } finally {
    closeDirectoryHandle(quarantineHandle)
  }
  return removeEmptyClaimedDirectory(quarantineOwner)
}

export function sourcePackPlatformSupported(platform = process.platform) {
  return platform !== 'win32'
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

/** Ensure the official build did not alter the pinned source identity. */
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

async function main() {
  if (!sourcePackPlatformSupported()) fail('DSH source pack requires POSIX directory descriptors and is unsupported on Windows')
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
  const allowDirty = values['allow-dirty'] === true
  const identity = validateSourceIdentity(dshDir, effective, {
    ci: process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true',
    allowDirty,
  })
  if (identity.dirty) console.error('WARNING: DIRTY DSH SOURCE TREE (reproducible = false)')

  const validation = validateSourcePackOutputInfo(values.out ?? DEFAULT_OUTPUT, identity.directory)
  const output = validation.path
  const staging = claimSourcePackStaging()
  let stageOutputOwner
  let stageHandle
  let outputOwner
  let outputHandle
  let stagingRemoved = false
  try {
    const stageOutput = join(staging.path, 'output')
    assertStageOwnership(staging, undefined, 'initialization')
    await runOfficial(identity.directory, ['install', '--frozen-lockfile'], OFFICIAL_TIMEOUTS.install)
    // Local source checkouts can retain ignored tsbuildinfo/lib state from an
    // earlier build. Clean only generated repository-owned outputs so the same
    // official build is reproducible without requiring a pristine local tree.
    await runOfficial(identity.directory, ['clean'], OFFICIAL_TIMEOUTS.clean)
    await runOfficial(identity.directory, ['build:official'], OFFICIAL_TIMEOUTS.build)
    await runOfficial(identity.directory, ['release:pack', '--family', 'dsh', '--out', stageOutput], OFFICIAL_TIMEOUTS.pack)
    const afterIdentity = validateSourceIdentity(identity.directory, effective, {
      ci: process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true',
      allowDirty: values['allow-dirty'] === true,
    })
    assertSourceIdentityUnchanged(identity, afterIdentity)
    assertClaimedSourcePackOutput(staging, 'official release pack')
    stageOutputOwner = claimProducedDirectory(stageOutput)
    assertStageOwnership(staging, stageOutputOwner, 'official release pack')
    stageHandle = openDirectoryHandle(stageOutput)
    assertStageOwnership(staging, stageOutputOwner, 'opening packed output')

    // The official packer writes publish-order.txt for registry publishing. Source
    // mode only needs immutable tarballs plus its generated distribution manifest;
    // discard the known auxiliary output and reject anything unexpected.
    const packedEntries = readdirSync(stageHandle.path)
    assertStageOwnership(staging, stageOutputOwner, 'listing packed output')
    for (const entry of packedEntries) {
      if (entry.endsWith('.tgz')) continue
      if (!ALLOWED_AUXILIARY_OUTPUT.has(entry)) fail(`official DSH pack output contains unknown entry: ${entry}`)
      assertStageOwnership(staging, stageOutputOwner, `filtering ${entry}`)
      const path = join(stageHandle.path, entry)
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail(`source pack produced a non-regular or hardlinked disposable entry: ${path}`)
      unlinkSync(path)
      assertStageOwnership(staging, stageOutputOwner, `filtered ${entry}`)
    }
    assertStageOwnership(staging, stageOutputOwner, 'post-pack filtering')

    const leakScanOptions = {
      sourcePaths: [identity.directory],
      tempRoots: [staging.path],
      distributionPaths: [stageOutput],
      scanArchive: false,
    }
    const packageEntries = packageMapFromTarballs(stageOutput, effective.expectedVersion, leakScanOptions)
    assertStageOwnership(staging, stageOutputOwner, 'package map validation')
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
    const stageManifest = manifestFor(stageOutputOwner)
    assertStageOwnership(staging, stageOutputOwner, 'staged manifest write')
    writeExclusiveFile(join(stageHandle.path, SOURCE_MANIFEST_NAME), `${JSON.stringify(stageManifest, null, 2)}\n`)
    assertStageOwnership(staging, stageOutputOwner, 'staged distribution validation')
    validateSourceDistribution({ manifest: stageManifest, directory: stageOutput }, {
      allowDirty,
      ...leakScanOptions,
    })
    assertStageOwnership(staging, stageOutputOwner, 'staged final validation')

    // Reserve the caller's final path only after the complete source pack is
    // validated. mkdir is exclusive, so an output that appeared meanwhile is
    // never replaced; all packer-owned work remains in the private staging root.
    outputOwner = claimSourcePackOutput(output, validation)
    outputHandle = openDirectoryHandle(output)
    assertClaimedSourcePackOutput(outputOwner, 'opening final output')
    const finalManifest = manifestFor(outputOwner)
    for (const entry of packedEntries) {
      if (!entry.endsWith('.tgz')) continue
      assertStageOwnership(staging, stageOutputOwner, `staged copy ${entry}`)
      assertClaimedSourcePackOutput(outputOwner, `final copy ${entry}`)
      const source = join(stageHandle.path, entry)
      const info = lstatSync(source)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail(`source pack staged tarball is not a regular file with exactly one link: ${source}`)
      const expected = lstatSync(source, { bigint: true })
      copyOwnedFile(source, join(outputHandle.path, entry), expected)
      assertClaimedSourcePackOutput(outputOwner, `final copy ${entry}`)
      assertStageOwnership(staging, stageOutputOwner, `staged unlink ${entry}`)
      unlinkSync(source)
      assertStageOwnership(staging, stageOutputOwner, `staged unlinked ${entry}`)
    }
    assertStageOwnership(staging, stageOutputOwner, 'final artifact transfer')
    assertClaimedSourcePackOutput(outputOwner, 'final manifest write')
    writeExclusiveFile(join(outputHandle.path, SOURCE_MANIFEST_NAME), `${JSON.stringify(finalManifest, null, 2)}\n`)
    assertClaimedSourcePackOutput(outputOwner, 'distribution validation')
    const distribution = validateSourceDistribution({ manifest: finalManifest, directory: output }, {
      allowDirty,
      sourcePaths: [identity.directory],
      tempRoots: [staging.path],
      distributionPaths: [output],
    })
    assertClaimedSourcePackOutput(outputOwner, 'final distribution validation')
    closeDirectoryHandle(outputHandle)
    outputHandle = undefined
    closeDirectoryHandle(stageHandle)
    stageHandle = undefined
    if (!removeClaimedSourcePackOutput(staging)) fail(`source pack staging ownership changed; refusing cleanup: ${staging.path}`)
    stagingRemoved = true
    printDshProvenance(distribution)
    console.log(`DSH source distribution written to ${output}`)
    return output
  } catch (error) {
    const cleanupErrors = []
    try {
      closeDirectoryHandle(outputHandle)
      outputHandle = undefined
      closeDirectoryHandle(stageHandle)
      stageHandle = undefined
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
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
