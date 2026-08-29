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

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
 * Validate an output path before the packer removes/recreates it. Existing
 * directories are replaceable only when they are clearly prior source-pack
 * outputs; arbitrary checkout or filesystem directories are never destroyed.
 */
export function validateSourcePackOutput(outputPath, dshDir) {
  const output = resolve(outputPath)
  const source = resolve(dshDir)
  const canonicalOutput = canonicalPath(output)
  const canonicalSource = canonicalPath(source)
  const canonicalTui = canonicalPath(PACKAGE_ROOT)
  if (pathInside(canonicalOutput, canonicalSource)) fail(`source pack output must not be inside the DSH checkout: ${output}`)
  if (pathInside(canonicalOutput, canonicalTui)) fail(`source pack output must not be inside the TUI checkout: ${output}`)
  const parent = dirname(output)
  if (parent === output || dirname(parent) === parent) {
    fail(`source pack output must be a dedicated child directory: ${output}`)
  }
  if (!existsSync(output)) return output

  const info = lstatSync(output)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`source pack output must be a real directory: ${output}`)
  const entries = readdirSync(output)
  if (entries.length === 0) fail(`source pack output already exists; remove it before packing: ${output}`)
  if (!entries.includes(SOURCE_MANIFEST_NAME)) {
    fail(`refusing to use non-source-pack directory: ${output}`)
  }
  const allowed = entries.every(entry => {
    if (!(entry === SOURCE_MANIFEST_NAME || /^[A-Za-z0-9@._+-]+\.tgz$/u.test(entry))) return false
    return lstatSync(join(output, entry)).isFile()
  })
  if (!allowed) fail(`refusing to use a source-pack directory with unexpected files: ${output}`)
  try {
    loadDshDistributionManifest(output, {
      packageJson: {},
      requiredPackages: [DSH_CLI_PACKAGE],
    })
  } catch (error) {
    fail(`refusing to use an invalid source-pack directory: ${output}${error instanceof Error ? `: ${error.message}` : ''}`)
  }
  fail(`source pack output already exists; remove it before packing: ${output}`)
}

/** Claim an absent output directory atomically before any packer writes to it. */
function claimSourcePackOutput(output) {
  mkdirSync(dirname(output), { recursive: true })
  mkdirSync(output)
  const info = lstatSync(output)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`source pack output claim is not a real directory: ${output}`)
  return { path: output, dev: info.dev, ino: info.ino }
}

/** Remove only the directory inode this process atomically claimed. */
function removeClaimedSourcePackOutput(owner) {
  let info
  try {
    info = lstatSync(owner.path)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== owner.dev || info.ino !== owner.ino) return false
  rmSync(owner.path, { recursive: true, force: true })
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

    await runOfficial(identity.directory, ['install', '--frozen-lockfile'], OFFICIAL_TIMEOUTS.install)
    // Local source checkouts can retain ignored tsbuildinfo/lib state from an
    // earlier build. Clean only generated repository-owned outputs so the same
    // official build is reproducible without requiring a pristine local tree.
    await runOfficial(identity.directory, ['clean'], OFFICIAL_TIMEOUTS.clean)
    await runOfficial(identity.directory, ['build:official'], OFFICIAL_TIMEOUTS.build)
    await runOfficial(identity.directory, ['release:pack', '--family', 'dsh', '--out', output], OFFICIAL_TIMEOUTS.pack)

    // The official packer writes publish-order.txt for registry publishing. Source
    // mode only needs immutable tarballs plus its generated distribution manifest;
    // discard every other top-level output before the artifact is uploaded.
    for (const entry of readdirSync(output)) {
      if (!entry.endsWith('.tgz')) rmSync(join(output, entry), { recursive: true, force: true })
    }

    const packageEntries = packageMapFromTarballs(output, effective.expectedVersion)
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
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => [name, entry.fileName])),
    }
    writeFileSync(join(output, 'dsh-source-distribution.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const distribution = validateSourceDistribution({ manifest, directory: output })
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
