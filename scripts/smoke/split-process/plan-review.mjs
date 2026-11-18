/**
 * FR8 `interaction.plan-review`: the OFFICIAL `exit_plan_mode` review in a real
 * Split Host/Client pair.
 *
 * ONE real installed candidate Host (the C1 qualification fixture row) and TWO
 * real authenticated PTY Clients prove, on the SAME Host instance:
 *
 *   1. the Client creates its own Root Session from an ordinary prompt;
 *   2. the Client enters plan mode through the REAL `/plan` input, and the Host
 *      commits the official durable `plan/mode=true`;
 *   3. the next authored prompt (`FR8_PLAN_APPROVE`) makes the scripted Host
 *      model call the OFFICIAL `exit_plan_mode` tool, which asks through the
 *      official `userQuestions` waterfall — the Client's ONE Question seat
 *      renders it, the reading row shows the plan body (the real transcript card
 *      when it can be located, else the official question's own full-text
 *      fallback — both legitimate), `Esc` returns without answering, and the
 *      official Approve row settles it;
 *   4. the Host records the EXACT `tool/call` / `tool/result` (`approved:true`)
 *      and the durable `plan/mode=false` lands only AFTER that result, inside
 *      the next accepted pre-step;
 *   5. a SECOND, independent Client starts its OWN Session and proves the
 *      negative: a Keep-planning review leaves plan mode ACTIVE, returns the
 *      authored feedback through the official tool error, and writes no plan
 *      exit, while the following prompt runs as an ordinary turn.
 *
 * This case deliberately does NOT run the dismiss path: the plan allows the
 * Split negative to be Keep OR cancel, and the Direct mounted case already owns
 * the official `ASK_CANCELLED` dismiss proof. The fixture still supports a
 * `FR8_PLAN_DISMISS` marker, but no Split case consumes it.
 *
 * The fixture never writes a Session event by hand, never injects a synthetic
 * Question DTO and never creates a second Question/Plan authority.
 *
 * @module split-process/plan-review
 */

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import {
  hostSessionEvents,
  hostUserTexts,
  waitForHostSessionEvent,
  waitForHostSessionEventAfter,
} from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

const MARK_APPROVE = 'FR8_PLAN_APPROVE'
const MARK_KEEP = 'FR8_PLAN_KEEP'
const MARK_NEXT_STEP = 'FR8_PLAN_NEXT_STEP'
const PLAN_TAIL = 'FR8_PLAN_TAIL_END'

/**
 * Type one line into the proven-empty composer and press Enter.
 *
 * @param client the real PTY Client.
 * @param line the exact line to submit.
 * @param label the diagnostic scope for a failed submit.
 */
async function submitLine(client, line, label) {
  // A fresh Session may open with its seed draft still in the composer; clear
  // it through the real editor before probing the seat.
  client.send('\x15')
  const marker = `${label}-draft-probe`
  client.send(marker)
  try {
    await client.waitForComposerDraft(marker, 30_000)
  } catch (error) {
    const frame = await client.viewport().catch(() => [])
    throw new SplitSmokeAssertionError(`${label}: the composer never accepted a probe draft: ${JSON.stringify(frame.slice(-12))}`, { cause: error })
  }
  client.send('\x15') // clear the probe without submitting it
  // The composer always paints the mode hint (e.g. `Plan mode · describe the
  // task`), so an EMPTY-line heuristic is wrong: prove the probe text is gone
  // through the real editor, then type the line on that same live seat.
  client.send(line)
  try {
    await client.waitForComposerDraft(line, 30_000)
  } catch (error) {
    const frame = await client.viewport().catch(() => [])
    throw new SplitSmokeAssertionError(`${label}: the editor seat never held the submitted line: ${JSON.stringify(frame.slice(-12))}`, { cause: error })
  }
  client.send('\r')
}

/** The screen's painted text, or '' when the Client cannot read it yet. */
async function frameOf(client) {
  return (await client.viewport()).join('\n')
}

/** Wait for one painted needle in the real Client. */
async function waitForScreen(client, needle, label, timeoutMs = 60_000) {
  const needles = Array.isArray(needle) ? needle : [needle]
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const frame = await frameOf(client)
    if (needles.some(text => frame.includes(text))) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const frame = await frameOf(client).catch(() => '')
  throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: needles, frame: frame.split('\n').slice(-24) })}`)
}

/** One official `tool/call` event of the given name. */
function planCallOf(events, name = 'exit_plan_mode') {
  return events.find(event => event.type === 'tool/call' && event.data?.name === name)
}

/** The OFFICIAL `tool/result` of one exact call id. */
function resultOf(events, callId) {
  return events.find(event => event.type === 'tool/result' && event.data?.message?.toolCallId === callId)
}

/** The value of the LAST durable `plan/mode` event. */
function lastPlanMode(events) {
  return events.filter(event => event.type === 'plan/mode').at(-1)?.data?.active
}

/**
 * The `interaction.plan-review` case.
 *
 * @param context the runner context (workDir/dshHome/installation/trace…).
 * @returns `{ status: 'PASS' }` after every assertion held.
 */
export async function runPlanReview(context) {
  const { dshHome, trace } = context
  const scene = createC1Scene(context)
  try {
    const { host, ready: hostReady } = await scene.startC1Host('plan-review', 'FR8 plan-review Host')
    const hostFacts = await scene.hostIdentityFacts(host)
    assert(hostFacts.hostPid === hostReady.pid, 'FR8 the Host ready record does not own the Host identity')

    // ── Session A: the official approve path. ───────────────────────────────
    const { client } = await scene.startC1Client('FR8 plan-review Client')
    await scene.assertInteractionGate(client, 'FR8 Client')
    const sessionA = await scene.openC1Session(client, 'fr8-plan-review-open', 'FR8 plan-review Client A')
    await waitForHostSessionEvent(dshHome, sessionA, event => event.type === 'turn/end', 'FR8 Session A first turn end')

    // The REAL `/plan` input, not a seeded Session event.
    await submitLine(client, '/plan', 'FR8-A-plan')
    const entered = await waitForHostSessionEvent(dshHome, sessionA,
      event => event.type === 'plan/mode' && event.data?.active === true, 'FR8 official plan/mode=true')
    assert(entered !== undefined, 'FR8 Session A entered plan mode through the official command')
    trace('plan-review.entered', { sessionId: sessionA })

    await submitLine(client, `Present the plan ${MARK_APPROVE}`, 'FR8-A-approve-prompt')
    await waitForScreen(client, 'Plan review', 'FR8 Client A plan-review seat')
    const eventsAtSeat = hostSessionEvents(dshHome, sessionA)
    const callA = planCallOf(eventsAtSeat)
    assert(callA !== undefined, 'FR8 the official exit_plan_mode tool call is durable in Session A')
    assert(callA.data.arguments.includes(PLAN_TAIL), 'FR8 the reviewed plan body is the official call argument')

    // The FIRST row reads the plan. The real generated Client has no Host tool
    // registry: a provable transcript card yields the reading viewport, and an
    // unlocatable card legitimately falls back to the official question's own
    // full text (the frozen FR7 contract). Both are legitimate; the CARD was
    // still proven durable above. Esc returns WITHOUT answering.
    const beforeView = hostSessionEvents(dshHome, sessionA).length
    client.send('\r')
    await waitForScreen(client, ['Reading the submitted plan', 'Full review text'], 'FR8 Client A plan reading step')
    await waitForScreen(client, PLAN_TAIL, 'FR8 Client A plan body tail')
    client.send('\x1b')
    await waitForScreen(client, 'View plan', 'FR8 Client A back to the decision list')
    assert(resultOf(hostSessionEvents(dshHome, sessionA), callA.data.callId) === undefined,
      'FR8 reading and Esc settled no tool result')

    // ↓↓ to the official Approve row, Enter.
    client.send('\x1b[B')
    client.send('\x1b[B')
    await waitForScreen(client, '> Approve plan', 'FR8 Client A Approve row')
    client.send('\r')
    const approvedResult = await waitForHostSessionEventAfter(dshHome, sessionA, beforeView,
      event => event.type === 'tool/result' && event.data?.message?.toolCallId === callA.data.callId,
      'FR8 official approve tool result')
    assert(approvedResult.data.message.isError !== true, 'FR8 the approved review is not a tool error')
    const approvedText = (approvedResult.data.message.content ?? []).map(block => block.text ?? '').join('')
    assert(approvedText.includes('Plan approved'), `FR8 the official approve result: ${JSON.stringify(approvedText)}`)

    // The plan exit lands only in the NEXT accepted pre-step, AFTER the result.
    const eventsAfterApprove = hostSessionEvents(dshHome, sessionA)
    const resultIndex = eventsAfterApprove.findIndex(event =>
      event.type === 'tool/result' && event.data?.message?.toolCallId === callA.data.callId)
    const offIndex = eventsAfterApprove.findIndex((event, index) =>
      index > resultIndex && event.type === 'plan/mode' && event.data?.active === false)
    assert(resultIndex >= 0, 'FR8 the approve result is in the durable log')
    assert(offIndex > resultIndex, 'FR8 plan mode off is committed AFTER the approve result')
    assert(eventsAfterApprove.slice(resultIndex, offIndex).some(event => event.type === 'step/end'),
      'FR8 a step boundary separates the approve result from the mode write')
    assert(lastPlanMode(hostSessionEvents(dshHome, sessionA)) === false,
      'FR8 the LAST durable plan/mode of Session A is false')
    assert(hostSessionEvents(dshHome, sessionA).filter(event => event.type === 'tool/result').length === 1,
      'FR8 the reviewed call settled exactly once')
    // The user-visible settled state agrees with the durable facts.
    await waitForScreen(client, 'Plan approved', 'FR8 the approved tool result is painted')
    trace('plan-review.approved', { sessionId: sessionA, callId: callA.data.callId })

    // ── Session B: the Keep-planning negative in its OWN real Client. ─────
    // A second independent PTY Client starts a DIFFERENT Session on the SAME
    // Host. This avoids the in-process `/new` draft-restore race and is a
    // stronger Split proof (two authenticated surfaces, one Host).
    const { client: clientB } = await scene.startC1Client('FR8 plan-review Client B')
    const sessionB = await scene.openC1Session(clientB, 'fr8-plan-review-seed-b', 'FR8 plan-review Client B')
    assert(sessionB !== sessionA, 'FR8 Session B is an independent Session')
    await waitForHostSessionEvent(dshHome, sessionB, event => event.type === 'turn/end', 'FR8 Session B first turn end')
    await submitLine(clientB, '/plan', 'FR8-B-plan')
    await waitForHostSessionEvent(dshHome, sessionB,
      event => event.type === 'plan/mode' && event.data?.active === true, 'FR8 Session B plan/mode=true')

    await submitLine(clientB, `Present the plan for edits ${MARK_KEEP}`, 'FR8-B-keep-prompt')
    await waitForScreen(clientB, 'Plan review', 'FR8 Client A Session B decision seat')
    await waitForScreen(clientB, 'Keep planning…', 'FR8 Client A Session B Keep row')
    const callB = planCallOf(hostSessionEvents(dshHome, sessionB))
    assert(callB !== undefined, 'FR8 the official review call is durable in Session B')
    assert(callB.data.callId !== callA.data.callId, 'FR8 the two Sessions review DIFFERENT call ids')

    // ↓ then Enter opens the feedback step; Esc there is a local back.
    clientB.send('\x1b[B')
    clientB.send('\r')
    await waitForScreen(clientB, 'Request changes', 'FR8 Client A feedback step')
    clientB.send('\x1b')
    await waitForScreen(clientB, 'Keep planning…', 'FR8 Client A back from the feedback edit')
    assert(resultOf(hostSessionEvents(dshHome, sessionB), callB.data.callId) === undefined,
      'FR8 the feedback Esc settled no tool result')

    // Submit a CJK revision request through the real composer.
    // The Esc back kept the decision cursor on `Keep planning…`.
    clientB.send('\r')
    await waitForScreen(clientB, 'Request changes', 'FR8 Client A feedback step again')
    clientB.send('修改第 2 步')
    clientB.send('\r')
    const keepResult = await waitForHostSessionEvent(dshHome, sessionB,
      event => event.type === 'tool/result' && event.data?.message?.toolCallId === callB.data.callId,
      'FR8 official keep-planning tool result')
    const keepText = (keepResult.data.message.content ?? []).map(block => block.text ?? '').join('')
    assert(keepResult.data.message.isError === true, 'FR8 Keep planning is the official tool-error feedback path')
    assert(keepText.includes('修改第 2 步'), `FR8 the tool feedback returns the authored text: ${JSON.stringify(keepText)}`)
    assert(lastPlanMode(hostSessionEvents(dshHome, sessionB)) === true, 'FR8 Session B plan mode stays ACTIVE after Keep')
    assert(hostSessionEvents(dshHome, sessionB).filter(event => event.type === 'plan/mode' && event.data?.active === false).length === 0,
      'FR8 Session B wrote no plan exit of its own')
    trace('plan-review.kept', { sessionId: sessionB, callId: callB.data.callId })

    // The next prompt after the kept feedback is an ordinary turn.
    await submitLine(clientB, `Continue after the feedback ${MARK_NEXT_STEP}`, 'FR8-B-next-step')
    await waitForScreen(clientB, 'next-step answer', 'FR8 Session B next-step turn')
    const userTexts = hostUserTexts(hostSessionEvents(dshHome, sessionB))
    assert(userTexts.some(text => text.includes(MARK_KEEP)), 'FR8 the authored keep marker is the durable user prompt')
    trace('plan-review.next-step', { sessionId: sessionB })

    await scene.exitC1Client(client, 'FR8 plan-review Client')
    await scene.exitC1Client(clientB, 'FR8 plan-review Client B')
    await scene.stopC1Host(host)
    return { status: 'PASS' }
  } finally {
    await scene.dispose()
  }
}
