/**
 * The CASE-REPORT tooling: the reporter that produces the machine-readable
 * case record, the shard argument, the title transform and the runner
 * specification.
 *
 * These are the pieces the case-title policy and the CI diagnostics rest
 * on, so their contracts are proved here rather than assumed:
 *
 *   - the reporter's HUMAN output is the `spec` reporter's own output, so
 *     adding the machine record cannot change what a CI log shows;
 *   - the machine record counts the same cases the reporter counts, and
 *     records a skipped case as SKIPPED rather than as a fast pass;
 *   - the shard argument is Node's own shard, and a malformed one fails;
 *   - the title transform removes a leading code and keeps the sentence.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/test-case-reporting.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { parseShard } from '../../scripts/run-test-lane.mjs'
import { stripCodePrefix, rewriteSource } from '../../scripts/strip-code-prefix.mjs'
import { collectRunnerSpec } from '../../scripts/runner-spec.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const REPORTER = join(ROOT, 'scripts', 'test-case-reporter.mjs')

/** Run a synthetic test file through the reporter and return its records. */
function runReporter(files, { jsonl = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-case-reporter-'))
  try {
    const jsonlPath = join(dir, 'cases.jsonl')
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(dir, name), source)
    }
    const result = spawnSync(
      process.execPath,
      ['--test', `--test-reporter=${REPORTER}`, ...Object.keys(files).map(name => join(dir, name))],
      {
        cwd: ROOT,
        encoding: 'utf8',
        // `NODE_TEST_CONTEXT` marks a process as a test-runner CHILD. It is
        // inherited from the enclosing test run, and a child that carries it
        // runs the file as a child process instead of a test file, so it
        // reports nothing.
        env: { ...process.env, NODE_TEST_CONTEXT: undefined, ...(jsonl ? { DSH_TEST_JSONL: jsonlPath } : {}) },
      },
    )
    const records = jsonl
      ? readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      : []
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, records }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const TWO_CASES = `
import { test } from 'node:test'
test('the first case passes', () => {})
test('the second case passes', () => {})
`

test('the reporter records every case of every file it is given', () => {
  const run = runReporter({
    'a.test.mjs': TWO_CASES,
    'b.test.mjs': TWO_CASES,
  })
  assert.equal(run.status, 0, run.stderr)
  // Two files, two cases each, plus the two FILE entries.
  assert.equal(run.records.length, 6, JSON.stringify(run.records, null, 2))
  const files = new Set(run.records.map(record => record.file))
  assert.equal(files.size, 2, 'both files must be represented')
})

test('a case that is only a code keeps its name', () => {
  const run = runReporter({
    'a.test.mjs': `
import { test } from 'node:test'
test('B3', () => {})
`,
  })
  assert.equal(run.status, 0, run.stderr)
  const names = run.records.map(record => record.name)
  assert.ok(names.includes('B3'), JSON.stringify(names))
})

test('a skipped case is recorded as SKIPPED, not as a fast pass', () => {
  const run = runReporter({
    'a.test.mjs': `
import { test } from 'node:test'
test('a skipped case', { skip: true }, () => {})
test('a passing case', () => {})
`,
  })
  assert.equal(run.status, 0, run.stderr)
  const byName = new Map(run.records.map(record => [record.name, record]))
  assert.equal(byName.get('a skipped case')?.result, 'skip')
  assert.equal(byName.get('a passing case')?.result, 'pass')
})

test('a todo case is recorded as TODO', () => {
  const run = runReporter({
    'a.test.mjs': `
import { test } from 'node:test'
test('a todo case', { todo: 'later' }, () => {})
`,
  })
  assert.equal(run.status, 0, run.stderr)
  const record = run.records.find(entry => entry.name === 'a todo case')
  assert.equal(record?.result, 'todo')
})

test('the human report is the spec report: the case lines are the same', () => {
  const source = `
import { test } from 'node:test'
test('a case that passes', () => {})
`
  const dir = mkdtempSync(join(tmpdir(), 'dsh-case-spec-'))
  try {
    const file = join(dir, 'a.test.mjs')
    writeFileSync(file, source)
    const plain = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    })
    const teed = spawnSync(process.execPath, ['--test', `--test-reporter=${REPORTER}`, file], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, DSH_TEST_JSONL: join(dir, 'cases.jsonl') },
    })
    // The case lines are the report a CI log shows; the timing suffix is
    // the only part that legitimately differs between two runs.
    const caseLines = output => output
      .split('\n')
      .filter(line => line.startsWith('✔') || line.startsWith('✖'))
      .map(line => line.replace(/\([\d.]+ms\)/u, ''))
    assert.deepEqual(caseLines(teed.stdout), caseLines(plain.stdout))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('without the JSONL destination the reporter still prints the human report', () => {
  const run = runReporter({ 'a.test.mjs': TWO_CASES }, { jsonl: false })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /the first case passes/u)
})

test('the shard argument accepts a well-formed shard and rejects a malformed one', () => {
  assert.equal(parseShard([]), undefined)
  assert.equal(parseShard(['--shard=1/4']), '1/4')
  assert.equal(parseShard(['--shard=4/4']), '4/4')
  for (const malformed of ['--shard=0/4', '--shard=5/4', '--shard=1/0', '--shard=abc', '--shard=1']) {
    assert.throws(() => parseShard([malformed]), /shard/u, `must reject: ${malformed}`)
  }
})

test('the title transform removes a leading code and keeps the sentence', () => {
  assert.equal(
    stripCodePrefix('A5b: the composition zone is one facade plus its bootstrap helpers'),
    'the composition zone is one facade plus its bootstrap helpers',
  )
  assert.equal(
    stripCodePrefix('PR5 negative control: an indeterminate prompt result never restores the draft'),
    'an indeterminate prompt result never restores the draft',
  )
  assert.equal(
    stripCodePrefix('A5b/TS2: a forbidden handler reintroduced in a NESTED helper fails the zone lock'),
    'a forbidden handler reintroduced in a NESTED helper fails the zone lock',
  )
  assert.equal(
    stripCodePrefix('PR3-B §7.3 (F2): a steer gone stale does not reseed a switch-dropping renderer'),
    'a steer gone stale does not reseed a switch-dropping renderer',
  )
})

test('the title transform leaves a title without a leading code ALONE', () => {
  const title = 'a stale surface detach does not close the newer surface'
  assert.equal(stripCodePrefix(title), title)
})

test('the title transform does not strip a title that IS only a code', () => {
  assert.equal(stripCodePrefix('B3'), 'B3')
})

test('the title transform rewrites only the title literal of a case', () => {
  const source = [
    "import { test } from 'node:test'",
    "test('A5b: the composition zone is one facade', () => {})",
    "const label = 'A5b: not a title'",
    'test(`A5b: a computed ${value} title`, () => {})',
  ].join('\n')
  const rewritten = rewriteSource(source)
  assert.match(rewritten, /test\('the composition zone is one facade'/u)
  // A string that is not a case title is not touched.
  assert.match(rewritten, /const label = 'A5b: not a title'/u)
  // A template with an interpolation carries a computed name; it is left
  // alone, because its final text is not knowable from the source.
  assert.match(rewritten, /test\(`A5b: a computed \$\{value\} title`/u)
})

test('the runner specification reports the real machine, and marks what it cannot see', () => {
  const spec = collectRunnerSpec()
  assert.equal(typeof spec.node.version, 'string')
  assert.equal(typeof spec.cpu.availableParallelism, 'number')
  assert.ok(spec.cpu.availableParallelism >= 1)
  // The cgroup reading is either measured or explicitly unavailable — it is
  // never replaced by the runner family's public label.
  if (spec.cgroup.cpu.available === false) {
    assert.equal(spec.cgroup.cpu.quotaUs, null)
  } else {
    assert.equal(typeof spec.cgroup.cpu.cgroupVersion, 'string')
  }
})
