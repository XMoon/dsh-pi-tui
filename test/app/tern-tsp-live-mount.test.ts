/**
 * PR3-A live-mount contract tests (Tern Surface Protocol).
 *
 * The chain under test is the PRODUCTION read-only TSP mount:
 *
 *     realistic SessionEvent routing (the PR2 harness shape)
 *       -> ONE real TranscriptFolder + window controller
 *       -> the REAL SurfaceRuntime with the TSP renderer mount
 *       -> the REAL SDK session/surface on a scripted pane tty
 *
 * A-04: cold Direct hydration renders the first frame; a durable tool settle
 *       + a live token delta update the SAME node (no delete/move rebuild).
 * A-05: an owner A→B transition shows the explicit Loading state, then B's
 *       own fold commits; a B-scope frame never carries A's rows.
 * A-06: a same-id fold replacement re-scopes presentation keys; the same
 *       token never survives the replacement.
 * A-07: dispose closes the SDK surface (x keep:false) and the session ONCE,
 *       restoring raw mode; a late repaint after dispose writes nothing.
 * A-08: an approval/question arriving at the read-only renderer resolves
 *       through the LEGAL fail-closed paths (unavailable / next) with an
 *       observable dock notice — no auto-approve, no hanging promise.
 *
 * STANDS-IN: the pane is a scripted tty (not a real Tern); the app graph is
 * the real SurfaceRuntime + a minimal routing source (PR2's harness family).
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-live-mount.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { connect as sdkConnect, concatBytes, ui } from '@stencil-hq/tern'
import type { Op, Session, TermInput, TermOutput, WireNode } from '@stencil-hq/tern'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ModelPickerRequest } from '../../src/app/command/model-presentation.ts'
import { applyAssistantLiveInput } from '../../src/app/surface/session-presentation.ts'
import { StatsFolder } from '../../src/domain/status/stats.ts'
import { toolSummaryKeys } from '../../src/tui/transcript/tool-presentation.ts'
import type { AssistantLiveInput } from '../../src/runtime/assistant-stream-port.ts'
import type { ComposerSubmitRequest } from '../../src/tui-app.ts'
import type { SurfaceEventRoutingSource } from '../../src/app/surface/event-routing.ts'
import {
  createSurfaceRuntime,
  type SurfaceRuntime,
  type SurfaceRendererMount,
} from '../../src/app/surface/runtime.ts'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import { resolveTspNativeFooterConfig } from '../../src/domain/footer/tsp-native-config.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { isQuitKey, mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { foldWireNodes, wireNodes } from '../support/tsp-picker-wire.ts'
import { readTspBlobMessages, type ObservedTspBlob } from '../support/tsp-blob-wire.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'
import { svgContentBlocks, svgFactFromArgs } from '../../src/domain/visual/svg.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { createInputHistory } from '../../src/app/surface/input-history.ts'
import type { SurfaceDisplaySeam } from '../../src/app/surface/display-seam.ts'
import type { HistoryScopeSettlement } from '../../src/client/history/recall-scope.ts'
import { historyFilePath, loadHistoryRecords } from '../../src/client/history/store.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()
const SESSION_ID = 'session-pr3a-mount'
const T0 = 1_700_000_000_000

// ── The scripted Tern pane (PR2's fixture family) ───────────────────────────

class FakeInput extends EventEmitter implements TermInput {
  readonly isTTY = true
  isRaw = false
  readonly raw: boolean[] = []
  readonly received: string[] = []
  setRawMode(mode: boolean): void {
    this.isRaw = mode
    this.raw.push(mode)
  }
  type(text: string): void {
    this.emit('data', ENCODER.encode(text))
  }
}

class FakeOutput implements TermOutput {
  readonly isTTY = true
  readonly columns = 100
  readonly chunks: Uint8Array[] = []
  onWrite: ((bytes: Uint8Array) => void) | undefined
  write(data: Uint8Array | string): boolean {
    const bytes = typeof data === 'string' ? ENCODER.encode(data) : data
    this.chunks.push(bytes)
    this.onWrite?.(bytes)
    return true
  }
  text(): string {
    return DECODER.decode(concatBytes(this.chunks))
  }
}

const HELLO = {
  r: 'hello',
  v: 1,
  term: 'tern',
  ver: '0.6.2',
  kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'message', 'button'],
  features: ['flow', 'styles'],
  apc: 65536,
  credits: 2,
  cols: 120,
  cell: { w: 8, h: 17 },
  dark: true,
  reduceMotion: false,
  hour12: false,
}

interface WireFrame {
  readonly sf: string
  readonly s: number
  readonly ops: readonly Op[]
}

function decodeFrames(text: string): WireFrame[] {
  const frames: WireFrame[] = []
  for (const match of text.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
    frames.push(JSON.parse(match[1]!) as WireFrame)
  }
  return frames
}

class ScriptedTern {
  readonly input = new FakeInput()
  readonly output = new FakeOutput()
  readonly frames: WireFrame[] = []
  readonly blobs: ObservedTspBlob[] = []
  readonly closeBodies: unknown[] = []
  /** The pane-shaped frame reader the shared wire helpers fold. */
  readonly pane = { frames: (): readonly WireFrame[] => this.frames }

  constructor(hello: typeof HELLO = HELLO) {
    this.output.onWrite = bytes => {
      const text = DECODER.decode(bytes)
      if (text.includes('\u001b[c')) {
        setTimeout(() => this.input.type(`\u001b_tsp;r;${JSON.stringify(hello)}\u001b\\\u001b[?62;52;c`), 1)
        return
      }
      for (const blob of readTspBlobMessages(bytes)) this.blobs.push(blob)
      for (const match of text.matchAll(/\u001b_tsp;x;([\s\S]*?)\u001b\\/g)) {
        try { this.closeBodies.push(JSON.parse(match[1]!)) } catch { /* ignore */ }
      }
      for (const frame of decodeFrames(text)) {
        this.frames.push(frame)
        setTimeout(() => this.input.type(
          `\u001b_tsp;e;${JSON.stringify({ ev: 'ack', sf: frame.sf, s: frame.s })}\u001b\\`,
        ), 0)
      }
    }
  }
}

async function openSession(tern: ScriptedTern): Promise<Session> {
  const session = await sdkConnect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')
  return session
}

// ── Events ──────────────────────────────────────────────────────────────────

function ev(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: T0 + seq, data } as SessionEvent
}

function userMessage(seq: number, text: string, id = `user-${seq}`): SessionEvent {
  return ev('user/message', {
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }, seq)
}

function toolCall(seq: number, callId: string): SessionEvent {
  return ev('tool/call', { turn: 1, step: 0, callId: ToolCallId(callId), name: 'read', arguments: '{}' }, seq)
}

function toolResult(seq: number, callId: string, text: string): SessionEvent {
  return ev('tool/result', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId(`result-${callId}`),
      role: 'tool',
      toolCallId: ToolCallId(callId),
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, seq)
}

function assistantMessage(seq: number, id: string, text: string): SessionEvent {
  return ev('assistant/message', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId(id),
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
      stream: [],
    },
  }, seq)
}

function liveChunk(text: string): AssistantLiveInput {
  return {
    kind: 'chunk',
    sessionId: SESSION_ID,
    attemptId: 'attempt-pr3a',
    turn: 1,
    step: 0,
    time: T0 + 100,
    chunk: { type: 'text-delta', index: 0, text },
  } as AssistantLiveInput
}

// ── The harness: the real SurfaceRuntime + the TSP renderer mount ───────────

const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

interface Harness {
  readonly surface: SurfaceRuntime<SessionEvent>
  /** The REAL `surface.start` inputs, so a second start can be driven as-is. */
  readonly startDeps: Parameters<SurfaceRuntime<SessionEvent>['start']>[0]
  readonly tern: ScriptedTern
  readonly imageReads: { readonly attachmentId: string; readonly scope: unknown }[]
  setImageScope(scope: unknown): void
  route(event: SessionEvent): void
  selectHistoryTurn(turn: number): boolean
  selectLatestWindow(): boolean
  windowSnapshot(): ReturnType<TranscriptWindowController['snapshot']>
  /** Replace the main fold under the same session id (re-hydration shape). */
  replaceMain(): void
  exitRequested(): boolean
  /** PR-C (TSP-7): the handlers the input bind delivered (undefined pre-bind). */
  boundHandlers(): Parameters<TspRenderer['bindInput']>[0] | undefined
  /** The mounted TSP renderer itself; throws before the mount commits. */
  renderer(): TspRenderer
  dispose(): Promise<void>
}

async function mountTspHarness(options: {
  requestExit?: () => void
  onFatal?: (error: unknown) => void
  sessionBrowserCapabilities?: boolean
  /** PR-E (TSP-7): advertise `el` so the Quiet Composer shell mounts. */
  composerActions?: boolean
  /** PR-C (TSP-7): the composition's late-bound `/model` UI entry, injected
   *  exactly as `src/app/bootstrap.ts` injects it into `createSurfaceRuntime`. */
  openModelPicker?: (entry: 'models' | 'effort') => void
  /** PR-E (TSP-7): the composition's late-bound Permission UI seam. */
  permissionUi?: { options(): readonly string[]; select(id: string): void }
  /** Mouse PR4: the composition's late-bound `/tasks` UI entry, injected
   *  exactly as `src/app/bootstrap.ts` injects it into `createSurfaceRuntime`. */
  openTasksBrowserUi?: () => void
  /** Mouse PR4: the real `/tasks` business-entry availability read. */
  tasksBrowserUiAvailable?: () => boolean
  /** Observe the same injected Client-local copy capability used by the renderer. */
  copyVisual?: (text: string) => Promise<boolean>
  /** TSP I-A: the ONE application submit entry the real `pendingInputBinding`
   *  forwards to (default: inert, exactly what every existing case assumes). */
  onSubmit?: (text: string, request: ComposerSubmitRequest, scopeToken?: number) => void
  /** TSP I-A: the composition's History-eligibility policy. Absent means the
   *  events table declares NO predicate at all (the PiTui `?.() === false`
   *  shape then accepts). */
  shouldRememberInput?: (text: string) => boolean
  /** The ONE live display authority. When present, the SAME object goes to
   *  both `surface.start` and the production `mountTspRenderer`, exactly as the
   *  composition root wires it. Absent keeps the historical standalone mount
   *  (no renderer displayState) that every older case asserts. */
  displayState?: { preset: 'focus' | 'compact' | 'full' }
  /** Observe the production mount's authorized image-read port. */
  readImage?: (ref: ImageAttachmentRefLike, scope: unknown) => Promise<{ ref: unknown; data: Uint8Array }>
  imageScope?: unknown
  /** Advertise the native `image` kind + `blobs` feature so a ready Tool SVG
   *  really carries its own collapsible disclosure. */
  nativeImages?: boolean
} = {}): Promise<Harness & { session: Session }> {
  const kinds = new Set(HELLO.kinds)
  const features = new Set(HELLO.features)
  if (options.nativeImages === true) {
    kinds.add('image')
    kinds.add('text')
    features.add('blobs')
  }
  if (options.sessionBrowserCapabilities === true) {
    for (const kind of ['picker', 'row', 'overlay', 'text', 'md']) kinds.add(kind)
    features.add('scroll')
  }
  if (options.composerActions === true) kinds.add('el')
  const hello = { ...HELLO, kinds: [...kinds], features: [...features] }
  const tern = new ScriptedTern(hello)
  const session = await openSession(tern)
  const imageReads: { readonly attachmentId: string; readonly scope: unknown }[] = []
  let activeImageScope: unknown = options.imageScope ?? { scope: 'test-image-scope' }
  let folder = new TranscriptFolder()
  let statsFolder = new StatsFolder()
  let mainPreviews = new Map<string, import('../../src/app/surface/streaming-tool-preparing.ts').StreamingToolPreview>()
  const controller = new TranscriptWindowController({ windowTurns: 20, stepTurns: 10 })
  let exitCount = 0

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
      stats: { apply: (events: readonly SessionEvent[]) => statsFolder.apply(events) },
      get window() { return controller },
      previews: mainPreviews,
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
    applyMainAssistantInput: input => applyAssistantLiveInput(folder, statsFolder, mainPreviews, input, toolSummaryKeys),
  }

  const surface = createSurfaceRuntime<SessionEvent>({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation,
    notificationMode: undefined,
    notificationMethod: undefined,
    mainProgressAuthority: 'local-events',
    terminalProgress: undefined,
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
    // PR-C (TSP-7): the composition's late-bound `/model` UI entry, when the
    // case supplies one (the production bootstrap always does).
    ...(options.openModelPicker === undefined ? {} : { openModelPicker: options.openModelPicker }),
    // PR-E (TSP-7): the narrow Permission UI seam, forwarded by the runtime
    // into the renderer input binding exactly like the production bootstrap.
    ...(options.permissionUi === undefined ? {} : { permissionUi: options.permissionUi }),
    // Mouse PR4: the late-bound `/tasks` UI entry and its availability fact,
    // forwarded verbatim like the model/session entries above.
    ...(options.openTasksBrowserUi === undefined ? {} : { openTasksBrowserUi: options.openTasksBrowserUi }),
    ...(options.tasksBrowserUiAvailable === undefined ? {} : { tasksBrowserUiAvailable: options.tasksBrowserUiAvailable }),
  })
  surface.attachEventRouting(source)

  let mountedRenderer: TspRenderer | undefined
  // PR-C (TSP-7): the handlers `bindRendererInput` delivered, so a case can
  // drive the renderer's own input contract (the button click path's handler).
  let boundHandlers: Parameters<TspRenderer['bindInput']>[0] | undefined
  const copyVisual = options.copyVisual ?? (async () => false)
  const renderer: SurfaceRendererMount = {
    mount: (binding, statusReader) => {
      mountedRenderer = mountTspRenderer(session, { copyVisual,
        requestExit: () => {
          exitCount += 1
          options.requestExit?.()
        },
        ...(options.onFatal === undefined ? {} : { onFatal: options.onFatal }),
        ...(options.displayState === undefined ? {} : { displayState: options.displayState }),
      })
      // TSP-7 PR-A: the status reader is bound BEFORE the image binding, like
      // the production mount — a renderer that fails its image bind still
      // releases through the existing path.
      mountedRenderer.bindStatusReader(statusReader)
      // PR-C: the mount hands the renderer the ONE image binding of this
      // surface — the fake mount installs it, it never fakes success.
      mountedRenderer.bindImages(binding)
      const innerBind = mountedRenderer.bindInput.bind(mountedRenderer)
      mountedRenderer = new Proxy(mountedRenderer, {
        get(target, prop, receiver) {
          if (prop === 'bindInput') {
            return (handlers: Parameters<TspRenderer['bindInput']>[0]) => {
              boundHandlers = handlers
              innerBind(handlers)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
      return mountedRenderer
    },
    releaseUnmounted: async () => { await mountedRenderer?.dispose() },
  }
  const startDeps: Parameters<SurfaceRuntime<SessionEvent>['start']>[0] = {
    events: {
      // TSP I-A: the ONE application submit entry the real binding forwards to,
      // plus the optional History-eligibility policy the composition owns.
      onSubmit: (text, request, scopeToken) => { options.onSubmit?.(text, request, scopeToken) },
      onExit: () => {},
      ...(options.shouldRememberInput === undefined
        ? {}
        : { shouldRememberInput: options.shouldRememberInput }),
    },
    renderer,
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: options.displayState ?? { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
    readImage: async (ref, scope) => {
      imageReads.push({ attachmentId: ref.attachmentId, scope })
      if (options.readImage === undefined) throw new Error('image read was not configured for this harness')
      return await options.readImage(ref, scope)
    },
    imageScope: () => activeImageScope,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    captureHistoryScope: () => ({ sessionId: SESSION_ID, isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: copyVisual,
    deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: text => text,
  }
  surface.start(startDeps)

  return {
    surface,
    startDeps,
    tern,
    session,
    imageReads,
    setImageScope(scope) { activeImageScope = scope },
    route(event) {
      surface.routeSessionEvent({ id: SESSION_ID }, event)
    },
    selectHistoryTurn(turn) {
      return controller.anchorAt(turn)
    },
    selectLatestWindow() {
      return controller.latest()
    },
    windowSnapshot() {
      return controller.snapshot()
    },
    replaceMain() {
      folder = new TranscriptFolder()
      statsFolder = new StatsFolder()
      mainPreviews = new Map()
      controller.setTurns(folder.groupedTurns())
    },
    exitRequested: () => exitCount > 0,
    /** PR-C (TSP-7): the handlers the input bind delivered (test-only read). */
    boundHandlers: () => boundHandlers,
    renderer: () => {
      const mounted = mountedRenderer
      if (mounted === undefined) throw new Error('no renderer is mounted in this harness')
      return mounted
    },
    async dispose() {
      // The ONE renderer-release promise owns the disposal outcome: a failed
      // release must surface to THIS caller (never as an unowned rejection), and
      // it is awaited before the harness considers the surface torn down.
      try {
        surface.dispose()
        await surface.whenRendererReleased()
      } finally {
        await settle()
      }
    },
  }
}


/** Feed one official TSP event frame into the scripted pane's input. */
function harnessFreeInput(tern: ScriptedTern, event: Record<string, unknown>): void {
  tern.input.type(`\u001b_tsp;e;${JSON.stringify(event)}\u001b\\`)
}

async function settle(): Promise<void> {
  for (let index = 0; index < 40; index += 1) await new Promise(resolve => setTimeout(resolve, 3))
}

// ── A-04: cold hydration + live delta on the same node ──────────────────────

test('cold hydration renders the first frame; tool settle and live delta update in place', async () => {
  const harness = await mountTspHarness()
  try {
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'hydrate the renderer'))
    harness.route(toolCall(2, 'call-read-1'))
    harness.surface.paintNow()
    await settle()
    const firstFrame = harness.tern.frames.at(-1)
    assert.ok(firstFrame !== undefined, 'the cold frame reached the wire')
    assert.ok(harness.tern.output.text().includes('hydrate the renderer'), 'the user row rendered')

    // The durable settle updates the SAME tool node (no del/move).
    harness.route(toolResult(3, 'call-read-1', 'the file body'))
    harness.surface.paintNow()
    await settle()
    const settleFrame = harness.tern.frames.at(-1)!
    assert.equal(settleFrame.ops.filter(op => op[0] === 'del').length, 0, 'the settle deletes nothing')
    assert.equal(settleFrame.ops.filter(op => op[0] === 'move').length, 0, 'the settle moves nothing')

    // A live token delta appends to the retained streaming card.
    harness.surface.applyAssistantInput(liveChunk('streaming '))
    harness.surface.paintNow()
    await settle()
    harness.surface.applyAssistantInput(liveChunk('tail'))
    harness.surface.paintNow()
    await settle()
    const streamFrame = harness.tern.frames.at(-1)!
    assert.ok(streamFrame.ops.some(op => op[0] === 'text'), 'the delta rides an SDK text op')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── A-05: the REAL owner gap — Loading survives the old fold's repaint ──────

test('after the generation bump the Loading fence drops the OLD fold repaint (production gap)', async () => {
  const harness = await mountTspHarness()
  try {
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'owner-a-content'))
    harness.surface.paintNow()
    await settle()
    assert.ok(harness.tern.output.text().includes('owner-a-content'), 'A commits first')

    // The PRODUCTION generation bump: `resetForGeneration()` raises the
    // hydration window BEFORE the new fold exists (the old folder is still
    // mounted and its controller re-bound — exactly what the surface does).
    harness.surface.display.beginSessionHydration()
    await settle()
    assert.ok(harness.tern.output.text().includes('Loading session…'), 'the bump shows the explicit Loading state')

    // The REAL production gap: between the bump and the new fold's first
    // commit, a repaint still reads the OLD fold. It must be FENCED — the
    // old rows may never reappear (nor be relabelled as the new subject).
    const framesBeforeFencedRepaint = harness.tern.frames.length
    harness.surface.paintNow()
    await settle()
    assert.ok(harness.tern.output.text().includes('Loading session…'), 'Loading survives the retired fold repaint')
    assert.equal(harness.tern.frames.length, framesBeforeFencedRepaint,
      'the fenced old-fold repaint is DROPPED (no frame at all)')
    assert.ok(!harness.tern.output.text().slice(harness.tern.output.text().indexOf('Loading session…')).includes('owner-a-content'),
      'A rows never reappear after the fence')

    // The new owner's own fold commits under a NEW source token.
    harness.replaceMain()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'owner-b-content'))
    harness.surface.paintNow()
    await settle()
    assert.ok(harness.tern.output.text().includes('owner-b-content'), 'B renders after its own commit')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── A-06: a replacement scope gets a FRESH SDK namespace ─────────────────────

test('a same-id fold replacement re-scopes into a fresh node namespace', async () => {
  const harness = await mountTspHarness()
  try {
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'identical-rows'))
    harness.surface.paintNow()
    await settle()
    const prefixOf = (wire: string): Set<string> =>
      new Set([...wire.matchAll(/main\.(s\d+)-/g)].map(m => m[1]!))
    const firstScopes = prefixOf(harness.tern.output.text())
    assert.equal(firstScopes.size, 1, 'the first scope used exactly one namespace')

    // Same-id cold rehydrate carrying the SAME rows: a different fold object
    // (a NEW source token), so the presentation keys must re-scope. The SDK
    // may not silently reuse the old ids and keep terminal-local state.
    harness.replaceMain()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'identical-rows'))
    harness.surface.paintNow()
    await settle()
    const allScopes = prefixOf(harness.tern.output.text())
    assert.ok(allScopes.size >= 2,
      `the replacement opened a NEW namespace (saw ${[...allScopes].join(', ')})`)
    const [firstScope] = [...firstScopes]
    assert.ok([...allScopes].some(scope => scope !== firstScope),
      'the replacement namespace differs from the original scope')

    // An ORDINARY delta keeps the current scope (no gratuitous rebuild).
    const framesBefore = harness.tern.frames.length
    harness.route(userMessage(2, 'another-row'))
    harness.surface.paintNow()
    await settle()
    const deltaFrame = harness.tern.frames.at(-1)!
    assert.ok(harness.tern.frames.length > framesBefore, 'the delta committed')
    assert.ok(deltaFrame.ops.some(op => op[0] === 'add'),
      'the ordinary delta added a row inside the retained scope')
    assert.deepEqual(prefixOf(JSON.stringify(deltaFrame.ops)), new Set([[...allScopes].at(-1)!]),
      'the delta stays in the CURRENT scope (no new namespace)')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── A-07: dispose closes the surface and session once, restores raw mode ────

test('dispose closes the SDK surface (x keep:false) and the session exactly once', async () => {
  const harness = await mountTspHarness()
  const session = harness.session
  try {
    harness.route(userMessage(1, 'before-dispose'))
    harness.surface.paintNow()
    await settle()

    await harness.dispose()
    await session.close()

    const wire = harness.tern.output.text()
    const closes = harness.tern.closeBodies.filter(body => (body as { id?: string }).id === 's1')
    assert.equal(closes.length, 1, 'exactly one x close for the surface')
    assert.deepEqual((closes[0] as { keep?: boolean }).keep, false, 'the normal close keeps nothing')
    assert.deepEqual(harness.tern.input.raw, [true, false], 'raw mode restored exactly once')

    // A late repaint after dispose writes nothing further.
    const framesBefore = harness.tern.frames.length
    harness.surface.routeSessionEvent({ id: SESSION_ID }, userMessage(9, 'late-after-dispose'))
    harness.surface.paintNow()
    await settle()
    assert.equal(harness.tern.frames.length, framesBefore, 'a late projection never frames a closed surface')
  } finally {
    await harness.dispose().catch(() => {})
    await session.close().catch(() => {})
  }
})

test('SurfaceRuntime retires all native presenter getters on dispose', async () => {
  const harness = await mountTspHarness({ sessionBrowserCapabilities: true })
  const session = harness.session
  try {
    assert.ok(harness.surface.modelPresentation, 'the TSP renderer exposes its Model presenter')
    assert.ok(harness.surface.presetPresentation, 'the TSP renderer exposes its Preset presenter')
    assert.ok(harness.surface.sessionBrowserPresentation, 'the TSP renderer exposes its Session Browser presenter')

    await harness.dispose()

    assert.equal(harness.surface.modelPresentation, undefined)
    assert.equal(harness.surface.presetPresentation, undefined)
    assert.equal(harness.surface.sessionBrowserPresentation, undefined)
  } finally {
    await harness.dispose().catch(() => {})
    await session.close().catch(() => {})
  }
})

test('the PiTUI Host Editor workspace control is inert on a TSP mount', async () => {
  const harness = await mountTspHarness({ sessionBrowserCapabilities: true })
  const session = harness.session
  try {
    // The TSP renderer branch has NO TuiApp: the runtime bridge's `app?.` call
    // is a strict no-op, so the `←←` gesture (a TuiApp-local state machine)
    // cannot exist on this mount at all.
    assert.throws(() => harness.surface.app, /the surface is not mounted/u)
    const nativeBrowser = harness.surface.sessionBrowserPresentation
    assert.ok(nativeBrowser !== undefined, 'the TSP renderer keeps its native Session Browser presenter')
    let touched = 0
    assert.doesNotThrow(() => harness.surface.setEditorWorkspaceEntry({
      available: () => { touched += 1; return true },
      captureIsCurrent: () => { touched += 1; return () => true },
      openAll: () => { touched += 1 },
    }))
    assert.equal(touched, 0, 'an inert bridge never evaluates the control')
    assert.throws(() => harness.surface.app, /the surface is not mounted/u,
      'the install attempt must never create a TuiApp')
    assert.equal(harness.surface.sessionBrowserPresentation, nativeBrowser,
      'the native Session Browser presenter is unchanged')
  } finally {
    await harness.dispose().catch(() => {})
    await session.close().catch(() => {})
  }
})

// ── B3-A3: the Task Center capability is the NEGOTIATED pane truth ──────────

test('the default HELLO (no picker/row/text/scroll) declares no Task Center', async () => {
  const harness = await mountTspHarness()
  const session = harness.session
  try {
    assert.equal(harness.surface.display.supportsTaskCenter, false,
      'the default pane cannot present the Hub or read its Reader, so /tasks stays refused')
    assert.equal(harness.surface.display.supportsViewer, false, 'and no Viewer is advertised')
  } finally {
    await harness.dispose().catch(() => {})
    await session.close().catch(() => {})
  }
})

test('a fully negotiated HELLO declares the Task Center and STILL no Viewer', async () => {
  // The Session Browser opt-in advertises exactly the negotiated vocabulary the
  // Hub + Reader need (`picker`, `row`, `text`, `overlay` and `scroll`; `col` is
  // base), so the display seam's ONE capability truth flips — and nothing else
  // on the seam does.
  const harness = await mountTspHarness({ sessionBrowserCapabilities: true })
  const session = harness.session
  try {
    assert.equal(harness.surface.display.supportsTaskCenter, true,
      'the negotiated pane truthfully declares the production Task Center')
    assert.equal(harness.surface.display.supportsViewer, false,
      'the Task Center capability never implies the business Viewer')
    assert.equal(harness.surface.display.supportsModals, false,
      'and never implies modals: the interaction seat keeps its own admission')
  } finally {
    await harness.dispose().catch(() => {})
    await session.close().catch(() => {})
  }
})

// ── The exit intent: B1 semantics (q is text; Ctrl+D exits only empty) ──────

test('exit routes Ctrl+C and empty-draft Ctrl+D; a typed q is editor text', async () => {
  assert.equal(isQuitKey({ name: 'q' }), false, 'the PR3-A bare q quit retired with the composer')
  assert.equal(isQuitKey({ name: 'c', ctrl: true }), true)
  assert.equal(isQuitKey({ name: 'd', ctrl: true }), false,
    'Ctrl+D is not an unconditional quit — the composer reducer decides on the empty draft')
  assert.equal(isQuitKey({ name: 'c', ctrl: false }), false, 'bare c is not quit')
  assert.equal(isQuitKey({ name: 'enter' }), false)
  assert.equal(isQuitKey({ name: 'escape' }), false)

  const harness = await mountTspHarness()
  try {
    harness.tern.input.type('x')
    await settle()
    assert.equal(harness.exitRequested(), false, 'an ordinary key never requests exit')
    harness.tern.input.type('q')
    await settle()
    assert.equal(harness.exitRequested(), false, 'a typed q is editor text now, not the quit intent')
    // Ctrl+D with a NON-empty draft is an editor no-op, never a quit.
    harness.tern.input.type('\x04')
    await settle()
    assert.equal(harness.exitRequested(), false, 'Ctrl+D with text in the composer does not exit')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── untrusted terminal output: the TSP dock never forwards raw controls ─────

// ── PR-C (TSP-7): the late-bound `/model` UI entry reaches the bound renderer ─
//
// The composition's seam is narrow by construction: bootstrap assigns a
// callback AFTER registration, `createSurfaceRuntime` forwards it verbatim
// into the renderer input binding, and the renderer's handlers are the ONLY
// consumers. These cases pin that wiring (the full business chain — command
// owner → catalog → picker → writer — is qualified end-to-end by the
// composer-actions suite and the model-picker suites).

test('the late-bound /model entry reaches the bound renderer input exactly once', async () => {
  const calls: Array<'models' | 'effort'> = []
  const harness = await mountTspHarness({
    openModelPicker: entry => { calls.push(entry) },
  })
  try {
    harness.surface.bindRendererInput()
    const bound = harness.boundHandlers()
    assert.ok(bound, 'the renderer input is bound')
    bound.openModelPicker('models')
    bound.openModelPicker('effort')
    await settle() // window: let the seam callbacks run before reading the recorded calls
    assert.deepEqual(calls, ['models', 'effort'],
      'both entry hints traverse the surface seam verbatim, exactly once each')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('an unwired composition refuses the /model UI entry loudly, never silently', async () => {
  const harness = await mountTspHarness()
  try {
    harness.surface.bindRendererInput()
    const bound = harness.boundHandlers()
    assert.ok(bound)
    // The runtime's placeholder throws: a dead composer control must be
    // VISIBLE (the renderer reports it), not a silent no-op.
    assert.throws(() => bound!.openModelPicker('models'),
      /model picker command entry is not wired/)
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('the late-bound Permission UI seam reaches the bound renderer input exactly once', async () => {
  const calls: string[] = []
  const harness = await mountTspHarness({
    permissionUi: {
      options: () => ['read-only', 'workspace-write'],
      select: id => { calls.push(id) },
    },
  })
  try {
    harness.surface.bindRendererInput()
    const bound = harness.boundHandlers()
    assert.ok(bound)
    assert.deepEqual(bound.permissionOptions?.(), ['read-only', 'workspace-write'])
    bound.selectPermission?.('workspace-write')
    await settle() // window: let the seam callback run before reading the record
    assert.deepEqual(calls, ['workspace-write'], 'the renderer reaches the ONE late-bound StatusRuntime seam')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('an unwired Permission UI seam reads empty and refuses the select loudly', async () => {
  const harness = await mountTspHarness()
  try {
    harness.surface.bindRendererInput()
    const bound = harness.boundHandlers()
    assert.ok(bound)
    assert.deepEqual(bound.permissionOptions?.(), [], 'no owner composes an empty catalog, never a fabricated one')
    assert.throws(() => bound.selectPermission?.('workspace-write'), /permission UI owner is not composed/)
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('production assembly: surface.commitStatus + the Permission seam reach the Quiet Composer menu and one select', async () => {
  const selects: string[] = []
  const harness = await mountTspHarness({
    composerActions: true,
    permissionUi: {
      options: () => ['read-only', 'workspace-write', 'danger-full-access'],
      select: id => { selects.push(id) },
    },
  })
  try {
    harness.surface.bindRendererInput()
    harness.surface.commitStatus(
      { access: { permissionPreset: { id: 'workspace-write', label: 'Workspace Write', matched: true } } } as never,
      {},
      undefined,
    )
    await waitUntil('the quiet composer permission trigger paints', () =>
      wireNodes({ frames: () => harness.tern.frames }).some(node => node.k === 'el'
        && String(node.id).includes('.composer-permission-s')
        && !String(node.id).includes('option')))
    const trigger = wireNodes({ frames: () => harness.tern.frames }).find(node => node.k === 'el'
      && String(node.id).includes('.composer-permission-s')
      && !String(node.id).includes('option'))
    assert.ok(trigger)
    harnessFreeInput(harness.tern, { ev: 'action', sf: harness.tern.frames.at(-1)!.sf, id: trigger!.id, act: 'click' })
    await waitUntil('the three standard permission options paint', () =>
      wireNodes({ frames: () => harness.tern.frames }).filter(node => node.k === 'el'
        && String(node.id).includes('.composer-permission-option-')).length === 3)
    const full = wireNodes({ frames: () => harness.tern.frames }).find(node => node.k === 'el'
      && String(node.id).includes('.composer-permission-option-')
      && String(node.p['text'] ?? '').includes('Full Access'))
    assert.ok(full)
    harnessFreeInput(harness.tern, { ev: 'action', sf: harness.tern.frames.at(-1)!.sf, id: full!.id, act: 'click' })
    await waitUntil('the select callback ran', () => selects.length === 1)
    assert.deepEqual(selects, ['danger-full-access'])
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a hostile notice never reaches the TSP wire raw', async () => {
  const harness = await mountTspHarness()
  try {
    const hostile = 'evil\u001b]52;c;YXR0YWNr\u0007\u001b[2J\u009b2Jname'
    harness.surface.display.notify(hostile, 'error')
    await settle()
    const wire = harness.tern.output.text()
    assert.ok(!wire.includes('YXR0YWNr'), `no OSC 52 payload reaches the TSP wire:\n${wire.slice(0, 400)}`)
    assert.ok(!wire.includes('\u009b'), 'no raw C1 byte reaches the TSP wire')
    assert.ok(wire.includes('evil'), 'the readable notice text survives the projection')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── A-09 (F4): many notices never collide on an SDK node key ────────────────

test('repeated notices keep unique dock keys (no SDK duplicate-key ViewError)', async () => {
  const harness = await mountTspHarness()
  try {
    for (let index = 0; index < 8; index += 1) {
      harness.surface.display.notify(`notice number ${index}`, 'error')
      await settle()
    }
    const wire = harness.tern.output.text()
    assert.ok(wire.includes('notice number 7'), 'the newest notice is rendered')
    const noticeIds = [...wire.matchAll(/"id":"dock\.notice-([^"]+)"/g)].map(m => m[1]!)
    assert.ok(noticeIds.length >= 8, `every notice frame landed (${noticeIds.length})`)
    // The pinned modals notice (A-08 path) coexisting with transient notices
    // must not collide either.
    harness.surface.display.setDockNotice({ id: 'pinned', text: 'pinned notice', kind: 'info' })
    await settle()
    harness.surface.display.notify('after pinned', 'error')
    await settle()
    harness.surface.display.setDockNotice(undefined)
    await settle()
    harness.surface.display.notify('after clear', 'info')
    await settle()
    assert.ok(harness.tern.output.text().includes('after clear'), 'the renderer survives pinned/clear/notify cycles')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── A-10 (F5): the pending-input presentation is actually VISIBLE ────────────

test('the joined pending presentation (queued + tail) renders in the dock', async () => {
  const harness = await mountTspHarness()
  try {
    harness.surface.display.setPendingInputPresentation({
      queued: [
        { id: 'q-1', text: 'queued local text', mode: 'followup' },
        { id: 'q-2', text: 'queued steer text', mode: 'steer' },
      ],
      tail: [
        { kind: 'user', row: { id: 'u-1', text: 'steering text', status: 'steering' } },
        { kind: 'context', row: { id: 'c-1', text: 'background context text' } },
      ],
      running: true,
    } as never)
    await settle()
    const wire = harness.tern.output.text()
    assert.ok(wire.includes('queued local text'), 'the queued row is visible')
    assert.ok(wire.includes('queued steer text'), 'the steer row is visible')
    assert.ok(wire.includes('steering text'), 'the pending user row is visible')
    assert.ok(wire.includes('(steering…)'), 'the pending status is visible')
    assert.ok(wire.includes('background context text'), 'the non-user Context row is visible')
    assert.ok(wire.includes('context:'), 'the Context row keeps its non-user identity')

    // Clearing the presentation removes the rows again.
    harness.surface.display.setPendingInputPresentation({ queued: [], tail: [], running: false } as never)
    await settle()
    const cleared = harness.tern.output.text()
    assert.ok(cleared.includes('\"del\",\"dock.queue-q-1\"') || !cleared.slice(cleared.lastIndexOf('dock.queue-q-1')).includes('queued local text'),
      'the cleared queue row is removed from the dock')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('an idle authoritative queue explains the next-prompt wake; local-only/running do not', async () => {
  const harness = await mountTspHarness()
  const lastFrame = (wire: string): string => wire.slice(wire.lastIndexOf('_tsp;f;') + 1)
  try {
    harness.surface.display.setPendingInputPresentation({
      queued: [{ id: 'q-parked', text: 'parked queue text', mode: 'followup' }],
      tail: [],
      running: false,
    } as never)
    await waitUntil('the parked queue hint', () => lastFrame(harness.tern.output.text()).includes('dock.queue-parked-hint'))
    let wire = harness.tern.output.text()
    const parked = lastFrame(wire)
    assert.ok(parked.includes('"add","dock.queue-parked-hint"') && parked.includes('waiting for the next prompt — send a message to continue'),
      `the idle authoritative queue must explain the next-prompt wake:\n${parked}`)

    harness.surface.display.setPendingInputPresentation({
      queued: [{ id: 'q-local', text: 'local-only text', mode: 'followup', local: true }],
      tail: [],
      running: false,
    } as never)
    await waitUntil('the local-only queue row', () => lastFrame(harness.tern.output.text()).includes('local-only text'))
    wire = harness.tern.output.text()
    const local = lastFrame(wire)
    assert.ok(local.includes('local-only text'), `the local echo must stay visible:\n${local}`)
    assert.ok(local.includes('sending…'), `a local echo is still being admitted:\n${local}`)
    assert.ok(!foldWireNodes(harness.tern.frames).some(node => node.id === 'dock.queue-parked-hint'),
      `the old parked hint must be retired from the folded wire for local-only rows:\n${local}`)

    harness.surface.display.setPendingInputPresentation({
      queued: [{ id: 'q-running', text: 'running queue text', mode: 'followup' }],
      tail: [],
      running: true,
    } as never)
    // Re-establish the parked state, then transition directly to running: this
    // proves the parked → running retirement, not just local → running.
    harness.surface.display.setPendingInputPresentation({
      queued: [{ id: 'q-parked-again', text: 'parked again', mode: 'followup' }],
      tail: [],
      running: false,
    } as never)
    await waitUntil('the parked hint returns', () => foldWireNodes(harness.tern.frames).some(node => node.id === 'dock.queue-parked-hint'))
    harness.surface.display.setPendingInputPresentation({
      queued: [{ id: 'q-running', text: 'running queue text', mode: 'followup' }],
      tail: [],
      running: true,
    } as never)
    await waitUntil('the running queue row', () => lastFrame(harness.tern.output.text()).includes('running queue text'))
    wire = harness.tern.output.text()
    const running = lastFrame(wire)
    assert.ok(!foldWireNodes(harness.tern.frames).some(node => node.id === 'dock.queue-parked-hint'),
      `a BUSY queued row is normal queueing, not parked; the hint is retired from the folded wire:\n${running}`)
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── A-11 (F6): a mounted input-loop failure is FATAL, not a normal exit ─────

test('a real SDK iterator failure routes the SAME error to the FATAL intent', async () => {
  const tern = new ScriptedTern()
  const session = await openSession(tern)
  let fatal: unknown
  let fatalCount = 0
  let exits = 0
  const renderer = mountTspRenderer(session, { copyVisual: async () => false,
    requestExit: () => { exits += 1 },
    onFatal: error => { fatal = error; fatalCount += 1 },
  })
  try {
    await settle()
    // Manufacture a REAL mounted failure through the shipped SDK route: a node
    // handler that throws. The SDK's #chain catches it and rejects the next
    // iterator read with that exact error (session.ts #fail).
    const mountedFailure = new Error('mounted tty died')
    const sdkSurface = session.surface('s1')
    assert.ok(sdkSurface !== undefined, 'the mounted renderer owns surface s1')
    sdkSurface.render(ui.col(
      { key: 'probe' },
      ui.text({ key: 'boom', onAction: { boom: () => { throw mountedFailure } } } as never, 'x'),
    ))
    await settle()
    harnessFreeInput(tern, { ev: 'action', sf: 's1', id: 'main.probe.boom', act: 'boom', mods: [] })
    await settle()

    assert.equal(fatalCount, 1, 'the input loop surfaced the failure exactly once')
    assert.equal(fatal, mountedFailure,
      'the SAME error INSTANCE reaches the fatal route (identity, not message equality)')
    assert.equal(exits, 0, 'a mounted failure NEVER reports a normal exit intent')
  } finally {
    await renderer.dispose()
  }
})

// ── PR4-0 audit: a non-modal native event has NO business sink ──────────────

test('non-key SDK events reach no business action while no modal seat is up', async () => {
  const tern = new ScriptedTern()
  const session = await openSession(tern)
  const calls = { submit: 0, steer: 0, cancel: 0, noteUserInput: 0, exits: 0 }
  const renderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => { calls.exits += 1 } })
  try {
    renderer.bindInput({
      exit: () => { calls.exits += 1 },
      cancel: () => { calls.cancel += 1 },
      submit: () => { calls.submit += 1 },
      steer: () => { calls.steer += 1 },
      pasteMedia: () => {},
      pastedPath: () => {},
      admitPastedPathDelivery: () => true, shouldRememberInput: () => true,
      noteUserInput: () => { calls.noteUserInput += 1 },
      listContinuedQuestions: () => [],
      reopenContinuedQuestion: () => false,
      openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true, openTasksBrowserUi() {}, tasksBrowserUiAvailable: () => true,
    })
    await settle()
    // INJECTED protocol events, not events this UI emits: the current TSP view
    // declares no `actions` on any node, so its only natural pointer target is
    // the composer (`ui.editor` -> a `focus` claim); `action`/`select`/
    // `activate`/`change` are the official wire shapes a real Tern pane emits
    // for nodes that DO declare them (the PR4-0 real-Tern probe), injected here
    // to lock the ROUTER fact: with no modal seat up, none of them becomes an
    // application action — this is the "rendered is not actionable" boundary.
    for (const event of [
      { ev: 'action', sf: 's1', id: 'dock.composer', act: 'click', mods: [] },
      { ev: 'select', sf: 's1', id: 'main.some-list', item: 'main.some-list.0' },
      { ev: 'activate', sf: 's1', id: 'main.some-list', item: 'main.some-list.0' },
      { ev: 'change', sf: 's1', id: 'main.some-check', value: 'on', checked: true, name: 'x' },
      { ev: 'focus', sf: 's1', id: 'dock.composer' },
    ]) {
      harnessFreeInput(tern, event)
      await settle()
    }
    assert.deepEqual(calls, { submit: 0, steer: 0, cancel: 0, noteUserInput: 0, exits: 0 },
      'a non-modal native event never reaches submit/steer/cancel/exit/user-input')
    assert.equal(renderer.composer.getDraft(), '', 'the draft is untouched by the events')
  } finally {
    await renderer.dispose()
  }
})

// ── A-15 (F3-002): a client protocol rejection is DIAGNOSED, nothing else ───
//
// The client answers a refused protocol operation with `error` (`msg` required;
// `sf`/`s`/`op`/`sheet`/`id` optional). The SDK neither interprets nor consumes it
// (`Surface.dispatch` has no `error` branch), so without an application branch it is
// silently dropped — the confirmed diagnostic gap. These cases go through the REAL
// SDK connect + `mountTspRenderer` + the real wire (`harnessFreeInput`), so the SDK's
// own routing decides which events reach the iterator.
//
// WHICH ASSERTIONS DISCRIMINATE (stated explicitly, per review):
//  - The DIAGNOSTIC assertions (`diagnostics.length`, `message`, `fields`) are the
//    discriminative ones: they fail without the new branch.
//  - The "nothing else changed" witnesses (no frame, no extra focus op, no notify, no
//    fatal, business counters at zero) are OUTCOME witnesses, not discriminators: the
//    pre-existing routes already decline `error` (`interaction.ts` claims only
//    focus/edit/undo/send; both pickers require `select|activate|action` plus a known
//    `id`), so they also hold without the fix. They are kept to catch a regression that
//    makes an `error` act somewhere. A-15e carries the one genuinely discriminative
//    contrast: the legal focus route still re-asserts focus under a modal, while the same
//    state plus an `error` does not take that re-assert path. It does NOT show that the
//    error failed to ENTER the seat — every consumer already declines `error`, so no
//    black-box observation can separate a branch before the seat from one after it.

interface Diagnostic {
  readonly message: string
  readonly fields: Record<string, unknown> | undefined
}

/** Mount the renderer with the diagnostics + notification sinks observed and the business counters. */
async function mountDiagnosed(tern: ScriptedTern) {
  const diagnostics: Diagnostic[] = []
  const notifications: string[] = []
  const business = { submit: 0, steer: 0, cancel: 0, noteUserInput: 0, exits: 0 }
  const fatals: unknown[] = []
  const renderer = mountTspRenderer(await openSession(tern), { copyVisual: async () => false,
    requestExit: () => { business.exits += 1 },
    onFatal: error => { fatals.push(error) },
    logError: (message, fields) => { diagnostics.push({ message, fields }) },
  })
  // A user-visible notification is a MUST-NOT for a protocol error: witness it. Keep the
  // UNBOUND original and forward through `.call` so the receiver stays the live `display`
  // object (a bound patch would pin it to whatever it was bound to).
  const notify = renderer.display.notify
  renderer.display.notify = (text, kind) => { notifications.push(text); notify.call(renderer.display, text, kind) }
  renderer.bindInput({
    exit: () => { business.exits += 1 },
    cancel: () => { business.cancel += 1 },
    submit: () => { business.submit += 1 },
    steer: () => { business.steer += 1 },
    pasteMedia: () => {},
    pastedPath: () => {},
    admitPastedPathDelivery: () => true, shouldRememberInput: () => true,
    noteUserInput: () => { business.noteUserInput += 1 },
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
    openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true, openTasksBrowserUi() {}, tasksBrowserUiAvailable: () => true,
  })
  return { renderer, diagnostics, notifications, business, fatals }
}

const NO_BUSINESS = { submit: 0, steer: 0, cancel: 0, noteUserInput: 0, exits: 0 }

/** The `focus` ops sent so far — the side-effect witness for "an error changes nothing". */
function focusOps(tern: ScriptedTern): string[] {
  return tern.frames.flatMap(frame => frame.ops.filter(op => op[0] === 'focus').map(op => String(op[1])))
}

test('a local-surface protocol error is diagnosed exactly once and changes nothing else', async () => {
  const tern = new ScriptedTern()
  const { renderer, diagnostics, notifications, business, fatals } = await mountDiagnosed(tern)
  try {
    await settle()
    const framesBefore = tern.frames.length
    const opsBefore = focusOps(tern)

    harnessFreeInput(tern, { ev: 'error', sf: 's1', s: 5, op: 5, msg: 'unknown id layer.modal-1.answer' })
    await settle()

    // Discriminative: without the new branch this stays empty.
    assert.equal(diagnostics.length, 1, 'ONE protocol rejection produces exactly ONE diagnostic')
    assert.equal(diagnostics[0]?.message, 'tsp renderer: client rejected protocol operation')
    assert.deepEqual(diagnostics[0]?.fields, { sf: 's1', s: 5, op: 5, msg: 'unknown id layer.modal-1.answer' },
      'the diagnostic carries the exact structured fields the client sent')
    // Outcome witnesses (they also hold without the fix — see the group comment).
    assert.deepEqual(notifications, [], 'a protocol error never raises a user notification')
    assert.equal(tern.frames.length, framesBefore, 'an error is never a reason to render')
    assert.deepEqual(focusOps(tern), opsBefore, 'an error never re-asserts focus')
    assert.deepEqual(business, NO_BUSINESS, 'the business handlers never see a protocol error')
    assert.deepEqual(fatals, [], 'a refused operation is not a fatal renderer failure')
    assert.equal(renderer.composer.getDraft(), '', 'the composer draft is untouched')
  } finally {
    await renderer.dispose()
    assert.ok(tern.closeBodies.length >= 1, 'the session still closed and released the tty')
    assert.deepEqual(fatals, [], 'disposal reports no fatal either')
  }
})

test('optional `sf`/`s`/`op` are never fabricated, and a foreign surface is not attributed', async () => {
  const tern = new ScriptedTern()
  const { renderer, diagnostics, notifications, business, fatals } = await mountDiagnosed(tern)
  try {
    await settle()
    // Session-level: `msg` alone is a legal ErrorEvent. It MUST be recorded and MUST NOT
    // gain an invented `sf`/`s`/`op`.
    harnessFreeInput(tern, { ev: 'error', msg: 'session level refusal' })
    await settle()
    assert.equal(diagnostics.length, 1, 'a message-only refusal is still diagnosed')
    assert.deepEqual(diagnostics[0]?.fields, { msg: 'session level refusal' },
      'the diagnostic carries ONLY what the client sent (no fabricated sf/s/op)')

    // Another surface's error is NOT this renderer's to attribute.
    harnessFreeInput(tern, { ev: 'error', sf: 's2', s: 3, op: 1, msg: 'a foreign refusal' })
    await settle()
    assert.equal(diagnostics.length, 1, 'a foreign surface error is not attributed to this renderer')
    assert.deepEqual(notifications, [])
    assert.deepEqual(business, NO_BUSINESS)
    assert.deepEqual(fatals, [])
  } finally {
    await renderer.dispose()
    assert.ok(tern.closeBodies.length >= 1, 'the session still closed')
    assert.deepEqual(fatals, [])
  }
})

test('an error that ALSO carries an optional `id` is still an error, never a business route', async () => {
  const tern = new ScriptedTern()
  const { renderer, diagnostics, notifications, business, fatals } = await mountDiagnosed(tern)
  try {
    await settle()
    const framesBefore = tern.frames.length
    const opsBefore = focusOps(tern)
    // The pinned SDK type allows `id` on an ErrorEvent. Routing must NOT depend on it:
    // this must take the error branch, not the node-id keyed presenter route.
    harnessFreeInput(tern, { ev: 'error', sf: 's1', id: 'layer.preset-1-rev-1', s: 9, op: 0, msg: 'unknown id dock.composer' })
    await settle()
    assert.equal(diagnostics.length, 1, 'an error with an `id` is diagnosed exactly once')
    assert.deepEqual(diagnostics[0]?.fields, { sf: 's1', s: 9, op: 0, msg: 'unknown id dock.composer' },
      'the optional `id` is NOT logged (the diagnostic contract takes sf/s/op/msg)')
    assert.deepEqual(notifications, [])
    assert.equal(tern.frames.length, framesBefore, 'the `id` did NOT open a presenter path that renders')
    assert.deepEqual(focusOps(tern), opsBefore, 'and it did not move focus')
    assert.deepEqual(business, NO_BUSINESS)
    assert.deepEqual(fatals, [])
  } finally {
    await renderer.dispose()
    assert.ok(tern.closeBodies.length >= 1, 'the session still closed')
    assert.deepEqual(fatals, [])
  }
})

test('a protocol error during an open modal is diagnosed without settling it or re-asserting focus', async () => {
  const tern = new ScriptedTern()
  const { renderer, diagnostics, notifications, business, fatals } = await mountDiagnosed(tern)
  try {
    await settle()
    let settled = false
    void renderer.interaction
      .askQuestions([{ id: 'a15-q', question: 'still open?' }], undefined, undefined, false)
      .then(() => { settled = true }, () => { settled = true })
    await settle()
    const framesWithModal = tern.frames.length
    const opsBefore = focusOps(tern)

    harnessFreeInput(tern, { ev: 'error', sf: 's1', s: 6, op: 0, msg: 'unknown id no-such-node' })
    await settle()

    assert.equal(diagnostics.length, 1, 'the modal seat does not swallow the diagnosis')
    assert.deepEqual(notifications, [])
    assert.equal(settled, false, 'an error never settles the modal')
    assert.equal(tern.frames.length, framesWithModal, 'an error never repaints under a modal')
    assert.deepEqual(focusOps(tern), opsBefore, 'an error never re-asserts the modal focus')
    assert.deepEqual(business, NO_BUSINESS)
    assert.deepEqual(fatals, [])
    renderer.interaction.withdrawPending()
    await settle()
  } finally {
    await renderer.dispose()
    assert.ok(tern.closeBodies.length >= 1, 'the session still closed')
    assert.deepEqual(fatals, [])
  }
})

test('under a modal the LEGAL focus route still re-asserts focus, while an `error` does not', async () => {
  const tern = new ScriptedTern()
  const { renderer, diagnostics, notifications, business, fatals } = await mountDiagnosed(tern)
  try {
    await settle()
    void renderer.interaction
      .askQuestions([{ id: 'a15-q2', question: 'legal route control' }], undefined, undefined, false)
      .then(() => {}, () => {})
    await settle()
    // POSITIVE CONTROL for the untouched legal route: while the seat is up, a terminal
    // `focus` claim is re-asserted by the pre-existing modal branch (a NEW focus op).
    const opsBeforeFocus = focusOps(tern).length
    harnessFreeInput(tern, { ev: 'focus', sf: 's1', id: 'dock.composer' })
    await settle()
    const opsAfterFocus = focusOps(tern).length
    assert.ok(opsAfterFocus > opsBeforeFocus,
      `the legal modal focus route still re-asserts focus (${opsBeforeFocus} -> ${opsAfterFocus})`)
    // ...and the SAME state + an `error` adds a diagnostic but no focus op and no repaint.
    const framesBefore = tern.frames.length
    harnessFreeInput(tern, { ev: 'error', sf: 's1', s: 7, op: 0, msg: 'unknown id dock.composer' })
    await settle()
    assert.equal(diagnostics.length, 1, 'the error is diagnosed next to the legal route')
    assert.equal(focusOps(tern).length, opsAfterFocus, 'and it does NOT take the legal re-assert path')
    assert.equal(tern.frames.length, framesBefore, 'nor does it render')
    assert.deepEqual(notifications, [])
    assert.deepEqual(business, NO_BUSINESS)
    assert.deepEqual(fatals, [])
    renderer.interaction.withdrawPending()
    await settle()
  } finally {
    await renderer.dispose()
    assert.ok(tern.closeBodies.length >= 1, 'the session still closed')
    assert.deepEqual(fatals, [])
  }
})

// ── A-12 (F7): a failed mount closes the already-connected SDK session ─────

test('a rejected mount closes the connected SDK session once (no leaked tty owner)', async () => {
  const tern = new ScriptedTern()
  const session = await openSession(tern)
  let closes = 0
  const originalClose = session.close.bind(session)
  session.close = async () => { closes += 1; await originalClose() }
  // Force `session.open` to throw: the connect-time ownership must close the
  // session before re-raising (raw-mode stdin would otherwise stay held with
  // no registered disposer).
  const originalOpen = session.open.bind(session)
  session.open = () => { throw new Error('open exploded') }
  try {
    const { connectTspRenderer } = await import('../../src/tui/tsp/session.ts')
    await assert.rejects(
      connectTspRenderer({ copyVisual: async () => false, requestExit: () => {}, connect: async () => session, connectTimeout: 50 }),
      /open exploded/,
    )
    // R2-3 ownership: the CONNECTOR is the one owner that connected the session,
    // so it performs the ONE release; `mountTspRenderer` re-raises a throwing
    // `open` without closing (a second close would be a double owner).
    assert.equal(closes, 1, `the connector closed the session exactly once (${closes})`)
  } finally {
    session.open = originalOpen
    if (closes === 0) await session.close().catch(() => {})
  }
})

test('a secondary tty-restoration failure never replaces the primary mount error', async () => {
  const tern = new ScriptedTern()
  const session = await openSession(tern)
  let closes = 0
  const originalClose = session.close.bind(session)
  const originalOpen = session.open.bind(session)
  session.open = () => { throw new Error('open exploded') }
  session.close = async () => { closes += 1; throw new Error('raw restore exploded') }
  const recorded: { message: string; fields?: Record<string, unknown> }[] = []
  try {
    const { connectTspRenderer } = await import('../../src/tui/tsp/session.ts')
    await assert.rejects(
      connectTspRenderer({
        copyVisual: async () => false,
        requestExit: () => {},
        connect: async () => session,
        connectTimeout: 50,
        logError: (message, fields) => { recorded.push({ message, fields }) },
      }),
      /open exploded/,
      'the PRIMARY mount error is the one that propagates',
    )
    assert.equal(closes, 1, 'the release was ATTEMPTED exactly once')
    assert.equal(recorded.length, 1, 'the secondary restoration failure is recorded, never swallowed')
    assert.match(String(recorded[0]!.fields?.error), /raw restore exploded/)
    assert.match(String(recorded[0]!.fields?.primary), /open exploded/)
  } finally {
    session.open = originalOpen
    session.close = originalClose
    await session.close().catch(() => {})
  }
})

test('a mounted teardown preserves BOTH close failures (never truncates the first)', async () => {
  const tern = new ScriptedTern()
  const session = await openSession(tern)
  const renderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => {}, onFatal: () => {} })
  await settle()
  const sdkSurface = session.surface('s1')
  assert.ok(sdkSurface !== undefined, 'the mounted renderer owns surface s1')
  const surfaceFailure = new Error('surface close exploded')
  const sessionFailure = new Error('session close exploded')
  // Fault injection at the SDK boundary: keep the UNBOUND originals so the
  // teardown can still release the real tty afterwards.
  const originalSurfaceClose = sdkSurface.close
  const originalSessionClose = session.close
  sdkSurface.close = async () => { throw surfaceFailure }
  session.close = async () => { throw sessionFailure }
  try {
    const failure = await renderer.dispose().then(() => undefined, (error: unknown) => error)
    assert.ok(failure instanceof AggregateError,
      `both close failures surface together (got ${String(failure)})`)
    assert.deepEqual((failure as AggregateError).errors, [surfaceFailure, sessionFailure],
      'the FIRST failure keeps its position instead of being discarded')
  } finally {
    sdkSurface.close = originalSurfaceClose
    session.close = originalSessionClose
    await sdkSurface.close({ keep: false }).catch(() => {})
    await session.close().catch(() => {})
  }
})

test('the PRODUCTION connector handshake releases a mount a REAL surface.start rejected', async () => {
  const tern = new ScriptedTern()
  const session = await openSession(tern)
  let closes = 0
  const originalClose = session.close.bind(session)
  session.close = async () => { closes += 1; await originalClose() }
  const { selectRendererMount, productionTspConnector } = await import('../../src/app/bootstrap/renderer-selection.ts')
  const requestExit = (): void => {}
  // ONLY the SDK connect boundary is replaced: the PRODUCTION connector and its
  // real `connectTspRenderer` (owned-session release + diagnostics) are the ones
  // under test (R3-3).
  const mount = await selectRendererMount({
    log: () => {},
    env: { DSH_PI_TUI_RENDERER: 'tsp' },
    resolveFooterConfig: () => resolveTspNativeFooterConfig({ doc: { footer: 'default' }, readiness: 'ready', userItems: { items: [], invalidCount: 0 } }),
    connectTsp: productionTspConnector({ copyVisual: async () => false,
      cwd: '/tmp', displayState: { preset: 'full' }, requestExit, onFatal: () => {}, log: () => {}, logError: () => {},
      connect: async () => session,
    }),
  })
  assert.ok(mount !== undefined, 'the PRODUCTION connector produced a mount')

  const harness = await mountTspHarness()
  try {
    // A REAL `surface.start` rejection on an ALREADY-MOUNTED surface (this guard
    // pins the RELEASE accessor and its idempotence; the disposed-DURING-handshake
    // cancellation path is the acquisition transaction's business, and this test
    // does NOT exercise that path).
    assert.throws(
      () => { harness.surface.start({ ...harness.startDeps, renderer: mount }) },
      /the surface is already mounted/,
      'the REAL surface.start rejected the mount',
    )
    await mount.releaseUnmounted()
    await mount.releaseUnmounted()
    assert.equal(closes, 1, 'the handshake release is idempotent and closes exactly once')
  } finally {
    await harness.dispose()
  }
})

// ── A-13 (F3): the hydrate-tail reset never clears hydrated facts ───────────

test('the hydrate-tail reset keeps committed status facts and an explicit undefined title clears', async () => {
  const harness = await mountTspHarness()
  try {
    harness.surface.display.commitStatusFacts({ sessionTitle: 'AUTHORITATIVE_TITLE', working: true, planMode: true, busy: true })
    await settle()
    harness.surface.display.resetSessionFacts()
    await settle()
    assert.equal(harness.surface.display.getSessionTitle(), 'AUTHORITATIVE_TITLE',
      'the hydrate-tail reset does not clear the just-committed title')
    assert.ok(harness.tern.output.text().includes('AUTHORITATIVE_TITLE'), 'the title stays visible')

    // A partial commit must not drop the SIBLING facts. Each surviving fact is
    // witnessed on its OWN authority:
    //   title → the displayable legacy line;
    //   plan  → the NATIVE status row the projection owns (committed below).
    // The banner's `working` word retired with the banner (plan §1.3); the
    // run-phase display is PR-B scope and is NOT re-asserted here.
    harness.surface.display.commitStatusFacts({ todos: [{ content: 'a todo', status: 'pending' }] })
    await settle()
    const wire = harness.tern.output.text()
    assert.ok(wire.includes('AUTHORITATIVE_TITLE'), 'the sibling title fact survives a partial commit')
    assert.ok(wire.includes('todos 0/1'), 'the todo fact is visible')
    // The plan fact is a NATIVE row now: it exists only after a formal display
    // commit has published the store snapshot that carries `collaboration.plan`.
    // Committing it is the setup, not the witness — the witness is that the
    // partial `todos` commit AFTER it does not drop the row.
    harness.surface.commitStatus(
      { collaboration: { plan: { effective: true } } } as never,
      {},
      undefined,
    )
    await settle()
    const planSeg = wireNodes(harness.tern.pane)
      .find(node => node.k === 'seg' && node.p.key === 'status-r1-plan')
    assert.ok(planSeg !== undefined, 'the committed plan paints its native seg')
    assert.equal(planSeg.p.text, 'plan', 'the plan word is the builtin formatter output')
    harness.surface.display.commitStatusFacts({ sessionTitle: 'POST_PLAN_TITLE' })
    await settle()
    const planAfterFactsCommit = wireNodes(harness.tern.pane)
      .find(node => node.k === 'seg' && node.p.key === 'status-r1-plan')
    assert.ok(planAfterFactsCommit !== undefined,
      'the plan seg survives a sibling status-facts commit')

    // PRESENCE semantics: an explicitly-present undefined title CLEARS it.
    harness.surface.display.commitStatusFacts({ sessionTitle: undefined })
    await settle()
    assert.equal(harness.surface.display.getSessionTitle(), '',
      'explicit undefined clears even the replacement title')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── A-14 (F9): the semantic patch reaches the SHARED StatusStore ────────────

test('surface.commitStatus writes the shared StatusStore on the TSP branch', async () => {
  const harness = await mountTspHarness()
  try {
    harness.surface.commitStatus(
      { workspace: { cwd: '/AUTHORITATIVE_WORKSPACE', project: 'AUTHORITATIVE_WORKSPACE' } } as never,
      {},
      undefined,
    )
    await settle()
    assert.equal(harness.surface.status.snapshot().workspace.cwd, '/AUTHORITATIVE_WORKSPACE',
      'the semantic patch landed in the shared store (both renderers consume it)')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── A-08: modals at the read-only renderer fail closed, observably ──────────

test('the read-only renderer advertises no modals and the dock notice is observable', async () => {
  const harness = await mountTspHarness()
  try {
    assert.equal(harness.surface.display.supportsModals, false)
    harness.surface.display.setDockNotice({ id: 'probe', text: 'modals unsupported probe', kind: 'info' })
    await settle()
    assert.ok(harness.tern.output.text().includes('modals unsupported probe'), 'the dock notice reached the wire')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('the interaction owner registers fail-closed answerers on a modal-less renderer', async () => {
  // The REAL interaction runtime over the TSP display seam: an approval ask
  // resolves 'unavailable' (the official no-answerer outcome — never an
  // implicit allow) and a question delegates to next() (the Host lifecycle).
  const { createInteractionRuntime } = await import('../../src/app/surface/interaction-runtime.ts')
  const notices: unknown[] = []
  const display = {
    supportsModals: false,
    setDockNotice: (notice: unknown) => { notices.push(notice) },
    notify: () => {},
    setTranscript: () => {},
    commitStatusFacts: () => {},
    commitDisplaySubject: () => {},
    resetSessionFacts: () => {},
    resetInputHistory: () => {},
    beginInputHistoryScope: () => {},
    settleScopeInput: () => {},
    setSearchResult: () => {},
    setWelcomeCard: () => {},
    setWelcomeIdle: () => {},
    setTerminalCwd: () => {},
    setPendingInputPresentation: () => {},
    getSessionTitle: () => '',
    getViewerGeneration: () => 0,
    supportsTaskCenter: false,
    supportsViewer: false,
  }
  let approvalListener: ((req: { toolName: string }, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  let questionProvider: ((req: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const port = {
    onApprovalRequest: (listener: typeof approvalListener) => { approvalListener = listener },
    questions: {
      onRequest: (provider: typeof questionProvider) => { questionProvider = provider; return true },
      snapshot: () => undefined,
      subscribe: () => undefined,
      claimTimedWait: () => undefined,
      subscribeAttention: () => undefined,
      answerContinued: async () => 'queued',
    },
    setApprovalPolicy: () => true,
  }
  const interaction = createInteractionRuntime({
    presenter: () => { throw new Error('no TuiApp on the TSP branch') },
    livePresenter: () => undefined,
    display: () => display as never,
    currentSessionId: () => 'session-a08',
    isAdmissibleSession: () => true,
    schedulePaint: () => {},
    diag: () => ({ debug() {}, info() {}, warn() {}, error() {}, dispose() {} }),
    isCleanedUp: () => false,
    onAttentionChanged: () => {},
    publishActivity: () => {},
  })
  interaction.attach(port as never, { lookupCallArgs: () => undefined, dangerCommand: () => false })
  try {
    assert.ok(approvalListener !== undefined, 'the approval answerer is registered (fail-closed)')
    assert.ok(questionProvider !== undefined, 'the question answerer is registered (delegating)')
    const outcome = await approvalListener!({ toolName: 'bash' }, async () => 'allowed-once')
    assert.equal(outcome, 'unavailable', 'an approval at the read-only renderer resolves unavailable — never allowed')
    assert.equal(notices.length, 2, 'the notice is published at attach AND at the approval request')
    const delegated: string[] = []
    const answer = await questionProvider!(null, async () => { delegated.push('next'); return 'host-answer' })
    assert.deepEqual(delegated, ['next'])
    assert.equal(answer, 'host-answer', 'a question delegates to the Host waterfall (its timeout/continued lifecycle owns it)')
    assert.equal(notices.length, 3, 'a delegated question re-publishes the same explicit notice too')
    assert.ok(String((notices[0] as { text: string }).text).includes('not answerable'), 'the notice is observable')

    // The notice is TRANSIENT: the hydrate-tail reset clears it and enough
    // ordinary notices evict it. A later request must make it observable AGAIN —
    // otherwise a programmatic/timed approval arrives with no visible
    // explanation at all.
    notices.length = 0
    const lateOutcome = await approvalListener!({ toolName: 'bash' }, async () => 'allowed-once')
    assert.equal(lateOutcome, 'unavailable')
    assert.equal(notices.length, 1,
      'an unsupported request AFTER the notice was cleared re-publishes it (current visibility, not history)')
    assert.equal((notices[0] as { id: string }).id, 'modals-unsupported')

    notices.length = 0
    await questionProvider!(null, async () => { delegated.push('next'); return 'host-answer' })
    assert.equal(notices.length, 1, 'a delegated question re-publishes the same explicit notice')
    assert.deepEqual(delegated, ['next', 'next'], 'the question still delegates (no fabricated answer)')
  } finally {
    interaction.dispose()
  }
})

test('the live harness OWNS its renderer release: a failed close surfaces, never as an unhandled rejection', async () => {
  const harness = await mountTspHarness()
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    await settle()
    const output = harness.tern.output
    const original = output.onWrite
    const closeFailure = new Error('close write exploded')
    let armed = true
    output.onWrite = (bytes: Uint8Array): void => {
      if (armed && DECODER.decode(bytes).includes('\u001b_tsp;x;')) {
        armed = false
        throw closeFailure
      }
      original?.(bytes)
    }
    // The release outcome belongs to THIS caller, with the EXACT injected identity.
    const failure = await harness.dispose().then(() => undefined, (error: unknown) => error)
    assert.equal(failure, closeFailure,
      'the failed renderer release surfaces to the disposing caller as the SAME error')
    assert.equal(harness.tern.input.raw.at(-1), false,
      'the failing release still restored the tty (raw mode off)')
    // Give Node a turn to report any UNOWNED rejection before asserting.
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.deepEqual(unhandled, [],
      'no unowned rejection: the harness consumed the release outcome it started')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

// ── PR3-B B3: teardown order — the interaction owner retires FIRST ──────────

test('the surface withdraws the interaction owner BEFORE it starts the renderer release', async () => {
  // The order of the two teardown owners in ONE synchronous batch: the modal
  // promises are withdrawn before the terminal release begins, so a live
  // question/approval is never classified by a terminal that vanished first.
  const order: string[] = []
  const presenter = {
    showApprovalPrompt: () => Promise.resolve('cancelled' as const),
    askQuestions: () => Promise.resolve([]),
    setSettledQuestionAnswersLookup: () => {},
    notify: () => {},
    setQuestionAttention: () => {},
    withdrawPending: () => { order.push('interaction-withdraw') },
    withdrawPresentations: () => {},
    closeTransientList: () => {},
  }
  const display = {
    setTranscript: () => {},
    commitDisplaySubject: () => {},
    commitStatusFacts: () => {},
    resetSessionFacts: () => {},
    beginSessionHydration: () => {},
    clearActiveDraft: () => {},
    retainsStaleDraftRestore: () => false,
    resetInputHistory: () => {},
    beginInputHistoryScope: () => {},
    settleScopeInput: () => {},
    setSearchResult: () => {},
    notify: () => {},
    setDockNotice: () => {},
    setWelcomeCard: () => {},
    setWelcomeIdle: () => {},
    setTerminalCwd: () => {},
    setPendingInputPresentation: () => {},
    getSessionTitle: () => '',
    getViewerGeneration: () => 0,
    supportsTaskCenter: false,
    supportsViewer: false,
    supportsModals: true,
  }
  const composer = {
    getDraft: () => '',
    setDraft: () => {},
    setEditorText: () => {},
    insertIntoEditor: () => {},
    notify: () => {},
    setSubmitPending: () => {},
    clearSettledLocalMessages: () => {},
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
  surface.start({
    events: { onSubmit: () => {}, onExit: () => {} },
    renderer: {
      // PR-C: the fake mount receives the ONE image binding of this surface.
      // It PROVES the binding carries a real loader and a scope sampler
      // instead of accepting a default that would hide a missing binder.
      mount: (binding, statusReader) => {
        assert.equal(typeof binding.imageLoader.load, 'function')
        assert.equal(typeof binding.imageScope, 'function')
        // TSP-7 PR-A: the mount hands over a READ-ONLY reader — no store
        // writer and no subscription travel with it.
        assert.equal(typeof statusReader.snapshot, 'function')
        return {
          display,
          // The TSP mount always supplies the Task Center presentation sink
          // (the internal Work Hub); this surface fixture never opens it.
          taskPresentation: {
            openBrowser: () => ({ close: () => {}, setItems: () => {}, setRefreshState: () => {} }),
            setQuickTaskItems: () => {},
            setAgents: () => {},
            setTasks: () => {},
            setQuestionAttention: () => {},
            setTaskSummary: () => {},
          },
          composer,
          interaction: presenter,
          bindInput: () => {},
          dispose: async () => { order.push('renderer-release') },
        }
      },
      releaseUnmounted: async () => {},
    } as SurfaceRendererMount,
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
    readImage: () => Promise.reject(new Error('not exercised')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    captureHistoryScope: () => ({ sessionId: 'session-b3-order', isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: async () => false,
    deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: text => text,
  })
  surface.bindRendererInput()
  surface.dispose()
  await surface.whenRendererReleased()
  assert.deepEqual(order, ['interaction-withdraw', 'renderer-release'],
    'the interaction owner is withdrawn BEFORE the renderer release starts')
})


/** Wait for a real SDK-wire fact. The deadline bounds a genuine failure; the
 * loop itself observes the production signal, never a blind fixed sleep. */
async function awaitWireFact(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}

// ── B2-L6: the routed PTC subtree reaches the mounted production renderer ──

test('a routed PTC child start/settle reaches the mounted renderer wire', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'full' } })
  const codeArgs = { code: 'print(1)', description: 'Inspect project and run tests' }
  const readArgs = { file_path: 'src/a.ts' }
  /** Every node the SDK has ever ADDED to the real surface. */
  const collectWireNodes = (): WireNode[] => {
    const nodes: WireNode[] = []
    const visit = (node: WireNode): void => {
      nodes.push(node)
      for (const child of node.c ?? []) visit(child)
    }
    for (const frame of harness.tern.frames) {
      for (const op of frame.ops) {
        if (op[0] === 'add') visit(op[4])
      }
    }
    return nodes
  }
  try {
    harness.surface.bindRendererInput()
    // A genuine durable PTC sequence through the PRODUCTION route: the
    // SessionEvent goes through `routeSessionEvent` → the real folder/window →
    // `SurfaceRuntime.repaintTarget` → the mounted `mountTspRenderer` → the
    // shipped SDK surface. The child START arrives while the parent is running;
    // the parent then settles BEFORE the child's own settle.
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'Inspect and run the PTC program.'))
    harness.route(ev('tool/call', {
      turn: 1,
      step: 0,
      callId: ToolCallId('code-1'),
      name: 'run_code',
      arguments: JSON.stringify(codeArgs),
    }, 2))
    harness.route(ev('tool/ptc-dispatch-start', {
      rootCallId: ToolCallId('code-1'),
      parentCallId: ToolCallId('code-1'),
      subCallId: ToolCallId('code-1:code:1'),
      name: 'read',
      arguments: readArgs,
    }, 3))
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'tool'), 'the collapsed parent Tool header')
    const parent = mountedNodes(harness).find(node => node.k === 'tool')!
    assert.equal(parent.p['collapsible'], true)
    assert.equal(parent.p['collapsed'], true, 'the PTC subtree starts hidden with its parent body')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: parent.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).find(node => node.id === parent.id)?.p['collapsed'] === false,
      'the current parent owner receives its exact native disclosure target')
    await awaitWireFact(() => mountedNodes(harness).some(node => node.id.endsWith('.sub-code-1:code:1')),
      'the child header after the parent body opens')
    harness.route(toolResult(4, 'code-1', 'program output'))
    harness.surface.paintNow()
    await awaitWireFact(() => mountedNodes(harness).find(node => node.id === parent.id)?.p['status'] === 'done',
      'the parent Tool result after its body is open')

    const initial = collectWireNodes()
    const child = initial.find(node => node.id.endsWith('.sub-code-1:code:1'))
    assert.ok(child !== undefined, 'the routed PTC start reached the mounted renderer wire')
    const childId = child.id
    const rootId = childId.slice(0, -'.sub-code-1:code:1'.length)
    assert.equal(child.k, 'tool')
    assert.equal(child.p?.['frame'], 'inline', 'the routed child is a native inline tool')
    assert.equal(child.p?.['status'], 'running')
    assert.equal(initial.find(node => node.id === `${rootId}.child-head`)?.p?.['text'], 'Child calls · 1')
    assert.equal(mountedNodes(harness).find(node => node.id === rootId)?.p?.['status'], 'done',
      'the parent settled before the child settle')
    assert.equal(initial.filter(node => node.id === childId).length, 1,
      'the routed child node was added exactly once')

    // The child SETTLE is routed the same way, after the parent already settled.
    harness.route(ev('tool/ptc-dispatch', {
      rootCallId: ToolCallId('code-1'),
      parentCallId: ToolCallId('code-1'),
      subCallId: ToolCallId('code-1:code:1'),
      name: 'read',
      arguments: readArgs,
      isError: false,
      content: [{ type: 'text', text: 'file.txt' }],
    }, 5))
    harness.surface.paintNow()
    // PR2: the Main children are maintained by targeted raw ops, so a retained
    // parent card's own one-root diff may also RE-ADD its changed child subtree
    // instead of only `set`-ing the child. Both are the same correctness claim:
    // the child node the client ends up with is the SAME id, now settled.
    await awaitWireFact(
      () => harness.tern.frames.some(frame => frame.ops.some(op =>
        op[0] === 'set' && op[1] === childId && (op[2] as { status?: string }).status === 'done')),
      'the routed child settle to reach the mounted renderer wire',
    )

    const settleFrame = harness.tern.frames.at(-1)!
    const childDone = (node: WireNode): boolean => node.id === childId && node.p?.['status'] === 'done'
    assert.ok(settleFrame.ops.some(op => op[0] === 'set' && op[1] === childId
      && (op[2] as { status?: string }).status === 'done')
    || settleFrame.ops.some(op => op[0] === 'add' && childDone(op[4] as unknown as WireNode)),
    'the routed settle updates the SAME child node on the real wire')
    // The retained parent root is re-diffed, never re-keyed: no op may delete or
    // move the ROOT card itself.
    assert.equal(settleFrame.ops.some(op => op[0] === 'del' && op[1] === rootId), false, 'the routed settle deletes no root')
    assert.equal(settleFrame.ops.some(op => op[0] === 'move' && op[1] === rootId), false, 'the routed settle moves no root')
    assert.equal(collectWireNodes().some(node => node.id === `${childId}.result`), false,
      'a settled child body remains hidden until its own Tool disclosure opens')
    const settledChild = collectWireNodes().find(node => node.id === childId)!
    assert.equal(settledChild.p?.['collapsed'], true)
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: childId, collapsed: false, raw: {} })
    await awaitWireFact(() => collectWireNodes().some(node => node.id === `${childId}.result`),
      'the child result after its independent disclosure opens')
    const bodyFrame = harness.tern.frames[harness.tern.frames.length - 1]!
    const addedResult = bodyFrame.ops
      .flatMap(op => op[0] === 'add' ? [op[4]] : [])
      .flatMap(node => {
        const out: WireNode[] = []
        const visit = (current: WireNode): void => {
          out.push(current)
          for (const next of current.c ?? []) visit(next)
        }
        visit(node)
        return out
      })
      .find(node => node.id === `${childId}.result`)
    assert.equal(addedResult?.p?.['text'], 'file.txt', 'the complete child result reaches the real wire on open')
    assert.equal(addedResult?.p?.['wrap'], true)
    assert.equal(bodyFrame.ops.some(op => op[0] === 'set' && op[1] === rootId), false,
      'the child toggle never rewrites the root card')
    assert.equal(collectWireNodes().filter(node => node.id === childId).length, 1,
      'the child node was never remounted across settlement and disclosure')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── TSP I-A: the APPLICATION composition of the recall occurrence ───────────
/*
 * PRODUCTION SHAPE: the real `createSurfaceRuntime` + `surface.start(startDeps)`
 * build the ONE `pendingInputBinding`; `bindRendererInput()` installs it into
 * the real `mountTspRenderer`; a real key on the scripted pane then runs the
 * renderer's own composer → that bound handler → `deps.events` and the real
 * `SurfaceRuntime.display` seam. The last case additionally drives the
 * PRODUCTION `InputHistory` owner over a real `$DSH_HOME/user-history` file, so
 * the accepted input → original writer → same-stack settlement → reseed chain is
 * one run, not a splice.
 * STAND-IN: the scripted pane is not a physical Tern client; the routing source
 * is the minimal PR2 harness family (no Host, no live DSH Session); the recorder
 * on the mounted renderer's own display seam is a one-to-one observer that calls
 * the UNBOUND original through, so the kernel commit still runs.
 * The kernel state behind those commits is read back through the mount's OWN
 * headless diagnostics (`scopeFactCountForTest` / `reconcileStepsForTest`), so
 * the seam is proven to COMMIT, not merely to be called.
 * NOT IN THIS RUN: in production the real `SubmissionController` sits between
 * `events.onSubmit` and the history writer; this case calls the PRODUCTION
 * `InputHistory` owner at that point, so the controller hop is the one labelled
 * substitution. That hop — the real controller, the real writer and the real
 * file, including an identical repeat taking the real policy SKIP and a
 * genuinely staged attachment persisting no row — is pinned on the official
 * Direct composition by `test/integration/tern-tsp-history-persist-direct.test.ts`.
 * The occurrence token itself has no file-level witness (the persisted row
 * carries no occurrence identity), so the two lanes are the occurrence half and
 * the writer half of ONE contract, and neither is claimed as the other.
 */

/* One real draft + one Enter through the mounted renderer, awaited on the
 * AUTHORITATIVE facts: the surface's own composer port (the renderer's live
 * draft) and the application submit entry that recorded the gesture. No fixed
 * window is used — the waits are the facts the case asserts. */
async function enterDraft(
  harness: Harness & { session: Session },
  submitted: readonly { readonly text: string }[],
  text: string,
): Promise<void> {
  harness.tern.input.type(text)
  await waitUntil(`the mounted composer holds ${JSON.stringify(text)}`,
    () => harness.surface.composer.getDraft() === text)
  const expected = submitted.length + 1
  harness.tern.input.type('\r')
  await waitUntil(`the application submit entry recorded ${expected} submission(s)`,
    () => submitted.length === expected)
}

test('the SurfaceRuntime input binding carries the recall occurrence into the application submit entry', async () => {
  const submitted: Array<{ text: string; request: string; scopeToken: number | undefined }> = []
  const harness = await mountTspHarness({
    onSubmit: (text, request, scopeToken) => {
      submitted.push({ text, request: String(request), scopeToken })
    },
  })
  try {
    harness.surface.bindRendererInput()
    assert.ok(harness.boundHandlers(), 'the bind delivered the real pendingInputBinding')
    await enterDraft(harness, submitted, 'composed prompt')
    assert.deepEqual(submitted.map(entry => entry.text), ['composed prompt'],
      'the real Enter reaches the application submit entry exactly once')
    assert.equal(typeof submitted[0]!.scopeToken, 'number',
      'the occurrence token rides the EXISTING third argument through the composition')
    assert.equal(submitted[0]!.request, 'enter', 'the gesture is untouched by the wider signature')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('the application display seam, not the renderer, opens and closes the mounted recall scope', async () => {
  const submitted: Array<{ text: string; scopeToken: number | undefined }> = []
  const harness = await mountTspHarness({
    onSubmit: (text, _request, scopeToken) => { submitted.push({ text, scopeToken }) },
  })
  try {
    harness.surface.bindRendererInput()
    // The owner's hydration reseed, driven through the REAL `SurfaceRuntime`
    // display seam (the same call `session-presentation` makes): the submission
    // path stays, the scope closes.
    harness.surface.display.resetInputHistory(['reseeded row'], SESSION_ID)
    await enterDraft(harness, submitted, 'after the reseed')
    assert.deepEqual(submitted, [{ text: 'after the reseed', scopeToken: undefined }],
      'a closed scope still submits through the application, allocating no occurrence')

    // The formal publication seam reopens it (the same call `bootstrap` makes).
    submitted.length = 0
    harness.surface.display.beginInputHistoryScope('next-owner')
    await enterDraft(harness, submitted, 'for the next owner')
    assert.equal(typeof submitted[0]!.scopeToken, 'number',
      'the published owner reopens the mounted renderer\'s scope')

    // A settlement routed through the SAME seam changes neither half.
    const liveToken = submitted[0]!.scopeToken
    submitted.length = 0
    harness.surface.display.settleScopeInput({
      token: liveToken,
      owner: 'next-owner',
      outcome: 'written',
      text: 'for the next owner',
    })
    // `settleScopeInput` is a SYNCHRONOUS seam commit, so its immediate
    // observable is enough: it wrote nothing into the live composer.
    assert.equal(harness.surface.composer.getDraft(), '',
      'the settlement never touched the draft (no render, no seat change)')
    await enterDraft(harness, submitted, 'still open')
    assert.equal(typeof submitted[0]!.scopeToken, 'number', 'the scope stayed open across the settlement')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('the TSP binding projects the application shouldRememberInput policy instead of guessing one', async () => {
  const submitted: Array<{ text: string; scopeToken: number | undefined }> = []
  const harness = await mountTspHarness({
    onSubmit: (text, _request, scopeToken) => { submitted.push({ text, scopeToken }) },
    shouldRememberInput: text => !text.includes('<img'),
  })
  try {
    harness.surface.bindRendererInput()
    const bound = harness.boundHandlers()
    assert.ok(bound)
    assert.equal(bound!.shouldRememberInput('plain prompt'), true)
    assert.equal(bound!.shouldRememberInput('<img 1>'), false,
      'the binding PROJECTS the application predicate — it owns no policy of its own')

    // The refused input is still a BUSINESS submission (the controller owns
    // that), it just records no recall occurrence.
    await enterDraft(harness, submitted, '<img 1>')
    assert.deepEqual(submitted, [{ text: '<img 1>', scopeToken: undefined }],
      'a History-policy refusal submits normally and allocates no occurrence')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a composition that declares no History predicate accepts the input for recall', async () => {
  const harness = await mountTspHarness()
  try {
    harness.surface.bindRendererInput()
    const bound = harness.boundHandlers()
    assert.ok(bound)
    assert.equal(bound!.shouldRememberInput('anything'), true,
      'an absent application predicate means nothing to refuse — the SAME `?.() === false` shape PiTui uses')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a real TSP Enter reaches the production history owner, writes its row and settles the same mount', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-recall-chain-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const file = historyFilePath(home, home)
  const submitted: Array<{ text: string; scopeToken: number | undefined }> = []
  // The PRODUCTION write owner, composed exactly as `bootstrap` composes it:
  // the late-bound display seam of THIS surface, the client cwd, the row
  // owner's cwd. Nothing here reimplements the write policy.
  let persistSubmissions = true
  const harness = await mountTspHarness({
    onSubmit: (text, _request, scopeToken) => {
      submitted.push({ text, scopeToken })
      if (!persistSubmissions) return
      historyOwner.persist({
        text,
        sessionId: SESSION_ID,
        hasAttachments: false,
        timestamp: T0,
        ...(scopeToken === undefined ? {} : { scopeToken }),
      })
    },
  })
  const historyOwner = createInputHistory({
    surface: { get display() { return harness.surface.display } },
    clientCwd: home,
    sessionCwd: () => home,
    diag: createDiag({ stderrLevel: 'off' }),
    isCleanedUp: () => false,
  })
  // One-to-one observation of the settlement ON THE PRODUCTION CONSUMER: the
  // mounted renderer's own seam member is saved UNBOUND, re-called through the
  // same instance, and the SAME function identity is restored afterwards, so
  // the kernel commit below it still runs (the recorder never replaces it).
  const seam: SurfaceDisplaySeam = harness.renderer().display
  const originalSettle = seam.settleScopeInput
  const settlements: HistoryScopeSettlement[] = []
  seam.settleScopeInput = (settlement) => {
    settlements.push(settlement)
    originalSettle.call(seam, settlement)
  }
  life.defer(() => { seam.settleScopeInput = originalSettle })
  try {
    harness.surface.bindRendererInput()
    // The mount kernel starts this case with no durable settlement fact at all,
    // so every count below is a STATE witness, not a call witness: a seam whose
    // body no longer commits to the kernel cannot move these numbers.
    assert.equal(harness.renderer().scopeFactCountForTest(), 0,
      'no settlement fact exists before any submission')

    await enterDraft(harness, submitted, 'recall chain prompt')
    assert.equal(typeof submitted[0]!.scopeToken, 'number', 'the accepted Enter is an occurrence')
    // SINK 1 — the real file: one row, this Session's id, the submitted text.
    const rows = loadHistoryRecords(file)
    assert.deepEqual(rows.map(row => row.content), ['recall chain prompt'],
      'the production owner appended exactly one real row')
    assert.equal(rows[0]!.sessionId, SESSION_ID, 'the row carries the live session id')
    // SINK 2 — the same synchronous stack settled THAT occurrence, and the
    // settlement reached the mounted renderer's own seam (exactly one call).
    assert.deepEqual(settlements, [{
      token: submitted[0]!.scopeToken,
      owner: SESSION_ID,
      outcome: 'written',
      text: 'recall chain prompt',
    }], 'persist settled the occurrence on its own stack, once')
    // SINK 3 — THAT settlement became a durable per-token fact INSIDE this
    // mount's kernel. This is what proves the seam delegates rather than
    // swallowing: a `settleScopeInput` body that ignored its argument would
    // still satisfy the recorder above and leave this at 0.
    assert.equal(harness.renderer().scopeFactCountForTest(), 1,
      'the written occurrence holds exactly one durable settlement fact in this mount')

    // N05 at the real writer: a SECOND identical Enter is a distinct occurrence
    // (the CWD-level dedupe skips its row), so write and skip stay separable.
    await enterDraft(harness, submitted, 'recall chain prompt')
    assert.equal(typeof submitted[1]!.scopeToken, 'number')
    assert.notEqual(submitted[1]!.scopeToken, submitted[0]!.scopeToken,
      'two identical accepted Enters are two occurrences')
    assert.equal(settlements.length, 2, 'the second submission settled exactly once more')
    assert.equal(settlements[1]!.outcome, 'skipped', 'the per-file consecutive dedupe skipped the row')
    assert.equal(settlements[1]!.token, submitted[1]!.scopeToken,
      'the skip is attributed to ITS OWN occurrence, not to the text')
    assert.equal(loadHistoryRecords(file).length, 1, 'a policy skip wrote no row')
    assert.equal(harness.renderer().scopeFactCountForTest(), 2,
      'the skipped occurrence keeps its OWN fact — settled is not written, and both are remembered')

    // The owner's hydration reseed, driven with the REAL rows the file now
    // holds: the kernel commits it and CLOSES the scope. The next Enter is
    // therefore a plain tokenless write — the witness that the reseed really
    // changed this mount's state instead of being dropped.
    const diskRows = loadHistoryRecords(file).map(row => row.content).reverse()
    harness.surface.display.resetInputHistory(diskRows, SESSION_ID)
    // The reseed consumed those facts in a real linear reconcile and then
    // retired the scope with them: both numbers are kernel state, read back
    // through the mount's own diagnostics.
    assert.ok(harness.renderer().reconcileStepsForTest() > 0,
      'the reseed really walked the window this mount had settled')
    assert.equal(harness.renderer().scopeFactCountForTest(), 0,
      'the committed scope left no settlement fact behind')
    await enterDraft(harness, submitted, 'after the real reseed')
    assert.equal(submitted[2]!.scopeToken, undefined,
      "the real reseed closed this mount's open scope")
    assert.deepEqual(loadHistoryRecords(file).map(row => row.content),
      ['recall chain prompt', 'after the real reseed'],
      'a closed scope still writes through the production owner')
    assert.equal(settlements.length, 3, 'the tokenless write settled once, with no token')
    assert.equal(settlements[2]!.token, undefined, 'the tokenless writer reports no occurrence')
    assert.equal(harness.renderer().scopeFactCountForTest(), 0,
      'a tokenless write records no occurrence fact — settled without an occurrence stays stateless')

    // N07, now a test and not just a code fact: a DISPOSED mount must refuse a
    // late kernel commit. It has to be aimed at an occurrence that is still
    // LIVE and UNSETTLED while the scope is still OPEN — settling an already
    // closed scope early-returns for its own reason and would prove nothing.
    // So the last Enter allocates its token in the mount and the writer is told
    // to leave it unsettled; only then is the mount disposed.
    harness.surface.display.beginInputHistoryScope('late-owner')
    persistSubmissions = false
    await enterDraft(harness, submitted, 'left unsettled')
    const lateToken = submitted[3]!.scopeToken
    assert.equal(typeof lateToken, 'number', 'the reopened scope allocated the late occurrence')
    assert.equal(harness.renderer().scopeFactCountForTest(), 0,
      'that occurrence is live and UNSETTLED before the disposal')
    await harness.dispose()
    harness.surface.display.settleScopeInput({
      token: lateToken,
      owner: 'late-owner',
      outcome: 'written',
      text: 'left unsettled',
    })
    assert.equal(harness.renderer().scopeFactCountForTest(), 0,
      'a disposed mount refuses the late settlement instead of reopening recall state')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── Canonical Full/Compact transcript modes on the mounted production renderer ──

/** The folded node shape the shared pane helper actually returns. */
interface ModeWireNode {
  readonly id: string
  readonly k: string
  readonly p: Record<string, unknown>
  readonly c?: ModeWireNode[]
}

/** The live wire node set of the mounted base surface. */
function mountedNodes(harness: Harness): ModeWireNode[] {
  return wireNodes({ frames: () => harness.tern.frames }) as unknown as ModeWireNode[]
}

const mountedSections = (harness: Harness): ModeWireNode[] => mountedNodes(harness).filter(node => node.k === 'section')

/** The real SDK node id of the first Compact Activity section. */
function firstActivityId(harness: Harness): string {
  const section = mountedSections(harness).find(node => node.p['collapsible'] === true)
  assert.ok(section !== undefined, 'the frame carries a collapsible Activity section')
  return section.id
}

/** Drive one canonical two-Work turn through the REAL event route. */
function routeTwoWorkTurn(harness: Harness): void {
  harness.route(ev('turn/start', { turn: 1 }, 0))
  harness.route(userMessage(1, 'inspect the repository'))
  harness.route(ev('assistant/message', {
    turn: 1, step: 0,
    message: {
      id: MessageId('think-a'), role: 'assistant',
      content: [{ type: 'reasoning', text: 'reading the structure first' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
      stream: [
        { type: 'chunk', time: T0 + 2, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        { type: 'chunk', time: T0 + 4000, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'reading the structure first' } } },
      ],
    },
  }, 2))
  harness.route(toolCall(3, 'call-read'))
  harness.route(toolResult(4, 'call-read', 'the file body'))
  harness.route(ev('assistant/message', {
    turn: 1, step: 1,
    message: { id: MessageId('mid-1'), role: 'assistant', content: [{ type: 'text', text: 'intermediate narration' }], source: { kind: 'model', provider: 'p', model: 'm' }, stream: [] },
  }, 5))
  harness.route(ev('tool/call', { turn: 1, step: 2, callId: ToolCallId('call-bash'), name: 'bash', arguments: '{"command":"echo hi"}' }, 6))
  harness.route(ev('tool/result', {
    turn: 1, step: 2,
    message: { id: MessageId('result-bash'), role: 'tool', toolCallId: ToolCallId('call-bash'), content: [{ type: 'text', text: 'hi' }], source: { kind: 'tool', callId: ToolCallId('call-bash') } },
  }, 7))
  harness.route(ev('assistant/message', {
    turn: 1, step: 3,
    message: { id: MessageId('final-1'), role: 'assistant', content: [{ type: 'text', text: 'the final answer' }], source: { kind: 'model', provider: 'p', model: 'm' }, stream: [] },
  }, 8))
  harness.route(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 9))
  harness.surface.paintNow()
}

const nodeText = (node: ModeWireNode): string => {
  const parts: string[] = []
  const visit = (current: ModeWireNode): void => {
    if (typeof current.p['text'] === 'string') parts.push(current.p['text'])
    for (const child of current.c ?? []) visit(child)
  }
  visit(node)
  return parts.join(' ')
}

test('current User and Assistant native Copy actions use the same injected clipboard sink once each', async () => {
  const copied: string[] = []
  const harness = await mountTspHarness({
    displayState: { preset: 'full' },
    copyVisual: async text => { copied.push(text); return true },
  })
  try {
    harness.surface.bindRendererInput()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'question  with raw spacing\n'))
    harness.route(assistantMessage(2, 'answer-1', 'answer  bytes\n'))
    harness.route(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3))
    harness.surface.paintNow()
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'message'), 'the native User message')

    const user = mountedNodes(harness).find(node => node.k === 'message' && node.p['role'] === 'dsh.transcript.user')
    const userAction = (user?.p['actions'] as Array<{ readonly act?: string }> | undefined)?.find(action => action.act === 'dsh-transcript-copy')
    assert.ok(user && userAction, 'the actual wire message carries the custom action')
    const sf = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'action', sf, id: user.id, act: userAction.act, raw: {} })
    await awaitWireFact(() => copied.length === 1, 'the User Copy sink call')
    assert.equal(copied[0], 'question  with raw spacing\n')

    const button = mountedNodes(harness).find(node => node.k === 'button' && node.p['role'] === 'dsh.transcript.copy')
    assert.ok(button, 'the Assistant footer has a real native button node')
    assert.deepEqual(button.p['actions'], { click: 'dsh-transcript-copy' })
    harnessFreeInput(harness.tern, {
      ev: 'action', sf: harness.tern.frames.at(-1)!.sf, id: button.id, act: 'dsh-transcript-copy', raw: {},
    })
    await awaitWireFact(() => copied.length === 2, 'the Assistant Copy sink call')
    assert.equal(copied[1], 'answer  bytes\n')
    assert.equal(copied.length, 2, 'one real SDK action invokes exactly one injected clipboard callback')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a modal-covered or retired transcript Copy node performs no clipboard write', async () => {
  const copied: string[] = []
  const harness = await mountTspHarness({
    displayState: { preset: 'full' },
    copyVisual: async text => { copied.push(text); return true },
  })
  try {
    harness.surface.bindRendererInput()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'subject A prompt'))
    harness.surface.paintNow()
    await awaitWireFact(() => mountedNodes(harness).some(node => node.p['role'] === 'dsh.transcript.user'), 'subject A Copy node')
    const oldUser = mountedNodes(harness).find(node => node.p['role'] === 'dsh.transcript.user')!
    const pending = harness.renderer().interaction.askQuestions([{ id: 'copy-modal', question: 'Continue?' }], undefined, undefined, false)
    pending.catch(() => {})
    await awaitWireFact(() => harness.tern.output.text().includes('Continue?'), 'the real Question seat')
    // Bounded negative observation: a covered Copy has no completion signal,
    // so drain the event loop for a bounded window before observing the sink.
    harnessFreeInput(harness.tern, {
      ev: 'action', sf: harness.tern.frames.at(-1)!.sf, id: oldUser.id, act: 'dsh-transcript-copy', raw: {},
    })
    await settle() // bounded negative observation window: no observable completion event exists
    assert.equal(copied.length, 0, 'a Question modal blocks the underlying action')
    harness.renderer().interaction.withdrawPending()
    await pending.catch(() => {})

    harness.surface.display.beginSessionHydration()
    await settle() // bounded negative observation window: hydration emits no completion event for a rejected id
    harnessFreeInput(harness.tern, {
      ev: 'action', sf: harness.tern.frames.at(-1)!.sf, id: oldUser.id, act: 'dsh-transcript-copy', raw: {},
    })
    await settle() // bounded negative observation window: a retired frame id has no completion event
    assert.equal(copied.length, 0, 'hydration rejects the retired frame node')

    harness.replaceMain()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'subject B prompt'))
    harness.surface.paintNow()
    await awaitWireFact(() => mountedNodes(harness).some(node => nodeText(node).includes('subject B prompt')), 'subject B frame')
    const newUser = mountedNodes(harness).find(node => node.p['role'] === 'dsh.transcript.user')!
    assert.notEqual(newUser.id, oldUser.id, 'a new source receives a distinct node namespace')
    harnessFreeInput(harness.tern, {
      ev: 'action', sf: harness.tern.frames.at(-1)!.sf, id: oldUser.id, act: 'dsh-transcript-copy', raw: {},
    })
    await settle() // bounded negative observation window: an old source id has no completion event
    assert.equal(copied.length, 0, 'an old source node id cannot copy subject B')
    harnessFreeInput(harness.tern, {
      ev: 'action', sf: harness.tern.frames.at(-1)!.sf, id: newUser.id, act: 'dsh-transcript-copy', raw: {},
    })
    await awaitWireFact(() => copied.length === 1, 'subject B current Copy action')
    assert.equal(copied[0], 'subject B prompt')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('inner Thinking, Context and Tool toggles use the exact current node owner and respect covered or retired seats', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'full' }, nativeImages: true })
  try {
    harness.surface.bindRendererInput()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'inspect all transcript details'))
    harness.route(ev('assistant/message', {
      turn: 1, step: 0,
      message: {
        id: MessageId('inner-thinking'), role: 'assistant',
        content: [{ type: 'reasoning', text: 'first reasoning line\nlatest reasoning line' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
        stream: [
          { type: 'chunk', time: T0 + 2, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
          { type: 'chunk', time: T0 + 3, chunk: { type: 'reasoning-delta', index: 0, text: 'first reasoning line\nlatest reasoning line' } },
          { type: 'chunk', time: T0 + 4, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'first reasoning line\nlatest reasoning line' } } },
        ],
      },
    }, 2))
    harness.route(toolCall(3, 'inner-read'))
    harness.route(toolResult(4, 'inner-read', 'full tool result'))
    harness.route(contextEvent(5, 'inner-snapshot-a', 'first hidden context', 'first label'))
    harness.route(contextEvent(6, 'inner-snapshot-b', 'second hidden context', 'second label'))
    harness.route(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 7))
    harness.surface.paintNow()
    await awaitWireFact(() => mountedNodes(harness).some(node => String(node.p['text'] ?? '').includes('latest reasoning line')),
      'the Full Thinking Section head')

    const current = (): ModeWireNode[] => mountedNodes(harness)
    // A queued SIGNAL hint from an earlier commit (`settle`) or the caret
    // re-assertion after a modal retires (`focus`) may flush on the next ack;
    // neither paints content, so the frame witness counts only frames that
    // carry a real CONTENT op.
    const painted = (): number => harness.tern.frames.filter(frame => frame.ops.some(op => op[0] !== 'settle' && op[0] !== 'focus')).length
    const byKey = (needle: string): ModeWireNode | undefined => current().find(node => node.k === 'section' && String(node.p['key']).includes(needle))
    const thinking = byKey('msg-')
    assert.ok(thinking !== undefined && nodeText(thinking).includes('latest reasoning line'))
    assert.equal(thinking.p['collapsed'], true)
    assert.equal(current().some(node => node.id === `${thinking.id}.body`), false)
    const tool = current().find(node => node.k === 'tool' && node.p['name'] === 'read')
    assert.ok(tool !== undefined)
    assert.equal(tool.p['collapsed'], true)
    assert.equal(current().some(node => node.id === `${tool.id}.result`), false)
    const cluster = byKey('ctx-')
    assert.ok(cluster !== undefined)
    assert.equal(cluster.p['collapsed'], true)
    assert.equal(current().some(node => node.p['text'] === 'first hidden context'), false)

    const sf = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: thinking.id, collapsed: false, raw: {} })
    await awaitWireFact(() => current().some(node => node.id === `${thinking.id}.body`), 'the Thinking body after exact toggle')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: cluster.id, collapsed: false, raw: {} })
    await awaitWireFact(() => current().filter(node => node.k === 'section'
      && (node.p['head'] === 'first label · ambient' || node.p['head'] === 'second label · ambient')).length === 2,
    'the two canonical Context member Sections after the Cluster opens')
    const memberOf = (head: string): ModeWireNode => {
      const node = current().find(entry => entry.k === 'section' && entry.p['head'] === head)
      assert.ok(node !== undefined, `the current member Section exists: ${head}`)
      return node
    }
    const memberA = memberOf('first label · ambient')
    const memberB = memberOf('second label · ambient')
    assert.ok(memberA.id !== memberB.id, 'each Cluster member has its own exact node id')
    for (const member of [memberA, memberB]) {
      assert.equal(member.p['collapsible'], true)
      assert.equal(member.p['collapsed'], true, 'a member body starts independently closed')
      assert.equal(current().some(node => node.id === `${member.id}.body`), false)
    }
    assert.equal(current().some(node => node.p['text'] === 'first hidden context'), false,
      'opening the canonical Cluster alone materializes no member body')
    const memberBodies = (): { readonly a: boolean; readonly b: boolean } => ({
      a: current().some(node => node.id === `${memberA.id}.body` && node.p['text'] === 'first hidden context'),
      b: current().some(node => node.id === `${memberB.id}.body` && node.p['text'] === 'second hidden context'),
    })
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: memberA.id, collapsed: false, raw: {} })
    await awaitWireFact(() => memberBodies().a, 'the exact member A body after its own toggle')
    assert.deepEqual(memberBodies(), { a: true, b: false }, 'member A opens without opening B')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: memberB.id, collapsed: false, raw: {} })
    await awaitWireFact(() => memberBodies().b, 'the exact member B body after its own toggle')
    assert.deepEqual(memberBodies(), { a: true, b: true }, 'both members are independently open')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: memberA.id, collapsed: true, raw: {} })
    await awaitWireFact(() => !memberBodies().a, 'closing member A retires only its own body')
    assert.deepEqual(memberBodies(), { a: false, b: true }, 'member B keeps its own open state')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: cluster.id, collapsed: true, raw: {} })
    await awaitWireFact(() => current().every(node => node.id !== memberA.id && node.id !== memberB.id),
      'closing the Cluster retires both member nodes')
    // A stale member id under the closed ancestor names no current contribution.
    const framesWithClusterClosed = painted()
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: memberA.id, collapsed: false, raw: {} })
    // Bounded negative observation: a stale member id must paint no frame.
    await settle()
    assert.equal(painted(), framesWithClusterClosed, 'a stale member id under a closed Cluster paints no frame')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: cluster.id, collapsed: false, raw: {} })
    await awaitWireFact(() => current().some(node => node.id === memberB.id), 'the same Cluster reopens')
    assert.equal(current().find(node => node.id === memberA.id)?.p['collapsed'], true,
      'reopening the Cluster restores member A closed')
    assert.equal(current().find(node => node.id === memberB.id)?.p['collapsed'], false,
      'reopening the Cluster restores member B open')
    assert.deepEqual(memberBodies(), { a: false, b: true }, 'the member preference survives the Cluster close/open cycle')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: memberA.id, collapsed: false, raw: {} })
    await awaitWireFact(() => memberBodies().a, 'member A reopens independently again')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: tool.id, collapsed: false, raw: {} })
    await awaitWireFact(() => current().some(node => node.id === `${tool.id}.result`), 'the exact Tool result body')

    const stableIds = [thinking.id, cluster.id, tool.id, memberA.id, memberB.id]
    harness.route(ev('user/message', { id: MessageId('inner-followup'), role: 'user', content: [{ type: 'text', text: 'same Source follow-up' }], source: { kind: 'user' } }, 8))
    harness.surface.paintNow()
    await awaitWireFact(() => current().some(node => nodeText(node).includes('same Source follow-up')), 'a later same-source projection')
    for (const id of stableIds) assert.ok(current().some(node => node.id === id), `the streaming/formal commit keeps inner id ${id}`)
    assert.equal(current().find(node => node.id === thinking.id)?.p['collapsed'], false, 'the opened Thinking stays open')
    assert.equal(current().find(node => node.id === cluster.id)?.p['collapsed'], false, 'the opened Cluster stays open')
    assert.equal(current().find(node => node.id === tool.id)?.p['collapsed'], false, 'the opened Tool stays open')
    assert.equal(current().find(node => node.id === memberA.id)?.p['collapsed'], false, 'member A stays open')
    assert.equal(current().find(node => node.id === memberB.id)?.p['collapsed'], false, 'member B stays open')
    assert.deepEqual(memberBodies(), { a: true, b: true }, 'the same-source update keeps both member bodies')

    const pending = harness.renderer().interaction.askQuestions([{ id: 'inner-seat-q', question: 'Proceed?' }], undefined, undefined, false)
    pending.catch(() => {})
    await awaitWireFact(() => harness.tern.output.text().includes('Proceed?'), 'the current modal seat')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: thinking.id, collapsed: true, raw: {} })
    // Bounded negative observation: a modal-covered pointer must paint no late frame.
    await settle()
    const openedThinking = current().find(node => node.id === thinking.id)
    assert.equal(openedThinking?.p['collapsed'], false,
      'a covered toggle does not mutate the manual owner')
    assert.equal(current().some(node => node.id === `${thinking.id}.body`), true,
      'the covered close does not remove the Thinking body')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: memberA.id, collapsed: true, raw: {} })
    // Bounded negative observation: a covered member toggle must paint no frame.
    await settle()
    assert.equal(current().find(node => node.id === memberA.id)?.p['collapsed'], false,
      'a covered member toggle does not mutate the member owner')
    assert.deepEqual(memberBodies(), { a: true, b: true }, 'the covered member close keeps its body')
    harness.renderer().interaction.withdrawPending()
    await pending.catch(() => {})

    const oldIds = [...stableIds]
    harness.surface.display.beginSessionHydration()
    await awaitWireFact(() => current().some(node => nodeText(node).includes('Loading session')), 'the source retirement frame')
    const framesDuringHydration = painted()
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: oldIds[0]!, collapsed: true, raw: {} })
    // Bounded negative observation: a hydration-retired id must paint no frame.
    await settle()
    assert.equal(painted(), framesDuringHydration, 'a retired exact node id is rejected during hydration')
    harness.replaceMain()
    harness.route(ev('turn/start', { turn: 1 }, 20))
    harness.route(userMessage(21, 'incoming source'))
    harness.route(ev('assistant/message', {
      turn: 1, step: 0,
      message: { id: MessageId('incoming-thinking'), role: 'assistant', content: [{ type: 'reasoning', text: 'incoming reasoning' }], source: { kind: 'model', provider: 'p', model: 'm' }, stream: [] },
    }, 22))
    harness.surface.paintNow()
    await awaitWireFact(() => current().some(node => node.p['text'] === 'incoming source'), 'the replacement subject frame')
    const incomingThinking = current().find(node => node.k === 'section' && nodeText(node).includes('incoming reasoning'))
    assert.ok(incomingThinking !== undefined)
    assert.equal(incomingThinking.p['collapsed'], true, 'the new Source starts with no inherited inner expansion')
    const beforeLate = painted()
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: oldIds[1]!, collapsed: true, raw: {} })
    // Bounded negative observation: a retired Context Cluster id must paint no late frame.
    await settle()
    assert.equal(painted(), beforeLate, 'a retired Context cluster id cannot act on the new Source')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: oldIds[3]!, collapsed: false, raw: {} })
    // Bounded negative observation: a retired Cluster member id must paint no late frame.
    await settle()
    assert.equal(painted(), beforeLate, 'a retired Cluster member id cannot act on the new Source')
    assert.equal(current().some(node => node.p['text'] === 'incoming reasoning'), true)
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

/** One canonical surfaced Context event with its producer form/label. */
function contextEvent(seq: number, id: string, text: string, label: string): SessionEvent {
  return ev('user/message', {
    id: MessageId(id), role: 'user', content: [{ type: 'text', text }],
    source: { kind: 'plugin', form: 'snapshot', plugin: label },
  }, seq)
}

test('Focus Context Row preferences survive same-source updates and preset round trips', async () => {
  const displayState: { preset: 'focus' | 'compact' | 'full' } = { preset: 'focus' }
  const harness = await mountTspHarness({ displayState })
  try {
    harness.surface.bindRendererInput()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'inspect persistent Focus context'))
    harness.route(assistantMessage(2, 'focus-context-narration', 'the Agent is checking the Context'))
    harness.route(contextEvent(3, 'focus-context-a', 'first Focus context body', 'runtime-context'))
    harness.route(contextEvent(4, 'focus-context-b', 'second Focus context body', 'runtime-context'))
    harness.surface.paintNow()
    await awaitWireFact(() => mountedSections(harness).some(node => String(node.p['key']).includes('focus-')),
      'the canonical Focus root materializes')
    const focusRoot = mountedSections(harness).find(node => String(node.p['key']).includes('focus-'))!
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: focusRoot.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).some(node => node.id === focusRoot.id && node.p['collapsed'] === false),
      'the canonical Focus root opens before its Context Rows are queried')
    const rows = mountedSections(harness).filter(node => node.p['head'] === 'runtime-context')
    const ids = rows.map(row => row.id)
    assert.equal(rows.length, 2, JSON.stringify({
      sections: mountedSections(harness).map(node => ({ id: node.id, p: node.p, children: node.c })),
    }))
    assert.ok(rows.every(row => row.p['collapsed'] === true), 'each Context Row starts with its own detail closed')
    for (const row of rows) {
      harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: row.id, collapsed: false, raw: {} })
      await awaitWireFact(() => mountedNodes(harness).some(node => node.id === `${row.id}.body`),
        `the exact Focus Context Row ${row.id} opens`)
    }
    assert.ok(mountedNodes(harness).some(node => node.p['text'] === 'first Focus context body'))
    assert.ok(mountedNodes(harness).some(node => node.p['text'] === 'second Focus context body'))

    for (const preset of ['full', 'compact'] as const) {
      displayState.preset = preset
      harness.surface.paintNow()
      await awaitWireFact(() => mountedSections(harness).some(node => String(node.p['key']).includes('ctx-')),
        `the ${preset} projection uses its canonical Cluster`)
      displayState.preset = 'focus'
      harness.surface.paintNow()
      await awaitWireFact(() => ids.every(id => mountedSections(harness).some(node => node.id === id)),
        'the same Focus Row occurrences return')
      for (const id of ids) {
        assert.equal(mountedSections(harness).find(node => node.id === id)?.p['collapsed'], false,
          `the ${preset} round trip keeps the loaded Row preference`)
        assert.ok(mountedNodes(harness).some(node => node.id === `${id}.body`))
      }
    }

    // A same-Source authoritative commit rebuilds canonical Work/Cluster
    // membership while Focus continues to present the same rows independently.
    harness.route(contextEvent(5, 'focus-context-c', 'third same-source Focus context', 'runtime-context'))
    const beforeReprojection = harness.tern.frames.length
    harness.surface.paintNow()
    await awaitWireFact(() => harness.tern.frames.length > beforeReprojection
      && mountedSections(harness).filter(node => node.p['head'] === 'runtime-context').length === 3, 'the same-source Focus context projection')
    for (const id of ids) {
      const row = mountedSections(harness).find(node => node.id === id)
      assert.equal(row?.p['collapsed'], false, `Focus keeps the same Context Row owner open: ${id}`)
      assert.ok(mountedNodes(harness).some(node => node.id === `${id}.body`), `the exact Context Row body remains mounted: ${id}`)
    }
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('an open live Thinking Section keeps one id and follows later reasoning through status commits', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'focus' } })
  try {
    harness.surface.bindRendererInput()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'inspect the live reasoning stream'))
    harness.route(ev('step/start', { turn: 1, step: 0 }, 2))
    harness.surface.applyAssistantInput({
      kind: 'chunk', sessionId: SESSION_ID, attemptId: 'live-thinking-owner', turn: 1, step: 0,
      time: T0 + 3, chunk: { type: 'reasoning-delta', index: 0, text: 'checking the first row\n' },
    } as never)
    harness.surface.paintNow()
    await awaitWireFact(() => mountedSections(harness).some(node => nodeText(node).includes('checking the first row')),
      'the first live reasoning prefix reaches a native Thinking Section')
    const root = mountedSections(harness).find(node => String(node.p['key']).includes('focus-'))!
    assert.equal(root.p['collapsed'], true)
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: root.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).some(node => node.id === root.id && node.p['collapsed'] === false),
      'the exact Focus Root opens before Work and Thinking are queried')
    const work = mountedSections(harness).find(node => String(node.p['key']).includes('work-'))!
    assert.equal(work.p['collapsed'], true)
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: work.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).some(node => node.id === work.id && node.p['collapsed'] === false),
      'the exact canonical Work opens before selecting the transient Thinking row')
    const firstThinking = mountedSections(harness).find(node => /^(?:s\d+-)?msg-\d+$/u.test(String(node.p['key']))
      && nodeText(node).includes('checking the first row'))!
    const thinkingId = firstThinking.id
    assert.equal(firstThinking.p['collapsed'], true)
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: thinkingId, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.id === `${thinkingId}.body`),
      'the exact live Thinking body opens before the next chunk')
    const firstBody = mountedNodes(harness).find(node => node.id === `${thinkingId}.body`)
    assert.equal(firstBody?.p['text'], 'checking the first row\n')
    assert.equal(firstBody?.p['stream'], true)

    harness.surface.applyAssistantInput({
      kind: 'chunk', sessionId: SESSION_ID, attemptId: 'live-thinking-owner', turn: 1, step: 0,
      time: T0 + 4, chunk: { type: 'reasoning-delta', index: 0, text: 'latest reasoning line' },
    } as never)
    harness.surface.paintNow()
    await awaitWireFact(() => mountedNodes(harness).some(node => node.id === `${thinkingId}.body`
      && String(node.p['text']).includes('latest reasoning line')),
    'the same open live body advances to the later reasoning delta')
    const secondBody = mountedNodes(harness).find(node => node.id === `${thinkingId}.body`)
    assert.equal(mountedSections(harness).find(node => node.id === thinkingId)?.p['collapsed'], false)
    assert.equal(secondBody?.p['text'], 'checking the first row\nlatest reasoning line')
    assert.equal(secondBody?.p['stream'], true)

    const rootTitle = (): string => String(mountedNodes(harness).find(node => node.id === `${root.id}.head.title`)?.p['text'] ?? '')
    const statusFrame = harness.tern.frames.length
    harness.surface.commitStatus({
      activity: { phase: 'waiting-question', busy: true, queuedCount: 0, taskCount: 0, childAgentCount: 0, todoCount: 0 },
    } as never, {}, undefined)
    await awaitWireFact(() => harness.tern.frames.length > statusFrame
      && rootTitle().includes('Waiting for input')
      && mountedSections(harness).some(node => node.id === thinkingId && node.p['collapsed'] === false),
    'a formal status commit changes the Focus phase without replacing the opened Thinking owner')
    assert.equal(mountedNodes(harness).find(node => node.id === `${thinkingId}.body`)?.p['text'],
      'checking the first row\nlatest reasoning line')
    const resumedFrame = harness.tern.frames.length
    harness.surface.commitStatus({
      activity: { phase: 'working', busy: true, queuedCount: 0, taskCount: 0, childAgentCount: 0, todoCount: 0 },
    } as never, {}, undefined)
    await awaitWireFact(() => harness.tern.frames.length > resumedFrame
      && rootTitle().includes('Working')
      && mountedSections(harness).some(node => node.id === thinkingId && node.p['collapsed'] === false),
    'the resumed working status keeps the exact expanded Thinking row')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('the SAME live DisplayState drives Full, Compact and Focus while preserving same-source Turn choice', async () => {
  const displayState: { preset: 'focus' | 'compact' | 'full' } = { preset: 'full' }
  const harness = await mountTspHarness({ displayState })
  const appendAssistant = (seq: number, id: string, text: string): void => {
    harness.route(ev('assistant/message', {
      turn: 1, step: seq,
      message: { id: MessageId(id), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' }, stream: [] },
    }, seq))
    harness.surface.paintNow()
  }
  try {
    harness.surface.bindRendererInput()
    routeTwoWorkTurn(harness)
    await awaitWireFact(() => mountedNodes(harness).some(node => nodeText(node).includes('the final answer')), 'the Full turn frame')
    assert.equal(mountedSections(harness).filter(node => String(node.p['key']).includes('work-') || String(node.p['key']).includes('focus-')).length, 0,
      'Full paints no Work/Activity or Focus root container')
    assert.ok(mountedNodes(harness).some(node => node.k === 'tool'), 'Full keeps the native Tool rows')

    // The authority is the SAME object the composition root owns: each mode
    // switch is observed by the next real transcript commit.
    displayState.preset = 'compact'
    appendAssistant(10, 'mode-compact', 'a later Compact commit')
    await awaitWireFact(() => mountedSections(harness).length === 2, 'the Compact Activity sections after the mode change')
    assert.ok(mountedSections(harness).every(section => section.p['collapsible'] === true && section.p['collapsed'] === true),
      'Compact defaults every canonical Work collapsed')

    displayState.preset = 'focus'
    appendAssistant(11, 'mode-focus', 'a later Focus commit')
    await awaitWireFact(() => mountedSections(harness).some(node => node.id.includes('focus-')), 'the Focus root after the mode change')
    const root = mountedSections(harness).find(node => node.id.includes('focus-'))!
    assert.equal(mountedSections(harness).filter(node => node.id.startsWith(`${root.id}.s1-work-`)).length, 0,
      'Focus Work is absent while the root is collapsed')
    const sf = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: root.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).find(node => node.id === root.id)?.p['collapsed'] === false,
      'the current Focus root opens')

    displayState.preset = 'full'
    appendAssistant(12, 'mode-full-again', 'a later Full commit')
    await awaitWireFact(() => mountedSections(harness).every(node =>
      !String(node.p['key']).includes('work-') && !String(node.p['key']).includes('focus-')),
    'Full has no remaining Work or Focus disclosure roots')
    assert.ok(mountedNodes(harness).some(node => node.k === 'tool'), 'Full restores flat Tool rows')

    displayState.preset = 'focus'
    appendAssistant(13, 'mode-focus-again', 'a later Focus commit')
    await awaitWireFact(() => mountedSections(harness).some(node => node.id === root.id && node.p['collapsed'] === false),
      'the same-source Focus choice survives Full and returns expanded')
    assert.ok(mountedSections(harness).some(node => node.id.startsWith(`${root.id}.s1-work-`)),
      'the expanded root restores its nested canonical Work sections')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a collapsed Compact Work image has no read/blob demand until expanded and never crosses source scopes', async () => {
  const scopeA = { scope: 'image-A' }
  const scopeB = { scope: 'image-B' }
  const attachment: ImageAttachmentRefLike = {
    attachmentId: 'att-compact-work', mediaType: 'image/png', bytes: 4, width: 2, height: 2, name: 'hidden.png',
  }
  const harness = await mountTspHarness({
    displayState: { preset: 'compact' },
    nativeImages: true,
    imageScope: scopeA,
    readImage: async (ref, scope) => ({ ref, data: new Uint8Array([scope === scopeA ? 1 : 2, 3, 4]) }),
  })
  const routeImageWork = (base: number): void => {
    harness.route(ev('turn/start', { turn: 1 }, base))
    harness.route(userMessage(base + 1, 'inspect the hidden image', `user-image-${base}`))
    const callId = `call-image-${base}`
    harness.route(ev('tool/call', { turn: 1, step: 0, callId: ToolCallId(callId), name: 'read_image', arguments: '{}' }, base + 2))
    harness.route(ev('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId(`result-image-${base}`), role: 'tool', toolCallId: ToolCallId(callId),
        content: [{ type: 'text', text: 'image result' }, { type: 'image', attachment }],
        source: { kind: 'tool', callId },
      },
    }, base + 3))
    harness.surface.paintNow()
  }
  try {
    harness.surface.bindRendererInput()
    routeImageWork(0)
    await awaitWireFact(() => mountedSections(harness).length === 1, 'the collapsed Activity containing the image Tool')
    assert.equal(harness.imageReads.length, 0, 'collapsed Work starts no attachment read')
    assert.equal(harness.tern.blobs.length, 0, 'collapsed Work sends no blob')
    assert.equal(mountedNodes(harness).filter(node => node.k === 'image').length, 0, 'the hidden member has no image node')

    const sectionA = mountedSections(harness)[0]!
    const sfA = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: sfA, id: sectionA.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'tool'), 'the Tool header after expanding Work A')
    const toolA = mountedNodes(harness).find(node => node.k === 'tool')!
    assert.equal(toolA.p['collapsed'], true, 'the Tool body has its own collapsed owner')
    assert.equal(harness.imageReads.length, 0, 'opening Work alone starts no hidden result read')
    const sfToolA = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: sfToolA, id: toolA.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'image'), 'the Tool image after its own disclosure opens')
    assert.deepEqual(harness.imageReads.map(read => [read.attachmentId, read.scope]), [['att-compact-work', scopeA]],
      'opening the exact Tool starts one read through the owning scope')
    assert.equal(harness.tern.blobs.length, 1, 'the expanded Tool sends one image blob')

    // An ordinary repaint of the same source keeps the visible Activity and
    // reuses the ImageLoader entry; neither the read nor the blob duplicates.
    harness.surface.paintNow()
    assert.equal(harness.imageReads.length, 1, 'same-source repaint does not re-read the image')
    assert.equal(harness.tern.blobs.length, 1, 'same-source repaint does not resend the blob')

    // Retire the expanded subject through the real generation/hydration path.
    harness.surface.display.beginSessionHydration()
    await awaitWireFact(() => harness.tern.output.text().includes('Loading session…'), 'the hydration fence')
    harness.setImageScope(scopeB)
    harness.replaceMain()
    routeImageWork(10)
    await awaitWireFact(() => mountedSections(harness).length === 1, 'the collapsed Activity for source B')
    assert.equal(mountedSections(harness)[0]!.p['collapsed'], true, 'source B starts with a retired Work disclosure state')
    assert.equal(harness.imageReads.length, 1, 'collapsed source B starts no second read')
    assert.strictEqual(harness.imageReads[0]?.scope, scopeA, 'the only read remains owned by source A')
    assert.equal(harness.tern.blobs.length, 1, 'the source switch sends no hidden or stale blob')
    assert.equal(mountedNodes(harness).filter(node => node.k === 'image').length, 0, 'source A image node is retired')

    const sectionB = mountedSections(harness)[0]!
    const sfB = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: sfB, id: sectionB.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'tool'), 'the new Source Tool header')
    const toolB = mountedNodes(harness).find(node => node.k === 'tool')!
    assert.equal(toolB.p['collapsed'], true, 'Source B does not inherit Source A Tool expansion')
    assert.equal(harness.imageReads.length, 1, 'opening only Source B Work starts no image read')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: toolB.id, collapsed: false, raw: {} })
    await awaitWireFact(() => harness.imageReads.length === 2, 'the source B Tool image read')
    assert.deepEqual(harness.imageReads.map(read => read.scope), [scopeA, scopeB], 'source B reads only under its own scope')
    await awaitWireFact(() => harness.tern.blobs.length === 2, 'the source B blob')
    await awaitWireFact(() => mountedNodes(harness).filter(node => node.k === 'image').length === 1, 'source B image frame')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})


test('a real toggle on the measured Activity node id expands exactly that Work, and a repeated target state is idempotent', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'compact' } })
  try {
    harness.surface.bindRendererInput()
    routeTwoWorkTurn(harness)
    await awaitWireFact(() => mountedSections(harness).length === 2, 'the two Compact Activity sections')
    const sections = mountedSections(harness)
    const first = sections[0]
    const second = sections[1]
    assert.ok(first !== undefined && second !== undefined, 'both Activity sections exist')
    const targetId = first.id
    const otherId = second.id
    assert.equal(mountedNodes(harness).filter(node => node.k === 'tool').length, 0, 'collapsed Activities build no Tool node')

    const sf = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: targetId, collapsed: false, key: targetId.slice(targetId.lastIndexOf('.') + 1), raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'tool'), 'the first Work Tool body after the real toggle')
    let current = mountedSections(harness)
    assert.equal(current.find(node => node.id === targetId)?.p['collapsed'], false, 'Work A is open')
    assert.equal(current.find(node => node.id === otherId)?.p['collapsed'], true, 'Work B is untouched')
    assert.equal(mountedNodes(harness).filter(node => node.k === 'tool').length, 1, 'only Work A materialized its Tool')

    // A repeated `collapsed:false` is the client's REPORTED target state: it
    // must not invert the local owner (no double toggle).
    const framesBefore = harness.tern.frames.length
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: targetId, collapsed: false, raw: {} })
    await settle() // bounded observation window: a refused toggle must paint no frame
    current = mountedSections(harness)
    assert.equal(current.find(node => node.id === targetId)?.p['collapsed'], false, 'the repeated expand did not collapse the Work')
    assert.equal(harness.tern.frames.length, framesBefore, 'an unchanged target state paints no new frame')

    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: targetId, collapsed: true, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).filter(node => node.k === 'tool').length === 0, 'the Work collapse retires its Tool node')
    assert.equal(mountedSections(harness).find(node => node.id === targetId)?.p['collapsed'], true, 'Work A is collapsed again')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('Focus root and nested Work toggles keep one semantic owner and reset only its children', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'focus' } })
  try {
    harness.surface.bindRendererInput()
    routeTwoWorkTurn(harness)
    await awaitWireFact(() => mountedSections(harness).some(node => node.id.includes('focus-')),
      'the native Focus root')
    const sections = mountedSections(harness)
    const root = sections.find(node => node.id.includes('focus-'))
    assert.ok(root !== undefined)
    assert.equal(sections.filter(node => node.id.startsWith(`${root.id}.work-`)).length, 0,
      'collapsed root has no nested Work nodes')
    assert.equal(root.p['collapsed'], true)
    assert.equal(sections.filter(node => !node.id.includes('.work-')).length, 1,
      'Focus paints one top-level disclosure root, not an Action sibling')

    const sf = harness.tern.frames.at(-1)!.sf
    const rootId = root.id
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: rootId, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).filter(node => node.id.startsWith(`${rootId}.s1-work-`)).length === 2,
      'the expanded Focus root Work children')
    assert.equal(mountedSections(harness).find(node => node.id === rootId)?.p['collapsed'], false,
      'the same root id opens')
    assert.equal(mountedNodes(harness).filter(node => node.k === 'tool').length, 0,
      'opening the root leaves both nested Work spans collapsed')

    const works = mountedSections(harness).filter(node => node.id.startsWith(`${rootId}.s1-work-`))
    const workA = works[0]!
    const workB = works[1]!
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: workB.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'tool' && node.id.startsWith(`${workB.id}.`)),
      'only Work B materializes its Tool')
    assert.equal(mountedSections(harness).find(node => node.id === workA.id)?.p['collapsed'], true,
      'Work A stays closed')
    assert.equal(mountedSections(harness).find(node => node.id === workB.id)?.p['collapsed'], false,
      'Work B has its own native disclosure owner')
    const toolB = mountedNodes(harness).find(node => node.k === 'tool' && node.id.startsWith(`${workB.id}.`))!
    const thinkingB = mountedSections(harness).find(node => node.id.startsWith(`${workB.id}.`) && nodeText(node).includes('Thinking'))!
    assert.equal(toolB.p['collapsed'], true, 'the Tool detail starts independently collapsed')
    assert.equal(thinkingB.p['collapsed'], true, 'Thinking starts independently collapsed')
    let currentSf = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: currentSf, id: toolB.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.id === `${toolB.id}.result`),
      'the exact Tool result after its own disclosure opens')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: thinkingB.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.id === `${thinkingB.id}.body`),
      'the exact Thinking body after its own disclosure opens')

    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: workB.id, collapsed: true, raw: {} })
    await awaitWireFact(() => mountedSections(harness).find(node => node.id === workB.id)?.p['collapsed'] === true,
      'closing Work B physically removes its inner rows')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: workB.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).find(node => node.id === thinkingB.id)?.p['collapsed'] === false,
      'reopening Work B restores its manual Thinking choice')
    assert.equal(mountedNodes(harness).find(node => node.id === toolB.id)?.p['collapsed'], false,
      'reopening Work B restores its manual Tool choice')

    const beforeRepeated = harness.tern.frames.length
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: rootId, collapsed: false, raw: {} })
    await settle() // bounded observation window: a repeated target state must paint no frame
    assert.equal(harness.tern.frames.length, beforeRepeated, 'a repeated root target is idempotent')

    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: rootId, collapsed: true, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).filter(node => node.k === 'tool').length === 0,
      'closing the root removes its Work Tool nodes')
    assert.equal(mountedSections(harness).find(node => node.id === rootId)?.p['collapsed'], true)
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: rootId, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).find(node => node.id === rootId)?.p['collapsed'] === false,
      'the same root reopens')
    const reopenedWorks = mountedSections(harness).filter(node => node.id.startsWith(`${rootId}.s1-work-`))
    assert.equal(reopenedWorks.length, 2)
    assert.ok(reopenedWorks.every(node => node.p['collapsed'] === true),
      'closing the root reset only its nested Work expansions')
    assert.equal(mountedNodes(harness).filter(node => node.k === 'tool').length, 0)
    const reopenedWorkB = reopenedWorks.find(node => node.id === workB.id)!
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: reopenedWorkB.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'tool' && node.id === toolB.id),
      'Work B rematerializes after its Root reopens')
    assert.equal(mountedNodes(harness).find(node => node.id === toolB.id)?.p['collapsed'], true,
      'Root close cleared the Tool body preference for its own Turn')
    assert.equal(mountedSections(harness).find(node => node.id === thinkingB.id)?.p['collapsed'], true,
      'Root close cleared the Thinking body preference for its own Turn')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

/** Two completed Focus turns with ordinary process, a semantic Context Cluster,
 *  a settled human-interaction Tool and a PTC parent/child. */
function routeFocusResetTurns(harness: Harness): void {
  harness.route(ev('turn/start', { turn: 1 }, 0))
  harness.route(userMessage(1, 'focus reset turn one', 'focus-reset-user-1'))
  harness.route(ev('assistant/message', {
    turn: 1, step: 0,
    message: {
      id: MessageId('focus-reset-think-1'), role: 'assistant',
      content: [{ type: 'reasoning', text: 'turn1 reasoning line' }],
      source: { kind: 'model', provider: 'p', model: 'm' }, stream: [],
    },
  }, 2))
  harness.route(ev('tool/call', { turn: 1, step: 0, callId: ToolCallId('focus-reset-read-1'), name: 'read', arguments: '{}' }, 3))
  harness.route(ev('tool/result', {
    turn: 1, step: 0,
    message: {
      id: MessageId('focus-reset-read-result-1'), role: 'tool', toolCallId: ToolCallId('focus-reset-read-1'),
      content: [{ type: 'text', text: 'turn1 read body' }], source: { kind: 'tool', callId: 'focus-reset-read-1' },
    },
  }, 4))
  harness.route(contextEvent(5, 'focus-reset-context-a', 'turn1 context A body', 'turn1-context-a'))
  harness.route(contextEvent(6, 'focus-reset-context-b', 'turn1 context B body', 'turn1-context-b'))
  harness.route(ev('tool/call', {
    turn: 1, step: 1, callId: ToolCallId('focus-reset-question-1'), name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ id: 'q1', question: 'Continue?', options: ['Yes'] }] }),
  }, 7))
  harness.route(ev('tool/result', {
    turn: 1, step: 1,
    message: {
      id: MessageId('focus-reset-question-result'), role: 'tool', toolCallId: ToolCallId('focus-reset-question-1'),
      content: [{ type: 'text', text: '{"answers":[]}' }], source: { kind: 'tool', callId: 'focus-reset-question-1' },
    },
  }, 8))
  harness.route(ev('tool/call', { turn: 1, step: 2, callId: ToolCallId('focus-reset-ptc-1'), name: 'run_code', arguments: '{}' }, 9))
  harness.route(ev('tool/ptc-dispatch-start', {
    rootCallId: ToolCallId('focus-reset-ptc-1'), parentCallId: ToolCallId('focus-reset-ptc-1'),
    subCallId: 'focus-reset-child-1', name: 'read', arguments: { file_path: 'turn1-child.ts' },
  }, 10))
  harness.route(ev('tool/result', {
    turn: 1, step: 2,
    message: {
      id: MessageId('focus-reset-ptc-result'), role: 'tool', toolCallId: ToolCallId('focus-reset-ptc-1'),
      content: [{ type: 'text', text: 'turn1 program output' }], source: { kind: 'tool', callId: 'focus-reset-ptc-1' },
    },
  }, 11))
  harness.route(ev('tool/ptc-dispatch', {
    rootCallId: ToolCallId('focus-reset-ptc-1'), parentCallId: ToolCallId('focus-reset-ptc-1'),
    subCallId: 'focus-reset-child-1', name: 'read', arguments: { file_path: 'turn1-child.ts' },
    isError: false, content: [{ type: 'text', text: 'turn1 child read body' }],
  }, 12))
  harness.route(ev('assistant/message', {
    turn: 1, step: 3,
    message: {
      id: MessageId('focus-reset-final-1'), role: 'assistant', content: [{ type: 'text', text: 'turn1 final answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' }, stream: [],
    },
  }, 13))
  harness.route(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 14))

  harness.route(ev('turn/start', { turn: 2 }, 20))
  harness.route(userMessage(21, 'focus reset turn two', 'focus-reset-user-2'))
  harness.route(ev('assistant/message', {
    turn: 2, step: 0,
    message: {
      id: MessageId('focus-reset-think-2'), role: 'assistant',
      content: [{ type: 'reasoning', text: 'turn2 reasoning line' }],
      source: { kind: 'model', provider: 'p', model: 'm' }, stream: [],
    },
  }, 22))
  harness.route(ev('tool/call', { turn: 2, step: 0, callId: ToolCallId('focus-reset-read-2'), name: 'read', arguments: '{}' }, 23))
  harness.route(ev('tool/result', {
    turn: 2, step: 0,
    message: {
      id: MessageId('focus-reset-read-result-2'), role: 'tool', toolCallId: ToolCallId('focus-reset-read-2'),
      content: [{ type: 'text', text: 'turn2 read body' }], source: { kind: 'tool', callId: 'focus-reset-read-2' },
    },
  }, 24))
  harness.route(ev('assistant/message', {
    turn: 2, step: 1,
    message: {
      id: MessageId('focus-reset-final-2'), role: 'assistant', content: [{ type: 'text', text: 'turn2 final answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' }, stream: [],
    },
  }, 25))
  harness.route(ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 26))
  harness.surface.paintNow()
}

test('closing and reopening a Compact Work keeps member and PTC-child manual owners', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'compact' } })
  try {
    harness.surface.bindRendererInput()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'compact disclosure memory', 'compact-memory-user'))
    harness.route(ev('assistant/message', {
      turn: 1, step: 0,
      message: {
        id: MessageId('compact-memory-think'), role: 'assistant',
        content: [{ type: 'reasoning', text: 'compact reasoning line' }],
        source: { kind: 'model', provider: 'p', model: 'm' }, stream: [],
      },
    }, 2))
    harness.route(toolCall(3, 'compact-memory-read'))
    harness.route(toolResult(4, 'compact-memory-read', 'compact read body'))
    harness.route(contextEvent(5, 'compact-memory-context-a', 'compact context A body', 'compact-context-a'))
    harness.route(contextEvent(6, 'compact-memory-context-b', 'compact context B body', 'compact-context-b'))
    harness.route(ev('tool/call', { turn: 1, step: 1, callId: ToolCallId('compact-memory-ptc'), name: 'run_code', arguments: '{}' }, 7))
    harness.route(ev('tool/ptc-dispatch-start', {
      rootCallId: ToolCallId('compact-memory-ptc'), parentCallId: ToolCallId('compact-memory-ptc'),
      subCallId: 'compact-memory-child', name: 'read', arguments: { file_path: 'compact-child.ts' },
    }, 8))
    harness.route(ev('tool/result', {
      turn: 1, step: 1,
      message: {
        id: MessageId('compact-memory-ptc-result'), role: 'tool', toolCallId: ToolCallId('compact-memory-ptc'),
        content: [{ type: 'text', text: 'compact program output' }], source: { kind: 'tool', callId: 'compact-memory-ptc' },
      },
    }, 9))
    harness.route(ev('tool/ptc-dispatch', {
      rootCallId: ToolCallId('compact-memory-ptc'), parentCallId: ToolCallId('compact-memory-ptc'),
      subCallId: 'compact-memory-child', name: 'read', arguments: { file_path: 'compact-child.ts' },
      isError: false, content: [{ type: 'text', text: 'compact child read body' }],
    }, 10))
    harness.route(ev('assistant/message', {
      turn: 1, step: 2,
      message: {
        id: MessageId('compact-memory-final'), role: 'assistant', content: [{ type: 'text', text: 'compact final answer' }],
        source: { kind: 'model', provider: 'p', model: 'm' }, stream: [],
      },
    }, 11))
    harness.route(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 12))
    harness.surface.paintNow()

    const section = (id: string): ModeWireNode | undefined => mountedSections(harness).find(node => node.id === id)
    const toolNode = (id: string): ModeWireNode | undefined => mountedNodes(harness).find(node => node.id === id)
    const toggle = (id: string, collapsed: boolean): void => {
      harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id, collapsed, raw: {} })
    }
    await awaitWireFact(() => mountedSections(harness).filter(node => String(node.p['key']).includes('work-')).length === 1,
      'the one Compact Activity section of the canonical Work run')
    const works = mountedSections(harness).filter(node => String(node.p['key']).includes('work-'))
    const workA = works[0]!
    if (workA.p['collapsed'] === true) toggle(workA.id, false)
    await awaitWireFact(() => section(workA.id)?.p['collapsed'] === false, 'the Compact Work opens')

    const thinking = mountedSections(harness).find(node =>
      node.id.startsWith(`${workA.id}.`) && node.k === 'section'
      && /^(?:s\d+-)?msg-\d+$/u.test(String(node.p['key'])) && nodeText(node).includes('compact reasoning line'))!
    const read = mountedNodes(harness).find(node => node.k === 'tool' && node.p['name'] === 'read'
      && node.id.startsWith(`${workA.id}.`))!
    const cluster = mountedSections(harness).find(node =>
      node.id.startsWith(`${workA.id}.`) && String(node.p['key']).includes('ctx-'))!
    assert.ok(thinking !== undefined && read !== undefined && cluster !== undefined)
    toggle(thinking.id, false)
    toggle(read.id, false)
    toggle(cluster.id, false)
    await awaitWireFact(() => mountedSections(harness).some(node =>
      node.id.startsWith(`${cluster.id}.`) && node.p['head'] === 'compact-context-a · ambient'), 'the Compact member headers')
    const memberA = mountedSections(harness).find(node =>
      node.id.startsWith(`${cluster.id}.`) && node.p['head'] === 'compact-context-a · ambient')!
    const memberB = mountedSections(harness).find(node =>
      node.id.startsWith(`${cluster.id}.`) && node.p['head'] === 'compact-context-b · ambient')!
    toggle(memberA.id, false)
    await awaitWireFact(() => toolNode(`${memberA.id}.body`) !== undefined, 'the Compact member A body')

    const parent = mountedNodes(harness).find(node => node.k === 'tool' && node.p['name'] === 'run_code'
      && node.id.startsWith(`${workA.id}.`))!
    assert.ok(parent !== undefined)
    toggle(parent.id, false)
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'tool'
      && node.id.startsWith(`${parent.id}.`) && node.id.endsWith('.sub-compact-memory-child')), 'the Compact PTC child')
    const child = mountedNodes(harness).find(node => node.k === 'tool'
      && node.id.startsWith(`${parent.id}.`) && node.id.endsWith('.sub-compact-memory-child'))!
    toggle(child.id, false)
    await awaitWireFact(() => toolNode(`${child.id}.result`) !== undefined, 'the Compact PTC child body')

    // Close and reopen the enclosing Work: nothing below it loses its own
    // manual owner (the Tool parent close/reopen preserves its child too).
    toggle(workA.id, true)
    await awaitWireFact(() => section(workA.id)?.p['collapsed'] === true, 'Work A closes')
    toggle(workA.id, false)
    await awaitWireFact(() => section(workA.id)?.p['collapsed'] === false, 'Work A reopens')
    assert.equal(section(thinking.id)?.p['collapsed'], false, 'the Thinking preference survives the Work close')
    assert.equal(toolNode(read.id)?.p['collapsed'], false, 'the Tool preference survives the Work close')
    assert.equal(section(cluster.id)?.p['collapsed'], false, 'the Cluster preference survives the Work close')
    assert.equal(section(memberA.id)?.p['collapsed'], false, 'member A survives the Work close')
    assert.equal(toolNode(`${memberA.id}.body`) !== undefined, true)
    assert.equal(section(memberB.id)?.p['collapsed'], true, 'the sibling member stays closed')

    toggle(parent.id, true)
    await awaitWireFact(() => mountedNodes(harness).every(node => !node.id.startsWith(`${parent.id}.`)),
      'the closed PTC parent retires its child nodes')
    toggle(parent.id, false)
    await awaitWireFact(() => toolNode(`${parent.id}.result`) !== undefined, 'the PTC parent reopens')
    assert.equal(toolNode(child.id)?.p['collapsed'], false,
      'the PTC child keeps its manual disclosure through the parent close/reopen')
    assert.equal(toolNode(`${child.id}.result`) !== undefined, true, 'the child body follows its preserved owner')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('an explicit Focus root close resets only the process owners that root projects', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'focus' } })
  try {
    harness.surface.bindRendererInput()
    routeFocusResetTurns(harness)
    const section = (id: string): ModeWireNode | undefined => mountedSections(harness).find(node => node.id === id)
    const toolNode = (id: string): ModeWireNode | undefined => mountedNodes(harness).find(node => node.id === id)
    const toggle = (id: string, collapsed: boolean): void => {
      harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id, collapsed, raw: {} })
    }
    const waitState = async (id: string, collapsed: boolean, label: string): Promise<void> => {
      await awaitWireFact(() => section(id)?.p['collapsed'] === collapsed, label)
    }
    const painted = (): number => harness.tern.frames.filter(frame =>
      frame.ops.some(op => op[0] !== 'settle' && op[0] !== 'focus')).length
    const under = (rootId: string): ModeWireNode[] => mountedNodes(harness)
      .filter(node => node.id.startsWith(`${rootId}.`))
    const worksUnder = (rootId: string): ModeWireNode[] => mountedSections(harness)
      .filter(node => node.id.startsWith(`${rootId}.`) && String(node.p['key']).includes('work-'))

    await awaitWireFact(() => mountedSections(harness).filter(node => String(node.p['key']).includes('focus-')).length === 2,
      'the two canonical Focus roots')
    const roots = mountedSections(harness).filter(node => String(node.p['key']).includes('focus-'))
    const root1 = roots[0]!
    const root2 = roots[1]!
    toggle(root1.id, false)
    await waitState(root1.id, false, 'the first Focus root opens')
    toggle(root2.id, false)
    await waitState(root2.id, false, 'the second Focus root opens')

    await awaitWireFact(() => worksUnder(root1.id).length === 2, 'the two turn-1 Work spans')
    const works1 = worksUnder(root1.id)
    for (const work of works1) {
      if (work.p['collapsed'] === true) toggle(work.id, false)
    }
    await awaitWireFact(() => worksUnder(root1.id).every(node => node.p['collapsed'] === false),
      'both turn-1 Work spans open')

    const isThinkingSection = (node: ModeWireNode, line: string): boolean =>
      node.k === 'section' && /^(?:s\d+-)?msg-\d+$/u.test(String(node.p['key'])) && nodeText(node).includes(line)
    await awaitWireFact(() => mountedSections(harness).some(node => isThinkingSection(node, 'turn1 reasoning line')),
      'the turn-1 Thinking node')
    const thinking1 = mountedSections(harness).find(node => isThinkingSection(node, 'turn1 reasoning line'))!
    const workA = works1.find(work => thinking1.id.startsWith(`${work.id}.`))!
    assert.ok(workA !== undefined, 'the Thinking node belongs to a turn-1 Work')
    const workB = works1.find(work => work.id !== workA.id)!
    assert.ok(workB !== undefined, 'the PTC Work is the other turn-1 Work')
    toggle(thinking1.id, false)
    await awaitWireFact(() => toolNode(`${thinking1.id}.body`) !== undefined, 'the turn-1 Thinking body')
    const read1 = mountedNodes(harness).find(node => node.k === 'tool' && node.p['name'] === 'read'
      && node.id.startsWith(`${workA.id}.`))!
    assert.ok(read1 !== undefined)
    toggle(read1.id, false)
    await awaitWireFact(() => toolNode(`${read1.id}.result`) !== undefined, 'the turn-1 ordinary Tool body')

    const cluster1 = mountedSections(harness).find(node =>
      node.id.startsWith(`${workA.id}.`) && String(node.p['key']).includes('ctx-'))!
    assert.ok(cluster1 !== undefined)
    toggle(cluster1.id, false)
    await awaitWireFact(() => mountedSections(harness).some(node =>
      node.id.startsWith(`${cluster1.id}.`) && node.p['head'] === 'turn1-context-a · ambient'), 'the turn-1 member headers')
    const memberA = mountedSections(harness).find(node =>
      node.id.startsWith(`${cluster1.id}.`) && node.p['head'] === 'turn1-context-a · ambient')!
    const memberB = mountedSections(harness).find(node =>
      node.id.startsWith(`${cluster1.id}.`) && node.p['head'] === 'turn1-context-b · ambient')!
    toggle(memberA.id, false)
    await awaitWireFact(() => toolNode(`${memberA.id}.body`) !== undefined, 'the turn-1 member A body')
    assert.equal(section(memberB.id)?.p['collapsed'], true, 'member B stays independently closed')

    const question = mountedNodes(harness).find(node => node.k === 'tool' && node.p['name'] === 'ask_user_question')
    assert.ok(question !== undefined, 'the settled human-interaction Tool is a surfaced row')
    toggle(question.id, false)
    await awaitWireFact(() => toolNode(`${question.id}.result`) !== undefined, 'the settled interaction Tool body')

    const ptcParent = mountedNodes(harness).find(node => node.k === 'tool' && node.p['name'] === 'run_code'
      && node.id.startsWith(`${workB.id}.`))!
    assert.ok(ptcParent !== undefined)
    toggle(ptcParent.id, false)
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'tool'
      && node.id.startsWith(`${ptcParent.id}.`) && node.id.endsWith('.sub-focus-reset-child-1')), 'the PTC child')
    const ptcChild = mountedNodes(harness).find(node => node.k === 'tool'
      && node.id.startsWith(`${ptcParent.id}.`) && node.id.endsWith('.sub-focus-reset-child-1'))!
    toggle(ptcChild.id, false)
    await awaitWireFact(() => toolNode(`${ptcChild.id}.result`) !== undefined, 'the PTC child body')

    await awaitWireFact(() => worksUnder(root2.id).length === 1, 'the turn-2 Work span')
    const work2 = worksUnder(root2.id)[0]!
    if (work2.p['collapsed'] === true) toggle(work2.id, false)
    await awaitWireFact(() => section(work2.id)?.p['collapsed'] === false, 'the turn-2 Work opens')
    const thinking2 = mountedSections(harness).find(node =>
      node.id.startsWith(`${work2.id}.`) && node.k === 'section'
      && /^(?:s\d+-)?msg-\d+$/u.test(String(node.p['key'])) && nodeText(node).includes('turn2 reasoning line'))!
    const read2 = mountedNodes(harness).find(node => node.k === 'tool' && node.p['name'] === 'read'
      && node.id.startsWith(`${work2.id}.`))!
    toggle(thinking2.id, false)
    await awaitWireFact(() => toolNode(`${thinking2.id}.body`) !== undefined, 'the turn-2 Thinking body')
    toggle(read2.id, false)
    await awaitWireFact(() => toolNode(`${read2.id}.result`) !== undefined, 'the turn-2 Tool body')

    // The user explicitly closes the FIRST root. Its Work/Thinking/ordinary
    // Tool roots reset; its independent Context, settled interaction and PTC
    // child owners, plus the whole second Turn, keep their manual state.
    toggle(root1.id, true)
    await waitState(root1.id, true, 'the first Focus root closes')
    await awaitWireFact(() => [thinking1.id, read1.id, cluster1.id, question.id]
      .every(id => mountedNodes(harness).every(node => node.id !== id)),
    'the closed root retires its inner nodes')
    assert.deepEqual(under(root2.id).filter(node => node.id === thinking2.id)
      .map(node => node.p['collapsed']), [false], 'the other Turn Thinking stays open')
    assert.deepEqual(under(root2.id).filter(node => node.id === read2.id)
      .map(node => node.p['collapsed']), [false], 'the other Turn Tool stays open')
    assert.deepEqual(under(root2.id).filter(node => node.id === work2.id)
      .map(node => node.p['collapsed']), [false], 'the other Turn Work stays open')
    const closedFrames = painted()
    toggle(thinking1.id, true)
    // Bounded negative observation: a stale inner id must paint no frame.
    await settle()
    assert.equal(painted(), closedFrames, 'a stale inner id under the closed root paints no frame')

    toggle(root1.id, false)
    await waitState(root1.id, false, 'the first Focus root reopens')
    await awaitWireFact(() => toolNode(question.id) !== undefined, 'the reopened root materializes its persistent rows')
    await awaitWireFact(() => toolNode(question.id)?.p['collapsed'] === false
      && toolNode(`${question.id}.result`) !== undefined,
    'the settled interaction Tool keeps its open preference without its root-hidden Work')
    assert.deepEqual(worksUnder(root1.id).map(node => node.p['collapsed']), [true, true],
      'the explicit root close reset both owned Work owners')
    assert.equal(under(root1.id).some(node => node.id === thinking1.id), false,
      'a collapsed Work materializes no Thinking node')

    const reopenedWorkA = section(workA.id)!
    toggle(reopenedWorkA.id, false)
    await waitState(reopenedWorkA.id, false, 'the first Work reopens')
    assert.equal(section(thinking1.id)?.p['collapsed'], true, 'the root close reset the owned Thinking owner')
    assert.equal(toolNode(read1.id)?.p['collapsed'], true, 'the root close reset the owned ordinary Tool root')
    assert.equal(section(cluster1.id)?.p['collapsed'], false, 'the independent Context Cluster keeps its preference')
    assert.equal(section(memberA.id)?.p['collapsed'], false, 'the independent Context member keeps its preference')
    assert.equal(toolNode(`${memberA.id}.body`) !== undefined, true)
    assert.equal(section(memberB.id)?.p['collapsed'], true, 'the closed sibling member is unchanged')

    const reopenedWorkB = section(workB.id)!
    toggle(reopenedWorkB.id, false)
    await waitState(reopenedWorkB.id, false, 'the second Work reopens')
    assert.equal(toolNode(ptcParent.id)?.p['collapsed'], true, 'the root close reset the PTC parent root')
    toggle(ptcParent.id, false)
    await awaitWireFact(() => toolNode(`${ptcParent.id}.result`) !== undefined, 'the PTC parent body reopens')
    assert.equal(toolNode(ptcChild.id)?.p['collapsed'], false,
      'the PTC child keeps its own disclosure owner through the parent/root reset')
    assert.equal(toolNode(`${ptcChild.id}.result`) !== undefined, true,
      'the PTC child body is readable again with its preserved preference')

    assert.equal(section(work2.id)?.p['collapsed'], false, 'the other Turn Work is still open')
    assert.equal(toolNode(`${thinking2.id}.body`) !== undefined, true, 'the other Turn Thinking body is still visible')
    assert.equal(toolNode(`${read2.id}.result`) !== undefined, true, 'the other Turn Tool body is still visible')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a TSP Main ignores a virtual history anchor and retains its latest live Preparing', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'focus' } })
  try {
    harness.surface.bindRendererInput()
    routeTwoWorkTurn(harness)
    harness.route(ev('turn/start', { turn: 2 }, 10))
    harness.route(userMessage(11, 'prepare the next operation', 'user-live-turn-2'))
    harness.route(ev('step/start', { turn: 2, step: 0 }, 12))
    harness.surface.applyAssistantInput({
      kind: 'chunk', sessionId: SESSION_ID, attemptId: 'history-live-preparing', turn: 2, step: 0,
      time: T0 + 13,
      chunk: { type: 'tool-call-delta', index: 0, id: 'history-live-bash', name: 'bash', argumentsDelta: '{"command":"echo pending"}' },
    } as never)
    harness.surface.paintNow()
    await awaitWireFact(() => mountedNodes(harness).some(node => String(node.p['text'] ?? '').includes('Preparing Bash')),
      'the live Preparing summary at the latest loaded document tail')
    const latestNodes = mountedNodes(harness)
    assert.equal(harness.windowSnapshot().hasNewer, false, 'the same Folder controller proves this is latest')
    assert.ok(latestNodes.some(node => node.p['text'] === 'prepare the next operation'),
      'the latest loaded document contains the current live turn')
    assert.ok(latestNodes.some(node => String(node.p['text'] ?? '').includes('Preparing Bash')),
      'the latest Root carries the current Preparing summary')
    const sf = harness.tern.frames.at(-1)!.sf
    const currentRoot = mountedSections(harness).at(-1)!
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: currentRoot.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.id.includes('preparing-history-live-bash')),
      'the live Preparing row inside its opened Root')

    const rootId = currentRoot.id
    assert.equal(harness.selectHistoryTurn(1), true, 'the production window controller selects the earlier turn')
    assert.equal(harness.windowSnapshot().mode, 'history', 'the production controller owns a history selection')
    assert.equal(harness.windowSnapshot().hasNewer, true, 'the selected Folder window proves newer turns exist')
    harness.surface.paintNow()
    // The SDK emits no frame for this identical loaded node tree; this bounded
    // observation window lets its synchronous input/write path drain before the live-set negative assertions.
    await settle()
    const historyNodes = mountedNodes(harness)
    assert.ok(historyNodes.some(node => node.p['text'] === 'inspect the repository'),
      'the earlier loaded User remains on the same Main')
    assert.ok(historyNodes.some(node => node.p['text'] === 'prepare the next operation'),
      'the virtual history anchor cannot remove the latest loaded User')
    const livePreparingRows = historyNodes.filter(node => node.k === 'row'
      && node.id.includes('preparing-history-live-bash'))
    assert.equal(livePreparingRows.length, 1,
      'the authorized live Preparing remains one row under the same source and Root id')
    assert.ok(livePreparingRows[0]!.id.startsWith(`${rootId}.`), 'the Preparing row remains inside the original Root')
    assert.ok(historyNodes.some(node => node.id === rootId), 'the existing Focus Root id remains mounted')
    assert.ok(historyNodes.some(node => String(node.p['text'] ?? '').includes('Preparing Bash')),
      'history metadata cannot suppress the current Preparing summary')
    assert.ok(!historyNodes.some(node => nodeText(node).includes('Earlier turns')),
      'the application does not synthesize a window summary for TSP Main')
    assert.equal(harness.tern.frames.at(-1)!.sf, sf, 'the same native Main surface remains current')

    assert.equal(harness.selectLatestWindow(), true, 'the production window controller resumes the latest tail')
    harness.surface.paintNow()
    // This selection also projects an identical tree, so the SDK may send zero
    // ops; the bounded drain observes the live node set without requiring a frame.
    await settle()
    const latestAgain = mountedNodes(harness)
    assert.ok(latestAgain.some(node => node.p['text'] === 'inspect the repository'))
    assert.ok(latestAgain.some(node => node.p['text'] === 'prepare the next operation'))
    assert.ok(latestAgain.some(node => node.id === rootId), 'returning to latest does not mint a new Root id')
    assert.ok(latestAgain.some(node => String(node.p['text'] ?? '').includes('Preparing Bash')),
      'the live Preparing remains mounted without an application-level Follow command')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: rootId, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.id.includes('preparing-history-live-bash')),
      'the same live Preparing row remains inside its original Root')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a Compact TSP Main keeps its current Work preview while the virtual window is anchored in history', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'compact' } })
  try {
    harness.surface.bindRendererInput()
    for (let turn = 1; turn <= 25; turn += 1) {
      const seq = (turn - 1) * 3
      harness.route(ev('turn/start', { turn }, seq))
      harness.route(userMessage(seq + 1, `loaded Main turn ${turn}`, `compact-loaded-${turn}`))
      harness.route(ev('turn/end', { turn, reason: { kind: 'completed' } }, seq + 2))
    }
    harness.surface.paintNow()
    await awaitWireFact(() => mountedNodes(harness).some(node => node.p['text'] === 'loaded Main turn 25'),
      'the latest loaded User before the virtual anchor')
    assert.equal(harness.selectHistoryTurn(1), true, 'the virtual Controller can select an earlier turn')

    harness.route(ev('turn/start', { turn: 26 }, 75))
    harness.route(userMessage(76, 'prepare the next compact operation', 'compact-live-user-26'))
    harness.route(ev('tool/call', {
      turn: 26, step: 0, callId: ToolCallId('compact-preview-seed'), name: 'read', arguments: '{}',
    }, 77))
    harness.route(ev('tool/result', {
      turn: 26, step: 0,
      message: {
        id: MessageId('compact-preview-seed-result'), role: 'tool',
        toolCallId: ToolCallId('compact-preview-seed'),
        content: [{ type: 'text', text: 'seeded the canonical Work' }],
        source: { kind: 'tool', callId: ToolCallId('compact-preview-seed') },
      },
    }, 78))
    harness.route(ev('step/start', { turn: 26, step: 1 }, 79))
    harness.surface.applyAssistantInput({
      kind: 'chunk', sessionId: SESSION_ID, attemptId: 'compact-history-preview', turn: 26, step: 1,
      time: T0 + 80,
      chunk: { type: 'tool-call-delta', index: 0, id: 'compact-live-bash', name: 'bash', argumentsDelta: '{"command":"echo pending"}' },
    } as never)
    harness.surface.paintNow()
    await awaitWireFact(() => mountedNodes(harness).some(node =>
      node.k === 'section' && node.p['collapsible'] === true && nodeText(node).includes('Preparing Bash')),
    'the live Preparing summary in the latest Compact Work')

    const nodes = mountedNodes(harness)
    assert.equal(harness.windowSnapshot().mode, 'history', 'the virtual Controller still reports its earlier history anchor')
    assert.ok(nodes.some(node => node.p['text'] === 'loaded Main turn 1'), 'the oldest loaded User remains mounted')
    assert.ok(nodes.some(node => node.p['text'] === 'loaded Main turn 25'), 'the prior latest User remains mounted')
    assert.ok(nodes.some(node => node.p['text'] === 'prepare the next compact operation'),
      'the current live User remains mounted despite the virtual history anchor')
    const activity = nodes.find(node => node.k === 'section'
      && node.p['collapsible'] === true && nodeText(node).includes('Preparing Bash'))!
    const sf = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: activity.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).find(node => node.id === activity.id)?.p['collapsed'] === false,
      'the exact latest Compact Activity expands under its real wire id')
    const expandedRows = mountedNodes(harness).filter(node => node.k === 'row' && nodeText(node).includes('Preparing Bash'))
    assert.equal(expandedRows.length, 1, 'the authorized live Preparing row appears exactly once')
    assert.ok(expandedRows[0]!.id.startsWith(`${activity.id}.`), 'the live Preparing belongs to the expanded Compact Activity')
    assert.ok(!nodes.some(node => nodeText(node).includes('Earlier turns')),
      'the TSP Main has no virtual-window summary')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

for (const preset of ['full', 'compact', 'focus'] as const) {
  test(`a TSP ${preset} Main retains all loaded User messages past the PiTui window`, async () => {
    const harness = await mountTspHarness({ displayState: { preset } })
    const userNodes = (): ModeWireNode[] => mountedNodes(harness).filter(node =>
      node.k === 'message' && node.p['role'] === 'dsh.transcript.user')
    const routeTurn = (turn: number, seq: number): void => {
      const marker = `MAIN-${String(turn).padStart(2, '0')}`
      harness.route(ev('turn/start', { turn }, seq))
      harness.route(userMessage(seq + 1, marker, marker))
      harness.route(ev('turn/end', { turn, reason: { kind: 'completed' } }, seq + 2))
    }
    try {
      for (let turn = 1; turn <= 25; turn += 1) routeTurn(turn, (turn - 1) * 3)
      harness.surface.paintNow()

      const anchors = ['MAIN-01', 'MAIN-13', 'MAIN-25']
      await awaitWireFact(() => anchors.every(marker =>
        userNodes().filter(node => nodeText(node).includes(marker)).length === 1),
      `${preset} Main mounts the earliest, middle and latest loaded Users`)
      const projectedUsers = userNodes()
      assert.equal(projectedUsers.length, 25, 'every loaded User message remains in the same Main')
      for (const marker of anchors) {
        assert.equal(projectedUsers.filter(node => nodeText(node).includes(marker)).length, 1,
          `${marker} is mounted exactly once`)
      }
      assert.ok(!mountedNodes(harness).some(node => nodeText(node).includes('Earlier turns')),
        'TSP does not add a synthetic virtual-window summary')

      const earliest = projectedUsers.find(node => nodeText(node).includes('MAIN-01'))!
      const framesBeforeAppend = harness.tern.frames.length
      routeTurn(26, 75)
      harness.surface.paintNow()
      await awaitWireFact(() => userNodes().some(node => nodeText(node).includes('MAIN-26')),
        `${preset} Main mounts the next loaded User`)
      const afterAppend = userNodes()
      const earliestAfterAppend = afterAppend.find(node => nodeText(node).includes('MAIN-01'))
      assert.equal(earliestAfterAppend?.id, earliest.id, 'the earliest User keeps its SDK node id')
      assert.equal(afterAppend.length, 26, 'the next turn appends without evicting a loaded User')
      const earliestMutations = harness.tern.frames.slice(framesBeforeAppend).flatMap(frame => frame.ops)
        .filter(op => (op[0] === 'del' && op[1] === earliest.id)
          || (op[0] === 'move' && op.some(value => value === earliest.id)))
      assert.equal(earliestMutations.length, 0, 'the appended turn neither deletes nor moves the earliest User')
    } finally {
      await harness.dispose()
      await harness.session.close()
    }
  })
}

test('a TSP source replacement shows only loaded rows until an earlier Folder is rehydrated', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'full' } })
  const userNodes = (): ModeWireNode[] => mountedNodes(harness).filter(node =>
    node.k === 'message' && node.p['role'] === 'dsh.transcript.user')
  const routeTurn = (turn: number, seq: number, marker: string): void => {
    harness.route(ev('turn/start', { turn }, seq))
    harness.route(userMessage(seq + 1, marker, marker))
    harness.route(ev('turn/end', { turn, reason: { kind: 'completed' } }, seq + 2))
  }
  try {
    routeTurn(1, 0, 'MAIN-01')
    routeTurn(2, 3, 'MAIN-02')
    harness.surface.paintNow()
    await awaitWireFact(() => userNodes().length === 2, 'the original loaded source')
    const originalIds = userNodes().map(node => node.id)

    // Fixture-level source replacement models an authorized Remote rehydrate;
    // it is not evidence of a Remote Host reader.
    harness.replaceMain()
    routeTurn(24, 0, 'REMOTE-TAIL-24')
    routeTurn(25, 3, 'REMOTE-TAIL-25')
    harness.surface.paintNow()
    await awaitWireFact(() => userNodes().some(node => nodeText(node).includes('REMOTE-TAIL-25')),
      'the replacement source tail')
    let replacementUsers = userNodes()
    assert.equal(replacementUsers.length, 2, 'only the two loaded replacement rows are mounted')
    assert.ok(replacementUsers.some(node => nodeText(node).includes('REMOTE-TAIL-24')))
    assert.ok(replacementUsers.some(node => nodeText(node).includes('REMOTE-TAIL-25')))
    assert.ok(replacementUsers.every(node => !originalIds.includes(node.id)), 'the new source receives a new node namespace')
    assert.ok(replacementUsers.every(node => !nodeText(node).includes('MAIN-')),
      'the retired Folder rows do not leak into the new source')
    const firstTailId = replacementUsers.find(node => nodeText(node).includes('REMOTE-TAIL-25'))!.id

    // Only a second authoritative Folder replacement may add an earlier row;
    // it is submitted first so the loaded chronology stays valid.
    harness.replaceMain()
    routeTurn(23, 0, 'REMOTE-OLDER-23')
    routeTurn(24, 3, 'REMOTE-TAIL-24')
    routeTurn(25, 6, 'REMOTE-TAIL-25')
    harness.surface.paintNow()
    await awaitWireFact(() => userNodes().some(node => nodeText(node).includes('REMOTE-OLDER-23')),
      'the explicitly rehydrated earlier row')
    replacementUsers = userNodes()
    assert.equal(replacementUsers.length, 3)
    assert.ok(replacementUsers.some(node => nodeText(node).includes('REMOTE-OLDER-23')))
    assert.ok(replacementUsers.some(node => nodeText(node).includes('REMOTE-TAIL-24')))
    const rehydratedTailId = replacementUsers.find(node => nodeText(node).includes('REMOTE-TAIL-25'))!.id
    assert.notEqual(rehydratedTailId, firstTailId, 'each authoritative Folder replacement retires the former source namespace')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})


test('a new Preparing after an Assistant remains a Root row beside an earlier Focus Work', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'focus' } })
  try {
    harness.surface.bindRendererInput()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'inspect then prepare'))
    harness.route(toolCall(2, 'focus-before-pending'))
    harness.route(toolResult(3, 'focus-before-pending', 'first result'))
    harness.route(ev('assistant/message', {
      turn: 1, step: 1,
      message: { id: MessageId('focus-before-ownerless'), role: 'assistant', content: [{ type: 'text', text: 'intermediate answer' }], source: { kind: 'model', provider: 'p', model: 'm' }, stream: [] },
    }, 4))
    harness.route(ev('step/start', { turn: 1, step: 2 }, 5))
    harness.surface.applyAssistantInput({
      kind: 'chunk', sessionId: SESSION_ID, attemptId: 'focus-ownerless-attempt', turn: 1, step: 2,
      time: T0 + 6,
      chunk: { type: 'tool-call-delta', index: 0, id: 'focus-after-assistant', name: 'bash', argumentsDelta: '{"command":"echo pending"}' },
    } as never)
    harness.surface.paintNow()
    await awaitWireFact(() => mountedSections(harness).some(node => nodeText(node).includes('Action: Preparing Bash')),
      'the collapsed root shows the new streamed Preparing')
    const root = mountedSections(harness).find(node => node.id.includes('focus-'))!
    const sf = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: root.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).find(node => node.id === root.id)?.p['collapsed'] === false,
      'the same Focus root expands')
    const works = mountedSections(harness).filter(node => node.id.startsWith(`${root.id}.s1-work-`))
    assert.equal(works.length, 1, 'the pending run creates no phantom Work')
    assert.ok(!nodeText(works[0]!).includes('Preparing'), 'the earlier Work never adopts the new preview')
    const rows = mountedNodes(harness).filter(node => node.k === 'row' && node.id.includes('preparing-focus-after-assistant'))
    assert.equal(rows.length, 1, 'opening the root retains the new Preparing exactly once')
    assert.equal(rows[0]!.id, `${root.id}.preparing-focus-after-assistant`, 'the row belongs directly to its real Root')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a streamed Preparing preview is owned only by the exact trailing Focus Work', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'focus' } })
  try {
    harness.surface.bindRendererInput()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'inspect then prepare'))
    harness.route(toolCall(2, 'focus-live-read'))
    harness.route(toolResult(3, 'focus-live-read', 'first result'))
    harness.route(ev('assistant/message', {
      turn: 1, step: 1,
      message: { id: MessageId('focus-between-works'), role: 'assistant', content: [{ type: 'text', text: 'intermediate answer' }], source: { kind: 'model', provider: 'p', model: 'm' }, stream: [] },
    }, 4))
    harness.surface.applyAssistantInput({
      kind: 'chunk', sessionId: SESSION_ID, attemptId: 'focus-preparing-attempt', turn: 1, step: 2,
      time: T0 + 5,
      chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
    } as never)
    harness.surface.applyAssistantInput({
      kind: 'chunk', sessionId: SESSION_ID, attemptId: 'focus-preparing-attempt', turn: 1, step: 2,
      time: T0 + 6,
      chunk: { type: 'reasoning-delta', index: 0, text: 'preparing the final check' },
    } as never)
    harness.surface.applyAssistantInput({
      kind: 'chunk', sessionId: SESSION_ID, attemptId: 'focus-preparing-attempt', turn: 1, step: 2,
      time: T0 + 7,
      chunk: {
        type: 'tool-call-delta', index: 1, id: 'focus-live-preparing', name: 'bash',
        argumentsDelta: '{"command":"echo pending"}',
      },
    } as never)
    harness.surface.paintNow()
    await awaitWireFact(() => mountedSections(harness).some(node => node.id.includes('focus-')),
      'the current Focus root with a live Preparing preview')

    const collapsedRoot = mountedSections(harness).find(node => node.id.includes('focus-'))!
    assert.ok(nodeText(collapsedRoot).includes('Action: Preparing Bash'),
      `the collapsed root Action slot uses the current preview: ${JSON.stringify({ root: collapsedRoot, nodes: mountedNodes(harness).map(node => ({ id: node.id, text: node.p['text'] })) })}`)
    assert.equal(mountedSections(harness).length, 1, 'no synthetic Preparing Work section is created')

    const sf = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: collapsedRoot.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).filter(node => node.id.startsWith(`${collapsedRoot.id}.s1-work-`)).length === 2,
      'the expanded root has both canonical Work owners')
    const works = mountedSections(harness).filter(node => node.id.startsWith(`${collapsedRoot.id}.s1-work-`))
    const earlierWork = works.find(node => nodeText(node).includes('read ×1'))
    const trailingWork = works.find(node => nodeText(node).includes('Preparing Bash'))
    assert.ok(earlierWork !== undefined, `the first canonical Work is present: ${JSON.stringify(works.map(node => nodeText(node)))}`)
    assert.ok(trailingWork !== undefined, `the trailing Work owns the summary: ${JSON.stringify(works.map(node => nodeText(node)))}`)
    assert.notEqual(earlierWork.id, trailingWork.id, 'the two canonical Work owners remain distinct')
    assert.equal(works.filter(node => nodeText(node).includes('Preparing Bash')).length, 1,
      'only one nested Work header owns the same-Turn preview')

    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: trailingWork.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.id.includes('preparing-focus-live-preparing')),
      'the real mapped Preparing row inside the opened tail Work')
    const preparingRows = mountedNodes(harness).filter(node => node.k === 'row'
      && node.id.includes('preparing-focus-live-preparing'))
    assert.equal(preparingRows.length, 1, 'the live preview is materialized exactly once')
    assert.ok(preparingRows[0]!.id.startsWith(`${trailingWork.id}.`), 'the row belongs to the exact trailing Work node')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('Focus root toggle is refused by modal and retired source fences', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'focus' } })
  try {
    harness.surface.bindRendererInput()
    routeTwoWorkTurn(harness)
    await awaitWireFact(() => mountedSections(harness).some(node => node.id.includes('focus-')),
      'the Focus root before modal admission')
    const root = mountedSections(harness).find(node => node.id.includes('focus-'))!
    const rootId = root.id
    const sf = harness.tern.frames.at(-1)!.sf
    // A queued SIGNAL hint from an earlier commit (`settle`) or a caret
    // re-assertion (`focus`) may flush on the next ack; neither paints content,
    // so the frame witness counts only frames carrying a real CONTENT op.
    const painted = (): number => harness.tern.frames.filter(frame => frame.ops.some(op => op[0] !== 'settle' && op[0] !== 'focus')).length
    const beforeUnknown = painted()
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: 'main.not-a-real-focus-root', collapsed: false, raw: {} })
    await settle() // bounded observation window: a refused toggle must paint no frame
    assert.equal(painted(), beforeUnknown, 'an unknown root id paints no frame')
    assert.equal(mountedSections(harness).find(node => node.id === rootId)?.p['collapsed'], true,
      'an unknown id cannot alter the real root owner')
    const pending = harness.renderer().interaction.askQuestions([{ id: 'focus-q', question: 'Continue?' }], undefined, undefined, false)
    pending.catch(() => {})
    await awaitWireFact(() => harness.tern.output.text().includes('Continue?'), 'the real modal seat')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: rootId, collapsed: false, raw: {} })
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: 'foreign-surface', id: rootId, collapsed: false, raw: {} })
    await settle() // bounded observation window: covered and foreign toggles must paint no frame
    assert.equal(mountedSections(harness).find(node => node.id === rootId)?.p['collapsed'], true,
      'covered and foreign root events leave the Focus owner closed')
    assert.equal(mountedNodes(harness).filter(node => node.k === 'tool').length, 0,
      'the covered toggle never materializes background Work members')
    harness.renderer().interaction.withdrawPending()
    await pending.catch(() => {})

    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: rootId, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).find(node => node.id === rootId)?.p['collapsed'] === false,
      'the current root opens after the modal retires')
    harness.surface.display.beginSessionHydration()
    await awaitWireFact(() => mountedNodes(harness).some(node => nodeText(node).includes('Loading session')),
      'hydration paints the Loading state')
    const duringHydration = painted()
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: rootId, collapsed: false, raw: {} })
    await settle() // bounded observation window: a hydration-retired id must paint no frame
    assert.equal(painted(), duringHydration, 'the retired root id is refused during hydration')

    harness.replaceMain()
    routeTwoWorkTurn(harness)
    await awaitWireFact(() => mountedSections(harness).some(node => node.id.includes('focus-') && node.id !== rootId),
      'the replacement source Focus root')
    const replacement = mountedSections(harness).find(node => node.id.includes('focus-'))!
    assert.notEqual(replacement.id, rootId, 'the replacement source receives a new root namespace')
    assert.equal(replacement.p['collapsed'], true, 'the replacement source inherits no Focus disclosure')
    const beforeStale = painted()
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: rootId, collapsed: false, raw: {} })
    await settle() // bounded observation window: the prior source id must paint no frame
    assert.equal(painted(), beforeStale, 'the prior source root id cannot alter the replacement')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a formal status commit refreshes the Focus root without a transcript commit', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'focus' } })
  try {
    harness.surface.bindRendererInput()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'waiting on the user'))
    harness.surface.applyAssistantInput({
      kind: 'chunk', sessionId: SESSION_ID, attemptId: 'attempt-focus-status', turn: 1, step: 0,
      time: T0 + 2, chunk: { type: 'reasoning-delta', index: 0, text: 'checking the request' },
    } as never)
    harness.surface.paintNow()
    await awaitWireFact(() => mountedSections(harness).some(node => node.id.includes('focus-')),
      'the live Focus root before its phase transition')
    const root = mountedSections(harness).find(node => node.id.includes('focus-'))!
    const rootTitle = (): string => String(mountedNodes(harness).find(node => node.id === `${root.id}.head.title`)?.p['text'] ?? '')
    assert.ok(rootTitle().includes('Working'), 'the initial formal phase reads Working')

    harness.surface.commitStatus({
      activity: { phase: 'waiting-question', busy: true, queuedCount: 0, taskCount: 0, childAgentCount: 0, todoCount: 0 },
    } as never, {}, undefined)
    await awaitWireFact(() => rootTitle().includes('Waiting for input'),
      'the status commit repaints the same root without a transcript commit')

    harness.surface.commitStatus({
      activity: { phase: 'working', busy: true, queuedCount: 0, taskCount: 0, childAgentCount: 0, todoCount: 0 },
    } as never, {}, undefined)
    await awaitWireFact(() => rootTitle().includes('Working'),
      'resuming the official phase repaints the same root')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a foreign surface, an unknown node id and a stale scope toggle never open a Work', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'compact' } })
  try {
    harness.surface.bindRendererInput()
    routeTwoWorkTurn(harness)
    await awaitWireFact(() => mountedSections(harness).length === 2, 'the Compact Activity sections')
    const targetId = firstActivityId(harness)
    const lastFrame = harness.tern.frames.at(-1)
    assert.ok(lastFrame !== undefined)
    const sf = lastFrame.sf
    const before = harness.tern.frames.length
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: 'some-other-surface', id: targetId, collapsed: false, raw: {} })
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: 'main.not-a-real-node', collapsed: false, raw: {} })
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: `${targetId}-suffix`, collapsed: false, raw: {} })
    // An arbitrary ancestor prefix is NOT the SDK's fixed `main.` namespace.
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: `layer.${targetId.slice('main.'.length)}`, collapsed: false, raw: {} })
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: `other.${targetId.slice('main.'.length)}`, collapsed: false, raw: {} })
    await settle() // bounded observation window: a refused toggle must paint no frame
    assert.equal(harness.tern.frames.length, before, 'no rejected toggle painted a frame')
    assert.ok(mountedSections(harness).every(section => section.p['collapsed'] === true), 'every Work stays collapsed')

    // A REAL expand first, so the stale-scope negative has something to lose.
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: targetId, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).some(section => section.p['collapsed'] === false), 'the real expand')
    const staleId = targetId
    harness.surface.display.beginSessionHydration()
    await settle() // bounded observation window: a refused toggle must paint no frame
    const duringHydration = harness.tern.frames.length
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: staleId, collapsed: false, raw: {} })
    await settle() // bounded observation window: a refused toggle must paint no frame
    assert.equal(harness.tern.frames.length, duringHydration, 'the hydration window refuses the old Work toggle')

    // The new subject commits under a NEW scope; the old node id is gone.
    harness.replaceMain()
    harness.route(ev('turn/start', { turn: 1 }, 20))
    harness.route(userMessage(21, 'the incoming subject'))
    harness.route(toolCall(22, 'call-new'))
    harness.route(toolResult(23, 'call-new', 'new body'))
    harness.surface.paintNow()
    await awaitWireFact(() => mountedNodes(harness).some(node => nodeText(node).includes('the incoming subject')), 'the new subject frame')
    const newSections = mountedSections(harness)
    assert.ok(newSections.length > 0, 'the new subject has its own Activity')
    assert.ok(!newSections.some(section => section.id === staleId), 'the retired scope id is absent')
    assert.ok(newSections.every(section => section.p['collapsed'] === true), 'the incoming subject starts collapsed')
    const framesNow = harness.tern.frames.length
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: staleId, collapsed: false, raw: {} })
    await settle() // bounded observation window: a refused toggle must paint no frame
    assert.equal(harness.tern.frames.length, framesNow, 'the retired id cannot open the new subject Work')
    assert.ok(mountedSections(harness).every(section => section.p['collapsed'] === true), 'the new Work stays collapsed')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('an open modal seat blocks the base Activity toggle without reaching the background Tool owner', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'compact' } })
  try {
    harness.surface.bindRendererInput()
    routeTwoWorkTurn(harness)
    await awaitWireFact(() => mountedSections(harness).length === 2, 'the Compact Activity sections')
    const targetId = firstActivityId(harness)
    const lastFrame = harness.tern.frames.at(-1)
    assert.ok(lastFrame !== undefined)
    const sf = lastFrame.sf
    // The REAL interaction owner opens a modal seat (never a fabricated flag).
    const pending = harness.renderer().interaction.askQuestions([
      { id: 'q1', question: 'Proceed?' },
    ], undefined, undefined, false)
    pending.catch(() => {})
    await awaitWireFact(() => harness.tern.output.text().includes('Proceed?'), 'the real modal frame')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: targetId, collapsed: false, raw: {} })
    await settle() // bounded observation window: a refused toggle must paint no frame
    assert.ok(mountedSections(harness).every(section => section.p['collapsed'] === true), 'the modal seat keeps every Work collapsed')
    assert.equal(mountedNodes(harness).filter(node => node.k === 'tool').length, 0,
      'the covered toggle reached neither the Work nor a background Tool owner')
    harness.renderer().interaction.withdrawPending()
    await pending.catch(() => {})
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a same-source streaming delta keeps an opened Work expanded, and dispose retires the Work owner', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'compact' } })
  try {
    harness.surface.bindRendererInput()
    routeTwoWorkTurn(harness)
    await awaitWireFact(() => mountedSections(harness).length === 2, 'the Compact Activity sections')
    const targetId = firstActivityId(harness)
    const lastFrame = harness.tern.frames.at(-1)
    assert.ok(lastFrame !== undefined)
    const sf = lastFrame.sf
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: targetId, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).some(section => section.p['collapsed'] === false), 'the manual expand')

    // An ordinary same-source delta: a NEW open turn of the SAME fold streams
    // live text (the production assistant-stream path, same source token).
    harness.route(ev('turn/start', { turn: 2 }, 11))
    harness.route(ev('user/message', { id: MessageId('user-2'), role: 'user', content: [{ type: 'text', text: 'a later prompt' }], source: { kind: 'user' } }, 12))
    harness.surface.applyAssistantInput({
      kind: 'chunk', sessionId: SESSION_ID, attemptId: 'attempt-later', turn: 2, step: 0,
      time: T0 + 13_000, chunk: { type: 'text-delta', index: 0, text: 'a later delta' },
    } as never)
    harness.surface.paintNow()
    await awaitWireFact(() => mountedNodes(harness).some(node => nodeText(node).includes('a later delta')), 'the delta frame')
    assert.equal(mountedSections(harness).find(section => section.id === targetId)?.p['collapsed'], false,
      'the same-source delta did not reset the manual Work expansion')

    await harness.dispose()
    const afterDispose = harness.tern.frames.length
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: targetId, collapsed: false, raw: {} })
    await settle() // bounded observation window: a refused toggle must paint no frame
    assert.equal(harness.tern.frames.length, afterDispose, 'a disposed mount paints nothing for a late Work toggle')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('an unsettled streamed Assistant remains visible inside an expanded Focus root', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'focus' } })
  try {
    harness.surface.bindRendererInput()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'read the live answer'))
    harness.route(ev('step/start', { turn: 1, step: 0 }, 2))
    harness.surface.applyAssistantInput({
      kind: 'chunk', sessionId: SESSION_ID, attemptId: 'focus-live-answer', turn: 1, step: 0,
      time: T0 + 3, chunk: { type: 'text-delta', index: 0, text: 'LIVE-ANSWER-CHUNK' },
    } as never)
    harness.surface.paintNow()
    await awaitWireFact(() => mountedSections(harness).some(node => node.id.includes('focus-')),
      'the running Focus root with a live Assistant candidate')
    assert.equal(harness.imageReads.length, 0, 'the text candidate has no image read side effect')

    const root = mountedSections(harness).find(node => node.id.includes('focus-'))!
    const sf = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: root.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'col'
      && node.p['role'] === 'dsh.transcript.assistant'
      && nodeText(node).includes('LIVE-ANSWER-CHUNK')),
    'the unsettled Assistant candidate is painted as native content inside the expanded Root')
    assert.ok(mountedSections(harness).find(node => node.id === root.id)?.p['collapsed'] === false,
      'the same Focus root owns the live candidate')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a closed Focus root or Work starts no image read until its owning disclosures open', async () => {
  const attachment: ImageAttachmentRefLike = {
    attachmentId: 'focus-hidden-image', mediaType: 'image/png', bytes: 4, width: 2, height: 2, name: 'hidden.png',
  }
  const harness = await mountTspHarness({
    displayState: { preset: 'focus' },
    nativeImages: true,
    readImage: async ref => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }),
  })
  try {
    harness.surface.bindRendererInput()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'inspect hidden image'))
    const callId = 'focus-image-call'
    harness.route(ev('tool/call', { turn: 1, step: 0, callId: ToolCallId(callId), name: 'read_image', arguments: '{}' }, 2))
    harness.route(ev('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId('focus-image-result'), role: 'tool', toolCallId: ToolCallId(callId),
        content: [{ type: 'text', text: 'image result' }, { type: 'image', attachment }],
        source: { kind: 'tool', callId },
      },
    }, 3))
    harness.route(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4))
    harness.surface.paintNow()
    await awaitWireFact(() => mountedSections(harness).some(node => node.id.includes('focus-')),
      'the collapsed Focus image root')
    const root = mountedSections(harness).find(node => node.id.includes('focus-'))!
    assert.equal(harness.imageReads.length, 0, 'the collapsed root subscribes to no hidden image')
    assert.equal(harness.tern.blobs.length, 0, 'the collapsed root sends no blob')

    const sf = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: root.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).some(node => node.id.startsWith(`${root.id}.s1-work-`)),
      'the root-open but Work-collapsed image frame')
    assert.equal(harness.imageReads.length, 0, 'opening the root alone leaves the Work image hidden')
    assert.equal(harness.tern.blobs.length, 0, 'opening the root alone sends no image blob')

    const work = mountedSections(harness).find(node => node.id.startsWith(`${root.id}.s1-work-`))!
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: work.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'tool'), 'the Work Tool header')
    const tool = mountedNodes(harness).find(node => node.k === 'tool')!
    assert.equal(tool.p['collapsed'], true, 'the Tool body is a separate disclosure')
    assert.equal(harness.imageReads.length, 0, 'opening the Work alone still hides Tool result images')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf: harness.tern.frames.at(-1)!.sf, id: tool.id, collapsed: false, raw: {} })
    await awaitWireFact(() => harness.imageReads.length === 1, 'the opened Tool image read')
    await awaitWireFact(() => harness.tern.blobs.length === 1, 'the opened Tool image blob')
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'image'),
      'the opened Tool member image frame')

    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: root.id, collapsed: true, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).every(node => node.k !== 'image'), 'root close hides the image node')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: root.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).find(node => node.id === root.id)?.p['collapsed'] === false,
      'the Focus root opens again')
    assert.ok(mountedSections(harness).filter(node => node.id.startsWith(`${root.id}.s1-work-`)).every(node => node.p['collapsed'] === true),
      'the nested Work does not inherit its former open state')
    assert.equal(harness.tern.blobs.length, 1, 'reopening a collapsed root does not send another hidden blob')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('closing a Focus root resets only its nested Tool SVG disclosure', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'focus' }, nativeImages: true })
  try {
    harness.surface.bindRendererInput()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'draw one figure'))
    const svgArgs = {
      title: 'Focus Box',
      description: 'one Focus-owned SVG',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    }
    harness.route(ev('tool/call', {
      turn: 1, step: 0, callId: ToolCallId('focus-svg-call'), name: 'dsh_pi_tui_svg', arguments: JSON.stringify(svgArgs),
    }, 2))
    harness.route(ev('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId('focus-svg-result'), role: 'tool', toolCallId: ToolCallId('focus-svg-call'),
        content: svgContentBlocks(svgFactFromArgs(svgArgs)), source: { kind: 'tool', callId: 'focus-svg-call' },
      },
    }, 3))
    harness.route(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4))
    harness.surface.paintNow()
    await awaitWireFact(() => mountedSections(harness).some(node => node.id.includes('focus-')),
      'the collapsed Focus SVG root')
    const root = mountedSections(harness).find(node => node.id.includes('focus-'))!
    const sf = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: root.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).some(node => node.id.startsWith(`${root.id}.s1-work-`)),
      'the Focus nested Work section')
    const work = mountedSections(harness).find(node => node.id.startsWith(`${root.id}.s1-work-`))!
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: work.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'tool'), 'the SVG Tool node inside its Work')
    const tool = mountedNodes(harness).find(node => node.k === 'tool')!
    assert.equal(tool.p['collapsed'], true, 'the SVG Tool owns an independent disclosure')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: tool.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'image'), 'the opened SVG image node')
    assert.equal(harness.tern.blobs.length, 1, 'only the Tool disclosure requested the SVG blob')

    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: root.id, collapsed: true, raw: {} })
    await awaitWireFact(() => mountedSections(harness).find(node => node.id === root.id)?.p['collapsed'] === true,
      'the Focus root closes')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: root.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).find(node => node.id === root.id)?.p['collapsed'] === false,
      'the same Focus root opens again')
    const reopenedWork = mountedSections(harness).find(node => node.id.startsWith(`${root.id}.s1-work-`))!
    assert.equal(reopenedWork.p['collapsed'], true, 'the root close reset its nested Work')
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: reopenedWork.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'tool'), 'the Work reopens')
    const reopenedTool = mountedNodes(harness).find(node => node.k === 'tool')!
    assert.equal(reopenedTool.p['collapsed'], true, 'the root close reset only this Turn Tool disclosure')
    assert.equal(mountedNodes(harness).some(node => node.k === 'image'), false,
      'the SVG stays hidden until its own disclosure is reopened')
    assert.equal(harness.tern.blobs.length, 1, 'reopening the root and Work sends no second blob')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a materialized Focus Tool toggle waits for the Question Modal and native Picker seats', async () => {
  const harness = await mountTspHarness({
    displayState: { preset: 'focus' },
    nativeImages: true,
    sessionBrowserCapabilities: true,
  })
  try {
    harness.surface.bindRendererInput()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'draw two figures'))
    for (const [step, id] of ['modal-tool', 'picker-tool'].entries()) {
      const callId = `focus-svg-${id}`
      const args = {
        title: `Figure ${step + 1}`,
        description: `Focus-owned SVG ${step + 1}`,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="${step + 1}" height="10"/></svg>`,
      }
      harness.route(ev('tool/call', {
        turn: 1, step, callId: ToolCallId(callId), name: 'dsh_pi_tui_svg', arguments: JSON.stringify(args),
      }, 2 + step * 2))
      harness.route(ev('tool/result', {
        turn: 1, step,
        message: {
          id: MessageId(`result-${id}`), role: 'tool', toolCallId: ToolCallId(callId),
          content: svgContentBlocks(svgFactFromArgs(args)), source: { kind: 'tool', callId },
        },
      }, 3 + step * 2))
    }
    harness.route(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6))
    harness.surface.paintNow()
    const sf = harness.tern.frames.at(-1)!.sf
    await awaitWireFact(() => mountedSections(harness).some(node => node.id.includes('focus-')),
      'the collapsed Focus root')
    const root = mountedSections(harness).find(node => node.id.includes('focus-'))!
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: root.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedSections(harness).some(node => node.id.startsWith(`${root.id}.s1-work-`)),
      'the nested canonical Work')
    const works = mountedSections(harness).filter(node => node.id.startsWith(`${root.id}.s1-work-`))
    for (const work of works) {
      harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: work.id, collapsed: false, raw: {} })
      await awaitWireFact(() => mountedSections(harness).find(node => node.id === work.id)?.p['collapsed'] === false,
        'the Focus Work expansion frame')
    }
    const materializedTools = mountedNodes(harness).filter(node => node.k === 'tool')
    assert.equal(materializedTools.length, 2,
      `both materialized SVG Tool nodes: ${JSON.stringify({ nodes: mountedNodes(harness), sections: mountedSections(harness), tools: materializedTools })}`)
    const [modalTool, pickerTool] = materializedTools
    assert.ok(modalTool !== undefined && pickerTool !== undefined)
    assert.equal(modalTool.p['collapsed'], true)
    assert.equal(pickerTool.p['collapsed'], true)

    const pending = harness.renderer().interaction.askQuestions([{ id: 'focus-seat-q', question: 'Proceed?' }], undefined, undefined, false)
    pending.catch(() => {})
    await awaitWireFact(() => harness.tern.output.text().includes('Proceed?'), 'the actual Question Modal seat')
    await settle() // bounded window: the Modal's initial frame and focus update have landed
    const modalFrames = harness.tern.frames.length
    const modalBlobs = harness.tern.blobs.length
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: modalTool.id, collapsed: false, raw: {} })
    await settle() // bounded window: an admitted toggle must paint a frame; the seat must suppress it
    assert.equal(harness.tern.frames.length, modalFrames, 'the covered Tool toggle paints no Main frame')
    assert.equal(harness.tern.blobs.length, modalBlobs, 'the covered Tool toggle requests no SVG Blob')
    assert.equal(mountedNodes(harness).find(node => node.id === modalTool.id)?.p['collapsed'], true,
      'the covered Tool keeps its collapsed state')
    harness.renderer().interaction.withdrawPending()
    await pending.catch(() => {})

    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: modalTool.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'image'),
      'the same Tool node expands after the modal releases its seat')
    await awaitWireFact(() => harness.tern.blobs.length === modalBlobs + 1, 'the admitted SVG Blob')

    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: modalTool.id, collapsed: true, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).find(node => node.id === modalTool.id)?.p['collapsed'] === true,
      'the first Tool is collapsed before the picker case')
    const modelPresentation = harness.renderer().modelPresentation
    assert.ok(modelPresentation !== undefined, 'the pane negotiated the native Model Picker')
    const picker = modelPresentation.open({
      subject: { sessionless: false },
      entry: 'models',
      apply() { throw new Error('model selection is not exercised') },
      retry() { throw new Error('model retry is not exercised') },
      isCurrent: () => true,
      runOwned() { throw new Error('model tasks are not exercised') },
    } satisfies ModelPickerRequest)
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'picker'), 'the native Model Picker frame')
    await settle() // bounded window: the Picker's initial frame and focus update have landed
    const pickerFrames = harness.tern.frames.length
    const pickerBlobs = harness.tern.blobs.length
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: pickerTool.id, collapsed: false, raw: {} })
    await settle() // bounded window: an admitted toggle must paint a frame; the seat must suppress it
    assert.equal(harness.tern.frames.length, pickerFrames, 'the covered Tool toggle paints no Main frame')
    assert.equal(harness.tern.blobs.length, pickerBlobs, 'the covered Tool toggle requests no SVG Blob')
    assert.equal(mountedNodes(harness).find(node => node.id === pickerTool.id)?.p['collapsed'], true,
      'the covered Tool keeps its collapsed state')
    picker.close()
    await awaitWireFact(() => mountedNodes(harness).every(node => node.k !== 'picker'), 'the native Picker retirement')

    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: pickerTool.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).find(node => node.id === pickerTool.id)?.p['collapsed'] === false,
      'the same Tool node expands after the Picker retires')
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'image' && node.id.startsWith(`${pickerTool.id}.`)),
      'the expanded Tool materializes its SVG image after the Picker retires')
    await awaitWireFact(() => harness.tern.blobs.length === pickerBlobs + 1,
      'the expanded Tool requests its own Blob after the Picker retires')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a Compact Tool toggle is isolated by the Question Modal and expands when its seat releases', async () => {
  const harness = await mountTspHarness({ displayState: { preset: 'compact' }, nativeImages: true })
  try {
    harness.surface.bindRendererInput()
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'draw a figure'))
    const svgArgs = { title: 'Box', description: 'a box', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>' }
    harness.route(ev('tool/call', {
      turn: 1, step: 0, callId: ToolCallId('svg-1'), name: 'dsh_pi_tui_svg',
      arguments: JSON.stringify(svgArgs),
    }, 2))
    harness.route(ev('tool/result', {
      turn: 1, step: 0,
      // The REAL credential producer, so the fold admits a ready SVG state.
      message: { id: MessageId('svg-result'), role: 'tool', toolCallId: ToolCallId('svg-1'), content: svgContentBlocks(svgFactFromArgs(svgArgs)), source: { kind: 'tool', callId: ToolCallId('svg-1') } },
    }, 3))
    harness.surface.paintNow()
    await awaitWireFact(() => mountedSections(harness).length === 1, 'the SVG Work Activity')
    const sectionId = firstActivityId(harness)
    const lastFrame = harness.tern.frames.at(-1)
    assert.ok(lastFrame !== undefined)
    const sf = lastFrame.sf
    assert.equal(mountedNodes(harness).filter(node => node.k === 'image').length, 0, 'the collapsed Activity draws no image')

    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: sectionId, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'tool'), 'the expanded Work Tool card')
    const toolNode = mountedNodes(harness).find(node => node.k === 'tool')!
    assert.equal(toolNode.p['collapsed'], true, 'the Tool SVG card keeps its OWN collapsed disclosure')
    assert.equal(mountedNodes(harness).filter(node => node.k === 'image').length, 0, 'opening the Work demanded no SVG blob')

    const pending = harness.renderer().interaction.askQuestions([{ id: 'compact-seat-q', question: 'Proceed?' }], undefined, undefined, false)
    pending.catch(() => {})
    await awaitWireFact(() => harness.tern.output.text().includes('Proceed?'), 'the actual Question Modal seat')
    await settle() // bounded window: the Modal's initial frame and focus update have landed
    const modalFrames = harness.tern.frames.length
    const modalBlobs = harness.tern.blobs.length
    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: toolNode.id, collapsed: false, raw: {} })
    await settle() // bounded window: an admitted toggle must paint a frame; the seat must suppress it
    assert.equal(harness.tern.frames.length, modalFrames, 'the covered Compact Tool toggle paints no Main frame')
    assert.equal(harness.tern.blobs.length, modalBlobs, 'the covered Compact Tool toggle requests no SVG Blob')
    assert.equal(mountedNodes(harness).find(node => node.id === toolNode.id)?.p['collapsed'], true,
      'the covered Compact Tool keeps its collapsed state')
    assert.equal(mountedSections(harness).find(section => section.id === sectionId)?.p['collapsed'], false,
      'the Tool toggle leaves its owning Activity expanded')
    harness.renderer().interaction.withdrawPending()
    await pending.catch(() => {})

    harnessFreeInput(harness.tern, { ev: 'toggle', sf, id: toolNode.id, collapsed: false, raw: {} })
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'image' && node.id.startsWith(`${toolNode.id}.`)),
      'the same Compact Tool node expands after the Modal releases its seat')
    await awaitWireFact(() => harness.tern.blobs.length === modalBlobs + 1,
      'the admitted Compact Tool requests its SVG Blob')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── Mouse PR4: the first-party Tasks status segment's pointer entry ─────────
//
// The renderer paints the click action ONLY while its live admission predicate
// allows the click, and it admits an `action` event ONLY for the exact node id
// of the frame it committed. These cases drive the REAL scripted pane input, so
// the event shape (`sf`/`id`/`act`) is the client's own.

/** The protocol action the first-party Tasks segment sends. */
const TASKS_ACTION = 'dsh.footer.tasks.open'

/** The committed Tasks status segment carrying the click action, if any. */
function tasksActionNode(harness: Harness): ModeWireNode | undefined {
  return mountedNodes(harness).find(node => node.k === 'seg'
    && (node.p['actions'] as { readonly click?: unknown } | undefined)?.click === TASKS_ACTION)
}

/** Commit the real activity facts a running Task roster produces. */
function commitRunningTasks(harness: Harness): void {
  harness.surface.commitStatus({
    activity: { taskCount: 2, taskTotalCount: 3, childAgentCount: 0, childAgentTotalCount: 0 },
  } as never, {}, undefined)
}

test('Mouse PR4: a real click on the visible Tasks badge opens the registered entry exactly once', async () => {
  const opens: number[] = []
  const harness = await mountTspHarness({
    // The Hub + Reader capability: the SAME negotiation `/tasks` admission uses.
    sessionBrowserCapabilities: true,
    openTasksBrowserUi: () => { opens.push(1) },
    tasksBrowserUiAvailable: () => true,
  })
  try {
    harness.surface.bindRendererInput()
    commitRunningTasks(harness)
    await awaitWireFact(() => tasksActionNode(harness) !== undefined, 'the badge paints its click action')
    const badge = tasksActionNode(harness)!
    assert.ok(String(badge.p['text'] ?? '').includes('2/3j'),
      `the action rides the REAL attention badge: ${String(badge.p['text'])}`)

    // The SF must be the surface this action was committed on.
    const sf = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'action', sf, id: badge.id, act: TASKS_ACTION })
    await awaitWireFact(() => opens.length === 1, 'the registered entry ran once')
    await settle() // bounded window: a duplicate dispatch would land here
    assert.equal(opens.length, 1, 'exactly one business entry call per click')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('Mouse PR4: a pane without the Task Center capability paints an inert badge and refuses a fabricated action', async () => {
  const opens: number[] = []
  const harness = await mountTspHarness({
    openTasksBrowserUi: () => { opens.push(1) },
    tasksBrowserUiAvailable: () => true,
  })
  try {
    harness.surface.bindRendererInput()
    commitRunningTasks(harness)
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'seg'
      && String(node.p['text'] ?? '').includes('2/3j')), 'the badge itself paints')
    assert.equal(tasksActionNode(harness), undefined,
      'a pane that cannot present the Hub never claims a click target')
    const badge = mountedNodes(harness).find(node => node.k === 'seg'
      && String(node.p['text'] ?? '').includes('2/3j'))!
    const sf = harness.tern.frames.at(-1)!.sf
    harnessFreeInput(harness.tern, { ev: 'action', sf, id: badge.id, act: TASKS_ACTION })
    await settle() // bounded window: a wrong admission would have called the entry
    assert.deepEqual(opens, [], 'the event is dropped, never routed around the capability')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('Mouse PR4: an unregistered /tasks entry leaves the badge inert even on a capable pane', async () => {
  const opens: number[] = []
  const harness = await mountTspHarness({
    sessionBrowserCapabilities: true,
    openTasksBrowserUi: () => { opens.push(1) },
    tasksBrowserUiAvailable: () => false,
  })
  try {
    harness.surface.bindRendererInput()
    commitRunningTasks(harness)
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'seg'
      && String(node.p['text'] ?? '').includes('2/3j')), 'the badge itself paints')
    assert.equal(tasksActionNode(harness), undefined,
      'the availability fact — not the painted badge — decides the action')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('Mouse PR4: a foreign, stale or mismatched Tasks action is dropped without a call', async () => {
  const opens: number[] = []
  const harness = await mountTspHarness({
    sessionBrowserCapabilities: true,
    openTasksBrowserUi: () => { opens.push(1) },
    tasksBrowserUiAvailable: () => true,
  })
  try {
    harness.surface.bindRendererInput()
    commitRunningTasks(harness)
    await awaitWireFact(() => tasksActionNode(harness) !== undefined, 'the badge paints its click action')
    const badge = tasksActionNode(harness)!
    const sf = harness.tern.frames.at(-1)!.sf

    // A forged sibling id: no node of the committed frame has it.
    harnessFreeInput(harness.tern, { ev: 'action', sf, id: `${badge.id}.forged`, act: TASKS_ACTION })
    // The committed id with a different action name.
    harnessFreeInput(harness.tern, { ev: 'action', sf, id: badge.id, act: 'other.action' })
    // The right id and act on ANOTHER surface.
    harnessFreeInput(harness.tern, { ev: 'action', sf: `${sf}-other`, id: badge.id, act: TASKS_ACTION })
    await settle() // bounded window: any wrong admission would have called the entry
    assert.deepEqual(opens, [], 'only the committed node id on its own surface is admitted')

    // The frame that retires the badge retires its node id too.
    harness.surface.commitStatus({
      activity: { taskCount: 0, taskTotalCount: 0, childAgentCount: 0, childAgentTotalCount: 0 },
    } as never, {}, undefined)
    await awaitWireFact(() => tasksActionNode(harness) === undefined, 'the badge leaves the frame')
    harnessFreeInput(harness.tern, { ev: 'action', sf, id: badge.id, act: TASKS_ACTION })
    await settle() // bounded window
    assert.deepEqual(opens, [], 'a retired node id can never claim the intent')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('Mouse PR4: an unbound renderer input admits no Tasks action', async () => {
  const opens: number[] = []
  const harness = await mountTspHarness({
    sessionBrowserCapabilities: true,
    openTasksBrowserUi: () => { opens.push(1) },
    tasksBrowserUiAvailable: () => true,
  })
  try {
    commitRunningTasks(harness)
    await awaitWireFact(() => mountedNodes(harness).some(node => node.k === 'seg'
      && String(node.p['text'] ?? '').includes('2/3j')), 'the badge itself paints')
    assert.equal(tasksActionNode(harness), undefined,
      'no action is claimed before the application input binding exists')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('Mouse PR4: the late-bound /tasks entry and its availability reach the bound renderer input', async () => {
  const calls: number[] = []
  const harness = await mountTspHarness({
    openTasksBrowserUi: () => { calls.push(1) },
    tasksBrowserUiAvailable: () => true,
  })
  try {
    harness.surface.bindRendererInput()
    const bound = harness.boundHandlers()
    assert.ok(bound, 'the renderer input is bound')
    assert.equal(bound.tasksBrowserUiAvailable(), true, 'the availability fact traverses verbatim')
    bound.openTasksBrowserUi()
    await settle() // window: let the seam callback run before reading the record
    assert.deepEqual(calls, [1], 'the entry traverses the surface seam exactly once')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('Mouse PR4: an unwired /tasks entry refuses loudly and availability answers false', async () => {
  const harness = await mountTspHarness()
  try {
    harness.surface.bindRendererInput()
    const bound = harness.boundHandlers()
    assert.ok(bound)
    assert.throws(() => bound.openTasksBrowserUi(),
      /tasks browser command entry is not wired/)
    assert.equal(bound.tasksBrowserUiAvailable(), false,
      'an unwired composition never claims the entry is available')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('Mouse PR4: the badge action follows the LIVE entry availability across committed frames', async () => {
  let available = true
  const opens: number[] = []
  const harness = await mountTspHarness({
    sessionBrowserCapabilities: true,
    openTasksBrowserUi: () => { opens.push(1) },
    tasksBrowserUiAvailable: () => available,
  })
  try {
    harness.surface.bindRendererInput()
    commitRunningTasks(harness)
    await awaitWireFact(() => tasksActionNode(harness) !== undefined, 'the badge paints its action')
    const badgeId = tasksActionNode(harness)!.id
    const commit = (queued: number): void => {
      harness.surface.commitStatus({
        activity: { taskCount: 2, taskTotalCount: 3, childAgentCount: 0, childAgentTotalCount: 0, queuedCount: queued },
      } as never, {}, undefined)
    }

    // The command authority changes hands (e.g. a later Host override): the
    // NEXT committed frame must retract the action, and the retired node id
    // must not run the entry from a stale click.
    available = false
    commit(1)
    await awaitWireFact(() => tasksActionNode(harness) === undefined, 'the action is retracted')
    harnessFreeInput(harness.tern, { ev: 'action', sf: harness.tern.frames.at(-1)!.sf, id: badgeId, act: TASKS_ACTION })
    await settle() // window: a wrong admission would have called the entry by now (negative observation)
    assert.deepEqual(opens, [], 'the retracted frame admits no action')

    // Authority returns: the same projection repaints the action.
    available = true
    commit(2)
    await awaitWireFact(() => tasksActionNode(harness) !== undefined, 'the action returns')
    harnessFreeInput(harness.tern, {
      ev: 'action',
      sf: harness.tern.frames.at(-1)!.sf,
      id: tasksActionNode(harness)!.id,
      act: TASKS_ACTION,
    })
    await awaitWireFact(() => opens.length === 1, 'the restored action runs once')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})
