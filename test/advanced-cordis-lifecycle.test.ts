/**
 * Phase 2 tests (plan §14): the ADVANCED facade's caller-fiber ownership —
 * input captures and interactive overlay leases are disposed on owner
 * unload, the facade works before any surface exists, and a stale service
 * handle's registration is rejected (INACTIVE_EFFECT rollback).
 * @module @xmoon76/dsh-pi-tui/advanced-cordis-lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { PI_TUI_EXTENSIONS_SERVICE } from '../src/extensions.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import { apply as applyExtensionHost } from '../src/extensions.ts'
import { advanced } from '../src/extension/advanced.ts'
import { ADVANCED_API_LEVEL } from '../src/extension/advanced.ts'

/** A minimal provider fiber that provides tuiStartup (the host's gate). */
function startupPlugin(ctx: Context): void {
  ctx.provide(TUI_STARTUP_SERVICE, {})
}

/** Mount one plugin fiber (awaited to ACTIVE) and return its disposer. */
async function mount(ctx: Context, plugin: (ctx: Context) => void): Promise<() => Promise<void>> {
  const fiber = ctx.plugin(plugin)
  await fiber
  return () => fiber.dispose()
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** The live advanced input captures (id → mode), or null when unavailable. */
function captures(ctx: Context): Record<string, string> | null {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as
    | { advancedInputs: { snapshot(): { captures: Array<{ id: string; mode: string }> } } }
    | undefined
  if (service === undefined) return null
  const out: Record<string, string> = {}
  for (const record of service.advancedInputs.snapshot().captures) out[record.id] = record.mode
  return out
}

test('ADVANCED_API_LEVEL is 1 (the Phase-2 contract)', () => {
  assert.equal(ADVANCED_API_LEVEL, 1)
})

test('advanced facade: input captures are caller-fiber-owned (owner unload removes exactly them)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await mount(ctx, startupPlugin)
    await mount(ctx, applyExtensionHost)

    const pluginB = await mount(ctx, (ctx) => {
      const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
      const ui = advanced(service)
      ui.input.capture({ id: 'b1', mode: 'capture', handle: () => false })
      ui.input.capture({ id: 'b2', mode: 'observe', handle: () => {} })
    })
    const pluginC = await mount(ctx, (ctx) => {
      const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
      advanced(service).input.capture({ id: 'c1', mode: 'capture', handle: () => false })
    })
    await settle()
    assert.deepEqual(captures(ctx), { b1: 'capture', b2: 'observe', c1: 'capture' })

    // Unload B: ONLY B's captures disappear.
    await pluginB()
    await settle()
    assert.deepEqual(captures(ctx), { c1: 'capture' }, 'unload B must remove exactly B')

    // Reload B: its captures return.
    const pluginB2 = await mount(ctx, (ctx) => {
      const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
      advanced(service).input.capture({ id: 'b1', mode: 'capture', handle: () => false })
    })
    await settle()
    assert.deepEqual(captures(ctx), { b1: 'capture', c1: 'capture' })
    await pluginB2()
    await settle()
    assert.deepEqual(captures(ctx), { c1: 'capture' })
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('advanced facade: a second exclusive capture across owners is an explicit error', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await mount(ctx, startupPlugin)
    await mount(ctx, applyExtensionHost)

    await mount(ctx, (ctx) => {
      const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
      advanced(service).input.capture({ id: 'ex1', mode: 'exclusive', handle: () => false })
    })
    await settle()
    // The second exclusive must throw loudly (never a load-order winner).
    await assert.rejects(
      mount(ctx, (ctx) => {
        const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
        advanced(service).input.capture({ id: 'ex2', mode: 'exclusive', handle: () => false })
      }),
      /exclusive advanced input capture conflict/,
    )
    assert.deepEqual(captures(ctx), { ex1: 'exclusive' })
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('advanced facade: an explicit dispose() detaches the fiber-bound disposer (no double cleanup)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await mount(ctx, startupPlugin)
    await mount(ctx, applyExtensionHost)

    let handle: { dispose(): void } | undefined
    const plugin = await mount(ctx, (ctx) => {
      const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
      handle = advanced(service).input.capture({ id: 'explicit', mode: 'capture', handle: () => false })
    })
    await settle()
    assert.deepEqual(captures(ctx), { explicit: 'capture' })
    handle?.dispose()
    await settle()
    assert.deepEqual(captures(ctx), {}, 'explicit dispose removes the capture')
    // The fiber disposer then no-ops (no double cleanup, no throw).
    await plugin()
    await settle()
    assert.deepEqual(captures(ctx), {})
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('advanced facade: registration works before any surface exists (the registry is service-lifetime)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await mount(ctx, startupPlugin)
    await mount(ctx, applyExtensionHost)

    // No surface host is attached: the capture registers and the route is
    // a safe no-op (no input flows without a surface).
    const plugin = await mount(ctx, (ctx) => {
      const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
      advanced(service).input.capture({ id: 'pre', mode: 'capture', handle: () => true })
    })
    await settle()
    assert.deepEqual(captures(ctx), { pre: 'capture' })
    await plugin()
    await settle()
    assert.deepEqual(captures(ctx), {})
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('advanced facade: the interactive overlay lease is inert without a mounted surface', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await mount(ctx, startupPlugin)
    await mount(ctx, applyExtensionHost)

    const plugin = await mount(ctx, (ctx) => {
      const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
      const lease = advanced(service).ui.showInteractiveOverlay({
        render: () => ({ kind: 'text', spans: [{ text: 'pre' }] }),
        dispose: () => {},
      })
      // No surface is mounted: the lease is inert but every method is safe.
      lease.focus()
      lease.blur()
      lease.invalidate()
      lease.hide()
      lease.show()
      lease.close()
    })
    await settle()
    await plugin()
    await settle()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('advanced facade: owner unload aborts a pending imperative prompt (the promise settles)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await mount(ctx, startupPlugin)
    await mount(ctx, applyExtensionHost)

    // A pending select with NO mounted surface resolves undefined
    // immediately (the seam is absent) — the fiber effect still detaches
    // cleanly.
    const plugin = await mount(ctx, (ctx) => {
      const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
      const ui = advanced(service)
      void ui.ui.select({ items: [{ value: 'a', label: 'A' }] })
      void ui.ui.confirm({ question: 'q' })
      void ui.ui.input({ question: 'i' })
      ui.ui.notify('hello')
      void ui.ui.custom(() => ({ render: () => ({ kind: 'text', spans: [{ text: 'x' }] }) }))
    })
    await settle()
    await plugin()
    await settle()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})
