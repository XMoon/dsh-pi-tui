/**
 * Fullscreen transcript-search interaction contract (perf plan S4 §7 / §10.4):
 * the search box keeps KEYBOARD focus, but the transcript viewport stays
 * interactive — wheel, PageUp/PageDown, scrollbar, background disclosure and
 * selection — while the editor stays locked behind the modal.
 * @module @xmoon76/dsh-pi-tui/transcript-search-interaction.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { TuiApp } from '../../src/tui-app.ts'
import { parseUserKeybindings } from '../../src/tui/keybindings/config.ts'
import type { TranscriptMessage } from '../../src/transcript.ts'
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
