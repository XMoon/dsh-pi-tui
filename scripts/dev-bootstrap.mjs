#!/usr/bin/env node
/**
 * Materialize the DSH distribution selected by the current development
 * context. npm mode uses the tracked frozen lockfile; source mode reuses or
 * builds an exact-SHA source pack outside the worktree and then materializes
 * it through the repository's existing distribution helper.
 *
 * @module dev-bootstrap
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, basename, isAbsolute, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  DEV_ENV_FILE,
  DEV_STATE_FILE,
  hashFile,
  resolveDshDevContext,
  sourceEnvironment,
} from './dsh-dev-context.mjs'
import { inspectNpmResolution } from './dev-doctor.mjs'
import { DSH_ROOT_PACKAGE, expectedDshRepositoryRemote, normalizeDshRepositoryRemote } from './lib/dsh-distribution.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SOURCE_PACK_SCRIPT = 'scripts/dsh-source-pack.mjs'
const SOURCE_PREPARE_SCRIPT = 'scripts/prepare-dsh-test-environment.mjs'
const SOURCE_HELPER = 'scripts/lib/dsh-distribution.mjs'
// Ephemeral source-pack generation identity: the root basename prefix and
// the owner marker that together prove a superseded generation belongs to
// THIS worktree before it is reclaimed (Phase F of the tmp hygiene plan).
const EPHEMERAL_ROOT_PREFIX = 'dsh-pi-tui-source-'
const EPHEMERAL_MARKER_NAME = '.dsh-pi-tui-ephemeral.json'
const EPHEMERAL_MARKER_KIND = 'dsh-pi-tui-source-pack'
const LOCK_WAIT_MS = 15 * 60 * 1000
const LOCK_STALE_MS = 10 * 60 * 1000
const TIMEOUTS = {
  git: 20 * 60 * 1000,
  install: 20 * 60 * 1000,
  sourcePack: 60 * 60 * 1000,
}

function fail(message) {
  const error = new Error(message)
  error.name = 'DshDevBootstrapError'
  throw error
}

function commandText(result) {
  return [result?.stdout, result?.stderr, result?.error?.message]
    .filter(value => typeof value === 'string' && value.trim() !== '')
    .join('\n')
    .trim()
}

function configuredPnpm() {
  if (typeof process.env.PNPM_EXECUTABLE === 'string' && process.env.PNPM_EXECUTABLE !== '') return process.env.PNPM_EXECUTABLE
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pnpm'], { encoding: 'utf8' })
  return (lookup.stdout ?? '').split(/\r?\n/u).find(line => line.trim() !== '')?.trim() ?? 'pnpm'
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0 || result.error !== undefined) {
    fail(`${options.label ?? command} failed${commandText(result) ? `:\n${commandText(result)}` : ''}`)
  }
  return (result.stdout ?? '').trim()
}

function killChild(child, signal = 'SIGTERM') {
  if (child.pid === undefined) return
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, signal) } catch { /* child may already be gone */ }
  }
  try { child.kill(signal) } catch { /* child may already be gone */ }
}

function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000
  const label = options.label ?? `${command} ${args.join(' ')}`
  console.log(`DSH dev: ${label}`)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    let settled = false
    let timedOut = false
    let hardKillTimer
    const timeout = setTimeout(() => {
      if (settled) return
      timedOut = true
      killChild(child, 'SIGTERM')
      hardKillTimer = setTimeout(() => {
        if (settled) return
        killChild(child, 'SIGKILL')
        const error = new Error(`${label} timed out after ${timeoutMs}ms`)
        error.code = 'ETIMEDOUT'
        settle(undefined, error)
      }, 1_000)
    }, timeoutMs)
    const settle = (result, error = undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (hardKillTimer !== undefined) clearTimeout(hardKillTimer)
      if (error !== undefined) reject(error)
      else resolvePromise(result)
    }
    child.once('error', error => {
      if (timedOut) return
      settle(undefined, error)
    })
    child.once('exit', (status, signal) => {
      // A direct child may exit after SIGTERM while descendants in its process
      // group are still mutating the checkout. Keep the lock until the hard
      // kill grace period completes.
      if (timedOut) return
      if (status === 0) {
        settle({ status, signal })
        return
      }
      const error = new Error(`${label} failed with exit ${status ?? 'unknown'}${signal ? ` (${signal})` : ''}`)
      error.code = status === null ? 'ETIMEDOUT' : 'DSH_DEV_COMMAND_FAILED'
      settle(undefined, error)
    })
  })
}

function currentPnpmVersion(command, root = undefined) {
  return runCapture(command, ['--version'], {
    env: commandEnvironment('npm', { root }),
    label: 'read pnpm version',
  })
}

function commandEnvironment(mode, { strictSourceIdentity = false, baseEnvironment = process.env, root = undefined } = {}) {
  const base = {
    ...baseEnvironment,
    ...(root === undefined ? {} : { DSH_DEV_ROOT: resolve(root) }),
    DSH_DEV_MODE: mode === 'source' ? 'source' : 'npm',
    npm_config_minimum_release_age: '0',
    pnpm_config_minimum_release_age: '0',
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false',
  }
  if (mode !== 'source') {
    delete base.DSH_MODE
    delete base.DSH_SOURCE_CONFIG
    delete base.DSH_SOURCE_DISTRIBUTION
    delete base.DSH_DEV_EPHEMERAL
    delete base.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN
    delete base.pnpm_config_verify_deps_before_run
    delete base.TARBALL_SMOKE_SKIP_INSTALL
    return base
  }
  const environment = sourceEnvironment(base)
  if (strictSourceIdentity) environment.CI = 'true'
  return environment
}

function assertRealDirectory(path, label) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
    return
  }
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be an independent real directory: ${path}`)
}

function assertIndependentNodeModules(root) {
  const path = join(root, 'node_modules')
  if (!existsSync(path)) return false
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`node_modules must be an independent real directory: ${path}`)
  return true
}

async function distributionHelper(context) {
  const path = join(context.root, SOURCE_HELPER)
  if (!existsSync(path)) fail(`source mode requires ${SOURCE_HELPER}; this workspace has no source distribution helper`)
  try {
    return await import(pathToFileURL(path).href)
  } catch (error) {
    fail(`could not load ${SOURCE_HELPER}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readState(context) {
  if (!existsSync(context.statePath)) return undefined
  try {
    const info = lstatSync(context.statePath)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return undefined
    const value = JSON.parse(readFileSync(context.statePath, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function stateCoreMatches(context, state, pnpm, distributionPath = undefined) {
  if (state === undefined || state.schemaVersion !== 1 || state.mode !== context.mode) return false
  if (context.mode === 'source' && state.ephemeral === true) {
    // An ephemeral state only matches when it references the exact
    // distribution this run is about to use: a stale ephemeral generation
    // must never be treated as the current one, and a run that is about to
    // switch to the canonical cache must not skip its materialization. A
    // malformed distribution field (old version, partial write, manual
    // edit) is a cache miss, never an exception.
    if (typeof state.distribution !== 'string' || !isAbsolute(state.distribution)
      || distributionPath === undefined || resolve(state.distribution) !== resolve(distributionPath)) {
      return false
    }
  }
  const required = ['node', 'pnpm', 'root', 'packageJsonHash', 'lockfileHash']
  if (required.some(field => !Object.hasOwn(state, field))) return false
  if (typeof state.node !== 'string' || typeof state.pnpm !== 'string' || typeof state.root !== 'string'
    || typeof state.packageJsonHash !== 'string' || !/^[0-9a-f]{64}$/u.test(state.packageJsonHash)
    || typeof state.lockfileHash !== 'string' || !/^[0-9a-f]{64}$/u.test(state.lockfileHash)) return false
  if (resolve(state.root) !== context.root) return false
  if (state.node !== String(process.versions.node.split('.')[0])) return false
  if (state.pnpm !== pnpm) return false
  if (state.packageJsonHash !== hashFile(context.packageJsonPath)) return false
  if (state.lockfileHash !== hashFile(join(context.root, 'pnpm-lock.yaml'))) return false
  if (context.mode === 'source') {
    return Object.hasOwn(state, 'repository')
      && Object.hasOwn(state, 'ref')
      && Object.hasOwn(state, 'expectedVersion')
      && Object.hasOwn(state, 'distribution')
      && typeof state.repository === 'string'
      && typeof state.ref === 'string'
      && typeof state.expectedVersion === 'string'
      && typeof state.distribution === 'string'
      && isAbsolute(state.distribution)
      && state.repository === context.source.repository
      && state.ref === context.source.ref
      && state.expectedVersion === context.source.expectedVersion
  }
  return true
}

function writeAtomic(path, content, mode = 0o600) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail(`refusing to replace symlink: ${path}`)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

function writeState(context, pnpm, distributionPath = undefined, { ephemeral = false } = {}) {
  const packageJsonHash = hashFile(context.packageJsonPath)
  const lockfileHash = hashFile(join(context.root, 'pnpm-lock.yaml'))
  if (packageJsonHash === undefined || lockfileHash === undefined) {
    fail('cannot write local state without package.json and pnpm-lock.yaml')
  }
  const payload = {
    schemaVersion: 1,
    mode: context.mode,
    node: String(process.versions.node.split('.')[0]),
    pnpm,
    root: context.root,
    packageJsonHash,
    lockfileHash,
  }
  if (context.mode === 'source') {
    Object.assign(payload, {
      repository: context.source.repository,
      ref: context.source.ref,
      expectedVersion: context.source.expectedVersion,
      distribution: resolve(distributionPath),
      ephemeral,
    })
  }
  writeAtomic(context.statePath, `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function developmentEnvironmentContent(context, distributionPath = undefined, { ephemeral = false } = {}) {
  const lines = [
    '# Generated by pnpm dev:bootstrap; do not commit.',
    `export DSH_DEV_ROOT=${shellQuote(context.root)}`,
    `export DSH_DEV_MODE=${shellQuote(context.mode)}`,
    'export PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS=\'false\'',
  ]
  if (context.mode === 'source') {
    lines.push(
      'export PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=\'false\'',
      'export pnpm_config_verify_deps_before_run=\'false\'',
    )
    lines.push(`export DSH_SOURCE_CONFIG=${shellQuote(context.sourceConfigPath)}`)
    lines.push(`export DSH_SOURCE_DISTRIBUTION=${shellQuote(resolve(distributionPath))}`)
    lines.push(`export DSH_DEV_EPHEMERAL=${shellQuote(ephemeral ? '1' : '0')}`)
    lines.push("export TARBALL_SMOKE_SKIP_INSTALL='1'")
  } else {
    lines.push('unset PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN')
    lines.push('unset pnpm_config_verify_deps_before_run')
    lines.push('unset DSH_MODE')
    lines.push('unset DSH_SOURCE_CONFIG')
    lines.push('unset DSH_SOURCE_DISTRIBUTION')
    lines.push('unset DSH_DEV_EPHEMERAL')
    lines.push('unset TARBALL_SMOKE_SKIP_INSTALL')
  }
  return `${lines.join('\n')}\n`
}

/**
 * Write ONLY the generated env file — the single mutating step of the
 * env+state checkpoint whose outcome commitDevelopmentState() tracks.
 * writeAtomic() replaces the target with one rename or not at all, so a
 * throw here means the path on disk was never modified.
 */
function writeDevelopmentEnvironmentFile(context, distributionPath = undefined, options = {}) {
  writeAtomic(context.envPath, developmentEnvironmentContent(context, distributionPath, options))
}

/**
 * The .envrc shim is only ever CREATED, never modified, and is NOT part of
 * the env+state commit transaction: it is created best-effort AFTER a
 * successful commit (its content is static and has no relation to the
 * committed generation). An existing entry of any kind (regular file,
 * symlink, directory) is never touched; a creation failure only warns and
 * never fails the bootstrap.
 */
function ensureEnvrcShim(context) {
  const direnvPath = join(context.root, '.envrc')
  try {
    const fd = openSync(direnvPath, 'wx', 0o600)
    try {
      writeFileSync(fd, `# Generated by pnpm dev:bootstrap\nsource ./${DEV_ENV_FILE}\n`)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if (error?.code === 'EEXIST') return
    console.warn(`could not create the .envrc shim at ${direnvPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Convenience writer (test/diagnostic surface): env file plus the .envrc
 * shim when absent. It is NOT transactional — production commits go
 * through commitDevelopmentState(), which owns rollback; use
 * writeDevelopmentEnvironmentFile() as its env step.
 */
function writeDevelopmentEnvironment(context, distributionPath = undefined, options = {}) {
  writeDevelopmentEnvironmentFile(context, distributionPath, options)
  ensureEnvrcShim(context)
}

function cachePackPath(context) {
  if (context.sourcePack === undefined) fail('source context has no exact source pack path')
  return context.sourcePack
}

function cachePackRoot(context) {
  return dirname(cachePackPath(context))
}

function existingPathInfo(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function existingCachePath(path) {
  const info = existingPathInfo(path)
  if (info === undefined) return false
  if (info.isSymbolicLink()) fail(`source pack cache must not be a symlink: ${path}`)
  return true
}

function distributionFromPath(helper, context, path, { allowDirty = false, sourcePaths = [] } = {}) {
  return helper.loadDshDistribution({
    mode: 'source',
    manifest: path,
    packageJson: context.packageJsonPath,
    sourceConfig: context.source,
    allowDirty,
    sourcePaths,
    tempRoots: [context.cacheRoot],
    distributionPaths: [path],
  })
}

function assertReproducibleDistribution(distribution, path) {
  if (distribution.dirty === true || distribution.reproducible !== true) {
    fail(`shared source pack must be clean and reproducible: ${path}`)
  }
  return distribution
}

function tryCachedDistribution(helper, context, path, { requireReproducible = false } = {}) {
  if (!existingCachePath(path)) return { distribution: undefined, error: undefined }
  try {
    const distribution = distributionFromPath(helper, context, path)
    if (requireReproducible) assertReproducibleDistribution(distribution, path)
    return { distribution, error: undefined }
  } catch (error) {
    return { distribution: undefined, error }
  }
}

function quarantineInvalidCache(path) {
  if (!existingCachePath(path)) return
  const quarantine = `${path}.invalid-${process.pid}-${randomUUID()}`
  try {
    renameSync(path, quarantine)
  } catch (error) {
    fail(`cannot quarantine invalid source pack cache ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    rmSync(quarantine, { recursive: true, force: true })
  } catch (error) {
    fail(`cannot remove invalid source pack cache ${quarantine}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function lockOwner(path) {
  try {
    const value = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'))
    if (value === null || typeof value !== 'object') return undefined
    return value
  } catch {
    return undefined
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function reapStaleLock(path, label = 'lock') {
  if (!existsSync(path)) return false
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a real directory: ${path}`)
  const owner = lockOwner(path)
  const age = Date.now() - info.mtimeMs
  if (age < LOCK_STALE_MS || processAlive(owner?.pid)) return false
  const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`
  try {
    renameSync(path, quarantine)
  } catch {
    return false
  }
  rmSync(quarantine, { recursive: true, force: true })
  return true
}

async function acquireDirectoryLock(lockPath, label) {
  const token = randomUUID()
  const started = Date.now()
  while (true) {
    try {
      mkdirSync(lockPath)
      writeFileSync(join(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 })
      return { acquired: true, token, lockPath, label }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      reapStaleLock(lockPath, label)
      if (Date.now() - started >= LOCK_WAIT_MS) {
        fail(`timed out waiting for ${label}: ${lockPath}`)
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
    }
  }
}

function releaseDirectoryLock(lock) {
  if (lock?.acquired !== true) return
  const owner = lockOwner(lock.lockPath)
  if (owner?.token !== lock.token || owner?.pid !== process.pid) return
  rmSync(lock.lockPath, { recursive: true, force: true })
}

async function acquireSourceLock(helper, context) {
  const root = cachePackRoot(context)
  assertRealDirectory(root, 'source pack cache root')
  const lockPath = join(root, `${context.source.ref}.lock`)
  while (true) {
    const cached = tryCachedDistribution(helper, context, cachePackPath(context), { requireReproducible: true })
    if (cached.distribution !== undefined) return { acquired: false, distribution: cached.distribution, lockPath }
    const lock = await acquireDirectoryLock(lockPath, 'source pack lock')
    const afterLock = tryCachedDistribution(helper, context, cachePackPath(context), { requireReproducible: true })
    if (afterLock.distribution !== undefined) {
      releaseDirectoryLock(lock)
      return { acquired: false, distribution: afterLock.distribution, lockPath }
    }
    return lock
  }
}

function releaseSourceLock(lock) {
  releaseDirectoryLock(lock)
}

function assertHarnessCheckout(directory, repository, { requirePackage = true } = {}) {
  const top = runCapture('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { label: 'inspect Harness checkout' })
  if (resolve(top) !== resolve(directory)) fail(`Harness checkout is not a repository root: ${directory}`)
  const remote = runCapture('git', ['-C', directory, 'remote', 'get-url', 'origin'], { label: 'inspect Harness checkout remote' })
  if (normalizeDshRepositoryRemote(remote) !== expectedDshRepositoryRemote(repository)) {
    fail(`Harness checkout remote must be ${expectedDshRepositoryRemote(repository)}, got ${remote}`)
  }
  const packagePath = join(directory, 'package.json')
  if (!existsSync(packagePath)) {
    if (requirePackage) fail(`Harness checkout package.json is missing: ${packagePath}`)
    return
  }
  let metadata
  try {
    metadata = JSON.parse(readFileSync(packagePath, 'utf8'))
  } catch (error) {
    fail(`Harness checkout package.json is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (metadata?.name !== '@deepseek-ai/dsh-root') {
    fail(`refusing to operate on a non-Harness checkout: ${directory}`)
  }
}

function assertCleanHarnessCheckout(directory) {
  const status = runCapture('git', ['-C', directory, 'status', '--porcelain', '--untracked-files=all'], {
    label: 'check Harness checkout cleanliness',
  })
  if (status !== '') fail(`DSH source checkout is dirty; refusing shared source-pack build: ${directory}`)
}

function assertHarnessRepository(repositoryPath, repository) {
  const bare = runCapture('git', ['--git-dir', repositoryPath, 'rev-parse', '--is-bare-repository'], {
    label: 'inspect Harness object repository',
  })
  if (bare !== 'true') fail(`Harness object repository must be bare: ${repositoryPath}`)
  const remote = runCapture('git', ['--git-dir', repositoryPath, 'remote', 'get-url', 'origin'], {
    label: 'inspect Harness object repository remote',
  })
  if (normalizeDshRepositoryRemote(remote) !== expectedDshRepositoryRemote(repository)) {
    fail(`Harness object repository remote must be ${expectedDshRepositoryRemote(repository)}, got ${remote}`)
  }
}

function harnessWorktreeRecords(repositoryPath) {
  const output = runCapture('git', ['--git-dir', repositoryPath, 'worktree', 'list', '--porcelain'], {
    label: 'inspect Harness worktrees',
  })
  const records = []
  let record
  for (const line of output.split(/\r?\n/u)) {
    if (line === '') {
      if (record !== undefined) records.push(record)
      record = undefined
      continue
    }
    if (line.startsWith('worktree ')) record = { path: line.slice('worktree '.length) }
    else if (record !== undefined && line.startsWith('HEAD ')) record.head = line.slice('HEAD '.length).toLowerCase()
  }
  if (record !== undefined) records.push(record)
  return records
}

async function ensureHarnessRepository(context, environment) {
  const repositoryPath = context.harnessRepository
  const parent = dirname(repositoryPath)
  assertRealDirectory(parent, 'Harness cache parent')
  const existing = existingPathInfo(repositoryPath)
  if (existing === undefined) {
    await runCommand('git', ['clone', '--bare', '--no-tags', `https://github.com/${context.source.repository}.git`, repositoryPath], {
      cwd: parent,
      env: environment,
      timeoutMs: TIMEOUTS.git,
      label: 'clone shared DeepSeek Harness object repository',
    })
  } else if (!existing.isDirectory() || existing.isSymbolicLink()) {
    fail(`Harness object repository must be a real directory: ${repositoryPath}`)
  }
  assertHarnessRepository(repositoryPath, context.source.repository)
  await runCommand('git', ['--git-dir', repositoryPath, 'fetch', '--no-tags', 'origin', context.source.ref], {
    cwd: context.root,
    env: environment,
    timeoutMs: TIMEOUTS.git,
    label: `fetch DeepSeek Harness ${context.source.ref}`,
  })
  assertHarnessRepository(repositoryPath, context.source.repository)
}

async function ensureHarnessWorktree(context, environment) {
  const repositoryPath = context.harnessRepository
  const directory = context.harnessCheckout
  assertRealDirectory(context.harnessWorktreeRoot, 'Harness worktree root')
  const canonicalDirectory = resolve(directory)
  const existing = harnessWorktreeRecords(repositoryPath).find(record => resolve(record.path) === canonicalDirectory)
  const directoryInfo = existingPathInfo(directory)
  if (directoryInfo?.isSymbolicLink()) {
    fail(`Harness worktree path must be a real directory: ${directory}`)
  }
  if (existing !== undefined) {
    if (existing.head !== context.source.ref) {
      fail(`Harness worktree ${directory} is registered at ${existing.head}, expected ${context.source.ref}`)
    }
  } else if (directoryInfo !== undefined) {
    fail(`Harness worktree path exists but is not registered with the dedicated object repository: ${directory}`)
  } else {
    await runCommand('git', ['--git-dir', repositoryPath, 'worktree', 'add', '--detach', directory, context.source.ref], {
      cwd: context.root,
      env: environment,
      timeoutMs: TIMEOUTS.git,
      label: `create DeepSeek Harness worktree ${context.source.ref}`,
    })
  }
  assertHarnessCheckout(directory, context.source.repository)
  assertCleanHarnessCheckout(directory)
  return directory
}

async function ensureHarnessCheckout(context, requestedDirectory, { skipRepository = false } = {}) {
  const hasProvidedDirectory = typeof requestedDirectory === 'string' && requestedDirectory.trim() !== ''
  if (hasProvidedDirectory) {
    const directory = resolve(requestedDirectory)
    if (directory === context.root || directory.startsWith(`${context.root}${sep}`)) {
      fail(`provided Harness checkout must be outside the TUI worktree: ${directory}`)
    }
    if (!existsSync(directory)) fail(`provided Harness checkout is missing: ${directory}`)
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`provided Harness checkout must be a real directory: ${directory}`)
    // A provided checkout is never fetched, checked out, or published into the
    // shared SHA cache. This allows deliberate dirty-tree debugging safely.
    assertHarnessCheckout(directory, context.source.repository)
    return directory
  }

  assertRealDirectory(context.cacheRoot, 'Harness cache root')
  const lock = await acquireDirectoryLock(join(context.cacheRoot, 'deepseek-harness.git.lock'), 'Harness object repository lock')
  try {
    const environment = commandEnvironment('source', { root: context.root })
    if (!skipRepository) await ensureHarnessRepository(context, environment)
    return await ensureHarnessWorktree(context, environment)
  } finally {
    releaseDirectoryLock(lock)
  }
}

function sourcePackCommandArgs(sourcePackScript, dshDirectory, configPath, output, allowDirty) {
  return [
    sourcePackScript,
    '--dsh-dir', dshDirectory,
    '--config', configPath,
    '--out', output,
    ...(allowDirty ? ['--allow-dirty'] : []),
  ]
}

async function runSourcePack(helper, context, dshDirectory, output, { strictSourceIdentity, allowDirty }) {
  const sourcePackScript = join(context.root, SOURCE_PACK_SCRIPT)
  if (!existsSync(sourcePackScript)) fail(`source mode requires ${SOURCE_PACK_SCRIPT}`)
  await runCommand(process.execPath, sourcePackCommandArgs(
    sourcePackScript,
    dshDirectory,
    context.sourceConfigPath,
    output,
    allowDirty,
  ), {
    cwd: context.root,
    env: commandEnvironment('source', { strictSourceIdentity, root: context.root }),
    timeoutMs: TIMEOUTS.sourcePack,
    label: 'build and validate official DSH source pack',
  })
  return distributionFromPath(helper, context, output, {
    allowDirty,
    sourcePaths: [dshDirectory],
  })
}

async function buildCachedSourcePack(helper, context) {
  const finalPath = cachePackPath(context)
  const cached = tryCachedDistribution(helper, context, finalPath, { requireReproducible: true })
  if (cached.distribution !== undefined) return { distribution: cached.distribution, cacheHit: true }
  quarantineInvalidCache(finalPath)

  const dshDirectory = await ensureHarnessCheckout(context)
  const stageRoot = mkdtempSync(join(cachePackRoot(context), `.dsh-source-${context.source.ref}-`))
  const stageOutput = join(stageRoot, 'pack')
  let moved = false
  try {
    const staged = await runSourcePack(helper, context, dshDirectory, stageOutput, {
      strictSourceIdentity: true,
      allowDirty: false,
    })
    assertReproducibleDistribution(staged, stageOutput)
    if (existingCachePath(finalPath)) {
      const raced = tryCachedDistribution(helper, context, finalPath, { requireReproducible: true })
      if (raced.distribution !== undefined) return { distribution: raced.distribution, cacheHit: true }
      fail(`source pack cache appeared with invalid contents while building: ${finalPath}`)
    }
    renameSync(stageOutput, finalPath)
    moved = true
    const distribution = assertReproducibleDistribution(distributionFromPath(helper, context, finalPath), finalPath)
    console.log(`Source pack cache: miss (${distribution.packages.size} packages)`)
    return { distribution, cacheHit: false }
  } finally {
    if (!moved && existsSync(stageOutput)) rmSync(stageOutput, { recursive: true, force: true })
    if (existsSync(stageRoot)) rmSync(stageRoot, { recursive: true, force: true })
  }
}

function ephemeralSourcePackRoot(context) {
  // Provided/dirty builds must not be durable cache entries. Keep the output
  // in the OS temporary area so the current shell can use it, while normal OS
  // cleanup supplies the lifetime boundary. The owner marker lets a later
  // bootstrap of the SAME worktree prove ownership before reclaiming the
  // superseded generation (never a global /tmp sweep).
  const root = mkdtempSync(join(tmpdir(), EPHEMERAL_ROOT_PREFIX))
  const markerPath = join(root, EPHEMERAL_MARKER_NAME)
  try {
    writeFileSync(markerPath, `${JSON.stringify({
      schemaVersion: 1,
      kind: EPHEMERAL_MARKER_KIND,
      workspaceRoot: context.root,
      createdAt: new Date().toISOString(),
      pid: process.pid,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    // A generation without its owner marker is unclaimable garbage: remove
    // the empty root instead of leaving it for OS temp hygiene.
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Best effort; the root is empty and harmless.
    }
    throw error
  }
  return root
}

/**
 * Canonical identity for ownership comparisons: realpath when the path
 * exists (so a worktree reached through a symlinked path still matches
 * its own marker), lexical resolve as a safe fallback.
 */
function canonicalPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The full ownership contract for an ephemeral generation root, independent
 * of the current dev state: the path shape (directly inside the OS temp
 * root, project basename prefix), a real non-symlink directory, and an
 * owner-only single-link marker naming THIS worktree. Returns the candidate
 * root when every check passes, undefined otherwise.
 */
function ephemeralRootOwnedBy(context, candidateRoot) {
  if (dirname(candidateRoot) !== resolve(tmpdir())) return undefined
  if (!basename(candidateRoot).startsWith(EPHEMERAL_ROOT_PREFIX)) return undefined
  const rootInfo = existingPathInfo(candidateRoot)
  if (rootInfo === undefined || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return undefined
  const markerPath = join(candidateRoot, EPHEMERAL_MARKER_NAME)
  const markerInfo = existingPathInfo(markerPath)
  if (markerInfo === undefined || !markerInfo.isFile() || markerInfo.isSymbolicLink()) return undefined
  // The marker contract is an owner-only ordinary file: a forged mode or a
  // hardlink (nlink > 1) is not acceptable proof of ownership.
  if (markerInfo.nlink !== 1 || (markerInfo.mode & 0o777) !== 0o600) return undefined
  let marker
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    return undefined
  }
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return undefined
  if (marker.schemaVersion !== 1 || marker.kind !== EPHEMERAL_MARKER_KIND) return undefined
  if (typeof marker.workspaceRoot !== 'string' || canonicalPath(marker.workspaceRoot) !== canonicalPath(context.root)) return undefined
  return candidateRoot
}

/**
 * The previous generation this worktree may reclaim, proven by the committed
 * dev state plus the owner marker inside the candidate root. Returns the
 * resolved candidate root, or undefined when anything is off-spec (wrong
 * mode, non-ephemeral, outside tmpdir, wrong basename shape, symlinked
 * root/marker, foreign worktree marker, ...). Never scans /tmp broadly.
 */
function reclaimableEphemeralRoot(context) {
  const state = readState(context)
  if (state === undefined || state.mode !== 'source' || state.ephemeral !== true) return undefined
  const distribution = state.distribution
  if (typeof distribution !== 'string' || !isAbsolute(distribution)) return undefined
  if (basename(distribution) !== 'pack') return undefined
  return ephemeralRootOwnedBy(context, resolve(dirname(distribution)))
}

/**
 * Remove a superseded ephemeral generation — only after the new state/env
 * committed successfully. When the dev context is supplied, the ENTIRE
 * ownership contract (path shape, real root, owner-only single-link marker
 * naming this worktree) is revalidated immediately before the recursive
 * removal, so a candidate replaced between the reclaim decision and this
 * call fails closed and stays for OS temp hygiene instead of being deleted.
 * A failure to remove must never fail the bootstrap.
 */
function reclaimEphemeralRoot(candidateRoot, activeDistributionPath = undefined, context = undefined) {
  if (candidateRoot === undefined) return
  if (typeof activeDistributionPath === 'string' && resolve(dirname(activeDistributionPath)) === candidateRoot) return
  if (context !== undefined) {
    let owned
    try {
      owned = ephemeralRootOwnedBy(context, candidateRoot)
    } catch (error) {
      // A validation failure (for example EACCES on a path component) must
      // never fail the bootstrap: fail closed and leave the candidate to
      // OS temp hygiene.
      console.warn(`could not verify ${candidateRoot} before reclaim: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (owned === undefined) {
      console.warn(`not reclaiming ${candidateRoot}: it no longer satisfies the ephemeral ownership contract for this worktree`)
      return
    }
  }
  try {
    rmSync(candidateRoot, { recursive: true, force: true })
    console.log(`Reclaimed superseded ephemeral source pack: ${candidateRoot}`)
  } catch (error) {
    console.warn(`Could not reclaim superseded ephemeral source pack ${candidateRoot}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function buildProvidedSourcePack(helper, context, requestedDirectory) {
  const dshDirectory = await ensureHarnessCheckout(context, requestedDirectory)
  const outputRoot = ephemeralSourcePackRoot(context)
  const output = join(outputRoot, 'pack')
  try {
    const distribution = await runSourcePack(helper, context, dshDirectory, output, {
      strictSourceIdentity: false,
      allowDirty: true,
    })
    console.log(`Source pack: ephemeral (${output})`)
    // Ownership of the freshly built generation stays explicit: the caller
    // must discard it if materializeSource() fails before the new state
    // commits. An explicit --distribution is also `provided`, but it is NOT
    // ours to delete — only this freshly built root is.
    return { distribution, path: output, cacheHit: false, provided: true, ownedEphemeralRoot: outputRoot }
  } catch (error) {
    discardOwnedEphemeralRoot(context, outputRoot)
    throw error
  }
}

/**
 * Delete an ephemeral generation this process built but never committed:
 * materializeSource() failed after the pack succeeded (install, resolution
 * assert, or the env/state commit), so nothing references the new root and
 * the previous generation stays the active one. The removal is guarded by
 * the structural ownership contract (ephemeralRootOwnedBy): a root that no
 * longer satisfies it — replaced, marker missing/forged, foreign worktree —
 * is never recursively deleted. Best effort: failures only warn; the
 * original bootstrap error is what propagates.
 */
function discardOwnedEphemeralRoot(context, root) {
  if (root === undefined) return
  let owned
  try {
    owned = ephemeralRootOwnedBy(context, root)
  } catch (error) {
    // A validation failure (for example EACCES on a path component) must
    // never replace the original bootstrap error: fail closed and leave
    // the root to OS temp hygiene.
    console.warn(`could not verify ephemeral source pack ${root} before removal: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (owned === undefined) {
    console.warn(`not removing ephemeral source pack ${root}: it no longer satisfies the ownership contract for this worktree`)
    return
  }
  try {
    rmSync(root, { recursive: true, force: true })
    console.warn(`Discarded uncommitted ephemeral source pack after bootstrap failure: ${root}`)
  } catch (error) {
    console.warn(`Could not discard uncommitted ephemeral source pack ${root}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * The ephemeral generation the committed dev state still references, when
 * it is still usable: the state is source+ephemeral with a matching
 * repository/ref/expectedVersion identity, and the referenced distribution
 * still exists as an OWNED generation of this worktree (full ownership
 * contract) with a loadable manifest. Returns { distribution, path } or
 * undefined. A shell whose inherited generation was reclaimed by another
 * bootstrap recovers to this committed generation instead of silently
 * switching the worktree to the canonical source-pack cache — which would
 * reclaim the still-working generation (and, for a dirty provided pack,
 * quietly replace it with the pinned/canonical source).
 */
function committedEphemeralDistribution(helper, context) {
  const state = readState(context)
  if (state === undefined || state.mode !== 'source' || state.ephemeral !== true) return undefined
  if (state.repository !== context.source.repository
    || state.ref !== context.source.ref
    || state.expectedVersion !== context.source.expectedVersion) return undefined
  const path = state.distribution
  if (typeof path !== 'string' || !isAbsolute(path) || basename(path) !== 'pack') return undefined
  if (ephemeralRootOwnedBy(context, resolve(dirname(path))) === undefined) return undefined
  try {
    const distribution = distributionFromPath(helper, context, path, { allowDirty: true })
    return { distribution, path }
  } catch {
    return undefined
  }
}

async function sourceDistribution(helper, context, values) {
  // An explicit checkout is the debug escape hatch and must win over a stale
  // DSH_SOURCE_DISTRIBUTION inherited from a previously sourced shell.
  const requestedDshDirectory = values['dsh-dir'] ?? (values.distribution === undefined ? process.env.DSH_DIR : undefined)
  if (typeof requestedDshDirectory === 'string' && requestedDshDirectory.trim() !== '') {
    return buildProvidedSourcePack(helper, context, requestedDshDirectory)
  }
  const requestedDistribution = values.distribution ?? context.distribution
  if (requestedDistribution !== undefined) {
    const providedPath = resolve(context.root, requestedDistribution)
    const distribution = distributionFromPath(helper, context, providedPath, { allowDirty: true })
    console.log(`Source pack: provided (${providedPath})`)
    return { distribution, path: providedPath, cacheHit: false, provided: true }
  }
  // No inherited distribution (or one whose generation was reclaimed by
  // another bootstrap): recover to the generation the committed state still
  // references before falling back to the canonical source-pack cache. The
  // committed state is authoritative — switching to the cache would reclaim
  // the working generation.
  const committed = committedEphemeralDistribution(helper, context)
  if (committed !== undefined) {
    console.log(`Source pack: committed ephemeral (${committed.path})`)
    return { distribution: committed.distribution, path: committed.path, cacheHit: false, provided: false }
  }
  const lock = await acquireSourceLock(helper, context)
  try {
    if (!lock.acquired) {
      console.log('Source pack cache: hit (another process completed it)')
      return { distribution: lock.distribution, path: cachePackPath(context), cacheHit: true }
    }
    const result = await buildCachedSourcePack(helper, context)
    if (result.cacheHit) console.log('Source pack cache: hit')
    return { ...result, path: cachePackPath(context) }
  } finally {
    releaseSourceLock(lock)
  }
}

function sourceMaterialized(helper, context, distribution) {
  if (!assertIndependentNodeModules(context.root)) return false
  try {
    const required = helper.sourceInstallPackages(distribution, context.packageJson)
    helper.assertSourceResolution(context.root, distribution, required)
    return true
  } catch {
    return false
  }
}

/**
 * Snapshot a regular file (content AND mode) for rollback WITHOUT ever
 * reading through a symlink: a symlink (or any non-regular file) at the
 * path is recorded as `unsafe`, so a later rollback of a path THIS COMMIT
 * REPLACED removes the swapped-in link instead of copying what it points
 * at. A pre-existing entry the commit never replaced is never rolled back
 * at all — see commitDevelopmentState.
 */
function snapshotRegularFile(path) {
  const info = existingPathInfo(path)
  if (info === undefined) return undefined
  if (info.isSymbolicLink() || !info.isFile()) return { unsafe: true }
  return { content: readFileSync(path, 'utf8'), mode: info.mode & 0o777 }
}

/**
 * Restore a path THIS COMMIT REPLACED to its snapshot, fail-closed and
 * never destructive:
 * - a swapped-in symlink is removed (never followed) and the previous
 *   content is written in its place;
 * - an unexpected DIRECTORY at the path is never recursively deleted —
 *   rollback throws so the failure is reported instead of silently
 *   destroying data;
 * - a regular file is replaced with the previous content AND mode, or
 *   removed when there was no previous regular file.
 */
function rollbackPath(path, snapshot) {
  const current = existingPathInfo(path)
  if (current === undefined) {
    if (snapshot !== undefined && !snapshot.unsafe) writeAtomic(path, snapshot.content, snapshot.mode)
    return
  }
  if (current.isSymbolicLink()) {
    rmSync(path, { force: true })
    if (snapshot !== undefined && !snapshot.unsafe) writeAtomic(path, snapshot.content, snapshot.mode)
    return
  }
  if (current.isDirectory()) {
    throw new Error(`refusing to remove unexpected directory at ${path} during rollback`)
  }
  if (snapshot === undefined || snapshot.unsafe) rmSync(path, { force: true })
  else writeAtomic(path, snapshot.content, snapshot.mode)
}

function commitDevelopmentState(context, writeEnvironment, writeStateFn) {
  // The env file and the state file are one logical checkpoint: a shell
  // sources the env file, but every durable decision (mode, generation,
  // distribution) is read back from the state file. The state file is the
  // commit point — writeAtomic() leaves it untouched when it throws — so a
  // failed commit keeps every durable reference pointing at the previous
  // generation. Only the env file is rolled back, and only when its write
  // SUCCEEDED and the state write then failed: writeAtomic() never
  // partially replaces the target, so a throw from the env writer means
  // the path is already exactly as it was. The .envrc shim is NOT part of
  // this transaction (see ensureEnvrcShim).
  let envFileCommitted = false
  let previousEnv
  try {
    previousEnv = snapshotRegularFile(context.envPath)
    writeEnvironment()
    envFileCommitted = true
    writeStateFn()
  } catch (error) {
    try {
      if (envFileCommitted) rollbackPath(context.envPath, previousEnv)
    } catch (rollbackError) {
      console.warn(`could not roll back the dev environment after state commit failure: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
    }
    throw error
  }
}

async function materializeSource(helper, context, distribution, distributionPath, force, provided) {
  const pnpmCommand = configuredPnpm()
  const pnpm = currentPnpmVersion(pnpmCommand, context.root)
  const state = readState(context)
  const already = !force && provided !== true && stateCoreMatches(context, state, pnpm, distributionPath) && sourceMaterialized(helper, context, distribution)
  if (!already) {
    const prepareScript = join(context.root, SOURCE_PREPARE_SCRIPT)
    if (!existsSync(prepareScript)) fail(`source mode requires ${SOURCE_PREPARE_SCRIPT}`)
    const allowDirty = distribution.dirty === true || distribution.reproducible !== true
    await runCommand(process.execPath, [
      prepareScript,
      '--mode', 'source',
      '--distribution', distributionPath,
      '--workspace', context.root,
      '--config', context.sourceConfigPath,
      '--ref', context.source.ref,
      '--expected-version', context.source.expectedVersion,
      ...(allowDirty ? ['--allow-dirty'] : []),
    ], {
      cwd: context.root,
      env: commandEnvironment('source', { root: context.root }),
      timeoutMs: TIMEOUTS.install,
      label: 'materialize DSH source distribution in this worktree',
    })
  } else {
    console.log('Workspace source distribution: already materialized')
  }
  assertIndependentNodeModules(context.root)
  const required = helper.sourceInstallPackages(distribution, context.packageJson)
  helper.assertSourceResolution(context.root, distribution, required)
  const ephemeral = provided === true || resolve(distributionPath) !== resolve(context.sourcePack)
  commitDevelopmentState(
    context,
    () => writeDevelopmentEnvironmentFile(context, distributionPath, { ephemeral }),
    () => writeState(context, pnpm, distributionPath, { ephemeral }),
  )
  // Best-effort, AFTER the commit: the .envrc shim is not part of the
  // transaction and a failure here must never fail the bootstrap.
  ensureEnvrcShim(context)
}

function npmMaterialized(context, pnpm, force) {
  if (force || !assertIndependentNodeModules(context.root)) return false
  if (!stateCoreMatches(context, readState(context), pnpm)) return false
  return inspectNpmResolution(context).problems.length === 0
}

async function materializeNpm(context, force) {
  const pnpmCommand = configuredPnpm()
  const pnpm = currentPnpmVersion(pnpmCommand, context.root)
  if (!npmMaterialized(context, pnpm, force)) {
    await runCommand(pnpmCommand, ['install', '--frozen-lockfile', '--reporter=append-only'], {
      cwd: context.root,
      env: commandEnvironment('npm', { root: context.root }),
      timeoutMs: TIMEOUTS.install,
      label: 'install frozen npm DSH dependencies',
    })
  } else {
    console.log('Workspace npm dependencies: already materialized')
  }
  assertIndependentNodeModules(context.root)
  commitDevelopmentState(
    context,
    () => writeDevelopmentEnvironmentFile(context),
    () => writeState(context, pnpm),
  )
  // Best-effort, AFTER the commit: the .envrc shim is not part of the
  // transaction and a failure here must never fail the bootstrap.
  ensureEnvrcShim(context)
}

function parseCli() {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  const { values } = parseArgs({
    args,
    options: {
      root: { type: 'string' },
      mode: { type: 'string' },
      config: { type: 'string' },
      distribution: { type: 'string' },
      'dsh-dir': { type: 'string' },
      force: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  return values
}

export const _test = {
  acquireSourceLock,
  releaseSourceLock,
  sourceDistribution,
  sourcePackCommandArgs,
  writeDevelopmentEnvironment,
  writeDevelopmentEnvironmentFile,
  ensureEnvrcShim,
  existingCachePath,
  reapStaleLock,
  tryCachedDistribution,
  stateCoreMatches,
  assertHarnessCheckout,
  ensureHarnessCheckout,
  ensureHarnessRepository,
  ensureHarnessWorktree,
  runCommand,
  commandEnvironment,
  ephemeralSourcePackRoot,
  reclaimableEphemeralRoot,
  reclaimEphemeralRoot,
  discardOwnedEphemeralRoot,
  commitDevelopmentState,
  bootstrapLockPath,
  acquireBootstrapLock,
  releaseBootstrapLock,
  EPHEMERAL_ROOT_PREFIX,
  EPHEMERAL_MARKER_NAME,
  EPHEMERAL_MARKER_KIND,
}

const BOOTSTRAP_LOCK_DIRECTORY = 'bootstrap-locks'

/** The per-worktree bootstrap lock path: one lock per canonical worktree
 * root, shared by every process bootstrapping that worktree. */
function bootstrapLockPath(context) {
  const root = join(context.cacheRoot, BOOTSTRAP_LOCK_DIRECTORY)
  assertRealDirectory(root, 'bootstrap lock root')
  const key = createHash('sha256').update(canonicalPath(context.root)).digest('hex').slice(0, 16)
  return join(root, `${key}.lock`)
}

async function acquireBootstrapLock(context) {
  return acquireDirectoryLock(bootstrapLockPath(context), 'worktree bootstrap lock')
}

function releaseBootstrapLock(lock) {
  releaseDirectoryLock(lock)
}

export async function bootstrapDevelopmentEnvironment(options = {}) {
  const context = resolveDshDevContext(options)
  const force = options.force === true
  // One bootstrap at a time per worktree: two agents bootstrapping the same
  // worktree concurrently would race on node_modules, the env/state commit,
  // and generation reclaim (the second one would reclaim the first's
  // committed generation). The lock covers the whole flow — previous-state
  // read, source selection/build, materialize, env/state commit, reclaim —
  // so the second caller waits, then sees the first caller's committed
  // state and reuses it. Different worktrees have independent locks.
  const lock = await acquireBootstrapLock(context)
  try {
    // Captured BEFORE any state mutation: the ephemeral generation this
    // worktree still references. It stays untouched until the new
    // generation has committed, so a failed bootstrap leaves the previous
    // one usable.
    const previousEphemeralRoot = reclaimableEphemeralRoot(context)
    let result
    if (context.mode === 'npm') {
      await materializeNpm(context, force)
      result = { context, distribution: undefined, cacheHit: undefined }
    } else {
      if (process.platform === 'win32') fail('source mode requires POSIX directory operations and is unsupported on Windows')
      const helper = await distributionHelper(context)
      const selected = await sourceDistribution(helper, context, options)
      try {
        await materializeSource(helper, context, selected.distribution, selected.path, force, selected.provided)
      } catch (error) {
        // The pack succeeded but nothing committed to it yet: this process is
        // still the owner of the fresh generation, so a failure here must not
        // leak a new dsh-pi-tui-source-* root into the OS temp area.
        discardOwnedEphemeralRoot(context, selected.ownedEphemeralRoot)
        throw error
      }
      result = {
        context,
        distribution: selected.distribution,
        distributionPath: selected.path,
        cacheHit: selected.cacheHit,
      }
    }
    reclaimEphemeralRoot(previousEphemeralRoot, result.distributionPath, context)
    return result
  } finally {
    releaseBootstrapLock(lock)
  }
}

async function main() {
  const values = parseCli()
  const result = await bootstrapDevelopmentEnvironment({
    root: values.root,
    mode: values.mode,
    config: values.config,
    distribution: values.distribution,
    'dsh-dir': values['dsh-dir'],
    force: values.force,
  })
  if (result.context.mode === 'source') {
    console.log(`DSH mode: source`)
    console.log(`DSH ref: ${result.context.source.ref}`)
    console.log(`Source pack: ${result.distributionPath}`)
  } else {
    console.log('DSH mode: npm')
  }
  console.log('✓ development environment ready')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch(error => {
    console.error(`DSH_DEV_BOOTSTRAP_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
