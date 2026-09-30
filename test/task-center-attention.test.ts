/**
 * Pure Question attention -> Task Center row projection tests (M3-3B addendum
 * §16.2). No TUI, no Host: the helper is deliberately testable on its own.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { projectTaskItems } from '../src/task-presentation.ts'
import {
  QUESTION_ATTENTION_GROUP,
  fullQuestionRows,
  questionAttentionLabel,
  questionIdentityOf,
  questionTaskRowValue,
  quickQuestionRows,
  type QuestionAttentionRow,
} from '../src/task-center-attention.ts'

const QUESTIONS = [
  { id: 'q1', question: 'Use staging or production?' },
  { id: 'q2', question: 'Which region?' },
]

const row = (presentation: 'visible' | 'parked', overrides: Partial<QuestionAttentionRow> = {}): QuestionAttentionRow => ({
  sessionId: 'session-a',
  callId: 'call-1',
  questions: [QUESTIONS[0]!],
  presentation,
  ...overrides,
})

test('Quick lists only PARKED questions; a visible panel is not duplicated', () => {
  const rows = [row('parked'), row('visible', { callId: 'call-2' })]
  const quick = quickQuestionRows(rows)
  assert.equal(quick.length, 1)
  assert.equal(quick[0]!.status, 'awaiting answer')
  assert.equal(quick[0]!.value, questionTaskRowValue('session-a', 'call-1'))
})

test('Full lists every actionable question with its presentation status', () => {
  const rows = [row('parked'), row('visible', { callId: 'call-2' })]
  const full = fullQuestionRows(rows)
  assert.deepEqual(full.map(item => [item.value, item.status]), [
    [questionTaskRowValue('session-a', 'call-1'), 'awaiting answer'],
    [questionTaskRowValue('session-a', 'call-2'), 'answering'],
  ])
})

test('every Question row is a non-work row: no stop semantics, no Job type', () => {
  for (const item of [...quickQuestionRows([row('parked')]), ...fullQuestionRows([row('visible')])]) {
    assert.equal(item.source, 'question')
    assert.equal(item.canStop, false)
    assert.equal(item.canOpen, true)
    assert.equal(item.group, QUESTION_ATTENTION_GROUP)
    assert.equal(item.type, undefined, 'a Question is not one of the Job/Subagent type filters')
    assert.equal(item.active, undefined, 'a Question never joins the active-work count')
    assert.equal(item.attention, undefined, 'nor the failure-attention flag')
    assert.equal(item.startedAt, undefined)
  }
})

test('the row identity is the exact session+call identity, never a label or order', () => {
  const value = questionTaskRowValue('session/a b', 'call:1')
  assert.deepEqual(questionIdentityOf(value), { sessionId: 'session/a b', callId: 'call:1' })
  assert.equal(questionIdentityOf('agent:1'), undefined)
  assert.equal(questionIdentityOf('question:'), undefined)
  assert.equal(questionIdentityOf('question:onlysession'), undefined)
  // Two different calls with the SAME label never collide.
  const a = questionTaskRowValue('session-a', 'call-1')
  const b = questionTaskRowValue('session-a', 'call-2')
  assert.notEqual(a, b)
})

test('labels are compact, single-physical-row, and never raw argument JSON', () => {
  assert.equal(questionAttentionLabel([QUESTIONS[0]!]), 'Use staging or production?')
  assert.equal(questionAttentionLabel([QUESTIONS[0]!, QUESTIONS[1]!]), '2 questions awaiting answer')
  assert.equal(questionAttentionLabel([]), 'Question awaiting answer')
  assert.equal(
    questionAttentionLabel([{ id: 'q', question: 'line one\nline two\t  spaced   out' }]),
    'line one line two spaced out',
  )
  const item = fullQuestionRows([row('parked', { questions: [{ id: 'q', header: 'Pick one', question: 'ignored' }] })])[0]!
  assert.equal(item.label, 'Pick one', 'the header is the preferred summary')
})

test('status ordering follows authority order', () => {
  const rows = [row('visible', { callId: 'a' }), row('parked', { callId: 'b' }), row('parked', { callId: 'c' })]
  assert.deepEqual(fullQuestionRows(rows).map(item => questionIdentityOf(item.value)?.callId), ['a', 'b', 'c'])
})

test('the Question row is a PRIMARY row, never a dimmed ancestor context', () => {
  // In Quick's Active scope the generic rule marks every non-active row as
  // context (`ancestorContext: true`) and the panel dims it — which for a
  // pending Question is exactly backwards.
  const rows = fullQuestionRows([row('parked')])
  const projected = projectTaskItems(rows, { scope: 'active' })
  assert.equal(projected.rows.length, 1)
  assert.equal(projected.rows[0]!.ancestorContext, false, 'a parked Question is not an ancestor context row')
  assert.equal(projected.rows[0]!.status, 'awaiting answer')

  // The same holds when a running Job is present: the Question stays primary.
  const withWork = projectTaskItems([
    ...rows,
    { value: 'job:1', label: 'bash · build', status: 'running', type: 'bash' },
  ], { scope: 'active' })
  const question = withWork.rows.find(entry => entry.value === rows[0]!.value)
  assert.ok(question !== undefined, 'the Question row survives active work')
  assert.equal(question.ancestorContext, false)
})
