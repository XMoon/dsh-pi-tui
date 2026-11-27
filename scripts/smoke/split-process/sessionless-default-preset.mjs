/**
 * UX PR3: the REAL Host / REAL Split Client sessionless `/preset` surface.
 *
 * ONE packed candidate, a real Profile-backed Host and real PTY Clients prove
 * the PiTui Catalog over the authenticated Split transport end to end:
 *
 * - the bare `/preset` opens the Catalog (Agent presets, Built-in groups and the
 *   Host-authoritative `[default]` chip) and creates no Session;
 * - the explicit `Use next` stages the run-local pending preset — the reopened
 *   Catalog reads `[next session]` back from the same Client state, and the
 *   surface status still reports NO open Session;
 * - the explicit `Set default` writes the real Profile Config owner, and a NEW
 *   Client (after an independent Host restart) reads the new `[default]` back
 *   from the Host roster — no Client-local value and no Session creation.
 *
 * It also injects a REAL roster-read transport fault
 * (`SPLIT_PROCESS_CLIENT_FAIL_PRESET_ROSTER`, a pre-dispatch failure on the real
 * `agentPresets/list` wire call), proves the in-panel Error with the real reason,
 * then removes the marker and proves Retry re-enters the SAME read owner and
 * recovers to the Catalog. No fake RPC and no Host service substitution.
 *
 * @module split-process/sessionless-default-preset
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForCondition, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** The filtered preset the explicit `Use next` stages. */
const USE_PRESET = 'ptc'
/** The filtered preset the explicit `Set default` persists for new Sessions. */
const DEFAULT_PRESET = 'minimal'

/** Open the bare `/preset` and wait for the REAL roster-read failure frame. */
async function openPresetPanelExpectingError(client, label) {
  await closeCatalog(client, `${label} previous Catalog`)
  await client.waitForScreen('❯', `${label} composer seat`, 60_000)
  client.send('\x15')
  await sleep(300)
  client.send('/preset\r')
  await waitForScreenText(client, 'Preset catalog unavailable', `${label} Catalog error`, 120_000)
  await waitForScreenText(client, 'Retry', `${label} Retry action`, 60_000)
  await waitForScreenText(client, 'Close [Esc]', `${label} Close action`, 60_000)
  const flat = (await frameText(client)).replace(/\s+/gu, ' ')
  if (!/agentPresets\/list|roster read/iu.test(flat)) {
    throw new SplitSmokeAssertionError(`${label}: the real read failure reason is missing: ${JSON.stringify(flat.slice(-400))}`)
  }
}

async function frameText(client) {
  return (await client.viewport()).join('\n')
}

async function waitForScreenText(client, text, label, timeoutMs = 120_000) {
  try {
    await waitForCondition(async () => (await frameText(client)).includes(text), label, timeoutMs)
  } catch (error) {
    const frame = await client.viewport()
    const lines = frame.filter(line => /preset|Built-in|Custom|Use|Close|Loading/iu.test(line))
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: text, diagnosticLines: lines.slice(-16) })}`, { cause: error })
  }
}

async function waitForScreenGone(client, text, label, timeoutMs = 120_000) {
  try {
    await waitForCondition(async () => !(await frameText(client)).includes(text), label, timeoutMs)
  } catch {
    throw new SplitSmokeAssertionError(`${label}: the ${JSON.stringify(text)} surface never closed`)
  }
}

/** A failed explicit write surfaces an owner notice; never mistake it for a
 *  persisted outcome. */
async function assertNoWriteFailure(client, label) {
  await sleep(600)
  const flat = (await frameText(client)).replace(/\s+/gu, ' ')
  assert(!/preset selection failed:|default preset save:|do not retry/iu.test(flat),
    `${label}: an explicit write failed: ${JSON.stringify(flat.slice(-400))}`)
}

/** Close the Catalog through its real Esc ladder: a non-empty search query is
 *  cleared FIRST, so the case presses Esc until the surface is gone (never a
 *  blind fixed count that could leak a second Esc to the editor). */
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

/** Open the bare `/preset` from a proven-empty sessionless editor seat and
 *  wait for the Host roster to hydrate the Catalog. */
async function openPresetPanel(client, label) {
  // A previous Catalog may still be open from an earlier assertion: `/preset`
  // typed into it would become SEARCH TEXT, not a command. Close it first and
  // prove the surface is gone before opening the next one.
  await closeCatalog(client, `${label} previous Catalog`)
  // Wait for the composer seat to be the live input owner before typing: after
  // a closed panel a Client may take a moment to return focus to the editor.
  await client.waitForScreen('❯', `${label} composer seat`, 60_000)
  client.send('\x15') // clear any pending editor content
  await sleep(300)
  client.send('/preset\r')
  await waitForScreenText(client, 'Agent presets', `${label} Catalog opened`)
  try {
    await waitForCondition(async () => {
      const frame = await frameText(client)
      return frame.includes('Standard mode (standard)') && !frame.includes('Loading agent presets')
    }, `${label} Catalog hydrated`, 120_000)
  } catch (error) {
    const frame = await client.viewport()
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ hydrated: false, frame: frame.slice(-16) })}`, { cause: error })
  }
}

/** Filter the Catalog by a complete id and prove that row is on screen. */
async function filterPreset(client, preset, label) {
  client.send(preset)
  await waitForScreenText(client, preset, `${label} filtered ${preset}`)
}

/** The explicit `Use next`: one Tab reaches the Use action, Enter runs it
 *  (no row Enter ever writes). */
async function useNext(client, preset, label) {
  await openPresetPanel(client, label)
  await filterPreset(client, preset, label)
  client.send('\t')
  await waitForCondition(async () => {
    const frame = await frameText(client)
    return frame.includes('Use next [Enter]') || frame.includes('Use [Enter]')
  }, `${label} Use focus`, 60_000)
  client.send('\r')
  await waitForScreenGone(client, 'Agent presets', `${label} Catalog closed on Use next`)
  await assertNoWriteFailure(client, label)
}

/** The explicit `Set default`: the flat ring reaches Use on the first Tab and
 *  Set default on the second; Enter commits the focused secondary writer. */
async function setDefault(client, preset, label) {
  await openPresetPanel(client, label)
  await filterPreset(client, preset, label)
  client.send('\t')
  await sleep(200)
  client.send('\t')
  await waitForCondition(async () => {
    const frame = await frameText(client)
    return frame.includes('Set default [Enter]') || frame.includes('Set [Enter]')
  }, `${label} Default focus`, 60_000)
  client.send('\r')
  await waitForScreenGone(client, 'Agent presets', `${label} Catalog closed on Set default`)
  await assertNoWriteFailure(client, label)
}

/** Reopen the Catalog, filter one preset and prove its state chip is painted
 *  from the Host-authoritative read (the badge may wrap to its own row, so the
 *  whole frame is matched). */
async function assertPresetChip(client, preset, chip, label) {
  await openPresetPanel(client, label)
  await filterPreset(client, preset, label)
  try {
    await waitForCondition(async () => (await frameText(client)).includes(chip), `${label} ${chip} chip`, 60_000)
  } catch (error) {
    const frame = await client.viewport()
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: chip, frame: frame.slice(-16) })}`, { cause: error })
  }
  await closeCatalog(client, `${label} Catalog closed after read`)
}

export async function runSessionlessDefaultPreset(context) {
  const { workDir } = context
  const scene = createC1Scene(context)
  const { startC1Host, startC1Client, exitC1Client, stopC1Host, dispose } = scene
  const unique = `${String(process.pid)}-${Date.now().toString(36)}`
  const homeA = join(workDir, `ux-pr3-home-a-${unique}`)
  const homeB = join(workDir, `ux-pr3-home-b-${unique}`)
  const homeC = join(workDir, `ux-pr3-home-c-${unique}`)
  const faultDir = join(workDir, `ux-pr3-preset-fault-${unique}`)
  for (const home of [homeA, homeB, homeC]) mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(faultDir, { recursive: true, mode: 0o700 })

  try {
    const { host, ready } = await startC1Host('unowned-job', 'UX-PR3')
    assert(ready.localHost?.hostPid > 0, `UX-PR3 the Host Ready record carries no identity: ${JSON.stringify(ready.localHost)}`)

    const { client: a, ready: aReady } = await startC1Client('UX-PR3 client A', { HOME: homeA }, { cwd: workDir })
    assert(aReady.sessionOpen === false && aReady.surfaceMounted === true,
      `UX-PR3 client A is not a mounted sessionless surface: ${JSON.stringify(aReady)}`)

    // ── P-01: the real Catalog reads the Host roster; no Session is created ──
    await openPresetPanel(a, 'UX-PR3 catalog')
    const catalog = await frameText(a)
    assert(catalog.includes('Built-in ·'), `UX-PR3 the Catalog paints no Built-in group: ${JSON.stringify(catalog.slice(-600))}`)
    assert(catalog.includes('Use next'), `UX-PR3 the sessionless action bar is missing: ${JSON.stringify(catalog.slice(-400))}`)
    assert(catalog.includes('Close [Esc]'), 'UX-PR3 the Catalog paints no explicit Close')
    const catalogStatus = await waitForSurfaceStatus(a,
      record => record.sessionOpen === false, 'UX-PR3 catalog stays sessionless', 60_000)
    assert(catalogStatus.sessionOpen === false, 'UX-PR3 opening the Catalog created a Session')

    // ── P-02: the explicit Use next stages the run-local pending preset ─────
    await useNext(a, USE_PRESET, 'UX-PR3 Use next')
    const afterUse = await waitForSurfaceStatus(a,
      record => record.sessionOpen === false, 'UX-PR3 Use next stays sessionless', 60_000)
    assert(afterUse.sessionOpen === false, 'UX-PR3 Use next created a Session')
    await assertPresetChip(a, USE_PRESET, '[next session]', 'UX-PR3 pending readback')

    // ── P-03: the explicit Set default writes the real Profile Config ───────
    await setDefault(a, DEFAULT_PRESET, 'UX-PR3 Set default')
    const afterDefault = await waitForSurfaceStatus(a,
      record => record.sessionOpen === false, 'UX-PR3 Set default stays sessionless', 60_000)
    assert(afterDefault.sessionOpen === false, 'UX-PR3 Set default created a Session')
    await assertPresetChip(a, DEFAULT_PRESET, '[default]', 'UX-PR3 Host default readback')

    // ── P-05: a REAL roster-read wire fault → Error + Retry recovery ────────
    const { client: c, ready: cReady } = await startC1Client('UX-PR3 client C (roster fault)', {
      HOME: homeC,
      SPLIT_PROCESS_CLIENT_FAIL_PRESET_ROSTER: faultDir,
    }, { cwd: workDir })
    assert(cReady.sessionOpen === false, 'UX-PR3 client C is not sessionless')
    writeFileSync(join(faultDir, 'fail'), '1', { mode: 0o600 })
    await openPresetPanelExpectingError(c, 'UX-PR3 roster read failure')
    const afterFailure = await waitForSurfaceStatus(c,
      record => record.sessionOpen === false, 'UX-PR3 read failure stays sessionless', 60_000)
    assert(afterFailure.sessionOpen === false, 'UX-PR3 the failed read created a Session')
    // Remove the fault and Retry through the visible footer: the SAME read
    // owner re-reads the Host roster and hydrates the panel in place.
    rmSync(join(faultDir, 'fail'), { force: true })
    c.send('\t')
    await sleep(200)
    c.send('\r')
    await waitForCondition(async () => {
      const frame = await frameText(c)
      return frame.includes('Standard mode (standard)') && !frame.includes('Loading agent presets')
    }, 'UX-PR3 Retry hydrated the Catalog', 120_000).catch(async (error) => {
      const frame = await c.viewport()
      throw new SplitSmokeAssertionError(`UX-PR3 Retry recovery: ${JSON.stringify({ frame: frame.slice(-16) })}`, { cause: error })
    })
    assert(!(await frameText(c)).includes('Preset catalog unavailable'), 'UX-PR3 the error must be replaced by the Catalog')
    const afterRetry = await waitForSurfaceStatus(c,
      record => record.sessionOpen === false, 'UX-PR3 Retry stays sessionless', 60_000)
    assert(afterRetry.sessionOpen === false, 'UX-PR3 the retried read created a Session')
    await closeCatalog(c, 'UX-PR3 roster-retry Catalog')
    await exitC1Client(c, 'UX-PR3 client C')

    await exitC1Client(a, 'UX-PR3 client A')

    // ── P-04: the persisted default survives an INDEPENDENT Host restart ────
    await stopC1Host(host)
    const { ready: ready2 } = await startC1Host('unowned-job', 'UX-PR3-2')
    assert(ready2.localHost?.hostPid > 0, 'UX-PR3 the restarted Host did not become ready')
    const { client: b, ready: bReady } = await startC1Client('UX-PR3 client B', { HOME: homeB }, { cwd: workDir })
    assert(bReady.sessionOpen === false, 'UX-PR3 client B is not sessionless')
    await assertPresetChip(b, DEFAULT_PRESET, '[default]', 'UX-PR3 restarted Host default readback')
    // This case shares the packed Profile with later split scenarios. Restore
    // the lane's standard baseline through the same real writer after the
    // persistence proof, so the following blank-session case does not inherit
    // `minimal` as its current preset and lose its Set-default action.
    await setDefault(b, 'standard', 'UX-PR3 restore lane baseline default')
    await assertPresetChip(b, 'standard', '[default]', 'UX-PR3 restored baseline readback')
    await exitC1Client(b, 'UX-PR3 client B')

    context.trace?.('ux-pr3-sessionless-default-preset', {
      candidate: context.candidateSha256,
      catalogRead: true,
      useNext: USE_PRESET,
      setDefault: DEFAULT_PRESET,
      sessionCreated: false,
      hostRestartPersisted: true,
      readFailureInjected: 'SPLIT_PROCESS_CLIENT_FAIL_PRESET_ROSTER',
      readFailureRecoveredByRetry: true,
    })
    return { status: 'PASS' }
  } finally {
    await dispose()
  }
}
