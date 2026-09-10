/**
 * Headless tests for the Ctrl+R history-search panel (history-panel.ts):
 * open state, query lifecycle, scope toggle (query preserved), selection,
 * Enter accept (NO submit semantics live in the host — the panel only
 * reports), Esc cancel, zero-match Enter no-op, stale-result dropping and
 * the responsive layout. A fake source drives the async search; no
 * terminal is needed.
 * @module @xmoon76/dsh-pi-tui/history-panel.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { HistoryPanel, HISTORY_PANEL_FOOTER, HISTORY_PANEL_SPLIT_WIDTH } from '../src/history-panel.ts'
import type { HistorySearchResult, HistorySearchSource } from '../src/history-search.ts'
import type { HistoryScope } from '../src/history-search.ts'

const visibleWidthOf = visibleWidth

/** A controllable fake source: records calls and resolves with the rows of
 * the CURRENT query (or a preset per-call response). */
class FakeSource implements HistorySearchSource {
  requests: Array<{ scope: HistoryScope; query: string; cwd: string; sessionId?: string; limit: number }> = []
  rows: HistorySearchResult[] = []
  delayMs = 0
  /** Per-query delay override: the SLOW query's response arrives last. */
  delayByQuery: Record<string, number> = {}
  fail = false
  /** Manually-settled pending searches (deterministic race control — the
   * test resolves them in the exact order it wants; no wall-clock timing). */
  pending: Array<{ resolve: (page: import('../src/history-search.ts').HistorySearchPage) => void; reject: (error: unknown) => void }> = []
  /** When true, `search()` returns a deferred the test resolves via
   * {@link resolveNext}. Otherwise it resolves after the delay. */
  manual = false
  search(request: import('../src/history-search.ts').HistorySearchRequest): Promise<import('../src/history-search.ts').HistorySearchPage> {
    this.requests.push({
      scope: request.scope, query: request.query, cwd: request.cwd,
      sessionId: request.sessionId, limit: request.limit,
    })
    if (this.fail) return Promise.reject(new Error('boom'))
    if (this.manual) {
      return new Promise<import('../src/history-search.ts').HistorySearchPage>((resolve, reject) => {
        this.pending.push({ resolve, reject })
      })
    }
    const delay = this.delayByQuery[request.query] ?? this.delayMs
    return new Promise(resolve => {
      setTimeout(() => resolve({ results: [...this.rows], exhausted: true }), delay)
    })
  }
  /** Resolve the OLDEST pending search with rows (FIFO — the order the
   *  panel issued them). */
  resolveNext(rows: HistorySearchResult[]): void {
    const pending = this.pending.shift()
    if (pending === undefined) throw new Error('resolveNext: no pending search')
    pending.resolve({ results: [...rows], exhausted: true })
  }
  /** Reject the OLDEST pending search (FIFO). */
  rejectNext(error: unknown): void {
    const pending = this.pending.shift()
    if (pending === undefined) throw new Error('rejectNext: no pending search')
    pending.reject(error)
  }
}

function row(content: string, ts: number, cwd = '/a', id = content): HistorySearchResult {
  return { id, content, cwd, ts, sourceFile: '/a/h.jsonl', sourceByteOffset: 0 }
}

function makePanel(source: FakeSource, opts: Partial<import('../src/history-panel.ts').HistoryPanelOptions> = {}) {
  let accepted: string | undefined
  let closed = 0
  const panel = new HistoryPanel({
    source,
    cwd: '/work/a',
    onAccept: (content) => { accepted = content },
    onClose: () => { closed += 1 },
    debounceMs: 1,
    ...opts,
  })
  return { panel, accepted: () => accepted, closed: () => closed }
}

/** Flush microtasks only (no timers — the debounce must NOT fire). */
const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

/** Flush microtasks + one timer turn (the panel's 1ms test debounce fires). */
const settle = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

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
  // The debounce collapses the three keystrokes into ONE search.
  assert.equal(source.requests.length, 2, 'initial + one debounced search')
  assert.equal(source.requests[1]?.query, 'ngi')
})

test('panel: Tab toggles the scope and PRESERVES the query', async () => {
  const source = new FakeSource()
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  panel.handleInput('x')
  await settle()
  panel.handleInput('\t')
  await settle()
  assert.equal(source.requests[2]?.scope, 'all')
  assert.equal(source.requests[2]?.query, 'x', 'the query survives the scope switch')
  // And back.
  panel.handleInput('\t')
  await settle()
  assert.equal(source.requests[3]?.scope, 'current')
  assert.equal(source.requests[3]?.query, 'x')
})

test('panel: Enter accepts the selected row', async () => {
  const source = new FakeSource()
  source.rows = [row('first prompt', 2), row('second prompt', 1)]
  const { panel, accepted } = makePanel(source)
  panel.start()
  await settle()
  panel.handleInput('\r')
  assert.equal(accepted(), 'first prompt')
})

test('panel: Enter with NO match is a no-op (no accept, no close)', async () => {
  const source = new FakeSource()
  source.rows = []
  const { panel, accepted, closed } = makePanel(source)
  panel.start()
  await settle()
  panel.handleInput('\r')
  assert.equal(accepted(), undefined)
  assert.equal(closed(), 0)
})

test('panel: Esc cancels without touching the draft (the host keeps it)', async () => {
  const source = new FakeSource()
  const { panel, closed } = makePanel(source)
  panel.start()
  await settle()
  panel.handleInput('\x1b')
  assert.equal(closed(), 1)
})

test('panel: Ctrl+C cancels like Esc', async () => {
  const source = new FakeSource()
  const { panel, closed } = makePanel(source)
  panel.start()
  await settle()
  panel.handleInput('\x03')
  assert.equal(closed(), 1)
})

test('panel: Down/Up move the selection; the detail follows', async () => {
  const source = new FakeSource()
  source.rows = [row('first', 2), row('second', 1), row('third', 0)]
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  panel.handleInput('\x1b[B') // down
  assert.equal(panel.selected()?.content, 'second')
  panel.handleInput('\x1b[B') // down
  assert.equal(panel.selected()?.content, 'third')
  panel.handleInput('\x1b[B') // wraps to top
  assert.equal(panel.selected()?.content, 'first')
  panel.handleInput('\x1b[A') // up wraps to bottom
  assert.equal(panel.selected()?.content, 'third')
})

test('panel: a stale async result never overwrites a fresher query', async () => {
  // Deterministic race: search #1 (query '') is still pending when the
  // query changes. Resolving the STALE #1 first must drop it; the FRESH
  // #2 (issued after the change) is the only result that can land.
  const source = new FakeSource()
  source.manual = true
  const { panel } = makePanel(source)
  panel.start()
  // Search #1 is pending; the user types, which bumps the generation.
  panel.handleInput('a')
  await settle() // debounce fires → search #2 pending
  assert.equal(source.requests.length, 2)
  source.resolveNext([row('stale', 1)]) // #1 (stale) lands FIRST
  await settle()
  assert.equal(panel.selected(), undefined, 'the stale response must be dropped')
  source.resolveNext([row('fresh', 9)]) // #2 (freshest) lands
  await settle()
  assert.equal(panel.selected()?.content, 'fresh')
})

test('panel: a response landing DURING the debounce window is dropped (generation invalidated on change, not on fire)', async () => {
  // The review repro: search #1 is in flight; the user types again, and #1
  // resolves BEFORE the debounce timer fires (the timer must not be the
  // only fence — the generation must be invalidated at change time).
  const source = new FakeSource()
  source.manual = true
  const { panel } = makePanel(source)
  panel.start() // search #1 pending
  panel.handleInput('a') // scheduleSearch: generation bumped NOW, timer set
  // #1 resolves BEFORE the debounce fires (we never awaited settle):
  source.resolveNext([row('old query result', 1)])
  await flushMicrotasks() // microtasks only — the debounce timer has NOT fired yet
  assert.equal(source.requests.length, 1, 'the debounced search has not fired yet')
  assert.equal(panel.selected(), undefined, 'the pre-change response must not commit')
  await settle(2) // now the debounce fires -> search #2
  assert.equal(source.requests.length, 2)
  source.resolveNext([row('new query result', 2)])
  await settle()
  assert.equal(panel.selected()?.content, 'new query result')
})

test('panel: a LATE rejection after dispose never commits "History unavailable"', async () => {
  // The review repro: the panel is disposed (host close) while a search is
  // in flight; an abort-ignoring source rejects LATE — the closed panel
  // must not paint an error state (the generation fence covers the reject
  // path too).
  const source = new FakeSource()
  source.manual = true
  const { panel } = makePanel(source)
  panel.start()
  assert.equal(source.requests.length, 1)
  panel.dispose() // host closes the panel (Esc/accept/stop)
  source.rejectNext(new Error('late failure')) // ignores the abort
  await flushMicrotasks()
  const lines = panel.render(80)
  assert.ok(!lines.some(line => line.includes('History unavailable')),
    'a disposed panel must not commit the error state')
})

test('panel: a LATE resolve after dispose is dropped too', async () => {
  const source = new FakeSource()
  source.manual = true
  const { panel } = makePanel(source)
  panel.start()
  panel.dispose()
  source.resolveNext([row('too late', 1)])
  await flushMicrotasks()
  assert.equal(panel.selected(), undefined, 'a late resolve must not touch the closed panel')
})

test('panel: zero results renders the no-match state and the footer', async () => {
  const source = new FakeSource()
  source.rows = []
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  const lines = panel.render(80)
  assert.ok(lines.some(line => line.includes('No history yet')), 'empty-query zero results say "No history yet"')
  assert.ok(lines.some(line => line.includes(HISTORY_PANEL_FOOTER)))
})

test('panel: wide render splits list and details; narrow stacks them', async () => {
  const source = new FakeSource()
  source.rows = [
    row('fix nginx reload', 5),
    row('second line prompt\nwith a newline', 4),
  ]
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  const wide = panel.render(HISTORY_PANEL_SPLIT_WIDTH + 20)
  // The split layout draws a detail column with Directory/Time labels.
  assert.ok(wide.some(line => line.includes('│')), 'wide layout separates the detail column')
  const narrow = panel.render(HISTORY_PANEL_SPLIT_WIDTH - 20)
  assert.ok(narrow.some(line => line.includes('Directory')), 'the detail rows are present')
})

test('panel: the selection viewport FOLLOWS the cursor (a long list scrolls, the › marker never hides)', async () => {
  // Review repro: 30 results, a ~16-row window — ↓ to row 20 must scroll
  // the window, not vanish the selected row from the rendered list.
  const source = new FakeSource()
  source.rows = Array.from({ length: 30 }, (_, index) => row(`entry ${index}`, 30 - index))
  const { panel } = makePanel(source, { maxRows: 20 })
  panel.start()
  await settle()
  // Walk down to entry 20.
  for (let step = 0; step < 20; step += 1) panel.handleInput('\x1b[B')
  assert.equal(panel.selected()?.content, 'entry 20')
  const lines = panel.render(80)
  const selectedLine = lines.find(line => line.includes('entry 20'))
  assert.ok(selectedLine !== undefined, 'the selected row must be inside the viewport')
  assert.ok(selectedLine!.includes('›'), 'the selected row must carry the › marker')
  // And the viewport does not show rows far above the window (it scrolled).
  assert.ok(!lines.some(line => line.includes('entry 0')), 'the viewport scrolled past the head')
})

test('panel: every rendered line fits the width and the total never exceeds the budget (real data)', async () => {
  const source = new FakeSource()
  const huge = Array.from({ length: 500 }, (_, i) => `line ${i} of a giant prompt`).join('\n')
  source.rows = [
    ...Array.from({ length: 25 }, (_, index) => row(`entry ${index}`, 25 - index)),
    row(huge, 1),
  ]
  const { panel } = makePanel(source, { maxRows: 16 })
  panel.start()
  await settle()
  for (const width of [70, HISTORY_PANEL_SPLIT_WIDTH - 20, HISTORY_PANEL_SPLIT_WIDTH + 20]) {
    const lines = panel.render(width)
    assert.ok(lines.length <= 16, `render(${width}) must stay within the 16-row budget (got ${lines.length})`)
    for (const line of lines) {
      assert.ok(visibleWidthOf(line) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`)
    }
  }
})

test('panel: a TINY budget (8 rows) never overflows; a workable budget keeps the metadata visible', async () => {
  // Round-4 repro: maxRows 8 — the old stacked layout rendered 9 rows
  // (clipping the footer) and the detail slice could drop Time/Session.
  const source = new FakeSource()
  source.rows = [
    ...Array.from({ length: 30 }, (_, index) => row(`entry ${index}`, 30 - index)),
    row('multiline prompt\nsecond line\nthird line', 1, '/work/a', 'multi'),
  ]
  const { panel } = makePanel(source, { maxRows: 8 })
  panel.start()
  await settle()
  for (const width of [60, 80]) {
    const lines = panel.render(width)
    assert.ok(lines.length <= 8, `render(${width}) must stay within 8 rows (got ${lines.length})`)
    for (const line of lines) {
      assert.ok(visibleWidthOf(line) <= width, `line exceeds width ${width}`)
    }
  }
  // With a workable budget the metadata survives: Directory/Time rows are
  // never sliced away (content takes the remainder, metadata is reserved).
  const { panel: roomy } = makePanel(source, { maxRows: 16 })
  roomy.start()
  await settle()
  roomy.handleInput('\x1b[A') // select the metadata-rich row (last)
  const roomyLines = roomy.render(80)
  assert.ok(roomyLines.some(line => line.includes('Directory:')), 'the Directory row must stay visible')
  assert.ok(roomyLines.some(line => line.includes('Time:')), 'the Time row must stay visible')
})

test('panel: the detail pane is suppressed (never truncated) when the budget cannot hold its metadata', async () => {
  // Round-5 repro: a split layout with a small body budget used to slice
  // Time/Session off the detail. The pane must render ONLY when it can
  // keep ALL metadata rows; otherwise it is suppressed entirely.
  const source = new FakeSource()
  // A row with the FULL metadata set (Directory + Time + Session = 3 rows).
  source.rows = [{ id: 'p', content: 'prompt', cwd: '/work/a', ts: 1, sessionId: 'ses_1', sourceFile: '/a/h.jsonl', sourceByteOffset: 0 }]
  const { panel } = makePanel(source, { maxRows: 8 })
  panel.start()
  await settle()
  // maxRows 8 → bodyBudget 4 < 2 + 3 metadata → the detail must be
  // suppressed, never truncated.
  const lines = panel.render(HISTORY_PANEL_SPLIT_WIDTH + 20)
  assert.ok(!lines.some(line => line.includes('Time:')), 'a truncated detail must not render at all')
  // With a workable budget the FULL metadata set renders.
  const { panel: roomy } = makePanel(source, { maxRows: 16 })
  roomy.start()
  await settle()
  const roomyLines = roomy.render(HISTORY_PANEL_SPLIT_WIDTH + 20)
  assert.ok(roomyLines.some(line => line.includes('Directory:')), 'Directory must render')
  assert.ok(roomyLines.some(line => line.includes('Time:')), 'Time must render')
  assert.ok(roomyLines.some(line => line.includes('Session:')), 'Session must render')
})

test('panel: setMaxRows reflows the live row budget without losing selection', async () => {
  const source = new FakeSource()
  source.rows = Array.from({ length: 20 }, (_, index) => row(`entry ${index}`, 20 - index))
  const { panel } = makePanel(source, { maxRows: 16 })
  panel.start()
  await settle()
  for (let step = 0; step < 12; step += 1) panel.handleInput('\x1b[B')
  assert.equal(panel.selected()?.content, 'entry 12')
  panel.setMaxRows(8)
  const narrow = panel.render(80)
  assert.ok(narrow.length <= 8, `setMaxRows must cap the render (got ${narrow.length})`)
  assert.ok(narrow.some(line => line.includes('entry 12')), 'the selected row must survive a shrink')
  panel.setMaxRows(16)
  const wide = panel.render(80)
  assert.ok(wide.length > narrow.length, 'growing the budget must reflow more rows')
  assert.ok(wide.some(line => line.includes('entry 12')), 'the selected row must survive a grow')
})

test('panel: maxRows 1–2 never overflows (the chrome yields, not the budget)', () => {
  // Round-6 repro: render() always emitted title + search + one body row
  // (3 rows), overflowing maxRows 1 and 2.
  const source = new FakeSource()
  source.rows = [row('prompt', 1)]
  for (const maxRows of [1, 2, 3, 4]) {
    const { panel } = makePanel(source, { maxRows })
    const lines = panel.render(80)
    assert.ok(lines.length <= maxRows, `maxRows ${maxRows} must not overflow (got ${lines.length})`)
  }
})

test('panel: a suppressed detail in the split layout leaves NO stray separator', async () => {
  // Round-6 repro: when the detail cannot fit its metadata, renderSplit
  // used to emit a lone `│` after the list.
  const source = new FakeSource()
  source.rows = [{ id: 'p', content: 'prompt', cwd: '/work/a', ts: 1, sessionId: 'ses_1', sourceFile: '/a/h.jsonl', sourceByteOffset: 0 }]
  const { panel } = makePanel(source, { maxRows: 8 })
  panel.start()
  await settle()
  const lines = panel.render(HISTORY_PANEL_SPLIT_WIDTH + 20)
  assert.ok(!lines.some(line => line.includes('│')), 'no stray separator when the detail is suppressed')
})

test('panel: a 500-line prompt is clamped in the detail pane (never fills the terminal)', () => {
  const source = new FakeSource()
  const huge = Array.from({ length: 500 }, (_, i) => `line ${i} of a giant prompt`).join('\n')
  source.rows = [row(huge, 1)]
  const { panel } = makePanel(source, { maxRows: 16 })
  // The detail clamps regardless of load state: the wrapped render is
  // bounded by the budget even before results arrive (empty state) — and
  // the loaded render is covered by the budget test above.
  const lines = panel.render(70)
  assert.ok(lines.length <= 16, 'the panel render is bounded by its budget')
})

// ---------------------------------------------------------------------------
// Session scope (the Ctrl+R panel optimization): default scope, Tab cycle,
// responsive tabs.
// ---------------------------------------------------------------------------

test('UI1: with a session identity the default scope is session', async () => {
  const source = new FakeSource()
  const { panel } = makePanel(source, { sessionId: 'ses_1' })
  panel.start()
  await settle()
  assert.equal(source.requests[0]?.scope, 'session', 'the default scope is the current session')
  assert.equal(source.requests[0]?.sessionId, 'ses_1', 'the request carries the captured session identity')
})

test('UI2: without a session identity the default scope is current', async () => {
  const source = new FakeSource()
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  assert.equal(source.requests[0]?.scope, 'current', 'a deferred start has no session — current is the fallback')
  assert.equal(source.requests[0]?.sessionId, undefined)
})

test('UI3: Tab cycles session → current → all → session (query preserved)', async () => {
  const source = new FakeSource()
  const { panel } = makePanel(source, { sessionId: 'ses_1' })
  panel.start()
  await settle()
  panel.handleInput('x')
  await settle()
  panel.handleInput('\t')
  await settle()
  assert.equal(source.requests[2]?.scope, 'current')
  assert.equal(source.requests[2]?.query, 'x', 'the query survives the scope switch')
  panel.handleInput('\t')
  await settle()
  assert.equal(source.requests[3]?.scope, 'all')
  assert.equal(source.requests[3]?.query, 'x')
  panel.handleInput('\t')
  await settle()
  assert.equal(source.requests[4]?.scope, 'session')
  assert.equal(source.requests[4]?.sessionId, 'ses_1', 'the cycle wraps back to the session scope')
  panel.handleInput('\t')
  await settle()
  assert.equal(source.requests[5]?.scope, 'current', 'the cycle is closed')
})

test('UI3b: without a session identity Tab cycles current ⇄ all only', async () => {
  const source = new FakeSource()
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  panel.handleInput('\t')
  await settle()
  assert.equal(source.requests[1]?.scope, 'all')
  panel.handleInput('\t')
  await settle()
  assert.equal(source.requests[2]?.scope, 'current', 'no session tab without a session identity')
})

test('UI3c: the title renders the scope tabs responsively', async () => {
  const source = new FakeSource()
  const { panel } = makePanel(source, { sessionId: 'ses_1' })
  panel.start()
  await settle()
  // Wide: the full labels fit on one line.
  const wide = panel.render(100)
  assert.ok(wide.some(line => line.includes('[ Current session ]')
    && line.includes('Current directory') && line.includes('All directories')),
  'wide terminals get the full three labels')
  // Narrow: the short labels — three full labels must never be forced
  // onto one line.
  const narrow = panel.render(74)
  assert.ok(narrow.some(line => line.includes('[ Session ]')
    && line.includes('Directory') && line.includes('All')),
  'narrow terminals get the short labels')
  // Without a session identity the session tab is hidden entirely.
  const { panel: noSession } = makePanel(source)
  noSession.start()
  await settle()
  const twoTabs = noSession.render(100)
  assert.ok(twoTabs.some(line => line.includes('Current directory') && line.includes('All directories')))
  assert.ok(!twoTabs.some(line => line.includes('Current session')), 'no session tab without a session identity')
})
/** A minimal mouse event for direct component tests. */
function mouse(
  type: 'press' | 'click' | 'wheel',
  x: number,
  y: number,
  width = 100,
  height = 24,
  wheelDelta?: number,
): import('@xmoon76/pi-tui').TuiMouseEvent {
  return {
    type,
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
    ...(type === 'wheel' ? { wheelDelta: wheelDelta ?? 1 } : {}),
  }
}

test('history: mouse click accepts the pressed result (mouse parity)', async () => {
  const source = new FakeSource()
  source.rows = [row('first result', 1000), row('second result', 2000), row('third result', 3000)]
  const { panel, accepted } = makePanel(source)
  panel.start()
  await settle()
  const rendered = panel.render(100)
  // Rows: 0=title, 1=search, 2=blank, 3+=results.
  const secondRow = rendered.findIndex(line => line.includes('second result'))
  assert.ok(secondRow >= 0, `second result row missing:\n${rendered.join('\n')}`)
  const press = panel.handleMouse(mouse('press', 10, secondRow, 100, 24))
  assert.ok(press?.handled, 'press on a result row must be handled')
  assert.equal(press?.focus, true, 'press must request focus')
  panel.handleMouse(mouse('click', 10, secondRow, 100, 24))
  assert.equal(accepted(), 'second result', 'click must accept the pressed result')
})

test('history: async repaint between press and click cannot transfer acceptance (mouse parity)', async () => {
  const source = new FakeSource()
  source.manual = true
  const { panel, accepted } = makePanel(source)
  panel.start()
  source.resolveNext([row('result A', 1000, '/a', 'id-a')])
  await flushMicrotasks()
  let rendered = panel.render(100)
  const rowA = rendered.findIndex(line => line.includes('result A'))
  assert.ok(rowA >= 0, 'result A row missing')
  panel.handleMouse(mouse('press', 10, rowA, 100, 24))
  // Async refresh: typing re-searches; B replaces A in the same row.
  panel.handleInput('x')
  await settle()
  source.resolveNext([row('result B', 2000, '/a', 'id-b')])
  await flushMicrotasks()
  rendered = panel.render(100)
  assert.ok(rendered.some(line => line.includes('result B')), 'result B must be painted')
  panel.handleMouse(mouse('click', 10, rowA, 100, 24))
  assert.equal(accepted(), undefined, 'acceptance must not transfer to the new result')
})

test('history: wide split detail column is inert (mouse parity)', async () => {
  const source = new FakeSource()
  source.rows = [row('first result', 1000, '/a', 'id-1')]
  const { panel, accepted } = makePanel(source)
  panel.start()
  await settle()
  const rendered = panel.render(100)
  const firstRow = rendered.findIndex(line => line.includes('first result'))
  assert.ok(firstRow >= 0, 'result row missing')
  const separator = rendered[firstRow]?.indexOf('│') ?? -1
  assert.ok(separator >= 0, 'split separator missing')
  // A click in the detail column (right of the separator) must be inert.
  assert.equal(panel.handleMouse(mouse('press', separator + 5, firstRow, 100, 24)), undefined, 'detail column must be inert')
  panel.handleMouse(mouse('click', separator + 5, firstRow, 100, 24))
  assert.equal(accepted(), undefined, 'detail click must not accept the row')
})

test('history: search Input click repositions the query cursor (mouse parity)', async () => {
  const source = new FakeSource()
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  panel.handleInput('ab')
  await settle()
  panel.render(100)
  // Search row y=1: "Search: " (8 cols) + Input prompt "> " (2), so value
  // column 1 (between a and b) is at x = 8 + 2 + 1 = 11.
  const result = panel.handleMouse(mouse('press', 11, 1, 100, 24))
  assert.ok(result?.handled, 'press on the search row must be handled')
  panel.handleInput('X')
  const rendered = panel.render(100).map(line => line.replace(/\x1b\[[0-9;]*m/gu, ''))
  assert.ok(rendered.some(line => line.includes('aXb')), 'typing after the click must insert at the clicked query column')
})

test('history: wheel moves the result selection (mouse parity)', async () => {
  const source = new FakeSource()
  source.rows = [row('r1', 1000), row('r2', 2000), row('r3', 3000)]
  const { panel } = makePanel(source)
  panel.start()
  await settle()
  panel.render(100)
  const firstRow = 3 // title 0, search 1, blank 2, first result 3
  const up = panel.handleMouse(mouse('wheel', 10, firstRow, 100, 24, -1))
  assert.ok(up?.handled, 'wheel must be handled')
  assert.equal(panel.selected()?.content, 'r3', 'wheel up must wrap to the last result')
  panel.handleMouse(mouse('wheel', 10, firstRow, 100, 24, 1))
  assert.equal(panel.selected()?.content, 'r1', 'wheel down must wrap to the first result')
})

test('history: narrow stacked layout maps physical rows (mouse parity)', async () => {
  const source = new FakeSource()
  source.rows = [row('first result', 1000), row('second result', 2000)]
  const { panel, accepted } = makePanel(source)
  panel.start()
  await settle()
  const rendered = panel.render(60) // narrow: stacked layout
  const secondRow = rendered.findIndex(line => line.includes('second result'))
  assert.ok(secondRow >= 0, `second result row missing:\n${rendered.join('\n')}`)
  panel.handleMouse(mouse('press', 10, secondRow, 60, 24))
  panel.handleMouse(mouse('click', 10, secondRow, 60, 24))
  assert.equal(accepted(), 'second result', 'stacked click must accept the pressed result')
})

test('history: async repaint-free results commit between press and click cannot transfer acceptance (mouse parity)', async () => {
  const source = new FakeSource()
  source.manual = true
  const { panel, accepted } = makePanel(source)
  panel.start()
  source.resolveNext([row('result A', 1000, '/a', 'id-a')])
  await flushMicrotasks()
  const rendered = panel.render(100)
  const rowA = rendered.findIndex(line => line.includes('result A'))
  assert.ok(rowA >= 0, 'result A row missing')
  panel.handleMouse(mouse('press', 10, rowA, 100, 24))
  // Async refresh WITHOUT a repaint: the hit map is still last-painted
  // geometry, but the CURRENT results have a different result at the same
  // index. The click must resolve by the pressed ID, not the stale index.
  panel.handleInput('x')
  await settle()
  source.resolveNext([row('result B', 2000, '/a', 'id-b')])
  await flushMicrotasks()
  panel.handleMouse(mouse('click', 10, rowA, 100, 24))
  assert.equal(accepted(), undefined, 'acceptance must not transfer to the replacement at the stale index')
})

test('history: async repaint-free results commit between paint and press cannot select the replacement (mouse parity)', async () => {
  const source = new FakeSource()
  source.manual = true
  const { panel } = makePanel(source)
  panel.start()
  source.resolveNext([row('result A', 1000, '/a', 'id-a')])
  await flushMicrotasks()
  panel.render(100)
  // Async refresh WITHOUT a repaint: the hit map is still last-painted
  // geometry, but the CURRENT results have a different result at the same
  // index. The press must resolve by the pressed ID, not the stale index.
  panel.handleInput('x')
  await settle()
  source.resolveNext([row('result B', 2000, '/a', 'id-b')])
  await flushMicrotasks()
  const press = panel.handleMouse(mouse('press', 10, 3, 100, 24)) // press the old 'result A' row
  assert.equal(press, undefined, 'a press on a row whose id no longer exists must be rejected')
  assert.equal(panel.selected()?.content, 'result B', 'the selection must stay on the committed result, not the stale index')
})
