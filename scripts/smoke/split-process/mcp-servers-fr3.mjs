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
 *   3. Probe connects and lists the real tool for BOTH official transports
 *      (stdio and streamable-http), and a disabled entry is still probeable;
 *   4. Restart is dispatched ONCE through the official Host `restart` (stdio and
 *      HTTP), and the page reports the settled request without claiming a
 *      connected status; a waiting-credentials entry and a failing entry stay
 *      their own negative facts and never hide the other servers;
 *   5. `/web` on → off keeps the SAME `mcp-manager` Host fiber (the Web toggle
 *      never owns, mounts or unloads the shared manager).
 *
 * Fixtures are minimal local MCP servers (stdio + raw streamable-http) with one
 * tool; no production server is probed or restarted.
 *
 * @module split-process/mcp-servers-fr3
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
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
      const composer = await client.composerText().catch(() => undefined)
      const empty = composer === undefined
        || composer.split('\n').every(text => text.replace(/[│┌┐└┘─]/gu, ' ').replace(/❯/gu, ' ').trim() === '')
      if (empty) {
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
    `${label}: the mcp-manager row must be active with a live fiber: ${JSON.stringify(rows[0])}; stderr=${JSON.stringify((host.stderr ?? '').slice(-2500))}`)
  return rows[0]
}

/** One correlated private `piTuiWebAccess` round trip on a live Peer. */
async function webAccess(peer, value, label, sequence) {
  const requestId = `fr3-web-${String(sequence)}`
  peer.send({ op: 'qualification-web-access', requestId, webAccessEnabled: value })
  const record = await peer.waitFor(entry => entry.op === 'web-access' && entry.requestId === requestId,
    label, 300_000)
  assert(record.ok === true, `${label}: the private Web access call failed: ${JSON.stringify(record.errorCode ?? null)}`)
  return record.status
}


/** A stdio server that answers initialize then drops the transport (give-up). */
const GIVEUP_SERVER_SOURCE = `#!/usr/bin/env node
import { createInterface } from 'node:readline'
const send = payload => process.stdout.write(JSON.stringify(payload) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fr3-giveup', version: '1.0.0' },
    } })
    setTimeout(() => process.exit(1), 40)
    return
  }
  if (message.method === 'ping') send({ jsonrpc: '2.0', id: message.id, result: {} })
})
`

/** A minimal raw Streamable HTTP MCP fixture (initialize/tools/list/tools/call). */
async function startHttpMcpFixture() {
  const reply = message => {
    if (message.id === undefined) return undefined
    switch (message.method) {
      case 'initialize':
        return { jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fr3-http-fixture', version: '1.0.0' },
        } }
      case 'ping': return { jsonrpc: '2.0', id: message.id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }] } }
      case 'tools/call':
        return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } }
      default:
        return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } }
    }
  }
  const server = createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(405, { 'content-type': 'application/json' }).end('{"error":"no sse"}'); return }
    if (req.method === 'DELETE') { res.writeHead(200).end('{}'); return }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let parsed
      try { parsed = JSON.parse(body) } catch { res.writeHead(400).end('{"error":"bad json"}'); return }
      const messages = Array.isArray(parsed) ? parsed : [parsed]
      const responses = messages.map(reply).filter(Boolean)
      if (responses.length === 0) { res.writeHead(202).end(); return }
      const initialize = messages.some(m => m.method === 'initialize')
      const payload = JSON.stringify(responses.length === 1 ? responses[0] : responses)
      res.writeHead(200, {
        'content-type': 'application/json',
        ...(initialize ? { 'mcp-session-id': 'fr3-http-session' } : {}),
      }).end(payload)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

/** Wait for one regex in the client frame. */
async function waitForScreenPattern(client, pattern, label, timeoutMs = 90_000) {
  try {
    await waitForCondition(async () => pattern.test((await client.viewport()).join('\n')), label, timeoutMs)
  } catch (error) {
    const frame = await client.viewport()
    const lines = frame.filter(line => /mcp|server|probe|restart|state|connected|disabled|credential|failed/iu.test(line))
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: String(pattern), diagnosticLines: lines.slice(-16) })}`, { cause: error })
  }
}

/** Go back to the list and select the Nth (0-based) row, then open its detail. */
async function selectRow(client, index) {
  // Back to the list (a Detail Esc returns there; an already-list frame is a
  // no-op for the list's own Esc ladder only when the page is at its root, so
  // the caller always invokes this from a Detail frame).
  client.send('\x1b')
  await sleep(300)
  // Reach the FIRST row by probing the painted marker (the list wraps, so a
  // fixed number of Up presses cannot mean "top").
  for (let step = 0; step < 8; step += 1) {
    if (/\u25b8 fr3-fixture/u.test((await client.viewport()).join('\n'))) break
    client.send('\x1b[A')
    await sleep(200)
  }
  for (let step = 0; step < index; step += 1) {
    client.send('\x1b[B')
    await sleep(200)
  }
  client.send('\r')
  await sleep(400)
}

/** One case: `mcp.servers-fr3`.
 */
export async function runMcpServersFr3(context) {
  const { trace } = context
  const scene = createC1Scene(context, { mcpManagerProbe: true })
  const root = (() => {
    const dir = scene.c1WorkRoot('fr3-mcp-servers')
    return dir
  })()
  let httpServer
  const serverScript = join(root, 'fr3-mcp-fixture-server.mjs')
  writeFileSync(serverScript, FIXTURE_SERVER_SOURCE, { mode: 0o700 })
  const failScript = join(root, 'fr3-mcp-fail-server.mjs')
  writeFileSync(failScript, '#!/usr/bin/env node\nprocess.exit(1)\n', { mode: 0o700 })
  const giveupScript = join(root, 'fr3-mcp-giveup-server.mjs')
  writeFileSync(giveupScript, GIVEUP_SERVER_SOURCE, { mode: 0o700 })
  const httpFixture = await startHttpMcpFixture()
  httpServer = httpFixture
  // The profile's OWN `mcp-manager` row inherits this configuration by id; no
  // second manager row and no production server is touched. Five entries cover
  // both official transports plus the L4 negatives (disabled probe, a
  // waiting-credentials entry and a failing entry).
  appendFileSync(scene.c1Work.patchPath, [
    '',
    '- id: mcp-manager',
    '  config:',
    '    servers:',
    `      ${SERVER_NAME}:`,
    '        transport: stdio',
    `        command: ${JSON.stringify(process.execPath)}`,
    `        args: [${JSON.stringify(serverScript)}]`,
    '        enabled: true',
    '      fr3-http:',
    '        transport: streamable-http',
    `        url: ${JSON.stringify(httpFixture.url)}`,
    '        enabled: true',
    '      fr3-disabled:',
    '        transport: stdio',
    `        command: ${JSON.stringify(process.execPath)}`,
    `        args: [${JSON.stringify(serverScript)}]`,
    '        enabled: false',
    '      fr3-credentials:',
    '        transport: stdio',
    `        command: ${JSON.stringify(process.execPath)}`,
    `        args: [${JSON.stringify(serverScript)}]`,
    '        enabled: true',
    '        env:',
    '          TOKEN: "${credential:FR3_MISSING}"',
    '      fr3-fail:',
    '        transport: stdio',
    `        command: ${JSON.stringify(process.execPath)}`,
    `        args: [${JSON.stringify(failScript)}]`,
    '        enabled: true',
    '        reconnect:',
    '          enabled: false',
    '      fr3-giveup:',
    '        transport: stdio',
    `        command: ${JSON.stringify(process.execPath)}`,
    `        args: [${JSON.stringify(giveupScript)}]`,
    '        enabled: true',
    '        reconnect:',
    '          enabled: true',
    '          initialDelayMs: 1',
    '          maxDelayMs: 1',
    '          maxAttempts: 1',
    '',
  ].join('\n'))

  let host
  let client
  let peerProcess
  try {
    const started = await scene.startC1Host('mcp-servers-fr3', 'FR3 MCP Host')
    host = started.host
    const row = await mcpManagerRow(host, 'FR3 initial')
    trace('fr3.manager-mounted', { id: row.id, fiberUid: row.fiberUid })

    const a = await scene.startC1Client('FR3 MCP Client')
    client = a.client
    await openMcpPage(client, 'FR3')
    await waitForScreenText(client, SERVER_NAME, 'FR3 configured stdio server row')
    await waitForScreenText(client, 'fr3-http', 'FR3 configured HTTP server row')
    await waitForScreenText(client, 'Connected', 'FR3 live connection')
    const listFrame = (await client.viewport()).join('\n')
    assert(/Configured/u.test(listFrame), `FR3: the configured server must show Source Configured:\n${listFrame}`)
    // A single failed server never hides the other managed servers.
    assert(/fr3-fail/u.test(listFrame) && /fr3-disabled/u.test(listFrame),
      `FR3: the failing/disabled servers must stay listed beside the healthy ones:\n${listFrame}`)

    // ROW 0 — stdio: real Probe, then one settled Restart.
    client.send('\r')
    await sleep(300)
    await waitForScreenText(client, 'Transport: Not exposed', 'FR3 detail transport fact')
    client.send('p')
    await waitForScreenText(client, 'Probe passed', 'FR3 stdio probe result')
    assert(/1 tool/u.test((await client.viewport()).join('\n')), 'FR3: stdio probe must report the fixture tool')
    client.send('x')
    await waitForScreenText(client, `Restart ${SERVER_NAME}?`, 'FR3 restart confirmation')
    client.send('y')
    await waitForScreenText(client, 'Restart settled · awaiting connected status', 'FR3 restart settled notice')
    trace('fr3.stdio', { probe: 'PASS', restart: 'SETTLED' })

    // ROW 1 — streamable-http: real Probe AND one settled Restart.
    await selectRow(client, 1)
    await waitForScreenText(client, 'Server: fr3-http', 'FR3 HTTP detail')
    await waitForScreenText(client, 'State: Connected', 'FR3 HTTP connected')
    client.send('p')
    await waitForScreenText(client, 'Probe passed', 'FR3 HTTP probe result')
    client.send('x')
    await waitForScreenText(client, 'Restart fr3-http?', 'FR3 HTTP restart confirmation')
    client.send('y')
    await waitForScreenText(client, 'Restart settled · awaiting connected status', 'FR3 HTTP restart settled')
    trace('fr3.http', { probe: 'PASS', restart: 'SETTLED' })

    // ROW 2 — disabled entry is still probeable (official manager support).
    await selectRow(client, 2)
    await waitForScreenText(client, 'Server: fr3-disabled', 'FR3 disabled detail')
    await waitForScreenText(client, 'State: Disabled', 'FR3 disabled state')
    client.send('p')
    await waitForScreenText(client, 'Probe passed', 'FR3 disabled probe result')
    trace('fr3.disabled-probe', { passed: true })

    // ROW 3 — waiting-credentials: a real Host refusal, never a fake success.
    await selectRow(client, 3)
    await waitForScreenText(client, 'Server: fr3-credentials', 'FR3 credentials detail')
    await waitForScreenText(client, 'State: Waiting credentials', 'FR3 waiting-credentials state')
    client.send('p')
    await waitForScreenPattern(client, /Probe (refused|unavailable|failed)/u, 'FR3 credentials probe refusal')
    trace('fr3.waiting-credentials', { refused: true })

    // ROW 4 — a failing entry is its own state; it never becomes "no servers".
    await selectRow(client, 4)
    await waitForScreenText(client, 'Server: fr3-fail', 'FR3 failing detail')
    await waitForScreenPattern(client, /State: (Failed|Reconnect disabled)/u, 'FR3 failing state')
    client.send('p')
    await waitForScreenPattern(client, /Probe failed at/u, 'FR3 failing probe result')
    trace('fr3.failed-entry', { isolated: true })

    // ROW 5 — a reconnect budget of one gives up after the server drops.
    await selectRow(client, 5)
    await waitForScreenText(client, 'Server: fr3-giveup', 'FR3 give-up detail')
    await waitForScreenPattern(client, /State: Failed \(gave up\)/u, 'FR3 give-up state')
    trace('fr3.give-up', { observed: true })

    // ROW 6 — the plugin-registered server has NO settings key: it must be
    // Plugin-owned, never Configured.
    await selectRow(client, 6)
    await waitForScreenText(client, 'Server: fr3-plugin', 'FR3 plugin-owned detail')
    await waitForScreenText(client, 'Source: Plugin-owned', 'FR3 plugin-owned source')
    trace('fr3.plugin-owned', { classified: true })

    // Web on -> off keeps the SAME manager fiber (the Web toggle never owns
    // it). The toggle is the Host's own private service, driven by a Peer so
    // the assertion does not depend on the human Client's Settings state.
    await exitSettingsWorkspace(client, 'FR3')
    const beforeWeb = await mcpManagerRow(host, 'FR3 before Web')
    const peer = new context.EntryProcess('peer', context.entries.client, {
      ...context.base,
      env: { ...context.base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peerProcess = peer
    await peer.waitFor(record => record.m4a0 === 'ready', 'FR3 Web peer ready', 180_000)
    const enabled = await webAccess(peer, true, 'FR3 Web enabled', 1)
    assert(enabled?.state === 'enabled', `FR3: the Host did not reach Web enabled: ${JSON.stringify(enabled)}`)
    const duringWeb = await mcpManagerRow(host, 'FR3 during Web')
    assert(duringWeb.fiberUid === beforeWeb.fiberUid, 'FR3: enabling Web re-mounted the shared mcp-manager row')
    const disabled = await webAccess(peer, false, 'FR3 Web disabled', 2)
    assert(disabled?.state === 'disabled', `FR3: the Host did not reach Web disabled: ${JSON.stringify(disabled)}`)
    const afterWeb = await mcpManagerRow(host, 'FR3 after Web')
    assert(afterWeb.fiberUid === beforeWeb.fiberUid, 'FR3: Web off->on->off replaced the shared mcp-manager fiber')
    trace('fr3.web-identity', { fiberUid: beforeWeb.fiberUid, kept: true })
    await peer.shutdown()
    peerProcess = undefined

    client.send('/exit\r')
    await client.waitForExit(60_000)
    await client.dispose()
    client = undefined
    await scene.stopC1Host(host)
    host = undefined
    return { status: 'PASS' }
  } finally {
    if (peerProcess !== undefined && !peerProcess.exited) await peerProcess.shutdown().catch(() => {})
    if (httpServer !== undefined) await httpServer.close().catch(() => {})
    await scene.dispose()
  }
}
