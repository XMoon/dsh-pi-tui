/**
 * FR5-B official Settings sections over real authenticated Split Clients.
 *
 * One Host with two authenticated Clients proves: the General migration of the
 * two startup preferences (same ids, real profile values), the Session log
 * upload switch and its official Reset readback, the Agent-loop numeric page,
 * the ACTIVE-shell two-cap page, and a two-Client stale-revision refusal that
 * never overwrites the winning profile bytes.
 *
 * @module split-process/host-numeric-settings-fr5b
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { submitLine } from './mcp-servers-fr3.mjs'

const WEB_PREFERENCE_NS = 'pi-tui-web-preferences'
const ACP_PREFERENCE_NS = 'pi-tui-acp-preferences'
const SESSION_LOG_NS = 'session-log-deepseek'
const AGENT_LOOP_NS = 'agent-loop'
const SHELL_NS = 'bash-sandbox'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function frameOf(client) {
  return (await client.viewport()).join('\n')
}

async function waitForText(client, text, label, timeoutMs = 90_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const frame = await frameOf(client)
    if (frame.includes(text)) return frame
    await sleep(100)
  }
  throw new SplitSmokeAssertionError(`${label}: wanted ${JSON.stringify(text)}; frame=${JSON.stringify(await client.viewport())}`)
}

async function waitForPattern(client, pattern, label, timeoutMs = 90_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const frame = await frameOf(client)
    if (pattern.test(frame)) return frame
    await sleep(100)
  }
  throw new SplitSmokeAssertionError(`${label}: wanted ${String(pattern)}; frame=${JSON.stringify(await client.viewport())}`)
}

async function selectFrame(client, predicate, label, limit = 24) {
  for (let step = 0; step < limit; step += 1) {
    const frame = await frameOf(client)
    if (predicate(frame)) return frame
    client.send('\x1b[B')
    await sleep(140)
  }
  throw new SplitSmokeAssertionError(`${label}: the target was never selected; frame=${JSON.stringify((await client.viewport()).slice(-20))}`)
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const selectedRow = (frame, label) => new RegExp(`^.*> ${escapeRegExp(label)}(?:\\s|$)`, 'mu').test(frame)

async function openCategory(client, category, label) {
  await submitLine(client, '/settings', `${label} /settings`)
  await waitForText(client, 'Settings · Categories', `${label} Settings root`)
  await selectFrame(client, frame => new RegExp(`^> ${category}(?:\\s|$)`, 'mu').test(frame), `${label} ${category} category`)
  client.send('\r')
  await sleep(200)
}

async function saveAndVerify(client, label, expected) {
  client.send('s')
  const frame = await waitForPattern(client, expected, label, 90_000)
  return frame
}

function profileUserConfig(profileDir, namespace) {
  const rows = parseYaml(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')) ?? []
  return rows.filter(row => row?.id === namespace && row.config !== undefined).at(-1)?.config
}

async function closeClient(client, scene, label) {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const frame = await frameOf(client)
    if (!/Settings ·/u.test(frame)) break
    if (/Discard unsaved changes\? y\/N/u.test(frame)) {
      client.send('y')
      await sleep(180)
    } else {
      client.send('\x1b')
      await sleep(180)
    }
  }
  await scene.exitC1Client(client, label)
}

export async function runHostNumericSettingsFr5B(context) {
  const { trace, installation, dshHome } = context
  const scene = createC1Scene(context)
  let host
  let clientA
  let clientB
  try {
    // Real pre-existing PROFILE USER values prove the migrated preference rows
    // read their ORIGINAL ids and values after moving to General (and remain
    // writable through the same official profile patch).
    const profilePatch = join(installation.profileDir, 'cordis.patch.yml')
    const existingRows = existsSync(profilePatch) ? (parseYaml(readFileSync(profilePatch, 'utf8')) ?? []) : []
    assert(Array.isArray(existingRows), 'the isolated profile patch must be a row list')
    writeFileSync(profilePatch, `${JSON.stringify([
      ...existingRows,
      { id: WEB_PREFERENCE_NS, config: { autoStart: true } },
      { id: ACP_PREFERENCE_NS, config: { autoStart: true } },
    ])}\n`, { mode: 0o600 })
    chmodSync(profilePatch, 0o600)

    const started = await scene.startC1Host('host-numeric-settings-fr5b', 'FR5-B Host')
    host = started.host
    const identity = await scene.hostIdentityFacts(host)
    const clientAStarted = await scene.startC1Client('FR5-B Client A')
    clientA = clientAStarted.client
    const clientBStarted = await scene.startC1Client('FR5-B Client B')
    clientB = clientBStarted.client
    assert(clientA.child.pid !== clientB.child.pid, 'the two Clients must use distinct wrappers')
    assert(clientAStarted.ready.pid !== clientBStarted.ready.pid, 'the two Clients must have distinct business PIDs')
    scene.assertInteractionGate(clientA, 'FR5-B Client A')
    scene.assertInteractionGate(clientB, 'FR5-B Client B')
    trace('fr5b.authenticated-clients', {
      wrapperPids: [clientA.child.pid, clientB.child.pid],
      clientPids: [clientAStarted.ready.pid, clientBStarted.ready.pid],
    })

    // ── General order + the migrated Web/ACP startup preferences ───────────
    await openCategory(clientA, 'General', 'FR5-B General')
    const general = await frameOf(clientA)
    for (const label of ['Backend', 'Start Web automatically', 'Start ACP automatically', 'Session log upload']) {
      assert(general.includes(label), `General must paint ${label}: ${JSON.stringify(general)}`)
    }
    assert(!general.includes('Auto-enable Web on Host startup'), 'the old Web label must not survive')
    assert(!general.includes('Auto-enable ACP on Host startup'), 'the old ACP label must not survive')
    await selectFrame(clientA, frame => selectedRow(frame, 'Start Web automatically'), 'FR5-B Web preference row')
    const webOn = await frameOf(clientA)
    assert(/Start Web automatically[^\n]*\bOn\b/u.test(webOn), `the home overlay USER value must read On: ${JSON.stringify(webOn)}`)
    clientA.send('\r')
    await waitForText(clientA, 'Choose value', 'FR5-B Web preference choice')
    await selectFrame(clientA, frame => /^.*> Off(?:\s|$)/mu.test(frame), 'FR5-B Web Off candidate')
    clientA.send('\r')
    await waitForPattern(clientA, /Verified/u, 'FR5-B Web preference verified')
    assert(profileUserConfig(installation.profileDir, WEB_PREFERENCE_NS)?.autoStart === false,
      'the migrated Web row writes the SAME official preference field')
    trace('fr5b.general-web-migration', { existingUserValueRead: true, savedProfile: true })

    // The ACP preference still writes its original id from the new location.
    clientA.send('\x1b') // settled Detail -> Rows
    await sleep(160)
    await selectFrame(clientA, frame => selectedRow(frame, 'Start ACP automatically'), 'FR5-B ACP preference row')
    clientA.send('\r')
    await waitForText(clientA, 'Choose value', 'FR5-B ACP preference choice')
    await selectFrame(clientA, frame => /^.*> Off(?:\s|\n|\r)/mu.test(frame), 'FR5-B ACP Off candidate')
    clientA.send('\r')
    await waitForPattern(clientA, /Verified/u, 'FR5-B ACP preference verified')
    assert(profileUserConfig(installation.profileDir, ACP_PREFERENCE_NS)?.autoStart === false,
      'the migrated ACP row writes its original official preference field')
    trace('fr5b.general-acp-migration', { savedProfile: true })

    // ── Session log upload: risk text, Off, and Reset readback ─────────────
    clientA.send('\x1b') // settled Detail -> Rows
    await sleep(160)
    await selectFrame(clientA, frame => selectedRow(frame, 'Session log upload'), 'FR5-B Session log row')
    const sessionDetail = await waitForText(clientA, 'session log data with requests',
      'FR5-B Session log risk text')
    assert(sessionDetail.includes('conversation content'),
      'the conversation-content risk must be painted in the Detail')
    clientA.send('\r')
    await waitForText(clientA, 'Choose value', 'FR5-B Session log choice')
    await selectFrame(clientA, frame => /^.*> Off(?:\s|$)/mu.test(frame), 'FR5-B Session log Off candidate')
    clientA.send('\r')
    await waitForPattern(clientA, /Verified/u, 'FR5-B Session log Off verified')
    assert(profileUserConfig(installation.profileDir, SESSION_LOG_NS)?.enabled === false,
      'Off is a real USER value (not treated as absence)')
    clientA.send('\x1b')
    await sleep(160)
    // Reset the same field: the official unset may read back On.
    await selectFrame(clientA, frame => selectedRow(frame, 'Session log upload'), 'FR5-B Session log reset row')
    clientA.send('\r')
    await waitForText(clientA, 'Choose value', 'FR5-B Session log reset choice')
    await selectFrame(clientA, frame => /^.*> Reset(?:\s|$)/mu.test(frame), 'FR5-B Session log Reset candidate')
    clientA.send('\r')
    const resetFrame = await waitForPattern(clientA, /Verified/u, 'FR5-B Session log Reset verified')
    assert(/\bOn\b/u.test(resetFrame), 'the Reset readback may be On and must be shown as the current value')
    trace('fr5b.session-log', { offPersisted: true, resetVerified: true, resetReadbackOn: true })

    // ── Agent loop numeric page ────────────────────────────────────────────
    clientA.send('\x1b') // settled Detail -> Rows
    await sleep(160)
    clientA.send('\x1b') // Rows -> category rail
    await sleep(160)
    await selectFrame(clientA, frame => /^> Agent(?:\s|$)/mu.test(frame), 'FR5-B Agent category')
    clientA.send('\r')
    await sleep(200)
    await selectFrame(clientA, frame => selectedRow(frame, 'Agent loop'), 'FR5-B Agent loop row')
    clientA.send('\r')
    await waitForPattern(clientA, /Settings · Agent · Agent loop/u, 'FR5-B Agent loop page')
    await selectFrame(clientA, frame => selectedRow(frame, 'Parallel tool calls'), 'FR5-B Agent loop field')
    clientA.send('\r')
    await waitForText(clientA, 'Edit Parallel tool calls', 'FR5-B Agent loop input')
    clientA.send('\x15')
    await sleep(80)
    for (const character of '2') {
      clientA.send(character)
      await sleep(40)
    }
    clientA.send('\r')
    await waitForPattern(clientA, /Status: Unsaved/u, 'FR5-B Agent loop staged')
    await saveAndVerify(clientA, 'FR5-B Agent loop verified', /Status: Verified/u)
    assert(profileUserConfig(installation.profileDir, AGENT_LOOP_NS)?.maxParallelToolCalls === 2,
      'the Agent-loop page writes the official profile field')
    trace('fr5b.agent-loop', { savedProfile: true })
    // Reset through the same page: official unset, Host readback.
    await selectFrame(clientA, frame => selectedRow(frame, 'Parallel tool calls'), 'FR5-B Agent loop reset field')
    clientA.send('x')
    await waitForPattern(clientA, /Reset staged/u, 'FR5-B Agent loop reset staged')
    await saveAndVerify(clientA, 'FR5-B Agent loop reset verified', /Status: Verified/u)
    trace('fr5b.agent-loop-reset', { officialUnset: true, readback: true })

    // ── Shell execution: two fields, one CAS, then a stale Client B ────────
    clientA.send('\x1b') // Agent-loop page -> Agent rows
    await sleep(160)
    clientA.send('\x1b') // Agent rows -> category rail
    await sleep(160)
    await selectFrame(clientA, frame => /^> Tools(?:\s|$)/mu.test(frame), 'FR5-B Tools category')
    clientA.send('\r')
    await sleep(200)
    await selectFrame(clientA, frame => selectedRow(frame, 'Shell execution'), 'FR5-B Shell row A')
    clientA.send('\r')
    await waitForPattern(clientA, /Settings · Tools · Shell execution/u, 'FR5-B Shell page A')
    await waitForPattern(clientA, /Host model-tool executor · POSIX Bash/u, 'FR5-B active executor A')
    const shellOpenedFrame = await frameOf(clientA)
    assert(/Command timeout \(ms\)\s+60000/u.test(shellOpenedFrame) && /Output cap per stream \(bytes\)\s+64000/u.test(shellOpenedFrame),
      `the Shell page must show the official inherited caps: ${JSON.stringify(shellOpenedFrame)}`)

    // Client B opens the SAME section BEFORE A saves, so both pages capture the
    // same revision; only the first Save may win.
    await openCategory(clientB, 'Tools', 'FR5-B Tools B')
    await selectFrame(clientB, frame => selectedRow(frame, 'Shell execution'), 'FR5-B Shell row B')
    clientB.send('\r')
    await waitForPattern(clientB, /Settings · Tools · Shell execution/u, 'FR5-B Shell page B')
    // B stages a divergent draft BEFORE A saves: the two pages hold the same
    // captured revision, so B's later Save must be refused, not rebased.
    await selectFrame(clientB, frame => selectedRow(frame, 'Command timeout (ms)'), 'FR5-B Shell timeout field B')
    clientB.send('\r')
    await waitForText(clientB, 'Edit Command timeout (ms)', 'FR5-B Shell timeout input B')
    clientB.send('\x15')
    await sleep(80)
    for (const character of '90000') {
      clientB.send(character)
      await sleep(40)
    }
    clientB.send('\r')
    await waitForPattern(clientB, /Status: Unsaved/u, 'FR5-B Shell staged B')

    await selectFrame(clientA, frame => selectedRow(frame, 'Command timeout (ms)'), 'FR5-B Shell timeout field A')
    clientA.send('\r')
    await waitForText(clientA, 'Edit Command timeout (ms)', 'FR5-B Shell timeout input A')
    clientA.send('\x15')
    await sleep(80)
    for (const character of '45000') {
      clientA.send(character)
      await sleep(40)
    }
    clientA.send('\r')
    await selectFrame(clientA, frame => selectedRow(frame, 'Output cap per stream (bytes)'), 'FR5-B Shell cap field A')
    clientA.send('\r')
    await waitForText(clientA, 'Edit Output cap per stream (bytes)', 'FR5-B Shell cap input A')
    clientA.send('\x15')
    await sleep(80)
    for (const character of '128000') {
      clientA.send(character)
      await sleep(40)
    }
    clientA.send('\r')
    const shellStagedFrame = await waitForPattern(clientA, /Status: Unsaved/u, 'FR5-B Shell staged A')
    assert(/Command timeout \(ms\)\s+45000/u.test(shellStagedFrame) && /Output cap per stream \(bytes\)\s+128000/u.test(shellStagedFrame),
      `the Shell page must paint both staged caps: ${JSON.stringify(shellStagedFrame)}`)
    await saveAndVerify(clientA, 'FR5-B Shell verified A', /Status: Verified/u)
    const shellPatch = profileUserConfig(installation.profileDir, SHELL_NS)
    assert(shellPatch?.timeoutMs === 45_000 && shellPatch?.maxOutputBytes === 128_000,
      `the shell page writes both caps in the official patch: ${JSON.stringify(shellPatch)}`)

    // A's committed write invalidated B's captured revision. Depending on
    // whether the shared document-updated event reaches B before the key, the
    // stale Save either meets the CAS ("Not saved") or is refused by the
    // Last-known read-only page (no Save painted). Both are refusals; neither
    // may write.
    clientB.send('s')
    await waitForPattern(clientB, /Not saved|refresh to review|Last-known · read-only/u,
      'FR5-B stale Client B refusal', 30_000)
    await sleep(400)
    const bAfterSaveAttempt = await frameOf(clientB)
    assert(!/Verified/u.test(bAfterSaveAttempt), 'the stale Client never claims a verified write')
    if (/Save \[S\]/u.test(bAfterSaveAttempt)) {
      // The notification had not landed yet: a second explicit attempt meets
      // the captured revision fence and reports Not saved.
      clientB.send('s')
      const bRetry = await waitForPattern(clientB, /Not saved|refresh to review/u,
        'FR5-B stale Client B CAS refusal', 20_000)
      assert(/Not saved|refresh to review/u.test(bRetry), 'the stale intent is named as not saved')
    }
    assert(profileUserConfig(installation.profileDir, SHELL_NS)?.timeoutMs === 45_000,
      'Client B cannot replace the committed shell timeout')
    trace('fr5b.shell-two-client', { bothCapsOneSave: true, staleRefused: true, profileKept: true })

    await scene.assertHostIdentityKept(host, identity, 'FR5-B settings writes')
    await closeClient(clientA, scene, 'FR5-B Client A')
    clientA = undefined
    await closeClient(clientB, scene, 'FR5-B Client B')
    clientB = undefined
    await scene.stopC1Host(host)
    host = undefined
    await scene.awaitSceneSeatFree()
    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L5',
      authenticatedClients: 2,
      generalMigration: true,
      sessionLogResetReadback: true,
      agentLoopProfile: true,
      shellTwoCapsOneCas: true,
      staleRevisionRefused: true,
      originalSplitHostIntact: true,
    }
  } finally {
    if (clientB !== undefined) await clientB.dispose().catch(() => {})
    if (clientA !== undefined) await clientA.dispose().catch(() => {})
    if (host !== undefined) await scene.stopC1Host(host)
    await scene.dispose()
  }
}
