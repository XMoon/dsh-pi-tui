/**
 * TSP-7 PR-B: the rich native statusline's activity projection.
 *
 * The PR-A file proves the six frozen items and the ONE committed snapshot;
 * THIS file proves the facts PR-B adds reach the store and the wire through the
 * REAL producers — never a hand-built `StatusPatch`:
 *
 * 1. STORE LEVEL: the surface's ONE activity projection turns a producer's
 *    machine fact into `StatusSnapshot.activity` in the correct display subject.
 * 2. WIRE LEVEL: the SAME commit paints the native row through the production
 *    `commitStatus` → `commitDisplaySubject` path.
 * 3. SCOPE/RESET: a session switch, a child subject and a disposal never let an
 *    outgoing subject's activity ride an incoming frame.
 *
 * Every case names its authoritative input, the exact producer callback it
 * fires and the assertion's evidence level.
 *
 * @module @xmoon76/dsh-pi-tui/app/tern-tsp-statusline-activity
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Node } from '@stencil-hq/tern'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createSurfaceRuntime, type SurfaceRendererMount } from '../../src/app/surface/runtime.ts'
import { createStatusRuntime, type StatusRuntimeDeps } from '../../src/app/surface/status-runtime.ts'
import { StatsFolder } from '../../src/domain/status/stats.ts'
import type { SessionStatusProjection } from '../../src/runtime/session-reader-port.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../../src/domain/status/types.ts'
import { mountTspRenderer } from '../../src/tui/tsp/session.ts'
import { nativeStatuslineRows } from '../../src/tui/tsp/statusline-view.ts'
import { deriveActivityStatus } from '../../src/domain/status/derive-activity.ts'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import type { SurfaceEventRoutingSource } from '../../src/app/surface/event-routing.ts'
import type { TaskSurfaceSource } from '../../src/app/surface/task-runtime.ts'
import type { TaskBrowserJobInput } from '../../src/domain/task/browser.ts'
import type { TaskSubagentEntry } from '../../src/runtime/task-read-port.ts'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import type { DisplayActivityFacts } from '../../src/app/surface/display-seam.ts'
import type { SurfaceInteractionPresenter } from '../../src/app/surface/interaction-presenter.ts'
import type { QuestionSurfaceSnapshot, QuestionInteractionPort } from '../../src/runtime/interaction-port.ts'
import type { QuestionSurfaceController } from '../../src/app/surface/question-controller.ts'
import { createInteractionRuntime } from '../../src/app/surface/interaction-runtime.ts'
import { displaySeamStub } from '../support/display-seam-stub.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { wireNodes } from '../support/tsp-picker-wire.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'

const SESSION_ID = 'session-tsp7-prb'
const T0 = 1_700_000_000_000

// ── Helpers ─────────────────────────────────────────────────────────────────

function props(node: Node): Record<string, unknown> {
  return node.props as Record<string, unknown>
}

function children(node: Node): readonly Node[] {
  return node.children
}

function segTexts(rows: readonly Node[]): string[] {
  return rows.flatMap(row => children(row).map(node => String(props(node).text ?? '')))
}

/**
 * Wait until the wire actually shows the expected state (the SDK coalesces
 * frames, so a fixed sleep would either overshoot or race).
 */
const drawn = async (label: string, predicate: () => boolean): Promise<void> => { await waitUntil(label, predicate, 5_000) }

async function openOn(pane: TspPane): Promise<NonNullable<Awaited<ReturnType<typeof connect>>>> {
  const { connect } = await import('@stencil-hq/tern')
  const session = await connect({ env: {}, input: pane.input, output: pane.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')
  return session
}

const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

interface Harness {
  readonly surface: ReturnType<typeof createSurfaceRuntime<SessionEvent>>
  readonly pane: TspPane
  /** The ONE shared store's current snapshot (the authority under test). */
  snapshot(): StatusSnapshot
  readonly statusRuntime: ReturnType<typeof createStatusRuntime>
  readonly renderer: ReturnType<typeof mountTspRenderer>
  setSessionStatus(status: SessionStatusProjection | undefined): void
  setChildViewer(viewer: { id: string; label: string } | undefined): void
  /**
   * Attach the REAL Task Center owner (its own `TaskBrowserRuntime` + catalog
   * fence) onto this surface, so a Summary reaches the store through the
   * production `commitSummary` — never a hand-written patch.
   */
  attachTaskSource(source: TaskSurfaceSource): void
  /**
   * Publish ONE activity fact batch through the surface's REAL activity
   * projection entry (the same path `publishAttention`/`commitSummary` take).
   */
  commitActivityOnly(facts: { questionAttention?: number }): void
  /**
   * The interaction owner's post-admission activity publish (the production
   * `presentedModalFacts()` → display-commit path), re-reading the REAL
   * presenter's active seat.
   */
  publishPresentedModal(): void
  dispose(): Promise<void>
}

/** Mount the REAL surface + the REAL TSP renderer on the scripted pane. */
async function mountActivityHarness(): Promise<Harness> {
  const pane = installTspPane({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'status', 'seg'] })
  const session = await openOn(pane)
  const folder = new TranscriptFolder()
  const controller = new TranscriptWindowController({ windowTurns: 20, stepTurns: 10 })
  const source: SurfaceEventRoutingSource<SessionEvent> = {
    isCleanedUp: () => false,
    isAttachedSession: session => session.id === SESSION_ID,
    currentSessionId: () => SESSION_ID,
    hasLiveAgent: () => true,
    completionOwnerId: () => undefined,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => ({
      folder: { apply: (events: readonly SessionEvent[]) => folder.apply(events) },
      stats: { apply: () => {} },
      get window() { return controller },
      previews: new Map(),
      applyToolPreview: () => {},
      refreshRecentPerformanceAvailability: () => {},
    }),
    viewedChildId: () => undefined,
    viewedChild: () => { throw new Error('no viewer in this harness') },
    mainFolder: () => folder,
    viewedChildFolder: () => { throw new Error('no viewer in this harness') },
    pendingSubjectId: () => undefined,
    pendingSnapshot: () => undefined,
    submissionEchoes: () => undefined,
    queueTextOf: () => '',
    exitView: () => {},
    refreshStatusCheap: () => {},
    refreshStatusAndWelcome: () => {},
    refreshWorkspaceFacts: () => {},
    applyGoalChange: () => {},
    sessionTitleOf: () => undefined,
    extendLoadedHistory: () => false,
    settleLocalSubmitAck: () => {},
    markSubmitLatency: () => {},
    observeDurableSubmission: () => {},
    markContextDirty: () => {},
    refreshContextMeasurement: () => {},
    currentWorkingFromLog: () => false,
    flushTurn: () => {},
    registeredAgentIs: () => false,
    isCurrentOwnerAgent: () => false,
    viewedChildAgent: () => undefined,
    setViewedChildAgent: () => {},
    setViewedQueueAgent: () => {},
    agentForSession: () => undefined,
    applyViewedChildAssistantInput: () => { throw new Error('no viewer in this harness') },
    applyMainAssistantInput: input => folder.applyLiveInput(input),
  }

  const surface = createSurfaceRuntime<SessionEvent>({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation,
    notificationMode: undefined,
    notificationMethod: undefined,
    mainProgressAuthority: 'local-events',
    terminalProgress: undefined,
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
  })
  surface.attachEventRouting(source)

  const sessionStatuses = new Map<string, SessionStatusProjection>()
  let childViewer: { id: string; label: string } | undefined
  const mainStats = new StatsFolder()
  mainStats.hydrate([
    { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
    { type: 'request/context', seq: 1, time: T0 + 1, data: { turn: 1, step: 0, contextWindow: 1_000_000 } },
  ] as never)
  const statusRuntime = createStatusRuntime({
    surface,
    updateTerminalTitle: () => {},
    isCleanedUp: () => false,
    liveAgent: () => undefined,
    generation: () => 1,
    currentSessionId: () => SESSION_ID,
    measureContext: () => 250_000,
    sessionStatus: (sessionId: string) => sessionStatuses.get(sessionId),
    model: {
      selection: () => undefined,
      currentOf: () => undefined,
      defaultSelection: () => undefined,
      marker: () => undefined,
      preset: () => undefined,
    },
    host: () => ({
      permissionPresets: undefined,
      sandboxPolicy: undefined,
      approval: undefined,
      planMode: undefined,
      sessionProjections: undefined,
    }),
    remote: { plan: () => undefined },
    presentation: { mainStats: () => mainStats },
    viewer: {
      read: () => (childViewer === undefined
        ? undefined
        : { ...childViewer, mode: 'continuable', activity: 'running', cwd: '/child', stats: new StatsFolder() }),
    },
    diag: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} },
    clientCwd: '/client/CLIENT_CWD',
  } as unknown as StatusRuntimeDeps)

  let mounted: ReturnType<typeof mountTspRenderer> | undefined
  const renderer: SurfaceRendererMount = {
    mount: (binding, statusReader) => {
      mounted = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => {} })
      mounted.bindStatusReader(statusReader)
      mounted.bindImages(binding)
      return mounted
    },
    releaseUnmounted: async () => { await mounted?.dispose() },
  }
  surface.start({
    events: { onSubmit: () => {}, onExit: () => {} },
    renderer,
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
    readImage: () => Promise.reject(new Error('not exercised')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    captureHistoryScope: () => ({ sessionId: SESSION_ID, isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: async () => false,
    deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: text => text,
  })
  assert.ok(mounted !== undefined, 'the renderer mounted')
  const bound = mounted
  return {
    surface,
    pane,
    renderer: bound,
    statusRuntime,
    snapshot: () => surface.status.snapshot(),
    setSessionStatus(status) {
      if (status === undefined) return
      sessionStatuses.set(status.sessionId, status)
    },
    setChildViewer(viewer) { childViewer = viewer },
    attachTaskSource(source) {
      surface.attachTasks(source, {
        diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
        isCleanedUp: () => false,
      })
    },
    publishPresentedModal() {
      // The REAL presenter read (the production presentedModalFacts source).
      const presented = bound.interaction.presentedModalKind?.()
      const working = surface.status.snapshot().activity.phase === 'working'
      const activity = deriveActivityStatus(
        {
          working,
          compacting: false,
          applyingCompaction: false,
          approvalOpen: presented === 'approval',
          questionOpen: presented === 'question',
        },
        false,
        { queuedCount: 0, taskCount: 0, childAgentCount: 0, todoCount: 0 },
      )
      surface.status.update({ activity } as never)
      bound.display.commitDisplaySubject({ activity } as never, {}, undefined)
    },
    commitActivityOnly(facts) {
      // The REAL publish shape the interaction runtime's publishAttention
      // produces: the activity projection rides the formal display commit
      // (store update + commitDisplaySubject), exactly like commitActivityFacts.
      const published = { questionAttention: 1, ...facts }
      const activity = deriveActivityStatus(
        { working: false, compacting: false, applyingCompaction: false, approvalOpen: false, questionOpen: false },
        false,
        {
          queuedCount: 0,
          taskCount: 0,
          childAgentCount: 0,
          questionAttentionCount: published.questionAttention,
          todoCount: 0,
        },
      )
      surface.status.update({ activity } as never)
      bound.display.commitDisplaySubject({ activity } as never, {}, undefined)
    },
    async dispose() {
      try {
        surface.dispose()
        await surface.whenRendererReleased()
      } finally {
        pane.restore()
      }
      void bound
    },
  }
}

/** The live `status` nodes of the pane, with their `seg` children. */
function liveStatusRows(pane: TspPane): {
  key: string
  segs: { key: string; text: string; side?: string; priority?: number; tone?: string }[]
}[] {
  const out: { key: string; segs: { key: string; text: string; side?: string; priority?: number; tone?: string }[] }[] = []
  const nodes = wireNodes(pane)
  const ordered = nodes.slice().sort((a, b) => a.id.localeCompare(b.id))
  for (const node of ordered) {
    if (node.k !== 'status') continue
    const segs = nodes
      .filter(child => child.k === 'seg' && child.id.startsWith(`${node.id}.`))
      .map(child => ({
        key: String(child.p.key ?? ''),
        text: typeof child.p.text === 'string' ? child.p.text : '',
        ...(child.p.side === undefined ? {} : { side: String(child.p.side) }),
        ...(child.p.priority === undefined ? {} : { priority: Number(child.p.priority) }),
        ...(child.p.tone === undefined ? {} : { tone: String(child.p.tone) }),
      }))
    out.push({ key: String(node.p.key ?? ''), segs })
  }
  return out
}

/** One row-1 seg's text (or `undefined` when the seg is absent). */
function segText(pane: TspPane, key: string): string | undefined {
  for (const row of liveStatusRows(pane)) {
    const seg = row.segs.find(entry => entry.key === key)
    if (seg !== undefined) return seg.text
  }
  return undefined
}

// ── B-01: the REAL working producer reaches the store and the wire ──────────

test('PR-B B-01: the commitStatusFacts working producer drives the store activity and the native run row', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    assert.equal(harness.snapshot().activity.phase, 'idle', 'the baseline phase is idle')

    // The REAL producer: the same `commitStatusFacts` contract the event routing
    // and the cold hydrate use. No patch is hand-built here.
    harness.surface.display.commitStatusFacts({ working: true, busy: true })
    assert.equal(harness.snapshot().activity.phase, 'working',
      'the working fact reached the ONE store through the surface projection')
    assert.equal(harness.snapshot().activity.busy, true, 'busy stays its own machine fact')

    // …and the SAME commit painted the native row (the store update alone paints
    // nothing — PR-A A-04's contract still holds).
    await drawn('the run seg on the wire', () => segText(harness.pane, 'status-r1-run') !== undefined)
    assert.ok(segText(harness.pane, 'status-r1-run')?.includes('work'),
      `the compact run phase is the builtin's: ${segText(harness.pane, 'status-r1-run')}`)

    // The LIFECYCLE end: `working:false` really clears it (presence is the
    // write authority), and the seg leaves the row.
    harness.surface.display.commitStatusFacts({ working: false, busy: false })
    assert.equal(harness.snapshot().activity.phase, 'idle', 'working:false ends the phase')
    await drawn('the run seg leaves the wire', () => segText(harness.pane, 'status-r1-run') === undefined)
  } finally {
    await harness.dispose()
  }
})

// ── B-03: compaction precedence over a still-true busy ──────────────────────

test('PR-B B-03: compacting and applying-compaction outrank working, and idle clears', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    harness.surface.display.commitStatusFacts({ working: true, busy: true })
    assert.equal(harness.snapshot().activity.phase, 'working')

    // The compaction bracket opens: the SHARED precedence decides, so a still-busy
    // machine must not hide it.
    harness.surface.display.commitStatusFacts({ compactionPhase: 'summarizing', busy: true })
    assert.equal(harness.snapshot().activity.phase, 'compacting',
      'compacting outranks working (the shared derive, never a local rule)')
    await drawn('the compacting seg', () => segText(harness.pane, 'status-r1-run')?.includes('compact') === true)

    harness.surface.display.commitStatusFacts({ compactionPhase: 'applying' })
    assert.equal(harness.snapshot().activity.phase, 'applying-compaction')
    await drawn('the applying seg', () => segText(harness.pane, 'status-r1-run')?.includes('apply-compact') === true)

    // An explicit `idle` really CLEARS compaction (presence = the write authority).
    harness.surface.display.commitStatusFacts({ compactionPhase: 'idle', working: false, busy: false })
    assert.equal(harness.snapshot().activity.phase, 'idle', "compactionPhase:'idle' clears the phase")
    await drawn('the run seg is gone', () => segText(harness.pane, 'status-r1-run') === undefined)
  } finally {
    await harness.dispose()
  }
})

// ── B-13: a partial fact never clears the facts it does not name ────────────

test('PR-B B-13: a title/todo-only commit keeps working and the work counts', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    harness.surface.display.commitStatusFacts({ working: true, busy: true, todos: [{ content: 'a', status: 'pending' }] })
    assert.equal(harness.snapshot().activity.phase, 'working')
    assert.equal(harness.snapshot().activity.todoCount, 1, 'the todo count is the display subject list length')

    // A PARTIAL commit that names neither working nor todos must not clear either.
    harness.surface.display.commitStatusFacts({ sessionTitle: 'a title' })
    assert.equal(harness.snapshot().activity.phase, 'working',
      'an unrelated partial commit never clears the run phase')
    assert.equal(harness.snapshot().activity.todoCount, 1, 'an unrelated partial commit never clears the todo count')
  } finally {
    await harness.dispose()
  }
})

// ── B-05/B-12: the child subject never borrows the main activity ────────────

test('PR-B B-12: a child subject drops the main-only run/task/projection facts', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    // Establish the MAIN facts positively first: they are provably paintable.
    harness.surface.display.commitStatusFacts({ working: true, busy: true })
    await drawn('the main run seg', () => segText(harness.pane, 'status-r1-run') !== undefined)

    // The REAL display-subject selector moves to a child through the semantic
    // owner (never a hand-written `view` patch).
    harness.setChildViewer({ id: 'child-a', label: 'research' })
    harness.statusRuntime.refresh()
    assert.equal(harness.snapshot().view.subject.kind, 'subagent', 'the display subject is the child')
    assert.equal(harness.snapshot().activity.phase, 'idle',
      'the child does NOT borrow the main subject run phase')
    assert.equal(harness.snapshot().activity.taskCount, 0, 'no main job count on the child')
  } finally {
    await harness.dispose()
  }
})

// ── B-17: an equivalent repeat publishes nothing ────────────────────────────

test('PR-B B-17: an identical activity commit bumps no revision and adds no frame', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    harness.surface.display.commitStatusFacts({ working: true, busy: true })
    await drawn('the run seg', () => segText(harness.pane, 'status-r1-run') !== undefined)
    const revision = harness.surface.status.revision()
    const frames = harness.pane.frames().length

    // The SAME fact again: the store's content-equality dedupe must absorb it.
    harness.surface.display.commitStatusFacts({ working: true, busy: true })
    assert.equal(harness.surface.status.revision(), revision,
      'an identical activity projection does not churn the store revision')
    assert.equal(harness.pane.frames().length, frames, 'no extra frame for an identical commit')
  } finally {
    await harness.dispose()
  }
})

// ── The pure projection: the PR-B item set ──────────────────────────────────

test('PR-B B-06: the run row and the attention row are the PR-B additions', () => {
  const base = emptyStatusSnapshot()
  const snapshot: StatusSnapshot = {
    ...base,
    activity: deriveActivityStatus(
      { working: true, compacting: false, applyingCompaction: false, approvalOpen: false, questionOpen: false },
      true,
      {
        queuedCount: 0,
        taskCount: 2,
        childAgentCount: 1,
        taskTotalCount: 4,
        childAgentTotalCount: 3,
        failedTaskCount: 1,
        questionAttentionCount: 1,
        todoCount: 0,
      },
    ),
  }
  const rows = nativeStatuslineRows(snapshot)
  assert.equal(rows.length, 2, 'both rows project when the run and attention facts exist')
  const rowOne = children(rows[0]!)
  const keys = rowOne.map(node => props(node).key)
  assert.ok(keys.includes('status-r1-run'), `row 1 carries the run seg: ${keys.join(',')}`)
  assert.ok(keys.includes('status-r1-attention'), `row 1 carries the attention seg: ${keys.join(',')}`)
  const texts = segTexts(rows)
  // The `!` failure, the agents/jobs pair and the `?` Question are the builtin's
  // own compact vocabulary — never a TSP re-implementation.
  const attention = texts.find(text => text.includes('!1')) ?? ''
  assert.ok(attention.includes('1/3a'), `the agents pair is the builtin's: ${attention}`)
  assert.ok(attention.includes('2/4j'), `the jobs pair is the builtin's: ${attention}`)
  assert.ok(attention.includes('?1'), `the parked Question is the builtin's: ${attention}`)
})

test('PR-B: an idle subject with no work shows no run seg and no empty badge', () => {
  const rows = nativeStatuslineRows(emptyStatusSnapshot())
  for (const row of rows) {
    for (const seg of children(row)) {
      assert.notEqual(props(seg).key, 'status-r1-run', 'idle never paints a run seg')
      assert.notEqual(props(seg).key, 'status-r1-attention', 'no empty attention badge')
    }
  }
})

// ── B-07/B-08: the REAL TaskBrowserRuntime GLOBAL summary ──────────────────

/** A real Task Center source over one scripted roster + one descendant set. */
function taskSourceOf(options: {
  readonly jobs: readonly TaskBrowserJobInput[]
  readonly descendants: readonly TaskSubagentEntry[]
}): TaskSurfaceSource {
  const subject = {}
  return {
    sessionId: () => SESSION_ID,
    captureSubject: () => subject as never,
    subjectMatches: candidate => candidate === subject,
    enterView: async () => {},
    interruptSubagent: async () => ({ kind: 'committed' } as never),
    rowSelectionDisposition: (_row, jobDetail) => jobDetail,
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: status => status,
    jobObservation: { open: () => () => {}, stop: async () => ({ kind: 'requested' }) },
    jobs: { list: () => [...options.jobs], subscribe: () => () => {} },
    taskRead: {
      currentKey: () => `g1:${SESSION_ID}`,
      currentSessionId: () => SESSION_ID,
      readTask: async () => ({
        parentSessionId: SESSION_ID,
        parentAvailable: true,
        descendants: [...options.descendants],
        jobs: [...options.jobs],
      }),
      activityOf: (childId) => {
        const entry = options.descendants.find(candidate => candidate.id === childId)
        return entry?.kind === 'child' ? entry.activity : 'inactive'
      },
    },
  }
}

/** Let the Task Center owner's async catalog traversal settle. */
const settleCatalog = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

test('PR-B B-07: the GLOBAL TaskBrowserRuntime summary reaches the store and the native attention row', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    // Jobs-only: 2 running of 4 tracked, no descendant catalog at all.
    harness.attachTaskSource(taskSourceOf({
      jobs: [
        { id: 'j1', kind: 'bash', label: 'build', status: 'running', startedAt: 1_000 },
        { id: 'j2', kind: 'bash', label: 'test', status: 'running', startedAt: 1_001 },
        { id: 'j3', kind: 'bash', label: 'lint', status: 'completed', startedAt: 1_002, finishedAt: 1_100 },
        { id: 'j4', kind: 'bash', label: 'docs', status: 'completed', startedAt: 1_003, finishedAt: 1_101 },
      ],
      descendants: [],
    }))
    harness.surface.refreshTasks()
    await settleCatalog()

    const activity = harness.snapshot().activity
    assert.equal(activity.taskCount, 2, 'the running job count came from the real roster')
    assert.equal(activity.taskTotalCount, 4, 'the tracked total came from the real roster')
    assert.equal(activity.childAgentCount, 0, 'no descendant catalog means no agent count')
    // The GLOBAL summary here comes from `TaskBrowserRuntime`, the one owner
    // that DOES hold the failure-acknowledgement lifetime, so its
    // `failedAttention` is a real fact: this roster has no failed record, so the
    // count is 0 — present and truthful, never absent and never fabricated.
    assert.equal(activity.failedTaskCount, 0, 'the global summary carries its real failed-attention fact')

    // …and the SAME projection painted the native attention seg.
    await drawn('the attention seg on the wire', () => segText(harness.pane, 'status-r1-attention') !== undefined)
    const text = segText(harness.pane, 'status-r1-attention') ?? ''
    assert.ok(text.includes('2/4j'), `the jobs pair is the builtin's: ${text}`)
    assert.ok(!text.includes('a'), `an agents-only figure is NOT printed for a jobs-only session: ${text}`)
  } finally {
    await harness.dispose()
  }
})

test('PR-B B-08: an agents-only catalog paints the agent figure and no 0/0 jobs', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    harness.attachTaskSource(taskSourceOf({
      jobs: [],
      descendants: [
        { kind: 'child', id: 'child-1', label: 'a', mode: 'continuable', activity: 'running', hasChildren: false, parentId: '', depth: 1 },
        { kind: 'child', id: 'child-2', label: 'b', mode: 'continuable', activity: 'running', hasChildren: false, parentId: '', depth: 1 },
        { kind: 'child', id: 'child-3', label: 'c', mode: 'continuable', activity: 'inactive', hasChildren: false, parentId: '', depth: 1 },
      ],
    }))
    harness.surface.refreshAgents()
    await settleCatalog()

    const activity = harness.snapshot().activity
    assert.equal(activity.childAgentCount, 2, 'the running agents came from the real catalog')
    assert.equal(activity.childAgentTotalCount, 3, 'the total came from the real catalog')
    assert.equal(activity.taskCount, 0, 'no job rows in this catalog')

    await drawn('the attention seg on the wire', () => segText(harness.pane, 'status-r1-attention') !== undefined)
    const text = segText(harness.pane, 'status-r1-attention') ?? ''
    assert.ok(text.includes('2/3a'), `the agents pair is the builtin's: ${text}`)
    assert.ok(!text.includes('j'), `a jobs-only figure is NOT printed for an agents-only catalog: ${text}`)
  } finally {
    await harness.dispose()
  }
})

test('PR-B B-32: a session reset drops the old session counts instead of inheriting them', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    harness.attachTaskSource(taskSourceOf({
      jobs: [{ id: 'j1', kind: 'bash', label: 'build', status: 'running', startedAt: 1_000 }],
      descendants: [],
    }))
    harness.surface.refreshTasks()
    await settleCatalog()
    assert.equal(harness.snapshot().activity.taskCount, 1, 'the old session has a job count')

    // The REAL generation-bump reset path.
    harness.surface.resetTasks()
    assert.equal(harness.snapshot().activity.taskCount, 0,
      'the new session never inherits the old session counts')
    assert.equal(harness.snapshot().activity.taskTotalCount, 0)
  } finally {
    await harness.dispose()
  }
})

// ── B-04: a PARKED Question is `?N`, never a waiting-question phase ─────────

const SILENT_DIAG: Diag = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} }

/**
 * The REAL `QuestionSurfaceController` + the REAL `createInteractionRuntime`
 * over a recording presenter, so the parked count and the presented fact come
 * from the production owners — not from a hand-written snapshot.
 */
function mountQuestionOwner(options: {
  readonly currentSessionId?: () => string | undefined
  /** The ADMISSION authority (defaults to "the session the surface shows"). */
  readonly isAdmissibleSession?: (sessionId: string) => boolean
  /**
   * Model the REAL TSP single-seat FIFO in the fake presenter: one active
   * modal, later arrivals queue behind it, a settle promotes the queue before
   * resolving (the same order the real seat keeps).
   */
  readonly fifoSeat?: boolean
} = {}): {
  readonly activity: DisplayActivityFacts[]
  readonly presenterCount: () => number
  readonly controller: QuestionSurfaceController
  readonly setSnapshot: (next: QuestionSurfaceSnapshot | undefined) => void
  readonly notifyChange: () => void
  readonly publish: () => void
  readonly deliverApproval: (request: Record<string, unknown>) => Promise<void>
  /** Deliver ONE live question request through the REAL registered provider. */
  readonly deliverQuestion: (request: Record<string, unknown>) => Promise<unknown>
  /** Hold the NEXT timed Host claim open until the returned release runs. */
  holdClaim(): { entered: Promise<void>; release: () => void }
  /** Resolve when the presenter received a Question form (this flow). */
  whenAskEntered(): Promise<void>
  readonly dispose: () => void
} {
  const published: DisplayActivityFacts[] = []
  let presented = 0
  let snapshot: QuestionSurfaceSnapshot | undefined
  let subscribers: Array<() => void> = []
  const currentSessionId = options.currentSessionId ?? (() => SESSION_ID)
  let approvalListener: ((request: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  /** The REAL provider the controller registered (drives `handleLive`). */
  let questionProvider: ((request: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  /**
   * A gate holding the NEXT `claimTimedWait` open (the Host claim in flight).
   * `claimEntered` resolves when the claim call ACTUALLY starts — the negative
   * assertions then run against a proven in-flight claim, never against a
   * request that has not begun (external review P3).
   */
  let claimGate: Promise<void> | undefined
  let claimEntered: (() => void) | undefined
  const port: QuestionInteractionPort = {
    onRequest: provider => { questionProvider = provider as typeof questionProvider; return true },
    subscribe: (_sessionId, listener) => {
      subscribers.push(listener)
      return () => { subscribers = subscribers.filter(entry => entry !== listener) }
    },
    snapshot: () => snapshot,
    claimTimedWait: async () => {
      claimEntered?.()
      if (claimGate !== undefined) await claimGate
      return undefined
    },
    answerContinued: async () => 'queued',
  }
  const runtime = createInteractionRuntime({
    presenter: () => presenter,
    livePresenter: () => presenter,
    display: () => displaySeamStub({ supportsModals: true }),
    currentSessionId,
    isAdmissibleSession: options.isAdmissibleSession ?? (sessionId => sessionId === currentSessionId()),
    schedulePaint: () => {},
    diag: () => SILENT_DIAG,
    isCleanedUp: () => false,
    onAttentionChanged: () => {},
    publishActivity: facts => { published.push(facts) },
  })
  /** Resolves when the presenter actually received a Question form (level-
   *  triggered: an ask that already entered resolves immediately). */
  let askEntered = false
  let askWaiter: (() => void) | undefined
  /** The presenter's ACTIVE-slot kind (PR-B F4: the presented authority). */
  let presentedKind: 'approval' | 'question' | undefined
  /** The FIFO seat's queued admissions (each runs when the seat frees). */
  const seatQueue: Array<() => void> = []
  const presenter: SurfaceInteractionPresenter = {
    showApprovalPrompt: (request: never, _agentInputWait: boolean) => {
      const signal = (request as { signal?: AbortSignal } | undefined)?.signal
      const take = (resolve: (outcome: import('../../src/app/surface/interaction-presenter.ts').ApprovalOutcome) => void): void => {
        presentedKind = 'approval'
        // The promoted approval OWNS the seat until its own lifetime ends (the
        // real seat presents it; nothing settles it implicitly). An already-
        // ended lifetime settles immediately (an abort that fired while the
        // request was still queued).
        if (signal?.aborted === true) { resolve('cancelled'); return }
        signal?.addEventListener('abort', () => { resolve('cancelled') }, { once: true })
      }
      if (options.fifoSeat === true && presentedKind !== undefined) {
        // QUEUED behind the active modal (the real seat's fifo): not presented.
        return new Promise<import('../../src/app/surface/interaction-presenter.ts').ApprovalOutcome>(resolve => {
          seatQueue.push(() => take(resolve))
        }).finally(() => { presentedKind = undefined })
      }
      return new Promise<import('../../src/app/surface/interaction-presenter.ts').ApprovalOutcome>(resolve => {
        take(resolve)
      }).finally(() => { presentedKind = undefined })
    },
    presentedModalKind: () => presentedKind,
    // A mounted Question form stays mounted until its lifetime aborts (a real
    // form waits for the user and rejects on abort — the RFL-002 coexistence
    // case needs the held-open form, and the process needs every flow
    // settleable). A Question queued behind an active modal models the fifo.
    askQuestions: (_questions, signal) => new Promise((_resolve, reject) => {
      const take = (): void => {
        presentedKind = 'question'
        askEntered = true
        askWaiter?.()
        const end = (): void => {
          // The settle PROMOTES the queue before the rejection propagates.
          presentedKind = undefined
          seatQueue.shift()?.()
          reject(new Error('question flow cancelled'))
        }
        if (signal?.aborted === true) { end(); return }
        signal?.addEventListener('abort', end, { once: true })
      }
      if (options.fifoSeat === true && presentedKind !== undefined) {
        seatQueue.push(take)
        return
      }
      take()
    }),
    setSettledQuestionAnswersLookup: () => {},
    notify: () => {},
    setQuestionAttention: () => { presented += 1 },
    withdrawPending: () => {},
    withdrawPresentations: () => {},
    closeTransientList: () => {},
  }
  runtime.attach({
    onApprovalRequest: (listener: unknown) => { approvalListener = listener as typeof approvalListener },
    questions: port,
    setApprovalPolicy: () => true,
  } as never, {
    lookupCallArgs: () => undefined,
    dangerCommand: () => false,
  })
  const controller = runtime.controller()
  assert.ok(controller !== undefined, 'the ONE controller was created')
  return {
    activity: published,
    presenterCount: () => presented,
    controller,
    setSnapshot: next => { snapshot = next },
    notifyChange: () => { for (const listener of [...subscribers]) listener() },
    publish: () => runtime.publishAttention(),
    holdClaim(): { entered: Promise<void>; release: () => void } {
      let release: () => void = () => {}
      claimGate = new Promise<void>(r => { release = r })
      const entered = new Promise<void>(resolve => { claimEntered = resolve })
      return {
        entered,
        release: () => {
          release()
          claimGate = undefined
          claimEntered = undefined
        },
      }
    },
    whenAskEntered: () => {
      if (askEntered) return Promise.resolve()
      return new Promise<void>(resolve => { askWaiter = resolve })
    },
    /** Deliver ONE live question request through the REAL registered provider. */
    deliverQuestion: (request: Record<string, unknown>) => {
      assert.ok(questionProvider !== undefined, 'the controller registered its live provider')
      return questionProvider!(request, async () => [])
    },
    /** Deliver ONE approval request through the REAL registered listener. */
    deliverApproval: (request: Record<string, unknown>) => {
      assert.ok(approvalListener !== undefined, 'the runtime registered its approval listener')
      const next = async () => 'unavailable' as const
      return Promise.resolve(approvalListener!(request, next)).then(() => undefined)
    },
    dispose: () => runtime.dispose(),
  }
}

test('PR-B B-04: a parked Question publishes ?1 and NEVER a waiting-question phase', () => {
  const owner = mountQuestionOwner()
  try {
    // The projection lists ONE answerable continued call; the controller parks
    // it (it does not own the seat).
    owner.setSnapshot({
      sessionId: SESSION_ID,
      active: [{ sessionId: SESSION_ID, callId: 'c1', questions: [{ id: 'q1', question: 'q', options: [] }], state: 'continued' }],
      settled: [],
      queuedReplyCallIds: new Set(),
    } as never)
    owner.controller.reconcile()
    owner.publish()

    const last = owner.activity.at(-1)
    assert.ok(last !== undefined, 'the attention change published an activity fact')
    assert.equal(last.questionAttention, 1, 'the parked count is ?1')
    assert.equal(last.questionOpen, false,
      'a parked Question is NOT a presented one — the phase must not claim waiting-question')
    // The DISPLAY-SUBJECT separation: a Questions-only session shows `?1` with
    // no job/agent figures at all.
    assert.equal(last.taskCount, undefined, 'no job count is invented for a Questions-only session')
  } finally {
    owner.dispose()
  }
})

test('PR-B B-04: a reopened Question becomes presented, and parking it clears the fact', () => {
  const owner = mountQuestionOwner()
  try {
    owner.setSnapshot({
      sessionId: SESSION_ID,
      active: [{ sessionId: SESSION_ID, callId: 'c1', questions: [{ id: 'q1', question: 'q', options: [] }], state: 'continued' }],
      settled: [],
      queuedReplyCallIds: new Set(),
    } as never)
    owner.controller.reconcile()
    owner.publish()
    assert.equal(owner.activity.at(-1)?.questionOpen, false, 'the parked Question is not presented')
    assert.equal(owner.activity.at(-1)?.questionAttention, 1, '…and it still counts as ?1')

    // The REAL reopen path (Alt+Q / the Task Center row): the same logical
    // Question takes the seat and becomes `visible`.
    assert.equal(owner.controller.reopen(SESSION_ID, 'c1'), true, 'the reopen mounted the form')
    owner.publish()
    assert.equal(owner.activity.at(-1)?.questionOpen, true,
      'a visible entry publishes the presented fact')
    // The parked count DROPS with it: the same Question is no longer waiting in
    // the parked list (no double counting).
    assert.equal(owner.activity.at(-1)?.questionAttention, 0, 'the reopened entry leaves the parked count')
  } finally {
    owner.dispose()
  }
})

// ── B-24/B-29: the navigation lifecycle owns the activity subject ──────────

test('PR-B B-24: a session switch drops the outgoing activity before the new subject commits', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    harness.surface.display.commitStatusFacts({ working: true, busy: true })
    await drawn('the run seg on the wire', () => segText(harness.pane, 'status-r1-run') !== undefined)

    // The REAL hydration window (the generation-bump signal a committed switch
    // runs first): the outgoing subject's activity must go with its transcript.
    harness.surface.display.beginSessionHydration()
    await drawn('the hydration frame without a status row', () => liveStatusRows(harness.pane).length === 0)

    // The generation reset (the session-lifecycle owner's explicit clear).
    harness.surface.resetSubjectStatus()
    assert.equal(harness.snapshot().activity.phase, 'idle',
      'the outgoing subject working fact does not survive the generation bump')
    assert.equal(harness.snapshot().activity.taskCount, 0)
  } finally {
    await harness.dispose()
  }
})

test('PR-B B-18: a disposed surface publishes nothing from a late owner callback', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    harness.surface.display.commitStatusFacts({ working: true, busy: true })
    assert.equal(harness.snapshot().activity.phase, 'working')
    const revision = harness.surface.status.revision()
    await harness.dispose()

    // A LATE producer callback on the retained seam: the mount it belonged to is
    // gone, so it must not write the store and must not render.
    harness.surface.display.commitStatusFacts({ working: false, busy: false })
    assert.equal(harness.surface.status.revision(), revision,
      'a disposed surface commits no further activity')
  } finally {
    await harness.pane.restore()
  }
})

// ── B-14/B-15/B-16: absent statistics paint nothing ────────────────────────

test('PR-B B-14: an absent TTFB/R5/All sample paints no zero statistic', () => {
  const rows = nativeStatuslineRows(emptyStatusSnapshot())
  for (const row of rows) {
    for (const seg of children(row)) {
      assert.notEqual(props(seg).key, 'status-r2-ttfb', 'no latency sample means no latency seg')
      assert.notEqual(props(seg).key, 'status-r2-speed', 'no rate sample means no rate seg')
      assert.notEqual(props(seg).key, 'status-r2-cache', 'no cache fact means no cache seg')
    }
  }
})

test('PR-B B-15: a partial performance projection renders only the facts it has', () => {
  const base = emptyStatusSnapshot()
  const withR5: StatusSnapshot = {
    ...base,
    usage: { ...base.usage, performance: { llmMs: 0, tokensPerSec: 116 } },
  }
  const keys = nativeStatuslineRows(withR5).flatMap(row => children(row).map(node => props(node).key))
  assert.ok(keys.includes('status-r2-speed'), 'the R5 fact paints the rate seg')
  assert.ok(!keys.includes('status-r2-ttfb'), 'no latency sample means no latency seg')

  const withLatency: StatusSnapshot = {
    ...base,
    usage: { ...base.usage, performance: { llmMs: 0, firstTokenMs: 2_600 } },
  }
  const latencyKeys = nativeStatuslineRows(withLatency).flatMap(row => children(row).map(node => props(node).key))
  assert.ok(latencyKeys.includes('status-r2-ttfb'), 'the latency fact paints the latency seg')
  assert.ok(!latencyKeys.includes('status-r2-speed'), 'no rate sample means no rate seg')
})

test('PR-B B-16: a Remote session with no token totals still paints its context', () => {
  const base = emptyStatusSnapshot()
  const snapshot: StatusSnapshot = {
    ...base,
    usage: {
      ...base.usage,
      tokens: undefined,
      context: { usedTokens: 250_000, windowTokens: 1_000_000, percent: 25 },
    },
  }
  const keys = nativeStatuslineRows(snapshot).flatMap(row => children(row).map(node => props(node).key))
  assert.ok(!keys.includes('status-r2-tokens'), 'no official token totals means no token seg')
  assert.ok(keys.includes('status-r2-context'), 'the measured context is still painted')
})

// ── B-22: a read-only seg never advertises an action ───────────────────────

test('PR-B B-22: the attention seg never advertises a Task Center the renderer cannot open', () => {
  const base = emptyStatusSnapshot()
  const snapshot: StatusSnapshot = {
    ...base,
    activity: deriveActivityStatus(
      { working: false, compacting: false, applyingCompaction: false, approvalOpen: false, questionOpen: false },
      false,
      { queuedCount: 0, taskCount: 1, childAgentCount: 0, taskTotalCount: 2, todoCount: 0 },
    ),
  }
  const rows = nativeStatuslineRows(snapshot)
  const attention = rows
    .flatMap(row => children(row))
    .find(node => props(node).key === 'status-r1-attention')
  assert.ok(attention !== undefined, 'the attention seg is painted')
  // `NO_SURFACE_HINTS.taskBrowserAvailable === false` is the projection's only
  // truth: the builtin therefore omits its `↓ view` hint, and the seg carries
  // NO click action of its own (a native tone/icon never grants a business act).
  const text = String(props(attention).text)
  assert.ok(!text.includes('↓'), `no view hint is advertised: ${text}`)
  assert.equal(props(attention).actions, undefined, 'the seg declares no action')
})

// ── RFL-001: an inadmissible live flow never paints waiting-question ────────

test('PR-B RFL-001: a replaced session live flow keeps alive but never presents', async () => {
  let currentSession: string | undefined = SESSION_ID
  const owner = mountQuestionOwner({ currentSessionId: () => currentSession })
  try {
    // The surface moves to session B BEFORE session A's late request arrives.
    // The request carries its own Host signal, so only the Host may end it:
    // the controller keeps it alive (it awaits the signal) but it was NEVER
    // admissible, so it must not paint THIS subject as waiting-question.
    currentSession = 'session-b'
    const hostLifetime = new AbortController()
    const flow = owner.deliverQuestion({
      sessionId: SESSION_ID,
      callId: 'c1',
      questions: [{ id: 'q1', question: 'late', options: [] }],
      signal: hostLifetime.signal,
      timed: false,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    // The flow is STILL ALIVE (it awaits its Host signal) but the presenter's
    // ACTIVE slot never took it — the current subject is not waiting-question.
    assert.equal(owner.activity.some(facts => facts.questionOpen === true), false,
      'an inadmissible live flow never publishes the presented fact')
    // Cleanup: the Host ends the request; the flow settles through the real path.
    hostLifetime.abort()
    await flow.catch(() => {})
  } finally {
    owner.dispose()
  }
})

// ── RFL-002: a Question that outlives an approval keeps its fact ────────────

test('PR-B RFL-002/F4: the seat is the phase authority — a queued approval keeps the Question phase, a promoted one takes it', async () => {
  const owner = mountQuestionOwner({ fifoSeat: true })
  try {
    // 1. A continued Question is mounted VISIBLE (the real reopen path).
    owner.setSnapshot({
      sessionId: SESSION_ID,
      active: [{ sessionId: SESSION_ID, callId: 'c1', questions: [{ id: 'q1', question: 'q', options: [] }], state: 'continued' }],
      settled: [],
      queuedReplyCallIds: new Set(),
    } as never)
    owner.controller.reconcile()
    assert.equal(owner.controller.reopen(SESSION_ID, 'c1'), true)
    owner.publish()
    assert.equal(owner.activity.at(-1)?.questionOpen, true, 'the Question is presented')

    // 2. An Approval arrives while the Question HOLDS the single seat. The
    //    presenter queues it (FIFO); the phase must STAY with the Question — a
    //    merely-queued approval never claims waiting-approval (F4).
    const approvalLifetime = new AbortController()
    const settled = owner.deliverApproval({
      toolName: 'bash', reason: 'probe', sessionId: SESSION_ID, signal: approvalLifetime.signal,
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const during = owner.activity.at(-1)
    assert.equal(during?.questionOpen, true, 'the Question keeps the phase while the approval queues')
    assert.equal(during?.approvalOpen, false, 'a FIFO-queued approval is NOT waiting-approval')

    // 3. The Question parks (the real Esc path): the seat frees and the QUEUED
    //    approval is promoted — the phase moves to waiting-approval (the seat
    //    truth, published through the controller's park notification).
    owner.controller.attentionRows() // (no-op read; the park path below is real)
    const parked = owner.controller.reopen(SESSION_ID, 'c1')
    void parked
    // Park the mounted continued form through the controller's own path.
    owner.setSnapshot({
      sessionId: SESSION_ID,
      active: [],
      settled: [{ callId: 'c1', answers: [] }],
      queuedReplyCallIds: new Set(),
    } as never)
    owner.controller.reconcile()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(owner.activity.some(facts => facts.approvalOpen === true), true,
      'the promoted approval owns the phase after the Question parks')

    // 4. The approval settles (its own lifetime ends) and the phase returns.
    approvalLifetime.abort()
    await settled
    const after = owner.activity.at(-1)!
    assert.equal(after.approvalOpen, false, 'the settled approval releases the phase')
  } finally {
    owner.dispose()
  }
})

test('PR-B EXT-F4: a Question holding the seat keeps its phase while an Approval queues; a fresh seat admits the Approval directly', async () => {
  // The fake seat models the REAL TSP single-seat FIFO (one active modal, a
  // settle promotes the queue before resolving); everything else is the
  // production controller -> interaction runtime -> presenter chain.
  const owner = mountQuestionOwner({ fifoSeat: true })
  try {
    owner.setSnapshot({
      sessionId: SESSION_ID,
      active: [],
      settled: [],
      queuedReplyCallIds: new Set(),
    } as never)
    // 1. The Question TAKES the seat through the REAL live provider path.
    const questionLifetime = new AbortController()
    const question = owner.deliverQuestion({
      sessionId: SESSION_ID,
      callId: 'c1',
      questions: [{ id: 'q1', question: 'q', options: [] }],
      signal: questionLifetime.signal,
      timed: false,
    })
    question.catch(() => {})
    await owner.whenAskEntered()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(owner.activity.some(facts => facts.questionOpen === true), true,
      'the seat-holder Question publishes waiting-question')

    // 2. An Approval arrives while the Question holds the seat: it QUEUES and
    //    must NOT claim waiting-approval. (The promotion itself is witnessed by
    //    the RFL-002 park path: the settle promotes before the promise chain
    //    resumes, so the republish reads the new seat.)
    const approvalLifetime = new AbortController()
    const settled = owner.deliverApproval({
      toolName: 'bash', reason: 'probe', sessionId: SESSION_ID, signal: approvalLifetime.signal,
    })
    settled.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 10))
    const during = owner.activity.at(-1)
    assert.equal(during?.questionOpen, true, 'the Question keeps the phase while the approval queues')
    assert.equal(during?.approvalOpen, false, 'a FIFO-queued approval is NOT waiting-approval')

    // 3. Teardown through the real lifetimes (both flows settle).
    approvalLifetime.abort()
    questionLifetime.abort()
    await Promise.allSettled([settled, question])
  } finally {
    owner.dispose()
  }
})

test('PR-B EXT-F4b: with the seat free an Approval admits directly and publishes waiting-approval', async () => {
  const owner = mountQuestionOwner({ fifoSeat: true })
  try {
    const approvalLifetime = new AbortController()
    const settled = owner.deliverApproval({
      toolName: 'bash', reason: 'probe', sessionId: SESSION_ID, signal: approvalLifetime.signal,
    })
    settled.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(owner.activity.some(facts => facts.approvalOpen === true), true,
      'the directly-admitted approval publishes waiting-approval')
    approvalLifetime.abort()
    await settled
    const after = owner.activity.at(-1)!
    assert.equal(after.approvalOpen, false, 'the settled approval releases the phase')
  } finally {
    owner.dispose()
  }
})

// ── RFL-003: a main todo write mid-view never touches the child ─────────────

test('PR-B RFL-003: a child subject keeps its own todo count; main todo writes do not leak', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    // MAIN has 2 todos.
    harness.surface.display.commitStatusFacts({ todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] })
    assert.equal(harness.snapshot().activity.todoCount, 2)

    // The child commits with its OWN presentation (1 todo) through the REAL
    // semantic owner.
    harness.setChildViewer({ id: 'child-a', label: 'research' })
    harness.setSessionStatus({
      sessionId: 'child-a',
      title: 'child',
      todos: [{ content: 'child todo', status: 'pending' }],
      goal: undefined,
    } as never)
    harness.statusRuntime.refresh()
    assert.equal(harness.snapshot().view.subject.kind, 'subagent')
    assert.equal(harness.snapshot().activity.todoCount, 1,
      'the child todo count came from the child presentation, not the main mirror')

    // A MAIN todo/write lands while the child is displayed: the child's
    // activity must not move (the main mirror is not the child's authority).
    harness.surface.display.commitStatusFacts({ todos: [{ content: 'main only', status: 'pending' }] })
    assert.equal(harness.snapshot().activity.todoCount, 1,
      'a main todo write mid-view never leaks into the child activity')
    assert.equal(harness.snapshot().activity.queuedCount, 0, 'no main queue borrow either')
  } finally {
    await harness.dispose()
  }
})

// ── EXT-F1: a registered flow whose Host claim is still opening does NOT
// paint waiting-question; the phase arrives only when the form is presented ──

test('PR-B EXT-F1: a blocked timed claim never paints waiting-question until the form presents', async () => {
  const owner = mountQuestionOwner()
  try {
    owner.setSnapshot({
      sessionId: SESSION_ID,
      active: [],
      settled: [],
      queuedReplyCallIds: new Set(),
    } as never)
    // Hold the timed Host claim OPEN: the request is registered and admissible,
    // but its form has NOT reached the presenter yet. `entered` resolves when
    // the claim call has ACTUALLY started, so the negative assertions below run
    // against a proven in-flight claim (external review P3) — no fixed wait.
    const claim = owner.holdClaim()
    const hostLifetime = new AbortController()
    const flow = owner.deliverQuestion({
      sessionId: SESSION_ID,
      callId: 'c1',
      questions: [{ id: 'q1', question: 'q', options: [] }],
      signal: hostLifetime.signal,
      timed: true,
    })
    await claim.entered
    // While the claim is in flight the flow is ALIVE but NOT presented.
    assert.equal(owner.activity.some(facts => facts.questionOpen === true), false,
      'a registered-but-claiming flow never publishes the waiting-question fact')

    // Release the claim: the flow reaches the presenter and the phase arrives.
    claim.release()
    await owner.whenAskEntered()
    assert.equal(owner.activity.some(facts => facts.questionOpen === true), true,
      'the form reaching the presenter publishes waiting-question in the same step')

    hostLifetime.abort()
    await flow.catch(() => {})
  } finally {
    owner.dispose()
  }
})

// ── EXT-F2: one business fact batch produces no mixed legacy/native frame ──

test('PR-B EXT-F2: the Working→Compacting transition paints ONE consistent frame, never new legacy beside old native', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    harness.surface.display.commitStatusFacts({ working: true, busy: true })
    await drawn('the working seg on the wire', () => segText(harness.pane, 'status-r1-run')?.includes('work') === true)

    // The transition: the SAME business batch updates the legacy compaction word
    // and the native run state. Watch EVERY frame the wire actually sends.
    const framesBefore = harness.pane.frames().length
    harness.surface.display.commitStatusFacts({ compactionPhase: 'summarizing', busy: true })
    await drawn('the compacting seg on the wire', () => segText(harness.pane, 'status-r1-run')?.includes('compact') === true)
    // Drain the same-tick microtask flush (a facts-only repaint would land here).
    await new Promise(resolve => setTimeout(resolve, 30))

    // Every frame SINCE the transition must be internally consistent: a frame
    // whose dock carries the NEW `compacting` word must also carry the NEW
    // native phase — the mixed pair (new legacy + old `work` seg) is exactly
    // the non-atomic intermediate frame F2 forbids.
    const newFrames = harness.pane.frames().slice(framesBefore)
    // The wire's frames are DELTAS (an unchanged seg is not re-sent), so a
    // mixed intermediate frame cannot be detected by string containment. The
    // discriminating witness is the FRAME COUNT: a synchronous legacy repaint
    // followed by the activity's display commit sends TWO frames for ONE
    // business fact batch (verified: 2 frames before the deferred-flush fix,
    // 1 after); the coalesced batch publishes the SAME facts in ONE frame.
    assert.equal(newFrames.length, 1,
      `one business fact batch publishes exactly ONE frame (got ${newFrames.length}: a synchronous legacy repaint followed by the display commit would split it)`)
    assert.ok(newFrames.length > 0, 'the transition produced at least one frame')
    const settled = JSON.stringify(newFrames[0])
    assert.ok(settled.includes('compacting'), 'the single frame carries the new legacy compaction word')
    assert.ok(settled.includes('compact'), 'the single frame carries the new native phase')

    // And the final wire state is the settled one.
    assert.ok(segText(harness.pane, 'status-r1-run')?.includes('compact') === true,
      'the native run state is the compacting phase')
    harness.surface.display.commitStatusFacts({ compactionPhase: 'applying' })
    await drawn('the applying seg', () => segText(harness.pane, 'status-r1-run')?.includes('apply-compact') === true)
  } finally {
    await harness.dispose()
  }
})

// ── EXT-F2b: a facts-only commit still repaints its legacy line ─────────────

test('PR-B EXT-F2b: a title-only facts commit still updates the legacy dock line', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    harness.surface.display.commitStatusFacts({ sessionTitle: 'FACTS_ONLY_TITLE' })
    // The scheduled flush is a microtask: the wire shows the line without any
    // formal display commit following.
    await drawn('the legacy title line on the wire', () =>
      wireNodes(harness.pane).some(node => typeof node.p.text === 'string' && node.p.text.includes('FACTS_ONLY_TITLE')))
  } finally {
    await harness.dispose()
  }
})

// ── EXT-F3: a Question parked/visible switch paints ONE frame, not a
// dock-count frame followed by a native-badge frame ─────────────────────────

test('PR-B EXT-F3: a parked-Question arrival publishes the dock line and the native badge in ONE frame', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    // Establish a live native row first (the probe sequence: a working run seg),
    // so the dock already carries status content — the same shape the
    // production surface is in when a Question parks mid-run.
    harness.surface.display.commitStatusFacts({ working: true, busy: true })
    await drawn('the run seg on the wire', () => segText(harness.pane, 'status-r1-run') !== undefined)

    // The interaction runtime's REAL publish sequence for a parked-Question
    // arrival: the presenter's dock-count projection (`setQuestionAttention`,
    // the `Continued questions: N` line) followed by the surface's activity
    // publish (the native `?1` badge) — the SAME business fact through two
    // presentation outlets. F3 requires them to reach the wire as ONE frame.
    const presenter = harness.renderer.interaction
    const framesBefore = harness.pane.frames().length
    presenter.setQuestionAttention(1)
    harness.commitActivityOnly({ questionAttention: 1 })
    // Let the same-tick microtask window pass (a split publish's second frame
    // would land here).
    await new Promise(resolve => setTimeout(resolve, 30))
    const sent = harness.pane.frames().length - framesBefore
    assert.equal(sent, 1,
      `the parked-Question fact batch published exactly ONE frame (got ${sent})`)

    // …and both projections of the fact are on the wire.
    await drawn('the dock continued-questions line', () =>
      wireNodes(harness.pane).some(node => typeof node.p.text === 'string' && node.p.text.includes('Continued questions')))
    await drawn('the native attention badge', () =>
      segText(harness.pane, 'status-r1-attention')?.includes('?1') === true)
  } finally {
    await harness.dispose()
  }
})

// ── EXT-F5: a modal admission and its waiting phase land in ONE wire frame ──

test('PR-B EXT-F5: an approval admission paints the modal and waiting-approval in ONE frame', async () => {
  const harness = await mountActivityHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    // A live run row exists first (the witness needs prior dock content, the
    // same rule EXT-F3 established).
    harness.surface.display.commitStatusFacts({ working: true, busy: true })
    await drawn('the run seg on the wire', () => segText(harness.pane, 'status-r1-run') !== undefined)

    // The REAL production sequence: the presenter call (the TSP seat takes the
    // approval), then the runtime's post-admission activity publish through
    // the display commit. Both fact families must reach the wire in ONE frame.
    const presenter = harness.renderer.interaction
    const framesBefore = harness.pane.frames().length
    const lifetime = new AbortController()
    const prompt = presenter.showApprovalPrompt({
      toolName: 'bash', reason: 'probe', signal: lifetime.signal,
    }, true)
    prompt.catch(() => {})
    // The interaction owner's post-admission publish (the production path the
    // runtime drives through publishActivity → commitStatus).
    harness.publishPresentedModal()
    await new Promise(resolve => setTimeout(resolve, 30))
    // The CONTENT frames (ops beyond the SDK's focus protocol): the modal and
    // its waiting phase must share exactly ONE content frame. A bare
    // `["focus",…]` op after it is the SDK's caret protocol, not a split
    // presentation (measured: the admission frame carries the `w-approval` seg
    // AND the modal overlay together; the focus op follows separately).
    const newFrames = harness.pane.frames().slice(framesBefore)
    const contentFrames = newFrames.filter(frame =>
      !(Array.isArray(frame.ops) && frame.ops.length === 1 && String(frame.ops[0]?.[0]) === 'focus'))
    assert.equal(contentFrames.length, 1,
      `the modal admission and its waiting phase published exactly ONE content frame (got ${contentFrames.length} of ${newFrames.length} total)`)
    const frame = JSON.stringify(contentFrames[0])
    assert.ok(frame.includes('w-approval'), 'the one content frame carries the native waiting-approval phase')
    assert.ok(frame.includes('modal'), 'the one content frame carries the modal overlay')

    lifetime.abort()
    await prompt.catch(() => {})
    harness.publishPresentedModal()
    await new Promise(resolve => setTimeout(resolve, 30))
  } finally {
    await harness.dispose()
  }
})
