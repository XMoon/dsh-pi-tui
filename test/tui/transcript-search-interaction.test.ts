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
  readonly submits: string[]
  readonly copied: string[]
}

function startSearchApp(width = 80, height = 24): Harness {
  const vt = new VirtualTerminal(width, height)
  const queries: string[] = []
  const submits: string[] = []
  const copied: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => { submits.push(text) },
    onExit: () => {},
    onSearchQuery: (query) => { queries.push(query) },
  }, {
    copySelection: async (text) => { copied.push(text); return true },
  })
  app.start()
  startedApps.add(app)
  app.setFullscreen(true)
  app.setTranscript(longTranscript())
  return { vt, app, queries, submits, copied }
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

test('interaction: the Host search shortcut opens the Host box and never the fork native search', async () => {
  const { vt, app, queries } = startSearchApp()
  await vt.waitForRender()

  // Ctrl+F (Host default) and Ctrl+Shift+F (the default shared with the fork's
  // native tui.altScreen.search) must both resolve to the Host box: the Host
  // query is the only search surface over the full folded transcript.
  for (const key of ['\x06', '\x1b[102;6u']) {
    vt.sendInput(key)
    await vt.waitForRender()
    assert.equal(app.isSearching(), true, `${JSON.stringify(key)} must open the Host search box`)
    const painted = vt.getViewport().join('\n')
    assert.ok(painted.includes('Find transcript'), 'the Host box must be painted')
    assert.ok(!painted.includes('Find in transcript'), 'the fork native search must never be painted')
    assert.ok(!painted.includes('Shift+Enter'), 'the fork native navigation row must never be painted')
    vt.sendInput('needle')
    await vt.waitForRender()
    assert.equal(queries.at(-1), 'needle', 'the Host query must receive the typing')
    app.closeTranscriptSearch()
    await vt.waitForRender()
    assert.equal(app.isSearching(), false, 'precondition: the box closes before the next key')
  }

  // Negative control: with the Host action remapped, the old defaults stay
  // suppressed — an old default must never silently re-enable the fork's
  // rendered-line search, and must not reach the Host query either.
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.search': 'ctrl+g' }))
  queries.length = 0
  for (const key of ['\x06', '\x1b[102;6u']) {
    vt.sendInput(key)
    await vt.waitForRender()
    assert.equal(app.isSearching(), false, `${JSON.stringify(key)} must open nothing once remapped`)
    const painted = vt.getViewport().join('\n')
    assert.ok(!painted.includes('Find in transcript'), 'the fork native search must stay suppressed after a remap')
    assert.ok(!painted.includes('Shift+Enter'), 'the fork native navigation row must stay suppressed after a remap')
    vt.sendInput('zzz')
    await vt.waitForRender()
  }
  assert.deepEqual(queries, [], 'a suppressed key must never reach the Host query')
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
