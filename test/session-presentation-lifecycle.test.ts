/**
 * Presentation lifecycle safety: the REAL `createSessionPresentation` owner's
 * generation reset is an INVALIDATION signal (the first-session creation bumps
 * it; a pre-publication failure bumps it while the old owner still stands), so
 * it must NEVER drop the user's active draft — the drop's real production
 * positions are the session runtime's committed post-publication sites (pinned
 * by `test/session-runtime-remote-owner-handoff.test.ts`).
 *
 * This witness exists because the surrounding owner-handoff suite only injects
 * a MOCK `resetForGeneration` (it cannot observe the real presentation reset),
 * and the Tern suites drive the renderer's hydration/clear seam directly. Only
 * this test calls the production `resetForGeneration` and observes the real
 * `clearActiveDraft` seam.
 * @module @xmoon76/dsh-pi-tui/session-presentation-lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionPresentation, type SessionPresentationEvent } from '../src/app/surface/session-presentation.ts'
import { displaySeamStub } from './support/display-seam-stub.ts'
import { toolSummaryKeys } from '../src/tui/transcript/tool-presentation.ts'
import { createOpeningJournal } from '../src/app/surface/opening-journal.ts'
import type { PresentationReadSnapshot } from '../src/runtime/presentation-read-port.ts'
import type { Diag } from '../src/runtime/process/diagnostics.ts'

/**
 * The REAL Remote-branch presentation owner over a controlled window and
 * generation, recording every active-draft clear the presentation issues.
 */
function harness(options: {
  /** S3-R0: the controllable read→commit proof (undefined = superseded). */
  readonly refoldProof?: (
    sessionId: string,
    revision: number,
  ) => { readonly generation: unknown; readonly binding: unknown; readonly revision: number } | undefined
  /** S3-R0: a deterministic read gate (no sleeps). The read captures the
   *  CURRENT window at start and awaits this before returning it. */
  readonly readGate?: () => Promise<void> | undefined
  /** RFL-007: the official `running` bit the working fold defers to. */
  readonly running?: () => boolean
  /** RFL-007: the projected plan authority. */
  readonly plan?: () => boolean
  /** S3-R0: the transport identity seams (a stale token during the read is what
   *  makes `initLiveRemoteSession` return undefined). */
  readonly transport?: {
    readonly capture: (sessionId: string) => unknown
    readonly current: (sessionId: string, token: unknown) => boolean
  }
} = {}): {
  setWindow(events: readonly Record<string, unknown>[], hasMore: boolean, revision?: number): void
  /** The hydrate outcome: undefined means the commit was fenced out. */
  coldHydrate(): Promise<unknown>
  /** S3-R0: the committed proof (or undefined when the read was superseded). */
  rehydrate(): Promise<unknown>
  resetForGeneration(): void
  draftClears(): number
  /** The live presentation bridge (fold identity is the commit witness). */
  presentation: ReturnType<typeof createSessionPresentation<SessionPresentationEvent>>
  /** Every `applyResumedCompaction` commit (external review RFL-001 witness). */
  resumedCompactions(): ReadonlyArray<{ id: string | undefined; active: boolean; phase?: string }>
  /** Every working-fold seed the reconcile published (RFL-007). */
  workingSeeds(): ReadonlyArray<{ sessionId: string; transportToken: unknown; fold: boolean; proven: boolean }>
  /** Every deferred context measurement (RFL-007). */
  initialMeasurements(): readonly string[]
  /** How many times the reconcile marked the context dirty (RFL-009). */
  contextDirty(): number
  /** Every explicit measurement reason the reconcile requested (RFL-009). */
  contextRefreshes(): readonly string[]
  /** Every status-fact commit (RFL-007 planMode witness). */
  statusFacts(): ReadonlyArray<Record<string, unknown>>
} {
  let window: PresentationReadSnapshot | undefined
  let generation = 0
  const app = {
    setBusy: () => {}, setWorking: () => {}, setPlanMode: () => {},
    setSessionTitle: () => {}, setTodoSummary: () => {}, clearLocalMessages: () => {},
    clearNotify: () => {}, clearExitConfirmation: () => {}, setSearchResult: () => {},
    clearSessionOverrides: () => {}, resetInputHistory: () => {},
  }
  const journal = createOpeningJournal<Record<string, unknown>>()
  /** The active-draft drop seam: every call is a dropped user draft. */
  let draftClears = 0
  /** RFL-001 (external review): every resumed-compaction commit the surface saw. */
  const resumedCompactions: Array<{ id: string | undefined; active: boolean; phase?: string }> = []
  /** RFL-007 (internal review): every working-fold seed the commit published. */
  const workingSeeds: Array<{ sessionId: string; transportToken: unknown; fold: boolean; proven: boolean }> = []
  /** RFL-007: every deferred context measurement the tail scheduled. */
  const initialMeasurements: string[] = []
  /** RFL-009: the live `compaction/end` measurement contract (dirty -> measure). */
  let contextDirty = 0
  const contextRefreshes: string[] = []
  /** Every status-fact commit (planMode and friends). */
  const statusFacts: Array<Record<string, unknown>> = []
  const surface = {
    app,
    openingJournal: journal,
    display: displaySeamStub({
      clearActiveDraft: () => { draftClears += 1 },
      commitStatusFacts: (facts: Record<string, unknown>) => { statusFacts.push(facts) },
    }),
    resetSearchPresentation: () => {}, resetTasks: () => {}, resetPendingPresentation: () => {},
    applyResumedCompaction: (id: string | undefined, active: boolean, phase?: string) => { resumedCompactions.push({ id, active, phase }) }, repaint: () => {}, refreshPendingInput: () => {},
    refreshTasks: () => {}, refreshAgents: () => {},
  }
  const diag: Diag = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} } as unknown as Diag
  const presentation = createSessionPresentation<SessionPresentationEvent>({
    surface: surface as never,
    diag,
    summaryKeys: toolSummaryKeys,
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
      updateWelcomeCard: () => {}, scheduleInitialMeasurement: (sessionId: string) => { initialMeasurements.push(sessionId) },
      markContextDirty: () => { contextDirty += 1 }, refreshContextMeasurement: (reason: string) => { contextRefreshes.push(reason) },
    },
    history: { rememberCwd: () => {}, currentCwd: () => '/c', records: () => [], setLastContent: () => {} },
    commands: { register: () => {} },
    submission: { clearPending: () => {} },
    viewer: { resetAutoPop: () => {}, teardownForSessionSwap: () => {} },
    remote: {
      read: async () => {
        // The snapshot is captured at READ START, exactly like the official
        // reader: a held read answers the revision it started on.
        const captured = window
        const gate = options.readGate?.()
        if (gate !== undefined) await gate
        return captured
      },
      running: () => options.running?.() ?? false,
      plan: () => options.plan?.() ?? false,
      // The staleness fence is not this test's subject: every read is current.
      isStillCurrent: () => true,
      captureGeneration: () => generation,
      facts: () => ({}),
      ...(options.refoldProof === undefined ? {} : { windowRefoldProof: options.refoldProof }),
      ...(options.transport === undefined ? {} : {
        captureTransportToken: (sessionId: string) => options.transport!.capture(sessionId),
        isTransportTokenCurrent: (sessionId: string, token: unknown) => options.transport!.current(sessionId, token),
      }),
      seedWindowWorkingFold: input => { workingSeeds.push(input) },
    },
  })
  return {
    setWindow: (events, hasMore, revision = 1) => {
      window = {
        sessionId: 's',
        durableEvents: events as never,
        liveInputs: [],
        revision,
        coverage: hasMore ? 'bounded' : 'full',
        hasMore,
        loadingOlder: false,
        openState: 'open',
      }
    },
    coldHydrate: () => presentation.initLiveRemoteSession('s'),
    rehydrate: () => presentation.rehydrateFromWindow('s'),
    resetForGeneration: () => {
      generation += 1
      presentation.resetForGeneration()
    },
    draftClears: () => draftClears,
    resumedCompactions: () => resumedCompactions,
    workingSeeds: () => workingSeeds,
    initialMeasurements: () => initialMeasurements,
    contextDirty: () => contextDirty,
    contextRefreshes: () => contextRefreshes,
    statusFacts: () => statusFacts,
    presentation,
  }
}

test('S3-R0: the read→commit fence refuses a superseded revision (nothing is replaced)', async () => {
  // The S3-R0 window re-fold is only valid while the official window STILL is
  // the revision that was read; an async read overtaken by a newer revision (or
  // a replaced generation/binding) must commit nothing — otherwise it would
  // overwrite the newer fold and acknowledge a superseded recovery.
  let state: 'current' | 'superseded' = 'current'
  const h = harness({
    refoldProof: () => (state === 'current' ? { generation: 1, binding: {}, revision: 42 } : undefined),
  })
  h.setWindow([], false)
  await h.coldHydrate()
  const before = h.presentation.mainFolder()
  state = 'superseded'
  assert.equal(await h.rehydrate(), undefined, 'a superseded read returns no committed proof')
  assert.ok(Object.is(h.presentation.mainFolder(), before),
    'a superseded read must NOT replace the fold (a newer window owns the transcript)')
  state = 'current'
  const proof = await h.rehydrate()
  assert.notEqual(proof, undefined, 'a still-current read commits and returns its proof')
  assert.ok(!Object.is(h.presentation.mainFolder(), before),
    'the committed read replaced the fold')
})

test('S3-R0: a transport rollover during the cold read makes the hydrate uncommitted (undefined)', async () => {
  // The bootstrap keys its retry on exactly this outcome: `initLiveRemoteSession`
  // returns undefined when the transport token captured BEFORE the read is no
  // longer current at commit time (the G1→undefined→G2 shape).
  let transportCurrent = true
  const h = harness({
    transport: {
      capture: () => ({ generation: 1, binding: {} }),
      current: () => transportCurrent,
    },
  })
  h.setWindow([], false, 7)
  transportCurrent = true
  await h.coldHydrate()
  transportCurrent = false
  assert.equal(await h.coldHydrate(), undefined,
    'the stale transport token makes the hydrate return undefined (what the retry keys on)')
})

test('S3-R0/RFL-001: a window reconcile re-derives the compaction routing state from the committed window', async (t) => {
  // External review RFL-001: the replace path used to run the full cold hydrate,
  // which also reset `compactingId` and the phase/busy/working presentation from
  // the log (`applyResumedCompaction`). The in-place reconcile must restore that
  // same state FROM THE SAME COMMITTED WINDOW, under the same fences.
  const h = harness({
    refoldProof: (_sessionId, revision) => ({ generation: 1, binding: {}, revision }),
  })
  h.setWindow([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'compaction/start', data: { compactionId: 'compact-1' } },
  ], false, 11)
  await h.coldHydrate()
  const afterCold = h.resumedCompactions().at(-1)
  assert.deepEqual(afterCold, { id: 'compact-1', active: true, phase: 'summarizing' },
    'the cold hydrate derives the live bracket')

  // A reconcile whose window still carries the live bracket keeps it.
  h.setWindow([{ type: 'turn/start', data: { turn: 1 } }, { type: 'compaction/start', data: { compactionId: 'compact-1' } }], false, 12)
  const committed = await h.rehydrate()
  assert.notEqual(committed, undefined)
  assert.deepEqual(h.resumedCompactions().at(-1), { id: 'compact-1', active: true, phase: 'summarizing' },
    'the reconcile re-derives the still-live bracket from the committed window')

  // A reconcile whose window carries the END must clear the stale id.
  h.setWindow([
    { type: 'compaction/start', data: { compactionId: 'compact-1' } },
    { type: 'compaction/end', data: { compactionId: 'compact-1' } },
  ], false, 13)
  await h.rehydrate()
  assert.deepEqual(h.resumedCompactions().at(-1), { id: undefined, active: false, phase: 'idle' },
    'a compaction that ended during the outage is cleared, never left stale')

  // A REFUSED reconcile (superseded read) must not touch the state at all.
  let stale = true
  const refused = harness({
    refoldProof: (_sessionId, revision) => (
      stale ? undefined : { generation: 1, binding: {}, revision }
    ),
  })
  refused.setWindow([{ type: 'compaction/start', data: { compactionId: 'compact-3' } }], false, 21)
  await refused.coldHydrate()
  const before = refused.resumedCompactions().length
  stale = true
  refused.setWindow([{ type: 'compaction/end', data: { compactionId: 'compact-3' } }], false, 22)
  assert.equal(await refused.rehydrate(), undefined, 'a superseded read commits nothing')
  assert.equal(refused.resumedCompactions().length, before,
    'a refused reconcile never touches the compaction routing state')
})

test('RFL-007: the reconcile publishes the proven working fold, the plan projection and the compaction-end measurement', async (t) => {
  // The replace path used to run the full cold hydrate, which published the
  // working/busy fold, the projected plan mode and (via the event path) the
  // context measurement after a compaction end. The in-place reconcile must
  // publish the same side effects from the SAME committed window/facts.
  let running = false
  let plan = false
  const h = harness({
    refoldProof: (_sessionId, revision) => ({ generation: 1, binding: {}, revision }),
    running: () => running,
    plan: () => plan,
  })
  // A COMPLETE window with an open turn proves the fold from the log.
  h.setWindow([{ type: 'turn/start', data: { turn: 1 } }], false, 31)
  await h.coldHydrate()
  plan = true
  assert.notEqual(await h.rehydrate(), undefined)
  assert.deepEqual(h.workingSeeds().at(-1), {
    sessionId: 's',
    transportToken: { generation: 1, binding: {} },
    fold: true,
    proven: true,
  }, 'a complete window publishes the PROVEN log fold under the committed transport identity')
  assert.ok(h.statusFacts().some(facts => facts.planMode === true),
    'the projected plan authority is committed, never folded from the window')

  // A TRUNCATED window defers to the official `running` bit (never a guess).
  running = false
  h.setWindow([{ type: 'turn/start', data: { turn: 1 } }], true, 32)
  await h.rehydrate()
  assert.deepEqual(h.workingSeeds().at(-1), {
    sessionId: 's',
    transportToken: { generation: 1, binding: {} },
    fold: false,
    proven: false,
  }, 'a truncated window publishes the official running fallback as UNPROVEN')

  // A boundary that did NOT move (a compaction start alone is not a measure
  // event) stays measurement-free.
  const dirtyBeforeStart = h.contextDirty()
  h.setWindow([{ type: 'compaction/start', data: { compactionId: 'c1' } }], false, 33)
  await h.rehydrate()
  assert.equal(h.contextDirty(), dirtyBeforeStart, 'a compaction START alone does not measure')

  // RFL-009/011: a bracket whose START and END both landed during the outage
  // leaves the committed `active` flag unchanged (inactive -> inactive); the
  // measure-event identity is what notices it, and the reconcile runs the live
  // `compaction/end` contract (mark dirty -> measure).
  h.setWindow([
    { type: 'compaction/start', data: { compactionId: 'c1' } },
    { type: 'compaction/end', data: { compactionId: 'c1' } },
  ], false, 34)
  await h.rehydrate()
  assert.equal(h.contextDirty(), dirtyBeforeStart + 1, 'the swallowed bracket marks the context dirty')
  assert.deepEqual(h.contextRefreshes().at(-1), 'compaction-end',
    'and measures it through the live compaction-end contract')

  // RFL-009: a TURN that ended with no compaction at all is a measure boundary too.
  h.setWindow([
    { type: 'compaction/start', data: { compactionId: 'c1' } },
    { type: 'compaction/end', data: { compactionId: 'c1' } },
    { type: 'turn/start', data: { turn: 2 } },
  ], false, 35)
  await h.rehydrate()
  h.setWindow([
    { type: 'compaction/start', data: { compactionId: 'c1' } },
    { type: 'compaction/end', data: { compactionId: 'c1' } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ], false, 36)
  await h.rehydrate()
  assert.equal(h.contextDirty(), dirtyBeforeStart + 2, 'a turn that ended during the outage measures too')

  // Measure parity with the live fold, on a FRESH owner so the baseline is
  // unambiguous: a STALE end for an older compaction is not a measure boundary
  // (the live routing only measures a MATCHED settle), and the matched end then
  // measures exactly once.
  const parity = harness({ refoldProof: (_sessionId, revision) => ({ generation: 1, binding: {}, revision }) })
  parity.setWindow([{ type: 'turn/start', data: { turn: 1 } }], false, 81)
  await parity.coldHydrate()
  const parityBase = parity.contextDirty()
  parity.presentation.noteLiveMeasureEvent('s', { type: 'compaction/start', data: { compactionId: 'A2' } })
  parity.presentation.noteLiveMeasureEvent('s', { type: 'compaction/start', data: { compactionId: 'B2' } })
  parity.presentation.noteLiveMeasureEvent('s', { type: 'compaction/end', data: { compactionId: 'A2' } })
  parity.setWindow([
    { type: 'compaction/start', data: { compactionId: 'A2' } },
    { type: 'compaction/start', data: { compactionId: 'B2' } },
    { type: 'compaction/end', data: { compactionId: 'A2' } },
  ], false, 82)
  await parity.rehydrate()
  assert.equal(parity.contextDirty(), parityBase,
    'a stale end for A2 does not measure while B2 is in flight')
  parity.setWindow([
    { type: 'compaction/start', data: { compactionId: 'A2' } },
    { type: 'compaction/start', data: { compactionId: 'B2' } },
    { type: 'compaction/end', data: { compactionId: 'A2' } },
    { type: 'compaction/end', data: { compactionId: 'B2' } },
  ], false, 83)
  // The outage swallowed this matched end (no live note): the reconcile measures it.
  await parity.rehydrate()
  assert.equal(parity.contextDirty(), parityBase + 1,
    'the matched end B2 measures exactly once')
  // The tracker must follow a bracket the COLD HYDRATE restored: a later live
  // matched end then advances the baseline, so the next reconcile measures
  // nothing (no double measurement).
  const hydrated = harness({ refoldProof: (_sessionId, revision) => ({ generation: 1, binding: {}, revision }) })
  hydrated.setWindow([{ type: 'compaction/start', data: { compactionId: 'B3' } }], false, 91)
  await hydrated.coldHydrate()
  const hydratedBase = hydrated.contextDirty()
  hydrated.presentation.noteLiveMeasureEvent('s', { type: 'compaction/end', data: { compactionId: 'B3' } })
  hydrated.setWindow([
    { type: 'compaction/start', data: { compactionId: 'B3' } },
    { type: 'compaction/end', data: { compactionId: 'B3' } },
  ], false, 92)
  await hydrated.rehydrate()
  assert.equal(hydrated.contextDirty(), hydratedBase,
    'a live end for the bracket the COLD HYDRATE restored never measures twice')

  // The same parity for a bracket a RECONCILE committed.
  const recommitted = harness({ refoldProof: (_sessionId, revision) => ({ generation: 1, binding: {}, revision }) })
  recommitted.setWindow([{ type: 'compaction/start', data: { compactionId: 'B4' } }], false, 93)
  await recommitted.coldHydrate()
  await recommitted.rehydrate()
  const recommittedBase = recommitted.contextDirty()
  recommitted.presentation.noteLiveMeasureEvent('s', { type: 'compaction/end', data: { compactionId: 'B4' } })
  recommitted.setWindow([
    { type: 'compaction/start', data: { compactionId: 'B4' } },
    { type: 'compaction/end', data: { compactionId: 'B4' } },
  ], false, 94)
  await recommitted.rehydrate()
  assert.equal(recommitted.contextDirty(), recommittedBase,
    'a live end for the bracket a RECONCILE committed never measures twice')

  // And once the live path HAS handled it, a later page reconcile measures nothing.
  parity.presentation.noteLiveMeasureEvent('s', { type: 'compaction/end', data: { compactionId: 'B2' } })
  await parity.rehydrate()
  assert.equal(parity.contextDirty(), parityBase + 1,
    'a live-handled matched end never measures a second time')

  // A boundary the LIVE routing already measured keeps an ordinary page
  // reconcile measurement-free (no false positive on paging).
  h.setWindow([
    { type: 'compaction/start', data: { compactionId: 'c9' } },
    { type: 'compaction/end', data: { compactionId: 'c9' } },
  ], false, 38)
  // A real session saw the START live too (the routing's bracket needs it to
  // recognise the matched end).
  h.presentation.noteLiveMeasureEvent('s', { type: 'compaction/start', data: { compactionId: 'c9' } })
  h.presentation.noteLiveMeasureEvent('s', { type: 'compaction/end', data: { compactionId: 'c9' } })
  const dirtyBeforePrepend = h.contextDirty()
  h.setWindow([
    { type: 'turn/start', data: { turn: 0 } },
    { type: 'compaction/start', data: { compactionId: 'c9' } },
    { type: 'compaction/end', data: { compactionId: 'c9' } },
  ], true, 39)
  await h.rehydrate()
  assert.equal(h.contextDirty(), dirtyBeforePrepend,
    'a page reconcile after a LIVE-measured boundary does not measure again')

  // An unchanged measure boundary keeps the reconcile measurement-free
  // (history/rolling paging).
  // The SAME boundary (an older page joined at the front) stays measurement-free.
  const stableEvents = [
    { type: 'turn/start', data: { turn: 0 } },
    { type: 'compaction/start', data: { compactionId: 'c9' } },
    { type: 'compaction/end', data: { compactionId: 'c9' } },
  ]
  h.setWindow([
    { type: 'turn/start', data: { turn: -1 } },
    ...stableEvents,
  ], true, 40)
  await h.rehydrate()
  assert.equal(h.contextDirty(), dirtyBeforePrepend,
    'a page reconcile whose newest measure boundary is unchanged stays measurement-free')

  // RFL-010: the COLD window is the baseline — a compaction live at hydrate time
  // that ends during the outage must be detected on the FIRST reconcile.
  const cold = harness({
    refoldProof: (_sessionId, revision) => ({ generation: 1, binding: {}, revision }),
  })
  cold.setWindow([{ type: 'compaction/start', data: { compactionId: 'c2' } }], false, 41)
  await cold.coldHydrate()
  assert.equal(cold.contextDirty(), 0)
  cold.setWindow([
    { type: 'compaction/start', data: { compactionId: 'c2' } },
    { type: 'compaction/end', data: { compactionId: 'c2' } },
  ], false, 42)
  await cold.rehydrate()
  assert.equal(cold.contextDirty(), 1,
    'a compaction live at the cold hydrate and ended during the outage measures on the first reconcile')

  // The working/busy BASELINE is published by the RECONCILE itself (the cold
  // hydrate's order), not only by the cold hydrate and not only into the cache:
  // scope the assertion to the facts the reconcile just added.
  const factsBeforeReconcile = h.statusFacts().length
  h.setWindow([{ type: 'turn/start', data: { turn: 4 } }], false, 61)
  await h.rehydrate()
  assert.ok(
    h.statusFacts().slice(factsBeforeReconcile).some(facts => facts.working === true && facts.busy === true),
    'the RECONCILE publishes the working/busy baseline to the visible surface',
  )
  // The prior-true -> turn/end direction: the reconcile must publish false too
  // (an inactive compaction alone never rewrites these fields).
  const factsBeforeEnd = h.statusFacts().length
  const dirtyBeforeEnd = h.contextDirty()
  h.setWindow([
    { type: 'turn/start', data: { turn: 4 } },
    { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
  ], false, 62)
  await h.rehydrate()
  assert.ok(
    h.statusFacts().slice(factsBeforeEnd).some(facts => facts.working === false && facts.busy === false),
    'a reconciled turn end publishes working=false/busy=false, never the stale true',
  )
  assert.equal(h.contextDirty(), dirtyBeforeEnd + 1, 'the reconciled turn end re-measures the context')

  // A `step/start` boundary is a measure event of the SAME classifier class.
  const dirtyBeforeStep = h.contextDirty()
  h.setWindow([
    { type: 'turn/start', data: { turn: 5 } },
    { type: 'step/start', data: { turn: 5, step: 1 } },
  ], false, 63)
  await h.rehydrate()
  assert.equal(h.contextDirty(), dirtyBeforeStep + 1, 'a step/start boundary re-measures the context too')


})

test('compaction window fold uses the LIVE compactionId-matched semantics', async (t) => {
  // The window rebuild must agree with `foldCompactionEvent`: a stale end for an
  // older compaction never settles a newer one, and a matched summary resumes
  // the Applying phase (a history prepend must not regress it to Summarizing).
  const proof = (_sessionId: string, revision: number) => ({ generation: 1, binding: {}, revision })
  const h = harness({ refoldProof: proof })

  // start A -> start B -> end A: B is STILL the live bracket.
  h.setWindow([
    { type: 'compaction/start', data: { compactionId: 'A' } },
    { type: 'compaction/start', data: { compactionId: 'B' } },
    { type: 'compaction/end', data: { compactionId: 'A' } },
  ], false, 71)
  assert.notEqual(await h.rehydrate(), undefined)
  assert.deepEqual(h.resumedCompactions().at(-1), { id: 'B', active: true, phase: 'summarizing' },
    'a stale end for A never settles the newer bracket B')

  // ...then end B settles it.
  h.setWindow([
    { type: 'compaction/start', data: { compactionId: 'A' } },
    { type: 'compaction/start', data: { compactionId: 'B' } },
    { type: 'compaction/end', data: { compactionId: 'A' } },
    { type: 'compaction/end', data: { compactionId: 'B' } },
  ], false, 72)
  await h.rehydrate()
  assert.deepEqual(h.resumedCompactions().at(-1), { id: undefined, active: false, phase: 'idle' },
    'the matching end settles the bracket')

  // start B -> summary B -> PREPEND: the Applying phase survives the re-fold.
  h.setWindow([
    { type: 'compaction/start', data: { compactionId: 'B' } },
    { type: 'compaction/summary', data: { compactionId: 'B' } },
  ], false, 73)
  await h.rehydrate()
  assert.deepEqual(h.resumedCompactions().at(-1), { id: 'B', active: true, phase: 'applying' },
    'a matched summary rebuilds the Applying phase')
  h.setWindow([
    { type: 'turn/start', data: { turn: 0 } },
    { type: 'compaction/start', data: { compactionId: 'B' } },
    { type: 'compaction/summary', data: { compactionId: 'B' } },
  ], true, 74)
  await h.rehydrate()
  assert.deepEqual(h.resumedCompactions().at(-1), { id: 'B', active: true, phase: 'applying' },
    'an ordinary history prepend does NOT regress Applying to Summarizing')

  // ...and a stale summary for another compaction never flips the phase.
  h.setWindow([
    { type: 'compaction/start', data: { compactionId: 'B' } },
    { type: 'compaction/summary', data: { compactionId: 'A' } },
  ], false, 75)
  await h.rehydrate()
  assert.deepEqual(h.resumedCompactions().at(-1), { id: 'B', active: true, phase: 'summarizing' },
    'a summary for a DIFFERENT compaction does not advance the phase')
})

test('S3-R0: read A already in flight → window B commits → A settles last and writes nothing', async (t) => {
  // RFL-003 owner-level barrier through the PRODUCTION rehydrate consumer:
  // A STARTS (captures revision 41), the official window advances to 42 and B
  // commits while A is still awaiting, then A settles last. A must not write and
  // B's fold must survive. The PROOF SEAM here is test-provided and
  // revision-sensitive (the same decision the bootstrap's ingress eligibility
  // makes); the real source→sink path over the official wire is the L6 lane, so
  // this witness is the read→commit fence, not the whole L6 chain. Deterministic
  // gate, no sleeps.
  let officialRevision = 41
  let releaseA: (() => void) | undefined
  let gateA: Promise<void> | undefined
  const h = harness({
    refoldProof: (_sessionId, revision) => (
      revision === officialRevision ? { generation: 1, binding: {}, revision } : undefined
    ),
    readGate: () => (gateA === undefined ? undefined : gateA),
  })
  h.setWindow([], false, 41)
  await h.coldHydrate()
  const before = h.presentation.mainFolder()
  // Read A STARTS while the official window is 41; it is held.
  gateA = new Promise<void>(resolve => { releaseA = resolve })
  // AGENTS.local: a held gate always has a fallback release, so a failing
  // assertion in B cannot leave A pending and poison the process.
  t.after(() => { releaseA?.() })
  const aInFlight = h.rehydrate()
  // The official window advances and B commits while A is still in flight.
  officialRevision = 42
  gateA = undefined
  h.setWindow([], false, 42)
  const proofB = await h.rehydrate()
  assert.notEqual(proofB, undefined, 'B (the current revision) commits')
  const afterB = h.presentation.mainFolder()
  assert.ok(!Object.is(afterB, before), 'B replaced the fold')
  // A settles LAST: it answers revision 41, which the window no longer is.
  releaseA?.()
  assert.equal(await aInFlight, undefined, 'A cannot commit after B')
  assert.ok(Object.is(h.presentation.mainFolder(), afterB), 'A wrote nothing; B remains visible')
})

test('PR3-B §7.3 (F1): the generation reset NEVER drops the active draft (the drop moved to the committed switch)', async () => {
  // The round-6 review's F1 correction witness: the generation reset is an
  // INVALIDATION signal (the first-session creation bumps it; a
  // pre-publication failure bumps it while the old owner stands), so the
  // draft drop must NOT live there. This presentation-level witness pins
  // that `resetForGeneration` never calls the drop seam; the drop's REAL
  // production positions (the session runtime's committed post-publication
  // sites) are pinned by session-runtime-remote-owner-handoff.test.ts.
  const h = harness()
  h.setWindow([], false)
  await h.coldHydrate()
  assert.equal(h.draftClears(), 0, 'an ordinary cold hydrate never drops the draft')
  await h.rehydrate()
  assert.equal(h.draftClears(), 0, 'a same-session window rehydrate never drops the draft')
  h.resetForGeneration()
  assert.equal(h.draftClears(), 0,
    'the generation reset alone NEVER drops the draft (an invalidation, not a confirmed switch — the first-session shape bumps it too)')
  h.resetForGeneration()
  assert.equal(h.draftClears(), 0, 'repeated invalidations keep the draft')
})
