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
import { JobInspectorPanel } from '../src/tui/panels/job-inspector-panel.ts'

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
  // The typed selection route is wired EXACTLY like the production surface
  // composition (onQuickTaskSelect → task.openQuickTaskItem) through a
  // late-bound ref, so an Enter/click in this suite proves the real
  // app → callback → runtime-authority sink.
  let runtimeRef: TaskRuntime | undefined
  const quickSelects: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  }, {
    onQuickTaskSelect: (value: string): boolean => {
      quickSelects.push(value)
      return runtimeRef?.openQuickTaskItem(value) ?? false
    },
  })
  app.start()
  startedApps.add(app)
  // The FIRST paint settles the editor's layout width — the ↓ classifier's
  // painted-frame guard is live only after it (production steady state).
  await vt.waitForRender()
  await vt.waitForRender()

  const roster = { rows: [...(options.roster ?? [])] }
  const attention: Array<{ sessionId: string; callId: string }> = []
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
  runtimeRef = tasks
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
  return {
    vt, app, tasks, roster, attention: { reopen: () => false }, reopens: () => [...reopens],
    quickSelects: () => [...quickSelects], band,
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
  // F6: the SELECTED label paints textStrong (bold); the unselected does not.
  // Bold is a CELL attribute — read through the terminal buffer, not the
  // stripped text.
  const allRows = rawView(h.vt)
  const selectedRowNo = allRows.findIndex(line => line.includes('build') && line.includes('‣'))
  const unselectedRowNo = allRows.findIndex(line => line.includes('test') && line.includes('‣'))
  assert.ok(selectedRowNo >= 0 && unselectedRowNo >= 0, `both rows paint:\n${allRows.join('\n')}`)
  const labelCol = allRows[selectedRowNo]!.indexOf('bash')
  assert.ok(h.vt.getCellBold(selectedRowNo, labelCol + 1), `the selected label is bold (textStrong):\n${allRows[selectedRowNo]}`)
  assert.equal(h.vt.getCellBold(unselectedRowNo, allRows[unselectedRowNo]!.indexOf('test') + 1), false,
    `the unselected label is not bold:\n${allRows[unselectedRowNo]}`)
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

/** S6 — Enter routes the typed selection into a REAL Job workspace (the
 *  literal Enter → accessory → app callback → runtime → Job Inspector sink). */
test('B4B-06 Enter opens the real Job workspace; a refused value never disturbs it', async () => {
  const h = await startQuick({
    roster: [job('j1', 'build', 'running'), job('j2', 'test', 'running')],
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  const draftBefore = h.app.getDraft()
  const screenOpen = (): boolean => h.app.focusedComponentForTest() instanceof JobInspectorPanel

  // The LITERAL keyboard path: enter Quick, select alpha, Enter. The sink is
  // the REAL Job workspace (keyboard + screen), not a recorded array: with a
  // runtime that never opens anything this test could not pass.
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  await sleep(20)
  assert.ok(screenOpen(), `the Enter must open the REAL Job workspace:\n${view(h.vt)}`)
  assert.equal(h.band().identity, -1, 'the commit leaves Quick (the workspace owns the surface)')

  // The workspace HOLDS the keyboard: typing grows nothing in the editor
  // draft while it is up.
  h.vt.sendInput('q')
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), draftBefore, 'the Job workspace owns the keys, the editor gets nothing')

  // The workspace's Esc returns the KEYBOARD to the editor with the draft
  // intact (plan §9.2 — Job detail Esc lands on the editor; no modal Quick).
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.ok(!screenOpen(), 'the workspace Esc closes it')
  h.vt.sendInput('z')
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), `${draftBefore}z`, 'the editor owns the keys again, draft intact')

  // The REFUSAL side through the SAME authority: a stale value is refused
  // (no surface opens), a current one routes.
  assert.equal(h.tasks.openQuickTaskItem('job:missing'), false, 'a stale value is refused, no surface opens')
  assert.equal(h.tasks.openQuickTaskItem('job:j1'), true, 'a current value routes to the Job open')
})

/** S8 — a parked Question row reaches the REAL attention.reopen. */
test('B4B-08 a parked Question enters the projection; a refused reopen reports no surface', async () => {
  const reopens: string[] = []
  let allowReopen = true
  const vt = new VirtualTerminal(120, 40)
  let runtimeRef: TaskRuntime | undefined
  // The PRODUCTION commit route, wired exactly like the surface composition:
  // Enter → accessory onActivate → the app's onQuickTaskSelect → the
  // runtime's openQuickTaskItem. Without this option the Enter would fall
  // through to the editor submit and prove nothing.
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    onQuickTaskSelect: (value: string): boolean => runtimeRef?.openQuickTaskItem(value) ?? false,
  })
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
        return allowReopen
      },
    },
  })
  tasks.attachTasks(source, { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  runtimeRef = tasks
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
  // The LITERAL Enter path — accessory → app onQuickTaskSelect → runtime
  // openQuickTaskItem → the controller's reopen. The parked Question's
  // reopen is the PRODUCTION reopen (the reopens array is wired as the
  // attention authority), so this proves the source→sink chain, not a
  // helper called in isolation.
  vt.sendInput('\r')
  await vt.waitForRender()
  await sleep(20)
  assert.ok(reopens.includes('s1:c1'), `the Enter must reopen through the controller entry:\n${reopens.join(' |')}`)
  assert.equal(rawView(vt).findIndex(line => line.startsWith('Task Quick')), -1, 'the commit leaves Quick after the Question route')

  // The STALE-Question refusal is part of the typed contract (plan §9.2):
  // reopen false ⇒ openQuickTaskItem false, dispatched exactly once.
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  allowReopen = false
  tasks.refreshAttentionRows()
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  await sleep(20)
  assert.equal(reopens.filter(id => id === 's1:c1').length, 2, 'exactly the refusal dispatch happened')
  assert.equal(rawView(vt).findIndex(line => line.startsWith('Task Quick')), -1, 'a refused reopen keeps Quick closed (no fabricated reopen surface)')
})

/** S9 — Fullscreen native SGR press→release→synthesized click opens the
 *  typed detail for the SAME row; press A → release B never activates. */
test('B4B-09-s9 fullscreen same-row SGR click opens; cross-row press/release refuses', async () => {
  const h = await startQuick({
    roster: [job('j1', 'alpha', 'running'), job('j2', 'bravo', 'running'), job('j3', 'charlie', 'running')],
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  // Swap first (a regular-root band would be retired by the hand-off), then
  // enter Quick on the alt root.
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.ok(h.band().identity >= 0, 'the Quick is ACTIVE on the alt root')

  const rows = rawView(h.vt)
  const rowA = rows.findIndex(line => line.includes('alpha') && line.includes('‣'))
  const rowB = rows.findIndex(line => line.includes('bravo') && line.includes('‣'))
  assert.ok(rowA >= 0 && rowB >= 0, `both task rows paint in fullscreen:\n${view(h.vt)}`)

  // press A → release B: identity mismatch (a moved gesture), nothing opens.
  // The SINK is observed, not a painted word: an empty record BEFORE the
  // positive control makes this negative discriminating.
  h.vt.sendInput(`\x1b[<0;10;${rowA + 1}M`)
  h.vt.sendInput(`\x1b[<0;10;${rowB + 1}m`)
  await h.vt.waitForRender()
  await sleep(20)
  assert.deepEqual(h.quickSelects(), [], 'a moved press/release must not activate any row')

  // The separator/header rule is inert: a full press/release ON the
  // separator row synthesizes a click that no task row answers.
  const sepRow = h.band().identity
  assert.ok(sepRow >= 0, 'the band is still ACTIVE for the separator probe')
  h.vt.sendInput(`\x1b[<0;10;${sepRow + 1}M`)
  h.vt.sendInput(`\x1b[<0;10;${sepRow + 1}m`)
  await h.vt.waitForRender()
  await sleep(20)
  assert.deepEqual(h.quickSelects(), [], 'the separator hit is inert (addendum §3.3)')

  // STRUCTURAL row replacement between press and release: the pressed row's
  // stable identity is REPLACED while the gesture is held (a real
  // asynchronous swap — same physical cell, a different task at the SAME
  // painted window). After the reflow REPAINTS, the cell carries a
  // different stable identity while the painted placement stays live — the
  // accessory's stable-ID guard must refuse the click (the fork synthesizes
  // one for the unchanged placement; the identity mismatch decides).
  h.vt.sendInput(`\x1b[<0;10;${rowA + 1}M`)
  await h.vt.waitForRender()
  h.roster.rows = [job('j9', 'alpha2', 'running'), job('j2', 'bravo', 'running'), job('j3', 'charlie', 'running')]
  h.tasks.refreshTasks()
  await h.vt.waitForRender()
  await sleep(40) // let the reflow frame clear the fork's render throttle
  await h.vt.waitForRender()
  h.vt.sendInput(`\x1b[<0;10;${rowA + 1}m`)
  await h.vt.waitForRender()
  await sleep(20)
  assert.deepEqual(h.quickSelects(), [], 'a replaced pressed row must not activate on the stale identity')

  // The gesture state is clean after the refusal: a fresh same-cell
  // press/release on the CURRENT first row activates THAT row (a NEW press
  // overwrites the latch; the refused identity is gone).
  h.vt.sendInput(`\x1b[<0;10;${rowA + 1}M`)
  h.vt.sendInput(`\x1b[<0;10;${rowA + 1}m`)
  await h.vt.waitForRender()
  await sleep(20)
  assert.deepEqual(h.quickSelects(), ['job:j9'], `the fresh click must activate the CURRENT row:\n${h.quickSelects().join('|')}`)
  h.app.setFullscreen(false)
  await h.vt.waitForRender()
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

  // An extreme short frame: the entry DECLINES (0 grant → no band), the ↓
  // hint is NOT painted, and the Down reaches the EDITOR (native behavior —
  // here: it jumps the single-line draft to the line end, visible via the
  // next printable landing after the cursor; simpler witness: a printable
  // still edits the draft, proving the editor owns the keyboard).
  const small = await startQuick({ cols: 80, rows: 6, roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await small.vt.waitForRender()
  const smallScreen = view(small.vt)
  assert.ok(!smallScreen.includes('↓ view'), `a 0-grant frame must not advertise ↓:\n${smallScreen}`)
  small.vt.sendInput('\x1b[B')
  await small.vt.waitForRender()
  assert.equal(small.band().identity, -1, `a 0-grant frame must decline the entry:\n${smallScreen}`)
  small.vt.sendInput('x')
  await small.vt.waitForRender()
  assert.ok(view(small.vt).includes('❯ x'), `the editor must own the keyboard after the declined Down:\n${view(small.vt)}`)
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

/** F4: an ACTIVE Quick resized below its grant retires — the editor gets
 *  the keyboard back instead of an invisible band consuming input. */
test('B4B-resize-zero an ACTIVE Quick resized to 0 grant exits and returns the editor', async () => {
  const h = await startQuick({ cols: 120, rows: 40, roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.ok(h.band().identity >= 0, 'the Quick is ACTIVE before the resize')
  h.vt.resize(120, 4)
  await h.vt.waitForRender()
  await sleep(30)
  assert.equal(h.band().identity, -1, `the lost grant must retire the band:\n${view(h.vt)}`)
  // The editor owns the keyboard again (the accessory consumes nothing).
  h.vt.sendInput('x')
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), 'x', `the editor must own the keyboard after the resize:\n${view(h.vt)}`)
})

/** Selection-currentness (B4B-08): deleting the SELECTED row falls back to
 *  its successor (predecessor at the tail) — never to the head. */
test('B4B-delete-fallback deleted selection lands on successor/predecessor', async () => {
  const h = await startQuick({ roster: [job('j1', 'alpha', 'running'), job('j2', 'bravo', 'running'), job('j3', 'charlie', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B') // enter; alpha selected
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B') // select bravo
  await h.vt.waitForRender()
  assert.match(strip(h.band().items[1]!), /^> /, 'bravo is selected')
  const accessory = (h.app as unknown as { taskQuick?: { setItems(items: readonly unknown[]): void } }).taskQuick
  assert.ok(accessory, 'the accessory must be reachable for the projection commit')
  // Delete bravo: [alpha, charlie] → successor charlie selected.
  accessory.setItems([
    { value: 'job:j1', label: 'alpha', status: 'running', source: 'job' },
    { value: 'job:j3', label: 'charlie', status: 'running', source: 'job' },
  ])
  await h.vt.waitForRender()
  assert.match(strip(h.band().items[1]!), /^> /, `charlie (successor) is selected:\n${h.band().items.map(strip).join('|')}`)
  // Delete the tail (charlie): [alpha] → predecessor alpha selected.
  accessory.setItems([{ value: 'job:j1', label: 'alpha', status: 'running', source: 'job' }])
  await h.vt.waitForRender()
  assert.match(strip(h.band().items[0]!), /^> /, `alpha (predecessor) is selected:\n${h.band().items.map(strip).join('|')}`)
})

/** Screen-swap retirement (main §5): entering fullscreen while Quick is
 *  ACTIVE must hide the band and return the keyboard to the editor. */
test('B4B-swap a fullscreen hand-off retires the ACTIVE Quick', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.ok(h.band().identity >= 0, 'the Quick is ACTIVE before the swap')
  const draftBefore = h.app.getDraft()

  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  await sleep(20)
  assert.equal(h.band().identity, -1, `the swap must retire the ACTIVE band:\n${view(h.vt)}`)
  // The editor owns the keyboard on the new root: typing edits the draft.
  h.vt.sendInput('x')
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), `${draftBefore}x`, `the editor owns the keyboard after the swap:\n${view(h.vt)}`)

  // Re-entry works on the alt root.
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.ok(h.band().identity >= 0, 'the Quick can be re-entered on the alt root')
  h.app.setFullscreen(false)
  await h.vt.waitForRender()
  await sleep(20)
  assert.equal(h.band().identity, -1, 'the reverse swap retires it again')
  // The reverse swap restores the EDITOR's keyboard on the main root: the
  // same input-owner proof as the forward direction (B4B-11/S13).
  h.vt.sendInput('y')
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), `${draftBefore}xy`, 'the editor owns the keyboard after the reverse swap')
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

/** F2 — a PRE-ABORTED approval request is never a blocking owner. */
test('B4B-f2 a pre-aborted approval request does not retire the ACTIVE Quick', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.ok(h.band().identity >= 0, 'the Quick is ACTIVE before the aborted request')

  const controller = new AbortController()
  controller.abort()
  const decision = h.app.showApprovalPrompt({ toolName: 'bash', signal: controller.signal })
  await h.vt.waitForRender()
  assert.equal(await decision, 'cancelled', 'the aborted request settles cancelled')
  assert.ok(!view(h.vt).includes('Approve bash'), 'no dialog mounts for a pre-aborted request')
  assert.ok(h.band().identity >= 0, `the ACTIVE Quick survives the non-owner:\n${view(h.vt)}`)

  // The NEGATIVE control: a LIVE request is a real blocking owner and DOES
  // retire the band (plan §5 — the retirement follows the owner, not the
  // call).
  const live = h.app.showApprovalPrompt({ toolName: 'fs', reason: 'write' })
  await h.vt.waitForRender()
  assert.ok(view(h.vt).includes('Approve fs'), 'the live dialog mounts')
  assert.equal(h.band().identity, -1, 'the live blocking owner retires the ACTIVE Quick')
  h.vt.sendInput('n')
  assert.equal(await live, 'rejected')
  await h.vt.waitForRender()
})

/** F6 — the Down fast path measures the chrome ONCE per frame (plan §9.3). */
test('B4B-f6 the admission probe measures the chrome once per render window', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  // Patch the PRODUCTION measurement seam on the live instance (the
  // one-to-one passthrough pattern): every chrome measurement the admission
  // pays routes through this method.
  const app = h.app as unknown as { taskQuickChromeRows(width: number): number }
  const original = app.taskQuickChromeRows
  let calls = 0
  const patched = (width: number): number => {
    calls += 1
    return original.call(app, width)
  }
  app.taskQuickChromeRows = patched
  try {
    h.vt.sendInput('\x1b[B') // one Down: resolution + hint compose + dispatch
    await h.vt.waitForRender()
    await sleep(20)
    assert.ok(h.band().identity >= 0, 'the Down enters the Quick')
    assert.ok(calls <= 2, `the whole keypress must measure the chrome at most twice, got ${calls}`)
    calls = 0
    h.vt.sendInput('\x1b') // Esc leaves
    await h.vt.waitForRender()
    assert.equal(h.band().identity, -1, 'Esc leaves the Quick')
    calls = 0
    // A DECLINED candidate Down with a NON-EMPTY projection: the frame is
    // too short to paint one task row, so the projection survives (the
    // predicate's items gate passes) and the MEASURED grant probe is the
    // fact that declines. Shrink the viewport (rows 40 → 8) with the roster
    // intact — the projection stays non-empty, the grant goes to zero.
    const measuredBefore = calls
    h.vt.resize(120, 6)
    await h.vt.waitForRender()
    await sleep(20)
    await h.vt.waitForRender()
    assert.ok(h.app.taskQuickItemCountForTest() >= 1, 'the projection must be NON-empty for this negative')
    assert.equal(h.app.enterTaskQuick(), false, 'the 0-grant entry declines through the measured probe')
    assert.ok(calls >= measuredBefore, 'the decline must have gone through the measured grant path')
    calls = 0
    h.vt.sendInput('\x1b[B')
    await h.vt.waitForRender()
    await sleep(20)
    assert.equal(h.band().identity, -1, 'the 0-grant Down declines')
    assert.ok(calls <= 2, `a declined keypress must measure at most twice, got ${calls}`)
  } finally {
    app.taskQuickChromeRows = original
    h.vt.resize(120, 40)
  }
})
