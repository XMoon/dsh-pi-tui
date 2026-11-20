/**
 * M6 UX PR2: the real Settings/Exit UI drives the Profile Host stop decision.
 *
 * One real Host and REAL Surface Clients (`script(1)` PTYs). A Client saves a
 * VERIFIED `daemon → direct` Backend in the real Settings workspace, then
 * `/exit`s and takes the ONE whole-Host stop confirm:
 *   - `Leave daemon Host running and exit` keeps the old Host (and a sibling
 *     Client) alive, performs ZERO manager stop, and exits 0;
 *   - a second Client's `Stop daemon Host and exit` releases its B1 transport
 *     before the ONE authenticated `daemon stop` runs AFTER the terminal
 *     restore: the old Host process exits and is verified gone, the sibling
 *     Client loses that instance and fails closed, and the stopping Client
 *     exits 0 with NO terminal transport failure of its own.
 *
 * This is the A09/A11 process-lifecycle proof that unit tests cannot give (the
 * Remote transport disconnect races the Client exit lifecycle, and a signal
 * stop must actually end the Host process). It references the Linux/macOS
 * manager lanes for the OS install/stop fact; it does NOT re-run them.
 *
 * @module split-process/daemon-ui-host-stop-m6-ux-pr2
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { alive, readStartIdentity } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { submitLine } from './mcp-servers-fr3.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

async function frameOf(client) {
  return (await client.viewport().catch(() => [])).join('\n')
}

/**
 * The ONE Host process identity this run must prove gone: the PID and kernel
 * starttime the Host itself published. A later PID owner with a DIFFERENT
 * starttime is a reused PID, not the old Host.
 */
function recordedHostProcess(identity) {
  assert(Number.isInteger(identity?.hostPid) && typeof identity?.hostStarttime === 'string',
    `the Host identity carries no kernel process fact: ${JSON.stringify(identity)}`)
  return { pid: identity.hostPid, starttime: identity.hostStarttime }
}

/**
 * The recorded Host process REALLY exited. The authority is the OS fact, not a
 * control-channel answer: an unreachable Host must never be read as a stopped
 * one, which is exactly what a `status` probe failure would do.
 */
async function waitHostProcessGone(recorded, label, timeoutMs = 60_000) {
  const started = Date.now()
  for (;;) {
    const running = alive(recorded.pid)
    const current = running ? readStartIdentity(recorded.pid) : undefined
    // Gone = the recorded PID no longer exists, or it now belongs to a process
    // with a DIFFERENT kernel starttime (PID reuse). A live PID whose starttime
    // cannot be read is UNKNOWN: `undefined` must never be read as gone.
    if (!running || (current !== undefined && current !== recorded.starttime)) {
      return { pid: recorded.pid, starttime: recorded.starttime, observed: current ?? null }
    }
    assert(Date.now() - started < timeoutMs,
      `${label}: the recorded Host process is still alive or its kernel identity is unreadable `
      + `(pid=${String(recorded.pid)} starttime=${String(current ?? 'unreadable')})`)
    await sleep(100)
  }
}

async function waitForText(client, text, label, timeoutMs = 90_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if ((await frameOf(client)).includes(text)) return
    await sleep(100)
  }
  throw new SplitSmokeAssertionError(`${label}: wanted ${JSON.stringify(text)}; frame=${JSON.stringify((await client.viewport()).slice(-20))}`)
}

async function waitForPattern(client, pattern, label, timeoutMs = 90_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (pattern.test(await frameOf(client))) return
    await sleep(100)
  }
  throw new SplitSmokeAssertionError(`${label}: wanted ${String(pattern)}; frame=${JSON.stringify((await client.viewport()).slice(-20))}`)
}

async function selectFrame(client, predicate, label, limit = 24) {
  for (let step = 0; step < limit; step += 1) {
    if (predicate(await frameOf(client))) return
    client.send('\x1b[B')
    await sleep(140)
  }
  throw new SplitSmokeAssertionError(`${label}: the target was never selected; frame=${JSON.stringify((await client.viewport()).slice(-20))}`)
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const selectedRow = (frame, label) => new RegExp(`^.*> ${escapeRegExp(label)}(?:\\s|$)`, 'mu').test(frame)

/** Open the Backend Detail through the REAL Settings UI (ends on the fact view). */
async function openBackendDetail(client, label) {
  await submitLine(client, '/settings', `${label} /settings`)
  await waitForText(client, 'Settings · Categories', `${label} Settings root`)
  await selectFrame(client, frame => /^> General(?:\s|$)/mu.test(frame), `${label} General category`)
  client.send('\r')
  await sleep(200)
  await selectFrame(client, frame => selectedRow(frame, 'Backend'), `${label} Backend row`)
  client.send('\r')
  await waitForText(client, 'Which backend a new launch runs', `${label} Backend detail`)
}

/**
 * Save ONE verified Backend candidate and dismiss any direct→daemon install
 * follow-up with Esc (`Not now`: zero manager IO). Leaves the panel on the
 * Backend Detail so a second candidate can be saved.
 */
async function chooseBackend(client, target, label) {
  const wanted = new RegExp(`^.*> ${target}(?:\\s|$)`, 'mu')
  // The choice can be invalidated by a settings refresh between the open and the
  // navigation; re-open it and retry instead of racing one frame.
  for (let round = 0; round < 4; round += 1) {
    if (wanted.test(await frameOf(client))) break
    await waitForText(client, 'Enter choose', `${label} choose action`)
    await sleep(300)
    if (!/Choose value/u.test(await frameOf(client))) client.send('\r')
    try {
      await waitForText(client, 'Confirm', `${label} backend choice`, 6_000)
    } catch {
      continue
    }
    // The choice opens with the focus on the CURRENT candidate and the list
    // CLAMPS (no wrap): the other value may be above OR below it, so probe both
    // directions instead of assuming a list order.
    for (let step = 0; step < 8 && !wanted.test(await frameOf(client)); step += 1) {
      client.send(step % 2 === 0 ? '\x1b[A' : '\x1b[B')
      await sleep(250)
    }
    if (wanted.test(await frameOf(client))) break
  }
  if (!wanted.test(await frameOf(client))) {
    console.error('PR2_CHOICE_STUCK', label, JSON.stringify(await frameOf(client)))
  }
  assert(wanted.test(await frameOf(client)), `${label} ${target} candidate not focused`)
  client.send('\r')
  await waitForPattern(client, /Verified/u, `${label} ${target} verified`)
  await sleep(300)
  if ((await frameOf(client)).includes('Optional OS supervision')) {
    client.send('\x1b') // Not now — the install offer performs zero manager IO
    await sleep(300)
  }
}

/** Close the Settings workspace (Detail→Rows→Categories→closed) before `/exit`. */
async function closeSettings(client, label) {
  for (let step = 0; step < 4; step += 1) {
    const frame = await frameOf(client)
    if (!/Settings ·/u.test(frame)) return
    client.send('\x1b')
    await sleep(250)
  }
  const frame = await frameOf(client)
  assert(!/Settings ·/u.test(frame), `${label} Settings workspace did not close: ${JSON.stringify(frame.slice(-8))}`)
}

/** Take the whole-Host stop confirm's SAFE detach (`Leave…`) after `/exit`. */
async function exitLeave(client, label) {
  client.send('/exit\r')
  await waitForText(client, 'Leave daemon Host running and exit', `${label} host-stop confirm`, 60_000)
  client.send('\r')
  const exit = await client.waitForExit(60_000)
  assert(exit.code === 0 && exit.signal === null, `${label} Leave exit was ${JSON.stringify(exit)}`)
  return exit
}

/** Take the whole-Host stop confirm's DESTRUCTIVE branch (`Stop…`) after `/exit`. */
async function exitStop(client, label) {
  client.send('/exit\r')
  await waitForText(client, 'Stop daemon Host and exit', `${label} host-stop confirm`, 60_000)
  await selectFrame(client, frame => /^.*> Stop daemon Host and exit(?:\s|$)/mu.test(frame), `${label} Stop focus`, 6)
  client.send('\r')
  const exit = await client.waitForExit(90_000)
  // The explicit Stop hands the ONE authorization to the final exit root, which
  // runs the authenticated admin stop AFTER the terminal restore. The exit code
  // is that control-plane verdict, so a confirmed stop is 0 and every refusal or
  // unconfirmed transition keeps its own non-zero class.
  assert(exit.code === 0 && exit.signal === null, `${label} Stop exit was ${JSON.stringify(exit)}`)
  return exit
}

/**
 * One verified Backend save end to end. A settings refresh may invalidate the
 * open value modal; a fresh Settings lease is the only deterministic recovery,
 * so retry the WHOLE open+navigate+choose instead of racing one frame.
 */
async function saveBackend(client, target, label) {
  for (let round = 0; round < 3; round += 1) {
    try {
      await openBackendDetail(client, label)
      await chooseBackend(client, target, label)
      return
    } catch {
      try { client.send('\x1b') } catch {}
      await closeSettings(client, label)
      await sleep(500)
    }
  }
  throw new SplitSmokeAssertionError(`${label}: the ${target} Backend save never settled`)
}

/** Run the Settings→exit whole-Host stop lifecycle. */
export async function runDaemonUiHostStop(context) {
  const { trace, dshHome } = context
  // Seed the Profile's persisted Backend as `daemon` BEFORE either process boots,
  // so the Client's ONE verified `direct` save is the real daemon→direct
  // conversion that arms the exit-time whole-Host stop confirm.
  writeFileSync(join(dshHome, 'settings.yaml'), 'tui-startup:\n  backend: daemon\n')
  const scene = createC1Scene(context)
  const { startC1Host, startC1Client, hostIdentityFacts, assertHostIdentityKept, dispose } = scene
  try {
    const { host } = await startC1Host('daemon-ui-host-stop', 'PR2 Host')
    const { client: clientA } = await startC1Client('PR2 A')
    const { client: clientB } = await startC1Client('PR2 B')
    const before = await hostIdentityFacts(host)

    // A: a verified direct→daemon save (the install follow-up, dismissed with
    // Not now: zero manager IO), then — after reopening Settings — a verified
    // daemon→direct save that records the transient exit intent. `/exit` then
    // takes the whole-Host stop confirm.
    await saveBackend(clientA, 'Direct', 'PR2 A')
    await closeSettings(clientA, 'PR2 A')
    await exitLeave(clientA, 'PR2 A')
    trace('pr2.leave-exit', { exitCode: 0 })

    // The old Host and the sibling Client SURVIVE the safe Leave.
    await waitForText(clientB, 'pi-tui', 'PR2 B still painted after A left')
    await assertHostIdentityKept(host, before, 'PR2 Host after A Leave')
    // B is still a live Client process attached to the SAME Host instance: the
    // safe Leave never tore the shared Host or the sibling Client down.
    assert(!clientB.exited, 'the sibling Client process is still alive after A leaves')
    trace('pr2.leave-survival', { hostKept: true, siblingKept: true })

    // A2: the same two verified saves, then the DESTRUCTIVE Stop.
    const { client: clientA2 } = await startC1Client('PR2 A2')
    // A already persisted `direct`; A2 must first restore `daemon` and then save
    // `direct` again — that measurement is the real daemon→direct conversion.
    await saveBackend(clientA2, 'Daemon', 'PR2 A2')
    await closeSettings(clientA2, 'PR2 A2')
    await saveBackend(clientA2, 'Direct', 'PR2 A2')
    await closeSettings(clientA2, 'PR2 A2')
    const stopExit = await exitStop(clientA2, 'PR2 A2')
    trace('pr2.stop-exit', { exitCode: stopExit.code })
    // F3 negative control (committed Stop): the EXPECTED disconnect that follows
    // this Client's own whole-Host stop must never reach it as a terminal
    // transport identity failure. The confirmed exit released the B1 transport
    // BEFORE the control plane ran, so the ONE exit controller owns the code.
    const stopFailures = clientA2.records.filter(record => record.m4a0 === 'failure')
    assert(stopFailures.length === 0,
      `the confirmed Stop must not turn the expected disconnect into a Client failure: ${JSON.stringify(stopFailures)}`)
    trace('pr2.stop-no-failure', { failureRecords: 0 })

    // The old Host PROCESS is verified gone by the OS: the exact PID/kernel
    // starttime it published before the stop no longer exists. A control-
    // channel probe is deliberately NOT the proof here — an unreachable Host
    // must never be read as a stopped one.
    const gone = await waitHostProcessGone(recordedHostProcess(before), 'PR2 Host stopped after the explicit Stop')
    trace('pr2.stop-gone', { hostVerifiedGone: true, pid: gone.pid, pidReused: gone.observed !== null })

    // The explicit Stop destroyed B's old Host instance: B can no longer hold a
    // clean connection to it (its transport drops), so its exit is NOT a clean
    // detach of a live Host. That is exactly the A11 sibling-isolation fact.
    if (!clientB.exited) await clientB.waitForExit(60_000).catch(() => undefined)
    // F3 negative control (NO Stop commit): the same Host disappearance is a
    // REAL terminal failure for a Client that never confirmed a stop. It must
    // still fail closed through the recorded transport scope error, never exit
    // as if the Host were still serving it.
    const siblingFailure = clientB.records.find(record => record.m4a0 === 'failure')
    trace('pr2.sibling-after-stop', {
      exited: clientB.exited,
      exit: clientB.exitResult ?? null,
      failureCode: siblingFailure?.code ?? null,
    })
    assert(clientB.exited && clientB.exitResult?.code !== 0,
      `the sibling Client cannot keep the stopped Host instance (exited=${String(clientB.exited)}, exit=${JSON.stringify(clientB.exitResult)})`)
    assert(siblingFailure?.code === 'LOCAL_FILE_UNSAFE',
      `the sibling Client must fail through the terminal local-discovery refusal: ${JSON.stringify(clientB.records.filter(record => record.m4a0 === 'failure' || record.m4a0 === 'cleanup-failure'))}`)
    await clientB.dispose().catch(() => {})
  } finally {
    await dispose()
  }
  return {
    status: 'PASS',
    scope: 'REAL_SPLIT_PROCESS_L6',
    leave: { hostKept: true, siblingKept: true },
    stop: { hostVerifiedGone: true, noTerminalTransportFailure: true, siblingLostInstance: true },
  }
}

/**
 * Path 3 (A14) on the REAL wire: a second Client's real Settings write is only
 * observable through the FIRST Client's fresh authoritative read.
 *
 * The first Client's committed config mirror is deliberately held stale (a
 * qualification-only deferred invalidation) so `read()` still reports `direct`
 * while the Host already persists `daemon`. The exit intent therefore opens the
 * whole-Host stop verification with a stale-but-ready mirror, and the REAL
 * `readFresh()` must reject the transition — a plain `read()` would have
 * authorized the Stop. The old Host must keep its exact kernel identity (ZERO
 * admin stops) and the Client must exit as a plain detach.
 */
export async function runDaemonUiHostStopPath3(context) {
  const { trace, dshHome } = context
  writeFileSync(join(dshHome, 'settings.yaml'), 'tui-startup:\n  backend: direct\n')
  const scene = createC1Scene(context)
  const { startC1Host, startC1Client, hostIdentityFacts, assertHostIdentityKept, dispose } = scene
  try {
    const { host } = await startC1Host('daemon-control.m6-ux-pr2-ui-host-stop-path3', 'PR3 Host')
    const before = await hostIdentityFacts(host)
    // A: the Client that will attempt the Stop. Its invalidation is deferred, so
    // its committed mirror keeps the last value it read.
    const { client: clientA } = await startC1Client('PR3 A', { SPLIT_PROCESS_CLIENT_DEFER_SETTINGS_INVALIDATION: '1' })
    // A arms the transient daemon→direct transition with two REAL verified saves.
    await saveBackend(clientA, 'Daemon', 'PR3 A')
    await closeSettings(clientA, 'PR3 A')
    await saveBackend(clientA, 'Direct', 'PR3 A')
    await closeSettings(clientA, 'PR3 A')

    // B changes the Profile back to Daemon through its OWN real Settings UI.
    const { client: clientB } = await startC1Client('PR3 B')
    await saveBackend(clientB, 'Daemon', 'PR3 B')
    await closeSettings(clientB, 'PR3 B')
    trace('pr3.second-client-wrote', { value: 'daemon' })

    // A's committed mirror is still `direct` (stale-but-ready): the Settings
    // detail it paints comes from that snapshot.
    await openBackendDetail(clientA, 'PR3 A')
    const staleFrame = await frameOf(clientA)
    assert(/Value\s+Direct/u.test(staleFrame),
      `A's committed mirror must still read Direct before the exit; frame=${JSON.stringify(staleFrame)}`)
    await closeSettings(clientA, 'PR3 A')
    trace('pr3.stale-mirror', { readBackend: 'direct' })

    // A /exit: the REAL fresh read must observe B's `daemon` and refuse the Stop.
    clientA.send('/exit\r')
    const exit = await clientA.waitForExit(90_000)
    assert(exit.code === 0 && exit.signal === null,
      `a refused Stop is a plain detach and must exit 0, saw ${JSON.stringify(exit)}`)
    trace('pr3.stop-refused-exit', { exitCode: exit.code })
    assert(!clientA.records.some(record => record.m4a0 === 'failure'),
      'the refused Stop must not produce a terminal transport failure')

    // The refusal is a POSITIVE fact: the coordinator records that the fresh
    // authoritative read did not confirm the transition. Without this line a
    // silently refreshed mirror (confirm never opened) could look identical.
    const pid = clientA.records.find(record => record.m4a0 === 'ready')?.pid
    const clientLog = readFileSync(join(dshHome, 'logs', `pi-tui-${String(pid)}.log`), 'utf8')
    assert(clientLog.includes('host stop declined: the fresh authoritative Backend read did not confirm the transition'),
      `the production coordinator must record the fresh-read refusal; log tail=${JSON.stringify(clientLog.slice(-800))}`)
    assert(clientA.raw.includes('The daemon Host was not stopped by this action.'),
      `the hint must state the Host was not stopped; raw tail=${JSON.stringify(clientA.raw.slice(-500))}`)
    trace('pr3.fresh-read-refused', { adminStops: 0 })

    // ZERO admin stops: the old Host instance keeps its exact kernel identity.
    await assertHostIdentityKept(host, before, 'PR3 Host after the refused Stop')
    trace('pr3.host-kept', { identityUnchanged: true })
    await clientB.dispose().catch(() => {})
  } finally {
    await dispose()
  }
  return {
    status: 'PASS',
    scope: 'REAL_SPLIT_PROCESS_L6',
    path3: { staleMirror: true, freshReadRefused: true, adminStops: 0, hostKept: true },
  }
}
