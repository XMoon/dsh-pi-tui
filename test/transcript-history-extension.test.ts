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
