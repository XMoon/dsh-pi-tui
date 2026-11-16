/**
 * The plan-review QuestionFlow branch (FR7): an OFFICIAL plan-review question
 * (exact intent shape) renders the compact decision component — View plan,
 * Keep planning…, Approve — instead of the generic Q1→Review→Submit pages;
 * the default cursor is NEVER Approve; the answer encoding uses the official
 * labels; and every other question shape keeps the generic flow untouched.
 * @module @xmoon76/dsh-pi-tui/plan-review-flow.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import {
  planReviewOf,
  QuestionFlow,
  type QuestionFlowQuestion,
} from '../../src/tui/interaction/question.ts'

const PLAN_MD = '# Upgrade 0.5.7\n## Scope\n- goal dock\n- plan review\n## Execution\nship it'

function planQuestion(overrides: Partial<QuestionFlowQuestion> = {}): QuestionFlowQuestion {
  return {
    id: 'plan-review',
    question: 'Approve this plan and leave plan mode?',
    header: 'Plan review',
    detail: PLAN_MD,
    options: [
      { label: 'Approve', description: 'Leave plan mode.' },
      { label: 'Keep planning', description: 'Stay in plan mode.' },
    ],
    intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan-1' },
    ...overrides,
  }
}

function makeFlow(
  questions: readonly QuestionFlowQuestion[],
  handlers: { onDone?: (answers: unknown[]) => void; onCancel?: () => void } = {},
): QuestionFlow {
  return new QuestionFlow(
    questions,
    (answers) => handlers.onDone?.(answers),
    () => handlers.onCancel?.(),
  )
}

function render(flow: QuestionFlow, width = 80): string[] {
  return flow.render(width).map(line => stripTerminalSequences(line))
}

test('planReviewOf accepts exactly the official shape and rejects lookalikes', () => {
  assert.ok(planReviewOf([planQuestion()]) !== undefined, 'the official shape is a plan review')
  // Two questions in one ask: not a plan decision.
  assert.equal(planReviewOf([planQuestion(), planQuestion()]), undefined)
  // A forged intent without a matching approve option.
  assert.equal(planReviewOf([planQuestion({ intent: { kind: 'plan-review', approve: 'Nope' } })]), undefined)
  // approve present but no other option (no keep-planning class).
  assert.equal(planReviewOf([planQuestion({
    options: [{ label: 'Approve' }],
    intent: { kind: 'plan-review', approve: 'Approve' },
  })]), undefined)
  // A different intent kind.
  assert.equal(planReviewOf([planQuestion({ intent: { kind: 'approval', approve: 'Approve' } })]), undefined)
  // No intent at all.
  assert.equal(planReviewOf([planQuestion({ intent: undefined })]), undefined)
})

test('the plan decision component defaults to View (with inspection) and never to Approve', () => {
  const flow = makeFlow([planQuestion()])
  flow.setMaxRows(24)
  assert.ok(flow.setPlanInspection(() => true), 'the plan flow accepts the inspection capability')
  const lines = render(flow)
  const joined = lines.join('\n')
  assert.ok(joined.includes('Plan review · Upgrade 0.5.7'), `title row missing:\n${joined}`)
  const viewRow = lines.findIndex(line => line.includes('View plan'))
  const keepRow = lines.findIndex(line => line.includes('Keep planning…'))
  const approveRow = lines.findIndex(line => line.includes('Approve plan'))
  assert.ok(viewRow >= 0, `View plan row missing:\n${joined}`)
  assert.ok(keepRow >= 0, `Keep planning row missing:\n${joined}`)
  assert.ok(approveRow >= 0, `Approve row missing:\n${joined}`)
  assert.ok(viewRow < keepRow && keepRow < approveRow, `fixed row order View→Keep→Approve:\n${joined}`)
  // The cursor '>' marks View plan (index 0), never Approve.
  assert.ok(lines[viewRow]!.trimStart().startsWith('>'), `View plan must hold the cursor:\n${joined}`)
  assert.ok(!lines[approveRow]!.trimStart().startsWith('>'), `Approve must not hold the default cursor:\n${joined}`)
  // No generic question machinery renders.
  assert.ok(!joined.includes('Review'), `no generic Review tab:\n${joined}`)
  assert.ok(!joined.includes('Type something.'), `no generic free-text row:\n${joined}`)
})

test('without the inspection capability the decision list keeps Keep first (Regular shape)', () => {
  const flow = makeFlow([planQuestion()])
  flow.setMaxRows(24)
  flow.setPlanInspection(undefined)
  const lines = render(flow)
  const joined = lines.join('\n')
  assert.ok(!joined.includes('View plan'), `Regular must not offer an unusable View plan:\n${joined}`)
  const keepRow = lines.findIndex(line => line.includes('Keep planning…'))
  assert.ok(keepRow >= 0 && lines[keepRow]!.trimStart().startsWith('>'), `Keep planning holds the default cursor:\n${joined}`)
})

test('Enter on Approve answers the OFFICIAL approve label through the flow settle', () => {
  const settled: unknown[] = []
  const flow = makeFlow([planQuestion()], { onDone: answers => settled.push(answers) })
  flow.setMaxRows(24)
  flow.setPlanInspection(() => true)
  // ↓↓ moves to Approve (View=0, Keep=1, Approve=2).
  flow.handleInput('\x1b[B')
  flow.handleInput('\x1b[B')
  flow.handleInput('\r')
  assert.deepEqual(settled, [[{ id: 'plan-review', selected: ['Approve'] }]],
    `the official approve label is the answer:\n${JSON.stringify(settled)}`)
})

test('Enter on View runs the host inspection once and enters reading; Esc returns to the decision', () => {
  const inspections: number[] = []
  const flow = makeFlow([planQuestion()])
  flow.setMaxRows(24)
  flow.setPlanInspection(() => { inspections.push(1); return true })
  flow.handleInput('\r') // Enter on View (default cursor)
  assert.equal(inspections.length, 1, 'the host inspection runs exactly once')
  let lines = render(flow)
  assert.ok(lines.join('\n').includes('Reading the submitted plan'), `reading step must render:\n${lines.join('\n')}`)
  // Enter in reading is INERT (never an approve).
  const settled: unknown[] = []
  ;(flow as unknown as { onDone: (answers: unknown[]) => void }).onDone = answers => settled.push(answers)
  flow.handleInput('\r')
  assert.deepEqual(settled, [], 'Enter in reading must never settle')
  // Esc returns to the decision list.
  flow.handleInput('\x1b')
  lines = render(flow)
  assert.ok(lines.join('\n').includes('View plan'), `Esc returns to the decision list:\n${lines.join('\n')}`)
})

test('a failed inspection degrades to the question-detail fallback, never a claimed reading state', () => {
  const flow = makeFlow([planQuestion()])
  flow.setMaxRows(24)
  flow.setPlanInspection(() => false)
  flow.handleInput('\r') // Enter on View
  const lines = render(flow)
  const joined = lines.join('\n')
  assert.ok(joined.includes('Full review text'), `the fallback names its source:\n${joined}`)
  assert.ok(!joined.includes('Reading the submitted plan'), `no claimed-located reading:\n${joined}`)
  // The fallback shows the plan body's tail via paging (the whole text stays
  // reachable; a fixed cap would drop it silently).
  assert.ok(joined.includes('# Upgrade 0.5.7'), `the fallback body starts with the plan:\n${joined}`)
})

test('Keep planning… opens the feedback input; Enter sends the official label with optional custom', () => {
  const settled: unknown[] = []
  const flow = makeFlow([planQuestion()], { onDone: answers => settled.push(answers) })
  flow.setMaxRows(24)
  flow.setPlanInspection(() => true)
  flow.handleInput('\x1b[B') // ↓ to Keep planning…
  flow.handleInput('\r')
  let lines = render(flow)
  assert.ok(lines.join('\n').includes('What should be changed?'), `feedback step renders:\n${lines.join('\n')}`)
  // Esc keeps the draft and returns to the decision list.
  flow.handleInput('p')
  flow.handleInput('l')
  flow.handleInput('e')
  flow.handleInput('a')
  flow.handleInput('s')
  flow.handleInput('e')
  flow.handleInput('\x1b')
  lines = render(flow)
  assert.ok(lines.join('\n').includes('View plan'), `Esc returns to the decision list:\n${lines.join('\n')}`)
  // Re-enter: the cursor stays on Keep planning… and the draft survives.
  flow.handleInput('\r')
  flow.handleInput('\r') // Enter submits the feedback with the kept draft.
  assert.deepEqual(settled, [[{ id: 'plan-review', selected: ['Keep planning'], custom: 'please' }]],
    `the keep label survives with the custom text:\n${JSON.stringify(settled)}`)
})

test('an empty feedback answers the keep label alone (no custom field)', () => {
  const settled: unknown[] = []
  const flow = makeFlow([planQuestion()], { onDone: answers => settled.push(answers) })
  flow.setMaxRows(24)
  flow.setPlanInspection(() => true)
  flow.handleInput('\x1b[B') // Keep planning…
  flow.handleInput('\r') // enter feedback
  flow.handleInput('\r') // submit empty
  assert.deepEqual(settled, [[{ id: 'plan-review', selected: ['Keep planning'] }]],
    `empty feedback keeps only the label:\n${JSON.stringify(settled)}`)
})

test('Esc on the decision list is the OFFICIAL dismiss (onCancel)', () => {
  let cancelled = 0
  const flow = makeFlow([planQuestion()], { onCancel: () => { cancelled += 1 } })
  flow.setMaxRows(24)
  flow.setPlanInspection(() => true)
  flow.handleInput('\x1b')
  assert.equal(cancelled, 1, 'Esc on the decision list cancels the flow')
})

test('Ctrl+C is the official cancel in every plan step (no orphaned reading state)', () => {
  // Decision.
  let cancelled = 0
  const decision = makeFlow([planQuestion()], { onCancel: () => { cancelled += 1 } })
  decision.setMaxRows(24)
  decision.setPlanInspection(() => true)
  decision.handleInput('\x03')
  assert.equal(cancelled, 1, 'Ctrl+C cancels from the decision list')
  // Reading: the host reading lease is released and the flow cancels.
  let readingEnded = 0
  let readingCancelled = 0
  const reading = makeFlow([planQuestion()], { onCancel: () => { readingCancelled += 1 } })
  reading.setMaxRows(24)
  reading.setPlanInspection(() => true)
  reading.onPlanReadingEnd = () => { readingEnded += 1 }
  reading.handleInput('\r')
  assert.ok(reading.isPlanReading())
  reading.handleInput('\x03')
  assert.equal(readingCancelled, 1, 'Ctrl+C cancels while reading')
  assert.equal(readingEnded, 1, 'Ctrl+C releases the reading lease')
  // Feedback: Ctrl+C cancels instead of the Input consuming it.
  let feedbackCancelled = 0
  const feedback = makeFlow([planQuestion()], { onCancel: () => { feedbackCancelled += 1 } })
  feedback.setMaxRows(24)
  feedback.setPlanInspection(() => true)
  feedback.handleInput('\x1b[B')
  feedback.handleInput('\r')
  feedback.handleInput('\x03')
  assert.equal(feedbackCancelled, 1, 'Ctrl+C cancels while editing feedback')
})

test('a non-plan question keeps the generic flow pages untouched', () => {
  const flow = makeFlow([planQuestion({
    intent: undefined,
    options: [{ label: 'A' }, { label: 'B' }],
  })])
  flow.setMaxRows(24)
  const lines = render(flow)
  const joined = lines.join('\n')
  assert.ok(joined.includes('Approve this plan'), `the question text renders:\n${joined}`)
  assert.ok(joined.includes('Review'), `the generic Review tab renders:\n${joined}`)
  assert.ok(!joined.includes('Plan review · '), `no plan decision component:\n${joined}`)
})

function stripLines(flow: QuestionFlow, width = 80): string[] {
  return flow.render(width).map(line => stripTerminalSequences(line))
}

/** Click the plan decision row with `label` through the last-painted hit map. */
function clickPlanRow(flow: QuestionFlow, label: string, width = 80): void {
  const lines = stripLines(flow, width)
  const row = lines.findIndex(line => line.includes(label))
  assert.ok(row >= 0, `row '${label}' must be painted:\n${lines.join('\n')}`)
  const gesture = flow.beginMousePress(row, 0)
  assert.ok(gesture !== undefined, `press on '${label}' must capture its row`)
  flow.completeMouseClick(gesture, row, 0)
}

test('Fullscreen pointer: clicking a decision row is keyboard-Enter parity (never a stray approve)', () => {
  const settled: unknown[] = []
  const flow = makeFlow([planQuestion()], { onDone: answers => settled.push(answers) })
  flow.setMaxRows(24)
  flow.setMouseActionsEnabled(true)
  flow.setPlanInspection(() => true)
  const lines = stripLines(flow)
  const joined = lines.join('\n')
  // The action bar is the frozen hint row, not a second list of verbs.
  assert.ok(joined.includes('↑↓ select'), `selection hint missing:\n${joined}`)
  assert.ok(joined.includes('Enter choose'), `enter hint missing:\n${joined}`)
  assert.ok(joined.includes('Discuss [Esc]'), `the clickable Discuss verb missing:\n${joined}`)
  assert.ok(joined.includes('Waiting for decision'), `the decision status fact missing:\n${joined}`)
  // Clicking the Approve row settles with the official label.
  clickPlanRow(flow, 'Approve plan')
  assert.deepEqual(settled, [[{ id: 'plan-review', selected: ['Approve'] }]])
})

test('Fullscreen pointer: clicking View runs the inspection (a click is never a submit)', () => {
  const settled: unknown[] = []
  const inspections: number[] = []
  const flow = makeFlow([planQuestion()], { onDone: answers => settled.push(answers) })
  flow.setMaxRows(24)
  flow.setMouseActionsEnabled(true)
  flow.setPlanInspection(() => { inspections.push(1); return true })
  clickPlanRow(flow, 'View plan')
  assert.equal(inspections.length, 1, 'the click runs the inspection once')
  assert.deepEqual(settled, [], 'View never submits')
  assert.ok(flow.isPlanReading(), 'the click enters the reading step')
})

test('Fullscreen pointer: clicking Keep opens the feedback input, and the Send verb submits', () => {
  const settled: unknown[] = []
  const flow = makeFlow([planQuestion()], { onDone: answers => settled.push(answers) })
  flow.setMaxRows(24)
  flow.setMouseActionsEnabled(true)
  flow.setPlanInspection(() => true)
  clickPlanRow(flow, 'Keep planning…')
  let lines = stripLines(flow)
  assert.ok(lines.join('\n').includes('What should be changed?'), `feedback step missing:\n${lines.join('\n')}`)
  // The feedback Input row is a real pointer target (click places the cursor).
  const inputRow = lines.findIndex(line => line.trimStart().startsWith('>'))
  assert.ok(inputRow >= 0, `the feedback input row must paint:\n${lines.join('\n')}`)
  const inputGesture = flow.beginMousePress(inputRow, 4)
  assert.ok(inputGesture !== undefined)
  flow.completeMouseClick(inputGesture, inputRow, 4)
  // Click the Send revision span.
  const sendRow = lines.length - 1
  const sendCol = lines[sendRow]!.indexOf('Send revision')
  assert.ok(sendCol >= 0, `Send revision missing:\n${lines[sendRow]}`)
  const sendGesture = flow.beginMousePress(sendRow, sendCol)
  assert.ok(sendGesture !== undefined)
  flow.completeMouseClick(sendGesture, sendRow, sendCol)
  assert.deepEqual(settled, [[{ id: 'plan-review', selected: ['Keep planning'] }]],
    'the click submits the official keep label')
})

test('Fullscreen pointer: a stale gesture cannot act on a repainted plan step', () => {
  const settled: unknown[] = []
  const flow = makeFlow([planQuestion()], { onDone: answers => settled.push(answers) })
  flow.setMaxRows(24)
  flow.setMouseActionsEnabled(true)
  flow.setPlanInspection(() => true)
  const lines = stripLines(flow)
  const viewRow = lines.findIndex(line => line.includes('View plan'))
  assert.ok(viewRow >= 0)
  // Press on View, then change the mode (keyboard enters reading) before the
  // release: the release must be inert, never a submit and never a re-entry.
  const gesture = flow.beginMousePress(viewRow, 0)
  assert.ok(gesture !== undefined)
  flow.handleInput('\r')
  flow.completeMouseClick(gesture, viewRow, 0)
  assert.deepEqual(settled, [], 'a stale release never approves')
  assert.ok(flow.isPlanReading(), 'the keyboard action owns the transition')
})

test('Fullscreen pointer: the fallback Back returns to the decision list without an answer', () => {
  const settled: unknown[] = []
  const flow = makeFlow([planQuestion()], { onDone: answers => settled.push(answers) })
  flow.setMaxRows(24)
  flow.setMouseActionsEnabled(true)
  flow.setPlanInspection(() => false)
  flow.handleInput('\r') // View → fallback (no provable target)
  let lines = stripLines(flow)
  assert.ok(lines.join('\n').includes('Full review text'), `fallback missing:\n${lines.join('\n')}`)
  const backRow = lines.length - 1
  const backCol = lines[backRow]!.indexOf('Back')
  assert.ok(backCol >= 0, `fallback Back verb missing:\n${lines[backRow]}`)
  const gesture = flow.beginMousePress(backRow, backCol)
  assert.ok(gesture !== undefined)
  flow.completeMouseClick(gesture, backRow, backCol)
  lines = stripLines(flow)
  assert.ok(lines.join('\n').includes('View plan'), `Back returns to the decision list:\n${lines.join('\n')}`)
  assert.deepEqual(settled, [], 'Back never answers')
})

test('a plan request with several non-approve options still renders exactly three rows', () => {
  const flow = makeFlow([planQuestion({
    options: [
      { label: 'Approve' },
      { label: 'Keep planning' },
      { label: 'Ask something else' },
    ],
  })])
  flow.setMaxRows(24)
  flow.setPlanInspection(() => true)
  const lines = stripLines(flow)
  const joined = lines.join('\n')
  const decisionRows = lines.filter(line => /^(>| ) (View plan|Keep planning…|Approve plan)$/.test(line))
  assert.equal(decisionRows.length, 3, `exactly three decision rows:\n${joined}`)
  assert.ok(joined.includes('Keep planning…'), `the FIRST non-approve option is the keep class:\n${joined}`)
  assert.ok(!joined.includes('Ask something else'), `extra non-approve options never add rows:\n${joined}`)
})

test('a real feedback edit fires the answer-mutation hook and keeps the draft snapshot live', () => {
  let mutations = 0
  const drafts: unknown[] = []
  const flow = new QuestionFlow(
    [planQuestion()],
    () => {},
    () => {},
    () => { mutations += 1 },
    draft => { drafts.push(draft) },
  )
  flow.setMaxRows(24)
  flow.setPlanInspection(() => true)
  flow.handleInput('\x1b[B') // Keep planning…
  flow.handleInput('\r')
  assert.equal(mutations, 0, 'entering the feedback step is not itself an answer mutation')
  // Cursor-only keys never mutate.
  flow.handleInput('\x1b[D')
  flow.handleInput('\x1b[C')
  assert.equal(mutations, 0, 'cursor moves never mutate')
  // The first real character freezes the timed claim and snapshots the draft.
  flow.handleInput('n')
  assert.equal(mutations, 1, 'the first edited character is a real answer mutation')
  assert.equal((drafts.at(-1) as { answers: Array<{ custom: string }> }).answers[0]!.custom, 'n',
    'the draft snapshot carries the feedback text for park/reopen')
  flow.handleInput('o')
  assert.equal(mutations, 2, 'every real edit notifies')
  assert.equal((drafts.at(-1) as { answers: Array<{ custom: string }> }).answers[0]!.custom, 'no')
})

test('a stale action-bar press from another plan step is inert after a keyboard transition', () => {
  const settled: unknown[] = []
  const flow = makeFlow([planQuestion()], { onDone: answers => settled.push(answers) })
  flow.setMaxRows(24)
  flow.setMouseActionsEnabled(true)
  flow.setPlanInspection(() => true)
  // Enter feedback, then press its `Back [Esc]` span…
  flow.handleInput('\x1b[B')
  flow.handleInput('\r')
  let lines = stripLines(flow)
  const backRow = lines.length - 1
  const backCol = lines[backRow]!.indexOf('Back')
  assert.ok(backCol >= 0, `feedback Back span missing:\n${lines[backRow]}`)
  const gesture = flow.beginMousePress(backRow, backCol)
  assert.ok(gesture !== undefined)
  // …then leave feedback with the KEYBOARD (Esc) and release the old span.
  flow.handleInput('\x1b')
  flow.completeMouseClick(gesture, backRow, backCol)
  assert.ok(!flow.isPlanReading(), 'the stale release never enters reading')
  assert.deepEqual(settled, [], 'the stale release never answers')
  lines = stripLines(flow)
  assert.ok(lines.join('\n').includes('View plan'), `the flow stays on the decision list:\n${lines.join('\n')}`)
})
