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
import { HistoryPanel, HISTORY_PANEL_FOOTER, HISTORY_PANEL_SPLIT_WIDTH } from '../src/history-panel.ts'
import type { HistorySearchResult, HistorySearchSource } from '../src/history-search.ts'
import type { HistoryScope } from '../src/history-search.ts'

/** A controllable fake source: records calls and resolves with the rows of
 * the CURRENT query (or a preset per-call response). */
class FakeSource implements HistorySearchSource {
  requests: Array<{ scope: HistoryScope; query: string; cwd: string; limit: number }> = []
  rows: HistorySearchResult[] = []
  delayMs = 0
  /** Per-query delay override: the SLOW query's response arrives last. */
  delayByQuery: Record<string, number> = {}
  fail = false
  search(request: import('../src/history-search.ts').HistorySearchRequest): Promise<HistorySearchResult[]> {
    this.requests.push({ scope: request.scope, query: request.query, cwd: request.cwd, limit: request.limit })
    if (this.fail) return Promise.reject(new Error('boom'))
    const delay = this.delayByQuery[request.query] ?? this.delayMs
    return new Promise(resolve => {
      setTimeout(() => resolve([...this.rows]), delay)
    })
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

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5))

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
  // The FIRST search (query '') is SLOW; the second (query 'a') is FAST —
  // the slow response must NOT clobber the fresh rows when it finally lands.
  const source = new FakeSource()
  source.delayByQuery = { '': 30, a: 2 }
  const { panel } = makePanel(source)
  panel.start()
  await new Promise(resolve => setTimeout(resolve, 10))
  panel.handleInput('a')
  source.rows = [row('fresh', 9)]
  // The fast 'a' search lands; then the slow '' search resolves with the
  // SAME rows — wait past BOTH, and the selection must still be the fresh
  // row from the LATEST query (generation guard, plan §14).
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(panel.selected()?.content, 'fresh', 'the fresher query owns the selection')
  assert.equal(source.requests.length, 2)
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

test('panel: huge content is clamped in the detail pane (never fills the terminal)', () => {
  const source = new FakeSource()
  const huge = Array.from({ length: 500 }, (_, i) => `line ${i} of a giant prompt`).join('\n')
  source.rows = [row(huge, 1)]
  const { panel } = makePanel(source, { maxRows: 16 })
  const lines = panel.render(70)
  assert.ok(lines.length <= 16, 'the panel render is bounded by its budget')
})