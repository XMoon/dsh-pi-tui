/**
 * M4 surface-level tests: the widget slots flow end to end — a plugin
 * registers an `input.widget.above` / `input.widget.below` contribution
 * through the SERVICE, the SurfaceHost's widget outlets render it, the
 * host's editor zone picks it up, and unload clears it (the M4 contracts:
 * plan §9 bounded widgets, §19 host-owned budgets, §18 error isolation).
 * @module @xmoon76/dsh-pi-tui/extension-widget-surface.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { ExtensionLedger } from '../src/extension/internal/ledger.ts'
import { SurfaceHost } from '../src/extension/internal/surface-host.ts'
import { SurfaceStateStore } from '../src/extension/internal/surface-state.ts'

/** A fake TuiApp chrome: header/dock/footer/widgets Texts that record the
 * merged text. The widget zones are host-owned Text components. */
function chrome() {
  const texts = { header: '', dock: '', footer: '', above: '', below: '' }
  return {
    texts,
    setAbove(text: string) { texts.above = text },
    setBelow(text: string) { texts.below = text },
  }
}

function surfaceSnapshot(overrides: Partial<import('../src/extension/public-types.ts').SurfaceSnapshot> = {}) {
  return {
    surfaceId: 'tui-test',
    generation: 1,
    width: 80,
    height: 24,
    fullscreen: false,
    focusedSeat: 'editor' as const,
    themeId: 'dark',
    themeRevision: 0,
    ...overrides,
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

test('SurfaceHost: a widget registered through the ledger renders in the above zone', () => {
  const ledger = new ExtensionLedger()
  let renders = 0
  const host = new SurfaceHost(ledger, () => { renders += 1 })
  host.attach({ header: {} as never, dock: {} as never, footer: {} as never }, surfaceSnapshot())
  const handle = ledger.register('input.widget.above', { id: 'w1', order: 1 }, {
    view: { kind: 'text', spans: [{ text: 'widget one' }] },
  }, 'owner-a')
  host.refreshOutlets()
  assert.equal(stripAnsi(host.widgetsAboveText()), 'widget one')
  assert.equal(host.hasWidgetsAbove(), true)
  assert.equal(host.hasWidgetsBelow(), false)
  // Removal clears the zone.
  handle.dispose()
  host.refreshOutlets()
  assert.equal(host.widgetsAboveText(), '')
  assert.equal(host.hasWidgetsAbove(), false)
  host.dispose()
})

test('SurfaceHost: below widgets render and respect the row budget', () => {
  const ledger = new ExtensionLedger()
  let renders = 0
  const host = new SurfaceHost(ledger, () => { renders += 1 })
  host.attach({ header: {} as never, dock: {} as never, footer: {} as never }, surfaceSnapshot())
  ledger.register('input.widget.below', { id: 'b1', order: 1 }, {
    view: { kind: 'rows', rows: [
      { kind: 'text', spans: [{ text: 'r1' }] },
      { kind: 'text', spans: [{ text: 'r2' }] },
      { kind: 'text', spans: [{ text: 'r3' }] },
    ] },
    importance: 0,
  }, 'owner-a')
  host.setWidgetRowsBelow(2)
  host.refreshOutlets()
  assert.equal(stripAnsi(host.widgetsBelowText()), 'r1\nr2')
  assert.equal(host.hasWidgetsBelow(), true)
  host.dispose()
})

test('SurfaceHost: a resize re-bakes widget rows at the new width', () => {
  const ledger = new ExtensionLedger()
  let renders = 0
  const host = new SurfaceHost(ledger, () => { renders += 1 })
  host.attach({ header: {} as never, dock: {} as never, footer: {} as never }, surfaceSnapshot())
  ledger.register('input.widget.above', { id: 'wrap' }, {
    view: { kind: 'text', spans: [{ text: 'a '.repeat(40) }] },
  }, 'owner-a')
  host.refreshOutlets()
  const at80 = host.widgetsAboveText().split('\n').length
  host.updateSurface({ width: 10 })
  host.refreshOutlets()
  const at10 = host.widgetsAboveText().split('\n').length
  assert.ok(at10 > at80, 'narrow width must re-wrap the widget rows')
  host.dispose()
})

test('SurfaceHost: widget capabilities are advertised on attach', () => {
  const ledger = new ExtensionLedger()
  const host = new SurfaceHost(ledger, () => {})
  host.attach({ header: {} as never, dock: {} as never, footer: {} as never }, surfaceSnapshot())
  const capabilities = host.capabilitiesOf()
  assert.ok(capabilities.has('slot.input.widget'))
  host.dispose()
})

test('SurfaceHost: a throwing widget contribution is isolated and the zone stays healthy', () => {
  const ledger = new ExtensionLedger()
  let renders = 0
  const host = new SurfaceHost(ledger, () => { renders += 1 })
  host.attach({ header: {} as never, dock: {} as never, footer: {} as never }, surfaceSnapshot())
  ledger.register('input.widget.above', { id: 'good' }, {
    view: { kind: 'text', spans: [{ text: 'ok' }] },
  }, 'a')
  ledger.register('input.widget.above', { id: 'bad' }, {
    get view() { throw new Error('widget boom') },
  } as never, 'b')
  host.refreshOutlets()
  assert.equal(stripAnsi(host.widgetsAboveText()), 'ok')
  const health = ledger.healthSnapshot().find(record => record.id === 'bad')
  assert.equal(health?.state, 'failed')
  assert.match(health?.lastError ?? '', /widget boom/)
  host.dispose()
})

test('SurfaceHost: dispose clears the widget zones (no stale rows after teardown)', () => {
  const ledger = new ExtensionLedger()
  let renders = 0
  const host = new SurfaceHost(ledger, () => { renders += 1 })
  host.attach({ header: {} as never, dock: {} as never, footer: {} as never }, surfaceSnapshot())
  ledger.register('input.widget.below', { id: 'gone' }, {
    view: { kind: 'text', spans: [{ text: 'bye' }] },
  }, 'a')
  host.refreshOutlets()
  assert.equal(host.hasWidgetsBelow(), true)
  host.dispose()
  assert.equal(host.widgetsBelowText(), '')
  assert.equal(host.hasWidgetsBelow(), false)
})

test('SurfaceStateStore: widget state flows to the store slices', () => {
  const store = new SurfaceStateStore({ requestRender: () => {} })
  const state = store.get()
  assert.equal(state.surface.width, 0)
  store.set({ surface: surfaceSnapshot() })
  assert.equal(store.get().surface.width, 80)
})
