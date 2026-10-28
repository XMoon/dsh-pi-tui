/**
 * M1 contract gate: the Cordis owner lifecycle of extension registrations.
 * The acceptance flow from the plan (proven against the REAL cordis 4.0.1
 * behavior — the ABI is written from this test, not from assumptions):
 *
 *   provider A mount → plugin B register → plugin C register
 *     → unload B  → only B contribution disappears
 *     → reload B  → contribution returns
 *     → unload A  → dependents collapse/inert
 *     → remount A → dependents remount cleanly
 *
 * Also verified: the service is usable BEFORE any surface exists (M1), load
 * timing never decides ordering (ledger rules do), and an explicit
 * dispose() detaches the fiber disposer cleanly.
 * @module @xmoon76/dsh-pi-tui/extension-cordis-lifecycle.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { PI_TUI_EXTENSIONS_SERVICE } from '../../src/extensions.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'
import type {
  AutocompleteProviderContribution,
  ContributionHealth,
  EditorContribution,
  ExtensionView,
  MessagePresentationSnapshot,
  NormalizedKey,
  ToolPresentationSnapshot,
  TuiAutocompleteQuery,
  TuiColorPalette,
  TuiKeybindingContribution,
  TuiMessageRendererContribution,
  TuiThemeContribution,
  TuiToolRendererContribution,
} from '../../src/extension/public-types.ts'

/** The extension-host provider under test (real entry, real apply). */
import { apply as applyExtensionHost } from '../../src/extensions.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/tui/process-slot.ts). */
interface DisposableApp { isDisposed(): boolean; dispose(): void }
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<DisposableApp>()
afterEach(() => {
  disposeStartedApps()
})

/** A minimal provider fiber that provides tuiStartup (the host's gate). */
function startupPlugin(ctx: Context): void {
  ctx.provide(TUI_STARTUP_SERVICE, {})
}

/** One registered contribution (typed per slot contract shape). */
interface BadgeContribution {
  text: string
}

/** Register one badge through the service; returns the handle. */
function registerBadge(ctx: Context, id: string, text: string, order?: number) {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
    register(slot: string, spec: { id: string; order?: number }, value: BadgeContribution): {
      id: string
      invalidate(): void
      replace(next: BadgeContribution): void
      dispose(): void
    }
  }
  return service.register('chrome.header.badge', { id, ...(order === undefined ? {} : { order }) }, { text })
}

/** Mount one plugin fiber (awaited to ACTIVE) and return its disposer. */
async function mount(ctx: Context, plugin: (ctx: Context) => void): Promise<() => Promise<void>> {
  const fiber = ctx.plugin(plugin)
  await fiber
  return () => fiber.dispose()
}

/** The current header-badge contributions (id → text), or null when the
 * service is unavailable. */
function badges(ctx: Context): Record<string, string> | null {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as
    | { _ledger(): { snapshot(slot: string): { records: Array<{ id: string; value: BadgeContribution }> } } }
    | undefined
  if (service === undefined) return null
  const snapshot = service._ledger().snapshot('chrome.header.badge')
  const out: Record<string, string> = {}
  for (const record of snapshot.records) out[record.id] = record.value.text
  return out
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

test('owner unload removes exactly the owner’s contributions; reload restores them', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)

    // Plugin B and C both register (mount order is load order — the ledger
    // must NOT let it decide anything).
    const pluginB = await mount(ctx, (ctx) => {
      registerBadge(ctx, 'b1', 'B first')
      registerBadge(ctx, 'b2', 'B second')
    })
    const pluginC = await mount(ctx, (ctx) => {
      registerBadge(ctx, 'c1', 'C only')
    })
    await pluginB; await pluginC
    await settle()
    assert.deepEqual(badges(ctx), { b1: 'B first', b2: 'B second', c1: 'C only' })

    // Unload B: ONLY B's contributions disappear.
    await pluginB()
    await settle()
    assert.deepEqual(badges(ctx), { c1: 'C only' }, 'unload B must remove exactly B')

    // Reload B: its contributions return (mount() returns a DISPOSER; the
    // reloaded plugin stays mounted until the disposer is invoked).
    const pluginB2 = await mount(ctx, (ctx) => {
      registerBadge(ctx, 'b1', 'B first again')
    })
    await settle()
    assert.deepEqual(badges(ctx), { b1: 'B first again', c1: 'C only' })
    await pluginB2()
    await settle()
    assert.deepEqual(badges(ctx), { c1: 'C only' })
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('provider unload makes every dependent registration collapse; remount restores them', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)

    const pluginB = await mount(ctx, (ctx) => {
      registerBadge(ctx, 'b1', 'B')
    })
    await settle()
    assert.deepEqual(badges(ctx), { b1: 'B' })

    // Unload the PROVIDER: the service disappears, so every dependent
    // registration collapses with it (nothing may crash or linger).
    await host()
    await settle()
    assert.equal(ctx.get(PI_TUI_EXTENSIONS_SERVICE), undefined, 'service gone after provider unload')

    // Remount the provider: a NEW service instance; the plugin's handle
    // from the old instance is inert, and re-registration works cleanly.
    const host2 = await mount(ctx, applyExtensionHost)
    await settle()
    const pluginB2 = await mount(ctx, (ctx) => {
      registerBadge(ctx, 'b1', 'B remounted')
    })
    await settle()
    assert.deepEqual(badges(ctx), { b1: 'B remounted' })
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('registration works before any surface exists; invalidate/replace are safe no-ops without a sink', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)

    const handle = registerBadge(ctx, 'pre', 'before surface')
    // No surface host is attached (M1): invalidate/replace must not throw
    // and must not touch any terminal.
    handle.invalidate()
    handle.replace({ text: 'updated' })
    assert.equal(badges(ctx)?.['pre'], 'updated')
    handle.dispose()
    assert.deepEqual(badges(ctx), {})
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('an explicit dispose() detaches the fiber-bound disposer (no double cleanup)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)

    const handle = registerBadge(ctx, 'x', 'X')
    handle.dispose()
    assert.deepEqual(badges(ctx), {})
    // Fiber unload afterwards must not double-dispose or throw.
    const plugin = await mount(ctx, (ctx) => {
      registerBadge(ctx, 'y', 'Y')
    })
    await settle()
    assert.deepEqual(badges(ctx), { y: 'Y' })
    await plugin()
    await settle()
    assert.deepEqual(badges(ctx), {})
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('slotSemantics answers known slots and rejects unknown ones', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as { slotSemantics(slot: string): string | undefined }
    assert.equal(service.slotSemantics('chrome.header.badge'), 'list')
    assert.equal(service.slotSemantics('input.dock.item'), 'list')
    assert.equal(service.slotSemantics('chrome.footer.status'), 'list')
    assert.equal(service.slotSemantics('nope'), undefined)
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('the (slot, id) pair is free again after its owner fiber unloads', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)

    const plugin = await mount(ctx, (c) => {
      ;(c.get(PI_TUI_EXTENSIONS_SERVICE) as any).register('chrome.header.badge', { id: 'ghost' }, { text: 'G' })
    })
    await settle()
    assert.equal(badges(ctx)?.['ghost'], 'G')
    await plugin()
    await settle()
    assert.equal(badges(ctx)?.['ghost'], undefined, 'owner unload must remove the registration')

    // Re-register the same id: must succeed (the disposed registration does
    // not block the pair — the round-2 review regression).
    const plugin2 = await mount(ctx, (c) => {
      ;(c.get(PI_TUI_EXTENSIONS_SERVICE) as any).register('chrome.header.badge', { id: 'ghost' }, { text: 'G2' })
    })
    await settle()
    assert.equal(badges(ctx)?.['ghost'], 'G2', 'the (slot, id) pair must be free after owner disposal')
    await plugin2()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('two anonymous sibling fibers are DISTINCT owners: the same (slot, id) from both must not conflict (review P1)', async () => {
  // Regression for the review's P1: the generic register() briefly used the
  // BARE fiber name as the owner, so two anonymous sibling plugins both
  // owned by 'root' — a second live plugin registering the same id in the
  // same slot was (wrongly) rejected as a duplicate, and owner-scoped
  // disposal/health conflated the two. The owner is UID-QUALIFIED; the
  // HMR-stable identity lives in a SEPARATE stableOwner field (only the
  // chrome.footer.item canonical key uses it).
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)

    // Two ANONYMOUS plugin fibers (no name) registering the SAME id.
    const pluginA = await mount(ctx, (c) => {
      ;(c.get(PI_TUI_EXTENSIONS_SERVICE) as any).register('chrome.header.badge', { id: 'sibling' }, { text: 'A' })
    })
    const pluginB = await mount(ctx, (c) => {
      ;(c.get(PI_TUI_EXTENSIONS_SERVICE) as any).register('chrome.header.badge', { id: 'sibling' }, { text: 'B' })
    })
    await settle()
    const view = badges(ctx)
    assert.ok(view !== null && view !== undefined && view['sibling'] !== undefined,
      'both anonymous siblings must register the same id without a duplicate-owner conflict')
    // Unload one: the OTHER sibling's registration survives (owner-scoped
    // disposal is exact — 'root' can never sweep a live neighbor).
    await pluginA()
    await settle()
    assert.ok(badges(ctx)?.['sibling'] !== undefined,
      'unloading one anonymous sibling must not remove the other\u2019s registration')
    await pluginB()

    // The chrome.footer.item PERSISTED key (`ext:<stableOwner>/<id>`) must
    // stay injective among LIVE registrations: two plugins sharing a stable
    // owner (two anonymous fibers both resolve to 'root') with the same id
    // would produce the SAME canonical key — the second registration is an
    // explicit error (the theme registry's duplicate-name precedent), and
    // the key is free again once the holder unloads (an HMR reload disposes
    // first). The rejection is asserted at the top level (a register throw
    // inside a plugin fiber is reported through the fiber's error channel).
    const serviceOf = (c: Context) => c.get(PI_TUI_EXTENSIONS_SERVICE) as unknown as {
      register(slot: string, spec: { id: string }, value: unknown): unknown
    }
    // C registers from its OWN fiber (the caller's context owns the
    // registration — a mount that reads the service through the outer ctx
    // would bind the effect to the root fiber and never unload).
    const pluginC = await mount(ctx, (c) => {
      serviceOf(c).register('chrome.footer.item', { id: 'foot' }, { label: 'C', segment: { spans: [{ text: 'C' }] } })
    })
    await settle()
    assert.throws(
      () => serviceOf(ctx).register('chrome.footer.item', { id: 'foot' }, { label: 'D', segment: { spans: [{ text: 'D' }] } }),
      /duplicate chrome\.footer\.item canonical key/,
      'the second same-key footer registration must be rejected while the holder is live',
    )
    // After the holder unloads, the (stable owner, id) key is free again.
    await pluginC()
    await settle()
    serviceOf(ctx).register('chrome.footer.item', { id: 'foot' }, { label: 'E', segment: { spans: [{ text: 'E' }] } })
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('a stale service detachSurface does not tear down a newer generation bridge (P1)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
      attachSurface(bridge: { subscribe(listener: (state: unknown) => void): () => void }, capabilities: ReadonlySet<string>, surfaceId: string): void
      detachSurface(surfaceId?: string): void
      subscribeState(listener: (state: unknown) => void): () => void
      _listenerUnsubscribersSize(): number
    }

    // Generation 1 attaches; a listener goes live on its bridge.
    let bridge1Subscribed = 0
    service.attachSurface({ subscribe: () => { bridge1Subscribed += 1; return () => { bridge1Subscribed -= 1 } } }, new Set(), 'gen-a')
    assert.equal(bridge1Subscribed, 0, 'no listeners yet — the attach itself subscribes nothing')
    const listener = (): void => {}
    service.subscribeState(listener)
    assert.equal(bridge1Subscribed, 1, 'the listener must subscribe to the LIVE bridge')

    // Generation 2 attaches to a NEW bridge; the old detach arrives late.
    let bridge2Subscribed = 0
    service.attachSurface({ subscribe: () => { bridge2Subscribed += 1; return () => { bridge2Subscribed -= 1 } } }, new Set(), 'gen-b')
    // A stale detachSurface from generation 1 must be a NO-OP: generation 2
    // keeps its bridge and its live listener (the review's "dispose A after
    // attach B" repro through the service bridge).
    service.detachSurface('gen-a')
    assert.equal(bridge2Subscribed, 1, 'the newer generation must keep its bridge after a stale detach (P1)')

    // The REAL current detach tears down the newer generation's BRIDGE
    // BINDING — the subscription RECORD stays pending (P1-3: caller-owned
    // records survive surface recreation; a later attach re-binds).
    service.detachSurface('gen-b')
    assert.equal(bridge2Subscribed, 0, 'the current detach must release the live bridge binding (P1)')
    assert.equal(service._listenerUnsubscribersSize(), 1, 'the subscription RECORD survives the detach (P1-3)')

    // A NEW generation attaches: the record re-binds automatically.
    let bridge3Subscribed = 0
    service.attachSurface({ subscribe: () => { bridge3Subscribed += 1; return () => { bridge3Subscribed -= 1 } } }, new Set(), 'gen-c')
    assert.equal(bridge3Subscribed, 1, 'the pending record must re-bind to the new bridge (P1-3)')

    // The OWNER FIBER unload removes the record (the fiber-bound disposer).
    // The listener was subscribed by THIS test's fiber (the service's
    // caller is the plugin fiber created by mount() below), so mount a
    // plugin that subscribes and unload it.
    let pluginDisposer: (() => Promise<void>) | undefined
    pluginDisposer = await mount(ctx, (c) => {
      const svc = c.get(PI_TUI_EXTENSIONS_SERVICE) as { subscribeState(listener: (state: unknown) => void): () => void }
      svc.subscribeState(() => {})
    })
    await settle()
    assert.equal(service._listenerUnsubscribersSize(), 2, 'the plugin subscription record exists')
    await pluginDisposer()
    await settle()
    assert.equal(service._listenerUnsubscribersSize(), 1, 'owner unload removes exactly the owner record (F1)')
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('registering through a stale service handle after its owner fiber died throws and leaves NO ghost', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)

    // A plugin captures its service handle; the plugin then unloads. The
    // handle's this.ctx still points at the dead fiber, so a later
    // register() through it must throw INACTIVE_EFFECT — and the ledger
    // must roll the registration back (no ghost blocking the (slot, id)).
    let stale: { register(slot: string, spec: unknown, value: unknown): unknown } | undefined
    const plugin = await mount(ctx, (c) => {
      stale = c.get(PI_TUI_EXTENSIONS_SERVICE) as typeof stale
    })
    await settle()
    await plugin()
    await settle()

    assert.throws(
      () => stale?.register('chrome.header.badge', { id: 'stale' }, { text: 'S' }),
      /inactive context|INACTIVE_EFFECT|already disposed/i,
      'a stale service handle must fail loudly',
    )
    // No ghost: the pair is re-registrable from a live fiber.
    const plugin2 = await mount(ctx, (c) => {
      ;(c.get(PI_TUI_EXTENSIONS_SERVICE) as any).register('chrome.header.badge', { id: 'stale' }, { text: 'S2' })
    })
    await settle()
    assert.equal(badges(ctx)?.['stale'], 'S2', 'the failed stale registration must not block the pair')
    await plugin2()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('a stale subscribeState throws and leaves NO live listener (rollback, follow-up P1)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)

    // A plugin captures the service handle and subscribes WHILE ALIVE, then
    // unloads. The bridge is live (attached below), so the subscription is
    // a real bridge subscription.
    let stale: { subscribeState(listener: (state: unknown) => void): () => void; _listenerUnsubscribersSize(): number } | undefined
    const plugin = await mount(ctx, (c) => {
      stale = c.get(PI_TUI_EXTENSIONS_SERVICE) as typeof stale
    })
    // Attach a fake bridge: the subscription goes live.
    let bridgeSubscribed = 0
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
      attachSurface(bridge: { subscribe(listener: (state: unknown) => void): () => void }, capabilities: ReadonlySet<string>, surfaceId: string): void
      _listenerUnsubscribersSize(): number
    }
    service.attachSurface({ subscribe: () => { bridgeSubscribed += 1; return () => { bridgeSubscribed -= 1 } } }, new Set(), 'gen-1')
    await settle()
    assert.equal(service._listenerUnsubscribersSize(), 0, 'no listeners yet')

    // The plugin subscribes through its own (live) handle.
    let subscribed = false
    const plugin2 = await mount(ctx, (c) => {
      const svc = c.get(PI_TUI_EXTENSIONS_SERVICE) as NonNullable<typeof stale>
      svc.subscribeState(() => { subscribed = true })
    })
    await settle()
    assert.equal(service._listenerUnsubscribersSize(), 1, 'the live subscription exists')
    assert.equal(bridgeSubscribed, 1, 'the listener must subscribe to the bridge')

    // The plugin unloads: its fiber disposer releases the subscription.
    await plugin2()
    await settle()
    assert.equal(service._listenerUnsubscribersSize(), 0, 'unload must release the live subscription (F1)')
    assert.equal(bridgeSubscribed, 0, 'the bridge subscription must be gone')

    // The STALE handle's subscribeState must throw AND roll back: the
    // bridge subscription is installed first, then the fiber effect fails —
    // the subscription must be released again, leaving NO live listener.
    await plugin() // unload the stale handle's owner
    await settle()
    assert.throws(
      () => stale?.subscribeState(() => {}),
      /inactive context|INACTIVE_EFFECT|already disposed/i,
      'a stale subscribeState must fail loudly',
    )
    assert.equal(service._listenerUnsubscribersSize(), 0, 'a failed stale subscribeState must leave NO listener (rollback)')
    assert.equal(bridgeSubscribed, 0, 'a failed stale subscribeState must leave NO bridge subscription (rollback)')

    // Idempotence: an EXPLICIT unsubscribe after the fiber already unloaded
    // (the disposer ran) must not re-subscribe or re-invoke the listener.
    // With a LIVE bridge the initial delivery is synchronous: exactly one
    // invocation, and double release must not re-subscribe/re-invoke.
    let bridge2Subscribed = 0
    service.attachSurface({
      subscribe: (listener) => {
        bridge2Subscribed += 1
        listener({ surface: { surfaceId: 's', generation: 1, width: 80, height: 24, fullscreen: false, focusedSeat: 'editor', themeId: 'dark', themeRevision: 0 }, session: {}, activity: {} } as never)
        return () => { bridge2Subscribed -= 1 }
      },
    }, new Set(), 'gen-2')
    let invoked = 0
    const plugin3 = await mount(ctx, (c) => {
      const svc = c.get(PI_TUI_EXTENSIONS_SERVICE) as NonNullable<typeof stale>
      const release = svc.subscribeState(() => { invoked += 1 })
      // The fiber's disposer AND the explicit release share one teardown.
      release()
      release()
    })
    await settle()
    assert.equal(invoked, 1, 'the initial synchronous delivery fires once; double release must not re-invoke')
    assert.equal(service._listenerUnsubscribersSize(), 0, 'double release must not leave a listener')
    await plugin3()
    await settle()
    assert.equal(service._listenerUnsubscribersSize(), 0)
    assert.equal(bridge2Subscribed, 0, 'the explicit release must unsubscribe from the bridge')

    // The reverse order (review finding 9): UNLOAD the fiber first (the
    // fiber disposer runs the shared teardown), THEN call the returned
    // public disposer — it must be a no-op: no re-subscribe, no re-invoke,
    // no map entry.
    let releaseAfterUnload: (() => void) | undefined
    let invokedAfterUnload = 0
    const plugin4 = await mount(ctx, (c) => {
      const svc = c.get(PI_TUI_EXTENSIONS_SERVICE) as NonNullable<typeof stale>
      releaseAfterUnload = svc.subscribeState(() => { invokedAfterUnload += 1 })
    })
    await settle()
    assert.equal(invokedAfterUnload, 1, 'the initial synchronous delivery fires once')
    await plugin4() // unload: the fiber disposer releases the subscription
    await settle()
    assert.equal(service._listenerUnsubscribersSize(), 0, 'unload must release the subscription')
    assert.equal(bridge2Subscribed, 0, 'unload must unsubscribe from the bridge')
    releaseAfterUnload?.() // the public disposer after unload: must be a no-op
    releaseAfterUnload?.()
    await settle()
    assert.equal(invokedAfterUnload, 1, 'a post-unload public release must not re-invoke')
    assert.equal(service._listenerUnsubscribersSize(), 0, 'a post-unload public release must not leave/re-create a listener')
    assert.equal(bridge2Subscribed, 0, 'a post-unload public release must not re-subscribe')
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('a throwing bridge unsubscribe during migration/detach does not leak or abort (round-3 finding 1)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
      attachSurface(bridge: { subscribe(listener: (state: unknown) => void): () => void }, capabilities: ReadonlySet<string>, surfaceId: string): void
      detachSurface(surfaceId?: string): void
      subscribeState(listener: (state: unknown) => void): () => void
      _listenerUnsubscribersSize(): number
    }

    // Two listeners on bridge 1; bridge 1's unsubscribe THROWS.
    let bridge1Subscribed = 0
    service.attachSurface({
      subscribe: () => { bridge1Subscribed += 1; return () => { bridge1Subscribed -= 1; throw new Error('bridge1 unsubscribe boom') } },
    }, new Set(), 'gen-1')
    const l1 = (): void => {}
    const l2 = (): void => {}
    service.subscribeState(l1)
    service.subscribeState(l2)
    assert.equal(service._listenerUnsubscribersSize(), 2)

    // Migration to bridge 2: the throwing old unsubscribe must not abort —
    // both listeners land on bridge 2 and can be released.
    let bridge2Subscribed = 0
    service.attachSurface({
      subscribe: () => { bridge2Subscribed += 1; return () => { bridge2Subscribed -= 1 } },
    }, new Set(), 'gen-2')
    assert.equal(bridge2Subscribed, 2, 'both listeners must migrate to the new bridge despite the throwing old unsubscribe')
    assert.equal(service._listenerUnsubscribersSize(), 2, 'both listeners stay tracked on the new bridge')

    // Detach: the bridge-2 binding releases; the RECORDS stay pending
    // (P1-3). A throwing teardown must not abort the loop and must not
    // leave a live binding on the dead bridge.
    service.detachSurface('gen-2')
    assert.equal(service._listenerUnsubscribersSize(), 2, 'detach keeps the records pending (P1-3)')
    assert.equal(bridge2Subscribed, 0)

    // A detach where the teardown itself throws must still unbind the
    // records (no live binding on the dead bridge).
    service.attachSurface({
      subscribe: () => { return () => { throw new Error('detach boom') } },
    }, new Set(), 'gen-3')
    const l3 = (): void => {}
    service.subscribeState(l3)
    assert.equal(service._listenerUnsubscribersSize(), 3)
    service.detachSurface('gen-3')
    assert.equal(service._listenerUnsubscribersSize(), 3, 'a throwing teardown must not leak or abort; records stay pending (P1-3)')

    // A NEW attach re-binds every pending record.
    let bridge4Subscribed = 0
    service.attachSurface({
      subscribe: () => { bridge4Subscribed += 1; return () => { bridge4Subscribed -= 1 } },
    }, new Set(), 'gen-4')
    assert.equal(bridge4Subscribed, 3, 'every pending record re-binds on the new attach (P1-3)')
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('a duplicate subscribeState listener is rejected loudly (round-4 finding)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
      subscribeState(listener: (state: unknown) => void): () => void
      _listenerUnsubscribersSize(): number
    }
    const listener = (): void => {}
    const release = service.subscribeState(listener)
    assert.equal(service._listenerUnsubscribersSize(), 1)
    // The SAME listener function again: rejected, and the FIRST
    // subscription stays intact (its teardown is not overwritten).
    assert.throws(
      () => service.subscribeState(listener),
      /already subscribed/i,
      'a duplicate listener must be rejected loudly (round-4 finding)',
    )
    assert.equal(service._listenerUnsubscribersSize(), 1, 'the first subscription must survive the rejected duplicate')
    release()
    assert.equal(service._listenerUnsubscribersSize(), 0, 'the first subscription releases cleanly')
    // After release, the SAME listener can subscribe again.
    const release2 = service.subscribeState(listener)
    assert.equal(service._listenerUnsubscribersSize(), 1)
    release2()
    assert.equal(service._listenerUnsubscribersSize(), 0)
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

// ── M5: fiber-bound registries (commands/themes/settings/autocomplete/ ─────
// ── keybindings) ───────────────────────────────────────────────────────────

test('a STALE command handle never untracks a later registration (same owner + id)', async () => {
  // The ledger health record is keyed (slot, owner, id) — it cannot tell two
  // registrations of one id apart. A repeated/late cleanup of a disposed
  // handle must therefore leave a NEWER generation (same owner, same id) both
  // registered AND tracked.
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await mount(ctx, startupPlugin)
    await mount(ctx, applyExtensionHost)
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as unknown as {
      registerCommand(contribution: {
        id: string
        name: string
        description: string
        handler: () => { kind: 'success' }
      }): { id: string; dispose(): void }
      commands: { isLocal(name: string, statics: ReadonlySet<string>): boolean }
      _ledger(): { healthSnapshot(): readonly { id: string; state: string }[] }
    }
    const spec = {
      id: 'stale-cmd',
      name: 'stalecmd',
      description: 'stale handle',
      handler: () => ({ kind: 'success' as const }),
    }
    const first = service.registerCommand(spec)
    first.dispose()
    assert.equal(service.commands.isLocal('stalecmd', new Set()), false, 'the first disposal removed it')
    const second = service.registerCommand(spec)
    // The late/repeated cleanup of the OLD handle.
    first.dispose()
    first.dispose()
    assert.equal(service.commands.isLocal('stalecmd', new Set()), true, 'the newer registration stays live')
    assert.equal(service._ledger().healthSnapshot().some(entry => entry.id === 'stale-cmd'), true,
      'the newer registration health record survives the stale cleanup')
    second.dispose()
    assert.equal(service.commands.isLocal('stalecmd', new Set()), false, 'the current handle disposes its own')
    assert.equal(service._ledger().healthSnapshot().some(entry => entry.id === 'stale-cmd'), false,
      'and untracks its own record')
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('command/theme/setting registrations are fiber-bound (owner unload cleans up)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
      registerCommand(contribution: {
        id: string
        name: string
        description: string
        handler: () => { kind: 'success' }
      }): { id: string; dispose(): void }
      registerTheme(contribution: { id: string; name: string; palette: object }): { id: string; dispose(): void }
      registerSetting(contribution: { id: string; label: string; currentValue: string }): { id: string; dispose(): void }
      registerAutocomplete(contribution: { id: string; provider: object }): { id: string; dispose(): void }
      registerKeybinding(contribution: {
        id: string
        key: { key: string; ctrl: boolean; alt: boolean; shift: boolean; super: boolean }
        action: string
      }): { id: string; dispose(): void }
      commands: { isLocal(name: string, statics: ReadonlySet<string>): boolean; hasAny(): boolean }
      themes: { names(): string[]; hasAny(): boolean }
      settings: { rows(): unknown[]; hasAny(): boolean }
      autocomplete: { hasAny(): boolean }
      keybindings: { hasAny(): boolean }
    }
    assert.ok(service !== undefined)
    // Plugin A registers one contribution in every M5 registry.
    const disposer = await mount(ctx, (pluginCtx) => {
      const svc = pluginCtx.get(PI_TUI_EXTENSIONS_SERVICE) as typeof service
      svc.registerCommand({ id: 'cmd-a', name: 'acmd', description: 'a', handler: () => ({ kind: 'success' }) })
      svc.registerTheme({ id: 'theme-a', name: 'A Theme', palette: { text: '#fff' } })
      svc.registerSetting({ id: 'set-a', label: 'A Setting', currentValue: 'v' })
      svc.registerAutocomplete({ id: 'auto-a', provider: { getSuggestions: async () => null } })
      svc.registerKeybinding({
        id: 'key-a',
        // A modified chord: a plain printable key is rejected at
        // registration (the router keeps printable keys with the editor,
        // so the binding could never fire — round-12 finding).
        key: { key: 'k', ctrl: true, alt: true, shift: false, super: false },
        action: 'open-search',
      })
    })
    await settle()
    assert.equal(service.commands.isLocal('acmd', new Set()), true)
    assert.deepEqual(service.themes.names(), ['A Theme'])
    assert.equal(service.settings.rows().length, 1)
    assert.equal(service.commands.hasAny(), true)
    assert.equal(service.themes.hasAny(), true)
    assert.equal(service.settings.hasAny(), true)
    assert.equal(service.autocomplete.hasAny(), true)
    assert.equal(service.keybindings.hasAny(), true)
    // Unload plugin A: every contribution disappears.
    await disposer()
    await settle()
    assert.equal(service.commands.isLocal('acmd', new Set()), false)
    assert.deepEqual(service.themes.names(), [])
    assert.equal(service.settings.rows().length, 0)
    assert.equal(service.commands.hasAny(), false)
    assert.equal(service.themes.hasAny(), false)
    assert.equal(service.settings.hasAny(), false)
    assert.equal(service.autocomplete.hasAny(), false)
    assert.equal(service.keybindings.hasAny(), false)
    await host()
    await startup()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('the keybinding registry rejects non-public actions and printable keys through the PUBLIC path (round 12)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
      registerKeybinding(contribution: {
        id: string
        key: { key: string; ctrl: boolean; alt: boolean; shift: boolean; super: boolean }
        action: string
      }): { id: string; dispose(): void }
      keybindings: { hasAny(): boolean }
    }
    assert.ok(service !== undefined)
    // A Host-private app.* action is NOT a public TuiAction: the runtime
    // whitelist must reject it through the PUBLIC extension path — a
    // JS/`as any` plugin can never trigger the Host dispatcher with it
    // (capability boundary, round-12 finding).
    assert.throws(() => service.registerKeybinding({
      id: 'bad-exit',
      key: { key: 'x', ctrl: true, alt: false, shift: false, super: false },
      action: 'app.exit.request' as never,
    }), /not a public TuiAction/, 'a Host-private action string must be rejected through the public path')
    // A plain printable key can never reach the plugin stage: rejected too.
    assert.throws(() => service.registerKeybinding({
      id: 'bad-space',
      key: { key: 'space', ctrl: false, alt: false, shift: false, super: false },
      action: 'open-search',
    }), /text-producing/, 'a text-producing key must be rejected through the public path')
    // Shift-only text keys are text on every protocol (Shift+A is the 'A'
    // byte on legacy, 'a'+shift on Kitty) — rejected like unmodified ones
    // (round-17 finding: they used to steal typing on Kitty).
    assert.throws(() => service.registerKeybinding({
      id: 'bad-shift-a',
      key: { key: 'a', ctrl: false, alt: false, shift: true, super: false },
      action: 'open-search',
    }), /text-producing/, 'Shift+A must be rejected through the public path')
    // A key name the fork grammar can never produce can never fire:
    // rejected at registration (round-17 finding).
    assert.throws(() => service.registerKeybinding({
      id: 'bad-name',
      key: { key: 'definitely-not-a-key', ctrl: true, alt: false, shift: false, super: false },
      action: 'open-search',
    }), /not a valid key/, 'a non-grammar key name must be rejected through the public path')
    // A fork EDITOR-owned key (Tab) is consumed by the focused editor
    // before the plugin stage — the registration is rejected instead of
    // advertising a dead rule (round-19 finding).
    assert.throws(() => service.registerKeybinding({
      id: 'bad-tab',
      key: { key: 'tab', ctrl: false, alt: false, shift: false, super: false },
      action: 'open-search',
    }), /editor/, 'an editor-owned key must be rejected through the public path')
    // A legacy C0 alias (Ctrl+I is the Tab byte on legacy terminals) can
    // never fire through the plugin stage either: rejected through the
    // public path, sharing the config parser's legacy inventory (round-13
    // finding — the EffectiveKeymap would resolve it but the router's
    // normalized lookup never would).
    assert.throws(() => service.registerKeybinding({
      id: 'bad-legacy',
      key: { key: 'i', ctrl: true, alt: false, shift: false, super: false },
      action: 'open-search',
    }), /legacy terminal/, 'a legacy C0 key must be rejected through the public path')
    // A public action + modified chord registers fine.
    const handle = service.registerKeybinding({
      id: 'good',
      key: { key: 'x', ctrl: true, alt: true, shift: false, super: false },
      action: 'open-search',
    })
    await settle()
    assert.equal(service.keybindings.hasAny(), true)
    handle.dispose()
    await settle()
    assert.equal(service.keybindings.hasAny(), false)
    await host()
    await startup()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('a subscription record survives detach and re-binds on the next attach (no reload needed)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
      attachSurface(bridge: { subscribe(listener: (state: unknown) => void): () => void }, capabilities: ReadonlySet<string>, surfaceId: string): void
      detachSurface(surfaceId?: string): void
      subscribeState(listener: (state: unknown) => void): () => void
      _listenerUnsubscribersSize(): number
    }

    // A PLUGIN fiber subscribes (its fiber stays alive the whole test —
    // the review repro: plugin fiber alive, surface recreated).
    const received: string[] = []
    const plugin = await mount(ctx, (c) => {
      const svc = c.get(PI_TUI_EXTENSIONS_SERVICE) as typeof service
      svc.subscribeState((state) => received.push((state as { surface: { surfaceId: string } }).surface.surfaceId))
    })
    await settle()
    assert.equal(service._listenerUnsubscribersSize(), 1, 'the plugin subscription record exists')

    // Surface A attaches: the listener receives A's state.
    service.attachSurface({
      subscribe: (listener) => {
        listener({ surface: { surfaceId: 'surface-A' } } as never)
        return () => {}
      },
    }, new Set(), 'surface-A')
    await settle()
    assert.deepEqual(received, ['surface-A'], 'the listener receives A state on attach')

    // Surface A detaches: the RECORD survives (pending), the binding is gone.
    service.detachSurface('surface-A')
    await settle()
    assert.equal(service._listenerUnsubscribersSize(), 1, 'the record survives the detach (P1-3)')

    // A while later, surface B attaches: the SAME record re-binds WITHOUT
    // the plugin fiber reloading.
    service.attachSurface({
      subscribe: (listener) => {
        listener({ surface: { surfaceId: 'surface-B' } } as never)
        return () => {}
      },
    }, new Set(), 'surface-B')
    await settle()
    assert.deepEqual(received, ['surface-A', 'surface-B'], 'the listener receives B state on re-attach (P1-3)')

    // The plugin unloads: the record is removed and nothing is bound.
    await plugin()
    await settle()
    assert.equal(service._listenerUnsubscribersSize(), 0, 'owner unload removes the record')
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('no-arg detach releases the current surface leases', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
      attachSurface(
        bridge: { subscribe(listener: (state: unknown) => void): () => void },
        capabilities: ReadonlySet<string>,
        surfaceId: string,
        requestRender?: (force?: boolean) => void,
      ): void
      detachSurface(surfaceId?: string): void
      setOverlayMount(surfaceId: string, mount: (view: unknown, options?: unknown) => { close(): void; hide(): void; show(): void }): void
      showOverlay(view: unknown, options?: unknown): { close(): void; hide(): void; show(): void }
      subscribeState(listener: (state: unknown) => void): () => void
      _listenerUnsubscribersSize(): number
    }

    let renderRequests = 0
    let bridgeSubscribed = 0
    let overlayMounts = 0
    let overlayCloses = 0
    service.attachSurface({
      subscribe: (listener) => {
        bridgeSubscribed += 1
        listener({ surface: { surfaceId: 'surface-current' } })
        return () => { bridgeSubscribed -= 1 }
      },
    }, new Set(), 'surface-current', () => { renderRequests += 1 })
    service.setOverlayMount('surface-current', () => {
      overlayMounts += 1
      return {
        close: () => { overlayCloses += 1 },
        hide: () => {},
        show: () => {},
      }
    })
    const releaseState = service.subscribeState(() => {})

    let registration: { invalidate(): void; dispose(): void } | undefined
    let overlay: { close(): void; hide(): void; show(): void } | undefined
    const plugin = await mount(ctx, (c) => {
      const svc = c.get(PI_TUI_EXTENSIONS_SERVICE) as typeof service & {
        register(slot: string, spec: { id: string }, value: { text: string }): { invalidate(): void; dispose(): void }
      }
      registration = svc.register('chrome.header.badge', { id: 'current' }, { text: 'current' })
      overlay = svc.showOverlay({ kind: 'text', spans: [{ text: 'current' }] })
    })
    await settle()
    assert.equal(bridgeSubscribed, 1, 'the current bridge is live')
    assert.ok(renderRequests > 0, 'the current surface receives registration invalidation')
    assert.equal(overlayMounts, 1, 'the current surface mounts the overlay')

    // No-arg detach means the CURRENT generation. It releases the
    // surface-owned seams while preserving caller-owned records for a later
    // surface recreation.
    service.detachSurface()
    assert.equal(bridgeSubscribed, 0, 'the current bridge binding is released')
    assert.equal(service._listenerUnsubscribersSize(), 1, 'the caller-owned subscription record survives detach')

    const rendersBeforeDetachedInvalidation = renderRequests
    registration!.invalidate()
    await settle()
    assert.equal(renderRequests, rendersBeforeDetachedInvalidation, 'detached invalidation must not reach the dead surface')

    const mountsBeforeDetachedOverlay = overlayMounts
    const inert = service.showOverlay({ kind: 'text', spans: [{ text: 'detached' }] })
    assert.equal(overlayMounts, mountsBeforeDetachedOverlay, 'detached surface must not mount a new overlay')
    inert.close()
    overlay!.close()
    assert.equal(overlayCloses, 1, 'closing the mounted overlay lease remains idempotent')

    registration!.dispose()
    releaseState()
    await plugin()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('attach A → attach B → late detach A leaves B bound (stale detach)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = await mount(ctx, startupPlugin)
    const host = await mount(ctx, applyExtensionHost)
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
      attachSurface(bridge: { subscribe(listener: (state: unknown) => void): () => void }, capabilities: ReadonlySet<string>, surfaceId: string): void
      detachSurface(surfaceId?: string): void
      subscribeState(listener: (state: unknown) => void): () => void
      _listenerUnsubscribersSize(): number
    }

    // A listener migrates A → B; the LATE detach of A must not unbind B.
    let bridgeASubscribed = 0
    let bridgeBSubscribed = 0
    service.attachSurface({
      subscribe: () => { bridgeASubscribed += 1; return () => { bridgeASubscribed -= 1 } },
    }, new Set(), 'surface-A')
    service.subscribeState(() => {})
    assert.equal(bridgeASubscribed, 1)
    service.attachSurface({
      subscribe: () => { bridgeBSubscribed += 1; return () => { bridgeBSubscribed -= 1 } },
    }, new Set(), 'surface-B')
    assert.equal(bridgeBSubscribed, 1, 'the listener migrates to B')
    assert.equal(bridgeASubscribed, 0, 'the old bridge binding is released')
    // The stale detach (A) must be a NO-OP for B's binding.
    service.detachSurface('surface-A')
    assert.equal(bridgeBSubscribed, 1, 'the late detach of A must not unbind B (P1)')
    assert.equal(service._listenerUnsubscribersSize(), 1, 'the record stays')
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

// ── P1-4: managed overlays are CALLER-FIBER-OWNED ──────────────────────────

test('a plugin overlay closes automatically when the owner fiber unloads (HMR/disable)', async () => {
  const { VirtualTerminal } = await import('../support/virtual-terminal.ts')
  const { TuiApp } = await import('../../src/tui-app.ts')
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startupFiber = ctx.plugin((c) => {
      c.provide(TUI_STARTUP_SERVICE, {})
    })
    await startupFiber
    const hostFiber = ctx.plugin(applyExtensionHost)
    await hostFiber

    // The runner wires the service seam to a REAL app surface.
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
      setOverlayMount(surfaceId: string, mount: (view: unknown, options?: unknown) => { close(): void; hide(): void; show(): void }): void
      showOverlay(view: unknown, options?: unknown): { close(): void; hide(): void; show(): void }
    }
    const vt = new VirtualTerminal(80, 24)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
    app.start()
    startedApps.add(app)
    await vt.waitForRender()
    service.setOverlayMount('surface-1', (view, options) => app.showExtensionOverlay(view as never, options as never))

    // A plugin fiber opens an overlay.
    const plugin = ctx.plugin((c) => {
      const svc = c.get(PI_TUI_EXTENSIONS_SERVICE) as typeof service
      svc.showOverlay({ kind: 'text', spans: [{ text: 'plugin overlay' }] })
    })
    await plugin
    await vt.waitForRender()
    const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
    let view = vt.getViewport().map(strip).join('\n')
    assert.ok(view.includes('plugin overlay'), 'the plugin overlay must be visible')

    // The plugin fiber unloads (HMR/disable): the overlay MUST close
    // automatically — the TUI surface stays alive.
    await plugin.dispose()
    await Promise.resolve()
    await Promise.resolve()
    await vt.waitForRender()
    view = vt.getViewport().map(strip).join('\n')
    assert.ok(!view.includes('plugin overlay'), `the overlay must close on owner unload (P1-4):\n${view}`)
    assert.equal(app.ownedExtensionOverlayLeasesForTest(), 0, 'no owned lease may survive the owner unload')
    app.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('explicit close then fiber unload is idempotent — no double close, no throw', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startupFiber = ctx.plugin((c) => {
      c.provide(TUI_STARTUP_SERVICE, {})
    })
    await startupFiber
    const hostFiber = ctx.plugin(applyExtensionHost)
    await hostFiber

    let closes = 0
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
      setOverlayMount(surfaceId: string, mount: (view: unknown, options?: unknown) => { close(): void; hide(): void; show(): void }): void
      showOverlay(view: unknown, options?: unknown): { close(): void; hide(): void; show(): void }
    }
    service.setOverlayMount('surface-1', () => ({
      close: () => { closes += 1 },
      hide: () => {},
      show: () => {},
    }))

    // The plugin explicitly closes, THEN its fiber unloads.
    const plugin = ctx.plugin((c) => {
      const svc = c.get(PI_TUI_EXTENSIONS_SERVICE) as typeof service
      const lease = svc.showOverlay({ kind: 'text', spans: [{ text: 'x' }] })
      lease.close()
      lease.close()
      lease.hide()
      lease.show()
    })
    await plugin
    await plugin.dispose()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(closes, 1, 'close + fiber unload must close EXACTLY once (idempotent, no double close)')
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('an old overlay lease is INERT after its surface disposes; it never mounts on a newer surface', async () => {
  const { VirtualTerminal } = await import('../support/virtual-terminal.ts')
  const { TuiApp } = await import('../../src/tui-app.ts')
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startupFiber = ctx.plugin((c) => {
      c.provide(TUI_STARTUP_SERVICE, {})
    })
    await startupFiber
    const hostFiber = ctx.plugin(applyExtensionHost)
    await hostFiber

    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
      setOverlayMount(surfaceId: string, mount: (view: unknown, options?: unknown) => { close(): void; hide(): void; show(): void }): void
      detachSurface(surfaceId?: string): void
      showOverlay(view: unknown, options?: unknown): { close(): void; hide(): void; show(): void }
    }
    const vt = new VirtualTerminal(80, 24)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
    app.start()
    startedApps.add(app)
    await vt.waitForRender()

    // Surface A's seam is wired; a plugin opens an overlay through it.
    service.setOverlayMount('surface-A', (view, options) => app.showExtensionOverlay(view as never, options as never))
    let lease: { close(): void; hide(): void; show(): void } | undefined
    const plugin = ctx.plugin((c) => {
      const svc = c.get(PI_TUI_EXTENSIONS_SERVICE) as typeof service
      lease = svc.showOverlay({ kind: 'text', spans: [{ text: 'old overlay' }] })
    })
    await plugin
    await vt.waitForRender()
    assert.ok(vt.getViewport().join('\n').includes('old overlay'))

    // Surface A disposes: the seam detaches (surface-owned) AND the app's
    // dispose closes every still-owned lease.
    app.dispose()
    service.detachSurface('surface-A')
    await Promise.resolve()
    await Promise.resolve()

    // A newer surface B attaches with ITS OWN seam — the OLD lease must
    // never mount on B (the old seam is gone; show() is inert).
    const vtB = new VirtualTerminal(80, 24)
    const appB = new TuiApp(vtB, { onSubmit: () => {}, onExit: () => {} })
    appB.start()
    startedApps.add(appB)
    await vtB.waitForRender()
    service.setOverlayMount('surface-B', (view, options) => appB.showExtensionOverlay(view as never, options as never))
    lease?.show()
    await vtB.waitForRender()
    assert.ok(!vtB.getViewport().join('\n').includes('old overlay'), 'the old lease must not mount on surface B (P1-4)')
    lease?.close()
    assert.equal(appB.ownedExtensionOverlayLeasesForTest(), 0)
    appB.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

// ── Stable registration release IDEMPOTENCE (six slots) ────────────────────
//
// The health record is keyed (slot, owner, id) and the five external
// registries key their records BY ID ONLY, so neither can tell two
// registrations of one id apart. Every release of a registration must
// therefore run EXACTLY ONCE: the explicit handle release, the fiber effect
// cleanup and the failed-effect rollback share one cleanup. A repeated or
// LATE release of an OLD registration must leave a same-fiber (or HMR
// reloaded) replacement's record, its registry revision and its health
// untouched.

/** One live registration handle (the public handle shape). */
interface SlotRegistration {
  readonly id: string
  dispose(): void
}

/** The scoped service surface the six slots are driven through. */
interface LifecycleService {
  registerTheme(contribution: TuiThemeContribution): SlotRegistration
  registerAutocomplete(contribution: AutocompleteProviderContribution): SlotRegistration
  registerKeybinding(contribution: TuiKeybindingContribution): SlotRegistration
  registerMessageRenderer(contribution: TuiMessageRendererContribution): SlotRegistration
  registerToolRenderer(contribution: TuiToolRendererContribution): SlotRegistration
  registerEditor(contribution: EditorContribution): SlotRegistration
  setThemeUnloadedHook(hook: (unloaded: { selectableValue: string; name: string }) => void): () => void
  readonly themes: {
    snapshot(): { themes: readonly { id: string; name: string; owner: string }[]; revision: number }
    selectableValues(): string[]
    displayNameForSelectable(value: string): string | undefined
    hasSelectable(value: string): boolean
  }
  readonly autocomplete: {
    snapshot(): { providers: readonly { id: string; description?: string; owner: string }[]; revision: number }
    suggestOwned(
      query: TuiAutocompleteQuery,
      onError?: (id: string, owner: string, error: unknown) => void,
      onSuccess?: (id: string, owner: string) => void,
    ): Promise<{ items: readonly { value: string; label: string }[]; prefix: string } | null>
  }
  readonly keybindings: {
    snapshot(): { bindings: readonly { id: string; action: string; owner: string }[]; revision: number }
    actionFor(key: NormalizedKey): string | undefined
    subscribe(listener: () => void): () => void
  }
  readonly renderers: {
    snapshot(): {
      messageRenderers: readonly { id: string; description?: string; owner: string }[]
      toolRenderers: readonly { id: string; toolName: string; description?: string; owner: string }[]
      revision: number
    }
    renderMessageOwned(
      snapshot: MessagePresentationSnapshot,
      onError?: (id: string, owner: string, error: unknown) => void,
    ): { view: ExtensionView; rendererId: string; owner: string } | undefined
    renderToolOwned(
      snapshot: ToolPresentationSnapshot,
      onError?: (id: string, owner: string, error: unknown) => void,
    ): { view: ExtensionView; rendererId: string; owner: string } | undefined
  }
  readonly editors: {
    snapshot(): { editors: readonly { id: string; priority: number; owner: string }[]; revision: number }
    winner(): { id: string; priority: number; owner: string } | undefined
  }
  _ledger(): {
    healthSnapshot(): readonly ContributionHealth[]
    recordExternalError(slot: string, id: string, owner: string, message: string): void
    clearExternalError(slot: string, id: string, owner: string): void
  }
}

type Variant = 'A' | 'B'

/** The mutable failure switch of one registration (a natural failure path). */
interface FailureGate {
  fail: boolean
}

/** One slot's registration/release/observation adapter (file-local table). */
interface SlotProbe {
  /** Short stable id for this slot (test ids are built from it). */
  readonly key: string
  /** The health `extensionPoint` of the slot. */
  readonly slot: string
  readonly recordMarker: (variant: Variant) => string
  readonly invokeMarker: (variant: Variant) => string
  /** A natural callback failure (B's provider/render throws), when one exists. */
  readonly failureMessage?: (variant: Variant) => string
  readonly register: (service: LifecycleService, id: string, variant: Variant, gate: FailureGate) => SlotRegistration
  /** The live registry record for `id`, as (owner, visible label). */
  readonly live: (service: LifecycleService, id: string) => { owner: string; label: string } | undefined
  /** The registry revision (a no-op release must not bump it). */
  readonly revision: (service: LifecycleService) => number
  /** Drive the slot through its real consumer path. */
  readonly invoke: (
    service: LifecycleService,
    id: string,
    onError: (owner: string, error: unknown) => void,
  ) => string | undefined | Promise<string | undefined>
}

const KEY_CHORD: NormalizedKey = { key: 'k', ctrl: true, alt: true, shift: false, super: false }

/** A partial palette sample: the registry stores the contribution verbatim. */
const SAMPLE_PALETTE = { text: '#111111' } as unknown as TuiColorPalette

function textView(text: string): ExtensionView {
  return { kind: 'text', spans: [{ text }] }
}

function viewText(view: ExtensionView): string {
  return view.kind === 'text' ? view.spans.map(span => span.text).join('') : `<${view.kind}>`
}

const SLOT_PROBES: readonly SlotProbe[] = [
  {
    key: 'theme',
    slot: 'theme',
    recordMarker: variant => `Shared ${variant} theme`,
    invokeMarker: variant => `Shared ${variant} theme`,
    register: (service, id, variant) => service.registerTheme({
      id,
      name: `Shared ${variant} theme`,
      palette: SAMPLE_PALETTE,
    }),
    live: (service, id) => {
      const record = service.themes.snapshot().themes.find(entry => entry.id === id)
      return record === undefined ? undefined : { owner: record.owner, label: record.name }
    },
    revision: service => service.themes.snapshot().revision,
    invoke: service => {
      const values = service.themes.selectableValues()
      if (values.length !== 1) return `<${values.length} live selectables>`
      return service.themes.displayNameForSelectable(values[0]!)
    },
  },
  {
    key: 'autocomplete',
    slot: 'autocomplete',
    recordMarker: variant => `Shared ${variant} provider`,
    invokeMarker: variant => `${variant}-suggestion`,
    failureMessage: variant => `${variant} provider boom`,
    register: (service, id, variant, gate) => service.registerAutocomplete({
      id,
      description: `Shared ${variant} provider`,
      provider: {
        getSuggestions: async () => {
          if (gate.fail) throw new Error(`${variant} provider boom`)
          return { items: [{ value: `${variant}-suggestion`, label: `${variant} suggestion` }], prefix: '' }
        },
      },
    }),
    live: (service, id) => {
      const record = service.autocomplete.snapshot().providers.find(entry => entry.id === id)
      return record === undefined ? undefined : { owner: record.owner, label: record.description ?? '' }
    },
    revision: service => service.autocomplete.snapshot().revision,
    invoke: async (service, id, onError) => {
      const result = await service.autocomplete.suggestOwned(
        { lines: [], cursorLine: 0, cursorCol: 0, signal: new AbortController().signal },
        (failedId, failureOwner, error) => {
          if (failedId === id) onError(failureOwner, error)
        },
      )
      return result?.items[0]?.value
    },
  },
  {
    key: 'keybinding',
    slot: 'keybinding',
    recordMarker: variant => variant === 'A' ? 'open-search' : 'toggle-fullscreen',
    invokeMarker: variant => variant === 'A' ? 'open-search' : 'toggle-fullscreen',
    register: (service, id, variant) => service.registerKeybinding({
      id,
      key: KEY_CHORD,
      action: variant === 'A' ? 'open-search' : 'toggle-fullscreen',
      description: `Shared ${variant} binding`,
    }),
    live: (service, id) => {
      const record = service.keybindings.snapshot().bindings.find(entry => entry.id === id)
      return record === undefined ? undefined : { owner: record.owner, label: record.action }
    },
    revision: service => service.keybindings.snapshot().revision,
    invoke: service => service.keybindings.actionFor(KEY_CHORD),
  },
  {
    key: 'message',
    slot: 'transcript.message.renderer',
    recordMarker: variant => `Shared ${variant} message renderer`,
    invokeMarker: variant => `${variant} message view`,
    failureMessage: variant => `${variant} message renderer boom`,
    register: (service, id, variant, gate) => service.registerMessageRenderer({
      id,
      description: `Shared ${variant} message renderer`,
      render: () => {
        if (gate.fail) throw new Error(`${variant} message renderer boom`)
        return textView(`${variant} message view`)
      },
    }),
    live: (service, id) => {
      const record = service.renderers.snapshot().messageRenderers.find(entry => entry.id === id)
      return record === undefined ? undefined : { owner: record.owner, label: record.description ?? '' }
    },
    revision: service => service.renderers.snapshot().revision,
    invoke: (service, id, onError) => {
      const rendered = service.renderers.renderMessageOwned(
        { kind: 'assistant', turn: 0, text: 'body' },
        (failedId, failureOwner, error) => {
          if (failedId === id) onError(failureOwner, error)
        },
      )
      return rendered === undefined ? undefined : viewText(rendered.view)
    },
  },
  {
    key: 'tool',
    slot: 'transcript.tool.renderer',
    recordMarker: variant => `Shared ${variant} tool renderer`,
    invokeMarker: variant => `${variant} tool view`,
    failureMessage: variant => `${variant} tool renderer boom`,
    register: (service, id, variant, gate) => service.registerToolRenderer({
      id,
      toolName: 'bash',
      description: `Shared ${variant} tool renderer`,
      render: () => {
        if (gate.fail) throw new Error(`${variant} tool renderer boom`)
        return textView(`${variant} tool view`)
      },
    }),
    live: (service, id) => {
      const record = service.renderers.snapshot().toolRenderers.find(entry => entry.id === id)
      return record === undefined ? undefined : { owner: record.owner, label: record.description ?? '' }
    },
    revision: service => service.renderers.snapshot().revision,
    invoke: (service, id, onError) => {
      const rendered = service.renderers.renderToolOwned(
        { callId: 'call-1', toolName: 'bash', status: 'ok', expanded: false },
        (failedId, failureOwner, error) => {
          if (failedId === id) onError(failureOwner, error)
        },
      )
      return rendered === undefined ? undefined : viewText(rendered.view)
    },
  },
  {
    key: 'editor',
    slot: 'editor',
    recordMarker: variant => variant === 'A' ? '5' : '7',
    invokeMarker: variant => variant === 'A' ? '5' : '7',
    register: (service, id, variant) => service.registerEditor({
      id,
      priority: variant === 'A' ? 5 : 7,
      create: () => ({
        component: textView(`${variant} editor`),
        getText: () => '',
        setText: () => {},
        dispose: () => {},
      }),
    }),
    live: (service, id) => {
      const record = service.editors.snapshot().editors.find(entry => entry.id === id)
      return record === undefined ? undefined : { owner: record.owner, label: String(record.priority) }
    },
    revision: service => service.editors.snapshot().revision,
    invoke: service => String(service.editors.winner()?.priority),
  },
]

/** Boot the real Cordis loader + the real extension host. */
async function mountLifecycleHost(ctx: Context): Promise<void> {
  await ctx.plugin(Loader)
  await mount(ctx, startupPlugin)
  await mount(ctx, applyExtensionHost)
}

/**
 * Mount one REAL plugin fiber and return the scoped service it captured
 * (`c.get(PI_TUI_EXTENSIONS_SERVICE)` — every registration in these tests
 * enters through that scoped handle, never the bare registries).
 */
async function mountServiceOwner(
  ctx: Context,
  name?: string,
): Promise<{ service: LifecycleService; unload: () => Promise<void> }> {
  let captured: LifecycleService | undefined
  const apply = (c: Context): void => {
    captured = c.get(PI_TUI_EXTENSIONS_SERVICE) as unknown as LifecycleService
  }
  const fiber = name === undefined ? ctx.plugin(apply) : ctx.plugin({ name, apply })
  await fiber
  assert.ok(captured !== undefined, 'the plugin fiber must resolve the extension service')
  return { service: captured, unload: () => fiber.dispose() }
}

/** Every health record for one slot + id (all owners). */
function slotHealth(service: LifecycleService, slot: string, id: string): readonly ContributionHealth[] {
  return service._ledger().healthSnapshot().filter(record => record.extensionPoint === slot && record.id === id)
}

/**
 * One slot's full A → release → B → late-A-release sequence. Every
 * registration enters through the plugin fiber's SCOPED service handle; the
 * consumer paths are the real registry reads (suggestOwned /
 * renderMessageOwned / renderToolOwned / actionFor / selectableValues /
 * winner).
 */
async function runReplacementScenario(ctx: Context, probe: SlotProbe): Promise<void> {
  await mountLifecycleHost(ctx)
  const owner = await mountServiceOwner(ctx, `release-owner-${probe.key}`)
  const service = owner.service
  const gate: FailureGate = { fail: false }
  try {
    const first = probe.register(service, 'shared', 'A', gate)
    const liveA = probe.live(service, 'shared')
    assert.equal(liveA?.label, probe.recordMarker('A'), `${probe.slot}: A is the live registry record`)
    assert.ok(liveA !== undefined)
    const ownerA = liveA.owner
    const healthA = slotHealth(service, probe.slot, 'shared')
    assert.equal(healthA.length, 1, `${probe.slot}: A owns exactly ONE health record`)
    assert.equal(healthA[0]?.owner, ownerA, `${probe.slot}: A's health is the caller's owner`)
    assert.equal(healthA[0]?.state, 'active')

    first.dispose()
    assert.equal(probe.live(service, 'shared'), undefined, `${probe.slot}: A's release removes its record`)
    assert.equal(slotHealth(service, probe.slot, 'shared').length, 0, `${probe.slot}: A's release drops its health`)

    // The SAME fiber registers the same id again (the replacement).
    const second = probe.register(service, 'shared', 'B', gate)
    const liveB = probe.live(service, 'shared')
    assert.equal(liveB?.label, probe.recordMarker('B'), `${probe.slot}: B is the live registry record`)
    assert.equal(liveB?.owner, ownerA, `${probe.slot}: B is registered by the same owner`)
    const revisionB = probe.revision(service)
    const healthB = slotHealth(service, probe.slot, 'shared')
    assert.equal(healthB.length, 1, `${probe.slot}: B owns exactly ONE health record`)
    assert.equal(healthB[0]?.state, 'active')
    const onError = (failureOwner: string, error: unknown): void => {
      service._ledger().recordExternalError(probe.slot, 'shared', failureOwner, String(error))
    }
    assert.equal(await probe.invoke(service, 'shared', onError), probe.invokeMarker('B'),
      `${probe.slot}: B serves through its real consumer path`)

    // The OLD handle is released again — twice.
    first.dispose()
    first.dispose()
    assert.equal(probe.live(service, 'shared')?.label, probe.recordMarker('B'),
      `${probe.slot}: the late old release keeps B's live record identity`)
    assert.equal(probe.revision(service), revisionB,
      `${probe.slot}: the late old release does not mutate the registry revision`)
    const healthAfterLate = slotHealth(service, probe.slot, 'shared')
    assert.equal(healthAfterLate.length, 1, `${probe.slot}: B keeps exactly ONE health record`)
    assert.equal(healthAfterLate[0]?.owner, ownerA, `${probe.slot}: B's health is still B's own record`)
    assert.equal(healthAfterLate[0]?.state, 'active')
    assert.equal(await probe.invoke(service, 'shared', onError), probe.invokeMarker('B'),
      `${probe.slot}: B still serves after the late old release`)

    // B's FAILURE must land on B's surviving health record.
    if (probe.failureMessage !== undefined) {
      gate.fail = true
      assert.equal(await probe.invoke(service, 'shared', onError), undefined,
        `${probe.slot}: the failing B abdicates`)
      const failed = slotHealth(service, probe.slot, 'shared')
      assert.equal(failed.length, 1, `${probe.slot}: the failure lands on B's health record`)
      assert.equal(failed[0]?.owner, ownerA)
      assert.equal(failed[0]?.state, 'failed')
      assert.match(failed[0]?.lastError ?? '', new RegExp(`${probe.failureMessage('B')}$`),
        `${probe.slot}: B's own error message is recorded`)
      gate.fail = false
    } else {
      // No natural failure callback for this slot: the health bridge reports
      // against the CURRENT owner (B), and the record it reaches is B's.
      service._ledger().recordExternalError(probe.slot, 'shared', ownerA, 'bridge refused')
      const failed = slotHealth(service, probe.slot, 'shared')
      assert.equal(failed.length, 1)
      assert.equal(failed[0]?.state, 'failed')
      assert.equal(failed[0]?.lastError, 'bridge refused')
      service._ledger().clearExternalError(probe.slot, 'shared', ownerA)
      assert.equal(slotHealth(service, probe.slot, 'shared')[0]?.state, 'active')
    }

    second.dispose()
    second.dispose()
    assert.equal(probe.live(service, 'shared'), undefined, `${probe.slot}: B's own release removes its record`)
    assert.equal(slotHealth(service, probe.slot, 'shared').length, 0, `${probe.slot}: B's own release drops its health`)
  } finally {
    await owner.unload()
  }
  assert.equal(probe.live(service, 'shared'), undefined,
    `${probe.slot}: the owner unload leaves no record`)
  assert.equal(slotHealth(service, probe.slot, 'shared').length, 0,
    `${probe.slot}: the owner unload leaves no health`)
}

for (const probe of SLOT_PROBES) {
  test(`a released ${probe.slot} handle keeps a same-id replacement and its health`, async () => {
    const ctx = new Context()
    try {
      await runReplacementScenario(ctx, probe)
    } finally {
      for (const runtime of [...ctx.registry.values()]) {
        for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
      }
    }
  })
}

test('a listener registering a same-id replacement during the release keeps its health (synchronous reentrancy)', async () => {
  const ctx = new Context()
  try {
    await mountLifecycleHost(ctx)
    const owner = await mountServiceOwner(ctx)
    const service = owner.service
    const first = service.registerKeybinding({ id: 'reentrant', key: KEY_CHORD, action: 'open-search' })
    assert.equal(service.keybindings.actionFor(KEY_CHORD), 'open-search')
    const oldOwner = service.keybindings.snapshot().bindings.find(entry => entry.id === 'reentrant')?.owner
    assert.ok(oldOwner !== undefined)

    // The registry's dispose notifies SYNCHRONOUSLY, with the record already
    // removed: a listener may register the replacement right there. The
    // replacement's health must survive the remainder of the OLD release.
    let replacement: SlotRegistration | undefined
    let reentered = false
    const unsubscribe = service.keybindings.subscribe(() => {
      if (reentered) return
      if (service.keybindings.actionFor(KEY_CHORD) !== undefined) return
      reentered = true
      replacement = service.registerKeybinding({ id: 'reentrant', key: KEY_CHORD, action: 'toggle-fullscreen' })
    })

    // ONE release of A, which re-enters and installs B.
    first.dispose()
    assert.equal(service.keybindings.actionFor(KEY_CHORD), 'toggle-fullscreen',
      'the listener-installed replacement is live')
    const live = service.keybindings.snapshot().bindings.find(entry => entry.id === 'reentrant')
    assert.equal(live?.owner, oldOwner, 'the replacement belongs to the same owner')
    const health = slotHealth(service, 'keybinding', 'reentrant')
    assert.equal(health.length, 1, 'the replacement owns exactly ONE health record')
    assert.equal(health[0]?.state, 'active', 'the tail of the OLD release never untracks the replacement health')

    // A repeated release of the OLD handle cannot undo the replacement.
    first.dispose()
    assert.equal(service.keybindings.actionFor(KEY_CHORD), 'toggle-fullscreen')
    assert.equal(slotHealth(service, 'keybinding', 'reentrant').length, 1)

    replacement?.dispose()
    unsubscribe()
    assert.equal(service.keybindings.actionFor(KEY_CHORD), undefined)
    assert.equal(slotHealth(service, 'keybinding', 'reentrant').length, 0)
    await owner.unload()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('the theme unload hook fires exactly once per theme registration', async () => {
  const ctx = new Context()
  try {
    await mountLifecycleHost(ctx)
    const owner = await mountServiceOwner(ctx)
    const service = owner.service

    // A RELEASED hook is never called: disposing a theme with no selection and
    // no hook consumer stays safe.
    const releaseAbsent = service.setThemeUnloadedHook(() => {
      throw new Error('a released theme unload hook must never run')
    })
    releaseAbsent()
    service.registerTheme({ id: 'hook-absent', name: 'Hook absent', palette: SAMPLE_PALETTE }).dispose()

    const unloaded: { selectableValue: string; name: string }[] = []
    const releaseHook = service.setThemeUnloadedHook(entry => {
      unloaded.push(entry)
    })
    const first = service.registerTheme({ id: 'hook-theme', name: 'Hook A', palette: SAMPLE_PALETTE })
    first.dispose()
    assert.deepEqual(unloaded, [{ selectableValue: 'plugin:root/hook-theme', name: 'Hook A' }],
      'the first release notifies exactly once, with the source-qualified value')

    const second = service.registerTheme({ id: 'hook-theme', name: 'Hook B', palette: SAMPLE_PALETTE })
    first.dispose()
    first.dispose()
    assert.equal(unloaded.length, 1, 'a repeated old release never re-notifies')
    assert.equal(service.themes.displayNameForSelectable('plugin:root/hook-theme'), 'Hook B',
      'the replacement keeps the same selectable identity')
    const healthB = slotHealth(service, 'theme', 'hook-theme')
    assert.equal(healthB.length, 1)
    assert.equal(healthB[0]?.state, 'active')

    second.dispose()
    assert.equal(unloaded.length, 2, 'the replacement release notifies exactly once')
    assert.deepEqual(unloaded[1], { selectableValue: 'plugin:root/hook-theme', name: 'Hook B' })

    // A theme left LIVE is notified exactly once by the fiber cleanup.
    service.registerTheme({ id: 'hook-live', name: 'Hook live', palette: SAMPLE_PALETTE })
    await owner.unload()
    assert.equal(unloaded.length, 3, 'the fiber cleanup notifies the still-live theme exactly once')
    assert.deepEqual(unloaded[2], { selectableValue: 'plugin:root/hook-live', name: 'Hook live' })
    releaseHook()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('an owner unload and a stale-fiber rollback leave no record or health ghost (six Stable slots)', async () => {
  const ctx = new Context()
  try {
    await mountLifecycleHost(ctx)

    // (a) Register only, never release, then unload the owner fiber: every
    // slot disappears with its health; the theme hook notified once.
    const unloadedThemes: { selectableValue: string; name: string }[] = []
    const releaseHook = (ctx.get(PI_TUI_EXTENSIONS_SERVICE) as unknown as LifecycleService)
      .setThemeUnloadedHook(entry => unloadedThemes.push(entry))
    const live = await mountServiceOwner(ctx)
    for (const probe of SLOT_PROBES) {
      probe.register(live.service, `unload-${probe.key}`, 'A', { fail: false })
    }
    for (const probe of SLOT_PROBES) {
      assert.equal(probe.live(live.service, `unload-${probe.key}`)?.label, probe.recordMarker('A'),
        `${probe.slot}: the registration is live before the unload`)
      assert.equal(slotHealth(live.service, probe.slot, `unload-${probe.key}`).length, 1)
    }
    await live.unload()
    for (const probe of SLOT_PROBES) {
      assert.equal(probe.live(live.service, `unload-${probe.key}`), undefined,
        `${probe.slot}: the owner unload removes the record`)
      assert.equal(slotHealth(live.service, probe.slot, `unload-${probe.key}`).length, 0,
        `${probe.slot}: the owner unload removes the health`)
    }
    assert.equal(unloadedThemes.length, 1, 'the unloaded theme notifies the hook exactly once')
    releaseHook()

    // (b) A STALE scoped service (its owner fiber is gone) must fail loudly and
    // roll the half-registration back, leaving the id free for a new fiber.
    const staleOwner = await mountServiceOwner(ctx)
    await staleOwner.unload()
    for (const probe of SLOT_PROBES) {
      const id = `stale-${probe.key}`
      assert.throws(
        () => probe.register(staleOwner.service, id, 'A', { fail: false }),
        /inactive context|INACTIVE_EFFECT|already disposed/i,
        `${probe.slot}: a stale scoped service must fail loudly`,
      )
      assert.equal(probe.live(staleOwner.service, id), undefined,
        `${probe.slot}: the failed stale registration leaves no registry ghost`)
      assert.equal(slotHealth(staleOwner.service, probe.slot, id).length, 0,
        `${probe.slot}: the failed stale registration leaves no health ghost`)
    }

    const fresh = await mountServiceOwner(ctx)
    for (const probe of SLOT_PROBES) {
      const registration = probe.register(fresh.service, `stale-${probe.key}`, 'B', { fail: false })
      assert.equal(probe.live(fresh.service, `stale-${probe.key}`)?.label, probe.recordMarker('B'),
        `${probe.slot}: a new live fiber registers the same id successfully`)
      assert.equal(slotHealth(fresh.service, probe.slot, `stale-${probe.key}`).length, 1)
      registration.dispose()
    }
    await fresh.unload()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('a late release from an unloaded fiber never removes a new fiber’s replacement (HMR)', async () => {
  const ctx = new Context()
  try {
    await mountLifecycleHost(ctx)
    const unloaded: { selectableValue: string; name: string }[] = []
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as unknown as LifecycleService
    const releaseHook = service.setThemeUnloadedHook(entry => unloaded.push(entry))

    // The plugin's FIRST generation registers a theme and a keybinding.
    const previous = await mountServiceOwner(ctx, 'hmr-plugin')
    const themeA = previous.service.registerTheme({ id: 'hmr-theme', name: 'HMR A', palette: SAMPLE_PALETTE })
    const bindingA = previous.service.registerKeybinding({
      id: 'hmr-binding',
      key: KEY_CHORD,
      action: 'open-search',
    })
    assert.equal(service.themes.selectableValues().includes('plugin:hmr-plugin/hmr-theme'), true)
    await previous.unload()
    assert.deepEqual(unloaded, [{ selectableValue: 'plugin:hmr-plugin/hmr-theme', name: 'HMR A' }],
      'the first generation’s unload notifies the hook exactly once')

    // The reloaded generation (SAME plugin name, NEW fiber/owner) registers the
    // same ids: the source-qualified selectable value is stable across HMR.
    const reloaded = await mountServiceOwner(ctx, 'hmr-plugin')
    const themeB = reloaded.service.registerTheme({ id: 'hmr-theme', name: 'HMR B', palette: SAMPLE_PALETTE })
    reloaded.service.registerKeybinding({ id: 'hmr-binding', key: KEY_CHORD, action: 'toggle-fullscreen' })
    const ownerB = service.themes.snapshot().themes.find(entry => entry.id === 'hmr-theme')?.owner
    assert.ok(ownerB !== undefined)
    assert.equal(service.themes.displayNameForSelectable('plugin:hmr-plugin/hmr-theme'), 'HMR B')
    assert.equal(service.keybindings.actionFor(KEY_CHORD), 'toggle-fullscreen')

    // The LATE releases of the OLD generation's handles.
    themeA.dispose()
    bindingA.dispose()
    assert.equal(service.themes.displayNameForSelectable('plugin:hmr-plugin/hmr-theme'), 'HMR B',
      'the late old theme release never removes the reloaded theme')
    assert.equal(service.keybindings.actionFor(KEY_CHORD), 'toggle-fullscreen',
      'the late old keybinding release never removes the reloaded binding')
    assert.equal(unloaded.length, 1, 'the late old release never re-notifies the theme hook')
    for (const [slot, id] of [['theme', 'hmr-theme'], ['keybinding', 'hmr-binding']] as const) {
      const health = slotHealth(service, slot, id)
      assert.equal(health.length, 1, `${slot}: the reloaded registration keeps exactly ONE health record`)
      assert.equal(health[0]?.owner, ownerB, `${slot}: the health belongs to the reloaded owner`)
      assert.equal(health[0]?.state, 'active')
    }

    themeB.dispose()
    await reloaded.unload()
    assert.equal(unloaded.length, 2, 'the reloaded theme notifies the hook exactly once on release')
    assert.equal(service.themes.hasSelectable('plugin:hmr-plugin/hmr-theme'), false)
    assert.equal(slotHealth(service, 'theme', 'hmr-theme').length, 0)
    assert.equal(slotHealth(service, 'keybinding', 'hmr-binding').length, 0)
    releaseHook()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})
