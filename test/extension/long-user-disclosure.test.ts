/**
 * Long user-message disclosure: a text-only durable user prompt whose
 * render-time VISUAL ROW COUNT exceeds the threshold renders head + compact
 * marker + tail, `Ctrl+O` expands it (recent-turn fold master), and in
 * fullscreen the WHOLE bubble BODY is the local disclosure surface — a plain
 * click anywhere on a collapsed bubble expands that message, a plain click
 * anywhere on an expanded bubble collapses it (the dedicated tail control row
 * is retired, so no collapse label is ever painted) — the Claude-style local
 * block toggle. Drag selection
 * never mutates the disclosure; double-click word selection is deliberately
 * NOT available on the long-user bubble in either state (the first complete
 * click acts immediately). The canonical `TranscriptMessage.text` is never
 * touched — compaction is a UserBubble presentation only.
 * @module @xmoon76/dsh-pi-tui/long-user-disclosure.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { parseUserKeybindings } from '../../src/tui/keybindings/config.ts'
import { RendererRegistry } from '../../src/extension/internal/renderer-registry.ts'
import type { ExtensionView } from '../../src/extension/public-types.ts'
import type { TranscriptMessage, TurnActivity } from '../../src/transcript.ts'
import { TuiApp, UserBubbleComponent } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { Text } from '@xmoon76/pi-tui'

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
    expanded: false,
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
  assert.ok(view.includes('ctrl+o expand/collapse'), 'the regular hint names the bidirectional key owner')
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
  assert.ok(view.includes('ctrl+p expand/collapse'), `the marker must use the remapped key:\n${view}`)
  assert.ok(!view.includes('ctrl+o expand/collapse'), 'the stale default must not survive')
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
  assert.ok(!view.includes('ctrl+o expand/collapse'), 'the dead Ctrl+O hint must not appear inside a fullscreen Focus')
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

test('fullscreen: a plain click anywhere on collapsed long-user text expands that message', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(11))])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1)

  // The whole bubble is the disclosure surface: a head-row click expands.
  const headY = rows.findIndex(row => row.endsWith('line1'))
  assert.ok(headY >= 0)
  clickCell(vt, 10, headY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'a head-row click expands the message')
  assert.equal(compactMarkerCount(rows), 0)

  // Collapse back via the expanded body click, then a visible TAIL-row click
  // expands too (the first complete click acts immediately in both states).
  const bodyY = rows.findIndex(row => row.includes('line2'))
  clickCell(vt, 10, bodyY)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the body click collapses back')
  const tailY = rows.findIndex(row => row.includes('line11'))
  assert.ok(tailY >= 0)
  clickCell(vt, 10, tailY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'a tail-row click expands the message too')
  assert.equal(compactMarkerCount(rows), 0)
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

test('dismiss promotes a current long-user reveal but honors an explicit collapse', async () => {
  const { vt, app } = startApp(100, 30)
  const message = user(lines(11))
  app.setFullscreen(true)
  app.setTranscript([message])
  assert.equal(compactMarkerCount(await viewRows(vt)), 1, 'the long user starts compact')
  app.revealSearchMatch(message)
  assert.equal(compactMarkerCount(await viewRows(vt)), 0, 'search temporarily expands the long user')
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  assert.equal(compactMarkerCount(await viewRows(vt)), 0, 'dismiss keeps the promoted long user expanded')
  assert.equal((app as unknown as { expandedOverride: Map<object, boolean> }).expandedOverride.get(message), true,
    'dismiss promotes the existing long-user disclosure owner')
  assert.equal(app.transcriptSearchPresentationForTest(), undefined, 'dismiss clears search presentation')
  app.clearSessionOverrides()
  const collapsedMessage = user(lines(11))
  app.setTranscript([collapsedMessage])
  app.revealSearchMatch(collapsedMessage)
  assert.equal(compactMarkerCount(await viewRows(vt)), 0, 'precondition: search reveal is open')
  vt.sendInput('\x0f')
  assert.equal(compactMarkerCount(await viewRows(vt)), 1, 'the explicit collapse revokes the search reveal')
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  assert.equal(compactMarkerCount(await viewRows(vt)), 1, 'dismiss does not re-open an explicitly collapsed user')
  assert.notEqual((app as unknown as { expandedOverride: Map<object, boolean> }).expandedOverride.get(collapsedMessage), true,
    'an explicit collapse is not promoted')
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
  app.setPendingInputPresentation({ queued: [], tail: [{ kind: 'user', row: { id: 'p1', text: lines(24), status: 'steering' } }], running: true })
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

test('disabled regular search reveal does not leak an expansion into fullscreen Focus', async () => {
  const { vt, app } = startApp()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  const message = user(lines(11))
  app.setTranscript([message])
  let rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0, 'regular with no key renders the prompt in full')

  app.revealSearchMatch(message)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0, 'the reveal must not write an override for a non-folded bubble')

  app.setFocusMode(true)
  app.setFullscreen(true)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'fullscreen Focus must fold and offer the click marker')
  assert.ok(!rows.some(row => row.includes('line5')), 'no stale expansion may hide the marker')
  assert.ok(rows.some(row => row.includes('click to expand')))
  app.setFullscreen(false)
  app.setFocusMode(false)
  app.stop()
})

test('disabling the expand key then entering fullscreen Focus drops a stale search expansion', async () => {
  const { vt, app } = startApp()
  const message = user(lines(11))
  app.setTranscript([message])
  // The reveal legitimately expands while the key is still bound.
  app.revealSearchMatch(message)
  let rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'the reveal expands under the bound key')

  // Disable the key, then enter fullscreen Focus: the override is now stale
  // and must not hide the Focus marker.
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  app.setFocusMode(true)
  app.setFullscreen(true)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the stale override must be dropped on the transition')
  assert.ok(!rows.some(row => row.includes('line5')))
  assert.ok(rows.some(row => row.includes('click to expand')))
  app.setFullscreen(false)
  app.setFocusMode(false)
  app.stop()
})

test('re-entering fullscreen through a non-folding regular surface resets disclosure (by design)', async () => {
  const { vt, app } = startApp(100, 40)
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  app.setTranscript([user(lines(11))])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  assert.ok(markerY >= 0, `fullscreen must fold without the key:\n${rows.join('\n')}`)
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'the marker click expands in fullscreen')

  // A regular surface with no expand key cannot hold the disclosure: re-entry
  // re-derives folded (documented global transition clear, not source-scoped).
  app.setFullscreen(false)
  app.setFullscreen(true)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'by design: the expansion does not survive the non-folding interlude')
  assert.ok(!rows.some(row => row.includes('line5')))
  app.setFullscreen(false)
  app.stop()
})

// ── Ctrl+O recent-turn range uses USER turns, not process turns ──────────

test('Ctrl+O expands only the most recent 3 long user prompts in a pure chat', async () => {
  const { vt, app } = startApp(100, 200)
  const messages: TranscriptMessage[] = []
  for (let turn = 1; turn <= 5; turn += 1) {
    messages.push(user(lines(11, `u${turn}-`), turn))
    messages.push({ kind: 'assistant', turn, text: `answer ${turn}` })
  }
  app.setTranscript(messages)
  assert.equal(compactMarkerCount(await viewRows(vt)), 5, 'all five prompts start folded')

  vt.sendInput('\x0f')
  const rows = await viewRows(vt)
  const view = rows.join('\n')
  assert.equal(compactMarkerCount(rows), 2, 'only turns 1 and 2 stay folded')
  assert.ok(!view.includes('u1-5') && !view.includes('u2-5'), 'the two oldest stay compact')
  assert.ok(view.includes('u3-5') && view.includes('u4-5') && view.includes('u5-5'),
    `the most recent three must be full:\n${view}`)
  app.stop()
})

test('a sparse process turn does not widen the long-user Ctrl+O range', async () => {
  const { vt, app } = startApp(100, 200)
  const messages: TranscriptMessage[] = [
    user(lines(11, 'u1-'), 1),
    { kind: 'tool', turn: 1, name: 'read', args: JSON.stringify({ path: 'a' }), result: 'ok', status: 'ok' },
    user(lines(11, 'u2-'), 2),
    user(lines(11, 'u3-'), 3),
    user(lines(11, 'u4-'), 4),
    user(lines(11, 'u5-'), 5),
  ]
  app.setTranscript(messages)
  assert.equal(compactMarkerCount(await viewRows(vt)), 5, 'all five prompts start folded')

  vt.sendInput('\x0f')
  const rows = await viewRows(vt)
  const view = rows.join('\n')
  assert.equal(compactMarkerCount(rows), 2, 'the process boundary must not decide the user range')
  assert.ok(!view.includes('u1-5') && !view.includes('u2-5'), 'the two oldest stay compact')
  assert.ok(view.includes('u3-5') && view.includes('u4-5') && view.includes('u5-5'),
    `the most recent three must be full:\n${view}`)
  app.stop()
})

test('a newer user turn shifts the Ctrl+O window and re-collapses the dropped prompt', async () => {
  const { vt, app } = startApp(100, 240)
  const build = (count: number): TranscriptMessage[] =>
    Array.from({ length: count }, (_, index) => user(lines(11, `u${index + 1}-`), index + 1))
  app.setTranscript(build(5))
  vt.sendInput('\x0f')
  let view = (await viewRows(vt)).join('\n')
  assert.ok(view.includes('u3-5'), 'turn 3 starts inside the recent window')

  app.setTranscript(build(6))
  view = (await viewRows(vt)).join('\n')
  assert.ok(!view.includes('u3-5'), 'turn 3 must collapse once it leaves the recent window')
  assert.ok(view.includes('u4-5') && view.includes('u5-5') && view.includes('u6-5'),
    `the new recent three must be full:\n${view}`)
  assert.equal(compactMarkerCount(await viewRows(vt)), 3, 'turns 1, 2 and 3 stay folded')
  app.stop()
})

test('a new user turn does not rebuild unchanged non-user components', async () => {
  const { vt, app } = startApp(100, 200)
  const assistant: TranscriptMessage = { kind: 'assistant', turn: 1, text: 'answer' }
  const tool: TranscriptMessage = { kind: 'tool', turn: 1, name: 'read', args: JSON.stringify({ path: 'a' }), result: 'ok', status: 'ok' }
  const before: TranscriptMessage[] = [
    user(lines(11, 'u1-'), 1), assistant, tool,
    user(lines(11, 'u2-'), 2), user(lines(11, 'u3-'), 3), user(lines(11, 'u4-'), 4),
  ]
  app.setTranscript(before)
  vt.sendInput('\x0f') // master on so the user boundary is finite
  await viewRows(vt)
  const assistantComponent = app.messageCacheEntryForTest(assistant)?.component
  const toolComponent = app.messageCacheEntryForTest(tool)?.component
  assert.ok(assistantComponent !== undefined && toolComponent !== undefined)

  // A newer user turn shifts the user boundary (2 -> 3), but no non-user
  // component's render depends on it.
  app.setTranscript([...before, user(lines(11, 'u5-'), 5)])
  await viewRows(vt)
  assert.equal(app.messageCacheEntryForTest(assistant)?.component, assistantComponent,
    'the assistant component must be reused across a user-boundary shift')
  assert.equal(app.messageCacheEntryForTest(tool)?.component, toolComponent,
    'the tool component must be reused across a user-boundary shift')
  app.stop()
})

// ── Extension renderer ownership of kind: 'user' ─────────────────────────

function textView(text: string): ExtensionView {
  return { kind: 'text', spans: [{ text }] }
}

test('a kind:user extension renderer does not pollute the Host long-user disclosure state', async () => {
  const vt = new VirtualTerminal(100, 200)
  const registry = new RendererRegistry()
  registry.registerMessageRenderer({
    id: 'plugin-user',
    order: 1,
    render: (snapshot) => snapshot.kind === 'user' && (snapshot.text ?? '').startsWith('p-')
      ? textView('PLUGIN USER')
      : undefined,
  }, 'test')
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  startedApps.add(app)

  const pluginOwned = user(lines(11, 'p-'), 0)
  const hostOwned = user(lines(11, 'b-'), 1)
  app.setTranscript([pluginOwned, hostOwned])
  let rows = await viewRows(vt)
  assert.ok(rows.join('\n').includes('PLUGIN USER'), 'the plugin owns the first user presentation')
  assert.equal(compactMarkerCount(rows), 1, 'only the Host-rendered user gets the compact marker')

  // A search hit on the PLUGIN-owned long user must not write a Host override:
  // the next Ctrl+O must still expand the recent-turn master.
  app.revealSearchMatch(pluginOwned)
  await viewRows(vt)

  vt.sendInput('\x0f')
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('b-5')),
    'Ctrl+O must toggle the master, not clear a phantom plugin-user override')
  app.stop()
})

test('boundary shifts and surface swaps never re-run a plugin-owned user renderer', async () => {
  const vt = new VirtualTerminal(100, 200)
  const registry = new RendererRegistry()
  let renders = 0
  registry.registerMessageRenderer({
    id: 'plugin-user',
    order: 1,
    render: (snapshot) => {
      if (snapshot.kind === 'user' && (snapshot.text ?? '').startsWith('p-')) {
        renders += 1
        return textView('PLUGIN USER')
      }
      return undefined
    },
  }, 'test')
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  startedApps.add(app)

  const tool = (turn: number): TranscriptMessage =>
    ({ kind: 'tool', turn, name: 'read', args: JSON.stringify({ path: `f${turn}` }), result: 'ok', status: 'ok' })
  // The plugin-owned prompt sits INSIDE the recent user window, and three tool
  // turns make the PROCESS boundary non-empty, so both boundaries can move.
  const pluginOwned = user(lines(11, 'p-'), 2)
  const base: TranscriptMessage[] = [
    tool(1), tool(2), tool(3),
    user(lines(11, 'a-'), 1), pluginOwned, user(lines(11, 'c-'), 3), user(lines(11, 'd-'), 4),
  ]
  app.setTranscript(base)
  vt.sendInput('\x0f') // master on so both boundaries are finite
  await viewRows(vt)
  assert.ok(renders >= 1, 'the plugin rendered the owned user at least once')
  const rendersBefore = renders
  const componentBefore = app.messageCacheEntryForTest(pluginOwned)?.component
  assert.ok(componentBefore !== undefined)

  // (a) PROCESS-boundary shift: a 4th tool turn moves `expandBoundary()`
  // (0 -> 2). A user message never reads it.
  app.setTranscript([...base, tool(4)])
  await viewRows(vt)
  assert.equal(app.messageCacheEntryForTest(pluginOwned)?.component, componentBefore,
    'the plugin-owned user must be reused across a process-boundary shift')
  assert.equal(renders, rendersBefore, 'a process-boundary shift must not re-run the plugin renderer')

  // (b) USER-boundary shift: a 5th user turn moves the recent-USER window
  // (2 -> 3) and flips the plugin-owned message's Host `expanded` state.
  app.setTranscript([...base, tool(4), user(lines(11, 'e-'), 5)])
  await viewRows(vt)
  assert.equal(app.messageCacheEntryForTest(pluginOwned)?.component, componentBefore,
    'the plugin-owned user must be reused across a user-boundary shift')
  assert.equal(renders, rendersBefore, 'a user-boundary shift must not re-run the plugin renderer')

  // (c) Surface swap changes the Host hint owner; the plugin consumes none.
  app.setFullscreen(true)
  await viewRows(vt)
  assert.equal(app.messageCacheEntryForTest(pluginOwned)?.component, componentBefore,
    'the plugin-owned user must be reused across a surface swap')
  assert.equal(renders, rendersBefore, 'a surface swap must not re-run the plugin renderer')
  app.setFullscreen(false)
  app.stop()
})

test('a just-registered user renderer is reconciled before the Host reveal decision', async () => {
  const vt = new VirtualTerminal(100, 200)
  const registry = new RendererRegistry()
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  startedApps.add(app)

  const message = user(lines(11, 'x-'), 0)
  app.setTranscript([message])
  await viewRows(vt) // Host bubble: no renderer registered yet

  // Register a user renderer: the registry revision moves, but the app's cache
  // still holds the Host build (the runner would rebuild on the batched notify).
  const handle = registry.registerMessageRenderer({
    id: 'plugin-user',
    order: 1,
    render: (snapshot) => snapshot.kind === 'user' ? textView('PLUGIN USER') : undefined,
  }, 'test')

  // Synchronous reveal BEFORE any rebuild: ownership must be decided against
  // the LIVE registry, so no Host override is written.
  app.revealSearchMatch(message)

  app.setTranscript([message])
  let rows = await viewRows(vt)
  assert.ok(rows.join('\n').includes('PLUGIN USER'), 'the plugin owns the user presentation')

  // Unload the plugin: the Host returns. A stale Host override would render it
  // expanded with no marker.
  handle.dispose()
  app.setTranscript([message])
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the Host bubble must be folded after the plugin unload')
  assert.ok(!rows.some(row => row.includes('x-5')), 'no stale Host override may survive the plugin unload')
  app.stop()
})

test('a just-unloaded user renderer still accepts the search reveal for the returning Host bubble', async () => {
  const vt = new VirtualTerminal(100, 200)
  const registry = new RendererRegistry()
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  startedApps.add(app)

  const message = user(lines(11, 'x-'), 0)
  const handle = registry.registerMessageRenderer({
    id: 'plugin-user',
    order: 1,
    render: (snapshot) => snapshot.kind === 'user' ? textView('PLUGIN USER') : undefined,
  }, 'test')
  app.setTranscript([message])
  await viewRows(vt)
  assert.ok((await viewRows(vt)).join('\n').includes('PLUGIN USER'))

  // Unload + synchronous reveal before the deferred rebuild: the returning Host
  // bubble must still receive the reveal (a fail-closed ownership check would
  // silently drop it).
  handle.dispose()
  app.revealSearchMatch(message)
  app.setTranscript([message])
  const rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0, 'the returning Host bubble is revealed')
  assert.ok(rows.some(row => row.includes('x-5')), 'the hidden middle is visible after the reveal')
  app.stop()
})

test('a re-entrantly self-disposing renderer still yields the Host reveal decision', async () => {
  const vt = new VirtualTerminal(100, 200)
  const registry = new RendererRegistry()
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  startedApps.add(app)

  const message = user(lines(11, 'x-'), 0)
  app.setTranscript([message])
  await viewRows(vt) // Host bubble: no renderer registered yet

  let handle: { dispose: () => void } | undefined
  handle = registry.registerMessageRenderer({
    id: 'self-dispose-user',
    order: 1,
    render: (snapshot) => {
      if (snapshot.kind !== 'user') return undefined
      handle?.dispose()
      return textView('SELF DISPOSED')
    },
  }, 'test')

  // Synchronous reveal inside the deferred-invalidation window: the reconcile
  // builds the self-disposing renderer, which mutates the registry again. The
  // helper must keep reconciling until the selection revision is current, so
  // the FINAL Host owner still receives the reveal.
  app.revealSearchMatch(message)
  app.setTranscript([message])
  const rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0, 'the returning Host bubble must be revealed')
  assert.ok(rows.some(row => row.includes('x-5')), 'the hidden middle is visible after the reveal')
  app.stop()
})

test('a pathological always-mutating renderer fails closed instead of trusting a stale entry', async () => {
  const vt = new VirtualTerminal(100, 200)
  const registry = new RendererRegistry()
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  startedApps.add(app)

  const message = user(lines(11, 'x-'), 0)
  app.setTranscript([message])
  await viewRows(vt) // Host bubble

  // A renderer that keeps registering a NEW abdicating renderer on every
  // render, so the registry revision never stabilises within the bound; it
  // stops mutating after a few calls so the surface can settle.
  let registrations = 0
  registry.registerMessageRenderer({
    id: 'churn',
    order: 1,
    render: () => {
      if (registrations < 5) {
        registrations += 1
        registry.registerMessageRenderer({ id: `churn-${registrations}`, order: 5, render: () => undefined }, 'test')
      }
      return undefined
    },
  }, 'test')

  app.revealSearchMatch(message)
  app.setTranscript([message])
  const rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'a stale entry must not leave a phantom Host expansion')
  assert.ok(!rows.some(row => row.includes('x-5')), 'the Host bubble must stay folded')
  app.stop()
})

// ── Bidirectional fullscreen mouse disclosure (whole-BODY click) ─────────
//
// The compact marker EXPANDS; the expanded message BODY carries the ONE
// collapse affordance. No tail control row is painted on any surface, and
// every other bubble row stays inert so ordinary user text keeps
// selection/copy semantics.

const COLLAPSE_LABEL = '▴ Collapse'

function collapseFooterRows(rows: readonly string[]): number[] {
  return rows.flatMap((row, index) => row.includes(COLLAPSE_LABEL) ? [index] : [])
}

test('fullscreen: the durable long user round-trips expand → collapse via the message BODY', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(11)), { kind: 'assistant', turn: 0, text: 'done' }])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the prompt starts compact')
  assert.ok(!rows.some(row => row.includes('line5')), 'the middle is hidden')
  assert.equal(collapseFooterRows(rows).length, 0, 'the dedicated tail control is retired')

  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'the marker click expands the prompt')
  assert.equal(compactMarkerCount(rows), 0, 'no marker while expanded')
  assert.equal(collapseFooterRows(rows).length, 0, `no collapse control exists while expanded:\n${rows.join('\n')}`)
  assert.ok(!rows.join('\n').includes('▴ Collapse'), 'the retired label must never be painted')

  // The BODY is the collapse owner: a plain click on any user-text row.
  const bodyY = rows.findIndex(row => row.includes('line5'))
  assert.ok(bodyY >= 0, `an expanded body row must be visible:\n${rows.join('\n')}`)
  clickCell(vt, 50, bodyY)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the body click restores compact')
  assert.ok(!rows.some(row => row.includes('line5')), 'the middle is hidden again')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: the FINAL long user block stays complete and collapses by body click (no extra row)', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(11))])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  // The final block must keep every one of its own rows: no synthetic trailing
  // control row may be charged to it (the retired `+1` height rule).
  assert.ok(rows.some(row => row.includes('line11')), `the final block must stay complete:\n${rows.join('\n')}`)
  assert.equal(collapseFooterRows(rows).length, 0, `no dedicated collapse row exists:\n${rows.join('\n')}`)

  // ...and its own last content row is a live collapse target.
  const lastBodyY = rows.findIndex(row => row.includes('line11'))
  assert.ok(lastBodyY >= 0)
  clickCell(vt, 50, lastBodyY)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the final-block body click collapses back')
  assert.equal(collapseFooterRows(rows).length, 0, 'no residual tail row after the collapse')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen Focus: the expanded user collapses by a BODY click with no tail chrome', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(11)), { kind: 'assistant', turn: 0, text: 'done' }])
  app.setFocusMode(true)
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'the marker expands inside fullscreen Focus')
  assert.equal(collapseFooterRows(rows).length, 0, `no tail chrome inside fullscreen Focus:\n${rows.join('\n')}`)

  const bodyY = rows.findIndex(row => row.includes('line5'))
  assert.ok(bodyY >= 0)
  clickCell(vt, 10, bodyY)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the click-only body collapse works')
  app.setFullscreen(false)
  app.setFocusMode(false)
  app.stop()
})

test('regular: expanded long user does not inject collapse chrome into scrollback', async () => {
  const { vt, app } = startApp()
  app.setTranscript([user(lines(11)), { kind: 'assistant', turn: 0, text: 'done' }])
  vt.sendInput('\x0f')
  const rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'the prompt is expanded')
  // Regular draws into the terminal main screen: a visible label would be
  // copied by the terminal's native selection, so no tail control is painted.
  // Ctrl+O remains the regular collapse owner.
  assert.equal(collapseFooterRows(rows).length, 0, `regular must not paint a copyable collapse label:\n${rows.join('\n')}`)
  assert.ok(!rows.join('\n').includes('▴ Collapse'))

  vt.sendInput('\x0f')
  const collapsed = await viewRows(vt)
  assert.equal(compactMarkerCount(collapsed), 1, 'Ctrl+O still collapses the regular prompt')
  app.stop()
})

test('regular: a disabled toggleExpand key renders no dead collapse footer', async () => {
  const { vt, app } = startApp()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  app.setTranscript([user(lines(11)), { kind: 'assistant', turn: 0, text: 'done' }])
  const rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0)
  assert.equal(collapseFooterRows(rows).length, 0, 'no fold, no dead footer')
  app.stop()
})

test('fullscreen: a disabled toggleExpand key still round-trips entirely by mouse', async () => {
  const { vt, app } = startApp(100, 40)
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  app.setTranscript([user(lines(11)), { kind: 'assistant', turn: 0, text: 'done' }])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'fullscreen folds without the key')

  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'the marker click expands')
  assert.equal(collapseFooterRows(rows).length, 0, `no collapse chrome is painted:\n${rows.join('\n')}`)

  const bodyY = rows.findIndex(row => row.includes('line5'))
  assert.ok(bodyY >= 0)
  clickCell(vt, 50, bodyY)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the mouse alone returns to compact')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: a plain click on expanded long-user BODY collapses only that message', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(11, 'alpha'), 0), user(lines(11, 'beta'), 1)])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 2, 'both long users start compact')

  // Expand BOTH messages via their markers (the second marker moves after the
  // first expansion, so resolve it from the repainted view).
  const markerAY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerAY)
  rows = await viewRows(vt)
  const markerBY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerBY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('alpha5')) && rows.some(row => row.includes('beta5')), 'both are expanded')

  // A plain click on A's BODY collapses ONLY A — never the bulk Ctrl+O owner.
  const bodyAY = rows.findIndex(row => row.includes('alpha2'))
  assert.ok(bodyAY >= 0, `an A body row must be visible:\n${rows.join('\n')}`)
  clickCell(vt, 10, bodyAY)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'A returns to its compact marker')
  assert.ok(!rows.some(row => row.includes('alpha5')), 'the clicked message collapses')
  assert.ok(rows.some(row => row.includes('beta5')), 'the other message keeps its own expansion (not a bulk collapse)')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: a search-revealed prompt paints no collapse chrome', async () => {
  const { vt, app } = startApp(100, 40)
  const message = user(lines(11))
  app.setTranscript([message, { kind: 'assistant', turn: 0, text: 'done' }])
  app.setFullscreen(true)
  assert.equal(compactMarkerCount(await viewRows(vt)), 1)

  app.revealSearchMatch(message)
  const rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'the hidden middle is revealed')
  assert.equal(collapseFooterRows(rows).length, 0, `a search reveal paints no collapse chrome:\n${rows.join('\n')}`)
  assert.ok(!rows.join('\n').includes('▴ Collapse'))
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: clicking the body of a search-revealed long user collapses and suppresses the reveal', async () => {
  const { vt, app } = startApp(100, 40)
  const message = user(lines(11))
  app.setTranscript([message, { kind: 'assistant', turn: 0, text: 'done' }])
  app.setFullscreen(true)
  assert.equal(compactMarkerCount(await viewRows(vt)), 1)

  app.revealSearchMatch(message)
  let rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'the hidden middle is revealed')

  const bodyY = rows.findIndex(row => row.includes('line2'))
  assert.ok(bodyY >= 0)
  clickCell(vt, 10, bodyY)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the body click restores compact')
  assert.ok(!rows.some(row => row.includes('line5')), 'the explicit collapse suppresses the current search reveal')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: drag selection across user text never mutates the disclosure', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(11)), { kind: 'assistant', turn: 0, text: 'done' }])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')))

  const headY = rows.findIndex(row => row.includes('line1'))
  const lastY = rows.findIndex(row => row.includes('line11'))
  assert.ok(headY >= 0 && lastY >= 0)
  vt.sendInput(`\x1b[<0;1;${headY + 1}M`)
  vt.sendInput(`\x1b[<32;1;${lastY + 1}M`)
  vt.sendInput(`\x1b[<0;1;${lastY + 1}m`)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'a drag selection must not collapse the message')
  assert.equal(compactMarkerCount(rows), 0)
  app.setFullscreen(false)
  app.stop()
})

// Intentional trade-off: the expanded long-user body is a local disclosure
// surface, so the FIRST complete plain click collapses it immediately.
// There is deliberately NO deferred single-click window (no timer, no click
// latency, no gesture state machine) that would keep double-click word
// selection available on that surface — drag selection remains the copy
// affordance (the test above).
test('fullscreen: the first complete click on an expanded body collapses immediately (no deferred double-click window)', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(11)), { kind: 'assistant', turn: 0, text: 'done' }])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'the prompt is expanded')

  const bodyY = rows.findIndex(row => row.includes('line2'))
  assert.ok(bodyY >= 0)
  clickCell(vt, 10, bodyY)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the first complete click must collapse immediately')
  assert.ok(!rows.some(row => row.includes('line5')), 'the middle is hidden again')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: a copy across the expanded message carries no presentation label', async () => {
  const vt = new VirtualTerminal(100, 40)
  const copied: string[] = []
  const app = new TuiApp(
    vt,
    { onSubmit: () => {}, onExit: () => {} },
    { copySelection: async (text) => { copied.push(text); return true } },
  )
  app.start()
  startedApps.add(app)
  app.setTranscript([user(lines(11)), { kind: 'assistant', turn: 0, text: 'TAILANSWER' }])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.equal(collapseFooterRows(rows).length, 0, `no collapse chrome exists:\n${rows.join('\n')}`)
  const lastUserY = rows.findIndex(row => row.includes('line11'))
  const answerY = rows.findIndex(row => row.includes('TAILANSWER'))
  assert.ok(lastUserY >= 0 && answerY > lastUserY, `the user tail and the answer must be in order:\n${rows.join('\n')}`)

  // Drag from the LAST user body row across the block boundary to the answer:
  // the real content is copied and no presentation label exists to leak.
  vt.sendInput(`\x1b[<0;1;${lastUserY + 1}M`)
  vt.sendInput(`\x1b[<32;40;${answerY + 1}M`)
  vt.sendInput(`\x1b[<0;40;${answerY + 1}m`)
  await vt.waitForRender()

  assert.ok(copied.length >= 1, `expected a copy gesture:\n${rows.join('\n')}`)
  const text = copied.join('\n')
  assert.ok(!text.includes('Collapse'), `clipboard leaked collapse chrome:\n${text}`)
  assert.ok(!text.includes('ctrl+o'), `clipboard leaked the key hint:\n${text}`)
  assert.ok(!text.includes('click'), `clipboard leaked a click hint:\n${text}`)
  assert.ok(text.includes('line11'), `the real last user row must be copied:\n${text}`)
  assert.ok(text.includes('TAILANSWER'), `the answer must still be copied:\n${text}`)
  // The end-of-message semantics stay the plain transcript boundary: the last
  // user row keeps its own line and the answer follows on the next one.
  assert.ok(text.includes('line11\n'), `the user tail must end its own line:\n${text}`)
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: selecting the complete expanded message copies its real text', async () => {
  const vt = new VirtualTerminal(100, 40)
  const copied: string[] = []
  const app = new TuiApp(
    vt,
    { onSubmit: () => {}, onExit: () => {} },
    { copySelection: async (text) => { copied.push(text); return true } },
  )
  app.start()
  startedApps.add(app)
  app.setTranscript([user(lines(11)), { kind: 'assistant', turn: 0, text: 'done' }])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)

  const headY = rows.findIndex(row => row.includes('line1'))
  const lastY = rows.findIndex(row => row.includes('line11'))
  assert.ok(headY >= 0 && lastY > headY, `the whole body must be visible:\n${rows.join('\n')}`)
  vt.sendInput(`\x1b[<0;1;${headY + 1}M`)
  vt.sendInput(`\x1b[<32;40;${lastY + 1}M`)
  vt.sendInput(`\x1b[<0;40;${lastY + 1}m`)
  await vt.waitForRender()

  const expected = ['❯ line1', ...Array.from({ length: 10 }, (_, index) => `line${index + 2}`)].join('\n')
  assert.equal(copied.join('\n'), expected, 'the complete expanded text must copy verbatim (with its prompt prefix)')
  app.setFullscreen(false)
  app.stop()
})

// ── Durable steer + pending→durable handoff ──────────────────────────────

test('durable same-turn steer uses the ordinary long-user fold (no steer-specific renderer)', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'user', turn: 1, text: lines(11), steer: true }])
  let rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'a long durable steer folds like any user prompt')
  vt.sendInput('\x0f')
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'the ordinary Ctrl+O owner expands it')
  assert.equal(compactMarkerCount(rows), 0)
  app.stop()
})

test('a pending explicit expansion is never promoted onto the durable message', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([])
  app.setPendingInputPresentation({
    queued: [],
    tail: [{ kind: 'user', row: { id: 'p1', rpcId: 'r1', text: lines(24, 'p-'), status: 'steering', foldableText: true } }],
    running: true,
  })
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  assert.ok((await viewRows(vt)).some(row => row.includes('p-12')), 'the pending row is explicitly expanded')

  // The durable message materializes and the pending lane empties: the
  // ephemeral override must NOT be inherited — that would promote ephemeral
  // UI state into durable message state.
  app.setPendingInputPresentation({ queued: [], tail: [], running: false })
  app.setTranscript([user(lines(24, 'p-'), 1)])
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the durable message re-derives its own state')
  assert.ok(!rows.some(row => row.includes('p-12')), 'the pending expansion is not inherited')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: a persisted Ctrl+O master stays mouse-round-trippable after the key is disabled', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(24)), { kind: 'assistant', turn: 0, text: 'done' }])
  vt.sendInput('\x0f') // the regular Ctrl+O master expands the recent prompt
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line12')), `the master expansion survives into fullscreen:\n${rows.join('\n')}`)
  assert.equal(collapseFooterRows(rows).length, 0, `no collapse chrome is painted:\n${rows.join('\n')}`)

  const bodyY = rows.findIndex(row => row.includes('line12'))
  assert.ok(bodyY >= 0)
  clickCell(vt, 60, bodyY)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the body click collapses without the key')
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  assert.ok(rows[markerY]!.includes('click to expand'), 'the marker keeps the working click affordance')
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0, 'the marker click expands again without the key')
  assert.equal(collapseFooterRows(rows).length, 0, 'never stranded, never a tail control')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: a stale collapsed-bubble press never collapses through the body that repainted onto its cell', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(11)), { kind: 'assistant', turn: 0, text: 'done' }])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  assert.ok(markerY >= 0, `the compact marker must be in view:\n${rows.join('\n')}`)

  // Press the marker (EXPAND identity) but do NOT release.
  vt.sendInput(`\x1b[<0;10;${markerY + 1}M`)

  // Expand through the keyboard while the press is still down: the pressed cell
  // is now part of the user BODY, whose hit carries the opposite direction.
  vt.sendInput('\x0f')
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('line5')), 'the message is now expanded')
  assert.match(rows[markerY] ?? '', /line\d/, `the pressed cell must now show user body text:\n${rows.join('\n')}`)

  // Release at the pressed cell: the stale EXPAND identity must never run the
  // COLLAPSE that repainted onto the same cell.
  vt.sendInput(`\x1b[<0;10;${markerY + 1}m`)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0, 'the stale press must not collapse the message')
  assert.ok(rows.some(row => row.includes('line5')), 'the message stays expanded')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: a stale body press never expands through the collapsed bubble that repainted onto its cell', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(11)), { kind: 'assistant', turn: 0, text: 'done' }])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  vt.sendInput('\x0f') // the Ctrl+O master expands the recent user
  rows = await viewRows(vt)
  const bodyY = rows.findIndex(row => row.includes('line2'))
  assert.ok(bodyY >= 0, `the expanded body must be in view:\n${rows.join('\n')}`)

  // Press the BODY (COLLAPSE identity) but do NOT release.
  vt.sendInput(`\x1b[<0;10;${bodyY + 1}M`)

  // Collapse the same message through the keyboard while the press is down: the
  // pressed cell is now inside the COLLAPSED bubble, whose whole-bubble hit
  // carries the opposite direction.
  vt.sendInput('\x0f')
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the keyboard collapse takes effect')

  // Release at the pressed cell: the stale COLLAPSE identity must never run the
  // EXPAND that repainted onto the same cell.
  vt.sendInput(`\x1b[<0;10;${bodyY + 1}m`)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the stale body press must not re-expand the message')
  assert.ok(!rows.some(row => row.includes('line5')), 'the message stays collapsed')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: a rebuild between press and release still copies the real painted content', async () => {
  const vt = new VirtualTerminal(100, 40)
  const copied: string[] = []
  const app = new TuiApp(
    vt,
    { onSubmit: () => {}, onExit: () => {} },
    { copySelection: async (text) => { copied.push(text); return true } },
  )
  app.start()
  startedApps.add(app)
  const message = user(lines(11), 1)
  app.setTranscript([message, { kind: 'assistant', turn: 1, text: lines(20, 'a-') }])
  app.setFullscreen(true)
  vt.sendInput('\x0f') // expand the recent user: every painted row is real content
  await viewRows(vt)
  let rows = await viewRows(vt)
  const lastUserY = rows.findIndex(row => row.includes('line11'))
  assert.ok(lastUserY >= 0, `the expanded user tail must be painted:\n${rows.join('\n')}`)
  const paintedBelow = rows[lastUserY + 2]!
  assert.ok(paintedBelow.trim() !== '')

  // Start a drag selection across the user tail (+ the real text below it) and
  // do NOT release yet.
  vt.sendInput(`\x1b[<0;1;${lastUserY}M`)
  vt.sendInput(`\x1b[<32;90;${lastUserY + 3}M`)

  // A transcript update rebuilds the projection and shifts this entry down two
  // rows, but the frame is NOT repainted before the release.
  app.setTranscript([user('short', 0), message, { kind: 'assistant', turn: 1, text: lines(20, 'a-') }])
  vt.sendInput(`\x1b[<0;90;${lastUserY + 3}m`)
  await viewRows(vt)

  assert.ok(copied.length >= 1, `expected a copy gesture:\n${rows.join('\n')}`)
  const text = copied.join('\n')
  assert.ok(!text.includes('Collapse'), `no collapse chrome may ever be copied:\n${text}`)
  // No copy filter exists any more: the painted REAL row below the user tail is
  // copied verbatim, never blanked.
  assert.ok(text.includes(paintedBelow.trim()), `a real painted row was wrongly blanked:\n${text}`)
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen resize re-derives the expanded state with no stale chrome', async () => {
  const { vt, app } = startApp(80, 40)
  const text = Array.from({ length: 8 }, () => 'x'.repeat(100)).join('\n')
  app.setTranscript([user(text, 0), { kind: 'assistant', turn: 0, text: 'done' }])
  app.setFullscreen(true)
  vt.sendInput('\x0f') // expand the recent user
  let rows = await viewRows(vt)
  assert.equal(collapseFooterRows(rows).length, 0, `narrow: no collapse chrome exists:\n${rows.join('\n')}`)
  assert.equal(compactMarkerCount(rows), 0, 'the narrow prompt is expanded')

  // Widen: the same 8 logical lines now render as 8 visual rows, below the
  // threshold, so the bubble is no longer collapse-capable (the width change
  // rebuilds the tree).
  vt.resize(200, 40)
  rows = await viewRows(vt)
  assert.equal(collapseFooterRows(rows).length, 0, `wide: no stale chrome:\n${rows.join('\n')}`)
  assert.equal(compactMarkerCount(rows), 0, 'a non-compactable prompt has no marker either')

  // Narrow again: the persisted master re-expands the recent prompt.
  vt.resize(80, 40)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0, 'the narrow prompt is expanded again')
  assert.equal(collapseFooterRows(rows).length, 0, `narrow again: still no collapse chrome:\n${rows.join('\n')}`)

  const bodyY = rows.findIndex(row => row.includes('xxxx'))
  assert.ok(bodyY >= 0, `the re-derived body must be visible:\n${rows.join('\n')}`)
  clickCell(vt, 60, bodyY)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the re-derived body remains click-collapsible')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: a stale body press never acts on the message that shifted onto its cell', async () => {
  const { vt, app } = startApp(100, 40)
  const message = user(lines(24, 'b-'), 1)
  app.setTranscript([message, { kind: 'assistant', turn: 1, text: lines(20, 'a-') }])
  app.setFullscreen(true)
  vt.sendInput('\x0f') // expand the recent user
  let rows = await viewRows(vt)
  const bodyY = rows.findIndex(row => row.includes('b-12'))
  assert.ok(bodyY >= 0, `the expanded body must be in view:\n${rows.join('\n')}`)

  // Press the BODY, then insert a LONG preceding message (a rebuild that pushes
  // this entry far down) before releasing: the pressed cell is now covered by a
  // DIFFERENT message, whose body must never receive the stale gesture.
  vt.sendInput(`\x1b[<0;60;${bodyY + 1}M`)
  app.setTranscript([user(lines(24, 'z-'), 0), message, { kind: 'assistant', turn: 1, text: lines(20, 'a-') }])
  vt.sendInput(`\x1b[<0;60;${bodyY + 1}m`)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0, 'no message may collapse or expand from the stale press')
  assert.ok(rows.some(row => row.includes('b-12')), 'the originally expanded message stays expanded')
  app.setFullscreen(false)
  app.stop()
})

test('an unrelated long-user collapse does not revoke the current search reveal', async () => {
  const { vt, app } = startApp(100, 60)
  const a = user(lines(11, 'a-'), 0)
  const b = user(lines(11, 'b-'), 1)
  app.setTranscript([a, b])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  // Expand B manually (the SECOND compact marker belongs to B).
  const markers = rows.map((row, index) => ({ row, index })).filter(entry => entry.row.includes('rows compacted'))
  assert.equal(markers.length, 2, `both prompts start compact:\n${rows.join('\n')}`)
  clickCell(vt, 10, markers[1]!.index)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('b-5')), 'B is manually expanded')

  // Target A with the search reveal.
  app.setTranscriptSearchTarget({
    query: 'a-5',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: a,
  })
  rows = await viewRows(vt)
  let aRow = rows.findIndex(row => row.includes('a-5'))
  assert.ok(aRow >= 0, 'the search target expands A')
  assert.ok(!vt.getCellInverse(aRow, rows[aRow]!.indexOf('a-5')), 'precondition: a long bubble is anchor-only (no guessed strong)')

  // Collapse the UNRELATED B by clicking its BODY (the local collapse surface).
  const bBodyY = rows.findIndex(row => row.includes('b-2'))
  assert.ok(bBodyY >= 0, `a B body row must be visible:\n${rows.join('\n')}`)
  clickCell(vt, 10, bBodyY)
  rows = await viewRows(vt)
  assert.ok(!rows.some(row => row.includes('b-5')), 'B collapsed')
  aRow = rows.findIndex(row => row.includes('a-5'))
  assert.ok(aRow >= 0, 'the unrelated collapse must NOT revoke A search reveal (A stays expanded)')
  app.setFullscreen(false)
  app.stop()
})

function runningActivity(turn: number): TurnActivity {
  return {
    turn,
    completed: false,
    assistantMessages: 0,
    toolCalls: 1,
    tools: new Map([['read', 1]]),
    revision: 1,
  } as TurnActivity
}

test('fullscreen Compact: a body click collapses only the user, the Work bulk keeps its state', async () => {
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset: 'compact' } })
  app.start()
  startedApps.add(app)
  app.setTranscript(
    [
      user(lines(11, 'u-'), 1),
      { kind: 'tool', turn: 1, name: 'read', args: JSON.stringify({ path: 'a' }), result: 'ok', status: 'ok' },
    ],
    new Map([[1, runningActivity(1)]]),
  )
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const workY = rows.findIndex(row => /▸ Activity/.test(row))
  assert.ok(workY >= 0, `the collapsed Work span header must be visible:\n${rows.join('\n')}`)

  // Expand the Work span (Ctrl+O owns the Work bulk in fullscreen Compact).
  clickCell(vt, 10, workY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('Read')), `the Work span expands:\n${rows.join('\n')}`)

  // Expand the long user via its marker, then collapse it by a plain body click.
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  assert.ok(markerY >= 0, `the long user stays compact:\n${rows.join('\n')}`)
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('u-5')), 'the user expands by the marker click')

  const bodyY = rows.findIndex(row => row.includes('u-2'))
  assert.ok(bodyY >= 0)
  clickCell(vt, 10, bodyY)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'only the user collapses')
  assert.ok(!rows.some(row => row.includes('u-5')), 'the user middle is hidden again')
  assert.ok(rows.some(row => row.includes('Read')), 'the Work bulk state is unchanged (still expanded)')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: two expanded long users keep exactly one normal separator row', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([user(lines(11, 'a-'), 0), user(lines(11, 'b-'), 1)])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 2, 'both long prompts start compact')

  // Expand BOTH messages through their markers (the second marker moves after
  // the first expansion, so resolve it from the repainted view).
  clickCell(vt, 10, rows.findIndex(row => row.includes('rows compacted')))
  rows = await viewRows(vt)
  clickCell(vt, 10, rows.findIndex(row => row.includes('rows compacted')))
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('a-11')) && rows.some(row => row.includes('b-11')), `both are expanded:\n${rows.join('\n')}`)

  // Between the two blocks sits exactly ONE ordinary separator row: the retired
  // tail control must never occupy or replace it.
  const aTail = rows.findIndex(row => row.includes('a-11'))
  const bHead = rows.findIndex(row => row.includes('b-1'))
  assert.ok(aTail >= 0 && bHead > aTail, `both blocks must be in order:\n${rows.join('\n')}`)
  assert.equal(bHead - aTail, 2, `exactly one separator row between the blocks:\n${rows.join('\n')}`)
  assert.equal((rows[aTail + 1] ?? '').trim(), '', `the separator row stays blank:\n${rows.join('\n')}`)
  assert.equal(collapseFooterRows(rows).length, 0, 'no label occupies the separator')
  app.setFullscreen(false)
  app.stop()
})
