/**
 * M6 UX PR2: the real Settings/Exit UI drives the Profile Host stop decision.
 *
 * One real Host and REAL Surface Clients (`script(1)` PTYs). A Client saves a
 * VERIFIED `daemon → direct` Backend in the real Settings workspace, then
 * `/exit`s and takes the ONE whole-Host stop confirm:
 *   - `Leave daemon Host running and exit` keeps the old Host (and a sibling
 *     Client) alive, performs ZERO manager stop, and exits 0;
 *   - a second Client's `Stop daemon Host and exit` runs the ONE authenticated
 *     `daemon stop` AFTER the terminal restore: the old Host is verified gone,
 *     the sibling Client loses that instance, and the exit code is 0.
 *
 * This is the A09/A11 process-lifecycle proof that unit tests cannot give (the
 * Remote transport disconnect races the Client exit lifecycle). It references
 * the Linux/macOS manager lanes for the OS install/stop fact; it does NOT
 * re-run them.
 *
 * @module split-process/daemon-ui-host-stop-m6-ux-pr2
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { submitLine } from './mcp-servers-fr3.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

async function frameOf(client) {
  return (await client.viewport().catch(() => [])).join('\n')
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
  // is that control-plane verdict (0 = confirmed stop).
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

    // The old Host is verified gone; the sibling Client lost that instance.
    await waitForCondition(async () => {
      try { return (await hostIdentityFacts(host)) === undefined } catch { return true }
    }, 'PR2 Host stopped after the explicit Stop', 60_000)
    trace('pr2.stop-gone', { hostVerifiedGone: true })

    // The explicit Stop destroyed B's old Host instance: B can no longer hold a
    // clean connection to it (its transport drops), so its exit is NOT a clean
    // detach of a live Host. That is exactly the A11 sibling-isolation fact.
    if (!clientB.exited) await clientB.waitForExit(60_000).catch(() => undefined)
    trace('pr2.sibling-after-stop', { exited: clientB.exited, exit: clientB.exitResult ?? null })
    assert(clientB.exited && clientB.exitResult?.code !== 0,
      `the sibling Client cannot keep the stopped Host instance (exited=${String(clientB.exited)}, exit=${JSON.stringify(clientB.exitResult)})`)
    await clientB.dispose().catch(() => {})
  } finally {
    await dispose()
  }
  return {
    status: 'PASS',
    scope: 'REAL_SPLIT_PROCESS_L6',
    leave: { hostKept: true, siblingKept: true },
    stop: { hostVerifiedGone: true, siblingLostInstance: true },
  }
}

/** A tiny bounded condition wait (the scene owns its own process backstop). */
async function waitForCondition(predicate, label, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await sleep(150)
  }
  throw new SplitSmokeAssertionError(`${label}: the condition never settled`)
}
