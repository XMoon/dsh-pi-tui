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

import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
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

/** Create a disposable build directory beside the final output. */
function sourcePackStaging(parent) {
  return mkdtempSync(join(parent, `.dsh-source-pack-${process.pid}-`))
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
    if (!auxiliaryInfo.isFile() || auxiliaryInfo.isSymbolicLink()) {
      fail(`official DSH auxiliary output must be a regular file: ${auxiliaryPath}`)
    }
    rmSync(auxiliaryPath)
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
  const staging = sourcePackStaging(dirname(output))
  const stageOutput = join(staging, 'output')
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

    renameSync(stageOutput, output)
    printDshProvenance(distribution)
    console.log(`DSH source distribution written to ${output}`)
    return output
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
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
