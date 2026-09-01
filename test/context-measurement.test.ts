/**
 * Context-measurement coordinator tests (PR D2): the cheap status refresh
 * must NEVER trigger a measurement (UI-only events keep measureCalls at 0),
 * model-visible lifecycle events trigger bounded measurements through the
 * semantic reader seam, session switches never leak an old session's value,
 * failures keep last-good semantics, and the deferred initial measure runs
 * only after the first usable paint and only for the session that was
 * captured (generation fence).
 *
 * The coordinator + defer helper ARE the production seam the runner drives
 * (the same pattern as settleCompactionSurface / foldCompactionEvent).
 * @module @xmoon76/dsh-pi-tui/context-measurement.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  ContextMeasurementCoordinator,
  deferInitialContextMeasure,
  type ContextMeasureReason,
} from '../src/status/context-measurement.ts'
import { emptyStatusSnapshot } from '../src/status/types.ts'
import { StatusStore } from '../src/status/store.ts'
import { usageFromStats } from '../src/status/derive-usage.ts'
import { plainSectionEqual } from '../src/status/equal.ts'
import type { SessionStats } from '../src/stats.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { contextRefreshKind } from '../src/index.ts'

/** A counting reader standing in for SessionReader.measureContext. */
function countingReader(initial = 42_000): {
  measureCalls: number
  value: number
  reader: (sessionId: string) => number | undefined
} {
  const state = { measureCalls: 0, value: initial }
  return {
    get measureCalls() { return state.measureCalls },
    set value(next: number) { state.value = next },
    reader: (_sessionId: string) => {
      state.measureCalls += 1
      return state.value
    },
  }
}

/** The runner's exact UI-only pattern: a cheap refresh cycle. */
function cheapRefresh(coordinator: ContextMeasurementCoordinator, sessionId: string | undefined): number | undefined {
  return coordinator.valueFor(sessionId)
}

/** The runner's exact model-visible pattern: mark dirty, then measure. */
function measuredRefresh(
  coordinator: ContextMeasurementCoordinator,
  sessionId: string,
  reader: (sessionId: string) => number | undefined,
): number | undefined {
  coordinator.markDirty()
  return coordinator.measure(sessionId, reader)
}

test('initial measure happens once; the value is cached for cheap refreshes', () => {
  const coordinator = new ContextMeasurementCoordinator()
  const counting = countingReader(50_000)
  coordinator.bind('session-a')
  assert.equal(coordinator.isDirty(), true, 'a fresh session starts dirty')
  const first = coordinator.measure('session-a', counting.reader)
  assert.equal(first, 50_000)
  assert.equal(counting.measureCalls, 1)
  assert.equal(coordinator.isDirty(), false, 'a successful measure clears dirty')
  // Cheap refreshes read the cache: no reader call.
  for (let i = 0; i < 100; i += 1) {
    assert.equal(cheapRefresh(coordinator, 'session-a'), 50_000)
  }
  assert.equal(counting.measureCalls, 1, '100 cheap refreshes never measure')
})

test('19.2 hard gate: 100 UI-only refresh cycles -> measureCalls stays 0', () => {
  const coordinator = new ContextMeasurementCoordinator()
  const counting = countingReader(42_000)
  coordinator.bind('session-a')
  // UI-only events repaint from the cache; they never mark dirty.
  for (let i = 0; i < 100; i += 1) {
    cheapRefresh(coordinator, 'session-a')
    coordinator.valueFor(undefined)
  }
  assert.equal(counting.measureCalls, 0, 'UI-only refreshes never reach the reader')
  assert.equal(coordinator.valueFor('session-a'), undefined, 'no measurement was ever made')
})

test('19.3 long-session independence: cheap refresh cost never touches the reader', () => {
  const coordinator = new ContextMeasurementCoordinator()
  // The reader's cost grows with session length — but it must never run
  // for cheap refreshes, so the cost is irrelevant.
  let measuredTurns = 0
  const expensiveReader = (_sessionId: string): number => {
    measuredTurns += 1
    return 10_000 + measuredTurns
  }
  coordinator.bind('session-a')
  for (let i = 0; i < 10_000; i += 1) cheapRefresh(coordinator, 'session-a')
  assert.equal(measuredTurns, 0, '10k cheap refreshes produce zero measurements, any session length')
})

test('lifecycle trigger matrix: bounded measurements per model-visible event', () => {
  const coordinator = new ContextMeasurementCoordinator()
  const counting = countingReader(40_000)
  coordinator.bind('session-a')
  // initial
  coordinator.measure('session-a', counting.reader)
  assert.equal(counting.measureCalls, 1, 'initial post-paint measure: 1')
  // UI-only interlude
  for (let i = 0; i < 20; i += 1) cheapRefresh(coordinator, 'session-a')
  assert.equal(counting.measureCalls, 1, 'UI-only events after the initial measure: 0 growth')
  // step/start
  measuredRefresh(coordinator, 'session-a', counting.reader)
  assert.equal(counting.measureCalls, 2, 'step/start: bounded +1')
  // turn/end
  measuredRefresh(coordinator, 'session-a', counting.reader)
  assert.equal(counting.measureCalls, 3, 'turn/end: bounded +1 when dirty')
  // compaction/end
  measuredRefresh(coordinator, 'session-a', counting.reader)
  assert.equal(counting.measureCalls, 4, 'compaction/end: +1')
  // keybinding/theme/focus (UI-only) again
  cheapRefresh(coordinator, 'session-a')
  cheapRefresh(coordinator, 'session-a')
  assert.equal(counting.measureCalls, 4, 'keybinding/theme/focus-style refreshes: 0')
  // same-sync-chain dedupe: a second measure with NO dirty mark skips.
  coordinator.measure('session-a', counting.reader)
  assert.equal(counting.measureCalls, 4, 'a clean cache skips the reader (dirty=false -> skip)')
})

test('session switch: the old session value never leaks into the new session', () => {
  const coordinator = new ContextMeasurementCoordinator()
  const counting = countingReader(100_000)
  coordinator.bind('session-old')
  coordinator.measure('session-old', counting.reader)
  assert.equal(coordinator.valueFor('session-old'), 100_000)
  // Switch: bind the new identity — the old value is gone.
  coordinator.bind('session-new')
  assert.equal(coordinator.snapshot().value, undefined, 'bind clears the old value')
  assert.equal(coordinator.valueFor('session-new'), undefined, 'the new session starts unmeasured')
  assert.equal(coordinator.valueFor('session-old'), undefined, 'the old session id reads nothing after the switch')
  // The new session measures once.
  measuredRefresh(coordinator, 'session-new', counting.reader)
  assert.equal(counting.measureCalls, 2)
  assert.equal(coordinator.valueFor('session-new'), 100_000)
  assert.equal(coordinator.valueFor('session-old'), undefined, 'old-session reads stay empty forever')
})

test('a stale/foreign session id is refused: no measurement can commit under the wrong identity', () => {
  const coordinator = new ContextMeasurementCoordinator()
  const counting = countingReader(7_000)
  coordinator.bind('session-current')
  const stale = coordinator.measure('session-old', counting.reader)
  assert.equal(stale, undefined)
  assert.equal(counting.measureCalls, 0, 'a foreign session id never reaches the reader')
  assert.equal(coordinator.snapshot().sessionId, 'session-current', 'the bound identity never changed')
})

test('19.6 failure regression: undefined and throwing readers keep last-good, recover later', () => {
  const coordinator = new ContextMeasurementCoordinator()
  let calls = 0
  let fail = true
  const flaky = (_sessionId: string): number | undefined => {
    calls += 1
    if (fail) return undefined
    return 66_000
  }
  coordinator.bind('session-a')
  const first = coordinator.measure('session-a', flaky)
  assert.equal(first, undefined, 'measurement failure falls back to no context')
  assert.equal(calls, 1)
  assert.equal(coordinator.isDirty(), true, 'a failed measure stays dirty for the next trigger')
  // Subsequent triggers retry — still failing, still not crashing.
  assert.equal(coordinator.measure('session-a', flaky), undefined)
  assert.equal(calls, 2)
  // Success recovers.
  fail = false
  assert.equal(coordinator.measure('session-a', flaky), 66_000)
  assert.equal(coordinator.isDirty(), false)
  assert.equal(coordinator.valueFor('session-a'), 66_000)

  // A THROWING reader: swallowed, last-good stays, dirty stays.
  const throwing = new ContextMeasurementCoordinator()
  const counting = countingReader(9_000)
  throwing.bind('session-a')
  throwing.measure('session-a', counting.reader)
  assert.equal(throwing.valueFor('session-a'), 9_000)
  throwing.markDirty()
  const afterThrow = throwing.measure('session-a', () => { throw new Error('backend exploded') })
  assert.equal(afterThrow, 9_000, 'a throwing reader keeps the last-good value')
  assert.equal(throwing.isDirty(), true, 'the dirty flag survives the throw (retry armed)')
})

test('19.5 first-paint ordering: the deferred measure runs AFTER the paint turn, fenced', () => {
  const order: string[] = []
  const coordinator = new ContextMeasurementCoordinator()
  const counting = countingReader(30_000)
  coordinator.bind('session-a')

  // The runner paints + cheap-refreshes FIRST, then defers the measure.
  let scheduled: (() => void) | undefined
  const cancel = deferInitialContextMeasure(
    (callback) => { scheduled = callback; return { cancel: () => { scheduled = undefined } } },
    () => true,
    () => {
      order.push('measure')
      measuredRefresh(coordinator, 'session-a', counting.reader)
    },
  )
  order.push('paint')
  order.push('cheap-status')
  assert.ok(typeof scheduled === 'function', 'the deferral is scheduled, not run inline')
  assert.deepEqual(order, ['paint', 'cheap-status'], 'nothing measured before the deferred turn')
  scheduled!()
  assert.deepEqual(order, ['paint', 'cheap-status', 'measure'], 'the measure runs in its own turn')
  assert.equal(counting.measureCalls, 1)
  cancel()
})

test('deferred initial measure is a no-op when the session changed before it ran', () => {
  const order: string[] = []
  let generation = 1
  let liveSession = 'session-a'
  // The runner captures generation + session id and fences against both.
  const capturedGeneration = generation
  const capturedSession = liveSession
  let scheduled: (() => void) | undefined
  const cancel = deferInitialContextMeasure(
    (callback) => { scheduled = callback; return { cancel: () => { scheduled = undefined } } },
    () => capturedGeneration === generation && liveSession === capturedSession,
    () => { order.push('measure-ran') },
  )
  // Session switch BEFORE the deferred callback fires.
  generation += 1
  liveSession = 'session-b'
  scheduled!()
  assert.deepEqual(order, [], 'a stale deferred measure never commits')
  cancel()
})

test('defer cancel clears the pending callback (dispose path)', () => {
  let scheduled: (() => void) | undefined
  let cancelled = false
  const cancel = deferInitialContextMeasure(
    (callback) => { scheduled = callback; return { cancel: () => { cancelled = true } } },
    () => true,
    () => { throw new Error('must never run after cancel') },
  )
  cancel()
  assert.equal(cancelled, true)
})

test('bind(undefined) clears everything (deferred start, no live session)', () => {
  const coordinator = new ContextMeasurementCoordinator()
  const counting = countingReader(0)
  coordinator.bind('session-a')
  coordinator.measure('session-a', counting.reader)
  assert.equal(coordinator.valueFor('session-a'), 0)
  coordinator.bind(undefined)
  assert.equal(coordinator.snapshot().value, undefined)
  assert.equal(coordinator.measure('session-a', counting.reader), undefined, 'no session -> no measure')
  assert.equal(counting.measureCalls, 1, 'the cleared coordinator never reaches the reader')
})

test('reason names are the documented model-visible triggers', () => {
  const reasons: ContextMeasureReason[] = [
    'initial', 'step-start', 'turn-end', 'compaction-end', 'explicit-status', 'session-switch',
  ]
  assert.equal(reasons.length, 6)
  assert.ok(reasons.includes('step-start') && reasons.includes('compaction-end'))
})

test('contextRefreshKind classifier: model-visible events measure, UI-only events repaint cheaply', () => {
  assert.equal(contextRefreshKind('step/start'), 'measure')
  assert.equal(contextRefreshKind('turn/end'), 'measure')
  assert.equal(contextRefreshKind('compaction/end'), 'measure', 'classified measure; the firehose skips it (fold-outcome path)')
  for (const uiOnly of [
    'turn/start', 'user/message', 'assistant/chunk', 'assistant/message',
    'tool/call', 'tool/result', 'subagent/start', 'subagent/end', 'agent/status',
    'session/end-seed', 'compaction/start', 'llm/retry', 'command/run',
  ]) {
    assert.equal(contextRefreshKind(uiOnly), 'cheap', `${uiOnly} must only repaint cheaply`)
  }
})

test('P1: a session switch never shows the OLD session context through the status chain', () => {
  // The FULL projection chain, replayed with the runner's exact
  // refreshStatusCheap semantics: coordinator->valueFor, the store usage
  // projection (usageFromStats + plainSectionEqual patch, like the runner),
  // then app.setStatus with the legacy context fields. TuiApp.setStatus
  // MERGES into its legacy status and usageFromStatus() falls back to the
  // store's current usage — so BOTH the legacy fields AND the store
  // projection must be driven by the CURRENT session's (un)measured
  // context. The runner MUST project `contextTokens: undefined` explicitly
  // (a conditional spread leaves session A's value in the merge).
  const coordinator = new ContextMeasurementCoordinator()
  const store = new StatusStore(emptyStatusSnapshot())
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { statusStore: store })
  app.start()
  const stats = (inputTokens: number): SessionStats => ({
    turns: 5, steps: 9, llmMs: 100, firstTokenMsAvg: 50, tokensPerSec: 10, cacheHitPct: 0,
    inputTokens, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, contextWindow: 128_000,
  })
  try {
    const refreshCheap = (sessionId: string | undefined, sessionStats: SessionStats): void => {
      const contextTokens = coordinator.valueFor(sessionId)
      const usage = usageFromStats(sessionStats, contextTokens)
      const current = store.snapshot()
      const patch: { usage?: typeof usage } = {}
      if (!plainSectionEqual(current.usage, usage)) patch.usage = usage
      store.update(patch)
      app.setStatus({ contextTokens, contextWindow: contextTokens === undefined ? undefined : sessionStats.contextWindow })
    }
    // Session A measured 110k/128k and projected.
    coordinator.bind('session-a')
    coordinator.measure('session-a', () => 110_000)
    refreshCheap('session-a', stats(5_000))
    assert.equal(store.snapshot().usage?.context?.usedTokens, 110_000, 'session A pressure is visible')

    // Switch to B: the deferred measurement has NOT run yet — B's first
    // cheap refresh must show B's own fallback, never A's 110k.
    coordinator.bind('session-b')
    refreshCheap('session-b', stats(3_000))
    const afterSwitch = store.snapshot().usage?.context
    assert.ok(afterSwitch !== undefined && afterSwitch.usedTokens !== 110_000, 'B must never show A context pressure')

    // B's measurement FAILS (undefined, then throw): A's value must not
    // revive — the cleared fields stay cleared, the fallback stays B's.
    coordinator.measure('session-b', () => undefined)
    refreshCheap('session-b', stats(3_000))
    const afterUndefined = store.snapshot().usage?.context
    assert.ok(afterUndefined !== undefined && afterUndefined.usedTokens !== 110_000, 'A context must not revive after an undefined measurement')
    coordinator.markDirty()
    coordinator.measure('session-b', () => { throw new Error('backend exploded') })
    refreshCheap('session-b', stats(3_000))
    const afterThrow = store.snapshot().usage?.context
    assert.ok(afterThrow !== undefined && afterThrow.usedTokens !== 110_000, 'A context must not revive after a throwing measurement')

    // B's later SUCCESS projects B's own value (the clear was per-session,
    // not a permanent blank).
    const later = coordinator.measure('session-b', () => 12_000)
    assert.equal(later, 12_000)
    refreshCheap('session-b', stats(3_000))
    assert.equal(store.snapshot().usage?.context?.usedTokens, 12_000)
  } finally {
    app.stop()
  }
})

test('P2: /status forces ONE measurement through the coordinator, never a duplicate direct read', async () => {
  // The real /status handler must route through the runner's
  // forceContextMeasurement (mark dirty + semantic reader + cache + cheap
  // repaint) — a direct sessionReader read from the command surface would
  // bypass the coordinator cache and could duplicate the deferred initial
  // measurement (round-8 finding).
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const ctx = new Context()
  const defs: Array<{ name: string; handler?: unknown }> = []
  ctx.provide('commands', {
    register: (def: { name: string; handler?: unknown }): (() => void) => { defs.push(def); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  } as never)
  const agent = { session: { id: 'session-b', events: [], header: { cwd: '/ws' } } } as unknown as Agent
  try {
    // Run the handler under BOTH force outcomes: a measured value AND an
    // undefined force (no live session / measurement failure). The direct
    // reader must NEVER run while the coordinator is present — the old
    // `??` fallback triggered a second, uncached measurement when the
    // force returned undefined (round-9 finding).
    for (const forceValue of [42_000, undefined]) {
      defs.length = 0 // re-register per round so the fresh handler is found
      let forceCalls = 0
      let directReads = 0
      const runner = {
        ctx,
        app,
        cwd: '/ws',
        signal: new AbortController().signal,
        diag: { warn: () => {}, error: () => {}, info: () => {} },
        commandRegistry: ctx.get('commands'),
        recordExtensionError: () => {},
        clearExtensionError: () => {},
        captureExtensionHealthRef: () => {},
        ensureSession: async () => {},
        sessionCwd: () => '/ws',
        get liveAgent() { return agent },
        extensions: undefined,
        forceContextMeasurement: () => { forceCalls += 1; return forceValue },
        sessionReader: {
          measureContext: () => { directReads += 1; return 99_000 },
          list: async () => [], search: async () => [], titles: async () => new Map(), readExportData: async () => ({ kind: 'none' }),
        },
      } as unknown as TuiCommandRunner
      registerTuiCommands(runner)
      const statusDef = defs.find(entry => entry.name === 'status')
      assert.ok(statusDef?.handler, 'the /status command is registered')
      await (statusDef.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
      assert.equal(forceCalls, 1, 'the explicit status forces exactly one measurement through the coordinator')
      assert.equal(directReads, 0, `the direct reader is never called while the coordinator is present (force returned ${String(forceValue)})`)
    }
  } finally {
    app.stop()
  }
})

test('the deferred initial measure binds the captured session FIRST, then skips only an already-measured one', () => {
  const coordinator = new ContextMeasurementCoordinator()
  const counting = countingReader(50_000)
  // The runner's deferred-callback shape (deferInitialContextMeasure run),
  // verbatim: bind the captured session BEFORE the dirty guard — an
  // UNBOUND coordinator (cold resume) or a coordinator still bound to the
  // PREVIOUS session (switch) reads as not dirty, and guarding before the
  // bind would make the initial measure a permanent no-op (round-10
  // finding).
  const deferredRun = (sessionId: string): void => {
    coordinator.bind(sessionId)
    if (!coordinator.isDirty()) return
    coordinator.markDirty()
    coordinator.measure(sessionId, counting.reader)
  }
  // Cold resume: the coordinator is UNBOUND when the deferred callback
  // runs — the measure must still happen once.
  deferredRun('session-cold')
  assert.equal(counting.measureCalls, 1, 'the cold-resume deferred measure must run')
  assert.equal(coordinator.valueFor('session-cold'), 50_000)
  // A second deferral for the same already-measured session is a no-op
  // (the round-9 force-then-deferred dedupe).
  deferredRun('session-cold')
  assert.equal(counting.measureCalls, 1, 'no re-measure for an already-measured session')
  // A FAILED earlier attempt keeps the last-good value AND stays dirty:
  // the deferred callback retries.
  coordinator.markDirty()
  assert.equal(coordinator.measure('session-cold', () => undefined), 50_000, 'a failed measure keeps the last-good value')
  assert.equal(coordinator.isDirty(), true, 'a failed measure stays dirty')
  deferredRun('session-cold')
  assert.equal(counting.measureCalls, 2, 'a failed attempt is retried by the deferred callback')
  // Session switch: the coordinator is still bound to the OLD session when
  // the NEW session's deferred callback runs — binding the new id clears
  // the old value and arms exactly one fresh measure.
  coordinator.bind('session-old')
  coordinator.markDirty()
  coordinator.measure('session-old', counting.reader)
  const afterSwitchMeasure = counting.measureCalls
  deferredRun('session-new')
  assert.equal(counting.measureCalls, afterSwitchMeasure + 1, 'the switched session measures exactly once')
  assert.equal(coordinator.valueFor('session-new'), 50_000)
  assert.equal(coordinator.valueFor('session-old'), undefined, 'the old session value is cleared by the bind')
})

test('D2 structural gate: the runner source keeps measurement out of cheap refreshes', () => {
  // The same source-audit style as test/rules.test.ts: a regression that
  // reintroduces a measuring reader (or the direct tokenMeter service)
  // into a generic status refresh fails here instead of waiting for a
  // review round. Comments are stripped so documentation cannot mask code.
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
  const cheapStart = stripped.indexOf('const refreshStatusCheap =')
  const cheapEnd = stripped.indexOf('const refreshContextMeasurement =')
  assert.ok(cheapStart !== -1 && cheapEnd > cheapStart, 'both status functions exist')
  const cheapBlock = stripped.slice(cheapStart, cheapEnd)
  assert.ok(!cheapBlock.includes('measureContext'), 'the cheap refresh must never call a measurement reader')
  assert.ok(!cheapBlock.includes('tokenMeter'), 'the cheap refresh must never read the tokenMeter service')
  assert.ok(!stripped.includes("ctx.get('tokenMeter')"), 'the runner no longer reads tokenMeter directly (the Direct adapter owns it)')
  assert.ok(stripped.includes('backend.sessionReader.measureContext'), 'measurement goes through the SessionReader port')
  // P1: the legacy context fields must be projected EXPLICITLY (undefined
  // clears the TuiApp merge) — a conditional spread would leave the
  // previous session's context on the new session's first frames.
  assert.ok(cheapBlock.includes('contextTokens,'), 'setStatus must always carry the contextTokens field (undefined clears)')
  assert.ok(cheapBlock.includes('contextWindow: contextTokens === undefined ? undefined :'), 'an unmeasured session must clear the window too')
  // P2: the deferred initial measure must skip a session that an earlier
  // force/lifecycle measurement already succeeded for — the callback first
  // checks the coordinator's dirty flag instead of re-measuring blindly.
  const deferStart = stripped.indexOf('const scheduleInitialContextMeasure =')
  const deferEnd = stripped.indexOf('let app: TuiApp')
  assert.ok(deferStart !== -1 && deferEnd > deferStart, 'the deferred-measure scheduler exists')
  const deferBlock = stripped.slice(deferStart, deferEnd)
  assert.ok(deferBlock.includes('.isDirty()'), 'the deferred initial measure must skip an already-measured session')
})
