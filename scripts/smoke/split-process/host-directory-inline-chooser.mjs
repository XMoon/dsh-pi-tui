/**
 * Session Workspace PR3 L5/L6: the REAL Host + REAL Split Client inline
 * Host-directory chooser.
 *
 * ONE real Host process and ONE real PiTUI `SurfaceEntryProcess` Client on its
 * own `script(1)` PTY. The Client is Sessionless, has a DIFFERENT HOME/cwd from
 * the Host, and opens the production `/sessions` Browser. Through real keys it
 * must:
 *
 *   PR3-A  open the root `Add directory` row, issue ONE `list(undefined)` and
 *          prefill the Host account's home (never the Client's).
 *   PR3-B  type a Host-only prefix, show the official Host child and NEVER the
 *          same-prefix Client-only directory.
 *   PR3-C  Tab through the official `entry.path` chain into a child level with
 *          ZERO Workspace registrations, Session creates or Agent stops.
 *   PR3-D  Enter verify the raw path through the ONE existing
 *          `resolveWorkspace` write, after which the official Workspace follow
 *          really lists the new Workspace. The Client stays Sessionless.
 *   PR3-E  a real transport drop (the qualification-only in-flight read) never
 *          lets the editor fall back to the Client filesystem; a later query on
 *          the new generation keeps reading the Host.
 *   PR3-F  Esc returns to the Welcome, `/exit` stops the Client cleanly and the
 *          Host keeps ONE browse backend row.
 *
 * The tiny-size matrix is NOT_RUN in this PTY fixture (its viewport is fixed at
 * 100x30); it is owned by the VirtualTerminal frame suite and the real tmux
 * lane. No private Host RPC and no test-only UI shortcut is used: every editor
 * action enters through the real PTY key stream.
 *
 * @module split-process/host-directory-inline-chooser
 */

import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostStatus, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** Every durable entry under the isolated Host Session store. */
function sessionInventory(dshHome) {
  const root = join(dshHome, 'sessions')
  try {
    return readdirSync(root, { recursive: true }).map(entry => String(entry)).sort()
  } catch {
    return []
  }
}

/** Run the PR3 inline Host-directory chooser qualification. */
export async function runHostDirectoryInlineChooser(context) {
  const { workDir, dshHome, installation } = context
  const scene = createC1Scene(context)
  const { startC1Host, startC1Client, exitC1Client, dispose } = scene
  const requestPath = join(workDir, 'pr3-inline-chooser-request.json')
  let probeSequence = 0
  const hostHome = installation.home
  const unique = `${String(process.pid)}-${Date.now().toString(36)}`
  const markerName = `p3-${unique}`
  const childName = 'child'
  const clientOnlyName = `${markerName}-client-only`

  try {
    // ── Host-only fixture: marker/child live ONLY under the Host account ────
    const markerPath = join(hostHome, markerName)
    const childPath = join(markerPath, childName)
    mkdirSync(childPath, { recursive: true, mode: 0o700 })
    mkdirSync(join(markerPath, '.hidden-child'), { recursive: true, mode: 0o700 })

    // ── Client-local HOME/cwd: a same-prefix directory the Host cannot know ──
    const clientHome = join(workDir, 'pr3-client-home')
    const clientCwd = join(workDir, 'pr3-client-cwd')
    mkdirSync(clientHome, { recursive: true, mode: 0o700 })
    mkdirSync(clientCwd, { recursive: true, mode: 0o700 })
    mkdirSync(join(clientHome, clientOnlyName), { recursive: true, mode: 0o700 })
    const clientHomeReal = realpathSync(clientHome)
    const hostHomeReal = realpathSync(hostHome)
    assert(clientHomeReal !== hostHomeReal,
      'PR3 the Client and Host homes are the same directory; locality would not be provable')

    const { host, ready } = await startC1Host('directory-browse', 'PR3')
    const backendRows = (ready.entries ?? []).filter(entry =>
      entry.name === '@deepseek-ai/dsh-host-directory-picker-browse')
    assert(backendRows.length === 1 && backendRows[0].state === 'active',
      `PR3 the official browse backend row is ${JSON.stringify(backendRows.map(row => [row.id, row.state]))}, expected one ACTIVE row`)
    assert(ready.services?.workspaceController === true && ready.services?.typertGateway === true,
      'PR3 the official Workspace Controller/Gateway services are not live')
    const pickerFiberUid = backendRows[0].fiberUid
    assert(typeof pickerFiberUid === 'number', 'PR3 the browse backend row carries no live fiber identity')

    const { client, ready: clientReady } = await startC1Client('PR3 inline chooser client', {
      SPLIT_PROCESS_CLIENT_READ_AUTHORITY_PROOF: requestPath,
      HOME: clientHome,
    }, { cwd: clientCwd })
    assert(clientReady.sessionOpen === false && clientReady.surfaceMounted === true,
      `PR3 the client is not a mounted Sessionless surface (${JSON.stringify({
        sessionOpen: clientReady.sessionOpen,
        surfaceMounted: clientReady.surfaceMounted,
      })})`)

    /** ONE correlated read-authority probe request on this REAL surface. */
    const probe = async (request, label, timeoutMs = 120_000) => {
      const nonce = `pr3-${String(++probeSequence)}`
      writeFileSync(requestPath, JSON.stringify({ nonce, op: 'directory-browse', ...request }), { mode: 0o600 })
      client.signalBusiness('SIGUSR2')
      return await client.waitFor(record => record.m4b2s === 'qualification'
        && record.op === 'read-authority-proof'
        && record.nonce === nonce
        && (record.phase === 'directory-browse' || record.phase === 'directory-browse-rejected'),
      `${label} probe record`, timeoutMs)
    }

    /** The official Workspace identities through the ONE follow read. */
    const workspaceBaselineIds = async label => {
      const nonce = `pr3-ws-${String(++probeSequence)}`
      writeFileSync(requestPath, JSON.stringify({
        nonce,
        op: 'workspaces',
        windowMs: 5_000,
        maxFrames: 1,
      }), { mode: 0o600 })
      client.signalBusiness('SIGUSR2')
      const frame = await client.waitFor(record => record.m4b2s === 'qualification'
        && record.op === 'read-authority-proof'
        && record.nonce === nonce
        && record.phase === 'workspaces-frame',
      `${label} Workspace baseline`, 120_000)
      return (frame.items ?? []).map(item => ({
        workspaceId: String(item.workspaceId),
        path: typeof item.path === 'string' ? item.path : undefined,
      })).sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
    }

    const sessionsBefore = sessionInventory(dshHome)
    const workspacesBefore = await workspaceBaselineIds('PR3 before')

    // ── PR3-A: `/sessions` → Home → Enter opens the inline Add editor ───────
    client.send('/sessions\r')
    await client.waitForScreen('Sessions ·', 'PR3 Session Workspace frame', 60_000)
    await client.waitForScreen('Add directory', 'PR3 root Add row', 60_000)
    client.send('\x1b[H')
    await new Promise(resolve => setTimeout(resolve, 120))
    client.send('\r')
    await client.waitForScreen('Host directory:', 'PR3 inline Host editor', 60_000)
    // The official Host HOME must arrive from `list(undefined)`; the Client
    // process has its own HOME and that directory must never be prefilled.
    await client.waitForScreen(hostHome, 'PR3 Host home prefill', 60_000)
    const opened = (await client.viewport()).join('\n')
    assert(!opened.includes(clientOnlyName),
      `PR3 the Client-only directory leaked into the Host suggestion frame:\n${opened}`)

    // ── PR3-B: type the Host-only prefix; the Client-only twin stays out ────
    client.send(markerName)
    await client.waitForScreen(`> ${markerName}/`, 'PR3 official Host marker candidate', 60_000)
    const filtered = (await client.viewport()).join('\n')
    assert(!filtered.includes(clientOnlyName),
      `PR3 the Client-only same-prefix directory appeared in the Host candidates:\n${filtered}`)
    assert(!filtered.includes('.hidden-child'),
      'PR3 the hidden child belongs to the NEXT level and must not appear yet')

    // ── PR3-C: Tab completes the official path with ZERO writes ─────────────
    const sessionsBeforeTabs = sessionInventory(dshHome)
    const workspacesBeforeTabs = await workspaceBaselineIds('PR3 before Tab')
    client.send('\t')
    await client.waitForScreen('child/', 'PR3 next level candidate', 60_000)
    client.send('child')
    await client.waitForScreen('> child/', 'PR3 filtered child candidate', 60_000)
    client.send('\t')
    await client.waitForScreen(`/${markerName}/${childName}/`, 'PR3 accepted child path', 60_000)
    const afterTabs = await workspaceBaselineIds('PR3 after Tab')
    assert(JSON.stringify(afterTabs) === JSON.stringify(workspacesBeforeTabs),
      `PR3 Tab completion changed the official Workspace baseline (${JSON.stringify(workspacesBeforeTabs)} -> ${JSON.stringify(afterTabs)})`)
    assert(JSON.stringify(sessionInventory(dshHome)) === JSON.stringify(sessionsBeforeTabs),
      'PR3 Tab completion changed the durable Host Session inventory')
    const statusAfterTabs = await waitForSurfaceStatus(client,
      record => record.sessionOpen === false, 'PR3 Sessionless after Tab', 30_000)
    assert(statusAfterTabs.sessionOpen === false, 'PR3 Tab opened or created a Session')

    // ── PR3-E: a real transport drop never falls back to the Client FS ──────
    const dropRecord = await probe({ path: markerPath, abort: 'drop' }, 'PR3 drop during the editor read')
    assert(dropRecord.phase === 'directory-browse-rejected' && dropRecord.rejected === true,
      `PR3 the dropped qualification read delivered ${JSON.stringify(dropRecord)}`)
    await waitForSurfaceStatus(client,
      record => typeof record.generationId === 'number'
        && record.generationId !== dropRecord.generationAtDispatch,
      'PR3 connection generation rollover', 120_000)
    client.send('\x7f')
    await client.waitForScreen('> child/', 'PR3 Host child after the new generation')
    const afterDrop = (await client.viewport()).join('\n')
    assert(!afterDrop.includes(clientOnlyName),
      `PR3 the post-drop frame fell back to the Client filesystem:\n${afterDrop}`)

    // ── PR3-D: Enter verifies the raw Host path through the ONE write ───────
    client.send('\r')
    await client.waitForScreen('Directory added:', 'PR3 registered directory fact', 120_000)
    const registered = await workspaceBaselineIds('PR3 after verify')
    const expectedPath = realpathSync(childPath)
    const newWorkspaces = registered.filter(workspace =>
      workspace.path !== undefined && realpathSync(workspace.path) === expectedPath)
    assert(newWorkspaces.length === 1,
      `PR3 the official Workspace follow does not list the verified Host directory ${expectedPath}: ${JSON.stringify(registered)}`)
    assert(newWorkspaces[0].workspaceId !== undefined, 'PR3 the new Workspace row carries no official id')
    assert(JSON.stringify(sessionInventory(dshHome)) === JSON.stringify(sessionsBefore),
      'PR3 Add created a Session (it is not New)')
    const afterRegisterStatus = await waitForSurfaceStatus(client,
      record => record.sessionOpen === false, 'PR3 Sessionless after Add', 30_000)
    assert(afterRegisterStatus.sessionOpen === false, 'PR3 verifying the directory switched Session')
    assert(workspacesBefore.every(workspace => registered.some(next => next.workspaceId === workspace.workspaceId)),
      'PR3 the Add removed an existing official Workspace')

    // ── PR3-F: Esc returns to Welcome; the Client exits cleanly ─────────────
    client.send('\x1b')
    await client.waitForScreenGone('Sessions ·', 'PR3 Browser closes back to the Welcome', 60_000)
    const welcome = (await client.viewport()).join('\n')
    // The Welcome legitimately states the confirmed next-create directory in
    // its own card; the EDITOR's suggestion block and its Esc verb must be gone.
    assert(!welcome.includes('Suggestions (Host)') && !welcome.includes('Esc cancel'),
      `PR3 the inline editor survived the Browser close:\n${welcome}`)
    assert(welcome.includes(realpathSync(childPath)),
      `PR3 the Welcome does not state the verified next-create directory:\n${welcome}`)
    await exitC1Client(client, 'PR3 inline chooser client')

    const status = await hostStatus(host)
    const pickerRows = (status.entries ?? []).filter(entry =>
      entry.name === '@deepseek-ai/dsh-host-directory-picker-browse')
    assert(pickerRows.length === 1 && pickerRows[0].state === 'active',
      `PR3 after the run the browse backend rows are ${JSON.stringify(pickerRows.map(row => [row.id, row.state]))}`)
    assert(pickerRows[0].fiberUid === pickerFiberUid,
      'PR3 the browse backend row was remounted by the editor reads')
    assert(status.pid === ready.pid,
      `PR3 the run replaced the Host identity (${String(status.pid)} != ${String(ready.pid)})`)

    context.trace?.('pr3-host-directory-inline-chooser', {
      hostHome: 'Host-owned',
      hostOnlyMarker: markerName,
      clientOnlyExcluded: true,
      officialPathChain: true,
      tabsRegisteredNothing: true,
      dropNeverFellBackToClient: true,
      verifiedWorkspaceId: newWorkspaces[0].workspaceId,
      sessionlessAfterAdd: true,
      browserClosedWithEsc: true,
      tinySizeMatrix: 'NOT_RUN (split PTY fixture viewport is fixed at 100x30; owned by VT + tmux lanes)',
    })
    return { status: 'PASS' }
  } finally {
    try { rmSync(join(hostHome, markerName), { recursive: true, force: true }) } catch { /* the temp home is disposed with the scene */ }
    await dispose()
  }
}
