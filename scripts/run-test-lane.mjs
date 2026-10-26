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
 *     filesystem;
 *   - SIGNALS: on POSIX the child leads its OWN process group, so a forwarded
 *     SIGINT/SIGTERM/SIGHUP reaches the workers and commands it started, and
 *     the temp root is removed only once the whole group is provably gone — a
 *     bounded grace, then ONE SIGKILL escalation. The direct child's `close`
 *     alone is not the group's end, on a NORMAL exit either: a lane whose
 *     workers left a process running keeps (and reports) its root instead of
 *     deleting a directory that process still uses. On Windows there is no
 *     group id to address, so the signal is forwarded to the direct child only.
 *
 * Usage: node scripts/run-test-lane.mjs <lane>
 * @module @xmoon76/dsh-pi-tui/scripts/run-test-lane
 */

import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLane } from './test-discovery.mjs'
import { LANES } from './test-lanes.mjs'
import { groupStillAlive, stopOwnedGroup } from './lib/owned-process-group.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_ROOT = join(ROOT, 'test')

/** A command's trimmed output, or null when it cannot be read. */
function commandOutput(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', cwd: ROOT }).trim()
  } catch {
    return null
  }
}

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

/**
 * Parse the optional `--test-concurrency=<n>` argument.
 *
 * The concurrency is Node's OWN `--test-concurrency`: it caps how many test
 * FILES the runner keeps in flight at once. It is passed straight through,
 * so the level that is measured is the level that runs.
 *
 * The DEFAULT level is expressed by NOT passing the flag at all: Node then
 * uses `os.availableParallelism()`, which is what the repository actually
 * runs. A level of `default` therefore means "no flag", not "the number of
 * CPUs".
 *
 * @param {string[]} args - the command line arguments.
 * @returns {string|undefined} the Node concurrency argument, or undefined.
 */
export function parseConcurrency(args) {
  const argument = args.find(entry => entry.startsWith('--test-concurrency='))
  if (argument === undefined) return undefined
  const value = argument.slice('--test-concurrency='.length)
  if (value === 'default') return undefined
  if (!/^\d+$/u.test(value)) {
    throw new Error(`the test concurrency must be a whole number or "default", got: ${value}`)
  }
  const concurrency = Number(value)
  if (concurrency < 1) {
    throw new Error(`the test concurrency must be at least 1, got: ${concurrency}`)
  }
  return `--test-concurrency=${concurrency}`
}

function main() {
  const laneName = process.argv[2]
  const args = process.argv.slice(3)
  if (laneName === undefined) {
    console.error(`usage: node scripts/run-test-lane.mjs <lane> [--shard=<index>/<total>] [--test-concurrency=<n>]\nlanes: ${Object.keys(LANES).join(', ')}`)
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

  // The optional concurrency. It is a runner ARGUMENT, not a mode: the
  // default is Node's own.
  const concurrency = parseConcurrency(args)

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
  const spawnArgs = [
    '--test',
    ...reporterArgs,
    ...(shard === undefined ? [] : [`--test-shard=${shard}`]),
    ...(concurrency === undefined ? [] : [concurrency]),
    ...relativeFiles,
  ]

  // The EFFECTIVE parameters.
  //
  // The workflow knows what it INTENDED to run; only this process knows what
  // it actually put on the child's command line. The difference between the
  // two is not hypothetical: the concurrency used to be accepted here and
  // then dropped, so five CI runs were reported as a concurrency comparison
  // while every one of them ran at Node's default.
  //
  // So the applied values are recorded here, next to the case records, and
  // the aggregate checks them against what the run claims to be.
  const effective = process.env.DSH_TEST_EFFECTIVE_JSON
  if (effective !== undefined) {
    writeFileSync(effective, `${JSON.stringify({
      shard: shard ?? null,
      testConcurrency: concurrency === undefined ? null : Number(concurrency.slice('--test-concurrency='.length)),
      // The files this shard handed to Node, before Node's own sharding.
      laneFileCount: relativeFiles.length,
      // The fixed flags, so a reader can see the whole prefix.
      argvPrefix: spawnArgs.slice(0, spawnArgs.length - relativeFiles.length),
      nodeExecPath: process.execPath,
      nodeVersion: process.version,
      sha: commandOutput('git', ['rev-parse', 'HEAD']),
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    }, null, 2)}\n`)
  }

  // POSIX only: the child leads its own process group, which is what a
  // forwarded signal can address as a TREE (the `node --test` workers and the
  // commands they started). Windows has no group id, so it keeps the previous
  // direct-child forwarding.
  const ownsGroup = process.platform !== 'win32'
  const child = spawn(process.execPath, spawnArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    detached: ownsGroup,
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
  })

  let childResult
  let resolveClosed
  /** Resolves on the direct child's `close`, never on a group fact. */
  const closed = new Promise((resolve) => { resolveClosed = resolve })
  let finished = false
  let teardownStarted = false

  const disposeRoot = () => {
    if (keep) {
      process.stderr.write(`[run-test-lane] keeping ${root} (DSH_TEST_KEEP_TMP=1)\n`)
      return
    }
    rmSync(root, { recursive: true, force: true })
  }

  /**
   * The ONE place the lane finishes: whatever combination of child close,
   * spawn failure and signal teardown reaches it first, the temp root is
   * removed at most once and the exit code is set at most once.
   */
  const finish = (settled, detail) => {
    if (finished) return
    finished = true
    if (settled) {
      disposeRoot()
    } else {
      // The root IS the child's TMPDIR. Removing it while a descendant still
      // runs would delete the very directory that process is using, so an
      // unproven group keeps the root and says so instead of claiming a
      // cleanup it cannot prove.
      process.stderr.write(`[run-test-lane] keeping ${root}: ${detail}\n`)
    }
    if (childResult === undefined) {
      process.exitCode = 1
      return
    }
    if (childResult.code !== null) {
      process.exitCode = childResult.code
      return
    }
    const signo = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGTERM: 15 }[childResult.signal] ?? 0
    process.exitCode = signo > 0 ? 128 + signo : 1
  }

  child.on('error', (error) => {
    // A child that never spawned has no group and no status: the spawn failure
    // wins and is reported as such.
    if (finished) return
    finished = true
    disposeRoot()
    console.error(`[run-test-lane] failed to spawn the test runner: ${error.message}`)
    process.exitCode = 1
  })
  child.on('close', (code, signal) => {
    childResult = { code, signal }
    resolveClosed()
    if (teardownStarted) return
    // A normal close is only the DIRECT child's end. A worker or command it
    // started can still be using the root, and the root must not be deleted
    // underneath it — the same rule the signal path follows.
    if (ownsGroup && groupStillAlive(child)) {
      finish(false, `process group ${child.pid} still has live members after the direct child exited`)
      return
    }
    finish(true)
  })

  const onSignal = (signal) => {
    if (teardownStarted || finished) return
    teardownStarted = true
    void (async () => {
      let settled = true
      if (ownsGroup) {
        settled = await stopOwnedGroup(child, signal)
      } else {
        try {
          child.kill(signal)
        } catch {
          // The child may have settled between the check and the kill.
        }
      }
      if (!settled) {
        finish(false, `process group ${child.pid} still has live members after SIGKILL`)
        return
      }
      await closed
      finish(true)
    })()
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGHUP', () => onSignal('SIGHUP'))
}

// The runner runs only when it is EXECUTED. A test that imports the
// argument parsers must be able to reach them without the module running a
// lane.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
