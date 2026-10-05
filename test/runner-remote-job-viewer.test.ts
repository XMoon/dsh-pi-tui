/**
 * M3-5 PR3 L6 qualification (frozen plan §15 L6, §11 J6-J12): the REAL Remote
 * application composition (`createRemoteApplicationRuntime` through the real
 * runner selection seam) driving the REAL `/tasks` Task Center → REAL Job row
 * → REAL Remote selected-Job OutputViewer + Stop over the SAME rc.2 Host/Client
 * graph the M3-4 presentation L6 harness
 * (`test/runner-remote-presentation.test.ts`, imported here — never a second
 * graph) already proves.
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - the ordinary rc.2 Host base services required by Session/Jobs/attachments
 *   (the shared `remote-application-fixture`) plus the whole-log projection
 *   rows the presentation harness mounts
 * - the real `@deepseek-ai/dsh-subagent` Host service, whose plugin
 *   registration is what makes the official `subagentCatalog` Session
 *   projection readable over the wire (the Task read's root projection)
 * - `LocalJobRegistry` + `JobController`: the REAL Host background-Job
 *   registry and its generated `job.list`/`job.follow`/`job.kill` wire rows;
 *   one real background Job is started with a LIVE Agent owner through
 *   `host.ctx.jobs.start(...)` (the `remote-client-runtime` case-H pattern)
 * - the official Client/Gateway path over the real in-process carrier and the
 *   REAL runner composition root (`app/bootstrap.ts`) through the production
 *   selection seam (a pre-selected aggregate)
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - the scripted `StubStreamingLlmAdapter` (the presentation harness default):
 *   the Host emits REAL agent events; no proof below submits a Remote prompt,
 *   so the model endpoint is never exercised
 * - the virtual terminal (UI bytes are observed but are not the subject)
 *
 * DELIBERATELY ABSENT
 * - a public Remote selector
 * - a second Host Jobs/JobController service or a second Client graph
 * - any Direct `ctx.jobs` read/kill on the application path
 *
 * USER-REACHABLE SURFACES EXERCISED: `/tasks` full Task Center, the Job row,
 * the selected-Job OutputViewer (retained-output body + live append + the
 * `tasks.stop` Stop key + Esc back), the Task-Center row Stop (two-step
 * `s` → `y` confirmation), the subagent-kind Job fallback, and the real
 * `/resume` main-Session switch.
 *
 * @module @xmoon76/dsh-pi-tui/runner-remote-job-viewer.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JobId, type JobHandle, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import { RemoteJobObservationPort, type RemoteJobKillResult } from '../src/runtime/remote/job-observation-remote.ts'
import { mountRemotePresentationHost, mountRemoteRunner } from './runner-remote-presentation.test.ts'
import { waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

/** The one fixture preset id. */
const PRESET_ID = 'm3-5-pr3-remote-job-viewer'
/** The resumed main Session the L6 scenario runs in. */
const MAIN_ID = 'm3-5-pr3-main'
/** The replacement main Session the stale-callback control switches to. */
const MAIN_B_ID = 'm3-5-pr3-main-b'
const MAIN_B_DIR = 'b-main-ws'

const JOB_ONE_LABEL = 'm3-5-pr3-build-one'
const JOB_TWO_LABEL = 'm3-5-pr3-build-two'
const SUBAGENT_JOB_LABEL = 'm3-5-pr3-bg-subagent'
const JOB_ONE_INITIAL = 'pr3-one retained line\n'
const JOB_ONE_APPENDED = 'pr3-one live appended line\n'

type Append = (type: string, data: unknown, options?: { surfaceOp?: 'append' }) => void

/** The real Host Session appender (the same primitive the fixture suites use). */
function appenderOf(ctx: Context, sessionId: string): Append {
  const session = ctx.sessions.get(SessionId(sessionId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  return (type, data, options) => session.append(type, data, options)
}

/** Seed one completed durable turn on one real Host Session log. */
function seedTurn(append: Append, turn: number, label: string): void {
  append('turn/start', { turn })
  append('step/start', { turn, step: 1 })
  append('user/message', {
    id: `u-${label}-${turn}`, role: 'user', content: [{ type: 'text', text: `${label} prompt ${turn}` }], source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  append('assistant/message', {
    turn, step: 1,
    message: { id: `a-${label}-${turn}`, role: 'assistant', content: [{ type: 'text', text: `${label} answer ${turn}` }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
    stream: [], usage: { inputTokens: 1, outputTokens: 1 },
  }, { surfaceOp: 'append' })
  append('step/end', { turn, step: 1 })
  append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** The structural faces this suite drives on the mounted TuiApp. */
interface MountedApp {
  setDraft(text: string): void
  getDraft(): string
  submitDraft(): void
  getViewerGeneration(): number
  overlayGraphState(): { handles: number; dependents: number; suspended: number }
  notify(text: string, kind?: 'error' | 'info'): void
  statusStore: {
    snapshot(): {
      view?: { subject?: { kind?: string; id?: string; label?: string; mode?: string; activity?: string } }
      workspace?: { cwd?: string; project?: string }
    }
  }
}

/** The official Client `IJobs` face (the exact object the Remote adapter uses). */
interface ClientJobsFace {
  state: {
    getSnapshot(): {
      readonly rows: Readonly<Record<string, readonly {
        readonly id: string
        readonly kind: string
        readonly label: string
        readonly status: string
        readonly detail?: string
      }[]>>
      readonly observed: Readonly<Record<string, { readonly text: string; readonly streaming: boolean; readonly error?: string } | undefined>>
    }
  }
  watchRows(sessionId: string): () => void
  observe(sessionId: string | undefined, jobId: string): () => void
  kill(sessionId: string, jobId: string): Promise<RemoteJobKillResult>
}

/** The Host `ctx.jobs` registry subset the spies wrap. */
interface HostJobsFace {
  start(spec: {
    kind: string
    label: string
    owner: unknown
    run: (job: JobHandle) => { cancel: () => void; done: Promise<JobOutcome> }
  }): JobId
  read(id: JobId, caller?: unknown): unknown
  kill(id: JobId, caller?: unknown, reason?: string): 'requested' | 'already-finished'
}

/** One started real Host background Job under test control. */
interface StartedJob {
  readonly id: JobId
  handle(): JobHandle
}

interface KillControl {
  mode: 'real' | 'inert' | 'indeterminate' | 'held' | 'reject'
  /** How many times the official `IJobs.kill` was invoked through the port. */
  calls: number
  resolveHeld: (() => void) | undefined
  rejectHeld: ((error: unknown) => void) | undefined
}

interface JobViewerFixture {
  readonly host: Awaited<ReturnType<typeof mountRemotePresentationHost>>
  readonly fixture: Awaited<ReturnType<typeof mountRemoteRunner>>
  readonly app: MountedApp
  readonly jobs: HostJobsFace
  readonly clientJobs: ClientJobsFace
  readonly killControl: KillControl
  /** The transient notices the surface posted (via the wrapped `notify`). */
  readonly notices: string[]
  /** The retained-output text of the Client observation for one job. */
  observedText(jobId: JobId): string
  /** The official Client roster row status for one job, or undefined. */
  rosterStatus(jobId: JobId): string | undefined
  observeAcquires(): number
  observeReleases(): number
  hostReadCalls(): number
  hostKillCalls(): number
  /** The rendered viewport text, ANSI-stripped and joined. */
  view(): string
}

/** Start ONE real Host background Job owned by a live Agent of `owner`. */
function startJob(
  jobs: HostJobsFace,
  options: { readonly owner: string; readonly kind: string; readonly label: string; readonly text?: string },
): StartedJob {
  let handle: JobHandle | undefined
  let settle!: (outcome: JobOutcome) => void
  const done = new Promise<JobOutcome>(resolve => { settle = resolve })
  const id = jobs.start({
    kind: options.kind,
    label: options.label,
    owner: SessionId(options.owner),
    run: (job) => {
      handle = job
      if (options.text !== undefined) job.append(options.text)
      // The producer settles on cancellation, so a killed record always
      // releases its waiters (and the fixture teardown never stalls).
      return { cancel: () => settle({ status: 'killed' }), done }
    },
  })
  assert.ok(handle !== undefined, 'the real job starter must run synchronously')
  const captured = handle
  return { id, handle: () => captured }
}

/**
 * Build the L6 fixture: the real Remote graph (presentation harness) over one
 * resumed main Session carrying a real transcript. No subagent children are
 * created — the Job roster is the subject.
 */
async function mountJobViewerFixture(life: TestLifecycle): Promise<JobViewerFixture> {
  const host = await mountRemotePresentationHost(life, PRESET_ID)
  // The real Host subagent service: its projection registration is the
  // authority that makes the `subagentCatalog` root projection readable, which
  // the PR2 semantic Task read requires even with zero descendants.
  const SubagentRuntime = (await import('@deepseek-ai/dsh-subagent')).default
  await host.ctx.plugin(SubagentRuntime as never, { maxDepth: 3 } as never)

  await host.harness.create(SessionId(MAIN_ID), { provider: 'smoke', model: 'smoke' } as never, { cwd: host.anchorDir })
  seedTurn(appenderOf(host.ctx, MAIN_ID), 1, 'main')

  const fixture = await mountRemoteRunner(life, { presetId: PRESET_ID, resumeSessionId: MAIN_ID, host })
  await waitFor('the main transcript hydrated', () => fixture.vt.getViewport().join('').includes('main answer 1'), 20_000)
  const app = fixture.runnerApp() as unknown as MountedApp
  assert.ok(app !== undefined, 'the production runner must create a TuiApp')

  const jobs = (host.ctx as unknown as { jobs: HostJobsFace }).jobs
  const clientJobs = fixture.aggregate.wire.client.jobs as unknown as ClientJobsFace
  assert.ok(clientJobs !== undefined, 'the official Client Jobs service must be composed')

  // ── Light probes over the official seam (never a second graph). The Remote
  // adapter holds the SAME `IJobs` object the aggregate exposes.
  let observeAcquires = 0
  let observeReleases = 0
  const realObserve = clientJobs.observe
  clientJobs.observe = function (this: unknown, sessionId: string | undefined, jobId: string): () => void {
    observeAcquires += 1
    const release = realObserve.call(this, sessionId, jobId)
    let released = false
    return () => {
      if (released) return
      released = true
      observeReleases += 1
      release()
    }
  }

  const killControl: KillControl = { mode: 'real', calls: 0, resolveHeld: undefined, rejectHeld: undefined }
  const realKill = clientJobs.kill
  clientJobs.kill = function (this: unknown, sessionId: string, jobId: string): Promise<RemoteJobKillResult> {
    killControl.calls += 1
    if (killControl.mode === 'inert') return Promise.resolve({ ok: true, value: { outcome: 'requested' } })
    if (killControl.mode === 'indeterminate') {
      return Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'injected indeterminate kill' } })
    }
    if (killControl.mode === 'reject') return Promise.reject(new Error('injected carrier rejection'))
    if (killControl.mode === 'held') {
      return new Promise<RemoteJobKillResult>((resolve, reject) => {
        killControl.resolveHeld = () => resolve({ ok: true, value: { outcome: 'requested' } })
        killControl.rejectHeld = (error: unknown) => reject(error)
      })
    }
    return realKill.call(this, sessionId, jobId)
  }

  // The model-consuming / Direct-only Host accessors: a Remote application
  // path must never call `ctx.jobs.read` (it would consume the model
  // `job_output` cursor) or add a second direct `kill` beside the wire one.
  let hostReadCalls = 0
  let hostKillCalls = 0
  const realHostRead = jobs.read
  jobs.read = function (this: unknown, ...args: Parameters<HostJobsFace['read']>): unknown {
    hostReadCalls += 1
    return realHostRead.apply(this, args)
  }
  const realHostKill = jobs.kill
  jobs.kill = function (this: unknown, ...args: Parameters<HostJobsFace['kill']>): 'requested' | 'already-finished' {
    hostKillCalls += 1
    return realHostKill.apply(this, args)
  }

  const notices: string[] = []
  const realNotify = app.notify.bind(app)
  app.notify = (text: string, kind?: 'error' | 'info'): void => {
    notices.push(text)
    realNotify(text, kind)
  }

  const view = (): string => fixture.vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/gu, '')).join('\n')
  const rosterRow = (jobId: JobId): { status: string } | undefined =>
    (clientJobs.state.getSnapshot().rows[MAIN_ID] ?? []).find(row => row.id === String(jobId))
  return {
    host,
    fixture,
    app,
    jobs,
    clientJobs,
    killControl,
    notices,
    observedText: (jobId) => clientJobs.state.getSnapshot().observed[String(jobId)]?.text ?? '',
    rosterStatus: (jobId) => rosterRow(jobId)?.status,
    observeAcquires: () => observeAcquires,
    observeReleases: () => observeReleases,
    hostReadCalls: () => hostReadCalls,
    hostKillCalls: () => hostKillCalls,
    view,
  }
}

/** Submit one line through the REAL mounted surface (the production gesture). */
function submit(app: MountedApp, line: string): void {
  app.setDraft(line)
  app.submitDraft()
}

/** The `tasks.stop` key as the mounted app advertises it (never hard-coded). */
function stopKey(app: MountedApp): string {
  const keybindings = (app as unknown as { keybindings: { keyHint(id: string): string } }).keybindings
  const key = keybindings.keyHint('tasks.stop')
  assert.ok(key !== '', 'the app must advertise a tasks.stop key')
  return key
}

/** Walk the REAL Full Task Center selection onto one row label (no shortcut). */
async function selectTaskRow(fx: JobViewerFixture, label: string): Promise<void> {
  await waitFor(`the Task Center rendered ${label}`, () => fx.view().includes(label), 20_000)
  for (let step = 0; step <= 10; step += 1) {
    const selected = fx.view().split('\n').some(line => line.includes('→') && line.includes(label))
    if (selected) return
    fx.fixture.vt.sendInput('\x1b[B')
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  throw new Error(`the Task Center never selected ${label}:\n${fx.view()}`)
}

/** Open one Job row's detail through the real Enter panel action. */
async function openJobRow(fx: JobViewerFixture, label: string): Promise<void> {
  await selectTaskRow(fx, label)
  fx.fixture.vt.sendInput('\r')
}

test('L6 §15 steps 1-8 + negatives (c)/no-retry/no-ctx.jobs.read: the REAL Job viewer observes the Remote stream, updates live without consuming `job_output`, and its Stop converges through the official roster', async (t) => {
  const life = testLifecycle(t)
  const fx = await mountJobViewerFixture(life)
  const { app, view } = fx

  // ── §15 step 1-2: the real Remote composition + the resumed main Session.
  assert.equal(fx.fixture.override.selected.kind, 'remote', '§15.1 the selected core must be the Remote aggregate')
  assert.equal(fx.fixture.override.selected.backend.kind, 'remote')
  assert.equal(
    fx.fixture.aggregate.backendRuntime.semantics.jobObservation instanceof RemoteJobObservationPort,
    true,
    '§15.1 the ONE selected-Job observation/Stop mutation must be the Remote wire adapter, never the Direct `ctx.jobs` adapter',
  )
  assert.equal(app.statusStore.snapshot().view?.subject?.kind, 'main', '§15.2 the resumed main Session owns the surface')

  // ── §15 step 3: ONE real Host background Job owned by a live Agent of the
  // resumed Session, visible in the Session's Job roster.
  const job = startJob(fx.jobs, { owner: MAIN_ID, kind: 'bash', label: JOB_ONE_LABEL, text: JOB_ONE_INITIAL })

  // ── §15 step 4: `/tasks` through the REAL TUI command, then locate the Job row.
  submit(app, '/tasks')
  await selectTaskRow(fx, JOB_ONE_LABEL)
  await waitFor('the official Client roster carries the started job as running', () =>
    fx.rosterStatus(job.id) === 'running', 20_000)
  const browserView = view()
  assert.match(browserView, /bash · m3-5-pr3-build-one/u, `the Job row must render in the Task Center:\n${browserView}`)

  // ── §15 step 5: Enter opens the REAL selected-Job OutputViewer; the body is
  // the Remote observation's retained output (handles 2 = browser + detail).
  fx.fixture.vt.sendInput('\r')
  await waitFor('the Job detail viewer opened', () => app.overlayGraphState().handles === 2, 10_000)
  assert.equal(fx.observeAcquires(), 1,
    'the viewer must acquire its one observer through the official Client `IJobs.observe` (never a Direct `jobController.follow`)')
  await waitFor('the viewer body shows the retained output from the Remote observation', () =>
    view().includes(JOB_ONE_INITIAL.trim()), 20_000)
  assert.match(view(), /retained output preview/u, `the Remote observation body must render:\n${view()}`)
  const readCallsBeforeAppend = fx.hostReadCalls()

  // ── §15 step 6: append MORE output; the viewer body grows from the live
  // observation with NO polling and NO model `job_output` consumption.
  job.handle().append(JOB_ONE_APPENDED)
  await waitFor('the appended output reached the viewer body without a registry read', () =>
    view().includes(JOB_ONE_APPENDED.trim()), 20_000)
  // §15 step 9: a live PROGRESS change converges through the same observation.
  job.handle().updateProgress('3/10 compiling')
  await waitFor('the live progress line converged into the viewer body', () =>
    view().includes('progress: 3/10 compiling'), 20_000)
  assert.equal(fx.observedText(job.id).includes(JOB_ONE_APPENDED.trim()), true,
    'the growth must come through the official observation, not the opening row')
  assert.equal(fx.hostReadCalls(), readCallsBeforeAppend,
    'the viewer path must never consume model `job_output` (`ctx.jobs.read`)')
  assert.equal(fx.hostReadCalls(), 0, 'no `ctx.jobs.read` may run on the Remote application path')

  // ── §15 step 7: the viewer advertises the stop hint and the REAL Stop key
  // dispatches through the semantic port.
  const key = stopKey(app)
  assert.match(view(), new RegExp(`${key} stop · Esc back`, 'u'),
    `the viewer must advertise the app's tasks.stop hint before Stop:\n${view()}`)

  // ── Negative control (c): a PROVEN `requested` admission that never reaches
  // the Host (the settled path is injected as requested) must still not be
  // assigned to the local roster/viewer optimistically — the official status
  // is the only body/row authority.
  fx.killControl.mode = 'inert'
  fx.fixture.vt.sendInput(key)
  await waitFor('the requested settlement notice posted', () =>
    fx.notices.some(message => message.includes(`stopping ${JOB_ONE_LABEL}`)), 10_000)
  assert.equal(fx.hostKillCalls(), 0, 'the inert requested kill must not reach the Host')
  assert.equal(fx.rosterStatus(job.id), 'running',
    'a requested admission must not optimistically rewrite the official roster')
  assert.match(view(), /running/u, `no optimistic local status may replace the official running fact:\n${view()}`)
  assert.match(view(), new RegExp(`${key} stop · Esc back`, 'u'),
    'canStop must follow the latest OBSERVED status, not the local request')

  // ── Negative control: an INDETERMINATE kill is never auto-retried and never
  // rewritten into a local optimistic status; the viewer keeps the official
  // running fact and stays stop-capable until an authoritative convergence.
  fx.killControl.mode = 'indeterminate'
  const killCallsBefore = fx.killControl.calls
  fx.fixture.vt.sendInput(key)
  await waitFor('the indeterminate settlement notice posted', () =>
    fx.notices.some(message => message.includes('could not confirm stopping') && message.includes(JOB_ONE_LABEL)), 10_000)
  assert.equal(fx.killControl.calls - killCallsBefore, 1,
    'an indeterminate kill must dispatch exactly once — never an automatic retry')
  assert.equal(fx.hostKillCalls(), 0,
    'the injected inert/indeterminate probes must not reach the Host registry at all')
  assert.equal(fx.rosterStatus(job.id), 'running',
    'the injected indeterminate kill must not change the official roster')
  assert.match(view(), /running/u, `no optimistic local status may replace the official running fact:\n${view()}`)
  assert.match(view(), new RegExp(`${key} stop · Esc back`, 'u'),
    'canStop must stay advertised while the latest OBSERVED status is active')

  // ── §15 step 8: the REAL Stop converges through the official roster/follow.
  fx.killControl.mode = 'real'
  fx.fixture.vt.sendInput(key)
  await waitFor('the official roster converged to the terminal status', () =>
    fx.rosterStatus(job.id) === 'killed', 20_000)
  await waitFor('the viewer rendered the terminal status', () => view().includes('killed'), 20_000)
  await waitFor('the viewer Stop capability disappeared after settlement', () =>
    !new RegExp(`${key} stop`, 'u').test(view()), 10_000)
  await waitFor('the observation stream settled', () =>
    fx.clientJobs.state.getSnapshot().observed[String(job.id)]?.streaming === false, 20_000)
  await waitFor('the settled body rendered its detail and dropped the live progress', () =>
    view().includes('killed') && view().includes('detail: cancelled by the user')
    && !view().includes('progress: 3/10 compiling'), 20_000)
  assert.match(view(), /killed/u, `the terminal status must render in the viewer:\n${view()}`)
  assert.match(view(), /detail: cancelled by the user/u,
    `the official settlement detail must converge into the viewer body:\n${view()}`)
  assert.equal(view().includes('progress: 3/10 compiling'), false,
    'the settlement must clear the live progress line')
  assert.equal(fx.rosterStatus(job.id), 'killed', 'the Job\'s official roster status must be terminal')
  assert.equal(fx.hostKillCalls(), 1,
    'exactly ONE real Host kill admission may run: the wire stop, never an added direct `ctx.jobs` call')
  assert.equal(fx.notices.some(message => message.includes(`stopping ${JOB_ONE_LABEL}`)), true,
    'the requested settlement must notify truthfully')

  // ── §15 step 9: Esc returns to the SAME Task Center with its state preserved.
  fx.fixture.vt.sendInput('\x1b')
  await waitFor('Esc closed only the Job detail', () => app.overlayGraphState().handles === 1, 10_000)
  // The overlay graph commits synchronously; wait for the repaint that reveals
  // the restored browser (the viewer body owns the old frame until then).
  await waitFor('the restored browser frame painted', () => !view().includes('retained output preview'), 10_000)
  const restored = view()
  assert.match(restored, /bash · m3-5-pr3-build-one/u, `the parent browser must be preserved:\n${restored}`)
  assert.match(restored, /killed/u, `the restored browser row must show the converged status:\n${restored}`)
})

test('L6 §15 step 10 + 11(b): a SECOND real Job stops through the Task-Center row confirmation (the SAME semantic operation) and the Job-detail observer is released and re-acquired exactly once', async (t) => {
  const life = testLifecycle(t)
  const fx = await mountJobViewerFixture(life)
  const { app, view } = fx
  const key = stopKey(app)

  // Two real, independently owned Jobs: the row-stop target and a surviving control.
  const control = startJob(fx.jobs, { owner: MAIN_ID, kind: 'bash', label: JOB_ONE_LABEL, text: JOB_ONE_INITIAL })
  const target = startJob(fx.jobs, { owner: MAIN_ID, kind: 'bash', label: JOB_TWO_LABEL, text: 'pr3-two retained line\n' })
  submit(app, '/tasks')
  await waitFor('both Job rows rendered', () =>
    view().includes(JOB_ONE_LABEL) && view().includes(JOB_TWO_LABEL), 20_000)
  await waitFor('both Jobs are officially running', () =>
    fx.rosterStatus(control.id) === 'running' && fx.rosterStatus(target.id) === 'running', 20_000)

  // ── §15 step 10: select the SECOND Job row and stop it through the REAL
  // two-step row confirmation (`tasks.stop` then `Y`).
  await selectTaskRow(fx, JOB_TWO_LABEL)
  const killCallsBefore = fx.killControl.calls
  const hostKillsBefore = fx.hostKillCalls()
  fx.fixture.vt.sendInput(key)
  // The REAL two-step confirmation affordance: the panel renders its
  // `Y confirm stop · Esc cancel` chord hint and latches the pending stop.
  await waitFor('the row stop confirmation rendered', () =>
    /Y confirm stop · Esc cancel/u.test(view()), 10_000)
  fx.fixture.vt.sendInput('y')
  await waitFor('the row-confirmed Job converged to the terminal status', () =>
    fx.rosterStatus(target.id) === 'killed', 20_000)
  // The SAME semantic operation: exactly one `IJobs.kill` through the port and
  // exactly one Host admission beside it — never the Direct registry directly.
  assert.equal(fx.killControl.calls - killCallsBefore, 1,
    'the row confirmation must dispatch the ONE semantic stop exactly once')
  assert.equal(fx.hostKillCalls() - hostKillsBefore, 1,
    'exactly one Host kill admission must serve the row stop')
  assert.equal(fx.rosterStatus(control.id), 'running', 'the other Job must be untouched by the row stop')
  await waitFor('the Task-Center row rendered the converged status', () => view().includes('killed'), 10_000)

  // ── Negative control 11(b): opening the detail acquires the observer, Esc
  // releases it, and returning to `/tasks` NEVER acquires a second observer.
  // A settled row is still openable (the terminal detail is readable).
  const acquiresBeforeDetail = fx.observeAcquires()
  await openJobRow(fx, JOB_TWO_LABEL)
  await waitFor('the second Job detail opened', () => app.overlayGraphState().handles === 2, 10_000)
  await waitFor('the settled detail renders its terminal observation', () =>
    view().includes('killed') && view().includes('pr3-two retained line'), 20_000)
  assert.equal(fx.observeAcquires(), acquiresBeforeDetail + 1,
    'one Job-detail open must acquire exactly one selected-Job observer')
  fx.fixture.vt.sendInput('\x1b')
  await waitFor('Esc closed the second Job detail', () => app.overlayGraphState().handles === 1, 10_000)
  await waitFor('closing the detail released its observer', () =>
    fx.observeReleases() === acquiresBeforeDetail + 1, 10_000)

  const acquiresAtClose = fx.observeAcquires()
  fx.fixture.vt.sendInput('\x1b')
  await waitFor('the Task Center closed', () => app.overlayGraphState().handles === 0, 10_000)
  submit(app, '/tasks')
  await waitFor('the Task Center re-opened', () => app.overlayGraphState().handles === 1, 10_000)
  await waitFor('the re-opened Task Center rendered the rows', () => view().includes(JOB_TWO_LABEL), 20_000)
  assert.equal(fx.observeAcquires(), acquiresAtClose,
    'returning to /tasks must NOT create a second selected-Job observer')
  // Discriminating witness: re-opening the detail DOES acquire again, so the
  // zero-growth assertion above is not vacuous.
  await openJobRow(fx, JOB_TWO_LABEL)
  await waitFor('the detail re-opened as a non-vacuous witness', () => app.overlayGraphState().handles === 2, 10_000)
  assert.equal(fx.observeAcquires(), acquiresAtClose + 1,
    'the observer counter must move on a real Job-detail open')
  assert.equal(fx.observeReleases(), fx.observeAcquires() - 1,
    'every observer except the currently mounted one must have been released')
})

// ─────────────────────────────────────────────────────────────────────────────
// M3-6 PR2 §14.6: the OPEN selected-Job viewer recovers in place across a
// normal Connection reconnect — the same Job stays mounted, the B-side
// authoritative output reaches the SAME viewer, no duplicate observer/viewer is
// created, and a Stop issued AFTER B reaches the official `IJobs.kill` exactly
// once (the write-settlement negative: a Stop settled BEFORE the reconnect is
// never replayed).
// ─────────────────────────────────────────────────────────────────────────────

test('L6 M3-6 PR2 §14.6: the OPEN Job viewer recovers after reconnect — same detail, B output converges, one observer, post-B Stop kills exactly once, no replay', async (t) => {
  const life = testLifecycle(t)
  const fx = await mountJobViewerFixture(life)
  const { app, view } = fx
  const key = stopKey(app)

  // One real running Job and one REAL write settled BEFORE the reconnect
  // (the write-settlement negative control: an official `IJobs.kill` whose
  // proven settlement must never be replayed by the reconnect).
  const settledJob = startJob(fx.jobs, { owner: MAIN_ID, kind: 'bash', label: JOB_ONE_LABEL, text: JOB_ONE_INITIAL })
  const liveJob = startJob(fx.jobs, { owner: MAIN_ID, kind: 'bash', label: JOB_TWO_LABEL, text: 'pr3-two retained line\n' })
  await waitFor('both Jobs are officially running', () =>
    fx.rosterStatus(settledJob.id) === 'running' && fx.rosterStatus(liveJob.id) === 'running', 20_000)
  const settledKillsBefore = fx.killControl.calls
  fx.killControl.mode = 'real'
  // The pre-reconnect Stop: the official Client write the surface's Stop
  // key would dispatch (the same `IJobs.kill` the mounted Stop uses).
  const settledOutcome = await fx.clientJobs.kill(MAIN_ID, String(settledJob.id))
  assert.equal(settledOutcome.ok, true, 'the pre-reconnect Stop settled with a proven outcome')
  await waitFor('the pre-reconnect stop converged', () =>
    fx.rosterStatus(settledJob.id) === 'killed', 20_000)
  const preReconnectKills = fx.killControl.calls - settledKillsBefore
  assert.equal(preReconnectKills, 1, 'the pre-reconnect Stop dispatched exactly once')

  // ── Open the SECOND Job's detail (the surface that must recover).
  submit(app, '/tasks')
  await openJobRow(fx, JOB_TWO_LABEL)
  await waitFor('the live Job detail opened', () => app.overlayGraphState().handles === 2, 10_000)
  await waitFor('the pre-reconnect retained output rendered', () =>
    view().includes('pr3-two retained line'), 20_000)
  const acquiresBeforeReconnect = fx.observeAcquires()

  // ── The OFFICIAL reconnect, with the Job truth advancing while the old
  // generation is gone (the appended output exists only for generation B).
  const connection = fx.fixture.aggregate.wire.client.connection as unknown as {
    generation: { getSnapshot(): { readonly id: number } | undefined }
    reconnect(): void
  }
  const generationBefore = connection.generation.getSnapshot()?.id
  connection.reconnect()
  liveJob.handle().append('pr3-two post-reconnect line\n')
  liveJob.handle().updateProgress('7/10 linking')
  await waitFor('a NEW DEFINED Connection generation is established', () => {
    const current = connection.generation.getSnapshot()?.id
    return current !== undefined && current !== generationBefore
  }, 20_000)

  // The SAME Job detail remains mounted and the B-side authoritative
  // observation reaches the SAME viewer.
  await waitFor('the post-reconnect output reached the same viewer', () =>
    view().includes('pr3-two post-reconnect line'), 20_000)
  await waitFor('the post-reconnect progress converged', () =>
    view().includes('progress: 7/10 linking'), 20_000)
  assert.equal(app.overlayGraphState().handles, 2,
    'the reconnect neither closed nor duplicated the Job detail')
  assert.equal(fx.observeAcquires(), acquiresBeforeReconnect,
    'the reconnect created NO duplicate observer')

  // The roster and detail converge after B (the settled Job stays terminal,
  // the live Job stays running through the same Client model).
  await waitFor('the roster re-converged after B', () =>
    fx.rosterStatus(settledJob.id) === 'killed' && fx.rosterStatus(liveJob.id) === 'running', 20_000)

  // ── A Stop issued AFTER B reaches the official `IJobs.kill` exactly once.
  const killCallsBeforePostB = fx.killControl.calls
  const hostKillsBeforePostB = fx.hostKillCalls()
  fx.fixture.vt.sendInput(key)
  await waitFor('the post-B Stop converged the live Job', () =>
    fx.rosterStatus(liveJob.id) === 'killed', 20_000)
  await waitFor('the viewer rendered the terminal status', () => view().includes('killed'), 20_000)
  assert.equal(fx.killControl.calls - killCallsBeforePostB, 1,
    'the post-B Stop dispatched the official kill EXACTLY once')
  assert.equal(fx.hostKillCalls() - hostKillsBeforePostB, 1,
    'exactly one Host kill admission served the post-B Stop')
  // The write-settlement negative control: the reconnect NEVER replayed the
  // pre-reconnect Stop — the total kill count grows by exactly the one
  // post-B dispatch above.
  assert.equal(fx.killControl.calls, killCallsBeforePostB + 1,
    'no pre-reconnect settlement was replayed across the reconnect')
})

test('L6 §15 negative control 11(a): a `kind:subagent` Job with NO stable child id stays in the Job detail, never a guessed transcript', async (t) => {
  const life = testLifecycle(t)
  const fx = await mountJobViewerFixture(life)
  const { app, view } = fx
  const subagentJob = startJob(fx.jobs, {
    owner: MAIN_ID, kind: 'subagent', label: SUBAGENT_JOB_LABEL, text: 'pr3-subagent retained line\n',
  })
  submit(app, '/tasks')
  // The panel's job label for a subagent-`kind` row carries the one-shot suffix.
  await selectTaskRow(fx, SUBAGENT_JOB_LABEL)
  await waitFor('the subagent Job rendered as a job row', () =>
    new RegExp(`subagent job · ${SUBAGENT_JOB_LABEL} · one-shot`, 'u').test(view()), 20_000)
  const generationBefore = app.getViewerGeneration()

  fx.fixture.vt.sendInput('\r')
  // The row has NO `childSessionId` on rc.2, so `subagentJobTranscriptId`
  // resolves undefined and the row must fall back to the Job detail — a child
  // OVERLAY (handles 2), not a replacing transcript (handles 0/1).
  await waitFor('the subagent Job opened as a detail overlay', () => app.overlayGraphState().handles === 2, 10_000)
  await waitFor('the subagent Job detail rendered its observed retained output', () =>
    view().includes('pr3-subagent retained line'), 20_000)
  const detail = view()
  assert.match(detail, new RegExp(`subagent ${String(subagentJob.id)} · ${SUBAGENT_JOB_LABEL}`, 'u'),
    `the detail title must name the Job, never a guessed child:\n${detail}`)
  // A guessed transcript would have replaced the surface and committed a child
  // subject; the main subject must stay untouched.
  assert.equal(app.statusStore.snapshot().view?.subject?.kind, 'main',
    'the subagent Job detail must not re-point the display subject to a guessed child')
  assert.equal(app.getViewerGeneration(), generationBefore,
    'a Job detail is an overlay, never a viewer-generation commit')

  // The documented fallback text is reachable only before the first observed
  // snapshot; the live observation already owns the body, so assert the
  // fallback source directly through the SAME composition (never a fabricated
  // child id): the row carries no `childSessionId`.
  const row = (fx.clientJobs.state.getSnapshot().rows[MAIN_ID] ?? []).find(candidate => candidate.id === String(subagentJob.id))
  assert.ok(row !== undefined, 'the official roster must carry the subagent Job')
  assert.equal('childSessionId' in row, false,
    'the rc.2 JobView carries no stable child id — the detail fallback is the only truthful path')
  fx.fixture.vt.sendInput('\x1b')
  await waitFor('the subagent Job detail closed', () => app.overlayGraphState().handles === 1, 10_000)
})

test('L6 §15 step 12: a main-Session switch with a Stop in flight drops the stale settlement and releases the observer without mutating the replacement surface', async (t) => {
  const life = testLifecycle(t)
  const fx = await mountJobViewerFixture(life)
  const { host, app, view } = fx

  // The replacement main Session (its own workspace + transcript).
  const bCwd = join(host.anchorDir, MAIN_B_DIR)
  mkdirSync(bCwd, { recursive: true })
  await host.harness.create(SessionId(MAIN_B_ID), { provider: 'smoke', model: 'smoke' } as never, { cwd: bCwd })
  seedTurn(appenderOf(host.ctx, MAIN_B_ID), 1, 'mainb')

  const job = startJob(fx.jobs, { owner: MAIN_ID, kind: 'bash', label: JOB_ONE_LABEL, text: JOB_ONE_INITIAL })
  submit(app, '/tasks')
  await openJobRow(fx, JOB_ONE_LABEL)
  await waitFor('the Job detail viewer opened', () => app.overlayGraphState().handles === 2, 10_000)
  await waitFor('the observation body arrived', () => view().includes(JOB_ONE_INITIAL.trim()), 20_000)
  const key = stopKey(app)

  // Dispatch Stop and HOLD its settlement in flight (the wrapped official
  // `IJobs.kill` returns a promise the test controls).
  fx.killControl.mode = 'held'
  fx.fixture.vt.sendInput(key)
  await waitFor('the Stop is dispatched and its settlement is in flight', () =>
    fx.killControl.resolveHeld !== undefined, 10_000)
  const noticesBefore = fx.notices.length

  // Switch the viewed main Session while the observation stream is open and the
  // Stop settlement is still in flight.
  submit(app, `/resume ${MAIN_B_ID}`)
  await waitFor('the replacement main session hydrated', () => view().includes('mainb answer 1'), 20_000)
  assert.equal(app.statusStore.snapshot().view?.subject?.kind, 'main',
    'the replacement surface must be the new main Session')
  assert.equal(app.statusStore.snapshot().workspace?.project, MAIN_B_DIR,
    'the replacement workspace must be the new main Session cwd')
  await waitFor('the switched-out Job/Browser stack was torn down', () =>
    app.overlayGraphState().handles === 0, 10_000)
  const replacement = view()
  assert.equal(replacement.includes(JOB_ONE_LABEL), false,
    `the superseded Job row must not survive the switch:\n${replacement}`)
  assert.equal(replacement.includes(JOB_ONE_INITIAL.trim()), false,
    `the superseded Job output must not survive the switch:\n${replacement}`)

  // Release the held settlement: a stale stop result must dispatch NO notice.
  fx.killControl.resolveHeld?.()
  await new Promise(resolve => setTimeout(resolve, 400))
  const staleNotices = fx.notices.slice(noticesBefore).filter(message => message.includes(JOB_ONE_LABEL))
  assert.deepEqual(staleNotices, [],
    'a stop settlement resolving after the session switch must not notify the replacement surface')

  // A late observed snapshot (appended after the switch) must not repaint either.
  job.handle().append(JOB_ONE_APPENDED)
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(view().includes(JOB_ONE_APPENDED.trim()), false,
    'a late observed snapshot from the retired session must not paint the replacement surface')
  assert.equal(app.statusStore.snapshot().workspace?.project, MAIN_B_DIR,
    'the replacement workspace must remain the new main Session')
  await waitFor('the switch released the selected-Job observer', () =>
    fx.observeReleases() === fx.observeAcquires(), 10_000)
})

test('L6 §15 step 12 (teardown variant): disposing the surface with a Stop in flight drops the stale settlement and releases the observer', async (t) => {
  const life = testLifecycle(t)
  const fx = await mountJobViewerFixture(life)
  const { app, view } = fx
  const job = startJob(fx.jobs, { owner: MAIN_ID, kind: 'bash', label: JOB_ONE_LABEL, text: JOB_ONE_INITIAL })
  submit(app, '/tasks')
  await openJobRow(fx, JOB_ONE_LABEL)
  await waitFor('the Job detail viewer opened', () => app.overlayGraphState().handles === 2, 10_000)
  await waitFor('the observation body arrived', () => view().includes(JOB_ONE_INITIAL.trim()), 20_000)

  fx.killControl.mode = 'held'
  fx.fixture.vt.sendInput(stopKey(app))
  await waitFor('the Stop is dispatched and its settlement is in flight', () =>
    fx.killControl.resolveHeld !== undefined, 10_000)
  const noticesBefore = fx.notices.length

  await fx.fixture.dispose()
  fx.killControl.resolveHeld?.()
  await new Promise(resolve => setTimeout(resolve, 400))
  const staleNotices = fx.notices.slice(noticesBefore).filter(message => message.includes(JOB_ONE_LABEL))
  assert.deepEqual(staleNotices, [],
    'a stop settlement resolving after surface disposal must not notify the disposed surface')
  assert.equal(fx.observeReleases(), fx.observeAcquires(),
    'surface disposal must release the mounted selected-Job observer')
})

test('L6 §14/J12: a same-Session Job A -> Job B viewer replacement (with a browser close/reopen) drops A\'s stale Stop SUCCESS settlement and keeps the current viewer\'s Stop working', async (t) => {
  const life = testLifecycle(t)
  const fx = await mountJobViewerFixture(life)
  const { app, view } = fx
  const jobA = startJob(fx.jobs, { owner: MAIN_ID, kind: 'bash', label: JOB_ONE_LABEL, text: 'pr3-a retained line\n' })
  const jobB = startJob(fx.jobs, { owner: MAIN_ID, kind: 'bash', label: JOB_TWO_LABEL, text: 'pr3-b retained line\n' })
  submit(app, '/tasks')
  await openJobRow(fx, JOB_ONE_LABEL)
  await waitFor('the A viewer opened', () => app.overlayGraphState().handles === 2, 10_000)
  await waitFor('the A body arrived', () => view().includes('pr3-a retained line'), 20_000)
  const key = stopKey(app)

  // Dispatch A's Stop and HOLD its settlement in flight.
  fx.killControl.mode = 'held'
  fx.fixture.vt.sendInput(key)
  await waitFor('A Stop is in flight', () => fx.killControl.resolveHeld !== undefined, 10_000)
  const noticesBefore = fx.notices.length
  const acquiresBefore = fx.observeAcquires()

  // Close A, close the browser, reopen /tasks and mount Job B — all in the
  // SAME main Session, so the ownership subject NEVER changes and only the
  // viewer-instance fence can drop A's late settlement.
  fx.fixture.vt.sendInput('\x1b')
  await waitFor('the A viewer closed', () => app.overlayGraphState().handles === 1, 10_000)
  fx.fixture.vt.sendInput('\x1b')
  await waitFor('the browser closed', () => app.overlayGraphState().handles === 0, 10_000)
  submit(app, '/tasks')
  await waitFor('the browser re-opened', () => app.overlayGraphState().handles === 1, 10_000)
  await openJobRow(fx, JOB_TWO_LABEL)
  await waitFor('the B viewer opened', () => app.overlayGraphState().handles === 2, 10_000)
  await waitFor('the B body arrived', () => view().includes('pr3-b retained line'), 20_000)
  assert.equal(app.statusStore.snapshot().view?.subject?.kind, 'main',
    'the same main Session owns the replacement viewer')
  assert.equal(fx.observeAcquires(), acquiresBefore + 1,
    'the replacement viewer acquires exactly one selected-Job observer')

  // Release A's settlement: it must not notify or paint the replacement viewer.
  fx.killControl.resolveHeld?.()
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.deepEqual(
    fx.notices.slice(noticesBefore).filter(message => message.includes(JOB_ONE_LABEL)),
    [],
    'a Stop settlement for the CLOSED viewer A must not notify the replacement surface',
  )
  assert.match(view(), /pr3-b retained line/, 'the replacement viewer body must be unchanged')
  assert.equal(view().includes('pr3-a retained line'), false, 'A output must not paint the replacement viewer')

  // Positive control: the CURRENT viewer's Stop still notifies and converges.
  fx.killControl.mode = 'real'
  fx.fixture.vt.sendInput(key)
  await waitFor('the current viewer B converged', () => fx.rosterStatus(jobB.id) === 'killed', 20_000)
  assert.equal(
    fx.notices.slice(noticesBefore).some(message => message.includes(`stopping ${JOB_TWO_LABEL}`)),
    true,
    'the current viewer settlement must still notify — the instance fence is not over-broad',
  )
  assert.equal(fx.rosterStatus(jobA.id), 'running', 'the retired A Job must be untouched')
})

test('L6 §14/J12: a same-Session A -> B replacement drops A\'s stale Stop ERROR settlement, while the current viewer\'s stop ERROR still notifies', async (t) => {
  const life = testLifecycle(t)
  const fx = await mountJobViewerFixture(life)
  const { app, view } = fx
  startJob(fx.jobs, { owner: MAIN_ID, kind: 'bash', label: JOB_ONE_LABEL, text: 'pr3-a retained line\n' })
  startJob(fx.jobs, { owner: MAIN_ID, kind: 'bash', label: JOB_TWO_LABEL, text: 'pr3-b retained line\n' })
  submit(app, '/tasks')
  await openJobRow(fx, JOB_ONE_LABEL)
  await waitFor('the A viewer opened', () => app.overlayGraphState().handles === 2, 10_000)
  await waitFor('the A body arrived', () => view().includes('pr3-a retained line'), 20_000)
  const key = stopKey(app)

  fx.killControl.mode = 'held'
  fx.fixture.vt.sendInput(key)
  await waitFor('A Stop is in flight', () => fx.killControl.rejectHeld !== undefined, 10_000)
  const noticesBefore = fx.notices.length

  // Same-Session replacement: A closes, the browser closes/reopens, B mounts.
  fx.fixture.vt.sendInput('\x1b')
  await waitFor('the A viewer closed', () => app.overlayGraphState().handles === 1, 10_000)
  fx.fixture.vt.sendInput('\x1b')
  await waitFor('the browser closed', () => app.overlayGraphState().handles === 0, 10_000)
  submit(app, '/tasks')
  await waitFor('the browser re-opened', () => app.overlayGraphState().handles === 1, 10_000)
  await openJobRow(fx, JOB_TWO_LABEL)
  await waitFor('the B viewer opened', () => app.overlayGraphState().handles === 2, 10_000)
  await waitFor('the B body arrived', () => view().includes('pr3-b retained line'), 20_000)

  // Reject A's held settlement: the retired viewer's ERROR notice must be dropped.
  fx.killControl.rejectHeld?.(new Error('injected carrier rejection'))
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.deepEqual(
    fx.notices.slice(noticesBefore).filter(message => message.includes(JOB_ONE_LABEL)),
    [],
    'a Stop ERROR settlement for the CLOSED viewer A must not notify the replacement surface',
  )
  assert.equal(view().includes('pr3-a retained line'), false, 'A output must not paint the replacement viewer')

  // Positive control: the CURRENT viewer's stop ERROR still notifies.
  fx.killControl.mode = 'reject'
  fx.fixture.vt.sendInput(key)
  await waitFor('the current viewer stop error notified', () =>
    fx.notices.slice(noticesBefore).some(message => message.includes(`could not stop ${JOB_TWO_LABEL}`)), 10_000)
})
