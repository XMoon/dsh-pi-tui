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
function harness(): {
  setWindow(events: readonly Record<string, unknown>[], hasMore: boolean): void
  coldHydrate(): Promise<void>
  rehydrate(): Promise<void>
  resetForGeneration(): void
  draftClears(): number
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
      read: async () => window,
      running: () => false,
      plan: () => false,
      // The staleness fence is not this test's subject: every read is current.
      isStillCurrent: () => true,
      captureGeneration: () => generation,
      facts: () => ({}),
    },
  })
  return {
    setWindow: (events, hasMore) => {
      window = {
        sessionId: 's',
        durableEvents: events as never,
        liveInputs: [],
        revision: 1,
        coverage: hasMore ? 'bounded' : 'full',
        hasMore,
        loadingOlder: false,
        openState: 'open',
      }
    },
    coldHydrate: () => presentation.initLiveRemoteSession('s').then(() => undefined),
    rehydrate: () => presentation.rehydrateFromWindow('s'),
    resetForGeneration: () => {
      generation += 1
      presentation.resetForGeneration()
    },
    draftClears: () => draftClears,
  }
}

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
