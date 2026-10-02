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
  /** Park the NEXT reader resolution until release (the stale window). */
  parkNextRead(): { released: Promise<void>; release(): void }
  available(): boolean | undefined
  coldHydrate(): Promise<void>
  rehydrate(): Promise<void>
}

function harness(): Harness {
  let window: PresentationReadSnapshot | undefined
  let current = true
  let parked: (() => void) | undefined
  let parkedResolve: (() => void) | undefined
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
    if (parked !== undefined) {
      await new Promise<void>(resolve => { parkedResolve = resolve })
    }
    return window
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
      const released = new Promise<void>(resolve => { parkedResolve = resolve })
      const gate = { released, release: () => { parked = undefined; parkedResolve?.() } }
      parked = () => {}
      return gate
    },
    available: () => presentation.mainRecentPerformanceAvailable(),
    coldHydrate: () => presentation.initLiveRemoteSession('s').then(() => undefined),
    rehydrate: () => presentation.rehydrateFromWindow('s'),
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

test('PR5 §3.2 stale hydrate: a superseded rehydrate cannot flip the replacement subject\'s bit', async () => {
  const h = harness()
  // Subject A cold-hydrates with a PROVEN window (enough samples).
  const proven: Array<Record<string, unknown>> = []
  let seq = 0
  for (let turn = 1; turn <= RECENT_PERFORMANCE_SAMPLE_LIMIT * 2; turn += 1) {
    proven.push(...validSampleTurn(turn, seq) as Array<Record<string, unknown>>)
    seq += 5
  }
  h.setWindow(proven, true)
  await h.coldHydrate()
  assert.equal(h.available(), true)
  // A rehydrate starts and parks mid-read; the owner is REPLACED while the
  // old read is pending. The stale window (history start) would flip the
  // bit — but it never commits.
  const gate = h.parkNextRead()
  h.setWindow([], false)
  const stale = h.rehydrate()
  h.setCurrent(false)
  gate.release()
  await stale
  // The replacement subject's bit keeps the value its OWN committed window
  // proved — the stale hydrate never touched it.
  assert.equal(h.available(), true)
})
