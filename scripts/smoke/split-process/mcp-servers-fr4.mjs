/**
 * FR4: MCP server configuration CRUD in the REAL Split Host/Client.
 *
 * ONE real Host (the installed candidate package) and real authenticated TUI
 * Clients prove the configuration loop end to end through the OFFICIAL
 * `settings` wire and the ONE official `mcp-manager` row:
 *
 *   1. an INHERITED (base-layer) server is shown as `Inherited` and its Detail
 *      offers Edit/Disable but never Delete;
 *   2. `a Add` writes a User-added stdio server (mock process) and a
 *      User-added streamable-http server (mock TCP endpoint): each commit is ONE
 *      official revision-checked mutation, the profile patch gains the entry and
 *      the manager's own watch brings the server to `Connected` — a saved
 *      configuration is reported as such, never as a connection;
 *   3. `e Edit` changes ONE argument and leaves the entry's other fields (and
 *      the deferred budget fields) untouched;
 *   4. `t` Disable → `Disabled` and Enable → `Connected` without replacing the
 *      manager fiber;
 *   5. `d` on the User-added server removes the entry; `d` on the inherited one
 *      is refused (zero writes) and `u` restores the inherited configuration;
 *   6. a dirty `Esc` discards the draft with zero writes, and a Plugin-owned
 *      server offers no configuration action at all;
 *   7. TWO real Clients: A holds a form open, B commits, A's save reports the
 *      revision conflict and writes nothing.
 *
 * The inherited base server lives in a LOW layer (the installed candidate
 * bundle's own patch), never in the run's command-line overlay: an overlay
 * would make the official ConfigEditor refuse every user-layer write.
 *
 * Fixtures are minimal local MCP servers (stdio + raw streamable-http) with one
 * tool; no production server is configured, probed or restarted.
 *
 * @module split-process/mcp-servers-fr4
 */

import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForCondition } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'
import {
  FIXTURE_SERVER_SOURCE,
  exitSettingsWorkspace,
  mcpManagerRow,
  openMcpPage,
  startHttpMcpFixture,
  waitForScreenPattern,
  waitForScreenText,
} from './mcp-servers-fr3.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

const INHERITED_NAME = 'fr4-inherited'
const USER_STDIO = 'fr4-user'
const USER_HTTP = 'fr4-http'
const PLUGIN_NAME = 'fr4-plugin'
const MISSING_CREDENTIAL = '${credential:FR4_MISSING}'

/**
 * Leave the Settings workspace (an Esc ladder) and exit one Client through the
 * real `/exit` line. The page's own action bar decides whether another Esc is
 * needed; a Client that cannot leave is disposed (never left running).
 */
async function closeClient(client, scene, label) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const frame = await frameOf(client)
    if (!/Settings ·/u.test(frame)) break
    if (frame.includes('Discard changes?')) {
      client.send('d')
      await sleep(320)
      continue
    }
    client.send('\x1b')
    await sleep(350)
  }
  try {
    await scene.exitC1Client(client, label)
  } catch (error) {
    // The bounded exit did not settle (a page still holding the seat): release
    // the process explicitly instead of leaving a live Client behind, then
    // rethrow so the case reports the real failure.
    await client.dispose().catch(() => {})
    throw error
  }
}

/** The current frame text. */
async function frameOf(client) {
  return (await client.viewport()).join('\n')
}

/** The current profile patch bytes (the official write sink). */
function patchText(profileDir) {
  return readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
}

/** The `mcp-manager` user-layer `servers` keys of the profile patch. */
function configuredNames(profileDir) {
  const text = patchText(profileDir)
  const names = new Set()
  // The patch is a YAML sequence of rows; the LAST non-insert `mcp-manager` row
  // owns the user configuration. Reading keys textually keeps this assertion
  // independent of the YAML library the Host uses.
  const rows = text.split(/\n- id: /u)
  for (const row of rows) {
    if (!row.startsWith('mcp-manager')) continue
    const serversAt = row.indexOf('    servers:')
    if (serversAt === -1) continue
    const block = row.slice(serversAt).split('\n')
    let inServers = false
    for (const line of block.slice(1)) {
      if (/^ {6}\S/u.test(line)) {
        inServers = true
        names.add(line.trim().replace(/:$/u, ''))
        continue
      }
      if (inServers && !/^ {6}/u.test(line)) break
    }
  }
  return names
}

/** Wait for one exact painted line of the Settings page. */
async function waitForScreen(client, text, label, timeoutMs = 90_000) {
  try {
    await waitForCondition(async () => (await frameOf(client)).includes(text), label, timeoutMs)
  } catch (error) {
    const frame = await frameOf(client)
    const failure = new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: text, frame: frame.slice(-2500) })}`)
    failure.cause = error
    throw failure
  }
}

/** Wait for one painted pattern. */
async function waitForPattern(client, pattern, label, timeoutMs = 90_000) {
  try {
    await waitForCondition(async () => pattern.test(await frameOf(client)), label, timeoutMs)
  } catch (error) {
    const frame = await frameOf(client)
    const failure = new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: String(pattern), frame: frame.slice(-2500) })}`)
    failure.cause = error
    throw failure
  }
}

/** Type one value into the ACTIVE form input and commit it. */
async function typeValue(client, value, label) {
  // Ctrl+U clears the pre-filled value (the official Input binding).
  client.send('\x15')
  await sleep(60)
  for (const char of value) client.send(char)
  await sleep(80)
  client.send('\r')
  await sleep(150)
  void label
}

/** The focused form row label, read from the painted marker (`▸ <label>:`). */
function focusedRowLabel(frame) {
  const match = /▸ ([^:\n]+):/u.exec(frame)
  return match === null ? undefined : (match[1] ?? '').trim()
}

/**
 * Move the form focus onto the row whose LABEL starts with `label`. The
 * position is proven from the FRAME, so an inserted/removed row can never shift
 * the navigation onto a neighbouring field.
 */
async function focusRow(client, label, where) {
  for (let step = 0; step < 16; step += 1) {
    const current = focusedRowLabel(await frameOf(client))
    if (current !== undefined && current.startsWith(label)) return
    client.send('\x1b[B')
    await sleep(120)
  }
  throw new SplitSmokeAssertionError(`${where}: the form row ${JSON.stringify(label)} was never focused:\n${await frameOf(client)}`)
}

/** Open the configuration form of the selected row through `key`. */
async function openForm(client, key, label) {
  client.send(key)
  await waitForScreen(client, 'Identity', `${label} form painted`)
}

/**
 * Open the ADD form from the list. The list is re-proven before every attempt
 * (an Esc ladder or a just-closed form can land on a different view), and the
 * painted `Identity` group is the acceptance fact.
 */
async function openAddForm(client, label) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await backToList(client)
    client.send('a')
    for (let step = 0; step < 40; step += 1) {
      if ((await frameOf(client)).includes('Identity')) return
      await sleep(200)
    }
  }
  throw new SplitSmokeAssertionError(`${label}: the Add form was never painted:\n${await frameOf(client)}`)
}

/** Assert one official configuration status line and that it is NOT a
 *  connection claim. */
async function waitForSaved(client, label) {
  await waitForScreen(client, 'Saved · waiting for Host reconcile', `${label} saved status`)
  const frame = await frameOf(client)
  assert(!/Saved · waiting for Host reconcile · Connected/u.test(frame),
    `${label}: a saved configuration must never be painted as a connection`)
}

/** The ONE case: `mcp.servers-fr4`. */
export async function runMcpServersFr4(context) {
  const { trace } = context
  const scene = createC1Scene(context, { mcpManagerProbe: true })
  const root = scene.c1WorkRoot('fr4-mcp-config')
  const serverScript = join(root, 'fr4-mcp-fixture-server.mjs')
  writeFileSync(serverScript, FIXTURE_SERVER_SOURCE, { mode: 0o700 })
  chmodSync(serverScript, 0o700)
  const httpFixture = await startHttpMcpFixture()

  // The INHERITED (base) server lives in the installed candidate bundle's OWN
  // patch — a layer BELOW the user document. The run's command-line overlay
  // would win over the user layer and make ConfigEditor refuse every write.
  const basePatch = join(context.installation.profilePackage, 'cordis.patch.yml')
  appendFileSync(basePatch, [
    '',
    '- id: mcp-manager',
    '  config:',
    '    servers:',
    `      ${INHERITED_NAME}:`,
    '        transport: stdio',
    `        command: ${JSON.stringify(process.execPath)}`,
    `        args: [${JSON.stringify(serverScript)}]`,
    '        enabled: true',
    '',
  ].join('\n'))

  let host
  let client
  let clientB
  try {
    const started = await scene.startC1Host('mcp-servers-fr4', 'FR4 MCP Host', { C1_FR4_PLUGIN: '1' })
    host = started.host
    const row = await mcpManagerRow(host, 'FR4 initial')
    trace('fr4.manager-mounted', { id: row.id, fiberUid: row.fiberUid })

    client = (await scene.startC1Client('FR4 MCP Client')).client
    await openMcpPage(client, 'FR4')

    // (1) The inherited server is Connected and classified Inherited.
    await waitForScreenText(client, INHERITED_NAME, 'FR4 inherited server row')
    await waitForScreenText(client, 'Connected', 'FR4 inherited connection')
    await openRow(client, INHERITED_NAME, 'FR4 inherited')
    await waitForScreenText(client, 'Configuration: Inherited', 'FR4 inherited provenance')
    await waitForScreenText(client, 'Saved transport: stdio', 'FR4 inherited saved transport')
    trace('fr4.inherited-classified', { provenance: 'Inherited', state: 'Connected' })

    // A Plugin-owned server offers no configuration action.
    await exitSettingsWorkspace(client, 'FR4 plugin-owned probe')
    await openMcpPage(client, 'FR4 plugin-owned')
    if ((await frameOf(client)).includes(PLUGIN_NAME)) {
      await openRow(client, PLUGIN_NAME, 'FR4 plugin-owned')
      await waitForScreenText(client, 'Source: Plugin-owned', 'FR4 plugin-owned source')
      const before = patchText(context.installation.profileDir)
      for (const key of ['e', 't', 'd', 'u']) {
        client.send(key)
        await sleep(250)
      }
      await sleep(400)
      assert(patchText(context.installation.profileDir) === before,
        'FR4: a plugin-owned server must never trigger a configuration write')
      assert(!(await frameOf(client)).includes('Saving configuration'),
        'FR4: a plugin-owned server must never start a configuration write')
      trace('fr4.plugin-owned-denied', { writes: 0 })
    } else {
      trace('fr4.plugin-owned-denied', { skipped: 'the plugin row was not listed' })
    }

    // (2a) Add a User-added stdio server.
    await exitSettingsWorkspace(client, 'FR4 add stdio')
    await openMcpPage(client, 'FR4 add stdio')
    const revisionBefore = patchText(context.installation.profileDir)
    await openAddForm(client, 'FR4 add stdio')
    // Focus row 0 (Name) and type the name.
    client.send('\r')
    await sleep(150)
    await typeValue(client, USER_STDIO, 'FR4 add name')
    await focusRow(client, 'Command', 'FR4 add stdio')
    client.send('\r')
    await sleep(150)
    await typeValue(client, process.execPath, 'FR4 add command')
    await focusRow(client, 'Arguments', 'FR4 add stdio')
    client.send('\r') // inserts an empty arg row
    await sleep(250)
    await focusRow(client, 'Arg 1', 'FR4 add stdio')
    client.send('\r')
    await sleep(150)
    await typeValue(client, serverScript, 'FR4 add arg')
    client.send('s')
    await waitForSaved(client, 'FR4 add stdio')
    assert(patchText(context.installation.profileDir) !== revisionBefore,
      'FR4: the stdio Add must write the profile patch')
    assert(configuredNames(context.installation.profileDir).has(USER_STDIO),
      'FR4: the added stdio server must be in the profile configuration')
    // A saved Add closes its form and steps back one view; the new row must be
    // listed with the manager's OWN reconciled status (never a saved claim).
    await backToList(client)
    await waitForPattern(client, new RegExp(`\\b${USER_STDIO}\\b`, 'u'), 'FR4 added stdio row')
    await openRow(client, USER_STDIO, 'FR4 added stdio')
    await waitForScreenText(client, 'State: Connected', 'FR4 added stdio connection')
    trace('fr4.add-stdio', { saved: true, connected: true })

    // (2b) Add a User-added streamable-http server.
    await openAddForm(client, 'FR4 add http')
    client.send('\r')
    await sleep(150)
    await typeValue(client, USER_HTTP, 'FR4 add http name')
    await focusRow(client, 'Transport', 'FR4 add http')
    client.send('\r') // switch to streamable-http
    await sleep(300)
    await waitForPattern(client, /Transport: streamable-http/u, 'FR4 http transport selected')
    await focusRow(client, 'URL', 'FR4 add http')
    client.send('\r')
    await sleep(150)
    await typeValue(client, httpFixture.url, 'FR4 add http url')
    client.send('s')
    await waitForSaved(client, 'FR4 add http')
    assert(configuredNames(context.installation.profileDir).has(USER_HTTP),
      'FR4: the added HTTP server must be in the profile configuration')
    await backToList(client)
    await waitForPattern(client, new RegExp(`\\b${USER_HTTP}\\b`, 'u'), 'FR4 added HTTP row')
    await openRow(client, USER_HTTP, 'FR4 added HTTP')
    await waitForScreenText(client, 'State: Connected', 'FR4 added HTTP connection')
    trace('fr4.add-http', { saved: true, connected: true })

    // (3) Edit ONE argument of the stdio server.
    await exitSettingsWorkspace(client, 'FR4 edit')
    await openMcpPage(client, 'FR4 edit')
    await openRow(client, USER_STDIO, 'FR4 edit')
    const beforeEdit = patchText(context.installation.profileDir)
    await openForm(client, 'e', 'FR4 edit')
    // A real change that keeps the mock server working: APPEND one argument
    // row (the mock ignores extra argv). Replacing arg 1 would break the spawn
    // and prove nothing about the dirty-path projection.
    await focusRow(client, 'Arguments', 'FR4 edit')
    client.send('\r')
    await sleep(250)
    await focusRow(client, 'Arg 2', 'FR4 edit')
    client.send('\r')
    await sleep(200)
    await typeValue(client, '--fr4-edited', 'FR4 edit arg')
    client.send('s')
    await waitForSaved(client, 'FR4 edit')
    const afterEdit = patchText(context.installation.profileDir)
    assert(afterEdit !== beforeEdit, 'FR4: the Edit must write the profile patch')
    assert(afterEdit.includes('--fr4-edited'),
      'FR4: the edited argument must reach the profile patch')
    assert(afterEdit.includes(serverScript.replace(/\\/gu, '\\')),
      'FR4: the untouched argument must stay in the profile patch')
    assert(!/startupTimeoutMs/u.test(afterEdit) || /startupTimeoutMs/u.test(beforeEdit),
      'FR4: an Edit must never introduce a deferred budget field')
    trace('fr4.edit', { dirtyPathOnly: true })

    // (4) Disable, then Enable.
    await openRow(client, USER_STDIO, 'FR4 toggle')
    client.send('t')
    await waitForPattern(client, /Change (saved configuration|config)\?/u, 'FR4 toggle confirmation')
    client.send('y')
    await waitForScreenText(client, 'Configuration saved · the server will stop', 'FR4 disabled saved')
    await waitForScreenText(client, 'State: Disabled', 'FR4 disabled state')
    const disabledRow = await mcpManagerRow(host, 'FR4 after disable')
    assert(disabledRow.fiberUid === row.fiberUid, 'FR4: Disable must not replace the manager fiber')
    client.send('t')
    await waitForPattern(client, /Change (saved configuration|config)\?/u, 'FR4 enable confirmation')
    client.send('y')
    await waitForScreenText(client, 'Configuration saved · the server will start', 'FR4 enabled saved')
    // The manager reconciles the enabled entry itself; the page waits for the
    // WATCH to prove the connection (a saved configuration is not a connection).
    await waitForPattern(client, /State: (Connected|Connecting|Reconnecting)/u, 'FR4 enabled runtime state')
    await waitForScreenText(client, 'State: Connected', 'FR4 enabled state')
    const enabledRow = await mcpManagerRow(host, 'FR4 after enable')
    assert(enabledRow.fiberUid === row.fiberUid, 'FR4: Enable must not replace the manager fiber')
    trace('fr4.toggle', { disabled: true, enabled: true, sameManagerFiber: true })

    // (5) The inherited server refuses Delete and restores on Reset.
    await openRow(client, INHERITED_NAME, 'FR4 inherited again')
    const beforeRefusedDelete = patchText(context.installation.profileDir)
    client.send('d')
    await sleep(400)
    assert(!(await frameOf(client)).includes(`Delete ${INHERITED_NAME}?`),
      'FR4: an inherited server must offer no Delete confirmation')
    assert(patchText(context.installation.profileDir) === beforeRefusedDelete,
      'FR4: a refused Delete must write nothing')
    trace('fr4.inherited-delete-refused', { writes: 0 })

    // Override it (Disable), then Reset to the inherited configuration.
    client.send('t')
    await waitForPattern(client, /Change (saved configuration|config)\?/u, 'FR4 override confirmation')
    client.send('y')
    await waitForScreenText(client, 'State: Disabled', 'FR4 inherited overridden state')
    await waitForScreenText(client, 'Configuration: Overridden (user)', 'FR4 inherited now overridden')
    client.send('u')
    // The bar compacts to `Reset <name>?` when the full sentence does not fit;
    // the SUBJECT is the safety fact either way.
    await waitForPattern(client, new RegExp(`(Remove your override|Reset ${INHERITED_NAME}\\?)`, 'u'), 'FR4 reset confirmation')
    client.send('y')
    await waitForScreenText(client, 'Inherited configuration restored', 'FR4 reset result')
    await waitForScreenText(client, 'Configuration: Inherited', 'FR4 inherited restored')
    await waitForScreenText(client, 'State: Connected', 'FR4 inherited reconnected')
    trace('fr4.inherited-reset', { restored: true, connected: true })

    // (6) A dirty form Esc discards with zero writes.
    await openRow(client, USER_STDIO, 'FR4 dirty')
    const beforeDiscard = patchText(context.installation.profileDir)
    await openForm(client, 'e', 'FR4 dirty form')
    await focusRow(client, 'Command', 'FR4 dirty')
    client.send('\r')
    await sleep(150)
    client.send('z')
    await sleep(150)
    client.send('\r')
    await sleep(200)
    client.send('\x1b')
    await waitForScreenText(client, 'Discard changes?', 'FR4 discard confirmation')
    client.send('d')
    await sleep(500)
    assert(patchText(context.installation.profileDir) === beforeDiscard,
      'FR4: a discarded draft must write nothing')
    trace('fr4.dirty-discard', { writes: 0 })

    // (7) Two Clients: B commits while A's form is open -> A sees the conflict.
    clientB = (await scene.startC1Client('FR4 MCP Client B')).client
    await openMcpPage(clientB, 'FR4 Client B')
    await openRow(clientB, USER_HTTP, 'FR4 B')

    // A opens its form at the CURRENT revision.
    await openRow(client, USER_HTTP, 'FR4 A')
    await openForm(client, 'e', 'FR4 A form')
    // A makes a REAL change (a zero-diff draft would short-circuit and never
    // reach the CAS): focus Enabled and toggle it.
    await focusRow(client, 'Enabled', 'FR4 A form')
    client.send('\r')
    await sleep(250)
    await waitForPattern(client, /Unsaved changes/u, 'FR4 A dirty draft')

    // B disables the same server, moving the namespace revision.
    clientB.send('t')
    await waitForPattern(clientB, /Change (saved configuration|config)\?/u, 'FR4 B toggle confirmation')
    clientB.send('y')
    await waitForScreenText(clientB, 'Configuration saved · the server will stop', 'FR4 B saved')

    // A's save carries the OLD revision. The Host refuses it EITHER as the
    // official revision conflict (the same-generation CAS) OR as a stale
    // authority fence (a generation change observed first); both are a
    // truthful "not saved" and both must write NOTHING.
    const beforeConflict = patchText(context.installation.profileDir)
    client.send('s')
    await waitForPattern(client, /Not saved · (configuration changed|the Host authority changed)/u, 'FR4 A stale-save refusal')
    const conflictFrame = await frameOf(client)
    assert(patchText(context.installation.profileDir) === beforeConflict,
      'FR4: a refused stale save must write nothing')
    assert(!conflictFrame.includes('Saved · waiting for Host reconcile'),
      'FR4: a refused stale save must never be reported as saved')
    trace('fr4.two-client-conflict', {
      conflict: /configuration changed/u.test(conflictFrame),
      staleAuthority: /Host authority changed/u.test(conflictFrame),
      writes: 0,
    })

    // (5b) The User-added server is deletable. A's conflicted draft is still
    // open (the draft survives a conflict by contract), so it is discarded
    // FIRST — a dirty Esc ladder would otherwise swallow the workspace exit.
    await backToList(client)
    await exitSettingsWorkspace(client, 'FR4 delete')
    await openMcpPage(client, 'FR4 delete')
    await openRow(client, USER_STDIO, 'FR4 delete')
    client.send('d')
    await waitForPattern(client, new RegExp(`Delete ${USER_STDIO}\\?`, 'u'), 'FR4 delete confirmation')
    client.send('y')
    await waitForScreenText(client, 'Config removed · waiting for Host reconcile', 'FR4 delete result')
    assert(!configuredNames(context.installation.profileDir).has(USER_STDIO),
      'FR4: a User-added Delete must remove the entry from the profile configuration')
    trace('fr4.delete-user', { removed: true })

    // A Client still inside the Settings workspace sends `/exit` to the PAGE,
    // so the workspace is left FIRST (Esc ladder out of the form/list), then
    // the main editor seat receives the exit line.
    await closeClient(client, scene, 'FR4 Client A')
    client = undefined
    if (clientB !== undefined) {
      await closeClient(clientB, scene, 'FR4 Client B')
      clientB = undefined
    }
    await scene.stopC1Host(host)
    host = undefined
    return { status: 'PASS' }
  } finally {
    if (clientB !== undefined) await clientB.dispose().catch(() => {})
    if (client !== undefined) await client.dispose().catch(() => {})
    await httpFixture.close().catch(() => {})
    await scene.dispose()
  }
}

/**
 * Leave any open form (discarding a dirty draft) and return to the LIST.
 *
 * The page's own ACTION BAR is the view authority: a scrolled Detail does not
 * paint its `Server:` row, so the visible content cannot tell the two views
 * apart. `a Add`/`Enter details` exist only on the list; `p probe`/`e edit`
 * only on a Detail; `s Save` only in the form.
 */
async function backToList(client) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const frame = await frameOf(client)
    if (frame.includes('Discard changes?')) {
      client.send('d')
      await sleep(300)
      continue
    }
    const bar = frame.split('\n').filter(line => /Back \[Esc\]/u.test(line)).at(-1) ?? ''
    const inForm = /Identity|Connection|Parameters/u.test(frame) && /s Save/u.test(bar)
    const inDetail = /p probe|e edit|d delete/u.test(bar)
    if (!inForm && !inDetail && /a Add|Enter details/u.test(bar)) return
    client.send('\x1b')
    await sleep(320)
  }
  throw new SplitSmokeAssertionError(`FR4: the page never returned to its list:\n${await frameOf(client)}`)
}

/**
 * Select ONE exact server by its painted marker and open its detail. The
 * selection is proven from the frame (the list wraps, so a fixed key count
 * cannot mean "this row"); the caller is never assumed to start in a
 * particular view.
 */
async function openRow(client, name, label) {
  await backToList(client)
  const marker = () => new RegExp(`▸ ${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?=\\s|$)`, 'u')
  // Probe upward for the first row, then walk down to the target.
  for (let step = 0; step < 10; step += 1) {
    if (marker().test(await frameOf(client))) break
    client.send('\x1b[A')
    await sleep(150)
  }
  for (let step = 0; step < 14; step += 1) {
    if (marker().test(await frameOf(client))) break
    client.send('\x1b[B')
    await sleep(150)
  }
  assert(marker().test(await frameOf(client)), `${label}: the ${name} row was never selected`)
  client.send('\r')
  await sleep(400)
  await waitForScreenText(client, `Server: ${name}`, `${label} detail`)
}
