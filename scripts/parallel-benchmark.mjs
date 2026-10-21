#!/usr/bin/env node
/**
 * The PARALLEL BENCHMARK: measure the product lane under different Node
 * test-runner concurrency levels, on the SAME tree and the SAME test set.
 *
 * The question is not "is a bigger number faster" but "which concurrency
 * is the right operating point for this repository, on this machine and on
 * a CI runner".
 *
 * A benchmark that does not VERIFY ITS RESULTS can certify a broken run as
 * the fastest one: a level that dies early looks fast, and a level that
 * silently skips tests looks cheaper. So every run is checked, and the
 * benchmark FAILS when any run is not a complete, green, identical pass:
 *
 *   - the child must exit 0;
 *   - the report must declare its pass/fail/skip counts, and `fail` must be
 *     0;
 *   - every level must report the SAME pass and skip counts — a level that
 *     ran fewer tests is not a comparable measurement;
 *   - the run must not have been killed by a signal.
 *
 * The resource sampling is SYSTEM-WIDE (the whole `/proc`), so the peak RSS
 * and process count describe the MACHINE, not this run's process tree. They
 * are reported as a system-level observation and are NOT used to compare the
 * levels' resource cost.
 *
 * Usage: node scripts/parallel-benchmark.mjs [--repeats N] [--levels 1,2,4,8]
 * @module @xmoon76/dsh-pi-tui/scripts/parallel-benchmark
 */

import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { availableParallelism, cpus, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLane } from './test-discovery.mjs'
import { LANES } from './test-lanes.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const TEST_ROOT = join(ROOT, 'test')

/** The system-wide peak resident set and process count during a run. */
async function sampleUsage(child, intervalMs = 250) {
  let peakRssKb = 0
  let peakProcesses = 0
  const sampler = setInterval(() => {
    let rss = 0
    let processes = 0
    try {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/u.test(entry)) continue
        try {
          const status = readFileSync(`/proc/${entry}/status`, 'utf8')
          const match = /VmRSS:\s+(\d+) kB/u.exec(status)
          if (match !== null) rss += Number(match[1])
          processes += 1
        } catch {
          // The process exited between the listing and the read.
        }
      }
    } catch {
      // /proc is unreadable in this environment; the sample is skipped.
    }
    if (rss > peakRssKb) peakRssKb = rss
    if (processes > peakProcesses) peakProcesses = processes
  }, intervalMs)
  const code = await new Promise((resolve_) => {
    child.on('close', (exitCode, signal) => resolve_({ exitCode, signal }))
  })
  clearInterval(sampler)
  return { ...code, peakRssKb, peakProcesses }
}

/**
 * Run the product lane at one concurrency level.
 *
 * The file list is passed RELATIVE to the repository root and the child
 * runs with that root as its working directory: the absolute form would
 * exceed the Windows command-line limit (the product lane is ~491 files,
 * and absolute paths in a typical Windows checkout total ~60,000 characters
 * against `CreateProcessW`'s 32,767).
 */
function runLane(concurrency) {
  const files = resolveLane(TEST_ROOT, LANES.product.patterns, LANES.product.suffixes, LANES.product.exclude ?? [])
  const relativeFiles = files.map(rel => join('test', rel))
  const args = ['--test']
  // The DEFAULT level is expressed by NOT passing `--test-concurrency`: Node
  // then uses its own default, which is what the repository actually runs.
  if (concurrency !== 'default') args.push(`--test-concurrency=${concurrency}`)
  const child = spawn(process.execPath, [...args, ...relativeFiles], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  return { child, output: () => output }
}

/**
 * The pass/fail/skip counts a run's report declares.
 *
 * A report that does not declare them is INCOMPLETE: the run may have died
 * before printing its summary, and its timing would certify a broken run.
 */
function counts(output) {
  const pass = /^ℹ pass (\d+)$/mu.exec(output)
  const fail = /^ℹ fail (\d+)$/mu.exec(output)
  const skipped = /^ℹ skipped (\d+)$/mu.exec(output)
  const tests = /^ℹ tests (\d+)$/mu.exec(output)
  return {
    pass: pass === null ? undefined : Number(pass[1]),
    fail: fail === null ? undefined : Number(fail[1]),
    skipped: skipped === null ? undefined : Number(skipped[1]),
    tests: tests === null ? undefined : Number(tests[1]),
  }
}

/**
 * Check one run's result. A run that is not a complete, green pass fails
 * the benchmark: its timing must not be counted.
 */
function checkRun(label, usage, output) {
  const reported = counts(output)
  if (usage.signal !== null) {
    throw new Error(`${label}: the run was killed by ${usage.signal} — its timing is not a measurement`)
  }
  if (usage.exitCode !== 0) {
    throw new Error(`${label}: the run exited ${usage.exitCode} — its timing is not a measurement`)
  }
  if (reported.tests === undefined || reported.pass === undefined || reported.fail === undefined || reported.skipped === undefined) {
    throw new Error(`${label}: the run produced no complete report — its timing is not a measurement`)
  }
  if (reported.fail !== 0) {
    throw new Error(`${label}: the run reported ${reported.fail} failing test(s) — its timing is not a measurement`)
  }
  return reported
}

async function main() {
  const args = process.argv.slice(2)
  const repeatsIndex = args.indexOf('--repeats')
  const levelsIndex = args.indexOf('--levels')
  const repeats = repeatsIndex === -1 ? 3 : Number(args[repeatsIndex + 1])
  const levels = levelsIndex === -1
    ? ['default', 1, 2, 4, 8]
    : args[levelsIndex + 1].split(',').map(entry => (entry === 'default' ? 'default' : Number(entry)))

  console.log('=== environment ===')
  console.log(`node                ${process.version}`)
  console.log(`cpus                ${cpus().length}`)
  console.log(`availableParallelism ${availableParallelism()}`)
  console.log(`total memory        ${(totalmem() / 1024 ** 3).toFixed(1)} GiB`)
  console.log(`repeats             ${repeats}`)
  console.log(`levels              ${levels.join(', ')}`)
  console.log('note: the peak RSS / process count are SYSTEM-WIDE samples, not this')
  console.log("      run's process tree; they describe the machine, not the level.\n")

  const results = []
  let reference = undefined
  for (const level of levels) {
    const times = []
    let last = undefined
    for (let run = 0; run < repeats; run += 1) {
      const start = Date.now()
      const { child, output } = runLane(level)
      const usage = await sampleUsage(child)
      const elapsed = (Date.now() - start) / 1000
      const label = `concurrency=${level} run=${run + 1}`
      const reported = checkRun(label, usage, output())
      if (reference === undefined) {
        reference = reported
      } else if (
        reported.pass !== reference.pass
        || reported.skipped !== reference.skipped
        || reported.tests !== reference.tests
      ) {
        // A level that ran a DIFFERENT number of tests is not a comparable
        // measurement: it would be a different suite, not the same one.
        throw new Error(
          `${label}: the run reported ${reported.tests} test(s) / ${reported.pass} pass / ${reported.skipped} skipped, but the reference is ${reference.tests} / ${reference.pass} / ${reference.skipped} — the levels did not run the same suite`,
        )
      }
      times.push(elapsed)
      last = { ...usage, ...reported }
      console.log(
        `${label}: ${elapsed.toFixed(1)}s exit=${usage.exitCode} pass=${reported.pass} fail=${reported.fail} skipped=${reported.skipped} systemPeakRss=${(usage.peakRssKb / 1024).toFixed(0)} MiB systemProcesses=${usage.peakProcesses}`,
      )
    }
    const sorted = [...times].sort((a, b) => a - b)
    results.push({
      level,
      p50: sorted[Math.floor(sorted.length / 2)],
      max: sorted[sorted.length - 1],
      min: sorted[0],
      pass: last?.pass ?? 0,
      skipped: last?.skipped ?? 0,
      peakRssMb: (last?.peakRssKb ?? 0) / 1024,
      peakProcesses: last?.peakProcesses ?? 0,
    })
  }

  console.log('\n=== summary ===')
  console.log('concurrency      p50(s)  max(s)  min(s)  pass  skipped  systemPeakRss(MiB)')
  for (const row of results) {
    console.log(
      `${String(row.level).padStart(11)}  ${row.p50.toFixed(1).padStart(5)}  ${row.max.toFixed(1).padStart(5)}  ${row.min.toFixed(1).padStart(5)}  ${String(row.pass).padStart(4)}  ${String(row.skipped).padStart(7)}  ${row.peakRssMb.toFixed(0).padStart(17)}`,
    )
  }
  const best = results.reduce((a, b) => (b.p50 < a.p50 ? b : a))
  console.log(`\nthe fastest p50: concurrency=${best.level} (${best.p50.toFixed(1)}s)`)
}

await main()
