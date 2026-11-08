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
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { TuiApp } from '../../src/tui-app.ts'
import { darkColors, lightColors } from '../../src/domain/display/theme.ts'
import { currentPalette } from '../../src/tui/theme/runtime.ts'
import { TranscriptFolder, workflowPhaseKey, type TranscriptMessage, type TranscriptToolMessage } from '../../src/transcript.ts'
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
    subjectKind: 'main', subjectId: 'search', sourceIdentity: {}, session: {}, sessionId: 'search', seq: 2,
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
    subjectKind: 'main', subjectId: 'deliverable-search', sourceIdentity: {}, session: {}, sessionId: 'deliverable-search', seq: 3,
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
    subjectKind: 'main', subjectId: 'cross-block-search', sourceIdentity: {}, session: {}, sessionId: 'cross-block-search', seq: 2,
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
