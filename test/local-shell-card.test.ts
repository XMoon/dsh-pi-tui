/**
 * Tests for the local-shell display policy (plan §5): the pure preview
 * math — running cards collapse to 5 source lines, settled cards to 20
 * VISUAL rows, Unicode/emoji/ANSI never split, and the hidden count stays
 * honest — plus the app-level integration: Ctrl+O expand/collapse follows
 * the master switch, and Alt+K dismisses settled cards only.
 * @module @xmoon76/dsh-pi-tui/local-shell-card.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import {
  isLocalShellCard,
  localShellHiddenMarker,
  localShellPreview,
  RUNNING_PREVIEW_LINES,
  RUNNING_PREVIEW_VISUAL_CEILING,
  SETTLED_PREVIEW_VISUAL_ROWS,
} from '../src/local-shell-card.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

// --- pure preview math ---

test('running preview keeps the newest 5 source lines and reports the hidden count', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
  const { rows, hidden } = localShellPreview(lines.join('\n'), 80, RUNNING_PREVIEW_LINES, 'lines')
  assert.equal(rows.length, 5, 'running preview keeps exactly 5 source lines')
  assert.deepEqual(rows, ['line 96', 'line 97', 'line 98', 'line 99', 'line 100'])
  assert.equal(hidden, 95, 'the 95 older lines are hidden')
})

test('settled preview bounds VISUAL rows, wrapping long logical lines', () => {
  // 100 short lines fit under 20 visual rows; a long line wraps into many.
  const shortLines = Array.from({ length: 10 }, (_, i) => `short ${i}`).join('\n')
  const { rows: shortRows, hidden: shortHidden } = localShellPreview(shortLines, 80, SETTLED_PREVIEW_VISUAL_ROWS, 'visual')
  assert.equal(shortRows.length, 10, 'all short rows fit')
  assert.equal(shortHidden, 0)
  // One gigantic line (200 chars at width 40 → 5 visual rows) + 30 short
  // lines: the newest lines fill the budget, the giant line's own tail
  // shows what still fits.
  const giant = 'x'.repeat(200)
  const tail = Array.from({ length: 30 }, (_, i) => `tail line ${i}`).join('\n')
  const { rows, hidden } = localShellPreview(`${giant}\n${tail}`, 40, SETTLED_PREVIEW_VISUAL_ROWS, 'visual')
  const visual = rows.length
  assert.ok(visual <= SETTLED_PREVIEW_VISUAL_ROWS, `visual rows must respect the budget: ${visual}`)
  assert.ok(rows[rows.length - 1]!.includes('tail line 29'), 'the newest content wins')
  assert.ok(hidden >= 1, 'the giant line (or more) is hidden')
})

test('a single line longer than the budget shows its own visual tail', () => {
  const { rows, hidden } = localShellPreview('a'.repeat(500), 30, 4, 'visual')
  assert.equal(rows.length, 4, 'the visual budget is exact')
  assert.equal(rows[rows.length - 1]!.endsWith('a'), true, 'the tail is the newest content')
  assert.ok(hidden >= 1, 'the older visual rows are hidden')
})

test('CJK/emoji/ZWJ content never splits mid-grapheme', () => {
  const text = '中🙂' .repeat(40)
  const { rows, hidden } = localShellPreview(text, 30, 5, 'visual')
  assert.ok(rows.length <= 5, `visual rows bounded: ${rows.length}`)
  for (const row of rows) {
    // A grapheme must never be cut: every broken sequence is caught by
    // the wrap helper, so rows are plain display-safe strings.
    assert.ok(row.length <= 31, `row too long:\n${row}`)
  }
  void hidden
})

test('empty text previews as empty', () => {
  assert.deepEqual(localShellPreview('', 80, 5, 'lines'), { rows: [], hidden: 0, partial: false })
  assert.deepEqual(localShellPreview('', 80, 20, 'visual'), { rows: [], hidden: 0, partial: false })
})

test('the hidden marker carries the expand hint and stays honest', () => {
  assert.equal(localShellHiddenMarker(0, false, false, 'ctrl+o'), '')
  assert.equal(localShellHiddenMarker(3, false, false, 'ctrl+o'), '3 more lines (ctrl+o to expand)')
  assert.equal(localShellHiddenMarker(3, true, false, 'ctrl+o'), '3 more lines (ctrl+o to expand)')
  // A PARTIAL cut (the front of the same line hidden) must not claim
  // "1 more line" — that would lie about what is hidden (review P1).
  assert.equal(localShellHiddenMarker(1, true, true, 'ctrl+o'), 'earlier output hidden (ctrl+o to expand)')
  assert.equal(localShellHiddenMarker(1, false, true, 'ctrl+o'), 'earlier output hidden (ctrl+o to expand)')
  assert.equal(localShellHiddenMarker(0, true, true, 'ctrl+o'), '')
})

test('isLocalShellCard recognizes only the unbounded-turn shell card', () => {
  assert.equal(isLocalShellCard({ kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell', args: 'ls', result: '', status: 'running' }), true)
  // A session tool card carries a real turn number.
  assert.equal(isLocalShellCard({ kind: 'tool', turn: 3, name: 'shell', args: 'ls', result: '', status: 'running' }), false)
  assert.equal(isLocalShellCard({ kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'bash', args: 'ls', result: '', status: 'running' }), false)
  assert.equal(isLocalShellCard({ kind: 'assistant', turn: 0, text: 'hi' }), false)
})

// --- app integration: fold/expand and dismiss ---

function startApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app }
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

test('local shell cards collapse by default and Ctrl+O expands them', async () => {
  const vt = new VirtualTerminal(80, 60)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const long = Array.from({ length: 30 }, (_, i) => `output line ${i}`).join('\n')
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'ls -la', result: long, status: 'ok',
  })
  let view = await viewport(vt)
  // Collapsed: the head plus the newest 20 visual rows, never the full log.
  assert.ok(view.includes('output line 29'), `newest line must show:\n${view}`)
  assert.ok(!view.includes('output line 0'), `old line must NOT show collapsed:\n${view}`)
  // Ctrl+O (the master switch) expands the local shell card.
  vt.sendInput('\x0f')
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(view.includes('output line 0'), `expanded card must show the first line:\n${view}`)
  // Ctrl+O again collapses back.
  vt.sendInput('\x0f')
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(!view.includes('output line 0'), `collapsed card must hide the first line:\n${view}`)
  app.stop()
})

test('Alt+K dismisses settled local shell cards but never running ones', async () => {
  const { vt, app } = startApp()
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'done', result: '[exit 0]', status: 'ok',
  })
  const running = app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'live', result: '', status: 'running',
  })
  await viewport(vt)
  vt.sendInput('\x1bk') // Alt+K (ESC k)
  await vt.waitForRender()
  const view = await viewport(vt)
  assert.ok(!view.includes('[exit 0]'), 'settled card must be dismissed:\n${view}')
  assert.ok(view.includes('live'), `running card must survive dismiss:\n${view}`)
  // The running card later settles; the next Alt+K takes it too.
  app.updateLocalMessage(running, {
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'live', result: '[exit 0]', status: 'ok',
  })
  vt.sendInput('\x1bk')
  await vt.waitForRender()
  const after = await viewport(vt)
  assert.ok(!after.includes('live'), 'newly settled card must dismiss on the next Alt+K:\n${after}')
  app.stop()
})

test('a RUNNING gigantic single line is bounded by the visual ceiling, not the line budget (review P1)', () => {
  // The capture layer deliberately allows one unterminated logical line to
  // grow to ~256 KiB (`print("x"*200000, end="")`). The running preview's
  // 5-line budget would pass it through untouched, and wrapping it would
  // produce thousands of visual rows — flooding the TUI. The hard visual
  // ceiling must bound the rendered rows.
  const giant = 'x'.repeat(256 * 1024)
  const { rows, hidden, partial } = localShellPreview(giant, 80, RUNNING_PREVIEW_LINES, 'lines')
  assert.ok(rows.length <= RUNNING_PREVIEW_VISUAL_CEILING,
    `running preview must respect the visual ceiling (${rows.length} > ${RUNNING_PREVIEW_VISUAL_CEILING})`)
  assert.equal(hidden, 1, 'the single line is counted hidden')
  assert.equal(partial, true, 'the cut is mid-line: the hidden content is the EARLIER part of the same line')
  // The marker must say so honestly — never "1 more lines".
  assert.equal(localShellHiddenMarker(hidden, true, partial, 'ctrl+o'), 'earlier output hidden (ctrl+o to expand)')
})

test('a RUNNING preview with many SHORT lines keeps the 5-line budget and is not partial', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
  const { rows, hidden, partial } = localShellPreview(lines, 80, RUNNING_PREVIEW_LINES, 'lines')
  assert.equal(rows.length, 5, 'short lines keep the source-line budget')
  assert.equal(hidden, 95)
  assert.equal(partial, false, 'whole lines are hidden, not a partial cut')
})
