#!/usr/bin/env node
/**
 * The test LANE runner: resolve a lane's membership through the discovery
 * rule and hand the explicit file list to Node's test runner.
 *
 * The lane's membership is a PATTERN, not a hand-maintained path list, so a
 * test that moves into an ownership directory cannot silently stop being
 * discovered. The patterns live in `scripts/test-lanes.mjs`; this script
 * resolves them and spawns the runner.
 *
 * The lane runner keeps the repository's execution contract:
 *
 *   - the child runs under the disposable temp root (TMPDIR/TMP/TEMP), so a
 *     forgotten fixture cleanup can only leave ONE runner root behind;
 *   - the child is spawned WITHOUT a shell, so no glob is ever expanded by
 *     a shell (the pattern resolution happens HERE, in Node);
 *   - the exit code is passed through unchanged;
 *   - an EMPTY lane fails closed — a lane that discovers nothing must never
 *     report green;
 *   - the file list is sorted, so the execution order does not depend on the
 *     filesystem.
 *
 * Usage: node scripts/run-test-lane.mjs <lane>
 * @module @xmoon76/dsh-pi-tui/scripts/run-test-lane
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLane } from './test-discovery.mjs'
import { LANES } from './test-lanes.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_ROOT = join(ROOT, 'test')

function main() {
  const laneName = process.argv[2]
  if (laneName === undefined) {
    console.error(`usage: node scripts/run-test-lane.mjs <lane>\nlanes: ${Object.keys(LANES).join(', ')}`)
    process.exit(2)
  }
  const lane = LANES[laneName]
  if (lane === undefined) {
    console.error(`unknown test lane: ${laneName}\nlanes: ${Object.keys(LANES).join(', ')}`)
    process.exit(2)
  }
  // The lane's patterns are relative to the test root.
  const files = resolveLane(TEST_ROOT, lane.patterns, lane.suffixes, lane.exclude ?? [])
  const absolute = files.map(rel => join(TEST_ROOT, rel))

  const root = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-test-run-'))
  const keep = process.env.DSH_TEST_KEEP_TMP === '1'
  const child = spawn(process.execPath, ['--test', ...absolute], {
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
  })
  const forwardSignal = (signal) => {
    if (!child.killed) {
      try {
        child.kill(signal)
      } catch {
        // The child may have settled between the check and the kill.
      }
    }
  }
  process.on('SIGINT', () => forwardSignal('SIGINT'))
  process.on('SIGTERM', () => forwardSignal('SIGTERM'))
  process.on('SIGHUP', () => forwardSignal('SIGHUP'))

  const disposeRoot = () => {
    if (keep) {
      process.stderr.write(`[run-test-lane] keeping ${root} (DSH_TEST_KEEP_TMP=1)\n`)
      return
    }
    rmSync(root, { recursive: true, force: true })
  }

  child.on('error', (error) => {
    disposeRoot()
    console.error(`[run-test-lane] failed to spawn the test runner: ${error.message}`)
    process.exit(1)
  })
  child.on('close', (code, signal) => {
    disposeRoot()
    if (code !== null) {
      process.exitCode = code
      return
    }
    const signo = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGTERM: 15 }[signal] ?? 0
    process.exitCode = signo > 0 ? 128 + signo : 1
  })
}

main()
