/**
 * PR4 addendum: Focus collapsed mid-turn Notice suppression.
 *
 * Collapsed Focus distinguishes CAUSAL INPUT from MID-TURN PROCESS FEEDBACK:
 * a `form:'notice'` row in the turn's opening foundation stays visible (it
 * explains why the Agent resumed), while a mid-turn notice is hidden inside
 * the collapsed Thought and restored in raw chronology when the Thought opens.
 * The decision reads the semantic `form`, never a source kind or plugin name;
 * Compact/Full never route through this predicate.
 * @module @xmoon76/dsh-pi-tui/focus-notice-suppression.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isCollapsedFocusHiddenRow, projectFocus } from '../src/focus-activity.ts'
import { TranscriptFolder, type TranscriptMessage } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import type { DisplayState } from '../src/display-preset.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

const TURN = 1
const noActivities = new Map()

const user = (text: string): TranscriptMessage => ({ kind: 'user', turn: TURN, text })
const steer = (text: string): TranscriptMessage => ({ kind: 'user', turn: TURN, text, steer: true })
const thinking = (text: string): TranscriptMessage => ({ kind: 'thinking', turn: TURN, text, running: true })
const tool = (): TranscriptMessage => ({ kind: 'tool', turn: TURN, name: 'read', args: '{}', result: 'ok', status: 'ok' })
const assistant = (text: string): TranscriptMessage => ({ kind: 'assistant', turn: TURN, text })
const notice = (label: string, summary: string, sourceKind: string): TranscriptMessage => ({
  kind: 'system', turn: TURN, text: 'notice payload', label, summary, icon: 'context-notice', context: true,
  contextPresentation: { form: 'notice', sourceKind, role: 'inject' },
})
const relay = (sender: string): TranscriptMessage => ({
  kind: 'system', turn: TURN, text: `relay body from ${sender}`, label: 'agent-message', context: true,
  contextPresentation: { form: 'relay', sourceKind: 'agent-message', senderSessionId: sender, role: 'inject' },
})
const ambient = (label: string): TranscriptMessage => ({
  kind: 'system', turn: TURN, text: `${label} body`, label, context: true,
  contextPresentation: { form: 'instructions', sourceKind: 'plugin', role: 'inject' },
})
const summary = (text: string): TranscriptMessage => ({ kind: 'summary', text })

/** Flatten the F6 nested Work containers back into member rows: these tests
 * assert the raw Focus chronology, and the canonical span keeps its members
 * inside the container. */
function flatRows(blocks: ReturnType<typeof projectFocus>): TranscriptMessage[] {
  return blocks.flatMap(block => block.kind === 'work'
    ? [...block.span.members]
    : block.kind === 'message' ? [block.message] : [])
}

function collapsed(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  return flatRows(projectFocus(messages, noActivities, new Set(), true))
}

function expanded(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  return flatRows(projectFocus(messages, noActivities, new Set([TURN]), true))
}

// --- 1/2: busy-turn notice is absorbed by the collapsed Thought -------------

test('1. a busy-turn tool-jobs notice is hidden while collapsed and restored in raw chronology when expanded', () => {
  const noticeRow = notice('Background job', 'job finished', 'tool-jobs')
  const messages = [user('go'), thinking('first'), tool(), noticeRow, thinking('second'), tool(), assistant('final')]
  const collapsedRows = collapsed(messages)
  assert.ok(!collapsedRows.includes(noticeRow), 'the mid-turn notice is hidden inside the collapsed Thought')
  assert.deepEqual(collapsedRows.map(row => row.kind), ['user'], 'only the causal opening input stays visible')

  const expandedRows = expanded(messages)
  assert.deepEqual(expandedRows, messages, 'expanded Focus restores the exact raw chronology')
  assert.equal(expandedRows.indexOf(noticeRow), 3)
})

test('2. a busy-turn subagent-settled notice is hidden by form, not by source kind', () => {
  for (const sourceKind of ['tool-jobs', 'subagent-settled', 'future-producer']) {
    const noticeRow = notice('Agent notice', 'child settled', sourceKind)
    const messages = [user('go'), thinking('first'), tool(), noticeRow, assistant('final')]
    assert.ok(!collapsed(messages).includes(noticeRow), `source ${sourceKind}: hidden while collapsed`)
    assert.equal(expanded(messages).indexOf(noticeRow), 3, `source ${sourceKind}: restored when expanded`)
  }
})

// --- 3: leading / causal notice --------------------------------------------

test('3. a leading wakeup notice stays visible above the Working row', () => {
  const noticeRow = notice('Background job', 'woke the agent', 'tool-jobs')
  const messages = [noticeRow, thinking('why I resumed'), tool(), assistant('final')]
  assert.ok(collapsed(messages).includes(noticeRow), 'the opening foundation notice stays surfaced')
  assert.equal(collapsed(messages)[0], noticeRow, 'it renders before the Thought')
})

test('3b. a notice inside the opening foundation burst stays visible', () => {
  const ambientRow = ambient('AGENTS.md')
  const noticeRow = notice('Background job', 'woke the agent', 'tool-jobs')
  const thinkingRow = thinking('process')
  const messages = [ambientRow, noticeRow, thinkingRow]
  const rows = collapsed(messages)
  assert.ok(rows.includes(ambientRow) && rows.includes(noticeRow), 'opening foundation rows survive')
})

// --- 4: mid-turn relay stays visible ---------------------------------------

test('4. a mid-turn relay remains visible while collapsed', () => {
  const relayRow = relay('child-2')
  const messages = [user('go'), thinking('first'), relayRow, thinking('second'), assistant('final')]
  const rows = collapsed(messages)
  assert.ok(rows.includes(relayRow), 'an external Agent-authored input is never hidden with a notice')
})

// --- 5: notice between two Process regions ---------------------------------

test('5. a notice between Process regions creates no standalone collapsed row and restores in place when expanded', () => {
  const noticeRow = notice('Background job', 'between', 'subagent-settled')
  const firstProcess = thinking('before')
  const secondProcess = thinking('after')
  const messages = [user('go'), firstProcess, tool(), noticeRow, secondProcess, tool(), assistant('final')]
  const collapsedRows = collapsed(messages)
  assert.ok(!collapsedRows.includes(noticeRow), 'no standalone visible row while collapsed')
  assert.equal(collapsedRows.filter(row => row.kind === 'user').length, 1, 'the causal opening user row still renders')

  const expandedRows = expanded(messages)
  const beforeIndex = expandedRows.indexOf(firstProcess)
  const noticeIndex = expandedRows.indexOf(noticeRow)
  const afterIndex = expandedRows.indexOf(secondProcess)
  assert.ok(beforeIndex >= 0 && noticeIndex > beforeIndex && afterIndex > noticeIndex,
    'expanded restores Process -> Notice -> Process order')
})

// --- 7: user/steer rows are never moved or swallowed ------------------------
test('7. the notice suppression never moves or swallows a user/steer row', () => {
  const steerRow = steer('steered mid-turn')
  const noticeRow = notice('Background job', 'mid', 'tool-jobs')
  const messages = [user('opening'), thinking('process'), noticeRow, steerRow, tool()]
  const rows = collapsed(messages)
  assert.equal(rows[0]!.kind, 'user')
  assert.ok(rows.includes(steerRow), 'a same-turn steer stays visible')
  assert.ok(!rows.includes(noticeRow), 'only the mid-turn notice is suppressed')
})

// --- 8: grouping parity on a turn split by a window summary -----------------

test('8. a turn split by a turn-less row keeps the consecutive-run grouping (reveal predicate agrees with the projection)', () => {
  // A turn-less entry SPLITS turn 1 into two runs. The notice starts the second
  // run, so its own lead boundary is the run start and the projection renders
  // it; the reveal predicate must use the SAME consecutive grouping instead of
  // reconstructing an all-same-turn group (which would wrongly call it hidden).
  const noticeRow = notice('Background job', 'after the split', 'tool-jobs')
  const messages = [user('opening'), thinking('before'), summary('… older'), noticeRow, thinking('after')]
  assert.equal(isCollapsedFocusHiddenRow(messages, noticeRow), false,
    'the predicate mirrors the projection consecutive-run grouping')
  assert.ok(collapsed(messages).includes(noticeRow), 'the projection renders the notice in its own run')
})

// --- 6: search reveal over a hidden mid-turn notice -------------------------

function startApp(preset: DisplayState['preset']): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset } })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

function busyTurnWithNoticeFixture(): { folder: TranscriptFolder; noticeRow: TranscriptMessage } {
  const folder = new TranscriptFolder()
  const source = { kind: 'tool-jobs', form: 'notice', summary: 'HIDDEN_NOTICE_SUMMARY', senderSessionId: 'job-1' }
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 1000, 0),
    eventAt('user/message', { id: MessageId('u1'), role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, 1001, 1),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'first reasoning' } }, 1002, 2),
    eventAt('tool/call', { turn: 1, step: 0, callId: 'c1', name: 'read', arguments: '{}' }, 1003, 3),
    eventAt('user/message', { id: MessageId('notice-1'), role: 'user', content: [{ type: 'text', text: 'notice payload HIDDEN_NOTICE_PAYLOAD' }], source }, 1004, 4),
    eventAt('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'second reasoning' } }, 1005, 5),
    eventAt('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{}' }, 1006, 6),
  ])
  const noticeRow = folder.messages().find(message => message.kind === 'system' && message.contextPresentation?.form === 'notice')
  assert.ok(noticeRow !== undefined, 'fixture: the mid-turn notice folds')
  return { folder, noticeRow }
}

test('6. a search hit inside a hidden mid-turn notice reveals it temporarily and dismiss restores collapsed Focus', async () => {
  const { vt, app } = startApp('focus')
  const { folder, noticeRow } = busyTurnWithNoticeFixture()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(!view.includes('HIDDEN_NOTICE_SUMMARY'), `the mid-turn notice is hidden while collapsed:\n${view}`)

  app.setTranscriptSearchTarget({
    query: 'HIDDEN_NOTICE_PAYLOAD',
    match: { id: 0, turn: 1, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: noticeRow,
  })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('HIDDEN_NOTICE_SUMMARY'), `the search reveal surfaces the hidden notice:\n${view}`)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'the reveal never writes manual Thought state')

  app.finishTranscriptSearchPresentation(new Set())
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('HIDDEN_NOTICE_SUMMARY'), `dismiss restores collapsed Focus:\n${view}`)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'no manual disclosure state is created')
})

// --- Compact / Full are unchanged ------------------------------------------

test('a Compact notice stays a standalone row (this suppression is Focus-only)', async () => {
  const { vt, app } = startApp('compact')
  const { folder } = busyTurnWithNoticeFixture()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('HIDDEN_NOTICE_SUMMARY'), `Compact keeps the notice standalone:\n${view}`)
})
