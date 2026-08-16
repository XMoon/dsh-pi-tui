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

/** Long detail: `n` distinct lines that fit one row at width 100 and wrap
 * to two rows at width 50 — a deterministic scrollport fixture. */
function longDetail(n: number): string {
  return Array.from({ length: n }, (_, i) => `detail-${String(i).padStart(2, '0')} ` + 'y'.repeat(70)).join('\n')
}

test('scrollport: PageDown/PageUp page the long body without moving the budget', () => {
  for (const width of WIDTHS) {
    const f = makeFlow([{ id: 'q1', question: 'Pick a side', detail: longDetail(60), options: [{ label: 'Alpha' }, { label: 'Beta' }] }], 12)
    const top = render(f, width).join('\n')
    assert.ok(render(f, width).length <= 12, `budget overflow at top (${width})`)
    assert.ok(top.includes('Pick a side'), `question missing at top (${width}):\n${top}`)
    assert.ok(top.includes('detail-00'), `first detail line missing (${width}):\n${top}`)
    assert.ok(top.includes('↓ '), `down marker missing (${width}):\n${top}`)
    assert.ok(!top.includes('↑ '), `up marker must not show at the top (${width}):\n${top}`)
    // Page down until the render stops changing (bottom reached).
    let guard = 200
    let prev = ''
    while (guard-- > 0) {
      f.handleInput('\x1b[6~')
      const next = render(f, width).join('\n')
      if (next === prev) break
      prev = next
    }
    const bottom = render(f, width).join('\n')
    assert.ok(render(f, width).length <= 12, `budget moved while scrolling (${width})`)
    // MAX_CONTENT_ROWS (64) caps the wrapped content, so the deepest
    // reachable line depends on the width: 61 rows fit uncapped at width
    // 100 (one row per line), while width 50 wraps each line to three rows
    // (word-wrap puts the label on its own row) and the cap lands at
    // detail-20.
    const deepest = width >= 100 ? 'detail-59' : 'detail-20'
    assert.ok(bottom.includes(deepest), `deep content unreachable (${width}, want ${deepest}):\n${bottom}`)
    assert.ok(!bottom.includes('detail-00'), `top content must scroll away (${width}):\n${bottom}`)
    assert.ok(bottom.includes('↑ '), `up marker missing at the bottom (${width}):\n${bottom}`)
    // Page up back to the top.
    while (guard-- > 0) {
      f.handleInput('\x1b[5~')
      const next = render(f, width).join('\n')
      if (next.includes('Pick a side')) break
    }
    const back = render(f, width).join('\n')
    assert.ok(back.includes('detail-00'), `PageUp must return to the top (${width}):\n${back}`)
    assert.ok(!back.includes('↑ '), `up marker must clear at the top (${width}):\n${back}`)
  }
})

/** The `↓ N more lines` marker's remaining count, -1 when absent. */
function belowCount(view: string): number {
  const match = /↓ (\d+) more lines/.exec(view)
  return match === null ? -1 : Number(match[1])
}

test('expand grows the body region and collapses the option window to the anchored row', () => {
  // Tested at the EXPANDED budget (38): the compact region caps at
  // MAX_BODY_LINES, so expansion must be exercised where it has room.
  for (const width of WIDTHS) {
    const f = makeFlow([{ id: 'q1', question: 'Pick a side', detail: longDetail(60), options: Array.from({ length: 6 }, (_, i) => ({ label: `Option ${i + 1}` })) }], 38)
    const compact = render(f, width).join('\n')
    assert.ok(render(f, width).length <= 38, `budget overflow compact (${width})`)
    assert.ok(compact.includes('Option 2'), `window must show neighbors compact (${width}):\n${compact}`)
    const compactBelow = belowCount(compact)
    assert.ok(compactBelow > 0, `down marker missing (${width}):\n${compact}`)
    f.handleInput('e')
    const expanded = render(f, width).join('\n')
    assert.ok(render(f, width).length <= 38, `budget overflow expanded (${width})`)
    assert.ok(belowCount(expanded) < compactBelow, `expand must reveal more content (${width}):\n${expanded}`)
    assert.ok(!expanded.includes('Option 2'), `window must collapse to the anchored row (${width}):\n${expanded}`)
    assert.ok(expanded.includes('Option 1'), `the anchored option must survive (${width}):\n${expanded}`)
    assert.ok(expanded.includes('→'), `pointer missing expanded (${width}):\n${expanded}`)
    // The hint drops low-priority verbs at narrow widths (pre-existing), so
    // 'esc cancel' is strictly asserted only where it fits.
    if (width >= 100) {
      assert.ok(expanded.includes('esc cancel'), `hint missing expanded (${width}):\n${expanded}`)
    }
    f.handleInput('e')
    const collapsed = render(f, width).join('\n')
    assert.ok(collapsed.includes('Option 2'), `collapse must restore the window (${width}):\n${collapsed}`)
  }
})

test('expand is a no-op when the body fits', () => {
  const f = makeFlow([{ id: 'q1', question: 'Short', options: [{ label: 'A' }] }], 24)
  const before = render(f, 100).join('\n')
  f.handleInput('e')
  assert.equal(render(f, 100).join('\n'), before)
})

test('scrolling resets when the question changes', () => {
  const f = makeFlow([
    { id: 'q1', question: 'First?', detail: longDetail(60), options: [{ label: 'A' }] },
    { id: 'q2', question: 'Second?', detail: longDetail(60), options: [{ label: 'B' }] },
  ], 24)
  render(f, 100) // input arrives after the first render (app timing)
  f.handleInput('\x1b[6~') // scroll q1's body down
  assert.ok(!render(f, 100).join('\n').includes('First?'), `question must scroll away:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x1b[C') // → next question: must open at ITS top, not mid-scroll
  const q2 = render(f, 100).join('\n')
  assert.ok(q2.includes('Second?'), `forward tab change must reset the scroll:\n${q2}`)
  f.handleInput('\x1b[D') // ← back
  assert.ok(render(f, 100).join('\n').includes('First?'), `scroll must reset on backward tab change:\n${render(f, 100).join('\n')}`)
})

test('expand resets when the question changes', () => {
  const f = makeFlow([
    { id: 'q1', question: 'First?', detail: longDetail(60), options: Array.from({ length: 4 }, (_, i) => ({ label: `Option ${i + 1}` })) },
    { id: 'q2', question: 'Second?', detail: longDetail(60), options: Array.from({ length: 4 }, (_, i) => ({ label: `B ${i + 1}` })) },
  ], 38)
  render(f, 100)
  f.handleInput('e') // expand q1
  assert.ok(!render(f, 100).join('\n').includes('Option 2'), `window must collapse when expanded:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x1b[C') // → q2: must open COLLAPSED (the old code leaked the
  // expanded view forward — only ←/Enter reset the body view).
  const q2 = render(f, 100).join('\n')
  assert.ok(q2.includes('B 2'), `expand must reset on forward tab change:\n${q2}`)
  f.handleInput('\x1b[D') // ← q1
  const back = render(f, 100).join('\n')
  assert.ok(back.includes('Option 2'), `expand must reset on backward tab change:\n${back}`)
})

test('PageDown and expand are inert on the review page', () => {
  const f = makeFlow([
    { id: 'q1', question: 'First?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Second?', options: [{ label: 'B' }] },
  ], 24)
  f.handleInput('1')
  f.handleInput('1') // → review page
  const before = render(f, 100).join('\n')
  f.handleInput('\x1b[6~')
  f.handleInput('e')
  assert.equal(render(f, 100).join('\n'), before)
})

test('optionless questions scroll their long body too', () => {
  const f = makeFlow([{ id: 'q1', question: 'Type it', detail: longDetail(60) }], 24)
  assert.ok(render(f, 100).join('\n').includes('detail-00'), `top missing:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x1b[6~')
  const scrolled = render(f, 100).join('\n')
  assert.ok(!scrolled.includes('detail-00'), `optionless body must scroll:\n${scrolled}`)
})

test('budget 38 expanded keeps the invariants (pointer, question, hint)', () => {
  for (const width of WIDTHS) {
    const f = makeFlow([{ id: 'q1', question: 'Pick a side', detail: longDetail(60), options: Array.from({ length: 6 }, (_, i) => ({ label: `Option ${i + 1}` })) }], 38)
    f.handleInput('e')
    assertPage(render(f, width), 38, width, 'Pick a side', { pointer: true, hint: 'esc cancel' })
  }
})
