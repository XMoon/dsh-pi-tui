/**
 * Fullscreen transcript-search interaction contract (perf plan S4 §7 / §10.4):
 * the search box keeps KEYBOARD focus, but the transcript viewport stays
 * interactive — wheel, PageUp/PageDown, scrollbar, background disclosure and
 * selection — while the editor stays locked behind the modal. The plan-review
 * reading step (FR7) is the same mounted contract with the Question owning the
 * seat: the same one-shot reveal/scroll primitives, the same disclosure
 * owners, and the same "never submit from the reading viewport" rule.
 * @module @xmoon76/dsh-pi-tui/transcript-search-interaction.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { TuiApp, type TuiAppOptions } from '../../src/tui-app.ts'
import { createClientToolPresenter } from '../../src/tui/transcript/client-tool-presenter.ts'
import { parseUserKeybindings } from '../../src/tui/keybindings/config.ts'
import type { TranscriptMessage, TranscriptSearchMatch } from '../../src/transcript.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly queries: string[]
  readonly scopes: Array<'view' | 'full'>
  readonly submits: string[]
  readonly copied: string[]
  readonly searchSteps: Array<'next' | 'previous'>
  readonly jumpLatest: number[]
}

function startSearchApp(width = 80, height = 24): Harness {
  const vt = new VirtualTerminal(width, height)
  const queries: string[] = []
  const scopes: Array<'view' | 'full'> = []
  const submits: string[] = []
  const copied: string[] = []
  const searchSteps: Array<'next' | 'previous'> = []
  const jumpLatest: number[] = []
  let app!: TuiApp
  app = new TuiApp(vt, {
    onSubmit: (text) => { submits.push(text) },
    onExit: () => {},
    onSearchQuery: (query) => { queries.push(query) },
    onSearchScope: scope => {
      scopes.push(scope)
      app.setSearchScope(scope)
    },
    onSearchNext: () => { searchSteps.push('next') },
    onSearchPrev: () => { searchSteps.push('previous') },
    onTranscriptJumpLatest: () => { jumpLatest.push(1); return true },
  }, {
    copySelection: async (text) => { copied.push(text); return true },
  })
  app.start()
  startedApps.add(app)
  app.setFullscreen(true)
  app.setTranscript(longTranscript())
  return { vt, app, queries, scopes, submits, copied, searchSteps, jumpLatest }
}

function longTranscript(): TranscriptMessage[] {
  return Array.from({ length: 14 }, (_, turn) => ({
    kind: 'user' as const,
    turn,
    text: Array.from({ length: 5 }, (_, line) => `turn ${turn} body line ${line}`).join('\n'),
  }))
}

function scrollTop(app: TuiApp): number {
  const scroll = app.fullscreenScrollForTest()
  assert.ok(scroll !== undefined, 'fullscreen scroll view must exist')
  return scroll.scrollTop
}

test('interaction: wheel and PageUp/PageDown scroll the transcript while the search input keeps focus', async () => {
  const { vt, app, queries } = startSearchApp()
  await vt.waitForRender()
  app.startTranscriptSearch()
  await vt.waitForRender()
  vt.sendInput('needle')
  await vt.waitForRender()
  assert.deepEqual(queries.slice(-1), ['needle'], 'precondition: the query reached the search input')
  assert.equal(app.focusSeatForTest(), 'overlay', 'the search box owns the keyboard seat')

  const before = scrollTop(app)
  queries.length = 0
  vt.sendInput('\x1b[5~') // PageUp
  await vt.waitForRender()
  assert.ok(scrollTop(app) < before, `PageUp must page the transcript:\n${vt.getViewport().join('\n')}`)
  assert.deepEqual(queries, [], 'PageUp must not reach the search input')
  const paged = scrollTop(app)
  vt.sendInput('\x1b[6~') // PageDown
  await vt.waitForRender()
  assert.ok(scrollTop(app) > paged, 'PageDown must page back down')
  assert.deepEqual(queries, [], 'PageDown must not reach the search input')

  const beforeWheel = scrollTop(app)
  vt.sendInput('\x1b[<64;5;8M') // wheel up over the transcript, outside the search box
  await vt.waitForRender()
  assert.ok(scrollTop(app) < beforeWheel, 'wheel must scroll the transcript')
  assert.deepEqual(queries, [], 'the wheel must not reach the search input')
  assert.equal(app.focusSeatForTest(), 'overlay', 'the search box keeps the keyboard seat after scrolling')
  app.stop()
})

test('interaction: Home/End still edit the search query instead of the viewport', async () => {
  const { vt, app, queries } = startSearchApp()
  await vt.waitForRender()
  app.startTranscriptSearch()
  await vt.waitForRender()
  vt.sendInput('abc')
  await vt.waitForRender()
  const before = scrollTop(app)
  vt.sendInput('\x1bOH') // Home — the query cursor, never the viewport top
  vt.sendInput('X')
  await vt.waitForRender()
  assert.equal(queries.at(-1), 'Xabc', `Home must move the query cursor, not the viewport:\n${vt.getViewport().join('\n')}`)
  assert.equal(scrollTop(app), before, 'Home must not scroll the transcript')
  vt.sendInput('\x1bOF') // End
  vt.sendInput('Y')
  await vt.waitForRender()
  assert.equal(queries.at(-1), 'XabcY', 'End must move the query cursor, not the viewport bottom')
  assert.equal(scrollTop(app), before, 'End must not scroll the transcript')
  app.stop()
})

test('interaction: the search modal still locks the editor and never submits', async () => {
  const { vt, app, submits } = startSearchApp()
  await vt.waitForRender()
  app.startTranscriptSearch()
  await vt.waitForRender()
  vt.sendInput('draft text')
  vt.sendInput('\r') // Enter = next match, never submit
  await vt.waitForRender()
  assert.deepEqual(submits, [], 'Enter inside the search box must never submit the prompt')
  assert.equal(app.hostEditorTextForTest(), '', 'typed characters must never leak into the editor draft')
  assert.equal(app.focusSeatForTest(), 'overlay', 'the search box owns the keyboard seat')
  app.closeTranscriptSearch()
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'editor', 'closing restores the editor seat')
  app.stop()
})

test('interaction: the search box keeps pointer ownership inside its rectangle', async () => {
  const { vt, app, queries } = startSearchApp()
  await vt.waitForRender()
  app.startTranscriptSearch()
  await vt.waitForRender()
  vt.sendInput('abc')
  await vt.waitForRender()
  // The box is anchored top-right (40%, margin 1) at 80 columns: its query row
  // is screen row 2 (SGR y=3), column 47+3=50 (SGR x=51) — clicking there must
  // position the private Input's cursor, i.e. the click landed on the BOX and
  // never on the transcript underneath.
  vt.sendInput('\x1b[<0;51;3M')
  vt.sendInput('\x1b[<0;51;3m')
  await vt.waitForRender()
  vt.sendInput('X')
  await vt.waitForRender()
  assert.equal(queries.at(-1), 'aXbc', `the in-box click must position the query cursor:\n${vt.getViewport().join('\n')}`)
  assert.equal(app.isSearching(), true, 'the box stays open')

  // A wheel INSIDE the box is handed to the transcript because the box does not
  // handle it — but the box itself never disappears and keeps the query.
  vt.sendInput('\x1b[<64;70;2M')
  await vt.waitForRender()
  assert.equal(app.isSearching(), true, 'an in-box wheel never closes the box')
  assert.equal(queries.at(-1), 'aXbc', 'an in-box wheel never edits the query')
  app.stop()
})

function unprovenToolTarget(): { message: TranscriptMessage; match: TranscriptSearchMatch } {
  const message: TranscriptMessage = {
    kind: 'tool',
    turn: 0,
    name: 'bash',
    args: '{}',
    result: 'needle tool output',
    status: 'ok',
  }
  const match: TranscriptSearchMatch = {
    id: -1,
    turn: 0,
    occurrence: 0,
    source: { kind: 'tool-field', field: 'result' },
    sourceOccurrence: 0,
    normalizedSourceRange: { start: 0, end: 'needle'.length },
  }
  return { message, match }
}

function overlayBounds(app: TuiApp): { row: number; col: number; width: number; height: number } {
  const overlay = (app as unknown as {
    searchOverlay?: { getBounds(): { row: number; col: number; width: number; height: number } | undefined }
  }).searchOverlay?.getBounds()
  assert.ok(overlay !== undefined, 'the Search overlay must be painted')
  return overlay
}

test('interaction: a non-exact Full target adds one Source-only row and an exact one removes it', async () => {
  const { vt, app } = startSearchApp(120, 30)
  await vt.waitForRender()
  app.startTranscriptSearch('full')
  await vt.waitForRender()
  const handles = app.overlayGraphState().handles
  const tool = unprovenToolTarget()
  const exact: TranscriptMessage = { kind: 'user', turn: 1, text: 'needle exact body' }
  app.setTranscript([tool.message, exact])
  await vt.waitForRender()
  assert.equal(app.currentFullSearchNotice(), undefined, 'no current target means no notice')
  assert.equal(overlayBounds(app).height, 3, 'an empty Full query keeps the three-row form')

  app.setTranscriptSearchPresentation({
    matchMessages: new Set([tool.message]),
    target: { query: 'needle', match: tool.match, message: tool.message },
    grantReveal: true,
  })
  await vt.waitForRender()
  assert.deepEqual(app.currentFullSearchNotice(), { kind: 'unproven', sourceLabel: 'Tool result' },
    'a Tool result has no source-cell proof: label-only, never a visible-cell claim')
  assert.equal(overlayBounds(app).height, 4, 'the honest Source-only row really grows the ONE overlay')
  assert.equal(app.overlayGraphState().handles, handles, 'the notice never mints a second overlay')
  const unprovenFrame = vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/gu, ''))
  assert.ok(unprovenFrame.some(line => line.includes('Source-only') && line.includes('position unverified')
    && line.includes('Tool result')),
  `the fourth row names the source kind and the honest position:\n${unprovenFrame.join('\n')}`)
  assert.ok(!unprovenFrame.some(line => line.includes('no visible cell')),
    'an unproven target never claims the cell is absent')
  assert.equal(app.focusSeatForTest(), 'overlay', 'the notice keeps the search Input focused')

  const userMatch: TranscriptSearchMatch = {
    id: -1,
    turn: 1,
    occurrence: 0,
    source: { kind: 'message' },
    sourceOccurrence: 0,
    normalizedSourceRange: { start: 0, end: 'needle'.length },
  }
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([exact]),
    target: { query: 'needle', match: userMatch, message: exact },
    grantReveal: true,
  })
  await vt.waitForRender()
  assert.equal(app.currentFullSearchNotice(), undefined, 'an exact current cell needs no notice')
  assert.equal(overlayBounds(app).height, 3, 'the overlay returns to its three-row form')
  assert.ok(!vt.getViewport().some(line => line.includes('Source-only')))
  app.stop()
})

test('interaction: a short terminal keeps three rows and folds the Source-only fact into the hint row', async () => {
  const { vt, app } = startSearchApp(80, 10)
  await vt.waitForRender()
  app.startTranscriptSearch('full')
  await vt.waitForRender()
  const tool = unprovenToolTarget()
  app.setTranscript([tool.message])
  await vt.waitForRender()
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([tool.message]),
    target: { query: 'needle', match: tool.match, message: tool.message },
    grantReveal: true,
  })
  await vt.waitForRender()
  assert.equal(overlayBounds(app).height, 3, 'a <=10-row terminal never spends a fourth row')
  const lines = vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/gu, ''))
  const noticeRow = lines.find(line => line.includes('Source-only'))
  assert.ok(noticeRow !== undefined, `the compact Source-only row is painted:\n${lines.join('\n')}`)
  assert.match(noticeRow, /Source-only.*Loaded/u, 'the real loaded-history coverage truth survives')
  assert.match(noticeRow, /Esc/u, 'the effective close key survives the compact layout')
  assert.ok(lines.some(line => line.includes('[Full]')), 'the scope title survives the compact layout')
  assert.ok(lines.some(line => line.includes('>')), 'the query Input row survives the compact layout')
  assert.equal(app.focusSeatForTest(), 'overlay')
  app.stop()
})

test('interaction: resize and scope changes reflow one Source-only notice without a second owner', async () => {
  const { vt, app } = startSearchApp(120, 30)
  await vt.waitForRender()
  app.startTranscriptSearch('full')
  await vt.waitForRender()
  const handles = app.overlayGraphState().handles
  const tool = unprovenToolTarget()
  app.setTranscript([tool.message])
  await vt.waitForRender()
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([tool.message]),
    target: { query: 'needle', match: tool.match, message: tool.message },
    grantReveal: true,
  })
  await vt.waitForRender()
  assert.equal(overlayBounds(app).height, 4)

  vt.resize(80, 10)
  await vt.waitForRender()
  assert.equal(overlayBounds(app).height, 3, 'a short terminal returns to the three-row form')
  assert.ok(vt.getViewport().some(line => line.includes('Source-only')), 'the compact fact stays painted')

  vt.resize(44, 20)
  await vt.waitForRender()
  assert.equal(overlayBounds(app).height, 4, 'a 44-column terminal keeps the fourth row')
  const narrow = vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/gu, ''))
  const narrowNotice = narrow.find(line => line.includes('Source-only'))
  assert.ok(narrowNotice !== undefined, `a narrow box still names the source-only fact:\n${narrow.join('\n')}`)
  assert.ok(narrowNotice.includes('unverified') || narrowNotice.includes('not painted'),
    'the narrow layout keeps the short honest status word')
  assert.ok(!narrowNotice.includes('position unverified'), 'the long status yields to the 24-column box')

  vt.resize(120, 30)
  await vt.waitForRender()
  assert.equal(overlayBounds(app).height, 4, 'growing again restores the fourth row')
  assert.equal(app.overlayGraphState().handles, handles, 'no resize mints another overlay')
  assert.equal(app.currentFullSearchNotice()?.kind, 'unproven', 'the notice still belongs to the current target')

  app.setSearchScope('view')
  await vt.waitForRender()
  assert.equal(app.currentFullSearchNotice(), undefined, 'the View scope never speaks for a Full source')
  assert.ok(!vt.getViewport().some(line => line.includes('Source-only')), 'the View scope drops the fourth row')
  assert.equal(overlayBounds(app).height, 3)

  app.setSearchScope('full')
  await vt.waitForRender()
  assert.equal(app.currentFullSearchNotice()?.kind, 'unproven', 'the retained Full target restores its notice')
  assert.equal(overlayBounds(app).height, 4)

  app.closeTranscriptSearch()
  await vt.waitForRender()
  assert.equal(app.currentFullSearchNotice(), undefined, 'closing retires the notice with its overlay')
  app.stop()
})

test('interaction: a higher modal suppresses the Source-only row and restores it on close', async () => {
  const { vt, app } = startSearchApp(120, 30)
  await vt.waitForRender()
  app.startTranscriptSearch('full')
  await vt.waitForRender()
  const tool = unprovenToolTarget()
  app.setTranscript([tool.message])
  await vt.waitForRender()
  app.setTranscriptSearchPresentation({
    matchMessages: new Set([tool.message]),
    target: { query: 'needle', match: tool.match, message: tool.message },
    grantReveal: true,
  })
  await vt.waitForRender()
  assert.equal(app.currentFullSearchNotice()?.kind, 'unproven')

  const picker = app.openPicker([{ value: 'opt', label: 'option' }], () => {}, () => {}, { width: 20, maxHeight: 3 })
  await vt.waitForRender()
  assert.equal(app.currentFullSearchNotice(), undefined,
    'another visible modal owns the frame: the Search notice is not current')
  picker.close()
  await vt.waitForRender()
  assert.equal(app.currentFullSearchNotice()?.kind, 'unproven', 'closing the modal restores the honest notice')
  app.stop()
})

test('interaction: the Source-only row keeps the frozen size, theme and icon matrix', async () => {
  const sizes = [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20], [80, 8]] as const
  for (const theme of ['dark', 'light'] as const) {
    for (const iconStyle of ['symbols', 'minimal'] as const) {
      for (const [width, height] of sizes) {
        const vt = new VirtualTerminal(width, height)
        const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
        app.start()
        startedApps.add(app)
        app.setFullscreen(true)
        app.applyTheme(theme)
        app.setIconStyle(iconStyle)
        const tool = unprovenToolTarget()
        app.setTranscript([tool.message])
        await vt.waitForRender()
        app.startTranscriptSearch('full')
        await vt.waitForRender()
        app.setTranscriptSearchPresentation({
          matchMessages: new Set([tool.message]),
          target: { query: 'needle', match: tool.match, message: tool.message },
          grantReveal: true,
        })
        await vt.waitForRender()
        const label = `${theme}/${iconStyle}/${width}x${height}`
        const compact = height <= 10
        assert.equal(overlayBounds(app).height, compact ? 3 : 4, `${label}: the box keeps its real row budget`)
        const lines = vt.getViewport().map(line => stripTerminalSequences(line))
        const notice = lines.find(line => line.includes('Source-only'))
        assert.ok(notice !== undefined, `${label}: the Source-only fact is painted:\n${lines.join('\n')}`)
        assert.ok(!notice.includes('…'), `${label}: required segments are never partially truncated`)
        if (compact) {
          assert.ok(notice.includes('Esc'), `${label}: the compact row keeps the effective close key`)
          assert.ok(notice.includes('Loaded') || notice.includes('Entire'), `${label}: the real coverage truth survives`)
        } else {
          assert.ok(!notice.includes('Loaded'), `${label}: the four-row form keeps the close key on the hint row`)
        }
        assert.ok(lines.some(line => line.includes('[Full]')), `${label}: the scope title survives`)
        assert.ok(lines[overlayBounds(app).row + 1]?.includes('>'), `${label}: the Input row is painted inside the box`)
        assert.equal(app.focusSeatForTest(), 'overlay', `${label}: the Input keeps the seat`)
        app.dispose()
      }
    }
  }
})

test('interaction: an ordinary modal blocks the transcript viewport while search is open', async () => {
  const { vt, app } = startSearchApp()
  await vt.waitForRender()
  app.startTranscriptSearch()
  await vt.waitForRender()
  vt.sendInput('needle')
  await vt.waitForRender()

  const before = scrollTop(app)
  vt.sendInput('\x1b[5~')
  await vt.waitForRender()
  assert.ok(scrollTop(app) < before, 'precondition: the search passthrough pages the transcript')

  const paged = scrollTop(app)
  const picker = app.openPicker([{ value: 'opt', label: 'option' }], () => {}, () => {}, { width: 20, maxHeight: 3 })
  await vt.waitForRender()
  vt.sendInput('\x1b[5~')
  vt.sendInput('\x1b[<64;5;8M')
  await vt.waitForRender()
  assert.equal(scrollTop(app), paged, 'an ordinary modal must block PageUp and the wheel')

  picker.close()
  await vt.waitForRender()
  vt.sendInput('\x1b[5~')
  await vt.waitForRender()
  assert.ok(scrollTop(app) < paged, 'closing the modal restores the search passthrough')
  app.stop()
})

test('interaction: the transcript scrollbar stays hoverable and draggable while search is open', async () => {
  const { vt, app, queries } = startSearchApp()
  await vt.waitForRender()
  app.startTranscriptSearch()
  await vt.waitForRender()
  vt.sendInput('needle')
  await vt.waitForRender()
  const before = scrollTop(app)

  // Hover the right-most column to reveal the auto scrollbar, then press the
  // track well ABOVE the thumb (the view follows the end): the jump/drag must
  // move the transcript without touching the search query or closing the box.
  vt.sendInput('\x1b[<35;80;3M')
  await vt.waitForRender()
  vt.sendInput('\x1b[<0;80;6M')
  await vt.waitForRender()
  assert.ok(scrollTop(app) < before, `the scrollbar track press must scroll the transcript:\n${vt.getViewport().join('\n')}`)
  vt.sendInput('\x1b[<32;80;8M')
  vt.sendInput('\x1b[<0;80;8m')
  await vt.waitForRender()
  assert.equal(app.isSearching(), true, 'the box stays open while dragging the scrollbar')
  assert.equal(queries.at(-1), 'needle', 'dragging the scrollbar never edits the query')
  app.stop()
})

test('interaction: boundary paging reaches the host while search is open', async () => {
  const vt = new VirtualTerminal(80, 24)
  const moves: Array<[-1 | 1, string]> = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSearchQuery: () => {},
    onTranscriptMoveOlder: (source) => { moves.push([-1, source]); return true },
    onTranscriptMoveNewer: (source) => { moves.push([1, source]); return true },
  })
  app.start()
  startedApps.add(app)
  app.setFullscreen(true)
  app.setTranscript(longTranscript())
  await vt.waitForRender()
  app.startTranscriptSearch()
  await vt.waitForRender()

  app.scrollToTop({ disableFollow: true })
  await vt.waitForRender()
  vt.sendInput('\x1b[5~')
  await vt.waitForRender()
  assert.deepEqual(moves, [[-1, 'page']], 'PageUp at the top must reach the host older-boundary callback')

  app.scrollToBottom()
  await vt.waitForRender()
  vt.sendInput('\x1b[6~')
  await vt.waitForRender()
  assert.deepEqual(moves, [[-1, 'page'], [1, 'page']], 'PageDown at the bottom must reach the newer boundary')
  app.stop()
})

test('interaction: View/Full actions and Tab switch one search overlay without exposing fork search', async () => {
  const { vt, app, queries, scopes } = startSearchApp()
  await vt.waitForRender()

  vt.sendInput('\x06') // Ctrl+F -> View
  await vt.waitForRender()
  assert.equal(app.isSearching(), true)
  assert.ok(vt.getViewport().join('\n').includes('[View]'))
  assert.ok(!vt.getViewport().join('\n').includes('Find in transcript'))
  vt.sendInput('needle')
  await vt.waitForRender()
  assert.equal(queries.at(-1), 'needle')
  const overlayHandles = app.overlayGraphState().handles
  app.startTranscriptSearch() // Legacy/plugin entry is Full even when View already owns the overlay.
  await vt.waitForRender()
  assert.deepEqual(scopes, ['full'])
  assert.equal(app.overlayGraphState().handles, overlayHandles, 'legacy Full changes scope in place')
  assert.ok(vt.getViewport().join('\n').includes('needle'), 'the legacy action retains the shared query')

  vt.sendInput('\t')
  await vt.waitForRender()
  assert.deepEqual(scopes, ['full', 'view'])
  let painted = vt.getViewport().join('\n')
  assert.ok(painted.includes('[View]'))
  assert.ok(painted.includes('needle'), 'Tab retains the single search query')

  vt.sendInput('\x1b[102;6u') // Ctrl+Shift+F switches the active View to Full.
  await vt.waitForRender()
  assert.deepEqual(scopes, ['full', 'view', 'full'])
  assert.ok(vt.getViewport().join('\n').includes('[Full]'))

  vt.sendInput('\x06') // Ctrl+F switches the active Full to View.
  await vt.waitForRender()
  assert.deepEqual(scopes, ['full', 'view', 'full', 'view'])
  painted = vt.getViewport().join('\n')
  assert.ok(painted.includes('[View]'))
  assert.ok(painted.includes('needle'))

  vt.sendInput('\t')
  await vt.waitForRender()
  assert.deepEqual(scopes, ['full', 'view', 'full', 'view', 'full'])
  assert.ok(vt.getViewport().join('\n').includes('[Full]'))
  assert.ok(!vt.getViewport().join('\n').includes('Find in transcript'), 'fork search never paints')

  vt.sendInput('\x1b[102;6u') // same active action toggles close
  await vt.waitForRender()
  assert.equal(app.isSearching(), false)
  app.stop()
})

test('interaction: fixed Search scope/navigation/close keys outrank a Jump Latest remap', async () => {
  const { vt, app, scopes, searchSteps, jumpLatest } = startSearchApp()
  await vt.waitForRender()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    'app.transcript.jumpLatest': ['tab', 'enter', 'shift+enter', 'ctrl+c'],
  }))
  await vt.waitForRender()
  app.startTranscriptSearch('view')
  await vt.waitForRender()

  vt.sendInput('\t')
  await vt.waitForRender()
  assert.deepEqual(scopes, ['full'], 'fixed Tab changes View to Full before the colliding Jump Latest action')
  assert.deepEqual(jumpLatest, [], 'Tab never dispatches Jump Latest while Search owns input')

  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(searchSteps, ['next'], 'fixed Enter navigates the active Search scope before Jump Latest')
  assert.deepEqual(jumpLatest, [], 'Enter never dispatches Jump Latest while Search owns input')
  assert.equal(app.isSearching(), true, 'Search remains open after the fixed Next action')

  vt.sendInput('\x1b[13;2u')
  await vt.waitForRender()
  assert.deepEqual(searchSteps, ['next', 'previous'], 'fixed Shift+Enter navigates previous before Jump Latest')
  assert.deepEqual(jumpLatest, [], 'Shift+Enter never dispatches Jump Latest while Search owns input')
  assert.equal(app.isSearching(), true, 'Search remains open after the fixed Previous action')

  vt.sendInput('\x03')
  await vt.waitForRender()
  assert.equal(app.isSearching(), false, 'fixed Ctrl+C closes Search before Jump Latest')
  assert.deepEqual(jumpLatest, [], 'Ctrl+C never dispatches Jump Latest while Search owns input')
  app.stop()
})

test('interaction: legacy Full Ctrl+F override wins the View builtin and remapped-away Full never opens fork search', async () => {
  const { vt, app, scopes } = startSearchApp()
  await vt.waitForRender()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.search': 'ctrl+f' }))
  await vt.waitForRender()

  vt.sendInput('\x06')
  await vt.waitForRender()
  assert.equal(app.isSearching(), true)
  assert.equal(scopes.length, 0, 'the legacy Ctrl+F binding opens Full directly, not View')
  let painted = vt.getViewport().join('\n')
  assert.ok(painted.includes('[Full]'))
  assert.ok(!painted.includes('Find in transcript'))
  app.closeTranscriptSearch()
  await vt.waitForRender()

  vt.sendInput('\x1b[102;6u')
  await vt.waitForRender()
  assert.equal(app.isSearching(), false, 'the replaced Full default does not fall back to View or native search')
  assert.ok(!vt.getViewport().join('\n').includes('Find in transcript'))

  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    'app.transcript.search.view': 'ctrl+g',
    'app.transcript.search': 'ctrl+y',
  }))
  vt.sendInput('\x07')
  await vt.waitForRender()
  assert.equal(app.isSearching(), true, 'Ctrl+G opens the remapped View action')
  app.closeTranscriptSearch()
  await vt.waitForRender()
  vt.sendInput('\x19') // Ctrl+Y opens remapped Full.
  await vt.waitForRender()
  assert.equal(app.isSearching(), true)
  assert.ok(vt.getViewport().join('\n').includes('[Full]'))
  app.stop()
})

test('interaction: the fixed-width theme and glyph matrix keeps one active scope, count, and query focus', async (t) => {
  const sizes = [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20]] as const
  for (const theme of ['dark', 'light'] as const) {
    for (const iconStyle of ['symbols', 'minimal'] as const) {
      for (const [width, height] of sizes) {
        const vt = new VirtualTerminal(width, height)
        let app!: TuiApp
        app = new TuiApp(vt, {
          onSubmit: () => {},
          onExit: () => {},
          onSearchQuery: query => { app.setRenderedViewSearchQuery(query) },
        })
        app.start()
        startedApps.add(app)
        app.setFullscreen(true)
        app.applyTheme(theme)
        app.setIconStyle(iconStyle)
        app.setTranscript([{ kind: 'user', turn: 0, text: 'needle' }])
        await vt.waitForRender()
        vt.sendInput('\x06')
        await vt.waitForRender()
        vt.sendInput('needle')
        await vt.waitForRender()

        const lines = vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/gu, ''))
        const title = lines.find(line => line.includes('View') || line.includes('[V]'))
        const hint = lines.find(line => line.toLowerCase().includes('esc') || line.includes('↵'))
        assert.ok(title !== undefined, `${theme}/${iconStyle}/${width}x${height}: scope title stays visible`)
        assert.match(title, /1\/1/u, `${theme}/${iconStyle}/${width}x${height}: result count is preserved`)
        const active = title.match(/\[(?:View|Full|V|F)\]/gu) ?? []
        assert.equal(active.length, 1, `${theme}/${iconStyle}/${width}x${height}: exactly one scope is active`)
        assert.ok(hint !== undefined, `${theme}/${iconStyle}/${width}x${height}: close/scope guidance survives`)
        assert.ok(!hint.includes('…'), `${theme}/${iconStyle}/${width}x${height}: action hints are not partially truncated`)
        assert.equal(app.focusSeatForTest(), 'overlay', `${theme}/${iconStyle}/${width}x${height}: the Input retains focus`)
        assert.equal(app.isSearching(), true)
        app.dispose()
      }
    }
  }
})
test('interaction: a painted same-layout frame between scope press and release keeps the click', async () => {
  const { vt, app, scopes } = startSearchApp()
  await vt.waitForRender()
  vt.sendInput('\x06')
  await vt.waitForRender()
  const lines = (): string[] => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/gu, ''))
  const titleRow = (): number => lines().findIndex(line => line.includes('[View]'))
  const fullColumn = (): number => {
    const row = lines()[titleRow()]!
    const index = row.indexOf('Full')
    assert.ok(index >= 0, `Full scope control is painted:\n${lines().join('\n')}`)
    return index
  }
  const row = titleRow()
  assert.ok(row >= 0, `View scope title is painted:\n${lines().join('\n')}`)
  const column = fullColumn()

  vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
  app.requestRender()
  await vt.waitForRender()
  vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`)
  await vt.waitForRender()

  assert.deepEqual(scopes, ['full'], 'same-cell release after a same-layout painted frame switches in place')
  assert.ok(lines().some(line => line.includes('[Full]')), 'the Full title becomes the actual painted scope')
  app.stop()
})

test('interaction: clicking the painted scope title switches in place and a cross-scope release is inert', async () => {
  const { vt, app, scopes } = startSearchApp()
  await vt.waitForRender()
  vt.sendInput('\x06')
  await vt.waitForRender()
  vt.sendInput('needle')
  await vt.waitForRender()
  const paintedTitle = (): { row: number; view: number; full: number } => {
    const lines = vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/gu, ''))
    const row = lines.findIndex(line => line.includes('[View]'))
    assert.ok(row >= 0, `the scope title is painted:\n${lines.join('\n')}`)
    const view = lines[row]!.indexOf('[View]')
    const full = lines[row]!.indexOf('Full')
    assert.ok(view >= 0 && full > view)
    return { row, view, full }
  }
  const clickCell = (column: number, row: number): void => {
    const x = column + 1
    const y = row + 1
    vt.sendInput(`\x1b[<0;${x};${y}M`)
    vt.sendInput(`\x1b[<0;${x};${y}m`)
  }

  let title = paintedTitle()
  clickCell(title.view + 1, title.row)
  await vt.waitForRender()
  assert.deepEqual(scopes, [], 'clicking the already active scope is a no-op')

  title = paintedTitle()
  const pressX = title.view + 1
  const releaseX = title.full + 1
  const y = title.row + 1
  vt.sendInput(`\x1b[<0;${pressX};${y}M`)
  vt.sendInput(`\x1b[<0;${releaseX};${y}m`)
  await vt.waitForRender()
  assert.deepEqual(scopes, [], 'pressing one scope and releasing on the other is not a click')

  title = paintedTitle()
  clickCell(title.full + 1, title.row)
  await vt.waitForRender()
  assert.deepEqual(scopes, ['full'])
  assert.ok(vt.getViewport().join('\n').includes('[Full]'))
  assert.ok(vt.getViewport().join('\n').includes('needle'), 'the single query survives pointer scope selection')
  app.stop()
})

test('interaction: background selection copies while an in-box drag never selects the transcript', async () => {
  const { vt, app, copied } = startSearchApp()
  await vt.waitForRender()
  app.startTranscriptSearch()
  await vt.waitForRender()
  vt.sendInput('needle')
  await vt.waitForRender()

  // A drag on a transcript row OUTSIDE the box (the box is top-right) selects
  // and copies the underlying text.
  vt.sendInput('\x1b[<0;1;6M')
  vt.sendInput('\x1b[<32;20;6M')
  vt.sendInput('\x1b[<0;20;6m')
  await vt.waitForRender()
  assert.ok(copied.length >= 1, 'a background drag outside the search box must copy the selection')
  assert.ok(copied.some(text => text.includes('turn ')), `the copied text must be transcript content: ${JSON.stringify(copied)}`)

  // A drag INSIDE the box owns the pointer: no transcript selection/copy.
  const before = copied.length
  vt.sendInput('\x1b[<0;60;2M')
  vt.sendInput('\x1b[<32;70;2M')
  vt.sendInput('\x1b[<0;70;2m')
  await vt.waitForRender()
  assert.equal(copied.length, before, 'an in-box drag must never copy the transcript underneath')
  assert.equal(app.isSearching(), true, 'the in-box drag never closes the box')
  app.stop()
})

// ── The plan-review one-shot inspection over the SAME mounted viewport ────

const PLAN_MD = '# Upgrade 0.5.7\n## Scope\n- goal dock\n- plan review\n## Execution\nship it'

function planTranscript(callId?: string): TranscriptMessage[] {
  return [
    { kind: 'user', turn: 0, text: 'plan the upgrade' },
    { kind: 'assistant', turn: 0, text: 'Here is my plan.' },
    {
      kind: 'tool', turn: 1, name: 'exit_plan_mode', ...(callId === undefined ? {} : { callId }),
      args: JSON.stringify({ plan: PLAN_MD }), result: '', status: 'running',
    },
    ...Array.from({ length: 10 }, (_, i) => ({
      kind: 'user' as const, turn: 2 + i, text: `filler turn ${i} ${'x'.repeat(60)}`,
    })),
  ]
}

function planView(vt: VirtualTerminal): string {
  return stripTerminalSequences(vt.getViewport().join('\n'))
}

interface PlanScene {
  vt: VirtualTerminal
  app: TuiApp
  settle: Promise<{ id: string; selected: string[]; custom?: string }[]>
  cancelled: () => number
}

/** The OFFICIAL Direct `presentCall` shape for exit_plan_mode (what
 * toolPresenterFrom forwards from the host registry). */
const planDirectPresenter = {
  call: (name: string, argsRaw: string) => {
    if (name !== 'exit_plan_mode') return undefined
    const plan = (JSON.parse(argsRaw) as { plan?: string }).plan ?? ''
    const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(plan)?.[1] ?? 'Plan'
    return { card: 'generic' as const, title: heading, kind: 'other' as const, content: [{ type: 'text' as const, text: plan }] }
  },
  result: () => undefined,
}

const SESSION = 'session-plan-review'

function planScene(
  messages: TranscriptMessage[],
  width = 100,
  height = 24,
  options: TuiAppOptions = {},
  /** The official Question's session identity; `null` means "unknown" (an
   * explicit `undefined` argument would re-trigger the default). */
  reviewSessionId: string | null = SESSION,
): PlanScene {
  const vt = new VirtualTerminal(width, height)
  let cancelledCount = 0
  let app!: TuiApp
  app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, options)
  app.start()
  startedApps.add(app)
  // The production identity facts: the live session id on the welcome card and
  // the official Question's own session id in the caller-owned status.
  app.setWelcomeCard({ cwd: '/ws', sessionId: SESSION, version: 'test' })
  app.setFullscreen(true)
  app.setTranscript(messages)
  const settle = app.askQuestions([{
    id: 'plan-review',
    question: 'Approve this plan and leave plan mode?',
    header: 'Plan review',
    detail: PLAN_MD,
    options: [
      { label: 'Approve', description: 'Leave plan mode.' },
      { label: 'Keep planning', description: 'Stay in plan mode.' },
    ],
    intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan-1' },
  }], undefined, reviewSessionId === null ? {} : { reviewSessionId }, false)
  return { vt, app, settle, cancelled: () => cancelledCount }
}

test('View plan reveals the called plan card body in the planTranscript and the answer still settles', async () => {
  // The REAL Direct presenter seam: the plan body comes from the official
  // generic call planView, not from a test-only synthetic card.
  const { vt, app, settle } = planScene(planTranscript('call-plan-1'), 100, 24, { present: planDirectPresenter })
  await vt.waitForRender()
  // Park the viewport at the bottom so the reveal scroll is observable.
  app.scrollToBottom({ disableFollow: true })
  await vt.waitForRender()
  const parked = app.fullscreenScrollForTest()?.scrollTop ?? 0
  assert.ok(!planView(vt).includes('## Scope'), 'precondition: the plan body row is out of planView before the reveal')
  // Enter on the default View row triggers the inspection + reading step.
  vt.sendInput('\r')
  await vt.waitForRender()
  const reading = planView(vt)
  assert.ok(reading.includes('Reading the submitted plan'), `reading step must render:\n${reading}`)
  const after = app.fullscreenScrollForTest()?.scrollTop ?? -1
  assert.ok(after < parked, `the reveal must scroll up to the plan card (parked=${parked}, after=${after})`)
  assert.ok(planView(vt).includes('## Scope'), `the revealed card shows the plan body, not just its header:\n${planView(vt)}`)
  // Esc returns to the decision list; the question is still answerable.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  const decision = planView(vt)
  assert.ok(decision.includes('View plan'), `Esc returns to the decision list:\n${decision}`)
  // ↓↓ to Approve, Enter — the official settle path.
  vt.sendInput('\x1b[B')
  vt.sendInput('\x1b[B')
  vt.sendInput('\r')
  const answers = await settle
  assert.deepEqual(answers, [{ id: 'plan-review', selected: ['Approve'] }])
  app.stop()
})

test('the Remote client presenter path also reveals the full plan body (no Host registry)', async () => {
  // The Remote branch has no Host tool registry: createClientToolPresenter
  // derives the generic card from the logged arguments instead.
  const remote = createClientToolPresenter()
  const { vt, app, settle } = planScene(planTranscript('call-plan-1'), 100, 24, { present: remote })
  await vt.waitForRender()
  app.scrollToBottom({ disableFollow: true })
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(planView(vt).includes('## Scope'), `the Remote-derived card must show the plan body:\n${planView(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  vt.sendInput('\x1b[B')
  vt.sendInput('\r')
  const answers = await settle
  assert.deepEqual(answers, [{ id: 'plan-review', selected: ['Approve'] }])
  app.stop()
})

test('a missing plan card (no logged call) degrades View to the question-detail fallback', async () => {
  // No callId on the card: the inspection cannot prove the target.
  const { vt, app, settle } = planScene(planTranscript())
  await vt.waitForRender()
  vt.sendInput('\r') // Enter on View
  await vt.waitForRender()
  const fallback = planView(vt)
  assert.ok(fallback.includes('Full review text'), `the fallback page renders:\n${fallback}`)
  assert.ok(fallback.includes('# Upgrade 0.5.7'), `the fallback shows the plan body:\n${fallback}`)
  // Esc back, then Keep planning with feedback — the settle still works.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // Keep planning…
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('w')
  vt.sendInput('o')
  vt.sendInput('r')
  vt.sendInput('k')
  vt.sendInput('\r')
  const answers = await settle
  assert.deepEqual(answers, [{ id: 'plan-review', selected: ['Keep planning'], custom: 'work' }])
  app.stop()
})

test('a long plan fallback pages to the very tail (no 256-row silent cut)', async () => {
  // 400 plan lines: far beyond the generic page cap. The fallback must reach
  // the LAST line by paging, and must never claim the tail is visible early.
  const lines = Array.from({ length: 400 }, (_, i) => `step line ${i} unique-marker-${i}`)
  const longPlan = `# Long Plan\n${lines.join('\n')}`
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setWelcomeCard({ cwd: '/ws', sessionId: SESSION, version: 'test' })
  app.setFullscreen(true)
  // No logged call for this question: View CANNOT locate a card.
  app.setTranscript(planTranscript())
  const settle = app.askQuestions([{
    id: 'plan-review',
    question: 'Approve this plan and leave plan mode?',
    header: 'Plan review',
    detail: longPlan,
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: 'Approve' },
  }], undefined, { reviewSessionId: SESSION }, false)
  await vt.waitForRender()
  vt.sendInput('\r') // View -> fallback (no provable target)
  await vt.waitForRender()
  assert.ok(planView(vt).includes('Full review text'), `the fallback must render:\n${planView(vt)}`)
  assert.ok(!planView(vt).includes('unique-marker-399'), 'precondition: the tail starts hidden')
  // Page down until the LAST line is visible (bounded: a silent cap fails
  // loudly instead of hanging).
  for (let page = 0; page < 60 && !planView(vt).includes('unique-marker-399'); page += 1) {
    vt.sendInput('\x1b[6~') // PageDown
    await vt.waitForRender()
  }
  assert.ok(planView(vt).includes('unique-marker-399'), `the fallback tail must be reachable:\n${planView(vt)}`)
  // Paging never settles the question: Esc back, then the official dismiss.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await settle.then(() => {}, () => {})
  app.stop()
})

test('settling the plan question releases the temporary reveal and forced sub-call', async () => {
  const root: Extract<TranscriptMessage, { kind: 'tool' }> = {
    kind: 'tool', turn: 1, name: 'run_code', callId: 'call-root',
    args: '{}', result: '', status: 'running',
    subCalls: [{
      kind: 'tool', turn: 1, name: 'exit_plan_mode', subCallId: 'call-plan-1',
      parentCallId: 'call-root', rootCallId: 'call-root',
      args: JSON.stringify({ plan: PLAN_MD }), result: '', status: 'running',
    }],
  }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 0, text: 'plan via run_code' },
    root,
  ]
  const { vt, app, settle } = planScene(messages)
  await vt.waitForRender()
  // Enter View (inspection + reading), then Esc back, then Esc dismiss — the
  // question settles and the reveal must be gone.
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(planView(vt).includes('Reading the submitted plan'))
  vt.sendInput('\x1b') // reading → decision
  await vt.waitForRender()
  vt.sendInput('\x1b') // decision → official dismiss
  await settle.then(() => {}, () => {})
  await vt.waitForRender()
  assert.equal(app.transcriptSearchPresentationForTest(), undefined,
    'the settled plan question must leave no search presentation behind')
  const internals = app as unknown as { planInspection?: unknown; subCallExpanded: Set<string> }
  assert.equal(internals.planInspection, undefined,
    'the one-shot plan inspection presentation must be released on settle')
  assert.equal(internals.subCallExpanded.has('call-plan-1'), false,
    'the plan inspection never mints a durable sub-call expansion')
  app.stop()
})

test('an identity mismatch fails closed to the detail fallback (no reveal, no scroll)', async () => {
  const { vt, app, settle } = planScene(planTranscript('call-plan-1'), 100, 24, { present: planDirectPresenter }, 'session-other')
  await vt.waitForRender()
  app.scrollToBottom({ disableFollow: true })
  await vt.waitForRender()
  const parked = app.fullscreenScrollForTest()?.scrollTop ?? -1
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(planView(vt).includes('Full review text'), `the mismatch degrades to the fallback:\n${planView(vt)}`)
  assert.equal((app as unknown as { planInspection?: unknown }).planInspection, undefined,
    'a failed locate commits no inspection presentation')
  assert.equal(app.fullscreenScrollForTest()?.scrollTop, parked,
    'a failed locate never moves the planTranscript viewport')
  assert.equal(app.transcriptSearchPresentationForTest(), undefined,
    'a failed locate creates no search presentation')
  vt.sendInput('\x1b') // back to the decision list
  await vt.waitForRender()
  vt.sendInput('\x1b') // official dismiss
  await settle.then(() => {}, () => {})
  app.stop()
})

test('an unknown Question session identity fails closed (no callId-only locate)', async () => {
  const { vt, app, settle } = planScene(planTranscript('call-plan-1'), 100, 24, { present: planDirectPresenter }, null)
  await vt.waitForRender()
  app.scrollToBottom({ disableFollow: true })
  await vt.waitForRender()
  const parked = app.fullscreenScrollForTest()?.scrollTop ?? -1
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(planView(vt).includes('Full review text'), `an unknown identity degrades to the fallback:\n${planView(vt)}`)
  assert.equal((app as unknown as { planInspection?: unknown }).planInspection, undefined,
    'an unproven identity commits no inspection presentation')
  assert.equal(app.fullscreenScrollForTest()?.scrollTop, parked,
    'an unproven identity never moves the planTranscript viewport')
  vt.sendInput('\x1b') // back to the decision list
  await vt.waitForRender()
  vt.sendInput('\x1b') // official dismiss
  await settle.then(() => {}, () => {})
  app.stop()
})

test('the inspection matches a nested PTC sub-call by its subCallId and shows the plan body', async () => {
  // Build a PTC root whose nested sub-call is the exit_plan_mode card.
  const root: Extract<TranscriptMessage, { kind: 'tool' }> = {
    kind: 'tool', turn: 1, name: 'run_code', callId: 'call-root',
    args: '{}', result: '', status: 'running',
    subCalls: [{
      kind: 'tool', turn: 1, name: 'exit_plan_mode', subCallId: 'call-plan-1',
      parentCallId: 'call-root', rootCallId: 'call-root',
      args: JSON.stringify({ plan: PLAN_MD }), result: '', status: 'running',
    }],
  }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 0, text: 'plan via run_code' },
    root,
    ...Array.from({ length: 10 }, (_, i) => ({
      kind: 'user' as const, turn: 2 + i, text: `filler ${i}`,
    })),
  ]
  const { vt, app, settle } = planScene(messages, 100, 24, { present: planDirectPresenter })
  await vt.waitForRender()
  app.scrollToBottom({ disableFollow: true })
  await vt.waitForRender()
  vt.sendInput('\r') // View
  await vt.waitForRender()
  const reading = planView(vt)
  assert.ok(reading.includes('Reading the submitted plan'), `the nested sub-call locates:\n${reading}`)
  // The RUNNING nested call's plan body comes from the presenter's generic
  // planView of the call arguments (never from a result that does not exist yet).
  assert.ok(reading.includes('## Scope'), `the nested card must show the plan body:\n${reading}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  vt.sendInput('\x1b[B')
  vt.sendInput('\r')
  const answers = await settle
  assert.deepEqual(answers, [{ id: 'plan-review', selected: ['Approve'] }])
  app.stop()
})

test('Focus collapsed Thought: View opens the owner Thought and locates the card', async () => {
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 0, text: 'plan the upgrade' },
    { kind: 'thinking', turn: 1, text: 'planning the upgrade carefully' },
    {
      kind: 'tool', turn: 1, name: 'exit_plan_mode', callId: 'call-plan-1',
      args: JSON.stringify({ plan: PLAN_MD }), result: '', status: 'running',
    },
    ...Array.from({ length: 8 }, (_, i) => ({
      kind: 'user' as const, turn: 2 + i, text: `filler turn ${i} ${'x'.repeat(60)}`,
    })),
  ]
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { present: planDirectPresenter })
  app.start()
  startedApps.add(app)
  app.setWelcomeCard({ cwd: '/ws', sessionId: SESSION, version: 'test' })
  app.setFocusMode(true)
  app.setFullscreen(true)
  const activities = new Map([[1, { turn: 1, completed: false, think: { text: 'planning the upgrade carefully', running: true } }]])
  app.setTranscript(messages, activities as never)
  const settle = app.askQuestions([{
    id: 'plan-review', question: 'Approve?', header: 'Plan review', detail: PLAN_MD,
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan-1' },
  }], undefined, { reviewSessionId: SESSION }, false)
  await vt.waitForRender()
  assert.ok(!planView(vt).includes('## Scope'), 'precondition: the collapsed Thought hides the plan card')
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(planView(vt).includes('Reading the submitted plan'), `the Focus reveal must locate the card:\n${planView(vt)}`)
  assert.ok(planView(vt).includes('## Scope'), `the plan body must be materialized inside the opened Thought:\n${planView(vt)}`)
  // A REAL header click on the (temporarily opened) Thought must COLLAPSE the
  // temporary reveal, never write a manual expansion.
  app.toggleFocusTurn(1)
  await vt.waitForRender()
  assert.ok(!planView(vt).includes('## Scope'), `the Thought click collapsed the temporary reveal:\n${planView(vt)}`)
  assert.equal(app.focusExpandedTurnsForTest().has(1), false,
    'the user collapse never writes a manual Focus expansion')
  // Back to the decision list, then a NEW View re-opens the Thought and card.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(planView(vt).includes('## Scope'), `a new View re-opens the Focus card:\n${planView(vt)}`)
  // The Ctrl+O Collapse All path (the modal inspection allowlist) is the SAME
  // explicit-collapse owner: it must revoke the plan lease and hide the card.
  ;(app as unknown as { collapseAllFullscreenFocusRoots(): void }).collapseAllFullscreenFocusRoots()
  await vt.waitForRender()
  assert.ok(!planView(vt).includes('## Scope'), `Collapse All revokes the plan lease:\n${planView(vt)}`)
  assert.equal((app as unknown as { planInspection?: unknown }).planInspection, undefined,
    'Collapse All revoked the one-shot lease')
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'Collapse All wrote no manual expansion')
  // A new View re-opens it again.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(planView(vt).includes('## Scope'), `a new View re-opens after Collapse All:\n${planView(vt)}`)
  vt.sendInput('\x1b') // back to the decision list
  await vt.waitForRender()
  vt.sendInput('\x1b') // official dismiss
  await settle.then(() => {}, () => {})
  assert.equal(app.focusExpandedTurnsForTest().size, 0,
    'the inspection never writes a manual Focus expansion')
  app.stop()
})

test('a REAL user collapse during reading wins (both disclosure branches); a NEW View re-opens', async () => {
  const messages = planTranscript('call-plan-1')
  const card = messages.find(
    (m): m is Extract<TranscriptMessage, { kind: 'tool' }> => m.kind === 'tool' && m.name === 'exit_plan_mode',
  )!
  const { vt, app, settle } = planScene(messages, 100, 24, { present: planDirectPresenter })
  await vt.waitForRender()
  const toggle = (): void => {
    ;(app as unknown as { toggleMessageExpanded(message: TranscriptMessage): void }).toggleMessageExpanded(card)
  }
  // Branch 1: the user OPENS the card before View (a durable `true` override),
  // then View, then the SAME disclosure route collapses it during reading.
  toggle()
  await vt.waitForRender()
  assert.equal((app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride.get(card), true,
    'the user opened the card before View (durable disclosure owner)')
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(planView(vt).includes('Reading the submitted plan'), `the located reading step:\n${planView(vt)}`)
  toggle() // first click during reading must collapse, not be re-opened by the lease
  await vt.waitForRender()
  assert.ok(!planView(vt).includes('## Scope'), `the first real collapse click wins over the plan lease:\n${planView(vt)}`)
  assert.ok(planView(vt).includes('Reading the submitted plan'), 'the reading step itself survives the collapse')
  // Esc back, then a NEW explicit View re-opens the card.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(planView(vt).includes('## Scope'), `a new View re-opens the card:\n${planView(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await settle.then(() => {}, () => {})
  app.stop()
})

test('a PTC child collapsed during reading stays folded; a new View re-opens it', async () => {
  const root: Extract<TranscriptMessage, { kind: 'tool' }> = {
    kind: 'tool', turn: 1, name: 'run_code', callId: 'call-root',
    args: '{}', result: '', status: 'running',
    subCalls: [{
      kind: 'tool', turn: 1, name: 'exit_plan_mode', subCallId: 'call-plan-1',
      parentCallId: 'call-root', rootCallId: 'call-root',
      args: JSON.stringify({ plan: PLAN_MD }), result: '', status: 'running',
    }],
  }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 0, text: 'plan via run_code' },
    root,
  ]
  const { vt, app, settle } = planScene(messages, 100, 24, { present: planDirectPresenter })
  // The user MANUALLY expands the child BEFORE View: the durable branch of the
  // disclosure toggle must also revoke the lease when it collapses the child.
  ;(app as unknown as { toggleSubCallExpanded(subCallId: string): void }).toggleSubCallExpanded('call-plan-1')
  await vt.waitForRender()
  assert.equal((app as unknown as { subCallExpanded: Set<string> }).subCallExpanded.has('call-plan-1'), true,
    'precondition: the child is manually expanded before View')
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(planView(vt).includes('## Scope'), `precondition: the nested body is visible:\n${planView(vt)}`)
  // The same disclosure route collapses it during reading.
  ;(app as unknown as { toggleSubCallExpanded(subCallId: string): void }).toggleSubCallExpanded('call-plan-1')
  await vt.waitForRender()
  assert.ok(!planView(vt).includes('## Scope'), `an explicit child collapse during reading wins:\n${planView(vt)}`)
  assert.equal((app as unknown as { subCallExpanded: Set<string> }).subCallExpanded.has('call-plan-1'), false,
    'the durable manual expansion is removed by the collapse')
  assert.equal((app as unknown as { planInspection?: unknown }).planInspection, undefined,
    'an explicit child collapse revokes the one-shot lease for the rest of the reading step')
  // A new explicit View re-opens it.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(planView(vt).includes('## Scope'), `a new View re-opens the nested card:\n${planView(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await settle.then(() => {}, () => {})
  app.stop()
})

test('a QUEUED plan-review question mounts with the live View capability (FIFO handover)', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { present: planDirectPresenter })
  app.start()
  startedApps.add(app)
  app.setWelcomeCard({ cwd: '/ws', sessionId: SESSION, version: 'test' })
  app.setFullscreen(true)
  app.setTranscript(planTranscript('call-plan-1'))
  await vt.waitForRender()
  // A normal question owns the seat first; the plan review is queued behind it.
  const first = app.askQuestions([{
    id: 'q1',
    question: 'Pick one',
    options: [{ label: 'A' }, { label: 'B' }],
  }])
  await vt.waitForRender()
  const plan = app.askQuestions([{
    id: 'plan-review', question: 'Approve?', header: 'Plan review', detail: PLAN_MD,
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan-1' },
  }], undefined, { reviewSessionId: SESSION }, false)
  await vt.waitForRender()
  // Settle the first question: select A, then submit on the review page.
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('\r')
  const firstAnswers = await first
  assert.deepEqual(firstAnswers, [{ id: 'q1', selected: ['A'] }])
  await vt.waitForRender()
  // The handed-over plan review must render the FULL decision list (View first).
  const handed = planView(vt)
  assert.ok(handed.includes('View plan'), `a queued plan review must offer View plan:\n${handed}`)
  const rows = stripTerminalSequences(vt.getViewport().join('\n')).split('\n')
  const viewRow = rows.findIndex(row => row.includes('> View plan'))
  assert.ok(viewRow >= 0, `View plan holds the default cursor after the handover:\n${handed}`)
  // And it really locates the card.
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(planView(vt).includes('Reading the submitted plan'), `the handed-over flow reads:\n${planView(vt)}`)
  assert.ok(planView(vt).includes('## Scope'), `the handed-over flow locates the body:\n${planView(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  vt.sendInput('\x1b[B')
  vt.sendInput('\r')
  const planAnswers = await plan
  assert.deepEqual(planAnswers, [{ id: 'plan-review', selected: ['Approve'] }])
  app.stop()
})

test('a long PTC plan line wraps and its tail is reachable by scrolling (80 columns)', async () => {
  // One LONG paragraph line: a per-line truncation would permanently lose the
  // tail, so the only readable proof is the unique marker at its end.
  const longLine = `${'scope item '.repeat(18)}tail-marker-xyz`
  const longPlan = `# Long Plan\n${longLine}`
  const root: Extract<TranscriptMessage, { kind: 'tool' }> = {
    kind: 'tool', turn: 1, name: 'run_code', callId: 'call-root',
    args: '{}', result: '', status: 'running',
    subCalls: [{
      kind: 'tool', turn: 1, name: 'exit_plan_mode', subCallId: 'call-plan-1',
      parentCallId: 'call-root', rootCallId: 'call-root',
      args: JSON.stringify({ plan: longPlan }), result: '', status: 'running',
    }],
  }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 0, text: 'plan via run_code' },
    root,
  ]
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { present: planDirectPresenter })
  app.start()
  startedApps.add(app)
  app.setWelcomeCard({ cwd: '/ws', sessionId: SESSION, version: 'test' })
  app.setFullscreen(true)
  app.setTranscript(messages)
  const settle = app.askQuestions([{
    id: 'plan-review', question: 'Approve?', header: 'Plan review', detail: longPlan,
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan-1' },
  }], undefined, { reviewSessionId: SESSION }, false)
  await vt.waitForRender()
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(planView(vt).includes('Reading the submitted plan'), `the nested card locates:\n${planView(vt)}`)
  // The wrapped tail starts below the viewport; the reading step's own page
  // keys scroll the planTranscript until the marker becomes readable.
  for (let page = 0; page < 12 && !planView(vt).includes('tail-marker-xyz'); page += 1) {
    vt.sendInput('\x1b[6~') // PageDown (reading step → planTranscript viewport)
    await vt.waitForRender()
  }
  assert.ok(planView(vt).includes('tail-marker-xyz'), `the wrapped tail must be readable at 80 columns:\n${planView(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await settle.then(() => {}, () => {})
  app.stop()
})

test('a PTC target located below many earlier siblings scrolls to the CHILD row, not the root top', async () => {
  // 40 collapsed sibling sub-calls render one header row each before the
  // target: measuring only the ROOT card's top would leave the plan body far
  // below the viewport while still claiming "located".
  const filler = Array.from({ length: 40 }, (_, i) => ({
    kind: 'tool' as const, turn: 1, name: 'read', subCallId: `filler-${i}`,
    parentCallId: 'call-root', rootCallId: 'call-root',
    args: JSON.stringify({ path: `src/f${i}.ts` }), result: '', status: 'ok' as const,
  }))
  const root: Extract<TranscriptMessage, { kind: 'tool' }> = {
    kind: 'tool', turn: 1, name: 'run_code', callId: 'call-root',
    args: '{}', result: '', status: 'running',
    subCalls: [
      ...filler,
      {
        kind: 'tool', turn: 1, name: 'exit_plan_mode', subCallId: 'call-plan-1',
        parentCallId: 'call-root', rootCallId: 'call-root',
        args: JSON.stringify({ plan: PLAN_MD }), result: '', status: 'running',
      },
    ],
  }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 0, text: 'plan via run_code with many siblings' },
    root,
  ]
  const { vt, app, settle } = planScene(messages, 100, 24, { present: planDirectPresenter })
  await vt.waitForRender()
  assert.ok(!planView(vt).includes('## Scope'), 'precondition: the target body is out of planView')
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(planView(vt).includes('Reading the submitted plan'), `the reading step renders:\n${planView(vt)}`)
  assert.ok(planView(vt).includes('## Scope'), `the ONE locate lands on the child row (not the root top):\n${planView(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await settle.then(() => {}, () => {})
  app.stop()
})

test('Compact Work sibling: the plan reveal opens the Work span and a real header click collapses it', async () => {
  const messages = planTranscript('call-plan-1')
  const card = messages.find(
    (m): m is Extract<TranscriptMessage, { kind: 'tool' }> => m.kind === 'tool' && m.name === 'exit_plan_mode',
  )!
  const { vt, app, settle } = planScene(messages, 100, 24, { present: planDirectPresenter })
  app.setDisplayPreset('compact')
  await vt.waitForRender()
  assert.ok(!planView(vt).includes('## Scope'), `precondition: the collapsed Work span hides the card:\n${planView(vt)}`)
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(planView(vt).includes('## Scope'), `the plan reveal opens the Work span:\n${planView(vt)}`)
  // A REAL Work header click collapses the temporary reveal.
  const owner = (app as unknown as {
    canonicalStructureIndex(): { workByMember: Map<TranscriptMessage, { owner: TranscriptMessage }> }
  }).canonicalStructureIndex().workByMember.get(card)?.owner
  assert.ok(owner !== undefined, 'fixture: the card belongs to a Work span')
  app.toggleWorkSpan(owner)
  await vt.waitForRender()
  assert.ok(!planView(vt).includes('## Scope'), `the Work header click collapsed the reveal:\n${planView(vt)}`)
  assert.equal((app as unknown as { planInspection?: unknown }).planInspection, undefined,
    'the Work collapse revoked the plan lease')
  // A new View re-opens the Work span and the card.
  vt.sendInput('\x1b') // back to the decision list
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(planView(vt).includes('## Scope'), `a new View re-opens the Compact card:\n${planView(vt)}`)
  // The Ctrl+O BULK sibling (the real modal-safe planTranscript disclosure) must
  // revoke the plan lease in the SAME transaction.
  vt.sendInput('\x0f') // Ctrl+O → collapse all open Work spans
  await vt.waitForRender()
  assert.ok(!planView(vt).includes('## Scope'), `the Ctrl+O bulk collapse revokes the plan lease:\n${planView(vt)}`)
  assert.equal((app as unknown as { planInspection?: unknown }).planInspection, undefined,
    'the bulk collapse revoked the one-shot lease')
  // A new View re-opens it again.
  vt.sendInput('\x1b') // back to the decision list
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(planView(vt).includes('## Scope'), `a new View re-opens after the bulk collapse:\n${planView(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await settle.then(() => {}, () => {})
  app.stop()
})
