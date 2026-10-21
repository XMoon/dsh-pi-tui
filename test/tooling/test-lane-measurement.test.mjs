/**
 * The lane runner's MEASUREMENT path: from the real entry point to a
 * parseable case record.
 *
 * The unit tests of the reporter drive it DIRECTLY, with the reporter
 * named on the command line. That proves the reporter works, but it does
 * not prove the path a CI run takes: the lane runner has to LOAD the
 * reporter, and it has to write the records where the consumer looks for
 * them. A runner that never loads the reporter produces NO records, and
 * every consumer then fails later with a confusing "file not found"
 * instead of at the point of the mistake.
 *
 * So these cases run the real `scripts/run-test-lane.mjs` over a
 * DISPOSABLE tree, with the runner's own discovery, its own reporter
 * wiring and its own temp-root contract, and then read the records the
 * aggregate actually consumes.
 *
 * The tree is disposable on purpose. A probe placed in the repository's
 * own `test/tooling/` would be DISCOVERED by the very lane the test runs:
 * the lane would run the probe, the probe would run the lane, and each
 * level would spawn another lane — a recursion that exhausts the
 * machine's memory. A disposable root outside the repository's test tree
 * cannot be discovered, so the recursion cannot start.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { testLifecycle } from '../support/temp-lifecycle.ts'
import { resolveTestRoot } from '../../scripts/run-test-lane.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/**
 * The current nesting depth of the measurement.
 *
 * `Number(undefined)` is `NaN`, and `NaN ?? 0` is still `NaN` — the `??`
 * operator only replaces `null` and `undefined`, not a value that is not a
 * number. So the depth has to be read explicitly.
 *
 * @param {string|undefined} raw - the environment value.
 * @returns {number} the depth, 0 when it is absent or unreadable.
 */
function depthOf(raw) {
  if (raw === undefined || raw === '') return 0
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}
const RUNNER = join(ROOT, 'scripts', 'run-test-lane.mjs')

/**
 * Run the real lane runner over a disposable lane.
 *
 * @param {string} t - the test context.
 * @param {{files: Record<string, string>, jsonl: boolean}} options
 * @returns {{status: number|null, jsonl: string, stdout: string, stderr: string}}
 */
function runLane(t, { files, jsonl }) {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-lane-measure-')
  // The disposable tree is the runner's TEST ROOT for this run, so the
  // real discovery rule runs over it and finds only these files.
  const testRoot = join(root, 'test')
  mkdirSync(testRoot, { recursive: true })
  for (const [name, source] of Object.entries(files)) {
    const path = join(testRoot, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, source)
  }
  const destination = join(root, 'cases.jsonl')
  const result = spawnSync(process.execPath, [RUNNER, 'product', '--test-root', testRoot], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      DSH_TEST_ROOT: testRoot,
      DSH_TEST_JSONL: jsonl ? destination : undefined,
      // A GUARD against a runaway recursion. The disposable tree cannot be
      // discovered by the lane it holds, so the recursion cannot start;
      // and if it ever did, the depth limit stops it before it can
      // exhaust the machine's memory. The lane runner passes the variable
      // on to the child, so the depth counts the nesting.
      DSH_LANE_MEASUREMENT_DEPTH: String(depthOf(process.env.DSH_LANE_MEASUREMENT_DEPTH) + 1),
    },
  })
  return {
    status: result.status,
    jsonl: destination,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

const TWO_CASES_MJS = [
  "import { test } from 'node:test'",
  "test('a synthetic case that passes', () => {})",
  "test('a synthetic case that is skipped', { skip: true }, () => {})",
].join('\n')

const TWO_CASES = [
  "import test from 'node:test'",
  "test('a synthetic case that passes', () => {})",
  "test('a synthetic case that is skipped', { skip: true }, () => {})",
].join('\n')

test('the lane runner WRITES the case records when the opt-in variable is set', (t) => {
  // A runaway recursion is the failure mode this file is most able to
  // cause, so the depth is bounded here as well as in the child.
  const depth = depthOf(process.env.DSH_LANE_MEASUREMENT_DEPTH)
  if (depth > 2) {
    t.skip('the lane measurement recursion is already too deep')
    return
  }
  const run = runLane(t, {
    files: {
      'synthetic.test.ts': TWO_CASES,
      // The product lane's patterns name BOTH suffixes, and the
      // discovery rule fails closed when a pattern matches nothing — so
      // the disposable tree has to carry one file of each.
      'synthetic.test.mjs': TWO_CASES_MJS,
    },
    jsonl: true,
  })
  assert.equal(run.status, 0, run.stderr)
  assert.ok(existsSync(run.jsonl), `the lane runner must write ${run.jsonl}`)
  const records = readFileSync(run.jsonl, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  // Two files, each with a passing and a skipped case, plus one FILE
  // entry per file.
  //
  // A FILE entry is the one whose NAME is a path ending in a test file's
  // own name — the same rule the shard aggregate uses to recognise a
  // file's entry.
  const isFileEntry = record => /\.test\.(ts|mjs)$/u.test(record.name)
  const fileEntries = records.filter(isFileEntry)
  const cases = records.filter(record => !isFileEntry(record))
  assert.equal(cases.length, 4, JSON.stringify(records.map(r => ({ n: r.name, r: r.result })), null, 2))
  const byResult = new Map(cases.map(record => [record.name, record.result]))
  assert.equal(byResult.get('a synthetic case that passes'), 'pass')
  assert.equal(byResult.get('a synthetic case that is skipped'), 'skip')
  // The file entries are there too: the aggregate needs them to know the
  // shard's file list.
  assert.equal(fileEntries.length, 2, JSON.stringify(records.map(r => r.name), null, 2))
})

test('the environment variable ALONE cannot redirect a qualification run', () => {
  // `pnpm test:product` must scan the repository's own test files, and
  // nothing an environment variable says may change that set: a stray
  // `DSH_TEST_ROOT` in a developer's shell must not make the product
  // lane report green without having run the product suite.
  //
  // The DECISION is what is under test, and it is a decision about one
  // directory — so it is verified directly, without running the product
  // suite to observe which files it found.
  const canonical = join(ROOT, 'test')
  const synthetic = join(tmpdir(), 'dsh-synthetic-test-root')
  // The variable alone: IGNORED, and the canonical root is used.
  assert.equal(
    resolveTestRoot(undefined, { DSH_TEST_ROOT: synthetic }),
    canonical,
    'the environment variable alone must not redirect the lane',
  )
  // The explicit opt-in: the two have to AGREE, or the runner refuses.
  assert.equal(
    resolveTestRoot(synthetic, { DSH_TEST_ROOT: synthetic }),
    resolve(synthetic),
    'the explicit opt-in must select the named root',
  )
  assert.throws(
    () => resolveTestRoot(synthetic, {}),
    /requires DSH_TEST_ROOT/u,
    'the explicit opt-in without the variable must be refused',
  )
  assert.throws(
    () => resolveTestRoot(synthetic, { DSH_TEST_ROOT: canonical }),
    /disagree/u,
    'the explicit opt-in and the variable must agree',
  )
})

test('the lane runner writes NO records when the opt-in variable is absent', (t) => {
  const run = runLane(t, {
    files: {
      'synthetic.test.ts': TWO_CASES,
      // The product lane's patterns name BOTH suffixes, and the
      // discovery rule fails closed when a pattern matches nothing — so
      // the disposable tree has to carry one file of each.
      'synthetic.test.mjs': TWO_CASES_MJS,
    },
    jsonl: false,
  })
  assert.equal(run.status, 0, run.stderr)
  // The default run must be exactly what it always was: no records file,
  // and the ordinary human report.
  assert.equal(existsSync(run.jsonl), false)
  assert.match(run.stdout, /a synthetic case that passes/u)
})
