/**
 * The SHARD AGGREGATE GATE: the proof that the shards are the whole lane
 * must FAIL CLOSED.
 *
 * A fail-closed proof that is only ever exercised by a real CI run cannot
 * be shown to fail closed — it is only shown to have passed once. So this
 * gate drives the verifier with SYNTHETIC shards and breaks each part of
 * the qualification in turn:
 *
 *   - a shard that is missing;
 *   - a shard that produced no record;
 *   - a file that belongs to no shard;
 *   - a file that belongs to two shards;
 *   - a case that FAILED;
 *   - a case that was CANCELLED;
 *   - a case with no outcome at all (the shard died half way);
 *   - a shard whose recorded run identity is a different run.
 *
 * Each of those must produce a failure. A proof that cannot fail is not a
 * proof.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/test-shard-aggregate.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { verifyShards } from '../../scripts/verify-shards.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** The lane's files, as a synthetic two-shard split. */
const FILES = ['app/one.test.ts', 'app/two.test.ts', 'tui/three.test.ts']

/**
 * Build a synthetic shard directory.
 *
 * The records use the REPOSITORY-root form the reporter writes
 * (`test/app/one.test.ts`), because that is the form a real shard's
 * records have.
 *
 * @param {string} root - the directory the shards live in.
 * @param {string} name - the shard's directory name.
 * @param {{files: string[], results?: Record<string, string>, spec?: object|null}} options
 */
function writeShard(root, name, { files, results = {}, skipReasons = {}, spec = { sha: 'sha-1', runId: 'run-1' }, applied = undefined }) {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  const records = []
  for (const file of files) {
    const repositoryPath = `test/${file}`
    // A FILE is reported as one case whose name is the file's own path.
    records.push({ file: repositoryPath, name: repositoryPath, line: 1, column: 1, nesting: 0, duration_ms: 1, result: 'pass' })
    // The result is taken AS GIVEN: a case with no result must stay
    // without one, so the aggregate's allow list can be exercised.
    const result = Object.hasOwn(results, file) ? results[file] : 'pass'
    const record = { file: repositoryPath, name: `the case in ${file}`, line: 2, column: 1, nesting: 0, duration_ms: 1, result }
    // A skip states WHY. The aggregate classifies that reason, so a fixture
    // that skips without one is a case the policy must reject.
    if (result === 'skip') {
      record.skipReason = Object.hasOwn(skipReasons, file) ? skipReasons[file] : null
    }
    records.push(record)
  }
  writeFileSync(join(directory, 'cases.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n')
  if (spec !== null) {
    writeFileSync(join(directory, 'runner-spec.json'), JSON.stringify(spec))
  }
  // The parameters the runner APPLIED. A shard that recorded none is a
  // shard whose configuration is unknown, and the aggregate rejects it —
  // so every VALID fixture carries them, exactly like a real shard does.
  // `applied: null` is how a case deliberately omits them.
  if (applied !== null) {
    const index = /shard-(\d+)/u.exec(name)?.[1] ?? '1'
    writeFileSync(join(directory, 'effective-params.json'), JSON.stringify(applied ?? {
      shard: `${index}/2`,
      testConcurrency: null,
      laneFileCount: files.length,
    }))
  }
  return directory
}

/** The expected file set of the synthetic lane. */
const EXPECTED = new Set(FILES)

test('a complete, disjoint split of the lane is accepted', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'] })
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED })
  assert.deepEqual(aggregate.failures, [], JSON.stringify(aggregate.failures, null, 2))
  assert.equal(aggregate.observedFileCount, 3)
  assert.equal(aggregate.totalCases, 3)
})

test('a MISSING shard fails the aggregate', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: FILES })
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED })
  assert.ok(aggregate.failures.length > 0, 'a missing shard must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /expected 2 shard directories .*found 1/u)
})

test('two Node versions are two SEPARATE partitions, and both are accepted', (t) => {
  // Each Node version runs the WHOLE lane, so the two versions have the
  // SAME file list. Comparing them against each other would report every
  // file as belonging to two shards — so each version is proved on its
  // own.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-versions-')
  // A DISJOINT split of the files, the same one for each Node version.
  const first = FILES.slice(0, 1)
  const second = FILES.slice(1)
  writeShard(root, 'shard-1-node24', { files: first })
  writeShard(root, 'shard-2-node24', { files: second })
  writeShard(root, 'shard-1-node22', { files: first })
  writeShard(root, 'shard-2-node22', { files: second })
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED })
  assert.deepEqual(aggregate.failures, [], JSON.stringify(aggregate, null, 2))
  assert.deepEqual(aggregate.versions.map(entry => entry.node).sort(), ['22', '24'])
  // Every version observed the whole lane.
  assert.equal(aggregate.observedFileCount, EXPECTED.size)
})

test('each Node version is compared against the baseline ON ITS OWN', (t) => {
  // A version may skip a different number of cases than another — the
  // optional-bundle skip depends on what that version's environment
  // provides. So the baseline is compared per version, not across the
  // whole run.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-version-baseline-')
  const first = FILES.slice(0, 1)
  const second = FILES.slice(1)
  writeShard(root, 'shard-1-node24', { files: first })
  writeShard(root, 'shard-2-node24', { files: second })
  writeShard(root, 'shard-1-node22', { files: first })
  writeShard(root, 'shard-2-node22', { files: second })
  // Each version runs the WHOLE lane, so each version's case count is the
  // lane's own count — the same number for every version. The fixture
  // writes one case per file.
  const cases = FILES.length
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED, expectedCases: cases, expectedSkipped: 0 })
  assert.deepEqual(aggregate.failures, [], JSON.stringify(aggregate.failures, null, 2))
  assert.deepEqual(aggregate.versions.map(entry => entry.node).sort(), ['22', '24'])
  // Each version reports its OWN counts.
  for (const version of aggregate.versions) {
    assert.equal(version.cases, cases, `Node ${version.node} must report its own case count`)
  }
})

test('a MISSING shard on ONE Node version fails that version', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-version-missing-')
  const first = FILES.slice(0, 1)
  const second = FILES.slice(1)
  writeShard(root, 'shard-1-node24', { files: first })
  writeShard(root, 'shard-1-node22', { files: first })
  writeShard(root, 'shard-2-node22', { files: second })
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED })
  assert.ok(aggregate.failures.length > 0, 'the version with a missing shard must fail')
  assert.match(aggregate.failures.join('\n'), /for Node 24/u)
})

test('a shard that produced NO record fails the aggregate', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: FILES })
  writeShard(root, 'shard-2', { files: [] })
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED })
  assert.ok(aggregate.failures.length > 0, 'an empty shard must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /produced no case record/u)
})

test('a LOST file fails the aggregate', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts'] })
  writeShard(root, 'shard-2', { files: ['app/two.test.ts'] })
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED })
  assert.ok(aggregate.failures.length > 0, 'a lost file must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /tui\/three\.test\.ts belongs to no shard/u)
})

test('an OVERLAPPED file fails the aggregate', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['app/two.test.ts', 'tui/three.test.ts'] })
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED })
  assert.ok(aggregate.failures.length > 0, 'an overlapped file must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /belongs to two shards/u)
})

test('a FAILED case fails the aggregate', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'], results: { 'tui/three.test.ts': 'fail' } })
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED })
  assert.ok(aggregate.failures.length > 0, 'a failed case must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /failing case/u)
})

test('a CANCELLED case fails the aggregate', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'], results: { 'tui/three.test.ts': 'cancelled' } })
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED })
  assert.ok(aggregate.failures.length > 0, 'a cancelled case must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /cancelled case/u)
})

test('a case with NO outcome fails the aggregate', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'], results: { 'tui/three.test.ts': 'unknown' } })
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED })
  assert.ok(aggregate.failures.length > 0, 'a case with no outcome must fail the aggregate')
  // The outcome is not accepted: it is neither a pass nor an accepted skip.
  assert.match(aggregate.failures.join('\n'), /outcome is not accepted/u)
})

test('a shard from a DIFFERENT run fails the aggregate', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', {
    files: ['tui/three.test.ts'],
    spec: { sha: 'sha-OTHER', runId: 'run-OTHER' },
  })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    expectedSha: 'sha-1',
    expectedRunId: 'run-1',
  })
  assert.ok(aggregate.failures.length > 0, 'a foreign shard must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /ran against sha-OTHER/u)
  assert.match(aggregate.failures.join('\n'), /belongs to run run-OTHER/u)
})

test('a shard with NO recorded identity fails the aggregate', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'], spec: null })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    expectedSha: 'sha-1',
    expectedRunId: 'run-1',
  })
  assert.ok(aggregate.failures.length > 0, 'a shard without an identity must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /recorded no runner specification/u)
})

test('a shard whose specification records NO identity at all fails the aggregate', (t) => {
  // The specification exists and is valid JSON, but it carries neither
  // the SHA nor the run id. A check that only compares the field when it
  // happens to be present would accept this shard and claim a coverage
  // nobody measured.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'], spec: { cpu: { availableParallelism: 24 } } })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    expectedSha: 'sha-1',
    expectedRunId: 'run-1',
  })
  assert.ok(aggregate.failures.length > 0, 'a shard with an empty identity must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /recorded no commit SHA/u)
  assert.match(aggregate.failures.join('\n'), /recorded no run id/u)
})

test('a shard that records only the SHA fails the aggregate', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'], spec: { sha: 'sha-1' } })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    expectedSha: 'sha-1',
    expectedRunId: 'run-1',
  })
  assert.ok(aggregate.failures.length > 0, 'a shard missing the run id must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /recorded no run id/u)
})

test('a shard that records only the run id fails the aggregate', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'], spec: { runId: 'run-1' } })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    expectedSha: 'sha-1',
    expectedRunId: 'run-1',
  })
  assert.ok(aggregate.failures.length > 0, 'a shard missing the SHA must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /recorded no commit SHA/u)
})

test('a file that is NOT part of the lane fails the aggregate', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts', 'tui/stranger.test.ts'] })
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED })
  assert.ok(aggregate.failures.length > 0, 'a foreign file must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /is not part of the product lane/u)
})

test('the recorded REPOSITORY-root path is compared against the TEST-root path', (t) => {
  // The reporter writes `test/app/one.test.ts`; the discovery rule returns
  // `app/one.test.ts`. They are two FORMS of one path, and the aggregate
  // must compare them as such — otherwise every file would look lost.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'] })
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED })
  assert.deepEqual(aggregate.failures, [], JSON.stringify(aggregate.failures, null, 2))
  assert.equal(aggregate.observedFileCount, EXPECTED.size)
})

test('a MISSING case fails the aggregate when a baseline is known', (t) => {
  // The file partition proves every FILE was covered. It does not prove
  // every CASE inside those files was recorded: a recorder that dropped
  // one case would still leave every file covered.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'] })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    expectedCases: 4,
    expectedSkipped: 0,
  })
  assert.ok(aggregate.failures.length > 0, 'a missing case must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /recorded 3 case\(s\), but the baseline is 4/u)
})

test('an EXTRA skipped case fails the aggregate when a baseline is known', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'], results: { 'tui/three.test.ts': 'skip' } })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    expectedCases: 3,
    expectedSkipped: 0,
  })
  assert.ok(aggregate.failures.length > 0, 'an extra skip must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /recorded 1 skipped case\(s\), but the baseline for that version is 0/u)
})

test('the aggregate accepts a split that matches the baseline exactly', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'] })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    expectedCases: 3,
    expectedSkipped: 0,
  })
  assert.deepEqual(aggregate.failures, [], JSON.stringify(aggregate.failures, null, 2))
})

test('a shard from an EARLIER attempt fails the aggregate', (t) => {
  // A re-run of the same workflow has the same run id and the same commit;
  // only the attempt tells them apart.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', {
    files: ['tui/three.test.ts'],
    spec: { sha: 'sha-1', runId: 'run-1', runAttempt: '1' },
  })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    expectedSha: 'sha-1',
    expectedRunId: 'run-1',
    expectedRunAttempt: '2',
  })
  assert.ok(aggregate.failures.length > 0, 'an earlier attempt must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /belongs to attempt 1, not 2/u)
})

test('a shard that records NO attempt fails the aggregate when one is expected', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-gate-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', {
    files: ['tui/three.test.ts'],
    spec: { sha: 'sha-1', runId: 'run-1' },
  })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    expectedSha: 'sha-1',
    expectedRunId: 'run-1',
    expectedRunAttempt: '2',
  })
  assert.ok(aggregate.failures.length > 0, 'a missing attempt must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /recorded no run attempt/u)
})

test('the CLI reads the case and skip baseline from the environment', (t) => {
  // The API-level tests prove the CHECKS; this proves the PATH. A
  // verifier whose live entry point drops the expectations would accept a
  // shard set that lost a case, and every API-level test would still
  // pass.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-cli-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'] })
  const expectedFiles = join(root, 'expected-files.txt')
  writeFileSync(expectedFiles, [...EXPECTED].join('\n'))
  const run = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'verify-shards.mjs'),
    '--shards', root,
    '--total', '2',
    '--expected-files', expectedFiles,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      // The baseline says FOUR cases; the shards recorded THREE.
      DSH_EXPECTED_CASES: '4',
      DSH_EXPECTED_SKIPPED: '0',
    },
  })
  assert.notEqual(run.status, 0, 'the CLI must fail on a lost case')
  assert.match(run.stderr, /but the baseline is 4/u)
})

test('the CLI reads the run attempt from the environment', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-cli-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', {
    files: ['tui/three.test.ts'],
    spec: { sha: 'sha-1', runId: 'run-1', runAttempt: '1' },
  })
  const expectedFiles = join(root, 'expected-files.txt')
  writeFileSync(expectedFiles, [...EXPECTED].join('\n'))
  const run = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'verify-shards.mjs'),
    '--shards', root,
    '--total', '2',
    '--expected-files', expectedFiles,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      DSH_EXPECTED_SHA: 'sha-1',
      DSH_EXPECTED_RUN_ID: 'run-1',
      DSH_EXPECTED_RUN_ATTEMPT: '2',
    },
  })
  assert.notEqual(run.status, 0, 'the CLI must fail on a foreign attempt')
  assert.match(run.stderr, /belongs to attempt 1, not 2/u)
})

test('the CLI accepts a shard set that matches the baseline exactly', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-cli-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'] })
  const expectedFiles = join(root, 'expected-files.txt')
  writeFileSync(expectedFiles, [...EXPECTED].join('\n'))
  const run = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'verify-shards.mjs'),
    '--shards', root,
    '--total', '2',
    '--expected-files', expectedFiles,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      DSH_EXPECTED_CASES: '3',
      DSH_EXPECTED_SKIPPED: '0',
    },
  })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /the shard aggregate is the whole lane/u)
})

test('the CLI refuses a malformed baseline instead of disabling the check', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-cli-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'] })
  const expectedFiles = join(root, 'expected-files.txt')
  writeFileSync(expectedFiles, [...EXPECTED].join('\n'))
  const run = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'verify-shards.mjs'),
    '--shards', root,
    '--total', '2',
    '--expected-files', expectedFiles,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      DSH_EXPECTED_CASES: 'many',
    },
  })
  assert.notEqual(run.status, 0, 'a malformed baseline must fail')
  assert.match(run.stderr, /must be a non-negative integer/u)
})

test('a case whose result is MISSING fails the aggregate', (t) => {
  // A deny list would pass this record: `undefined` is not `fail`, not
  // `cancelled` and not `unknown`, and it changes neither the case count
  // nor the skip count — so the aggregate would accept a shard set whose
  // evidence is incomplete.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-cli-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'], results: { 'tui/three.test.ts': undefined } })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
  })
  assert.ok(aggregate.failures.length > 0, 'a case with no result must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /outcome is not accepted/u)
})

test('a TODO case fails the aggregate', (t) => {
  // A todo is a case Node recognised but did not prove. It is not a
  // failure, and it is not a pass either — accepting it by omission
  // would let a case that proves nothing count as qualified.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-cli-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'], results: { 'tui/three.test.ts': 'todo' } })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
  })
  assert.ok(aggregate.failures.length > 0, 'a todo case must fail the aggregate')
  assert.match(aggregate.failures.join('\n'), /1 todo/u)
})

// ---------------------------------------------------------------------------
// The EFFECTIVE parameters.
//
// The regression these protect: five CI runs were reported as a concurrency
// comparison while every one of them ran at Node's default, because the
// runner accepted `--test-concurrency` and then never put it on the child's
// command line. Nothing failed — the lane was green and the report was
// complete. Only the CONFIGURATION was a lie.
//
// So the runner records what it applied, and the aggregate compares that
// record against the level the run claims to measure.
// ---------------------------------------------------------------------------

test('a shard that ran at a DIFFERENT concurrency than the run claims fails', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-applied-')
  writeShard(root, 'shard-1', {
    files: ['app/one.test.ts', 'app/two.test.ts'],
    applied: { shard: '1/2', testConcurrency: 8, laneFileCount: 2 },
  })
  writeShard(root, 'shard-2', {
    files: ['tui/three.test.ts'],
    applied: { shard: '2/2', testConcurrency: 8, laneFileCount: 1 },
  })
  // The run CLAIMS Node's default, and the shards applied 8. That is not a
  // measurement of the default, so it must not pass as one.
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    expectedConcurrency: 'default',
  })
  assert.ok(aggregate.failures.length > 0, 'an applied level that differs from the claim must fail')
  assert.match(aggregate.failures.join('\n'), /claims Node's default concurrency but ran at 8/u)
})

test('a shard that applied the claimed concurrency is accepted', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-applied-ok-')
  writeShard(root, 'shard-1', {
    files: ['app/one.test.ts', 'app/two.test.ts'],
    applied: { shard: '1/2', testConcurrency: 6, laneFileCount: 2 },
  })
  writeShard(root, 'shard-2', {
    files: ['tui/three.test.ts'],
    applied: { shard: '2/2', testConcurrency: 6, laneFileCount: 1 },
  })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    expectedConcurrency: 6,
  })
  assert.deepEqual(aggregate.failures, [])
})

test('a shard that recorded NO applied parameters fails when a level is claimed', (t) => {
  // A shard whose applied configuration is unknown cannot prove it measured
  // the claimed level. Failing open here would recreate the original defect.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-applied-missing-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'], applied: null })
  writeShard(root, 'shard-2', { files: ['tui/three.test.ts'], applied: null })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    expectedConcurrency: 'default',
  })
  assert.ok(aggregate.failures.length > 0, 'a shard with no applied parameters must fail')
  assert.match(aggregate.failures.join('\n'), /recorded no effective parameters/u)
})

test('a shard artifact filed under a DIFFERENT shard than it ran fails', (t) => {
  // The directory names the shard the artifact belongs to; the runner
  // recorded the shard it was given. If they disagree, the artifact is
  // filed under a shard whose coverage it does not hold.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-index-')
  writeShard(root, 'shard-1', {
    files: ['app/one.test.ts', 'app/two.test.ts'],
    applied: { shard: '2/2', testConcurrency: null, laneFileCount: 2 },
  })
  writeShard(root, 'shard-2', {
    files: ['tui/three.test.ts'],
    applied: { shard: '2/2', testConcurrency: null, laneFileCount: 1 },
  })
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED })
  assert.ok(aggregate.failures.length > 0, 'a mis-filed shard must fail')
  assert.match(aggregate.failures.join('\n'), /ran the shard 2\/2, not 1\/2/u)
})

test('the aggregate records both the CLAIMED and the APPLIED level', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shard-record-')
  writeShard(root, 'shard-1', {
    files: ['app/one.test.ts', 'app/two.test.ts'],
    applied: { shard: '1/2', testConcurrency: 4, laneFileCount: 2 },
  })
  writeShard(root, 'shard-2', {
    files: ['tui/three.test.ts'],
    applied: { shard: '2/2', testConcurrency: 4, laneFileCount: 1 },
  })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    expectedConcurrency: 4,
  })
  assert.equal(aggregate.expectedConcurrency, 4, 'the claim is part of the record')
  for (const shard of aggregate.shards) {
    assert.equal(shard.applied.testConcurrency, 4, 'what each shard applied is part of the record')
    assert.equal(shard.applied.laneFileCount, shard.fileCount)
  }
})

// ---------------------------------------------------------------------------
// The SKIP POLICY.
//
// A skip count is a function of the environment, so the count is not
// evidence. What is evidence is that every skip states a reason and that
// the reason is one of a pre-agreed class. Without this, a case can start
// skipping itself for a NEW reason — a broken fixture, a tool the runner
// used to have — and the count stays identical.
// ---------------------------------------------------------------------------

/** The accepted classes, as the aggregate reads them. */
const ACCEPTED = [/BLOCKED: no provisioned official DSH .* Optional-bundle installation/u, /no fd\/fdfind on PATH/u]

test('a skip with NO stated reason fails the policy', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-skip-none-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts'] })
  writeShard(root, 'shard-2', {
    files: ['tui/three.test.ts'],
    results: { 'tui/three.test.ts': 'skip' },
    skipReasons: { 'tui/three.test.ts': null },
  })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    acceptedSkips: ACCEPTED,
  })
  assert.ok(aggregate.failures.length > 0, 'a skip with no reason must fail')
  assert.match(aggregate.failures.join('\n'), /no reason stated/u)
})

test('a skip whose reason is OUTSIDE the accepted classes fails', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-skip-unknown-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts'] })
  writeShard(root, 'shard-2', {
    files: ['tui/three.test.ts'],
    results: { 'tui/three.test.ts': 'skip' },
    skipReasons: { 'tui/three.test.ts': 'the fixture stopped working' },
  })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    acceptedSkips: ACCEPTED,
  })
  assert.ok(aggregate.failures.length > 0)
  assert.match(aggregate.failures.join('\n'), /reason the policy does not accept/u)
  assert.match(aggregate.failures.join('\n'), /the fixture stopped working/u,
    'the failure must quote the reason, so a reader can classify it')
})

test('an ACCEPTED reason passes, and the policy is recorded in the report', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-skip-ok-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', {
    files: ['tui/three.test.ts'],
    results: { 'tui/three.test.ts': 'skip' },
    skipReasons: { 'tui/three.test.ts': 'BLOCKED: no provisioned official DSH 0.2.1-rc.2 Optional-bundle installation was found' },
  })
  const aggregate = verifyShards({
    shardsRoot: root,
    total: 2,
    expectedFiles: EXPECTED,
    acceptedSkips: ACCEPTED,
  })
  assert.deepEqual(aggregate.failures, [])
  assert.deepEqual(aggregate.skipPolicy, { acceptedClasses: 2, enforced: true },
    'a reader must be able to tell "no unaccepted skip" from "no policy applied"')
})

test('a run with NO policy applied says so, instead of looking enforced', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-skip-nopolicy-')
  writeShard(root, 'shard-1', { files: ['app/one.test.ts', 'app/two.test.ts'] })
  writeShard(root, 'shard-2', {
    files: ['tui/three.test.ts'],
    results: { 'tui/three.test.ts': 'skip' },
    skipReasons: { 'tui/three.test.ts': 'anything at all' },
  })
  const aggregate = verifyShards({ shardsRoot: root, total: 2, expectedFiles: EXPECTED })
  assert.deepEqual(aggregate.failures, [], 'an unclassified skip is not a failure when no policy is asserted')
  assert.equal(aggregate.skipPolicy, null, 'but the report must NOT claim a policy was enforced')
})
