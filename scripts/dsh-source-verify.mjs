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
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
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

function directoryOwner(directory, label) {
  let info
  let parentInfo
  const parentPath = dirname(directory)
  try {
    info = lstatSync(directory)
    parentInfo = lstatSync(parentPath)
  } catch (error) {
    fail(`${label} is missing: ${directory}`)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} is not a real directory: ${directory}`)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail(`${label} parent is not a real directory: ${parentPath}`)
  return { path: directory, dev: info.dev, ino: info.ino, parentPath, parentDev: parentInfo.dev, parentIno: parentInfo.ino }
}

function parentState(owner) {
  try {
    const info = lstatSync(owner.parentPath)
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== owner.parentDev || info.ino !== owner.parentIno) return false
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function ownerState(owner) {
  try {
    const info = lstatSync(owner.path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== owner.dev || info.ino !== owner.ino) return false
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function removeOwnedDirectory(owner, hooks = undefined) {
  const state = ownerState(owner)
  if (state === undefined) return true
  if (!state) return false
  if (parentState(owner) !== true) return false
  hooks?.beforeQuarantineRename?.()
  if (parentState(owner) !== true) return false
  hooks?.afterParentValidation?.()

  // Keep the quarantine on the owner's filesystem and make it inaccessible to
  // other users. A second identity check immediately before removal prevents
  // a replacement in the quarantine from becoming a recursive-delete target.
  const quarantineRoot = join(dirname(owner.path), `.dsh-source-verify-cleanup-${process.pid}-${randomUUID()}`)
  const quarantine = join(quarantineRoot, 'claimed')
  mkdirSync(quarantineRoot, { mode: 0o700 })
  let moved = false
  let completed = false
  try {
    renameSync(owner.path, quarantine)
    moved = true
    const movedInfo = lstatSync(quarantine)
    if (!movedInfo.isDirectory() || movedInfo.isSymbolicLink() || movedInfo.dev !== owner.dev || movedInfo.ino !== owner.ino) return false
    if (parentState(owner) !== true) return false
    hooks?.afterQuarantineValidation?.(quarantine, quarantineRoot)
    if (parentState(owner) !== true) return false
    const confirmed = lstatSync(quarantine)
    if (!confirmed.isDirectory() || confirmed.isSymbolicLink() || confirmed.dev !== owner.dev || confirmed.ino !== owner.ino) return false
    rmSync(quarantine, { recursive: true, force: false })
    rmdirSync(quarantineRoot)
    completed = true
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' && !moved) return parentState(owner) === true
    return false
  } finally {
    if (!completed && !moved) {
      try {
        rmdirSync(quarantineRoot)
      } catch {
        // A failed empty-root cleanup is harmless and must not remove anything recursively.
      }
    }
  }
}

function generatedDistributionOwner(directory) {
  return directoryOwner(directory, 'generated source distribution')
}

function removeGeneratedDistribution(owner) {
  return removeOwnedDirectory(owner)
}

export function temporaryWorkspaceOwner(directory) {
  return directoryOwner(directory, 'temporary source verification workspace')
}

export function removeTemporaryWorkspace(owner, hooks = undefined) {
  return removeOwnedDirectory(owner, hooks)
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
    if (generatedDistribution) {
      await runSourcePack(values, effective)
      // Capture the generated directory before reading its manifest so cleanup
      // cannot later claim a replacement that appeared after the child exited.
      generatedOwner = generatedDistributionOwner(distributionDir)
    }
    const distribution = loadDshDistributionManifest(distributionDir, {
      packageJson: join(PACKAGE_ROOT, 'package.json'),
    })
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
      scanArchive: false,
    })
    // pack:release keeps the postpack smoke offline, but Source Mode's
    // compatibility driver must also prove the packed candidate can be
    // installed in a clean project with the local DSH tarball closure.
    const sourceFreshSmokeEnv = { ...sourcePnpmEnv, TARBALL_SMOKE_SKIP_INSTALL: '0' }
    await run(process.execPath, [
      join(workspace, 'scripts', 'tarball-smoke.mjs'),
      candidate,
      '--dsh-distribution', distributionDir,
    ], workspace, 'source tarball fresh install', sourceFreshSmokeEnv, VERIFY_TIMEOUTS.check)
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
