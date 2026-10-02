/**
 * PR5 (plan §3.2/§Batch 3A) unit coverage for the presentation-owned
 * recent-performance availability bit: the ONE authority beside the main
 * stats fold, committed in the SAME fenced hydrate commits that replace
 * the fold — cold Remote hydrate, rehydrateFromWindow after loadOlder,
 * and the stale-hydrate drop (a superseded rehydrate can never flip the
 * replacement subject's bit).
 * @module @xmoon76/dsh-pi-tui/recent-performance-availability.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionPresentation, type SessionPresentationEvent } from '../src/app/surface/session-presentation.ts'
import { hasEnoughRecentPerformanceSamples, RECENT_PERFORMANCE_SAMPLE_LIMIT } from '../src/stats.ts'
import type { PresentationReadSnapshot } from '../src/runtime/presentation-read-port.ts'
import type { AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'
import type { Diag } from '../src/diag.ts'

/** One completed turn whose assistant message carries a VALID recent
 *  sample (embedded durable stream, two token deltas + usage). */
function validSampleTurn(turn: number, seqBase: number) {
  return [
    { type: 'turn/start', seq: seqBase, time: 0, data: { turn } },
    { type: 'step/start', seq: seqBase + 1, time: 0, data: { turn, step: 1 } },
    {
      type: 'assistant/message', seq: seqBase + 2, time: 1_000,
      data: {
        turn, step: 1,
        message: { id: `m-${turn}`, role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
        usage: { inputTokens: 1, outputTokens: 100 },
        stream: [
          { type: 'chunk', time: 500, chunk: { type: 'text-delta', index: 0, text: 'a' } },
          { type: 'chunk', time: 900, chunk: { type: 'text-delta', index: 0, text: 'b' } },
        ],
      },
    },
    { type: 'step/end', seq: seqBase + 3, time: 1_100, data: { turn, step: 1 } },
    { type: 'turn/end', seq: seqBase + 4, time: 1_100, data: { turn, reason: { kind: 'completed' } } },
  ]
}

interface Harness {
  setWindow(events: Array<Record<string, unknown>>, hasMore: boolean): void
  setCurrent(current: boolean): boolean
  /** Park the NEXT reader resolution until release (the stale window).
   *  The snapshot it eventually returns is the one SET at park time (the
   *  reader captures its payload before parking — a later setWindow must
   *  not leak into a read that already began). */
  parkNextRead(): { release(): void }
  available(): boolean | undefined
  coldHydrate(): Promise<void>
  rehydrate(): Promise<void>
  /** The synchronous generation-bump reset (the A2 seam). */
  resetForGeneration(): void
}

function harness(): Harness {
  let window: PresentationReadSnapshot | undefined
  let current = true
  let parkedResolve: (() => void) | undefined
  let parkedArmed: Promise<void> | undefined
  const app = {
    setBusy: () => {}, setWorking: () => {}, setPlanMode: () => {},
    setSessionTitle: () => {}, setTodoSummary: () => {}, clearLocalMessages: () => {},
    clearNotify: () => {}, clearExitConfirmation: () => {}, setSearchResult: () => {},
    clearSessionOverrides: () => {}, resetInputHistory: () => {},
  }
  const surface = {
    app, openingJournal: { cut: () => undefined },
    resetSearchPresentation: () => {}, resetTasks: () => {}, resetPendingPresentation: () => {},
    applyResumedCompaction: () => {}, repaint: () => {}, refreshPendingInput: () => {},
    refreshTasks: () => {}, refreshAgents: () => {},
  }
  const diag: Diag = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} } as unknown as Diag
  const read = async (): Promise<PresentationReadSnapshot | undefined> => {
    // Capture the payload THIS read observes BEFORE any parking delay: a
    // read that began must settle against the window it read, never a
    // later mutable replacement.
    const observed = window
    const armed = parkedArmed
    if (armed !== undefined) {
      parkedArmed = undefined
      await armed
    }
    return observed
  }
  const presentation = createSessionPresentation<SessionPresentationEvent>({
    surface: surface as never,
    diag,
    isCleanedUp: () => false,
    refreshStatusCheap: () => {},
    folds: { title: () => undefined },
    direct: {
      installModelSelection: () => {},
      assistantStreamBaselineFor: () => [],
      planActive: () => false,
    },
    status: {
      setGoalText: () => {}, refresh: () => {}, refreshTerminalTitle: () => {},
      updateWelcomeCard: () => {}, scheduleInitialMeasurement: () => {},
    },
    history: { rememberCwd: () => {}, currentCwd: () => '/c', records: () => [], setLastContent: () => {} },
    commands: { register: () => {} },
    submission: { clearPending: () => {} },
    viewer: { resetAutoPop: () => {}, teardownForSessionSwap: () => {} },
    remote: {
      read,
      running: () => false,
      plan: () => false,
      isStillCurrent: () => current,
      facts: () => ({}),
    },
  })
  return {
    setWindow: (events, hasMore) => {
      window = Object.freeze({
        sessionId: 's',
        durableEvents: Object.freeze(events.map(event => Object.freeze({ ...event }))) as never,
        liveInputs: Object.freeze([] as readonly AssistantLiveInput[]),
        revision: 1,
        coverage: hasMore ? 'bounded' : 'full',
        hasMore,
        loadingOlder: false,
        openState: 'open',
      })
    },
    setCurrent: value => { current = value; return current },
    parkNextRead: () => {
      const gate = { release: () => { parkedResolve?.() } }
      parkedResolve = undefined
      // Arm the park for the NEXT read: the read captures its payload, then
      // waits on this gate.
      const arm = new Promise<void>(resolve => { parkedResolve = resolve })
      parkedArmed = arm
      return gate
    },
    available: () => presentation.mainRecentPerformanceAvailable(),
    coldHydrate: () => presentation.initLiveRemoteSession('s').then(() => undefined),
    rehydrate: () => presentation.rehydrateFromWindow('s'),
    resetForGeneration: () => presentation.resetForGeneration(),
  }
}

test('PR5 §3.2: a bounded window without enough samples starts UNAVAILABLE (unknown, not zero)', async () => {
  const h = harness()
  // One valid sample only — far below both the TTFT (5) and throughput (10)
  // candidate windows; hasMore=true means older history exists.
  const events = validSampleTurn(1, 0)
  assert.equal(hasEnoughRecentPerformanceSamples(events as never), false,
    'fixture check: one sample does NOT prove the window')
  h.setWindow(events, true)
  await h.coldHydrate()
  assert.equal(h.available(), false)
})

test('PR5 §3.2: a window that reached the history start is AVAILABLE even with zero valid samples', async () => {
  const h = harness()
  // No valid samples at all, but hasMore=false — the fold IS the whole log;
  // its zero is a measured zero.
  h.setWindow([], false)
  await h.coldHydrate()
  assert.equal(h.available(), true)
})

test('PR5 §3.2: a bounded window with enough retained samples is AVAILABLE', async () => {
  const h = harness()
  const events: Array<Record<string, unknown>> = []
  let seq = 0
  for (let turn = 1; turn <= RECENT_PERFORMANCE_SAMPLE_LIMIT * 2; turn += 1) {
    events.push(...validSampleTurn(turn, seq) as Array<Record<string, unknown>>)
    seq += 5
  }
  assert.equal(hasEnoughRecentPerformanceSamples(events as never), true,
    'fixture check: the retained samples DO prove the window')
  h.setWindow(events, true)
  await h.coldHydrate()
  assert.equal(h.available(), true)
})

test('PR5 loadOlder: reaching enough retained samples flips availability false → true', async () => {
  const h = harness()
  // Cold window: one sample, truncated.
  h.setWindow(validSampleTurn(1, 0), true)
  await h.coldHydrate()
  assert.equal(h.available(), false)
  // The widened window (after loadOlder) retains enough samples.
  const widened: Array<Record<string, unknown>> = []
  let seq = 0
  for (let turn = 1; turn <= RECENT_PERFORMANCE_SAMPLE_LIMIT * 2; turn += 1) {
    widened.push(...validSampleTurn(turn, seq) as Array<Record<string, unknown>>)
    seq += 5
  }
  h.setWindow(widened, true)
  await h.rehydrate()
  assert.equal(h.available(), true)
})

test('PR5 loadOlder: reaching the history start with fewer samples than the limit flips false → true', async () => {
  const h = harness()
  // Two valid samples — below the limit; the window is still truncated.
  const two = [...validSampleTurn(1, 0), ...validSampleTurn(2, 5)]
  h.setWindow(two, true)
  await h.coldHydrate()
  assert.equal(h.available(), false)
  // loadOlder reaches the history start: the fold is now the whole log.
  h.setWindow(two, false)
  await h.rehydrate()
  assert.equal(h.available(), true)
})

test('PR5 §3.2 stale hydrate: a superseded rehydrate cannot flip the replacement subject\'s bit (true counterfactual)', async () => {
  const h = harness()
  // Subject A cold-hydrates with a TRUNCATED window that proves NOTHING
  // (one sample, hasMore=true): its bit is false.
  h.setWindow(validSampleTurn(1, 0), true)
  await h.coldHydrate()
  assert.equal(h.available(), false)
  // A rehydrate for A starts and parks mid-read; its snapshot is the
  // window SET AT PARK TIME — a history-start window whose commit would
  // write `true`.
  const gate = h.parkNextRead()
  h.setWindow([], false)
  const stale = h.rehydrate()
  // The owner is REPLACED while the old read is pending; the replacement
  // subject then cold-hydrates ITS OWN still-unproven window (false).
  h.setCurrent(false)
  h.setWindow(validSampleTurn(1, 0), true)
  await h.coldHydrate()
  assert.equal(h.available(), false, 'the replacement subject\'s own hydrate committed false')
  // Release the stale read: its §6.5 fences drop it — the bit stays the
  // replacement's own `false`. A stale commit (the history-start window)
  // would write `true` here, which is exactly the counterfactual this
  // test must be able to catch.
  gate.release()
  await stale
  assert.equal(h.available(), false,
    'the stale rehydrate never flipped the replacement subject\'s bit (a stale commit would read true)')
})

test('PR5 §3.2 generation reset: the availability bit returns to false before the replacement hydrates', async () => {
  const h = harness()
  // Subject A hydrates a PROVEN window (enough retained samples).
  const proven: Array<Record<string, unknown>> = []
  let seq = 0
  for (let turn = 1; turn <= RECENT_PERFORMANCE_SAMPLE_LIMIT * 2; turn += 1) {
    proven.push(...validSampleTurn(turn, seq) as Array<Record<string, unknown>>)
    seq += 5
  }
  h.setWindow(proven, true)
  await h.coldHydrate()
  assert.equal(h.available(), true)
  // The generation bump resets the presentation synchronously — BEFORE the
  // new owner is published — so the hydrate-pending window reads `false`
  // (the old subject's `true` must not leak).
  h.resetForGeneration()
  assert.equal(h.available(), false,
    'the bit is false in the hydrate-pending window after the generation reset')
  // The replacement subject's own hydrate then re-proves it.
  h.setWindow(proven, true)
  await h.coldHydrate()
  assert.equal(h.available(), true)
})
