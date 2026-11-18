/**
 * Continuity T66: an ACK-dropped unknown write survives Host death truthfully.
 *
 * The Host commits one write whose RPC ACK is dropped, so the Client's local
 * write outcome is `indeterminate` while the Host durable row already exists.
 * Whether the official acceptance wins that race is independent: an accepted
 * prompt clears its draft, a real unknown keeps it with the uncertainty notice.
 * The committing Host is then SIGKILLed before the Turn ends; a later Host
 * cold-resumes the SAME Session and must see the original user text exactly
 * once, settle the intercepted Turn as `interrupted` and never fabricate an
 * assistant answer or replay the write.
 *
 * @module split-process/unknown-write-host-death
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { alive, readJson, waitGone } from '../../lib/split-smoke-processes.mjs'
import {
  hostSessionEvents,
  hostUserTexts,
  waitForHostSessionEvent,
} from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/**
 * Drive the T66 unknown-write/Host-death scene on this run's ONE installation.
 *
 * The case owns every Host and Client through ONE C1 scene; its `finally`
 * disposes them. The replacement Host created by cold discovery is stopped
 * through its own official SIGTERM admission.
 */
export async function runUnknownWriteHostDeath(context) {
  const { workDir, dshHome, trace, failpoint } = context
  const scene = createC1Scene(context)
  const {
    startC1Host,
    startC1Client,
    exitC1Client,
    openC1Session,
    hostIdentityFacts,
    sceneScopeId,
    awaitSceneSeatFree,
  } = scene

  /**
   * Stop a Host this case did not create through `startC1Host`: the one a
   * Client spawns by itself through `ensureLocalHost` after the previous
   * instance died. The official SIGTERM admission is the supported stop; the
   * kernel seat and the launch material must be gone afterwards.
   */
  const stopSpawnedHost = async (hostPid, instanceId, label) => {
    // The instance files live under the FULL 64-character scope id; ONLY the
    // Linux abstract-socket NAME is truncated to 40 characters. Asserting the
    // absence of those files under the socket suffix would silently inspect a
    // directory that never exists. Both the presence check (while the Host is
    // still running) and the absence check (after the official stop) therefore
    // use the real scope directory, and the truncated spelling is asserted to
    // be a NON-directory so this confusion cannot come back.
    const hostScopeId = sceneScopeId()
    assert(typeof hostScopeId === 'string' && hostScopeId.length === 64,
      `${label}: the scene never learned the full 64-character scope id`)
    const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', hostScopeId)
    assert(existsSync(scopeDir), `${label}: the full-scope run directory is missing`)
    assert(!existsSync(join(dshHome, 'run', 'dsh-pi-tui', hostScopeId.slice(0, 40))),
      `${label}: a truncated 40-character scope directory must never exist`)
    const instancePath = join(scopeDir, 'instance.json')
    const launchPath = join(scopeDir, 'launch.json')
    assert(existsSync(instancePath),
      `${label}: the running spawned Host published no instance record to reclaim`)
    assert(existsSync(launchPath),
      `${label}: the running spawned Host published no launch material to reclaim`)
    process.kill(hostPid, 'SIGTERM')
    await waitGone(hostPid, 30_000)
    assert(!alive(hostPid), `${label}: the spawned Host survived the official SIGTERM`)
    await awaitSceneSeatFree()
    assert(!existsSync(launchPath), `${label}: the stopped Host left its launch material behind`)
    if (existsSync(instancePath)) {
      assert(readJson(instancePath)?.instanceId !== instanceId,
        `${label}: the stopped Host left its own instance record behind`)
    }
  }

  try {
    // T66: the UNKNOWN-WRITE half of the Host-death contract. The Host commits
    // an ACK-dropped write (so the Client's RPC outcome is `indeterminate`),
    // then the committing Host dies. A later Host must read the durable log
    // exactly once (never replay the unknown write), and no Host may ever
    // report that write as a success it did not observe.
    {
      const releaseBarrier = join(workDir, 't66-long-turn.release')
      const { host, ready, workRoot } = await startC1Host('long-turn', 't66', { C1_HOLD_LONG_TURN: releaseBarrier })
      // The lane's own fail-after control: this case's first real Host is alive
      // here, so the case-owned finally must dispose it and release its seat.
      failpoint('recovery.unknown-write-host-death.after-host-spawn')
      const { client } = await startC1Client('T66 Client', { SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK: '1' })
      const unknownToken = 't66 unknown-write'
      const sessionId = await openC1Session(client, unknownToken, 'T66')
      // The injection witness and the Host's held Turn are TWO independent
      // facts: the fault hit this Client's real prompt RPC, and the Host is
      // holding the Turn it already committed.
      await client.waitFor(
        record => record.m4b2s === 'qualification' && record.op === 'prompt-ack-dropped',
        'T66 prompt ACK-drop injection witness',
        60_000,
      )
      await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T66 held Turn')
      const hostBefore = await hostIdentityFacts(host)
      const hostPid = ready.pid
      const text = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
        .filter(entry => entry === unknownToken).length
      assert(text === 1, `T66 the Host did not commit the ACK-dropped write exactly once (${String(text)})`)
      // The Composer/ACK terminal: the RPC ACK is unknown but the Host
      // committed, so the official acceptance may already have cleared the
      // draft. The held long Turn legitimately keeps its working activity;
      // only THIS gesture's generic motion row must be gone.
      const settleDeadline = Date.now() + 60_000
      let disposition
      while (Date.now() < settleDeadline) {
        const viewport = await client.viewport()
        const frame = viewport.join('\n')
        const composer = client.composerOf(viewport)
        const pendingAck = frame.includes('Submitting…') || frame.includes('Queued…')
        if (composer !== undefined && !composer.includes(unknownToken)) {
          if (pendingAck) { await sleep(50); continue }
          disposition = 'accepted'
          break
        }
        if (composer !== undefined && composer.includes(unknownToken)) {
          if (!frame.includes('indeterminate') || pendingAck) { await sleep(50); continue }
          const occurrences = composer.split(unknownToken).length - 1
          assert(occurrences === 1,
            `T66 the retained draft appears ${String(occurrences)} times after the unknown write`)
          disposition = 'unknown'
          break
        }
        await sleep(50)
      }
      assert(disposition !== undefined,
        'T66 the ACK-dropped gesture never reached a settled Composer/ACK state')
      const settledFrame = (await client.viewport()).join('\n')
      assert(!settledFrame.includes('Submitting…') && !settledFrame.includes('Queued…'),
        `T66 left a pending motion row after the ${disposition} disposition`)
      if (disposition === 'accepted') {
        assert(!settledFrame.includes('indeterminate'),
          'T66 an accepted prompt painted the retry/uncertainty notice anyway')
      } else {
        assert(settledFrame.includes('indeterminate'),
          'T66 the unaccepted unknown discarded its uncertainty notice')
      }
      assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === 'prompt-ack-dropped').length === 1,
        'T66 the prompt ACK-drop witness must fire exactly once for this Client')
      // The committing Host dies BEFORE the Turn settles: the write's outcome is
      // now permanently unknown to every Client.
      process.kill(hostPid, 'SIGKILL')
      await waitGone(hostPid, 30_000)
      assert(!alive(hostPid), 'T66 the Host survived SIGKILL')
      const lost = await client.waitFor(
        record => record.m4b2s === 'surface-status' && record.transport !== 'connected',
        'T66 Client observed the official Connection loss',
        60_000,
      )
      assert(lost.transport === 'disconnected' || lost.transport === 'connecting',
        `T66 unexpected Client transport state after the kill: ${JSON.stringify(lost.transport)}`)
      assert(!(await client.viewport()).join('\n').includes('long-turn answer'),
        'T66 the Client painted a settlement for the write whose Host died')
      client.signalBusiness('SIGTERM')
      const exit = await client.waitForExit(60_000)
      assert(exit.code === 0 && exit.signal === null, `T66 Client cleanup exit was ${JSON.stringify(exit)}`)
      await client.dispose()
      // A NEW Host on stale discovery, then a real cold resume of the SAME
      // Session: the durable log must still carry the unknown write EXACTLY ONCE
      // and no fabricated settlement.
      const { client: fresh, ready: freshReady } = await startC1Client('T66 fresh Client')
      const newHost = freshReady.host
      assert(newHost.hostPid !== hostBefore.hostPid, 'T66 stale discovery reused the killed Host PID')
      assert(freshReady.sessionOpen === false, 'T66 the dead Host view survived across the replacement')
      const newInstanceId = newHost.instanceId
      fresh.signalBusiness('SIGTERM')
      const freshExit = await fresh.waitForExit(60_000)
      assert(freshExit.code === 0 && freshExit.signal === null, `T66 fresh Client exit was ${JSON.stringify(freshExit)}`)
      await fresh.dispose()
      const { client: resumed } = await startC1Client('T66 cold-resume Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
      await resumed.waitForScreen(unknownToken, 'T66 cold-resume history')
      const recovered = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T66 cold-resume orphan settlement', 120_000)
      assert(recovered.data?.reason?.kind === 'interrupted',
        `T66 the cold resume settled the unknown write's Turn as ${String(recovered.data?.reason?.kind)}`)
      assert((hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'turn/start').length === 1,
        'T66 the recovered settlement does not belong to the single lost Turn')
      assert(!(await resumed.viewport()).join('\n').includes('long-turn answer'),
        'T66 the cold resume painted a fabricated answer')
      const afterResume = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
        .filter(entry => entry === unknownToken).length
      assert(afterResume === 1, `T66 the cold resume replayed the unknown write (${String(afterResume)} commits)`)
      await exitC1Client(resumed, 'T66 cold-resume Client')
      await stopSpawnedHost(newHost.hostPid, newInstanceId, 'T66 spawned Host')
      trace('t66', {
        hostPid,
        signal: 'SIGKILL',
        rpcOutcome: 'indeterminate',
        ackDropped: 'prompt-ack-dropped',
        composerDisposition: disposition,
        ackSettled: true,
        hostCommits: 1,
        clientObserved: lost.transport,
        replayedAfterResume: false,
        fabricatedSettlement: false,
        newHostPid: newHost.hostPid,
        newInstanceId,
      })
    }
  } finally {
    await scene.dispose()
  }
}
