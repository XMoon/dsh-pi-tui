/**
 * Transcript-search presentation PERFORMANCE structure (perf plan S1 §4.1 /
 * plan §10.1): the app-level half of the structural gates — one rebuild per
 * presentation commit, no remeasure / full render on an ordinary jump, and a
 * content-geometry cache that agrees with the rendered view.
 * @module @xmoon76/dsh-pi-tui/transcript-search-performance.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { createSearchProfiler, searchProfilingEnabled } from '../../src/app/surface/search-profile.ts'
import { TuiApp } from '../../src/tui-app.ts'
import type { TranscriptMessage } from '../../src/transcript.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

function startApp(width = 100, height = 30): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(width, height)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

function userMessage(turn: number, text: string): Extract<TranscriptMessage, { kind: 'user' }> {
  return { kind: 'user', turn, text }
}

function target(
  message: TranscriptMessage,
  query = 'needle',
  sourceOccurrence = 0,
  normalizedSourceRange?: { readonly start: number; readonly end: number },
) {
  return {
    query,
    match: {
      id: 0,
      turn: 'turn' in message ? message.turn : 0,
      occurrence: 0,
      source: { kind: 'message' as const },
      sourceOccurrence,
      ...(normalizedSourceRange === undefined ? {} : { normalizedSourceRange }),
    },
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

test('perf: same-query navigation reuses each live card’s indexed rendered results', async () => {
  const { vt, app } = startApp()
  const messages = Array.from({ length: 20 }, (_, turn) => userMessage(turn, `turn ${turn} needle content`))
  app.setFullscreen(true)
  app.setTranscript(messages)
  await vt.waitForRender()

  const representatives = new Set(messages)
  app.setTranscriptSearchPresentation({ matchMessages: representatives, target: target(messages[0]!), grantReveal: true })
  app.resetSearchPresentationDiagnosticsForTest()
  app.setTranscriptSearchPresentation({ matchMessages: representatives, target: target(messages[1]!), grantReveal: true })

  const diagnostics = app.searchPresentationDiagnosticsForTest()
  assert.equal(diagnostics.rebuilds, 1, 'same-query navigation still rebuilds at most once')
  assert.ok(diagnostics.renderedMatchLookups > 0, 'the normal host path performs indexed lookups')
  assert.equal(diagnostics.renderedMatchResultCacheHits, diagnostics.renderedMatchLookups,
    'unchanged cards reuse their complete rendered match arrays')

  const cache = (app as unknown as {
    messageComponents: Map<TranscriptMessage, { renderedSearchIndex?: object }>
  }).messageComponents
  const indexes = messages.map(message => cache.get(message)?.renderedSearchIndex)
  assert.ok(indexes.every(index => index !== undefined), 'search indexes are lazy-created for participating cards')
  assert.equal(new Set(indexes).size, messages.length, 'each live message entry owns its own index')
  app.stop()
})

test('perf: indexed search reuses the entry across query changes and invalidates changed lines', async () => {
  const { vt, app } = startApp()
  const message = userMessage(0, 'needle before')
  app.setFullscreen(true)
  app.setTranscript([message])
  await vt.waitForRender()
  const presentation = (app as unknown as {
    mountedTranscriptBlocks: ReadonlyArray<{
      block: { kind: string; message?: TranscriptMessage }
      searchSelection?: {
        matches: readonly unknown[]
        selectedIndex: number
        exact: boolean
        exactPaintedSegments?: ReadonlyArray<{ row: number; startCol: number; endCol: number }>
      }
    }>
  })
  const currentSelection = () => presentation.mountedTranscriptBlocks.find(entry => entry.block.message === message)?.searchSelection

  app.setTranscriptSearchTarget(target(message, 'needle', 0, { start: 0, end: 6 }))
  assert.equal(currentSelection()?.matches.length, 1, 'the initial query has one rendered match')
  assert.equal(currentSelection()?.exact, true, 'the current source cell is proven')
  const initialStartCol = currentSelection()?.exactPaintedSegments?.[0]?.startCol
  assert.ok(initialStartCol !== undefined, 'the initial proof publishes painted cells')
  const cache = (app as unknown as {
    messageComponents: Map<TranscriptMessage, { renderedSearchIndex?: { search: (lines: readonly string[], query: string) => { matches: readonly unknown[] } } }>
  }).messageComponents
  const index = cache.get(message)?.renderedSearchIndex
  assert.ok(index !== undefined, 'the initial presentation creates the entry index')

  message.text = 'omega after'
  app.resetSearchPresentationDiagnosticsForTest()
  app.setTranscript([message])
  assert.equal(currentSelection()?.matches.length, 0, 'changed rendered lines do not reuse the old query match')
  assert.equal(app.searchPresentationDiagnosticsForTest().renderedMatchResultCacheHits, 0,
    'line invalidation cannot report a complete result-cache hit')
  assert.strictEqual(cache.get(message)?.renderedSearchIndex, index, 'the same entry keeps the same index object')

  // Same stable match identity, moved source text: the proof re-locates the
  // painted cell instead of reusing the old column.
  message.text = 'prefix needle after'
  app.setTranscript([message])
  app.setTranscriptSearchTarget(target(message, 'needle', 0, { start: 7, end: 13 }))
  const moved = currentSelection()
  assert.equal(moved?.matches.length, 1, 'the new query matches the changed rendered lines')
  assert.equal(moved?.selectedIndex, -1, 'the plain-text channel never uses a rendered ordinal')
  assert.equal(moved?.exact, true, 'the moved source occurrence is re-proven')
  assert.equal(moved?.exactPaintedSegments?.[0]?.startCol, initialStartCol! + 7,
    'a real text prefix shift moves the proven cell by exactly the inserted prefix width')
  app.stop()
})

test('perf: the plain-text proof runs once for the current target, never per frame or per history card', async () => {
  const { vt, app } = startApp()
  const longText = `${'filler '.repeat(1400)}needle ${'tail '.repeat(1000)}`
  const current = userMessage(0, longText)
  const history = Array.from({ length: 8 }, (_, index) => userMessage(index + 1, `needle history ${index} ${'x'.repeat(40)}`))
  app.setFullscreen(true)
  app.setTranscript([current, ...history])
  await vt.waitForRender()

  app.resetSearchPresentationDiagnosticsForTest()
  app.setTranscriptSearchTarget(target(current, 'needle', 0, { start: 9800, end: 9806 }))
  const diagnostics = app.searchPresentationDiagnosticsForTest()
  assert.equal(diagnostics.plainTextProofs, 1,
    'exactly ONE disposable source-cell proof for the current target — never one per history card')
  assert.ok(diagnostics.plainTextProofs < history.length + 1)

  await vt.waitForRender()
  app.resetSearchPresentationDiagnosticsForTest()
  await vt.waitForRender()
  await vt.waitForRender()
  assert.equal(app.searchPresentationDiagnosticsForTest().plainTextProofs, 0,
    'settled repaints never repeat the probe')

  app.resetSearchPresentationDiagnosticsForTest()
  app.setTranscriptSearchTarget(target(history[0]!, 'needle', 0, { start: 0, end: 6 }))
  assert.equal(app.searchPresentationDiagnosticsForTest().plainTextProofs, 1,
    'switching the current target proves only the new current card once')
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

test('perf: rendered View navigation and passive scroll do not rescan or rebuild the mounted window', async () => {
  const { vt, app } = startApp(80, 12)
  const messages = Array.from({ length: 24 }, (_, turn) => userMessage(turn, `turn ${turn} needle content`))
  app.setFullscreen(true)
  app.setTranscript(messages)
  await vt.waitForRender()
  const initial = app.setRenderedViewSearchQuery('needle')
  assert.equal(initial.count, messages.length)
  assert.ok(initial.currentIndex >= 0, 'a non-empty View query selects one mounted occurrence')
  await vt.waitForRender()

  app.resetSearchPresentationDiagnosticsForTest()
  const expectedNext = (initial.currentIndex + 1) % messages.length
  assert.deepEqual(app.stepRenderedViewSearch(1), { currentIndex: expectedNext, count: messages.length })
  let diagnostics = app.searchPresentationDiagnosticsForTest()
  assert.equal(diagnostics.renderedMatchLookups, 0, 'Next uses the existing occurrence list')
  assert.equal(diagnostics.rebuilds, 0, 'Next updates only the old/new mounted wrappers')
  assert.equal(diagnostics.remeasures, 0, 'clean geometry does not remeasure on Next')
  assert.equal(diagnostics.fullRenders, 0, 'Next does not render the whole transcript')
  assert.equal(diagnostics.transcriptSets, 0, 'Next never reprojects the transcript')

  const before = app.fullscreenScrollForTest()!
  assert.ok(before.maxScrollTop > 0, 'the transcript overflows the viewport')
  app.resetSearchPresentationDiagnosticsForTest()
  vt.sendInput(before.scrollTop > 0 ? '\u001b[<64;5;8M' : '\u001b[<65;5;8M')
  await vt.waitForRender()
  const after = app.fullscreenScrollForTest()!
  assert.notEqual(after.scrollTop, before.scrollTop, 'the real wheel event moves the viewport')
  diagnostics = app.searchPresentationDiagnosticsForTest()
  assert.equal(diagnostics.renderedMatchLookups, 0, 'passive scrolling performs no rendered-index lookup')
  assert.equal(diagnostics.rebuilds, 0, 'passive scrolling does not rebuild the mounted window')
  assert.equal(diagnostics.remeasures, 0, 'the geometry-epoch snapshot is reused while scrolling')
  app.dispose()
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

// ── F2: the Assistant Markdown proof stays out of frames and history cards ───

function assistantMessage(turn: number, text: string): Extract<TranscriptMessage, { kind: 'assistant' }> {
  return { kind: 'assistant', turn, text }
}

interface AssistantProofSelection {
  readonly exact: boolean
  readonly selectedIndex: number
  readonly selectedRow?: number
  readonly exactPaintedSegments?: ReadonlyArray<{ readonly row: number; readonly startCol: number; readonly endCol: number }>
}

function assistantProofSelection(app: TuiApp, message: TranscriptMessage): AssistantProofSelection | undefined {
  const mounted = (app as unknown as {
    mountedTranscriptBlocks: ReadonlyArray<{ block: { message?: TranscriptMessage }; searchSelection?: AssistantProofSelection }>
  }).mountedTranscriptBlocks
  return mounted.find(entry => entry.block.message === message)?.searchSelection
}

test('perf: one Assistant Markdown proof per current presentation, never per history card or frame', async () => {
  const { vt, app } = startApp()
  const current = assistantMessage(0, 'needle one')
  const history = Array.from({ length: 8 }, (_, index) => assistantMessage(index + 1, `needle history ${index}`))
  app.setFullscreen(true)
  app.setTranscript([current, ...history])
  await vt.waitForRender()

  app.resetSearchPresentationDiagnosticsForTest()
  app.setTranscriptSearchTarget(target(current, 'needle', 0, { start: 0, end: 6 }))
  let diagnostics = app.searchPresentationDiagnosticsForTest()
  assert.equal(diagnostics.markdownProofs, 1,
    'exactly ONE F1 proof for the current target — never one per history card')
  assert.ok(diagnostics.markdownProofs <= diagnostics.rebuilds + diagnostics.remeasures,
    'every presentation pass proves the current card at most once')
  const selection = assistantProofSelection(app, current)
  assert.equal(selection?.exact, true)
  assert.equal(selection?.selectedIndex, -1)
  assert.deepEqual(selection?.exactPaintedSegments, [{ row: 0, startCol: 4, endCol: 10 }],
    'the emoji bullet indent is part of the card-relative cell geometry')

  for (let frame = 0; frame < 2; frame += 1) {
    await vt.waitForRender()
    app.resetSearchPresentationDiagnosticsForTest()
    await vt.waitForRender()
    assert.equal(app.searchPresentationDiagnosticsForTest().markdownProofs, 0,
      'settled repaints never re-run the proof')
  }
  app.resetSearchPresentationDiagnosticsForTest()
  app.scrollToSearchTarget()
  await vt.waitForRender()
  assert.equal(app.searchPresentationDiagnosticsForTest().markdownProofs, 0,
    'a scroll-only frame never re-runs the proof')

  app.resetSearchPresentationDiagnosticsForTest()
  app.setTranscriptSearchTarget(target(history[0]!, 'needle', 0, { start: 0, end: 6 }))
  assert.equal(app.searchPresentationDiagnosticsForTest().markdownProofs, 1,
    'switching the current target proves only the new current card once')
  assert.equal(assistantProofSelection(app, history[0]!)?.exact, true)
  const exactCards = (app as unknown as {
    mountedTranscriptBlocks: ReadonlyArray<{ searchSelection?: { exact: boolean } }>
  }).mountedTranscriptBlocks.filter(entry => entry.searchSelection?.exact === true)
  assert.equal(exactCards.length, 1, 'only the current card carries a proven source-cell selection')
  app.stop()
})

test('perf: an unchanged Assistant presentation and a stale range never re-prove', async () => {
  const { vt, app } = startApp()
  const message = assistantMessage(0, 'needle one')
  app.setFullscreen(true)
  app.setTranscript([message])
  await vt.waitForRender()
  const representatives = new Set([message])
  app.setTranscriptSearchPresentation({
    matchMessages: representatives,
    target: target(message, 'needle', 0, { start: 0, end: 6 }),
    grantReveal: true,
  })
  await vt.waitForRender()
  assert.equal(assistantProofSelection(app, message)?.exact, true, 'precondition: the current cell is proven')

  app.resetSearchPresentationDiagnosticsForTest()
  app.setTranscriptSearchPresentation({
    matchMessages: representatives,
    target: target(message, 'needle', 0, { start: 0, end: 6 }),
    grantReveal: false,
  })
  let diagnostics = app.searchPresentationDiagnosticsForTest()
  assert.equal(diagnostics.rebuilds, 0, 'an unchanged semantic presentation commit is a no-op')
  assert.equal(diagnostics.markdownProofs, 0, 'a no-op commit never re-runs the proof')

  // A changed source keeps the OLD target: the projection is rejected BEFORE
  // the F1 call, so no stale proven segment can survive.
  message.text = 'omega after'
  app.setTranscript([message])
  diagnostics = app.searchPresentationDiagnosticsForTest()
  assert.equal(diagnostics.markdownProofs, 0, 'a stale normalized range never reaches the F1 proof')
  assert.equal(assistantProofSelection(app, message)?.exact, false)
  assert.equal(assistantProofSelection(app, message)?.exactPaintedSegments, undefined)

  // The same stable identity with a moved source re-locates the painted cell.
  message.text = 'prefix needle after'
  app.setTranscript([message])
  await vt.waitForRender()
  app.resetSearchPresentationDiagnosticsForTest()
  app.setTranscriptSearchTarget(target(message, 'needle', 0, { start: 7, end: 13 }))
  assert.equal(app.searchPresentationDiagnosticsForTest().markdownProofs, 1)
  const moved = assistantProofSelection(app, message)
  assert.equal(moved?.exact, true, 'the moved source occurrence is re-proven')
  assert.deepEqual(moved?.exactPaintedSegments, [{ row: 0, startCol: 11, endCol: 17 }],
    'the proven cell moves with the inserted prefix instead of reusing the old column')
  app.stop()
})

test('perf: a geometric remeasure re-proves the current Assistant rows at the new width', async () => {
  const { vt, app } = startApp(100, 30)
  const message = assistantMessage(0, `${'prefix '.repeat(12)}needle tail`)
  app.setFullscreen(true)
  app.setTranscript([message])
  await vt.waitForRender()
  app.setTranscriptSearchTarget(target(message, 'needle', 0, { start: 84, end: 90 }))
  await vt.waitForRender()
  const before = assistantProofSelection(app, message)
  assert.equal(before?.exact, true, 'precondition: the wide geometry is proven')

  app.resetSearchPresentationDiagnosticsForTest()
  vt.resize(40, 30)
  await vt.waitForRender()
  app.scrollToSearchTarget()
  await vt.waitForRender()
  const diagnostics = app.searchPresentationDiagnosticsForTest()
  assert.ok(diagnostics.remeasures >= 1, 'the resize remeasures the mounted rows')
  assert.ok(diagnostics.markdownProofs >= 1, 'the remeasure re-proves instead of reusing the old width')
  const after = assistantProofSelection(app, message)
  assert.equal(after?.exact, true, 'the narrowed geometry is proven against the CURRENT rows')
  assert.notDeepEqual(after?.exactPaintedSegments, before?.exactPaintedSegments,
    'the old proven columns are not reused across the width change')
  app.stop()
})

test('perf: a theme change re-proves the Assistant cell instead of reusing the old proof', async () => {
  const { vt, app } = startApp()
  const message = assistantMessage(0, 'needle one')
  app.setFullscreen(true)
  app.setTranscript([message])
  await vt.waitForRender()
  app.setTranscriptSearchTarget(target(message, 'needle', 0, { start: 0, end: 6 }))
  await vt.waitForRender()
  const before = assistantProofSelection(app, message)?.exactPaintedSegments
  assert.deepEqual(before, [{ row: 0, startCol: 4, endCol: 10 }])

  app.resetSearchPresentationDiagnosticsForTest()
  app.applyTheme('light')
  await vt.waitForRender()
  assert.ok(app.searchPresentationDiagnosticsForTest().markdownProofs >= 1,
    'the rebuilt theme component is proven again')
  const after = assistantProofSelection(app, message)
  assert.equal(after?.exact, true, 'the theme rebuild still proves the same source cell')
  assert.deepEqual(after?.exactPaintedSegments, before, 'the same source range keeps the same painted columns')
  app.applyTheme('dark')
  app.stop()
})
