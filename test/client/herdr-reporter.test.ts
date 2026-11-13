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

/** Wait for a diagnostic line produced by the parent's asynchronous child
 *  `close` handler; the fake CLI's `end` log entry alone does not prove that
 *  callback has run yet. */
async function waitForDiagnosed(
  lines: readonly string[],
  predicate: (lines: readonly string[]) => boolean,
  label: string,
  deadlineMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    if (predicate(lines)) return
    if (Date.now() > deadline) {
      throw new Error(`${label} did not occur within ${String(deadlineMs)}ms; diagnostics: ${JSON.stringify(lines)}`)
    }
    await delay(10)
  }
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

// ── H2 (plan §4.1): the main-Session report on the SAME ordered queue ───────

const SESSION_A = `session-${'a'.repeat(32)}`
const SESSION_B = `session-${'b'.repeat(32)}`
const SESSION_C = `session-${'c'.repeat(32)}`
const SESSION_T = `session-${'d'.repeat(32)}`
const PROFILE = 'pi-tui'

function sessionStarts(fixture: HerdrCliFixture): HerdrCliEntry[] {
  return starts(fixture, 'report-agent-session')
}

function resumeArgvOf(entry: HerdrCliEntry): readonly string[] | undefined {
  const argv = entry.argv ?? []
  const separator = argv.indexOf('--')
  return separator < 0 ? undefined : argv.slice(separator + 1)
}

function sessionIdOf(entry: HerdrCliEntry): string {
  return argAfter(entry.argv ?? [], '--agent-session-id')
}

function directSession(id: string): { sessionId: string; resumeArgv: readonly string[] } {
  return { sessionId: id, resumeArgv: ['dsh', '--profile', PROFILE, '--session', id] }
}

/**
 * Wait until every started fake-CLI child has its own `end` line: the
 * authoritative queue-settle signal (never a fixed window).
 */
async function settleQueue(fixture: HerdrCliFixture, label = 'the fake CLI queue settled'): Promise<void> {
  await fixture.waitFor((entries) => {
    const started = new Set(entries.filter(entry => entry.phase === 'start').map(entry => entry.pid))
    const ended = new Set(entries.filter(entry => entry.phase === 'end').map(entry => entry.pid))
    return [...started].every(pid => ended.has(pid))
  }, label)
}

/**
 * Settle the queue AND the dispatch a `close` handler may start: a child writes
 * its `end` line BEFORE the parent's close callback runs, so a bare settle can
 * miss a dispatch started from that callback. One `setImmediate` continuation runs
 * after the I/O callbacks, and the queue is then settled again.
 */
async function settleThroughDispatch(fixture: HerdrCliFixture, label?: string): Promise<void> {
  await settleQueue(fixture, label)
  await new Promise<void>(resolve => setImmediate(resolve))
  await settleQueue(fixture, label)
}

/** Session invocations whose own child exited 0 (Herdr actually accepted them). */
function deliveredSessions(fixture: HerdrCliFixture): string[] {
  const entries = fixture.entries()
  const endedOk = new Set(entries.filter(entry => entry.phase === 'end' && entry.code === 0).map(entry => entry.pid))
  return fixture.sessions()
    .filter((_, index) => endedOk.has(sessionStarts(fixture)[index].pid))
    .map(session => session.sessionId)
}

function startPhases(entries: readonly HerdrCliEntry[]): string[] {
  return entries.filter(entry => entry.phase === 'start').map(entry => {
    if (entry.argv?.[1] === 'release-agent') return 'release'
    if (entry.argv?.[1] === 'report-agent-session') return 'session'
    return 'state'
  })
}

test('a Direct initial Session reports after the first successful state with the exact five-word argv', async (t) => {
  const fixture = createHerdrCliFixture(t)
  const reporter = reporterOf(fixture)
  const session = directSession(SESSION_A)
  reporter.publish({ state: 'idle' })
  reporter.observeSession(session)
  await fixture.waitFor(entries => startCount(entries) >= 2, 'the state and session reports')
  const [state, sessionEntry] = fixture.starts()
  assert.equal(commandOf(state), 'report-agent', 'the state report must be the FIRST Pane command')
  assert.equal(commandOf(sessionEntry), 'report-agent-session', 'the Session report must follow the state')
  assert.deepEqual(sessionEntry.argv, [
    'pane', 'report-agent-session', fixture.paneId,
    '--source', 'dsh-pi-tui',
    '--agent', 'dsh-pi-tui',
    '--seq', String(seqOf(sessionEntry)),
    '--agent-session-id', SESSION_A,
    '--', 'dsh', '--profile', PROFILE, '--session', SESSION_A,
  ])
  assert.ok(seqOf(sessionEntry) > seqOf(state), 'state and Session share one monotone seq')
  assert.deepEqual(fixture.sessions(), [{ sessionId: SESSION_A, resumeArgv: session.resumeArgv }])
})

test('a sessionless start buffers the first Session and fabricates no predecessor', async (t) => {
  const fixture = createHerdrCliFixture(t)
  const reporter = reporterOf(fixture)
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => startCount(entries) >= 1, 'the initial idle report')
  assert.deepEqual(sessionStarts(fixture), [], 'a sessionless Pane must report no Session')
  reporter.observeSession(directSession(SESSION_A))
  await fixture.waitFor(entries => sessionStarts(fixture).length === 1, 'the first Session')
  assert.deepEqual(fixture.sessions().map(entry => entry.sessionId), [SESSION_A])
  assert.deepEqual(startPhases(fixture.entries()), ['state', 'session'])
})

test('a recoverable switch reports only the new Session, with no release and no Agent-state touch', async (t) => {
  const fixture = createHerdrCliFixture(t)
  const reporter = reporterOf(fixture)
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => startCount(entries) >= 1, 'the idle report')
  reporter.observeSession(directSession(SESSION_A))
  await fixture.waitFor(entries => sessionStarts(fixture).length === 1, 'Session A')
  reporter.observeSession(directSession(SESSION_B))
  await fixture.waitFor(entries => sessionStarts(fixture).length === 2, 'Session B')
  assert.deepEqual(fixture.sessions().map(entry => entry.sessionId), [SESSION_A, SESSION_B])
  assert.equal(starts(fixture, 'release-agent').length, 0, 'a normal recoverable switch never releases')
  assert.equal(starts(fixture, 'report-agent').length, 1, 'the Agent state was not republished')
})

test('a three-way churn with a blocked first Session child collapses to the first and the final Session', async (t) => {
  const fixture = createHerdrCliFixture(t, { sessionDelayMs: 350 })
  const reporter = reporterOf(fixture)
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 1, 'the idle report')
  reporter.observeSession(directSession(SESSION_A))
  await fixture.waitFor(entries => sessionStarts(fixture).length === 1, 'the slow Session A')
  reporter.observeSession(directSession(SESSION_B))
  reporter.observeSession(directSession(SESSION_C))
  await fixture.waitFor(entries => sessionStarts(fixture).length === 2, 'the final Session C')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length >= 3, 'the state and both sessions ended')
  assert.deepEqual(fixture.sessions().map(entry => entry.sessionId), [SESSION_A, SESSION_C],
    'B was superseded before it ever dispatched')
  const timeline = startPhases(fixture.entries())
  assert.deepEqual(timeline, ['state', 'session', 'session'], 'a second child never starts before the first exits')
  const [firstSession, secondSession] = fixture.entries()
    .filter(entry => entry.phase === 'start' && entry.argv?.[1] === 'report-agent-session')
  assert.notEqual(firstSession.pid, secondSession.pid)
})

test('losing the recoverable target withdraws the old resume exactly once and re-registers', async (t) => {
  // Sessionless: Direct resume A -> no Session.
  const sessionless = createHerdrCliFixture(t, { sessionDelayMs: 20 })
  const sessionlessReporter = reporterOf(sessionless)
  sessionlessReporter.publish({ state: 'idle' })
  await sessionless.waitFor(entries => starts(sessionless, 'report-agent').length === 1, 'the idle report')
  sessionlessReporter.observeSession(directSession(SESSION_A))
  await sessionless.waitFor(entries => sessionStarts(sessionless).length === 1, 'Session A')
  sessionlessReporter.observeSession(undefined)
  await sessionless.waitFor(entries => starts(sessionless, 'release-agent').length === 1, 'the cleanup release')
  await sessionless.waitFor(entries => starts(sessionless, 'report-agent').length === 2, 'the re-registration')
  await settleThroughDispatch(sessionless)
  assert.deepEqual(startPhases(sessionless.entries()), ['state', 'session', 'release', 'state'],
    'the cleanup is an ORDERED release then re-acquire, and no Session follows a sessionless target')
  assert.equal(sessionStarts(sessionless).length, 1)

  // A recoverable A -> a canonical B WITHOUT a legal resume (Remote-shaped):
  // the old A resume must be withdrawn, then B's id reported without `--`.
  const remoteShaped = createHerdrCliFixture(t, { sessionDelayMs: 20 })
  const remoteShapedReporter = reporterOf(remoteShaped)
  remoteShapedReporter.publish({ state: 'idle' })
  await remoteShaped.waitFor(entries => starts(remoteShaped, 'report-agent').length === 1, 'the idle report')
  remoteShapedReporter.observeSession(directSession(SESSION_A))
  await remoteShaped.waitFor(entries => sessionStarts(remoteShaped).length === 1, 'Session A')
  remoteShapedReporter.observeSession({ sessionId: SESSION_B })
  await remoteShaped.waitFor(entries => sessionStarts(remoteShaped).length === 2, 'Session B without resume')
  await remoteShaped.waitFor(entries => starts(remoteShaped, 'release-agent').length === 1, 'the cleanup release')
  assert.deepEqual(remoteShaped.sessions().map(entry => entry.sessionId), [SESSION_A, SESSION_B])
  assert.deepEqual(remoteShaped.sessions()[1].resumeArgv, undefined)
  assert.deepEqual(startPhases(remoteShaped.entries()), ['state', 'session', 'release', 'state', 'session'])
})

test('a Remote Session is reported without any resume argv and only after qualification', async (t) => {
  const fixture = createHerdrCliFixture(t)
  const reporter = reporterOf(fixture, false)
  reporter.publish({ state: 'idle' })
  reporter.observeSession({ sessionId: SESSION_A })
  // An UNqualified reporter has no dispatch path at all (both calls return
  // before `enqueue`), so this negative needs no observation window.
  assert.deepEqual(fixture.entries(), [], 'an unqualified Remote Client must spawn nothing')

  reporter.setQualified(true)
  await fixture.waitFor(entries => sessionStarts(fixture).length === 1, 'the Remote Session A')
  reporter.observeSession({ sessionId: SESSION_T })
  await fixture.waitFor(entries => sessionStarts(fixture).length === 2, 'the Remote Session T')
  assert.deepEqual(fixture.sessions(), [{ sessionId: SESSION_A }, { sessionId: SESSION_T }])
  for (const entry of sessionStarts(fixture)) {
    assert.equal(resumeArgvOf(entry), undefined, 'Remote must never carry a resume argv')
    assert.equal(entry.argv?.includes('--'), false)
  }
  assert.equal(starts(fixture, 'release-agent').length, 0)
})

test('a lost Remote generation releases first and requalification reports only the current Session', async (t) => {
  const fixture = createHerdrCliFixture(t)
  const reporter = reporterOf(fixture)
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 1, 'the idle report')
  reporter.observeSession({ sessionId: SESSION_A })
  await fixture.waitFor(entries => sessionStarts(fixture).length === 1, 'Session A')
  reporter.setQualified(false)
  reporter.observeSession({ sessionId: SESSION_T })
  await fixture.waitFor(entries => starts(fixture, 'release-agent').length === 1, 'the ordered release')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length >= 3, 'the release settled')
  reporter.setQualified(true)
  await fixture.waitFor(entries => sessionStarts(fixture).length === 2, 'the requalified Session T')
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 2, 'the requalified state')
  assert.deepEqual(startPhases(fixture.entries()), ['state', 'session', 'release', 'state', 'session'])
  const afterRelease = fixture.entries().slice(fixture.entries().findIndex(entry => entry.phase === 'start' && entry.argv?.[1] === 'release-agent'))
  assert.equal(afterRelease.some(entry => entry.phase === 'start' && entry.argv?.[1] === 'report-agent-session' && sessionIdOf(entry) === SESSION_A), false,
    'the lost generation Session A must never be replayed')
  assert.deepEqual(fixture.sessions().map(entry => entry.sessionId), [SESSION_A, SESSION_T])
})

test('a same-identity re-notification is deduped and a real Session change is not lost', async (t) => {
  const fixture = createHerdrCliFixture(t)
  const reporter = reporterOf(fixture)
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 1, 'the idle report')
  const projection = directSession(SESSION_A)
  reporter.observeSession(projection)
  await fixture.waitFor(entries => sessionStarts(fixture).length === 1, 'Session A')
  // Same committed owner notified again (a generation-only bump), and again
  // without any StatusStore change: no physical Session command may appear.
  reporter.observeSession(projection)
  reporter.observeSession(directSession(SESSION_A))
  await settleThroughDispatch(fixture)
  assert.equal(sessionStarts(fixture).length, 1, 'the same id/argv notification is deduped')
  // A real owner change must be reported even when no Agent status changes.
  reporter.observeSession(directSession(SESSION_T))
  await fixture.waitFor(entries => sessionStarts(fixture).length === 2, 'the real Session change')
  assert.deepEqual(fixture.sessions().map(entry => entry.sessionId), [SESSION_A, SESSION_T])
})

test('a blocked state and a Session change share one seq and neither erases the other', async (t) => {
  const fixture = createHerdrCliFixture(t, { delayMs: 20 })
  const recorder = recordingDiag()
  const reporter = reporterOf(fixture, true, recorder.diag)
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 1, 'the idle report')
  reporter.publish({ state: 'blocked', kind: 'question' })
  reporter.observeSession(directSession(SESSION_A))
  await fixture.waitFor(entries => sessionStarts(fixture).length === 1, 'the Session after blocked')
  const blocked = starts(fixture, 'report-agent')[1]
  const session = sessionStarts(fixture)[0]
  assert.equal(stateOf(blocked), 'blocked')
  assert.ok(seqOf(session) > seqOf(blocked), 'the Session report shares the blocked report seq order')
  assert.deepEqual(startPhases(fixture.entries()), ['state', 'state', 'session'])
  assert.ok(!recorder.lines.some(line => line.includes(SESSION_A)), 'diagnostics never carry the Session id')
})

test('external failures stay contained, leave no backlog and leak no Session data', async (t) => {
  // Non-zero status exit: the Session stays buffered, never dispatched.
  const failing = createHerdrCliFixture(t, { exitCode: 3 })
  const failingReporter = reporterOf(failing)
  failingReporter.publish({ state: 'working' })
  failingReporter.observeSession(directSession(SESSION_A))
  await failing.waitFor(entries => entries.some(entry => entry.phase === 'end' && entry.code === 3), 'the failed first report')
  failingReporter.publish({ state: 'blocked', kind: 'permission' })
  await failing.waitFor(entries => starts(failing, 'report-agent').length === 2, 'the later status attempt')
  await settleThroughDispatch(failing)
  assert.deepEqual(sessionStarts(failing), [], 'no Session may follow an unacknowledged Pane')

  // Spawn ENOENT: contained, diagnosed without the Session id or profile.
  const secretProfile = `profile-secret-${String(process.pid)}`
  const missing = createHerdrCliFixture(t, {
    binPath: join(tmpdir(), `herdr-missing-${String(process.pid)}-${Date.now().toString(36)}`),
  })
  const recorder = recordingDiag()
  const missingReporter = reporterOf(missing, true, recorder.diag)
  const secretProjection = {
    sessionId: SESSION_A,
    resumeArgv: ['dsh', '--profile', secretProfile, '--session', SESSION_A],
  }
  assert.doesNotThrow(() => {
    missingReporter.publish({ state: 'working' })
    missingReporter.observeSession(secretProjection)
  })
  // The spawn error is reported by the diagnostics sink itself: wait for that
  // authoritative observation rather than for a fixed window.
  await missing.waitFor(() => recorder.lines.length > 0, 'the spawn error is diagnosed')
  assert.ok(recorder.lines.some(line => line.includes('ENOENT')), `ENOENT is diagnosed: ${JSON.stringify(recorder.lines)}`)
  for (const line of recorder.lines) {
    assert.ok(!line.includes(SESSION_A), `diagnostics leaked the Session id: ${line}`)
    assert.ok(!line.includes(secretProfile), `diagnostics leaked the profile: ${line}`)
  }

  // A timed-out Session child is killed and a later real Session still reports.
  const slow = createHerdrCliFixture(t, { sessionDelayMs: 900 })
  const slowReporter = reporterOf(slow)
  slowReporter.publish({ state: 'idle' })
  await slow.waitFor(entries => starts(slow, 'report-agent').length === 1, 'the idle report')
  slowReporter.observeSession(directSession(SESSION_A))
  await slow.waitFor(entries => sessionStarts(slow).length === 1, 'the slow Session A')
  slowReporter.observeSession(directSession(SESSION_T))
  await slow.waitFor(entries => sessionStarts(slow).length === 2, 'the Session after the timeout', 5_000)
  assert.deepEqual(slow.sessions().map(entry => entry.sessionId), [SESSION_A, SESSION_T])
  // The second Session child is still inside its 500 ms timeout window: let the
  // reporter's own bound kill it so no child outlives this test process group.
  await delay(600)

  // Dispose while a Session child is in flight: exactly one ordered release,
  // then no later child of any kind.
  const disposing = createHerdrCliFixture(t, { sessionDelayMs: 250 })
  const disposingReporter = reporterOf(disposing)
  disposingReporter.publish({ state: 'idle' })
  await disposing.waitFor(entries => starts(disposing, 'report-agent').length === 1, 'the idle report')
  disposingReporter.observeSession(directSession(SESSION_A))
  await disposing.waitFor(entries => sessionStarts(disposing).length === 1, 'the in-flight Session')
  disposingReporter.dispose()
  disposingReporter.observeSession(directSession(SESSION_T))
  disposingReporter.setQualified(true)
  await disposing.waitFor(entries => starts(disposing, 'release-agent').length === 1, 'the dispose release')
  await settleThroughDispatch(disposing)
  assert.equal(starts(disposing, 'release-agent').length, 1, 'dispose is idempotent')
  assert.equal(sessionStarts(disposing).length, 1, 'no Session after dispose')
  assert.deepEqual(startPhases(disposing.entries()), ['state', 'session', 'release'])
})

// ── H2 abnormal-recovery contract (external review F1/F2/F3) ─────────────────

test('a failed cleanup release claims nothing and a later real event retries it', async (t) => {
  const fixture = createHerdrCliFixture(t, { sessionDelayMs: 20 })
  const recorder = recordingDiag()
  const reporter = reporterOf(fixture, true, recorder.diag)
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 1, 'the idle registration')
  reporter.observeSession(directSession(SESSION_A))
  await fixture.waitFor(entries => sessionStarts(fixture).length === 1, 'Session A with a resume argv')

  // The withdrawal of the saved resume target FAILS (non-zero exit).
  fixture.env.HERDR_FAKE_EXIT_CODE = '3'
  reporter.observeSession(undefined)
  await fixture.waitFor(entries => entries.some(entry => entry.phase === 'end'
    && entry.code === 3
    && starts(fixture, 'release-agent').length === 1), 'the failed cleanup release')
  await settleThroughDispatch(fixture)
  await waitForDiagnosed(recorder.lines,
    lines => lines.some(line => line.includes('"reason":"release"') && line.includes('"code":3')),
    'the failed withdrawal is diagnosed without argv')
  assert.equal(starts(fixture, 'report-agent').length, 1,
    'a failed withdrawal must NOT re-register the Pane (the resume target may still be saved)')
  assert.equal(sessionStarts(fixture).length, 1, 'no Session may be claimed after a failed cleanup')
  assert.deepEqual(startPhases(fixture.entries()), ['state', 'session', 'release'],
    'the failed withdrawal must not be followed by a re-registration')

  // A LATER real lifecycle event (the same logical state is still a real fact)
  // retries the outstanding cleanup exactly once; only its success re-registers.
  fixture.env.HERDR_FAKE_EXIT_CODE = '0'
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => starts(fixture, 'release-agent').length === 2, 'the retried cleanup')
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 2,
    'the re-registration after the SUCCESSFUL retried cleanup')
  await settleThroughDispatch(fixture)
  assert.deepEqual(startPhases(fixture.entries()), ['state', 'session', 'release', 'release', 'state'],
    'the Pane is re-registered only after the withdrawal really succeeded')
  assert.equal(sessionStarts(fixture).length, 1, 'the sessionless target still reports no Session')
  const [firstRelease, secondRelease] = fixture.starts().filter(entry => commandOf(entry) === 'release-agent')
  assert.ok(seqOf(secondRelease) > seqOf(firstRelease), 'both withdrawals share the one monotone seq')
})

test('a first state-registration failure is repaired by a Session-only change', async (t) => {
  const fixture = createHerdrCliFixture(t, { firstDelayMs: 0 })
  const reporter = reporterOf(fixture)
  // The FIRST `report-agent` fails: the Pane is never held.
  fixture.env.HERDR_FAKE_EXIT_CODE = '3'
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => entries.some(entry => entry.phase === 'end'
    && entry.code === 3 && starts(fixture, 'report-agent').length === 1), 'the failed first registration')

  // Herdr recovers, and the ONLY change is the main Session (the Agent stays
  // idle, so the H1 state dedupe alone would never dispatch again).
  fixture.env.HERDR_FAKE_EXIT_CODE = '0'
  reporter.observeSession({ sessionId: SESSION_B })
  await fixture.waitFor(entries => sessionStarts(fixture).length === 1,
    'the Session after the repaired registration')
  const phases = startPhases(fixture.entries())
  assert.deepEqual(phases, ['state', 'state', 'session'],
    `the Session-only change must re-register the Pane first; the log is ${JSON.stringify(phases)}`)
  assert.deepEqual(fixture.sessions(), [{ sessionId: SESSION_B }],
    'the Remote-shaped Session is reported without a resume argv')
})

test('dispose during an in-flight cleanup release never starts a second one', async (t) => {
  // `delayMs` keeps the cleanup withdrawal IN FLIGHT long enough for the
  // dispose below to arrive while it is still the active child (and still
  // inside the reporter's own 500 ms bound).
  const fixture = createHerdrCliFixture(t, { delayMs: 400 })
  const reporter = reporterOf(fixture)
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 1, 'the idle registration')
  reporter.observeSession(directSession(SESSION_A))
  await fixture.waitFor(entries => sessionStarts(fixture).length === 1, 'the in-flight Session A')
  // The cleanup withdrawal waits behind the in-flight Session child.
  reporter.observeSession(undefined)
  await fixture.waitFor(entries => starts(fixture, 'release-agent').length === 1, 'the cleanup release')
  // Dispose WHILE that release is still running: it already covers the teardown.
  const releasePid = starts(fixture, 'release-agent')[0].pid
  reporter.dispose()
  reporter.dispose()
  await fixture.waitFor(entries => entries.some(entry => entry.phase === 'end' && entry.pid === releasePid),
    'the cleanup release settled')
  await settleThroughDispatch(fixture)
  assert.equal(starts(fixture, 'release-agent').length, 1,
    `dispose must not duplicate an already-owed withdrawal: ${JSON.stringify(startPhases(fixture.entries()))}`)
  assert.deepEqual(startPhases(fixture.entries()), ['state', 'session', 'release'])
})

test('a startup sample during the first state child never duplicates the registration', async (t) => {
  // The composition samples the owner immediately after subscribing. On a
  // sessionless start that sample has no Session AND typically arrives while the
  // very first `report-agent` child is still in flight.
  const fixture = createHerdrCliFixture(t, { firstDelayMs: 300, delayMs: 0 })
  const reporter = reporterOf(fixture)
  reporter.publish({ state: 'idle' })
  reporter.observeSession(undefined)
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length >= 1, 'the first state child')
  await fixture.waitFor(entries => entries.some(entry => entry.phase === 'end'), 'the first state settled')
  await settleThroughDispatch(fixture)
  assert.deepEqual(startPhases(fixture.entries()), ['state'],
    'a sessionless sample must not duplicate the in-flight state registration')
  // A later REAL Session is still reported exactly once, after that state.
  reporter.observeSession({ sessionId: SESSION_A })
  await fixture.waitFor(entries => sessionStarts(fixture).length === 1, 'the Session after the state')
  assert.deepEqual(startPhases(fixture.entries()), ['state', 'session'])
})

test('a failed Session report is retried by the next real Agent state fact', async (t) => {
  const fixture = createHerdrCliFixture(t, { sessionDelayMs: 10 })
  const recorder = recordingDiag()
  const reporter = reporterOf(fixture, true, recorder.diag)
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 1, 'the idle registration')
  reporter.observeSession(directSession(SESSION_A))
  await fixture.waitFor(entries => sessionStarts(fixture).length === 1, 'Session A delivered')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length
    >= entries.filter(entry => entry.phase === 'start').length, 'the queue settled after A')

  // B's report FAILS: the dispatched intent left the queue, so only the
  // delivered baseline (`lastSession` = A) still proves what Herdr holds.
  fixture.env.HERDR_FAKE_SESSION_EXIT_CODE = '3'
  reporter.observeSession(directSession(SESSION_B))
  await fixture.waitFor(entries => sessionStarts(fixture).length === 2, 'the Session B child')
  const failedSessionPid = sessionStarts(fixture)[1].pid
  await fixture.waitFor(entries => entries.some(entry => entry.phase === 'end'
    && entry.pid === failedSessionPid && entry.code === 3), 'the failed Session B')
  // The child's `end` line is written BEFORE the reporter's close handler runs;
  // wait for the handler's own diagnostic so the next event cannot race it.
  await fixture.waitFor(() => recorder.lines.some(line => line.includes('"reason":"session"')
    && line.includes('"code":3')), 'the reporter observed the Session failure')
  await settleThroughDispatch(fixture)
  assert.deepEqual(deliveredSessions(fixture), [SESSION_A],
    'the failed report must not be treated as delivered')
  assert.deepEqual(startPhases(fixture.entries()), ['state', 'session', 'session'],
    'the failed session dispatch is the last child: nothing retried it by itself')

  // A REAL Agent state fact is the lifecycle event that reconciles it.
  fixture.env.HERDR_FAKE_SESSION_EXIT_CODE = ''
  reporter.publish({ state: 'working' })
  // Wait on DELIVERY (exit 0), not on a dispatch count: the failed B already
  // occupies one dispatch slot, so a count would pass before the retry exists.
  await fixture.waitFor(() => deliveredSessions(fixture).length === 2, 'Session B delivered')
  await settleQueue(fixture, 'the retry settled')
  assert.deepEqual(deliveredSessions(fixture), [SESSION_A, SESSION_B],
    'the CURRENT Session must win after the retry')
  const lastInvocation = fixture.sessions().at(-1)
  assert.deepEqual(lastInvocation?.resumeArgv,
    ['dsh', '--profile', PROFILE, '--session', SESSION_B])
  // The invariant is the ORDER of the winning facts, not the number of attempts
  // an event may legitimately retry: the new state report exists, and the final
  // Session dispatch follows it.
  const phases = startPhases(fixture.entries())
  const lastStateAt = phases.lastIndexOf('state')
  const lastSessionAt = phases.lastIndexOf('session')
  assert.ok(lastStateAt >= 0 && lastSessionAt > lastStateAt,
    `the final Session dispatch must follow the new state registration: ${JSON.stringify(phases)}`)
  const statesSeq = starts(fixture, 'report-agent').map(entry => stateOf(entry))
  assert.ok(statesSeq.includes('working'), 'the new Agent state is reported')
})

test('a failed cleanup release is retried by a changed Agent state fact', async (t) => {
  const fixture = createHerdrCliFixture(t, { sessionDelayMs: 10 })
  const recorder = recordingDiag()
  const reporter = reporterOf(fixture, true, recorder.diag)
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 1, 'the idle registration')
  reporter.observeSession(directSession(SESSION_A))
  await fixture.waitFor(entries => sessionStarts(fixture).length === 1, 'Session A delivered')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length
    >= entries.filter(entry => entry.phase === 'start').length, 'the queue settled after A')

  // The cleanup withdrawal FAILS while the Agent is idle.
  fixture.env.HERDR_FAKE_EXIT_CODE = '3'
  reporter.observeSession(undefined)
  await fixture.waitFor(entries => starts(fixture, 'release-agent').length === 1, 'the cleanup release child')
  const failedReleasePid = starts(fixture, 'release-agent')[0].pid
  await fixture.waitFor(entries => entries.some(entry => entry.phase === 'end'
    && entry.pid === failedReleasePid && entry.code === 3), 'the failed cleanup release')
  await fixture.waitFor(() => recorder.lines.some(line => line.includes('"reason":"release"')
    && line.includes('"code":3')), 'the reporter observed the cleanup failure')
  await settleThroughDispatch(fixture)
  assert.equal(starts(fixture, 'release-agent').length, 1, 'the failed withdrawal is not retried by itself')
  assert.equal(starts(fixture, 'report-agent').length, 1, 'the Pane must stay unregistered')

  // The Agent moves idle -> working: a state CHANGE (not a deduped repeat) must
  // still retry the outstanding cleanup, then re-register the current fact.
  fixture.env.HERDR_FAKE_EXIT_CODE = '0'
  reporter.publish({ state: 'working' })
  await fixture.waitFor(entries => starts(fixture, 'release-agent').length === 2, 'the retried cleanup')
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 2, 'the re-registration')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length
    >= entries.filter(entry => entry.phase === 'start').length, 'the recovery settled')
  // The retried withdrawal must precede the re-registration, and no Session may
  // follow a sessionless target; the exact number of attempts is not the
  // contract (an event may legitimately retry once).
  const phases = startPhases(fixture.entries())
  const lastReleaseAt = phases.lastIndexOf('release')
  const lastStateAt = phases.lastIndexOf('state')
  assert.ok(lastReleaseAt >= 0 && lastStateAt > lastReleaseAt,
    `the retried cleanup precedes the re-registration: ${JSON.stringify(phases)}`)
  assert.equal(phases.slice(lastReleaseAt).filter(phase => phase === 'session').length, 0,
    'a sessionless target must never dispatch a Session after the withdrawal')
  assert.deepEqual(starts(fixture, 'report-agent').map(entry => stateOf(entry)).at(-1), 'working',
    'the re-registration carries the CURRENT state, not the stale one')
})

test('an event landing while the Session report is in flight still retries it when that child fails', async (t) => {
  // `sessionDelayMs` holds B's child in flight long enough for a real Agent
  // state fact to arrive during that flight, which is the window RFL-007 is
  // about: the event must not be dropped because the Session is already active.
  const fixture = createHerdrCliFixture(t, { sessionDelayMs: 300 })
  const reporter = reporterOf(fixture)
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 1, 'the idle registration')
  reporter.observeSession(directSession(SESSION_A))
  await fixture.waitFor(entries => deliveredSessions(fixture).length === 1, 'Session A delivered')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length
    >= entries.filter(entry => entry.phase === 'start').length, 'the queue settled after A')

  // B is dispatched and FAILS; the state fact arrives while it is in flight.
  fixture.env.HERDR_FAKE_SESSION_EXIT_CODE = '3'
  reporter.observeSession(directSession(SESSION_B))
  await fixture.waitFor(entries => sessionStarts(fixture).length === 2, 'the in-flight Session B')
  reporter.publish({ state: 'working' })
  // The event is remembered; the failed B must be retried WITHOUT a new event.
  await fixture.waitFor(entries => sessionStarts(fixture).length === 3, 'Session B retried from the in-flight event')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length
    >= entries.filter(entry => entry.phase === 'start').length, 'the retry settled')
  assert.deepEqual(deliveredSessions(fixture), [SESSION_A],
    'both attempts failed, so nothing new may be claimed as delivered')

  // Still no additional event: the retry is NOT repeated a second time.
  await settleThroughDispatch(fixture)
  assert.equal(sessionStarts(fixture).length, 3, 'one retry per remembered event, never a loop')

  // A later real event, with the CLI healthy, delivers the current Session.
  fixture.env.HERDR_FAKE_SESSION_EXIT_CODE = ''
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => deliveredSessions(fixture).length === 2, 'Session B delivered')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length
    >= entries.filter(entry => entry.phase === 'start').length, 'the queue settled after the recovery')
  assert.deepEqual(deliveredSessions(fixture), [SESSION_A, SESSION_B])
  assert.deepEqual(fixture.sessions()[2].resumeArgv,
    ['dsh', '--profile', PROFILE, '--session', SESSION_B])
})

test('a quick switch back while the superseded Session is in flight ends on the current Session', async (t) => {
  const fixture = createHerdrCliFixture(t, { sessionDelayMs: 300 })
  const reporter = reporterOf(fixture)
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 1, 'the idle registration')
  reporter.observeSession(directSession(SESSION_A))
  await fixture.waitFor(entries => deliveredSessions(fixture).length === 1, 'Session A delivered')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length
    >= entries.filter(entry => entry.phase === 'start').length, 'the queue settled after A')

  // B starts a long report; A becomes current again BEFORE B settles.
  reporter.observeSession(directSession(SESSION_B))
  await fixture.waitFor(entries => sessionStarts(fixture).length === 2, 'the in-flight Session B')
  reporter.observeSession(directSession(SESSION_A))

  // The stale B cannot win: A must be the LAST delivered Session.
  await fixture.waitFor(entries => deliveredSessions(fixture).at(-1) === SESSION_A
    && deliveredSessions(fixture).length >= 2, 'A re-delivered after the stale B settled')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length
    >= entries.filter(entry => entry.phase === 'start').length, 'the queue settled after the recovery')
  assert.deepEqual(deliveredSessions(fixture), [SESSION_A, SESSION_B, SESSION_A],
    'the quick switch must end on the CURRENT Session, not on the superseded one')
  const lastSessionArgv = fixture.sessions().at(-1)?.resumeArgv
  assert.deepEqual(lastSessionArgv, ['dsh', '--profile', PROFILE, '--session', SESSION_A])
})

test('a Session queued behind a slow state child never wins after a switch back', async (t) => {
  // A slow state child keeps the queue busy, so B is only QUEUED (not in
  // flight) when A becomes current again. 400 ms stays inside the reporter's own
  // 500 ms child bound while leaving the two synchronous observations well
  // inside the child's lifetime.
  const fixture = createHerdrCliFixture(t, { delayMs: 400 })
  const reporter = reporterOf(fixture)
  reporter.publish({ state: 'idle' })
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 1, 'the idle registration')
  reporter.observeSession(directSession(SESSION_A))
  await fixture.waitFor(entries => deliveredSessions(fixture).length === 1, 'Session A delivered')
  await fixture.waitFor(entries => entries.filter(entry => entry.phase === 'end').length
    >= entries.filter(entry => entry.phase === 'start').length, 'the queue settled after A')

  reporter.publish({ state: 'working' })
  await fixture.waitFor(entries => starts(fixture, 'report-agent').length === 2, 'the slow working child')
  reporter.observeSession(directSession(SESSION_B))
  reporter.observeSession(directSession(SESSION_A))
  // The state child is still running, so nothing Session-shaped may have been
  // dispatched: B was queued and A is already the delivered Session.
  assert.deepEqual(fixture.sessions().map(session => session.sessionId), [SESSION_A],
    'the stale queued B must never be dispatched')
  await settleThroughDispatch(fixture, 'the slow state child settled')
  // A stale dispatch WOULD be spawned synchronously in the settle, but its start
  // line is written by a NEW process a little later. The absence is therefore only
  // observable through a bounded window; 150 ms is well above the measured
  // start-to-end latency of these children (~10 ms) and is the only reasoned
  // sleep in this case.
  await delay(150)
  assert.deepEqual(fixture.sessions().map(session => session.sessionId), [SESSION_A],
    'the stale queued B must still not be dispatched once the queue drains')
  assert.deepEqual(deliveredSessions(fixture), [SESSION_A])
  assert.deepEqual(starts(fixture, 'report-agent').map(entry => stateOf(entry)), ['idle', 'working'],
    'the state report is untouched by the stale Session switch')
})
