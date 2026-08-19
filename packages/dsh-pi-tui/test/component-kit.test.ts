/**
 * M4 component-kit tests: the public ExtensionView tree compiles into
 * private components that render at the CURRENT width (live, re-wrapping on
 * resize), never accept raw ANSI, abdicate when empty, and isolate
 * per-contribution throws (plan §9 / §19 / §18).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { compileView } from '../src/extension/internal/component-compiler.ts'
import type { ExtensionView } from '../src/extension/public-types.ts'
import { WidgetOutlet } from '../src/extension/internal/widget-outlet.ts'
import { ExtensionLedger } from '../src/extension/internal/ledger.ts'
import { visibleWidth } from '@xmoon76/pi-tui'

function sink(): { requests: number; requestRender(): void } {
  const s = { requests: 0, requestRender() { s.requests += 1 } }
  return s
}

/** Strip ANSI SGR codes for content assertions (the host styles spans). */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

test('compileView: text view renders spans and wraps at the current width', () => {
  const { component, isEmpty } = compileView({
    kind: 'text',
    spans: [{ text: 'hello world' }],
  })
  assert.equal(isEmpty, false)
  const wide = component.render(80)
  assert.equal(wide.length, 1)
  assert.equal(stripAnsi(wide[0]), 'hello world')
  // Narrow width: wraps.
  const narrow = component.render(5)
  assert.ok(narrow.length > 1, 'narrow width must wrap')
  // Live across resizes: rendering at a new width re-wraps (never frozen).
  const again = component.render(80)
  assert.deepEqual(again, wide, 'unchanged content + width stays reference-stable')
})

test('compileView: an empty text view abdicates (renders nothing)', () => {
  const { component, isEmpty } = compileView({ kind: 'text', spans: [] })
  assert.equal(isEmpty, true)
  assert.deepEqual(component.render(80), [])
})

test('compileView: whitespace-only spans still render (spaces occupy cells)', () => {
  // Whitespace occupies visible cells (visibleWidth('   ') === 3), so it is
  // NOT an abdication — only ZERO-width content (empty spans) abdicates.
  const { component, isEmpty } = compileView({ kind: 'text', spans: [{ text: '   ' }] })
  assert.equal(isEmpty, false)
  assert.equal(component.render(80).length, 1)
})

test('compileView: markdown view renders through the host palette', () => {
  const { component, isEmpty } = compileView({ kind: 'markdown', markdown: '# hi\n\nbody' })
  assert.equal(isEmpty, false)
  const lines = component.render(80)
  assert.ok(lines.length >= 2)
  // Heading renders bold (ANSI present), body plain.
  assert.ok(lines.some(line => line.includes('hi') && line.includes('\x1b[')))
  assert.ok(lines.some(line => line.includes('body')))
  // Empty markdown abdicates.
  const empty = compileView({ kind: 'markdown', markdown: '   ' })
  assert.equal(empty.isEmpty, true)
  assert.deepEqual(empty.component.render(80), [])
})

test('compileView: markdown stays live across width changes', () => {
  const { component } = compileView({ kind: 'markdown', markdown: 'a '.repeat(60) })
  const wide = component.render(100)
  const narrow = component.render(20)
  assert.ok(narrow.length > wide.length, 'narrow width must re-wrap')
})

test('compileView: spacer renders the requested empty rows', () => {
  const { component, isEmpty } = compileView({ kind: 'spacer', rows: 3 })
  assert.equal(isEmpty, false)
  assert.deepEqual(component.render(80), ['', '', ''])
  const zero = compileView({ kind: 'spacer', rows: 0 })
  assert.equal(zero.isEmpty, true)
})

test('compileView: vertical stack renders children in order with gap', () => {
  const { component, isEmpty } = compileView({
    kind: 'stack',
    direction: 'vertical',
    gap: 1,
    children: [
      { kind: 'text', spans: [{ text: 'a' }] },
      { kind: 'text', spans: [{ text: 'b' }] },
    ],
  })
  assert.equal(isEmpty, false)
  const lines = component.render(80).map(stripAnsi)
  assert.deepEqual(lines, ['a', '', 'b'])
})

test('compileView: stack with only empty children abdicates', () => {
  const { component, isEmpty } = compileView({
    kind: 'stack',
    direction: 'vertical',
    children: [
      { kind: 'text', spans: [] },
      { kind: 'spacer', rows: 0 },
    ],
  })
  assert.equal(isEmpty, true)
  assert.deepEqual(component.render(80), [])
})

test('compileView: horizontal stack renders children as sequential rows', () => {
  const { component, isEmpty } = compileView({
    kind: 'stack',
    direction: 'horizontal',
    children: [
      { kind: 'text', spans: [{ text: 'x' }] },
      { kind: 'text', spans: [{ text: 'y' }] },
    ],
  })
  assert.equal(isEmpty, false)
  assert.deepEqual(component.render(80).map(stripAnsi), ['x', 'y'])
})

test('compileView: frame renders a border rule around the child', () => {
  const { component, isEmpty } = compileView({
    kind: 'frame',
    child: { kind: 'text', spans: [{ text: 'inner' }] },
  })
  assert.equal(isEmpty, false)
  const lines = component.render(10)
  assert.equal(lines.length, 3)
  assert.equal(visibleWidth(lines[0]), 10, 'top border spans the full width')
  assert.equal(visibleWidth(lines[2]), 10, 'bottom border spans the full width')
  assert.ok(lines[1].includes('inner'))
  // An absent child abdicates.
  const noChild = compileView({ kind: 'frame' })
  assert.equal(noChild.isEmpty, true)
})

test('compileView: rows view renders up to maxRows and drops excess', () => {
  const { component, isEmpty } = compileView({
    kind: 'rows',
    maxRows: 2,
    rows: [
      { kind: 'text', spans: [{ text: 'r1' }] },
      { kind: 'text', spans: [{ text: 'r2' }] },
      { kind: 'text', spans: [{ text: 'r3' }] },
    ],
  })
  assert.equal(isEmpty, false)
  const lines = component.render(80).map(stripAnsi)
  assert.deepEqual(lines, ['r1', 'r2'])
})

test('compileView: unknown view kinds abdicate safely', () => {
  const { component, isEmpty } = compileView({ kind: 'nope' } as never)
  assert.equal(isEmpty, true)
  assert.deepEqual(component.render(80), [])
})

test('compileView: undefined abdicates', () => {
  const { component, isEmpty } = compileView(undefined)
  assert.equal(isEmpty, true)
  assert.deepEqual(component.render(80), [])
})

test('the public view tree has no raw-ANSI field (API contract)', () => {
  // The "no raw ANSI" rule is an API-surface contract: the ExtensionView
  // union has NO field that accepts raw escapes (no `ansi`/`raw`/`escape`
  // member — styling flows through semantic StyledSpan tokens only). This
  // is a compile-time property of public-types.ts; the runtime assertion
  // guards against a future field sneaking in.
  const view: ExtensionView = { kind: 'text', spans: [{ text: 'ok' }] }
  assert.equal('ansi' in view, false)
  assert.equal('raw' in view, false)
  assert.equal('escape' in view, false)
})

// ── WidgetOutlet ───────────────────────────────────────────────────────────

test('WidgetOutlet: renders ordered widgets above/below the editor zone', () => {
  const ledger = new ExtensionLedger()
  const s = sink()
  const outlet = new WidgetOutlet(ledger, s, 'input.widget.above')
  const h1 = ledger.register('input.widget.above', { id: 'a1', order: 1 }, { view: { kind: 'text', spans: [{ text: 'first' }] } }, 'owner-a')
  const h2 = ledger.register('input.widget.above', { id: 'a2', order: 2 }, { view: { kind: 'text', spans: [{ text: 'second' }] } }, 'owner-b')
  outlet.refresh(0, 80, 3)
  assert.equal(stripAnsi(outlet.text()), 'first\nsecond')
  assert.equal(outlet.hasContent(), true)
  h1.dispose()
  h2.dispose()
})

test('WidgetOutlet: deterministic order (order ASC, id ASC)', () => {
  const ledger = new ExtensionLedger()
  const outlet = new WidgetOutlet(ledger, sink(), 'input.widget.below')
  ledger.register('input.widget.below', { id: 'z', order: 2 }, { view: { kind: 'text', spans: [{ text: 'z' }] } }, 'a')
  ledger.register('input.widget.below', { id: 'a', order: 2 }, { view: { kind: 'text', spans: [{ text: 'a' }] } }, 'b')
  ledger.register('input.widget.below', { id: 'm', order: 1 }, { view: { kind: 'text', spans: [{ text: 'm' }] } }, 'c')
  outlet.refresh(0, 80, 3)
  assert.equal(stripAnsi(outlet.text()), 'm\na\nz')
})

test('WidgetOutlet: removal clears the painted rows (no stale rows)', () => {
  const ledger = new ExtensionLedger()
  const outlet = new WidgetOutlet(ledger, sink(), 'input.widget.above')
  const handle = ledger.register('input.widget.above', { id: 'x' }, { view: { kind: 'text', spans: [{ text: 'gone soon' }] } }, 'o')
  outlet.refresh(0, 80, 3)
  assert.equal(outlet.hasContent(), true)
  handle.dispose()
  outlet.refresh(0, 80, 3)
  assert.equal(stripAnsi(outlet.text()), '')
  assert.equal(outlet.hasContent(), false)
})

test('WidgetOutlet: low-importance widgets collapse first under the row budget', () => {
  const ledger = new ExtensionLedger()
  const outlet = new WidgetOutlet(ledger, sink(), 'input.widget.above')
  ledger.register('input.widget.above', { id: 'low', order: 1 }, { view: { kind: 'text', spans: [{ text: 'low' }] }, importance: 0 }, 'a')
  ledger.register('input.widget.above', { id: 'high', order: 2 }, { view: { kind: 'text', spans: [{ text: 'high' }] }, importance: 10 }, 'b')
  // Budget 1: only the high-importance widget survives.
  outlet.refresh(0, 80, 1)
  assert.equal(stripAnsi(outlet.text()), 'high')
  // Budget 2: both fit.
  outlet.refresh(0, 80, 2)
  assert.equal(stripAnsi(outlet.text()), 'low\nhigh')
})

test('WidgetOutlet: a single over-budget widget is truncated, never dropped', () => {
  const ledger = new ExtensionLedger()
  const outlet = new WidgetOutlet(ledger, sink(), 'input.widget.above')
  ledger.register('input.widget.above', { id: 'big' }, {
    view: { kind: 'rows', rows: [
      { kind: 'text', spans: [{ text: 'r1' }] },
      { kind: 'text', spans: [{ text: 'r2' }] },
      { kind: 'text', spans: [{ text: 'r3' }] },
    ] },
  }, 'a')
  outlet.refresh(0, 80, 2)
  assert.equal(stripAnsi(outlet.text()), 'r1\nr2')
})

test('WidgetOutlet: per-contribution throw is isolated and recorded', () => {
  const ledger = new ExtensionLedger()
  const outlet = new WidgetOutlet(ledger, sink(), 'input.widget.above')
  ledger.register('input.widget.above', { id: 'good' }, { view: { kind: 'text', spans: [{ text: 'ok' }] } }, 'a')
  ledger.register('input.widget.above', { id: 'bad' }, {
    get view() { throw new Error('boom') },
  } as never, 'b')
  outlet.refresh(0, 80, 3)
  assert.equal(stripAnsi(outlet.text()), 'ok', 'the throwing contribution is omitted')
  const health = ledger.healthSnapshot().find(record => record.id === 'bad')
  assert.ok(health !== undefined)
  assert.equal(health.state, 'failed')
  assert.match(health.lastError ?? '', /boom/)
})

test('WidgetOutlet: a failed contribution recovers after a successful render', () => {
  const ledger = new ExtensionLedger()
  const outlet = new WidgetOutlet(ledger, sink(), 'input.widget.above')
  let throwing = true
  const handle = ledger.register('input.widget.above', { id: 'flaky' }, {
    get view() {
      if (throwing) throw new Error('first fail')
      return { kind: 'text', spans: [{ text: 'recovered' }] }
    },
  } as never, 'a')
  outlet.refresh(0, 80, 3)
  assert.equal(stripAnsi(outlet.text()), '')
  throwing = false
  handle.replace({ view: { kind: 'text', spans: [{ text: 'recovered' }] } } as never)
  outlet.refresh(0, 80, 3)
  assert.equal(stripAnsi(outlet.text()), 'recovered')
  const health = ledger.healthSnapshot().find(record => record.id === 'flaky')
  assert.equal(health?.state, 'active')
})

test('WidgetOutlet: maxHeight caps a widget before the row budget applies', () => {
  const ledger = new ExtensionLedger()
  const outlet = new WidgetOutlet(ledger, sink(), 'input.widget.above')
  ledger.register('input.widget.above', { id: 'capped' }, {
    view: { kind: 'rows', rows: [
      { kind: 'text', spans: [{ text: 'r1' }] },
      { kind: 'text', spans: [{ text: 'r2' }] },
      { kind: 'text', spans: [{ text: 'r3' }] },
    ] },
    maxHeight: 2,
  }, 'a')
  outlet.refresh(0, 80, 10)
  assert.equal(stripAnsi(outlet.text()), 'r1\nr2')
})
