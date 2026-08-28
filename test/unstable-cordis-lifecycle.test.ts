/**
 * Phase 3 tests (plan §16): the UNSTABLE facade's caller-fiber ownership —
 * raw captures and low-level mounts are disposed on owner unload, the
 * facade works before any surface exists, and the emergency fail-safe
 * releases every capture and mount.
 * @module @xmoon76/dsh-pi-tui/unstable-cordis-lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { PI_TUI_EXTENSIONS_SERVICE } from '../src/extensions.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import { apply as applyExtensionHost } from '../src/extensions.ts'
import { unstable } from '../src/extension/unstable.ts'
import { UNSTABLE_API_LEVEL } from '../src/extension/unstable.ts'

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

/** The live unstable raw captures (id → mode), or null when unavailable. */
function captures(ctx: Context): Record<string, string> | null {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as
    | { unstableInputs: { snapshot(): { captures: Array<{ id: string; mode: string }> } } }
    | undefined
  if (service === undefined) return null
  const out: Record<string, string> = {}
  for (const record of service.unstableInputs.snapshot().captures) out[record.id] = record.mode
  return out
}

test('UNSTABLE_API_LEVEL is 1 (the Phase-3 contract)', () => {
  assert.equal(UNSTABLE_API_LEVEL, 1)
})

test('unstable facade: raw captures are caller-fiber-owned (owner unload removes exactly them)', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await mount(ctx, startupPlugin)
    await mount(ctx, applyExtensionHost)

    const pluginB = await mount(ctx, (ctx) => {
      const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
      const ui = unstable(service)
      ui.input.captureRaw({ id: 'b1', mode: 'capture', handle: () => undefined })
      ui.input.captureRaw({ id: 'b2', mode: 'observe', handle: () => undefined })
    })
    const pluginC = await mount(ctx, (ctx) => {
      const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
      unstable(service).input.captureRaw({ id: 'c1', mode: 'capture', handle: () => undefined })
    })
    await settle()
    assert.deepEqual(captures(ctx), { b1: 'capture', b2: 'observe', c1: 'capture' })

    await pluginB()
    await settle()
    assert.deepEqual(captures(ctx), { c1: 'capture' }, 'unload B must remove exactly B')

    const pluginB2 = await mount(ctx, (ctx) => {
      const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
      unstable(service).input.captureRaw({ id: 'b1', mode: 'capture', handle: () => undefined })
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

test('unstable facade: a second exclusive raw capture across owners is an explicit error', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await mount(ctx, startupPlugin)
    await mount(ctx, applyExtensionHost)

    await mount(ctx, (ctx) => {
      const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
      unstable(service).input.captureRaw({ id: 'ex1', mode: 'exclusive', handle: () => undefined })
    })
    await settle()
    await assert.rejects(
      mount(ctx, (ctx) => {
        const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
        unstable(service).input.captureRaw({ id: 'ex2', mode: 'exclusive', handle: () => undefined })
      }),
      /exclusive unstable raw capture conflict/,
    )
    assert.deepEqual(captures(ctx), { ex1: 'exclusive' })
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('unstable facade: the emergency fail-safe releases every capture and mount', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await mount(ctx, startupPlugin)
    await mount(ctx, applyExtensionHost)

    const plugin = await mount(ctx, (ctx) => {
      const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
      const ui = unstable(service)
      ui.input.captureRaw({ id: 'a', mode: 'capture', handle: () => undefined })
      ui.input.captureRaw({ id: 'b', mode: 'exclusive', handle: () => undefined })
      // A low-level mount (inert without a surface, but the lease is
      // tracked for the fail-safe).
      const handle = ui.surface.handle
      handle.mountComponent({ render: () => ['x'] })
    })
    await settle()
    assert.deepEqual(captures(ctx), { a: 'capture', b: 'exclusive' })
    // The Host emergency release (the app's fail-safe path).
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as { _unstableEmergencyRelease(): void }
    service._unstableEmergencyRelease()
    await settle()
    assert.deepEqual(captures(ctx), {}, 'the fail-safe released every capture')
    // The fiber disposer then no-ops (idempotent).
    await plugin()
    await settle()
    assert.deepEqual(captures(ctx), {})
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('unstable facade: registration works before any surface exists; the surface handle is inert', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await mount(ctx, startupPlugin)
    await mount(ctx, applyExtensionHost)

    const plugin = await mount(ctx, (ctx) => {
      const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as never
      const ui = unstable(service)
      ui.input.captureRaw({ id: 'pre', mode: 'capture', handle: () => undefined })
      // No surface is mounted: the handle is inert but every method is
      // safe.
      const handle = ui.surface.handle
      assert.equal(handle.surfaceId, 'inert')
      handle.requestRender()
      const lease = handle.mountComponent({ render: () => ['x'] })
      lease.focus()
      lease.blur()
      lease.invalidate()
      lease.hide()
      lease.show()
      lease.close()
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
