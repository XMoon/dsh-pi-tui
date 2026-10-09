/**
 * The PRODUCTION-level acquisition / handoff / cancellation guards.
 *
 * Everything here runs the REAL composition root (`mountRunner` → `applyRunner`
 * → `startRunner`) with the TSP opt-in over the scripted pane installed as the
 * process tty, so the shipped SDK `connect`, `productionTspConnector`,
 * `selectRendererMount`, `SurfaceRuntime`, `SurfaceLifecycle`, `ExitController`
 * and the runner's fatal path all execute for real. Only the tty boundary is
 * simulated; the Cordis fiber unload is the real HMR disposal. These lock the
 * acquisition-stage ownership and failure propagation that the lifecycle-level
 * helpers cannot see.
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

interface Boot {
  readonly dispose: () => Promise<void>
}

/** Boot the REAL runner with the opt-in over the scripted pane. */
async function bootRunner(options: {
  readonly home: string
  readonly logFile: string
  readonly pane: TspPane
  readonly appExit: () => void
  /** Extra services the harness does not provide (e.g. a failing port). */
  readonly provide?: (ctx: { provide(name: string, value: unknown): void }) => void
}): Promise<Boot> {
  const { Context } = await import('@deepseek-ai/cordis')
  const { makeHarness, mountRunner, disposeContext } = await import('./support/runner-harness.ts')
  const harness = makeHarness(options.home)
  process.env.DSH_PI_TUI_RENDERER = 'tsp'
  process.env.DSH_PI_TUI_LOG = options.logFile
  const ctx = new Context()
  options.provide?.(ctx)
  const fiber = await mountRunner(ctx, options.home, harness, {}, {}, options.appExit)
  return {
    dispose: async () => {
      await disposeContext(ctx)
      await fiber.dispose()
    },
  }
}

test('TSP runner: a queued Ctrl+C in the handshake batch exits with the tty restored and no fatal', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3a-tsp-runner-')
  const logFile = join(home, 'diag.log')
  const pane = installTspPane()
  life.defer(() => { pane.restore() })

  // The legal quit intent (Ctrl+C) is decoded from the SAME read as the hello
  // reply: the SDK owns the tty before the application ownership transfer.
  pane.queueWithHandshake('\u0003')

  const order: string[] = []
  let rawAtExit: boolean | undefined
  const boot = await bootRunner({
    home,
    logFile,
    pane,
    appExit: () => {
      order.push('appExit')
      rawAtExit = pane.input.raw.at(-1)
    },
  })
  try {
    const log = readFileSync(logFile, 'utf8')
    assert.ok(pane.probed(), `the shipped SDK connected over the installed pane (log: ${log.slice(0, 700)})`)
    await waitUntil('the exit to complete', () => order.includes('appExit'))
    assert.equal(pane.closeFrames(), 1, 'the acquired session was closed exactly ONCE')
    assert.equal(rawAtExit, false, 'raw mode was restored BEFORE hint/appExit')
    assert.ok(!log.includes('fatal'), `no startup fatal on a legal cancellation (log: ${log.slice(0, 400)})`)
    assert.ok(!log.includes('mounting PiTui'), 'the cancellation never fell back to PiTui')
  } finally {
    await boot.dispose()
  }
})

test('TSP runner: a real PRE-SELECTION failure completes the fatal teardown (no stage without a producer)', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3a-tsp-preselect-')
  const logFile = join(home, 'diag.log')
  const pane = installTspPane()
  life.defer(() => { pane.restore() })

  let exits = 0
  const { Context } = await import('@deepseek-ai/cordis')
  const { makeHarness, mountRunner, disposeContext } = await import('./support/runner-harness.ts')
  // A REAL pre-selection failure that runs AFTER the surface lifecycle exists: the
  // extension host attach reads the service's ledger FIRST, so an extension
  // service whose ledger throws fails the composition before the renderer attempt.
  const harness = makeHarness(home)
  process.env.DSH_PI_TUI_RENDERER = 'tsp'
  process.env.DSH_PI_TUI_LOG = logFile
  const ctx = new Context()
  ctx.provide('piTuiExtensions', {
    _ledger: () => { throw new Error('injected extension attach failure') },
    // The teardown path also detaches the surface from the service: keep the
    // fake complete so the failure under test stays the ONLY failure.
    detachSurface: () => {},
  })
  const fiber = await mountRunner(ctx, home, harness, {}, {}, () => { exits += 1 })
  try {
    try {
      await waitUntil('the fatal teardown to finish', () => exits > 0)
    } catch {
      throw new Error(`the fatal never completed — log: ${readFileSync(logFile, 'utf8').slice(0, 900)}`)
    }
    const log = readFileSync(logFile, 'utf8')
    assert.ok(log.includes('injected extension attach failure'),
      `the real pre-selection failure reached the fatal path (log: ${log.slice(0, 400)})`)
    assert.ok(!log.includes('the surface is not mounted'),
      'the pre-mount teardown never read an unmounted surface')
    assert.ok(!log.includes('TSP renderer disposal'),
      'a pre-attempt failure never produced an acquisition release attempt')
    assert.equal(pane.probed(), false, 'the renderer attempt never started (connector calls: 0)')
  } finally {
    await disposeContext(ctx)
    await fiber.dispose()
  }
})

test('TSP runner: a real fiber unload during a HELD handshake waits for the acquired renderer', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3a-tsp-hmr-')
  const logFile = join(home, 'diag.log')
  const pane = installTspPane()
  life.defer(() => { pane.restore() })
  pane.holdHandshake()

  const { Context } = await import('@deepseek-ai/cordis')
  const { makeHarness, mountRunner, disposeContext } = await import('./support/runner-harness.ts')
  const harness = makeHarness(home)
  process.env.DSH_PI_TUI_RENDERER = 'tsp'
  process.env.DSH_PI_TUI_LOG = logFile
  const ctx = new Context()
  const fiber = await mountRunner(ctx, home, harness, {}, {}, () => {})
  await waitUntil('the SDK probe', () => pane.probed())

  // The REAL HMR disposal while the handshake is held: the old disposer must not
  // complete before the acquired renderer is released.
  let disposalSettled = false
  const disposal = (async () => {
    await disposeContext(ctx)
    await fiber.dispose()
  })().then(() => { disposalSettled = true })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(disposalSettled, false, 'the disposer WAITS for the held handshake')
  assert.equal(pane.closeFrames(), 0, 'nothing was released yet')

  pane.releaseHandshake()
  await disposal
  assert.equal(pane.closeFrames(), 1, 'the acquired renderer was released exactly ONCE after the handshake')
  assert.ok(!readFileSync(logFile, 'utf8').includes('fatal'), 'the unload is not a startup fatal')
})

test('TSP runner: a held handshake that DECLINES after a fiber unload never starts PiTui', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3a-tsp-decline-')
  const logFile = join(home, 'diag.log')
  const pane = installTspPane()
  life.defer(() => { pane.restore() })
  pane.holdHandshake()

  const { Context } = await import('@deepseek-ai/cordis')
  const { makeHarness, mountRunner, disposeContext } = await import('./support/runner-harness.ts')
  const { liveTuiCountForTest } = await import('../src/tui/process-slot.ts')
  const harness = makeHarness(home)
  process.env.DSH_PI_TUI_RENDERER = 'tsp'
  process.env.DSH_PI_TUI_LOG = logFile
  const ctx = new Context()
  const fiber = await mountRunner(ctx, home, harness, {}, {}, () => {})
  await waitUntil('the SDK probe', () => pane.probed())

  const disposal = (async () => {
    await disposeContext(ctx)
    await fiber.dispose()
  })()
  pane.decline() // the SDK gets no reply: it declines after its own timeout
  await disposal
  const log = readFileSync(logFile, 'utf8')
  assert.equal(pane.closeFrames(), 0, 'a declined handshake owns no session to close')
  assert.equal(liveTuiCountForTest(), 0,
    'a cancelled startup never mounted a PiTui TuiApp (the selection\'s own decline log line is not a mount)')
  assert.ok(!log.includes('fatal'), 'a cancellation is not a fatal')
})

test('TSP runner: an acquired release failure reaches the ROOT cleanup outcome (Error)', async (t) => {
  await assertAcquiredReleaseFailure(t, new Error('acquired close exploded'))
})

test('TSP runner: an acquired release rejecting `undefined` is STILL a root cleanup failure', async (t) => {
  await assertAcquiredReleaseFailure(t, undefined)
})

/**
 * Drive the real cancellation path with the SDK's `x` close write failing: the
 * acquired tty owner is never released, so the published teardown transaction
 * must reject — the ROOT records the cleanup failure, not just a leaf warning.
 */
async function assertAcquiredReleaseFailure(
  t: { readonly name: string },
  failure: unknown,
): Promise<void> {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t as never)
  const home = life.tempDir('pr3a-tsp-release-')
  const logFile = join(home, 'diag.log')
  const pane = installTspPane()
  life.defer(() => { pane.restore() })
  pane.failCloseWrite(failure)
  pane.queueWithHandshake('\u0003')

  const order: string[] = []
  const boot = await bootRunner({ home, logFile, pane, appExit: () => { order.push('appExit') } })
  try {
    await waitUntil('the exit to complete', () => order.includes('appExit'))
    const log = readFileSync(logFile, 'utf8')
    assert.ok(log.includes('tsp renderer: release failed after a cancelled startup'),
      `the leaf diagnostic records the failed acquired release (log: ${log.slice(0, 700)})`)
    assert.ok(log.includes('cleanup failed'),
      'the ROOT cleanup failure is observed — the shared outcome rejected instead of reporting success')
    assert.ok(!log.includes('fatal'), 'a cancellation is not a startup fatal')
  } finally {
    await boot.dispose()
  }
}
