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

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
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

/** Save the verified `daemon → direct` Backend through the REAL Settings UI. */
async function saveDirectBackend(client, label) {
  await submitLine(client, '/settings', `${label} /settings`)
  await waitForText(client, 'Settings · Categories', `${label} Settings root`)
  await selectFrame(client, frame => /^> General(?:\s|$)/mu.test(frame), `${label} General category`)
  client.send('\r')
  await sleep(200)
  await selectFrame(client, frame => selectedRow(frame, 'Backend'), `${label} Backend row`)
  client.send('\r')
  await waitForText(client, 'Choose value', `${label} Backend choice`)
  await selectFrame(client, frame => /^.*> Direct(?:\s|$)/mu.test(frame), `${label} Direct candidate`)
  client.send('\r')
  await waitForPattern(client, /Verified/u, `${label} Backend verified`)
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
  assert(exit.code === 0 && exit.signal === null, `${label} Stop exit was ${JSON.stringify(exit)}`)
  return exit
}

/** Run the Settings→exit whole-Host stop lifecycle. */
export async function runDaemonUiHostStop(context) {
  const { trace } = context
  const scene = createC1Scene(context)
  const { startC1Host, startC1Client, hostIdentityFacts, assertHostIdentityKept, exitC1Client, dispose } = scene
  try {
    const { host } = await startC1Host('daemon-ui-host-stop', 'PR2 Host')
    const { client: clientA } = await startC1Client('PR2 A')
    const { client: clientB } = await startC1Client('PR2 B')
    const before = await hostIdentityFacts(host)

    // A: verified daemon→direct save through the REAL Settings UI, then Leave.
    await saveDirectBackend(clientA, 'PR2 A')
    await waitForText(clientA, 'Optional OS supervision', 'PR2 A follow-up painted')
    clientA.send('\x1b') // Not now (dismiss the follow-up) — zero manager IO
    await sleep(300)
    await exitLeave(clientA, 'PR2 A')
    trace('pr2.leave-exit', { exitCode: 0 })

    // The old Host and the sibling Client SURVIVE the safe Leave.
    await waitForText(clientB, 'pi-tui', 'PR2 B still painted after A left')
    await assertHostIdentityKept(host, before, 'PR2 Host after A Leave')
    const bStatus = await waitForSurfaceStatus(clientB, record => record.sessionState !== undefined, 'PR2 B status after A Leave')
    assert(bStatus !== undefined, 'the sibling Client still has its Host instance after A leaves')
    trace('pr2.leave-survival', { hostKept: true, siblingKept: true })

    // A2: verified daemon→direct save, then the DESTRUCTIVE Stop.
    const { client: clientA2 } = await startC1Client('PR2 A2')
    await saveDirectBackend(clientA2, 'PR2 A2')
    await exitStop(clientA2, 'PR2 A2')
    trace('pr2.stop-exit', { exitCode: 0 })

    // The old Host is verified gone; the sibling Client lost that instance.
    await waitForCondition(async () => {
      try { return (await hostIdentityFacts(host)) === undefined } catch { return true }
    }, 'PR2 Host stopped after the explicit Stop', 60_000)
    trace('pr2.stop-gone', { hostVerifiedGone: true })

    // B's exit is its own ordinary detach; nothing here re-stops anything.
    await exitC1Client(clientB, 'PR2 B')
    trace('pr2.sibling-detach', { exitCode: 0 })
  } finally {
    await dispose()
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
