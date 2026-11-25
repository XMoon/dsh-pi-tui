/**
 * Remote activity lifecycle (F1/F4): the application-level source → decision →
 * sink proof for the Transcript Dock's working/compaction state.
 *
 * The chain under test is ONE in-process composition wired in the SAME order as
 * `app/bootstrap.ts`:
 *
 *   official-shape Session event window (fixture, real `createRemoteLiveIngress`)
 *     → `observeWorkingTurnBoundary` (the REAL startup helper)
 *     → `SurfaceRuntime.routeSessionEvent` (the REAL application router)
 *     → the ONE `StatusStore.activity` (the REAL surface projection)
 *     → the REAL TSP renderer on the pinned SDK's scripted Pane
 *
 * The cold hydrate is the REAL `createSessionPresentation().initLiveRemoteSession`
 * and the working-fold cache is seeded from its committed outcome, exactly like
 * the composition root. The fixture is an official-SHAPE event window (entries,
 * contiguous revision+1 append changes, snapshot subscribers, an exact binding
 * and Connection generation) — NOT a real Host wire.
 *
 * Evidence level: L6 in-process application composition (official-shape durable
 * source + real application owners + scripted SDK pane). NOT run: real Split
 * Client↔Host, a real Tern GUI, and a real Host daemon (owner-excluded for this
 * work).
 *
 * @module @xmoon76/dsh-pi-tui/remote-activity-lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createSurfaceRuntime, type SurfaceRendererMount } from '../../src/app/surface/runtime.ts'
import { createSessionPresentation } from '../../src/app/surface/session-presentation.ts'
import { createSessionStartupHelpers } from '../../src/app/bootstrap/session-startup.ts'
import type { RemoteApplicationSources } from '../../src/app/application-runtime.ts'
import {
  createRemoteLiveIngress,
  type RemoteLiveIngressBinding,
  type RemoteLiveIngressHandle,
  type RemoteLiveIngressSessions,
} from '../../src/app/remote/live-ingress.ts'
import type { SurfaceEventRoutingSource } from '../../src/app/surface/event-routing.ts'
import type { PresentationDurableEvent, PresentationReadSnapshot, PresentationWindowRefoldProof } from '../../src/runtime/presentation-read-port.ts'
import type { RemoteConnectionGeneration, RemoteConnectionGenerationSource } from '../../src/runtime/remote/session-reader-remote.ts'
import type { StatusSnapshot } from '../../src/domain/status/types.ts'
import { mountTspRenderer } from '../../src/tui/tsp/session.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { toolSummaryKeys } from '../../src/tui/transcript/tool-presentation.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { wireNodes } from '../support/tsp-picker-wire.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'

const T0 = 1_700_000_000_000
const SESSION_A = 'session-remote-a'
const SESSION_B = 'session-remote-b'

// ── Official-shape durable source ──────────────────────────────────────────

interface FixtureEntry {
  readonly type: 'event'
  readonly event: PresentationDurableEvent
}

interface FixtureWindow {
  entries: FixtureEntry[]
  revision: number
  hasMore: boolean
  change?: { readonly kind: 'append'; readonly entries: readonly FixtureEntry[] }
}

/** One official retained binding's live window + listeners. A replaced binding
 *  is a NEW runtime object with its OWN listeners (a stale publication to the
 *  old binding can never reach the new one). */
interface BindingRuntime {
  binding: RemoteLiveIngressBinding
  window: FixtureWindow
  readonly eventListeners: Set<() => void>
  readonly snapshotListeners: Set<() => void>
}

interface SourceState {
  running: boolean | undefined
  current: BindingRuntime
}

const noop = (): void => {}
const SILENT_DIAG = createDiag({ filePath: undefined, stderrLevel: 'off' })

function createGenerationSource(): RemoteConnectionGenerationSource & { replace(): void } {
  let serial = 1
  let current: RemoteConnectionGeneration | undefined = { id: serial }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    replace() {
      serial += 1
      current = { id: serial }
      for (const listener of [...listeners]) listener()
    },
  }
}

function createBindingRuntime(entries: readonly FixtureEntry[], revision: number, hasMore: boolean): BindingRuntime {
  const runtime: BindingRuntime = {
    // Assigned immediately below; the closure below only runs after this
    // factory returned.
    binding: undefined as unknown as RemoteLiveIngressBinding,
    window: { entries: [...entries], revision, hasMore },
    eventListeners: new Set(),
    snapshotListeners: new Set(),
  }
  runtime.binding = {
    session: {
      getSnapshot: () => ({ openState: 'open' as const }),
      subscribe(listener: () => void) {
        runtime.snapshotListeners.add(listener)
        return () => { runtime.snapshotListeners.delete(listener) }
      },
      projections: {
        // This scenario follows no current-value projection.
        faceOf: () => ({ subscribe: () => () => {} }),
      },
    },
    eventSource: {
      getSnapshot: () => runtime.window as never,
      subscribe(listener: () => void) {
        runtime.eventListeners.add(listener)
        return () => { runtime.eventListeners.delete(listener) }
      },
    },
  }
  return runtime
}

interface OfficialShapeFixture {
  readonly sessions: RemoteLiveIngressSessions
  currentSessionId(): string | undefined
  ownerGeneration(): number
  setOwner(sessionId: string): void
  createSource(sessionId: string, events: readonly PresentationDurableEvent[], options?: { readonly hasMore?: boolean }): void
  currentRuntime(sessionId: string): BindingRuntime
  replaceBinding(sessionId: string): BindingRuntime
  publish(sessionId: string, event: PresentationDurableEvent): void
  publishRuntime(runtime: BindingRuntime, event: PresentationDurableEvent): void
  setRunning(sessionId: string, running: boolean | undefined): void
  running(sessionId: string): boolean | undefined
  read(sessionId: string): Promise<PresentationReadSnapshot | undefined>
  reads(): number
  generationSource(): RemoteConnectionGenerationSource
  generate(): unknown
  bumpConnectionGeneration(): void
  captureTransportToken(sessionId: string): unknown
  isTransportTokenCurrent(sessionId: string, token: unknown): boolean
}

function createOfficialShapeFixture(sessionId: string, events: readonly PresentationDurableEvent[], hasMore: boolean): OfficialShapeFixture {
  const generation = createGenerationSource()
  const sources = new Map<string, SourceState>()
  let currentSessionId: string | undefined = sessionId
  let ownerGeneration = 1
  let reads = 0

  const requireSource = (id: string): SourceState => {
    const source = sources.get(id)
    if (source === undefined) throw new Error(`the fixture has no source for ${id}`)
    return source
  }
  const createSource = (id: string, entries: readonly PresentationDurableEvent[], options?: { readonly hasMore?: boolean }): void => {
    sources.set(id, {
      running: false,
      current: createBindingRuntime(entries.map(event => ({ type: 'event', event })), 1, options?.hasMore === true),
    })
  }
  createSource(sessionId, events, { hasMore })

  const publishRuntime = (runtime: BindingRuntime, event: PresentationDurableEvent): void => {
    const entry: FixtureEntry = { type: 'event', event }
    runtime.window = {
      entries: [...runtime.window.entries, entry],
      revision: runtime.window.revision + 1,
      hasMore: runtime.window.hasMore,
      change: { kind: 'append', entries: [entry] },
    }
    for (const listener of [...runtime.eventListeners]) listener()
  }

  return {
    sessions: { binding: id => sources.get(id)?.current.binding },
    currentSessionId: () => currentSessionId,
    ownerGeneration: () => ownerGeneration,
    setOwner(id) {
      currentSessionId = id
      ownerGeneration += 1
    },
    createSource,
    currentRuntime: id => requireSource(id).current,
    replaceBinding(id) {
      const source = requireSource(id)
      const previous = source.current
      source.current = createBindingRuntime(previous.window.entries, previous.window.revision + 1, previous.window.hasMore)
      return previous
    },
    publish: (id, event) => { publishRuntime(requireSource(id).current, event) },
    publishRuntime,
    setRunning: (id, running) => { requireSource(id).running = running },
    running: id => sources.get(id)?.running,
    read: async (id) => {
      reads += 1
      const source = sources.get(id)
      if (source === undefined) return undefined
      const window = source.current.window
      return {
        sessionId: id,
        durableEvents: window.entries.map(entry => entry.event),
        liveInputs: [],
        revision: window.revision,
        coverage: window.hasMore ? 'bounded' : 'full',
        hasMore: window.hasMore,
        loadingOlder: false,
        openState: 'open',
      }
    },
    reads: () => reads,
    generationSource: () => generation,
    generate: () => generation.getSnapshot(),
    bumpConnectionGeneration: () => { generation.replace() },
    captureTransportToken: id => {
      const source = sources.get(id)
      if (source === undefined) return undefined
      return { generation: generation.getSnapshot(), binding: source.current.binding }
    },
    isTransportTokenCurrent: (id, token) => {
      const source = sources.get(id)
      if (source === undefined) return false
      const value = token as { readonly generation?: unknown; readonly binding?: unknown } | undefined
      return value !== undefined
        && Object.is(value.binding, source.current.binding)
        && Object.is(value.generation, generation.getSnapshot())
    },
  }
}

// ── Events ─────────────────────────────────────────────────────────────────

let seq = 0
function durable(type: string, data: Record<string, unknown> = {}): PresentationDurableEvent {
  seq += 1
  return { type, seq, time: T0 + seq, data }
}
const turnStart = (turn = 1): PresentationDurableEvent => durable('turn/start', { turn })
const turnEnd = (turn = 1): PresentationDurableEvent => durable('turn/end', { turn, reason: { kind: 'completed' } })
const compactionStart = (id = 'c1'): PresentationDurableEvent => durable('compaction/start', { compactionId: id, turn: null })
const compactionSummary = (id = 'c1'): PresentationDurableEvent => durable('compaction/summary', {
  compactionId: id,
  summary: [{ type: 'text', text: 'compacted body' }],
  shadowedSeqs: [],
  shadowedTokenCount: 10,
})
const compactionEnd = (id: string | undefined = 'c1', error?: string): PresentationDurableEvent => durable(
  'compaction/end',
  error === undefined ? { compactionId: id } : { compactionId: id, error },
)
const userMessage = (text: string): PresentationDurableEvent => durable('user/message', {
  id: `user-${seq}`,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

// ── Harness ────────────────────────────────────────────────────────────────

const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

/** One ingress subscription: the REAL sinks plus its own recovery log. */
interface SubscriptionLog {
  refolds: Array<string | undefined>
  snapshots: number
  projections: number
}

interface LifecycleHarness {
  readonly pane: TspPane
  readonly fixture: OfficialShapeFixture
  readonly surface: ReturnType<typeof createSurfaceRuntime<SessionEvent>>
  readonly startup: ReturnType<typeof createSessionStartupHelpers>
  readonly presentation: ReturnType<typeof createSessionPresentation<SessionEvent>>
  activity(): StatusSnapshot['activity']
  /** Every committed activity projection, in store order. */
  activityCommits(): ReadonlyArray<{ readonly phase: string; readonly busy: boolean }>
  runSegment(): string | undefined
  notices(): ReadonlyArray<{ readonly text: string; readonly kind: string }>
  contextMeasures(): readonly string[]
  reads(): number
  publish(event: PresentationDurableEvent): void
  publishRuntime(runtime: BindingRuntime, event: PresentationDurableEvent): void
  setRunning(running: boolean | undefined): void
  hydrate(sessionId?: string): Promise<void>
  switchOwner(sessionId: string, events: readonly PresentationDurableEvent[], options?: { readonly hasMore?: boolean; readonly running?: boolean }): Promise<void>
  logs(): ReadonlyArray<SubscriptionLog>
  dispose(): Promise<void>
}

async function mountLifecycleHarness(options: {
  readonly sessionId?: string
  readonly window: readonly PresentationDurableEvent[]
  readonly hasMore?: boolean
  readonly running?: boolean
}): Promise<LifecycleHarness> {
  const sessionId = options.sessionId ?? SESSION_A
  const pane = installTspPane({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'status', 'seg'] })
  const { connect } = await import('@stencil-hq/tern')
  const session = await connect({ env: {}, input: pane.input, output: pane.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')

  const fixture = createOfficialShapeFixture(sessionId, options.window, options.hasMore === true)
  fixture.setRunning(sessionId, options.running ?? false)
  const ingress = createRemoteLiveIngress(fixture.sessions, fixture.generationSource())

  const handles: RemoteLiveIngressHandle[] = []
  const logs: SubscriptionLog[] = []
  const notices: Array<{ text: string; kind: string }> = []
  const activityCommits: Array<{ phase: string; busy: boolean }> = []

  const remoteSources = {
    presentationReader: { read: (id: string) => fixture.read(id) },
    liveIngress: ingress,
    sessionFacts: {
      captureTransportToken: (id: string) => fixture.captureTransportToken(id),
      isTransportTokenCurrent: (id: string, token: unknown) => fixture.isTransportTokenCurrent(id, token),
      running: (id: string) => fixture.running(id),
      plan: () => undefined,
    },
  } as unknown as RemoteApplicationSources

  const surface = createSurfaceRuntime<SessionEvent>({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation,
    notificationMode: undefined,
    notificationMethod: undefined,
    mainProgressAuthority: 'host-snapshot',
    terminalProgress: undefined,
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
  })

  const startup = createSessionStartupHelpers({
    isRemote: true,
    pendingPresetId: () => undefined,
    launchPresetId: () => undefined,
    resolvePresetRoster: () => undefined,
    warn: noop,
    diag: SILENT_DIAG,
    composeDirect: async () => { throw new Error('the Remote branch never composes a Direct agent') },
    currentAgent: () => undefined,
    composedPresetRoster: () => undefined,
    recordedPresetOf: () => undefined,
    currentSessionId: () => fixture.currentSessionId(),
    sessionPresetProjectionOf: () => undefined,
    sessionBlankOf: () => undefined,
    generation: () => fixture.ownerGeneration(),
    remoteSources,
  })

  const contextMeasures: string[] = []
  let contextDirty = 0
  const presentation = createSessionPresentation<SessionEvent>({
    surface: surface as never,
    diag: SILENT_DIAG,
    summaryKeys: toolSummaryKeys,
    isCleanedUp: () => false,
    refreshStatusCheap: noop,
    folds: { title: () => undefined },
    direct: {
      installModelSelection: noop,
      assistantStreamBaselineFor: () => [],
      planActive: () => false,
      effectiveCwd: () => undefined,
    },
    status: {
      setGoalText: noop,
      refresh: noop,
      refreshTerminalTitle: noop,
      refreshTerminalCwd: noop,
      updateWelcomeCard: noop,
      scheduleInitialMeasurement: noop,
      markContextDirty: () => { contextDirty += 1 },
      refreshContextMeasurement: reason => { contextMeasures.push(reason) },
    },
    history: {
      rememberCwd: noop,
      currentCwd: () => '/tmp',
      records: () => [],
      setLastContent: noop,
      readSessionRecall: async () => ({ entries: [], writeIds: [] }),
    },
    currentness: {
      captureGeneration: () => fixture.ownerGeneration(),
      isStillCurrent: (id, generation) => fixture.currentSessionId() === id && fixture.ownerGeneration() === generation,
    },
    commands: { register: noop },
    submission: { clearPending: noop },
    viewer: { resetAutoPop: noop, teardownForSessionSwap: noop },
    remote: {
      read: id => fixture.read(id),
      running: id => fixture.running(id),
      plan: () => ({ active: false, pending: false }),
      facts: () => ({}),
      captureGeneration: () => fixture.ownerGeneration(),
      isStillCurrent: (id, generation) => fixture.currentSessionId() === id && fixture.ownerGeneration() === generation,
      captureTransportToken: id => fixture.captureTransportToken(id),
      isTransportTokenCurrent: (id, token) => fixture.isTransportTokenCurrent(id, token),
      windowRefoldProof: (id, revision): PresentationWindowRefoldProof | undefined => {
        const token = fixture.captureTransportToken(id) as { readonly generation?: unknown; readonly binding?: unknown } | undefined
        if (token === undefined) return undefined
        const runtime = fixture.currentRuntime(id)
        if (runtime.window.revision !== revision) return undefined
        return { generation: token.generation, binding: token.binding, revision }
      },
      seedWindowWorkingFold: input => {
        startup.seedWorkingFold({
          generation: fixture.ownerGeneration(),
          sessionId: input.sessionId,
          transportToken: input.transportToken,
          fold: input.fold,
          proven: input.proven,
        })
      },
    },
  })

  const routingSource: SurfaceEventRoutingSource<SessionEvent> = {
    isCleanedUp: () => false,
    isAttachedSession: session => session.id === fixture.currentSessionId(),
    currentSessionId: () => fixture.currentSessionId(),
    hasLiveAgent: () => true,
    completionOwnerId: () => undefined,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => presentation.main,
    viewedChildId: () => undefined,
    viewedChild: () => { throw new Error('no viewer in this harness') },
    mainFolder: () => presentation.mainFolder(),
    viewedChildFolder: () => { throw new Error('no viewer in this harness') },
    pendingSubjectId: () => undefined,
    pendingSnapshot: () => undefined,
    submissionEchoes: () => undefined,
    queueTextOf: () => '',
    exitView: noop,
    refreshStatusCheap: noop,
    refreshStatusAndWelcome: noop,
    refreshWorkspaceFacts: noop,
    applyGoalChange: noop,
    sessionTitleOf: () => undefined,
    extendLoadedHistory: () => false,
    settleLocalSubmitAck: noop,
    markSubmitLatency: noop,
    observeDurableSubmission: noop,
    observeDirectPendingSubmissionEvent: () => false,
    markContextDirty: () => { contextDirty += 1 },
    refreshContextMeasurement: reason => { contextMeasures.push(reason) },
    currentWorkingFromLog: () => startup.currentWorkingFromLog(),
    flushTurn: noop,
    registeredAgentIs: () => false,
    isCurrentOwnerAgent: () => false,
    viewedChildAgent: () => undefined,
    setViewedChildAgent: noop,
    setViewedQueueAgent: noop,
    agentForSession: () => undefined,
    applyViewedChildAssistantInput: () => { throw new Error('no viewer in this harness') },
    applyMainAssistantInput: input => presentation.applyAssistantInput(input),
  }
  surface.attachEventRouting(routingSource)

  let mounted: ReturnType<typeof mountTspRenderer> | undefined
  const renderer: SurfaceRendererMount = {
    mount: (binding, statusReader) => {
      mounted = mountTspRenderer(session, { copyVisual: async () => false, requestExit: noop })
      // The production mount binds the ONE committed-status reader before the
      // image binding; the activity row paints from that formal snapshot.
      mounted.bindStatusReader(statusReader)
      mounted.bindImages(binding)
      // Record the ONE notify sink the routing reaches (the error-path proof)
      // while forwarding the real call unchanged.
      const originalNotify = mounted.display.notify
      mounted.display.notify = (text, kind) => {
        notices.push({ text, kind: kind ?? 'info' })
        originalNotify(text, kind)
      }
      return mounted
    },
    releaseUnmounted: async () => { await mounted?.dispose() },
  }
  surface.start({
    events: { onSubmit: noop, onExit: noop },
    renderer,
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
    readImage: () => Promise.reject(new Error('not exercised')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    captureHistoryScope: () => ({ sessionId, isCurrent: () => true }),
    onTerminalResize: noop,
    copySelection: async () => false,
    deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
    openExternalUrl: noop,
    readClipboardText: async () => undefined,
    imageFallbackColor: text => text,
  })
  assert.ok(mounted !== undefined, 'the renderer mounted')

  // The ONE activity store is observed through its own subscription: the same
  // synchronous listener a TSP painter/consumer sees.
  surface.status.subscribe(snapshot => {
    activityCommits.push({ phase: snapshot.activity.phase, busy: snapshot.activity.busy })
  })

  const sinksFor = (log: SubscriptionLog) => ({
    onDurableEvent: (id: string, event: PresentationDurableEvent): void => {
      // The PRODUCTION order (bootstrap.ts): advance the discardable Turn fold
      // first, then route the same durable event, then record its measure
      // boundary.
      startup.observeWorkingTurnBoundary(id, event)
      surface.routeSessionEvent({ id }, event as unknown as SessionEvent)
      presentation.noteLiveMeasureEvent(id, event)
    },
    onLiveInput: noop,
    onWindowRefoldRequired: (_id: string, reason?: string): void => { log.refolds.push(reason) },
    onSessionSnapshotChanged: (): void => { log.snapshots += 1 },
    onProjectionsChanged: (): void => { log.projections += 1 },
  })

  const hydrate = async (target: string): Promise<void> => {
    const outcome = await presentation.initLiveRemoteSession(target)
    assert.ok(outcome !== undefined, `the cold hydrate committed for ${target}`)
    startup.seedWorkingFold({
      generation: fixture.ownerGeneration(),
      sessionId: target,
      transportToken: outcome.transportToken,
      fold: outcome.working,
      proven: outcome.proven,
    })
    const log: SubscriptionLog = { refolds: [], snapshots: 0, projections: 0 }
    handles.push(ingress.subscribe(target, sinksFor(log), {
      revision: outcome.revision,
      transportToken: outcome.transportToken,
    }))
    logs.push(log)
  }

  await hydrate(sessionId)

  const runSegment = (): string | undefined => {
    const nodes = wireNodes(pane)
    for (const node of nodes) {
      if (node.k !== 'seg' || node.p.key !== 'status-r1-run') continue
      return typeof node.p.text === 'string' ? node.p.text : ''
    }
    return undefined
  }

  return {
    pane,
    fixture,
    surface,
    startup,
    presentation,
    activity: () => surface.status.snapshot().activity,
    activityCommits: () => activityCommits,
    runSegment,
    notices: () => notices,
    contextMeasures: () => [...contextMeasures],
    reads: () => fixture.reads(),
    publish: event => {
      const id = fixture.currentSessionId()
      assert.ok(id !== undefined, 'a session is current')
      fixture.publish(id, event)
    },
    publishRuntime: (runtime, event) => { fixture.publishRuntime(runtime, event) },
    setRunning: running => {
      const id = fixture.currentSessionId()
      assert.ok(id !== undefined, 'a session is current')
      fixture.setRunning(id, running)
    },
    hydrate,
    async switchOwner(target, events, options) {
      for (const handle of handles.splice(0, handles.length)) handle.dispose()
      fixture.createSource(target, events, { hasMore: options?.hasMore === true })
      fixture.setRunning(target, options?.running ?? false)
      fixture.setOwner(target)
      presentation.resetForGeneration()
      surface.resetSubjectStatus()
      await hydrate(target)
    },
    logs: () => logs,
    async dispose() {
      for (const handle of handles.splice(0, handles.length)) handle.dispose()
      try {
        surface.dispose()
        await surface.whenRendererReleased()
      } finally {
        pane.restore()
      }
    },
  }
}

const drawn = async (label: string, predicate: () => boolean): Promise<void> => {
  await waitUntil(label, predicate, 5_000)
}

function assertActivity(
  harness: LifecycleHarness,
  phase: StatusSnapshot['activity']['phase'],
  busy: boolean,
  label: string,
): void {
  const activity = harness.activity()
  assert.equal(activity.phase, phase, `${label}: phase`)
  assert.equal(activity.busy, busy, `${label}: busy is its own machine fact`)
}

// ── A: the reported false-Working direction ─────────────────────────────────

test('A: a live turn end followed by a standalone compaction settles Idle (no false Working)', async () => {
  const harness = await mountLifecycleHarness({ window: [turnStart(1)] })
  try {
    await drawn('the hydrated working row', () => harness.runSegment() !== undefined)
    assertActivity(harness, 'working', true, 'the complete window proves the open turn')

    const beforeTurnEnd = harness.activityCommits().length
    harness.publish(turnEnd(1))
    assert.deepEqual(harness.activityCommits().slice(beforeTurnEnd), [{ phase: 'idle', busy: false }],
      'the turn end is ONE self-consistent activity snapshot')
    assertActivity(harness, 'idle', false, 'the live turn boundary settles the work')
    harness.setRunning(false)

    harness.publish(compactionStart('standalone'))
    assertActivity(harness, 'compacting', true, 'a standalone compaction arms busy')
    await drawn('the compacting row', () => harness.runSegment()?.includes('compact') === true)

    const beforeSettle = harness.activityCommits().length
    harness.publish(compactionEnd('standalone'))
    assert.deepEqual(harness.activityCommits().slice(beforeSettle), [{ phase: 'idle', busy: false }],
      'the matched settle is ONE snapshot: no intermediate phase=idle,busy=true')
    assertActivity(harness, 'idle', false, 'the matched settle releases the false Working')
    await drawn('the run seg leaves the row', () => harness.runSegment() === undefined)
    assert.equal(harness.fixture.running(SESSION_A), false,
      'the official SessionSnapshot.running stays its own, separately readable fact')
  } finally {
    await harness.dispose()
  }
})

// ── B: the reported premature-Idle direction ────────────────────────────────

test('B: an in-turn compaction settles back to Working, and the real turn end then settles Idle', async () => {
  const harness = await mountLifecycleHarness({ window: [turnStart(1), turnEnd(1)] })
  try {
    assertActivity(harness, 'idle', false, 'the complete idle window hydrates idle')

    harness.publish(turnStart(2))
    assertActivity(harness, 'working', true, 'the live turn start opens the work')
    harness.publish(compactionStart('in-turn'))
    harness.publish(compactionSummary('in-turn'))
    assertActivity(harness, 'applying-compaction', true, 'the matched summary advances the phase')
    await drawn('the applying row', () => harness.runSegment()?.includes('apply-compact') === true)

    const beforeInTurnSettle = harness.activityCommits().length
    harness.publish(compactionEnd('in-turn'))
    assert.deepEqual(harness.activityCommits().slice(beforeInTurnSettle), [{ phase: 'working', busy: true }],
      'the settlement is ONE working snapshot, never a transient idle')
    assertActivity(harness, 'working', true,
      'the matched end must NOT clear a still-open turn (premature Idle direction)')
    await drawn('the work row', () => harness.runSegment()?.includes('work') === true)

    const beforeTurnEnd = harness.activityCommits().length
    harness.publish(turnEnd(2))
    assert.deepEqual(harness.activityCommits().slice(beforeTurnEnd), [{ phase: 'idle', busy: false }],
      'the real turn end is ONE idle snapshot')
    assertActivity(harness, 'idle', false, 'the REAL turn end is the only idle transition')
    await drawn('the run seg leaves after the real turn end', () => harness.runSegment() === undefined)
  } finally {
    await harness.dispose()
  }
})

// ── C: turn end before the compaction settles ───────────────────────────────

test('C: a turn end inside an active compaction keeps busy until the matched end', async () => {
  const harness = await mountLifecycleHarness({ window: [turnStart(1), turnEnd(1)] })
  try {
    harness.publish(turnStart(2))
    harness.publish(compactionStart('c-mid'))
    assertActivity(harness, 'compacting', true, 'the compaction owns the phase')

    const beforeTurnEnd = harness.activityCommits().length
    harness.publish(turnEnd(2))
    assert.deepEqual(harness.activityCommits().slice(beforeTurnEnd), [],
      'the derived activity is already compacting/true: no inconsistent intermediate snapshot is published')
    assertActivity(harness, 'compacting', true,
      'the interrupted turn closes before its compaction settles: busy stays armed')
    await drawn('the compacting row survives', () => harness.runSegment()?.includes('compact') === true)

    const beforeSettle = harness.activityCommits().length
    harness.publish(compactionEnd('c-mid'))
    assert.deepEqual(harness.activityCommits().slice(beforeSettle), [{ phase: 'idle', busy: false }],
      'the matched end is ONE idle snapshot')
    assertActivity(harness, 'idle', false, 'only the matched compaction end releases busy')
    await drawn('the settled row', () => harness.runSegment() === undefined)
  } finally {
    await harness.dispose()
  }
})

// ── D: the error settle and the unmatched ends ──────────────────────────────

test('D: a matched error end notifies once and settles; unmatched/idless/repeated ends change nothing', async () => {
  const harness = await mountLifecycleHarness({ window: [turnStart(1), turnEnd(1)] })
  try {
    harness.publish(compactionStart('c-err'))
    harness.publish(compactionEnd('c-err', 'llm failed'))
    assertActivity(harness, 'idle', false, 'a failed matched end still settles the state')
    assert.equal(harness.notices().length, 1, 'the matched failure notifies exactly once')
    assert.equal(harness.notices()[0]?.kind, 'error', 'the failure keeps its visible error kind')
    assert.ok(harness.notices()[0]?.text.includes('llm failed'), 'the Host reason reaches the notice')

    const commits = harness.activityCommits().length
    const measures = harness.contextMeasures().length
    harness.publish(compactionEnd(undefined))
    harness.publish(compactionEnd('foreign'))
    harness.publish(compactionEnd('c-err'))
    assert.equal(harness.activityCommits().length, commits,
      'unmatched/idless/repeated ends never republish activity')
    assert.equal(harness.contextMeasures().length, measures,
      'unmatched/idless/repeated ends never re-measure the context')
    assert.equal(harness.notices().length, 1, 'unmatched ends never notify again')
    assertActivity(harness, 'idle', false, 'no stale end resurrects the compaction')
  } finally {
    await harness.dispose()
  }
})

// ── E: the unproven window fallback + the first live proof ─────────────────

test('E: a truncated-window running fallback is replaced by the first live boundary and never overridden by a later running bit', async () => {
  const harness = await mountLifecycleHarness({ window: [userMessage('outside the window')], hasMore: true, running: true })
  try {
    assertActivity(harness, 'working', true, 'an unprovable window falls back to the official running bit')

    harness.publish(turnEnd(1))
    assert.equal(harness.startup.currentWorkingFromLog(), false,
      'the live boundary is the proven answer even though the running bit still says true')
    assertActivity(harness, 'idle', false, 'the live boundary settles the row')

    // The Host running bit lagging behind must not override the later proof.
    harness.setRunning(true)
    harness.publish(compactionStart('c-after'))
    harness.publish(compactionEnd('c-after'))
    assertActivity(harness, 'idle', false,
      'the matched settle reads the proven fold, never the lagging running bit')
  } finally {
    await harness.dispose()
  }
})

// ── F: owner/generation/binding fences ─────────────────────────────────────

test('F: a retired owner or replaced same-id binding never moves the new Dock; a legal new hydrate does', async () => {
  const harness = await mountLifecycleHarness({ window: [turnStart(1), turnEnd(1)] })
  try {
    assertActivity(harness, 'idle', false, 'owner A starts idle')
    harness.publish(turnStart(2))
    assertActivity(harness, 'working', true, 'owner A is legitimately working')

    // A NEW Session commits: the old ingress handle is disposed with the owner,
    // and the surface resets. A late publication from A's source must not move B.
    const staleRuntimeA = harness.fixture.currentRuntime(SESSION_A)
    await harness.switchOwner(SESSION_B, [turnStart(1), turnEnd(1)])
    assertActivity(harness, 'idle', false, 'owner B hydrates its own idle state')
    // The ingress dispatch is synchronous and this handle was disposed with
    // its owner, so the stale publication cannot schedule a deferred delivery.
    harness.publishRuntime(staleRuntimeA, turnStart(9))
    assertActivity(harness, 'idle', false, 'a retired owner event never turns B working')

    // The same Session ID with a REPLACED binding + Connection generation: a
    // stale publication on the old binding is never delivered as an increment.
    const staleRuntimeB = harness.fixture.currentRuntime(SESSION_B)
    harness.fixture.setOwner(SESSION_B)
    harness.fixture.replaceBinding(SESSION_B)
    harness.presentation.resetForGeneration()
    harness.surface.resetSubjectStatus()
    await harness.hydrate(SESSION_B)
    assertActivity(harness, 'idle', false, 'the replacement binding hydrates its own window')
    // The OLD binding's publish path sees the replaced exact binding and
    // disposes synchronously; no deferred increment exists to wait for.
    harness.publishRuntime(staleRuntimeB, turnStart(10))
    assertActivity(harness, 'idle', false, 'a stale binding publication never reaches the new Dock')

    // The new legal owner is still fully functional.
    harness.publish(turnStart(3))
    assertActivity(harness, 'working', true, 'the current binding still drives the Dock')
    await drawn('the working row after the legal event', () => harness.runSegment() !== undefined)
  } finally {
    await harness.dispose()
  }
})

// ── G: the matched settle performs no extra window read ─────────────────────

test('G: a matched compaction settle triggers no full-window read (F4 falsifiable control)', async () => {
  const harness = await mountLifecycleHarness({ window: [turnStart(1), turnEnd(1)] })
  try {
    const afterHydrate = harness.reads()
    assert.equal(afterHydrate, 1, 'the cold hydrate read the window exactly once')

    harness.publish(turnStart(2))
    harness.publish(compactionStart('c-no-read'))
    harness.publish(compactionSummary('c-no-read'))
    harness.publish(compactionEnd('c-no-read'))
    assert.equal(harness.reads(), afterHydrate,
      'the matched settle must not start a background full-window read/clone')
    // A deleted background task would have been INVOKED synchronously in the
    // settle and settled within these microtask turns; a later one would still
    // read the same counter.
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(harness.reads(), afterHydrate,
      'no detached task may read the window after the settle either')
    assertActivity(harness, 'working', true, 'the in-turn compaction still settles correctly')
  } finally {
    await harness.dispose()
  }
})
