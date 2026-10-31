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
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertNpmWorktree, resolveDshDevContext } from './dsh-dev-context.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SCRIPT_PATH), '..')

const INSTALL_ARGUMENTS = ['install', '--frozen-lockfile']

function fail(message) {
  const error = new Error(message)
  error.name = 'MiseSetupError'
  throw error
}

function configuredPnpm(environment) {
  return typeof environment.PNPM_EXECUTABLE === 'string' && environment.PNPM_EXECUTABLE !== ''
    ? environment.PNPM_EXECUTABLE
    : 'pnpm'
}

export function runMiseSetup({ root = ROOT, mode = undefined, environment = process.env } = {}) {
  const context = resolveDshDevContext({ root, mode, environment })
  assertNpmWorktree(context.root, context, 'mise run setup')
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
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    runMiseSetup()
  } catch (error) {
    console.error(`MISE_SETUP_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
