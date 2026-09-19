/**
 * Transcript-search navigation regression matrix (plan §14.6/§14.7): the
 * TuiApp-level occurrence highlight / reveal / viewport-anchor contract that
 * the old card-level tests could not exercise.
 * @module @xmoon76/dsh-pi-tui/transcript-search-navigation.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TuiApp } from '../src/tui-app.ts'
import { TranscriptFolder, type TranscriptMessage, type TranscriptToolMessage } from '../src/transcript.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

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

test('navigation: the current strong highlight moves between occurrences in one card', async () => {
  const { vt, app } = startApp()
  const message: TranscriptMessage = { kind: 'user', turn: 0, text: 'needle alpha needle beta' }
  app.setFullscreen(true)
  app.setTranscript([message])
  let lines = await viewport(vt)
  let cells = occurrenceCells(lines)

  const target = (occurrence: number) => ({
    query: 'needle',
    match: { id: 0, turn: 0, occurrence, source: { kind: 'message' as const }, sourceOccurrence: occurrence },
    message,
  })
  app.setTranscriptSearchTarget(target(0))
  lines = await viewport(vt)
  cells = occurrenceCells(lines)
  assert.ok(vt.getCellInverse(cells.row, cells.first), `the FIRST occurrence is current:\n${lines.join('\n')}`)
  assert.ok(!vt.getCellInverse(cells.row, cells.second), 'the second occurrence is not current')

  app.setTranscriptSearchTarget(target(1))
  lines = await viewport(vt)
  cells = occurrenceCells(lines)
  assert.ok(!vt.getCellInverse(cells.row, cells.first), 'the first occurrence is no longer current')
  assert.ok(vt.getCellInverse(cells.row, cells.second), 'the SECOND occurrence is current')
  app.stop()
})

test('navigation: a reveal that changes height still anchors the hidden occurrence', async () => {
  const { vt, app } = startApp(100, 20)
  const longText = Array.from({ length: 24 }, (_, index) => `line ${index}`).join('\n')
    + '\nneedle in the compacted middle\n' + Array.from({ length: 6 }, (_, index) => `tail ${index}`).join('\n')
  const message: TranscriptMessage = { kind: 'user', turn: 0, text: longText }
  app.setFullscreen(true)
  app.setTranscript([message])
  const collapsed = (await viewport(vt)).join('\n')
  assert.ok(!collapsed.includes('needle in the compacted middle'), 'precondition: the middle is compacted away')

  app.setTranscriptSearchTarget({
    query: 'compacted middle',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message,
  })
  app.scrollToSearchTarget()
  const revealedLines = await viewport(vt)
  const revealed = revealedLines.join('\n')
  assert.ok(revealed.includes('needle in the compacted middle'), `the revealed occurrence must be anchored into view:\n${revealed}`)
  const row = revealedLines.findIndex(line => line.includes('needle in the compacted middle'))
  const col = revealedLines[row]!.indexOf('compacted')
  assert.ok(vt.getCellInverse(row, col), 'the current occurrence keeps its strong highlight')
  app.stop()
})

test('navigation: clearing the target removes the reveal and every highlight', async () => {
  const { vt, app } = startApp()
  const message: TranscriptMessage = { kind: 'user', turn: 0, text: 'needle alpha needle beta' }
  app.setFullscreen(true)
  app.setTranscript([message])
  app.setTranscriptSearchTarget({
    query: 'needle',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message,
  })
  let lines = await viewport(vt)
  let cells = occurrenceCells(lines)
  assert.ok(vt.getCellInverse(cells.row, cells.first), 'precondition: the target highlights the first occurrence')

  app.setTranscriptSearchTarget(undefined)
  lines = await viewport(vt)
  cells = occurrenceCells(lines)
  assert.ok(!vt.getCellInverse(cells.row, cells.first), 'clearing removes the highlight')
  assert.ok(!vt.getCellInverse(cells.row, cells.second), 'clearing removes every occurrence highlight')
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
  const a: TranscriptMessage = { kind: 'user', turn: 0, text: 'alpha needle one' }
  const b: TranscriptMessage = { kind: 'user', turn: 1, text: 'beta needle two' }
  const c: TranscriptMessage = { kind: 'user', turn: 2, text: 'gamma without the term' }
  app.setFullscreen(true)
  app.setTranscript([a, b, c])
  app.setTranscriptSearchTarget({
    query: 'needle',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: a,
  })
  const lines = await viewport(vt)
  const aRow = lines.findIndex(line => line.includes('alpha needle one'))
  const bRow = lines.findIndex(line => line.includes('beta needle two'))
  const cRow = lines.findIndex(line => line.includes('gamma without the term'))
  assert.ok(aRow >= 0 && bRow >= 0 && cRow >= 0, `all cards visible:\n${lines.join('\n')}`)
  const aCol = lines[aRow]!.indexOf('needle')
  const bCol = lines[bRow]!.indexOf('needle')
  assert.ok(vt.getCellInverse(aRow, aCol), 'the target occurrence is strong (inverse)')
  assert.ok(!vt.getCellUnderline(aRow, aCol), 'the target occurrence is not weak')
  assert.ok(vt.getCellUnderline(bRow, bCol), 'the other VISIBLE matching card is weak (underline)')
  assert.ok(!vt.getCellInverse(bRow, bCol), 'the other matching card is not strong')
  assert.ok(!vt.getCellUnderline(cRow, lines[cRow]!.indexOf('gamma')), 'a non-matching card is untouched')
  app.stop()
})

test('navigation: a live group reflow keeps the current highlight via stable-match rebind', async () => {
  const event = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
    ({ type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent)
  const readCall = (seq: number, callId: string, file: string, turn: number): SessionEvent =>
    event('tool/call', { turn, step: 0, callId: ToolCallId(callId), name: 'read', arguments: JSON.stringify({ file }) }, seq)
  const readResult = (seq: number, callId: string, text: string, turn: number): SessionEvent =>
    event('tool/result', {
      turn, step: 0,
      message: {
        id: MessageId(`m-${seq}`), role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId(callId), content: [{ type: 'text', text }] }],
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
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5),
  ])
  const project = () => folder.window({ maxTurns: 50 })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript(project().messages, folder.turnActivities())
  // 'files' renders in the merged read head (`Read 2 files`) — the read body
  // itself needs a presenter, so the head is the visible occurrence here.
  const match = folder.search('files')[0]!
  const message = folder.resolveSearchMatch(match)!
  app.setTranscriptSearchTarget({ query: 'files', match, message })
  let lines = await viewport(vt)
  let row = lines.findIndex(line => line.includes('Read 2 files'))
  assert.ok(row >= 0 && vt.getCellInverse(row, lines[row]!.indexOf('files')), 'precondition: the target is highlighted')

  // A late cross-turn read joins the group: the representative card OBJECT is
  // replaced by the reflow, while match.id/source stay stable.
  folder.apply([
    event('turn/start', { turn: 1 }, 6),
    readCall(7, 'r3', 'src/c.ts', 1),
    readResult(8, 'r3', 'shared token C', 1),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 9),
  ])
  app.setTranscript(project().messages, folder.turnActivities())
  // The runner's per-repaint sync (stable match → current card object).
  app.rebindTranscriptSearchTarget(folder.resolveSearchMatch(match))

  lines = await viewport(vt)
  row = lines.findIndex(line => line.includes('Read 3 files'))
  assert.ok(row >= 0, `the reflowed group card is visible:\n${lines.join('\n')}`)
  assert.ok(vt.getCellInverse(row, lines[row]!.indexOf('files')), 'the rebind keeps the current occurrence strong after reflow')
  app.stop()
})
