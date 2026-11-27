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
 * - the reopened live Catalog reads the switched Session preset back;
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

const PRESETS = [
  { id: 'standard', label: 'Standard mode' },
  { id: 'ptc', label: 'PTC mode' },
  { id: 'minimal', label: 'Minimal mode' },
  { id: 'cordis', label: 'Creator mode' },
]

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

function presetRow(frame, preset) {
  const lines = frame.split('\n')
  const index = lines.findIndex(line => line.includes(`${preset.label} (${preset.id})`))
  if (index < 0) return undefined
  const line = lines[index]
  const next = lines[index + 1] ?? ''
  const wrappedBadge = /\[(?:default|current|next session)\]/u.test(next)
    && !PRESETS.some(candidate => next.includes(`${candidate.label} (${candidate.id})`))
  return { line, context: wrappedBadge ? `${line}\n${next}` : line }
}

function currentDefaultPreset(frame, label) {
  const lines = frame.split('\n')
  const badgeIndexes = lines.flatMap((line, index) => line.includes('[default]') ? [index] : [])
  assert(badgeIndexes.length === 1, `${label}: expected exactly one default badge`)
  const badgeIndex = badgeIndexes[0]
  for (const index of [badgeIndex, badgeIndex - 1]) {
    const line = lines[index]
    if (line === undefined) continue
    const preset = PRESETS.find(candidate => line.includes(`${candidate.label} (${candidate.id})`))
    if (preset !== undefined) return preset
  }
  throw new SplitSmokeAssertionError(`${label}: the default badge has no recognized built-in row`)
}

async function selectPreset(client, target, label) {
  for (const char of `(${target.id})`) {
    client.send(char)
    await sleep(50)
  }
  await waitForCondition(async () => {
    const row = presetRow(await frameText(client), target)
    return row?.line.includes('>') === true
  }, `${label} target selection`, 60_000)
  return presetRow(await frameText(client), target)
}

async function waitForPresetBadge(client, target, badge, label) {
  await waitForCondition(async () => presetRow(await frameText(client), target)?.context.includes(badge) === true,
    label, 60_000)
}

async function setDefault(client) {
  await openCatalog(client, 'UX-PR3 sync')
  await waitForScreenText(client, 'Use session', 'UX-PR3 sync live action label')
  const catalog = await frameText(client)
  const currentDefault = currentDefaultPreset(catalog, 'UX-PR3 sync')
  const target = PRESETS.find(candidate => candidate.id !== currentDefault.id)
  assert(target !== undefined, 'UX-PR3 sync no non-default built-in preset is available')
  const selectedRow = await selectPreset(client, target, 'UX-PR3 sync')
  assert(selectedRow !== undefined && !selectedRow.context.includes('[default]'),
    `UX-PR3 sync target ${target.id} is already the default: ${JSON.stringify({ currentDefault: currentDefault.id, selectedRow })}`)
  assert(!(await frameText(client)).includes('Already the default'),
    `UX-PR3 sync target ${target.id} still exposes the disabled default action`)
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
    return frame.includes(`current blank session switched to ${target.id}`)
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
    await waitForPresetBadge(a, target, '[current]', 'UX-PR3-SYNC current preset readback')
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
    await waitForPresetBadge(b, target, '[default]', 'UX-PR3-SYNC restarted Host default readback')
    await closeCatalog(b, 'UX-PR3-SYNC restarted Catalog')
    // The split lane shares this packed Profile with later scenarios. Restore
    // its standard baseline through the same real writer after the persistence
    // proof so a later Session is not created with the minimal preset (which
    // intentionally omits the ask-user tool required by the next case).
    await setDefault(b, 'standard', 'UX-PR3-SYNC restore lane baseline default')
    await openCatalog(b, 'UX-PR3-SYNC restored baseline readback')
    b.send('standard')
    await waitForScreenText(b, 'standard', 'UX-PR3-SYNC restored baseline filter')
    await waitForCondition(async () => (await frameText(b)).includes('[default]'),
      'UX-PR3-SYNC restored Host default readback', 60_000)
    await closeCatalog(b, 'UX-PR3-SYNC restored baseline Catalog')
    await exitC1Client(b, 'UX-PR3-SYNC client B')

    context.trace?.('ux-pr3-blank-session-default-sync', {
      candidate: context.candidateSha256,
      blankSessionCreated: true,
      configSaved: target.id,
      sessionSwitched: true,
      statusReadback: target.id,
      hostRestartPersisted: true,
      restoredLaneDefault: 'standard',
    })
    return { status: 'PASS' }
  } finally {
    await dispose()
  }
}
