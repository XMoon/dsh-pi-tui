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
  const surface = {
    app,
    openingJournal: journal,
    display: displaySeamStub({ clearActiveDraft: () => { draftClears += 1 } }),
    resetSearchPresentation: () => {}, resetTasks: () => {}, resetPendingPresentation: () => {},
    applyResumedCompaction: () => {}, repaint: () => {}, refreshPendingInput: () => {},
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
      updateWelcomeCard: () => {}, scheduleInitialMeasurement: () => {},
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
      running: () => false,
      plan: () => false,
      // The staleness fence is not this test's subject: every read is current.
      isStillCurrent: () => true,
      captureGeneration: () => generation,
      facts: () => ({}),
      ...(options.refoldProof === undefined ? {} : { windowRefoldProof: options.refoldProof }),
      ...(options.transport === undefined ? {} : {
        captureTransportToken: (sessionId: string) => options.transport!.capture(sessionId),
        isTransportTokenCurrent: (sessionId: string, token: unknown) => options.transport!.current(sessionId, token),
      }),
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

test('S3-R0: read A already in flight → window B commits → A settles last and writes nothing', async () => {
  // RFL-003 owner-level barrier through the PRODUCTION rehydrate consumer:
  // A STARTS (captures revision 41), the official window advances to 42 and B
  // commits while A is still awaiting, then A settles last. A must not write and
  // B's fold must survive. Deterministic gate, no sleeps.
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
