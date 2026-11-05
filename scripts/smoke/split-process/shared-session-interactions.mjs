/**
 * M5-B / M5-C: two REAL surface Clients on ONE Host Session, with the shared
 * interaction waterfall (Question and Approval) settled exactly once.
 *
 * M5-B proves the SAME Session X is retained by two concurrently admitted
 * Clients: shared history/stream, the shared pending inbox, the official
 * empty-draft Ctrl+S steer of the other Client's occurrence, two independent
 * same-text submits (never merged), A -> Y navigation while B keeps writing X,
 * and a B-only exit that leaves A and the Host untouched.
 *
 * M5-C proves the official Question/Approval waterfall reaches BOTH real
 * modals before either Client answers, that the winner's ONE real keyboard
 * decision settles the ONE Host request, and that the loser's stale/late answer
 * cannot produce a second Host result (Question won by A; Approval reject and
 * allow won by B and A respectively).
 *
 * @module split-process/shared-session-interactions
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import {
  alive,
  assertClientHostFacts,
  lastSurfaceStatus,
  waitForSurfaceStatus,
} from '../../lib/split-smoke-processes.mjs'
import {
  hostSessionEvents,
  hostUserTexts,
  waitForHostSessionEvent,
  waitForHostSessionEventAfter,
  waitForHostSessionHeader,
} from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** Run the two-Client Session and interaction scenes on this installation. */
export async function runSharedSessionInteractions(context) {
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
  } = scene
  try {
    // M5B-01 (M5-B): TWO real Surface Clients — distinct `script(1)` PTYs and
    // distinct business PIDs — retain the SAME Host Session X at the same
    // time. A opens X and starts a real Host Turn the fixture holds; B
    // auto-opens the SAME X from its own pty, reads A's durable history and
    // the in-flight Host stream; B queues into the shared Host inbox, A
    // observes it on its own frame and steers it with the existing
    // empty-draft Ctrl+S gesture (official updateQueue over B's occurrence
    // identity); both Clients submit; the same text from two independent
    // real gestures is never merged; A navigates to Y while B keeps writing
    // X; B's normal exit leaves A, the Host and X's durable facts untouched.
    // This is one isolated Host scene so WS-2 and the T44-T66 Cases keep
    // their own Hosts and durable counts.
    {
      const releaseBarrier = join(workDir, 'm5b-long-turn.release')
      const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5b-same-session', {
        C1_HOLD_LONG_TURN: releaseBarrier,
      })
      const hostBefore = await hostIdentityFacts(host)
      assert(hostBefore.hostPid === hostReady.pid, 'M5B the Host ready record does not own the Host identity')
      // The lane's own fail-after control: the M5-B Host is alive here.
      failpoint('multi-client.shared-session-interactions.after-host-spawn')
      const { client: clientA, ready: aReady } = await startC1Client('M5B A')
      const sessionX = await openC1Session(clientA, 'm5b-seed-a', 'M5B A')
      assert(Number.isInteger(aReady.pid) && aReady.pid > 0 && aReady.pid !== hostBefore.hostPid,
        'M5B Client A published no live business PID distinct from the Host')
      assert(alive(aReady.pid), 'M5B Client A is not a live business process before B is admitted')
      const held = await waitForC1WorkEvent(workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5B held Turn')
      assert(held.agentStatus === 'running',
        `M5B the Host Agent was ${JSON.stringify(held.agentStatus)} while the Turn was held`)
      await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5B turn/start')
      assert(!existsSync(releaseBarrier), 'M5B the held Turn was released before the shared-queue proof')
      /** The plain text of one durable/inbox message (bounded, never a payload dump). */
      const textOf = message => (message?.content ?? [])
        .map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
        .join('')
      /** The attempt-labelled prefix the fixture paints for one settled answer. */
      const answerPrefix = event => {
        const text = textOf(event?.data?.message)
        const prefix = text.match(/^long-turn answer \d+/u)?.[0]
        assert(prefix !== undefined, `M5B unexpected Host assistant text: ${JSON.stringify(text.slice(0, 80))}`)
        return prefix
      }

      // MB-01: B is a SECOND real pty — its own `script(1)` wrapper and its
      // own business PID — whose startup intent opens the SAME Session X.
      const { client: clientB, ready: bReady } = await startC1Client('M5B B', {
        SPLIT_PROCESS_CLIENT_SESSION: sessionX,
      })
      const bOpen = await waitForSurfaceStatus(clientB,
        record => record.sessionOpen === true
          && record.openSessionId === sessionX
          && record.transport === 'connected'
          && record.surfaceMounted === true,
        'M5B B retained the exact Session X')
      assertClientHostFacts(bOpen.host, hostBefore, 'M5B B')
      assert(Number.isInteger(bReady.pid) && bReady.pid > 0 && bReady.pid !== hostBefore.hostPid,
        'M5B Client B published no live business PID distinct from the Host')
      assert(aReady.pid !== bReady.pid, 'M5B the two Clients must be two different business PIDs')
      assert(clientA.child.pid !== clientB.child.pid,
        'M5B the two Clients must run under distinct script(1) wrappers')
      assert(aReady.pid !== clientA.child.pid && bReady.pid !== clientB.child.pid,
        'M5B a business PID was mistaken for its script(1) wrapper')
      assert(alive(aReady.pid) && alive(bReady.pid), 'M5B a Client was not a live business process after B was admitted')
      assert(bReady.activeWrappers === 1 && bReady.liveSockets === 1,
        `M5B Client B owns wrappers=${String(bReady.activeWrappers)} sockets=${String(bReady.liveSockets)}`)
      for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
        assert(bReady.owners?.[owner] === 1, `M5B Client B owns ${owner} ${String(bReady.owners?.[owner])}`)
      }
      // B never typed the seed: its painted frame is the shared Host history
      // plus the in-flight Host stream A started before B existed.
      await clientB.waitForScreen('m5b-seed-a', 'M5B B read A\'s durable history', 120_000)
      await clientB.waitForScreen('long-turn started', 'M5B B read the running Host stream', 120_000)
      await clientA.waitForScreen('long-turn started', 'M5B A still shows the running Host stream', 120_000)
      assert(alive(hostBefore.hostPid), 'M5B the Host died while both Clients retained Session X')

      // MB-02: B queues into the shared Host inbox while the Turn is held.
      // A never typed that text, so A's frame can only carry the Host
      // occurrence — never B's client-local optimistic echo.
      const bQueueIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
      clientB.send('m5b-b-queued\r')
      const bQueue = await waitForHostSessionEventAfter(dshHome, sessionX, bQueueIndex,
        event => event.type === 'agent/inbox/spliced'
          && event.data?.target === 'next-turn'
          && (event.data.inserted ?? []).some(message => textOf(message) === 'm5b-b-queued'),
        'M5B B queued into the shared Host inbox',
        120_000)
      const bQueuedItem = (bQueue.data.inserted ?? []).find(message => textOf(message) === 'm5b-b-queued')
      assert(typeof bQueuedItem?.id === 'string' && bQueuedItem.id !== '',
        'M5B the Host queued occurrence carries no identity')
      await clientA.waitForScreen('m5b-b-queued', 'M5B A read B\'s Host pending', 120_000)
      const aOnX = lastSurfaceStatus(clientA)
      assert(aOnX?.sessionOpen === true && aOnX.openSessionId === sessionX
        && aOnX.transport === 'connected', 'M5B Client A left Session X while B was pending')

      // MB-03: the existing empty-draft Ctrl+S is the official FIFO steer-all.
      // It addresses B's Host occurrence, and the Host moves the SAME identity
      // from next-turn into next-step. It never creates an A prompt.
      const steerStart = (hostSessionEvents(dshHome, sessionX) ?? []).length
      clientA.send('\x13')
      await waitForHostSessionEventAfter(dshHome, sessionX, steerStart,
        event => event.type === 'agent/inbox/spliced'
          && event.data?.target === 'next-turn'
          && event.data?.removedCount === 1
          && (event.data.inserted ?? []).length === 0,
        'M5B Ctrl+S removed B\'s queued occurrence',
        120_000)
      const steered = await waitForHostSessionEventAfter(dshHome, sessionX, steerStart,
        event => event.type === 'agent/inbox/spliced'
          && event.data?.target === 'next-step'
          && (event.data.inserted ?? []).some(message => message?.id === bQueuedItem.id),
        'M5B Ctrl+S steered the exact Host occurrence identity',
        120_000)
      assert((steered.data.inserted ?? []).filter(message => message?.id === bQueuedItem.id).length === 1,
        'M5B the steer path duplicated the Host occurrence')
      const steerEvents = hostSessionEvents(dshHome, sessionX) ?? []
      const queueRemovalIndex = steerEvents.findIndex((event, index) => index >= steerStart
        && event.type === 'agent/inbox/spliced'
        && event.data?.target === 'next-turn'
        && event.data?.removedCount === 1
        && (event.data.inserted ?? []).length === 0)
      const steerInsertIndex = steerEvents.findIndex((event, index) => index >= steerStart
        && event.type === 'agent/inbox/spliced'
        && event.data?.target === 'next-step'
        && (event.data.inserted ?? []).some(message => message?.id === bQueuedItem.id))
      assert(queueRemovalIndex >= 0 && steerInsertIndex > queueRemovalIndex,
        'M5B Ctrl+S did not move B\'s occurrence from next-turn into next-step')
      assert(!steerEvents.some(event => event.type === 'user/message'
        && textOf(event.data) === 'm5b-b-queued'),
        'M5B the steered occurrence was committed before the running step settled')

      // MB-04: A's own submission enters the same shared queue while the
      // Turn is held; B — which never typed it — reads it on its own frame.
      const aQueueIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
      clientA.send('m5b-a-queued\r')
      const aQueue = await waitForHostSessionEventAfter(dshHome, sessionX, aQueueIndex,
        event => event.type === 'agent/inbox/spliced'
          && event.data?.target === 'next-turn'
          && (event.data.inserted ?? []).some(message => textOf(message) === 'm5b-a-queued'),
        'M5B A queued into the shared Host inbox',
        120_000)
      const aQueuedItem = (aQueue.data.inserted ?? []).find(message => textOf(message) === 'm5b-a-queued')
      assert(typeof aQueuedItem?.id === 'string' && aQueuedItem.id !== '',
        'M5B A\'s Host queued occurrence carries no identity')
      await clientB.waitForScreen('m5b-a-queued', 'M5B B read A\'s Host pending', 120_000)
      const bOnX = lastSurfaceStatus(clientB)
      assert(bOnX?.sessionOpen === true && bOnX.openSessionId === sessionX
        && bOnX.transport === 'connected', 'M5B Client B left Session X while A was pending')

      // Release the held Turn ONCE. The steered occurrence is claimed at the
      // next step boundary of the SAME Turn; A's queued occurrence starts the
      // following Turn. Both settlements are durable Host facts.
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const claimedB = await waitForHostSessionEventAfter(dshHome, sessionX, aQueueIndex,
        event => event.type === 'user/message' && event.data?.id === bQueuedItem.id,
        'M5B the steered occurrence was claimed',
        120_000)
      assert(textOf(claimedB.data) === 'm5b-b-queued', 'M5B the steered occurrence changed content')
      const claimedA = await waitForHostSessionEventAfter(dshHome, sessionX, aQueueIndex,
        event => event.type === 'user/message' && event.data?.id === aQueuedItem.id,
        'M5B A\'s queued occurrence was claimed',
        120_000)
      assert(textOf(claimedA.data) === 'm5b-a-queued', 'M5B A\'s queued occurrence changed content')
      const claimEvents = hostSessionEvents(dshHome, sessionX) ?? []
      const bClaimIndex = claimEvents.findIndex(event => event.type === 'user/message' && event.data?.id === bQueuedItem.id)
      const aClaimIndex = claimEvents.findIndex(event => event.type === 'user/message' && event.data?.id === aQueuedItem.id)
      assert(bClaimIndex >= 0 && aClaimIndex > bClaimIndex,
        'M5B the Host did not claim the steered occurrence before the queued Turn')
      const steerAnswer = claimEvents.slice(bClaimIndex, aClaimIndex).find(event => event.type === 'assistant/message')
      assert(steerAnswer !== undefined, 'M5B the steered occurrence produced no Host answer')
      // The queued Turn's own settlement: wait for its durable end, then read
      // its answer. The claim index is the observation boundary, never a timer.
      await waitForHostSessionEventAfter(dshHome, sessionX, aClaimIndex,
        event => event.type === 'turn/end', 'M5B the queued Turn settled', 120_000)
      const settledEvents = hostSessionEvents(dshHome, sessionX) ?? []
      const aAnswer = settledEvents.slice(aClaimIndex).find(event => event.type === 'assistant/message')
      assert(aAnswer !== undefined, 'M5B A\'s queued Turn produced no Host answer')
      for (const [label, client] of [['A', clientA], ['B', clientB]]) {
        await client.waitForScreen(answerPrefix(steerAnswer), `M5B ${label} read the steered settlement`, 120_000)
        await client.waitForScreen(answerPrefix(aAnswer), `M5B ${label} read the queued settlement`, 120_000)
      }
      const queueDurable = hostUserTexts(settledEvents)
      for (const [text, expected] of [['m5b-seed-a', 1], ['m5b-b-queued', 1], ['m5b-a-queued', 1]]) {
        const count = queueDurable.filter(entry => entry === text).length
        assert(count === expected,
          `M5B the Host committed ${JSON.stringify(text)} ${String(count)} time(s), expected ${String(expected)}`)
      }
      assert(settledEvents.filter(event => event.type === 'user/message' && event.data?.id === bQueuedItem.id).length === 1,
        'M5B the steered occurrence was committed more than once')
      assert(settledEvents.filter(event => event.type === 'user/message' && event.data?.id === aQueuedItem.id).length === 1,
        'M5B A\'s queued occurrence was committed more than once')

      // MB-05: the SAME text from two independent real gestures is NOT a Host
      // identity. Sequential submits; the second wait uses the durable length
      // before its own send as the observation boundary.
      const aSameBoundary = (hostSessionEvents(dshHome, sessionX) ?? []).length
      clientA.send('m5b-same-text\r')
      await clientA.waitForScreen('m5b-same-text', 'M5B A same-text submission painted', 120_000)
      const aSame = await waitForHostSessionEventAfter(dshHome, sessionX, aSameBoundary,
        event => event.type === 'user/message' && textOf(event.data) === 'm5b-same-text',
        'M5B A same-text accepted', 120_000)
      await waitForHostSessionEventAfter(dshHome, sessionX, aSameBoundary,
        event => event.type === 'turn/end', 'M5B A same-text Turn settled', 120_000)
      const afterASame = hostSessionEvents(dshHome, sessionX) ?? []
      assert(hostUserTexts(afterASame).filter(text => text === 'm5b-same-text').length === 1,
        'M5B the first same-text submission was lost or duplicated')
      const bSameBoundary = afterASame.length
      clientB.send('m5b-same-text\r')
      const bSame = await waitForHostSessionEventAfter(dshHome, sessionX, bSameBoundary,
        event => event.type === 'user/message' && textOf(event.data) === 'm5b-same-text',
        'M5B B same-text accepted', 120_000)
      await waitForHostSessionEventAfter(dshHome, sessionX, bSameBoundary,
        event => event.type === 'turn/end', 'M5B B same-text Turn settled', 120_000)
      const afterBSame = hostSessionEvents(dshHome, sessionX) ?? []
      assert(hostUserTexts(afterBSame).filter(text => text === 'm5b-same-text').length === 2,
        'M5B the Host merged two independent same-text submissions')
      assert(aSame.data?.id !== bSame.data?.id,
        'M5B the two same-text submissions reused one Host message identity')
      const bSameAnswer = afterBSame.slice(bSameBoundary).find(event => event.type === 'assistant/message')
      assert(bSameAnswer !== undefined, 'M5B the second same-text Turn produced no Host answer')
      for (const [label, client] of [['A', clientA], ['B', clientB]]) {
        await client.waitForScreen(answerPrefix(bSameAnswer), `M5B ${label} read the second same-text settlement`, 120_000)
      }

      // MB-06: A navigates to its own new Session Y while B still owns X.
      const xHeaderBefore = await waitForHostSessionHeader(dshHome, sessionX, 'M5B X durable header')
      const aNavigationBoundary = clientA.records.length
      clientA.send('/new\r')
      const aLeft = await clientA.waitFor(
        record => clientA.records.indexOf(record) >= aNavigationBoundary
          && record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && typeof record.openSessionId === 'string'
          && record.openSessionId !== sessionX,
        'M5B A navigated away from Session X',
        120_000,
      )
      const sessionY = aLeft.openSessionId
      assert(sessionY !== sessionX, 'M5B A did not leave Session X')
      // A's CURRENT facts: after B was admitted AND after A's own navigation.
      assertClientHostFacts(aLeft.host, hostBefore, 'M5B A after navigation')
      assert(aLeft.transport === 'connected' && aLeft.surfaceMounted === true,
        'M5B Client A lost its transport/surface while navigating')
      assert(aLeft.activeWrappers === 1 && aLeft.liveSockets === 1,
        `M5B Client A owns wrappers=${String(aLeft.activeWrappers)} sockets=${String(aLeft.liveSockets)}`)
      for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
        assert(aLeft.owners?.[owner] === 1, `M5B Client A owns ${owner} ${String(aLeft.owners?.[owner])}`)
      }
      assert(alive(aReady.pid) && alive(bReady.pid) && alive(hostBefore.hostPid),
        'M5B a process died during A\'s navigation')
      // Y is A's own new Session in the same Host; A writes there so the
      // separation below is a real write, not an empty selection.
      clientA.send('m5b-y-only\r')
      await clientA.waitForScreen('m5b-y-only', 'M5B A Y prompt painted', 120_000)
      await waitForHostSessionEventAfter(dshHome, sessionY, 0,
        event => event.type === 'user/message' && textOf(event.data) === 'm5b-y-only',
        'M5B A wrote Y', 120_000)
      await waitForHostSessionEventAfter(dshHome, sessionY, 0,
        event => event.type === 'turn/end', 'M5B A Y Turn settled', 120_000)
      // B still owns X and writes there while A is on Y.
      const bAfterBoundary = (hostSessionEvents(dshHome, sessionX) ?? []).length
      clientB.send('m5b-b-after-a-left-x\r')
      await waitForHostSessionEventAfter(dshHome, sessionX, bAfterBoundary,
        event => event.type === 'user/message' && textOf(event.data) === 'm5b-b-after-a-left-x',
        'M5B B wrote X after A left', 120_000)
      await waitForHostSessionEventAfter(dshHome, sessionX, bAfterBoundary,
        event => event.type === 'turn/end', 'M5B B X Turn settled', 120_000)
      await clientB.waitForScreen('m5b-b-after-a-left-x', 'M5B B X write painted', 120_000)
      const bAfterEvents = hostSessionEvents(dshHome, sessionX) ?? []
      const bAfterAnswer = bAfterEvents.slice(bAfterBoundary).find(event => event.type === 'assistant/message')
      assert(bAfterAnswer !== undefined, 'M5B B\'s X write produced no Host answer')
      await clientB.waitForScreen(answerPrefix(bAfterAnswer), 'M5B B read its X settlement', 120_000)
      const bStillOnX = lastSurfaceStatus(clientB)
      assert(bStillOnX?.sessionOpen === true && bStillOnX.openSessionId === sessionX
        && bStillOnX.transport === 'connected', 'M5B B lost Session X when A navigated')
      const aOnY = lastSurfaceStatus(clientA)
      assert(aOnY?.sessionOpen === true && aOnY.openSessionId === sessionY,
        'M5B A is not on its own Session Y')
      // A's Y frame can never carry B's X-only text; Y's durable log neither.
      assert(!(await clientA.viewport()).join('\n').includes('m5b-b-after-a-left-x'),
        'M5B A painted B\'s X-only write on Y')
      assert(!(hostSessionEvents(dshHome, sessionY) ?? []).some(event => event.type === 'user/message'
        && textOf(event.data) === 'm5b-b-after-a-left-x'),
        'M5B B\'s X write leaked into Session Y')
      // X's immutable header (id/createdAt/cwd) never moved.
      const xHeaderAfter = await waitForHostSessionHeader(dshHome, sessionX, 'M5B X durable header after A left')
      assert(JSON.stringify(xHeaderAfter) === JSON.stringify(xHeaderBefore),
        'M5B A leaving X changed the durable Session header/workspace')
      await assertHostIdentityKept(host, hostBefore, 'M5B Host after A navigated')

      // MB-07: B's normal exit releases ONLY B while A (on Y), the Host and
      // X's durable facts stay live.
      clientB.send('/exit\r')
      const bExit = await clientB.waitForExit(60_000)
      assert(bExit.code === 0 && bExit.signal === null, `M5B Client B exit was ${JSON.stringify(bExit)}`)
      const bClosed = await clientB.waitFor(record => record.m4b2s === 'client-closed', 'M5B B client-closed', 30_000)
      for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
        assert(bClosed.owners?.[owner] === 0, `M5B Client B left ${owner} alive after its normal exit`)
      }
      assert(bClosed.sessionOpen === false && bClosed.surfaceMounted === false,
        'M5B Client B still claimed an open surface/Session after its normal exit')
      assert(bClosed.activeWrappers === 0 && bClosed.liveSockets === 0,
        'M5B Client B still owned transport wrappers/sockets after its normal exit')
      await clientB.dispose()
      assert(alive(aReady.pid), 'M5B Client A died when Client B exited')
      assert(alive(hostBefore.hostPid), 'M5B the Host died when Client B exited')
      await assertHostIdentityKept(host, hostBefore, 'M5B Host after B exit')
      // A can still read AND write Y after B is gone.
      assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY, 'M5B A lost Session Y when B exited')
      const yAfterBoundary = (hostSessionEvents(dshHome, sessionY) ?? []).length
      clientA.send('m5b-y-after-b-exit\r')
      await clientA.waitForScreen('m5b-y-after-b-exit', 'M5B A Y prompt after B exit painted', 120_000)
      await waitForHostSessionEventAfter(dshHome, sessionY, yAfterBoundary,
        event => event.type === 'user/message' && textOf(event.data) === 'm5b-y-after-b-exit',
        'M5B A wrote Y after B exited', 120_000)
      await waitForHostSessionEventAfter(dshHome, sessionY, yAfterBoundary,
        event => event.type === 'turn/end', 'M5B A Y Turn after B exit settled', 120_000)

      // Final durable accounting on the COMPLETE logs after every Turn
      // settled: two same-text submits stay two, nothing crossed Sessions.
      const xFinal = hostSessionEvents(dshHome, sessionX) ?? []
      const xTexts = hostUserTexts(xFinal)
      for (const [text, expected] of [
        ['m5b-seed-a', 1],
        ['m5b-b-queued', 1],
        ['m5b-a-queued', 1],
        ['m5b-same-text', 2],
        ['m5b-b-after-a-left-x', 1],
      ]) {
        const count = xTexts.filter(entry => entry === text).length
        assert(count === expected,
          `M5B Session X committed ${JSON.stringify(text)} ${String(count)} time(s), expected ${String(expected)}`)
      }
      // The Session's own runtime/time context rows are also official
      // `user/message` events: the human-write accounting below is scoped to
      // THIS case's prefixes, never a raw total that would count them.
      const xHumanTexts = xTexts.filter(entry => entry.startsWith('m5b-'))
      assert(xHumanTexts.length === 6,
        `M5B Session X carried ${String(xHumanTexts.length)} m5b-* user messages, expected 6`)
      assert(xTexts.every(entry => entry !== 'm5b-y-only' && entry !== 'm5b-y-after-b-exit'),
        'M5B a Y-only write leaked into Session X')
      const yFinal = hostUserTexts(hostSessionEvents(dshHome, sessionY) ?? [])
      assert(yFinal.filter(entry => entry === 'm5b-y-only').length === 1
        && yFinal.filter(entry => entry === 'm5b-y-after-b-exit').length === 1,
        'M5B Session Y lost one of A\'s own writes')
      assert(yFinal.every(entry => !['m5b-seed-a', 'm5b-b-queued', 'm5b-a-queued', 'm5b-same-text', 'm5b-b-after-a-left-x'].includes(entry)),
        'M5B an X-only write leaked into Session Y')

      await exitC1Client(clientA, 'M5B A')
      await stopC1Host(host)
      trace('m5b-same-session', {
        hostPid: hostBefore.hostPid,
        clientAPid: aReady.pid,
        clientBPid: bReady.pid,
        wrapperPids: [clientA.child.pid, clientB.child.pid],
        sessionX,
        sessionY,
        sameHost: true,
        distinctPtys: true,
        hostUserMessages: { seed: 1, bQueued: 1, aQueued: 1, sameText: 2, bAfterALeftX: 1 },
        queueSteer: 'B occurrence moved next-turn -> next-step; claimed once',
        sameTextCommitCount: 2,
        bWroteXAfterALeft: true,
        yOnlyWrites: 2,
        clientBNormalExit: bExit.code,
        clientBResourcesReleased: true,
        clientAKept: true,
        hostIdentityKept: true,
      })
    }

    // M5C-01 (M5-C): TWO REAL Surface Clients — distinct `script(1)` PTYs,
    // distinct business PIDs and one installed official interaction-provider
    // pair each — are admitted to the SAME Host Session X BEFORE the Host
    // asks. ONE Host Question/Approval reaches BOTH real modals, the winner's
    // ONE real keyboard decision settles the ONE Host waterfall, and the
    // loser's presentation is withdrawn by the official Gateway cancellation
    // so its later key cannot produce a second Host result.
    //
    // Three fixed scenes, each with its own Host, empty Session X and work
    // root: Question won by A (M5C-01Q), Approval-Reject won by B (M5C-01AR)
    // and Approval-Allow won by A (M5C-01AA). Both Approval scenes use the
    // same real `approval-allow` Host workload: the outcome is decided by the
    // real Client keyboards, never by a second Host scenario pretending a
    // refusal.
    {
      /**
       * Admit both real Clients onto one EMPTY Host Session X without asking
       * anything yet. A creates X with the REAL product `/new` command, which
       * creates an empty Session without submitting a model prompt; B then
       * joins the SAME X through its own startup intent. `openC1Session` is
       * forbidden here: it submits the first prompt immediately, so the Host
       * could ask before B exists and the scene would only prove a replay.
       *
       * The returned scene is not evidence by itself: the Host must carry no
       * turn/tool call/approval and the fixture no request before the caller
       * sends the ONE trigger prompt.
       */
      const admitM5cDualSurfaceScene = async (scenario, label) => {
        const { host, ready: hostReady, workRoot } = await startC1Host(scenario, label)
        const hostBefore = await hostIdentityFacts(host)
        assert(hostBefore.hostPid === hostReady.pid,
          `${label} the Host ready record does not own the Host identity`)
        const { client: clientA, ready: aReady } = await startC1Client(`${label} A`)
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
          `${label} Client A opened an empty Session`,
          120_000,
        )
        const sessionX = aOpen.openSessionId
        assert(Number.isInteger(aReady.pid) && aReady.pid > 0 && aReady.pid !== hostBefore.hostPid,
          `${label} Client A published no live business PID distinct from the Host`)
        assert(alive(aReady.pid), `${label} Client A is not a live business process`)
        assert(aReady.activeWrappers === 1 && aReady.liveSockets === 1,
          `${label} Client A owns wrappers=${String(aReady.activeWrappers)} sockets=${String(aReady.liveSockets)}`)
        for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
          assert(aReady.owners?.[owner] === 1, `${label} Client A owns ${owner} ${String(aReady.owners?.[owner])}`)
        }
        assertInteractionGate(clientA, `${label} Client A`)
        const { client: clientB, ready: bReady } = await startC1Client(`${label} B`, {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const bOpen = await waitForSurfaceStatus(clientB, record => record.sessionOpen === true
          && record.openSessionId === sessionX
          && record.transport === 'connected'
          && record.surfaceMounted === true, `${label} Client B retained Session X`)
        assertClientHostFacts(aOpen.host, hostBefore, `${label} Client A`)
        assertClientHostFacts(bOpen.host, hostBefore, `${label} Client B`)
        assert(Number.isInteger(bReady.pid) && bReady.pid > 0 && bReady.pid !== hostBefore.hostPid,
          `${label} Client B published no live business PID distinct from the Host`)
        assert(aReady.pid !== bReady.pid, `${label} the two Clients must be two different business PIDs`)
        assert(clientA.child.pid !== clientB.child.pid,
          `${label} the two Clients must run under distinct script(1) wrappers`)
        assert(aReady.pid !== clientA.child.pid && bReady.pid !== clientB.child.pid,
          `${label} a business PID was mistaken for its script(1) wrapper`)
        assert(alive(aReady.pid) && alive(bReady.pid),
          `${label} a Client was not a live business process after B was admitted`)
        assert(bReady.activeWrappers === 1 && bReady.liveSockets === 1,
          `${label} Client B owns wrappers=${String(bReady.activeWrappers)} sockets=${String(bReady.liveSockets)}`)
        for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
          assert(bReady.owners?.[owner] === 1, `${label} Client B owns ${owner} ${String(bReady.owners?.[owner])}`)
        }
        assertInteractionGate(clientB, `${label} Client B`)
        const pendingBefore = hostSessionEvents(dshHome, sessionX) ?? []
        assert(!pendingBefore.some(event => event.type === 'turn/start' || event.type === 'tool/call'
          || event.type === 'approval/asked'),
        `${label} Host Session X carried Host activity before the trigger`)
        assert(readC1WorkEvents(workRoot).every(event => event.kind !== 'question-request'
          && event.kind !== 'approval-request'),
        `${label} the Host asked before both real Clients were admitted`)
        assert(alive(hostBefore.hostPid), `${label} the Host died while both Clients were admitted`)
        return { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX }
      }

      // M5C-01Q: the Host's non-timed foreground Question reaches both real
      // modals; A answers through the REAL review page; B's modal is withdrawn
      // and its later option key is inert. The durable `tool/call.callId` ties
      // the ONE question tool call to its ONE `tool/result` — a non-timed ask
      // carries no `wait.callId`, so the waterfall record cannot be the
      // correlation authority here.
      {
        const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX } =
          await admitM5cDualSurfaceScene('question', 'm5c-question')
        // The ONE trigger is A's real keyboard submission AFTER both Clients
        // are ready and nothing is pending.
        const triggerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientA.send('m5c-question-trigger\r')
        const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
          event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
          'M5C question tool/call', 120_000)
        // Validate the DURABLE field BEFORE touching it: a missing/foreign
        // value coerced with String() would become the fabricated 'undefined'
        // and silently pass every correlation below.
        assert(typeof call.data.callId === 'string' && call.data.callId !== '',
          'M5C the question tool/call carries no callId')
        const callId = call.data.callId
        const request = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'question-request' && event.sessionId === sessionX,
          'M5C Host question request', 120_000)
        assert(request.questions?.[0]?.question === 'Continue the C1 test?',
          `M5C unexpected Host question payload: ${JSON.stringify(request.questions?.[0]?.question)}`)
        assert((request.questions?.[0]?.options ?? []).map(option => option?.label).join('|') === 'Proceed|Cancel',
          'M5C the Host question options are not the fixture Proceed/Cancel pair')
        const requestsBeforeAnswer = readC1WorkEvents(workRoot)
          .filter(event => event.kind === 'question-request' && event.sessionId === sessionX)
        assert(requestsBeforeAnswer.length === 1,
          `M5C the Host asked ${String(requestsBeforeAnswer.length)} times before any answer`)
        // BOTH physically distinct PTYs must paint the same ANSWERABLE modal
        // BEFORE the winner types anything.
        await clientA.waitForScreen('[1] Proceed', 'M5C A question modal', 120_000)
        await clientB.waitForScreen('[1] Proceed', 'M5C B question modal', 120_000)
        assert((await clientA.viewport()).join('\n').includes('Continue the C1 test?'),
          'M5C Client A painted no question text')
        assert((await clientB.viewport()).join('\n').includes('Continue the C1 test?'),
          'M5C Client B painted no question text')
        // A answers through the REAL QuestionFlow review page, never the port.
        const answerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientA.send('1')
        await clientA.waitForScreen('Review your answer before submit', 'M5C A question review', 30_000)
        clientA.send('\r')
        const settled = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'question-settled' && event.sessionId === sessionX,
          'M5C Host question settled', 120_000)
        assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
          `M5C the Host received the wrong answer: ${JSON.stringify(settled.answers)}`)
        const result = await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
          event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
          'M5C question tool result', 120_000)
        assert(result.data?.message?.isError !== true, 'M5C the answered question failed at the Host')
        await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
          event => event.type === 'turn/end', 'M5C question turn/end', 120_000)
        for (const [side, client] of [['A', clientA], ['B', clientB]]) {
          await client.waitForScreen('question answered', `M5C ${side} read the Host settlement`, 120_000)
        }
        // B lost the SAME Host delivery: the official Gateway cancellation
        // withdrew its CURRENT modal and returned the editor seat without a
        // local Esc or decision.
        await clientB.waitForScreenGone('[1] Proceed', 'M5C B question modal withdrawn', 120_000)
        const bAfterWithdraw = (await clientB.viewport()).join('\n')
        assert(!bAfterWithdraw.includes('Review your answer before submit'),
          'M5C loser B opened the question review page')
        assert(!bAfterWithdraw.includes('○ Submit') && !bAfterWithdraw.includes('✓ Submit'),
          'M5C loser B still paints the question Submit tab')
        clientB.send('m5c-b-editor-after-question')
        await clientB.waitForComposerDraft('m5c-b-editor-after-question', 30_000)
        clientB.send('\x15')
        await clientB.waitForScreenGone('m5c-b-editor-after-question', 'M5C loser B cleared its editor draft', 30_000)
        // The old option key is ordinary editor text now: clearing it must not
        // create a second Host answer or reopen the settled modal.
        const lateIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientB.send('2')
        await sleep(300)
        clientB.send('\x15')
        await sleep(300)
        assert(!(await clientB.viewport()).join('\n').includes('[1] Proceed'),
          'M5C a late loser option key reopened the settled question modal')
        assert((hostSessionEvents(dshHome, sessionX) ?? []).slice(lateIndex)
          .every(event => event.type !== 'tool/call' && event.type !== 'tool/result'
            && event.type !== 'turn/start' && event.type !== 'turn/end'),
        'M5C a late loser key produced Host activity')
        assert(alive(aReady.pid) && alive(bReady.pid) && alive(hostBefore.hostPid),
          'M5C a process died during the question first-settlement proof')
        assert(lastSurfaceStatus(clientA)?.openSessionId === sessionX
          && lastSurfaceStatus(clientB)?.openSessionId === sessionX,
        'M5C a Client left Session X after the first settlement')
        await assertHostIdentityKept(host, hostBefore, 'M5C Host after the question first settlement')
        // B exits normally; A, the Host and X's durable facts stay live, and a
        // NEW durable snapshot after the exit still carries exactly one answer.
        await exitC1Client(clientB, 'M5C question B')
        assert(alive(aReady.pid), 'M5C Client A died when Client B exited')
        assert(alive(hostBefore.hostPid), 'M5C the Host died when Client B exited')
        assert(lastSurfaceStatus(clientA)?.openSessionId === sessionX
          && lastSurfaceStatus(clientA)?.transport === 'connected',
        'M5C Client A lost Session X when Client B exited')
        const afterExitEvents = hostSessionEvents(dshHome, sessionX) ?? []
        assert(afterExitEvents.filter(event => event.type === 'tool/result'
          && String(event.data?.message?.toolCallId) === callId).length === 1,
        'M5C the question produced a second Host tool result after the loser exited')
        const afterExitProofs = readC1WorkEvents(workRoot)
        assert(afterExitProofs.filter(event => event.kind === 'question-request' && event.sessionId === sessionX).length === 1
          && afterExitProofs.filter(event => event.kind === 'question-settled' && event.sessionId === sessionX).length === 1,
        'M5C the question request/settlement pair changed after the loser exited')
        await exitC1Client(clientA, 'M5C question A')
        const finalEvents = hostSessionEvents(dshHome, sessionX) ?? []
        const finalProofs = readC1WorkEvents(workRoot)
        assert(finalProofs.filter(event => event.kind === 'question-request' && event.sessionId === sessionX).length === 1
          && finalProofs.filter(event => event.kind === 'question-settled' && event.sessionId === sessionX).length === 1,
        'M5C the question was not settled exactly once')
        assert(finalProofs.every(event => event.kind !== 'question-failed'),
          'M5C a legal first answer was recorded as a failed Host question')
        assert(finalEvents.filter(event => event.type === 'tool/call'
          && event.data?.name === 'ask_user_question').length === 1,
        'M5C the Host asked more than once for one question tool call')
        assert(finalEvents.filter(event => event.type === 'tool/result'
          && String(event.data?.message?.toolCallId) === callId).length === 1,
        'M5C the Host wrote more than one tool result for the question call')
        await stopC1Host(host)
        // A swallowed shutdown is NOT a normal end: the Host entry exits 0
        // only when its official owner shutdown completed without any
        // cleanup failure, so the M5-C scene must assert the real result.
        assert(host.exited === true && host.exitResult?.code === 0 && host.exitResult?.signal === null,
          `M5C the Host did not shut down normally: ${JSON.stringify(host.exitResult)}`)
        trace('m5c-01q', {
          hostPid: hostBefore.hostPid,
          clientAPid: aReady.pid,
          clientBPid: bReady.pid,
          wrapperPids: [clientA.child.pid, clientB.child.pid],
          sessionX,
          questionCallId: callId,
          bothPtysSawQuestion: true,
          winner: 'A',
          hostSettlements: 1,
          loserWithdrawn: true,
          loserLateKeyInert: true,
          sameHostBeforeAfter: true,
          clientsExitedNormally: true,
          hostExitCode: host.exitResult.code,
        })
      }

      // M5C-01AR: the SAME ApprovalSheet is live in both real modals; B's
      // rejection wins the ONE Host waterfall, A's later `y` cannot allow the
      // command, and no marker may ever exist for this refusal.
      {
        const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX } =
          await admitM5cDualSurfaceScene('approval-allow', 'm5c-approval-reject')
        const triggerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientA.send('m5c-approval-reject-trigger\r')
        const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
          event => event.type === 'tool/call' && event.data?.name === 'bash',
          'M5C AR bash tool/call', 120_000)
        assert(typeof call.data.callId === 'string' && call.data.callId !== '',
          'M5C AR the bash tool/call carries no callId')
        const toolCallId = call.data.callId
        const asked = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
          event => event.type === 'approval/asked', 'M5C AR approval/asked', 120_000)
        const requestId = String(asked.data.id)
        assert(typeof asked.data.id === 'string' && asked.data.id !== '',
          'M5C AR the Host approval request carries no ApprovalRequestId')
        assert(asked.data.callId === undefined || String(asked.data.callId) === toolCallId,
          'M5C AR the approval/asked call correlation does not name the bash tool call')
        const request = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'approval-request' && event.sessionId === sessionX,
          'M5C AR Host approval request', 120_000)
        assert(request.toolName === 'bash', 'M5C AR the approval is not for the official bash tool')
        assert(String(request.callId) === toolCallId,
          'M5C AR the fixture approval request names another tool call')
        const askedBeforeDecision = (hostSessionEvents(dshHome, sessionX) ?? [])
          .filter(event => event.type === 'approval/asked')
        assert(askedBeforeDecision.length === 1,
          `M5C AR the Host asked ${String(askedBeforeDecision.length)} approvals before any decision`)
        // BOTH physically distinct PTYs must paint the same ANSWERABLE sheet.
        await clientA.waitForScreen('[y] Allow once', 'M5C AR A approval sheet', 120_000)
        await clientB.waitForScreen('[y] Allow once', 'M5C AR B approval sheet', 120_000)
        assert((await clientA.viewport()).join('\n').includes('[n] Reject'),
          'M5C AR Client A painted no reject action')
        assert((await clientB.viewport()).join('\n').includes('[n] Reject'),
          'M5C AR Client B painted no reject action')
        const decideIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientB.send('n')
        const decided = await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
          event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
          'M5C AR approval/decided', 120_000)
        assert(decided.data.outcome === 'rejected',
          `M5C AR the first Host outcome was ${JSON.stringify(decided.data.outcome)}`)
        const settlement = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'rejected',
          'M5C AR rejected settlement', 60_000)
        assert(String(settlement.callId) === toolCallId,
          'M5C AR the rejected settlement names another tool call')
        assert(readC1WorkEvents(workRoot).every(event => event.kind !== 'approval-failed'),
          'M5C AR the approval failed at the Host instead of settling rejected')
        // The official denied tool result is written; the command NEVER runs.
        const denied = await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
          event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolCallId,
          'M5C AR denied tool result', 120_000)
        assert(denied.data?.message?.isError === true,
          'M5C AR a rejected approval still executed the bash tool')
        await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
          event => event.type === 'turn/end', 'M5C AR turn/end', 120_000)
        for (const [side, client] of [['A', clientA], ['B', clientB]]) {
          await client.waitForScreen('approval settled', `M5C AR ${side} read the Host settlement`, 120_000)
        }
        assert(!existsSync(join(workRoot, 'approval-allow.marker')),
          'M5C AR the rejected harmless command executed')
        // A lost the SAME Host delivery: its sheet is withdrawn; the later
        // `y` is ordinary editor text and must not allow or re-decide.
        await clientA.waitForScreenGone('[y] Allow once', 'M5C AR loser A sheet withdrawn', 120_000)
        assert(!(await clientA.viewport()).join('\n').includes('[n] Reject'),
          'M5C AR loser A still paints the approval actions')
        clientA.send('m5c-a-editor-after-approval')
        await clientA.waitForComposerDraft('m5c-a-editor-after-approval', 30_000)
        clientA.send('\x15')
        await clientA.waitForScreenGone('m5c-a-editor-after-approval', 'M5C AR loser A cleared its editor draft', 30_000)
        const lateIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientA.send('y')
        await sleep(300)
        clientA.send('\x15')
        await sleep(300)
        assert(!(await clientA.viewport()).join('\n').includes('[y] Allow once'),
          'M5C AR a late loser key reopened the settled ApprovalSheet')
        const decisions = (hostSessionEvents(dshHome, sessionX) ?? [])
          .filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId)
        assert(decisions.length === 1 && decisions[0].data.outcome === 'rejected',
          'M5C AR the late loser allow produced a second/changed Host decision')
        assert((hostSessionEvents(dshHome, sessionX) ?? []).slice(lateIndex)
          .every(event => event.type !== 'approval/decided' && event.type !== 'tool/result'),
        'M5C AR a late loser key produced Host activity')
        assert(readC1WorkEvents(workRoot).every(event => !(event.kind === 'approval-settled'
          && event.outcome === 'allowed-once')),
        'M5C AR the late loser key settled an allowed approval')
        assert(!existsSync(join(workRoot, 'approval-allow.marker')),
          'M5C AR the late loser key executed the rejected command')
        assert((hostSessionEvents(dshHome, sessionX) ?? []).filter(event => event.type === 'tool/result'
          && String(event.data?.message?.toolCallId) === toolCallId).length === 1,
        'M5C AR the rejected tool call produced a second Host result')
        assert(alive(aReady.pid) && alive(bReady.pid) && alive(hostBefore.hostPid),
          'M5C AR a process died during the approval first-settlement proof')
        assert(lastSurfaceStatus(clientA)?.openSessionId === sessionX
          && lastSurfaceStatus(clientB)?.openSessionId === sessionX,
        'M5C AR a Client left Session X after the first settlement')
        await assertHostIdentityKept(host, hostBefore, 'M5C AR Host after the approval first settlement')
        await exitC1Client(clientA, 'M5C AR A')
        assert(alive(bReady.pid), 'M5C AR Client B died when the loser exited')
        assert(alive(hostBefore.hostPid), 'M5C AR the Host died when the loser exited')
        await exitC1Client(clientB, 'M5C AR B')
        const finalEvents = hostSessionEvents(dshHome, sessionX) ?? []
        const finalProofs = readC1WorkEvents(workRoot)
        assert(finalEvents.filter(event => event.type === 'approval/asked'
          && String(event.data?.id) === requestId).length === 1
          && finalEvents.filter(event => event.type === 'approval/decided'
            && String(event.data?.id) === requestId && event.data?.outcome === 'rejected').length === 1,
        'M5C AR the approval was not asked/decided exactly once as rejected')
        assert(finalProofs.filter(event => event.kind === 'approval-settled').length === 1
          && finalProofs.filter(event => event.kind === 'approval-failed').length === 0,
        'M5C AR the fixture settlement was not exactly one rejection')
        assert(!existsSync(join(workRoot, 'approval-allow.marker')),
          'M5C AR a marker appeared for the refused command')
        await stopC1Host(host)
        assert(host.exited === true && host.exitResult?.code === 0 && host.exitResult?.signal === null,
          `M5C AR the Host did not shut down normally: ${JSON.stringify(host.exitResult)}`)
        trace('m5c-01ar', {
          hostPid: hostBefore.hostPid,
          clientAPid: aReady.pid,
          clientBPid: bReady.pid,
          wrapperPids: [clientA.child.pid, clientB.child.pid],
          sessionX,
          approvalRequestId: requestId,
          toolCallId,
          bothPtysSawApproval: true,
          winner: 'B',
          hostOutcome: 'rejected',
          decisions: 1,
          marker: false,
          loserWithdrawn: true,
          loserLateAllowInert: true,
          sameHostBeforeAfter: true,
          clientsExitedNormally: true,
          hostExitCode: host.exitResult.code,
        })
      }

      // M5C-01AA: the SAME ApprovalSheet is live in both real modals; A's
      // allow wins the ONE Host waterfall and executes the harmless command
      // exactly once; B's later `n` neither reverses the settlement nor adds
      // a decision or a second execution.
      {
        const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX } =
          await admitM5cDualSurfaceScene('approval-allow', 'm5c-approval-allow')
        const triggerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientA.send('m5c-approval-allow-trigger\r')
        const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
          event => event.type === 'tool/call' && event.data?.name === 'bash',
          'M5C AA bash tool/call', 120_000)
        assert(typeof call.data.callId === 'string' && call.data.callId !== '',
          'M5C AA the bash tool/call carries no callId')
        const toolCallId = call.data.callId
        const asked = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
          event => event.type === 'approval/asked', 'M5C AA approval/asked', 120_000)
        const requestId = String(asked.data.id)
        assert(typeof asked.data.id === 'string' && asked.data.id !== '',
          'M5C AA the Host approval request carries no ApprovalRequestId')
        assert(asked.data.callId === undefined || String(asked.data.callId) === toolCallId,
          'M5C AA the approval/asked call correlation does not name the bash tool call')
        const request = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'approval-request' && event.sessionId === sessionX,
          'M5C AA Host approval request', 120_000)
        assert(request.toolName === 'bash', 'M5C AA the approval is not for the official bash tool')
        assert(String(request.callId) === toolCallId,
          'M5C AA the fixture approval request names another tool call')
        const askedBeforeDecision = (hostSessionEvents(dshHome, sessionX) ?? [])
          .filter(event => event.type === 'approval/asked')
        assert(askedBeforeDecision.length === 1,
          `M5C AA the Host asked ${String(askedBeforeDecision.length)} approvals before any decision`)
        await clientA.waitForScreen('[y] Allow once', 'M5C AA A approval sheet', 120_000)
        await clientB.waitForScreen('[y] Allow once', 'M5C AA B approval sheet', 120_000)
        assert((await clientA.viewport()).join('\n').includes('[n] Reject'),
          'M5C AA Client A painted no reject action')
        assert((await clientB.viewport()).join('\n').includes('[n] Reject'),
          'M5C AA Client B painted no reject action')
        const decideIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientA.send('y')
        const decided = await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
          event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
          'M5C AA approval/decided', 120_000)
        assert(decided.data.outcome === 'allowed-once',
          `M5C AA the first Host outcome was ${JSON.stringify(decided.data.outcome)}`)
        const settlement = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'allowed-once',
          'M5C AA allowed-once settlement', 60_000)
        assert(String(settlement.callId) === toolCallId,
          'M5C AA the allowed settlement names another tool call')
        assert(readC1WorkEvents(workRoot).every(event => event.kind !== 'approval-failed'),
          'M5C AA the approval failed at the Host instead of settling allowed-once')
        const executed = await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
          event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolCallId,
          'M5C AA executed tool result', 120_000)
        assert(executed.data?.message?.isError !== true,
          'M5C AA the allowed harmless command reported a failed Host result')
        const marker = join(workRoot, 'approval-allow.marker')
        assert(existsSync(marker), 'M5C AA the allowed harmless command did not execute')
        assert(readFileSync(marker, 'utf8') === 'c1-approval-allow',
          'M5C AA the executed marker does not carry the fixture payload')
        await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
          event => event.type === 'turn/end', 'M5C AA turn/end', 120_000)
        for (const [side, client] of [['A', clientA], ['B', clientB]]) {
          await client.waitForScreen('approval settled', `M5C AA ${side} read the Host settlement`, 120_000)
        }
        // B lost the SAME Host delivery: its sheet is withdrawn; the later
        // `n` is ordinary editor text and must not reverse anything.
        await clientB.waitForScreenGone('[y] Allow once', 'M5C AA loser B sheet withdrawn', 120_000)
        assert(!(await clientB.viewport()).join('\n').includes('[n] Reject'),
          'M5C AA loser B still paints the approval actions')
        clientB.send('m5c-b-editor-after-approval')
        await clientB.waitForComposerDraft('m5c-b-editor-after-approval', 30_000)
        clientB.send('\x15')
        await clientB.waitForScreenGone('m5c-b-editor-after-approval', 'M5C AA loser B cleared its editor draft', 30_000)
        const lateIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientB.send('n')
        await sleep(300)
        clientB.send('\x15')
        await sleep(300)
        assert(!(await clientB.viewport()).join('\n').includes('[y] Allow once'),
          'M5C AA a late loser key reopened the settled ApprovalSheet')
        const decisions = (hostSessionEvents(dshHome, sessionX) ?? [])
          .filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId)
        assert(decisions.length === 1 && decisions[0].data.outcome === 'allowed-once',
          'M5C AA the late loser reject produced a second/changed Host decision')
        assert((hostSessionEvents(dshHome, sessionX) ?? []).slice(lateIndex)
          .every(event => event.type !== 'approval/decided' && event.type !== 'tool/result'),
        'M5C AA a late loser key produced Host activity')
        assert(readC1WorkEvents(workRoot).filter(event => event.kind === 'approval-settled'
          && event.outcome === 'allowed-once').length === 1,
        'M5C AA the late loser key settled a second allowed approval')
        assert(readFileSync(marker, 'utf8') === 'c1-approval-allow',
          'M5C AA the marker changed after the late loser key')
        assert((hostSessionEvents(dshHome, sessionX) ?? []).filter(event => event.type === 'tool/result'
          && String(event.data?.message?.toolCallId) === toolCallId).length === 1,
        'M5C AA the approved tool call produced a second Host result')
        assert(alive(aReady.pid) && alive(bReady.pid) && alive(hostBefore.hostPid),
          'M5C AA a process died during the approval first-settlement proof')
        assert(lastSurfaceStatus(clientA)?.openSessionId === sessionX
          && lastSurfaceStatus(clientB)?.openSessionId === sessionX,
        'M5C AA a Client left Session X after the first settlement')
        await assertHostIdentityKept(host, hostBefore, 'M5C AA Host after the approval first settlement')
        await exitC1Client(clientB, 'M5C AA B')
        assert(alive(aReady.pid), 'M5C AA Client A died when the loser exited')
        assert(alive(hostBefore.hostPid), 'M5C AA the Host died when the loser exited')
        await exitC1Client(clientA, 'M5C AA A')
        const finalEvents = hostSessionEvents(dshHome, sessionX) ?? []
        const finalProofs = readC1WorkEvents(workRoot)
        assert(finalEvents.filter(event => event.type === 'approval/asked'
          && String(event.data?.id) === requestId).length === 1
          && finalEvents.filter(event => event.type === 'approval/decided'
            && String(event.data?.id) === requestId && event.data?.outcome === 'allowed-once').length === 1,
        'M5C AA the approval was not asked/decided exactly once as allowed-once')
        assert(finalProofs.filter(event => event.kind === 'approval-settled').length === 1
          && finalProofs.filter(event => event.kind === 'approval-failed').length === 0,
        'M5C AA the fixture settlement was not exactly one approval')
        assert(existsSync(marker) && readFileSync(marker, 'utf8') === 'c1-approval-allow',
          'M5C AA the final marker did not survive the normal exits')
        await stopC1Host(host)
        assert(host.exited === true && host.exitResult?.code === 0 && host.exitResult?.signal === null,
          `M5C AA the Host did not shut down normally: ${JSON.stringify(host.exitResult)}`)
        trace('m5c-01aa', {
          hostPid: hostBefore.hostPid,
          clientAPid: aReady.pid,
          clientBPid: bReady.pid,
          wrapperPids: [clientA.child.pid, clientB.child.pid],
          sessionX,
          approvalRequestId: requestId,
          toolCallId,
          bothPtysSawApproval: true,
          winner: 'A',
          hostOutcome: 'allowed-once',
          decisions: 1,
          marker: true,
          loserWithdrawn: true,
          loserLateRejectInert: true,
          sameHostBeforeAfter: true,
          clientsExitedNormally: true,
          hostExitCode: host.exitResult.code,
        })
      }
    }
  } finally {
    await scene.dispose()
  }
}
