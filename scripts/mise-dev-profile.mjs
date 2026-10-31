#!/usr/bin/env node
/**
 * Install this checkout's built TUI into the isolated development profile.
 *
 * The DSH CLI is the mise-managed project tool; the profile lives under the
 * task-provided isolated DSH_HOME. This script refuses to install into the
 * user's real ~/.dsh and refuses to link a checkout that has not been built.
 *
 * @module mise-dev-profile
 */

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertNpmWorktree, resolveDshDevContext } from './dsh-dev-context.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SCRIPT_PATH), '..')
export const PROFILE = 'pi-tui-dev'

function fail(message) {
  const error = new Error(message)
  error.name = 'MiseDevProfileError'
  throw error
}

function canonicalPath(path) {
  let current = resolve(path)
  const missing = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    missing.unshift(basename(current))
    current = parent
  }
  return resolve(realpathSync(current), ...missing)
}

function pathWithin(root, target) {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

export function assertIsolatedHome(environment = process.env, command = 'mise run dev:profile', root = ROOT) {
  const configured = environment.DSH_HOME
  if (typeof configured !== 'string' || configured.trim() === '') {
    fail(`DSH_HOME is not set; run this through \`${command}\``)
  }
  const realHome = canonicalPath(join(homedir(), '.dsh'))
  const selected = canonicalPath(configured)
  if (pathWithin(realHome, selected)) {
    fail(`refusing to install the development profile into the real ~/.dsh; use the isolated DSH_HOME provided by \`${command}\``)
  }
  const tempRoot = canonicalPath(join(root, 'temp'))
  if (!pathWithin(tempRoot, selected)) {
    fail(`refusing DSH_HOME outside this worktree's temp directory: ${selected}; use the isolated DSH_HOME provided by \`${command}\``)
  }
}

export function assertBuildOutput(root = ROOT) {
  const entry = join(root, 'dist', 'index.mjs')
  if (!existsSync(entry)) fail(`built bundle is missing at ${entry}; run \`mise run build\` first`)
}

export function runMiseDevProfile({ root = ROOT, environment = process.env } = {}) {
  const context = resolveDshDevContext({ root, environment })
  assertNpmWorktree(context.root, context, 'mise run dev:profile')
  assertIsolatedHome(environment, 'mise run dev:profile', context.root)
  assertBuildOutput(root)
  const result = spawnSync('dsh', ['plugin', '--profile', PROFILE, '--', 'add', 'link:.'], {
    cwd: root,
    env: environment,
    stdio: 'inherit',
  })
  if (result.error !== undefined) fail(`dsh plugin could not start: ${result.error.message}`)
  if (result.status !== 0) fail(`dsh plugin failed with exit ${result.status ?? 'unknown'}`)
}

export const _test = {
  PROFILE,
  assertBuildOutput,
  assertIsolatedHome,
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    runMiseDevProfile()
  } catch (error) {
    console.error(`MISE_DEV_PROFILE_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
