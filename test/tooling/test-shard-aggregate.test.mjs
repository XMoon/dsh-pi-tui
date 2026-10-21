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
import { join } from 'node:path'

import { verifyShards } from '../../scripts/verify-shards.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

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
    records.push({ file: repositoryPath, name: `the case in ${file}`, line: 2, column: 1, nesting: 0, duration_ms: 1, result: results[file] ?? 'pass' })
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
  assert.match(aggregate.failures.join('\n'), /expected 2 shard directories, found 1/u)
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
  assert.match(aggregate.failures.join('\n'), /no outcome/u)
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
