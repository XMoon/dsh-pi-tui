/**
 * M5-U-A: the REAL Host / two-PTY read-authority qualification.
 *
 * This case proves the ONE UI-neutral `SessionWorkspaceFactsPort` the backend
 * exposes, in the REAL split Client composition against the REAL Host:
 *
 *   UA-01/02  Client A shows Session Y and has NEVER retained Session X; the
 *             official passive read still reports X's Host running state and
 *             pending kind, while Y reports its own idle state.
 *   UA-03     X's real Host Question is read by A(Y) through the port BEFORE any
 *             answer; G567 navigation-first admission keeps A's modal OFF the Y
 *             editor, and A's existing first-settlement modal appears only
 *             after `/resume X` commits; it then settles the ONE Host request;
 *             B's stale modal is withdrawn and its late key is inert; A reads
 *             the durable result on X.
 *   UA-04     the symmetric real Approval: A reads `approval`, allows once, the
 *             Host Gateway settles exactly one `allowed-once`, B cannot
 *             re-decide.
 *   UA-05     a TIMED question times out to `continued`; A (never retaining X)
 *             reads the exact late-answer callId and drives the ONE official
 *             `userQuestions.answer` late-answer sink once; a repeat answer
 *             produces no second durable reply.
 *   UA-07     the official `workspace.follow` baseline and a REAL Session-create
 *             increment agree with the Host workspace membership.
 *   UA-09/10  the reads create no Host write and no second owner; a REAL mux
 *             rollover (SIGUSR1) yields a new generation whose read still works.
 *
 * Every fact comes from the mounted Backend port through a qualification-only
 * probe (`SPLIT_PROCESS_CLIENT_READ_AUTHORITY_PROOF`), never a private RPC,
 * second Client or local store. This module creates no Host fixture service.
 *
 * @module split-process/read-authority
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import {
  alive,
  lastSurfaceStatus,
  waitForSurfaceStatus,
} from '../../lib/split-smoke-processes.mjs'
import {
  hostSessionEvents,
  waitForHostSessionEvent,
  waitForHostSessionEventAfter,
} from '../../lib/split-smoke-sessions.mjs'
import { createDualSurfaceSceneTools } from './dual-surface-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** The plain text of one durable/inbox message (bounded, never a payload dump). */
const textOf = message => (message?.content ?? [])
  .map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
  .join('')

/** Run the U-A read-authority qualification on this installation. */
export async function runReadAuthority(context) {
  const { workDir, dshHome, trace } = context
  const tools = createDualSurfaceSceneTools(context)
  const { scene, exitC1Client, stopC1Host, submitPrompt, resumeSession } = tools

  // ── The ONE qualification probe (no product surface) ──────────────────────
  const requestPath = join(workDir, 'ua-read-authority-request.json')
  let probeSequence = 0
  /** Write ONE request and signal the Client's ONE read-authority probe. */
  const signalProbe = (client, request) => {
    const nonce = `ua-${String(++probeSequence)}`
    writeFileSync(requestPath, JSON.stringify({ nonce, ...request }), { mode: 0o600 })
    client.signalBusiness('SIGUSR2')
    return nonce
  }
  /** Wait for one record of THIS probe request (phase-addressable). */
  const waitProbe = (client, nonce, predicate, label, timeoutMs = 120_000) =>
    client.waitFor(record => record.m4b2s === 'qualification'
      && record.op === 'read-authority-proof'
      && record.nonce === nonce
      && predicate(record), label, timeoutMs)
  /** One read op; returns the facts record. */
  const readFacts = async (client, label) => {
    const nonce = signalProbe(client, { op: 'read' })
    const record = await waitProbe(client, nonce, candidate => candidate.phase === 'facts', label)
    return record
  }
  /** Poll the REAL port read until one fact satisfies the predicate. The
   *  continued projection settles a moment after the timed tool result, so the
   *  authoritative read (not a Host fixture helper) is the readiness signal. */
  const readFactsUntil = async (client, predicate, label, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      last = await readFacts(client, label)
      if (predicate(last)) return last
      await sleep(1_000)
    }
    throw new SplitSmokeAssertionError(
      `${label}: the port read never satisfied the predicate; last=${JSON.stringify(last?.facts)}`)
  }

  /** The U-A scene always carries the ONE read-authority probe env. */
  const startDualSurfaceScene = (scenario, label, extraHostEnv = {}, options = {}) =>
    tools.startDualSurfaceScene(scenario, label, extraHostEnv, {
      ...options,
      clientEnv: {
        SPLIT_PROCESS_CLIENT_READ_AUTHORITY_PROOF: requestPath,
        ...options.clientEnv,
      },
    })

  /** The ONE row/fact for a Session id, with a diagnosable failure. */
  const factOf = (record, sessionId, label) => {
    const fact = (record.facts ?? []).find(entry => entry.sessionId === sessionId)
    assert(fact !== undefined, `${label}: no fact for Session ${sessionId} in ${JSON.stringify(record.facts)}`)
    return fact
  }
  const rowOf = (record, sessionId, label) => {
    const row = (record.rows ?? []).find(entry => entry.id === sessionId)
    assert(row !== undefined, `${label}: the listed roster has no row for the target Session`)
    return row
  }
  /** A read-only op must not add ONE Host session event (UA-09). */
  const assertNoHostWrite = (sessionId, before, label) => {
    const after = (hostSessionEvents(dshHome, sessionId) ?? []).length
    assert(after === before,
      `${label}: the read-authority probe wrote ${String(after - before)} Host session event(s)`)
  }

  try {
    // ── UA-01/02/03: A(Y) reads X's real Question, then the existing modal
    //    settles the ONE Host request and A re-enters X through old `/resume`.
    {
      const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX, sessionY } =
        await startDualSurfaceScene('question', 'ua-question')
      const triggerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
      await submitPrompt(clientB, 'm5c-question-trigger', 'UA question trigger')
      const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
        'UA question tool/call', 120_000)
      assert(typeof call.data.callId === 'string' && call.data.callId !== '',
        'UA the question tool/call carries no callId')
      const callId = call.data.callId
      await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-request' && event.sessionId === sessionX,
        'UA Host question request', 120_000)
      // B owns Session X and paints the answerable modal. A owns Session Y:
      // PR-G567 navigation-first admission must keep X's modal OFF A's Y
      // editor even though the same forwarded Host waterfall reached A's root.
      await clientB.waitForScreen('[1] Proceed', 'UA B question modal', 120_000)
      await sleep(1_000)
      assert(!(await clientA.viewport()).join('\n').includes('[1] Proceed'),
        'UA-03 A painted X\'s question modal while its committed Session was Y')
      assert(!readC1WorkEvents(workRoot).some(event => event.kind === 'question-settled'),
        'UA-03 a modal presentation settled the Host question before any answer')
      assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY,
        'UA Client A stopped showing Session Y before the read')
      const writesBefore = (hostSessionEvents(dshHome, sessionX) ?? []).length
      // UA-01/02: A shows Y, has never retained X, and still reads X's Host
      // running/pending facts plus Y's own independent idle state.
      const read = await readFacts(clientA, 'UA A read of pending X')
      assert(read.phase === 'facts', `UA the read probe failed: ${JSON.stringify(read)}`)
      assert(read.openSessionId === sessionY && read.sessionOpen === true,
        'UA the read probe ran when Client A no longer showed Session Y')
      const rowX = rowOf(read, sessionX, 'UA X row')
      assert((rowX.retainedBy?.tuiMainView ?? 0) === 0,
        `UA Client A retained Session X at read time: ${JSON.stringify(rowX.retainedBy)}`)
      const factX = factOf(read, sessionX, 'UA X fact')
      assert(factX.attention === 'question', `UA X attention was ${JSON.stringify(factX.attention)}`)
      assert(factX.attentionSourceState === 'known',
        `UA X attention source was ${JSON.stringify(factX.attentionSourceState)}`)
      assert(factX.running === true, `UA X running was ${JSON.stringify(factX.running)}`)
      assert(Array.isArray(factX.pendingKinds) && factX.pendingKinds.includes('question'),
        `UA X pending kinds were ${JSON.stringify(factX.pendingKinds)}`)
      assert(rowX.live === false, 'UA the Remote list row was not conservatively detached (`live:false`)')
      const factY = factOf(read, sessionY, 'UA Y fact')
      assert(factY.running === false, `UA Y running was ${JSON.stringify(factY.running)} (idle Session)`)
      assert(factY.attention === 'none', `UA Y attention was ${JSON.stringify(factY.attention)}`)
      // The caller's roster is the only corpus; a subagent child never enters.
      assert((read.rows ?? []).every(row => row.origin !== 'subagent' && row.origin === undefined),
        'UA the two-Client scene unexpectedly listed a subagent child')
      assertNoHostWrite(sessionX, writesBefore, 'UA read of X')
      // Re-read AFTER the sample: no retained reference and no second owner.
      const readAgain = await readFacts(clientA, 'UA A read after the first sample')
      assert((rowOf(readAgain, sessionX, 'UA X row (second read)').retainedBy?.tuiMainView ?? 0) === 0,
        'UA the read itself retained Session X')
      assert(readAgain.generationId === read.generationId,
        `UA the read changed the Connection generation (${String(read.generationId)} -> ${String(readAgain.generationId)})`)
      assert(readAgain.sessionOpen === true && readAgain.openSessionId === sessionY,
        'UA a read moved Client A off Session Y')

      // UA-03: G567 navigation-first — A re-enters X through the OLD
      // `/resume` path FIRST; only the committed X editor receives the SAME
      // live request's modal, whose answer then travels back through the Host's
      // own forwarded-event correlation.
      const navigateIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
      await resumeSession(clientA, sessionX, 'UA A /resume X before the answer')
      assert((hostSessionEvents(dshHome, sessionX) ?? []).slice(navigateIndex)
        .every(event => event.type !== 'tool/result' && event.type !== 'turn/end'),
      'UA-03 navigating to X settled the Host question')
      await clientA.waitForScreen('[1] Proceed', 'UA A question modal after the X commit', 120_000)
      const answerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
      clientA.send('1')
      await clientA.waitForScreen('Review your answer before submit', 'UA A question review', 30_000)
      clientA.send('\r')
      const settled = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-settled' && event.sessionId === sessionX,
        'UA Host question settled', 120_000)
      assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
        `UA the Host received the wrong answer: ${JSON.stringify(settled.answers)}`)
      const result = await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
        event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
        'UA question tool result', 120_000)
      assert(result.data?.message?.isError !== true, 'UA the answered question failed at the Host')
      await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
        event => event.type === 'turn/end', 'UA question turn/end', 120_000)
      // B lost the SAME Host delivery: its modal is withdrawn and its late key
      // cannot produce a second Host decision.
      await clientB.waitForScreenGone('[1] Proceed', 'UA B question modal withdrawn', 120_000)
      const lateIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
      clientB.send('2')
      await sleep(300)
      clientB.send('\x15')
      await sleep(300)
      assert(!(await clientB.viewport()).join('\n').includes('[1] Proceed'),
        'UA a late loser option key reopened the settled question modal')
      assert((hostSessionEvents(dshHome, sessionX) ?? []).slice(lateIndex)
        .every(event => event.type !== 'tool/call' && event.type !== 'tool/result'
          && event.type !== 'turn/start' && event.type !== 'turn/end'),
      'UA a late loser key produced Host activity')
      // A re-enters X through the OLD navigation path and reads the durable
      // settlement (the U-A read never had to open X to classify it).
      await resumeSession(clientA, sessionX, 'UA A /resume X')
      assert(lastSurfaceStatus(clientA)?.transport === 'connected',
        'UA Client A lost the transport while resuming X')
      await clientA.waitForScreen('question answered', 'UA A read X\'s durable answer', 120_000)
      const readAfterResume = await readFacts(clientA, 'UA A read of the resumed X')
      const factAfter = factOf(readAfterResume, sessionX, 'UA X fact after resume')
      assert(factAfter.pendingKinds !== undefined && !factAfter.pendingKinds.includes('question'),
        'UA the settled question still reports a pending question')
      assert(factAfter.attention !== 'question',
        `UA the settled question still reports attention ${JSON.stringify(factAfter.attention)}`)
      for (const [side, ready] of [['A', aReady], ['B', bReady]]) {
        assert(alive(ready.pid), `UA Client ${side} died during the question first settlement`)
      }
      assert(alive(hostBefore.hostPid), 'UA the Host died during the question first settlement')
      const finalEvents = hostSessionEvents(dshHome, sessionX) ?? []
      assert(finalEvents.filter(event => event.type === 'tool/result'
        && String(event.data?.message?.toolCallId) === callId).length === 1,
      'UA the question produced a second Host result')
      const finalProofs = readC1WorkEvents(workRoot)
      assert(finalProofs.filter(event => event.kind === 'question-request' && event.sessionId === sessionX).length === 1
        && finalProofs.filter(event => event.kind === 'question-settled' && event.sessionId === sessionX).length === 1,
      'UA the Host question request/settlement pair was not exactly one')
      await exitC1Client(clientB, 'UA question B')
      await exitC1Client(clientA, 'UA question A')
      await stopC1Host(host)
      assert(host.exited === true && host.exitResult?.code === 0 && host.exitResult?.signal === null,
        `UA the question Host did not shut down normally: ${JSON.stringify(host.exitResult)}`)
      trace('ua-01-03', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        sessionY,
        sessionX,
        questionCallId: callId,
        aRetainedXAtRead: 0,
        aAttention: factX.attention,
        hostSettlements: 1,
        loserWithdrawn: true,
      })
    }

    // ── UA-04: the symmetric real Approval from A(Y), settled by A.
    {
      const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX, sessionY } =
        await startDualSurfaceScene('approval-allow', 'ua-approval')
      const triggerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
      await submitPrompt(clientB, 'm5c-approval-reject-trigger', 'UA approval trigger')
      const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'tool/call' && event.data?.name === 'bash',
        'UA approval bash tool/call', 120_000)
      assert(typeof call.data.callId === 'string' && call.data.callId !== '',
        'UA the bash tool/call carries no callId')
      const toolCallId = call.data.callId
      const asked = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'approval/asked', 'UA approval/asked', 120_000)
      assert(typeof asked.data.id === 'string' && asked.data.id !== '',
        'UA the Host approval request carries no ApprovalRequestId')
      const requestId = asked.data.id
      await waitForC1WorkEvent(workRoot,
        event => event.kind === 'approval-request' && event.sessionId === sessionX,
        'UA Host approval request', 120_000)
      await clientB.waitForScreen('[y] Allow once', 'UA B approval sheet', 120_000)
      await sleep(1_000)
      assert(!(await clientA.viewport()).join('\n').includes('[y] Allow once'),
        'UA-04 A painted X\'s approval sheet while its committed Session was Y')
      assert(!(hostSessionEvents(dshHome, sessionX) ?? []).some(event => event.type === 'approval/decided'),
        'UA-04 a presentation decided the Host approval before any answer')
      assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY,
        'UA Client A stopped showing Session Y before the approval read')
      const writesBefore = (hostSessionEvents(dshHome, sessionX) ?? []).length
      const read = await readFacts(clientA, 'UA A read of pending approval X')
      const rowX = rowOf(read, sessionX, 'UA approval X row')
      assert((rowX.retainedBy?.tuiMainView ?? 0) === 0,
        `UA Client A retained Session X at approval read time: ${JSON.stringify(rowX.retainedBy)}`)
      const factX = factOf(read, sessionX, 'UA approval X fact')
      assert(factX.attention === 'approval', `UA X approval attention was ${JSON.stringify(factX.attention)}`)
      assert(factX.attentionSourceState === 'known',
        `UA X approval source was ${JSON.stringify(factX.attentionSourceState)}`)
      assert(Array.isArray(factX.pendingKinds) && factX.pendingKinds.includes('approval'),
        `UA X approval pending kinds were ${JSON.stringify(factX.pendingKinds)}`)
      assertNoHostWrite(sessionX, writesBefore, 'UA read of approval X')
      // G567 navigation-first: A commits X first; the SAME live approval then
      // mounts on X and allows once through the SAME existing ApprovalSheet.
      const navigateIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
      await resumeSession(clientA, sessionX, 'UA A /resume X before the approval decision')
      assert((hostSessionEvents(dshHome, sessionX) ?? []).slice(navigateIndex)
        .every(event => event.type !== 'approval/decided' && event.type !== 'tool/result'),
      'UA-04 navigating to X decided the Host approval')
      await clientA.waitForScreen('[y] Allow once', 'UA A approval sheet after the X commit', 120_000)
      const decideIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
      clientA.send('y')
      const decided = await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
        event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
        'UA approval/decided', 120_000)
      assert(decided.data.outcome === 'allowed-once',
        `UA the first Host approval outcome was ${JSON.stringify(decided.data.outcome)}`)
      const settlement = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'approval-settled' && event.outcome === 'allowed-once',
        'UA allowed-once settlement', 60_000)
      assert(String(settlement.callId) === toolCallId,
        'UA the allowed settlement names another tool call')
      await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
        event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolCallId,
        'UA approval tool/result', 120_000)
      await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
        event => event.type === 'turn/end', 'UA approval turn/end', 120_000)
      assert(existsSync(join(workRoot, 'approval-allow.marker')),
        'UA the ALLOWED harmless command never executed')
      await clientB.waitForScreen('approval settled', 'UA B read the Host settlement', 120_000)
      await clientB.waitForScreenGone('[y] Allow once', 'UA B approval sheet withdrawn', 120_000)
      // B's late reject key must not re-decide the settled Host request.
      clientB.send('n')
      await sleep(300)
      clientB.send('\x15')
      await sleep(300)
      const decisions = (hostSessionEvents(dshHome, sessionX) ?? [])
        .filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId)
      assert(decisions.length === 1 && decisions[0].data.outcome === 'allowed-once',
        'UA the late loser key produced a second/changed Host approval decision')
      // A is already on X (the navigation-first commit above); the durable
      // settlement is read from that SAME committed Session.
      await resumeSession(clientA, sessionX, 'UA A already on X after the approval')
      await clientA.waitForScreen('approval settled', 'UA A read the Host settlement after resuming X', 120_000)
      const readAfterResume = await readFacts(clientA, 'UA A read of the resumed approval X')
      const factAfter = factOf(readAfterResume, sessionX, 'UA approval fact after resume')
      assert(factAfter.pendingKinds !== undefined && !factAfter.pendingKinds.includes('approval'),
        'UA the settled approval still reports a pending approval')
      for (const [side, ready] of [['A', aReady], ['B', bReady]]) {
        assert(alive(ready.pid), `UA Client ${side} died during the approval first settlement`)
      }
      assert(alive(hostBefore.hostPid), 'UA the Host died during the approval first settlement')
      await exitC1Client(clientB, 'UA approval B')
      await exitC1Client(clientA, 'UA approval A')
      await stopC1Host(host)
      assert(host.exited === true && host.exitResult?.code === 0 && host.exitResult?.signal === null,
        `UA the approval Host did not shut down normally: ${JSON.stringify(host.exitResult)}`)
      trace('ua-04', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        sessionY,
        sessionX,
        approvalRequestId: requestId,
        hostOutcome: decided.data.outcome,
        decisions: decisions.length,
        aAttention: factX.attention,
      })
    }

    // ── UA-05: a TIMED question becomes `continued`; A reads the exact
    //    late-answer callId and drives the ONE official answer sink once.
    {
      const holdBarrier = join(workDir, 'ua-timed-question.release')
      const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX, sessionY } =
        await startDualSurfaceScene('question', 'ua-timed', {
          C1_TIMED_QUESTION: '1',
          // The preset row must be in the official TIMED mode; the fixture arg
          // alone leaves `tool-ask-user` in its legacy blocking mode.
          SPLIT_PROCESS_EXTRA_PATCH: scene.c1Work.timedPatchPath,
          C1_HOLD_AFTER_TIMED: holdBarrier,
        })
      const triggerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
      await submitPrompt(clientB, 'm5c-question-trigger', 'UA timed question trigger')
      const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
        'UA timed question tool/call', 120_000)
      const callId = call.data.callId
      assert(typeof callId === 'string' && callId !== '', 'UA the timed question tool/call carries no callId')
      // The Client-owned 1s foreground window times out; the official
      // ASK_TIMED_OUT rejection writes the pending tool result and moves the
      // durable projection to `continued`.
      await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-failed' && event.sessionId === sessionX,
        'UA timed foreground ended', 120_000)
      await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
        'UA timed question result', 120_000)
      await waitForC1WorkEvent(workRoot,
        event => event.kind === 'after-timed-held' && event.sessionId === sessionX,
        'UA timed question held after continued', 120_000)
      // A (on Y, never retaining X) reads the exact continued candidate from
      // the REAL port once the timed projection settles.
      const read = await readFactsUntil(clientA, record => {
        const fact = (record.facts ?? []).find(entry => entry.sessionId === sessionX)
        return fact !== undefined
          && Array.isArray(fact.continuedQuestionCallIds)
          && fact.continuedQuestionCallIds.includes(callId)
      }, 'UA A read of continued X')
      assert(read.openSessionId === sessionY, 'UA Client A left Session Y before the continued read')
      const rowX = rowOf(read, sessionX, 'UA continued X row')
      assert((rowX.retainedBy?.tuiMainView ?? 0) === 0,
        `UA Client A retained Session X at continued read time: ${JSON.stringify(rowX.retainedBy)}`)
      const factX = factOf(read, sessionX, 'UA continued X fact')
      assert(Array.isArray(factX.continuedQuestionCallIds) && factX.continuedQuestionCallIds.includes(callId),
        `UA the continued callId was not read: ${JSON.stringify(factX.continuedQuestionCallIds)}`)
      assert(factX.attention === 'question',
        `UA the continued question attention was ${JSON.stringify(factX.attention)}`)
      assert(factX.attentionSourceState === 'known',
        `UA the continued question source was ${JSON.stringify(factX.attentionSourceState)}`)
      assert(Array.isArray(factX.pendingKinds) && !factX.pendingKinds.includes('question'),
        `UA the timed-out question still reports a Gateway pending: ${JSON.stringify(factX.pendingKinds)}`)
      // The ONE official late-answer sink: A's answer is queued into X's inbox
      // even though A never retained X.
      const answerNonce = signalProbe(clientA, {
        op: 'answer-continued',
        sessionId: sessionX,
        callId,
        answers: { answers: [{ id: 'c1-question', selected: ['Proceed'] }] },
      })
      const answerRecord = await waitProbe(clientA, answerNonce,
        record => record.phase === 'continued-answer' || record.phase === 'failed',
        'UA continued answer')
      assert(answerRecord.phase === 'continued-answer' && answerRecord.outcome === 'queued',
        `UA the late answer was not queued: ${JSON.stringify(answerRecord)}`)
      // The queued reply is now in the binding's inbox while the timed call is
      // still `continued`: a fresh port read must WITHDRAW the answerable
      // candidate instead of presenting the same call as needs-attention.
      const suppressed = await readFactsUntil(clientA, record => {
        const fact = (record.facts ?? []).find(entry => entry.sessionId === sessionX)
        return fact !== undefined
          && Array.isArray(fact.continuedQuestionCallIds)
          && !fact.continuedQuestionCallIds.includes(callId)
      }, 'UA queued reply suppresses the continued candidate', 20_000)
      const suppressedFact = factOf(suppressed, sessionX, 'UA queued suppression fact')
      assert(suppressedFact.attention !== 'question' && suppressedFact.attention !== 'plan-review',
        `UA a queued reply still reported attention ${JSON.stringify(suppressedFact.attention)}`)
      // Release the held turn: the queued reply is claimed as a durable
      // `user-question-reply` message exactly once.
      writeFileSync(holdBarrier, 'release\n', { mode: 0o600 })
      const reply = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'user/message'
          && event.data?.source?.kind === 'user-question-reply'
          && String(event.data?.source?.callId) === callId,
        'UA durable continued reply', 120_000)
      assert(textOf(reply.data).includes('Proceed'),
        'UA the durable late reply lost the user answer')
      // A repeat answer of the SAME callId is not a second pending fact and must
      // not write a second durable reply.
      const replyIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
      const repeatNonce = signalProbe(clientA, {
        op: 'answer-continued',
        sessionId: sessionX,
        callId,
        answers: { answers: [{ id: 'c1-question', selected: ['Proceed'] }] },
      })
      const repeat = await waitProbe(clientA, repeatNonce,
        record => record.phase === 'continued-answer' || record.phase === 'failed',
        'UA repeated continued answer')
      const repeatRejected = repeat.phase === 'failed'
        || (repeat.phase === 'continued-answer' && repeat.outcome === 'not-continued')
      assert(repeatRejected,
        `UA a repeated late answer was accepted again: ${JSON.stringify(repeat)}`)
      await sleep(500)
      const replies = (hostSessionEvents(dshHome, sessionX) ?? []).slice(replyIndex)
        .filter(event => event.type === 'user/message'
          && event.data?.source?.kind === 'user-question-reply'
          && String(event.data?.source?.callId) === callId)
      assert(replies.length === 0, 'UA the repeated late answer wrote a second durable reply')
      for (const [side, ready] of [['A', aReady], ['B', bReady]]) {
        assert(alive(ready.pid), `UA Client ${side} died during the continued-answer proof`)
      }
      assert(alive(hostBefore.hostPid), 'UA the Host died during the continued-answer proof')
      // The retained Client B may hold the continued late-answer form after the
      // timed window; a SIGTERM proves the same clean Client exit without
      // relying on a composer command that the form would consume.
      for (const [side, client] of [['B', clientB], ['A', clientA]]) {
        client.signalBusiness('SIGTERM')
        const exit = await client.waitForExit(60_000)
        assert(exit.code === 0 && exit.signal === null,
          `UA timed Client ${side} exit was ${JSON.stringify(exit)}`)
        await client.dispose()
      }
      await stopC1Host(host)
      assert(host.exited === true && host.exitResult?.code === 0 && host.exitResult?.signal === null,
        `UA the timed-question Host did not shut down normally: ${JSON.stringify(host.exitResult)}`)
      trace('ua-05', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        sessionY,
        sessionX,
        continuedCallId: callId,
        readWithoutRetain: true,
        lateAnswerQueued: true,
        duplicateReply: false,
      })
    }

    // ── UA-07/09/10: the official Workspace follow baseline + a REAL Session
    //    create increment, then a real mux rollover and a fresh-generation read.
    {
      // B gets its OWN launch directory, HOME and PATH: the Workspace identity
      // a Client reads must still be the Host's, never its own filesystem.
      const bCwd = join(workDir, 'ua-b-client-cwd')
      const bHome = join(workDir, 'ua-b-home')
      for (const dir of [bCwd, bHome]) mkdirSync(dir, { recursive: true, mode: 0o700 })
      const { host, hostBefore, clientA, clientB, aReady, bReady, sessionY } =
        await startDualSurfaceScene('question', 'ua-workspaces', {}, {
          openB: false,
          bCwd,
          bEnv: { HOME: bHome, PATH: `${bCwd}:${process.env.PATH ?? ''}` },
        })
      // B is admitted but sessionless: it proposes no Workspace of its own, and
      // its different launch environment must not become a membership fact.
      // The stream must stay OPEN across the whole membership sequence: the
      // `/new` create happens after the second client's baseline probe, and a
      // slow shared-lane run must not let the window expire (or a frame budget
      // run out on an unrelated Workspace change) before the increment frame.
      const baselineNonce = signalProbe(clientA, { op: 'workspaces', windowMs: 90_000, maxFrames: 32 })
      await waitProbe(clientA, baselineNonce, record => record.phase === 'workspaces-open',
        'UA workspaces stream opened', 30_000)
      const baseline = await waitProbe(clientA, baselineNonce,
        record => record.phase === 'workspaces-frame' && record.type === 'baseline',
        'UA workspaces baseline', 30_000)
      const items = baseline.items ?? []
      assert(items.length >= 1, 'UA the Host Workspace baseline carried no Workspace')
      const member = items.find(item => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionY))
      assert(member !== undefined,
        `UA A's Session Y is not in the Host Workspace baseline: ${JSON.stringify(items)}`)
      assert(typeof member.workspaceId === 'string' && member.workspaceId !== ''
        && typeof member.path === 'string' && typeof member.title === 'string',
      'UA a Workspace baseline row is missing its Host identity/path/title')
      // B (different cwd/HOME/PATH) reads the SAME Host Workspace identity for
      // the same Session; its own launch directory is never the answer.
      const bNonce = signalProbe(clientB, { op: 'workspaces', windowMs: 15_000, maxFrames: 1 })
      const bBaseline = await waitProbe(clientB, bNonce,
        record => record.phase === 'workspaces-frame' && record.type === 'baseline',
        'UA B workspaces baseline', 30_000)
      const bMember = (bBaseline.items ?? []).find(item =>
        Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionY))
      assert(bMember !== undefined,
        `UA B (different cwd/HOME/PATH) did not see Y's Host Workspace: ${JSON.stringify(bBaseline.items)}`)
      assert(bMember.workspaceId === member.workspaceId && bMember.path === member.path
        && bMember.title === member.title, 'UA the two Clients disagreed about the Host Workspace identity')
      assert(bMember.path !== bCwd,
        `UA the Workspace path fell back to the Client launch directory (${JSON.stringify(bMember.path)})`)
      await waitProbe(clientB, bNonce, record => record.phase === 'workspaces-ended',
        'UA B workspaces stream ended', 30_000)
      // A real Session create changes the Host Workspace membership; the
      // per-open stream must forward that increment.
      const createIndex = (hostSessionEvents(dshHome, sessionY) ?? []).length
      await submitPrompt(clientA, '/new', 'UA workspaces A /new')
      const aSecond = await waitForSurfaceStatus(clientA,
        record => record.sessionOpen === true && typeof record.openSessionId === 'string'
          && record.openSessionId !== sessionY,
        'UA A created Session X',
        120_000)
      const sessionX = aSecond.openSessionId
      const upsert = await waitProbe(clientA, baselineNonce,
        record => record.phase === 'workspaces-frame'
          && (record.type === 'upsert' || record.type === 'replace')
          && JSON.stringify(record).includes(sessionX),
        'UA workspaces membership increment', 120_000)
      if (upsert.type === 'upsert') {
        assert(upsert.workspace.workspaceId === member.workspaceId,
          `UA the Session-create increment named another Workspace: ${JSON.stringify(upsert.workspace)}`)
        assert(upsert.workspace.sessionIds.includes(sessionX),
          'UA the increment does not carry the created Session X membership')
      } else {
        const updated = upsert.items.find(item => item.workspaceId === member.workspaceId)
        assert(updated !== undefined && updated.sessionIds.includes(sessionX),
          'UA the full Workspace replacement does not carry the created Session X membership')
      }
      // The A stream closes at its OWN window (90s): the ended wait must outlast
      // it, and the window must outlast the whole membership sequence (the B
      // probe plus the `/new` create).
      await waitProbe(clientA, baselineNonce, record => record.phase === 'workspaces-ended',
        'UA workspaces stream ended', 150_000)
      assert((hostSessionEvents(dshHome, sessionY) ?? []).length >= createIndex,
        'UA the Host Session log lost events during the Workspace observation')
      // A REAL mux rollover: the next read runs on the NEW generation.
      const beforeReconnect = lastSurfaceStatus(clientA)
      assert(beforeReconnect?.transport === 'connected' && typeof beforeReconnect.generationId === 'number',
        'UA Client A had no connected generation before the rollover')
      clientA.signalBusiness('SIGUSR1')
      const reconnected = await waitForSurfaceStatus(clientA,
        record => record.transport === 'connected'
          && typeof record.generationId === 'number'
          && record.generationId !== beforeReconnect.generationId,
        'UA Client A reconnected on a new generation',
        120_000)
      const afterReconnect = await readFacts(clientA, 'UA A read after the real reconnect')
      assert(afterReconnect.phase === 'facts', `UA the post-reconnect read failed: ${JSON.stringify(afterReconnect)}`)
      assert(afterReconnect.generationId === reconnected.generationId,
        `UA the post-reconnect read ran on generation ${String(afterReconnect.generationId)} instead of ${String(reconnected.generationId)}`)
      const factAfterReconnect = factOf(afterReconnect, sessionX, 'UA post-reconnect X fact')
      assert(factAfterReconnect.attentionSourceState !== undefined,
        'UA the post-reconnect read published no fact state')
      for (const [side, ready] of [['A', aReady], ['B', bReady]]) {
        assert(alive(ready.pid), `UA Client ${side} died during the Workspace/reconnect proof`)
      }
      assert(alive(hostBefore.hostPid), 'UA the Host died during the Workspace/reconnect proof')
      await exitC1Client(clientB, 'UA workspaces B')
      await exitC1Client(clientA, 'UA workspaces A')
      await stopC1Host(host)
      assert(host.exited === true && host.exitResult?.code === 0 && host.exitResult?.signal === null,
        `UA the Workspace Host did not shut down normally: ${JSON.stringify(host.exitResult)}`)
      trace('ua-07-10', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        workspaceId: member.workspaceId,
        workspaceIncrement: upsert.type,
        sessionY,
        sessionX,
        generationBefore: beforeReconnect.generationId,
        generationAfter: reconnected.generationId,
      })
    }
  } finally {
    await scene.dispose()
  }
}
