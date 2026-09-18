/**
 * Long-user disclosure inside fullscreen + Focus: the compact marker stays a
 * click-only EXPAND (Ctrl+O owns the Thought-root bulk there), the expanded
 * tail control offers only the click, and Ctrl+O's existing root precedence is
 * preserved — with an expanded Thought root it collapses the roots AND clears
 * the long-user expansion, and it never routes through the generic user
 * viewport helper (which would fight the root's `anchor-turn` contract).
 * @module @xmoon76/dsh-pi-tui/long-user-disclosure-focus.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import type { TranscriptMessage, TurnActivity } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(width = 100, height = 40): { vt: VirtualTerminal; app: TuiApp } {
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

function clickCell(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
}

function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, index) => `${prefix}${index + 1}`).join('\n')
}

function user(text: string, turn = 0): Extract<TranscriptMessage, { kind: 'user' }> {
  return { kind: 'user', turn, text }
}

function activity(turn: number): TurnActivity {
  return {
    turn,
    completed: false,
    assistantMessages: 0,
    toolCalls: 1,
    tools: new Map([['read', 1]]),
    revision: 1,
  } as TurnActivity
}

test('fullscreen Focus: an expanded root wins over an expanded user on Ctrl+O (root precedence)', async () => {
  const { vt, app } = startApp()
  app.setTranscript(
    [
      user(lines(11, 'u-'), 1),
      { kind: 'tool', turn: 1, name: 'read', args: JSON.stringify({ path: 'a' }), result: 'ok', status: 'ok' },
    ],
    new Map([[1, activity(1)]]),
  )
  app.setFocusMode(true)
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  assert.ok(markerY >= 0, `the user starts compact with a click-only marker:\n${rows.join('\n')}`)
  assert.ok(rows[markerY]!.includes('click to expand'))
  assert.ok(!rows[markerY]!.includes('ctrl+o'), 'fullscreen Focus never promises Ctrl+O on the user card')

  // Expand the Thought root (the Ctrl+O bulk), then the long user via its
  // marker — the two disclosures coexist.
  vt.sendInput('\x0f')
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('Read')), `the root expands:\n${rows.join('\n')}`)
  const markerY2 = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY2)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('u-5')), 'the user expands by the marker click')

  // Ctrl+O with BOTH expanded: the root precedence clears the user expansion
  // and collapses the roots, keeping its own anchor-turn viewport.
  vt.sendInput('\x0f')
  rows = await viewRows(vt)
  const view = rows.join('\n')
  assert.equal(rows.filter(row => row.includes('rows compacted')).length, 1, `the user collapses:\n${view}`)
  assert.ok(!view.includes('u-5'), 'the user middle is hidden again')
  assert.ok(!view.includes('Read a'), 'the Thought root collapses too (Collapse All)')
  app.setFullscreen(false)
  app.setFocusMode(false)
  app.stop()
})
