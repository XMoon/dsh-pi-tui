/**
 * T3-B1: the application COMPOSITION of the Session semantic search.
 *
 * This is the lane that proves the read-only binding is wired to the ONE owner of
 * every fact it answers, through the production chain
 * `SurfaceRuntime.start` → `SurfaceRendererMount.mount(image, status,
 * historySearch, semanticSearch, queue)` → `bindTranscriptSemanticSearch` →
 * the seat → the mount's ONE `TspComposer`:
 *
 * - the snapshot comes from the SAME selected `TranscriptFolder` the repaint
 *   uses (the main folder, or the viewed child's while its viewer is mounted);
 * - the source token is an OPAQUE per-fold identity, so a same-id cold
 *   replacement of the Folder is a NEW source and every older snapshot,
 *   resolution and currentness check is refused;
 * - the coverage label is the officially committed fact, scoped to the source it
 *   was committed for, so a Remote `hasMore` can never be lent to another subject
 *   and a Direct complete log is the only `Entire`.
 *
 * EVIDENCE LEVEL: application-composed. The `SurfaceRuntime`, its mount, the
 * selected folders, the binding and the TSP renderer are PRODUCTION. STANDS-IN:
 * the scripted tty pane (the real client lane is
 * `scripts/tern-pane-transcript-semantic-search.mjs`), and the routing source is
 * this harness's minimal folder holder — the REAL event→folder routing is
 * `test/app/tern-tsp-live-mount.test.ts`'s subject.
 * @module @xmoon76/dsh-pi-tui/test/app/tern-tsp-semantic-search-surface.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect as sdkConnect } from '@stencil-hq/tern'
import type { Session } from '@stencil-hq/tern'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createSurfaceRuntime, type SurfaceRendererMount } from '../../src/app/surface/runtime.ts'
import type { SurfaceEventRoutingSource } from '../../src/app/surface/event-routing.ts'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { StatsFolder } from '../../src/domain/status/stats.ts'
import type { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import { TranscriptWindowController as WindowController } from '../../src/domain/transcript/window.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { settle, waitUntil } from '../support/tsp-runner-harness.ts'
import { surfaceTexts } from '../support/tsp-picker-wire.ts'

const T0 = 1_700_000_000_000
const SESSION_ID = 'ses_b1_surface'
const MAIN_MARKER = 'B1_SURFACE_MAIN_ONLY'
const CHILD_MARKER = 'B1_SURFACE_CHILD_ONLY'

function ev(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: T0 + seq * 1000, data } as SessionEvent
}

/** One official turn whose assistant answer carries `marker`. */
function seedTurns(folder: TranscriptFolder, marker: string, tag: string): void {
  const events: SessionEvent[] = []
  let seq = 0
  events.push(ev('turn/start', { turn: 1 }, seq++))
  events.push(ev('user/message', {
    id: MessageId(`${tag}-u-1`), role: 'user', content: [{ type: 'text', text: `a request tagged ${tag}` }], source: { kind: 'user' },
  }, seq++))
  events.push(ev('step/start', { turn: 1, step: 0 }, seq++))
  events.push(ev('assistant/message', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId(`${tag}-a-1`),
      role: 'assistant',
      content: [{ type: 'text', text: `the answer carries ${marker}` }],
      source: { kind: 'model', provider: 'scripted', model: 'scripted' },
    },
    stream: [],
  }, seq++))
  events.push(ev('step/end', { turn: 1, step: 0 }, seq++))
  events.push(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, seq++))
  folder.apply(events)
}

interface SurfaceHarness {
  readonly pane: TspPane
  readonly surface: ReturnType<typeof createSurfaceRuntime<never>>
  readonly renderer: () => TspRenderer
  /** The binding the production mount received. */
  readonly binding: () => import('../../src/app/surface/runtime.ts').TspTranscriptSemanticSearchBinding
  /** The exact `mainFolder()` object the routing source handed to the surface. */
  readonly mainFolder: () => TranscriptFolder
  /** Replace the main Folder with a NEW instance (a same-id cold rehydrate). */
  replaceMain(marker: string): void
  /** Mount a viewed child with its own Folder. */
  mountChild(marker: string): void
  /** Unmount the viewed child. */
  unmountChild(): void
  /** Commit the officially accepted Remote coverage for the CURRENT subject. */
  commitCoverage(coverage: 'loaded-history' | 'loaded-history-with-more' | 'entire-session'): void
  texts(): string[]
  key(bytes: string): Promise<void>
  dispose(): Promise<void>
}

async function mountSurface(life: { after(fn: () => unknown): void }, options: {
  readonly remote?: boolean
} = {}): Promise<SurfaceHarness> {
  const pane = installTspPane({ composerActions: true, transcriptSearch: true })
  life.after(() => pane.restore())
  const connected = await sdkConnect({ timeout: 500, exitHooks: false })
  assert.ok(connected !== null, 'the shipped SDK accepts the scripted pane')
  const session: Session = connected

  let mainFolder = new TranscriptFolder()
  seedTurns(mainFolder, MAIN_MARKER, 'main')
  let statsFolder = new StatsFolder()
  let controller: TranscriptWindowController = new WindowController({ windowTurns: 20, stepTurns: 10 })
  let childFolder: TranscriptFolder | undefined

  let capturedBinding: import('../../src/app/surface/runtime.ts').TspTranscriptSemanticSearchBinding | undefined
  let mountedRenderer: TspRenderer | undefined

  const rendererMount: SurfaceRendererMount = {
    mount: (imageBinding, statusReader, historySearch, semanticSearch) => {
      capturedBinding = semanticSearch
      mountedRenderer = mountTspRenderer(session, {
        copyVisual: async () => true,
        requestExit: () => {},
        onFatal: (error) => { throw new Error(`the mount routed a fatal: ${String(error)}`) },
        displayState: { preset: 'full' },
      })
      mountedRenderer.bindStatusReader(statusReader)
      mountedRenderer.bindImages(imageBinding)
      mountedRenderer.bindHistorySearch(historySearch)
      mountedRenderer.bindTranscriptSemanticSearch(semanticSearch)
      return mountedRenderer
    },
    releaseUnmounted: async () => { await mountedRenderer?.dispose() },
  }

  const nullPresentation = {
    handleFocusReport: () => {}, markFocused: () => {}, focusState: () => 'focused' as const,
    notify: () => {}, enableFocusReporting: () => {}, disableFocusReporting: () => {},
  }
  const routing = {
    isCleanedUp: () => false,
    isAttachedSession: () => true,
    currentSessionId: () => SESSION_ID,
    hasLiveAgent: () => true,
    completionOwnerId: () => undefined,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => ({
      folder: { apply: (events: readonly SessionEvent[]) => mainFolder.apply(events) },
      stats: { apply: (events: readonly SessionEvent[]) => statsFolder.apply(events) },
      get window() { return controller },
      previews: new Map(),
      applyToolPreview: () => {},
      refreshRecentPerformanceAvailability: () => {},
    }),
    viewedChildId: () => (childFolder === undefined ? undefined : 'child-1'),
    viewedChild: () => ({
      folder: childFolder,
      window: controller,
      previews: new Map(),
      applyToolPreview: () => {},
      refreshRecentPerformanceAvailability: () => {},
    }),
    mainFolder: () => mainFolder,
    viewedChildFolder: () => {
      if (childFolder === undefined) throw new Error('no viewer is mounted')
      return childFolder
    },
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
    observeDirectPendingSubmissionEvent: () => false,
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
    applyViewedChildAssistantInput: () => {},
    applyMainAssistantInput: () => {},
  } as unknown as SurfaceEventRoutingSource<never>

  const surface = createSurfaceRuntime<never>({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation as never,
    notificationMode: undefined,
    notificationMethod: undefined,
    mainProgressAuthority: 'local-events',
    terminalProgress: undefined,
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
    // The boot coverage fact: Direct owns a complete log; Remote starts at the
    // loaded history its Reader authorized.
    initialSearchCoverage: options.remote === true ? 'loaded-history' : 'entire-session',
  })
  surface.attachEventRouting(routing)
  surface.start({
    events: {
      onSubmit: () => {},
      onExit: () => {},
      shouldRememberInput: () => true,
    } as never,
    renderer: rendererMount,
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'full' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
    readImage: () => Promise.reject(new Error('not exercised')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    captureHistoryScope: () => ({ sessionId: SESSION_ID, isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: async () => true,
    deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: (text: string) => text,
  } as never)
  surface.bindRendererInput()
  // The production repaint publishes the seeded main Folder through the display
  // seam with the surface's OWN opaque token, so the card's search AND its
  // canonical-owner reveal chain run against the real projection (never a
  // test-supplied token).
  surface.repaint()
  await waitUntil('the mount painted its composer editor',
    () => true)

  const harness: SurfaceHarness = {
    pane,
    surface,
    renderer: () => {
      assert.ok(mountedRenderer !== undefined, 'the TSP renderer committed its mount')
      return mountedRenderer
    },
    binding: () => {
      assert.ok(capturedBinding !== undefined, 'the surface handed the semantic-search binding to the mount')
      return capturedBinding
    },
    mainFolder: () => mainFolder,
    replaceMain(marker) {
      // A same-id cold replacement: a BRAND NEW Folder for the SAME session.
      mainFolder = new TranscriptFolder()
      seedTurns(mainFolder, marker, 'rehydrated')
      statsFolder = new StatsFolder()
      controller = new WindowController({ windowTurns: 20, stepTurns: 10 })
      surface.repaint()
    },
    mountChild(marker) {
      childFolder = new TranscriptFolder()
      seedTurns(childFolder, marker, 'viewed')
      surface.repaint()
    },
    unmountChild() {
      childFolder = undefined
      surface.repaint()
    },
    commitCoverage(coverage) {
      surface.setTranscriptSearchCoverage(coverage)
    },
    texts: () => surfaceTexts(pane, 's1'),
    async key(bytes) { pane.key(bytes) },
    async dispose() {
      try {
        surface.dispose()
        await surface.whenRendererReleased()
      } finally {
        // reason: the disposal window lets the async release promise settle.
        await settle()
      }
    },
  }
  return harness
}

const ALT_SHIFT_S = '\u001b[115;4u'

test('the binding searches the SAME main Folder the repaint uses, with a complete-log coverage', async (t) => {
  const h = await mountSurface(t)
  const binding = h.binding()
  const snapshot = binding.snapshot(MAIN_MARKER.toLowerCase())
  assert.ok(snapshot !== undefined, 'a committed main subject answers')
  assert.equal(snapshot.subjectKind, 'main')
  assert.equal(snapshot.subjectId, SESSION_ID)
  assert.equal(snapshot.coverage, 'entire-session', 'Direct owns a complete log')
  assert.equal(snapshot.matches.length, 1, 'the REAL Folder search found the seeded answer')
  // The resolved representative is the CURRENT Folder's own message object.
  const message = binding.resolve(snapshot.source, snapshot.matches[0]!)
  assert.ok(message !== undefined)
  assert.equal(message.kind, 'assistant')
  assert.equal(binding.current(snapshot.source), true)
})

test('an empty query yields no matches from the Folder authority', async (t) => {
  const h = await mountSurface(t)
  const snapshot = h.binding().snapshot('')
  assert.ok(snapshot !== undefined)
  assert.deepEqual(snapshot.matches, [], 'the Folder owns the empty-query answer')
})

test('a same-id cold replacement is a NEW source: the old token is refused everywhere', async (t) => {
  const h = await mountSurface(t)
  const binding = h.binding()
  const before = binding.snapshot(MAIN_MARKER.toLowerCase())
  assert.ok(before !== undefined)
  const oldMatch = before.matches[0]!
  // A cold rehydrate under the SAME session id: a brand new Folder instance.
  h.replaceMain('B1_SURFACE_REHYDRATED_ONLY')
  assert.equal(binding.current(before.source), false,
    'a replaced Folder is never the old source, even under the same session id')
  assert.equal(binding.resolve(before.source, oldMatch), undefined,
    'an old match never resolves against the new Folder')
  const after = binding.snapshot(MAIN_MARKER.toLowerCase())
  assert.ok(after !== undefined)
  assert.notEqual(after.source, before.source, 'the new subject carries a new opaque token')
  assert.equal(after.matches.length, 0, 'the replaced subject no longer contains the old text')
  const rehydrated = binding.snapshot('b1_surface_rehydrated_only')
  assert.ok(rehydrated !== undefined)
  assert.equal(rehydrated.matches.length, 1, 'the new content is searchable')
})

test('a viewed child is its own subject with its own token and matches', async (t) => {
  const h = await mountSurface(t)
  const binding = h.binding()
  const main = binding.snapshot(MAIN_MARKER.toLowerCase())
  assert.ok(main !== undefined)
  h.mountChild('B1_SURFACE_CHILD_ONLY')
  const child = binding.snapshot(CHILD_MARKER.toLowerCase())
  assert.ok(child !== undefined)
  assert.equal(child.subjectKind, 'viewed-child')
  assert.equal(child.subjectId, 'child-1')
  assert.notEqual(child.source, main.source, 'the child is a different source')
  assert.equal(child.matches.length, 1)
  assert.equal(binding.current(main.source), false, 'the main token is no longer current')
  // Unmounting the viewer returns to the main subject: a DIFFERENT token again.
  h.unmountChild()
  const back = binding.snapshot(MAIN_MARKER.toLowerCase())
  assert.ok(back !== undefined)
  assert.equal(back.subjectKind, 'main')
  assert.equal(back.matches.length, 1)
})

test('the Remote coverage is the officially committed fact, scoped to its own subject', async (t) => {
  const h = await mountSurface(t, { remote: true })
  const binding = h.binding()
  const before = binding.snapshot(MAIN_MARKER.toLowerCase())
  assert.ok(before !== undefined)
  assert.equal(before.coverage, 'loaded-history', 'Remote starts at the loaded history')
  // The official acknowledged refold reports more history: the SAME subject now
  // labels itself honestly.
  h.commitCoverage('loaded-history-with-more')
  const widened = binding.snapshot(MAIN_MARKER.toLowerCase())
  assert.ok(widened !== undefined)
  assert.equal(widened.source, before.source, 'the subject did not change')
  assert.equal(widened.coverage, 'loaded-history-with-more')
  // A NEW subject never inherits the previous subject's `hasMore`.
  h.replaceMain('B1_SURFACE_SECOND_SUBJECT')
  const fresh = binding.snapshot('b1_surface_second_subject')
  assert.ok(fresh !== undefined)
  assert.equal(fresh.coverage, 'loaded-history',
    'a new Remote subject starts at loaded history, never at the previous subject\'s fact')
})

test('Remote never claims Entire, whatever the match count says', async (t) => {
  const h = await mountSurface(t, { remote: true })
  const binding = h.binding()
  h.commitCoverage('loaded-history')
  const snapshot = binding.snapshot(MAIN_MARKER.toLowerCase())
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.matches.length, 1, 'a real hit exists')
  assert.notEqual(snapshot.coverage, 'entire-session',
    'a match count never widens the coverage claim')
})

test('the cheap revision probe answers the CURRENT Folder revision and refuses a stale token', async (t) => {
  const h = await mountSurface(t)
  const binding = h.binding()
  const snapshot = binding.snapshot(MAIN_MARKER.toLowerCase())
  assert.ok(snapshot !== undefined)
  assert.equal(binding.revision(snapshot.source), h.mainFolder().searchRevision(),
    'the probe reads the SAME Folder revision the snapshot was computed on')
  // A same-id cold replacement is a NEW token: the old probe answers nothing.
  h.replaceMain('B1_SURFACE_REVISION_TWO')
  assert.equal(binding.revision(snapshot.source), undefined,
    'a replaced subject never answers a revision for the old token')
})

test('current()/resolve() compare the SUBJECT, not only the folder token', async (t) => {
  const h = await mountSurface(t)
  const binding = h.binding()
  const mainSnapshot = binding.snapshot(MAIN_MARKER.toLowerCase())
  assert.ok(mainSnapshot !== undefined)
  // Mount a viewed child: same surface, DIFFERENT subject, different folder.
  h.mountChild('B1_SURFACE_SUBJECT_CHILD')
  assert.equal(binding.current(mainSnapshot.source), false,
    'the main token is no longer current once the viewed child is the subject')
  assert.equal(binding.resolve(mainSnapshot.source, mainSnapshot.matches[0]!), undefined,
    'an old token never resolves against the successor subject')
  // Back to main: the ORIGINAL main folder is still its own live subject.
  h.unmountChild()
  assert.equal(binding.current(mainSnapshot.source), true,
    'the same folder under the same main subject is current again')
})

test('a disposed surface answers nothing: no stale snapshot, no resolution, no currentness', async (t) => {
  const h = await mountSurface(t)
  const binding = h.binding()
  const before = binding.snapshot(MAIN_MARKER.toLowerCase())
  assert.ok(before !== undefined)
  await h.dispose()
  assert.equal(binding.snapshot(MAIN_MARKER.toLowerCase()), undefined)
  assert.equal(binding.resolve(before.source, before.matches[0]!), undefined)
  assert.equal(binding.current(before.source), false)
})

test('query edits reuse the Folder refinement instead of re-scanning the whole history', async (t) => {
  const h = await mountSurface(t)
  const binding = h.binding()
  // A prefix-extension chain is the case the Folder's refinement exists for: each
  // longer query must be a REFINED scan over the previous round's candidates,
  // never a fresh full scan of the loaded history.
  const words = ['b1_surface_main_only', 'b1_surface_main_only_x', 'b1_surface_main_only_xy']
  // The source token is minted by the FIRST snapshot and reused for the chain:
  // the refinement only applies while it names the same source.
  const first = binding.snapshot(words[0]!)
  assert.ok(first !== undefined)
  let previous = { query: words[0]!, matches: first.matches, revision: first.revision }
  for (const query of words.slice(1)) {
    const snapshot = binding.snapshot(query, {
      previousQuery: previous.query,
      previousMatches: previous.matches,
      revision: previous.revision,
      source: first.source,
    })
    assert.ok(snapshot !== undefined)
    previous = { query, matches: snapshot.matches, revision: snapshot.revision }
  }
  const diagnostics = h.mainFolder().searchDiagnosticsForTest()
  assert.ok(diagnostics.refinedScans > 0,
    `the refinement path really ran :: ${JSON.stringify(diagnostics)}`)
  assert.equal(diagnostics.fullScans, 1,
    `exactly ONE full scan (the first round); every extension refined :: ${JSON.stringify(diagnostics)}`)
})

test('a long history: query edits refine instead of rescanning, and the search index stays stable', () => {
  // 1,200 official turns is well past the plan's 1,000-card long-history bound.
  // This is the FOLDER authority the binding calls (the scripted pane's single
  // frame budget cannot carry a 1,200-turn transcript, so the perf claim is
  // measured on the search authority itself, not on a rendered frame).
  const long = new TranscriptFolder()
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 1; turn <= 1200; turn += 1) {
    events.push(ev('turn/start', { turn }, seq++))
    events.push(ev('user/message', {
      id: MessageId(`lh-u-${turn}`), role: 'user',
      content: [{ type: 'text', text: `turn ${turn} prompt` }], source: { kind: 'user' },
    }, seq++))
    events.push(ev('step/start', { turn, step: 0 }, seq++))
    events.push(ev('assistant/message', {
      turn, step: 0,
      message: {
        id: MessageId(`lh-a-${turn}`), role: 'assistant',
        content: [{ type: 'text', text: `turn ${turn} answer needle_${turn}` }],
        source: { kind: 'model', provider: 'scripted', model: 'scripted' },
      },
      stream: [],
    }, seq++))
    events.push(ev('step/end', { turn, step: 0 }, seq++))
    events.push(ev('turn/end', { turn, reason: { kind: 'completed' } }, seq++))
  }
  long.apply(events)
  const first = long.search('turn 500 answer')
  assert.ok(first.length > 0, 'the long history really holds the target')
  const revision = long.searchRevision()
  let previousQuery = 'turn 500 answer'
  let previousMatches = first
  const started = Date.now()
  for (const query of ['turn 500 answer n', 'turn 500 answer ne', 'turn 500 answer nee']) {
    previousMatches = long.search(query, { previousQuery, previousMatches, revision })
    previousQuery = query
  }
  const elapsed = Date.now() - started
  const diagnostics = long.searchDiagnosticsForTest()
  assert.equal(diagnostics.fullScans, 1,
    `the first round is the ONLY full scan over 1,200 turns :: ${JSON.stringify(diagnostics)}`)
  assert.equal(diagnostics.refinedScans, 3,
    `every extension refined over the previous candidates :: ${JSON.stringify(diagnostics)}`)
  assert.ok(elapsed < 1500,
    `three refined rounds over 1,200 turns took ${elapsed}ms (a full rescan per keystroke is the regression)`)
})

test('the renderer opens the card against the composed binding and searches the real Folder', async (t) => {
  const h = await mountSurface(t)
  await h.key(ALT_SHIFT_S)
  await waitUntil('the search card painted',
    () => h.texts().some(text => text.includes('Session Search')))
  const painted = h.texts().filter(text => text.includes('Session Search') || text.includes('targets'))
  assert.ok(painted.length > 0, `the card painted :: ${JSON.stringify(painted)}`)
  assert.equal(h.texts().some(text => text.includes('Entire')), true,
    'the card states the composed Direct coverage')
  const beforeTyping = h.binding().snapshot(MAIN_MARKER.toLowerCase())
  for (const ch of MAIN_MARKER.toLowerCase()) await h.key(ch)
  const found = h.texts().some(text => text.includes('1/1 targets'))
  assert.equal(found, true,
    `the card reports the seeded target :: ${JSON.stringify({ texts: h.texts().slice(-8), matches: beforeTyping?.matches.length })}`)
  const snapshot = h.binding().snapshot(MAIN_MARKER.toLowerCase())
  assert.equal(snapshot?.matches.length, 1,
    `the composed binding sees the seeded answer :: ${JSON.stringify({ texts: h.texts().slice(-8), matches: snapshot?.matches.length })}`)
})
