/**
 * FR5-A Subagent settings over two real authenticated Split Clients.
 *
 * One official home override forces only Selection to refuse its write, while
 * Limits remains writable. Client B proves partial settlement; Client A keeps
 * the revision it opened with and cannot overwrite B after that Host update.
 *
 * @module split-process/subagent-settings-fr5a
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { isDeepStrictEqual } from 'node:util'
import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { submitLine } from './mcp-servers-fr3.mjs'

const SELECTION_NS = 'subagent-model-selection-settings'
const SAVED_ROUTE = { provider: 'fr5a-saved-provider', model: 'fr5a-saved-model' }

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

async function selectFrame(client, predicate, label, direction = '\x1b[B', limit = 20) {
  for (let step = 0; step < limit; step += 1) {
    const frame = await frameOf(client)
    if (predicate(frame)) return frame
    client.send(direction)
    await sleep(120)
  }
  throw new SplitSmokeAssertionError(`${label}: the target was never selected; frame=${JSON.stringify((await client.viewport()).slice(-18))}`)
}

async function openSubagentSettings(client, label) {
  await submitLine(client, '/settings', `${label} /settings`)
  await waitForText(client, 'Settings · Categories', `${label} Settings root`)
  await selectFrame(client, frame => /^> Agent\b/mu.test(frame), `${label} Agent category`)
  client.send('\r')
  await sleep(180)
  await selectFrame(client, frame => /^> Subagent settings\b/mu.test(frame), `${label} Subagent row`)
  client.send('\r')
  await waitForPattern(client, /Settings · Agent · Subagent settings[\s\S]*Limits · Ready[\s\S]*Model selection · Ready/u,
    `${label} authoritative Subagent page`)
}

async function focusField(client, label, where) {
  await selectFrame(client, frame => new RegExp(`^> ${label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'mu').test(frame), where, '\x1b[B', 6)
}

async function stageNumber(client, label, value, where) {
  await focusField(client, label, where)
  client.send('\r')
  await waitForText(client, `Edit ${label}`, `${where} input`)
  client.send('\x15')
  await sleep(80)
  for (const char of value) {
    client.send(char)
    await sleep(40)
  }
  client.send('\r')
  const frame = await waitForPattern(client, /Limits: Unsaved/u, `${where} staged limit`)
  assert(frame.includes('Save [S]'), `${where}: the staged limit must paint Save`)
}

async function stageEnabled(client, where) {
  await focusField(client, 'Enabled', `${where} Enabled`)
  client.send('\r')
  await waitForPattern(client, /> Enabled\s+On\b/u, `${where} staged Enabled`)
  const frame = await waitForPattern(client, /Selection: Unsaved/u, `${where} staged selection`)
  assert(frame.includes('Save [S]'), `${where}: Enabled must remain staged before Save`)
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

export async function runSubagentSettingsFr5A(context) {
  const { trace, installation, dshHome } = context
  const scene = createC1Scene(context)
  let host
  let clientA
  let clientB
  try {
    // The isolated DSH_HOME patch supplies a valid route and overlays Enabled
    // Off. The staged Enabled=true field reaches the official ConfigEditor
    // refusal while Limits can still commit independently.
    const homePatch = join(dshHome, 'cordis.patch.yml')
    assert(!existsSync(homePatch), 'the isolated DSH home must not have a pre-existing overlay')
    writeFileSync(homePatch, [
      `- id: ${SELECTION_NS}`,
      '  config:',
      '    enabled: false',
      '    allowedModels:',
      `      - provider: ${SAVED_ROUTE.provider}`,
      `        model: ${SAVED_ROUTE.model}`,
      '',
    ].join('\n'), { mode: 0o600 })
    chmodSync(homePatch, 0o600)

    const started = await scene.startC1Host('subagent-settings-fr5a', 'FR5-A Subagent Host')
    host = started.host
    const identity = await scene.hostIdentityFacts(host)
    const clientAStarted = await scene.startC1Client('FR5-A Subagent Client A')
    clientA = clientAStarted.client
    const clientBStarted = await scene.startC1Client('FR5-A Subagent Client B')
    clientB = clientBStarted.client
    assert(clientA.child.pid !== clientB.child.pid, 'the two authenticated Clients must use distinct script(1) wrappers')
    assert(clientAStarted.ready.pid !== clientA.child.pid && clientBStarted.ready.pid !== clientB.child.pid,
      'each ready record must name the real Node Client, not its script(1) wrapper')
    assert(clientAStarted.ready.pid !== clientBStarted.ready.pid, 'the two authenticated Clients must have distinct business PIDs')
    trace('fr5a.authenticated-clients', {
      wrapperPids: [clientA.child.pid, clientB.child.pid],
      clientPids: [clientAStarted.ready.pid, clientBStarted.ready.pid],
    })
    scene.assertInteractionGate(clientA, 'FR5-A Client A')
    scene.assertInteractionGate(clientB, 'FR5-A Client B')

    // A and B both open against the unchanged Host sections. A stages a distinct
    // Limits value; B stages a winning Limits value plus the independently
    // rejected Selection.enabled field.
    await openSubagentSettings(clientA, 'FR5-A Client A')
    await stageNumber(clientA, 'Maximum recursion depth', '2', 'FR5-A Client A')
    await openSubagentSettings(clientB, 'FR5-A Client B')
    await stageNumber(clientB, 'Maximum recursion depth', '3', 'FR5-A Client B')
    await stageEnabled(clientB, 'FR5-A Client B')

    assert(profileUserConfig(installation.profileDir, 'subagent') === undefined,
      'neither Client has written Limits before Save')
    assert(profileUserConfig(installation.profileDir, SELECTION_NS) === undefined,
      'neither Client has written Selection before Save')

    clientB.send('s')
    const bFrame = await waitForPattern(clientB,
      /Limits: Verified[\s\S]*Selection: Outcome unconfirmed/u,
      'FR5-A Client B partial namespace settlement')
    assert(isDeepStrictEqual(profileUserConfig(installation.profileDir, 'subagent'), { maxDepth: 3 }),
      'the writable Limits namespace reaches the actual Host USER profile patch')
    assert(profileUserConfig(installation.profileDir, SELECTION_NS) === undefined,
      'the home-overlay refusal creates no Selection USER override')
    assert(bFrame.includes('home patch or command-line overlay'),
      'the failed section names the official higher-layer refusal')
    trace('fr5a.remote-partial-save', { limitsVerified: true, selectionOutcomeUnconfirmed: true, profilePatch: true })

    // A must not rebase its draft onto B's newer Host revision or overwrite it.
    // Whether the shared document-updated event has already refreshed A's mirror
    // or A discovers the revision at Save, the real Settings page refuses the
    // stale intent and the bytes remain B's committed value.
    clientA.send('s')
    const aFrame = await waitForPattern(clientA,
      /Last-known|Not saved · settings changed|Refresh to review/u,
      'FR5-A Client A stale-revision outcome')
    assert(profileUserConfig(installation.profileDir, 'subagent')?.maxDepth === 3,
      'Client A cannot replace Client B\'s actual profile value with its stale 2')
    assert(profileUserConfig(installation.profileDir, SELECTION_NS) === undefined,
      'Client A cannot bypass the higher-layer Selection refusal')
    await scene.assertHostIdentityKept(host, identity, 'FR5-A settings writes')
    trace('fr5a.remote-two-client-conflict', { clients: 2, staleIntentRefused: true, hostIdentityKept: true })

    await closeClient(clientA, scene, 'FR5-A Client A')
    clientA = undefined
    await closeClient(clientB, scene, 'FR5-A Client B')
    clientB = undefined
    await scene.stopC1Host(host)
    host = undefined
    await scene.awaitSceneSeatFree()
    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L5',
      authenticatedClients: 2,
      limitsPartialSuccess: true,
      selectionOverlayRefusal: true,
      staleRevisionRefused: aFrame.includes('Last-known') || aFrame.includes('Not saved'),
      hostProfileReadback: true,
      originalSplitHostIntact: true,
    }
  } finally {
    if (clientB !== undefined) await clientB.dispose().catch(() => {})
    if (clientA !== undefined) await clientA.dispose().catch(() => {})
    if (host !== undefined) await scene.stopC1Host(host)
    await scene.dispose()
  }
}
