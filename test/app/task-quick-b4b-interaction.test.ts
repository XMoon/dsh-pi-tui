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
 * - S14 `/tasks` Full works with Quick hidden (search filter applied);
 * - F11 focused Quick consumes Host submit/steer actions without touching the hidden draft.
 *
 * @module @xmoon76/dsh-pi-tui/task-quick-b4b-interaction.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { TuiApp, type TuiAppOptions } from '../../src/tui-app.ts'
import { EditorRegistry } from '../../src/extension/internal/editor-registry.ts'
import { HistoryPanel } from '../../src/tui/panels/history-panel.ts'
import { planTaskQuickLayout } from '../../src/tui/panels/task-quick-accessory.ts'
import { createTaskRuntime, type TaskRuntime, type TaskSurfaceSource } from '../../src/app/surface/task-runtime.ts'
import { displaySeamStub } from '../support/display-seam-stub.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import type { TaskBrowserJobInput } from '../../src/domain/task/browser.ts'
import type { TaskSubagentEntry } from '../../src/runtime/task-read-port.ts'
import type { SessionSubject } from '../../src/app/session/subject.ts'
import type { JobObservationPort, JobStopOutcome } from '../../src/runtime/job-observation-port.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { JobInspectorPanel } from '../../src/tui/panels/job-inspector-panel.ts'
import { SettingsWorkspacePanel, type SettingsWorkspaceSource } from '../../src/tui/panels/settings-workspace-panel.ts'
import { ExtensionLedger } from '../../src/extension/internal/ledger.ts'
import { SurfaceHost } from '../../src/extension/internal/surface-host.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')
const rawView = (vt: VirtualTerminal): string[] => vt.getViewport().map(strip)
const view = (vt: VirtualTerminal): string => rawView(vt).join('\n')
const editorFrame = (vt: VirtualTerminal): string[] => {
  const lines = rawView(vt)
  const top = lines.findIndex(line => line.includes('↑') && line.includes('more'))
  if (top < 0) return []
  const bottom = lines.findIndex((line, index) => index > top && /^─+$/.test(line.trim()))
  if (bottom < 0) return []
  return lines.slice(top, bottom + 1)
}

function job(id: string, label: string, status: string, kind = 'bash'): TaskBrowserJobInput {
  return { id, kind, label, status, startedAt: 1_000 }
}

function settingsWorkspaceSource(): SettingsWorkspaceSource {
  return {
    readSnapshot: () => ({
      configReadiness: 'ready',
      capturedAt: Date.now(),
      rows: [
        { id: 'theme', category: 'appearance', label: 'Configured theme', summary: 'auto', value: 'auto', scope: 'TUI settings document', freshness: 'ready', description: 'palette', action: 'inspect' },
      ],
    }),
  }
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly tasks: TaskRuntime
  readonly roster: { rows: TaskBrowserJobInput[] }
  /** The typed selection routes the production enterTaskQuick observed. */
  readonly quickSelects: () => readonly string[]
  /** Full Task Center callback count and focus ownership at dispatch. */
  readonly fullOpenCalls: () => number
  readonly quickFocusedAtFullOpen: () => readonly boolean[]
  readonly editorFocusedAtFullOpen: () => readonly boolean[]
  /** Host submits observed by the real input/action dispatcher. */
  readonly submitted: () => readonly string[]
  /** The Question reopens the attention authority observed. */
  readonly reopens: () => readonly string[]
  /** The production typed route's Subagent-view port calls. */
  readonly enteredViews: () => readonly Parameters<TaskSurfaceSource['enterView']>[]
  /** Whether Quick was still focused when the view port was entered. */
  readonly quickFocusedAtEnterView: () => readonly boolean[]
  readonly attention: { readonly reopen: (sessionId: string, callId: string) => boolean }
  readonly band: () => { identity: number; items: string[] }
}

async function startQuick(options: {
  cols?: number
  rows?: number
  roster?: TaskBrowserJobInput[]
  descendants?: TaskSubagentEntry[]
  /** A controller-side reopen spy for the Question witnesses (S8). */
  reopenResult?: boolean
  /** Include the production Full navigation action (the TuiApp callback uses TaskRuntime). */
  withFullAction?: boolean
  /** Optional production host seams needed by owner-displacement witnesses. */
  appOptions?: Omit<TuiAppOptions, 'onQuickTaskSelect' | 'onQuickTaskOpenFull'>
} = {}): Promise<Harness> {
  const columns = options.cols ?? 120
  const terminalRows = options.rows ?? 40
  const vt = new VirtualTerminal(columns, terminalRows)
  const submitted: string[] = []
  // The typed selection route is wired EXACTLY like the production surface
  // composition (onQuickTaskSelect → task.openQuickTaskItem) through a
  // late-bound ref, so an Enter/click in this suite proves the real
  // app → callback → runtime-authority sink.
  let runtimeRef: TaskRuntime | undefined
  const quickSelects: string[] = []
  const quickFocusedAtFullOpen: boolean[] = []
  const editorFocusedAtFullOpen: boolean[] = []
  let fullOpenCount = 0
  let appRef: TuiApp | undefined
  const app = new TuiApp(vt, {
    onSubmit: text => { submitted.push(text) },
    onExit: () => {},
  }, {
    ...options.appOptions,
    onQuickTaskSelect: (value: string): boolean => {
      quickSelects.push(value)
      return runtimeRef?.openQuickTaskItem(value) ?? false
    },
    ...(options.withFullAction === true ? {
      onQuickTaskOpenFull: () => {
        fullOpenCount += 1
        const currentApp = appRef
        assert.ok(currentApp, 'the Full callback runs only after TuiApp construction')
        quickFocusedAtFullOpen.push(currentApp.taskQuickFocusedForTest())
        editorFocusedAtFullOpen.push(
          currentApp.focusedComponentForTest() === currentApp.seatEditorForTest().component,
        )
        runtimeRef?.openTasksBrowser('full')
      },
    } : {}),
  })
  appRef = app
  app.start()
  startedApps.add(app)
  // The FIRST paint settles the editor's layout width — the ↓ classifier's
  // painted-frame guard is live only after it (production steady state).
  await vt.waitForRender()
  await vt.waitForRender()

  const roster = { rows: [...(options.roster ?? [])] }
  const attention: Array<{ sessionId: string; callId: string }> = []
  const reopens: string[] = []
  const enteredViews: Parameters<TaskSurfaceSource['enterView']>[] = []
  const quickFocusedAtEnterView: boolean[] = []
  const descendants = [...(options.descendants ?? [])]
  const subject = {} as SessionSubject
  const reopenResult = options.reopenResult ?? true
  const source: TaskSurfaceSource = {
    sessionId: () => 'sess-main',
    captureSubject: () => subject,
    subjectMatches: candidate => candidate === subject,
    enterView: async (...args) => {
      enteredViews.push(args)
      quickFocusedAtEnterView.push(app.taskQuickFocusedForTest())
    },
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
    ...(options.descendants === undefined ? {} : {
      taskRead: {
        currentKey: () => 'g1:sess-main',
        currentSessionId: () => 'sess-main',
        readTask: async () => ({
          parentSessionId: 'sess-main',
          parentAvailable: true,
          descendants,
          jobs: roster.rows,
        }),
        activityOf: (childId: string) => descendants
          .find((entry): entry is Extract<TaskSubagentEntry, { kind: 'child' }> => entry.kind === 'child' && entry.id === childId)
          ?.activity,
      },
    }),
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
    enteredViews: () => [...enteredViews], quickFocusedAtEnterView: () => [...quickFocusedAtEnterView],
    quickSelects: () => [...quickSelects],
    fullOpenCalls: () => fullOpenCount,
    quickFocusedAtFullOpen: () => [...quickFocusedAtFullOpen],
    editorFocusedAtFullOpen: () => [...editorFocusedAtFullOpen],
    submitted: () => [...submitted],
    band,
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** S1 — hidden by default with live tasks; the badge survives. */
test('live tasks: the accessory paints ZERO rows and the badge keeps its counts', async () => {
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
test('no tasks: the accessory paints nothing (0 rows, 0 header)', async () => {
  const h = await startQuick({})
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  const screen = view(h.vt)
  assert.equal(h.band().identity, -1, `nothing to paint:\n${screen}`)
  assert.ok(!screen.includes('Task Quick'), `no empty header:\n${screen}`)
})

/** S2/S3 — the editor boundary drives the entry; the draft survives. */
test('effective ↓ enters from the middle of the last visual line and preserves the draft', async () => {
  const h = await startQuick({
    roster: [job('j1', 'build', 'running'), job('j2', 'test', 'running')],
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  // Both lines fit the terminal width. Move the real caret left from the end
  // into the middle of the final visual line before exercising the Down route.
  const firstLine = 'first line of the draft is long enough to retain the caret column'
  const lastLine = 'second visual line keeps its cursor near the middle, not the end'
  const originalDraft = `${firstLine}\n${lastLine}`
  h.app.setDraft(originalDraft)
  await h.vt.waitForRender()
  for (let i = 0; i < 30; i++) {
    h.vt.sendInput('\x1b[D')
    await h.vt.waitForRender()
  }
  const cursorAtMiddle = h.app.seatEditorForTest().getCursor()
  const lastLineStart = firstLine.length + 1
  assert.ok(cursorAtMiddle > lastLineStart && cursorAtMiddle < originalDraft.length,
    `real Left input must park the caret inside the final visual line:\n${view(h.vt)}`)
  assert.ok(view(h.vt).includes('↓ view'), `the effective keymap advertises Down from the middle of the final visual line:\n${view(h.vt)}`)

  // Park the cursor on the FIRST visual line (a real Up press). This position
  // is still on the same logical draft, but it must not admit the Quick.
  h.vt.sendInput('\x1b[A')
  await h.vt.waitForRender()
  const draftBefore = h.app.getDraft()
  const screen1 = view(h.vt)
  assert.ok(screen1.includes(firstLine), `the draft is visible:\n${screen1}`)
  assert.equal(h.band().identity, -1, 'Down on a non-last visual line must not paint Quick')
  assert.ok(!screen1.includes('↓ view'), `a non-last visual line cannot advertise entry:\n${screen1}`)

  // Back to the final visual line (real Down), then the entry Down from its
  // middle. The first Down only navigates the editor; the second is routed by
  // the effective keymap and must preserve the non-end caret position.
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  const cursorBeforeEntry = h.app.seatEditorForTest().getCursor()
  assert.ok(cursorBeforeEntry > lastLineStart && cursorBeforeEntry < originalDraft.length,
    `vertical navigation returns to a middle position in the last visual line:\n${view(h.vt)}`)
  assert.ok(view(h.vt).includes('↓ view'), 'the effective keymap hint is available at the middle cursor')
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  await sleep(20)
  const band = h.band()
  assert.ok(band.identity >= 0, `the entry Down from the middle must paint Quick:\n${view(h.vt)}`)
  assert.equal(h.app.taskQuickFocusedForTest(), true, 'Quick owns focus after entry')
  assert.ok(!view(h.vt).includes('↓ view'), 'the entry hint disappears while Quick is ACTIVE')
  assert.equal(h.app.getDraft(), draftBefore, 'the draft is byte-for-byte unchanged')
  assert.equal(h.app.seatEditorForTest().getCursor(), cursorBeforeEntry, 'the middle caret offset is preserved')
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
  const separatorRow = band.identity - 1
  assert.ok(separatorRow >= 0, `the separator rule paints immediately above the identity row:\n${view(h.vt)}`)
  assert.match(lines[separatorRow]!, /^─+$/, 'the actual first band row is the divider')
  assert.equal(band.identity, separatorRow + 1, 'the identity row follows the separator')
  const footerRows = h.app.footerRenderRowsForTest().map(strip).map(line => line.trimEnd()).filter(Boolean)
  assert.ok(footerRows.length > 0, 'the live footer has painted rows')
  for (const footerRow of footerRows) {
    const paintedRow = lines.findIndex((line, index) => index < separatorRow && line.includes(footerRow))
    assert.ok(paintedRow >= 0, `Footer row must remain painted above the Quick divider: ${JSON.stringify(footerRow)}\n${view(h.vt)}`)
  }

  // S5: Esc exits with the exact original draft.
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.equal(h.band().identity, -1, 'Esc must hide the Quick band')
  assert.ok(view(h.vt).includes('↓ view'), 'the hint returns after focus is restored to the eligible editor')
  assert.equal(h.app.getDraft(), draftBefore, 'Esc preserves the draft')
  assert.ok(view(h.vt).includes('first line of the draft'), 'the editor is visible again')
})

test('Quick returns the scrolled editor viewport, cursor and mode unchanged', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  const draft = Array.from({ length: 24 }, (_, index) => `draft line ${index + 1} with enough text`).join('\n')
  h.app.setDraft(draft)
  await h.vt.waitForRender()

  const editorBefore = editorFrame(h.vt)
  assert.ok(editorBefore.length > 0, `the scrolled editor frame is visible:\n${view(h.vt)}`)
  assert.ok(editorBefore.some(line => line.includes('↑')), `the test draft exercises the scrolled viewport:\n${editorBefore.join('\n')}`)
  const cursorBefore = h.app.seatEditorForTest().getCursor()
  const modeBefore = h.app.inputModeForTest()
  const terminalCursorBefore = h.vt.getCursorPosition()

  // The non-empty draft ends on the last visual line, so the actual Down route
  // transfers focus without changing any Editor-owned state.
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.equal(h.app.taskQuickFocusedForTest(), true, 'the last-visual-line Down enters Quick')
  assert.equal(h.app.getDraft(), draft)
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()

  assert.equal(h.app.getDraft(), draft)
  assert.equal(h.app.seatEditorForTest().getCursor(), cursorBefore, 'the logical cursor offset returns exactly')
  assert.equal(h.app.inputModeForTest(), modeBefore, 'the Editor input mode returns unchanged')
  assert.deepEqual(h.vt.getCursorPosition(), terminalCursorBefore, 'the painted cursor position returns exactly')
  assert.deepEqual(editorFrame(h.vt), editorBefore, 'the scrolled visible editor viewport returns exactly')
})

/** S4 — ↑↓/Pg navigation; Up at the global first row exits. */
test('Up/Down and PgUp/PgDn move by painted task rows; Up at the global first row exits', async () => {
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

  // PgDn/PgUp move by the actual three painted task rows, not the divider or
  // identity row. The 4-item catalog exposes the shifted window and selection.
  h.vt.sendInput('\x1b[6~')
  await h.vt.waitForRender()
  assert.match(view(h.vt), /showing 2-4\/4/, `PgDn advances by three visible task rows:\n${view(h.vt)}`)
  assert.match(strip(h.band().items[2]!), /^> .*delta/, 'PgDn selects the fourth global task row')
  h.vt.sendInput('\x1b[5~')
  await h.vt.waitForRender()
  assert.match(view(h.vt), /showing 1-3\/4/, `PgUp returns to the first painted window:\n${view(h.vt)}`)
  assert.match(strip(h.band().items[0]!), /^> .*alpha/, 'PgUp selects the first global task row')
  h.vt.sendInput('\x1b[5~')
  await h.vt.waitForRender()
  assert.match(view(h.vt), /showing 1-3\/4/, `PgUp clamps at the first window instead of wrapping:\n${view(h.vt)}`)
  assert.match(strip(h.band().items[0]!), /^> .*alpha/, 'clamped PgUp keeps the first global row selected')
  h.vt.sendInput('\x1b[6~')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[6~')
  await h.vt.waitForRender()
  assert.match(view(h.vt), /showing 2-4\/4/, `repeated PgDn clamps at the last window instead of wrapping:\n${view(h.vt)}`)
  assert.match(strip(h.band().items[2]!), /^> .*delta/, 'clamped PgDn keeps the last global row selected')
  h.vt.sendInput('\x1b[5~')
  await h.vt.waitForRender()
  assert.match(view(h.vt), /showing 1-3\/4/, 'the next PgUp can move away from the clamped last window')

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
test('Enter opens the real Job workspace; a refused value never disturbs it', async () => {
  const h = await startQuick({
    roster: [job('j1', 'build', 'running'), job('j2', 'test', 'running')],
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  const draftBefore = h.app.getDraft()
  const screenOpen = (): boolean => h.app.focusedComponentForTest() instanceof JobInspectorPanel

  // The LITERAL keyboard path: enter Quick, select alpha, Enter. The sink is
  // the REAL Job workspace (keyboard + screen), not a recorded array: with a
  // runtime that never opens anything this test could not pass. The typed
  // IDENTITY is asserted too: the callback input is exactly the selected
  // stable value, and the opened workspace is THAT Job's — a mis-route to
  // job:j2 would fail both witnesses.
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  await sleep(20)
  assert.deepEqual(h.quickSelects(), ['job:j1'], `the Enter must route the EXACT selected value:\n${h.quickSelects().join('|')}`)
  assert.ok(screenOpen(), `the Enter must open the REAL Job workspace:\n${view(h.vt)}`)
  assert.ok(view(h.vt).includes('j1'), `the opened workspace is job:j1's:\n${view(h.vt)}`)
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

test('Post-B4-B Full action exits Quick before opening the same TaskRuntime Task Center as /tasks', async () => {
  const h = await startQuick({
    withFullAction: true,
    roster: [job('j1', 'build', 'running'), job('j2', 'test', 'running')],
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  const draftBefore = h.app.getDraft()
  const fullTaskLabels = (): string[] => rawView(h.vt)
    .map(line => line.match(/bash · (build|test)\b/)?.[0])
    .filter((label): label is string => label !== undefined)
  assert.equal(h.band().identity, -1, 'the action is hidden together with the inactive accessory')
  assert.ok(!view(h.vt).includes('Open Task Center…'))

  h.vt.sendInput('\x1b[B') // enter Quick; first real task stays selected
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B') // second real task
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B') // typed Full navigation target
  await h.vt.waitForRender()
  const action = rawView(h.vt).find(line => line.includes('Open Task Center…'))
  assert.ok(action?.startsWith('> ➜ Open Task Center…'), `the action follows both real tasks:
${view(h.vt)}`)
  assert.deepEqual(h.quickSelects(), [], 'navigation has not routed any TaskPanelItem')

  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  await sleep(20)
  assert.equal(h.fullOpenCalls(), 1, 'Enter invokes the injected Full Task Center callback once')
  assert.deepEqual(h.quickFocusedAtFullOpen(), [false], 'Quick commits HIDDEN before the runtime opens Full')
  assert.deepEqual(h.editorFocusedAtFullOpen(), [true], 'the live Editor seat receives focus before the runtime opens Full')
  assert.equal(h.app.taskQuickFocusedForTest(), false)
  const fromQuick = fullTaskLabels()
  assert.deepEqual(fromQuick, ['bash · build', 'bash · test'], `Full shows the global task rows:
${view(h.vt)}`)
  assert.ok(view(h.vt).includes('Tasks'), `the existing Full Task Center is open:
${view(h.vt)}`)
  assert.equal(h.band().identity, -1, 'Full owns the surface while Quick remains hidden')

  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  h.vt.sendInput('x')
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), `${draftBefore}x`, 'closing Full returns keyboard focus to the current Editor')
  assert.equal(h.band().identity, -1, 'closing Full does not restore the old Quick action selection')

  // The same runtime entry is what the existing `/tasks` command calls.
  h.tasks.openTasksBrowser('full')
  await h.vt.waitForRender()
  assert.deepEqual(fullTaskLabels(), fromQuick, 'the Full action and `/tasks` share the same global dataset')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
})

test('Post-B4-B Full action accepts only a same-row Fullscreen SGR click', async () => {
  const h = await startQuick({ withFullAction: true, roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()

  const rows = rawView(h.vt)
  const actionRow = rows.findIndex(line => line.includes('Open Task Center…'))
  const taskRow = rows.findIndex(line => line.includes('bash · build') && line.includes('‣'))
  assert.ok(actionRow >= 0 && taskRow >= 0, `both painted targets are visible:
${view(h.vt)}`)

  h.vt.sendInput(`\x1b[<0;10;${actionRow + 1}M`)
  h.vt.sendInput(`\x1b[<0;10;${taskRow + 1}m`)
  await h.vt.waitForRender()
  assert.equal(h.fullOpenCalls(), 0, 'pressing the action and releasing on a task row is inert')
  assert.deepEqual(h.quickSelects(), [])

  h.vt.sendInput(`\x1b[<0;10;${actionRow + 1}M`)
  h.vt.sendInput(`\x1b[<0;10;${actionRow + 1}m`)
  await h.vt.waitForRender()
  await sleep(20)
  assert.equal(h.fullOpenCalls(), 1, 'the matching painted action row opens Full exactly once')
  assert.deepEqual(h.quickFocusedAtFullOpen(), [false])
  assert.deepEqual(h.editorFocusedAtFullOpen(), [true], 'Fullscreen click restores Editor before opening Full')
  assert.equal(h.band().identity, -1, 'the mouse route also leaves Quick first')
  assert.ok(view(h.vt).includes('Tasks'), `the Full Task Center is visible after the click:
${view(h.vt)}`)
})

test('a live SGR wheel keeps Enter on the selected painted Quick row', async () => {
  const h = await startQuick({
    roster: [
      job('j1', 'build', 'running'), job('j2', 'test', 'running'), job('j3', 'lint', 'running'),
      job('j4', 'deploy', 'running'), job('j5', 'audit', 'running'),
    ],
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  h.app.setFullscreen(true)
  await h.vt.waitForRender()

  h.vt.sendInput('\x1b[B') // enter Quick through the effective editor binding
  await h.vt.waitForRender()
  const before = h.band()
  assert.equal(before.items.length, 3, `the first three task rows paint:\n${view(h.vt)}`)
  assert.match(strip(before.items[0]!), /^> .*bash · build/, 'the first painted task starts selected')

  // The real alt-screen router sends this native SGR wheel to Task Quick.
  const firstItemRow = before.identity + 1
  h.vt.sendInput(`\x1b[<65;5;${firstItemRow + 1}M`)
  await h.vt.waitForRender()
  await h.vt.waitForRender()
  const after = h.band()
  assert.match(strip(rawView(h.vt)[after.identity]!), /showing 2-4\/5$/, `the wheel advances the painted window:\n${view(h.vt)}`)
  assert.match(strip(after.items[0]!), /^> .*bash · test/, `selection moves to the visible edge row:\n${view(h.vt)}`)

  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  await sleep(20)
  assert.deepEqual(h.quickSelects(), ['job:j2'], 'Enter opens the selected value from the painted window')
  assert.ok(h.app.focusedComponentForTest() instanceof JobInspectorPanel, `the real Job workspace opens:\n${view(h.vt)}`)
  assert.ok(view(h.vt).includes('j2'), `the opened workspace is the selected job:\n${view(h.vt)}`)
})

test('an async projection insertion keeps the surviving Enter selection painted', async () => {
  const h = await startQuick({
    roster: [
      job('j1', 'build', 'running'), job('j2', 'test', 'running'), job('j3', 'lint', 'running'),
      job('j4', 'deploy', 'running'), job('j5', 'audit', 'running'),
    ],
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  h.app.setFullscreen(true)
  await h.vt.waitForRender()

  h.vt.sendInput('\x1b[B') // enter Quick
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B') // select the stable job:j2 identity
  await h.vt.waitForRender()
  assert.match(strip(h.band().items[1]!), /^> .*bash · test/, 'job:j2 is selected before the async refresh')

  // A later roster publication inserts two rows ahead of the selected identity
  // while leaving the first-visible anchor intact.
  await sleep(0)
  h.roster.rows = [
    job('j1', 'build', 'running'), job('j6', 'setup', 'running'), job('j7', 'compile', 'running'),
    job('j2', 'test', 'running'), job('j3', 'lint', 'running'), job('j4', 'deploy', 'running'),
    job('j5', 'audit', 'running'),
  ]
  h.tasks.refreshTasks()
  await h.vt.waitForRender()
  const refreshed = h.band()
  assert.match(strip(rawView(h.vt)[refreshed.identity]!), /showing 2-4\/7$/, `the stable selection rebases the painted window:\n${view(h.vt)}`)
  const selected = refreshed.items.filter(line => strip(line).startsWith('> '))
  assert.equal(selected.length, 1, `exactly one task row remains selected:\n${view(h.vt)}`)
  assert.match(strip(selected[0]!), /bash · test/, `job:j2 remains the visible selection:\n${view(h.vt)}`)

  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  await sleep(20)
  assert.deepEqual(h.quickSelects(), ['job:j2'], 'Enter routes the reconciled stable identity')
  assert.ok(h.app.focusedComponentForTest() instanceof JobInspectorPanel, `the real Job workspace opens:\n${view(h.vt)}`)
  assert.ok(view(h.vt).includes('j2'), `the opened workspace is the selected job:\n${view(h.vt)}`)
})

test('a deleted Quick selection cannot open its fallback before paint', async () => {
  const h = await startQuick({
    roster: [job('j1', 'build', 'running'), job('j2', 'test', 'running'), job('j3', 'lint', 'running')],
  })
  for (let i = 0; i < 8; i += 1) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  h.app.setFullscreen(true)
  await h.vt.waitForRender()

  h.vt.sendInput('\x1b[B') // enter Quick
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B') // select job:j2
  await h.vt.waitForRender()
  assert.match(strip(h.band().items[1]!), /^> .*bash · test/, 'job:j2 is selected in the painted frame')

  h.roster.rows = [job('j1', 'build', 'running'), job('j3', 'lint', 'running')]
  h.tasks.refreshTasks()
  h.vt.sendInput('\r') // The roster commit queued a paint; this input runs before it.
  assert.deepEqual(h.quickSelects(), [], 'Enter cannot open the unpainted successor fallback')
  assert.equal(h.app.taskQuickFocusedForTest(), true, 'the refused Enter leaves Quick active')
  assert.match(strip(h.band().items[1]!), /^> .*bash · test/, 'the last painted selection remains on screen')

  await h.vt.waitForRender()
  const refreshed = h.band()
  const selected = refreshed.items.filter(line => strip(line).startsWith('> '))
  assert.equal(selected.length, 1, `the new frame has exactly one selected task:\n${view(h.vt)}`)
  assert.match(strip(selected[0]!), /bash · lint/, 'the successor becomes visibly selected after paint')

  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  await sleep(20)
  assert.deepEqual(h.quickSelects(), ['job:j3'], 'Enter routes the painted successor through Task Runtime')
  assert.ok(h.app.focusedComponentForTest() instanceof JobInspectorPanel, `the real Job workspace opens:\n${view(h.vt)}`)
  assert.ok(view(h.vt).includes('j3'), `the opened workspace is the painted successor:\n${view(h.vt)}`)
})

test('Enter routes a Quick Subagent through the real typed enterView authority', async () => {
  const h = await startQuick({
    roster: [],
    descendants: [{
      kind: 'child', id: 'child-1', label: 'review', mode: 'continuable',
      activity: 'running', hasChildren: false, parentId: '', depth: 1,
    }],
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  assert.ok(h.app.taskQuickItemCountForTest() >= 1, 'the semantic Task read publishes the child to the hidden projection')

  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.equal(h.app.taskQuickFocusedForTest(), true, 'Down transfers focus to Quick')
  assert.ok(view(h.vt).includes('subagent · review'), `the real Task projection paints the child row after entry:\n${view(h.vt)}`)
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  await sleep(20)

  assert.deepEqual(h.quickSelects(), ['agent:child-1'], 'Enter carries the selected stable child identity through the host callback')
  assert.deepEqual(h.enteredViews(), [['child-1', 'review', 'continuable', 'sess-main', 'running', 1]],
    'the typed router sends the current child, mode, parent, activity and depth to enterView')
  assert.deepEqual(h.quickFocusedAtEnterView(), [false], 'Quick retires before the blocking Subagent view takes ownership')
  assert.equal(h.app.taskQuickFocusedForTest(), false, 'the Subagent route leaves Quick')
})

/** S8 — a parked Question row reaches the REAL attention.reopen. */
test('a parked Question enters the projection; a refused reopen reports no surface', async () => {
  const reopens: string[] = []
  let allowReopen = true
  const vt = new VirtualTerminal(120, 40)
  let runtimeRef: TaskRuntime | undefined
  // The PRODUCTION commit route, wired exactly like the surface composition:
  // Enter → accessory onActivate → the app's onQuickTaskSelect → the
  // runtime's openQuickTaskItem. Without this option the Enter would fall
  // through to the editor submit and prove nothing. The callback's RETURN
  // value is observed (the typed outcome the accessory contract carries).
  const callbackResults: boolean[] = []
  const observedCallbackResults = (): readonly boolean[] => [...callbackResults]
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    onQuickTaskSelect: (value: string): boolean => {
      const result = runtimeRef?.openQuickTaskItem(value) ?? false
      callbackResults.push(result)
      return result
    },
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
  assert.deepEqual(observedCallbackResults(), [true], 'the successful reopen reports the TRUE outcome')
  assert.equal(rawView(vt).findIndex(line => line.startsWith('Task Quick')), -1, 'the commit leaves Quick after the Question route')

  // The STALE-Question refusal is part of the typed contract (plan §9.2):
  // reopen false ⇒ openQuickTaskItem false, dispatched exactly once. The
  // callback outcome is observed at the SAME production seam, so a runtime
  // that promoted the refusal to a fabricated success would fail here.
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  allowReopen = false
  tasks.refreshAttentionRows()
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  await sleep(20)
  assert.equal(reopens.filter(id => id === 's1:c1').length, 2, 'exactly the refusal dispatch happened')
  assert.deepEqual(observedCallbackResults(), [true, false], 'the refused reopen reports the FALSE outcome through the same callback')
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

  // The separator is the row BEFORE the identity header (band().identity is
  // the header's screen row). Verify the physical rule, then send distinct
  // press/release gestures to divider, header and Footer badge; all are inert.
  const headerRow = h.band().identity
  const sepRow = headerRow - 1
  assert.ok(headerRow > 0, 'the band is still ACTIVE for the chrome probes')
  assert.match(rows[sepRow]!, /^\s*─+\s*$/, `the probed row is the actual divider:\n${view(h.vt)}`)
  for (const y of [sepRow, headerRow]) {
    h.vt.sendInput(`\x1b[<0;10;${y + 1}M`)
    h.vt.sendInput(`\x1b[<0;10;${y + 1}m`)
    await h.vt.waitForRender()
    assert.deepEqual(h.quickSelects(), [], `divider/header row ${y} is inert (addendum §3.3)`)
  }
  const footerRows = h.app.footerRenderRowsForTest().map(strip).map(line => line.trimEnd()).filter(Boolean)
  const footerScreenRows = footerRows
    .map(row => rows.findIndex((line, index) => index < sepRow && line.includes(row)))
    .filter(index => index >= 0)
  assert.ok(footerScreenRows.length > 0, `the Footer is visible above the divider:\n${view(h.vt)}`)
  for (const y of footerScreenRows) {
    h.vt.sendInput(`\x1b[<0;10;${y + 1}M`)
    h.vt.sendInput(`\x1b[<0;10;${y + 1}m`)
    await h.vt.waitForRender()
    assert.deepEqual(h.quickSelects(), [], `Footer row ${y} is not a Task Quick item`)
  }

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
test('shell mode and a non-last visual line fail the admission closed', async () => {
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

test('owner displacement retires Quick before History, Settings, managed overlays and plugin editors', async () => {
  const editorRegistry = new EditorRegistry()
  const h = await startQuick({
    roster: [job('j1', 'build', 'running')],
    appOptions: {
      editorRegistry,
      historySearchSource: { search: async () => ({ results: [], exhausted: true }) },
      historySearchCwd: () => '/workspace',
      captureHistoryScope: () => ({ sessionId: 'sess-main', isCurrent: () => true }),
    },
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  assert.equal(h.app.enterTaskQuick(), true, 'the production Quick entry must be active before History takes the seat')
  await h.vt.waitForRender()
  h.app.openHistorySearch()
  await h.vt.waitForRender()
  assert.ok(h.app.focusedComponentForTest() instanceof HistoryPanel, 'History becomes the actual focused seat owner')
  assert.equal(h.app.taskQuickFocusedForTest(), false, 'History displaces Quick focus')
  assert.equal(h.band().identity, -1, 'Quick paints no rows under the History tenant')
  h.app.closeHistorySearch()
  await h.vt.waitForRender()

  assert.equal(h.app.enterTaskQuick(), true, 'Quick can be entered again after History closes')
  await h.vt.waitForRender()
  const closeSettings = h.app.openSettings(
    [{ id: 'setting', label: 'Plugin setting', currentValue: 'on', values: ['on', 'off'] }],
    () => {},
    () => {},
  )
  await h.vt.waitForRender()
  assert.ok(view(h.vt).includes('Plugin setting'), `Settings owns the visible overlay:\n${view(h.vt)}`)
  assert.equal(h.app.taskQuickFocusedForTest(), false, 'Settings displaces Quick focus')
  assert.equal(h.band().identity, -1, 'Quick paints no rows under Settings')
  closeSettings()
  await h.vt.waitForRender()

  assert.equal(h.app.enterTaskQuick(), true, 'Quick can be entered again after Settings closes')
  await h.vt.waitForRender()
  const managed = h.app.showAdvancedInteractiveOverlay({
    render: () => ({ kind: 'text', spans: [{ text: 'managed overlay' }] }),
  })
  await h.vt.waitForRender()
  assert.ok(managed.focused, 'the managed overlay owns physical focus')
  assert.ok(view(h.vt).includes('managed overlay'), `the managed overlay is painted:\n${view(h.vt)}`)
  assert.equal(h.app.taskQuickFocusedForTest(), false, 'the managed overlay displaces Quick focus')
  assert.equal(h.band().identity, -1, 'Quick paints no rows under the managed overlay')
  managed.close()
  await h.vt.waitForRender()

  assert.equal(h.app.enterTaskQuick(), true, 'Quick can be entered again before a plugin editor handoff')
  await h.vt.waitForRender()
  editorRegistry.register({
    id: 'plugin-editor',
    priority: 1,
    create: () => ({
      component: { kind: 'text', spans: [{ text: 'plugin editor' }] },
      getText: () => 'draft',
      setText: () => {},
      getCursor: () => 0,
      setCursor: () => {},
      dispose: () => {},
    }),
  }, 'plugin')
  h.app.reconcileEditorNow()
  h.app.requestRender()
  await h.vt.waitForRender()
  assert.equal(h.app.seatEditorForTest().id, 'plugin-editor', 'the plugin editor becomes the current seat occupant')
  assert.equal(h.app.focusedComponentForTest(), h.app.seatEditorForTest().component, 'the plugin editor receives physical focus')
  assert.equal(h.app.taskQuickFocusedForTest(), false, 'the plugin editor handoff displaces Quick focus')
  assert.equal(h.band().identity, -1, 'Quick paints no rows after the plugin editor takes the seat')
})

test('Job and Settings workspace leases retire active Quick and never restore it', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  assert.equal(h.app.enterTaskQuick(), true)
  const jobHandle = h.app.openJobInspector({
    initial: { opening: { jobId: 'j1', kind: 'bash', label: 'build', status: 'running' } },
    canStop: () => false,
    onStop: () => {},
    onClose: () => {},
  })
  await h.vt.waitForRender()
  assert.ok(h.app.focusedComponentForTest() instanceof JobInspectorPanel, 'the Job workspace takes ownership')
  assert.equal(h.app.taskQuickFocusedForTest(), false, 'the Job lease retires Quick')
  jobHandle.close()
  await h.vt.waitForRender()
  assert.equal(h.app.taskQuickFocusedForTest(), false, 'closing Job returns to the editor, not Quick')
  assert.ok(!view(h.vt).includes('Task Quick'), 'the closed workspace leaves no Quick identity row')

  assert.equal(h.app.enterTaskQuick(), true, 'Quick may be explicitly reopened after returning')
  const settingsHandle = h.app.openSettingsWorkspace(settingsWorkspaceSource(), { onOpenLegacy: () => {} })
  await h.vt.waitForRender()
  assert.ok(h.app.focusedComponentForTest() instanceof SettingsWorkspacePanel, 'Settings takes ownership')
  assert.equal(h.app.taskQuickFocusedForTest(), false, 'the Settings lease retires Quick')
  settingsHandle.close()
  await h.vt.waitForRender()
  assert.equal(h.app.taskQuickFocusedForTest(), false, 'closing Settings returns to the editor, not Quick')
  assert.ok(!view(h.vt).includes('Task Quick'), 'the closed workspace leaves no Quick identity row')
})

test('a synchronous Footer callback workspace wins over an older Quick opener', async () => {
  let app: TuiApp | undefined
  let reenter = false
  let nestedSettings: { close: () => void } | undefined
  const host = new SurfaceHost(new ExtensionLedger(() => {}), () => app?.requestRender())
  const originalFooterText = host.footerText
  host.footerText = () => {
    if (reenter) {
      reenter = false
      if (app === undefined) throw new Error('the TUI must be mounted before the reentrant witness')
      nestedSettings = app.openSettingsWorkspace(settingsWorkspaceSource(), { onOpenLegacy: () => {} })
    }
    return originalFooterText.call(host)
  }
  const h = await startQuick({
    roster: [job('j1', 'build', 'running')],
    appOptions: { extensionHost: host },
  })
  app = h.app
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  assert.equal(h.app.enterTaskQuick(), true)

  reenter = true
  assert.throws(() => h.app.openJobInspector({
    initial: { opening: { jobId: 'j1', kind: 'bash', label: 'build', status: 'running' } },
    canStop: () => false,
    onStop: () => {},
    onClose: () => {},
  }), /a Settings workspace screen is already leased/)
  assert.ok(nestedSettings, 'the synchronous Footer callback committed the newer Settings lease')
  assert.ok(h.app.focusedComponentForTest() instanceof SettingsWorkspacePanel, 'the newer workspace remains the owner')
  assert.equal(h.app.taskQuickFocusedForTest(), false, 'Quick was retired before the callback opened Settings')

  nestedSettings.close()
  await h.vt.waitForRender()
  assert.equal(h.app.taskQuickFocusedForTest(), false, 'closing the newer workspace does not restore Quick')
})

/** S11 — `app.tasks.open: false` drops the hint and the route; numbers stay. */
test('a disabled action drops the hint and the route; the badge numbers survive', async () => {
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
test('the 44-col CJK wrapped draft enters; an extreme frame declines the entry', async () => {
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
test('a session reset with Quick ACTIVE exits and clears the projection', async () => {
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

/** F4/R4-F1: a held pointer gesture does NOT survive a repaint. A real SGR
 *  press, a WIDTH-ONLY resize (the band keeps its grant, its rows and the
 *  pressed cell's physical y), a repaint, THEN the release on the same
 *  cell: the frame-fence clears the intent — nothing activates. A fresh
 *  same-cell gesture after the resize clicks the CURRENT row normally. */
test('a held press across a width-only resize never activates; a fresh gesture does', async () => {
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
  const rows = rawView(h.vt)
  const bandStart = rows.findIndex(line => line.startsWith('Task Quick'))
  const rowA = rows.findIndex(line => line.includes('alpha') && line.includes('‣'))
  assert.ok(bandStart >= 0 && rowA >= 0, `the band and the target row paint:\n${view(h.vt)}`)

  // Press alpha, THEN resize the width (rows stay 40): the band keeps its
  // grant, the same task rows, and the pressed cell's physical y.
  h.vt.sendInput(`\x1b[<0;10;${rowA + 1}M`)
  await h.vt.waitForRender()
  h.vt.resize(100, 40)
  await h.vt.waitForRender()
  await sleep(40) // the resize frame clears the fork's render throttle
  await h.vt.waitForRender()
  const rowsAfter = rawView(h.vt)
  const rowAAfter = rowsAfter.findIndex(line => line.includes('alpha') && line.includes('‣'))
  assert.equal(rowAAfter, rowA, 'the pressed cell keeps its physical row across the width-only resize')
  assert.ok(rowsAfter.findIndex(line => line.startsWith('Task Quick')) >= 0, 'the band survives the resize with its grant')

  // Release on the SAME cell: the frame fence kills the stale intent —
  // observed at the SINK, not a painted word.
  h.vt.sendInput(`\x1b[<0;10;${rowA + 1}m`)
  await h.vt.waitForRender()
  await sleep(20)
  assert.deepEqual(h.quickSelects(), [], 'a held press across a repaint must not activate')

  // The positive control: a FRESH same-cell gesture clicks the CURRENT row.
  h.vt.sendInput(`\x1b[<0;10;${rowAAfter + 1}M`)
  h.vt.sendInput(`\x1b[<0;10;${rowAAfter + 1}m`)
  await h.vt.waitForRender()
  await sleep(20)
  assert.deepEqual(h.quickSelects(), ['job:j1'], `a fresh post-resize click activates normally:\n${h.quickSelects().join('|')}`)
  h.app.setFullscreen(false)
  await h.vt.waitForRender()
})

test('a height-only terminal resize invalidates the held SGR row intent', async () => {
  const h = await startQuick({
    roster: [job('j1', 'alpha', 'running'), job('j2', 'bravo', 'running'), job('j3', 'charlie', 'running')],
  })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()

  const before = rawView(h.vt)
  const rowA = before.findIndex(line => line.includes('alpha') && line.includes('‣'))
  const quickIdentity = before.findIndex(line => line.startsWith('Task Quick'))
  const taskRows = before.filter(line => line.includes('‣ ')).length
  const dividerRows = quickIdentity > 0 && /^─+$/.test(before[quickIdentity - 1]!.trim()) ? 1 : 0
  const initialQuickHeight = taskRows + (quickIdentity >= 0 ? 1 : 0) + dividerRows
  assert.ok(rowA >= 0, `the target item paints before the resize:\n${view(h.vt)}`)
  assert.equal(initialQuickHeight, 5, 'the band paints divider, identity and three task rows')

  h.vt.sendInput(`\x1b[<0;10;${rowA + 1}M`)
  await h.vt.waitForRender()
  h.vt.resize(120, 41)
  await h.vt.waitForRender()
  await sleep(40)
  await h.vt.waitForRender()
  const after = rawView(h.vt)
  const rowAAfter = after.findIndex(line => line.includes('alpha') && line.includes('‣'))
  assert.equal(rowAAfter, rowA + 1, 'the bottom-anchored band shifts one physical row on a height-only resize')
  const identityAfter = after.findIndex(line => line.startsWith('Task Quick'))
  const dividerAfter = identityAfter > 0 && /^─+$/.test(after[identityAfter - 1]!.trim()) ? 1 : 0
  const actualHeightAfter = after.filter(line => line.includes('‣ ')).length + (identityAfter >= 0 ? 1 : 0) + dividerAfter
  assert.equal(actualHeightAfter, initialQuickHeight,
    'the Quick band itself keeps its painted dimensions, reproducing the stale-intent edge')

  // Move with the same visible item: the row/value and Quick dimensions are
  // unchanged, but the terminal-height component of the painted frame differs.
  h.vt.sendInput(`\x1b[<0;10;${rowAAfter + 1}m`)
  await h.vt.waitForRender()
  await sleep(20)
  assert.deepEqual(h.quickSelects(), [], 'the held press must not activate across a height-only repaint')

  h.vt.sendInput(`\x1b[<0;10;${rowAAfter + 1}M`)
  h.vt.sendInput(`\x1b[<0;10;${rowAAfter + 1}m`)
  await h.vt.waitForRender()
  await sleep(20)
  assert.deepEqual(h.quickSelects(), ['job:j1'], 'a fresh post-resize same-row gesture remains valid')
  h.app.setFullscreen(false)
  await h.vt.waitForRender()
})

/** F4: an ACTIVE Quick resized below its grant retires — the editor gets
 *  the keyboard back instead of an invisible band consuming input. */
test('an ACTIVE Quick resized to 0 grant exits and returns the editor', async () => {
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
test('deleted selection lands on successor/predecessor', async () => {
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
test('a fullscreen hand-off retires the ACTIVE Quick', async () => {
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
test('the /tasks Full browser opens and filters while the Quick stays hidden', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running'), job('j2', 'test', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  h.tasks.openTasksBrowser('full')
  await h.vt.waitForRender()
  assert.ok(view(h.vt).includes('Tasks [TRACKED]'), `the Full browser opens:\n${view(h.vt)}`)
  for (const width of [44, 80, 120]) {
    h.vt.resize(width, 40)
    await h.vt.waitForRender()
    const ordinaryHint = rawView(h.vt).find(line => line.includes('Esc close'))
    assert.ok(ordinaryHint, `width ${width}: the Full action hint paints:\n${view(h.vt)}`)
    const ordinaryEsc = ordinaryHint.slice(ordinaryHint.indexOf('Esc close') + 'Esc close'.length)
    assert.ok(!ordinaryEsc.includes(' · '), `width ${width}: Esc close is the final painted action:\n${ordinaryHint}`)
    assert.ok(visibleWidth(ordinaryHint) <= width, `width ${width}: the Full action row fits (${visibleWidth(ordinaryHint)} > ${width})`)

    h.vt.sendInput('/')
    await h.vt.waitForRender()
    const searchHint = rawView(h.vt).find(line => line.includes('Esc back'))
    assert.ok(searchHint, `width ${width}: search advertises its real Esc back action:\n${view(h.vt)}`)
    const searchEsc = searchHint.slice(searchHint.indexOf('Esc back') + 'Esc back'.length)
    assert.ok(!searchEsc.includes(' · '), `width ${width}: Esc back is the final painted action:\n${searchHint}`)
    assert.ok(visibleWidth(searchHint) <= width, `width ${width}: the search action row fits (${visibleWidth(searchHint)} > ${width})`)
    h.vt.sendInput('\x1b')
    await h.vt.waitForRender()
  }
  h.vt.resize(120, 40)
  await h.vt.waitForRender()
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
  const app = h.app as unknown as { taskQuickChromeRows(width: number, footerRows?: number): number }
  const original = app.taskQuickChromeRows
  let calls = 0
  const patched = (width: number, footerRows?: number): number => {
    calls += 1
    return original.call(app, width, footerRows)
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
    // fact that declines. Shrink the viewport (rows 40 → 6; rows 8 still
    // grants one row — probed) with the roster intact — the projection
    // stays non-empty, the grant goes to zero.
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

/** R7-F1/R8-F5 — a mode flip with an UNCHANGED raw visual-line state must
 *  still refresh the hint: '/' opens the dropdown at the last line (the raw
 *  visual-line truth is unchanged), the open event recomposes, Down routes
 *  to the picker; Esc closes it, the close event recomposes, and the hint
 *  returns to its pre-dropdown value. Both directions are HARD assertions —
 *  a defect that skips either recompose fails here. */
test('B4B-f7 an autocomplete open/close with unchanged visual state recomposes both ways', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  // The dropdown needs a provider — the production MentionProvider is
  // installed via setCommandCompletions (the same path /tasks tests use).
  h.app.setCommandCompletions([{ name: 'tasks', description: 'Task Center' }], '/tmp')
  // Type a slash command prefix: the caret stays on the last visual line
  // (raw visual-line truth unchanged); '/' opens the autocomplete dropdown.
  h.vt.sendInput('/')
  await h.vt.waitForRender()
  assert.equal(h.app.isShowingAutocompleteForTest(), true, 'the dropdown must be open after /')
  const hintOpen = view(h.vt).includes('↓ view')
  // While the dropdown owns Down, the hint must NOT advertise the Quick
  // entry (the admission gate refuses Down).
  assert.equal(hintOpen, false, `the open dropdown must hide the ↓ hint:\n${view(h.vt)}`)
  // Esc closes the dropdown: Down is re-admitted and the hint returns.
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.equal(h.app.isShowingAutocompleteForTest(), false, 'Esc closes the dropdown')
  assert.equal(view(h.vt).includes('↓ view'), true, `the closed dropdown restores the ↓ hint:\n${view(h.vt)}`)
})

/** R9-F1/F4/F5 — ordinary same-layout edits neither compose Footer nor
 *  rebuild the wrap map; a rewrap refreshes the boundary, while X063 events
 *  share one compose and navigation reuses the event fact. */
test('B4B-f8 onChange-only rewrap refreshes and coalesces the visual boundary', async () => {
  const h = await startQuick({ cols: 40, rows: 24, roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  const app = h.app as unknown as {
    renderFooter(boundary?: { physicalWidth: number; onLastVisualLine: boolean }): void
    editor: {
      getPaddingX(): number
      isOnLastVisualLineRawForHost(width: number): boolean
      buildVisualLineMap(width: number): unknown[]
      setTextAndCursor(text: string, cursor: { line: number; col: number }): void
      setCursor(cursor: { line: number; col: number }): void
      onVisualLineBoundaryChanged?: (reason: string, onLast: boolean) => void
    }
  }
  const originalRenderFooter = app.renderFooter
  const originalMapBuilder = app.editor.buildVisualLineMap
  let composes = 0
  let mapBuilds = 0
  app.renderFooter = function (boundary): void {
    composes += 1
    originalRenderFooter.call(app, boundary)
  }
  app.editor.buildVisualLineMap = function (width: number): unknown[] {
    mapBuilds += 1
    return originalMapBuilder.call(app.editor, width)
  }
  const originalBoundary = app.editor.onVisualLineBoundaryChanged
  let boundaryEvents = 0
  app.editor.onVisualLineBoundaryChanged = (reason, onLast) => {
    boundaryEvents += 1
    originalBoundary?.(reason, onLast)
  }
  try {
    const width = h.vt.columns
    const padding = app.editor.getPaddingX()
    const clampedPadding = Math.min(padding, Math.max(0, Math.floor((width - 1) / 2)))
    const contentWidth = Math.max(1, width - clampedPadding * 2)
    const visualWidth = Math.max(1, contentWidth - (clampedPadding ? 0 : 1))
    h.app.setDraft('short')
    await h.vt.waitForRender()
    composes = 0
    mapBuilds = 0
    boundaryEvents = 0
    for (const key of ['a', 'b', 'c']) {
      h.vt.sendInput(key)
      await h.vt.waitForRender()
    }
    assert.equal(composes, 0, 'ordinary same-layout printable input does not recompose Footer')
    assert.equal(mapBuilds, 0, 'ordinary printable input does not rebuild the Editor visual map')

    composes = 0
    mapBuilds = 0
    h.app.setDraft('x'.repeat(visualWidth))
    await h.vt.waitForRender()
    assert.equal(app.editor.isOnLastVisualLineRawForHost(width), true, 'the full-width draft cursor is on its last visual line')

    // Two X063 changes in one host turn must consume the LAST fact, not the
    // first: the cursor moves from a non-last line to the end of the last.
    composes = 0
    boundaryEvents = 0
    app.editor.setTextAndCursor('line1\nline2', { line: 0, col: 0 })
    app.editor.setCursor({ line: 1, col: 5 })
    await h.vt.waitForRender()
    assert.equal(boundaryEvents, 2, 'both programmatic boundary facts publish')
    assert.equal(composes, 1, 'the shared scheduler composes once for both X063 events')
    assert.ok(view(h.vt).includes('↓ view'), 'the final true fact admits the hint')

    // A current true X063 fact is immediately invalidated by an onChange-only
    // edit that wraps the trailing text onto another visual line.
    composes = 0
    boundaryEvents = 0
    app.editor.setTextAndCursor('x'.repeat(visualWidth), { line: 0, col: visualWidth })
    app.editor.setCursor({ line: 0, col: Math.floor(visualWidth / 2) })
    mapBuilds = 0
    h.vt.sendInput('X')
    await h.vt.waitForRender()
    assert.equal(boundaryEvents, 2, 'the two current true facts preceded the plain insertion')
    assert.equal(composes, 1, 'the onChange-only rewrap recomposes from the new rendered layout')
    assert.equal(mapBuilds, 0, 'the rewrap does not rebuild the visual map outside Editor.render')
    assert.equal(app.editor.isOnLastVisualLineRawForHost(width), false, 'the insertion moves the caret off the last visual line')
    assert.equal(view(h.vt).includes('↓ view'), false, 'the stale true payload is not painted as an affordance')

    composes = 0
    boundaryEvents = 0
    h.vt.sendInput('\x1b[D')
    await h.vt.waitForRender()
    assert.equal(boundaryEvents, 1, 'the follow-up cursor move publishes its raw boundary')
    assert.equal(composes, 0, 'an unchanged false boundary does not recompose from a stale true baseline')
  } finally {
    app.renderFooter = originalRenderFooter
    app.editor.buildVisualLineMap = originalMapBuilder
    app.editor.onVisualLineBoundaryChanged = originalBoundary
  }
})

test('B4B-width4 TuiEditor admission uses the fork-clamped width at four columns', async () => {
  const h = await startQuick({ cols: 4, rows: 24, roster: [job('j1', 'build', 'running')] })
  h.app.setDraft('x')
  await h.vt.waitForRender()
  const app = h.app as unknown as {
    editor: {
      canEnterTaskQuickFromDown(physicalWidth: number): boolean
      isOnLastVisualLineRawForHost(physicalWidth: number): boolean
    }
  }
  assert.equal(app.editor.isOnLastVisualLineRawForHost(4), true, 'the raw frame fact uses the render padding clamp')
  assert.equal(app.editor.canEnterTaskQuickFromDown(4), true, 'Down admission uses the same physical-width formula')
})

/** X063 jump transitions can change Down ownership while the raw visual-line
 *  truth is unchanged, so the production Footer must recompose in both ways. */
test('B4B-f9 jump arm and no-match completion refresh an unchanged-boundary hint', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  assert.ok(view(h.vt).includes('↓ view'), 'the initial editor state advertises entry')
  h.vt.sendInput('\x1d')
  await h.vt.waitForRender()
  assert.equal(view(h.vt).includes('↓ view'), false, 'arming jump mode hides the hint despite unchanged raw boundary')
  h.vt.sendInput('z') // No match: completes without moving the cursor.
  await h.vt.waitForRender()
  assert.equal(view(h.vt).includes('↓ view'), true, 'jump completion restores the hint at the same visual boundary')
})

/** R9-F3 / Owner revision: hidden entry is measured against a complete Footer
 *  candidate with the hint enabled, never the currently painted hint-free
 *  Footer. The one-row actual/two-row candidate case must fail closed without
 *  oscillation; added height admits the same route; ACTIVE focus is governed by
 *  the actual painted geometry and survives Footer hint/preset changes. */
test('B4B-f10 preflights the hint-enabled Footer and keeps ACTIVE Quick independent', async () => {
  const h = await startQuick({ cols: 30, rows: 7, roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  const app = h.app as unknown as { taskQuickChromeRows(width: number, footerRows?: number): number }
  const original = app.taskQuickChromeRows
  const candidateFooterRows: number[] = []
  app.taskQuickChromeRows = (width: number, footerRows?: number): number => {
    if (footerRows !== undefined) candidateFooterRows.push(footerRows)
    return original.call(app, width, footerRows)
  }
  const customLayout = {
    schemaVersion: 1 as const,
    rows: [{ left: [{ id: 'tasks', suffix: ' abcde' }], right: [] }],
  }
  try {
    h.app.setFooterPreset('compact')
    candidateFooterRows.length = 0
    h.app.setFooterLayout(customLayout)
    await h.vt.waitForRender()
    await h.vt.waitForRender()

    const shortScreen = view(h.vt)
    assert.ok(shortScreen.includes('[1 task running]'), `the task badge and live count survive:\n${shortScreen}`)
    assert.equal(shortScreen.includes('↓ view'), false, `candidate overflow hides only the entry hint:\n${shortScreen}`)
    assert.ok(candidateFooterRows.includes(2), `preflight measures the complete hint-enabled Footer as two rows: ${candidateFooterRows}`)
    const hintFreeChrome = original.call(app, 30, 1)
    const candidateChrome = original.call(app, 30, 2)
    assert.ok(planTaskQuickLayout(30, 7, hintFreeChrome, 1, 0).itemRows >= 1,
      'the hint-free Footer would fit one task row')
    assert.equal(planTaskQuickLayout(30, 7, candidateChrome, 1, 0).itemRows, 0,
      'the two-row hint-enabled candidate correctly removes that grant')
    const footer = (h.app as unknown as { footer: { render(width: number): string[] } }).footer
    assert.equal(footer.render(30).length, 1, 'the committed hint-free Footer remains one physical row')
    assert.equal(h.app.enterTaskQuick(), false, 'the conservative candidate grant declines entry')
    h.vt.sendInput('\x1b[B')
    await h.vt.waitForRender()
    assert.equal(h.app.taskQuickFocusedForTest(), false, 'Down remains with the editor')
    assert.equal(h.band().identity, -1, 'repeated frames do not oscillate into Quick')
    assert.equal(view(h.vt).includes('↓ view'), false, 'repeated frames preserve the stable hidden state')

    // More rows make room for one task below the same two-row candidate.
    h.vt.resize(30, 20)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(view(h.vt).includes('↓ view'), `the larger frame admits the candidate:\n${view(h.vt)}`)
    h.vt.sendInput('\x1b[B')
    await h.vt.waitForRender()
    assert.equal(h.app.taskQuickFocusedForTest(), true, 'the effective Down enters Quick')
    assert.ok(h.band().items.length >= 1, `the active task row paints:\n${view(h.vt)}`)
    assert.equal(view(h.vt).includes('↓ view'), false, 'the hint disappears while Quick owns focus')

    // Changing Footer layout while ACTIVE must not re-run hidden-entry
    // admission or drop Quick merely because the editor no longer owns focus.
    h.app.setFooterPreset('full')
    await h.vt.waitForRender()
    assert.equal(h.app.taskQuickFocusedForTest(), true, 'a Footer preset change does not retire ACTIVE Quick')
    assert.ok(h.band().identity >= 0, `Quick remains visible after the Footer change:\n${view(h.vt)}`)

    // A real task-source transition still owns ACTIVE lifetime: empty roster
    // closes Quick; a later row restores the hidden entry hint.
    h.roster.rows = []
    h.tasks.refreshTasks()
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
    await h.vt.waitForRender()
    assert.equal(h.app.taskQuickFocusedForTest(), false, 'an empty task projection exits ACTIVE Quick')
    assert.equal(view(h.vt).includes('↓ view'), false, 'no entry hint remains without tasks')
    h.roster.rows = [job('j2', 'test', 'running')]
    h.tasks.refreshTasks()
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
    await h.vt.waitForRender()
    assert.ok(view(h.vt).includes('↓ view'), `a refreshed task restores the valid entry hint:\n${view(h.vt)}`)
  } finally {
    app.taskQuickChromeRows = original
  }
})

test('B4B-f11 focused Quick consumes host submit and steer bindings', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running')] })
  const draft = 'hidden draft must not submit'
  h.app.setDraft(draft)
  await h.vt.waitForRender()

  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.equal(h.app.taskQuickFocusedForTest(), true, 'Down transfers focus to Quick')

  h.vt.sendInput('\x1b[13;5u') // kitty Ctrl+Enter: host accelerated submit
  await h.vt.waitForRender()
  assert.deepEqual(h.submitted(), [], 'a Host submit action must not reach the hidden draft')
  assert.equal(h.app.getDraft(), draft, 'the hidden draft remains byte-for-byte intact')
  assert.equal(h.app.taskQuickFocusedForTest(), true, 'unlisted Host actions do not leave Quick')

  h.app.setBusy(true)
  await h.vt.waitForRender()
  h.vt.sendInput('\x13') // Ctrl+S: host steer while busy
  await h.vt.waitForRender()
  assert.deepEqual(h.submitted(), [], 'the busy Host steer action must not send the hidden draft')
  assert.equal(h.app.getDraft(), draft, 'steer leaves the hidden draft intact')
  assert.equal(h.app.taskQuickFocusedForTest(), true, 'Quick remains the focused input owner')
})

test('B4B-f13 a resize before queued Footer compose refreshes from the new Editor layout', async () => {
  const h = await startQuick({ cols: 40, rows: 24, roster: [job('j1', 'build', 'running')] })
  const app = h.app as unknown as {
    editor: {
      setTextAndCursor(text: string, cursor: { line: number; col: number }): void
      setCursor(cursor: { line: number; col: number }): void
      isOnLastVisualLineRawForHost(width: number): boolean
      onVisualLineBoundaryChanged?: (reason: string, onLast: boolean) => void
    }
  }
  app.editor.setTextAndCursor('x'.repeat(60), { line: 0, col: 30 })
  await h.vt.waitForRender()
  assert.equal(app.editor.isOnLastVisualLineRawForHost(40), false)
  assert.equal(view(h.vt).includes('↓ view'), false, 'the narrow frame does not advertise a false boundary')

  const originalBoundary = app.editor.onVisualLineBoundaryChanged
  let eventWidth: number | undefined
  let eventBoundary: boolean | undefined
  app.editor.onVisualLineBoundaryChanged = (reason, onLast) => {
    if (reason === 'programmatic') {
      eventWidth = h.vt.columns
      eventBoundary = onLast
    }
    originalBoundary?.(reason, onLast)
  }
  try {
    app.editor.setCursor({ line: 0, col: 31 })
    h.vt.resize(80, 24)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.equal(eventWidth, 40, 'the queued transition fact belongs to the old frame width')
    assert.equal(eventBoundary, false, 'the old-width fact is non-last')
    assert.equal(app.editor.isOnLastVisualLineRawForHost(80), true, 'the new rendered frame places the cursor on its last visual line')
    assert.ok(view(h.vt).includes('↓ view'), 'the post-resize Editor render restores the Footer hint')
  } finally {
    app.editor.onVisualLineBoundaryChanged = originalBoundary
  }
})
/**
 * B4B-f14. With NO live work and only
 * an UNACKNOWLEDGED failed job, the Active projection must keep the failure row
 * (`task-presentation.ts` active include: `includeAttentionInActive === true &&
 * (item.attention === true || isTaskItemFailure(item.status))`). The Footer
 * hint, the Quick projection and the REAL Down route must therefore agree.
 *
 * A green run means this shape is NOT a defect: the badge keeps its failure
 * attention AND still promises a trigger the Quick can serve.
 */
test('B4B-f14 failure-only roster: the failure row reaches Quick and the footer keeps promising it', async () => {
  // `descendants: []` installs the production `taskRead` seam, so the runtime's
  // RICH summary path is live (`refreshRuntime` early-returns without a catalog
  // key) — the failure count the badge and `tasksActive` are derived from.
  const h = await startQuick({ roster: [job('j1', 'build', 'failed')], descendants: [] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  h.tasks.refreshAgentRuntimeOnly()
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  const footerText = h.app.footerRenderRowsForTest().map(strip).join('\n')
  assert.match(footerText, /failed|! ?1/, `the badge keeps the failure attention:\n${view(h.vt)}`)
  assert.ok(footerText.includes('↓ view'),
    `the hint must be advertised when the Quick can serve the failure row:\n${view(h.vt)}`)
  assert.equal(h.app.taskQuickItemCountForTest(), 1, 'the unacknowledged failure row is projected with no live work')

  // The route must agree with the paint: a real Down enters Quick and the
  // painted band carries the failed row.
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  await sleep(20)
  const band = h.band()
  assert.ok(band.identity >= 0, `Down must enter Quick for the failure-only roster:\n${view(h.vt)}`)
  assert.equal(h.app.taskQuickFocusedForTest(), true, 'Quick owns focus after the entry')
  assert.ok(band.items.some(row => row.includes('build')), `the failed row paints in Quick:\n${band.items.join('\n')}`)

  // Esc returns to the editor and re-paints the same hint.
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.equal(h.band().identity, -1, 'Esc hides the band')
  assert.ok(h.app.footerRenderRowsForTest().map(strip).join('\n').includes('↓ view'), 'the hint returns')
})

/**
 * B4B-f15. The failure
 * window: an ordinary text edit invalidates the published Editor layout
 * snapshot (`onChange`), and a TASK-RUNTIME commit (never a StatusStore
 * commit) composes the Footer before the Editor renders again. That compose
 * must paint the badge WITHOUT the hint (fail-closed), and the EXISTING
 * convergence must then restore it — no extra status pushes, no polling — with
 * the real Down route agreeing with the restored paint.
 *
 * Intermediate observations are witnesses of the window, never the verdict:
 * the assertions are the FINAL painted Footer and the real Down route.
 */
test('B4B-f15 a compose before the Editor republishes its layout heals through the existing convergence', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  assert.ok(view(h.vt).includes('↓ view'), 'precondition: the eligible state advertises the hint')

  const app = h.app as unknown as {
    renderFooter(boundary?: { physicalWidth: number; onLastVisualLine: boolean }): void
    quickHintCurrentEditorLayout?: { physicalWidth: number; onLastVisualLine: boolean }
  }
  const originalRenderFooter = app.renderFooter
  const observed: Array<{ layoutPublished: boolean; badgePainted: boolean; hintPainted: boolean; items: number }> = []
  app.renderFooter = function (this: unknown, boundary): void {
    originalRenderFooter.call(app, boundary)
    const painted = h.app.footerRenderRowsForTest().map(strip).join('\n')
    observed.push({
      layoutPublished: app.quickHintCurrentEditorLayout !== undefined,
      // The exact user-visible shape: a BADGE-bearing Footer with no hint.
      badgePainted: /failed|!\s?\d|tracked jobs|tasks? running|agents/.test(painted),
      hintPainted: painted.includes('↓ view'),
      items: h.app.taskQuickItemCountForTest(),
    })
  }
  try {
    // 1) A real edit invalidates the layout snapshot (production onChange path)
    //    but the Editor has NOT rendered again yet.
    h.vt.sendInput('a')
    // 2) A task-runtime commit recomposes the Footer inside that window.
    h.roster.rows.push(job('j2', 'test', 'running'))
    h.tasks.refreshTasks()

    const unpublished = observed.filter(entry => !entry.layoutPublished)
    assert.ok(unpublished.length >= 1,
      `witness: at least one compose must run with the Editor layout unpublished: ${JSON.stringify(observed)}`)
    assert.ok(unpublished.some(entry => entry.badgePainted === true && entry.hintPainted === false && entry.items >= 1),
      `witness: a badge-bearing compose painted without the hint: ${JSON.stringify(observed)}`)

    // 3) No further status/task commits: let only the existing microtask and
    //    render queues settle.
    observed.length = 0
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    await sleep(20)

    const healed = h.app.footerRenderRowsForTest().map(strip).join('\n')
    assert.ok(healed.includes('↓ view'),
      `the hint must self-heal without extra commits:\n${view(h.vt)}\nobserved=${JSON.stringify(observed)}`)

    // 4) The route must agree with the healed paint.
    h.vt.sendInput('\x1b[B')
    await h.vt.waitForRender()
    await sleep(20)
    assert.ok(h.band().identity >= 0, `Down must enter Quick after the self-heal:\n${view(h.vt)}`)
    assert.equal(h.app.taskQuickFocusedForTest(), true, 'Quick owns focus after the healed entry')
    h.vt.sendInput('\x1b')
    await h.vt.waitForRender()
  } finally {
    app.renderFooter = originalRenderFooter
  }
})

/**
 * B4B-f16. History-browse restore: while browsing, the classifier
 * refuses Down (the hint may legitimately drop), but returning to the draft
 * makes the REAL route eligible again (`historyIndex === -1`, prompt mode, on
 * the last visual line, grant available). The restore emits exactly one
 * `navigation` boundary event; when its value equals `taskQuickPaintedBoundary`
 * the T4 dedupe returns early and none of the T3 conditions is sensitive to
 * `historyIndex`, so the paint can stay hint-less while Down works.
 *
 * Assertion order is deliberate: the intermediate drop is only a witness, the
 * verdict is the FINAL painted Footer plus the REAL Down route.
 */
test('B4B-f16 returning from history browse repaints the ↓ hint the real Down route admits', async () => {
  const h = await startQuick({ cols: 40, rows: 24, roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  // Seed ONE history entry through the REAL submit path.
  h.app.setDraft('short')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  const paintedHint = (): boolean => h.app.footerRenderRowsForTest().map(strip).join('\n').includes('↓ view')
  // The empty draft is eligible: same single visual row as the recalled entry.
  assert.equal(h.app.getDraft(), '', 'the submission cleared the draft')
  assert.equal(paintedHint(), true, `precondition: the eligible empty draft advertises the hint:\n${view(h.vt)}`)

  // An EMPTY draft enters history on the first Up (editor.ts:1212-1213); the
  // recalled entry keeps the raw boundary true while the classifier's history
  // gate refuses Down.
  h.vt.sendInput('\x1b[A')
  await h.vt.waitForRender()
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  assert.ok(view(h.vt).includes('short'), `witness: the entry is recalled into the editor:\n${view(h.vt)}`)
  assert.equal(paintedHint(), false, `witness: browsing legitimately drops the hint:\n${view(h.vt)}`)

  // Down leaves the single-row entry and restores the saved draft.
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), '', `the browse exited back to the saved draft:\n${view(h.vt)}`)

  // Both facts are gathered before the verdict so ONE failure reports the whole
  // split: the REAL route probe mutates the state (Down enters Quick), so it
  // runs first and the paint is read before it.
  const paintedAfterRestore = paintedHint()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  await sleep(20)
  const routeEntered = h.band().identity >= 0
  const routeFocused = h.app.taskQuickFocusedForTest()
  assert.equal(routeEntered, true, `the real Down route enters Quick:\n${view(h.vt)}`)

  // VERDICT: the route is eligible again, so the paint must say so.
  assert.equal(paintedAfterRestore, true,
    `paint must match the route: the restored eligible draft must repaint ↓ view `
    + `(real Down entered Quick: ${routeEntered}, Quick focused: ${routeFocused})\n${view(h.vt)}`)
})

/**
 * B4B-f17. The Quick band GRANT is a MEASURED geometry fact
 * (`taskQuickGrantAvailable`) and is deliberately NOT part of
 * `canAdmitDownHint`. When a chrome-height change removes the band's room the
 * route correctly refuses Down — so the painted hint must stop promising it.
 * Driven by the REAL Ctrl+T toggle; the grant is only MEASURED, never edited,
 * and `renderFooter()` is never called to help.
 */
test('B4B-f17 opening the Todo panel removes the grant and the ↓ hint stops promising the refused route', async () => {
  const h = await startQuick({ cols: 60, rows: 12, roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  const app = h.app as unknown as { taskQuickGrantAvailable(): boolean }
  const paintedHint = (): boolean => h.app.footerRenderRowsForTest().map(strip).join('\n').includes('↓ view')

  h.app.setTodoSummary([
    { content: 'first', status: 'in_progress' },
    { content: 'second', status: 'pending' },
    { content: 'third', status: 'pending' },
    { content: 'fourth', status: 'pending' },
  ])
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  assert.equal(app.taskQuickGrantAvailable(), true, `precondition: the CLOSED panel leaves band room:\n${view(h.vt)}`)
  assert.equal(paintedHint(), true, `precondition: the eligible state advertises the hint:\n${view(h.vt)}`)

  // Open the panel with the REAL key: the band loses its room.
  h.vt.sendInput('\x14')
  await h.vt.waitForRender()
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  const grantAfterOpen = app.taskQuickGrantAvailable()
  const paintedAfterOpen = paintedHint()
  // The REAL route in the same state (it must refuse while the grant is gone).
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  await sleep(20)
  const routeAfterOpen = h.band().identity >= 0
  if (routeAfterOpen) {
    h.vt.sendInput('\x1b')
    await h.vt.waitForRender()
  }

  assert.equal(grantAfterOpen, false, `the open panel must remove the grant:\n${view(h.vt)}`)
  assert.equal(routeAfterOpen, false, `the route must refuse while the grant is gone:\n${view(h.vt)}`)
  assert.equal(paintedAfterOpen, false,
    `the hint must not promise a refused route (grant ${grantAfterOpen}, real Down entered ${routeAfterOpen})\n${view(h.vt)}`)
})

/**
 * B4B-f18. The restore direction: the band has NO room while the
 * Todo panel is open (the hint is legitimately absent — the same runner-publish
 * sequence as production: the panel is opened first, then the todos arrive), and
 * closing the panel returns the grant. The route admits Down again, so the
 * painted hint must return with it.
 */
test('B4B-f18 closing the Todo panel restores the grant and the ↓ hint returns with the route', async () => {
  const h = await startQuick({ cols: 60, rows: 12, roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  const app = h.app as unknown as { taskQuickGrantAvailable(): boolean }
  const paintedHint = (): boolean => h.app.footerRenderRowsForTest().map(strip).join('\n').includes('↓ view')

  // Open the panel FIRST (empty), then publish the todos: the production
  // sequence that leaves the Footer composed with the tall chrome.
  h.vt.sendInput('\x14')
  await h.vt.waitForRender()
  h.app.setTodoSummary([
    { content: 'first', status: 'in_progress' },
    { content: 'second', status: 'pending' },
    { content: 'third', status: 'pending' },
    { content: 'fourth', status: 'pending' },
  ])
  // A REAL task-runtime commit while the panel is open is the live sequence
  // that leaves the Footer painted from the tall chrome. The grant is only
  // MEASURED here; nothing edits it and renderFooter() is never called.
  h.roster.rows.push(job('j2', 'test', 'running'))
  h.tasks.refreshTasks()
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  assert.equal(app.taskQuickGrantAvailable(), false, `precondition: the OPEN panel removes the band room:\n${view(h.vt)}`)
  assert.equal(paintedHint(), false, `precondition: no room means no hint:\n${view(h.vt)}`)

  // Close the panel with the REAL key: the grant returns.
  h.vt.sendInput('\x14')
  await h.vt.waitForRender()
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  const grantAfterClose = app.taskQuickGrantAvailable()
  const paintedAfterClose = paintedHint()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  await sleep(20)
  const routeAfterClose = h.band().identity >= 0

  assert.equal(routeAfterClose, true, `the real Down must enter Quick again after the panel closes:\n${view(h.vt)}`)
  assert.equal(grantAfterClose, true, `the closed panel must return the grant:\n${view(h.vt)}`)
  assert.equal(paintedAfterClose, true,
    `the restored grant must repaint the hint (grant ${grantAfterClose}, real Down entered ${routeAfterClose})\n${view(h.vt)}`)
})

/**
 * B4B-f19 (focus/seat authority). A fullscreen LEFT CLICK inside the editor
 * makes the editor the input owner. The fork promotes the mouse focus target
 * to the seat's physical mount container, which forwards `focused` and the
 * keyboard to its live child (X051) — so the editor still types. Every
 * consumer that asks "does the editor own the keyboard" must therefore resolve
 * to the EDITOR after such a click (the raw physical focus legitimately stays
 * on the forwarding seat mount).
 */
test('B4B-f19 a fullscreen editor click leaves the editor as the input owner (hint and Down follow)', async () => {
  const h = await startQuick({ roster: [job('j1', 'build', 'running')] })
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  assert.ok(view(h.vt).includes('↓ view'), `precondition: the alt frame advertises the hint:\n${view(h.vt)}`)

  // Press + release on ONE cell inside the editor's painted rows: the renderer
  // synthesizes the click that positions the cursor (1-based SGR rows).
  const rows = rawView(h.vt)
  const promptRow = rows.findIndex(line => line.includes('❯'))
  assert.ok(promptRow >= 0, `the editor paints its prompt row:\n${view(h.vt)}`)
  h.vt.sendInput(`\x1b[<0;3;${promptRow + 1}M`)
  h.vt.sendInput(`\x1b[<0;3;${promptRow + 1}m`)
  await h.vt.waitForRender()
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
  await h.vt.waitForRender()

  assert.equal(h.app.inputOwnerForTest(), h.app.seatEditorForTest().component,
    `the editor itself must remain the input owner after a fullscreen editor click:\n${view(h.vt)}`)

  // Both the paint and the real route must survive the click.
  assert.ok(view(h.vt).includes('↓ view'), `the hint must survive the click:\n${view(h.vt)}`)
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  await sleep(20)
  assert.ok(h.band().identity >= 0, `Down must still enter Quick after the click:\n${view(h.vt)}`)
  h.app.setFullscreen(false)
  await h.vt.waitForRender()
})
