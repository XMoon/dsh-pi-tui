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
  assert.ok(lines.join('\n').includes('→'), `pointer missing after cursor move:\n${lines.join('\n')}`)
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
        assert.ok(lines.join('\n').includes('→'), `pointer missing at step ${step}:\n${lines.join('\n')}`)
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
    f.handleInput('s') // skip q1
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
