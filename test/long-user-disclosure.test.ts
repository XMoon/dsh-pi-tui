/**
 * Long user-message disclosure: a text-only durable user prompt whose
 * render-time VISUAL ROW COUNT exceeds the threshold renders head + compact
 * marker + tail, `Ctrl+O` expands it (recent-turn fold master), the
 * fullscreen compact marker row alone is clickable, and a search hit in the
 * hidden middle expands the bubble. The canonical `TranscriptMessage.text`
 * is never touched — compaction is a UserBubble presentation only.
 * @module @xmoon76/dsh-pi-tui/long-user-disclosure.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import type { TranscriptMessage } from '../src/transcript.ts'
import { TuiApp, UserBubbleComponent } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { Text } from '@xmoon76/pi-tui'

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

async function viewRows(vt: VirtualTerminal): Promise<string[]> {
  await vt.waitForRender()
  return vt.getViewport().map(line => stripTerminalSequences(line).replace(/[│┃█]$/, '').trimEnd())
}

/** SGR primary-button press+release at a 0-based viewport cell. */
function clickCell(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
}

/** N short logical lines (`line1\nline2\n…`) — one visual row each. */
function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, index) => `${prefix}${index + 1}`).join('\n')
}

function user(text: string, turn = 0): Extract<TranscriptMessage, { kind: 'user' }> {
  return { kind: 'user', turn, text }
}

function compactMarkerCount(rows: readonly string[]): number {
  return rows.filter(row => row.includes('rows compacted')).length
}

// ── Component: render-time visual-row compaction ─────────────────────────

function renderBubble(
  component: UserBubbleComponent,
  width: number,
): { rows: string[]; markerRow: number | undefined } {
  const rows = component.render(width).map(line => line.trimEnd())
  return { rows, markerRow: component.compactMarkerRow() }
}

function newBubble(text: string, marker?: (hidden: number, available: number) => string): UserBubbleComponent {
  return new UserBubbleComponent(new Text(text, 0, 0), '❯ ', (value) => value, {
    thresholdRows: 10,
    headRows: 4,
    tailRows: 3,
    compactMarker: marker ?? ((hidden) => `MARK ${hidden}`),
  })
}

test('component: exactly the row threshold stays full; one more row compacts', () => {
  const full = renderBubble(newBubble(lines(10)), 40)
  assert.equal(full.rows.length, 10, '10 visual rows must render fully')
  assert.equal(full.markerRow, undefined)

  const compact = renderBubble(newBubble(lines(11)), 40)
  assert.equal(compact.rows.length, 8, 'head 4 + marker 1 + tail 3')
  assert.equal(compact.markerRow, 4)
  assert.deepEqual(compact.rows.slice(0, 4), ['❯ line1', '  line2', '  line3', '  line4'])
  assert.equal(compact.rows[4], '  MARK 4')
  assert.deepEqual(compact.rows.slice(-3), ['  line9', '  line10', '  line11'])
})

test('component: blank rows are preserved in the head and tail', () => {
  const text = ['h1', '', 'h3', 'h4', 'm5', 'm6', 'm7', 'm8', 't9', '', 't11', 't12'].join('\n')
  const { rows, markerRow } = renderBubble(newBubble(text), 40)
  assert.equal(rows.length, 8)
  assert.equal(markerRow, 4)
  assert.equal(rows[1], '', 'the blank head row must survive')
  assert.equal(rows[5], '', 'the blank tail row must survive')
  assert.equal(rows[6], '  t11')
  assert.equal(rows[7], '  t12')
})

test('component: the SAME component re-decides compaction after a resize', () => {
  const text = Array.from({ length: 8 }, () => 'x'.repeat(100)).join('\n')
  const component = newBubble(text)
  // Wide: each 100-char line is one row → 8 rows → full.
  renderBubble(component, 180)
  assert.equal(component.compactMarkerRow(), undefined)
  // Narrow: each line wraps to two rows → 16 rows → compact.
  const narrow = renderBubble(component, 80)
  assert.equal(narrow.markerRow, 4)
  assert.equal(narrow.rows.length, 8, 'no stale full render after narrowing')
  // Wide again: the fold decision is recomputed, never cached by width.
  renderBubble(component, 180)
  assert.equal(component.compactMarkerRow(), undefined)
})

test('component: CJK / wide emoji rows stay within the inner width', () => {
  const cjk = Array.from({ length: 6 }, (_, index) => `第${index + 1}行` + '好'.repeat(58)).join('\n')
  const { rows, markerRow } = renderBubble(newBubble(cjk), 80)
  assert.equal(markerRow, 4, '12 wrapped CJK rows must compact')
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= 80, `row exceeds the bubble width: ${JSON.stringify(row)}`)
  }
  const emoji = Array.from({ length: 8 }, () => '🙂'.repeat(60)).join('\n')
  const wide = renderBubble(newBubble(emoji), 80)
  assert.equal(wide.markerRow, 4)
  for (const row of wide.rows) {
    assert.ok(visibleWidth(row) <= 80, `wide-cell row exceeds the bubble width: ${JSON.stringify(row)}`)
  }
})

test('component: the marker falls back to the short form and never overflows', () => {
  const component = newBubble(lines(30), (hidden, available) => {
    const full = `── ${hidden} rows compacted · ctrl+o to expand ──`
    return full.length <= available ? full : `── ${hidden} rows compacted ──`
  })
  const wide = renderBubble(component, 40)
  assert.ok(wide.rows[4]!.includes('rows compacted'))
  assert.ok(!wide.rows[4]!.includes('to expand'), 'the verb is dropped when it cannot fit')
  // An extreme width clips the marker instead of wrapping/overflowing it.
  const narrow = renderBubble(component, 20)
  assert.ok(visibleWidth(narrow.rows[4]!) <= 20, `the marker must be clipped: ${JSON.stringify(narrow.rows[4])}`)
})

// ── App: regular surface disclosure ──────────────────────────────────────

test('regular: a short user prompt is unchanged (no marker)', async () => {
  const { vt, app } = startApp()
  app.setTranscript([user('hello\nworld\nthird')])
  const rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('hello')))
  assert.ok(rows.some(row => row.includes('third')))
  assert.equal(compactMarkerCount(rows), 0)
  app.stop()
})

test('regular: a long prompt shows head + marker + tail with the Ctrl+O hint', async () => {
  const { vt, app } = startApp()
  app.setTranscript([user(lines(40))])
  const rows = await viewRows(vt)
  const view = rows.join('\n')
  assert.ok(view.includes('line1') && view.includes('line4'), 'head rows visible')
  assert.ok(view.includes('line38') && view.includes('line40'), 'tail rows visible')
  assert.ok(!view.includes('line20'), 'the middle is hidden')
  assert.ok(view.includes('33 rows compacted'), 'the marker counts the hidden VISUAL rows')
  assert.ok(view.includes('ctrl+o to expand'), 'the regular hint resolves the effective key')
  app.stop()
})

test('regular: the trailing user instruction stays visible below a bulk paste', async () => {
  const { vt, app } = startApp(100, 24)
  const text = [
    'help me read this log:',
    ...Array.from({ length: 70 }, (_, index) => `log ${index + 1}`),
    'note: it only happens on Debian 13',
  ].join('\n')
  app.setTranscript([user(text)])
  const rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('only happens on Debian 13')), 'the tail instruction is visible')
  assert.ok(rows.some(row => row.includes('rows compacted')))
  app.stop()
})

test('regular: Ctrl+O expands the full text and collapses back to compact', async () => {
  const { vt, app } = startApp()
  app.setTranscript([user(lines(11))])
  assert.ok(!(await viewRows(vt)).some(row => row.includes('line5')), 'collapsed hides the middle')

  vt.sendInput('\x0f')
  let rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'Ctrl+O shows the full text')
  assert.equal(compactMarkerCount(rows), 0, 'no marker while expanded')

  vt.sendInput('\x0f')
  rows = await viewRows(vt)
  assert.ok(!rows.some(row => row.includes('line5')), 'Ctrl+O restores the compact view')
  assert.equal(compactMarkerCount(rows), 1)
  app.stop()
})

test('regular: remapping toggleExpand updates the compact marker key', async () => {
  const { vt, app } = startApp()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': 'ctrl+p' }))
  app.setTranscript([user(lines(11))])
  const view = (await viewRows(vt)).join('\n')
  assert.ok(view.includes('ctrl+p to expand'), `the marker must use the remapped key:\n${view}`)
  assert.ok(!view.includes('ctrl+o to expand'), 'the stale default must not survive')
  app.stop()
})

test('regular: a single long line compacts by wrapped visual rows', async () => {
  const { vt, app } = startApp(80, 40)
  app.setTranscript([user('y'.repeat(1200))])
  const rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the wrapped single line must compact')
  app.stop()
})

test('terminal resize re-decides compaction without stale state', async () => {
  const { vt, app } = startApp(180, 40)
  const wide = Array.from({ length: 8 }, () => 'x'.repeat(100)).join('\n')
  app.setTranscript([user(wide)])
  assert.equal(compactMarkerCount(await viewRows(vt)), 0, '8 rows at 180 columns stays full')

  vt.resize(80, 40)
  assert.equal(compactMarkerCount(await viewRows(vt)), 1, 'narrowing wraps past the threshold')

  vt.resize(180, 40)
  assert.equal(compactMarkerCount(await viewRows(vt)), 0, 'widening restores the full render')
  app.stop()
})

test('compaction never mutates the canonical message text', async () => {
  const { vt, app } = startApp()
  const text = lines(40)
  const message = user(text)
  app.setTranscript([message])
  await viewRows(vt)
  assert.equal(message.text, text, 'the canonical text stays complete')
  assert.equal(message.content, undefined)
  app.stop()
})

// ── App: fullscreen marker click ─────────────────────────────────────────

test('fullscreen: the compact marker advertises click plus the effective key without Focus', async () => {
  const { vt, app } = startApp()
  app.setTranscript([user(lines(11))])
  app.setFullscreen(true)
  const view = (await viewRows(vt)).join('\n')
  assert.ok(view.includes('click / ctrl+o to expand'), `fullscreen marker hint missing:\n${view}`)
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen Focus: the marker is click-only (Ctrl+O owns the Thought bulk)', async () => {
  const { vt, app } = startApp()
  app.setTranscript([user(lines(11))])
  app.setFocusMode(true)
  app.setFullscreen(true)
  const view = (await viewRows(vt)).join('\n')
  assert.ok(view.includes('click to expand'), `click-only hint missing:\n${view}`)
  assert.ok(!view.includes('ctrl+o to expand'), 'the dead Ctrl+O hint must not appear inside a fullscreen Focus')
  app.setFullscreen(false)
  app.setFocusMode(false)
  app.stop()
})

test('fullscreen: clicking the marker expands only that long message', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(11, 'alpha'), 0), user(lines(11, 'beta'), 1)])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 2)
  assert.ok(!rows.some(row => row.includes('alpha5')))

  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('alpha5')), 'the clicked message expands')
  assert.ok(!rows.some(row => row.includes('beta5')), 'the other message stays compact')
  assert.equal(compactMarkerCount(rows), 1)
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: clicking ordinary user text never expands', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(11))])
  app.setFullscreen(true)
  const rows = await viewRows(vt)
  const headY = rows.findIndex(row => row.endsWith('line1'))
  assert.ok(headY >= 0)
  clickCell(vt, 10, headY)
  const after = await viewRows(vt)
  assert.ok(!after.some(row => row.includes('line5')), 'ordinary text stays collapsed')
  assert.equal(compactMarkerCount(after), 1, 'the marker remains the only affordance')
  app.setFullscreen(false)
  app.stop()
})

// ── App: search reveal ───────────────────────────────────────────────────

test('revealSearchMatch expands a hidden long user message (any mode)', async () => {
  const { vt, app } = startApp()
  const message = user(lines(11))
  app.setTranscript([message])
  assert.ok(!(await viewRows(vt)).some(row => row.includes('line5')))
  app.revealSearchMatch(message)
  assert.ok((await viewRows(vt)).some(row => row.includes('line5')), 'the hidden middle is revealed')
  assert.equal(compactMarkerCount(await viewRows(vt)), 0, 'the revealed message renders in full')
  app.stop()
})

test('revealSearchMatch leaves an already-expanded user message untouched', async () => {
  const { vt, app } = startApp()
  const message = user(lines(11))
  app.setTranscript([message])
  app.revealSearchMatch(message)
  app.revealSearchMatch(message)
  assert.ok((await viewRows(vt)).some(row => row.includes('line5')))
  app.stop()
})

// ── Non-candidates keep the existing presentation ────────────────────────

test('mixed-content user messages are never compacted', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'user',
    turn: 0,
    text: lines(11),
    content: [
      { type: 'text', text: lines(11) },
      { type: 'file', attachment: { attachmentId: 'att-file-1', name: 'report.pdf', bytes: 12_600 } },
    ],
  } as never])
  const rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0, 'a mixed bubble keeps the old presentation')
  app.stop()
})

test('the ephemeral pending-user echo is never compacted', async () => {
  const { vt, app } = startApp()
  app.setTranscript([])
  app.setPendingInputPresentation({ queued: [], steering: [{ id: 'p1', text: lines(24), status: 'steering' }], running: true })
  const rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0, 'the pending echo renders in full')
  assert.ok(rows.some(row => row.includes('line20')), 'the pending text is fully visible')
  app.stop()
})

// ── Ctrl+O ownership: collapse + surface gating (review round-1) ─────────

test('regular Ctrl+O expansion does not leak into fullscreen Focus', async () => {
  const { vt, app } = startApp()
  app.setTranscript([user(lines(11))])
  vt.sendInput('\x0f')
  let rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'regular Ctrl+O expands the bubble')

  app.setFocusMode(true)
  app.setFullscreen(true)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'fullscreen Focus must re-collapse the persisted master expansion')
  assert.ok(!rows.some(row => row.includes('line5')), 'the middle is hidden again in fullscreen Focus')
  assert.ok(rows.some(row => row.includes('click to expand')), 'the click-only marker is the affordance there')
  app.setFullscreen(false)
  app.setFocusMode(false)
  app.stop()
})

test('fullscreen marker click then Ctrl+O restores compact', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(11))])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'the marker click expands the bubble')

  vt.sendInput('\x0f')
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'Ctrl+O must be able to restore compact')
  assert.ok(!rows.some(row => row.includes('line5')))
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen Focus: Ctrl+O collapses a marker-clicked user bubble', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(11))])
  app.setFocusMode(true)
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  assert.ok(markerY >= 0, `compact marker missing in fullscreen Focus:\n${rows.join('\n')}`)
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'the marker click expands in fullscreen Focus')

  vt.sendInput('\x0f')
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'Ctrl+O collapses the user bubble in fullscreen Focus')
  assert.ok(!rows.some(row => row.includes('line5')))
  app.setFullscreen(false)
  app.setFocusMode(false)
  app.stop()
})

test('fullscreen Focus: Ctrl+O collapses a search-revealed user bubble without owning roots', async () => {
  const { vt, app } = startApp(100, 40)
  const message = user(lines(11))
  app.setTranscript([message])
  app.setFocusMode(true)
  app.setFullscreen(true)
  assert.equal(compactMarkerCount(await viewRows(vt)), 1)

  app.revealSearchMatch(message)
  let rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'the search reveal expands in fullscreen Focus')

  vt.sendInput('\x0f')
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the user-only collapse must restore compact')
  assert.ok(!rows.some(row => row.includes('line5')))
  app.setFullscreen(false)
  app.setFocusMode(false)
  app.stop()
})

test('regular: a disabled toggleExpand key renders the full prompt (never strands it)', async () => {
  const { vt, app } = startApp()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  app.setTranscript([user(lines(11))])
  const rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0, 'no fold without an expand affordance')
  assert.ok(rows.some(row => row.includes('line5')), 'the full prompt must stay readable')
  const view = rows.join('\n')
  assert.ok(!view.includes('the expand key'), `no dead hint:\n${view}`)
  app.stop()
})

test('fullscreen: a disabled toggleExpand key still advertises the working click', async () => {
  const { vt, app } = startApp()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  app.setTranscript([user(lines(11))])
  app.setFullscreen(true)
  const view = (await viewRows(vt)).join('\n')
  assert.ok(view.includes('click to expand'), `the click affordance must survive:\n${view}`)
  app.setFullscreen(false)
  app.stop()
})

test('a search hit on a SHORT user prompt does not consume the next Ctrl+O', async () => {
  const { vt, app } = startApp()
  const longMessage = user(lines(11, 'long'), 0)
  const shortMessage = user('just a short prompt', 1)
  app.setTranscript([longMessage, shortMessage])
  let rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'only the long prompt is folded')

  app.revealSearchMatch(shortMessage)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'a short prompt needs no reveal override')

  vt.sendInput('\x0f')
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('long5')), 'Ctrl+O must still expand the recent-turn master')
  assert.equal(compactMarkerCount(rows), 0)
  app.stop()
})
