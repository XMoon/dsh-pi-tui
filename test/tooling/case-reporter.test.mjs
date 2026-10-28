/**
 * The case reporter's outcome recording.
 *
 * The reporter writes one JSONL record per case, and the aggregate's
 * fail-closed gate reads those records to prove the shards cover the
 * lane. So a record that says `pass` for a case that was SKIPPED makes
 * the aggregate's skip baseline wrong — and the baseline is what proves
 * that no shard quietly lost a case.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/case-reporter.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPORTER = join(ROOT, 'scripts', 'test-case-reporter.mjs')

/**
 * Run a source file through the reporter and read its records.
 *
 * @param {string} source - the test source.
 * @returns {Array<object>} the records the reporter wrote.
 */
function record(source) {
  const directory = join(ROOT, 'temp', `dsh-reporter-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
  const file = join(directory, 'synthetic.test.mjs')
  const destination = join(directory, 'cases.jsonl')
  mkdirSync(directory, { recursive: true })
  writeFileSync(file, source)
  try {
    const result = spawnSync(process.execPath, ['--test', `--test-reporter=${REPORTER}`, file], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, DSH_TEST_JSONL: destination },
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return readFileSync(destination, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('a skipped case is recorded as skipped', () => {
  const records = record("import { test } from 'node:test'\ntest('a skipped case', { skip: 'why' }, () => {})\n")
  const skipped = records.find(entry => entry.name === 'a skipped case')
  assert.ok(skipped !== undefined, JSON.stringify(records, null, 2))
  assert.equal(skipped.result, 'skip')
})

test('a case whose outcome never arrives is still recorded with ITS OWN skip', () => {
  // The reporter pairs each outcome with the oldest completion of the same
  // file. A completion that never gets an outcome is recorded by the
  // trailing loop — and that loop used to record it as `pass`, because
  // it read the skip from the (absent) outcome instead of from the
  // completion, which carries the marker itself.
  //
  // The consequence was a RECORD that said `pass` for a case the CI log
  // showed as skipped, so the aggregate's skip baseline was off by one
  // and compared against the wrong number.
  const records = record("import { test } from 'node:test'\ntest('a skipped case', { skip: 'why' }, () => {})\n")
  const skipped = records.find(entry => entry.name === 'a skipped case')
  assert.equal(skipped.result, 'skip', 'the completion carries the skip marker itself')
})

test('a case is recorded with the marker ITS OWN completion carries', () => {
  // The reporter pairs each outcome with the oldest completion of the
  // same file, so under load a completion can be left WITHOUT an outcome
  // — it is then recorded by the trailing loop.
  //
  // That loop used to read the skip from the (absent) outcome, so a case
  // the CI log showed as SKIPPED was recorded as `pass`. The aggregate's
  // skip baseline is compared against these records, so the baseline was
  // off by one and the comparison was against the wrong number.
  //
  // The rule the records must satisfy: the result comes from the
  // completion's own marker, whether or not an outcome arrived.
  const source = readFileSync(REPORTER, 'utf8')
  assert.match(
    source,
    /outcome\.skip !== undefined \|\| data\.skip !== undefined/u,
    'the completion\'s own skip marker must be read as well as the outcome\'s',
  )
  assert.match(
    source,
    /outcome\.todo !== undefined \|\| data\.todo !== undefined/u,
    'the completion\'s own todo marker must be read as well as the outcome\'s',
  )
})

test('a suite is recorded as a suite, and its children keep their own results', () => {
  const records = record([
    "import { describe, test } from 'node:test'",
    "describe('a suite', () => {",
    "  test('a skipped child', { skip: 'why' }, () => {})",
    "  test('a passing child', () => {})",
    '})',
  ].join('\n'))
  const suite = records.find(entry => entry.name === 'a suite')
  assert.equal(suite.type, 'suite')
  const skipped = records.find(entry => entry.name === 'a suite > a skipped child')
  assert.equal(skipped.result, 'skip')
  const passed = records.find(entry => entry.name === 'a suite > a passing child')
  assert.equal(passed.result, 'pass')
})
