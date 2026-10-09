/**
 * PR3-A renderer-selection contract tests (Tern Surface Protocol).
 *
 * The chain under test is the PRODUCTION composition decision:
 *
 *     $DSH_PI_TUI_RENDERER (the only opt-in authority)
 *       -> the bootstrap-level selection seam (connect BEFORE PiTui)
 *       -> SurfaceRuntime.start({ renderer? }) vs startProcessTui
 *
 * A-01: opt-in + a real SDK connect success ⇒ the TSP renderer mounts, and
 *       `startProcessTui` NEVER runs (no TuiApp, no process-slot claim, the
 *       SDK session owns the tty).
 * A-02: `connect() === null` ⇒ the PiTui mount runs unchanged (TSP surface
 *       never opened).
 * A-03: no opt-in ⇒ no SDK import/connect at all.
 * A-07 (selection half): a connect THROW is a startup failure — it propagates
 *       out of the selection seam; it is NEVER mapped to `null`/fallback.
 *
 * STANDS-IN: the terminal is a scripted tty answering the official handshake
 * (the same fixture family PR2 used); the app graph is the real
 * `SurfaceRuntime` + a minimal routing source, as in PR2. Nothing here claims
 * a real Tern pane (that is the manual smoke in docs/tern-tsp/evidence/pr3-a.md).
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-renderer-selection.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { connect as sdkConnect, concatBytes } from '@stencil-hq/tern'
import type { Op } from '@stencil-hq/tern'
import type { ConnectOptions, Session, TermInput, TermOutput } from '@stencil-hq/tern'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { RoutedSessionEvent } from '../src/app/surface/event-routing.ts'
import type { SurfaceEventRoutingSource } from '../src/app/surface/event-routing.ts'
import {
  createSurfaceRuntime,
  type SurfaceRuntime,
  type SurfaceRendererMount,
} from '../src/app/surface/runtime.ts'
import { TranscriptFolder } from '../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../src/domain/transcript/window.ts'
import { installVirtualProcessTerminal } from './support/runner-harness.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { createPluginManagerPanel } from '../src/tui/plugin-manager/panel.ts'
import { createSurfaceLifecycle } from '../src/app/bootstrap/lifecycle.ts'
import { createExitController } from '../src/app/bootstrap/exit.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()
const SESSION_ID = 'session-pr3a-sel'

// ── The scripted Tern pane (same shape PR2 used) ────────────────────────────

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
  readonly isTTY: boolean
  readonly columns = 100
  readonly chunks: Uint8Array[] = []
  onWrite: ((bytes: Uint8Array) => void) | undefined
  constructor(isTTY = true) {
    this.isTTY = isTTY
  }
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
  /** Every `o` (open) body on the wire. */
  readonly opened: unknown[] = []
  /** Whether a DA1/hello probe ever ran (the SDK connected). */
  probed = false

  constructor() {
    this.output.onWrite = bytes => {
      const text = DECODER.decode(bytes)
      if (text.includes('\u001b[c')) {
        this.probed = true
        setTimeout(() => this.input.type(`\u001b_tsp;r;${JSON.stringify(HELLO)}\u001b\\\u001b[?62;52;c`), 1)
        return
      }
      for (const match of text.matchAll(/\u001b_to?;o;([\s\S]*?)\u001b\\/g)) {
        try { this.opened.push(JSON.parse(match[1]!)) } catch { /* not an open */ }
      }
      // A real pane acks every frame it drew (credit flow control).
      for (const frame of decodeFrames(text)) {
        setTimeout(() => this.input.type(
          `\u001b_tsp;e;${JSON.stringify({ ev: 'ack', sf: frame.sf, s: frame.s })}\u001b\\`,
        ), 0)
      }
    }
  }
}

/** The selection seam under test: the SAME logic bootstrap.ts runs. */
/**
 * Drive the PRODUCTION selection seam (`selectRendererMount` +
 * `productionTspConnector`) — never a hand-copied selector. The connector's
 * lazy import and the SDK `connect` are the shipped ones; only the tty is the
 * scripted pane and `connect` may be replaced to force a failure.
 */
async function selectRenderer(options: {
  readonly env: Record<string, string | undefined>
  readonly requestExit?: () => void
  readonly onFatal?: (error: unknown) => void
  /**
   * The official SDK connect boundary: `null` = the SDK declined the pane, a
   * throw = the fatal connect failure. Only this boundary is replaced — the
   * PRODUCTION connector and `connectTspRenderer` (with its owned-session
   * mount-failure release) always stay in the path (R3-3).
   */
  readonly connect?: () => Promise<Session | null>
  /** Records the connector invocation (proves the default path never probes). */
  readonly onConnect?: () => void
  /** Records the connector's secondary-restoration diagnostics (R2-3). */
  readonly onLogError?: (message: string, fields?: Record<string, unknown>) => void
}): Promise<SurfaceRendererMount | undefined> {
  const { selectRendererMount, productionTspConnector } = await import('../src/app/bootstrap/renderer-selection.ts')
  const production = productionTspConnector({
    cwd: '/tmp',
    requestExit: options.requestExit ?? ((): void => {}),
    onFatal: options.onFatal ?? ((): void => {}),
    log: (): void => {},
    logError: (message, fields) => { options.onLogError?.(message, fields) },
    ...(options.connect === undefined ? {} : { connect: options.connect }),
  })
  return selectRendererMount({
    log: (): void => {},
    connectTsp: async () => {
      options.onConnect?.()
      return await production()
    },
    env: options.env,
  })
}

// ── The real app-graph harness (the PR2 shape, minimal) ─────────────────────

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
  mount(renderer?: SurfaceRendererMount): void
  route(event: SessionEvent): void
  /** Owns the real renderer-release outcome, then restores the terminal. */
  dispose(): Promise<void>
}

function mountHarness(): Harness {
  const vt = new VirtualTerminal(100, 30)
  const restoreTerminal = installVirtualProcessTerminal(vt)
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
  const dispose = async (): Promise<void> => {
    try {
      surface.dispose()
      // The release outcome belongs to the CALLER: a failed renderer release must
      // surface here (never as an unowned rejection), before the terminal is restored.
      await surface.whenRendererReleased()
    } finally {
      restoreTerminal()
    }
  }
  return {
    surface,
    dispose,
    mount(renderer) {
      surface.start({
        events: { onSubmit: () => {}, onExit: () => {} },
        ...(renderer === undefined ? {} : { renderer }),
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
      })
    },
    route(event) {
      surface.routeSessionEvent({ id: SESSION_ID }, event)
    },
  }
}

function userMessage(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: 1_700_000_000_000 + seq,
    data: {
      id: `u-${seq}` as never,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  } as unknown as SessionEvent
}

async function settle(): Promise<void> {
  for (let index = 0; index < 40; index += 1) await new Promise(resolve => setTimeout(resolve, 3))
}

// ── A-01: opt-in + real SDK connect success ⇒ TSP-only mount ────────────────

test('A-01: the PRODUCTION selection + a real SDK connect mounts the TSP renderer and never starts a TuiApp', async () => {
  const tern = new ScriptedTern()
  // The PRODUCTION selector, with the shipped SDK connect over the scripted pane.
  const mount = await selectRenderer({
    env: { DSH_PI_TUI_RENDERER: 'tsp' },
    connect: async () => {
      const session = await sdkConnect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 500 })
      assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')
      return session
    },
  })
  assert.ok(mount !== undefined, 'the production selection produced the renderer mount')

  const harness = mountHarness()
  try {
    harness.mount(mount)
    await settle()

    // NO TuiApp exists: reading surface.app throws, the display seam answers.
    assert.throws(() => harness.surface.app, /the surface is not mounted/,
      'no TuiApp exists on the TSP branch')
    assert.equal(harness.surface.display.supportsModals, false)
    // The SDK session owns the tty: raw mode was taken by the SDK only.
    assert.deepEqual(tern.input.raw.includes(true), true, 'the SDK took raw mode')
    assert.ok(tern.output.text().includes('\u001b_tsp;o;'), 'the TSP surface opened on the real wire')

    // The live transcript reaches the renderer through the real projection.
    harness.route({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as never)
    harness.route(userMessage(1, 'selects the renderer'))
    harness.surface.paintNow()
    await settle()
    assert.ok(tern.output.text().includes('selects the renderer'), 'the routed message rendered on the TSP wire')
  } finally {
    await harness.dispose()
  }
})

// ── A-02: connect() === null ⇒ the unchanged PiTui mount ────────────────────

test('A-02: SDK connect null falls back to the PiTui mount (opt-in present)', async () => {
  const tern = new ScriptedTern()
  // The pane never answers the probe: the shipped SDK declines (returns null).
  tern.output.onWrite = () => {}

  const renderer = await selectRenderer({
    env: { DSH_PI_TUI_RENDERER: 'tsp' },
    connect: async () => await sdkConnect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 50 }),
  })
  assert.equal(renderer, undefined, 'the selection seam yields no renderer mount on null')

  const harness = mountHarness()
  try {
    harness.mount(renderer)
    // The PiTui mount succeeded: a TuiApp exists and renders.
    assert.equal(typeof harness.surface.app.start, 'function', 'the PiTui TuiApp mounted')
    harness.route(userMessage(1, 'pitui fallback'))
    harness.surface.paintNow()
    await settle()
    const wire = tern.output.text()
    assert.ok(!wire.includes('\u001b_tsp;o;') && !wire.includes('\u001b_tsp;f;'), 'no TSP surface opened or framed after the declined probe')
  } finally {
    await harness.dispose()
  }
})

// ── A-03: no opt-in ⇒ no SDK probe at all ───────────────────────────────────

test('A-03: without the opt-in the PRODUCTION selection never invokes the connector', async () => {
  const tern = new ScriptedTern()
  let connectorCalls = 0
  const renderer = await selectRenderer({ env: {}, onConnect: () => { connectorCalls += 1 } })
  assert.equal(renderer, undefined, 'no renderer mount without the opt-in')
  assert.equal(connectorCalls, 0,
    'the production selection never reached the TSP connector (so no SDK import/connect/probe)')
  assert.equal(tern.probed, false, 'the SDK probe never ran')

  const harness = mountHarness()
  try {
    harness.mount(renderer)
    assert.equal(typeof harness.surface.app.start, 'function', 'the default PiTui mount ran')
  } finally {
    await harness.dispose()
  }
})

// ── A-07 (selection half): a connect throw is a startup failure ─────────────

test('A-07: a SDK connect THROW propagates — never mapped to null or a fallback', async () => {
  await assert.rejects(
    selectRenderer({
      env: { DSH_PI_TUI_RENDERER: 'tsp' },
      connect: async () => { throw new Error('handshake exploded') },
    }),
    /handshake exploded/,
    'the connect failure escapes the selection seam (the runner fatal path owns it)',
  )
})

// ── The env name is the ONLY authority (no TERM_PROGRAM inference) ──────────

test('A-03b: TERM_PROGRAM=tern alone never selects the TSP renderer', async () => {
  const tern = new ScriptedTern()
  const renderer = await selectRenderer({ env: { TERM_PROGRAM: 'tern' } })
  assert.equal(renderer, undefined)
  assert.equal(tern.probed, false, 'no probe without the explicit opt-in env')
})


// ── L6 composition fallback: the FULL runner with the opt-in on a non-TSP tty ──

test('L6 composition: DSH_PI_TUI_RENDERER=tsp on a non-TSP environment mounts PiTui end-to-end', async (t) => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const { makeHarness, mountRunner, installVirtualProcessTerminal, disposeContext } = await import('./support/runner-harness.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3a-l6-')
  const logFile = join(home, 'diag.log')
  const harness = makeHarness(home)
  const vt = new VirtualTerminal(110, 32)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  const previousRenderer = process.env.DSH_PI_TUI_RENDERER
  const previousLog = process.env.DSH_PI_TUI_LOG
  process.env.DSH_PI_TUI_RENDERER = 'tsp'
  process.env.DSH_PI_TUI_LOG = logFile
  const ctx = new Context()
  try {
    // stdin is NOT a TTY under node:test: the shipped SDK connect declines,
    // the selection yields no renderer, and the FULL production composition
    // mounts PiTui — every boot-mandatory step (pending input, command
    // registration with its completions install, interaction attach) runs.
    const fiber = await mountRunner(ctx, home, harness, {}, {})
    await disposeContext(ctx)
    await fiber.dispose()
    const log = readFileSync(logFile, 'utf8')
    assert.ok(log.includes('tsp renderer unavailable (SDK declined); mounting PiTui'),
      'the selection logged the honest decline')
    assert.ok(!log.includes('fatal'),
      'the composition reached no fatal path with the opt-in present')
  } finally {
    if (previousRenderer === undefined) delete process.env.DSH_PI_TUI_RENDERER
    else process.env.DSH_PI_TUI_RENDERER = previousRenderer
    if (previousLog === undefined) delete process.env.DSH_PI_TUI_LOG
    else process.env.DSH_PI_TUI_LOG = previousLog
    restoreTerminal()
  }
})

// ── F1: the exit orchestration AWAITS the renderer release ─────────────────

test('F1: the exit controller awaits the renderer release before the hint/appExit', async () => {
  const { createExitController } = await import('../src/app/bootstrap/exit.ts')
  const order: string[] = []
  let release: (() => void) | undefined
  const { requestExit } = createExitController({
    diag: { info: () => {}, error: () => {} },
    cleanup: () => new Promise<void>(resolve => {
      order.push('cleanup')
      release = () => { order.push('tty-released'); resolve() }
    }),
    hint: () => order.push('hint'),
    resumeHint: () => 'resume',
    exit: () => order.push('exit'),
  })
  requestExit()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(order, ['cleanup'], 'nothing after cleanup runs while the renderer still owns the tty')
  release!()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(order, ['cleanup', 'tty-released', 'hint', 'exit'],
    'the hint and appExit run only after the SDK restored the terminal')
})

// ── F8: the PUBLIC compaction settle contract is unchanged ──────────────────

test('F8: the public settleCompactionSurface keeps its three-setter structural contract', async () => {
  const { settleCompactionSurface } = await import('../src/index.ts')
  const calls: string[] = []
  let refreshes = 0
  // An OLD (pre-PR3-A) third-party-style caller object: the public shape must
  // not have been repurposed to the aggregated seam member.
  settleCompactionSurface({
    setCompactionPhase: phase => calls.push(`phase:${phase}`),
    setBusy: busy => calls.push(`busy:${busy}`),
    setWorking: working => calls.push(`working:${working}`),
  }, () => { refreshes += 1 }, true)
  assert.deepEqual(calls, ['phase:idle', 'busy:true', 'working:true'],
    'the public surface still calls the three setters')
  assert.equal(refreshes, 1, 'the settle still refreshes once')
})

// ── R2-1: the REAL surface lifecycle waits for the renderer release ────────

interface LifecycleHarness {
  readonly lifecycle: import('../src/app/bootstrap/lifecycle.ts').SurfaceLifecycle
  readonly order: string[]
  release(): void
  /** Settle the acquisition stage (the ownership transfer / the cancelled release). */
  acquire(): void
  /** REJECT the acquisition stage (the acquired tty owner was NOT released). */
  failAcquire(error: unknown): void
}

function mountLifecycle(options: {
  readonly throwInViewer?: boolean
  /** The EXACT value the viewer step throws (may legally be `undefined`). */
  readonly viewerFailure?: unknown
  /** When present, the renderer RELEASE rejects with this value. */
  readonly releaseFailure?: unknown
  /** Keeps the ACQUISITION stage pending so a test can prove the teardown waits. */
  readonly holdAcquisition?: boolean
  /** Runs SYNCHRONOUSLY from the batch's abort step — the R3-1 re-entry trigger. */
  readonly onAbort?: () => void
} = {}): LifecycleHarness {
  const order: string[] = []
  let release!: () => void
  const held = new Promise<void>((resolve, reject) => {
    release = () => {
      order.push('tty-released')
      if ('releaseFailure' in options) reject(options.releaseFailure)
      else resolve()
    }
  })
  let cleaned = false
  // The surface slot mirrors `SurfaceRuntime.rendererRelease`: it starts as an
  // already-resolved promise and only becomes the real release once `dispose()`
  // runs. That is the exact R3-1 window.
  let slot: Promise<void> = Promise.resolve()
  const surface = {
    retireCompletionOwner: () => { order.push('retireCompletionOwner') },
    disableFocusReporting: () => { order.push('disableFocusReporting') },
    disposePluginManager: () => { order.push('disposePluginManager') },
    disposeJobEvents: () => { order.push('disposeJobEvents') },
    disposeJobObservation: () => { order.push('disposeJobObservation') },
    disposeTaskBrowser: () => { order.push('disposeTaskBrowser') },
    dispose: () => { order.push('surface.dispose'); slot = held },
    whenRendererReleased: () => slot,
  }
  const noop = (): void => {}
  // The acquisition stage: settled by default (the ownership transfer already
  // happened in these fixtures); `holdAcquisition` keeps it pending.
  let settleAcquired!: () => void
  let rejectAcquired!: (error: unknown) => void
  const acquired = new Promise<void>((resolve, reject) => {
    settleAcquired = resolve
    rejectAcquired = reject
  })
  if (options.holdAcquisition !== true) settleAcquired()
  const lifecycle = createSurfaceLifecycle({
    diag: { debug: noop, info: noop, warn: noop, error: () => { order.push('cleanup-error') }, dispose: noop },
    isCleanedUp: () => cleaned,
    markCleanedUp: () => { cleaned = true },
    surface,
    abortLifecycle: () => { order.push('abort'); options.onAbort?.() },
    disposeViewer: () => {
      if (options.throwInViewer === true) {
        // `viewerFailure` is an EXPLICIT option so that `throw undefined` (a
        // legal JavaScript failure) is distinguishable from "no failure".
        throw 'viewerFailure' in options ? options.viewerFailure : new Error('viewer disposal failed')
      }
      order.push('disposeViewer')
    },
    clearDraftImages: noop,
    clearDraftFiles: noop,
    disposeCommandCatalog: noop,
    cancelDeferredStatus: noop,
    disposeFooterCommand: noop,
    disposeLocalShell: noop,
    retireOwnedSession: async () => ({ } as never),
    disposeSelectedTransport: async () => {},
    registerDisposal: () => {},
    whenRendererAcquired: () => acquired,
  })
  return {
    lifecycle,
    order,
    release: () => release(),
    acquire: () => settleAcquired(),
    failAcquire: (error: unknown) => rejectAcquired(error),
  }
}

test('R2-1a: a SECOND cleanup awaits the SAME renderer release (never races to retirement)', async () => {
  const { lifecycle, order, release } = mountLifecycle()
  const first = lifecycle.disposeSurface()
  const second = lifecycle.disposeSurface()
  assert.ok(first instanceof Promise, 'the first teardown returns the release promise')
  assert.ok(second instanceof Promise, 'the idempotent second cleanup STILL returns a promise')

  const hintOrder: string[] = []
  const { requestExit } = createExitController({
    diag: { info: () => {}, error: () => {} },
    cleanup: () => lifecycle.disposeSurface(),
    hint: () => hintOrder.push('hint'),
    resumeHint: () => 'resume',
    exit: () => hintOrder.push('exit'),
  })
  requestExit()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(hintOrder, [], 'no hint/appExit while the renderer still owns the tty')
  assert.ok(!order.includes('tty-released'))

  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(hintOrder, ['hint', 'exit'], 'the hint and appExit run only after the release')
})

test('R2-1b: a THROWING sibling still awaits the release before surfacing its failure', async () => {
  const { lifecycle, order, release } = mountLifecycle({ throwInViewer: true })
  const released = lifecycle.disposeSurface()
  assert.ok(released instanceof Promise)
  let failure: unknown
  let settled = false
  void (released as Promise<void>).then(() => { settled = true }, error => { settled = true; failure = error })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(settled, false, 'the throwing sibling does NOT settle the teardown before the tty release')
  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(settled, true, 'the teardown settles after the release')
  assert.ok(failure instanceof Error, 'the aggregated sync failure is surfaced to the caller')
  assert.match((failure as Error).message, /viewer disposal failed/)
  assert.ok(order.includes('tty-released'), 'the release actually ran')
})

test('R2-1c: the exit path with a throwing sibling still orders release -> hint -> exit', async () => {
  const { lifecycle, release } = mountLifecycle({ throwInViewer: true })
  const seen: string[] = []
  const { requestExit } = createExitController({
    diag: { info: () => {}, error: () => { seen.push('cleanup-error') } },
    cleanup: () => lifecycle.disposeSurface(),
    hint: () => seen.push('hint'),
    resumeHint: () => 'resume',
    exit: () => seen.push('exit'),
  })
  requestExit()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(seen, [], 'nothing runs before the release when a sibling threw')
  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(seen, ['cleanup-error', 'hint', 'exit'],
    'the failure is recorded AFTER the release, and the hint/exit follow it')
})

// ── R3-1: a SYNCHRONOUS re-entrant teardown shares the published transaction ──

test('R3-1a: a synchronous re-entrant teardown cannot reach hint/appExit before the tty release', async () => {
  const holder: { requestExit(): void } = { requestExit: () => {} }
  // The re-entry trigger: the batch's `abortLifecycle` synchronously dispatches
  // the exit intent (the production shape — an abort listener reaching
  // `requestExit` while `disposeSurface()` is still inside its batch).
  const { lifecycle, order, release } = mountLifecycle({ onAbort: () => { holder.requestExit() } })
  const { requestExit } = createExitController({
    diag: { info: () => {}, error: () => {} },
    cleanup: () => lifecycle.disposeSurface(),
    hint: () => order.push('hint'),
    resumeHint: () => 'resume',
    exit: () => order.push('exit'),
  })
  holder.requestExit = requestExit

  const first = lifecycle.disposeSurface()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(!order.includes('hint') && !order.includes('exit'),
    `the re-entrant exit path awaited the real release (order: ${order.join(',')})`)

  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(order.indexOf('tty-released') < order.indexOf('hint'),
    'the hint lands after the tty release')
  assert.deepEqual(order.slice(-2), ['hint', 'exit'], 'the exit follows the hint, once')
  await first
})

test('R3-1b: the first and the re-entrant caller observe the SAME complete teardown outcome', async () => {
  const { lifecycle, release } = mountLifecycle({ throwInViewer: true })
  const first = lifecycle.disposeSurface()
  const second = lifecycle.disposeSurface()
  assert.ok(first instanceof Promise && second instanceof Promise)
  assert.equal(second, first, 'both callers await the SAME published transaction')

  release()
  const outcomes = await Promise.allSettled([first, second])
  assert.equal(outcomes[0]!.status, 'rejected', 'the batch failure reaches the first caller')
  assert.equal(outcomes[1]!.status, 'rejected',
    'the second caller no longer sees a FULFILLED raw release')
  assert.equal(outcomes[0]!.reason, outcomes[1]!.reason,
    'the SAME failure is surfaced to both callers')
})

test('R4-3: a sibling that throws `undefined` is a FAILURE, never a silent success', async () => {
  // `throw undefined` is legal JavaScript: the batch cannot use the thrown
  // VALUE as the presence test, or a broken disposer would report a clean
  // teardown to every caller.
  const { lifecycle, release } = mountLifecycle({ throwInViewer: true, viewerFailure: undefined })
  const first = lifecycle.disposeSurface()
  const second = lifecycle.disposeSurface()
  assert.ok(first instanceof Promise && second instanceof Promise)
  assert.equal(second, first, 'both callers await the SAME published transaction')

  release()
  const outcomes = await Promise.allSettled([first, second])
  assert.equal(outcomes[0]!.status, 'rejected', 'the first caller sees the failure')
  assert.equal(outcomes[1]!.status, 'rejected', 'the repeated caller sees the SAME failure')
  assert.equal(outcomes[0]!.reason, undefined,
    'the EXACT thrown value is rethrown, not wrapped and not dropped')
  assert.equal(outcomes[1]!.reason, undefined)
})

test('R4-3b: a sibling `throw undefined` and a failing release aggregate BOTH', async () => {
  const releaseFailure = new Error('tty release exploded')
  const { lifecycle, release } = mountLifecycle({
    throwInViewer: true,
    viewerFailure: undefined,
    releaseFailure,
  })
  const released = lifecycle.disposeSurface()
  assert.ok(released instanceof Promise)
  release()
  const outcome = await Promise.allSettled([released])
  assert.equal(outcome[0]!.status, 'rejected')
  assert.ok(outcome[0]!.reason instanceof AggregateError,
    'the undefined batch failure and the release failure are surfaced together')
  assert.deepEqual((outcome[0]!.reason as AggregateError).errors, [undefined, releaseFailure],
    'the batch failure keeps its position and the exact release failure is preserved')
})

test('R4-1: the teardown transaction WAITS for the ACQUISITION stage', async () => {
  // The SDK renderer owns the tty from `connect` until the application ownership
  // transfer. A quit in that window must not print the hint / request `appExit`
  // while the renderer still owns the terminal, so the teardown transaction
  // composes the acquisition stage into its release.
  const { lifecycle, order, release, acquire } = mountLifecycle({ holdAcquisition: true })
  const { requestExit } = createExitController({
    diag: { info: () => {}, error: () => {} },
    cleanup: () => lifecycle.disposeSurface(),
    hint: () => order.push('hint'),
    resumeHint: () => 'resume',
    exit: () => order.push('exit'),
  })
  requestExit()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(!order.includes('hint') && !order.includes('exit'),
    `the exit cannot proceed while the handshake still owns the tty (order: ${order.join(',')})`)

  acquire()
  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(order.slice(-2), ['hint', 'exit'],
    'the hint and appExit run only after BOTH the acquisition and the release settled')
})

test('R4-1b: the ACQUISITION stage alone still gates the exit after the release settled', async () => {
  const { lifecycle, order, release, acquire } = mountLifecycle({ holdAcquisition: true })
  const { requestExit } = createExitController({
    diag: { info: () => {}, error: () => {} },
    cleanup: () => lifecycle.disposeSurface(),
    hint: () => order.push('hint'),
    resumeHint: () => 'resume',
    exit: () => order.push('exit'),
  })
  requestExit()
  await new Promise(resolve => setTimeout(resolve, 20))
  // The renderer release settles FIRST; the exit must still wait for the
  // acquisition stage — otherwise the hint/appExit would run while the SDK
  // handshake still owns the terminal.
  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(!order.includes('hint') && !order.includes('exit'),
    `the exit still waits for the acquisition stage (order: ${order.join(',')})`)

  acquire()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(order.slice(-2), ['hint', 'exit'])
})

test('R5-2: a FAILED acquisition release rejects the shared teardown outcome', async () => {
  // The transaction contract the bootstrap cancellation/rejected-handoff branches
  // depend on: when the acquired tty owner was NOT released, the published
  // teardown must REJECT — a fulfilled teardown with a live tty is exactly the
  // failure this locks. (The bootstrap branch itself needs the runner fixture;
  // this pins the contract at its consumer.)
  const { lifecycle, release, failAcquire } = mountLifecycle({ holdAcquisition: true })
  const released = lifecycle.disposeSurface()
  assert.ok(released instanceof Promise)
  release()
  const releaseError = new Error('acquired renderer close exploded')
  failAcquire(releaseError)
  const outcome = await Promise.allSettled([released])
  assert.equal(outcome[0]!.status, 'rejected',
    'the teardown is NOT fulfilled while the acquired tty is still held')
  assert.equal(outcome[0]!.reason, releaseError, 'the exact acquired-release failure is surfaced')
})

test('R5-2b: an acquisition release that rejects `undefined` is still a failure', async () => {
  const { lifecycle, release, failAcquire } = mountLifecycle({ holdAcquisition: true })
  const released = lifecycle.disposeSurface()
  assert.ok(released instanceof Promise)
  release()
  failAcquire(undefined)
  const outcome = await Promise.allSettled([released])
  assert.equal(outcome[0]!.status, 'rejected', 'PRESENCE decides, never the payload value')
  assert.equal(outcome[0]!.reason, undefined)
})
