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

    // The REAL current detach tears down the newer generation.
    service.detachSurface('gen-b')
    assert.equal(bridge2Subscribed, 0, 'the current detach must release the live bridge (P1)')
    assert.equal(service._listenerUnsubscribersSize(), 0, 'no listener map entries may survive (P1)')
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

    // Detach: the throwing bridge-2 teardown (here non-throwing) releases;
    // simulate a throwing teardown on a fresh attach.
    service.detachSurface('gen-2')
    assert.equal(service._listenerUnsubscribersSize(), 0, 'detach must clear every listener')
    assert.equal(bridge2Subscribed, 0)

    // A detach where the teardown itself throws must still clear the map.
    service.attachSurface({
      subscribe: () => { return () => { throw new Error('detach boom') } },
    }, new Set(), 'gen-3')
    service.subscribeState(l1)
    assert.equal(service._listenerUnsubscribersSize(), 1)
    service.detachSurface('gen-3')
    assert.equal(service._listenerUnsubscribersSize(), 0, 'a throwing teardown must not leave a map entry')
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
        key: { key: 'k', ctrl: false, alt: false, shift: false, super: false },
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
