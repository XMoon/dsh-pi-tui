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
import { ProcessTerminal, type TerminalProgressState } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'
import type { RunPhase } from '../src/domain/status/types.ts'
import { createSurfaceRuntime } from '../src/app/surface/runtime.ts'
import { createInteractionRuntime } from '../src/app/surface/interaction-runtime.ts'
import type { SurfaceEventRoutingSource } from '../src/app/surface/event-routing.ts'
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
    // OSC 9;4;3 behind, and an $EDITOR round-trip hands the PTY to another
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
}

interface SurfaceHarness extends SurfaceControls {
  readonly progress: boolean[]
  /** Every effective OSC 9;4 state (fork X059) the mounted Tern app wrote. */
  readonly progressStates: TerminalProgressState[]
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
  /**
   * Mount the surface as a Tern terminal (`TERM_PROGRAM=tern` around the app
   * construction). The environment is restored immediately afterwards: the
   * identity is read ONCE by the app, so the running scenario keeps its Tern
   * projection without leaking the env into another suite.
   */
  readonly tern?: boolean
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
  vt.setProgress = (active: boolean) => { progress.push(active) }
  vt.setProgressState = (state: TerminalProgressState) => { progressStates.push(state) }
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
  const routingSource = {
    isCleanedUp: () => false,
    completionOwnerId: () => owner,
    pendingSubjectId: () => undefined,
    pendingSnapshot: () => undefined,
    submissionEchoes: () => undefined,
    queueTextOf: () => '',
  } as unknown as SurfaceEventRoutingSource<never>

  const surface = createSurfaceRuntime({
    tuiVersion: '0.0.0-test',
    notificationPresentation: options.presentation ?? nullPresentation,
    notificationMode: options.notificationMode,
    notificationMethod: options.notificationMethod,
    createPluginManagerPanel,
  })
  surface.attachEventRouting(routingSource)
  const controls: SurfaceControls = {
    setOwner: (identity) => {
      owner = identity
      surface.setCompletionOwner(identity)
    },
    routeStatus: (agentId, status) => surface.routeAgentStatus(agentId, status),
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
  const activeWrites = (): number => writes.filter(write => write === '\x1b]9;4;3\x07').length
  const clearWrites = (): number => writes.filter(write => write === '\x1b]9;4;0\x07').length
  // The MOUNT is itself a capture window: the very first real byte is the
  // claim clear (see below) and must not leak into the report.
  const h = captured(() => mountSurface((controls) => controls.setOwner('main'), { realProgress: true }))
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

    // `src/authorization.ts` / the `/login` command ask through the SAME
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
