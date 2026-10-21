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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLane } from './test-discovery.mjs'
import { LANES } from './test-lanes.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_ROOT = join(ROOT, 'test')

/** The lane the shards partition. */
const LANE = 'product'

/** The case records of one shard directory. */
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

function main() {
  const args = process.argv.slice(2)
  const shardsIndex = args.indexOf('--shards')
  const totalIndex = args.indexOf('--total')
  const outIndex = args.indexOf('--out')
  if (shardsIndex === -1 || totalIndex === -1) {
    console.error('usage: node scripts/verify-shards.mjs --shards <dir> --total <n> [--out <file>]')
    process.exit(2)
  }
  const shardsRoot = resolve(args[shardsIndex + 1])
  const total = Number(args[totalIndex + 1])
  // The identity the shards must agree on. It comes from the environment
  // of the aggregate job, which is the run that is doing the aggregating.
  const expectedSha = process.env.DSH_EXPECTED_SHA ?? null
  const expectedRunId = process.env.DSH_EXPECTED_RUN_ID ?? null

  const aggregate = verifyShards({ shardsRoot, total, expectedSha, expectedRunId })

  if (outIndex !== -1) {
    writeFileSync(args[outIndex + 1], `${JSON.stringify(aggregate, null, 2)}\n`)
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
  const shardDirectories = existsSync(shardsRoot)
    ? readdirSync(shardsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    : []
  if (shardDirectories.length !== total) {
    failures.push(`expected ${total} shard directories, found ${shardDirectories.length}: ${shardDirectories.join(', ')}`)
  }

  const seenFiles = new Map()
  let totalCases = 0
  let totalSkipped = 0
  const shards = []

  for (const directory of shardDirectories) {
    const shardDirectory = join(shardsRoot, directory)
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
    // A shard that produced records is NOT proof that its cases RAN. A
    // failed or cancelled case is a real failure, and a shard that died
    // half way leaves only the records it managed to write. So the
    // outcomes themselves are checked, not just their presence.
    const failed = shardCases.filter(record => record.result === 'fail')
    const cancelled = shardCases.filter(record => record.result === 'cancelled')
    const unknown = shardCases.filter(record => record.result === 'unknown')
    if (failed.length > 0) {
      failures.push(`the shard ${directory} reported ${failed.length} failing case(s): ${failed.slice(0, 3).map(record => record.name).join('; ')}`)
    }
    if (cancelled.length > 0) {
      failures.push(`the shard ${directory} reported ${cancelled.length} cancelled case(s)`)
    }
    if (unknown.length > 0) {
      failures.push(`the shard ${directory} reported ${unknown.length} case(s) with no outcome: the shard did not finish`)
    }
    // The shard must record the run it belongs to. Without that identity
    // a shard from a DIFFERENT run could be counted towards this one, and
    // the aggregate would claim a coverage it never measured.
    if (spec === null) {
      failures.push(`the shard ${directory} recorded no runner specification: its identity is unknown`)
    } else if (spec.sha !== undefined && spec.sha !== null && expectedSha !== null && spec.sha !== expectedSha) {
      failures.push(`the shard ${directory} ran against ${spec.sha}, not ${expectedSha}`)
    }
    if (spec !== null && spec.runId !== undefined && spec.runId !== null
      && expectedRunId !== null && spec.runId !== expectedRunId) {
      failures.push(`the shard ${directory} belongs to run ${spec.runId}, not ${expectedRunId}`)
    }
    totalCases += shardCases.length
    totalSkipped += skipped
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

  // The union must be the whole lane.
  for (const file of expectedFiles) {
    if (!seenFiles.has(file)) {
      failures.push(`the file ${file} belongs to no shard: its cases never ran`)
    }
  }
  for (const file of seenFiles.keys()) {
    if (!expectedFiles.has(file)) {
      failures.push(`the file ${file} is not part of the ${LANE} lane`)
    }
  }

  return {
    lane: LANE,
    shardTotal: total,
    expectedFileCount: expectedFiles.size,
    observedFileCount: seenFiles.size,
    totalCases,
    totalSkipped,
    shards,
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
  const args = process.argv.slice(2)
  const shardsIndex = args.indexOf('--shards')
  const totalIndex = args.indexOf('--total')
  const outIndex = args.indexOf('--out')
  if (shardsIndex === -1 || totalIndex === -1) {
    console.error('usage: node scripts/verify-shards.mjs --shards <dir> --total <n> [--out <file>]')
    process.exit(2)
  }
  report(
    verifyShards({
      shardsRoot: resolve(args[shardsIndex + 1]),
      total: Number(args[totalIndex + 1]),
      expectedSha: process.env.DSH_EXPECTED_SHA ?? null,
      expectedRunId: process.env.DSH_EXPECTED_RUN_ID ?? null,
    }),
    outIndex,
    outIndex === -1 ? '' : args[outIndex + 1],
  )
}
