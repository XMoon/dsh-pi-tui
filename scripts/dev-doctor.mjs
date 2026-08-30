#!/usr/bin/env node
/**
 * Read-only diagnostic for one dsh-pi-tui development worktree.
 *
 * The doctor never installs, builds, deletes, or rewrites anything. It reports
 * one of READY, STALE, MISSING, or BROKEN and gives the same bootstrap command
 * for every non-ready state.
 *
 * @module dev-doctor
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  DEV_STATE_FILE,
  hashFile,
  resolveDshDevContext,
  sourceEnvironment,
} from './dsh-dev-context.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SOURCE_HELPER_RELATIVE = join('scripts', 'lib', 'dsh-distribution.mjs')
const STATUS_ORDER = { READY: 0, MISSING: 1, STALE: 2, BROKEN: 3 }

function diagnostic(status, message) {
  return { status, message }
}

function packageInstallPath(root, name) {
  return join(root, 'node_modules', ...name.split('/'))
}

function commandOutput(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined || result.status !== 0) {
    return { value: undefined, error: result.error?.message ?? ((result.stderr ?? '').trim() || `exit ${result.status ?? 'unknown'}`) }
  }
  return { value: (result.stdout ?? '').trim(), error: undefined }
}

function pnpmVersion() {
  const env = {
    ...process.env,
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false',
  }
  const configured = env.PNPM_EXECUTABLE
  const command = typeof configured === 'string' && configured !== '' ? configured : 'pnpm'
  return commandOutput(command, ['--version'], env)
}

function nodeVersionOkay() {
  const [majorText, minorText] = process.versions.node.split('.')
  const major = Number(majorText)
  const minor = Number(minorText)
  return major >= 24 || (major === 22 && minor >= 19)
}

function readState(path) {
  if (!existsSync(path)) return { value: undefined, error: undefined }
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      return { value: undefined, error: 'local state must be a regular file' }
    }
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { value: undefined, error: 'local state must be an object' }
    }
    return { value, error: undefined }
  } catch (error) {
    return { value: undefined, error: error instanceof Error ? error.message : String(error) }
  }
}

function loadHelper(context) {
  const path = join(context.root, SOURCE_HELPER_RELATIVE)
  if (!existsSync(path)) return { path, helper: undefined, error: undefined }
  return import(pathToFileURL(path).href)
    .then(helper => ({ path, helper, error: undefined }))
    .catch(error => ({ path, helper: undefined, error: error instanceof Error ? error.message : String(error) }))
}

function stateMatches(context, state, distributionPath, pnpm) {
  if (state === undefined) return diagnostic('MISSING', `${DEV_STATE_FILE} is missing`)
  if (state.schemaVersion !== 1) return diagnostic('BROKEN', `${DEV_STATE_FILE} has an unsupported schemaVersion`)
  const required = ['mode', 'node', 'pnpm', 'root', 'packageJsonHash', 'lockfileHash']
  const missing = required.filter(field => !Object.hasOwn(state, field))
  if (missing.length > 0) return diagnostic('BROKEN', `${DEV_STATE_FILE} is missing required fields: ${missing.join(', ')}`)
  if (typeof state.mode !== 'string' || typeof state.node !== 'string' || typeof state.pnpm !== 'string' || typeof state.root !== 'string'
    || typeof state.packageJsonHash !== 'string' || !/^[0-9a-f]{64}$/u.test(state.packageJsonHash)
    || typeof state.lockfileHash !== 'string' || !/^[0-9a-f]{64}$/u.test(state.lockfileHash)) {
    return diagnostic('BROKEN', `${DEV_STATE_FILE} has invalid required field types`)
  }
  if (state.mode !== context.mode) return diagnostic('STALE', `local state mode=${state.mode}; expected ${context.mode}`)
  if (context.mode === 'source' && context.distribution !== undefined && state.ephemeral !== true) {
    return diagnostic('STALE', 'an explicitly provided source distribution must remain ephemeral')
  }
  if (context.mode === 'source' && resolve(distributionPath ?? '') !== resolve(context.sourcePack)) {
    return diagnostic('STALE', 'current source distribution is outside the canonical SHA cache; it is not durable')
  }
  if (context.mode === 'source' && state.ephemeral === true) {
    return diagnostic('STALE', 'local state is an ephemeral provided source distribution; run standard source bootstrap for durable cache')
  }
  if (resolve(state.root) !== context.root) {
    return diagnostic('STALE', `local state belongs to ${state.root}`)
  }
  if (state.packageJsonHash !== hashFile(context.packageJsonPath)) {
    return diagnostic('STALE', 'package.json changed since bootstrap')
  }
  const lockfile = join(context.root, 'pnpm-lock.yaml')
  if (state.lockfileHash !== hashFile(lockfile)) {
    return diagnostic('STALE', 'pnpm-lock.yaml changed since bootstrap')
  }
  if (state.node !== String(process.versions.node.split('.')[0])) {
    return diagnostic('STALE', `local state node=${state.node}; current node=${process.versions.node.split('.')[0]}`)
  }
  if (state.pnpm !== pnpm) {
    return diagnostic('STALE', `local state pnpm=${state.pnpm}; current pnpm=${pnpm}`)
  }
  if (context.mode === 'source') {
    const sourceRequired = ['repository', 'ref', 'expectedVersion', 'distribution']
    const sourceMissing = sourceRequired.filter(field => !Object.hasOwn(state, field))
    if (sourceMissing.length > 0) return diagnostic('BROKEN', `${DEV_STATE_FILE} is missing source fields: ${sourceMissing.join(', ')}`)
    if (typeof state.repository !== 'string' || typeof state.ref !== 'string' || typeof state.expectedVersion !== 'string'
      || typeof state.distribution !== 'string' || !isAbsolute(state.distribution)) {
      return diagnostic('BROKEN', `${DEV_STATE_FILE} has invalid source field types`)
    }
    if (state.repository !== context.source.repository || state.ref !== context.source.ref || state.expectedVersion !== context.source.expectedVersion) {
      return diagnostic('STALE', 'local state does not match the tracked DSH source pin')
    }
    if (resolve(state.distribution) !== resolve(distributionPath ?? '')) {
      return diagnostic('STALE', 'local state distribution does not match the current source pack')
    }
  }
  return undefined
}

function sourceEnvironmentStatus(context, environment = process.env) {
  if (context.mode !== 'source') return { ok: true, message: 'not required for npm mode' }
  const expected = sourceEnvironment({})
  const missing = Object.entries({
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: expected.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN,
    pnpm_config_verify_deps_before_run: expected.pnpm_config_verify_deps_before_run,
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: expected.PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS,
    TARBALL_SMOKE_SKIP_INSTALL: expected.TARBALL_SMOKE_SKIP_INSTALL,
  }).filter(([name, value]) => environment[name] !== value).map(([name]) => name)
  if (missing.length > 0) return { ok: false, message: `not loaded (${missing.join(', ')})` }
  return { ok: true, message: 'correct' }
}

function nodeModulesStatus(context) {
  const path = join(context.root, 'node_modules')
  if (!existsSync(path)) return diagnostic('MISSING', 'node_modules is missing')
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) return diagnostic('BROKEN', 'node_modules must be an independent real directory')
  return undefined
}

function pathWithin(root, target) {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function resolutionPath(context, name) {
  const path = packageInstallPath(context.root, name)
  if (!existsSync(path)) return { path, realpath: undefined, metadata: undefined, error: 'missing' }
  try {
    const info = lstatSync(path)
    if (!info.isSymbolicLink()) {
      return { path, realpath: resolve(path), metadata: undefined, error: 'package is not a pnpm virtual-store link' }
    }
    const realpath = realpathSync(path)
    const virtualStore = join(context.root, 'node_modules', '.pnpm')
    if (!existsSync(virtualStore) || !pathWithin(realpathSync(virtualStore), realpath)) {
      return { path, realpath, metadata: undefined, error: 'symlink is not a pnpm virtual-store resolution' }
    }
    const packageJson = join(path, 'package.json')
    const metadata = JSON.parse(readFileSync(packageJson, 'utf8'))
    return { path, realpath, metadata, error: undefined }
  } catch (error) {
    return { path, realpath: undefined, metadata: undefined, error: error instanceof Error ? error.message : String(error) }
  }
}

const SEMVER = /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

function parseVersion(value) {
  const match = SEMVER.exec(value)
  if (match === null) return undefined
  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
    prerelease: match.groups.prerelease === undefined ? [] : match.groups.prerelease.split('.').map(part => /^\d+$/u.test(part) ? Number(part) : part),
  }
}

function compareVersions(left, right) {
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1
    if (typeof a === 'number') return -1
    if (typeof b === 'number') return 1
    return String(a) < String(b) ? -1 : 1
  }
  return 0
}

function rangeVersion(value) {
  const normalized = value.replace(/^v/u, '')
  return parseVersion(normalized)
}

function upperForCaret(base) {
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0, prerelease: [] }
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] }
  return { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] }
}

function upperForTilde(base) {
  return { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] }
}

function satisfiesSimpleRange(version, range) {
  const normalized = range.trim().replace(/^workspace:/u, '')
  if (normalized === '' || normalized === '*' || normalized.toLowerCase() === 'latest') return true
  if (normalized.includes(' - ')) {
    const [lowText, highText] = normalized.split(' - ', 2)
    const low = rangeVersion(lowText)
    const high = rangeVersion(highText)
    return low !== undefined && high !== undefined && compareVersions(version, low) >= 0 && compareVersions(version, high) <= 0
  }
  if (/^[~^]/u.test(normalized)) {
    const base = rangeVersion(normalized.slice(1))
    if (base === undefined) return false
    const upper = normalized.startsWith('^') ? upperForCaret(base) : upperForTilde(base)
    return compareVersions(version, base) >= 0 && compareVersions(version, upper) < 0
  }
  const wildcard = /^(?<major>\d+|x|X|\*)(?:\.(?<minor>\d+|x|X|\*))?(?:\.(?<patch>\d+|x|X|\*))?$/u.exec(normalized)
  if (wildcard !== null && [wildcard.groups.major, wildcard.groups.minor, wildcard.groups.patch].some(value => value !== undefined && /[xX*]/u.test(value))) {
    if (!/[xX*]/u.test(wildcard.groups.major) && version.major !== Number(wildcard.groups.major)) return false
    if (wildcard.groups.minor !== undefined && !/[xX*]/u.test(wildcard.groups.minor) && version.minor !== Number(wildcard.groups.minor)) return false
    if (wildcard.groups.patch !== undefined && !/[xX*]/u.test(wildcard.groups.patch) && version.patch !== Number(wildcard.groups.patch)) return false
    return true
  }
  const comparator = /^(?<operator>>=|<=|>|<|=)?(?<version>v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u.exec(normalized)
  if (comparator === null) return false
  const target = rangeVersion(comparator.groups.version)
  if (target === undefined) return false
  const comparison = compareVersions(version, target)
  switch (comparator.groups.operator ?? '=') {
    case '>=': return comparison >= 0
    case '<=': return comparison <= 0
    case '>': return comparison > 0
    case '<': return comparison < 0
    default: return comparison === 0
  }
}

export function versionSatisfies(versionText, rangeText) {
  const version = parseVersion(versionText)
  if (version === undefined || typeof rangeText !== 'string') return false
  return rangeText.split(/\s*\|\|\s*/u).some(alternative => alternative.trim().split(/\s+/u).filter(Boolean).every(range => satisfiesSimpleRange(version, range)))
}

function declaredDshSpecs(packageJson, name) {
  const specs = []
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    const entries = packageJson?.[section]
    if (entries !== null && typeof entries === 'object' && !Array.isArray(entries) && Object.hasOwn(entries, name)) {
      if (typeof entries[name] === 'string') specs.push(entries[name])
    }
  }
  return specs
}

export function inspectNpmResolution(context) {
  const problems = []
  const versions = new Map()
  for (const name of context.requiredDshPackages) {
    const result = resolutionPath(context, name)
    if (result.error !== undefined) {
      problems.push(diagnostic(result.error === 'missing' ? 'MISSING' : 'BROKEN', `${name}: ${result.error}`))
      continue
    }
    if (result.metadata?.name !== name || typeof result.metadata?.version !== 'string') {
      problems.push(diagnostic('BROKEN', `${name}: installed package metadata is invalid`))
      continue
    }
    versions.set(result.metadata.version, (versions.get(result.metadata.version) ?? 0) + 1)
    const specs = declaredDshSpecs(context.packageJson, name)
    const incompatible = specs.filter(spec => !versionSatisfies(result.metadata.version, spec))
    if (incompatible.length > 0) {
      problems.push(diagnostic('STALE', `${name}: installed ${result.metadata.version} does not satisfy ${incompatible.join(' or ')}`))
      continue
    }
    const lower = result.realpath.toLowerCase()
    if (lower.includes('source-packs') || lower.includes('deepseek-harness') || lower.includes('file+')) {
      problems.push(diagnostic('STALE', `${name}: npm mode resolves through a source distribution (${result.realpath})`))
    }
  }
  return { problems, versions: [...versions.entries()].sort(([left], [right]) => left.localeCompare(right)) }
}

function inspectSourceResolution(helper, context, distribution) {
  const problems = []
  const required = helper.sourceInstallPackages(distribution, context.packageJson)
  for (const name of required) {
    try {
      helper.assertSourcePackageResolution(context.root, distribution, name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = /missing installed package/u.test(message) ? 'MISSING' : 'BROKEN'
      problems.push(diagnostic(status, message))
    }
  }
  return { problems, count: required.length }
}

function bestStatus(diagnostics) {
  if (diagnostics.length === 0) return 'READY'
  return diagnostics.reduce((status, item) => STATUS_ORDER[item.status] > STATUS_ORDER[status] ? item.status : status, 'READY')
}

function addDiagnostics(target, diagnostics) {
  for (const item of diagnostics) if (item !== undefined) target.push(item)
}

function printHuman(context, details) {
  console.log(`DSH mode        ${context.mode}`)
  if (context.mode === 'source') {
    console.log(`DSH ref         ${context.source.ref}`)
    console.log(`DSH version     ${context.source.expectedVersion}`)
    console.log(`source pack     ${details.sourcePack}`)
  } else {
    console.log(`DSH resolution  ${details.npmVersions.length === 0 ? 'missing' : details.npmVersions.map(([version, count]) => `${version} (${count})`).join(', ')}`)
  }
  console.log(`node            ${process.versions.node}`)
  console.log(`pnpm            ${details.pnpm ?? 'unavailable'} (declared ${context.packageManager.declared ?? 'none'})`)
  console.log(`node_modules    ${details.nodeModules}`)
  console.log(`workspace DSH   ${details.workspaceResolution}`)
  console.log(`environment     ${details.environment}`)
  for (const warning of details.warnings) console.log(`warning         ${warning}; use pnpm dev:shell when source env is required`)
  console.log(`local state     ${details.state}`)
  console.log(`status          ${details.status}`)
  if (details.status === 'READY') {
    console.log('✓ development environment ready')
  } else {
    console.log('Run:')
    console.log('  pnpm dev:bootstrap')
  }
}

async function inspect(context) {
  const diagnostics = []
  if (!nodeVersionOkay()) diagnostics.push(diagnostic('BROKEN', `Node ${process.versions.node} does not satisfy the project engine`))

  const pnpm = pnpmVersion()
  if (pnpm.error !== undefined) diagnostics.push(diagnostic('BROKEN', `pnpm is unavailable: ${pnpm.error}`))
  const expectedPnpm = context.packageManager.name === 'pnpm' ? context.packageManager.version : undefined
  if (expectedPnpm !== undefined && pnpm.value !== undefined && pnpm.value !== expectedPnpm) {
    diagnostics.push(diagnostic('STALE', `pnpm ${pnpm.value} does not match packageManager ${expectedPnpm}`))
  }
  if (context.packageManager.name !== undefined && context.packageManager.name !== 'pnpm') {
    diagnostics.push(diagnostic('BROKEN', `packageManager must be pnpm, got ${context.packageManager.declared}`))
  }

  const modules = nodeModulesStatus(context)
  if (modules !== undefined) diagnostics.push(modules)
  const environment = sourceEnvironmentStatus(context)
  const warnings = environment.ok ? [] : [environment.message]

  let sourcePack = context.mode === 'source' ? 'missing' : 'not used'
  let workspaceResolution = context.mode === 'source' ? 'not checked' : 'incorrect'
  let npmVersions = []
  let distributionPath
  if (context.mode === 'source') {
    const helperResult = await loadHelper(context)
    if (helperResult.error !== undefined) {
      diagnostics.push(diagnostic('BROKEN', `cannot load DSH distribution helper: ${helperResult.error}`))
    } else if (helperResult.helper === undefined) {
      diagnostics.push(diagnostic('BROKEN', `missing ${SOURCE_HELPER_RELATIVE}`))
    } else {
      distributionPath = context.distribution ?? context.sourcePack
      const isSharedCache = resolve(distributionPath) === resolve(context.sourcePack)
      try {
        const distribution = helperResult.helper.loadDshDistribution({
          mode: 'source',
          manifest: distributionPath,
          packageJson: context.packageJsonPath,
          sourceConfig: context.source,
          allowDirty: !isSharedCache,
          sourcePaths: [context.harnessCheckout],
          tempRoots: [context.cacheRoot],
          distributionPaths: [distributionPath],
        })
        sourcePack = isSharedCache ? 'cached' : 'provided'
        if (isSharedCache && (distribution.dirty === true || distribution.reproducible !== true)) {
          diagnostics.push(diagnostic('BROKEN', 'shared source pack is dirty or non-reproducible'))
        }
        const resolution = inspectSourceResolution(helperResult.helper, context, distribution)
        workspaceResolution = resolution.problems.length === 0 ? 'correct' : 'incorrect'
        addDiagnostics(diagnostics, resolution.problems)
        if (resolution.count === 0) diagnostics.push(diagnostic('BROKEN', 'source distribution contains no packages'))
      } catch (error) {
        workspaceResolution = 'incorrect'
        const message = error instanceof Error ? error.message : String(error)
        diagnostics.push(diagnostic(existsSync(distributionPath ?? '') ? 'BROKEN' : 'MISSING', message))
      }
    }
  } else {
    const resolution = inspectNpmResolution(context)
    workspaceResolution = resolution.problems.length === 0 ? 'correct' : 'incorrect'
    npmVersions = resolution.versions
    addDiagnostics(diagnostics, resolution.problems)
  }

  const stateResult = readState(context.statePath)
  if (stateResult.error !== undefined) diagnostics.push(diagnostic('BROKEN', `${DEV_STATE_FILE}: ${stateResult.error}`))
  const stateDiagnostic = stateMatches(context, stateResult.value, distributionPath ?? context.sourcePack, pnpm.value)
  if (stateDiagnostic !== undefined) diagnostics.push(stateDiagnostic)

  const status = bestStatus(diagnostics)
  return {
    status,
    pnpm: pnpm.value,
    nodeModules: modules === undefined ? 'present' : 'missing/broken',
    workspaceResolution,
    environment: environment.message,
    warnings,
    state: stateResult.error ?? (stateResult.value === undefined ? 'missing' : stateDiagnostic?.message ?? 'matches'),
    sourcePack,
    npmVersions,
    diagnostics,
  }
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
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  return values
}

export const _test = {
  bestStatus,
  sourceEnvironmentStatus,
  inspectSourceResolution,
  stateMatches,
}

export async function diagnoseDevelopmentEnvironment(options = {}) {
  const context = resolveDshDevContext(options)
  const details = await inspect(context)
  return { context, details }
}

async function main() {
  const values = parseCli()
  const result = await diagnoseDevelopmentEnvironment({
    root: values.root,
    mode: values.mode,
    config: values.config,
    distribution: values.distribution,
  })
  if (values.json === true) {
    console.log(JSON.stringify({
      status: result.details.status,
      mode: result.context.mode,
      source: result.context.source,
      sourcePack: result.context.sourcePack,
      workspaceResolution: result.details.workspaceResolution,
      environment: result.details.environment,
      warnings: result.details.warnings,
      diagnostics: result.details.diagnostics,
    }, null, 2))
  } else {
    printHuman(result.context, result.details)
  }
  if (result.details.status !== 'READY') process.exitCode = 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch(error => {
    console.error(`DSH_DEV_DOCTOR_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
