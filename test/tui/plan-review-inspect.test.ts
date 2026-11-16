/**
 * The plan-review inspection over a REAL mounted app (FR7 A4): the host seam
 * resolves the OFFICIAL `intent.callId` against the CURRENT transcript (a
 * native tool card or a nested PTC sub-call), reveals the card through the
 * existing search-reveal machinery, scrolls the SAME fullscreen ScrollView,
 * and the mounted question keeps its seat and answerability across the
 * whole read→back→answer journey.
 * @module @xmoon76/dsh-pi-tui/plan-review-inspect.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { TuiApp, type TuiAppOptions } from '../../src/tui-app.ts'
import type { TranscriptMessage } from '../../src/transcript.ts'
import { createClientToolPresenter } from '../../src/tui/transcript/client-tool-presenter.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

const PLAN_MD = '# Upgrade 0.5.7\n## Scope\n- goal dock\n- plan review\n## Execution\nship it'

function transcript(callId?: string): TranscriptMessage[] {
  return [
    { kind: 'user', turn: 0, text: 'plan the upgrade' },
    { kind: 'assistant', turn: 0, text: 'Here is my plan.' },
    {
      kind: 'tool', turn: 1, name: 'exit_plan_mode', ...(callId === undefined ? {} : { callId }),
      args: JSON.stringify({ plan: PLAN_MD }), result: '', status: 'running',
    },
    ...Array.from({ length: 10 }, (_, i) => ({
      kind: 'user' as const, turn: 2 + i, text: `filler turn ${i} ${'x'.repeat(60)}`,
    })),
  ]
}

function view(vt: VirtualTerminal): string {
  return stripTerminalSequences(vt.getViewport().join('\n'))
}

interface Scene {
  vt: VirtualTerminal
  app: TuiApp
  settle: Promise<{ id: string; selected: string[]; custom?: string }[]>
  cancelled: () => number
}

/** The OFFICIAL Direct `presentCall` shape for exit_plan_mode (what
 * toolPresenterFrom forwards from the host registry). */
const directPlanPresenter = {
  call: (name: string, argsRaw: string) => {
    if (name !== 'exit_plan_mode') return undefined
    const plan = (JSON.parse(argsRaw) as { plan?: string }).plan ?? ''
    const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(plan)?.[1] ?? 'Plan'
    return { card: 'generic' as const, title: heading, kind: 'other' as const, content: [{ type: 'text' as const, text: plan }] }
  },
  result: () => undefined,
}

const SESSION = 'session-plan-review'

function scene(
  messages: TranscriptMessage[],
  width = 100,
  height = 24,
  options: TuiAppOptions = {},
  /** The official Question's session identity; `null` means "unknown" (an
   * explicit `undefined` argument would re-trigger the default). */
  reviewSessionId: string | null = SESSION,
): Scene {
  const vt = new VirtualTerminal(width, height)
  let cancelledCount = 0
  let app!: TuiApp
  app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, options)
  app.start()
  startedApps.add(app)
  // The production identity facts: the live session id on the welcome card and
  // the official Question's own session id in the caller-owned status.
  app.setWelcomeCard({ cwd: '/ws', sessionId: SESSION, version: 'test' })
  app.setFullscreen(true)
  app.setTranscript(messages)
  const settle = app.askQuestions([{
    id: 'plan-review',
    question: 'Approve this plan and leave plan mode?',
    header: 'Plan review',
    detail: PLAN_MD,
    options: [
      { label: 'Approve', description: 'Leave plan mode.' },
      { label: 'Keep planning', description: 'Stay in plan mode.' },
    ],
    intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan-1' },
  }], undefined, reviewSessionId === null ? {} : { reviewSessionId }, false)
  return { vt, app, settle, cancelled: () => cancelledCount }
}

test('View plan reveals the called plan card body in the transcript and the answer still settles', async () => {
  // The REAL Direct presenter seam: the plan body comes from the official
  // generic call view, not from a test-only synthetic card.
  const { vt, app, settle } = scene(transcript('call-plan-1'), 100, 24, { present: directPlanPresenter })
  await vt.waitForRender()
  // Park the viewport at the bottom so the reveal scroll is observable.
  app.scrollToBottom({ disableFollow: true })
  await vt.waitForRender()
  const parked = app.fullscreenScrollForTest()?.scrollTop ?? 0
  assert.ok(!view(vt).includes('## Scope'), 'precondition: the plan body row is out of view before the reveal')
  // Enter on the default View row triggers the inspection + reading step.
  vt.sendInput('\r')
  await vt.waitForRender()
  const reading = view(vt)
  assert.ok(reading.includes('Reading the submitted plan'), `reading step must render:\n${reading}`)
  const after = app.fullscreenScrollForTest()?.scrollTop ?? -1
  assert.ok(after < parked, `the reveal must scroll up to the plan card (parked=${parked}, after=${after})`)
  assert.ok(view(vt).includes('## Scope'), `the revealed card shows the plan body, not just its header:\n${view(vt)}`)
  // Esc returns to the decision list; the question is still answerable.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  const decision = view(vt)
  assert.ok(decision.includes('View plan'), `Esc returns to the decision list:\n${decision}`)
  // ↓↓ to Approve, Enter — the official settle path.
  vt.sendInput('\x1b[B')
  vt.sendInput('\x1b[B')
  vt.sendInput('\r')
  const answers = await settle
  assert.deepEqual(answers, [{ id: 'plan-review', selected: ['Approve'] }])
  app.stop()
})

test('the Remote client presenter path also reveals the full plan body (no Host registry)', async () => {
  // The Remote branch has no Host tool registry: createClientToolPresenter
  // derives the generic card from the logged arguments instead.
  const remote = createClientToolPresenter()
  const { vt, app, settle } = scene(transcript('call-plan-1'), 100, 24, { present: remote })
  await vt.waitForRender()
  app.scrollToBottom({ disableFollow: true })
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(view(vt).includes('## Scope'), `the Remote-derived card must show the plan body:\n${view(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  vt.sendInput('\x1b[B')
  vt.sendInput('\r')
  const answers = await settle
  assert.deepEqual(answers, [{ id: 'plan-review', selected: ['Approve'] }])
  app.stop()
})

test('a missing plan card (no logged call) degrades View to the question-detail fallback', async () => {
  // No callId on the card: the inspection cannot prove the target.
  const { vt, app, settle } = scene(transcript())
  await vt.waitForRender()
  vt.sendInput('\r') // Enter on View
  await vt.waitForRender()
  const fallback = view(vt)
  assert.ok(fallback.includes('Full review text'), `the fallback page renders:\n${fallback}`)
  assert.ok(fallback.includes('# Upgrade 0.5.7'), `the fallback shows the plan body:\n${fallback}`)
  // Esc back, then Keep planning with feedback — the settle still works.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // Keep planning…
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('w')
  vt.sendInput('o')
  vt.sendInput('r')
  vt.sendInput('k')
  vt.sendInput('\r')
  const answers = await settle
  assert.deepEqual(answers, [{ id: 'plan-review', selected: ['Keep planning'], custom: 'work' }])
  app.stop()
})

test('a long plan fallback pages to the very tail (no 256-row silent cut)', async () => {
  // 400 plan lines: far beyond the generic page cap. The fallback must reach
  // the LAST line by paging, and must never claim the tail is visible early.
  const lines = Array.from({ length: 400 }, (_, i) => `step line ${i} unique-marker-${i}`)
  const longPlan = `# Long Plan\n${lines.join('\n')}`
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setWelcomeCard({ cwd: '/ws', sessionId: SESSION, version: 'test' })
  app.setFullscreen(true)
  // No logged call for this question: View CANNOT locate a card.
  app.setTranscript(transcript())
  const settle = app.askQuestions([{
    id: 'plan-review',
    question: 'Approve this plan and leave plan mode?',
    header: 'Plan review',
    detail: longPlan,
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: 'Approve' },
  }], undefined, { reviewSessionId: SESSION }, false)
  await vt.waitForRender()
  vt.sendInput('\r') // View -> fallback (no provable target)
  await vt.waitForRender()
  assert.ok(view(vt).includes('Full review text'), `the fallback must render:\n${view(vt)}`)
  assert.ok(!view(vt).includes('unique-marker-399'), 'precondition: the tail starts hidden')
  // Page down until the LAST line is visible (bounded: a silent cap fails
  // loudly instead of hanging).
  for (let page = 0; page < 60 && !view(vt).includes('unique-marker-399'); page += 1) {
    vt.sendInput('\x1b[6~') // PageDown
    await vt.waitForRender()
  }
  assert.ok(view(vt).includes('unique-marker-399'), `the fallback tail must be reachable:\n${view(vt)}`)
  // Paging never settles the question: Esc back, then the official dismiss.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await settle.then(() => {}, () => {})
  app.stop()
})

test('settling the plan question releases the temporary reveal and forced sub-call', async () => {
  const root: Extract<TranscriptMessage, { kind: 'tool' }> = {
    kind: 'tool', turn: 1, name: 'run_code', callId: 'call-root',
    args: '{}', result: '', status: 'running',
    subCalls: [{
      kind: 'tool', turn: 1, name: 'exit_plan_mode', subCallId: 'call-plan-1',
      parentCallId: 'call-root', rootCallId: 'call-root',
      args: JSON.stringify({ plan: PLAN_MD }), result: '', status: 'running',
    }],
  }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 0, text: 'plan via run_code' },
    root,
  ]
  const { vt, app, settle } = scene(messages)
  await vt.waitForRender()
  // Enter View (inspection + reading), then Esc back, then Esc dismiss — the
  // question settles and the reveal must be gone.
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(view(vt).includes('Reading the submitted plan'))
  vt.sendInput('\x1b') // reading → decision
  await vt.waitForRender()
  vt.sendInput('\x1b') // decision → official dismiss
  await settle.then(() => {}, () => {})
  await vt.waitForRender()
  assert.equal(app.transcriptSearchPresentationForTest(), undefined,
    'the settled plan question must leave no search presentation behind')
  const internals = app as unknown as { planInspection?: unknown; subCallExpanded: Set<string> }
  assert.equal(internals.planInspection, undefined,
    'the one-shot plan inspection presentation must be released on settle')
  assert.equal(internals.subCallExpanded.has('call-plan-1'), false,
    'the plan inspection never mints a durable sub-call expansion')
  app.stop()
})

test('an identity mismatch fails closed to the detail fallback (no reveal, no scroll)', async () => {
  const { vt, app, settle } = scene(transcript('call-plan-1'), 100, 24, { present: directPlanPresenter }, 'session-other')
  await vt.waitForRender()
  app.scrollToBottom({ disableFollow: true })
  await vt.waitForRender()
  const parked = app.fullscreenScrollForTest()?.scrollTop ?? -1
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(view(vt).includes('Full review text'), `the mismatch degrades to the fallback:\n${view(vt)}`)
  assert.equal((app as unknown as { planInspection?: unknown }).planInspection, undefined,
    'a failed locate commits no inspection presentation')
  assert.equal(app.fullscreenScrollForTest()?.scrollTop, parked,
    'a failed locate never moves the transcript viewport')
  assert.equal(app.transcriptSearchPresentationForTest(), undefined,
    'a failed locate creates no search presentation')
  vt.sendInput('\x1b') // back to the decision list
  await vt.waitForRender()
  vt.sendInput('\x1b') // official dismiss
  await settle.then(() => {}, () => {})
  app.stop()
})

test('an unknown Question session identity fails closed (no callId-only locate)', async () => {
  const { vt, app, settle } = scene(transcript('call-plan-1'), 100, 24, { present: directPlanPresenter }, null)
  await vt.waitForRender()
  app.scrollToBottom({ disableFollow: true })
  await vt.waitForRender()
  const parked = app.fullscreenScrollForTest()?.scrollTop ?? -1
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(view(vt).includes('Full review text'), `an unknown identity degrades to the fallback:\n${view(vt)}`)
  assert.equal((app as unknown as { planInspection?: unknown }).planInspection, undefined,
    'an unproven identity commits no inspection presentation')
  assert.equal(app.fullscreenScrollForTest()?.scrollTop, parked,
    'an unproven identity never moves the transcript viewport')
  vt.sendInput('\x1b') // back to the decision list
  await vt.waitForRender()
  vt.sendInput('\x1b') // official dismiss
  await settle.then(() => {}, () => {})
  app.stop()
})

test('the inspection matches a nested PTC sub-call by its subCallId and shows the plan body', async () => {
  // Build a PTC root whose nested sub-call is the exit_plan_mode card.
  const root: Extract<TranscriptMessage, { kind: 'tool' }> = {
    kind: 'tool', turn: 1, name: 'run_code', callId: 'call-root',
    args: '{}', result: '', status: 'running',
    subCalls: [{
      kind: 'tool', turn: 1, name: 'exit_plan_mode', subCallId: 'call-plan-1',
      parentCallId: 'call-root', rootCallId: 'call-root',
      args: JSON.stringify({ plan: PLAN_MD }), result: '', status: 'running',
    }],
  }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 0, text: 'plan via run_code' },
    root,
    ...Array.from({ length: 10 }, (_, i) => ({
      kind: 'user' as const, turn: 2 + i, text: `filler ${i}`,
    })),
  ]
  const { vt, app, settle } = scene(messages, 100, 24, { present: directPlanPresenter })
  await vt.waitForRender()
  app.scrollToBottom({ disableFollow: true })
  await vt.waitForRender()
  vt.sendInput('\r') // View
  await vt.waitForRender()
  const reading = view(vt)
  assert.ok(reading.includes('Reading the submitted plan'), `the nested sub-call locates:\n${reading}`)
  // The RUNNING nested call's plan body comes from the presenter's generic
  // view of the call arguments (never from a result that does not exist yet).
  assert.ok(reading.includes('## Scope'), `the nested card must show the plan body:\n${reading}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  vt.sendInput('\x1b[B')
  vt.sendInput('\r')
  const answers = await settle
  assert.deepEqual(answers, [{ id: 'plan-review', selected: ['Approve'] }])
  app.stop()
})

test('Focus collapsed Thought: View opens the owner Thought and locates the card', async () => {
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 0, text: 'plan the upgrade' },
    { kind: 'thinking', turn: 1, text: 'planning the upgrade carefully' },
    {
      kind: 'tool', turn: 1, name: 'exit_plan_mode', callId: 'call-plan-1',
      args: JSON.stringify({ plan: PLAN_MD }), result: '', status: 'running',
    },
    ...Array.from({ length: 8 }, (_, i) => ({
      kind: 'user' as const, turn: 2 + i, text: `filler turn ${i} ${'x'.repeat(60)}`,
    })),
  ]
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { present: directPlanPresenter })
  app.start()
  startedApps.add(app)
  app.setWelcomeCard({ cwd: '/ws', sessionId: SESSION, version: 'test' })
  app.setFocusMode(true)
  app.setFullscreen(true)
  const activities = new Map([[1, { turn: 1, completed: false, think: { text: 'planning the upgrade carefully', running: true } }]])
  app.setTranscript(messages, activities as never)
  const settle = app.askQuestions([{
    id: 'plan-review', question: 'Approve?', header: 'Plan review', detail: PLAN_MD,
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan-1' },
  }], undefined, { reviewSessionId: SESSION }, false)
  await vt.waitForRender()
  assert.ok(!view(vt).includes('## Scope'), 'precondition: the collapsed Thought hides the plan card')
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(view(vt).includes('Reading the submitted plan'), `the Focus reveal must locate the card:\n${view(vt)}`)
  assert.ok(view(vt).includes('## Scope'), `the plan body must be materialized inside the opened Thought:\n${view(vt)}`)
  // A REAL header click on the (temporarily opened) Thought must COLLAPSE the
  // temporary reveal, never write a manual expansion.
  app.toggleFocusTurn(1)
  await vt.waitForRender()
  assert.ok(!view(vt).includes('## Scope'), `the Thought click collapsed the temporary reveal:\n${view(vt)}`)
  assert.equal(app.focusExpandedTurnsForTest().has(1), false,
    'the user collapse never writes a manual Focus expansion')
  // Back to the decision list, then a NEW View re-opens the Thought and card.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(view(vt).includes('## Scope'), `a new View re-opens the Focus card:\n${view(vt)}`)
  vt.sendInput('\x1b') // back to the decision list
  await vt.waitForRender()
  vt.sendInput('\x1b') // official dismiss
  await settle.then(() => {}, () => {})
  assert.equal(app.focusExpandedTurnsForTest().size, 0,
    'the inspection never writes a manual Focus expansion')
  app.stop()
})

test('a REAL user collapse during reading wins (both disclosure branches); a NEW View re-opens', async () => {
  const messages = transcript('call-plan-1')
  const card = messages.find(
    (m): m is Extract<TranscriptMessage, { kind: 'tool' }> => m.kind === 'tool' && m.name === 'exit_plan_mode',
  )!
  const { vt, app, settle } = scene(messages, 100, 24, { present: directPlanPresenter })
  await vt.waitForRender()
  const toggle = (): void => {
    ;(app as unknown as { toggleMessageExpanded(message: TranscriptMessage): void }).toggleMessageExpanded(card)
  }
  // Branch 1: the user OPENS the card before View (a durable `true` override),
  // then View, then the SAME disclosure route collapses it during reading.
  toggle()
  await vt.waitForRender()
  assert.equal((app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride.get(card), true,
    'the user opened the card before View (durable disclosure owner)')
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(view(vt).includes('Reading the submitted plan'), `the located reading step:\n${view(vt)}`)
  toggle() // first click during reading must collapse, not be re-opened by the lease
  await vt.waitForRender()
  assert.ok(!view(vt).includes('## Scope'), `the first real collapse click wins over the plan lease:\n${view(vt)}`)
  assert.ok(view(vt).includes('Reading the submitted plan'), 'the reading step itself survives the collapse')
  // Esc back, then a NEW explicit View re-opens the card.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(view(vt).includes('## Scope'), `a new View re-opens the card:\n${view(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await settle.then(() => {}, () => {})
  app.stop()
})

test('a PTC child collapsed during reading stays folded; a new View re-opens it', async () => {
  const root: Extract<TranscriptMessage, { kind: 'tool' }> = {
    kind: 'tool', turn: 1, name: 'run_code', callId: 'call-root',
    args: '{}', result: '', status: 'running',
    subCalls: [{
      kind: 'tool', turn: 1, name: 'exit_plan_mode', subCallId: 'call-plan-1',
      parentCallId: 'call-root', rootCallId: 'call-root',
      args: JSON.stringify({ plan: PLAN_MD }), result: '', status: 'running',
    }],
  }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 0, text: 'plan via run_code' },
    root,
  ]
  const { vt, app, settle } = scene(messages, 100, 24, { present: directPlanPresenter })
  await vt.waitForRender()
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(view(vt).includes('## Scope'), `precondition: the nested body is visible:\n${view(vt)}`)
  // The user collapses the nested child through the REAL disclosure owner
  // (clicking the child header): the temporary reveal is suppressed and the
  // mounted batch rebuilds.
  ;(app as unknown as { toggleSubCallExpanded(subCallId: string): void }).toggleSubCallExpanded('call-plan-1')
  await vt.waitForRender()
  assert.ok(!view(vt).includes('## Scope'), `an explicit child collapse during reading wins:\n${view(vt)}`)
  assert.equal((app as unknown as { subCallExpanded: Set<string> }).subCallExpanded.has('call-plan-1'), false,
    'the inspection never mints a durable sub-call expansion')
  // A new explicit View re-opens it.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(view(vt).includes('## Scope'), `a new View re-opens the nested card:\n${view(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await settle.then(() => {}, () => {})
  app.stop()
})

test('a QUEUED plan-review question mounts with the live View capability (FIFO handover)', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { present: directPlanPresenter })
  app.start()
  startedApps.add(app)
  app.setWelcomeCard({ cwd: '/ws', sessionId: SESSION, version: 'test' })
  app.setFullscreen(true)
  app.setTranscript(transcript('call-plan-1'))
  await vt.waitForRender()
  // A normal question owns the seat first; the plan review is queued behind it.
  const first = app.askQuestions([{
    id: 'q1',
    question: 'Pick one',
    options: [{ label: 'A' }, { label: 'B' }],
  }])
  await vt.waitForRender()
  const plan = app.askQuestions([{
    id: 'plan-review', question: 'Approve?', header: 'Plan review', detail: PLAN_MD,
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan-1' },
  }], undefined, { reviewSessionId: SESSION }, false)
  await vt.waitForRender()
  // Settle the first question: select A, then submit on the review page.
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('\r')
  const firstAnswers = await first
  assert.deepEqual(firstAnswers, [{ id: 'q1', selected: ['A'] }])
  await vt.waitForRender()
  // The handed-over plan review must render the FULL decision list (View first).
  const handed = view(vt)
  assert.ok(handed.includes('View plan'), `a queued plan review must offer View plan:\n${handed}`)
  const rows = stripTerminalSequences(vt.getViewport().join('\n')).split('\n')
  const viewRow = rows.findIndex(row => row.includes('> View plan'))
  assert.ok(viewRow >= 0, `View plan holds the default cursor after the handover:\n${handed}`)
  // And it really locates the card.
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(view(vt).includes('Reading the submitted plan'), `the handed-over flow reads:\n${view(vt)}`)
  assert.ok(view(vt).includes('## Scope'), `the handed-over flow locates the body:\n${view(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  vt.sendInput('\x1b[B')
  vt.sendInput('\r')
  const planAnswers = await plan
  assert.deepEqual(planAnswers, [{ id: 'plan-review', selected: ['Approve'] }])
  app.stop()
})

test('a long PTC plan line wraps and its tail is reachable by scrolling (80 columns)', async () => {
  // One LONG paragraph line: a per-line truncation would permanently lose the
  // tail, so the only readable proof is the unique marker at its end.
  const longLine = `${'scope item '.repeat(18)}tail-marker-xyz`
  const longPlan = `# Long Plan\n${longLine}`
  const root: Extract<TranscriptMessage, { kind: 'tool' }> = {
    kind: 'tool', turn: 1, name: 'run_code', callId: 'call-root',
    args: '{}', result: '', status: 'running',
    subCalls: [{
      kind: 'tool', turn: 1, name: 'exit_plan_mode', subCallId: 'call-plan-1',
      parentCallId: 'call-root', rootCallId: 'call-root',
      args: JSON.stringify({ plan: longPlan }), result: '', status: 'running',
    }],
  }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 0, text: 'plan via run_code' },
    root,
  ]
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { present: directPlanPresenter })
  app.start()
  startedApps.add(app)
  app.setWelcomeCard({ cwd: '/ws', sessionId: SESSION, version: 'test' })
  app.setFullscreen(true)
  app.setTranscript(messages)
  const settle = app.askQuestions([{
    id: 'plan-review', question: 'Approve?', header: 'Plan review', detail: longPlan,
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan-1' },
  }], undefined, { reviewSessionId: SESSION }, false)
  await vt.waitForRender()
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(view(vt).includes('Reading the submitted plan'), `the nested card locates:\n${view(vt)}`)
  // The wrapped tail starts below the viewport; the reading step's own page
  // keys scroll the transcript until the marker becomes readable.
  for (let page = 0; page < 12 && !view(vt).includes('tail-marker-xyz'); page += 1) {
    vt.sendInput('\x1b[6~') // PageDown (reading step → transcript viewport)
    await vt.waitForRender()
  }
  assert.ok(view(vt).includes('tail-marker-xyz'), `the wrapped tail must be readable at 80 columns:\n${view(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await settle.then(() => {}, () => {})
  app.stop()
})

test('a PTC target located below many earlier siblings scrolls to the CHILD row, not the root top', async () => {
  // 40 collapsed sibling sub-calls render one header row each before the
  // target: measuring only the ROOT card's top would leave the plan body far
  // below the viewport while still claiming "located".
  const filler = Array.from({ length: 40 }, (_, i) => ({
    kind: 'tool' as const, turn: 1, name: 'read', subCallId: `filler-${i}`,
    parentCallId: 'call-root', rootCallId: 'call-root',
    args: JSON.stringify({ path: `src/f${i}.ts` }), result: '', status: 'ok' as const,
  }))
  const root: Extract<TranscriptMessage, { kind: 'tool' }> = {
    kind: 'tool', turn: 1, name: 'run_code', callId: 'call-root',
    args: '{}', result: '', status: 'running',
    subCalls: [
      ...filler,
      {
        kind: 'tool', turn: 1, name: 'exit_plan_mode', subCallId: 'call-plan-1',
        parentCallId: 'call-root', rootCallId: 'call-root',
        args: JSON.stringify({ plan: PLAN_MD }), result: '', status: 'running',
      },
    ],
  }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 0, text: 'plan via run_code with many siblings' },
    root,
  ]
  const { vt, app, settle } = scene(messages, 100, 24, { present: directPlanPresenter })
  await vt.waitForRender()
  assert.ok(!view(vt).includes('## Scope'), 'precondition: the target body is out of view')
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(view(vt).includes('Reading the submitted plan'), `the reading step renders:\n${view(vt)}`)
  assert.ok(view(vt).includes('## Scope'), `the ONE locate lands on the child row (not the root top):\n${view(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await settle.then(() => {}, () => {})
  app.stop()
})

test('Compact Work sibling: the plan reveal opens the Work span and a real header click collapses it', async () => {
  const messages = transcript('call-plan-1')
  const card = messages.find(
    (m): m is Extract<TranscriptMessage, { kind: 'tool' }> => m.kind === 'tool' && m.name === 'exit_plan_mode',
  )!
  const { vt, app, settle } = scene(messages, 100, 24, { present: directPlanPresenter })
  app.setDisplayPreset('compact')
  await vt.waitForRender()
  assert.ok(!view(vt).includes('## Scope'), `precondition: the collapsed Work span hides the card:\n${view(vt)}`)
  vt.sendInput('\r') // View
  await vt.waitForRender()
  assert.ok(view(vt).includes('## Scope'), `the plan reveal opens the Work span:\n${view(vt)}`)
  // A REAL Work header click collapses the temporary reveal.
  const owner = (app as unknown as {
    canonicalStructureIndex(): { workByMember: Map<TranscriptMessage, { owner: TranscriptMessage }> }
  }).canonicalStructureIndex().workByMember.get(card)?.owner
  assert.ok(owner !== undefined, 'fixture: the card belongs to a Work span')
  app.toggleWorkSpan(owner)
  await vt.waitForRender()
  assert.ok(!view(vt).includes('## Scope'), `the Work header click collapsed the reveal:\n${view(vt)}`)
  assert.equal((app as unknown as { planInspection?: unknown }).planInspection, undefined,
    'the Work collapse revoked the plan lease')
  // A new View re-opens the Work span and the card.
  vt.sendInput('\x1b') // back to the decision list
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(view(vt).includes('## Scope'), `a new View re-opens the Compact card:\n${view(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await settle.then(() => {}, () => {})
  app.stop()
})
