/**
 * Transcript-search presentation PERFORMANCE structure (perf plan S1 §4.1 /
 * plan §10.1): the app-level half of the structural gates — one rebuild per
 * presentation commit, no remeasure / full render on an ordinary jump, and a
 * content-geometry cache that agrees with the rendered view.
 * @module @xmoon76/dsh-pi-tui/transcript-search-performance.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createSearchProfiler, searchProfilingEnabled } from '../src/search-profile.ts'
import { TuiApp } from '../src/tui-app.ts'
import type { TranscriptMessage } from '../src/transcript.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(width = 100, height = 30): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(width, height)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

function userMessage(turn: number, text: string): TranscriptMessage {
  return { kind: 'user', turn, text }
}

function target(message: TranscriptMessage) {
  return {
    query: 'needle',
    match: { id: 0, turn: 'turn' in message ? message.turn : 0, occurrence: 0, source: { kind: 'message' as const }, sourceOccurrence: 0 },
    message,
  }
}

test('perf: an atomic presentation commit rebuilds at most once and is a no-op when unchanged', async () => {
  const { vt, app } = startApp()
  const a = userMessage(0, 'needle one')
  const b = userMessage(1, 'needle two')
  app.setFullscreen(true)
  app.setTranscript([a, b])
  await vt.waitForRender()

  // The old two-setter path rebuilt once for the representative set and once
  // for the target. The atomic commit must reach the tree in ONE rebuild.
  const representatives = new Set([a, b])
  app.resetSearchPresentationDiagnosticsForTest()
  app.setTranscriptSearchPresentation({ matchMessages: representatives, target: target(a), grantReveal: true })
  assert.equal(app.searchPresentationDiagnosticsForTest().rebuilds, 1, 'representative set + target commit once')

  // Re-committing the SAME semantic presentation (fresh target object, stable
  // set + card identity) must not touch the tree at all — a passive projection
  // rebind relies on this to preserve the Focus live-height floors.
  app.resetSearchPresentationDiagnosticsForTest()
  app.setTranscriptSearchPresentation({ matchMessages: representatives, target: target(a), grantReveal: false })
  assert.equal(app.searchPresentationDiagnosticsForTest().rebuilds, 0, 'an unchanged semantic commit is a no-op')
  app.stop()
})

test('perf: setTranscript applies a search presentation inside its single rebuild', async () => {
  const { vt, app } = startApp()
  const a = userMessage(0, 'needle one')
  const b = userMessage(1, 'needle two')
  app.setFullscreen(true)
  app.setTranscript([a, b])
  await vt.waitForRender()

  app.resetSearchPresentationDiagnosticsForTest()
  app.setTranscript([a, b], undefined, undefined, undefined, {
    matchMessages: new Set([a, b]),
    target: target(b),
    grantReveal: true,
  })
  const diagnostics = app.searchPresentationDiagnosticsForTest()
  assert.equal(diagnostics.transcriptSets, 1)
  assert.equal(diagnostics.rebuilds, 1, 'the projection epoch commits as ONE rebuild')
  app.stop()
})

test('perf: rebinding the same card object is a no-op; a replaced card rebinds once', async () => {
  const { vt, app } = startApp()
  const a = userMessage(0, 'needle one')
  const b = userMessage(1, 'needle two')
  app.setFullscreen(true)
  app.setTranscript([a, b])
  app.setTranscriptSearchTarget(target(a))
  await vt.waitForRender()

  app.resetSearchPresentationDiagnosticsForTest()
  app.rebindTranscriptSearchTarget(a)
  assert.equal(app.searchPresentationDiagnosticsForTest().rebuilds, 0, 'same object identity is not a rebind')

  app.rebindTranscriptSearchTarget(b)
  assert.equal(app.searchPresentationDiagnosticsForTest().rebuilds, 1, 'a replaced card rebinds once')
  app.stop()
})

test('perf: an ordinary search jump neither remeasures nor re-renders the whole view', async () => {
  const { vt, app } = startApp()
  const messages = Array.from({ length: 6 }, (_, index) => userMessage(index, `turn ${index} needle ${'x'.repeat(40)}`))
  app.setFullscreen(true)
  app.setTranscript(messages)
  await vt.waitForRender()

  app.resetSearchPresentationDiagnosticsForTest()
  app.setTranscriptSearchPresentation({ matchMessages: new Set(messages), target: target(messages[3]!), grantReveal: true })
  app.scrollToSearchTarget()
  const diagnostics = app.searchPresentationDiagnosticsForTest()
  assert.equal(diagnostics.remeasures, 0, 'the rebuild already measured the rows')
  assert.equal(diagnostics.fullRenders, 0, 'the cached content height replaces the whole-view render')
  app.stop()
})

test('perf: the cached content geometry matches the rendered mounted view', async () => {
  const { vt, app } = startApp()
  const messages = [
    userMessage(0, 'needle one'),
    { kind: 'assistant' as const, turn: 0, text: `answer ${'y'.repeat(120)}` },
    userMessage(1, 'needle two'),
  ]
  app.setFullscreen(true)
  app.setTranscript(messages)
  await vt.waitForRender()

  app.setTranscriptSearchPresentation({ matchMessages: new Set(messages), target: target(messages[2]!), grantReveal: true })
  app.scrollToSearchTarget()
  const scroll = app.fullscreenScrollForTest()
  assert.ok(scroll !== undefined, 'fullscreen scroll view must exist')
  assert.equal(app.transcriptContentHeightForTest(), scroll.contentHeight,
    'the cached height must equal messagesView.render(width).length')
  app.stop()
})

test('perf: the search profiler is a no-op unless enabled and emits the plan stage set once per operation', () => {
  assert.equal(searchProfilingEnabled({ DSH_TUI_SEARCH_PROFILE: '1' }), true)
  assert.equal(searchProfilingEnabled({}), false)

  const disabledLines: string[] = []
  const disabled = createSearchProfiler(false, () => 0, line => disabledLines.push(line))
  disabled.start()
  disabled.stage('search.rebuild')
  disabled.end()
  assert.deepEqual(disabledLines, [], 'a disabled profiler writes nothing')

  const lines: string[] = []
  let clock = 0
  const enabled = createSearchProfiler(true, () => (clock += 5), line => lines.push(line))
  enabled.start()
  enabled.stage('search.semantic')
  enabled.stage('search.resolve-representatives')
  enabled.stage('search.window')
  enabled.stage('search.presentation-commit')
  enabled.stage('search.rebuild')
  enabled.stage('search.scroll')
  enabled.end()
  assert.equal(lines.length, 1, 'ONE line per operation')
  for (const stage of ['search.semantic=', 'search.resolve-representatives=', 'search.window=', 'search.presentation-commit=', 'search.rebuild=', 'search.scroll=', 'search.total=']) {
    assert.ok(lines[0]!.includes(stage), `stage ${stage} missing from ${lines[0]!}`)
  }
  // A stage outside an operation window is dropped, and a second end() is a
  // no-op — a stray pass can never append to a stale line.
  lines.length = 0
  enabled.stage('search.stray')
  enabled.end()
  assert.deepEqual(lines, [], 'stages/end outside a window are dropped')
})
