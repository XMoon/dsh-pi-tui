/**
 * Pure QuestionFlow budget matrix: the flow's render output IS its height in
 * the editor-seat layout (nothing clips it), so for every supported budget
 * (8..24) and representative width, every page — question, options, skipped
 * note, review — must fit the budget and keep its REQUIRED rows: the
 * question's first text row, the highlighted option's `→` pointer, and the
 * final key hint.
 * @module @xmoon76/dsh-pi-tui/question-flow.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { QuestionFlow, type QuestionFlowQuestion } from '../src/question.ts'

const BUDGETS = [8, 12, 22, 24]
const WIDTHS = [50, 100]

function strip(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, '')
}

function makeFlow(questions: QuestionFlowQuestion[], budget: number): QuestionFlow {
  const f = new QuestionFlow(questions, () => {}, () => {})
  f.setMaxRows(budget)
  return f
}

/** Render the flow and strip ANSI escapes. */
function render(f: QuestionFlow, width: number): string[] {
  return f.render(width).map(strip)
}

/** Assert the per-page invariants and the total budget. */
function assertPage(
  lines: string[],
  budget: number,
  width: number,
  questionStart: string,
  expect: { pointer?: boolean; hint: string; skipped?: boolean; header?: string; review?: boolean },
): void {
  assert.ok(lines.length <= budget, `page overflowed budget ${budget} at width ${width} (${lines.length} rows):\n${lines.join('\n')}`)
  const joined = lines.join('\n')
  assert.ok(lines.some(l => l.includes(questionStart)), `question first row missing (${width}x${budget}):\n${joined}`)
  if (expect.pointer === true) {
    assert.ok(joined.includes('→'), `pointer missing (${width}x${budget}):\n${joined}`)
  }
  // A hint row always exists (the last row); low-priority verbs drop out at
  // narrow widths, so 'esc cancel' is strictly asserted only where it fits.
  assert.ok(lines[lines.length - 1]!.trim() !== '', `hint row missing (${width}x${budget}):\n${joined}`)
  if (width >= 100) {
    assert.ok(joined.includes(expect.hint), `hint '${expect.hint}' missing (${width}x${budget}):\n${joined}`)
  }
  if (expect.skipped === true) {
    assert.ok(joined.includes('(skipped)'), `skipped note missing (${width}x${budget}):\n${joined}`)
  }
  if (expect.header !== undefined) {
    if (expect.header === '') {
      assert.ok(!joined.includes('HEADER'), `header must drop (${width}x${budget}):\n${joined}`)
    } else {
      assert.ok(joined.includes(expect.header), `header missing (${width}x${budget}):\n${joined}`)
    }
  }
  if (expect.review === true) {
    assert.ok(joined.includes('Submit') && joined.includes('Cancel'), `review actions missing (${width}x${budget}):\n${joined}`)
  }
}

const RICH_QUESTION: QuestionFlowQuestion = {
  id: 'q1',
  header: 'HEADER',
  question: 'Which approach should we take for this very long question that wraps across many rows? '.repeat(3).trim(),
  detail: 'Detail line one with extra context.\nDetail line two with even more context that keeps going. '.repeat(4).trim(),
  options: Array.from({ length: 8 }, (_, i) => ({
    label: `Option ${i + 1} with a fairly long label that wraps`.repeat(2),
    description: `Description ${i + 1} ` + 'd'.repeat(120),
  })),
}

test('budget matrix: rich choice page keeps required rows', () => {
  for (const budget of BUDGETS) {
    for (const width of WIDTHS) {
      const f = makeFlow([RICH_QUESTION], budget)
      assertPage(render(f, width), budget, width, 'Which approach', {
        pointer: true,
        hint: 'esc cancel',
        header: 'HEADER',
      })
    }
  }
})

test('budget matrix: cursor movement beyond MAX_VISIBLE_OPTIONS keeps the pointer', () => {
  for (const budget of BUDGETS) {
    for (const width of WIDTHS) {
      const f = makeFlow([RICH_QUESTION], budget)
      for (let step = 0; step < 8; step++) {
        const lines = render(f, width)
        assertPage(lines, budget, width, 'Which approach', { pointer: true, hint: 'esc cancel' })
        f.handleInput('\x1b[B') // Down
      }
    }
  }
})

test('budget matrix: a skipped question revisited keeps the skipped note', () => {
  for (const budget of BUDGETS) {
    for (const width of WIDTHS) {
      const f = makeFlow([RICH_QUESTION, { id: 'q2', question: 'Second question', options: [{ label: 'B' }] }], budget)
      f.handleInput('s') // skip q1
      f.handleInput('\x1b[D') // back to q1 (drafts survive)
      assertPage(render(f, width), budget, width, 'Which approach', {
        pointer: true,
        hint: 'esc cancel',
        skipped: true,
      })
    }
  }
})

test('budget matrix: optionless free-text question keeps the question and hint', () => {
  for (const budget of BUDGETS) {
    for (const width of WIDTHS) {
      const f = makeFlow([{ id: 'q1', question: 'Type your answer to this long free-text question that wraps across rows. '.repeat(2).trim() }], budget)
      assertPage(render(f, width), budget, width, 'Type your answer', { hint: 'esc cancel' })
    }
  }
})

test('budget matrix: review page keeps Submit/Cancel and the hint', () => {
  for (const budget of BUDGETS) {
    for (const width of WIDTHS) {
      const f = makeFlow([
        { id: 'q1', question: RICH_QUESTION.question, options: RICH_QUESTION.options },
        { id: 'q2', question: 'Second?', options: [{ label: 'B' }] },
      ], budget)
      f.handleInput('1') // answer q1 (single-select advances)
      f.handleInput('1') // answer q2 → review page
      assertPage(render(f, width), budget, width, 'Review your answer', {
        hint: 'esc cancel',
        review: true,
      })
    }
  }
})

test('budget 8 with header and skipped state drops the header, keeps required rows', () => {
  // bodyAllowance at budget 8 with a skipped note = 8 - 2 - (4 + 1) = 1:
  // the decorative header cannot fit next to the required question row.
  for (const width of WIDTHS) {
    const f = makeFlow([RICH_QUESTION, { id: 'q2', question: 'Second?', options: [{ label: 'B' }] }], 8)
    f.handleInput('s') // skip q1
    f.handleInput('\x1b[D') // back to q1
    assertPage(render(f, width), 8, width, 'Which approach', {
      pointer: true,
      hint: 'esc cancel',
      skipped: true,
      header: '',
    })
  }
})

test('a 1-row question budget shows the question text, never a marker-only row', () => {
  // bodyAllowance 1: budget 8 + header (2 + 1 + 4 = 7, leaving 1) with a
  // long question that wraps — the first row must carry the question text.
  const f = makeFlow([{
    id: 'q1',
    header: 'HEADER',
    question: 'A very long question '.repeat(10).trim(),
    options: [{ label: 'A' }],
  }], 8)
  const lines = render(f, 50)
  assert.ok(lines.length <= 8, `overflow:\n${lines.join('\n')}`)
  assert.ok(lines.some(l => l.includes('A very long question')), `question text missing:\n${lines.join('\n')}`)
  assert.ok(!lines.some(l => l.includes('more lines')), `marker-only row must not replace the question:\n${lines.join('\n')}`)
})
