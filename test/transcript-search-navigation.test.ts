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
import { TranscriptFolder, workflowPhaseKey, type TranscriptMessage, type TranscriptToolMessage } from '../src/transcript.ts'
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

test('navigation: the current strong highlight moves between occurrences in one source', async () => {
  const { vt, app } = startApp()
  // A Workflow member label is a direct projection with proven columns, so its
  // two occurrences can each be the exact current occurrence.
  const card = {
    kind: 'workflow', turn: 0, runId: 'run-1' as never, name: 'audit', status: 'running',
    members: [{ seq: 0, label: 'needle alpha needle beta', phase: 'P', childId: 'child-0' as never, status: 'running' }],
  } as Extract<TranscriptMessage, { kind: 'workflow' }>
  app.setFullscreen(true)
  app.setTranscript([card])
  let lines = await viewport(vt)
  let cells = occurrenceCells(lines)

  const target = (occurrence: number) => ({
    query: 'needle',
    match: {
      id: 0, turn: 0, occurrence,
      source: { kind: 'workflow-member' as const, phaseKey: workflowPhaseKey('P'), seq: 0, field: 'label' as const },
      sourceOccurrence: occurrence,
    },
    message: card,
  })
  app.setTranscriptSearchTarget(target(0))
  lines = await viewport(vt)
  cells = occurrenceCells(lines)
  assert.equal(vt.getCellBgRgb(cells.row, cells.first), 0xf5c542, `the FIRST occurrence is current:\n${lines.join('\n')}`)
  assert.equal(vt.getCellBgRgb(cells.row, cells.second), undefined, 'the second occurrence is not current')
  assert.ok(!vt.getCellInverse(cells.row, cells.first), 'the themed block never uses the terminal inverse attribute')

  app.setTranscriptSearchTarget(target(1))
  lines = await viewport(vt)
  cells = occurrenceCells(lines)
  assert.equal(vt.getCellBgRgb(cells.row, cells.first), undefined, 'the first occurrence is no longer current')
  assert.equal(vt.getCellBgRgb(cells.row, cells.second), 0xf5c542, 'the SECOND occurrence is current')
  app.stop()
})

test('navigation: a reveal still expands an anchor-only card and anchors its top', async () => {
  const { vt, app } = startApp(100, 20)
  const longText = Array.from({ length: 24 }, (_, index) => `line ${index}`).join('\n')
    + '\nneedle in the compacted middle\n' + Array.from({ length: 6 }, (_, index) => `tail ${index}`).join('\n')
  const message: TranscriptMessage = { kind: 'user', turn: 0, text: longText }
  app.setFullscreen(true)
  app.setTranscript([message])
  const collapsed = (await viewport(vt)).join('\n')
  assert.ok(!collapsed.includes('needle in the compacted middle'), 'precondition: the middle is compacted away')
  assert.ok(collapsed.includes('rows compacted'), 'precondition: the bubble is compacted')

  app.setTranscriptSearchTarget({
    query: 'compacted middle',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message,
  })
  app.scrollToSearchTarget()
  const revealed = (await viewport(vt)).join('\n')
  // A compact-capable long bubble inserts marker/tail chrome rows, so its whole
  // card is NOT occurrence-preserving: the reveal still EXPANDS it, and the
  // selection anchors at the owning card top (no guessed strong occurrence).
  assert.ok(!revealed.includes('rows compacted'), `the search reveal must expand the bubble:\n${revealed}`)
  assert.ok(revealed.includes('line 0'), `the anchor lands on the owning card top:\n${revealed}`)
  app.stop()
})

test('navigation: clearing the target removes the reveal and every decoration', async () => {
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
  // A user bubble's whole card injects the `❯` marker: anchor-only, so the
  // current card's matches are decorated WEAKLY.
  assert.ok(vt.getCellUnderline(cells.row, cells.first), 'precondition: the target occurrence is weak-decorated')
  assert.ok(!vt.getCellInverse(cells.row, cells.first), 'a message-kind card is anchor-only')

  app.setTranscriptSearchTarget(undefined)
  lines = await viewport(vt)
  cells = occurrenceCells(lines)
  assert.ok(!vt.getCellUnderline(cells.row, cells.first), 'clearing removes the first decoration')
  assert.ok(!vt.getCellUnderline(cells.row, cells.second), 'clearing removes every decoration')
  assert.ok(!vt.getCellInverse(cells.row, cells.first), 'clearing leaves no strong highlight')
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
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'workflow-member', phaseKey: workflowPhaseKey('P'), seq: 0, field: 'label' }, sourceOccurrence: 0 },
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
  // 'read' renders in the merged read head as the tool NAME — a direct
  // projection, so it is a provable occurrence (the read result body itself
  // needs a presenter).
  const match = folder.search('read').find(m => m.source.kind === 'tool-field' && m.source.field === 'name')!
  const message = folder.resolveSearchMatch(match)!
  app.setTranscriptSearchTarget({ query: 'read', match, message })
  let lines = await viewport(vt)
  let row = lines.findIndex(line => line.includes('Read 2 files'))
  assert.ok(row >= 0 && vt.getCellUnderline(row, lines[row]!.indexOf('Read')), 'precondition: the target card is decorated (anchor-only source)')

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
  // The rebind re-attached the presentation to the NEW card object: without it
  // the card would not even be decorated (identity would not match).
  assert.ok(vt.getCellUnderline(row, lines[row]!.indexOf('Read')), 'the rebind keeps the reflowed card decorated')
  assert.ok(!vt.getCellInverse(row, lines[row]!.indexOf('Read')), 'a tool name/args source stays anchor-only (no guessed strong)')
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
        id: MessageId('r1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: 'needle output' }] }],
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
  assert.ok(!vt.getCellInverse(headerRow, lines[headerRow]!.indexOf('needle')), 'the ARGS hit must not strong-highlight the summary')

  // A tool RESULT has no provable rendered occurrence either: it anchors with
  // no strong highlight, so it can never mislabel another occurrence as the
  // current N/M hit.
  app.setTranscriptSearchTarget({ query: 'needle', match: resultMatch, message: card })
  lines = await viewport(vt)
  const resultRow = lines.findIndex(line => line.includes('needle output'))
  assert.ok(resultRow >= 0, `tool result body must render:\n${lines.join('\n')}`)
  assert.ok(!vt.getCellInverse(resultRow, lines[resultRow]!.indexOf('needle')), 'the RESULT hit must NOT strong-highlight a guessed occurrence')
  assert.ok(!vt.getCellInverse(headerRow, lines[headerRow]!.indexOf('needle')), 'the args header is not current either')
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
      message: { id: MessageId('a1'), role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [],
    }, 2),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
  ])
  const matches = folder.search('report')
  const pathMatch = matches.find(m => m.source.kind === 'assistant-deliverable' && m.source.field === 'path')
  const descriptionMatch = matches.find(m => m.source.kind === 'assistant-deliverable' && m.source.field === 'description')
  assert.ok(pathMatch !== undefined && descriptionMatch !== undefined, `both deliverable fields must match: ${JSON.stringify(matches)}`)

  const { vt, app } = startApp()
  app.setFullscreen(true)
  const card = folder.messages()[0]!
  app.setTranscript([card], folder.turnActivities())

  app.setTranscriptSearchTarget({ query: 'report', match: pathMatch, message: card })
  let lines = await viewport(vt)
  const pathRow = lines.findIndex(line => line.includes('out/report.md'))
  assert.ok(pathRow >= 0, `delivered path row missing:\n${lines.join('\n')}`)
  // The path is RELATIVIZED (raw prefix removed), so a raw ordinal cannot be
  // proven: anchor only, no strong highlight.
  assert.ok(!vt.getCellInverse(pathRow, lines[pathRow]!.indexOf('report')), 'the PATH hit must not strong-highlight a relativized path')

  app.setTranscriptSearchTarget({ query: 'report', match: descriptionMatch, message: card })
  lines = await viewport(vt)
  const descriptionRow = lines.findIndex(line => line.includes('Final report'))
  assert.ok(descriptionRow >= 0, `delivered description row missing:\n${lines.join('\n')}`)
  // The description is WRAPPED (and hard-broken for over-wide tokens), which
  // can drop a raw occurrence from the rendered corpus: anchor only.
  assert.ok(!vt.getCellInverse(descriptionRow, lines[descriptionRow]!.indexOf('report')), 'the DESCRIPTION hit must not strong-highlight a wrapped description')
  assert.ok(!vt.getCellInverse(pathRow, lines[pathRow]!.indexOf('report')), 'the path row is not the current occurrence')
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
  assert.ok(!vt.getCellInverse(bodyRow, lines[bodyRow]!.indexOf('needle')), 'the child RESULT hit must not strong-highlight a truncated body')
  const headerRow = lines.findIndex(line => line.includes('echo needle'))
  assert.ok(headerRow < 0 || !vt.getCellInverse(headerRow, lines[headerRow]!.indexOf('needle')), 'the header/command row is not the current occurrence')
  app.stop()
})

test('navigation: a Thinking header chrome is never strong-highlighted for a body hit', async () => {
  const { vt, app } = startApp()
  const message: TranscriptMessage = { kind: 'thinking', turn: 0, text: 'thinking about search' }
  app.setFullscreen(true)
  app.setTranscript([message])
  app.setTranscriptSearchTarget({
    query: 'thinking',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message,
  })
  const lines = await viewport(vt)
  const headerRow = lines.findIndex(line => /Thinking/.test(line))
  assert.ok(headerRow >= 0, `thinking header must render:\n${lines.join('\n')}`)
  assert.ok(!vt.getCellInverse(headerRow, 0), 'the injected Thinking header must NOT be the current occurrence')
  const bodyRow = lines.findIndex(line => line.includes('about search'))
  assert.ok(bodyRow >= 0, `thinking body must render:\n${lines.join('\n')}`)
  assert.ok(!vt.getCellInverse(bodyRow, lines[bodyRow]!.indexOf('about')), 'the thinking body is anchor-only (no strong)')
  app.stop()
})

test('navigation: the user bubble marker is never strong-highlighted for a body hit', async () => {
  const { vt, app } = startApp()
  const message: TranscriptMessage = { kind: 'user', turn: 0, text: '❯ body' }
  app.setFullscreen(true)
  app.setTranscript([message])
  app.setTranscriptSearchTarget({
    query: '❯',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message,
  })
  const lines = await viewport(vt)
  const row = lines.findIndex(line => line.includes('body'))
  assert.ok(row >= 0, `user bubble must render:\n${lines.join('\n')}`)
  const markerCol = lines[row]!.indexOf('❯')
  assert.ok(markerCol >= 0, `the bubble marker must render:\n${lines.join('\n')}`)
  assert.ok(!vt.getCellInverse(row, markerCol), 'the injected bubble marker must NOT be the current occurrence')
  app.stop()
})

test('navigation: an anchor-only current shows a weaker anchor wash and no strong occurrence', async () => {
  const { vt, app } = startApp()
  const message: TranscriptMessage = { kind: 'user', turn: 0, text: 'needle alpha needle beta' }
  app.setFullscreen(true)
  app.setTranscript([message])
  app.setTranscriptSearchTarget({
    query: 'needle',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message,
  })
  const lines = await viewport(vt)
  const cells = occurrenceCells(lines)
  // The occurrences stay WEAK; the card's anchor row carries the weaker
  // "current result lives here" wash — never the exact occurrence block.
  assert.ok(vt.getCellUnderline(cells.row, cells.first), 'the occurrence is weak-decorated')
  assert.notEqual(vt.getCellBgRgb(cells.row, 0), 0xf5c542, 'an anchor-only current never paints the exact block')
  assert.equal(vt.getCellBgRgb(cells.row, 0), 0x3a3220, `the anchor row carries the weaker current wash:\n${lines.join('\n')}`)
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
        id: MessageId('r1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: 'needle output' }] }],
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

test('navigation: a wrapped deliverable description never strong-highlights a renumbered occurrence', async () => {
  const event = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
    ({ type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent)
  // The filler pushes `alpha` to the END of line 1, so `alpha beta` SPANS the
  // wrap and a second `alpha beta` sits on line 2. Wrapping can drop a raw
  // occurrence from the rendered corpus, so a surviving match must never be
  // renumbered as sourceOccurrence 0 and strong-highlighted.
  const description = `${'x'.repeat(84)} alpha beta alpha beta`
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
  const line1 = lines.findIndex(line => line.includes('xxxx') && line.includes('alpha'))
  const line2 = lines.findIndex(line => line.includes('alpha') && line.includes('beta') && !line.includes('xxxx'))
  assert.ok(line1 >= 0 && line2 >= 0, `wrapped description must render:\n${lines.join('\n')}`)
  assert.ok(!vt.getCellInverse(line1, lines[line1]!.indexOf('alpha')), 'line 1 must not be a guessed strong occurrence')
  assert.ok(!vt.getCellInverse(line2, lines[line2]!.indexOf('beta')), 'line 2 must not be renumbered as the current occurrence')
  app.stop()
})

test('navigation: a hard-wrapped description token never strong-highlights a surviving occurrence', async () => {
  const event = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
    ({ type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent)
  // A long no-space token is hard-broken by the wrapper, so a query spanning
  // the break (`ghij`) disappears from the rendered corpus while a later
  // `ghij` survives — it must NOT be renumbered as sourceOccurrence 0.
  const description = `${'abcdefghij'.repeat(12)}ijklmnop needle ghij`
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
  const match = folder.search('ghij')[0]!
  assert.deepEqual(match.source, { kind: 'assistant-deliverable', index: 0, field: 'description' })

  const { vt, app } = startApp()
  app.setFullscreen(true)
  const card = folder.messages()[0]!
  app.setTranscript([card], folder.turnActivities())
  app.setTranscriptSearchTarget({ query: 'ghij', match, message: card })
  const lines = await viewport(vt)
  const surviving = lines.findIndex(line => line.includes('ghij'))
  assert.ok(surviving >= 0, `the surviving occurrence must render:\n${lines.join('\n')}`)
  assert.ok(!vt.getCellInverse(surviving, lines[surviving]!.indexOf('ghij')), 'a surviving hard-wrap match must not be the current occurrence')
  app.stop()
})
