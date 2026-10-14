/**
 * Phase 3B / B4-A — Task Quick on the REAL production path.
 *
 * A mounted `TuiApp` + `VirtualTerminal` + the real `createTaskRuntime` owner;
 * only the external Task surface port is replaced (the Job roster feed, the
 * optional semantic Task read and the Question attention model). Every
 * assertion reads the PAINTED frame (`VirtualTerminal.getViewport()`), never a
 * hand-built row array: the accessory is judged as the terminal renders it.
 *
 * Covered here:
 * - roster → coordinator/catalog commit → projection → below-editor rows with
 *   NO modal browser open, on both terminal roots;
 * - the Jobs-only fallback (no subagent catalog) and a transient roster read
 *   failure (retained rows — never an authoritative empty);
 * - the 3/1/0 row ladder on the frozen size matrix with the editor, the footer
 *   and the transcript row preserved;
 * - parked Question attention as its own typed row, a VISIBLE one never
 *   duplicated;
 * - the pointer contract: the alt screen delivers a real SGR wheel to the
 *   painted window, while the ordinary main screen has NO application mouse at
 *   all (the accepted H3A-16 contract, guarded by
 *   `test/history-seat-mouse.test.ts`); painting / resizing / wheeling the
 *   passive window acknowledges NOTHING; and a display seam without Task Center
 *   support mounts nothing.
 *
 * @module @xmoon76/dsh-pi-tui/task-quick-b4a-composition.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'
import { createTaskRuntime, type TaskRuntime, type TaskSurfaceSource } from '../src/app/surface/task-runtime.ts'
import { TaskBrowserRuntime } from '../src/app/surface/task-browser-runtime.ts'
import type { QuestionAttentionRow } from '../src/app/surface/question-controller.ts'
import type { SessionSubject } from '../src/app/session/subject.ts'
import type { JobObservationPort, JobStopOutcome } from '../src/runtime/job-observation-port.ts'
import type { TaskSubagentEntry } from '../src/runtime/task-read-port.ts'
import type { TaskBrowserJobInput } from '../src/domain/task/browser.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import { currentPalette, setTheme } from '../src/tui/theme/runtime.ts'
import { lightColors } from '../src/domain/display/theme.ts'
import { displaySeamStub } from './support/display-seam-stub.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** The painted frame, sequence-free: every assertion below reads what the
 *  terminal actually shows, and the helpers project each row through the same
 *  primitive. */
const strip = stripTerminalSequences
const rawView = (vt: VirtualTerminal): string[] => vt.getViewport().map(strip)
const view = (vt: VirtualTerminal): string => rawView(vt).join('\n')
const rowOf = (vt: VirtualTerminal, needle: string): number =>
  rawView(vt).findIndex(line => line.includes(needle))
/** Every painted task row of the accessory, whatever its grant (a one-row grant
 *  paints no identity row, so the band is located by the status group). */
const itemRows = (vt: VirtualTerminal): string[] =>
  rawView(vt).filter(line => line.includes('‣ '))

function job(id: string, label: string, status: string, kind = 'bash'): TaskBrowserJobInput {
  return { id, kind, label, status, startedAt: 1_000 }
}

class JobObservationDouble implements JobObservationPort {
  open(): () => void {
    return () => {}
  }

  async stop(): Promise<JobStopOutcome> {
    return { kind: 'requested' }
  }
}

interface QuickHarness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly tasks: TaskRuntime
  /** The MUTABLE roster the injected jobs feed reads (throws when `reader` is set). */
  readonly roster: { rows: TaskBrowserJobInput[]; failure: Error | undefined }
  /** The MUTABLE parked/visible Question attention model. */
  readonly attention: QuestionAttentionRow[]
  /** The MUTABLE descendant catalog of the semantic Task read. */
  readonly descendants: TaskSubagentEntry[]
  /** The painted accessory band: the identity row index and its item rows. */
  band(): { identity: number; items: string[] }
  /** The editor's top and bottom border rows in the painted frame. */
  editor(): { top: number; bottom: number }
}

function startQuick(options: {
  cols?: number
  rows?: number
  taskRead?: boolean
  supportsTaskCenter?: boolean
  roster: TaskBrowserJobInput[]
  descendants?: TaskSubagentEntry[]
}): QuickHarness {
  const columns = options.cols ?? 120
  const terminalRows = options.rows ?? 40
  const vt = new VirtualTerminal(columns, terminalRows)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {})
  app.start()
  startedApps.add(app)

  const roster = { rows: [...options.roster], failure: undefined as Error | undefined }
  const attention: QuestionAttentionRow[] = []
  const descendants = [...(options.descendants ?? [])]
  const subject = {} as SessionSubject
  const source: TaskSurfaceSource = {
    sessionId: () => 'sess-main',
    captureSubject: () => subject,
    subjectMatches: candidate => candidate === subject,
    enterView: async () => {},
    interruptSubagent: async () => ({ kind: 'committed' } as never),
    rowSelectionDisposition: (row, jobDetail) => row === undefined || row.kind === 'job' ? jobDetail : 'close',
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: status => status,
    jobObservation: new JobObservationDouble(),
    jobs: {
      list: () => {
        if (roster.failure !== undefined) throw roster.failure
        return roster.rows
      },
      subscribe: () => () => {},
    },
    ...(options.taskRead === false ? {} : {
      taskRead: {
        currentKey: () => 'g1:sess-main',
        currentSessionId: () => 'sess-main',
        readTask: async () => ({
          parentSessionId: 'sess-main',
          parentAvailable: true,
          descendants: [...descendants],
          jobs: roster.failure === undefined ? roster.rows : [],
        }),
        activityOf: (childId: string) => {
          const entry = descendants.find(candidate => candidate.id === childId)
          return entry !== undefined && entry.kind === 'child' ? entry.activity : 'inactive'
        },
      },
    }),
  }
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => displaySeamStub({ supportsTaskCenter: options.supportsTaskCenter ?? true }),
    isCleanedUp: () => false,
    attention: { rows: () => attention, reconcile: () => {}, publish: () => {}, reopen: () => false },
  })
  tasks.attachTasks(source, { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })

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
  const editor = (): { top: number; bottom: number } => {
    const lines = rawView(vt)
    const prompt = lines.findIndex(line => line.includes('❯'))
    const border = '─'.repeat(10)
    const top = prompt < 0 ? -1 : lines.slice(0, prompt).findLastIndex(line => line.includes(border))
    const bottom = prompt < 0 ? -1 : lines.findIndex((line, index) => index > prompt && line.includes(border))
    return { top, bottom }
  }
  return { vt, app, tasks, roster, attention, descendants, band, editor }
}

// ── B4A-01: the passive projection reaches the frame with no browser open ──

test('B4A-01 the Job roster paints below the editor with NO Task Browser open', async () => {
  const h = startQuick({
    roster: [
      job('j1', 'build', 'running'),
      job('j2', 'test', 'running', 'pwsh'),
      job('j3', 'deploy', 'failed'),
      job('j4', 'review', 'running', 'subagent'),
    ],
  })
  await flush()
  await h.vt.waitForRender()

  const lines = rawView(h.vt)
  const band = h.band()
  const editor = h.editor()
  assert.ok(band.identity >= 0, `the accessory must paint:\n${view(h.vt)}`)
  assert.equal(band.items.length, 3, `three task rows at 120x40:\n${view(h.vt)}`)
  // Exactly below the editor seat, and above the footer.
  assert.equal(band.identity, editor.bottom + 1, 'the identity row sits directly below the editor')
  assert.ok(band.identity + band.items.length < lines.length, 'the footer stays below the accessory')
  // The real roster, projected by the ONE authority — never a second catalog.
  // N is the scrollable projection: the failed job is footer attention while
  // live work keeps the Active scope, exactly as the modal Quick projects it.
  assert.match(strip(lines[band.identity]!), /^Task Quick\s+showing 1-3\/3$/)
  const painted = band.items.map(line => line.trimEnd())
  assert.match(painted[0]!, /bash · build\s+‣ Running$/)
  assert.match(painted[1]!, /pwsh · test\s+‣ Running$/)
  assert.match(painted[2]!, /subagent job · review · one-shot\s+‣ Running$/)
  // No modal chrome, no keyboard hint, no focus device: the window is passive.
  assert.equal(band.items.some(line => line.includes('> ') || line.includes('Select')), false)
  assert.ok(!view(h.vt).includes('↑↓ select'), 'the modal Task Browser chrome must not be painted')
  // Footer attention for the failed job is untouched by the passive paint.
  h.app.stop()
})

test('B4A-01b the Jobs-only fallback (no subagent catalog) also paints below the editor', async () => {
  const h = startQuick({
    taskRead: false,
    roster: [job('j1', 'build', 'running'), job('j2', 'deploy', 'failed')],
  })
  await flush()
  await h.vt.waitForRender()
  const band = h.band()
  assert.ok(band.identity >= 0, `the Jobs-only feed must paint:\n${view(h.vt)}`)
  // Live work keeps the Active scope: the terminal failure is footer attention,
  // exactly as the modal Quick projects it.
  assert.deepEqual(band.items.map(line => line.trimEnd().split(/\s+‣\s+/)[0]), ['bash · build'])
  assert.match(strip(rawView(h.vt)[band.identity]!), /showing 1-1\/1$/)
})

test('B4A-01c a transient roster read failure keeps the RETAINED rows', async () => {
  const h = startQuick({ taskRead: false, roster: [job('j1', 'build', 'running')] })
  await flush()
  await h.vt.waitForRender()
  assert.equal(h.band().items.length, 1)
  h.roster.failure = new Error('registry read failed')
  h.tasks.refreshTasks()
  await h.vt.waitForRender()
  assert.equal(h.band().items.length, 1, `a failed read is not an authoritative empty:\n${view(h.vt)}`)
  assert.match(strip(h.band().items[0]!), /bash · build\s+‣ Running$/)
})

test('B4A-01d the coordinator path (semantic Task read) feeds the SAME window', async () => {
  const h = startQuick({
    roster: [job('j1', 'build', 'running')],
    descendants: [{
      kind: 'child', id: 'child-a', label: 'review', mode: 'continuable',
      activity: 'running', hasChildren: false, parentId: '', depth: 1,
    } as unknown as TaskSubagentEntry],
  })
  await flush()
  await h.vt.waitForRender()
  const band = h.band()
  assert.ok(band.identity >= 0, `the coordinator commit must reach the accessory:\n${view(h.vt)}`)
  const painted = band.items.map(line => `${line.trimEnd()}`)
  assert.ok(painted.some(line => /subagent · review/.test(line)), `the descendant row must paint:\n${view(h.vt)}`)
})

test('B4A-02 the window paints the PROJECTED activity in tree order, never a running lie', async () => {
  const h = startQuick({
    roster: [],
    descendants: [
      {
        kind: 'child', id: 'parent', label: 'parent', mode: 'continuable',
        activity: 'inactive', hasChildren: true, parentId: '', depth: 1,
      },
      {
        kind: 'child', id: 'child', label: 'child', mode: 'continuable',
        activity: 'running', hasChildren: false, parentId: 'parent', depth: 2,
      },
    ] as unknown as TaskSubagentEntry[],
  })
  await flush()
  await h.vt.waitForRender()
  const items = itemRows(h.vt)
  assert.equal(items.length, 2, `the running child and its context ancestor paint in that order:\n${view(h.vt)}`)
  // The inactive ancestor keeps its OWN real activity word — the tree context
  // is never relabelled to match its running descendant.
  assert.match(items[0]!, /subagent · parent · continuable\s+‣ Inactive$/)
  assert.match(items[1]!, /subagent · child · continuable\s+‣ Running$/)
})

test('B4A-02b a session reset clears the window with the rest of the Task Center state', async () => {
  const h = startQuick({ taskRead: false, roster: [job('j1', 'build', 'running')] })
  await flush()
  await h.vt.waitForRender()
  assert.equal(itemRows(h.vt).length, 1)
  h.tasks.resetTasks()
  await h.vt.waitForRender()
  assert.deepEqual(itemRows(h.vt), [], `the new session must not inherit the old rows:\n${view(h.vt)}`)
  assert.equal(rowOf(h.vt, 'Task Quick'), -1, 'no orphan identity row after the reset')
  assert.equal(h.app.getDraft(), '', 'the reset itself never touches the draft')
})

// ── B4A-05: the frozen size matrix ─────────────────────────────────────────

test('B4A-05 the 3/1/0 ladder on the frozen matrix, editor/footer/transcript preserved', async () => {
  const sizes: ReadonlyArray<readonly [cols: number, rows: number, items: number]> = [
    [200, 60, 3],
    [120, 40, 3],
    [80, 24, 3],
    [80, 10, 1],
    [80, 8, 1],
    [72, 24, 3],
    [44, 20, 3],
  ]
  for (const [cols, rows, expected] of sizes) {
    const h = startQuick({
      cols,
      rows,
      taskRead: false,
      roster: [
        job('j1', 'build the whole thing with a very long label', 'running'),
        job('j2', 'test', 'running'),
        job('j3', 'deploy', 'running'),
        job('j4', 'lint', 'running'),
        job('j5', '中文任务标签非常长需要被正确截断', 'running'),
      ],
    })
    await flush()
    await h.vt.waitForRender()
    const label = `${cols}x${rows}`
    const lines = rawView(h.vt)
    const items = itemRows(h.vt)
    const identity = rowOf(h.vt, 'Task Quick')
    const editor = h.editor()
    assert.equal(items.length, expected, `${label}: item rows:\n${view(h.vt)}`)
    assert.ok(items.length <= 3, `${label}: never more than three task rows`)
    // The position is ALWAYS real: on the identity row when one is granted,
    // otherwise as the compact tail of the single content row.
    const positionRow = identity >= 0 ? lines[identity]! : items[0]!
    assert.match(positionRow, /\d+-\d+\/5$/, `${label}: a real position indicator:\n${view(h.vt)}`)
    // The band is BELOW the seat and above the footer: nothing pinned is
    // orphaned, and the whole accessory fits the visible viewport.
    const firstItemRow = rowOf(h.vt, items[0]!)
    assert.ok(firstItemRow > editor.bottom, `${label}: the band sits below the seat:\n${view(h.vt)}`)
    assert.ok(firstItemRow + items.length - 1 < h.vt.rows, `${label}: the band stays inside the viewport`)
    // The seat and the footer survive at every size.
    assert.ok(editor.bottom > editor.top && editor.top >= 0, `${label}: the editor seat is intact`)
    assert.ok(rowOf(h.vt, '❯') >= 0, `${label}: the editor prompt is painted`)
    for (const footerRow of h.app.footerRenderRowsForTest().map(strip).map(line => line.trimEnd())) {
      if (footerRow === '') continue
      assert.ok(lines.some(line => line.includes(footerRow)),
        `${label}: a footer row was clipped out of the viewport: ${JSON.stringify(footerRow)}`)
    }
    // The position indicator is real and the frozen glyph vocabulary is used.
    assert.equal(/→|●|○|◐|×/.test(items.join('')), false, `${label}: no legacy per-status glyph in the accessory`)
    // The process slot (pi-tui keybindings are process-global) is released only
    // by the FINAL dispose: the next matrix cell needs its own app.
    h.app.dispose()
  }
})

test('B4A-05c the fullscreen root keeps a real transcript viewport beside the window', async () => {
  const cells: ReadonlyArray<readonly [cols: number, rows: number, items: number]> = [
    [120, 40, 3],
    [80, 24, 3],
    [80, 10, 1],
    [80, 8, 1],
  ]
  for (const [cols, rows, expected] of cells) {
    const h = startQuick({ cols, rows, taskRead: false, roster: [
      job('j1', 'build', 'running'), job('j2', 'test', 'running'), job('j3', 'lint', 'running'),
      job('j4', 'deploy', 'running'),
    ] })
    await flush()
    h.app.setFullscreen(true)
    await h.vt.waitForRender()
    const label = `${cols}x${rows}`
    const items = itemRows(h.vt)
    const scroll = h.app.fullscreenScrollForTest()
    assert.ok(scroll, `${label}: the fullscreen transcript pane must exist`)
    assert.equal(items.length, expected, `${label}: item rows:\n${view(h.vt)}`)
    assert.ok(scroll.viewportHeight >= 1,
      `${label}: the transcript floor survives the accessory (viewport ${scroll.viewportHeight}):\n${view(h.vt)}`)
    assert.ok(rowOf(h.vt, '❯') >= 0, `${label}: the seat is painted`)
    for (const footerRow of h.app.footerRenderRowsForTest().map(strip).map(line => line.trimEnd())) {
      if (footerRow === '') continue
      assert.ok(rawView(h.vt).some(line => line.includes(footerRow)),
        `${label}: the pinned footer stays inside the viewport: ${JSON.stringify(footerRow)}`)
    }
    h.app.dispose()
  }
})

test('B4A-05d an extreme frame degrades to ZERO rows instead of eating the transcript', async () => {
  const h = startQuick({ cols: 80, rows: 6, taskRead: false, roster: [
    job('j1', 'build', 'running'), job('j2', 'test', 'running'), job('j3', 'lint', 'running'),
  ] })
  await flush()
  await h.vt.waitForRender()
  assert.deepEqual(itemRows(h.vt), [], `a frame with no room paints nothing:\n${view(h.vt)}`)
  assert.equal(rowOf(h.vt, 'Task Quick'), -1, 'no orphan identity row without a task row')
  assert.ok(rowOf(h.vt, '❯') >= 0, 'the editor seat still owns its rows')
  h.app.dispose()
})

test('B4A-05b a nonempty multi-line draft never invades the transcript floor', async () => {
  const h = startQuick({ cols: 80, rows: 10, taskRead: false, roster: [
    job('j1', 'build', 'running'), job('j2', 'test', 'running'), job('j3', 'lint', 'running'),
  ] })
  await flush()
  h.app.setEditorText('first\nsecond\nthird')
  await h.vt.waitForRender()
  const items = itemRows(h.vt)
  const editor = h.editor()
  assert.ok(editor.bottom - editor.top >= 2, `the multi-line editor owns its rows:\n${view(h.vt)}`)
  // A 10-row frame with the taller seat, the header, the footer and the
  // transcript floor can only afford ONE content row — spent on the task, never
  // on the identity row: the compact position rides its tail.
  assert.equal(items.length, 1, `exactly one task row survives:\n${view(h.vt)}`)
  assert.match(items[0]!, /^bash · build\s+‣ Running\s+1-1\/3$/)
  assert.ok(rowOf(h.vt, items[0]!) > editor.bottom, 'the accessory stays BELOW the editor seat')
  assert.ok(editor.top >= 1, `the transcript floor survives a taller draft:\n${view(h.vt)}`)
})

// ── B4A-03: Question attention ─────────────────────────────────────────────

test('B4A-03 a PARKED Question is its own typed row and a VISIBLE one never duplicates', async () => {
  const h = startQuick({ taskRead: false, roster: [], })
  h.attention.push({ sessionId: 'sess-main', callId: 'c1', questions: [{ id: 'q1', question: 'Continue with the deploy?' }], presentation: 'parked' })
  // The Question controller's own two publications for one attention change:
  // the Task Center rows (`TaskRuntime.refreshAttentionRows`) and the footer
  // count (`interaction-runtime` -> `presenter.setQuestionAttention`).
  h.tasks.refreshAttentionRows()
  h.app.setQuestionAttention(1)
  await h.vt.waitForRender()
  const parked = h.band()
  assert.ok(parked.identity >= 0, `parked attention must paint:\n${view(h.vt)}`)
  assert.equal(parked.items.length, 1)
  assert.match(strip(parked.items[0]!), /Continue with the deploy\?\s+‣ Awaiting answer$/)
  // The footer's OWN `?N` attention figure is untouched by the passive paint:
  // the window never writes the parked count back.
  assert.ok(view(h.vt).includes('? 1 awaiting'), `the footer keeps its own parked count:\n${view(h.vt)}`)
  // A VISIBLE Question owns the editor seat: it must not be duplicated here.
  h.attention[0] = { ...h.attention[0]!, presentation: 'visible' }
  h.tasks.refreshAttentionRows()
  h.app.setQuestionAttention(0)
  await h.vt.waitForRender()
  assert.equal(h.band().identity, -1, `a visible Question never duplicates into Quick:\n${view(h.vt)}`)
})

// ── B4A-04 / B4A-06: the pointer and the acknowledgement ledger ────────────

test('B4A-06 the alt screen delivers a real SGR wheel to the painted window only', async () => {
  const h = startQuick({ cols: 120, rows: 40, taskRead: false, roster: [
    job('j1', 'build', 'running'), job('j2', 'test', 'running'), job('j3', 'lint', 'running'),
    job('j4', 'deploy', 'running'), job('j5', 'audit', 'running'),
  ] })
  await flush()
  await h.vt.waitForRender()
  h.app.setEditorText('a draft line')
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  const before = h.band()
  assert.match(strip(rawView(h.vt)[before.identity]!), /showing 1-3\/5$/)
  const firstItemRow = before.identity + 1
  // ONE native SGR wheel notch DOWN over the first painted task row.
  h.vt.sendInput(`\x1b[<65;5;${firstItemRow + 1}M`)
  await h.vt.waitForRender()
  await flush(2)
  const after = h.band()
  assert.match(strip(rawView(h.vt)[after.identity]!), /showing 2-4\/5$/, `the wheel must move the window:\n${view(h.vt)}`)
  assert.match(strip(after.items[0]!), /bash · test\s+‣ Running$/)
  // The editor draft, its focus and the transcript viewport are untouched.
  assert.equal(h.app.getDraft(), 'a draft line', 'the wheel must never touch the draft')
  h.vt.sendInput('x')
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), 'a draft linex', 'the editor still owns the keyboard after the wheel')
  // A wheel ABOVE the accessory belongs to the transcript, never to Quick.
  const scrolled = strip(rawView(h.vt)[before.identity]!)
  h.vt.sendInput(`\x1b[<65;5;2M`)
  await h.vt.waitForRender()
  await flush(2)
  assert.equal(strip(rawView(h.vt)[h.band().identity]!), scrolled, 'a transcript wheel must not move the Quick window')
})

test('B4A-06b the ordinary main screen has NO application mouse: the wheel moves nothing', async () => {
  const h = startQuick({ cols: 120, rows: 40, taskRead: false, roster: [
    job('j1', 'build', 'running'), job('j2', 'test', 'running'), job('j3', 'lint', 'running'),
    job('j4', 'deploy', 'running'),
  ] })
  await flush()
  await h.vt.waitForRender()
  const before = h.band()
  assert.ok(before.identity >= 0)
  assert.match(strip(rawView(h.vt)[before.identity]!), /showing 1-3\/4$/)
  const firstItemRow = before.identity + 1
  h.vt.sendInput(`\x1b[<65;5;${firstItemRow + 1}M`)
  await h.vt.waitForRender()
  await flush(2)
  // H3A-16: the regular root writes no mouse mode, so the terminal never sends
  // the event in the first place; an injected one must change nothing.
  assert.match(strip(rawView(h.vt)[h.band().identity]!), /showing 1-3\/4$/)
  assert.equal(h.app.getDraft(), '')
})

test('B4A-04 painting, resizing and wheeling the passive window acknowledge NOTHING', async () => {
  const original = TaskBrowserRuntime.prototype.acknowledge
  let calls = 0
  TaskBrowserRuntime.prototype.acknowledge = function (this: TaskBrowserRuntime, values: readonly string[]): void {
    calls += 1
    return original.call(this, values)
  }
  try {
    // The coordinator path: the acknowledgement ledger lives in the
    // `TaskBrowserRuntime` the semantic Task read owns, so this is the only
    // configuration in which the witness can have a positive control at all.
    const h = startQuick({ cols: 120, rows: 40, roster: [
      job('j1', 'build', 'running'), job('j2', 'deploy', 'failed'),
    ] })
    await flush()
    await h.vt.waitForRender()
    // Live work keeps the failure OUT of the Active scope: footer attention only.
    assert.deepEqual(itemRows(h.vt).map(line => line.split(/\s+‣\s+/)[0]), ['bash · build'])
    // Settle the work: the unacknowledged failure surfaces in the window…
    h.roster.rows = [job('j2', 'deploy', 'failed')]
    h.tasks.refreshAgentRuntimeOnly()
    await h.vt.waitForRender()
    assert.match(itemRows(h.vt)[0]!, /bash · deploy\s+‣ Failed$/)
    // …and the passive paint, a resize and a wheel must never acknowledge it.
    h.vt.resize(100, 30)
    await h.vt.waitForRender()
    h.app.setFullscreen(true)
    await h.vt.waitForRender()
    const band = h.band()
    h.vt.sendInput(`\x1b[<65;5;${band.identity + 2}M`)
    await h.vt.waitForRender()
    await flush(2)
    assert.equal(calls, 0, 'the passive window acknowledges no failure')
    assert.ok(view(h.vt).includes('! 1 failed'), `the footer attention is still pending:\n${view(h.vt)}`)
    // Positive control: the modal Task Browser DOES acknowledge the visible
    // failure row — so the probe is not vacuous.
    h.app.setFullscreen(false)
    await h.vt.waitForRender()
    h.tasks.openTasksBrowser('quick')
    await h.vt.waitForRender()
    await flush(2)
    assert.ok(calls >= 1, `opening the modal browser on the failure row must acknowledge:\n${view(h.vt)}`)
  } finally {
    TaskBrowserRuntime.prototype.acknowledge = original
  }
})

test('B4A-08 the painted window uses the frozen role tokens, live across a theme switch', async () => {
  const hexToRgb = (hex: string): number =>
    (parseInt(hex.slice(1, 3), 16) << 16) | (parseInt(hex.slice(3, 5), 16) << 8) | parseInt(hex.slice(5, 7), 16)
  const h = startQuick({ cols: 120, rows: 40, taskRead: false, roster: [
    job('j1', 'build', 'running'), job('j2', 'deploy', 'failed'),
  ] })
  await flush()
  await h.vt.waitForRender()
  const ink = (needle: string, glyph: string): number | undefined => {
    const row = rowOf(h.vt, needle)
    const col = rawView(h.vt)[row]!.indexOf(glyph)
    return h.vt.getCellFgRgb(row, col)
  }
  // Role 1 identity, role 9 status word, both from the LIVE palette.
  assert.equal(ink('Task Quick', 'Task Quick'), hexToRgb(currentPalette.textStrong))
  assert.equal(ink('bash · build', '‣'), hexToRgb(currentPalette.primary))
  // No live work: the unacknowledged failure paints its own semantic token.
  h.roster.rows = [job('j2', 'deploy', 'failed')]
  h.tasks.refreshTasks()
  await h.vt.waitForRender()
  assert.equal(ink('bash · deploy', '‣'), hexToRgb(currentPalette.warning))
  // The SAME frame under the light palette (a live switch, no re-mount).
  setTheme('light')
  h.app.requestRender()
  await h.vt.waitForRender()
  assert.equal(ink('Task Quick', 'Task Quick'), hexToRgb(lightColors.textStrong))
  assert.equal(ink('bash · deploy', '‣'), hexToRgb(lightColors.warning))
  // Nothing new entered the chrome vocabulary.
  assert.equal(/→|●|○|◐|×|│|╭|─/.test(itemRows(h.vt).join('')), false, `only the frozen vocabulary:\n${view(h.vt)}`)
  setTheme('dark')
})

// ── B4A-07 / B4A-10 ────────────────────────────────────────────────────────

test('B4A-07 a resize re-budgets the window and keeps the anchored row visible', async () => {
  const h = startQuick({ cols: 120, rows: 40, taskRead: false, roster: [
    job('j1', 'a', 'running'), job('j2', 'b', 'running'), job('j3', 'c', 'running'),
    job('j4', 'd', 'running'), job('j5', 'e', 'running'), job('j6', 'f', 'running'),
  ] })
  await flush()
  await h.vt.waitForRender()
  assert.equal(h.band().items.length, 3)
  h.vt.resize(120, 10)
  await h.vt.waitForRender()
  const shrunk = h.band()
  assert.equal(shrunk.items.length, 1, `the short frame keeps one task row:\n${view(h.vt)}`)
  assert.match(strip(shrunk.items[0]!), /bash · a\s+‣ Running$/, 'the anchored row survives the shrink')
  h.vt.resize(120, 40)
  await h.vt.waitForRender()
  assert.equal(h.band().items.length, 3, 'growing back restores the window')
})

test('B4A-10 a display seam without Task Center support mounts no fake window', async () => {
  const h = startQuick({
    cols: 120, rows: 40, taskRead: false, supportsTaskCenter: false,
    roster: [job('j1', 'build', 'running')],
  })
  await flush()
  await h.vt.waitForRender()
  assert.equal(h.band().identity, -1, `no Task Center capability must mount no Quick window:\n${view(h.vt)}`)
  assert.ok(!view(h.vt).includes('Task Quick'))
})
