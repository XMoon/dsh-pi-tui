/**
 * Transcript-search navigation regression matrix (plan §14.6/§14.7): the
 * TuiApp-level occurrence highlight / reveal / viewport-anchor contract that
 * the old card-level tests could not exercise.
 * @module @xmoon76/dsh-pi-tui/transcript-search-navigation.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { MessageId, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { TuiApp } from '../../src/tui-app.ts'
import { darkColors, lightColors } from '../../src/domain/display/theme.ts'
import { currentPalette } from '../../src/tui/theme/runtime.ts'
import { TranscriptFolder, workflowPhaseKey, type TranscriptMessage, type TranscriptSearchMatch, type TranscriptToolMessage } from '../../src/transcript.ts'
import { deliveredFilesCapabilityStub } from '../support/delivered-files.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { assistantVisualPresentation, setAssistantVisualPresentation } from '../../src/domain/visual/presentation.ts'
import type { PublishedVisual } from '../../src/domain/visual/publication.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

function startApp(width = 100, height = 30): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(width, height)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

async function viewport(vt: VirtualTerminal): Promise<string[]> {
  await vt.waitForRender()
  return vt.getViewport()
}

/** The viewport row + columns of the two `needle` occurrences on one line. */
function occurrenceCells(lines: readonly string[]): { row: number; first: number; second: number } {
  const row = lines.findIndex(line => line.includes('needle alpha needle beta'))
  assert.ok(row >= 0, `occurrence line missing:\n${lines.join('\n')}`)
  const text = lines[row]!
  const first = text.indexOf('needle')
  const second = text.lastIndexOf('needle')
  return { row, first, second }
}

/** Whether a rendered cell carries the EXACT-current themed block. This is the
 * real "is this occurrence the proven current one" signal now that the exact
 * style deliberately no longer uses the terminal inverse attribute. */
function isStrongCell(vt: VirtualTerminal, row: number, col: number): boolean {
  return vt.getCellBgRgb(row, col) === 0xf5c542
}

/** Press+release a left click at one viewport cell. */
function click(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x};${y}M`)
  vt.sendInput(`\x1b[<0;${x};${y}m`)
}

function sessionEvent(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

/** Fold one real user turn so every match comes from the authoritative
 * `TranscriptFolder.search()` (never a hand-built source range). */
function userMessageFolder(text: string, turn = 0): {
  folder: TranscriptFolder
  message: Extract<TranscriptMessage, { kind: 'user' }>
} {
  const folder = new TranscriptFolder()
  folder.apply([
    sessionEvent('turn/start', { turn }, 0),
    sessionEvent('user/message', {
      id: MessageId(`search-user-${turn}`),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }, 1),
    sessionEvent('turn/end', { turn, reason: { kind: 'completed' } }, 2),
  ])
  const message = folder.messages().find(
    (candidate): candidate is Extract<TranscriptMessage, { kind: 'user' }> => candidate.kind === 'user',
  )
  assert.ok(message !== undefined, 'fixture: the folded user message exists')
  return { folder, message }
}

/** Fold one real reasoning attempt into a Host Thinking row. */
function thinkingMessageFolder(text: string, turn = 0): {
  folder: TranscriptFolder
  message: Extract<TranscriptMessage, { kind: 'thinking' }>
} {
  const folder = new TranscriptFolder()
  folder.apply([
    sessionEvent('turn/start', { turn }, 0),
    sessionEvent('assistant/attempt', {
      turn,
      step: 0,
      stream: [{ type: 'chunk', time: 1_700_000_000_002, chunk: { type: 'reasoning-delta', index: 0, text } }],
    }, 1),
    sessionEvent('turn/end', { turn, reason: { kind: 'completed' } }, 2),
  ])
  const message = folder.messages().find(
    (candidate): candidate is Extract<TranscriptMessage, { kind: 'thinking' }> => candidate.kind === 'thinking',
  )
  assert.ok(message !== undefined, 'fixture: the folded Thinking row exists')
  return { folder, message }
}

interface MountedSearchSelectionForTest {
  readonly selectedIndex: number
  readonly selectedRow?: number
  readonly exact: boolean
  readonly exactPaintedSegments?: ReadonlyArray<{ readonly row: number; readonly startCol: number; readonly endCol: number }>
  readonly sourceDisposition?: 'not-painted' | 'unproven'
}

function mountedSelectionFor(app: TuiApp, message: TranscriptMessage): MountedSearchSelectionForTest | undefined {
  const mounted = (app as unknown as {
    mountedTranscriptBlocks: ReadonlyArray<{ block: { message?: TranscriptMessage }; searchSelection?: MountedSearchSelectionForTest }>
  }).mountedTranscriptBlocks
  return mounted.find(entry => entry.block.message === message)?.searchSelection
}

/** The terminal column of one visible needle occurrence, measured with the
 * same cell width the terminal uses (never a JS string index). */
function columnOf(line: string, needle: string, occurrence = 0): number {
  let index = -1
  let from = 0
  for (let occurrenceIndex = 0; occurrenceIndex <= occurrence; occurrenceIndex += 1) {
    index = line.indexOf(needle, from)
    assert.ok(index >= 0, `occurrence ${occurrenceIndex} of ${JSON.stringify(needle)} missing from ${JSON.stringify(line)}`)
    from = index + needle.length
  }
  return visibleWidth(line.slice(0, index))
}

const STRONG_BG = 0xf5c542
const ANCHOR_BG = 0x3a3220

test('navigation: direct Workflow provenance remains visible across the frozen size, theme and icon matrix', async () => {
  const previousPalette = currentPalette
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  try {
    app.setFullscreen(true)
    const card = {
      kind: 'workflow', turn: 0, runId: 'run-visual-matrix' as never, name: '任务 needle-run', status: 'running',
      members: [],
    } as Extract<TranscriptMessage, { kind: 'workflow' }>
    const sizes = [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20]] as const
    const iconStyles = ['emoji', 'symbols', 'minimal'] as const

    for (const [theme, width, height] of [
      ...sizes.map(([columns, rows]) => ['dark', columns, rows] as const),
      ...sizes.map(([columns, rows]) => ['light', columns, rows] as const),
      ...sizes.map(([columns, rows]) => ['custom', columns, rows] as const),
    ]) {
      for (const iconStyle of iconStyles) {
        vt.resize(width, height)
        if (theme === 'dark' || theme === 'light') app.applyTheme(theme)
        else app.applyPalette({ ...darkColors, searchCurrentBg: '#123456' })
        app.setIconStyle(iconStyle)
        app.setTranscript([card])
        app.setTranscriptSearchTarget(undefined)
        let lines = await viewport(vt)
        const row = lines.findIndex(line => line.includes('任务 needle-run'))
        assert.ok(row >= 0, `Workflow field is visible at ${width}x${height}, ${theme}, ${iconStyle}:\n${lines.join('\n')}`)
        const column = visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf('needle')))
        const beforeBg = vt.getCellBgRgb(row, column)
        assert.notEqual(beforeBg, 0xf5c542, 'the pre-search field cell is not painted as current')

        app.setTranscriptSearchTarget({
          query: 'needle',
          match: {
            id: 0, turn: 0, occurrence: 0,
            normalizedSourceRange: { start: 3, end: 9 },
            source: { kind: 'workflow-run', field: 'name' },
            sourceOccurrence: 0,
          },
          message: card,
        })
        lines = await viewport(vt)
        const targetRow = lines.findIndex(line => line.includes('任务 needle-run'))
        assert.ok(targetRow >= 0, `searched Workflow field stays visible at ${width}x${height}, ${theme}, ${iconStyle}`)
        const targetColumn = visibleWidth(lines[targetRow]!.slice(0, lines[targetRow]!.indexOf('needle')))
        assert.ok(vt.getCellBgRgb(targetRow, targetColumn) !== beforeBg,
          `the exact current source cell changes at ${width}x${height}, ${theme}, ${iconStyle}`)
        const mounted = (app as unknown as {
          mountedTranscriptBlocks: ReadonlyArray<{ block: { message?: TranscriptMessage }; searchSelection?: { exact: boolean; selectedIndex: number } }>
        }).mountedTranscriptBlocks
        const selection = mounted.find(entry => entry.block.message === card)?.searchSelection
        assert.equal(selection?.exact, true, `the direct field proof holds at ${width}x${height}, ${theme}, ${iconStyle}`)
        assert.ok(selection!.selectedIndex >= 0)
      }
    }
  } finally {
    if (previousPalette === darkColors) app.applyTheme('dark')
    else if (previousPalette === lightColors) app.applyTheme('light')
    else app.applyPalette(previousPalette)
    app.stop()
  }
})
test('navigation: a search reveal proves the hidden User body and scrolls to it', async () => {
  const { vt, app } = startApp(100, 20)
  const longText = Array.from({ length: 24 }, (_, index) => `line ${index}`).join('\n')
    + '\nneedle in the compacted middle\n' + Array.from({ length: 6 }, (_, index) => `tail ${index}`).join('\n')
  const { folder, message } = userMessageFolder(longText)
  const match = folder.search('needle')[0]
  assert.ok(match !== undefined)
  app.setFullscreen(true)
  app.setTranscript([message], folder.turnActivities())
  let lines = await viewport(vt)
  const collapsed = lines.join('\n')
  assert.ok(!collapsed.includes('needle in the compacted middle'), 'precondition: the middle is compacted away')
  assert.ok(collapsed.includes('rows compacted'), 'precondition: the bubble is compacted')

  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: 'needle', match, message },
    grantReveal: true,
  })
  app.scrollToSearchTarget()
  lines = await viewport(vt)
  const revealed = lines.join('\n')
  assert.ok(!revealed.includes('rows compacted'), `the search reveal still opens the bubble:\n${revealed}`)
  const row = lines.findIndex(line => line.includes('needle in the compacted middle'))
  assert.ok(row >= 0, `the revealed target body is visible:\n${revealed}`)
  assert.ok((app.fullscreenScrollForTest()?.scrollTop ?? 0) > 0, 'the proven painted row is below the card top')
  assert.equal(vt.getCellBgRgb(row, columnOf(lines[row]!, 'needle')), STRONG_BG, 'the revealed source cell is current')
  const selection = mountedSelectionFor(app, message)
  assert.equal(selection?.exact, true, 'the revealed body is proven, not guessed')
  assert.equal(selection?.selectedIndex, -1, 'the plain-text channel never needs a rendered ordinal')
  assert.equal(selection?.selectedRow, selection?.exactPaintedSegments?.[0]?.row)
  assert.ok((selection?.exactPaintedSegments?.length ?? 0) > 0)

  // An explicit body click collapses the target and revokes the temporary
  // reveal; a later passive rebind must not re-open it.
  click(vt, 10, row)
  lines = await viewport(vt)
  assert.ok(lines.join('\n').includes('rows compacted'), 'the explicit collapse hides the body again')
  assert.equal(app.transcriptSearchPresentationForTest()?.revealGranted, false, 'an explicit collapse revokes the reveal')
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: 'needle', match, message },
    grantReveal: false,
  })
  lines = await viewport(vt)
  assert.ok(!lines.join('\n').includes('needle in the compacted middle'), 'a passive rebind never re-grants the reveal')
  const passive = mountedSelectionFor(app, message)
  assert.equal(passive?.exact, false, 'a collapsed body has no cell proof')
  assert.equal(passive?.exactPaintedSegments, undefined, 'no stale painted segments survive the collapse')
  assert.equal(passive?.selectedRow, 0, 'the honest source anchor is the card top')

  // An explicit navigation re-grants and re-opens the body, which re-proves
  // its painted cells at the current width.
  app.setTranscriptSearchTarget({ query: 'needle', match, message })
  app.scrollToSearchTarget()
  lines = await viewport(vt)
  assert.ok(lines.join('\n').includes('needle in the compacted middle'), 'the explicit navigation re-opens the body')
  const reproved = mountedSelectionFor(app, message)
  assert.equal(reproved?.exact, true)
  assert.ok((reproved?.exactPaintedSegments?.length ?? 0) > 0)

  // Dismiss promotes the durable long-user owner (PR-A semantics unchanged).
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  lines = await viewport(vt)
  assert.ok(lines.join('\n').includes('needle in the compacted middle'), 'dismiss keeps the revealed body open')
  const overrides = (app as unknown as { expandedOverride: Map<object, boolean> }).expandedOverride
  assert.equal(overrides.get(message), true, 'dismiss promotes the durable long-user owner')
  app.stop()
})

test('navigation: two distant User hits scroll to their own painted cells', async () => {
  const text = [
    'top filler',
    'needle first hit',
    ...Array.from({ length: 20 }, (_, index) => `middle filler ${index}`),
    'needle second hit',
    'bottom filler',
  ].join('\n')
  const { folder, message } = userMessageFolder(text)
  const matches = folder.search('needle')
  assert.equal(matches.length, 2, 'the authoritative corpus owns exactly two occurrences')
  const other: TranscriptMessage = { kind: 'user', turn: 1, text: 'another needle card' }
  const { vt, app } = startApp(100, 12)
  app.setFullscreen(true)
  app.setTranscript([message, other], folder.turnActivities())
  await viewport(vt)
  const representatives = new Set([message, other])
  const navigate = (occurrence: number): void => {
    app.setTranscriptSearchPresentation({
      matchMessages: representatives,
      target: { query: 'needle', match: matches[occurrence]!, message },
      grantReveal: true,
    })
    app.scrollToSearchTarget()
  }

  navigate(0)
  let lines = await viewport(vt)
  let row = lines.findIndex(line => line.includes('needle first hit'))
  assert.ok(row >= 0, `the first target is visible:\n${lines.join('\n')}`)
  assert.equal(vt.getCellBgRgb(row, columnOf(lines[row]!, 'needle')), STRONG_BG, 'the first occurrence is current')
  let selection = mountedSelectionFor(app, message)
  assert.equal(selection?.exact, true)
  assert.equal(selection?.selectedIndex, -1)
  assert.equal(selection?.exactPaintedSegments?.[0]?.row, selection?.selectedRow)
  const firstScrollTop = app.fullscreenScrollForTest()!.scrollTop
  const otherRow = lines.findIndex(line => line.includes('another needle card'))
  if (otherRow >= 0) {
    assert.ok(vt.getCellUnderline(otherRow, columnOf(lines[otherRow]!, 'needle')), 'the other matching card is weak')
    assert.notEqual(vt.getCellBgRgb(otherRow, columnOf(lines[otherRow]!, 'needle')), STRONG_BG,
      'a different card never borrows the current strong block')
  }

  navigate(1)
  lines = await viewport(vt)
  row = lines.findIndex(line => line.includes('needle second hit'))
  assert.ok(row >= 0, `the second target is visible:\n${lines.join('\n')}`)
  assert.ok(!lines.some(line => line.includes('needle first hit')), 'the first occurrence is not the viewport destination')
  assert.notEqual(app.fullscreenScrollForTest()!.scrollTop, firstScrollTop, 'Next moves the viewport to the proven row')
  assert.equal(vt.getCellBgRgb(row, columnOf(lines[row]!, 'needle')), STRONG_BG, 'the second occurrence is current')
  selection = mountedSelectionFor(app, message)
  assert.equal(selection?.exact, true)
  assert.equal(selection?.exactPaintedSegments?.[0]?.row, selection?.selectedRow)

  navigate(0)
  lines = await viewport(vt)
  const backRow = lines.findIndex(line => line.includes('needle first hit'))
  assert.ok(backRow >= 0, `Prev returns to the first occurrence:\n${lines.join('\n')}`)
  assert.equal(vt.getCellBgRgb(backRow, columnOf(lines[backRow]!, 'needle')), STRONG_BG, 'the first cell is current again')
  app.stop()
})

test('navigation: clearing the target removes every proven decoration', async () => {
  const { folder, message } = userMessageFolder('needle alpha needle beta')
  const match = folder.search('needle')[0]
  assert.ok(match !== undefined)
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript([message], folder.turnActivities())
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: 'needle', match, message },
    grantReveal: true,
  })
  let lines = await viewport(vt)
  let cells = occurrenceCells(lines)
  assert.equal(mountedSelectionFor(app, message)?.exact, true, 'precondition: the current User hit is proven')
  assert.equal(vt.getCellBgRgb(cells.row, cells.first), STRONG_BG, 'precondition: the current occurrence is strong')
  assert.ok(vt.getCellUnderline(cells.row, cells.second), 'precondition: the other occurrence is weak')

  app.setTranscriptSearchTarget(undefined)
  lines = await viewport(vt)
  cells = occurrenceCells(lines)
  assert.equal(vt.getCellUnderline(cells.row, cells.first), false, 'clearing removes the first decoration')
  assert.equal(vt.getCellUnderline(cells.row, cells.second), false, 'clearing removes every decoration')
  assert.notEqual(vt.getCellBgRgb(cells.row, cells.first), STRONG_BG, 'clearing leaves no strong highlight')
  assert.notEqual(vt.getCellBgRgb(cells.row, cells.second), STRONG_BG, 'the other occurrence is not strong either')
  app.stop()
})

test('navigation: resize re-proves the current wrapped User cell at the new width', async () => {
  const text = `${'prefix filler '.repeat(14)}needle wrapped target ${'suffix filler '.repeat(14)}`
  const { folder, message } = userMessageFolder(text)
  const match = folder.search('needle')[0]
  assert.ok(match !== undefined)
  const { vt, app } = startApp(100, 14)
  app.setFullscreen(true)
  app.setTranscript([message], folder.turnActivities())
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: 'needle', match, message },
    grantReveal: true,
  })
  app.scrollToSearchTarget()
  let lines = await viewport(vt)
  let row = lines.findIndex(line => line.includes('needle'))
  assert.ok(row >= 0, `the target is visible before resize:\n${lines.join('\n')}`)
  assert.equal(vt.getCellBgRgb(row, columnOf(lines[row]!, 'needle')), STRONG_BG, 'the pre-resize cell is exact')

  vt.resize(40, 14)
  await viewport(vt)
  app.scrollToSearchTarget()
  lines = await viewport(vt)
  row = lines.findIndex(line => line.includes('needle'))
  assert.ok(row >= 0, `the target remains visible after re-wrapping:\n${lines.join('\n')}`)
  assert.equal(vt.getCellBgRgb(row, columnOf(lines[row]!, 'needle')), STRONG_BG,
    'resize re-proves the current cells at the new width instead of reusing stale columns')
  const selection = mountedSelectionFor(app, message)
  assert.equal(selection?.exact, true)
  assert.equal(selection?.selectedRow, selection?.exactPaintedSegments?.[0]?.row)
  app.stop()
})

test('navigation: an already-visible proven range does not jitter the viewport', async () => {
  const { vt, app } = startApp(100, 12)
  const text = [
    ...Array.from({ length: 5 }, (_, index) => `prefix ${index}`),
    'needle visible target',
    ...Array.from({ length: 18 }, (_, index) => `suffix ${index}`),
  ].join('\n')
  const { folder, message } = userMessageFolder(text)
  const match = folder.search('needle')[0]
  assert.ok(match !== undefined)
  app.setFullscreen(true)
  app.setTranscript([message], folder.turnActivities())
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: 'needle', match, message },
    grantReveal: true,
  })
  app.scrollToSearchTarget()
  const scroll = app.fullscreenScrollForTest()
  assert.ok(scroll !== undefined)
  await viewport(vt)
  app.scrollToTop({ disableFollow: true })
  await viewport(vt)
  const before = app.fullscreenScrollForTest()!.scrollTop
  assert.ok(vt.getViewport().some(line => line.includes('needle visible target')), 'precondition: target remains visible after a manual scroll')
  app.scrollToSearchTarget()
  assert.equal(app.fullscreenScrollForTest()!.scrollTop, before, 'an already-visible proven range must not be re-centered')
  app.stop()
})

interface SearchPaintedRects {
  readonly overlay: { readonly row: number; readonly col: number; readonly width: number; readonly height: number }
  readonly viewport: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

/** The REAL painted rectangles of the current frame: the managed Search
 * overlay handle and the fullscreen ScrollView component. Tests must read the
 * production geometry, never re-derive the overlay's width/margin formula. */
function searchPaintedRects(app: TuiApp): SearchPaintedRects {
  const internals = app as unknown as {
    searchOverlay?: { getBounds(): { row: number; col: number; width: number; height: number } | undefined }
    fullscreen?: { getPaintedBox(component: unknown): { x: number; y: number; width: number; height: number } | undefined }
    fullscreenScroll?: unknown
  }
  const overlay = internals.searchOverlay?.getBounds()
  assert.ok(overlay !== undefined, 'the Search overlay is painted in this frame')
  const viewport = internals.fullscreen?.getPaintedBox(internals.fullscreenScroll)
  assert.ok(viewport !== undefined, 'the transcript ScrollView is painted in this frame')
  return { overlay, viewport }
}

function scrollViewInternals(app: TuiApp): { scrollTop: number; scrollTo(top: number, options?: object): void } {
  const scroll = (app as unknown as { fullscreenScroll?: { scrollTop: number; scrollTo(top: number, options?: object): void } }).fullscreenScroll
  assert.ok(scroll !== undefined, 'the fullscreen transcript owns its scroll view')
  return scroll
}

/** The first viewport cell of the current STRONG transcript-search
 * occurrence (the themed current-match block is unique to the proven cells). */
function findStrongSearchCell(vt: VirtualTerminal): { row: number; col: number } | undefined {
  const lines = vt.getViewport()
  for (let row = 0; row < lines.length; row += 1) {
    for (let col = 0; col < visibleWidth(lines[row]!); col += 1) {
      if (vt.getCellBgRgb(row, col) === STRONG_BG) return { row, col }
    }
  }
  return undefined
}

function strongSearchCell(vt: VirtualTerminal): { row: number; col: number } {
  const cell = findStrongSearchCell(vt)
  assert.ok(cell !== undefined, `no strong search cell is painted:\n${vt.getViewport().join('\n')}`)
  return cell
}

/** Whether one painted cell rect intersects the real overlay rectangle. */
function cellUnderOverlay(row: number, col: number, overlay: SearchPaintedRects['overlay']): boolean {
  return row >= overlay.row && row < overlay.row + overlay.height
    && col >= overlay.col && col < overlay.col + overlay.width
}

test('navigation: a proven target under the Search box moves below it, while a left-side hit never moves', async () => {
  for (const [width, height] of [[80, 24], [100, 30]] as const) {
    const filler = (prefix: string, count: number): string[] =>
      Array.from({ length: count }, (_, index) => `${prefix} ${index}`)

    // A hit whose painted COLUMNS sit under the box (a long line before it).
    const rightText = [
      ...filler('head', 40),
      `${'x'.repeat(60)} needle occluded target`,
      ...filler('tail', 40),
    ].join('\n')
    const right = userMessageFolder(rightText)
    const rightMatch = right.folder.search('needle')[0]
    assert.ok(rightMatch !== undefined, 'fixture: the right-side occurrence exists')
    const rightStart = startApp(width, height)
    rightStart.app.setFullscreen(true)
    rightStart.app.setTranscript([right.message], right.folder.turnActivities())
    await viewport(rightStart.vt)
    rightStart.app.startTranscriptSearch('full')
    await viewport(rightStart.vt)
    rightStart.app.setTranscriptSearchPresentation({
      matchMessages: new Set([right.message]),
      target: { query: 'needle', match: rightMatch, message: right.message },
      grantReveal: true,
    })
    rightStart.app.scrollToSearchTarget()
    await viewport(rightStart.vt)
    const rects = searchPaintedRects(rightStart.app)
    const scroll = scrollViewInternals(rightStart.app)
    const placed = strongSearchCell(rightStart.vt)
    assert.ok(!cellUnderOverlay(placed.row, placed.col, rects.overlay),
      `${width}x${height}: the first placement puts the proven cell outside the box`)
    // The user scrolls the target under the box's own row band.
    const boxRow = Math.min(rects.overlay.row + 1, rects.overlay.row + rects.overlay.height - 1)
    scroll.scrollTo(scroll.scrollTop + placed.row - boxRow, { disableFollow: true })
    await viewport(rightStart.vt)
    const before = scroll.scrollTop
    // The box paints OVER the covered cell, so the visible-frame witness is the
    // strong cell disappearing together with the needle text.
    assert.equal(findStrongSearchCell(rightStart.vt), undefined,
      `${width}x${height}: precondition: the box hides the covered current cell`)
    assert.ok(!rightStart.vt.getViewport().some(line => line.includes('needle')),
      `${width}x${height}: precondition: the covered target text is not on screen`)

    rightStart.app.scrollToSearchTarget()
    await viewport(rightStart.vt)
    assert.notEqual(scroll.scrollTop, before, `${width}x${height}: a covered jump moves the viewport`)
    const moved = strongSearchCell(rightStart.vt)
    assert.equal(moved.row, rects.overlay.row + rects.overlay.height,
      `${width}x${height}: the target lands on the row just below the box`)
    assert.ok(!cellUnderOverlay(moved.row, moved.col, rects.overlay), 'the moved cell is not occluded')
    assert.ok(moved.row >= rects.viewport.y && moved.row < rects.viewport.y + rects.viewport.height,
      'the moved cell is inside the painted viewport')
    rightStart.app.dispose()

    // The SAME row band, but painted LEFT of the box: readable, no scroll.
    const leftText = [
      ...filler('head', 40),
      'needle left of the box',
      ...filler('tail', 40),
    ].join('\n')
    const left = userMessageFolder(leftText)
    const leftMatch = left.folder.search('needle')[0]
    assert.ok(leftMatch !== undefined, 'fixture: the left-side occurrence exists')
    const leftStart = startApp(width, height)
    leftStart.app.setFullscreen(true)
    leftStart.app.setTranscript([left.message], left.folder.turnActivities())
    await viewport(leftStart.vt)
    leftStart.app.startTranscriptSearch('full')
    await viewport(leftStart.vt)
    leftStart.app.setTranscriptSearchPresentation({
      matchMessages: new Set([left.message]),
      target: { query: 'needle', match: leftMatch, message: left.message },
      grantReveal: true,
    })
    leftStart.app.scrollToSearchTarget()
    await viewport(leftStart.vt)
    const leftRects = searchPaintedRects(leftStart.app)
    const leftScroll = scrollViewInternals(leftStart.app)
    const leftPlaced = strongSearchCell(leftStart.vt)
    const leftBoxRow = Math.min(leftRects.overlay.row + 1, leftRects.overlay.row + leftRects.overlay.height - 1)
    leftScroll.scrollTo(leftScroll.scrollTop + leftPlaced.row - leftBoxRow, { disableFollow: true })
    await viewport(leftStart.vt)
    const leftBefore = leftScroll.scrollTop
    const leftCell = strongSearchCell(leftStart.vt)
    assert.equal(leftCell.row, leftBoxRow)
    assert.equal(cellUnderOverlay(leftCell.row, leftCell.col, leftRects.overlay), false,
      `${width}x${height}: precondition: the same row is painted left of the box`)
    leftStart.app.scrollToSearchTarget()
    await viewport(leftStart.vt)
    assert.equal(leftScroll.scrollTop, leftBefore,
      `${width}x${height}: a readable left-side hit on the box row never jitters`)
    assert.equal(strongSearchCell(leftStart.vt).row, leftBoxRow)
    leftStart.app.dispose()
  }
})

test('navigation: a session replacement retires the notice and its pending occlusion correction', async () => {
  const { vt, app } = startApp(100, 30)
  app.setFullscreen(true)
  const tool: TranscriptMessage = {
    kind: 'tool',
    turn: 0,
    name: 'bash',
    args: '{}',
    result: 'needle tool output',
    status: 'ok',
  }
  app.setTranscript([tool])
  await viewport(vt)
  app.startTranscriptSearch('full')
  await viewport(vt)
  const scroll = scrollViewInternals(app)
  const before = scroll.scrollTop
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([tool]),
    target: {
      query: 'needle',
      match: {
        id: -1,
        turn: 0,
        occurrence: 0,
        source: { kind: 'tool-field', field: 'result' },
        sourceOccurrence: 0,
        normalizedSourceRange: { start: 0, end: 6 },
      },
      message: tool,
    },
    grantReveal: true,
  })
  app.scrollToSearchTarget()
  assert.equal(app.currentFullSearchNotice()?.kind, 'unproven', 'precondition: the notice is current')
  // A session/subject hydration seam replaces the transcript BEFORE the next
  // painted frame; the registered correction must never move the new screen.
  app.clearSessionOverrides()
  await viewport(vt)
  await viewport(vt)
  assert.equal(app.currentFullSearchNotice(), undefined,
    'a session replacement retires the old Source-only notice')
  assert.equal(app.searchPresentationDiagnosticsForTest().occlusionCorrections, 0,
    'the retired screen never applies the previous session\'s correction')
  assert.equal(scroll.scrollTop, before, 'the new session keeps its own viewport')
  app.stop()
})

/** Count the grapheme segments the production code iterates inside `run`.
 * A whole-message expansion yields one segment per code unit; a bounded
 * context window yields a few hundred at most. */
function countGraphemeSegments(run: () => void): number {
  const prototype = Intl.Segmenter.prototype as unknown as {
    segment(input: string): Iterable<Intl.SegmentData>
  }
  const original = prototype.segment
  let yields = 0
  prototype.segment = function (this: Intl.Segmenter, input: string): Iterable<Intl.SegmentData> {
    const result = original.call(this, input)
    return {
      [Symbol.iterator]: function* () {
        for (const item of result) {
          yields += 1
          yield item
        }
      },
    }
  }
  try {
    run()
    return yields
  } finally {
    prototype.segment = original
  }
}

test('navigation: a Source-only snippet never scans a message-length source or token', async () => {
  // A snippet is a display nicety: a huge source is label-only, and a
  // pathological unbroken token is omitted instead of sliced/regex-tested.
  const cases = [
    // 1e6-char source with 1e5-char suffix: the source-length cap applies
    // before any normalized->raw mapping or token expansion.
    { label: 'huge source', text: `${'a'.repeat(1_000_000)} needle 组合 ${'b'.repeat(100_000)}` },
    // 1e5-char source inside the source cap whose token before the hit is
    // still 1e5 chars: the guard-token cap applies.
    { label: 'huge token', text: `${'a'.repeat(100_000)} needle tail` },
  ] as const
  for (const { label, text } of cases) {
    const { folder, message } = userMessageFolder(text)
    const match = folder.search('needle')[0]
    assert.ok(match !== undefined, 'fixture: the occurrence exists')
    const { vt, app } = startApp(240, 30)
    try {
      app.setFullscreen(true)
      app.setTranscript([message], folder.turnActivities())
      await viewport(vt)
      app.startTranscriptSearch('full')
      await viewport(vt)
      const segments = countGraphemeSegments(() => {
        app.setTranscriptSearchPresentation({
          matchMessages: new Set([message]),
          target: { query: 'needle', match, message },
          grantReveal: false,
        })
      })
      const lines = await viewport(vt)
      const notice = app.currentFullSearchNotice()
      assert.equal(notice?.kind, 'unproven', `${label}: the collapsed User hit is non-exact`)
      assert.equal(notice?.snippet, undefined, `${label}: an over-budget snippet is omitted, never truncated`)
      assert.ok(segments < 5_000,
        `${label}: the presentation path must not segment the whole message (${segments} segments)`)
      const noticeRows = lines.map(line => stripTerminalSequences(line)).filter(line => line.includes('Source-only'))
      assert.equal(noticeRows.length, 1, `${label}: the notice still occupies exactly one physical row`)
      assert.ok(!noticeRows[0]!.includes('User text · '), `${label}: the painted row is label-only`)
    } finally {
      app.dispose()
    }
  }
})

test('navigation: a bounded snippet keeps CJK, combining and ZWJ clusters whole on one physical row', async () => {
  const text = [
    ...Array.from({ length: 12 }, (_, index) => `before ${index}`),
    '汉e\u0301👨‍👩‍👧‍👦 needle 组合字符👩‍💻 suffix',
    ...Array.from({ length: 8 }, (_, index) => `after ${index}`),
  ].join('\n')
  const { folder, message } = userMessageFolder(text)
  const match = folder.search('needle')[0]
  assert.ok(match !== undefined, 'fixture: the occurrence exists')
  const { vt, app } = startApp(240, 30)
  try {
    app.setFullscreen(true)
    app.setTranscript([message], folder.turnActivities())
    await viewport(vt)
    app.startTranscriptSearch('full')
    await viewport(vt)
    app.setTranscriptSearchPresentation({
      matchMessages: new Set([message]),
      target: { query: 'needle', match, message },
      grantReveal: false,
    })
    const lines = await viewport(vt)
    const snippet = app.currentFullSearchNotice()?.snippet ?? ''
    assert.ok(snippet.includes('👨‍👩‍👧‍👦'), 'the leading ZWJ cluster is kept whole')
    assert.ok(snippet.includes('e\u0301'), 'the combining sequence is kept whole')
    assert.ok(snippet.includes('👩‍💻'), 'the trailing ZWJ cluster is kept whole')
    assert.ok(snippet.includes('汉'), 'CJK context is kept')
    assert.ok(!/[\r\n]/u.test(snippet), 'the snippet is one physical line')
    const noticeRows = lines.map(line => stripTerminalSequences(line)).filter(line => line.includes('Source-only'))
    assert.equal(noticeRows.length, 1, 'the notice occupies exactly one physical row')
    assert.ok(noticeRows[0]!.includes('needle'), `the bounded context is really painted:\n${noticeRows[0]}`)
  } finally {
    app.dispose()
  }
})

test('navigation: an IP-literal context never reaches the painted Source-only row at a wide terminal', async () => {
  // The displayed context is a 12-grapheme window, which can SPLIT an address
  // (`127.0.0.1` -> `.0.0.1`), so the safety classifier must see the complete
  // whitespace-delimited token. 200 columns keep the snippet inside the real
  // painted notice row (a 100-column box would drop it by width and hide the
  // leak).
  const cases = [
    { line: 'connect 127.0.0.1 then needle service', safe: false },
    { line: 'connect 10.0.0.1 then needle service', safe: false },
    { line: 'connect 127.0.0.1:8000 then needle service', safe: false },
    { line: 'connect 192.168.1.1 then needle service', safe: false },
    { line: 'connect 8.8.8.8 then needle service', safe: false },
    { line: 'connect ::1 then needle service', safe: false },
    { line: 'connect fe80::1 then needle service', safe: false },
    // Windows DRIVE-RELATIVE paths have no separator at all: `C:needle` is a
    // path on drive C's current directory, not prose.
    { line: 'open C:needle service', safe: false },
    { line: 'open C:needle', safe: false },
    { line: 'open c:needle', safe: false },
    { line: 'needle compacted middle', safe: true },
  ] as const
  for (const { line, safe } of cases) {
    const text = [
      ...Array.from({ length: 12 }, (_, index) => `before ${index}`),
      line,
      ...Array.from({ length: 8 }, (_, index) => `after ${index}`),
    ].join('\n')
    const { folder, message } = userMessageFolder(text)
    const match = folder.search('needle')[0]
    assert.ok(match !== undefined, 'fixture: the User occurrence exists')
    const { vt, app } = startApp(200, 30)
    try {
      app.setFullscreen(true)
      app.setTranscript([message], folder.turnActivities())
      await viewport(vt)
      app.startTranscriptSearch('full')
      await viewport(vt)
      app.setTranscriptSearchPresentation({
        matchMessages: new Set([message]),
        target: { query: 'needle', match, message },
        grantReveal: false,
      })
      const lines = await viewport(vt)
      const notice = app.currentFullSearchNotice()
      assert.equal(notice?.kind, 'unproven', 'the collapsed User hit is honestly non-exact')
      const noticeRow = lines.map(candidate => stripTerminalSequences(candidate))
        .find(candidate => candidate.includes('Source-only'))
      assert.ok(noticeRow !== undefined, `the Source-only row is painted:\n${lines.join('\n')}`)
      if (safe) {
        assert.ok((notice?.snippet ?? '').includes('needle compacted'),
          `a safe context still reaches the notice (${JSON.stringify(notice)})`)
        assert.ok(noticeRow.includes('needle compacted'),
          `the safe snippet is really painted in the four-row box:\n${noticeRow}`)
      } else {
        assert.equal(notice?.snippet, undefined,
          `no IP/path/URL context may become a snippet (${line})`)
        assert.ok(!noticeRow.includes('User text · '),
          `the painted notice row carries no snippet after the source label:\n${noticeRow}`)
        assert.ok(!/\d+\.\d+|::|[\\/]/u.test(noticeRow),
          `no IP/URL/path fragment is painted in the notice row:\n${noticeRow}`)
      }
    } finally {
      app.dispose()
    }
  }
})

test('navigation: a collapsed Host Thinking target is label-only until its body is revealed', async () => {
  const text = [
    ...Array.from({ length: 12 }, (_, index) => `before ${index}`),
    'needle in the hidden reasoning body',
    ...Array.from({ length: 8 }, (_, index) => `after ${index}`),
  ].join('\n')
  const { folder, message } = thinkingMessageFolder(text)
  const match = folder.search('needle')[0]
  assert.ok(match !== undefined, 'fixture: the Thinking occurrence exists')
  const { vt, app } = startApp(100, 30)
  app.setFullscreen(true)
  app.setTranscript([message], folder.turnActivities())
  await viewport(vt)
  app.startTranscriptSearch('full')
  await viewport(vt)

  // Passive rebind: the temporary reveal is NOT granted, so the compact card
  // paints only its preview. The raw reasoning body is hidden transcript text
  // and may never become a Source-only snippet.
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: 'needle', match, message },
    grantReveal: false,
  })
  await viewport(vt)
  assert.equal(mountedSelectionFor(app, message)?.exact, false, 'a collapsed Thinking body has no cell proof')
  assert.equal(mountedSelectionFor(app, message)?.sourceDisposition, 'unproven')
  assert.deepEqual(app.currentFullSearchNotice(), { kind: 'unproven', sourceLabel: 'Thinking text' },
    'a collapsed Host Thinking notice is label-only: no hidden-body snippet')

  // Explicit navigation reveals (expands) the Host Thinking body, which then
  // proves its own painted cells instead of falling back to Source-only.
  app.setTranscriptSearchTarget({ query: 'needle', match, message })
  await viewport(vt)
  const revealed = mountedSelectionFor(app, message)
  assert.equal(revealed?.exact, true, 'the expanded Host Thinking body proves the current cell')
  assert.equal(revealed?.sourceDisposition, undefined)
  assert.equal(app.currentFullSearchNotice(), undefined, 'an exact Thinking target shows no notice')
  app.stop()
})

test('navigation: a collapsed User target is honest Source-only with only a safe sanitized context', async () => {
  const cases = [
    { line: 'needle compacted middle', safe: true },
    { line: '\x1b]52;c;Zm9v\x07\x1b[31mneedle\x1b[0m control middle', safe: false },
    // Path/URL shaped context must never be copied into the Source-only row:
    // Windows drive + backslashes, a plain relative path, and a bare host.
    { line: 'C:\\reports\\needle.txt hidden path', safe: false },
    { line: 'see reports/needle.txt for details', safe: false },
    { line: 'visit example.com then needle', safe: false },
    // A URL AUTHORITY has no separator at all: host:port and bare localhost are
    // URL-shaped context too.
    { line: 'localhost:3000 needle service', safe: false },
    { line: 'connect to api:8443 then needle', safe: false },
    { line: 'localhost needle service', safe: false },
    { line: '[::1]:8080 needle service', safe: false },
  ] as const
  for (const { line, safe } of cases) {
    const text = [
      ...Array.from({ length: 12 }, (_, index) => `before ${index}`),
      line,
      ...Array.from({ length: 8 }, (_, index) => `after ${index}`),
    ].join('\n')
    const { folder, message } = userMessageFolder(text)
    const match = folder.search('needle')[0]
    assert.ok(match !== undefined, 'fixture: the long-User occurrence exists')
    const { vt, app } = startApp(100, 30)
    app.setFullscreen(true)
    app.setTranscript([message], folder.turnActivities())
    await viewport(vt)
    app.setTranscriptSearchPresentation({
      matchMessages: new Set([message]),
      target: { query: 'needle', match, message },
      grantReveal: true,
    })
    app.scrollToSearchTarget()
    let lines = await viewport(vt)
    assert.equal(mountedSelectionFor(app, message)?.exact, true, 'precondition: the reveal proves the body cell')
    const bodyRow = lines.findIndex(candidate => candidate.includes('needle'))
    assert.ok(bodyRow >= 0, `precondition: the revealed body is visible:\n${lines.join('\n')}`)

    // Explicit collapse revokes the temporary reveal; the semantic target stays
    // current but no source cell can be proven any more.
    click(vt, 10, bodyRow)
    lines = await viewport(vt)
    assert.ok(lines.some(candidate => candidate.includes('rows compacted')),
      `precondition: the bubble collapsed again:\n${lines.join('\n')}`)
    app.setTranscriptSearchPresentation({
      matchMessages: new Set([message]),
      target: { query: 'needle', match, message },
      grantReveal: false,
    })
    await viewport(vt)
    assert.equal(mountedSelectionFor(app, message)?.exact, false, 'a collapsed body has no cell proof')
    assert.equal(mountedSelectionFor(app, message)?.sourceDisposition, 'unproven',
      'a collapsed Host body is unproven, never "no visible cell"')

    app.startTranscriptSearch('full')
    lines = await viewport(vt)
    const notice = app.currentFullSearchNotice()
    assert.equal(notice?.kind, 'unproven')
    assert.equal(notice?.sourceLabel, 'User text')
    if (safe) {
      assert.ok((notice?.snippet ?? '').includes('needle'),
        `a Host-owned single-text User source may show a sanitized context (got ${JSON.stringify(notice)})`)
      assert.ok((notice?.snippet ?? '').includes('compacted'), 'the context keeps surrounding graphemes')
    } else {
      assert.equal(notice?.snippet, undefined,
        'control/escape context is never shown, not even sanitized')
    }
    const frame = lines.map(candidate => stripTerminalSequences(candidate))
    const noticeRow = frame.find(candidate => candidate.includes('Source-only'))
    assert.ok(noticeRow !== undefined && noticeRow.includes('unverified'),
      `the overlay paints the honest Source-only row:\n${frame.join('\n')}`)
    assert.ok(!frame.some(candidate => candidate.includes(']52;') || candidate.includes('[31m')),
      'no raw control sequence reaches the painted notice')
    assert.ok(!/[\\/]|example\.com/u.test(noticeRow), 'no path or URL fragment reaches the painted notice')
    app.dispose()
  }
})

test('navigation: a passive transcript repaint does not snap back to the search range', async () => {
  const { vt, app } = startApp(100, 14)
  const text = [
    ...Array.from({ length: 20 }, (_, index) => `prefix ${index}`),
    'needle passive target',
    ...Array.from({ length: 12 }, (_, index) => `suffix ${index}`),
  ].join('\n')
  const { folder, message: targetMessage } = userMessageFolder(text)
  const match = folder.search('needle')[0]
  assert.ok(match !== undefined)
  app.setFullscreen(true)
  app.setTranscript([targetMessage], folder.turnActivities())
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([targetMessage]),
    target: { query: 'needle', match, message: targetMessage },
    grantReveal: true,
  })
  app.scrollToSearchTarget()
  await viewport(vt)
  app.scrollToTop({ disableFollow: true })
  await viewport(vt)
  const before = app.fullscreenScrollForTest()!.scrollTop
  app.setTranscript([targetMessage, { kind: 'user', turn: 1, text: 'new passive content' }])
  await viewport(vt)
  assert.equal(app.fullscreenScrollForTest()!.scrollTop, before, 'passive projection preserves the user viewport')
  app.stop()
})

test('dismiss promotion: Focus root and fullscreen secondary card keep a searched tool open', async () => {
  const event = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
    ({ type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent)
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('user/message', {
      id: MessageId('u-focus'), role: 'user', content: [{ type: 'text', text: 'run the tool' }], source: { kind: 'user' },
    }, 1),
    event('tool/call', {
      turn: 0, step: 0, callId: ToolCallId('focus-tool'), name: 'bash', arguments: JSON.stringify({ command: 'echo needle' }),
    }, 2),
    event('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('focus-result'), role: 'tool',
        toolCallId: ToolCallId('focus-tool'),
        content: [{ type: 'text', text: 'needle output' }],
        source: { kind: 'tool', callId: ToolCallId('focus-tool') },
      },
    }, 3),
    event('assistant/message', {
      turn: 0, step: 1,
      message: {
        id: MessageId('focus-answer'), role: 'assistant', content: [{ type: 'text', text: 'done' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, 4),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5),
  ])
  const match = folder.search('needle').find(candidate => candidate.source.kind === 'tool-field' && candidate.source.field === 'result')
  assert.ok(match !== undefined, 'the tool result search hit exists')
  const message = folder.resolveSearchMatch(match)
  assert.ok(message !== undefined, 'the tool result resolves to its tool card')

  const { vt, app } = startApp()
  app.setFocusMode(true)
  app.setFullscreen(true)
  app.setTranscript(folder.messages(), folder.turnActivities())
  app.setTranscriptSearchTarget({ query: 'needle', match, message })
  let lines = await viewport(vt)
  assert.ok(lines.some(line => line.includes('needle output')), `the search reveal opens the tool body:\n${lines.join('\n')}`)

  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  lines = await viewport(vt)
  const overrides = (app as unknown as { expandedOverride: Map<object, boolean> }).expandedOverride
  assert.equal(app.focusExpandedTurnsForTest().has(0), true, 'dismiss promotes the real Focus Thought root')
  assert.equal(overrides.get(message), true, 'dismiss promotes the fullscreen secondary owner')
  assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'dismiss clears search presentation')
  assert.ok(lines.some(line => line.includes('needle output')), `the searched tool remains open:\n${lines.join('\n')}`)
  app.stop()
})

test('dismiss promotion: Workflow Run and Phase owners become durable after dismiss', async () => {
  const card = {
    kind: 'workflow', turn: 0, runId: 'run-close' as never, name: 'audit', status: 'completed',
    members: Array.from({ length: 6 }, (_, seq) => ({
      seq, label: seq === 5 ? 'needle member' : `member ${seq}`, phase: 'P', childId: `child-${seq}` as never, status: 'completed',
    })),
  } as Extract<TranscriptMessage, { kind: 'workflow' }>
  const { vt, app } = startApp(100, 30)
  app.setFullscreen(true)
  app.setTranscript([card])
  const match = {
    id: 0, turn: 0, occurrence: 0,
    normalizedSourceRange: { start: 0, end: 6 },
    source: { kind: 'workflow-member' as const, phaseKey: workflowPhaseKey('P'), seq: 5, field: 'label' as const },
    sourceOccurrence: 0,
  }
  app.setTranscriptSearchTarget({ query: 'needle', match, message: card })
  let lines = await viewport(vt)
  assert.ok(lines.some(line => line.includes('needle member')), `the search reveal opens the member context:\\n${lines.join('\n')}`)

  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  lines = await viewport(vt)
  const disclosure = (app as unknown as {
    workflowDisclosure: Map<string, { userOpen?: boolean; phases: Map<string, { userOpen?: boolean }> }>
  }).workflowDisclosure
  const state = disclosure.get('run-close')
  assert.equal(state?.userOpen, true, 'dismiss promotes the Workflow Run owner')
  assert.equal(state?.phases.get(workflowPhaseKey('P'))?.userOpen, true, 'dismiss promotes the Workflow Phase owner')
  assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'dismiss clears search presentation')
  assert.ok(lines.some(line => line.includes('Workflow')), `the durable Workflow card remains:\\n${lines.join('\n')}`)
  app.stop()
})

test('dismiss promotion: regular secondary reveal promotes its per-card owner', async () => {
  const { vt, app } = startApp()
  const message: TranscriptMessage = { kind: 'thinking', turn: 0, text: 'needle reasoning' }
  app.setTranscript([message])
  app.setTranscriptSearchTarget({
    query: 'needle',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message,
  })
  assert.ok((await viewport(vt)).some(line => line.includes('needle reasoning')), 'the regular search reveal is visible')
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  const overrides = (app as unknown as { expandedOverride: Map<object, boolean> }).expandedOverride
  assert.equal(overrides.get(message), true,
    'after F6 the regular surface has a per-card owner for the revealed Thinking and promotes it')
  assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'dismiss clears search presentation')
  app.stop()
})

test('dismiss promotion: generic assistant presentation has no durable expansion owner', async () => {
  const { vt, app } = startApp()
  const message: TranscriptMessage = { kind: 'assistant', turn: 0, text: 'needle assistant body' }
  app.setTranscript([message])
  app.setTranscriptSearchTarget({
    query: 'needle',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message,
  })
  await viewport(vt)
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await viewport(vt)
  const overrides = (app as unknown as { expandedOverride: Map<object, boolean> }).expandedOverride
  assert.notEqual(overrides.get(message), true, 'generic assistant search presentation is not made durable')
  assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'dismiss clears search presentation')
  app.stop()
})

test('navigation: a two-level PTC path reveals the grandchild body', async () => {
  const grandchild: TranscriptToolMessage = {
    kind: 'tool', turn: 0, name: 'bash', args: '{}', result: 'deepest-needle output', status: 'ok',
    subCallId: 'grand-1', parentCallId: 'child-1', rootCallId: 'root-1',
  }
  const child: TranscriptToolMessage = {
    kind: 'tool', turn: 0, name: 'bash', args: '{}', result: 'child output', status: 'ok',
    subCalls: [grandchild], subCallId: 'child-1', parentCallId: 'root-1', rootCallId: 'root-1',
  }
  const root: TranscriptToolMessage = {
    kind: 'tool', turn: 0, name: 'run_code', args: '{}', result: 'ok', status: 'ok', subCalls: [child],
  }
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript([root])
  app.setTranscriptSearchTarget({
    query: 'deepest-needle',
    match: {
      id: 0, turn: 0, occurrence: 0,
      source: { kind: 'subcall-field', subCallIds: ['child-1', 'grand-1'], field: 'result' },
      sourceOccurrence: 0,
    },
    message: root,
  })
  const view = (await viewport(vt)).join('\n')
  assert.ok(view.includes('deepest-needle output'), `the grandchild body must be visible:\n${view}`)
  app.stop()
})

test('navigation: every visible matching card is weak-highlighted, the current card strong', async () => {
  const { vt, app } = startApp()
  // The current card needs a PROVABLE source: a Workflow member label.
  const a = {
    kind: 'workflow', turn: 0, runId: 'run-1' as never, name: 'audit', status: 'running',
    members: [{ seq: 0, label: 'alpha needle one', phase: 'P', childId: 'child-0' as never, status: 'running' }],
  } as Extract<TranscriptMessage, { kind: 'workflow' }>
  const b: TranscriptMessage = { kind: 'user', turn: 1, text: 'beta needle two' }
  const c: TranscriptMessage = { kind: 'user', turn: 2, text: 'gamma without the term' }
  app.setFullscreen(true)
  app.setTranscript([a, b, c])
  // The runner publishes the semantic match representatives (deduped cards).
  app.setSearchMatchMessages(new Set([a, b]))
  app.setTranscriptSearchTarget({
    query: 'needle',
    match: {
      id: 0, turn: 0, occurrence: 0,
      normalizedSourceRange: { start: 6, end: 12 },
      source: { kind: 'workflow-member', phaseKey: workflowPhaseKey('P'), seq: 0, field: 'label' },
      sourceOccurrence: 0,
    },
    message: a,
  })
  const lines = await viewport(vt)
  const aRow = lines.findIndex(line => line.includes('alpha needle one') && line.includes('—'))
  const bRow = lines.findIndex(line => line.includes('beta needle two'))
  const cRow = lines.findIndex(line => line.includes('gamma without the term'))
  assert.ok(aRow >= 0 && bRow >= 0 && cRow >= 0, `all cards visible:\n${lines.join('\n')}`)
  const aCol = lines[aRow]!.indexOf('needle')
  const bCol = lines[bRow]!.indexOf('needle')
  assert.equal(vt.getCellBgRgb(aRow, aCol), 0xf5c542, 'the target occurrence is strong (themed block)')
  assert.ok(vt.getCellUnderline(bRow, bCol), 'the other VISIBLE matching card is weak (underline)')
  assert.notEqual(vt.getCellBgRgb(bRow, bCol), 0xf5c542, 'the other matching card is not strong')
  assert.ok(!vt.getCellUnderline(cRow, lines[cRow]!.indexOf('gamma')), 'a non-matching card is untouched')
  app.stop()
})

test('navigation: a live group reflow keeps the current highlight via stable-match rebind', async () => {
  // Post-F6 PR B: groups never cross turns, so the object-replacing reflow
  // is exercised WITHIN one turn — a late-settling pending read in the
  // middle of a run rebuilds the group card object while the search match
  // id/source stay stable.
  const event = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
    ({ type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent)
  const readCall = (seq: number, callId: string, file: string, turn: number): SessionEvent =>
    event('tool/call', { turn, step: 0, callId: ToolCallId(callId), name: 'read', arguments: JSON.stringify({ file }) }, seq)
  const readResult = (seq: number, callId: string, text: string, turn: number): SessionEvent =>
    event('tool/result', {
      turn, step: 0,
      message: {
        id: MessageId(`m-${seq}`), role: 'tool',
        toolCallId: ToolCallId(callId),
        content: [{ type: 'text', text }],
        source: { kind: 'tool', callId: ToolCallId(callId) },
      },
    }, seq)

  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    readCall(1, 'r1', 'src/a.ts', 0),
    readResult(2, 'r1', 'shared token A', 0),
    readCall(3, 'r2', 'src/b.ts', 0),
    readResult(4, 'r2', 'shared token B', 0),
  ])
  const project = () => folder.window({ maxTurns: 50 })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript(project().messages, folder.turnActivities())
  // 'read' renders in the merged read head as the tool NAME — a direct
  // projection, so it is a provable occurrence (the read result body itself
  // needs a presenter).
  const match = folder.search('read').find(m => m.source.kind === 'tool-field' && m.source.field === 'name')!
  const message = folder.resolveSearchMatch(match)!
  app.setTranscriptSearchTarget({ query: 'read', match, message })
  let lines = await viewport(vt)
  let row = lines.findIndex(line => line.includes('Read 2 files'))
  assert.ok(row >= 0 && vt.getCellUnderline(row, lines[row]!.indexOf('Read')), 'precondition: the target card is decorated (anchor-only source)')

  // A pending read parks between the group and a settled tail read; when it
  // settles IN PLACE (non-tail) the run reflows and the representative card
  // OBJECT is replaced, while match.id/source stay stable.
  folder.apply([
    readCall(5, 'r3', 'src/c.ts', 0),
    readCall(6, 'r4', 'src/d.ts', 0),
    readResult(7, 'r4', 'shared token D', 0),
    readResult(8, 'r3', 'shared token C', 0),
  ])
  app.setTranscript(project().messages, folder.turnActivities())
  // The runner's per-repaint sync (stable match → current card object).
  app.rebindTranscriptSearchTarget(folder.resolveSearchMatch(match))

  lines = await viewport(vt)
  row = lines.findIndex(line => line.includes('Read 4 files'))
  assert.ok(row >= 0, `the reflowed group card is visible:\n${lines.join('\n')}`)
  // The rebind re-attached the presentation to the NEW card object: without it
  // the card would not even be decorated (identity would not match).
  assert.ok(vt.getCellUnderline(row, lines[row]!.indexOf('Read')), 'the rebind keeps the reflowed card decorated')
  assert.ok(!isStrongCell(vt, row, lines[row]!.indexOf('Read')), 'a tool name/args source stays anchor-only (no guessed strong)')
  app.stop()
})

test('navigation: tool args and result hits are anchor-only (no guessed strong)', async () => {
  const event = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
    ({ type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent)
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('c1'), name: 'bash', arguments: JSON.stringify({ command: 'echo needle' }) }, 1),
    event('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('r1'), role: 'tool',
        toolCallId: ToolCallId('c1'),
        content: [{ type: 'text', text: 'needle output' }],
        source: { kind: 'tool', callId: ToolCallId('c1') },
      },
    }, 2),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 3),
  ])
  const matches = folder.search('needle')
  const argsMatch = matches.find(m => m.source.kind === 'tool-field' && m.source.field === 'args')
  const resultMatch = matches.find(m => m.source.kind === 'tool-field' && m.source.field === 'result')
  assert.ok(argsMatch !== undefined && resultMatch !== undefined, `both field hits expected: ${JSON.stringify(matches)}`)

  const { vt, app } = startApp()
  app.setFullscreen(true)
  const messages = folder.window({ maxTurns: 50 }).messages
  app.setTranscript(messages, folder.turnActivities())
  const card = messages[0]!

  app.setTranscriptSearchTarget({ query: 'needle', match: argsMatch, message: card })
  let lines = await viewport(vt)
  const headerRow = lines.findIndex(line => line.includes('Bash'))
  assert.ok(headerRow >= 0, `tool header must render:\n${lines.join('\n')}`)
  // The rendered args summary is a presenter projection of the raw args, so it
  // anchors WITHOUT a strong highlight (a raw ordinal cannot be proven).
  assert.ok(!isStrongCell(vt, headerRow, lines[headerRow]!.indexOf('needle')), 'the ARGS hit must not strong-highlight the summary')

  // A tool RESULT has no provable rendered occurrence either: it anchors with
  // no strong highlight, so it can never mislabel another occurrence as the
  // current N/M hit.
  app.setTranscriptSearchTarget({ query: 'needle', match: resultMatch, message: card })
  lines = await viewport(vt)
  const resultRow = lines.findIndex(line => line.includes('needle output'))
  assert.ok(resultRow >= 0, `tool result body must render:\n${lines.join('\n')}`)
  assert.ok(!isStrongCell(vt, resultRow, lines[resultRow]!.indexOf('needle')), 'the RESULT hit must NOT strong-highlight a guessed occurrence')
  assert.ok(!isStrongCell(vt, headerRow, lines[headerRow]!.indexOf('needle')), 'the args header is not current either')
  app.stop()
})

test('navigation: deliverable path and description hits are anchor-only', async () => {
  const event = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
    ({ type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent)
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 1 }, 0),
    event('deliverables/presented', { turn: 1, callId: 'present-1', files: [{ path: 'out/report.md', description: 'Final report' }] }, 1),
    event('assistant/message', {
      turn: 1, step: 0,
      message: {
        id: MessageId('a1'),
        role: 'assistant',
        content: [{ type: 'text', text: `earlier report\n${Array.from({ length: 18 }, (_, index) => `filler ${index}`).join('\n')}` }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, 2),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
  ])
  const matches = folder.search('report')
  const pathMatch = matches.find(m => m.source.kind === 'assistant-deliverable' && m.source.field === 'path')
  const descriptionMatch = matches.find(m => m.source.kind === 'assistant-deliverable' && m.source.field === 'description')
  assert.ok(pathMatch !== undefined && descriptionMatch !== undefined, `both deliverable fields must match: ${JSON.stringify(matches)}`)

  const { vt, app } = startApp(80, 12)
  app.setFullscreen(true)
  const card = folder.messages()[0]!
  app.setTranscript([card], folder.turnActivities())

  app.setTranscriptSearchTarget({ query: 'report', match: pathMatch, message: card })
  let lines = await viewport(vt)
  const pathRow = lines.findIndex(line => line.includes('report.md'))
  assert.ok(pathRow >= 0, `delivered path row missing:\n${lines.join('\n')}`)
  // The path is RELATIVIZED (raw prefix removed), so a raw ordinal cannot be
  // proven: anchor only, no strong highlight.
  assert.ok(!isStrongCell(vt, pathRow, lines[pathRow]!.indexOf('report')), 'the PATH hit must not strong-highlight a relativized path')

  app.setTranscriptSearchTarget({ query: 'report', match: descriptionMatch, message: card })
  app.scrollToSearchTarget()
  lines = await viewport(vt)
  const descriptionRow = lines.findIndex(line => line.includes('Final report'))
  assert.ok(descriptionRow >= 0, `deliverable description must be the viewport destination:\n${lines.join('\n')}`)
  assert.ok(!lines.some(line => line.includes('earlier report')),
    `the unrelated assistant-body hit must not be the viewport destination:\n${lines.join('\n')}`)
  assert.ok((app.fullscreenScrollForTest()?.scrollTop ?? 0) > 0, 'the source-local destination must be below the card top')
  const mounted = (app as unknown as {
    mountedTranscriptBlocks: ReadonlyArray<{
      block: { message?: TranscriptMessage }
      searchSelection?: { selectedIndex: number; exact: boolean }
    }>
  }).mountedTranscriptBlocks
  const selection = mounted.find(entry => entry.block.message === card)?.searchSelection
  assert.equal(selection?.selectedIndex, -1, 'source-region viewport targeting remains anchor-only')
  assert.equal(selection?.exact, false, 'source-region viewport targeting never proves provenance')
  assert.ok(!isStrongCell(vt, descriptionRow, lines[descriptionRow]!.indexOf('report')), 'the DESCRIPTION hit must not strong-highlight an approximate target')
  assert.ok(!isStrongCell(vt, pathRow, lines[pathRow]!.indexOf('report')), 'the path row is not the current occurrence')
  app.stop()
})

test('navigation: a PTC child result maps to its body, not the header or the root card', async () => {
  const event = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
    ({ type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent)
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('code-1'), name: 'run_code', arguments: JSON.stringify({ code: 'print(1)' }) }, 1),
    event('tool/ptc-dispatch-start', {
      rootCallId: ToolCallId('code-1'), parentCallId: ToolCallId('code-1'),
      subCallId: ToolCallId('child-1'), name: 'bash', arguments: { command: 'echo needle' },
    }, 2),
    event('tool/ptc-dispatch', {
      rootCallId: ToolCallId('code-1'), parentCallId: ToolCallId('code-1'),
      subCallId: ToolCallId('child-1'), name: 'bash', arguments: { command: 'echo needle' },
      isError: false, content: [{ type: 'text', text: 'needle in child result' }],
    }, 3),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4),
  ])
  const matches = folder.search('needle')
  const resultMatch = matches.find(m => m.source.kind === 'subcall-field' && m.source.field === 'result')
  assert.ok(resultMatch !== undefined, `child result hit expected: ${JSON.stringify(matches)}`)

  const { vt, app } = startApp()
  app.setFullscreen(true)
  const card = folder.messages()[0]!
  app.setTranscript([card], folder.turnActivities())
  app.setTranscriptSearchTarget({ query: 'needle', match: resultMatch, message: card })
  const lines = await viewport(vt)
  const bodyRow = lines.findIndex(line => line.includes('needle in child result'))
  assert.ok(bodyRow >= 0, `child result body must render:\n${lines.join('\n')}`)
  // Result lines are width-truncated, so a raw result ordinal is not provable:
  // the child body anchors without a guessed strong highlight.
  assert.ok(!isStrongCell(vt, bodyRow, lines[bodyRow]!.indexOf('needle')), 'the child RESULT hit must not strong-highlight a truncated body')
  const headerRow = lines.findIndex(line => line.includes('echo needle'))
  assert.ok(headerRow < 0 || !isStrongCell(vt, headerRow, lines[headerRow]!.indexOf('needle')), 'the header/command row is not the current occurrence')
  app.stop()
})

test('navigation: expanded Thinking proves the body, never the title chrome', async () => {
  const { folder, message } = thinkingMessageFolder('thinking about search')
  const match = folder.search('thinking').find(candidate => candidate.source.kind === 'message')
  assert.ok(match !== undefined, 'fixture: the reasoning body is the semantic source')
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript(folder.messages(), folder.turnActivities())
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: 'thinking', match, message },
    grantReveal: true,
  })
  app.scrollToSearchTarget()
  const lines = await viewport(vt)
  const headerRow = lines.findIndex(line => /Thinking/.test(line))
  assert.ok(headerRow >= 0, `thinking header must render:\n${lines.join('\n')}`)
  const titleColumn = columnOf(lines[headerRow]!, 'Thinking')
  assert.notEqual(vt.getCellBgRgb(headerRow, titleColumn), STRONG_BG, 'the injected Thinking title is not the body hit')
  assert.notEqual(vt.getCellBgRgb(headerRow, 0), ANCHOR_BG, 'an exact body proof never washes the title row')
  const bodyRow = lines.findIndex(line => line.includes('about search'))
  assert.ok(bodyRow >= 0, `thinking body must render:\n${lines.join('\n')}`)
  assert.equal(vt.getCellBgRgb(bodyRow, columnOf(lines[bodyRow]!, 'thinking')), STRONG_BG,
    'only the reasoning body occurrence is current')
  const selection = mountedSelectionFor(app, message)
  assert.equal(selection?.exact, true)
  assert.equal(selection?.selectedIndex, -1, 'the body proof does not guess a rendered title ordinal')
  assert.ok((selection?.exactPaintedSegments?.length ?? 0) > 0)
  assert.ok(selection!.exactPaintedSegments!.every(segment => segment.row >= 1),
    'the title row is excluded from the painted-cell channel')
  assert.equal(selection?.selectedRow, selection?.exactPaintedSegments?.[0]?.row)
  app.stop()
})

test('navigation: the bubble marker is never the proven User source cell', async () => {
  const { folder, message } = userMessageFolder('❯ body')
  const match = folder.search('❯')[0]
  assert.ok(match !== undefined)
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript([message], folder.turnActivities())
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: '❯', match, message },
    grantReveal: true,
  })
  const lines = await viewport(vt)
  const row = lines.findIndex(line => line.includes('body'))
  assert.ok(row >= 0, `user bubble must render:\n${lines.join('\n')}`)
  const markerColumn = columnOf(lines[row]!, '❯', 0)
  const sourceColumn = columnOf(lines[row]!, '❯', 1)
  assert.notEqual(vt.getCellBgRgb(row, markerColumn), STRONG_BG, 'the injected bubble marker is not the current occurrence')
  assert.equal(vt.getCellBgRgb(row, sourceColumn), STRONG_BG, 'the source occurrence cell is current')
  assert.equal(mountedSelectionFor(app, message)?.exact, true)
  app.stop()
})

test('navigation: an anchor-only mixed User card keeps the weaker row wash', async () => {
  const { vt, app } = startApp()
  const text = 'needle alpha needle beta'
  const message: TranscriptMessage = {
    kind: 'user',
    turn: 0,
    text,
    content: [
      { type: 'text', text },
      { type: 'image', attachment: { type: 'image', name: 'note.png' } },
    ] as ContentBlock[],
  }
  app.setFullscreen(true)
  app.setTranscript([message])
  app.setTranscriptSearchTarget({
    query: 'needle',
    match: {
      id: 0, turn: 0, occurrence: 0,
      normalizedSourceRange: { start: 0, end: 6 },
      source: { kind: 'message' },
      sourceOccurrence: 0,
    },
    message,
  })
  const lines = await viewport(vt)
  const cells = occurrenceCells(lines)
  // Mixed content has no single Host Text layout to witness, so this card
  // keeps the PR-A anchor: weak occurrences plus the weaker row wash.
  assert.ok(vt.getCellUnderline(cells.row, cells.first), 'the occurrence stays weak')
  assert.notEqual(vt.getCellBgRgb(cells.row, cells.first), STRONG_BG, 'mixed content never claims an exact cell')
  assert.equal(vt.getCellBgRgb(cells.row, 0), ANCHOR_BG, `the anchor row carries the weaker current wash:\n${lines.join('\n')}`)
  const selection = mountedSelectionFor(app, message)
  assert.equal(selection?.exact, false)
  assert.equal(selection?.selectedIndex, -1)
  assert.equal(selection?.exactPaintedSegments, undefined)
  app.stop()
})

test('navigation: the anchor wash never leaks past the anchor row', async () => {
  const { vt, app } = startApp()
  const message: TranscriptMessage = { kind: 'assistant', turn: 0, text: 'needle first\nplain second' }
  app.setFullscreen(true)
  app.setTranscript([message])
  app.setTranscriptSearchTarget({
    query: 'needle',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message,
  })
  const lines = await viewport(vt)
  const first = lines.findIndex(line => line.includes('needle first'))
  const second = lines.findIndex(line => line.includes('plain second'))
  assert.ok(first >= 0 && second >= 0, `both rows must render:\n${lines.join('\n')}`)
  assert.equal(vt.getCellBgRgb(first, 0), 0x3a3220, 'the anchor row is washed')
  // The background must have been RESET before the next row: no bleed.
  assert.notEqual(vt.getCellBgRgb(second, 0), 0x3a3220, 'the wash must not bleed into the following row')
  app.stop()
})

test('navigation: a narrow width still paints the exact current occurrence', async () => {
  const { vt, app } = startApp(40, 20)
  const card = {
    kind: 'workflow', turn: 0, runId: 'run-1' as never, name: 'audit', status: 'running',
    members: [{ seq: 0, label: 'needle alpha needle beta', phase: 'P', childId: 'child-0' as never, status: 'running' }],
  } as Extract<TranscriptMessage, { kind: 'workflow' }>
  app.setFullscreen(true)
  app.setTranscript([card])
  app.setTranscriptSearchTarget({
    query: 'needle',
    match: {
      id: 0, turn: 0, occurrence: 1,
      normalizedSourceRange: { start: 13, end: 19 },
      source: { kind: 'workflow-member', phaseKey: workflowPhaseKey('P'), seq: 0, field: 'label' },
      sourceOccurrence: 1,
    },
    message: card,
  })
  const lines = await viewport(vt)
  const cells = occurrenceCells(lines)
  assert.equal(vt.getCellBgRgb(cells.row, cells.first), undefined, 'the first occurrence is not current')
  assert.equal(vt.getCellBgRgb(cells.row, cells.second), 0xf5c542, 'the second occurrence is the exact current block at 40 cols')
  app.stop()
})

test('navigation: tool args and result anchor rows are visually distinct without a strong occurrence', async () => {
  const event = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
    ({ type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent)
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('tool/call', { turn: 0, step: 0, callId: ToolCallId('c1'), name: 'bash', arguments: JSON.stringify({ command: 'echo needle' }) }, 1),
    event('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('r1'), role: 'tool',
        toolCallId: ToolCallId('c1'),
        content: [{ type: 'text', text: 'needle output' }],
        source: { kind: 'tool', callId: ToolCallId('c1') },
      },
    }, 2),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 3),
  ])
  const matches = folder.search('needle')
  const resultMatch = matches.find(m => m.source.kind === 'tool-field' && m.source.field === 'result')!
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const messages = folder.window({ maxTurns: 50 }).messages
  app.setTranscript(messages, folder.turnActivities())
  app.setTranscriptSearchTarget({ query: 'needle', match: resultMatch, message: messages[0]! })
  const lines = await viewport(vt)
  const resultRow = lines.findIndex(line => line.includes('needle output'))
  assert.ok(resultRow >= 0, `tool result body must render:\n${lines.join('\n')}`)
  // Anchor-only: the occurrence never gets the exact block. The result field has
  // no renderer-proven region, so the selection anchors at the owning card top —
  // that row carries the weaker wash so the current N/M is still findable.
  assert.notEqual(vt.getCellBgRgb(resultRow, lines[resultRow]!.indexOf('needle')), 0xf5c542, 'the result hit is not a proven occurrence')
  const cardTop = lines.findIndex(line => line.includes('Bash'))
  assert.ok(cardTop >= 0, `tool card header missing:\n${lines.join('\n')}`)
  assert.equal(vt.getCellBgRgb(cardTop, 0), 0x3a3220, 'the owning card top carries the anchor wash')
  app.stop()
})

test('navigation: a deliverable description truncated on its row never strong-highlights a substituted occurrence', async () => {
  const event = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
    ({ type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent)
  // The description is one physical row with both ends preserved, so a match
  // in the ABBREVIATED middle is not rendered at all. The row is still
  // anchored to the RAW description region; it must never paint a guessed
  // strong occurrence at a cell the renderer did not derive.
  const description = `${'x'.repeat(120)} alpha beta alpha beta ${'y'.repeat(120)}`
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 1 }, 0),
    event('deliverables/presented', { turn: 1, callId: 'present-1', files: [{ path: 'out/report.md', description }] }, 1),
    event('assistant/message', {
      turn: 1, step: 0,
      message: { id: MessageId('a1'), role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [],
    }, 2),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
  ])
  const match = folder.search('alpha beta')[0]!
  assert.deepEqual(match.source, { kind: 'assistant-deliverable', index: 0, field: 'description' })

  const { vt, app } = startApp()
  app.setFullscreen(true)
  const card = folder.messages()[0]!
  app.setTranscript([card], folder.turnActivities())
  app.setTranscriptSearchTarget({ query: 'alpha beta', match, message: card })
  const lines = await viewport(vt)
  const pathRow = lines.findIndex(line => line.includes('report.md'))
  assert.ok(pathRow >= 0, `the delivered path row renders:\n${lines.join('\n')}`)
  const row = pathRow + 1
  assert.ok(lines[row]!.trimStart().startsWith('xxx'),
    `the description owns the NEXT row and keeps its head:\n${lines.join('\n')}`)
  assert.ok(!lines[row]!.includes('alpha'), `the middle match is abbreviated away, not rendered:\n${lines[row]}`)
  for (let col = 0; col < 90; col += 1) {
    assert.ok(!isStrongCell(vt, row, col), `no guessed strong cell at column ${col}`)
  }
  app.stop()
})

test('navigation: a truncated description keeps its full RAW source in the search corpus', async () => {
  const event = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
    ({ type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent)
  // The display is an abbreviation, never the search corpus: a token the row
  // cuts away from its middle is still found by the fold's own search
  // projection (M3 contract).
  const description = `${'a'.repeat(80)} needle-ghij ${'b'.repeat(80)}`
  const folder = new TranscriptFolder()
  folder.hydrate([
    event('turn/start', { turn: 1 }, 0),
    event('deliverables/presented', { turn: 1, callId: 'present-1', files: [{ path: 'out/report.md', description }] }, 1),
    event('assistant/message', {
      turn: 1, step: 0,
      message: { id: MessageId('a1'), role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [],
    }, 2),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
  ])
  const match = folder.search('needle-ghij')[0]!
  assert.deepEqual(match.source, { kind: 'assistant-deliverable', index: 0, field: 'description' })

  const { vt, app } = startApp()
  app.setFullscreen(true)
  const card = folder.messages()[0]!
  app.setTranscript([card], folder.turnActivities())
  app.setTranscriptSearchTarget({ query: 'needle-ghij', match, message: card })
  const lines = await viewport(vt)
  const pathRow = lines.findIndex(line => line.includes('report.md'))
  assert.ok(pathRow >= 0, `the delivered path row renders:\n${lines.join('\n')}`)
  const row = pathRow + 1
  assert.ok(lines[row]!.includes('a'.repeat(20)), `the description is painted on its own row:\n${lines.join('\n')}`)
  assert.ok(!lines[row]!.includes('needle-ghij'), `the row cuts the middle token away:\n${lines[row]}`)
  app.stop()
})

test('navigation: an explicit re-navigation re-opens a manually collapsed PTC sub-call', async () => {
  const grandchild: TranscriptToolMessage = {
    kind: 'tool', turn: 0, name: 'bash', args: '{}', result: 'deepest-needle output', status: 'ok',
    subCallId: 'grand-1', parentCallId: 'child-1', rootCallId: 'root-1',
  }
  const child: TranscriptToolMessage = {
    kind: 'tool', turn: 0, name: 'bash', args: '{}', result: 'child output', status: 'ok',
    subCalls: [grandchild], subCallId: 'child-1', parentCallId: 'root-1', rootCallId: 'root-1',
  }
  const root: TranscriptToolMessage = {
    kind: 'tool', turn: 0, name: 'run_code', args: '{}', result: 'ok', status: 'ok', subCalls: [child],
  }
  const { vt, app } = startApp(100, 30)
  app.setFullscreen(true)
  app.setTranscript([root])
  const target = () => ({
    query: 'deepest-needle',
    match: {
      id: 0, turn: 0, occurrence: 0,
      source: { kind: 'subcall-field' as const, subCallIds: ['child-1', 'grand-1'], field: 'result' as const },
      sourceOccurrence: 0,
    },
    message: root,
  })
  app.setTranscriptSearchTarget(target())
  let lines = await viewport(vt)
  const bodyRow = lines.findIndex(line => line.includes('deepest-needle output'))
  assert.ok(bodyRow > 0, `the reveal must open the grandchild body:\n${lines.join('\n')}`)

  // The USER manually collapses the grandchild by clicking its header. This adds
  // the sub-call to the search suppression set WITHOUT revoking the reveal grant.
  click(vt, 10, bodyRow)
  lines = await viewport(vt)
  assert.ok(!lines.some(line => line.includes('deepest-needle output')),
    `the manual collapse must hide the body:\n${lines.join('\n')}`)
  assert.equal(app.transcriptSearchPresentationForTest()?.revealGranted, true,
    'a PTC sub-call collapse keeps the reveal grant (plan §7.5)')

  // Dismissing after the manual collapse must NOT promote that suppressed path
  // into durable disclosure, but it must clear the presentation atomically.
  app.resetSearchPresentationDiagnosticsForTest()
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  lines = await viewport(vt)
  const subCallExpanded = (app as unknown as { subCallExpanded: Set<string> }).subCallExpanded
  assert.equal(subCallExpanded.has('grand-1'), false, 'a manually collapsed PTC child is not promoted on dismiss')
  assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'dismiss clears the search target')
  assert.equal(app.searchPresentationDiagnosticsForTest().rebuilds, 1, 'dismiss clears presentation in one rebuild')
  assert.ok(!lines.some(line => line.includes('deepest-needle output')),
    `the suppressed child stays collapsed after dismiss:\n${lines.join('\n')}`)

  // An explicit navigation that wraps to the SAME semantic target must still
  // re-open the sub-call (plan §10.4: only the next explicit Next/Prev re-reveals).
  app.setTranscriptSearchTarget(target())
  lines = await viewport(vt)
  assert.ok(lines.some(line => line.includes('deepest-needle output')),
    `an explicit re-navigation must re-open the collapsed sub-call:\n${lines.join('\n')}`)
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  lines = await viewport(vt)
  assert.equal(subCallExpanded.has('child-1'), true, 'the ancestor child is promoted on dismiss')
  assert.equal(subCallExpanded.has('grand-1'), true, 'the current PTC child is promoted on dismiss')
  assert.ok(lines.some(line => line.includes('deepest-needle output')),
    `a non-suppressed search reveal stays open after dismiss:\n${lines.join('\n')}`)
  app.stop()
})


// ── a published visual Assistant keeps rendered search geometry ───────────

function searchChartPublication(ref: string): PublishedVisual {
  return {
    ref, turn: 0, step: 1, stepStartSeq: 5, callSeq: 6, resultSeq: 7, callId: 'present-search',
    source: {
      ref, type: 'chart', title: 'Search latency', turn: 0, step: 0, stepStartSeq: 1, callSeq: 2, resultSeq: 3, callId: 'chart-search',
      chart: { version: 1, type: 'chart', kind: 'bars', title: 'Search latency', unit: 'ms', series: [{ label: 'p50', value: 42 }] },
      svg: undefined, svgSource: undefined, svgAdmissionWidth: undefined,
    },
  }
}

function visualAnswerFolder(ref: string, text: string): {
  folder: TranscriptFolder
  assistant: Extract<TranscriptMessage, { kind: 'assistant' }>
} {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } } as unknown as SessionEvent,
    {
      type: 'assistant/message',
      seq: 1,
      time: 2,
      data: {
        turn: 0,
        step: 0,
        message: {
          id: MessageId('search-visual'),
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    } as unknown as SessionEvent,
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 0, reason: { kind: 'completed' } } } as unknown as SessionEvent,
  ])
  const assistant = folder.messages().find(
    (message): message is Extract<TranscriptMessage, { kind: 'assistant' }> => message.kind === 'assistant',
  )
  assert.ok(assistant !== undefined)
  setAssistantVisualPresentation(assistant, {
    subjectKind: 'main', subjectId: 'search', sourceIdentity: {}, session: {}, sessionId: 'search',
    turn: 0, step: 0, text: assistant.text, content: undefined, assistantRevision: 0,
  }, [searchChartPublication(ref)])
  return { folder, assistant }
}

test('search after an inline figure highlights the rendered answer row', async () => {
  const ref = `sv2_${'f'.repeat(20)}`
  const marker = `[dsh-visual-${ref}]: <#>`
  const { folder, assistant } = visualAnswerFolder(ref, `Before figure.\n\n${marker}\n\nAfter needle.`)
  const { vt, app } = startApp()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  app.setTranscriptSearchTarget({
    query: 'needle',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: assistant,
  })
  const lines = await viewport(vt)
  const row = lines.findIndex(line => line.includes('After needle.'))
  assert.ok(row >= 0, `the searched answer row is visible:\n${lines.join('\n')}`)
  const col = lines[row]!.indexOf('needle')
  assert.ok(vt.getCellUnderline(row, col), 'the rendered occurrence is weak-highlighted')
  assert.equal(vt.getCellBgRgb(row, col), undefined, 'a message-source occurrence is never falsely exact')
  app.stop()
})

test('a search that only matches a consumed marker line paints no false anchor', async () => {
  const ref = `sv2_${'f'.repeat(20)}`
  const marker = `[dsh-visual-${ref}]: <#>`
  const { folder, assistant } = visualAnswerFolder(ref, `Before figure.\n\n${marker}\n\nAfter.`)
  const { vt, app } = startApp()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  app.setTranscriptSearchTarget({
    query: `dsh-visual-${ref}`,
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: assistant,
  })
  const lines = await viewport(vt)
  const row = lines.findIndex(line => line.includes('Before figure.'))
  assert.ok(row >= 0, `the answer remains visible:\n${lines.join('\n')}`)
  const col = lines[row]!.indexOf('Before figure.')
  assert.equal(vt.getCellBgRgb(row, col), undefined, 'no anchor wash for a hidden marker-only match')
  assert.equal(vt.getCellUnderline(row, col), false, 'no false occurrence highlight')
  app.stop()
})


test('navigation: a consumed Visual marker is Source-only no-visible-cell, never a homonym', async () => {
  const ref = `sv2_${'f'.repeat(20)}`
  const marker = `[dsh-visual-${ref}]: <#>`
  const { folder, assistant } = visualAnswerFolder(ref, `Before figure.\n\n${marker}\n\nAfter body.`)
  const { vt, app } = startApp(100, 30)
  app.setFullscreen(true)
  app.setTranscript([assistant], folder.turnActivities())
  await viewport(vt)
  app.startTranscriptSearch('full')
  await viewport(vt)
  app.setTranscriptSearchTarget({
    query: `dsh-visual-${ref}`,
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: assistant,
  })
  const lines = await viewport(vt)
  const row = lines.findIndex(line => line.includes('Before figure.'))
  assert.ok(row >= 0, `the answer remains visible:\n${lines.join('\n')}`)
  assert.equal(mountedSelectionFor(app, assistant), undefined,
    'the consumed marker owns no search selection and no fabricated visual row')
  assert.deepEqual(app.currentFullSearchNotice(), { kind: 'not-painted', sourceLabel: 'Assistant text' },
    'the consumed marker is real evidence of "no visible cell", not a same-named text match')
  const frame = lines.map(line => stripTerminalSequences(line))
  assert.ok(frame.some(line => line.includes('Source-only') && line.includes('no visible cell')),
    `the honest Source-only row is painted:\n${frame.join('\n')}`)
  assert.ok(!frame.some(line => line.includes(`dsh-visual-${ref}`)), 'the raw marker never leaks')
  app.stop()
})

test('a visual Assistant keeps the search anchor for a folded delivered-file target', async () => {
  const ref = `sv2_${'f'.repeat(20)}`
  const files = Array.from({ length: 6 }, (_, index) => ({
    path: `out/visible-${index}.md`,
    description: `Visible report ${index}`,
  }))
  files[5] = { path: 'out/hidden-target.md', description: 'Hidden delivered target' }
  const folder = new TranscriptFolder()
  folder.hydrate([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as unknown as SessionEvent,
    {
      type: 'deliverables/presented',
      seq: 1,
      time: 2,
      data: { turn: 1, callId: 'present-1', files },
    } as unknown as SessionEvent,
    {
      type: 'assistant/message',
      seq: 2,
      time: 3,
      data: {
        turn: 1,
        step: 0,
        message: {
          id: MessageId('visual-deliverable-search'),
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    } as unknown as SessionEvent,
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } } as unknown as SessionEvent,
  ])
  const card = folder.messages().find(
    (message): message is Extract<TranscriptMessage, { kind: 'assistant' }> => message.kind === 'assistant',
  )
  assert.ok(card !== undefined)
  setAssistantVisualPresentation(card, {
    subjectKind: 'main', subjectId: 'deliverable-search', sourceIdentity: {}, session: {}, sessionId: 'deliverable-search',
    turn: 1, step: 0, text: card.text, content: undefined, assistantRevision: 0,
  }, [searchChartPublication(ref)])
  const match = folder.search('hidden-target').find(candidate => candidate.source.kind === 'assistant-deliverable')
  assert.ok(match !== undefined, 'the hidden delivered path is in the raw search corpus')
  assert.deepEqual(match.source, { kind: 'assistant-deliverable', index: 5, field: 'path' })

  const { vt, app } = startApp(100, 24)
  app.setFullscreen(true)
  app.setTranscript([card], folder.turnActivities())
  await vt.waitForRender()
  assert.ok(assistantVisualPresentation(card) !== undefined, 'precondition: the Answer has a visual sidecar')
  // A PASSIVE rebind does not grant the temporary reveal, so the folded tail
  // stays closed and the hidden path has no rendered occurrence. The target is
  // still a legitimate semantic hit and must keep its anchor selection.
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([card]),
    target: { query: 'hidden-target', match, message: card },
    grantReveal: false,
  })
  const lines = await viewport(vt)
  assert.ok(!lines.some(line => line.includes('hidden-target.md')),
    `precondition: the folded tail hides the target:\n${lines.join('\n')}`)
  const mounted = (app as unknown as {
    mountedTranscriptBlocks: ReadonlyArray<{
      block: { message?: TranscriptMessage }
      searchSelection?: { selectedIndex: number; exact: boolean }
    }>
  }).mountedTranscriptBlocks
  const selection = mounted.find(entry => entry.block.message === card)?.searchSelection
  assert.ok(selection !== undefined,
    'a delivered-file target keeps its anchor selection; only a consumed-marker message target is suppressed')
  assert.equal(selection.exact, false, 'the deliverable target remains anchor-only')
  app.stop()
})

test('a message target below an inline figure stays at the card anchor without provenance', async () => {
  const ref = `sv2_${'f'.repeat(20)}`
  const marker = `[dsh-visual-${ref}]: <#>`
  const filler = Array.from({ length: 30 }, (_, index) => `filler line ${index}`).join('\n')
  const { folder, assistant } = visualAnswerFolder(ref, `Before figure.\n\n${marker}\n\n${filler}\n\nAfter needle.`)
  const { vt, app } = startApp(80, 12)
  app.setFullscreen(true)
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  app.setTranscriptSearchTarget({
    query: 'needle',
    match: folder.search('needle').find(match => match.source.kind === 'message')!,
    message: assistant,
  })
  app.scrollToSearchTarget()
  const lines = await viewport(vt)
  assert.ok(!lines.some(line => line.includes('After needle.')),
    `a message source without cell provenance does not guess the row after the figure:\n${lines.join('\n')}`)
  assert.equal(app.fullscreenScrollForTest()?.scrollTop, 0, 'the inexact message source stays at the card top')
  const mounted = (app as unknown as {
    mountedTranscriptBlocks: ReadonlyArray<{ block: { message?: TranscriptMessage }; searchSelection?: { selectedIndex: number; exact: boolean; selectedRow?: number } }>
  }).mountedTranscriptBlocks
  const selection = mounted.find(entry => entry.block.message === assistant)?.searchSelection
  assert.equal(selection?.selectedIndex, -1)
  assert.equal(selection?.exact, false)
  assert.equal(selection?.selectedRow, 0)
  app.stop()
})


test('a message target crossing a non-text block keeps its search anchor', async () => {
  const ref = `sv2_${'f'.repeat(20)}`
  const content = [
    { type: 'text' as const, text: 'cross-' },
    { type: 'image' as const, attachment: { type: 'image' as const, name: 'middle.png' } },
    { type: 'text' as const, text: 'block' },
  ] as ContentBlock[]
  const folder = new TranscriptFolder()
  folder.hydrate([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } } as unknown as SessionEvent,
    {
      type: 'assistant/message',
      seq: 1,
      time: 2,
      data: {
        turn: 0,
        step: 0,
        message: {
          id: MessageId('cross-block-search'),
          role: 'assistant',
          content,
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    } as unknown as SessionEvent,
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 0, reason: { kind: 'completed' } } } as unknown as SessionEvent,
  ])
  const card = folder.messages().find(
    (message): message is Extract<TranscriptMessage, { kind: 'assistant' }> => message.kind === 'assistant',
  )
  assert.ok(card !== undefined)
  assert.equal(card.text, 'cross-block', 'the raw corpus concatenates text blocks without a separator')
  setAssistantVisualPresentation(card, {
    subjectKind: 'main', subjectId: 'cross-block-search', sourceIdentity: {}, session: {}, sessionId: 'cross-block-search',
    turn: 0, step: 0, text: card.text, content: card.content, assistantRevision: 0,
  }, [searchChartPublication(ref)])
  const match = folder.search('cross-block').find(candidate => candidate.source.kind === 'message')
  assert.ok(match !== undefined, 'the raw message corpus has the cross-block hit')

  const { vt, app } = startApp(100, 24)
  app.setTranscript([card], folder.turnActivities())
  await vt.waitForRender()
  const plain = (await viewport(vt)).join('\n')
  assert.ok(!plain.includes('cross-block'),
    `precondition: the image block breaks the rendered contiguous text:\n${plain}`)
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([card]),
    target: { query: 'cross-block', match, message: card },
    grantReveal: false,
  })
  const mounted = (app as unknown as {
    mountedTranscriptBlocks: ReadonlyArray<{
      block: { message?: TranscriptMessage }
      searchSelection?: { selectedIndex: number; exact: boolean }
    }>
  }).mountedTranscriptBlocks
  const selection = mounted.find(entry => entry.block.message === card)?.searchSelection
  assert.ok(selection !== undefined,
    'a legitimate message hit crossing a non-text block must keep its anchor; only hidden-marker-only hits are suppressed')
  app.stop()
})


// --- A folded same-turn Agent relay is searchable through its Work owner -----

function relayEvent(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

/** A real Compact transcript: Process -> qualified same-turn Agent relay ->
 * Process, so the relay is a Work member (never a standalone row). */
function foldedRelayFolder(): { folder: TranscriptFolder; relay: TranscriptMessage } {
  const relayMessage = {
    id: MessageId('search-folded-relay'), role: 'user',
    content: [{ type: 'text', text: 'FOLDED_RELAY_PAYLOAD with the needle inside' }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-search-child' },
  }
  const folder = new TranscriptFolder()
  folder.apply([
    relayEvent('turn/start', { turn: 0 }, 0),
    relayEvent('tool/call', { turn: 0, step: 0, callId: ToolCallId('search-relay-c1'), name: 'read', arguments: '{}' }, 1),
    relayEvent('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('search-relay-r1'), role: 'tool', toolCallId: ToolCallId('search-relay-c1'),
        content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: ToolCallId('search-relay-c1') },
      },
    }, 2),
    relayEvent('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [relayMessage] }, 3),
    relayEvent('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 4),
    relayEvent('user/message', relayMessage, 5),
    relayEvent('tool/call', { turn: 0, step: 1, callId: ToolCallId('search-relay-c2'), name: 'bash', arguments: '{}' }, 6),
    relayEvent('tool/result', {
      turn: 0, step: 1,
      message: {
        id: MessageId('search-relay-r2'), role: 'tool', toolCallId: ToolCallId('search-relay-c2'),
        content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: ToolCallId('search-relay-c2') },
      },
    }, 7),
    relayEvent('assistant/message', {
      turn: 0, step: 2,
      message: { id: MessageId('search-relay-final'), role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 8),
    relayEvent('turn/end', { turn: 0, reason: { kind: 'completed' } }, 9),
  ])
  const relay = folder.messages().find(message => message.kind === 'system' && message.text.includes('FOLDED_RELAY_PAYLOAD'))
  assert.ok(relay !== undefined && relay.kind === 'system')
  assert.equal(relay.contextPresentation?.sameTurnNextStep, true, 'fixture: the relay is a proven Work member')
  return { folder, relay }
}

function startCompactApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'compact' },
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

test('search reveals a folded same-turn Agent relay through its Work owner and dismissal restores the fold', async () => {
  const { folder, relay } = foldedRelayFolder()
  const { vt, app } = startCompactApp()
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  assert.ok(!view().includes('FOLDED_RELAY_PAYLOAD'),
    `precondition: the Work folds the relay while collapsed:\n${view()}`)

  app.setTranscriptSearchTarget({
    query: 'FOLDED_RELAY_PAYLOAD',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: relay,
  })
  assert.equal(app.transcriptSearchPresentationForTest()?.revealGranted, true,
    'the folded relay resolves a Work reveal')
  app.scrollToSearchTarget()
  await vt.waitForRender()
  assert.ok(view().includes('FOLDED_RELAY_PAYLOAD'),
    `the reveal opens the owning Work and locates the relay body:\n${view()}`)

  app.finishTranscriptSearchPresentation(new Set())
  await vt.waitForRender()
  assert.ok(!view().includes('FOLDED_RELAY_PAYLOAD'),
    `dismissal restores the folded Work instead of permanently expanding the turn:\n${view()}`)
  assert.ok(view().includes('Activity') || view().includes('Thought'),
    'the Work/Activity header remains the collapsed presentation')
  app.stop()
})

test('search reveals a relay folded inside a Focus Thought and dismissal restores the collapsed Thought', async () => {
  const { folder, relay } = foldedRelayFolder()
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'focus' },
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  assert.ok(!view().includes('FOLDED_RELAY_PAYLOAD'), `precondition: the Thought hides the relay:\n${view()}`)
  assert.equal(app.focusExpandedTurnsForTest().size, 0)

  app.setTranscriptSearchTarget({
    query: 'FOLDED_RELAY_PAYLOAD',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: relay,
  })
  app.scrollToSearchTarget()
  await vt.waitForRender()
  assert.ok(view().includes('FOLDED_RELAY_PAYLOAD'), `the reveal opens the Thought and locates the relay:\n${view()}`)

  app.finishTranscriptSearchPresentation(new Set())
  await vt.waitForRender()
  assert.ok(!view().includes('FOLDED_RELAY_PAYLOAD'), `dismissal restores the collapsed Thought:\n${view()}`)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'no permanent manual Thought expansion is left behind')
  app.stop()
})

// --- A folded same-turn subagent settlement is searchable through its Work owner ---

/** A real Compact transcript: Process -> qualified same-turn subagent
 * settlement -> Process, so the settlement is a Work member (never a
 * standalone row). */
function foldedSettledFolder(): { folder: TranscriptFolder; settled: TranscriptMessage } {
  const settledMessage = {
    id: MessageId('search-folded-settled'), role: 'user',
    content: [{ type: 'text', text: 'FOLDED_SETTLED_PAYLOAD with the needle inside' }],
    source: { kind: 'subagent-settled', form: 'notice', summary: 'child completed', senderSessionId: 'session-search-child' },
  }
  const folder = new TranscriptFolder()
  folder.apply([
    relayEvent('turn/start', { turn: 0 }, 0),
    relayEvent('tool/call', { turn: 0, step: 0, callId: ToolCallId('search-settled-c1'), name: 'read', arguments: '{}' }, 1),
    relayEvent('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('search-settled-r1'), role: 'tool', toolCallId: ToolCallId('search-settled-c1'),
        content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: ToolCallId('search-settled-c1') },
      },
    }, 2),
    relayEvent('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [settledMessage] }, 3),
    relayEvent('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 4),
    relayEvent('user/message', settledMessage, 5),
    relayEvent('tool/call', { turn: 0, step: 1, callId: ToolCallId('search-settled-c2'), name: 'bash', arguments: '{}' }, 6),
    relayEvent('tool/result', {
      turn: 0, step: 1,
      message: {
        id: MessageId('search-settled-r2'), role: 'tool', toolCallId: ToolCallId('search-settled-c2'),
        content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: ToolCallId('search-settled-c2') },
      },
    }, 7),
    relayEvent('assistant/message', {
      turn: 0, step: 2,
      message: { id: MessageId('search-settled-final'), role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 8),
    relayEvent('turn/end', { turn: 0, reason: { kind: 'completed' } }, 9),
  ])
  const settled = folder.messages().find(message => message.kind === 'system' && message.text.includes('FOLDED_SETTLED_PAYLOAD'))
  assert.ok(settled !== undefined && settled.kind === 'system')
  assert.equal(settled.contextPresentation?.sameTurnNextStep, true, 'fixture: the settlement is a proven Work member')
  return { folder, settled }
}

test('search reveals a folded same-turn subagent settlement through its Work owner and dismissal restores the fold', async () => {
  const { folder, settled } = foldedSettledFolder()
  const { vt, app } = startCompactApp()
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  assert.ok(!view().includes('FOLDED_SETTLED_PAYLOAD'),
    `precondition: the Work folds the settlement while collapsed:\n${view()}`)

  app.setTranscriptSearchTarget({
    query: 'FOLDED_SETTLED_PAYLOAD',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: settled,
  })
  assert.equal(app.transcriptSearchPresentationForTest()?.revealGranted, true,
    'the folded settlement resolves a Work reveal')
  app.scrollToSearchTarget()
  await vt.waitForRender()
  assert.ok(view().includes('FOLDED_SETTLED_PAYLOAD'),
    `the reveal opens the owning Work and locates the settlement body:\n${view()}`)

  app.finishTranscriptSearchPresentation(new Set())
  await vt.waitForRender()
  assert.ok(!view().includes('FOLDED_SETTLED_PAYLOAD'),
    `dismissal restores the folded Work instead of permanently expanding the turn:\n${view()}`)
  assert.ok(view().includes('Activity') || view().includes('Thought'),
    'the Work/Activity header remains the collapsed presentation')
  app.stop()
})

test('search reveals a settlement folded inside a Focus Thought and dismissal restores the collapsed Thought', async () => {
  const { folder, settled } = foldedSettledFolder()
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    displayState: { preset: 'focus' },
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  assert.ok(!view().includes('FOLDED_SETTLED_PAYLOAD'), `precondition: the Thought hides the settlement:\n${view()}`)
  assert.equal(app.focusExpandedTurnsForTest().size, 0)

  app.setTranscriptSearchTarget({
    query: 'FOLDED_SETTLED_PAYLOAD',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: settled,
  })
  app.scrollToSearchTarget()
  await vt.waitForRender()
  assert.ok(view().includes('FOLDED_SETTLED_PAYLOAD'), `the reveal opens the Thought and locates the settlement:\n${view()}`)

  app.finishTranscriptSearchPresentation(new Set())
  await vt.waitForRender()
  assert.ok(!view().includes('FOLDED_SETTLED_PAYLOAD'), `dismissal restores the collapsed Thought:\n${view()}`)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'no permanent manual Thought expansion is left behind')
  app.stop()
})

// ── PR-B: plain-text source-to-cell proof at real widths ───────────────────

/** Every viewport cell where a visible `needle` starts and carries the strong
 * block. Ambiguity-free: the caller compares the count and the row. */
function strongNeedleStarts(vt: VirtualTerminal, lines: readonly string[]): Array<{ row: number; column: number }> {
  const starts: Array<{ row: number; column: number }> = []
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row]!
    for (let index = line.indexOf('needle'); index >= 0; index = line.indexOf('needle', index + 'needle'.length)) {
      const column = visibleWidth(line.slice(0, index))
      if (vt.getCellBgRgb(row, column) === STRONG_BG) starts.push({ row, column })
    }
  }
  return starts
}

test('navigation: proven User cells hold across standard and wrapped widths', async () => {
  const text = 'needle alpha needle'
  const { folder, message } = userMessageFolder(text)
  const matches = folder.search('needle')
  assert.equal(matches.length, 2)
  const { vt, app } = startApp(160, 30)
  app.setFullscreen(true)
  app.setTranscript([message], folder.turnActivities())
  await viewport(vt)
  for (const width of [160, 100, 80, 20]) {
    vt.resize(width, 30)
    await viewport(vt)
    app.setTranscriptSearchPresentation({
      matchMessages: new Set([message]),
      target: { query: 'needle', match: matches[1]!, message },
      grantReveal: true,
    })
    app.scrollToSearchTarget()
    const lines = await viewport(vt)
    const strong = strongNeedleStarts(vt, lines)
    assert.equal(strong.length, 1, `width ${width}: exactly ONE occurrence is current:\n${lines.join('\n')}`)
    const selection = mountedSelectionFor(app, message)
    assert.equal(selection?.exact, true, `width ${width}: the source hit is proven`)
    assert.ok((selection?.exactPaintedSegments?.length ?? 0) > 0, `width ${width}: painted cells exist`)
    if (width !== 20) {
      const row = strong[0]!.row
      const first = columnOf(lines[row]!, 'needle', 0)
      assert.ok(strong[0]!.column > first, `width ${width}: the SECOND occurrence is current, not the first`)
    }
  }
  app.stop()
})

test('navigation: a very narrow User bubble still proves its wrapped cell', async () => {
  const { folder, message } = userMessageFolder('needle alpha beta')
  const match = folder.search('needle')[0]
  assert.ok(match !== undefined)
  const { vt, app } = startApp(12, 24)
  app.setFullscreen(true)
  app.setTranscript([message], folder.turnActivities())
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: 'needle', match, message },
    grantReveal: true,
  })
  app.scrollToSearchTarget()
  const lines = await viewport(vt)
  const row = lines.findIndex(line => line.includes('needle'))
  assert.ok(row >= 0, `the wrapped source is visible at 12 columns:\n${lines.join('\n')}`)
  assert.equal(vt.getCellBgRgb(row, columnOf(lines[row]!, 'needle')), STRONG_BG)
  const selection = mountedSelectionFor(app, message)
  assert.equal(selection?.exact, true)
  assert.equal(selection?.selectedRow, selection?.exactPaintedSegments?.[0]?.row)
  app.stop()
})

test('navigation: wide CJK and ZWJ emoji User cells map to terminal columns', async () => {
  const text = '检索 目标词\n👩‍👩‍👦 needle\n检索 tail'
  const { folder, message } = userMessageFolder(text)
  const cjk = folder.search('检索')
  const emoji = folder.search('👩‍👩‍👦')
  assert.equal(cjk.length, 2, 'the authoritative corpus has two CJK occurrences')
  assert.equal(emoji.length, 1)
  const { vt, app } = startApp(60, 30)
  app.setFullscreen(true)
  app.setTranscript([message], folder.turnActivities())

  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: '检索', match: cjk[1]!, message },
    grantReveal: true,
  })
  let lines = await viewport(vt)
  let row = lines.findIndex(line => line.includes('检索 tail'))
  assert.ok(row >= 0, `the second CJK occurrence is visible:\n${lines.join('\n')}`)
  const cjkColumn = columnOf(lines[row]!, '检索')
  assert.equal(vt.getCellBgRgb(row, cjkColumn), STRONG_BG, 'the first CJK cell is current')
  assert.equal(vt.getCellBgRgb(row, cjkColumn + 1), STRONG_BG, 'the second CJK cell belongs to the same current grapheme')

  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: '👩‍👩‍👦', match: emoji[0]!, message },
    grantReveal: true,
  })
  lines = await viewport(vt)
  row = lines.findIndex(line => line.includes('👩‍👩‍👦'))
  assert.ok(row >= 0, `the ZWJ cluster is visible:\n${lines.join('\n')}`)
  const emojiColumn = columnOf(lines[row]!, '👩‍👩‍👦')
  assert.equal(vt.getCellBgRgb(row, emojiColumn), STRONG_BG, 'the leading cell of the ZWJ cluster is current')
  assert.equal(vt.getCellBgRgb(row, emojiColumn + 1), STRONG_BG, 'the whole wide grapheme is painted, never half')
  assert.equal(mountedSelectionFor(app, message)?.exact, true)
  app.stop()
})

test('navigation: the source-cell witness never reaches the painted frame', async () => {
  const { folder, message } = userMessageFolder('needle alpha needle beta')
  const matches = folder.search('needle')
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript([message], folder.turnActivities())
  await viewport(vt)
  const renderedRows = (): readonly string[] => {
    const mounted = (app as unknown as {
      mountedTranscriptBlocks: ReadonlyArray<{ block: { message?: TranscriptMessage }; rendered: readonly string[] }>
    }).mountedTranscriptBlocks
    return mounted.find(entry => entry.block.message === message)!.rendered
  }
  const plain = renderedRows()
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: 'needle', match: matches[1]!, message },
    grantReveal: true,
  })
  await viewport(vt)
  const decorated = renderedRows()
  assert.deepEqual(decorated.map(stripTerminalSequences), plain.map(stripTerminalSequences),
    'the live child rows keep exactly the pre-search visible text')
  assert.deepEqual(decorated.map(visibleWidth), plain.map(visibleWidth),
    'the witness never changes the painted width')
  assert.ok(!vt.writes.join('').includes('dsh-pi-tui-search-proof'),
    'the disposable witness URL never reaches terminal writes')
  app.stop()
})

test('navigation: a passively targeted compact Thinking stays anchor-only', async () => {
  const { folder, message } = thinkingMessageFolder('thinking preview about needle')
  const match = folder.search('thinking').find(candidate => candidate.source.kind === 'message')
  assert.ok(match !== undefined)
  const { vt, app } = startApp(100, 30)
  app.setFullscreen(true)
  app.setTranscript(folder.messages(), folder.turnActivities())
  // A PASSIVE rebind carries the target without granting the reveal, so the
  // compact preview stays the only visible body evidence.
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: 'thinking', match, message },
    grantReveal: false,
  })
  const lines = await viewport(vt)
  const titleRow = lines.findIndex(line => /Thinking/.test(line))
  const previewRow = lines.findIndex(line => line.includes('preview about needle'))
  assert.ok(titleRow >= 0 && previewRow >= 0, `the compact Thinking rows are painted:\n${lines.join('\n')}`)
  for (const row of [titleRow, previewRow]) {
    for (let column = 0; column < visibleWidth(lines[row]!); column += 1) {
      assert.notEqual(vt.getCellBgRgb(row, column), STRONG_BG,
        `the compact Thinking row ${row} never claims a proven source cell`)
    }
  }
  const selection = mountedSelectionFor(app, message)
  assert.equal(selection?.exact, false, 'a compact preview is not the reasoning source layout')
  assert.equal(selection?.selectedIndex, -1)
  assert.equal(selection?.exactPaintedSegments, undefined)
  app.stop()
})

test('navigation: the regular surface paints the proven User cell without a scroll owner', async () => {
  const { folder, message } = userMessageFolder('needle alpha needle beta')
  const matches = folder.search('needle')
  const { vt, app } = startApp(100, 30)
  app.setTranscript([message], folder.turnActivities())
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: 'needle', match: matches[1]!, message },
    grantReveal: true,
  })
  const lines = await viewport(vt)
  const row = lines.findIndex(line => line.includes('needle alpha needle beta'))
  assert.ok(row >= 0, `the regular User row is painted:\n${lines.join('\n')}`)
  assert.equal(vt.getCellBgRgb(row, columnOf(lines[row]!, 'needle', 1)), STRONG_BG,
    'the second regular-surface occurrence is the proven current cell')
  assert.notEqual(vt.getCellBgRgb(row, columnOf(lines[row]!, 'needle', 0)), STRONG_BG,
    'the first occurrence is not current')
  assert.equal(app.fullscreenScrollForTest(), undefined,
    'a regular surface never gains a Fullscreen scroll controller from search exactness')
  assert.equal(mountedSelectionFor(app, message)?.exact, true)
  app.stop()
})

test('navigation: a plugin-rendered User or Thinking card never claims Host source cells', async () => {
  const { RendererRegistry } = await import('../../src/extension/internal/renderer-registry.ts')
  const registry = new RendererRegistry()
  registry.registerMessageRenderer({
    id: 'plugin-thinking-proof', kind: 'thinking',
    render: snapshot => ({ kind: 'text', spans: [{ text: `plugin ${snapshot.text ?? ''}` }] }),
  }, 'plugin')
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    renderers: registry,
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  const { folder, message } = thinkingMessageFolder('thinking needle body')
  const match = folder.search('needle').find(candidate => candidate.source.kind === 'message')
  assert.ok(match !== undefined)
  app.setFullscreen(true)
  app.setTranscript(folder.messages(), folder.turnActivities())
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: 'needle', match, message },
    grantReveal: true,
  })
  const lines = await viewport(vt)
  const row = lines.findIndex(line => line.includes('plugin') && line.includes('needle'))
  assert.ok(row >= 0, `the plugin renderer owns the card:\n${lines.join('\n')}`)
  for (let column = 0; column < visibleWidth(lines[row]!); column += 1) {
    assert.notEqual(vt.getCellBgRgb(row, column), STRONG_BG,
      'a plugin-rendered card never becomes an exact Host cell even when its text matches')
  }
  const selection = mountedSelectionFor(app, message)
  assert.equal(selection?.exact, false)
  assert.equal(selection?.exactPaintedSegments, undefined)
  app.stop()
})


// ── C0 negative guards: a hidden Markdown href never becomes a visible Exact ──

/** Fold one real Assistant message (the authoritative `assistant/message`
 * event), so the markdown source and its semantic occurrences are produced by
 * the same fold the live transcript uses. */
function assistantSearchFolder(text: string, id: string): {
  folder: TranscriptFolder
  message: Extract<TranscriptMessage, { kind: 'assistant' }>
} {
  const folder = new TranscriptFolder()
  folder.apply([
    sessionEvent('turn/start', { turn: 0 }, 0),
    sessionEvent('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId(id),
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, 1),
    sessionEvent('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2),
  ])
  const message = folder.messages().find(
    (candidate): candidate is Extract<TranscriptMessage, { kind: 'assistant' }> => candidate.kind === 'assistant',
  )
  assert.ok(message !== undefined, 'fixture: the folded assistant message exists')
  return { folder, message }
}

/** Terminal columns of every visible occurrence on one rendered row, measured
 * on the VISIBLE text (an OSC 8 href parameter may itself contain the
 * needle and must never be counted as a painted occurrence). */
function visibleColumnsOf(line: string, needle: string): number[] {
  const plain = stripTerminalSequences(line)
  const columns: number[] = []
  for (let index = plain.indexOf(needle); index >= 0; index = plain.indexOf(needle, index + needle.length)) {
    columns.push(visibleWidth(plain.slice(0, index)))
  }
  return columns
}

test('a hidden Markdown href search hit never strong-highlights a visible homonym', async () => {
  const previousCapabilities = getCapabilities()
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  try {
    const { folder, message } = assistantSearchFolder('[display](https://example.invalid/needle) needle', 'assistant-hidden-href')
    const matches = folder.search('needle')
    assert.equal(matches.length, 2, 'the raw corpus owns the href hit and the visible body hit')
    const match = matches[0]!
    assert.deepEqual(match.source, { kind: 'message' })
    assert.ok(match.normalizedSourceRange !== undefined, 'the href hit has a source-local range')
    const { vt, app } = startApp(100, 30)
    app.setFullscreen(true)
    app.setTranscript(folder.messages(), folder.turnActivities())
    app.setTranscriptSearchTarget({ query: 'needle', match, message })
    const lines = await viewport(vt)
    const row = lines.findIndex(line => stripTerminalSequences(line).includes('display'))
    assert.ok(row >= 0, `the linked answer is painted:\n${lines.join('\n')}`)
    const columns = visibleColumnsOf(lines[row]!, 'needle')
    assert.equal(columns.length, 1, `only the body homonym is visible:\n${lines[row]}`)
    for (let offset = 0; offset < 'needle'.length; offset += 1) {
      assert.notEqual(vt.getCellBgRgb(row, columns[0]! + offset), STRONG_BG,
        'a hidden href never strong-highlights the visible homonym')
    }
    const selection = mountedSelectionFor(app, message)
    assert.equal(selection?.exact, false, 'the hidden href target is not a proven cell')
    assert.equal(selection?.selectedIndex, -1)
    assert.equal(selection?.exactPaintedSegments, undefined)
    const presentation = app.transcriptSearchPresentationForTest()
    assert.equal(presentation?.query, 'needle', 'the query identity is unchanged')
    assert.equal(presentation?.sourceKey, 'message')
    assert.equal(presentation?.sourceOccurrence, match.sourceOccurrence, 'the source ordinal is unchanged')
    assert.equal(presentation?.matchId, match.id)
    assert.equal(presentation?.matchTurn, match.turn)
    assert.equal(folder.search('needle').length, 2, 'the semantic N/M corpus is unchanged')
    app.stop()
  } finally {
    setCapabilities(previousCapabilities)
  }
})

test('a hidden Markdown href between two visible homonyms never selects either text cell', async () => {
  const previousCapabilities = getCapabilities()
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  try {
    const { folder, message } = assistantSearchFolder('[needle](https://example.invalid/needle) needle', 'assistant-hidden-href-between')
    const matches = folder.search('needle')
    assert.equal(matches.length, 3, 'label, hidden href and body are three semantic occurrences')
    const match = matches[1]!
    assert.deepEqual(match.source, { kind: 'message' })
    assert.ok(match.normalizedSourceRange !== undefined)
    const { vt, app } = startApp(80, 30)
    app.setFullscreen(true)
    app.setTranscript(folder.messages(), folder.turnActivities())
    app.setTranscriptSearchTarget({ query: 'needle', match, message })
    for (const width of [80, 44]) {
      vt.resize(width, 30)
      const lines = await viewport(vt)
      const row = lines.findIndex(line => visibleColumnsOf(line, 'needle').length >= 1)
      assert.ok(row >= 0, `width ${width}: the linked answer is painted:\n${lines.join('\n')}`)
      const columns = visibleColumnsOf(lines[row]!, 'needle')
      assert.equal(columns.length, 2, `width ${width}: only the link label and the body are visible:\n${lines[row]}`)
      for (const column of columns) {
        for (let offset = 0; offset < 'needle'.length; offset += 1) {
          assert.notEqual(vt.getCellBgRgb(row, column + offset), STRONG_BG,
            `width ${width}: neither visible homonym becomes the hidden href's current cell`)
        }
      }
      const selection = mountedSelectionFor(app, message)
      assert.equal(selection?.exact, false, `width ${width}: the hidden href target is not a proven cell`)
      assert.equal(selection?.selectedIndex, -1)
      assert.equal(selection?.exactPaintedSegments, undefined)
    }
    const presentation = app.transcriptSearchPresentationForTest()
    assert.equal(presentation?.query, 'needle', 'the query identity is unchanged')
    assert.equal(presentation?.sourceKey, 'message')
    assert.equal(presentation?.sourceOccurrence, match.sourceOccurrence, 'the hidden href source ordinal is unchanged')
    assert.equal(presentation?.matchId, match.id)
    assert.equal(folder.search('needle').length, 3, 'the semantic N/M corpus is unchanged')
    app.stop()
  } finally {
    setCapabilities(previousCapabilities)
  }
})

// ── F2: a Host-native Assistant Markdown card proves its painted source cells ──

/** The CURRENT theme's exact-block background (the strong style is palette
 * driven, so the light theme uses a different RGB than dark). */
function strongBg(): number {
  return Number.parseInt((currentPalette.searchCurrentBg ?? '#F5C542').replace('#', ''), 16)
}

/** The STRONG current block's characters on one viewport row, read from the
 * terminal's OWN cells: the environment's width model (not the renderer's
 * `visibleWidth`) decides which cell holds which glyph, so an emoji bullet can
 * never shift the expectation. */
function strongCellText(vt: VirtualTerminal, row: number): string {
  return vt.getRgbBackgroundRuns(strongBg()).filter(run => run.row === row).map(run => run.text).join('')
}

/** Every viewport row that paints part of the STRONG current block. */
function strongRows(_lines: readonly string[], vt: VirtualTerminal): { row: number; text: string }[] {
  const rows = new Map<number, string>()
  for (const run of vt.getRgbBackgroundRuns(strongBg())) {
    rows.set(run.row, (rows.get(run.row) ?? '') + run.text)
  }
  return [...rows].map(([row, text]) => ({ row, text }))
}

/** The whole STRONG block text in row-major order (a wrapped hit owns several
 * rows and reassembles to the query). */
function strongText(lines: readonly string[], vt: VirtualTerminal): string {
  return strongRows(lines, vt).map(entry => entry.text).join('')
}

/** Mount one real folded Assistant answer, then prove one real Folder match
 * against the measured row map (the same order the interactive surface uses:
 * the card is painted before a search presentation is committed). */
async function mountAssistantAnswer(
  folder: TranscriptFolder,
  message: TranscriptMessage,
  query: string,
  match: TranscriptSearchMatch,
  width = 100,
  height = 30,
): Promise<{ vt: VirtualTerminal; app: TuiApp }> {
  const { vt, app } = startApp(width, height)
  app.setFullscreen(true)
  app.setIconStyle('symbols')
  app.setTranscript([message], folder.turnActivities())
  await viewport(vt)
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query, match, message },
    grantReveal: true,
  })
  app.scrollToSearchTarget()
  return { vt, app }
}

test('navigation: an Assistant Markdown card proves each same-card occurrence and scrolls to it', async () => {
  const text = [
    'needle first answer',
    ...Array.from({ length: 16 }, (_, index) => `filler line ${index}`),
    'needle second answer',
  ].join('\n')
  const { folder, message } = assistantSearchFolder(text, 'assistant-two-hits')
  const matches = folder.search('needle')
  assert.equal(matches.length, 2, 'the authoritative corpus owns exactly two occurrences')
  const { vt, app } = await mountAssistantAnswer(folder, message, 'needle', matches[0]!, 100, 12)

  let lines = await viewport(vt)
  assert.deepEqual(strongRows(lines, vt).map(entry => entry.text), ['needle'],
    'the first occurrence is the only strong block in the frame')
  const firstRow = lines.findIndex(line => stripTerminalSequences(line).includes('needle first answer'))
  assert.ok(firstRow >= 0, `the first answer row is painted:\n${lines.join('\n')}`)
  assert.equal(strongCellText(vt, firstRow), 'needle')
  let selection = mountedSelectionFor(app, message)
  assert.equal(selection?.exact, true, 'the Host Markdown source range is proven against real cells')
  assert.equal(selection?.selectedIndex, -1, 'the Markdown proof never uses a rendered ordinal')
  assert.equal(selection?.selectedRow, selection?.exactPaintedSegments?.[0]?.row)
  const firstScrollTop = app.fullscreenScrollForTest()!.scrollTop

  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: 'needle', match: matches[1]!, message },
    grantReveal: true,
  })
  app.scrollToSearchTarget()
  lines = await viewport(vt)
  assert.ok(lines.some(line => stripTerminalSequences(line).includes('needle second answer')),
    `the viewport scrolls to the second source-proven row:\n${lines.join('\n')}`)
  assert.ok(!lines.some(line => stripTerminalSequences(line).includes('needle first answer')),
    'the first occurrence is no longer the viewport destination')
  assert.notEqual(app.fullscreenScrollForTest()!.scrollTop, firstScrollTop, 'Next moves the viewport')
  assert.deepEqual(strongRows(lines, vt).map(entry => entry.text), ['needle'])
  selection = mountedSelectionFor(app, message)
  assert.equal(selection?.exact, true)
  assert.equal(selection?.exactPaintedSegments?.[0]?.row, selection?.selectedRow)
  assert.equal(folder.search('needle').length, 2, 'the semantic N/M corpus is unchanged')
  app.stop()
})

test('navigation: headings, emphasis, quotes and lists prove the exact source cells', async () => {
  const cases: Array<{ text: string; count: number }> = [
    { text: '## needle heading', count: 1 },
    { text: 'before **needle** *needle* ~~needle~~', count: 3 },
    { text: '> quote needle', count: 1 },
    { text: '- first\n  - nested needle', count: 1 },
    { text: '1. one\n2. needle ordered', count: 1 },
  ]
  const { vt, app } = startApp(100, 30)
  app.setFullscreen(true)
  app.setIconStyle('symbols')
  for (const testCase of cases) {
    for (const width of [44, 100]) {
      vt.resize(width, 30)
      const { folder, message } = assistantSearchFolder(testCase.text, `assistant-md-${testCase.count}-${width}-${testCase.text.length}`)
      const matches = folder.search('needle')
      assert.equal(matches.length, testCase.count, `${testCase.text}: one semantic hit per occurrence`)
      app.setTranscript([message], folder.turnActivities())
      for (let occurrence = 0; occurrence < matches.length; occurrence += 1) {
        app.setTranscriptSearchPresentation({
          matchMessages: new Set([message]),
          target: { query: 'needle', match: matches[occurrence]!, message },
          grantReveal: true,
        })
        const lines = await viewport(vt)
        assert.deepEqual(strongRows(lines, vt).map(entry => entry.text), ['needle'],
          `${JSON.stringify(testCase.text)} occurrence ${occurrence} at width ${width}: the exact leaf cells are strong`)
        const selection = mountedSelectionFor(app, message)
        assert.equal(selection?.exact, true, `${JSON.stringify(testCase.text)}: a single-leaf hit is PROVEN`)
        assert.equal(selection?.selectedIndex, -1)
      }
    }
  }
  app.stop()
})

test('navigation: link labels prove, a hidden href stays anchor-only, a printed href proves', async () => {
  const previousCapabilities = getCapabilities()
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  try {
    const { folder, message } = assistantSearchFolder('[needle](https://example.invalid/needle) needle', 'assistant-link-visible')
    const matches = folder.search('needle')
    assert.equal(matches.length, 3, 'label, hidden href and body are three semantic occurrences')
    const { vt, app } = await mountAssistantAnswer(folder, message, 'needle', matches[0]!, 90, 20)
    assert.deepEqual(strongRows(await viewport(vt), vt).map(entry => entry.text), ['needle'],
      'the link label is a proven painted cell')
    assert.equal(mountedSelectionFor(app, message)?.exact, true)

    app.setTranscriptSearchPresentation({
      matchMessages: new Set([message]),
      target: { query: 'needle', match: matches[1]!, message },
      grantReveal: true,
    })
    const hiddenLines = await viewport(vt)
    assert.deepEqual(strongRows(hiddenLines, vt), [], 'a hidden href never paints a visible homonym')
    const hiddenSelection = mountedSelectionFor(app, message)
    assert.equal(hiddenSelection?.exact, false)
    assert.equal(hiddenSelection?.exactPaintedSegments, undefined)
    assert.equal(hiddenLines.filter(line => visibleColumnsOf(line, 'needle').length > 0).length, 1,
      'both visible homonyms stay painted but neither becomes the href cell')

    app.setTranscriptSearchPresentation({
      matchMessages: new Set([message]),
      target: { query: 'needle', match: matches[2]!, message },
      grantReveal: true,
    })
    const bodyLines = await viewport(vt)
    assert.deepEqual(strongRows(bodyLines, vt).map(entry => entry.text), ['needle'],
      'the visible body occurrence is proven')
    const bodySelection = mountedSelectionFor(app, message)
    assert.equal(bodySelection?.exact, true)
    assert.ok((bodySelection?.exactPaintedSegments?.length ?? 0) > 0,
      'the body proof publishes card-relative segments')
    assert.equal(folder.search('needle').length, 3, 'the hidden href keeps its semantic occurrence')
    app.stop()
  } finally {
    setCapabilities(previousCapabilities)
  }
})

test('navigation: a printed link destination is a proven source cell when hyperlinks are off', async () => {
  const previousCapabilities = getCapabilities()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  try {
    const { folder, message } = assistantSearchFolder('[label](https://example.invalid/needle)', 'assistant-link-printed')
    const matches = folder.search('needle')
    assert.equal(matches.length, 1, 'the printed destination is the only semantic occurrence')
    const { vt, app } = await mountAssistantAnswer(folder, message, 'needle', matches[0]!, 90, 20)
    const lines = await viewport(vt)
    assert.ok(lines.some(line => stripTerminalSequences(line).includes('example.invalid/needle')),
      `the destination is printed by the card:\n${lines.join('\n')}`)
    assert.deepEqual(strongRows(lines, vt).map(entry => entry.text), ['needle'],
      'the printed destination is the honest painted cell')
    const selection = mountedSelectionFor(app, message)
    assert.equal(selection?.exact, true)
    assert.equal(selection?.selectedIndex, -1)
    app.stop()
  } finally {
    setCapabilities(previousCapabilities)
  }
})

test('navigation: inline code, fenced code and literal LaTeX prove; a fence tag does not', async () => {
  const cases: Array<{ text: string; count: number }> = [
    { text: '`needle` inline code', count: 1 },
    { text: '```js\nconst needle = 1\n```', count: 1 },
    { text: '$needle$ and \\(needle\\)', count: 2 },
    { text: '$$\nneedle\n$$', count: 1 },
    { text: '\\[\nneedle\n\\]', count: 1 },
  ]
  const { vt, app } = startApp(90, 30)
  app.setFullscreen(true)
  app.setIconStyle('symbols')
  for (const testCase of cases) {
    const { folder, message } = assistantSearchFolder(testCase.text, `assistant-code-${testCase.text.length}-${testCase.count}`)
    const matches = folder.search('needle')
    assert.equal(matches.length, testCase.count, `${JSON.stringify(testCase.text)}: one hit per literal occurrence`)
    app.setTranscript([message], folder.turnActivities())
    for (const match of matches) {
      app.setTranscriptSearchPresentation({
        matchMessages: new Set([message]),
        target: { query: 'needle', match, message },
        grantReveal: true,
      })
      const lines = await viewport(vt)
      assert.deepEqual(strongRows(lines, vt).map(entry => entry.text), ['needle'],
        `${JSON.stringify(testCase.text)}: the literal source cell is strong`)
      assert.equal(mountedSelectionFor(app, message)?.exact, true)
    }
  }

  // The code-fence TAG is markup, not a painted source cell.
  const fenced = assistantSearchFolder('```js\nconst needle = 1\n```', 'assistant-fence-tag')
  const tagMatch = fenced.folder.search('js')[0]
  assert.ok(tagMatch !== undefined, 'fixture: the fence tag is in the semantic corpus')
  app.setTranscript([fenced.message], fenced.folder.turnActivities())
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([fenced.message]),
    target: { query: 'js', match: tagMatch, message: fenced.message },
    grantReveal: true,
  })
  const tagLines = await viewport(vt)
  assert.deepEqual(strongRows(tagLines, vt), [], 'a code fence tag never becomes an exact cell')
  assert.equal(mountedSelectionFor(app, fenced.message)?.exact, false)
  app.stop()
})

test('navigation: a query longer than the card width proves every wrapped row', async () => {
  const word = 'supercalifragilisticexpialidocious'
  const { folder, message } = assistantSearchFolder(`${word} tail`, 'assistant-wrapped-query')
  const matches = folder.search(word)
  assert.equal(matches.length, 1)
  const { vt, app } = await mountAssistantAnswer(folder, message, word, matches[0]!, 11, 30)
  const lines = await viewport(vt)
  const selection = mountedSelectionFor(app, message)
  assert.equal(selection?.exact, true, 'the wrapped occurrence is proven')
  assert.ok((selection?.exactPaintedSegments?.length ?? 0) >= 2,
    'the occurrence owns one segment per painted row')
  assert.equal(strongText(lines, vt), word, 'every wrapped row reassembles the query')
  assert.equal(strongRows(lines, vt).length, selection?.exactPaintedSegments?.length,
    'exactly the proven rows are strong')
  assert.equal(folder.search(word).length, 1)
  app.stop()
})

test('navigation: Unicode source cells re-prove across width, theme and bullet geometry', async () => {
  const text = '前缀**匹配词**后缀 cafe\u0301 needle 家庭 👨‍👩‍👧 tail'
  const { folder, message } = assistantSearchFolder(text, 'assistant-unicode')
  const matches = folder.search('needle')
  assert.equal(matches.length, 1)
  const { vt, app } = startApp(100, 30)
  app.setFullscreen(true)
  try {
    for (const iconStyle of ['emoji', 'minimal'] as const) {
      for (const theme of ['dark', 'light'] as const) {
        app.setIconStyle(iconStyle)
        app.applyTheme(theme)
        for (const width of [12, 44, 80, 120]) {
          vt.resize(width, 30)
          app.setTranscript([message], folder.turnActivities())
          await viewport(vt)
          app.setTranscriptSearchPresentation({
            matchMessages: new Set([message]),
            target: { query: 'needle', match: matches[0]!, message },
            grantReveal: true,
          })
          app.scrollToSearchTarget()
          const lines = await viewport(vt)
          assert.equal(strongText(lines, vt), 'needle',
            `width ${width}, ${theme}, ${iconStyle}: the re-painted cell stays exact`)
          const selection = mountedSelectionFor(app, message)
          assert.equal(selection?.exact, true, `width ${width}, ${theme}, ${iconStyle}: exact`)
          assert.ok((selection?.exactPaintedSegments?.length ?? 0) > 0)
          assert.equal(selection?.selectedRow, selection?.exactPaintedSegments?.[0]?.row)
        }
      }
    }

    // CJK, ZWJ and combining source cells prove too: the terminal cell walk
    // keeps a wide glyph on its own cells and a combining mark inside its base
    // cell, so the strong run must reassemble the exact query text.
    vt.resize(80, 30)
    for (const query of ['匹配词', '👨‍👩‍👧', 'e\u0301']) {
      const queryMatches = folder.search(query)
      assert.equal(queryMatches.length, 1, `fixture: ${JSON.stringify(query)} is searchable once`)
      app.setTranscriptSearchPresentation({
        matchMessages: new Set([message]),
        target: { query, match: queryMatches[0]!, message },
        grantReveal: true,
      })
      app.scrollToSearchTarget()
      const queryLines = await viewport(vt)
      assert.equal(strongText(queryLines, vt), query,
        `${JSON.stringify(query)} proves its own painted cells`)
      assert.equal(mountedSelectionFor(app, message)?.exact, true, `${JSON.stringify(query)} is exact`)
    }

    // A geometry change without a re-measure must never keep the old columns:
    // the remeasure pass re-proves the CURRENT rows for the new width.
    vt.resize(44, 30)
    app.setTranscript([message], folder.turnActivities())
    await viewport(vt)
    app.setTranscriptSearchPresentation({
      matchMessages: new Set([message]),
      target: { query: 'needle', match: matches[0]!, message },
      grantReveal: true,
    })
    app.scrollToSearchTarget()
    await viewport(vt)
    const beforeResize = mountedSelectionFor(app, message)?.exactPaintedSegments
    assert.ok(beforeResize !== undefined)
    app.resetSearchPresentationDiagnosticsForTest()
    vt.resize(20, 30)
    await viewport(vt)
    app.scrollToSearchTarget()
    await viewport(vt)
    const afterResize = mountedSelectionFor(app, message)?.exactPaintedSegments
    assert.ok(afterResize !== undefined, 'the narrower geometry is re-proven')
    assert.notDeepEqual(afterResize, beforeResize, 'the old proven columns are not reused')
    assert.equal(strongText(await viewport(vt), vt), 'needle', 'the re-proven rows still spell the source text')
    const resizeDiagnostics = app.searchPresentationDiagnosticsForTest()
    assert.ok(resizeDiagnostics.markdownProofs >= 1,
      'the resize re-proves instead of reusing the old proven columns')
    assert.ok(resizeDiagnostics.markdownProofs <= resizeDiagnostics.rebuilds + resizeDiagnostics.remeasures,
      'every presentation pass proves the current card at most once')
  } finally {
    app.stop()
  }
})

test('navigation: a live Assistant stream proves its current text and drops a stale range', async () => {
  const folder = new TranscriptFolder()
  folder.apply([sessionEvent('turn/start', { turn: 0 }, 0)])
  folder.applyLiveInput({
    kind: 'chunk',
    sessionId: 'search-stream',
    attemptId: 'attempt-stream',
    turn: 0,
    step: 0,
    time: 1_700_000_000_001,
    chunk: { type: 'text-delta', index: 0, text: 'prefix needle' },
  })
  const live = folder.messages().find(
    (candidate): candidate is Extract<TranscriptMessage, { kind: 'assistant' }> => candidate.kind === 'assistant',
  )
  assert.ok(live !== undefined, 'fixture: the live Assistant row exists')
  assert.equal(live.displayBlocks, undefined, 'fixture: a text-only stream carries no opaque projection')
  const matches = folder.search('needle')
  assert.equal(matches.length, 1)
  const { vt, app } = await mountAssistantAnswer(folder, live, 'needle', matches[0]!, 70, 20)

  let lines = await viewport(vt)
  assert.equal(strongText(lines, vt), 'needle', 'the live current source range is proven')
  assert.equal(mountedSelectionFor(app, live)?.exact, true)

  // An unclosed math span is not a painted literal leaf yet.
  folder.applyLiveInput({
    kind: 'chunk',
    sessionId: 'search-stream',
    attemptId: 'attempt-stream',
    turn: 0,
    step: 0,
    time: 1_700_000_000_002,
    chunk: { type: 'text-delta', index: 0, text: ' \\(needle' },
  })
  const unclosed = folder.search('needle').at(-1)!
  app.setTranscript(folder.messages(), folder.turnActivities())
  await viewport(vt)
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([live]),
    target: { query: 'needle', match: unclosed, message: live },
    grantReveal: true,
  })
  lines = await viewport(vt)
  assert.deepEqual(strongRows(lines, vt), [], 'a pending math source keeps the honest anchor')
  assert.equal(mountedSelectionFor(app, live)?.exact, false)

  // Closing the math span re-proves the literal source text.
  folder.applyLiveInput({
    kind: 'chunk',
    sessionId: 'search-stream',
    attemptId: 'attempt-stream',
    turn: 0,
    step: 0,
    time: 1_700_000_000_003,
    chunk: { type: 'text-delta', index: 0, text: '\\)' },
  })
  const closed = folder.search('needle').at(-1)!
  app.setTranscript(folder.messages(), folder.turnActivities())
  await viewport(vt)
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([live]),
    target: { query: 'needle', match: closed, message: live },
    grantReveal: true,
  })
  lines = await viewport(vt)
  assert.equal(strongText(lines, vt), 'needle', 'the closed math literal is proven')

  // A SETTLED text that no longer contains the target at the old offset must
  // not reuse the previous proven cells.
  const settled = assistantSearchFolder('x needle settled', 'assistant-settled-mismatch')
  app.setTranscript([settled.message], settled.folder.turnActivities())
  await viewport(vt)
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([settled.message]),
    target: { query: 'needle', match: matches[0]!, message: settled.message },
    grantReveal: true,
  })
  lines = await viewport(vt)
  assert.deepEqual(strongRows(lines, vt), [], 'a stale normalized range never paints a visible cell')
  assert.equal(mountedSelectionFor(app, settled.message)?.exact, false)
  app.stop()
})

test('navigation: composite and foreign Assistant owners stay anchor-only', async () => {
  const { RendererRegistry } = await import('../../src/extension/internal/renderer-registry.ts')
  const registry = new RendererRegistry()
  registry.registerMessageRenderer({
    id: 'plugin-assistant-proof', kind: 'assistant',
    render: snapshot => ({ kind: 'text', spans: [{ text: `plugin ${snapshot.text ?? ''}` }] }),
  }, 'plugin')

  const { folder, message } = assistantSearchFolder('needle body', 'assistant-plugin-owned')
  const match = folder.search('needle')[0]!
  const vt = new VirtualTerminal(90, 20)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    renderers: registry,
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  app.start()
  startedApps.add(app)
  app.setFullscreen(true)
  app.setIconStyle('symbols')
  app.setTranscript([message], folder.turnActivities())
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([message]),
    target: { query: 'needle', match, message },
    grantReveal: true,
  })
  let lines = await viewport(vt)
  assert.ok(lines.some(line => stripTerminalSequences(line).includes('plugin needle body')),
    `the plugin renderer owns the card:\n${lines.join('\n')}`)
  assert.deepEqual(strongRows(lines, vt), [], 'a plugin-owned Assistant card never claims Host proof')
  let selection = mountedSelectionFor(app, message)
  assert.equal(selection?.exact, false)
  assert.equal(selection?.exactPaintedSegments, undefined)
  app.dispose()

  // Multi-ContentBlock (text + image), open-opaque, interrupted and delivered
  // cards are composite owners: one text child is never the whole card source.
  const compositeCases: Array<Extract<TranscriptMessage, { kind: 'assistant' }>> = [
    {
      kind: 'assistant', turn: 0, text: 'needle body',
      content: [
        { type: 'text', text: 'needle ' },
        { type: 'image', attachment: { type: 'image', ref: 'img-1' } } as never,
        { type: 'text', text: 'body' },
      ],
    },
    { kind: 'assistant', turn: 0, text: 'needle body', displayBlocks: [{ kind: 'open-opaque', blockType: 'tool-call' }] },
    { kind: 'assistant', turn: 0, text: 'needle body', interrupted: true },
    { kind: 'assistant', turn: 0, text: 'needle body', deliverables: [{ path: 'report.md' }] },
  ]
  for (const candidate of compositeCases) {
    const compositeVt = new VirtualTerminal(90, 24)
    const compositeApp = new TuiApp(compositeVt, { onSubmit: () => {}, onExit: () => {} }, {
      deliveredFiles: deliveredFilesCapabilityStub,
    })
    compositeApp.start()
    startedApps.add(compositeApp)
    compositeApp.setFullscreen(true)
    compositeApp.setIconStyle('symbols')
    compositeApp.setTranscript([candidate])
    compositeApp.setTranscriptSearchPresentation({
      matchMessages: new Set([candidate]),
      target: {
        query: 'needle',
        match: {
          id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0,
          normalizedSourceRange: { start: 0, end: 6 },
        },
        message: candidate,
      },
      grantReveal: true,
    })
    lines = await viewport(compositeVt)
    assert.deepEqual(strongRows(lines, compositeVt), [],
      `${JSON.stringify(Object.keys(candidate))}: a composite Assistant owner stays anchor-only`)
    selection = mountedSelectionFor(compositeApp, candidate)
    assert.equal(selection?.exact, false)
    assert.equal(selection?.exactPaintedSegments, undefined)
    compositeApp.dispose()
  }

  // A narrow table falls back to plain rows the proof cannot own.
  const table = assistantSearchFolder('| h |\n|---|\n| needle |', 'assistant-table-fallback')
  const tableMatch = table.folder.search('needle')[0]!
  const tableVt = new VirtualTerminal(8, 20)
  const tableApp = new TuiApp(tableVt, { onSubmit: () => {}, onExit: () => {} }, {
    deliveredFiles: deliveredFilesCapabilityStub,
  })
  tableApp.start()
  startedApps.add(tableApp)
  tableApp.setFullscreen(true)
  tableApp.setIconStyle('symbols')
  tableApp.setTranscript([table.message], table.folder.turnActivities())
  tableApp.setTranscriptSearchPresentation({
    matchMessages: new Set([table.message]),
    target: { query: 'needle', match: tableMatch, message: table.message },
    grantReveal: true,
  })
  lines = await viewport(tableVt)
  assert.deepEqual(strongRows(lines, tableVt), [], 'the narrow table fallback never invents an exact cell')
  assert.equal(mountedSelectionFor(tableApp, table.message)?.exact, false)
  tableApp.dispose()
})

test('navigation: a lowercasing expansion interior stays anchor-only; a stripped control neighbour still proves', async () => {
  // `İ` lowercases to two normalized codepoints; a query that starts inside the
  // expansion has no raw boundary, so no cell can be claimed.
  const expansion = assistantSearchFolder('İneedle', 'assistant-lowercase-interior')
  const expansionMatch = expansion.folder.search('i')[0]
  assert.ok(expansionMatch !== undefined, 'fixture: the expansion interior is searchable')
  const { vt, app } = await mountAssistantAnswer(expansion.folder, expansion.message, 'i', expansionMatch, 70, 20)
  let lines = await viewport(vt)
  assert.deepEqual(strongRows(lines, vt), [], 'the expansion interior is not a painted source cell')
  assert.equal(mountedSelectionFor(app, expansion.message)?.exact, false)

  // A range that crosses a raw control sequence is not locally projectable.
  const crossed = assistantSearchFolder('before \x1b[31mneedle red', 'assistant-crossed-control')
  const crossedMatch = crossed.folder.search('needle')[0]!
  app.setTranscript([crossed.message], crossed.folder.turnActivities())
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([crossed.message]),
    target: { query: 'needle', match: crossedMatch, message: crossed.message },
    grantReveal: true,
  })
  lines = await viewport(vt)
  // The sanitized source keeps the visible needle: this one IS the painted
  // text, so it must be proven rather than rejected as a homonym.
  assert.equal(strongText(lines, vt), 'needle', 'a range after a stripped control sequence still names real cells')
  app.stop()
})

test('navigation: a case-folding rendered overlap never widens the proven cells', async () => {
  // `ſ` (U+017F long s) lowercases to itself, so `TranscriptFolder.search('ss')`
  // reports the two real `s` cells at source [1,3). The rendered matcher is
  // Unicode ignore-case (U+017F folds to `s`), so it reports the OVERLAPPING
  // `ſs` at [0,2). The shared painter must keep the strong block equal to the
  // proven cells and leave the long-s cell weak — for every source-proven
  // owner, not just Assistant.
  const previousCapabilities = getCapabilities()
  setCapabilities({ images: null, trueColor: true, hyperlinks: true })
  try {
    const assistant = assistantSearchFolder('ſss', 'f2-long-s-assistant')
    const user = userMessageFolder('ſss')
    const thinking = thinkingMessageFolder('ſss')
    const cases: Array<{
      label: string
      folder: TranscriptFolder
      message: TranscriptMessage
      expand?: true
    }> = [
      { label: 'assistant', folder: assistant.folder, message: assistant.message },
      { label: 'user', folder: user.folder, message: user.message },
      { label: 'thinking', folder: thinking.folder, message: thinking.message, expand: true },
    ]

    const { vt, app } = startApp(80, 20)
    app.setFullscreen(true)
    app.setIconStyle('symbols')
    for (const testCase of cases) {
      app.setTranscriptSearchTarget(undefined)
      app.setTranscript(testCase.folder.messages(), testCase.folder.turnActivities())
      if (testCase.expand === true) {
        const overrides = (app as unknown as { expandedOverride: Map<object, boolean> }).expandedOverride
        overrides.set(testCase.message, true)
        app.setTranscript(testCase.folder.messages(), testCase.folder.turnActivities())
      }
      await viewport(vt)
      const matches = testCase.folder.search('ss')
      assert.equal(matches.length, 1, `${testCase.label}: exactly one semantic hit`)
      assert.deepEqual(matches[0]!.normalizedSourceRange, { start: 1, end: 3 },
        `${testCase.label}: the lowercase corpus hit is the two real s cells, not the long s`)
      app.setTranscriptSearchPresentation({
        matchMessages: new Set([testCase.message]),
        target: { query: 'ss', match: matches[0]!, message: testCase.message },
        grantReveal: true,
      })
      app.scrollToSearchTarget()
      const lines = await viewport(vt)
      const row = lines.findIndex(line => stripTerminalSequences(line).includes('ſss'))
      assert.ok(row >= 0, `${testCase.label}: the long-s row is painted:\n${lines.join('\n')}`)
      assert.deepEqual(strongRows(lines, vt).map(entry => entry.text), ['ss'],
        `${testCase.label}: the strong block is exactly the proven cells`)
      const selection = mountedSelectionFor(app, testCase.message)
      assert.equal(selection?.exact, true, `${testCase.label}: the source cells are proven`)
      assert.equal(selection?.exactPaintedSegments?.length, 1)
      let longSColumn = -1
      for (let column = 0; column < vt.columns; column += 1) {
        if (vt.getCellText(row, column) === 'ſ') {
          longSColumn = column
          break
        }
      }
      assert.ok(longSColumn >= 0, `${testCase.label}: the long-s cell is painted`)
      assert.notEqual(vt.getCellBgRgb(row, longSColumn), strongBg(),
        `${testCase.label}: the overlapping long-s cell is never upgraded to strong`)
      assert.equal(vt.getCellUnderline(row, longSColumn), true,
        `${testCase.label}: the weak occurrence keeps only the uncovered cell`)
    }
    app.stop()
  } finally {
    setCapabilities(previousCapabilities)
  }
})
