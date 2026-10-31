#!/usr/bin/env node
/**
 * Run the Source Mode profile flow with the materialized source CLI.
 *
 * Source Mode is POSIX-only: its bootstrap materializes the pinned exact-SHA
 * distribution into this worktree's node_modules. The commands here must use
 * that local CLI (never the mise-managed npm CLI) and an isolated DSH_HOME.
 *
 * @module mise-source-mode
 */

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { assertBuildOutput, assertIsolatedHome } from './mise-dev-profile.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SCRIPT_PATH), '..')
const PROFILE = 'pi-tui'

function fail(message) {
  const error = new Error(message)
  error.name = 'MiseSourceModeError'
  throw error
}

function sourceEnvironment(environment) {
  return {
    ...environment,
    DSH_MODE: 'source',
    DSH_DEV_MODE: 'source',
  }
}

function runNode(script, args, environment) {
  const result = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    env: environment,
    stdio: 'inherit',
  })
  if (result.error !== undefined) fail(`${script} could not start: ${result.error.message}`)
  if (result.status !== 0) fail(`${script} failed with exit ${result.status ?? 'unknown'}`)
}

export function assertSourceReady(environment = process.env) {
  if (process.platform === 'win32') fail('Source Mode is POSIX-only')
  runNode('scripts/dev-doctor.mjs', ['--mode', 'source'], sourceEnvironment(environment))
}

export function sourceCliPath(root = ROOT) {
  const cli = join(root, 'node_modules', '.bin', 'dsh')
  if (!existsSync(cli)) fail(`source CLI is missing at ${cli}; run \`mise run source:bootstrap\` first`)
  const real = realpathSync(cli)
  const nodeModules = join(root, 'node_modules')
  if (real !== nodeModules && !real.startsWith(`${nodeModules}${sep}`)) {
    fail(`source CLI resolves outside this worktree's node_modules: ${real}`)
  }
  return real
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

export function runSourceProfile({ root = ROOT, environment = process.env, command = 'profile', cwd = root } = {}) {
  if (command !== 'profile' && command !== 'dsh') fail(`unknown Source Mode command ${command}`)
  assertIsolatedHome(environment, 'mise run source:profile', root)
  assertSourceReady(environment)
  assertBuildOutput(root)
  const envFile = join(root, '.dsh-dev-env')
  if (!existsSync(envFile)) fail(`source environment file is missing: ${envFile}; run \`mise run source:bootstrap\` first`)
  const cli = sourceCliPath(root)
  const args = command === 'profile'
    ? ['plugin', '--profile', PROFILE, '--', 'add', 'link:.']
    : ['--profile', PROFILE]
  const script = `. ${shellQuote(envFile)} && exec ${shellQuote(cli)} ${args.map(shellQuote).join(' ')}`
  const result = spawnSync('/bin/sh', ['-c', script], {
    cwd: command === 'profile' ? root : cwd,
    env: sourceEnvironment(environment),
    stdio: 'inherit',
  })
  if (result.error !== undefined) fail(`source CLI could not start: ${result.error.message}`)
  if (result.status !== 0) fail(`source CLI failed with exit ${result.status ?? 'unknown'}`)
}

function parseCli() {
  const args = process.argv.slice(2)
  const command = args.shift()
  if (args[0] === '--') args.shift()
  const { values } = parseArgs({
    args,
    options: {
      cwd: { type: 'string' },
    },
    allowPositionals: false,
  })
  if (command !== 'profile' && command !== 'dsh') fail('usage: mise-source-mode.mjs <profile|dsh> [--cwd <path>]')
  return { command, cwd: values.cwd }
}

export const _test = {
  PROFILE,
  assertSourceReady,
  sourceCliPath,
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const { command, cwd } = parseCli()
    runSourceProfile({ command, cwd: cwd === undefined ? undefined : resolve(cwd) })
  } catch (error) {
    console.error(`MISE_SOURCE_MODE_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
