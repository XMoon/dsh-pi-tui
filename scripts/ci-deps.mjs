#!/usr/bin/env node
/**
 * Prepare one CI job's dependencies for the RESOLVED DSH mode.
 *
 * Every job that installs dependencies needs the same thing, and the two
 * modes need different things:
 *
 *   npm     — install from the registry with the frozen lockfile, and export
 *             the registry variables for the later steps;
 *   source  — install the pinned DSH distribution into the workspace, and
 *             export the variables the Source Mode lanes depend on
 *             (`TARBALL_SMOKE_SKIP_INSTALL=1` among them).
 *
 * Hand-written copies of that decision are how a mode-specific step goes
 * missing in exactly one job — and a job that installs from the registry
 * while the run claims Source Mode is testing a different dependency graph.
 *
 * The decision is therefore here, once, and it is testable: `--print-plan`
 * prints the commands and the exported variables WITHOUT running anything,
 * so the contract can be asserted without a network or a workspace.
 *
 * Usage:
 *   node scripts/ci-deps.mjs --mode <npm|source> [--distribution <dir>] [--print-plan]
 * @module @xmoon76/dsh-pi-tui/scripts/ci-deps
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

/** The source-mode configuration the pinned distribution comes from. */
const SOURCE_CONFIG = 'test/compat/dsh-source.json'

/**
 * The plan for one mode.
 *
 * @param {{mode: string, distribution?: string, workspace: string}} options
 * @returns {{mode: string, commands: string[][], env: Record<string,string>}} the plan.
 */
export function depsPlan({ mode, distribution, workspace }) {
  if (mode === 'npm') {
    return {
      mode,
      commands: [['pnpm', 'install', '--frozen-lockfile']],
      env: {
        NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
        npm_config_registry: 'https://registry.npmjs.org/',
        PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
        PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false',
      },
    }
  }
  if (mode === 'source') {
    // A Source Mode job WITHOUT the distribution would fall back to the
    // registry and quietly test the wrong graph, so it is an error rather
    // than an npm install.
    if (distribution === undefined || distribution === '') {
      throw new Error('source mode requires --distribution: the pinned DSH pack must come from the job that built it')
    }
    return {
      mode,
      commands: [[
        'node',
        'scripts/prepare-dsh-test-environment.mjs',
        '--mode',
        'source',
        '--distribution',
        distribution,
        '--workspace',
        workspace,
        '--config',
        SOURCE_CONFIG,
      ]],
      env: {
        PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
        PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false',
        // The packed package must not try to install its own DSH peer: the
        // distribution is already in the workspace.
        TARBALL_SMOKE_SKIP_INSTALL: '1',
      },
    }
  }
  throw new Error(`the DSH mode '${mode}' is not one this pipeline prepares dependencies for`)
}

function main() {
  const args = process.argv.slice(2)
  const valueOf = (name) => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const mode = valueOf('--mode')
  if (mode === undefined) {
    console.error('usage: node scripts/ci-deps.mjs --mode <npm|source> [--distribution <dir>] [--workspace <dir>] [--print-plan]')
    process.exit(2)
  }
  const plan = depsPlan({
    mode,
    distribution: valueOf('--distribution'),
    workspace: valueOf('--workspace') ?? process.env.GITHUB_WORKSPACE ?? ROOT,
  })
  if (args.includes('--print-plan')) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }
  // The exported variables are what the LATER steps read, so they go to the
  // job environment rather than to this process only.
  const envFile = process.env.GITHUB_ENV
  if (envFile === undefined) {
    throw new Error('GITHUB_ENV is not set: this script exists to prepare a JOB, not a shell')
  }
  for (const [name, value] of Object.entries(plan.env)) appendFileSync(envFile, `${name}=${value}\n`)
  const [command, ...commandArgs] = plan.commands[0]
  // eslint-disable-next-line no-console -- the child's output IS the job log
  console.log(`preparing ${plan.mode} dependencies: ${command} ${commandArgs.join(' ')}`)
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', cwd: ROOT })
  if (result.status !== 0) throw new Error(`dependency preparation failed: ${command} exited ${result.status}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
