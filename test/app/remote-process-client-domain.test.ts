/**
 * M4-B2-S §9 — the shared official Client Domain mount on a REAL Cordis Client
 * Context.
 *
 * This suite proves the Domain-ONLY ownership contract introduced for the split
 * Client:
 *
 * - `mountRemoteClientDomains` mounts the generated `/remote` contributions,
 *   the private pi-tui contribution and the official fileUpload -> Sessions ->
 *   Jobs plugins on the caller's ONE Context, and returns the caller's SAME
 *   Context/Connection objects;
 * - it never creates or disposes the Context, Typert, Connection or Gateway;
 * - a second Domain mount on the same Context is refused instead of creating a
 *   duplicate owner set;
 * - `dispose()` releases exactly the Domains and contributions in reverse and
 *   leaves the transport graph live.
 *
 * EVIDENCE LEVEL: L5 (real official Client runtime over the in-process Host
 * carrier). This is NOT the real split-process qualification — the installed
 * two-PID lane is `scripts/split-process-smoke.mjs`.
 *
 * @module @xmoon76/dsh-pi-tui/remote-process-client-domain.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, RegistryService, symbols, type Fiber } from '@deepseek-ai/cordis'
import type { InProcessHostCarrier } from '../../src/app/remote/host-runtime.ts'
import { createRemoteHostRuntime } from '../../src/app/remote/host-runtime.ts'
import {
  loadOfficialClientModulesOnce,
  mountRemoteClientDomains,
  type MountedRemoteClientDomains,
} from '../../src/app/remote/client-runtime.ts'
import { createRemoteApplicationHostFixture, testLifecycle } from '../support/remote-application-fixture.ts'

const PRESET = 'm4-b2-s-domain-preset'

/** Unwrap a Cordis traceable service proxy to its implementation. */
function unwrapService(value: unknown): unknown {
  const original = (value as Record<symbol, unknown>)[symbols.original]
  return original ?? value
}

/**
 * Build the caller-owned official Client transport graph exactly the way a
 * real Client process does (Typert -> Connection over the caller's carrier ->
 * Gateway), WITHOUT creating any Domain service.
 */
async function createClientTransportGraph(carrier: InProcessHostCarrier): Promise<Context> {
  const modules = await loadOfficialClientModulesOnce()
  const context = new Context()
  await context.plugin(modules.typert)
  await context.plugin(connectionContext => {
    modules.connection.installConnection(connectionContext, {
      interactions: 'answer',
      transport: {
        ownsHost: true,
        fetch: carrier.fetch,
        openStream: carrier.openStream,
      },
    })
  })
  await context.plugin(modules.gateway)
  return context
}

test('the shared Domain mount owns exactly the Domains on the caller Context and refuses a duplicate mount', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, PRESET)
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const context = await createClientTransportGraph(hostRuntime.carrier)
  let mounted: MountedRemoteClientDomains | undefined
  try {
    const connectionBefore = context.get('connection')
    assert.notEqual(connectionBefore, undefined, 'the caller installed the official Connection')
    assert.equal(context.reflect.get('sessions'), undefined, 'the caller must NOT have mounted the Session Client')
    assert.equal(context.reflect.get('jobs'), undefined, 'the caller must NOT have mounted the Jobs Client')

    mounted = await mountRemoteClientDomains({ context })
    assert.ok(Object.is(mounted.context, context), 'the mount returns the caller Context by identity')
    assert.equal(unwrapService(mounted.connection), unwrapService(connectionBefore),
      'the mount returns the caller Connection by identity (never a second transport)')
    assert.equal(unwrapService(mounted.remote), unwrapService(context.get('remote')),
      'the mount returns the ONE official Client Remote service')

    // ONE Domain set: the official plugins are live, and the private pi-tui
    // contribution's two namespaces came from the same Remote service.
    assert.notEqual(context.reflect.get('fileUpload'), undefined)
    assert.notEqual(context.reflect.get('sessions'), undefined)
    assert.notEqual(context.reflect.get('jobs'), undefined)
    assert.equal(mounted.sessions.list.getSnapshot().phase, 'ready', 'the mount awaited the official Client readiness')
    const privateRemote = mounted.remote as unknown as {
      readonly piTuiFileReferences?: unknown
      readonly piTuiTerminalProgress?: unknown
    }
    assert.notEqual(privateRemote.piTuiFileReferences, undefined, 'the private PiFile namespace is mounted')
    assert.notEqual(privateRemote.piTuiTerminalProgress, undefined, 'the private terminal-progress namespace is mounted')
    // Host-side services are never present in a Client Context.
    assert.equal(context.reflect.get('agents'), undefined, 'no Host agents service is fabricated')
    assert.equal(context.reflect.get('agentDefaultModel'), undefined, 'no Host default-model service is fabricated')

    // A second mount would be a second owner set on the same Context: the
    // gateway must refuse the duplicate descriptors and the failed mount must
    // leave the FIRST owner set untouched.
    await assert.rejects(
      mountRemoteClientDomains({ context }),
      /already|duplicate|mounted|conflict/iu,
      'a duplicate Domain mount on the same Context must be refused',
    )
    assert.notEqual(context.reflect.get('sessions'), undefined, 'the refused duplicate left the first Session Client live')
    assert.equal(mounted.sessions.list.getSnapshot().phase, 'ready', 'the refused duplicate left the first readiness intact')

    await mounted.dispose()
    mounted = undefined
    // Only the Domains and the `/remote` contributions are released. The
    // caller's transport graph stays live until the caller disposes it.
    assert.equal(context.reflect.get('fileUpload'), undefined, 'the FileUpload Client is released')
    assert.equal(context.reflect.get('sessions'), undefined, 'the Session Client is released')
    assert.equal(context.reflect.get('jobs'), undefined, 'the Jobs Client is released')
    assert.equal(privateRemote.piTuiFileReferences, undefined, 'the private PiFile contribution is released')
    assert.equal(privateRemote.piTuiTerminalProgress, undefined, 'the private terminal-progress contribution is released')
    assert.notEqual(context.reflect.get('connection'), undefined, 'the caller Connection survives the Domain disposal')
    assert.notEqual(context.reflect.get('remote'), undefined, 'the caller Gateway survives the Domain disposal')
    assert.notEqual(context.reflect.get('typert'), undefined, 'the caller Typert registry survives the Domain disposal')
  } finally {
    if (mounted !== undefined) await mounted.dispose()
    await context.fiber.dispose()
    await hostRuntime.dispose()
    await host.dispose()
  }
})

test('the shared Domain mount unwinds its own partial composition when a Domain plugin fails', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, PRESET)
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const context = await createClientTransportGraph(hostRuntime.carrier)
  try {
    const modules = await loadOfficialClientModulesOnce()
    // Poison exactly the Jobs Client plugin (the last mount). The earlier
    // contributions/fileUpload/Sessions must unwind; the caller's transport
    // graph must stay live so the caller can retire it itself.
    // The official gateway installs Domain services through `ctx.plugin`, which
    // resolves through the registry service (the M3 suite patches the same
    // seam). Only the Jobs module identity is poisoned; every other mount keeps
    // its real production path.
    const originalPlugin = RegistryService.prototype.plugin as unknown as (...args: unknown[]) => Fiber & PromiseLike<Fiber>
    let injected = false
    RegistryService.prototype.plugin = function (this: unknown, plugin: unknown, ...args: unknown[]): Fiber & PromiseLike<Fiber> {
      if (!injected && plugin === modules.jobs) {
        injected = true
        return originalPlugin.call(this, {
          apply() { throw new Error('induced Domain plugin startup failure') },
        }, ...args)
      }
      return originalPlugin.call(this, plugin, ...args)
    }
    try {
      await assert.rejects(
        mountRemoteClientDomains({ context }),
        /induced Domain plugin startup failure/u,
      )
    } finally {
      RegistryService.prototype.plugin = originalPlugin
    }
    assert.equal(context.reflect.get('fileUpload'), undefined, 'the partial FileUpload Client unwound')
    assert.equal(context.reflect.get('sessions'), undefined, 'the partial Sessions Client unwound')
    assert.notEqual(context.reflect.get('connection'), undefined, 'the caller Connection survives the failed mount')
    assert.notEqual(context.reflect.get('remote'), undefined, 'the caller Gateway survives the failed mount')
  } finally {
    await context.fiber.dispose()
    await hostRuntime.dispose()
    await host.dispose()
  }
})
