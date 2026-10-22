/**
 * PR3-B B2 submission-path tests.
 *
 * These run the REAL TSP renderer over the scripted pane (shipped SDK connect)
 * so the submit gesture, its ordering and the rollback are exercised through
 * the renderer's own composer and the real `mountTspRenderer` wiring — not
 * through a hand-built state machine. The application side of the submit path
 * (the ONE `SubmissionController`) is covered by the runner-interactive suite;
 * here the interest is the RENDERER half of the contract:
 *
 *   1. the §3.4 ordering: snapshot → clear → callback, never a stale restore;
 *   2. rollback: a refusal that merges the draft back shows up as live draft
 *      content again, and the next submit re-sends the merged text;
 *   3. no double-send: an accepted submit leaves an empty composer, so a
 *      second Enter in the same gesture window submits nothing new.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-submission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { connect as sdkConnect, concatBytes, type TermInput, type TermOutput } from '@stencil-hq/tern'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import type { StreamingToolPreview } from '../../src/app/surface/streaming-tool-preparing.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

class FakeInput extends EventEmitter implements TermInput {
  readonly isTTY = true
  isRaw = false
  setRawMode(mode: boolean): void { this.isRaw = mode }
  type(text: string): void { this.emit('data', ENCODER.encode(text)) }
}

class FakeOutput implements TermOutput {
  readonly isTTY = true
  readonly columns = 100
  readonly chunks: Uint8Array[] = []
  write(data: Uint8Array | string): boolean {
    this.chunks.push(typeof data === 'string' ? ENCODER.encode(data) : data)
    return true
  }
  text(): string { return DECODER.decode(concatBytes(this.chunks)) }
}

const HELLO = {
  r: 'hello', v: 1, term: 'tern', ver: '0.6.2',
  kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'editor', 'input', 'text'],
  features: ['flow', 'styles', 'paste'],
  apc: 65536, credits: 2, cols: 120, cell: { w: 8, h: 17 },
  dark: true, reduceMotion: false, hour12: false,
}

/** The controlled editor text the wire last committed for `dock.composer`. */
function lastComposerText(wire: string): string | undefined {
  let text: string | undefined
  for (const match of wire.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
    const frame = JSON.parse(match[1]!) as { ops: unknown[][] }
    for (const op of frame.ops) {
      if (op[0] === 'add') {
        const node = op[4] as { c?: Array<{ id?: string; p?: { text?: string } }> } | undefined
        const editor = node?.c?.find(child => child.id === 'dock.composer')
        if (editor?.p?.text !== undefined) text = editor.p.text
      } else if (op[0] === 'set' && op[1] === 'dock.composer') {
        const props = op[2] as { text?: string }
        if (props.text !== undefined) text = props.text
      } else if (op[0] === 'text' && op[1] === 'dock.composer') {
        const action = op[2]
        const value = op[3] as string
        text = action === 'append' ? (text ?? '') + value : value
      }
    }
  }
  return text
}

interface Harness {
  readonly renderer: TspRenderer
  readonly input: FakeInput
  readonly output: FakeOutput
  readonly session: Awaited<ReturnType<typeof sdkConnect>>
  dispose(): Promise<void>
}

async function mountPane(
  onSubmit: (text: string, request: string) => void,
  /** Opt out of the commit-point bind so a test can drive the held window. */
  options: {
    bind?: boolean
    /** Lifecycle-intent recorders for the default binding (cancel/exit). */
    onCancel?: () => void
    onExit?: () => void
  } = {},
): Promise<Harness> {
  const input = new FakeInput()
  const output = new FakeOutput()
  // ONE pass-through wrapper: the original write keeps capturing the wire
  // (output.text() below reads it), the wrapper additionally answers the DA1
  // probe and acks every frame — only the tty boundary is simulated.
  const originalWrite = output.write.bind(output)
  output.write = (data): boolean => {
    originalWrite(data)
    const bytes = typeof data === 'string' ? ENCODER.encode(data) : data
    const text = DECODER.decode(bytes)
    if (text.includes('\u001b[c')) {
      setTimeout(() => input.type(`\u001b_tsp;r;${JSON.stringify(HELLO)}\u001b\\\u001b[?62;52;c`), 1)
      return true
    }
    for (const match of text.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
      const frame = JSON.parse(match[1]!) as { sf: string; s: number }
      setTimeout(() => input.type(
        `\u001b_tsp;e;${JSON.stringify({ ev: 'ack', sf: frame.sf, s: frame.s })}\u001b\\`,
      ), 0)
    }
    return true
  }
  const session = await sdkConnect({ env: {}, input, output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')
  const renderer = mountTspRenderer(session, { requestExit: () => {} })
  if (options.bind !== false) {
    renderer.bindInput({
      exit: () => { options.onExit?.() },
      cancel: () => { options.onCancel?.() },
      submit: (text, request) => onSubmit(text, request),
      steer: () => {},
      noteUserInput: () => {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false,
    })
  }
  return {
    renderer,
    input,
    output,
    session,
    dispose: async () => { await renderer.dispose(); await session.close() },
  }
}

/**
 * The FIXED wait, for the observations that are about what did NOT happen.
 *
 * A negative fact ("the held key never reached the composer") needs an
 * observation WINDOW, and the window is the assertion's own bound. The same
 * wait covers the moment right after a hydration fence is ARMED: the next
 * key must land inside the fence, and "the fence is up" is not an
 * observable frame.
 */
async function settle(millis = 300): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, millis))
}

/** Wait for a real fact, with the deadline the observation is worth. */
async function awaitFact(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail(`timed out waiting for ${label}`)
    }
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

/**
 * Wait until the composer HAS the typed text.
 *
 * The typed text reaches the composer through the real input path, and the
 * composer is the authority for it (the controlled editor state the renderer
 * owns, and the same text the wire carries). Waiting for that fact replaces
 * a fixed sleep that only GUESSED how long the delivery takes.
 */
async function awaitTyped(harness: Harness, text: string): Promise<void> {
  await awaitFact(
    () => harness.renderer.composer.getDraft() === text
      || lastComposerText(harness.output.text()) === text,
    `the composer to hold ${JSON.stringify(text)}`,
  )
}

test('the submit callback observes an EMPTY composer (clear-before-callback ordering)', async () => {
  const seen: Array<{ text: string; draftAtCallback: string }> = []
  const harness = await mountPane((text) => {
    seen.push({ text, draftAtCallback: harness.renderer.composer.getDraft() })
  })
  try {
    harness.input.type('ordered text')
    await awaitTyped(harness, 'ordered text')
    harness.input.type('\r')
    await awaitFact(() => seen.length === 1, 'the submit callback to run')
    assert.deepEqual(seen, [{ text: 'ordered text', draftAtCallback: '' }],
      'one submit; the composer was already cleared when the callback ran')
    assert.equal(harness.renderer.composer.getDraft(), '')
  } finally {
    await harness.dispose()
  }
})

test('a refusal that merges the draft back becomes live content and is re-submittable', async () => {
  // The refusal path the real controller uses for an unsupported builtin or a
  // `!` line: merge the submitted text into the live draft and notify. The
  // renderer must show that merged draft again (no stale pre-callback
  // snapshot winning over it) and the next Enter must re-send the merged text.
  const submissions: string[] = []
  let refuseOnce = true
  const harness = await mountPane((text) => {
    submissions.push(text)
    if (refuseOnce) {
      refuseOnce = false
      // Exactly what the controller's refusal does: merge back into the LIVE
      // composer (read → merge → write), never restore a snapshot.
      harness.renderer.composer.setDraft(`${harness.renderer.composer.getDraft()}${text}`)
    }
  })
  try {
    harness.input.type('!echo hi')
    await awaitTyped(harness, '!echo hi')
    harness.input.type('\r')
    await awaitFact(() => submissions.length === 1, 'the refused line to reach the submit path')
    assert.deepEqual(submissions, ['!echo hi'], 'the refused line reached the submit path once')
    assert.equal(harness.renderer.composer.getDraft(), '!echo hi',
      'the refusal merged the line back into the live composer')
    assert.equal(lastComposerText(harness.output.text()), '!echo hi',
      'the merged draft is on the wire again (the renderer never re-applied a stale snapshot)')
    harness.input.type('\r')
    await awaitFact(() => submissions.length === 2, 'the second submission')
    assert.deepEqual(submissions, ['!echo hi', '!echo hi'],
      'the next Enter re-sends the restored text (a real second submission, not a replay of the first)')
  } finally {
    await harness.dispose()
  }
})

test('an accepted submit leaves an empty composer, so a second Enter cannot double-send', async () => {
  // The receiver mirrors the existing application admission: an EMPTY
  // serialized draft is a silent no-op (`dispatchUserInput`'s guard), so a
  // second Enter on the already-cleared composer can never produce a second
  // send. The renderer's job is only to hand over the (empty) draft.
  const delivered: string[] = []
  const harness = await mountPane((text) => { if (text.trim() !== '') delivered.push(text) })
  try {
    harness.input.type('once')
    await awaitTyped(harness, 'once')
    harness.input.type('\r')
    await awaitFact(() => delivered.length === 1, 'the first delivery')
    assert.deepEqual(delivered, ['once'], 'the first Enter delivered the draft exactly once')
    assert.equal(harness.renderer.composer.getDraft(), '')
    harness.input.type('\r')
    await settle()
    assert.deepEqual(delivered, ['once'],
      'the second Enter handed over an EMPTY draft (the application no-ops it) — no duplicate send')
  } finally {
    await harness.dispose()
  }
})

// ── The session/hydration input fence (§3.4 row 1) ──────────────────────────

test('the hydration window accepts NO composer key and never submits', async () => {
  const submissions: string[] = []
  const harness = await mountPane((text) => { submissions.push(text) })
  try {
    harness.input.type('draft before the switch')
    await awaitTyped(harness, 'draft before the switch')
    assert.equal(harness.renderer.composer.getDraft(), 'draft before the switch')
    // A generation bump: the surface reports the hydration window (the new
    // subject's frame has not committed yet).
    harness.renderer.display.beginSessionHydration()
    await settle()
    harness.input.type('more')
    await settle()
    assert.equal(harness.renderer.composer.getDraft(), 'draft before the switch',
      'the fence preserves the outgoing draft and accepts no edit')
    harness.input.type('\r')
    await settle()
    assert.deepEqual(submissions, [], 'no submit can cross the hydration fence')
  } finally {
    await harness.dispose()
  }
})

test('the fence lifts when the new subject commits, and the composer works again', async () => {
  const submissions: string[] = []
  const harness = await mountPane((text) => { submissions.push(text) })
  try {
    harness.renderer.display.beginSessionHydration()
    await settle()
    harness.input.type('typed during the switch')
    await settle()
    assert.equal(harness.renderer.composer.getDraft(), '', 'still fenced')
    // The new subject commits a projection: the fence lifts.
    harness.renderer.display.setTranscript([], undefined, undefined, undefined, undefined, { subject: 'new' })
    harness.input.type('after the switch')
    await awaitTyped(harness, 'after the switch')
    assert.equal(harness.renderer.composer.getDraft(), 'after the switch',
      'input is accepted again once the new subject committed')
    harness.input.type('\r')
    await awaitFact(() => submissions.length === 1, 'the submit after the fence lift')
    assert.deepEqual(submissions, ['after the switch'],
      'a submit after the fence lift reaches the application normally')
  } finally {
    await harness.dispose()
  }
})

test('a key HELD across a generation bump cannot submit when the bind replays it', async () => {
  // The reviewer's exact shape: hold text + Enter, THEN the surface reports a
  // generation bump, THEN the bind replays the queue. The replay must honour
  // the SAME fence as the live path — previously it called the dispatcher
  // directly and the held Enter submitted into the outgoing subject.
  const submissions: string[] = []
  const harness = await mountPane((text) => { submissions.push(text) }, { bind: false })
  try {
    harness.input.type('held text\r')
    await settle()
    assert.equal(harness.renderer.composer.getDraft(), '', 'the held keys never touched the composer')
    // The surface announces the generation bump BEFORE the bind.
    harness.renderer.display.beginSessionHydration()
    await settle()
    harness.renderer.bindInput({
      exit: () => {}, cancel: () => {},
      submit: (text) => { submissions.push(text) },
      steer: () => {}, noteUserInput: () => {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false,
    })
    await settle()
    assert.deepEqual(submissions, [], 'the held Enter did NOT cross the hydration fence at the replay')
  } finally {
    await harness.dispose()
  }
})

test('a hydration that NEVER commits stays fail-closed (Loading retained, no submit, cancel still live)', async () => {
  // The never-commit terminal state the round-3 review asked to pin: when the
  // owner's hydrate fails BEFORE any new-subject frame, the renderer cannot
  // lift the fence itself (only a NEW source token commits it away). The
  // honest witness is the RENDERER's own contract: the Loading state stays,
  // the retained draft is preserved (never silently editable nor submittable
  // against the outgoing subject), and the lifecycle intents remain live —
  // the owner's failure handling (session-presentation records the failure
  // and continues; the runner never exits from a renderer-local fence).
  const submissions: string[] = []
  let cancels = 0
  let exits = 0
  const harness = await mountPane((text) => { submissions.push(text) }, {
    onCancel: () => { cancels += 1 },
    onExit: () => { exits += 1 },
  })
  try {
    harness.input.type('draft of the outgoing subject')
    await awaitTyped(harness, 'draft of the outgoing subject')
    assert.equal(harness.renderer.composer.getDraft(), 'draft of the outgoing subject')
    // The owner's hydrate began and NEVER commits a new subject.
    harness.renderer.display.beginSessionHydration()
    await settle(1_000)
    // The Loading state is retained (no new-subject frame ever committed).
    assert.ok(harness.output.text().includes('Loading session'),
      'the never-committing hydration keeps the explicit Loading state')
    // The draft is preserved and untouchable: neither edits nor submits cross.
    harness.input.type('X')
    harness.input.type('\r')
    await settle()
    assert.equal(harness.renderer.composer.getDraft(), 'draft of the outgoing subject',
      'the fenced composer kept the outgoing draft verbatim')
    assert.deepEqual(submissions, [], 'no submit crossed the never-lifted fence')
    // The LIFECYCLE intents stay live (the fence must not lock the user in).
    harness.input.type('\u001b')
    // The cancel intent is the completion signal, and the case asserts it:
    // a fixed wait only guessed how long the lifecycle intent took to reach
    // the host.
    await awaitFact(() => cancels === 1, 'the cancel intent to reach the host')
    assert.equal(cancels, 1, 'Escape still reaches the cancel intent (fail-closed, never locked)')
    assert.equal(exits, 0, 'the fence itself never exits the TUI')
  } finally {
    await harness.dispose()
  }
})

// ── The genuine A→B draft isolation (§7.3; the B2 external review's F1) ─────

test('a GENUINE session switch clears the old draft — Enter into B never sends A\'s text', async () => {
  // The exact state sequence of the external review's P2: session A's
  // unsubmitted draft must not survive into B. The session-lifecycle
  // authority drops the active draft at the COMMITTED cross-owner
  // publication (the session runtime's post-commit sites — see the wiring
  // witness in recent-performance-availability.test.ts for the production
  // call positions); the renderer contract under test here is the seam
  // pair `beginSessionHydration()` + `clearActiveDraft()` followed by B's
  // own commit.
  const submissions: string[] = []
  const harness = await mountPane((text) => { submissions.push(text) })
  try {
    harness.input.type('draft from A')
    await awaitTyped(harness, 'draft from A')
    assert.equal(harness.renderer.composer.getDraft(), 'draft from A')
    // The committed-switch seam pair (the runtime calls these back-to-back
    // at the post-publication site).
    harness.renderer.display.beginSessionHydration()
    harness.renderer.display.clearActiveDraft()
    await settle()
    // B's own projection commits: the fence lifts.
    harness.renderer.display.setTranscript([], undefined, undefined, undefined, undefined, { subject: 'B' })
    assert.equal(harness.renderer.composer.getDraft(), '',
      'the A→B switch cleared A\'s unsubmitted draft (never submittable into B)')
    // A stray Enter right after the lift hands the renderer's EMPTY wire
    // form to the application (its empty-submission no-op); what must NEVER
    // appear is A's text.
    harness.input.type('\r')
    await awaitFact(() => submissions.length === 1, 'the empty handover')
    assert.deepEqual(submissions, [''],
      'the stray Enter handed over the EMPTY draft (the application no-ops it) — never A\'s text')
    // B's own typing works normally.
    harness.input.type('typed in B')
    await awaitTyped(harness, 'typed in B')
    harness.input.type('\r')
    await awaitFact(() => submissions.length === 2, "B's own submission")
    assert.deepEqual(submissions, ['', 'typed in B'],
      'after the empty handover, B\'s own draft submits normally (A\'s text never appears)')
  } finally {
    await harness.dispose()
  }
})

test('the FIRST-session creation and a generation bump WITHOUT a committed switch never drop the draft', async () => {
  // The round-6 review's discriminator: the generation reset alone is an
  // INVALIDATION signal, not a confirmed A→B. The first-session creation
  // (commit shape C) bumps too, and a pre-publication failure bumps while
  // the OLD owner still stands — in both shapes the draft belongs to the
  // live/still-current subject and MUST survive. The renderer-side
  // contract: only the explicit `clearActiveDraft()` (called solely from
  // the session runtime's committed post-publication sites) ever drops the
  // text; `beginSessionHydration()` alone never does.
  const submissions: string[] = []
  const harness = await mountPane((text) => { submissions.push(text) })
  try {
    // Shape C (first session): the user types while the deferred create is
    // in flight; the creation's generation bump + hydration window raise —
    // but there is no OUTGOING session, so no drop may happen.
    harness.input.type('typed while the first session creates')
    await awaitTyped(harness, 'typed while the first session creates')
    harness.renderer.display.beginSessionHydration()
    await settle()
    harness.renderer.display.setTranscript([], undefined, undefined, undefined, undefined, { subject: 'first' })
    assert.equal(harness.renderer.composer.getDraft(), 'typed while the first session creates',
      'the first-session creation preserved the draft (no outgoing session ⇒ no drop)')
    // The pre-publication failure shape: a generation bump happened (the
    // invalidation) but the publication failed — the OLD owner stands and
    // its own fold re-commits. The hydration window lifts on the new source
    // token; the draft was never dropped.
    harness.input.type(' + kept')
    await awaitTyped(harness, 'typed while the first session creates + kept')
    harness.renderer.display.beginSessionHydration()
    await settle()
    harness.renderer.display.setTranscript([], undefined, undefined, undefined, undefined, { subject: 'still-A' })
    assert.equal(harness.renderer.composer.getDraft(), 'typed while the first session creates + kept',
      'an invalidated-but-unswitched generation preserved the draft (the drop needs the committed publication)')
  } finally {
    await harness.dispose()
  }
})

test('a SAME-SESSION rehydrate preserves the unsubmitted draft', async () => {
  // §7.3's other half: ordinary hydration of the SAME session keeps the
  // unsubmitted main-composer text Client-local. `initLiveSession` calls
  // `beginSessionHydration` on the SAME generation (no generation reset, no
  // `clearActiveDraft`), so the draft must survive the rehydrate window and
  // remain editable once the new fold commits.
  const submissions: string[] = []
  const harness = await mountPane((text) => { submissions.push(text) })
  try {
    harness.input.type('kept through rehydrate')
    await awaitTyped(harness, 'kept through rehydrate')
    harness.renderer.display.beginSessionHydration()
    await settle()
    // The SAME session's replacement fold commits (a new source token, no
    // generation reset): the fence lifts WITHOUT any draft drop.
    harness.renderer.display.setTranscript([], undefined, undefined, undefined, undefined, { subject: 'same-session-new-fold' })
    assert.equal(harness.renderer.composer.getDraft(), 'kept through rehydrate',
      'the same-session rehydrate preserved the unsubmitted draft')
    harness.input.type(' + more')
    await awaitTyped(harness, 'kept through rehydrate + more')
    assert.equal(harness.renderer.composer.getDraft(), 'kept through rehydrate + more',
      'editing continues on the preserved draft')
    harness.input.type('\r')
    await awaitFact(() => submissions.length === 1, 'the preserved draft submission')
    assert.deepEqual(submissions, ['kept through rehydrate + more'],
      'the preserved draft submits into the SAME session normally')
  } finally {
    await harness.dispose()
  }
})

test('a FAILED switch (hydration raised, never cleared, no new subject) preserves the draft', async () => {
  // The failure-adjacent path the external review asked to cover: a switch
  // that begins (hydration window raised) but never reaches its generation
  // boundary — the owner's failure handling keeps the OLD subject. No
  // `clearActiveDraft` ran, so the user's draft is intact once the SAME
  // subject re-commits.
  const submissions: string[] = []
  const harness = await mountPane((text) => { submissions.push(text) })
  try {
    harness.input.type('draft during failed switch')
    await awaitTyped(harness, 'draft during failed switch')
    harness.renderer.display.beginSessionHydration()
    await settle()
    // The switch FAILED: the same subject's own fold re-commits (the fence
    // lifts on the new source token; no draft was ever dropped).
    harness.renderer.display.setTranscript([], undefined, undefined, undefined, undefined, { subject: 'A-recovered' })
    assert.equal(harness.renderer.composer.getDraft(), 'draft during failed switch',
      'a failed switch preserved the draft (no draft drop without the generation boundary)')
    harness.input.type('\r')
    await awaitFact(() => submissions.length === 1, 'the recovered session submission')
    assert.deepEqual(submissions, ['draft during failed switch'],
      'the preserved draft submits into the recovered session normally')
  } finally {
    await harness.dispose()
  }
})

test('the TSP renderer declares the switch-dropping stale-restore contract', async () => {
  // The renderer-side half of the F2 contract: after a committed switch
  // dropped the outgoing draft, the renderer DECLARES that a stale
  // submission's restore must be suppressed (`retainsStaleDraftRestore()`
  // === false). The suppression itself lives in the submission runtime —
  // its REAL async regression (old busy steer parked at prepare → the
  // switch → the stale settle) is in writer-admission.test.ts; this case
  // pins the renderer's capability answer and that the composer has no
  // hidden second owner (the port mutator stays the only writer).
  const submissions: string[] = []
  const harness = await mountPane((text) => { submissions.push(text) })
  try {
    assert.equal(harness.renderer.display.retainsStaleDraftRestore(), false,
      'the TSP renderer drops stale restores across a committed switch (PiTui retains — its adapter test and steer.test.ts pin that half)')
    // The composer exposes no other restore path: the port mutator is the
    // only writer, so the runtime's suppression decision is total.
    assert.equal(harness.renderer.composer.getDraft(), '', 'the composer starts empty')
    harness.renderer.composer.setEditorText('probe')
    assert.equal(harness.renderer.composer.getDraft(), 'probe',
      'the port mutator remains the only writer (no hidden cache or second owner)')
    harness.renderer.composer.setEditorText('')
    assert.deepEqual(submissions, [])
  } finally {
    await harness.dispose()
  }
})

test('clearActiveDraft is PURE STATE — no render IO, no throw surface', async () => {
  // The external review's publication-atomicity finding: the drop runs
  // inside the synchronous publication block, where a throwing render would
  // turn the clear into a pre-publication failure with the draft already
  // lost. The TSP primitive is therefore PURE STATE: it commits the emptied
  // editor without rendering (the next committed frame carries it), so the
  // seam cannot throw renderer IO. Witnessed on the real pane: the clear
  // emits NO new wire frame, and the editor STATE is emptied — the very
  // next render (the hydration repaint) draws the empty composer.
  const harness = await mountPane(() => {})
  try {
    harness.input.type('draft to drop')
    await awaitTyped(harness, 'draft to drop')
    assert.equal(harness.renderer.composer.getDraft(), 'draft to drop')
    const framesBefore = harness.output.chunks.length
    harness.renderer.display.clearActiveDraft()
    // NO render IO happened synchronously (the publication-safe property).
    assert.equal(harness.output.chunks.length, framesBefore,
      'the clear emitted no frame — pure state, no renderer IO, no throw surface')
    assert.equal(harness.renderer.composer.getDraft(), '',
      'the editor STATE is emptied (the next committed frame draws it)')
    // The next render (B's own commit) carries the empty composer.
    harness.renderer.display.setTranscript([], undefined, undefined, undefined, undefined, { subject: 'B' })
    // The completion signal is the CLEARED COMPOSER ON THE WIRE: the output
    // chunk count would also move for an unrelated write, and the renderer's
    // own state says nothing about what was painted. The wire is what the
    // contract is about.
    await awaitFact(() => lastComposerText(harness.output.text()) === '',
      'the cleared composer to reach the wire')
    assert.ok(harness.output.chunks.length > framesBefore, 'the next frame committed')
    assert.equal(lastComposerText(harness.output.text()), '',
      'the wire shows the empty composer through B\'s first frame')
    assert.equal(harness.renderer.composer.getDraft(), '', 'the editor stays empty through B\'s first frame')
  } finally {
    await harness.dispose()
  }
})

// ── PR-B3: the native Preparing rows over the REAL renderer ──────────────────
//
// The mapper is exercised over the real `mountTspRenderer` + the shipped SDK
// connect: the renderer receives the preview snapshot through the ONE display
// seam (`setTranscript`) and the SDK turns the native nodes into real wire
// frames. These cases prove the RENDERER half — the preview reaches the wire,
// a byte update re-texts the SAME row, the formal call removes it, and a
// retired source can never revive the retired rows.

/** One durable tool row (a Work member). */
function workTool(turn: number, callId: string, name = 'read'): Extract<TranscriptMessage, { kind: 'tool' }> {
  return { kind: 'tool', turn, callId, name, args: '{}', result: '', status: 'running' }
}

/** One live Preparing preview (the application owner's projection). */
function preview(overrides: Partial<StreamingToolPreview> & { readonly turn: number }): StreamingToolPreview {
  return { callId: '', step: 0, index: 0, argumentBytes: 7, ...overrides }
}

interface WireNode {
  readonly id: string
  readonly k: string
  readonly p?: Record<string, unknown>
  readonly c?: WireNode[]
}

/** Every wire frame of the run, in order. */
function wireFrames(wire: string): { ops: unknown[][] }[] {
  const frames: { ops: unknown[][] }[] = []
  for (const match of wire.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
    frames.push(JSON.parse(match[1]!) as { ops: unknown[][] })
  }
  return frames
}

/** The node state the wire accumulates (add/del/set/text replayed). */
function wireState(wire: string): Map<string, { k: string; p: Record<string, unknown>; childIds: string[] }> {
  const nodes = new Map<string, { k: string; p: Record<string, unknown>; childIds: string[] }>()
  const visit = (node: WireNode): void => {
    nodes.set(node.id, { k: node.k, p: node.p ?? {}, childIds: (node.c ?? []).map(child => child.id) })
    for (const child of node.c ?? []) visit(child)
  }
  for (const frame of wireFrames(wire)) {
    for (const op of frame.ops) {
      if (op[0] === 'add') {
        const node = op[4] as WireNode | null | undefined
        if (node !== undefined && node !== null) visit(node)
      } else if (op[0] === 'del') {
        // A delete removes the whole subtree from the client's tree.
        const doomed = new Set<string>()
        const collect = (id: string): void => {
          if (doomed.has(id)) return
          doomed.add(id)
          for (const child of nodes.get(id)?.childIds ?? []) collect(child)
        }
        collect(op[1] as string)
        for (const id of doomed) nodes.delete(id)
      } else if (op[0] === 'set') {
        const id = op[1] as string
        const existing = nodes.get(id)
        if (existing !== undefined) nodes.set(id, { ...existing, p: { ...existing.p, ...(op[2] as object) } })
      } else if (op[0] === 'text') {
        const id = op[1] as string
        const existing = nodes.get(id)
        if (existing === undefined) continue
        const before = typeof existing.p['text'] === 'string' ? existing.p['text'] : ''
        const value = op[3] as string
        nodes.set(id, { ...existing, p: { ...existing.p, text: op[2] === 'append' ? before + value : value } })
      }
    }
  }
  return nodes
}

/** The native row nodes the wire currently shows, with their visible text. */
function wirePreparingRows(wire: string): { id: string; text: string }[] {
  const nodes = wireState(wire)
  const rows: { id: string; text: string }[] = []
  for (const [id, node] of nodes) {
    if (node.k !== 'row') continue
    rows.push({ id, text: node.childIds.map(child => String(nodes.get(child)?.p['text'] ?? '')).join('') })
  }
  return rows
}

/** The ops of the LAST wire frame (the renderer's own diff). */
function lastFrameOps(wire: string): unknown[][] {
  const frames = wireFrames(wire)
  const last = frames[frames.length - 1]
  assert.ok(last !== undefined, 'the renderer committed at least one frame')
  return last.ops
}

/** Whether the wire currently shows a node with exactly this text. */
function wireHasText(wire: string, text: string): boolean {
  return [...wireState(wire).values()].some(node => node.p['text'] === text)
}

test('B3-S01: the preview the renderer is given reaches the wire as ONE native row', async () => {
  const harness = await mountPane(() => {})
  try {
    harness.renderer.display.setTranscript(
      [workTool(1, 'call-1')],
      undefined,
      undefined,
      [preview({ turn: 1, callId: 'call-bash', name: 'bash', summary: 'Run focused tests', argumentBytes: 23 })],
      undefined,
      { subject: 'A' },
    )
    await settle(120)
    const wire = harness.output.text()
    const rows = wirePreparingRows(wire)
    assert.equal(rows.length, 1, 'exactly one native row on the wire')
    assert.equal(rows[0]!.text, 'Preparing Bash… · Run focused tests · 23 B')
    assert.ok(wire.includes('"k":"row"'), 'the row is a native row node')
    assert.ok(!wire.includes('"k":"badge"'), 'no badge node')
    // The Preparing row is NOT a tool node: the durable Work tool is the only
    // tool on the wire, and the Preparing row adds none.
    const state = wireState(wire)
    assert.equal([...state.values()].filter(node => node.k === 'row').length, 1, 'exactly one row node')
    assert.equal([...state.values()].filter(node => node.k === 'tool').length, 1, 'the durable tool only')
  } finally {
    await harness.dispose()
  }
})

test('B3-S02: more bytes re-text the SAME row, and the formal call removes it', async () => {
  const harness = await mountPane(() => {})
  try {
    const source = { subject: 'A' }
    // The SAME durable row object across the commits: the transcript row keeps
    // its presentation identity, so only the Preparing row changes.
    const existing = workTool(1, 'call-1')
    harness.renderer.display.setTranscript(
      [existing],
      undefined,
      undefined,
      [preview({ turn: 1, callId: 'call-bash', name: 'bash', summary: 'Run focused tests', argumentBytes: 23 })],
      undefined,
      source,
    )
    await settle(120)
    const added = wirePreparingRows(harness.output.text())
    assert.equal(added.length, 1, 'the first frame adds the row')
    const rowId = added[0]!.id

    // More streamed bytes: the SAME row, re-texted — no delete, no re-add.
    harness.renderer.display.setTranscript(
      [existing],
      undefined,
      undefined,
      [preview({ turn: 1, callId: 'call-bash', name: 'bash', summary: 'Run focused tests', argumentBytes: 69 })],
      undefined,
      source,
    )
    await settle(120)
    const updateOps = lastFrameOps(harness.output.text())
    assert.equal(updateOps.filter(op => op[0] === 'del').length, 0, 'the row is not deleted')
    assert.equal(updateOps.filter(op => op[0] === 'add').length, 0, 'the row is not re-added')
    const textOps = updateOps.filter(op => op[0] === 'text')
    assert.equal(textOps.length, 1, 'only the byte text changed')
    assert.equal(textOps[0]![1], `${rowId}.bytes`)

    // The formal tool call: the owner cleared the preview, so the row goes.
    harness.renderer.display.setTranscript(
      [existing, { kind: 'tool', turn: 1, callId: 'call-bash', name: 'bash', args: '{}', result: '', status: 'running' }],
      undefined,
      undefined,
      [],
      undefined,
      source,
    )
    await settle(120)
    const handoffOps = lastFrameOps(harness.output.text())
    assert.ok(handoffOps.some(op => op[0] === 'del' && op[1] === rowId), 'the Preparing row is deleted')
    const wire = harness.output.text()
    assert.ok(!wirePreparingRows(wire).some(row => row.id === rowId), 'the row is gone from the wire')
  } finally {
    await harness.dispose()
  }
})

test('B3-S03: the retired source\'s Preparing rows can never revive the Loading state', async () => {
  const harness = await mountPane(() => {})
  try {
    const retired = { subject: 'A' }
    const existing = workTool(1, 'call-1')
    harness.renderer.display.setTranscript(
      [existing],
      undefined,
      undefined,
      [preview({ turn: 1, callId: 'call-bash', name: 'bash', argumentBytes: 23 })],
      undefined,
      retired,
    )
    await settle(120)
    assert.equal(wirePreparingRows(harness.output.text()).length, 1, 'the first subject shows its row')

    // The generation bump: the renderer shows the explicit Loading state and
    // fences the retired source.
    harness.renderer.display.beginSessionHydration()
    await settle(120)
    assert.ok(wireHasText(harness.output.text(), 'Loading session…'), 'the bump shows the explicit Loading state')
    assert.equal(wirePreparingRows(harness.output.text()).length, 0, 'the retired row is gone with the Loading state')

    // The RETIRED source repaints with its old Preparing rows: the fence drops
    // the frame entirely.
    const framesBeforeRetired = wireFrames(harness.output.text()).length
    harness.renderer.display.setTranscript(
      [existing],
      undefined,
      undefined,
      [preview({ turn: 1, callId: 'call-bash', name: 'bash', argumentBytes: 23 })],
      undefined,
      retired,
    )
    await settle(120)
    assert.equal(wireFrames(harness.output.text()).length, framesBeforeRetired,
      'the retired frame is DROPPED (no frame at all)')

    // A settled-answer lookup resolves DURING the hydration window: its
    // repaint must not resurrect the retired rows.
    harness.renderer.interaction.setSettledQuestionAnswersLookup(() => undefined)
    await settle(120)
    const wire = harness.output.text()
    assert.ok(wireHasText(wire, 'Loading session…'), 'Loading survives the settled-answer repaint')
    assert.equal(wirePreparingRows(wire).length, 0,
      'the retired Preparing row was not resurrected by the settled-answer repaint')

    // The new subject commits under a NEW source token: the normal display
    // resumes with its OWN preview.
    harness.renderer.display.setTranscript(
      [workTool(2, 'call-2')],
      undefined,
      undefined,
      [preview({ turn: 2, callId: 'call-read', name: 'read', argumentBytes: 12 })],
      undefined,
      { subject: 'B' },
    )
    await settle(120)
    const finalWire = harness.output.text()
    assert.ok(!wireHasText(finalWire, 'Loading session…'), 'the new subject lifts the Loading state')
    const rows = wirePreparingRows(finalWire)
    assert.equal(rows.length, 1, 'the new subject shows exactly its own row')
    assert.equal(rows[0]!.text, 'Preparing Read… · 12 B')
  } finally {
    await harness.dispose()
  }
})
