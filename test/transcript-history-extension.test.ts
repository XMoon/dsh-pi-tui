/**
 * M3-4 PR2: the transcript boundary GESTURE DISPATCH (the TuiApp input
 * layer): a real PageUp at the fullscreen loaded-floor edge invokes
 * `onTranscriptMoveOlder('page')` exactly once, and a `false` answer leaves
 * the viewport at the edge.
 *
 * The PRODUCTION surface body behind that callback — `transcriptMoveOlder`
 * falling through to `routing().extendLoadedHistory()` when the virtual
 * window is at its loaded floor — is source-locked below (the repo's
 * ownership-lock idiom); the Remote L6 suite exercises the same production
 * surface end-to-end and the official `loadOlder` engine over the real wire.
 * Together the three layers cover the chain; no single test here claims the
 * full dynamic path.
 *
 * @module @xmoon76/dsh-pi-tui/transcript-history-extension.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { afterEach } from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import { TranscriptWindowController } from '../src/domain/transcript/window.ts'
import { createSurfaceRuntime } from '../src/app/surface/runtime.ts'
import type { SurfaceEventRoutingSource } from '../src/app/surface/event-routing.ts'
import { createPluginManagerPanel } from '../src/tui/plugin-manager/panel.ts'
import { installVirtualProcessTerminal } from './support/runner-harness.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

/** The process TUI slot is global: every constructed TuiApp is disposed
 *  after each test (only dispose releases the slot, never stop()). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** A transcript entry list: ONE turn whose virtual window sits at its
 *  loaded floor (the oldest loaded turn is the first rendered turn). */
function singleTurnTranscript(lines: number): Array<{ kind: 'assistant'; turn: number; text: string }> {
  return [{
    kind: 'assistant' as const,
    turn: 0,
    text: Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join('\n'),
  }]
}

test('the fullscreen boundary gesture at the loaded floor invokes extendLoadedHistory and consumes the gesture', async () => {
  const vt = new VirtualTerminal(100, 30)
  const extensions: Array<'wheel' | 'page' | 'scrollbar'> = []
  let moveOlderResults: boolean[] = []
  // The surface wiring: moveOlder fails at the floor (the controller has no
  // older page), then the extension seam answers.
  const controllerHasOlderPage = (): boolean => false
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onTranscriptMoveOlder: source => {
      const moved = controllerHasOlderPage()
      moveOlderResults.push(moved)
      if (moved) return true
      // The surface's fall-through: the routing source's extension seam.
      extensions.push(source)
      return true
    },
  })
  app.start()
  startedApps.add(app)
  try {
    app.setTranscript(singleTurnTranscript(40))
    app.setFullscreen(true)
    await vt.waitForRender()
    app.scrollToTop({ disableFollow: true })
    await vt.waitForRender()
    vt.sendInput('\x1b[57421u') // PageUp at the top = the older boundary gesture
    await vt.waitForRender()
    assert.deepEqual(moveOlderResults, [false], 'the virtual window was already at its loaded floor')
    assert.deepEqual(extensions, ['page'], 'the extension seam received the boundary gesture')
  } finally {
    app.stop?.()
  }
})

test('the boundary gesture with NO extension available leaves the viewport at the edge (returns false)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onTranscriptMoveOlder: () => false, // no older page AND no extension
  })
  app.start()
  startedApps.add(app)
  try {
    app.setTranscript(singleTurnTranscript(40))
    app.setFullscreen(true)
    await vt.waitForRender()
    app.scrollToTop({ disableFollow: true })
    await vt.waitForRender()
    const historyBefore = app.fullscreenScrollForTest()
    assert.ok(historyBefore !== undefined)
    vt.sendInput('\x1b[57421u')
    await vt.waitForRender()
    const historyAfter = app.fullscreenScrollForTest()
    assert.ok(historyAfter !== undefined)
    assert.equal(historyAfter.scrollTop, historyBefore.scrollTop,
      'an unextended boundary leaves the viewport at the edge')
  } finally {
    app.stop?.()
  }
})

test('the production surface body falls through to extendLoadedHistory at the loaded floor (source lock)', async () => {
  const { readFileSync } = await import('node:fs')
  const surface = readFileSync(new URL('../src/app/surface/runtime.ts', import.meta.url), 'utf8')
  // The exact production chain (M3-4 PR2): a failed virtual-window page at
  // the floor asks the routing source's extension seam; a truthy answer
  // consumes the gesture.
  const fallThrough = surface.match(/const transcriptMoveOlder = \(\): boolean => \{[\s\S]*?\n  \}/)
  assert.ok(fallThrough !== null, 'the surface owns transcriptMoveOlder')
  assert.ok(fallThrough[0].includes('if (!controller.moveOlder()) {'),
    'a failed virtual-window page reaches the extension branch')
  assert.ok(fallThrough[0].includes('routing().extendLoadedHistory()'),
    'the extension branch invokes the routing source member (the Remote loadOlder dispatch)')
  assert.ok(fallThrough[0].includes('return routing().extendLoadedHistory()'),
    'the extension answer decides whether the boundary gesture is consumed')
})

test('the newer boundary gesture at the live tail reaches the surface once and leaves the viewport at the tail', async () => {
  const vt = new VirtualTerminal(100, 30)
  const newerAnswers: boolean[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // The surface wiring answered by a live-tail window: the local move is a
    // no-op, so the perf fast-path returns without capturing anything.
    onTranscriptMoveNewer: () => {
      newerAnswers.push(false)
      return false
    },
  })
  app.start()
  startedApps.add(app)
  try {
    app.setTranscript(singleTurnTranscript(40))
    app.setFullscreen(true)
    await vt.waitForRender()
    const before = app.fullscreenScrollForTest()
    assert.ok(before !== undefined)
    vt.sendInput('\x1b[57422u') // PageDown at the tail = the newer boundary gesture
    await vt.waitForRender()
    assert.deepEqual(newerAnswers, [false], 'the newer boundary gesture reached the surface exactly once')
    const after = app.fullscreenScrollForTest()
    assert.ok(after !== undefined)
    assert.equal(after.scrollTop, before.scrollTop, 'an unconsumed newer boundary leaves the viewport at the tail')
  } finally {
    app.stop?.()
  }
})

// --- Mounted production wiring: the boundary fast-path call trace -----------
//
// The frozen plan requires the REAL production `transcriptMoveOlder()` /
// `transcriptMoveNewer()` closures to run with their capture / repaint /
// restore / extension calls counted AND ordered. A string-order source lock has
// no discriminating power here (it still passes with a duplicated capture, a
// swapped restore edge or a repaint before the capture), so this harness mounts
// the real `createSurfaceRuntime` over a virtual ProcessTerminal, attaches a
// minimal routing source, and instruments the test-owned controller and the
// mounted app instance. Every assertion below therefore reads the production
// call order, not a text match.

const nullNotificationPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

/** `turns` turns of 40-line user messages: content far beyond the viewport, so a
 * page gesture can reach the local scroll boundary. */
function boundaryFolder(turns: number): TranscriptFolder {
  const folder = new TranscriptFolder()
  const events: unknown[] = []
  let seq = 0
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, time: turn * 10, data: { turn } })
    events.push({
      type: 'user/message', seq: seq++, time: turn * 10 + 1, data: {
        content: [{ type: 'text', text: Array.from({ length: 40 }, (_, index) => `turn ${turn} line ${index}`).join('\n') }],
        source: { kind: 'user' },
      },
    })
    events.push({ type: 'turn/end', seq: seq++, time: turn * 10 + 2, data: { turn, reason: { kind: 'completed' } } })
  }
  folder.hydrate(events as never[])
  return folder
}

function viewportHasLine(vt: VirtualTerminal, needle: string): boolean {
  return vt.getViewport().some(line => line.replace(/\u001b\[[0-9;]*m/g, '').includes(needle))
}

interface BoundaryHarness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly folder: TranscriptFolder
  readonly controller: TranscriptWindowController
  readonly trace: string[]
  readonly extension: { calls: number; answer: boolean }
  dispose(): void
}

/** The real surface runtime mounted over a virtual terminal, with the boundary
 * handlers instrumented for an ordered call trace. */
function mountBoundaryHarness(turns: number, options: {
  readonly windowTurns: number
  readonly stepTurns: number
  readonly extensionAnswer: boolean
}): BoundaryHarness {
  const vt = new VirtualTerminal(100, 30)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  const folder = boundaryFolder(turns)
  const controller = new TranscriptWindowController({
    windowTurns: options.windowTurns, stepTurns: options.stepTurns, turns: folder.turns(),
  })
  const trace: string[] = []
  const extension = { calls: 0, answer: options.extensionAnswer }
  const routingSource = {
    viewedChildId: () => undefined,
    main: () => ({ folder, window: controller, previews: [] }),
    mainFolder: () => folder,
    extendLoadedHistory: () => {
      extension.calls += 1
      trace.push('extendLoadedHistory')
      return extension.answer
    },
  } as unknown as SurfaceEventRoutingSource<never>

  const surface = createSurfaceRuntime({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullNotificationPresentation,
    notificationMode: undefined,
    notificationMethod: undefined,
    createPluginManagerPanel,
  })
  surface.attachEventRouting(routingSource)
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
    sessionId: () => 'session-boundary-test',
    onTerminalResize: () => {},
    copySelection: async () => false,
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
  })

  // Test-local instrumentation of the MOUNTED production handlers.
  const app = surface.app
  const captureOriginal = app.captureTranscriptViewportAnchor.bind(app)
  app.captureTranscriptViewportAnchor = () => {
    trace.push('capture')
    return captureOriginal()
  }
  const setTranscriptOriginal = app.setTranscript.bind(app)
  app.setTranscript = (...args: Parameters<TuiApp['setTranscript']>) => {
    trace.push('repaint')
    return setTranscriptOriginal(...args)
  }
  const restoreOriginal = app.restoreTranscriptViewportAnchor.bind(app)
  app.restoreTranscriptViewportAnchor = (...args: Parameters<TuiApp['restoreTranscriptViewportAnchor']>) => {
    trace.push(`restore:${args[1] ?? 'top'}`)
    return restoreOriginal(...args)
  }
  const scrollToBottomOriginal = app.scrollToBottom.bind(app)
  app.scrollToBottom = (...args: Parameters<TuiApp['scrollToBottom']>) => {
    trace.push('scrollToBottom')
    return scrollToBottomOriginal(...args)
  }
  const moveOlderOriginal = controller.moveOlder.bind(controller)
  controller.moveOlder = () => {
    trace.push('moveOlder')
    return moveOlderOriginal()
  }
  const moveNewerOriginal = controller.moveNewer.bind(controller)
  controller.moveNewer = () => {
    trace.push('moveNewer')
    return moveNewerOriginal()
  }

  return {
    vt, app, folder, controller, trace, extension,
    dispose: () => {
      surface.dispose()
      restoreTerminal()
    },
  }
}

/** The controller's CURRENT window, in the shape `repaintTarget()` publishes. */
function currentWindow(harness: BoundaryHarness): ReturnType<TranscriptFolder['window']> {
  const endTurn = harness.controller.endTurn()
  return harness.folder.window({
    maxTurns: harness.controller.windowTurns,
    ...(endTurn === undefined ? {} : { endTurn }),
  })
}

/** Seed the mounted surface with the controller's current window at one local
 * edge and clear the trace (the seed is test-local; production publishes the
 * same window through `repaintTarget`). */
async function seedWindow(harness: BoundaryHarness, at: 'top' | 'bottom'): Promise<void> {
  const projection = currentWindow(harness)
  harness.app.setFullscreen(true)
  harness.app.setTranscript(projection.messages, harness.folder.turnActivities(), {
    ...harness.controller.state(),
    firstTurn: projection.firstTurn,
    lastTurn: projection.lastTurn,
    hasNewer: projection.hasNewer,
  })
  await harness.vt.waitForRender()
  if (at === 'top') harness.app.scrollToTop({ disableFollow: true })
  else harness.app.scrollToBottom({ disableFollow: true })
  await harness.vt.waitForRender()
  harness.trace.length = 0
  harness.extension.calls = 0
}

test('the mounted newer fast-path performs ZERO capture/repaint on a local boundary no-op', async () => {
  const harness = mountBoundaryHarness(1, { windowTurns: 20, stepTurns: 10, extensionAnswer: false })
  try {
    await seedWindow(harness, 'bottom')
    const before = harness.app.fullscreenScrollForTest()
    assert.ok(before !== undefined)
    harness.vt.sendInput('\x1b[57422u') // PageDown at the tail = the newer boundary gesture
    await harness.vt.waitForRender()
    assert.deepEqual(harness.trace, ['moveNewer'],
      'a live-tail no-op must move, then return before any capture/repaint/restore')
    assert.equal(harness.app.fullscreenScrollForTest()?.scrollTop, before.scrollTop,
      'an unconsumed newer boundary leaves the viewport at the tail')
  } finally {
    harness.dispose()
  }
})

test('the mounted older fast-path performs ZERO capture/repaint and still reaches extendLoadedHistory() once', async () => {
  for (const answer of [false, true]) {
    const harness = mountBoundaryHarness(1, { windowTurns: 20, stepTurns: 10, extensionAnswer: answer })
    try {
      await seedWindow(harness, 'top')
      const before = harness.app.fullscreenScrollForTest()
      assert.ok(before !== undefined)
      harness.vt.sendInput('\x1b[57421u') // PageUp at the loaded floor = the older boundary gesture
      await harness.vt.waitForRender()
      assert.deepEqual(harness.trace, ['moveOlder', 'extendLoadedHistory'],
        `a local older no-op must reach the extension seam exactly once with no capture (answer=${answer})`)
      assert.equal(harness.extension.calls, 1, 'the Remote/official older-history seam is reached exactly once')
      assert.equal(harness.app.fullscreenScrollForTest()?.scrollTop, before.scrollTop,
        'neither extension answer repaints or moves the mounted viewport locally')
    } finally {
      harness.dispose()
    }
  }
})

test('a successful local older page move captures ONCE before the repaint and restores the top anchor', async () => {
  const harness = mountBoundaryHarness(25, { windowTurns: 20, stepTurns: 10, extensionAnswer: true })
  try {
    await seedWindow(harness, 'top')
    const topLine = harness.vt.getViewport()
      .map(line => line.replace(/\u001b\[[0-9;]*m/g, ''))
      .map(line => /turn \d+ line \d+/.exec(line)?.[0])
      .find(match => match !== undefined)
    assert.ok(topLine !== undefined, `the live window top edge must be visible:\n${harness.vt.getViewport().join('\n')}`)
    harness.vt.sendInput('\x1b[57421u')
    await harness.vt.waitForRender()
    assert.deepEqual(harness.trace, ['moveOlder', 'capture', 'repaint', 'restore:top'],
      'a real older movement captures the OLD projection exactly once, then repaints and restores the top edge')
    assert.equal(harness.extension.calls, 0, 'a successful LOCAL movement must not touch the Remote extension seam')
    assert.ok(viewportHasLine(harness.vt, topLine),
      `the observable overlap row (the old top edge) survives the page move: ${topLine}`)
  } finally {
    harness.dispose()
  }
})

test('a successful moveNewer that STAYS in history captures ONCE and restores the BOTTOM anchor', async () => {
  const harness = mountBoundaryHarness(30, { windowTurns: 10, stepTurns: 3, extensionAnswer: false })
  try {
    // Walk the REAL controller into a history window that is NOT at the newest
    // turn, so the production sink is the `restoreTranscriptViewportAnchor(...,
    // 'bottom')` branch — the latest fallback (`scrollToBottom`) is a DIFFERENT
    // branch, covered by the history@newest test below.
    assert.equal(harness.controller.moveOlder(), true)
    assert.equal(harness.controller.turnOlder(), true)
    assert.equal(harness.controller.isLatest(), false, 'the setup window is history, not the newest turn')
    await seedWindow(harness, 'bottom')
    const bottomLine = harness.vt.getViewport()
      .map(line => line.replace(/\u001b\[[0-9;]*m/g, ''))
      .map(line => /turn \d+ line \d+/.exec(line)?.[0])
      .filter(match => match !== undefined)
      .at(-1)
    assert.ok(bottomLine !== undefined, `the history window bottom edge must be visible:\n${harness.vt.getViewport().join('\n')}`)
    harness.vt.sendInput('\x1b[57422u') // PageDown at the history window bottom
    await harness.vt.waitForRender()
    assert.deepEqual(harness.trace, ['moveNewer', 'capture', 'repaint', 'restore:bottom'],
      'a newer movement that stays in history captures once (BEFORE the repaint) and restores the BOTTOM edge')
    assert.equal(harness.controller.isLatest(), false, 'the movement stayed inside history')
    assert.ok(viewportHasLine(harness.vt, bottomLine),
      `the observable overlap row (the old bottom edge) survives the move: ${bottomLine}`)
  } finally {
    harness.dispose()
  }
})

test('a successful moveNewer from history-at-newest captures ONCE before the repaint and jumps to the tail', async () => {
  const harness = mountBoundaryHarness(25, { windowTurns: 20, stepTurns: 10, extensionAnswer: false })
  try {
    // Walk the REAL controller to history@newest: the window then reaches the
    // newest turn while `snapshot().hasNewer === false` — the edge a caller must
    // never treat as a no-op.
    assert.equal(harness.controller.moveOlder(), true)
    while (harness.controller.snapshot().hasNewer) assert.equal(harness.controller.turnNewer(), true)
    assert.equal(harness.controller.isLatest(), false, 'still a history window')
    await seedWindow(harness, 'bottom')
    harness.vt.sendInput('\x1b[57422u') // PageDown at the history window bottom
    await harness.vt.waitForRender()
    assert.deepEqual(harness.trace, ['moveNewer', 'capture', 'repaint', 'scrollToBottom'],
      'history@newest -> latest is a real movement: capture once, repaint, then the latest fallback')
    assert.equal(harness.controller.isLatest(), true, 'the semantic mode switched to latest')
  } finally {
    harness.dispose()
  }
})
