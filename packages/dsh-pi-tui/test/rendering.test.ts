/**
 * Headless tests for the P5c rendering features: diff colorization, LaTeX
 * in assistant markdown, the todo panel, the thinking hide toggle,
 * user-questions dialogs, and fullscreen scrollback search.
 * @module @xmoon76/dsh-pi-tui/rendering.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { isDiffResult, renderDiffLine } from '../src/diff.ts'
import {
  foldedCallPreview, genericRawInputLines, parseReadEnvelopes, resultTextLines, toolPresenterFrom, webCardLines,
} from '../src/present.ts'
import { color, currentPalette, darkColors, lightColors, setTheme } from '../src/theme.ts'
import { TuiApp, BulletedComponent } from '../src/tui-app.ts'
import { WorkingIndicator } from '../src/working.ts'
import { Text, type Terminal } from '@xmoon76/pi-tui'
import { VirtualTerminal } from './virtual-terminal.ts'

// CI/tooling environments export NO_COLOR, FORCE_COLOR=0 and CI=true, which
// themeOptOut() honours by skipping terminal queries entirely — that would
// silently turn every autodetect test into a no-op assertion. Clear all
// three for this suite (the tests inject terminal replies, so the opt-out
// would only mask the code paths under test).
process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

function startApp(width = 100, height = 24): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(width, height)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app }
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

test('diff detection and line colorization', () => {
  assert.equal(isDiffResult('edit', 'plain'), true)
  assert.equal(isDiffResult('apply_patch', 'plain'), true)
  assert.equal(isDiffResult('bash', 'diff --git a/x b/x\n@@ -1 +1 @@'), true)
  assert.equal(isDiffResult('bash', 'just output'), false)
  assert.equal(renderDiffLine('+added'), color.success('+added'))
  assert.equal(renderDiffLine('-removed'), color.error('-removed'))
  assert.equal(renderDiffLine('@@ -1,3 +1,3 @@'), color.textDim('@@ -1,3 +1,3 @@'))
  assert.equal(renderDiffLine('+++ b/x'), color.textDim('+++ b/x'))
  assert.equal(renderDiffLine(' context'), ' context')
})

test('latex renders inside assistant markdown', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'assistant', turn: 0, text: 'Energy $E=mc^2$ rules' }])
  const view = await viewport(vt)
  assert.ok(view.includes('²'), `latex not rendered:\n${view}`)
})

test('ctrl+t toggles the todo panel with markers', async () => {
  const { vt, app } = startApp()
  app.setTodoSummary([
    { content: 'fix tests', status: 'in_progress' },
    { content: 'ship it', status: 'pending' },
    { content: 'done thing', status: 'completed' },
  ])
  let view = await viewport(vt)
  assert.ok(!view.includes('Todo'), `panel visible by default:\n${view}`)
  vt.sendInput('\x14') // ctrl+t
  view = await viewport(vt)
  assert.ok(view.includes('Todo'), `panel title missing:\n${view}`)
  // Only the first active item shows in the header; the rest prove the panel.
  assert.ok(view.includes('ship it'), `pending row missing:\n${view}`)
  assert.ok(view.includes('done thing'), `completed row missing:\n${view}`)
  vt.sendInput('\x14')
  view = await viewport(vt)
  assert.ok(!view.includes('Todo'), `panel still visible:\n${view}`)
})

test('alt+t hides thinking entries', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'thinking', turn: 0, text: 'secret reasoning' }])
  let view = await viewport(vt)
  assert.ok(view.includes('secret reasoning'), `thinking missing:\n${view}`)
  vt.sendInput('\x1bt') // alt+t
  view = await viewport(vt)
  assert.ok(!view.includes('secret reasoning'), `thinking not hidden:\n${view}`)
  assert.equal(app.isThinkingHidden(), true)
  vt.sendInput('\x1bt')
  view = await viewport(vt)
  assert.ok(view.includes('secret reasoning'), `thinking not restored:\n${view}`)
})

test('askQuestions collects a single selection', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Continue?',
    options: [{ label: 'Yes' }, { label: 'No' }],
  }])
  let view = await viewport(vt)
  assert.ok(view.includes('Continue?'), `question missing:\n${view}`)
  assert.ok(view.includes('[1] Yes'), `option missing:\n${view}`)
  vt.sendInput('2')
  await viewport(vt)
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['No'] }])
})

test('question dialog wraps long text, keeps descriptions on their own lines, and never ellipsizes', async () => {
  const { vt, app } = startApp()
  const longQuestion = 'AGENTS.md 硬规则「fire-and-forget 走 runDetached,禁止裸 void」与现状存在分歧,如何解决?这一句非常长,必须换行显示而不能被对话框截断。'
  const promise = app.askQuestions([{
    id: 'q1',
    question: longQuestion,
    options: [{ label: '方案 3:新增 runOwned', description: '新增 runOwned(label, task, { onResult, onCancel, onError }) 用于 result-consuming 主流程,这段描述同样很长需要换行' }],
  }])
  const view = await viewport(vt)
  // The full question text must be visible (wrapped, never ellipsized).
  assert.ok(view.includes('对话框截断'), `question text truncated:\n${view}`)
  assert.ok(!view.includes('…'), `question dialog ellipsized content:\n${view}`)
  // The description renders on its own wrapped line, not crammed after the label.
  const lines = view.split('\n')
  const labelIdx = lines.findIndex(line => line.includes('方案 3:新增 runOwned'))
  assert.ok(labelIdx >= 0, `option label missing:\n${view}`)
  assert.ok(lines[labelIdx + 1]?.includes('新增 runOwned(label'), `description not on its own line:\n${view}`)
  assert.ok(!lines[labelIdx]!.includes('result-consuming 主流程'), `description crammed on the label row:\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('question dialog tabs align with the box border and the hint fits the width', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{ id: 'q1', question: 'Pick', options: [{ label: 'A' }] }])
  const view = await viewport(vt)
  const lines = view.split('\n')
  // The tab strip is the first content row of the overlay: the border column
  // must be followed by the mark directly (the previous build's stray leading
  // space inside the box made the box look misaligned). The overlay is
  // centered, so strip the outer margin first.
  const tabIdx = lines.findIndex(line => line.includes('Q1'))
  assert.ok(tabIdx >= 0, `tab strip missing:\n${view}`)
  const trimmedTab = lines[tabIdx]!.trimStart()
  assert.ok(trimmedTab.startsWith('│ '), `tab row lost its border:\n${view}`)
  // The frame adds exactly ONE padding cell; a second space means the tab
  // strip content itself starts with a stray space (the old misalignment).
  assert.ok(!trimmedTab.startsWith('│  '), `tab strip has a stray leading space:\n${view}`)
  // The hint must not be ellipsized.
  const hintIdx = lines.findIndex(line => line.includes('esc cancel'))
  assert.ok(hintIdx >= 0 && !lines[hintIdx]!.includes('…'), `hint truncated:\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('question dialog docks in the editor seat at full width above the footer', async () => {
  // Issue #3 follow-up: the dialog used to be a centered 85%-wide × 26-row
  // modal that covered the whole transcript on common terminals. It now
  // spans the full terminal width and sits in the EDITOR SEAT (kimi's
  // mountEditorReplacement), with the footer (status line) still visible
  // BELOW it.
  const { vt, app } = startApp(160)
  app.setStatus({ model: 'my-model', cwd: 'c' })
  const promise = app.askQuestions([{ id: 'q1', question: 'Pick', options: [{ label: 'A' }] }])
  const view = await viewport(vt)
  const lines = view.split('\n')
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const qIdx = lines.findIndex(line => strip(line).includes('Pick'))
  assert.ok(qIdx >= 0, `question missing:\n${view}`)
  let topIdx = -1
  let bottomIdx = -1
  for (let i = qIdx; i >= 0; i--) {
    const s = strip(lines[i] ?? '')
    if (s.includes('╭') && s.includes('╮')) { topIdx = i; break }
  }
  for (let i = qIdx; i < lines.length; i++) {
    const s = strip(lines[i] ?? '')
    if (s.includes('╰') && s.includes('╯')) { bottomIdx = i; break }
  }
  assert.ok(topIdx >= 0 && bottomIdx >= 0, `question frame missing:\n${view}`)
  // Full width: the border spans all 160 columns.
  const top = strip(lines[topIdx]!)
  assert.equal(top.lastIndexOf('╮') - top.indexOf('╭') + 1, 160, `frame must span the full 160 cols:\n${view}`)
  // The dialog is docked at the bottom, not centered: its bottom border sits
  // immediately above the footer's first row.
  const footerIdx = lines.findIndex(line => strip(line).includes('my-model'))
  assert.ok(footerIdx >= 0, `footer missing:\n${view}`)
  assert.equal(bottomIdx + 1, footerIdx, `dialog bottom border must sit directly above the footer:\n${view}`)
  assert.ok(topIdx > 0, `dialog must not start at row 0 (docked, not centered):\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

/** Measure the question frame's span (bottom border row - top border row + 1).
 * The question frame is the BOTTOM-MOST frame in the viewport (the editor
 * seat sits above the footer); frames above it (welcome card, header) are
 * ignored. Returns -1 when no frame is found. */
function questionFrameSpan(view: string): number {
  const lines = view.split('\n')
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let top = -1
  let bottom = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = strip(lines[i] ?? '')
    if (bottom === -1 && s.includes('╰') && s.includes('╯')) bottom = i
    if (top === -1 && s.includes('╭') && s.includes('╮')) top = i
    if (top !== -1 && bottom !== -1) break
  }
  return top >= 0 && bottom >= 0 ? bottom - top + 1 : -1
}

test('the question dialog height cap tracks the terminal height', async () => {
  // The cap is 60% of the terminal height (8..24 content rows + 2 borders).
  // The fixture must FILL the budget (7 long-description options), and the
  // assertion measures the question frame's ACTUAL span — a short question
  // renders fewer rows and proves nothing about the cap.
  const cases: Array<[number, number]> = [[16, 10], [24, 14], [40, 24], [60, 26]]
  for (const [rows, maxSpan] of cases) {
    const vt = new VirtualTerminal(100, rows)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
    app.start()
    const promise = app.askQuestions([{
      id: 'q1',
      question: 'Pick one',
      options: Array.from({ length: 7 }, (_, i) => ({
        label: `Option ${i + 1}`,
        description: 'd'.repeat(800),
      })),
    }])
    const view = await viewport(vt)
    const span = questionFrameSpan(view)
    assert.ok(span > 4, `dialog missing at ${rows} rows:\n${view}`)
    assert.ok(span <= maxSpan, `dialog span ${span} > ${maxSpan} at ${rows} rows:\n${view}`)
    assert.ok(view.includes('→'), `pointer pushed out at ${rows} rows:\n${view}`)
    assert.ok(view.includes('esc cancel'), `hint pushed out at ${rows} rows:\n${view}`)
    assert.ok(view.includes('more lines'), `truncation marker missing at ${rows} rows:\n${view}`)
    await vt.sendInput('\x1b')
    await assert.rejects(promise, /cancelled/)
  }
})

test('the whole question dialog fits its height: long descriptions cannot push the hint out', async () => {
  const { vt, app } = startApp()
  // Review repro: 7 options, each with an ~800-char description, once
  // wrapped to 112 rows; the overlay clips at maxHeight 26 and the user
  // would be choosing blind. The shared budget must keep the current
  // option and the hint visible.
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Pick one',
    options: Array.from({ length: 7 }, (_, i) => ({
      label: `Option ${i + 1}`,
      description: 'd'.repeat(800),
    })),
  }])
  const view = await viewport(vt)
  // Measure the question frame only (24-row terminal: cap = 14 rows) — the
  // docked layout leaves other content visible, so whole-viewport row counts
  // would prove nothing.
  const span = questionFrameSpan(view)
  assert.ok(span > 4, `dialog missing:\n${view}`)
  assert.ok(span <= 14, `dialog overflowed the 60% height cap (span ${span}):\n${view}`)
  assert.ok(view.includes('Option 1'), `the current option was pushed out:\n${view}`)
  assert.ok(view.includes('esc cancel'), `the hint was pushed out:\n${view}`)
  assert.ok(view.includes('more lines'), `truncation marker missing:\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('long descriptions cannot hide the highlighted option while moving the cursor', async () => {
  const { vt, app } = startApp()
  // Review repro: 7 options, each with an ~800-char description. Rows above
  // the cursor used to consume the whole option budget, so after a few Downs
  // the page showed only the rows above the cursor and the `→` pointer
  // vanished. The current option's label is anchored: every step must show
  // the pointer.
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Pick one',
    options: Array.from({ length: 7 }, (_, i) => ({
      label: `Option ${i + 1}`,
      description: 'd'.repeat(800),
    })),
  }])
  for (let step = 0; step < 6; step++) {
    const view = await viewport(vt)
    assert.ok(view.includes('→'), `highlighted option vanished at step ${step}:\n${view}`)
    assert.ok(view.includes('esc cancel'), `hint vanished at step ${step}:\n${view}`)
    vt.sendInput('\x1b[B') // Down
  }
  const view = await viewport(vt)
  assert.ok(view.includes('→'), `highlighted option vanished after the final Down:\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('the highlighted question option stays visible at narrow terminal widths', async () => {
  for (const width of [50, 60, 70]) {
    const { vt, app } = startApp(width)
    const promise = app.askQuestions([{
      id: 'q1',
      question: 'Pick one',
      options: Array.from({ length: 7 }, (_, i) => ({
        label: `Option ${i + 1}`,
        description: 'd'.repeat(800),
      })),
    }])
    for (let step = 0; step < 7; step++) {
      const view = await viewport(vt)
      assert.ok(view.includes('→'), `highlighted option vanished at width ${width}, step ${step}:\n${view}`)
      if (step < 6) vt.sendInput('\x1b[B')
    }
    vt.sendInput('\x1b')
    await assert.rejects(promise, /cancelled/)
  }
})

test('review page stays inside the dialog: Submit and the hint survive long answers', async () => {
  const { vt, app } = startApp()
  // Review repro: 3 questions, each ~900 chars, answered — the old review
  // page wrapped every question/answer unbudgeted (54+ rows) and the overlay
  // clipped Submit/Cancel at row 53. The budgeted review page must keep the
  // action row and the hint visible no matter how long the answers are.
  const longQuestion = 'q'.repeat(900)
  const promise = app.askQuestions([
    { id: 'q1', question: longQuestion, options: [{ label: 'A' }] },
    { id: 'q2', question: longQuestion, options: [{ label: 'B' }] },
    { id: 'q3', question: longQuestion, options: [{ label: 'C' }] },
  ])
  await viewport(vt)
  vt.sendInput('1')
  await viewport(vt)
  vt.sendInput('\x1b[C') // → next question
  await viewport(vt)
  vt.sendInput('1')
  await viewport(vt)
  vt.sendInput('\x1b[C') // → next question
  await viewport(vt)
  vt.sendInput('1')
  await viewport(vt)
  vt.sendInput('\x1b[C') // → review page
  const view = await viewport(vt)
  assert.ok(view.includes('Submit'), `Submit action missing:\n${view}`)
  assert.ok(view.includes('Cancel'), `Cancel action missing:\n${view}`)
  assert.ok(view.includes('esc cancel'), `hint missing:\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('a long unbroken question detail is row-budgeted so the hint stays visible and options stay reachable', async () => {
  const { vt, app } = startApp()
  // 3000 chars on ONE line: without a physical-row budget this wraps to
  // dozens of rows and pushes the options + hint out of the dialog.
  const longDetail = 'x'.repeat(3000)
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Pick a side',
    detail: longDetail,
    options: [{ label: 'Alpha' }, { label: 'Beta' }],
  }])
  let view = await viewport(vt)
  // The unified scrollport shows the TOP of the page: the wrapped detail
  // fills the region and the options sit below the fold — but the hint stays
  // pinned and the marker proves the content continues.
  assert.ok(!view.includes('Alpha'), `options must sit below the fold while the detail fills the region:\n${view}`)
  assert.ok(view.includes('esc cancel'), `hint pushed out of the dialog:\n${view}`)
  assert.ok(view.includes('more lines') || view.includes('more content hidden'), `truncation marker missing:\n${view}`)
  // PageDown reaches the options — nothing is unreachable on a small screen.
  for (let page = 0; page < 6 && !view.includes('Alpha'); page++) {
    vt.sendInput('\x1b[6~')
    await vt.waitForRender()
    view = await viewport(vt)
  }
  assert.ok(view.includes('Alpha'), `options unreachable by scrolling:\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('an active question re-budgets when the terminal resizes', async () => {
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Pick one',
    options: Array.from({ length: 7 }, (_, i) => ({
      label: `Option ${i + 1}`,
      description: 'd'.repeat(800),
    })),
  }])
  let view = await viewport(vt)
  assert.ok(questionFrameSpan(view) <= 24, `dialog must fit 24 rows at 40 rows:\n${view}`)
  vt.resize(100, 16)
  view = await viewport(vt)
  const span = questionFrameSpan(view)
  assert.ok(span <= 10, `dialog must re-budget to 10 rows after resize (span ${span}):\n${view}`)
  assert.ok(view.includes('→'), `pointer lost after resize:\n${view}`)
  assert.ok(view.includes('esc cancel'), `hint lost after resize:\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('a queued question budgets against the terminal height at presentation', async () => {
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const first = app.askQuestions([{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }])
  const second = app.askQuestions([{ id: 'q2', question: 'Second?', options: [
    ...Array.from({ length: 7 }, (_, i) => ({ label: `Option ${i + 1}`, description: 'd'.repeat(800) })),
  ] }])
  await viewport(vt)
  // Resize while the FIRST flow is active: the queued flow must present at
  // the CURRENT height, not the height captured at askQuestions time.
  vt.resize(100, 16)
  await viewport(vt)
  vt.sendInput('1')
  await viewport(vt)
  vt.sendInput('\r')
  await first
  const view = await viewport(vt)
  assert.ok(view.includes('Second?'), `queued question must take the seat:\n${view}`)
  const span = questionFrameSpan(view)
  assert.ok(span <= 10, `queued dialog must budget at the current height (span ${span}):\n${view}`)
  assert.ok(view.includes('esc cancel'), `hint lost:\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(second, /cancelled/)
})

test('the previous assistant reply stays visible above the question dialog', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'assistant', turn: 0, text: 'Here is the plan I propose: step one, step two, step three.' }])
  const promise = app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }])
  const view = await viewport(vt)
  assert.ok(view.includes('Here is the plan I propose'), `reply hidden behind the dialog:\n${view}`)
  assert.ok(view.includes('Proceed?'), `question missing:\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('question dialog invariants hold under saturated chrome', async () => {
  // Busy indicator + queue + todo + dock content are pinned rows above the
  // seat; the dialog must keep its own invariants (height cap, pointer,
  // hint) even when the transcript is squeezed out entirely. Transcript
  // visibility is best-effort — it is NOT asserted here.
  const { vt, app } = startApp()
  app.setTodoSummary([
    { content: 'todo one', status: 'in_progress' },
    { content: 'todo two', status: 'pending' },
  ])
  app.setTasks([{ id: 't1', label: 'sleep 10', status: 'running' }])
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Pick one',
    options: Array.from({ length: 7 }, (_, i) => ({
      label: `Option ${i + 1}`,
      description: 'd'.repeat(800),
    })),
  }])
  const view = await viewport(vt)
  const span = questionFrameSpan(view)
  assert.ok(span <= 14, `dialog overflowed under chrome (span ${span}):\n${view}`)
  assert.ok(view.includes('→'), `pointer pushed out under chrome:\n${view}`)
  assert.ok(view.includes('esc cancel'), `hint pushed out under chrome:\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('a question flow preserves the editor draft across cancel', async () => {
  const { vt, app } = startApp()
  app.setDraft('my precious draft')
  const promise = app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }])
  await viewport(vt)
  vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
  // The SAME editor instance swaps back into the seat — the draft survives.
  assert.equal(app.getDraft(), 'my precious draft')
})

test('aborting a question restores the editor without any key input', async () => {
  const { vt, app } = startApp()
  const controller = new AbortController()
  const promise = app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }], controller.signal)
  let view = await viewport(vt)
  assert.ok(view.includes('Proceed?'), `question missing:\n${view}`)
  // The AbortSignal path never passes through handleQuestionKey's repaint:
  // the settle must request the repaint itself.
  controller.abort()
  await assert.rejects(promise, /cancelled/)
  view = await viewport(vt)
  assert.ok(!view.includes('Proceed?'), `stale question frame after abort:\n${view}`)
})

test('a question flow suspends the settings panel and restores it on settle', async () => {
  const { vt, app } = startApp()
  app.openSettings(
    [{ id: 'a', label: 'Settings row A', description: 'desc', currentValue: '' }],
    () => {},
    () => {},
  )
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('Settings row A'), `settings missing before question:\n${view}`)
  const promise = app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('Proceed?'), `question missing:\n${view}`)
  assert.ok(!view.includes('Settings row A'), `settings must be suspended while the question is up:\n${view}`)
  // The question is answerable while the settings panel is hidden.
  vt.sendInput('1')
  await vt.waitForRender()
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('Settings row A'), `settings must return after the question:\n${view}`)
})

test('an approval arriving during a question is suspended and revealed in order', async () => {
  const { vt, app } = startApp()
  app.openSettings(
    [{ id: 'a', label: 'Settings row A', description: 'desc', currentValue: '' }],
    () => {},
    () => {},
  )
  await vt.waitForRender()
  const question = app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(!view.includes('Approve bash?'), `approval must stay hidden under the question:\n${view}`)
  // Settle the question: the approval appears (it was created while the
  // question owned the modal front), the settings stay hidden beneath it.
  vt.sendInput('1')
  await vt.waitForRender()
  vt.sendInput('\r')
  await question
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('Approve bash?'), `approval must appear after the question:\n${view}`)
  assert.ok(!view.includes('Settings row A'), `settings must stay hidden under the approval:\n${view}`)
  // Rejecting the approval restores the settings beneath it.
  vt.sendInput('n')
  assert.equal(await approval, 'rejected')
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('Settings row A'), `settings must return after the approval:\n${view}`)
})

test('closing a suspended overlay during a question must not revive it', async () => {
  const { vt, app } = startApp()
  const close = app.openSettings(
    [{ id: 'a', label: 'Settings row A', description: 'desc', currentValue: '' }],
    () => {},
    () => {},
  )
  await vt.waitForRender()
  const promise = app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  // Close the suspended settings programmatically while the question is up.
  close()
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(!view.includes('Settings row A'), `settings must stay hidden:\n${view}`)
  // Settling the question must NOT revive the closed overlay.
  vt.sendInput('1')
  await vt.waitForRender()
  vt.sendInput('\r')
  await promise
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(!view.includes('Settings row A'), `a closed overlay must not revive after the question:\n${view}`)
})

test('queued question flows transfer the seat and suspension without restoring', async () => {
  const { vt, app } = startApp()
  app.openSettings(
    [{ id: 'a', label: 'Settings row A', description: 'desc', currentValue: '' }],
    () => {},
    () => {},
  )
  await vt.waitForRender()
  const first = app.askQuestions([{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }])
  const second = app.askQuestions([{ id: 'q2', question: 'Second?', options: [{ label: 'B' }] }])
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('First?'), `first question missing:\n${view}`)
  assert.ok(!view.includes('Settings row A'), `settings must be suspended:\n${view}`)
  vt.sendInput('1')
  await vt.waitForRender()
  vt.sendInput('\r')
  await first
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('Second?'), `second question must take the seat:\n${view}`)
  assert.ok(!view.includes('First?'), `first frame must be gone:\n${view}`)
  assert.ok(!view.includes('Settings row A'), `settings must stay suspended between flows:\n${view}`)
  vt.sendInput('1')
  await vt.waitForRender()
  vt.sendInput('\r')
  await second
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('Settings row A'), `settings must return after the LAST flow:\n${view}`)
})

test('a question preempts a visible approval and restores it on settle', async () => {
  const { vt, app } = startApp()
  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await vt.waitForRender()
  const question = app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('Proceed?'), `question must take the front:\n${view}`)
  assert.ok(!view.includes('Approve bash?'), `approval must be suspended:\n${view}`)
  vt.sendInput('1')
  await vt.waitForRender()
  vt.sendInput('\r')
  await question
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('Approve bash?'), `approval must return after the question:\n${view}`)
  vt.sendInput('y')
  assert.equal(await approval, 'allowed-once')
})

test('a question renders and restores inside fullscreen', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await vt.waitForRender()
  const promise = app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }])
  const view = await viewport(vt)
  assert.ok(view.includes('Proceed?'), `question missing in fullscreen:\n${view}`)
  vt.sendInput('1')
  await vt.waitForRender()
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  const after = await viewport(vt)
  assert.ok(!after.includes('Proceed?'), `stale question frame in fullscreen:\n${after}`)
})

test('setFullscreen during an active question keeps the question mounted', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  // Direct toggle (not reachable through Ctrl+F — question input wins — but
  // the public method must not crash or lose the question).
  app.setFullscreen(true)
  let view = await viewport(vt)
  assert.ok(view.includes('Proceed?'), `question must survive the toggle:\n${view}`)
  vt.sendInput('1')
  await vt.waitForRender()
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  app.setFullscreen(false)
  view = await viewport(vt)
  assert.ok(!view.includes('Proceed?'), `stale question frame after leaving fullscreen:\n${view}`)
})

test('fullscreen toggle clears the overlay tracking graph (no stale handles)', async () => {
  // The toggle destroys the OLD screen's overlays — including ones suspended
  // under an active question. The tracking graph (overlayHandles,
  // overlayDependents, the question's suspension set) must be cleared at the
  // toggle. This is a GRAPH assertion: stale handles are behaviorally
  // invisible (settleQuestions guards revival with overlayHandles.has()), so
  // a screen-output test cannot distinguish the leak from the fix — only the
  // graph sizes can.
  const { vt, app } = startApp()
  app.openSettings(
    [{ id: 'a', label: 'Settings row A', description: 'desc', currentValue: '' }],
    () => {},
    () => {},
  )
  await vt.waitForRender()
  const promise = app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  // Before the toggle: the settings overlay is suspended under the question.
  assert.deepEqual(app.overlayGraphState(), { handles: 1, dependents: 0, suspended: 1 })
  app.setFullscreen(true)
  let view = await viewport(vt)
  assert.ok(view.includes('Proceed?'), `question must survive the toggle:\n${view}`)
  // After the toggle: the destroyed overlays leave NO dead handles behind
  // (this assertion fails on the pre-fix code, which kept stale
  // overlayDependents / suspendedOverlays entries across the toggle).
  assert.deepEqual(app.overlayGraphState(), { handles: 0, dependents: 0, suspended: 0 })
  // Settle the question: the destroyed settings must not revive.
  vt.sendInput('1')
  await vt.waitForRender()
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.deepEqual(app.overlayGraphState(), { handles: 0, dependents: 0, suspended: 0 })
  view = await viewport(vt)
  assert.ok(!view.includes('Settings row A'), `destroyed settings must not revive:\n${view}`)
})

/** Long detail: distinct lines that fit one row at width 100 (the app-level
 * fixtures run at 100 cols) — a deterministic scrollport fixture. */
function longDetailLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `detail-${String(i).padStart(2, '0')} ` + 'y'.repeat(70)).join('\n')
}

test('the question body scrolls with PageUp/PageDown', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Pick a side',
    detail: longDetailLines(60),
    options: [{ label: 'Alpha' }, { label: 'Beta' }],
  }])
  let view = await viewport(vt)
  assert.ok(view.includes('detail-00'), `top content missing:\n${view}`)
  assert.ok(view.includes('↓ '), `down marker missing:\n${view}`)
  assert.ok(!view.includes('detail-09'), `deep content must be clipped compact:\n${view}`)
  vt.sendInput('\x1b[6~') // PageDown
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(!view.includes('detail-00'), `top content must scroll away:\n${view}`)
  assert.ok(view.includes('↑ '), `up marker missing after scrolling:\n${view}`)
  vt.sendInput('\x1b[5~') // PageUp
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(view.includes('detail-00'), `PageUp must return to the top:\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('e expands the question panel and collapses it back', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Pick a side',
    detail: longDetailLines(60),
    options: [{ label: 'Alpha' }, { label: 'Beta' }],
  }])
  let view = await viewport(vt)
  const compactSpan = questionFrameSpan(view)
  assert.ok(compactSpan <= 14, `compact panel must respect the 60% cap (span ${compactSpan}):\n${view}`)
  assert.ok(!view.includes('detail-09'), `deep content must be clipped compact:\n${view}`)
  vt.sendInput('e')
  await vt.waitForRender()
  view = await viewport(vt)
  const expandedSpan = questionFrameSpan(view)
  assert.ok(expandedSpan > compactSpan, `expand must grow the panel (${compactSpan} -> ${expandedSpan}):\n${view}`)
  assert.ok(expandedSpan <= 20, `expanded panel must respect the 80% cap (span ${expandedSpan}):\n${view}`)
  assert.ok(view.includes('detail-09'), `expand must reveal deeper content:\n${view}`)
  // The pointer follows the cursor: moving it scrolls the option (with its
  // description) into the viewport — the pointer never gets stranded
  // off-screen while paging the unified scrollport.
  vt.sendInput('j')
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(view.includes('→'), `pointer must follow the cursor into view:\n${view}`)
  vt.sendInput('e')
  await vt.waitForRender()
  view = await viewport(vt)
  assert.equal(questionFrameSpan(view), compactSpan, `collapse must restore the panel size:\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('e reveals cut option descriptions on a small screen', async () => {
  // Regression: on a 24-row terminal with a SHORT body, option descriptions
  // were cut by the window budget and 'e' no-oped (its guard only looked at
  // the BODY overflow) — descriptions were unreachable. 'e' must now grow
  // the panel and let the extra rows flow to the option window.
  const { vt, app } = startApp()
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Pick a side',
    options: Array.from({ length: 4 }, (_, i) => ({
      label: `Option ${i + 1}`,
      description: 'x'.repeat(700) + `TAIL${i}`,
    })),
  }])
  let view = await viewport(vt)
  assert.ok(view.includes('more lines'), `descriptions must be cut compact:\n${view}`)
  assert.ok(!view.includes('TAIL0'), `description tail must be hidden compact:\n${view}`)
  const compactSpan = questionFrameSpan(view)
  vt.sendInput('e')
  await vt.waitForRender()
  view = await viewport(vt)
  const expandedSpan = questionFrameSpan(view)
  assert.ok(expandedSpan > compactSpan, `e must grow the panel (${compactSpan} -> ${expandedSpan}):\n${view}`)
  assert.ok(view.includes('TAIL0'), `e must reveal the cut description:\n${view}`)
  assert.ok(view.includes('→'), `pointer must survive expand:\n${view}`)
  vt.sendInput('e')
  await vt.waitForRender()
  view = await viewport(vt)
  assert.equal(questionFrameSpan(view), compactSpan, `collapse must restore the panel size:\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

/** Send an SGR primary-button press+release (1-based coords) at a screen row. */
function clickCell(vt: { sendInput: (data: string) => void }, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
}

test('a fullscreen click on an option row selects it', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await vt.waitForRender()
  const promise = app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }])
  let view = await viewport(vt)
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const lines = view.split('\n')
  const yesIdx = lines.findIndex(line => strip(line).includes('[1] Yes'))
  assert.ok(yesIdx >= 0, `option row missing:\n${view}`)
  // Click the "Yes" row (x inside the content columns; y from the viewport).
  clickCell(vt, 10, yesIdx)
  await vt.waitForRender()
  view = await viewport(vt)
  // Single-select on the last question advances to the review page.
  assert.ok(view.includes('Submit'), `click must select the option:\n${view}`)
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['Yes'] }])
})

test('a fullscreen click on the body scroll marker expands the panel', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await vt.waitForRender()
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Pick a side',
    detail: longDetailLines(60),
    options: [{ label: 'Alpha' }],
  }])
  let view = await viewport(vt)
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const lines = view.split('\n')
  const markerIdx = lines.findIndex(line => strip(line).includes('↓ '))
  assert.ok(markerIdx >= 0, `scroll marker missing:\n${view}`)
  const compactSpan = questionFrameSpan(view)
  clickCell(vt, 10, markerIdx)
  await vt.waitForRender()
  view = await viewport(vt)
  const expandedSpan = questionFrameSpan(view)
  assert.ok(expandedSpan > compactSpan, `marker click must expand the panel (${compactSpan} -> ${expandedSpan}):\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('a fullscreen click toggles a multi-select option', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await vt.waitForRender()
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Pick some',
    multiSelect: true,
    options: [{ label: 'A' }, { label: 'B' }],
  }])
  let view = await viewport(vt)
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const aIdx = view.split('\n').findIndex(line => strip(line).includes('[ ] A'))
  assert.ok(aIdx >= 0, `option A row missing:\n${view}`)
  clickCell(vt, 10, aIdx)
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(view.includes('[✓] A'), `click must toggle A on:\n${view}`)
  const bIdx = view.split('\n').findIndex(line => strip(line).includes('[ ] B'))
  assert.ok(bIdx >= 0, `option B row missing:\n${view}`)
  clickCell(vt, 10, bIdx)
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(view.includes('[✓] B'), `click must toggle B on:\n${view}`)
  // Multi-select stays on the question; the second click on A toggles it off.
  const aOn = view.split('\n').findIndex(line => strip(line).includes('[✓] A'))
  clickCell(vt, 10, aOn)
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(view.includes('[ ] A'), `click must toggle A back off:\n${view}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('a fullscreen click on the "Type something." row enters free-text mode', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await vt.waitForRender()
  const promise = app.askQuestions([{ id: 'q1', question: 'Pick', options: [{ label: 'A' }] }])
  let view = await viewport(vt)
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const otherIdx = view.split('\n').findIndex(line => strip(line).includes('Type something.'))
  assert.ok(otherIdx >= 0, `free-text row missing:\n${view}`)
  clickCell(vt, 10, otherIdx)
  await vt.waitForRender()
  // Free-text mode is active: typed text lands in the row's real Input.
  vt.sendInput('custom answer')
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(view.includes('custom answer'), `typed text must land in the free-text row:\n${view}`)
  // A second click on the SAME row must not reset the in-progress text.
  const editIdx = view.split('\n').findIndex(line => strip(line).includes('custom answer'))
  clickCell(vt, 10, editIdx)
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(view.includes('custom answer'), `re-click must not discard the typed text:\n${view}`)
  // Esc leaves free-text mode (a second Esc cancels the flow).
  await vt.sendInput('\x1b')
  await vt.waitForRender()
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('a fullscreen click is inert on the review page', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await vt.waitForRender()
  const promise = app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  vt.sendInput('1') // single-select advances to the review page
  let view = await viewport(vt)
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  assert.ok(view.includes('Submit'), `review page missing:\n${view}`)
  const submitIdx = view.split('\n').findIndex(line => strip(line).includes('Submit'))
  assert.ok(submitIdx >= 0, `Submit row missing:\n${view}`)
  clickCell(vt, 10, submitIdx)
  await vt.waitForRender()
  const after = await viewport(vt)
  // The review page has no hit map and no scroll marker: the click is inert.
  assert.equal(after, view, `click must be inert on the review page:\n${after}`)
  await vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('askQuestions toggles multi-select options', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Pick some',
    multiSelect: true,
    options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
  }])
  await viewport(vt)
  vt.sendInput('1')
  await viewport(vt)
  vt.sendInput('3')
  await viewport(vt)
  vt.sendInput('1') // toggle A off again
  await viewport(vt)
  vt.sendInput('2') // toggle B on
  await viewport(vt)
  // Multi-select Enter toggles; → pages to the review page, Enter submits.
  vt.sendInput('\x1b[C')
  await viewport(vt)
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['C', 'B'] }])
})

test('askQuestions collects free text for option-less questions', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{ id: 'q1', question: 'Your name?' }])
  await viewport(vt)
  vt.sendInput('alice')
  vt.sendInput('\r') // commit the typed answer
  await viewport(vt)
  vt.sendInput('\r') // review page: submit the batch
  assert.deepEqual(await promise, [{ id: 'q1', selected: [], custom: 'alice' }])
})

test('askQuestions walks through multiple questions', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([
    { id: 'q1', question: 'First?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Second?', options: [{ label: 'B' }, { label: 'C' }] },
  ])
  let view = await viewport(vt)
  assert.ok(view.includes('First?'), `first question missing:\n${view}`)
  // A single-select Enter advances immediately (Web parity).
  vt.sendInput('1')
  await viewport(vt)
  view = await viewport(vt)
  assert.ok(view.includes('Second?'), `second question missing:\n${view}`)
  vt.sendInput('2')
  await viewport(vt)
  // The review page: Enter submits the whole batch.
  vt.sendInput('\r')
  assert.deepEqual(await promise, [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: ['C'] },
  ])
})

test('esc cancels an askQuestions flow with a rejection', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{ id: 'q1', question: 'Continue?', options: [{ label: 'Yes' }] }])
  await viewport(vt)
  vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('concurrent askQuestions flows queue FIFO and each settles exactly once', async () => {
  const { vt, app } = startApp()
  const first = app.askQuestions([{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }])
  const second = app.askQuestions([{ id: 'q2', question: 'Second?', options: [{ label: 'B' }] }])
  await viewport(vt)
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('First?'), `the first flow is on screen:\n${view}`)
  assert.ok(!view.includes('Second?'), 'the second flow must wait in the queue')
  vt.sendInput('1') // choose A
  await viewport(vt)
  vt.sendInput('\r') // submit the first flow
  await viewport(vt)
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Second?'), `the second flow must take the screen:\n${view}`)
  vt.sendInput('1') // choose B
  await viewport(vt)
  vt.sendInput('\r') // submit the second flow
  await viewport(vt)
  assert.deepEqual(await first, [{ id: 'q1', selected: ['A'] }])
  assert.deepEqual(await second, [{ id: 'q2', selected: ['B'] }])
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('First?') && !view.includes('Second?'), `ghost overlay after both settle:\n${view}`)
})

test('a queued askQuestions flow aborted while waiting rejects without ever showing', async () => {
  const { vt, app } = startApp()
  const first = app.askQuestions([{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }])
  const controller = new AbortController()
  const second = app.askQuestions([{ id: 'q2', question: 'Second?', options: [{ label: 'B' }] }], controller.signal)
  await viewport(vt)
  controller.abort() // cancelled while queued: never presented, promise settles
  await assert.rejects(second, /cancelled/)
  await viewport(vt)
  let view = vt.getViewport().join('\n')
  assert.ok(!view.includes('Second?'), 'the aborted flow must never be presented')
  vt.sendInput('1')
  await viewport(vt)
  vt.sendInput('\r')
  assert.deepEqual(await first, [{ id: 'q1', selected: ['A'] }])
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('Second?'), 'no ghost overlay after the first settles')
})

test('aborting the ACTIVE flow rejects it and shows the next queued flow', async () => {
  const { vt, app } = startApp()
  const controller = new AbortController()
  const first = app.askQuestions([{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }], controller.signal)
  const second = app.askQuestions([{ id: 'q2', question: 'Second?', options: [{ label: 'B' }] }])
  await viewport(vt)
  controller.abort()
  await assert.rejects(first, /cancelled/)
  await viewport(vt)
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Second?'), `the queued flow must take the screen after the active one aborts:\n${view}`)
  vt.sendInput('1')
  await viewport(vt)
  vt.sendInput('\r')
  assert.deepEqual(await second, [{ id: 'q2', selected: ['B'] }])
})

test('stop() cancels every pending askQuestions flow with a rejection', async () => {
  const { vt, app } = startApp()
  const first = app.askQuestions([{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }])
  const second = app.askQuestions([{ id: 'q2', question: 'Second?', options: [{ label: 'B' }] }])
  await viewport(vt)
  app.stop()
  await assert.rejects(first, /cancelled/)
  await assert.rejects(second, /cancelled/)
})

test('the message component cache is pruned to the live transcript', () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const cache = (app as unknown as { messageComponents: Map<object, unknown> }).messageComponents
  const messages: { kind: 'user'; turn: number; text: string }[] = []
  for (let i = 0; i < 50; i += 1) {
    messages.push({ kind: 'user', turn: i, text: `message ${i}` })
  }
  app.setTranscript(messages)
  assert.ok(cache.size >= 50, 'the live messages are cached')
  // The window slides forward in a long session: the cache must shrink to
  // the live set instead of growing to full-history size.
  app.setTranscript(messages.slice(45))
  assert.equal(cache.size, 5, 'the cache must shrink to the live set')
  // A completely fresh window disposes the previous entries.
  app.setTranscript([{ kind: 'user', turn: 100, text: 'fresh' }])
  assert.equal(cache.size, 1, 'entries from the previous window must be disposed')
  app.stop()
})

test('local card push/replace/clear prune the component cache too', () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const cache = (app as unknown as { messageComponents: Map<object, unknown> }).messageComponents
  const locals = (app as unknown as { localMessages: object[] }).localMessages
  // 200 distinct cards, each running→settled: every replacement is a NEW
  // object, so without pruning the cache would hold the replaced running
  // card AND the settled one (400). The cache must track the LIVE locals.
  for (let i = 0; i < 200; i += 1) {
    const running = app.pushLocalMessage({
      kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'bash',
      args: `{"i":${i}}`, result: '', status: 'running',
    })
    app.updateLocalMessage(running, {
      kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'bash',
      args: `{"i":${i}}`, result: 'done', status: 'ok',
    })
  }
  assert.equal(cache.size, 200, 'each settled card cached once; replaced running objects pruned')
  assert.equal(cache.size, locals.length, 'the cache tracks the live local cards, never more')
  // Clearing the locals empties their cache entries (a bare session
  // transcript repaint is NOT required to trigger this).
  app.clearLocalMessages()
  assert.equal(cache.size, 0, 'clearLocalMessages must drop the local cache entries')
  app.stop()
})

test('tool card headers show the design title and the args summary', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'bash',
    args: '{"command":"ls -la","cwd":"/tmp"}',
    result: 'done', status: 'ok',
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('Bash ls -la [ok]'), `design title missing:\n${view}`)
  assert.ok(!view.includes('command=ls -la'), `raw key-arg format leaked:\n${view}`)
})

test('footer preset hides the stats line in compact mode', async () => {
  const { vt, app } = startApp()
  app.setStatus({ model: 'm', cwd: 'c', statsLine: '5 步| LLM 8.1s' })
  let view = await viewport(vt)
  assert.ok(view.includes('5 步| LLM 8.1s'), `stats line missing in full mode:\n${view}`)
  app.setFooterPreset('compact')
  view = await viewport(vt)
  assert.ok(!view.includes('5 步| LLM 8.1s'), `stats line visible in compact mode:\n${view}`)
  assert.ok(view.includes('[m]'), `line 1 missing:\n${view}`)
  app.setFooterPreset('full')
  view = await viewport(vt)
  assert.ok(view.includes('5 步| LLM 8.1s'), `stats line not restored:\n${view}`)
})

test('autoDetectTheme resolves without changing the theme when the terminal is silent', async () => {
  const { vt, app } = startApp()
  const before = currentPalette
  await app.autoDetectTheme() // VirtualTerminal never answers OSC 11
  assert.equal(currentPalette, before, 'silent terminal must not change the palette')
})

test('autoDetectTheme applies the detected theme through the ACTIVE screen in fullscreen mode', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await viewport(vt)
  // The alt screen owns the terminal input handler: the OSC 11 reply must
  // resolve the query registered on the ACTIVE screen. A query on the
  // stopped main screen would have its reply swallowed by the alt screen's
  // OSC 11 consumer and time out — the bug that made `auto` a silent no-op
  // in fullscreen mode.
  const pending = app.autoDetectTheme()
  vt.sendInput('\x1b]11;#eeeeee\x07') // bright background -> light palette
  await pending
  assert.equal(currentPalette, lightColors, 'fullscreen autodetect must apply the detected palette')
})

test('autoDetectTheme coalesces concurrent calls onto one shared query', async () => {
  const vt = new VirtualTerminal(100, 24)
  const writes: string[] = []
  const spy = new Proxy(vt, {
    get(target, prop) {
      if (prop === 'write') {
        return (data: string): void => { writes.push(data); target.write(data) }
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as Terminal
  const app = new TuiApp(spy, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  try {
    const first = app.autoDetectTheme()
    const second = app.autoDetectTheme()
    assert.equal(writes.filter(data => data.includes('\x1b]11;?')).length, 1,
      'concurrent autodetect calls must share one OSC 11 query')
    vt.sendInput('\x1b]11;#eeeeee\x07')
    await Promise.all([first, second])
    assert.equal(currentPalette, lightColors, 'the shared query result must apply once')
  } finally {
    app.stop()
  }
})

test('autoDetectTheme drops the settled result when shouldApply returns false', async () => {
  const { vt, app } = startApp()
  const before = currentPalette
  const pending = app.autoDetectTheme({ shouldApply: () => false })
  vt.sendInput('\x1b]11;#eeeeee\x07')
  await pending
  assert.equal(currentPalette, before, 'a refused result must not change the palette')
})

test('trackTerminalTheme enables DSR 996 scheme tracking idempotently', async () => {
  const vt = new VirtualTerminal(100, 24)
  const writes: string[] = []
  const spy = new Proxy(vt, {
    get(target, prop) {
      if (prop === 'write') {
        return (data: string): void => { writes.push(data); target.write(data) }
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as Terminal
  const app = new TuiApp(spy, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  try {
    app.trackTerminalTheme(true)
    app.trackTerminalTheme(true) // idempotent: no second query
    assert.equal(writes.filter(data => data.includes('\x1b[?996n')).length, 1,
      'enabling tracking must query DSR 996 exactly once')
    app.trackTerminalTheme(false)
    app.trackTerminalTheme(true) // re-enabling after disable queries again
    assert.equal(writes.filter(data => data.includes('\x1b[?996n')).length, 2,
      're-enabling after disable must query again')
  } finally {
    app.stop()
  }
})

test('scheme reports reach listeners while the alt screen owns input', async () => {
  const { vt, app } = startApp()
  const received: string[] = []
  app.onTerminalThemeChange((theme) => { received.push(theme) })
  app.setFullscreen(true)
  await viewport(vt)
  vt.sendInput('\x1b[?997;2n') // light — consumed by the alt screen
  assert.deepEqual(received, ['light'], 'reports must fan out from the active screen')
  app.stop()
})

test('fullscreen scrollback search opens with ctrl+shift+f', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'user', turn: 0, text: 'needle' }])
  await viewport(vt)
  app.setFullscreen(true)
  await viewport(vt)
  vt.sendInput('\x1b[102;6u') // kitty ctrl+shift+f
  const view = await viewport(vt)
  assert.ok(view.includes('Find transcript'), `search bar missing:\n${view}`)
})

test('ctrl+f opens and closes the transcript search (no fullscreen toggle)', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'user', turn: 0, text: 'needle' }])
  await viewport(vt)
  assert.equal(app.isFullscreen(), false)
  vt.sendInput('\x06') // ctrl+f → search, NOT fullscreen
  let view = await viewport(vt)
  assert.ok(view.includes('Find transcript'), `search bar missing:\n${view}`)
  assert.equal(app.isFullscreen(), false, 'ctrl+f must not toggle fullscreen')
  vt.sendInput('\x06') // ctrl+f again closes the overlay
  view = await viewport(vt)
  assert.ok(!view.includes('Find transcript'), `search bar still open:\n${view}`)
})

test('welcome card wraps long facts inside a full-width box', async () => {
  const { vt, app } = startApp()
  app.setWelcomeCard({
    cwd: '/very/long/working/directory/that/keeps/going',
    sessionId: `session-${'x'.repeat(40)}`,
    model: 'opencode-go/deepseek-v4-flash',
    version: '0.1.0-rc.6',
    preset: 'standard',
  })
  const view = await viewport(vt)
  // Facts render in full: the session id is never truncated, and long lines
  // wrap instead of ending in an ellipsis.
  assert.ok(view.includes(`session-${'x'.repeat(40)}`), `session id truncated:\n${view}`)
  assert.ok(view.includes('deepseek-v4-flash'), `model missing:\n${view}`)
  assert.ok(view.includes('standard'), `preset missing:\n${view}`)
  assert.ok(view.includes('0.1.0-rc.6'), `version missing:\n${view}`)
  assert.ok(view.includes('/very/long/working/directory/that/keeps/going'), `cwd truncated:\n${view}`)
  // The box spans the full terminal width, matching the editor border below.
  const lines = view.split('\n')
  const top = lines.find(line => line.includes('╭') && line.includes('╮'))
  assert.ok(top !== undefined, `box top missing:\n${view}`)
  assert.equal(top.length, 100, `box top must be full width, got ${top.length}`)
  assert.ok(lines.some(line => line.includes('╰') && line.includes('╯')), `box bottom missing:\n${view}`)
  assert.ok(lines.some(line => line.includes('│')), `box sides missing:\n${view}`)
})
test('working indicator shows on the row directly above the editor while active', async () => {
  const { vt, app } = startApp()
  app.setWorking(true)
  const view = await viewport(vt)
  const lines = view.split('\n')
  const workingIndex = lines.findIndex(line => line.includes('Working'))
  assert.ok(workingIndex !== -1, `working row missing:\n${view}`)
  const editorTop = lines.findIndex(line => line.includes('─'.repeat(10)))
  assert.ok(editorTop !== -1, `editor border missing:\n${view}`)
  assert.equal(workingIndex + 1, editorTop, `working row must sit directly above the editor border:\n${view}`)
  app.setWorking(false)
  const idle = await viewport(vt)
  assert.ok(!idle.includes('Working'), `working row survived:\n${idle}`)
})

test('WorkingIndicator stays active across timer restarts; refresh repaints live palettes', () => {
  const renders: string[] = []
  const capture = (): void => { renders.push(indicator.render(80).join('')) }
  const indicator = new WorkingIndicator(capture, { frames: ['🐋'], intervalMs: 1000 })
  // start() → restartAnimation() must NOT clear the active flag (the old
  // code called stop() from restartAnimation, so refresh() never repainted
  // and a single-frame indicator kept the stale palette forever).
  indicator.start()
  const afterStart = renders.length
  indicator.refresh()
  assert.ok(renders.length > afterStart, 'refresh() must repaint an ACTIVE indicator immediately')
  // An active indicator follows a live theme switch on the next refresh.
  setTheme('dark')
  indicator.refresh()
  const dark = renders[renders.length - 1]!
  setTheme('light')
  indicator.refresh()
  const light = renders[renders.length - 1]!
  assert.notEqual(dark, light, 'the active indicator must repaint with the live palette')
  // Repeated start is idempotent: no throw, single timer (dispose clean).
  indicator.start()
  indicator.start()
  indicator.dispose()
  // A stopped indicator never repaints.
  indicator.start()
  indicator.stop()
  const afterStop = renders.length
  indicator.refresh()
  assert.equal(renders.length, afterStop, 'refresh() must not repaint a STOPPED indicator')
  // Restore the global theme (setTheme is module state).
  setTheme('dark')
})

test('working indicator alternates between the whale emojis', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { workingIntervalMs: 20 })
  app.start()
  app.setWorking(true)
  await vt.waitForRender()
  const seen = new Set<string>()
  for (let i = 0; i < 30 && seen.size < 2; i += 1) {
    const view = vt.getViewport().join('\n')
    const line = view.split('\n').find(candidate => candidate.includes('Working'))
    if (line !== undefined) {
      if (line.includes('🐋')) seen.add('🐋')
      if (line.includes('🐳')) seen.add('🐳')
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(seen.has('🐋') && seen.has('🐳'), `both whale emojis must appear, saw: ${[...seen].join(', ')}`)
  app.setWorking(false)
  app.stop()
})

test('working indicator shows above the editor in fullscreen too', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setWorking(true)
  const view = await viewport(vt)
  const lines = view.split('\n')
  const workingIndex = lines.findIndex(line => line.includes('Working'))
  assert.ok(workingIndex !== -1, `working row missing in fullscreen:\n${view}`)
  const editorTop = lines.findIndex(line => line.includes('─'.repeat(10)))
  assert.ok(editorTop !== -1, `editor border missing:\n${view}`)
  assert.equal(workingIndex + 1, editorTop, `working row must sit above the editor border in fullscreen:\n${view}`)
  app.setWorking(false)
  app.setFullscreen(false)
})
test('live theme switch recolors every surface while the content stays identical', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setStatus({ model: 'p/m', cwd: '/ws', branch: 'main', turns: 2, steps: 3, statsLine: 'llm 1s' })
  app.setPlanMode(true)
  app.setTodoSummary([{ content: 'fix the theme', status: 'in_progress' }])
  app.setTasks([{ id: 'bash-1', label: 'review', status: 'running', kind: 'bash' }])
  app.setQueueItems([{ id: 'q1', text: 'hello', mode: 'followup' }])
  app.setWorking(true)
  await vt.waitForRender()
  // Locate the header row (contains the plan badge).
  const findRow = (needle: string): number => {
    const lines = vt.getViewport()
    const index = lines.findIndex(line => line.includes(needle))
    assert.ok(index !== -1, `row with ${needle} missing`)
    return index
  }
  const headerRow = findRow('[plan]')
  const badgeCol = (): number => vt.getViewport()[headerRow]!.indexOf('[plan]')
  // Dark palette: the plan badge renders with the dark warning token.
  assert.equal(vt.getCellFgRgb(headerRow, badgeCol()), 0xe8a838, 'dark plan badge must be #E8A838')
  app.applyTheme('light')
  await vt.waitForRender()
  assert.equal(vt.getCellFgRgb(headerRow, badgeCol()), 0x92660a, 'light plan badge must be #92660A')
  // Content is unchanged by the switch.
  const before = vt.getViewport().join('\n')
  app.applyTheme('dark')
  await vt.waitForRender()
  assert.equal(vt.getViewport().join('\n'), before, 'theme switch must not change content')
  // A custom palette applies too; unset tokens keep the base.
  app.applyPalette({ ...darkColors, primary: '#123456' })
  await vt.waitForRender()
  assert.equal(vt.getCellFgRgb(headerRow, badgeCol()), 0xe8a838, 'unset tokens keep the base palette')
  app.applyTheme('dark')
  app.setWorking(false)
  app.stop()
})

test('theme switch recolors the welcome card (its width cache must not freeze ANSI)', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setWelcomeCard({ cwd: '/ws', sessionId: 'session-x', model: 'p/m', version: '0.0.0' })
  await vt.waitForRender()
  const row = vt.getViewport().findIndex(line => line.includes('╭'))
  assert.ok(row >= 0, `welcome card missing:\n${vt.getViewport().join('\n')}`)
  // Dark border #5A5A5A → light border #737373 after the switch.
  assert.equal(vt.getCellFgRgb(row, 0), 0x5a5a5a, 'dark welcome border must be #5A5A5A')
  app.applyTheme('light')
  await vt.waitForRender()
  assert.equal(vt.getCellFgRgb(row, 0), 0x737373, 'welcome border must follow the live theme')
  app.stop()
})

test('working indicator keeps animating in fullscreen and after leaving it, with a single timer', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { workingIntervalMs: 20 })
  app.start()
  app.setWorking(true)
  await vt.waitForRender()
  // Sample several ticks WHILE the alt screen renders: the repaint callback
  // must route to the active screen or the animation would freeze on the
  // first frame (the main screen is stopped in fullscreen).
  app.setFullscreen(true)
  await vt.waitForRender()
  const seenFullscreen = new Set<string>()
  for (let i = 0; i < 30 && seenFullscreen.size < 2; i += 1) {
    const line = vt.getViewport().join('\n').split('\n').find(candidate => candidate.includes('Working'))
    if (line !== undefined) {
      if (line.includes('🐋')) seenFullscreen.add('🐋')
      if (line.includes('🐳')) seenFullscreen.add('🐳')
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(seenFullscreen.has('🐋') && seenFullscreen.has('🐳'),
    `both whale emojis must appear in fullscreen, saw: ${[...seenFullscreen].join(', ')}`)
  // Leaving fullscreen: the animation continues (no duplicated timer stall).
  app.setFullscreen(false)
  await vt.waitForRender()
  const seenAfter = new Set<string>()
  for (let i = 0; i < 30 && seenAfter.size < 2; i += 1) {
    const line = vt.getViewport().join('\n').split('\n').find(candidate => candidate.includes('Working'))
    if (line !== undefined) {
      if (line.includes('🐋')) seenAfter.add('🐋')
      if (line.includes('🐳')) seenAfter.add('🐳')
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(seenAfter.has('🐋') && seenAfter.has('🐳'),
    `animation must resume after leaving fullscreen, saw: ${[...seenAfter].join(', ')}`)
  app.setWorking(false)
  app.stop()
})


test('search cards group matches by file and mark truncation', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    workspaceRoot: '/ws',
    present: {
      call: () => undefined,
      result: () => ({
        card: 'search',
        shape: 'matches',
        files: [{ path: '/ws/src/foo.ts', matches: [{ lineNumber: 12, line: 'const a = 1' }] }],
        truncated: true,
        total: 42,
      }),
    },
  })
  app.start()
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'grep',
    args: '{"pattern":"const","path":"/ws/src"}',
    result: '12: const a = 1', status: 'ok', resultBlocks: [],
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('Search const [ok]'), `search header missing:\n${view}`)
  assert.ok(view.includes('src/foo.ts'), `relativized file group missing:\n${view}`)
  assert.ok(view.includes('12 │ const a = 1'), `match line missing:\n${view}`)
  assert.ok(view.includes('… truncated — 42 total matches'), `truncation marker missing:\n${view}`)
  assert.ok(!view.includes('/ws/src/foo.ts'), `absolute path leaked:\n${view}`)
  app.stop()
})

test('terminal cards show the output and the exit code', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => undefined,
      result: () => ({ card: 'terminal', output: 'hello\nworld', exitCode: 0 }),
    },
  })
  app.start()
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'bash',
    args: '{"command":"echo hi"}',
    result: 'hello\nworld', status: 'ok', resultBlocks: [],
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('Bash echo hi [ok]'), `terminal header missing:\n${view}`)
  // The command row survives expansion (kimi ShellExecution parity): the
  // expanded body leads with `$ cmd` ABOVE the output.
  const commandAt = view.indexOf('$ echo hi')
  assert.ok(commandAt >= 0, `command row missing in the expanded card:\n${view}`)
  assert.ok(view.indexOf('hello') > commandAt, `command must render above the output:\n${view}`)
  assert.ok(view.includes('hello'), `output line missing:\n${view}`)
  assert.ok(view.includes('world'), `output line missing:\n${view}`)
  assert.ok(view.includes('[exit 0]'), `exit pill missing:\n${view}`)
  app.stop()
})

test('expanded bash cards keep the command row without a presenter', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'bash',
    args: '{"command":"ls -la /tmp && echo done"}',
    result: 'file1\nfile2\ndone', status: 'ok', resultBlocks: [],
  }])
  let view = await viewport(vt)
  assert.ok(view.includes('$ ls -la /tmp && echo done'), `folded command preview missing:\n${view}`)
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'bash',
    args: '{"command":"ls -la /tmp && echo done"}',
    result: 'file1\nfile2\ndone', status: 'ok', resultBlocks: [],
  }])
  view = await viewport(vt)
  const commandAt = view.indexOf('$ ls -la /tmp && echo done')
  assert.ok(commandAt >= 0, `expanded card lost the command:\n${view}`)
  assert.ok(view.indexOf('file1') > commandAt, `command must render above the output:\n${view}`)
  assert.ok(view.includes('file2') && view.includes('done'), `output missing:\n${view}`)
})

test('running bash cards surface the command row when expanded', async () => {
  const { vt, app } = startApp()
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'bash',
    args: '{"command":"pnpm test"}',
    result: '', status: 'running', resultBlocks: [],
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('$ pnpm test'), `running card lost the command:\n${view}`)
})

test('running bash cards use the presenter command and never double-render it', async () => {
  // The presenter path (callView.card === 'terminal') takes the command
  // from the tool's own presentCall title; the command row must render
  // exactly ONCE (the branch returns before the args-derived fallback).
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => ({ card: 'terminal', title: 'echo hi' }),
      result: () => undefined,
    },
  })
  app.start()
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'bash',
    args: '{"command":"echo hi"}',
    result: '', status: 'running', resultBlocks: [],
  }])
  const view = await viewport(vt)
  const matches = view.match(/\$ echo hi/g) ?? []
  assert.equal(matches.length, 1, `command row must render exactly once:\n${view}`)
  app.stop()
})

test('pwsh cards render the command under a PS> prompt', async () => {
  const { vt, app } = startApp()
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'pwsh',
    args: '{"command":"Get-ChildItem"}',
    result: 'file1', status: 'ok', resultBlocks: [],
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('PS> Get-ChildItem'), `pwsh prompt missing:\n${view}`)
  assert.ok(!view.includes('$ Get-ChildItem'), `bash prompt leaked into a pwsh card:\n${view}`)
  assert.ok(view.includes('file1'), `output missing:\n${view}`)
})

test('generic presenter cards keep the command row above the raw input', async () => {
  // A presenter returning 'generic' with rawInput for a bash call must
  // still lead with the `$ command` row (a no-op for non-terminal tools).
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => ({ card: 'generic', title: 'Sleep 5 seconds', rawInput: { command: 'sleep 5' } }),
      result: () => undefined,
    },
  })
  app.start()
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'bash',
    args: '{"command":"sleep 5"}',
    result: '', status: 'running', resultBlocks: [],
  }])
  const view = await viewport(vt)
  const commandAt = view.indexOf('$ sleep 5')
  assert.ok(commandAt >= 0, `command row missing:\n${view}`)
  // The presenter rawInput renders pretty-printed (JSON.stringify(…, null, 2)).
  const rawAt = view.indexOf('"command": "sleep 5"')
  assert.ok(rawAt > commandAt, `command must render above the raw input:\n${view}`)
  app.stop()
})

test('injected context renders a web-style labeled row and expands to its body', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'system', turn: 0,
    text: '# AGENTS.md\nDo the thing carefully.\nNever break the build.',
    label: 'AGENTS.md',
  }])
  // Folded: the row names the producer, the body stays hidden.
  const folded = await viewport(vt)
  assert.ok(folded.includes('Context injection AGENTS.md'), `injected label missing:\n${folded}`)
  assert.ok(!folded.includes('Do the thing'), `injected body leaked while folded:\n${folded}`)
  // Expanded: the body appears under the labeled header.
  app.setToolOutputExpanded(true)
  const expanded = await viewport(vt)
  assert.ok(expanded.includes('Context injection AGENTS.md'), `labeled header missing when expanded:\n${expanded}`)
  assert.ok(expanded.includes('Do the thing carefully.'), `injected body missing:\n${expanded}`)
})

test('a notice injection folds with its one-line summary', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'system', turn: 0,
    text: '3 files written',
    label: 'todo',
    summary: 'saved the todo list',
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('Context injection todo — saved the todo list'), `notice summary missing:\n${view}`)
})

test('unlabeled system entries keep the section marker', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'system', turn: 0, text: 'llm retry 1/3 — BUSY: overloaded' }])
  const view = await viewport(vt)
  assert.ok(view.includes('§ llm retry'), `section marker missing:\n${view}`)
})





test('fullscreen mouse click toggles one card independently of the global fold', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript([
    { kind: 'user', turn: 0, text: 'hello' },
    { kind: 'thinking', turn: 0, text: 'one\ntwo\nthree' },
    { kind: 'tool', turn: 0, name: 'bash', args: '{"command":"ls"}', result: 'a\nb\nc', status: 'ok' },
    { kind: 'tool', turn: 0, name: 'bash', args: '{"command":"pwd"}', result: '/ws', status: 'ok' },
  ])
  await viewport(vt)
  // Rows (blank spacers between blocks): header(1) + user(2) + thinking(4)
  // + tool1(6) + tool2(8) inside the scroll pane. Click the first tool card:
  // it alone expands.
  vt.sendInput('\x1b[<0;10;8M')
  vt.sendInput('\x1b[<0;10;8m')
  let view = await viewport(vt)
  assert.ok(view.includes('\nb'), `clicked card body missing:\n${view}`)
  assert.ok(view.includes('Bash ls [ok]'), `clicked card header missing:\n${view}`)
  assert.ok(!view.includes('\nthree'), `thinking must stay folded after the click:\n${view}`)
  assert.ok(!view.includes('\n/ws'), `second tool card must stay folded:\n${view}`)
  // Clicking the same row again collapses just that card. The second click
  // waits past the alt screen's double-click window (a fast repeat selects
  // a word, like a native terminal).
  await new Promise(resolve => setTimeout(resolve, 600))
  vt.sendInput('\x1b[<0;10;8M')
  vt.sendInput('\x1b[<0;10;8m')
  view = await viewport(vt)
  assert.ok(!view.includes('\nb'), `card must collapse again:\n${view}`)
  // The keyboard Ctrl+O still expands everything, mouse state or not.
  vt.sendInput('\x0f')
  view = await viewport(vt)
  assert.ok(view.includes('\nthree'), `global expand must show thinking:\n${view}`)
  assert.ok(view.includes('\nc'), `global expand must show the tool body:\n${view}`)
  assert.ok(view.includes('\n/ws'), `global expand must show the second card:\n${view}`)
  app.setFullscreen(false)
})

test('fullscreen click on a thinking row expands it; wheel, right button, and drag stay inert', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript([
    { kind: 'thinking', turn: 0, text: 'line one\nline two\nline three' },
    { kind: 'tool', turn: 0, name: 'bash', args: '{"command":"ls"}', result: 'a\nb\nc', status: 'ok' },
  ])
  await viewport(vt)
  // Rows: header(1) + thinking(2) + tool(3). Click the thinking row.
  vt.sendInput('\x1b[<0;5;2M')
  vt.sendInput('\x1b[<0;5;2m')
  let view = await viewport(vt)
  assert.ok(view.includes('\nline two'), `thinking body missing after click:\n${view}`)
  assert.ok(!view.includes('\nb'), `tool card must stay folded:\n${view}`)
  // A drag (press + moved release) must not toggle either card.
  vt.sendInput('\x1b[<0;5;2M')
  vt.sendInput('\x1b[<0;20;2m')
  await viewport(vt)
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('\nline two'), `a drag must not collapse the card:\n${view}`)
  assert.ok(!view.includes('\nb'), `a drag must not expand the tool card:\n${view}`)
  // A wheel scroll and a right-button press/release must not toggle anything.
  vt.sendInput('\x1b[<64;5;2M')
  vt.sendInput('\x1b[<2;5;2M')
  vt.sendInput('\x1b[<2;5;2m')
  await viewport(vt)
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('\nline two'), `wheel/right must not collapse the card:\n${view}`)
  assert.ok(!view.includes('\nb'), `wheel/right must not expand the tool card:\n${view}`)
  app.setFullscreen(false)
})



test('tool card headers carry a per-variant emoji', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'tool', turn: 0, name: 'read', args: '{"file_path":"/ws/src/foo.ts"}', result: 'x', status: 'ok' },
    { kind: 'tool', turn: 0, name: 'bash', args: '{"command":"ls"}', result: 'x', status: 'ok' },
    { kind: 'tool', turn: 0, name: 'grep', args: '{"pattern":"foo"}', result: 'x', status: 'ok' },
    { kind: 'tool', turn: 0, name: 'subagent', args: 'worker', result: '', status: 'ok' },
  ])
  const view = await viewport(vt)
  assert.ok(view.includes('📖  Read /ws/src/foo.ts'), `read emoji missing:\n${view}`)
  assert.ok(view.includes('🖥️  Bash ls'), `bash emoji missing:\n${view}`)
  assert.ok(view.includes('🔍  Search foo'), `search emoji missing:\n${view}`)
  assert.ok(view.includes('🤖  Subagent worker'), `subagent emoji missing:\n${view}`)
})

test('regular mode leaves the mouse entirely to the terminal (no click handling)', async () => {
  // pi parity: regular mode never enables mouse reporting, so terminal-native
  // selection and scrollback scrolling stay intact. A stray SGR sequence is
  // still inert and never disturbs the editor.
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'tool', turn: 0, name: 'bash', args: '{"command":"ls"}', result: 'a\nb\nc', status: 'ok' },
  ])
  await viewport(vt)
  vt.sendInput('\x1b[<0;10;2M')
  vt.sendInput('\x1b[<0;10;2m')
  await viewport(vt)
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('\nb'), `regular mode must not react to clicks:\n${view}`)
})

test('tool cards degrade to generic rendering when the registry lookup is absent', async () => {
  // Mirrors the production guard: the registry is read through ctx.get and
  // may be absent (or hide behind cordis's inject guard), in which case the
  // presenter yields no views and cards render generically instead of failing.
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: toolPresenterFrom(() => undefined),
  })
  app.start()
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'read',
    args: '{"file_path":"/ws/src/foo.ts"}',
    result: 'line one', status: 'ok', resultBlocks: [],
  }])
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Read /ws/src/foo.ts [ok]'), `generic header missing:\n${view}`)
  assert.ok(view.includes('line one'), `generic body missing:\n${view}`)
  app.stop()
})

test('injected context rows show their emoji in the viewport', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'system', turn: 0,
    text: '# AGENTS.md\nRead me first.',
    label: 'AGENTS.md',
    emoji: '📄',
  }, {
    kind: 'system', turn: 0,
    text: 'catalog',
    label: 'skill-catalog',
    emoji: '📚',
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('📄  Context injection AGENTS.md'), `instruction emoji missing:\n${view}`)
  assert.ok(view.includes('📚  Context injection skill-catalog'), `catalog emoji missing:\n${view}`)
})

test('slash command cards carry a control-panel emoji', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'tool', turn: 0, name: '/compact', args: '', result: 'executed', status: 'ok' },
  ])
  const view = await viewport(vt)
  assert.ok(view.includes('🎛️  compact [ok]'), `slash emoji missing:\n${view}`)
})






test('read envelopes parse single, merged, and non-envelope results', () => {
  const single = `<path>/ws/a.ts</path>
<type>file</type>
<content>
1: line one
2: line two

(End of file - total 2 lines)
</content>`
  const envelopes = parseReadEnvelopes(single)
  assert.equal(envelopes.length, 1)
  assert.equal(envelopes[0]?.path, '/ws/a.ts')
  assert.equal(envelopes[0]?.lines.length, 2)
  assert.equal(envelopes[0]?.lines[1]?.text, 'line two')
  assert.equal(envelopes[0]?.totalLines, 2)
  // Merged group card: two consecutive envelopes parse into two entries.
  const merged = `${single}\n\n${single.replace('/ws/a.ts', '/ws/b.ts')}`
  const mergedEnvelopes = parseReadEnvelopes(merged)
  assert.equal(mergedEnvelopes.length, 2)
  assert.equal(mergedEnvelopes[1]?.path, '/ws/b.ts')
  // Not an envelope: no entries, no throw.
  assert.equal(parseReadEnvelopes('plain output').length, 0)
  assert.equal(parseReadEnvelopes('').length, 0)
})

test('read cards preview their envelope summary, never the raw XML', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'read',
    args: '{"file_path":"/ws/a.ts"}',
    result: `<path>/ws/a.ts</path>
<type>file</type>
<content>
1: line one
2: line two

(End of file - total 2 lines)
</content>`,
    status: 'ok',
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('Read /ws/a.ts [ok] — 2 lines'), `summary preview missing:\n${view}`)
  assert.ok(!view.includes('<path>'), `raw envelope leaked into the folded row:\n${view}`)
  assert.ok(!view.includes('<content>'), `raw content leaked into the folded row:\n${view}`)
})

test('merged read groups expand into one tree row per file', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: toolPresenterFrom(() => undefined),
    workspaceRoot: '/ws',
  })
  app.start()
  app.setToolOutputExpanded(true)
  // The merged card is what groupConsecutiveReads produces: args "N files"
  // plus the consecutive envelopes joined in the result.
  const envelopeA = `<path>/ws/a.ts</path>\n<type>file</type>\n<content>\n1: a\n\n(End of file - total 1 lines)\n</content>`
  const envelopeB = envelopeA.replace('/ws/a.ts', '/ws/b.ts').replace('1: a', '1: b')
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'read',
    args: '2 files',
    result: `${envelopeA}\n\n${envelopeB}`,
    status: 'ok',
  }])
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('├─ a.ts · 1 lines'), `first tree row missing:\n${view}`)
  assert.ok(view.includes('└─ b.ts · 1 lines'), `last tree row missing:\n${view}`)
  assert.ok(!view.includes('<path>'), `raw XML leaked:\n${view}`)
  app.stop()
})

test('assistant and user messages align continuation lines under the bullet', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'user', turn: 0, text: 'line one\nline two' },
    { kind: 'assistant', turn: 0, text: 'para one\n\npara two' },
  ])
  const view = await viewport(vt)
  const lines = view.split('\n')
  const user = lines.findIndex(line => line.includes('❯ line one'))
  assert.ok(user >= 0, `user first line missing:\n${view}`)
  assert.ok(lines[user + 1]?.includes('line two'), `user continuation must follow on the next row:\n${view}`)
  assert.ok(!lines[user + 1]!.includes('❯'), `user continuation must not repeat the bullet:\n${view}`)
  // The assistant whale leads the first paragraph; the second paragraph's
  // first line indents under the bullet (a markdown blank line sits between).
  const assistant = lines.findIndex(line => line.includes('🐋') && line.includes('para one'))
  assert.ok(assistant >= 0, `assistant first line missing:\n${view}`)
  const paraTwo = lines.findIndex(line => line.includes('para two'))
  assert.ok(paraTwo > assistant, `assistant continuation missing:\n${view}`)
  assert.ok(!lines[paraTwo]!.includes('🐋'), `continuation must not repeat the bullet:\n${view}`)
  assert.ok(lines[paraTwo]!.startsWith('    '), `continuation must indent under the bullet:\n${view}`)
})

test('BulletedComponent keeps a live child with reference-stable output', () => {
  const child = new Text('hello world', 0, 0)
  const bullet = new BulletedComponent(child, '❯ ')
  const first = bullet.render(40)
  assert.equal(first[0]!.trimEnd(), '❯ hello world', `first line must lead with the bullet:\n${first}`)
  // Same width: the SAME array reference comes back (the fork's per-frame
  // processed-line reuse keys on reference identity — a rebuilt array every
  // frame would degrade divergence 5 for every assistant/user line).
  assert.equal(bullet.render(40), first, 'same-width renders must reuse the same array')
  // A narrower width re-renders the live child: wrapped continuation lines
  // indent under the bullet instead of repeating it.
  const narrow = bullet.render(10)
  assert.notEqual(narrow, first, 'a width change must rebuild the output')
  assert.ok(narrow[0]!.startsWith('❯ '), `first line must keep the bullet:\n${narrow}`)
  assert.ok(narrow.slice(1).every(line => line.startsWith('  ')), `continuation must indent:\n${narrow}`)
})

test('assistant markdown tables reflow on terminal resize', async () => {
  const { vt, app } = startApp(80)
  const table = [
    '| name | description |',
    '| --- | --- |',
    '| alpha | a fairly long description that should wrap when the window is narrow |',
    '| beta | another longish description with bold and **inline code** tokens |',
    '| gamma | short |',
  ].join('\n')
  app.setTranscript([{ kind: 'assistant', turn: 0, text: table }])
  let view = await viewport(vt)
  let top = view.split('\n').find(line => line.includes('┌'))
  assert.ok(top !== undefined, `table missing at 80:\n${view}`)
  assert.ok(top.includes('┐'), `border split across rows at 80:\n${view}`)
  const wide = top.length

  vt.resize(120, 24)
  view = await viewport(vt)
  top = view.split('\n').find(line => line.includes('┌'))
  assert.ok(top !== undefined && top.includes('┐'), `border broken after widening:\n${view}`)
  assert.ok(top.length > wide, `table must reflow wider after resize (was ${wide}, now ${top.length}):\n${view}`)

  vt.resize(60, 24)
  view = await viewport(vt)
  top = view.split('\n').find(line => line.includes('┌'))
  assert.ok(top !== undefined && top.includes('┐'), `border must not split into plain text after narrowing:\n${view}`)
  assert.ok(top.length < wide, `table must reflow narrower after resize:\n${view}`)
  assert.ok(top.length <= 60, `table must fit the terminal (${top.length} > 60):\n${view}`)
})

test('workflow runs expand into a phase-grouped member tree', async () => {
  const { vt, app } = startApp()
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'tool',
    turn: 0,
    name: 'workflow',
    args: 'audit',
    result: 'stop: completed',
    status: 'ok',
    members: [
      { label: 'checker', phase: 'review', status: 'ok' },
      { label: 'patcher', phase: 'review', status: 'error' },
      { label: 'reporter', phase: 'report', status: 'ok' },
      { label: 'live-agent', status: 'running' },
    ],
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('Workflow audit [ok]'), `run header missing:\n${view}`)
  assert.ok(view.includes('  review'), `phase header missing:\n${view}`)
  assert.ok(view.includes('checker — completed'), `completed member missing:\n${view}`)
  assert.ok(view.includes('patcher — failed'), `failed member missing:\n${view}`)
  assert.ok(view.includes('  report'), `second phase missing:\n${view}`)
  assert.ok(view.includes('reporter — completed'), `report member missing:\n${view}`)
  assert.ok(view.includes('live-agent — running'), `running member missing:\n${view}`)
})

test('workflow runs stay a single folded row until expanded', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'tool',
    turn: 0,
    name: 'workflow',
    args: 'audit',
    result: 'stop: completed',
    status: 'ok',
    members: [{ label: 'checker', phase: 'review', status: 'ok' }],
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('Workflow audit [ok]'), `folded header missing:\n${view}`)
  assert.ok(!view.includes('checker — completed'), `members leaked while folded:\n${view}`)
})

test('askQuestions marks recommended options and renders detail blocks', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Pick one?',
    detail: 'Some context about the choice.',
    options: [
      { label: 'Plain' },
      { label: 'Best (recommended)' },
    ],
  }])
  let view = await viewport(vt)
  assert.ok(view.includes('Some context about the choice.'), `detail missing:\n${view}`)
  assert.ok(view.includes('[recommended]'), `recommended badge missing:\n${view}`)
  assert.ok(!view.includes('(recommended)'), `suffix must be stripped from the display:\n${view}`)
  vt.sendInput('\r') // the recommended row is the default highlight → review
  await viewport(vt)
  vt.sendInput('\r') // review: submit
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['Best (recommended)'] }])
})

test('askQuestions skip pages through and preserves drafts', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([
    { id: 'q1', question: 'First?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Second?' },
  ])
  await viewport(vt)
  vt.sendInput('s') // skip Q1 (empty answer)
  await viewport(vt)
  let view = await viewport(vt)
  assert.ok(view.includes('Second?'), `skipped past the first question:\n${view}`)
  vt.sendInput('hello')
  vt.sendInput('\r') // commit the typed answer → review page
  await viewport(vt)
  // b returns from the review page; drafts survive the round trip.
  vt.sendInput('b')
  await viewport(vt)
  view = await viewport(vt)
  assert.ok(view.includes('Second?'), `back to the second question:\n${view}`)
  vt.sendInput('\x1b[D') // Q2 text mode: ← pages back to Q1
  await viewport(vt)
  view = await viewport(vt)
  assert.ok(view.includes('First?'), `back to the first question:\n${view}`)
  vt.sendInput('\x1b[C') // back to Q2
  await viewport(vt)
  vt.sendInput('\x1b[C') // Q2 → review
  await viewport(vt)
  vt.sendInput('\r') // submit
  assert.deepEqual(await promise, [
    { id: 'q1', selected: [] },
    { id: 'q2', selected: [], custom: 'hello' },
  ])
})

test('askQuestions review page shows every answer before submitting', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([
    { id: 'q1', question: 'One?', options: [{ label: 'X' }] },
    { id: 'q2', question: 'Two?', options: [{ label: 'Y' }] },
  ])
  await viewport(vt)
  vt.sendInput('1')
  await viewport(vt)
  vt.sendInput('1')
  await viewport(vt)
  const view = await viewport(vt)
  assert.ok(view.includes('Review your answer before submit'), `review page missing:\n${view}`)
  assert.ok(view.includes('One?'), `Q1 answer missing:\n${view}`)
  assert.ok(view.includes('Two?'), `Q2 answer missing:\n${view}`)
  assert.ok(view.includes('X'), `Q1 value missing:\n${view}`)
  assert.ok(view.includes('Y'), `Q2 value missing:\n${view}`)
  vt.sendInput('\r') // submit
  assert.deepEqual(await promise, [
    { id: 'q1', selected: ['X'] },
    { id: 'q2', selected: ['Y'] },
  ])
})

test('an aborted signal settles the question flow as cancelled', async () => {
  const { vt, app } = startApp()
  const controller = new AbortController()
  const promise = app.askQuestions([{ id: 'q1', question: 'Any?', options: [{ label: 'Yes' }] }], controller.signal)
  await viewport(vt)
  controller.abort()
  await assert.rejects(promise, /cancelled/)
  const view = await viewport(vt)
  assert.ok(!view.includes('Any?'), `dialog must close on abort:\n${view}`)
  void vt
})

test('ask_user_question cards carry the Question identity and a friendly summary', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'tool', turn: 0, name: 'ask_user_question', args: '{"questions":[{"id":"q","question":"Go?"}]}', result: '', status: 'running' },
  ])
  const view = await viewport(vt)
  assert.ok(view.includes('❓  Question'), `question card missing:\n${view}`)
  assert.ok(view.includes('Go?'), `question text summary missing:\n${view}`)
  assert.ok(!view.includes('Tool call'), `generic card leaked:\n${view}`)
  assert.ok(!view.includes('"questions"'), `raw args JSON leaked into the summary:\n${view}`)
})

test('web search result views render sources and the answer (WebBlock parity)', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => undefined,
      result: () => ({
        card: 'web', kind: 'search', truncated: true,
        answer: 'The harness renders cards.',
        sources: [
          { url: 'https://example.com/a', title: 'Card docs', snippet: 'How cards render.' },
          { url: 'https://example.com/b' },
        ],
      }),
    },
  })
  app.start()
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'web_search',
    args: '{"query":"dsh cards"}',
    result: 'raw model-facing text must not appear',
    status: 'ok',
    resultBlocks: [{ type: 'text', text: 'raw model-facing text must not appear' }],
  }])
  app.setToolOutputExpanded(true)
  const view = await viewport(vt)
  assert.ok(view.includes('The harness renders cards.'), `answer missing:\n${view}`)
  assert.ok(view.includes('• Card docs — https://example.com/a'), `source title-url missing:\n${view}`)
  assert.ok(view.includes('  How cards render.'), `source snippet missing:\n${view}`)
  assert.ok(view.includes('• https://example.com/b'), `untitled source missing:\n${view}`)
  assert.ok(view.includes('… truncated — more sources omitted'), `truncation marker missing:\n${view}`)
  assert.ok(!view.includes('raw model-facing text'), `raw result leaked:\n${view}`)
  app.stop()
})

test('web fetch result views render the URL and HTTP status', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => undefined,
      result: () => ({ card: 'web', kind: 'fetch', url: 'https://example.com/page', statusCode: 200, truncated: false }),
    },
  })
  app.start()
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'web_fetch',
    args: '{"url":"https://example.com/page"}',
    result: 'raw body', status: 'ok', resultBlocks: [{ type: 'text', text: 'raw body' }],
  }])
  app.setToolOutputExpanded(true)
  const view = await viewport(vt)
  assert.ok(view.includes('https://example.com/page — HTTP 200'), `fetch summary missing:\n${view}`)
  assert.ok(!view.includes('raw body'), `raw body leaked:\n${view}`)
  app.stop()
})

test('todo_write rawInput renders as a checklist instead of pretty JSON', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => ({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: {
        todos: [
          { content: 'fix tests', status: 'in_progress' },
          { content: 'ship it', status: 'pending' },
          { content: 'done thing', status: 'completed' },
        ],
      } }),
      result: () => undefined,
    },
  })
  app.start()
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'todo_write',
    args: JSON.stringify({ todos: [
      { content: 'fix tests', status: 'in_progress' },
      { content: 'ship it', status: 'pending' },
      { content: 'done thing', status: 'completed' },
    ] }),
    result: '', status: 'running',
  }])
  app.setToolOutputExpanded(true)
  const view = await viewport(vt)
  assert.ok(view.includes('● fix tests'), `active item missing:\n${view}`)
  assert.ok(view.includes('○ ship it'), `pending item missing:\n${view}`)
  assert.ok(view.includes('✓ done thing'), `completed item missing:\n${view}`)
  assert.ok(!view.includes('"todos"'), `raw JSON leaked:\n${view}`)
  app.stop()
})

test('exit_plan_mode renders its content plan body while running', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => ({
        card: 'generic', title: 'The Plan', kind: 'other',
        content: [{ type: 'text', text: '# The Plan\nStep one.\nStep two.' }],
      }),
      result: () => undefined,
    },
  })
  app.start()
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'exit_plan_mode',
    args: JSON.stringify({ plan: '# The Plan\nStep one.\nStep two.' }),
    result: '', status: 'running',
  }])
  app.setToolOutputExpanded(true)
  const view = await viewport(vt)
  assert.ok(view.includes('Step one.'), `plan body missing:\n${view}`)
  assert.ok(view.includes('Step two.'), `plan body truncated:\n${view}`)
  assert.ok(!view.includes('"plan"'), `raw JSON leaked:\n${view}`)
  app.stop()
})

test('generic result content renders instead of the raw model-facing text', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => undefined,
      result: () => ({ card: 'generic', title: 'Plan review', content: [{ type: 'text', text: 'The plan was approved.' }] }),
    },
  })
  app.start()
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'exit_plan_mode',
    args: '{"plan":"x"}', result: 'raw plan review', status: 'ok',
    resultBlocks: [{ type: 'text', text: 'raw plan review' }],
  }])
  app.setToolOutputExpanded(true)
  const view = await viewport(vt)
  assert.ok(view.includes('The plan was approved.'), `generic result content missing:\n${view}`)
  assert.ok(!view.includes('raw plan review'), `raw result text leaked:\n${view}`)
  app.stop()
})

test('folded todo cards preview done/total counts', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'todo_write',
    args: JSON.stringify({ todos: [
      { content: 'one', status: 'completed' },
      { content: 'two', status: 'completed' },
      { content: 'three', status: 'pending' },
    ] }),
    result: '', status: 'ok',
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('2/3 done'), `folded todo count missing:\n${view}`)
  assert.ok(view.includes('three'), `first active item missing:\n${view}`)
})

test('folded web cards preview the query/url without repeating the header', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'tool', turn: 0, name: 'web_search', args: '{"query":"dsh cards"}', result: 'x', status: 'ok' },
    { kind: 'tool', turn: 0, name: 'web_fetch', args: '{"url":"https://example.com/p"}', result: 'x', status: 'ok' },
  ])
  const view = await viewport(vt)
  // The header summary already carries the query/url (SUMMARY_KEYS), so the
  // folded row shows it once — never duplicated by a preview suffix.
  assert.ok(view.includes('Search dsh cards'), `folded web_search query missing:\n${view}`)
  assert.ok(view.includes('https://example.com/p'), `folded web_fetch url missing:\n${view}`)
  const searchRow = view.split('\n').find(line => line.includes('dsh cards'))
  assert.ok(searchRow !== undefined && !searchRow.includes('— dsh cards'), `query duplicated on the folded row:\n${view}`)
})

test('webCardLines pure helper renders both search and fetch shapes', () => {
  assert.deepEqual(webCardLines({
    card: 'web', kind: 'search', truncated: true, answer: 'A.',
    sources: [{ url: 'https://e.com', title: 'T', snippet: 'S.' }],
  }), ['A.', '• T — https://e.com', '  S.', '… truncated — more sources omitted'])
  assert.deepEqual(webCardLines({
    card: 'web', kind: 'fetch', url: 'https://e.com', statusCode: 404, truncated: false,
  }), ['https://e.com — HTTP 404'])
})

test('genericRawInputLines structures todo/session/terminal payloads', () => {
  assert.deepEqual(genericRawInputLines('todo_write', {
    todos: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'completed' },
    ],
  }), ['● a', '✓ b'])
  assert.deepEqual(genericRawInputLines('session_event_read', { seq: 7, session_id: 's1' }), ['s1 · seq 7'])
  assert.deepEqual(genericRawInputLines('terminal_send', { sessionId: 'main', text: 'go' }), ['session main: go'])
  assert.deepEqual(genericRawInputLines('unknown_tool', { a: 1 }), ['{', '  "a": 1', '}'])
  assert.deepEqual(genericRawInputLines('skill', 'my-skill'), ['my-skill'])
})

test('foldedCallPreview pure helper derives todo/web/skill previews', () => {
  assert.equal(foldedCallPreview('todo_write', JSON.stringify({ todos: [
    { content: 'one', status: 'completed' },
    { content: 'two', status: 'pending' },
  ] })), ' — 1/2 done · two')
  assert.equal(foldedCallPreview('web_search', '{"query":"dsh"}'), ' — dsh')
  assert.equal(foldedCallPreview('web_fetch', '{"url":"https://e.com"}'), ' — https://e.com')
  assert.equal(foldedCallPreview('skill', '{"name":"reclaim"}'), ' — reclaim')
  assert.equal(foldedCallPreview('bash', '{"command":"ls"}'), '')
})

test('resultTextLines flattens blocks with the Web resultText semantics', () => {
  assert.deepEqual(resultTextLines([{ type: 'text', text: 'one\ntwo' }]), ['one', 'two'])
  assert.deepEqual(resultTextLines([{ type: 'reasoning', text: 'think' }]), ['{\n  "type": "reasoning",\n  "text": "think"\n}'])
  assert.deepEqual(resultTextLines([], { name: 'Error', code: 'E_BAD' }), ['Error: E_BAD'])
  assert.deepEqual(resultTextLines([]), [])
})
