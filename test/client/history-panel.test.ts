/**
 * Headless tests for the Ctrl+R History EDITOR-SEAT panel (Phase 3B / B3-A):
 * the pure seat row allocator, the vertical list+Preview presentation, the
 * query/scope/selection lifecycle, the Preview navigation, Copy All, the F2
 * presentation toggle, the responsive sizes and the exact original-source
 * selection mapping the Fullscreen Preview drag resolves against.
 *
 * The panel-level pointer contract is pinned in `history-seat-mouse.test.ts`
 * (real SGR bytes through the real `TuiApp`); this file pins the component's
 * own refusal when the pointer capability is disabled (the regular main
 * screen), which is the negative half of that contract. A fake source drives
 * the async search — no terminal is needed.
 * @module @xmoon76/dsh-pi-tui/history-panel.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import {
  formatRelativeAge,
  HistoryPanel,
  planHistorySeatLayout,
  type HistoryPanelOptions,
  type HistorySeatGeometry,
} from '../../src/tui/panels/history-panel.ts'
import {
  buildSourceTextVisualLayout,
  sourceTextPointOffset,
  sourceTextSelectionRange,
} from '../../src/tui/components/source-text-layout.ts'
import type { HistorySearchResult, HistorySearchSource } from '../../src/client/history/search.ts'
import type { HistoryScope } from '../../src/client/history/search.ts'
import { color, setTheme } from '../../src/tui/theme/runtime.ts'
import { darkColors, type ColorPalette } from '../../src/domain/display/theme.ts'

const visibleWidthOf = visibleWidth

/** A controllable fake source: records calls and resolves with the rows of the
 * CURRENT query (or a preset per-call response). */
class FakeSource implements HistorySearchSource {
  requests: Array<{ scope: HistoryScope; query: string; cwd: string; sessionId?: string; limit: number }> = []
  rows: HistorySearchResult[] = []
  delayMs = 0
  fail = false
  /** Manually-settled pending searches (deterministic race control). */
  pending: Array<{ resolve: (page: import('../../src/client/history/search.ts').HistorySearchPage) => void; reject: (error: unknown) => void }> = []
  manual = false
  search(request: import('../../src/client/history/search.ts').HistorySearchRequest): Promise<import('../../src/client/history/search.ts').HistorySearchPage> {
    this.requests.push({
      scope: request.scope, query: request.query, cwd: request.cwd,
      sessionId: request.sessionId, limit: request.limit,
    })
    if (this.fail) return Promise.reject(new Error('boom'))
    if (this.manual) {
      return new Promise<import('../../src/client/history/search.ts').HistorySearchPage>((resolve, reject) => {
        this.pending.push({ resolve, reject })
      })
    }
    return new Promise(resolve => {
      setTimeout(() => resolve({ results: [...this.rows], exhausted: true }), this.delayMs)
    })
  }
  resolveNext(rows: HistorySearchResult[]): void {
    const pending = this.pending.shift()
    if (pending === undefined) throw new Error('resolveNext: no pending search')
    pending.resolve({ results: [...rows], exhausted: true })
  }
  rejectNext(error: unknown): void {
    const pending = this.pending.shift()
    if (pending === undefined) throw new Error('rejectNext: no pending search')
    pending.reject(error)
  }
}

function row(content: string, ts: number, cwd = '/a', id = content): HistorySearchResult {
  return { id, content, cwd, ts, sourceFile: '/a/h.jsonl', sourceByteOffset: 0 }
}

/** One injected seat geometry (`chromeRows` defaults to a bare frame). */
function seatGeometry(columns: number, rows: number, chromeRows = 0): HistorySeatGeometry {
  return { columns: () => columns, rows: () => rows, chromeRows: () => chromeRows }
}

interface PanelHarness {
  panel: HistoryPanel
  accepted: () => { id: string; content: string } | undefined
  closed: () => number
  copied: string[]
}

function makePanel(source: FakeSource, opts: Partial<HistoryPanelOptions> = {}): PanelHarness {
  let accepted: { id: string; content: string } | undefined
  let closed = 0
  const copied: string[] = []
  const panel = new HistoryPanel({
    source,
    cwd: '/work/a',
    geometry: seatGeometry(100, 30),
    onAccept: (selection) => { accepted = selection },
    onClose: () => { closed += 1 },
    onCopy: (text) => { copied.push(text) },
    debounceMs: 1,
    ...opts,
  })
  return { panel, accepted: () => accepted, closed: () => closed, copied }
}

/** Flush microtasks only (no timers — the debounce must NOT fire). */
const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

/** Flush microtasks + one timer turn (the panel's 1ms test debounce fires). */
const settle = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Wait (bounded) until the panel's ASYNC search commits the FINAL visible
 *  state. The debounce + source delay + generation commit can outlive any
 *  fixed sleep under CI load; `Loading history…` is a legitimate intermediate
 *  state, never the state these assertions may judge. */
async function waitForHistoryRender(
  panel: HistoryPanel,
  predicate: (lines: string[]) => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<string[]> {
  const start = Date.now()
  for (;;) {
    const lines = panel.render(100)
    if (predicate(lines)) return lines
    if (Date.now() - start > timeoutMs) {
      assert.fail(`${label}: the async history search never reached its final state:\n${plain(lines).join('\n')}`)
    }
    await new Promise<void>(resolve => setTimeout(resolve, 2))
  }
}

/** Strip ANSI so the assertions read the plain text the user sees. */
const plain = (lines: readonly string[]): string[] => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))

/** The INTERNAL Results/Preview divider row: skips the two Owner-decision D15
 *  boundary rules at the first and last seat rows. */
const internalDividerRow = (lines: readonly string[]): number =>
  lines.findIndex((line, index) => index > 0 && index < lines.length - 1 && /^─+$/u.test(line.trim()))

// ── the pure seat row allocator ─────────────────────────────────────────────

test('B3-A layout: the responsive sizes allocate header/query/footer, ≤8 result rows and the Preview remainder', () => {
  const cases = [
    // D15: at these comfortable grants BOTH boundary rules are drawn and consume
    // two content rows (the list region yields first), so each Preview is 2
    // content rows smaller than the pre-D15 plan at the wide sizes.
    { cols: 200, rows: 60, chrome: 2, expanded: false, target: 37, list: 8, preview: 21 },
    { cols: 200, rows: 60, chrome: 2, expanded: true, target: 48, list: 8, preview: 32 },
    { cols: 120, rows: 40, chrome: 2, expanded: false, target: 25, list: 8, preview: 9 },
    { cols: 120, rows: 40, chrome: 2, expanded: true, target: 32, list: 8, preview: 16 },
    { cols: 80, rows: 24, chrome: 2, expanded: false, target: 15, list: 4, preview: 3 },
  ] as const
  for (const item of cases) {
    const layout = planHistorySeatLayout(item.cols, item.rows, item.chrome, item.expanded, { previewable: true })
    const painted = (layout.header ? 1 : 0) + (layout.query ? 1 : 0) + (layout.footer ? 1 : 0)
      + (layout.divider ? 1 : 0) + (layout.previewHeading ? 1 : 0) + (layout.metadata ? 1 : 0)
      + (layout.topRule ? 1 : 0) + (layout.bottomRule ? 1 : 0)
      + layout.resultsRows + layout.previewRows
    assert.equal(layout.grant, Math.min(item.target, item.rows - item.chrome - 1),
      `${item.cols}x${item.rows} expanded=${item.expanded} grant`)
    assert.ok(painted <= layout.grant, `${item.cols}x${item.rows} must never paint more than its grant`)
    assert.equal(layout.resultsRows, item.list, `${item.cols}x${item.rows} list allocation`)
    assert.equal(layout.previewRows, item.preview, `${item.cols}x${item.rows} preview content rows`)
    assert.equal(layout.resultRows + (layout.resultsRows >= 2 ? 1 : 0), layout.resultsRows)
    assert.equal(layout.acceptEnabled, true)
    assert.equal(layout.topRule, true, `${item.cols}x${item.rows} top boundary rule`)
    assert.equal(layout.bottomRule, true, `${item.cols}x${item.rows} bottom boundary rule`)
  }
})

test('B3-A layout: the tiny sizes keep the mandatory chrome and never paint an unpainted acceptance', () => {
  // 80x10 / 80x8 / 44x8 with a real two-row chrome: query + hint survive and the
  // Preview (metadata, heading, divider) yields BEFORE the mandatory rows.
  const tiny = planHistorySeatLayout(80, 8, 2, false, { previewable: true })
  assert.equal(tiny.grant, 5)
  assert.deepEqual(
    [tiny.header, tiny.query, tiny.footer], [true, true, true],
    'the header, the query and the honest Esc hint stay painted',
  )
  assert.equal(tiny.previewRows, 0, 'no Preview fits at 80x8')
  assert.equal(tiny.resultsRows, 2, 'the visible selected result rows win')
  assert.equal(tiny.acceptEnabled, true)

  const narrow = planHistorySeatLayout(44, 8, 2, false, { previewable: true })
  assert.equal(narrow.grant, 5)
  assert.equal(narrow.resultsRows, 2)
  assert.equal(narrow.previewRows, 0)

  // A grant too small for the body: chrome only, and NO acceptance.
  const empty = planHistorySeatLayout(80, 4, 0, false, { previewable: true })
  assert.equal(empty.grant, 2)
  assert.equal(empty.header, true)
  assert.equal(empty.query, true)
  assert.equal(empty.footer, false)
  assert.equal(empty.resultsRows, 0)
  assert.equal(empty.acceptEnabled, false)

  // Zero grant (the chrome alone exceeds the terminal): the panel paints nothing.
  const none = planHistorySeatLayout(80, 3, 4, false, { previewable: true })
  assert.equal(none.grant, 0)
  assert.equal(none.header, false)
  assert.equal(none.resultsRows + none.previewRows, 0)

  // Loading / empty / failed content: ONE message row and no preview at all.
  const message = planHistorySeatLayout(120, 40, 2, false, { previewable: false })
  assert.equal(message.resultsRows, 1)
  assert.equal(message.previewRows, 0)
  assert.equal(message.divider, false)
  assert.equal(message.acceptEnabled, false)
})

test('B3-A layout: a non-positive/NaN geometry never produces a negative allocation', () => {
  for (const [cols, rows, chrome] of [[0, 0, 0], [-5, -5, -5], [Number.NaN, Number.NaN, Number.NaN]] as const) {
    const layout = planHistorySeatLayout(cols, rows, chrome, false, { previewable: true })
    assert.ok(layout.width >= 1)
    assert.ok(layout.grant >= 0)
    assert.ok(layout.resultsRows >= 0 && layout.previewRows >= 0)
  }
})

// ── query / scope / results lifecycle ──────────────────────────────────────

test('panel: opens in current scope with an empty query and immediately searches', async () => {
  const source = new FakeSource()
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  assert.equal(source.requests.length, 1)
  assert.equal(source.requests[0]?.scope, 'current')
  assert.equal(source.requests[0]?.query, '')
})

test('panel: typing updates the query and re-searches (debounced)', async () => {
  const source = new FakeSource()
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  panel.handleInput('n')
  panel.handleInput('g')
  panel.handleInput('i')
  await settle()
  assert.equal(source.requests.length, 2, 'initial + one debounced search')
  assert.equal(source.requests[1]?.query, 'ngi')
})

test('panel: Tab toggles the scope and PRESERVES the query; a session identity adds the session tab', async () => {
  const source = new FakeSource()
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  panel.handleInput('x')
  await settle()
  panel.handleInput('\t')
  await settle()
  assert.equal(source.requests[2]?.scope, 'all')
  assert.equal(source.requests[2]?.query, 'x')
  panel.handleInput('\t')
  await settle()
  assert.equal(source.requests[3]?.scope, 'current')

  const withSession = makePanel(source, { sessionId: 'ses_1' })
  withSession.panel.start()
  await settle()
  assert.equal(source.requests[4]?.scope, 'session')
  assert.equal(source.requests[4]?.sessionId, 'ses_1')
})

test('panel: a session identity defaults to the session scope and cycles through it', async () => {
  const source = new FakeSource()
  const { panel } = makePanel(source, { sessionId: 'ses_1' })
  panel.start()
  await settle()
  assert.equal(source.requests[0]?.scope, 'session')
  panel.handleInput('\t')
  await settle()
  assert.equal(source.requests[1]?.scope, 'current')
  panel.handleInput('\t')
  await settle()
  assert.equal(source.requests[2]?.scope, 'all')
  panel.handleInput('\t')
  await settle()
  assert.equal(source.requests[3]?.scope, 'session')
})

test('panel: Enter accepts the selected row with its stable identity (no submit, no close side effect here)', async () => {
  const source = new FakeSource()
  source.rows = [row('first prompt', 2), row('second prompt', 1)]
  const { panel, accepted } = makePanel(source)
  panel.start()
  await settle()
  panel.render(100)
  panel.handleInput('\r')
  assert.deepEqual(accepted(), { id: 'first prompt', content: 'first prompt' })
})

test('panel: Enter with NO match and with an UNPAINTED row is a no-op', async () => {
  const source = new FakeSource()
  source.rows = []
  const empty = makePanel(source)
  empty.panel.start()
  await settle()
  empty.panel.render(100)
  empty.panel.handleInput('\r')
  assert.equal(empty.accepted(), undefined, 'a zero-match Enter accepts nothing')

  // A selected row that the last frame could NOT paint is never accepted.
  const many = new FakeSource()
  many.rows = Array.from({ length: 30 }, (_, index) => row(`entry ${index}`, 30 - index, '/a', `id-${index}`))
  const harness = makePanel(many)
  harness.panel.start()
  await settle()
  harness.panel.render(100) // paints the head only
  for (let step = 0; step < 25; step += 1) harness.panel.handleInput('\x1b[B')
  assert.equal(harness.panel.selected()?.content, 'entry 25')
  harness.panel.handleInput('\r')
  assert.equal(harness.accepted(), undefined, 'an unpainted selection must not be accepted')
  harness.panel.render(100) // paint the scrolled window
  harness.panel.handleInput('\r')
  assert.equal(harness.accepted()?.content, 'entry 25', 'after the paint the same Enter accepts')
})

test('panel: Esc and Ctrl+C cancel without accepting', async () => {
  const source = new FakeSource()
  source.rows = [row('entry', 1)]
  const esc = makePanel(source)
  esc.panel.start()
  await settle()
  esc.panel.render(100)
  esc.panel.handleInput('\x1b')
  assert.equal(esc.closed(), 1)
  assert.equal(esc.accepted(), undefined)

  const ctrlC = makePanel(source)
  ctrlC.panel.start()
  await settle()
  ctrlC.panel.render(100)
  ctrlC.panel.handleInput('\x03')
  assert.equal(ctrlC.closed(), 1)
})

test('panel: the selection viewport FOLLOWS the cursor and PgUp/PgDn page by the PAINTED row count', async () => {
  const source = new FakeSource()
  source.rows = Array.from({ length: 60 }, (_, index) => row(`entry ${index}`, 60 - index, '/a', `id-${index}`))
  const { panel } = makePanel(source, { geometry: seatGeometry(100, 30) })
  panel.start()
  await settle()
  const lines = plain(panel.render(100))
  const dividerRow = internalDividerRow(lines)
  const selected = lines.findIndex(line => line.startsWith('> '))
  // Only the LIST region rows (above the divider) are results: the Preview
  // paints the selected entry's own text too.
  const visible = lines.slice(0, dividerRow).filter(line => /entry \d+/.test(line)).length
  assert.ok(selected > 0 && visible > 1, `the list must paint a multi-row window:\n${lines.join('\n')}`)
  panel.handleInput('\x1b[6~') // PageDown
  assert.equal(panel.selected()?.content, `entry ${visible}`)
  const scrolled = plain(panel.render(100))
  assert.ok(scrolled.some(line => line.startsWith('> ') && line.includes(`entry ${visible}`)),
    'the selected row must stay inside the viewport')
  assert.ok(!scrolled.some(line => line.includes('entry 0')), 'the window scrolled past the head')
  panel.handleInput('\x1b[5~') // PageUp
  assert.equal(panel.selected()?.content, 'entry 0')
})

test('panel: a stale async result never overwrites a fresher query (and acceptance stays frozen)', async () => {
  const source = new FakeSource()
  source.manual = true
  const { panel } = makePanel(source)
  panel.start()
  panel.handleInput('a')
  await settle()
  assert.equal(source.requests.length, 2)
  source.resolveNext([row('stale', 1)])
  await settle()
  assert.equal(panel.selected(), undefined, 'the stale response must be dropped')
  source.resolveNext([row('fresh', 9)])
  await settle()
  panel.render(100)
  assert.equal(panel.selected()?.content, 'fresh')
})

test('panel: a LATE rejection after dispose never commits "History unavailable"', async () => {
  const source = new FakeSource()
  source.manual = true
  const { panel } = makePanel(source)
  panel.start()
  panel.dispose()
  source.rejectNext(new Error('late failure'))
  await flushMicrotasks()
  const lines = plain(panel.render(80))
  assert.ok(!lines.some(line => line.includes('History unavailable')))
})

test('panel: a source failure paints the non-accepting unavailable state', async () => {
  const source = new FakeSource()
  source.fail = true
  source.rows = [row('never', 1)]
  const { panel, accepted } = makePanel(source)
  panel.start()
  await settle()
  const lines = plain(panel.render(100))
  assert.ok(lines.some(line => line.includes('History unavailable')), lines.join('\n'))
  panel.handleInput('\r')
  assert.equal(accepted(), undefined, 'a failed search must never accept a stale row')
})

test('panel: zero results renders the no-match state and the footer', async () => {
  const source = new FakeSource()
  source.rows = []
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  const lines = plain(panel.render(100))
  assert.ok(lines.some(line => line.includes('No history yet')))
  assert.ok(lines.some(line => line.includes('Enter use · Tab scope') && line.includes('Esc cancel')),
    'the full action bar is painted at 100 columns')
})

// ── presentation: list + Preview ────────────────────────────────────────────

test('panel: the vertical presentation keeps the header, query, counter, list, divider, Preview and metadata inside the grant', async () => {
  const source = new FakeSource()
  source.rows = [
    ...Array.from({ length: 25 }, (_, index) => row(`entry ${index}`, 25 - index, '/a', `id-${index}`)),
    row('long prompt first line\nsecond line\nthird line', 1, '/work/a', 'long'),
  ]
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  const raw = panel.render(120)
  const lines = plain(raw)
  assert.ok(internalDividerRow(lines) > 0, 'the Results/Preview divider is painted')
  assert.ok(/^─+$/u.test(lines[0]!.trim()), 'the Owner-decision D15 top boundary rule is the first row')
  assert.ok(/^─+$/u.test(lines.at(-1)!.trim()), 'the D15 bottom boundary rule is the last row')
  assert.ok(lines[1]!.includes('Input History'), 'the header follows the top boundary rule')
  assert.ok(lines[2]!.includes('Search: '), 'the query row follows')
  assert.ok(lines.some(line => line.includes('Results · 26 matches')), 'the counter is painted')
  assert.ok(lines.some(line => line.includes('Preview ')), 'the Preview heading is painted')
  assert.ok(lines.some(line => line.includes('Scope: directory')), 'the metadata row is painted')
  assert.ok(lines.some(line => line.includes('Enter use · Tab scope') && line.includes('Esc cancel')),
    'the footer hint is painted')
  assert.equal(lines.filter(line => /entry \d+/.test(line)).length, 6,
    'the list window (5 result rows) plus the one Preview content row for the selected entry')
  assert.ok(lines.length <= 18, `the render must stay within the grant (got ${lines.length})`)
  for (const line of raw) assert.ok(visibleWidthOf(line) <= 120, `line exceeds the width: ${JSON.stringify(line)}`)
})

test('panel: a long Preview is fully readable — no `… more` truncation, independent of the list', async () => {
  const source = new FakeSource()
  const huge = Array.from({ length: 500 }, (_, index) => `source line ${index}`).join('\n')
  source.rows = [row('other entry', 2, '/a', 'other'), row(huge, 1, '/a', 'huge')]
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  panel.handleInput('\x1b[A') // select the long entry (last)
  const lines = plain(panel.render(100))
  assert.ok(!lines.some(line => line.includes('… more')), 'the Preview never truncates the source with a marker')
  assert.ok(lines.some(line => line.includes('source line 0')), 'the Preview starts at the source head')
  assert.ok(lines.some(line => line.includes('rows 1-4/500')), `the heading reports the real position:\n${lines.join('\n')}`)
  // Alt+End scrolls the Preview to the LAST source row.
  panel.handleInput('\x1b[1;3F')
  const tail = plain(panel.render(100))
  assert.ok(tail.some(line => line.includes('source line 499')), `Alt+End reaches the last source row:\n${tail.join('\n')}`)
  assert.ok(tail.some(line => line.includes('rows 497-500/500')), tail.join('\n'))
  // The list selection did NOT move (the Preview scroll is independent).
  assert.equal(panel.selected()?.content, huge)
})

test('panel: F2 toggles the 63%/80% presentation and the render grows', async () => {
  const source = new FakeSource()
  source.rows = Array.from({ length: 30 }, (_, index) => row(`entry ${index}`, 30 - index, '/a', `id-${index}`))
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  const normal = panel.render(100)
  assert.equal(panel.isExpanded(), false)
  panel.handleInput('\x1bOQ') // F2
  assert.equal(panel.isExpanded(), true)
  const expanded = panel.render(100)
  assert.ok(expanded.length > normal.length, 'the expanded presentation must grant more rows')
  assert.ok(plain(expanded).find(line => line.includes('Input History'))!.includes('F2 collapse'), 'the header advertises the toggle')
  panel.handleInput('\x1bOQ')
  assert.equal(panel.isExpanded(), false)
})

test('panel: the Preview re-anchors its SOURCE offset across a resize instead of a raw row', async () => {
  const source = new FakeSource()
  const prompt = Array.from({ length: 40 }, (_, index) => `source line ${index}`).join('\n')
  source.rows = [row(prompt, 1, '/a', 'p')]
  let columns = 100
  const { panel } = makePanel(source, {
    geometry: { columns: () => columns, rows: () => 30, chromeRows: () => 2 },
  })
  panel.start()
  await settle()
  panel.render(columns)
  panel.handleInput('\x1b[1;3B') // Alt+Down: scroll one Preview row
  panel.render(columns)
  const firstContent = (): string => {
    const lines = plain(panel.render(columns))
    const heading = lines.findIndex(line => line.includes('Preview '))
    return lines[heading + 1] ?? ''
  }
  assert.ok(firstContent().includes('source line 1'), 'the Preview scrolled one source row')
  // A NARROWER terminal soft-wraps every row into two: the anchor must follow the
  // SOURCE (line 1), not the old visual row number.
  columns = 40
  panel.render(columns)
  assert.ok(firstContent().includes('source line 1'), `the source anchor survives the rewrap:\n${plain(panel.render(columns)).join('\n')}`)
})

test('panel: a NEW selected result resets the Preview to its top, a repaint of the SAME one keeps the scroll', async () => {
  const source = new FakeSource()
  const prompt = Array.from({ length: 40 }, (_, index) => `source line ${index}`).join('\n')
  source.rows = [row(prompt, 2, '/a', 'p1'), row('second entry', 1, '/a', 'p2')]
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  panel.render(100)
  panel.handleInput('\x1b[1;3B')
  panel.render(100)
  const headingOf = (): string => plain(panel.render(100)).find(line => line.includes('Preview ')) ?? ''
  const scrolled = headingOf()
  assert.ok(scrolled.includes('rows 2-'), scrolled)
  // A repaint of the SAME result keeps the anchor.
  assert.equal(headingOf(), scrolled)
  // A NEW selection resets it.
  panel.handleInput('\x1b[B')
  panel.render(100)
  assert.ok(headingOf().includes('rows 1-'), 'a new selected result starts the Preview at the top')
})

// ── Copy All / pointer capability ───────────────────────────────────────────

test('panel: Alt+C copies the EXACT selected content in both modes; the regular mode paints NO mouse button', async () => {
  const source = new FakeSource()
  const prompt = '  leading\n中文 and trailing  '
  source.rows = [row(prompt, 1, '/a', 'p')]
  const { panel, copied } = makePanel(source)
  panel.start()
  await settle()
  const lines = plain(panel.render(100))
  assert.ok(lines.some(line => line.includes('Alt+C copy')), 'the regular mode advertises the keyboard hint')
  assert.ok(!lines.some(line => line.includes('Copy All [Alt+C]')), 'the regular mode never paints a fake mouse target')
  panel.handleInput('\x1bc') // Alt+C
  assert.deepEqual(copied, [prompt], 'Alt+C copies the stored source byte for byte')
})

test('panel: the pointer capability refuses every event when it is disabled (regular main screen)', async () => {
  const source = new FakeSource()
  source.rows = [row('alpha', 1, '/a', 'a')]
  const { panel } = makePanel(source) // pointerEnabled defaults to false
  panel.start()
  await settle()
  panel.render(100)
  const event = (type: 'press' | 'click', x: number, y: number): import('@xmoon76/pi-tui').TuiMouseEvent => ({
    type, button: 'left', x, y, screenX: x, screenY: y, width: 100, height: panel.render(100).length,
    shift: false, alt: false, ctrl: false,
  })
  assert.equal(panel.handleMouse(event('press', 4, 3)), undefined, 'a disabled pointer capability handles nothing')
  assert.equal(panel.handleMouse(event('click', 4, 3)), undefined)
})

test('panel: the fullscreen pointer mode paints the actions and a Preview drag copies the exact source range', async () => {
  const source = new FakeSource()
  const prompt = 'a\tb CJK 中文 e\u0301 😀\nsecond'
  source.rows = [row(prompt, 1, '/a', 'p')]
  const copied: string[] = []
  const { panel } = makePanel(source, { pointerEnabled: () => true, onCopy: (text) => copied.push(text) })
  panel.start()
  await settle()
  const raw = panel.render(100)
  const lines = plain(raw)
  assert.ok(lines.some(line => line.includes('Copy All [Alt+C]') && line.includes('Use Selected [Enter]')),
    'the fullscreen Preview heading carries the real clickable actions')
  const height = raw.length
  const headingRow = lines.findIndex(line => line.includes('Copy All [Alt+C]'))
  const firstContentRow = headingRow + 1
  const event = (
    type: 'press' | 'drag' | 'release' | 'click',
    x: number,
    y: number,
  ): import('@xmoon76/pi-tui').TuiMouseEvent => ({
    type, button: 'left', x, y, screenX: x, screenY: y, width: 100, height,
    shift: false, alt: false, ctrl: false,
  })
  panel.handleMouse(event('press', 0, firstContentRow))
  panel.handleMouse(event('drag', 1, firstContentRow + 1))
  panel.handleMouse(event('release', 1, firstContentRow + 1))
  // The gesture spans source row 0 col 0 → row 1 col 1 (the endpoint is
  // INCLUSIVE of the grapheme under it, exactly like the Job Command page): the
  // exact original substring, tab/combining/emoji included, with no rendering
  // round trip.
  assert.deepEqual(copied, ['a\tb CJK 中文 e\u0301 😀\nse'], 'the drag copies the exact source substring')
})

// ── the exact original-source selection mapping (the Preview drag authority) ─

test('history preview mapping: tabs, spaces, CJK, combining marks, emoji, hard breaks and controls survive byte for byte', () => {
  const slice = (source: string, width: number, anchor: [number, number], focus: [number, number]): string | undefined => {
    const layout = buildSourceTextVisualLayout(source, width)
    const range = sourceTextSelectionRange(layout, { row: anchor[0], col: anchor[1] }, { row: focus[0], col: focus[1] })
    return range === undefined ? undefined : source.slice(range.start, range.end)
  }
  const endOffset = (source: string, width: number, row: number, col: number): number | undefined =>
    sourceTextPointOffset(buildSourceTextVisualLayout(source, width), { row, col }, 'end')
  // Hard breaks keep their original bytes in both directions.
  assert.equal(slice('ab\ncd', 80, [0, 0], [1, 1]), 'ab\ncd')
  assert.equal(slice('ab\ncd', 80, [1, 1], [0, 0]), 'ab\ncd')
  // TAB paints three cells but maps ONE `\t`.
  assert.equal(slice('a\tb', 80, [0, 0], [0, 4]), 'a\tb')
  // Leading/trailing spaces have their own offsets (never trimmed).
  assert.equal(slice('  ab  ', 80, [0, 0], [0, 6]), '  ab  ')
  // CJK / combining marks / emoji are never split mid-grapheme: the cell that
  // carries them maps the WHOLE grapheme.
  assert.equal(slice('中文abc', 80, [0, 0], [0, 2]), '中文')
  assert.equal(endOffset('e\u0301x', 80, 0, 0), 2, 'the combining mark rides the base character')
  assert.equal(endOffset('😀x', 80, 0, 0), 2, 'the astral emoji is one grapheme')
  assert.equal(slice('e\u0301x', 80, [0, 0], [0, 1]), 'e\u0301x')
  // A soft wrap inserts nothing: the wrapped rows are one continuous range.
  assert.equal(slice('abcdef', 3, [0, 0], [1, 0]), 'abcd')
  // ANSI/controls are painted as safe escapes and still map their ORIGINAL
  // single character (never the escape's own bytes).
  assert.equal(slice('a\u001b[31mb', 80, [0, 0], [0, 4]), 'a\u001b')
  assert.equal(endOffset('a\u001b[31mb', 80, 0, 0), 1, 'plain text maps one character')
  assert.equal(slice('a\u0000b', 80, [0, 0], [0, 4]), 'a\u0000')
  assert.equal(endOffset('a\u0000b', 80, 0, 0), 1, 'a NUL maps one source character')
})

test('H3A-05: a 200-row page scrolls to row 150 with the marker visible and the stable ID preserved across a resize', async () => {
  const source = new FakeSource()
  source.rows = Array.from({ length: 200 }, (_, index) => row(`entry ${index}`, 200 - index, '/a', `id-${index}`))
  let columns = 100
  const { panel } = makePanel(source, {
    geometry: { columns: () => columns, rows: () => 30, chromeRows: () => 2 },
  })
  panel.start()
  await settle()
  panel.render(columns)
  for (let step = 0; step < 150; step += 1) panel.handleInput('\x1b[B')
  assert.equal(panel.selected()?.id, 'id-150')
  const lines = plain(panel.render(columns))
  const divider = internalDividerRow(lines)
  const painted = lines.slice(0, divider).filter(line => /entry \d+/.test(line))
  assert.ok(painted.some(line => line.startsWith('> ') && line.includes('entry 150')),
    `the selected row must stay inside the painted window:\n${lines.join('\n')}`)
  assert.ok(!lines.some(line => line.includes('entry 0')), 'the window scrolled past the head')
  // A resize re-wraps/repaints but keeps the stable selection identity.
  columns = 60
  const resized = plain(panel.render(columns))
  assert.equal(panel.selected()?.id, 'id-150', 'the stable ID survives the resize')
  assert.ok(resized.some(line => line.startsWith('> ') && line.includes('entry 150')), resized.join('\n'))
})

test('H3A-06: Copy All of a 2000-line prompt is the whole original source, and the Preview reaches its last row', async () => {
  const source = new FakeSource()
  const huge = Array.from({ length: 2000 }, (_, index) => `line ${index}`).join('\n')
  source.rows = [row(huge, 1, '/a', 'huge')]
  const { panel, copied } = makePanel(source, {
    geometry: seatGeometry(100, 30, 2),
  })
  panel.start()
  await settle()
  panel.render(100)
  panel.handleInput('\x1bc') // Alt+C
  assert.deepEqual(copied, [huge], 'Copy All equals the entire original source, byte for byte')
  panel.handleInput('\x1b[1;3F') // Alt+End
  const lines = plain(panel.render(100))
  assert.ok(lines.some(line => line.includes('line 1999')), `the Preview reaches the last source row:\n${lines.join('\n')}`)
  assert.ok(!lines.some(line => line.includes('… more')), 'no truncation marker is ever painted')
})

test('H3A-04: a STALE rejection after a query change never paints the error state', async () => {
  const source = new FakeSource()
  source.manual = true
  const { panel } = makePanel(source)
  panel.start()
  assert.equal(source.requests.length, 1)
  panel.handleInput('a') // invalidates the generation immediately
  source.rejectNext(new Error('stale failure')) // search #1 rejects late
  await flushMicrotasks()
  assert.ok(!plain(panel.render(100)).some(line => line.includes('History unavailable')),
    'the pre-change failure must not commit into the new query')
  await settle(2) // the debounce fires search #2
  source.resolveNext([row('fresh row', 5, '/a', 'fresh')])
  await settle()
  const lines = plain(panel.render(100))
  assert.ok(lines.some(line => line.includes('fresh row')), `the fresh page commits:\n${lines.join('\n')}`)
  assert.ok(!lines.some(line => line.includes('History unavailable')))
})

test('H3A-09: a Preview drag that releases outside the painted region cancels (nothing is copied)', async () => {
  const source = new FakeSource()
  source.rows = [row('abc\ndef', 1, '/a', 'p')]
  const copied: string[] = []
  const { panel } = makePanel(source, {
    geometry: seatGeometry(100, 30, 2),
    pointerEnabled: () => true,
    onCopy: (text) => copied.push(text),
  })
  panel.start()
  await settle()
  const painted = plain(panel.render(100))
  const divider = internalDividerRow(painted)
  const firstContent = painted.findIndex(line => line.includes('Preview ')) + 1
  const listRow = painted.findIndex(line => /entry|abc/.test(line) && !line.includes('Preview '))
  assert.ok(divider > 0 && firstContent > 0 && listRow >= 0 && listRow < divider,
    `the frame must paint a list ABOVE the preview:\n${painted.join('\n')}`)
  const height = panel.render(100).length
  const event = (type: 'press' | 'drag' | 'release', x: number, y: number): import('@xmoon76/pi-tui').TuiMouseEvent => ({
    type, button: 'left', x, y, screenX: x, screenY: y, width: 100, height,
    shift: false, alt: false, ctrl: false,
  })
  panel.handleMouse(event('press', 0, firstContent))
  panel.handleMouse(event('drag', 2, firstContent + 1))
  // The pointer leaves the Preview into the results list and releases there:
  // plan §6 H3A-09 — the drag safely CANCELS (never copies the list underneath).
  panel.handleMouse(event('drag', 5, listRow))
  panel.handleMouse(event('release', 5, listRow))
  assert.deepEqual(copied, [],
    'a drag that leaves the painted Preview and releases outside it copies nothing')
  // The cancelled gesture leaves no live anchor behind.
  panel.handleMouse(event('release', 2, firstContent + 1))
  assert.deepEqual(copied, [], 'the cancelled gesture cannot be resurrected')
})

test('currentness: a stale subject never acts and never publishes (the caller keeps the lifecycle)', async () => {
  const source = new FakeSource()
  source.manual = true
  let current = true
  const { panel, closed } = makePanel(source, {
    pointerEnabled: () => true,
    tenantIsCurrent: () => current,
  })
  panel.start() // search #1 stays pending
  current = false // the captured session moved while it is in flight
  source.resolveNext([row('previous session row', 1, '/a', 'previous')])
  await flushMicrotasks()
  assert.equal(panel.selected(), undefined, 'a previous-subject page is never published')
  assert.equal(panel.hasResults(), false, 'the stale page is not shown as a result')
  assert.equal(closed(), 0, 'the caller-owned lifecycle is never closed from the async path')
  // The seat stays inert: no acceptance, no copy, no pointer action.
  assert.equal(panel.canAccept(), false)
  panel.handleInput('\r')
  assert.equal(panel.selected(), undefined)
})

test('currentness: the pointer and acceptance entries refuse a stale subject', async () => {
  const source = new FakeSource()
  source.rows = [row('alpha prompt', 1, '/a', 'id-a')]
  let current = true
  const { panel, accepted, copied, closed } = makePanel(source, {
    geometry: seatGeometry(100, 30, 2),
    pointerEnabled: () => true,
    tenantIsCurrent: () => current,
  })
  panel.start()
  await settle()
  const painted = plain(panel.render(100))
  const height = painted.length
  const contentRow = painted.findIndex(line => line.includes('Preview ')) + 1
  const event = (type: 'press' | 'release', x: number, y: number): import('@xmoon76/pi-tui').TuiMouseEvent => ({
    type, button: 'left', x, y, screenX: x, screenY: y, width: 100, height,
    shift: false, alt: false, ctrl: false,
  })
  assert.equal(panel.canAccept(), true, 'the live subject may accept')
  current = false
  assert.equal(panel.canAccept(), false, 'a stale subject may not accept')
  panel.handleInput('\r')
  assert.equal(accepted(), undefined, 'a stale Enter is inert')
  panel.handleInput('\x1bc') // Alt+C
  assert.deepEqual(copied, [], 'a stale Copy All copies nothing')
  assert.equal(panel.handleMouse(event('press', 4, contentRow)), undefined,
    'the pointer entry refuses a stale subject')
  assert.equal(closed(), 0, 'refusing an action never closes the panel by itself')
})

test('H3A-09: a release outside the painted Preview cancels the drag (no copy, no surviving anchor)', async () => {
  const source = new FakeSource()
  source.rows = [row('abc\ndef', 1, '/a', 'p')]
  const copied: string[] = []
  const { panel } = makePanel(source, {
    geometry: seatGeometry(100, 30, 2),
    pointerEnabled: () => true,
    onCopy: (text) => copied.push(text),
  })
  panel.start()
  await settle()
  const painted = plain(panel.render(100))
  const height = painted.length
  const contentRow = painted.findIndex(line => line.includes('Preview ')) + 1
  const event = (
    type: 'press' | 'drag' | 'release',
    x: number,
    y: number,
  ): import('@xmoon76/pi-tui').TuiMouseEvent => ({
    type, button: 'left', x, y, screenX: x, screenY: y, width: 100, height,
    shift: false, alt: false, ctrl: false,
  })
  panel.handleMouse(event('press', 0, contentRow))
  panel.handleMouse(event('drag', 2, contentRow + 1))
  // The release lands OUTSIDE the painted rows: plan §6 H3A-09 — safely CANCEL.
  panel.handleMouse(event('release', 2, height + 5))
  assert.deepEqual(copied, [], 'an out-of-frame release copies nothing')
  // The cancelled gesture cannot be extended or resurrected…
  panel.handleMouse(event('drag', 3, contentRow))
  assert.deepEqual(copied, [], 'a motion-only drag after the cancel copies nothing')
  panel.handleMouse(event('release', 3, contentRow))
  assert.deepEqual(copied, [], 'a later release of the cancelled gesture copies nothing')
  // …nor can a release on a DIFFERENT painted region (the metadata row).
  panel.handleMouse(event('press', 0, contentRow))
  panel.handleMouse(event('drag', 2, contentRow + 1))
  panel.handleMouse(event('release', 2, height - 1))
  assert.deepEqual(copied, [], 'a release outside the painted Preview cancels too')
  // A query that commits while the drag is live re-anchors the page: its
  // release is stale and cancels (plan §5.2 step 5).
  copied.length = 0
  panel.handleMouse(event('press', 0, contentRow))
  panel.handleMouse(event('drag', 2, contentRow + 1))
  panel.handleInput('x')
  await settle() // the debounced search commits (a new generation)
  panel.render(100) // an async repaint at the SAME size
  panel.handleMouse(event('release', 2, contentRow + 1))
  assert.deepEqual(copied, [], 'a release of a gesture the async repaint invalidated copies nothing')
  // A width change between press and release cancels as well.
  const tall = panel.render(100).length
  panel.handleMouse(event('press', 0, contentRow))
  panel.handleMouse(event('drag', 2, contentRow + 1))
  panel.render(70) // rewrap: every painted cell moved
  const moved = { ...event('release', 2, contentRow + 1), width: 70, height: tall }
  panel.handleMouse(moved)
  assert.deepEqual(copied, [], 'a release against a frame whose width moved cancels')
  // …and the next REAL press+drag still works (row 0 col 0 → row 1 col 0).
  panel.render(100)
  panel.handleMouse(event('press', 0, contentRow))
  panel.handleMouse(event('drag', 0, contentRow + 1))
  panel.handleMouse(event('release', 0, contentRow + 1))
  assert.deepEqual(copied, ['abc\nd'], 'a fresh gesture still copies its own range')
})

test('pointer: a repaint-free page replacement neither transfers the selection nor moves it on a press', async () => {
  const source = new FakeSource()
  source.manual = true
  const { panel } = makePanel(source, { pointerEnabled: () => true })
  panel.start()
  source.resolveNext([row('alpha prompt', 2, '/a', 'id-a'), row('extra prompt', 1, '/a', 'id-x')])
  await flushMicrotasks()
  const painted = plain(panel.render(100))
  const pressedRow = painted.findIndex(line => line.includes('alpha prompt'))
  const height = painted.length
  assert.ok(pressedRow >= 0, `alpha must paint:\n${painted.join('\n')}`)
  const event = (type: 'press' | 'click', x: number, y: number): import('@xmoon76/pi-tui').TuiMouseEvent => ({
    type, button: 'left', x, y, screenX: x, screenY: y, width: 100, height,
    shift: false, alt: false, ctrl: false,
  })
  panel.handleMouse(event('press', 4, pressedRow))
  assert.equal(panel.selected()?.id, 'id-a', 'the press selects the pressed ID')

  // The page is replaced WITHOUT a repaint: the painted cell now holds BETA and
  // the hit map still names alpha.
  panel.handleInput('x')
  await settle()
  source.resolveNext([row('BETA prompt', 9, '/a', 'id-b'), row('alpha prompt', 2, '/a', 'id-a')])
  await flushMicrotasks()
  assert.equal(panel.selected()?.id, 'id-a', 'the stable ID survives the replacement')
  // The synthesized click resolves against the LAST PAINTED cell, which still
  // names alpha… but the CURRENT page moved BETA there, so the click must not
  // select BETA.
  panel.handleMouse(event('click', 4, pressedRow))
  assert.equal(panel.selected()?.id, 'id-a', 'a click never selects whatever the current page has at the pressed cell')

  // A press on a cell whose painted ID no longer exists is REJECTED outright:
  // paint the page that still contains alpha, then let a commit DROP alpha
  // without repainting.
  const frame = plain(panel.render(100))
  const staleRow = frame.findIndex(line => line.includes('alpha prompt'))
  assert.ok(staleRow >= 0, `the frame must still show alpha:\n${frame.join('\n')}`)
  panel.handleInput('x')
  await settle()
  source.resolveNext([row('BETA prompt', 9, '/a', 'id-b')])
  await flushMicrotasks()
  assert.equal(panel.selected()?.id, 'id-b', 'the commit itself moved the selection to the surviving page')
  assert.equal(panel.handleMouse(event('press', 4, staleRow)), undefined,
    'a press on a row whose id no longer exists is rejected')
  assert.equal(panel.selected()?.id, 'id-b', 'the rejected press never re-selects from the stale hit map')
})

test('H3A-09: the RELEASE position is the drag endpoint (a terminal may fold the last motion into it)', async () => {
  const source = new FakeSource()
  source.rows = [row('abc\ndefghij', 1, '/a', 'p')]
  const copied: string[] = []
  const { panel } = makePanel(source, {
    geometry: seatGeometry(100, 30, 2),
    pointerEnabled: () => true,
    onCopy: (text) => copied.push(text),
  })
  panel.start()
  await settle()
  const painted = plain(panel.render(100))
  const height = painted.length
  const contentRow = painted.findIndex(line => line.includes('Preview ')) + 1
  const event = (
    type: 'press' | 'drag' | 'release',
    x: number,
    y: number,
  ): import('@xmoon76/pi-tui').TuiMouseEvent => ({
    type, button: 'left', x, y, screenX: x, screenY: y, width: 100, height,
    shift: false, alt: false, ctrl: false,
  })
  // press (row 0, col 0) → drag (row 1, col 1) → RELEASE (row 1, col 3): the
  // copied range must end at the release column, not the last drag column.
  panel.handleMouse(event('press', 0, contentRow))
  panel.handleMouse(event('drag', 1, contentRow + 1))
  panel.handleMouse(event('release', 3, contentRow + 1))
  assert.deepEqual(copied, ['abc\ndefg'],
    'the release position finalizes the selection (through the released cell)')
})

test('pointer: a right or middle button can never start a History gesture', async () => {
  const source = new FakeSource()
  source.rows = [row('abc\ndefghij', 1, '/a', 'p'), row('second entry', 2, '/a', 'q')]
  const copied: string[] = []
  const { panel, accepted } = makePanel(source, {
    geometry: seatGeometry(100, 30, 2),
    pointerEnabled: () => true,
    onCopy: (text) => copied.push(text),
  })
  panel.start()
  await settle()
  const painted = plain(panel.render(100))
  const height = painted.length
  const contentRow = painted.findIndex(line => line.includes('Preview ')) + 1
  const secondRow = painted.findIndex(line => line.includes('second entry'))
  const actionRow = painted.findIndex(line => line.includes('Use Selected [Enter]'))
  assert.ok(secondRow >= 0 && actionRow >= 0 && contentRow > 0,
    `the frame must paint rows and actions:\n${painted.join('\n')}`)
  const event = (
    type: 'press' | 'drag' | 'release' | 'click',
    button: 'left' | 'middle' | 'right',
    x: number,
    y: number,
  ): import('@xmoon76/pi-tui').TuiMouseEvent => ({
    type, button, x, y, screenX: x, screenY: y, width: 100, height,
    shift: false, alt: false, ctrl: false,
  })
  const selectedBefore = panel.selected()?.id
  for (const button of ['right', 'middle'] as const) {
    assert.equal(panel.handleMouse(event('press', button, 4, secondRow)), undefined,
      `a ${button} press on a result row must be refused`)
    assert.equal(panel.handleMouse(event('click', button, 4, secondRow)), undefined,
      `a ${button} click on a result row must be refused`)
    assert.equal(panel.handleMouse(event('press', button, 4, contentRow)), undefined,
      `a ${button} press in the Preview must not start a drag`)
    assert.equal(panel.handleMouse(event('press', button, 4, actionRow)), undefined,
      `a ${button} press on an action must be refused`)
  }
  assert.equal(panel.selected()?.id, selectedBefore, 'no non-left press moved the selection')
  assert.equal(accepted(), undefined, 'no non-left action accepted anything')
  assert.deepEqual(copied, [], 'no non-left gesture copied anything')
  // The left button still works in the same frame.
  panel.handleMouse(event('press', 'left', 0, contentRow))
  panel.handleMouse(event('release', 'left', 2, contentRow))
  assert.deepEqual(copied, ['abc'], 'the left button still drags and copies')
})

test('H3A-12: a resize keeps the Preview on the same SOURCE text (real re-wrap, ASCII and CJK)', async () => {
  // Each source LINE is 80 cells: it paints ONE visual row at 100 columns and
  // TWO at 40, so a raw visual-row anchor would land on a different passage.
  const ascii = (index: number): string => `L${String(index).padStart(2, '0')}${'-'.repeat(77)}`
  const source = new FakeSource()
  source.rows = [row(Array.from({ length: 40 }, (_, index) => ascii(index)).join('\n'), 1, '/a', 'p')]
  let columns = 100
  const { panel } = makePanel(source, {
    geometry: { columns: () => columns, rows: () => 30, chromeRows: () => 2 },
  })
  panel.start()
  await settle()
  const firstPreviewRow = (): string => {
    const lines = plain(panel.render(columns))
    const heading = lines.findIndex(line => line.includes('Preview '))
    return lines[heading + 1] ?? ''
  }
  panel.render(100)
  assert.equal(firstPreviewRow(), ascii(0), 'the Preview starts at the first source line')
  for (let step = 0; step < 10; step += 1) panel.handleInput('\x1b[1;3B') // Alt+Down
  assert.equal(firstPreviewRow(), ascii(10), 'ten source rows down at 100 columns')
  columns = 40
  assert.equal(firstPreviewRow(), ascii(10).slice(0, 40),
    'after the re-wrap the SAME source line is at the top (not the same visual row number)')
  columns = 100
  assert.equal(firstPreviewRow(), ascii(10),
    'growing back re-derives the same source row from the anchor')

  // CJK: 60 double-width chars wrap at 50 chars (100 cells) and 20 chars
  // (40 cells) per row, so each source line is 2 rows then 3.
  const cjk = (index: number): string => `${String(index).padStart(2, '0')}${'中文行'.repeat(20)}`
  const cjkSource = new FakeSource()
  cjkSource.rows = [row(Array.from({ length: 20 }, (_, index) => cjk(index)).join('\n'), 1, '/a', 'p2')]
  let cjkColumns = 100
  const { panel: cjkPanel } = makePanel(cjkSource, {
    geometry: { columns: () => cjkColumns, rows: () => 30, chromeRows: () => 2 },
  })
  cjkPanel.start()
  await settle()
  const cjkFirstRow = (): string => {
    const lines = plain(cjkPanel.render(cjkColumns))
    const heading = lines.findIndex(line => line.includes('Preview '))
    return lines[heading + 1] ?? ''
  }
  cjkPanel.render(100)
  for (let step = 0; step < 10; step += 1) cjkPanel.handleInput('\x1b[1;3B') // 5 source lines = 10 rows
  const head = cjkFirstRow()
  // The row must be a REAL prefix of the anchored source line (never of the line
  // a raw visual-row reuse would have landed on).
  assert.ok(head.length >= 10 && cjk(5).startsWith(head),
    `the anchored CJK line must be at the top:\n${JSON.stringify(head)}`)
  assert.ok(!cjk(2).startsWith(head), 'the raw visual row would have shown another source line')
  cjkColumns = 40
  const wrapped = cjkFirstRow()
  assert.ok(wrapped.length >= 10 && cjk(5).startsWith(wrapped),
    `the CJK re-wrap keeps the same source line at the top:\n${JSON.stringify(wrapped)}`)
  assert.ok(!cjk(2).startsWith(wrapped), 'the re-wrap never jumps to another source line')
  assert.ok(wrapped.length < head.length, 'the narrower wrap really shortens the painted row')
})

// ── B3-B: the frozen design-language roles on the History seat ───────────────

test('B3-B visual: identity / active scope / selected row / counter / metadata carry the frozen role tokens', async () => {
  const source = new FakeSource()
  source.rows = [row('alpha prompt', 3, '/work/a', 'a'), row('beta prompt', 2, '/work/b', 'b')]
  const { panel } = makePanel(source, { sessionId: 'ses_a' })
  panel.start()
  await settle()
  const raw = panel.render(100)

  const borderOpen = color.border('\u0000').split('\u0000')[0]!
  assert.ok(raw[0]!.startsWith(`${borderOpen}─`), 'the D15 top boundary rule is the first row')
  assert.ok(raw.at(-1)!.startsWith(`${borderOpen}─`), 'the D15 bottom boundary rule is the last row')
  const header = raw[1]!
  assert.ok(header.startsWith(color.textStrong(' Input History ')), `identity is bold textStrong:\n${header}`)
  assert.ok(header.includes(color.textStrong('[Current Session]', 'primary')), `the active scope is bold primary:\n${header}`)
  assert.ok(header.includes(color.textDim('Current Directory')), 'the inactive scopes are textDim')
  assert.equal(plain([header])[0]!.split('[').length - 1, 1, 'exactly ONE bracketed active scope per header')
  assert.ok(raw[2]!.includes(color.textDim('Search: ')), 'the query label is textDim')
  assert.ok(raw.some(line => line.includes(color.textDim('Results · ')) && line.includes(color.textMuted('2 matches'))),
    'the counter splits its label and count tokens')

  const selectedRow = raw.find(line => line.startsWith(color.primary('> ')))
  assert.ok(selectedRow !== undefined, 'the selected row opens with a primary `> ` gutter')
  assert.ok(selectedRow.includes(color.textStrong('alpha prompt')), 'the selected prompt is bold textStrong')
  assert.ok(selectedRow.includes(color.textDim(`${formatRelativeAge(3).padStart(3)} `)), 'the age stays textDim, never bolded with the row')
  const dimOpen = color.textDim('\u0000').split('\u0000')[0]!
  const metaLine = raw.find(line => plain([line])[0]!.startsWith('  Scope: session'))!
  assert.ok(metaLine.startsWith(`${dimOpen}  Scope: session`), 'the metadata facts are textDim')
  assert.ok(raw.some(line => line.includes(color.textMuted('F2 expand'))), 'the F2 hint is textMuted')
})

test('B3-B action bar: fixed order with Esc last, whole-segment drops, never a partial word', async () => {
  const source = new FakeSource()
  source.rows = [row('alpha', 1, '/work/a', 'a')]
  const { panel } = makePanel(source)
  panel.start()
  await settle()

  const wide = plain(panel.render(120)).find(line => line.includes('Esc cancel'))!
  assert.equal(wide.trimEnd(),
    'Enter use · Tab scope · ↑/↓ results · Alt+↑/↓ preview · Alt+C copy · F2 expand · Esc cancel')

  const mid = plain(panel.render(80)).find(line => line.includes('Esc cancel'))!
  assert.ok(mid.includes('↑/↓') && !mid.includes('↑/↓ results'), `the short form is compacted whole:\n${mid}`)
  assert.ok(mid.trimEnd().endsWith('Esc cancel'), 'Esc stays last')

  const narrow = plain(panel.render(44)).find(line => line.includes('Esc cancel'))!
  assert.ok(narrow.trimEnd().endsWith('Esc cancel'), `Esc survives and stays last:\n${narrow}`)
  assert.ok(!narrow.includes('…'), 'a dropped segment is never a partial word')
  assert.ok(!narrow.includes('· ·') && !narrow.includes('·  ') && !narrow.trimEnd().endsWith('·'), 'no dangling separator')
})

test('B3-B narrow: the F2 hint is removed whole and the scope tabs use the short forms', async () => {
  const source = new FakeSource()
  source.rows = [row('alpha', 1, '/work/a', 'a')]
  const { panel } = makePanel(source, { sessionId: 'ses_a' })
  panel.start()
  await settle()
  const header = plain(panel.render(44)).find(line => line.includes('Input History'))!
  assert.ok(header.includes('Input History'), header)
  assert.ok(header.includes('[Session]'), `the narrow header uses the short scope label:\n${header}`)
  assert.ok(!header.includes('F2'), `the F2 hint is removed whole, never a partial F2 label:\n${header}`)
  assert.ok(!header.includes('exp'), header)
})

test('B3-B placeholders: a no-match is textDim and a failed load paints its word error', async () => {
  const empty = new FakeSource()
  empty.rows = []
  const { panel } = makePanel(empty)
  panel.start()
  // The INITIAL load is async too: wait for its committed empty state before
  // typing, so the query cannot race the first search's generation.
  await waitForHistoryRender(
    panel,
    lines => lines.some(line => line.startsWith(color.textDim('  No history yet'))),
    'initial empty history',
  )
  panel.handleInput('zzz')
  const noMatch = await waitForHistoryRender(
    panel,
    lines => lines.some(line => line.startsWith(color.textDim('  No matching history'))),
    'no-match placeholder',
  )
  assert.ok(noMatch.some(line => line.startsWith(color.textDim('  No matching history'))),
    `a no-match is a textDim placeholder:\n${plain(noMatch).join('\n')}`)

  const failing = new FakeSource()
  failing.fail = true
  const { panel: failedPanel } = makePanel(failing)
  failedPanel.start()
  const failed = await waitForHistoryRender(
    failedPanel,
    lines => lines.some(line => line.startsWith(color.error('  History unavailable'))),
    'failed-load placeholder',
  )
  assert.ok(failed.some(line => line.startsWith(color.error('  History unavailable'))),
    `a failed load paints its word error:\n${plain(failed).join('\n')}`)
  assert.ok(!failed.some(line => line.startsWith(color.textDim('  History unavailable'))),
    'a failure is never painted as a calm placeholder')
})

test('B3-B matrix: the seat never overflows 200x50 / 80x10 / 44x20 and keeps the action bar last', async () => {
  for (const [columns, rows] of [[200, 50], [80, 10], [44, 20]] as const) {
    const source = new FakeSource()
    source.rows = [row('alpha prompt with a much longer body than the row', 3, '/work/a', 'a')]
    const { panel } = makePanel(source, {
      sessionId: 'ses_a',
      geometry: { columns: () => columns, rows: () => rows, chromeRows: () => 0 },
    })
    panel.start()
    await settle()
    const raw = panel.render(columns)
    for (const line of raw) {
      assert.ok(visibleWidthOf(line) <= columns, `${columns}x${rows}: a row exceeds the frame: ${JSON.stringify(line)}`)
    }
    const layout = planHistorySeatLayout(columns, rows, 0, false, { previewable: true })
    if (layout.grant >= 3) {
      const plainLines = plain(raw)
      const last = plainLines[plainLines.length - 1]!
      if (layout.bottomRule) {
        assert.ok(/^─+$/u.test(last.trim()), `${columns}x${rows}: the D15 bottom rule is the last row:\n${last}`)
      }
      const actionBar = layout.bottomRule ? plainLines[plainLines.length - 2]! : last
      assert.ok(actionBar.includes('use') && actionBar.includes('cancel'),
        `${columns}x${rows}: the action bar is the last CONTENT row:\n${actionBar}`)
    }
  }
})

test('B3-B degenerate width: a frame below the frozen matrix never overflows', async () => {
  const source = new FakeSource()
  source.rows = [row('alpha prompt', 1, '/work/a', 'a')]
  const { panel } = makePanel(source, {
    sessionId: 'ses_a',
    geometry: { columns: () => 12, rows: () => 20, chromeRows: () => 0 },
  })
  panel.start()
  await settle()
  const raw = panel.render(12)
  for (const line of raw) {
    assert.ok(visibleWidthOf(line) <= 12, `a degenerate-width row exceeds the frame: ${JSON.stringify(line)}`)
  }
})


// ---------------------------------------------------------------------------
// B3-B theme: dark / light / custom (H3B-16)
// ---------------------------------------------------------------------------

test('B3-B theme: dark/light/custom resolve the frozen role tokens live and never overflow', async () => {
  const source = new FakeSource()
  source.rows = [row('alpha prompt', 3, '/work/a', 'a')]
  const { panel } = makePanel(source, { sessionId: 'ses_a' })
  panel.start()
  await settle()
  const custom: ColorPalette = {
    ...darkColors,
    primary: '#123456',
    textStrong: '#abcdef',
    textDim: '#111111',
    textMuted: '#222222',
    border: '#333333',
    error: '#ff0000',
  }
  const cases: Array<{ name: string; apply: () => void; cursorAnsi?: string }> = [
    { name: 'dark', apply: () => setTheme('dark') },
    { name: 'light', apply: () => setTheme('light') },
    // 0x12,0x34,0x56 → the truecolor SGR the custom primary must really emit.
    { name: 'custom', apply: () => setTheme('custom', custom), cursorAnsi: '\x1b[38;2;18;52;86m' },
  ]
  try {
    for (const themeCase of cases) {
      themeCase.apply()
      const raw = panel.render(100)
      const header = raw.find(line => line.includes('Input History'))!
      assert.ok(header.startsWith(color.textStrong(' Input History ')),
        `${themeCase.name}: identity is bold textStrong`)
      assert.ok(header.includes(color.textStrong('[Current Session]', 'primary')),
        `${themeCase.name}: the active scope is bold primary`)
      const selected = raw.find(line => line.startsWith(color.primary('> ')))
      assert.ok(selected !== undefined && selected.includes(color.textStrong('alpha prompt')),
        `${themeCase.name}: the selected row uses the live primary cursor + bold textStrong label`)
      assert.ok(raw.some(line => line.includes(color.textMuted('F2 expand'))),
        `${themeCase.name}: the F2 hint is textMuted`)
      assert.ok(raw.some(line => line.includes(color.textDim('Results · ')) && line.includes(color.textMuted('1 match'))),
        `${themeCase.name}: the counter splits its tokens`)
      if (themeCase.cursorAnsi !== undefined) {
        assert.ok(selected!.includes(themeCase.cursorAnsi),
          `${themeCase.name}: the custom palette's primary really reaches the cursor (no cached ink)`)
      }
      for (const line of raw) {
        assert.ok(visibleWidthOf(line) <= 100, `${themeCase.name}: a row exceeds the frame`)
      }
    }
  } finally {
    setTheme('dark')
  }
})


test('D15 boundary rules: the bottom rule yields first, leaving a witnessed TOP-only state', () => {
  // 80x12, no chrome: grant = floor(12×.63) = 7. Two rules need an 8-row grant,
  // so the bottom rule has yielded while the top rule and the full mandatory
  // chrome plus a result row stay painted.
  const topOnly = planHistorySeatLayout(80, 12, 0, false, { previewable: true })
  assert.equal(topOnly.grant, 7)
  assert.equal(topOnly.topRule, true, 'the top boundary rule survives')
  assert.equal(topOnly.bottomRule, false, 'the bottom boundary rule yielded first')
  assert.deepEqual([topOnly.header, topOnly.query, topOnly.footer], [true, true, true],
    'the mandatory chrome is untouched by the rule budget')
  assert.ok(topOnly.resultRows >= 1, 'a real result row stays painted')
  assert.ok(topOnly.previewRows >= 1, 'the Preview is not what yielded for the rule')

  // One row narrower: both rules have yielded, still with the mandatory chrome.
  const none = planHistorySeatLayout(80, 11, 0, false, { previewable: true })
  assert.equal(none.grant, 6)
  assert.equal(none.topRule, false)
  assert.equal(none.bottomRule, false)
  assert.deepEqual([none.header, none.query, none.footer], [true, true, true])

  // Non-previewable content keeps BOTH rules at the same small grant: loading /
  // empty / failed needs only its one message row, so the rules are not
  // competing with a Preview region (this is why 80x10 paints rules for
  // error/loading/no-match but not for a ready Preview — documented in the PR).
  const message = planHistorySeatLayout(80, 12, 0, false, { previewable: false })
  assert.equal(message.topRule, true)
  assert.equal(message.bottomRule, true)
  assert.ok(message.resultsRows >= 1, 'the message row stays painted')
})


test('D15 boundary rules: they may compress Results/Preview but never to zero rows', () => {
  // The rules really take rows from the body (the allocation matrix above pins
  // the pre-D15 vs D15 numbers, e.g. 200x60 preview 23 -> 21), yet a real result
  // row and a real Preview content row always survive them.
  for (const [rows, chrome] of [[24, 2], [30, 0], [40, 2], [50, 0], [60, 2]] as const) {
    const layout = planHistorySeatLayout(100, rows, chrome, false, { previewable: true })
    if (layout.topRule || layout.bottomRule) {
      assert.ok(layout.resultRows >= 1, `${rows}x${chrome}: a result row survives the rules`)
      assert.ok(layout.previewRows >= 1, `${rows}x${chrome}: a Preview content row survives the rules`)
    }
  }
  // At the exact boundary the budget removes a rule rather than zeroing the
  // Preview: 80x12 -> grant 7 -> top only (the bottom rule is removed first)
  // while >=1 result row and >=1 Preview row stay painted.
  const topOnly = planHistorySeatLayout(80, 12, 0, false, { previewable: true })
  assert.equal(topOnly.topRule, true)
  assert.equal(topOnly.bottomRule, false)
  assert.ok(topOnly.resultRows >= 1 && topOnly.previewRows >= 1,
    'removing the bottom rule is what protects the one-row Preview floor')
  // A non-previewable state has no Preview to protect: it keeps both rules and
  // its one status/message row.
  const message = planHistorySeatLayout(80, 12, 0, false, { previewable: false })
  assert.equal(message.topRule, true)
  assert.equal(message.bottomRule, true)
  assert.ok(message.resultsRows >= 1)
})
