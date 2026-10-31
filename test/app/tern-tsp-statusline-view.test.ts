/**
 * TSP-7 PR-A: the native statusline core.
 *
 * Three levels of evidence, in the order the PR-A plan asks for:
 *
 * 1. PURE PROJECTION (`nativeStatuslineRows`): the six frozen builtin items,
 *    their keys/sides/priorities, and the absent-value rules. These prove the
 *    mapping, not its reachability.
 * 2. PORT CONTRACT: the read-only reader binds exactly once, a second or a
 *    post-disposal bind fails fast, and a formal display commit without a
 *    bound reader fails fast instead of painting a substitute banner.
 * 3. SOURCE → DECISION → SINK: a REAL `createSurfaceRuntime` +
 *    `surface.commitStatus(...)` writes the ONE shared store and the mounted
 *    TSP renderer paints the native rows from THAT commit; a session switch
 *    never lets the outgoing subject's status ride the incoming frame.
 *
 * @module @xmoon76/dsh-pi-tui/app/tern-tsp-statusline-view
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
import { resolveTspNativeFooterConfig } from '../../src/domain/footer/tsp-native-config.ts'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import type { SurfaceEventRoutingSource } from '../../src/app/surface/event-routing.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { wireNodes } from '../support/tsp-picker-wire.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'

const SESSION_ID = 'session-tsp7-pra'
const T0 = 1_700_000_000_000

// ── Helpers ─────────────────────────────────────────────────────────────────

/** One projection node's own props (the SDK keeps them on `props`). */
function props(node: Node): Record<string, unknown> {
  return node.props as Record<string, unknown>
}

/** A projection node's children (`ui.status` → its `ui.seg`s). */
function children(node: Node): readonly Node[] {
  return node.children
}

/** The `seg` text of every row of a projection, in order. */
function segTexts(rows: readonly Node[]): string[] {
  return rows.flatMap(row => children(row).map(node => String(props(node).text ?? '')))
}

/** A snapshot carrying every PR-A fact (a test fixture, not a production rule). */
function fullSnapshot(): StatusSnapshot {
  const base = emptyStatusSnapshot()
  return {
    ...base,
    access: { permissionPreset: { id: 'read-only' } },
    workspace: { cwd: '/workspaces/dsh-pi-tui', branch: 'main' },
    collaboration: { plan: { effective: true } },
    usage: {
      ...base.usage,
      tokens: { input: 114_000_000, output: 54_000, cacheRead: 0, cacheWrite: 0 },
      context: { usedTokens: 160_000, windowTokens: 1_000_000, percent: 16 },
    },
  } as unknown as StatusSnapshot
}

// ── 1. The pure projection ──────────────────────────────────────────────────

test('PR-A: the two native rows carry the frozen keys, sides and priorities', () => {
  const rows = nativeStatuslineRows(fullSnapshot())
  assert.equal(rows.length, 2, 'both rows project when every fact is present')
  assert.equal(props(rows[0]).key, 'status-row-1')
  assert.equal(props(rows[1]).key, 'status-row-2')

  const rowOne = children(rows[0])
  const rowTwo = children(rows[1])
  assert.deepEqual(rowOne.map(node => props(node).key), [
    'status-r1-permission',
    'status-r1-cwd',
    'status-r1-git',
    'status-r1-plan',
  ], 'row 1 keeps the frozen item order')
  assert.deepEqual(rowTwo.map(node => props(node).key), ['status-r2-tokens', 'status-r2-context'])

  // Row 1: permission 95, cwd 50, git 30, plan 100 (right side).
  assert.deepEqual(rowOne.map(node => props(node).priority), [95, 50, 30, 100])
  // Row 2: tokens 60, context 100 (right side).
  assert.deepEqual(rowTwo.map(node => props(node).priority), [60, 100])
  assert.deepEqual(rowOne.map(node => props(node).side), [undefined, undefined, undefined, 'right'])
  assert.deepEqual(rowTwo.map(node => props(node).side), [undefined, 'right'])
})

test('PR-A: the seg text comes from the existing builtin formatter, never a re-implementation', () => {
  const rows = nativeStatuslineRows(fullSnapshot())
  const texts = segTexts(rows)
  // `permission-preset:compact` -> 'ro'; `cwd:basename` -> the last path part;
  // `git-branch:plain` -> the branch; `plan-state:plain` -> 'plan'.
  assert.ok(texts.includes('ro'), `the compact permission text is the builtin's: ${texts.join(' | ')}`)
  assert.ok(texts.includes('dsh-pi-tui'), `the cwd basename is the builtin's: ${texts.join(' | ')}`)
  assert.ok(texts.includes('main'), `the git branch is the builtin's: ${texts.join(' | ')}`)
  assert.ok(texts.includes('plan'), `the plan word is the builtin's: ${texts.join(' | ')}`)
  // `token-usage:pi` -> '↑114M ↓54k'; `context:percent` -> 'ctx 16%'.
  assert.ok(texts.some(text => text.includes('114M') && text.includes('54k')),
    `the pi token pair is the builtin's: ${texts.join(' | ')}`)
  assert.ok(texts.some(text => text.includes('16%')),
    `the context percent is the builtin's: ${texts.join(' | ')}`)
})

test('PR-A: an absent fact omits its seg; an empty row omits the whole status', () => {
  const base = emptyStatusSnapshot()
  // No fact at all and no token projection: no status node whatsoever.
  const bare = {
    ...base,
    usage: { ...base.usage, tokens: undefined },
  } as unknown as StatusSnapshot
  assert.equal(nativeStatuslineRows(bare).length, 0, 'an empty snapshot paints no status row')

  // Nothing but a cwd: row 1 has exactly one seg and row 2 does not exist.
  const cwdOnly = {
    ...bare,
    workspace: { cwd: '/workspaces/only' },
  } as unknown as StatusSnapshot
  const cwdRows = nativeStatuslineRows(cwdOnly)
  assert.equal(cwdRows.length, 1, 'row 2 is not mounted when no statistic is available')
  assert.equal(props(cwdRows[0]!).key, 'status-row-1')
  assert.equal(children(cwdRows[0]!).length, 1)

  // Remote with no token projection but a usable context: row 2 shows context only.
  const remote = {
    ...bare,
    usage: { ...base.usage, tokens: undefined, context: { usedTokens: 5, windowTokens: 100, percent: 5 } },
  } as unknown as StatusSnapshot
  const remoteRows = nativeStatuslineRows(remote)
  assert.equal(remoteRows.length, 1)
  assert.equal(props(remoteRows[0]!).key, 'status-row-2')
  assert.deepEqual(children(remoteRows[0]!).map(node => props(node).key), ['status-r2-context'],
    'no ↑0 ↓0 is fabricated for an absent token projection')
})

test('PR-A: an unusable context window hides the context seg', () => {
  const base = emptyStatusSnapshot()
  for (const context of [
    undefined,
    { usedTokens: 5, windowTokens: 0 },
    { usedTokens: 5, windowTokens: -1 },
  ]) {
    const snapshot = { ...base, usage: { ...base.usage, tokens: undefined, context } } as unknown as StatusSnapshot
    assert.equal(nativeStatuslineRows(snapshot).length, 0,
      `no pseudo "ctx 0%" for context=${JSON.stringify(context)}`)
  }
})

test('PR-A: a workspace the subject does not own shows Unavailable, never a guessed path', () => {
  const base = emptyStatusSnapshot()
  // `tokens: undefined` isolates row 1: the baseline's legal zero token object
  // is a REAL value the pi formatter renders, so it is not part of this witness.
  const bare = { ...base, usage: { ...base.usage, tokens: undefined } } as unknown as StatusSnapshot
  const unavailable = { ...bare, workspace: { cwd: '', cwdUnavailable: true } } as unknown as StatusSnapshot
  const rows = nativeStatuslineRows(unavailable)
  assert.equal(rows.length, 1)
  assert.deepEqual(segTexts(rows), ['Unavailable'],
    'the builtin "Unavailable" word survives')
  // An empty cwd WITHOUT the stated unavailability is not a claim.
  const silent = { ...bare, workspace: { cwd: '' } } as unknown as StatusSnapshot
  assert.equal(nativeStatuslineRows(silent).length, 0, 'no path is invented from process.cwd()')
})

test('PR-A: a child subject does not borrow the main session plan', () => {
  const base = emptyStatusSnapshot()
  const child = {
    ...base,
    usage: { ...base.usage, tokens: undefined },
    view: { subject: { kind: 'child', id: 'child-1' } },
    workspace: { cwd: '/host/child' },
    collaboration: { plan: { effective: true } },
  } as unknown as StatusSnapshot
  const rows = nativeStatuslineRows(child)
  assert.equal(rows.length, 1)
  const texts = segTexts(rows)
  assert.ok(!texts.includes('plan'), 'the builtin plan item is main-only, so a child shows no plan')
  assert.ok(texts.includes('child'), 'the child shows only its own workspace')
})

test('PR-A: an identical repeat projection produces identical rows', () => {
  const snapshot = fullSnapshot()
  const first = nativeStatuslineRows(snapshot)
  const second = nativeStatuslineRows(snapshot)
  assert.equal(first.length, second.length)
  for (const [index, row] of first.entries()) {
    assert.deepEqual(props(row), props(second[index]), `row ${index} is unchanged`)
  }
})

// ── 2. The port contract ────────────────────────────────────────────────────

test('PR-A: the status reader binds once; a later bind and a post-disposal bind fail fast', async () => {
  const pane = installTspPane()
  try {
    const session = await openOn(pane)
    const renderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => {} })
    try {
      const reader = { snapshot: () => emptyStatusSnapshot() }
      renderer.bindStatusReader(reader)
      assert.throws(() => renderer.bindStatusReader(reader), /already bound/,
        'a second binding is an explicit error, never a silent re-point')
    } finally {
      await renderer.dispose()
    }
    assert.throws(() => renderer.bindStatusReader({ snapshot: () => emptyStatusSnapshot() }),
      /disposal/, 'a disposed renderer refuses a late reader')
  } finally {
    pane.restore()
  }
})

test('PR-A: a display commit without a bound reader fails fast instead of painting a substitute', async () => {
  const pane = installTspPane()
  try {
    const session = await openOn(pane)
    const renderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => {} })
    try {
      assert.throws(() => renderer.display.commitDisplaySubject({}, {}, undefined), /no status reader/,
        'an unbound renderer must not silently fall back to a text banner')
    } finally {
      await renderer.dispose()
    }
  } finally {
    pane.restore()
  }
})

test('PR-A A-24: a DISPOSED renderer never samples the reader again', async () => {
  const pane = installTspPane()
  try {
    const session = await openOn(pane)
    const renderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => {} })
    // Count the reads on the SAME reader the mount installed, so the witness is
    // the production object and not a fixture of this test's own making.
    let reads = 0
    const reader = { snapshot: () => { reads += 1; return emptyStatusSnapshot() } }
    renderer.bindStatusReader(reader)
    renderer.display.commitDisplaySubject({}, {}, undefined)
    assert.equal(reads, 1, 'a live display commit samples the reader exactly once')

    await renderer.dispose()
    // The retained seam may still be called after teardown (§3.4): it must
    // paint nothing and read nothing, because the mount it belonged to is gone.
    renderer.display.commitDisplaySubject({}, {}, undefined)
    renderer.display.commitDisplaySubject({}, {}, undefined)
    assert.equal(reads, 1, 'a disposed renderer performs NO further snapshot read')
  } finally {
    pane.restore()
  }
})

// ── 3. The source → decision → sink chain ───────────────────────────────────

/**
 * Wait until the wire actually shows the expected state.
 *
 * The SDK coalesces frames under credit flow control, so a fixed sleep would
 * either overshoot or race: every assertion below is preceded by the
 * authoritative wire fact it depends on (`waitUntil` polls that fact, never
 * "give the system time").
 */
const drawn = async (label: string, predicate: () => boolean): Promise<void> => { await waitUntil(label, predicate, 5_000) }

/** The official SDK connect over the installed pane. */
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
  commit(patch: Record<string, unknown>): void
  /**
   * RFL-002: the REAL semantic status owner over the SAME surface. `refresh()`
   * derives the patch from Host/session facts and reaches the renderer through
   * `surface.commitStatus` — no test-built patch is involved.
   */
  readonly statusRuntime: ReturnType<typeof createStatusRuntime>
  /** The mounted production renderer (its display seam is the real one). */
  readonly renderer: ReturnType<typeof mountTspRenderer>
  /** Install one session's official projection, keyed by its own id. */
  setSessionStatus(status: SessionStatusProjection | undefined): void
  /** Open the viewer on one child session (the real display-subject selector). */
  setChildViewer(viewer: { id: string; label: string } | undefined): void
  dispose(): Promise<void>
}

/** Mount the REAL surface + the REAL TSP renderer on the scripted pane. */
async function mountStatuslineHarness(options: {
  /** Observe the EXACT reader object the surface hands the mount. */
  readonly onStatusReader?: (reader: { snapshot(): StatusSnapshot }) => void
  /**
   * Which real branch the semantic owner runs on. `remote` (the default) reads
   * cwd/permission from the official session projection; `direct` reads them from
   * the in-process Host services and the live Agent, which is the OTHER real
   * equivalent source §2.4 requires.
   */
  readonly branch?: 'remote' | 'direct'
} = {}): Promise<Harness> {
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

  // RFL-002: the REAL semantic status owner over the SAME surface. Its
  // `refresh()` reads the official session projection and commits through
  // `surface.commitStatus` — the production source → decision → sink chain.
  /**
   * The official projection store, KEYED BY SESSION ID — the real owner reads
   * `sessionStatus(sessionId)`, so a fixture that ignored the id could not prove
   * which subject answered.
   */
  const sessionStatuses = new Map<string, SessionStatusProjection>()
  let childViewer: { id: string; label: string } | undefined
  const mainStats = new StatsFolder()
  // The official `request/context` event is the ONLY carrier of the context
  // window in this fold (`StatsFolder` owns it); it is applied here, so the
  // derived percent is a real projection fact rather than a test number.
  mainStats.hydrate([
    { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
    {
      type: 'request/context',
      seq: 1,
      time: T0 + 1,
      data: { turn: 1, step: 0, contextWindow: 1_000_000 },
    },
  ] as never)
  const statusRuntime = createStatusRuntime({
    surface,
    updateTerminalTitle: () => {},
    isCleanedUp: () => false,
    // DIRECT branch: the live Agent + the in-process Host services are the
    // source. REMOTE-equivalent: neither exists, so the official session
    // projection answers (the §2.4 "equivalent source" for that branch).
    liveAgent: () => (options.branch === 'direct'
      ? { session: { id: SESSION_ID, header: { cwd: '/agent/AGENT_CWD' } }, options: { provider: 'p', model: 'm' } }
      : undefined),
    generation: () => 1,
    currentSessionId: () => SESSION_ID,
    // The Host semantic reader port: the official projected token count for
    // the exact session. The WINDOW comes from the real stats fold above, so
    // the derived percent is `250000/1000000`.
    measureContext: () => 250_000,
    sessionStatus: (sessionId: string) => sessionStatuses.get(sessionId),
    model: {
      selection: () => undefined,
      currentOf: () => undefined,
      defaultSelection: () => undefined,
      marker: () => undefined,
      preset: () => undefined,
    },
    host: () => (options.branch === 'direct'
      // The in-process Host services the DIRECT branch derives access from.
      ? {
          permissionPresets: {
            current: () => 'danger-full-access',
            optionOf: (name: string) => ({ name, label: name }),
          },
          sandboxPolicy: undefined,
          approval: undefined,
          planMode: undefined,
          sessionProjections: undefined,
        }
      : {
          permissionPresets: undefined,
          sandboxPolicy: undefined,
          approval: undefined,
          planMode: undefined,
          sessionProjections: undefined,
        }),
    // The REMOTE-equivalent branch: no live Agent, so the OFFICIAL session
    // projection is the only source for cwd and permission. The owner derives;
    // the test supplies no patch.
    ...(options.branch === 'direct' ? {} : { remote: { plan: () => undefined } }),
    presentation: { mainStats: () => mainStats },
    // The REAL display-subject selector: answers which Session's status is shown.
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
      options.onStatusReader?.(statusReader)
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
    setSessionStatus(status) {
      if (status === undefined) return
      sessionStatuses.set(status.sessionId, status)
    },
    setChildViewer(viewer) { childViewer = viewer },
    commit(patch) {
      surface.commitStatus(patch as never, {}, undefined)
    },
    async dispose() {
      try {
        surface.dispose()
        await surface.whenRendererReleased()
      } finally {
        pane.restore()
      }
      // The SDK session outlives the mount in this harness until the caller
      // closes it; a failure there must surface, never be swallowed.
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
  // The `seg` children are read from the LIVE node set, not from a row's `c`
  // snapshot: a `set` op updates a live seg in place, and the snapshot the row
  // was added with still carries the value it had at that moment.
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

test('PR-A L6: a real surface.commitStatus reaches the TSP wire as native status rows', async () => {
  const harness = await mountStatuslineHarness()
  try {
    // Before the first formal display commit the mount has already painted its
    // initial dock: read it from the wire, not from a timer.
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    assert.deepEqual(liveStatusRows(harness.pane).map(row => row.key), [],
      'no native status appears before the first formal display commit')

    // The REAL coordination point: `surface.commitStatus` writes the ONE store
    // and then completes the display commit on the mounted renderer.
    harness.commit({
      access: { permissionPreset: { id: 'workspace-write' } },
      workspace: { cwd: '/workspaces/AUTHORITATIVE_WS', branch: 'AUTHORITATIVE_BRANCH' },
      usage: {
        tokens: { input: 2_000, output: 300, cacheRead: 0, cacheWrite: 0 },
        context: { usedTokens: 250_000, windowTokens: 1_000_000, percent: 25 },
        performance: { llmMs: 0 },
        turns: 1,
        steps: 1,
      },
    })
    await drawn('both committed rows on the wire', () =>
      liveStatusRows(harness.pane).map(row => row.key).join(',') === 'status-row-1,status-row-2')

    const rows = liveStatusRows(harness.pane)
    assert.deepEqual(rows.map(row => row.key), ['status-row-1', 'status-row-2'],
      'both rows reached the SDK surface from the real commit')
    const rowOne = rows[0]!
    const rowTwo = rows[1]!
    assert.deepEqual(rowOne.segs.map(seg => seg.key), [
      'status-r1-permission',
      'status-r1-cwd',
      'status-r1-git',
    ])
    assert.ok(rowOne.segs[0]!.text.includes('ww'), `the compact workspace-write word: ${rowOne.segs[0]!.text}`)
    assert.ok(rowOne.segs[1]!.text.includes('AUTHORITATIVE_WS'), 'the cwd basename came from the store')
    assert.ok(rowOne.segs[2]!.text.includes('AUTHORITATIVE_BRANCH'), 'the branch came from the store')
    assert.deepEqual(rowTwo.segs.map(seg => seg.key), ['status-r2-tokens', 'status-r2-context'])
    assert.ok(rowTwo.segs[1]!.text.includes('25%'), `the context percent: ${rowTwo.segs[1]!.text}`)
    assert.equal(rowTwo.segs[1]!.side, 'right')
    assert.equal(rowTwo.segs[1]!.priority, 100)

    // The dock still carries the ONE controlled editor (untouched by PR-A).
    const editor = wireNodes(harness.pane).find(node => node.k === 'editor')
    assert.ok(editor !== undefined, 'the controlled composer is still in the dock')
    assert.equal(editor.p.key, 'composer')
  } finally {
    await harness.dispose()
  }
})

test('PR-A L6: a value update lands in the SAME row, and the retired value is gone', async () => {
  const harness = await mountStatuslineHarness()
  try {
    /**
     * The row-1 segs. A `waitUntil` predicate must never throw (a thrown
     * predicate skips the wait), so an unmounted row reads as an empty list.
     */
    const rowOne = (): { key: string; text: string }[] =>
      liveStatusRows(harness.pane).find(entry => entry.key === 'status-row-1')?.segs ?? []
    harness.commit({ workspace: { cwd: '/workspaces/FIRST_WS' } })
    await drawn('the first cwd on the wire', () => rowOne().some(seg => seg.text.includes('FIRST_WS')))

    harness.commit({ workspace: { cwd: '/workspaces/SECOND_WS' } })
    // The wire is polled until the REPLACEMENT value is the drawn one, so the
    // "old value is gone" assertion below reads a settled frame.
    await drawn('the second cwd on the wire', () => rowOne().some(seg => seg.text.includes('SECOND_WS')))
    const segs = rowOne()
    assert.ok(segs.length > 0, 'row 1 is mounted')
    // ONE cwd seg, in the SAME row: no second status node, no stale sibling.
    assert.equal(segs.filter(seg => seg.key === 'status-r1-cwd').length, 1,
      'the cwd item keeps exactly one seg (no stacked status node)')
    assert.ok(segs.some(seg => seg.text.includes('SECOND_WS')), 'the new cwd is visible')
    assert.ok(!segs.some(seg => seg.text.includes('FIRST_WS')),
      'the retired cwd is not left beside it in the same row')
  } finally {
    await harness.dispose()
  }
})

test('PR-A L6: a session switch hides the outgoing status until the new subject commits', async () => {
  const harness = await mountStatuslineHarness()
  try {
    harness.commit({
      workspace: { cwd: '/workspaces/OUTGOING_WS' },
      access: { permissionPreset: { id: 'read-only' } },
    })
    await drawn('the outgoing cwd on the wire', () =>
      liveStatusRows(harness.pane).some(entry => entry.segs.some(seg => seg.text.includes('OUTGOING_WS'))))
    const outgoing = liveStatusRows(harness.pane).find(entry => entry.key === 'status-row-1')
    assert.ok(outgoing !== undefined, 'the outgoing subject has a row-1')
    assert.ok(outgoing.segs.some(seg => seg.text.includes('OUTGOING_WS')))

    // The switch: hydration begins (the renderer drops the presented status and
    // paints the Loading frame), then the new subject commits.
    harness.surface.display.beginSessionHydration()
    // The hydration frame is the one that carries NO status row.
    await drawn('the hydration frame without a status row', () => liveStatusRows(harness.pane).length === 0)
    assert.deepEqual(liveStatusRows(harness.pane), [],
      "the outgoing subject's status never appears in the hydration frame")

    harness.commit({ workspace: { cwd: '/workspaces/INCOMING_WS' } })
    // The fence lifts only when the NEW source's transcript commits.
    harness.surface.display.setTranscript([], undefined, undefined, undefined, undefined, {})
    await drawn('the incoming cwd on the wire', () =>
      liveStatusRows(harness.pane).some(entry => entry.segs.some(seg => seg.text.includes('INCOMING_WS'))))
    const rows = liveStatusRows(harness.pane)
    const incoming = rows.find(entry => entry.key === 'status-row-1')
    assert.ok(incoming !== undefined, 'the incoming subject paints its own row 1')
    assert.ok(incoming.segs.some(seg => seg.text.includes('INCOMING_WS')), 'the new cwd is visible')
    assert.ok(!incoming.segs.some(seg => seg.text.includes('OUTGOING_WS')),
      "the outgoing subject's cwd never rides the incoming frame")
  } finally {
    await harness.dispose()
  }
})

test('PR-A A-04: a store update alone paints NOTHING until the display commit lands', async () => {
  const harness = await mountStatuslineHarness()
  try {
    await drawn('the initial dock frame', () => harness.pane.frames().length > 0)
    const before = harness.pane.frames().length

    // Write the ONE store directly, WITHOUT the display commit. This is the
    // half-applied state §2.3 forbids the renderer from observing: the renderer
    // must not subscribe, so not a single frame may appear.
    harness.surface.status.update({
      workspace: { cwd: '/workspaces/HALF_APPLIED' },
    } as never)
    await new Promise(resolve => setTimeout(resolve, 60)) // bounded window: proves absence, see below

    assert.equal(harness.pane.frames().length, before,
      'a store update with no display commit emits no frame')
    assert.deepEqual(liveStatusRows(harness.pane), [],
      'no status row pre-publishes the un-committed value')

    // The formal display commit is what publishes it.
    harness.renderer.display.commitDisplaySubject({}, {}, undefined)
    await drawn('the row after the explicit display commit', () =>
      liveStatusRows(harness.pane).some(row => row.segs.some(seg => seg.text.includes('HALF_APPLIED'))))
    assert.ok(liveStatusRows(harness.pane).length > 0, 'the display commit published the value')
  } finally {
    await harness.dispose()
  }
})

test('PR-A A-24: a REAL binder throw propagates and the production release closes once', async () => {
  const pane = installTspPane()
  try {
    // The PRODUCTION selection seam and PRODUCTION connector: the lazy import,
    // `connectTspRenderer` and the wrapper are the shipped ones; only the tty is
    // the scripted pane.
    const { selectRendererMount, productionTspConnector } = await import('../../src/app/bootstrap/renderer-selection.ts')
    const production = productionTspConnector({
      copyVisual: async () => false,
      cwd: '/tmp',
      requestExit: () => {},
      onFatal: () => {},
      log: () => {},
      logError: () => {},
    })
    const tsp = await production()
    assert.ok(tsp !== undefined, 'the production connector acquired a renderer')

    // Make the renderer's OWN binder fail: the first (real) image binding is
    // installed here, so the wrapper's later `bindImages` throws the shipped
    // "already installed" error — a REAL throw from production code, not one the
    // test fabricates.
    tsp.bindImages({} as never)

    const mount = await selectRendererMount({
      log: () => {},
      env: { DSH_PI_TUI_RENDERER: 'tsp' },
      // PR-D: the footer resolver slot; the default projection keeps this
      // PR-A binder-throw witness on its original subject.
      resolveFooterConfig: () => resolveTspNativeFooterConfig({ doc: { footer: 'default' }, readiness: 'ready', userItems: { items: [], invalidCount: 0 } }),
      connectTsp: async () => tsp,
    })
    assert.ok(mount !== undefined, 'the wrapper produced a mount')

    const reader = { snapshot: () => emptyStatusSnapshot() }
    // The REAL wrapper mount: it binds the reader, then the image binder throws.
    assert.throws(() => mount.mount({} as never, reader),
      /already installed/,
      'the production binder error propagates unchanged (never swallowed)')
    // No surface was opened by the failed mount, so the pane has seen no close
    // frame yet: the release below is the FIRST close this session can produce.
    assert.equal(pane.closeFrames(), 0, 'the failed mount closed nothing itself')

    // The caller's release path (bootstrap's `releaseAcquiredRenderer`).
    await mount.releaseUnmounted()
    // The SDK close frame is the AUTHORITATIVE production witness: one close on
    // the wire means the acquired session was released exactly once.
    assert.equal(pane.closeFrames(), 1, 'the acquired session closed exactly once')
    // Idempotence: the same release accessor must not close a second time.
    await mount.releaseUnmounted()
    assert.equal(pane.closeFrames(), 1, 'the second release is inert')
  } finally {
    pane.restore()
  }
})

test('PR-A A-18: a child subject never borrows the main subject facts', async () => {
  const harness = await mountStatuslineHarness()
  try {
    // 1. Establish the MAIN facts FIRST and observe them on the wire — the
    //    positive control: every value the child must not inherit is proven to be
    //    paintable for the main subject.
    harness.setSessionStatus({
      sessionId: SESSION_ID,
      cwd: '/workspaces/MAIN_WS',
      permission: 'danger-full-access',
      context: { projectedTokens: 500_000, contextWindow: 1_000_000 },
      usage: { uncachedInputTokens: 7_000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    harness.statusRuntime.refresh()
    await drawn('the main subject rows on the wire', () =>
      liveStatusRows(harness.pane).some(row => row.segs.some(seg => seg.text.includes('MAIN_WS'))))
    const mainTexts = liveStatusRows(harness.pane).flatMap(row => row.segs.map(seg => seg.text))
    assert.ok(mainTexts.some(text => text.includes('MAIN_WS')), `main cwd painted: ${mainTexts.join(' | ')}`)
    assert.ok(mainTexts.some(text => text.includes('yolo')), `main permission painted: ${mainTexts.join(' | ')}`)
    assert.ok(liveStatusRows(harness.pane).some(row => row.key === 'status-row-2'),
      'the main subject painted row 2 (its own usage)')

    // 2. Now switch to the child. Its projection carries ONLY a cwd — no branch,
    //    no context, no tokens, and a different permission.
    harness.setSessionStatus({
      sessionId: 'child-1',
      cwd: '/child/CHILD_WS',
      permission: 'read-only',
    })
    harness.setChildViewer({ id: 'child-1', label: 'research' })
    harness.statusRuntime.refresh()
    await drawn('the child subject rows on the wire', () =>
      liveStatusRows(harness.pane).some(row => row.segs.some(seg => seg.text.includes('CHILD_WS'))))

    const rows = liveStatusRows(harness.pane)
    const childTexts = rows.flatMap(row => row.segs.map(seg => seg.text))
    // The child's OWN facts.
    assert.ok(childTexts.some(text => text.includes('CHILD_WS')), `child cwd: ${childTexts.join(' | ')}`)
    assert.ok(childTexts.some(text => text.includes('ro')), `child permission: ${childTexts.join(' | ')}`)
    // NONE of the main subject's facts may ride the child frame.
    for (const borrowed of ['MAIN_WS', 'yolo']) {
      assert.ok(!childTexts.some(text => text.includes(borrowed)),
        `the child frame must not carry the main "${borrowed}": ${childTexts.join(' | ')}`)
    }
    // The child has no plan (a child plan is never effective) and no usage, so
    // row 2 must be ABSENT entirely — no inherited context percent, no tokens.
    assert.ok(!childTexts.includes('plan'), `no plan on a child: ${childTexts.join(' | ')}`)
    assert.equal(rows.filter(row => row.key === 'status-row-2').length, 0,
      'the child painted no row 2: it inherits neither the main context nor its tokens')
    assert.ok(!childTexts.some(text => text.includes('%')),
      `no inherited context percent: ${childTexts.join(' | ')}`)
  } finally {
    await harness.dispose()
  }
})

test('PR-A A-03 L6: the REAL StatusRuntime source reaches the TSP wire', async () => {
  const harness = await mountStatuslineHarness()
  try {
    // The official projection the semantic owner reads: a permission preset, a
    // session cwd and a context window. NOTHING here is a StatusPatch — the
    // owner derives it.
    harness.setSessionStatus({
      sessionId: SESSION_ID,
      cwd: '/workspaces/REAL_SOURCE_WS',
      permission: 'read-only',
      context: { projectedTokens: 250_000, contextWindow: 1_000_000 },
    })

    // The production entry points: the real context measurement writes the
    // cached pressure through the semantic reader port, then `refresh()` folds
    // it into the patch and commits. No value below is supplied by the test.
    harness.statusRuntime.refreshContextMeasurement('turn-end')
    harness.statusRuntime.refresh()
    await drawn('the real-source row 1 on the wire', () =>
      liveStatusRows(harness.pane).some(row => row.key === 'status-row-1'))

    const rowOne = liveStatusRows(harness.pane).find(row => row.key === 'status-row-1')
    assert.ok(rowOne !== undefined, 'the real source painted row 1')
    const texts = rowOne.segs.map(seg => seg.text)
    assert.ok(texts.includes('ro'), `the derived permission reached the wire: ${texts.join(' | ')}`)
    assert.ok(texts.some(text => text.includes('REAL_SOURCE_WS')),
      `the derived session cwd reached the wire: ${texts.join(' | ')}`)

    const rowTwo = liveStatusRows(harness.pane).find(row => row.key === 'status-row-2')
    assert.ok(rowTwo !== undefined, 'the derived usage painted row 2')
    assert.ok(rowTwo.segs.some(seg => seg.text.includes('25%')),
      `the MEASURED context percent reached the wire: ${rowTwo.segs.map(seg => seg.text).join(' | ')}`)

    // NEGATIVE: a permission the owner does NOT hold is never painted. The
    // owner reports `read-only`, so no dangerous-preset word may appear.
    const allTexts = liveStatusRows(harness.pane).flatMap(row => row.segs.map(seg => seg.text))
    assert.ok(!allTexts.some(text => text.includes('yolo')),
      'the derived status never invents danger-full-access')
  } finally {
    await harness.dispose()
  }
})

test('PR-A A-03 L6: the DIRECT branch source reaches the TSP wire too', async () => {
  // The plan §2.4 requires one real equivalent source fixture PER branch. This is
  // the Direct one: the live Agent supplies the session/header cwd and the
  // in-process Host permission service supplies the preset. The owner derives the
  // patch; this test supplies none.
  const harness = await mountStatuslineHarness({ branch: 'direct' })
  try {
    harness.statusRuntime.refresh()
    await drawn('the Direct-source row 1 on the wire', () =>
      liveStatusRows(harness.pane).some(row => row.key === 'status-row-1'))

    const rowOne = liveStatusRows(harness.pane).find(row => row.key === 'status-row-1')
    assert.ok(rowOne !== undefined, 'the Direct source painted row 1')
    const texts = rowOne.segs.map(seg => seg.text)
    assert.ok(texts.some(text => text.includes('AGENT_CWD')),
      `the Agent-header cwd reached the wire: ${texts.join(' | ')}`)
    // `danger-full-access` formats to `yolo` in the compact permission style, so
    // its presence proves the Host service (not the absent projection) answered.
    assert.ok(texts.some(text => text.includes('yolo')),
      `the Host permission preset reached the wire: ${texts.join(' | ')}`)
    // And the same fact carries the warning tone the client receives.
    const permissionSeg = rowOne.segs.find(seg => seg.key === 'status-r1-permission')
    assert.equal(permissionSeg?.tone, 'warning', 'the dangerous preset carries its warning tone')
  } finally {
    await harness.dispose()
  }
})

test('PR-A: the ACTUAL reader the surface passes to the mount carries only snapshot()', async () => {
  // Capture the object the SURFACE hands the mount — not a fixture of this test.
  const captured: { reader?: object } = {}
  const harness = await mountStatuslineHarness({
    onStatusReader: reader => { captured.reader = reader },
  })
  try {
    const reader = captured.reader
    assert.ok(reader !== undefined, 'the surface handed the mount a reader')
    assert.deepEqual(Object.keys(reader), ['snapshot'],
      'the production reader exposes exactly the one getter')
    assert.equal(typeof (reader as { snapshot: () => unknown }).snapshot, 'function')
    // The store keeps every writer; NONE of them travelled with the reader.
    for (const writer of ['update', 'subscribe', 'replace', 'revision'] as const) {
      assert.equal(writer in reader, false, `the reader carries no "${writer}"`)
      assert.equal(typeof harness.surface.status[writer], 'function',
        `the store still owns "${writer}"`)
    }
    // It reads the SAME store the surface writes: a committed patch is visible
    // through the captured reader, which is what makes it a real projection.
    harness.commit({ workspace: { cwd: '/workspaces/PORT_PROBE' } })
    assert.equal(harness.surface.status.snapshot().workspace.cwd, '/workspaces/PORT_PROBE')
    assert.equal((reader as { snapshot: () => { workspace: { cwd: string } } }).snapshot().workspace.cwd,
      '/workspaces/PORT_PROBE', 'the captured reader observes the committed store')
  } finally {
    await harness.dispose()
  }
})

test('PR-A A-12: plan effective and pending keep the builtin distinction', () => {
  const base = emptyStatusSnapshot()
  const withPlan = (plan: { effective: boolean; pending?: boolean }): string[] => {
    const snapshot = {
      ...base,
      usage: { ...base.usage, tokens: undefined },
      collaboration: { plan },
    } as unknown as StatusSnapshot
    return segTexts(nativeStatuslineRows(snapshot))
  }
  assert.ok(withPlan({ effective: true }).includes('plan'), 'an effective plan reads `plan`')
  assert.ok(withPlan({ effective: false, pending: true }).includes('plan pending'),
    'a PENDING plan reads `plan pending` — the two states are never conflated')
  assert.equal(withPlan({ effective: false }).length, 0,
    'no plan state at all paints no plan seg (no fabricated default)')
})

test('PR-A A-05 L6: ONE commit updates BOTH rows in the same dock frame', async () => {
  const harness = await mountStatuslineHarness()
  try {
    harness.commit({
      workspace: { cwd: '/workspaces/BEFORE_WS' },
      usage: {
        tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
        context: { usedTokens: 100_000, windowTokens: 1_000_000, percent: 10 },
        performance: { llmMs: 0 }, turns: 1, steps: 1,
      },
    })
    await drawn('the before rows', () =>
      liveStatusRows(harness.pane).some(row => row.segs.some(seg => seg.text.includes('BEFORE_WS'))))

    // ONE patch touching BOTH rows: the workspace (row 1) and the usage (row 2).
    harness.commit({
      workspace: { cwd: '/workspaces/AFTER_WS' },
      usage: {
        tokens: { input: 2_000, output: 300, cacheRead: 0, cacheWrite: 0 },
        context: { usedTokens: 500_000, windowTokens: 1_000_000, percent: 50 },
        performance: { llmMs: 0 }, turns: 2, steps: 2,
      },
    })
    await drawn('the after rows', () =>
      liveStatusRows(harness.pane).some(row => row.segs.some(seg => seg.text.includes('AFTER_WS'))))

    const rows = liveStatusRows(harness.pane)
    const rowOne = rows.find(row => row.key === 'status-row-1')!
    const rowTwo = rows.find(row => row.key === 'status-row-2')!
    // Both rows carry the NEW facts, and neither retains the old ones.
    assert.ok(rowOne.segs.some(seg => seg.text.includes('AFTER_WS')), 'row 1 got the new cwd')
    assert.ok(!rowOne.segs.some(seg => seg.text.includes('BEFORE_WS')), 'row 1 dropped the old cwd')
    assert.ok(rowTwo.segs.some(seg => seg.text.includes('ctx 50%')), 'row 2 got the new context')
    assert.ok(!rowTwo.segs.some(seg => seg.text.includes('ctx 10%')), 'row 2 dropped the old context')
    assert.ok(rowTwo.segs.some(seg => seg.text.includes('2.0k')), 'row 2 got the new token pair')
  } finally {
    await harness.dispose()
  }
})

test('PR-A A-06 L6: an identical repeat commit adds no node and no frame storm', async () => {
  const harness = await mountStatuslineHarness()
  try {
    const patch = {
      workspace: { cwd: '/workspaces/STABLE_WS' },
      usage: {
        tokens: { input: 5_000, output: 500, cacheRead: 0, cacheWrite: 0 },
        context: { usedTokens: 200_000, windowTokens: 1_000_000, percent: 20 },
        performance: { llmMs: 0 }, turns: 1, steps: 1,
      },
    }
    harness.commit(patch)
    await drawn('the stable rows', () =>
      liveStatusRows(harness.pane).some(row => row.segs.some(seg => seg.text.includes('STABLE_WS'))))
    const segKeys = liveStatusRows(harness.pane).flatMap(row => row.segs.map(seg => seg.key)).sort()
    const framesAfterFirst = harness.pane.frames().length

    // The SAME content again (a fresh object, the store compares by content).
    for (let repeat = 0; repeat < 3; repeat += 1) harness.commit(structuredClone(patch))
    await new Promise(resolve => setTimeout(resolve, 80)) // bounded window: proves no extra frame

    const rows = liveStatusRows(harness.pane)
    assert.deepEqual(rows.flatMap(row => row.segs.map(seg => seg.key)).sort(), segKeys,
      'no seg was added or duplicated by the repeats')
    assert.equal(rows.length, 2, 'still exactly two status rows')
    // An identical commit must not churn the store, so no repaint is queued.
    assert.equal(harness.pane.frames().length, framesAfterFirst,
      'three identical commits emitted no additional frame (no render storm)')
  } finally {
    await harness.dispose()
  }
})

test('PR-A A-08 L6: a Remote session with no token projection paints no token seg', async () => {
  const harness = await mountStatuslineHarness()
  try {
    // The official projection carries a context window and NO usage at all.
    harness.setSessionStatus({
      sessionId: SESSION_ID,
      cwd: '/workspaces/REMOTE_WS',
      context: { projectedTokens: 250_000, contextWindow: 1_000_000 },
    })
    harness.statusRuntime.refreshContextMeasurement('turn-end')
    harness.statusRuntime.refresh()
    await drawn('the remote rows', () =>
      liveStatusRows(harness.pane).some(row => row.key === 'status-row-2'))

    const rowTwo = liveStatusRows(harness.pane).find(row => row.key === 'status-row-2')!
    const texts = rowTwo.segs.map(seg => seg.text)
    assert.ok(texts.some(text => text.includes('ctx 25%')),
      `the projected context reached the wire: ${texts.join(' | ')}`)
    assert.ok(!texts.some(text => text.includes('↑') || text.includes('↓')),
      `no fabricated ↑0 ↓0 for an absent token projection: ${texts.join(' | ')}`)
    assert.deepEqual(rowTwo.segs.map(seg => seg.key), ['status-r2-context'],
      'the token seg is absent, the context seg is not')
  } finally {
    await harness.dispose()
  }
})

test('PR-A: a dangerous permission carries the warning tone, a safe one does not', () => {
  const base = emptyStatusSnapshot()
  const withPermission = (id: string): StatusSnapshot => ({
    ...base,
    usage: { ...base.usage, tokens: undefined },
    access: { permissionPreset: { id } },
  }) as unknown as StatusSnapshot

  /** The permission seg's own `tone` prop, read off the real projection. */
  const toneOf = (id: string): unknown => {
    const row = nativeStatuslineRows(withPermission(id))[0]
    assert.ok(row !== undefined, `row 1 renders for ${id}`)
    const seg = children(row).find(child => props(child).key === 'status-r1-permission')
    assert.ok(seg !== undefined, `the permission seg exists for ${id}`)
    return props(seg).tone
  }

  assert.equal(toneOf('danger-full-access'), 'warning',
    'the builtin warning severity reaches the client as a native tone')
  assert.equal(toneOf('custom'), 'warning', 'a custom preset keeps its warning severity')
  assert.equal(toneOf('read-only'), 'muted',
    'a read-only preset is de-emphasized, never painted like yolo')
  assert.notEqual(toneOf('danger-full-access'), toneOf('read-only'),
    'danger and read-only are distinguishable by tone, not only by text')
})

/** Keep the typed imports above honest for the exported surface. */
export type { Node }
export { SessionSeq, T0 }
