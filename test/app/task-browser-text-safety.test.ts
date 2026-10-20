/**
 * Task Browser Host-text terminal safety on the REAL production path.
 *
 * A mounted `TuiApp` + `VirtualTerminal` drives the real `createTaskRuntime`
 * owner, the real `openTaskBrowser` overlay (the S → Y Stop confirmation) and
 * the real `/tasks` row projection; only the external Job-observation port is
 * replaced. The assertions read the RAW byte stream the TUI writes to the
 * terminal (`Terminal.write`) — never a `stripTerminalSequences()` screenshot,
 * which would erase the very escape payload under test.
 *
 * The boundary under guard:
 *   authoritative Host Job/Subagent label
 *     → TaskPanelItem → TaskBrowserPanel (list / detail / Stop confirmation)
 *     → TaskRuntime notice → TuiApp.notify → the ONE transient notice line.
 *
 * @module @xmoon76/dsh-pi-tui/task-browser-text-safety.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { TuiApp } from '../../src/tui-app.ts'
import { createTaskRuntime, type TaskRuntime, type TaskSurfaceSource } from '../../src/app/surface/task-runtime.ts'
import type { SessionSubject } from '../../src/app/session/subject.ts'
import type { JobObservationPort, JobStopOutcome } from '../../src/runtime/job-observation-port.ts'
import type { SubagentInterruptOutcome, SubagentInterruptRequest } from '../../src/runtime/subagent-port.ts'
import type { TaskSubagentEntry } from '../../src/runtime/task-read-port.ts'
import type { TaskBrowserJobInput } from '../../src/domain/task/browser.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { displaySeamStub } from '../support/display-seam-stub.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

/** The task's verified hostile fixture: an OSC 52 clipboard write (with a
 *  base64 payload), readable text, and a CSI erase. */
const HOSTILE = '\x1b]52;c;UFdORUQ=\x07echo ok\x1b[2J'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** Assert the RAW terminal stream carries none of the Host's control bytes.
 *  `\x1b[2J` is checked against a benign-label control (see the success case):
 *  a legitimate full-screen clear would otherwise make the guard vacuous. */
function assertNoHostileBytes(stream: string, context: string): void {
  assert.ok(!stream.includes(']52;c;'), `${context}: no Host OSC reaches the terminal stream`)
  assert.ok(!stream.includes('UFdORUQ='), `${context}: no Host clipboard payload reaches the terminal stream`)
  assert.ok(!stream.includes('\x1b[2J'), `${context}: no Host CSI reaches the terminal stream`)
}

class JobObservationDouble implements JobObservationPort {
  readonly stops: string[] = []
  stopOutcome: JobStopOutcome = { kind: 'requested' }
  stopFailure: Error | undefined
  /** Hold `stop` until `releaseStop()` — the late-settlement currentness case. */
  holdStop = false
  private pendingStop: { resolve: (outcome: JobStopOutcome) => void } | undefined

  open(): () => void {
    return () => {}
  }

  async stop(_sessionId: string, jobId: string): Promise<JobStopOutcome> {
    this.stops.push(jobId)
    if (this.stopFailure !== undefined) throw this.stopFailure
    if (this.holdStop) {
      return await new Promise<JobStopOutcome>((resolve) => { this.pendingStop = { resolve } })
    }
    return this.stopOutcome
  }

  releaseStop(outcome: JobStopOutcome): void {
    const pending = this.pendingStop
    this.pendingStop = undefined
    pending?.resolve(outcome)
  }
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly tasks: TaskRuntime
  readonly observation: JobObservationDouble
  /** Every Subagent interruption the runtime dispatched, in order. */
  readonly interrupts: ReadonlyArray<{ parentSessionId: string; childSessionId: string }>
  /** Every notice that reached `TuiApp.notify`, with its level. */
  readonly notices: ReadonlyArray<{ text: string; kind: 'info' | 'error' }>
  /** The RAW terminal output captured from the mounted app. */
  stream(): string
}

interface HarnessOptions {
  readonly jobLabel?: string
  /** When set, a running continuable descendant row joins the browser. */
  readonly subagentLabel?: string
  readonly interrupt?: (request: SubagentInterruptRequest) => Promise<SubagentInterruptOutcome>
}

function startHarness(options: HarnessOptions = {}): Harness {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {})
  app.start()
  startedApps.add(app)

  // Capture the raw byte stream the TUI writes to the terminal. Installed
  // AFTER start() so the initial screen setup is out of scope: only the
  // browser interaction and its notices are asserted.
  const written: string[] = []
  const originalWrite = vt.write.bind(vt)
  vt.write = (data: string): void => { written.push(data); originalWrite(data) }

  const notices: Array<{ text: string; kind: 'info' | 'error' }> = []
  const originalNotify = app.notify
  app.notify = (text: string, kind: 'error' | 'info' = 'info'): void => {
    notices.push({ text, kind })
    originalNotify.call(app, text, kind)
  }

  const observation = new JobObservationDouble()
  const subject = {} as SessionSubject
  const interrupts: Array<{ parentSessionId: string; childSessionId: string }> = []
  const jobs = (): TaskBrowserJobInput[] => [{
    id: 'job-a',
    kind: 'bash',
    label: options.jobLabel ?? 'plain build',
    status: 'running',
    startedAt: 1_000,
  }]
  const descendants: TaskSubagentEntry[] = options.subagentLabel === undefined ? [] : [{
    kind: 'child',
    id: 'child-a',
    label: options.subagentLabel,
    mode: 'continuable',
    activity: 'running',
    hasChildren: false,
    parentId: '',
    depth: 1,
  }]
  const source: TaskSurfaceSource = {
    sessionId: () => 'sess-main',
    captureSubject: () => subject,
    subjectMatches: candidate => candidate === subject,
    enterView: async () => {},
    interruptSubagent: async (parentSessionId, childSessionId) => {
      interrupts.push({ parentSessionId, childSessionId })
      if (options.interrupt === undefined) throw new Error('subagent interrupt is not exercised by this case')
      return options.interrupt({ parentSessionId, childSessionId, mode: 'continuable' })
    },
    rowSelectionDisposition: (row, jobDetail) => row === undefined || row.kind === 'job' ? jobDetail : 'close',
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: status => status,
    jobObservation: observation,
    jobs: { list: jobs, subscribe: () => () => {} },
    taskRead: {
      currentKey: () => 'g1:sess-main',
      currentSessionId: () => 'sess-main',
      readTask: async () => ({ parentSessionId: 'sess-main', parentAvailable: true, descendants, jobs: jobs() }),
      activityOf: () => 'running',
    },
  }
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => displaySeamStub(),
    isCleanedUp: () => false,
    attention: { rows: () => [], reconcile: () => {}, publish: () => {}, reopen: () => false },
  })
  tasks.attachTasks(source, { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  return { vt, app, tasks, observation, interrupts, notices, stream: () => written.join('') }
}

/** Open `/tasks`, select the first row and confirm the S → Y Stop chord. */
async function openBrowserAndStop(harness: Harness): Promise<void> {
  harness.tasks.openTasksBrowser('full')
  await harness.vt.waitForRender()
  harness.vt.sendInput('S')
  await harness.vt.waitForRender()
  harness.vt.sendInput('y')
  await flush()
  await harness.vt.waitForRender()
}

// ── S-02: the real Job Stop notice ─────────────────────────────────────────

test('S-02 a hostile Job label never reaches the terminal through a real Task Browser Stop', async () => {
  const harness = startHarness({ jobLabel: HOSTILE })
  await flush()
  await openBrowserAndStop(harness)

  // The Stop is dispatched exactly ONCE, through the SAME port mutation.
  assert.deepEqual(harness.observation.stops, ['job-a'], 'the Stop dispatches exactly ONE port mutation')
  const stream = harness.stream()
  assertNoHostileBytes(stream, 'requested Stop')
  // The notice is the truthful settlement AND it reaches the terminal with
  // its readable content (the sanitized projection, not the raw label).
  assert.ok(stream.includes('stopping echo ok'),
    'the requested notice is painted with the sanitized label')
  // …while the ONE notice authority still holds the caller's RAW notice text:
  // the display projection never rewrites the notice source.
  assert.deepEqual(harness.notices, [{ text: `stopping ${HOSTILE}`, kind: 'info' }],
    'the notice source keeps the official raw label and its info level')
  harness.app.stop()
})

test('S-02b a hostile Job label never reaches the terminal through a FAILED Stop notice', async () => {
  const harness = startHarness({ jobLabel: HOSTILE })
  await flush()
  harness.observation.stopOutcome = { kind: 'rejected', message: 'the registry refused' }
  await openBrowserAndStop(harness)

  assert.deepEqual(harness.observation.stops, ['job-a'], 'a failed Stop is still dispatched exactly once')
  const stream = harness.stream()
  assertNoHostileBytes(stream, 'rejected Stop')
  assert.ok(stream.includes('could not stop echo ok: the registry refused'),
    'the error notice is painted with the sanitized label and the real reason')
  assert.deepEqual(harness.notices,
    [{ text: `could not stop ${HOSTILE}: the registry refused`, kind: 'error' }],
    'the error level and the raw label are preserved on the notice source')
  harness.app.stop()
})

test('S-02c a hostile Job label never reaches the terminal through a THROWING Stop dispatch', async () => {
  const harness = startHarness({ jobLabel: HOSTILE })
  await flush()
  harness.observation.stopFailure = new Error('kill admission refused')
  await openBrowserAndStop(harness)

  assert.deepEqual(harness.observation.stops, ['job-a'], 'a throwing dispatch is still attempted exactly once')
  const stream = harness.stream()
  assertNoHostileBytes(stream, 'throwing Stop')
  assert.ok(stream.includes('could not stop echo ok: kill admission refused'),
    'the dispatch failure is painted with the sanitized label and the real reason')
  assert.deepEqual(harness.notices,
    [{ text: `could not stop ${HOSTILE}: kill admission refused`, kind: 'error' }],
    'the dispatch failure keeps the raw label and its error level')
  harness.app.stop()
})

test('S-04 a benign label is unchanged, so the hostile-byte guard is not vacuous', async () => {
  const harness = startHarness({ jobLabel: 'plain build' })
  await flush()
  await openBrowserAndStop(harness)
  const stream = harness.stream()
  // The SAME capture pipeline carries no legitimate `\x1b[2J`, which is what
  // makes the CSI assertion on the hostile fixture discriminating.
  assert.ok(!stream.includes('\x1b[2J'), 'a benign Stop emits no full-screen erase')
  assert.ok(stream.includes('stopping plain build'), 'the benign notice is painted verbatim')
  assert.deepEqual(harness.observation.stops, ['job-a'])
  harness.app.stop()
})

// ── S-03: the symmetric Subagent interrupt notices ─────────────────────────

test('S-03 a hostile Subagent label never reaches the terminal through a committed interrupt', async () => {
  const harness = startHarness({ subagentLabel: HOSTILE, interrupt: async () => ({ kind: 'committed' }) })
  await flush()
  await openBrowserAndStop(harness)

  assert.deepEqual([...harness.interrupts], [{ parentSessionId: 'sess-main', childSessionId: 'child-a' }],
    'the interrupt authority still names the durable direct parent and the exact child')
  const stream = harness.stream()
  assertNoHostileBytes(stream, 'committed interrupt')
  assert.ok(stream.includes('stopping echo ok'), 'the committed notice is painted sanitized')
  assert.deepEqual(harness.notices, [{ text: `stopping ${HOSTILE}`, kind: 'info' }],
    'the committed notice keeps the raw child label and its info level')
  harness.app.stop()
})

test('S-03b a hostile Subagent label never reaches the terminal through a rejected interrupt', async () => {
  const harness = startHarness({
    subagentLabel: HOSTILE,
    interrupt: async () => ({ kind: 'rejected', reason: { kind: 'error', message: 'denied' } }),
  })
  await flush()
  await openBrowserAndStop(harness)

  assert.deepEqual([...harness.interrupts], [{ parentSessionId: 'sess-main', childSessionId: 'child-a' }])
  const stream = harness.stream()
  assertNoHostileBytes(stream, 'rejected interrupt')
  assert.ok(stream.includes('could not stop echo ok: denied'),
    'the rejection notice is painted with the sanitized label and the real reason')
  assert.deepEqual(harness.notices, [{ text: `could not stop ${HOSTILE}: denied`, kind: 'error' }])
  harness.app.stop()
})

test('S-03c a hostile Subagent label never reaches the terminal through an indeterminate interrupt', async () => {
  const harness = startHarness({
    subagentLabel: HOSTILE,
    interrupt: async () => ({ kind: 'indeterminate', message: 'carrier went away' }),
  })
  await flush()
  await openBrowserAndStop(harness)

  const stream = harness.stream()
  assertNoHostileBytes(stream, 'indeterminate interrupt')
  assert.ok(stream.includes('could not confirm stopping echo ok'),
    'an unproven settlement is reported as unproven, sanitized')
  assert.deepEqual(harness.notices,
    [{ text: `could not confirm stopping ${HOSTILE} — the session state will decide`, kind: 'error' }],
    'the indeterminate notice keeps its certainty wording, raw label and error level')
  harness.app.stop()
})

test('S-03d a hostile Subagent label never reaches the terminal through a THROWING interrupt dispatch', async () => {
  const harness = startHarness({
    subagentLabel: HOSTILE,
    interrupt: async () => { throw new Error('admission refused') },
  })
  await flush()
  await openBrowserAndStop(harness)

  assert.deepEqual([...harness.interrupts], [{ parentSessionId: 'sess-main', childSessionId: 'child-a' }],
    'a throwing dispatch is still attempted through the exact authority')
  const stream = harness.stream()
  assertNoHostileBytes(stream, 'throwing interrupt')
  assert.ok(stream.includes('could not stop echo ok: admission refused'),
    'the onError notice is painted with the sanitized label and the real reason')
  assert.deepEqual(harness.notices, [{ text: `could not stop ${HOSTILE}: admission refused`, kind: 'error' }],
    'the onError notice keeps the raw label and its error level')
  harness.app.stop()
})

// ── S-04: currentness — a closed browser receives no late notice ────────────

test('S-04 a browser closed before the Stop settles receives no late notice', async () => {
  const harness = startHarness({ jobLabel: HOSTILE })
  await flush()
  harness.observation.holdStop = true
  harness.tasks.openTasksBrowser('full')
  await harness.vt.waitForRender()
  harness.vt.sendInput('S')
  await harness.vt.waitForRender()
  harness.vt.sendInput('y')
  await flush()
  harness.vt.waitForRender()
  assert.deepEqual(harness.observation.stops, ['job-a'], 'the Stop really dispatched')

  // The user leaves the browser while the Stop is still in flight…
  harness.vt.sendInput('\x1b')
  await harness.vt.waitForRender()
  // …then the authoritative settlement lands: the browser token fence must
  // drop it (no notice for a surface the user already left).
  harness.observation.releaseStop({ kind: 'requested' })
  await flush(12)
  await harness.vt.waitForRender()
  assert.deepEqual([...harness.notices], [], 'a retired browser must not notify a late settlement')
  assertNoHostileBytes(harness.stream(), 'late settlement')
  harness.app.stop()
})
