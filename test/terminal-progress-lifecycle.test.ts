/**
 * Terminal progress lifecycle (plan §12.2/§12.4–§12.8): the authoritative
 * main-Agent `agent/status` is the ONLY pane-progress source, the desired
 * state is deduped, an owner commit and the final teardown retire it, and
 * every TuiApp-owned screen restart restores a still-running state.
 *
 * Two REAL production layers are exercised:
 * - `TuiApp.setTerminalProgress` over a recording VirtualTerminal (dedupe plus
 *   the fullscreen / external-editor / plain stop-start restores);
 * - the mounted `createSurfaceRuntime` with its real event routing (the
 *   main-vs-child/stale fence, the pre-mount latch and the owner reset).
 *
 * The low-level OSC 9;4 protocol (active sequence, keepalive, `stop()` clear)
 * stays owned by `@xmoon76/pi-tui` and is not re-asserted here.
 * @module @xmoon76/dsh-pi-tui/terminal-progress-lifecycle.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProcessTerminal, type TerminalProgressState } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'
import type { RunPhase } from '../src/domain/status/types.ts'
import type { TerminalProgressMode } from '../src/domain/terminal-progress/settings.ts'
import type { TranscriptFolder } from '../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../src/domain/transcript/window.ts'
import { createSurfaceRuntime, type SurfaceRuntime } from '../src/app/surface/runtime.ts'
import { createTerminalProgressInterval } from '../src/domain/terminal-progress/interval.ts'
import { createSurfaceLifecycle } from '../src/app/bootstrap/lifecycle.ts'
import { createInteractionRuntime } from '../src/app/surface/interaction-runtime.ts'
import type { MainProgressAuthority, RoutedSessionEvent, SurfaceEventRoutingSource } from '../src/app/surface/event-routing.ts'
import type { TerminalNotificationPresentation } from '../src/app/surface/notification-runtime.ts'
import type { ApprovalOutcome } from '../src/tui/panels/approval-dialog.ts'
import type {
  ApprovalRequestLike,
  InteractionPort,
  QuestionInteractionPort,
  QuestionSurfaceSnapshot,
  QuestionWaitClaim,
  UserQuestionProvider,
} from '../src/runtime/interaction-port.ts'
import { createPluginManagerPanel } from '../src/tui/plugin-manager/panel.ts'
import type { Diag } from '../src/runtime/process/diagnostics.ts'
import { installVirtualProcessTerminal } from './support/runner-harness.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

/** The process TUI slot is global: every constructed TuiApp is disposed after
 *  each test (only dispose releases the slot, never stop()). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** A no-op diagnostics channel (the interaction owner only forwards failures). */
const SILENT_DIAG = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {},
} as const

/** Drain the routing's `queueMicrotask` pending-input refreshes. */
async function drain(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

/** A short ordered-timeline label for one OSC 7501 record. */
function programTimelineLabel(sequence: string): string {
  const match = /^\x1b\]7501;state=([^:\x1b]*)(?::kind=([^:\x1b]*))?/.exec(sequence)
  if (match === null) return `7501:${sequence}`
  return match[2] === undefined ? `7501:${match[1]}` : `7501:${match[1]}:${match[2]}`
}

// ── TuiApp layer: dedupe + every TuiApp-owned screen restart ───────────────

/** A started app whose injected VirtualTerminal records every progress write.
 *  `tern: true` mounts the same lifecycle as a Tern terminal (fork X059). */
function mountApp(tern = false): {
  vt: VirtualTerminal
  app: TuiApp
  progress: boolean[]
  states: TerminalProgressState[]
} {
  const vt = new VirtualTerminal(80, 24)
  const progress: boolean[] = []
  const states: TerminalProgressState[] = []
  vt.setProgress = (active: boolean) => { progress.push(active) }
  vt.setProgressState = (state: TerminalProgressState) => { states.push(state) }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { ternTerminal: tern })
  app.start()
  startedApps.add(app)
  return { vt, app, progress, states }
}

test('setTerminalProgress dedupes equal writes (no per-status churn)', () => {
  const { app, progress } = mountApp()
  try {
    app.setTerminalProgress(true)
    app.setTerminalProgress(true)
    app.setTerminalProgress(true)
    app.setTerminalProgress(false)
    app.setTerminalProgress(false)
    assert.deepEqual(progress, [false, true, false],
      'the mount claims idle; three runnings write ONE active hint; a repeated idle writes ONE clear')
  } finally {
    app.dispose()
  }
})

test('a fullscreen round-trip restores a still-running progress state', () => {
  const { app, progress } = mountApp()
  try {
    app.setTerminalProgress(true)
    app.setFullscreen(true)
    assert.equal(app.isFullscreen(), true)
    app.setFullscreen(false)
    assert.equal(app.isFullscreen(), false)
    assert.deepEqual(progress, [false, true, true, true],
      'the mount claims idle; each screen restart re-asserts the desired busy state')
  } finally {
    app.dispose()
  }
})

test('a plain stop/start round-trip restores a still-running progress state', () => {
  const { app, progress } = mountApp()
  try {
    app.setTerminalProgress(true)
    app.stop()
    app.start()
    assert.deepEqual(progress, [false, true, true])
  } finally {
    app.dispose()
  }
})

test('every terminal acquisition asserts the desired progress state', () => {
  const { app, progress } = mountApp()
  try {
    // The pane's progress indicator is terminal-side state that outlives an
    // ownership window: Tern paints a pane "running" while a foreground command
    // runs (and `dsh` itself is that command), a killed process can leave
    // OSC 9;4;1;0 behind, and an $EDITOR round-trip hands the PTY to another
    // program. Each acquisition therefore re-asserts the CURRENT desired state.
    assert.deepEqual(progress, [false], 'the mount asserts the idle state (clearing any stale pane busy)')
    app.stop()
    app.start()
    assert.deepEqual(progress, [false, false], 'an idle reacquisition re-asserts idle (the terminal may have changed)')
  } finally {
    app.dispose()
  }
})

test('a reacquisition overwrites a progress state changed while the TUI was stopped', () => {
  const vt = new VirtualTerminal(80, 24)
  // The terminal's PHYSICAL state, as an external owner would leave it.
  let physical: boolean | undefined
  vt.setProgress = (active: boolean) => { physical = active }
  const stop = vt.stop.bind(vt)
  // The real ProcessTerminal.stop() clears an active indicator and its
  // keepalive; the virtual stand-in must model that for the tracked physical
  // state to be faithful.
  vt.stop = () => { stop(); physical = undefined }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  try {
    assert.equal(physical, false, 'the mount claims idle')
    app.stop()
    assert.equal(physical, undefined, 'the stop cleared the indicator')
    // While dsh does not own the PTY, another program paints it busy and dies
    // without clearing — the same stale terminal-side state this change fixes.
    physical = true
    app.start()
    assert.equal(physical, false, 'the reacquisition overwrites the foreign busy state with the desired idle state')
  } finally {
    app.dispose()
  }
})

test('a stopped TuiApp folds the desired progress without writing the terminal', () => {
  const { app, progress } = mountApp()
  try {
    app.stop()
    app.setTerminalProgress(true)
    assert.deepEqual(progress, [false], 'a stopped surface never writes physical progress')
    app.start()
    assert.deepEqual(progress, [false, true], 'the restart projects the folded desired state exactly once')
  } finally {
    app.dispose()
  }
})

test('a $EDITOR-suspended TuiApp folds status changes and projects once on resume', async () => {
  const vt = new VirtualTerminal(80, 24)
  const progress: boolean[] = []
  vt.setProgress = (active: boolean) => { progress.push(active) }
  let release!: (text: string) => void
  const gate = new Promise<string>(resolve => { release = resolve })
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: () => gate,
    runOwned: () => {},
  })
  app.start()
  startedApps.add(app)
  try {
    app.setTerminalProgress(true)
    // The suspend runs synchronously before the first await: $EDITOR now owns
    // the terminal for the whole time this promise is pending.
    const pending = app.launchExternalEditor()
    assert.deepEqual(progress, [false, true], 'the suspend itself writes no progress')
    // The Agent keeps reporting while $EDITOR is open: idle -> running again.
    app.setTerminalProgress(false)
    app.setTerminalProgress(true)
    assert.deepEqual(progress, [false, true], 'a suspended terminal never receives progress bytes')
    release('edited')
    await pending
    assert.deepEqual(progress, [false, true, true], 'the resume projects the latest desired state exactly once')
  } finally {
    app.dispose()
  }
})

test('a $EDITOR round-trip returning on an idle Agent re-claims idle on resume', async () => {
  const vt = new VirtualTerminal(80, 24)
  const progress: boolean[] = []
  let physical: boolean | undefined
  vt.setProgress = (active: boolean) => { progress.push(active); physical = active }
  let release!: (text: string) => void
  const gate = new Promise<string>(resolve => { release = resolve })
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: () => gate,
    runOwned: () => {},
  })
  app.start()
  startedApps.add(app)
  try {
    assert.deepEqual(progress, [false], 'the mount claims idle')
    const pending = app.launchExternalEditor()
    assert.deepEqual(progress, [false], 'the suspend writes nothing')
    // The PTY belongs to $EDITOR: it (or a program it runs) paints the pane busy
    // and exits without clearing — exactly the stale state this change fixes.
    physical = true
    release('edited')
    await pending
    assert.deepEqual(progress, [false, false], 'the resume re-claims the idle state with ONE write')
    assert.equal(physical, false, 'the foreign busy state is overwritten on reacquisition')
  } finally {
    app.dispose()
  }
})

test('an external-editor suspend/resume restores a still-running progress state', async () => {
  const vt = new VirtualTerminal(80, 24)
  const progress: boolean[] = []
  vt.setProgress = (active: boolean) => { progress.push(active) }
  const stop = vt.stop.bind(vt)
  let terminalStops = 0
  vt.stop = () => { terminalStops += 1; stop() }
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: async () => 'edited',
    runOwned: () => {},
  })
  app.start()
  startedApps.add(app)
  try {
    app.setTerminalProgress(true)
    await app.launchExternalEditor()
    assert.equal(terminalStops, 1, 'the suspend stops the active screen (clearing the physical indicator)')
    assert.deepEqual(progress, [false, true, true], 'the resume re-asserts the desired busy state')
  } finally {
    app.dispose()
  }
})

// ── Surface layer: the real routing fence + latch + owner reset ────────────

/** The null terminal notification presentation (the terminal sequences are
 *  asserted by the notification suites; these fixtures exercise the surface
 *  aggregate without a real terminal). */
const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

interface SurfaceControls {
  /** Commit a completion-owner identity (the production seam: the routing's
   *  owner read and the surface reset move together). */
  readonly setOwner: (identity: string | undefined) => void
  /** Route one `agent/status` through the real production router. */
  readonly routeStatus: (agentId: string, status: 'running' | 'idle') => void
  /** Route one `session/event` through the real production router. */
  readonly routeSession: (event: { type: string; data: unknown }, sessionId?: string) => void
  /** Mount a viewed child (undefined exits the viewer). */
  readonly viewChild: (childId: string | undefined) => void
  /** Begin the opening-session journal for the main session. */
  readonly beginOpening: () => void
  /** Clear the opening-session journal. */
  readonly endOpening: () => void
}

interface SurfaceHarness extends SurfaceControls {
  readonly progress: boolean[]
  /** Every effective OSC 9;4 state (fork X059) the mounted Tern app wrote. */
  readonly progressStates: TerminalProgressState[]
  /** Every OSC 7501 record the app wrote through the terminal `write` path. */
  readonly programWrites: string[]
  /** ONE merged ordered timeline: `9;4:*`, `7501:*` and `terminal:stop`. */
  readonly timeline: string[]
  /** The RAW surface runtime, so a test can drive the production composition
   *  teardown (`createSurfaceLifecycle().disposeSurface()`). */
  readonly surfaceRuntime: SurfaceRuntime<RoutedSessionEvent>
  /** The LIVE mounted app: real Question / Approval flows drive it. */
  readonly app: TuiApp
  /** The canonical activity phase the surface publishes (NOT the pane state). */
  readonly phase: () => RunPhase
  /**
   * The REAL Agent interaction seam: one approval request delivered through the
   * registered `InteractionPort.onApprovalRequest` handler (production: the
   * Direct/Remote backend's approval port).
   */
  readonly agentApproval: (request: {
    toolName: string
    reason: string
    signal?: AbortSignal
  }) => Promise<ApprovalOutcome>
  /**
   * The REAL Agent interaction seam for questions: one live request delivered
   * through the registered `QuestionInteractionPort` provider, which reaches
   * `TuiApp.askQuestions(..., agentInputWait = true)` exactly like a LIVE
   * `ask_user_question` foreground wait does (production: the Host question
   * channel). A CONTINUED late answer takes the same channel with `false`.
   */
  readonly agentQuestion: (
    signal?: AbortSignal,
    options?: { timed?: boolean; callId?: string },
  ) => Promise<unknown>
  /** Install the Host timed-wait claim the next live request will receive. */
  readonly setClaim: (claim: QuestionWaitClaim | undefined) => void
  /** Install the Host question projection the port serves (cold discovery). */
  readonly setQuestionSnapshot: (snapshot: QuestionSurfaceSnapshot | undefined) => void
  /** Fire the port's projection notification (the Host change feed). */
  readonly notifyQuestionChange: () => void
  /** Reopen a parked CONTINUED (late-answer) question from the Task Center. */
  readonly reopenContinued: (callId: string) => boolean
  /** Apply the native-terminal-progress preference through the REAL surface
   *  seam (`SurfaceRuntime.setTerminalProgressMode`). */
  readonly setTerminalProgressMode: (mode: string) => void
  dispose(): void
}

interface MountSurfaceOptions {
  /**
   * Route ONLY the progress contract (`setProgress` / `stop`) to a REAL
   * `ProcessTerminal`, so the OSC 9;4 bytes and the terminal-owned keepalive
   * interval under test are the production ones. Every other terminal method
   * stays virtual (no raw-mode stdin).
   */
  readonly realProgress?: boolean
  readonly presentation?: TerminalNotificationPresentation
  readonly notificationMode?: string
  readonly notificationMethod?: string
  /** The persisted native-terminal-progress preference at mount ('on'
   *  default | 'off'). */
  readonly terminalProgress?: string
  /**
   * Mount the surface as a Tern terminal (`TERM_PROGRAM=tern` around the app
   * construction). The environment is restored immediately afterwards: the
   * identity is read ONCE by the app, so the running scenario keeps its Tern
   * projection without leaking the env into another suite.
   */
  readonly tern?: boolean
  /** The diagnostics channel the evidence fold reports unknown reason kinds
   *  through (absent in production-shaped fixtures without a runner). */
  readonly diag?: Diag
  /**
   * Which adapter owns the main terminal outcome (R1 §5.3). Defaults to the
   * Direct local-evidence authority; a remote-authority mount proves the
   * mutual-exclusion gate (the durable ingress never writes the local fold).
   */
  readonly mainProgressAuthority?: MainProgressAuthority
}

/**
 * The real surface runtime mounted over a virtual ProcessTerminal, with only
 * the pending-input routing ports stubbed (this suite never presents pending
 * input). `beforeStart` runs AFTER the routing source is attached and BEFORE
 * the mount, so the pre-mount latch path is reachable.
 */
function mountSurface(
  beforeStart?: (controls: SurfaceControls) => void,
  options: MountSurfaceOptions = {},
): SurfaceHarness {
  const vt = new VirtualTerminal(100, 30)
  const progress: boolean[] = []
  const progressStates: TerminalProgressState[] = []
  const programWrites: string[] = []
  // ONE merged, ordered timeline of BOTH protocols plus the terminal stop, so
  // the cross-protocol ordering contract (9;4 before 7501, clear before stop)
  // is asserted on a single sequence rather than on two independent arrays.
  const timeline: string[] = []
  vt.setProgress = (active: boolean) => { progress.push(active); timeline.push(active ? '9;4:active' : '9;4:clear') }
  vt.setProgressState = (state: TerminalProgressState) => { progressStates.push(state); timeline.push(`9;4:${state}`) }
  const passthroughWrite = vt.write.bind(vt)
  vt.write = (data: string) => {
    for (const match of data.matchAll(/\x1b\]7501;[^\x1b]*\x1b\\/g)) {
      programWrites.push(match[0])
      timeline.push(programTimelineLabel(match[0]))
    }
    passthroughWrite(data)
  }
  const passthroughStop = vt.stop.bind(vt)
  vt.stop = () => { timeline.push('terminal:stop'); passthroughStop() }
  const real = options.realProgress === true ? new ProcessTerminal() : undefined
  if (real !== undefined) {
    // Capture the REAL implementations BEFORE installVirtualProcessTerminal
    // replaces them on the prototype: the patched methods delegate back into
    // these virtual overrides, so calling them here would recurse.
    const realSetProgress = ProcessTerminal.prototype.setProgress
    const realSetProgressState = ProcessTerminal.prototype.setProgressState
    const realStop = ProcessTerminal.prototype.stop
    // The app's patched ProcessTerminal delegates to this virtual terminal;
    // only the progress methods reach the REAL implementation, so the real
    // OSC 9;4 write and the real keepalive interval run (§12.8 authority). The
    // REAL boolean method delegates to the REAL stateful one (X059), so BOTH
    // must be routed or the delegation would land back on the patch.
    vt.setProgress = (active: boolean) => {
      progress.push(active)
      realSetProgress.call(real, active)
    }
    vt.setProgressState = (state: TerminalProgressState) => {
      progressStates.push(state)
      realSetProgressState.call(real, state)
    }
    const virtualStop = vt.stop.bind(vt)
    vt.stop = () => {
      virtualStop()
      realStop.call(real)
    }
  }
  const restoreTerminal = installVirtualProcessTerminal(vt)
  let owner: string | undefined
  let viewedChild: string | undefined
  // The main transcript/stats/window targets: the SAME minimal instances the
  // routing applies into and repaints from. The repaint reads a REAL window
  // controller over an EMPTY transcript, so `paintNow()` on turn/end is the
  // production path without pulling a full transcript fixture in.
  const SESSION_ID = 'session-terminal-progress-test'
  const emptySink = { apply: () => {} }
  const emptyFolder = {
    apply: () => {},
    groupedTurns: () => [],
    turnActivities: () => [],
    searchRevision: () => 0,
    window: () => ({ messages: [], firstTurn: undefined, lastTurn: undefined, hasNewer: false }),
  } as unknown as TranscriptFolder
  const mainWindow = new TranscriptWindowController()
  const mainPresentation = () => ({
    folder: emptyFolder,
    stats: emptySink,
    window: mainWindow,
    previews: new Map(),
    applyToolPreview: () => {},
    refreshRecentPerformanceAvailability: () => {},
  })
  const viewedChildPresentation = () => ({
    id: viewedChild ?? '',
    folder: emptyFolder,
    stats: emptySink,
    window: mainWindow,
    previews: new Map(),
    applyToolPreview: () => {},
    beginTurn: () => {},
    endTurn: () => {},
    refreshFooter: () => {},
  })
  const routingSource = {
    isCleanedUp: () => false,
    isAttachedSession: () => true,
    currentSessionId: () => SESSION_ID,
    hasLiveAgent: () => true,
    completionOwnerId: () => owner,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: mainPresentation,
    viewedChildId: () => viewedChild,
    viewedChild: viewedChildPresentation,
    mainFolder: () => emptyFolder,
    viewedChildFolder: () => emptyFolder,
    pendingSubjectId: () => undefined,
    pendingSnapshot: () => undefined,
    submissionEchoes: () => undefined,
    queueTextOf: () => '',
    exitView: () => { viewedChild = undefined },
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
    registeredAgentIs: () => true,
    isCurrentOwnerAgent: () => true,
    viewedChildAgent: () => undefined,
    setViewedChildAgent: () => {},
    setViewedQueueAgent: () => {},
    agentForSession: () => undefined,
    applyViewedChildAssistantInput: () => {},
    applyMainAssistantInput: () => {},
  } as unknown as SurfaceEventRoutingSource<never>

  const surface =  createSurfaceRuntime({
    tuiVersion: '0.0.0-test',
    notificationPresentation: options.presentation ?? nullPresentation,
    notificationMode: options.notificationMode,
    notificationMethod: options.notificationMethod,
    terminalProgress: options.terminalProgress,
    mainProgressAuthority: options.mainProgressAuthority ?? 'local-events',
    ...(options.diag === undefined ? {} : { diag: options.diag }),
    createPluginManagerPanel,
  })
  surface.attachEventRouting(routingSource)
  const controls: SurfaceControls = {
    setOwner: (identity) => {
      owner = identity
      surface.setCompletionOwner(identity)
    },
    routeStatus: (agentId, status) => surface.routeAgentStatus(agentId, status),
    routeSession: (event, sessionId = SESSION_ID) => surface.routeSessionEvent({ id: sessionId }, event as never),
    viewChild: (childId) => { viewedChild = childId },
    beginOpening: () => { surface.openingJournal.begin(SESSION_ID) },
    endOpening: () => { surface.openingJournal.reset() },
  }
  beforeStart?.(controls)
  const previousTermProgram = process.env.TERM_PROGRAM
  if (options.tern === true) process.env.TERM_PROGRAM = 'tern'
  try {
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
      sessionId: () => 'session-terminal-progress-test',
      onTerminalResize: () => {},
      copySelection: async () => false,
      openExternalUrl: () => {},
      readClipboardText: async () => undefined,
      imageFallbackColor: (text) => text,
    })
  } finally {
    if (previousTermProgram === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = previousTermProgram
  }

  // The REAL Agent interaction seam. `createSurfaceRuntime`'s own
  // `attachInteraction` reads the Task Center's diagnostics channel, which only
  // exists once that owner is attached, so this suite composes the SAME
  // production `interaction-runtime` against the mounted app instead: the call
  // sites that declare an Agent-blocking wait (the approval port and the question
  // controller's LIVE `ask`) are then the production ones under test.
  let approvalListener: ((request: ApprovalRequestLike, next: unknown) => unknown) | undefined
  let questionProvider: UserQuestionProvider | undefined
  let questionSnapshot: QuestionSurfaceSnapshot | undefined
  let questionClaim: QuestionWaitClaim | undefined
  let questionSubscriber: (() => void) | undefined
  const questionPort = {
    onRequest: (next: UserQuestionProvider) => { questionProvider = next; return true },
    subscribe: (_sessionId: string, listener: () => void) => {
      questionSubscriber = listener
      return () => { if (questionSubscriber === listener) questionSubscriber = undefined }
    },
    snapshot: () => questionSnapshot,
    claimTimedWait: async () => questionClaim,
    answerContinued: async () => 'queued',
  } as unknown as QuestionInteractionPort
  const interactionPort = {
    questions: questionPort,
    onApprovalRequest: (listener: (request: ApprovalRequestLike, next: unknown) => unknown) => {
      approvalListener = listener
    },
    setApprovalPolicy: () => true,
  } as unknown as InteractionPort
  const agentInteraction = createInteractionRuntime({
    mounted: () => surface.app,
    liveApp: () => surface.app,
    currentSessionId: () => 'session-terminal-progress-test',
    schedulePaint: () => {},
    diag: () => SILENT_DIAG,
    isCleanedUp: () => false,
    setQuestionAttention: () => {},
    onAttentionChanged: () => {},
  })
  agentInteraction.attach(interactionPort, { lookupCallArgs: () => undefined, dangerCommand: () => false })

  let disposed = false
  return {
    progress,
    progressStates,
    programWrites,
    timeline,
    surfaceRuntime: surface,
    app: surface.app,
    phase: () => surface.status.snapshot().activity.phase,
    agentApproval: (request) => {
      if (approvalListener === undefined) throw new Error('the Agent approval listener was not registered')
      return approvalListener(request, undefined) as Promise<ApprovalOutcome>
    },
    agentQuestion: (signal, options) => {
      if (questionProvider === undefined) throw new Error('the Agent question provider was not registered')
      return questionProvider({
        sessionId: 'session-terminal-progress-test',
        callId: options?.callId ?? 'call-1',
        timed: options?.timed === true,
        questions: [{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }],
        ...(signal === undefined ? {} : { signal }),
      }, async () => ({ answers: [] }))
    },
    setClaim: (claim) => { questionClaim = claim },
    setQuestionSnapshot: (snapshot) => { questionSnapshot = snapshot },
    notifyQuestionChange: () => { questionSubscriber?.() },
    reopenContinued: (callId) =>
      agentInteraction.controller()?.reopen('session-terminal-progress-test', callId) ?? false,
    setTerminalProgressMode: (mode) => surface.setTerminalProgressMode(mode),
    ...controls,
    dispose: () => {
      if (disposed) return
      disposed = true
      agentInteraction.dispose()
      surface.dispose()
      restoreTerminal()
    },
  }
}

test('a pre-mount main running status is latched and projected by the FIRST acquisition', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  })
  try {
    await drain()
    assert.deepEqual(h.progress, [true],
      'the FIRST acquisition already asserts the latched running state (plan addendum §25 — no idle -> working flash)')
    h.routeStatus('main', 'running')
    h.routeStatus('main', 'running')
    await drain()
    assert.deepEqual(h.progress, [true], 'repeated running statuses never churn the indicator')
    h.routeStatus('main', 'idle')
    h.routeStatus('main', 'idle')
    await drain()
    assert.deepEqual(h.progress, [true, false], 'a repeated idle writes ONE clear')
  } finally {
    h.dispose()
  }
})

test('a child or stale agent status never touches the pane progress', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('child', 'running')
    controls.routeStatus('child', 'idle')
    controls.routeStatus('retired', 'running')
  })
  try {
    await drain()
    assert.deepEqual(h.progress, [false], 'only the mount claim ran; no status projected progress')
    h.routeStatus('main', 'running')
    await drain()
    assert.deepEqual(h.progress, [false, true], 'the main Agent still projects after the child/stale noise')
  } finally {
    h.dispose()
  }
})

test('a completion-owner commit clears the retiree progress and the new owner must prove running', async () => {
  const h = mountSurface((controls) => controls.setOwner('A'))
  try {
    h.routeStatus('A', 'running')
    await drain()
    assert.deepEqual(h.progress, [false, true], 'owner A running projects busy')
    h.setOwner('B')
    assert.deepEqual(h.progress, [false, true, false], 'the owner commit clears the retiree busy state immediately')
    h.routeStatus('A', 'idle')
    h.routeStatus('A', 'running')
    h.routeStatus('B', 'idle')
    await drain()
    assert.deepEqual(h.progress, [false, true, false], 'late A statuses and a first-idle B are inert')
    h.routeStatus('B', 'running')
    await drain()
    assert.deepEqual(h.progress, [false, true, false, true], 'B becomes busy only after its own running event')
  } finally {
    h.dispose()
  }
})

test('surface disposal retires the pane progress before the mounted app dies', async () => {
  const h = mountSurface((controls) => controls.setOwner('main'))
  try {
    h.routeStatus('main', 'running')
    await drain()
    assert.deepEqual(h.progress, [false, true])
    h.dispose()
    assert.deepEqual(h.progress, [false, true, false], 'disposal clears the busy hint explicitly')
  } finally {
    h.dispose()
  }
})

test('disposal clears the REAL OSC 9;4 indicator and stops its keepalive (plan §12.8)', async (t) => {
  // Only setInterval is mocked: the terminal-owned keepalive is then provable
  // without a wall-clock wait. `setProgress` / `stop` stay the REAL
  // `ProcessTerminal` implementations (the plan's low-level authority), so the
  // assertion is against actual production bytes and the actual interval.
  t.mock.timers.enable({ apis: ['setInterval'] })
  const writes: string[] = []
  // The stdout spy is installed ONLY around synchronous capture windows: no
  // other task can run inside them, so the node:test child (which reports its
  // results through stdout) can neither lose a result line nor have raw OSC
  // bytes injected into the report.
  const captured = <T>(run: () => T): T => {
    const previousWrite = process.stdout.write
    process.stdout.write = ((chunk: unknown) => { writes.push(String(chunk)); return true }) as never
    try {
      return run()
    } finally {
      process.stdout.write = previousWrite
    }
  }
  const activeWrites = (): number => writes.filter(write => write === '\x1b]9;4;1;0\x07').length
  const clearWrites = (): number => writes.filter(write => write === '\x1b]9;4;0\x07').length
  // X059: only a terminal known to expire OSC 9;4 state owns the 1 s heartbeat,
  // and the policy is snapshotted when `ProcessTerminal` is constructed inside
  // mountSurface. Pin Ghostty so this case keeps proving the REAL interval and
  // its teardown; the persistent-terminal one-shot path (Tern) is covered by
  // packages/pi-tui/test/terminal.test.ts.
  const previousTermProgram = process.env.TERM_PROGRAM
  process.env.TERM_PROGRAM = 'ghostty'
  // The MOUNT is itself a capture window: the very first real byte is the
  // claim clear (see below) and must not leak into the report.
  const h = (() => {
    try {
      return captured(() => mountSurface((controls) => controls.setOwner('main'), { realProgress: true }))
    } finally {
      if (previousTermProgram === undefined) delete process.env.TERM_PROGRAM
      else process.env.TERM_PROGRAM = previousTermProgram
    }
  })()
  try {
    // The mount CLAIM is the first real byte: the fresh TuiApp asserts the idle
    // state, which is what clears a pane the terminal had already painted busy
    // (Tern marks a pane running while `dsh` itself is the foreground command).
    const clearedAtMount = clearWrites()
    assert.equal(clearedAtMount, 1, 'the mount claims the idle state with one real OSC 9;4 clear')
    assert.equal(activeWrites(), 0, 'the mount must not paint an active indicator')
    captured(() => h.routeStatus('main', 'running'))
    await drain()
    assert.equal(activeWrites(), 1, 'a running status writes ONE real OSC 9;4 active sequence')
    assert.equal(clearWrites(), clearedAtMount, 'a running status adds no clear')
    captured(() => t.mock.timers.tick(1000))
    assert.equal(activeWrites(), 2, 'the terminal keepalive re-asserts the active indicator')
    captured(() => h.dispose())
    assert.equal(clearWrites(), clearedAtMount + 1, 'disposal clears the real indicator')
    const activeAfterDispose = activeWrites()
    captured(() => t.mock.timers.tick(5000))
    assert.equal(activeWrites(), activeAfterDispose, 'no keepalive survives disposal')
    assert.equal(clearWrites(), clearedAtMount + 1, 'no later progress write survives disposal')
  } finally {
    h.dispose()
  }
})

test('notification mode off suppresses the toast but never the pane progress (plan §15)', async () => {
  const notifications: string[] = []
  const presentation: TerminalNotificationPresentation = {
    ...nullPresentation,
    notify: (method, title, body) => { notifications.push(`${method}:${title}:${body}`) },
  }
  const h = mountSurface((controls) => controls.setOwner('main'), {
    presentation,
    notificationMode: 'off',
    notificationMethod: 'bell',
  })
  try {
    h.routeStatus('main', 'running')
    await drain()
    assert.deepEqual(h.progress, [false, true], 'the running state projects progress regardless of notification mode')
    h.routeStatus('main', 'idle')
    await drain()
    assert.deepEqual(h.progress, [false, true, false], 'the idle state clears progress regardless of notification mode')
    assert.deepEqual(notifications, [], 'mode off still suppresses the completion toast')
  } finally {
    h.dispose()
  }
})

// ── Tern waiting_input refinement (PR B / fork X059) ────────────────────────
//
// The canonical RunPhase is the FIRST input of the pane-progress projection, and
// the lifecycle-owned `agentInputWait` fact is the second: a `waiting-question` /
// `waiting-approval` phase pauses the pane ONLY when the Agent is BLOCKED on that
// wait. "This form came from the Agent channel" is not enough — a CONTINUED
// late-answer form comes from that channel and must not pause. The positives below
// enter through the real Agent port (`InteractionPort.onApprovalRequest` /
// `QuestionInteractionPort` provider), so the assertion covers
// source -> lifecycle decision -> TuiApp -> TerminalProgressState; the negatives
// prove a Client-local question (the `/login` authorization shape)
// keeps the pane working even though the canonical phase IS `waiting-question`.

test('a Tern AGENT approval pauses the pane and settling it returns to working', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  }, { tern: true })
  try {
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate'],
      'the FIRST acquisition asserts the latched running state (no idle -> working flash)')

    const controller = new AbortController()
    const decision = h.agentApproval({ toolName: 'bash', reason: 'probe', signal: controller.signal })
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused'],
      'the Agent approval port projects waiting_input immediately (no agent/status needed)')
    controller.abort()
    await decision
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused', 'indeterminate'],
      'the settled wait returns to working while the Agent keeps running')
    assert.deepEqual(h.progress, [], 'the Tern path never falls back to the boolean projection')
  } finally {
    h.dispose()
  }
})

test('a Tern AGENT question flow pauses the pane and settling it returns to working', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  }, { tern: true })
  try {
    await drain()
    const controller = new AbortController()
    const answer = h.agentQuestion(controller.signal)
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused'],
      'the live Agent question projects waiting_input immediately')
    controller.abort()
    await answer.catch(() => {})
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused', 'indeterminate'],
      'the settled question returns to working while the Agent keeps running')
  } finally {
    h.dispose()
  }
})

test('a CLIENT-LOCAL question never pauses the Tern pane (the /login authorization shape)', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  }, { tern: true })
  try {
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate'])

    // `src/app/command/authorization.ts` / the `/login` command ask through the SAME
    // `TuiApp.askQuestions` entry point, with the fail-closed `agentInputWait =
    // false` default: the canonical phase still becomes `waiting-question`
    // (footer/Focus keep their authority) but the main Agent is NOT blocked on
    // this input.
    const controller = new AbortController()
    const answer = h.app.askQuestions(
      [{ id: 'auth', question: 'API key', masked: true }],
      controller.signal,
    )
    assert.equal(h.phase(), 'waiting-question', 'the canonical surface phase is the generic wait phase')
    assert.deepEqual(h.progressStates, ['indeterminate'],
      'a Client-local question must NEVER project the Agent waiting_input state')
    controller.abort()
    await answer.catch(() => {})
    await drain()
    assert.equal(h.phase(), 'idle', 'the local flow settled')
    assert.deepEqual(h.progressStates, ['indeterminate'], 'and the pane never left the working state')
  } finally {
    h.dispose()
  }
})

test('a timed Agent question hands over to its own CONTINUED form without pausing the pane', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  }, { tern: true })
  try {
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate'])

    // The Host timed-wait claim: it ends when the Host records the timed result.
    let endWait!: () => void
    const ended = new Promise<void>(resolve => { endWait = resolve })
    let releases = 0
    h.setClaim({ remainingMs: 60_000, ended, release: () => { releases += 1 } })

    // 1. The LIVE foreground Agent wait: the Agent IS blocked -> waiting_input.
    //    Nothing below sends another agent/status; every transition is driven by
    //    the real controller lifecycle.
    const live = h.agentQuestion(undefined, { timed: true, callId: 'call-timed' })
    await drain()
    assert.equal(h.phase(), 'waiting-question')
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused'],
      'the live foreground Agent wait is Agent-blocking')
    assert.equal(releases, 0, 'the claim is held while the foreground wait runs')

    // 2. The Host records the timed result: the SAME call is now `continued` and
    //    the Agent has already continued ("Your answer will arrive as a new
    //    turn").
    h.setQuestionSnapshot({
      sessionId: 'session-terminal-progress-test',
      active: [{
        sessionId: 'session-terminal-progress-test',
        callId: 'call-timed',
        state: 'continued',
        questions: [{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }],
      }],
      settled: [],
      queuedReplyCallIds: new Set(),
    })

    // 3. The Host wait ENDS: the controller closes the foreground attempt and its
    //    own awaitContinued() re-offers the call as the editable late answer.
    endWait()
    await live.catch(() => {})
    await drain()
    assert.equal(h.phase(), 'waiting-question', 'the late-answer form still owns the surface')
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused', 'indeterminate'],
      'the Agent already continued: the pane leaves waiting_input and returns to working')
    assert.equal(releases, 1, 'the ended claim is released exactly once')
  } finally {
    h.dispose()
  }
})

test('a CONTINUED Agent question (reopened late answer) never pauses the Tern pane', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  }, { tern: true })
  try {
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate'])

    // The Host wait ENDED: the call is `continued` and the Agent already
    // continued — its own form says "The Agent continued. Your answer will
    // arrive as a new turn". The projection change feed makes the surface
    // discover the late-answer call (cold discovery: nothing is auto-revealed).
    h.setQuestionSnapshot({
      sessionId: 'session-terminal-progress-test',
      active: [{
        sessionId: 'session-terminal-progress-test',
        callId: 'call-late',
        state: 'continued',
        questions: [{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }],
      }],
      settled: [],
      queuedReplyCallIds: new Set(),
    })
    h.notifyQuestionChange()
    await drain()
    assert.equal(h.phase(), 'idle', 'a parked continued call does not own the surface')
    assert.deepEqual(h.progressStates, ['indeterminate'])

    // The user reopens the late-answer form from the Task Center.
    assert.equal(h.reopenContinued('call-late'), true, 'the continued call is answerable')
    await drain()
    assert.equal(h.phase(), 'waiting-question', 'the late-answer form IS a presented question')
    assert.deepEqual(h.progressStates, ['indeterminate'],
      'but the Agent is NOT blocked on it: a continued question must never show waiting_input')
  } finally {
    h.dispose()
  }
})

test('a question FIFO handover from a LOCAL flow to an AGENT flow pauses the pane', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  }, { tern: true })
  try {
    await drain()
    const local = new AbortController()
    const localAnswer = h.app.askQuestions(
      [{ id: 'auth', question: 'API key', masked: true }],
      local.signal,
    )
    assert.equal(h.phase(), 'waiting-question')
    assert.deepEqual(h.progressStates, ['indeterminate'], 'a Client-local wait is not Agent waiting_input')

    // The Agent question queues BEHIND the local one: the seat is occupied, so
    // its own agentInputWait must not move the pane yet.
    const agent = new AbortController()
    const agentAnswer = h.agentQuestion(agent.signal)
    await drain()
    assert.equal(h.phase(), 'waiting-question')
    assert.deepEqual(h.progressStates, ['indeterminate'], 'a queued wait does not own the surface yet')

    // Settle the local flow: the seat hands over to the Agent question while the
    // canonical phase stays `waiting-question`, so ONLY a re-projection of the new
    // flow's agentInputWait can flip the pane.
    local.abort()
    await localAnswer.catch(() => {})
    await drain()
    assert.equal(h.phase(), 'waiting-question', 'the phase is unchanged across the handover')
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused'],
      'the handover re-derives the pane state from the NEW (Agent-owned) flow')

    agent.abort()
    await agentAnswer.catch(() => {})
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused', 'indeterminate'])
  } finally {
    h.dispose()
  }
})

test('a question FIFO handover from an AGENT flow to a LOCAL flow returns the pane to working', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  }, { tern: true })
  try {
    await drain()
    const agent = new AbortController()
    const agentAnswer = h.agentQuestion(agent.signal)
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused'])

    // A Client-local flow queues behind the Agent question.
    const local = new AbortController()
    const localAnswer = h.app.askQuestions(
      [{ id: 'auth', question: 'API key', masked: true }],
      local.signal,
    )
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused'], 'the queued local wait is not projected')

    agent.abort()
    await agentAnswer.catch(() => {})
    await drain()
    assert.equal(h.phase(), 'waiting-question', 'the phase is unchanged across the handover')
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused', 'indeterminate'],
      'the handover to a Client-local flow must DROP waiting_input')

    local.abort()
    await localAnswer.catch(() => {})
    await drain()
    assert.equal(h.phase(), 'idle')
  } finally {
    h.dispose()
  }
})

test('a plan-review prompt reaches waiting_input through the real Approval port', async () => {
  // The state comes from the Agent approval port, NOT from matching the
  // `exit_plan_mode` tool name: the SAME flow pauses for a `bash` prompt
  // (previous test) and an unattended attention count does not.
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  }, { tern: true })
  try {
    await drain()
    const controller = new AbortController()
    const decision = h.agentApproval({
      toolName: 'exit_plan_mode',
      reason: 'review the plan',
      signal: controller.signal,
    })
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused'])
    controller.abort()
    await decision
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused', 'indeterminate'])
  } finally {
    h.dispose()
  }
})

test('parked question ATTENTION alone never pauses the Tern pane', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  }, { tern: true })
  try {
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate'])
    // A parked (not presented) Question is Task Center attention only: it owns
    // no response surface, so the phase is NOT waiting-question.
    h.app.setQuestionAttention(2)
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate'],
      'attention without a presented flow keeps the working state')
  } finally {
    h.dispose()
  }
})

test('a Tern owner commit clears a paused state and a late retired owner cannot restore it', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('A')
    controls.routeStatus('A', 'running')
  }, { tern: true })
  try {
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate'])
    const controller = new AbortController()
    const decision = h.agentApproval({ toolName: 'bash', reason: 'probe', signal: controller.signal })
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused'])

    h.setOwner('B')
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused', 'clear'],
      'the owner commit clears the retiree pause immediately')
    controller.abort()
    await decision
    h.routeStatus('A', 'running')
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused', 'clear'],
      'a late retired owner status can restore neither paused nor working')
    h.routeStatus('B', 'running')
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused', 'clear', 'indeterminate'],
      'the new owner proves running through its own status')
  } finally {
    h.dispose()
  }
})

test('a stopped Tern app folds running and phase changes and projects the latest state once', async () => {
  const { app, progress, states } = mountApp(true)
  try {
    app.setTerminalProgress(true)
    assert.deepEqual(states, ['clear', 'indeterminate'], 'the mount claims idle, then running shows working')
    app.stop()
    app.setTerminalProgress(false)
    app.setTerminalProgress(true)
    assert.deepEqual(states, ['clear', 'indeterminate'], 'a stopped surface never writes physical progress')
    app.start()
    assert.deepEqual(states, ['clear', 'indeterminate', 'indeterminate'],
      'the restart projects the latest effective state exactly once')
    assert.deepEqual(progress, [], 'the Tern path never falls back to the boolean projection')
  } finally {
    app.dispose()
  }
})

test('a $EDITOR-suspended Tern app folds a wait opening and resumes directly to paused', async () => {
  const vt = new VirtualTerminal(80, 24)
  const states: TerminalProgressState[] = []
  const progress: boolean[] = []
  vt.setProgress = (active: boolean) => { progress.push(active) }
  vt.setProgressState = (state: TerminalProgressState) => { states.push(state) }
  let release!: (text: string) => void
  const gate = new Promise<string>(resolve => { release = resolve })
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: () => gate,
    runOwned: () => {},
  }, { ternTerminal: true })
  app.start()
  startedApps.add(app)
  try {
    app.setTerminalProgress(true)
    assert.deepEqual(states, ['clear', 'indeterminate'])

    // $EDITOR takes the PTY for the whole time this promise is pending.
    const pending = app.launchExternalEditor()

    // The wait OPENS while the editor owns the terminal: only the desired
    // state is folded, the editor's screen never receives progress bytes.
    const controller = new AbortController()
    const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'probe', signal: controller.signal }, true)
    assert.deepEqual(states, ['clear', 'indeterminate'],
      'a suspended terminal receives no progress bytes for the opening wait')

    release('edited')
    await pending
    assert.deepEqual(states, ['clear', 'indeterminate', 'paused'],
      'the resume emits ONLY the latest effective state (the folded wait), exactly once')

    controller.abort()
    await decision
    await drain()
    assert.deepEqual(states, ['clear', 'indeterminate', 'paused', 'indeterminate'],
      'the settled wait returns to working on the resumed terminal')
    assert.deepEqual(progress, [])
  } finally {
    app.dispose()
  }
})

test('a $EDITOR-suspended Tern app folds a wait settling and an idle round-trip, then resumes the latest state', async () => {
  const vt = new VirtualTerminal(80, 24)
  const states: TerminalProgressState[] = []
  vt.setProgressState = (state: TerminalProgressState) => { states.push(state) }
  let release!: (text: string) => void
  const gate = new Promise<string>(resolve => { release = resolve })
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: () => gate,
    runOwned: () => {},
  }, { ternTerminal: true })
  app.start()
  startedApps.add(app)
  try {
    app.setTerminalProgress(true)
    assert.deepEqual(states, ['clear', 'indeterminate'])

    const pending = app.launchExternalEditor()

    // The wait opens AND settles while the editor owns the terminal, then the
    // Agent goes idle: every change is folded, none is written.
    const controller = new AbortController()
    const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'probe', signal: controller.signal }, true)
    controller.abort()
    await decision
    await drain()
    app.setTerminalProgress(false)
    assert.deepEqual(states, ['clear', 'indeterminate'],
      'a suspended terminal receives no progress bytes for the opened/settled wait or the idle change')

    release('edited')
    await pending
    assert.deepEqual(states, ['clear', 'indeterminate', 'clear'],
      'the resume emits ONLY the latest effective state (idle), not the stale working one')
  } finally {
    app.dispose()
  }
})

test('a Tern terminal without the stateful projection fails soft to the working indicator', async () => {
  const vt = new VirtualTerminal(80, 24)
  const progress: boolean[] = []
  vt.setProgress = (active: boolean) => { progress.push(active) }
  // A terminal that does NOT implement the fork's richer projection (plan
  // §9.3): the paused target must degrade to the boolean working/clear pair and
  // never to a raw escape write.
  Object.defineProperty(vt, 'setProgressState', { value: undefined, configurable: true })
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { ternTerminal: true })
  app.start()
  startedApps.add(app)
  try {
    assert.deepEqual(progress, [false], 'the mount asserts idle through the boolean contract')
    app.setTerminalProgress(true)
    assert.deepEqual(progress, [false, true])

    const controller = new AbortController()
    const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'probe', signal: controller.signal }, true)
    assert.deepEqual(progress, [false, true, true],
      'a paused target re-asserts the working indicator (idempotent bytes), never a clear or a raw sequence')
    controller.abort()
    await decision
    await drain()
    assert.deepEqual(progress, [false, true, true, true],
      'the settled wait is still working and the pane never left the active state')
  } finally {
    app.dispose()
  }
})

test('a fullscreen swap while paused restores the paused state on the new screen', async () => {
  const { app, states } = mountApp(true)
  try {
    app.setTerminalProgress(true)
    const controller = new AbortController()
    const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'probe', signal: controller.signal }, true)
    assert.deepEqual(states, ['clear', 'indeterminate', 'paused'])
    app.setFullscreen(true)
    app.setFullscreen(false)
    assert.deepEqual(states, ['clear', 'indeterminate', 'paused', 'paused', 'paused'],
      'every screen restart re-asserts the current paused state (the stop cleared the pane)')
    controller.abort()
    await decision
    await drain()
    assert.deepEqual(states, ['clear', 'indeterminate', 'paused', 'paused', 'paused', 'indeterminate'])
  } finally {
    app.dispose()
  }
})

// ── Terminal progress presentation preference (plan §12.8/§12.9) ─────────────
//
// The "Terminal progress" setting is a presentation GATE over the SAME
// authoritative fold (main-running truth + canonical RunPhase + agentInputWait),
// never a second Agent-state authority. The tests below drive the REAL surface
// seam (`SurfaceRuntime.setTerminalProgressMode`) and the real Agent approval
// port, so disabling/re-enabling is proven against the production lifecycle.

test('turning terminal progress off clears immediately and suppresses later active/paused writes', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  }, { tern: true })
  try {
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate'], 'the enabled running state projects working')

    h.setTerminalProgressMode('off')
    assert.deepEqual(h.progressStates, ['indeterminate', 'clear'],
      'disabling asserts ONE clear through the same low-level path')

    // Semantic churn while off: an Agent-blocking wait opens and settles, then
    // the Agent goes idle. Nothing physical may be written.
    const controller = new AbortController()
    const decision = h.agentApproval({ toolName: 'bash', reason: 'probe', signal: controller.signal })
    assert.deepEqual(h.progressStates, ['indeterminate', 'clear'],
      'opening an Agent-blocking wait writes no paused state while off')
    controller.abort()
    await decision
    await drain()
    h.routeStatus('main', 'idle')
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate', 'clear'],
      'settling the wait and going idle write no active/paused bytes while off')
  } finally {
    h.dispose()
  }
})

test('turning terminal progress back on while running reprojects working immediately', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  }, { tern: true })
  try {
    await drain()
    h.setTerminalProgressMode('off')
    assert.deepEqual(h.progressStates, ['indeterminate', 'clear'])

    // NO new agent/status: re-enabling reprojects the still-running truth.
    h.setTerminalProgressMode('on')
    assert.deepEqual(h.progressStates, ['indeterminate', 'clear', 'indeterminate'],
      're-enabling writes the CURRENT effective state without a new Agent status')
  } finally {
    h.dispose()
  }
})

test('off/on while the Agent is blocked on a wait clears and then restores paused', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  }, { tern: true })
  try {
    await drain()
    const controller = new AbortController()
    const decision = h.agentApproval({ toolName: 'bash', reason: 'probe', signal: controller.signal })
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused'])

    h.setTerminalProgressMode('off')
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused', 'clear'])
    h.setTerminalProgressMode('on')
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused', 'clear', 'paused'],
      'the Agent-blocking wait truth survives the toggle and reprojects waiting_input')

    controller.abort()
    await decision
    await drain()
    assert.deepEqual(h.progressStates, ['indeterminate', 'paused', 'clear', 'paused', 'indeterminate'],
      'settling returns to working because the Agent is still running')
  } finally {
    h.dispose()
  }
})

test('a surface mounted with terminal progress off asserts clear and suppresses every acquisition', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    // The pre-mount running latch must NOT be projected while off.
    controls.routeStatus('main', 'running')
  }, { tern: true, terminalProgress: 'off' })
  try {
    await drain()
    assert.deepEqual(h.progressStates, ['clear'],
      'the mount asserts clear instead of the latched running state')
    h.app.stop()
    h.app.start()
    assert.deepEqual(h.progressStates, ['clear', 'clear'],
      'a reacquisition while off asserts clear again and no active/paused bytes')
  } finally {
    h.dispose()
  }
})

test('a disabled surface still folds the truth and projects the current state only on re-enable', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  }, { tern: true, terminalProgress: 'off' })
  try {
    await drain()
    // running -> waiting_input -> running while off: no physical writes.
    const controller = new AbortController()
    const decision = h.agentApproval({ toolName: 'bash', reason: 'probe', signal: controller.signal })
    controller.abort()
    await decision
    await drain()
    assert.deepEqual(h.progressStates, ['clear'], 'the whole off window stays physically clear')

    h.setTerminalProgressMode('on')
    assert.deepEqual(h.progressStates, ['clear', 'indeterminate'],
      're-enabling projects the CURRENT folded truth exactly once, not a replay of the suppressed churn')
  } finally {
    h.dispose()
  }
})

// ── OSC 7501: real routing -> evidence fold -> terminal sink (plan §6.3) ─────
//
// Every expectation below is the EXACT record byte sequence; the L1 suite pins
// the encoder, so this suite proves the production ROUTING, the interval
// evidence fold and the SETTLE timing — not the encoding.

const IDLE = '\x1b]7501;state=idle:app=dsh-pi-tui\x1b\\'
const WORKING = '\x1b]7501;state=working:app=dsh-pi-tui\x1b\\'
const DONE = '\x1b]7501;state=done:app=dsh-pi-tui\x1b\\'
const ERROR = '\x1b]7501;state=error:app=dsh-pi-tui\x1b\\'
const CLEAR = '\x1b]7501;state=clear\x1b\\'
const PERMISSION = '\x1b]7501;state=blocked:kind=permission:app=dsh-pi-tui\x1b\\'
const QUESTION = '\x1b]7501;state=blocked:kind=question:app=dsh-pi-tui\x1b\\'

/** Drive one FULL running interval through the real router. */
async function driveInterval(
  h: SurfaceHarness,
  reasonKind: string | undefined,
  agentId = 'main',
  turn = 1,
): Promise<void> {
  h.routeStatus(agentId, 'running')
  await drain()
  h.routeSession({ type: 'turn/start', data: { turn } })
  await drain()
  if (reasonKind !== undefined) {
    h.routeSession({ type: 'turn/end', data: { turn, reason: { kind: reasonKind } } })
    await drain()
  }
  h.routeStatus(agentId, 'idle')
  await drain()
}

test('a real completed interval settles done exactly once, after the 9;4 clear and with no idle between', async () => {
  const h = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    assert.deepEqual(h.programWrites, [IDLE], 'the mount asserts idle')
    h.routeStatus('main', 'running')
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING])
    assert.deepEqual(h.progress, [false, true])

    h.routeSession({ type: 'turn/start', data: { turn: 1 } })
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING], 'turn/start alone writes no terminal record')
    h.routeSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING],
      'turn/end captures evidence ONLY — the completion is committed at the idle transition')

    h.routeStatus('main', 'idle')
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING, DONE],
      'ONE settle commit: no intermediate idle between working and done')
    assert.deepEqual(h.progress, [false, true, false], '9;4 clears on the same transition')
    assert.deepEqual(h.timeline, [
      '9;4:clear', '7501:idle',
      '9;4:active', '7501:working',
      '9;4:clear', '7501:done',
    ], 'the merged timeline proves 9;4 precedes 7501 on BOTH transitions and no idle sits between working and done')
  } finally {
    h.dispose()
  }
})

test('every official turn-end reason classifies to the fixed OSC 7501 outcome', async () => {
  const cases: ReadonlyArray<readonly [string | undefined, string]> = [
    ['completed', DONE],
    ['error', ERROR],
    ['max-tokens', ERROR],
    ['aborted', IDLE],
    ['blocked', IDLE],
    ['interrupted', IDLE],
    ['forked', IDLE],
    ['a-future-kind-not-in-this-repo', IDLE],
    [undefined, IDLE],
  ]
  for (const [reasonKind, expected] of cases) {
    const h = mountSurface((controls) => controls.setOwner('main'))
    try {
      await drain()
      await driveInterval(h, reasonKind)
      assert.deepEqual(h.programWrites, [IDLE, WORKING, expected],
        `turn/end reason ${reasonKind ?? '<none>'} must settle ${expected}`)
    } finally {
      h.dispose()
    }
  }
})

test('an unmatched turn/end never becomes the interval outcome', async () => {
  const h = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    h.routeStatus('main', 'running')
    await drain()
    h.routeSession({ type: 'turn/start', data: { turn: 1 } })
    await drain()
    // A turn/end for a DIFFERENT turn is not this interval's completion.
    h.routeSession({ type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
    await drain()
    h.routeSession({ type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } })
    await drain()
    h.routeStatus('main', 'idle')
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING, IDLE],
      'no matched turn/end means NO completion evidence — never a guessed done/error')
  } finally {
    h.dispose()
  }
})

test('the Remote authority keeps the durable ingress out of the local interval', async () => {
  // R1 §5.3 (STOP-DOUBLE): on the Remote branch the Host evidence stream owns
  // the main terminal outcome, so the durable `session/event` ingress may feed
  // the transcript but must NEVER settle the local interval. The interval is
  // activated the way the Host evidence will activate it; in this fixture the
  // surface's own status routing stands in for that Host edge (production never
  // installs the Direct `agent/status` channel on the Remote branch), while the
  // DURABLE turn evidence below is the real ingress under test.
  const h = mountSurface((controls) => controls.setOwner('main'), { mainProgressAuthority: 'host-snapshot' })
  try {
    await drain()
    h.routeStatus('main', 'running')
    await drain()
    h.routeSession({ type: 'turn/start', data: { turn: 1 } })
    h.routeSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING],
      'the durable turn evidence writes NOTHING under the Remote authority')
    h.routeStatus('main', 'idle')
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING, IDLE],
      'the settled outcome cannot come from the durable ingress — the Host evidence owns it')
  } finally {
    h.dispose()
  }
})

test('the Remote feed commits the Host fact, and a lineage restart re-baselines the controller', async () => {
  const notifications: string[] = []
  const presentation: TerminalNotificationPresentation = {
    ...nullPresentation,
    notify: (method, title, body) => { notifications.push(`${method}:${title}:${body}`) },
  }
  const h = mountSurface((controls) => controls.setOwner('main'), {
    presentation,
    // 'always': the fixture never reports terminal focus, and the controller's
    // initial focus is honestly 'unfocused' (mode 'unfocused' would suppress).
    notificationMode: 'always',
    notificationMethod: 'bell',
  })
  try {
    await drain()
    const feed = (
      fact: { kind: 'snapshot' | 'update'; restart: boolean; running: boolean; outcome: 'idle' | 'done' | 'error' },
    ): void => { h.surfaceRuntime.applyRemoteMainProgress(fact, 'main') }

    // 1. The first edge of a fresh lineage: the restart frame IS a real Host
    //    update, so (after re-baselining) it feeds the controller.
    feed({ kind: 'update', restart: true, running: true, outcome: 'idle' })
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING], 'the Remote fact drives the same single commit as Direct')

    // 2. A NEW lineage that is already idle (Host remount / Agent replacement):
    //    the display adopts idle, but the PREVIOUS lineage's running edge must
    //    never pair with it into a false completion.
    feed({ kind: 'update', restart: true, running: false, outcome: 'idle' })
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING, IDLE], 'the restarted lineage shows idle')
    assert.deepEqual(notifications, [], 'a lineage restart never notifies')

    // 3. The same lineage still notifies exactly once: a continued running edge
    //    followed by a continued settle.
    feed({ kind: 'update', restart: true, running: true, outcome: 'idle' })
    await drain()
    feed({ kind: 'update', restart: false, running: false, outcome: 'done' })
    await drain()
    assert.deepEqual(notifications, ['bell:DSH:Turn complete'],
      'the real running -> idle edge of one lineage notifies once')

    // 4. A CONNECTING snapshot of the SAME lineage is display truth only: it
    //    never notifies, and the following real idle edge still notifies once.
    notifications.length = 0
    feed({ kind: 'update', restart: false, running: true, outcome: 'idle' })
    feed({ kind: 'snapshot', restart: false, running: true, outcome: 'idle' })
    await drain()
    assert.deepEqual(notifications, [], 'an opening snapshot never notifies')
    feed({ kind: 'update', restart: false, running: false, outcome: 'done' })
    await drain()
    assert.deepEqual(notifications, ['bell:DSH:Turn complete'],
      'the interval observed running before the snapshot still notifies once')
    assert.deepEqual(h.programWrites, [IDLE, WORKING, IDLE, WORKING, DONE, WORKING, DONE],
      'the snapshot re-asserts the running display without a duplicate write')
  } finally {
    h.dispose()
  }
})

test('L4: the Direct adapter publishes exactly the shared fold commits for the same evidence', async () => {
  // R1 §5.4: the SAME explainable evidence sequence drives (a) the mounted
  // surface's real Direct adapter and (b) a bare shared-fold instance. The two
  // must agree commit for commit — this is the shared-semantics proof, not a
  // pre-computed-outcome parity.
  const labels = (active: boolean, outcome: string): string =>
    active ? WORKING : (outcome === 'done' ? DONE : outcome === 'error' ? ERROR : IDLE)
  type Step =
    | { readonly status: boolean }
    | { readonly turnStart: number }
    | { readonly turnEnd: readonly [number, string] }
  const scripts: ReadonlyArray<readonly Step[]> = [
    [{ status: true }, { turnStart: 1 }, { turnEnd: [1, 'completed'] }, { status: false }],
    [{ status: true }, { turnStart: 1 }, { turnEnd: [1, 'error'] }, { status: false }],
    [{ status: true }, { turnStart: 1 }, { turnEnd: [1, 'max-tokens'] }, { status: false }],
    [{ status: true }, { turnStart: 1 }, { turnEnd: [1, 'aborted'] }, { status: false }],
    [{ status: true }, { turnStart: 1 }, { turnEnd: [1, 'a-future-kind-not-in-this-repo'] }, { status: false }],
    // The LAST valid closed turn decides; an unmatched end never does.
    [{ status: true }, { turnStart: 1 }, { turnEnd: [1, 'completed'] }, { turnStart: 2 }, { turnEnd: [2, 'error'] }, { status: false }],
    [{ status: true }, { turnStart: 1 }, { turnEnd: [9, 'completed'] }, { status: false }],
    // An unclosed open turn has no evidence at all.
    [{ status: true }, { turnStart: 1 }, { status: false }],
    // Repeated statuses are inert in both directions.
    [{ status: true }, { status: true }, { turnStart: 1 }, { turnEnd: [1, 'completed'] }, { status: false }, { status: false }],
    // A second, independent interval settles on its own evidence.
    [{ status: true }, { turnStart: 1 }, { turnEnd: [1, 'aborted'] }, { status: false }, { status: true }, { turnStart: 2 }, { turnEnd: [2, 'completed'] }, { status: false }],
  ]
  for (const [index, script] of scripts.entries()) {
    const h = mountSurface((controls) => controls.setOwner('main'))
    try {
      await drain()
      const fold = createTerminalProgressInterval()
      const expected: string[] = []
      for (const step of script) {
        if ('status' in step) {
          const progress = fold.status(step.status)
          if (progress !== undefined) expected.push(labels(progress.active, progress.outcome))
          h.routeStatus('main', step.status ? 'running' : 'idle')
        } else if ('turnStart' in step) {
          fold.turnStart(step.turnStart)
          h.routeSession({ type: 'turn/start', data: { turn: step.turnStart } })
        } else {
          fold.turnEnd(step.turnEnd[0], step.turnEnd[1])
          h.routeSession({ type: 'turn/end', data: { turn: step.turnEnd[0], reason: { kind: step.turnEnd[1] } } })
        }
        await drain()
      }
      // `slice(1)` drops the mount's initial idle assertion: the script drives
      // the interval AFTER the mount, exactly like the fold instance.
      assert.deepEqual(h.programWrites.slice(1), expected,
        `script ${String(index)} must publish exactly the shared fold's commits`)
    } finally {
      h.dispose()
    }
  }
})

test('an unknown upstream turn-end reason is diagnosed, not guessed', async () => {
  const warnings: Array<{ message: string; fields: Record<string, unknown> | undefined }> = []
  const diag = {
    debug: () => {},
    info: () => {},
    warn: (message: string, fields?: Record<string, unknown>) => { warnings.push({ message, fields }) },
    error: () => {},
    dispose: () => {},
  } satisfies Diag
  const h = mountSurface((controls) => controls.setOwner('main'), { diag })
  try {
    await drain()
    await driveInterval(h, 'a-future-kind-not-in-this-repo')
    assert.deepEqual(h.programWrites, [IDLE, WORKING, IDLE],
      'an unrecognized closer is honestly idle')
    assert.equal(warnings.length, 1, 'the unknown kind is recorded exactly once')
    assert.match(warnings[0]!.message, /unknown turn\/end reason/u)
    assert.deepEqual(warnings[0]!.fields, { kind: 'a-future-kind-not-in-this-repo' },
      'the diagnosis names the actual upstream kind')
  } finally {
    h.dispose()
  }
})

test('notification mode off never suppresses the OSC 7501 settle', async () => {
  const notifications: string[] = []
  const presentation: TerminalNotificationPresentation = {
    ...nullPresentation,
    notify: (method, title, body) => { notifications.push(`${method}:${title}:${body}`) },
  }
  const h = mountSurface((controls) => controls.setOwner('main'), {
    presentation,
    notificationMode: 'off',
    notificationMethod: 'bell',
  })
  try {
    await drain()
    await driveInterval(h, 'completed')
    assert.deepEqual(h.programWrites, [IDLE, WORKING, DONE],
      'the settle projection is independent of the notification policy')
    assert.deepEqual(notifications, [], 'mode off still suppresses the completion toast')
  } finally {
    h.dispose()
  }
})

test('a later turn replaces the earlier candidate: only the final error is reported', async () => {
  const h = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    h.routeStatus('main', 'running')
    await drain()
    h.routeSession({ type: 'turn/start', data: { turn: 1 } })
    h.routeSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING], 'turn 1 completed must NOT emit done mid-interval')
    h.routeSession({ type: 'turn/start', data: { turn: 2 } })
    h.routeSession({ type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } })
    await drain()
    h.routeStatus('main', 'idle')
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING, ERROR],
      'the interval settles on its LAST completed turn, and done was never shown')
  } finally {
    h.dispose()
  }
})

test('a real Agent approval or question projects blocked while the non-Tern 9;4 stays working', async () => {
  const h = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    h.routeStatus('main', 'running')
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING])

    const approval = new AbortController()
    const decision = h.agentApproval({ toolName: 'bash', reason: 'probe', signal: approval.signal })
    assert.deepEqual(h.programWrites, [IDLE, WORKING, PERMISSION],
      'the live Agent approval is the ONLY source of blocked:permission')
    assert.deepEqual(h.progress, [false, true],
      'the non-Tern 9;4 projection stays the plain working pair while 7501 blocks')
    approval.abort()
    await decision
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING, PERMISSION, WORKING])

    const question = new AbortController()
    const answer = h.agentQuestion(question.signal)
    assert.deepEqual(h.programWrites, [IDLE, WORKING, PERMISSION, WORKING, QUESTION])
    question.abort()
    await answer.catch(() => {})
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING, PERMISSION, WORKING, QUESTION, WORKING])
  } finally {
    h.dispose()
  }
})

test('a Client-local question and a settled wait never project blocked', async () => {
  const h = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    h.routeStatus('main', 'running')
    await drain()
    // The /login authorization shape: the canonical phase becomes
    // waiting-question, but the Agent is NOT blocked on it.
    const local = new AbortController()
    const answer = h.app.askQuestions([{ id: 'auth', question: 'API key', masked: true }], local.signal)
    assert.equal(h.phase(), 'waiting-question')
    assert.deepEqual(h.programWrites, [IDLE, WORKING],
      'a Client-local modal must never claim the Agent is blocked')
    local.abort()
    await answer.catch(() => {})
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING])
  } finally {
    h.dispose()
  }
})

test('child, foreign-session and opening-journal events never feed the main turn evidence', async () => {
  const h = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    h.routeStatus('main', 'running')
    await drain()
    // A child session's turn pair: the owner fence rejects it.
    h.routeSession({ type: 'turn/start', data: { turn: 1 } }, 'child-session')
    h.routeSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, 'child-session')
    // A stale/foreign session's turn pair: rejected as well.
    h.routeSession({ type: 'turn/start', data: { turn: 1 } }, 'retired-session')
    h.routeSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, 'retired-session')
    // The opening journal fences PRE-COMMIT events of the main session.
    h.beginOpening()
    h.routeSession({ type: 'turn/start', data: { turn: 1 } })
    h.routeSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    h.endOpening()
    await drain()
    // No LIVE main turn pair was observed, so the interval has no evidence.
    h.routeStatus('main', 'idle')
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING, IDLE],
      'child / foreign / journal events must not create a done outcome')
  } finally {
    h.dispose()
  }
})

test('while a child viewer is mounted the MAIN turn evidence still updates', async () => {
  const h = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    h.viewChild('child-1')
    h.routeStatus('main', 'running')
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING])
    // The viewed child's own turn pair stays with the child presentation.
    h.routeSession({ type: 'turn/start', data: { turn: 1 } }, 'child-1')
    h.routeSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } }, 'child-1')
    await drain()
    // The MAIN session's turn pair must still be captured (the symmetry edge).
    h.routeSession({ type: 'turn/start', data: { turn: 1 } })
    h.routeSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drain()
    h.routeStatus('main', 'idle')
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING, DONE],
      'viewing a child must never starve the main interval evidence')
  } finally {
    h.dispose()
  }
})

test('a pre-mount running latch asserts 7501 working on the FIRST acquisition (no idle flash)', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  })
  try {
    await drain()
    assert.deepEqual(h.programWrites, [WORKING],
      'the first acquisition asserts the final state directly')
    assert.deepEqual(h.progress, [true])
  } finally {
    h.dispose()
  }
})

test('the REAL surface disposal retains a proven done and clears a live working record', async () => {
  const settled = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    await driveInterval(settled, 'completed')
    assert.deepEqual(settled.programWrites, [IDLE, WORKING, DONE])
    settled.dispose()
    assert.equal(settled.programWrites[settled.programWrites.length - 1], DONE,
      'surface.dispose() preserves the proven completion through the retire fold')
    assert.ok(!settled.programWrites.includes(CLEAR),
      'a retainable done record is never cleared on the way out')
  } finally {
    settled.dispose()
  }

  const working = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    working.routeStatus('main', 'running')
    await drain()
    assert.deepEqual(working.programWrites, [IDLE, WORKING])
    working.dispose()
    assert.equal(working.programWrites[working.programWrites.length - 1], CLEAR,
      'surface.dispose() retires a live working record')
  } finally {
    working.dispose()
  }
})

test('an owner rebind retires a retained done and the new owner must prove running', async () => {
  const h = mountSurface((controls) => controls.setOwner('A'))
  try {
    await drain()
    await driveInterval(h, 'completed', 'A')
    assert.deepEqual(h.programWrites, [IDLE, WORKING, DONE])
    h.setOwner('B')
    assert.deepEqual(h.programWrites, [IDLE, WORKING, DONE, IDLE],
      'the rebind retires the retained done BEFORE the new owner is authorized')
    h.routeStatus('A', 'idle')
    h.routeStatus('A', 'running')
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING, DONE, IDLE],
      'a late status from the retired owner can restore neither state')
    h.routeStatus('B', 'running')
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING, DONE, IDLE, WORKING],
      'the new owner proves running through its own authoritative status')
  } finally {
    h.dispose()
  }
})

// ── OSC 7501 mode matrix (plan §5) ──────────────────────────────────────────

test('mode switches retire dropped protocols and assert newly selected ones, 9;4 before 7501', async () => {
  const h = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    assert.deepEqual(h.programWrites, [IDLE], 'dual mode asserts idle at the mount')
    // dual -> 9;4: retire 7501, leave the unchanged 9;4 alone.
    h.setTerminalProgressMode('9;4')
    assert.deepEqual(h.programWrites, [IDLE, CLEAR])
    assert.deepEqual(h.progress, [false], 'an unchanged 9;4 selection is not re-flushed')
    // 9;4 -> 7501: the dropped 9;4 is force-cleared, then 7501 asserts.
    h.setTerminalProgressMode('7501')
    assert.deepEqual(h.programWrites, [IDLE, CLEAR, IDLE])
    assert.deepEqual(h.progress, [false, false], 'the forced dropped-protocol clear is always emitted')
    // 7501 -> off: clear 7501.
    h.setTerminalProgressMode('off')
    assert.deepEqual(h.programWrites, [IDLE, CLEAR, IDLE, CLEAR])
    // off -> dual: the newly enabled 9;4 asserts the current truth, then 7501.
    h.setTerminalProgressMode('9;4+7501')
    assert.deepEqual(h.programWrites, [IDLE, CLEAR, IDLE, CLEAR, IDLE])
    assert.deepEqual(h.progress, [false, false, false], 'each newly enabled protocol is asserted exactly once')
    // Same value is a no-op.
    h.setTerminalProgressMode('9;4+7501')
    assert.equal(h.programWrites.length, 5)
    assert.deepEqual(h.timeline, [
      '9;4:clear', '7501:idle',
      '7501:clear',
      '9;4:clear', '7501:idle',
      '7501:clear',
      '9;4:clear', '7501:idle',
    ], 'the merged timeline proves each mode transition retires dropped protocols (forced) and asserts newly selected ones, 9;4 before 7501')
  } finally {
    h.dispose()
  }
})

test('a mode switch while running preserves the current truth per protocol', async () => {
  const h = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    h.routeStatus('main', 'running')
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING])
    // dual -> 7501: the unchanged 7501 record is not re-flushed.
    h.setTerminalProgressMode('7501')
    assert.deepEqual(h.programWrites, [IDLE, WORKING])
    assert.deepEqual(h.progress, [false, true, false], '9;4 is retired with one clear')
    // 7501 -> dual: 9;4 asserts the CURRENT running truth, 7501 is unchanged.
    h.setTerminalProgressMode('9;4+7501')
    assert.deepEqual(h.programWrites, [IDLE, WORKING])
    assert.deepEqual(h.progress, [false, true, false, true])
    assert.deepEqual(h.timeline, [
      '9;4:clear', '7501:idle',
      '9;4:active', '7501:working',
      '9;4:clear',
      '9;4:active',
    ], 'the retired 9;4 protocol is cleared before the newly selected one is re-asserted, and the unchanged 7501 record is untouched')
  } finally {
    h.dispose()
  }
})

test('repeated identical statuses write nothing and display swaps never change the state', async () => {
  const h = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    await driveInterval(h, 'completed')
    assert.deepEqual(h.programWrites, [IDLE, WORKING, DONE])
    h.routeStatus('main', 'idle')
    h.routeStatus('main', 'idle')
    await drain()
    assert.equal(h.programWrites.length, 3, 'a repeated idle never re-settles')
    // A fullscreen round-trip retires and re-asserts the SAME semantic record.
    h.app.setFullscreen(true)
    h.app.setFullscreen(false)
    assert.equal(h.programWrites[h.programWrites.length - 1], DONE,
      'the display swap re-asserts the retained done record')
  } finally {
    h.dispose()
  }
})

test('OSC 7501 never gains a heartbeat while the 9;4 keepalive keeps running', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const previousTermProgram = process.env.TERM_PROGRAM
  process.env.TERM_PROGRAM = 'ghostty'
  const swallow = (run: () => void): void => {
    const previousWrite = process.stdout.write
    process.stdout.write = (() => true) as never
    try { run() } finally { process.stdout.write = previousWrite }
  }
  const h = (() => {
    try {
      return mountSurface((controls) => controls.setOwner('main'), { realProgress: true })
    } finally {
      if (previousTermProgram === undefined) delete process.env.TERM_PROGRAM
      else process.env.TERM_PROGRAM = previousTermProgram
    }
  })()
  try {
    await drain()
    h.routeStatus('main', 'running')
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING])
    swallow(() => t.mock.timers.tick(5000))
    await drain()
    assert.deepEqual(h.programWrites, [IDLE, WORKING],
      'the 9;4 keepalive must not re-send any OSC 7501 record')
  } finally {
    h.dispose()
  }
})

// ── OSC 7501 terminal lifetime (plan §4.4/§5) ───────────────────────────────

/** A started app whose injected terminal records both protocol outputs. */
function mountAppProgram(options: {
  tern?: boolean
  mode?: TerminalProgressMode
  initialActive?: boolean
} = {}): {
  vt: VirtualTerminal
  app: TuiApp
  states: TerminalProgressState[]
  progress: boolean[]
  program: string[]
  timeline: string[]
} {
  const vt = new VirtualTerminal(80, 24)
  const states: TerminalProgressState[] = []
  const progress: boolean[] = []
  const program: string[] = []
  const timeline: string[] = []
  vt.setProgressState = (state: TerminalProgressState) => { states.push(state); timeline.push(`9;4:${state}`) }
  vt.setProgress = (active: boolean) => { progress.push(active); timeline.push(active ? '9;4:active' : '9;4:clear') }
  const passthroughWrite = vt.write.bind(vt)
  vt.write = (data: string) => {
    for (const match of data.matchAll(/\x1b\]7501;[^\x1b]*\x1b\\/g)) {
      program.push(match[0])
      timeline.push(programTimelineLabel(match[0]))
    }
    passthroughWrite(data)
  }
  const passthroughStop = vt.stop.bind(vt)
  vt.stop = () => { timeline.push('terminal:stop'); passthroughStop() }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    ternTerminal: options.tern === true,
    ...(options.mode === undefined ? {} : { terminalProgressMode: options.mode }),
    ...(options.initialActive === undefined ? {} : { initialTerminalProgress: options.initialActive }),
  })
  app.start()
  startedApps.add(app)
  return { vt, app, states, progress, program, timeline }
}

test('a plain stop retires the 7501 record and the restart restores the latest desired state', () => {
  const { app, program, timeline } = mountAppProgram()
  try {
    assert.deepEqual(program, [IDLE])
    app.setTerminalProgress(true)
    assert.deepEqual(program, [IDLE, WORKING])
    app.stop()
    assert.deepEqual(program, [IDLE, WORKING, CLEAR], 'the stop retires the live record before the PTY is released')
    app.start()
    assert.deepEqual(program, [IDLE, WORKING, CLEAR, WORKING], 'the restart restores the latest desired state')
    assert.deepEqual(timeline, [
      '9;4:clear', '7501:idle',
      '9;4:active', '7501:working',
      '7501:clear', 'terminal:stop',
      '9;4:active', '7501:working',
    ], 'the 7501 retirement is emitted BEFORE the terminal stop hands the PTY away')
    assert.ok(timeline.indexOf('7501:clear') < timeline.indexOf('terminal:stop'),
      'the clear must precede terminal.stop(), never follow it')
  } finally {
    app.dispose()
  }
})

// ── Synchronous-sink reentrancy (plan §4.4 / STOP-10) ───────────────────────
//
// A terminal sink can synchronously re-enter the owner (a custom Terminal, or
// a plugin callback on the write path). The presentation must CONVERGE on the
// newest desired state: a retire/release is never lost, a stale projection
// never overwrites a newer one, and a lifecycle operation that stops the screen
// never leaves the ownership latch claiming a dead terminal. Each probe injects
// exactly one reentry and asserts the merged timeline.

interface ReentrantHooks {
  /** One 9;4 boolean write (non-Tern path). */
  onProgress?: (active: boolean, app: () => TuiApp) => void
  /** One 9;4 stateful write (Tern path). */
  onProgressState?: (state: TerminalProgressState, app: () => TuiApp) => void
  /** Any raw terminal write (OSC 7, OSC 7501, …). */
  onTerminalWrite?: (data: string, app: () => TuiApp) => void
}

/** A recording terminal whose sinks run the injected reentry hook. */
function mountReentrantApp(
  hooks: ReentrantHooks,
  options: { tern?: boolean; initialActive?: boolean; cwd?: string; mode?: TerminalProgressMode } = {},
): { app: TuiApp; program: string[]; states: TerminalProgressState[]; timeline: string[] } {
  const vt = new VirtualTerminal(80, 24)
  const program: string[] = []
  const states: TerminalProgressState[] = []
  const timeline: string[] = []
  let app: TuiApp | undefined
  const current = (): TuiApp => {
    if (app === undefined) throw new Error('the app is not constructed yet')
    return app
  }
  const passthroughWrite = vt.write.bind(vt)
  vt.write = (data: string) => {
    for (const match of data.matchAll(/\x1b\]7501;[^\x1b]*\x1b\\/g)) {
      program.push(match[0])
      timeline.push(programTimelineLabel(match[0]))
    }
    if (app !== undefined) hooks.onTerminalWrite?.(data, current)
    passthroughWrite(data)
  }
  const passthroughStop = vt.stop.bind(vt)
  vt.stop = () => { timeline.push('terminal:stop'); passthroughStop() }
  vt.setProgress = (active: boolean) => {
    timeline.push(active ? '9;4:active' : '9;4:clear')
    if (app !== undefined) hooks.onProgress?.(active, current)
  }
  vt.setProgressState = (state: TerminalProgressState) => {
    states.push(state)
    timeline.push(`9;4:${state}`)
    if (app !== undefined) hooks.onProgressState?.(state, current)
  }
  app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    ...(options.tern === undefined ? {} : { ternTerminal: options.tern }),
    ...(options.initialActive === undefined ? {} : { initialTerminalProgress: options.initialActive }),
    ...(options.mode === undefined ? {} : { terminalProgressMode: options.mode }),
  })
  if (options.cwd !== undefined) app.setTerminalCwd(options.cwd)
  app.start()
  startedApps.add(app)
  return { app, program, states, timeline }
}

test('a synchronous stop from the 9;4 sink never leaks a 7501 working record', () => {
  let reentered = 0
  const probe = mountReentrantApp({
    onProgress: (active, app) => {
      if (active && reentered === 0) {
        reentered += 1
        app().stop()
      }
    },
  })
  try {
    probe.app.setTerminalProgress(true)
    assert.equal(reentered, 1, 'the sink really re-entered once')
    assert.equal(probe.program[probe.program.length - 1], CLEAR,
      'the nested stop retired the record; the superseded acquisition must not restore working')
    assert.ok(!probe.program.includes(WORKING),
      `no working record may reach a terminal the app no longer owns: ${probe.timeline.join(', ')}`)
    assert.deepEqual(probe.timeline, ['9;4:clear', '7501:idle', '9;4:active', '7501:clear', 'terminal:stop'])
  } finally {
    probe.app.dispose()
  }
})

test('a synchronous stop from the ACQUISITION 9;4 sink never leaks a 7501 working record', () => {
  let reentered = 0
  const probe = mountReentrantApp({
    onProgress: (active, app) => {
      if (active && reentered === 0) {
        reentered += 1
        app().stop()
      }
    },
  }, { initialActive: true })
  try {
    assert.deepEqual(probe.timeline, ['9;4:active', 'terminal:stop'],
      'the first acquisition asserts 9;4, the reentry releases ownership, and convergence writes nothing more')
    assert.ok(!probe.program.includes(WORKING),
      'the superseded acquisition must not write a working record after the release')
  } finally {
    probe.app.dispose()
  }
})

test('a mode switch re-entered by its own 9;4 clear leaves the NEWER mode as the last state', () => {
  // The mount's own 9;4 cleanup clear is #1; the mode switch's clear is #2.
  let clears = 0
  let reentered = false
  const probe = mountReentrantApp({
    onProgress: (active, app) => {
      if (active) return
      clears += 1
      if (clears === 2) {
        reentered = true
        app().setTerminalProgressMode('9;4+7501')
      }
    },
  })
  try {
    probe.app.setTerminalProgress(true)
    assert.deepEqual(probe.program, [IDLE, WORKING])
    // dual -> off: its 9;4 clear callback synchronously re-selects dual.
    probe.app.setTerminalProgressMode('off')
    assert.equal(reentered, true, 'the clear really re-entered once')
    assert.deepEqual(probe.timeline, [
      '9;4:clear', '7501:idle',
      '9;4:active', '7501:working',
      '9;4:clear', '9;4:active', '7501:working',
    ], 'the nested off -> dual transition wins (asserting both newly enabled protocols); the superseded off transition emits no later 7501 clear')
    assert.equal(probe.program[probe.program.length - 1], WORKING,
      'the live mode is dual and the last physical record is its working state')
    assert.ok(!probe.program.includes(CLEAR), 'the superseded off transition never cleared the newer record')
  } finally {
    probe.app.dispose()
  }
})

test('a mode-enable assert interrupted by stop never writes into the released terminal', () => {
  // off + main running -> dual: the forced 9;4 assert synchronously hands the
  // PTY away. The remaining forced 7501 assert must abort, and a later
  // PAIR-CHANGING status must fold without writing.
  let stopped = false
  const probe = mountReentrantApp({
    onProgress: (active, app) => {
      if (!active || stopped) return
      stopped = true
      app().stop()
    },
  }, { mode: 'off' })
  try {
    probe.app.setTerminalProgress(true)
    probe.app.setTerminalProgressMode('9;4+7501')
    assert.equal(stopped, true, 'the forced 9;4 assert really re-entered with a stop')
    assert.deepEqual(probe.timeline, ['9;4:clear', '7501:clear', '9;4:active', 'terminal:stop'],
      'ownership was released during the 9;4 assert, so no 7501 working may follow')
    assert.ok(!probe.program.includes(WORKING), 'the released terminal must never receive a working record')
    const writesBefore = probe.program.length
    probe.app.setTerminalProgress(false, 'error')
    assert.equal(probe.program.length, writesBefore, 'a pair-changing status after the stop still writes nothing')
  } finally {
    probe.app.dispose()
  }
})

test('a mode-enable assert interrupted by dispose never writes into the disposed app', () => {
  let didDispose = false
  const probe = mountReentrantApp({
    onProgress: (active, app) => {
      if (!active || didDispose) return
      didDispose = true
      app().dispose()
    },
  }, { mode: 'off' })
  try {
    probe.app.setTerminalProgress(true)
    probe.app.setTerminalProgressMode('9;4+7501')
    assert.equal(didDispose, true, 'the forced 9;4 assert really re-entered with a dispose')
    assert.equal(probe.app.isDisposed(), true)
    assert.deepEqual(probe.timeline, ['9;4:clear', '7501:clear', '9;4:active', 'terminal:stop'],
      'the disposed app must not receive a further 7501 record')
    assert.ok(!probe.program.includes(WORKING), 'a disposed terminal must never receive a working record')
  } finally {
    probe.app.dispose()
  }
})

test('an acquisition force re-entered by an Agent approval never duplicates the blocked record', () => {
  // Acquisition force on a Tern terminal: the 9;4 assert synchronously opens a
  // real Agent approval. The nested projection already asserted blocked; the
  // stale acquisition force is void, so blocked is emitted EXACTLY once.
  let reentered = false
  const probe = mountReentrantApp({
    onProgressState: (state, app) => {
      if (state !== 'indeterminate' || reentered) return
      reentered = true
      void app().showApprovalPrompt({ toolName: 'bash', reason: 'probe' }, true)
    },
  }, { tern: true, initialActive: true })
  try {
    assert.equal(reentered, true, 'the acquisition force really re-entered once')
    assert.deepEqual(probe.timeline, ['9;4:indeterminate', '9;4:paused', '7501:blocked:permission'],
      'the nested approval asserts blocked once; the stale force must not repeat it')
    assert.equal(probe.program.filter(entry => entry === PERMISSION).length, 1)
  } finally {
    probe.app.dispose()
  }
})

test('a forced mode assert re-entered by a newer settled outcome never duplicates the completion', () => {
  // off running -> dual: the forced 9;4 assert synchronously folds a settled
  // `done`. The nested projection already wrote the completion; the stale
  // forced 7501 assert must fall back to the dedupe.
  let reentered = false
  const probe = mountReentrantApp({
    onProgress: (active, app) => {
      if (!active || reentered) return
      reentered = true
      app().setTerminalProgress(false, 'done')
    },
  }, { mode: 'off' })
  try {
    probe.app.setTerminalProgress(true)
    probe.app.setTerminalProgressMode('9;4+7501')
    assert.equal(reentered, true)
    assert.equal(probe.program.filter(entry => entry === DONE).length, 1,
      `the completion must be settled exactly once: ${probe.timeline.join(', ')}`)
    assert.deepEqual(probe.timeline, ['9;4:clear', '7501:clear', '9;4:active', '9;4:clear', '7501:done'])
  } finally {
    probe.app.dispose()
  }
})

test('a newly enabled assert disabled by a nested mode change emits no active record', () => {
  // off running -> dual: the forced 9;4 active sink synchronously switches back
  // to off. The outer's stale `enabled7501` must be re-scoped to the CURRENT
  // selection, so no 7501 ACTIVE record is emitted while the protocol is off;
  // convergence retires the residue instead.
  let reentered = false
  const probe = mountReentrantApp({
    onProgress: (active, app) => {
      if (!active || reentered) return
      reentered = true
      app().setTerminalProgressMode('off')
    },
  }, { mode: 'off' })
  try {
    probe.app.setTerminalProgress(true)
    probe.app.setTerminalProgressMode('9;4+7501')
    assert.equal(reentered, true, 'the forced off -> dual 9;4 assert really re-entered once')
    assert.deepEqual(probe.timeline, [
      '9;4:clear', '7501:clear',
      '9;4:active',
      '9;4:clear', '7501:clear',
    ], 'the nested off transition retires both; the stale outer emits no 7501 active record while off')
    assert.ok(!probe.program.includes(WORKING),
      `no working/blocked/done record may be emitted while 7501 is disabled: ${probe.timeline.join(', ')}`)
  } finally {
    probe.app.dispose()
  }
})

test('a newly enabled 9;4 assert disabled by a nested mode change never starts the indicator', () => {
  // 7501 running -> 9;4: the forced 7501 retirement synchronously switches back
  // to 7501. The outer's stale `enabled94` must be re-scoped, so the 9;4
  // indicator (and its keepalive) is never started while the mode is 7501-only.
  let reentered = false
  const probe = mountReentrantApp({
    onTerminalWrite: (data, app) => {
      if (reentered || !data.includes('7501;state=clear')) return
      reentered = true
      app().setTerminalProgressMode('7501')
    },
  }, { mode: '7501' })
  try {
    probe.app.setTerminalProgress(true)
    probe.app.setTerminalProgressMode('9;4')
    assert.equal(reentered, true, 'the forced 7501 retirement really re-entered once')
    assert.deepEqual(probe.timeline, [
      '9;4:clear', '7501:idle',
      '7501:working',
      '7501:clear',
      '9;4:clear', '7501:working',
    ], 'the nested 7501 transition retires 9;4; the stale outer never emits a 9;4 active record')
    assert.ok(!probe.timeline.includes('9;4:active'),
      `the 9;4 indicator must never start while the mode is 7501-only: ${probe.timeline.join(', ')}`)
  } finally {
    probe.app.dispose()
  }
})

test('an ABA mode change never lets the superseded assert write again', () => {
  // off running -> dual, whose forced 9;4 assert synchronously runs
  // dual -> 7501 -> dual and lands back on the OUTER's mode value. Mode
  // equality cannot identify the operation, so the outer's PENDING forced 7501
  // assert must be voided by the revision — otherwise a stale `working` is
  // emitted after the ABA already settled the state.
  let reentered = false
  const probe = mountReentrantApp({
    onProgress: (active, app) => {
      if (!active || reentered) return
      reentered = true
      app().setTerminalProgressMode('7501')
      app().setTerminalProgressMode('9;4+7501')
    },
  }, { mode: 'off' })
  try {
    probe.app.setTerminalProgress(true)
    probe.app.setTerminalProgressMode('9;4+7501')
    assert.equal(reentered, true, 'the forced off -> dual 9;4 assert really re-entered once')
    assert.equal(probe.program.filter(entry => entry === WORKING).length, 1,
      `the ABA settles working once; the superseded outer must add none: ${probe.timeline.join(', ')}`)
    assert.deepEqual(probe.timeline, [
      '9;4:clear', '7501:clear',
      '9;4:active',
      '9;4:clear', '7501:working',
      '9;4:active',
    ], 'the ABA returns to dual and settles it; the superseded outer transition is void')
  } finally {
    probe.app.dispose()
  }
})

test('an acquisition settled from its cwd write asserts the completion exactly once', () => {
  // The acquisition's force qualification must start BEFORE the OSC 7 cwd
  // write: a synchronous sink there can settle a status, and the acquisition
  // must not re-assert the record that newer operation already emitted.
  let reentered = false
  const probe = mountReentrantApp({
    onTerminalWrite: (data, app) => {
      if (reentered || !data.includes(']7;')) return
      reentered = true
      app().setTerminalProgress(false, 'done')
    },
  }, { tern: true, cwd: '/tmp', initialActive: true })
  try {
    assert.equal(reentered, true, 'the OSC 7 acquisition write really re-entered once')
    assert.equal(probe.timeline.filter(entry => entry === '7501:done').length, 1,
      `the cwd-settled completion must be emitted exactly once: ${probe.timeline.join(', ')}`)
    assert.deepEqual(probe.timeline, ['7501:done', '9;4:clear'],
      'the nested settlement wins; the acquisition only asserts the 9;4 state it still owes')
  } finally {
    probe.app.dispose()
  }
})

test('an inert projection during an acquisition never cancels the mandatory 7501 cleanup clear', () => {
  // A reacquisition whose forced 9;4 clear synchronously runs a physically
  // INERT projection (setWorking -> projectActivity -> converge(false) writes
  // nothing). The newer operation merely occurring must not consume the 7501
  // cleanup force: the acquisition still clears any record a previous owner
  // (`$EDITOR`, a crashed process) left behind.
  for (const mode of ['off', '9;4'] as const) {
    let armed = false
    let reentered = false
    const probe = mountReentrantApp({
      onProgressState: (state, app) => {
        if (!armed || state !== 'clear' || reentered) return
        reentered = true
        app().setWorking(true)
      },
    }, { tern: true, mode })
    try {
      probe.app.stop()
      armed = true
      probe.app.start()
      assert.equal(reentered, true, `mode ${mode}: the reacquisition really re-entered with an inert projection`)
      assert.equal(probe.timeline[probe.timeline.length - 1], '7501:clear',
        `mode ${mode}: the mandatory cleanup clear must still be emitted: ${probe.timeline.join(', ')}`)
      assert.equal(probe.timeline.filter(entry => entry === '7501:clear').length, 2,
        `mode ${mode}: one cleanup at the mount and one at the reacquisition`)
    } finally {
      probe.app.dispose()
    }
  }
})

test('a mode transition interrupted by a newer status still retires the dropped protocol', () => {
  // The 9;4 clear of `dual working -> off` synchronously folds a newer settled
  // status. The interrupted transition's PENDING 7501 retirement must still
  // land: convergence makes the newer operation clean up the residue it
  // inherits, so `off` can never leave a live record behind.
  let clears = 0
  let reentered = false
  const probe = mountReentrantApp({
    onProgress: (active, app) => {
      if (active) return
      clears += 1
      if (clears === 2) {
        reentered = true
        app().setTerminalProgress(false, 'done')
      }
    },
  })
  try {
    probe.app.setTerminalProgress(true)
    assert.deepEqual(probe.program, [IDLE, WORKING])
    probe.app.setTerminalProgressMode('off')
    assert.equal(reentered, true)
    assert.deepEqual(probe.timeline, [
      '9;4:clear', '7501:idle',
      '9;4:active', '7501:working',
      '9;4:clear', '7501:clear', '7501:clear',
    ], 'the newer status retires the residue AND the mandate still lands: two cleanup clears (no active record repeats)')
    assert.equal(probe.program[probe.program.length - 1], CLEAR,
      'mode off must end with NO live 7501 record')
    probe.app.dispose()
    assert.equal(probe.program[probe.program.length - 1], CLEAR,
      'the disposal cannot resurrect the residue either')
  } finally {
    probe.app.dispose()
  }
})

test('a phase-only approval re-entered from the 9;4 sink is never overwritten by the stale projection', () => {
  // A Tern 9;4 write synchronously opens a real Agent approval. The nested
  // projection moves the phase AND the Agent-wait fact; the outer projection
  // must fold the NEWEST inputs instead of restoring `working`.
  let reentered = false
  const probe = mountReentrantApp({
    onProgressState: (state, app) => {
      if (state !== 'indeterminate' || reentered) return
      reentered = true
      void app().showApprovalPrompt({ toolName: 'bash', reason: 'probe' }, true)
    },
  }, { tern: true })
  try {
    assert.deepEqual(probe.timeline, ['9;4:clear', '7501:idle'])
    probe.app.setTerminalProgress(true)
    assert.equal(reentered, true, 'the 9;4 sink really re-entered once')
    assert.deepEqual(probe.timeline, [
      '9;4:clear', '7501:idle',
      '9;4:indeterminate', '9;4:paused', '7501:blocked:permission',
    ], 'the nested wait projects paused + blocked; no stale working record may follow')
    assert.ok(!probe.program.includes(WORKING),
      'the superseded projection must not overwrite the blocked record')
  } finally {
    probe.app.dispose()
  }
})

test('a synchronous stop from the acquisition cwd write never starts the 9;4 indicator afterwards', () => {
  let stopped = false
  const probe = mountReentrantApp({
    onTerminalWrite: (data, app) => {
      if (stopped || !data.includes(']7;')) return
      stopped = true
      app().stop()
    },
  }, { tern: true, cwd: '/tmp' })
  try {
    assert.equal(stopped, true, 'the OSC 7 write really re-entered once')
    assert.deepEqual(probe.timeline, ['terminal:stop'],
      'the acquisition must not write 9;4 (or 7501) after the ownership was released')
    assert.ok(!probe.timeline.some(entry => entry.startsWith('9;4:')),
      'no 9;4 working state may start a keepalive on a released terminal')
  } finally {
    probe.app.dispose()
  }
})

test('a stop whose retirement write is re-entered by a newer start ends consistent', () => {
  let reentered = false
  const probe = mountReentrantApp({
    onTerminalWrite: (data, app) => {
      if (reentered || !data.includes('7501;state=clear')) return
      reentered = true
      app().start()
    },
  })
  try {
    probe.app.setTerminalProgress(true)
    assert.deepEqual(probe.program, [IDLE, WORKING])
    probe.app.stop()
    assert.equal(reentered, true, 'the retirement write really re-entered once')
    assert.deepEqual(probe.timeline, [
      '9;4:clear', '7501:idle',
      '9;4:active', '7501:working',
      '7501:clear', '9;4:active', '7501:working',
      'terminal:stop', '7501:clear',
    ], 'the outer stop wins: the screen is stopped AND ownership is released, leaving no live record')
    assert.equal(probe.program[probe.program.length - 1], CLEAR,
      'a screen-stopping lifecycle operation ends with the record retired')
    probe.app.setTerminalProgress(true)
    // A PAIR-CHANGING status: if the app still owned the presentation this
    // would emit a done/error record; a released ownership folds it silently.
    const writesBefore = probe.program.length
    probe.app.setTerminalProgress(false, 'error')
    assert.equal(probe.program.length, writesBefore,
      'the app no longer owns a presentation after the stop')
  } finally {
    probe.app.dispose()
  }
})

test('a 7501 -> 9;4 switch retires the dropped protocol BEFORE asserting the new one', () => {
  // Plan §5 mode matrix: `9;4 <-> 7501` is "clear the retired protocol FIRST,
  // then write the current state to the new protocol".
  const { app, timeline } = mountAppProgram({ mode: '7501' })
  try {
    assert.deepEqual(timeline, ['9;4:clear', '7501:idle'])
    app.setTerminalProgress(true)
    assert.deepEqual(timeline, ['9;4:clear', '7501:idle', '7501:working'])
    app.setTerminalProgressMode('9;4')
    assert.deepEqual(timeline, [
      '9;4:clear', '7501:idle',
      '7501:working',
      '7501:clear', '9;4:active',
    ], 'the dropped 7501 is retired before the newly enabled 9;4 asserts the current truth')
  } finally {
    app.dispose()
  }
})

test('an older transition force never duplicates the newer mode\'s assert', () => {
  // off -> dual: the forced 9;4 assert re-enters with a newer 7501 mode. The
  // superseded transition must NOT re-assert its stale force, and the newest
  // mode's assert must appear exactly once.
  let reentered = false
  const probe = mountReentrantApp({
    onProgress: (active, app) => {
      if (!active || reentered) return
      reentered = true
      app().setTerminalProgressMode('7501')
    },
  }, { mode: 'off' })
  try {
    assert.deepEqual(probe.timeline, ['9;4:clear', '7501:clear'], 'off mode retires both protocols at the mount')
    probe.app.setTerminalProgress(true)
    probe.app.setTerminalProgressMode('9;4+7501')
    assert.equal(reentered, true, 'the forced 9;4 assert really re-entered once')
    assert.deepEqual(probe.timeline, [
      '9;4:clear', '7501:clear',
      '9;4:active',
      '9;4:clear',
      '7501:working',
    ], 'the superseded dual transition stops at the newer 7501 mode; the newer mode asserts 7501 once')
    assert.equal(probe.program.filter(entry => entry === WORKING).length, 1,
      'the stale force must not produce a second identical assert')
  } finally {
    probe.app.dispose()
  }
})

test('an external-editor round-trip folds the truth and leaks no 7501 record into the editor', async () => {
  const vt = new VirtualTerminal(80, 24)
  const program: string[] = []
  const passthroughWrite = vt.write.bind(vt)
  vt.write = (data: string) => {
    for (const match of data.matchAll(/\x1b\]7501;[^\x1b]*\x1b\\/g)) program.push(match[0])
    passthroughWrite(data)
  }
  let release!: (text: string) => void
  const gate = new Promise<string>(resolve => { release = resolve })
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: () => gate,
    runOwned: () => {},
  })
  app.start()
  startedApps.add(app)
  try {
    app.setTerminalProgress(true)
    assert.deepEqual(program, [IDLE, WORKING])
    const pending = app.launchExternalEditor()
    assert.deepEqual(program, [IDLE, WORKING, CLEAR], 'the suspend retires the record before $EDITOR owns the PTY')
    // The Agent keeps reporting while $EDITOR is open: the record is folded,
    // never written into the editor's terminal.
    app.setTerminalProgress(false, 'done')
    app.setTerminalProgress(false, 'idle')
    assert.deepEqual(program, [IDLE, WORKING, CLEAR])
    release('edited')
    await pending
    assert.deepEqual(program, [IDLE, WORKING, CLEAR, IDLE],
      'the resume projects the latest desired record exactly once')
  } finally {
    app.dispose()
  }
})

test('a final dispose clears a live/paused/idle record but retains a proven done or error', () => {
  for (const [settled, expected] of [
    ['idle', CLEAR],
    ['working', CLEAR],
    ['done', DONE],
    ['error', ERROR],
  ] as const) {
    const { app, program } = mountAppProgram()
    try {
      if (settled === 'working') app.setTerminalProgress(true)
      else if (settled !== 'idle') app.setTerminalProgress(false, settled)
      app.dispose()
      assert.equal(program[program.length - 1], expected,
        `a final dispose after ${settled} must leave ${expected}`)
      if (settled === 'done' || settled === 'error') {
        assert.ok(!program.includes(CLEAR), 'a retainable completion record must not be cleared')
      }
    } finally {
      app.dispose()
    }
  }
})

test('each mode mounts, toggles and re-acquires with only its selected protocols', () => {
  // 9;4 only: the 7501 cleanup clear is emitted, but no active 7501 record.
  const compat = mountAppProgram({ mode: '9;4' })
  try {
    assert.deepEqual(compat.program, [CLEAR], 'the unselected 7501 protocol is retired at the mount')
    compat.app.setTerminalProgress(true)
    assert.deepEqual(compat.program, [CLEAR], '9;4-only never writes a 7501 record')
    assert.equal(compat.progress[compat.progress.length - 1], true)
  } finally {
    compat.app.dispose()
  }

  // 7501 only: the 9;4 cleanup clear is emitted, but no 9;4 state/keepalive.
  const semantic = mountAppProgram({ mode: '7501' })
  try {
    assert.deepEqual(semantic.program, [IDLE])
    assert.deepEqual(semantic.states, [], 'the unselected 9;4 protocol is never statefully projected')
    semantic.app.setTerminalProgress(true)
    assert.deepEqual(semantic.program, [IDLE, WORKING])
    assert.deepEqual(semantic.states, [], '7501-only keeps the 9;4 projection cleared')
  } finally {
    semantic.app.dispose()
  }

  // off: both protocols are cleaned up and nothing active is ever written.
  const off = mountAppProgram({ mode: 'off' })
  try {
    assert.deepEqual(off.program, [CLEAR])
    off.app.setTerminalProgress(true)
    off.app.stop()
    off.app.start()
    assert.deepEqual(off.program, [CLEAR, CLEAR], 'every acquisition retires both protocols')
  } finally {
    off.app.dispose()
  }
})

// ── Writer failure + production diagnostics wiring (plan §4.4 / §3.1) ───────

test('a synchronously throwing terminal sink is contained and recovery re-asserts the truth', () => {
  // A broken stdout must never crash the semantic agent lifecycle (plan §4.4):
  // BOTH protocol writers are contained, and the next acquisition re-asserts
  // the desired presentation unconditionally once the terminal recovers.
  const vt = new VirtualTerminal(80, 24)
  const program: string[] = []
  const timeline: string[] = []
  let failing = true
  const passthroughWrite = vt.write.bind(vt)
  vt.write = (data: string) => {
    if (data.includes('\x1b]7501;')) {
      if (failing) throw new Error('probe 7501 writer failure')
      for (const match of data.matchAll(/\x1b\]7501;[^\x1b]*\x1b\\/g)) {
        program.push(match[0])
        timeline.push(programTimelineLabel(match[0]))
      }
    }
    passthroughWrite(data)
  }
  vt.setProgress = (active: boolean) => {
    if (failing) throw new Error('probe 9;4 writer failure')
    timeline.push(active ? '9;4:active' : '9;4:clear')
  }
  vt.setProgressState = (state: TerminalProgressState) => {
    if (failing) throw new Error('probe 9;4 writer failure')
    timeline.push(`9;4:${state}`)
  }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  assert.doesNotThrow(() => app.start(), 'a throwing sink must never crash the surface')
  startedApps.add(app)
  try {
    assert.deepEqual<string[]>(program, [], 'the failing 7501 writer emitted no record')
    assert.deepEqual<string[]>(timeline, [], 'the failing 9;4 writer emitted no record')
    failing = false
    app.stop()
    app.start()
    assert.equal(program[program.length - 1], IDLE,
      'the recovered acquisition re-asserts the desired 7501 record')
    assert.ok(timeline.includes('9;4:clear'), 'the recovered 9;4 sink re-asserts the acquisition state')
    app.setTerminalProgress(true)
    assert.equal(program[program.length - 1], WORKING,
      'later status transitions keep working after recovery')
  } finally {
    app.dispose()
  }
})

test('the production composition injects the diagnostics channel into the surface', () => {
  // The unknown `turn/end.reason.kind` diagnostic (plan §3.1) must be reachable
  // in PRODUCTION, not only in a fixture: the composition root passes the
  // runner's diag into `createSurfaceRuntime`, and the surface records through
  // it instead of guessing an outcome.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const bootstrap = readFileSync(join(root, 'src', 'app', 'bootstrap.ts'), 'utf8')
  const creation = bootstrap.indexOf('createSurfaceRuntime<SessionEvent>({')
  assert.ok(creation >= 0, 'the composition must create the surface runtime')
  const call = bootstrap.slice(creation, bootstrap.indexOf('\n    })', creation))
  assert.ok(call.includes('\n      diag,\n'),
    'the production composition must inject the diagnostics channel into createSurfaceRuntime')
  const surface = readFileSync(join(root, 'src', 'app', 'surface', 'runtime.ts'), 'utf8')
  assert.ok(surface.includes("options.diag?.warn('terminal progress: unknown turn/end reason'"),
    'the surface must record an unknown turn/end reason through the injected channel')
})

// ── Production exit path (external review P1) ───────────────────────────────

/**
 * Drive the REAL composition teardown over a mounted surface:
 * `createSurfaceLifecycle(...).disposeSurface()` → the surface's final-teardown
 * retirement → `SurfaceRuntime.dispose()` → `TuiApp.dispose()` → the injected
 * terminal. The deps are the same narrow callbacks the composition root
 * injects; the teardown face is the REAL surface runtime.
 */
function disposeThroughProductionLifecycle(h: SurfaceHarness): () => void {
  let cleanedUp = false
  const lifecycle = createSurfaceLifecycle({
    diag: SILENT_DIAG as never,
    isCleanedUp: () => cleanedUp,
    markCleanedUp: () => { cleanedUp = true },
    surface: h.surfaceRuntime,
    abortLifecycle: () => {},
    disposeViewer: () => {},
    clearDraftImages: () => {},
    clearDraftFiles: () => {},
    disposeCommandCatalog: () => {},
    cancelDeferredStatus: () => {},
    disposeFooterCommand: () => {},
    disposeLocalShell: () => {},
    retireOwnedSession: async () => ({}) as never,
    disposeSelectedTransport: async () => {},
    registerDisposal: () => {},
  })
  return () => lifecycle.disposeSurface()
}

test('the production exit path retains a proven done/error and clears a live interval', async () => {
  // done: the retained completion must survive the whole production exit chain.
  const done = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    await driveInterval(done, 'completed')
    assert.deepEqual(done.programWrites, [IDLE, WORKING, DONE])
    const exit = disposeThroughProductionLifecycle(done)
    exit()
    assert.equal(done.programWrites[done.programWrites.length - 1], DONE,
      'disposeSurface() must retain the proven completion, not reset it to idle')
    assert.ok(!done.programWrites.includes(CLEAR),
      'the retained completion must not be erased by the final physical record')
    exit()
    assert.equal(done.programWrites.length, 3, 'a repeated disposeSurface() is idempotent and writes nothing')
  } finally {
    done.dispose()
  }

  // error: the same retention for the error outcome.
  const errored = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    await driveInterval(errored, 'error')
    disposeThroughProductionLifecycle(errored)()
    assert.equal(errored.programWrites[errored.programWrites.length - 1], ERROR,
      'a proven error must also survive the production exit path')
    assert.ok(!errored.programWrites.includes(CLEAR))
  } finally {
    errored.dispose()
  }

  // a live (still running) interval must NOT leave a working record behind.
  const working = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    working.routeStatus('main', 'running')
    await drain()
    assert.deepEqual(working.programWrites, [IDLE, WORKING])
    disposeThroughProductionLifecycle(working)()
    assert.equal(working.programWrites[working.programWrites.length - 1], CLEAR,
      'a live interval retires to idle and clears at disposal')
  } finally {
    working.dispose()
  }

  // session switch THEN exit: the rebind retires the old result; there is no
  // proven completion left for the exit to retain.
  const switched = mountSurface((controls) => controls.setOwner('main'))
  try {
    await drain()
    await driveInterval(switched, 'completed')
    assert.equal(switched.programWrites[switched.programWrites.length - 1], DONE)
    switched.setOwner('next-owner')
    assert.equal(switched.programWrites[switched.programWrites.length - 1], IDLE,
      'an owner rebind still retires the previous completion')
    disposeThroughProductionLifecycle(switched)()
    assert.equal(switched.programWrites[switched.programWrites.length - 1], CLEAR,
      'after a rebind the exit has no proven completion to retain')
  } finally {
    switched.dispose()
  }
})
