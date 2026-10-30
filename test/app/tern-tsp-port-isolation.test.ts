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
 * @module @xmoon76/dsh-pi-tui/tern-tsp-port-isolation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TuiApp } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import type { SubmissionComposerPort } from '../../src/app/submission/composer-port.ts'
import { pituiSurfaceInteractionPresenter, type PiTuiInteractionApp, type SurfaceInteractionPresenter } from '../../src/app/surface/interaction-presenter.ts'
import { createUserShell } from '../../src/app/submission/user-shell.ts'
import type { InterruptAgentLike } from '../../src/app/session/interrupt.ts'
import * as runtime from '../../src/app/surface/runtime.ts'

const CONTROLLER_SOURCE = fileURLToPath(new URL('../../src/app/submission/controller.ts', import.meta.url))
const USER_SHELL_SOURCE = fileURLToPath(new URL('../../src/app/submission/user-shell.ts', import.meta.url))

// ── Static: the submission owner reads the port, not TuiApp ─────────────────

test('the submission controller imports no TuiApp binding', () => {
  const source = readFileSync(CONTROLLER_SOURCE, 'utf8')
  // Type-only compatibility re-exports are fine; a VALUE/TYPE binding of the
  // class itself would let PiTui-only members creep back in.
  assert.equal(
    /import\s+(type\s+)?\{[^}]*\bTuiApp\b[^}]*\}\s*from\s*'[^']*tui-app\.ts'/.test(source), false,
    'controller.ts must not import TuiApp (the SubmissionComposerPort is the only composer seam)',
  )
})

test('the user shell keeps only the local-card TuiApp members', () => {
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

test('the PiTui composer port is the live app and the presenter is the delegating adapter', () => {
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

test('the PiTui presenter forwards every member to the app receiver and withdraws nothing itself', async () => {
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
    presentedModalKindForStatus: () => undefined,
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

test('every SubmissionComposerPort member is live on a real PiTui app', () => {
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

// ── The attachment intake's live composer bridge ───────────────────────────

/**
 * The THREE production hops between the mounted renderer's composer and the
 * `/attach` `/image` registrar. Each is a separate module, so a hop can be
 * dropped while every runtime suite stays green (the registrar is exercised
 * directly by its own tests, and the surface's own suite supplies its deps by
 * hand). This is a STATIC lock — it proves the wiring exists, not that a frame
 * was painted; the behavioural half below proves the seam carries a live
 * object rather than a captured one.
 */
test('the mounted composer is bridged from the composition root through the command surface into the attachment registrar', () => {
  const root = readFileSync(fileURLToPath(new URL('../../src/app/bootstrap.ts', import.meta.url)), 'utf8')
  const surface = readFileSync(fileURLToPath(new URL('../../src/app/command/surface.ts', import.meta.url)), 'utf8')
  const commands = readFileSync(fileURLToPath(new URL('../../src/commands.ts', import.meta.url)), 'utf8')
  const artifacts = readFileSync(fileURLToPath(new URL('../../src/tui/commands/artifacts.ts', import.meta.url)), 'utf8')

  // 1. The composition root hands the LIVE surface read into createCommandSurface.
  assert.ok(root.includes('composer: () => surface.composer,'),
    'bootstrap must pass the live `surface.composer` read into the command surface')
  // 2. The command surface exposes it to the registrar through the presentation seam.
  assert.ok(surface.includes('composer: () => deps.surface.composer(),'),
    'the command surface must pass its live composer read into registerTuiCommands')
  // 3. The registrar receives it as the live getter (never the PiTui app alone).
  assert.ok(commands.includes('composer: presentation?.composer ?? (() => app),'),
    'the artifact registrar must receive the presentation composer, falling back only for legacy call sites')
  // 4. And the intake actually resolves it per command instead of using a
  //    cached value or the PiTui-only runner member.
  assert.ok(artifacts.includes('const composer = composerGetter()'),
    'the intake must read the composer at command time')
  assert.equal(artifacts.includes('runner.insertIntoEditor('), false,
    'the intake must never reach the PiTui-only insertIntoEditor no-op')
})

test('the live composer getter reports the CURRENT seat, never a cached one', () => {
  // The seam shape the composition root binds: a live read, so the object the
  // renderer mounted is what the intake writes into, and a replaced seat is
  // reported on the next command.
  const mounted = { marker: 'tsp-composer' }
  let current = mounted
  const seam = { composer: () => current }
  assert.equal(seam.composer(), mounted, 'the seam reads the mounted object')
  const replacement = { marker: 'replacement' }
  current = replacement
  assert.equal(seam.composer(), replacement, 'a replaced seat is read on the next call, never cached')
  assert.notEqual(seam.composer(), mounted, 'the previous seat is no longer reported')
})

// ── Behavioral: the UserShell interrupt notice is renderer-neutral ──────────

test('the UserShell interrupt error notice routes through the injected renderer-neutral notify', async () => {
  const notices: string[] = []
  const cardCalls: string[] = []
  // A minimal local-card app double: only the members the run()/card path
  // uses; the interrupt path must never touch them.
  const appDouble = {
    pushLocalMessage: (card: unknown) => { cardCalls.push('push'); return card },
    updateLocalMessage: (card: unknown) => { cardCalls.push('update'); return card },
    clearSettledLocalMessages: () => { cardCalls.push('clear') },
  }
  // A control interrupt whose backend cancel REJECTS, so the interrupt path
  // reaches its onError notice.
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
    // The interrupt control admission: the injected backend cancel REJECTS,
    // which is the failure this test observes on the neutral notify.
    session: {
      withWriter: ((_scope: unknown, task: () => unknown) => Promise.resolve().then(task)) as never,
      interrupt: () => Promise.reject(new Error('cancel port refused')),
    },
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

// ── PR4: the draft projection is READ-ONLY and LIVE ─────────────────────────

test('the draft projection exposes no mutation member and reads the LIVE composer text', () => {
  const { createSurfaceDraftImageProjection } = runtimeModule()
  let draft = ''
  const staged = [stagedDraft('a.png'), stagedDraft('b.png')]
  const projection = createSurfaceDraftImageProjection(
    () => ({ getDraft: () => draft } as unknown as SubmissionComposerPort),
    { values: () => staged },
  )

  // The renderer never receives a writer: `occurrences()` is the whole surface.
  assert.deepEqual(Object.keys(projection), ['occurrences'])
  for (const forbidden of ['add', 'remove', 'clear', 'submit', 'upload', 'path']) {
    assert.equal(forbidden in projection, false, `the projection must not expose ${forbidden}`)
  }

  assert.deepEqual(projection.occurrences(), [], 'an empty draft references nothing')
  draft = `${staged[0]!.placeholder} and ${staged[1]!.placeholder}`
  assert.deepEqual(projection.occurrences().map(occurrence => occurrence.image.id), [1, 2],
    'the projection re-reads the live text on every call')
  draft = staged[1]!.placeholder
  assert.deepEqual(projection.occurrences().map(occurrence => occurrence.image.id), [2],
    'deleting a token retires that occurrence on the NEXT call — no cache, no list')
})

test('the draft projection answers [] before the mount or without a preview source', () => {
  const { createSurfaceDraftImageProjection } = runtimeModule()
  const seat = { getDraft: () => '[image #1 (640×360)]' } as unknown as SubmissionComposerPort

  assert.deepEqual(createSurfaceDraftImageProjection(() => undefined, { values: () => [] }).occurrences(), [],
    'no live composer yet answers [] — never a fabricated occurrence')
  assert.deepEqual(createSurfaceDraftImageProjection(() => seat, undefined).occurrences(), [],
    'no preview source answers [] rather than inventing a store')
})

/** The runtime module's draft-projection construction (the ONE production path). */
function runtimeModule(): { createSurfaceDraftImageProjection: typeof import('../../src/app/surface/runtime.ts')['createSurfaceDraftImageProjection'] } {
  return { createSurfaceDraftImageProjection: runtime.createSurfaceDraftImageProjection }
}

/** One staged draft of the given name and a canonical placeholder. */
function stagedDraft(name: string): import('../../src/client/media/image/types.ts').DraftImage {
  const id = name === 'a.png' ? 1 : 2
  return {
    id,
    kind: 'image',
    source: { type: 'clipboard' },
    bytes: new Uint8Array(4),
    mediaType: 'image/png',
    width: 640,
    height: 360,
    byteLength: 4,
    name,
    placeholder: `[image #${id} (640×360)]`,
  }
}
