#!/usr/bin/env node
/**
 * Prepare one TUI checkout for the selected DSH distribution. Source mode uses
 * an ephemeral pnpm override generated from the validated distribution manifest;
 * npm mode keeps the tracked lockfile and uses a frozen install.
 *
 * @module prepare-dsh-test-environment
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import {
  DEFAULT_SOURCE_CONFIG,
  loadDshDistribution,
  loadDshSourceConfig,
  npmDshDistribution,
  prepareDshInstall,
  restoreDshInstall,
  sourceInstallPackages,
  assertSourceResolution,
  validateDshSourceConfig,
  printDshProvenance,
} from './lib/dsh-distribution.mjs'
import { pnpmExecutable, runBounded } from './lib/process.mjs'

const PNPM_COMMAND = pnpmExecutable()
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PI2DSH_MANIFEST = join(ROOT, 'test', 'compat', 'pi2dsh.json')

function fail(message) {
  throw new Error(message)
}

function readTargetVersion() {
  const path = join(ROOT, 'test', 'compat', 'pi2dsh.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof manifest.dshVersion !== 'string' || manifest.dshVersion === '') fail(`${path} has no exact dshVersion`)
  return manifest.dshVersion
}

function parseCli() {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  const { values } = parseArgs({
    args,
    options: {
      mode: { type: 'string' },
      distribution: { type: 'string' },
      workspace: { type: 'string' },
      'dsh-version': { type: 'string' },
      ref: { type: 'string' },
      'expected-version': { type: 'string' },
      config: { type: 'string' },
      'allow-dirty': { type: 'boolean' },
    },
    allowPositionals: false,
  })
  return values
}

export function installEnvironment(mode, base = process.env, root = undefined) {
  const environment = {
    ...base,
    ...(root === undefined ? {} : { DSH_DEV_ROOT: resolve(root) }),
    DSH_DEV_MODE: mode,
    npm_config_minimum_release_age: '0',
    pnpm_config_minimum_release_age: '0',
  }
  if (mode === 'source') {
    environment.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = 'false'
    environment.pnpm_config_verify_deps_before_run = 'false'
    environment.PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS = 'false'
    return environment
  }
  delete environment.DSH_MODE
  delete environment.DSH_SOURCE_CONFIG
  delete environment.DSH_SOURCE_DISTRIBUTION
  delete environment.DSH_DEV_EPHEMERAL
  delete environment.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN
  delete environment.pnpm_config_verify_deps_before_run
  delete environment.TARBALL_SMOKE_SKIP_INSTALL
  return environment
}

export async function runInstall(workspace, args, { timeoutMs } = {}) {
  const mode = args.includes('--frozen-lockfile') ? 'npm' : 'source'
  const result = await runBounded(PNPM_COMMAND, args, {
    cwd: workspace,
    env: installEnvironment(mode, process.env, workspace),
    timeoutMs: timeoutMs ?? (mode === 'source' ? 20 * 60_000 : 10 * 60_000),
    label: `DSH ${mode} dependency install`,
  })
  if (result.status !== 0 || result.timedOut) {
    fail(`DSH ${mode} install failed${result.error ? `: ${result.error.message}` : ` with exit ${result.status ?? 'unknown'}`}`)
  }
}

export async function prepareDshTestEnvironment({
  mode = process.env.DSH_MODE ?? 'npm',
  distribution,
  workspace = ROOT,
  dshVersion = readTargetVersion(),
  config = DEFAULT_SOURCE_CONFIG,
  ref,
  expectedVersion,
  allowDirty = false,
} = {}) {
  const target = resolve(workspace)
  if (!existsSync(join(target, 'package.json'))) fail(`TUI workspace package.json is missing: ${target}`)
  const trackedSourceConfig = mode === 'source' ? loadDshSourceConfig(config) : undefined
  const sourceConfig = trackedSourceConfig === undefined ? undefined : validateDshSourceConfig({
    ...trackedSourceConfig,
    ref: ref ?? trackedSourceConfig.ref,
    expectedVersion: expectedVersion ?? trackedSourceConfig.expectedVersion,
  }, trackedSourceConfig.path)
  const selected = mode === 'source'
    ? loadDshDistribution({
      mode,
      manifest: distribution,
      packageJson: join(target, 'package.json'),
      sourceConfig,
      allowDirty,
    })
    : npmDshDistribution(dshVersion)
  const prepared = prepareDshInstall(selected, target, {
    materializeSourceDependencies: selected.kind === 'source-pack',
    stripPackageManager: true,
  })
  printDshProvenance(selected)
  try {
    await runInstall(target, [...prepared.installArgs, '--ignore-scripts', '--config.minimum-release-age=0', '--reporter=append-only'])
  } finally {
    restoreDshInstall(prepared)
  }
  if (selected.kind === 'source-pack') {
    const packageJson = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    assertSourceResolution(target, selected, sourceInstallPackages(selected, packageJson))
  }
  return { distribution: selected, prepared, workspace: target }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = parseCli()
    if (values.mode !== 'source' && values.mode !== 'npm') fail('--mode must be source or npm')
    if (values.mode === 'source' && typeof values.distribution !== 'string') fail('--distribution is required in source mode')
    await prepareDshTestEnvironment({
      mode: values.mode,
      distribution: values.distribution,
      workspace: values.workspace ?? ROOT,
      dshVersion: values['dsh-version'] ?? readTargetVersion(),
      config: values.config ?? DEFAULT_SOURCE_CONFIG,
      ref: values.ref,
      expectedVersion: values['expected-version'],
      allowDirty: values['allow-dirty'] === true,
    })
    console.log(`DSH test environment ready: ${values.mode}`)
  } catch (error) {
    console.error(`DSH_ENVIRONMENT_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
