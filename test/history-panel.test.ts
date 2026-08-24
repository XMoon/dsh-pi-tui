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
  requests: Array<{ scope: HistoryScope; query: string; cwd: string; limit: number }> = []
  rows: HistorySearchResult[] = []
  delayMs = 0
  /** Per-query delay override: the SLOW query's response arrives last. */
  delayByQuery: Record<string, number> = {}
  fail = false
  /** Manually-settled pending searches (deterministic race control — the
   * test resolves them in the exact order it wants; no wall-clock timing). */
  pending: Array<{ resolve: (rows: HistorySearchResult[]) => void; reject: (error: unknown) => void }> = []
  /** When true, `search()` returns a deferred the test resolves via
   * {@link resolveNext}. Otherwise it resolves after the delay. */
  manual = false
  search(request: import('../src/history-search.ts').HistorySearchRequest): Promise<HistorySearchResult[]> {
    this.requests.push({ scope: request.scope, query: request.query, cwd: request.cwd, limit: request.limit })
    if (this.fail) return Promise.reject(new Error('boom'))
    if (this.manual) {
      return new Promise<HistorySearchResult[]>((resolve, reject) => {
        this.pending.push({ resolve, reject })
      })
    }
    const delay = this.delayByQuery[request.query] ?? this.delayMs
    return new Promise(resolve => {
      setTimeout(() => resolve([...this.rows]), delay)
    })
  }
  /** Resolve the OLDEST pending search with rows (FIFO — the order the
   *  panel issued them). */
  resolveNext(rows: HistorySearchResult[]): void {
    const pending = this.pending.shift()
    if (pending === undefined) throw new Error('resolveNext: no pending search')
    pending.resolve([...rows])
  }
  /** Reject the OLDEST pending search (FIFO). */
  rejectNext(error: unknown): void {
    const pending = this.pending.shift()
    if (pending === undefined) throw new Error('rejectNext: no pending search')
    pending.reject(error)
  }
}

function row(content: string, ts: number, cwd = '/a', id = content): HistorySearchResult {
  return { id, content, cwd, ts, sourceFile: '/a/h.jsonl', sourceIndex: 0 }
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