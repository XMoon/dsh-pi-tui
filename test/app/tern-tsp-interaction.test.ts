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
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { wireNodes, type WireNode } from '../support/tsp-picker-wire.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import type { ApprovalOutcome, ApprovalPromptRequest, TuiQuestion, TuiQuestionAnswer, TuiQuestionStatus } from '../../src/app/surface/interaction-presenter.ts'

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

/**
 * `pane.key()` is NOT synchronous as far as the RENDERER is concerned.
 *
 * The pane emits `data` synchronously, but the shipped SDK delivers it through
 * its own async input loop (`for await (const input of session)` in
 * src/tui/tsp/session.ts), so the renderer's `routeInput` runs on a later turn.
 * Measured on this fixture: immediately after `pane.key('z')` the composer is
 * still empty and only a later turn carries the `z`. A barrier that merely
 * draws a frame therefore CANNOT prove a key was processed — the frame can win
 * the race.
 *
 * A test that can name the key's effect waits for THAT effect directly (the
 * cases below that do have one do exactly that). A pure "this must not happen"
 * case has no positive sink by contract, so it keeps a bounded observation
 * window whose reason is stated next to it (docs/guides/testing.md).
 */
const KEY_DELIVERY_WINDOW_MS = 120

/** Wait for the SDK input loop to have had the chance to deliver and process a
 *  key: a bounded window, justified by the loop being the ONLY producer.
 *
 *  Used by the negative cases only. The bound is not a guess about how long an
 *  arbitrary operation takes — it covers exactly one input dispatch plus the
 *  renderer's synchronous handling, and the assertion that follows is about an
 *  absence that must hold for EVERY such dispatch. */
async function waitForKeyDeliveryWindow(): Promise<void> {
  // reason: bounded negative-observation window — the SDK's async input loop is
  // the single producer of a routed key, and a key the surface DROPS has no
  // positive sink to await. The window covers one input dispatch plus the
  // renderer's synchronous handling of it.
  await new Promise<void>(resolve => setTimeout(resolve, KEY_DELIVERY_WINDOW_MS))
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

/** Mount the REAL TSP renderer over the scripted pane and bind the input.
 *
 * The default pane advertises the base vocabulary only, so the modal seat keeps
 * the LEGACY text form — the fail-closed default, exactly like an older client.
 * A case that wants the NATIVE composite branch opts in with
 * `nativeInteraction`, and a negative case narrows the advertised sets. */
async function mountHarness(options: {
  readonly nativeInteraction?: boolean
  readonly kinds?: readonly string[]
  readonly features?: readonly string[]
} = {}): Promise<Harness> {
  const pane = installTspPane(options)
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
  const renderer = mountTspRenderer(session, { copyVisual: async () => false,
    requestExit: () => { exits.push(1) },
    onFatal: error => { fatals.push(error) },
  })
  renderer.bindInput({
    exit: () => { exits.push(1) },
    cancel: () => { cancels.push(1) },
    submit: text => { submits.push(text) },
    steer: () => {},
    pasteMedia: () => {},
    pastedPath: () => {},
    admitPastedPathDelivery: () => true,
    noteUserInput: () => {},
    listContinuedQuestions: () => harness.continued,
    reopenContinuedQuestion: (sessionId, callId) => {
      reopenCalls.push({ sessionId, callId })
      if (!harness.reopenAnswer) return false
      harness.onReopen?.()
      return true
    },
    openModelPicker() {}, openModelQuick() {},
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

/** One node of the active modal overlay by its path suffix (wire-derived id). */
function modalNode(pane: TspPane, suffix: string): WireNode | undefined {
  return wireNodes(pane).find(node => /^layer\.modal-\d+\./.test(node.id) && node.id.endsWith(suffix))
}

test('B-hardening: a hostile approval request never emits its raw control bytes to the wire', async () => {
  const harness = await mountHarness()
  try {
    const hostile = 'tool\u001b]52;c;YXR0YWNr\u0007\u001b[2J\u001b]0;hijacked-title\u001b\\\u009b2J\r[y] allow once'
    const outcome = harness.renderer.interaction.showApprovalPrompt(
      { toolName: hostile, reason: hostile, arguments: hostile, danger: true },
      true,
    )
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the approval overlay reached the wire')
    const wire = wireText(harness.pane)
    assert.ok(!wire.includes('YXR0YWNr'), `no OSC 52 payload reaches the wire:\n${wire.slice(0, 400)}`)
    assert.ok(!wire.includes('hijacked-title'), 'no OSC 0 title payload reaches the wire')
    const ops = JSON.stringify(harness.ops())
    assert.ok(!ops.includes('\\u001b'), 'no raw ESC reaches a node prop')
    assert.ok(!ops.includes('\u009b'), 'no raw C1 byte reaches a node prop')
    assert.ok(ops.includes('[y] allow once'), 'the reason text itself still reads inline')
    harness.pane.key('n')
    assert.equal(await outcome, 'rejected')
  } finally {
    await harness.dispose()
  }
})

test('B-hardening: a hostile approval toolName never forges a second visual row', async () => {
  const harness = await mountHarness()
  try {
    const hostile = 'tool-a\n[y] allow once\t\u001b]52;c;YXR0YWNr\u0007'
    const outcome = harness.renderer.interaction.showApprovalPrompt(
      { toolName: hostile, reason: hostile, arguments: '{}' },
      true,
    )
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the approval overlay reached the wire')
    const tool = modalNode(harness.pane, '.tool')
    assert.ok(tool !== undefined, 'the approval tool label is on the wire')
    const toolText = String(tool.p.text ?? '')
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(toolText),
      `the tool label is ONE physical row: ${JSON.stringify(toolText)}`)
    assert.ok(toolText.includes('tool-a') && toolText.includes('[y] allow once'),
      `the readable label survives collapsed on that row: ${JSON.stringify(toolText)}`)
    harness.pane.key('n')
    assert.equal(await outcome, 'rejected')
  } finally {
    await harness.dispose()
  }
})

test('B-hardening: hostile question header/option labels fold to one prop row while prose stays multiline', async () => {
  const harness = await mountHarness()
  const recorder = statusOf()
  try {
    const questions = [question({
      id: 'q-hostile-labels',
      header: 'Header\n❯ Choice B',
      question: 'question body\nstays multi-line',
      detail: 'detail\nstays multi-line',
      options: [
        { label: 'Choice A\n❯ Choice B' },
        { label: 'Choice D', description: 'desc\nstays multi-line' },
      ],
    })]
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, recorder.status, false)
    await waitFor(() => modalNode(harness.pane, '.header') !== undefined, 'the question overlay reached the wire')
    const header = modalNode(harness.pane, '.header')
    const firstRow = modalNode(harness.pane, '.row-0')
    const secondRow = modalNode(harness.pane, '.row-1')
    assert.ok(header !== undefined && firstRow !== undefined && secondRow !== undefined,
      'the header and both option rows are on the wire')
    const headerText = String(header.p.text ?? '')
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(headerText),
      `the header is ONE physical row: ${JSON.stringify(headerText)}`)
    const firstText = String(firstRow.p.text ?? '')
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(firstText),
      `the option label is ONE physical row: ${JSON.stringify(firstText)}`)
    assert.ok(firstText.includes('Choice A ❯ Choice B'),
      `the collapsed label survives on that row: ${JSON.stringify(firstText)}`)
    const secondText = String(secondRow.p.text ?? '')
    assert.ok(secondText.includes('\n'),
      `the option description keeps its prose line break: ${JSON.stringify(secondText)}`)
    const questionText = String(modalNode(harness.pane, '.question')?.p.text ?? '')
    assert.ok(questionText.includes('\n'), 'the question body stays multi-line')
    harness.pane.key('\x1b')
    await assert.rejects(answers, /question flow cancelled/)
  } finally {
    await harness.dispose()
  }
})

// ── The single modal layer, focus, and the return to the composer ───────────

test('an approval owns ONE layer overlay, unmounts it on settle, and returns the caret to an untouched composer', async () => {
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

test('approval keys are exactly y/n/Esc/Ctrl+C and every other key is consumed', async () => {
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
    // The seat consumes these keys synchronously; the barrier flushes whatever
    // they produced, so the absences below cover the whole effect.
    await waitForKeyDeliveryWindow()
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

test('a queued approval takes the seat without a second focus, and a reentrant successor is not answered by the first key', async () => {
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

test('abort settles the right approval (queued abort leaves the active one alone)', async () => {
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

test('a single-select question highlights the intent.approve option and delivers the real option labels', async () => {
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

test('a multi-select question toggles with Space, keeps original option order and submits with Enter', async () => {
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

test('an unanswered question marked forward is skipped, and Review returns to the last question', async () => {
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

test('a masked free-text answer never reaches the wire and is returned through the original promise', async () => {
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

test('a masked answer stays masked on the Review page and the official answer keeps the real value', async () => {
  // §6.4-6's masked question type is unreachable through the agent tool (its schema
  // has no `masked` field) and the builtin masked prompt (`/auth`) is not a
  // TSP-reachable command, so the renderer's masked behaviour is covered here: the
  // DISPLAY masks one bullet per grapheme (edit + Review) while the authoritative
  // answer returned to the official controller carries the real value.
  const harness = await mountHarness()
  const recorder = statusOf()
  try {
    const questions = [question({ id: 'q5r', question: 'Token?', masked: true })]
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, recorder.status, false)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the form opened')
    const secret = 'sentinel-secret-42'
    harness.pane.key(secret)
    await waitFor(() => wireText(harness.pane).includes('•'), 'the masked display')
    assert.equal(wireText(harness.pane).includes(secret), false, 'the plaintext never reaches the wire')
    harness.pane.key('\r')
    await waitFor(() => wireText(harness.pane).includes('Review'), 'the review page')
    const review = wireText(harness.pane)
    assert.equal(review.includes(secret), false, 'the Review page keeps the masked value masked')
    assert.ok(review.includes('•'.repeat([...secret].length)), 'one bullet per grapheme on the Review page')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'q5r', selected: [], custom: secret }],
      'the official answer carries the real value, never the masked display')
  } finally {
    await harness.dispose()
  }
})

test('an optionless question edits free text, Esc→Enter round trip keeps it, and Enter confirms through Review', async () => {
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

test('an initialDraft restores the parked progress (tab, selection, custom)', async () => {
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

test('Alt+Q reads the parked rows fresh, reopens through the controller, and closes the list first', async () => {
  const harness = await mountHarness()
  try {
    harness.pane.key('\x1bq')
    // The notice IS this key's positive effect: wait for it on the wire instead
    // of drawing a barrier that could win the race against input delivery.
    await waitFor(() => wireText(harness.pane).includes('No continued questions'),
      'the empty continued-question list to be notified')
    assert.deepEqual(overlayAdds(harness.ops()), [], 'no rows -> no layer opened')

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

test('a refused Alt+Q reopen only notifies, and a new official request preempts the list', async () => {
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

test('the modal seat outranks the hydration fence, while Alt+Q stays fenced out', async () => {
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
    await waitForKeyDeliveryWindow()
    assert.equal(harness.renderer.composer.getDraft(), '', 'the hydration fence dropped the composer key')
    assert.deepEqual(overlayAdds(harness.ops()).slice(1), [], 'Alt+Q never opens a list during hydration')
  } finally {
    await harness.dispose()
  }
})

test('a terminal focus event cannot move the caret away from an open form', async () => {
  const harness = await mountHarness()
  try {
    // Without a modal the event is not the seat's business: no new focus op.
    const before = focusTargets(harness.ops()).length
    harness.pane.event({ ev: 'focus', sf: 's1', id: 'dock.composer' })
    await waitForKeyDeliveryWindow()
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

test('a question form focuses its real input node only while the free-text editor is open', async () => {
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

test('disposal settles an unanswered form so no caller hangs', async () => {
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

test('withdrawPresentation drops the form and releases the input (the promise stays with its own lifetime)', async () => {
  const { createTspInteractionSeat } = await import('../../src/tui/tsp/interaction.ts')
  const seat = createTspInteractionSeat({
    render: () => {},
    onFatal: error => { throw new Error(`unexpected fatal: ${String(error)}`) },
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
    // The shared seat interface's three modal inputs: these unit seats are
    // built without a pane, so they exercise the legacy (non-native) branch.
    surfaceId: 's1',
    nativeQuestions: false,
    nativeApproval: false,
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

test('a lifetime retired BEFORE its slot exists never mounts, and its own lifetime still settles it', async () => {
  const { createTspInteractionSeat } = await import('../../src/tui/tsp/interaction.ts')
  const fatals: unknown[] = []
  const seat = createTspInteractionSeat({
    render: () => {},
    onFatal: error => { fatals.push(error) },
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
    // The shared seat interface's three modal inputs: these unit seats are
    // built without a pane, so they exercise the legacy (non-native) branch.
    surfaceId: 's1',
    nativeQuestions: false,
    nativeApproval: false,
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

test('a withdrawal whose frame commit fails reaches the renderer fatal sink and settles nothing itself', async () => {
  const { createTspInteractionSeat } = await import('../../src/tui/tsp/interaction.ts')
  const fatals: unknown[] = []
  let failFrame = false
  const injected = new Error('withdrawal frame failed')
  const seat = createTspInteractionSeat({
    render: () => { if (failFrame) throw injected },
    onFatal: error => { fatals.push(error) },
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
    // The shared seat interface's three modal inputs: these unit seats are
    // built without a pane, so they exercise the legacy (non-native) branch.
    surfaceId: 's1',
    nativeQuestions: false,
    nativeApproval: false,
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

test('a frame failure while PRESENTING a form is fatal, settles once and leaves no ghost seat', async () => {
  const { createTspInteractionSeat } = await import('../../src/tui/tsp/interaction.ts')
  const fatals: unknown[] = []
  let fail = true
  const seat = createTspInteractionSeat({
    render: () => { if (fail) throw new Error('frame failed') },
    onFatal: error => { fatals.push(error) },
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
    // The shared seat interface's three modal inputs: these unit seats are
    // built without a pane, so they exercise the legacy (non-native) branch.
    surfaceId: 's1',
    nativeQuestions: false,
    nativeApproval: false,
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

test('a real single-select choice invalidates the replaced Other text (it cannot resurrect)', async () => {
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

test('re-confirming the same answer fires no real-answer mutation hook', async () => {
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
    await waitForKeyDeliveryWindow()
    assert.equal(recorder.mutations, 1, 'a no-op re-confirmation is not a real-answer mutation')
    harness.pane.key('\r')       // submit from review
    assert.deepEqual(await answers, [{ id: 'f3', selected: ['A'] }])
  } finally {
    await harness.dispose()
  }
})

test('a retired request detaches its real listener and cannot write into the seat that follows it', async () => {
  const { createTspInteractionSeat } = await import('../../src/tui/tsp/interaction.ts')
  let renders = 0
  const seat = createTspInteractionSeat({
    render: () => { renders += 1 },
    onFatal: () => {},
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
    // The shared seat interface's three modal inputs: these unit seats are
    // built without a pane, so they exercise the legacy (non-native) branch.
    surfaceId: 's1',
    nativeQuestions: false,
    nativeApproval: false,
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
    // reason: bounded negative-observation window — the retired request has no
    // positive sink by contract (its whole obligation is "repaint nothing"), and
    // the successor form the abort raced is already presented, so this window
    // covers the only continuation the abort can still schedule.
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

test('closeTransientList releases the seat and the input (a replacement never inherits the list)', async () => {
  const { createTspInteractionSeat } = await import('../../src/tui/tsp/interaction.ts')
  const renders: number[] = []
  const seat = createTspInteractionSeat({
    render: () => { renders.push(1) },
    onFatal: error => { throw new Error(`unexpected fatal: ${String(error)}`) },
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
    // The shared seat interface's three modal inputs: these unit seats are
    // built without a pane, so they exercise the legacy (non-native) branch.
    surfaceId: 's1',
    nativeQuestions: false,
    nativeApproval: false,
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

test('a batched withdrawal commits ONE frame and never promotes a member of the batch', async () => {
  const { createTspInteractionSeat } = await import('../../src/tui/tsp/interaction.ts')
  const frames: string[] = []
  const seat = createTspInteractionSeat({
    render: () => { frames.push(JSON.stringify(seat.renderLayer())) },
    onFatal: error => { throw new Error(`unexpected fatal: ${String(error)}`) },
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
    // The shared seat interface's three modal inputs: these unit seats are
    // built without a pane, so they exercise the legacy (non-native) branch.
    surfaceId: 's1',
    nativeQuestions: false,
    nativeApproval: false,
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

test('the composer accepts input again only after the NEW projection scope commits', async () => {
  // The session-switch HYDRATION FENCE: between `beginSessionHydration()` and
  // the new subject's first committed frame the composer accepts NO key — the
  // key is DROPPED, not held, so no later wait can recover it.
  //
  // The fence lifts exactly when the new projection scope commits (the
  // renderer clears `hydrating` in the same commit that advances the scope
  // epoch). A test that waits for the SESSION SWITCH to be "visually over"
  // — for example for the Session Browser to disappear — can still be inside
  // that window, and the command it types is then lost for good.
  //
  // This case proves both halves of that boundary: the input is dropped while
  // the fence is up, and it is accepted as soon as the new scope commits.
  const harness = await mountHarness()
  try {
    // A scope is showing, so the fence has something to retire.
    harness.renderer.display.setTranscript(
      [{ kind: 'assistant', turn: 1, text: 'the outgoing subject' }],
      undefined,
      undefined,
      undefined,
      undefined,
      { identity: 'outgoing' },
    )
    await waitFor(() => harness.renderer.composer.getDraft() === '', 'the composer starts empty')

    // The switch begins: the fence goes up and the input is dropped.
    harness.renderer.display.beginSessionHydration()
    harness.pane.key('a')
    await waitForKeyDeliveryWindow()
    assert.equal(harness.renderer.composer.getDraft(), '',
      'the hydration fence dropped the composer key (it is not held for replay)')

    // The NEW subject commits: a new projection source re-scopes the
    // presentation, and the fence lifts with it.
    harness.renderer.display.setTranscript(
      [{ kind: 'assistant', turn: 1, text: 'the incoming subject' }],
      undefined,
      undefined,
      undefined,
      undefined,
      { identity: 'incoming' },
    )
    await waitFor(() => harness.renderer.composer.getDraft() === '', 'the new scope committed')

    // The composer accepts the key again — the wait above is what makes the
    // next command deliverable.
    harness.pane.key('b')
    await waitFor(() => harness.renderer.composer.getDraft() === 'b',
      'the composer accepts input once the new scope has committed')
  } finally {
    await harness.dispose()
  }
})

// ── The native composite branch (the negotiated Questions/Approval forms) ────
//
// These cases opt the scripted pane into the EXACT kind set the native
// composites paint, so the seat takes its native branch; every case above keeps
// the default advertised set and therefore qualifies the LEGACY branch. The
// wire is still the only observation point, and each pointer event travels
// through the shipped SDK's decoder as a real `SessionInput{event}`.
//
// A `void answers.catch(() => {})` beside a flow a case may leave open is not
// a swallowed error: the case still awaits the outcome it names. It keeps a
// failing ASSERTION from being reported as the seat's expected disposal
// cancellation, which would hide the real cause (AGENTS.md: never hide a
// contradiction).

/** The base surface id the renderer opens first on this fixture. */
const BASE_SF = 's1'

/** The native Questions form on the live wire, or `undefined` while no frame
 *  carrying it has been drawn yet (a `waitFor` predicate must answer "not
 *  yet", it may not throw). */
function findNativeForm(pane: TspPane): WireNode | undefined {
  return wireNodes(pane).find(entry => entry.k === 'questions')
}

/** The asserting read, for after the frame has been awaited. */
function nativeForm(pane: TspPane): WireNode {
  const node = findNativeForm(pane)
  assert.ok(node !== undefined, `the native questions form is on the wire: ${wireNodes(pane).map(entry => entry.k).join(',')}`)
  return node
}

/** Await the native form of the CURRENT frame, then read it. */
async function nativeFormReady(pane: TspPane, label = 'the native questions form reached the wire'): Promise<WireNode> {
  await waitFor(() => findNativeForm(pane) !== undefined, label)
  return nativeForm(pane)
}

/** A button of the current Review/safe row, awaited by its key suffix. */
async function waitForButton(pane: TspPane, suffix: string): Promise<WireNode> {
  await waitFor(() => wireNodes(pane).some(node => node.k === 'button' && node.id.endsWith(suffix)), `the ${suffix} button reached the wire`)
  const node = wireNodes(pane).find(entry => entry.k === 'button' && entry.id.endsWith(suffix))
  assert.ok(node !== undefined)
  return node
}

/** The native Tool node of the current approval, if any is mounted. */
function toolNode(pane: TspPane): WireNode | undefined {
  return wireNodes(pane).find(entry => entry.k === 'tool')
}

/** The DIRECT children of one overlay, in the order the wire carries them. */
function overlayChildren(pane: TspPane, id: string): string[] {
  return wireNodes(pane)
    .filter(node => node.id.startsWith(`${id}.`) && !node.id.slice(id.length + 1).includes('.'))
    .map(node => String(node.id.split('.').at(-1)))
}

/** Mount the renderer on a pane that negotiated the native modal vocabulary. */
async function mountNativeHarness(): Promise<Harness> {
  return mountHarness({ nativeInteraction: true })
}

test('the native branch is taken only by a pane that negotiated it; a smaller pane keeps the text form', async () => {
  const native = await mountNativeHarness()
  try {
    const answers = native.renderer.interaction.askQuestions(
      [question({ id: 'cap-a', question: 'Which target?', options: [{ label: 'alpha' }] })], undefined, undefined, false)
    await nativeFormReady(native.pane)
    native.pane.key('\x1b')
    await assert.rejects(answers, /question flow cancelled/)
  } finally {
    await native.dispose()
  }

  // The SAME request on a pane that advertises the base vocabulary only.
  const legacy = await mountHarness()
  try {
    const answers = legacy.renderer.interaction.askQuestions(
      [question({ id: 'cap-b', question: 'Which target?', options: [{ label: 'alpha' }] })], undefined, undefined, false)
    await waitFor(() => overlayAdds(legacy.ops()).length === 1, 'the legacy form opened')
    assert.equal(wireNodes(legacy.pane).some(node => node.k === 'questions'), false,
      'a pane without the kind never gets a native form')
    assert.ok(modalNode(legacy.pane, '.row-0') !== undefined, 'the legacy text option row is painted instead')
    legacy.pane.key('\x1b')
    await assert.rejects(answers, /question flow cancelled/)
  } finally {
    await legacy.dispose()
  }
})

test('native projection: stable index tokens, the real labels, required:false, and status/heading OUTSIDE the form', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const questions = [
      question({
        id: 'q-0',
        header: 'Deployment',
        question: 'Which target?',
        detail: 'Choose one.',
        options: [{ label: 'alpha', description: 'the steady one' }, { label: 'beta (recommended)' }],
      }),
      question({ id: 'q-1', question: 'And again?', options: [{ label: 'alpha' }, { label: 'beta' }] }),
    ]
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, recorder.status, false)
    void answers.catch(() => {})
    await nativeFormReady(harness.pane)
    const form = nativeForm(harness.pane)
    const items = form.p.items as Array<Record<string, unknown>>
    assert.deepEqual(items.map(item => item.id), ['q-0', 'q-1'], 'items are indexed by POSITION, in source order')
    assert.equal(form.p.step, 0, 'the native step is the seat tab')
    assert.equal(form.p.variant, 'steps')
    assert.equal(form.p.submit, 'Review answers', 'the native submit label names the Review, never a Host write')
    for (const item of items) {
      assert.equal(item.required, false, 'Skip stays allowed: no invented required rule')
      assert.equal(item.multi, undefined, 'a single-select question is not projected as multi')
      assert.equal(item.other === undefined, false, 'a choice page keeps the Other answer field')
    }
    assert.deepEqual(items.map(item => item.prompt), ['Which target?', 'And again?'],
      'the real question text is projected, not an index')
    const choices = items[0]!.choices as Array<Record<string, unknown>>
    assert.deepEqual(choices.map(choice => choice.value), ['o-0', 'o-1'], 'choice values are stable index tokens')
    assert.equal(choices[0]!.label, 'alpha')
    assert.equal(choices[0]!.detail, 'the steady one')
    assert.equal(choices[1]!.label, 'beta', 'the (recommended) suffix is stripped from the DISPLAY label')
    assert.match(String(choices[1]!.detail), /Recommended/)
    // The controller status and the question heading are real facts of THIS
    // request, so they ride a line of the same overlay, never a fake SDK field.
    const order = overlayChildren(harness.pane, overlayAdds(harness.ops()).at(-1)!)
    assert.ok(order.includes('status'), 'the status line is outside the native form')
    assert.ok(order.includes('header'), 'the heading is outside the native form')
    assert.ok(order.indexOf('status') < order.indexOf(String(form.id.split('.').at(-1))), 'and above the form')
    assert.deepEqual(form.p.answers ?? {}, {}, 'nothing is selected yet, so no answer is projected')
    harness.pane.key('\x1b')
    await assert.rejects(answers, /question flow cancelled/)
  } finally {
    await harness.dispose()
  }
})

test('a native pointer change selects the REAL label, fires only a semantic mutation, and keeps source order', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const questions = [question({
      id: 'q1',
      question: 'Pick any',
      multiSelect: true,
      // The client reports the picks in CLICK order; the answer must not.
      options: [{ label: 'one' }, { label: 'two' }, { label: 'three' }],
    })]
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, recorder.status, false)
    void answers.catch(() => {})
    await nativeFormReady(harness.pane)
    const form = nativeForm(harness.pane)
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: form.id, item: 'q-0', value: ['o-2'] })
    await waitFor(() => recorder.mutations === 1, 'the first real pick fired the hook')
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: form.id, item: 'q-0', value: ['o-2', 'o-0'] })
    await waitFor(() => recorder.mutations === 2, 'the second real pick fired the hook')
    // Re-sending the same SET is not a semantic change.
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: form.id, item: 'q-0', value: ['o-2', 'o-0'] })
    await waitForKeyDeliveryWindow()
    assert.equal(recorder.mutations, 2, 'a repeated identical selection set fires no hook')
    assert.deepEqual((nativeForm(harness.pane).p.answers as Record<string, unknown>)['q-0'], ['o-0', 'o-2'],
      'the projected answer set follows SOURCE order, not the client order')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'submit' })
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'q1', selected: ['one', 'three'] }],
      'the batch carries the real labels in source option order')
  } finally {
    await harness.dispose()
  }
})

test('the native last-step submit NEVER writes the Host; only the Review commit settles', async () => {
  const harness = await mountNativeHarness()
  try {
    const answers = harness.renderer.interaction.askQuestions(
      [question({ id: 'q2', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] })], undefined, undefined, false)
    void answers.catch(() => {})
    await nativeFormReady(harness.pane)
    const form = nativeForm(harness.pane)
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: form.id, item: 'q-0', value: 'o-1' })
    await waitFor(() => (nativeForm(harness.pane).p.answers as Record<string, unknown>)['q-0'] === 'o-1', 'the pick is projected')
    // The client's own submit payload carries every answer: the seat must
    // ignore its content and open Review only.
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: form.id, act: 'submit', value: { 'q-0': 'injected' } })
    await waitForButton(harness.pane, '.submit')
    let settled = false
    void answers.then(() => { settled = true })
    await waitForKeyDeliveryWindow()
    assert.equal(settled, false, 'the native submit did not settle the question')
    assert.equal(wireText(harness.pane).includes('injected'), false, 'the client submit payload is never projected')
    const submit = modalNode(harness.pane, '.submit')
    assert.ok(submit !== undefined, 'the Review page paints a real Submit button')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: submit.id, act: 'review-submit' })
    assert.deepEqual(await answers, [{ id: 'q2', selected: ['b'] }], 'the Review commit is the one business write')
  } finally {
    await harness.dispose()
  }
})

test('native admission refuses a stale visit, another page, a foreign surface and a malformed payload', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const questions = [
      question({ id: 'q3', question: 'first', options: [{ label: 'a' }, { label: 'b' }] }),
      question({ id: 'q4', question: 'second', options: [{ label: 'c' }, { label: 'd' }] }),
    ]
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, recorder.status, false)
    void answers.catch(() => {})
    await nativeFormReady(harness.pane)
    const firstVisit = nativeForm(harness.pane)
    // An out-of-range token, a non-canonical spelling, a wrong JSON type,
    // another page's item, a foreign surface and another request's node id are
    // all refusals — never a coerced answer.
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: firstVisit.id, item: 'q-0', value: 'o-9' })
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: firstVisit.id, item: 'q-0', value: 'o-01' })
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: firstVisit.id, item: 'q-0', value: 7 })
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: firstVisit.id, item: 'q-1', value: 'o-0' })
    harness.pane.event({ ev: 'change', sf: 'other-surface', id: firstVisit.id, item: 'q-0', value: 'o-0' })
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: 'layer.modal-99.qform-99', item: 'q-0', value: 'o-0' })
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: 'layer.modal-99.qform-99', act: 'submit' })
    await waitForKeyDeliveryWindow()
    assert.equal(recorder.mutations, 0, 'no refused event touched the draft')
    assert.equal(recorder.drafts.length, 0, 'and no refused event reported a draft either')

    // A REAL pick, then the page change makes that very node id stale.
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: firstVisit.id, item: 'q-0', value: 'o-0' })
    await waitFor(() => recorder.mutations === 1, 'the real pick registered')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'next', item: 'q-0' })
    await waitFor(() => findNativeForm(harness.pane) !== undefined && nativeForm(harness.pane).id !== firstVisit.id, 'the second page is a NEW node id')
    const secondForm = nativeForm(harness.pane)
    assert.equal(secondForm.p.step, 1, 'the native step followed the seat tab')
    // The superseded visit can no longer select, page or settle anything.
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: firstVisit.id, item: 'q-0', value: 'o-1' })
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: firstVisit.id, act: 'submit' })
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: firstVisit.id, act: 'back' })
    await waitForKeyDeliveryWindow()
    assert.equal(nativeForm(harness.pane).id, secondForm.id, 'a stale visit moved nothing')
    assert.equal(recorder.mutations, 1, 'a stale visit changed no answer')
    // A page action on the CURRENT form that names a different item.
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: secondForm.id, act: 'next', item: 'q-0' })
    await waitForKeyDeliveryWindow()
    assert.equal(nativeForm(harness.pane).p.step, 1, 'an item that is not the current page is refused')

    harness.pane.event({ ev: 'change', sf: BASE_SF, id: secondForm.id, item: 'q-1', value: 'o-1' })
    await waitFor(() => recorder.mutations === 2, 'the second page pick registered')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'submit' })
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'q3', selected: ['a'] }, { id: 'q4', selected: ['d'] }],
      'only the admitted events shaped the batch')
  } finally {
    await harness.dispose()
  }
})

test('a page action without its exact current item is refused, and submit carries none', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const questions = [
      question({ id: 'p1', question: 'first', options: [{ label: 'a' }, { label: 'b' }] }),
      question({ id: 'p2', question: 'second', options: [{ label: 'c' }] }),
    ]
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, recorder.status, false)
    void answers.catch(() => {})
    await nativeFormReady(harness.pane)
    const form = nativeForm(harness.pane)
    // No item at all, and another page's item: both are malformed for a page action.
    for (const act of ['next', 'skip', 'back']) {
      harness.pane.event({ ev: 'action', sf: BASE_SF, id: form.id, act })
      harness.pane.event({ ev: 'action', sf: BASE_SF, id: form.id, act, item: 'q-9' })
    }
    await waitForKeyDeliveryWindow()
    assert.equal(nativeForm(harness.pane).p.step, 0, 'a page action without its exact item moved nothing')
    assert.equal(recorder.drafts.length, 0, 'and it changed no draft')
    // The real shape (item = the current question) still advances.
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: form.id, act: 'next', item: 'q-0' })
    await waitFor(() => (nativeForm(harness.pane).p.step as number) === 1, 'the exact page action advanced')
    const second = nativeForm(harness.pane)
    // Submit is the mirror rule: it carries NO item, and one that does is refused.
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: second.id, act: 'submit', item: 'q-1' })
    await waitForKeyDeliveryWindow()
    assert.equal((nativeForm(harness.pane).p.step as number), 1, 'a submit carrying an item is refused')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: second.id, act: 'submit' })
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'p1', selected: [] }, { id: 'p2', selected: [] }])
  } finally {
    await harness.dispose()
  }
})

test('native Back keeps every draft; native Skip drops only the page it names', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const questions = [
      question({ id: 'q5', question: 'first', options: [{ label: 'a' }] }),
      question({ id: 'q6', question: 'second', options: [{ label: 'c' }, { label: 'd' }] }),
    ]
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, recorder.status, false)
    void answers.catch(() => {})
    await nativeFormReady(harness.pane)
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: nativeForm(harness.pane).id, item: 'q-0', value: 'o-0' })
    await waitFor(() => recorder.mutations === 1, 'the first pick registered')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'next', item: 'q-0' })
    await waitFor(() => (nativeForm(harness.pane).p.step as number) === 1, 'the second page is current')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'back', item: 'q-1' })
    await waitFor(() => (nativeForm(harness.pane).p.step as number) === 0, 'Back returned to the first page')
    assert.deepEqual((nativeForm(harness.pane).p.answers as Record<string, unknown>)['q-0'], 'o-0',
      'Back kept the earlier draft')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'next', item: 'q-0' })
    await waitFor(() => (nativeForm(harness.pane).p.step as number) === 1, 'forward again')
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: nativeForm(harness.pane).id, item: 'q-1', value: 'o-1' })
    await waitFor(() => (nativeForm(harness.pane).p.answers as Record<string, unknown>)['q-1'] === 'o-1', 'the second pick registered')
    // An explicit Skip of THIS page: the answer it just got must not ride along.
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'skip', item: 'q-1' })
    await waitForButton(harness.pane, '.submit')
    await waitFor(() => findNativeForm(harness.pane) === undefined, 'Review owns the seat now')
    assert.deepEqual(recorder.drafts.at(-1)?.answers[1], { selected: [], custom: '', skipped: true },
      'the skipped page carries no stale answer')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'q5', selected: ['a'] }, { id: 'q6', selected: [] }])
  } finally {
    await harness.dispose()
  }
})


test('the Review buttons admit only their own exact current node; Back keeps drafts, Cancel cancels', async () => {
  const harness = await mountNativeHarness()
  try {
    const answers = harness.renderer.interaction.askQuestions(
      [question({ id: 'q7', question: 'Which?', options: [{ label: 'a' }] })], undefined, undefined, false)
    void answers.catch(() => {})
    await nativeFormReady(harness.pane)
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: nativeForm(harness.pane).id, item: 'q-0', value: 'o-0' })
    await waitFor(() => (nativeForm(harness.pane).p.answers as Record<string, unknown>)['q-0'] === 'o-0', 'the pick registered')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'submit' })
    const submit = await waitForButton(harness.pane, '.submit')
    assert.equal(String(modalNode(harness.pane, '.summary')?.p.text ?? ''),
      '1 question · 1 answered · 0 skipped', 'the summary line accounts for every question')
    // The right node with a wrong action name, and the right name on a node of
    // another visit, are both refusals.
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: submit.id, act: 'allow' })
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: 'layer.modal-1.review-9.submit', act: 'review-submit' })
    let settled = false
    void answers.then(() => { settled = true })
    await waitForKeyDeliveryWindow()
    assert.equal(settled, false, 'a mismatched node/action pair never commits')
    // Back leaves Review, and re-entering it mints a NEW row: the old Submit id
    // is then a node of a superseded visit.
    const back = wireNodes(harness.pane).find(node => node.k === 'button' && node.id.endsWith('.back'))
    assert.ok(back !== undefined, 'Review paints a real Back button')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: back.id, act: 'review-back' })
    await nativeFormReady(harness.pane, 'Back returned to the question')
    assert.deepEqual((nativeForm(harness.pane).p.answers as Record<string, unknown>)['q-0'], 'o-0',
      'Back kept the draft (it is a presentation move, not a reset)')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'submit' })
    await waitFor(() => wireNodes(harness.pane).some(node => node.k === 'button' && node.id.endsWith('.submit') && node.id !== submit.id),
      'the revisited Review is a NEW node id')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: submit.id, act: 'review-submit' })
    await waitForKeyDeliveryWindow()
    assert.equal(settled, false, 'the superseded Review button is inert')
    const fresh = wireNodes(harness.pane).find(node => node.k === 'button' && node.id.endsWith('.submit'))!
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: fresh.id, act: 'review-submit' })
    assert.deepEqual(await answers, [{ id: 'q7', selected: ['a'] }])
  } finally {
    await harness.dispose()
  }
})

test('a Review Cancel action runs the original cancellation and releases the caret', async () => {
  const harness = await mountNativeHarness()
  try {
    const answers = harness.renderer.interaction.askQuestions(
      [question({ id: 'q8', question: 'Which?', options: [{ label: 'a' }] })], undefined, undefined, false)
    void answers.catch(() => {})
    await nativeFormReady(harness.pane)
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'submit' })
    const cancel = await waitForButton(harness.pane, '.cancel')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: cancel.id, act: 'review-cancel' })
    await assert.rejects(answers, /question flow cancelled/)
    await waitFor(() => lastOp(harness.ops(), 'focus')?.[1] === 'dock.composer', 'the composer regained the caret')
  } finally {
    await harness.dispose()
  }
})

test('the safe form paints REAL buttons for an optionless or masked page and never leaks the secret', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const secret = 'sentinel-secret-42'
    const answers = harness.renderer.interaction.askQuestions(
      [question({ id: 'q9', question: 'Token?', masked: true })], undefined, recorder.status, false)
    void answers.catch(() => {})
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the safe form opened')
    const kinds = wireNodes(harness.pane).map(node => node.k)
    assert.equal(kinds.includes('questions'), false, 'a masked page is never projected as an empty native Steps form')
    assert.ok(kinds.includes('button'), 'the safe form paints real buttons, not a text line pretending to be one')
    harness.pane.key(secret)
    await waitFor(() => recorder.drafts.at(-1)?.answers[0]?.custom === secret, 'the draft keeps the real value')
    assert.ok(wireText(harness.pane).includes('•'), 'the pane shows bullets')
    assert.equal(wireText(harness.pane).includes(secret), false, 'the masked plaintext never reaches the wire')
    const next = wireNodes(harness.pane).find(node => node.k === 'button' && node.id.endsWith('.next'))
    assert.ok(next !== undefined, 'the safe form paints a Next button')
    // A pointer click on Next is exactly the keyboard commit for this page.
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: next.id, act: 'form-next' })
    await waitForButton(harness.pane, '.submit')
    const review = wireText(harness.pane)
    assert.equal(review.includes(secret), false, 'Review keeps the sensitive answer bulleted')
    assert.ok(review.includes('•'.repeat([...secret].length)), 'one bullet per grapheme')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'q9', selected: [], custom: secret }],
      'the authoritative answer carries the real value')
  } finally {
    await harness.dispose()
  }
})

test('the Other input keeps ONE owner: a pointer focus opens the same editor at the real derived id', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const answers = harness.renderer.interaction.askQuestions(
      [question({ id: 'q10', question: 'Which?', options: [{ label: 'a' }] })], undefined, recorder.status, false)
    void answers.catch(() => {})
    await nativeFormReady(harness.pane)
    const form = nativeForm(harness.pane)
    const other = wireNodes(harness.pane).find(node => node.k === 'input' && node.id === `${form.id}.q-0.other`)
    assert.ok(other !== undefined, 'the SDK-derived Other child carries the real id')
    assert.equal(lastOp(harness.ops(), 'focus')?.[1], null, 'the choice page owns no caret')
    // The stale guess the seat used to publish must NOT be what gets focused.
    harness.pane.event({ ev: 'focus', sf: BASE_SF, id: 'layer.modal-1.answer' })
    await waitForKeyDeliveryWindow()
    assert.notEqual(lastOp(harness.ops(), 'focus')?.[1], 'layer.modal-1.answer', 'a foreign answer-field claim is refused')
    harness.pane.event({ ev: 'focus', sf: BASE_SF, id: other.id })
    await waitFor(() => lastOp(harness.ops(), 'focus')?.[1] === other.id, 'the caret went to the real Other id')
    harness.pane.key('typed')
    await waitFor(() => recorder.drafts.at(-1)?.answers[0]?.custom === 'typed', 'the keyboard stayed the input owner')
    assert.deepEqual(nativeForm(harness.pane).p.answers ?? {}, {}, 'a custom answer never enters the native answers map')
    harness.pane.key('\r')
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'q10', selected: [], custom: 'typed' }])
  } finally {
    await harness.dispose()
  }
})

test('the keyboard cursor line answers an Arrow press and hides when a real choice arrives', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const answers = harness.renderer.interaction.askQuestions(
      [question({ id: 'q11', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] })], undefined, recorder.status, false)
    void answers.catch(() => {})
    await nativeFormReady(harness.pane)
    const cursor = () => wireNodes(harness.pane).some(node => node.id.endsWith('.keyboard-cursor'))
    assert.equal(cursor(), false, 'the default mouse journey shows no keyboard line')
    harness.pane.key('\x1b[B')   // Arrow down asks for the keyboard cursor
    await waitFor(() => cursor(), 'the keyboard cursor line appeared')
    assert.match(String(modalNode(harness.pane, '.keyboard-cursor')?.p.text ?? ''), /Keyboard cursor: \[2\] b/)
    assert.equal(recorder.mutations, 0, 'a highlight is not an answer')
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: nativeForm(harness.pane).id, item: 'q-0', value: 'o-1' })
    await waitFor(() => recorder.mutations === 1, 'the real pick registered')
    await waitFor(() => !cursor(), 'a native choice hides the keyboard line')
    // A digit picks in place and never leaves the page.
    harness.pane.key('1')
    await waitFor(() => recorder.mutations === 2, 'the digit pick registered')
    assert.equal(nativeForm(harness.pane).p.step, 0, 'a digit stays on the page (Next pages)')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'submit' })
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'q11', selected: ['a'] }], 'the last real choice is the answer')
  } finally {
    await harness.dispose()
  }
})

test('the native approval paints the full tool facts BEFORE the ask control and gives the tool no body', async () => {
  const harness = await mountNativeHarness()
  try {
    const outcome = harness.renderer.interaction.showApprovalPrompt(
      { toolName: 'bash', reason: 'needs a shell', arguments: '{"cmd":"ls -la"}', danger: true }, true)
    await waitFor(() => toolNode(harness.pane) !== undefined, 'the native approval reached the wire')
    const overlayId = overlayAdds(harness.ops()).at(-1)!
    const order = overlayChildren(harness.pane, overlayId)
    const toolAt = order.findIndex(entry => entry === 'approval-tool')
    const argsAt = order.findIndex(entry => entry === 'args')
    assert.ok(toolAt >= 0, 'the native tool node is on the wire')
    assert.ok(argsAt >= 0 && argsAt < toolAt, `the arguments are painted BEFORE the decision: ${order.join(',')}`)
    assert.ok(order.indexOf('tool-name') < toolAt && order.indexOf('reason') < toolAt && order.indexOf('danger') < toolAt,
      `every tool fact precedes the approval control: ${order.join(',')}`)
    const tool = toolNode(harness.pane)!
    assert.equal(tool.p.status, 'ask')
    assert.equal(tool.p.confirm, 'card')
    assert.equal(tool.p.frame, 'inline', 'one frame, not a ring inside a ring')
    assert.equal(tool.p.role, 'dsh-native-approval', 'the scoped role the one stylesheet keys on')
    assert.equal((tool.p.ask as Record<string, unknown>).always, false, 'the Always grant this product cannot honour is hidden')
    assert.equal((tool.p.ask as Record<string, unknown>).allow, 'Allow once')
    assert.equal(tool.c, undefined, 'the approval control carries NO body: the client draws its panel above it')
    const args = wireNodes(harness.pane).find(node => node.id.endsWith('.args'))
    assert.ok(args !== undefined && args.k === 'scroll', 'the arguments ride a bounded scroll region')
    assert.deepEqual(args.p.max, { h: 0.5 }, 'a FRACTION of the overlay body, never a pixel or line budget')
    assert.ok(wireNodes(harness.pane).some(node => node.id === `${args.id}.body` && node.k === 'code'),
      'the full argument text is still there, readable inside that region')
    assert.equal(wireNodes(harness.pane).filter(node => node.k === 'tool').length, 1, 'exactly ONE ask control')
    assert.ok(wireText(harness.pane).includes('Dangerous command'), 'the danger marker is readable')
    assert.ok(wireText(harness.pane).includes('Y allow once'), 'the real shortcuts are stated')
    harness.pane.key('y')
    assert.equal(await outcome, 'allowed-once')
  } finally {
    await harness.dispose()
  }
})

test('the approval Allow/Deny buttons settle the ORIGINAL promise once, and nothing else decides', async () => {
  const harness = await mountNativeHarness()
  try {
    const outcome = harness.renderer.interaction.showApprovalPrompt(APPROVAL, true)
    await waitFor(() => toolNode(harness.pane) !== undefined, 'the approval opened')
    const tool = toolNode(harness.pane)!
    const settles: ApprovalOutcome[] = []
    void outcome.then(value => { settles.push(value) })
    // `always`, a scope value on either button, another node, another surface,
    // and a non-action event on the tool are ALL refusals.
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: tool.id, act: 'always' })
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: tool.id, act: 'allow', value: 'session' })
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: tool.id, act: 'allow', value: 'always' })
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: tool.id, act: 'deny', value: 'once' })
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: 'layer.modal-9.approval-tool', act: 'allow' })
    harness.pane.event({ ev: 'action', sf: 'other-surface', id: tool.id, act: 'allow' })
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: tool.id, value: 'allow' })
    harness.pane.event({ ev: 'select', sf: BASE_SF, id: tool.id, item: 'allow' })
    await waitForKeyDeliveryWindow()
    assert.deepEqual(settles, [], 'no refused approval action settled anything')
    assert.deepEqual(harness.submits, [], 'none of them reached the composer either')
    assert.ok(toolNode(harness.pane) !== undefined, 'the approval is still open')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: tool.id, act: 'allow' })
    assert.equal(await outcome, 'allowed-once')
    await waitForKeyDeliveryWindow()
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: tool.id, act: 'deny' })
    await waitForKeyDeliveryWindow()
    assert.deepEqual(settles, ['allowed-once'], 'a repeated click on the retired tool cannot settle twice')
  } finally {
    await harness.dispose()
  }
})

test('a native approval for a DENY decision settles rejected, and Cancel keys still cancel', async () => {
  const harness = await mountNativeHarness()
  try {
    const denied = harness.renderer.interaction.showApprovalPrompt(APPROVAL, true)
    await waitFor(() => toolNode(harness.pane) !== undefined, 'the approval opened')
    const tool = toolNode(harness.pane)!
    const back = wireNodes(harness.pane).find(node => node.k === 'text' && node.id.endsWith('.hint'))
    assert.ok(back !== undefined, 'the real shortcut line is present')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: tool.id, act: 'deny' })
    assert.equal(await denied, 'rejected')
    const cancelled = harness.renderer.interaction.showApprovalPrompt(APPROVAL, true)
    await waitFor(() => toolNode(harness.pane) !== undefined, 'the next approval opened')
    harness.pane.key('\x1b')
    assert.equal(await cancelled, 'cancelled')
  } finally {
    await harness.dispose()
  }
})


test('the Enter-keycap rule is installed ONCE per surface, and only by a pane that can honour it', async () => {
  const SHEET = 'dsh-native-approval-shortcuts'
  const installs = (pane: TspPane) => (wireText(pane).match(new RegExp(SHEET, 'g')) ?? []).length
  const native = await mountNativeHarness()
  try {
    const outcome = native.renderer.interaction.showApprovalPrompt(APPROVAL, true)
    await waitFor(() => toolNode(native.pane) !== undefined, 'the approval opened')
    assert.equal(installs(native.pane), 1, 'the scoped sheet is installed exactly once, never per render')
    const sheet = wireText(native.pane)
    assert.ok(sheet.includes('[data-role=\\"dsh-native-approval\\"] .sf-tool-ask-btn .sf-kbd { display: none; }'),
      `and its body is exactly the one Enter-keycap rule: ${sheet.slice(sheet.indexOf(SHEET), sheet.indexOf(SHEET) + 240)}`)
    native.pane.key('n')
    await outcome
    // Several more approvals and questions: STILL one install, and the rule is
    // never re-sent from a render path.
    for (let index = 0; index < 3; index += 1) {
      const next = native.renderer.interaction.showApprovalPrompt(APPROVAL, true)
      await waitFor(() => toolNode(native.pane) !== undefined, 'the approval opened')
      native.pane.key('n')
      await next
    }
    const questions = native.renderer.interaction.askQuestions(
      [question({ id: 'sheet-q', question: 'Which?', options: [{ label: 'a' }] })], undefined, undefined, false)
    await nativeFormReady(native.pane, 'the queued form opened')
    native.pane.key('\x1b')
    await assert.rejects(questions, /question flow cancelled/)
    assert.equal(installs(native.pane), 1, 'still exactly one sheet install after every repaint')
  } finally {
    await native.dispose()
  }

  // A pane WITHOUT `styles` cannot hide the misleading keycap, so it must get
  // neither the native approval nor the sheet — and it stays answerable.
  const noStyles = await mountHarness({
    kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'questions', 'overlay', 'row', 'text', 'input', 'button', 'scroll'],
    features: ['flow'],
  })
  try {
    const outcome = noStyles.renderer.interaction.showApprovalPrompt(APPROVAL, true)
    await waitFor(() => overlayAdds(noStyles.ops()).length === 1, 'the approval opened')
    assert.equal(toolNode(noStyles.pane), undefined, 'no native ask control without `styles`')
    assert.equal(wireText(noStyles.pane).includes(SHEET), false, 'and no sheet without `styles`')
    assert.ok(wireText(noStyles.pane).includes('y allow once'), 'the legacy text approval is still answerable')
    noStyles.pane.key('y')
    assert.equal(await outcome, 'allowed-once')
  } finally {
    await noStyles.dispose()
  }

  // A pane that advertises every native Questions kind EXCEPT `row`: the safe
  // form and the Review page both build a `row`, so the gate must be fail-closed
  // and the legacy text form must be what this pane really gets.
  const noRow = await mountHarness({
    kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'questions', 'overlay', 'text', 'input', 'button', 'scroll'],
    features: ['flow', 'styles'],
  })
  try {
    const questions = noRow.renderer.interaction.askQuestions(
      [question({ id: 'norow-q', question: 'Which?', options: [{ label: 'a' }] })], undefined, undefined, false)
    void questions.catch(() => {})
    await waitFor(() => overlayAdds(noRow.ops()).length === 1, 'the question form opened')
    assert.equal(findNativeForm(noRow.pane), undefined,
      'a pane without the row kind never gets the native Questions form')
    assert.ok(modalNode(noRow.pane, '.row-0') !== undefined, 'the legacy text rows are painted instead')
    assert.equal(wireNodes(noRow.pane).some(node => node.k === 'row'), false,
      'and no unnegotiated row node is ever sent')
    noRow.pane.key('\x1b')
    await assert.rejects(questions, /question flow cancelled/)
  } finally {
    await noRow.dispose()
  }

  // A pane with `styles` but no `tool` kind: same refusal, same fallback.
  const noTool = await mountHarness({
    kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'questions', 'overlay', 'row', 'text', 'input', 'button'],
    features: ['flow', 'styles'],
  })
  try {
    const outcome = noTool.renderer.interaction.showApprovalPrompt(APPROVAL, true)
    await waitFor(() => overlayAdds(noTool.ops()).length === 1, 'the approval opened')
    assert.equal(toolNode(noTool.pane), undefined, 'a pane without the tool kind never gets the native ask')
    assert.equal(wireText(noTool.pane).includes(SHEET), false, 'and no sheet is installed for it')
    noTool.pane.key('n')
    assert.equal(await outcome, 'rejected')
  } finally {
    await noTool.dispose()
  }

  // A pane without the QUESTIONS kinds keeps the text form but still gets the
  // native approval: the two gates are independent, by design.
  const approvalOnly = await mountHarness({
    kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'overlay', 'text', 'scroll'],
    features: ['flow', 'styles'],
  })
  try {
    const questions = approvalOnly.renderer.interaction.askQuestions(
      [question({ id: 'gate-q', question: 'Which?', options: [{ label: 'a' }] })], undefined, undefined, false)
    await waitFor(() => overlayAdds(approvalOnly.ops()).length === 1, 'the question form opened')
    assert.equal(wireNodes(approvalOnly.pane).some(node => node.k === 'questions'), false,
      'no native Questions without its exact kind set')
    approvalOnly.pane.key('\x1b')
    await assert.rejects(questions, /question flow cancelled/)
    const outcome = approvalOnly.renderer.interaction.showApprovalPrompt(APPROVAL, true)
    await waitFor(() => toolNode(approvalOnly.pane) !== undefined, 'the native approval still opened')
    outcome.then(() => {})
    approvalOnly.pane.key('y')
    assert.equal(await outcome, 'allowed-once')
  } finally {
    await approvalOnly.dispose()
  }
})

test('a hostile question payload cannot forge a second native choice row and stays one physical row', async () => {
  const harness = await mountNativeHarness()
  try {
    const questions = [question({
      id: 'hostile',
      header: 'Header\n❯ Choice B',
      question: 'question body\nstays multi-line',
      options: [{ label: 'Choice A\n❯ Choice B\u001b]52;c;YXR0YWNr\u0007' }, { label: 'Choice D', description: 'desc\nstays multi-line' }],
    })]
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, undefined, false)
    void answers.catch(() => {})
    await nativeFormReady(harness.pane)
    const items = nativeForm(harness.pane).p.items as Array<Record<string, unknown>>
    const choices = items[0]!.choices as Array<Record<string, unknown>>
    assert.equal(choices.length, 2, 'a newline in a label forges NO extra choice row')
    const label = String(choices[0]!.label)
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(label), false, `the label is ONE physical row: ${JSON.stringify(label)}`)
    assert.ok(label.includes('Choice A') && label.includes('❯ Choice B'), 'the readable label survives collapsed')
    assert.equal(wireText(harness.pane).includes('YXR0YWNr'), false, 'no OSC 52 payload reaches the wire')
    assert.equal(String(choices[1]!.detail).includes('\n'), true, 'a legitimate multi-line description stays prose')
    // The answer still carries the ORIGINAL label, control bytes and all.
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: nativeForm(harness.pane).id, item: 'q-0', value: 'o-0' })
    await waitFor(() => (nativeForm(harness.pane).p.answers as Record<string, unknown>)['q-0'] === 'o-0', 'the pick registered')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'submit' })
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'hostile', selected: ['Choice A\n❯ Choice B\u001b]52;c;YXR0YWNr\u0007'] }],
      'the Host receives the request’s own label, not a display projection')
  } finally {
    await harness.dispose()
  }
})

test('a mixed native queue keeps FIFO, and Alt+Q still reads the parked rows over a native pane', async () => {
  const harness = await mountNativeHarness()
  try {
    const approval = harness.renderer.interaction.showApprovalPrompt({ toolName: 'bash', reason: 'first' }, true)
    const questions = harness.renderer.interaction.askQuestions(
      [question({ id: 'mix-q', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] })], undefined, undefined, false)
    await waitFor(() => toolNode(harness.pane) !== undefined, 'the approval owns the seat first')
    assert.equal(wireNodes(harness.pane).some(node => node.k === 'questions'), false, 'the queued question is not painted')
    const tool = toolNode(harness.pane)!
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: tool.id, act: 'allow' })
    assert.equal(await approval, 'allowed-once')
    await nativeFormReady(harness.pane, 'the queued question took the seat')
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: nativeForm(harness.pane).id, item: 'q-0', value: 'o-0' })
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'submit' })
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await questions, [{ id: 'mix-q', selected: ['a'] }])

    // Alt+Q over the same native pane: the continued list is unchanged.
    harness.continued.push({ sessionId: 'session-a', callId: 'call-parked', presentation: 'parked' })
    harness.reopenAnswer = false
    harness.pane.key('\x1bq')
    await waitFor(() => wireText(harness.pane).includes('Continued questions'), 'the list opened')
    assert.ok(wireText(harness.pane).includes('call-parked'), 'the parked row is listed')
    harness.pane.key('\x1b')
    await waitFor(() => wireText(harness.pane).includes('That question is no longer answerable')
      || overlayAdds(harness.ops()).length === 3, 'Esc closed the list')
  } finally {
    await harness.dispose()
  }
})

test('REGRESSION: a masked answer never rides into the NEXT page’s native Other field', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const secret = 'cross-page-secret-77'
    const questions = [
      question({ id: 'x1', question: 'Token?', masked: true }),
      question({ id: 'x2', question: 'Which target?', options: [{ label: 'a' }, { label: 'b' }] }),
    ]
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, recorder.status, false)
    void answers.catch(() => {})
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the masked page opened')
    harness.pane.key(secret)
    await waitFor(() => recorder.drafts.at(-1)?.answers[0]?.custom === secret, 'the masked draft holds the real value')
    assert.equal(wireText(harness.pane).includes(secret), false, 'the masked page itself leaks nothing')
    // Commit the masked answer: the flow moves to the NEXT page, which has
    // options and therefore paints the native steps form with its OWN Other
    // input. The live buffer is re-seeded per page (the regression this case
    // pins), so the previous page's secret can never be painted here.
    harness.pane.key('\r')
    await nativeFormReady(harness.pane, 'the next page is the native steps form')
    await waitForKeyDeliveryWindow()
    assert.equal(wireText(harness.pane).includes(secret), false,
      `the previous masked answer must never reach the next page's wire: ${wireText(harness.pane).slice(0, 200)}`)
    const other = wireNodes(harness.pane).find(node => node.k === 'input' && node.id.endsWith('.other'))
    assert.ok(other !== undefined, 'the native page paints its Other field')
    assert.equal(String(other.p.text ?? ''), '', 'and it starts from THIS page’s own draft')
    harness.pane.key('\x1b')
    await assert.rejects(answers, /question flow cancelled/)
  } finally {
    await harness.dispose()
  }
})

test('REGRESSION: a restored draft containing a masked answer never reaches a later choice page', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const secret = 'restored-secret-91'
    const questions = [
      question({ id: 'r1', question: 'Token?', masked: true }),
      question({ id: 'r2', question: 'Which target?', options: [{ label: 'a' }, { label: 'b' }] }),
    ]
    const status: TuiQuestionStatus = {
      ...recorder.status,
      initialDraft: {
        tab: 0,
        answers: [
          { selected: [], custom: secret, skipped: false },
          { selected: [], custom: '', skipped: false },
        ],
      },
    }
    const answers = harness.renderer.interaction.askQuestions(questions, undefined, status, false)
    void answers.catch(() => {})
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the restored masked page opened')
    assert.equal(wireText(harness.pane).includes(secret), false, 'the restored masked page leaks nothing')
    assert.ok(wireText(harness.pane).includes('•••••••••••••••'), 'and it shows one bullet per grapheme')
    // Commit the restored answer: the flow moves to the NEXT page (the native
    // steps form). Enter is the masked page's commit, exactly as the keyboard
    // contract says.
    harness.pane.key('\r')
    await nativeFormReady(harness.pane, 'the choice page opened')
    await waitForKeyDeliveryWindow()
    assert.equal(wireText(harness.pane).includes(secret), false,
      'a restored masked draft must not ride into the next page’s wire')
    harness.pane.key('\r')
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'r1', selected: [], custom: secret }, { id: 'r2', selected: ['a'] }],
      'the authoritative answer still carries the real secret')
  } finally {
    await harness.dispose()
  }
})

test('a masked page that ALSO carries options keeps them visible, operable and masked', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const secret = 'masked-with-options-33'
    const answers = harness.renderer.interaction.askQuestions(
      [question({
        id: 'mo',
        question: 'API key (or pick a saved one)',
        masked: true,
        options: [{ label: 'vault', description: 'read from the vault' }, { label: 'env' }],
      })], undefined, recorder.status, false)
    void answers.catch(() => {})
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the masked page opened')
    const texts = wireNodes(harness.pane).filter(node => node.k === 'button').map(node => String(node.p.text ?? ''))
    assert.deepEqual(texts, ['vault', 'env', 'Back', 'Next', 'Cancel'],
      `the choices are painted as real buttons next to the page controls: ${texts.join(',')}`)
    assert.ok(wireText(harness.pane).includes('read from the vault'), 'the option description is not dropped')
    // A pointer pick on an option lands in the same draft the keyboard writes.
    const pick = wireNodes(harness.pane).find(node => node.k === 'button' && node.id.endsWith('.o-0.pick'))
    assert.ok(pick !== undefined, 'the option button carries its own exact node id')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: pick.id, act: 'form-choice' })
    await waitFor(() => recorder.mutations === 1, 'the pointer pick fired the real-answer hook once')
    assert.deepEqual(recorder.drafts.at(-1)?.answers[0], { selected: ['vault'], custom: '', skipped: false },
      'the option really landed in the seat draft')
    // A button of another visit is inert.
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: pick.id.replace('form-choices-0', 'form-choices-9'), act: 'form-choice' })
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: pick.id, act: 'allow' })
    await waitForKeyDeliveryWindow()
    assert.equal(recorder.mutations, 1, 'a stale or mismatched option action changes nothing')
    // The secret stays masked while the choice is visible. This page HAS choices,
    // so it opens on option navigation (RFL-003): the field is entered by
    // CLAIMING it, and only then do the keystrokes belong to it.
    const fieldId = wireNodes(harness.pane).find(node => node.k === 'input' && node.id.endsWith('.answer'))?.id
    assert.ok(fieldId !== undefined, 'the masked page paints its answer field')
    harness.pane.event({ ev: 'focus', sf: BASE_SF, id: fieldId })
    await waitFor(() => lastOp(harness.ops(), 'focus')?.[1] === fieldId, 'the masked input owns the caret before typing')
    harness.pane.key(secret)
    await waitFor(() => recorder.drafts.at(-1)?.answers[0]?.custom === secret, 'the typed secret is held by the draft')
    assert.equal(wireText(harness.pane).includes(secret), false, 'the masked text never reaches the wire')
    // One bullet per GRAPHEME of the value the seat holds, exactly as the
    // masked contract says. Read the FOLDED node: the SDK streams a long value
    // through `text` append ops, so the raw wire is not one contiguous run.
    const field = wireNodes(harness.pane).find(node => node.k === 'input' && node.id.endsWith('.answer'))
    assert.ok(field !== undefined, 'the safe form paints its answer field')
    const bullets = [...secret].length
    assert.equal(String(field.p.text ?? ''), '•'.repeat(bullets), `one bullet per grapheme (${bullets} expected)`)
    assert.equal(Number(field.p.cursor), bullets, 'and the caret counts graphemes too')
    // Commit the secret and finish the flow (the digit/option keyboard contract
    // on this page is pinned by the dedicated RFL-003 case below).
    harness.pane.key('\r')
    await waitForButton(harness.pane, '.submit')
    // The existing single-select rule is unchanged: a nonblank custom answer
    // REPLACES the choice (the same rule `submitBatch`/the PiTui flow apply), so
    // the batch carries the secret only — never the stale pick it superseded.
    harness.pane.key('\r')       // the digit pick commits -> Review
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    // The pre-existing single-select rule is unchanged: a nonblank custom answer
    // REPLACES the choice, so the batch carries the real secret (never the
    // superseded pick) through the original sink.
    const finalBatch = await answers
    assert.deepEqual(finalBatch, [{ id: 'mo', selected: [], custom: secret }],
      'the batch carries the real secret through the original sink')
    assert.equal(JSON.stringify(finalBatch).includes('vault'), false,
      'a superseded pick never rides into the batch')
  } finally {
    await harness.dispose()
  }
})

test('a pane that lacks only the badge kind keeps the legacy approval (no half-shown danger marker)', async () => {
  const harness = await mountHarness({
    kinds: ['col', 'card', 'section', 'md', 'code', 'tool', 'questions', 'overlay', 'row', 'text', 'input', 'button', 'scroll'],
    features: ['flow', 'styles'],
  })
  try {
    const outcome = harness.renderer.interaction.showApprovalPrompt(
      { toolName: 'bash', reason: 'deletes things', arguments: '{"cmd":"rm -rf"}', danger: true }, true)
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the approval opened')
    assert.equal(toolNode(harness.pane), undefined, 'a pane without `badge` never gets the native ask control')
    assert.equal(wireNodes(harness.pane).some(node => node.k === 'badge'), false, 'and no unnegotiated badge is sent')
    assert.ok(wireText(harness.pane).includes('Dangerous command'), 'the legacy form still states the danger fact')
    assert.equal(wireText(harness.pane).includes('dsh-native-approval-shortcuts'), false, 'and no sheet is installed')
    harness.pane.key('n')
    assert.equal(await outcome, 'rejected')
  } finally {
    await harness.dispose()
  }
})

test('clicking the ALREADY selected option still hides the keyboard cursor without a second mutation', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const answers = harness.renderer.interaction.askQuestions(
      [question({ id: 'kc', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] })], undefined, recorder.status, false)
    void answers.catch(() => {})
    await nativeFormReady(harness.pane)
    const cursor = () => wireNodes(harness.pane).some(node => node.id.endsWith('.keyboard-cursor'))
    harness.pane.key('\x1b[B')
    await waitFor(() => cursor(), 'the Arrow press showed the keyboard cursor')
    const form = nativeForm(harness.pane)
    // Pick 'b' (the highlighted row) once: a real change, one hook.
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: form.id, item: 'q-0', value: 'o-1' })
    await waitFor(() => recorder.mutations === 1, 'the first pick fired the hook')
    await waitFor(() => !cursor(), 'the first pick hid the keyboard cursor')
    // Show it again, then re-click the SAME option: no semantic change, but the
    // pointer is clearly in use, so the cursor line must still go away.
    harness.pane.key('\x1b[A')
    await waitFor(() => cursor(), 'the Arrow press showed it again')
    const form2 = nativeForm(harness.pane)
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: form2.id, item: 'q-0', value: 'o-1' })
    await waitFor(() => !cursor(), 're-clicking the selected option hides the keyboard cursor')
    await waitForKeyDeliveryWindow()
    assert.equal(recorder.mutations, 1, 'and a no-op pick still fires no real-answer hook')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'submit' })
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'kc', selected: ['b'] }])
  } finally {
    await harness.dispose()
  }
})

test('a masked multi-select page toggles its visible options on pointer, in source order', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const answers = harness.renderer.interaction.askQuestions(
      [question({
        id: 'mm',
        question: 'Pick stored credentials (or type one)',
        masked: true,
        multiSelect: true,
        options: [{ label: 'one' }, { label: 'two' }, { label: 'three' }],
      })], undefined, recorder.status, false)
    void answers.catch(() => {})
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the masked multi page opened')
    const pickId = (index: number) => wireNodes(harness.pane)
      .find(node => node.k === 'button' && node.id.endsWith(`.o-${index}.pick`))?.id
    const third = pickId(2)
    const first = pickId(0)
    assert.ok(third !== undefined && first !== undefined, 'every visible option carries its own pick node')
    // Click the LAST option first, then the FIRST: both must stay picked.
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: third, act: 'form-choice' })
    await waitFor(() => recorder.mutations === 1, 'the first pick registered')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: first, act: 'form-choice' })
    await waitFor(() => recorder.mutations === 2, 'the second pick registered')
    // The draft is in SELECTION order; the authoritative batch (asserted below)
    // is the one that must come back in source option order.
    assert.deepEqual([...(recorder.drafts.at(-1)?.answers[0]?.selected ?? [])].sort(), ['one', 'three'],
      'a multi pointer pick ADDS to the set and keeps the previous picks')
    // Clicking a picked option again removes only that one.
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: third, act: 'form-choice' })
    await waitFor(() => recorder.mutations === 3, 'the toggle-off registered')
    assert.deepEqual(recorder.drafts.at(-1)?.answers[0]?.selected, ['one'],
      're-clicking a picked option toggles it off and keeps the rest')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: pickId(2)!, act: 'form-choice' })
    await waitFor(() => recorder.drafts.at(-1)?.answers[0]?.selected?.length === 2, 'picked again')
    // To Review and commit: the batch keeps SOURCE option order.
    const nextButton = wireNodes(harness.pane).find(node => node.k === 'button' && node.id.endsWith('.next'))
    assert.ok(nextButton !== undefined, 'the masked page paints its Next button')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nextButton.id, act: 'form-next' })
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'mm', selected: ['one', 'three'] }],
      'the batch carries both picks in source option order')
  } finally {
    await harness.dispose()
  }
})

test('a masked page WITH options opens on option navigation, not on text editing', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const answers = harness.renderer.interaction.askQuestions(
      [question({
        id: 'nav',
        question: 'API key (or pick a stored one)',
        masked: true,
        options: [{ label: 'vault' }, { label: 'env' }],
      })], undefined, recorder.status, false)
    void answers.catch(() => {})
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the masked page opened')
    // §2.4: on an option page a digit selects DIRECTLY and stays on the page.
    // It must not be typed into the masked field, and the page must not open
    // with the field holding the hardware caret.
    assert.notEqual(lastOp(harness.ops(), 'focus')?.[1], overlayIdOfAnswer(harness),
      'the masked page with options does not open with the field focused')
    harness.pane.key('2')
    await waitFor(() => recorder.mutations === 1, 'the digit picked a visible option')
    assert.deepEqual(recorder.drafts.at(-1)?.answers[0], { selected: ['env'], custom: '', skipped: false },
      'the digit selected the option, and no text was typed')
    // The click on the real input IS the way into the field, and then Esc is the
    // first of the two layers (it leaves the edit and keeps the text).
    const field = wireNodes(harness.pane).find(node => node.k === 'input' && node.id.endsWith('.answer'))
    assert.ok(field !== undefined, 'the field is painted')
    harness.pane.event({ ev: 'focus', sf: BASE_SF, id: field.id })
    await waitFor(() => lastOp(harness.ops(), 'focus')?.[1] === field.id, 'the click put the caret in the field')
    harness.pane.key('ab')
    await waitFor(() => recorder.drafts.at(-1)?.answers[0]?.custom === 'ab', 'the keystrokes reached the field')
    harness.pane.key('\x1b')
    await waitFor(() => lastOp(harness.ops(), 'focus')?.[1] !== field.id, 'Esc left the edit')
    assert.equal(recorder.drafts.at(-1)?.answers[0]?.custom, 'ab', 'and the text survived it')
    harness.pane.key('\x1b')
    await assert.rejects(answers, /question flow cancelled/)
  } finally {
    await harness.dispose()
  }
})

/** The answer field's wire id on the current overlay. */
function overlayIdOfAnswer(harness: Harness): string {
  return wireNodes(harness.pane).find(node => node.k === 'input' && node.id.endsWith('.answer'))?.id ?? 'none'
}

test('a masked page with options shows the keyboard cursor and hides it on a pointer pick', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const single = harness.renderer.interaction.askQuestions(
      [question({ id: 'kc1', question: 'Which?', masked: true, options: [{ label: 'a' }, { label: 'b' }] })],
      undefined, recorder.status, false)
    void single.catch(() => {})
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the masked page opened')
    const cursor = () => modalNode(harness.pane, '.keyboard-cursor')?.p.text
    assert.equal(cursor(), undefined, 'no cursor line before an arrow is pressed')
    harness.pane.key('\x1b[B')   // down -> the second option
    await waitFor(() => cursor() !== undefined, 'the safe form paints the keyboard cursor line')
    assert.match(String(cursor()), /Keyboard cursor: \[2\] b · enter select/,
      'and it names the row AND the single-select key')

    // A pointer pick hides it again, on the safe form too.
    const pick = wireNodes(harness.pane).find(node => node.k === 'button' && node.id.endsWith('.o-1.pick'))
    assert.ok(pick !== undefined)
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: pick.id, act: 'form-choice' })
    await waitFor(() => cursor() === undefined, 'a pointer pick hides the cursor line')
    assert.equal(recorder.mutations, 1, 'and the pick is one real answer change')
    harness.pane.key('\x1b')
    await assert.rejects(single, /question flow cancelled/)
  } finally {
    await harness.dispose()
  }
})

test('the cursor line names the MULTI-select keys (space toggle, enter continue)', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const multi = harness.renderer.interaction.askQuestions(
      [question({ id: 'kc2', question: 'Which?', masked: true, multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] })],
      undefined, recorder.status, false)
    void multi.catch(() => {})
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the masked multi page opened')
    harness.pane.key('\x1b[B')
    await waitFor(() => modalNode(harness.pane, '.keyboard-cursor') !== undefined, 'the cursor line appeared')
    assert.match(String(modalNode(harness.pane, '.keyboard-cursor')?.p.text),
      /space toggle · enter continue/, 'the hint is the real multi-select binding, never "Enter select"')
    // And the hint is right: Space toggles, Enter continues.
    harness.pane.key(' ')
    await waitFor(() => recorder.mutations === 1, 'Space toggled the highlighted option')
    assert.deepEqual(recorder.drafts.at(-1)?.answers[0]?.selected, ['b'])
    harness.pane.key('\r')
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await multi, [{ id: 'kc2', selected: ['b'] }])
  } finally {
    await harness.dispose()
  }
})

test('a `(recommended)` suffix keeps its mark on the native form', async () => {
  const harness = await mountNativeHarness()
  try {
    const suffix = harness.renderer.interaction.askQuestions(
      [question({ id: 'rec1', question: 'Which?', options: [{ label: 'slow' }, { label: 'fast (recommended)' }] })],
      undefined, undefined, false)
    void suffix.catch(() => {})
    await nativeFormReady(harness.pane)
    const choices = (nativeForm(harness.pane).p.items as Array<Record<string, unknown>>)[0]!.choices as Array<Record<string, unknown>>
    assert.equal(choices[0]!.label, 'slow')
    assert.equal(choices[1]!.label, 'fast', 'the suffix is stripped from the label')
    assert.match(String(choices[1]!.detail ?? ''), /Recommended/, 'and the recommendation is stated')
    harness.pane.key('\x1b')
    await assert.rejects(suffix, /question flow cancelled/)
  } finally {
    await harness.dispose()
  }
})

test('`intent.approve` recommends the same way the suffix does', async () => {
  // A separate harness: one seat shows one request at a time, so a queued
  // second ask would never be painted for the assertion to read.
  const harness = await mountNativeHarness()
  try {
    const intent = harness.renderer.interaction.askQuestions(
      [question({
        id: 'rec2', question: 'Approve?', intent: { kind: 'approve', approve: 'yes' },
        options: [{ label: 'no' }, { label: 'yes' }],
      })], undefined, undefined, false)
    void intent.catch(() => {})
    await nativeFormReady(harness.pane)
    const choices = (nativeForm(harness.pane).p.items as Array<Record<string, unknown>>)[0]!.choices as Array<Record<string, unknown>>
    assert.match(String(choices[1]!.detail ?? ''), /Recommended/,
      '`intent.approve` marks the same way the suffix does')
    assert.equal(String(choices[0]!.detail ?? ''), '', 'and only the recommended one carries the note')
    harness.pane.key('\x1b')
    await assert.rejects(intent, /question flow cancelled/)
  } finally {
    await harness.dispose()
  }
})

test('the safe form restores the recommendation mark for a masked page', async () => {
  const harness = await mountNativeHarness()
  try {
    const masked = harness.renderer.interaction.askQuestions(
      [question({ id: 'rec3', question: 'Which?', masked: true, options: [{ label: 'plain' }, { label: 'best (recommended)' }] })],
      undefined, undefined, false)
    void masked.catch(() => {})
    await waitFor(() => wireNodes(harness.pane).some(node => node.k === 'button' && node.id.endsWith('.o-1.pick')),
      'the masked page painted its choices')
    const labels = wireNodes(harness.pane).filter(node => node.k === 'button').map(node => String(node.p.text ?? ''))
    assert.ok(labels.some(text => text.includes('best (recommended)')),
      `the safe form restores the recommendation mark: ${labels.join(' / ')}`)
    harness.pane.key('\x1b')
    await assert.rejects(masked, /question flow cancelled/)
  } finally {
    await harness.dispose()
  }
})

test('the recommended answer value is still the ORIGINAL label', async () => {
  const harness = await mountNativeHarness()
  try {
    const answers = harness.renderer.interaction.askQuestions(
      [question({ id: 'rec4', question: 'Which?', intent: { kind: 'approve', approve: 'ship (recommended)' }, options: [{ label: 'wait' }, { label: 'ship (recommended)' }] })],
      undefined, undefined, false)
    void answers.catch(() => {})
    await nativeFormReady(harness.pane)
    const form = nativeForm(harness.pane)
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: form.id, item: 'q-0', value: 'o-1' })
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'submit' })
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'rec4', selected: ['ship (recommended)'] }],
      'the display projection never rewrites the answer value')
  } finally {
    await harness.dispose()
  }
})

test('a 10th option advertises no keycap it cannot honour', async () => {
  const harness = await mountNativeHarness()
  try {
    const options = Array.from({ length: 10 }, (_unused, index) => ({ label: `opt-${index}` }))
    const answers = harness.renderer.interaction.askQuestions(
      [question({ id: 'ten', question: 'Which?', masked: true, options })], undefined, undefined, false)
    void answers.catch(() => {})
    await waitFor(() => wireNodes(harness.pane).filter(node => node.k === 'button').length === 13,
      'all ten choices plus the three page controls are painted')
    const buttons = wireNodes(harness.pane).filter(node => node.k === 'button' && node.id.includes('.o-'))
    assert.equal(buttons.length, 10)
    const keysOf = (index: number) => buttons.find(node => node.id.endsWith(`.o-${index}.pick`))?.p.keys
    assert.deepEqual(keysOf(0), ['1'], 'the first nine carry their digit keycap')
    assert.deepEqual(keysOf(8), ['9'])
    assert.equal(keysOf(9), undefined, 'and the tenth advertises none, since no digit reaches it')
    harness.pane.key('\x1b')
    await assert.rejects(answers, /question flow cancelled/)
  } finally {
    await harness.dispose()
  }
})

test('on a masked page WITH options, Enter selects the highlighted option and Next skips — never both', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const answers = harness.renderer.interaction.askQuestions(
      [question({ id: 'nx', question: 'Which?', masked: true, options: [{ label: 'a' }, { label: 'b' }] })],
      undefined, recorder.status, false)
    void answers.catch(() => {})
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the masked page opened')
    // The ⏎ keycap must not claim Enter runs the Next button: on a page with
    // choices Enter confirms the highlighted option instead.
    const next = wireNodes(harness.pane).find(node => node.k === 'button' && node.id.endsWith('.next'))
    assert.ok(next !== undefined, 'the page paints its Next button')
    assert.deepEqual(next.p.keys, undefined,
      'a page with choices does not advertise ⏎ for Next (Enter selects instead)')
    // Enter really selects the highlighted option and advances.
    harness.pane.key('\x1b[B')   // down to the second option
    await waitFor(() => modalNode(harness.pane, '.keyboard-cursor') !== undefined, 'the cursor line appeared')
    harness.pane.key('\r')
    await waitFor(() => recorder.mutations >= 1, 'Enter confirmed the highlighted option')
    assert.deepEqual(recorder.drafts.at(-1)?.answers[0]?.selected, ['b'],
      'Enter selected the highlighted option, it did not skip')
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'nx', selected: ['b'] }])
  } finally {
    await harness.dispose()
  }
})

test('a free-text page keeps its ⏎ keycap, because Enter really commits the text', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const answers = harness.renderer.interaction.askQuestions(
      [question({ id: 'ft', question: 'Anything else?' })], undefined, recorder.status, false)
    void answers.catch(() => {})
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the free-text page opened')
    const next = wireNodes(harness.pane).find(node => node.k === 'button' && node.id.endsWith('.next'))
    assert.ok(next !== undefined, 'the page paints its Next button')
    assert.deepEqual(next.p.keys, ['⏎'], 'a page with NO choices keeps the keycap: Enter commits the text')
    // And the keycap is honest: clicking Next commits the typed text.
    harness.pane.key('ok')
    await waitFor(() => recorder.drafts.at(-1)?.answers[0]?.custom === 'ok', 'the text reached the draft')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: next.id, act: 'form-next' })
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'ft', selected: [], custom: 'ok' }])
  } finally {
    await harness.dispose()
  }
})

test('clicking Next on an unanswered masked page with options skips the question', async () => {
  const harness = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const answers = harness.renderer.interaction.askQuestions(
      [
        question({ id: 'sk1', question: 'Which?', masked: true, options: [{ label: 'a' }, { label: 'b' }] }),
        question({ id: 'sk2', question: 'Second?', options: [{ label: 'x' }] }),
      ], undefined, recorder.status, false)
    void answers.catch(() => {})
    await waitFor(() => overlayAdds(harness.ops()).length === 1, 'the masked page opened')
    const next = wireNodes(harness.pane).find(node => node.k === 'button' && node.id.endsWith('.next'))
    assert.ok(next !== undefined)
    // No answer at all: the frozen skip rule marks it skipped, it does NOT pick
    // the highlighted option (that is Enter's job, and only Enter's).
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: next.id, act: 'form-next' })
    await waitFor(() => recorder.drafts.at(-1)?.answers[0]?.skipped === true, 'Next marked the question skipped')
    assert.deepEqual(recorder.drafts.at(-1)?.answers[0]?.selected, [], 'and it selected nothing')
    await nativeFormReady(harness.pane, 'the second question is the native steps form')
    harness.pane.event({ ev: 'change', sf: BASE_SF, id: nativeForm(harness.pane).id, item: 'q-1', value: 'o-0' })
    await waitFor(() => recorder.drafts.at(-1)?.answers[1]?.selected?.length === 1, 'the second question answered')
    harness.pane.event({ ev: 'action', sf: BASE_SF, id: nativeForm(harness.pane).id, act: 'submit' })
    await waitForButton(harness.pane, '.submit')
    harness.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'sk1', selected: [] }, { id: 'sk2', selected: ['x'] }],
      'the batch carries the skip, not an accidental selection')
  } finally {
    await harness.dispose()
  }
})

test('after Esc leaves the edit, Next no longer claims ⏎ (Enter re-enters the edit)', async () => {
  const runtime = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const answers = runtime.renderer.interaction.askQuestions(
      [question({ id: 'ft2', question: 'Anything else?' })], undefined, recorder.status, false)
    void answers.catch(() => {})
    await waitFor(() => overlayAdds(runtime.ops()).length === 1, 'the free-text page opened')
    const keysOf = () => wireNodes(runtime.pane)
      .find(node => node.k === 'button' && node.id.endsWith('.next'))?.p.keys
    assert.deepEqual(keysOf(), ['⏎'], 'while the field is the editor, Next really is ⏎')
    runtime.pane.key('hello')
    await waitFor(() => recorder.drafts.at(-1)?.answers[0]?.custom === 'hello', 'the text reached the draft')
    assert.deepEqual(keysOf(), ['⏎'], 'still editing: the keycap still tells the truth')
    // Esc leaves the EDIT (the frozen two-layer contract): the text survives, the
    // page stays, and Enter now only re-enters the edit — so the keycap lies.
    runtime.pane.key('\x1b')
    await waitFor(() => lastOp(runtime.ops(), 'focus')?.[1] !== 'layer.modal-1.answer', 'Esc left the edit')
    assert.equal(recorder.drafts.at(-1)?.answers[0]?.custom, 'hello', 'and kept the text')
    // The SDK clears a dropped prop with `null` (an `undefined`-valued prop
    // would be SKIPPED and leave the old keycap painted), so "no keycap" reads
    // as null/absent on the wire — never as the earlier ['⏎'].
    assert.ok(keysOf() === null || keysOf() === undefined,
      `a page that is NOT editing does not advertise ⏎ for Next (Enter re-enters the edit): ${JSON.stringify(keysOf())}`)
    // The claim is right: Enter re-enters the edit, it does not run Next.
    runtime.pane.key('\r')
    await waitFor(() => lastOp(runtime.ops(), 'focus')?.[1] === 'layer.modal-1.answer', 'Enter re-entered the edit')
    assert.deepEqual(keysOf(), ['⏎'], 'and the keycap comes back with the editor')
    assert.equal(recorder.drafts.at(-1)?.answers[0]?.custom, 'hello', 'nothing was submitted by that Enter')
    // A second Enter (now editing) really commits and advances.
    runtime.pane.key('\r')
    await waitForButton(runtime.pane, '.submit')
    runtime.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'ft2', selected: [], custom: 'hello' }])
  } finally {
    await runtime.dispose()
  }
})

test('the same Esc→Enter rule holds on a MASKED free-text page', async () => {
  const runtime = await mountNativeHarness()
  const recorder = statusOf()
  try {
    const answers = runtime.renderer.interaction.askQuestions(
      [question({ id: 'ms2', question: 'Token?', masked: true })], undefined, recorder.status, false)
    void answers.catch(() => {})
    await waitFor(() => overlayAdds(runtime.ops()).length === 1, 'the masked page opened')
    const keysOf = () => wireNodes(runtime.pane)
      .find(node => node.k === 'button' && node.id.endsWith('.next'))?.p.keys
    runtime.pane.key('hunter2')
    await waitFor(() => recorder.drafts.at(-1)?.answers[0]?.custom === 'hunter2', 'the secret reached the draft')
    assert.deepEqual(keysOf(), ['⏎'], 'editing: Next is ⏎')
    assert.equal(wireText(runtime.pane).includes('hunter2'), false, 'and the secret is never on the wire')
    runtime.pane.key('\x1b')
    await waitFor(() => lastOp(runtime.ops(), 'focus')?.[1] !== 'layer.modal-1.answer', 'Esc left the edit')
    assert.ok(keysOf() === null || keysOf() === undefined,
      `not editing: no false ⏎ (Enter would only re-enter the edit): ${JSON.stringify(keysOf())}`)
    runtime.pane.key('\r')
    await waitFor(() => lastOp(runtime.ops(), 'focus')?.[1] === 'layer.modal-1.answer', 'Enter re-entered the edit')
    assert.deepEqual(keysOf(), ['⏎'], 'editing again: the keycap is honest again')
    runtime.pane.key('\r')
    await waitForButton(runtime.pane, '.submit')
    runtime.pane.key('\r')
    assert.deepEqual(await answers, [{ id: 'ms2', selected: [], custom: 'hunter2' }])
    assert.equal(wireText(runtime.pane).includes('hunter2'), false, 'the secret still never reached the wire')
  } finally {
    await runtime.dispose()
  }
})
