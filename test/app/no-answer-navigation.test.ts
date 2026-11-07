/**
 * PR-G567: the modal-safe no-answer navigation entry (Alt+W) of the split
 * Client's PiTUI modal seat.
 *
 * Evidence level: L3 over the ONE mounted TuiApp. The real Host + two-PTY
 * scene is proven by the split-process smoke; this suite pins the local
 * behavior that makes it safe:
 *
 * - Alt+W is inert without the installed control and while the modal owns a
 *   fixed response key (the modal response ladder stays authoritative);
 * - `begin()` withdraws the mounted Question/Approval seat and the local
 *   cancellation is a presentation fact, never a decision;
 * - the root hold is released by the physical Session Workspace close, not by
 *   the key press;
 * - when the Browser cannot lease/open, the hold is released at once so the
 *   editor is never stranded.
 *
 * @module @xmoon76/dsh-pi-tui/no-answer-navigation.test
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

function startApp(): { app: TuiApp; vt: VirtualTerminal } {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} })
  // The navigation-installed flag is module-global (the modal hint reads it);
  // clear it BEFORE start so each test begins from the Direct default.
  app.setNoAnswerNavigation(undefined)
  app.start()
  startedApps.add(app)
  return { app, vt }
}

async function settleOutcome<T>(
  promise: Promise<T>,
  timeoutMs = 1_000,
): Promise<{ kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown } | { kind: 'timeout' }> {
  return Promise.race([
    promise.then(
      value => ({ kind: 'resolved' as const, value }),
      error => ({ kind: 'rejected' as const, error }),
    ),
    new Promise<{ kind: 'timeout' }>(resolve => {
      const timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
      timer.unref?.()
    }),
  ])
}

/** Open the REAL Session Workspace lease on the app (the command layer's own
 *  entry) with inert callbacks. */
function openWorkspace(app: TuiApp): void {
  app.openSessionWorkspace({
    subject: { currentSessionId: 'session-X', currentCwd: '/tmp', isCurrent: () => true },
    onQueryChange: () => {},
    onResume: () => {},
    onClose: () => {},
    initialMode: 'browse',
    initialBrowseScope: 'current',
  })
}

test('Alt+W withdraws the mounted question, opens the lease, and releases the hold on the workspace close', async () => {
  const { app, vt } = startApp()
  const controller = new AbortController()
  const question = app.askQuestions([{ id: 'q1', question: 'Continue?', options: [{ label: 'Proceed' }] }], controller.signal, undefined, true)
  const questionOutcome = settleOutcome(question)
  await vt.waitForRender()
  assert.match(vt.getViewport().join(''), /Continue\?/u, 'the question owns the seat first')

  let beginCalls = 0
  let openCalls = 0
  let releaseCalls = 0
  app.setNoAnswerNavigation({
    available: () => true,
    begin: () => {
      beginCalls += 1
      app.withdrawPresentations([controller.signal])
      return () => { releaseCalls += 1 }
    },
    open: () => {
      openCalls += 1
      openWorkspace(app)
    },
  })

  vt.sendInput('\x1bw')
  await vt.waitForRender()
  assert.equal(beginCalls, 1, 'Alt+W commits the hold before anything else')
  assert.equal(openCalls, 1, 'Alt+W opens the EXISTING Session Workspace lease')
  assert.match(vt.getViewport().join(''), /All workspaces|Recent sessions|sessions/iu,
    'the fullscreen Session Workspace is the visible surface')
  const outcome = await questionOutcome
  assert.equal(outcome.kind, 'rejected', 'the withdrawn local question attempts no Host answer')
  assert.match(String((outcome as { error: unknown }).error), /question flow cancelled/u)
  assert.equal(releaseCalls, 0, 'the hold stays committed while the Browser is open')

  // Esc closes the physical workspace: THAT is the hold-release fact.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(releaseCalls, 1, 'the workspace close releases the navigation hold exactly once')
})

test('Alt+W withdraws a mounted approval without deciding it and releases on close', async () => {
  const { app, vt } = startApp()
  const controller = new AbortController()
  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'need a decision', signal: controller.signal }, true)
  await vt.waitForRender()
  assert.match(vt.getViewport().join(''), /bash|Approval/iu, 'the approval sheet owns the seat first')

  let releaseCalls = 0
  app.setNoAnswerNavigation({
    available: () => true,
    begin: () => {
      app.withdrawPresentations([controller.signal])
      return () => { releaseCalls += 1 }
    },
    open: () => { openWorkspace(app) },
  })
  vt.sendInput('\x1bw')
  await vt.waitForRender()
  assert.deepEqual(await settleOutcome(approval), { kind: 'resolved', value: 'cancelled' },
    'the withdrawn approval is a local presentation cancellation, not a Host decision')
  assert.equal(releaseCalls, 0)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(releaseCalls, 1, 'the workspace close releases the hold')
})

test('Alt+W is inert when the control is absent or unavailable and the modal keeps its fixed keys', async () => {
  const { app, vt } = startApp()
  const controller = new AbortController()
  const question = app.askQuestions([{ id: 'q1', question: 'Keep me?', options: [{ label: 'Proceed' }] }], controller.signal, undefined, true)
  await vt.waitForRender()

  // No control installed (Direct / TSP): the key falls through to the modal,
  // which consumes it as ordinary input; nothing opens and nothing settles.
  vt.sendInput('\x1bw')
  await vt.waitForRender()
  assert.match(vt.getViewport().join(''), /Keep me\?/u, 'the modal is still mounted')
  assert.equal((await settleOutcome(question, 50)).kind, 'timeout', 'Alt+W settles nothing')

  let beginCalls = 0
  let openCalls = 0
  app.setNoAnswerNavigation({
    available: () => false,
    begin: () => { beginCalls += 1; return () => {} },
    open: () => { openCalls += 1 },
  })
  vt.sendInput('\x1bw')
  await vt.waitForRender()
  assert.equal(beginCalls, 0, 'an unavailable Browser never takes the hold')
  assert.equal(openCalls, 0)
  assert.match(vt.getViewport().join(''), /Keep me\?/u, 'the dialog stays mounted')
  assert.match(vt.getViewport().join(''), /Session browsing is not available/u, 'the refusal is visible')

  // The fixed response key still wins: Esc settles the flow as the human cancel.
  vt.sendInput('\x1b')
  const outcome = await settleOutcome(question)
  assert.equal(outcome.kind, 'rejected')
  assert.match(String((outcome as { error: unknown }).error), /question flow cancelled/u)
})

test('withdrawPresentations removes every matching queued question before the active one settles', async () => {
  const { app, vt } = startApp()
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = app.askQuestions([{ id: 'q1', question: 'first queue?', options: [{ label: 'a' }] }], firstController.signal)
  const firstOutcome = settleOutcome(first)
  const second = app.askQuestions([{ id: 'q2', question: 'second queue?', options: [{ label: 'a' }] }], secondController.signal)
  const secondOutcome = settleOutcome(second)
  await vt.waitForRender()
  assert.match(vt.getViewport().join(''), /first queue\?/u)
  assert.doesNotMatch(vt.getViewport().join(''), /second queue\?/u, 'the second flow is queued, not mounted')

  app.withdrawPresentations([firstController.signal, secondController.signal])
  assert.equal((await firstOutcome).kind, 'rejected', 'the active flow is withdrawn locally')
  assert.equal((await secondOutcome).kind, 'rejected', 'the queued flow is withdrawn without mounting')
  await vt.waitForRender()
  assert.doesNotMatch(vt.getViewport().join(''), /second queue\?/u, 'the withdrawn successor was never promoted')

  // A fresh question still takes the seat: nothing was stranded.
  const third = app.askQuestions([{ id: 'q3', question: 'still works?', options: [{ label: 'a' }] }])
  const thirdOutcome = settleOutcome(third)
  await vt.waitForRender()
  assert.match(vt.getViewport().join(''), /still works\?/u)
  vt.sendInput('\x1b')
  assert.equal((await thirdOutcome).kind, 'rejected')
})

test('withdrawPresentations removes every matching queued approval before the active one settles', async () => {
  const { app, vt } = startApp()
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = app.showApprovalPrompt({ toolName: 'bash', reason: 'first', signal: firstController.signal })
  const firstOutcome = settleOutcome(first)
  const second = app.showApprovalPrompt({ toolName: 'bash', reason: 'second', signal: secondController.signal })
  const secondOutcome = settleOutcome(second)
  await vt.waitForRender()
  assert.match(vt.getViewport().join(''), /first/u)
  assert.doesNotMatch(vt.getViewport().join(''), /second/u, 'the second approval is queued, not mounted')

  app.withdrawPresentations([firstController.signal, secondController.signal])
  assert.deepEqual(await firstOutcome, { kind: 'resolved', value: 'cancelled' })
  assert.deepEqual(await secondOutcome, { kind: 'resolved', value: 'cancelled' })
  await vt.waitForRender()
  assert.doesNotMatch(vt.getViewport().join(''), /second/u, 'the withdrawn approval successor was never promoted')
})

test('Alt+W is inert on a continued (agent-not-blocked) question form and no hint paints', async () => {
  const { app, vt } = startApp()
  app.setNoAnswerNavigation({
    available: () => true,
    begin: () => { throw new Error('continued form must never begin a navigation hold') },
    open: () => { throw new Error('continued form must never open the workspace') },
  })
  // agentInputWait defaults to FALSE: this is a continued late-answer form.
  let onCancel: ((error: unknown) => void) | undefined
  const cancelled = new Promise<unknown>((_resolve, reject) => { onCancel = reject })
  const flow = app.askQuestions(
    [{ id: 'q1', question: 'Answer later?', options: [{ label: 'Proceed' }] }],
  )
  flow.catch(error => onCancel?.(error))
  await vt.waitForRender()
  assert.match(vt.getViewport().join(''), /Answer later\?/u)
  assert.doesNotMatch(vt.getViewport().join(''), /browse/u,
    'a continued form must not advertise the navigation verb')
  vt.sendInput('\x1bw')
  await vt.waitForRender()
  assert.match(vt.getViewport().join(''), /Answer later\?/u, 'the form is untouched after Alt+W')
  // Alt+W was inert: settle nothing within a short window.
  const early = await Promise.race([cancelled.then(() => 'settled', () => 'settled'), new Promise<'quiet'>(r => setTimeout(() => r('quiet'), 300))])
  assert.equal(early, 'quiet', 'Alt+W on a continued form settles nothing')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.doesNotMatch(vt.getViewport().join(''), /Answer later\?/u, 'Esc cancelled the continued form')
})

test('a live forwarded question paints the navigation hint only after the control is installed', async () => {
  const { app, vt } = startApp()
  const controller = new AbortController()
  const outcome = settleOutcome(app.askQuestions(
    [{ id: 'q1', question: 'Blocked?', options: [{ label: 'Proceed' }] }],
    controller.signal,
    undefined,
    true,
  ))
  await vt.waitForRender()
  assert.match(vt.getViewport().join(''), /Blocked\?/u)
  // Direct (no control installed): no verb.
  assert.doesNotMatch(vt.getViewport().join(''), /browse/u, 'Direct must not advertise the verb')
  // Installing an UNAVAILABLE control still hides the verb: the hint may
  // never advertise an entry whose press would answer "unavailable".
  app.setNoAnswerNavigation({ available: () => false, begin: () => () => {}, open: () => {} })
  app.requestRender()
  await vt.waitForRender()
  assert.doesNotMatch(vt.getViewport().join(''), /browse/u,
    'an unavailable entry must not be advertised')
  // Making it available paints the verb on the next render.
  app.setNoAnswerNavigation({ available: () => true, begin: () => () => {}, open: () => {} })
  app.requestRender()
  await vt.waitForRender()
  assert.match(vt.getViewport().join(''), /browse/u, 'the live forwarded form advertises the verb')
  vt.sendInput('\x1b')
  assert.equal((await outcome).kind, 'rejected')
})

test('Alt+W is inert outside a modal, e.g. while the Session Workspace owns the seat', async () => {
  const { app, vt } = startApp()
  let beginCalls = 0
  let openCalls = 0
  app.setNoAnswerNavigation({
    available: () => true,
    begin: () => { beginCalls += 1; return () => {} },
    open: () => { openCalls += 1 },
  })
  openWorkspace(app)
  await vt.waitForRender()
  assert.match(vt.getViewport().join(''), /All workspaces|Recent sessions|sessions/iu)
  // With no active Question/Approval the key never reaches the modal-safe
  // entry; it must not open a second Browser or submit the workspace search.
  vt.sendInput('\x1bw')
  await vt.waitForRender()
  assert.equal(beginCalls, 0, 'no navigation hold outside a modal')
  assert.equal(openCalls, 0, 'no second Session Workspace outside a modal')
  assert.match(vt.getViewport().join(''), /All workspaces|Recent sessions|sessions/iu)
})

test('a control that opens no lease releases the hold immediately instead of stranding the editor', async () => {
  const { app, vt } = startApp()
  const controller = new AbortController()
  const question = app.askQuestions([{ id: 'q1', question: 'Still there?', options: [{ label: 'Proceed' }] }], controller.signal, undefined, true)
  const questionOutcome = settleOutcome(question)
  await vt.waitForRender()
  let releaseCalls = 0
  app.setNoAnswerNavigation({
    available: () => true,
    begin: () => {
      app.withdrawPresentations([controller.signal])
      return () => { releaseCalls += 1 }
    },
    open: () => {},
  })
  vt.sendInput('\x1bw')
  await vt.waitForRender()
  assert.equal(releaseCalls, 1, 'no lease means no future close: the hold is released at once')
  assert.match(vt.getViewport().join(''), /Sessions could not be opened/u, 'the failure is explicit')
  assert.equal((await questionOutcome).kind, 'rejected', 'the local presentation settled')
})
