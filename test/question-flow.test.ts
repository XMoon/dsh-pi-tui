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
    assert.ok(joined.includes('→ ['), `pointer missing (${width}x${budget}):\n${joined}`)
  }
  // A hint row always exists (the last row); 'esc cancel' always survives
  // (it is reserved in the fit loop), while the other verbs drop out at
  // narrow widths — so those are strictly asserted only where they fit.
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
    // The review page (plan item 4) has NO Submit/Cancel action row: the
    // 'Submit' TAB stays in the strip, but a Cancel ACTION must never
    // render (Enter submits, Esc cancels — no two-choice control).
    assert.ok(joined.includes('Submit'), `review tab missing (${width}x${budget}):\n${joined}`)
    assert.ok(!joined.includes('Cancel'), `the Submit/Cancel two-choice row is gone (${width}x${budget}):\n${joined}`)
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

/** Move the cursor down once and assert the pointer is visible (the unified
 * scrollport follows the cursor — at rest the view starts at the top, where
 * a long question+detail may keep the pointer below the fold). */
function assertPointerAfterDown(f: QuestionFlow, width: number, budget: number): void {
  f.handleInput('\x1b[B')
  const lines = render(f, width)
  assert.ok(lines.length <= budget, `budget overflow after cursor move:\n${lines.join('\n')}`)
  assert.ok(lines.join('\n').includes('→ ['), `pointer missing after cursor move:\n${lines.join('\n')}`)
}

test('budget matrix: rich choice page keeps required rows', () => {
  for (const budget of BUDGETS) {
    for (const width of WIDTHS) {
      const f = makeFlow([RICH_QUESTION], budget)
      // At rest the view starts at the TOP (question first) — the pointer
      // follows the cursor once it moves.
      assertPage(render(f, width), budget, width, 'Which approach', {
        hint: 'esc cancel',
        header: 'HEADER',
      })
      assertPointerAfterDown(f, width, budget)
    }
  }
})

test('budget matrix: cursor movement keeps the pointer in view', () => {
  for (const budget of BUDGETS) {
    for (const width of WIDTHS) {
      const f = makeFlow([RICH_QUESTION], budget)
      assert.ok(render(f, width).length <= budget, `budget overflow at rest:\n${render(f, width).join('\n')}`)
      for (let step = 0; step < 8; step++) {
        f.handleInput('\x1b[B') // Down — the view follows the cursor
        const lines = render(f, width)
        assert.ok(lines.length <= budget, `budget overflow at step ${step}:\n${lines.join('\n')}`)
        assert.ok(lines.join('\n').includes('→ ['), `pointer missing at step ${step}:\n${lines.join('\n')}`)
      }
    }
  }
})

test('budget matrix: a skipped question revisited keeps the skipped note', () => {
  for (const budget of BUDGETS) {
    for (const width of WIDTHS) {
      const f = makeFlow([RICH_QUESTION, { id: 'q2', question: 'Second question', options: [{ label: 'B' }] }], budget)
      f.handleInput('\x1b[C') // → skip q1 (unanswered → skipped + advance)
      f.handleInput('\x1b[D') // back to q1 (drafts survive)
      assertPage(render(f, width), budget, width, 'Which approach', {
        hint: 'esc cancel',
        skipped: true,
      })
      assertPointerAfterDown(f, width, budget)
    }
  }
})

test('budget matrix: optionless free-text question keeps the question and hint', () => {
  for (const budget of BUDGETS) {
    for (const width of WIDTHS) {
      const f = makeFlow([{ id: 'q1', question: 'Type your answer to this long free-text question that wraps across rows. '.repeat(2).trim() }], budget)
      // An optionless question OPENS in the text edit (esc back = leave
      // the edit for the navigation layer).
      assertPage(render(f, width), budget, width, 'Type your answer', { hint: 'esc back' })
    }
  }
})

test('→ skips only unanswered questions; answered drafts advance untouched', () => {
  // Web QuestionComposer skip parity: → on an UNANSWERED question marks it
  // skipped and advances; on an ANSWERED one the draft survives untouched.
  let done: unknown
  const f = new QuestionFlow([
    { id: 'q1', question: 'One?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Two?', options: [{ label: 'B' }] },
  ], (answers) => { done = answers }, () => {})
  f.setMaxRows(24)
  render(f, 100)
  f.handleInput('1') // answer q1 (single-select advances)
  render(f, 100)
  // q2 is now shown; → skips it (unanswered) and lands on the review page.
  f.handleInput('\x1b[C')
  assert.ok(render(f, 100).join('\n').includes('Submit'), `→ must reach the review page:\n${render(f, 100).join('\n')}`)
  f.handleInput('\r') // submit
  assert.deepEqual(done, [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: [] },
  ])
  // The unanswered question must be visibly marked skipped when reviewed
  // (this is what distinguishes →-skip from plain →-paging — the old code
  // just advanced without marking).
  let done3: unknown
  const h = new QuestionFlow([
    { id: 'q1', question: 'One?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Two?', options: [{ label: 'B' }] },
  ], (answers) => { done3 = answers }, () => {})
  h.setMaxRows(24)
  render(h, 100)
  h.handleInput('1') // answer q1 → q2
  render(h, 100)
  h.handleInput('\x1b[C') // → on UNANSWERED q2: skipped + review
  const skippedReview = render(h, 100).join('\n')
  assert.ok(skippedReview.includes('(skipped)'), `the unanswered question must show (skipped):\n${skippedReview}`)
  h.handleInput('\r') // submit
  assert.deepEqual(done3, [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: [] },
  ])
  // And an ANSWERED question's draft is preserved by → (no skip note).
  let done2: unknown
  const g = new QuestionFlow([
    { id: 'q1', question: 'One?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Two?', options: [{ label: 'B' }] },
  ], (answers) => { done2 = answers }, () => {})
  g.setMaxRows(24)
  render(g, 100)
  g.handleInput('1') // q1 answered → advances to q2
  render(g, 100)
  g.handleInput('1') // q2 answered → review
  render(g, 100)
  g.handleInput('\x1b[D') // ← back to q2 (answered)
  render(g, 100)
  g.handleInput('\x1b[C') // → on ANSWERED q2: draft kept, advance to review
  const review = render(g, 100).join('\n')
  assert.ok(review.includes('Submit'), `→ must reach the review page:\n${review}`)
  assert.ok(!review.includes('(skipped)'), `an answered question must not be marked skipped:\n${review}`)
  g.handleInput('\r') // submit
  assert.deepEqual(done2, [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: ['B'] },
  ])
})

test('Enter on empty custom text never wipes an existing selection', () => {
  // Regression: committing EMPTY custom text used to set skipped=true,
  // and the skipped mark wins at submit (returns selected: []) — the
  // selection was silently destroyed. An answered draft must survive.
  // (The old text-mode → move-on verb is gone — → is the text cursor now —
  // so Enter is the commit key this invariant rides on.)
  // Single-select case.
  let done: unknown
  const f = new QuestionFlow([
    { id: 'q1', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] },
  ], (answers) => { done = answers }, () => {})
  f.setMaxRows(24)
  render(f, 100)
  f.handleInput('1') // select A → advances to the review page
  render(f, 100)
  f.handleInput('\x1b[D') // ← back to q1 (answered)
  render(f, 100)
  // Walk the cursor to the "Type something." row and enter text mode.
  f.handleInput('\x1b[B')
  f.handleInput('\x1b[B')
  render(f, 100)
  f.handleInput('\r') // enter the free-text row
  render(f, 100)
  f.handleInput('\r') // Enter with EMPTY text: must NOT wipe the selection
  const review = render(f, 100).join('\n')
  assert.ok(review.includes('Submit'), `Enter must reach the review page:\n${review}`)
  assert.ok(!review.includes('(skipped)'), `the answered question must not become (skipped):\n${review}`)
  f.handleInput('\r') // submit
  assert.deepEqual(done, [{ id: 'q1', selected: ['A'] }])
  // Multi-select case: X checked, empty → keeps the selection.
  let done2: unknown
  const g = new QuestionFlow([
    { id: 'q1', question: 'Pick many', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
  ], (answers) => { done2 = answers }, () => {})
  g.setMaxRows(24)
  render(g, 100)
  g.handleInput('\r') // toggle X (multi-select stays on the question)
  render(g, 100)
  // Cursor onto "Type something." (last row), enter text mode, Enter empty.
  g.handleInput('\x1b[B')
  g.handleInput('\x1b[B')
  render(g, 100)
  g.handleInput('\r')
  render(g, 100)
  g.handleInput('\r') // Enter with EMPTY text on the answered multi-select
  // Single-question flow: commitOther advances straight to the review page.
  const review2 = render(g, 100).join('\n')
  assert.ok(review2.includes('Submit'), `Enter must reach the review page:\n${review2}`)
  assert.ok(!review2.includes('(skipped)'), `the multi-select answer must not become (skipped):\n${review2}`)
  g.handleInput('\r') // submit
  assert.deepEqual(done2, [{ id: 'q1', selected: ['X'] }])
})

test('review page: Enter submits, ↓ never cancels, ← goes back to the last question', () => {
  // Plan item 4: the review page is a PURE review — no Submit/Cancel
  // two-choice control, no focus, no ↑↓. Enter submits the whole batch,
  // Esc cancels the flow, ← returns to the last question (drafts survive).
  let cancelled = 0
  let done: unknown
  const f = new QuestionFlow([
    { id: 'q1', question: 'One?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Two?', options: [{ label: 'B' }] },
  ], (answers) => { done = answers }, () => { cancelled += 1 })
  f.setMaxRows(24)
  render(f, 100)
  f.handleInput('1') // answer q1 → q2
  render(f, 100)
  f.handleInput('1') // answer q2 → review
  let review = render(f, 100).join('\n')
  assert.ok(review.includes('Submit'), `review page missing:\n${review}`)
  assert.ok(!review.includes('Cancel'), `no Cancel action row on the pure review page:\n${review}`)
  assert.ok(review.includes('← back · ↵ submit · esc cancel'), `fixed review hint missing:\n${review}`)
  // ↑↓ are INERT on the review page: ↓ must not arm a Cancel action.
  f.handleInput('\x1b[B')
  f.handleInput('\x1b[B')
  render(f, 100)
  f.handleInput('\r')
  assert.equal(cancelled, 0, `↓ + Enter must SUBMIT, never cancel`)
  assert.deepEqual(done, [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: ['B'] },
  ])
  // ← back to the last question (drafts survive) — the old 'b' verb.
  const g = new QuestionFlow([
    { id: 'q1', question: 'One?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Two?', options: [{ label: 'B' }] },
  ], () => {}, () => {})
  g.setMaxRows(24)
  render(g, 100)
  g.handleInput('1')
  render(g, 100)
  g.handleInput('1') // → review
  g.handleInput('\x1b[D') // ← back
  assert.ok(render(g, 100).join('\n').includes('Two?'), `← must return to the last question:\n${render(g, 100).join('\n')}`)
})

test('Enter in text mode commits the typed answer (empty counts as skipped)', () => {
  // Text mode (optionless): Enter commits the typed text and advances; an
  // empty input counts as skipped (the old → move-on verb is now the text
  // cursor's key in edit mode — Enter is the commit path).
  let done: unknown
  const f = new QuestionFlow([
    { id: 'q1', question: 'Name?' },
    { id: 'q2', question: 'Second?', options: [{ label: 'B' }] },
  ], (answers) => { done = answers }, () => {})
  f.setMaxRows(24)
  render(f, 100)
  f.handleInput('alice')
  f.handleInput('\r') // Enter commits the typed answer
  assert.ok(render(f, 100).join('\n').includes('Second?'), `Enter must advance from text mode:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x1b[C') // → on unanswered q2 → review (skipped)
  render(f, 100)
  f.handleInput('\r') // submit
  assert.deepEqual(done, [
    { id: 'q1', selected: [], custom: 'alice' },
    { id: 'q2', selected: [] },
  ])
})

test('the hint advertises ← back · → skip instead of the old letters', () => {
  const f = makeFlow([
    { id: 'q1', question: 'One?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Two?', options: [{ label: 'B' }] },
  ], 24)
  const questionPage = render(f, 100).join('\n')
  assert.ok(questionPage.includes('← back · → skip'), `hint must advertise the arrow verbs:\n${questionPage}`)
  assert.ok(!questionPage.includes('s skip'), `the old 's skip' verb must be gone:\n${questionPage}`)
  // Text mode edits text: ←→ belong to the text cursor (edit hint), and
  // the edit hint always says esc back (leave the edit).
  const g = makeFlow([{ id: 'q1', question: 'Your name?' }], 24)
  const textMode = render(g, 100).join('\n')
  assert.ok(textMode.includes('←→ edit'), `text-mode hint must advertise ←→ edit:\n${textMode}`)
  assert.ok(textMode.includes('esc back'), `edit hint must advertise esc back:\n${textMode}`)
  assert.ok(!textMode.includes('esc cancel'), `edit hint must not advertise esc cancel:\n${textMode}`)
  assert.ok(!textMode.includes('→ next'), `text-mode hint must not advertise → next:\n${textMode}`)
  assert.ok(!textMode.includes('→ skip'), `text-mode hint must not say → skip:\n${textMode}`)
  assert.ok(!textMode.includes('↑↓ select'), `text-mode hint must not advertise ↑↓ select:\n${textMode}`)
  assert.ok(!textMode.includes('1-1 choose'), `text-mode hint must not advertise digit choose:\n${textMode}`)
  // The NAVIGATION state after Esc advertises the optionless verbs:
  // ↵ re-enters the edit, ← back / → skip page (a multi-question flow),
  // esc cancels the flow.
  const g2 = makeFlow([
    { id: 'q1', question: 'First?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Your name?' },
  ], 24)
  g2.handleInput('1') // answer Q1 → Q2 (optionless, edit layer)
  g2.handleInput('\x1b') // Esc → navigation state
  const navMode = render(g2, 100).join('\n')
  assert.ok(navMode.includes('↵ edit'), `navigation hint must advertise ↵ edit:\n${navMode}`)
  assert.ok(navMode.includes('← back · → skip'), `navigation hint must advertise the arrow verbs:\n${navMode}`)
  assert.ok(navMode.includes('esc cancel'), `navigation hint must advertise esc cancel:\n${navMode}`)
  assert.ok(!navMode.includes('←→ edit'), `navigation hint must not advertise ←→ edit:\n${navMode}`)
  f.handleInput('1')
  render(f, 100)
  f.handleInput('1') // → review
  const review = render(f, 100).join('\n')
  assert.ok(review.includes('← back · ↵ submit · esc cancel'), `review hint must advertise the fixed verbs:\n${review}`)
  assert.ok(!review.includes('↑↓ choose'), `the Submit/Cancel two-choice verb must be gone:\n${review}`)
  assert.ok(!review.includes('b back'), `the old 'b back' verb must be gone:\n${review}`)
})

test('budget matrix: review page keeps the hint and never a Cancel row', () => {
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

test('the review page fills the FULL budget (round-3 finding: one row was reserved for the removed Cancel row)', () => {
  // The old page reserved TWO tail rows (the Submit/Cancel action row +
  // the hint); with the action row gone, the hint is the ONLY required
  // tail — the page must show one more answer/content row, i.e. use the
  // whole budget when the answers are long enough. Five long answers
  // far exceed every budget, so the budget is exactly filled.
  const questions = Array.from({ length: 5 }, (_, i) => ({
    id: `q${i + 1}`,
    question: RICH_QUESTION.question,
    options: RICH_QUESTION.options,
  }))
  for (const budget of BUDGETS) {
    const f = makeFlow(questions, budget)
    for (let qi = 0; qi < questions.length; qi++) {
      f.handleInput('1') // answer → advance (review page on the last)
    }
    const lines = render(f, 100)
    assert.equal(lines.length, budget, `the review page must fill the whole budget at ${budget}:\n${lines.join('\n')}`)
    assert.ok(lines[lines.length - 1]!.includes('↵ submit'),
      `the hint must still be the last row at ${budget}:\n${lines.join('\n')}`)
  }
})

test('budget 8 with header and skipped state keeps the required rows', () => {
  // Budget 8 with a skipped note: the scrollport is tiny but the question's
  // first row, the (skipped) note and the hint must all survive; the
  // decorative header may keep its row (the scrollport scrolls).
  for (const width of WIDTHS) {
    const f = makeFlow([RICH_QUESTION, { id: 'q2', question: 'Second?', options: [{ label: 'B' }] }], 8)
    f.handleInput('\x1b[C') // → skip q1
    f.handleInput('\x1b[D') // back to q1
    assertPage(render(f, width), 8, width, 'Which approach', {
      hint: 'esc cancel',
      skipped: true,
    })
    assertPointerAfterDown(f, width, 8)
  }
})

test('a 1-row question budget shows the question text, never a marker-only row', () => {
  // Budget 8 + header with a long question: the first scrollport row must
  // carry the question text (required-first) — a marker may follow, but it
  // can never replace the question row.
  const f = makeFlow([{
    id: 'q1',
    header: 'HEADER',
    question: 'A very long question '.repeat(10).trim(),
    options: [{ label: 'A' }],
  }], 8)
  const lines = render(f, 50)
  assert.ok(lines.length <= 8, `overflow:\n${lines.join('\n')}`)
  const questionRow = lines.findIndex(l => l.includes('A very long question'))
  assert.ok(questionRow >= 0, `question text missing:\n${lines.join('\n')}`)
  const markerRow = lines.findIndex(l => l.includes('more lines'))
  assert.ok(markerRow === -1 || markerRow > questionRow, `marker must not replace the question:\n${lines.join('\n')}`)
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
    // MAX_CONTENT_ROWS (256) keeps the whole page (detail + options)
    // reachable at both widths — the deepest detail line is always there.
    assert.ok(bottom.includes('detail-59'), `deep content unreachable (${width}):\n${bottom}`)
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

test('expand flips the hint and keeps the fixed-budget render intact', () => {
  // 'e' only grows the FRAME (the app layer's QuestionFrame reads
  // isBodyExpanded); at a fixed budget the flow's render is unchanged apart
  // from the hint verb (e expand <-> e collapse) — asserted at widths where
  // the hint fits (the fit loop drops verbs at narrow widths).
  for (const width of WIDTHS) {
    const f = makeFlow([{ id: 'q1', question: 'Pick a side', detail: longDetail(60), options: Array.from({ length: 6 }, (_, i) => ({ label: `Option ${i + 1}` })) }], 38)
    const compact = render(f, width).join('\n')
    assert.ok(render(f, width).length <= 38, `budget overflow compact (${width})`)
    assert.ok(compact.includes('↓ '), `down marker missing (${width}):\n${compact}`)
    f.handleInput('e')
    const expanded = render(f, width).join('\n')
    assert.ok(render(f, width).length <= 38, `budget overflow expanded (${width})`)
    if (width >= 100) {
      assert.ok(expanded.includes('e collapse'), `hint must flip to e-collapse (${width}):\n${expanded}`)
    }
    f.handleInput('e')
    const collapsed = render(f, width).join('\n')
    if (width >= 100) {
      assert.ok(collapsed.includes('e expand'), `collapse must restore the hint (${width}):\n${collapsed}`)
    }
  }
})

test('expand is a no-op when everything fits', () => {
  const f = makeFlow([{ id: 'q1', question: 'Short', options: [{ label: 'A' }] }], 24)
  const before = render(f, 100).join('\n')
  f.handleInput('e')
  assert.equal(render(f, 100).join('\n'), before)
})

test('the hint advertises e-expand when the page overflows the scrollport', () => {
  // Small-budget fixture: short question + long option descriptions — the
  // page overflows, so 'e' (and the scroll verbs) are advertised. Width 100:
  // the hint fits all verbs (the fit loop drops parts at narrow widths).
  const f = makeFlow([{
    id: 'q1',
    question: 'Pick',
    options: Array.from({ length: 3 }, (_, i) => ({ label: `Option ${i + 1}`, description: 'd'.repeat(300) })),
  }], 12)
  const compact = render(f, 100).join('\n')
  assert.ok(compact.includes('more lines'), `descriptions must overflow:\n${compact}`)
  assert.ok(compact.includes('e expand'), `hint must advertise e-expand:\n${compact}`)
  assert.ok(compact.includes('pgup/pgdn scroll'), `hint must advertise scrolling:\n${compact}`)
  f.handleInput('e')
  const expanded = render(f, 100).join('\n')
  assert.ok(render(f, 100).length <= 12, `budget overflow expanded:\n${expanded}`)
  assert.ok(expanded.includes('Option 1'), `the first option must survive:\n${expanded}`)
  assert.ok(expanded.includes('e collapse'), `hint must flip to e-collapse:\n${expanded}`)
  f.handleInput('e')
  assert.ok(render(f, 100).join('\n').includes('e expand'), `collapse must restore the hint:\n${render(f, 100).join('\n')}`)
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
  assert.ok(render(f, 100).join('\n').includes('e collapse'), `q1 must be expanded:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x1b[C') // → q2: must open COLLAPSED (the old code leaked the
  // expanded view forward — only ←/Enter reset the body view).
  const q2 = render(f, 100).join('\n')
  assert.ok(q2.includes('e expand'), `expand must reset on forward tab change:\n${q2}`)
  f.handleInput('\x1b[D') // ← q1
  const back = render(f, 100).join('\n')
  assert.ok(back.includes('e expand'), `expand must reset on backward tab change:\n${back}`)
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

test('expand keeps the scroll position at a fixed budget', () => {
  // The frame grows in the APP layer; the flow itself must KEEP the scroll
  // when 'e' toggles — a reintroduced `bodyScroll = 0` would jump the view
  // back to the top while the user is reading the options ('e' reveals more
  // rows where the user is looking, never the question head again).
  const f = makeFlow([{ id: 'q1', question: 'Pick a side', detail: longDetail(60), options: Array.from({ length: 6 }, (_, i) => ({ label: `Option ${i + 1}` })) }], 12)
  render(f, 100)
  let guard = 200
  let prev = ''
  while (guard-- > 0) {
    f.handleInput('\x1b[6~')
    const next = render(f, 100).join('\n')
    if (next === prev) break
    prev = next
  }
  const scrolled = render(f, 100).join('\n')
  assert.ok(!scrolled.includes('Pick a side'), `precondition — must be scrolled away from the top:\n${scrolled}`)
  f.handleInput('e')
  const expanded = render(f, 100).join('\n')
  assert.ok(expanded.includes('Option 6'), `expand must keep the scrolled view:\n${expanded}`)
  assert.ok(!expanded.includes('Pick a side'), `expand must not jump back to the top:\n${expanded}`)
})

test('empty free-text rows show a dim placeholder, replaced by typed text', () => {
  // Optionless page: the pinned input row advertises itself with a dim
  // placeholder instead of a bare cursor block (a blank row reads as
  // "nothing here" on a small screen).
  const f = makeFlow([{ id: 'q1', question: 'Your name?' }], 12)
  const optionless = render(f, 100).join('\n')
  assert.ok(optionless.includes('Type your answer…'), `placeholder missing:\n${optionless}`)
  f.handleInput('alice')
  const typed = render(f, 100).join('\n')
  assert.ok(!typed.includes('Type your answer…'), `placeholder must clear while typing:\n${typed}`)
  assert.ok(typed.includes('alice'), `typed text must replace the placeholder:\n${typed}`)
  // Choice page: while editing the 'Type something.' row with an EMPTY
  // value, the label stays as a dim placeholder (it used to vanish into a
  // bare cursor row); typing replaces it.
  const g = makeFlow([{ id: 'q1', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }], 12)
  render(g, 100)
  g.handleInput('\x1b[B')
  g.handleInput('\x1b[B') // cursor onto 'Type something.'
  assert.ok(render(g, 100).join('\n').includes('Type something.'), `label missing before editing:\n${render(g, 100).join('\n')}`)
  g.handleInput('\r') // enter free-text editing (empty draft)
  const editing = render(g, 100).join('\n')
  assert.ok(editing.includes('Type something.'), `label must stay as a placeholder while editing an empty value:\n${editing}`)
  g.handleInput('hi')
  const gTyped = render(g, 100).join('\n')
  assert.ok(gTyped.includes('hi'), `typed text must land in the editing row:\n${gTyped}`)
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
    assertPage(render(f, width), 38, width, 'Pick a side', { hint: 'esc cancel' })
    assertPointerAfterDown(f, width, 38)
  }
})

// ── ↑↓ edge scrolling (the question overview must be reachable by ↑) ──────

/** A page that overflows a 12-row budget at width 100: a long detail pushes
 * every option (and the question) out of the initial viewport. */
function overflowingFlow(): QuestionFlow {
  return makeFlow([{ id: 'q1', question: 'Pick a side', detail: longDetail(60), options: [{ label: 'Alpha' }, { label: 'Beta' }] }], 12)
}

test('↑ at the first row scrolls the body UP until the question overview returns', () => {
  for (const width of WIDTHS) {
    const f = overflowingFlow()
    render(f, width) // first render establishes the scrollport geometry
    // ↓ twice: the cursor walks to the last row; the view follows it down.
    f.handleInput('\x1b[B')
    f.handleInput('\x1b[B')
    const deep = render(f, width).join('\n')
    assert.ok(!deep.includes('Pick a side'), `precondition — question must be scrolled away (${width}):\n${deep}`)
    // ↑ at the first row must scroll the view up (never wrap to the last row).
    // The cursor sits on the FIRST row after the walk-down (↑ from the last
    // row wraps); press ↑ until the question text returns. The pointer may
    // leave the viewport mid-scroll (like PageUp) — that is accepted; a ↓
    // afterwards restores it (verified in the composition test below).
    let guard = 40
    while (guard-- > 0) {
      f.handleInput('\x1b[A')
      const next = render(f, width).join('\n')
      if (next.includes('Pick a side')) break
    }
    assert.ok(render(f, width).join('\n').includes('Pick a side'), `↑ must scroll the question back (${width}):\n${render(f, width).join('\n')}`)
  }
})

test('↓ at the last row scrolls the body DOWN instead of wrapping (overflow only)', () => {
  for (const width of WIDTHS) {
    // Deterministic pin for the ↓ edge-scroll branch:
    //  1. walk the cursor to the LAST row ("Type something.") — the view
    //     follows it to the page bottom;
    //  2. PageUp once — the view scrolls UP a page, the cursor (still on
    //     the last row) drops BELOW the viewport;
    //  3. ↓ — with the cursor on the last row and MORE content below the
    //     viewport (`lastContentRows > bodyScroll + lastVisibleRows` is
    //     genuinely true), the edge-scroll branch must fire: the view
    //     scrolls DOWN a page and the cursor STAYS on the last row.
    const f = overflowingFlow()
    render(f, width)
    f.handleInput('\x1b[B') // Alpha
    f.handleInput('\x1b[B') // Beta
    f.handleInput('\x1b[B') // Type something. (LAST row)
    render(f, width)
    f.handleInput('\x1b[5~') // PageUp: view up a page, cursor below the viewport
    const midPage = render(f, width).join('\n')
    assert.ok(midPage.includes('↑ '), `precondition — view must be scrolled down (${width}):\n${midPage}`)
    assert.ok(!midPage.includes('→ ['), `precondition — cursor must be off-screen after PageUp (${width}):\n${midPage}`)
    // ↓ at the LAST row with more content below: edge-scroll fires — the
    // view scrolls DOWN and the cursor STAYS on the last row (no wrap to
    // the first row, which would yank the view back toward the top).
    f.handleInput('\x1b[B')
    const after = render(f, width).join('\n')
    assert.ok(after !== midPage, `↓ at the last row must change the view (${width})`)
    assert.ok(!after.includes('Pick a side'), `↓ at the last row must keep scrolling down (${width}):\n${after}`)
    assert.ok(after.includes('→ [ ] Type something.'), `cursor must stay on the last row (edge scroll, no wrap) (${width}):\n${after}`)
  }
})

test('↑↓ keep the wrap-around when the page fits (no overflow)', () => {
  const f = makeFlow([{ id: 'q1', question: 'Short', options: [{ label: 'A' }, { label: 'B' }] }], 24)
  render(f, 100)
  // ↑ at the first row: no scroll to do, so the cursor wraps to the last row
  // (the "Type something." free-text row).
  f.handleInput('\x1b[A')
  assert.ok(render(f, 100).join('\n').includes('→ [ ] Type something.'), `↑ must wrap to the last row when the page fits:\n${render(f, 100).join('\n')}`)
  // ↓ at the last row: no overflow, so the cursor wraps back to the first.
  f.handleInput('\x1b[B')
  assert.ok(render(f, 100).join('\n').includes('→ [1] A'), `↓ must wrap to the first row when the page fits:\n${render(f, 100).join('\n')}`)
})

test('edge scrolling composes with cursor follow (pointer restored by the next cursor move)', () => {
  for (const width of WIDTHS) {
    const f = overflowingFlow()
    render(f, width)
    // Down-walk to the last row, then ↑ (edge scroll — pointer may leave the
    // viewport), then ↓ again: the cursor-follow must restore the pointer.
    f.handleInput('\x1b[B')
    f.handleInput('\x1b[B')
    f.handleInput('\x1b[A') // edge scroll up (pointer may leave the view)
    f.handleInput('\x1b[B') // cursor move: the view follows the pointer back
    const lines = render(f, width)
    assert.ok(lines.length <= 12, `budget overflow (${width}):\n${lines.join('\n')}`)
    assert.ok(lines.join('\n').includes('→ ['), `cursor follow must restore the pointer (${width}):\n${lines.join('\n')}`)
    // And ↑ still reaches the question from anywhere (the headline fix).
    let guard = 40
    while (guard-- > 0) {
      f.handleInput('\x1b[A')
      if (render(f, width).join('\n').includes('Pick a side')) break
    }
    assert.ok(render(f, width).join('\n').includes('Pick a side'), `↑ must reach the question after interleaving (${width})`)
  }
})

// Kitty CSI-u / modifyOtherKeys encodings: terminals that answer the Kitty
// keyboard-protocol query (zellij, Windows Terminal, WezTerm, kitty…) report
// arrows/Esc/Tab as CSI-u sequences (`\x1b[1;1B`, `\x1b[27;1u`, `\x1b[9;1u`)
// instead of the legacy `\x1b[B`/`\x1b`/`\t`. The flow previously compared
// raw sequences, silently dropping every such key (the zellij repro: arrows
// and Esc dead while letters/Enter worked — letters stay raw bytes). All
// matching goes through matchesKey now; these tests pin the CSI-u forms.
test('Kitty CSI-u arrow keys navigate (zellij/WezTerm/Windows Terminal)', () => {
  const f = makeFlow([{ id: 'q1', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }], 24)
  render(f, 100)
  // CSI-u ↓ with modifier 0 (`\x1b[1;1B`) and the user's exact sequence with
  // super reported (`\x1b[1;129B` — the zellij repro) must both move down.
  f.handleInput('\x1b[1;1B')
  assert.ok(render(f, 100).join('\n').includes('→ [2] B'), `CSI-u down must move the cursor:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x1b[1;129B')
  assert.ok(render(f, 100).join('\n').includes('→ [ ] Type something.'), `CSI-u down (super mod) must move the cursor:\n${render(f, 100).join('\n')}`)
  // CSI-u ↑ (`\x1b[1;1A`) back up.
  f.handleInput('\x1b[1;1A')
  assert.ok(render(f, 100).join('\n').includes('→ [2] B'), `CSI-u up must move the cursor:\n${render(f, 100).join('\n')}`)
  // CSI-u ←/→ page between questions (q1 → q2 → review).
  const f2 = makeFlow([
    { id: 'q1', question: 'One', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Two', options: [{ label: 'B' }] },
  ], 24)
  render(f2, 100)
  f2.handleInput('\x1b[1;1C') // CSI-u right
  assert.ok(render(f2, 100).join('\n').includes('Two'), `CSI-u right must page to q2:\n${render(f2, 100).join('\n')}`)
  f2.handleInput('\x1b[1;1D') // CSI-u left
  assert.ok(render(f2, 100).join('\n').includes('One'), `CSI-u left must page back to q1:\n${render(f2, 100).join('\n')}`)
})

test('Kitty CSI-u Esc cancels and CSI-u Tab/Enter work', () => {
  // Esc as `\x1b[27;1u` and the repro's `\x1b[27;129u` must cancel the flow.
  let cancelled = 0
  const f = makeFlow([{ id: 'q1', question: 'Pick', options: [{ label: 'A' }] }], 24)
  const g = new QuestionFlow([{ id: 'q1', question: 'Pick', options: [{ label: 'A' }] }], () => {}, () => { cancelled += 1 })
  g.setMaxRows(24)
  render(g, 100)
  g.handleInput('\x1b[27;1u')
  assert.equal(cancelled, 1, `CSI-u Esc must cancel (plain mod): got ${cancelled}`)
  const h = new QuestionFlow([{ id: 'q1', question: 'Pick', options: [{ label: 'A' }] }], () => {}, () => { cancelled += 1 })
  h.setMaxRows(24)
  render(h, 100)
  h.handleInput('\x1b[27;129u')
  assert.equal(cancelled, 2, `CSI-u Esc must cancel (super mod, the zellij repro): got ${cancelled}`)
  // CSI-u Enter (`\x1b[13;1u`) confirms the highlighted option → review page;
  // a second Enter submits the batch (single-select advances, then the
  // review page owns the final submit — Web QuestionComposer semantics).
  let done: unknown
  const k = new QuestionFlow([{ id: 'q1', question: 'Pick', options: [{ label: 'A' }] }], (answers) => { done = answers }, () => {})
  k.setMaxRows(24)
  render(k, 100)
  k.handleInput('\x1b[13;1u')
  assert.ok(done === undefined, `first CSI-u Enter must land on the review page, not submit`)
  assert.ok(render(k, 100).join('\n').includes('Submit'), `review page must show after CSI-u Enter:\n${render(k, 100).join('\n')}`)
  k.handleInput('\x1b[13;1u')
  assert.ok(done !== undefined, `second CSI-u Enter must submit:\n${JSON.stringify(done)}`)
  assert.deepEqual((done as { id: string; selected: string[] }[])[0]?.selected, ['A'])
  // Legacy Esc must still cancel (regression guard for the old path).
  const legacy = new QuestionFlow([{ id: 'q1', question: 'Pick', options: [{ label: 'A' }] }], () => {}, () => { cancelled += 1 })
  legacy.setMaxRows(24)
  render(legacy, 100)
  legacy.handleInput('\x1b')
  assert.equal(cancelled, 3, `legacy Esc must still cancel: got ${cancelled}`)
})

// ── WP1: free-text edit keyboard ownership (plan §2) ─────────────────────

/** Enter the free-text edit of a question WITH options: walk the cursor to
 *  the "Type something." row (the last row) and confirm it. */
function enterOtherEdit(f: QuestionFlow, optionCount: number): void {
  render(f, 100)
  for (let i = 0; i < optionCount; i++) f.handleInput('\x1b[B')
  render(f, 100)
  f.handleInput('\r') // confirm the OTHER row
  render(f, 100)
}

test('edit mode: Left + X inserts mid-text and never commits/advances', () => {
  // The headline regressions: → used to commit+advance and ← used to page
  // back — the parent stole the text cursor. Now BOTH arrows go to the
  // shared Input, so abc + Left + X must yield abXc and stay put.
  let done: unknown
  const f = new QuestionFlow([
    { id: 'q1', question: 'Name?', options: [{ label: 'A' }, { label: 'B' }] },
  ], (answers) => { done = answers }, () => {})
  f.setMaxRows(24)
  enterOtherEdit(f, 2)
  f.handleInput('abc')
  f.handleInput('\x1b[D') // Left
  f.handleInput('X')
  let view = render(f, 100).join('\n')
  assert.ok(view.includes('abXc'), `Left+X must insert mid-text:\n${view}`)
  assert.ok(!view.includes('Review your answer'), `Left must not commit/advance:\n${view}`)
  assert.ok(done === undefined, `Left must not submit the draft`)
  // Right moves the cursor only (never commit/next).
  f.handleInput('\x1b[C') // Right — back to the end
  f.handleInput('Y')
  view = render(f, 100).join('\n')
  assert.ok(view.includes('abXcY'), `Right must move the cursor only:\n${view}`)
  assert.ok(!view.includes('Review your answer'), `Right must not commit/advance:\n${view}`)
  assert.ok(done === undefined, `Right must not submit the draft`)
  // The double-left-right variant from the plan.
  const g = new QuestionFlow([
    { id: 'q1', question: 'Name?', options: [{ label: 'A' }] },
  ], () => {}, () => {})
  g.setMaxRows(24)
  enterOtherEdit(g, 1)
  g.handleInput('abc')
  g.handleInput('\x1b[D')
  g.handleInput('\x1b[D')
  g.handleInput('\x1b[C')
  g.handleInput('X')
  view = render(g, 100).join('\n')
  assert.ok(view.includes('abXc'), `Left Left Right + X must land between b and c:\n${view}`)
  assert.ok(!view.includes('Review your answer'), `no advance in the double-arrow variant:\n${view}`)
})

test('edit mode: Home/End and Ctrl+A/E/B/F reach the shared Input', () => {
  const f = makeFlow([{ id: 'q1', question: 'Name?' }], 24) // optionless → already editing
  render(f, 100)
  f.handleInput('abc')
  f.handleInput('\x1bOH') // Home
  f.handleInput('X')
  assert.ok(render(f, 100).join('\n').includes('Xabc'), `Home + X must prepend:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x1bOF') // End
  f.handleInput('Y')
  assert.ok(render(f, 100).join('\n').includes('XabcY'), `End + Y must append:\n${render(f, 100).join('\n')}`)
  // Ctrl+A / Ctrl+E (Emacs line home/end).
  f.handleInput('\x01') // Ctrl+A
  f.handleInput('Z')
  assert.ok(render(f, 100).join('\n').includes('ZXabcY'), `Ctrl+A + Z must prepend:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x05') // Ctrl+E
  f.handleInput('W')
  assert.ok(render(f, 100).join('\n').includes('ZXabcYW'), `Ctrl+E + W must append:\n${render(f, 100).join('\n')}`)
  // Ctrl+B / Ctrl+F (Emacs char movement).
  f.handleInput('\x02') // Ctrl+B — one left from the end
  f.handleInput('V')
  assert.ok(render(f, 100).join('\n').includes('ZXabcYVW'), `Ctrl+B + V must insert before W:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x06') // Ctrl+F — back to the end
  f.handleInput('U')
  assert.ok(render(f, 100).join('\n').includes('ZXabcYVWU'), `Ctrl+F + U must append:\n${render(f, 100).join('\n')}`)
})

test('edit mode: Backspace/Delete, word movement and kill/undo reach the Input', () => {
  const f = makeFlow([{ id: 'q1', question: 'Name?' }], 24)
  render(f, 100)
  f.handleInput('abc')
  f.handleInput('\x7f') // Backspace
  assert.ok(render(f, 100).join('\n').includes('ab'), `Backspace must delete backward:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x1bOH') // Home
  f.handleInput('\x1b[3~') // Delete
  assert.ok(render(f, 100).join('\n').includes('b'), `Delete must delete forward:\n${render(f, 100).join('\n')}`)
  // Word movement: Alt+Left from the end lands at the previous word start.
  const g = makeFlow([{ id: 'q1', question: 'Words?' }], 24)
  render(g, 100)
  g.handleInput('hello world')
  g.handleInput('\x1bB') // Alt+Left
  g.handleInput('X')
  assert.ok(render(g, 100).join('\n').includes('hello Xworld'), `Alt+Left + X must insert at the word boundary:\n${render(g, 100).join('\n')}`)
  // Kill/undo: Ctrl+U kills to line start, undo restores it.
  const h = makeFlow([{ id: 'q1', question: 'Kill?' }], 24)
  render(h, 100)
  h.handleInput('abc')
  h.handleInput('\x15') // Ctrl+U
  assert.ok(!render(h, 100).join('\n').includes('abc'), `Ctrl+U must kill to line start:\n${render(h, 100).join('\n')}`)
  h.handleInput('\x1f') // Ctrl+- undo
  assert.ok(render(h, 100).join('\n').includes('abc'), `undo must restore the killed text:\n${render(h, 100).join('\n')}`)
})

test('edit mode: Enter confirms, Esc backs to choices (draft kept), PgUp/PgDn scroll the body', () => {
  // Enter confirms the custom answer (parent-owned).
  let done: unknown
  const f = new QuestionFlow([
    { id: 'q1', question: 'Name?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Second?', options: [{ label: 'B' }] },
  ], (answers) => { done = answers }, () => {})
  f.setMaxRows(24)
  enterOtherEdit(f, 1)
  f.handleInput('alice')
  f.handleInput('\r') // Enter commits
  assert.ok(render(f, 100).join('\n').includes('Second?'), `Enter must commit and advance:\n${render(f, 100).join('\n')}`)
  // Esc with choices: back to the option list, the COMMITTED draft survives.
  const g = new QuestionFlow([
    { id: 'q1', question: 'Name?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Second?', options: [{ label: 'B' }] },
  ], () => {}, () => {})
  g.setMaxRows(24)
  enterOtherEdit(g, 1)
  g.handleInput('alice')
  g.handleInput('\r') // Enter commits → advances to q2
  assert.ok(render(g, 100).join('\n').includes('Second?'), `precondition — committed custom advances:\n${render(g, 100).join('\n')}`)
  g.handleInput('\x1b[D') // ← back to q1 (answered, custom 'alice')
  enterOtherEdit(g, 1) // walk to the OTHER row and enter edit mode
  const beforeEsc = render(g, 100).join('\n')
  assert.ok(beforeEsc.includes('alice'), `precondition — draft text visible in the edit row:\n${beforeEsc}`)
  g.handleInput('\x1b') // Esc → option mode
  const backToChoices = render(g, 100).join('\n')
  assert.ok(backToChoices.includes('↑↓ select'), `Esc must return to the option list:\n${backToChoices}`)
  // Re-enter the edit: Esc leaves the cursor on the OTHER row, so Enter
  // goes straight back in — the COMMITTED draft text must still be there.
  render(g, 100)
  g.handleInput('\r')
  const reentered = render(g, 100).join('\n')
  assert.ok(reentered.includes('alice'), `the committed draft must survive Esc and re-entry:\n${reentered}`)
  // PgUp/PgDn still scroll the body while editing (a long detail).
  const h = makeFlow([{ id: 'q1', question: 'Pick a side', detail: longDetail(60) }], 12)
  const top = render(h, 100).join('\n')
  assert.ok(top.includes('detail-00'), `precondition — body top visible:\n${top}`)
  h.handleInput('\x1b[6~') // PageDown while editing
  const scrolled = render(h, 100).join('\n')
  assert.ok(!scrolled.includes('detail-00') || scrolled.includes('↑ '),
    `PageDown must scroll the body while editing:\n${scrolled}`)
  h.handleInput('\x1b[5~') // PageUp
  const back = render(h, 100).join('\n')
  assert.ok(back.includes('detail-00'), `PageUp must scroll the body back:\n${back}`)
})

test('optionless question: Esc enters the navigation state, Esc again cancels the flow', () => {
  // Two-layer state machine: the EDIT layer owns the text; Esc leaves it
  // for the navigation layer (← back / → skip / ↵ re-edit); ONLY the
  // navigation layer's Esc cancels the whole flow. A single Esc must
  // never cancel and must never strand the question uneditable.
  let cancelled = 0
  const f = new QuestionFlow([{ id: 'q1', question: 'Name?' }], () => {}, () => { cancelled += 1 })
  f.setMaxRows(24)
  render(f, 100)
  f.handleInput('alice')
  f.handleInput('\x1b') // Esc: leave the edit — NOT a cancel
  assert.equal(cancelled, 0, `first Esc must not cancel: got ${cancelled}`)
  const nav = render(f, 100).join('\n')
  assert.ok(nav.includes('↵ edit'), `after Esc the navigation hint must advertise ↵ edit:\n${nav}`)
  assert.ok(nav.includes('esc cancel'), `navigation hint must advertise esc cancel:\n${nav}`)
  f.handleInput('\x1b') // navigation-state Esc cancels the flow
  assert.equal(cancelled, 1, `navigation Esc must cancel the flow once: got ${cancelled}`)
  // The Input's generic cancel (Ctrl+C) mirrors the same two-stage
  // lifecycle: first press leaves the edit, second press cancels.
  const g = new QuestionFlow([{ id: 'q1', question: 'Name?' }], () => {}, () => { cancelled += 1 })
  g.setMaxRows(24)
  render(g, 100)
  g.handleInput('\x03') // Ctrl+C → navigation state (like Esc)
  assert.equal(cancelled, 1, `first Ctrl+C must leave the edit, not cancel: got ${cancelled}`)
  g.handleInput('\x03') // navigation-state Ctrl+C cancels
  assert.equal(cancelled, 2, `navigation Ctrl+C must cancel the flow: got ${cancelled}`)
})

test('optionless navigation state: Enter and printable keys re-enter the edit', () => {
  // After Esc leaves the edit, the question is NOT editable in place —
  // the edit layer must be re-entered explicitly (Enter) or implicitly
  // (any typing key drops straight back into the Input).
  let cancelled = 0
  const f = new QuestionFlow([{ id: 'q1', question: 'Name?' }], () => {}, () => { cancelled += 1 })
  f.setMaxRows(24)
  render(f, 100)
  f.handleInput('ali')
  f.handleInput('\x1b') // navigation state
  const before = render(f, 100).join('\n')
  assert.ok(!before.includes('←→ edit'), `navigation state must not advertise the edit hint:\n${before}`)
  f.handleInput('\r') // ↵ re-enters the edit
  const editing1 = render(f, 100).join('\n')
  assert.ok(editing1.includes('←→ edit'), `↵ must re-enter the edit:\n${editing1}`)
  f.handleInput('x') // typing inside the edit appends
  assert.ok(render(f, 100).join('\n').includes('alix'), `edit must accept text after ↵:\n${render(f, 100).join('\n')}`)
  // A printable key from the NAVIGATION state re-enters immediately with
  // the key delivered to the Input (search-box semantics).
  const g = new QuestionFlow([{ id: 'q1', question: 'Name?' }], () => {}, () => {})
  g.setMaxRows(24)
  render(g, 100)
  g.handleInput('abc')
  g.handleInput('\x1b') // navigation state
  g.handleInput('Z') // typing while navigating → straight into the edit
  const view = render(g, 100).join('\n')
  assert.ok(view.includes('abcZ'), `a typed key from navigation must re-enter the edit with the key:\n${view}`)
  assert.ok(view.includes('←→ edit'), `the hint must flip back to the edit after typing:\n${view}`)
  assert.equal(cancelled, 0, `typing must never cancel the flow`)
})

test('optionless question: Esc-back navigation reaches the previous question (P1 regression)', () => {
  // Q1 (choices) → Q2 (optionless) → review → ← back to Q2 → Esc leaves
  // the edit → ← pages back to Q1. Previously Esc on optionless Q2
  // cancelled the WHOLE flow, so the user could never keyboard back to
  // Q1 to fix an answer.
  let cancelled = 0
  const f = new QuestionFlow([
    { id: 'q1', question: 'First?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Second?' },
  ], () => {}, () => { cancelled += 1 })
  f.setMaxRows(24)
  render(f, 100)
  f.handleInput('1') // answer Q1 → Q2 (optionless, opens in edit mode)
  render(f, 100)
  f.handleInput('hello')
  f.handleInput('\r') // Enter commits Q2 → review page
  assert.ok(render(f, 100).join('\n').includes('Review your answer'), `precondition — review page:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x1b[D') // ← back to Q2 (drafts survive)
  let view = render(f, 100).join('\n')
  assert.ok(view.includes('Second?'), `← must return to Q2:\n${view}`)
  assert.ok(view.includes('←→ edit'), `Q2 must be in the edit layer after ← from review:\n${view}`)
  f.handleInput('\x1b') // Esc: leave Q2's edit (navigation layer)
  assert.equal(cancelled, 0, `Esc on Q2 edit must NOT cancel the flow: got ${cancelled}`)
  f.handleInput('\x1b[D') // ← pages back to Q1 (navigation layer)
  view = render(f, 100).join('\n')
  assert.ok(view.includes('First?'), `← from Q2 navigation must reach Q1:\n${view}`)
  assert.equal(cancelled, 0, `navigation must never cancel the flow: got ${cancelled}`)
})

test('edit mode hint is mode-specific: esc back everywhere in the edit, esc cancel in navigation', () => {
  // Choices + Other editing: esc BACK (leave the edit for the option list).
  const f = makeFlow([{ id: 'q1', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }], 24)
  enterOtherEdit(f, 2)
  const choicesEdit = render(f, 100).join('\n')
  assert.ok(choicesEdit.includes('←→ edit'), `edit hint must advertise ←→ edit:\n${choicesEdit}`)
  assert.ok(choicesEdit.includes('↵ confirm'), `edit hint must advertise ↵ confirm:\n${choicesEdit}`)
  assert.ok(choicesEdit.includes('esc back'), `choices edit hint must say esc back:\n${choicesEdit}`)
  assert.ok(!choicesEdit.includes('esc cancel'), `choices edit hint must not say esc cancel:\n${choicesEdit}`)
  assert.ok(!choicesEdit.includes('↑↓ select'), `edit hint must not advertise ↑↓ select:\n${choicesEdit}`)
  assert.ok(!choicesEdit.includes('1-2 choose'), `edit hint must not advertise digit choose:\n${choicesEdit}`)
  assert.ok(!choicesEdit.includes('↵ toggle'), `edit hint must not advertise ↵ toggle (Enter confirms custom text):\n${choicesEdit}`)
  assert.ok(!choicesEdit.includes('→ next'), `edit hint must not advertise → next:\n${choicesEdit}`)
  // Optionless EDIT layer: same esc back (leave the edit for the
  // navigation layer) — NOT esc cancel (that lives in navigation).
  const g = makeFlow([{ id: 'q1', question: 'Name?', options: [] }, { id: 'q2', question: 'Second?' }], 24)
  const optionless = render(g, 100).join('\n')
  assert.ok(optionless.includes('←→ edit'), `optionless edit hint must advertise ←→ edit:\n${optionless}`)
  assert.ok(optionless.includes('esc back'), `optionless edit hint must say esc back:\n${optionless}`)
  assert.ok(!optionless.includes('esc cancel'), `optionless edit hint must not say esc cancel:\n${optionless}`)
  // The optionless NAVIGATION layer (after Esc): ↵ re-enters the edit,
  // arrows page, esc cancels.
  g.handleInput('\x1b')
  const nav = render(g, 100).join('\n')
  assert.ok(nav.includes('↵ edit'), `navigation hint must advertise ↵ edit:\n${nav}`)
  assert.ok(nav.includes('← back · → skip'), `navigation hint must advertise the arrow verbs:\n${nav}`)
  assert.ok(nav.includes('esc cancel'), `navigation hint must advertise esc cancel:\n${nav}`)
  assert.ok(!nav.includes('←→ edit'), `navigation hint must not advertise ←→ edit:\n${nav}`)
  // List mode keeps its own hint (regression guard).
  const list = render(makeFlow([{ id: 'q1', question: 'Pick', options: [{ label: 'A' }] }], 24), 100).join('\n')
  assert.ok(list.includes('↑↓ select'), `list mode must keep ↑↓ select:\n${list}`)
  assert.ok(list.includes('↵ confirm'), `list mode must keep ↵ confirm:\n${list}`)
  assert.ok(list.includes('esc cancel'), `list mode must keep esc cancel:\n${list}`)
})

test('free-text input never leaks across questions (round-3 P1)', () => {
  // Q1 choices → Other edit commits 'abc' → advance to Q2 (choices) →
  // entering Q2's OTHER edit must start EMPTY, not show Q1's text.
  let done: unknown
  const f = new QuestionFlow([
    { id: 'q1', question: 'One?', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: 'Two?', options: [{ label: 'A' }, { label: 'B' }] },
  ], (answers) => { done = answers }, () => {})
  f.setMaxRows(24)
  render(f, 100)
  f.handleInput('\x1b[B'); f.handleInput('\x1b[B') // to Q1 OTHER row
  render(f, 100)
  f.handleInput('\r') // enter Q1 edit
  f.handleInput('abc')
  f.handleInput('\r') // commit → advance to Q2 (list)
  assert.ok(render(f, 100).join('\n').includes('Two?'), `precondition — Q2 shown:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x1b[B'); f.handleInput('\x1b[B') // to Q2 OTHER row
  render(f, 100)
  f.handleInput('\r') // enter Q2 edit
  const q2Edit = render(f, 100).join('\n')
  assert.ok(!q2Edit.includes('abc'), `Q2 edit must not show Q1's committed text:\n${q2Edit}`)
})

test('clearing a committed free-text answer is not resurrected by Esc→navigation→re-edit', () => {
  // An optionless question with a COMMITTED 'abc': revisit the edit,
  // clear it (Ctrl+A + Delete), Esc to navigation, re-enter with ↵ —
  // the deleted text must stay deleted (the shared Input's ownership is
  // tracked per question, not by value emptiness).
  const f = new QuestionFlow([
    { id: 'q1', question: 'One?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Two?' },
  ], () => {}, () => {})
  f.setMaxRows(24)
  render(f, 100)
  f.handleInput('1') // answer Q1 → Q2 (optionless, edit layer)
  f.handleInput('abc')
  f.handleInput('\r') // commit Q2 → review
  render(f, 100)
  f.handleInput('\x1b[D') // ← back to Q2
  assert.ok(render(f, 100).join('\n').includes('abc'), `precondition — committed text visible:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x01') // Ctrl+A (line start)
  f.handleInput('\x1b[3~') // Delete clears 'abc'
  assert.ok(!render(f, 100).join('\n').includes('abc'), `precondition — text cleared:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x1b') // Esc → navigation
  f.handleInput('\r') // ↵ re-enters the edit
  const reentered = render(f, 100).join('\n')
  assert.ok(!reentered.includes('abc'), `cleared text must not be resurrected:\n${reentered}`)
  // The SAME round trip still keeps genuine in-progress text.
  f.handleInput('xyz')
  f.handleInput('\x1b') // Esc → navigation
  f.handleInput('\r') // ↵ re-enter
  assert.ok(render(f, 100).join('\n').includes('xyz'), `in-progress text must survive the round trip:\n${render(f, 100).join('\n')}`)
})

test('free-text undo/yank history never leaks across questions', () => {
  // The free-text Input's undo stack and kill ring are PER-INSTANCE: a
  // cross-question ownership change must rebuild the Input (resetOtherInput),
  // so Ctrl+- (undo) / Ctrl+Y (yank) in a later question cannot resurrect
  // the previous question's editing history.
  const f = new QuestionFlow([
    { id: 'q1', question: 'One?', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: 'Two?', options: [{ label: 'A' }, { label: 'B' }] },
  ], () => {}, () => {})
  f.setMaxRows(24)
  render(f, 100)
  // Q1 OTHER: type abc, Backspace → 'ab', commit → advance to Q2.
  f.handleInput('\x1b[B'); f.handleInput('\x1b[B')
  render(f, 100)
  f.handleInput('\r') // enter Q1 edit
  f.handleInput('abc')
  f.handleInput('\x7f') // backspace → 'ab'
  f.handleInput('\r') // commit → Q2 (list)
  render(f, 100)
  f.handleInput('\x1b[B'); f.handleInput('\x1b[B')
  render(f, 100)
  f.handleInput('\r') // enter Q2 edit (seeded empty)
  assert.ok(!render(f, 100).join('\n').includes('ab'), `precondition — Q2 edit blank:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x1f') // Ctrl+- undo
  assert.ok(!render(f, 100).join('\n').includes('ab'), `undo must not resurrect Q1's text:\n${render(f, 100).join('\n')}`)
  f.handleInput('\x19') // Ctrl+Y yank
  assert.ok(!render(f, 100).join('\n').includes('ab'), `yank must not paste Q1's killed history:\n${render(f, 100).join('\n')}`)
})

test('optionless navigation: h and l are TEXT, not vim page aliases', () => {
  // Typing 'h'/'l' from the navigation state must re-enter the edit with
  // the letter — never page back (h) or skip-and-advance (l). The vim
  // aliases stay LIST-mode conveniences only (the review page has no
  // input to steal from and keeps h).
  let done: unknown
  const f = new QuestionFlow([
    { id: 'q1', question: 'First?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Second?' },
  ], (answers) => { done = answers }, () => {})
  f.setMaxRows(24)
  render(f, 100)
  f.handleInput('1') // answer Q1 → Q2 (optionless, edit layer)
  render(f, 100)
  f.handleInput('abc')
  f.handleInput('\x1b') // → navigation state
  f.handleInput('h') // 'h' must be text, NOT ← back
  let view = render(f, 100).join('\n')
  assert.ok(view.includes('abch'), `h must append to the edit:\n${view}`)
  assert.ok(view.includes('←→ edit'), `h must re-enter the edit layer:\n${view}`)
  assert.ok(!view.includes('First?'), `h must not page back to Q1:\n${view}`)
  f.handleInput('\x1b') // → navigation again
  f.handleInput('l') // 'l' must be text, NOT → skip
  view = render(f, 100).join('\n')
  assert.ok(view.includes('abchl'), `l must append to the edit:\n${view}`)
  assert.ok(view.includes('←→ edit'), `l must re-enter the edit layer:\n${view}`)
  assert.ok(!view.includes('Review your answer'), `l must not skip-and-advance:\n${view}`)
  assert.ok(done === undefined, `l must not submit anything`)
  // The physical arrows still page from the navigation layer.
  f.handleInput('\x1b')
  f.handleInput('\x1b[D') // ← pages back to Q1
  assert.ok(render(f, 100).join('\n').includes('First?'), `← must still page back:\n${render(f, 100).join('\n')}`)
})

test('optionless navigation: physical ↑/↓ stay no-ops, j/k are text', () => {
  const f = makeFlow([{ id: 'q1', question: 'Name?' }], 24)
  render(f, 100)
  f.handleInput('abc')
  f.handleInput('\x1b') // navigation state
  f.handleInput('\x1b[A') // physical ↑ — no-op, stays in navigation
  let view = render(f, 100).join('\n')
  assert.ok(view.includes('↵ edit'), `↑ must stay in the navigation layer:\n${view}`)
  assert.ok(!view.includes('←→ edit'), `↑ must not bounce into the edit:\n${view}`)
  f.handleInput('\x1b[B') // physical ↓ — no-op
  view = render(f, 100).join('\n')
  assert.ok(view.includes('↵ edit'), `↓ must stay in the navigation layer:\n${view}`)
  f.handleInput('j') // 'j' IS text
  view = render(f, 100).join('\n')
  assert.ok(view.includes('abcj'), `j must append to the edit:\n${view}`)
  assert.ok(view.includes('←→ edit'), `j must re-enter the edit layer:\n${view}`)
})

test('skip invalidates the free-text Input owner (no stale text beside (skipped))', () => {
  // Q1 (optionless) has uncommitted 'abc' in the Input; → skip advances.
  // Returning to Q1 must re-seed from the CLEARED draft — the (skipped)
  // row must never show stale 'abc' next to it (the Input instance and
  // ownership survive the skip otherwise, because Q2 never touches it).
  const f = new QuestionFlow([
    { id: 'q1', question: 'First?' },
    { id: 'q2', question: 'Second?', options: [{ label: 'A' }] },
  ], () => {}, () => {})
  f.setMaxRows(24)
  render(f, 100)
  f.handleInput('abc') // Q1 edit (uncommitted)
  f.handleInput('\x1b') // navigation state
  f.handleInput('\x1b[C') // → skip Q1 → Q2 (choices list)
  let view = render(f, 100).join('\n')
  assert.ok(view.includes('Second?'), `precondition — Q2 shown:\n${view}`)
  f.handleInput('\x1b[D') // ← back to Q1
  view = render(f, 100).join('\n')
  assert.ok(view.includes('First?'), `← must return to Q1:\n${view}`)
  assert.ok(view.includes('(skipped)'), `Q1 must stay skipped:\n${view}`)
  assert.ok(!view.includes('abc'), `the stale Input text must not show beside (skipped):\n${view}`)
  // The skip ALSO cleared the draft: committing empty then re-entering
  // still shows nothing stale.
  f.handleInput('\x1b') // Q1 navigation (re-entered from Q2)
  f.handleInput('\r') // ↵ re-enter the edit
  view = render(f, 100).join('\n')
  assert.ok(!view.includes('abc'), `re-entering the edit must not resurrect the skipped text:\n${view}`)
})

test('uncommitted edit is dropped on a real tab change regardless of the next question type', () => {
  // Contract: in-progress free-text survives ONLY an Esc → navigation →
  // ↵ round trip on the SAME question. Once the user actually pages to
  // another question (←/→/skip/commit-advance), the uncommitted edit is
  // dropped and re-entry reseeds from the committed draft — the outcome
  // must NOT depend on whether the intermediate question itself uses the
  // free-text Input (round finding: a choices stopover used to leave the
  // old owner alive, so the text survived only for that path).
  const scenarios: Array<{ label: string; second: QuestionFlowQuestion }> = [
    { label: 'choices stopover', second: { id: 'q2', question: 'Second?', options: [{ label: 'B' }] } },
    { label: 'optionless stopover', second: { id: 'q2', question: 'Second?' } },
  ]
  for (const scenario of scenarios) {
    const f = new QuestionFlow([
      { id: 'q1', question: 'First?' },
      scenario.second,
    ], () => {}, () => {})
    f.setMaxRows(24)
    render(f, 100)
    f.handleInput('abc') // Q1 uncommitted
    f.handleInput('\r') // commit → advance to Q2
    assert.ok(render(f, 100).join('\n').includes('Second?'), `${scenario.label} — precondition Q2 shown`)
    // ← back to Q1 (an optionless Q2 sits in its EDIT layer, where ← is
    // the text cursor — leave it for the navigation layer first).
    if (scenario.second.options === undefined) f.handleInput('\x1b')
    f.handleInput('\x1b[D')
    render(f, 100)
    f.handleInput('X') // edit the committed draft: abcX (uncommitted)
    assert.ok(render(f, 100).join('\n').includes('abcX'), `${scenario.label} — precondition abcX typed:\n${render(f, 100).join('\n')}`)
    f.handleInput('\x1b') // Esc → navigation (Q1)
    f.handleInput('\x1b[C') // → moves to Q2 (REAL tab change)
    render(f, 100)
    // ← back to Q1 (leave Q2's layer accordingly).
    if (scenario.second.options === undefined) f.handleInput('\x1b')
    f.handleInput('\x1b[D')
    const back = render(f, 100).join('\n')
    assert.ok(back.includes('abc'), `${scenario.label} — the committed draft survives the trip:\n${back}`)
    assert.ok(!back.includes('abcX'), `${scenario.label} — the uncommitted X must be dropped on a REAL tab change:\n${back}`)
  }
})

test('free-text row click enters edit and positions the cursor (mouse parity)', () => {
  const f = new QuestionFlow([
    { id: 'q1', question: 'Pick or type', options: [{ label: 'A' }, { label: 'B' }] },
  ], () => {}, () => {})
  f.setMaxRows(24)
  let rendered = f.render(100)
  const otherRow = rendered.findIndex(line => line.includes('Type something.'))
  assert.ok(otherRow >= 0, 'free-text row missing')
  // Click the free-text row → enters edit mode (an EMPTY input still
  // renders the dimmed row label, so prove the mode by typing).
  f.clickRow(otherRow, 5)
  f.handleInput('h')
  rendered = f.render(100)
  assert.ok(rendered.some(line => line.includes('h')), 'click must enter edit mode (typed text renders)')
  // Type the rest of "hello".
  for (const ch of 'ello') f.handleInput(ch)
  rendered = f.render(100)
  assert.ok(rendered.some(line => line.includes('hello')), 'typed text must render')
  // Click between e and l: the x must be derived from the ACTUAL painted
  // value cells (the prefix is "→ [ ] " = 6 columns; the Input has an
  // EMPTY prompt, so its local column 0 IS the first painted value
  // cell). Value column 2 (between e and l) is at flow-local x = 8.
  f.clickRow(otherRow, 8)
  f.handleInput('X')
  rendered = f.render(100).map(strip)
  assert.ok(rendered.some(line => line.includes('heXllo')), 'typing after the click must insert at the clicked column')
})

test('scrolled free-text row click still maps to the OTHER row (mouse parity)', () => {
  const f = new QuestionFlow([
    { id: 'q1', question: 'Long question', options: Array.from({ length: 20 }, (_, i) => ({ label: `Option ${i}` })) },
  ], () => {}, () => {})
  f.setMaxRows(8)
  // Walk the cursor down to the free-text row (20 options + the OTHER row
  // = 21 rows; the cursor starts at 0, so 20 downs land on the OTHER row);
  // the scrollport follows.
  for (let i = 0; i < 20; i += 1) f.handleInput('\x1b[B')
  const rendered = f.render(100)
  const otherRow = rendered.findIndex(line => line.includes('Type something.'))
  assert.ok(otherRow >= 0, 'free-text row must be visible after scrolling')
  f.clickRow(otherRow, 5)
  f.handleInput('h')
  const after = f.render(100)
  assert.ok(after.some(line => line.includes('h')), 'click must enter edit mode after scroll')
})

test('masked free-text click moves the real cursor while the render stays masked (mouse parity)', () => {
  const f = new QuestionFlow([
    { id: 'q1', question: 'Secret', masked: true, options: [{ label: 'A' }] },
  ], () => {}, () => {})
  f.setMaxRows(24)
  let rendered = f.render(100)
  const otherRow = rendered.findIndex(line => line.includes('Type something.'))
  assert.ok(otherRow >= 0, 'free-text row missing')
  f.clickRow(otherRow, 5) // enter edit
  for (const ch of 'hello') f.handleInput(ch)
  rendered = f.render(100)
  assert.ok(rendered.some(line => line.includes('•••••')), 'masked render must show one bullet per character')
  assert.ok(!rendered.some(line => line.includes('hello')), 'the secret must never render')
  // Click between e and l (flow-local x = 6 prefix + 2 value columns = 8)
  // and type X.
  f.clickRow(otherRow, 8)
  f.handleInput('X')
  rendered = f.render(100)
  assert.ok(rendered.some(line => line.includes('••••••')), 'the real value must grow to 6 characters')
  assert.ok(!rendered.some(line => line.includes('hello')), 'the secret must stay masked')
})

test('optionless pinned free-text row click positions the cursor (mouse parity)', () => {
  const f = new QuestionFlow([
    { id: 'q1', question: 'Type your answer' },
  ], () => {}, () => {})
  f.setMaxRows(24)
  // The optionless flow edits from the start: type "hello".
  for (const ch of 'hello') f.handleInput(ch)
  const rendered = f.render(100)
  // The exact pinned row recorded by the render (not a text search).
  const pinnedRow = (f as unknown as { pinnedOtherRow: number }).pinnedOtherRow
  assert.ok(pinnedRow >= 0, 'pinned input row must be recorded')
  assert.ok(rendered[pinnedRow]?.includes('hello'), `pinned input row missing:\n${rendered.join('\n')}`)
  // The pinned row is " hello" (no pointer/marker prefix): the value
  // starts at row col 1, so value column 2 (between e and l) is at row
  // col 3 and the Input-local x = 3 + 1 = 4.
  f.clickRow(pinnedRow, 3)
  f.handleInput('X')
  const after = f.render(100).map(strip)
  assert.ok(after.some(line => line.includes('heXllo')), 'typing after the pinned-row click must insert at the clicked column')
})

test('optionless pinned row click re-enters edit from navigation state (mouse parity)', () => {
  const f = new QuestionFlow([
    { id: 'q1', question: 'Type your answer' },
  ], () => {}, () => {})
  f.setMaxRows(24)
  for (const ch of 'hello') f.handleInput(ch)
  f.handleInput('\x1b') // Esc: leave the edit → navigation state
  let rendered = f.render(100)
  assert.ok(rendered.some(line => line.includes('↵ edit')), 'the navigation hint must show after Esc')
  const pinnedRow = (f as unknown as { pinnedOtherRow: number }).pinnedOtherRow
  assert.ok(pinnedRow >= 0, 'pinned input row must be recorded')
  f.clickRow(pinnedRow, 1)
  rendered = f.render(100)
  assert.ok(rendered.some(line => line.includes('↵ confirm')), 'clicking the pinned row must re-enter edit mode')
  assert.ok(rendered.some(line => line.includes('hello')), 'the draft must be preserved across the re-entry')
})

test('masked CJK click maps to the grapheme boundary (mouse parity)', () => {
  const f = new QuestionFlow([
    { id: 'q1', question: 'Secret', masked: true, options: [{ label: 'A' }] },
  ], () => {}, () => {})
  f.setMaxRows(24)
  let rendered = f.render(100)
  const otherRow = rendered.findIndex(line => line.includes('Type something.'))
  assert.ok(otherRow >= 0, 'free-text row missing')
  f.clickRow(otherRow, 5) // enter edit
  for (const ch of '界a') f.handleInput(ch)
  rendered = f.render(100)
  assert.ok(rendered.some(line => line.includes('••')), 'masked render must show one bullet per grapheme')
  assert.ok(!rendered.some(line => line.includes('界')), 'the secret must never render')
  // Click between the two graphemes (flow-local x = 6 prefix + 1) and
  // type X: the value must become 界Xa (never X界a or a split UTF-16
  // sequence).
  f.clickRow(otherRow, 7)
  f.handleInput('X')
  const input = (f as unknown as { otherInput: { getValue(): string } }).otherInput
  assert.equal(input.getValue(), '界Xa', 'the cursor must land between the graphemes')
  rendered = f.render(100)
  assert.ok(rendered.some(line => line.includes('•••')), 'the mask must grow to 3 bullets')
  assert.ok(!rendered.some(line => line.includes('界')), 'the secret must stay masked')
})

test('masked emoji click never splits a ZWJ grapheme (mouse parity)', () => {
  const f = new QuestionFlow([
    { id: 'q1', question: 'Secret', masked: true, options: [{ label: 'A' }] },
  ], () => {}, () => {})
  f.setMaxRows(24)
  let rendered = f.render(100)
  const otherRow = rendered.findIndex(line => line.includes('Type something.'))
  assert.ok(otherRow >= 0, 'free-text row missing')
  f.clickRow(otherRow, 5) // enter edit
  for (const ch of '👨‍💻a') f.handleInput(ch)
  rendered = f.render(100)
  assert.ok(rendered.some(line => line.includes('••')), 'one bullet per grapheme (a ZWJ sequence is ONE)')
  assert.ok(!rendered.some(line => line.includes('👨')), 'the secret must never render')
  // Click the second mask position (between the ZWJ grapheme and a) and
  // type X: the cursor must land AFTER the whole ZWJ sequence.
  f.clickRow(otherRow, 7)
  f.handleInput('X')
  const input = (f as unknown as { otherInput: { getValue(): string } }).otherInput
  assert.equal(input.getValue(), '👨‍💻Xa', 'the cursor must land after the ZWJ grapheme')
})

test('question: press → keyboard advance → release must not activate the next question (mouse parity)', () => {
  const f = new QuestionFlow([
    { id: 'q1', question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: 'Q2', options: [{ label: 'C' }, { label: 'D' }] },
  ], () => {}, () => {})
  f.setMaxRows(24)
  let rendered = f.render(100).map(strip)
  const rowA = rendered.findIndex(line => line.includes('[1] A'))
  assert.ok(rowA >= 0, 'option A row missing')
  // Press Q1/A: the press-time identity is Q1 + option A.
  const gesture = f.beginMousePress(rowA)
  assert.ok(gesture !== undefined, 'a press on an option must record a gesture')
  // Keyboard Enter advances to Q2.
  f.handleInput('\r')
  rendered = f.render(100).map(strip)
  const rowC = rendered.findIndex(line => line.includes('[1] C'))
  assert.ok(rowC >= 0, 'option C row missing')
  // Release on the SAME row: Q2/C must not activate (question id changed).
  f.completeMouseClick(gesture, rowC)
  rendered = f.render(100).map(strip)
  assert.ok(rendered.some(line => line.includes('?  Q2')), 'the flow must still be on Q2')
})

test('question: press option A → repaint moves B onto the cell → release must not activate B (mouse parity)', () => {
  const f = new QuestionFlow([
    { id: 'q1', question: 'Q1', options: Array.from({ length: 12 }, (_, i) => ({ label: `Option ${i}` })) },
  ], () => {}, () => {})
  f.setMaxRows(8)
  let rendered = f.render(100).map(strip)
  const rowA = rendered.findIndex(line => line.includes('Option 0'))
  assert.ok(rowA >= 0, 'option 0 row missing')
  // Press option 0.
  const gesture = f.beginMousePress(rowA)
  assert.ok(gesture !== undefined)
  // Keyboard scrolls the page: option 0 moves off, another option moves
  // onto the pressed cell.
  for (let i = 0; i < 4; i += 1) f.handleInput('\x1b[B')
  rendered = f.render(100).map(strip)
  const now = rendered[rowA] ?? ''
  assert.ok(!now.includes('Option 0'), `the pressed cell must now show a different option:\n${rendered.join('\n')}`)
  // Release on the same cell: the repainted option must not activate.
  f.completeMouseClick(gesture, rowA)
  // The flow must still be on Q1 (not advanced to Q2/submit): the tab
  // strip still shows Q1 unanswered.
  rendered = f.render(100).map(strip)
  assert.ok(rendered.some(line => line.includes('○ Q1')), 'the flow must still be on Q1')
})

test('question: inert press replaces the stale gesture (mouse parity)', () => {
  const f = new QuestionFlow([
    { id: 'q1', question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
  ], () => {}, () => {})
  f.setMaxRows(24)
  let rendered = f.render(100).map(strip)
  const rowA = rendered.findIndex(line => line.includes('[1] A'))
  const headerRow = rendered.findIndex(line => line.includes('?  Q1'))
  assert.ok(rowA >= 0 && headerRow >= 0, 'option/header rows missing')
  // Press option A.
  f.beginMousePress(rowA)
  // A NEW press on inert chrome replaces the gesture (the stale A
  // identity must not survive).
  const inertGesture = f.beginMousePress(headerRow)
  assert.ok(inertGesture !== undefined && inertGesture.hit === undefined, 'inert chrome must record an undefined hit')
  // Release on the inert cell: nothing may activate.
  f.completeMouseClick(inertGesture, headerRow)
  rendered = f.render(100).map(strip)
  assert.ok(rendered.some(line => line.includes('?  Q1')), 'the flow must still be on Q1')
})

test('question: inert press → repaint moves the marker onto the cell → release must not toggle (mouse parity)', () => {
  const f = new QuestionFlow([
    { id: 'q1', question: 'Q1', header: 'A header', options: Array.from({ length: 20 }, (_, i) => ({ label: `Option ${i}` })) },
  ], () => {}, () => {})
  f.setMaxRows(8)
  let rendered = f.render(100).map(strip)
  // Row 6 is inert (blank) at maxRows 8; the marker sits at row 5.
  const row = 6
  assert.equal((f as unknown as { hitMap: Map<number, string | undefined> }).hitMap.get(row), undefined, 'row 6 must be inert at maxRows 8')
  // Press the inert row: the press-time identity is undefined chrome.
  const gesture = f.beginMousePress(row)
  assert.ok(gesture !== undefined && gesture.hit === undefined, 'an inert press must record an undefined hit')
  // The budget changes: the marker moves onto row 6.
  f.setMaxRows(9)
  rendered = f.render(100).map(strip)
  assert.equal((f as unknown as { lastMarkerRow: number }).lastMarkerRow, row, 'the marker must move onto the pressed row')
  // Release on the same cell: the inert press must NOT toggle the
  // expanded panel (the marker is a DIFFERENT semantic target).
  const state = f as unknown as { bodyExpanded: boolean }
  const before = state.bodyExpanded
  f.completeMouseClick(gesture, row)
  assert.equal(state.bodyExpanded, before, 'the inert press must not toggle the expanded panel')
})

test('masked review keeps the grapheme mask (mouse parity)', () => {
  const f = new QuestionFlow([
    { id: 'q1', question: 'Secret', masked: true, options: [{ label: 'A' }] },
  ], () => {}, () => {})
  f.setMaxRows(24)
  let rendered = f.render(100).map(strip)
  const otherRow = rendered.findIndex(line => line.includes('Type something.'))
  assert.ok(otherRow >= 0, 'free-text row missing')
  f.clickRow(otherRow, 5) // enter edit
  for (const ch of '👨‍💻a') f.handleInput(ch)
  rendered = f.render(100).map(strip)
  assert.ok(rendered.some(line => line.includes('••')), 'editing must show one bullet per grapheme')
  f.handleInput('\r') // commit → review
  rendered = f.render(100).map(strip)
  assert.ok(rendered.some(line => line.includes('  ••')), 'review must show ONE bullet per grapheme (2 for 👨‍💻a, never 6 UTF-16 units)')
  assert.ok(!rendered.some(line => line.includes('••••••')), 'review must not use UTF-16 length')
  assert.ok(!rendered.some(line => line.includes('👨')), 'the secret must never render on review')
})

test('masked multiSelect review never shows the custom plaintext (mouse parity)', () => {
  const f = new QuestionFlow([
    { id: 'q1', question: 'Secret', masked: true, multiSelect: true, options: [{ label: 'A' }] },
  ], () => {}, () => {})
  f.setMaxRows(24)
  f.handleInput('1') // select A
  let rendered = f.render(100).map(strip)
  const otherRow = rendered.findIndex(line => line.includes('Type something.'))
  assert.ok(otherRow >= 0, 'free-text row missing')
  f.clickRow(otherRow, 5) // enter edit
  for (const ch of 'secret') f.handleInput(ch)
  f.handleInput('\r') // commit → review
  rendered = f.render(100).map(strip)
  assert.ok(rendered.some(line => line.includes('A + ••••••')), 'review must mask the custom beside the selection')
  assert.ok(!rendered.some(line => line.includes('secret')), 'the secret must never render on review')
})
