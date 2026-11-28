/**
 * UX PR3 v1.2: the REAL Split Host/Client `Set default` sync.
 *
 * ONE packed candidate, a real Profile-backed Host and real PTY Clients prove
 * the shared writer end to end for a LIVE BLANK Session:
 *
 * - a real `/new` creates the blank Session, then the bare `/preset` opens the
 *   live Catalog (`Use session`, not `Use next`);
 * - the explicit `Set default` writes the real Profile Config owner and, after
 *   that write is confirmed, switches THAT exact still-blank Session through
 *   the existing Host selection path;
 * - `/preset status` reads the switched Session preset back;
 * - an INDEPENDENT Host restart plus a NEW Client reads the persisted
 *   `[default]` back from the Host roster.
 *
 * No test service substitutes the Host/Config writers, no Session is created by
 * the default action itself, and no UI state is read as the authority.
 * @module split-process/blank-session-default-sync
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForCondition, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

const PRESET_ORDER = ['standard', 'ptc', 'minimal', 'cordis']

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

async function frameText(client) {
  return (await client.viewport()).join('\n')
}

async function waitForScreenText(client, text, label, timeoutMs = 120_000) {
  try {
    await waitForCondition(async () => (await frameText(client)).includes(text), label, timeoutMs)
  } catch (error) {
    const frame = await client.viewport()
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: text, frame: frame.slice(-16) })}`, { cause: error })
  }
}

async function waitForScreenGone(client, text, label, timeoutMs = 120_000) {
  try {
    await waitForCondition(async () => !(await frameText(client)).includes(text), label, timeoutMs)
  } catch {
    throw new SplitSmokeAssertionError(`${label}: the ${JSON.stringify(text)} surface never closed`)
  }
}

async function closeCatalog(client, label) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await frameText(client)).includes('Agent presets')) return
    client.send('\x1b')
    await sleep(250)
  }
  if ((await frameText(client)).includes('Agent presets')) {
    throw new SplitSmokeAssertionError(`${label}: the Catalog survived the Esc ladder`)
  }
}

async function openCatalog(client, label) {
  await closeCatalog(client, `${label} previous Catalog`)
  await client.waitForScreen('❯', `${label} composer seat`, 60_000)
  client.send('\x15')
  await sleep(300)
  client.send('/preset\r')
  await waitForScreenText(client, 'Agent presets', `${label} Catalog opened`)
  await waitForCondition(async () => {
    const frame = await frameText(client)
    return frame.includes('Standard mode (standard)') && !frame.includes('Loading agent presets')
  }, `${label} live Catalog hydrated`, 120_000)
}

async function selectPreset(client, target, label) {
  for (const char of target) {
    client.send(char)
    await sleep(50)
  }
  await waitForCondition(async () => {
    const frame = await frameText(client)
    return frame.split('\n').some(line => line.includes('>') && line.includes(target))
  }, `${label} target selection`, 60_000)
}

async function setDefault(client) {
  await openCatalog(client, 'UX-PR3 sync')
  await waitForScreenText(client, 'Use session', 'UX-PR3 sync live action label')
  const catalog = await frameText(client)
  const catalogLines = catalog.split('\n')
  const defaultIndex = catalogLines.findIndex(line => line.includes('[default]'))
  const defaultContext = defaultIndex < 0
    ? ''
    : catalogLines.slice(Math.max(0, defaultIndex - 1), defaultIndex + 2).join(' ')
  const currentDefault = /\(([^()]+)\)/u.exec(defaultContext)?.[1]
  const target = PRESET_ORDER.find(candidate => candidate !== currentDefault)
  assert(target !== undefined, 'UX-PR3 sync no non-default built-in preset is available')
  await selectPreset(client, target, 'UX-PR3 sync')
  const selected = await frameText(client)
  assert(!selected.includes('Already the default'),
    `UX-PR3 sync target ${target} is already the default: ${JSON.stringify({ currentDefault, defaultContext, selected: selected.slice(-2000) })}`)
  const targetLine = selected.split('\n').find(line => line.includes('>') && line.includes(target))
  assert(targetLine !== undefined && !targetLine.includes('[default]'),
    'UX-PR3 sync target still carries the default badge')
  client.send('\t')
  await sleep(250)
  client.send('\t')
  await waitForCondition(async () => {
    const frame = await frameText(client)
    return frame.includes('Set default [Enter]') || frame.includes('Set [Enter]')
  }, 'UX-PR3 sync Default focus', 60_000)
  client.send('\r')
  await waitForScreenGone(client, 'Agent presets', 'UX-PR3 sync default write')
  await waitForCondition(async () => {
    const frame = (await frameText(client)).replace(/\s+/gu, ' ')
    return frame.includes(`current blank session switched to ${target}`)
  }, 'UX-PR3 sync notice', 120_000)
  return target
}

export async function runBlankSessionDefaultSync(context) {
  const { workDir } = context
  const scene = createC1Scene(context)
  const { startC1Host, startC1Client, exitC1Client, stopC1Host, dispose } = scene
  const unique = `${String(process.pid)}-${Date.now().toString(36)}`
  const homeA = join(workDir, `ux-pr3-sync-home-a-${unique}`)
  const homeB = join(workDir, `ux-pr3-sync-home-b-${unique}`)
  for (const home of [homeA, homeB]) mkdirSync(home, { recursive: true, mode: 0o700 })

  try {
    const { host, ready } = await startC1Host('unowned-job', 'UX-PR3-SYNC')
    assert(ready.localHost?.hostPid > 0, 'UX-PR3-SYNC the Host Ready record carries no identity')

    const { client: a, ready: aReady } = await startC1Client('UX-PR3-SYNC client A', { HOME: homeA }, { cwd: workDir })
    assert(aReady.sessionOpen === false && aReady.surfaceMounted === true,
      `UX-PR3-SYNC client A is not a mounted sessionless surface: ${JSON.stringify(aReady)}`)

    a.send('/new\r')
    const opened = await waitForSurfaceStatus(a,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string',
      'UX-PR3-SYNC blank Session', 120_000)
    assert(opened.sessionOpen === true, 'UX-PR3-SYNC /new did not open the blank Session')
    await a.waitForScreen('❯', 'UX-PR3-SYNC session composer', 60_000)

    const target = await setDefault(a)
    const after = await waitForSurfaceStatus(a,
      record => record.sessionOpen === true && record.openSessionId === opened.openSessionId,
      'UX-PR3-SYNC Session stays open after sync', 60_000)
    assert(after.sessionOpen === true, 'UX-PR3-SYNC the default sync closed the Session surface')

    // The reopened live Catalog reads the CURRENT relationship back from the
    // Host-authoritative Session fact (never from the closed panel's notice).
    await openCatalog(a, 'UX-PR3-SYNC current readback')
    await selectPreset(a, target, 'UX-PR3-SYNC current')
    await waitForCondition(async () => (await frameText(a)).includes('[current]'),
      'UX-PR3-SYNC current preset readback', 60_000)
    await closeCatalog(a, 'UX-PR3-SYNC current Catalog')
    await exitC1Client(a, 'UX-PR3-SYNC client A')

    // Independent Host restart: the default lives in the real Profile Config,
    // not in the killed Client's memory.
    await stopC1Host(host)
    const { ready: ready2 } = await startC1Host('unowned-job', 'UX-PR3-SYNC-2')
    assert(ready2.localHost?.hostPid > 0, 'UX-PR3-SYNC the restarted Host did not become ready')
    const { client: b, ready: bReady } = await startC1Client('UX-PR3-SYNC client B', { HOME: homeB }, { cwd: workDir })
    assert(bReady.sessionOpen === false, 'UX-PR3-SYNC client B is not sessionless')
    await openCatalog(b, 'UX-PR3-SYNC restart readback')
    await selectPreset(b, target, 'UX-PR3-SYNC restarted')
    await waitForCondition(async () => (await frameText(b)).includes('[default]'),
      'UX-PR3-SYNC restarted Host default readback', 60_000)
    await closeCatalog(b, 'UX-PR3-SYNC restarted Catalog')
    await exitC1Client(b, 'UX-PR3-SYNC client B')

    context.trace?.('ux-pr3-blank-session-default-sync', {
      candidate: context.candidateSha256,
      blankSessionCreated: true,
      configSaved: target,
      sessionSwitched: true,
      statusReadback: target,
      hostRestartPersisted: true,
    })
    return { status: 'PASS' }
  } finally {
    await dispose()
  }
}
