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

/**
 * Parse the optional `--shard=<index>/<total>` argument.
 *
 * The shard is Node's OWN `--test-shard`: it partitions the test FILES it
 * is given, so the shards of one lane are disjoint by construction and the
 * union of all of them is the whole lane. The repository does not implement
 * its own partitioning — a second, divergent partitioner could disagree
 * with the runner about which file belongs where, and the aggregate would
 * then silently lose a file.
 *
 * @param {string[]} args - the command line arguments.
 * @returns {string|undefined} the Node shard argument, or undefined.
 */
export function parseShard(args) {
  const argument = args.find(entry => entry.startsWith('--shard='))
  if (argument === undefined) return undefined
  const value = argument.slice('--shard='.length)
  const match = /^(\d+)\/(\d+)$/u.exec(value)
  if (match === null) {
    throw new Error(`the shard must be written as <index>/<total>, got: ${value}`)
  }
  const index = Number(match[1])
  const total = Number(match[2])
  if (total < 1) {
    throw new Error(`the shard total must be at least 1, got: ${total}`)
  }
  if (index < 1 || index > total) {
    throw new Error(`the shard index must be between 1 and ${total}, got: ${index}`)
  }
  return `${index}/${total}`
}

function main() {
  const laneName = process.argv[2]
  const args = process.argv.slice(3)
  if (laneName === undefined) {
    console.error(`usage: node scripts/run-test-lane.mjs <lane> [--shard=<index>/<total>]\nlanes: ${Object.keys(LANES).join(', ')}`)
    process.exit(2)
  }
  const lane = LANES[laneName]
  if (lane === undefined) {
    console.error(`unknown test lane: ${laneName}\nlanes: ${Object.keys(LANES).join(', ')}`)
    process.exit(2)
  }
  // The lane's patterns are relative to the test root.
  const files = resolveLane(TEST_ROOT, lane.patterns, lane.suffixes, lane.exclude ?? [])
  // The file list is passed RELATIVE to the repository root, and the child
  // runs with that root as its working directory.
  //
  // The absolute form would exceed the Windows command-line limit: the
  // product lane is 491 files, and absolute paths in a typical Windows
  // checkout total ~60,000 characters against `CreateProcessW`'s 32,767.
  // The relative form is ~9,000 characters on every platform, and the
  // child's `cwd` keeps the repository root as the working directory —
  // which the tests rely on (22 of them read `process.cwd()`).
  const relativeFiles = files.map(rel => join('test', rel))

  // The optional shard. It is a runner ARGUMENT, not a mode: the default
  // is the WHOLE lane.
  const shard = parseShard(args)

  // The MACHINE-READABLE reporter.
  //
  // It is opt-in: the destination variable is what turns it on. Without
  // the variable, the lane runs exactly as it always did, with Node's own
  // reporter and no extra file. With it, the reporter is loaded and it
  // writes the case records NEXT TO the human report.
  //
  // The reporter has to be named on the COMMAND LINE — the destination
  // variable alone does not make Node load it, so a run that set the
  // variable but not the flag would produce no records at all, and every
  // consumer of them would fail later with a confusing "file not found".
  const jsonl = process.env.DSH_TEST_JSONL
  const reporterArgs = jsonl === undefined
    ? []
    : [`--test-reporter=${join(ROOT, 'scripts', 'test-case-reporter.mjs')}`]

  const root = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-test-run-'))
  const keep = process.env.DSH_TEST_KEEP_TMP === '1'
  const child = spawn(process.execPath, [
    '--test',
    ...reporterArgs,
    ...(shard === undefined ? [] : [`--test-shard=${shard}`]),
    ...relativeFiles,
  ], {
    cwd: ROOT,
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
