/**
 * M3-4 PR2 semantic-equivalence proof: the Remote bounded-window working-fold
 * fallback (`SessionSnapshot.running` when the window cannot prove a turn
 * boundary) vs `workingFromLog` (the latest turn boundary open).
 *
 * The invariant (verified against the rc.2 DSH source, agent-loop/src/agent.ts):
 *
 * - `Agent.status === 'running'` ⇔ the loop phase is `running`; the phase
 *   ENTERS before the first `turn/start` append (wakeDriver → kick → turn())
 *   and EXITS in kick's finally — after the LAST `turn()` returned, i.e. after
 *   the last `turn/end` is durable. Therefore:
 *
 *   1. `running === false` ⇒ every turn has a durable `turn/end` ⇒ any window
 *      containing the last boundary folds `workingFromLog === false` — the
 *      fallback can never answer `true` where the fold would answer `false`.
 *   2. `running === true` with an UNPROVABLE window (no boundary visible)
 *      covers exactly the pre-`turn/start` wake window and mid-turn windows —
 *      both are semantically "work in flight" for the busy/working UI fact,
 *      the same state the Direct surface enters on `turn/start`.
 *   3. The compaction settle consumes the SAME fallback through the injected
 *      capability; a `false` fallback there keeps the existing
 *      busy-after-turn-boundary policy, never fabricating a working row.
 *
 * These tests lock the TUI-side mapping contract (the upstream ordering is
 * locked upstream; a future rc that changes it must fail HERE).
 *
 * @module @xmoon76/dsh-pi-tui/remote-working-fold-equivalence.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'
import type { PresentationReadSnapshot } from '../src/runtime/presentation-read-port.ts'
import { createSessionPresentation, type SessionPresentationEvent } from '../src/app/surface/session-presentation.ts'
import type { Diag } from '../src/runtime/process/diagnostics.ts'

/** The minimal well-formed durable payloads the transcript fold reads. */
function dataOf(type: string, seq: number): Record<string, unknown> {
  switch (type) {
    case 'turn/start': return { turn: Math.floor(seq / 4) + 1 }
    case 'turn/end': return { turn: Math.floor(seq / 4) + 1, reason: { kind: 'completed' } }
    case 'user/message': return {
      id: `u-${seq}`, role: 'user',
      content: [{ type: 'text', text: `user ${seq}` }],
      source: { kind: 'user' },
    }
    case 'assistant/message': return {
      turn: 1, step: 1,
      message: {
        id: `a-${seq}`, role: 'assistant',
        content: [{ type: 'text', text: `assistant ${seq}` }],
        source: { kind: 'model', provider: 'smoke', model: 'smoke-model' },
      },
      stream: [], usage: { inputTokens: 1, outputTokens: 1 },
    }
    default: return {}
  }
}

function snapshotOf(events: Array<{ type: string; seq: number }>, hasMore = false): PresentationReadSnapshot {
  return Object.freeze({
    sessionId: 's',
    durableEvents: Object.freeze(events.map(event => Object.freeze({
      type: event.type, seq: event.seq, time: 1, data: dataOf(event.type, event.seq),
    }))),
    liveInputs: Object.freeze([] as readonly AssistantLiveInput[]),
    revision: 1,
    coverage: 'bounded',
    hasMore,
    loadingOlder: false,
    openState: 'open',
  })
}

interface Harness {
  setWindow(events: Array<{ type: string; seq: number }>, hasMore?: boolean): void
  setRunning(running: boolean | undefined): void
  setCurrent(current: boolean): void
  rolloverTransport(): void
  /** Run `fn` while the NEXT read is pending (after capture, before commit). */
  onMidRead(fn: () => void): void
  /** Run `fn` AFTER the reader fence passed, inside the hydrate commit
   *  (the window between the fence check and the returned outcome). */
  onHydrateCommit(fn: () => void): void
  isCurrent(token: unknown): boolean
  /** The outcome of the last hydrate (for token-identity assertions). */
  lastOutcome(): { transportToken: unknown } | undefined
  /** How many transport captures the owner performed. */
  captureCount(): number
  busy(): boolean | undefined
  working(): boolean | undefined
}

function harness(): Harness {
  let window: PresentationReadSnapshot = snapshotOf([], true)
  let running: boolean | undefined
  let current = true
  // The transport identity (Connection generation + binding object stand-ins)
  // for the §6.5 rollover regression: the token captured before the read vs
  // the LIVE identity compared after the await.
  const transportToken = { generation: 1, binding: {} }
  let liveTransportToken: unknown = transportToken
  /** Every capture the owner performs, in order — the regression proves the
   *  outcome carries the token captured ACROSS THE READ (not a later one). */
  const captures: unknown[] = []
  /** Optional mid-read hook: runs while the reader promise is pending (the
   *  capture has happened, the commit has not). */
  let midRead: (() => void) | undefined
  let lastOutcome: { transportToken: unknown } | undefined
  let hydrateCommit: (() => void) | undefined
  let busy: boolean | undefined
  let working: boolean | undefined
  const app = {
    setBusy: (value: boolean) => { busy = value },
    setWorking: (value: boolean) => { working = value },
    setPlanMode: () => {}, setSessionTitle: () => {}, setTodoSummary: () => {},
    clearLocalMessages: () => {}, clearNotify: () => {}, clearExitConfirmation: () => {},
    setSearchResult: () => {}, clearSessionOverrides: () => {}, resetInputHistory: () => {},
  }
  const surface = {
    app, openingJournal: { cut: () => undefined },
    resetSearchPresentation: () => {}, resetTasks: () => {}, resetPendingPresentation: () => {},
    applyResumedCompaction: () => {}, repaint: () => {},
    refreshPendingInput: () => {
      // Fires inside hydratePresentation — AFTER the reader fence passed.
      const hook = hydrateCommit
      hydrateCommit = undefined
      hook?.()
    },
    refreshTasks: () => {}, refreshAgents: () => {},
  }
  const noop = (): void => {}
  const diag: Diag = { info: noop, warn: noop, error: noop, debug: noop, dispose: noop } as unknown as Diag
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
      setGoalText: () => {}, refresh: () => {}, refreshTerminalTitle: () => {}, refreshTerminalCwd: () => {},
      updateWelcomeCard: () => {}, scheduleInitialMeasurement: () => {},
    },
    history: { rememberCwd: () => {}, currentCwd: () => '/c', records: () => [], setLastContent: () => {} },
    commands: { register: () => {} },
    submission: { clearPending: () => {} },
    viewer: { resetAutoPop: () => {}, teardownForSessionSwap: () => {} },
    remote: {
      read: async () => {
        // Resolve on a later microtask so a midRead hook can flip the
        // transport identity BETWEEN the fence capture and the commit.
        if (midRead !== undefined) {
          const hook = midRead
          midRead = undefined
          await Promise.resolve()
          hook()
        }
        return window
      },
      running: () => running,
      plan: () => false,
      isStillCurrent: () => current,
      captureTransportToken: () => { captures.push(transportToken); return transportToken },
      isTransportTokenCurrent: () => Object.is(transportToken, liveTransportToken),
      // The projection-owned current facts: this suite exercises the
      // working/busy fold, so the official answer is "nothing".
      facts: () => ({}),
    },
  })
  return {
    setWindow: (events, hasMore = true) => { window = snapshotOf(events, hasMore) },
    setRunning: value => { running = value },
    setCurrent: value => { current = value },
    rolloverTransport: () => { liveTransportToken = { generation: 2, binding: {} } },
    onMidRead: fn => { midRead = fn },
    onHydrateCommit: fn => { hydrateCommit = fn },
    isCurrent: token => Object.is(token, liveTransportToken),
    lastOutcome: () => lastOutcome,
    captureCount: () => captures.length,
    busy: () => busy,
    working: () => working,
    async init() { lastOutcome = await presentation.initLiveRemoteSession('s') },
  } as Harness & { init(): Promise<void> }
}

test('scenario 1: running=true with an UNPROVABLE window answers WORKING (the only official fact available)', async () => {
  const h = harness() as ReturnType<typeof harness> & { init(): Promise<void> }
  // hasMore=true and no boundary visible: the window cannot prove the fold
  // (its front is truncated); the official running bit is the only fact.
  h.setWindow([])
  h.setRunning(true)
  await h.init()
  assert.equal(h.busy(), true, 'running=true ⇒ the busy/working UI fact is on (the wake window is work in flight)')
  assert.equal(h.working(), true)
})

test('scenario 2a: running flips true BEFORE the durable turn/start — a COMPLETE window keeps the fold (Direct parity)', async () => {
  const h = harness() as ReturnType<typeof harness> & { init(): Promise<void> }
  // The window is COMPLETE (hasMore=false): the previous turn ended and the
  // new turn/start is not yet durable. running already flipped (wakeDriver)
  // — but the DIRECT surface also folds false here and turns working on when
  // the durable turn/start ARRIVES. The Remote branch must not lead the
  // canonical event-driven presentation: the fold wins on a provable window.
  h.setWindow([
    { type: 'turn/start', seq: 0 },
    { type: 'turn/end', seq: 3 },
  ], false)
  h.setRunning(true)
  await h.init()
  assert.equal(h.working(), false,
    'a complete window keeps the fold — the transient wake gap settles when turn/start lands (Direct parity)')
})

test('scenario 2b: running=false after the last turn/end — the fallback NEVER answers true where the fold answers false', async () => {
  const h = harness() as ReturnType<typeof harness> & { init(): Promise<void> }
  h.setWindow([
    { type: 'turn/start', seq: 0 },
    { type: 'turn/end', seq: 3 },
  ], false)
  h.setRunning(false)
  await h.init()
  assert.equal(h.working(), false)
  assert.equal(h.busy(), false)
})

test('scenario 2c: an unprovable window with running=false (all turns ended outside the window) answers NOT working', async () => {
  const h = harness() as ReturnType<typeof harness> & { init(): Promise<void> }
  // No boundary visible; kick has exited ⇒ every turn ended ⇒ not working.
  h.setWindow([
    { type: 'user/message', seq: 5 },
    { type: 'assistant/message', seq: 6 },
  ])
  h.setRunning(false)
  await h.init()
  assert.equal(h.working(), false)
})

test('scenario 3: a PROVABLE window always prefers the fold — running is only the unprovable-window fallback', async () => {
  const h = harness() as ReturnType<typeof harness> & { init(): Promise<void> }
  // The window proves an OPEN turn (turn/start, no turn/end): the fold is the
  // authority even if the running read lags behind (a torn relay).
  h.setWindow([{ type: 'turn/start', seq: 0 }], false)
  h.setRunning(false)
  await h.init()
  assert.equal(h.working(), true, 'the fold wins when the window proves the boundary (never the raw bit)')
})

test('§6.5 fence: a hydration whose owner was replaced while the reader await elapsed commits NOTHING', async () => {
  const h = harness() as ReturnType<typeof harness> & { init(): Promise<void> }
  h.setWindow([{ type: 'turn/start', seq: 0 }], false)
  h.setRunning(true)
  h.setCurrent(false) // the switch/new/fork won the race during the await
  await h.init()
  assert.equal(h.busy(), undefined, 'a superseded hydration must not commit any visible state')
  assert.equal(h.working(), undefined)
})

test('§6.5 fence: a CURRENT owner commits normally (the fence never blocks the live path)', async () => {
  const h = harness() as ReturnType<typeof harness> & { init(): Promise<void> }
  h.setWindow([{ type: 'turn/start', seq: 0 }], false)
  h.setRunning(false)
  h.setCurrent(true)
  await h.init()
  assert.equal(h.working(), true)
})

test('§6.5 fence: a Connection/binding ROLLOVER during the reader await commits NOTHING (no TUI owner change)', async () => {
  const h = harness() as ReturnType<typeof harness> & { init(): Promise<void> }
  h.setWindow([{ type: 'turn/start', seq: 0 }], false)
  h.setRunning(true)
  // The ownership fence stays CURRENT (no switch/new/fork committed). The
  // transport identity rolls over BETWEEN the fence capture and the commit —
  // i.e. DURING the reader await (the reconnect landed mid-read).
  h.setCurrent(true)
  h.onMidRead(() => { h.rolloverTransport() })
  await h.init()
  assert.equal(h.busy(), undefined, 'a transport rollover without a TUI owner commit still drops the visible commit')
  assert.equal(h.working(), undefined)
})

test('§6.5 seed identity: a rollover AFTER the reader fence still leaves the outcome stamped with the STALE token', async () => {
  const h = harness() as ReturnType<typeof harness> & { init(): Promise<void> }
  h.setWindow([{ type: 'turn/start', seq: 0 }], false)
  h.setRunning(false)
  h.setCurrent(true)
  // The transport rolls over AFTER the reader fence passed (inside the
  // hydrate commit). The commit's outcome must carry the ORIGINAL token —
  // re-capturing there would let a caller stamp the old fold as CURRENT.
  h.onHydrateCommit(() => { h.rolloverTransport() })
  await h.init()
  const outcome = h.lastOutcome()
  assert.ok(outcome !== undefined, 'the post-fence hydrate returns its outcome')
  assert.equal(h.captureCount(), 1,
    'the owner captures the transport token exactly ONCE (across the read), never again at the outcome')
  assert.notEqual(outcome.transportToken, undefined,
    'the outcome carries the token the read was fenced under')
  assert.equal(
    (h as unknown as { isCurrent(token: unknown): boolean }).isCurrent(outcome.transportToken),
    false,
    'the carried token is now STALE — a cache seeded from it must MISS on the next read',
  )
})
