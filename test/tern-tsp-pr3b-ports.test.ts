/**
 * PR3-B B0 port-isolation guards.
 *
 * The B0 refactor narrowed the submission controller to the seven-method
 * `SubmissionComposerPort` and the interaction runtime to the
 * `SurfaceInteractionPresenter`. These tests pin the refactor's structural
 * contract:
 *
 * - `src/app/submission/controller.ts` no longer imports `TuiApp` (the ONLY
 *   composer seam is the port; no new TuiApp import may re-enter through the
 *   back door — the display-seam DTO debt is a PR4 follow-up, not this one);
 * - the mounted PiTui `TuiApp` is the composer port itself, while the modal
 *   presenter is the narrow delegating adapter over it (B3: the adapter owns
 *   `withdrawPending`, which no `TuiApp` has);
 * - every one of the seven composer methods is exercised against a real
 *   headless `TuiApp` (a silently dropped member would surface as a missing
 *   capability on the TSP branch later);
 * - the UserShell interrupt error notice goes through the INJECTED
 *   renderer-neutral notify (never a PiTui member), while the local-card
 *   members stay on the app.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-pr3b-ports.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import type { SubmissionComposerPort } from '../src/app/submission/composer-port.ts'
import { pituiSurfaceInteractionPresenter, type PiTuiInteractionApp, type SurfaceInteractionPresenter } from '../src/app/surface/interaction-presenter.ts'
import { createUserShell } from '../src/app/submission/user-shell.ts'
import type { InterruptAgentLike } from '../src/app/session/interrupt.ts'

const CONTROLLER_SOURCE = fileURLToPath(new URL('../src/app/submission/controller.ts', import.meta.url))
const USER_SHELL_SOURCE = fileURLToPath(new URL('../src/app/submission/user-shell.ts', import.meta.url))

// ── Static: the submission owner reads the port, not TuiApp ─────────────────

test('B0: the submission controller imports no TuiApp binding', () => {
  const source = readFileSync(CONTROLLER_SOURCE, 'utf8')
  // Type-only compatibility re-exports are fine; a VALUE/TYPE binding of the
  // class itself would let PiTui-only members creep back in.
  assert.equal(
    /import\s+(type\s+)?\{[^}]*\bTuiApp\b[^}]*\}\s*from\s*'[^']*tui-app\.ts'/.test(source), false,
    'controller.ts must not import TuiApp (the SubmissionComposerPort is the only composer seam)',
  )
})

test('B0: the user shell keeps only the local-card TuiApp members', () => {
  const source = readFileSync(USER_SHELL_SOURCE, 'utf8')
  // The interrupt/failure notices must route through the injected
  // renderer-neutral `notify`, never `deps.app().notify`.
  const appNotifyUses = [...source.matchAll(/deps\.app\(\)\.notify/g)]
  assert.equal(appNotifyUses.length, 0,
    'UserShell failure/interrupt notices must use the injected notify, not deps.app().notify')
  // The remaining app uses are the local-card lifecycle only.
  for (const match of [...source.matchAll(/deps\.app\(\)\.(\w+)/g)]) {
    assert.ok(
      ['pushLocalMessage', 'updateLocalMessage', 'clearSettledLocalMessages'].includes(match[1]!),
      `unexpected UserShell app member use: ${match[1]}`,
    )
  }
})

// ── Structural: the app is the composer port; the presenter is the adapter ──

test('B0/B3: the PiTui composer port is the live app and the presenter is the delegating adapter', () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} })
  app.start()
  try {
    // No wrapper, no `as`-cast: the mounted app IS the composer port.
    const composer: SubmissionComposerPort = app
    // The modal presenter is the adapter: `TuiApp` itself cannot satisfy the
    // interface any more (`withdrawPending` has no app counterpart).
    const presenter: SurfaceInteractionPresenter = pituiSurfaceInteractionPresenter(app)
    assert.equal(typeof composer.getDraft, 'function')
    assert.equal(typeof presenter.showApprovalPrompt, 'function')
    assert.equal(typeof presenter.setQuestionAttention, 'function')
    assert.equal(typeof presenter.withdrawPending, 'function')
  } finally {
    app.dispose()
  }
})

test('B3: the PiTui presenter forwards every member to the app receiver and withdraws nothing itself', async () => {
  const calls: string[] = []
  const app: PiTuiInteractionApp = {
    // `this` identity is the receiver witness: a spread copy (`{ ...app }`)
    // would call these functions with the ADAPTER as receiver.
    showApprovalPrompt(request, agentInputWait = false) {
      assert.equal(this, app, 'the presenter must call the app as receiver')
      calls.push(`approval:${request.toolName}:${agentInputWait}`)
      return Promise.resolve('allowed-once')
    },
    askQuestions(questions, signal, status, agentInputWait = false) {
      assert.equal(this, app, 'the presenter must call the app as receiver')
      calls.push(`ask:${questions.length}:${signal === undefined}:${status === undefined}:${agentInputWait}`)
      return Promise.resolve([])
    },
    setSettledQuestionAnswersLookup(lookup) {
      assert.equal(this, app, 'the presenter must call the app as receiver')
      calls.push(`lookup:${lookup === undefined ? 'clear' : 'set'}`)
    },
    notify(text, kind = 'info') {
      assert.equal(this, app, 'the presenter must call the app as receiver')
      calls.push(`notify:${text}:${kind}`)
    },
    setQuestionAttention(count) {
      assert.equal(this, app, 'the presenter must call the app as receiver')
      calls.push(`attention:${count}`)
    },
  }
  const presenter = pituiSurfaceInteractionPresenter(app)
  const outcome = await presenter.showApprovalPrompt({ toolName: 'bash', reason: 'why' }, true)
  assert.equal(outcome, 'allowed-once')
  assert.deepEqual(await presenter.askQuestions([], undefined, undefined, false), [])
  presenter.setSettledQuestionAnswersLookup(undefined)
  presenter.notify('a notice', 'error')
  presenter.setQuestionAttention(3)
  // The PiTui cancellation owner is the app's own disposal: the adapter must
  // NOT invent a second withdrawal path on this branch.
  presenter.withdrawPending()
  assert.deepEqual(calls, [
    'approval:bash:true',
    'ask:0:true:true:false',
    'lookup:clear',
    'notify:a notice:error',
    'attention:3',
  ])
})

// ── Behavioral: all seven composer members work against a real TuiApp ───────

test('B0: every SubmissionComposerPort member is live on a real PiTui app', () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} })
  app.start()
  try {
    const composer: SubmissionComposerPort = app
    // setDraft/getDraft round-trip (1, 2)
    composer.setDraft('draft one')
    assert.equal(composer.getDraft(), 'draft one')
    // insertIntoEditor appends at the cursor (4)
    composer.insertIntoEditor(' + inserted')
    assert.ok(composer.getDraft().includes('inserted'))
    // setEditorText replaces (3)
    composer.setEditorText('restored draft')
    assert.equal(composer.getDraft(), 'restored draft')
    // notify renders without throwing (5)
    composer.notify('a port notice', 'info')
    // setSubmitPending shows then clears the ack row (6)
    composer.setSubmitPending('submit')
    composer.setSubmitPending(undefined)
    // clearSettledLocalMessages is callable on a fresh app (7)
    composer.clearSettledLocalMessages()
  } finally {
    app.dispose()
  }
})

// ── Behavioral: the UserShell interrupt notice is renderer-neutral ──────────

test('B0: the UserShell interrupt error notice routes through the injected renderer-neutral notify', async () => {
  const notices: string[] = []
  const cardCalls: string[] = []
  // A minimal local-card app double: only the members the run()/card path
  // uses; the interrupt path must never touch them.
  const appDouble = {
    pushLocalMessage: (card: unknown) => { cardCalls.push('push'); return card },
    updateLocalMessage: (card: unknown) => { cardCalls.push('update'); return card },
    clearSettledLocalMessages: () => { cardCalls.push('clear') },
  }
  // A writer whose cancel REJECTS, so the interrupt path reaches its
  // onError notice.
  const failingWriter = {
    cancel: () => Promise.reject(new Error('cancel port refused')),
    prompt: () => Promise.resolve(),
    updateQueue: () => Promise.resolve(),
  }
  // The neutral notify resolves the wait as soon as the REAL observable
  // completion fires (no fixed delay); the timeout keeps a silent regression
  // from hanging the suite.
  let notifyArrived!: (message: string) => void
  const notified = new Promise<string>(resolve => { notifyArrived = resolve })
  const shell = createUserShell<InterruptAgentLike>({
    app: () => appDouble as never,
    notify: (message, kind) => { assert.equal(kind, 'error'); notices.push(message); notifyArrived(message) },
    diag: { debug() {}, info() {}, warn() {}, error() {}, dispose() {} },
    isCleanedUp: () => false,
    liveAgent: () => undefined,
    ownership: { generation: () => 1 },
    // The interrupt path's writer admission: admit synchronously and run the
    // task (the cancel REJECTS, which is what this test observes).
    session: { withWriter: ((_scope: unknown, task: () => unknown) => Promise.resolve().then(task)) as never },
    requireLiveScope: () => { throw new Error('not exercised') },
    captureLiveScope: () => ({ sessionId: 'session-b0' }) as never,
    writerSection: (task) => task(),
    writer: failingWriter as never,
    status: { sessionCwd: () => '/tmp' },
    tuiSettings: undefined,
    shell: { execute: () => Promise.resolve({ kind: 'unavailable', reason: new Error('not exercised') }) } as never,
    submission: { settleAck: () => {}, markDispatch: () => {} },
  })
  shell.interrupt()
  // The failed cancel surfaces through the NEUTRAL notify; the card members
  // were never touched by the interrupt path.
  const firstNotice = await Promise.race([
    notified,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the interrupt failure never reached the neutral notify')), 2_000)),
  ])
  assert.ok(firstNotice.includes('cancel port refused'),
    `the interrupt failure surfaced through the neutral notify: ${JSON.stringify(notices)}`)
  assert.deepEqual(cardCalls, [], 'the interrupt path never touches the PiTui local-card surface')
})
