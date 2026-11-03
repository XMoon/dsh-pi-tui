#!/usr/bin/env node
/**
 * Run the isolated npm development profile.
 *
 * This is the `mise run dev:dsh` launcher. It deliberately does not install or
 * initialize a profile: a missing profile is a real DSH error. The launcher
 * applies the same npm-worktree guard as `dev:profile`, so an already
 * Source-materialized checkout cannot accidentally boot the mise npm CLI.
 *
 * @module mise-dev-dsh
 */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertNpmWorktree, resolveDshDevContext } from './dsh-dev-context.mjs'
import { PROFILE, assertIsolatedHome } from './mise-dev-profile.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SCRIPT_PATH), '..')

function fail(message) {
  const error = new Error(message)
  error.name = 'MiseDevDshError'
  throw error
}

export function runMiseDevDsh({ root = ROOT, environment = process.env, args = process.argv.slice(2) } = {}) {
  const context = resolveDshDevContext({ root, environment })
  assertNpmWorktree(context.root, context, 'mise run dev:dsh')
  assertIsolatedHome(environment, 'mise run dev:dsh', context.root)
  const result = spawnSync('dsh', ['--profile', PROFILE, ...args], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
  })
  if (result.error !== undefined) fail(`dsh could not start: ${result.error.message}`)
  if (result.status !== 0) fail(`dsh failed with exit ${result.status ?? 'unknown'}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const args = process.argv.slice(2)
    if (args[0] === '--') args.shift()
    runMiseDevDsh({ args })
  } catch (error) {
    console.error(`MISE_DEV_DSH_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
