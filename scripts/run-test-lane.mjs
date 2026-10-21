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
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLane } from './test-discovery.mjs'
import { LANES } from './test-lanes.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where the lanes are discovered.
 *
 * It is ALWAYS the repository's own `test/` directory for a QUALIFICATION
 * run: `pnpm test:product` must scan the repository's 491 product test
 * files, and nothing an environment variable says may change that set.
 * A qualification that silently scanned a different tree would report
 * green without having run the suite it claims to have run.
 *
 * `DSH_TEST_ROOT` therefore only applies when the caller ALSO passes
 * `--test-root`, which is the explicit opt-in a TEST uses to point the
 * runner at a disposable tree. The two have to agree, so a stray
 * environment variable cannot redirect a qualification run on its own.
 */
export function resolveTestRoot(explicit, environment = process.env) {
  const canonical = join(ROOT, 'test')
  if (explicit === undefined) return canonical
  const override = environment.DSH_TEST_ROOT
  if (override === undefined) {
    throw new Error('--test-root requires DSH_TEST_ROOT to name the same directory')
  }
  const resolved = resolve(override)
  if (resolved !== resolve(explicit)) {
    throw new Error(`--test-root (${explicit}) and DSH_TEST_ROOT (${override}) disagree`)
  }
  return resolved
}

function main() {
  const laneName = process.argv[2]
  const args = process.argv.slice(3)
  const testRootIndex = args.indexOf('--test-root')
  const explicitTestRoot = testRootIndex === -1 ? undefined : args[testRootIndex + 1]
  if (laneName === undefined) {
    console.error(`usage: node scripts/run-test-lane.mjs <lane> [--test-root <dir>]\nlanes: ${Object.keys(LANES).join(', ')}`)
    process.exit(2)
  }
  const lane = LANES[laneName]
  if (lane === undefined) {
    console.error(`unknown test lane: ${laneName}\nlanes: ${Object.keys(LANES).join(', ')}`)
    process.exit(2)
  }
  const testRoot = resolveTestRoot(explicitTestRoot)
  // The lane's patterns are relative to the test root.
  const files = resolveLane(testRoot, lane.patterns, lane.suffixes, lane.exclude ?? [])
  // The file list is passed RELATIVE to the repository root, and the child
  // runs with that root as its working directory.
  //
  // The absolute form would exceed the Windows command-line limit: the
  // product lane is 491 files, and absolute paths in a typical Windows
  // checkout total ~60,000 characters against `CreateProcessW`'s 32,767.
  // The relative form is ~9,000 characters on every platform, and the
  // child's `cwd` keeps the repository root as the working directory —
  // which the tests rely on (22 of them read `process.cwd()`).
  //
  // The prefix is the test root's own name, so an overridden root keeps
  // the same shape: the child is given `<root-name>/<file>` relative to
  // the working directory, and the working directory is the root's
  // PARENT.
  const testRootParent = dirname(testRoot)
  const testRootName = basename(testRoot)
  const workingDirectory = testRoot === join(ROOT, 'test') ? ROOT : testRootParent
  const relativeFiles = files.map(rel => join(testRootName, rel))

  const root = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-test-run-'))
  const keep = process.env.DSH_TEST_KEEP_TMP === '1'
  // The MACHINE-READABLE reporter.
  //
  // It is opt-in: the destination variable is what turns it on. Without
  // the variable the lane runs exactly as it always did, with Node's own
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
  const child = spawn(process.execPath, [
    '--test',
    ...reporterArgs,
    ...relativeFiles,
  ], {
    cwd: workingDirectory,
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

// The runner is a SCRIPT. Running it only when it IS the entry point keeps
// importing it side-effect free.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
