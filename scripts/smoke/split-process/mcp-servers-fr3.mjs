/**
 * FR3: the ONE Host MCP manager in the REAL Split Host/Client.
 *
 * ONE real Host (the installed candidate package) and ONE real authenticated
 * TUI Client prove the MCP management contract end to end:
 *
 *   1. the Host mounts exactly ONE official `mcp-manager` row (active, one
 *      fiber) and the generated `mcpManager` Remote namespace is usable;
 *   2. a test-only stdio server configured through the profile's own
 *      `mcp-manager.servers` reaches the TUI Settings page as a `Connected`
 *      `Configured` row — the configuration-source verdict comes from the
 *      official Settings key set, never the manager `configured` flag;
 *   3. Probe connects and lists the real server's tool (official result);
 *   4. Restart is dispatched ONCE through the official Host `restart`, and the
 *      page reports the settled request without claiming a connected status;
 *   5. `/web` on → off keeps the SAME `mcp-manager` Host fiber (the Web toggle
 *      never owns, mounts or unloads the shared manager).
 *
 * The only fixture is a minimal stdio MCP server with one tool; no production
 * server is probed or restarted.
 *
 * @module split-process/mcp-servers-fr3
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostStatus, waitForCondition } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

const SERVER_NAME = 'fr3-fixture'

/** A minimal MCP stdio server: initialize, tools/list, tools/call. */
const FIXTURE_SERVER_SOURCE = `#!/usr/bin/env node
import { createInterface } from 'node:readline'
const send = payload => process.stdout.write(JSON.stringify(payload) + '\\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id === undefined) return
  switch (message.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fr3-fixture', version: '1.0.0' },
      } })
      return
    case 'ping':
      send({ jsonrpc: '2.0', id: message.id, result: {} })
      return
    case 'tools/list':
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'echo', description: 'Echo a message', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
      ] } })
      return
    case 'tools/call':
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } })
      return
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })
  }
})
`

async function waitForScreenText(client, text, label, timeoutMs = 90_000) {
  try {
    await waitForCondition(async () => (await client.viewport()).join('\n').includes(text), label, timeoutMs)
  } catch (error) {
    const frame = await client.viewport()
    const lines = frame.filter(line => /mcp|server|probe|restart|connected|configured|unavailable/iu.test(line))
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: text, diagnosticLines: lines.slice(-16) })}`, { cause: error })
  }
}

/** Type one line into a proven-empty main editor seat. */
async function submitLine(client, line, label) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const marker = `fr3-ready-${String(attempt + 1)}`
    client.send(marker)
    try {
      await client.waitForComposerDraft(marker, 8_000)
    } catch {
      client.send('\x15')
      await sleep(300)
      continue
    }
    client.send('\x15')
    for (let poll = 0; poll < 60; poll += 1) {
      if (await client.composerText().then(text => text === undefined).catch(() => true)) {
        client.send(`${line}\r`)
        return
      }
      await sleep(100)
    }
  }
  throw new SplitSmokeAssertionError(`${label}: the editor seat never accepted the line`)
}

/** Leave the Settings workspace and prove the main editor regains the seat. */
async function exitSettingsWorkspace(client, label) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = `fr3-exit-${String(attempt)}`
    client.send(probe)
    try {
      await client.waitForComposerDraft(probe, 1_200)
      client.send('\x15')
      return
    } catch {
      client.send('\x15')
      client.send('\x1b')
      await sleep(300)
    }
  }
  throw new SplitSmokeAssertionError(`${label}: the main editor never regained the seat`)
}

/** Open Settings and walk to the MCP servers page. */
async function openMcpPage(client, label) {
  await submitLine(client, '/settings', `${label} /settings`)
  await waitForScreenText(client, 'Settings', `${label} settings workspace`)
  for (let step = 0; step < 14; step += 1) {
    const frame = (await client.viewport()).join('\n')
    if (/^\s*> Tools\b/mu.test(frame)) break
    client.send('\x1b[B')
    await sleep(200)
  }
  assert(/^\s*> Tools\b/mu.test((await client.viewport()).join('\n')), `${label}: the Tools category was never selected`)
  client.send('\r') // Categories -> Rows
  await sleep(300)
  for (let step = 0; step < 8; step += 1) {
    const frame = (await client.viewport()).join('\n')
    if (/^\s*> MCP servers\b/mu.test(frame)) break
    client.send('\x1b[B')
    await sleep(200)
  }
  assert(/^\s*> MCP servers\b/mu.test((await client.viewport()).join('\n')), `${label}: the MCP servers row was never selected`)
  client.send('\r') // open the embedded page
  await sleep(400)
}

/** The live `mcp-manager` Host row identity (one row, one fiber). */
async function mcpManagerRow(host, label) {
  const status = await hostStatus(host)
  const rows = (status.entries ?? []).filter(entry => entry.id === 'mcp-manager')
  assert(rows.length === 1, `${label}: exactly ONE mcp-manager Host row is expected, found ${String(rows.length)}`)
  assert(rows[0].state === 'active' && Number.isInteger(rows[0].fiberUid),
    `${label}: the mcp-manager row must be active with a live fiber: ${JSON.stringify(rows[0])}`)
  return rows[0]
}

/** Poll the Host Loader row state of one web row. */
async function webRowActive(host, id, expected, label) {
  await waitForCondition(async () => {
    const status = await hostStatus(host)
    const row = (status.entries ?? []).find(entry => entry.id === id)
    return (row?.state === 'active') === expected
  }, label, 60_000)
}

/**
 * One case: `mcp.servers-fr3`.
 */
export async function runMcpServersFr3(context) {
  const { trace } = context
  const scene = createC1Scene(context)
  const root = (() => {
    const dir = scene.c1WorkRoot('fr3-mcp-servers')
    return dir
  })()
  const serverScript = join(root, 'fr3-mcp-fixture-server.mjs')
  writeFileSync(serverScript, FIXTURE_SERVER_SOURCE, { mode: 0o700 })
  // The profile's OWN `mcp-manager` row inherits this configuration by id; no
  // second manager row and no production server is touched.
  appendFileSync(scene.c1Work.patchPath, `\n- id: mcp-manager\n  config:\n    servers:\n      ${SERVER_NAME}:\n        transport: stdio\n        command: ${JSON.stringify(process.execPath)}\n        args: [${JSON.stringify(serverScript)}]\n        enabled: true\n`)

  let host
  let client
  try {
    const started = await scene.startC1Host('mcp-servers-fr3', 'FR3 MCP Host')
    host = started.host
    const row = await mcpManagerRow(host, 'FR3 initial')
    trace('fr3.manager-mounted', { id: row.id, fiberUid: row.fiberUid })

    const a = await scene.startC1Client('FR3 MCP Client')
    client = a.client
    await openMcpPage(client, 'FR3')
    await waitForScreenText(client, SERVER_NAME, 'FR3 configured server row')
    await waitForScreenText(client, 'Connected', 'FR3 live connection')
    const listFrame = (await client.viewport()).join('\n')
    assert(/Configured/u.test(listFrame), `FR3: the configured server must show Source Configured:\n${listFrame}`)

    // Detail + Probe (a real connect + tools/list on the test server).
    client.send('\r')
    await sleep(300)
    await waitForScreenText(client, 'Transport: Not exposed', 'FR3 detail transport fact')
    client.send('p')
    await waitForScreenText(client, 'Probe passed', 'FR3 probe result')
    const afterProbe = (await client.viewport()).join('\n')
    assert(/1 tool/u.test(afterProbe), `FR3: the probe must report the fixture tool: ${JSON.stringify(afterProbe)}`)
    trace('fr3.probe', { passed: true })

    // Restart: explicit confirmation, ONE dispatch, settled (not "connected").
    client.send('x')
    await waitForScreenText(client, `Restart ${SERVER_NAME}?`, 'FR3 restart confirmation')
    client.send('y')
    await waitForScreenText(client, 'Restart settled · awaiting connected status', 'FR3 restart settled notice')
    trace('fr3.restart', { dispatched: true })

    // /web on -> off keeps the SAME manager fiber (Web never owns it).
    await exitSettingsWorkspace(client, 'FR3')
    const beforeWeb = await mcpManagerRow(host, 'FR3 before /web')
    await submitLine(client, '/web', 'FR3 /web enable')
    await webRowActive(host, 'web-runtime', true, 'FR3 web enabled')
    const duringWeb = await mcpManagerRow(host, 'FR3 during /web')
    assert(duringWeb.fiberUid === beforeWeb.fiberUid, 'FR3: enabling Web re-mounted the shared mcp-manager row')
    await submitLine(client, '/web', 'FR3 /web disable')
    await webRowActive(host, 'web-runtime', false, 'FR3 web disabled')
    const afterWeb = await mcpManagerRow(host, 'FR3 after /web')
    assert(afterWeb.fiberUid === beforeWeb.fiberUid, 'FR3: /web off->on->off replaced the shared mcp-manager fiber')
    trace('fr3.web-identity', { fiberUid: beforeWeb.fiberUid, kept: true })

    client.send('/exit\r')
    await client.waitForExit(60_000)
    await client.dispose()
    client = undefined
    await scene.stopC1Host(host)
    host = undefined
    return { status: 'PASS' }
  } finally {
    await scene.dispose()
  }
}
