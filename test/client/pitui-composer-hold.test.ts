/**
 * PR2 PiTui renderer contract: the composer submission attempt freezes the
 * real fork Editor (through the host input ladder and the public
 * `disableSubmit` contract), keeps the exact submitted document, and only the
 * Host acceptance clears it. Exercised through a REAL `TuiApp` over a
 * `VirtualTerminal` — the same composition the product runs.
 * @module @xmoon76/dsh-pi-tui/pitui-composer-hold.test
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

interface Mount {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly submitted: Array<{ text: string; request: string }>
  readonly steered: string[]
  readonly admissions: Array<{ text: string; request: string }>
  /** Answers `beginComposerSubmission`; default `'legacy'`. */
  admit(text: string, request: string): 'held' | 'legacy' | 'refused'
}

function startApp(): Mount {
  const vt = new VirtualTerminal(100, 24)
  const submitted: Array<{ text: string; request: string }> = []
  const steered: string[] = []
  const admissions: Array<{ text: string; request: string }> = []
  const mount: Mount = {
    vt,
    app: undefined as unknown as TuiApp,
    submitted,
    steered,
    admissions,
    admit: () => 'legacy',
  }
  const app = new TuiApp(vt, {
    onSubmit: (text, request) => { submitted.push({ text, request }) },
    onSteer: (text) => { steered.push(text) },
    onExit: () => {},
    onCancel: () => {},
    beginComposerSubmission: (text, request) => {
      admissions.push({ text, request })
      return mount.admit(text, request)
    },
  })
  app.start()
  startedApps.add(app)
  ;(mount as { app: TuiApp }).app = app
  return mount
}

async function type(vt: VirtualTerminal, data: string): Promise<void> {
  vt.sendInput(data)
  await vt.waitForRender()
}

test('PR2: a held Enter keeps the document, freezes editing and never fires onSubmit', async () => {
  const h = startApp()
  let holds = 0
  h.admit = (text) => {
    holds += 1
    h.app.holdSubmission(`attempt-${holds}`)
    return 'held'
  }
  await type(h.vt, 'held prompt')
  await type(h.vt, '\r')
  assert.equal(h.admissions.length, 1, 'the fork submit went through the ONE admission')
  assert.deepEqual(h.admissions[0]?.text, 'held prompt')
  assert.deepEqual(h.submitted, [], 'a held line is dispatched by the application, never by onSubmit')
  assert.equal(h.app.getDraft(), 'held prompt', 'the fork kept the exact submitted document')
  // Typing into the frozen composer changes nothing.
  await type(h.vt, 'X')
  assert.equal(h.app.getDraft(), 'held prompt', 'the held document is read-only')
  // A repeated Enter is consumed: no second admission, no submission.
  await type(h.vt, '\r')
  assert.equal(h.admissions.length, 1, 'a repeated Enter is a no-op while sending')
  assert.deepEqual(h.submitted, [])
  // The accepted settlement clears the committed draft exactly once.
  h.app.settleSubmission('attempt-1', 'accepted')
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), '', 'only the Host acceptance clears the draft')
})

test('PR2: a refusal unlocks the editor with the draft intact and editable', async () => {
  const h = startApp()
  h.admit = () => {
    h.app.holdSubmission('attempt-refuse')
    return 'held'
  }
  await type(h.vt, 'keep me')
  await type(h.vt, '\r')
  assert.equal(h.app.getDraft(), 'keep me')
  h.app.settleSubmission('attempt-refuse', 'not-accepted')
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), 'keep me', 'the refused draft is never cleared')
  await type(h.vt, '!')
  assert.equal(h.app.getDraft(), 'keep me!', 'the editor is editable again (no restore duplicated the text)')
})

test('PR2: a legacy verdict keeps the pre-PR2 clear-then-submit ordering', async () => {
  const h = startApp()
  await type(h.vt, '/status')
  await type(h.vt, '\r')
  assert.deepEqual(h.submitted, [{ text: '/status', request: 'enter' }],
    'a legacy line reaches onSubmit exactly as before')
  assert.equal(h.app.getDraft(), '', 'the legacy path cleared the draft before dispatching')
})

test('PR2: a refused verdict neither clears nor dispatches', async () => {
  const h = startApp()
  h.admit = () => 'refused'
  await type(h.vt, 'ignored')
  await type(h.vt, '\r')
  assert.deepEqual(h.submitted, [])
  assert.equal(h.app.getDraft(), 'ignored', 'the draft is preserved by a refused gesture')
})

test('PR2: the Ctrl+S steer gesture shares the admission and the freeze', async () => {
  const h = startApp()
  h.admit = (_text, request) => {
    if (request !== 'steer') return 'legacy'
    h.app.holdSubmission('attempt-steer')
    return 'held'
  }
  await type(h.vt, 'steer me')
  const dispatched = (h.app as unknown as {
    actionDispatcher: { dispatch: (action: string, data?: string) => boolean }
  }).actionDispatcher.dispatch('app.input.steer')
  assert.equal(dispatched, true)
  assert.equal(h.admissions.at(-1)?.request, 'steer', 'the steer gesture used the ONE admission')
  assert.deepEqual(h.steered, [], 'a held steer is dispatched by the application, never re-dispatched')
  assert.equal(h.app.getDraft(), 'steer me', 'the steered draft stays frozen until acceptance')
  h.app.settleSubmission('attempt-steer', 'accepted')
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), '')
})
