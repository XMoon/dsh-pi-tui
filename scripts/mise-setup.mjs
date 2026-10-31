#!/usr/bin/env node
/**
 * Materialize this worktree's npm-mode workspace dependencies from the tracked
 * frozen lockfile.
 *
 * This is the `mise run setup` entry point. Tool installation belongs to mise,
 * and source-mode materialization still belongs to the existing
 * dev-doctor/dev-bootstrap flow; this task must not become a second installer
 * for the pinned source distribution.
 *
 * @module mise-setup
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MODE_CONFIG_RELATIVE, readModeConfig, resolveDshDevContext } from './dsh-dev-context.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SCRIPT_PATH), '..')

const INSTALL_ARGUMENTS = ['install', '--frozen-lockfile']

function fail(message) {
  const error = new Error(message)
  error.name = 'MiseSetupError'
  throw error
}

export function assertNpmMode(context) {
  if (context.mode === 'npm') return
  fail(`mise run setup refuses mode=${context.mode} for ${context.root}; use \`pnpm dev:doctor\` and \`pnpm dev:bootstrap\` for the tracked Source Mode distribution`)
}

function assertTrackedNpmMode(root) {
  const path = join(root, MODE_CONFIG_RELATIVE)
  if (!existsSync(path)) return
  const tracked = readModeConfig(path)
  if (tracked === 'source') {
    fail(`mise run setup refuses the tracked source mode for ${root}; a DSH_MODE override must not run a plain npm install in this worktree. Use \`pnpm dev:doctor\` and \`pnpm dev:bootstrap\``)
  }
}

function configuredPnpm(environment) {
  return typeof environment.PNPM_EXECUTABLE === 'string' && environment.PNPM_EXECUTABLE !== ''
    ? environment.PNPM_EXECUTABLE
    : 'pnpm'
}

export function runMiseSetup({ root = ROOT, mode = undefined, environment = process.env } = {}) {
  const context = resolveDshDevContext({ root, mode, environment })
  assertTrackedNpmMode(context.root)
  assertNpmMode(context)
  const result = spawnSync(configuredPnpm(environment), INSTALL_ARGUMENTS, {
    cwd: context.root,
    env: environment,
    stdio: 'inherit',
  })
  if (result.error !== undefined) fail(`pnpm install could not start: ${result.error.message}`)
  if (result.status !== 0) fail(`pnpm install failed with exit ${result.status ?? 'unknown'}`)
}

export const _test = {
  INSTALL_ARGUMENTS,
  assertNpmMode,
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    runMiseSetup()
  } catch (error) {
    console.error(`MISE_SETUP_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
