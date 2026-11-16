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
