#!/usr/bin/env node
/**
 * Run the Remote Session read gates in independent exact DSH release-family
 * installs. rc1 is the installed production target; rc2 is a separate forward
 * compatibility lane and must not be inferred from the rc1 lockfile.
 *
 * @module dsh-client-family-compat
 */

import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBounded } from './lib/process.mjs'
import { PACKAGE_ROOT } from './lib/dsh-distribution.mjs'

const RELEASE_FAMILIES = ['0.1.5-rc.1', '0.1.5-rc.2']
const VERIFY_SCRIPT = join(PACKAGE_ROOT, 'scripts', 'dsh-npm-verify.mjs')

async function main() {
  for (const version of RELEASE_FAMILIES) {
    const label = `DSH Client exact-family lane ${version}`
    console.log(`DSH Client family compatibility: ${version}`)
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
  }
  console.log('DSH Client release-family compatibility passed — rc1 exact install and rc2 independent target')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`DSH_CLIENT_FAMILY_COMPAT_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
