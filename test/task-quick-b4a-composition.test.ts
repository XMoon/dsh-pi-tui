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
import { Text, stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'
import { createTaskRuntime, type TaskRuntime, type TaskSurfaceSource } from '../src/app/surface/task-runtime.ts'
import { QuestionSurfaceController } from '../src/app/surface/question-controller.ts'
import type { QuestionInteractionPort, QuestionSurfaceSnapshot, QuestionWaitClaim } from '../src/runtime/interaction-port.ts'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { TuiQuestionAnswer } from '../src/tui-app.ts'
import { TaskBrowserRuntime } from '../src/app/surface/task-browser-runtime.ts'
import type { QuestionAttentionRow } from '../src/app/surface/question-controller.ts'
import type { SessionSubject } from '../src/app/session/subject.ts'
import type { JobObservationPort, JobStopOutcome } from '../src/runtime/job-observation-port.ts'
import type { TaskSubagentEntry } from '../src/runtime/task-read-port.ts'
import type { TaskBrowserJobInput } from '../src/domain/task/browser.ts'
import { ExtensionLedger } from '../src/extension/internal/ledger.ts'
import { SurfaceHost } from '../src/extension/internal/surface-host.ts'
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
  /** Settle every catalog read currently held by `holdCatalog`. */
  releaseCatalog(): void
}

function startQuick(options: {
  cols?: number
  rows?: number
  taskRead?: boolean
  supportsTaskCenter?: boolean
  roster: TaskBrowserJobInput[]
  descendants?: TaskSubagentEntry[]
  /** Hold every semantic catalog (`readTask`) so a test can settle a SUPERSEDED
   *  session's read after the generation bump. */
  holdCatalog?: boolean
  /** A live PUBLIC below widget (`input.widget.below`) registered through a real
   *  `SurfaceHost`, so the accessory's coexistence with the public slot is
   *  witnessed on the painted frame. */
  widgetBelow?: string
}): QuickHarness {
  const columns = options.cols ?? 120
  const terminalRows = options.rows ?? 40
  const vt = new VirtualTerminal(columns, terminalRows)
  let app!: TuiApp
  const ledger = options.widgetBelow === undefined ? undefined : new ExtensionLedger(() => {})
  const host = ledger === undefined ? undefined : new SurfaceHost(ledger, () => app.requestRender())
  app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, host === undefined ? {} : { extensionHost: host })
  app.start()
  startedApps.add(app)
  if (host !== undefined && ledger !== undefined && options.widgetBelow !== undefined) {
    host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
      surfaceId: host.surfaceId, generation: 1, width: columns, height: terminalRows,
      fullscreen: false, focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
    })
    ledger.register('input.widget.below', { id: 'b4a-widget', order: 0 }, {
      view: { kind: 'text', spans: [{ text: options.widgetBelow }] },
      importance: 0,
    }, 'owner-b4a')
    host.refreshOutlets()
  }

  const roster = { rows: [...options.roster], failure: undefined as Error | undefined }
  const attention: QuestionAttentionRow[] = []
  const descendants = [...(options.descendants ?? [])]
  const pendingCatalogReads: Array<() => void> = []
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
        readTask: async () => {
          if (options.holdCatalog === true) {
            await new Promise<void>(resolve => pendingCatalogReads.push(resolve))
          }
          return {
            parentSessionId: 'sess-main',
            parentAvailable: true,
            descendants: [...descendants],
            jobs: roster.failure === undefined ? roster.rows : [],
          }
        },
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
  const releaseCatalog = (): void => {
    for (const release of pendingCatalogReads.splice(0)) release()
  }
  return { vt, app, tasks, roster, attention, descendants, band, editor, releaseCatalog }
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

test('B4A-01e a Workflow-scoped Task Browser never narrows the resident window', async () => {
  const h = startQuick({
    roster: [job('j1', 'build', 'running')],
    descendants: [
      {
        kind: 'child', id: 'c1', label: 'phase agent', mode: 'continuable',
        activity: 'running', hasChildren: false, parentId: '', depth: 1,
      },
      {
        kind: 'child', id: 'c2', label: 'unrelated agent', mode: 'continuable',
        activity: 'running', hasChildren: false, parentId: '', depth: 1,
      },
    ] as unknown as TaskSubagentEntry[],
  })
  await flush()
  await h.vt.waitForRender()
  assert.equal(itemRows(h.vt).length, 3, `the whole session is resident first:\n${view(h.vt)}`)
  // A Workflow phase viewer opens the modal with a DATASET scope of one child id.
  h.tasks.handleWorkflowAction({
    kind: 'open-phase-agents', runId: 'run-1', name: 'wf', phaseLabel: 'Phase 1', childIds: ['c1'],
  })
  await h.vt.waitForRender()
  await flush(2)
  assert.ok(view(h.vt).includes('Workflow · wf · Phase 1 · 1 agent'), `the modal is scoped:\n${view(h.vt)}`)
  // The resident window is NOT a dataset view: the Job and the unrelated active
  // subagent stay visible while the scoped modal is open.
  const resident = itemRows(h.vt)
  assert.equal(resident.length, 3, `the resident window keeps the session-wide rows:\n${view(h.vt)}`)
  assert.ok(resident.some(line => /bash · build/.test(line)), 'the Job stays resident under a subagent scope')
  assert.ok(resident.some(line => /unrelated agent/.test(line)), 'an unrelated active agent stays resident')
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
        // The long CJK label is FIRST so the painted window really carries it at
        // every size (a 44x20 frame shows only its first row).
        job('j5', '中文任务标签非常长需要被正确截断', 'running'),
        job('j1', 'build the whole thing with a very long label', 'running'),
        job('j2', 'test', 'running'),
        job('j3', 'deploy', 'running'),
        job('j4', 'lint', 'running'),
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
    // Every painted row is clamped to the terminal width in CELLS (a JS
    // `.length` would hide a CJK overflow).
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= cols, `${label}: a painted row overflowed ${cols} cells: ${JSON.stringify(line)}`)
    }
    // The position indicator is real and the frozen glyph vocabulary is used.
    assert.equal(/→|●|○|◐|×/.test(items.join('')), false, `${label}: no legacy per-status glyph in the accessory`)
    assert.equal(/[\u2500-\u257f]/.test(items.join('')), false, `${label}: no box-drawing glyph in the accessory`)
    // The process slot (pi-tui keybindings are process-global) is released only
    // by the FINAL dispose: the next matrix cell needs its own app.
    h.app.dispose()
  }
})

test('B4A-05c the fullscreen root keeps a real transcript viewport beside the window', async () => {
  const cells: ReadonlyArray<readonly [cols: number, rows: number, items: number]> = [
    [200, 60, 3],
    [120, 40, 3],
    [80, 24, 3],
    [80, 10, 1],
    [80, 8, 1],
    [72, 24, 3],
    [44, 20, 3],
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
    for (const line of rawView(h.vt)) {
      assert.ok(visibleWidth(line) <= cols, `${label}: a painted row overflowed ${cols} cells: ${JSON.stringify(line)}`)
    }
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

test('B4A-02c a superseded session late catalog result never paints into the new session', async () => {
  const h = startQuick({
    holdCatalog: true,
    roster: [job('j1', 'build', 'running')],
    descendants: [{
      kind: 'child', id: 'c1', label: 'late agent', mode: 'continuable',
      activity: 'running', hasChildren: false, parentId: '', depth: 1,
    } as unknown as TaskSubagentEntry],
  })
  await flush()
  await h.vt.waitForRender()
  // The roster commit alone already paints; the catalog read is still in flight.
  assert.equal(itemRows(h.vt).length, 1, `the roster row is resident:\n${view(h.vt)}`)
  // The session switches: the generation bump clears the Task Center state.
  h.tasks.resetTasks()
  await h.vt.waitForRender()
  assert.deepEqual(itemRows(h.vt), [], `the new session starts empty:\n${view(h.vt)}`)
  // The OLD read now settles with its old-session snapshot: it must not paint.
  h.releaseCatalog()
  await flush(4)
  await h.vt.waitForRender()
  assert.deepEqual(itemRows(h.vt), [], `a stale catalog result must never reach the new session:\n${view(h.vt)}`)
})

// ── B4A-03: Question attention, driven through the REAL controller ─────────

test('B4A-03b the production Question controller subscription reaches the painted window', async () => {
  const QUESTIONS: readonly AskUserQuestionItem[] = [{ id: 'q1', question: 'Use staging or production?' }]
  const SESSION = 'sess-main'
  const CALL = 'call-continued'
  let snapshot: QuestionSurfaceSnapshot | undefined
  let subscribers: Array<() => void> = []

  // The same minimal Question port the controller suites use (`question-park-reopen`).
  const port: QuestionInteractionPort = {
    onRequest: () => true,
    subscribe: (_sessionId, listener) => {
      subscribers.push(listener)
      return () => { subscribers = subscribers.filter(entry => entry !== listener) }
    },
    snapshot: () => snapshot,
    claimTimedWait: async (): Promise<QuestionWaitClaim | undefined> => undefined,
    answerContinued: async () => 'queued',
  }

  // A real TuiApp + the ONE Task Runtime, wired the way the production
  // composition wires them: the controller is the attention authority,
  // `publishAttention` is the app's own parked count, and the controller's
  // subscription repaints the Task Center rows.
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {})
  app.start()
  startedApps.add(app)
  const controller = new QuestionSurfaceController({
    port,
    ask: () => new Promise<TuiQuestionAnswer[]>(() => {}),
    notify: () => {},
    repaint: () => app.requestRender(),
    currentSessionId: () => SESSION,
    isAdmissibleSession: sessionId => sessionId === SESSION,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  })
  const publishAttention = (): void => {
    app.setQuestionAttention(controller.attentionRows().filter(row => row.presentation === 'parked').length)
  }
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => displaySeamStub(),
    isCleanedUp: () => false,
    attention: {
      rows: () => controller.attentionRows(),
      reconcile: () => controller.reconcile(),
      publish: publishAttention,
      reopen: (sessionId, callId) => controller.reopen(sessionId, callId),
    },
  })
  tasks.attachTasks({
    sessionId: () => SESSION,
    captureSubject: () => ({}) as never,
    subjectMatches: () => true,
    enterView: async () => {},
    interruptSubagent: async () => ({ kind: 'committed' }) as never,
    rowSelectionDisposition: (row, detail) => row === undefined || row.kind === 'job' ? detail : 'close',
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: status => status,
    jobObservation: new JobObservationDouble(),
    jobs: { list: () => [], subscribe: () => () => {} },
  }, { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  const subscription = controller.subscribeAttention(() => {
    publishAttention()
    tasks.refreshAttentionRows()
  })
  controller.attach()
  await flush()
  await vt.waitForRender()

  // Cold discovery with authority exposing a CONTINUED call: the controller
  // parks it (no form mounted) and its OWN subscription drives the window.
  snapshot = {
    sessionId: SESSION,
    active: [{ callId: CALL, sessionId: SESSION, questions: QUESTIONS, state: 'continued' }],
    settled: [],
    queuedReplyCallIds: new Set<string>(),
  }
  for (const listener of [...subscribers]) listener()
  controller.reconcile()
  await flush()
  await vt.waitForRender()
  assert.match(itemRows(vt)[0] ?? '', /Use staging or production\?\s+‣ Awaiting answer$/,
    `the controller's parked row must paint:\n${view(vt)}`)
  assert.ok(view(vt).includes('? 1 awaiting'), `the footer count comes from the same authority:\n${view(vt)}`)

  // The user reopens it: the controller's own subscription moves it to `visible`
  // (the flow owns the editor seat) and the resident window must drop it.
  assert.equal(controller.reopen(SESSION, CALL), true)
  await flush()
  await vt.waitForRender()
  await flush(2)
  assert.deepEqual(itemRows(vt), [], `a visible Question never duplicates into the window:\n${view(vt)}`)
  assert.ok(!view(vt).includes('? 1 awaiting'), 'the parked count returns to zero')
  subscription()
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

test('B4A-06c a wheel on the window never scrolls the transcript behind it, boundary included', async () => {
  const h = startQuick({ cols: 120, rows: 40, taskRead: false, roster: [
    job('j1', 'build', 'running'), job('j2', 'test', 'running'), job('j3', 'lint', 'running'),
    job('j4', 'deploy', 'running'), job('j5', 'audit', 'running'), job('j6', 'docs', 'running'),
  ] })
  await flush()
  // A scrollable transcript behind the window: an unconsumed wheel WOULD move it.
  h.app.setTranscript(Array.from({ length: 40 }, (_, index) => ({
    kind: 'assistant' as const, turn: index, text: `history row ${index}`,
  })))
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  const scroll = h.app.fullscreenScrollForTest()
  assert.ok(scroll, 'the fullscreen transcript pane must exist')
  assert.ok(scroll.maxScrollTop > 0, 'the transcript must be scrollable for this witness')
  const band = h.band()
  assert.match(strip(rawView(h.vt)[band.identity]!), /showing 1-3\/6$/)
  const before = { scrollTop: scroll.scrollTop, following: scroll.isFollowingEnd }
  // At the window's TOP boundary an upward wheel must stay with the window.
  h.vt.sendInput(`\x1b[<64;5;${band.identity + 2}M`)
  await h.vt.waitForRender()
  await flush(2)
  const afterUp = h.app.fullscreenScrollForTest()!
  assert.equal(afterUp.scrollTop, before.scrollTop, `the transcript must not move under a boundary wheel:\n${view(h.vt)}`)
  assert.equal(afterUp.isFollowingEnd, before.following, 'the follow state must not flip')
  assert.match(strip(rawView(h.vt)[h.band().identity]!), /showing 1-3\/6$/, 'the window stays at its top boundary')
})

test('B4A-06d a resize that has not been repainted refuses the wheel, then resolves against the new frame', async () => {
  const h = startQuick({ cols: 120, rows: 40, taskRead: false, roster: [
    job('j1', 'build', 'running'), job('j2', 'test', 'running'), job('j3', 'lint', 'running'),
    job('j4', 'deploy', 'running'),
  ] })
  await flush()
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  const band = h.band()
  assert.match(strip(rawView(h.vt)[band.identity]!), /showing 1-3\/4$/)
  // The screen row of the first painted item in the 120x40 frame.
  const itemRow = rowOf(h.vt, itemRows(h.vt)[0]!)
  // The resize lands on the terminal BEFORE the repaint: the pointer event still
  // carries the stale painted box, so only the LIVE-geometry fence can refuse it.
  h.vt.resize(120, 8)
  h.vt.sendInput(`\x1b[<65;5;${itemRow + 1}M`)
  await h.vt.waitForRender()
  await flush(2)
  // The repainted frame proves the refusal: the window is still at its first row
  // (an accepted stale wheel would have moved it to `2-2/4`).
  const shrunk = itemRows(h.vt)
  assert.equal(shrunk.length, 1, `the new frame keeps one task row:\n${view(h.vt)}`)
  assert.match(shrunk[0]!, /bash · build\s+‣ Running\s+1-1\/4$/, 'a pre-repaint wheel must not move the window')
  // The SAME gesture now resolves against the current frame.
  h.vt.sendInput(`\x1b[<65;5;${rowOf(h.vt, shrunk[0]!) + 1}M`)
  await h.vt.waitForRender()
  assert.match(itemRows(h.vt)[0]!, /bash · test\s+‣ Running\s+2-2\/4$/, `the new frame owns the wheel:\n${view(h.vt)}`)
})

test('B4A-06e a stale width resize still owns the in-band wheel: the transcript never scrolls', async () => {
  const h = startQuick({ cols: 120, rows: 40, taskRead: false, roster: [
    job('j1', 'build', 'running'), job('j2', 'test', 'running'), job('j3', 'lint', 'running'),
    job('j4', 'deploy', 'running'), job('j5', 'audit', 'running'),
  ] })
  await flush()
  // A scrollable transcript behind the window: an unconsumed wheel WOULD move it.
  h.app.setTranscript(Array.from({ length: 40 }, (_, index) => ({
    kind: 'assistant' as const, turn: index, text: `history row ${index}`,
  })))
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  const before = h.app.fullscreenScrollForTest()
  assert.ok(before && before.maxScrollTop > 0, 'the transcript must be scrollable for this witness')
  assert.equal(before.isFollowingEnd, true)
  const itemRow = rowOf(h.vt, itemRows(h.vt)[0]!)
  const windowBefore = itemRows(h.vt)
  // A WIDTH resize lands on the terminal before the repaint: the pointer is still
  // over the painted band of the old frame.
  h.vt.resize(100, 40)
  h.vt.sendInput(`\x1b[<64;5;${itemRow + 1}M`)
  await flush(1)
  const mid = h.app.fullscreenScrollForTest()!
  assert.equal(mid.scrollTop, before.scrollTop,
    'a stale in-band wheel must not fall through and scroll the transcript')
  assert.equal(mid.isFollowingEnd, before.isFollowingEnd, 'the follow state must not flip')
  // After the repaint the window's own anchor is unchanged as well.
  await h.vt.waitForRender()
  await flush(2)
  assert.deepEqual(itemRows(h.vt).map(line => line.split(/\s+‣\s+/)[0]), windowBefore.map(line => line.split(/\s+‣\s+/)[0]))
  assert.equal(h.app.fullscreenScrollForTest()!.scrollTop, before.scrollTop, 'the transcript is still untouched')
})

test('B4A-06f an emptied roster owns its band until the blank frame is painted', async () => {
  const h = startQuick({ cols: 120, rows: 40, taskRead: false, roster: [
    job('j1', 'build', 'running'), job('j2', 'test', 'running'), job('j3', 'lint', 'running'),
    job('j4', 'deploy', 'running'),
  ] })
  await flush()
  // A scrollable transcript behind the window: an unconsumed wheel WOULD move it.
  h.app.setTranscript(Array.from({ length: 40 }, (_, index) => ({
    kind: 'assistant' as const, turn: index, text: `history row ${index}`,
  })))
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  const before = h.app.fullscreenScrollForTest()
  assert.ok(before && before.maxScrollTop > 0, 'the transcript must be scrollable for this witness')
  assert.equal(before.isFollowingEnd, true)
  const itemRow = rowOf(h.vt, itemRows(h.vt)[0]!)
  // The roster empties and the projection is published SYNCHRONOUSLY, before the
  // deferred repaint: the old band is still on screen.
  h.roster.rows = []
  h.tasks.refreshTasks()
  h.vt.sendInput(`\x1b[<64;5;${itemRow + 1}M`)
  await flush(1)
  const mid = h.app.fullscreenScrollForTest()!
  assert.equal(mid.scrollTop, before.scrollTop,
    'an in-band wheel during the emptied-but-unpainted window must not scroll the transcript')
  assert.equal(mid.isFollowingEnd, before.isFollowingEnd, 'the follow state must not flip')
  // The repaint paints the blank band and retires the hit geometry.
  await h.vt.waitForRender()
  await flush(2)
  assert.deepEqual(itemRows(h.vt), [], `the emptied window paints nothing:\n${view(h.vt)}`)
  // The band's rows return to the transcript pane, which stays FOLLOWING the end:
  // its scrollTop settles on the new (larger-viewport) maximum — a layout
  // consequence, never the wheel.
  const after = h.app.fullscreenScrollForTest()!
  assert.equal(after.isFollowingEnd, true, 'the pane still follows the end')
  assert.equal(after.scrollTop, after.maxScrollTop, 'the pane sits at the end of the grown viewport')
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
  // A CUSTOM palette is read live as well (no token is captured at module scope).
  setTheme('custom', { ...lightColors, textStrong: '#123456', warning: '#654321' })
  h.app.requestRender()
  await h.vt.waitForRender()
  assert.equal(ink('Task Quick', 'Task Quick'), hexToRgb('#123456'))
  assert.equal(ink('bash · deploy', '‣'), hexToRgb('#654321'))
  // Icon density is NOT part of the chrome vocabulary: the accessory paints no
  // icon, so its rows stay byte-identical when the density changes.
  const symbolRows = itemRows(h.vt)
  h.app.setIconStyle('minimal')
  await h.vt.waitForRender()
  assert.deepEqual(itemRows(h.vt), symbolRows, 'the accessory is independent of the icon density')
  // Nothing new entered the chrome vocabulary.
  assert.equal(/→|●|○|◐|×|│|╭|─/.test(itemRows(h.vt).join('')), false, `only the frozen vocabulary:\n${view(h.vt)}`)
  setTheme('dark')
})

test('B4A-05e the resident window coexists with a live PUBLIC below widget', async () => {
  const h = startQuick({ cols: 120, rows: 40, taskRead: false, widgetBelow: 'BELOW-WIDGET', roster: [
    job('j1', 'build', 'running'), job('j2', 'test', 'running'),
  ] })
  await flush()
  await h.vt.waitForRender()
  const lines = rawView(h.vt)
  const editor = h.editor()
  const widgetRow = rowOf(h.vt, 'BELOW-WIDGET')
  const firstItemRow = rowOf(h.vt, itemRows(h.vt)[0]!)
  assert.ok(widgetRow >= 0, `the public below widget must still paint:\n${view(h.vt)}`)
  // Editor seat -> first-party accessory -> public below widget -> footer.
  assert.ok(firstItemRow > editor.bottom, `the accessory sits below the seat:\n${view(h.vt)}`)
  assert.ok(widgetRow > firstItemRow, `the PUBLIC slot keeps its position under the accessory:\n${view(h.vt)}`)
  for (const footerRow of h.app.footerRenderRowsForTest().map(strip).map(line => line.trimEnd())) {
    if (footerRow === '') continue
    assert.ok(lines.some(line => line.includes(footerRow)), `the footer is not pushed out: ${JSON.stringify(footerRow)}`)
  }
})

test('B4A-05f the FULLSCREEN root paints the public below widget beside the window', async () => {
  const h = startQuick({ cols: 120, rows: 40, taskRead: false, widgetBelow: 'BELOW-WIDGET', roster: [
    job('j1', 'build', 'running'), job('j2', 'test', 'running'), job('j3', 'lint', 'running'),
  ] })
  await flush()
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  const lines = rawView(h.vt)
  const firstItemRow = rowOf(h.vt, itemRows(h.vt)[0]!)
  const widgetRow = rowOf(h.vt, 'BELOW-WIDGET')
  const scroll = h.app.fullscreenScrollForTest()
  assert.ok(scroll, 'the fullscreen transcript pane must exist')
  assert.ok(firstItemRow >= 0, `the window paints in fullscreen:\n${view(h.vt)}`)
  assert.ok(widgetRow >= 0, `the public below widget still paints in fullscreen:\n${view(h.vt)}`)
  // editor seat -> first-party accessory -> public below widget -> footer.
  assert.ok(widgetRow > firstItemRow, `the PUBLIC slot keeps its position under the accessory:\n${view(h.vt)}`)
  // Neither band starves the pinned transcript: both reservations hold at once.
  assert.ok(scroll.viewportHeight >= 1, `the transcript floor survives both bands:\n${view(h.vt)}`)
  for (const footerRow of h.app.footerRenderRowsForTest().map(strip).map(line => line.trimEnd())) {
    if (footerRow === '') continue
    assert.ok(lines.some(line => line.includes(footerRow)), `the footer stays painted: ${JSON.stringify(footerRow)}`)
  }
})

test('B4A-04b after the modal acknowledges, the window still paints the REAL failed state', async () => {
  const h = startQuick({ cols: 120, rows: 40, roster: [job('j2', 'deploy', 'failed')] })
  await flush()
  await h.vt.waitForRender()
  assert.ok(view(h.vt).includes('! 1 failed'), `the unacknowledged failure is footer attention:\n${view(h.vt)}`)
  assert.match(itemRows(h.vt)[0]!, /bash · deploy\s+‣ Failed$/)
  h.tasks.openTasksBrowser('quick')
  await h.vt.waitForRender()
  await flush(2)
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  await flush(2)
  // The acknowledgement clears the FOOTER attention…
  assert.ok(!view(h.vt).includes('! 1 failed'), `the acknowledged failure leaves the badge:\n${view(h.vt)}`)
  // …while the resident window keeps reporting the task's own real state: being
  // acknowledged is not being unfailed.
  assert.match(itemRows(h.vt)[0]!, /bash · deploy\s+‣ Failed$/)
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
