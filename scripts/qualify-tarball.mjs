#!/usr/bin/env node
/**
 * Run the eight packed-artifact smokes against ONE exact tarball.
 *
 * This is the only qualification runner for a packed candidate. It is a thin
 * orchestrator: each smoke keeps its own install and assertion logic, and the
 * runner only fixes the ORDER, the exact tarball every child receives, and the
 * failure behaviour (the first non-zero child stops the run).
 *
 * Usage:
 *   node scripts/qualify-tarball.mjs [candidate.tgz]
 *   pnpm smoke:release -- [candidate.tgz]
 *
 * With no argument the runner requires EXACTLY ONE
 * `xmoon76-dsh-pi-tui-*.tgz` in the package root. It never picks "the newest"
 * of several, because a qualification must name the artifact it qualified.
 *
 * @module @xmoon76/dsh-pi-tui/scripts/qualify-tarball
 */

import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARBALL_NAME = /^xmoon76-dsh-pi-tui-.+\.tgz$/u

/** The fixed smoke order, matching the long-standing packed-artifact gate. */
export const SMOKE_SCRIPTS = [
  'scripts/tarball-smoke.mjs',
  'scripts/extension-fixture-smoke.mjs',
  'scripts/advanced-plugin-smoke.mjs',
  'scripts/phase4-plugin-smoke.mjs',
  'scripts/unstable-plugin-smoke.mjs',
  'scripts/vim-plugin-smoke.mjs',
  'scripts/examples-plugin-smoke.mjs',
  'scripts/compose-agent-compat-smoke.mjs',
]

function fail(message) {
  throw new Error(message)
}

function assertCandidate(path, label) {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    fail(`${label} does not exist: ${path}`)
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    fail(`${label} is not a regular file: ${path}`)
  }
  if (!TARBALL_NAME.test(basename(path))) {
    fail(`${label} is not a project tarball (expected xmoon76-dsh-pi-tui-*.tgz): ${path}`)
  }
}

/**
 * Resolve the ONE candidate this run qualifies.
 *
 * @param {string} directory the package root to scan when no path is given
 * @param {string|undefined} explicitPath an optional CLI path
 * @returns {string} the absolute candidate path
 */
export function selectCandidate(directory, explicitPath = undefined) {
  if (explicitPath !== undefined) {
    const candidate = resolve(process.cwd(), explicitPath)
    assertCandidate(candidate, 'the explicit candidate')
    return candidate
  }
  const names = readdirSync(directory).filter(name => TARBALL_NAME.test(name)).sort()
  if (names.length !== 1) {
    fail(`expected exactly one candidate tarball in ${directory}, found ${names.length}${names.length === 0 ? '' : ` (${names.join(', ')})`}`)
  }
  const candidate = join(directory, names[0])
  assertCandidate(candidate, 'the candidate')
  return candidate
}

/**
 * Run the fixed smoke sequence against one candidate.
 *
 * @param {string} candidate absolute path to the one tarball
 * @param {{scripts?: string[], spawn?: Function, root?: string}} options
 */
export function runQualification(candidate, { scripts = SMOKE_SCRIPTS, spawn = spawnSync, root = ROOT } = {}) {
  console.log(`qualify: candidate ${basename(candidate)}`)

  for (const [index, script] of scripts.entries()) {
    const stage = `${index + 1}/${scripts.length} ${basename(script, '.mjs')}`
    console.log(`qualify [${stage}]: starting`)
    const result = spawn(process.execPath, [join(root, script), candidate], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    })
    if (result.error !== undefined) {
      fail(`${stage} could not start: ${result.error.message}`)
    }
    if (result.status !== 0) {
      fail(`${stage} failed (${result.status === null ? `signal ${result.signal}` : `exit ${result.status}`})`)
    }
    console.log(`qualify [${stage}]: passed`)
  }

  console.log(`qualify: all ${scripts.length} packed-artifact smokes passed for ${basename(candidate)}`)
}

function main() {
  const rawArgs = process.argv.slice(2)
  // `pnpm run <script> -- <arg>` forwards the `--` separator to the script
  // (pnpm 12 does this), so strip it before the positional-argument check.
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  if (args.length > 1) {
    fail('usage: node scripts/qualify-tarball.mjs [candidate.tgz]')
  }
  const candidate = selectCandidate(ROOT, args[0])
  runQualification(candidate)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`QUALIFY_TARBALL_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
