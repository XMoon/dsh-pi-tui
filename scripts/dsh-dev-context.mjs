#!/usr/bin/env node
/**
 * Resolve the local DSH development distribution context.
 *
 * The context is deliberately independent of Git branch names. A workspace
 * with a tracked source pin uses source mode; a workspace without one defaults
 * to the registry-backed npm mode. Callers may override the mode explicitly
 * for a diagnostic or a one-off verification.
 *
 * @module dsh-dev-context
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  DSH_CLI_PACKAGE,
  DSH_REPOSITORY,
  isDshPackage,
  loadDshSourceConfig,
} from './lib/dsh-distribution.mjs'

export const SOURCE_CONFIG_RELATIVE = join('test', 'compat', 'dsh-source.json')
export const DEV_STATE_FILE = '.dsh-dev-state.json'
export const DEV_ENV_FILE = '.dsh-dev-env'
export const CACHE_DIRECTORY_NAME = 'dsh-pi-tui'


export { DSH_CLI_PACKAGE, DSH_REPOSITORY }

export class DshDevContextError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DshDevContextError'
  }
}

function fail(message) {
  throw new DshDevContextError(message)
}

function objectValue(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}

export function readJsonFile(path, label = basename(path)) {
  try {
    return objectValue(JSON.parse(readFileSync(path, 'utf8')), label)
  } catch (error) {
    if (error instanceof DshDevContextError) throw error
    fail(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function readPackageJson(root) {
  const directory = resolve(root)
  const path = join(directory, 'package.json')
  if (!existsSync(path) || !statSync(path).isFile()) fail(`package.json is missing: ${path}`)
  return { path, value: readJsonFile(path, 'package.json') }
}

export function generatedEnvironmentBelongsToRoot(root, environment = process.env) {
  const owner = environment.DSH_DEV_ROOT
  if (owner === undefined) return true
  if (typeof owner !== 'string' || owner.trim() === '') return false
  return resolve(owner) === resolve(root)
}

export function sourceConfigPath(root, configuredPath = undefined, environment = process.env) {
  const directory = resolve(root)
  const selected = configuredPath
    ?? (generatedEnvironmentBelongsToRoot(directory, environment) ? environment.DSH_SOURCE_CONFIG : undefined)
    ?? SOURCE_CONFIG_RELATIVE
  return resolve(directory, selected)
}

export function loadSourceConfig(path) {
  const resolved = resolve(path)
  if (!existsSync(resolved) || !statSync(resolved).isFile()) fail(`DSH source config is missing: ${resolved}`)
  try {
    return loadDshSourceConfig(resolved)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

export function cacheRoot(environment = process.env) {
  const configured = environment.XDG_CACHE_HOME
  const base = typeof configured === 'string' && configured.trim() !== ''
    ? resolve(configured)
    : join(homedir(), '.cache')
  return join(base, CACHE_DIRECTORY_NAME)
}

export function requiredDshPackages(packageJson) {
  const names = new Set()
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    const entries = packageJson?.[section]
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) continue
    for (const name of Object.keys(entries)) {
      if (isDshPackage(name)) names.add(name)
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

export function sourceEnvironment(base = process.env) {
  return {
    ...base,
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
    pnpm_config_verify_deps_before_run: 'false',
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false',
    TARBALL_SMOKE_SKIP_INSTALL: '1',
  }
}

export function hashFile(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export function packageManagerInfo(packageJson) {
  const declared = packageJson.packageManager
  if (typeof declared !== 'string' || declared.trim() === '') return { name: undefined, version: undefined, declared }
  const match = /^(?<name>[^@]+)@(?<version>.+)$/u.exec(declared.trim())
  return match === null
    ? { name: declared.trim(), version: undefined, declared: declared.trim() }
    : { name: match.groups.name, version: match.groups.version, declared: declared.trim() }
}

/**
 * Resolve one mode-neutral development context.
 *
 * `DSH_DEV_MODE`/`DSH_MODE` and the explicit option are diagnostic overrides;
 * the normal default is determined by whether this workspace carries the
 * source-pin policy file, never by its branch name.
 */
export function resolveDshDevContext({ root = process.cwd(), mode, config, distribution, environment = process.env } = {}) {
  const directory = resolve(root)
  const packageJson = readPackageJson(directory)
  const packageManager = packageManagerInfo(packageJson.value)
  const generatedEnvBelongsHere = generatedEnvironmentBelongsToRoot(directory, environment)
  const environmentMode = generatedEnvBelongsHere
    ? environment.DSH_DEV_MODE ?? environment.DSH_MODE
    : undefined
  const configuredMode = mode ?? environmentMode
  const configPath = sourceConfigPath(directory, config, environment)
  const modeFromPolicy = configuredMode ?? (existsSync(configPath) ? 'source' : 'npm')
  if (modeFromPolicy !== 'source' && modeFromPolicy !== 'npm') {
    fail(`unsupported DSH development mode ${modeFromPolicy}; expected source or npm`)
  }
  const source = modeFromPolicy === 'source' ? loadSourceConfig(configPath) : undefined
  const cache = cacheRoot(environment)
  const sourcePack = source === undefined ? undefined : join(cache, 'source-packs', source.ref)
  const environmentDistribution = distribution ?? (generatedEnvBelongsHere ? environment.DSH_SOURCE_DISTRIBUTION : undefined)
  const generatedDurableDistribution = distribution === undefined
    && generatedEnvBelongsHere
    && environment.DSH_DEV_EPHEMERAL === '0'
    && environmentDistribution !== undefined
    && sourcePack !== undefined
    && resolve(directory, environmentDistribution) === resolve(sourcePack)
  // A shell that sourced an ephemeral generation keeps inheriting its path
  // after another shell's bootstrap reclaimed that generation. Such an
  // inherited distribution is stale and must self-heal: drop it and fall
  // back to the normal resolution (committed state / canonical cache)
  // instead of hard-loading a path that no longer exists. Explicit
  // distribution arguments are never second-guessed.
  const staleEphemeralDistribution = distribution === undefined
    && generatedEnvBelongsHere
    && environment.DSH_DEV_EPHEMERAL === '1'
    && environmentDistribution !== undefined
    && !existsSync(resolve(directory, environmentDistribution))
  if (staleEphemeralDistribution) {
    console.warn(`DSH dev: ignoring stale inherited DSH_SOURCE_DISTRIBUTION=${environmentDistribution} (ephemeral generation no longer exists); run pnpm dev:bootstrap to refresh this shell`)
  }
  return {
    schemaVersion: 1,
    root: directory,
    packageJsonPath: packageJson.path,
    packageJson: packageJson.value,
    packageManager,
    mode: modeFromPolicy,
    sourceConfigPath: source?.path ?? configPath,
    source,
    cacheRoot: cache,
    harnessRepository: source === undefined ? undefined : join(cache, 'deepseek-harness.git'),
    harnessWorktreeRoot: source === undefined ? undefined : join(cache, 'harness-worktrees'),
    harnessCheckout: source === undefined ? undefined : join(cache, 'harness-worktrees', source.ref),
    sourcePack,
    distribution: generatedDurableDistribution || staleEphemeralDistribution ? undefined : environmentDistribution,
    statePath: join(directory, DEV_STATE_FILE),
    envPath: join(directory, DEV_ENV_FILE),
    requiredDshPackages: requiredDshPackages(packageJson.value),
  }
}

function cli() {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  const { values } = parseArgs({
    args,
    options: {
      root: { type: 'string' },
      mode: { type: 'string' },
      config: { type: 'string' },
      distribution: { type: 'string' },
    },
    allowPositionals: false,
  })
  const context = resolveDshDevContext({
    root: values.root,
    mode: values.mode,
    config: values.config,
    distribution: values.distribution,
  })
  console.log(JSON.stringify({
    schemaVersion: context.schemaVersion,
    root: context.root,
    mode: context.mode,
    sourceConfig: context.source,
    sourcePack: context.sourcePack,
    distribution: context.distribution,
    packageManager: context.packageManager,
  }, null, 2))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cli()
  } catch (error) {
    console.error(`DSH_DEV_CONTEXT_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
