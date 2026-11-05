/**
 * M5-N / M5-D: navigation and Client lifecycle are NON-DESTRUCTIVE.
 *
 * Every scene starts its OWN isolated Host and REAL `script(1)` surface Clients
 * (distinct business PIDs, wrappers and PTYs). M5-N proves `/new`/`/resume`
 * never stop or wait for a Host Turn a Client leaves, that a RUNNING target is
 * projected immediately, that a Host-queued occurrence stays with its own
 * Session, that an already-current switch is a no-op and that a Busy Esc still
 * cancels the exact Turn. M5-D proves the same invariant from every independent
 * A-side gesture (`/exit`, SIGKILL, SIGHUP, transport rollover, same-PID HMR,
 * navigation): B's Context, root fiber, generation, surface revision, Session X
 * and the Host identity stay unchanged and the Host's ORIGINAL held Turn
 * survives A's departure.
 *
 * @module split-process/non-destructive-client-lifecycle
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import {
  alive,
  assertClientHostFacts,
  findIsolatedProcesses,
  lastSurfaceStatus,
  readJson,
  seatFree,
  waitForCondition,
  waitForSurfaceStatus,
  waitGone,
} from '../../lib/split-smoke-processes.mjs'
import {
  hostAssistantHasText,
  hostSessionEvents,
  hostSessionLogCount,
  hostUserTexts,
  waitForHostSessionEvent,
  waitForHostSessionEventAfter,
  waitForHostSessionHeader,
} from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** Run the navigation and independent-Client-lifecycle scenes. */
export async function runNonDestructiveClientLifecycle(context) {
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
    assertInteractionGate,
    sceneScopeSuffix,
  } = scene
  try {
    // M5N-01 (M5-N): Split Remote navigation is NON-DESTRUCTIVE. ONE real
    // Host and REAL Surface Clients (`script(1)` PTYs, distinct business
    // PIDs) prove that `/new` and `/resume` never stop — and never wait for
    // — the Host Turn a Client leaves: the held X Turn keeps streaming and
    // ends with its normal `completed` reason after the navigating Client
    // moved, a RUNNING target is projected immediately instead of being
    // waited to idle, a Host-queued occurrence stays with its own Session,
    // an already-current switch is a no-op, and an explicit Busy Esc still
    // cancels the exact Host Turn (the negative control). The fixture's held
    // `long-turn` barrier is the ONLY thing that lets a held Turn continue,
    // so a replayed write or a timer cannot produce these facts.
    {
      const releaseBarrier = join(workDir, 'm5n-long-turn.release')
      const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5n-navigation', {
        C1_HOLD_LONG_TURN: releaseBarrier,
      })
      const hostBefore = await hostIdentityFacts(host)
      assert(hostBefore.hostPid === hostReady.pid, 'M5N the Host ready record does not own the Host identity')
      // The lane's own fail-after control: the M5-N Host is alive here.
      failpoint('navigation.non-destructive-client-lifecycle.after-host-spawn')
      const { client: clientA, ready: aReady } = await startC1Client('M5N A')
      assert(Number.isInteger(aReady.pid) && aReady.pid > 0 && aReady.pid !== hostBefore.hostPid,
        'M5N Client A published no live business PID distinct from the Host')
      assert(aReady.pid !== clientA.child.pid, 'M5N a business PID was mistaken for its script(1) wrapper')
      /** The plain text of one durable/inbox message (bounded, never a payload dump). */
      const textOf = message => (message?.content ?? [])
        .map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
        .join('')
      const durableOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []
      /** Wait for the Nth `turn/end` at or after one durable boundary. */
      const waitForTurnEnds = async (sessionId, afterIndex, count, label) => {
        await waitForCondition(
          () => durableOf(sessionId).slice(afterIndex).filter(event => event.type === 'turn/end').length >= count,
          label,
          120_000,
        )
        return durableOf(sessionId).slice(afterIndex).filter(event => event.type === 'turn/end')
      }

      // The seed Turn IS the running Turn every navigation below leaves: the
      // fixture holds it until the release barrier exists.
      const sessionX = await openC1Session(clientA, 'm5n-x-held', 'M5N A')
      const heldX = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5N X Turn held')
      assert(heldX.agentStatus === 'running',
        `M5N the Host Agent was ${JSON.stringify(heldX.agentStatus)} while X was held`)
      await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5N X turn/start')
      const xHeaderBefore = await waitForHostSessionHeader(dshHome, sessionX, 'M5N X durable header')
      const sessionsBeforeNew = hostSessionLogCount(dshHome)
      assert(!existsSync(releaseBarrier), 'M5N the held Turn was released before the first navigation')

      // NB-01 (N-02): `/new` while X RUNS. The new Session commits while X's
      // Turn is still held, so the switch cannot have waited for X to go
      // idle, and no `turn/end` may exist before the barrier is released.
      const newBoundary = clientA.records.length
      clientA.send('/new\r')
      const aOnY = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= newBoundary
          && record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && typeof record.openSessionId === 'string'
          && record.openSessionId !== sessionX,
        'M5N A opened Session Y while X was running',
        120_000,
      )
      const sessionY = aOnY.openSessionId
      assert(sessionY !== sessionX, 'M5N /new did not open a different Session')
      assert(aOnY.transport === 'connected' && aOnY.surfaceMounted === true,
        'M5N Client A lost its transport/surface while navigating')
      assertClientHostFacts(aOnY.host, hostBefore, 'M5N A on Y')
      assert(durableOf(sessionX).every(event => event.type !== 'turn/end'),
        'M5N X ended its Turn before the hold barrier was released: the /new stopped or waited for it')
      assert(!existsSync(releaseBarrier), 'M5N the hold barrier was released during /new')
      const yHeader = await waitForHostSessionHeader(dshHome, sessionY, 'M5N Y durable header')
      assert(hostSessionLogCount(dshHome) === sessionsBeforeNew + 1,
        `M5N /new created ${String(hostSessionLogCount(dshHome) - sessionsBeforeNew)} durable Sessions, expected exactly 1`)
      assert(yHeader.cwd === xHeaderBefore.cwd,
        `M5N the /new Session Workspace is not the captured Host Workspace: ${String(yHeader.cwd)} != ${String(xHeaderBefore.cwd)}`)
      const xHeaderAfterNew = await waitForHostSessionHeader(dshHome, sessionX, 'M5N X durable header after /new')
      assert(JSON.stringify(xHeaderAfterNew) === JSON.stringify(xHeaderBefore),
        'M5N /new changed the durable Session it left')

      // The RUNNING target for N-03: Y gets its own held Turn.
      clientA.send('m5n-y-held\r')
      const heldY = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionY, 'M5N Y Turn held')
      assert(heldY.agentStatus === 'running',
        `M5N the Host Agent was ${JSON.stringify(heldY.agentStatus)} while Y was held`)
      await waitForHostSessionEvent(dshHome, sessionY, event => event.type === 'turn/start', 'M5N Y turn/start')
      assert(durableOf(sessionY).every(event => event.type !== 'turn/end'),
        'M5N Y ended its Turn before the hold barrier was released')

      // NB-02 (N-03): `/resume` into a RUNNING target. A leaves running Y for
      // running X; the commit must not wait for X to go idle, and the new
      // surface projects X's in-flight stream instead of the Session it left.
      const resumeBoundary = clientA.records.length
      clientA.send(`/resume ${sessionX}\r`)
      const aOnX = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= resumeBoundary
          && record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && record.openSessionId === sessionX
          && record.transport === 'connected'
          && record.surfaceMounted === true,
        'M5N A resumed the RUNNING Session X',
        120_000,
      )
      assertClientHostFacts(aOnX.host, hostBefore, 'M5N A back on X')
      await waitForCondition(async () => {
        const frame = (await clientA.viewport()).join('\n')
        return frame.includes('long-turn started') && !frame.includes('m5n-y-held')
      }, 'M5N A projected the RUNNING X surface', 120_000)
      assert(!existsSync(releaseBarrier), 'M5N the hold barrier was released during /resume')

      // NB-03: an already-current switch is a NO-OP: no re-open, no Turn end.
      // The refusal is a COMMAND ERROR, and the TUI's contract keeps a
      // refused command line in the editor for correction ("an error outcome
      // keeps the draft"). That restored line is observed here and cleared
      // through the real editor before the next ordinary submit, so the
      // queued-occurrence proof can never be built on a concatenated line.
      const alreadyBoundary = clientA.records.length
      clientA.send(`/resume ${sessionX}\r`)
      await clientA.waitForScreen('already on this session', 'M5N already-current refusal', 120_000)
      const alreadyStatus = lastSurfaceStatus(clientA)
      assert(alreadyStatus?.openSessionId === sessionX, 'M5N an already-current switch moved the Client')
      assert(durableOf(sessionX).every(event => event.type !== 'turn/end'),
        'M5N an already-current switch ended the running Turn')
      assert(clientA.records.filter(record => clientA.records.indexOf(record) >= alreadyBoundary
        && record.m4b2s === 'surface-status' && record.openSessionId === sessionY).length === 0,
        'M5N an already-current switch opened a different Session')
      const refusedLine = `/resume ${sessionX}`
      await clientA.waitForComposerDraft(refusedLine)
      clientA.send('\x15')
      await waitForCondition(async () => {
        const composer = (await clientA.composerText()) ?? ''
        return !composer.includes('/resume')
      }, 'M5N cleared the refused command line', 30_000)

      // NB-04 (N-04): a Host-queued occurrence on the running X, then A
      // leaves X. The occurrence belongs to X and must survive the release.
      // The text is typed and CONFIRMED in the composer before Enter: an
      // input that a closing overlay or an unfocused seat drops is lost for
      // good, so the readiness fact (the editor holds the line) must be
      // observed instead of guessed.
      const xQueueIndex = durableOf(sessionX).length
      clientA.send('m5n-x-queued')
      await clientA.waitForComposerDraft('m5n-x-queued')
      assert(!((await clientA.composerText()) ?? '').includes('/resume'),
        'M5N the queued line must not inherit a refused command line')
      clientA.send('\r')
      const queuedX = await waitForHostSessionEventAfter(dshHome, sessionX, xQueueIndex,
        event => event.type === 'agent/inbox/spliced'
          && event.data?.target === 'next-turn'
          && (event.data.inserted ?? []).some(message => textOf(message) === 'm5n-x-queued'),
        'M5N X queued the occurrence in the Host inbox',
        120_000)
      const queuedItem = (queuedX.data.inserted ?? []).find(message => textOf(message) === 'm5n-x-queued')
      assert(typeof queuedItem?.id === 'string' && queuedItem.id !== '',
        'M5N the Host queued occurrence carries no identity')

      // NB-05 (N-01): `/resume` away from the RUNNING X. A lands on Y while
      // X's Turn and its queued occurrence are still held.
      const leaveBoundary = clientA.records.length
      clientA.send(`/resume ${sessionY}\r`)
      const aLeftX = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= leaveBoundary
          && record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && record.openSessionId === sessionY
          && record.transport === 'connected'
          && record.surfaceMounted === true,
        'M5N A left the running X for Y',
        120_000,
      )
      assertClientHostFacts(aLeftX.host, hostBefore, 'M5N A after leaving X')
      assert(!existsSync(releaseBarrier), 'M5N the hold barrier was released during the navigation')
      assert(durableOf(sessionX).every(event => event.type !== 'turn/end'),
        'M5N leaving X stopped its held Turn')
      // The status record is not a painted frame: the old X transcript can
      // still be on screen when the record arrives. Wait for a Y-ONLY fact
      // (`m5n-y-held` was never sent on X) before asserting the X-only
      // absence, or the assertion races the repaint.
      await waitForCondition(async () => (await clientA.viewport()).join('\n').includes('m5n-y-held'),
        'M5N A painted the Y surface after leaving X', 120_000)
      assert(!(await clientA.viewport()).join('\n').includes('m5n-x-queued'),
        'M5N the X-only queued occurrence leaked onto the Y surface')

      // B is a SECOND real pty admitted to the SAME X while it is still
      // running: it reads X's live held stream and A's Host pending.
      const { client: clientB, ready: bReady } = await startC1Client('M5N B', {
        SPLIT_PROCESS_CLIENT_SESSION: sessionX,
      })
      const bOnX = await waitForSurfaceStatus(clientB,
        record => record.sessionOpen === true
          && record.openSessionId === sessionX
          && record.transport === 'connected'
          && record.surfaceMounted === true,
        'M5N B retained the exact running Session X')
      assertClientHostFacts(bOnX.host, hostBefore, 'M5N B')
      assert(Number.isInteger(bReady.pid) && bReady.pid > 0 && bReady.pid !== hostBefore.hostPid,
        'M5N Client B published no live business PID distinct from the Host')
      assert(aReady.pid !== bReady.pid, 'M5N the two Clients must be two different business PIDs')
      assert(clientA.child.pid !== clientB.child.pid, 'M5N the two Clients must use distinct script(1) wrappers')
      await clientB.waitForScreen('long-turn started', 'M5N B read the running X stream', 120_000)
      await clientB.waitForScreen('m5n-x-queued', 'M5N B read the Host-queued occurrence', 120_000)
      assert(alive(aReady.pid) && alive(bReady.pid) && alive(hostBefore.hostPid),
        'M5N a process died during the navigation')

      // Release the ONE hold. The Turn A left continues and completes
      // normally, claims the queued occurrence into the SAME Session, and B
      // sees the continuation; A sees its own target's settlement.
      const xReleaseIndex = durableOf(sessionX).length
      const yReleaseIndex = durableOf(sessionY).length
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const xEnds = await waitForTurnEnds(sessionX, xReleaseIndex, 1, 'M5N the held X Turn completed')
      assert(xEnds[0]?.data?.reason?.kind === 'completed',
        `M5N the held X Turn settled as ${JSON.stringify(xEnds[0]?.data?.reason)} instead of a normal completion`)
      const yEnd = await waitForHostSessionEventAfter(dshHome, sessionY, yReleaseIndex,
        event => event.type === 'turn/end', 'M5N the held Y Turn completed', 120_000)
      assert(yEnd.data?.reason?.kind === 'completed',
        `M5N the held Y Turn settled as ${JSON.stringify(yEnd.data?.reason)} instead of a normal completion`)
      await clientA.waitForScreen('long-turn answer 1', 'M5N A read its target settlement', 120_000)
      await clientB.waitForScreen('long-turn answer 1', 'M5N B read the departed Turn settlement', 120_000)
      const claimedX = await waitForHostSessionEventAfter(dshHome, sessionX, xReleaseIndex,
        event => event.type === 'user/message' && event.data?.id === queuedItem.id,
        'M5N X claimed the exact queued occurrence', 120_000)
      assert(textOf(claimedX.data) === 'm5n-x-queued', 'M5N the claimed occurrence changed content')
      const xEndsAfter = await waitForTurnEnds(sessionX, xReleaseIndex, 2, 'M5N the queued X Turn settled')
      assert(xEndsAfter.every(event => event.data?.reason?.kind === 'completed'),
        'M5N a non-aborted X Turn settled without a normal completion')
      const finalX = durableOf(sessionX)
      assert(finalX.filter(event => event.type === 'user/message' && textOf(event.data) === 'm5n-x-queued').length === 1,
        'M5N the queued occurrence committed more than once')
      assert(finalX.filter(event => event.type === 'user/message' && event.data?.id === queuedItem.id).length === 1,
        'M5N the queued occurrence identity committed more than once')
      assert(durableOf(sessionY).every(event => !(event.type === 'user/message' && textOf(event.data) === 'm5n-x-queued')),
        'M5N the X-only queued occurrence leaked into Session Y')
      await clientB.waitForScreen('m5n-x-queued', 'M5N B read the settled queued occurrence', 120_000)
      assert(lastSurfaceStatus(clientB)?.openSessionId === sessionX,
        'M5N Client B lost Session X during the continuation')

      // NB-06 (explicit Stop negative control): a fresh held Turn on a fresh
      // Session Z is stopped by the real Busy Esc. The SAME Host records an
      // ABORTED user settlement, so the detached navigation policy did not
      // disable the explicit Stop.
      rmSync(releaseBarrier)
      const stopNewBoundary = clientA.records.length
      clientA.send('/new\r')
      const aOnZ = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= stopNewBoundary
          && record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && typeof record.openSessionId === 'string'
          && record.openSessionId !== sessionY
          && record.openSessionId !== sessionX,
        'M5N A opened the fresh Session Z for the Stop control',
        120_000,
      )
      const sessionZ = aOnZ.openSessionId
      clientA.send('m5n-z-stop\r')
      const heldZ = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionZ, 'M5N Z Turn held')
      assert(heldZ.agentStatus === 'running',
        `M5N the Host Agent was ${JSON.stringify(heldZ.agentStatus)} while Z was held`)
      // The Z transcript is fresh and carries its OWN unique prompt, so this
      // paint is the Z Turn's live stream — the surface is busy and accepts
      // the single-Esc Stop.
      await waitForCondition(async () => {
        const frame = (await clientA.viewport()).join('\n')
        return frame.includes('m5n-z-stop') && frame.includes('long-turn started')
      }, 'M5N A painted the held Z Turn', 120_000)
      const zStopIndex = durableOf(sessionZ).length
      clientA.send('\x1b')
      const zAborted = await waitForHostSessionEventAfter(dshHome, sessionZ, zStopIndex,
        event => event.type === 'turn/end', 'M5N the Busy Esc settled the Z Turn', 120_000)
      assert(zAborted.data?.reason?.kind === 'aborted'
        && zAborted.data?.reason?.reason?.kind === 'user',
      `M5N the Busy Esc settlement was ${JSON.stringify(zAborted.data?.reason)} instead of an aborted user Turn`)

      await assertHostIdentityKept(host, hostBefore, 'M5N Host after every navigation')
      await exitC1Client(clientA, 'M5N A')
      await exitC1Client(clientB, 'M5N B')
      await stopC1Host(host)
      trace('m5n-01', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        wrapperPids: [clientA.child.pid, clientB.child.pid],
        sessionX,
        sessionY,
        sessionZ,
        newFromRunningX: true,
        resumeRunningTarget: true,
        alreadyCurrentNoOp: true,
        queuedOccurrencePreserved: true,
        oldXTurnCompletion: 'completed',
        clientBReadContinuation: true,
        explicitStop: 'aborted/user',
      })
    }


    // M5N-02 (M5-N): the SIBLING paths of a detached navigation. `/fork`
    // adopts a Host-published child while the source Turn is still running,
    // and the Client EXIT releases only this Client's own references. Neither
    // path may cancel the Host work it leaves: the source Turn finishes with
    // its normal `completed` reason after the Client moved or exited, the
    // second Client keeps reading and writing that same Session, and an
    // explicit Busy Esc is still the ONE gesture that aborts a Turn (the
    // negative control). The Host fork boundary is the source's last
    // COMPLETED turn, so the child is adopted while the source's LATER Turn is
    // still held: a fork that waited for the source Turn could not commit
    // here, and a fork that stopped it could not continue afterwards.
    {
      const releaseBarrier = join(workDir, 'm5n2-siblings.release')
      const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5n2-siblings', {
        C1_HOLD_LONG_TURN: releaseBarrier,
      })
      const hostBefore = await hostIdentityFacts(host)
      assert(hostBefore.hostPid === hostReady.pid, 'M5N2 the Host ready record does not own the Host identity')
      const { client: clientA, ready: aReady } = await startC1Client('M5N2 A')
      /** The plain text of one durable/inbox message (bounded, never a payload dump). */
      const textOf = message => (message?.content ?? [])
        .map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
        .join('')
      const durableOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []
      /** Wait for the Nth `turn/end` at or after one durable boundary. */
      const waitForTurnEnds = async (sessionId, afterIndex, count, label) => {
        await waitForCondition(
          () => durableOf(sessionId).slice(afterIndex).filter(event => event.type === 'turn/end').length >= count,
          label,
          120_000,
        )
        return durableOf(sessionId).slice(afterIndex).filter(event => event.type === 'turn/end')
      }
      /** Type one prompt through the PAINTED composer, then submit it. */
      const submitPrompt = async (client, text) => {
        client.send(text)
        await client.waitForComposerDraft(text)
        client.send('\r')
      }
      /**
       * Wait for a FIXTURE event recorded at or after one boundary (the
       * fixture proof file is append-only for the whole lane, so a bare
       * `.find()` over all history can satisfy a wait with an EARLIER turn).
       */
      const waitForC1WorkEventAfter = async (afterIndex, predicate, label, timeoutMs = 120_000) => {
        const found = () => readC1WorkEvents(workRoot).slice(afterIndex).find(predicate)
        await waitForCondition(() => found() !== undefined, label, timeoutMs)
        return found()
      }

      // Turn 1 on X becomes a REAL completed product turn: it is the Host fork
      // cut the child inherits.
      const openWorkBoundary = readC1WorkEvents(workRoot).length
      const sessionX = await openC1Session(clientA, 'm5n2-x-turn1', 'M5N2 A')
      // The fixture stores only the FIRST 400 characters of a request's user
      // text, so a later turn's own prompt is beyond that window — the
      // pre-submit boundary is the freshness authority (see submitAndHold).
      const heldX1 = await waitForC1WorkEventAfter(openWorkBoundary,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionX,
        'M5N2 X first Turn held')
      assert(heldX1.agentStatus === 'running',
        `M5N2 the Host Agent was ${JSON.stringify(heldX1.agentStatus)} while X was held`)
      // B joins the SAME Session X through its own startup intent: it is the
      // second real Client that must keep serving X through both departures.
      const { client: clientB, ready: bReady } = await startC1Client('M5N2 B', {
        SPLIT_PROCESS_CLIENT_SESSION: sessionX,
      })
      const bOnX = await waitForSurfaceStatus(clientB,
        record => record.sessionOpen === true
          && record.openSessionId === sessionX
          && record.transport === 'connected'
          && record.surfaceMounted === true,
        'M5N2 B retained Session X')
      assertClientHostFacts(bOnX.host, hostBefore, 'M5N2 B')
      assert(Number.isInteger(bReady.pid) && bReady.pid > 0 && bReady.pid !== hostBefore.hostPid,
        'M5N2 Client B published no live business PID distinct from the Host')
      assert(aReady.pid !== bReady.pid, 'M5N2 the two Clients must be two different business PIDs')
      assert(clientA.child.pid !== clientB.child.pid, 'M5N2 the two Clients must use distinct script(1) wrappers')
      /**
       * Submit one prompt and prove the Host started ITS OWN Turn: the
       * fixture records `long-turn-held` for the model request, and the Host
       * appends the fresh `turn/start` plus the EXACT `user/message` after the
       * boundary taken BEFORE the submit. Both proof stores are append-only
       * for the whole lane, so every wait is bounded by that boundary instead
       * of scanning all history (`attempt` is a per-session call counter, not
       * an identity, and the fixture truncates `userText` to 400 characters).
       */
      const submitAndHold = async (client, prompt, durableBoundary) => {
        const workBoundary = readC1WorkEvents(workRoot).length
        await submitPrompt(client, prompt)
        const held = await waitForC1WorkEventAfter(workBoundary,
          event => event.kind === 'long-turn-held' && event.sessionId === sessionX,
          `M5N2 the "${prompt}" Turn held`)
        await waitForHostSessionEventAfter(dshHome, sessionX, durableBoundary,
          event => event.type === 'turn/start', `M5N2 the "${prompt}" Turn started at the Host`, 120_000)
        await waitForHostSessionEventAfter(dshHome, sessionX, durableBoundary,
          event => event.type === 'user/message' && textOf(event.data) === prompt,
          `M5N2 the Host committed the "${prompt}" prompt`, 120_000)
        return held
      }
      const xTurn1Index = durableOf(sessionX).length
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const xTurn1Ends = await waitForTurnEnds(sessionX, xTurn1Index, 1, 'M5N2 the held X first Turn completed')
      assert(xTurn1Ends[0]?.data?.reason?.kind === 'completed',
        `M5N2 the X first Turn settled as ${JSON.stringify(xTurn1Ends[0]?.data?.reason)} instead of a normal completion`)

      // Turn 2 on X stays RUNNING: it is the work the fork must not stop and
      // must not wait for.
      rmSync(releaseBarrier)
      const xTurn2Index = durableOf(sessionX).length
      const heldX2 = await submitAndHold(clientA, 'm5n2-x-turn2', xTurn2Index)
      assert(heldX2.agentStatus === 'running',
        `M5N2 the Host Agent was ${JSON.stringify(heldX2.agentStatus)} while X's second Turn was held`)
      assert(!existsSync(releaseBarrier), 'M5N2 the hold barrier was released before the fork')

      // NB-10 (N-05): `/fork` while X's second Turn runs. ONE Host fork, ONE
      // published child, ONE Client move, and the source keeps running.
      const sessionsBeforeFork = hostSessionLogCount(dshHome)
      const forkBoundary = clientA.records.length
      clientA.send('/fork\r')
      const aOnChild = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= forkBoundary
          && record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && typeof record.openSessionId === 'string'
          && record.openSessionId !== sessionX
          && record.transport === 'connected'
          && record.surfaceMounted === true,
        'M5N2 A adopted the forked child',
        120_000,
      )
      const childId = aOnChild.openSessionId
      assert(childId !== sessionX, 'M5N2 /fork did not move the Client onto a new Session')
      assertClientHostFacts(aOnChild.host, hostBefore, 'M5N2 A on the forked child')
      assert(durableOf(sessionX).slice(xTurn2Index).every(event => event.type !== 'turn/end'),
        'M5N2 the fork ended the source Turn: the source Host Turn was stopped')
      assert(!existsSync(releaseBarrier), 'M5N2 the hold barrier was released during the fork')
      // The Client moved ONCE: from the record that adopted the child on,
      // no later status may return to the source or name a third Session.
      const movesAfterFork = clientA.records
        .slice(clientA.records.indexOf(aOnChild))
        .filter(record => record.m4b2s === 'surface-status' && record.sessionOpen === true
          && typeof record.openSessionId === 'string')
        .map(record => record.openSessionId)
      assert(movesAfterFork.every(id => id === childId),
        `M5N2 the /fork moved the Client more than once: ${JSON.stringify(movesAfterFork)}`)
      // The Host published the child from THIS source, with the source's
      // COMPLETED prefix only: never the running Turn and never the source's
      // own command settlement.
      const childHeader = await waitForHostSessionHeader(dshHome, childId, 'M5N2 the child durable header')
      assert(hostSessionLogCount(dshHome) === sessionsBeforeFork + 1,
        `M5N2 /fork published ${String(hostSessionLogCount(dshHome) - sessionsBeforeFork)} durable Sessions, expected exactly 1`)
      assert(childHeader.parentSession === sessionX,
        `M5N2 the child lineage named ${JSON.stringify(childHeader.parentSession)} instead of the source`)
      assert(childHeader.isSeeded === true, 'M5N2 the child is not a seeded fork')
      const childUserTexts = hostUserTexts(durableOf(childId))
      assert(childUserTexts.filter(text => text === 'm5n2-x-turn1').length === 1,
        `M5N2 the child lost the source's completed prefix: ${JSON.stringify(childUserTexts)}`)
      assert(childUserTexts.filter(text => text === 'm5n2-x-turn2').length === 0,
        'M5N2 the child inherited the RUNNING source Turn')
      assert(durableOf(childId).some(event => event.type === 'turn/end' && event.data?.reason?.kind === 'completed'),
        'M5N2 the child inherited no completed Turn')
      // Release the ONE hold: the source Turn A left continues and completes,
      // and B reads the continuation through its own PTY.
      const xReleaseIndex = durableOf(sessionX).length
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const xTurn2Ends = await waitForTurnEnds(sessionX, xReleaseIndex, 1, 'M5N2 the source Turn completed after the fork')
      assert(xTurn2Ends[0]?.data?.reason?.kind === 'completed',
        `M5N2 the source Turn settled as ${JSON.stringify(xTurn2Ends[0]?.data?.reason)} instead of a normal completion`)
      await clientB.waitForScreen('long-turn answer 2', 'M5N2 B read the source continuation', 120_000)
      assert(lastSurfaceStatus(clientB)?.openSessionId === sessionX, 'M5N2 Client B left Session X')
      // A Split Remote TUI command is executed through the CLIENT command
      // registry: the projected agent never reaches `ctx.commands.execute`,
      // so `/fork` appends NO `command/run`/`command/done` row to the Host
      // Session (the Direct in-process path does, and
      // test/domain/runner-session-navigation.test.ts pins there that the
      // source owner stays attached THROUGH that append). The deferred
      // source-retirement window the runtime uses is the SAME code path on
      // both backends; the durable rows simply do not exist for this
      // backend, so this scene must not claim them.
      // The child is an INDEPENDENT conversation: its own prompt commits on
      // the child only.
      const childTurnIndex = durableOf(childId).length
      await submitPrompt(clientA, 'm5n2-child-own')
      await waitForHostSessionEventAfter(dshHome, childId, childTurnIndex,
        event => event.type === 'user/message' && textOf(event.data) === 'm5n2-child-own',
        'M5N2 the child prompt committed', 120_000)
      await waitForHostSessionEventAfter(dshHome, childId, childTurnIndex,
        event => event.type === 'turn/end', 'M5N2 the child Turn settled', 120_000)
      assert(hostUserTexts(durableOf(sessionX)).every(text => text !== 'm5n2-child-own'),
        'M5N2 the child prompt leaked into the source Session')

      // NB-11 (N-06): the Client EXIT. A returns to the running source and
      // leaves the Client entirely: the exit releases only A's own references.
      rmSync(releaseBarrier)
      const xTurn3Index = durableOf(sessionX).length
      const heldX3 = await submitAndHold(clientB, 'm5n2-x-turn3', xTurn3Index)
      assert(heldX3.agentStatus === 'running',
        `M5N2 the Host Agent was ${JSON.stringify(heldX3.agentStatus)} while X's third Turn was held`)
      const backBoundary = clientA.records.length
      clientA.send(`/resume ${sessionX}\r`)
      const aBackOnX = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= backBoundary
          && record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && record.openSessionId === sessionX
          && record.transport === 'connected'
          && record.surfaceMounted === true,
        'M5N2 A returned to the running source Session',
        120_000,
      )
      assertClientHostFacts(aBackOnX.host, hostBefore, 'M5N2 A back on X')
      const sessionsBeforeExit = hostSessionLogCount(dshHome)
      const aPid = aReady.pid
      await exitC1Client(clientA, 'M5N2 A')
      await waitGone(aPid, 15_000)
      assert(!alive(aPid), 'M5N2 Client A survived its exit')
      assert(alive(bReady.pid) && alive(hostBefore.hostPid), 'M5N2 the Client exit killed the Host or the second Client')
      assert(hostSessionLogCount(dshHome) === sessionsBeforeExit,
        'M5N2 the Client exit created or removed a durable Session')
      assert(durableOf(sessionX).slice(xTurn3Index).every(event => event.type !== 'turn/end'),
        'M5N2 the Client exit ended the running Host Turn')
      assert(!existsSync(releaseBarrier), 'M5N2 the hold barrier was released during the exit')
      await assertHostIdentityKept(host, hostBefore, 'M5N2 Host after the Client exit')
      // Release: the source Turn completes with its normal reason and B can
      // still write that same Session.
      const xExitReleaseIndex = durableOf(sessionX).length
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const xTurn3Ends = await waitForTurnEnds(sessionX, xExitReleaseIndex, 1, 'M5N2 the source Turn completed after the exit')
      assert(xTurn3Ends[0]?.data?.reason?.kind === 'completed',
        `M5N2 the source Turn settled as ${JSON.stringify(xTurn3Ends[0]?.data?.reason)} after the exit`)
      await clientB.waitForScreen('long-turn answer 3', 'M5N2 B read the continuation after A exited', 120_000)
      assert(durableOf(sessionX).every(event => !(event.type === 'turn/end' && event.data?.reason?.kind === 'aborted')),
        'M5N2 a Turn was aborted by something other than the explicit Stop')
      const afterExitIndex = durableOf(sessionX).length
      await submitPrompt(clientB, 'm5n2-b-after-exit')
      await waitForHostSessionEventAfter(dshHome, sessionX, afterExitIndex,
        event => event.type === 'user/message' && textOf(event.data) === 'm5n2-b-after-exit',
        'M5N2 B committed after A exited', 120_000)
      await waitForHostSessionEventAfter(dshHome, sessionX, afterExitIndex,
        event => event.type === 'turn/end', 'M5N2 the post-exit Turn settled', 120_000)
      const committedAfterExit = hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5n2-b-after-exit').length
      assert(committedAfterExit === 1,
        `M5N2 the post-exit prompt committed ${String(committedAfterExit)} times, expected exactly 1`)

      // NB-12 (explicit Stop negative control): only the Busy Esc gesture may
      // abort the SAME Session's held Turn. The exit above left it running.
      rmSync(releaseBarrier)
      const stopIndex = durableOf(sessionX).length
      // `submitAndHold` proves the FRESH Turn (fixture event + durable
      // `turn/start` + exact `user/message` after the boundary). The generic
      // "long-turn started" transcript line is never a freshness fact.
      const heldStop = await submitAndHold(clientB, 'm5n2-x-stop', stopIndex)
      assert(heldStop.agentStatus === 'running',
        `M5N2 the Host Agent was ${JSON.stringify(heldStop.agentStatus)} while the Stop-control Turn was held`)
      await waitForCondition(async () => (await clientB.viewport()).join('\n').includes('m5n2-x-stop'),
        'M5N2 B echoed the held Stop-control prompt', 120_000)
      clientB.send('\x1b')
      const stopped = await waitForHostSessionEventAfter(dshHome, sessionX, stopIndex,
        event => event.type === 'turn/end', 'M5N2 the Busy Esc settled the Turn', 120_000)
      assert(stopped.data?.reason?.kind === 'aborted' && stopped.data?.reason?.reason?.kind === 'user',
        `M5N2 the Busy Esc settlement was ${JSON.stringify(stopped.data?.reason)} instead of an aborted user Turn`)

      // NB-13 (N-05, `/rewind`): the SAME detached-navigation contract for an
      // EXPLICIT completed-turn cut. X keeps RUNNING while B rewinds: the Host
      // fork boundary is the PRECEDECESSOR's end (turn 3 for the selected turn
      // 4), the adopted child carries that prefix only, and the selected
      // prompt is restored into the ADOPTED child's editor.
      // The Stop control above already removed the hold barrier, so the next
      // source Turn holds; never rm a path that is legitimately gone.
      assert(!existsSync(releaseBarrier), 'M5N2 the hold barrier must be absent before the rewind Turn')
      const xTurn6Index = durableOf(sessionX).length
      const heldX6 = await submitAndHold(clientB, 'm5n2-x-turn6', xTurn6Index)
      assert(heldX6.agentStatus === 'running',
        `M5N2 the Host Agent was ${JSON.stringify(heldX6.agentStatus)} while X's sixth Turn was held`)
      const sessionsBeforeRewind = hostSessionLogCount(dshHome)
      const rewindBoundary = clientB.records.length
      clientB.send('/rewind\r')
      await clientB.waitForScreen('turn 4 · m5n2-b-after-exit',
        'M5N2 the rewind picker listed the completed turns', 60_000)
      /** The turn the picker's `> ` selection marker is PAINTED on. */
      const markedTurn = async () => {
        const row = (await clientB.viewport()).find(line => /> +turn \d+ ·/u.test(line))
        const match = row?.match(/> +turn (\d+) ·/u)
        return match === undefined ? undefined : Number(match[1])
      }
      const initialMarkedTurn = await markedTurn()
      assert(initialMarkedTurn !== undefined, 'M5N2 the rewind picker painted no selection marker')
      // Move the REAL picker selection by observing the painted marker move
      // (an authoritative frame fact), never by a fixed sleep between keys.
      for (let step = 0; step < 6 && (await markedTurn()) !== 4; step += 1) {
        const before = await markedTurn()
        clientB.send('\x1b[B')
        await waitForCondition(async () => {
          const now = await markedTurn()
          return now !== undefined && now !== before
        }, 'M5N2 the rewind picker moved its selection', 15_000)
      }
      assert((await markedTurn()) === 4, 'M5N2 the rewind picker never selected turn 4')
      clientB.send('\r')
      const bOnRewound = await clientB.waitFor(
        record => clientB.records.indexOf(record) >= rewindBoundary
          && record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && typeof record.openSessionId === 'string'
          && record.openSessionId !== sessionX
          && record.transport === 'connected'
          && record.surfaceMounted === true,
        'M5N2 B adopted the rewound child', 120_000)
      const rewoundChildId = bOnRewound.openSessionId
      assertClientHostFacts(bOnRewound.host, hostBefore, 'M5N2 B on the rewound child')
      assert(hostSessionLogCount(dshHome) === sessionsBeforeRewind + 1,
        `M5N2 /rewind published ${String(hostSessionLogCount(dshHome) - sessionsBeforeRewind)} durable Sessions, expected exactly 1`)
      assert(durableOf(sessionX).slice(xTurn6Index).every(event => event.type !== 'turn/end'),
        'M5N2 the rewind ended the running source Turn')
      assert(!existsSync(releaseBarrier), 'M5N2 the hold barrier was released during the rewind')
      const rewoundHeader = await waitForHostSessionHeader(dshHome, rewoundChildId, 'M5N2 the rewound child durable header')
      assert(rewoundHeader.parentSession === sessionX, 'M5N2 the rewound child does not name the source')
      assert(rewoundHeader.isSeeded === true, 'M5N2 the rewound child is not a seeded fork')
      const rewoundTexts = hostUserTexts(durableOf(rewoundChildId))
      assert(rewoundTexts.filter(text => text === 'm5n2-x-turn3').length === 1,
        `M5N2 the rewound child lost the prefix through turn 3: ${JSON.stringify(rewoundTexts)}`)
      assert(rewoundTexts.filter(text => text === 'm5n2-b-after-exit').length === 0,
        'M5N2 the rewound child inherited the selected turn it forked BEFORE')
      assert(durableOf(rewoundChildId).every(event => !(event.type === 'turn/end' && event.data?.reason?.kind === 'aborted')),
        'M5N2 the rewound child inherited the later aborted Turn')
      // The rewind restored the SELECTED turn's prompt into the ADOPTED editor.
      await clientB.waitForComposerDraft('m5n2-b-after-exit')
      clientB.send('\x15')
      await waitForCondition(async () => !((await clientB.composerText()) ?? '').includes('m5n2-b-after-exit'),
        'M5N2 cleared the restored rewind draft', 30_000)
      // The source Turn B walked away from still completes normally.
      const xRewindReleaseIndex = durableOf(sessionX).length
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const xTurn6Ends = await waitForTurnEnds(sessionX, xRewindReleaseIndex, 1, 'M5N2 the source Turn completed after the rewind')
      assert(xTurn6Ends[0]?.data?.reason?.kind === 'completed',
        `M5N2 the source Turn settled as ${JSON.stringify(xTurn6Ends[0]?.data?.reason)} after the rewind`)

      await assertHostIdentityKept(host, hostBefore, 'M5N2 Host after the fork, exit and Stop')
      await exitC1Client(clientB, 'M5N2 B')
      await stopC1Host(host)
      trace('m5n-02', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        wrapperPids: [clientA.child.pid, clientB.child.pid],
        sessionX,
        childId,
        forkDispatches: 1,
        forkCut: 'completed-prefix (turn 1)',
        sourceTurnKeptRunningThroughFork: true,
        remoteCommandRows: 'none (client-registry route)',
        childInheritedPrefixUserTexts: childUserTexts.length,
        childOwnTurnCommitted: true,
        sourceTurnCompletionAfterFork: 'completed',
        clientExitReleasesOnlyOwnReference: true,
        sourceTurnCompletionAfterExit: 'completed',
        secondClientCommittedAfterExit: true,
        explicitStop: 'aborted/user',
        rewoundChildId,
        rewindCut: 'turn 3 end (selected turn 4)',
        rewindDraftRestored: true,
        sourceTurnCompletionAfterRewind: 'completed',
      })
    }

    // M5N-03 (M5-N): a Client leaving a Session with a PENDING Host interaction
    // withdraws only its OWN presentation. The Host question is never
    // cancelled by that departure: the second admitted Client still answers
    // the SAME `callId`, the Host settles exactly once, and the Turn ends
    // normally. The reachable leave gesture while a Question owns the editor
    // seat is the Client EXIT (the modal does not accept a slash command), so
    // the local withdrawal is the exit's own teardown — never a Host cancel.
    {
      const { host, ready: hostReady, workRoot } = await startC1Host('question', 'm5n3-interaction')
      const hostBefore = await hostIdentityFacts(host)
      assert(hostBefore.hostPid === hostReady.pid, 'M5N3 the Host ready record does not own the Host identity')
      const { client: clientA, ready: aReady } = await startC1Client('M5N3 A')
      // A creates an EMPTY Session X with the real product `/new`; B joins the
      // SAME X before the Host is asked, so both modals are the ONE delivery.
      const aBoundary = clientA.records.length
      clientA.send('/new\r')
      const aOpen = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= aBoundary
          && record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && typeof record.openSessionId === 'string'
          && record.openSessionId !== ''
          && record.transport === 'connected'
          && record.surfaceMounted === true,
        'M5N3 Client A opened an empty Session',
        120_000,
      )
      const sessionX = aOpen.openSessionId
      assert(Number.isInteger(aReady.pid) && aReady.pid > 0 && aReady.pid !== hostBefore.hostPid,
        'M5N3 Client A published no live business PID distinct from the Host')
      const { client: clientB, ready: bReady } = await startC1Client('M5N3 B', {
        SPLIT_PROCESS_CLIENT_SESSION: sessionX,
      })
      const bOnX = await waitForSurfaceStatus(clientB,
        record => record.sessionOpen === true
          && record.openSessionId === sessionX
          && record.transport === 'connected'
          && record.surfaceMounted === true,
        'M5N3 Client B retained Session X')
      assertClientHostFacts(aOpen.host, hostBefore, 'M5N3 Client A')
      assertClientHostFacts(bOnX.host, hostBefore, 'M5N3 Client B')
      assert(aReady.pid !== bReady.pid, 'M5N3 the two Clients must be two different business PIDs')
      assert(clientA.child.pid !== clientB.child.pid, 'M5N3 the two Clients must use distinct script(1) wrappers')
      assertInteractionGate(clientA, 'M5N3 Client A')
      assertInteractionGate(clientB, 'M5N3 Client B')
      const pendingBefore = hostSessionEvents(dshHome, sessionX) ?? []
      assert(!pendingBefore.some(event => event.type === 'turn/start' || event.type === 'tool/call'
        || event.type === 'approval/asked'),
      'M5N3 Host Session X carried Host activity before the trigger')

      // The ONE trigger is A's real keyboard submission AFTER both Clients
      // were admitted and nothing was pending.
      const triggerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
      clientA.send('m5n3-interaction-trigger\r')
      const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
        'M5N3 the Host question tool/call', 120_000)
      assert(typeof call.data.callId === 'string' && call.data.callId !== '',
        'M5N3 the question tool/call carries no callId')
      const callId = call.data.callId
      await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-request' && event.sessionId === sessionX,
        'M5N3 the Host question request', 120_000)
      await clientA.waitForScreen('[1] Proceed', 'M5N3 A painted the question modal', 120_000)
      await clientB.waitForScreen('[1] Proceed', 'M5N3 B painted the question modal', 120_000)
      assert((await clientA.viewport()).join('\n').includes('Continue the C1 test?'),
        'M5N3 Client A painted no question text')
      assert((await clientB.viewport()).join('\n').includes('Continue the C1 test?'),
        'M5N3 Client B painted no question text')

      // A LEAVES the Session without answering. Nothing may reach the Host:
      // no answer, no cancel, no Turn end.
      const leaveIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
      const aPid = aReady.pid
      clientA.signalBusiness('SIGTERM')
      const aExit = await clientA.waitForExit(60_000)
      assert(aExit.code === 0 && aExit.signal === null,
        `M5N3 Client A exit was ${JSON.stringify(aExit)}`)
      await waitGone(aPid, 15_000)
      assert(!alive(aPid), 'M5N3 Client A survived its exit')
      await clientA.dispose()
      assert(alive(bReady.pid) && alive(hostBefore.hostPid), 'M5N3 A\'s departure killed the Host or Client B')
      assert((hostSessionEvents(dshHome, sessionX) ?? []).slice(leaveIndex)
        .every(event => event.type !== 'tool/result' && event.type !== 'turn/end'),
      'M5N3 A\'s departure settled the Host question or the Turn')
      assert(readC1WorkEvents(workRoot)
        .every(event => event.kind !== 'question-settled'),
      'M5N3 A\'s departure settled the Host question')
      await assertHostIdentityKept(host, hostBefore, 'M5N3 Host after A left')
      // B is still the answerer of the SAME Host delivery.
      await clientB.waitForScreen('[1] Proceed', 'M5N3 B still paints the answerable modal', 60_000)
      const answerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
      clientB.send('1')
      await clientB.waitForScreen('Review your answer before submit', 'M5N3 B question review', 30_000)
      clientB.send('\r')
      const settled = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-settled' && event.sessionId === sessionX,
        'M5N3 the Host question settled', 120_000)
      assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
        `M5N3 the Host received the wrong answer: ${JSON.stringify(settled.answers)}`)
      const result = await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
        event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
        'M5N3 the question tool result', 120_000)
      assert(result.data?.message?.isError !== true, 'M5N3 the answered question failed at the Host')
      const questionEnd = await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
        event => event.type === 'turn/end', 'M5N3 the question Turn ended', 120_000)
      assert(questionEnd.data?.reason?.kind === 'completed',
        `M5N3 the question Turn settled as ${JSON.stringify(questionEnd.data?.reason)} instead of a normal completion`)
      await clientB.waitForScreen('question answered', 'M5N3 B read the Host settlement', 120_000)
      // EXACTLY ONCE, read from the final durable state: A's departure neither
      // answered nor cancelled, and B's ONE decision is the ONE result.
      const finalEvents = hostSessionEvents(dshHome, sessionX) ?? []
      assert(finalEvents.filter(event => event.type === 'tool/result'
        && String(event.data?.message?.toolCallId) === callId).length === 1,
      'M5N3 the Host question produced more than one tool result')
      const finalProofs = readC1WorkEvents(workRoot)
      assert(finalProofs.filter(event => event.kind === 'question-request' && event.sessionId === sessionX).length === 1,
        'M5N3 the Host asked more than once')
      assert(finalProofs.filter(event => event.kind === 'question-settled' && event.sessionId === sessionX).length === 1,
        'M5N3 the Host settled the question more than once')
      assert(finalEvents.every(event => !(event.type === 'turn/end' && event.data?.reason?.kind === 'aborted')),
        'M5N3 the question Turn was aborted instead of settling normally')
      await assertHostIdentityKept(host, hostBefore, 'M5N3 Host after the settlement')
      await exitC1Client(clientB, 'M5N3 B')
      await stopC1Host(host)
      trace('m5n-03', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        wrapperPids: [clientA.child.pid, clientB.child.pid],
        sessionX,
        callId,
        dualModalPainted: true,
        leavingClientExitCode: aExit.code,
        departureSettledNothing: true,
        secondClientAnswered: 'Proceed',
        hostToolResults: 1,
        hostQuestionSettlements: 1,
        turnSettlement: 'completed',
      })
    }

    // M5D-01 (M5-D): INDEPENDENT Client lifecycle on ONE real Host with TWO
    // real Surface Clients. Every D scene starts its OWN isolated Host and
    // two `script(1)` PTYs (distinct business PIDs, wrappers and PTYs) and
    // proves the same invariant from a different reachable gesture: A leaves
    // (exit / SIGKILL / SIGHUP / transport rollover / same-PID HMR /
    // navigation). The cross-build `/reload-client` sibling is the upgrade
    // lane's U08, not a D scene. In every D scene B's own Context, root
    // fiber, transport generation, surface revision, Session X and Host
    // identity stay unchanged, and the Host's ORIGINAL held Turn survives
    // A's gesture.
    // The fixture is the ONLY authority for the held Turn and the Question,
    // so a timer, a replayed write or a cached transcript cannot produce
    // these facts.
    //
    //   D-01  A `/exit`; B keeps the original running X and writes after it
    //         completes.
    //   D-02  A SIGKILL (kernel path, NO graceful inventory); B keeps X; a
    //         NEW A' cold-attaches without replaying the accepted prompt.
    //   D-03  A's physical mux drop rolls the official generation over; B is
    //         untouched and the original Turn still completes. This scene
    //         does NOT claim the T66 lost-ACK taxonomy: it has no in-flight
    //         ACK-loss input.
    //   D-04  A same-PID surface HMR: the old revision is retired before the
    //         new one is ready and B's own surface never changes.
    //   D-05  A HMR while B holds the SAME pending Host Question: A's NEW
    //         revision repaints the pending frame, B settles the same callId
    //         exactly once and A's modal is withdrawn by the settlement.
    //   D-06  Host SIGKILL disconnects BOTH Clients; a new C cold-discovers
    //         the NEXT Host and neither old Client treats it as a
    //         continuation.
    //   D-07  A SIGHUP (process failure, never the graceful inventory); B
    //         keeps the running original X.
    //   D-08  N-composite: A navigates X -> Y through the real `/new` while
    //         X's original Turn is held, then exits from Y; B keeps X and the
    //         Host completes the ORIGINAL Turn.
    /** The durable events of one Host Session (empty before its log exists). */
    const durableOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []
    /** The plain text of one durable/inbox message (bounded, never a dump). */
    const textOf = message => (message?.content ?? [])
      .map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('')
    /** Type a prompt through the PAINTED composer, then submit it. */
    const submitPrompt = async (client, text) => {
      client.send(text)
      await client.waitForComposerDraft(text)
      client.send('\r')
    }
    /** Wait for the Nth `turn/end` at or after one durable boundary. */
    const waitForTurnEnds = async (sessionId, afterIndex, count, label) => {
      await waitForCondition(
        () => durableOf(sessionId).slice(afterIndex).filter(event => event.type === 'turn/end').length >= count,
        label,
        120_000,
      )
      return durableOf(sessionId).slice(afterIndex).filter(event => event.type === 'turn/end')
    }
    /**
     * The B-side non-interference witness of ONE operation. From the record
     * boundary taken BEFORE A's gesture, B's own status tuple may not change
     * at all: the Host status projection dedupes an identical
     * (transport, generation, session, revision, fiber) key, so "no NEW
     * record" is the correct fact for "B did not change". B's current-PTY
     * readback and B's later Host-accepted write are the independent
     * after-liveness proof; no heartbeat is invented here.
     */
    const assertSecondClientKept = (client, before, fromIndex, label) => {
      assert(before !== undefined, `${label}: Client B has no status boundary`)
      // Read the complete record tail first: the 25ms poller must not decide
      // this witness from a stale snapshot. The scene ALSO re-runs this scan
      // against the SAME boundary after B's own Host-accepted write, so a
      // record emitted late in A's operation window is still covered.
      client.readRecords()
      for (const record of client.records.slice(fromIndex).filter(entry => entry.m4b2s === 'surface-status')) {
        assert(record.pid === before.pid, `${label}: Client B PID changed`)
        assert(record.rootFiberUid === before.rootFiberUid, `${label}: Client B root fiber changed`)
        assert(record.generationId === before.generationId, `${label}: Client B transport generation changed`)
        assert(record.surfaceRevision === before.surfaceRevision, `${label}: Client B surface revision changed`)
        assert(record.surfaceFiberUid === before.surfaceFiberUid, `${label}: Client B runner fiber changed`)
        assert(record.surfaceMounted === true, `${label}: Client B lost its mounted surface`)
        assert(record.transport === 'connected', `${label}: Client B transport became ${String(record.transport)}`)
        assert(record.sessionOpen === true, `${label}: Client B lost its open Session`)
        assert(record.openSessionId === before.openSessionId, `${label}: Client B Session changed`)
        assert(record.host?.instanceId === before.host?.instanceId, `${label}: Client B Host instance changed`)
      }
      assert(client.records.slice(fromIndex).every(record => record.m4b2s !== 'client-closed'),
        `${label}: Client B emitted a Client owner release`)
      assert(alive(before.pid), `${label}: Client B business process is not alive`)
    }
    /** The graceful `/exit` inventory: code 0 and every owned Client row 0. */
    const exitClientWithInventory = async (client, label) => {
      client.send('/exit\r')
      const exit = await client.waitForExit(60_000)
      assert(exit.code === 0 && exit.signal === null, `${label} exit was ${JSON.stringify(exit)}`)
      const closed = await client.waitFor(record => record.m4b2s === 'client-closed', `${label} owner inventory`, 30_000)
      assert(closed.pid === client.records.find(record => record.m4a0 === 'ready')?.pid,
        `${label} owner inventory came from another process`)
      assert(closed.sessionOpen === false, `${label} still reported an open Session`)
      assert(closed.surfaceMounted === false, `${label} still reported a mounted surface`)
      for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
        assert(closed.owners?.[owner] === 0, `${label} left ${owner} owner alive`)
      }
      await client.dispose()
      return { exit, closed }
    }
    /**
     * Stop one D scene Host through its OWN owner path and assert the clean
     * shutdown exit. The older `stopC1Host` is a swallowing backstop for the
     * T/M5N cases; the plan's per-scene order ends with a clean Host stop, so
     * the M5-D scenes must not hide a failed owner shutdown.
     */
    const stopDHost = async (host, label) => {
      if (host.exited) {
        assert(host.exitResult?.code === 0,
          `${label} exited before its owner shutdown: ${JSON.stringify(host.exitResult)}`)
        return
      }
      const exit = await host.shutdown()
      assert(exit.code === 0, `${label} owner shutdown exited ${JSON.stringify(exit)}`)
    }

    // ── D-01: A `/exit` while the ORIGINAL Turn runs, B keeps X ──────────
    {
      const releaseBarrier = join(workDir, 'm5d1-long-turn.release')
      const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5d1-exit', {
        C1_HOLD_LONG_TURN: releaseBarrier,
      })
      const hostBefore = await hostIdentityFacts(host)
      assert(hostBefore.hostPid === hostReady.pid, 'M5D-01 the Host ready record does not own the Host identity')
      const { client: clientA, ready: aReady } = await startC1Client('M5D-01 A')
      const sessionX = await openC1Session(clientA, 'm5d1-x-held', 'M5D-01 A')
      const held = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5D-01 X Turn held', 120_000)
      assert(held.agentStatus === 'running',
        `M5D-01 the Host Agent was ${JSON.stringify(held.agentStatus)} while X was held`)
      await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5D-01 X turn/start', 120_000)
      const { client: clientB, ready: bReady } = await startC1Client('M5D-01 B', {
        SPLIT_PROCESS_CLIENT_SESSION: sessionX,
      })
      const bOnX = await waitForSurfaceStatus(clientB,
        record => record.sessionOpen === true && record.openSessionId === sessionX
          && record.transport === 'connected' && record.surfaceMounted === true,
        'M5D-01 B retained Session X')
      assertClientHostFacts(bOnX.host, hostBefore, 'M5D-01 B')
      // Two REAL business PIDs over two distinct `script(1)` wrappers/PTYs.
      assert(Number.isInteger(aReady.pid) && aReady.pid > 0 && aReady.pid !== hostBefore.hostPid,
        'M5D-01 Client A published no live business PID distinct from the Host')
      assert(Number.isInteger(bReady.pid) && bReady.pid > 0 && bReady.pid !== hostBefore.hostPid,
        'M5D-01 Client B published no live business PID distinct from the Host')
      assert(aReady.pid !== bReady.pid, 'M5D-01 the two Clients must be two different business PIDs')
      assert(clientA.child.pid !== clientB.child.pid, 'M5D-01 the two Clients must use distinct script(1) wrappers')
      await clientB.waitForScreen('long-turn started', 'M5D-01 B read the running X stream', 120_000)
      const bBefore = lastSurfaceStatus(clientB)
      const bBoundary = clientB.records.length
      const durableBoundary = durableOf(sessionX).length
      // A's REAL keyboard `/exit` through the painted editor while the Host
      // Turn is held: the graceful path, so the full owner inventory exists.
      const { exit: aExit, closed: aClosed } = await exitClientWithInventory(clientA, 'M5D-01 A')
      assert(aClosed.pid === aReady.pid, 'M5D-01 the owner inventory did not come from Client A')
      await waitGone(aReady.pid, 15_000)
      assert(!alive(aReady.pid), 'M5D-01 Client A survived its exit')
      assert(alive(bReady.pid) && alive(hostBefore.hostPid), 'M5D-01 A\'s exit killed the Host or Client B')
      assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-01 after A exit')
      assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
        'M5D-01 A\'s exit settled or cancelled the running Host Turn')
      assert(!existsSync(releaseBarrier), 'M5D-01 the hold barrier was released before the original Turn completed')
      await assertHostIdentityKept(host, hostBefore, 'M5D-01 Host after A exit')
      // Release the ONE hold: the ORIGINAL Turn completes and B reads it.
      const releaseIndex = durableOf(sessionX).length
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const ends = await waitForTurnEnds(sessionX, releaseIndex, 1, 'M5D-01 the original X Turn completed')
      assert(ends[0]?.data?.reason?.kind === 'completed',
        `M5D-01 the original X Turn settled as ${JSON.stringify(ends[0]?.data?.reason)}`)
      await clientB.waitForScreen('long-turn answer 1', 'M5D-01 B read the original Turn settlement', 120_000)
      assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d1-x-held').length === 1,
        'M5D-01 the accepted prompt was replayed or lost across A\'s exit')
      // B's OWN Host-accepted write on the SAME Session after the lifecycle.
      const writeIndex = durableOf(sessionX).length
      await submitPrompt(clientB, 'm5d1-b-after-exit')
      await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
        event => event.type === 'user/message' && textOf(event.data) === 'm5d1-b-after-exit',
        'M5D-01 B committed after A exited', 120_000)
      const bEnd = await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
        event => event.type === 'turn/end', 'M5D-01 B\'s own Turn settled', 120_000)
      assert(bEnd.data?.reason?.kind === 'completed', 'M5D-01 B\'s own Turn did not complete normally')
      await clientB.waitForScreen('long-turn answer 2', 'M5D-01 B read its own Turn settlement', 120_000)
      assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d1-b-after-exit').length === 1,
        'M5D-01 B\'s own prompt committed more than once')
      // Final scan of the WHOLE B status tail from the pre-gesture boundary:
      // a record emitted late in A's operation window is still covered.
      assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-01 at the end of the scene')
      assert(durableOf(sessionX).every(event => !(event.type === 'turn/end' && event.data?.reason?.kind === 'aborted')),
        'M5D-01 a Turn was aborted without an explicit user gesture')
      await assertHostIdentityKept(host, hostBefore, 'M5D-01 Host after the original Turn')
      await exitC1Client(clientB, 'M5D-01 B')
      await stopDHost(host, 'M5D-01 Host')
      trace('m5d-01', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        wrapperPids: [clientA.child.pid, clientB.child.pid],
        sessionX,
        aExitCode: aExit.code,
        aOwnersReleased: true,
        originalTurnSettlement: 'completed',
        bOwnReadback: true,
        bOwnTurn: 'completed',
      })
    }

    // ── D-02: A SIGKILL (kernel path), B keeps X, A' cold-attaches ────────
    {
      const releaseBarrier = join(workDir, 'm5d2-long-turn.release')
      const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5d2-hard-kill', {
        C1_HOLD_LONG_TURN: releaseBarrier,
      })
      const hostBefore = await hostIdentityFacts(host)
      assert(hostBefore.hostPid === hostReady.pid, 'M5D-02 the Host ready record does not own the Host identity')
      const { client: clientA, ready: aReady } = await startC1Client('M5D-02 A')
      const sessionX = await openC1Session(clientA, 'm5d2-x-held', 'M5D-02 A')
      const held = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5D-02 X Turn held', 120_000)
      assert(held.agentStatus === 'running',
        `M5D-02 the Host Agent was ${JSON.stringify(held.agentStatus)} while X was held`)
      await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5D-02 X turn/start', 120_000)
      const { client: clientB, ready: bReady } = await startC1Client('M5D-02 B', {
        SPLIT_PROCESS_CLIENT_SESSION: sessionX,
      })
      const bOnX = await waitForSurfaceStatus(clientB,
        record => record.sessionOpen === true && record.openSessionId === sessionX
          && record.transport === 'connected' && record.surfaceMounted === true,
        'M5D-02 B retained Session X')
      assertClientHostFacts(bOnX.host, hostBefore, 'M5D-02 B')
      assert(aReady.pid !== bReady.pid, 'M5D-02 the two Clients must be two different business PIDs')
      assert(clientA.child.pid !== clientB.child.pid, 'M5D-02 the two Clients must use distinct script(1) wrappers')
      await clientB.waitForScreen('long-turn started', 'M5D-02 B read the running X stream', 120_000)
      const bBefore = lastSurfaceStatus(clientB)
      const bBoundary = clientB.records.length
      const durableBoundary = durableOf(sessionX).length
      // A REAL SIGKILL to the BUSINESS PID (never the `script(1)` wrapper):
      // the kernel terminates it, so no graceful disposer/inventory exists.
      clientA.signalBusiness('SIGKILL')
      await waitGone(aReady.pid, 15_000)
      assert(!alive(aReady.pid), 'M5D-02 Client A survived SIGKILL')
      await clientA.waitForExit(60_000)
      clientA.readRecords()
      assert(clientA.records.every(record => record.m4b2s !== 'client-closed'),
        'M5D-02 a SIGKILL cannot produce the graceful Client owner inventory')
      await clientA.dispose()
      assert(alive(bReady.pid) && alive(hostBefore.hostPid), 'M5D-02 A\'s SIGKILL killed the Host or Client B')
      assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-02 after A SIGKILL')
      assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
        'M5D-02 A\'s SIGKILL settled or cancelled the running Host Turn')
      assert(!existsSync(releaseBarrier), 'M5D-02 the hold barrier was released before the original Turn completed')
      await assertHostIdentityKept(host, hostBefore, 'M5D-02 Host after A SIGKILL')
      // Release the ORIGINAL Turn; B must read the Host's own settlement.
      const releaseIndex = durableOf(sessionX).length
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const ends = await waitForTurnEnds(sessionX, releaseIndex, 1, 'M5D-02 the original X Turn completed')
      assert(ends[0]?.data?.reason?.kind === 'completed',
        `M5D-02 the original X Turn settled as ${JSON.stringify(ends[0]?.data?.reason)}`)
      await clientB.waitForScreen('long-turn answer 1', 'M5D-02 B read the original Turn settlement', 120_000)
      // A' is a NEW real PTY/PID that COLD-attaches the same Session and Host.
      const { client: clientAPrime, ready: aPrimeReady } = await startC1Client('M5D-02 A-prime', {
        SPLIT_PROCESS_CLIENT_SESSION: sessionX,
      })
      const aPrimeOnX = await waitForSurfaceStatus(clientAPrime,
        record => record.sessionOpen === true && record.openSessionId === sessionX
          && record.transport === 'connected' && record.surfaceMounted === true,
        'M5D-02 A-prime cold-attached Session X')
      assertClientHostFacts(aPrimeOnX.host, hostBefore, 'M5D-02 A-prime')
      assert(Number.isInteger(aPrimeReady.pid) && aPrimeReady.pid > 0,
        'M5D-02 A-prime published no live business PID')
      assert(aPrimeReady.pid !== aReady.pid, 'M5D-02 the cold replacement reused the killed Client PID')
      assert(aPrimeReady.pid !== bReady.pid, 'M5D-02 the cold replacement reused Client B\'s PID')
      assert(clientAPrime.child.pid !== clientA.child.pid && clientAPrime.child.pid !== clientB.child.pid,
        'M5D-02 the cold replacement reused another Client\'s script(1) wrapper')
      await clientAPrime.waitForScreen('m5d2-x-held', 'M5D-02 A-prime cold history', 120_000)
      await clientAPrime.waitForScreen('long-turn answer 1', 'M5D-02 A-prime read the settled Turn', 120_000)
      assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d2-x-held').length === 1,
        'M5D-02 the cold attach replayed the accepted prompt')
      // B's independent Host-accepted write after the cold attach.
      const writeIndex = durableOf(sessionX).length
      await submitPrompt(clientB, 'm5d2-b-after-kill')
      await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
        event => event.type === 'user/message' && textOf(event.data) === 'm5d2-b-after-kill',
        'M5D-02 B committed after A was killed', 120_000)
      const bEnd = await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
        event => event.type === 'turn/end', 'M5D-02 B\'s own Turn settled', 120_000)
      assert(bEnd.data?.reason?.kind === 'completed', 'M5D-02 B\'s own Turn did not complete normally')
      await clientB.waitForScreen('long-turn answer 2', 'M5D-02 B read its own Turn settlement', 120_000)
      assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d2-b-after-kill').length === 1,
        'M5D-02 B\'s own prompt committed more than once')
      assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d2-x-held').length === 1,
        'M5D-02 the killed Client\'s accepted prompt was replayed')
      assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-02 at the end of the scene')
      await exitC1Client(clientAPrime, 'M5D-02 A-prime')
      await exitC1Client(clientB, 'M5D-02 B')
      await stopDHost(host, 'M5D-02 Host')
      trace('m5d-02', {
        hostPid: hostBefore.hostPid,
        killedClientPid: aReady.pid,
        clientBPid: bReady.pid,
        coldClientPid: aPrimeReady.pid,
        wrapperPids: [clientA.child.pid, clientAPrime.child.pid, clientB.child.pid],
        sessionX,
        killedPath: 'SIGKILL (kernel): no graceful inventory claimed',
        originalTurnSettlement: 'completed',
        promptCommitsAfterColdAttach: 1,
        bOwnTurn: 'completed',
      })
    }

    // ── D-03: only A's official transport generation rolls over ───────────
    {
      const releaseBarrier = join(workDir, 'm5d3-long-turn.release')
      const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5d3-rollover', {
        C1_HOLD_LONG_TURN: releaseBarrier,
      })
      const hostBefore = await hostIdentityFacts(host)
      assert(hostBefore.hostPid === hostReady.pid, 'M5D-03 the Host ready record does not own the Host identity')
      const { client: clientA, ready: aReady } = await startC1Client('M5D-03 A')
      const sessionX = await openC1Session(clientA, 'm5d3-x-held', 'M5D-03 A')
      const held = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5D-03 X Turn held', 120_000)
      assert(held.agentStatus === 'running',
        `M5D-03 the Host Agent was ${JSON.stringify(held.agentStatus)} while X was held`)
      await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5D-03 X turn/start', 120_000)
      const { client: clientB, ready: bReady } = await startC1Client('M5D-03 B', {
        SPLIT_PROCESS_CLIENT_SESSION: sessionX,
      })
      const bOnX = await waitForSurfaceStatus(clientB,
        record => record.sessionOpen === true && record.openSessionId === sessionX
          && record.transport === 'connected' && record.surfaceMounted === true,
        'M5D-03 B retained Session X')
      assertClientHostFacts(bOnX.host, hostBefore, 'M5D-03 B')
      assert(aReady.pid !== bReady.pid, 'M5D-03 the two Clients must be two different business PIDs')
      assert(clientA.child.pid !== clientB.child.pid, 'M5D-03 the two Clients must use distinct script(1) wrappers')
      await clientB.waitForScreen('long-turn started', 'M5D-03 B read the running X stream', 120_000)
      const aBefore = lastSurfaceStatus(clientA)
      assert(typeof aBefore?.generationId === 'number',
        'M5D-03 Client A never observed an official transport generation')
      const bBefore = lastSurfaceStatus(clientB)
      const bBoundary = clientB.records.length
      const durableBoundary = durableOf(sessionX).length
      const aBoundary = clientA.records.length
      // Qualification-only input: SIGUSR1 drops A's REAL physical mux socket.
      // The PASS authority is NOT that trace: it is the official new
      // Connection generation with the exact Session re-adopted below.
      clientA.signalBusiness('SIGUSR1')
      await clientA.waitFor(
        record => clientA.records.indexOf(record) >= aBoundary
          && record.m4b2s === 'qualification' && record.op === 'drop-websocket',
        'M5D-03 the qualification mux drop was injected',
        30_000,
      )
      // The official Node Connection loop leaves `connected` through its
      // retry state and clears the generation; the literal `disconnected`
      // label is the offline/network-unavailable branch and is not reachable
      // on a local mux drop. Bind the generation truth: the old official
      // generation is GONE before the replacement generation is accepted.
      const dropped = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= aBoundary
          && record.m4b2s === 'surface-status'
          && record.transport !== 'connected'
          && record.generationId === undefined,
        'M5D-03 A observed the official lost generation',
        60_000,
      )
      assert(dropped.surfaceRevision === aBefore.surfaceRevision,
        'M5D-03 the transport loss replaced A\'s surface revision')
      const rolled = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= aBoundary
          && record.m4b2s === 'surface-status'
          && typeof record.generationId === 'number'
          && record.generationId !== aBefore.generationId
          && record.transport === 'connected'
          && record.sessionOpen === true
          && record.openSessionId === sessionX
          && record.surfaceMounted === true,
        'M5D-03 A reconnected on a NEW official generation with X current',
        120_000,
      )
      assertClientHostFacts(rolled.host, hostBefore, 'M5D-03 A after the rollover')
      assert(rolled.pid === aBefore.pid && rolled.rootFiberUid === aBefore.rootFiberUid,
        'M5D-03 the transport rollover replaced the Client process or root Context')
      assert(rolled.surfaceRevision === aBefore.surfaceRevision,
        'M5D-03 the transport rollover replaced A\'s surface revision')
      assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-03 during A rollover')
      assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
        'M5D-03 A\'s rollover settled or cancelled the running Host Turn')
      assert(!existsSync(releaseBarrier), 'M5D-03 the hold barrier was released during the rollover')
      await assertHostIdentityKept(host, hostBefore, 'M5D-03 Host after A rollover')
      // Release: A's CURRENT generation and B both read the ORIGINAL Turn.
      const releaseIndex = durableOf(sessionX).length
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const ends = await waitForTurnEnds(sessionX, releaseIndex, 1, 'M5D-03 the original X Turn completed')
      assert(ends[0]?.data?.reason?.kind === 'completed',
        `M5D-03 the original X Turn settled as ${JSON.stringify(ends[0]?.data?.reason)}`)
      await clientA.waitForScreen('long-turn answer 1', 'M5D-03 A read the settlement on the new generation', 120_000)
      await clientB.waitForScreen('long-turn answer 1', 'M5D-03 B read the original Turn settlement', 120_000)
      const writeIndex = durableOf(sessionX).length
      await submitPrompt(clientB, 'm5d3-b-after-rollover')
      await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
        event => event.type === 'user/message' && textOf(event.data) === 'm5d3-b-after-rollover',
        'M5D-03 B committed after A rolled over', 120_000)
      const bEnd = await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
        event => event.type === 'turn/end', 'M5D-03 B\'s own Turn settled', 120_000)
      assert(bEnd.data?.reason?.kind === 'completed', 'M5D-03 B\'s own Turn did not complete normally')
      await clientB.waitForScreen('long-turn answer 2', 'M5D-03 B read its own Turn settlement', 120_000)
      assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d3-b-after-rollover').length === 1,
        'M5D-03 B\'s own prompt committed more than once')
      assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d3-x-held').length === 1,
        'M5D-03 A\'s accepted prompt was replayed by the rollover')
      assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-03 at the end of the scene')
      const { exit: aExit } = await exitClientWithInventory(clientA, 'M5D-03 A')
      await exitC1Client(clientB, 'M5D-03 B')
      await stopDHost(host, 'M5D-03 Host')
      trace('m5d-03', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        wrapperPids: [clientA.child.pid, clientB.child.pid],
        sessionX,
        generationBefore: aBefore.generationId,
        generationAfter: rolled.generationId,
        rolloverInjection: 'qualification SIGUSR1 (physical mux socket)',
        lossObserved: dropped.transport,
        lostGeneration: 'undefined (old official generation invalidated)',
        officialReconnect: true,
        bGeneration: bBefore.generationId,
        originalTurnSettlement: 'completed',
        aExitCode: aExit.code,
        lostAckTaxonomyClaimed: false,
      })
    }

    // ── D-04: A same-PID HMR, B's whole lifecycle untouched ───────────────
    {
      const releaseBarrier = join(workDir, 'm5d4-long-turn.release')
      const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5d4-hmr', {
        C1_HOLD_LONG_TURN: releaseBarrier,
      })
      const hostBefore = await hostIdentityFacts(host)
      assert(hostBefore.hostPid === hostReady.pid, 'M5D-04 the Host ready record does not own the Host identity')
      const { client: clientA, ready: aReady } = await startC1Client('M5D-04 A', { SPLIT_PROCESS_CLIENT_HMR_PROBE: '1' })
      const sessionX = await openC1Session(clientA, 'm5d4-x-held', 'M5D-04 A')
      const held = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5D-04 X Turn held', 120_000)
      assert(held.agentStatus === 'running',
        `M5D-04 the Host Agent was ${JSON.stringify(held.agentStatus)} while X was held`)
      await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5D-04 X turn/start', 120_000)
      const { client: clientB, ready: bReady } = await startC1Client('M5D-04 B', {
        SPLIT_PROCESS_CLIENT_SESSION: sessionX,
      })
      const bOnX = await waitForSurfaceStatus(clientB,
        record => record.sessionOpen === true && record.openSessionId === sessionX
          && record.transport === 'connected' && record.surfaceMounted === true,
        'M5D-04 B retained Session X')
      assertClientHostFacts(bOnX.host, hostBefore, 'M5D-04 B')
      assert(aReady.pid !== bReady.pid, 'M5D-04 the two Clients must be two different business PIDs')
      assert(clientA.child.pid !== clientB.child.pid, 'M5D-04 the two Clients must use distinct script(1) wrappers')
      await clientB.waitForScreen('long-turn started', 'M5D-04 B read the running X stream', 120_000)
      const aBefore = lastSurfaceStatus(clientA)
      assert(aBefore !== undefined && aBefore.surfaceMounted === true && aBefore.sessionOpen === true,
        'M5D-04 Client A has no mounted status boundary')
      const bBefore = lastSurfaceStatus(clientB)
      const bBoundary = clientB.records.length
      const durableBoundary = durableOf(sessionX).length
      const hmrFrom = clientA.records.length
      // Qualification-only same-PID HMR: SIGUSR2 retires and remounts the
      // surface on A's SAME PID/root/transport while B stays live.
      clientA.signalBusiness('SIGUSR2')
      const start = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= hmrFrom
          && record.m4b2s === 'qualification' && record.op === 'hmr-revision-start',
        'M5D-04 HMR start',
        60_000,
      )
      assert(Number.isInteger(start.revision), 'M5D-04 the HMR start named no replacement revision')
      await waitForSurfaceStatus(clientA,
        record => record.surfaceRevision === aBefore.surfaceRevision && record.surfaceMounted === false,
        'M5D-04 the old surface retired first',
        60_000,
      )
      await clientA.waitFor(
        record => clientA.records.indexOf(record) >= hmrFrom
          && record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired',
        'M5D-04 the old revision retired',
        120_000,
      )
      const ready = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= hmrFrom
          && record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready',
        'M5D-04 the replacement revision is ready',
        180_000,
      )
      assert(ready.revision === start.revision, 'M5D-04 the ready record named another revision')
      const after = await waitForSurfaceStatus(clientA,
        record => record.surfaceRevision === ready.revision && record.surfaceMounted === true,
        'M5D-04 the replacement surface is mounted',
        120_000,
      )
      assert(after.pid === aBefore.pid, 'M5D-04 HMR changed the Client PID')
      assert(after.rootFiberUid === aBefore.rootFiberUid, 'M5D-04 HMR changed the Client root Context fiber')
      assert(after.generationId === aBefore.generationId, 'M5D-04 HMR changed the transport generation')
      assert(after.surfaceRevision !== aBefore.surfaceRevision, 'M5D-04 the surface revision did not change')
      assert(after.surfaceFiberUid !== aBefore.surfaceFiberUid, 'M5D-04 the runner fiber did not change')
      assert(after.sessionOpen === true && after.openSessionId === sessionX,
        'M5D-04 the new revision did not re-adopt the exact Session')
      assert(after.owners?.typert === 1 && after.owners?.connection === 1 && after.owners?.remote === 1
        && after.owners?.fileUpload === 1 && after.owners?.sessions === 1 && after.owners?.jobs === 1,
      `M5D-04 duplicate/absent Domain owners after HMR: ${JSON.stringify(after.owners)}`)
      // The retired-before-mounted ORDER is read from the record stream: the
      // old revision must be unmounted before ANY new-revision mount, so the
      // two revisions never own A's PTY at the same time.
      const records = clientA.records
      const indexOfOp = op => records.findIndex(record => record.m4b2s === 'qualification' && record.op === op)
      const startIndex = indexOfOp('hmr-revision-start')
      const retiredIndex = indexOfOp('hmr-revision-retired')
      const readyIndex = indexOfOp('hmr-revision-ready')
      const oldUnmountedIndex = records.findIndex(record => record.m4b2s === 'surface-status'
        && record.surfaceRevision === aBefore.surfaceRevision && record.surfaceMounted === false)
      const newMountedIndex = records.findIndex(record => record.m4b2s === 'surface-status'
        && record.surfaceRevision === ready.revision && record.surfaceMounted === true)
      assert(startIndex >= 0 && startIndex < oldUnmountedIndex,
        'M5D-04 the replacement started before the old surface was unmounted')
      assert(oldUnmountedIndex < newMountedIndex, 'M5D-04 the replacement surface mounted over a live old surface')
      assert(oldUnmountedIndex < retiredIndex && retiredIndex < readyIndex,
        'M5D-04 the old revision was not retired before the replacement became ready')
      assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-04 during A HMR')
      assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
        'M5D-04 A\'s HMR settled or cancelled the running Host Turn')
      assert(!existsSync(releaseBarrier), 'M5D-04 the hold barrier was released during HMR')
      await assertHostIdentityKept(host, hostBefore, 'M5D-04 Host after A HMR')
      const releaseIndex = durableOf(sessionX).length
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const ends = await waitForTurnEnds(sessionX, releaseIndex, 1, 'M5D-04 the original X Turn completed')
      assert(ends[0]?.data?.reason?.kind === 'completed',
        `M5D-04 the original X Turn settled as ${JSON.stringify(ends[0]?.data?.reason)}`)
      await clientA.waitForScreen('long-turn answer 1', 'M5D-04 the replacement revision read the settlement', 120_000)
      await clientB.waitForScreen('long-turn answer 1', 'M5D-04 B read the original Turn settlement', 120_000)
      const writeIndex = durableOf(sessionX).length
      await submitPrompt(clientB, 'm5d4-b-after-hmr')
      await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
        event => event.type === 'user/message' && textOf(event.data) === 'm5d4-b-after-hmr',
        'M5D-04 B committed after A HMR', 120_000)
      const bEnd = await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
        event => event.type === 'turn/end', 'M5D-04 B\'s own Turn settled', 120_000)
      assert(bEnd.data?.reason?.kind === 'completed', 'M5D-04 B\'s own Turn did not complete normally')
      await clientB.waitForScreen('long-turn answer 2', 'M5D-04 B read its own Turn settlement', 120_000)
      assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d4-b-after-hmr').length === 1,
        'M5D-04 B\'s own prompt committed more than once')
      assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d4-x-held').length === 1,
        'M5D-04 A\'s accepted prompt was replayed by HMR')
      assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-04 at the end of the scene')
      const { exit: aExit } = await exitClientWithInventory(clientA, 'M5D-04 A')
      await exitC1Client(clientB, 'M5D-04 B')
      await stopDHost(host, 'M5D-04 Host')
      trace('m5d-04', {
        hostPid: hostBefore.hostPid,
        clientAPid: aBefore.pid,
        clientBPid: bReady.pid,
        wrapperPids: [clientA.child.pid, clientB.child.pid],
        sessionX,
        revisionBefore: aBefore.surfaceRevision,
        revisionAfter: after.surfaceRevision,
        samePid: true,
        sameRootFiber: true,
        sameGeneration: true,
        retireBeforeReady: true,
        bIdentityKept: true,
        originalTurnSettlement: 'completed',
        aExitCode: aExit.code,
      })
    }

    // ── D-05: A HMR while B holds the SAME pending Host Question ──────────
    {
      const { host, ready: hostReady, workRoot } = await startC1Host('question', 'm5d5-interaction')
      const hostBefore = await hostIdentityFacts(host)
      assert(hostBefore.hostPid === hostReady.pid, 'M5D-05 the Host ready record does not own the Host identity')
      // Deterministic observer boundary for the replacement mount: the
      // assembly hold pauses HMR BEFORE the new UI runtime is created. The
      // barrier is PRESENT for the initial mount (so it passes immediately)
      // and is removed only before the HMR gesture, so the replacement mount
      // is the one that actually blocks. Wiping the observer at that hold
      // cannot erase a new frame: none exists yet.
      const assemblyBarrier = join(workDir, 'm5d5-hmr-assembly.release')
      writeFileSync(assemblyBarrier, 'initial-mount\n', { mode: 0o600 })
      const { client: clientA, ready: aReady } = await startC1Client('M5D-05 A', {
        SPLIT_PROCESS_CLIENT_HMR_PROBE: '1',
        SPLIT_PROCESS_CLIENT_HOLD_ASSEMBLY: `domain@${assemblyBarrier}`,
      })
      // A creates the EMPTY Session X with the real product `/new`; B joins
      // the SAME X before the Host is asked, so both modals are the ONE
      // official delivery to two independent root interaction owners.
      const aBoundary = clientA.records.length
      clientA.send('/new\r')
      const aOpen = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= aBoundary
          && record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && typeof record.openSessionId === 'string'
          && record.openSessionId !== ''
          && record.transport === 'connected'
          && record.surfaceMounted === true,
        'M5D-05 A opened an empty Session X',
        120_000,
      )
      const sessionX = aOpen.openSessionId
      const { client: clientB, ready: bReady } = await startC1Client('M5D-05 B', {
        SPLIT_PROCESS_CLIENT_SESSION: sessionX,
      })
      const bOnX = await waitForSurfaceStatus(clientB,
        record => record.sessionOpen === true && record.openSessionId === sessionX
          && record.transport === 'connected' && record.surfaceMounted === true,
        'M5D-05 B retained Session X')
      assertClientHostFacts(aOpen.host, hostBefore, 'M5D-05 A')
      assertClientHostFacts(bOnX.host, hostBefore, 'M5D-05 B')
      assert(aReady.pid !== bReady.pid, 'M5D-05 the two Clients must be two different business PIDs')
      assert(clientA.child.pid !== clientB.child.pid, 'M5D-05 the two Clients must use distinct script(1) wrappers')
      assertInteractionGate(clientA, 'M5D-05 A')
      assertInteractionGate(clientB, 'M5D-05 B')
      assert(!durableOf(sessionX).some(event => event.type === 'turn/start' || event.type === 'tool/call'
        || event.type === 'approval/asked'),
      'M5D-05 Host Session X carried Host activity before the trigger')
      const triggerIndex = durableOf(sessionX).length
      clientA.send('m5d5-interaction-trigger\r')
      const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
        event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
        'M5D-05 the Host question tool/call', 120_000)
      assert(typeof call.data.callId === 'string' && call.data.callId !== '',
        'M5D-05 the question tool/call carries no callId')
      const callId = call.data.callId
      await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-request' && event.sessionId === sessionX,
        'M5D-05 the Host question request', 120_000)
      await clientA.waitForScreen('[1] Proceed', 'M5D-05 A painted the question modal', 120_000)
      await clientB.waitForScreen('[1] Proceed', 'M5D-05 B painted the question modal', 120_000)
      assert((await clientA.viewport()).join('\n').includes('Continue the C1 test?'),
        'M5D-05 Client A painted no question text')
      assert((await clientB.viewport()).join('\n').includes('Continue the C1 test?'),
        'M5D-05 Client B painted no question text')
      const aBefore = lastSurfaceStatus(clientA)
      assert(aBefore !== undefined && aBefore.surfaceMounted === true, 'M5D-05 Client A has no mounted status boundary')
      const bBefore = lastSurfaceStatus(clientB)
      const bBoundary = clientB.records.length
      const durableCheckpoint = durableOf(sessionX).length
      const hmrFrom = clientA.records.length
      // Release the initial-mount hold path: removing the barrier now makes
      // the NEXT mount (the replacement revision) pause at the domain hold.
      rmSync(assemblyBarrier, { force: true })
      // A retires and remounts its surface while the SAME Host Question is
      // pending. B is never touched and never pre-answers.
      clientA.signalBusiness('SIGUSR2')
      const start = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= hmrFrom
          && record.m4b2s === 'qualification' && record.op === 'hmr-revision-start',
        'M5D-05 HMR start',
        60_000,
      )
      await waitForSurfaceStatus(clientA,
        record => record.surfaceRevision === aBefore.surfaceRevision && record.surfaceMounted === false,
        'M5D-05 the old surface retired first',
        60_000,
      )
      await clientA.waitFor(
        record => clientA.records.indexOf(record) >= hmrFrom
          && record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired',
        'M5D-05 the old revision retired',
        120_000,
      )
      // The replacement mount is now DETERMINISTICALLY parked at the domain
      // assembly hold, after the old revision retired and BEFORE
      // createRemoteClientUiRuntime / the runner paint. Wipe this observer's
      // buffer here: no new frame can exist yet, so the reset can never
      // erase a legitimate paint (the record-poller race the old ui-mounted
      // sync had). Then release the barrier and wait for the new ready/frame.
      const assemblyHold = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= hmrFrom
          && record.m4b2s === 'qualification' && record.op === 'assembly-hold'
          && record.stage === 'domain',
        'M5D-05 the replacement paused before its UI creation',
        120_000,
      )
      assert(assemblyHold.barrier === assemblyBarrier, 'M5D-05 the replacement paused on another assembly barrier')
      await new Promise(resolveFlush => clientA.term.write('', resolveFlush))
      clientA.term.reset()
      await new Promise(resolveFlush => clientA.term.write('', resolveFlush))
      assert(!(await clientA.viewport()).join('\n').includes('[1] Proceed'),
        'M5D-05 the retired revision frame survived the observer reset')
      writeFileSync(assemblyBarrier, 'release\n', { mode: 0o600 })
      const ready = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= hmrFrom
          && record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready',
        'M5D-05 the replacement revision is ready',
        180_000,
      )
      assert(ready.revision === start.revision, 'M5D-05 the ready record named another revision')
      const after = await waitForSurfaceStatus(clientA,
        record => record.surfaceRevision === ready.revision && record.surfaceMounted === true,
        'M5D-05 the replacement surface is mounted',
        120_000,
      )
      assert(after.pid === aBefore.pid && after.rootFiberUid === aBefore.rootFiberUid
        && after.generationId === aBefore.generationId,
      'M5D-05 the HMR changed A\'s PID, root Context or transport generation')
      assert(after.sessionOpen === true && after.openSessionId === sessionX,
        'M5D-05 the replacement revision did not re-adopt Session X')
      // The NEW revision must PAINT the pending modal before B answers.
      await clientA.waitForScreen('[1] Proceed', 'M5D-05 the NEW revision repainted the pending Question', 180_000)
      assert((await clientA.viewport()).join('\n').includes('Continue the C1 test?'),
        'M5D-05 the new revision painted no question text')
      await clientB.waitForScreen('[1] Proceed', 'M5D-05 B still paints the answerable modal', 60_000)
      assert(!readC1WorkEvents(workRoot).some(event => event.kind === 'question-settled'),
        'M5D-05 A\'s HMR settled the Host question')
      assert(durableOf(sessionX).slice(durableCheckpoint).every(event => event.type !== 'tool/result'),
        'M5D-05 the pending question was settled before B answered')
      assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-05 during A HMR')
      await assertHostIdentityKept(host, hostBefore, 'M5D-05 Host after A HMR')
      // B answers the SAME Host delivery with the real keyboard flow.
      const answerIndex = durableOf(sessionX).length
      clientB.send('1')
      await clientB.waitForScreen('Review your answer before submit', 'M5D-05 B question review', 30_000)
      clientB.send('\r')
      const settled = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'question-settled' && event.sessionId === sessionX,
        'M5D-05 the Host question settled', 120_000)
      assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
        `M5D-05 the Host received the wrong answer: ${JSON.stringify(settled.answers)}`)
      const result = await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
        event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
        'M5D-05 the question tool result', 120_000)
      assert(result.data?.message?.isError !== true, 'M5D-05 the answered question failed at the Host')
      const questionEnd = await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
        event => event.type === 'turn/end', 'M5D-05 the question Turn ended', 120_000)
      assert(questionEnd.data?.reason?.kind === 'completed',
        `M5D-05 the question Turn settled as ${JSON.stringify(questionEnd.data?.reason)} instead of a normal completion`)
      // The NEW revision withdraws the modal only after the official
      // settlement; A never answered and never cancelled it.
      await clientA.waitForScreenGone('[1] Proceed', 'M5D-05 A\'s new revision withdrew the settled modal', 120_000)
      await clientB.waitForScreen('question answered', 'M5D-05 B read the Host settlement', 120_000)
      const finalEvents = durableOf(sessionX)
      assert(finalEvents.filter(event => event.type === 'tool/result'
        && String(event.data?.message?.toolCallId) === callId).length === 1,
      'M5D-05 the Host question produced more than one tool result')
      const finalProofs = readC1WorkEvents(workRoot)
      assert(finalProofs.filter(event => event.kind === 'question-request' && event.sessionId === sessionX).length === 1,
        'M5D-05 the Host asked more than once')
      assert(finalProofs.filter(event => event.kind === 'question-settled' && event.sessionId === sessionX).length === 1,
        'M5D-05 the Host settled the question more than once')
      assert(finalProofs.every(event => !(event.kind === 'question-failed' && event.sessionId === sessionX)),
        'M5D-05 A\'s HMR cancelled the Host question instead of leaving it pending for B')
      assert(finalEvents.every(event => !(event.type === 'turn/end' && event.data?.reason?.kind === 'aborted')),
        'M5D-05 the question Turn was aborted instead of settling normally')
      assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-05 at the end of the scene')
      await assertHostIdentityKept(host, hostBefore, 'M5D-05 Host after the settlement')
      await exitC1Client(clientA, 'M5D-05 A')
      await exitC1Client(clientB, 'M5D-05 B')
      await stopDHost(host, 'M5D-05 Host')
      trace('m5d-05', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        wrapperPids: [clientA.child.pid, clientB.child.pid],
        sessionX,
        callId,
        dualModalPainted: true,
        aRevisionBefore: aBefore.surfaceRevision,
        aRevisionAfter: after.surfaceRevision,
        newRevisionRepaintedPending: true,
        bAnsweredSameCallId: 'Proceed',
        hostToolResults: 1,
        hostQuestionSettlements: 1,
        aModalWithdrawn: true,
        turnSettlement: 'completed',
      })
    }

    // ── D-06: Host SIGKILL disconnects BOTH Clients, C is a NEW Host ──────
    {
      const releaseBarrier = join(workDir, 'm5d6-long-turn.release')
      const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5d6-host-kill', {
        C1_HOLD_LONG_TURN: releaseBarrier,
      })
      const hostBefore = await hostIdentityFacts(host)
      assert(hostBefore.hostPid === hostReady.pid, 'M5D-06 the Host ready record does not own the Host identity')
      const { client: clientA, ready: aReady } = await startC1Client('M5D-06 A')
      const sessionX = await openC1Session(clientA, 'm5d6-x-held', 'M5D-06 A')
      const held = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5D-06 X Turn held', 120_000)
      assert(held.agentStatus === 'running',
        `M5D-06 the Host Agent was ${JSON.stringify(held.agentStatus)} while X was held`)
      await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5D-06 X turn/start', 120_000)
      const { client: clientB, ready: bReady } = await startC1Client('M5D-06 B', {
        SPLIT_PROCESS_CLIENT_SESSION: sessionX,
      })
      const bOnX = await waitForSurfaceStatus(clientB,
        record => record.sessionOpen === true && record.openSessionId === sessionX
          && record.transport === 'connected' && record.surfaceMounted === true,
        'M5D-06 B retained Session X')
      assertClientHostFacts(bOnX.host, hostBefore, 'M5D-06 B')
      assert(aReady.pid !== bReady.pid, 'M5D-06 the two Clients must be two different business PIDs')
      assert(clientA.child.pid !== clientB.child.pid, 'M5D-06 the two Clients must use distinct script(1) wrappers')
      await clientB.waitForScreen('long-turn started', 'M5D-06 B read the running X stream', 120_000)
      const aBoundary = clientA.records.length
      const bBoundary = clientB.records.length
      const durableBoundary = durableOf(sessionX).length
      const hostPid = hostBefore.hostPid
      const liveHostPids = () => findIsolatedProcesses(dshHome).filter(pid => {
        try {
          return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').includes('local-host.mjs')
        } catch {
          return false
        }
      })
      // The COMMON failure: a REAL SIGKILL of the Host BUSINESS PID. This is
      // not a graceful Host stop, so no cleanup record is expected.
      process.kill(hostPid, 'SIGKILL')
      await waitGone(hostPid, 30_000)
      assert(!alive(hostPid), 'M5D-06 the Host survived SIGKILL')
      const aLost = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= aBoundary
          && record.m4b2s === 'surface-status'
          && record.transport !== 'connected'
          && record.generationId === undefined,
        'M5D-06 A observed the official lost generation',
        60_000,
      )
      const bLost = await clientB.waitFor(
        record => clientB.records.indexOf(record) >= bBoundary
          && record.m4b2s === 'surface-status'
          && record.transport !== 'connected'
          && record.generationId === undefined,
        'M5D-06 B observed the official lost generation',
        60_000,
      )
      for (const [lost, label] of [[aLost, 'A'], [bLost, 'B']]) {
        // The local Node Connection loop exits `connected` through its retry
        // state and clears the generation; the literal `disconnected` label
        // is the offline/network-unavailable branch and is not reachable
        // here. The generation-undefined loss record is the authoritative
        // "the old generation is gone" fact.
        assert(lost.transport !== 'connected',
          `M5D-06 Client ${label} still reported a connected transport after the Host kill`)
        assert(lost.generationId === undefined,
          `M5D-06 Client ${label} still reported a current generation after the Host kill`)
        assert(lost.host?.instanceId === hostBefore.instanceId,
          `M5D-06 Client ${label} dropped the dead Host identity before the replacement existed`)
      }
      assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
        'M5D-06 the pending Turn was reported as settled after a Host SIGKILL')
      assert(!hostAssistantHasText(durableOf(sessionX), 'long-turn answer'),
        'M5D-06 an answer was fabricated for the Turn lost in the Host SIGKILL')
      assert(!(await clientA.viewport()).join('\n').includes('long-turn answer'),
        'M5D-06 Client A painted a fabricated answer for the lost Turn')
      assert(!(await clientB.viewport()).join('\n').includes('long-turn answer'),
        'M5D-06 Client B painted a fabricated answer for the lost Turn')
      assert(!clientA.exited && !clientB.exited,
        'M5D-06 a Client treated the ordinary Host carrier loss as a fatal exit')
      // C is a genuinely NEW startup: its own cold discovery creates the
      // next Host instance, and the cold resume reads the durable history.
      const { client: clientC, ready: cReady } = await startC1Client('M5D-06 C', {
        SPLIT_PROCESS_CLIENT_SESSION: sessionX,
      })
      const newHost = cReady.host
      assert(newHost.hostPid !== hostBefore.hostPid, 'M5D-06 stale discovery reused the killed Host PID')
      assert(newHost.instanceId !== hostBefore.instanceId, 'M5D-06 stale discovery reused the killed Host instance')
      // Host identity is the PID/starttime pair plus the authenticated
      // instance identity. Different PIDs already prove a different process;
      // a standalone cross-process `/proc` starttime inequality is tick-
      // granular and is not a contract (two fast processes may share a
      // tick). Verify the replacement Host's OWN registry facts instead.
      const newRegistry = readJson(join(dshHome, 'run', 'dsh-pi-tui', hostBefore.scopeId, 'instance.json'))
      assert(newRegistry.instanceId === newHost.instanceId
        && newRegistry.hostPid === newHost.hostPid
        && newRegistry.hostStarttime === newHost.hostStarttime,
      `M5D-06 the replacement Host registry does not match its authenticated identity: ${JSON.stringify(newRegistry)}`)
      await clientC.waitForScreen('m5d6-x-held', 'M5D-06 C cold history', 120_000)
      const recovered = await waitForHostSessionEventAfter(dshHome, sessionX, durableBoundary,
        event => event.type === 'turn/end', 'M5D-06 the new Host settled the orphaned Turn', 120_000)
      assert(recovered.data?.reason?.kind === 'interrupted',
        `M5D-06 the cold resume settled the lost Turn as ${String(recovered.data?.reason?.kind)}`)
      assert(durableOf(sessionX).filter(event => event.type === 'turn/start').length === 1,
        'M5D-06 the recovered settlement does not belong to the single lost Turn')
      assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d6-x-held').length === 1,
        'M5D-06 the cold resume replayed the accepted prompt')
      assert(!hostAssistantHasText(durableOf(sessionX), 'long-turn answer'),
        'M5D-06 the cold resume fabricated an answer')
      assert(!(await clientC.viewport()).join('\n').includes('long-turn answer'),
        'M5D-06 the resumed surface painted a fabricated answer')
      // AFTER C is up, the OLD Clients must NOT adopt the replacement Host.
      // The official identity fence is authoritative: the replacement Host
      // publishes new launch material, the old Client's retry reads it, sees
      // a DIFFERENT instanceId, and fails closed with
      // HOST_IDENTITY_MISMATCH instead of re-binding. That fail-closed exit
      // is the truthful no-takeover outcome for "不得将新 Host 的
      // instanceId/generation 冒充原 Host continuation"; no silent
      // continuation is possible. The deterministic causal input is the
      // replacement Host's launch material (published before its ready), and
      // every retry after that point reads it.
      const oldClientOutcomes = []
      for (const [client, ready, label] of [[clientA, aReady, 'A'], [clientB, bReady, 'B']]) {
        await waitForCondition(() => {
          client.readRecords()
          return client.records.some(record => record.m4a0 === 'failure') || client.exited
        }, `M5D-06 Client ${label} classified the replacement Host`, 60_000)
        client.readRecords()
        const failure = client.records.find(record => record.m4a0 === 'failure')
        assert(failure?.code === 'HOST_IDENTITY_MISMATCH',
          `M5D-06 Client ${label} did not take the official replacement-Host refusal: ${JSON.stringify(failure)}`)
        assert(/launch\.json names a different Host instance|Host identity changed/u.test(String(failure.error)),
          `M5D-06 Client ${label} failed for another reason: ${String(failure.error)}`)
        const exit = await client.waitForExit(60_000)
        assert(exit.code === 1 && exit.signal === null,
          `M5D-06 Client ${label} fail-closed exit was ${JSON.stringify(exit)}`)
        client.readRecords()
        assert(client.records.every(record => record.host?.instanceId !== newHost.instanceId),
          `M5D-06 Client ${label} recorded the replacement Host identity`)
        assert(client.records.every(record => !(record.m4b2s === 'surface-status' && record.transport === 'connected'
          && record.generationId !== undefined
          && record.host?.instanceId === newHost.instanceId)),
        `M5D-06 Client ${label} adopted a generation of the replacement Host`)
        oldClientOutcomes.push(`${label}:HOST_IDENTITY_MISMATCH`)
        await waitGone(ready.pid, 15_000)
        await client.dispose()
      }
      assert(JSON.stringify(liveHostPids()) === JSON.stringify([newHost.hostPid]),
        `M5D-06 expected exactly the replacement Host owner, found ${JSON.stringify(liveHostPids())}`)
      assert(!existsSync(releaseBarrier), 'M5D-06 the hold barrier was released during the Host failure')
      // C leaves normally; the replacement Host keeps running (Client
      // lifetime is independent of the Host) and is stopped through its own
      // owner path afterwards.
      await exitC1Client(clientC, 'M5D-06 C')
      assert(alive(newHost.hostPid), 'M5D-06 the replacement Host died when C exited')
      // Stop the REPLACEMENT Host through its owner path. It is a new Host,
      // never a revived original instance.
      process.kill(newHost.hostPid, 'SIGTERM')
      await waitGone(newHost.hostPid, 30_000)
      assert(!alive(newHost.hostPid), 'M5D-06 the replacement Host survived the official SIGTERM')
      await seatFree(`\0dsh-pi-tui-h-${sceneScopeSuffix()}`, 15_000)
      await stopC1Host(host)
      trace('m5d-06', {
        hostPid,
        signal: 'SIGKILL',
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        wrapperPids: [clientA.child.pid, clientB.child.pid],
        sessionX,
        aObserved: aLost.transport,
        bObserved: bLost.transport,
        oldClientOutcomes,
        newHostPid: newHost.hostPid,
        newInstanceId: newHost.instanceId,
        orphanSettlement: 'interrupted',
        fabricatedSettlement: false,
        automaticTakeover: false,
      })
    }

    // ── D-07: A SIGHUP is a process failure, B keeps the running X ────────
    {
      const releaseBarrier = join(workDir, 'm5d7-long-turn.release')
      const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5d7-client-hup', {
        C1_HOLD_LONG_TURN: releaseBarrier,
      })
      const hostBefore = await hostIdentityFacts(host)
      assert(hostBefore.hostPid === hostReady.pid, 'M5D-07 the Host ready record does not own the Host identity')
      const { client: clientA, ready: aReady } = await startC1Client('M5D-07 A')
      const sessionX = await openC1Session(clientA, 'm5d7-x-held', 'M5D-07 A')
      const held = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5D-07 X Turn held', 120_000)
      assert(held.agentStatus === 'running',
        `M5D-07 the Host Agent was ${JSON.stringify(held.agentStatus)} while X was held`)
      await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5D-07 X turn/start', 120_000)
      const { client: clientB, ready: bReady } = await startC1Client('M5D-07 B', {
        SPLIT_PROCESS_CLIENT_SESSION: sessionX,
      })
      const bOnX = await waitForSurfaceStatus(clientB,
        record => record.sessionOpen === true && record.openSessionId === sessionX
          && record.transport === 'connected' && record.surfaceMounted === true,
        'M5D-07 B retained Session X')
      assertClientHostFacts(bOnX.host, hostBefore, 'M5D-07 B')
      assert(aReady.pid !== bReady.pid, 'M5D-07 the two Clients must be two different business PIDs')
      assert(clientA.child.pid !== clientB.child.pid, 'M5D-07 the two Clients must use distinct script(1) wrappers')
      await clientB.waitForScreen('long-turn started', 'M5D-07 B read the running X stream', 120_000)
      const bBefore = lastSurfaceStatus(clientB)
      const bBoundary = clientB.records.length
      const durableBoundary = durableOf(sessionX).length
      // A REAL SIGHUP to the Client BUSINESS PID: the default disposition
      // terminates it, so this is NOT the graceful coordinator path and no
      // `client-closed` inventory may be expected.
      clientA.signalBusiness('SIGHUP')
      await waitGone(aReady.pid, 15_000)
      assert(!alive(aReady.pid), 'M5D-07 Client A survived SIGHUP')
      const aExit = await clientA.waitForExit(60_000)
      assert(aExit.code === 129 && aExit.signal === null,
        `M5D-07 SIGHUP wrapper exit was ${JSON.stringify(aExit)} (script -e maps SIGHUP to 128+1=129)`)
      clientA.readRecords()
      assert(clientA.records.every(record => record.m4b2s !== 'client-closed'),
        'M5D-07 the SIGHUP process-failure path fabricated a graceful owner inventory')
      await clientA.dispose()
      assert(alive(bReady.pid) && alive(hostBefore.hostPid), 'M5D-07 A\'s SIGHUP killed the Host or Client B')
      assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-07 after A SIGHUP')
      assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
        'M5D-07 A\'s SIGHUP settled or cancelled the running Host Turn')
      assert(!existsSync(releaseBarrier), 'M5D-07 the hold barrier was released before the original Turn completed')
      await assertHostIdentityKept(host, hostBefore, 'M5D-07 Host after A SIGHUP')
      const releaseIndex = durableOf(sessionX).length
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const ends = await waitForTurnEnds(sessionX, releaseIndex, 1, 'M5D-07 the original X Turn completed')
      assert(ends[0]?.data?.reason?.kind === 'completed',
        `M5D-07 the original X Turn settled as ${JSON.stringify(ends[0]?.data?.reason)}`)
      await clientB.waitForScreen('long-turn answer 1', 'M5D-07 B read the original Turn settlement', 120_000)
      assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d7-x-held').length === 1,
        'M5D-07 the accepted prompt was replayed or lost across A\'s SIGHUP')
      const writeIndex = durableOf(sessionX).length
      await submitPrompt(clientB, 'm5d7-b-after-hup')
      await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
        event => event.type === 'user/message' && textOf(event.data) === 'm5d7-b-after-hup',
        'M5D-07 B committed after A was HUPed', 120_000)
      const bEnd = await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
        event => event.type === 'turn/end', 'M5D-07 B\'s own Turn settled', 120_000)
      assert(bEnd.data?.reason?.kind === 'completed', 'M5D-07 B\'s own Turn did not complete normally')
      await clientB.waitForScreen('long-turn answer 2', 'M5D-07 B read its own Turn settlement', 120_000)
      assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d7-b-after-hup').length === 1,
        'M5D-07 B\'s own prompt committed more than once')
      assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-07 at the end of the scene')
      await exitC1Client(clientB, 'M5D-07 B')
      await stopDHost(host, 'M5D-07 Host')
      trace('m5d-07', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        wrapperPids: [clientA.child.pid, clientB.child.pid],
        sessionX,
        signal: 'SIGHUP',
        aWrapperExit: aExit,
        gracefulInventoryClaimed: false,
        originalTurnSettlement: 'completed',
        bOwnReadback: true,
      })
    }

    // ── D-08: N-composite X -> Y navigation, then A exits from Y ──────────
    {
      const releaseBarrier = join(workDir, 'm5d8-long-turn.release')
      const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5d8-navigation', {
        C1_HOLD_LONG_TURN: releaseBarrier,
      })
      const hostBefore = await hostIdentityFacts(host)
      assert(hostBefore.hostPid === hostReady.pid, 'M5D-08 the Host ready record does not own the Host identity')
      const { client: clientA, ready: aReady } = await startC1Client('M5D-08 A')
      const sessionX = await openC1Session(clientA, 'm5d8-x-held', 'M5D-08 A')
      const held = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5D-08 X Turn held', 120_000)
      assert(held.agentStatus === 'running',
        `M5D-08 the Host Agent was ${JSON.stringify(held.agentStatus)} while X was held`)
      await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5D-08 X turn/start', 120_000)
      // A's own OLD X frame must carry the unique prompt before the switch.
      await waitForCondition(async () => (await clientA.viewport()).join('\n').includes('m5d8-x-held'),
        'M5D-08 A painted the original X-only prompt', 120_000)
      const { client: clientB, ready: bReady } = await startC1Client('M5D-08 B', {
        SPLIT_PROCESS_CLIENT_SESSION: sessionX,
      })
      const bOnX = await waitForSurfaceStatus(clientB,
        record => record.sessionOpen === true && record.openSessionId === sessionX
          && record.transport === 'connected' && record.surfaceMounted === true,
        'M5D-08 B retained Session X')
      assertClientHostFacts(bOnX.host, hostBefore, 'M5D-08 B')
      assert(aReady.pid !== bReady.pid, 'M5D-08 the two Clients must be two different business PIDs')
      assert(clientA.child.pid !== clientB.child.pid, 'M5D-08 the two Clients must use distinct script(1) wrappers')
      await clientB.waitForScreen('long-turn started', 'M5D-08 B read the running X stream', 120_000)
      const bBefore = lastSurfaceStatus(clientB)
      const bBoundary = clientB.records.length
      const durableBoundary = durableOf(sessionX).length
      const xHeader = await waitForHostSessionHeader(dshHome, sessionX, 'M5D-08 X durable header')
      const sessionsBeforeNew = hostSessionLogCount(dshHome)
      // The N-gesture: the real `/new` while X's original Turn is RUNNING.
      // The pending-Question/Approval modal is NOT used here (the editor
      // seat forbids a lifecycle command under a pending interaction).
      const newBoundary = clientA.records.length
      clientA.send('/new\r')
      const aOnY = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= newBoundary
          && record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && typeof record.openSessionId === 'string'
          && record.openSessionId !== sessionX
          && record.transport === 'connected'
          && record.surfaceMounted === true,
        'M5D-08 A opened Session Y while X was held',
        120_000,
      )
      const sessionY = aOnY.openSessionId
      assertClientHostFacts(aOnY.host, hostBefore, 'M5D-08 A on Y')
      // A status record is NOT a painted frame. Y is empty, so its welcome
      // card names the EXACT Y id — the Y-only paint fact — and only then is
      // the X-only transcript absence asserted.
      await waitForCondition(async () => (await clientA.viewport()).join('\n').includes(sessionY),
        'M5D-08 A painted the NEW Y surface', 120_000)
      assert(!(await clientA.viewport()).join('\n').includes('m5d8-x-held'),
        'M5D-08 the X-only transcript survived the /new navigation')
      assert(!existsSync(releaseBarrier), 'M5D-08 the hold barrier was released during /new')
      const yHeader = await waitForHostSessionHeader(dshHome, sessionY, 'M5D-08 Y durable header')
      assert(hostSessionLogCount(dshHome) === sessionsBeforeNew + 1,
        `M5D-08 /new created ${String(hostSessionLogCount(dshHome) - sessionsBeforeNew)} durable Sessions, expected exactly 1`)
      assert(yHeader.cwd === xHeader.cwd,
        `M5D-08 the new Y Session Workspace is not the captured Host Workspace: ${String(yHeader.cwd)} != ${String(xHeader.cwd)}`)
      assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
        'M5D-08 the /new navigation ended or cancelled the running X Turn')
      // A exits from Y (its CURRENT Session) with the full owner inventory.
      const { exit: aExit } = await exitClientWithInventory(clientA, 'M5D-08 A')
      await waitGone(aReady.pid, 15_000)
      assert(!alive(aReady.pid), 'M5D-08 Client A survived its exit from Y')
      assert(alive(bReady.pid) && alive(hostBefore.hostPid), 'M5D-08 A\'s exit killed the Host or Client B')
      assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-08 after A navigated and exited')
      assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
        'M5D-08 A\'s exit from Y ended or cancelled the original X Turn')
      await assertHostIdentityKept(host, hostBefore, 'M5D-08 Host after A exited from Y')
      // The ORIGINAL X Turn — left twice (navigation, then exit) — completes
      // and B reads/writes the SAME Session X.
      const releaseIndex = durableOf(sessionX).length
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const ends = await waitForTurnEnds(sessionX, releaseIndex, 1, 'M5D-08 the original X Turn completed')
      assert(ends[0]?.data?.reason?.kind === 'completed',
        `M5D-08 the original X Turn settled as ${JSON.stringify(ends[0]?.data?.reason)}`)
      await clientB.waitForScreen('long-turn answer 1', 'M5D-08 B read the original Turn settlement', 120_000)
      assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d8-x-held').length === 1,
        'M5D-08 the accepted X prompt was replayed or lost')
      const writeIndex = durableOf(sessionX).length
      await submitPrompt(clientB, 'm5d8-b-after-navigation')
      await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
        event => event.type === 'user/message' && textOf(event.data) === 'm5d8-b-after-navigation',
        'M5D-08 B committed after A exited from Y', 120_000)
      const bEnd = await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
        event => event.type === 'turn/end', 'M5D-08 B\'s own Turn settled', 120_000)
      assert(bEnd.data?.reason?.kind === 'completed', 'M5D-08 B\'s own Turn did not complete normally')
      await clientB.waitForScreen('long-turn answer 2', 'M5D-08 B read its own Turn settlement', 120_000)
      assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d8-b-after-navigation').length === 1,
        'M5D-08 B\'s own prompt committed more than once')
      assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-08 at the end of the scene')
      // Y was a real ONE Host-created Session and stayed EMPTY of turns: A
      // never wrote there, it only released its own Y reference on exit.
      assert(durableOf(sessionY).every(event => event.type !== 'user/message'),
        'M5D-08 the empty Y Session received a message A never sent')
      await exitC1Client(clientB, 'M5D-08 B')
      await stopDHost(host, 'M5D-08 Host')
      trace('m5d-08', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        wrapperPids: [clientA.child.pid, clientB.child.pid],
        sessionX,
        sessionY,
        aExitCode: aExit.code,
        navigatedBeforeExit: true,
        aExitedFrom: 'Y',
        originalXTurnCompletion: 'completed',
        bOwnReadback: true,
        bOwnTurn: 'completed',
      })
    }
  } finally {
    await scene.dispose()
  }
}
