/**
 * Phase 3B / B1-C — the Job Command reader, the original-text drag selection and
 * the two Copy verbs (plan matrix C-01…C-18).
 *
 * The pure cases prove the original-UTF-16 offset mapping; the component cases
 * prove the mutual Command/Output pages, the header hit map and the key ladder;
 * the L6 cases drive the REAL `TuiApp` + `TuiAltScreen` + `VirtualTerminal` with
 * native SGR mouse bytes and the REAL `TaskRuntime` observation path, so the
 * copied payload is produced by the same consumer the user runs.
 *
 * @module @xmoon76/dsh-pi-tui/test/job-command-reader
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import type { OwnedRunner } from '../src/tui-app.ts'
import { TuiApp } from '../src/tui-app.ts'
import { JobInspectorPanel, type JobCopyRequest, type JobInspectorPanelIntents } from '../src/tui/panels/job-inspector-panel.ts'
import {
  buildCommandVisualLayout,
  commandPointOffset,
  commandRowSelectionColumns,
  commandSelectionRange,
} from '../src/tui/panels/job-command-document.ts'
import { createTaskRuntime, type JobInspectorState, type TaskRuntime, type TaskSurfaceSource } from '../src/app/surface/task-runtime.ts'
import { DirectJobObservationPort } from '../src/runtime/direct/job-observation-direct.ts'
import type { TaskBrowserJobInput } from '../src/domain/task/browser.ts'
import type { SessionSubject } from '../src/app/session/subject.ts'
import type { JobObservedSnapshot, JobObservationPort, JobStopOutcome } from '../src/runtime/job-observation-port.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
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

const rawView = (vt: VirtualTerminal): string[] => vt.getViewport().map(stripTerminalSequences)
const view = (vt: VirtualTerminal): string => rawView(vt).join('\n')
const rowOf = (vt: VirtualTerminal, needle: string): number =>
  rawView(vt).findIndex(line => line.includes(needle))

async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

// ── pure layer: the original UTF-16 offset mapping ─────────────────────────

/** `label.slice(range)` for one gesture between two document points. */
const sliceSelection = (
  source: string,
  width: number,
  anchor: readonly [number, number],
  focus: readonly [number, number],
): string | undefined => {
  const layout = buildCommandVisualLayout(source, width)
  const range = commandSelectionRange(layout, { row: anchor[0], col: anchor[1] }, { row: focus[0], col: focus[1] })
  return range === undefined ? undefined : source.slice(range.start, range.end)
}

test('C-07/C-09 whitespace, trailing spaces, CRLF and hard breaks survive the selection byte for byte', () => {
  // Hard breaks keep their ORIGINAL bytes: `\n` and `\r\n` are never re-written.
  assert.equal(sliceSelection('ab\ncd', 80, [0, 0], [1, 1]), 'ab\ncd')
  assert.equal(sliceSelection('ab\ncd', 80, [1, 1], [0, 0]), 'ab\ncd')
  assert.equal(sliceSelection('ab\r\ncd', 80, [0, 1], [1, 0]), 'b\r\nc')
  // A SOFT wrap inserts nothing: the wrapped rows are one continuous range.
  assert.equal(sliceSelection('abcdef', 3, [0, 0], [1, 0]), 'abcd')
  // Trailing and leading spaces have their own offsets.
  assert.equal(sliceSelection('ab   ', 80, [0, 0], [0, 4]), 'ab   ')
  assert.equal(sliceSelection('   ab', 80, [0, 1], [0, 2]), '  ')
  // An indented line keeps exactly its 1/2/3/4 leading spaces.
  for (const indent of [1, 2, 3, 4]) {
    const source = `${' '.repeat(indent)}x`
    assert.equal(sliceSelection(source, 80, [0, 0], [0, indent]), `${' '.repeat(indent)}x`)
  }
  // A real trailing newline is part of the source range.
  assert.equal(sliceSelection('abc\n', 80, [0, 0], [0, 2]), 'abc')
  // Multiple newlines produce their own (empty) rows and stay copyable.
  assert.equal(sliceSelection('a\n\nb', 80, [0, 0], [2, 0]), 'a\n\nb')
  // A click (same cell) is never a copy.
  assert.equal(sliceSelection('abc', 80, [0, 1], [0, 1]), undefined)
  // Terminal padding to the right edge is NOT a source run.
  assert.equal(sliceSelection('ab', 80, [0, 0], [0, 40]), 'ab')
})

test('C-08 TAB, spaces, CJK, combining marks, emoji and grapheme safety', () => {
  // TAB paints three cells but maps the ONE original `\t`; three literal spaces
  // map three spaces.
  assert.equal(sliceSelection('a\tb', 80, [0, 1], [0, 4]), '\tb')
  assert.equal(sliceSelection('a\tb', 80, [0, 1], [0, 2]), '\t')
  assert.equal(sliceSelection('a   b', 80, [0, 1], [0, 3]), '   ')
  // A wide grapheme is never cut in half.
  assert.equal(sliceSelection('中文', 80, [0, 0], [0, 3]), '中文')
  assert.equal(sliceSelection('中文a', 80, [0, 2], [0, 5]), '文a')
  // A combining mark rides on its base grapheme: the selection can never cut it
  // away from the base it belongs to.
  assert.equal(sliceSelection('ab\u0301c', 80, [0, 0], [0, 1]), 'ab\u0301')
  // A ZWJ emoji cluster is one grapheme with its own cell span.
  const emoji = 'a👨‍👩‍👧b'
  assert.equal(sliceSelection(emoji, 80, [0, 1], [0, 2]), '👨‍👩‍👧')
  // A grapheme wider than the WHOLE grant still copies in full.
  assert.equal(sliceSelection('中', 1, [0, 0], [0, 1]), '中')
})

test('C-09/C-10 a long single line soft-wraps without inventing LF, and control bytes stay safe', () => {
  const long = '0123456789ABCDEF'
  // Width 12: rows `0123456789AB` and `CDEF`.
  assert.equal(sliceSelection(long, 12, [0, 0], [1, 0]), '0123456789ABC')
  assert.equal(sliceSelection(long, 12, [0, 0], [1, 3]), long)
  // Raw ESC/OSC/C0 text is DISPLAYED as a safe escape but copied as the ORIGINAL
  // bytes — the display never becomes the payload.
  const escape = 'a\u001b[31mb'
  const layout = buildCommandVisualLayout(escape, 80)
  assert.equal(layout.rows[0]!.rendered, 'a\\x1b[31mb')
  assert.equal(sliceSelection(escape, 80, [0, 0], [0, 10]), escape)
  assert.equal(sliceSelection(escape, 80, [0, 1], [0, 5]), '\u001b[')
  const nul = 'a\u0000b'
  assert.equal(buildCommandVisualLayout(nul, 80).rows[0]!.rendered, 'a\\x00b')
  assert.equal(sliceSelection(nul, 80, [0, 0], [0, 5]), nul)
  // A lone CR is a VISIBLE token, never a hard break, and never painted raw.
  const loneCr = buildCommandVisualLayout('a\rb', 80)
  assert.equal(loneCr.rows.length, 1)
  assert.equal(loneCr.rows[0]!.rendered, 'a\\rb')
  assert.equal(sliceSelection('a\rb', 80, [0, 0], [0, 2]), 'a\r')
  // C1 / DEL are escaped too.
  assert.equal(buildCommandVisualLayout('\u009bx', 80).rows[0]!.rendered, '\\x9bx')
  assert.equal(buildCommandVisualLayout('\u007fx', 80).rows[0]!.rendered, '\\x7fx')
})

test('C-05 the pure layout never exceeds the grant and pads nothing into the source', () => {
  for (const width of [1, 3, 12, 44, 80]) {
    for (const source of ['', 'a', 'a\tb', '中文测试', 'a\u001b[1mb', 'x\n\ny', '   ', 'a'.repeat(200)]) {
      const layout = buildCommandVisualLayout(source, width)
      assert.ok(layout.rows.length >= 1, 'a document always has at least one visual row')
      for (const row of layout.rows) {
        assert.ok(visibleWidth(row.rendered) <= width, `row display fits the grant at width ${width}`)
        for (const run of row.runs) {
          assert.ok(run.startCol < width && run.endCol <= width, 'no run may exceed the grant')
          assert.ok(run.sourceStart <= run.sourceEnd, 'a run maps a forward source range')
          assert.ok(run.sourceEnd <= source.length, 'a run maps inside the source')
        }
        // Concatenating every run's display reproduces the painted row: the
        // source of truth is the run map, never the rendered string alone.
        assert.equal(row.runs.map(run => run.display).join(''), row.rendered)
      }
    }
  }
  // The display columns of one source range come from the same map.
  const layout = buildCommandVisualLayout('a\tb', 80)
  assert.deepEqual(commandRowSelectionColumns(layout, 0, 1, 2), { startCol: 1, endCol: 4 })
  assert.deepEqual(commandRowSelectionColumns(layout, 0, 1, 3), { startCol: 1, endCol: 5 })
})

// ── component layer: the two mutually exclusive pages ──────────────────────

const observedState = (patch: Partial<JobObservedSnapshot> = {}): JobInspectorState => ({
  opening: { jobId: 'job-a', kind: 'bash', label: 'job a', status: 'running' },
  observed: {
    jobId: 'job-a',
    kind: 'bash',
    label: 'echo one',
    status: 'running',
    text: 'retained tail',
    gapBefore: false,
    settled: false,
    ...patch,
  },
})

interface PanelHarness {
  readonly panel: JobInspectorPanel
  readonly copies: JobCopyRequest[]
  readonly closed: () => number
  readonly rows: { value: number }
  /** Every native copy-on-select request the panel made, in order. */
  readonly nativeCopy: boolean[]
}

function makePanel(state: JobInspectorState, overrides: Partial<JobInspectorPanelIntents> = {}): PanelHarness {
  const copies: JobCopyRequest[] = []
  const nativeCopy: boolean[] = []
  let closes = 0
  const rows = { value: 24 }
  const panel = new JobInspectorPanel(state, {
    rows: () => rows.value,
    requestRender: () => {},
    notice: () => undefined,
    onClose: () => { closes += 1 },
    canStop: () => true,
    onStop: () => {},
    onCopy: (request) => copies.push(request),
    paintedBox: () => undefined,
    setNativeCopyOnSelect: (enabled) => nativeCopy.push(enabled),
    isFindKey: () => false,
    findHint: () => '',
    focusComponent: () => {},
    ...overrides,
  })
  return { panel, copies, closed: () => closes, rows, nativeCopy }
}

/** Render one committed frame (so `onFramePainted` sees this frame's targets). */
const paint = (harness: PanelHarness, width = 80): string[] => {
  const lines = harness.panel.render(width)
  harness.panel.onFramePainted()
  return lines
}

test('C-03 a non-shell kind never grows a Command page or a Command Copy verb', () => {
  const harness = makePanel(observedState({ kind: 'subagent', label: 'echo one' }))
  const painted = paint(harness, 120).join('\n')
  assert.match(painted, /Label: echo one/, 'a non-shell label is shown as a Label')
  assert.ok(!/V command/.test(painted), 'no Command entry is advertised')
  harness.panel.handleInput('v')
  const after = paint(harness, 120).join('\n')
  assert.ok(!/Command reader/.test(after), '`v` cannot open a Command page')
  // `C` on the Output page is the INDEPENDENT retained-Output copy: a non-shell
  // Job still copies its retained text, never a fabricated command.
  harness.panel.handleInput('C')
  assert.deepEqual(harness.copies, [{ source: 'output', text: 'retained tail' }])
  harness.panel.dispose()
})

test('C-04 the opening row is never a Command source: only the observed label opens Copy All', () => {
  // No observed snapshot yet: the opening row may show a read-only summary, but
  // the Command page and Copy All must not become true early.
  const opening = makePanel({ opening: { jobId: 'job-a', kind: 'bash', label: 'pnpm build', status: 'running' } })
  const before = paint(opening, 120).join('\n')
  assert.match(before, /Command: pnpm build/)
  assert.ok(!/V command/.test(before), 'the opening row alone does not advertise V')
  opening.panel.handleInput('v')
  assert.ok(!/Command reader/.test(paint(opening, 120).join('\n')), 'no Command page before the first observation')
  opening.panel.handleInput('C')
  assert.deepEqual(opening.copies, [{ source: 'output', text: '', unavailable: 'output-unavailable' }],
    'no Output copy without an observation: the UNAVAILABLE reason is reported so the app can say so')
  opening.panel.dispose()

  // The SAME instance becomes eligible once the observation arrives.
  const live = makePanel({ opening: { jobId: 'job-a', kind: 'bash', label: 'pnpm build', status: 'running' } })
  live.panel.update(observedState({ label: 'pnpm build --watch' }))
  assert.match(paint(live, 120).join('\n'), /V command/, 'a wide Output bar advertises the Command entry')
  live.panel.handleInput('v')
  const command = paint(live, 120).join('\n')
  assert.match(command, /Command reader · \[Copy All\]/)
  assert.match(command, /Esc output/)
  live.panel.handleInput('C')
  assert.deepEqual(live.copies, [{ source: 'command-all', text: 'pnpm build --watch' }])
  live.panel.dispose()
})

test('C-05/C-06 the Command page owns one body and its own viewport at every budget', () => {
  for (const budget of [{ width: 120, rows: 40 }, { width: 80, rows: 24 }, { width: 44, rows: 8 }, { width: 44, rows: 4 }]) {
    const harness = makePanel(observedState({ label: `long command ${'x'.repeat(300)}` }))
    harness.rows.value = budget.rows
    harness.panel.handleInput('v')
    const lines = paint(harness, budget.width)
    for (const line of lines) {
      assert.ok(stripTerminalSequences(line).length <= budget.width * 2, `no over-wide row at ${budget.width}x${budget.rows}`)
    }
    const painted = lines.join('\n')
    assert.match(painted, /Esc output/, `the Command bar is pinned at ${budget.width}x${budget.rows}`)
    assert.ok(!/V command/.test(painted), 'the Output-only verb is absent on the Command page')
    assert.ok(!/Follow ON|Follow PAUSED/.test(painted), 'the Command page never claims a Follow state')
    assert.ok(!/Retained preview/.test(painted), 'the Command page never claims a retained preview')
    assert.match(painted, /Full command/)
    assert.match(lines.at(-1)!, /Esc output/, 'the Action Bar is the last row')
    harness.panel.handleInput('\x1b')
    assert.match(paint(harness, budget.width).join('\n'), /Esc back/, 'Esc returns to Output')
    harness.panel.dispose()
  }
})

test('C-15 the two pages own independent Find state, and `C` in EDIT never copies', () => {
  const harness = makePanel(observedState({ label: 'alpha beta gamma' }))
  // Output Find.
  harness.panel.openFind()
  harness.panel.handleInput('beta')
  harness.panel.handleInput('\r')
  const outputSearch = paint(harness).join('\n')
  assert.match(outputSearch, /Find Output:/)
  assert.equal(harness.copies.length, 0, 'Enter only navigates')
  // `C` while a Find owns the ordinary keys is inert.
  harness.panel.handleInput('C')
  assert.equal(harness.copies.length, 0, '`C` in NAVIGATE must not copy')
  harness.panel.handleInput('\x1b')
  assert.equal(harness.copies.length, 0, 'Esc leaves NAVIGATE only')
  // Switch to Command: its OWN query, never the Output one.
  harness.panel.handleInput('v')
  assert.ok(!/Find Output: beta/.test(paint(harness).join('\n')), 'the Output query is not inherited')
  harness.panel.openFind()
  const commandFind = paint(harness).join('\n')
  assert.match(commandFind, /Find Command:/)
  assert.ok(!/beta/.test(commandFind.split('\n').find(line => line.includes('Find Command:')) ?? ''), 'a fresh Command query')
  harness.panel.handleInput('alpha')
  harness.panel.handleInput('C')
  assert.equal(harness.copies.length, 0, '`C` in Command EDIT goes to the query, never the clipboard')
  harness.panel.handleInput('\x1b')
  harness.panel.handleInput('C')
  assert.deepEqual(harness.copies, [{ source: 'command-all', text: 'alpha beta gamma' }])
  // Back to Output: its query survived, the Command query did not transfer.
  harness.panel.handleInput('\x1b')
  harness.panel.openFind()
  assert.match(paint(harness).join('\n'), /Find Output: beta/)
  harness.panel.handleInput('\x1b')
  // The fork's native copy-on-select follows the SAME page switch: suspended on
  // the Command page (its exact copy must not race a word selection), restored
  // on Output.
  assert.deepEqual(harness.nativeCopy, [false, true], 'the native copy flag follows the reading page')
  harness.panel.dispose()
})

test('C-14 an empty / unavailable / ineligible copy source reports its own reason and never writes', () => {
  // Observed, but nothing retained: the empty body has its own reason.
  const empty = makePanel(observedState({ text: '' }))
  paint(empty)
  empty.panel.handleInput('C')
  assert.deepEqual(empty.copies, [{ source: 'output', text: '', unavailable: 'output-empty' }],
    'an empty retained Output names the EMPTY reason')
  empty.panel.dispose()

  // No observation at all: a DIFFERENT reason, so the user learns which state
  // they are looking at (plan §3).
  const connecting = makePanel({ opening: { jobId: 'job-a', kind: 'bash', label: 'pnpm build', status: 'running' } })
  paint(connecting)
  connecting.panel.handleInput('C')
  assert.deepEqual(connecting.copies, [{ source: 'output', text: '', unavailable: 'output-unavailable' }],
    'a not-yet-observed Output names the UNAVAILABLE reason')
  connecting.panel.dispose()

  const failed = makePanel({
    opening: { jobId: 'job-a', kind: 'bash', label: 'pnpm build', status: 'running' },
    observationError: 'no job controller',
  })
  paint(failed)
  failed.panel.handleInput('C')
  assert.deepEqual(failed.copies, [{ source: 'output', text: '', unavailable: 'output-unavailable' }],
    'a refused observation names the UNAVAILABLE reason')
  failed.panel.dispose()

  // An empty label is not a Command page at all; the Output path still answers.
  const emptyLabel = makePanel(observedState({ label: '', text: '' }))
  paint(emptyLabel)
  emptyLabel.panel.handleInput('v')
  assert.ok(!/Command reader/.test(paint(emptyLabel).join('\n')), 'an empty label is not a Command')
  emptyLabel.panel.handleInput('C')
  assert.deepEqual(emptyLabel.copies, [{ source: 'output', text: '', unavailable: 'output-empty' }],
    'nothing is copyable, and the reason is the empty body')
  emptyLabel.panel.dispose()

  // Losing Command eligibility returns to Output synchronously, so the NEXT
  // copy intent is an Output intent with the Output reason — the Command page is
  // never left as a hidden copy owner (plan §1.1 / §3).
  const lost = makePanel(observedState({ label: 'echo one' }))
  paint(lost)
  lost.panel.handleInput('v')
  assert.match(paint(lost).join('\n'), /Command reader/)
  lost.panel.update({ opening: { jobId: 'job-a', kind: 'bash', label: 'echo one', status: 'running' } })
  assert.ok(!/Command reader/.test(paint(lost).join('\n')), 'a lost Command eligibility returns to Output')
  lost.panel.handleInput('C')
  assert.deepEqual(lost.copies, [{ source: 'output', text: '', unavailable: 'output-unavailable' }],
    'the copy intent now belongs to the Output page, with its own reason')
  lost.panel.dispose()
})

test('C-16/C-06 an Output Follow/PAUSED position survives a round trip through the Command page', async () => {
  const harness = startApp()
  await openFirstJob(harness)
  const text = Array.from({ length: 80 }, (_, index) => `line ${String(index).padStart(3, '0')}`).join('\n')
  harness.tasks.observation.latest()!.emit({ label: 'echo hello', text })
  await harness.vt.waitForRender()
  await flush(2)
  // Follow ON: the newest retained row is visible.
  assert.match(view(harness.vt), /Follow ON/)
  assert.ok(bodyRow(harness.vt, 'line 079') >= 0)
  // Pause with PageUp and remember the topmost visible retained row.
  harness.vt.sendInput('\x1b[5~')
  await harness.vt.waitForRender()
  await flush(2)
  assert.match(view(harness.vt), /Follow PAUSED/)
  const pausedTop = firstBodyLine(harness.vt)
  assert.notEqual(pausedTop, '', `the paused body must still paint retained rows:\n${view(harness.vt)}`)
  // Round trip through the Command page: scrolling THERE must not touch Output.
  await openCommand(harness)
  assert.equal(rowOf(harness.vt, 'line 079'), -1, 'the Output body is not painted on the Command page')
  harness.vt.sendInput('\x1b[6~')
  await harness.vt.waitForRender()
  harness.vt.sendInput('\x1b')
  await harness.vt.waitForRender()
  await flush(2)
  assert.match(view(harness.vt), /Follow PAUSED/, 'the Output page never re-arms Follow')
  assert.equal(firstBodyLine(harness.vt), pausedTop, 'the Output viewport is exactly where the user left it')
  // Physical End on the Output page is still the ONLY Follow re-arm.
  harness.vt.sendInput('\x1b[F')
  await harness.vt.waitForRender()
  await flush(2)
  assert.match(view(harness.vt), /Follow ON/)
  assert.ok(bodyRow(harness.vt, 'line 079') >= 0, 'the newest retained row is followed again')
})

test('C-18 the header click must re-prove the same painted target; a narrowed button has no target', () => {
  const harness = makePanel(observedState({ label: 'echo one' }))
  const lines = paint(harness)
  const commandRow = lines.findIndex(line => line.includes('Command: echo one'))
  assert.ok(commandRow >= 0)
  // Press on the summary, repaint with ANOTHER label, release on the same cell:
  // the document key changed, so the click must not open the old Command page.
  harness.panel.onHeaderPress(2, commandRow)
  harness.panel.update(observedState({ label: 'echo two' }))
  paint(harness)
  harness.panel.onHeaderClick(2, commandRow)
  assert.ok(!/Command reader/.test(paint(harness).join('\n')), 'a ghost click must not open a Command page')
  // Press + release on the SAME painted target DOES open it.
  harness.panel.onHeaderPress(2, commandRow)
  harness.panel.onHeaderClick(2, commandRow)
  const command = paint(harness).join('\n')
  assert.match(command, /Command reader · \[Copy All\]/)
  harness.panel.dispose()

  // A too-narrow frame cannot paint the Copy All button: it must not create a
  // click target there, while the `C` key stays reachable.
  const narrow = makePanel(observedState({ label: 'echo one' }))
  narrow.panel.handleInput('v')
  const narrowLines = paint(narrow, 20).join('\n')
  assert.ok(!/\[Copy All\]/.test(narrowLines), 'the button is not painted on a narrow frame')
  narrow.panel.onHeaderPress(1, 1)
  narrow.panel.onHeaderClick(1, 1)
  assert.equal(narrow.copies.length, 0, 'an unpainted button has no click target')
  narrow.panel.handleInput('C')
  assert.deepEqual(narrow.copies, [{ source: 'command-all', text: 'echo one' }], '`C` remains the reachable path')
  narrow.panel.dispose()
})

test('C-12 a changed label or a resize cancels the gesture instead of copying stale offsets', async () => {
  const harness = startApp()
  await openFirstJob(harness)
  harness.tasks.observation.latest()!.emit({ label: 'abcdef' })
  await harness.vt.waitForRender()
  await flush(2)
  await openCommand(harness)
  const row = bodyRow(harness.vt, 'abcdef')
  // A REAL gesture, then the official label changes before the release: the old
  // offsets now describe other bytes.
  press(harness.vt, row, 0)
  drag(harness.vt, row, 3)
  harness.tasks.observation.latest()!.emit({ label: 'zyxwvu' })
  await harness.vt.waitForRender()
  await flush(2)
  release(harness.vt, row, 3)
  await flush(4)
  assert.deepEqual(harness.copied, [], 'a label change cancels the in-flight selection')
  // A resize has no proven column mapping either.
  press(harness.vt, row, 0)
  drag(harness.vt, row, 3)
  harness.vt.resize(100, 30)
  await harness.vt.waitForRender()
  await flush(2)
  release(harness.vt, row, 3)
  await flush(4)
  assert.deepEqual(harness.copied, [], 'a resize cancels the selection rather than re-mapping columns')
})

// ── L6: the real TuiApp + TaskRuntime + native SGR mouse ───────────────────

interface ObservationRecord {
  readonly jobId: string
  closes: number
  readonly emit: (patch: Partial<JobObservedSnapshot>) => void
}

class JobObservationDouble implements JobObservationPort {
  readonly records: ObservationRecord[] = []
  readonly stops: string[] = []
  stopOutcome: JobStopOutcome = { kind: 'requested' }
  /** When set, `open` refuses: the workspace presents the UNAVAILABLE phase. */
  openFailure: string | undefined

  open(_sessionId: string | undefined, jobId: string, listener: (snapshot: JobObservedSnapshot) => void): () => void {
    if (this.openFailure !== undefined) throw new Error(this.openFailure)
    const record: ObservationRecord = {
      jobId,
      closes: 0,
      emit: (patch) => listener({
        jobId,
        kind: 'bash',
        label: `job ${jobId}`,
        status: 'running',
        text: `retained ${jobId}`,
        gapBefore: false,
        settled: false,
        ...patch,
      }),
    }
    this.records.push(record)
    record.emit({})
    return () => { record.closes += 1 }
  }

  async stop(_sessionId: string, jobId: string): Promise<JobStopOutcome> {
    this.stops.push(jobId)
    return this.stopOutcome
  }

  latest(): ObservationRecord | undefined {
    return this.records.at(-1)
  }
}

interface TaskHarness {
  readonly tasks: TaskRuntime
  readonly observation: JobObservationDouble
}

/** The REAL Task Runtime over the real `/tasks` selection path. `port`
 *  replaces only the selected-Job observation adapter (the Direct L6 case drives
 *  the PRODUCTION `DirectJobObservationPort` this way). */
function attachTasks(
  app: TuiApp,
  jobIds: readonly string[],
  port?: JobObservationPort,
  rosterLabel?: string,
): TaskHarness {
  const jobSnapshots = (): TaskBrowserJobInput[] => jobIds.map((id, index) => ({
    id,
    kind: 'bash',
    label: rosterLabel ?? `job ${id}`,
    status: 'running',
    startedAt: 1_000 + index,
  }))
  const observation = new JobObservationDouble()
  const subject = {} as SessionSubject
  const source: TaskSurfaceSource = {
    sessionId: () => 'sess-main',
    captureSubject: () => subject,
    subjectMatches: candidate => candidate === subject,
    enterView: async () => {},
    interruptSubagent: async () => { throw new Error('not exercised') },
    rowSelectionDisposition: (row, jobDetail) => row === undefined || row.kind === 'job' ? jobDetail : 'close',
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: status => status,
    jobObservation: port ?? observation,
    jobs: { list: () => jobSnapshots(), subscribe: () => () => {} },
    taskRead: {
      currentKey: () => 'g1:sess-main',
      currentSessionId: () => 'sess-main',
      readTask: async () => ({
        parentSessionId: 'sess-main',
        parentAvailable: true,
        descendants: [],
        jobs: jobSnapshots(),
      }),
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
  return { tasks, observation }
}

interface AppHarness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly tasks: TaskHarness
  readonly copied: string[]
  readonly notices: string[]
}

/** Start the REAL app with a recording clipboard capability and an OWNED runner
 *  that really executes the task (so the payload chain stays real). */
function startApp(
  columns = 80,
  rows = 24,
  jobIds: readonly string[] = ['job-a'],
  port?: JobObservationPort,
  rosterLabel?: string,
): AppHarness {
  const vt = new VirtualTerminal(columns, rows)
  const copied: string[] = []
  const notices: string[] = []
  const owned: OwnedRunner = (_label, task, options) => {
    void Promise.resolve()
      .then(() => task())
      .then(
        result => options.onResult?.(result),
        error => options.onError?.(error),
      )
  }
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    runOwned: owned,
  }, {
    copySelection: async (text: string) => {
      copied.push(text)
      return true
    },
  })
  app.start()
  startedApps.add(app)
  const tasks = attachTasks(app, jobIds, port, rosterLabel)
  // The notice text is the app's ONE transient notice authority.
  const originalNotify = app.notify.bind(app)
  app.notify = (text: string, kind?: 'info' | 'error'): void => {
    notices.push(text)
    originalNotify(text, kind)
  }
  return { vt, app, tasks, copied, notices }
}

/** Open the first Job of the real `/tasks` browser through the real selection. */
async function openFirstJob(harness: AppHarness): Promise<void> {
  harness.tasks.tasks.openTasksBrowser('full')
  await harness.vt.waitForRender()
  harness.vt.sendInput('\r')
  await harness.vt.waitForRender()
}

/** Enter the Command page through the FIXED `v` key. */
async function openCommand(harness: AppHarness): Promise<void> {
  harness.vt.sendInput('v')
  await harness.vt.waitForRender()
  await flush(2)
}

const bodyRow = (vt: VirtualTerminal, needle: string): number => {
  const row = rowOf(vt, needle)
  assert.ok(row >= 0, `the painted frame must contain ${JSON.stringify(needle)}:\n${view(vt)}`)
  return row
}

/** The FIRST painted row matching a pattern (the Command document locator). */
const firstRowMatching = (vt: VirtualTerminal, pattern: RegExp): string => {
  for (const row of rawView(vt)) {
    const match = pattern.exec(row.trim())
    if (match !== null) return match[0]
  }
  return ''
}

/** The LAST painted row matching a pattern (the visible last body row). */
const lastRowMatching = (vt: VirtualTerminal, pattern: RegExp): string => {
  let found = ''
  for (const row of rawView(vt)) {
    const match = pattern.exec(row.trim())
    if (match !== null) found = match[0]
  }
  return found
}

/** The FIRST retained-body row of the painted frame, located by CONTENT
 *  (`line NNN`) rather than a fixed row index. */
const firstBodyLine = (vt: VirtualTerminal): string => {
  for (const row of rawView(vt)) {
    const match = /^(line \d{3})\b/.exec(row.trim())
    if (match !== null) return match[1]!
  }
  return ''
}

/** One native SGR left-button gesture (1-based terminal cells). */
const press = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`)
}
const drag = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<32;${col + 1};${row + 1}M`)
}
const release = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`)
}

test('C-01 the official Bash label reaches the Command page and Copy All copies it exactly once', async () => {
  const harness = startApp()
  await openFirstJob(harness)
  const label = '  pnpm build --watch --filter @xmoon76/dsh-pi-tui  \n'
  harness.tasks.observation.latest()!.emit({ label })
  await harness.vt.waitForRender()
  await flush(2)
  assert.equal(harness.tasks.observation.records.length, 1, 'ONE observer for the opened Job')

  // Reachable by the FIXED `v` key.
  await openCommand(harness)
  assert.match(view(harness.vt), /Command reader · \[Copy All\]/)

  harness.vt.sendInput('C')
  await flush(4)
  assert.deepEqual(harness.copied, [label], 'Copy All sends the ORIGINAL label, whitespace and trailing LF included')
  assert.equal(harness.notices.at(-1), 'Copy sent')
  assert.equal(harness.tasks.observation.records.length, 1, 'a Command copy never opens a second observer')
  assert.equal(harness.tasks.observation.latest()!.closes, 0, 'the copy never releases the observer')
})

test('C-01 the header Command summary click opens the Command page, and Copy All clicks copy the original', async () => {
  const harness = startApp()
  await openFirstJob(harness)
  const label = 'echo hello\nworld'
  harness.tasks.observation.latest()!.emit({ label })
  await harness.vt.waitForRender()
  await flush(2)
  const commandRow = bodyRow(harness.vt, 'Command: echo hello')
  // A REAL same-cell click through the native SGR path.
  press(harness.vt, commandRow, 4)
  release(harness.vt, commandRow, 4)
  await harness.vt.waitForRender()
  await flush(2)
  assert.match(view(harness.vt), /Command reader · \[Copy All\]/, 'the header click opens the Command page')
  // Click the painted [Copy All] button itself.
  const buttonRow = bodyRow(harness.vt, '[Copy All]')
  const buttonCol = rawView(harness.vt)[buttonRow]!.indexOf('[Copy All]')
  press(harness.vt, buttonRow, buttonCol + 2)
  release(harness.vt, buttonRow, buttonCol + 2)
  await flush(4)
  assert.deepEqual(harness.copied, [label], 'the painted button copies the ORIGINAL label')
  // plan §5: a REAL visible [Copy All] stays clickable while a Find owns the
  // keyboard, and the click changes nothing about the search.
  harness.copied.length = 0
  // Leave the fork's 500 ms double-click window: a second click on the same cell
  // would otherwise become a native word selection on this screen (pre-existing
  // B1-A behaviour), which is a different gesture from the header click.
  await new Promise<void>(resolve => setTimeout(resolve, 600))
  harness.vt.sendInput('/')
  await harness.vt.waitForRender()
  harness.vt.sendInput('hello')
  await harness.vt.waitForRender()
  await flush(2)
  assert.match(view(harness.vt), /Find Command: hello/, 'the Command query is being edited')
  press(harness.vt, buttonRow, buttonCol + 2)
  release(harness.vt, buttonRow, buttonCol + 2)
  await flush(4)
  assert.deepEqual(harness.copied, [label], 'the button copies the ORIGINAL label, never the query or a hit')
  const editing = view(harness.vt)
  assert.match(editing, /Find Command: hello/, 'the query is unchanged by the click')
  assert.match(editing, /Command reader · \[Copy All\]/, 'the click never switched pages')
  // The Search Input still owns the keyboard: the next character edits the query.
  harness.vt.sendInput('!')
  await harness.vt.waitForRender()
  await flush(2)
  assert.match(view(harness.vt), /Find Command: hello!/, 'the click never stole the search input focus')
  assert.deepEqual(harness.copied, [label], 'no duplicate copy from the extra typing')
})

test('C-11 a real SGR press→drag→release copies the exact original half-open range, forwards and backwards', async () => {
  const harness = startApp()
  await openFirstJob(harness)
  const label = 'abc\ndef'
  harness.tasks.observation.latest()!.emit({ label })
  await harness.vt.waitForRender()
  await flush(2)
  await openCommand(harness)
  const first = bodyRow(harness.vt, 'abc')
  const second = bodyRow(harness.vt, 'def')
  // Forward: press on `a`, drag onto `d`, release. The later point is inclusive.
  press(harness.vt, first, 0)
  drag(harness.vt, second, 0)
  release(harness.vt, second, 0)
  await flush(4)
  assert.deepEqual(harness.copied, ['abc\nd'], 'the forward drag keeps the original hard break')
  harness.copied.length = 0
  // Backward: press on `d`, drag back onto `c`. The range is SYMMETRIC: the
  // earlier point is start aligned and the later one end aligned, so the
  // grapheme the press landed on stays INSIDE the range (plan §2) — `d` is kept
  // here even though it was the pressed end.
  press(harness.vt, second, 0)
  drag(harness.vt, first, 2)
  release(harness.vt, first, 2)
  await flush(4)
  assert.deepEqual(harness.copied, ['c\nd'], 'the backward drag includes the pressed grapheme')
  harness.copied.length = 0
  // The two directions over one line are byte-identical (plan §2: `a -> c` and
  // `c -> a` both copy `abc`).
  harness.tasks.observation.latest()!.emit({ label: 'abc' })
  await harness.vt.waitForRender()
  await flush(2)
  const single = bodyRow(harness.vt, 'abc')
  press(harness.vt, single, 0)
  drag(harness.vt, single, 2)
  release(harness.vt, single, 2)
  await flush(4)
  assert.deepEqual(harness.copied, ['abc'], 'a -> c copies abc')
  harness.copied.length = 0
  press(harness.vt, single, 2)
  drag(harness.vt, single, 0)
  release(harness.vt, single, 0)
  await flush(4)
  assert.deepEqual(harness.copied, ['abc'], 'c -> a copies the SAME bytes')
  harness.copied.length = 0
  harness.tasks.observation.latest()!.emit({ label })
  await harness.vt.waitForRender()
  await flush(2)
  // A plain click (press + release on one cell) copies NOTHING.
  press(harness.vt, first, 1)
  release(harness.vt, first, 1)
  await flush(4)
  assert.deepEqual(harness.copied, [], 'a click is not a copy')
  // A drag that ends BELOW the body (on the Action Bar row) is clamped to the
  // body's own last visible row and stays inside the Command body.
  press(harness.vt, first, 0)
  drag(harness.vt, bodyRow(harness.vt, 'Esc output'), 10)
  release(harness.vt, bodyRow(harness.vt, 'Esc output'), 10)
  await flush(4)
  assert.deepEqual(harness.copied, [label], 'the captured gesture stays inside the Command body')
})

test('C-11 a drag on a TAB and on CJK copies the ORIGINAL characters, not the painted cells', async () => {
  const harness = startApp()
  await openFirstJob(harness)
  const label = 'a\tb 中文'
  harness.tasks.observation.latest()!.emit({ label })
  await harness.vt.waitForRender()
  await flush(2)
  await openCommand(harness)
  // `中文` is unique to the body row: the Job identity header also contains a
  // stray `a`, so the anchor must be located by content the body owns.
  const row = bodyRow(harness.vt, '中文')
  // The TAB paints cells 1..4; pressing anywhere inside it must yield `\t`.
  press(harness.vt, row, 1)
  drag(harness.vt, row, 2)
  release(harness.vt, row, 2)
  await flush(4)
  assert.deepEqual(harness.copied, ['\t'], 'a TAB cell copies the single original tab')
  harness.copied.length = 0
  // `b 中文`: cells 4..5 `b`, 5..6 space, 6..8 `中`, 8..10 `文`.
  press(harness.vt, row, 4)
  drag(harness.vt, row, 8)
  release(harness.vt, row, 8)
  await flush(4)
  assert.deepEqual(harness.copied, ['b 中文'], 'a wide grapheme is never cut in half')
})

test('C-11 edge auto-scroll follows the fork gesture: drag to the visible edge row, stop at the boundary', async () => {
  const harness = startApp(80, 24)
  await openFirstJob(harness)
  const label = Array.from({ length: 120 }, (_, index) => `cmd-${String(index).padStart(3, '0')}`).join('\n')
  harness.tasks.observation.latest()!.emit({ label })
  await harness.vt.waitForRender()
  await flush(2)
  await openCommand(harness)
  const barRow = bodyRow(harness.vt, 'Esc output')
  const topRow = bodyRow(harness.vt, 'cmd-000')
  assert.ok(bodyRow(harness.vt, 'cmd-020') > 0, 'the initially visible bottom row was located')
  // plan §6 rule 1: a press only anchors. Holding a press on the last visible
  // row must NOT start the timer.
  press(harness.vt, barRow - 1, 0)
  await new Promise<void>(resolve => setTimeout(resolve, 200))
  assert.equal(firstRowMatching(harness.vt, /^cmd-\d{3}/), 'cmd-000',
    'a press without a drag never auto-scrolls')
  release(harness.vt, barRow - 1, 0)
  await flush(2)
  // plan §6 rule 2: once the gesture has dragged, reaching the visible LAST row
  // scrolls, and the selection grows over rows that were not visible at press.
  press(harness.vt, topRow, 0)
  const lastVisibleCmd = bodyRow(harness.vt, lastRowMatching(harness.vt, /^cmd-\d{3}/))
  drag(harness.vt, lastVisibleCmd, 0)
  await new Promise<void>(resolve => setTimeout(resolve, 300))
  assert.notEqual(firstRowMatching(harness.vt, /^cmd-\d{3}/), 'cmd-000',
    'the visible LAST row starts the downward edge scroll')
  release(harness.vt, lastVisibleCmd, 0)
  await flush(4)
  assert.equal(harness.copied.length, 1, 'the auto-scrolled gesture still copies once')
  const grown = harness.copied[0]!
  assert.ok(grown.startsWith('cmd-000'), 'the gesture keeps its original anchor')
  assert.ok(grown.includes('cmd-021'), 'the edge timer advanced the selection past the first viewport')
  assert.ok(!grown.includes('cmd-119'), 'the selection never jumped to an off-screen document row')
  assert.ok(!grown.includes('\r'), 'no display escape leaked into the payload')
  assert.equal(grown, label.slice(0, grown.length), 'the payload is a contiguous original half-open range')
  harness.copied.length = 0
  // plan §6 rule 7: a release ends the gesture — no further scrolling happens.
  const afterRelease = firstRowMatching(harness.vt, /^cmd-\d{3}/)
  await new Promise<void>(resolve => setTimeout(resolve, 200))
  assert.equal(firstRowMatching(harness.vt, /^cmd-\d{3}/), afterRelease, 'a release stops the edge timer')

  // plan §6 rule 6: against a document short enough to reach the real end, the
  // timer stops instead of looping, and the selection ends on the LAST row.
  const short = Array.from({ length: 30 }, (_, index) => `row-${String(index).padStart(2, '0')}`).join('\n')
  harness.tasks.observation.latest()!.emit({ label: short })
  await harness.vt.waitForRender()
  await flush(2)
  // A new (shorter) document keeps the Command viewport: Home returns to its
  // first row so the boundary phase starts from a known position.
  harness.vt.sendInput('\x1b[H')
  await harness.vt.waitForRender()
  await flush(2)
  press(harness.vt, bodyRow(harness.vt, 'row-00'), 0)
  // Release a cell inside the last VISIBLE row's own text, so the inclusive end
  // alignment covers that whole row.
  const lastVisibleShort = bodyRow(harness.vt, lastRowMatching(harness.vt, /^row-\d{2}/))
  drag(harness.vt, lastVisibleShort, 5)
  await new Promise<void>(resolve => setTimeout(resolve, 700))
  const atBoundary = firstRowMatching(harness.vt, /^row-\d{2}/)
  await new Promise<void>(resolve => setTimeout(resolve, 250))
  assert.equal(firstRowMatching(harness.vt, /^row-\d{2}/), atBoundary,
    'the timer stops once the viewport can no longer move')
  release(harness.vt, lastVisibleShort, 5)
  await flush(4)
  const bounded = harness.copied[0]!
  assert.ok(bounded.endsWith('row-29'), 'the boundary hold reached the LAST document row')
  assert.equal(bounded, short.slice(0, bounded.length), 'and it is still one contiguous original range')
  harness.copied.length = 0
  // plan §6 rule 2 (reverse): the visible FIRST row scrolls back up.
  const viewTop = bodyRow(harness.vt, firstRowMatching(harness.vt, /^row-\d{2}/))
  press(harness.vt, bodyRow(harness.vt, lastRowMatching(harness.vt, /^row-\d{2}/)), 3)
  drag(harness.vt, viewTop, 3)
  await new Promise<void>(resolve => setTimeout(resolve, 250))
  assert.notEqual(firstRowMatching(harness.vt, /^row-\d{2}/), atBoundary,
    'the visible FIRST row scrolls the Command viewport back up')
  release(harness.vt, viewTop, 3)
  await flush(4)
  harness.copied.length = 0
  // The Output page's own state is untouched by any of this.
  harness.vt.sendInput('\x1b')
  await harness.vt.waitForRender()
  await flush(2)
  assert.match(view(harness.vt), /Follow ON/, 'the Output follow state is untouched')
})

test('C-13 the Output page copies the trigger-moment retained text, never the Command source', async () => {
  const harness = startApp()
  await openFirstJob(harness)
  harness.tasks.observation.latest()!.emit({ label: 'echo hello', text: 'retained\n tail  ' })
  await harness.vt.waitForRender()
  await flush(2)
  harness.vt.sendInput('C')
  await flush(4)
  assert.deepEqual(harness.copied, ['retained\n tail  '], 'the Output copy keeps the retained bytes verbatim')
  assert.equal(harness.notices.at(-1), 'Copy sent')
})

test('C-14 the clipboard settlement is honest: false/rejection report failure, and a stale Job never notifies', async () => {
  const harness = startApp()
  await openFirstJob(harness)
  harness.tasks.observation.latest()!.emit({ label: 'echo hello', text: 'tail' })
  await harness.vt.waitForRender()
  await flush(2)
  // A strategy that reports failure.
  let result = false
  ;(harness.app as unknown as { copySelection?: (text: string) => Promise<boolean> }).copySelection =
    async () => result
  harness.vt.sendInput('C')
  await flush(4)
  assert.equal(harness.notices.at(-1), 'Copy failed', 'a false result is reported as a failure')
  result = true
  harness.copied.length = 0
  harness.vt.sendInput('C')
  await flush(4)
  assert.equal(harness.notices.at(-1), 'Copy sent')
  // A rejection is a failure, not a silent success.
  ;(harness.app as unknown as { copySelection?: (text: string) => Promise<boolean> }).copySelection =
    async () => { throw new Error('no clipboard backend') }
  harness.vt.sendInput('C')
  await flush(4)
  assert.equal(harness.notices.at(-1), 'Copy failed')
  // A copy that settles AFTER the workspace closed must be silent.
  const before = harness.notices.length
  let settle: ((value: boolean) => void) | undefined
  ;(harness.app as unknown as { copySelection?: (text: string) => Promise<boolean> }).copySelection =
    () => new Promise<boolean>(resolve => { settle = resolve })
  harness.vt.sendInput('C')
  harness.vt.sendInput('\x1b')
  await harness.vt.waitForRender()
  settle?.(true)
  await flush(6)
  assert.equal(harness.notices.length, before, 'a stale settlement never notifies a newer viewer')
})

test('C-17 leaving the workspace releases the observer exactly once and leaves no gesture behind', async () => {
  const harness = startApp()
  await openFirstJob(harness)
  harness.tasks.observation.latest()!.emit({ label: 'abc\ndef\nghi' })
  await harness.vt.waitForRender()
  await flush(2)
  await openCommand(harness)
  const row = bodyRow(harness.vt, 'abc')
  press(harness.vt, row, 0)
  drag(harness.vt, row + 1, 1)
  // Esc back to Output cancels the gesture with the page switch.
  harness.vt.sendInput('\x1b')
  await harness.vt.waitForRender()
  release(harness.vt, row + 1, 1)
  await flush(4)
  assert.deepEqual(harness.copied, [], 'a gesture cancelled by the page switch never copies')
  assert.equal(harness.tasks.observation.latest()!.closes, 0, 'the page switch never releases the observer')
  // Esc again leaves the workspace and releases the observer exactly once.
  harness.vt.sendInput('\x1b')
  await harness.vt.waitForRender()
  await flush(2)
  assert.equal(harness.tasks.observation.latest()!.closes, 1, 'the workspace exit releases the observer exactly once')
})

test('C-16 an Output Follow (tail) survives a round trip through the Command page', async () => {
  const harness = startApp()
  await openFirstJob(harness)
  const text = Array.from({ length: 80 }, (_, index) => `line ${String(index).padStart(3, '0')}`).join('\n')
  harness.tasks.observation.latest()!.emit({ label: 'echo hello', text })
  await harness.vt.waitForRender()
  await flush(2)
  const tailRow = bodyRow(harness.vt, 'line 079')
  await openCommand(harness)
  // The Command page never shows the Output body.
  assert.equal(rowOf(harness.vt, 'line 079'), -1, 'the Output body is not painted on the Command page')
  harness.vt.sendInput('\x1b')
  await harness.vt.waitForRender()
  assert.equal(bodyRow(harness.vt, 'line 079'), tailRow, 'the Output tail is still followed after the round trip')
  // A producer append keeps following, and the Command page did not steal it.
  harness.tasks.observation.latest()!.emit({ text: `${text}\nline 080` })
  await harness.vt.waitForRender()
  await flush(2)
  assert.ok(bodyRow(harness.vt, 'line 080') >= 0, 'Follow ON still tracks the newest retained rows')
})

test('C-08 zero-width graphemes belong to their base cell and never break the painted row', () => {
  const cases = ['\u0301b', '\u0301bc', 'a\t\u0301b', '\u0301', 'x\n\u0301y']
  for (const source of cases) {
    for (const width of [1, 5, 80]) {
      const layout = buildCommandVisualLayout(source, width)
      for (const row of layout.rows) {
        assert.equal(row.runs.map(run => run.display).join(''), row.rendered,
          `runs reproduce the painted row for ${JSON.stringify(source)} at ${width}`)
        for (const run of row.runs) {
          assert.ok(run.startCol <= run.endCol && run.endCol <= width, 'no run exceeds the grant')
        }
      }
      // Every painted cell of a row maps to a real offset in that row's own
      // source range (a zero-width-only row included).
      for (const [rowIndex, row] of layout.rows.entries()) {
        for (let col = 0; col < Math.max(1, width); col += 1) {
          const offset = commandPointOffset(layout, { row: rowIndex, col }, 'start')
          if (offset === undefined) continue
          assert.ok(offset >= row.sourceStart && offset <= row.sourceEnd,
            `column ${col} of row ${rowIndex} maps inside its own range (${JSON.stringify(source)})`)
        }
      }
    }
  }
  // A LEADING zero-width grapheme rides on the first base character: a gesture
  // anchored on its cell carries the mark with it.
  assert.equal(sliceSelection('\u0301bc', 80, [0, 0], [0, 1]), '\u0301bc')
  assert.equal(sliceSelection('a\t\u0301b', 80, [0, 0], [0, 2]), 'a\t\u0301')
  // A row made ONLY of zero-width graphemes still resolves its own column.
  const solo = buildCommandVisualLayout('\u0301', 80)
  assert.equal(solo.rows.length, 1)
  assert.equal(commandPointOffset(solo, { row: 0, col: 0 }, 'start'), 0)
  assert.equal(commandPointOffset(solo, { row: 0, col: 0 }, 'end'), 1)
})

test('C-09 hardBreakEnd carries the real newline offsets and equals sourceEnd on a soft wrap', () => {
  const lf = buildCommandVisualLayout('ab\ncd', 80)
  assert.equal(lf.rows[0]!.sourceEnd, 2)
  assert.equal(lf.rows[0]!.hardBreakEnd, 3, 'LF belongs to the break, not to the row content')
  assert.equal(lf.rows[1]!.hardBreakEnd, 5)
  const crlf = buildCommandVisualLayout('ab\r\ncd', 80)
  assert.equal(crlf.rows[0]!.sourceEnd, 2)
  assert.equal(crlf.rows[0]!.hardBreakEnd, 4, 'CRLF is one hard-break token')
  const wrapped = buildCommandVisualLayout('abcdef', 3)
  for (const row of wrapped.rows) {
    assert.equal(row.hardBreakEnd, row.sourceEnd, 'a soft wrap inserts no break into the source')
  }
  const trailing = buildCommandVisualLayout('abc\n', 80)
  assert.equal(trailing.rows[0]!.hardBreakEnd, 4)
  assert.equal(trailing.rows[1]!.sourceStart, 4, 'a trailing LF still opens its own (empty) row')
  for (const source of ['ab\ncd', 'ab\r\ncd', 'abcdef', 'abc\n', 'a\tb', '']) {
    for (const row of buildCommandVisualLayout(source, 80).rows) {
      assert.ok(row.hardBreakEnd >= row.sourceEnd && row.hardBreakEnd <= source.length,
        `hardBreakEnd is a real source offset for ${JSON.stringify(source)}`)
    }
  }
})

test('C-18 the header hit map covers ONLY painted text: blank padding has no click target', () => {
  // The Command page button region is exactly `[Copy All]`.
  const harness = makePanel(observedState({ label: 'echo one' }))
  harness.panel.handleInput('v')
  const commandLines = paint(harness, 80)
  const readerRow = commandLines.findIndex(line => line.includes('[Copy All]'))
  assert.ok(readerRow >= 0)
  const buttonCol = 'Command reader · '.length
  harness.panel.onHeaderPress(buttonCol + 2, readerRow)
  harness.panel.onHeaderClick(buttonCol + 2, readerRow)
  assert.deepEqual(harness.copies, [{ source: 'command-all', text: 'echo one' }], 'the button itself copies')
  harness.copies.length = 0
  harness.panel.onHeaderPress(79, readerRow)
  harness.panel.onHeaderClick(79, readerRow)
  assert.deepEqual(harness.copies, [], 'the blank space right of the button is inert')
  harness.panel.dispose()

  // The Output summary region is its own visible text only.
  const output = makePanel(observedState({ label: 'echo one' }))
  const outputLines = paint(output, 80)
  const summaryRow = outputLines.findIndex(line => line.includes('Command: echo one'))
  assert.ok(summaryRow >= 0)
  output.panel.onHeaderPress(79, summaryRow)
  output.panel.onHeaderClick(79, summaryRow)
  assert.ok(!/Command reader/.test(paint(output, 80).join('\n')), 'the header padding never opens the page')
  output.panel.onHeaderPress(5, summaryRow)
  output.panel.onHeaderClick(5, summaryRow)
  assert.match(paint(output, 80).join('\n'), /Command reader · \[Copy All\]/, 'the summary text does open it')
  output.panel.dispose()
})

test('C-05 the two read-only verbs are advertised with a deterministic drop order', () => {
  const harness = makePanel(observedState({ label: 'echo one', text: 'tail' }))
  // The two verbs carry DIFFERENT priorities, so the drop order is a decision
  // and not an array-order accident: the copy verb always yields first, i.e. it
  // can never appear alone.
  let sawBoth = false
  let sawCommandOnly = false
  for (let width = 60; width <= 200; width += 4) {
    const bar = paint(harness, width).at(-1)!
    const hasCopy = /C copy output/.test(bar)
    const hasCommand = /V command/.test(bar)
    assert.ok(!hasCopy || hasCommand, `the copy verb never survives alone at ${width} columns`)
    if (hasCopy) sawBoth = true
    if (hasCommand && !hasCopy) sawCommandOnly = true
  }
  assert.ok(sawBoth, 'there is a row wide enough to advertise BOTH verbs')
  assert.ok(sawCommandOnly, 'there is a row where only the higher-priority Command verb survives')
  const tight = paint(harness, 80).at(-1)!
  assert.ok(!/V command/.test(tight), 'a tight row yields the Command verb too')
  assert.ok(!/C copy output/.test(tight), 'a tight row yields the copy verb')
  assert.match(tight, /Retained preview · not full history/, 'the pre-existing disclosure is never the price')
  harness.panel.dispose()

  // plan §4: an action that cannot execute this frame is never advertised. With
  // nothing retained the copy verb is absent even where the row has all the room
  // in the world, while the Command entry (which CAN act) stays.
  const emptyOutput = makePanel(observedState({ label: 'echo one', text: '' }))
  const wideBar = paint(emptyOutput, 200).at(-1)!
  assert.ok(!/C copy output/.test(wideBar), 'an empty Output never advertises the copy verb')
  assert.match(wideBar, /V command/, 'the Command entry can still act, so it stays advertised')
  emptyOutput.panel.dispose()
})

test('C-14 an empty retained Output is refused with honest feedback, never a false Copy sent', async () => {
  const harness = startApp()
  await openFirstJob(harness)
  harness.tasks.observation.latest()!.emit({ label: 'echo hello', text: '' })
  await harness.vt.waitForRender()
  await flush(2)
  harness.vt.sendInput('C')
  await flush(4)
  assert.deepEqual(harness.copied, [], 'nothing is written for an empty retained Output')
  assert.equal(harness.notices.at(-1), 'Nothing to copy', 'the user learns why C did nothing')
})

test('C-14 a refused observation reports Output unavailable, never a copy', async () => {
  const harness = startApp()
  // The observation port refuses to open at all: the workspace presents the
  // UNAVAILABLE phase, which must not be reported as an empty copy.
  harness.tasks.observation.openFailure = 'no job controller'
  await openFirstJob(harness)
  await flush(6)
  assert.match(view(harness.vt), /Retained output unavailable/, 'the unavailable phase is visible')
  harness.vt.sendInput('C')
  await flush(4)
  assert.deepEqual(harness.copied, [], 'an unavailable Output is never written to the clipboard')
  assert.equal(harness.notices.at(-1), 'Output unavailable', 'and it names its OWN reason')
})

test('C-01 Direct L6: the official bash args.command label crosses the PRODUCTION Direct adapter into the Command copy', async () => {
  const command = '  pnpm build\t--filter "a b"  \n    echo second-line   \n'
  let aborted = false
  const controller = {
    follow: (_request: unknown, signal: AbortSignal) => (async function* () {
      if (signal.aborted) { aborted = true; return }
      yield {
        type: 'opened',
        job: { id: 'job-direct', kind: 'bash', label: command, status: 'running', output: { earliest: 0, total: 0 } },
        from: 0,
      }
      yield { type: 'output', chunks: [{ text: 'direct retained\n' }], next: 16 }
    })(),
  }
  const port = new DirectJobObservationPort(
    { get: name => (name === 'jobController' ? controller : undefined) },
    createDiag({ filePath: undefined, stderrLevel: 'off' }),
  )
  const harness = startApp(120, 40, ['job-direct'], port)
  await openFirstJob(harness)
  await flush(12)
  assert.equal(aborted, false, 'the adapter stream stays open while the viewer observes')
  const painted = view(harness.vt)
  assert.ok(!/Retained output unavailable/.test(painted), `the Direct observation really opened:\n${painted}`)
  assert.match(painted, /Command:   pnpm build/, 'the observed label IS the official args.command')
  assert.match(painted, /direct retained/, 'the retained output came through the same adapter')
  await openCommand(harness)
  harness.vt.sendInput('C')
  await flush(6)
  assert.deepEqual(harness.copied, [command], 'the Direct path delivers the ORIGINAL command byte for byte')
  assert.equal(harness.notices.at(-1), 'Copy sent')
})

test('C-06 a >10,000-character / 1,200-line Command scrolls locally and keeps ONE observer', async () => {
  const harness = startApp(80, 24)
  await openFirstJob(harness)
  const big = Array.from({ length: 1_200 }, (_, index) => `line-${String(index).padStart(4, '0')}  ${'x'.repeat(8)}`).join('\n')
  assert.ok(big.length > 10_000, `the fixture really is plan scale (${big.length} chars)`)
  harness.tasks.observation.latest()!.emit({ label: big })
  await harness.vt.waitForRender()
  await flush(2)
  await openCommand(harness)
  const barRow = bodyRow(harness.vt, 'Esc output')
  assert.match(rawView(harness.vt)[barRow]!, /rows 1-\d+\/1200/, 'the position fact counts all 1,200 visual rows')
  const headerBefore = rawView(harness.vt)[0]
  const commandTop = firstRowMatching(harness.vt, /^line-\d{4}/)
  assert.notEqual(commandTop, '', 'the Command body paints rows')
  harness.vt.sendInput('\x1b[6~')
  await harness.vt.waitForRender()
  await flush(2)
  assert.equal(rawView(harness.vt)[0], headerBefore, 'the header never scrolls with the body')
  const scrolledTop = firstRowMatching(harness.vt, /^line-\d{4}/)
  assert.notEqual(scrolledTop, commandTop, 'PageDown really moved the Command viewport')
  harness.vt.sendInput('C')
  await flush(6)
  assert.deepEqual(harness.copied, [big], 'Copy All still delivers the WHOLE original document')
  // Round trip to Output and back: the Command viewport survives, one observer.
  harness.vt.sendInput('\x1b')
  await harness.vt.waitForRender()
  harness.vt.sendInput('v')
  await harness.vt.waitForRender()
  await flush(2)
  assert.equal(firstRowMatching(harness.vt, /^line-\d{4}/), scrolledTop,
    'the Command scrollTop survives the round trip')
  assert.equal(harness.tasks.observation.records.length, 1, 'ONE observer for the whole document')
})

test('C-10 a hostile OSC/CSI label is sanitized at the Header boundary and never reaches the terminal', async () => {
  const harness = startApp()
  await openFirstJob(harness)
  // Capture the RAW stream the app writes to the terminal from here on.
  const rawWritten: string[] = []
  const originalWrite = harness.vt.write.bind(harness.vt)
  harness.vt.write = (data: string) => {
    rawWritten.push(data)
    originalWrite(data)
  }
  const hostile = `\u001b]52;c;${Buffer.from('PWNED').toString('base64')}\u0007echo ok\u001b[2J`
  harness.tasks.observation.latest()!.emit({ label: hostile, text: 'retained job-a' })
  await harness.vt.waitForRender()
  await flush(2)
  const stream = rawWritten.join('')
  assert.ok(!stream.includes(']52;c;'), 'the label OSC 52 never reaches the terminal stream')
  // The BEL terminator alone would be a false positive (the app's OWN OSC
  // sequences legitimately end in BEL), so the decisive witness is the label's
  // clipboard PAYLOAD, which can only come from the unsanitized label.
  assert.ok(!stream.includes('UFdORUQ='), 'the label clipboard payload never reaches the terminal stream')
  assert.ok(!stream.includes('\u009b'), 'no raw C1 control byte reaches the terminal stream')
  const painted = view(harness.vt)
  assert.match(painted, /Command: echo ok/, `the header shows the SANITIZED summary:\n${painted}`)
  assert.ok(!/]52;c;|\[2J/.test(painted), 'no escape payload text leaks into the painted header')
  // The display boundary never touches the official bytes: the Command page
  // still copies the ORIGINAL label verbatim.
  await openCommand(harness)
  harness.vt.sendInput('C')
  await flush(4)
  assert.deepEqual(harness.copied, [hostile], 'the copy payload stays the official original')
})

test('C-01 a rapid double click on [Copy All] cannot overwrite the command copy with a word', async () => {
  const harness = startApp()
  await openFirstJob(harness)
  const label = 'echo hello\nworld'
  harness.tasks.observation.latest()!.emit({ label })
  await harness.vt.waitForRender()
  await flush(2)
  await openCommand(harness)
  const buttonRow = bodyRow(harness.vt, '[Copy All]')
  const buttonCol = rawView(harness.vt)[buttonRow]!.indexOf('[Copy All]')
  // Two same-cell clicks INSIDE the fork's 500 ms window: the second is
  // classified as a word selection, so it must not reach the clipboard.
  press(harness.vt, buttonRow, buttonCol + 2)
  release(harness.vt, buttonRow, buttonCol + 2)
  press(harness.vt, buttonRow, buttonCol + 2)
  release(harness.vt, buttonRow, buttonCol + 2)
  await flush(6)
  assert.deepEqual(harness.copied, [label], 'the clipboard holds ONLY the original label after a double click')
  assert.ok(!harness.copied.some(text => text === 'Copy' || text === 'All'), 'the native word selection never runs')
  assert.match(view(harness.vt), /Command reader · \[Copy All\]/, 'the page never changed')

  // Back on Output the screen's OWN copy-on-select is restored: a native drag
  // over the retained body still copies screen text (pre-existing B1-A behavior).
  harness.vt.sendInput('\x1b')
  await harness.vt.waitForRender()
  await flush(2)
  harness.copied.length = 0
  const bodyRowIndex = bodyRow(harness.vt, 'retained job-a')
  press(harness.vt, bodyRowIndex, 0)
  drag(harness.vt, bodyRowIndex, 6)
  release(harness.vt, bodyRowIndex, 6)
  await flush(4)
  assert.ok(harness.copied.length > 0, 'the Output page keeps the fork native selection copy')
  assert.notDeepEqual(harness.copied, [label], 'that native copy is screen text, not the command')
})

test('C-18 the compact header keeps the GAP/ERROR fact text non-interactive', () => {
  const harness = makePanel(observedState({ label: 'ls', gapBefore: true }))
  const lines = paint(harness, 44)
  const row = lines.findIndex(line => line.includes('Earlier output evicted'))
  assert.ok(row >= 0, `the compact row carries the fact text:\n${lines.join('\n')}`)
  const painted = lines[row]!
  assert.match(painted, /Command: ls/, 'the same row carries the Command summary')
  const factsCol = painted.indexOf('Earlier output evicted')
  harness.panel.onHeaderPress(factsCol + 2, row)
  harness.panel.onHeaderClick(factsCol + 2, row)
  assert.ok(!/Command reader/.test(paint(harness, 44).join('\n')),
    'clicking the GAP fact text never opens the Command page')
  const summaryCol = painted.indexOf('Command: ls')
  harness.panel.onHeaderPress(summaryCol + 1, row)
  harness.panel.onHeaderClick(summaryCol + 1, row)
  assert.match(paint(harness, 44).join('\n'), /Command reader · \[Copy All\]/,
    'the Command summary itself still opens it')
  harness.panel.dispose()
})

test('C-10 a hostile ROSTER label is sanitized in the workspace notice row (Stop settlement)', async () => {
  // The Stop settlement interpolates the BROWSER row label (not the observed
  // one), so BOTH are hostile here: the notice row is the other workspace chrome
  // row that paints Host-supplied Job text.
  const hostile = `\u001b]52;c;${Buffer.from('PWNED').toString('base64')}\u0007echo ok\u001b[2J`
  const harness = startApp(120, 40, ['job-a'], undefined, hostile)
  await openFirstJob(harness)
  harness.tasks.observation.latest()!.emit({ label: hostile, text: 'tail' })
  await harness.vt.waitForRender()
  await flush(2)
  const rawWritten: string[] = []
  const originalWrite = harness.vt.write.bind(harness.vt)
  harness.vt.write = (data: string) => {
    rawWritten.push(data)
    originalWrite(data)
  }
  // The advertised Stop on the Output page drives the settlement notice.
  harness.vt.sendInput('s')
  await flush(6)
  assert.deepEqual(harness.tasks.observation.stops, ['job-a'], 'the advertised Stop really dispatched')
  const stream = rawWritten.join('')
  assert.ok(!stream.includes(']52;c;'), 'the roster label OSC 52 never reaches the terminal from the notice row')
  assert.ok(!stream.includes('UFdORUQ='), 'its clipboard payload never reaches the terminal')
  assert.ok(!stream.includes('\u009b'), 'no raw C1 control byte reaches the terminal')
  const painted = view(harness.vt)
  assert.match(painted, /stopping echo ok/, `the notice shows the SANITIZED settlement:\n${painted}`)
  assert.ok(!/]52;c;|\[2J/.test(painted), 'no escape payload text leaks into the painted notice')
})
