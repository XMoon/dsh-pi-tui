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
import { projectFocus, type FocusProjectedBlock } from '../src/focus-activity.ts'
import { TranscriptFolder, type TurnActivity, type TranscriptMessage } from '../src/transcript.ts'
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

/** One live turn activity so the collapsed projection materializes an actual
 * Thought block (the positional assertions below need the real block order,
 * not only the emitted rows). */
function liveActivity(turn = TURN): TurnActivity {
  return {
    turn, startedAt: 1000, endedAt: 0, completed: false,
    think: { text: 'work reasoning', running: true },
    tools: new Map(), toolCalls: 0, assistantMessages: 0, revision: 0,
  }
}

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

/** The BLOCK-order signature of one collapsed projection with a live Thought:
 * each entry is the message row's label (falling back to its kind), or
 * `'<Thought>'` for the activity block. This is what locks the pre/post-
 * Thought POSITION semantics. */
function collapsedBlockOrder(
  messages: readonly TranscriptMessage[],
  activity: TurnActivity = liveActivity(),
): string[] {
  const blocks = projectFocus(messages, new Map([[TURN, activity]]), new Set(), true)
  const out: string[] = []
  for (const block of blocks) {
    if (block.kind === 'activity') out.push('<Thought>')
    else if (block.kind === 'message') {
      const message = block.message as TranscriptMessage & { label?: string }
      out.push(message.label ?? message.kind)
    } else out.push('<work>')
  }
  return out
}

// --- F1: busy tool-jobs Notice renders AFTER the Thought ---------------------

test('F1. a busy-turn tool-jobs notice is visible after the Thought and never a hidden Action candidate', () => {
  const noticeRow = notice('Background job', 'job finished', 'tool-jobs')
  const messages = [user('go'), thinking('first'), tool(), noticeRow, thinking('second'), tool(), assistant('final')]
  const collapsedRows = collapsed(messages)
  const noticeIndex = collapsedRows.indexOf(noticeRow)
  assert.ok(noticeIndex >= 0, 'the mid-turn notice is VISIBLE while collapsed')
  // The BLOCK order locks the position: the opening user, then the Thought,
  // then the post-Thought notice.
  assert.deepEqual(
    collapsedBlockOrder(messages),
    ['user', '<Thought>', 'Background job'],
    'collapsed Focus renders User -> Thought -> Notice',
  )
  // With a LIVE activity the Thought block exists, and its Action winner is
  // selected from the hidden rows only: the latest hidden tool evidence,
  // never the now-visible post-Thought notice.
  const lastToolRow = messages[messages.length - 2]!
  assert.equal(lastToolRow.kind, 'tool', 'fixture: a tool row is the latest hidden evidence')
  const liveBlocks = projectFocus(messages, new Map([[TURN, liveActivity()]]), new Set(), true)
  const actionBlock = liveBlocks.find(block => block.kind === 'activity')
  assert.ok(actionBlock !== undefined, 'fixture: the live activity materializes a Thought block')
  assert.equal(actionBlock?.action?.message, lastToolRow,
    'the Action winner is the hidden tool evidence, never the visible notice')

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

test('F3. a leading wakeup notice stays visible BEFORE the Thought', () => {
  const noticeRow = notice('Background job', 'woke the agent', 'tool-jobs')
  const messages = [noticeRow, thinking('why I resumed'), tool(), assistant('final')]
  const rows = collapsed(messages)
  assert.ok(rows.includes(noticeRow), 'the opening foundation notice stays surfaced')
  // The BLOCK order locks the pre-Thought position of the opening notice.
  assert.deepEqual(
    collapsedBlockOrder(messages),
    ['Background job', '<Thought>'],
    'an opening notice renders before the Thought',
  )
})

test('F3b. a notice inside the opening foundation burst stays visible before the Thought', () => {
  const ambientRow = ambient('AGENTS.md')
  const noticeRow = notice('Background job', 'woke the agent', 'tool-jobs')
  const thinkingRow = thinking('process')
  const messages = [ambientRow, noticeRow, thinkingRow]
  const rows = collapsed(messages)
  assert.ok(rows.includes(ambientRow) && rows.includes(noticeRow), 'opening foundation rows survive')
  assert.deepEqual(
    collapsedBlockOrder(messages),
    ['AGENTS.md', 'Background job', '<Thought>'],
    'the whole opening foundation burst precedes the Thought',
  )
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
  // The BLOCK order: user before the Thought, notice after it.
  assert.deepEqual(
    collapsedBlockOrder(messages),
    ['user', '<Thought>', 'Background job'],
    'the between-regions notice renders after the Thought',
  )

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

// --- F7c: mid-turn Notice across the committed-answer fence -------------------

test('F7c. a mid-turn notice before a committed answer keeps Thought -> Notice -> Answer -> Steer (fence preserved)', () => {
  // The exact high-risk combination this PR touched: User -> Process ->
  // mid-turn Notice -> Assistant A committed-before-steer -> Steer. The
  // collapsed emit must keep the committed-answer fence: the answer and the
  // steer stay in raw chronology AFTER the Thought and the post-Thought
  // notice, never duplicated, swallowed, or reordered across the fence.
  const folder = new TranscriptFolder()
  const initial = { id: MessageId('u1'), role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }], source: { kind: 'user' } }
  const steerMsg = { id: MessageId('u2'), role: 'user' as const, content: [{ type: 'text' as const, text: 'human steer' }], source: { kind: 'user' } }
  const noticeSource = { kind: 'tool-jobs', form: 'notice', summary: 'FENCE_NOTICE_SUMMARY', senderSessionId: 'job-1' }
  const eventAtSeq = (type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent =>
    ({ type, seq, time, data } as SessionEvent)
  folder.apply([
    eventAtSeq('turn/start', { turn: 1 }, 1000, 0),
    eventAtSeq('user/message', initial, 1001, 1),
    eventAtSeq('tool/call', { turn: 1, step: 0, callId: 'c1', name: 'read', arguments: '{}' }, 1002, 2),
    // The mid-turn notice lands BEFORE the committed answer.
    eventAtSeq('user/message', { id: MessageId('notice-1'), role: 'user', content: [{ type: 'text', text: 'notice payload' }], source: noticeSource }, 1003, 3),
    eventAtSeq('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'committed answer A' } }, 1004, 4),
    eventAtSeq('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [steerMsg] }, 1005, 5),
    eventAtSeq('assistant/message', {
      turn: 1, step: 0,
      stream: [{ type: 'text-chunks', time0: 1004, index: 0, dt: [], texts: ['committed answer A'] }],
      message: { id: MessageId('a1'), role: 'assistant', content: [{ type: 'text', text: 'committed answer A' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 1006, 6),
    eventAtSeq('step/end', { turn: 1, step: 0 }, 1007, 7),
    eventAtSeq('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 1008, 8),
    eventAtSeq('step/start', { turn: 1, step: 1 }, 1009, 9),
    eventAtSeq('user/message', steerMsg, 1010, 10),
    eventAtSeq('llm/retry', { turn: 1, step: 1, retry: 1, delayMs: 2_000, failure: { code: 'X', message: 'x' } }, 1011, 11),
  ])
  const messages = folder.messages()
  const noticeRow = messages.find(message => message.kind === 'system' && message.contextPresentation?.form === 'notice')
  assert.ok(noticeRow !== undefined, 'fixture: the mid-turn notice folds')
  const answerRow = messages.find(message => message.kind === 'assistant')
  assert.ok(answerRow !== undefined, 'fixture: the committed answer folds')
  const steerRow = messages.find(message => message.kind === 'user' && message.steer === true)
  assert.ok(steerRow !== undefined, 'fixture: the post-fence steer folds')

  // Collapsed: User -> Thought -> Notice -> committed Answer -> Steer, each
  // exactly once. The notice stays post-Thought; the answer and the steer
  // keep their post-fence chronology and never cross back over the Thought.
  const order = collapsedBlockOrder(messages, folder.turnActivity(1) ?? liveActivity())
  assert.deepEqual(
    order,
    ['user', '<Thought>', 'tool-jobs', 'assistant', 'user'],
    'Thought -> Notice -> committed Answer -> Steer, fence preserved',
  )
  assert.equal(order.filter(entry => entry === 'tool-jobs').length, 1, 'the notice is never duplicated')
  assert.equal(order.filter(entry => entry === 'assistant').length, 1, 'the answer is never duplicated')

  // Expanded: the exact raw chronology returns.
  const expandedRows = expanded(messages)
  assert.ok(expandedRows.indexOf(answerRow) > expandedRows.indexOf(noticeRow),
    'expanded keeps Notice before the committed answer (raw order)')
  assert.ok(expandedRows.indexOf(steerRow) > expandedRows.indexOf(answerRow),
    'expanded keeps the steer after the answer (raw order)')
})

// --- F8: turn-less split keeps the consecutive-run grouping ------------------
test('F8. a turn split by a turn-less row keeps the consecutive-run grouping (a notice starting its own run is opening foundation)', () => {
  // A turn-less entry SPLITS turn 1 into two runs. The notice starts the second
  // run, so its own lead boundary is the run start and the projection renders
  // it as that run's opening foundation — BEFORE that run's Thought.
  const noticeRow = notice('Background job', 'after the split', 'tool-jobs')
  const messages = [user('opening'), thinking('before'), summary('… older'), noticeRow, thinking('after')]
  assert.ok(collapsed(messages).includes(noticeRow), 'the projection renders the notice in its own run')
  assert.deepEqual(
    collapsedBlockOrder(messages),
    ['user', '<Thought>', 'summary', 'Background job', '<Thought>'],
    'the split-run notice opens its own run BEFORE that run\'s Thought (the turn-less summary stays standalone)',
  )
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

test('F10. a Full notice keeps the raw chronology (no disposition applies)', async () => {
  const { vt, app } = startApp('full')
  const { folder, noticeRow } = busyTurnWithNoticeFixture()
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('NOTICE_SUMMARY'), `Full keeps the notice visible:\n${view}`)
  // Full is the identity projection: the folder folds to
  // user -> read -> notice -> read, and the notice's rendered position sits
  // between its raw tool neighbors (after the first read card, before the
  // second one) — never hoisted or reordered.
  const raw = folder.messages()
  assert.deepEqual(
    raw.map(message => message.kind),
    ['user', 'tool', 'system', 'tool'],
    'fixture: the notice sits between two tool rows',
  )
  const firstReadAt = view.indexOf('Read')
  const noticeAt = view.indexOf('NOTICE_SUMMARY')
  const lastReadAt = view.lastIndexOf('Read')
  assert.ok(firstReadAt >= 0 && noticeAt > firstReadAt && lastReadAt > noticeAt,
    `the notice renders between its raw neighbors in Full:\n${view}`)
})
