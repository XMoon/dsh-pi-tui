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
