/**
 * M2 contract gate: the surface state store and the first chrome outlets.
 * Immutable snapshots, selector-aware batched subscriptions, deterministic
 * outlet rendering from ledger contributions, and the host/chrome boundary
 * (plugins never touch components or the root layout).
 * @module @xmoon76/dsh-pi-tui/surface-state.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Text } from '@xmoon76/pi-tui'
import { ExtensionLedger } from '../src/extension/internal/ledger.ts'
import { SurfaceStateStore } from '../src/extension/internal/surface-state.ts'
import { SurfaceHost } from '../src/extension/internal/surface-host.ts'
import type { HeaderBadge, StyledSpan } from '../src/extension/public-types.ts'

/** A store whose render sink records calls. */
function makeStore(): { store: SurfaceStateStore; renders: number[] } {
  const renders: number[] = []
  const store = new SurfaceStateStore({ requestRender: () => { renders.push(1) } })
  return { store, renders }
}

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

test('snapshots are immutable and deep-frozen', () => {
  const { store } = makeStore()
  store.set({ activity: { working: true, queuedCount: 2, taskCount: 0, childAgentCount: 0, todoCount: 0 } })
  const state = store.get()
  const activity = state.activity
  assert.equal(activity.working, true)
  assert.throws(() => { (activity as { working: boolean }).working = false }, TypeError)
  assert.ok(Object.isFrozen(activity))
  // P2-1: the OUTER state object is frozen too, not just its slices — the
  // public contract is "deeply frozen snapshots".
  assert.ok(Object.isFrozen(state), 'the outer SurfaceStateValues must be frozen (P2-1)')
  assert.throws(() => { (state as { surface: unknown }).surface = {} }, TypeError)
})

test('selectors fire only on slice CHANGE and delivery is batched', async () => {
  const { store, renders } = makeStore()
  const seen: Array<{ working: boolean; queuedCount: number }> = []
  let count = 0
  const disposer = store.subscribe({
    select: state => state.activity,
    notify: (value) => { seen.push({ working: value.working, queuedCount: value.queuedCount }); count += 1 },
  })
  // First delivery is synchronous with the initial snapshot.
  assert.equal(count, 1)
  assert.equal(seen[0]?.working, false)
  // Two writes in one tick → ONE batched notification with the final state.
  store.set({ activity: { working: true, queuedCount: 0, taskCount: 0, childAgentCount: 0, todoCount: 0 } })
  store.set({ activity: { working: true, queuedCount: 3, taskCount: 0, childAgentCount: 0, todoCount: 0 } })
  assert.equal(count, 1, 'no notification before the microtask')
  await settle()
  assert.equal(count, 2, 'exactly one batched notification')
  assert.deepEqual(seen[1], { working: true, queuedCount: 3 })
  assert.ok(renders.length >= 1, 'a state change requests a render')
  disposer()
  // After dispose: no more notifications.
  store.set({ activity: { working: false, queuedCount: 0, taskCount: 0, childAgentCount: 0, todoCount: 0 } })
  await settle()
  assert.equal(count, 2)
})

test('an identical slice write is a no-op (no notification)', async () => {
  const { store } = makeStore()
  let count = 0
  store.subscribe({
    select: state => state.activity,
    notify: () => { count += 1 },
  })
  assert.equal(count, 1)
  store.set({ activity: { working: false, queuedCount: 0, taskCount: 0, childAgentCount: 0, todoCount: 0 } })
  await settle()
  assert.equal(count, 1, 'identical slice must not notify')
})

test('header badge outlet renders ordered badges with tones', () => {
  const ledger = new ExtensionLedger(() => {})
  const surface = new SurfaceHost(ledger, () => {})
  ledger.register('chrome.header.badge', { id: 'a', order: 0 }, { text: 'beta' } satisfies HeaderBadge, 'p1')
  ledger.register('chrome.header.badge', { id: 'b', order: 1 }, { text: 'plan', tone: 'warning' } satisfies HeaderBadge, 'p2')
  surface.refreshOutlets()
  const text = surface.headerBadgeText()
  assert.ok(text.includes('beta'), `badge a missing: ${text}`)
  assert.ok(text.includes('plan'), `badge b missing: ${text}`)
  // Ordered: a before b.
  assert.ok(text.indexOf('beta') < text.indexOf('plan'), 'order ASC must hold')
})

test('dock outlet renders labels and details; empty contributions render nothing', () => {
  const ledger = new ExtensionLedger(() => {})
  const surface = new SurfaceHost(ledger, () => {})
  assert.equal(surface.dockText(), '', 'empty dock renders nothing')
  ledger.register('input.dock.item', { id: 't' }, {
    label: [{ text: '☑  ', tone: 'textDim' }, { text: '2 active' }] satisfies StyledSpan[],
  }, 'p1')
  surface.refreshOutlets()
  const text = surface.dockText()
  assert.ok(text.includes('2 active'), `dock label missing: ${text}`)
})

test('footer outlet renders ordered segments; low-importance segments drop in compact mode', () => {
  const ledger = new ExtensionLedger(() => {})
  const surface = new SurfaceHost(ledger, () => {})
  ledger.register('chrome.footer.status', { id: 'model', order: 0 }, {
    spans: [{ text: '[model-x]' }] satisfies StyledSpan[],
  }, 'p1')
  ledger.register('chrome.footer.status', { id: 'hint', order: 1, priority: 0 }, {
    spans: [{ text: 'press ? for help' }] satisfies StyledSpan[],
    importance: -1,
  }, 'p2')
  surface.refreshOutlets()
  const full = surface.footerText()
  assert.ok(full.includes('[model-x]'), `model segment missing: ${full}`)
  assert.ok(full.includes('press ? for help'), `hint segment missing: ${full}`)
  // The host asks for compact: low-importance (-1) segments drop.
  // (Compact handling lands with the host merge in Commit D; the outlet
  // exposes refresh(compact) for it.)
  const compactSurface = new SurfaceHost(ledger, () => {})
  compactSurface.refreshOutlets()
  assert.ok(compactSurface.footerText().includes('[model-x]'))
})

test('SurfaceHost attach publishes the surface snapshot and capabilities', () => {
  const ledger = new ExtensionLedger(() => {})
  const surface = new SurfaceHost(ledger, () => {})
  const header = new Text('', 0, 0)
  const dock = new Text('', 0, 0)
  const footer = new Text('', 0, 0)
  surface.attach({ header, dock, footer }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  assert.equal(surface.state().surface.surfaceId, 's1')
  assert.ok(surface.capabilitiesOf().has('slot.chrome.header.badge'))
  assert.ok(surface.capabilitiesOf().has('surface.snapshot'))
  surface.dispose()
  assert.equal(surface.isDisposed(), true)
  assert.equal(surface.capabilitiesOf().size, 0)
})

test('SurfaceHost updates slices through immutable snapshots', async () => {
  const ledger = new ExtensionLedger(() => {})
  const surface = new SurfaceHost(ledger, () => {})
  surface.updateSurface({ width: 100 })
  surface.updateSession({ cwd: '/ws', model: 'm' })
  surface.updateActivity({ working: true, queuedCount: 1, taskCount: 0, childAgentCount: 0, todoCount: 0 })
  await settle()
  assert.equal(surface.state().surface.width, 100)
  assert.equal(surface.state().session.cwd, '/ws')
  assert.equal(surface.state().activity.working, true)
})
