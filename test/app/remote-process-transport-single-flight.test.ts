/**
 * RFL-013A: the ONE B1 transport disposal is single-flight on its RESULT.
 *
 * The exit root's early release (the confirmed whole-Host Stop path), the
 * surface handle teardown and the startup-failure unwind can all call
 * `dispose()` on the SAME transport. A later call must await the FIRST unwind
 * and observe the SAME failure: the old boolean latch returned success to
 * every caller after the first, so a real `cleanupFailed` could be silently
 * lost exactly when the process was about to report its exit code.
 *
 * This suite installs the REAL transport composition over a structural module
 * set (no real DSH installation, no live Host, no wire) and injects ONE
 * failure into the real unwind step (the Fiber-disposal diagnostics sink
 * throws). The injected fault is a test vehicle only; the contract under test
 * is the real collection/rejection/share path.
 *
 * EVIDENCE LEVEL: component contract (L2). The real Client exit paths and the
 * packed split-process lane prove the OS-level behaviour.
 *
 * @module @xmoon76/dsh-pi-tui/remote-process-transport-single-flight.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'

import { installLocalTransport } from '../../src/app/remote-process/local-transport.ts'
import type { LocalInstanceRecord } from '../../src/app/remote-process/local-discovery.ts'
import { LOCAL_PROTOCOL } from '../../src/app/remote-process/local-scope.ts'
import type { LocalScope } from '../../src/app/remote-process/local-scope.ts'

const HOST_RECORD = {
  scopeId: 'scope',
  profileRealpath: '/profile',
  instanceId: 'instance',
  hostPid: 1,
  hostStarttime: '1',
  origin: 'http://127.0.0.1:1',
  protocol: LOCAL_PROTOCOL as typeof LOCAL_PROTOCOL,
  bundleVersion: '0.5.4',
  dshVersion: '0.2.1-rc.4',
  buildId: 'build',
} as LocalInstanceRecord

const HOST = { record: HOST_RECORD, identity: HOST_RECORD, cookie: 'cookie=1' } as never
const SCOPE = { dir: '/scope', profileRealpath: '/profile' } as unknown as LocalScope

const QUIET_DIAG = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never

/** The structural module set the real composition installs instead of DSH. */
function structuralModules() {
  const generation = {
    getSnapshot: () => ({ id: 1, host: { home: '/host' } }),
    subscribe: () => () => {},
  }
  return {
    typert: { apply: () => {} },
    connection: {
      apply: () => {},
      installConnection: (ctx: Context) => {
        ctx.provide('connection', {
          state: { getSnapshot: () => 'connected' as const },
          generation,
          reconnect: () => {},
        })
      },
    },
    gateway: { apply: () => {} },
  }
}

/**
 * Install the REAL transport composition. `failingDiag` makes the real
 * unwind's Fiber-disposal step reject, which the real unwind collects into the
 * transport's own `cleanupFailed` rejection.
 */
async function installTransport(failingDiag: boolean) {
  const context = new Context()
  const handle = await installLocalTransport(context, {
    dshAnchor: '/nonexistent-anchor',
    modulesOverride: structuralModules() as never,
    host: HOST,
    scope: SCOPE,
    diag: (failingDiag
      ? { info: () => {}, warn: () => {}, error: () => {}, debug: () => { throw new Error('injected unwind failure') } }
      : QUIET_DIAG) as never,
  })
  return { handle, context }
}

test('a later dispose observes the SAME cleanup failure as the early release', async () => {
  const { handle, context } = await installTransport(true)
  const first = await handle.dispose().then(() => undefined, error => error as Error & { cleanupFailed?: boolean })
  assert.ok(first instanceof Error, 'the early release (exit root) must surface the unwind failure')
  assert.equal(first.cleanupFailed, true)
  const second = await handle.dispose().then(() => undefined, error => error as Error)
  assert.ok(second instanceof Error, 'the later process-root teardown must not report success over that failure')
  assert.equal(second, first, 'both callers observe the identical rejection')
  await context.fiber.dispose()
})

test('concurrent callers of the same disposal settle on one shared outcome', async () => {
  const { handle, context } = await installTransport(true)
  const [early, teardown] = await Promise.all([
    handle.dispose().then(() => undefined, error => error as Error),
    handle.dispose().then(() => undefined, error => error as Error),
  ])
  assert.ok(early instanceof Error && teardown instanceof Error)
  assert.equal(early, teardown, 'the disposal is one shared settlement, not first-wins')
  await context.fiber.dispose()
})

test('a clean disposal is shared too, and stays success on every later call', async () => {
  const { handle, context } = await installTransport(false)
  await assert.doesNotReject(handle.dispose())
  await assert.doesNotReject(handle.dispose())
  await context.fiber.dispose()
})
