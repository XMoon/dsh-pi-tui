/**
 * The PRODUCTION-level acquisition / handoff / cancellation guards.
 *
 * Everything here runs the REAL composition root (`mountRunner` → `applyRunner`
 * → `startRunner`) with the TSP opt-in over the scripted pane installed as the
 * process tty, so the shipped SDK `connect`, `productionTspConnector`,
 * `selectRendererMount`, `SurfaceRuntime`, `SurfaceLifecycle`, `ExitController`
 * and the runner's fatal path all execute for real. Only the tty boundary (and,
 * where a case needs one, a single Host stand-in service) is simulated; the
 * Cordis fiber unload is the real HMR disposal.
 *
 * Ownership: the pane, the Cordis context and the mounted fiber are owned BEFORE
 * the boot, so ANY failure path releases a held handshake, awaits the real
 * context/fiber cleanup and only then restores the process streams/env — never
 * leaving an SDK or a held reply running after the harness is restored.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-runner-teardown.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { installTspPane, type TspPane } from './support/tsp-terminal-fixture.ts'

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

interface Owned {
  readonly pane: TspPane
  /**
   * Release any held gate, await the REAL context/fiber cleanup, then restore the
   * process streams/env. Idempotent: the happy path and the registered safety net
   * run the same ordered teardown.
   */
  readonly settle: () => Promise<void>
  /** The REAL Cordis/fiber disposal ALONE (no gate release, no restore). */
  readonly beginDisposal: () => Promise<void>
}

/** Own the pane + context + fiber BEFORE the boot, then mount the REAL runner. */
async function ownTspBoot(options: {
  readonly t: { readonly name: string }
  readonly home: string
  readonly logFile: string
  readonly sessionId?: string
  readonly resumeError?: Error
  readonly provide?: (ctx: { provide(name: string, value: unknown): void }) => void
  /** Runs with the owned pane before the connector can probe it. */
  readonly beforeMount?: (pane: TspPane) => void
  readonly appExit: () => void
}): Promise<Owned> {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(options.t as never)
  const pane = installTspPane()
  options.beforeMount?.(pane)
  const { Context } = await import('@deepseek-ai/cordis')
  const { makeHarness, mountRunner, disposeContext, fakeSession } = await import('./support/runner-harness.ts')
  const ctx = new Context()
  options.provide?.(ctx)
  process.env.DSH_PI_TUI_RENDERER = 'tsp'
  process.env.DSH_PI_TUI_LOG = options.logFile
  const session = options.sessionId === undefined
    ? undefined
    : fakeSession({
      id: options.sessionId,
      header: { id: options.sessionId, cwd: options.home, createdAt: 0, version: 1 },
      events: [],
    })
  const harness = makeHarness(
    options.home, session, undefined, undefined, undefined, undefined, undefined, undefined,
    options.resumeError,
  )
  let fiber: { dispose(): Promise<void> } | undefined
  let disposal: Promise<void> | undefined
  const beginDisposal = (): Promise<void> => {
    disposal ??= (async () => {
      await disposeContext(ctx)
      await fiber?.dispose()
    })()
    return disposal
  }
  let settled = false
  const settle = async (): Promise<void> => {
    if (settled) return
    settled = true
    pane.releaseHandshake()
    await beginDisposal().catch(() => {})
    pane.restore()
  }
  // Registered BEFORE the boot: the safety net runs the SAME ordered teardown.
  life.defer(() => { void settle() })
  fiber = await mountRunner(
    ctx, options.home, harness,
    options.sessionId === undefined ? {} : { sessionId: options.sessionId },
    {}, options.appExit,
  )
  return { pane, settle, beginDisposal }
}

test('TSP runner: a queued Ctrl+C in the handshake batch exits with the tty restored and no fatal', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const { liveTuiCountForTest } = await import('../src/tui/process-slot.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3a-tsp-runner-')
  const logFile = join(home, 'diag.log')

  const order: string[] = []
  let rawAtExit: boolean | undefined
  let paneRef: TspPane | undefined
  const owned = await ownTspBoot({
    t,
    home,
    logFile,
    // The legal quit intent (Ctrl+C) is decoded from the SAME read as the hello
    // reply: the SDK owns the tty before the application ownership transfer.
    beforeMount: pane => { paneRef = pane; pane.queueWithHandshake('\u0003') },
    appExit: () => {
      order.push('appExit')
      rawAtExit = paneRef === undefined ? undefined : paneRef.input.raw.at(-1)
    },
  })
  try {
    await waitUntil('the exit to complete', () => order.includes('appExit'))
    await owned.settle()
    // The SETTLED record — the cleanup/startup aftermath lands AFTER the request.
    const log = readFileSync(logFile, 'utf8')
    assert.ok(log.includes('tsp renderer selected'),
      `the real connector produced a renderer mount (log: ${log.slice(0, 500)})`)
    assert.equal(owned.pane.closeFrames(), 1, 'the acquired session was closed exactly ONCE')
    assert.equal(rawAtExit, false, 'raw mode was restored BEFORE hint/appExit')
    assert.ok(!log.includes('fatal'), `no startup fatal on a legal cancellation (log: ${log.slice(0, 400)})`)
    assert.equal(liveTuiCountForTest(), 0, 'a cancelled startup never created a PiTui TuiApp')
  } finally {
    await owned.settle()
  }
})

test('TSP runner: a real PRE-SELECTION failure completes the fatal teardown (no stage without a producer)', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3a-tsp-preselect-')
  const logFile = join(home, 'diag.log')

  let exits = 0
  // A REAL pre-selection failure that runs AFTER the surface lifecycle exists: the
  // extension host attach reads the service ledger FIRST, so a service whose
  // ledger throws fails the composition before the renderer attempt.
  const owned = await ownTspBoot({
    t,
    home,
    logFile,
    appExit: () => { exits += 1 },
    provide: ctx => {
      ctx.provide('piTuiExtensions', {
        _ledger: () => { throw new Error('injected extension attach failure') },
        detachSurface: () => {},
      })
    },
  })
  try {
    try {
      await waitUntil('the fatal teardown to finish', () => exits > 0)
    } catch {
      throw new Error(`the fatal never completed — log: ${readFileSync(logFile, 'utf8').slice(0, 900)}`)
    }
    await owned.settle()
    const log = readFileSync(logFile, 'utf8')
    assert.ok(log.includes('injected extension attach failure'),
      `the real pre-selection failure reached the fatal path (log: ${log.slice(0, 400)})`)
    assert.ok(!log.includes('the surface is not mounted'),
      'the pre-mount teardown never read an unmounted surface')
    assert.ok(!log.includes('TSP renderer disposal'),
      'a pre-attempt failure never produced an acquisition release attempt')
    assert.equal(owned.pane.probed(), false, 'the renderer attempt never started (connector calls: 0)')
  } finally {
    await owned.settle()
  }
})

test('TSP runner: a real fiber unload during a HELD handshake waits for the acquired renderer', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3a-tsp-hmr-')
  const logFile = join(home, 'diag.log')

  const owned = await ownTspBoot({
    t,
    home,
    logFile,
    beforeMount: pane => pane.holdHandshake(),
    appExit: () => {},
  })
  try {
    await waitUntil('the SDK probe', () => owned.pane.probed())
    // The REAL HMR disposal while the handshake is held: the old disposer must not
    // complete before the acquired renderer is released.
    let disposalSettled = false
    const disposal = owned.beginDisposal().then(() => { disposalSettled = true })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(disposalSettled, false, 'the disposer WAITS for the held handshake')
    assert.equal(owned.pane.closeFrames(), 0, 'nothing was released yet')

    owned.pane.releaseHandshake()
    await disposal
    assert.equal(owned.pane.closeFrames(), 1, 'the acquired renderer was released exactly ONCE after the handshake')
    assert.ok(!readFileSync(logFile, 'utf8').includes('fatal'), 'the unload is not a startup fatal')
  } finally {
    await owned.settle()
  }
})

test('TSP runner: a held handshake that DECLINES after a fiber unload never starts PiTui', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const { liveTuiCountForTest } = await import('../src/tui/process-slot.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3a-tsp-decline-')
  const logFile = join(home, 'diag.log')

  const owned = await ownTspBoot({
    t,
    home,
    logFile,
    beforeMount: pane => pane.holdHandshake(),
    appExit: () => {},
  })
  try {
    await waitUntil('the SDK probe', () => owned.pane.probed())
    const disposal = owned.beginDisposal()
    owned.pane.decline() // the SDK gets no reply: it declines after its own timeout
    await disposal
    assert.equal(owned.pane.closeFrames(), 0, 'a declined handshake owns no session to close')
    assert.equal(liveTuiCountForTest(), 0,
      'a cancelled startup never created a PiTui TuiApp (the selection log line is not a mount)')
    assert.ok(!readFileSync(logFile, 'utf8').includes('fatal'), 'a cancellation is not a fatal')
  } finally {
    await owned.settle()
  }
})

test('TSP runner: an acquired release failure reaches the ROOT cleanup outcome (Error)', async (t) => {
  await assertAcquiredReleaseFailure(t, new Error('acquired close exploded'))
})

test('TSP runner: an acquired release rejecting `undefined` is STILL a root cleanup failure', async (t) => {
  await assertAcquiredReleaseFailure(t, undefined)
})

/**
 * Drive the real cancellation path with the FIRST `x` close write failing: the
 * acquired tty owner's release rejects with the EXACT injected value, so the
 * published teardown transaction must reject — the ROOT records the cleanup
 * failure, not just a leaf warning.
 */
async function assertAcquiredReleaseFailure(t: { readonly name: string }, failure: unknown): Promise<void> {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t as never)
  const home = life.tempDir('pr3a-tsp-release-')
  const logFile = join(home, 'diag.log')

  const order: string[] = []
  const owned = await ownTspBoot({
    t: t as never,
    home,
    logFile,
    beforeMount: pane => {
      pane.failCloseWrite(failure)
      pane.queueWithHandshake('\u0003')
    },
    appExit: () => { order.push('appExit') },
  })
  try {
    await waitUntil('the exit to complete', () => order.includes('appExit'))
    await owned.settle()
    const log = readFileSync(logFile, 'utf8')
    assert.ok(log.includes('tsp renderer: release failed after a cancelled startup'),
      `the leaf diagnostic records the failed acquired release (log: ${log.slice(0, 700)})`)
    assert.ok(log.includes('cleanup failed'),
      'the ROOT cleanup failure is observed — the shared outcome rejected instead of reporting success')
    assert.ok(!log.includes('fatal'), 'a cancellation is not a startup fatal')
  } finally {
    await owned.settle()
  }
}
