/**
 * Focus collapsed mid-turn Notice disposition (2026-09-30 closure).
 *
 * Collapsed Focus distinguishes CAUSAL INPUT from MID-TURN PROCESS FEEDBACK
 * POSITIONALLY: a `form:'notice'` row in the turn's opening foundation stays
 * BEFORE the Thought (it explains why the turn started), while a mid-turn
 * notice renders AFTER the Thought as visible process feedback — never hidden
 * inside it, and never a candidate for the Thought's Action slot. Expanded
 * Focus restores the exact raw chronology. The decision reads the semantic
 * `form` plus raw position, never a source kind or plugin name; Compact/Full
 * never route through this disposition.
 * @module @xmoon76/dsh-pi-tui/focus-notice-suppression.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { projectFocus } from '../src/focus-activity.ts'
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

// --- F1: busy tool-jobs Notice renders AFTER the Thought ---------------------

test('F1. a busy-turn tool-jobs notice is visible after the Thought and never a hidden Action candidate', () => {
  const noticeRow = notice('Background job', 'job finished', 'tool-jobs')
  const messages = [user('go'), thinking('first'), tool(), noticeRow, thinking('second'), tool(), assistant('final')]
  const collapsedRows = collapsed(messages)
  const noticeIndex = collapsedRows.indexOf(noticeRow)
  assert.ok(noticeIndex >= 0, 'the mid-turn notice is VISIBLE while collapsed')
  const thoughtIndex = collapsedRows.findIndex(row => row.kind === 'thinking')
  // The notice renders after the Thought (its position within the visible
  // pre/post rows), never hoisted before it as causal input.
  assert.ok(thoughtIndex < 0 || noticeIndex > collapsedRows.indexOf(user('go')),
    'the notice renders after the opening causal input')
  const blocks = projectFocus(messages, noActivities, new Set(), true)
  const actionBlock = blocks.find(block => block.kind === 'activity')
  assert.ok(actionBlock === undefined || !('action' in actionBlock) || actionBlock.action?.message !== noticeRow,
    'a visible notice never contaminates the Thought Action candidate set')

  const expandedRows = expanded(messages)
  assert.deepEqual(expandedRows, messages, 'expanded Focus restores the exact raw chronology')
  assert.equal(expandedRows.indexOf(noticeRow), 3)
})

// --- F2: by form + raw position, never hardcoded source kinds ----------------

test('F2. a busy-turn subagent-settled and future-producer notice render by form, not source kind', () => {
  for (const sourceKind of ['tool-jobs', 'subagent-settled', 'future-producer']) {
    const noticeRow = notice('Agent notice', 'child settled', sourceKind)
    const messages = [user('go'), thinking('first'), tool(), noticeRow, assistant('final')]
    assert.ok(collapsed(messages).includes(noticeRow), `source ${sourceKind}: visible while collapsed`)
    assert.equal(expanded(messages).indexOf(noticeRow), 3, `source ${sourceKind}: restored when expanded`)
  }
})

// --- F3: opening Notice stays BEFORE the Thought -----------------------------

test('F3. a leading wakeup notice stays visible above the Working row', () => {
  const noticeRow = notice('Background job', 'woke the agent', 'tool-jobs')
  const messages = [noticeRow, thinking('why I resumed'), tool(), assistant('final')]
  const rows = collapsed(messages)
  assert.ok(rows.includes(noticeRow), 'the opening foundation notice stays surfaced')
  assert.equal(rows[0], noticeRow, 'it renders before the Thought')
})

test('F3b. a notice inside the opening foundation burst stays visible', () => {
  const ambientRow = ambient('AGENTS.md')
  const noticeRow = notice('Background job', 'woke the agent', 'tool-jobs')
  const thinkingRow = thinking('process')
  const messages = [ambientRow, noticeRow, thinkingRow]
  const rows = collapsed(messages)
  assert.ok(rows.includes(ambientRow) && rows.includes(noticeRow), 'opening foundation rows survive')
})

// --- F4: mid-turn relay stays visible (unchanged) ----------------------------

test('F4. a mid-turn relay remains visible while collapsed', () => {
  const relayRow = relay('child-2')
  const messages = [user('go'), thinking('first'), relayRow, thinking('second'), assistant('final')]
  const rows = collapsed(messages)
  assert.ok(rows.includes(relayRow), 'an external Agent-authored input is never hidden with a notice')
})

// --- F5: notice between two Process regions ----------------------------------

test('F5. a notice between Process regions renders after the Thought; expanded restores in place', () => {
  const noticeRow = notice('Background job', 'between', 'subagent-settled')
  const firstProcess = thinking('before')
  const secondProcess = thinking('after')
  const messages = [user('go'), firstProcess, tool(), noticeRow, secondProcess, tool(), assistant('final')]
  const collapsedRows = collapsed(messages)
  assert.ok(collapsedRows.includes(noticeRow), 'the between-regions notice renders a standalone visible row while collapsed')
  assert.equal(collapsedRows.filter(row => row.kind === 'user').length, 1, 'the causal opening user row still renders')

  const expandedRows = expanded(messages)
  const beforeIndex = expandedRows.indexOf(firstProcess)
  const noticeIndex = expandedRows.indexOf(noticeRow)
  const afterIndex = expandedRows.indexOf(secondProcess)
  assert.ok(beforeIndex >= 0 && noticeIndex > beforeIndex && afterIndex > noticeIndex,
    'expanded restores Process -> Notice -> Process order')
})

// --- F7: user/steer rows are never moved or swallowed ------------------------

test('F7. the notice disposition never moves or swallows a user/steer row', () => {
  const steerRow = steer('steered mid-turn')
  const noticeRow = notice('Background job', 'mid', 'tool-jobs')
  const messages = [user('opening'), thinking('process'), noticeRow, steerRow, tool()]
  const rows = collapsed(messages)
  assert.equal(rows[0]!.kind, 'user')
  assert.ok(rows.includes(steerRow), 'a same-turn steer stays visible')
  assert.ok(rows.includes(noticeRow), 'the mid-turn notice is visible too')
})

// --- F8: turn-less split keeps the consecutive-run grouping ------------------

test('F8. a turn split by a turn-less row keeps the consecutive-run grouping (a notice starting its own run is opening foundation)', () => {
  // A turn-less entry SPLITS turn 1 into two runs. The notice starts the second
  // run, so its own lead boundary is the run start and the projection renders
  // it as that run's opening foundation.
  const noticeRow = notice('Background job', 'after the split', 'tool-jobs')
  const messages = [user('opening'), thinking('before'), summary('… older'), noticeRow, thinking('after')]
  assert.ok(collapsed(messages).includes(noticeRow), 'the projection renders the notice in its own run')
})

// --- F6 + F9/F10: real-TUI search / Compact / Full controls -------------------

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
  const source = { kind: 'tool-jobs', form: 'notice', summary: 'NOTICE_SUMMARY', senderSessionId: 'job-1' }
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 1000, 0),
    eventAt('user/message', { id: MessageId('u1'), role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, 1001, 1),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'first reasoning' } }, 1002, 2),
    eventAt('tool/call', { turn: 1, step: 0, callId: 'c1', name: 'read', arguments: '{}' }, 1003, 3),
    eventAt('user/message', { id: MessageId('notice-1'), role: 'user', content: [{ type: 'text', text: 'notice payload NOTICE_PAYLOAD' }], source }, 1004, 4),
    eventAt('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'second reasoning' } }, 1005, 5),
    eventAt('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{}' }, 1006, 6),
  ])
  const noticeRow = folder.messages().find(message => message.kind === 'system' && message.contextPresentation?.form === 'notice')
  assert.ok(noticeRow !== undefined, 'fixture: the mid-turn notice folds')
  return { folder, noticeRow }
}

test('F6. searching a durable mid-turn notice needs no Focus root reveal and dismiss keeps it visible', async () => {
  const { vt, app } = startApp('focus')
  const { folder, noticeRow } = busyTurnWithNoticeFixture()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('NOTICE_SUMMARY'), `the mid-turn notice is visible while collapsed (post-Thought):\n${view}`)

  app.setTranscriptSearchTarget({
    query: 'NOTICE_PAYLOAD',
    match: { id: 0, turn: 1, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: noticeRow,
  })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('NOTICE_SUMMARY'), `the notice stays visible during the search:\n${view}`)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'the search never opens a manual Thought state for an already-visible row')

  app.finishTranscriptSearchPresentation(new Set())
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('NOTICE_SUMMARY'), `dismiss does NOT hide the notice again — it is an ordinary visible row:\n${view}`)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'no manual disclosure state is created')
})

test('F9. a Compact notice stays a standalone row (this disposition is Focus-only)', async () => {
  const { vt, app } = startApp('compact')
  const { folder } = busyTurnWithNoticeFixture()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('NOTICE_SUMMARY'), `Compact keeps the notice standalone:\n${view}`)
})
