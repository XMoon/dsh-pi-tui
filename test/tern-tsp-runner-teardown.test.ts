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
  /** The Cordis context: the official Host event plane the runner consumes. */
  readonly ctx: { emit(type: string, ...args: unknown[]): void }
  /**
   * Release any held gate, await the REAL context/fiber cleanup, then restore the
   * process streams/env. Idempotent: the happy path and the registered safety net
   * run the same ordered teardown.
   */
  readonly settle: () => Promise<void>
  /** The REAL Cordis/fiber disposal ALONE (no gate release, no restore). */
  readonly beginDisposal: () => Promise<void>
}

/**
 * Own the pane + context + fiber BEFORE the boot, then mount the REAL runner.
 * Everything is registered on the CASE's own `TestLifecycle`, so the existing
 * "every disposer runs before the temp dirs are removed" guarantee covers it.
 */
async function ownTspBoot(options: {
  readonly life: import('./support/temp-lifecycle.ts').TestLifecycle
  readonly home: string
  readonly logFile: string
  /** A standing session the runner RESUMES and owns live (the live-increment case). */
  readonly session?: { readonly id: string }
  readonly provide?: (ctx: { provide(name: string, value: unknown): void }) => void
  /** Runs with the owned pane before the connector can probe it. */
  readonly beforeMount?: (pane: TspPane) => void
  readonly appExit: () => void
}): Promise<Owned> {
  const life = options.life
  const { makeHarness, mountRunner, disposeContext } = await import('./support/runner-harness.ts')
  const pane = installTspPane()
  options.beforeMount?.(pane)
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  options.provide?.(ctx)
  process.env.DSH_PI_TUI_RENDERER = 'tsp'
  process.env.DSH_PI_TUI_LOG = options.logFile
  const harness = makeHarness(options.home, options.session as never)
  let fiber: { dispose(): Promise<void> } | undefined
  let disposal: Promise<void> | undefined
  const beginDisposal = (): Promise<void> => {
    disposal ??= (async () => {
      await disposeContext(ctx)
      await fiber?.dispose()
    })()
    return disposal
  }
  // ONE cached settlement for every caller (concurrent and repeated callers get the
  // SAME outcome, failures included — never an early "already done").
  let settlement: Promise<void> | undefined
  const settle = (): Promise<void> => {
    settlement ??= (async () => {
      pane.releaseHandshake()
      try {
        await beginDisposal()
      } finally {
        // Restore the process streams/env after the cleanup ATTEMPT, and never
        // swallow a cleanup failure: the caller (and the temp lifecycle) must see it.
        pane.restore()
      }
    })()
    return settlement
  }
  // Registered BEFORE the boot and RETURNING the real cleanup promise, so the temp
  // lifecycle AWAITS it (a disposer that starts an async chain and returns undefined
  // would let the hook finish while the SDK is still live).
  life.defer(() => settle())
  fiber = await mountRunner(
    ctx, options.home, harness,
    options.session === undefined ? {} : { sessionId: options.session.id },
    options.session === undefined ? {} : { sessionId: options.session.id },
    options.appExit,
  )
  return { pane, ctx: ctx as unknown as Owned['ctx'], settle, beginDisposal }
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
    life,
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
    assert.equal(liveTuiCountForTest(), 0,
      'no live PiTui TuiApp remains AT SETTLEMENT (a live-app count, not a "never created" tally)')
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
    life,
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
    life,
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
    life,
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
      'no live PiTui TuiApp remains at settlement (a live-app count, not a "never created" tally; the selection log line is not a mount)')
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
    life,
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

test('TSP harness ownership: one cached settlement, no early success, streams restored after', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3a-tsp-own-')
  const logFile = join(home, 'diag.log')
  const owned = await ownTspBoot({
    life,
    home,
    logFile,
    beforeMount: pane => pane.holdHandshake(),
    appExit: () => {},
  })
  const stdinBefore = process.stdin
  // (1) the REAL disposal must not complete while the handshake is held (it does NOT
  // release the gate — only `settle()` does).
  let disposalDone = false
  void owned.beginDisposal().then(() => { disposalDone = true })
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(disposalDone, false, 'the real disposal stays PENDING while the handshake is held')
  assert.equal(process.stdin, stdinBefore,
    'the process streams are NOT restored before the real cleanup ran')

  // (2) every caller shares ONE settlement, which releases the gate and awaits the
  // REAL disposal before restoring.
  const first = owned.settle()
  assert.equal(owned.settle(), first, 'concurrent callers share ONE settlement promise')
  await first
  assert.notEqual(process.stdin, stdinBefore, 'the streams are restored after the cleanup attempt')
  assert.equal(owned.settle(), first, 'a repeated caller gets the SAME settled promise (no second teardown)')
})

test('TSP runner: the REAL composition consumes a LIVE session increment into the SDK pane', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const { fakeSession, event, sessionEvents } = await import('./support/runner-harness.ts')
  const { MessageId } = await import('@deepseek-ai/dsh-llm')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3a-tsp-live-')
  const logFile = join(home, 'diag.log')
  // A standing session with history: the composition RESUMES it (seq 5) and the
  // increment below continues from there — the shape the other runner suites use.
  const session = fakeSession({
    id: 'pr3a-live',
    header: { id: 'pr3a-live', cwd: home, createdAt: 0, version: 1 },
    events: sessionEvents('pr3a hydrated state'),
  })
  const marker = 'pr3a live increment'
  const owned = await ownTspBoot({ life, home, logFile, session, appExit: () => {} })
  try {
    // Wait until the composition has actually PAINTED the hydrated session: the SDK
    // probe happens during `connect`, well before the post-mount wiring exists.
    await waitUntil('the hydrated state on the SDK pane',
      () => owned.pane.output.text().includes('pr3a hydrated state'), 15_000)
    assert.ok(!owned.pane.output.text().includes(marker), 'the marker is not a replay of the initial state')
    const framesBefore = owned.pane.frameCount()

    // The OFFICIAL Host event plane, with a NEW token: a real increment on the session
    // the composition owns live.
    const base = 6
    owned.ctx.emit('session/event', session, event('turn/start', { turn: 1 }, base))
    owned.ctx.emit('session/event', session, event('step/start', { turn: 1, step: 0 }, base + 1))
    owned.ctx.emit('session/event', session, event('assistant/message', {
      turn: 1,
      step: 0,
      message: {
        id: MessageId('pr3a-live-message'),
        role: 'assistant',
        content: [{ type: 'text', text: marker }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 3, outputTokens: 1 },
      stream: [],
    }, base + 2, 'append'))
    owned.ctx.emit('session/event', session, event('step/end', { turn: 1, step: 0 }, base + 3))
    owned.ctx.emit('session/event', session, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, base + 4))

    try {
      await waitUntil('the live increment on the SDK pane', () => owned.pane.output.text().includes(marker), 15_000)
    } catch {
      throw new Error(`live increment never arrived; diag: ${readFileSync(logFile, 'utf8').slice(0, 600)}`)
    }
    assert.ok(owned.pane.frameCount() > framesBefore, 'the increment produced NEW frames on the wire')
    await owned.settle()
    assert.ok(!readFileSync(logFile, 'utf8').includes('fatal'), 'a live increment is not a fatal path')
  } finally {
    await owned.settle()
  }
})
