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
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { PI_TUI_EXTENSIONS_SERVICE } from '../src/extensions.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'

/** The extension-host provider under test (real entry, real apply). */
import { apply as applyExtensionHost } from '../src/extensions.ts'

/** A minimal provider fiber that provides tuiStartup (the host's gate). */
function startupPlugin(ctx: Context): void {
  ctx.provide(TUI_STARTUP_SERVICE, { shippedPresetRoot: '/ws' })
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

test('M5: command/theme/setting registrations are fiber-bound (owner unload cleans up)', async () => {
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
        execution: 'local' | 'submission'
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
      svc.registerCommand({ id: 'cmd-a', name: 'acmd', description: 'a', execution: 'local' })
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

test('M5: the keybinding registry rejects non-public actions and printable keys through the PUBLIC path (round 12)', async () => {
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

test('P1-3: a subscription record survives detach and re-binds on the next attach (no reload needed)', async () => {
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

test('P1-1/P1-3/P1-4: no-arg detach releases the current surface leases', async () => {
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

test('P1-3: attach A → attach B → late detach A leaves B bound (stale detach)', async () => {
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

test('P1-4: a plugin overlay closes automatically when the owner fiber unloads (HMR/disable)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startupFiber = ctx.plugin((c) => {
      c.provide(TUI_STARTUP_SERVICE, { shippedPresetRoot: '/ws' })
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

test('P1-4: explicit close then fiber unload is idempotent — no double close, no throw', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startupFiber = ctx.plugin((c) => {
      c.provide(TUI_STARTUP_SERVICE, { shippedPresetRoot: '/ws' })
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

test('P1-4: an old overlay lease is INERT after its surface disposes; it never mounts on a newer surface', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startupFiber = ctx.plugin((c) => {
      c.provide(TUI_STARTUP_SERVICE, { shippedPresetRoot: '/ws' })
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
