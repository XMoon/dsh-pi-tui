/**
 * Transcript-search navigation regression matrix (plan §14.6/§14.7): the
 * TuiApp-level occurrence highlight / reveal / viewport-anchor contract that
 * the old card-level tests could not exercise.
 * @module @xmoon76/dsh-pi-tui/transcript-search-navigation.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import type { TranscriptMessage, TranscriptToolMessage } from '../src/transcript.ts'
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
