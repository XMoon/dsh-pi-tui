#!/usr/bin/env node
/**
 * Shared acquisition and integrity boundary for DeepSeek Harness compatibility.
 *
 * The published package contract is always expressed in package.json. Source
 * mode is a test-only adapter: it consumes the official DSH release tarball
 * family and writes overrides in an ephemeral install workspace.
 *
 * @module dsh-distribution
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = resolve(SCRIPT_DIR, '../..')
export const DEFAULT_SOURCE_CONFIG = join(PACKAGE_ROOT, 'test', 'compat', 'dsh-source.json')
export const SOURCE_MANIFEST_NAME = 'dsh-source-distribution.json'
export const DSH_ROOT_PACKAGE = '@deepseek-ai/dsh-root'
export const DSH_CLI_PACKAGE = '@deepseek-ai/dsh'
export const DSH_AGENT_PACKAGE = '@deepseek-ai/dsh-agent'
export const DSH_REPOSITORY = 'deepseek-ai/deepseek-harness'
const FULL_SHA = /^[0-9a-f]{40}$/iu
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const SOURCE_OVERRIDE_START = '# BEGIN DSH SOURCE OVERRIDES'
const SOURCE_OVERRIDE_END = '# END DSH SOURCE OVERRIDES'
const BINARY_ABSOLUTE_PATH_PREFIXES = [
  '/home/',
  '/Users/',
  '/runner/_work/',
  '/tmp/dsh-',
  '\\tmp\\dsh-',
]

export class DshDistributionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DshDistributionError'
  }
}

function fail(message) {
  throw new DshDistributionError(message)
}

function objectValue(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}

function stringValue(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`)
  return value
}

function isRegularUnlinkedFile(info) {
  return info?.isFile() === true && info.isSymbolicLink() === false && info.nlink === 1
}

function readJson(path, label) {
  try {
    return objectValue(JSON.parse(readFileSync(path, 'utf8')), label)
  } catch (error) {
    if (error instanceof DshDistributionError) throw error
    fail(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertVersion(version, label) {
  if (!VERSION.test(version)) fail(`${label} must be an exact SemVer version, got ${JSON.stringify(version)}`)
  return version
}

function assertSha(ref, label) {
  if (!FULL_SHA.test(ref)) fail(`${label} must be a full 40-character commit SHA, got ${JSON.stringify(ref)}`)
  return ref.toLowerCase()
}

function runGit(dshDir, args) {
  const result = spawnSync('git', ['-C', dshDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) fail(`git ${args.join(' ')} failed${commandText(result) ? `:\n${commandText(result)}` : ''}`)
  return (result.stdout ?? '').trim()
}

/** Normalize the GitHub remote spellings accepted for the pinned source. */
export function normalizeDshRepositoryRemote(remote) {
  return stringValue(remote, 'DSH source repository remote').trim()
    .replace(/^git@github\.com:/u, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//u, 'https://github.com/')
    .replace(/\/+$/u, '')
    .replace(/\.git$/u, '')
    .replace(/\/+$/u, '')
}

export function expectedDshRepositoryRemote(repository) {
  return `https://github.com/${stringValue(repository, 'DSH source repository')}`
}

/**
 * Verify that a checkout is the exact configured DSH source identity. CI is
 * strict about a clean tree; local verification may continue with a visible
 * reproducibility warning so harmless local build files do not block iteration.
 */
export function validateSourceIdentity(dshDir, config, options = {}) {
  const directory = resolve(dshDir)
  if (!existsSync(directory) || !statSync(directory).isDirectory()) fail(`DSH source checkout is missing: ${directory}`)
  const expectedRepository = stringValue(config.repository, 'DSH source repository')
  if (expectedRepository !== DSH_REPOSITORY) fail(`DSH source repository must be ${DSH_REPOSITORY}`)
  const origin = normalizeDshRepositoryRemote(runGit(directory, ['remote', 'get-url', 'origin']))
  if (origin !== expectedDshRepositoryRemote(expectedRepository)) {
    fail(`DSH source repository remote mismatch: expected ${expectedDshRepositoryRemote(expectedRepository)}, got ${origin}`)
  }
  const expectedRef = assertSha(stringValue(config.ref, 'DSH source ref'), 'DSH source ref')
  const expectedVersion = assertVersion(stringValue(config.expectedVersion, 'DSH expected version'), 'DSH expected version')
  const head = assertSha(runGit(directory, ['rev-parse', 'HEAD']), 'DSH checkout HEAD')
  if (head !== expectedRef) fail(`DSH source SHA mismatch: configured ${expectedRef}, checkout ${head}`)
  const root = readJson(join(directory, 'package.json'), 'DSH root package.json')
  if (root.name !== DSH_ROOT_PACKAGE) fail(`DSH root package name mismatch: expected ${DSH_ROOT_PACKAGE}, got ${root.name ?? '(missing)'}`)
  if (root.version !== expectedVersion) fail(`DSH root version mismatch: expected ${expectedVersion}, got ${root.version ?? '(missing)'}`)
  const cli = readJson(join(directory, 'apps', 'cli', 'package.json'), 'DSH CLI package.json')
  if (cli.name !== DSH_CLI_PACKAGE) fail(`DSH CLI package name mismatch: expected ${DSH_CLI_PACKAGE}, got ${cli.name ?? '(missing)'}`)
  if (cli.version !== expectedVersion) fail(`DSH CLI version mismatch: expected ${expectedVersion}, got ${cli.version ?? '(missing)'}`)
  const dirty = runGit(directory, ['status', '--porcelain']).length > 0
  const ci = options.ci === true || process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
  if (dirty && ci && options.allowDirty !== true) fail('DSH source checkout is dirty in CI; use a clean pinned checkout')
  return { directory, head, expectedVersion, dirty, reproducible: !dirty }
}

function isDshFamilyPackage(name) {
  return name === DSH_CLI_PACKAGE || name.startsWith('@deepseek-ai/dsh-')
}

/** Return whether a dependency name belongs to the published DSH family. */
export function isDshPackage(name) {
  return isDshFamilyPackage(name)
}

/** Validate a source pin object, including command-line overrides. */
export function validateDshSourceConfig(config, path = '<inline>') {
  objectValue(config, 'DSH source config')
  if (config.schemaVersion !== 1) fail('DSH source config schemaVersion must be 1')
  const repository = stringValue(config.repository, 'DSH source config repository')
  if (repository !== DSH_REPOSITORY) fail(`DSH source config repository must be ${DSH_REPOSITORY}`)
  const ref = assertSha(stringValue(config.ref, 'DSH source config ref'), 'DSH source config ref')
  const expectedVersion = assertVersion(
    stringValue(config.expectedVersion, 'DSH source config expectedVersion'),
    'DSH source config expectedVersion',
  )
  return { schemaVersion: 1, repository, ref, expectedVersion, path: resolve(path) }
}

/** Return the exact registry DSH version declared by this checkout.
 * The lockfile is then authoritative for the frozen install; this exact
 * package declaration selects the npm lane without reusing the unpublished
 * Source Mode pin. */
export function npmDshVersion(packageJson = readJson(join(PACKAGE_ROOT, 'package.json'), 'package.json')) {
  const devDependencies = objectValue(packageJson.devDependencies ?? {}, 'package.json devDependencies')
  return assertVersion(
    stringValue(devDependencies[DSH_AGENT_PACKAGE], `package.json devDependencies.${DSH_AGENT_PACKAGE}`),
    `package.json devDependencies.${DSH_AGENT_PACKAGE}`,
  )
}

/**
 * Load and validate the tracked source pin.
 * @param {string} [path] - source pin JSON path.
 */
export function loadDshSourceConfig(path = DEFAULT_SOURCE_CONFIG) {
  return validateDshSourceConfig(readJson(resolve(path), 'DSH source config'), path)
}

/**
 * Collect every DSH package the TUI install contract names. The CLI is always
 * included because source mode must install the complete family, not merely the
 * subset currently imported by a unit test.
 */
export function requiredDshPackages(packageJson = readJson(join(PACKAGE_ROOT, 'package.json'), 'package.json')) {
  const names = new Set([DSH_CLI_PACKAGE])
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const name of Object.keys(objectValue(packageJson[section] ?? {}, `package.json ${section}`))) {
      if (isDshFamilyPackage(name)) names.add(name)
    }
  }
  return [...names].sort()
}

/**
 * Return the reachable DSH package closure and its required non-DSH peers.
 * Direct local specs are needed for pnpm peer resolution; regular dependency
 * edges are also traversed so their peer closure is local. Non-DSH peers stay
 * registry-backed, but must be materialized explicitly when auto-install-peers
 * is disabled for source mode.
 */
function sourceInstallPlan(distribution, packageJson) {
  if (distribution?.kind !== 'source-pack') return { localPackages: [], externalPeers: {} }
  const pending = requiredDshPackages(packageJson)
  const seen = new Set()
  const externalPeers = new Map()
  while (pending.length > 0) {
    const name = pending.pop()
    if (name === undefined || seen.has(name)) continue
    const entry = distribution.packages.get(name)
    if (entry === undefined) fail(`DSH source distribution is missing reachable package ${name}`)
    seen.add(name)
    const metadata = readPackedPackageJson(entry.path)
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependencyName of Object.keys(objectValue(metadata[section] ?? {}, `${name} ${section}`))) {
        if (!isDshFamilyPackage(dependencyName)) continue
        if (!distribution.packages.has(dependencyName)) {
          fail(`${name} references DSH package ${dependencyName}, but the source family does not contain it`)
        }
        pending.push(dependencyName)
      }
    }
    for (const [peerName, peerRange] of Object.entries(objectValue(metadata.peerDependencies ?? {}, `${name} peerDependencies`))) {
      if (isDshFamilyPackage(peerName) || metadata.peerDependenciesMeta?.[peerName]?.optional === true) continue
      const normalizedRange = stringValue(peerRange, `${name} peerDependencies.${peerName}`)
      const priorRange = externalPeers.get(peerName)
      if (priorRange !== undefined && priorRange !== normalizedRange) {
        fail(`DSH source packages require conflicting registry peer ranges for ${peerName}: ${priorRange} and ${normalizedRange}`)
      }
      externalPeers.set(peerName, normalizedRange)
    }
  }
  return {
    localPackages: [...seen].sort(),
    externalPeers: Object.fromEntries([...externalPeers].sort(([left], [right]) => left.localeCompare(right))),
  }
}

export function sourceInstallPackages(distribution, packageJson) {
  return sourceInstallPlan(distribution, packageJson).localPackages
}

/** Return non-DSH peer dependencies needed by the reachable source closure. */
export function sourceExternalPeerDependencies(distribution, packageJson) {
  return sourceInstallPlan(distribution, packageJson).externalPeers
}

function commandText(result) {
  return [result?.stdout, result?.stderr, result?.error?.message]
    .filter(value => typeof value === 'string' && value.length > 0)
    .join('\n')
    .trim()
}

function runTar(args) {
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) fail(`tar ${args.join(' ')} failed${commandText(result) ? `:\n${commandText(result)}` : ''}`)
  return result.stdout ?? ''
}

function runTarBuffer(args) {
  const result = spawnSync('tar', args, {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) fail(`tar ${args.join(' ')} failed${commandText(result) ? `:\n${commandText(result)}` : ''}`)
  return result.stdout ?? Buffer.alloc(0)
}

/** Read package/package.json from one official tarball. */
export function readPackedPackageJson(tarball) {
  const info = existsSync(tarball) ? lstatSync(tarball) : undefined
  if (!isRegularUnlinkedFile(info)) fail(`${tarball} must be a regular file with exactly one link`)
  try {
    return objectValue(JSON.parse(runTar(['-xOf', tarball, 'package/package.json'])), `${tarball} package.json`)
  } catch (error) {
    if (error instanceof DshDistributionError) throw error
    fail(`${tarball} contains invalid package/package.json: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function tgzFiles(directory) {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) fail(`DSH distribution directory is missing: ${directory}`)
  return readdirSync(directory)
    .filter(name => name.endsWith('.tgz'))
    .map(name => join(directory, name))
    .filter(path => isRegularUnlinkedFile(lstatSync(path)))
    .sort()
}

function safeDistributionFile(directory, fileName) {
  if (typeof fileName !== 'string' || fileName === '' || isAbsolute(fileName)
    || fileName !== fileName.split(/[\\/]/u).at(-1)
    || !fileName.endsWith('.tgz')) {
    fail(`DSH distribution artifact must be a single relative .tgz filename: ${JSON.stringify(fileName)}`)
  }
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) fail(`DSH distribution directory is missing: ${directory}`)
  const root = realpathSync(directory)
  const path = resolve(directory, fileName)
  const rel = relative(root, path)
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    fail(`DSH distribution artifact escapes its directory: ${fileName}`)
  }
  const info = existsSync(path) ? lstatSync(path) : undefined
  if (!isRegularUnlinkedFile(info)) {
    fail(`DSH distribution artifact must be a regular file with exactly one link: ${path}`)
  }
  const canonical = realpathSync(path)
  const canonicalRel = relative(root, canonical)
  if (canonicalRel === '' || canonicalRel.startsWith(`..${sep}`) || canonicalRel === '..' || isAbsolute(canonicalRel)) {
    fail(`DSH distribution artifact escapes its directory: ${fileName}`)
  }
  return canonical
}

export function packageMapFromTarballs(directory, expectedVersion, options = {}) {
  const tarballs = tgzFiles(directory)
  if (tarballs.length === 0) fail(`DSH release pack produced no .tgz artifacts in ${directory}`)
  const packages = new Map()
  const usedFiles = new Set()
  for (const tarball of tarballs) {
    const metadata = assertNoSourceLeak(tarball, options)
    const name = stringValue(metadata.name, `${tarball} package.name`)
    const version = assertVersion(stringValue(metadata.version, `${tarball} package.version`), `${tarball} package.version`)
    if (!isDshFamilyPackage(name)) fail(`DSH release pack contains non-DSH package ${name} in ${tarball}`)
    if (version !== expectedVersion) fail(`${name} has version ${version}; expected ${expectedVersion}`)
    if (packages.has(name)) fail(`DSH release pack contains duplicate package name ${name}`)
    const fileName = tarball.slice(directory.length + 1)
    if (usedFiles.has(fileName)) fail(`DSH release pack contains duplicate artifact filename ${fileName}`)
    usedFiles.add(fileName)
    packages.set(name, { fileName, path: resolve(tarball), version })
  }
  if (!packages.has(DSH_CLI_PACKAGE)) fail(`DSH release pack is missing required CLI package ${DSH_CLI_PACKAGE}`)
  return packages
}

function normalisePackageEntries(manifest, directory, options = {}) {
  const packageEntries = objectValue(manifest.packages, 'DSH distribution packages')
  const packages = new Map()
  const seenFiles = new Set()
  for (const [name, fileName] of Object.entries(packageEntries)) {
    if (!isDshFamilyPackage(name)) fail(`DSH distribution contains a non-DSH package key: ${name}`)
    const path = safeDistributionFile(directory, fileName)
    if (seenFiles.has(path)) fail(`DSH distribution maps more than one package to ${path}`)
    seenFiles.add(path)
    const metadata = assertNoSourceLeak(path, options)
    if (metadata.name !== name) fail(`DSH distribution name mismatch: manifest ${name}, tarball ${metadata.name}`)
    if (metadata.version !== manifest.version) fail(`${name} has version ${metadata.version}; expected ${manifest.version}`)
    packages.set(name, { fileName, path, version: metadata.version })
  }
  if (!packages.has(DSH_CLI_PACKAGE)) fail(`DSH distribution is missing required CLI package ${DSH_CLI_PACKAGE}`)
  if (packages.size === 0) fail('DSH distribution package map must not be empty')
  return packages
}

function sourceManifestValue(manifest, label) {
  const value = stringValue(manifest[label], `DSH distribution ${label}`)
  return value
}

/**
 * Validate a source distribution manifest and all tarball metadata. This is
 * intentionally usable both after a build and after downloading a CI artifact.
 */
export function validateSourceDistribution(input, options = {}) {
  objectValue(input, 'DSH distribution input')
  const directory = resolve(options.directory ?? input.directory ?? '.')
  const manifest = input.manifest ?? input
  objectValue(manifest, 'DSH distribution manifest')
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) fail(`DSH distribution directory is missing: ${directory}`)
  const unexpectedFiles = readdirSync(directory).filter(name => {
    const path = join(directory, name)
    const info = lstatSync(path)
    const allowedName = name === SOURCE_MANIFEST_NAME || name.endsWith('.tgz')
    return !allowedName || !isRegularUnlinkedFile(info)
  })
  if (unexpectedFiles.length > 0) fail(`DSH distribution contains unexpected top-level file(s): ${unexpectedFiles.join(', ')}`)
  if (manifest.schemaVersion !== 1) fail('DSH distribution schemaVersion must be 1')
  if (manifest.mode !== 'source-pack') fail('DSH distribution mode must be source-pack')
  const repository = sourceManifestValue(manifest, 'repository')
  const sourceRef = assertSha(sourceManifestValue(manifest, 'sourceRef'), 'DSH distribution sourceRef')
  const sourceSha = assertSha(sourceManifestValue(manifest, 'sourceSha'), 'DSH distribution sourceSha')
  if (sourceRef !== sourceSha) fail('DSH distribution sourceRef and sourceSha must match')
  const version = assertVersion(sourceManifestValue(manifest, 'version'), 'DSH distribution version')
  if (options.expectedRepository !== undefined && repository !== options.expectedRepository) {
    fail(`DSH distribution repository mismatch: expected ${options.expectedRepository}, got ${repository}`)
  }
  if (options.expectedRef !== undefined && sourceSha !== assertSha(options.expectedRef, 'expected DSH source ref')) {
    fail(`DSH distribution source SHA mismatch: expected ${options.expectedRef}, got ${sourceSha}`)
  }
  if (options.expectedVersion !== undefined && version !== assertVersion(options.expectedVersion, 'expected DSH version')) {
    fail(`DSH distribution version mismatch: expected ${options.expectedVersion}, got ${version}`)
  }
  if (typeof manifest.dirty !== 'boolean' || typeof manifest.reproducible !== 'boolean') {
    fail('DSH distribution must positively attest dirty and reproducible booleans')
  }
  if (manifest.dirty !== false || manifest.reproducible !== true) {
    // Dirty distributions are valid only as explicitly provided local debug
    // inputs; callers must opt out of the shared SHA cache separately.
    if (options.allowDirty !== true) fail('DSH distribution is dirty or non-reproducible')
  }
  const packages = normalisePackageEntries({ ...manifest, version }, directory, {
    ...options,
    // Distribution validation checks dependency metadata; the dedicated leak
    // gate opts into archive-byte scanning for the final TUI artifact.
    scanArchive: options.scanArchive ?? false,
  })
  const listedPaths = new Set([...packages.values()].map(entry => resolve(entry.path)))
  const unlistedTarballs = tgzFiles(directory).filter(path => !listedPaths.has(resolve(path)))
  if (unlistedTarballs.length > 0) fail(`DSH distribution contains unlisted tarball(s): ${unlistedTarballs.join(', ')}`)
  const packageJson = options.packageJson === undefined
    ? readJson(join(PACKAGE_ROOT, 'package.json'), 'package.json')
    : typeof options.packageJson === 'string'
      ? readJson(resolve(options.packageJson), 'package.json')
      : objectValue(options.packageJson, 'TUI package.json')
  const required = options.requiredPackages ?? requiredDshPackages(packageJson)
  const missing = required.filter(name => !packages.has(name))
  if (missing.length > 0) fail(`DSH distribution is missing TUI-required package(s): ${missing.join(', ')}`)
  return {
    kind: 'source-pack',
    schemaVersion: 1,
    mode: 'source-pack',
    repository,
    sourceRef,
    sourceSha,
    version,
    directory,
    manifest,
    packages,
    dirty: manifest.dirty === true,
    reproducible: manifest.reproducible !== false,
  }
}

/** Load a source distribution directory or its JSON manifest. */
export function loadDshDistributionManifest(path, options = {}) {
  const resolved = resolve(path)
  const resolvedInfo = existsSync(resolved) ? lstatSync(resolved) : undefined
  const directory = resolvedInfo?.isDirectory() === true ? resolved : dirname(resolved)
  const manifestPath = resolvedInfo?.isDirectory() === true
    ? join(resolved, SOURCE_MANIFEST_NAME)
    : resolved
  if (!existsSync(manifestPath)) fail(`DSH distribution manifest is missing: ${manifestPath}`)
  const manifestInfo = lstatSync(manifestPath)
  if (!isRegularUnlinkedFile(manifestInfo)) {
    fail(`DSH distribution manifest must be a regular file with exactly one link: ${manifestPath}`)
  }
  const manifest = readJson(manifestPath, 'DSH distribution manifest')
  return validateSourceDistribution({ manifest, directory }, options)
}

/** Construct the registry-backed representation used by npm mode. */
export function npmDshDistribution(version) {
  return { kind: 'npm', version: assertVersion(stringValue(version, 'npm DSH version'), 'npm DSH version') }
}

/** Resolve a mode/configuration into one shared distribution representation. */
export function loadDshDistribution({
  mode = process.env.DSH_MODE ?? 'npm',
  manifest,
  version,
  packageJson,
  sourceConfig,
  allowDirty = false,
  sourcePaths,
  tempRoots,
  distributionPaths,
} = {}) {
  if (mode === 'source') {
    if (manifest === undefined) fail('source mode requires a DSH distribution manifest')
    const distribution = loadDshDistributionManifest(manifest, {
      packageJson,
      sourceConfig,
      allowDirty,
      sourcePaths,
      tempRoots,
      distributionPaths,
    })
    if (sourceConfig !== undefined) {
      const config = typeof sourceConfig === 'string' ? loadDshSourceConfig(sourceConfig) : sourceConfig
      if (distribution.repository !== config.repository || distribution.sourceSha !== config.ref || distribution.version !== config.expectedVersion) {
        fail('DSH source distribution does not match the configured source pin')
      }
    }
    return distribution
  }
  if (mode !== 'npm') fail(`unsupported DSH distribution mode ${mode}; expected source or npm`)
  return npmDshDistribution(version ?? process.env.DSH_VERSION ?? '0.1.2-alpha.2')
}

/** Return temporary pnpm override values for every packed DSH package. */
export function buildDshOverrides(distribution) {
  if (distribution?.kind !== 'source-pack') return {}
  const overrides = {}
  for (const [name, packageEntry] of distribution.packages) {
    const path = resolve(packageEntry.path)
    if (!existsSync(path)) fail(`DSH source override target is missing for ${name}: ${path}`)
    overrides[name] = `file:${path}`
  }
  return overrides
}

function overrideYaml(overrides) {
  const lines = [SOURCE_OVERRIDE_START, 'overrides:']
  for (const [name, value] of Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(value)}`)
  }
  lines.push(SOURCE_OVERRIDE_END)
  return lines.join('\n')
}

/** Write source-only overrides into an ephemeral pnpm workspace file. */
export function writeDshWorkspaceOverrides(workspaceDir, distribution, fileName = 'pnpm-workspace.yaml') {
  const path = join(resolve(workspaceDir), fileName)
  const existed = existsSync(path)
  const current = existed ? readFileSync(path, 'utf8') : 'packages:\n- packages/*\n'
  const start = current.indexOf(SOURCE_OVERRIDE_START)
  let base = current
  if (start >= 0) {
    const end = current.indexOf(SOURCE_OVERRIDE_END, start)
    if (end < 0) fail(`${path} has an unterminated DSH source override block`)
    base = `${current.slice(0, start).trimEnd()}\n`
    const after = current.slice(end + SOURCE_OVERRIDE_END.length).replace(/^\s*\n/u, '')
    base += after
  }
  const overrides = distribution?.kind === 'source-pack' ? buildDshOverrides(distribution) : {}
  try {
    if (distribution?.kind === 'source-pack') {
      if (Object.keys(overrides).length === 0) fail('source DSH distribution produced no overrides')
      const next = `${base.trimEnd()}\n${overrideYaml(overrides)}\n`
      writeFileSync(path, next, 'utf8')
    } else {
      writeFileSync(path, base, 'utf8')
    }
  } catch (error) {
    try {
      if (existed) writeFileSync(path, current, 'utf8')
      else rmSync(path, { force: true })
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `failed to restore ${path} after a workspace override write error`)
    }
    throw error
  }
  return {
    path,
    existed,
    backup: current,
    overrides,
  }
}

function packageSpec(distribution, name) {
  if (distribution?.kind === 'source-pack') {
    const entry = distribution.packages.get(name)
    if (entry === undefined) fail(`DSH source distribution has no package ${name}`)
    return `file:${resolve(entry.path)}`
  }
  if (distribution?.kind === 'npm') return distribution.version
  fail('invalid DSH distribution representation')
}

/**
 * Prepare an isolated DSH install. For a TUI workspace this writes only a
 * temporary workspace override file; for a small harness package it can also
 * add the CLI dependency to that temporary package.json.
 */
export function prepareDshInstall(distribution, targetDir, options = {}) {
  const directory = resolve(targetDir)
  if (!existsSync(directory)) fail(`DSH install target is missing: ${directory}`)
  const overrides = buildDshOverrides(distribution)
  const packagePath = options.packageJsonPath ?? join(directory, 'package.json')
  const materializeSourceDependencies = distribution?.kind === 'source-pack' && options.materializeSourceDependencies === true
  let workspaceFile
  let packageJsonBackup
  try {
    workspaceFile = options.workspaceFile === false
      ? undefined
      : writeDshWorkspaceOverrides(directory, distribution, options.workspaceFile ?? 'pnpm-workspace.yaml')
    if (options.addCliDependency === true || materializeSourceDependencies || options.stripPackageManager === true) {
      packageJsonBackup = readFileSync(packagePath, 'utf8')
      const pkg = readJson(packagePath, 'temporary install package.json')
      const dependencies = objectValue(pkg.dependencies ?? {}, 'temporary install dependencies')
      const next = {
        ...pkg,
        dependencies: options.addCliDependency === true
          ? { ...dependencies, [DSH_CLI_PACKAGE]: packageSpec(distribution, DSH_CLI_PACKAGE) }
          : dependencies,
      }
      if (options.stripPackageManager === true) delete next.packageManager
      if (materializeSourceDependencies) {
        const devDependencies = objectValue(pkg.devDependencies ?? {}, 'temporary install devDependencies')
        const installPlan = sourceInstallPlan(distribution, pkg)
        const localPackages = installPlan.localPackages
        const declaredExternalPeers = Object.fromEntries(Object.entries(pkg.peerDependencies ?? {})
          .filter(([name]) => !localPackages.includes(name) && pkg.peerDependenciesMeta?.[name]?.optional !== true))
        const declaredNames = new Set([
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.keys(pkg.optionalDependencies ?? {}),
          ...Object.keys(devDependencies),
          ...Object.keys(declaredExternalPeers),
        ])
        const discoveredExternalPeers = Object.fromEntries(Object.entries(installPlan.externalPeers)
          .filter(([name]) => !declaredNames.has(name)))
        next.devDependencies = {
          ...devDependencies,
          ...discoveredExternalPeers,
          ...declaredExternalPeers,
          ...Object.fromEntries(localPackages.map(name => [name, `file:${resolve(distribution.packages.get(name).path)}`])),
        }
      }
      writeFileSync(packagePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    }
  } catch (error) {
    try {
      restoreDshInstall({
        packagePath,
        packageJsonBackup,
        workspacePath: workspaceFile?.path,
        workspaceExisted: workspaceFile?.existed,
        workspaceBackup: workspaceFile?.backup,
      })
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `failed to restore temporary install metadata in ${directory}`)
    }
    throw error
  }
  return {
    targetDir: directory,
    packagePath,
    packageJsonBackup,
    workspacePath: workspaceFile?.path,
    workspaceExisted: workspaceFile?.existed,
    workspaceBackup: workspaceFile?.backup,
    overrides,
    cliSpec: packageSpec(distribution, DSH_CLI_PACKAGE),
    installArgs: distribution?.kind === 'source-pack'
      ? ['install', '--no-frozen-lockfile', '--lockfile=false', '--config.auto-install-peers=false', '--config.manage-package-manager-versions=false']
      : ['install', '--frozen-lockfile'],
  }
}

/** Restore temporary package/workspace metadata changed for the install. */
export function restoreDshInstall(prepared) {
  if (prepared === undefined || prepared === null) return
  const errors = []
  if (prepared.packageJsonBackup !== undefined) {
    try {
      writeFileSync(prepared.packagePath, prepared.packageJsonBackup, 'utf8')
    } catch (error) {
      errors.push(error)
    }
  }
  if (prepared.workspacePath !== undefined && prepared.workspaceBackup !== undefined) {
    try {
      if (prepared.workspaceExisted === true) writeFileSync(prepared.workspacePath, prepared.workspaceBackup, 'utf8')
      else rmSync(prepared.workspacePath, { force: true })
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, `failed to restore temporary install metadata in ${prepared.targetDir ?? prepared.packagePath}`)
}

function packageInstallPath(root, name) {
  return join(root, 'node_modules', ...name.split('/'))
}

function pathWithin(root, target) {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

/** Verify one DSH package resolves through pnpm's local file store. */
export function assertSourcePackageResolution(targetDir, distribution, name) {
  if (distribution?.kind !== 'source-pack') return
  const root = resolve(targetDir)
  const entry = distribution.packages.get(name)
  if (entry === undefined) fail(`source resolution check has no distribution entry for ${name}`)
  const installed = packageInstallPath(root, name)
  if (!existsSync(installed)) fail(`source resolution is missing installed package ${name}`)
  const installedInfo = lstatSync(installed)
  if (!installedInfo.isSymbolicLink()) fail(`source resolution for ${name} is not a pnpm package link`)
  const metadata = readJson(join(installed, 'package.json'), `${name} installed package.json`)
  if (metadata.name !== name || metadata.version !== distribution.version) {
    fail(`source resolution metadata mismatch for ${name}: ${metadata.name ?? '(missing)'}@${metadata.version ?? '(missing)'}`)
  }
  const actual = realpathSync(installed)
  const virtualStore = join(root, 'node_modules', '.pnpm')
  if (!existsSync(virtualStore) || !pathWithin(realpathSync(virtualStore), actual)) {
    fail(`source resolution for ${name} is outside pnpm's virtual store: ${actual}`)
  }
  const actualRelative = relative(realpathSync(virtualStore), actual).replaceAll('\\', '/').toLowerCase()
  const packageSuffix = `/node_modules/${name.toLowerCase()}`
  if (!actualRelative.endsWith(packageSuffix) || !actualRelative.includes('@file+')) {
    fail(`source resolution for ${name} did not come from a local file package: ${actual}`)
  }
  return { actual }
}

/** Verify every DSH package resolves to a local packed tarball after install. */
export function assertSourceResolution(targetDir, distribution, required = [...distribution.packages.keys()]) {
  if (distribution?.kind !== 'source-pack') return
  for (const name of required) assertSourcePackageResolution(targetDir, distribution, name)
  printDshProvenance(distribution)
}

/** Print the provenance tuple that distinguishes source commits sharing a version. */
export function printDshProvenance(distribution, output = console.log) {
  if (distribution?.kind === 'source-pack') {
    output(`DSH distribution : source-pack`)
    output(`DSH repository   : ${distribution.repository}`)
    output(`DSH source SHA   : ${distribution.sourceSha}`)
    output(`DSH version      : ${distribution.version}`)
    output(`package count    : ${String(distribution.packages.size)}`)
    if (distribution.dirty) output('WARNING: DIRTY DSH SOURCE TREE (reproducible = false)')
    return
  }
  output(`DSH distribution : npm`)
  output(`DSH version      : ${distribution?.version ?? '(unknown)'}`)
}

function sourceTokens(options) {
  const paths = [...(options.sourcePaths ?? []), ...(options.tempRoots ?? []), ...(options.distributionPaths ?? [])]
    .filter(value => typeof value === 'string' && value.length > 0)
    .map(value => resolve(value))
  return [...new Set(paths.flatMap(path => [path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')]))]
}

function scanDependencySpecs(value, location, forbidden) {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    if (/^(?:file|link|workspace):/iu.test(value) || forbidden.some(token => value.includes(token))) {
      fail(`source leak in ${location}: ${value}`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanDependencySpecs(entry, `${location}[${index}]`, forbidden))
    return
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) scanDependencySpecs(entry, `${location}.${key}`, forbidden)
  }
}

/**
 * Inspect a candidate tarball for source-only dependency specs or checkout
 * paths. Dependency manifests are authoritative; archive-content scanning is
 * bounded and checks concrete temporary/source path tokens without rejecting
 * ordinary prose identifiers.
 */
export function assertNoSourceLeak(tarball, options = {}) {
  const metadata = readPackedPackageJson(tarball)
  const forbidden = [
    ...sourceTokens(options),
    'RUNNER_TEMP',
    'dsh-source-pack',
    'deepseek-harness',
    '/tmp/dsh-',
    '\\tmp\\dsh-',
  ]
  scanDependencySpecs({
    dependencies: metadata.dependencies,
    optionalDependencies: metadata.optionalDependencies,
    peerDependencies: metadata.peerDependencies,
    devDependencies: metadata.devDependencies,
    bundledDependencies: metadata.bundledDependencies,
    pnpm: metadata.pnpm,
  }, `${tarball} package.json`, forbidden)

  if (options.scanArchive === false) return metadata

  const allEntries = runTar(['-tzf', tarball]).split(/\r?\n/u).filter(Boolean)
  // Explicit source roots are used to reject dependency specs, not ordinary
  // prose embedded in a package's documentation. Archive bytes still reject
  // concrete temporary/build-root tokens below.
  const textForbidden = [
    '/tmp/dsh-',
    '\\tmp\\dsh-',
  ]
  const archiveForbidden = [...new Set(forbidden.flatMap(token => {
    const normalized = token.replaceAll('\\', '/').toLowerCase()
    return [normalized, normalized.replace(/^\/+/, '')]
  }))]
  for (const entry of allEntries) {
    const normalized = entry.replaceAll('\\', '/')
    const normalizedLower = normalized.toLowerCase()
    const pathLeak = archiveForbidden.find(token => token !== '' && normalizedLower.includes(token))
    const parts = normalized.split('/')
    if (pathLeak !== undefined) {
      fail(`source leak in ${tarball}: forbidden archive path token ${pathLeak} in ${entry}`)
    }
    if (normalized.startsWith('/') || normalized.startsWith('\\\\') || /^[A-Za-z]:[\\/]/u.test(normalized) || parts.includes('..') || /\.tgz$/iu.test(normalized)) {
      fail(`source leak in ${tarball}: unsafe or nested archive entry ${entry}`)
    }
  }
  const linkEntries = runTar(['-tvzf', tarball, '--quoting-style=escape']).split(/\r?\n/u).filter(line => line.startsWith('l') || line.startsWith('h'))
  for (const line of linkEntries) {
    const arrow = line.indexOf(' -> ')
    const hardLink = line.indexOf(' link to ')
    const marker = arrow >= 0 ? arrow + 4 : hardLink >= 0 ? hardLink + 9 : -1
    if (marker < 0) continue
    const target = line.slice(marker).trim()
    const normalizedTarget = target.replaceAll('\\', '/').toLowerCase()
    const targetLeak = archiveForbidden.find(token => token !== '' && normalizedTarget.includes(token))
    const targetParts = normalizedTarget.split('/')
    if (targetLeak !== undefined
      || normalizedTarget.startsWith('/')
      || normalizedTarget.startsWith('\\')
      || /^[a-z]:[\\/]/u.test(normalizedTarget)
      || targetParts.includes('..')) {
      fail(`source leak in ${tarball}: unsafe archive link target ${target}`)
    }
  }
  // Documentation may legitimately mention an absolute path as prose. Scan
  // executable and metadata payloads for leaked build roots, while leaving
  // README/license text to the dependency and archive-path checks above.
  const entries = allEntries.filter(entry => {
    if (!entry.startsWith('package/') || entry.endsWith('/')) return false
    // README and license files are documentation, not executable payloads;
    // extensionless files under lib/dist are still commonly loaders/scripts.
    if (/(?:^|\/)(?:README|LICENSE)(?:\.[^/]*)?$/iu.test(entry)) return false
    return /\.(?:[cm]?js|[cm]?ts|json|map|ya?ml|sh|ps1|css|html)$/iu.test(entry)
      || /(?:^|\/)(?:lib|dist)\/[^/]+$/u.test(entry)
  })
  for (const entry of entries) {
    const bytes = runTarBuffer(['-xOf', tarball, entry])
    const byteMatch = textForbidden.find(token => bytes.includes(Buffer.from(token)))
    const binary = bytes.includes(0)
    const binaryPathMatch = binary
      ? BINARY_ABSOLUTE_PATH_PREFIXES.find(token => bytes.includes(Buffer.from(token)))
        ?? (/[A-Za-z]:[\\/]/u.exec(bytes.toString('latin1'))?.[0])
      : undefined
    const text = bytes.toString('utf8').replaceAll('\0', ' ')
    const match = byteMatch
      ?? binaryPathMatch
      ?? textForbidden.find(token => text.includes(token))
      ?? (/(?:^|[\s"'=])(?:\/home\/|\/Users\/|\/home\/runner\/work\/|[A-Za-z]:[\\/])/u.exec(text)?.[0])
    if (match !== undefined) fail(`source leak in ${tarball}:${entry}: ${match}`)
  }
  return metadata
}

/** Read a source manifest and return the normalized distribution representation. */
export function loadAndValidateSourceDistribution(path, options = {}) {
  return loadDshDistributionManifest(path, options)
}

export const _test = {
  FULL_SHA,
  VERSION,
  SOURCE_OVERRIDE_START,
  SOURCE_OVERRIDE_END,
  packageMapFromTarballs,
  normalisePackageEntries,
  sourceInstallPackages,
  scanDependencySpecs,
  packageInstallPath,
}
