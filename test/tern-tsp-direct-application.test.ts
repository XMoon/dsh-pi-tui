/**
 * PR3-B B2: the OFFICIAL Direct application chain over the TSP pane.
 *
 * Unlike the scripted-pane suites (which run the real runner against stand-in
 * services), this suite mounts the rc.2 Host composition for real — REAL live
 * Agents from `mountAgentLoopTestHarness`, the real Direct SessionWriter, the
 * real SubmissionController and the real TSP renderer — with only the MODEL
 * scripted (a streaming `LlmAdapter`). The proof chain is therefore:
 *
 *     SDK key bytes → the TSP input loop → the composer → handlers.submit →
 *     ApplicationEvents.onSubmit → the REAL SubmissionController → the REAL
 *     Direct writer → a REAL Agent turn → the official assistant stream →
 *     the canonical fold → SDK frames
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-direct-application.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createDirectTspFixture, directSettle, waitFor } from './support/direct-tsp-fixture.ts'

/** The latest controlled editor text on the wire for `dock.composer`. */
function latestComposerText(wire: string): string | undefined {
  let text: string | undefined
  let seen = false
  for (const match of wire.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
    const frame = JSON.parse(match[1]!) as { ops: unknown[][] }
    for (const op of frame.ops) {
      if (op[0] === 'add') {
        const node = op[4] as { c?: Array<{ id?: string; p?: { text?: string } }> } | undefined
        const editor = node?.c?.find(child => child.id === 'dock.composer')
        if (editor?.p?.text !== undefined) text = editor.p.text
        seen = true
      } else if (op[0] === 'set' && op[1] === 'dock.composer' && (op[2] as { text?: string }).text !== undefined) {
        text = (op[2] as { text: string }).text
      } else if (op[0] === 'text' && op[1] === 'dock.composer') {
        text = op[2] === 'append' ? (text ?? '') + (op[3] as string) : (op[3] as string)
      }
    }
  }
  return seen ? text : undefined
}

test('B2/Direct-L6: a TSP Enter drives a REAL Agent turn and the streamed reply reaches the pane', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['DIRECT', '-L6', '-OK'] })
  // The exact-once witness: a ONE-TO-ONE recorder on the PRODUCTION-created
  // Direct session writer (the unbound prototype original; every call goes
  // through `original.call(this)` and the recorded outcome is the original's).
  const promptCalls: Array<{ readonly sessionId: string; readonly mode: 'queue' | 'steer'; readonly message: unknown; readonly agentStatus: string; readonly outcome: { readonly kind: string } }> = []
  const recorder = fixture.recordPrompts(call => { promptCalls.push(call) })
  try {
    await directSettle(3_000)
    await directSettle(2_000)
    fixture.pane.input.type('hello official direct')
    await directSettle()
    assert.equal(latestComposerText(fixture.pane.output.text()), 'hello official direct',
      'the draft is on the wire before the gesture')
    // NEGATIVE CONTROL: the scripted model's text is NOT on the wire before the
    // submit — so its later appearance is caused by the Enter, not by a
    // pre-seeded frame or a fixture that renders the script eagerly.
    assert.ok(!fixture.pane.output.text().includes('DIRECT-L6-OK'),
      'the assistant text is absent until the gesture is submitted')
    // NEGATIVE CONTROL (writer): no prompt was written before the gesture, so
    // the later `calls === 1` is caused by the Enter — never by a boot-time or
    // eager write. The mutation the review ran (ignore Enter at the input
    // boundary) leaves this array empty and FAILS the assertions below.
    assert.equal(recorder.calls(), 0, 'no prompt write happened before the gesture')
    fixture.pane.input.type('\r')
    // The submission's own PRODUCER facts — not a wire substring the composer
    // draft could already satisfy: wait for the write's SETTLED record (the
    // recorder counts settled writes only, so `calls() === 1` implies the
    // record exists), then assert on THAT record.
    await waitFor('the committed prompt write to SETTLE',
      () => recorder.calls() === 1 && promptCalls.length === 1, 30_000)
    const call = promptCalls[0]!
    assert.ok(JSON.stringify(call.message).includes('hello official direct'),
      'the settled record carries the submitted prepared message')
    assert.equal(call.outcome.kind, 'committed', 'the one write settled committed')
    assert.equal(call.mode, 'queue', 'an idle-start submission queues')
    assert.equal(call.agentStatus, 'running',
      'the write addressed the REAL live Agent (resolved through the production agentFor)')
    // The REAL Agent turn ran: the scripted model served exactly one request.
    await waitFor('the streamed assistant reply', () => fixture.pane.output.text().includes('DIRECT-L6-OK'), 30_000)
    assert.equal(fixture.modelCalls(), 1, 'exactly ONE real Agent turn ran')
    const wire = fixture.pane.output.text()
    assert.ok(wire.includes('DIRECT-L6-OK'),
      'the scripted model stream reached the canonical fold and the SDK pane')
    // Post-turn stability: no second write ever SETTLES (the exact-once fact
    // is a terminal state, not a race snapshot).
    await directSettle(2_000)
    assert.equal(recorder.calls(), 1, 'no further prompt write settled after the turn')
    assert.equal(promptCalls.length, 1, 'the settled-record array agrees (exactly one)')
    assert.equal(fixture.modelCalls(), 1, 'no further model turn happened either')
    recorder.detach()
  } finally {
    recorder.detach()
    await fixture.settle()
  }
})
