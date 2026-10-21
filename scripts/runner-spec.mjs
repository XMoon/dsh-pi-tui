#!/usr/bin/env node
/**
 * The RUNNER SPECIFICATION: what machine actually ran the tests.
 *
 * The CI critical-path work needs facts, not guesses: how many CPUs the
 * runner really has, whether a cgroup CPU quota caps it, how much memory
 * it may use, and which Node/pnpm/OS actually ran.
 *
 * Every value is MEASURED or reported as UNAVAILABLE. A missing cgroup file
 * is reported as missing — the public "2-core" label of a runner family is
 * not a measurement and is never substituted for one.
 *
 * Usage: node scripts/runner-spec.mjs [--out runner-spec.json]
 * @module @xmoon76/dsh-pi-tui/scripts/runner-spec
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { arch, availableParallelism, cpus, platform, release, totalmem } from 'node:os'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Read a file, or report that it is not there. Never guesses a value. */
function readOrAbsent(path) {
  try {
    return { present: true, value: readFileSync(path, 'utf8').trim() }
  } catch (error) {
    return { present: false, value: null, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The cgroup CPU quota, when the host exposes one.
 *
 * `cpu.max` is the cgroup v2 form (`<quota> <period>`, or `max <period>` for
 * an unlimited quota); `cpu.cfs_quota_us` / `cpu.cfs_period_us` are the
 * cgroup v1 forms. A missing file is reported as absent, never as "unlimited".
 */
function cpuQuota() {
  const v2 = readOrAbsent('/sys/fs/cgroup/cpu.max')
  if (v2.present) {
    const [quota, period] = v2.value.split(/\s+/u)
    return {
      cgroupVersion: 'v2',
      raw: v2.value,
      quotaUs: quota === 'max' ? null : Number(quota),
      periodUs: period === undefined ? null : Number(period),
    }
  }
  const quota = readOrAbsent('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')
  const period = readOrAbsent('/sys/fs/cgroup/cpu/cpu.cfs_period_us')
  if (quota.present && period.present) {
    const quotaUs = Number(quota.value)
    const periodUs = Number(period.value)
    return {
      cgroupVersion: 'v1',
      raw: `${quota.value} ${period.value}`,
      quotaUs: quotaUs < 0 ? null : quotaUs,
      periodUs,
    }
  }
  return { cgroupVersion: null, raw: null, quotaUs: null, periodUs: null, available: false }
}

/** The cgroup memory limit, when the host exposes one. */
function memoryLimit() {
  const v2 = readOrAbsent('/sys/fs/cgroup/memory.max')
  if (v2.present) {
    return { cgroupVersion: 'v2', raw: v2.value, bytes: v2.value === 'max' ? null : Number(v2.value) }
  }
  const v1 = readOrAbsent('/sys/fs/cgroup/memory/memory.limit_in_bytes')
  if (v1.present) {
    return { cgroupVersion: 'v1', raw: v1.value, bytes: Number(v1.value) }
  }
  return { cgroupVersion: null, raw: null, bytes: null, available: false }
}

/** A command's output, or the reason it could not be read. */
function command(command, args) {
  try {
    return { present: true, value: execFileSync(command, args, { encoding: 'utf8' }).trim() }
  } catch (error) {
    return { present: false, value: null, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function collectRunnerSpec() {
  const pnpm = command('pnpm', ['--version'])
  return {
    // The IDENTITY of the run, in the two short forms the aggregate proof
    // compares. A shard that does not agree with the aggregating run on
    // these is a shard of a DIFFERENT run, and counting it would claim a
    // coverage nobody measured.
    sha: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    node: {
      version: process.version,
      execPath: process.execPath,
    },
    pnpm: pnpm.present ? { version: pnpm.value } : { version: null, unavailable: pnpm.reason },
    os: {
      platform: platform(),
      release: release(),
      arch: arch(),
      totalMemoryBytes: totalmem(),
    },
    cpu: {
      cpus: cpus().length,
      model: cpus()[0]?.model ?? null,
      availableParallelism: availableParallelism(),
    },
    cgroup: {
      cpu: cpuQuota(),
      memory: memoryLimit(),
    },
    runner: {
      name: process.env.RUNNER_NAME ?? null,
      os: process.env.RUNNER_OS ?? null,
      arch: process.env.RUNNER_ARCH ?? null,
      environment: process.env.RUNNER_ENVIRONMENT ?? null,
      imageOs: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
      githubRunId: process.env.GITHUB_RUN_ID ?? null,
      githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      githubSha: process.env.GITHUB_SHA ?? null,
    },
  }
}

function main() {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf('--out')
  const wallIndex = args.indexOf('--wall-clock-seconds')
  const spec = collectRunnerSpec()
  if (wallIndex !== -1) {
    // The measured wall clock is a FIELD of the specification, not a line
    // appended to the file: appending `wall_clock_seconds=123` to a JSON
    // document makes it invalid JSON, and every reader of it would then
    // fail to parse the very file that holds the measurement.
    spec.wallClockSeconds = Number(args[wallIndex + 1])
  }
  if (outIndex !== -1) {
    writeFileSync(args[outIndex + 1], `${JSON.stringify(spec, null, 2)}\n`)
  }
  console.log(JSON.stringify(spec, null, 2))
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
