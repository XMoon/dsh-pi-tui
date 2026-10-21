#!/usr/bin/env node
/**
 * Start a child shell with the environment materialized by dev:bootstrap.
 * This is the non-direnv fallback for source-mode worktrees.
 *
 * @module dev-shell
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import { resolveDshDevContext, sourceEnvironment } from './dsh-dev-context.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)

function parseCli() {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  const { values } = parseArgs({
    args,
    options: {
      root: { type: 'string' },
      mode: { type: 'string' },
      config: { type: 'string' },
      distribution: { type: 'string' },
    },
    allowPositionals: false,
  })
  return values
}

function shellPath() {
  if (process.platform === 'win32') return process.env.ComSpec ?? 'cmd.exe'
  return process.env.SHELL ?? '/bin/sh'
}

function npmEnvironment(base = process.env, root = undefined) {
  const environment = {
    ...base,
    ...(root === undefined ? {} : { DSH_DEV_ROOT: resolve(root) }),
    DSH_DEV_MODE: 'npm',
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false',
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

function sourceShellEnvironment(context, base = process.env) {
  return sourceEnvironment({
    ...base,
    DSH_DEV_ROOT: context.root,
    DSH_DEV_MODE: 'source',
    DSH_SOURCE_CONFIG: context.sourceConfigPath,
    DSH_SOURCE_DISTRIBUTION: context.distribution ?? context.sourcePack,
    DSH_DEV_EPHEMERAL: context.distribution === undefined ? '0' : '1',
  })
}

function main() {
  const values = parseCli()
  const context = resolveDshDevContext({
    root: values.root,
    mode: values.mode,
    config: values.config,
    distribution: values.distribution,
  })
  const environment = context.mode === 'source'
    ? sourceShellEnvironment(context)
    : npmEnvironment(process.env, context.root)
  if (context.mode === 'source' && context.distribution === undefined && !existsSync(context.sourcePack)) {
    console.error('Source pack is not ready; run `pnpm dev:bootstrap` before entering the source shell.')
  }
  console.log(`Starting ${shellPath()} with DSH mode=${context.mode}. Exit the child shell to return.`)
  const result = spawnSync(shellPath(), process.platform === 'win32' ? [] : ['-i'], {
    cwd: context.root,
    env: environment,
    stdio: 'inherit',
    windowsHide: false,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== null) process.exitCode = result.status
  else if (result.signal !== null) process.exitCode = 1
}

export const _test = {
  npmEnvironment,
  sourceShellEnvironment,
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main()
  } catch (error) {
    console.error(`DSH_DEV_SHELL_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
