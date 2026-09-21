/**
 * PR4 addendum: SETTLED surfaced-interaction tool cards (`ask_user_question`
 * and `exit_plan_mode` / Plan review) are human-decision evidence, not
 * ordinary Process work.
 *
 * Compact makes them Work boundaries (and never counts/previews them, running
 * or settled), collapsed Focus hoists them out of the Thought, expanded Focus
 * restores their raw chronology, and their OWN disclosure stays independent of
 * the Focus root. A running question / plan review is untouched (its panel owns
 * the interaction), the surfaced set is guarded to exactly those two names, and
 * every other tool stays ordinary Process.
 * @module @xmoon76/dsh-pi-tui/question-surfaced-card.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { projectCompact } from '../src/compact-projection.ts'
import { summarizeWorkSpan } from '../src/compact-work.ts'
import { projectFocus } from '../src/focus-activity.ts'
import { askAnswersLines, askAnswersSummary } from '../src/present.ts'
import { SURFACED_INTERACTION_TOOL_NAMES, isSurfacedInteractionTool, isSurfacedInteractionToolName } from '../src/transcript-semantics.ts'
import { TranscriptFolder, type TranscriptMessage } from '../src/transcript.ts'
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

const noOptions = { expandedWorkOwners: new Set<TranscriptMessage>(), expandedClusters: new Set<TranscriptMessage>(), forcedExpanded: new Set<TranscriptMessage>() }
const TURN = 1

const thinking = (text: string): TranscriptMessage => ({ kind: 'thinking', turn: TURN, text, running: false })
const user = (text: string): TranscriptMessage => ({ kind: 'user', turn: TURN, text })
const assistant = (text: string): TranscriptMessage => ({ kind: 'assistant', turn: TURN, text })
const tool = (name: string): TranscriptMessage => ({ kind: 'tool', turn: TURN, name, args: '{}', result: 'ok', status: 'ok' })

function answersJson(answered: number, total: number): string {
  return JSON.stringify({
    answers: Array.from({ length: total }, (_, index) => ({
      id: `q${index}`,
      selected: index < answered ? ['B'] : [],
      custom: '',
    })),
  })
}

function question(status: 'ok' | 'error' | 'running', result: string): Extract<TranscriptMessage, { kind: 'tool' }> {
  return {
    kind: 'tool', turn: TURN, name: 'ask_user_question',
    args: JSON.stringify({ questions: [{ id: 'q0', question: 'Use A or B?' }] }),
    result, status,
  }
}

function kindsOf(blocks: readonly { kind: string }[]): string[] {
  return blocks.map(block => block.kind)
}

function planReview(status: 'ok' | 'error' | 'running', result: string): Extract<TranscriptMessage, { kind: 'tool' }> {
  return {
    kind: 'tool', turn: TURN, name: 'exit_plan_mode',
    args: JSON.stringify({ plan: '# The Plan\nStep one.' }),
    result, status,
  }
}

// --- Q1: Compact Work boundary ---------------------------------------------

test('Q1 Compact: a settled question ends the Work run and renders standalone between two spans', () => {
  const questionRow = question('ok', answersJson(1, 1))
  const messages = [thinking('a'), tool('read'), questionRow, thinking('b'), tool('bash')]
  const blocks = projectCompact(messages, noOptions)
  assert.deepEqual(kindsOf(blocks), ['work', 'message', 'work'], 'Work A | Question | Work B')
  const middle = blocks[1]
  assert.ok(middle?.kind === 'message' && middle.message === questionRow, 'the question is standalone, not a member')

  const workBlocks = blocks.filter(block => block.kind === 'work')
  assert.equal(workBlocks.length, 2, 'two Work spans flank the question')
  for (const block of workBlocks) {
    assert.equal(block.kind === 'work' ? summarizeWorkSpan(block.span).toolCount : -1, 1)
  }
  const allMembers = blocks.flatMap(block => block.kind === 'work' ? [...block.span.members] : [])
  assert.ok(!allMembers.includes(questionRow), 'the question never joins a Work span')
})

test('Q5 Compact: the question is neither counted nor chosen as the span tool preview', () => {
  const questionRow = question('ok', answersJson(1, 1))
  // Question is the LAST tool before the boundary: a span before it must keep
  // its own latest meaningful tool, and the question must not be counted.
  const messages = [tool('read'), questionRow]
  const blocks = projectCompact(messages, noOptions)
  const span = blocks[0]
  assert.ok(span?.kind === 'work')
  const summary = summarizeWorkSpan(span.span)
  assert.equal(summary.toolCount, 1, 'only the read tool counts')
  assert.equal(summary.tool?.name, 'read', 'the question never becomes the Tool preview')
})

// --- Q9: a RUNNING question stays process (QuestionFlow owns it) -----------

test('Q9 a running question is not surfaced as a settled card', () => {
  const running = question('running', '')
  assert.equal(isSurfacedInteractionTool(running), false)
  const messages = [thinking('a'), tool('read'), running, tool('bash')]
  // Compact keeps it inside the Work run (no boundary).
  assert.deepEqual(kindsOf(projectCompact(messages, noOptions)), ['work'])
  // Collapsed Focus keeps it inside the Thought (no hoist).
  const collapsed = projectFocus(messages, new Map(), new Set(), true)
  assert.deepEqual(kindsOf(collapsed), [], 'no persistent row is hoisted for a running question')
  // Once settled, the same shape surfaces.
  assert.equal(isSurfacedInteractionTool(question('ok', answersJson(1, 1))), true)
})

// --- Q7/Q8: partial, skipped, error and cancellation stay surfaced ---------

test('Q7/Q8 a partial/skipped or errored question is still surfaced', () => {
  const partial = question('ok', answersJson(1, 3))
  assert.equal(askAnswersSummary(partial.result), '1/3 answered')
  const partialBlocks = projectCompact([tool('read'), partial, tool('bash')], noOptions)
  assert.deepEqual(kindsOf(partialBlocks), ['work', 'message', 'work'], 'a partially answered question still splits the run')

  const errored = question('error', '')
  const errorBlocks = projectCompact([tool('read'), errored], noOptions)
  assert.deepEqual(kindsOf(errorBlocks), ['work', 'message'], 'a cancelled/errored question is durable interaction evidence')
  assert.equal(isSurfacedInteractionTool(errored), true)
})

// --- Q2/Q3: Focus collapsed hoist + expanded chronology --------------------

/** One settled-interaction turn: user, read tool, the interaction tool
 * (settled or errored), then a bash tool and a final assistant. */
function interactionTurn(options: {
  toolName: string
  toolArgs: string
  resultText: string
  errored?: boolean
}): { folder: TranscriptFolder; interactionRow: TranscriptMessage } {
  const folder = new TranscriptFolder()
  const resultContent = options.errored ? [] : [{ type: 'text', text: options.resultText }]
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: TURN } },
    { type: 'user/message', seq: 1, time: 1001, data: { id: MessageId('u1'), role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } } },
    { type: 'tool/call', seq: 2, time: 1002, data: { turn: TURN, step: 0, callId: ToolCallId('c1'), name: 'read', arguments: '{}' } },
    { type: 'tool/result', seq: 3, time: 1003, data: { turn: TURN, step: 0, message: { id: MessageId('r1'), role: 'user', content: [{ type: 'tool-result', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: 'ok' }] }], source: { kind: 'tool', callId: ToolCallId('c1') } } } },
    { type: 'tool/call', seq: 4, time: 1004, data: { turn: TURN, step: 0, callId: ToolCallId('q1'), name: options.toolName, arguments: options.toolArgs } },
    {
      type: 'tool/result', seq: 5, time: 1005,
      data: {
        turn: TURN, step: 0,
        ...(options.errored ? { error: { name: 'UserQuestionError', code: 'ASK_CANCELLED' } } : {}),
        message: { id: MessageId('qr1'), role: 'user', content: [{ type: 'tool-result', toolCallId: ToolCallId('q1'), content: resultContent }], source: { kind: 'tool', callId: ToolCallId('q1') } },
      },
    },
    { type: 'tool/call', seq: 6, time: 1006, data: { turn: TURN, step: 1, callId: ToolCallId('c2'), name: 'bash', arguments: '{}' } },
    { type: 'assistant/message', seq: 7, time: 1007, data: { turn: TURN, step: 2, message: { id: MessageId('a1'), role: 'assistant', content: [{ type: 'text', text: 'final' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
    { type: 'turn/end', seq: 8, time: 9000, data: { turn: TURN, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
  folder.apply(events)
  const interactionRow = folder.messages().find(message => message.kind === 'tool' && message.name === options.toolName)
  assert.ok(interactionRow !== undefined, `fixture: the settled ${options.toolName} folds`)
  return { folder, interactionRow }
}

function questionTurn(): { folder: TranscriptFolder; questionRow: TranscriptMessage } {
  const { folder, interactionRow } = interactionTurn({
    toolName: 'ask_user_question',
    toolArgs: JSON.stringify({ questions: [{ id: 'q0', question: 'Use A or B?' }] }),
    resultText: answersJson(1, 1),
  })
  return { folder, questionRow: interactionRow }
}

function planReviewTurn(): { folder: TranscriptFolder; planReviewRow: TranscriptMessage } {
  const { folder, interactionRow } = interactionTurn({
    toolName: 'exit_plan_mode',
    toolArgs: JSON.stringify({ plan: '# The Plan\nStep one.' }),
    resultText: 'Plan approved — plan mode exited.',
  })
  return { folder, planReviewRow: interactionRow }
}

test('Q2 Focus collapsed hoists the settled question outside the Thought', () => {
  const { folder, questionRow } = questionTurn()
  const blocks = projectFocus(folder.messages(), folder.turnActivities(), new Set(), true)
  const order = blocks.map(block => block.kind === 'message'
    ? (block.message === questionRow ? 'question' : block.message.kind)
    : block.kind)
  assert.deepEqual(order, ['user', 'question', 'activity', 'assistant'], 'User | Question | Working | Assistant')
})

test('Q3 Focus expanded restores the question to its exact raw chronology', () => {
  const { folder, questionRow } = questionTurn()
  const blocks = projectFocus(folder.messages(), folder.turnActivities(), new Set([TURN]), true)
  // F6 keeps Process runs inside nested Work containers; flatten them for the
  // raw chronology assertion.
  const rows = blocks.flatMap(block => block.kind === 'work'
    ? [...block.span.members]
    : block.kind === 'message' ? [block.message] : [])
  const questionIndex = rows.indexOf(questionRow)
  const readIndex = rows.findIndex(message => message.kind === 'tool' && message.name === 'read')
  const bashIndex = rows.findIndex(message => message.kind === 'tool' && message.name === 'bash')
  assert.ok(readIndex >= 0 && questionIndex > readIndex && bashIndex > questionIndex,
    'expanded keeps Process -> Question -> Process raw order')
})

test('Q5 Focus: the settled question is not counted as a turn tool', () => {
  const { folder } = questionTurn()
  const activity = folder.turnActivity(TURN)
  assert.equal(activity?.toolCalls, 2, 'only the read and bash calls count')
  assert.equal(activity?.tools.has('ask_user_question'), false, 'the question never appears in the tool-type stats')
  assert.equal(activity?.tool?.name, 'bash', 'the latest meaningful tool is bash')
})

// --- Q6: multi-question card -------------------------------------------------

test('Q6 a multi-question result summarizes N/M and expands to structured answer rows', () => {
  const result = answersJson(2, 3)
  assert.equal(askAnswersSummary(result), '2/3 answered')
  const lines = askAnswersLines(result)
  assert.deepEqual(lines?.map(line => line.text), ['● q0 → B', '● q1 → B', '○ q2 — skipped'])
})

// --- UI: Q4 independent disclosure, Q6 render, Q10 search, Q12 capability ---

function startApp(preset: 'focus' | 'compact' | 'full'): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset } })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

function show(app: TuiApp, folder: TranscriptFolder): void {
  app.setTranscript(folder.messages(), folder.turnActivities())
}

function click(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x};${y}M`)
  vt.sendInput(`\x1b[<0;${x};${y}m`)
}

function rowOf(view: readonly string[], pattern: RegExp): number {
  return view.findIndex(line => pattern.test(line))
}

test('Q4 the question card disclosure is independent of the Focus root', async () => {
  const { vt, app } = startApp('focus')
  const { folder, questionRow } = questionTurn()
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  let view = vt.getViewport()
  assert.ok(rowOf(view, /Question/) >= 0, `precondition: the settled question card renders:\n${view.join('\n')}`)

  const headerRow = rowOf(view, /Question/)
  click(vt, 5, headerRow + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view.join('\n').includes('● q0 → B'), `the question card opens its own answers:\n${view.join('\n')}`)

  // Expanding the Focus root must NOT collapse the question card's own owner.
  app.toggleFocusTurn(TURN)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('● q0 → B'),
    `expanding the Focus root leaves the question card expanded:\n${vt.getViewport().join('\n')}`)

  // Collapsing the Focus root must not expand/alter it either.
  app.toggleFocusTurn(TURN)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('● q0 → B'),
    `collapsing the Focus root leaves the question card expanded:\n${vt.getViewport().join('\n')}`)
  assert.equal(isSurfacedInteractionTool(questionRow), true)
})

test('Q6 the settled question card renders the N/M summary and structured answers, never raw JSON', async () => {
  const { vt, app } = startApp('focus')
  const { folder } = questionTurn()
  show(app, folder)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('1/1 answered'), `the collapsed card carries the settled answer summary:\n${view}`)
  assert.ok(view.includes('Question'), `the card names the question:\n${view}`)

  app.expandFocusTurn(TURN)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('{"answers"'), `no raw JSON is ever shown:\n${view}`)
})

test('Q10 search reaches a hidden answer and dismiss restores the collapsed card', async () => {
  const { vt, app } = startApp('focus')
  const { folder, questionRow } = questionTurn()
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(!view.includes('● q0 → B'), `precondition: the answers are collapsed:\n${view}`)

  app.setTranscriptSearchTarget({
    query: 'q0',
    match: { id: 0, turn: TURN, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: questionRow,
  })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('● q0 → B'), `the search reveal opens the hidden answer:\n${view}`)

  app.finishTranscriptSearchPresentation(new Set())
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('● q0 → B'), `dismiss restores the collapsed card:\n${view}`)
  assert.ok(view.includes('1/1 answered'), `the settled summary remains visible:\n${view}`)
})

test('Q12 regular Compact folds the settled question card under the shared owner', async () => {
  const { vt, app } = startApp('compact')
  const { folder } = questionTurn()
  show(app, folder)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Question'), `the question card renders on regular Compact:\n${view}`)
  // After F6 regular Compact has an operable fold owner (the shared Ctrl+O
  // master), so the settled card folds instead of a dead hidden state.
  assert.ok(!view.includes('● q0 → B'), `regular Compact folds the settled card:\n${view}`)
  vt.sendInput('\x0f')
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('● q0 → B'), 'the master opens the card')
  vt.sendInput('\x0f')
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('● q0 → B'), 'the master collapses it again')

  app.setFullscreen(true)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('● q0 → B'), `fullscreen collapses the card behind its own click owner:\n${view}`)
  const headerRow = rowOf(vt.getViewport(), /Question/)
  click(vt, 5, headerRow + 1)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('● q0 → B'), 'the fullscreen click opens the card')
})

// --- R1#4a: reverse independence (collapsed card stays collapsed) -----------

test('a COLLAPSED surfaced-interaction card is never auto-expanded by a Focus root toggle', async () => {
  const { vt, app } = startApp('focus')
  const { folder } = questionTurn()
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('● q0 → B'), 'precondition: the card is collapsed')

  app.toggleFocusTurn(TURN)
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('● q0 → B'),
    `expanding the Focus root must not auto-expand the card:\n${vt.getViewport().join('\n')}`)

  app.toggleFocusTurn(TURN)
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('● q0 → B'),
    `collapsing the Focus root must not auto-expand the card either:\n${vt.getViewport().join('\n')}`)
})

// --- R1#4b: a real folded cancellation is surfaced --------------------------

test('a REAL folded cancellation (errored tool/result) is surfaced, not swallowed by Work', () => {
  const { folder, interactionRow } = interactionTurn({
    toolName: 'ask_user_question',
    toolArgs: JSON.stringify({ questions: [{ id: 'q0', question: 'Use A or B?' }] }),
    resultText: '',
    errored: true,
  })
  assert.equal(interactionRow.kind === 'tool' ? interactionRow.status : undefined, 'error')
  assert.equal(isSurfacedInteractionTool(interactionRow), true, 'an errored question is settled interaction evidence')
  const compact = projectCompact(folder.messages(), noOptions)
  assert.ok(compact.some(block => block.kind === 'message' && block.message === interactionRow),
    'the cancelled card renders standalone in Compact, not inside a Work span')
})

// --- R1#1: running interaction tool count/preview agree across presets ------

test('a RUNNING interaction tool is a Work member but never counts or previews in either projection', () => {
  const running = question('running', '')
  // Compact: still a member of the run (its active panel owns the interaction),
  // but contributes no tool count and never owns the Tool preview.
  const blocks = projectCompact([tool('read'), running, tool('bash')], noOptions)
  const work = blocks.find(block => block.kind === 'work')
  assert.ok(work?.kind === 'work')
  const summary = summarizeWorkSpan(work.span)
  assert.equal(summary.toolCount, 2, 'read + bash only, even while the question runs')
  assert.equal(summary.tool?.name, 'bash', 'the question never becomes the Tool preview while running')

  // Focus: the same agreement at the turn level.
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: TURN } },
    { type: 'tool/call', seq: 1, time: 1001, data: { turn: TURN, step: 0, callId: ToolCallId('c1'), name: 'read', arguments: '{}' } },
    { type: 'tool/result', seq: 2, time: 1002, data: { turn: TURN, step: 0, message: { id: MessageId('r1'), role: 'user', content: [{ type: 'tool-result', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: 'ok' }] }], source: { kind: 'tool', callId: ToolCallId('c1') } } } },
    { type: 'tool/call', seq: 3, time: 1003, data: { turn: TURN, step: 0, callId: ToolCallId('q1'), name: 'ask_user_question', arguments: '{}' } },
  ] as SessionEvent[])
  const activity = folder.turnActivity(TURN)
  assert.equal(activity?.toolCalls, 1, 'only the read call counts while the question runs')
  assert.equal(activity?.tools.has('ask_user_question'), false)
  assert.equal(activity?.tool?.name, 'read', 'the running question never owns the latest-meaningful Tool')
})

// --- Surfaced set is exactly the two known tools ---------------------------

test('the surfaced-interaction set is exactly ask_user_question + exit_plan_mode', () => {
  assert.deepEqual([...SURFACED_INTERACTION_TOOL_NAMES].sort(), ['ask_user_question', 'exit_plan_mode'])
  for (const name of ['todo_write', 'create_goal', 'update_goal', 'get_goal', 'send_message', 'interrupt_agent', 'bash', 'edit', 'write', 'read', 'run_code', 'workflow', 'schedule']) {
    assert.equal(isSurfacedInteractionToolName(name), false, `${name} must stay ordinary Process`)
  }
})

// --- E1–E4: exit_plan_mode / Plan review ------------------------------------

test('E1/E2 exit_plan_mode is a Compact Work boundary and hoists out of collapsed Focus', () => {
  const { folder, planReviewRow } = planReviewTurn()
  const compact = projectCompact(folder.messages(), noOptions)
  const compactBlock = compact.find(block => block.kind === 'message' && block.message === planReviewRow)
  assert.ok(compactBlock !== undefined, 'the Plan review card renders standalone in Compact (Work boundary)')
  const compactWork = compact.filter(block => block.kind === 'work')
  assert.equal(compactWork.length, 2, 'Work A | Plan review | Work B')

  const collapsed = projectFocus(folder.messages(), folder.turnActivities(), new Set(), true)
  const order = collapsed.map(block => block.kind === 'message'
    ? (block.message === planReviewRow ? 'plan-review' : block.message.kind)
    : block.kind)
  assert.deepEqual(order, ['user', 'plan-review', 'activity', 'assistant'], 'User | Plan review | Working | Assistant')

  const expanded = projectFocus(folder.messages(), folder.turnActivities(), new Set([TURN]), true)
  const rows = expanded.flatMap(block => block.kind === 'work'
    ? [...block.span.members]
    : block.kind === 'message' ? [block.message] : [])
  const reviewIndex = rows.indexOf(planReviewRow)
  const readIndex = rows.findIndex(message => message.kind === 'tool' && message.name === 'read')
  const bashIndex = rows.findIndex(message => message.kind === 'tool' && message.name === 'bash')
  assert.ok(readIndex >= 0 && reviewIndex > readIndex && bashIndex > reviewIndex, 'expanded restores raw chronology')
})

test('E3 a RUNNING exit_plan_mode stays inside Work/Working (plan approval owns it)', () => {
  const running = planReview('running', '')
  assert.equal(isSurfacedInteractionTool(running), false)
  assert.deepEqual(kindsOf(projectCompact([thinking('a'), tool('read'), running, tool('bash')], noOptions)), ['work'])
  assert.deepEqual(kindsOf(projectFocus([thinking('a'), tool('read'), running, tool('bash')], new Map(), new Set(), true)), [])
})

test('E4 exit_plan_mode never counts or previews, and its plan body stays expandable', () => {
  const { folder, planReviewRow } = planReviewTurn()
  const activity = folder.turnActivity(TURN)
  assert.equal(activity?.toolCalls, 2, 'only the read and bash calls count')
  assert.equal(activity?.tools.has('exit_plan_mode'), false)
  assert.equal(activity?.tool?.name, 'bash')
  const compact = projectCompact(folder.messages(), noOptions)
  const span = compact.find(block => block.kind === 'work')
  assert.ok(span?.kind === 'work')
  assert.equal(summarizeWorkSpan(span.span).toolCount, 1, 'the Plan review never joins a span count')
  assert.equal(planReviewRow.kind === 'tool' ? planReviewRow.name : undefined, 'exit_plan_mode')
})

// --- R3: regular Focus has no independent card owner -> fail open --------

function interactionFolder(toolName: 'ask_user_question' | 'exit_plan_mode'): {
  folder: TranscriptFolder
  interactionRow: TranscriptMessage
} {
  if (toolName === 'ask_user_question') {
    const { folder, questionRow } = questionTurn()
    return { folder, interactionRow: questionRow }
  }
  const { folder, planReviewRow } = planReviewTurn()
  return { folder, interactionRow: planReviewRow }
}

for (const toolName of ['ask_user_question', 'exit_plan_mode'] as const) {
  test(`R3 regular Focus: a settled ${toolName} card fails open and never follows the Focus root`, async () => {
    const { vt, app } = startApp('focus')
    const { folder } = toolName === 'ask_user_question' ? questionTurn() : planReviewTurn()
    show(app, folder)
    await vt.waitForRender()
    const cardFull = (): boolean => {
      const view = vt.getViewport().join('\n')
      return toolName === 'ask_user_question' ? view.includes('● q0 → B') : view.includes('Plan approved')
    }
    assert.ok(cardFull(), `regular Focus fails open (card full, no coupled fold):\n${vt.getViewport().join('\n')}`)
    assert.ok(!vt.getViewport().join('\n').includes('ctrl+o to expand'),
      `no Ctrl+O affordance is advertised for the fail-open card:\n${vt.getViewport().join('\n')}`)

    // Expanding/collapsing the root must never change the card's own state.
    app.expandFocusTurn(TURN)
    await vt.waitForRender()
    assert.ok(cardFull(), `expanding the root leaves the card full:\n${vt.getViewport().join('\n')}`)

    app.toggleFocusTurn(TURN)
    await vt.waitForRender()
    assert.ok(cardFull(), `collapsing the root leaves the card full:\n${vt.getViewport().join('\n')}`)

    // Ctrl+O drives ONLY the Thought root; the card stays full throughout.
    vt.sendInput('\x0f')
    await vt.waitForRender()
    const expandedView = vt.getViewport().join('\n')
    assert.ok(expandedView.includes('🐳'), `Ctrl+O expands the Thought root:\n${expandedView}`)
    assert.ok(cardFull(), `the card stays full while the root is open:\n${expandedView}`)

    vt.sendInput('\x0f')
    await vt.waitForRender()
    const collapsedView = vt.getViewport().join('\n')
    assert.ok(collapsedView.includes('🐋'), `Ctrl+O collapses the Thought root:\n${collapsedView}`)
    assert.ok(cardFull(), `the card stays full after the root collapses:\n${collapsedView}`)
  })
}

// --- R2#1: Collapse All still closes the root under an interaction reveal ---
test('R2#1 Ctrl+O Collapse All closes the root even while a settled interaction search reveal is active', async () => {
  const { vt, app } = startApp('focus')
  const { folder, questionRow } = questionTurn()
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('🐳'), 'precondition: the root is collapsed')

  app.setTranscriptSearchTarget({
    query: 'q0',
    match: { id: 0, turn: TURN, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: questionRow,
  })
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('🐳'),
    `the reveal opens the owning root:\n${vt.getViewport().join('\n')}`)

  // The reveal is a TEMPORARY grant: the bulk Collapse All must revoke it and
  // actually collapse the root (the card's own disclosure survives separately).
  vt.sendInput('\x0f')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('🐋'), `Collapse All must collapse the root:\n${view}`)
  assert.ok(!view.includes('🐳'), `no expanded root may survive the bulk collapse:\n${view}`)
  assert.ok(view.includes('Question'), `the settled card stays surfaced:\n${view}`)
})

// --- R4: searching a fail-open interaction must not open/promote the root ----

for (const toolName of ['ask_user_question', 'exit_plan_mode'] as const) {
  test(`R4 regular Focus: searching a fail-open ${toolName} card never opens or promotes the Thought root`, async () => {
    const { vt, app } = startApp('focus')
    const { folder, interactionRow } = interactionFolder(toolName)
    show(app, folder)
    await vt.waitForRender()
    assert.ok(!vt.getViewport().join('\n').includes('🐳'), 'precondition: the Thought root is collapsed')
    assert.equal(app.focusExpandedTurnsForTest().size, 0)

    // The card's answer/body is already visible (fail-open); the search target
    // therefore needs NO deeper Focus-root reveal.
    app.setTranscriptSearchTarget({
      query: 'answer',
      match: { id: 0, turn: TURN, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
      message: interactionRow,
    })
    await vt.waitForRender()
    let view = vt.getViewport().join('\n')
    assert.ok(view.includes('🐋') && !view.includes('🐳'), `searching a visible card must not open the root:\n${view}`)
    assert.equal(app.focusExpandedTurnsForTest().size, 0, 'the reveal is temporary, never manual root state')

    // An Esc dismiss may promote the CURRENT reveal — it must NOT promote the
    // Thought root for an already-visible fail-open card.
    app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
    assert.ok(view.includes('🐋') && !view.includes('🐳'), `dismiss keeps the root collapsed:\n${view}`)
    assert.equal(app.focusExpandedTurnsForTest().size, 0, 'no Thought-root promotion for an already-visible card')
  })
}
