/**
 * PR2 live-transcript-projection contract tests (Tern Surface Protocol).
 *
 * The chain under test is the PRODUCTION one:
 *
 *     realistic SessionEvent / AssistantLiveInput
 *       -> the REAL `routeSessionEvent` / `applyAssistantInput` routing bodies
 *       -> ONE real `TranscriptFolder` + `TranscriptWindowController`
 *       -> the REAL `SurfaceRuntime.repaintTarget()` projection glue
 *       -> the real mounted `TuiApp` (VirtualTerminal) committed the SAME array
 *       -> the optional read-only observer (`onTranscriptProjected`)
 *       -> PR1's pure mapper -> the real `@stencil-hq/tern` SDK surface
 *
 * STANDS-IN (never claimed as production): the runner-owned routing source
 * (the fold/window instances, the session facts and the status/preview sinks)
 * is a test fixture, exactly like `transcript-history-extension.test.ts`; the
 * TSP pane is a scripted tty that answers the official handshake and acks
 * frames under credit flow control. The two terminals are DIFFERENT objects:
 * PiTui never shares stdin with the SDK. Nothing here is L5 (real Host wire) or
 * L6 (a real pane running the app); see `docs/tsp/overview.md`.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-live-projection.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  concatBytes,
  connect,
  type Op,
  type Renderable,
  type SessionInput,
  type TermInput,
  type TermOutput,
} from '@stencil-hq/tern'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { TuiApp } from '../../src/tui-app.ts'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import { projectTranscriptStructure } from '../../src/tui/transcript/structure.ts'
import { toolSummaryKeys } from '../../src/tui/transcript/tool-presentation.ts'
import {
  createSessionPresentation,
  applyAssistantLiveInput,
  type SessionPresentation,
} from '../../src/app/surface/session-presentation.ts'
import {
  applyStreamingToolPreviewEvent,
  type StreamingToolPreview,
} from '../../src/app/surface/streaming-tool-preparing.ts'
import { StatsFolder } from '../../src/domain/status/stats.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import type { PresentationReadSnapshot } from '../../src/runtime/presentation-read-port.ts'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import {
  createSurfaceRuntime,
  type SurfaceRendererMount,
  type SurfaceRuntime,
  type TranscriptProjectionFrame,
} from '../../src/app/surface/runtime.ts'
import type { SurfaceEventRoutingSource } from '../../src/app/surface/event-routing.ts'
import type { AssistantLiveInput } from '../../src/runtime/assistant-stream-port.ts'
import type { SubmissionPresentationItem } from '../../src/app/submission/presentation.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { TranscriptNodeKeys, transcriptView } from '../../scripts/support/tern-tsp-transcript-view.ts'
import { installVirtualProcessTerminal } from '../support/runner-harness.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SESSION_ID = 'session-live-pr2'
const CHILD_ID = 'session-child-pr2'
/** The Remote-branch session id (the bounded-window hydration fixture). */
const REMOTE_ID = 'remote-session-pr2'
const T0 = 1_700_000_000_000
const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

const SESSION = { id: SESSION_ID }
const CHILD_SESSION = { id: CHILD_ID }

// ── Fixtures ───────────────────────────────────────────────────────────────

function ev(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: T0 + seq, data } as SessionEvent
}

function userMessage(seq: number, id: string, text: string): SessionEvent {
  return ev('user/message', {
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }, seq)
}

function toolCall(seq: number, id: string, name: string, args: Record<string, unknown>): SessionEvent {
  return ev('tool/call', { turn: 1, step: 0, callId: ToolCallId(id), name, arguments: JSON.stringify(args) }, seq)
}

function toolResult(seq: number, id: string, text: string): SessionEvent {
  return ev('tool/result', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId(`result-${id}`),
      role: 'tool',
      toolCallId: ToolCallId(id),
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId: ToolCallId(id) },
    },
  }, seq)
}

/** One settled assistant message (the hydrated cold-log shape). */
function assistantMessage(seq: number, id: string, text: string): SessionEvent {
  return ev('assistant/message', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId(id),
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    },
    stream: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }, seq)
}

/** One live main-session delta of the streaming assistant message. */
function liveChunk(chunk: unknown, sessionId = SESSION_ID): AssistantLiveInput {
  return {
    kind: 'chunk',
    sessionId,
    attemptId: 'attempt-pr2',
    turn: 1,
    step: 0,
    time: T0 + 100,
    chunk,
  } as AssistantLiveInput
}

const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

// ── The real mounted surface over a virtual PiTui terminal ──────────────────

interface Harness {
  readonly surface: SurfaceRuntime<SessionEvent>
  readonly app: TuiApp
  readonly vt: VirtualTerminal
  /** The CURRENT main fold (a session commit/rehydrate replaces it). */
  readonly folder: TranscriptFolder
  /** The ONE retained main window controller (`session-presentation.ts`). */
  readonly window: TranscriptWindowController
  /** Every frame the surface published, in order. */
  readonly frames: TranscriptProjectionFrame[]
  /** Every message array the mounted app was asked to commit, in order. */
  readonly committed: Array<readonly TranscriptMessage[]>
  viewChild(): TranscriptFolder
  exitChild(): void
  /** Replace the main fold under the SAME session id and re-bind the retained
   *  window controller (the session commit / cold rehydrate shape). */
  replaceMain(): void
  /** Hand the session over to another id WITHOUT touching the fold/window —
   *  the pre-hydration window of a session switch inside a commit. */
  handoverOwner(sessionId: string): void
  /** Install/replace the hook that runs inside the patched `setTranscript()`. */
  armCommitHook(fn: (() => void) | undefined): void
  dispose(): void
}

/**
 * Mount the REAL `SurfaceRuntime` + `TuiApp` (over a `VirtualTerminal`) with the
 * PR2 observer attached, and route through the real application routing bodies.
 * `duringCommit` runs inside the patched `setTranscript()`, so a test can make
 * the commit itself switch the active subject (the re-entrancy case).
 */
function mountHarness(options: {
  readonly onTranscriptProjected: (frame: TranscriptProjectionFrame) => void
  readonly duringCommit?: () => void
  /** PR3-A F10: a controllable pending subject (the own-input scroll guard). */
  readonly pending?: {
    readonly subjectId: string
    readonly echoes: () => readonly SubmissionPresentationItem[] | undefined
    readonly snapshot?: () => { readonly running: boolean; readonly items: readonly unknown[] } | undefined
  }
}): Harness {
  const vt = new VirtualTerminal(100, 30)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  let folder = new TranscriptFolder()
  const controller = new TranscriptWindowController({ windowTurns: 20, stepTurns: 10 })
  const frames: TranscriptProjectionFrame[] = []
  const committed: Array<readonly TranscriptMessage[]> = []
  let viewed: { id: string; folder: TranscriptFolder; window: TranscriptWindowController } | undefined
  let attached = true
  let ownerSessionId = SESSION_ID
  let commitHook = options.duringCommit
  let currentAgent: object | undefined
  const agents = new Map<string, object>()
  const previews = new Map()
  const stats = { apply: () => {} }

  // The presentation target stays ONE object whose fold/window are LIVE reads:
  // a session commit or cold rehydrate replaces the folder instance underneath
  // it and re-binds the ONE retained window controller, exactly as
  // `session-presentation.ts` does.
  const mainPresentation = {
    folder: { apply: (events: readonly SessionEvent[]) => folder.apply(events) },
    stats,
    get window() { return controller },
    previews,
    applyToolPreview: () => {},
    refreshRecentPerformanceAvailability: () => {},
  }
  const childPresentation = () => ({
    id: viewed!.id,
    folder: { apply: (events: readonly SessionEvent[]) => viewed!.folder.apply(events) },
    stats,
    window: viewed!.window,
    previews,
    applyToolPreview: () => {},
    beginTurn: () => {},
    endTurn: () => {},
    refreshFooter: () => {},
  })

  const source: SurfaceEventRoutingSource<SessionEvent> = {
    isCleanedUp: () => false,
    isAttachedSession: session => attached
      && (session.id === ownerSessionId || (viewed !== undefined && session.id === viewed.id)),
    currentSessionId: () => ownerSessionId,
    hasLiveAgent: () => true,
    completionOwnerId: () => undefined,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => mainPresentation,
    viewedChildId: () => viewed?.id,
    viewedChild: () => childPresentation(),
    mainFolder: () => folder,
    viewedChildFolder: () => viewed!.folder,
    pendingSubjectId: () => options.pending?.subjectId,
    pendingSnapshot: () => options.pending?.snapshot?.() as never,
    submissionEchoes: () => options.pending?.echoes(),
    queueTextOf: () => '',
    exitView: () => { viewed = undefined },
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
    registeredAgentIs: (sessionId, agent) => agent === agents.get(sessionId),
    isCurrentOwnerAgent: agent => currentAgent === agent,
    viewedChildAgent: () => undefined,
    setViewedChildAgent: () => {},
    setViewedQueueAgent: () => {},
    agentForSession: sessionId => agents.get(sessionId),
    applyViewedChildAssistantInput: input => viewed!.folder.applyLiveInput(input),
    applyMainAssistantInput: input => folder.applyLiveInput(input),
  }

  const surface = createSurfaceRuntime<SessionEvent>({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation,
    notificationMode: undefined,
    mainProgressAuthority: 'local-events',
    notificationMethod: undefined,
    terminalProgress: undefined,
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
    onTranscriptProjected: frame => {
      frames.push(frame)
      options.onTranscriptProjected(frame)
    },
  })
  surface.attachEventRouting(source)
  surface.start({
    events: { onSubmit: () => {}, onExit: () => {} },
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised by this test')) },
    readImage: () => Promise.reject(new Error('not exercised by this test')),
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

  // Instrument the MOUNTED production method (never a reimplementation): the
  // observer must carry the exact array this call received.
  const app = surface.app
  const prototype = Object.getPrototypeOf(app) as { setTranscript: TuiApp['setTranscript'] }
  const originalSetTranscript = prototype.setTranscript
  app.setTranscript = (...args: Parameters<TuiApp['setTranscript']>) => {
    committed.push(args[0])
    const result = originalSetTranscript.call(app, ...args)
    commitHook?.()
    return result
  }

  return {
    surface,
    app,
    vt,
    get folder() { return folder },
    get window() { return controller },
    frames,
    committed,
    viewChild() {
      const child = new TranscriptFolder()
      viewed = { id: CHILD_ID, folder: child, window: new TranscriptWindowController({ windowTurns: 20, stepTurns: 10 }) }
      return child
    },
    exitChild() { viewed = undefined },
    replaceMain() {
      // `session-presentation.ts` replaces the FOLD and re-binds the ONE
      // retained window controller (`windowController.setTurns(...)`); the
      // controller instance is never swapped within one subject.
      folder = new TranscriptFolder()
      controller.setTurns(folder.groupedTurns())
    },
    handoverOwner(sessionId) { ownerSessionId = sessionId },
    armCommitHook(fn) { commitHook = fn },
    dispose() {
      surface.dispose()
      restoreTerminal()
    },
  }
}

/** Route one durable event of the main session through the REAL routing. */
function route(harness: Harness, event: SessionEvent): void {
  harness.surface.routeSessionEvent(SESSION, event)
}

/** Whether one projection carries a user row with exactly this text. */
function hasUserText(messages: readonly TranscriptMessage[], text: string): boolean {
  return messages.some(message => message.kind === 'user' && message.text === text)
}

// ── The real TSP sink: a scripted Tern pane ─────────────────────────────────

class FakeInput extends EventEmitter implements TermInput {
  readonly isTTY: boolean
  isRaw = false
  readonly raw: boolean[] = []
  readonly received: string[] = []

  constructor(isTTY = true) {
    super()
    this.isTTY = isTTY
    this.on('data', (bytes: Uint8Array) => { this.received.push(DECODER.decode(bytes)) })
  }

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

/** The `hello` reply a supported Tern pane sends (same frame shape PR1 used). */
const HELLO = {
  r: 'hello',
  v: 1,
  term: 'tern',
  ver: '0.6.2',
  kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool'],
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

/** Every frame (`f`) message in one write, in order. */
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
  /** Every frame the SDK wrote, decoded from the wire. */
  readonly frames: WireFrame[] = []
  /** The capability reply this pane answers the SDK's probe with. */
  readonly hello: unknown

  constructor(hello: unknown = HELLO) {
    this.hello = hello
    this.output.onWrite = bytes => {
      const text = DECODER.decode(bytes)
      if (text.includes('\u001b[c')) {
        // The official capability probe: answer as a supported Tern pane.
        setTimeout(() => this.input.type(`\u001b_tsp;r;${JSON.stringify(this.hello)}\u001b\\\u001b[?62;52;c`), 1)
        return
      }
      for (const frame of decodeFrames(text)) {
        this.frames.push(frame)
        // A real pane acks each frame it drew: credit flow control allows at
        // most `credits` unacknowledged frames ahead.
        setTimeout(() => this.input.type(
          `\u001b_tsp;e;${JSON.stringify({ ev: 'ack', sf: frame.sf, s: frame.s })}\u001b\\`,
        ), 0)
      }
    }
  }
}

/** Open the real SDK surface on the scripted pane (an isolated tty owner). */
async function openTern(tern: ScriptedTern) {
  const session = await connect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')
  return { session, surface: session.open({ mode: 'inline' }) }
}

/**
 * The dev/test TSP bridge: the ONLY consumer of the PR2 frame. It re-scopes its
 * replay-local node keys per projection SOURCE (never across subjects) and
 * renders through the REAL SDK surface. It reads no Host, fold or window state.
 */
function createBridge(surface: { render(view: Renderable): void }) {
  const state = { keys: undefined as TranscriptNodeKeys | undefined, scope: undefined as object | undefined, renders: 0 }
  return {
    state,
    project(frame: TranscriptProjectionFrame): void {
      if (frame.sourceIdentity !== state.scope) {
        state.scope = frame.sourceIdentity
        state.keys = new TranscriptNodeKeys()
      }
      state.renders += 1
      surface.render({ main: transcriptView(projectTranscriptStructure(frame.messages), state.keys!) })
    },
  }
}

/** Let queued input (handshake, acks) and the SDK's pumps settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await new Promise(resolve => setTimeout(resolve, 2))
}

/** Wait past the surface's ONE 50 ms repaint coalescing window. */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 80))
}

// ── P2-01 / P2-02: the real application event chain reaches the real sink ──

test('a routed durable tool call reaches the real SDK sink through the live projection', async () => {
  const tern = new ScriptedTern()
  const { session, surface: sdk } = await openTern(tern)
  const bridge = createBridge(sdk)
  const harness = mountHarness({ onTranscriptProjected: frame => bridge.project(frame) })
  try {
    route(harness, ev('turn/start', { turn: 1 }, 0))
    route(harness, userMessage(1, 'user-1', 'Inspect the transcript projector boundary.'))
    harness.surface.paintNow()
    route(harness, toolCall(2, 'call-read-1', 'read', { file_path: 'src/tui/transcript/structure.ts' }))
    harness.surface.paintNow()
    const beforeResult = tern.frames.length

    route(harness, toolResult(3, 'call-read-1', 'file content'))
    harness.surface.paintNow()
    await settle()

    // The observer received exactly the arrays the mounted app committed.
    assert.ok(harness.frames.length >= 3, 'every commit published one frame')
    assert.equal(harness.frames.length, harness.committed.length)
    for (const [index, frame] of harness.frames.entries()) {
      assert.equal(frame.messages, harness.committed[index], `frame ${index} carries the committed array itself`)
    }
    assert.deepEqual(
      harness.frames.map(frame => [frame.subjectKind, frame.subjectId]),
      harness.frames.map(() => ['main', SESSION_ID]),
      'every frame is scoped to the live main session, never inferred from a row',
    )
    assert.equal(harness.frames[0]!.sourceIdentity, harness.frames[1]!.sourceIdentity,
      'one projection source keeps one identity across frames')
    assert.notEqual(harness.frames[0]!.sourceIdentity, harness.folder,
      'the observer never receives the mutable fold instance')

    // The REAL SDK surface rendered those frames on the wire: the settled tool
    // card is a small delta on a retained node (no delete, no move).
    assert.ok(tern.frames.length > beforeResult, 'the settled result reached the wire as a new frame')
    const settled = tern.frames[tern.frames.length - 1]!
    const ops = settled.ops
    assert.equal(ops.filter(op => op[0] === 'del').length, 0, 'the settled update deletes nothing')
    assert.equal(ops.filter(op => op[0] === 'move').length, 0, 'the settled update moves nothing')
    const statusSets = ops.filter(op => op[0] === 'set'
      && (op[2] as { readonly status?: unknown }).status === 'done')
    assert.equal(statusSets.length, 1, 'exactly one retained tool node is settled to done')
    assert.ok(tern.output.text().includes('"k":"tool"'), 'the wire carries the native tool node')
    assert.deepEqual(tern.input.raw, [true], 'the SDK owns raw mode on its own tty while connected')

    // The SDK session releases the tty it took (the product never does this on
    // the PiTui terminal).
    await sdk.close({ keep: false })
    await session.close()
    assert.deepEqual(tern.input.raw, [true, false], 'the SDK restored raw mode on its own tty')
    assert.ok(tern.output.text().includes('\u001b_tsp;x;'), 'the surface closed with `x`')
  } finally {
    harness.dispose()
  }
})

// ── P2-03: the live assistant input path ────────────────────────────────────

test('a live assistant delta routed by the real input path updates the same projection', async () => {
  const tern = new ScriptedTern()
  const { session, surface: sdk } = await openTern(tern)
  const bridge = createBridge(sdk)
  const harness = mountHarness({ onTranscriptProjected: frame => bridge.project(frame) })
  try {
    route(harness, ev('turn/start', { turn: 1 }, 0))
    route(harness, userMessage(1, 'user-1', 'Explain the boundary.'))
    harness.surface.paintNow()

    // The identity fence the Direct install consults before routing a stream.
    const agent = { session: { id: SESSION_ID } }
    assert.equal(harness.surface.isCurrentAssistantAgent(agent), false, 'an unregistered Agent is never current')
    const framesBefore = harness.frames.length
    harness.surface.applyAssistantInput(liveChunk({ type: 'block-start', index: 0, blockType: 'text' }))
    harness.surface.applyAssistantInput(liveChunk({ type: 'text-delta', index: 0, text: 'the projector' }))
    harness.surface.paintNow()
    assert.equal(harness.frames.length, framesBefore + 1, 'the live start and delta coalesced into the ONE commit')

    harness.surface.applyAssistantInput(liveChunk({ type: 'text-delta', index: 0, text: ' boundary' }))
    harness.surface.paintNow()
    await settle()

    assert.equal(harness.frames.length, framesBefore + 2, 'the second commit grew the same streaming card')
    const frame = harness.frames[harness.frames.length - 1]!
    const streaming = frame.messages.find(message => message.kind === 'assistant')
    assert.ok(streaming !== undefined, 'the streaming assistant row is in the projection')
    assert.equal(streaming.text, 'the projector boundary')

    const last = tern.frames[tern.frames.length - 1]!
    const textOps = last.ops.filter(op => op[0] === 'text')
    assert.ok(textOps.length >= 1, 'the growing text rides an SDK text op on the retained card')
    assert.equal(last.ops.filter(op => op[0] === 'del').length, 0, 'the stream never rebuilds the card')
    assert.equal(last.ops.filter(op => op[0] === 'move').length, 0, 'the stream never moves the card')
  } finally {
    harness.dispose()
    await sdk.close({ keep: false })
    await session.close()
  }
})

// ── P2-04: the existing fences still decide ─────────────────────────────────

test('an event from a session the surface is not attached to publishes nothing', async () => {
  const seen: TranscriptProjectionFrame[] = []
  const harness = mountHarness({ onTranscriptProjected: frame => void seen.push(frame) })
  try {
    route(harness, ev('turn/start', { turn: 1 }, 0))
    harness.surface.paintNow()
    const baseline = seen.length
    assert.equal(baseline, 1)

    // A stale/late event for another Session never reaches the fold AND never
    // schedules a repaint (asserted through the coalescing window, not a flag).
    const other = { id: 'session-other' }
    harness.surface.routeSessionEvent(other, userMessage(9, 'user-9', 'stale'))
    // A live delta for another Session is dropped by the neutral routing too.
    harness.surface.applyAssistantInput(liveChunk({ type: 'text-delta', index: 0, text: 'stale' }, 'session-other'))
    await flush()
    assert.equal(seen.length, baseline, 'neither the foreign durable event nor its stream repaints the surface')
    assert.equal(hasUserText(harness.folder.messages(), 'stale'), false, 'the foreign content never entered the fold')
  } finally {
    harness.dispose()
  }
})

// ── P2-05: main <-> viewed child ────────────────────────────────────────────

test('the viewed child and the main session each publish their own scope', () => {
  const seen: TranscriptProjectionFrame[] = []
  const harness = mountHarness({ onTranscriptProjected: frame => void seen.push(frame) })
  try {
    route(harness, ev('turn/start', { turn: 1 }, 0))
    route(harness, userMessage(1, 'user-1', 'main prompt'))
    harness.surface.paintNow()
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.subjectKind, 'main')
    const mainIdentity = seen[0]!.sourceIdentity

    const child = harness.viewChild()
    harness.surface.routeSessionEvent(CHILD_SESSION, ev('turn/start', { turn: 1 }, 0))
    harness.surface.routeSessionEvent(CHILD_SESSION, userMessage(1, 'child-1', 'child prompt'))
    harness.surface.routeSessionEvent(CHILD_SESSION, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2))

    const childFrames = seen.slice(1)
    assert.ok(childFrames.length > 0, 'the viewed child published while mounted')
    for (const frame of childFrames) {
      assert.equal(frame.subjectKind, 'viewed-child')
      assert.equal(frame.subjectId, CHILD_ID)
      assert.equal(frame.sourceIdentity, childFrames[0]!.sourceIdentity, 'the child keeps one identity')
      assert.notEqual(frame.sourceIdentity, mainIdentity, 'the child scope is not the main scope')
      assert.notEqual(frame.sourceIdentity, child, 'the child fold itself is never handed out')
    }
    assert.ok(childFrames.some(frame => hasUserText(frame.messages, 'child prompt')))

    // A main-session event still folds into the MAIN transcript while the child
    // is displayed; the ACTIVE projection stays the child's (the displayed
    // subject owns the pane), exactly as the production selection does.
    route(harness, userMessage(4, 'user-4', 'main continues'))
    harness.surface.paintNow()
    assert.ok(hasUserText(harness.folder.messages(), 'main continues'),
      'the main fold kept updating behind the viewer')
    assert.equal(seen[seen.length - 1]!.subjectKind, 'viewed-child', 'the displayed subject still owns the pane')

    harness.exitChild()
    harness.surface.paintNow()
    const back = seen[seen.length - 1]!
    assert.equal(back.subjectKind, 'main', 'leaving the viewer republishes the main subject')
    assert.equal(back.sourceIdentity, mainIdentity, 'the main fold keeps its identity across the viewer round trip')
    assert.ok(hasUserText(back.messages, 'main continues'), 'the main projection carries the hidden update')
  } finally {
    harness.dispose()
  }
})

// ── P2-10: a commit that switches the subject drops the stale frame ─────────

test('a subject switch performed synchronously inside setTranscript drops the stale frame', () => {
  const seen: TranscriptProjectionFrame[] = []
  let child: TranscriptFolder | undefined
  const harness = mountHarness({
    onTranscriptProjected: frame => void seen.push(frame),
    duringCommit: () => {
      // The commit runs plugin/modal callbacks: entering the viewer here must
      // discard the frame that was projected for the OLD target.
      child ??= harness.viewChild()
    },
  })
  try {
    route(harness, ev('turn/start', { turn: 1 }, 0))
    route(harness, userMessage(1, 'user-1', 'main prompt'))
    assert.equal(seen.length, 0, 'nothing is published before the mounted app committed')
    harness.surface.paintNow()
    assert.equal(seen.length, 0, 'the main frame was dropped: the surface had already left the main subject')

    // The next commit projects the CHILD (the viewer is mounted now).
    harness.surface.routeSessionEvent(CHILD_SESSION, ev('turn/start', { turn: 1 }, 0))
    harness.surface.routeSessionEvent(CHILD_SESSION, userMessage(1, 'child-1', 'child prompt'))
    harness.surface.routeSessionEvent(CHILD_SESSION, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2))
    assert.ok(seen.length > 0, 'the child projection is published')
    assert.equal(seen[seen.length - 1]!.subjectKind, 'viewed-child')
    assert.notEqual(seen[seen.length - 1]!.sourceIdentity, child, 'the child fold itself is never handed out')
  } finally {
    harness.dispose()
  }
})

// ── P2-10: a synchronous OWNER change never relabels the stale frame ────────

/**
 * SCOPE of this case: it proves that a frame whose commit is INTERRUPTED by a
 * subject handover is DROPPED (the captured, still-displayed fold is never
 * relabelled with the new subject's id), and that a later repaint publishes
 * under the CURRENT subject.
 *
 * It does NOT prove that the new subject has its own hydrated transcript: this
 * fixture deliberately keeps A's fold and window mounted (no B hydration), and
 * because the fold is not replaced the source identity is unchanged. Fold
 * replacement and source re-scoping are covered by P2-06/P2-07 (and the real
 * hydration paths by P2-01/P2-07).
 */
test('an owner handover under the SAME fold/window drops the interrupted frame', () => {
  const seen: TranscriptProjectionFrame[] = []
  const harness = mountHarness({ onTranscriptProjected: frame => void seen.push(frame) })
  try {
    route(harness, ev('turn/start', { turn: 1 }, 0))
    route(harness, userMessage(1, 'user-1', 'owner A prompt'))
    harness.surface.paintNow()
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.subjectId, SESSION_ID)

    // The commit's synchronous callback hands the session over to B while A's
    // fold AND window are still mounted (B is not hydrated yet): the source
    // objects are unchanged, only the SUBJECT identity moved.
    harness.armCommitHook(() => harness.handoverOwner('session-owner-b'))
    harness.surface.paintNow()
    assert.equal(seen.length, 1, 'the interrupted frame is dropped: A\'s messages are never relabelled with B\'s subject id')
    harness.armCommitHook(undefined)

    // A later repaint publishes again, under the CURRENT subject. The fold is
    // still A's (B was never hydrated in this fixture), so the identity token is
    // unchanged — that is the low-level contract this case covers, not a claim
    // that B's own transcript exists.
    harness.surface.paintNow()
    assert.equal(seen.length, 2, 'the current subject publishes normally')
    assert.equal(seen[1]!.subjectId, 'session-owner-b')
    assert.equal(seen[0]!.sourceIdentity, seen[1]!.sourceIdentity,
      'the same (still-mounted) fold keeps its identity: only the subject identity moved')
  } finally {
    harness.dispose()
  }
})

// ── P2-06 / P2-07: a replaced fold under the SAME session id ────────────────

test('a replaced fold under the SAME session id is a new projection scope', () => {
  const seen: TranscriptProjectionFrame[] = []
  const harness = mountHarness({ onTranscriptProjected: frame => void seen.push(frame) })
  try {
    route(harness, ev('turn/start', { turn: 1 }, 0))
    route(harness, userMessage(1, 'user-1', 'before the replacement'))
    harness.surface.paintNow()
    const before = seen[seen.length - 1]!
    assert.equal(before.subjectId, SESSION_ID)
    const stale = harness.folder

    // A session commit / cold rehydrate replaces the fold while the Session id
    // stays the same (the ONE window controller is re-bound to the new fold).
    harness.replaceMain()
    assert.notEqual(harness.folder, stale, 'the fold instance really was replaced')

    route(harness, userMessage(1, 'user-1', 'after the replacement'))
    harness.surface.paintNow()
    const after = seen[seen.length - 1]!
    assert.equal(after.subjectId, SESSION_ID, 'the Session id did NOT change')
    assert.notEqual(after.sourceIdentity, before.sourceIdentity,
      'the replaced source is a NEW scope: the same id is never the same view')
    assert.ok(hasUserText(after.messages, 'after the replacement'), 'the new fold projects its own window')
    assert.ok(!hasUserText(after.messages, 'before the replacement'), 'the new fold does not inherit the old window')

    // The replacement is stable and the stale fold receives nothing afterwards.
    route(harness, userMessage(2, 'user-2', 'later'))
    harness.surface.paintNow()
    assert.equal(seen[seen.length - 1]!.sourceIdentity, after.sourceIdentity, 'the new source keeps one identity')
    assert.equal(hasUserText(stale.messages(), 'later'), false, 'the replaced fold is no longer the projection source')
  } finally {
    harness.dispose()
  }
})

// ── P2-09: coalescing and the unchanged projection ──────────────────────────

test('coalesced repaints keep one commit per flush, and an unchanged projection sends no ops', async () => {
  const tern = new ScriptedTern()
  const { session, surface: sdk } = await openTern(tern)
  const bridge = createBridge(sdk)
  const harness = mountHarness({ onTranscriptProjected: frame => bridge.project(frame) })
  try {
    route(harness, ev('turn/start', { turn: 1 }, 0))
    route(harness, userMessage(1, 'user-1', 'one'))
    harness.surface.paintNow()
    assert.equal(harness.committed.length, 1)
    await settle()
    const wireBefore = tern.frames.length

    // Three durable events inside one flush window: the surface still commits
    // ONCE (the production 50 ms coalescing owns the schedule).
    route(harness, userMessage(4, 'user-4', 'two'))
    route(harness, toolCall(5, 'call-bash-1', 'bash', { command: 'true' }))
    route(harness, toolResult(6, 'call-bash-1', 'ok'))
    await flush()
    assert.equal(harness.committed.length, 2, 'the three events coalesced into one commit')

    // An extra repaint of the unchanged projection publishes a frame but the
    // SDK sends NO ops for it: the wire grows by nothing.
    const framesBeforeRepaint = tern.frames.length
    harness.surface.paintNow()
    await flush()
    assert.equal(harness.committed.length, 3, 'the repaint committed again')
    assert.equal(tern.frames.length, framesBeforeRepaint, 'an identical view is zero ops on the wire')
    assert.ok(tern.frames.length > wireBefore)
  } finally {
    harness.dispose()
    await sdk.close({ keep: false })
    await session.close()
  }
})

// ── P2-11: dispose releases the observer ────────────────────────────────────

test('dispose releases the read-only observer, so no later projection reaches the sink', async () => {
  const seen: TranscriptProjectionFrame[] = []
  const harness = mountHarness({ onTranscriptProjected: frame => void seen.push(frame) })
  try {
    route(harness, ev('turn/start', { turn: 1 }, 0))
    harness.surface.paintNow()
    assert.equal(seen.length, 1)

    harness.surface.dispose()
    const before = harness.committed.length
    harness.surface.routeSessionEvent(SESSION, userMessage(2, 'user-2', 'late'))
    // The routing still schedules a repaint for the late event, so wait past
    // the coalescing window: the frame must be dropped by the released
    // observer, not merely by the timer never firing.
    await flush()
    assert.equal(seen.length, 1, 'no frame is published after dispose')
    assert.ok(harness.committed.length >= before)
  } finally {
    harness.dispose()
  }
})

// ── P2-12 / P2-14: tty isolation and the product boundary ───────────────────

test('the TSP sink owns its own tty and no product source imports the SDK', async () => {
  const tern = new ScriptedTern()
  const { session, surface: sdk } = await openTern(tern)
  const bridge = createBridge(sdk)
  const harness = mountHarness({ onTranscriptProjected: frame => bridge.project(frame) })
  try {
    route(harness, ev('turn/start', { turn: 1 }, 0))
    route(harness, userMessage(1, 'user-1', 'hello'))
    harness.surface.paintNow()
    await settle()

    assert.notEqual(harness.vt, tern.input, 'PiTui and the SDK never share one input')
    assert.notEqual(harness.vt, tern.output, 'PiTui and the SDK never share one output')
    assert.ok(harness.vt.getViewport().some(line => line.length > 0), 'PiTui still renders to its own terminal')
    const wire = tern.frames.length
    const delivered = tern.input.received.length
    harness.vt.sendInput('x')
    await settle()
    assert.equal(tern.frames.length, wire, 'a PiTui keystroke never reaches the TSP session')
    assert.equal(tern.input.received.length, delivered, 'the SDK tty received nothing from the PiTui terminal')
    await sdk.close({ keep: false })
    await session.close()
    assert.deepEqual(tern.input.raw, [true, false], 'only the SDK tty entered and left raw mode')
  } finally {
    harness.dispose()
  }

  // PR3-A: the SDK now legitimately lives in the product graph, but ONLY in
  // the TSP renderer module (src/tui/tsp/**); everywhere else in src/** the
  // specifier stays forbidden, and the production composition still never
  // injects the PR2 observer.
  const sources: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) sources.push(path)
    }
  }
  walk(join(ROOT, 'src'))
  assert.ok(sources.length > 0)
  for (const path of sources) {
    if (relative(ROOT, path).replaceAll('\\', '/').startsWith('src/tui/tsp/')) continue
    assert.doesNotMatch(readFileSync(path, 'utf8'), /@stencil-hq\/tern/u, `${relative(ROOT, path)} must not import the TSP SDK`)
  }
  const bootstrap = readFileSync(join(ROOT, 'src', 'app', 'bootstrap.ts'), 'utf8')
  assert.doesNotMatch(bootstrap, /onTranscriptProjected/u, 'the production composition never injects the PR2 observer')
})

// ── P2-01 / P2-07: the REAL SessionPresentation hydration paths ─────────────

interface PresentationHarness {
  readonly surface: SurfaceRuntime<SessionEvent>
  readonly presentation: SessionPresentation<SessionEvent>
  readonly app: TuiApp
  readonly vt: VirtualTerminal
  readonly frames: TranscriptProjectionFrame[]
  readonly committed: Array<readonly TranscriptMessage[]>
  /** Replace the Remote reader's CURRENT window with its real event range. */
  setWindow(events: readonly SessionEvent[], hasMore: boolean): void
  /** Flip the ownership-generation fence the Remote commit is checked against. */
  setCurrent(value: boolean): void
  /** Run `fn` while the NEXT Remote read is pending (fence captured, commit not run). */
  onMidRead(fn: (() => void) | undefined): void
  /** The production Direct cold hydration (`initLiveSession`). */
  initDirect(events: readonly SessionEvent[]): Promise<void>
  /** The production Remote cold hydration (`initLiveRemoteSession`). */
  initRemote(): Promise<void>
  /** The production Remote rehydrate after an older-history page (`rehydrateFromWindow`). */
  rehydrate(): Promise<void>
  mainFolder(): TranscriptFolder
  mainWindow(): TranscriptWindowController
  /** How many times the production fold was asked for a window (the ONE
   *  projection call of each repaint; the observer must add none). */
  windowCalls(): number
  dispose(): void
}

/**
 * Mount the REAL `SurfaceRuntime` + `TuiApp` over a REAL `SessionPresentation`:
 * the production hydration owns the main transcript fold and its repaint goes
 * through the same `repaintTarget()` the observer hangs off. Only the runners'
 * capabilities (status/history/commands/viewer/diagnostics) and the Remote
 * reader snapshot are stand-ins.
 */
function mountPresentationHarness(options: {
  readonly sessionId: string
  readonly onTranscriptProjected: (frame: TranscriptProjectionFrame) => void
}): PresentationHarness {
  const vt = new VirtualTerminal(100, 30)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  const frames: TranscriptProjectionFrame[] = []
  const committed: Array<readonly TranscriptMessage[]> = []
  let window: PresentationReadSnapshot | undefined
  let current = true
  let midRead: (() => void) | undefined
  const liveTransportToken: unknown = { generation: 1 }
  // Count the production fold's projection calls: every repaint projects ONCE
  // through `folder.window()`, and the observer must never add another.
  const folderPrototype = TranscriptFolder.prototype as unknown as {
    window: (...args: never[]) => unknown
  }
  const originalFolderWindow = folderPrototype.window
  let windowCalls = 0
  folderPrototype.window = function (this: unknown, ...args: never[]): unknown {
    windowCalls += 1
    return originalFolderWindow.apply(this, args)
  }

  const surface = createSurfaceRuntime<SessionEvent>({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation,
    notificationMode: undefined,
    mainProgressAuthority: 'local-events',
    notificationMethod: undefined,
    terminalProgress: undefined,
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
    onTranscriptProjected: frame => {
      frames.push(frame)
      options.onTranscriptProjected(frame)
    },
  })

  const noop = (): void => {}
  const diag = { info: noop, warn: noop, error: noop, debug: noop, dispose: noop } as unknown as Diag
  const presentation = createSessionPresentation<SessionEvent>({
    surface,
    diag,
    summaryKeys: toolSummaryKeys,
    isCleanedUp: () => false,
    refreshStatusCheap: noop,
    folds: { title: () => undefined },
    direct: {
      installModelSelection: noop,
      assistantStreamBaselineFor: () => [],
      planActive: () => false,
      effectiveCwd: (agent) => agent.session.header.cwd,
    },
    status: {
      setGoalText: noop,
      refresh: noop,
      refreshTerminalTitle: noop,
      refreshTerminalCwd: noop,
      updateWelcomeCard: noop,
      scheduleInitialMeasurement: noop, markContextDirty: noop, refreshContextMeasurement: noop,
    },
    history: { rememberCwd: noop, currentCwd: () => '/tmp', records: () => [], setLastContent: noop },
    commands: { register: noop },
    submission: { clearPending: noop },
    viewer: { resetAutoPop: noop, teardownForSessionSwap: noop },
    remote: {
      read: async () => {
        // Resolve on a later microtask so a mid-read hook can move the ownership
        // generation between the fence capture (before the await) and the commit.
        if (midRead !== undefined) {
          const hook = midRead
          midRead = undefined
          await Promise.resolve()
          hook()
        }
        return window
      },
      running: () => false,
      plan: () => false,
      facts: () => ({}),
      captureTransportToken: () => liveTransportToken,
      isTransportTokenCurrent: (_sessionId, token) => Object.is(token, liveTransportToken),
      isStillCurrent: () => current,
      // S3-R0: the widened-window commit is valid only while the official window
      // still IS the revision the reader returned (this harness models a
      // current window; the staleness cases are driven by the fences above).
      windowRefoldProof: (_sessionId: string, revision: number) => ({
        generation: 1,
        binding: liveTransportToken,
        revision,
      }),
    },
  })

  const source: SurfaceEventRoutingSource<SessionEvent> = {
    isCleanedUp: () => false,
    isAttachedSession: session => session.id === options.sessionId,
    currentSessionId: () => options.sessionId,
    hasLiveAgent: () => true,
    completionOwnerId: () => undefined,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => presentation.main,
    viewedChildId: () => undefined,
    viewedChild: () => { throw new Error('the presentation fixture has no child viewer') },
    mainFolder: () => presentation.mainFolder(),
    viewedChildFolder: () => { throw new Error('the presentation fixture has no child viewer') },
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
    markContextDirty: noop,
    refreshContextMeasurement: noop,
    currentWorkingFromLog: () => false,
    flushTurn: noop,
    registeredAgentIs: () => false,
    isCurrentOwnerAgent: () => false,
    viewedChildAgent: () => undefined,
    setViewedChildAgent: noop,
    setViewedQueueAgent: noop,
    agentForSession: () => undefined,
    applyViewedChildAssistantInput: noop,
    applyMainAssistantInput: noop,
  }
  surface.attachEventRouting(source)
  surface.start({
    events: { onSubmit: () => {}, onExit: () => {} },
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised by this test')) },
    readImage: () => Promise.reject(new Error('not exercised by this test')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    captureHistoryScope: () => ({ sessionId: options.sessionId, isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: async () => false,
    deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: text => text,
  })

  const app = surface.app
  const prototype = Object.getPrototypeOf(app) as { setTranscript: TuiApp['setTranscript'] }
  const originalSetTranscript = prototype.setTranscript
  app.setTranscript = (...args: Parameters<TuiApp['setTranscript']>) => {
    committed.push(args[0])
    return originalSetTranscript.call(app, ...args)
  }

  return {
    surface,
    presentation,
    app,
    vt,
    frames,
    committed,
    setWindow(events, hasMore) {
      window = Object.freeze({
        sessionId: options.sessionId,
        durableEvents: Object.freeze([...events]),
        liveInputs: Object.freeze([] as readonly AssistantLiveInput[]),
        revision: 1,
        coverage: 'bounded',
        hasMore,
        loadingOlder: false,
        openState: 'open',
      })
    },
    setCurrent(value) { current = value },
    onMidRead(fn) { midRead = fn },
    async initDirect(events) {
      await presentation.initLiveSession({
        session: { id: options.sessionId, header: { cwd: '/tmp' }, snapshotEvents: () => events },
      })
    },
    async initRemote() { await presentation.initLiveRemoteSession(options.sessionId) },
    async rehydrate() { await presentation.rehydrateFromWindow(options.sessionId) },
    mainFolder: () => presentation.mainFolder(),
    mainWindow: () => presentation.mainWindow(),
    windowCalls: () => windowCalls,
    dispose() {
      folderPrototype.window = originalFolderWindow
      surface.dispose()
      restoreTerminal()
    },
  }
}

test('the production Direct cold hydration publishes the first projection', async () => {
  const tern = new ScriptedTern()
  const { session, surface: sdk } = await openTern(tern)
  const bridge = createBridge(sdk)
  const harness = mountPresentationHarness({
    sessionId: SESSION_ID,
    onTranscriptProjected: frame => bridge.project(frame),
  })
  try {
    const hydrated = [
      ev('turn/start', { turn: 1 }, 0),
      userMessage(1, 'user-1', 'cold hydrated prompt'),
      assistantMessage(2, 'assistant-1', 'cold hydrated answer'),
    ]
    await harness.initDirect(hydrated)
    await settle()

    assert.equal(harness.committed.length, 1, 'the hydration commit is the ONLY commit')
    assert.equal(harness.frames.length, 1, 'the cold hydration published exactly one frame')
    const frame = harness.frames[0]!
    assert.equal(frame.subjectKind, 'main')
    assert.equal(frame.subjectId, SESSION_ID)
    assert.equal(frame.messages, harness.committed[0], 'the frame carries the committed array itself')
    assert.ok(hasUserText(frame.messages, 'cold hydrated prompt'), 'the hydrated prompt is in the first projection')
    assert.ok(frame.messages.some(message => message.kind === 'assistant'), 'the hydrated answer is in the first projection')
    assert.equal(harness.windowCalls(), 1,
      'the first projection asked the fold for a window exactly once: the observer added no second projection')
    assert.equal(harness.mainFolder().messages().length, frame.messages.length,
      'the observed projection is the fold the production hydration installed')
    assert.ok(tern.frames.length > 0, 'the hydrated first projection rendered through the real SDK')
  } finally {
    harness.dispose()
    await sdk.close({ keep: false })
    await session.close()
  }
})

test('the production Remote rehydrate publishes the widened window as a new scope', async () => {
  const tern = new ScriptedTern()
  const { session, surface: sdk } = await openTern(tern)
  const bridge = createBridge(sdk)
  const harness = mountPresentationHarness({
    sessionId: REMOTE_ID,
    onTranscriptProjected: frame => bridge.project(frame),
  })
  try {
    const tail = [
      ev('turn/start', { turn: 2 }, 8),
      userMessage(9, 'u-tail', 'tail prompt'),
      assistantMessage(10, 'a-tail', 'tail answer'),
    ]
    const older = [
      ev('turn/start', { turn: 1 }, 0),
      userMessage(1, 'u-older', 'older prompt'),
      assistantMessage(2, 'a-older', 'older answer'),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
    ]

    // The FIRST bounded window: the newer tail only, older history unpaged.
    harness.setWindow(tail, true)
    await harness.initRemote()
    await settle()
    assert.equal(harness.frames.length, 1)
    const first = harness.frames[0]!
    assert.equal(first.subjectId, REMOTE_ID)
    assert.ok(hasUserText(first.messages, 'tail prompt'), 'the window tail is projected')
    assert.equal(hasUserText(first.messages, 'older prompt'), false, 'the unpaged history is not projected')
    const controllerBefore = harness.mainWindow()
    const staleFolder = harness.mainFolder()
    const projectionsBefore = harness.windowCalls()

    // The older page joins the reader window: the production rehydrate replaces
    // the fold itself.
    harness.setWindow([...older, ...tail], false)
    await harness.rehydrate()
    await settle()
    assert.equal(harness.frames.length, 2, 'the widened window published')
    assert.equal(harness.windowCalls(), projectionsBefore + 1,
      'the widened window projected exactly once: no extra re-fold from the seam')
    const second = harness.frames[1]!
    assert.equal(second.subjectId, REMOTE_ID, 'the Session id did not change')
    assert.notEqual(second.sourceIdentity, first.sourceIdentity, 'the widened window is a NEW fold scope')
    assert.notEqual(harness.mainFolder(), staleFolder, 'the production rehydrate installed a new fold')
    assert.equal(harness.mainWindow(), controllerBefore, 'the ONE window controller is retained and re-bound')
    assert.ok(hasUserText(second.messages, 'older prompt'), 'the widened window projects the earlier history')
    assert.ok(hasUserText(second.messages, 'tail prompt'), 'the newer tail is preserved')
    assert.equal(second.messages, harness.committed[1], 'the frame carries the committed array itself')

    // A later ordinary repaint stays on the new scope.
    harness.surface.paintNow()
    assert.equal(harness.frames[2]!.sourceIdentity, second.sourceIdentity, 'the new source keeps one identity')
    assert.ok(hasUserText(harness.frames[2]!.messages, 'older prompt'))
  } finally {
    harness.dispose()
    await sdk.close({ keep: false })
    await session.close()
  }
})

test('a stale Remote read installs no fold and publishes nothing', async () => {
  const seen: TranscriptProjectionFrame[] = []
  const harness = mountPresentationHarness({
    sessionId: REMOTE_ID,
    onTranscriptProjected: frame => void seen.push(frame),
  })
  try {
    const tail = [
      ev('turn/start', { turn: 2 }, 8),
      userMessage(9, 'u-tail', 'tail prompt'),
    ]
    const older = [
      ev('turn/start', { turn: 1 }, 0),
      userMessage(1, 'u-older', 'older prompt'),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
    ]
    harness.setWindow(tail, true)
    await harness.initRemote()
    assert.equal(seen.length, 1)
    const installed = harness.mainFolder()

    // The ownership generation moves (a session switch/rollover) while the
    // widening read is in flight: the commit must be dropped by the §6.5 fence.
    harness.setWindow([...older, ...tail], false)
    harness.onMidRead(() => harness.setCurrent(false))
    await harness.rehydrate()
    assert.equal(seen.length, 1, 'the stale widening published nothing')
    assert.equal(harness.mainFolder(), installed, 'the stale read installed no new fold')

    // A current read still commits.
    harness.setCurrent(true)
    await harness.rehydrate()
    assert.equal(seen.length, 2, 'the current widening commits')
    assert.ok(hasUserText(seen[1]!.messages, 'older prompt'))
  } finally {
    harness.dispose()
  }
})

// ── F10: the pending refresh only scrolls for NEW OWN input (PiTui default) ──

test('a background pending refresh never yanks the reader; a new own echo does', async () => {
  const ownEcho = (requestId: string, text: string): SubmissionPresentationItem => ({
    requestId,
    placement: 'transcript',
    text,
    createdAt: 1,
    attachments: [],
    foldableText: true,
  })
  let echoes: readonly SubmissionPresentationItem[] | undefined
  let snapshot: { readonly running: boolean; readonly items: readonly unknown[] } | undefined
  const harness = mountHarness({
    onTranscriptProjected: () => {},
    pending: {
      subjectId: SESSION_ID,
      echoes: () => echoes,
      snapshot: () => snapshot,
    },
  })
  try {
    const app = harness.app
    const prototype = Object.getPrototypeOf(app) as { scrollToBottom: TuiApp['scrollToBottom'] }
    const original = prototype.scrollToBottom
    let scrolls = 0
    app.scrollToBottom = (...args: Parameters<TuiApp['scrollToBottom']>) => {
      scrolls += 1
      return original.call(app, ...args)
    }
    try {
      // An empty refresh (another client's activity) never moves the viewport.
      harness.surface.refreshPendingInput()
      assert.equal(scrolls, 0, 'an empty refresh never scrolls')

      // An authoritative BACKGROUND `context` occurrence is not own input.
      snapshot = {
        running: true,
        items: [{ id: 'bg-1', placement: 'context', content: [{ type: 'text', text: 'background context' }] }],
      }
      harness.surface.refreshPendingInput()
      harness.surface.refreshPendingInput()
      assert.equal(scrolls, 0, 'a background Context occurrence never scrolls (even repeated)')

      // A NEW client-local own echo takes the viewport exactly once.
      echoes = [ownEcho('local-1', 'my own input')]
      harness.surface.refreshPendingInput()
      assert.equal(scrolls, 1, 'a NEW own echo scrolls exactly once')
      harness.surface.refreshPendingInput()
      assert.equal(scrolls, 1, 'an unchanged own echo does not scroll again')
    } finally {
      app.scrollToBottom = original
    }
  } finally {
    harness.dispose()
  }
})

// ── R2-2: ONE atomic display-subject commit on the PiTui branch ─────────────

test('surface.commitStatus publishes ONE atomic store transaction on PiTui', async () => {
  const harness = mountHarness({ onTranscriptProjected: () => {} })
  try {
    // A MAIN commit first, so the store starts from a known subject.
    harness.surface.commitStatus({ workspace: { cwd: '/w' } } as never, {}, undefined)
    const notifications: { subject: string; todoCount: number }[] = []
    const unsubscribe = harness.surface.status.subscribe(() => {
      const snapshot = harness.surface.status.snapshot()
      notifications.push({
        subject: snapshot.view.subject.kind,
        todoCount: snapshot.activity.todoCount,
      })
    })
    try {
      // The CHILD commit: the presentation projection plus the store patch are
      // ONE transaction. A pre-empting store write would publish an
      // intermediate snapshot (child subject beside the parent activity).
      harness.surface.commitStatus(
        {
          collaboration: { plan: { effective: true } },
          view: { subject: { kind: 'subagent', id: CHILD_ID, mode: 'continuable' } },
        } as never,
        {},
        {
          sessionId: CHILD_ID,
          title: 'child title',
          workspaceRoot: '/w',
          todos: [
            { content: 'child todo one', status: 'pending' },
            { content: 'child todo two', status: 'pending' },
          ],
        } as never,
      )
      await settle()
    } finally {
      unsubscribe()
    }
    assert.equal(notifications.length, 1,
      `exactly ONE store transaction per commitStatus (saw ${JSON.stringify(notifications)})`)
    assert.equal(notifications[0]!.subject, 'subagent',
      'the single published snapshot already carries the child display subject')
    assert.equal(notifications[0]!.todoCount, 2,
      'and the SAME snapshot already carries the child activity (never a parent-activity intermediate)')
  } finally {
    harness.dispose()
  }
})

// ── PR-B3: the live Preparing projection reaches the MOUNTED TSP renderer ─────
//
// This is the application-level chain of the Preparing rows: an official-shaped
// `tool-call-delta` arrives on the live assistant-stream seam, the PRODUCTION
// preview owner extracts the name/summary/bytes, the surface's ONE repaint
// hands the snapshot to the display seam, and the MOUNTED TSP renderer emits
// the native row on the real wire. Nothing here injects a pre-decided
// "attached" flag or a pre-rendered node.

/** The scripted pane's capability reply, with the native kinds this lane uses. */
const PREPARING_HELLO = {
  ...HELLO,
  kinds: [...HELLO.kinds, 'row', 'text'],
}

interface PreparingHarness {
  readonly surface: SurfaceRuntime<SessionEvent>
  readonly tern: ScriptedTern
  /** The PRODUCTION preview map the surface reads. */
  readonly previews: Map<string, StreamingToolPreview>
  route(event: SessionEvent): void
  /** The live Agent object of the main session (the identity the stream carries). */
  agent(): object
  /** Register a NEW live Agent for the main session (the owner's replacement). */
  replaceAgent(): object
  /** Retire the live Agent (the registry no longer knows it). */
  retireAgent(): void
  dispose(): Promise<void>
}

/**
 * Mount the REAL `SurfaceRuntime` over the REAL TSP renderer (the shipped SDK
 * connect on a scripted pane) with the PRODUCTION preview owner wired in: the
 * live assistant input folds through `applyAssistantLiveInput` and the durable
 * events clear the map through `applyStreamingToolPreviewEvent`.
 */
async function mountPreparingHarness(): Promise<PreparingHarness> {
  const tern = new ScriptedTern(PREPARING_HELLO)
  const { session } = await openTern(tern)
  const folder = new TranscriptFolder()
  const stats = new StatsFolder()
  const controller = new TranscriptWindowController({ windowTurns: 20, stepTurns: 10 })
  const previews = new Map<string, StreamingToolPreview>()
  /** The live Agent registry: the identity the assistant stream carries. */
  const agents = new Map<string, object>()
  let currentAgent: object | undefined
  const registerAgent = (agent: object): object => {
    agents.set(SESSION_ID, agent)
    currentAgent = agent
    return agent
  }

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
      stats: { apply: (events: readonly SessionEvent[]) => stats.apply(events) },
      get window() { return controller },
      previews,
      // The PRODUCTION clear path: a formal tool/call, a retry, an attempt and
      // the step/turn boundaries all clear the map here.
      applyToolPreview: event => applyStreamingToolPreviewEvent(previews, event),
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
    // The PRODUCTION identity facts: the registry knows the live Agent object
    // and the surface knows which object owns the main session.
    registeredAgentIs: (sessionId, agent) => agent === agents.get(sessionId),
    isCurrentOwnerAgent: agent => currentAgent === agent,
    viewedChildAgent: () => undefined,
    setViewedChildAgent: () => {},
    setViewedQueueAgent: () => {},
    agentForSession: sessionId => agents.get(sessionId),
    applyViewedChildAssistantInput: () => { throw new Error('no viewer in this harness') },
    // The PRODUCTION live path: the preview owner sees the SAME official
    // chunk the transcript fold sees.
    applyMainAssistantInput: input => applyAssistantLiveInput(folder, stats, previews, input, toolSummaryKeys),
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

  let mountedRenderer: TspRenderer | undefined
  const renderer: SurfaceRendererMount = {
    mount: (binding, statusReader) => {
      mountedRenderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => {} })
      // TSP-7 PR-A: the status reader is bound BEFORE the image binding, like
      // the production mount — a renderer that fails its image bind still
      // releases through the existing path.
      mountedRenderer.bindStatusReader(statusReader)
      // PR-C: the mount hands the renderer the ONE image binding of this
      // surface — the fake mount installs it, it never fakes success.
      mountedRenderer.bindImages(binding)
      return mountedRenderer
    },
    releaseUnmounted: async () => { await mountedRenderer?.dispose() },
  }
  surface.start({
    events: { onSubmit: () => {}, onExit: () => {} },
    renderer,
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised by this test')) },
    readImage: () => Promise.reject(new Error('not exercised by this test')),
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

  const agent = registerAgent({ session: { id: SESSION_ID } })

  return {
    surface,
    tern,
    previews,
    route(event) { surface.routeSessionEvent({ id: SESSION_ID }, event) },
    agent: () => agent,
    replaceAgent: () => registerAgent({ session: { id: SESSION_ID } }),
    retireAgent() {
      agents.delete(SESSION_ID)
      currentAgent = undefined
    },
    async dispose() {
      surface.dispose()
      await surface.whenRendererReleased()
      await session.close()
    },
  }
}

/** The native row nodes the wire currently shows, with their visible text. */
function wirePreparingRows(wire: string): { id: string; text: string }[] {
  interface WireNode { id: string; k: string; p?: Record<string, unknown>; c?: WireNode[] }
  const nodes = new Map<string, { k: string; p: Record<string, unknown>; childIds: string[] }>()
  const visit = (node: WireNode): void => {
    nodes.set(node.id, { k: node.k, p: node.p ?? {}, childIds: (node.c ?? []).map(child => child.id) })
    for (const child of node.c ?? []) visit(child)
  }
  for (const match of wire.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
    const frame = JSON.parse(match[1]!) as { ops: unknown[][] }
    for (const op of frame.ops) {
      if (op[0] === 'add') {
        const node = op[4] as WireNode | null | undefined
        if (node !== undefined && node !== null) visit(node)
      } else if (op[0] === 'del') {
        const doomed = new Set<string>()
        const collect = (id: string): void => {
          if (doomed.has(id)) return
          doomed.add(id)
          for (const child of nodes.get(id)?.childIds ?? []) collect(child)
        }
        collect(op[1] as string)
        for (const id of doomed) nodes.delete(id)
      } else if (op[0] === 'set') {
        const id = op[1] as string
        const existing = nodes.get(id)
        if (existing !== undefined) nodes.set(id, { ...existing, p: { ...existing.p, ...(op[2] as object) } })
      } else if (op[0] === 'text') {
        const id = op[1] as string
        const existing = nodes.get(id)
        if (existing === undefined) continue
        const before = typeof existing.p['text'] === 'string' ? existing.p['text'] : ''
        const value = op[3] as string
        nodes.set(id, { ...existing, p: { ...existing.p, text: op[2] === 'append' ? before + value : value } })
      }
    }
  }
  const rows: { id: string; text: string }[] = []
  for (const [id, node] of nodes) {
    if (node.k !== 'row') continue
    rows.push({ id, text: node.childIds.map(child => String(nodes.get(child)?.p['text'] ?? '')).join('') })
  }
  return rows
}

/** The official-shaped live tool-call delta of one streaming tool call. */
function toolCallDelta(id: string, index: number, name: string | undefined, argumentsDelta: string): AssistantLiveInput {
  return liveChunk({
    type: 'tool-call-delta',
    id,
    index,
    ...(name === undefined ? {} : { name }),
    argumentsDelta,
  })
}

/**
 * Wait for a real fact ON THE WIRE, with the deadline the observation is
 * worth. The fact is the renderer's CURRENT state (a row is on the wire, a
 * row has left it), so a wait that never sees it FAILS the test instead of
 * passing on a blind window.
 */
async function awaitWire(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

/** The Preparing rows the wire currently shows. */
function wireRowCount(harness: PreparingHarness): number {
  return wirePreparingRows(harness.tern.output.text()).length
}

/**
 * The PRODUCTION Direct install's admission, in the shape the bootstrap wires
 * it (`src/app/bootstrap.ts`: `installAssistantStream({ isCurrentAgent, onInput })`):
 * the identity fence decides whether the input is forwarded AT ALL. The fence
 * is the production `surface.isCurrentAssistantAgent(agent)` — the very
 * predicate the install consults (`src/runtime/direct/assistant-stream-direct.ts`:
 * `if (deps.isCurrentAgent(agent)) deps.onInput(input)`) — so a retired
 * Agent's delta never reaches the preview owner.
 *
 * The install itself is not mounted here: it needs the Host event surface
 * (`ctx`), and this lane must not add a Host service or a fixture-only hook.
 * @returns whether the input was forwarded to the surface.
 */
function deliverAssistantInput(
  harness: PreparingHarness,
  agent: object,
  input: AssistantLiveInput,
): boolean {
  if (!harness.surface.isCurrentAssistantAgent(agent)) return false
  harness.surface.applyAssistantInput(input)
  return true
}

test('B3-L01: a live tool-call delta reaches the mounted TSP renderer as ONE Preparing row', async () => {
  const harness = await mountPreparingHarness()
  try {
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'user-1', 'Run the focused test.'))
    harness.surface.paintNow()

    // The official stream input: a named tool whose arguments are still
    // arriving. The PRODUCTION owner extracts the summary and the bytes.
    // The input is delivered through the production identity admission.
    assert.equal(harness.surface.isCurrentAssistantAgent(harness.agent()), true,
      'the live Agent is the current one')
    assert.equal(deliverAssistantInput(harness, harness.agent(),
      toolCallDelta('call-bash', 0, 'bash', '{"command":"pnpm test --filter transcript","description":"Run focused tests"}')),
    true, 'the live Agent delta is admitted')
    harness.surface.paintNow()
    await awaitWire(() => wireRowCount(harness) === 1, 'the Preparing row to reach the wire')

    // The owner really holds the preview (no pre-decided flag was injected).
    assert.equal(harness.previews.size, 1, 'the production preview owner holds one preview')
    const rows = wirePreparingRows(harness.tern.output.text())
    assert.equal(rows.length, 1, 'exactly one Preparing row reached the wire')
    assert.ok(rows[0]!.text.startsWith('Preparing Bash…'), `the row names the tool: ${rows[0]!.text}`)
    assert.ok(rows[0]!.text.includes('Run focused tests'), 'the owner-extracted summary is shown')
    assert.ok(rows[0]!.text.endsWith(' B'), 'the exact byte count is shown')

    // The formal tool call: the owner clears the preview BEFORE the fold, so
    // ONE repaint shows the durable tool and no Preparing row.
    harness.route(toolCall(2, 'call-bash', 'bash', { command: 'pnpm test --filter transcript', description: 'Run focused tests' }))
    harness.surface.paintNow()
    await awaitWire(() => wireRowCount(harness) === 0, 'the Preparing row to leave the wire')
    assert.equal(harness.previews.size, 0, 'the formal call cleared the preview')
    assert.equal(wirePreparingRows(harness.tern.output.text()).length, 0, 'no Preparing row survives the handoff')
    assert.ok(harness.tern.output.text().includes('"k":"tool"'), 'the durable tool row is on the wire')
  } finally {
    await harness.dispose()
  }
})

test('B3-L02: the retry, the attempt, the step end and the turn end each clear the row', async () => {
  const harness = await mountPreparingHarness()
  try {
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'user-1', 'Run the focused test.'))
    harness.surface.paintNow()

    const showRow = async (id: string, name: string, args: string): Promise<void> => {
      deliverAssistantInput(harness, harness.agent(), toolCallDelta(id, 0, name, args))
      harness.surface.paintNow()
      await awaitWire(() => wireRowCount(harness) === 1, `the ${id} row to reach the wire`)
    }
    const assertCleared = async (what: string): Promise<void> => {
      await awaitWire(() => wireRowCount(harness) === 0, `the row to leave the wire after the ${what}`)
      assert.equal(harness.previews.size, 0, `the ${what} cleared the preview owner`)
      assert.equal(wireRowCount(harness), 0, `no ghost row survives the ${what}`)
    }

    // The retry boundary: the owner drops the step's previews.
    await showRow('call-bash', 'bash', '{"command":"pnpm test"}')
    harness.route(ev('llm/retry', { turn: 1, step: 0 }, 2))
    harness.surface.paintNow()
    await assertCleared('retry')

    // The committed attempt: the attempt's deltas never materialized, so its
    // step's previews must not survive as ghost rows.
    await showRow('call-read', 'read', '{"file_path":"src/a.ts"}')
    harness.route(ev('assistant/attempt', { turn: 1, step: 0 }, 3))
    harness.surface.paintNow()
    await assertCleared('attempt')

    // The step boundary.
    await showRow('call-read-2', 'read', '{"file_path":"src/b.ts"}')
    harness.route(ev('step/end', { turn: 1, step: 0 }, 4))
    harness.surface.paintNow()
    await assertCleared('step end')

    // The turn boundary: the whole turn's previews go with it.
    await showRow('call-bash-2', 'bash', '{"command":"pnpm test --filter transcript"}')
    harness.route(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5))
    harness.surface.paintNow()
    await assertCleared('turn end')
  } finally {
    await harness.dispose()
  }
})

test('B3-L03: a retired Agent\'s delta never reaches the preview owner', async () => {
  const harness = await mountPreparingHarness()
  try {
    harness.route(ev('turn/start', { turn: 1 }, 0))
    harness.route(userMessage(1, 'user-1', 'Run the focused test.'))
    harness.surface.paintNow()

    // The live Agent's delta is admitted and reaches the wire.
    assert.equal(deliverAssistantInput(harness, harness.agent(),
      toolCallDelta('call-bash', 0, 'bash', '{"command":"pnpm test"}')),
    true, 'the live Agent delta is admitted')
    harness.surface.paintNow()
    await awaitWire(() => wireRowCount(harness) === 1, 'the live Preparing row to reach the wire')
    assert.equal(harness.previews.size, 1, 'the owner holds the live preview')
    const rowsBefore = wirePreparingRows(harness.tern.output.text())
    assert.equal(rowsBefore.length, 1, 'the row is on the wire')

    // The owner is replaced: the retired Agent object is no longer the
    // registered one, so the production identity fence refuses its delta.
    const retired = harness.agent()
    harness.replaceAgent()
    assert.equal(harness.surface.isCurrentAssistantAgent(retired), false,
      'the retired Agent is not the current one')
    assert.equal(deliverAssistantInput(harness, retired,
      toolCallDelta('call-stale', 1, 'bash', '{"command":"pnpm test --stale"}')),
    false, 'the retired Agent delta is refused by the production admission')
    // A frame that DOES change the transcript proves the wire settled after
    // the refused delta: any row the refused delta had created would be in
    // this frame too.
    harness.route(userMessage(2, 'user-2', 'after the retired delta'))
    harness.surface.paintNow()
    await awaitWire(() => harness.tern.output.text().includes('after the retired delta'),
      'the frame after the refused delta to reach the wire')
    assert.equal(harness.previews.size, 1, 'the refused delta changed no preview')
    const rowsAfter = wirePreparingRows(harness.tern.output.text())
    assert.equal(rowsAfter.length, 1, 'the refused delta drew no second row')
    assert.equal(rowsAfter[0]!.text, rowsBefore[0]!.text, 'the visible row is the live one, unchanged')

    // A fully retired Agent (the registry no longer knows it) is refused too.
    harness.retireAgent()
    assert.equal(harness.surface.isCurrentAssistantAgent(harness.agent()), false,
      'an unregistered Agent is never current')
    assert.equal(deliverAssistantInput(harness, harness.agent(),
      toolCallDelta('call-stale-2', 2, 'bash', '{"command":"pnpm test --stale-2"}')),
    false, 'the unregistered Agent delta is refused')
    harness.route(userMessage(3, 'user-3', 'after the unregistered delta'))
    harness.surface.paintNow()
    await awaitWire(() => harness.tern.output.text().includes('after the unregistered delta'),
      'the frame after the second refused delta to reach the wire')
    assert.equal(harness.previews.size, 1, 'the refused delta still changed no preview')
    assert.equal(wireRowCount(harness), 1, 'the refused delta still drew no second row')
  } finally {
    await harness.dispose()
  }
})
