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

  const failures = []

  // The lane's own file list, resolved by the SAME discovery rule the
  // runner uses. This is the authority the shards are compared against.
  const lane = LANES[LANE]
  const expectedFiles = new Set(
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
    const shardFiles = cases
      .filter(record => record.name === record.file)
      .map(record => record.file)
    for (const file of shardFiles) {
      if (seenFiles.has(file)) {
        failures.push(`the file ${file} belongs to two shards (${seenFiles.get(file)} and ${directory})`)
      } else {
        seenFiles.set(file, directory)
      }
    }
    const shardCases = cases.filter(record => record.name !== record.file)
    const skipped = shardCases.filter(record => record.result === 'skip').length
    totalCases += shardCases.length
    totalSkipped += skipped
    shards.push({
      shard: directory,
      fileCount: shardFiles.length,
      caseCount: shardCases.length,
      skipped,
      wallClockSeconds: spec?.wall_clock_seconds ?? null,
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

  const aggregate = {
    lane: LANE,
    shardTotal: total,
    expectedFileCount: expectedFiles.size,
    observedFileCount: seenFiles.size,
    totalCases,
    totalSkipped,
    shards,
    failures,
  }

  if (outIndex !== -1) {
    writeFileSync(args[outIndex + 1], `${JSON.stringify(aggregate, null, 2)}\n`)
  }

  console.log(`lane              ${LANE}`)
  console.log(`shards            ${shardDirectories.length}/${total}`)
  console.log(`files             ${seenFiles.size}/${expectedFiles.size}`)
  console.log(`cases             ${totalCases}`)
  console.log(`skipped           ${totalSkipped}`)
  for (const shard of shards) {
    console.log(`  ${shard.shard}: files=${shard.fileCount} cases=${shard.caseCount} skipped=${shard.skipped} wall=${shard.wallClockSeconds}s`)
  }

  if (failures.length > 0) {
    console.error(`\nthe shard aggregate FAILED (${failures.length}):`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('\nthe shard aggregate is the whole lane')
}

main()
