/**
 * Session Workspace PR4 L5/L6: the REAL Host + REAL Split Client Workspace
 * failure recovery.
 *
 * TWO independent Sessionless `SurfaceEntryProcess` Clients, each on its own
 * `script(1)` PTY, with its own HOME/cwd that differs from the Host account.
 * The qualification-only `SPLIT_PROCESS_CLIENT_WORKSPACE_INTENT_PATH` override
 * (surface mode only) makes the Client propose a Host path that does NOT
 * exist, so the REAL generated Host `workspace/create` refuses the selection.
 *
 *   interaction.workspace-new-failure-recovery
 *     `/new` → the Host refuses the pre-create selection → the ONE Session
 *     Workspace Browser opens the FULL tree (never the inline Add editor) →
 *     Esc cancels only the UI → `/new` again → the root Add directory browses
 *     the Host home and registers a real Host directory through Verify → only
 *     that registration creates a Workspace, never a Session → the user
 *     explicitly activates the new Folder's `New session` → exactly one
 *     Session create/commit, WorkspaceId match, Browser collapse.
 *
 *   interaction.workspace-first-submit-failure-recovery
 *     a real PTY ordinary first prompt → the Host refuses the pre-create
 *     selection → the exact draft is restored and the existing inline Add
 *     editor opens prefilled with the refused proposal → the real draft stays
 *     in the editor across a successful Verify (no automatic resend) → a
 *     second deliberate Enter creates the ONE Session and writes the marker
 *     exactly once into the durable Host Session log.
 *
 * Both cases prove the refusal precedes any Session create (durable inventory
 * unchanged), the Client HOME/cwd never answers as a Host path, the same Host
 * PID and browse backend fiber survive, and no old Session was stopped (the
 * Clients are Sessionless). No private Host RPC or test-only UI shortcut is
 * used: every browser/editor action enters through the real PTY key stream.
 *
 * @module split-process/workspace-failure-recovery
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostStatus, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Every durable entry under the isolated Host Session store. */
function sessionInventory(dshHome) {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true }).map(entry => String(entry)).sort()
}

/** The durable Host Session LOG files (the ONE per-Session evidence). */
function sessionLogs(dshHome) {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true })
    .map(entry => String(entry))
    .filter(entry => entry.endsWith('.jsonl.zstd'))
    .sort()
}

/** One bounded wait for the durable Host Session log count. */
async function waitForSessionLogCount(dshHome, count, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const logs = sessionLogs(dshHome)
    if (logs.length === count) return logs
    if (Date.now() >= deadline) {
      throw new SplitSmokeAssertionError(`${label}: expected ${String(count)} durable Session log(s), found ${JSON.stringify(logs)}`)
    }
    await sleep(100)
  }
}

/** The decompressed text of every durable Host Session log. */
function sessionLogText(dshHome) {
  const root = join(dshHome, 'sessions')
  return sessionLogs(dshHome)
    .map(entry => zstdDecompressSync(readFileSync(join(root, entry))).toString('utf8'))
    .join('\n')
}

/** The durable `user/message` events of every Host Session log carrying `marker`. */
function userMessageMarkerEvents(dshHome, marker) {
  const root = join(dshHome, 'sessions')
  const found = []
  for (const entry of sessionLogs(dshHome)) {
    for (const line of zstdDecompressSync(readFileSync(join(root, entry))).toString('utf8').split('\n')) {
      if (line === '') continue
      const event = JSON.parse(line)
      if (event.type !== 'user/message') continue
      if (!JSON.stringify(event.data).includes(marker)) continue
      found.push({ log: entry, seq: event.seq })
    }
  }
  return found
}

/** Wait until the Host user-message event count for `marker` is `count`. */
async function waitForUserMessageMarker(dshHome, marker, count, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const events = userMessageMarkerEvents(dshHome, marker)
    if (events.length === count) return events
    if (Date.now() >= deadline) {
      throw new SplitSmokeAssertionError(`${label}: expected ${String(count)} Host user/message event(s) carrying the marker, found ${JSON.stringify(events)}`)
    }
    await sleep(100)
  }
}

/** One official Workspace follow baseline through the qualification probe. */
function workspaceBaselineReader(client, requestPath) {
  let sequence = 0
  return async label => {
    const nonce = `pr4-ws-${String(++sequence)}`
    writeFileSync(requestPath, JSON.stringify({ nonce, op: 'workspaces', windowMs: 5_000, maxFrames: 1 }), { mode: 0o600 })
    client.signalBusiness('SIGUSR2')
    const frame = await client.waitFor(record => record.m4b2s === 'qualification'
      && record.op === 'read-authority-proof'
      && record.nonce === nonce
      && record.phase === 'workspaces-frame',
    `${label} Workspace baseline`, 120_000)
    return (frame.items ?? []).map(item => ({
      workspaceId: String(item.workspaceId),
      path: typeof item.path === 'string' ? item.path : undefined,
      sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.map(String) : [],
    }))
  }
}

/** The official browse backend must be the ONE live row on the SAME fiber. */
function browseBackendRows(status) {
  return (status.entries ?? []).filter(entry =>
    entry.name === '@deepseek-ai/dsh-host-directory-picker-browse')
}

async function startRecoveryHost(scene, label) {
  const { host, ready } = await scene.startC1Host('directory-browse', label)
  const rows = browseBackendRows(ready)
  assert(rows.length === 1 && rows[0].state === 'active',
    `${label} the official browse backend row is ${JSON.stringify(rows.map(row => [row.id, row.state]))}, expected one ACTIVE row`)
  assert(typeof rows[0].fiberUid === 'number', `${label} the browse backend row carries no live fiber identity`)
  assert(ready.services?.workspaceController === true && ready.services?.typertGateway === true,
    `${label} the official Workspace Controller/Gateway services are not live`)
  return { host, ready, pickerFiberUid: rows[0].fiberUid }
}

async function assertHostKept(host, ready, pickerFiberUid, label) {
  const status = await hostStatus(host)
  assert(status.pid === ready.pid,
    `${label} the run replaced the Host identity (${String(status.pid)} != ${String(ready.pid)})`)
  const rows = browseBackendRows(status)
  assert(rows.length === 1 && rows[0].state === 'active',
    `${label} after the run the browse backend rows are ${JSON.stringify(rows.map(row => [row.id, row.state]))}`)
  assert(rows[0].fiberUid === pickerFiberUid, `${label} the browse backend row was remounted by the run`)
}

/** Run `/new` failure recovery (R1/R2) on ONE real Host and Sessionless Client. */
export async function runWorkspaceNewFailureRecovery(context) {
  const { workDir, dshHome, installation } = context
  const scene = createC1Scene(context)
  const { startC1Client, exitC1Client, dispose } = scene
  const requestPath = join(workDir, 'pr4-new-failure-request.json')
  const workspaceBaselineIds = client => workspaceBaselineReader(client, requestPath)
  const hostHome = installation.home
  const unique = `${String(process.pid)}-${Date.now().toString(36)}`
  const ownerName = `p4-new-${unique}`
  const clientHome = join(workDir, 'pr4-new-client-home')
  const clientCwd = join(workDir, 'pr4-new-client-cwd')
  const missingPath = join(workDir, `p4-new-missing-${unique}`)
  const recoverablePath = join(hostHome, ownerName)

  try {
    assert(!existsSync(missingPath), 'the injected refused Host path must not exist')
    mkdirSync(recoverablePath, { recursive: true, mode: 0o700 })
    mkdirSync(clientHome, { recursive: true, mode: 0o700 })
    mkdirSync(clientCwd, { recursive: true, mode: 0o700 })
    assert(realpathSync(clientHome) !== realpathSync(hostHome),
      'PR4 the Client and Host homes are the same directory; locality would not be provable')

    const { host, ready, pickerFiberUid } = await startRecoveryHost(scene, 'PR4-new')
    const { client, ready: clientReady } = await startC1Client('PR4 new recovery client', {
      SPLIT_PROCESS_CLIENT_READ_AUTHORITY_PROOF: requestPath,
      SPLIT_PROCESS_CLIENT_WORKSPACE_INTENT_PATH: missingPath,
      HOME: clientHome,
    }, { cwd: clientCwd })
    assert(clientReady.sessionOpen === false && clientReady.surfaceMounted === true,
      `PR4 the client is not a mounted Sessionless surface (${JSON.stringify({
        sessionOpen: clientReady.sessionOpen,
        surfaceMounted: clientReady.surfaceMounted,
      })})`)
    const readWorkspaces = workspaceBaselineIds(client)
    const sessionsBefore = sessionInventory(dshHome)
    const workspacesBefore = await readWorkspaces('PR4-new before')
    assert(!workspacesBefore.some(workspace => workspace.path !== undefined
      && existsSync(workspace.path)
      && realpathSync(workspace.path) === realpathSync(recoverablePath)),
    'PR4 the recoverable Host directory was registered before the user action')

    // ── The refused `/new` opens the FULL tree, never the Add editor ────────
    client.send('/new\r')
    await client.waitForScreen('Sessions ·', 'PR4-new full Workspace tree', 120_000)
    await client.waitForScreen('Add directory', 'PR4-new root Add row', 60_000)
    const refusedFrame = (await client.viewport()).join('\n')
    assert(!refusedFrame.includes('Host directory:'),
      `PR4 a /new recovery must not start in the inline Add editor:\n${refusedFrame}`)
    assert(JSON.stringify(sessionInventory(dshHome)) === JSON.stringify(sessionsBefore),
      'PR4 the refused /new created a Session')
    assert((await waitForSurfaceStatus(client, record => record.sessionOpen === false,
      'PR4-new Sessionless after the refusal', 30_000)).sessionOpen === false,
    'PR4 the refused /new opened a Session')

    // ── Esc cancels only the UI ─────────────────────────────────────────────
    client.send('\x1b')
    await client.waitForScreenGone('Sessions ·', 'PR4-new Esc closes only the Browser', 60_000)
    assert(JSON.stringify(sessionInventory(dshHome)) === JSON.stringify(sessionsBefore),
      'PR4 cancelling the recovery Browser created a Session')
    assert(await readWorkspaces('PR4-new after cancel').then(rows =>
      JSON.stringify(rows) === JSON.stringify(workspacesBefore)),
    'PR4 cancelling the recovery Browser changed the official Workspace baseline')

    // ── `/new` again, browse the Host home, Tab/Enter Register ──────────────
    client.send('/new\r')
    await client.waitForScreen('Sessions ·', 'PR4-new reopened full Workspace tree', 120_000)
    client.send('\x1b[H')
    await sleep(150)
    client.send('\r')
    await client.waitForScreen('Host directory:', 'PR4-new inline Host editor', 60_000)
    await client.waitForScreen(hostHome, 'PR4-new Host home prefill', 60_000)
    client.send(ownerName)
    await client.waitForScreen(`> ${ownerName}/`, 'PR4-new official Host marker candidate', 60_000)
    client.send('\t')
    await client.waitForScreen(`${ownerName}/`, 'PR4-new accepted Host path', 60_000)
    client.send('\r')
    await client.waitForScreen('Directory added:', 'PR4-new registered directory fact', 120_000)
    assert(JSON.stringify(sessionInventory(dshHome)) === JSON.stringify(sessionsBefore),
      'PR4 Add created a Session (it must only register the Workspace)')
    assert((await waitForSurfaceStatus(client, record => record.sessionOpen === false,
      'PR4-new Sessionless after Add', 30_000)).sessionOpen === false,
    'PR4 Add switched or created a Session')
    const afterAdd = await readWorkspaces('PR4-new after Add')
    const registered = afterAdd.filter(workspace => workspace.path !== undefined
      && existsSync(workspace.path)
      && realpathSync(workspace.path) === realpathSync(recoverablePath))
    assert(registered.length === 1,
      `PR4 the official Workspace follow does not list the verified Host directory: ${JSON.stringify(afterAdd)}`)
    const workspaceId = registered[0].workspaceId
    assert(workspacesBefore.every(workspace => afterAdd.some(next => next.workspaceId === workspace.workspaceId)),
      'PR4 Add removed an existing official Workspace')

    // ── Only the explicit Folder New creates the Session ────────────────────
    await client.waitForScreen('New session', 'PR4-new explicit New child row', 60_000)
    client.send('\x1b[H')
    await sleep(150)
    client.send('\x1b[B')
    await sleep(150)
    client.send('\x1b[C')
    await sleep(150)
    client.send('\r')
    const opened = await waitForSurfaceStatus(client,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string',
      'PR4-new one committed Session', 180_000)
    await client.waitForScreenGone('Sessions ·', 'PR4-new Browser collapses after commit', 60_000)
    const logs = await waitForSessionLogCount(dshHome, 1, 'PR4-new exactly one Session log')
    assert(logs.length === 1, 'PR4 the run created more than one Session')
    const afterCommit = await readWorkspaces('PR4-new after commit')
    const member = afterCommit.find(workspace => workspace.workspaceId === workspaceId)
    assert(member !== undefined && member.sessionIds.includes(opened.openSessionId),
      `PR4 the committed Session is not a member of the verified Workspace: ${JSON.stringify(afterCommit)}`)
    assert(JSON.stringify(sessionInventory(dshHome)) !== JSON.stringify(sessionsBefore),
      'PR4 the explicit Folder New created no durable Session')

    await exitC1Client(client, 'PR4 new recovery client')
    await assertHostKept(host, ready, pickerFiberUid, 'PR4-new')
    context.trace?.('pr4-workspace-new-failure-recovery', {
      refusalOpenedFullTree: true,
      cancelOnlyUi: true,
      addRegisteredOnly: true,
      workspaceId,
      sessionId: opened.openSessionId,
      sessionCreateCount: 1,
      tinySizeMatrix: 'NOT_RUN (split PTY fixture viewport is fixed at 100x30; owned by the VT + tmux lanes)',
    })
    return { status: 'PASS' }
  } finally {
    try { rmSync(recoverablePath, { recursive: true, force: true }) } catch { /* the isolated Host home is disposed with the scene */ }
    await dispose()
  }
}

/** Run the Sessionless first-submit failure recovery on ONE real Host + Client. */
export async function runWorkspaceFirstSubmitFailureRecovery(context) {
  const { workDir, dshHome, installation } = context
  const scene = createC1Scene(context)
  const { startC1Client, exitC1Client, dispose } = scene
  const requestPath = join(workDir, 'pr4-first-submit-request.json')
  const hostHome = installation.home
  const unique = `${String(process.pid)}-${Date.now().toString(36)}`
  const ownerName = `p4-first-${unique}`
  const clientHome = join(workDir, 'pr4-first-client-home')
  const clientCwd = join(workDir, 'pr4-first-client-cwd')
  const missingPath = join(workDir, `p4-first-missing-${unique}`)
  const recoverablePath = join(hostHome, ownerName)
  const marker = `p4-first-marker-${unique}`

  try {
    assert(!existsSync(missingPath), 'the injected refused Host path must not exist')
    mkdirSync(recoverablePath, { recursive: true, mode: 0o700 })
    mkdirSync(clientHome, { recursive: true, mode: 0o700 })
    mkdirSync(clientCwd, { recursive: true, mode: 0o700 })
    // A same-prefix CLIENT-ONLY directory: the Host candidate must never be the
    // Client filesystem, and the Host home answer must never include it.
    const clientOnlyName = `${ownerName}-client-only`
    mkdirSync(join(clientHome, clientOnlyName), { recursive: true, mode: 0o700 })

    const { host, ready, pickerFiberUid } = await startRecoveryHost(scene, 'PR4-first')
    const { client, ready: clientReady } = await startC1Client('PR4 first-submit client', {
      SPLIT_PROCESS_CLIENT_READ_AUTHORITY_PROOF: requestPath,
      SPLIT_PROCESS_CLIENT_WORKSPACE_INTENT_PATH: missingPath,
      HOME: clientHome,
    }, { cwd: clientCwd })
    assert(clientReady.sessionOpen === false && clientReady.surfaceMounted === true,
      `PR4 the client is not a mounted Sessionless surface (${JSON.stringify({
        sessionOpen: clientReady.sessionOpen,
        surfaceMounted: clientReady.surfaceMounted,
      })})`)
    const readWorkspaces = workspaceBaselineReader(client, requestPath)
    const sessionsBefore = sessionInventory(dshHome)
    const workspacesBefore = await readWorkspaces('PR4-first before')
    const prompt = `${marker} keep this draft`

    // ── Refused first submit: restore the exact draft, then the inline Add ──
    client.send(`${prompt}\r`)
    await client.waitForScreen('Host directory:', 'PR4-first inline Host editor after the restore', 120_000)
    const editorFrame = (await client.viewport()).join('\n')
    assert(editorFrame.includes(missingPath.slice(-24)), 'the refused Host proposal is prefilled for correction')
    assert(!editorFrame.includes(clientOnlyName), 'the Client-only directory leaked into the Host editor')
    assert(JSON.stringify(sessionInventory(dshHome)) === JSON.stringify(sessionsBefore),
      'the refused first submit created a Session')
    assert(sessionLogText(dshHome) === '', 'the refused first submit wrote a Host Session log')
    assert((await waitForSurfaceStatus(client, record => record.sessionOpen === false,
      'PR4-first Sessionless after the refusal', 30_000)).sessionOpen === false,
    'the refused first submit opened a Session')

    // ── Clear the refused proposal and complete the real Host directory ─────
    client.send('\x7f'.repeat(missingPath.length + 8))
    client.send(`${hostHome}/`)
    await client.waitForScreen(ownerName, 'PR4-first official Host home candidate list', 60_000)
    client.send(ownerName)
    await client.waitForScreen(`> ${ownerName}/`, 'PR4-first filtered official candidate', 60_000)
    client.send('\t')
    await client.waitForScreen(`${ownerName}/`, 'PR4-first accepted Host path', 60_000)
    client.send('\r')
    await client.waitForScreenGone('Sessions ·', 'PR4-first Verify returns to the Welcome', 120_000)
    await client.waitForScreen(marker, 'PR4-first restored draft stays in the editor', 60_000)
    assert(JSON.stringify(sessionInventory(dshHome)) === JSON.stringify(sessionsBefore),
      'Verify created a Session; it must only register the next-create Workspace')
    assert(sessionLogText(dshHome) === '', 'Verify wrote a Host Session log')
    assert(await readWorkspaces('PR4-first after Verify').then(rows => rows.some(workspace =>
      workspace.path !== undefined && existsSync(workspace.path)
      && realpathSync(workspace.path) === realpathSync(recoverablePath))),
    'Verify did not register the official Host Workspace')

    // ── The user must submit again: exactly one Session, marker once ────────
    client.send('\r')
    const opened = await waitForSurfaceStatus(client,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string',
      'PR4-first one committed Session', 180_000)
    await waitForSessionLogCount(dshHome, 1, 'PR4-first exactly one Session log')
    await waitForUserMessageMarker(dshHome, marker, 1, 'PR4-first Host user message written exactly once')
    const afterCommit = await readWorkspaces('PR4-first after commit')
    assert(afterCommit.some(workspace => workspace.sessionIds.includes(opened.openSessionId)),
      'the created Session is not a member of any official Workspace')
    assert(workspacesBefore.every(workspace => afterCommit.some(next => next.workspaceId === workspace.workspaceId)),
      'Verify removed an existing official Workspace')

    await exitC1Client(client, 'PR4 first-submit client')
    await assertHostKept(host, ready, pickerFiberUid, 'PR4-first')
    context.trace?.('pr4-workspace-first-submit-failure-recovery', {
      draftRestoredBeforeEditor: true,
      verifyRegisteredOnly: true,
      manualResubmitRequired: true,
      sessionId: opened.openSessionId,
      markerOccurrences: 1,
      sessionCreateCount: 1,
      tinySizeMatrix: 'NOT_RUN (split PTY fixture viewport is fixed at 100x30; owned by the VT + tmux lanes)',
    })
    return { status: 'PASS' }
  } finally {
    try { rmSync(recoverablePath, { recursive: true, force: true }) } catch { /* the isolated Host home is disposed with the scene */ }
    await dispose()
  }
}
