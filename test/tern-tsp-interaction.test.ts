/**
 * PR3-B B3 interaction-seat contract tests (the B3 addendum's §5.1).
 *
 * The chain under test is the PRODUCTION renderer mount:
 *
 *     ONE real `mountTspRenderer` over a scripted SDK terminal (the shared
 *     `test/support/tsp-terminal-fixture.ts` pane)
 *       -> the real interaction SEAT (layer/focus/FIFO/form state machine)
 *       -> the real SDK surface on the wire (the observation point)
 *
 * Every key in the PANE-driven cases travels as REAL tty bytes through the
 * SDK's ONE input loop (`SessionInput.key`). Two deliberate UNIT exceptions
 * call the seat's own API directly, because their subject is the seat contract
 * itself rather than a tty path: F1 injects a throwing render sink, and the
 * F6 retired-request guard drives the seat with decoded `Key` objects. The presenter's
 * promises are the ORIGINAL request promises, so an approval/question outcome
 * is asserted where the official port would receive it.
 *
 * STANDS-IN: the pane is a scripted tty (not a real Tern pane); the
 * question/timeout/continued lifecycle authority is the separately tested
 * `QuestionSurfaceController` (NOT re-implemented here) — these tests assert
 * only what the RENDERER owns: presentation, key routing, focus, settlement
 * and the wiring of the controller's own hooks.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-interaction.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect as sdkConnect } from '@stencil-hq/tern'
import type { Op } from '@stencil-hq/tern'
import { installTspPane, type TspPane } from './support/tsp-terminal-fixture.ts'
import { mountTspRenderer, type TspRenderer } from '../src/tui/tsp/session.ts'
import type { ApprovalOutcome, ApprovalPromptRequest, TuiQuestion, TuiQuestionAnswer, TuiQuestionStatus } from '../src/app/surface/interaction-presenter.ts'

const APPROVAL: ApprovalPromptRequest = { toolName: 'bash', reason: 'needs a shell', arguments: '{"cmd":"ls"}' }

/** One question with the official shape (defaults keep the cases terse). */
function question(overrides: Partial<TuiQuestion> & { id: string }): TuiQuestion {
  return { question: `ask ${overrides.id}`, ...overrides }
}

/** Wait until `predicate` holds (the SDK frames are flushed asynchronously). */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

interface ContinuedRow {
  readonly sessionId: string
  readonly callId: string
  readonly presentation: 'visible' | 'parked'
}

interface Harness {
  readonly pane: TspPane
  /** Bound after construction (the mount needs the harness for its callbacks). */
  renderer: TspRenderer
  readonly submits: string[]
  readonly cancels: number[]
  readonly exits: number[]
  readonly fatals: unknown[]
  /** The mutable Alt+Q authority this harness serves (tests own the contents). */
  readonly continued: ContinuedRow[]
  readonly reopenCalls: { sessionId: string; callId: string }[]
  /** The next Alt+Q reopen verdict; `onReopen` runs on a successful reopen. */
  reopenAnswer: boolean
  onReopen: (() => void) | undefined
  /** Every op the renderer put on the wire, in order. */
  ops(): Op[]
  frames(): readonly { readonly ops: readonly Op[] }[]
  /** The ids of every `del` op the wire carried. */
  deletions(): string[]
  dispose(): Promise<void>
}

/** Mount the REAL TSP renderer over the scripted pane and bind the input. */
async function mountHarness(): Promise<Harness> {
  const pane = installTspPane()
  const session = await sdkConnect({ app: 'dsh-pi-tui', timeout: 500 })
  assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')
  const submits: string[] = []
  const cancels: number[] = []
  const exits: number[] = []
  const fatals: unknown[] = []
  const continued: ContinuedRow[] = []
  const reopenCalls: { sessionId: string; callId: string }[] = []
  const harness: Harness = {
    pane,
    renderer: undefined as unknown as TspRenderer,
    submits,
    cancels,
    exits,
    fatals,
    continued,
    reopenCalls,
    reopenAnswer: false,
    onReopen: undefined,
    ops: () => pane.frames().flatMap(frame => frame.ops),
    frames: () => pane.frames(),
    deletions: () => pane.frames().flatMap(frame => frame.ops).filter(op => op[0] === 'del').map(op => String(op[1])),
    dispose: async () => {
      await harness.renderer.dispose()
      pane.restore()
    },
  }
  const renderer = mountTspRenderer(session, {
    requestExit: () => { exits.push(1) },
    onFatal: error => { fatals.push(error) },
  })
  renderer.bindInput({
    exit: () => { exits.push(1) },
    cancel: () => { cancels.push(1) },
    submit: text => { submits.push(text) },
    steer: () => {},
    noteUserInput: () => {},
    listContinuedQuestions: () => harness.continued,
    reopenContinuedQuestion: (sessionId, callId) => {
      reopenCalls.push({ sessionId, callId })
      if (!harness.reopenAnswer) return false
      harness.onReopen?.()
      return true
    },
  })
  harness.renderer = renderer
  return harness
}

/** The last op of a given kind, or `undefined`. */
function lastOp(ops: readonly Op[], kind: string): Op | undefined {
  return [...ops].reverse().find(op => op[0] === kind)
}

/** The `focus` targets in wire order. */
function focusTargets(ops: readonly Op[]): unknown[] {
  return ops.filter(op => op[0] === 'focus').map(op => op[1])
}

/** The overlay node ids added to the `layer` region. */
/** The OVERLAY ids added to the `layer` region — exactly `layer.modal-<n>`,
 *  never a nested node of one (which would inflate every modal-count assert). */
function overlayAdds(ops: readonly Op[]): string[] {
  return ops
    .filter(op => op[0] === 'add' && /^layer\.modal-\d+$/.test(String(op[1])))
    .map(op => String(op[1]))
}

/** The full JSON the renderer ever sent (the leak scan for masked values). */
function wireText(pane: TspPane): string {
  return pane.output.text()
}

// ── The single modal layer, focus, and the return to the composer ───────────

test('B3: an approval owns ONE layer overlay, unmounts it on settle, and returns the caret to an untouched composer', async () => {
  const harness = await mountHarness()
  try {
    harness.renderer.composer.setDraft('draft kept')
    const outcome = harness.renderer.interaction.showApprovalPrompt(APPROVAL, true)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the approval overlay reached the wire')

    // ONE overlay under the existing layer root, and the caret left the composer.
    assert.deepEqual(overlayAdds(harness.ops()), ['layer.modal-1'])
    const openOps = harness.ops()
    assert.equal(openOps.some(op => op[0] === 'del' && op[1] === 'layer'), false, 'the layer root is never deleted')
    assert.equal(lastOp(openOps, 'focus')?.[1], null, 'opening a modal focuses NONE')

    harness.pane.key('y')
    assert.equal(await outcome, 'allowed-once')
    await waitFor(() => harness.deletions().includes('layer.modal-1'), 'the modal node was deleted after settling')
    // The seat is closed: the layer root stays and the composer owns the caret.
    assert.equal(harness.deletions().includes('layer'), false)
    assert.equal(harness.renderer.composer.getDraft(), 'draft kept', 'the underlying composer draft is untouched')
    await waitFor(() => lastOp(harness.ops(), 'focus')?.[1] === 'dock.composer', 'the composer regained the caret')
    assert.deepEqual(harness.submits, [], 'no modal key ever reached the submit path')
  } finally {
    await harness.dispose()
  }
})

test('B3: approval keys are exactly y/n/Esc/Ctrl+C and every other key is consumed', async () => {
  const cases: { key: string; expected: ApprovalOutcome }[] = [
    { key: 'y', expected: 'allowed-once' },
    { key: 'n', expected: 'rejected' },
    { key: '\x1b', expected: 'cancelled' },
    { key: '\x03', expected: 'cancelled' },
  ]
  const harness = await mountHarness()
  try {
    for (const { key, expected } of cases) {
      const before = overlayAdds(harness.ops()).length
      const outcome = harness.renderer.interaction.showApprovalPrompt(APPROVAL, true)
      await waitFor(() => overlayAdds(harness.ops()).length > before, 'the modal opened')
      const modalId = overlayAdds(harness.ops())[before] ?? ''
      assert.notEqual(modalId, '')
      harness.pane.key(key)
      assert.equal(await outcome, expected, `key ${JSON.stringify(key)} settled ${expected}`)
      await waitFor(() => harness.deletions().includes(modalId), 'the modal was deleted')
    }
    // Unknown keys are consumed: no outcome, no submit, no composer edit.
    const before = overlayAdds(harness.ops()).length
    const pending = harness.renderer.interaction.showApprovalPrompt(APPROVAL, true)
    await waitFor(() => overlayAdds(harness.ops()).length > before, 'the modal opened')
    for (const key of ['\x04', '\r', '\x1b[200~y\x1b[201~', '\x1b[1;3y']) harness.pane.key(key)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(harness.submits.length, 0, 'no approval key reached the composer submit path')
    assert.equal(harness.renderer.composer.getDraft(), '', 'the composer stayed empty')
    const modalId = overlayAdds(harness.ops())[before] ?? ''
    assert.equal(harness.deletions().includes(modalId), false, 'the modal stayed open through the unknown keys')
    harness.pane.key('n')
    assert.equal(await pending, 'rejected')
  } finally {
    await harness.dispose()
  }
})

test('B3: a queued approval takes the seat without a second focus, and a reentrant successor is not answered by the first key', async () => {
  const harness = await mountHarness()
  try {
    // Two requests in flight: the second is QUEUED (not yet visible).
    const first = harness.renderer.interaction.showApprovalPrompt(APPROVAL, true)
    const second = harness.renderer.interaction.showApprovalPrompt({ toolName: 'bash', reason: 'second' }, true)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'only the active request is mounted')
    harness.pane.key('y')
    assert.equal(await first, 'allowed-once')
    await waitFor(() => overlayAdds(harness.ops()).length === 2, 'the queued successor took the seat')
    // The promotion committed a frame but must NOT re-issue a focus op (the
    // desired seat never changed): exactly ONE `focus null` for the whole run.
    assert.deepEqual(focusTargets(harness.ops()).filter(target => target === null), [null])
    harness.pane.key('n')
    assert.equal(await second, 'rejected', 'the second key settled the successor')
    assert.deepEqual(overlayAdds(harness.ops()), ['layer.modal-1', 'layer.modal-2'], 'the successor remounted under a fresh node id')
    await waitFor(() => lastOp(harness.ops(), 'focus')?.[1] === 'dock.composer', 'the composer regained the caret at the end')
  } finally {
    await harness.dispose()
  }
})

test('B3: abort settles the right approval (queued abort leaves the active one alone)', async () => {
  const harness = await mountHarness()
  try {
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    assert.equal(await harness.renderer.interaction.showApprovalPrompt({ ...APPROVAL, signal: alreadyAborted.signal }, true), 'cancelled')
    assert.deepEqual(overlayAdds(harness.ops()), [], 'an already-aborted request never mounts a modal')

    const activeAbort = new AbortController()
    const active = harness.renderer.interaction.showApprovalPrompt({ ...APPROVAL, signal: activeAbort.signal }, true)
    const queuedAbort = new AbortController()
    const queued = harness.renderer.interaction.showApprovalPrompt({ ...APPROVAL, reason: 'queued', signal: queuedAbort.signal }, true)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the active modal opened')
    queuedAbort.abort()
    assert.equal(await queued, 'cancelled', 'a queued abort settles only its own request')
    assert.equal(harness.deletions().includes('layer.modal-1'), false, 'the active modal was NOT interrupted')
    activeAbort.abort()
    assert.equal(await active, 'cancelled')
    await waitFor(() => harness.deletions().includes('layer.modal-1'), 'the active modal closed on abort')
  } finally {
    await harness.dispose()
  }
})

// ── The Question form ───────────────────────────────────────────────────────

/** One recording status the controller would supply. */
function statusOf(): { readonly status: TuiQuestionStatus; mutations: number; drafts: ReturnType<typeof snapshotOf>[] } {
  const recorder = {
    mutations: 0,
    drafts: [] as ReturnType<typeof snapshotOf>[],
    status: undefined as unknown as TuiQuestionStatus,
  }
  recorder.status = {
    text: 'expires in 30s',
    onAnswerMutation: () => { recorder.mutations += 1 },
    onDraftChange: draft => { recorder.drafts.push(snapshotOf(draft)) },
  }
  return recorder
}

function snapshotOf(draft: { readonly tab: number; readonly answers: readonly { readonly selected: readonly string[]; readonly custom: string; readonly skipped: boolean }[] }): { tab: number; answers: { selected: string[]; custom: string; skipped: boolean }[] } {
  return { tab: draft.tab, answers: draft.answers.map(answer => ({ selected: [...answer.selected], custom: answer.custom, skipped: answer.skipped })) }
}

test('B3: a single-select question highlights the intent.approve option and delivers the real option labels', async () => {
  const harness = await mountHarness()
  const recorder = statusOf()
  try {
    const questions = [question({
      id: 'q1',
      question: 'Which target?',
      options: [{ label: 'alpha' }, { label: 'beta (recommended)', description: 'the fast one' }],
      intent: { kind: 'approve', approve: 'alpha' },
    })]
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, recorder.status, false)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the question form opened')
    // The status line and the option list are on the wire (the suffix is
    // stripped for display; the answer keeps the ORIGINAL label).
    const text = wireText(harness.pane)
    assert.ok(text.includes('expires in 30s'), 'the controller status line is rendered')
    assert.ok(text.includes('beta'), 'the option is rendered')
    assert.ok(text.includes('[recommended]'), 'the recommended option is marked')
    // The highlighted row is intent.approve's (alpha) — Enter adopts it and
    // advances to the review page, where Enter submits the batch.
    harness.pane.key('\r')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'q1', selected: ['alpha'] }])
    assert.equal(recorder.mutations, 1, 'the FIRST real answer mutation fired the hook exactly once')
    assert.equal(recorder.drafts.at(-1)?.tab, 1, 'the final draft carries the review tab')
    assert.deepEqual(recorder.drafts.at(-1)?.answers[0], { selected: ['alpha'], custom: '', skipped: false })
  } finally {
    await harness.dispose()
  }
})

test('B3: a multi-select question toggles with Space, keeps original option order and submits with Enter', async () => {
  const harness = await mountHarness()
  const recorder = statusOf()
  try {
    const questions = [question({
      id: 'q2',
      question: 'Pick any',
      multiSelect: true,
      options: [{ label: 'one' }, { label: 'two' }, { label: 'three' }],
    })]
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, recorder.status, false)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the question form opened')
    harness.pane.key(' ')            // toggle 'one'
    harness.pane.key('\x1b[B')       // down
    harness.pane.key(' ')            // toggle 'two'
    await waitFor(() => recorder.mutations === 2, 'each real toggle fired the mutation hook; the highlight move did not')
    harness.pane.key('\r')           // continue (answered -> advance to review)
    harness.pane.key('\r')           // submit from review
    assert.deepEqual(await answers, [{ id: 'q2', selected: ['one', 'two'] }])
  } finally {
    await harness.dispose()
  }
})

test('B3: an unanswered question marked forward is skipped, and Review returns to the last question', async () => {
  const harness = await mountHarness()
  const recorder = statusOf()
  try {
    const questions = [
      question({ id: 'q3', question: 'first', multiSelect: true, options: [{ label: 'a' }] }),
      question({ id: 'q4', question: 'second', options: [{ label: 'x' }, { label: 'y' }] }),
    ]
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, recorder.status, false)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the form opened')
    harness.pane.key('\x1b[C')       // → : unanswered first question becomes skipped
    harness.pane.key('\x1b[C')       // → : review
    harness.pane.key('\x1b[D')       // ← : back to the last question
    harness.pane.key('\x1b[B')       // down to 'y'
    harness.pane.key('\r')           // adopt 'y'
    harness.pane.key('\r')           // submit from review
    assert.deepEqual(await answers, [{ id: 'q3', selected: [] }, { id: 'q4', selected: ['y'] }])
    assert.deepEqual(recorder.drafts.at(-1)?.answers[0], { selected: [], custom: '', skipped: true })
  } finally {
    await harness.dispose()
  }
})

test('B3: a masked free-text answer never reaches the wire and is returned through the original promise', async () => {
  const harness = await mountHarness()
  const recorder = statusOf()
  try {
    const questions = [question({ id: 'q5', question: 'Token?', masked: true })]
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, recorder.status, false)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the form opened')
    const secret = 'sentinel-secret-42'
    harness.pane.key(secret)
    // The bullets render, the plaintext does not — checked on the WIRE.
    await waitFor(() => wireText(harness.pane).includes('•'), 'the masked display reached the wire')
    assert.equal(wireText(harness.pane).includes(secret), false, 'the masked plaintext never reached the wire')
    // The FIRST Esc leaves the edit (text kept), the second cancels the form.
    // Each Esc is a LONE byte the decoder holds for its 30 ms flush, so the
    // next step waits for the observable state change instead of a timer.
    harness.pane.key('\x1b')
    await waitFor(() => wireText(harness.pane).includes('enter edit'), 'the free-text edit closed')
    assert.equal(wireText(harness.pane).includes(secret), false, 'leaving the edit leaks nothing either')
    harness.pane.key('\x1b')
    await assert.rejects(answers, /question flow cancelled/)
    assert.equal(recorder.drafts.at(-1)?.answers[0]?.custom, secret, 'the draft snapshot keeps the real answer for park/reopen')
  } finally {
    await harness.dispose()
  }
})

test('B3: an optionless question edits free text, Esc→Enter round trip keeps it, and Enter confirms through Review', async () => {
  const harness = await mountHarness()
  const recorder = statusOf()
  try {
    const questions = [question({ id: 'q6', question: 'Anything else?' })]
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, recorder.status, false)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the form opened')
    harness.pane.key('hi')
    harness.pane.key('\x7f')         // backspace
    harness.pane.key('i!')           // 'hi!'
    await waitFor(() => recorder.mutations === 5, 'each real text mutation fired the hook (2 + 1 + 2)')
    harness.pane.key('\x1b')         // first Esc: navigation state (text kept)
    await waitFor(() => wireText(harness.pane).includes('enter edit'), 'the edit closed with the text kept')
    harness.pane.key('\r')           // re-enter the edit
    harness.pane.key('?')            // 'hi!?'
    harness.pane.key('\r')           // confirm (answered -> review)
    harness.pane.key('\r')           // submit
    assert.deepEqual(await answers, [{ id: 'q6', selected: [], custom: 'hi!?' }])
  } finally {
    await harness.dispose()
  }
})

test('B3: an initialDraft restores the parked progress (tab, selection, custom)', async () => {
  const harness = await mountHarness()
  const recorder = statusOf()
  try {
    const questions = [
      question({ id: 'q7', question: 'first', options: [{ label: 'a' }, { label: 'b' }] }),
      question({ id: 'q8', question: 'second', options: [{ label: 'c' }, { label: 'd' }] }),
    ]
    const status: TuiQuestionStatus = {
      ...recorder.status,
      initialDraft: {
        tab: 1,
        answers: [
          { selected: ['b'], custom: '', skipped: false },
          { selected: ['d'], custom: '', skipped: false },
        ],
      },
    }
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, status, false)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the form opened')
    // The second question is the current page with 'd' already selected: Enter
    // adopts the highlighted row ('c' by default) — proving the tab came from
    // the draft, not from position 0.
    harness.pane.key('\r')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'q7', selected: ['b'] }, { id: 'q8', selected: ['c'] }])
  } finally {
    await harness.dispose()
  }
})

// ── Alt+Q: the continued-question list ──────────────────────────────────────

test('B3: Alt+Q reads the parked rows fresh, reopens through the controller, and closes the list first', async () => {
  const harness = await mountHarness()
  try {
    harness.pane.key('\x1bq')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(overlayAdds(harness.ops()), [], 'no rows -> no layer opened')
    assert.ok(wireText(harness.pane).includes('No continued questions'), 'the empty list is notified')

    harness.continued.push(
      { sessionId: 'session-a', callId: 'call-visible', presentation: 'visible' },
      { sessionId: 'session-a', callId: 'call-parked', presentation: 'parked' },
    )
    harness.reopenAnswer = true
    harness.onReopen = () => { void harness.renderer.interaction.showApprovalPrompt({ toolName: 'tool', reason: 'reopened' }, false) }
    harness.pane.key('\x1bq')
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the list opened')
    const listText = wireText(harness.pane)
    assert.ok(listText.includes('call-parked'), 'only the parked row is listed')
    assert.equal(listText.includes('call-visible'), false, 'a visible row is not a continued entry')
    harness.pane.key('\r')
    await waitFor(() => harness.reopenCalls.length === 1, 'the controller reopen ran')
    assert.deepEqual(harness.reopenCalls, [{ sessionId: 'session-a', callId: 'call-parked' }])
    // The list is closed BEFORE the reopen, and the reopened request takes the seat.
    assert.deepEqual(harness.deletions().slice(0, 1), ['layer.modal-1'], 'the list seat closed first')
    await waitFor(() => wireText(harness.pane).includes('reopened'), 'the real form replaced the list')
  } finally {
    await harness.dispose()
  }
})

test('B3: a refused Alt+Q reopen only notifies, and a new official request preempts the list', async () => {
  const harness = await mountHarness()
  try {
    harness.continued.push({ sessionId: 'session-a', callId: 'call-stale', presentation: 'parked' })
    harness.reopenAnswer = false
    harness.pane.key('\x1bq')
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the list opened')
    harness.pane.key('\r')
    await waitFor(() => harness.reopenCalls.length === 1, 'the refused reopen was attempted')
    // The refusal notice rides a frame, so it is awaited like every other
    // presentation fact (a bare read here raced the frame flush under load).
    await waitFor(() => wireText(harness.pane).includes('That question is no longer answerable'), 'a refusal is visible')
    await waitFor(() => harness.deletions().includes('layer.modal-1'), 'the list is gone')

    harness.pane.key('\x1bq')
    await waitFor(() => harness.deletions().includes('layer.modal-1') && overlayAdds(harness.ops()).length === 2, 'the list reopened')
    const pending = harness.renderer.interaction.showApprovalPrompt(APPROVAL, true)
    await waitFor(() => overlayAdds(harness.ops()).length === 3, 'the official request took the seat')
    harness.pane.key('y')
    assert.equal(await pending, 'allowed-once')
  } finally {
    await harness.dispose()
  }
})

// ── Hydration, the shared fence and the SDK event gate ──────────────────────

test('B3: the modal seat outranks the hydration fence, while Alt+Q stays fenced out', async () => {
  const harness = await mountHarness()
  try {
    const pending = harness.renderer.interaction.showApprovalPrompt(APPROVAL, true)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the modal opened')
    harness.renderer.display.beginSessionHydration()
    // The modal still answers while the surface replaces its subject.
    harness.pane.key('y')
    assert.equal(await pending, 'allowed-once')
    // The composer stays fenced: a typed key is dropped, Alt+Q opens nothing.
    harness.pane.key('x')
    harness.continued.push({ sessionId: 'session-a', callId: 'call-parked', presentation: 'parked' })
    harness.pane.key('\x1bq')
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(harness.renderer.composer.getDraft(), '', 'the hydration fence dropped the composer key')
    assert.deepEqual(overlayAdds(harness.ops()).slice(1), [], 'Alt+Q never opens a list during hydration')
  } finally {
    await harness.dispose()
  }
})

test('B3: a terminal focus event cannot move the caret away from an open form', async () => {
  const harness = await mountHarness()
  try {
    // Without a modal the event is not the seat's business: no new focus op.
    const before = focusTargets(harness.ops()).length
    harness.pane.event({ ev: 'focus', sf: 's1', id: 'dock.composer' })
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(focusTargets(harness.ops()).length, before, 'an idle renderer ignores the focus event')

    const pending = harness.renderer.interaction.showApprovalPrompt(APPROVAL, true)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the modal opened')
    const focused = focusTargets(harness.ops()).length
    harness.pane.event({ ev: 'focus', sf: 's1', id: 'dock.composer' })
    await waitFor(() => focusTargets(harness.ops()).length > focused, 'the seat re-asserted its own caret')
    assert.equal(lastOp(harness.ops(), 'focus')?.[1], null, 'the modal keeps the caret, not the composer')
    harness.pane.key('y')
    assert.equal(await pending, 'allowed-once')
  } finally {
    await harness.dispose()
  }
})

test('B3: a question form focuses its real input node only while the free-text editor is open', async () => {
  const harness = await mountHarness()
  try {
    const answers = harness.renderer.interaction.askQuestions([question({ id: 'q9', question: 'Anything?', options: [{ label: 'a' }] })], undefined, undefined, false)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the form opened')
    // The option list owns no caret; choosing "Type something." opens the input.
    harness.pane.key('\x1b[B')   // down to the free-text row
    harness.pane.key('\r')       // enter the edit
    await waitFor(() => lastOp(harness.ops(), 'focus')?.[1] === 'layer.modal-1.answer', 'the modal input got the caret')
    harness.pane.key('ok\r')     // type + confirm -> review
    harness.pane.key('\r')       // submit
    assert.deepEqual(await answers, [{ id: 'q9', selected: [], custom: 'ok' }])
    await waitFor(() => lastOp(harness.ops(), 'focus')?.[1] === 'dock.composer', 'the composer regained the caret')
  } finally {
    await harness.dispose()
  }
})

test('B3: disposal settles an unanswered form so no caller hangs', async () => {
  const harness = await mountHarness()
  try {
    const approval = harness.renderer.interaction.showApprovalPrompt(APPROVAL, true)
    // The rejection is observed THROUGH this handler: the seat settles it during
    // disposal, before the test would otherwise attach one.
    const answers = harness.renderer.interaction
      .askQuestions([question({ id: 'qa', question: 'q', options: [{ label: 'a' }] })], undefined, undefined, false)
      .then(() => undefined, (error: unknown) => error)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the first modal opened')
    await harness.renderer.dispose()
    assert.equal(await approval, 'cancelled')
    assert.match(String(await answers), /question flow cancelled/)
  } finally {
    harness.pane.restore()
  }
})

/**
 * The bounded outcome of one pending request: a leaked slot would leave the
 * promise PENDING forever, so the race turns that leak into a clean failure
 * instead of a hanging suite.
 */
async function settledOrPending(pending: Promise<unknown>): Promise<string> {
  return await Promise.race([
    pending.then(value => String(value)),
    new Promise<string>(resolve => { setTimeout(() => { resolve('PENDING') }, 200) }),
  ])
}

// ── Findings C/F6/F7/F8: a replaced Session's form leaves the seat ───────────

test('B3 finding C: withdrawPresentation drops the form and releases the input (the promise stays with its own lifetime)', async () => {
  const { createTspInteractionSeat } = await import('../src/tui/tsp/interaction.ts')
  const seat = createTspInteractionSeat({
    render: () => {},
    onFatal: error => { throw new Error(`unexpected fatal: ${String(error)}`) },
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
  })
  const callbacks = { listContinuedQuestions: () => [], reopenContinuedQuestion: () => false }
  const abort = new AbortController()
  const answers = seat.presenter
    .askQuestions([question({ id: 'c1', question: 'q', options: [{ label: 'a' }] })], abort.signal, undefined, false)
    .then(() => undefined, (error: unknown) => error)
  assert.equal(seat.hasModalSeat(), true, 'the live form owns the seat')
  let settled = false
  void answers.then(() => { settled = true })

  // The replacement Session's publication withdraws the PRESENTATION.
  seat.withdrawPresentation(abort.signal)
  assert.equal(seat.hasModalSeat(), false, 'the withdrawn form no longer owns the seat')
  assert.equal(
    seat.handleKey({ name: 'y', ctrl: false, alt: false, shift: false, meta: false }, callbacks),
    false, 'the withdrawn form no longer consumes keys (the input seat is released)')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(settled, false, 'the withdrawal settles nothing: the Host still owns the request')

  // Its OWN lifetime still ends exactly that promise.
  abort.abort()
  assert.match(await settledOrPending(answers), /question flow aborted/)

  // A teardown AFTER a withdrawal still settles what the seat owns.
  const second = new AbortController()
  const secondAnswers = seat.presenter
    .askQuestions([question({ id: 'c2', question: 'q', options: [{ label: 'a' }] })], second.signal, undefined, false)
    .then(() => undefined, (error: unknown) => error)
  seat.withdrawPresentation(second.signal)
  assert.equal(seat.hasModalSeat(), false)
  seat.dispose()
  assert.match(await settledOrPending(secondAnswers), /question flow cancelled/)
})

test('B3 findings F6/F7: a lifetime retired BEFORE its slot exists never mounts, and its own lifetime still settles it', async () => {
  const { createTspInteractionSeat } = await import('../src/tui/tsp/interaction.ts')
  const fatals: unknown[] = []
  const seat = createTspInteractionSeat({
    render: () => {},
    onFatal: error => { fatals.push(error) },
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
  })
  const callbacks = { listContinuedQuestions: () => [], reopenContinuedQuestion: () => false }
  const abort = new AbortController()
  // The Session was replaced while the flow was still OPENING (the controller's
  // held claim): the retirement lands before any slot exists.
  seat.withdrawPresentation(abort.signal)
  const answers = seat.presenter
    .askQuestions([question({ id: 'f7', question: 'q', options: [{ label: 'a' }] })], abort.signal, undefined, false)
    .then(() => undefined, (error: unknown) => error)
  assert.equal(seat.hasModalSeat(), false, 'a retired lifetime never mounts its form')
  assert.equal(
    seat.handleKey({ name: 'enter', ctrl: false, alt: false, shift: false, meta: false }, callbacks),
    false, 'a never-mounted form consumes no keys')
  // Still owned: only its OWN lifetime settles that request.
  abort.abort()
  assert.match(await settledOrPending(answers), /question flow aborted/)

  // An APPROVAL prompt shares the rule (finding F6: the same presentation
  // authority, no separate approval path).
  const approvalAbort = new AbortController()
  seat.withdrawPresentation(approvalAbort.signal)
  const approval = seat.presenter.showApprovalPrompt({ toolName: 'bash', reason: 'retired', signal: approvalAbort.signal }, true)
  assert.equal(seat.hasModalSeat(), false, 'a retired lifetime never mounts its approval prompt')
  approvalAbort.abort()
  assert.equal(await approval, 'cancelled', 'the Host withdrawal settles the retired approval fail-closed')
  assert.deepEqual(fatals, [], 'no fatal path ran for either retirement')
  seat.dispose()
})

test('B3 finding F8: a withdrawal whose frame commit fails reaches the renderer fatal sink and settles nothing itself', async () => {
  const { createTspInteractionSeat } = await import('../src/tui/tsp/interaction.ts')
  const fatals: unknown[] = []
  let failFrame = false
  const injected = new Error('withdrawal frame failed')
  const seat = createTspInteractionSeat({
    render: () => { if (failFrame) throw injected },
    onFatal: error => { fatals.push(error) },
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
  })
  const abort = new AbortController()
  const answers = seat.presenter
    .askQuestions([question({ id: 'f8', question: 'q', options: [{ label: 'a' }] })], abort.signal, undefined, false)
    .then(() => undefined, (error: unknown) => error)
  assert.equal(seat.hasModalSeat(), true, 'the live form owns the seat')
  failFrame = true
  // Must not throw into the publication/reconcile call stack: the failure is the
  // renderer's own FATAL path, exactly like a failing presentation or settlement.
  seat.withdrawPresentation(abort.signal)
  assert.equal(fatals.length, 1, 'the renderer fatal sink received the withdrawal failure')
  assert.equal(fatals[0], injected, 'the ORIGINAL error object reaches the sink unchanged')
  assert.equal(seat.hasModalSeat(), false, 'the slot had already left the seat')
  // The withdrawal settles nothing: the request keeps its own lifetime, and it
  // is still PENDING right up to its own abort.
  let settledBeforeAbort = false
  void answers.then(() => { settledBeforeAbort = true })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(settledBeforeAbort, false, 'the withdrawal never settled the request')
  abort.abort()
  assert.match(await settledOrPending(answers), /question flow aborted/)
  seat.dispose()
})

// ── Failure and mutation-hook contracts (review findings F1–F3) ─────────────

test('B3 F1: a frame failure while PRESENTING a form is fatal, settles once and leaves no ghost seat', async () => {
  const { createTspInteractionSeat } = await import('../src/tui/tsp/interaction.ts')
  const fatals: unknown[] = []
  let fail = true
  const seat = createTspInteractionSeat({
    render: () => { if (fail) throw new Error('frame failed') },
    onFatal: error => { fatals.push(error) },
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
  })
  try {
    // The approval path: the broken FIRST presentation must not resolve an
    // allow, must not leave the seat up, and must reach the fatal sink.
    assert.equal(await seat.presenter.showApprovalPrompt(APPROVAL, true), 'cancelled')
    assert.equal(seat.hasModalSeat(), false, 'no ghost seat keeps swallowing keys')
    assert.equal(fatals.length, 1, 'the fatal path received the presentation failure')
    assert.match(String(fatals[0]), /frame failed/)

    // The question path shares the same exit.
    const answers = seat.presenter
      .askQuestions([question({ id: 'f1', question: 'q', options: [{ label: 'a' }] })], undefined, undefined, false)
      .then(() => undefined, (error: unknown) => error)
    assert.match(String(await answers), /question flow cancelled/)
    assert.equal(seat.hasModalSeat(), false)
    assert.equal(fatals.length, 2)

    // Only the broken PRESENTATION retired: a working renderer keeps the seat.
    fail = false
    const ok = seat.presenter.showApprovalPrompt(APPROVAL, true)
    assert.equal(seat.hasModalSeat(), true)
    seat.handleKey({ name: 'y', ctrl: false, alt: false, shift: false, meta: false }, { listContinuedQuestions: () => [], reopenContinuedQuestion: () => false })
    assert.equal(await ok, 'allowed-once')
  } finally {
    seat.dispose()
  }
})

test('B3 F2: a real single-select choice invalidates the replaced Other text (it cannot resurrect)', async () => {
  const harness = await mountHarness()
  try {
    const answers = harness.renderer.interaction.askQuestions(
      [question({ id: 'f2', question: 'Pick', options: [{ label: 'A' }] })], undefined, undefined, false,
    )
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the form opened')
    harness.pane.key('\x1b[B')   // down to "Type something."
    harness.pane.key('\r')       // enter the free-text edit
    harness.pane.key('stale')    // synthetic replaced text
    harness.pane.key('\r')       // commit -> review (custom = 'stale')
    harness.pane.key('\x1b[D')   // back to the question
    harness.pane.key('\r')       // adopt A: the custom AND its editor buffer go
    harness.pane.key('\x1b[D')   // back to the question again
    harness.pane.key('\x1b[B')   // down to "Type something."
    harness.pane.key('\r')       // reopen the edit: it must be EMPTY
    harness.pane.key('\r')       // an empty commit keeps the current selection
    harness.pane.key('\r')       // submit from review
    assert.deepEqual(await answers, [{ id: 'f2', selected: ['A'] }],
      'the replaced Other text must not come back and overwrite the real choice')
  } finally {
    await harness.dispose()
  }
})

test('B3 F3: re-confirming the same answer fires no real-answer mutation hook', async () => {
  const harness = await mountHarness()
  const recorder = statusOf()
  try {
    const answers = harness.renderer.interaction.askQuestions(
      [question({ id: 'f3', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] })], undefined, recorder.status, false,
    )
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the form opened')
    harness.pane.key('\r')       // adopt A (a REAL change) -> review
    await waitFor(() => recorder.mutations === 1, 'the first real answer change fired the hook')
    harness.pane.key('\x1b[D')   // back to the question
    harness.pane.key('\r')       // re-confirm A: no answer semantics change
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(recorder.mutations, 1, 'a no-op re-confirmation is not a real-answer mutation')
    harness.pane.key('\r')       // submit from review
    assert.deepEqual(await answers, [{ id: 'f3', selected: ['A'] }])
  } finally {
    await harness.dispose()
  }
})

test('B3 F6.3: a retired request detaches its real listener and cannot write into the seat that follows it', async () => {
  const { createTspInteractionSeat } = await import('../src/tui/tsp/interaction.ts')
  let renders = 0
  const seat = createTspInteractionSeat({
    render: () => { renders += 1 },
    onFatal: () => {},
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
  })
  const callbacks = { listContinuedQuestions: () => [], reopenContinuedQuestion: () => false }
  const key = (name: string) => ({ name, ctrl: false, alt: false, shift: false, meta: false })
  // Observe the REAL EventTarget calls: the unbound originals are called with
  // the signal as receiver (never `.bind`, which would pin the receiver), and
  // the registered/removed LISTENER IDENTITIES are compared strictly.
  // `addEventListener(type, listener, options)`: args[1] is the listener — args[0]
  // is the event TYPE, so recording it would compare 'abort' with 'abort'.
  const controller = new AbortController()
  const signal = controller.signal
  const added: unknown[] = []
  const removed: unknown[] = []
  const target = Object.getPrototypeOf(signal) as EventTarget
  const originalAdd = target.addEventListener
  const originalRemove = target.removeEventListener
  Object.defineProperty(signal, 'addEventListener', {
    configurable: true,
    value: function (this: AbortSignal, ...args: Parameters<EventTarget['addEventListener']>) {
      added.push(args[1])
      return originalAdd.call(this, ...args)
    },
  })
  Object.defineProperty(signal, 'removeEventListener', {
    configurable: true,
    value: function (this: AbortSignal, ...args: Parameters<EventTarget['removeEventListener']>) {
      removed.push(args[1])
      return originalRemove.call(this, ...args)
    },
  })
  const hooks = { mutation: 0, draft: 0 }
  try {
    const answers = seat.presenter.askQuestions(
      [question({ id: 'r1', question: 'Retired?', options: [{ label: 'A' }] })],
      signal,
      {
        onAnswerMutation: () => { hooks.mutation += 1 },
        onDraftChange: () => { hooks.draft += 1 },
      },
      false,
    )
    assert.equal(added.length, 1, 'the live slot registered exactly one abort listener')
    seat.handleKey(key('enter'), callbacks)
    seat.handleKey(key('enter'), callbacks)
    assert.deepEqual(await answers, [{ id: 'r1', selected: ['A'] }])
    assert.equal(removed.length, 1, 'settlement removed the abort listener')
    assert.equal(removed[0], added[0], 'the SAME listener identity was removed (no leak, no stranger)')

    // The successor owns the seat; the retired request's late lifetime event
    // and its callbacks must reach neither the presentation nor the new form.
    const mutationAtRetirement = hooks.mutation
    const draftAtRetirement = hooks.draft
    const next = seat.presenter.askQuestions(
      [question({ id: 'n1', question: 'Next?', options: [{ label: 'B' }] })], undefined, undefined, false,
    )
    await Promise.resolve()
    const rendersWithNext = renders
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(renders, rendersWithNext, 'the retired lifetime repaints nothing in the new seat')
    assert.equal(hooks.mutation, mutationAtRetirement, 'the retired mutation hook never fires again')
    assert.equal(hooks.draft, draftAtRetirement, 'the retired draft hook never fires again')
    assert.equal(seat.hasModalSeat(), true, 'the new seat still owns the modal')
    seat.handleKey(key('enter'), callbacks)   // adopt B
    seat.handleKey(key('enter'), callbacks)   // submit
    assert.deepEqual(await next, [{ id: 'n1', selected: ['B'] }], 'the new request answered normally')
  } finally {
    seat.dispose()
  }
})

test('B3 P3: closeTransientList releases the seat and the input (a replacement never inherits the list)', async () => {
  const { createTspInteractionSeat } = await import('../src/tui/tsp/interaction.ts')
  const renders: number[] = []
  const seat = createTspInteractionSeat({
    render: () => { renders.push(1) },
    onFatal: error => { throw new Error(`unexpected fatal: ${String(error)}`) },
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
  })
  const callbacks = {
    listContinuedQuestions: () => [{ sessionId: 'session-a', callId: 'call-1', presentation: 'parked' as const }],
    reopenContinuedQuestion: () => true,
  }
  const key = (name: string) => ({ name, ctrl: false, alt: false, shift: false, meta: false })
  assert.equal(seat.openContinuedList(callbacks), true, 'the transient list opens over the parked row')
  assert.equal(seat.hasModalSeat(), true, 'the list owns the seat while open')
  seat.closeTransientList()
  assert.equal(seat.hasModalSeat(), false, 'a replacement closes the list')
  assert.equal(seat.handleKey(key('enter'), callbacks), false, 'the closed list consumes no keys')
  seat.closeTransientList()
  assert.equal(seat.hasModalSeat(), false, 'a repeated close is inert')
  seat.dispose()
})

test('B3 P2-D: a batched withdrawal commits ONE frame and never promotes a member of the batch', async () => {
  const { createTspInteractionSeat } = await import('../src/tui/tsp/interaction.ts')
  const frames: string[] = []
  const seat = createTspInteractionSeat({
    render: () => { frames.push(JSON.stringify(seat.renderLayer())) },
    onFatal: error => { throw new Error(`unexpected fatal: ${String(error)}`) },
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
  })
  const first = new AbortController()
  const second = new AbortController()
  const successor = new AbortController()
  const settled: string[] = []
  void seat.presenter.showApprovalPrompt({ toolName: 'bash', reason: 'A first', signal: first.signal }, true)
  void seat.presenter.showApprovalPrompt({ toolName: 'bash', reason: 'A second', signal: second.signal }, true)
  assert.match(frames.at(-1) ?? '', /A first/, 'the first request owns the seat')
  assert.doesNotMatch(frames.at(-1) ?? '', /A second/, 'the second request is queued, not painted')
  // A request for the SUCCESSOR subject is already queued behind them.
  void seat.presenter.showApprovalPrompt({ toolName: 'bash', reason: 'B request', signal: successor.signal }, true)
    .then(value => { settled.push(`B:${String(value)}`) }, error => { settled.push(`B:${String(error)}`) })
  const framesBefore = frames.length

  // The replacement withdraws BOTH replaced requests in ONE batch.
  seat.withdrawPresentations([first.signal, second.signal])
  assert.equal(frames.length, framesBefore + 1, 'the batch commits exactly ONE frame')
  assert.doesNotMatch(frames.at(-1) ?? '', /A first|A second/,
    'no member of the batch is promoted (or painted) in that frame')
  assert.match(frames.at(-1) ?? '', /B request/, 'the queued successor takes the seat in the SAME frame')
  assert.equal(seat.hasModalSeat(), true, 'the successor owns the seat afterwards')

  // The replaced requests keep their own lifetimes.
  first.abort()
  second.abort()
  successor.abort()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(settled, ['B:cancelled'], 'the successor settles for its own lifetime')
  seat.dispose()
})
