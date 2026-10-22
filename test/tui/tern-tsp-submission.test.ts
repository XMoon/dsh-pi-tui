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
import {
  connect as sdkConnect,
  concatBytes,
  type Op,
  type TermInput,
  type TermOutput,
  type WireNode,
} from '@stencil-hq/tern'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'

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

// ── PR-B2 L6: the production mount projects the real PTC subtree ──────────
//
// The chain under test is the production application composition, not a
// mapper-only spike: a real `TranscriptFolder` folds genuine PTC events, and
// the fold's messages are committed through the REAL mounted `mountTspRenderer`
// display seam into the shipped SDK surface. The child tool node and its later
// settle are asserted on the actual wire (`f` frames), so this is source→sink
// evidence for the nested native children; it is not a mapper-only claim.

interface SubmissionWireFrame {
  readonly sf: string
  readonly s: number
  readonly ops: readonly Op[]
}

function decodeWireFrames(wire: string): SubmissionWireFrame[] {
  return [...wire.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)].map(match => JSON.parse(match[1]!) as SubmissionWireFrame)
}

function flattenWireNode(node: WireNode, out: WireNode[] = []): WireNode[] {
  out.push(node)
  for (const child of node.c ?? []) flattenWireNode(child, out)
  return out
}

/** Every node the wire has ever ADDED (the current tree's node set). */
function wireNodes(wire: string): WireNode[] {
  const nodes: WireNode[] = []
  for (const frame of decodeWireFrames(wire)) {
    for (const op of frame.ops) {
      if (op[0] === 'add') flattenWireNode(op[4], nodes)
    }
  }
  return nodes
}

/** The repository's ordinary loose event envelope for fixtures. */
function sEvent(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 1_700_000_000_000 + seq, data } as SessionEvent
}

function ptcStartEvent(
  seq: number, root: string, sub: string, name: string, args: Record<string, unknown>,
): SessionEvent {
  return sEvent('tool/ptc-dispatch-start', {
    rootCallId: ToolCallId(root),
    parentCallId: ToolCallId(root),
    subCallId: ToolCallId(sub),
    name,
    arguments: args,
  }, seq)
}

function ptcSettleEvent(
  seq: number, root: string, sub: string, name: string, args: Record<string, unknown>, text: string,
): SessionEvent {
  return sEvent('tool/ptc-dispatch', {
    rootCallId: ToolCallId(root),
    parentCallId: ToolCallId(root),
    subCallId: ToolCallId(sub),
    name,
    arguments: args,
    isError: false,
    content: [{ type: 'text', text }],
  }, seq)
}

function rootCallEvent(seq: number, id: string, args: Record<string, unknown>): SessionEvent {
  return sEvent('tool/call', {
    turn: 1,
    step: 0,
    callId: ToolCallId(id),
    name: 'run_code',
    arguments: JSON.stringify(args),
  }, seq)
}

function rootResultEvent(seq: number, id: string, text: string): SessionEvent {
  return sEvent('tool/result', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId(`result-${id}`),
      role: 'tool',
      toolCallId: ToolCallId(id),
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId: ToolCallId(id) },
    },
  }, seq)
}

test('B2-L6: the mounted renderer emits PTC child tools and settles them on the real wire', async () => {
  const readArgs = { file_path: 'src/a.ts' }
  const turnStart = sEvent('turn/start', { turn: 1 }, 0)
  const folder = new TranscriptFolder()
  folder.apply([
    turnStart,
    rootCallEvent(1, 'code-1', { code: 'print(1)', description: 'Inspect project and run tests' }),
    ptcStartEvent(2, 'code-1', 'code-1:code:1', 'read', readArgs),
    rootResultEvent(3, 'code-1', 'program output'),
  ])

  const harness = await mountPane(() => {})
  try {
    // ONE stable projection-source token: the production renderer re-scopes its
    // presentation keys on a NEW source identity, so the same subject must pass
    // the SAME object (exactly as `SurfaceRuntime.repaintTarget` does).
    const source = { subject: 'ptc-A' }
    harness.renderer.display.setTranscript(folder.messages(), undefined, undefined, undefined, undefined, source)
    await awaitFact(
      () => wireNodes(harness.output.text()).some(node => node.id.endsWith('.sub-code-1:code:1')),
      'the PTC child tool node to reach the real wire',
    )

    const initialNodes = wireNodes(harness.output.text())
    const child = initialNodes.find(node => node.id.endsWith('.sub-code-1:code:1'))
    assert.ok(child !== undefined, 'the nested child tool node is on the wire')
    const childId = child.id
    const rootId = childId.slice(0, -'.sub-code-1:code:1'.length)
    assert.equal(child.k, 'tool', 'the child is a native tool node')
    assert.equal(child.p?.['frame'], 'inline')
    assert.equal(child.p?.['title'], 'Read')
    assert.equal(child.p?.['target'], 'src/a.ts')
    assert.equal(child.p?.['status'], 'running')
    assert.equal(initialNodes.find(node => node.id === `${rootId}.child-head`)?.p?.['text'], 'Child calls · 1')
    assert.equal(initialNodes.find(node => node.id === rootId)?.p?.['status'], 'done',
      'the root keeps its own settled status')

    // The REAL child settle enters through the same fold + production seam.
    folder.apply([ptcSettleEvent(4, 'code-1', 'code-1:code:1', 'read', readArgs, 'file.txt')])
    harness.renderer.display.setTranscript(folder.messages(), undefined, undefined, undefined, undefined, source)
    await awaitFact(
      () => decodeWireFrames(harness.output.text()).some(frame => frame.ops.some(op =>
        op[0] === 'set' && op[1] === childId && (op[2] as { status?: string }).status === 'done')),
      'the child settle to reach the real wire',
    )

    const frames = decodeWireFrames(harness.output.text())
    const last = frames[frames.length - 1]!
    const settleOp = last.ops.find(op => op[0] === 'set' && op[1] === childId)
    assert.ok(settleOp !== undefined && (settleOp[2] as { status?: string }).status === 'done',
      'the settle updates the SAME child node id, never a remount')
    assert.equal(last.ops.filter(op => op[0] === 'del').length, 0, 'the child settle deletes nothing')
    assert.equal(last.ops.filter(op => op[0] === 'move').length, 0, 'the child settle moves nothing')
    const added = last.ops.flatMap(op => op[0] === 'add' ? flattenWireNode(op[4]) : [])
    const resultNode = added.find(node => node.id === `${childId}.result`)
    assert.equal(resultNode?.p?.['text'], 'file.txt', 'the complete child result reaches the wire')
    assert.equal(resultNode?.p?.['wrap'], true)
    assert.equal(last.ops.some(op => op[0] === 'set' && op[1] === rootId), false,
      'the child settle never rewrites the root card')
    assert.equal(wireNodes(harness.output.text()).filter(node => node.id === childId).length, 1,
      'the child node was added exactly once — no remount across the settle')
  } finally {
    await harness.dispose()
  }
})
