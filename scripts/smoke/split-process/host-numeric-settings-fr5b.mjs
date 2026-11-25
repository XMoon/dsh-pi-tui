/**
 * FR5-B official Settings sections over real authenticated Split Clients.
 *
 * One Host with two authenticated Clients proves: the Host category and the
 * preference/runtime authority its Web UI page owns (a real Disable -> Enable
 * round trip with authoritative readback, plus the real profile preference),
 * the next-start preference its ACP access page owns (same ids, real profile
 * values), the Session log upload switch and its official Reset readback, the
 * Agent-loop numeric page, the ACTIVE-shell two-cap page, and a two-Client
 * stale-revision refusal that never overwrites the winning profile bytes.
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

/** The DETAIL-column prose of one frame: a sentence that wraps inside the real
 *  tenant width must still read as the same complete fact, without the sibling
 *  Rows column interleaving its physical lines. */
function detailColumnText(frame) {
  const lines = frame.split('\n')
  const header = lines.find(line => line.includes('Details'))
  if (header === undefined) return frame.replace(/\s+/gu, ' ').trim()
  const at = header.indexOf('Details')
  const start = header[at - 1] === '[' ? at - 1 : at
  return lines.map(line => line.slice(start)).join(' ').replace(/\s+/gu, ' ').trim()
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

async function waitForNoPattern(client, pattern, label, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const frame = await frameOf(client)
    if (!pattern.test(frame)) return frame
    await sleep(120)
  }
  throw new SplitSmokeAssertionError(`${label}: still matched ${String(pattern)}; frame=${JSON.stringify(await client.viewport())}`)
}

async function waitForDetailPattern(client, pattern, label, timeoutMs = 90_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const frame = await frameOf(client)
    if (pattern.test(detailColumnText(frame))) return frame
    await sleep(100)
  }
  throw new SplitSmokeAssertionError(`${label}: wanted ${String(pattern)} in the Detail column; frame=${JSON.stringify(await client.viewport())}`)
}

async function waitForProfileAutoStart(installation, expected, label, timeoutMs = 30_000, namespace = WEB_PREFERENCE_NS) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = profileUserConfig(installation.profileDir, namespace)
    if (last?.autoStart === expected) return last
    await sleep(100)
  }
  throw new SplitSmokeAssertionError(`${label}: ${namespace}.autoStart never became ${expected}; last=${JSON.stringify(last)}`)
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

/** The official Shell USER row must be EXACTLY this pair (both caps) after a
 *  stage: validating only one field cannot prove the other stayed untouched. */
function assertShellCaps(profileDir, expected, label) {
  const rows = parseYaml(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')) ?? []
  const config = profileUserConfig(profileDir, SHELL_NS) ?? {}
  const actual = { timeoutMs: config.timeoutMs, maxOutputBytes: config.maxOutputBytes }
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: the official shell caps must stay exactly ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} (rows=${JSON.stringify(rows)})`)
}

/** Leave a DIRTY Shell group through its real painted receipt, then prove the
 *  group retired to Rows. A timeout throws with the last frame instead of
 *  letting the generic close path hide a stuck question. */
async function leaveDirtyShellGroup(client, label) {
  client.send('\x1b')
  // A stale/refused capture must use its truthful read-only wording, never the
  // unavailable "Save keeps you here".
  const question = await waitForPattern(client,
    /Save keeps you here\.|Save is unavailable until you refresh and review\.|Host may have applied this change\./u,
    `${label} leave question`)
  assert(/Discard (?:and leave )?\[D\]|Leave anyway/u.test(question),
    `${label} must paint the complete leave receipt: ${JSON.stringify(question)}`)
  assert(!/Save keeps you here\./u.test(question) || /Save \[S\]/u.test(question),
    `${label} never advertises an unavailable Save: ${JSON.stringify(question)}`)
  client.send('d')
  await waitForPattern(client, /Settings · Tools · Rows/u, `${label} group retired to Rows`)
  client.send('\x1b')
  await waitForText(client, 'Settings · Categories', `${label} Settings root`)
  client.send('\x1b')
  await waitForNoPattern(client, /Settings · /u, `${label} Settings closed`)
}

async function closeClient(client, scene, label) {
  // The numeric tenants' leave questions are the ONLY discardable states: the
  // dirty-leave question paints `Save keeps you here.` and the local discard
  // paints `Discard unsaved changes?`, each with a complete Discard segment.
  // Answer them through their painted action (`d`), then walk the ordinary
  // Rows -> Categories -> close ladder with the real Esc.
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const frame = await frameOf(client)
    if (!/Settings ·/u.test(frame)) break
    if (/Save keeps you here\.|Host may have applied this change\.|Discard unsaved changes\?/u.test(frame)) {
      if (/Discard \[D\]/u.test(frame) || /Discard and leave \[D\]/u.test(frame) || /Leave anyway \[D\]/u.test(frame)) {
        client.send('d')
        await sleep(220)
        continue
      }
      client.send('\x1b')
      await sleep(180)
      continue
    }
    client.send('\x1b')
    await sleep(160)
  }
  await scene.exitC1Client(client, label)
}

export async function runHostNumericSettingsFr5B(context) {
  const { trace, installation, dshHome } = context
  const scene = createC1Scene(context)
  let host
  let clientA
  let clientB
  // Captured BEFORE the try so the finally block can restore them: the full
  // lane shares ONE installed profile, and this case's seeded USER rows plus its
  // real UI saves must not leak into later cases (`web.startup-preference`
  // asserts a pristine `userOverridden === false` first read).
  const profilePatch = join(installation.profileDir, 'cordis.patch.yml')
  const originalPatch = existsSync(profilePatch) ? readFileSync(profilePatch, 'utf8') : ''
  try {
    // Real pre-existing PROFILE USER values prove the migrated preference rows
    // read their ORIGINAL ids and values on the Host pages that own them (and
    // remain writable through the same official profile patch).
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

    // ── Host order + the next-start preferences its pages own ──────────────
    await openCategory(clientA, 'Host', 'FR5-B Host')
    const hostRows = await frameOf(clientA)
    const listedAt = (lines, label) => lines.findIndex(line => new RegExp(`^ {0,2}(?:> )?${escapeRegExp(label)}(?:\\s|$)`, 'u').test(line))
    const hostLines = hostRows.split('\n')
    const order = ['Backend', 'Web UI', 'ACP access', 'Session log upload'].map(label => listedAt(hostLines, label))
    assert(order.every(index => index >= 0), `Host must paint every row in ${JSON.stringify(order)}: ${JSON.stringify(hostRows)}`)
    assert(order.every((index, position) => position === 0 || index > order[position - 1]),
      `the Host rows keep their frozen order: ${JSON.stringify(hostRows)}`)
    for (const retired of ['Start Web automatically', 'Start ACP automatically',
      'Auto-enable Web on Host startup', 'Auto-enable ACP on Host startup']) {
      assert(!hostRows.includes(retired), `the retired Host row ${JSON.stringify(retired)} must not survive`)
    }

    // The seeded Web USER value is read on the page that OWNS it and written
    // through the same official preference id (the General row is retired).
    await selectFrame(clientA, frame => selectedRow(frame, 'Web UI'), 'FR5-B Web UI row')
    clientA.send('\r')
    await waitForPattern(clientA, /Settings · Host · Web UI/u, 'FR5-B Web UI page')

    // The same page owns the CURRENT Host runtime. The seeded autoStart turned
    // the frontend on at boot, so the mounted page must paint the real live
    // fact and complete a real Disable -> Enable round trip with readback.
    const runtimeReady = await waitForPattern(clientA, /Serving\s+(?:Enabled|Disabled|Unavailable)/u,
      'FR5-B Web runtime fact')
    assert(/Serving\s+Enabled/u.test(runtimeReady),
      `the seeded autoStart Host must serve Web at boot: ${JSON.stringify(runtimeReady)}`)
    await selectFrame(clientA, frame => selectedRow(frame, 'Disable Web…'), 'FR5-B Web disable row')
    clientA.send('\r')
    const disableRisk = await waitForText(clientA, 'Stop serving the Web UI?', 'FR5-B Web disable confirmation')
    assert(/Stop serving the Web UI\? Existing browser credentials and sessions are not revoked\./u
      .test(detailColumnText(disableRisk)),
    `the exact disable risk must be painted whole: ${JSON.stringify(disableRisk)}`)
    clientA.send('\r') // Disable Web: the confirmation's own first focus
    await waitForPattern(clientA, /Serving\s+Disabled/u, 'FR5-B Web runtime disabled')
    await waitForPattern(clientA, /Status\s+Verified/u, 'FR5-B Web runtime disable verified')
    // The runtime mutation must not have rewritten the next-start preference.
    assert(profileUserConfig(installation.profileDir, WEB_PREFERENCE_NS)?.autoStart === true,
      'Disable Web must leave the next-start USER preference On')
    clientA.send('\r') // the disabled page's first focus is Enable Web
    await waitForPattern(clientA, /Serving\s+Enabled/u, 'FR5-B Web runtime re-enabled')
    await waitForPattern(clientA, /Status\s+Verified/u, 'FR5-B Web runtime enable verified')
    assert(profileUserConfig(installation.profileDir, WEB_PREFERENCE_NS)?.autoStart === true,
      'Enable Web must leave the next-start USER preference On')
    trace('fr5b.host-web-runtime', { disabled: true, reEnabled: true, authoritativeReadback: true, preferenceUnchanged: true })

    // The seeded Web USER value is read on the page that OWNS it and written
    // through the same official preference id (the General row is retired).
    await selectFrame(clientA, frame => selectedRow(frame, 'Start automatically'), 'FR5-B Web start row')
    const webOn = await frameOf(clientA)
    assert(/Start automatically[^\n]*\bOn\b/u.test(webOn), `the Web page must read the seeded USER value On: ${JSON.stringify(webOn)}`)
    clientA.send('\r')
    await waitForText(clientA, 'Choose the value the next Host start applies:', 'FR5-B Web start choice')
    await selectFrame(clientA, frame => selectedRow(frame, 'Off'), 'FR5-B Web Off candidate')
    clientA.send('\r')
    await waitForText(clientA, 'Save the next Host start preference as Off?', 'FR5-B Web confirm step')
    clientA.send('\r')
    // Wait for the NEXT-START field and its OWN settled Status, not the earlier
    // runtime Status word; then prove the official profile sink.
    await waitForDetailPattern(clientA,
      /Next Host Start\s+Start automatically Off(?:\s|·).*?Status Verified/u,
      'FR5-B Web preference settled in the next-start section')
    const savedPreference = await waitForProfileAutoStart(installation, false, 'FR5-B Web preference profile')
    assert(savedPreference.autoStart === false, 'the Web page writes the SAME official preference field')
    // Retire the tenant and re-enter through the real Host row. The fresh mount
    // performs its own status read; its frame must still report the running Host
    // the runtime toggle left on, never the saved next-start value.
    clientA.send('\x1b') // page -> Host Rows
    await waitForNoPattern(clientA, /Current Host/u, 'FR5-B Web page retired')
    assert(profileUserConfig(installation.profileDir, WEB_PREFERENCE_NS)?.autoStart === false,
      'the saved preference stays Off while the page is retired')
    await selectFrame(clientA, frame => selectedRow(frame, 'Web UI'), 'FR5-B Web re-entry row')
    clientA.send('\r')
    await waitForPattern(clientA, /Settings · Host · Web UI/u, 'FR5-B Web re-entered')
    const webPreference = await waitForPattern(clientA, /Serving\s+Enabled/u, 'FR5-B Web fresh mount still serves')
    assert(/Serving\s+Enabled/u.test(webPreference),
      `a fresh mount after the preference save must still report Enabled: ${JSON.stringify(webPreference)}`)
    assert(profileUserConfig(installation.profileDir, WEB_PREFERENCE_NS)?.autoStart === false,
      'the next-start preference remains Off after the fresh runtime observation')
    trace('fr5b.host-web-preference', { existingUserValueRead: true, savedProfile: true, freshMountRuntimeUnchanged: true })
    clientA.send('\x1b') // fresh page -> the Host Rows
    await waitForNoPattern(clientA, /Current Host/u, 'FR5-B Web second retirement')

    // ACP access is the SAME real Detail tenant over the running Host runtime
    // and the persisted next-start preference. The seeded autoStart binds the
    // listener at boot; every mutation below proves its OWN authoritative
    // readback and leaves the OTHER authority untouched.
    await selectFrame(clientA, frame => selectedRow(frame, 'ACP access'), 'FR5-B ACP access row')
    clientA.send('\r')
    await waitForPattern(clientA, /Settings · Host · ACP access/u, 'FR5-B ACP access page')
    const acpBoot = await waitForPattern(clientA, /Listener\s+(?:Enabled|Disabled)/u, 'FR5-B ACP runtime fact')
    assert(/Listener\s+Enabled/u.test(detailColumnText(acpBoot)),
      `the seeded ACP autoStart must bind the listener at boot: ${JSON.stringify(acpBoot)}`)
    const acpSeed = await waitForDetailPattern(clientA, /Start automatically\s+On\b/u, 'FR5-B ACP seeded preference')
    assert(/Start automatically\s+On\b/u.test(detailColumnText(acpSeed)),
      `the ACP page must read the seeded USER value On: ${JSON.stringify(acpSeed)}`)
    // Disable: the complete risk copy gates the ONE real Host write.
    await selectFrame(clientA, frame => selectedRow(frame, 'Disable ACP…'), 'FR5-B ACP disable row')
    clientA.send('\r')
    const acpDisableRisk = await waitForText(clientA, 'Disable the local ACP listener?', 'FR5-B ACP disable confirmation')
    assert(/Disable the local ACP listener\? All connected ACP clients will be disconnected\. Host sessions, Agents and this TUI will keep running\./u
      .test(detailColumnText(acpDisableRisk)),
    `the exact ACP disable risk must be painted whole: ${JSON.stringify(acpDisableRisk)}`)
    clientA.send('\r') // Disable ACP: the confirmation's own first focus
    await waitForPattern(clientA, /Listener\s+Disabled/u, 'FR5-B ACP runtime disabled')
    await waitForDetailPattern(clientA, /Status\s+Verified/u, 'FR5-B ACP runtime disable verified')
    // A runtime toggle must NEVER rewrite the persisted next-start preference.
    // The preference still reads On here, BEFORE the Enable toggle below.
    assert(profileUserConfig(installation.profileDir, ACP_PREFERENCE_NS)?.autoStart === true,
      'the disabled runtime must leave the next-start USER preference On')
    clientA.send('\r') // the disabled page's first focus is Enable ACP
    await waitForPattern(clientA, /Listener\s+Enabled/u, 'FR5-B ACP runtime re-enabled')
    await waitForDetailPattern(clientA, /Status\s+Verified/u, 'FR5-B ACP runtime enable verified')
    // The runtime round trip must not have rewritten the next-start preference.
    assert(profileUserConfig(installation.profileDir, ACP_PREFERENCE_NS)?.autoStart === true,
      'the ACP runtime toggle must leave the next-start USER preference On')
    trace('fr5b.host-acp-runtime', {
      disabled: true,
      disabledPreferenceStillOn: true,
      reEnabled: true,
      authoritativeReadback: true,
      preferenceUnchanged: true,
    })

    // Next Host Start: the ACP page writes its own official preference id after
    // the explicit candidate -> Confirm save ladder.
    await selectFrame(clientA, frame => selectedRow(frame, 'Start automatically'), 'FR5-B ACP start row')
    clientA.send('\r')
    await waitForText(clientA, 'Choose the value the next Host start applies:', 'FR5-B ACP start choice')
    await selectFrame(clientA, frame => selectedRow(frame, 'Off'), 'FR5-B ACP Off candidate')
    clientA.send('\r')
    await waitForText(clientA, 'Save the next Host start preference as Off?', 'FR5-B ACP confirm step')
    clientA.send('\r')
    // Wait for the NEXT-START section's own settled Status, not the earlier
    // runtime Status word.
    await waitForDetailPattern(clientA,
      /Next Host Start\s+Start automatically Off(?:\s|·).*?Status Verified/u,
      'FR5-B ACP preference settled in the next-start section')
    const acpSaved = await waitForProfileAutoStart(installation, false, 'FR5-B ACP preference profile', 30_000, ACP_PREFERENCE_NS)
    assert(acpSaved.autoStart === false, 'the ACP page writes the SAME official preference field')
    trace('fr5b.host-acp-preference', { savedProfile: true })
    // Retire the tenant and re-enter through the real Host row: the fresh mount
    // performs ONE new read and must still report the running listener, never the
    // saved next-start value.
    clientA.send('\x1b') // page -> Host Rows
    await waitForNoPattern(clientA, /Current Host/u, 'FR5-B ACP page retired')
    await selectFrame(clientA, frame => selectedRow(frame, 'ACP access'), 'FR5-B ACP re-entry row')
    clientA.send('\r')
    await waitForPattern(clientA, /Settings · Host · ACP access/u, 'FR5-B ACP re-entered')
    const acpFresh = await waitForPattern(clientA, /Listener\s+Enabled/u, 'FR5-B ACP fresh mount still listens')
    assert(/Listener\s+Enabled/u.test(detailColumnText(acpFresh)),
      `a fresh mount after the preference save must still report Enabled: ${JSON.stringify(acpFresh)}`)
    await waitForDetailPattern(clientA, /Start automatically\s+Off\b/u, 'FR5-B ACP fresh mount preference Off')
    assert(profileUserConfig(installation.profileDir, ACP_PREFERENCE_NS)?.autoStart === false,
      'the next-start preference remains Off after the fresh runtime observation')
    trace('fr5b.host-acp-reentry', { freshRead: true, runtimeUnchanged: true, preferenceOff: true })
    clientA.send('\x1b') // fresh page -> the Host Rows
    await waitForNoPattern(clientA, /Current Host/u, 'FR5-B ACP second retirement')
    await sleep(200)

    // ── Session log upload: risk text, Off, and Reset readback ─────────────
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

    // ── Agent loop: the single-value Detail tenant, ONE Confirm ────────────
    clientA.send('\x1b') // settled Detail -> Rows
    await sleep(160)
    clientA.send('\x1b') // Rows -> category rail
    await sleep(160)
    await selectFrame(clientA, frame => /^> Agent(?:\s|$)/mu.test(frame), 'FR5-B Agent category')
    clientA.send('\r')
    await sleep(200)
    await selectFrame(clientA, frame => selectedRow(frame, 'Parallel tool calls'), 'FR5-B Agent value row')
    // ONE Enter from Rows is the whole entry: the tenant opens its raw Input in
    // the SAME Detail pane (no field list, no Apply, no Save).
    clientA.send('\r')
    const agentInput = await waitForPattern(clientA, /Settings · Agent · Parallel tool calls/u, 'FR5-B Agent tenant')
    assert(/Current value\s+\d+/u.test(agentInput), `the Agent tenant must paint the current value: ${JSON.stringify(agentInput)}`)
    await waitForPattern(clientA, /Value:\s*/u, 'FR5-B Agent raw value input')
    clientA.send('\x15')
    await sleep(80)
    for (const character of '2') {
      clientA.send(character)
      await sleep(40)
    }
    await sleep(140)
    clientA.send('\r')
    const agentVerified = await waitForPattern(clientA, /Verified/u, 'FR5-B Agent value verified')
    assert(!/Apply \[Enter\]/u.test(agentVerified) && !/Save \[S\]/u.test(agentVerified),
      'the migrated Agent journey never advertises a second Apply/Save key')
    assert(profileUserConfig(installation.profileDir, AGENT_LOOP_NS)?.maxParallelToolCalls === 2,
      'ONE Confirm writes the official profile field')
    trace('fr5b.agent-loop', { savedProfile: true, singleConfirm: true })
    // Reset through the scoped Details disclosure: the official unset, then the
    // Host readback (never set(inherited)).
    await sleep(140)
    clientA.send('?')
    await waitForPattern(clientA, /Reset to inherited…/u, 'FR5-B Agent Advanced disclosure')
    await waitForPattern(clientA, /Inherited\s+\d+/u, 'FR5-B Agent inherited fact')
    clientA.send('x')
    const resetQuestion = await waitForPattern(clientA, /The Host readback decides the value\./u, 'FR5-B Agent reset confirmation')
    const inheritedMatch = /Inherited\s+(\d+)/u.exec(resetQuestion)
    assert(inheritedMatch !== null, `the reset confirmation must paint the real inherited value: ${JSON.stringify(resetQuestion)}`)
    const inherited = Number(inheritedMatch[1])
    await waitForPattern(clientA, /Confirm \[Enter\]/u, 'FR5-B Agent reset confirm affordance')
    clientA.send('\r')
    const agentReset = await waitForPattern(clientA, /Verified/u, 'FR5-B Agent reset verified')
    // The official unset's success criterion is the Host readback, never USER-key
    // absence: an unset may legitimately materialize the inherited value.
    assert(new RegExp(`Current value\\s+${inherited}(?:\\s|$)`, 'u').test(agentReset),
      `the reset readback must paint the value the official unset leaves behind (inherited=${inherited}): ${JSON.stringify(agentReset)}`)
    const persistedAfterReset = profileUserConfig(installation.profileDir, AGENT_LOOP_NS)?.maxParallelToolCalls
    assert(persistedAfterReset === undefined || persistedAfterReset === inherited,
      `the official unset leaves either no USER key or the inherited value, never a different number: ${JSON.stringify(persistedAfterReset)}`)
    clientA.send('\x1b') // the clean tenant -> Rows
    await sleep(200)
    await waitForPattern(clientA, new RegExp(`Parallel tool calls\\s+${inherited}(?:\\s|$)`, 'u'), 'FR5-B Agent row readback')
    trace('fr5b.agent-loop-reset', { officialUnset: true, readback: true, inherited })

    // ── Shell execution: grouped fields, ONE CAS, reset, then stale B ──────
    clientA.send('\x1b') // Agent rows -> category rail
    await sleep(160)
    await selectFrame(clientA, frame => /^> Tools(?:\s|$)/mu.test(frame), 'FR5-B Tools category')
    clientA.send('\r')
    await sleep(200)
    await selectFrame(clientA, frame => selectedRow(frame, 'Shell execution'), 'FR5-B Shell row A')
    clientA.send('\r')
    await waitForPattern(clientA, /Settings · Tools · Shell execution/u, 'FR5-B Shell group A')
    await waitForPattern(clientA, /Host model-tool executor · POSIX Bash/u, 'FR5-B active executor A')
    const shellSeeded = profileUserConfig(installation.profileDir, SHELL_NS) ?? {}
    const seededCaps = { timeoutMs: shellSeeded.timeoutMs, maxOutputBytes: shellSeeded.maxOutputBytes }
    const shellOpenedFrame = await frameOf(clientA)
    assert(/Command timeout \(ms\)\s+60000 ms/u.test(shellOpenedFrame)
      && /Output cap per stream \(bytes\)\s+64000 bytes/u.test(shellOpenedFrame),
    `the Shell group must show the official inherited caps and units: ${JSON.stringify(shellOpenedFrame)}`)
    assert(!/Edit Command timeout \(ms\)/u.test(shellOpenedFrame),
      'entering the group never opens the raw Input')
    assert(/Save \[S\]/u.test(shellOpenedFrame) === false,
      `a clean group paints no Save: ${JSON.stringify(shellOpenedFrame)}`)

    // Client B opens the SAME section BEFORE A saves, so both pages capture the
    // same revision; only the first Save may win.
    await openCategory(clientB, 'Tools', 'FR5-B Tools B')
    await selectFrame(clientB, frame => selectedRow(frame, 'Shell execution'), 'FR5-B Shell row B')
    clientB.send('\r')
    await waitForPattern(clientB, /Settings · Tools · Shell execution/u, 'FR5-B Shell group B')
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
    await waitForPattern(clientB, /1 unsaved change/u, 'FR5-B Shell staged B')
    const bStagedFrame = await frameOf(clientB)
    assert(/Command timeout \(ms\)\s+90000 ms/u.test(bStagedFrame)
      && /Current: 60000 ms · Unsaved/u.test(bStagedFrame),
    `B must paint its candidate beside the served Current: ${JSON.stringify(bStagedFrame)}`)
    assertShellCaps(installation.profileDir, seededCaps, 'B local stage')

    await selectFrame(clientA, frame => selectedRow(frame, 'Command timeout (ms)'), 'FR5-B Shell timeout field A')
    clientA.send('\r')
    await waitForText(clientA, 'Edit Command timeout (ms)', 'FR5-B Shell timeout input A')
    clientA.send('\x15')
    await sleep(80)
    for (const character of '45000') {
      clientA.send(character)
      await sleep(40)
    }
    clientA.send('\r') // stage the first field locally
    const firstStage = await waitForPattern(clientA, /1 unsaved change/u, 'FR5-B Shell first stage A')
    assert(/Command timeout \(ms\)\s+45000 ms/u.test(firstStage)
      && /Current: 60000 ms · Unsaved/u.test(firstStage),
    `A's first stage must paint the candidate beside the served Current: ${JSON.stringify(firstStage)}`)
    assertShellCaps(installation.profileDir, seededCaps, 'A first local stage (both caps)')
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
    const shellStagedFrame = await waitForPattern(clientA, /2 unsaved changes/u, 'FR5-B Shell staged A')
    assert(/Command timeout \(ms\)\s+45000 ms/u.test(shellStagedFrame)
      && /Output cap per stream \(bytes\)\s+128000 bytes/u.test(shellStagedFrame),
    `the Shell group must paint both staged caps: ${JSON.stringify(shellStagedFrame)}`)
    assertShellCaps(installation.profileDir, seededCaps, 'A local stages')
    await saveAndVerify(clientA, 'FR5-B Shell verified A', /Status\s+Verified/u)
    const shellPatch = profileUserConfig(installation.profileDir, SHELL_NS)
    assert(shellPatch?.timeoutMs === 45_000 && shellPatch?.maxOutputBytes === 128_000,
      `the shell group writes both caps in the official patch: ${JSON.stringify(shellPatch)}`)
    const aVerifiedFrame = await frameOf(clientA)
    assert(/Status\s+Verified/u.test(aVerifiedFrame) && /Settings · Tools · Shell execution/u.test(aVerifiedFrame),
      'a verified Save stays in the SAME group')
    assert(/Command timeout \(ms\)\s+45000 ms/u.test(aVerifiedFrame)
      && /Output cap per stream \(bytes\)\s+128000 bytes/u.test(aVerifiedFrame),
    `the verified frame paints BOTH authoritative caps: ${JSON.stringify(aVerifiedFrame)}`)

    // A's committed write invalidated B's captured revision. Depending on
    // whether the shared document-updated event reaches B before the key, the
    // stale Save either meets the CAS ("Not saved") or is refused by the
    // Last-known read-only page (no Save painted). Both are refusals; neither
    // may write.
    clientB.send('s')
    // ONE explicit Save attempt; its OWN refusal receipt must arrive (the Host
    // CAS or the landed Last-known page). The explicit retry is not used to
    // fish for a refusal.
    const bAfterSaveAttempt = await waitForPattern(clientB, /Not saved|refresh to review|Last-known/u,
      'FR5-B stale Client B refusal', 30_000)
    assert(!/Verified/u.test(bAfterSaveAttempt), 'the stale Client never claims a verified write')
    assert(/Command timeout \(ms\)\s+90000 ms/u.test(bAfterSaveAttempt)
      && /Last confirmed: 60000 ms · Unsaved/u.test(bAfterSaveAttempt)
      && !/Current: 60000 ms/u.test(bAfterSaveAttempt) && !/Verified/u.test(bAfterSaveAttempt),
    `the stale Client retains its requested value and the real last-confirmed fact: ${JSON.stringify(bAfterSaveAttempt)}`)
    assertShellCaps(installation.profileDir, { timeoutMs: 45_000, maxOutputBytes: 128_000 },
      'Client B stale Save')
    trace('fr5b.shell-two-client', { bothCapsOneSave: true, staleRefused: true, profileKept: true })

    // A's explicit Reset of the SECOND field: the official unset is only STAGED
    // until the group Save, then the Host readback decides the value.
    const shellCommitted = profileUserConfig(installation.profileDir, SHELL_NS) ?? {}
    const committedCaps = { timeoutMs: shellCommitted.timeoutMs, maxOutputBytes: shellCommitted.maxOutputBytes }
    await selectFrame(clientA, frame => selectedRow(frame, 'Output cap per stream (bytes)'), 'FR5-B Shell reset field A')
    clientA.send('?')
    const shellAdvanced = await waitForPattern(clientA, /Reset to inherited…/u, 'FR5-B Shell Advanced A')
    const shellInheritedMatch = /Inherited\s+(\d+) bytes/u.exec(shellAdvanced)
    assert(shellInheritedMatch !== null,
      `the selected field Advanced must paint the real inherited cap: ${JSON.stringify(shellAdvanced)}`)
    const inheritedCap = Number(shellInheritedMatch[1])
    assert(new RegExp(`Effective\\s+128000 bytes`, 'u').test(shellAdvanced),
      'Advanced paints the served effective value')
    clientA.send('x')
    const shellResetStaged = await waitForPattern(clientA, /Reset staged/u, 'FR5-B Shell reset staged A')
    assert(/Output cap per stream \(bytes\)\s+Reset staged/u.test(shellResetStaged),
      `the official unset is staged on the selected field: ${JSON.stringify(shellResetStaged)}`)
    assert(/1 unsaved change/u.test(shellResetStaged),
      'the staged reset is a real dirty intent')
    assertShellCaps(installation.profileDir, committedCaps, 'A staged reset (both caps)')
    await saveAndVerify(clientA, 'FR5-B Shell reset verified A', /Status\s+Verified/u)
    const shellAfterReset = await frameOf(clientA)
    assert(new RegExp(`Output cap per stream \\(bytes\\)\\s+${inheritedCap} bytes`, 'u').test(shellAfterReset),
      `the verified group paints the Host readback, not the requested unset: ${JSON.stringify(shellAfterReset)}`)
    assert(/Command timeout \(ms\)\s+45000 ms/u.test(shellAfterReset),
      `the verified group keeps the sibling timeout: ${JSON.stringify(shellAfterReset)}`)
    const resetPatch = profileUserConfig(installation.profileDir, SHELL_NS)
    assert(resetPatch?.timeoutMs === 45_000,
      `the sibling timeout stays at its saved value after the reset: ${JSON.stringify(resetPatch)}`)
    assert(resetPatch?.maxOutputBytes === undefined || resetPatch?.maxOutputBytes === inheritedCap,
      `the official unset leaves no USER cap or the inherited value, never another number: ${JSON.stringify(resetPatch)}`)
    // Back to Rows: the ROW must read the authoritative Host caps, not the
    // page's last painted draft.
    clientA.send('\x1b')
    const shellRows = await waitForPattern(clientA, /Settings · Tools · Rows/u, 'FR5-B Shell back to Rows')
    assert(/Timeout 45000 ms/u.test(shellRows),
      `the Rows summary reads the authoritative committed timeout: ${JSON.stringify(shellRows)}`)
    assert(/Timeout 45000 ms/u.test(shellRows),
      `the Rows summary reads the authoritative committed timeout: ${JSON.stringify(shellRows)}`)
    // The Rows summary may clip at narrow widths; the Detail preview is the
    // actual readback route, so select/focus it through the real screen path.
    let preview = shellRows
    if (!new RegExp(`Output cap ${inheritedCap} bytes`, 'u').test(preview) || !/Timeout 45000 ms/u.test(preview)) {
      preview = await selectFrame(clientA, frame => selectedRow(frame, 'Shell execution'), 'FR5-B Shell row readback')
      clientA.send('\t')
      await sleep(160)
      preview = await frameOf(clientA)
    }
    assert(new RegExp(`Timeout 45000 ms`, 'u').test(preview)
      && new RegExp(`Output cap ${inheritedCap} bytes`, 'u').test(preview),
    `the Rows/Detail readback paints BOTH authoritative caps: ${JSON.stringify(preview)}`)
    trace('fr5b.shell-grouped-reset', { resetStaged: true, readbackDecides: true, siblingKept: true, inheritedCap, rowsReadback: true })

    await scene.assertHostIdentityKept(host, identity, 'FR5-B settings writes')
    await closeClient(clientA, scene, 'FR5-B Client A')
    clientA = undefined
    // B still holds its refused draft: leave through the REAL painted receipt,
    // prove the group retired to Rows, and only then close Settings normally.
    await leaveDirtyShellGroup(clientB, 'FR5-B Client B')
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
      shellGroupedReset: true,
      staleRevisionRefused: true,
      originalSplitHostIntact: true,
    }
  } finally {
    if (clientB !== undefined) await clientB.dispose().catch(() => {})
    if (clientA !== undefined) await clientA.dispose().catch(() => {})
    if (host !== undefined) await scene.stopC1Host(host)
    await scene.dispose()
    // Restore the exact original bytes: this case's seeded USER rows and real
    // UI saves are its own preconditions, never lane-wide facts. A failure here
    // MUST surface — silently swallowing it is what let the leak reach the next
    // case and fail `web.startup-preference`.
    writeFileSync(profilePatch, originalPatch, { mode: 0o600 })
  }
}
