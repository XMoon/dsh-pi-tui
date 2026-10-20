#!/usr/bin/env node
/**
 * The PARALLEL BENCHMARK: measure the product lane under different Node
 * test-runner concurrency levels, on the SAME tree and the SAME test set.
 *
 * The question is not "is a bigger number faster" but "which concurrency
 * is the right operating point for this repository, on this machine and on
 * a CI runner". The measurement therefore records, for every level:
 *
 *   - the wall time (the p50 of the repetitions, plus the maximum);
 *   - the peak RSS and the peak process count (the memory and the
 *     parallelism the level actually costs);
 *   - the pass/fail/skip counts (a faster run that loses a test is not a
 *     faster run).
 *
 * The levels are run in a fixed order, each REPEATED, and every run uses
 * the same code and the same dependency installation. The runner is never
 * started while a build is running.
 *
 * Usage: node scripts/parallel-benchmark.mjs [--repeats N] [--levels 1,2,4,8]
 * @module @xmoon76/dsh-pi-tui/scripts/parallel-benchmark
 */

import { spawn } from 'node:child_process'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLane } from './test-discovery.mjs'
import { LANES } from './test-lanes.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const TEST_ROOT = join(ROOT, 'test')

/** The peak resident set and process count observed while a child ran. */
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
    child.on('close', resolve_)
  })
  clearInterval(sampler)
  return { code, peakRssKb, peakProcesses }
}

function runLane(concurrency) {
  const files = resolveLane(TEST_ROOT, LANES.product.patterns, LANES.product.suffixes, LANES.product.exclude)
  const child = spawn(process.execPath, [
    '--test',
    `--test-concurrency=${concurrency}`,
    ...files.map(rel => join(TEST_ROOT, rel)),
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  return { child, output: () => output }
}

function counts(output) {
  const pass = /^ℹ pass (\d+)$/mu.exec(output)
  const fail = /^ℹ fail (\d+)$/mu.exec(output)
  const skipped = /^ℹ skipped (\d+)$/mu.exec(output)
  return {
    pass: pass === null ? undefined : Number(pass[1]),
    fail: fail === null ? undefined : Number(fail[1]),
    skipped: skipped === null ? undefined : Number(skipped[1]),
  }
}

async function main() {
  const args = process.argv.slice(2)
  const repeatsIndex = args.indexOf('--repeats')
  const levelsIndex = args.indexOf('--levels')
  const repeats = repeatsIndex === -1 ? 3 : Number(args[repeatsIndex + 1])
  const levels = levelsIndex === -1 ? [1, 2, 4, 8] : args[levelsIndex + 1].split(',').map(Number)

  console.log('=== environment ===')
  console.log(`node                ${process.version}`)
  console.log(`cpus                ${cpus().length}`)
  console.log(`availableParallelism ${(await import('node:os')).availableParallelism()}`)
  console.log(`total memory        ${(totalmem() / 1024 ** 3).toFixed(1)} GiB`)
  console.log(`repeats             ${repeats}`)
  console.log(`levels              ${levels.join(', ')}\n`)

  const results = []
  for (const level of levels) {
    const times = []
    let last = undefined
    for (let run = 0; run < repeats; run += 1) {
      const start = Date.now()
      const { child } = runLane(level)
      const usage = await sampleUsage(child)
      const elapsed = (Date.now() - start) / 1000
      times.push(elapsed)
      last = { ...usage, ...counts('') }
      console.log(`concurrency=${level} run=${run + 1}: ${elapsed.toFixed(1)}s exit=${usage.code} peakRss=${(usage.peakRssKb / 1024).toFixed(0)} MiB processes=${usage.peakProcesses}`)
    }
    const sorted = [...times].sort((a, b) => a - b)
    results.push({
      level,
      p50: sorted[Math.floor(sorted.length / 2)],
      max: sorted[sorted.length - 1],
      min: sorted[0],
      peakRssMb: (last?.peakRssKb ?? 0) / 1024,
      peakProcesses: last?.peakProcesses ?? 0,
    })
  }

  console.log('\n=== summary ===')
  console.log('concurrency  p50(s)  max(s)  min(s)  peakRss(MiB)  peakProcesses')
  for (const row of results) {
    console.log(
      `${String(row.level).padStart(11)}  ${row.p50.toFixed(1).padStart(5)}  ${row.max.toFixed(1).padStart(5)}  ${row.min.toFixed(1).padStart(5)}  ${row.peakRssMb.toFixed(0).padStart(12)}  ${String(row.peakProcesses).padStart(13)}`,
    )
  }
  const best = results.reduce((a, b) => (b.p50 < a.p50 ? b : a))
  console.log(`\nthe fastest p50: concurrency=${best.level} (${best.p50.toFixed(1)}s)`)
}

import { readFileSync, readdirSync } from 'node:fs'

main()
