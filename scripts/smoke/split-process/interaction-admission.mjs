/**
 * PR-G567 / M5-U-D gate: navigation-first forwarded interaction admission.
 *
 * One REAL Host + two genuine PiTUI Clients, each on its own `script(1)` PTY.
 * The forward direction (Q1/A1: A(Y) never paints X's modal, then re-enters X
 * and answers the SAME live Host request) is proven by the updated
 * `read.official-read-authority` UA-03/UA-04 scenes. THIS case owns the
 * inverse and loser paths that the old behavior could not satisfy:
 *
 *   Q2  A(X) shows the real question modal -> Alt+W (presentation-only hold,
 *       one existing Session Workspace) -> A(Y) -> back to X -> the SAME
 *       official callId is re-offered and answered exactly once.
 *   A2  the symmetric real Approval: same inverse navigation, one `allowed`
 *       decision, the harmless marker command executes once.
 *   N1  B answers while A is inside the navigation hold: A's old modal never
 *       resurrects, A never produces a second Host result, and the ONE Host
 *       settlement is B's.
 *
 * The proof is the real Host event stream / work fixture / two surface PIDs /
 * PTY frames. No private RPC, no second listing, no fake Peer.
 *
 * @module split-process/interaction-admission
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { alive, lastSurfaceStatus, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { hostSessionEvents, waitForHostSessionEventAfter } from '../../lib/split-smoke-sessions.mjs'
import { createDualSurfaceSceneTools } from './dual-surface-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** The panel's identity-first short id (the row label for an untitled Session). */
const shortSessionId = id => id.replace(/^session[-_]/i, '').slice(0, 8)

/** Run the navigation-first interaction admission qualification. */
export async function runInteractionNavigationFirst(context) {
  const { dshHome, trace } = context
  const tools = createDualSurfaceSceneTools(context)
  const { exitC1Client, stopC1Host, submitPrompt, resumeSession, startDualSurfaceScene } = tools

  const eventsOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []
  const settledCount = (workRoot, sessionId, kind) => readC1WorkEvents(workRoot)
    .filter(event => event.kind === `${kind}-settled` && event.sessionId === sessionId).length
  const toolResults = (sessionId, callId) => eventsOf(sessionId)
    .filter(event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId)
  const approvalDecisions = (sessionId, requestId) => eventsOf(sessionId)
    .filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId)

  /**
   * Focus the FIRST search result through the panel's two-Enter contract: the
   * first Enter only moves focus to results, so it is retried until the painted
   * `> <shortId>` marker proves the focus moved. A second Enter is NEVER sent
   * before that proof (it would resume the row prematurely).
   */
  const focusFirstSearchResult = async (client, sessionId, label) => {
    const marker = `> ${shortSessionId(sessionId)}`
    for (let attempt = 0; attempt < 6; attempt += 1) {
      client.send('\r')
      for (let poll = 0; poll < 20; poll += 1) {
        if ((await client.viewport()).join('\n').includes(marker)) return
        await sleep(50)
      }
      await sleep(500)
    }
    throw new SplitSmokeAssertionError(`${label}: the search result never took focus (${marker})`)
  }

  /** Alt+W from the live modal and stop in the workspace (no navigation). */
  const enterNavigationHold = async (client, label) => {
    client.send('\x1bw')
    await client.waitForScreen('Workspace: Current workspace', `${label} workspace opened`, 30_000)
    await client.waitForScreenGone('[1] Proceed', `${label} modal withdrawn for the hold`, 30_000)
  }

  /** A real process exit while the navigation hold owns the presentation. */
  const terminateClient = async (client, pid, label) => {
    client.signalBusiness('SIGTERM')
    const exit = await client.waitForExit(60_000)
    assert(exit.code === 0 && exit.signal === null, `${label} exit was ${JSON.stringify(exit)}`)
    for (let poll = 0; poll < 150 && alive(pid); poll += 1) await sleep(100)
    assert(!alive(pid), `${label} process survived its SIGTERM`)
    await client.dispose()
  }

  /**
   * Alt+W from the live modal, then search the OTHER Session by its exact id
   * and resume it through the workspace's two-Enter contract. Returns after
   * the real Session switch committed.
   */
  const holdAndNavigateTo = async (client, targetSessionId, label) => {
    client.send('\x1bw')
    await client.waitForScreen('Workspace: Current workspace', `${label} workspace opened`, 30_000)
    client.send('/')
    await client.waitForScreen('Search all workspaces', `${label} search entered`, 15_000)
    client.send(targetSessionId)
    await focusFirstSearchResult(client, targetSessionId, `${label} result focused`)
    client.send('\r')
    await waitForSurfaceStatus(client,
      record => record.sessionOpen === true && record.openSessionId === targetSessionId,
      `${label} committed ${targetSessionId}`,
      60_000)
    // The workspace closed with the committed switch; the new Session must not
    // paint the old request's modal.
    await sleep(1_000)
    assert(!(await client.viewport()).join('\n').includes('[1] Proceed')
      && !(await client.viewport()).join('\n').includes('[y] Allow once'),
    `${label} painted the held modal on the target Session`)
  }

  try {
    // ── Q2: A(X) modal -> Alt+W -> Y -> X -> answer the SAME request ────────
    {
      const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX, sessionY } =
        await startDualSurfaceScene('question', 'g567-q-inverse')
      await resumeSession(clientA, sessionX, 'G567-Q2 A resume X')
      const triggerIndex = eventsOf(sessionX).length
      await submitPrompt(clientB, 'm5c-question-trigger', 'G567-Q2 question trigger')
      const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
        'G567-Q2 question tool/call', 120_000)
      const callId = call.data.callId
      assert(typeof callId === 'string' && callId !== '', 'G567-Q2 the question tool/call carries no callId')
      await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-request' && event.sessionId === sessionX,
        'G567-Q2 Host question request', 120_000)
      await clientA.waitForScreen('[1] Proceed', 'G567-Q2 A question modal', 120_000)
      await clientB.waitForScreen('[1] Proceed', 'G567-Q2 B question modal', 120_000)

      await holdAndNavigateTo(clientA, sessionY, 'G567-Q2 A')
      // The hold/navigation is NOT an answer: no settlement, no result.
      assert(settledCount(workRoot, sessionX, 'question') === 0,
        'G567-Q2 leaving X produced a Host question settlement')
      assert(toolResults(sessionX, callId).length === 0,
        'G567-Q2 leaving X produced a Host tool result')
      assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY,
        'G567-Q2 A did not commit Session Y')

      // A returns to X: the SAME official invocation is re-offered, then the
      // real keyboard answer is the ONE Host settlement.
      await resumeSession(clientA, sessionX, 'G567-Q2 A resume X back')
      await clientA.waitForScreen('[1] Proceed', 'G567-Q2 question re-offered on X', 120_000)
      const answerIndex = eventsOf(sessionX).length
      clientA.send('1')
      await clientA.waitForScreen('Review your answer before submit', 'G567-Q2 A answer review', 30_000)
      clientA.send('\r')
      const settled = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-settled' && event.sessionId === sessionX,
        'G567-Q2 Host question settled', 120_000)
      assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
        `G567-Q2 the Host received ${JSON.stringify(settled.answers)} instead of Proceed`)
      const result = await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
        event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
        'G567-Q2 question tool result', 120_000)
      assert(result.data?.message?.isError !== true, 'G567-Q2 the answered question failed at the Host')
      assert(settledCount(workRoot, sessionX, 'question') === 1 && toolResults(sessionX, callId).length === 1,
        'G567-Q2 the navigation/answer produced more than one Host settlement')
      await clientB.waitForScreenGone('[1] Proceed', 'G567-Q2 B lost the one delivery', 120_000)
      for (const [side, ready] of [['A', aReady], ['B', bReady]]) {
        assert(alive(ready.pid), `G567-Q2 Client ${side} died during the inverse navigation`)
      }
      assert(alive(hostBefore.hostPid), 'G567-Q2 the Host died during the inverse navigation')
      trace('g567-q2', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        sessionX,
        sessionY,
        questionCallId: callId,
        hostSettlements: 1,
        navigatedThroughWorkspace: true,
      })
      await exitC1Client(clientB, 'G567-Q2 B')
      await exitC1Client(clientA, 'G567-Q2 A')
      await stopC1Host(host)
    }

    // ── A2: the symmetric inverse Approval ──────────────────────────────────
    {
      const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX, sessionY } =
        await startDualSurfaceScene('approval-allow', 'g567-a-inverse')
      await resumeSession(clientA, sessionX, 'G567-A2 A resume X')
      const triggerIndex = eventsOf(sessionX).length
      await submitPrompt(clientB, 'm5c-approval-reject-trigger', 'G567-A2 approval trigger')
      const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'tool/call' && event.data?.name === 'bash',
        'G567-A2 approval bash tool/call', 120_000)
      const toolCallId = call.data.callId
      const asked = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'approval/asked', 'G567-A2 approval/asked', 120_000)
      const requestId = asked.data.id
      assert(typeof requestId === 'string' && requestId !== '',
        'G567-A2 the Host approval request carries no ApprovalRequestId')
      await clientA.waitForScreen('[y] Allow once', 'G567-A2 A approval sheet', 120_000)
      await clientB.waitForScreen('[y] Allow once', 'G567-A2 B approval sheet', 120_000)

      await holdAndNavigateTo(clientA, sessionY, 'G567-A2 A')
      assert(approvalDecisions(sessionX, requestId).length === 0,
        'G567-A2 leaving X decided the Host approval')
      assert(toolResults(sessionX, toolCallId).length === 0,
        'G567-A2 leaving X produced a Host tool result')
      assert(!existsSync(join(workRoot, 'approval-allow.marker')),
        'G567-A2 the approved command ran before the human decision')

      await resumeSession(clientA, sessionX, 'G567-A2 A resume X back')
      await clientA.waitForScreen('[y] Allow once', 'G567-A2 approval re-offered on X', 120_000)
      const decideIndex = eventsOf(sessionX).length
      clientA.send('y')
      const decided = await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
        event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
        'G567-A2 approval/decided', 120_000)
      assert(decided.data.outcome === 'allowed-once',
        `G567-A2 the first Host approval outcome was ${JSON.stringify(decided.data.outcome)}`)
      await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
        event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolCallId,
        'G567-A2 approval tool/result', 120_000)
      assert(approvalDecisions(sessionX, requestId).length === 1,
        'G567-A2 the inverse navigation produced more than one Host approval decision')
      assert(existsSync(join(workRoot, 'approval-allow.marker')),
        'G567-A2 the ALLOWED harmless command never executed')
      for (const [side, ready] of [['A', aReady], ['B', bReady]]) {
        assert(alive(ready.pid), `G567-A2 Client ${side} died during the inverse approval`)
      }
      assert(alive(hostBefore.hostPid), 'G567-A2 the Host died during the inverse approval')
      trace('g567-a2', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        sessionX,
        sessionY,
        approvalRequestId: requestId,
        hostOutcome: decided.data.outcome,
        decisions: 1,
      })
      await exitC1Client(clientB, 'G567-A2 B')
      await exitC1Client(clientA, 'G567-A2 A')
      await stopC1Host(host)
    }

    // ── N1: B wins while A is inside the navigation hold ────────────────────
    {
      const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX, sessionY } =
        await startDualSurfaceScene('question', 'g567-loser')
      await resumeSession(clientA, sessionX, 'G567-N1 A resume X')
      const triggerIndex = eventsOf(sessionX).length
      await submitPrompt(clientB, 'm5c-question-trigger', 'G567-N1 question trigger')
      const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
        'G567-N1 question tool/call', 120_000)
      const callId = call.data.callId
      await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-request' && event.sessionId === sessionX,
        'G567-N1 Host question request', 120_000)
      await clientA.waitForScreen('[1] Proceed', 'G567-N1 A question modal', 120_000)
      await clientB.waitForScreen('[1] Proceed', 'G567-N1 B question modal', 120_000)

      // A enters the presentation-only hold (workspace) and B answers while A
      // is still navigating: the SAME Host request is settled exactly once.
      await holdAndNavigateTo(clientA, sessionY, 'G567-N1 A')
      const answerIndex = eventsOf(sessionX).length
      clientB.send('1')
      await clientB.waitForScreen('Review your answer before submit', 'G567-N1 B answer review', 30_000)
      clientB.send('\r')
      const settled = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-settled' && event.sessionId === sessionX,
        'G567-N1 Host question settled by B', 120_000)
      assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
        `G567-N1 the Host received ${JSON.stringify(settled.answers)} instead of Proceed`)
      await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
        event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
        'G567-N1 question tool result', 120_000)
      // A returns to X after B's win: the settled request must never reappear
      // as an answerable modal nor produce a second result.
      await resumeSession(clientA, sessionX, 'G567-N1 A returns to X')
      await sleep(1_500)
      const viewport = (await clientA.viewport()).join('\n')
      assert(!viewport.includes('[1] Proceed'),
        'G567-N1 A resurrected the already-settled question on returning to X')
      assert(settledCount(workRoot, sessionX, 'question') === 1 && toolResults(sessionX, callId).length === 1,
        'G567-N1 B\'s win plus A\'s close produced more than one Host settlement')
      for (const [side, ready] of [['A', aReady], ['B', bReady]]) {
        assert(alive(ready.pid), `G567-N1 Client ${side} died`)
      }
      assert(alive(hostBefore.hostPid), 'G567-N1 the Host died')
      trace('g567-n1', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        sessionX,
        sessionY,
        questionCallId: callId,
        winner: 'B',
        loserModalResurrected: false,
        hostSettlements: 1,
      })
      await exitC1Client(clientB, 'G567-N1 B')
      await exitC1Client(clientA, 'G567-N1 A')
      await stopC1Host(host)
    }

    // ── N2a: a real Client process exit during the navigation hold ──────────
    {
      const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX, sessionY } =
        await startDualSurfaceScene('question', 'g567-root-dispose')
      await resumeSession(clientA, sessionX, 'G567-N2a A resume X')
      const triggerIndex = eventsOf(sessionX).length
      await submitPrompt(clientB, 'm5c-question-trigger', 'G567-N2a question trigger')
      const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
        'G567-N2a question tool/call', 120_000)
      const callId = call.data.callId
      await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-request' && event.sessionId === sessionX,
        'G567-N2a Host question request', 120_000)
      await clientA.waitForScreen('[1] Proceed', 'G567-N2a A question modal', 120_000)
      await clientB.waitForScreen('[1] Proceed', 'G567-N2a B question modal', 120_000)

      // A commits the presentation-only hold, then its REAL process exits
      // inside the workspace. That teardown must not settle the Host request.
      await enterNavigationHold(clientA, 'G567-N2a A')
      const exitIndex = eventsOf(sessionX).length
      await terminateClient(clientA, aReady.pid, 'G567-N2a A')
      await sleep(1_000)
      assert(readC1WorkEvents(workRoot).every(event =>
        event.kind !== 'question-settled' && event.kind !== 'question-failed'),
      'G567-N2a A\'s process exit settled or cancelled the Host question')
      assert(eventsOf(sessionX).slice(exitIndex)
        .every(event => event.type !== 'tool/result' && event.type !== 'turn/end'),
      'G567-N2a A\'s process exit produced Host result activity')
      // B still owns the SAME pending delivery and gives the ONE answer.
      await clientB.waitForScreen('[1] Proceed', 'G567-N2a B still paints the answerable modal', 60_000)
      const answerIndex = eventsOf(sessionX).length
      clientB.send('1')
      await clientB.waitForScreen('Review your answer before submit', 'G567-N2a B answer review', 30_000)
      clientB.send('\r')
      const settled = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-settled' && event.sessionId === sessionX,
        'G567-N2a Host question settled by B', 120_000)
      assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
        `G567-N2a the Host received ${JSON.stringify(settled.answers)} instead of Proceed`)
      await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
        event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
        'G567-N2a question tool result', 120_000)
      assert(settledCount(workRoot, sessionX, 'question') === 1 && toolResults(sessionX, callId).length === 1,
        'G567-N2a the process exit plus B\'s answer produced more than one Host settlement')
      assert(alive(bReady.pid) && alive(hostBefore.hostPid), 'G567-N2a A\'s exit killed B or the Host')
      trace('g567-n2a', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        sessionX,
        sessionY,
        questionCallId: callId,
        aExitedInHold: true,
        hostSettlements: 1,
        settledBy: 'B',
      })
      await exitC1Client(clientB, 'G567-N2a B')
      await stopC1Host(host)
    }

    // ── N2-b: the OFFICIAL request is cancelled while A holds it in the
    //    navigation hold. The withdrawn hold must never re-present or answer
    //    the dead request; B/C2 or the Host keeps the ONE settlement.
    {
      const cancelBarrier = join(context.workDir, 'g567-n2b-cancel.release')
      const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX, sessionY } =
        await startDualSurfaceScene('approval-allow', 'g567-official-abort', { C1_CANCEL_AGENT: cancelBarrier })
      await resumeSession(clientA, sessionX, 'G567-N2b A resume X')
      const triggerIndex = eventsOf(sessionX).length
      await submitPrompt(clientB, 'm5c-approval-reject-trigger', 'G567-N2b approval trigger')
      const asked = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'approval/asked', 'G567-N2b approval/asked', 120_000)
      const requestId = String(asked.data.id)
      await clientA.waitForScreen('[y] Allow once', 'G567-N2b A approval sheet', 120_000)
      // A suspends the live sheet for navigation (hold + workspace, still on X).
      clientA.send('\x1bw')
      await clientA.waitForScreen('Workspace: Current workspace', 'G567-N2b workspace opened', 30_000)
      await clientA.waitForScreenGone('[y] Allow once', 'G567-N2b sheet withdrawn for the hold', 30_000)
      // The OFFICIAL Host Agent cancel aborts the pending request while A is
      // inside the hold: not a Client exit, the request lifetime itself ends.
      writeFileSync(cancelBarrier, 'cancel\n', { mode: 0o600 })
      await waitForC1WorkEvent(workRoot, event => event.kind === 'agent-cancel-requested', 'G567-N2b Host Agent cancel', 60_000)
      const decided = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
        'G567-N2b approval/decided (cancelled)', 120_000)
      assert(decided.data.outcome === 'cancelled',
        `G567-N2b unexpected Host abort taxonomy: ${JSON.stringify(decided.data.outcome)}`)
      // Close the workspace and return to X: the dead request must NOT come
      // back as an answerable sheet, and A's stale key must not decide again.
      clientA.send('\x1b')
      await waitForSurfaceStatus(clientA,
        record => record.sessionOpen === true && record.openSessionId === sessionX,
        'G567-N2b A back on X',
        60_000)
      await sleep(1_500)
      clientA.send('y')
      await sleep(1_000)
      assert(!(await clientA.viewport()).join('\n').includes('[y] Allow once'),
        'G567-N2b the aborted approval resurrected as an answerable sheet')
      assert(approvalDecisions(sessionX, requestId).length === 1,
        'G567-N2b the aborted request was decided twice')
      assert(!existsSync(join(workRoot, 'approval-allow.marker')),
        'G567-N2b a stale key executed the command after the official abort')
      // The stale `y` landed in the editor after the sheet was withdrawn; clear
      // it so the normal `/exit` below is still a command (the T55b lesson).
      clientA.send('\x15')
      await sleep(300)
      for (const [side, ready] of [['A', aReady], ['B', bReady]]) {
        assert(alive(ready.pid), `G567-N2b Client ${side} died`)
      }
      assert(alive(hostBefore.hostPid), 'G567-N2b the Host died')
      trace('g567-n2b', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        sessionX,
        sessionY,
        approvalRequestId: requestId,
        abortedDuringHold: true,
        hostOutcome: decided.data.outcome,
        decisions: 1,
        resurrected: false,
      })
      await exitC1Client(clientB, 'G567-N2b B')
      await exitC1Client(clientA, 'G567-N2b A')
      await stopC1Host(host)
    }

    // ── N3-a: A switches to Y, THEN the old X presenter callback would run.
    //    A(Y) shows no answerable X UI and cannot submit the old answer.
    {
      const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX, sessionY } =
        await startDualSurfaceScene('question', 'g567-stale-scope')
      await resumeSession(clientA, sessionX, 'G567-N3a A resume X')
      const triggerIndex = eventsOf(sessionX).length
      await submitPrompt(clientB, 'm5c-question-trigger', 'G567-N3a question trigger')
      const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
        'G567-N3a question tool/call', 120_000)
      const callId = call.data.callId
      await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-request' && event.sessionId === sessionX,
        'G567-N3a Host question request', 120_000)
      await clientA.waitForScreen('[1] Proceed', 'G567-N3a A question modal on X', 120_000)
      // A suspends for navigation and COMMITS a real switch to Y while the
      // request stays live the whole time.
      await holdAndNavigateTo(clientA, sessionY, 'G567-N3a A')
      const staleIndex = eventsOf(sessionX).length
      // The stale option key arrives while A shows Y. It must remain plain
      // editor input — NOT an answer to the still-live X request, and never a
      // submitted prompt on Y either (a submitted Y prompt would start Y's own
      // first-turn question, which is a different request, not this proof).
      // Enter is deliberately NOT sent: with no modal on Y it would submit a
      // new prompt, which is legal editor behavior and not this negative.
      clientA.send('1')
      await sleep(1_500)
      assert(!(await clientA.viewport()).join('\n').includes('[1] Proceed'),
        'G567-N3a A(Y) painted the stale X question as answerable')
      // The stale digit stayed a draft on Y (no new Y turn, no new request).
      await clientA.waitForComposerDraft('1', 8_000)
      clientA.send('\x15')
      assert(settledCount(workRoot, sessionX, 'question') === 0,
        'G567-N3a the stale option key settled the still-live Host question')
      assert(readC1WorkEvents(workRoot)
        .every(event => !(event.kind === 'question-request' && event.sessionId === sessionY)),
        'G567-N3a the stale option key started a new Y request')
      assert(eventsOf(sessionX).slice(staleIndex)
        .every(event => event.type !== 'tool/result' && event.type !== 'turn/end'),
      'G567-N3a the stale answer keys produced Host result activity')
      assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY,
        'G567-N3a A did not stay on Y')
      // B still owns the SAME live delivery and gives the ONE answer.
      await clientB.waitForScreen('[1] Proceed', 'G567-N3a B still paints the answerable modal', 60_000)
      const answerIndex = eventsOf(sessionX).length
      clientB.send('1')
      await clientB.waitForScreen('Review your answer before submit', 'G567-N3a B answer review', 30_000)
      clientB.send('\r')
      const settled = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-settled' && event.sessionId === sessionX,
        'G567-N3a Host question settled by B', 120_000)
      assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
        `G567-N3a the Host received ${JSON.stringify(settled.answers)} instead of Proceed`)
      await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
        event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
        'G567-N3a question tool result', 120_000)
      assert(settledCount(workRoot, sessionX, 'question') === 1 && toolResults(sessionX, callId).length === 1,
        'G567-N3a the stale keys plus B\'s answer produced more than one Host settlement')
      // The LATE half: B's settlement happens while A still shows Y. Any stale
      // presenter callback for the already-settled X request arriving at A
      // after that point must neither re-present an answerable form nor write
      // a second result. Waiting on the REAL Host settlement event is the
      // observable late-completion; A re-reads its own surface afterwards.
      const lateIndex = eventsOf(sessionX).length
      await sleep(2_000)
      const viewportLate = (await clientA.viewport()).join('\n')
      assert(!viewportLate.includes('[1] Proceed'),
        'G567-N3a a late presenter callback re-presented the settled X question on A(Y)')
      assert(eventsOf(sessionX).slice(lateIndex)
        .every(event => event.type !== 'tool/result' && event.type !== 'turn/start'),
      'G567-N3a a late presenter callback produced new Host activity on X')
      assert(settledCount(workRoot, sessionX, 'question') === 1,
        'G567-N3a a late presenter callback wrote a second settlement')
      // A returns to X AFTER the settlement: the settled request must not
      // reappear as answerable there either.
      await resumeSession(clientA, sessionX, 'G567-N3a A returns to X after settlement')
      await sleep(1_500)
      assert(!(await clientA.viewport()).join('\n').includes('[1] Proceed'),
        'G567-N3a returning to X resurrected the settled question as answerable')
      // Clear A's editor of the stale keys so /exit remains a command.
      clientA.send('\x15')
      for (const [side, ready] of [['A', aReady], ['B', bReady]]) {
        assert(alive(ready.pid), `G567-N3a Client ${side} died`)
      }
      assert(alive(hostBefore.hostPid), 'G567-N3a the Host died')
      trace('g567-n3a', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        sessionX,
        sessionY,
        questionCallId: callId,
        staleKeysSettled: false,
        settledBy: 'B',
        hostSettlements: 1,
      })
      await exitC1Client(clientB, 'G567-N3a B')
      await exitC1Client(clientA, 'G567-N3a A')
      await stopC1Host(host)
    }
  } finally {
    await tools.scene.dispose()
  }
}
