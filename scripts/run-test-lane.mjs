#!/usr/bin/env node
/**
 * The test LANE runner: resolve a lane's membership through the discovery
 * rule and hand the in-memory file list to Node's test-runner API.
 *
 * The lane's membership is a PATTERN, not a hand-maintained path list, so a
 * test that moves into an ownership directory cannot silently stop being
 * discovered. The patterns live in `scripts/test-lanes.mjs`; the short-argv
 * child resolves them and runs Node's native test runner.
 *
 * The lane runner keeps the repository's execution contract:
 *
 *   - the child runs under the disposable temp root (TMPDIR/TMP/TEMP), so a
 *     forgotten fixture cleanup can only leave ONE runner root behind;
 *   - the child is spawned WITHOUT a shell, so no glob is ever expanded by
 *     a shell (the pattern resolution happens HERE, in Node);
 *   - a CLEAN run passes the child's exit code through, but an INTERRUPTED run
 *     reports the first received SIGINT/SIGTERM/SIGHUP (128+signo) even when
 *     the child handles the signal and exits 0. A cleanup that cannot be proven
 *     is NON-ZERO as well: the child's own status stays diagnostic, because a
 *     lane that leaves a live process in its owned group is not a pass;
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
import { run } from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveLane } from './test-discovery.mjs'
import { LANES } from './test-lanes.mjs'
import { groupStillAlive, stopOwnedGroup } from './lib/owned-process-group.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_ROOT = join(ROOT, 'test')

/**
 * Ambient terminal-identity variables describe the DEVELOPER's enclosing
 * terminal (a Tern pane inside Zellij on Kitty, a tmux session, ...), not the
 * test fixture. Product tests construct their own capability and progress
 * environment; inheriting the developer's changes which branch a test takes
 * and makes a local run disagree with clean CI. A test that needs one of these
 * facts sets it explicitly (and restores it), so the lane child never inherits
 * them.
 */
const AMBIENT_TERMINAL_ENV = Object.freeze([
  'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  'KITTY_WINDOW_ID', 'KITTY_PID',
  'ZELLIJ', 'ZELLIJ_PANE_ID', 'ZELLIJ_SESSION_NAME', '_ZL_MATCH_MODE',
  'TMUX', 'TMUX_PANE', 'STY',
  'TERN_ACP', 'TERN_BLOB_DIR', 'TERN_COMPLETE', 'TERN_IDENTITY', 'TERN_LENSES',
  'TERN_PANE', 'TERN_PANE_SOCKET', 'TERN_WINDOW_SOCKET',
  'PI_IMAGE_PROTOCOL', 'PI_TUI_TMUX_KITTY_IMAGES', 'PI_TUI_TMUX_KITTY_PLACEHOLDERS',
])

/**
 * An ambient global module path (for example a mise-managed DSH rc.5 store)
 * must not make fixture `createRequire`/`require.resolve` calls select a
 * different DSH family than this checkout's locked rc.4 graph. Tests that need
 * a module set it explicitly; the lane child never inherits a global path.
 */
const AMBIENT_MODULE_ENV = Object.freeze(['NODE_PATH'])

/** The lane child environment without the developer's terminal identity or global module paths. */
export function sanitizeTestEnvironment(env = process.env) {
  const sanitized = { ...env }
  for (const name of [...AMBIENT_TERMINAL_ENV, ...AMBIENT_MODULE_ENV]) delete sanitized[name]
  return sanitized
}

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

/**
 * The spawned lane leader: the complete file list stays in this process, never
 * on a Windows CreateProcessW command line. Node still owns native sharding.
 */
async function runLaneChild(laneName, args) {
  const lane = LANES[laneName]
  const relativeFiles = resolveLane(TEST_ROOT, lane.patterns, lane.suffixes, lane.exclude ?? [])
    .map(rel => join('test', rel))
  const shard = parseShard(args)
  const concurrency = parseConcurrency(args)
  const options = {
    files: relativeFiles,
    // Node's programmatic API defaults to serial files. TRUE preserves the
    // CLI default of running files up to the available parallelism.
    concurrency: concurrency === undefined ? true : Number(concurrency.slice('--test-concurrency='.length)),
    ...(shard === undefined ? {} : {
      shard: { index: Number(shard.split('/')[0]), total: Number(shard.split('/')[1]) },
    }),
  }

  // Record what the child actually hands to run(), not only what CI intended.
  // The original effective-params.json fields remain the shard aggregate's
  // contract; argvPrefix is now the fixed, short child invocation.
  const effective = process.env.DSH_TEST_EFFECTIVE_JSON
  if (effective !== undefined) {
    writeFileSync(effective, `${JSON.stringify({
      shard: shard ?? null,
      testConcurrency: concurrency === undefined ? null : options.concurrency,
      laneFileCount: relativeFiles.length,
      argvPrefix: process.argv.slice(1),
      nodeExecPath: process.execPath,
      nodeVersion: process.version,
      sha: commandOutput('git', ['rev-parse', 'HEAD']),
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    }, null, 2)}\n`)
  }

  // Load the reporter BEFORE starting any worker: its module initialization
  // removes DSH_TEST_JSONL from the inherited environment so nested test runs
  // cannot write into this run's case inventory.
  const { default: reporter } = await import('./test-case-reporter.mjs')
  const events = run(options)
  // The run() API does not set the host process' failure exit code as the
  // CLI does; a failing test must still fail the lane and its CI job.
  events.on('test:fail', () => { process.exitCode = 1 })
  events.on('error', (error) => {
    console.error('[run-test-lane] test runner failed:', error)
    process.exitCode = 1
  })
  await reporter(events, {})
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
  // No discovered file path is passed through argv. The child resolves the
  // lane inside its own process and calls node:test.run({ files, shard }).
  const root = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-test-run-'))
  const keep = process.env.DSH_TEST_KEEP_TMP === '1'
  const spawnArgs = [fileURLToPath(import.meta.url), '--lane-child', laneName, ...args]

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
    env: { ...sanitizeTestEnvironment(process.env), TMPDIR: root, TMP: root, TEMP: root },
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
  const SIGNAL_EXIT = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGTERM: 15 }
  // The first interruption signal this wrapper received, if any. It owns the
  // wrapper's exit status: a child that "handles" SIGTERM and exits 0 must not
  // turn an interrupted run into a success.
  let receivedSignal
  /** The wrapper's OWN status; the child's result is diagnostic. */
  const exitCodeOf = () => {
    if (receivedSignal !== undefined) return 128 + (SIGNAL_EXIT[receivedSignal] ?? 0)
    if (childResult === undefined) return 1
    if (childResult.code !== null) return childResult.code
    const signo = SIGNAL_EXIT[childResult.signal] ?? 0
    return signo > 0 ? 128 + signo : 1
  }
  const describeChild = () => (childResult === undefined
    ? 'the direct child did not finish'
    : childResult.code !== null ? `the direct child exited ${childResult.code}` : `the direct child was terminated by ${childResult.signal}`)
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
      process.stderr.write(`[run-test-lane] cleanup unproven: keeping ${root}: ${detail} (${describeChild()})\n`)
    }
    // A cleanup that cannot be proven is NOT a pass: the run gets a non-zero
    // status and the child's own result stays diagnostic. The interruption
    // signal already makes the status non-zero on its own path.
    process.exitCode = settled || receivedSignal !== undefined ? exitCodeOf() : 1
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
    receivedSignal = signal
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

// The runner runs only when EXECUTED; tests may import its parsers.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--lane-child') {
    void runLaneChild(process.argv[3], process.argv.slice(4)).catch(error => {
      console.error('[run-test-lane] test runner failed:', error)
      process.exitCode = 1
    })
  } else {
    main()
  }
}
