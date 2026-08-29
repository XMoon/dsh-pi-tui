#!/usr/bin/env node
/**
 * Local Source Mode driver. It packs the pinned DSH checkout, installs the
 * complete family into a temporary TUI checkout through generated overrides,
 * runs the normal TUI validation pipeline, and removes the temporary checkout.
 *
 * Usage:
 *   pnpm compat:dsh:source -- --dsh-dir ~/src/deepseek-harness
 *   pnpm compat:dsh:source -- --dsh-dir ~/src/deepseek-harness --ref <full-sha>
 *   pnpm compat:dsh:source -- --distribution /tmp/dsh-source-pack --skip-runtime
 *
 * @module dsh-source-verify
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import {
  DEFAULT_SOURCE_CONFIG,
  PACKAGE_ROOT,
  loadDshDistributionManifest,
  loadDshSourceConfig,
  validateDshSourceConfig,
  assertNoSourceLeak,
} from './lib/dsh-distribution.mjs'
import { pnpmExecutable, runBounded } from './lib/process.mjs'
import {
  closeDirectoryHandle,
  claimProducedDirectory,
  openDirectoryHandle,
  removeEmptyClaimedDirectory,
  renameClaimedDirectory,
} from './dsh-source-pack.mjs'

const PNPM_COMMAND = pnpmExecutable()
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SOURCE_PACK_SCRIPT = fileURLToPath(new URL('./dsh-source-pack.mjs', import.meta.url))
const VERIFY_TIMEOUTS = {
  sourcePack: 50 * 60 * 1000,
  preparation: 20 * 60 * 1000,
  check: 30 * 60 * 1000,
}

function fail(message) {
  throw new Error(message)
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
      config: { type: 'string' },
      distribution: { type: 'string' },
      out: { type: 'string' },
      keep: { type: 'boolean' },
      'skip-runtime': { type: 'boolean' },
    },
    allowPositionals: false,
  })
  return values
}

/** Resolve every path-valued CLI option in the caller's working directory. */
export function resolveSourceVerifyPaths(values, cwd = process.cwd()) {
  const resolveOptional = value => value === undefined ? undefined : resolve(cwd, value)
  return {
    ...values,
    config: resolve(cwd, values.config ?? DEFAULT_SOURCE_CONFIG),
    'dsh-dir': resolveOptional(values['dsh-dir']),
    distribution: resolveOptional(values.distribution),
    out: resolveOptional(values.out),
  }
}

async function run(command, args, cwd, label, extraEnv = {}, timeoutMs = VERIFY_TIMEOUTS.check) {
  console.log(`DSH source verify: ${label}`)
  const result = await runBounded(command, args, {
    cwd,
    env: { ...process.env, npm_config_minimum_release_age: '0', pnpm_config_minimum_release_age: '0', ...extraEnv },
    timeoutMs,
    label,
  })
  if (result.status !== 0 || result.timedOut) {
    fail(`${label} failed${result.error ? `: ${result.error.message}` : ` with exit ${result.status ?? 'unknown'}`}`)
  }
}

function copyRepository(destination) {
  const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage', 'temp', '.pnpm-store', '.pnpm-data', '.pnpm-cache'])
  cpSync(PACKAGE_ROOT, destination, {
    recursive: true,
    filter(source) {
      const relative = source.slice(PACKAGE_ROOT.length + 1)
      if (relative === '') return true
      const segments = relative.split(/[\\/]/u)
      return !segments.some(segment => ignored.has(segment)) && !/^xmoon76-dsh-pi-tui-.*\.tgz$/u.test(basename(source))
    },
  })
}

function attachGitMetadata(workspace) {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
    }).trim()
    if (gitDir !== '') writeFileSync(join(workspace, '.git'), `gitdir: ${gitDir}\n`, 'utf8')
  } catch {
    // A source checkout without Git metadata can still run the other gates.
  }
}

export function candidateTarball(workspace) {
  const candidates = readdirSync(workspace)
    .filter(name => /^xmoon76-dsh-pi-tui-.*\.tgz$/u.test(name))
    .map(name => join(workspace, name))
    .filter(path => {
      const info = lstatSync(path)
      return info.isFile() && !info.isSymbolicLink() && info.nlink === 1
    })
  if (candidates.length !== 1) fail(`expected one TUI candidate tarball, found ${candidates.length}`)
  return candidates[0]
}

function sourcePackOutput(values) {
  return resolve(values.out ?? join(tmpdir(), `dsh-source-pack-${process.pid}`))
}

function directoryAncestors(path) {
  const ancestors = []
  let current = path
  while (true) {
    const info = lstatSync(current)
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`source distribution ancestor must be a real directory: ${current}`)
    ancestors.push({ path: current, dev: info.dev, ino: info.ino })
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return ancestors
}

/** Require the inode proof emitted by the source pack before cleanup. */
function generatedDistributionOwner(directory, manifest) {
  const identity = manifest?.outputIdentity
  if (typeof identity?.dev !== 'string' || typeof identity.ino !== 'string') {
    fail(`generated source distribution has no output ownership proof: ${directory}`)
  }
  const parentPath = dirname(directory)
  const ancestors = directoryAncestors(parentPath)
  const parent = lstatSync(parentPath)
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== identity.dev || String(info.ino) !== identity.ino) {
    fail(`generated source distribution ownership changed: ${directory}`)
  }
  return { path: directory, parentPath, ancestors, parentDev: parent.dev, parentIno: parent.ino, dev: info.dev, ino: info.ino }
}

function generatedOwnerState(owner) {
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

/** Quarantine and remove a generated distribution only while its proved inode is intact. */
function removeGeneratedDistribution(owner) {
  if (process.platform === 'win32') return false
  const state = generatedOwnerState(owner)
  if (state === undefined) return true
  if (!state) return false
  // Quarantine in a private directory so a raced source path can never turn
  // the caller-controlled parent into the recursive-delete target. The shared
  // helper binds both parent directories through held descriptors.
  const quarantineRoot = mkdtempSync(join(tmpdir(), `dsh-source-verify-cleanup-${process.pid}-`))
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

/** Claim the private verifier workspace so cleanup cannot remove a replacement. */
export function temporaryWorkspaceOwner(directory) {
  const parentPath = dirname(directory)
  const ancestors = directoryAncestors(parentPath)
  const parent = lstatSync(parentPath)
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`temporary source verification workspace is not a real directory: ${directory}`)
  return { path: directory, parentPath, ancestors, parentDev: parent.dev, parentIno: parent.ino, dev: info.dev, ino: info.ino }
}

function temporaryWorkspaceState(owner) {
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

export function removeTemporaryWorkspace(owner) {
  if (process.platform === 'win32') return false
  const state = temporaryWorkspaceState(owner)
  if (state === undefined) return true
  if (!state) return false
  const quarantineRoot = mkdtempSync(join(tmpdir(), `dsh-source-verify-workspace-${process.pid}-`))
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

async function runSourcePack(values, config) {
  const output = sourcePackOutput(values)
  const args = [SOURCE_PACK_SCRIPT, '--dsh-dir', values['dsh-dir']]
  if (values.ref !== undefined) args.push('--ref', values.ref)
  if (values['expected-version'] !== undefined) args.push('--expected-version', values['expected-version'])
  args.push('--config', config.path, '--out', output)
  await run(process.execPath, args, PACKAGE_ROOT, 'official DSH source pack', {}, VERIFY_TIMEOUTS.sourcePack)
  return output
}

async function main() {
  const values = resolveSourceVerifyPaths(parseCli())
  const configPath = values.config
  const tracked = loadDshSourceConfig(configPath)
  const effective = validateDshSourceConfig({
    ...tracked,
    ref: values.ref ?? tracked.ref,
    expectedVersion: values['expected-version'] ?? tracked.expectedVersion,
  }, tracked.path)
  if (values.distribution === undefined && (typeof values['dsh-dir'] !== 'string' || values['dsh-dir'].trim() === '')) {
    fail('--dsh-dir is required when --distribution is not provided')
  }

  const generatedDistribution = values.distribution === undefined
  const distributionDir = generatedDistribution ? sourcePackOutput(values) : resolve(values.distribution)
  const distributionExisted = existsSync(distributionDir)
  const sourcePnpmEnv = {
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false',
    TARBALL_SMOKE_SKIP_INSTALL: '1',
  }
  let root
  let rootOwner
  let generatedOwner
  try {
    if (generatedDistribution) await runSourcePack(values, effective)
    const distribution = loadDshDistributionManifest(distributionDir, {
      packageJson: join(PACKAGE_ROOT, 'package.json'),
    })
    if (generatedDistribution) generatedOwner = generatedDistributionOwner(distributionDir, distribution.manifest)
    if (distribution.repository !== effective.repository || distribution.sourceSha !== effective.ref || distribution.version !== effective.expectedVersion) {
      fail('packed DSH distribution does not match the effective source pin')
    }

    root = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-source-'))
    rootOwner = temporaryWorkspaceOwner(root)
    const workspace = join(root, 'workspace')
    copyRepository(workspace)
    attachGitMetadata(workspace)
    await run(process.execPath, [
      join(workspace, 'scripts', 'prepare-dsh-test-environment.mjs'),
      '--mode', 'source',
      '--distribution', distributionDir,
      '--workspace', workspace,
      '--config', configPath,
      '--ref', effective.ref,
      '--expected-version', effective.expectedVersion,
    ], PACKAGE_ROOT, 'source dependency preparation', sourcePnpmEnv, VERIFY_TIMEOUTS.preparation)
    for (const [label, args] of [
      ['vendored pi-tui typecheck', ['typecheck:fork']],
      ['vendored pi-tui tests', ['test:fork']],
      ['TUI build', ['build']],
      ['TUI bundle typecheck', ['typecheck:bundle']],
      ['TUI unit tests', ['test:bundle']],
      ['documentation tests', ['test:docs']],
      ['Pi surface compatibility gate', ['gate:pi-surface-compat']],
      ['TUI candidate build and pack', ['pack:release']],
    ]) await run(PNPM_COMMAND, args, workspace, label, sourcePnpmEnv)

    const candidate = candidateTarball(workspace)
    assertNoSourceLeak(candidate, {
      sourcePaths: values['dsh-dir'] === undefined ? [] : [resolve(values['dsh-dir'])],
      distributionPaths: [distributionDir],
    })
    if (values['skip-runtime'] !== true) {
      await run(process.execPath, [
        join(workspace, 'scripts', 'official-presets-smoke.mjs'),
        candidate,
        '--distribution', distributionDir,
        '--config', configPath,
        '--ref', effective.ref,
        '--expected-version', effective.expectedVersion,
      ], workspace, 'official DSH preset matrix', sourcePnpmEnv)
      await run(process.execPath, [join(workspace, 'scripts', 'dsh-runtime-boundary-smoke.mjs'), candidate], workspace, 'old DSH boundary', sourcePnpmEnv)
    }
    console.log('SKIPPED: requires published compatible DSH/pi2dsh combination (source mode)')
    console.log(`DSH Source Compatibility: CODE COMPLETE candidate ${basename(candidate)}`)
  } finally {
    if (root !== undefined) {
      if (values.keep === true || process.env.DSH_SOURCE_KEEP === '1') {
        console.error(`preserved source verification workspace: ${root}`)
      } else if (rootOwner === undefined) {
        console.error(`preserved source verification workspace without ownership proof: ${root}`)
      } else if (!removeTemporaryWorkspace(rootOwner)) {
        console.error(`preserved source verification workspace after ownership changed: ${root}`)
      }
    }
    if (generatedDistribution && !distributionExisted && values.keep !== true && process.env.DSH_SOURCE_KEEP !== '1') {
      if (generatedOwner === undefined) {
        if (existsSync(distributionDir)) console.error(`preserved source distribution without ownership proof: ${distributionDir}`)
      } else if (!removeGeneratedDistribution(generatedOwner)) {
        console.error(`preserved source distribution after ownership changed: ${distributionDir}`)
      }
    } else if (generatedDistribution) {
      console.error(`preserved source distribution: ${distributionDir}`)
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch(error => {
    console.error(`DSH_SOURCE_VERIFY_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
