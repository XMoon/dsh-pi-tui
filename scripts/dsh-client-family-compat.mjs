#!/usr/bin/env node
/**
 * Run the Remote Session read gates in an independent exact DSH release-family
 * install. By default the target is read from the package.json DSH declaration;
 * another release can be selected explicitly for a local compatibility probe.
 *
 * @module dsh-client-family-compat
 */

import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { runBounded } from './lib/process.mjs'
import { PACKAGE_ROOT, npmDshVersion } from './lib/dsh-distribution.mjs'

const VERIFY_SCRIPT = join(PACKAGE_ROOT, 'scripts', 'dsh-npm-verify.mjs')

function parseCli(args = process.argv.slice(2)) {
  const normalizedArgs = [...args]
  if (normalizedArgs[0] === '--') normalizedArgs.shift()
  const { values } = parseArgs({
    args: normalizedArgs,
    options: { 'dsh-version': { type: 'string' } },
    allowPositionals: false,
  })
  return values
}

function resolveVersion(values) {
  return values['dsh-version'] ?? npmDshVersion()
}

export function resolveDshVersion(args = process.argv.slice(2)) {
  return resolveVersion(parseCli(args))
}

async function main() {
  const values = parseCli()
  const version = resolveVersion(values)
  const label = `DSH Client exact-family lane ${version}`
  console.log(`DSH Client family compatibility: ${version}${values['dsh-version'] === undefined ? ' (package.json target)' : ' (manual target)'}`)
  const result = await runBounded(process.execPath, [
    VERIFY_SCRIPT,
    '--dsh-version', version,
    '--exact-family',
    '--client-smoke-only',
  ], {
    cwd: PACKAGE_ROOT,
    env: process.env,
    timeoutMs: 30 * 60 * 1000,
    label,
  })
  if (result.status !== 0 || result.timedOut) {
    throw new Error(`${label} failed${result.error ? `: ${result.error.message}` : ` with exit ${result.status ?? 'unknown'}`}`)
  }
  console.log(`DSH Client release-family compatibility passed — ${version}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`DSH_CLIENT_FAMILY_COMPAT_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
