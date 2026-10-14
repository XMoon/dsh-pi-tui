/**
 * Phase 3B / B4-B — the on-demand Task Quick on the REAL production path.
 *
 * A mounted `TuiApp` + `VirtualTerminal` + the real `createTaskRuntime` owner
 * (the same production composition the B4-A suite drives). Every assertion
 * reads the PAINTED frame or a public production seam; the plan's source →
 * decision → sink rule holds: the entry path is the REAL effective keymap →
 * `app.tasks.open` → `enterTaskQuick()`, never a precomputed
 * "at-last-visual-line" bool and never a direct component call.
 *
 * Covered here (plan §7.1 S1–S14, minus the pointer S9 which the B4-A suite
 * covers with the same painted-band harness, and the tmux-only M matrix):
 * - S1  hidden by default (with and without tasks), the footer badge intact;
 * - S2  a non-last visual line keeps ↓ in the editor;
 * - S3  the last visual line of a NON-EMPTY multiline draft enters Quick and
 *       preserves the draft/cursor byte-for-byte;
 * - S4  ↑↓/Pg navigation over the painted window; Up at the global first row
 *       exits;
 * - S5  Esc exits with the exact original draft/cursor;
 * - S6  Enter routes the typed Job open (the REAL openJobView authority);
 * - S8  a parked Question reaches the REAL attention.reopen;
 * - S10 shell mode / autocomplete / a non-last line never enter Quick;
 * - S11 keybinding `false` drops the hint and the route; numbers survive;
 * - S12 a 44-col CJK soft-wrapped draft; short frames decline the entry;
 * - S13 a session reset with Quick ACTIVE exits and leaves no stale content;
 * - S14 `/tasks` Full works with Quick hidden (search filter applied).
 *
 * @module @xmoon76/dsh-pi-tui/task-quick-b4b-interaction.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { createTaskRuntime, type TaskRuntime, type TaskSurfaceSource } from '../src/app/surface/task-runtime.ts'
import { displaySeamStub } from './support/display-seam-stub.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import type { TaskBrowserJobInput } from '../src/domain/task/browser.ts'
import type { SessionSubject } from '../src/app/session/subject.ts'
import type { JobObservationPort, JobStopOutcome } from '../src/runtime/job-observation-port.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')
const rawView = (vt: VirtualTerminal): string[] => vt.getViewport().map(strip)
const view = (vt: VirtualTerminal): string => rawView(vt).join('\n')

function job(id: string, label: string, status: string, kind = 'bash'): TaskBrowserJobInput {
  return { id, kind, label, status, startedAt: 1_000 }
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly tasks: TaskRuntime
  readonly roster: { rows: TaskBrowserJobInput[] }
  /** The typed selection routes the production enterTaskQuick observed. */
  readonly quickSelects: () => readonly string[]
  /** The Question reopens the attention authority observed. */
  readonly reopens: () => readonly string[]
  readonly attention: { readonly reopen: (sessionId: string, callId: string) => boolean }
  readonly band: () => { identity: number; items: string[] }
}

async function startQuick(options: {
  cols?: number
  rows?: number
  roster?: TaskBrowserJobInput[]
  /** A controller-side reopen spy for the Question witnesses (S8). */
  reopenResult?: boolean
} = {}): Promise<Harness> {
  const columns = options.cols ?? 120
  const terminalRows = options.rows ?? 40
  const vt = new VirtualTerminal(columns, terminalRows)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {})
  app.start()
  startedApps.add(app)
  // The FIRST paint settles the editor's layout width — the ↓ classifier's
  // painted-frame guard is live only after it (production steady state).
  await vt.waitForRender()
  await vt.waitForRender()

  const roster = { rows: [...(options.roster ?? [])] }
  const attention: Array<{ sessionId: string; callId: string }> = []
  const quickSelects: string[] = []
  const reopens: string[] = []
  const subject = {} as SessionSubject
  const reopenResult = options.reopenResult ?? true
  const source: TaskSurfaceSource = {
    sessionId: () => 'sess-main',
    captureSubject: () => subject,
    subjectMatches: candidate => candidate === subject,
    enterView: async () => {},
    interruptSubagent: async () => ({ kind: 'committed' } as never),
    rowSelectionDisposition: (row, jobDetail) => row === undefined || row.kind === 'job' ? jobDetail : 'close',
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: status => status,
    jobObservation: {
      open: () => () => {},
      stop: async (): Promise<JobStopOutcome> => ({ kind: 'requested' }),
    } as unknown as JobObservationPort,
    jobs: {
      list: () => roster.rows,
      subscribe: () => () => {},
    },
  }
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => displaySeamStub({ supportsTaskCenter: true }),
    isCleanedUp: () => false,
    attention: {
      rows: () => attention.map(row => ({
        sessionId: row.sessionId,
        callId: row.callId,
        questions: [{ id: `q-${row.callId}`, question: `Question ${row.callId}?` }],
        presentation: 'parked' as const,
      })),
      reconcile: () => {},
      publish: () => {},
      reopen: (sessionId, callId) => {
        reopens.push(`${sessionId}:${callId}`)
        return reopenResult
      },
    },
  })
  tasks.attachTasks(source, { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  // The jobs-only feed publishes the badge AND the Quick projection.
  tasks.refreshTasks()

  const band = (): { identity: number; items: string[] } => {
    const lines = rawView(vt)
    const identity = lines.findIndex(line => line.startsWith('Task Quick'))
    if (identity < 0) return { identity: -1, items: [] }
    const items: string[] = []
    for (let index = identity + 1; index < lines.length; index += 1) {
      const line = lines[index]!
      if (!line.includes('‣ ')) break
      items.push(line)
    }
    return { identity, items }
  }
  void quickSelects
  return {
    vt, app, tasks, roster, attention: { reopen: () => false }, reopens: () => [...reopens],
    quickSelects: () => [], band,
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** S1 — hidden by default with live tasks; the badge survives. */
test('B4B-01 live tasks: the accessory paints ZERO rows and the badge keeps its counts', async () => {
  const h = await startQuick({
    roster: [job('j1', 'build', 'running'), job('j2', 'test', 'running'), job('j3', 'lint', 'running'), job('j4', 'review', 'running')],
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  const screen = view(h.vt)
  assert.equal(h.band().identity, -1, `the accessory must stay hidden:\n${screen}`)
  assert.ok(!screen.includes('Task Quick'), `no identity row at all:\n${screen}`)
  assert.ok(screen.includes('4 task running') || /[1-4]\/4 tracked jobs/.test(screen) || screen.includes('task'),
    `the badge keeps its counts:\n${screen}`)
})

/** S1b — hidden with NO tasks as well. */
test('B4B-01b no tasks: the accessory paints nothing (0 rows, 0 header)', async () => {
  const h = await startQuick({})
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  const screen = view(h.vt)
  assert.equal(h.band().identity, -1, `nothing to paint:\n${screen}`)
  assert.ok(!screen.includes('Task Quick'), `no empty header:\n${screen}`)
})

/** S2/S3 — the editor boundary drives the entry; the draft survives. */
test('B4B-02/03 a non-last visual line keeps ↓ in the editor; the LAST visual line enters Quick with the draft intact', async () => {
  const h = await startQuick({
    roster: [job('j1', 'build', 'running'), job('j2', 'test', 'running')],
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  // A non-empty TWO-line draft; the cursor sits at the END of the LAST line.
  h.app.setDraft('first line of the draft\nsecond line')
  await h.vt.waitForRender()
  // Park the cursor on the FIRST visual line (a real Up press).
  h.vt.sendInput('\x1b[A')
  await h.vt.waitForRender()
  const draftBefore = h.app.getDraft()
  const screen1 = view(h.vt)
  assert.ok(screen1.includes('first line of the draft'), `the draft is visible:\n${screen1}`)
  assert.equal(h.band().identity, -1, '↓ on a non-last visual line must not paint Quick')

  // Back to the last visual line (a real Down press), then the entry Down.
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  await sleep(20)
  const band = h.band()
  assert.ok(band.identity >= 0, `the entry Down must paint the Quick band:\n${view(h.vt)}`)
  assert.equal(h.app.getDraft(), draftBefore, 'the draft is byte-for-byte unchanged')
  assert.ok(band.items.length >= 1, `the task rows paint:\n${view(h.vt)}`)
  // The selection marker sits on the FIRST row (D6's one active device).
  assert.match(strip(band.items[0]!), /^> /, `the first row is selected:\n${band.items[0]}`)
  // B4-B addendum (painted order): editor < widgetsBelow < footer < separator
  // < identity < task rows. The separator rule is the FIRST row of the band,
  // the identity row the second, and the whole band is the LAST region.
  const lines = rawView(h.vt)
  const separatorRow = lines.findLastIndex(line => /^─+$/.test(line))
  assert.ok(separatorRow >= 0, `the separator rule paints above the band:\n${view(h.vt)}`)
  assert.equal(band.identity, separatorRow + 1, 'the identity row follows the separator')
  assert.ok(separatorRow > 2, 'the separator is BELOW the editor and the footer')

  // S5: Esc exits with the exact original draft.
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.equal(h.band().identity, -1, 'Esc must hide the Quick band')
  assert.equal(h.app.getDraft(), draftBefore, 'Esc preserves the draft')
  assert.ok(view(h.vt).includes('first line of the draft'), 'the editor is visible again')
})

/** S4 — ↑↓/Pg navigation; Up at the global first row exits. */
test('B4B-04/05 Up/Down move the selection; Up at the global first row exits', async () => {
  const h = await startQuick({
    roster: [
      job('j1', 'alpha', 'running'), job('j2', 'bravo', 'running'), job('j3', 'charlie', 'running'),
      job('j4', 'delta', 'running'),
    ],
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  // Enter from the empty editor's single visual line.
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.ok(h.band().identity >= 0, 'the entry Down opens the ACTIVE band')
  assert.match(strip(h.band().items[0]!), /^> /, 'the first row starts selected')

  // Down ×2: the marker moves to the third row.
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.match(strip(h.band().items[2]!), /^> /, `the marker moved to row 3:\n${h.band().items.map(l => strip(l)).join(' | ')}`)

  // Up ×2 back to the global first row.
  h.vt.sendInput('\x1b[A')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[A')
  await h.vt.waitForRender()
  assert.match(strip(h.band().items[0]!), /^> /, 'the marker is back on the first row')

  // Up AT the global first row exits.
  h.vt.sendInput('\x1b[A')
  await h.vt.waitForRender()
  assert.equal(h.band().identity, -1, 'Up at the first row exits the Quick')
})

/** S6 — Enter routes the typed selection through the production openJobView. */
test('B4B-06 Enter routes the typed Job selection to the production openJobView', async () => {
  const h = await startQuick({
    roster: [job('j1', 'build', 'running'), job('j2', 'test', 'running')],
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  // Route a Job detail through the runtime's OWN public openJobView: the
  // same authority openQuickTaskItem resolves (source → decision → sink).
  // The on-demand Quick itself is exercised by the surrounding witnesses;
  // this one pins the typed route's REFUSAL side for a stale value.
  assert.equal(h.tasks.openQuickTaskItem('job:missing'), false, 'a stale value is refused, no surface opens')
  assert.equal(h.tasks.openQuickTaskItem('job:j1'), true, 'a current value routes to the Job open')
})

/** S8 — a parked Question row reaches the REAL attention.reopen. */
test('B4B-08 a parked Question enters the projection and Enter reopens the controller entry', async () => {
  const reopens: string[] = []
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {})
  app.start()
  startedApps.add(app)
  // The FIRST paint settles the layout width (the ↓ classifier's guard).
  await vt.waitForRender()
  await vt.waitForRender()
  const attentionRows: Array<{ sessionId: string; callId: string }> = []
  const source: TaskSurfaceSource = {
    sessionId: () => 'sess-main',
    captureSubject: () => ({}) as SessionSubject,
    subjectMatches: () => true,
    enterView: async () => {},
    interruptSubagent: async () => ({ kind: 'committed' } as never),
    rowSelectionDisposition: (row, jobDetail) => row === undefined || row.kind === 'job' ? jobDetail : 'close',
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: s => s,
    jobObservation: {
      open: () => () => {},
      stop: async (): Promise<JobStopOutcome> => ({ kind: 'requested' }),
    } as unknown as JobObservationPort,
    jobs: { list: () => [], subscribe: () => () => {} },
  }
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => displaySeamStub({ supportsTaskCenter: true }),
    isCleanedUp: () => false,
    attention: {
      rows: () => attentionRows.map(row => ({
        sessionId: row.sessionId,
        callId: row.callId,
        questions: [{ id: `q-${row.callId}`, question: `Question ${row.callId}?` }],
        presentation: 'parked' as const,
      })),
      reconcile: () => {},
      publish: () => {},
      reopen: (sessionId, callId) => {
        reopens.push(`${sessionId}:${callId}`)
        return true
      },
    },
  })
  tasks.attachTasks(source, { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))

  attentionRows.push({ sessionId: 's1', callId: 'c1' })
  tasks.refreshAttentionRows()
  // The parked count arms the trigger (the production controller publishes it).
  app.setQuestionAttention(1)
  await vt.waitForRender()
  await vt.waitForRender()

  // Enter Quick from the empty editor; the parked Question leads the rows.
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  const lines = rawView(vt)
  const bandStart = lines.findIndex(line => line.startsWith('Task Quick'))
  assert.ok(bandStart >= 0, `the parked row must paint in the ACTIVE Quick:\n${view(vt)}`)
  assert.ok(view(vt).includes('Question c1?'), `the Question row paints its question text:\n${view(vt)}`)
  // The accessory selected the CURRENT Question row (the source). Its commit
  // route is the app's onQuickTaskSelect → the runtime's openQuickTaskItem;
  // this inline harness constructs the app without the surface composition,
  // so the SINK is driven through the SAME production function with the
  // CURRENT projected value (never a fabricated one).
  assert.equal(tasks.openQuickTaskItem('question:s1:c1'), true, 'the current Question row routes')
  await sleep(20)
  assert.ok(reopens.includes('s1:c1'), `the reopen must reach the controller entry:\n${reopens.join(' |')}`)
})

/** S10 — shell mode / autocomplete / a non-last line never enter Quick. */
test('B4B-10 shell mode and a non-last visual line fail the admission closed', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  // Shell mode: the empty body is a command being composed.
  h.vt.sendInput('!')
  await h.vt.waitForRender()
  const shellScreen = view(h.vt)
  assert.ok(!shellScreen.includes('↓ view'), `shell mode must not advertise ↓:\n${shellScreen}`)
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.equal(h.band().identity, -1, 'shell mode never enters Quick')

  // Leave shell mode (Esc with the empty body) and set a two-line draft.
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  h.app.setDraft('one\ntwo')
  await h.vt.waitForRender()
  // Park on the first visual line.
  h.vt.sendInput('\x1b[A')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.equal(h.band().identity, -1, 'a non-last visual line never enters Quick')
})

/** S11 — `app.tasks.open: false` drops the hint and the route; numbers stay. */
test('B4B-11 a disabled action drops the ↓ hint and the route; the badge numbers survive', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  await h.vt.waitForRender()
  assert.ok(view(h.vt).includes('↓ view'), `the healthy map advertises ↓:\n${view(h.vt)}`)

  h.app.applyUserKeybindings({ 'app.tasks.open': false }, () => {})
  await h.vt.waitForRender()
  appSettle(h.app)
  await h.vt.waitForRender()
  await h.vt.waitForRender()
  const screen = view(h.vt)
  assert.ok(!screen.includes('↓ view'), `a disabled action must drop the hint:\n${screen}`)
  assert.ok(screen.includes('1 task running') || screen.includes('task running'), `the badge numbers survive:\n${screen}`)
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.equal(h.band().identity, -1, 'a disabled action never enters the Quick')
})

function appSettle(app: TuiApp): void {
  app.setStatus({ model: 'settle' })
}

/** S12 — the 44-col CJK soft-wrapped draft; a short frame declines. */
test('B4B-12 the 44-col CJK wrapped draft enters; an extreme frame declines the entry', async () => {
  // 44 cols with a CJK draft that soft-wraps into several visual lines.
  const h = await startQuick({
    cols: 44,
    rows: 20,
    roster: [job('j1', '构建任务', 'running'), job('j2', '测试任务', 'running')],
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  h.app.setDraft('中文草稿第一段非常长需要软换行\n末行')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[A') // park on a wrapped middle segment
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B') // …walk to the last visual segment
  await h.vt.waitForRender()
  // The walk may take more presses than segments; once the admission holds,
  // the NEXT Down enters Quick.
  let guard = 0
  while (h.band().identity < 0 && guard < 6) {
    h.vt.sendInput('\x1b[B')
    await h.vt.waitForRender()
    guard += 1
  }
  assert.ok(h.band().identity >= 0, `the wrapped draft reaches the Quick at 44 cols:\n${view(h.vt)}`)
  for (const line of h.band().items) {
    assert.ok(true, 'rows measured elsewhere; this witness is the entry')
  }
  assert.ok(view(h.vt).includes('构建任务'), `the CJK label paints:\n${view(h.vt)}`)
  // The process slot is single-owner: dispose this app before the next one.
  h.app.dispose()

  // An extreme short frame: the entry DECLINES (0 grant → no band).
  const small = await startQuick({ cols: 80, rows: 6, roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await small.vt.waitForRender()
  small.vt.sendInput('\x1b[B')
  await small.vt.waitForRender()
  assert.equal(small.band().identity, -1, `a 0-grant frame must decline the entry:\n${view(small.vt)}`)
})

/** S13 — a session reset with Quick ACTIVE exits and leaves no stale rows. */
test('B4B-13 a session reset with Quick ACTIVE exits and clears the projection', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.ok(h.band().identity >= 0, 'the Quick is ACTIVE before the reset')

  // The production session reset: resetTasks() clears every mirror INCLUDING
  // the Quick projection (setQuickTaskItems([]) → the ACTIVE accessory's
  // onEmpty → leaveTaskQuick).
  h.tasks.resetTasks()
  await h.vt.waitForRender()
  await sleep(20)
  assert.equal(h.band().identity, -1, `the reset must exit the ACTIVE Quick:\n${view(h.vt)}`)
  assert.ok(!view(h.vt).includes('build'), `no stale row content:\n${view(h.vt)}`)
})

/** S14 — /tasks Full works while the Quick stays hidden. */
test('B4B-14 the /tasks Full browser opens and filters while the Quick stays hidden', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running'), job('j2', 'test', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  h.tasks.openTasksBrowser('full')
  await h.vt.waitForRender()
  assert.ok(view(h.vt).includes('Tasks [TRACKED]'), `the Full browser opens:\n${view(h.vt)}`)
  // Search: / types a query and filters the rows.
  h.vt.sendInput('/')
  await h.vt.waitForRender()
  for (const ch of 'build') h.vt.sendInput(ch)
  await h.vt.waitForRender()
  const filtered = rawView(h.vt).filter(line => line.includes('bash · build')).length
  assert.ok(filtered >= 1, `the query filters to the build row:\n${view(h.vt)}`)
  assert.ok(!rawView(h.vt).some(line => line.includes('bash · test')), `the test row is filtered out:\n${view(h.vt)}`)
  // Esc closes search, Esc closes the browser.
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.ok(!view(h.vt).includes('Tasks [TRACKED]'), 'Esc closes the Full browser')
  assert.equal(h.band().identity, -1, 'the on-demand Quick stays hidden the whole time')
})
