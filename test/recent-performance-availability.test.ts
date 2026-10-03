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
import { createOpeningJournal } from '../src/app/surface/opening-journal.ts'
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

/** The SAME turn as {@link validSampleTurn}, but with a DIFFERENT route
 *  (provider/model): a completed step whose route key changed CLEARS both
 *  recent windows (`RecentPerformanceWindow.observeRoute`). */
function routeChangeTurn(turn: number, seqBase: number, provider: string, model: string) {
  const base = validSampleTurn(turn, seqBase)
  return base.map(event => event.type === 'assistant/message'
    ? { ...event, data: { ...(event.data as Record<string, unknown>), message: { id: `m-${turn}`, role: 'assistant', content: [], source: { kind: 'model', provider, model } } } }
    : event)
}

/** A late authoritative REPLACEMENT of an already-settled step whose decode
 *  range is no longer observable (a single delta): the step's throughput
 *  CANDIDATE leaves the window (`recent.removeThroughput`), so the SAME fold's
 *  evidence shrinks. */
function invalidatingReplacement(turn: number, seqBase: number) {
  return [{
    type: 'assistant/message', seq: seqBase, time: 2_000,
    data: {
      turn, step: 1,
      message: { id: `m-${turn}`, role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 1, outputTokens: 100 },
      stream: [{ type: 'chunk', time: 500, chunk: { type: 'text-delta', index: 0, text: 'a' } }],
    },
  }]
}

interface Harness {
  setWindow(events: Array<Record<string, unknown>>, hasMore: boolean): void
  /** Force every fence stale (the old subject's reads all drop). */
  setCurrent(current: boolean): boolean
  /** Publish a REPLACEMENT owner: bumps the generation so old captured
   *  fences read stale while NEW hydrates (captured after the bump) commit. */
  bumpOwner(): void
  /** Park the NEXT reader resolution until release (the stale window).
   *  The snapshot it eventually returns is the one SET at park time (the
   *  reader captures its payload before parking — a later setWindow must
   *  not leak into a read that already begun). */
  parkNextRead(): { release(): void }
  available(): boolean | undefined
  /** The DIRECT cold hydrate (the complete-log branch). */
  directHydrate(): Promise<void>
  /** Begin a Remote opening journal for `sid` (pre-commit durable events that
   *  reach the runner during the read, merged into the committed fold). */
  beginOpening(sid: string): void
  /** Record one event into the open journal (a no-op when none is open). */
  recordOpening(sid: string, event: Record<string, unknown>): void
  /** The LIVE append pair (what the live ingress performs): apply the newly
   *  appended events to the SAME main stats fold, then re-answer the
   *  availability predicate off that fold. No `loadOlder`/rehydrate involved. */
  applyLive(events: Array<Record<string, unknown>>): void
  /** How many times the availability flip re-derived the status (footer). */
  statusRefreshes(): number
  coldHydrate(): Promise<void>
  rehydrate(): Promise<void>
  /** The synchronous generation-bump reset (the A2 seam). */
  resetForGeneration(): void
}

function harness(): Harness {
  let window: PresentationReadSnapshot | undefined
  let current = true
  // A GENERATION-SCOPED fence (the production §6.5 shape): a hydrate
  // captures the generation at admission and stays admissible only while
  // the generation is unchanged — a REPLACEMENT owner bumps it, so the
  // replacement's own hydrate commits while the OLD read settles as stale.
  let generation = 0
  let parkedResolve: (() => void) | undefined
  let parkedArmed: Promise<void> | undefined
  const app = {
    setBusy: () => {}, setWorking: () => {}, setPlanMode: () => {},
    setSessionTitle: () => {}, setTodoSummary: () => {}, clearLocalMessages: () => {},
    clearNotify: () => {}, clearExitConfirmation: () => {}, setSearchResult: () => {},
    clearSessionOverrides: () => {}, resetInputHistory: () => {},
  }
  const journal = createOpeningJournal<Record<string, unknown>>()
  const surface = {
    app, openingJournal: journal,
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
  let statusRefreshes = 0
  const presentation = createSessionPresentation<SessionPresentationEvent>({
    surface: surface as never,
    diag,
    isCleanedUp: () => false,
    refreshStatusCheap: () => { statusRefreshes += 1 },
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
      // The PRODUCTION §6.5 fence shape: each hydrate captures the
      // generation at admission; the fence answers false once the live
      // generation moved past the captured one (a replacement owner) —
      // AND the global `current` switch still forces staleness for the
      // old-subject reads.
      isStillCurrent: (_sessionId: string, captured: number) => current && captured === generation,
      captureGeneration: () => generation,
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
    bumpOwner: () => { generation += 1 },
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
    directHydrate: () => presentation.initLiveSession({
      session: {
        id: 's',
        header: { cwd: '/c', id: 's' },
        snapshotEvents: () => [],
      },
      options: { provider: 'p', model: 'm' },
    } as never),
    beginOpening: sid => { journal.begin(sid) },
    recordOpening: (sid, event) => { journal.record(sid, event as never) },
    applyLive: events => {
      presentation.mainStats().apply(events as never)
      presentation.main.refreshRecentPerformanceAvailability()
    },
    statusRefreshes: () => statusRefreshes,
    coldHydrate: () => presentation.initLiveRemoteSession('s').then(() => undefined),
    rehydrate: () => presentation.rehydrateFromWindow('s'),
    resetForGeneration: () => {
      generation += 1
      presentation.resetForGeneration()
    },
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
  // Subject A cold-hydrates a TRUNCATED window that proves NOTHING (one
  // sample, hasMore=true): its committed bit is false.
  h.setWindow(validSampleTurn(1, 0), true)
  await h.coldHydrate()
  assert.equal(h.available(), false)
  // A rehydrate for A begins and parks mid-read; its captured snapshot is
  // the window SET AT PARK TIME — a history-start window whose commit
  // would write `true`.
  const gate = h.parkNextRead()
  h.setWindow([], false)
  const stale = h.rehydrate()
  // The owner is REPLACED (the generation bump retires A's captured
  // fences; A's pending rehydrate will settle as stale), and the
  // replacement subject cold-hydrates ITS OWN still-unproven window —
  // captured AFTER the bump, so THIS hydrate genuinely commits.
  h.bumpOwner()
  h.setWindow(validSampleTurn(1, 0), true)
  await h.coldHydrate()
  assert.equal(h.available(), false,
    'the replacement subject\'s own hydrate COMMITTED false (a post-bump capture passes its fence)')
  // Release the stale read: its §6.5 generation fence drops it — the
  // replacement's committed `false` survives. The parked snapshot
  // (history start) would write `true`: exactly the counterfactual this
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


test('F1/PR5 §3.2: a bounded insufficient window becomes AVAILABLE through live appends (no loadOlder)', async () => {
  // The reported defect: availability is shadow state beside the SAME fold, so
  // a truncated window that committed `false` must follow ordinary appended
  // evidence (the live ingress applies to the same fold and re-answers the
  // predicate). It must NOT require a `loadOlder`/rehydrate to flip, and the
  // flip must re-derive the status so the footer/`/status` stop omitting the
  // recent figures in the same step.
  const h = harness()
  h.setWindow(validSampleTurn(1, 0), true)
  await h.coldHydrate()
  assert.equal(h.available(), false, 'fixture check: the truncated window starts UNAVAILABLE')

  // Nine valid completed turns: TTFT is satisfied (>= 5) but the throughput
  // CANDIDATE window (>= 10) is not — the bit must stay down.
  for (let turn = 2; turn <= 10; turn += 1) h.applyLive(validSampleTurn(turn, (turn - 1) * 10))
  assert.equal(h.available(), true,
    'the tenth valid sample completes the throughput candidate window and flips the bit')

  // The flip re-derived the status (the footer reads the bit through the status
  // snapshot, so a silent flip would leave the omitted metrics on screen).
  assert.equal(h.statusRefreshes() >= 1, true,
    'the availability flip must re-derive the status')
})

test('F1/PR5 §3.2: the live flip is monotonic and never fires before the evidence is complete', async () => {
  const h = harness()
  h.setWindow(validSampleTurn(1, 0), true)
  await h.coldHydrate()
  const before = h.statusRefreshes()
  // Nine turns total: still incomplete, so no flip and no status churn from the
  // refresh path (it must not repaint on every append).
  for (let turn = 2; turn <= 9; turn += 1) h.applyLive(validSampleTurn(turn, (turn - 1) * 10))
  assert.equal(h.available(), false, 'an incomplete window stays UNAVAILABLE')
  assert.equal(h.statusRefreshes(), before,
    'no status re-derivation while the evidence is still incomplete')
  // The tenth completes it — exactly one flip.
  h.applyLive(validSampleTurn(10, 90))
  assert.equal(h.available(), true)
  h.applyLive(validSampleTurn(11, 100))
  assert.equal(h.available(), true, 'the bit is monotonic within a generation')
  assert.equal(h.statusRefreshes(), before + 1,
    'exactly one status re-derivation, on the flip')
})


test('F1/PR5 §3.2: an authoritative replacement that invalidates a candidate flips availability BACK to false (true→false in one generation)', async () => {
  // The fold's evidence is NOT monotonic: a late authoritative replacement can
  // remove a throughput candidate (`recent.removeThroughput`), so the SAME fold
  // that proved the window complete can stop proving it. The presentation bit is
  // shadow state for that fold and must follow it in BOTH directions.
  const h = harness()
  h.setWindow(validSampleTurn(1, 0), true)
  await h.coldHydrate()
  // Turns 2..9 close normally (nine candidates).
  for (let turn = 2; turn <= 9; turn += 1) h.applyLive(validSampleTurn(turn, (turn - 1) * 10))
  // Turn 10 settles its message but STAYS OPEN (no turn/end): the fold retains a
  // settled step's sample only until its turn closes, which is exactly the
  // window in which a late authoritative replacement can invalidate it.
  h.applyLive(validSampleTurn(10, 90).slice(0, 3) as Array<Record<string, unknown>>)
  assert.equal(h.available(), true, 'fixture check: the window is complete')
  const before = h.statusRefreshes()
  // Turn 10's candidate is invalidated while it is still open.
  h.applyLive(invalidatingReplacement(10, 200) as Array<Record<string, unknown>>)
  assert.equal(h.available(), false,
    'the bit must follow the fold DOWN when its evidence shrinks')
  assert.equal(h.statusRefreshes(), before + 1,
    'the downward flip re-derives the status too')
})

test('F1/PR5 §3.2: a ROUTE change that clears the fold windows re-answers availability from the CURRENT fold', async () => {
  // `observeRoute` clears both windows on a provider/model change, so the same
  // StatsFolder can go from complete to insufficient without the generation
  // changing.
  const h = harness()
  h.setWindow(validSampleTurn(1, 0), true)
  await h.coldHydrate()
  for (let turn = 2; turn <= 10; turn += 1) h.applyLive(validSampleTurn(turn, (turn - 1) * 10))
  assert.equal(h.available(), true, 'fixture check: the window is complete')
  h.applyLive(routeChangeTurn(11, 100, 'other-provider', 'other-model') as Array<Record<string, unknown>>)
  assert.equal(h.available(), false,
    'a route change resets the fold, so availability must be re-answered as insufficient')
})

test('F1/PR5 §3.2: a history-start window (hasMore=false) STAYS available while its evidence shrinks', async () => {
  // The second, independent authority: a window that provably reaches the
  // history start is authoritative even with zero valid samples, so a route
  // change (or any shrink) must NOT revoke its availability.
  const h = harness()
  h.setWindow([], false)
  await h.coldHydrate()
  assert.equal(h.available(), true, 'fixture check: a history-start window is available with no samples')
  const before = h.statusRefreshes()
  h.applyLive(validSampleTurn(1, 0))
  h.applyLive(routeChangeTurn(2, 10, 'other-provider', 'other-model') as Array<Record<string, unknown>>)
  assert.equal(h.available(), true,
    'the committed history-start fact keeps availability true regardless of retained evidence')
  assert.equal(h.statusRefreshes(), before,
    'no status churn when the answered value does not change')
})


test('F1/PR5 §3.2: DIRECT availability is TRUE by construction and cannot be revoked by a fold-local shrink', async () => {
  // v4: on Direct, availability is unconditionally true — its fold reads the
  // COMPLETE in-process log, so there is no bounded-window completeness question
  // to answer. Committing only the Remote completeness rule (leaving Direct's
  // coverage fact false) let a route change — which clears the retained recent
  // windows — flip Direct availability true -> false through the shared live
  // refresh, hiding TTFT/TPS from the Direct footer and `/status`.
  const h = harness()
  await h.directHydrate()
  assert.equal(h.available(), true, 'Direct is available by construction')
  const before = h.statusRefreshes()
  // A model/provider route change clears the fold's retained windows.
  h.applyLive(routeChangeTurn(1, 0, 'other-provider', 'other-model') as Array<Record<string, unknown>>)
  assert.equal(h.available(), true,
    'a Direct fold-local shrink must never revoke availability')
  assert.equal(h.statusRefreshes(), before,
    'and it must not churn the status: the answered value did not change')
})

test('F1/PR5 §3.2: the Remote availability answer comes from the COMMITTED fold, not the pre-merge snapshot', async () => {
  // The committed fold is built from `snapshot.durableEvents` MERGED with the
  // opening journal's durable events. Answering availability from the pre-merge
  // snapshot (as the earlier implementation did) drifts in BOTH directions: a
  // snapshot that looks complete can be reset by an opening-journal route change
  // that lands in the real fold.
  const h = harness()
  // Ten valid turns in the snapshot: "enough" by the pre-merge view.
  const events: Array<Record<string, unknown>> = []
  for (let turn = 1; turn <= 10; turn += 1) events.push(...validSampleTurn(turn, (turn - 1) * 10))
  h.setWindow(events, true)
  assert.equal(hasEnoughRecentPerformanceSamples(events as never), true,
    'fixture check: the PRE-MERGE snapshot alone looks complete')
  // While the read is parked, the opening journal records a NEW route: after the
  // merge the committed fold has its windows cleared.
  const park = h.parkNextRead()
  const hydrating = h.coldHydrate()
  h.beginOpening('s')
  // A COMPLETE turn for the new route: the route observation only runs on a
  // settled step, so the journal must carry the step's own boundaries.
  for (const event of routeChangeTurn(11, 100, 'other-provider', 'other-model')) {
    h.recordOpening('s', event as Record<string, unknown>)
  }
  park.release()
  await hydrating
  assert.equal(h.available(), false,
    'the answer must come from the COMMITTED (merged) fold, never the pre-merge snapshot')
  // And the reverse direction of the same root cause: after the committed fold
  // really shrinks, an append that cannot restore the window keeps it down.
  h.applyLive(validSampleTurn(12, 200))
  assert.equal(h.available(), false, 'a single further sample cannot re-complete a cleared window')
})
