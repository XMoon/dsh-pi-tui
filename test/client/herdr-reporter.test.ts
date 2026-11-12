/**
 * H1 Herdr reporter external-process contract (plan §6.1, HR-01…HR-09).
 *
 * Every case here crosses a REAL process boundary: the reporter spawns the
 * executable fake CLI from `test/support/herdr-cli-fixture.ts` and the
 * observable fact is the argv/exit log the fake process wrote. Nothing mocks
 * `spawn`, `ProgramStatus` or the Agent semantics.
 *
 * @module @xmoon76/dsh-pi-tui/client/herdr-reporter.test
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHerdrReporter, type HerdrReporter } from '../../src/client/herdr/reporter.ts'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import { createHerdrCliFixture, type HerdrCliEntry, type HerdrCliFixture } from '../support/herdr-cli-fixture.ts'

/** A diagnostics recorder that keeps every rendered field for leak checks. */
function recordingDiag(): { diag: Diag; lines: string[] } {
  const lines: string[] = []
  const record = (level: string, message: string, fields?: Record<string, unknown>): void => {
    lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`)
  }
  return {
    lines,
    diag: {
      debug: () => {},
      info: () => {},
      warn: (message, fields) => record('warn', message, fields),
      error: (message, fields) => record('error', message, fields),
      dispose: () => {},
    },
  }
}

function reporterOf(fixture: HerdrCliFixture, initialQualified = true, diag?: Diag): HerdrReporter {
  const reporter = createHerdrReporter(fixture.env, initialQualified, diag)
  assert.ok(reporter !== undefined, 'the complete Herdr environment must create a reporter')
  return reporter
}

/** The command a `start` entry describes (`report-agent` | `release-agent`). */
function commandOf(entry: HerdrCliEntry): string {
  return entry.argv?.[1] ?? '(missing)'
}

function argAfter(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag)
  assert.ok(index >= 0, `missing ${flag} in ${JSON.stringify(argv)}`)
  return argv[index + 1] ?? '(missing)'
}

function stateOf(entry: HerdrCliEntry): string {
  return argAfter(entry.argv ?? [], '--state')
}

function seqOf(entry: HerdrCliEntry): number {
  return Number(argAfter(entry.argv ?? [], '--seq'))
}

function startCount(entries: readonly HerdrCliEntry[]): number {
  return entries.filter(entry => entry.phase === 'start').length
}

function starts(fixture: HerdrCliFixture, command?: string): HerdrCliEntry[] {
  const entries = fixture.starts()
  return command === undefined ? entries : entries.filter(entry => commandOf(entry) === command)
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

test('HR-01 an incomplete Herdr Pane environment creates no reporter and no process', async (t) => {
  const fixture = createHerdrCliFixture(t)
  const base = fixture.env
  const variants: NodeJS.ProcessEnv[] = [
    { ...base, HERDR_ENV: undefined },
    { ...base, HERDR_ENV: '0' },
    { ...base, HERDR_ENV: 'true' },
    { ...base, HERDR_PANE_ID: '' },
    { ...base, HERDR_BIN_PATH: '' },
    { ...base, HERDR_SOCKET_PATH: '' },
  ]
  for (const env of variants) {
    assert.equal(createHerdrReporter(env, true), undefined)
  }
  await delay(100)
  assert.deepEqual(fixture.entries(), [], 'no child process may be spawned without the complete environment')
})

test('HR-02 idle/working/blocked/working/idle dispatch the fixed argv, source and monotone seq', async (t) => {
  const fixture = createHerdrCliFixture(t)
  const reporter = reporterOf(fixture)
  const publishAndWait = async (status: Parameters<HerdrReporter['publish']>[0], expected: number): Promise<void> => {
    reporter.publish(status)
    await fixture.waitFor(entries => startCount(entries) >= expected, `report ${String(expected)}`)
  }
  // Each fact is observed before the next one: this is the real edge sequence,
  // not a latest-wins burst (HR-04 owns the burst contract).
  await publishAndWait({ state: 'idle' }, 1)
  await publishAndWait({ state: 'working' }, 2)
  await publishAndWait({ state: 'blocked', kind: 'permission' }, 3)
  await publishAndWait({ state: 'working' }, 4)
  await publishAndWait({ state: 'idle' }, 5)
  // `clear` is a presentation retirement, not a business status change.
  reporter.publish({ state: 'clear' })
  await delay(150)
  const reports = starts(fixture, 'report-agent')
  assert.deepEqual(reports.map(stateOf), ['idle', 'working', 'blocked', 'working', 'idle'])
  const first = reports[0]
  assert.deepEqual(first.argv, [
    'pane', 'report-agent', fixture.paneId,
    '--source', 'dsh-pi-tui',
    '--agent', 'dsh-pi-tui',
    '--state', 'idle',
    '--seq', String(seqOf(first)),
  ])
  const seqs = reports.map(seqOf)
  for (let index = 1; index < seqs.length; index += 1) {
    assert.ok(seqs[index] > seqs[index - 1], `seq must strictly increase: ${JSON.stringify(seqs)}`)
  }
  assert.equal(starts(fixture, 'release-agent').length, 0, 'no release without an invalidation/dispose')
})

test('HR-03 repeated identical states and blocked kinds never repeat a physical command', async (t) => {
  const fixture = createHerdrCliFixture(t, { delayMs: 20 })
  const reporter = reporterOf(fixture)
  reporter.publish({ state: 'blocked', kind: 'permission' })
  await fixture.waitFor(entries => startCount(entries) >= 1, 'the first blocked report')
  reporter.publish({ state: 'blocked', kind: 'question' })
  reporter.publish({ state: 'blocked', kind: 'permission' })
  reporter.publish({ state: 'blocked', kind: 'question' })
  await delay(150)
  assert.deepEqual(starts(fixture).map(stateOf), ['blocked'], 'the blocked kind is not part of the Herdr contract')
  reporter.publish({ state: 'working' })
  await fixture.waitFor(entries => startCount(entries) >= 2, 'a real state change reports')
  assert.deepEqual(starts(fixture).map(stateOf), ['blocked', 'working'])
})

test('HR-04 a slow child never stacks: one live process and one latest pending intent', async (t) => {
  const fixture = createHerdrCliFixture(t, { firstDelayMs: 350, delayMs: 20 })
  const reporter = reporterOf(fixture)
  reporter.publish({ state: 'working' })
  await fixture.waitFor(entries => startCount(entries) >= 1, 'the slow first child started')
  // 100 synchronous flips while the first child is still running.
  for (let index = 0; index < 100; index += 1) {
    reporter.publish(index % 2 === 0 ? { state: 'blocked', kind: 'permission' } : { state: 'working' })
  }
  await fixture.waitFor(entries => startCount(entries) >= 2, 'the latest pending state dispatched')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length >= 2, 'both children exited')
  const entries = fixture.entries()
  assert.equal(startCount(entries), 2,
    `rapid churn must collapse to the first report plus ONE latest state: ${JSON.stringify(entries)}`)
  assert.deepEqual(entries.map(entry => entry.phase).slice(0, 4), ['start', 'end', 'start', 'end'],
    'a second child must never start before the first exits')
  assert.deepEqual(starts(fixture).map(stateOf), ['working', 'working'],
    'the intermediate blocked state was superseded by the final working state')
  assert.ok(!starts(fixture).some(entry => stateOf(entry) === 'blocked'))
})

test('HR-05 non-zero exit, spawn ENOENT and timeout never throw and never poison later reports', async (t) => {
  const nonZero = createHerdrCliFixture(t, { exitCode: 3 })
  const recorder = recordingDiag()
  const nonZeroReporter = reporterOf(nonZero, true, recorder.diag)
  assert.doesNotThrow(() => nonZeroReporter.publish({ state: 'working' }))
  await nonZero.waitFor(entries => entries.some(entry => entry.phase === 'end' && entry.code === 3), 'the non-zero exit')
  nonZeroReporter.publish({ state: 'blocked', kind: 'permission' })
  await nonZero.waitFor(entries => startCount(entries) >= 2, 'a report after the failed CLI')
  assert.deepEqual(starts(nonZero).map(stateOf), ['working', 'blocked'])
  assert.ok(recorder.lines.some(line => line.includes('"reason":"report"') && line.includes('"code":3')),
    `the non-zero exit is diagnosed without argv: ${JSON.stringify(recorder.lines)}`)

  const missing = createHerdrCliFixture(t, {
    binPath: join(tmpdir(), `herdr-does-not-exist-${String(process.pid)}-${Date.now().toString(36)}`),
  })
  const missingRecorder = recordingDiag()
  const missingReporter = reporterOf(missing, true, missingRecorder.diag)
  assert.doesNotThrow(() => missingReporter.publish({ state: 'working' }))
  assert.doesNotThrow(() => missingReporter.publish({ state: 'blocked', kind: 'permission' }))
  await delay(100)
  assert.ok(missingRecorder.lines.some(line => line.includes('ENOENT')),
    `a spawn ENOENT is diagnosed: ${JSON.stringify(missingRecorder.lines)}`)
  assert.deepEqual(missing.entries(), [], 'a missing executable can never run the fake CLI')

  const slow = createHerdrCliFixture(t, { firstDelayMs: 900, delayMs: 0 })
  const slowReporter = reporterOf(slow)
  slowReporter.publish({ state: 'working' })
  await slow.waitFor(entries => startCount(entries) >= 1, 'the slow child started')
  // The 500 ms bound kills it; the same reporter must still dispatch the next fact.
  slowReporter.publish({ state: 'blocked', kind: 'question' })
  await slow.waitFor(entries => startCount(entries) >= 2, 'the report after the timed-out child', 5_000)
  const firstSlow = starts(slow)[0]
  assert.ok(firstSlow.pid > 0)
  assert.ok(!slow.entries().some(entry => entry.phase === 'end' && entry.pid === firstSlow.pid),
    'the timed-out child was terminated instead of running to completion')
  await slow.waitFor(entries => entries.some(entry => entry.phase === 'end'), 'the second child exits')
})

test('HR-06 setQualified(false) releases in order and a requalification reports the current fact', async (t) => {
  const fixture = createHerdrCliFixture(t, { firstDelayMs: 250, delayMs: 0 })
  const reporter = reporterOf(fixture)
  reporter.publish({ state: 'working' })
  await fixture.waitFor(entries => startCount(entries) >= 1, 'the in-flight report')
  // A newer state waits behind the live child...
  reporter.publish({ state: 'blocked', kind: 'permission' })
  // ...and the qualification loss clears it, queueing the ordered withdrawal.
  reporter.setQualified(false)
  reporter.setQualified(false)
  await fixture.waitFor(entries => starts(fixture, 'release-agent').length === 1, 'one ordered release')
  assert.equal(starts(fixture, 'report-agent').length, 1, 'the superseded blocked report never dispatched')
  // Re-qualification publishes the CURRENT logical fact after the release.
  reporter.setQualified(true)
  await fixture.waitFor(entries => startCount(entries) >= 3, 'the requalified report')
  assert.deepEqual(fixture.starts().map(entry => commandOf(entry) === 'release-agent' ? 'release' : stateOf(entry)),
    ['working', 'release', 'blocked'])
  const [working, release, blocked] = fixture.starts()
  assert.ok(seqOf(release) > seqOf(working))
  assert.ok(seqOf(blocked) > seqOf(release), 'reports and releases share one monotone sequence')
})

test('HR-07 dispose is idempotent, releases once and stops every later publication', async (t) => {
  const fixture = createHerdrCliFixture(t, { delayMs: 100 })
  const reporter = reporterOf(fixture)
  reporter.publish({ state: 'working' })
  await fixture.waitFor(entries => startCount(entries) >= 1, 'the in-flight report')
  reporter.dispose()
  reporter.dispose()
  reporter.publish({ state: 'idle' })
  reporter.setQualified(true)
  await fixture.waitFor(entries => starts(fixture, 'release-agent').length === 1, 'the dispose release')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length >= 2, 'every child exited')
  await delay(100)
  assert.equal(starts(fixture, 'release-agent').length, 1, 'a repeated dispose never releases twice')
  assert.deepEqual(fixture.starts().map(entry => commandOf(entry) === 'release-agent' ? 'release' : stateOf(entry)),
    ['working', 'release'])
})

test('HR-08 a hostile-looking Pane id stays one literal argv element and secrets never reach diagnostics', async (t) => {
  const marker = join(tmpdir(), `herdr-injection-marker-${String(process.pid)}-${Date.now().toString(36)}`)
  const paneId = `pane "one" $(touch ${marker})`
  const secret = `herdr-secret-${String(process.pid)}-${Date.now().toString(36)}`
  const fixture = createHerdrCliFixture(t, { paneId, exitCode: 3 })
  fixture.env.HERDR_TEST_SECRET = secret
  const recorder = recordingDiag()
  const reporter = reporterOf(fixture, true, recorder.diag)
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => entries.some(entry => entry.phase === 'end'), 'the failing invocation')
  const start = starts(fixture)[0]
  assert.deepEqual(start.argv, [
    'pane', 'report-agent', paneId,
    '--source', 'dsh-pi-tui',
    '--agent', 'dsh-pi-tui',
    '--state', 'idle',
    '--seq', String(seqOf(start)),
  ], 'the Pane id must be exactly one literal argv element')
  assert.equal(existsSync(marker), false, 'no shell expansion may execute the Pane id')
  for (const line of recorder.lines) {
    assert.ok(!line.includes(secret), `diagnostics leaked an environment secret: ${line}`)
    assert.ok(!line.includes(paneId), `diagnostics leaked the Pane id/argv: ${line}`)
  }
})

test('HR-09 two fresh reporters start their sequence from the wall clock, never from 1', async (t) => {
  const before = Date.now()
  const firstFixture = createHerdrCliFixture(t)
  const secondFixture = createHerdrCliFixture(t)
  const first = reporterOf(firstFixture)
  const second = reporterOf(secondFixture)
  first.publish({ state: 'idle' })
  second.publish({ state: 'idle' })
  await firstFixture.waitFor(entries => startCount(entries) >= 1, 'the first reporter report')
  await secondFixture.waitFor(entries => startCount(entries) >= 1, 'the second reporter report')
  const firstSeq = seqOf(starts(firstFixture)[0])
  const secondSeq = seqOf(starts(secondFixture)[0])
  assert.ok(Number.isSafeInteger(firstSeq) && Number.isSafeInteger(secondSeq))
  assert.ok(firstSeq >= before * 1000, `the first reporter seq ${String(firstSeq)} is not wall-clock based`)
  assert.ok(secondSeq >= before * 1000, `the second reporter seq ${String(secondSeq)} is not wall-clock based`)
  assert.notEqual(firstSeq, 1)
  assert.notEqual(secondSeq, 1)
})
