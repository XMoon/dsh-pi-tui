#!/usr/bin/env node
/**
 * Local npm-mode driver. It validates the published/registry dependency lane
 * in an isolated copy, keeping the tracked lockfile frozen and exercising the
 * same TUI candidate packaging path used by releases.
 *
 * Usage: pnpm compat:dsh:npm [-- --dsh-version 0.1.2-alpha.1]
 *
 * @module dsh-npm-verify
 */

import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { pnpmExecutable, runBounded } from './lib/process.mjs'
import {
  DEFAULT_SOURCE_CONFIG,
  PACKAGE_ROOT,
  loadDshSourceConfig,
  npmDshDistribution,
  prepareDshInstall,
  restoreDshInstall,
  assertNoSourceLeak,
} from './lib/dsh-distribution.mjs'

const PNPM_COMMAND = pnpmExecutable()
const NPM_VERIFY_TIMEOUTS = {
  install: 20 * 60 * 1000,
  check: 30 * 60 * 1000,
}

function fail(message) {
  throw new Error(message)
}

const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org/'

/** Keep npm-mode checks on the public registry with no ambient user config. */
export function npmVerificationEnvironment(userConfigPath, base = process.env) {
  return {
    ...base,
    npm_config_registry: PUBLIC_NPM_REGISTRY,
    NPM_CONFIG_REGISTRY: PUBLIC_NPM_REGISTRY,
    npm_config_userconfig: userConfigPath,
    NPM_CONFIG_USERCONFIG: userConfigPath,
    npm_config_minimum_release_age: '0',
    pnpm_config_minimum_release_age: '0',
  }
}

function parseCli() {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  const { values } = parseArgs({
    args,
    options: {
      'dsh-version': { type: 'string' },
      config: { type: 'string' },
      keep: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  return values
}

async function run(command, args, cwd, label, environment = process.env, timeoutMs = NPM_VERIFY_TIMEOUTS.check) {
  console.log(`DSH npm verify: ${label}`)
  const result = await runBounded(command, args, {
    cwd,
    env: { ...environment, npm_config_minimum_release_age: '0', pnpm_config_minimum_release_age: '0' },
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

async function main() {
  const values = parseCli()
  const config = loadDshSourceConfig(values.config ?? DEFAULT_SOURCE_CONFIG)
  const distribution = npmDshDistribution(values['dsh-version'] ?? config.expectedVersion)
  const root = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-npm-'))
  const workspace = join(root, 'workspace')
  const npmConfigPath = join(root, 'npmrc')
  const npmEnvironment = npmVerificationEnvironment(npmConfigPath)
  try {
    writeFileSync(npmConfigPath, `registry=${PUBLIC_NPM_REGISTRY}\n`, 'utf8')
    copyRepository(workspace)
    const prepared = prepareDshInstall(distribution, workspace, { stripPackageManager: true })
    try {
      await run(PNPM_COMMAND, [...prepared.installArgs, '--ignore-scripts', '--config.minimum-release-age=0', '--reporter=append-only'], workspace, 'frozen npm dependency install', npmEnvironment, NPM_VERIFY_TIMEOUTS.install)
    } finally {
      restoreDshInstall(prepared)
    }
    for (const [label, args] of [
      ['vendored pi-tui typecheck', ['typecheck:fork']],
      ['vendored pi-tui tests', ['test:fork']],
      ['TUI unit tests', ['test:bundle']],
      ['documentation tests', ['test:docs']],
      ['Pi surface compatibility gate', ['gate:pi-surface-compat']],
      ['TUI candidate build and pack', ['pack:release']],
    ]) await run(PNPM_COMMAND, args, workspace, label, npmEnvironment)
    const candidate = candidateTarball(workspace)
    assertNoSourceLeak(candidate)
    console.log(`DSH npm compatibility passed — ${basename(candidate)} × DSH ${distribution.version}`)
  } finally {
    if (values.keep === true || process.env.DSH_NPM_KEEP === '1') console.error(`preserved npm verification workspace: ${root}`)
    else rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`DSH_NPM_VERIFY_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
