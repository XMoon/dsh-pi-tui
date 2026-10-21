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
function writeShard(root, name, { files, results = {}, spec = { sha: 'sha-1', runId: 'run-1' } }) {
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
    records.push({ file: repositoryPath, name: `the case in ${file}`, line: 2, column: 1, nesting: 0, duration_ms: 1, result })
  }
  writeFileSync(join(directory, 'cases.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n')
  if (spec !== null) {
    writeFileSync(join(directory, 'runner-spec.json'), JSON.stringify(spec))
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
  assert.match(aggregate.failures.join('\n'), /recorded 1 skipped case\(s\), but the baseline is 0/u)
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
