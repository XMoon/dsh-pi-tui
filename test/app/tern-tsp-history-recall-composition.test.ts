/**
 * The SAME-RUN chain from a real TSP Enter to a real ↑ that the user sees:
 *
 *   `SurfaceRuntime.pendingInputBinding` (one real mount)
 *     → the REAL `SubmissionController.submit(text, request, scopeToken)`
 *     → the REAL `InputHistory.persist` + the REAL JSONL file
 *     → the REAL `display.settleScopeInput` → the SAME mount's recall kernel
 *     → the owner's REAL `resetInputHistory` reseed
 *     → a REAL decoded ↑/↓ on the controlled `ui.editor` wire
 *
 * The decisive witness is the SCOPE TOKEN, not the row text: a tokenless
 * writer's row is interleaved between two tokened Enters, and the visible
 * browse must be `b → z → a`. Losing the token in the production submit
 * handoff cannot produce that order, so the case is falsifiable by a mutation
 * at the real controller call site. See the mutation log in the PR.
 *
 * EVIDENCE LEVEL: application-composed / SDK wire. The SurfaceRuntime, its
 * input binding, the TSP mount, the SDK, the controller, the writer, the JSONL
 * store, the scope kernel and the display seam are PRODUCTION. The Host/model
 * side is a declared stand-in: a scripted Agent-like, a synchronous writer
 * sink and a scripted tty (no physical Tern client or Remote qualification).
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-history-recall-composition.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { connect as sdkConnect, concatBytes } from '@stencil-hq/tern'
import type { Op, Session, TermInput, TermOutput } from '@stencil-hq/tern'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createSubmissionController, type SubmissionControllerDeps } from '../../src/app/submission/controller.ts'
import { bindSubmissionRuntime, type SubmissionRuntimeSurface } from '../../src/app/submission/runtime.ts'
import { preparePrompt } from '../../src/app/submission/prepared-prompt.ts'
import { mergeDraft } from '../../src/app/submission/steer.ts'
import { createSessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import { createInputHistory } from '../../src/app/surface/input-history.ts'
import { createSurfaceRuntime, type SurfaceRendererMount, type SurfaceRuntime } from '../../src/app/surface/runtime.ts'
import type { ComposerSubmitRequest } from '../../src/tui-app.ts'
import type { SurfaceEventRoutingSource } from '../../src/app/surface/event-routing.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { draftHasAttachments } from '../../src/client/media/draft-attachments.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { historyFilePath, loadHistoryRecords } from '../../src/client/history/store.ts'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { wireNodes } from '../support/tsp-picker-wire.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()
const SESSION_ID = 'session-recall-chain'
const T0 = 1_700_000_000_000
const UP = '\u001b[A'
const DOWN = '\u001b[B'
const ENTER = '\r'

// ── The scripted Tern pane (the same fixture family as the live-mount lane) ──

class FakeInput extends EventEmitter implements TermInput {
  readonly isTTY = true
  isRaw = false
  setRawMode(mode: boolean): void { this.isRaw = mode }
  type(text: string): void { this.emit('data', ENCODER.encode(text)) }
}

class FakeOutput implements TermOutput {
  readonly isTTY = true
  readonly columns = 100
  readonly chunks: Uint8Array[] = []
  write(bytes: Uint8Array | string): boolean {
    this.chunks.push(typeof bytes === 'string' ? ENCODER.encode(bytes) : bytes)
    return true
  }
  text(): string { return DECODER.decode(concatBytes(this.chunks)) }
}

const HELLO = {
  r: 'hello', v: 1, term: 'tern', ver: '0.6.2',
  kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'editor', 'input', 'text'],
  features: ['flow', 'styles', 'paste'],
  apc: 65536, credits: 2, cols: 120, cell: { w: 8, h: 17 },
  dark: true, reduceMotion: false, hour12: false,
}

interface WireFrame { readonly sf: string; readonly s: number; readonly ops: readonly Op[] }

class ScriptedTern {
  readonly input = new FakeInput()
  readonly output = new FakeOutput()
  readonly frames: WireFrame[] = []
  /** The pane-shaped frame reader the shared wire helpers fold. */
  readonly pane = { frames: (): readonly WireFrame[] => this.frames }

  constructor() {
    this.output.write = ((bytes: Uint8Array | string): boolean => {
      const write = FakeOutput.prototype.write.call(this.output, bytes)
      const text = DECODER.decode(typeof bytes === 'string' ? ENCODER.encode(bytes) : bytes)
      if (text.includes('\u001b[c')) {
        setTimeout(() => this.input.type(`\u001b_tsp;r;${JSON.stringify(HELLO)}\u001b\\\u001b[?62;52;c`), 1)
        return write
      }
      for (const match of text.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
        const frame = JSON.parse(match[1]!) as WireFrame
        this.frames.push(frame)
        setTimeout(() => this.input.type(
          `\u001b_tsp;e;${JSON.stringify({ ev: 'ack', sf: frame.sf, s: frame.s })}\u001b\\`,
        ), 0)
      }
      return write
    }) as typeof this.output.write
  }
}

async function openSession(tern: ScriptedTern): Promise<Session> {
  const session = await sdkConnect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null, 'the shipped SDK accepts the scripted pane')
  return session
}

/** The controlled editor of THIS mount (the user's visible composer). */
function visibleEditor(tern: ScriptedTern): { text: string; cursor: number } {
  const node = wireNodes(tern.pane).find(candidate => candidate.id === 'dock.composer')
  assert.ok(node, 'the controlled editor node is on the wire')
  return { text: String(node.p.text ?? ''), cursor: Number(node.p.cursor ?? 0) }
}

// ── The application composition (the REAL owners, no hand-rolled writer) ────

const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

interface AgentLike {
  status: string
  readonly session: { readonly id: string }
  readonly options: Record<string, unknown>
  cancel(): void
}

interface ChainHarness {
  readonly surface: SurfaceRuntime<SessionEvent>
  readonly tern: ScriptedTern
  readonly session: Session
  readonly renderer: () => TspRenderer
  /** The controller's REAL public entry — the ONE production path an Enter takes. */
  readonly controller: ReturnType<typeof createSubmissionController<AgentLike>>
  /** The REAL input-history owner; its tokenless `persist` is the steer writer. */
  readonly historyOwner: ReturnType<typeof createInputHistory>
  readonly file: string
  readonly writes: Array<{ sessionId: string; message: unknown }>
  readonly submits: Array<{ text: string; request: string; token: number | undefined }>
  readonly images: DraftImageStore
  readonly rawLines: () => readonly string[]
  type(text: string): Promise<void>
  /** Press Enter and wait for the REAL writer sink, not the composer clear.
   *  A policy SKIP still reaches the writer and settles the scope without
   *  adding a JSONL row (`{ written: false }`). */
  enter(text: string, options?: { readonly written?: boolean }): Promise<void>
  /** Arm/disarm the application's in-flight pasted-path delivery gate. */
  setPendingPastedPath(path: string | undefined): void
  /** A REAL decoded key, followed by the shared SDK render wait. */
  key(bytes: string): Promise<void>
  /** The RESOLVED current owner's frame, never a shadow state. */
  editor(): { text: string; cursor: number }
  dispose(): Promise<void>
}

/** The REAL history rows of the cwd (oldest first, as the file records them). */
function rowsOf(home: string) {
  return loadHistoryRecords(historyFilePath(home, home))
}

async function mountChain(
  life: import('../support/temp-lifecycle.ts').TestLifecycle,
  home: string,
): Promise<ChainHarness> {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const file = historyFilePath(home, home)
  assert.equal(dirname(file), join(home, 'user-history'), 'the file is the store\'s own path')

  const tern = new ScriptedTern()
  const session = await openSession(tern)
  let folder = new TranscriptFolder()
  const controllerWindow = new TranscriptWindowController({ windowTurns: 20, stepTurns: 10 })
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
      get window() { return controllerWindow },
      previews: new Map(),
      applyToolPreview: () => {},
      refreshRecentPerformanceAvailability: () => {},
    }),
    viewedChildId: () => undefined,
    viewedChild: () => { throw new Error('no viewer in this composition') },
    mainFolder: () => folder,
    viewedChildFolder: () => { throw new Error('no viewer in this composition') },
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
    applyViewedChildAssistantInput: () => { throw new Error('no viewer in this composition') },
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

  // The REAL controller. The composition's onSubmit entry calls its PUBLIC
  // `submit(text, request, scopeToken)` — no `historyOwner.persist` shortcut,
  // no split A/B fixture. The Host/model sink is the declared stand-in.
  let controller!: ReturnType<typeof createSubmissionController<AgentLike>>
  let historyOwner!: ReturnType<typeof createInputHistory>
  const writes: Array<{ sessionId: string; message: unknown }> = []
  const submitting: Array<{ text: string; request: string; token: number | undefined }> = []
  let mountedRenderer: TspRenderer | undefined
  const rendererMount: SurfaceRendererMount = {
    mount: (binding, statusReader) => {
      mountedRenderer = mountTspRenderer(session, {
        copyVisual: async () => false,
        requestExit: () => {},
      })
      mountedRenderer.bindStatusReader(statusReader)
      mountedRenderer.bindImages(binding)
      return mountedRenderer
    },
    releaseUnmounted: async () => { await mountedRenderer?.dispose() },
  }
  let pendingPastedPath: string | undefined
  surface.start({
    events: {
      onSubmit: (text: string, request: ComposerSubmitRequest, scopeToken?: number) => {
        submitting.push({ text, request: String(request), token: scopeToken })
        controller.submit(text, request, scopeToken)
      },
      onExit: () => {},
      shouldRememberInput: (text: string) => !draftHasAttachments(text, images, files)
        && (pendingPastedPath === undefined || !text.includes(pendingPastedPath)),
    },
    terminalPastedPath: {
      accept: () => {},
      blocksDelivery: (text: string) => pendingPastedPath !== undefined && text.includes(pendingPastedPath),
    },
    renderer: rendererMount,
    workspaceRoot: home,
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
    readImage: () => Promise.reject(new Error('not exercised')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => home,
    captureHistoryScope: () => ({ sessionId: SESSION_ID, isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: async () => false,
    deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: text => text,
  })
  surface.bindRendererInput()

  // The REAL writer owner, bound to THIS surface's display seam exactly as
  // `bootstrap` binds it: every persist is a real JSONL write and a real
  // synchronous `settleScopeInput` report on the same mount.
  historyOwner = createInputHistory({
    surface: { get display() { return surface.display } },
    clientCwd: home,
    sessionCwd: () => home,
    diag: createDiag({ stderrLevel: 'off' }),
    isCleanedUp: () => false,
  })
  const agent: AgentLike = { status: 'idle', session: { id: SESSION_ID }, options: {}, cancel: () => {} }
  const images = new DraftImageStore()
  const files = new DraftFileStore()
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  core.setCurrentOwner({} as never, SESSION_ID)
  let draft = ''
  const runtimeSurface: SubmissionRuntimeSurface = {
    withWriter: async (_scope, task) => task(),
    withPromptAdmission: async (_scope, _line, task) => task(),
    isDisposed: () => false,
    isScopeCurrent: () => true,
    mergeDraftIntoEditor: (text) => {
      const merged = mergeDraft(draft, text)
      draft = merged
      return merged === text
    },
    restoreStaleDraftIntoEditor: (text) => {
      const merged = mergeDraft(draft, text)
      draft = merged
      return merged === text ? 'merged-verbatim' : 'merged'
    },
    consumeDraftAttachments: () => {},
    markDispatch: () => {},
    beginLocalSubmission: () => {},
    settleLocalSubmission: () => {},
    settleSubmitAck: () => {},
    notify: () => {},
    refuseByTransitionFence: (text) => { draft = mergeDraft(draft, text) },
    prepareMessage: async (text, requestId) => preparePrompt(SESSION_ID, text, { images, files }, requestId),
    prompt: async (sessionId, message) => {
      writes.push({ sessionId, message })
      return { kind: 'committed', value: undefined }
    },
  }
  const submissionRuntime = bindSubmissionRuntime({ surface: runtimeSurface })
  const inert = new Proxy(function inert(): void {}, {
    get: (_target, key) => (key === 'then' ? undefined : inert),
    apply: () => undefined,
  })
  const deps: Record<string, unknown> = {
    app: () => surface.composer,
    diag: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} },
    signal: new AbortController().signal,
    isCleanedUp: () => false,
    logError: () => {},
    liveAgent: () => agent,
    ownership: {
      generation: () => core.generation(),
      captureSubject: () => core.subject(),
      transitionPending: () => false,
      awaitTransitionSettled: async () => {},
      beginNavigationIntent: () => () => {},
    },
    scope: {
      captureLive: () => ({ sessionId: SESSION_ID, subject: core.captureSubject()! } as never),
      isCurrent: () => true,
      requireLive: () => ({ sessionId: SESSION_ID, subject: core.captureSubject()! } as never),
    },
    session: {
      ensureSession: async () => {},
      beginCommandSettlement: () => {},
      abortCommandSettlement: () => {},
      settleCommandSettlement: () => {},
      trackSettlementWork: () => {},
    },
    submissionRuntime,
    command: {
      ...new Proxy({}, { get: () => () => false }),
      withCommandDelivery: <T,>(_delivery: unknown, run: () => T): T => run(),
      wasAdvertisedClaim: () => false,
      hostClaimOf: () => undefined,
      hostOriginClaimOf: () => undefined,
      hostCatalogResolves: () => false,
      clientClaimsLine: () => false,
      isSkillWrapperName: () => false,
      isSkillInvocation: () => false,
      takeCommandDraftDisposition: () => undefined,
      clientCommands: { get: () => undefined, execute: async () => undefined },
    },
    commandPlane: {
      available: () => false,
      execute: async () => undefined,
      findHandler: () => undefined,
    },
    backendKind: 'remote',
    backend: inert,
    drafts: { images, files },
    status: { sessionCwd: () => home },
    surface: { refreshPendingInput: () => {} },
    history: {
      persist: (record: Parameters<typeof historyOwner.persist>[0]) => historyOwner.persist(record),
      persistAfterSession: async (resolveSession: () => Promise<string | undefined>, persist: (sessionId: string | undefined) => void) => {
        persist(await resolveSession())
      },
    },
    viewer: { isViewing: () => false },
    extensions: {
      findContribution: () => undefined,
      handlerFor: () => undefined,
      commandIdFor: () => undefined,
      recordHealthRef: () => undefined,
      recordError: () => {},
      clearError: () => {},
    },
    artifacts: { start: () => {} },
    shell: { run: () => {}, interrupt: () => {}, cancelRun: () => false },
    supportsLocalShellCards: false,
    supportsTuiBuiltinUi: true,
    retainsStaleDraftRestore: true,
    model: { selected: { get current() { return undefined } } },
    image: { attachments: () => undefined, llm: () => undefined },
    tuiSettings: undefined,
    captureMatches: () => true,
    ownerWasReplaced: () => false,
    direct: { withPromptAdmission: async (_agent: unknown, _hasImages: boolean, task: () => Promise<unknown>) => task() },
    requestExit: () => {},
    isPlanActive: () => false,
    prepareTransport: async (text: string, requestId: string) => preparePrompt(SESSION_ID, text, { images, files }, requestId),
  }
  controller = createSubmissionController<AgentLike>(deps as unknown as SubmissionControllerDeps<AgentLike>)

  // The mount starts in the REAL sessionless pool (the kernel is open at
  // construction). The formal publication seam is driven by the cases that
  // need an owner — never silently folded into the harness.
  const harness: ChainHarness = {
    surface,
    tern,
    session,
    renderer: () => {
      assert.ok(mountedRenderer, 'the TSP renderer committed its mount')
      return mountedRenderer
    },
    controller,
    historyOwner,
    file,
    writes,
    submits: submitting,
    images,
    setPendingPastedPath: (path) => { pendingPastedPath = path },
    rawLines: () => existsSync(file)
      ? readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '')
      : [],
    async type(text) {
      tern.input.type(text)
      await waitUntil(`the composer holds ${JSON.stringify(text)}`, () => surface.composer.getDraft() === text)
    },
    async enter(text, options: { readonly written?: boolean } = {}) {
      await harness.type(text)
      const expected = writes.length + 1
      const rowsExpected = options.written === false ? rowsOf(home).length : expected
      tern.input.type(ENTER)
      await waitUntil(`the row writer settled ${rowsExpected} prompt(s)`, () => rowsOf(home).length >= rowsExpected, 30_000)
      await waitUntil(`the real writer observed ${expected} prompt(s)`, () => writes.length === expected, 30_000)
    },
    async key(bytes) {
      tern.input.type(bytes)
      // reason: the shared renderer frame wait — the wire is the observation.
      await new Promise(resolve => setTimeout(resolve, 120))
    },
    editor: () => visibleEditor(tern),
    dispose: async () => {
      await surface.dispose()
      await session.close()
    },
  }
  return harness
}

test('a tokenless writer between two real Enters stays visible between them in the same mount recall', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-recall-token-chain-')
  const h = await mountChain(life, home)
  t.after(() => h.dispose())
  // The REAL formal publication seam (the same call the Session owner makes).
  h.surface.display.beginInputHistoryScope(SESSION_ID)
  try {
    assert.deepEqual(rowsOf(home), [], 'the isolated JSONL starts empty')

    // 1. A REAL TSP Enter → the REAL controller → the REAL writer. Its
    // occurrence token is carried by the production submit handoff alone.
    await h.enter('a')
    assert.equal(h.writes.length, 1, 'the real session writer accepted a')
    assert.equal(typeof h.submits[0]!.token, 'number',
      'the production SurfaceRuntime submit entry carried an occurrence token into the controller')
    assert.equal(h.renderer().scopeFactCountForTest(), 1,
      'the writer settled THAT occurrence inside this mount kernel')

    // 2. The tokenless writer path the scope contract documents: the same
    // real InputHistory owner, called with NO token (a steer/extension writer).
    h.historyOwner.persist({ text: 'z', sessionId: SESSION_ID, hasAttachments: false, timestamp: T0 })
    // 3. Another REAL Enter.
    await h.enter('b')

    const rows = rowsOf(home)
    assert.deepEqual(rows.map(row => row.content), ['a', 'z', 'b'],
      'the REAL append order is a,z,b under this Session')
    assert.ok(rows.every(row => row.sessionId === SESSION_ID), 'every row carries the live Session')

    // 4. The owner's formal hydration reseed uses the REAL disk rows (the
    // same reverse/filter the session presentation makes), through the SAME
    // production display seam this mounted composer reads.
    const diskRows = rows.map(row => row.content).reverse()
    h.surface.display.resetInputHistory(diskRows, SESSION_ID)
    assert.ok(h.renderer().reconcileStepsForTest() > 0, 'the kernel really reconciled the settled window')

    // 5. REAL decoded ↑/↓ on the SAME controlled editor. A text-only
    // reconstruction (a,b,z) or a dropped token cannot produce `b → z → a`.
    await h.key(UP)
    assert.deepEqual(h.editor(), { text: 'b', cursor: 0 }, 'the first ↑ shows the newest REAL submission')
    await h.key(UP)
    assert.deepEqual(h.editor(), { text: 'z', cursor: 0 },
      'the second ↑ shows the tokenless writer\'s row at its real disk position')
    await h.key(UP)
    assert.deepEqual(h.editor(), { text: 'a', cursor: 0 },
      'the third ↑ shows the oldest tokened row — no tokenless duplicate moved ahead of it')
    await h.key(DOWN)
    await h.key(DOWN)
    await h.key(DOWN)
    assert.deepEqual(h.editor(), { text: '', cursor: 0 },
      'leaving index 0 restores the empty draft; the browse itself never submitted')
    assert.equal(h.writes.length, 2, 'the arrows wrote no business prompt')
    assert.deepEqual(h.rawLines().map(line => (JSON.parse(line) as { content: string }).content), ['a', 'z', 'b'],
      'the JSONL is the file-level witness of the same append order')
  } finally {
    await h.dispose()
    await h.session.close()
  }
})

test('the same chain keeps a written occurrence, a policy skip and two identical occurrences distinguishable', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-recall-outcomes-')
  const h = await mountChain(life, home)
  t.after(() => h.dispose())
  h.surface.display.beginInputHistoryScope(SESSION_ID)
  try {
    await h.enter('plain prompt')
    assert.equal(h.renderer().scopeFactCountForTest(), 1, 'the written occurrence holds its own fact')
    // The SAME text again: the real per-file consecutive dedupe SKIPS the row
    // but the controller still submits and the scope still keeps a distinct
    // occurrence with its own token.
    await h.enter('plain prompt', { written: false })
    assert.equal(h.writes.length, 2, 'the identical repeat reached the real writer again')
    assert.equal(rowsOf(home).length, 1, 'the writer policy skipped the second row')
    assert.equal(h.renderer().scopeFactCountForTest(), 2, 'the skipped occurrence has its own settled fact')

    // A tokenless writer between two tokened Enters shifts the CWD dedupe
    // anchor, so the later Enter writes its own row again. The production
    // InputHistory owner is that writer; only its scopeToken is absent.
    h.historyOwner.persist({ text: 'between', sessionId: SESSION_ID, hasAttachments: false, timestamp: T0 })
    assert.equal(rowsOf(home).length, 2, 'the tokenless writer appended its own row')
    await h.enter('plain prompt')
    assert.deepEqual(rowsOf(home).map(row => row.content), ['plain prompt', 'between', 'plain prompt'],
      'non-consecutive identical occurrences survive as three real rows')
    assert.equal(h.renderer().scopeFactCountForTest(), 2,
      'the skipped occurrence and its later written twin keep their two settled facts')

    const diskRows = rowsOf(home).map(row => row.content).reverse()
    h.surface.display.resetInputHistory(diskRows, SESSION_ID)
    await h.key(UP)
    assert.deepEqual(h.editor(), { text: 'plain prompt', cursor: 0 })
    await h.key(UP)
    assert.deepEqual(h.editor(), { text: 'between', cursor: 0 })
    await h.key(UP)
    assert.deepEqual(h.editor(), { text: 'plain prompt', cursor: 0 },
      'the two identical occurrences are still two recallable positions')
  } finally {
    await h.dispose()
    await h.session.close()
  }
})

test('a sessionless pool submission is adopted by the first publication, and a replaced owner cannot be recalled back', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-recall-owners-')
  const h = await mountChain(life, home)
  t.after(() => h.dispose())
  try {
    // Boot with the real cwd rows: `resetInputHistory` is a kernel commit, not
    // a draft write, so the composer stays empty until ↑ paints the seed.
    h.surface.display.resetInputHistory(['boot cwd row'])
    assert.deepEqual(h.editor(), { text: '', cursor: 0 }, 'the boot reseed writes no draft')
    await h.key(UP)
    assert.deepEqual(h.editor(), { text: 'boot cwd row', cursor: 0 }, 'a deferred start recalls the cwd')
    await h.key(DOWN)
    assert.equal(h.editor().text, '', 'the empty draft is restored from the cwd browse')

    // A REAL Enter in the sessionless POOL: the real writer resolves the FIRST
    // published Session (deferred-start gate) and the kernel keeps its
    // occurrence for the owner's reseed; a formal `begin` then retires the
    // browse that was open against the cwd pool.
    await h.enter('pool prompt')
    assert.equal(rowsOf(home).at(-1)?.sessionId, SESSION_ID,
      'the pool prompt is persisted under the FIRST published Session — the adoption case')
    await h.key(UP)
    assert.equal(h.editor().text, 'pool prompt',
      'the newest own submission is immediately recallable while the pool is still open')
    h.surface.display.beginInputHistoryScope(SESSION_ID)
    const aRows = rowsOf(home).filter(row => row.sessionId === SESSION_ID)
    h.surface.display.resetInputHistory(aRows.map(row => row.content).reverse(), SESSION_ID)
    await h.key(DOWN)
    assert.equal(h.editor().text, 'pool prompt',
      'the publication retired the browse: ↓ only moves the caret on the recalled row, it cannot restore a cwd draft')
    assert.deepEqual(h.editor(), { text: 'pool prompt', cursor: 11 })

    // B replaces A: A's browse is retired at the SAME formal seam.
    h.surface.display.beginInputHistoryScope('session-b')
    h.surface.display.resetInputHistory(['b row'], 'session-b')
    await h.key(DOWN)
    assert.equal(h.editor().text, 'pool prompt', 'A\'s bookmark cannot be walked back into B')
    assert.deepEqual(h.editor(), { text: 'pool prompt', cursor: 11 },
      '↓ only moved the caret on the retired browse row')
    await h.key(UP)
    await h.key(UP)
    assert.deepEqual(h.editor(), { text: 'b row', cursor: 0 }, 'B recalls its own rows')
  } finally {
    await h.dispose()
    await h.session.close()
  }
})

test('a draft that references a staged attachment refuses the recall and keeps the draft, caret and staged bytes', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-recall-admission-')
  const h = await mountChain(life, home)
  t.after(() => h.dispose())
  h.surface.display.beginInputHistoryScope(SESSION_ID)
  try {
    const bytes = new Uint8Array(33)
    const staged = h.images.add({ bytes, mediaType: 'image/png', width: 8, height: 8, source: { type: 'clipboard' } })
    h.surface.composer.setDraft(`${staged.placeholder} caption`)
    await waitUntil('the staged draft is live', () => h.editor().text === `${staged.placeholder} caption`)
    h.surface.display.resetInputHistory(['a plain row'])
    await h.key(UP)
    await h.key(UP)
    assert.deepEqual(h.editor(), { text: `${staged.placeholder} caption`, cursor: 0 },
      'the attachment predicate refused the recall: the multimodal draft is intact and only the '
      + 'boundary-causing Home step moved the caret')
    assert.equal(h.images.get(staged.id)?.byteLength, 33,
      'the staged image is still resolvable — no path from a refused browse can drop it')

    h.images.remove(staged.id)
    await h.key(UP)
    await h.key(UP)
    assert.deepEqual(h.editor(), { text: 'a plain row', cursor: 0 },
      'once the placeholder no longer resolves, the same draft recalls normally')
  } finally {
    await h.dispose()
    await h.session.close()
  }
})

test('an in-flight pasted path blocks the browse without writing a row or losing the draft text', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-recall-pending-path-')
  const h = await mountChain(life, home)
  t.after(() => h.dispose())
  h.surface.display.beginInputHistoryScope(SESSION_ID)
  try {
    h.surface.display.resetInputHistory(['a plain row'])
    const path = '/tmp/pi-tui-tsp-recall/pending-shot.png'
    h.setPendingPastedPath(path)
    await h.type(`${path} `)
    await h.key(UP)
    await h.key(UP)
    assert.deepEqual(h.editor(), { text: `${path} `, cursor: 0 },
      'the delivery gate refused the recall while the image read is in flight; the draft text is intact')
    assert.deepEqual(rowsOf(home), [], 'no recall, no draft mutation and no history row')

    h.setPendingPastedPath(undefined)
    await h.key(UP)
    await h.key(UP)
    assert.deepEqual(h.editor(), { text: 'a plain row', cursor: 0 },
      'the same key recalls once the read settled and the gate opened')
  } finally {
    await h.dispose()
    await h.session.close()
  }
})
