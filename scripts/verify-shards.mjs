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
 * It also checks, per file, that a file which reported itself reported at
 * least one real TEST. That is a WEAKER claim than a case count and it is
 * deliberately so: a committed total has to be edited by every commit that
 * adds a test, which makes an ordinary PR fail for doing the right thing.
 * The limit is stated rather than papered over — this proves "the file ran
 * something", NOT "every test that used to be in the file still runs". A
 * SUITE is not a test: `describe('x', () => {})` reports a suite and zero
 * tests, so suites are excluded from this check.
 *
 * Skip REASONS are classified against a committed policy. That is a
 * qualification boundary and it is independent of any count: the policy says
 * WHICH reasons are acceptable in this environment, not how many skips there
 * may be.
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
 * The parameters the RUNNER actually applied, as it recorded them.
 *
 * This is not what the workflow asked for: it is what the runner put on the
 * child's command line. `null` when the shard recorded nothing, which is a
 * failure when the aggregate expects a specific configuration.
 */
function readEffectiveParams(shardDirectory) {
  const path = join(shardDirectory, 'effective-params.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The shard argument a shard directory names.
 *
 * `product-diagnostics-shard-2-node24` is the artifact of `--shard=2/<total>`.
 * A directory that does not name a shard has no expected index, so the
 * comparison is skipped rather than invented.
 */
function shardIndexOf(directory, total) {
  // `shard-2`, `product-diagnostics-shard-2-node24` — the index is the
  // digits after `shard-`, and any `-node<version>` suffix is not part of
  // the shard argument.
  const match = /shard-(\d+)(?:-node[\d.]+)?$/u.exec(directory)
  if (match === null) return null
  return `${match[1]}/${total}`
}

/**
 * A run attempt as a positive integer, or null when the value is not one.
 *
 * `GITHUB_RUN_ATTEMPT` reaches `runner-spec.json` as a string, while a
 * synthetic or future record may carry a JSON number; both are the same
 * attempt. Everything else — `0`, a negative number, a fraction, an empty
 * string, a missing field or a non-numeric value — is not an attempt and must
 * never be compared as one.
 *
 * A workflow re-run keeps the same run id and the same commit and only
 * advances this number, so it is the EXECUTION GENERATION: a bounded
 * comparison over `1..currentAttempt`, not equality and not "any value".
 *
 * @param {unknown} value - the recorded or expected attempt.
 * @returns {number|null} the attempt, or null when it is not a positive integer.
 */
function parseRunAttempt(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null
  return Number(value)
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
 * The skip REASONS this qualification accepts, as regular expressions.
 *
 * A skip is not a pass and it is not a failure: it is a case that did not
 * run. Accepting it requires knowing WHY, so the accepted reasons are a
 * committed POLICY rather than a tolerance for "some skips". The policy is
 * independent of any count — it says which reasons are legitimate in this
 * environment, not how many skips may occur.
 *
 * @returns {RegExp[]|null} the accepted patterns, or null when the caller
 *   does not classify skips.
 */
function acceptedSkipPatterns() {
  const file = process.env.DSH_ACCEPTED_SKIPS_FILE
  if (file === undefined || file === '') return null
  if (!existsSync(file)) {
    throw new Error(`the accepted-skip policy ${file} is missing: an absent policy must not disable the check`)
  }
  const patterns = readFileSync(file, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .map(line => new RegExp(line, 'u'))
  if (patterns.length === 0) {
    throw new Error(`the accepted-skip policy ${file} states no reason: that would accept no skip at all, which is not a policy`)
  }
  return patterns
}

/**
 * The identity and the applied configuration the shards must agree on.
 *
 * They come from the environment of the aggregate job, which is the run that
 * is doing the aggregating. Every value is OPTIONAL at the level of this
 * reader and REQUIRED at the level of the qualification it serves: a check
 * that is not given an expectation does not run.
 *
 * There is deliberately NO committed case or skip COUNT here. A hand-written
 * total is a measurement device, not a delivery gate: every change to the
 * test tree would have to edit it in the same commit, and an ordinary PR that
 * adds a test would fail the pipeline until it did. What this aggregate
 * proves instead is STRUCTURE — the shards are the whole lane, every file
 * contributes cases, every outcome is accepted, and the parameters the runner
 * applied are the ones the workflow claims. The totals are reported so a
 * deliberate measurement can read them; they are not compared to a constant.
 *
 * @returns {object} the expectations.
 */
function readExpectations() {
  return {
    expectedSha: process.env.DSH_EXPECTED_SHA ?? null,
    expectedRunId: process.env.DSH_EXPECTED_RUN_ID ?? null,
    expectedRunAttempt: process.env.DSH_EXPECTED_RUN_ATTEMPT ?? null,
    // The concurrency the run claims to be about. `0` is not a level, so it
    // cannot be written by accident; the workflow passes the resolved level
    // (or `default` when no flag is applied, which the runner records as
    // `null`).
    expectedConcurrency: expectedConcurrencyBaseline(),
    acceptedSkips: acceptedSkipPatterns(),
  }
}

/**
 * The concurrency level the measurement claims to have applied.
 *
 * THREE states, because "the level is Node's default" and "there is no
 * expectation" must not collapse into the same value:
 *
 *   - `undefined` — no level is asserted, so no concurrency check runs;
 *   - `'default'` — the run claims Node's own default, so the runner must
 *     have recorded `null` (no flag). This is the state that catches a run
 *     that CLAIMS default and silently applied a number;
 *   - a number — the run claims that explicit level.
 */
function expectedConcurrencyBaseline() {
  const raw = process.env.DSH_EXPECTED_CONCURRENCY
  if (raw === undefined || raw === '') return undefined
  if (raw === 'default') return 'default'
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`DSH_EXPECTED_CONCURRENCY must be a positive integer or "default", got: ${raw}`)
  }
  return value
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
  // WHERE the baseline came from. A count on its own says nothing about
  // which run produced it, and a qualification has to be able to answer
  // that question from its own report.
  // The shape this run CLAIMED, as one line the context job resolved. It goes
  // into the report so a reader never has to correlate the aggregate with the
  // workflow log to learn which shard count and concurrency it proved.
  const configIndex = args.indexOf('--effective-config')
  if (shardsIndex === -1 || totalIndex === -1) {
    console.error('usage: node scripts/verify-shards.mjs --shards <dir> --total <n> [--out <file>] [--expected-files <file>] [--effective-config <text>]')
    console.error('the expectations are read from the environment:')
    console.error('  DSH_EXPECTED_SHA, DSH_EXPECTED_RUN_ID, DSH_EXPECTED_RUN_ATTEMPT,')
    console.error('  DSH_EXPECTED_CONCURRENCY, DSH_ACCEPTED_SKIPS_FILE')
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
      effectiveConfig: configIndex === -1 ? null : args[configIndex + 1],
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
  expectedConcurrency = undefined,
  acceptedSkips = undefined,
  effectiveConfig = null,
  expectedFiles: expectedFilesOverride,
}) {
  const failures = []
  const acceptedSkipPatternsOrNone = acceptedSkips === undefined ? null : acceptedSkips

  // The execution generation this aggregate is proving. A re-run of the same
  // workflow keeps the run id and the commit and only advances the attempt, so
  // the shard records must be in `1..currentAttempt`; a future attempt belongs
  // to a run that has not happened yet and is rejected. The expectation itself
  // is validated: an unusable value must fail the proof, not silently disable
  // the check.
  const expectedAttempt = expectedRunAttempt === null ? null : parseRunAttempt(expectedRunAttempt)
  if (expectedRunAttempt !== null && expectedAttempt === null) {
    failures.push(`the expected run attempt ${JSON.stringify(expectedRunAttempt)} is not a positive integer: the execution generation cannot be checked`)
  }

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
    // The shard SLOT each directory claims, inside this Node version's
    // partition. Two directories naming the same slot would mean one shard
    // measured twice and another not at all — a partition is a set of
    // DISTINCT slots, not merely `total` directories.
    const seenSlots = new Map()
    // The version's own counts are filled in after its shards are counted.
    if (directories.length !== total) {
      failures.push(`expected ${total} shard directories for Node ${version}, found ${directories.length}: ${directories.join(', ')}`)
    }
    for (const shardDirectory of directories) {
    const directory = basename(shardDirectory)
    const slot = shardIndexOf(directory, total)
    if (slot !== null) {
      if (seenSlots.has(slot)) {
        failures.push(`the shard slot ${slot} is claimed by two directories (${seenSlots.get(slot)} and ${directory}): a partition has distinct slots`)
      } else {
        seenSlots.set(slot, directory)
      }
    }
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
    // Every FILE that reported itself must also report at least one real TEST.
    //
    // The file partition proves every file was covered; it cannot see that a
    // file's tests were dropped on the way to the recorder. A committed case
    // count would catch more, and it is the wrong instrument for a delivery
    // pipeline: every commit that adds a test would have to edit that number,
    // so an ordinary PR would fail the build for doing the right thing.
    //
    // A SUITE is NOT a test. `describe('x', () => {})` reports one suite and
    // zero tests, so counting every non-file record would let an empty suite
    // stand in for a case. The recorder marks a missing type as `test`, which
    // is why SUITE is the only exclusion.
    const filesWithCases = new Set(
      shardCases
        .filter(record => record.type !== 'suite')
        .map(record => record.file)
        .filter(file => file !== undefined)
        .map(toTestRootPath),
    )
    const silent = shardFiles.filter(file => !filesWithCases.has(file))
    if (silent.length > 0) {
      failures.push(`the shard ${directory} reported ${silent.length} file(s) with no test record: ${silent.slice(0, 3).join(', ')}`)
    }
    // Every skip must state a reason, and the reason must be one this
    // qualification accepts.
    //
    // A count cannot do this job: a hundred skips are evidence only if they
    // are the SAME KIND of skip. A case that starts skipping itself for a new
    // reason — a broken fixture, a missing tool the runner used to have —
    // would keep any total identical and look like a healthy run.
    if (acceptedSkipPatternsOrNone !== null && skipped > 0) {
      const unclassified = []
      for (const record of shardCases) {
        if (record.result !== 'skip') continue
        const reason = record.skipReason
        if (reason === null || reason === undefined || reason === '') {
          unclassified.push(`${record.name} (no reason stated)`)
          continue
        }
        if (!acceptedSkipPatternsOrNone.some(pattern => pattern.test(reason))) {
          unclassified.push(`${record.name} (${reason})`)
        }
      }
      if (unclassified.length > 0) {
        failures.push(`the shard ${directory} skipped ${unclassified.length} case(s) for a reason the policy does not accept: ${unclassified.slice(0, 3).join('; ')}`)
      }
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
      if (expectedAttempt !== null) {
        // A re-run of the same workflow has the same run id and the same
        // commit, and only the attempt tells them apart. An artifact from an
        // EARLIER attempt is still valid evidence when the shard itself was
        // not re-run: a partial re-run of failed jobs keeps the successful
        // shards of the previous attempt, so the bounded range is what makes
        // the recovered aggregate possible. A FUTURE attempt cannot belong to
        // this run, and an unusable value is not an attempt at all.
        const recordedAttempt = parseRunAttempt(spec.runAttempt)
        if (recordedAttempt === null) {
          failures.push(`the shard ${directory} recorded no valid run attempt (${JSON.stringify(spec.runAttempt)}): a positive integer is required`)
        } else if (recordedAttempt > expectedAttempt) {
          failures.push(`the shard ${directory} belongs to attempt ${recordedAttempt}, which is newer than this run's attempt ${expectedAttempt}`)
        }
      }
    }
    totalCases += shardCases.length
    totalSkipped += skipped
    group.cases += shardCases.length
    group.skipped += skipped
    // The EFFECTIVE parameters the runner applied.
    //
    // The workflow knows what it intended; the runner recorded what it put
    // on the child's command line. Those two differ when an argument is
    // accepted and then dropped — which is exactly how five CI runs were
    // once reported as a concurrency comparison while every one of them ran
    // at Node's default.
    //
    // A measurement whose applied parameters are not the ones it claims is
    // not a measurement of that configuration, so a mismatch FAILS.
    // The shard INDEX is part of the identity: the directory names the
    // shard the artifact belongs to, and the runner recorded the shard it
    // was given. If they disagree, the artifact is filed under a shard
    // whose coverage it does not hold.
    //
    // The concurrency is checked only when the run ASSERTS a level. The
    // check exists because an argument accepted and then dropped is not
    // hypothetical: five CI runs were once reported as a concurrency
    // comparison while every one of them ran at Node's default.
    const applied = readEffectiveParams(shardDirectory)
    if (applied === null) {
      failures.push(`the shard ${directory} recorded no effective parameters: what it actually ran is unknown`)
    } else {
      if (slot !== null && applied.shard !== slot) {
        failures.push(`the shard ${directory} ran the shard ${applied.shard}, not ${slot}`)
      }
      if (expectedConcurrency === 'default') {
        if (applied.testConcurrency !== null) {
          failures.push(`the shard ${directory} claims Node's default concurrency but ran at ${applied.testConcurrency}`)
        }
      } else if (expectedConcurrency !== undefined && applied.testConcurrency !== expectedConcurrency) {
        const actual = applied.testConcurrency === null ? "Node's default" : String(applied.testConcurrency)
        failures.push(`the shard ${directory} ran at ${actual}, not the measured ${expectedConcurrency}`)
      }
    }
    shards.push({
      shard: directory,
      fileCount: shardFiles.length,
      caseCount: shardCases.length,
      skipped,
      failed: failed.length,
      cancelled: cancelled.length,
      sha: spec?.sha ?? null,
      runId: spec?.runId ?? null,
      // The EXECUTION GENERATION this shard was produced by. A partial re-run
      // legitimately leaves a mix of attempts in one aggregate, so the report
      // shows each shard's attempt instead of a single run-level number.
      runAttempt: spec?.runAttempt ?? null,
      applied: applied === null ? null : {
        shard: applied.shard,
        testConcurrency: applied.testConcurrency,
        laneFileCount: applied.laneFileCount,
      },
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

  return {
    lane: LANE,
    shardTotal: total,
    expectedFileCount: expectedFiles.size,
    observedFileCount: observedFileCount,
    totalCases,
    totalSkipped,
    // The shape the context job resolved for THIS run: shard count, matrix
    // cap, intra-shard concurrency and mode, in one line.
    effectiveConfig,
    // What the run CLAIMED, in the same shape the shards recorded what they
    // APPLIED, so a reader can compare the two sides directly.
    expectedConcurrency: expectedConcurrency === undefined ? null : expectedConcurrency,
    // Whether the skip REASONS were classified, and against how many accepted
    // classes. A reader must be able to tell "no unaccepted skip" from "no
    // policy was applied".
    skipPolicy: acceptedSkipPatternsOrNone === null
      ? null
      : { acceptedClasses: acceptedSkipPatternsOrNone.length, enforced: true },
    // The distinct attempts this partition was produced by. A normal run has
    // one; a partial re-run of failed jobs legitimately has several, and the
    // report says so instead of hiding the generation the evidence came from.
    runAttempts: [...new Set(shards.map(shard => shard.runAttempt).filter(attempt => attempt !== null))],
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
  // The execution generations the evidence came from. A partial re-run keeps
  // the successful shards of an earlier attempt, so a mixed list is expected
  // and must be visible in the report instead of being read as one attempt.
  const attempts = aggregate.runAttempts ?? []
  console.log(`attempts          ${attempts.length === 0 ? '(none recorded)' : attempts.join(', ')}${attempts.length > 1 ? ' (mixed by partial re-run)' : ''}`)
  for (const shard of aggregate.shards) {
    console.log(`  ${shard.shard}: attempt=${shard.runAttempt ?? '(none)'} files=${shard.fileCount} cases=${shard.caseCount} skipped=${shard.skipped} failed=${shard.failed} wall=${shard.wallClockSeconds}s`)
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
