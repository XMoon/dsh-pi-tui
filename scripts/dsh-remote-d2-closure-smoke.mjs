#!/usr/bin/env node
/**
 * Aggregate the focused D2 same-Host proof scripts without duplicating their
 * fixtures. The first failed child stops the closure and its output is kept.
 *
 * @module dsh-remote-d2-closure-smoke
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROOFS = [
  ['D2.1/D2.2 ordinary write and queue', 'scripts/dsh-remote-d2-write-smoke.mjs'],
  ['D2.3/D2.4 lifecycle and fork/rewind parity', 'scripts/dsh-remote-d2.4-fork-parity-smoke.mjs'],
]

function main() {
  for (const [name, script] of PROOFS) {
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', resolve(ROOT, script)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    })
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    if (result.error !== undefined) {
      throw new Error(`${name} failed to start: ${result.error.message}`)
    }
    if (result.status !== 0) {
      throw new Error(`${name} failed (exit ${String(result.status)})`)
    }
  }
  console.log('D2 closure smoke passed')
}

try {
  main()
} catch (error) {
  console.error(`DSH_REMOTE_D2_CLOSURE_FAILURE: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
}
