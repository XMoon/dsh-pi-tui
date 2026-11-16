/**
 * The `plan/mode` event's status wiring (FR7): the durable event says the
 * COMMITTED bit only, so the router must (a) publish that bit immediately and
 * (b) re-derive the official plan projection — which alone knows a PENDING
 * selection — instead of assuming the event is the whole plan fact. The
 * composer hint and the footer badge read that one committed projection.
 * @module @xmoon76/dsh-pi-tui/plan-mode-event-facts.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createEventRouting } from '../../src/app/surface/event-routing.ts'
import { createOpeningJournal } from '../../src/app/surface/opening-journal.ts'

interface RoutedEvent {
  readonly type: string
  readonly data: unknown
}

test('a plan/mode event commits the bit AND re-derives the official plan projection', () => {
  const facts: Array<{ planMode?: boolean; planPending?: boolean }> = []
  let refreshes = 0
  const noop = () => {}
  const folder = { apply: noop } as never
  const source = {
    isCleanedUp: () => false,
    isAttachedSession: () => true,
    currentSessionId: () => 'main-session',
    hasLiveAgent: () => true,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => ({
      setTranscript: noop, setStreamingToolPreviews: noop, setTurnActivity: noop,
      applyToolPreview: noop, applyTurnActivity: noop, setStats: noop,
      folder, stats: folder,
    }),
    viewedChildId: () => undefined,
    mainFolder: () => folder,
    viewedChildFolder: () => folder,
    applyGoalChange: noop,
    refreshStatusCheap: () => { refreshes += 1 },
  }
  const routing = createEventRouting<RoutedEvent>({
    source: () => source as never,
    mounted: () => ({
      commitStatusFacts: (next: { planMode?: boolean; planPending?: boolean }) => { facts.push(next) },
    }) as never,
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
  routing.routeSessionEvent({ id: 'main-session' }, { type: 'plan/mode', data: { active: true } })
  assert.deepEqual(facts, [{ planMode: true }],
    'the durable event bit is published immediately (the badge never waits)')
  assert.equal(refreshes, 1,
    'the official plan projection is re-read for the pending selection the event cannot carry')
})
