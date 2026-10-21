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

import { parseShard } from '../../scripts/run-test-lane.mjs'
import { hasLeadingCodePrefix, stripCodePrefix, rewriteSource } from '../../scripts/strip-code-prefix.mjs'
import { collectRunnerSpec } from '../../scripts/runner-spec.mjs'

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

test('the title transform does not rewrite a fixture that CONTAINS a case title', () => {
  // A test that builds a source fixture as an array of strings holds a
  // sample case title. That fixture is the SUBJECT of the case, so
  // rewriting it would change what the case proves.
  const source = [
    "import { test } from 'node:test'",
    "const fixture = [",
    "  \"test('A5b: the composition zone is one facade', () => {})\",",
    "]",
  ].join('\n')
  assert.equal(rewriteSource(source), source, 'a fixture inside a string must not be rewritten')
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

test('the runner specification with a wall clock is still valid JSON', (t) => {
  // The measured wall clock used to be APPENDED to the specification file
  // as `wall_clock_seconds=42`, which made the JSON invalid — so the
  // aggregate could not read the very file that held the measurement. The
  // wall clock is now a FIELD of the document.
  const dir = testLifecycle(t).tempDir('dsh-runner-spec-')
  {
    const path = join(dir, 'runner-spec.json')
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'runner-spec.mjs'), '--wall-clock-seconds', '42', '--out', path],
      { cwd: ROOT, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const spec = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(spec.wallClockSeconds, 42)
  }
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
    // `(review round 4)` is a REVIEW qualifier, not part of the code —
    // it stays, because it says which review produced the case.
    ['PR4 F2b.2 (review round 4): a fulfilled observation is an issue', '(review round 4): a fulfilled observation is an issue'],
    // The bracketed REVIEW qualifier is not the code — it stays.
    ['§D2 (review round 3 ruling): Direct keeps the mirror', '(review round 3 ruling): Direct keeps the mirror'],
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
