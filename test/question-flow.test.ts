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
      assertPage(render(f, width), budget, width, 'Type your answer', { hint: 'esc cancel' })
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

test('text-mode → with an empty input never wipes an existing selection', () => {
  // Regression for the arrow-key move-on invariant: entering the "Type
  // something." row and pressing → with EMPTY text used to set skipped=true,
  // and the skipped mark wins at submit (returns selected: []) — the
  // selection was silently destroyed. An answered draft must survive.
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
  f.handleInput('\x1b[C') // → with EMPTY text: must NOT wipe the selection
  const review = render(f, 100).join('\n')
  assert.ok(review.includes('Submit'), `→ must reach the review page:\n${review}`)
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
  // Cursor onto "Type something." (last row), enter text mode, → empty.
  g.handleInput('\x1b[B')
  g.handleInput('\x1b[B')
  render(g, 100)
  g.handleInput('\r')
  render(g, 100)
  g.handleInput('\x1b[C') // → with EMPTY text on the answered multi-select
  // Single-question flow: commitOther advances straight to the review page.
  const review2 = render(g, 100).join('\n')
  assert.ok(review2.includes('Submit'), `→ must reach the review page:\n${review2}`)
  assert.ok(!review2.includes('(skipped)'), `the multi-select answer must not become (skipped):\n${review2}`)
  g.handleInput('\r') // submit
  assert.deepEqual(done2, [{ id: 'q1', selected: ['X'] }])
})

test('review page: ↑↓ choose the action, ← goes back to the last question', () => {
  // The review highlight moved from ←/→ to ↑↓ (kimi's question dialog);
  // ← is now the back verb (replacing the old 'b' key).
  let cancelled = 0
  const f = new QuestionFlow([
    { id: 'q1', question: 'One?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Two?', options: [{ label: 'B' }] },
  ], () => {}, () => { cancelled += 1 })
  f.setMaxRows(24)
  render(f, 100)
  f.handleInput('1') // answer q1 → q2
  render(f, 100)
  f.handleInput('1') // answer q2 → review
  let review = render(f, 100).join('\n')
  assert.ok(review.includes('Submit'), `review page missing:\n${review}`)
  // ↓ moves the highlight to Cancel; Enter then cancels the flow.
  f.handleInput('\x1b[B')
  review = render(f, 100).join('\n')
  assert.ok(review.includes('Cancel'), `Cancel must be reachable:\n${review}`)
  f.handleInput('\r')
  assert.equal(cancelled, 1, `↓ + Enter must cancel`)
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

test('→ in text mode commits the typed answer (empty counts as skipped)', () => {
  // Text mode (optionless): → is the same "move on" verb — it commits the
  // typed text and advances; an empty input counts as skipped (Enter parity).
  let done: unknown
  const f = new QuestionFlow([
    { id: 'q1', question: 'Name?' },
    { id: 'q2', question: 'Second?', options: [{ label: 'B' }] },
  ], (answers) => { done = answers }, () => {})
  f.setMaxRows(24)
  render(f, 100)
  f.handleInput('alice')
  f.handleInput('\x1b[C') // → commits the typed answer
  assert.ok(render(f, 100).join('\n').includes('Second?'), `→ must advance from text mode:\n${render(f, 100).join('\n')}`)
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
  // Text mode commits on → (empty = skipped), so the verb is '→ next' there.
  const g = makeFlow([{ id: 'q1', question: 'Your name?' }], 24)
  const textMode = render(g, 100).join('\n')
  assert.ok(textMode.includes('→ next'), `text-mode hint must advertise → next:\n${textMode}`)
  assert.ok(!textMode.includes('→ skip'), `text-mode hint must not say → skip:\n${textMode}`)
  f.handleInput('1')
  render(f, 100)
  f.handleInput('1') // → review
  const review = render(f, 100).join('\n')
  assert.ok(review.includes('↑↓ choose · ← back'), `review hint must advertise ↑↓ choose · ← back:\n${review}`)
  assert.ok(!review.includes('b back'), `the old 'b back' verb must be gone:\n${review}`)
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
