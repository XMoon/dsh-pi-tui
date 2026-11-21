/**
 * PR1 Question pointer journey on the REAL PiTui application route: a real
 * `TuiApp`, the real `TuiAltScreen` SGR mouse listener and the real
 * `QuestionFlow`/`QuestionFrame` — no mock app and no direct handler call.
 *
 * Evidence level: application/headless (VirtualTerminal). It proves the
 * PiTui event chain and the visible painted state; it is not a physical
 * mouse check and it does not claim the DSH Host answer wire.
 *
 * @module @xmoon76/dsh-pi-tui/question-pointer.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TuiApp } from '../../src/tui-app.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

function startApp(columns = 80, rows = 24): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(columns, rows)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

async function view(vt: VirtualTerminal): Promise<string[]> {
  await vt.waitForRender()
  return vt.getViewport()
}

/** One 1-based SGR cell of a painted label. */
function cellOf(lines: readonly string[], label: string): { x: number; y: number } {
  for (let index = 0; index < lines.length; index += 1) {
    const column = lines[index]!.indexOf(label)
    if (column !== -1) return { x: column + 1, y: index + 1 }
  }
  throw new Error(`label not painted: ${label}\n${lines.join('\n')}`)
}

function press(vt: VirtualTerminal, cell: { x: number; y: number }): void {
  vt.sendInput(`\x1b[<0;${cell.x};${cell.y}M`)
}

function release(vt: VirtualTerminal, cell: { x: number; y: number }): void {
  vt.sendInput(`\x1b[<0;${cell.x};${cell.y}m`)
}

function click(vt: VirtualTerminal, cell: { x: number; y: number }): void {
  press(vt, cell)
  release(vt, cell)
}

function wheel(vt: VirtualTerminal, direction: 'up' | 'down', cell: { x: number; y: number }): void {
  vt.sendInput(`\x1b[<${direction === 'up' ? 64 : 65};${cell.x};${cell.y}M`)
}

/** The painted Question frame bounds (0-based viewport row indexes). */
function frameBounds(lines: readonly string[]): { top: number; bottom: number } | undefined {
  const top = lines.findIndex(line => line.includes('╭'))
  const bottom = lines.findIndex(line => line.includes('╰'))
  return top >= 0 && bottom >= top ? { top, bottom } : undefined
}

const LONG_DETAIL = Array.from({ length: 60 }, (_, index) =>
  `detail-${String(index).padStart(2, '0')} ${'y'.repeat(70)}`).join('\n')

test('a pointer-only journey navigates tabs, reviews and submits exactly once', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await view(vt)
  let settled = false
  const answersPromise = app.askQuestions([
    { id: 'q1', question: 'FIRST-QUESTION?', options: [{ label: 'ALPHA' }, { label: 'BETA' }] },
    { id: 'q2', question: 'SECOND-QUESTION?', options: [{ label: 'GAMMA' }, { label: 'DELTA' }] },
    { id: 'q3', question: 'THIRD-QUESTION?', options: [{ label: 'EPSILON' }] },
  ]).then((answers) => {
    settled = true
    return answers
  })
  let lines = await view(vt)
  assert.ok(lines.join('\n').includes('FIRST-QUESTION?'), 'Q1 opens first')
  click(vt, cellOf(lines, 'Q2'))
  lines = await view(vt)
  assert.ok(lines.join('\n').includes('SECOND-QUESTION?'), 'the Q2 tab jumps directly to Q2')
  click(vt, cellOf(lines, 'DELTA'))
  lines = await view(vt)
  assert.ok(lines.join('\n').includes('THIRD-QUESTION?'), 'the option click advances to Q3')
  click(vt, cellOf(lines, 'Review'))
  lines = await view(vt)
  assert.ok(lines.join('\n').includes('Review your answer before submit'), 'the Review tab paints the summary')
  assert.equal(settled, false, 'the Review tab never submits')
  click(vt, cellOf(lines, 'Submit'))
  const answers = await answersPromise
  assert.equal(settled, true, 'only the bottom Submit commits')
  assert.deepEqual(answers, [
    { id: 'q1', selected: [] },
    { id: 'q2', selected: ['DELTA'] },
    { id: 'q3', selected: [] },
  ])
})

test('the wheel scrolls the question body only and never the transcript behind it', async () => {
  const { vt, app } = startApp()
  // The Question wheel must use the SAME configured line step as the
  // transcript viewport (three lines per event here), never a page jump.
  app.setWheelScrollLines(3)
  app.setTranscript(Array.from({ length: 40 }, (_, index) => ({
    kind: 'user' as const,
    turn: index + 1,
    text: `TRANSCRIPT-LINE-${index}`,
  })))
  app.setFullscreen(true)
  await view(vt)
  // Put the transcript into browsing history so a background scroll would be
  // observable as a changed scrollTop.
  wheel(vt, 'up', { x: 10, y: 5 })
  await view(vt)
  const transcriptBefore = app.fullscreenScrollForTest()
  assert.ok(transcriptBefore !== undefined && transcriptBefore.scrollTop > 0,
    `precondition: the transcript is browsing history\n${JSON.stringify(transcriptBefore)}`)

  const question = app.askQuestions([{
    id: 'q1', question: 'LONG-QUESTION?', detail: LONG_DETAIL, options: [{ label: 'ALPHA' }],
  }])
  question.catch(() => {})
  let lines = await view(vt)
  const bounds = frameBounds(lines)
  assert.ok(bounds !== undefined, 'the Question frame must be painted')
  const bodyCell = { x: 10, y: bounds.top + 4 }
  wheel(vt, 'down', bodyCell)
  lines = await view(vt)
  assert.ok(lines.join('\n').includes('↑ 3 up'),
    `one wheel event must move exactly the configured three lines:\n${lines.join('\n')}`)
  for (let index = 0; index < 2; index += 1) wheel(vt, 'down', bodyCell)
  lines = await view(vt)
  assert.ok(!lines.join('\n').includes('detail-00'), `the question body must scroll:\n${lines.join('\n')}`)
  assert.equal(app.fullscreenScrollForTest()!.scrollTop, transcriptBefore.scrollTop,
    'a question-body wheel must not move the transcript')

  const scrolled = lines.join('\n')
  const currentBounds = frameBounds(lines)
  assert.ok(currentBounds !== undefined)
  // Tab strip, action bar and the transcript area outside the frame are all
  // inert: the outcome never leaves the Question frame's paint.
  wheel(vt, 'down', { x: 10, y: currentBounds.top + 2 })
  wheel(vt, 'down', { x: 10, y: currentBounds.bottom + 1 })
  wheel(vt, 'down', { x: 10, y: 3 })
  lines = await view(vt)
  assert.equal(lines.join('\n'), scrolled, 'a wheel outside the painted body must not repaint anything')
  assert.equal(app.fullscreenScrollForTest()!.scrollTop, transcriptBefore.scrollTop,
    'a wheel outside the painted body must not move the transcript')
})

test('a tab press cannot survive a terminal resize', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await view(vt)
  const question = app.askQuestions([
    { id: 'q1', question: 'FIRST-QUESTION?', options: [{ label: 'ALPHA' }] },
    { id: 'q2', question: 'SECOND-QUESTION?', options: [{ label: 'BETA' }] },
  ])
  question.catch(() => {})
  let lines = await view(vt)
  const cell = cellOf(lines, 'Q2')
  press(vt, cell)
  vt.resize(72, 24)
  await view(vt)
  release(vt, cell)
  lines = await view(vt)
  assert.ok(lines.join('\n').includes('FIRST-QUESTION?'), 'a resize between press and release must keep Q1')
})

test('a press from a cancelled Question cannot complete on the queued successor', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await view(vt)
  const first = app.askQuestions([
    { id: 'a1', question: 'FIRST-FLOW-Q1?', options: [{ label: 'A' }] },
    { id: 'a2', question: 'FIRST-FLOW-Q2?', options: [{ label: 'B' }] },
  ])
  const second = app.askQuestions([
    { id: 'b1', question: 'SECOND-FLOW-Q1?', options: [{ label: 'C' }] },
    { id: 'b2', question: 'SECOND-FLOW-Q2?', options: [{ label: 'D' }] },
  ])
  first.catch(() => {})
  second.catch(() => {})
  let lines = await view(vt)
  press(vt, cellOf(lines, 'Q2'))
  vt.sendInput('\x1b') // cancel the first flow; the queued flow takes the seat
  lines = await view(vt)
  assert.ok(lines.join('\n').includes('SECOND-FLOW-Q1?'), 'the queued flow is presented')
  release(vt, cellOf(lines, 'Q2'))
  lines = await view(vt)
  assert.ok(lines.join('\n').includes('SECOND-FLOW-Q1?'),
    'the cancelled flow\'s press must never navigate its successor')
  vt.sendInput('\x1b')
  await Promise.allSettled([first, second])
})

test('Regular/Main keeps no application Question pointer route', async () => {
  const { vt, app } = startApp()
  const question = app.askQuestions([
    { id: 'q1', question: 'FIRST-QUESTION?', options: [{ label: 'ALPHA' }] },
    { id: 'q2', question: 'SECOND-QUESTION?', options: [{ label: 'BETA' }] },
  ])
  question.catch(() => {})
  let lines = await view(vt)
  click(vt, cellOf(lines, 'Q2'))
  lines = await view(vt)
  assert.ok(lines.join('\n').includes('FIRST-QUESTION?'), 'a Regular tab click must not navigate')
  const before = lines.join('\n')
  wheel(vt, 'down', { x: 10, y: 10 })
  lines = await view(vt)
  assert.equal(lines.join('\n'), before, 'a Regular wheel has no application route')
  assert.equal(app.fullscreenScrollForTest(), undefined, 'Regular has no alt-screen transcript')
})

test('a focused overlay above the Question owns the pointer plane and keeps the covered body inert', async () => {
  const { vt, app } = startApp()
  app.setTranscript(Array.from({ length: 40 }, (_, index) => ({
    kind: 'user' as const,
    turn: index + 1,
    text: `TRANSCRIPT-LINE-${index}`,
  })))
  app.setFullscreen(true)
  await view(vt)
  wheel(vt, 'up', { x: 10, y: 5 })
  await view(vt)
  const transcriptBefore = app.fullscreenScrollForTest()
  assert.ok(transcriptBefore !== undefined && transcriptBefore.scrollTop > 0)

  const question = app.askQuestions([{
    id: 'q1', question: 'LONG-QUESTION?', detail: LONG_DETAIL, options: [{ label: 'ALPHA' }],
  }])
  question.catch(() => {})
  let lines = await view(vt)
  assert.ok(lines.join('\n').includes('detail-00'), 'precondition: the question body is at its top')
  const overlay = app.showAdvancedInteractiveOverlay({
    render: () => ({ kind: 'text' as const, spans: [{ text: 'OVERLAY-COVER' }] }),
  }, { width: 30, maxHeight: 5 })
  overlay.focus()
  lines = await view(vt)
  assert.ok(lines.join('\n').includes('OVERLAY-COVER'), 'the explicit overlay must paint above the Question')
  const cell = cellOf(lines, 'OVERLAY-COVER')
  const before = lines.join('\n')
  wheel(vt, 'down', cell)
  lines = await view(vt)
  assert.equal(lines.join('\n'), before,
    'a wheel on the focused overlay plane must not scroll the covered question body')
  assert.equal(app.fullscreenScrollForTest()!.scrollTop, transcriptBefore.scrollTop,
    'the overlay wheel must not leak into the background transcript')

  overlay.close()
  lines = await view(vt)
  const bounds = frameBounds(lines)
  assert.ok(bounds !== undefined)
  wheel(vt, 'down', { x: 10, y: bounds.top + 4 })
  lines = await view(vt)
  assert.ok(lines.join('\n').includes('↑ 1 up'),
    'after the overlay closes, the question body owns the wheel again')
})

test('a real wheel scroll invalidates a pending tab or action press', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  await view(vt)
  const question = app.askQuestions([
    { id: 'q1', question: 'LONG-FIRST?', detail: LONG_DETAIL, options: [{ label: 'ALPHA' }] },
    { id: 'q2', question: 'SECOND?', options: [{ label: 'BETA' }] },
  ])
  question.catch(() => {})
  let lines = await view(vt)
  const bounds = frameBounds(lines)
  assert.ok(bounds !== undefined)
  const bodyCell = { x: 10, y: bounds.top + 4 }
  // A pending tab press cannot complete after the body really scrolled.
  const q2 = cellOf(lines, 'Q2')
  press(vt, q2)
  wheel(vt, 'down', bodyCell)
  await view(vt)
  release(vt, q2)
  lines = await view(vt)
  const currentTab = (): number =>
    (app as unknown as { activeQuestions: { flow: { draftSnapshot(): { tab: number } } } })
      .activeQuestions.flow.draftSnapshot().tab
  assert.equal(currentTab(), 0, 'a tab pressed before a real wheel scroll must not navigate on release')
  // A pending action press cannot complete either.
  const skip = cellOf(lines, 'Skip')
  press(vt, skip)
  wheel(vt, 'down', bodyCell)
  await view(vt)
  release(vt, skip)
  lines = await view(vt)
  assert.equal(currentTab(), 0, 'an action pressed before a real wheel scroll must not run on release')
})
