#!/usr/bin/env node
/**
 * The SHARD AGGREGATE PROOF: the shards together are the whole lane.
 *
 * Splitting a lane across runners is only safe if the shards are exactly a
 * partition of it. Three things can go wrong, and all three are silent in
 * a green CI summary:
 *
 *   - a LOST file: a file belongs to no shard, so its cases never ran;
 *   - an OVERLAPPED file: a file belongs to two shards, so its cases ran
 *     twice and the total is inflated;
 *   - a SKIPPED shard: the shard job did not run, so a third of the lane
 *     was never measured, and the summary would still look complete.
 *
 * So the aggregate compares the shards' FILE LISTS against the lane's own
 * file list — resolved by the SAME discovery rule the runner uses — and
 * fails closed on any difference.
 *
 * It also checks the CASE counts: the shards' cases must add up to the
 * lane's own case count, and no shard may report a skip the unsharded lane
 * does not have.
 *
 * Usage:
 *   node scripts/verify-shards.mjs --shards shards --total 4 --out aggregate.json
 * @module @xmoon76/dsh-pi-tui/scripts/verify-shards
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLane } from './test-discovery.mjs'
import { LANES } from './test-lanes.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_ROOT = join(ROOT, 'test')

/** The lane the shards partition. */
const LANE = 'product'

/** The case records of one shard directory. */
/**
 * The expected skip count baseline: one number, or a per-version map.
 *
 * @returns {number|Record<string, number>|null} the baseline.
 */
function expectedSkippedBaseline() {
  const raw = process.env.DSH_EXPECTED_SKIPPED
  if (raw === undefined || raw === '') return null
  if (raw.trimStart().startsWith('{')) {
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error(`DSH_EXPECTED_SKIPPED is not a valid per-version map: ${raw}`)
    }
  }
  return Number(raw)
}

/**
 * The expected skip count for a Node version.
 *
 * The baseline is one number for the whole run, unless it is a
 * PER-VERSION map: `{"22.19.0": 31, "24": 37}`. A Node version can
 * legitimately skip a different number of cases than another — the
 * optional-bundle skip depends on what that version's environment
 * provides.
 *
 * @param {string} version - the Node version.
 * @returns {number|null} the expected skip count, or null when it is unknown.
 */
function expectedSkippedFor(version, baseline) {
  if (baseline === null || baseline === undefined) return null
  if (typeof baseline === 'object') {
    const value = baseline[version]
    return value === undefined ? null : value
  }
  if (Number.isNaN(baseline)) return null
  return baseline
}

/**
 * The Node version a shard directory ran on.
 *
 * The directories are `<shard>-node<version>`; a directory that does not
 * carry a version is its own group.
 *
 * @param {string} directory - the directory path.
 * @returns {string} the Node version, or '(unversioned)'.
 */
function nodeVersionOf(directory) {
  const match = /-node(\d+(?:\.\d+)*)$/u.exec(basename(directory))
  return match === null ? '(unversioned)' : match[1]
}

/**
 * The directories that hold shard records.
 *
 * A shard's records are the `cases.jsonl` file. They are found by
 * looking for that file: in a per-artifact subdirectory, or directly in
 * the root when a single artifact matched the download pattern.
 *
 * @param {string} shardsRoot - the directory the shards were downloaded into.
 * @returns {string[]} the directories that hold shard records.
 */
function findShardDirectories(shardsRoot) {
  if (!existsSync(shardsRoot)) return []
  const entries = readdirSync(shardsRoot, { withFileTypes: true })
  const directories = entries.filter(entry => entry.isDirectory()).map(entry => join(shardsRoot, entry.name))
  // The FLAT layout: the records sit directly in the root.
  if (existsSync(join(shardsRoot, 'cases.jsonl'))) directories.push(shardsRoot)
  return directories
}

function readShardCases(shardDirectory) {
  const jsonl = join(shardDirectory, 'cases.jsonl')
  if (!existsSync(jsonl)) return []
  return readFileSync(jsonl, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

/** The runner specification a shard recorded. */
function readShardSpec(shardDirectory) {
  const path = join(shardDirectory, 'runner-spec.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * A recorded file path in the TEST-root form the discovery rule uses.
 *
 * The reporter records the path relative to the repository root, because
 * that is the form a reader of a case record wants. The discovery rule
 * returns it relative to the test root. The comparison must be between
 * the two FORMS of one path, so the repository prefix is removed here.
 */
function toTestRootPath(path) {
  const normalized = path.split('\\').join('/')
  return normalized.startsWith('test/') ? normalized.slice('test/'.length) : normalized
}

/**
 * The identity and the baseline the shards must agree on.
 *
 * They come from the environment of the aggregate job, which is the run
 * that is doing the aggregating. Every value is OPTIONAL at the level of
 * this reader and REQUIRED at the level of the qualification it serves:
 * a check that is not given an expectation does not run, and a workflow
 * that wants the check must therefore pass the expectation.
 *
 * @returns {object} the expectations.
 */
function readExpectations() {
  const number = (name) => {
    const raw = process.env[name]
    if (raw === undefined || raw === '') return null
    const value = Number(raw)
    // A malformed number is a FAILURE, not a missing expectation: a
    // baseline that cannot be read must not silently disable the check.
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer, got: ${raw}`)
    }
    return value
  }
  return {
    expectedSha: process.env.DSH_EXPECTED_SHA ?? null,
    expectedRunId: process.env.DSH_EXPECTED_RUN_ID ?? null,
    expectedRunAttempt: process.env.DSH_EXPECTED_RUN_ATTEMPT ?? null,
    expectedCases: number('DSH_EXPECTED_CASES'),
    expectedSkipped: expectedSkippedBaseline(),
  }
}

function main() {
  const args = process.argv.slice(2)
  const shardsIndex = args.indexOf('--shards')
  const totalIndex = args.indexOf('--total')
  const outIndex = args.indexOf('--out')
  // The expected file list. It defaults to the lane's own file list, and
  // may be overridden with a file that lists them — one per line — so the
  // CLI can be exercised against a synthetic lane.
  const filesIndex = args.indexOf('--expected-files')
  if (shardsIndex === -1 || totalIndex === -1) {
    console.error('usage: node scripts/verify-shards.mjs --shards <dir> --total <n> [--out <file>] [--expected-files <file>]')
    console.error('the expectations are read from the environment:')
    console.error('  DSH_EXPECTED_SHA, DSH_EXPECTED_RUN_ID, DSH_EXPECTED_RUN_ATTEMPT,')
    console.error('  DSH_EXPECTED_CASES, DSH_EXPECTED_SKIPPED')
    process.exit(2)
  }
  const expectedFiles = filesIndex === -1
    ? undefined
    : new Set(readFileSync(args[filesIndex + 1], 'utf8').split('\n').filter(Boolean))
  report(
    verifyShards({
      shardsRoot: resolve(args[shardsIndex + 1]),
      total: Number(args[totalIndex + 1]),
      expectedFiles,
      ...readExpectations(),
    }),
    outIndex,
    outIndex === -1 ? '' : args[outIndex + 1],
  )
}

/**
 * Verify that the shards are a partition of the lane.
 *
 * The function is exported so the gate test can drive it with synthetic
 * shards: a fail-closed proof that is only exercised by a real CI run
 * cannot be shown to fail closed.
 *
 * @param {{shardsRoot: string, total: number, expectedSha?: string|null, expectedRunId?: string|null, expectedFiles?: Set<string>}} options
 * @returns {object} the aggregate report, including its failures.
 */
export function verifyShards({
  shardsRoot,
  total,
  expectedSha = null,
  expectedRunId = null,
  expectedRunAttempt = null,
  expectedCases = null,
  expectedSkipped = null,
  expectedFiles: expectedFilesOverride,
}) {
  const failures = []

  // The lane's own file list, resolved by the SAME discovery rule the
  // runner uses. This is the authority the shards are compared against.
  const lane = LANES[LANE]
  const expectedFiles = expectedFilesOverride ?? new Set(
    resolveLane(TEST_ROOT, lane.patterns, lane.suffixes, lane.exclude ?? []),
  )

  // The shards' own file lists, from the case records each shard produced.
  //
  // The shard directories are where each shard's records live. The
  // download puts them in a per-artifact subdirectory — EXCEPT when a
  // single artifact matched the pattern, which `actions/download-artifact`
  // extracts DIRECTLY into the target directory. So the records are found
  // by looking for them, not by assuming a layout.
  const shardDirectories = findShardDirectories(shardsRoot)

  // The shard directories are grouped by the Node version they ran on:
  // `<shard>-node<version>`. Each group is its OWN complete partition of
  // the lane, and each one has to prove that its union is the whole lane
  // and that its shards are pairwise disjoint.
  //
  // They must NOT be compared against each other: two Node versions run
  // the same files, so their file lists are identical, and a cross-version
  // comparison would report every file as belonging to two shards.
  const groups = new Map()
  for (const directory of shardDirectories) {
    const version = nodeVersionOf(directory)
    if (!groups.has(version)) groups.set(version, { version, directories: [], cases: 0, skipped: 0 })
    groups.get(version).directories.push(directory)
  }
  if (groups.size === 0) {
    failures.push(`expected ${total} shard directories, found 0`)
  }

  let totalCases = 0
  let totalSkipped = 0
  const shards = []
  const versions = []
  // Every Node version is a complete partition of the lane, so they all
  // observe the SAME file count. The first group's is the report's.
  let observedFileCount = 0

  for (const group of groups.values()) {
    const { version, directories } = group
    const seenFiles = new Map()
    // The version's own counts are filled in after its shards are counted.
    if (directories.length !== total) {
      failures.push(`expected ${total} shard directories for Node ${version}, found ${directories.length}: ${directories.join(', ')}`)
    }
    for (const shardDirectory of directories) {
    const directory = basename(shardDirectory)
    const cases = readShardCases(shardDirectory)
    const spec = readShardSpec(shardDirectory)
    if (cases.length === 0) {
      failures.push(`the shard ${directory} produced no case record: its run did not happen or did not complete`)
      continue
    }
    // The FILE entries are the shard's own file list: a file is reported
    // as one case whose name is the file's path.
    //
    // The reporter records the path relative to the REPOSITORY root
    // (`test/app/one.test.ts`), while the discovery rule returns it
    // relative to the TEST root (`app/one.test.ts`). Both forms are
    // normalised to the test-root form here, so the comparison is between
    // two forms of the same path and not between two different paths.
    const shardFiles = cases
      .filter(record => record.name === record.file)
      .map(record => toTestRootPath(record.file))
    for (const file of shardFiles) {
      if (seenFiles.has(file)) {
        failures.push(`the file ${file} belongs to two shards (${seenFiles.get(file)} and ${directory})`)
      } else {
        seenFiles.set(file, directory)
      }
    }
    const shardCases = cases.filter(record => record.name !== record.file)
    const skipped = shardCases.filter(record => record.result === 'skip').length
    // A shard that produced records is NOT proof that its cases RAN.
    //
    // The check is an ALLOW LIST, not a deny list: a case counts as
    // qualified only when its outcome is one this qualification accepts.
    // A deny list would pass a record whose `result` is missing (a
    // truncated or malformed JSONL line) and a `todo` (a case Node
    // recognised but did not prove), because neither is `fail`,
    // `cancelled` or `unknown` — and neither changes the case count or
    // the skip count, so the aggregate would accept a shard set that
    // never proved what it claims.
    //
    // `pass` and `skip` are the accepted outcomes: a case that ran and
    // passed, or a case that was skipped for a reason this qualification
    // accepts. A `todo` is a DECISION, not a pass — if a todo is ever
    // acceptable it has to be an explicit one.
    const ACCEPTED_RESULTS = new Set(['pass', 'skip'])
    const unacceptable = shardCases.filter(record => !ACCEPTED_RESULTS.has(record.result))
    if (unacceptable.length > 0) {
      const byResult = new Map()
      for (const record of unacceptable) {
        const key = record.result === undefined ? '(no result)' : String(record.result)
        byResult.set(key, (byResult.get(key) ?? 0) + 1)
      }
      const summary = [...byResult.entries()].map(([result, count]) => `${count} ${result}`).join(', ')
      failures.push(`the shard ${directory} reported ${unacceptable.length} case(s) whose outcome is not accepted: ${summary}`)
    }
    const failed = shardCases.filter(record => record.result === 'fail')
    const cancelled = shardCases.filter(record => record.result === 'cancelled')
    if (failed.length > 0) {
      failures.push(`the shard ${directory} reported ${failed.length} failing case(s): ${failed.slice(0, 3).map(record => record.name).join('; ')}`)
    }
    if (cancelled.length > 0) {
      failures.push(`the shard ${directory} reported ${cancelled.length} cancelled case(s)`)
    }
    // The shard must record the run it belongs to. Without that identity
    // a shard from a DIFFERENT run could be counted towards this one, and
    // the aggregate would claim a coverage it never measured.
    //
    // The identity is checked as a WHOLE: when the aggregate knows the
    // expected SHA or run id, a shard that does not carry it — because the
    // field is missing, null or empty — is rejected too. A check that only
    // compares the field when it happens to be present fails OPEN on a
    // specification that records nothing.
    if (spec === null) {
      failures.push(`the shard ${directory} recorded no runner specification: its identity is unknown`)
    } else {
      if (expectedSha !== null) {
        if (spec.sha === undefined || spec.sha === null || spec.sha === '') {
          failures.push(`the shard ${directory} recorded no commit SHA: its identity is unknown`)
        } else if (spec.sha !== expectedSha) {
          failures.push(`the shard ${directory} ran against ${spec.sha}, not ${expectedSha}`)
        }
      }
      if (expectedRunId !== null) {
        if (spec.runId === undefined || spec.runId === null || spec.runId === '') {
          failures.push(`the shard ${directory} recorded no run id: its identity is unknown`)
        } else if (spec.runId !== expectedRunId) {
          failures.push(`the shard ${directory} belongs to run ${spec.runId}, not ${expectedRunId}`)
        }
      }
      if (expectedRunAttempt !== null) {
        // A re-run of the same workflow has the same run id and the same
        // commit, and only the attempt tells them apart. An artifact from
        // an earlier attempt must not be counted towards this one.
        if (spec.runAttempt === undefined || spec.runAttempt === null || spec.runAttempt === '') {
          failures.push(`the shard ${directory} recorded no run attempt: its identity is unknown`)
        } else if (String(spec.runAttempt) !== String(expectedRunAttempt)) {
          failures.push(`the shard ${directory} belongs to attempt ${spec.runAttempt}, not ${expectedRunAttempt}`)
        }
      }
    }
    totalCases += shardCases.length
    totalSkipped += skipped
    group.cases += shardCases.length
    group.skipped += skipped
    shards.push({
      shard: directory,
      fileCount: shardFiles.length,
      caseCount: shardCases.length,
      skipped,
      failed: failed.length,
      cancelled: cancelled.length,
      sha: spec?.sha ?? null,
      runId: spec?.runId ?? null,
      wallClockSeconds: spec?.wallClockSeconds ?? null,
      availableParallelism: spec?.cpu?.availableParallelism ?? null,
    })
    }

    versions.push({ node: version, shardCount: directories.length, cases: group.cases, skipped: group.skipped })

    // The union must be the whole lane — for THIS Node version.
    if (versions.length === 1) observedFileCount = seenFiles.size
    for (const file of expectedFiles) {
      if (!seenFiles.has(file)) {
        failures.push(`the file ${file} belongs to no shard on Node ${version}: its cases never ran`)
      }
    }
    for (const file of seenFiles.keys()) {
      if (!expectedFiles.has(file)) {
        failures.push(`the file ${file} is not part of the ${LANE} lane (Node ${version})`)
      }
    }
  }

  // The case and skip BASELINE.
  //
  // The file partition proves that every test FILE was covered. It does
  // NOT prove that every CASE inside those files was recorded: a recorder
  // that silently dropped one case would still leave every file covered.
  // The counts are therefore compared against an independent baseline — the
  // unsharded lane's own totals — and a difference in either direction
  // fails: a missing case is a lost case, and an extra skip is a case that
  // did not run.
  //
  // The counts are compared PER GROUP, not across the whole run: each Node
  // version is its own partition, and a version may skip a different
  // number of cases than another — the optional-bundle skip depends on
  // what that version's environment provides.
  for (const group of groups.values()) {
    const cases = group.cases
    const skipped = group.skipped
    if (expectedCases !== null && !Number.isNaN(expectedCases)) {
      if (cases !== expectedCases) {
        failures.push(`the shards on Node ${group.version} recorded ${cases} case(s), but the baseline is ${expectedCases}`)
      }
    }
    // The expected skip count may be a PER-VERSION map: a Node version can
    // legitimately skip a different number of cases than another — the
    // optional-bundle skip depends on what that version's environment
    // provides.
    const expected = expectedSkippedFor(group.version, expectedSkipped)
    if (expected !== null && !Number.isNaN(expected)) {
      if (skipped !== expected) {
        failures.push(`the shards on Node ${group.version} recorded ${skipped} skipped case(s), but the baseline for that version is ${expected}`)
      }
    }
  }

  return {
    lane: LANE,
    shardTotal: total,
    expectedFileCount: expectedFiles.size,
    observedFileCount: observedFileCount,
    totalCases,
    totalSkipped,
    expectedCases,
    expectedSkipped,
    shards,
    versions,
    failures,
  }
}

function report(aggregate, outIndex, outPath) {
  if (outIndex !== -1) {
    writeFileSync(outPath, `${JSON.stringify(aggregate, null, 2)}\n`)
  }

  console.log(`lane              ${aggregate.lane}`)
  console.log(`shards            ${aggregate.shards.length}/${aggregate.shardTotal}`)
  console.log(`files             ${aggregate.observedFileCount}/${aggregate.expectedFileCount}`)
  console.log(`cases             ${aggregate.totalCases}`)
  console.log(`skipped           ${aggregate.totalSkipped}`)
  for (const shard of aggregate.shards) {
    console.log(`  ${shard.shard}: files=${shard.fileCount} cases=${shard.caseCount} skipped=${shard.skipped} failed=${shard.failed} wall=${shard.wallClockSeconds}s`)
  }

  if (aggregate.failures.length > 0) {
    console.error(`\nthe shard aggregate FAILED (${aggregate.failures.length}):`)
    for (const failure of aggregate.failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('\nthe shard aggregate is the whole lane')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
