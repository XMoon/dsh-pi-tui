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
import type { Op, Session, TermInput, TermOutput } from '@stencil-hq/tern'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'
import type { SurfaceEventRoutingSource } from '../src/app/surface/event-routing.ts'
import {
  createSurfaceRuntime,
  type SurfaceRuntime,
  type SurfaceRendererMount,
} from '../src/app/surface/runtime.ts'
import { TranscriptFolder } from '../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../src/domain/transcript/window.ts'
import { createPluginManagerPanel } from '../src/tui/plugin-manager/panel.ts'
import { isQuitKey, mountTspRenderer, type TspRenderer } from '../src/tui/tsp/session.ts'

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
  readonly closeBodies: unknown[] = []

  constructor() {
    this.output.onWrite = bytes => {
      const text = DECODER.decode(bytes)
      if (text.includes('\u001b[c')) {
        setTimeout(() => this.input.type(`\u001b_tsp;r;${JSON.stringify(HELLO)}\u001b\\\u001b[?62;52;c`), 1)
        return
      }
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
  route(event: SessionEvent): void
  /** Replace the main fold under the same session id (re-hydration shape). */
  replaceMain(): void
  exitRequested(): boolean
  dispose(): Promise<void>
}

async function mountTspHarness(options: { requestExit?: () => void; onFatal?: (error: unknown) => void } = {}): Promise<Harness & { session: Session }> {
  const tern = new ScriptedTern()
  const session = await openSession(tern)
  let folder = new TranscriptFolder()
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
    createPluginManagerPanel,
  })
  surface.attachEventRouting(source)

  let mountedRenderer: TspRenderer | undefined
  const renderer: SurfaceRendererMount = {
    mount: () => {
      mountedRenderer = mountTspRenderer(session, {
        requestExit: () => {
          exitCount += 1
          options.requestExit?.()
        },
        ...(options.onFatal === undefined ? {} : { onFatal: options.onFatal }),
      })
      return mountedRenderer
    },
    releaseUnmounted: async () => { await mountedRenderer?.dispose() },
  }
  const startDeps: Parameters<SurfaceRuntime<SessionEvent>['start']>[0] = {
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
    sessionId: () => SESSION_ID,
    onTerminalResize: () => {},
    copySelection: async () => false,
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
    route(event) {
      surface.routeSessionEvent({ id: SESSION_ID }, event)
    },
    replaceMain() {
      folder = new TranscriptFolder()
      controller.setTurns(folder.groupedTurns())
    },
    exitRequested: () => exitCount > 0,
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

test('A-04: cold hydration renders the first frame; tool settle and live delta update in place', async () => {
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

test('A-05: after the generation bump the Loading fence drops the OLD fold repaint (production gap)', async () => {
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

test('A-06: a same-id fold replacement re-scopes into a fresh node namespace', async () => {
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

test('A-07: dispose closes the SDK surface (x keep:false) and the session exactly once', async () => {
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

// ── The exit intent: B1 semantics (q is text; Ctrl+D exits only empty) ──────

test('A-04b: exit routes Ctrl+C and empty-draft Ctrl+D; a typed q is editor text', async () => {
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

// ── A-09 (F4): many notices never collide on an SDK node key ────────────────

test('A-09: repeated notices keep unique dock keys (no SDK duplicate-key ViewError)', async () => {
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

test('A-10: the joined pending presentation (queued + tail) renders in the dock', async () => {
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

// ── A-11 (F6): a mounted input-loop failure is FATAL, not a normal exit ─────

test('A-11: a real SDK iterator failure routes the SAME error to the FATAL intent', async () => {
  const tern = new ScriptedTern()
  const session = await openSession(tern)
  let fatal: unknown
  let fatalCount = 0
  let exits = 0
  const renderer = mountTspRenderer(session, {
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

// ── A-12 (F7): a failed mount closes the already-connected SDK session ─────

test('A-12: a rejected mount closes the connected SDK session once (no leaked tty owner)', async () => {
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
    const { connectTspRenderer } = await import('../src/tui/tsp/session.ts')
    await assert.rejects(
      connectTspRenderer({ requestExit: () => {}, connect: async () => session, connectTimeout: 50 }),
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

test('A-12c: a secondary tty-restoration failure never replaces the primary mount error', async () => {
  const tern = new ScriptedTern()
  const session = await openSession(tern)
  let closes = 0
  const originalClose = session.close.bind(session)
  const originalOpen = session.open.bind(session)
  session.open = () => { throw new Error('open exploded') }
  session.close = async () => { closes += 1; throw new Error('raw restore exploded') }
  const recorded: { message: string; fields?: Record<string, unknown> }[] = []
  try {
    const { connectTspRenderer } = await import('../src/tui/tsp/session.ts')
    await assert.rejects(
      connectTspRenderer({
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

test('A-12d: a mounted teardown preserves BOTH close failures (never truncates the first)', async () => {
  const tern = new ScriptedTern()
  const session = await openSession(tern)
  const renderer = mountTspRenderer(session, { requestExit: () => {}, onFatal: () => {} })
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

test('A-12b: the PRODUCTION connector handshake releases a mount a REAL surface.start rejected', async () => {
  const tern = new ScriptedTern()
  const session = await openSession(tern)
  let closes = 0
  const originalClose = session.close.bind(session)
  session.close = async () => { closes += 1; await originalClose() }
  const { selectRendererMount, productionTspConnector } = await import('../src/app/bootstrap/renderer-selection.ts')
  const requestExit = (): void => {}
  // ONLY the SDK connect boundary is replaced: the PRODUCTION connector and its
  // real `connectTspRenderer` (owned-session release + diagnostics) are the ones
  // under test (R3-3).
  const mount = await selectRendererMount({
    log: () => {},
    env: { DSH_PI_TUI_RENDERER: 'tsp' },
    connectTsp: productionTspConnector({
      cwd: '/tmp', requestExit, onFatal: () => {}, log: () => {}, logError: () => {},
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

test('A-13: the hydrate-tail reset keeps committed status facts and an explicit undefined title clears', async () => {
  const harness = await mountTspHarness()
  try {
    harness.surface.display.commitStatusFacts({ sessionTitle: 'AUTHORITATIVE_TITLE', working: true, planMode: true, busy: true })
    await settle()
    harness.surface.display.resetSessionFacts()
    await settle()
    assert.equal(harness.surface.display.getSessionTitle(), 'AUTHORITATIVE_TITLE',
      'the hydrate-tail reset does not clear the just-committed title')
    assert.ok(harness.tern.output.text().includes('AUTHORITATIVE_TITLE'), 'the title stays visible')

    // A partial commit must not drop the SIBLING facts (working/plan stay).
    harness.surface.display.commitStatusFacts({ todos: [{ content: 'a todo', status: 'pending' }] })
    await settle()
    const wire = harness.tern.output.text()
    assert.ok(wire.includes('working'), 'the sibling working fact survives a partial commit')
    assert.ok(wire.includes('plan'), 'the sibling plan fact survives a partial commit')
    assert.ok(wire.includes('todos 0/1'), 'the todo fact is visible')

    // PRESENCE semantics: an explicitly-present undefined title CLEARS it.
    harness.surface.display.commitStatusFacts({ sessionTitle: undefined })
    await settle()
    assert.equal(harness.surface.display.getSessionTitle(), '', 'explicit undefined clears the title')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── A-14 (F9): the semantic patch reaches the SHARED StatusStore ────────────

test('A-14: surface.commitStatus writes the shared StatusStore on the TSP branch', async () => {
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

test('A-08: the read-only renderer advertises no modals and the dock notice is observable', async () => {
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

test('A-08b: the interaction owner registers fail-closed answerers on a modal-less renderer', async () => {
  // The REAL interaction runtime over the TSP display seam: an approval ask
  // resolves 'unavailable' (the official no-answerer outcome — never an
  // implicit allow) and a question delegates to next() (the Host lifecycle).
  const { createInteractionRuntime } = await import('../src/app/surface/interaction-runtime.ts')
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

test('B3: the surface withdraws the interaction owner BEFORE it starts the renderer release', async () => {
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
    withdrawPresentation: () => {},
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
    createPluginManagerPanel,
  })
  surface.start({
    events: { onSubmit: () => {}, onExit: () => {} },
    renderer: {
      mount: () => ({
        display,
        composer,
        interaction: presenter,
        bindInput: () => {},
        dispose: async () => { order.push('renderer-release') },
      }),
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
    sessionId: () => 'session-b3-order',
    onTerminalResize: () => {},
    copySelection: async () => false,
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
