/**
 * M6 PR-C C4: the per-Turn prompt / multi-client session-view parity scene
 * (`prompt.session-focus-turn-parity`).
 *
 * Two REAL authenticated Client OS processes on ONE Host Session X, plus a
 * separate Session S2 and a fresh third Client Peer, drive the deterministic
 * A=Focus / B=Full / A-exits choreography while the Host holds real Turns.
 * The sink is the ACTUAL model-facing prompt: the deterministic local
 * Provider records the system text facts of every model request it serves
 * (`SPLIT_PROCESS_PROMPT_EVIDENCE`), so a section the model never received
 * cannot pass here.
 *
 * What the scene pins (and what a wrong implementation fails):
 *
 * - B submits while A views X in Focus: the Turn carries the Focus policy —
 *   any current Focus viewer wins, and B's Full view never dilutes it. A
 *   shared-Profile `displayPreset` or submitting-Client-local implementation
 *   fails this row.
 * - A toggles Focus off its own surface and exits MID-TURN: the open Turn
 *   KEEPS the Focus policy through its later steps (the per-Turn snapshot is
 *   frozen at `turn/start`), while B's next Turn after `turn/end` is the
 *   ordinary non-Focus policy. A re-evaluating-per-step implementation fails
 *   the frozen row; a sticky-Focus implementation fails the next-Turn row.
 * - B queues and steers while a Turn runs: the queued occurrence moves into
 *   the running Turn as a later step, and that step's request carries the
 *   SAME frozen policy.
 * - Session switch: a Turn on S2 (Full-only viewer) carries no Focus policy.
 * - Reconnect identity: a fresh authenticated Peer (Client C) re-opens X,
 *   becomes the only viewer and makes its Turn Focus again — the retired
 *   Peer's record never votes again. The Host identity survives every Client
 *   exit (Host survival).
 *
 * @module split-process/prompt-session-focus-turn-parity
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { alive, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { waitForHostSessionEvent, waitForHostSessionEventAfter } from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** Parse the recorded model-request prompt facts (one JSON row per request). */
function readRows(path) {
  const text = readFileSync(path, 'utf8').trim()
  return text === '' ? [] : text.split('\n').map(line => JSON.parse(line))
}

/** Run the per-Turn prompt parity scene on this installation. */
export async function runPromptSessionFocusTurnParity(context) {
  const { workDir, dshHome, trace, failpoint } = context
  const scene = createC1Scene(context)
  const {
    startC1Host,
    stopC1Host,
    startC1Client,
    exitC1Client,
    openC1Session,
    hostIdentityFacts,
    assertHostIdentityKept,
  } = scene
  const evidencePath = join(workDir, 'prompt-parity-evidence.jsonl')
  writeFileSync(evidencePath, '', { mode: 0o600 })
  /** Wait until at least `count` model requests were recorded, then return all rows. */
  const waitForRows = async (count, label) => {
    const deadline = Date.now() + 120_000
    for (;;) {
      const rows = readRows(evidencePath)
      if (rows.length >= count) return rows
      if (Date.now() > deadline) {
        throw new SplitSmokeAssertionError(`${label}: only ${String(rows.length)} prompt-evidence row(s), expected >= ${String(count)}`)
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 200))
    }
  }
  const assertRow = (row, expected, label) => {
    for (const [key, value] of Object.entries(expected)) {
      assert(row[key] === value,
        `${label}: prompt fact ${key} was ${JSON.stringify(row[key])}, expected ${JSON.stringify(value)}`)
    }
  }
  try {
    const releaseBarrier = join(workDir, 'prompt-parity.release')
    const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'prompt-parity', {
      C1_HOLD_LONG_TURN: releaseBarrier,
      SPLIT_PROCESS_PROMPT_EVIDENCE: evidencePath,
    })
    const hostBefore = await hostIdentityFacts(host)
    assert(hostBefore.hostPid === hostReady.pid, 'the Host ready record does not own the Host identity')
    failpoint('prompt.session-focus-turn-parity.after-host-spawn')

    // ---- Phase 1 (Session X): A=Focus, B=Full; B queues + steers while the
    // Turn runs; A exits mid-Turn; the Turn keeps Focus, the next does not.
    const { client: clientA, ready: aReady } = await startC1Client('PP A')
    clientA.send('/display focus\r')
    await clientA.waitForScreen('Display: focus.', 'PP A applied the Focus display preset', 60_000)
    const sessionX = await openC1Session(clientA, 'pp-a-seed', 'PP A')
    await waitForC1WorkEvent(workRoot,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionX,
      'PP held first Turn')
    await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'PP first turn/start')
    const { client: clientB, ready: bReady } = await startC1Client('PP B', {
      SPLIT_PROCESS_CLIENT_SESSION: sessionX,
    })
    const bOpen = await waitForSurfaceStatus(clientB,
      record => record.sessionOpen === true && record.openSessionId === sessionX
        && record.transport === 'connected' && record.surfaceMounted === true,
      'PP B retained the exact Session X')
    assert(bOpen.host?.hostPid === hostBefore.hostPid, 'PP B attached to a different Host')
    assert(alive(aReady.pid) && alive(bReady.pid) && aReady.pid !== bReady.pid,
      'PP the two Clients must be two live distinct business PIDs')
    await clientB.waitForScreen('pp-a-seed', 'PP B read A\'s durable history', 120_000)

    // B queues its own message while the Turn runs, then steers the queued
    // occurrence into the running Turn (the official empty-draft Ctrl+S).
    clientB.send('pp-b-queued\r')
    await clientB.waitForScreen('pp-b-queued', 'PP B queued message painted', 120_000)
    clientB.send('\x13')

    // The FIRST model request of the held Turn: A is a Focus viewer and B is
    // Full — any current Focus viewer wins (the shared-Profile and
    // submitting-Client-local traps fail here).
    const heldRows = await waitForRows(1, 'PP held Turn request')
    assertRow(heldRows[0], { focusSection: true, progressSection: false },
      'PP held Turn with A=Focus/B=Full')

    // Release the Turn; the steered occurrence runs as a LATER STEP of the
    // SAME Turn and must carry the SAME frozen policy.
    writeFileSync(releaseBarrier, '', { mode: 0o600 })
    const steppedRows = await waitForRows(2, 'PP steered step request')
    assertRow(steppedRows[1], { focusSection: true, progressSection: false },
      'PP steered step of the frozen Turn')
    await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/end', 'PP first turn/end')
    // Re-hold: the NEXT Turn must freeze with A still viewing as Focus.
    rmSync(releaseBarrier)

    // B submits its own Turn while A keeps viewing X in Focus: the roster,
    // NOT the submitting Client's own display, decides (the decisive row).
    clientB.send('pp-b-with-a-viewing\r')
    const votedRows = await waitForRows(3, 'PP B-submitted Turn request')
    assertRow(votedRows[2], { focusSection: true, progressSection: false },
      'PP B-submitted Turn while A views X in Focus')

    // A exits MID-TURN. The open Turn is already frozen: its LATER step keeps
    // Focus; B's NEXT Turn after turn/end is the ordinary non-Focus policy.
    clientA.send('/exit\r')
    const aExit = await clientA.waitForExit(60_000)
    assert(aExit.code === 0 && aExit.signal === null, `PP Client A exit was ${JSON.stringify(aExit)}`)
    await clientA.dispose()
    assert(alive(hostBefore.hostPid), 'PP the Host died when Client A exited')
    await assertHostIdentityKept(host, hostBefore, 'PP Host after A exit')
    clientB.send('pp-b-after-a-exit-step\r')
    await clientB.waitForScreen('pp-b-after-a-exit-step', 'PP B queued the post-exit step', 120_000)
    clientB.send('\x13')
    writeFileSync(releaseBarrier, '', { mode: 0o600 })
    const frozenRows = await waitForRows(4, 'PP frozen post-exit step request')
    assertRow(frozenRows[3], { focusSection: true, progressSection: false },
      'PP the open Turn kept Focus after the Focus viewer exited mid-Turn')
    await waitForHostSessionEventAfter(dshHome, sessionX, 0,
      event => event.type === 'turn/end', 'PP second turn/end', 120_000)

    // B's NEXT Turn (the T+1 after turn/end) is ordinary: B is a Full-only
    // viewer, so no Focus policy and the progress policy participates.
    clientB.send('pp-b-next-turn\r')
    const nextRows = await waitForRows(5, 'PP next Turn request')
    assertRow(nextRows[4], { focusSection: false, progressSection: true },
      'PP B-only Full viewer Turn after A exited')

    // ---- Phase 2 (Session S2): a Session switch to a Full-only Session
    // never carries the Focus policy.
    clientB.send('/new\r')
    const s2Open = await waitForSurfaceStatus(clientB,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string'
        && record.openSessionId !== sessionX,
      'PP B switched to a fresh Session S2')
    const sessionS2 = s2Open.openSessionId
    clientB.send('pp-s2-turn\r')
    const s2Rows = await waitForRows(6, 'PP S2 Turn request')
    assertRow(s2Rows[5], { focusSection: false, progressSection: true },
      'PP S2 Full-only viewer Turn')

    // ---- Phase 3 (reconnect identity + Host survival): a FRESH authenticated
    // Peer re-opens X and becomes its only viewer. The retired Peer's record
    // never votes again; the new Peer's Focus view decides its own Turn.
    clientB.send('/exit\r')
    const bExit = await clientB.waitForExit(60_000)
    assert(bExit.code === 0 && bExit.signal === null, `PP Client B exit was ${JSON.stringify(bExit)}`)
    await clientB.dispose()
    assert(alive(hostBefore.hostPid), 'PP the Host died when Client B exited')
    const { client: clientC, ready: cReady } = await startC1Client('PP C', {
      SPLIT_PROCESS_CLIENT_SESSION: sessionX,
    })
    const cOpen = await waitForSurfaceStatus(clientC,
      record => record.sessionOpen === true && record.openSessionId === sessionX
        && record.transport === 'connected' && record.surfaceMounted === true,
      'PP C re-opened the exact Session X')
    assert(cOpen.host?.hostPid === hostBefore.hostPid, 'PP C attached to a different Host')
    assert(alive(cReady.pid) && cReady.pid !== bReady.pid && cReady.pid !== aReady.pid,
      'PP Client C must be a fresh live business PID')
    clientC.send('/display focus\r')
    await clientC.waitForScreen('Display: focus.', 'PP C applied the Focus display preset', 60_000)
    clientC.send('pp-c-x-turn\r')
    const cRows = await waitForRows(7, 'PP fresh Peer Turn request')
    assertRow(cRows[6], { focusSection: true, progressSection: false },
      'PP fresh Peer Focus view decided its own Turn')
    await waitForHostSessionEventAfter(dshHome, sessionX, 0,
      event => event.type === 'turn/end', 'PP fresh Peer turn/end', 120_000)
    await assertHostIdentityKept(host, hostBefore, 'PP Host after the full scene')

    await exitC1Client(clientC, 'PP C')
    await stopC1Host(host)
    trace('prompt-parity', {
      hostPid: hostBefore.hostPid,
      clientPids: [aReady.pid, bReady.pid, cReady.pid],
      sessionX,
      sessionS2,
      focusTurns: ['T1(A-focus)', 'T1-step', 'T2(B-submitted,A-focus)', 'T2-frozen-post-exit', 'C-focus'],
      ordinaryTurns: ['T3(B-only)', 'T4(S2)'],
      queuedSteer: 'B occurrence moved next-turn -> next-step while the Turn ran',
      focusSurvivedMidTurnViewerExit: true,
      nextTurnAfterExitOrdinary: true,
      freshPeerDecidesOwnTurn: true,
      hostIdentityKept: true,
    })
  } finally {
    await scene.dispose()
  }
}
