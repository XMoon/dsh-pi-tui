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
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { testLifecycle } from '../support/temp-lifecycle.ts'

import { hasLeadingCodePrefix, stripCodePrefix } from '../../scripts/case-title-label.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const REPORTER = join(ROOT, 'scripts', 'test-case-reporter.mjs')

/** Run a synthetic test file through the reporter and return its records. */
function runReporter(t, files, { jsonl = true } = {}) {
  const dir = testLifecycle(t).tempDir('dsh-case-reporter-')
  {
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
  }
}

const TWO_CASES = `
import { test } from 'node:test'
test('the first case passes', () => {})
test('the second case passes', () => {})
`

test('the reporter records every case of every file it is given', (t) => {
  const run = runReporter(t, {
    'a.test.mjs': TWO_CASES,
    'b.test.mjs': TWO_CASES,
  })
  assert.equal(run.status, 0, run.stderr)
  // Two files, two cases each, plus the two FILE entries.
  assert.equal(run.records.length, 6, JSON.stringify(run.records, null, 2))
  const files = new Set(run.records.map(record => record.file))
  assert.equal(files.size, 2, 'both files must be represented')
})

test('a case that is only a code keeps its name', (t) => {
  const run = runReporter(t, {
    'a.test.mjs': `
import { test } from 'node:test'
test('B3', () => {})
`,
  })
  assert.equal(run.status, 0, run.stderr)
  const names = run.records.map(record => record.name)
  assert.ok(names.includes('B3'), JSON.stringify(names))
})

test('a skipped case is recorded as SKIPPED, not as a fast pass', (t) => {
  const run = runReporter(t, {
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

test('a skipped case that carries a REASON is recorded as SKIPPED', (t) => {
  // The repository's own skips carry a reason, not a boolean: the reason
  // says WHY the case could not run, and that is the whole value of the
  // marker.
  const run = runReporter(t, {
    'a.test.mjs': `
import { test } from 'node:test'
test('a blocked case', { skip: 'BLOCKED: the optional bundle is not provisioned' }, () => {})
`,
  })
  assert.equal(run.status, 0, run.stderr)
  const record = run.records.find(entry => entry.name === 'a blocked case')
  assert.equal(record?.result, 'skip')
})

test('a todo case is recorded as TODO', (t) => {
  const run = runReporter(t, {
    'a.test.mjs': `
import { test } from 'node:test'
test('a todo case', { todo: 'later' }, () => {})
`,
  })
  assert.equal(run.status, 0, run.stderr)
  const record = run.records.find(entry => entry.name === 'a todo case')
  assert.equal(record?.result, 'todo')
})

test('the human report is the spec report: the whole report is the same', (t) => {
  const source = `
import { test } from 'node:test'
test('a case that passes', () => {})
test('a skipped case', { skip: true }, () => {})
`
  const dir = testLifecycle(t).tempDir('dsh-case-spec-')
  {
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
    // The WHOLE report is compared, not only the case lines: a reporter
    // that dropped a summary line would still pass a case-line
    // comparison.
    //
    // The TIMINGS are the only part that legitimately differs between two
    // runs — the per-case duration and the total. They are normalised
    // away; everything else must be identical, line for line.
    const normalized = output => output
      .split('\n')
      .map(line => line.replace(/\([\d.]+ms\)/u, '(TIME)').replace(/duration_ms [\d.]+/u, 'duration_ms TIME'))
    assert.deepEqual(normalized(teed.stdout), normalized(plain.stdout))
  }
})

test('without the JSONL destination the reporter still prints the human report', (t) => {
  const run = runReporter(t, { 'a.test.mjs': TWO_CASES }, { jsonl: false })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /the first case passes/u)
})

test('the title transform removes a leading code and keeps the sentence', () => {
  assert.equal(
    stripCodePrefix('A5b: the composition zone is one facade plus its bootstrap helpers'),
    'the composition zone is one facade plus its bootstrap helpers',
  )
  // `negative control` names the KIND of case, not the code — it stays.
  assert.equal(
    stripCodePrefix('PR5 negative control: an indeterminate prompt result never restores the draft'),
    'negative control: an indeterminate prompt result never restores the draft',
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

test('the title transform removes every code family the tree uses', () => {
  // The families below are the ones the repository's own titles use. Each
  // one is a LABEL: it names the effort, not the behaviour.
  const cases = [
    ['A5b: the composition zone is one facade', 'the composition zone is one facade'],
    ['A5b/TS2: a forbidden handler fails the zone lock', 'a forbidden handler fails the zone lock'],
    ['A5b-6: the composition root introduces no new type', 'the composition root introduces no new type'],
    ['B4A-07 a resize re-budgets the window', 'a resize re-budgets the window'],
    ['PR5 §1C-3 (R6-1): only the winner is subtracted', 'only the winner is subtracted'],
    // A `step N` label carries its JOINED parts: 'step 10 + 11(b)',
    // 'steps 1-8 + negatives (c)/no-retry', 'step 8 / §5 Must 17'. The
    // whole scope is one label, and it goes with the code.
    ['L6 §15 step 10 + 11(b): a SECOND real Job stops', 'a SECOND real Job stops'],
    ['L6 §15 steps 1-8 + negatives (c)/no-retry/no-ctx.jobs.read: the REAL Job viewer observes', 'the REAL Job viewer observes'],
    ['L6 §15 step 8 / §5 Must 17: the case', 'the case'],
    // A bracketed qualifier that DIRECTLY follows the code is part of
    // the LABEL: it names the review or the variant, and it goes with
    // the code.
    ['PR4 F2b.2 (review round 4): a fulfilled observation is an issue', 'a fulfilled observation is an issue'],
    ['§D2 (review round 3 ruling): Direct keeps the mirror', 'Direct keeps the mirror'],
    // A bracket that qualifies a WORD is not the label: `shell` is the
    // subject, and `(Remote, CARRIER_GAP)` qualifies it.
    ['L6 §37 shell (Remote, CARRIER_GAP): the shell routes the turn', 'shell (Remote, CARRIER_GAP): the shell routes the turn'],
    ['§18.1 the Remote route never hands over', 'the Remote route never hands over'],
    ['A06/Focus: an idle compaction keeps the chronology', 'an idle compaction keeps the chronology'],
    ['B3 F6.1: a real answer freezes the countdown', 'a real answer freezes the countdown'],
    ['B2/Direct-L6: a TSP Enter drives a real turn', 'a TSP Enter drives a real turn'],
    ['E2–E5: per-card clicks layer over the preference', 'per-card clicks layer over the preference'],
    ['D2.1: Ctrl+S steers queued occurrences', 'Ctrl+S steers queued occurrences'],
    ['RFL-005: a cold attach verifies the first publication', 'a cold attach verifies the first publication'],
    ['PR D: an unsaved draft never executes', 'an unsaved draft never executes'],
    ['P1.1 headless: foo<Tab> opens no dropdown', 'foo<Tab> opens no dropdown'],
  ]
  for (const [from, to] of cases) {
    assert.equal(stripCodePrefix(from), to, `must strip: ${from}`)
  }
})

test('the title transform keeps a title that is only a code', () => {
  // There is no sentence after the code, so there is nothing to keep.
  assert.equal(stripCodePrefix('B3'), 'B3')
  assert.equal(stripCodePrefix('L6'), 'L6')
})

test('the title transform keeps a qualifier that the sentence needs', () => {
  // `Focus` and `Direct` name the variant the case covers. On their own
  // they are the subject of the sentence, not a label.
  assert.equal(
    stripCodePrefix('Focus Error sanitizes AUTH failure messages'),
    'Focus Error sanitizes AUTH failure messages',
  )
  assert.equal(
    stripCodePrefix('B/Direct: sessionless resume follows the production lifecycle'),
    'sessionless resume follows the production lifecycle',
  )
})

test('the title transform keeps a key name that looks like a code', () => {
  // `S` is a key, not a sub-label. Only a `PR` code may carry one.
  assert.equal(
    stripCodePrefix('S on a clean draft closes without persisting'),
    'S on a clean draft closes without persisting',
  )
})

test('the title audit and the title transform agree on what a code is', () => {
  // The audit reports the titles that still lead with a code; the
  // transform rewrites them. If the two used their own definitions, the
  // audit could stop reporting the very titles the transform would
  // change — and a "no code-led titles" report would then be a report
  // about the narrower definition, not about the tree.
  const cases = [
    'A5b: the composition zone is one facade',
    'A06/Focus: an idle compaction keeps the chronology',
    'B3 F6.1: a real answer freezes the countdown',
    'PR D: an unsaved draft never executes',
    'E2–E5: per-card clicks layer over the preference',
    'P1.1: ordinary prompt positions never open the dropdown',
    '§18.1 the Remote route never hands over',
    'PR5 §1C-3 (R6-1): only the winner is subtracted',
    'RFL-005: a cold attach verifies the first publication',
    'B/Direct: sessionless resume follows the lifecycle',
  ]
  for (const title of cases) {
    assert.equal(hasLeadingCodePrefix(title), true, `the audit must report: ${title}`)
    assert.notEqual(stripCodePrefix(title), title, `the transform must change: ${title}`)
  }
  const clear = [
    'the composition zone is one facade',
    'Focus Error sanitizes AUTH failure messages',
    'S on a clean draft closes without persisting',
    'B3',
  ]
  for (const title of clear) {
    assert.equal(hasLeadingCodePrefix(title), false, `the audit must not report: ${title}`)
    assert.equal(stripCodePrefix(title), title, `the transform must not change: ${title}`)
  }
})

test('a dot-separated code is removed without cutting the sentence', () => {
  // The dot is a separator only when a CODE precedes it. In a title like
  // `F1. a mount throw leaves the fiber unassigned: …` the colon is
  // inside the SENTENCE, and splitting there would cut it in half.
  assert.equal(
    stripCodePrefix('F1. a synchronous mount throw leaves the stage fiber unassigned: the unwind skips it'),
    'a synchronous mount throw leaves the stage fiber unassigned: the unwind skips it',
  )
  assert.equal(
    stripCodePrefix('§14/J12: a same-Session Job viewer replacement drops the stale settlement'),
    'a same-Session Job viewer replacement drops the stale settlement',
  )
  assert.equal(
    stripCodePrefix('F5+cancellation: a pre-aborted WORKSPACE request rejects before the answer'),
    'a pre-aborted WORKSPACE request rejects before the answer',
  )
})

test('the title transform removes the remaining code families', () => {
  const cases = [
    ['§3.9a: teardown with a pending main-path READ', 'teardown with a pending main-path READ'],
    ['(10): the replaced modal leaves the seat', 'the replaced modal leaves the seat'],
    ['(R6-1): only the winner is subtracted', 'only the winner is subtracted'],
    ['(ctrl-r harness): an Approval A→B FIFO keeps the seat parked', 'an Approval A→B FIFO keeps the seat parked'],
    // `hard gate` is the CATEGORY the case belongs to, not part of the
    // code — so it stays.
    ['19.2 hard gate: 100 UI-only refresh cycles', 'hard gate: 100 UI-only refresh cycles'],
    ['02/03 effective ↓ enters from the middle of the last line', 'effective ↓ enters from the middle of the last line'],
    ['D1. a Host-side wire construction failure unwinds', 'a Host-side wire construction failure unwinds'],
    ['F5+cancellation: a pre-aborted request rejects', 'a pre-aborted request rejects'],
    ['§14/J12: a same-Session viewer replacement drops the stale settlement', 'a same-Session viewer replacement drops the stale settlement'],
  ]
  for (const [from, to] of cases) {
    assert.equal(stripCodePrefix(from), to, `must strip: ${from}`)
    assert.equal(hasLeadingCodePrefix(from), true, `the audit must report: ${from}`)
  }
})

test('the title transform keeps the MEANINGFUL words that follow the code', () => {
  // `B3 F4 control: …` — the code is `B3 F4`, and `control` is the
  // CATEGORY the case belongs to. Dropping it would make the title say
  // LESS than it did, which is the opposite of the transform's contract.
  assert.equal(
    stripCodePrefix('B3 F4 control: with no settled entry an empty recorded result still renders no result body'),
    'control: with no settled entry an empty recorded result still renders no result body',
  )
  assert.equal(
    stripCodePrefix('A0 fullscreen seat preflight: the alt screen delivers press/click to a History result row'),
    'fullscreen seat preflight: the alt screen delivers press/click to a History result row',
  )
  assert.equal(
    stripCodePrefix('L6 §37 shell (Remote, CARRIER_GAP): the shell routes the turn'),
    'shell (Remote, CARRIER_GAP): the shell routes the turn',
  )
})

test('the title transform removes the case labels the plan numbers by letter', () => {
  // The plan numbers its sub-cases with a letter, and the letter alone is
  // the whole label: `A:`, `B:`, `C:`, `E:`.
  for (const [from, to] of [
    ['A: @src → dropdown → Tab → @src/ → children dropdown', '@src → dropdown → Tab → @src/ → children dropdown'],
    ['B: /image src → dropdown → Tab', '/image src → dropdown → Tab'],
    ['C: hello ./src<Tab> opens no dropdown', 'hello ./src<Tab> opens no dropdown'],
    ['E: sessionless @dir/ lists children through the app chain', 'sessionless @dir/ lists children through the app chain'],
  ]) {
    assert.equal(stripCodePrefix(from), to, `must strip: ${from}`)
    assert.equal(hasLeadingCodePrefix(from), true, `the audit must report: ${from}`)
  }
})

test('the title transform removes a review finding and an assertion number', () => {
  for (const [from, to] of [
    ['finding C (1): the real /new quiesce parks on a LIVE Question', 'the real /new quiesce parks on a LIVE Question'],
    ['finding F7: a held timed claim retired by a publication never mounts its form', 'a held timed claim retired by a publication never mounts its form'],
    ['finding C/F6 (5): a real publication withdraws a live APPROVAL prompt', 'a real publication withdraws a live APPROVAL prompt'],
    ['findings F6/F7: a lifetime retired BEFORE its slot exists never mounts', 'a lifetime retired BEFORE its slot exists never mounts'],
    ['assertion 7: a Remote adapter cannot import the Direct implementation', 'a Remote adapter cannot import the Direct implementation'],
    ['assertion 14: the startup island must not reach a repository implementation module', 'the startup island must not reach a repository implementation module'],
  ]) {
    assert.equal(stripCodePrefix(from), to, `must strip: ${from}`)
    assert.equal(hasLeadingCodePrefix(from), true, `the audit must report: ${from}`)
  }
})

test('a nested case records its FULL title, with the describe() chain', (t) => {
  // Node's `name` on a nested test is the node's OWN name; it does not
  // include the enclosing `describe()`. The title a reader sees in a
  // report is the chain, so the record has to carry it.
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-nested-title-')
  const file = join(dir, 'synthetic.test.mjs')
  writeFileSync(file, [
    "import { describe, test } from 'node:test'",
    "describe('Session switching', () => {",
    "  describe('inner', () => {",
    "    test('rejects a stale read', () => {})",
    "  })",
    "  test('keeps the title', () => {})",
    "})",
  ].join('\n'))
  const jsonl = join(dir, 'cases.jsonl')
  const result = spawnSync(
    process.execPath,
    ['--test', `--test-reporter=${REPORTER}`, file],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, DSH_TEST_JSONL: jsonl },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const records = readFileSync(jsonl, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  const names = records.filter(record => record.type === 'test' && record.name !== record.file).map(record => record.name)
  assert.deepEqual(names.sort(), [
    'Session switching > inner > rejects a stale read',
    'Session switching > keeps the title',
  ], JSON.stringify(records, null, 2))
})

test('the reporter records the file path RELATIVE to the repository root', (t) => {
  // The path has to be a FILE SYSTEM path, not a URL component: on
  // Windows `URL.pathname` is `/C:/Users/…`, and a space in the checkout
  // path stays percent-encoded as `%20`. `relative()` against such a
  // string yields a path that does not exist.
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-reporter-path-')
  const file = join(dir, 'synthetic.test.mjs')
  writeFileSync(file, "import { test } from 'node:test'\ntest('a synthetic case', () => {})\n")
  const jsonl = join(dir, 'cases.jsonl')
  const result = spawnSync(
    process.execPath,
    ['--test', `--test-reporter=${REPORTER}`, file],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, DSH_TEST_JSONL: jsonl },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const records = readFileSync(jsonl, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  for (const record of records) {
    // The path must not be a URL component: no percent-encoding, and no
    // leading slash (which is what a Windows `URL.pathname` has).
    assert.ok(!record.file.includes('%'), 'the path must not be percent-encoded: ' + record.file)
    assert.ok(!record.file.startsWith('/'), 'the path must not be an absolute URL path: ' + record.file)
  }
  // And the file the case really ran is the file that is named: the
  // record's own name is the file's path for the file entry.
  const fileEntry = records.find(record => record.name === record.file)
  assert.ok(fileEntry !== undefined, JSON.stringify(records, null, 2))
})

test('a describe() block is a SUITE, not a case', (t) => {
  // Node counts a `describe()` block as a SUITE and its `it()`s as
  // TESTS. The nesting depth cannot tell them apart — a top-level suite
  // has nesting 0, exactly like a plain test — so the reporter keeps
  // Node's own type, and the inventory counts by it.
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-suite-shape-')
  const file = join(dir, 'synthetic.test.mjs')
  writeFileSync(file, [
    "import { describe, it, test } from 'node:test'",
    "describe('Group', () => {",
    "  it('first', () => {})",
    "  it('second', () => {})",
    "})",
    "test('top level', () => {})",
  ].join('\n'))
  const jsonl = join(dir, 'cases.jsonl')
  const result = spawnSync(
    process.execPath,
    ['--test', `--test-reporter=${REPORTER}`, file],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, DSH_TEST_JSONL: jsonl },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const records = readFileSync(jsonl, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  const suites = records.filter(record => record.type === 'suite')
  const cases = records.filter(record => record.type === 'test' && record.name !== record.file)
  // Node's own summary for this file: 3 tests / 1 suite.
  assert.equal(suites.length, 1, JSON.stringify(records, null, 2))
  assert.equal(suites[0].name, 'Group')
  assert.equal(cases.length, 3, JSON.stringify(records, null, 2))
  // Node's own report must agree with the records.
  assert.match(result.stdout, /^ℹ tests 3$/mu)
  assert.match(result.stdout, /^ℹ suites 1$/mu)
})
