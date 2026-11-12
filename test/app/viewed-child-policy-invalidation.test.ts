/**
 * M6-1 F8 regression: a VIEWED CHILD's own policy knob event must revoke that
 * child's SessionPolicyObservation truth, not only repaint the footer.
 *
 * The routing's viewed-child branch returns before the main-session knob
 * handling, so without an explicit invalidation the child's footer would keep
 * reading the previously committed ready sandbox/approval snapshot.
 *
 * The router is the REAL `createEventRouting`; only the narrow source and the
 * injection callbacks are stubs (the child branch touches nothing else).
 *
 * @module @xmoon76/dsh-pi-tui/viewed-child-policy-invalidation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createEventRouting } from '../../src/app/surface/event-routing.ts'
import { createOpeningJournal } from '../../src/app/surface/opening-journal.ts'

interface RoutedEvent {
  readonly type: string
  readonly data: unknown
}

function fixture(): {
  readonly routing: ReturnType<typeof createEventRouting<RoutedEvent>>
  readonly invalidations: string[]
  readonly footerRefreshes: () => number
} {
  const invalidations: string[] = []
  let footerRefreshes = 0
  const noop = () => {}
  const folder = { apply: noop } as never
  const source = {
    isCleanedUp: () => false,
    isAttachedSession: () => true,
    currentSessionId: () => 'main-session',
    hasLiveAgent: () => true,
    // MAIN owns no event here: every routed event below belongs to the viewed
    // child, so the main branch is never entered.
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => ({ setTranscript: noop, setStreamingToolPreviews: noop, setTurnActivity: noop }),
    viewedChildId: () => 'child-session',
    viewedChild: () => ({
      applyToolPreview: noop,
      folder,
      stats: folder,
      beginTurn: noop,
      endTurn: noop,
      refreshFooter: () => { footerRefreshes += 1 },
    }),
    mainFolder: () => folder,
    viewedChildFolder: () => folder,
    invalidateSessionPolicy: (sessionId: string) => { invalidations.push(sessionId) },
  }
  const routing = createEventRouting<RoutedEvent>({
    source: () => source as never,
    mounted: () => ({} as never),
    openingJournal: createOpeningJournal<RoutedEvent>(),
    reconcileQuestions: noop,
    refreshAgents: noop,
    refreshAgentRuntimeOnly: noop,
    hasTaskChild: () => false,
    feedCompletionStatus: noop,
    setMainAgentProgress: noop,
    observeMainTurnStart: noop,
    observeMainTurnEnd: noop,
    mainProgressAuthority: 'local-events',
    refreshPendingInput: noop,
    schedulePaint: noop,
    paintNow: noop,
  })
  return { routing, invalidations, footerRefreshes: () => footerRefreshes }
}

test('a viewed child approval/sandbox/preset event revokes the CHILD observation', () => {
  for (const type of ['approval/policy', 'sandbox/mode', 'permission/preset']) {
    const h = fixture()
    h.routing.routeSessionEvent({ id: 'child-session' }, { type, data: {} })
    assert.deepEqual(h.invalidations, ['child-session'],
      `${type}: the child's exact session id must be invalidated`)
    assert.equal(h.footerRefreshes(), 1, `${type}: the footer still refreshes`)
  }
})

test('a viewed child NON-knob event refreshes the footer without a policy invalidation', () => {
  const h = fixture()
  h.routing.routeSessionEvent({ id: 'child-session' }, { type: 'step/end', data: {} })
  assert.deepEqual(h.invalidations, [])
  assert.equal(h.footerRefreshes(), 1)
})
