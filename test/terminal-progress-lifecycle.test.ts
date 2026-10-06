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
import { ProcessTerminal } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'
import { createSurfaceRuntime } from '../src/app/surface/runtime.ts'
import type { SurfaceEventRoutingSource } from '../src/app/surface/event-routing.ts'
import type { TerminalNotificationPresentation } from '../src/app/surface/notification-runtime.ts'
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

/** Drain the routing's `queueMicrotask` pending-input refreshes. */
async function drain(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

// ── TuiApp layer: dedupe + every TuiApp-owned screen restart ───────────────

/** A started app whose injected VirtualTerminal records every setProgress. */
function mountApp(): { vt: VirtualTerminal; app: TuiApp; progress: boolean[] } {
  const vt = new VirtualTerminal(80, 24)
  const progress: boolean[] = []
  vt.setProgress = (active: boolean) => { progress.push(active) }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app, progress }
}

test('setTerminalProgress dedupes equal writes (no per-status churn)', () => {
  const { app, progress } = mountApp()
  try {
    app.setTerminalProgress(true)
    app.setTerminalProgress(true)
    app.setTerminalProgress(true)
    app.setTerminalProgress(false)
    app.setTerminalProgress(false)
    assert.deepEqual(progress, [true, false],
      'three runnings write ONE active hint; a repeated idle writes ONE clear')
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
    assert.deepEqual(progress, [true, true, true],
      'each screen restart re-asserts the desired busy state (the stop cleared it)')
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
    assert.deepEqual(progress, [true, true])
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
    assert.deepEqual(progress, [true, true], 'the resume re-asserts the desired busy state')
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
  vt.setProgress = (active: boolean) => { progress.push(active) }
  const real = options.realProgress === true ? new ProcessTerminal() : undefined
  if (real !== undefined) {
    // Capture the REAL implementations BEFORE installVirtualProcessTerminal
    // replaces them on the prototype: the patched methods delegate back into
    // these virtual overrides, so calling them here would recurse.
    const realSetProgress = ProcessTerminal.prototype.setProgress
    const realStop = ProcessTerminal.prototype.stop
    // The app's patched ProcessTerminal delegates to this virtual terminal;
    // only the two progress methods reach the REAL implementation, so the real
    // OSC 9;4 write and the real keepalive interval run (§12.8 authority).
    vt.setProgress = (active: boolean) => {
      progress.push(active)
      realSetProgress.call(real, active)
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

  let disposed = false
  return {
    progress,
    ...controls,
    dispose: () => {
      if (disposed) return
      disposed = true
      surface.dispose()
      restoreTerminal()
    },
  }
}

test('a pre-mount main running status is latched and projected exactly once at mount', async () => {
  const h = mountSurface((controls) => {
    controls.setOwner('main')
    controls.routeStatus('main', 'running')
  })
  try {
    await drain()
    assert.deepEqual(h.progress, [true], 'the pre-mount running state projects exactly once at mount')
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
    assert.deepEqual(h.progress, [], 'only the current main Agent projects progress')
    h.routeStatus('main', 'running')
    await drain()
    assert.deepEqual(h.progress, [true], 'the main Agent still projects after the child/stale noise')
  } finally {
    h.dispose()
  }
})

test('a completion-owner commit clears the retiree progress and the new owner must prove running', async () => {
  const h = mountSurface((controls) => controls.setOwner('A'))
  try {
    h.routeStatus('A', 'running')
    await drain()
    assert.deepEqual(h.progress, [true], 'owner A running projects busy')
    h.setOwner('B')
    assert.deepEqual(h.progress, [true, false], 'the owner commit clears the retiree busy state immediately')
    h.routeStatus('A', 'idle')
    h.routeStatus('A', 'running')
    h.routeStatus('B', 'idle')
    await drain()
    assert.deepEqual(h.progress, [true, false], 'late A statuses and a first-idle B are inert')
    h.routeStatus('B', 'running')
    await drain()
    assert.deepEqual(h.progress, [true, false, true], 'B becomes busy only after its own running event')
  } finally {
    h.dispose()
  }
})

test('surface disposal retires the pane progress before the mounted app dies', async () => {
  const h = mountSurface((controls) => controls.setOwner('main'))
  try {
    h.routeStatus('main', 'running')
    await drain()
    assert.deepEqual(h.progress, [true])
    h.dispose()
    assert.deepEqual(h.progress, [true, false], 'disposal clears the busy hint explicitly')
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
  const capture = (run: () => void): void => {
    const previousWrite = process.stdout.write
    process.stdout.write = ((chunk: unknown) => { writes.push(String(chunk)); return true }) as never
    try {
      run()
    } finally {
      process.stdout.write = previousWrite
    }
  }
  const activeWrites = (): number => writes.filter(write => write === '\x1b]9;4;3\x07').length
  const clearWrites = (): number => writes.filter(write => write === '\x1b]9;4;0\x07').length
  const h = mountSurface((controls) => controls.setOwner('main'), { realProgress: true })
  try {
    capture(() => h.routeStatus('main', 'running'))
    await drain()
    assert.equal(activeWrites(), 1, 'a running status writes ONE real OSC 9;4 active sequence')
    assert.equal(clearWrites(), 0)
    capture(() => t.mock.timers.tick(1000))
    assert.equal(activeWrites(), 2, 'the terminal keepalive re-asserts the active indicator')
    capture(() => h.dispose())
    assert.equal(clearWrites(), 1, 'disposal clears the real indicator')
    const activeAfterDispose = activeWrites()
    capture(() => t.mock.timers.tick(5000))
    assert.equal(activeWrites(), activeAfterDispose, 'no keepalive survives disposal')
    assert.equal(clearWrites(), 1, 'no later progress write survives disposal')
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
    assert.deepEqual(h.progress, [true], 'the running state projects progress regardless of notification mode')
    h.routeStatus('main', 'idle')
    await drain()
    assert.deepEqual(h.progress, [true, false], 'the idle state clears progress regardless of notification mode')
    assert.deepEqual(notifications, [], 'mode off still suppresses the completion toast')
  } finally {
    h.dispose()
  }
})
