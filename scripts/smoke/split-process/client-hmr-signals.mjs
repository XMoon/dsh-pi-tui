/**
 * Continuity T57-T65: Client-only HMR and OS signal/Host-loss dispositions.
 *
 * T57-T59 replace the surface revision on the SAME Client PID/Context/
 * transport while a real Host Job keeps running, and prove failure/stop-during-
 * HMR clean up exactly once. T62-T65 deliver real OS signals to the Client or
 * Host and assert the official disposition taxonomy: SIGINT 130, the real
 * double Ctrl+C/Ctrl+D PTY chord, SIGHUP as a process failure (never a fake
 * graceful stop) and SIGKILL as a lost Host whose pending Turn is never
 * reported as settled. Every scenario starts its OWN Host and Clients; the
 * scene never learns from a previous case.
 *
 * @module split-process/client-hmr-signals
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import {
  alive,
  findIsolatedProcesses,
  readJson,
  waitForSurfaceStatus,
  waitGone,
} from '../../lib/split-smoke-processes.mjs'
import {
  hostAssistantHasText,
  hostSessionEvents,
  hostUserTexts,
  waitForHostSessionEvent,
} from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/**
 * Drive the T57-T65 HMR/signal scenes on this run's ONE installation.
 *
 * The case owns every Host and Client through ONE C1 scene; its `finally`
 * disposes them. A Host that a fresh Client discovers after the previous
 * instance died is stopped through its own official SIGTERM admission.
 */
export async function runClientHmrSignals(context) {
  const { workDir, dshHome, trace, failpoint } = context
  const scene = createC1Scene(context)
  const {
    PROTECTED_HOST_ROWS,
    c1JobWorkRoot,
    startC1Host,
    stopC1Host,
    startC1Client,
    exitC1Client,
    openC1Session,
    hostIdentityFacts,
    assertHostIdentityKept,
    hostRowFiberUids,
    assertHostRowsKept,
    sceneScopeId,
    awaitSceneSeatFree,
  } = scene
  try {
    // T12-surface-PTY-HUP: closing the REAL PTY master (the `script(1)`
    // wrapper dies) is a HUP, not a SIGTERM sent to the business Client. The
    // business PID must observe the terminal end and exit; the Host survives
    // for a fresh Client.
    {
      const { host, ready } = await startC1Host('job', 't12-hup')
      // The lane's own fail-after control: this case's first real Host is
      // alive here, so the case-owned finally must dispose it and release its
      // seat.
      failpoint('recovery.client-hmr-signals.after-host-spawn')
      const { client } = await startC1Client('T12 HUP Client')
      const businessPid = client.records.find(record => record.m4a0 === 'ready')?.pid
      assert(typeof businessPid === 'number', 'T12 HUP Client had no business PID')
      const scriptPid = client.child.pid
      try { process.kill(scriptPid, 'SIGKILL') } catch { /* already gone */ }
      await waitGone(businessPid, 20_000)
      assert(!alive(businessPid), 'T12 the business Client survived a real PTY master close')
      await client.dispose().catch(() => {})
      assert(alive(ready.pid), 'T12 the Host died on a Client PTY HUP')
      const { client: recovered } = await startC1Client('T12 HUP recovery Client')
      await exitC1Client(recovered, 'T12 HUP recovery Client')
      await stopC1Host(host)
      trace('t12-pty-hup', { hostPid: ready.pid, clientPid: businessPid, scriptPid, masterClosed: true, clientReusable: true, hostAlive: true })
    }

    // T57: Client-only HMR happy path on the SAME Client PID/Context/transport.
    // The Session is open and its Turn has settled BEFORE the revision
    // replacement, so the new revision must re-adopt a fresh exact
    // `tuiMainView` wrapper rather than starting sessionless.
    {
      const releaseBarrier = join(workDir, 't57-long-turn.release')
      const { host, ready, workRoot } = await startC1Host('long-turn', 't57', { C1_HOLD_LONG_TURN: releaseBarrier })
      const { client } = await startC1Client('T57 Client', { SPLIT_PROCESS_CLIENT_HMR_PROBE: '1' })
      const sessionId = await openC1Session(client, 't57 prompt', 'T57')
      await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T57 initial held Turn')
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T57 initial turn/end')
      const before = await waitForSurfaceStatus(client, record => record.surfaceMounted === true && record.sessionOpen === true && record.openSessionId === sessionId, 'T57 initial surface')
      const hostBefore = await hostIdentityFacts(host)
      const rowsBefore = await hostRowFiberUids(host)
      const beforePid = before.pid
      const beforeRootFiber = before.rootFiberUid
      const beforeGeneration = before.generationId
      const beforeRevision = before.surfaceRevision
      client.signalBusiness('SIGUSR2')
      await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T57 HMR start', 60_000)
      await waitForSurfaceStatus(client, record => record.surfaceRevision === beforeRevision && record.surfaceMounted === false, 'T57 retired surface status', 60_000)
      await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T57 HMR retired', 120_000)
      const hmrReady = await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready', 'T57 HMR ready', 180_000)
      const after = await waitForSurfaceStatus(client, record => record.surfaceRevision === hmrReady.revision && record.surfaceMounted === true, 'T57 new surface status', 120_000)
      assert(after.pid === beforePid, 'T57 the HMR changed the OS PID')
      assert(after.rootFiberUid === beforeRootFiber, 'T57 the HMR changed the Client root Context fiber')
      assert(after.generationId === beforeGeneration, 'T57 the HMR changed the transport generation')
      assert(after.surfaceRevision !== beforeRevision, 'T57 the surface revision did not change')
      assert(after.surfaceFiberUid !== before.surfaceFiberUid, 'T57 the runner fiber did not change')
      assert(after.sessionOpen === true && after.openSessionId === sessionId, 'T57 the new revision did not re-adopt the exact Session wrapper')
      assert(after.owners?.typert === 1 && after.owners?.connection === 1 && after.owners?.remote === 1
        && after.owners?.fileUpload === 1 && after.owners?.sessions === 1 && after.owners?.jobs === 1,
      `T57 duplicate/absent Domain owners after HMR: ${JSON.stringify(after.owners)}`)
      assert(after.privateNamespaces === 2, 'T57 private namespaces were not remounted exactly once')
      for (const operation of ['hmr-revision-start', 'hmr-revision-retired', 'hmr-revision-ready']) {
        assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === operation).length === 1,
          `T57 expected exactly one ${operation} record`)
      }
      await client.waitForScreen('long-turn answer', 'T57 new TTY paint', 120_000)
      await assertHostIdentityKept(host, hostBefore, 'T57 Host identity')
      await assertHostRowsKept(host, rowsBefore, 'T57 Host Loader rows')
      await exitC1Client(client, 'T57 Client')
      await stopC1Host(host)
      trace('t57', { hostPid: ready.pid, clientPid: beforePid, sessionId, revisionBefore: beforeRevision, revisionAfter: after.surfaceRevision, sameContext: true, sameTransport: true, sessionWrapper: 're-adopted', newTty: true, hostRows: 'same loader fibers', hostRowUids: PROTECTED_HOST_ROWS.length })
    }

    // T58: HMR while a real Host Job is running. The Host Job continues
    // across the surface revision; the new surface re-attaches to the same
    // Session and reads the surviving work.
    {
      const { host, ready, workRoot } = await startC1Host('job', 't58', {}, c1JobWorkRoot('t58'))
      const { client } = await startC1Client('T58 Client', { SPLIT_PROCESS_CLIENT_HMR_PROBE: '1' })
      const sessionId = await openC1Session(client, 't58 prompt', 'T58')
      const job = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.event === 'registered', 'T58 running Job')
      assert(typeof job.jobId === 'string' && job.status === 'running', 'T58 no real running Host Job')
      const hostBefore = await hostIdentityFacts(host)
      const rowsBefore = await hostRowFiberUids(host)
      client.signalBusiness('SIGUSR2')
      await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T58 HMR start')
      await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T58 HMR retired', 120_000)
      await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready', 'T58 HMR ready', 180_000)
      const after = await waitForSurfaceStatus(client, record => record.sessionOpen === true && record.openSessionId === sessionId, 'T58 new surface Session', 120_000)
      assert(after.pid === client.records.find(record => record.m4a0 === 'ready')?.pid, 'T58 the HMR changed the Client PID')
      assert(after.owners?.sessions === 1 && after.owners?.jobs === 1 && after.privateNamespaces === 2,
        'T58 duplicate/absent owners after HMR')
      assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired').length === 1,
        'T58 duplicate HMR retirement records')
      assert(alive(ready.pid), 'T58 the Host died during HMR')
      await assertHostIdentityKept(host, hostBefore, 'T58 Host after HMR')
      await assertHostRowsKept(host, rowsBefore, 'T58 Host Loader rows')
      assert(readC1WorkEvents(workRoot).every(event => !(event.kind === 'job-event' && event.jobId === job.jobId && event.event === 'settled')),
        'T58 the HMR settled the running Host Job')
      writeFileSync(join(workRoot, 'job.release'), 'release\n', { mode: 0o600 })
      const settled = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.jobId === job.jobId && event.event === 'settled', 'T58 Job settled after HMR', 120_000)
      assert(settled.status === 'completed', `T58 Job settled as ${JSON.stringify(settled.status)}`)
      await client.waitForScreen('job accepted', 'T58 new surface Job readback', 120_000)
      await exitC1Client(client, 'T58 Client')
      await stopC1Host(host)
      trace('t58', { hostPid: ready.pid, sessionId, jobId: job.jobId, hmrDuringJob: true, jobContinued: true, newSurfaceReadback: true, hostRows: 'same loader fibers', hostRowUids: PROTECTED_HOST_ROWS.length })
    }

    // T59: HMR failure and stop-during-HMR both fail closed with exactly one
    // reverse disposal and no second TTY owner.
    {
      const { host, ready } = await startC1Host('job', 't59')
      const { client } = await startC1Client('T59 failure Client', {
        SPLIT_PROCESS_CLIENT_HMR_PROBE: '1',
        SPLIT_PROCESS_CLIENT_HMR_FAIL: '1',
      })
      const c1Pid = client.records.find(record => record.m4a0 === 'ready')?.pid
      client.signalBusiness('SIGUSR2')
      await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T59 failure HMR start')
      await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T59 failure HMR retired', 120_000)
      await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-failure', 'T59 HMR failure', 120_000)
      const failureExit = await client.waitForExit(60_000)
      assert(failureExit.code === 1, `T59 HMR failure exit was ${JSON.stringify(failureExit)}`)
      for (const operation of ['hmr-revision-start', 'hmr-revision-retired', 'hmr-revision-failure']) {
        assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === operation).length === 1,
          `T59 expected exactly one ${operation} record on HMR failure`)
      }
      const closed = client.records.find(record => record.m4b2s === 'client-closed')
      assert(closed !== undefined, 'T59 HMR failure did not emit the final Client owner inventory')
      for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
        assert(closed.owners?.[owner] === 0, `T59 HMR failure left ${owner} owner alive`)
      }
      assert(alive(ready.pid), 'T59 HMR failure killed the Host')
      await client.dispose()
      const reuse = await startC1Client('T59 reuse Client')
      await exitC1Client(reuse.client, 'T59 reuse Client')
      await stopC1Host(host)
      trace('t59-failure', { hostPid: ready.pid, clientPid: c1Pid, exit: failureExit.code, clientReusable: true, hostAlive: true })

      const barrier = join(workDir, 't59-hmr-hold')
      const { host: stopHost, ready: stopReady } = await startC1Host('job', 't59-stop')
      const { client: stopping } = await startC1Client('T59 stop Client', {
        SPLIT_PROCESS_CLIENT_HMR_PROBE: '1',
        SPLIT_PROCESS_CLIENT_HMR_HOLD: `surface@${barrier}`,
      })
      stopping.signalBusiness('SIGUSR2')
      await stopping.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T59 stop HMR start')
      await stopping.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T59 stop HMR retired', 120_000)
      stopping.signalBusiness('SIGTERM')
      await stopping.waitFor(record => record.m4a0 === 'signal' && record.signal === 'SIGTERM', 'T59 stop signal admitted', 30_000)
      writeFileSync(barrier, 'release\n', { mode: 0o600 })
      const stopExit = await stopping.waitForExit(60_000)
      assert(stopExit.code === 0, `T59 stop-during-HMR exit was ${JSON.stringify(stopExit)}`)
      assert(stopping.records.filter(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start').length === 1,
        'T59 stop-during-HMR emitted a duplicate revision start')
      assert(stopping.records.filter(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired').length === 1,
        'T59 stop-during-HMR emitted a duplicate revision retirement')
      assert(!stopping.records.some(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready'),
        'T59 stop-during-HMR published a fake ready revision')
      assert(!stopping.records.some(record => record.m4a0 === 'cleanup-failure'), 'T59 stop-during-HMR reported a cleanup failure')
      assert(alive(stopReady.pid), 'T59 stop-during-HMR killed the Host')
      await stopping.dispose()
      await stopC1Host(stopHost)
      trace('t59-stop', { hostPid: stopReady.pid, exit: stopExit.code, cleanupFailures: 0, hostAlive: true })
    }

    // ── Fatal Host conditions and signal dispositions (T62–T65) ──────────
    /**
     * Stop a Host this lane did not create through `startC1Host`: the one a
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
    /** The live `dist/local-host.mjs` PIDs of THIS isolated DSH home. */
    const liveHostPids = () => findIsolatedProcesses(dshHome).filter(pid => {
      try {
        return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').includes('local-host.mjs')
      } catch {
        return false
      }
    })

    // T62: a real SIGINT delivered to the Client BUSINESS PID (never to the
    // `script(1)` wrapper) is the official 130 disposition: the Client's own
    // resources are released, the Host keeps its live identity, and a fresh
    // Client reads the existing Session history back. The Client never
    // signals the Host.
    {
      // The `long-turn` fixture REQUIRES its barrier; release it immediately so
      // the first Turn settles before the signal is sent.
      const releaseBarrier = join(workDir, 't62-long-turn.release')
      const { host, ready, workRoot } = await startC1Host('long-turn', 't62', { C1_HOLD_LONG_TURN: releaseBarrier })
      const { client } = await startC1Client('T62 Client')
      const sessionId = await openC1Session(client, 't62 prompt', 'T62')
      await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T62 held Turn')
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T62 settled Turn')
      const hostBefore = await hostIdentityFacts(host)
      const businessPid = client.records.find(record => record.m4a0 === 'ready')?.pid
      assert(Number.isInteger(businessPid), 'T62 the Client never published its business PID')
      client.signalBusiness('SIGINT')
      const admitted = await client.waitFor(
        record => record.m4a0 === 'signal' && record.signal === 'SIGINT',
        'T62 Client SIGINT admitted',
        30_000,
      )
      assert(admitted.pid === businessPid, 'T62 the SIGINT record did not come from the business PID')
      const exit = await client.waitForExit(60_000)
      assert(exit.code === 130 && exit.signal === null,
        `T62 Client SIGINT exit was ${JSON.stringify(exit)}, expected code 130`)
      await client.dispose()
      assert(alive(ready.pid), 'T62 the Client SIGINT killed the Host')
      await assertHostIdentityKept(host, hostBefore, 'T62 Host after Client SIGINT')
      const { client: reader } = await startC1Client('T62 reader Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
      await reader.waitForScreen('t62 prompt', 'T62 history readback')
      await exitC1Client(reader, 'T62 reader Client')
      await stopC1Host(host)
      trace('t62', {
        hostPid: ready.pid,
        clientPid: businessPid,
        signal: 'SIGINT',
        exitCode: exit.code,
        clientResourcesReleased: true,
        hostIdentityKept: true,
        historyReadback: true,
      })
    }

    // T63: the DEFAULT keyboard exit chord driven through the REAL PTY. Both
    // Ctrl+C and Ctrl+D require the SAME key twice inside the confirmation
    // window; one press is never enough. These are typed bytes on the pty
    // master, not signals. Ctrl+D needs an EMPTY draft (a non-empty draft turns
    // it into the editor's forward-delete).
    {
      const releaseBarrier = join(workDir, 't63-long-turn.release')
      const { host, ready, workRoot } = await startC1Host('long-turn', 't63', { C1_HOLD_LONG_TURN: releaseBarrier })
      const hostBefore = await hostIdentityFacts(host)
      const { client: ctrlC } = await startC1Client('T63 Ctrl+C Client')
      const sessionId = await openC1Session(ctrlC, 't63 prompt', 'T63')
      await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T63 held Turn')
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T63 settled Turn')
      // The product's OWN armed-exit cue is painted in the footer; waiting for
      // it (and then for it to expire) is what makes this a double-press proof
      // instead of "the key exits":
      //   1. ONE press arms and paints the hint, and does NOT exit;
      //   2. the hint disappears when the confirmation window closes, and the
      //      Client is still alive;
      //   3. ONE more press arms again, and the NEXT one inside that window
      //      exits through the real controller.
      ctrlC.send('\x03')
      await ctrlC.waitForScreen('again to exit', 'T63 Ctrl+C confirmation armed')
      await ctrlC.waitForScreenGone('again to exit', 'T63 Ctrl+C confirmation expired')
      assert(!ctrlC.exited, 'T63 a SINGLE Ctrl+C press already exited the Client')
      ctrlC.send('\x03')
      await ctrlC.waitForScreen('again to exit', 'T63 Ctrl+C confirmation re-armed')
      ctrlC.send('\x03')
      const ctrlCExit = await ctrlC.waitForExit(60_000)
      assert(ctrlCExit.code === 0 && ctrlCExit.signal === null,
        `T63 Ctrl+C double press exit was ${JSON.stringify(ctrlCExit)}`)
      await ctrlC.dispose()
      assert(alive(ready.pid), 'T63 the Ctrl+C exit killed the Host')
      await assertHostIdentityKept(host, hostBefore, 'T63 Host after Ctrl+C')

      const { client: ctrlD } = await startC1Client('T63 Ctrl+D Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
      await ctrlD.waitForScreen('t63 prompt', 'T63 history readback before Ctrl+D')
      // Ctrl+D needs an EMPTY draft (a non-empty draft turns it into the
      // editor's forward-delete) and the SAME key twice inside the window.
      ctrlD.send('\x04')
      await ctrlD.waitForScreen('again to exit', 'T63 Ctrl+D confirmation armed')
      await ctrlD.waitForScreenGone('again to exit', 'T63 Ctrl+D confirmation expired')
      assert(!ctrlD.exited, 'T63 a SINGLE Ctrl+D press already exited the Client')
      ctrlD.send('\x04')
      await ctrlD.waitForScreen('again to exit', 'T63 Ctrl+D confirmation re-armed')
      ctrlD.send('\x04')
      const ctrlDExit = await ctrlD.waitForExit(60_000)
      assert(ctrlDExit.code === 0 && ctrlDExit.signal === null,
        `T63 Ctrl+D double press exit was ${JSON.stringify(ctrlDExit)}`)
      await ctrlD.dispose()
      assert(alive(ready.pid), 'T63 the Ctrl+D exit killed the Host')
      await assertHostIdentityKept(host, hostBefore, 'T63 Host after Ctrl+D')
      const { client: recovered } = await startC1Client('T63 recovery Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
      await recovered.waitForScreen('t63 prompt', 'T63 history readback after both exits')
      await exitC1Client(recovered, 'T63 recovery Client')
      await stopC1Host(host)
      trace('t63', {
        hostPid: ready.pid,
        ctrlC: { presses: 2, exitCode: ctrlCExit.code, via: 'real pty typed input' },
        ctrlD: { presses: 2, exitCode: ctrlDExit.code, via: 'real pty typed input', draft: 'empty' },
        hostIdentityKept: true,
        sessionPreserved: true,
      })
    }

    // T64: a REAL SIGHUP is a process/terminal failure, NOT the official
    // graceful stop (the Host registers no SIGHUP handler by contract). The
    // attached Client must observe the official Connection loss without
    // fabricating a settlement for the lost Turn; the dead instance is never
    // revived, and stale discovery starts a NEW Host with a new identity.
    {
      const holdRelease = join(workDir, 't64-long-turn.release')
      const { host, ready, workRoot } = await startC1Host('long-turn', 't64', { C1_HOLD_LONG_TURN: holdRelease })
      const { client } = await startC1Client('T64 Client')
      const sessionId = await openC1Session(client, 't64 prompt', 'T64')
      const held = await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T64 held Turn')
      assert(held.agentStatus === 'running', `T64 the Host Agent was ${JSON.stringify(held.agentStatus)} while the Turn was held`)
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/start', 'T64 turn/start')
      const hostBefore = await hostIdentityFacts(host)
      const hostPid = ready.pid
      process.kill(hostPid, 'SIGHUP')
      await waitGone(hostPid, 30_000)
      assert(!alive(hostPid), 'T64 the Host survived a real SIGHUP')
      const lost = await client.waitFor(
        record => record.m4b2s === 'surface-status' && record.transport !== 'connected',
        'T64 Client observed the official Connection loss',
        60_000,
      )
      assert(lost.transport === 'disconnected' || lost.transport === 'connecting',
        `T64 unexpected Client transport state after the HUP: ${JSON.stringify(lost.transport)}`)
      // The lost Turn is never reported as settled, and no answer is invented.
      const afterHup = hostSessionEvents(dshHome, sessionId) ?? []
      assert(!afterHup.some(event => event.type === 'turn/end'),
        'T64 the lost Turn was reported as settled after a Host SIGHUP')
      assert(!hostAssistantHasText(afterHup, 'long-turn answer'),
        'T64 an answer was fabricated for the Turn lost in a Host SIGHUP')
      assert(!(await client.viewport()).join('\n').includes('long-turn answer'),
        'T64 the Client painted a fabricated answer for the Turn lost in a Host SIGHUP')
      // An ordinary carrier loss is retryable, not fatal: the Client is alive.
      assert(!client.exited, 'T64 the Client treated an ordinary Host carrier loss as a fatal exit')
      client.signalBusiness('SIGTERM')
      const exit = await client.waitForExit(60_000)
      assert(exit.code === 0 && exit.signal === null, `T64 Client cleanup exit was ${JSON.stringify(exit)}`)
      assert(!client.records.some(record => record.m4a0 === 'cleanup-failure'),
        'T64 the Client reported a cleanup failure after the Host SIGHUP')
      await client.dispose()
      // Stale discovery: a fresh Client must create a NEW instance, never
      // revive the dead one, and must not claim the old Session is open.
      const { client: fresh, ready: freshReady } = await startC1Client('T64 fresh Client')
      const newHost = freshReady.host
      assert(newHost.hostPid !== hostBefore.hostPid, 'T64 stale discovery reused the dead Host PID')
      assert(newHost.instanceId !== hostBefore.instanceId, 'T64 stale discovery reused the dead Host instance')
      assert(newHost.hostStarttime !== hostBefore.hostStarttime, 'T64 the new Host reuses the dead start identity')
      assert(freshReady.sessionOpen === false, 'T64 a sessionless Client claimed an open Session across a Host replacement')
      assert(JSON.stringify(liveHostPids()) === JSON.stringify([newHost.hostPid]),
        `T64 expected exactly the new Host to be live, found ${JSON.stringify(liveHostPids())}`)
      const newInstanceId = newHost.instanceId
      fresh.signalBusiness('SIGTERM')
      const freshExit = await fresh.waitForExit(60_000)
      assert(freshExit.code === 0 && freshExit.signal === null,
        `T64 fresh Client exit was ${JSON.stringify(freshExit)}`)
      await fresh.dispose()
      await stopSpawnedHost(newHost.hostPid, newInstanceId, 'T64 spawned Host')
      trace('t64', {
        hostPid,
        signal: 'SIGHUP',
        classification: 'process failure, not the official graceful stop',
        clientObserved: lost.transport,
        fabricatedSettlement: false,
        clientExit: exit.code,
        newHostPid: newHost.hostPid,
        newInstanceId,
        clientResourcesReleased: true,
      })
    }

    // T65: a REAL SIGKILL of the Host while a Client is attached and the
    // Session is open. The official Connection goes disconnected, the pending
    // write never fakes success, the old `tuiMainView` does not survive across
    // Hosts, and a cold resume reads the durable log truthfully without
    // replaying the unknown write.
    {
      const holdRelease = join(workDir, 't65-long-turn.release')
      const { host, ready, workRoot } = await startC1Host('long-turn', 't65', { C1_HOLD_LONG_TURN: holdRelease })
      const { client } = await startC1Client('T65 Client')
      const sessionId = await openC1Session(client, 't65 prompt', 'T65')
      await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T65 held Turn')
      const hostBefore = await hostIdentityFacts(host)
      const hostPid = ready.pid
      process.kill(hostPid, 'SIGKILL')
      await waitGone(hostPid, 30_000)
      assert(!alive(hostPid), 'T65 the Host survived SIGKILL')
      const lost = await client.waitFor(
        record => record.m4b2s === 'surface-status' && record.transport !== 'connected',
        'T65 Client observed the official Connection loss',
        60_000,
      )
      assert(lost.transport === 'disconnected' || lost.transport === 'connecting',
        `T65 unexpected Client transport state after the kill: ${JSON.stringify(lost.transport)}`)
      const afterKill = hostSessionEvents(dshHome, sessionId) ?? []
      assert(!afterKill.some(event => event.type === 'turn/end'),
        'T65 the pending Turn was reported as settled after a Host SIGKILL')
      assert(hostUserTexts(afterKill).filter(text => text === 't65 prompt').length === 1,
        'T65 the accepted write was lost or duplicated by the Host SIGKILL')
      assert(!client.exited, 'T65 the Client treated an ordinary Host carrier loss as a fatal exit')
      client.signalBusiness('SIGTERM')
      const exit = await client.waitForExit(60_000)
      assert(exit.code === 0 && exit.signal === null, `T65 Client cleanup exit was ${JSON.stringify(exit)}`)
      await client.dispose()
      // No cross-Host continuity: a sessionless Client gets a NEW Host and no
      // inherited Session; only one Host owner exists at a time.
      const { client: fresh, ready: freshReady } = await startC1Client('T65 fresh Client')
      const newHost = freshReady.host
      assert(newHost.hostPid !== hostBefore.hostPid, 'T65 stale discovery reused the killed Host PID')
      assert(newHost.instanceId !== hostBefore.instanceId, 'T65 stale discovery reused the killed Host instance')
      assert(freshReady.sessionOpen === false, 'T65 the old tuiMainView survived across a Host replacement')
      assert(JSON.stringify(liveHostPids()) === JSON.stringify([newHost.hostPid]),
        `T65 expected exactly one live Host owner, found ${JSON.stringify(liveHostPids())}`)
      const newInstanceId = newHost.instanceId
      // The sessionless Client is disposed before the cold-resume Client
      // starts; the two real surfaces could legally coexist, but this case
      // needs the cold resume to run after that Client released its state.
      fresh.signalBusiness('SIGTERM')
      const freshExit65 = await fresh.waitForExit(60_000)
      assert(freshExit65.code === 0 && freshExit65.signal === null,
        `T65 fresh Client exit was ${JSON.stringify(freshExit65)}`)
      await fresh.dispose()
      // A COLD resume of the same Session reads the durable history: the user
      // write is there exactly once and NO answer is invented for the lost Turn.
      const { client: resumed } = await startC1Client('T65 cold-resume Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
      await resumed.waitForScreen('t65 prompt', 'T65 cold-resume history')
      // The OFFICIAL Session open records the orphaned Turn's settlement. Waiting
      // for that durable record (not a timer) is what orders "after the resume,
      // nothing else is pending".
      const recovered = await waitForHostSessionEvent(
        dshHome,
        sessionId,
        event => event.type === 'turn/end',
        'T65 cold-resume orphan settlement',
        120_000,
      )
      // The official crash-recovery closer settles an orphaned turn with its own
      // reason. "Not completed" would also accept an absent/unknown reason, so the
      // exact taxonomy is asserted, on the Session's ONE open turn.
      assert(recovered.data?.reason?.kind === 'interrupted',
        `T65 the cold resume settled the lost Turn as ${String(recovered.data?.reason?.kind)}`)
      assert((hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'turn/start').length === 1,
        'T65 the recovered settlement does not belong to the single lost Turn')
      const afterResume = hostSessionEvents(dshHome, sessionId) ?? []
      assert(hostUserTexts(afterResume).filter(text => text === 't65 prompt').length === 1,
        'T65 the cold resume replayed the unknown write')
      // The official Session open may record the ORPHANED Turn as a
      // fail-closed settlement (an interrupted Turn is truthful recovery and
      // is what the user must see). What it must never do is report that lost
      // work as SUCCESS or invent an answer for it.
      for (const settled of afterResume.filter(event => event.type === 'turn/end')) {
        const kind = settled.data?.reason?.kind
        assert(kind !== 'completed' && kind !== 'max-tokens',
          `T65 the cold resume settled the lost Turn as ${String(kind)}`)
      }
      assert(!hostAssistantHasText(afterResume, 'long-turn answer'),
        'T65 the cold resume fabricated an answer for the lost Turn')
      assert(!(await resumed.viewport()).join('\n').includes('long-turn answer'),
        'T65 the resumed surface painted a fabricated answer for the lost Turn')
      await exitC1Client(resumed, 'T65 cold-resume Client')
      await stopSpawnedHost(newHost.hostPid, newInstanceId, 'T65 spawned Host')
      trace('t65', {
        hostPid,
        signal: 'SIGKILL',
        clientObserved: lost.transport,
        pendingTurnSettled: false,
        unknownWriteReplayed: false,
        crossHostViewContinuity: false,
        newHostPid: newHost.hostPid,
        newInstanceId,
        singleHostOwner: true,
      })
    }
  } finally {
    await scene.dispose()
  }
}
