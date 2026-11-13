/**
 * Session Workspace PR1 L5: the REAL Host / REAL Split Client directory-browse
 * qualification.
 *
 * This case proves the ONE read-only `HostDirectoryBrowsePort` in the installed
 * split composition, through the production Remote `directoryPicker/list`
 * generated namespace:
 *
 *   PR1-A  `list(undefined)` returns the Host account's OWN home and a
 *          Host-created marker directory under it.
 *   PR1-B  an explicit Host absolute path lists exactly that level's child
 *          directories (hidden flagged, files excluded), verbatim.
 *   PR1-C  the read happens in a real Split Client with NO Session: the
 *          surface reports no open Session and the durable Session inventory
 *          never changes.
 *   PR1-D  a directory that exists only in the Client launch directory never
 *          enters the Host home listing.
 *   PR1-E  a caller abort after dispatch is a rejection and never a ready
 *          listing; a physical mux drop during a read never produces a
 *          fabricated listing, and the Host stays alive with the same ONE
 *          browse backend row.
 *   PR1-H  opening the official Workspace follow baseline before and after the
 *          reads reports the same Workspace identities (no `workspace.create`).
 *
 * Every fact comes from the mounted Backend port through the qualification-only
 * read-authority probe (`SPLIT_PROCESS_CLIENT_READ_AUTHORITY_PROOF`), never a
 * private RPC or a second Client. No Host fixture service is created.
 *
 * @module split-process/host-directory-browse
 */

import { deepEqual } from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
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
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true }).map(entry => String(entry)).sort()
}

/** The plain names of a listing's child rows. */
function namesOf(listing) {
  return listing.entries.map(entry => entry.name)
}

/** Run the PR1 directory-browse qualification on this installation. */
export async function runHostDirectoryBrowse(context) {
  const { workDir, dshHome, installation } = context
  const scene = createC1Scene(context)
  const { startC1Host, startC1Client, exitC1Client, dispose } = scene
  const requestPath = join(workDir, 'pr1-directory-browse-request.json')
  let probeSequence = 0
  const hostHome = installation.home
  const unique = `${String(process.pid)}-${Date.now().toString(36)}`
  const markerName = `pi-tui-pr1-host-proof-${unique}`
  const clientOnlyName = `pi-tui-pr1-client-only-${unique}`

  try {
    // ── The Host-only preset: a directory that exists ONLY on the Host ───────
    const markerPath = join(hostHome, markerName)
    mkdirSync(join(markerPath, 'alpha'), { recursive: true, mode: 0o700 })
    mkdirSync(join(markerPath, '.hidden-child'), { recursive: true, mode: 0o700 })
    writeFileSync(join(markerPath, 'not-a-directory.txt'), 'pr1\n', { mode: 0o600 })
    // ── The CLIENT-LOCAL home: a directory the Host home cannot know. The
    // Client process runs with its own HOME, so an implementation that ever
    // read the Client filesystem/homedir instead of the Host would surface this
    // name (and lose the Host marker).
    const clientHome = join(workDir, 'pr1-client-home')
    const clientCwd = join(workDir, 'pr1-client-cwd')
    mkdirSync(clientHome, { recursive: true, mode: 0o700 })
    mkdirSync(clientCwd, { recursive: true, mode: 0o700 })
    mkdirSync(join(clientHome, clientOnlyName), { recursive: true, mode: 0o700 })
    assert(realpathSync(clientHome) !== realpathSync(hostHome),
      'PR1 the Client and Host homes are the same directory; locality would not be provable')

    const { host, ready } = await startC1Host('directory-browse', 'PR1')
    const backendRows = (ready.entries ?? []).filter(entry =>
      entry.name === '@deepseek-ai/dsh-host-directory-picker-browse')
    assert(backendRows.length === 1 && backendRows[0].state === 'active',
      `PR1 the official browse backend row is ${JSON.stringify(backendRows.map(row => [row.id, row.state]))}, expected one ACTIVE row`)
    assert(backendRows[0].id === 'directory-picker', `PR1 the browse backend row id is ${String(backendRows[0].id)}`)
    assert(ready.ownerEntries?.directoryPicker?.length === 1
      && ready.ownerEntries.directoryPicker[0] === 'directory-picker',
    `PR1 the directory-picker owner count is ${JSON.stringify(ready.ownerEntries?.directoryPicker)}`)
    assert(ready.ownerEntries?.workspaceController?.length === 1,
      'PR1 the ONE official Workspace Controller row is not the sole controller owner')
    assert(ready.ownerEntries?.workspaceRegistry?.length === 1,
      'PR1 the ONE official Workspace registry row is not the sole registry owner')
    assert(ready.services?.directoryPickerController === true,
      'PR1 the Workspace Controller child directory-picker handler is not live')
    assert(ready.services?.typertGateway === true && ready.services?.workspaceController === true,
      'PR1 the official Gateway/Workspace Controller services are not live')
    const pickerFiberUid = backendRows[0].fiberUid
    assert(typeof pickerFiberUid === 'number', 'PR1 the ACTIVE browse backend row carries no live fiber identity')

    const { client, ready: clientReady } = await startC1Client('PR1 read client', {
      SPLIT_PROCESS_CLIENT_READ_AUTHORITY_PROOF: requestPath,
      // A DISTINCT Client-local HOME: the Host home stays the isolated Host
      // account, so a Client filesystem/homedir read cannot masquerade as the
      // Host answer.
      HOME: clientHome,
    }, { cwd: clientCwd })
    assert(clientReady.sessionOpen === false && clientReady.surfaceMounted === true,
      `PR1 the read client is not a mounted Sessionless surface (${JSON.stringify({
        sessionOpen: clientReady.sessionOpen,
        surfaceMounted: clientReady.surfaceMounted,
      })})`)

    /** ONE correlated read-authority probe request on this REAL surface. */
    const probe = async (request, label, timeoutMs = 120_000) => {
      const nonce = `pr1-${String(++probeSequence)}`
      writeFileSync(requestPath, JSON.stringify({ nonce, op: 'directory-browse', ...request }), { mode: 0o600 })
      client.signalBusiness('SIGUSR2')
      return await client.waitFor(record => record.m4b2s === 'qualification'
        && record.op === 'read-authority-proof'
        && record.nonce === nonce
        && (record.phase === 'directory-browse' || record.phase === 'directory-browse-rejected'),
      `${label} probe record`, timeoutMs)
    }

    /** ONE official Workspace follow baseline on the SAME Sessionless Client. */
    const workspaceBaselineIds = async label => {
      const nonce = `pr1-ws-${String(++probeSequence)}`
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
      return (frame.items ?? []).map(item => String(item.workspaceId)).sort()
    }

    const sessionsBefore = sessionInventory(dshHome)
    // The surface's OWN mount preflight may still be adopting its launch
    // directory as a Host Workspace; a baseline taken mid-adoption would
    // attribute that legitimate mount write to the browse reads. Take a
    // baseline that is STABLE across three consecutive reads.
    let workspacesBefore = await workspaceBaselineIds('PR1 before')
    for (let settle = 0; settle < 30; settle += 1) {
      await new Promise(resolve => setTimeout(resolve, 150))
      const next = await workspaceBaselineIds(`PR1 before settle ${String(settle)}`)
      if (JSON.stringify(next) === JSON.stringify(workspacesBefore)) {
        if (settle >= 2) break
      } else {
        workspacesBefore = next
      }
    }

    // ── PR1-A: the Host home, with the Host-only marker directory ───────────
    const home = await probe({}, 'PR1 Host home')
    assert(home.phase === 'directory-browse', `PR1 the Host home read was rejected: ${JSON.stringify(home)}`)
    assert(home.outcome.kind === 'ready', `PR1 the Host home read is ${JSON.stringify(home.outcome)}`)
    const homeListing = home.outcome
    assert(realpathSync(homeListing.home) === realpathSync(hostHome),
      `PR1 listing.home is ${homeListing.home}, expected the isolated Host home ${hostHome}`)
    assert(realpathSync(homeListing.path) === realpathSync(hostHome),
      `PR1 list(undefined) listed ${homeListing.path}, expected the Host home`)
    assert(namesOf(homeListing).includes(markerName),
      `PR1 the Host home listing does not include ${markerName}: ${JSON.stringify(namesOf(homeListing))}`)
    assert(!namesOf(homeListing).includes(clientOnlyName),
      `PR1 the Client-local home entry ${clientOnlyName} leaked into the Host home listing`)
    assert(home.sessionOpen === false && home.openSessionId === null,
      `PR1 the read ran inside an open Session: ${JSON.stringify({
        sessionOpen: home.sessionOpen,
        openSessionId: home.openSessionId,
      })}`)
    assert(typeof home.generationAtDispatch === 'number'
      && home.generationAtDispatch === home.generationAtDelivery,
    `PR1 the home read crossed a connection generation (${String(home.generationAtDispatch)} -> ${String(home.generationAtDelivery)})`)
    assert(Array.isArray(homeListing.crumbs) && homeListing.crumbs.length > 0,
      'PR1 the official listing carries no ancestry crumbs')

    // ── PR1-B: an explicit Host absolute path, verbatim ─────────────────────
    const explicit = await probe({ path: markerPath }, 'PR1 explicit Host path')
    assert(explicit.phase === 'directory-browse' && explicit.outcome.kind === 'ready',
      `PR1 the explicit Host path read is ${JSON.stringify(explicit.outcome ?? explicit)}`)
    const explicitListing = explicit.outcome
    assert(typeof explicit.generationAtDispatch === 'number'
      && explicit.generationAtDispatch === explicit.generationAtDelivery,
    'PR1 the explicit path read crossed a connection generation')
    assert(realpathSync(explicitListing.path) === realpathSync(markerPath),
      `PR1 the explicit path read listed ${explicitListing.path}, expected ${markerPath}`)
    deepEqual(namesOf(explicitListing).sort(), ['.hidden-child', 'alpha'],
      `PR1 the explicit level rows are ${JSON.stringify(namesOf(explicitListing))}, expected only its child directories`)
    const hiddenRow = explicitListing.entries.find(entry => entry.name === '.hidden-child')
    const plainRow = explicitListing.entries.find(entry => entry.name === 'alpha')
    assert(hiddenRow?.hidden === true && plainRow?.hidden === false,
      'PR1 the official hidden flags are not preserved')
    assert(explicitListing.truncated === false,
      'PR1 a two-entry level reported truncated')
    assert(namesOf(explicitListing).every(name => name !== 'not-a-directory.txt'),
      'PR1 the file row entered a directory-only listing')

    // ── PR1-F: the REAL Host refusal stays a path failure, not unavailable ──
    const missingPath = join(hostHome, `pi-tui-pr1-missing-${unique}`)
    const missing = await probe({ path: missingPath }, 'PR1 missing Host path')
    assert(missing.phase === 'directory-browse' && missing.outcome.kind === 'failed',
      `PR1 a missing Host path produced ${JSON.stringify(missing.outcome ?? missing)}`)
    assert(missing.outcome.code === 'directory-picker/unreadable',
      `PR1 a missing Host path carries ${String(missing.outcome.code)}`)
    const relative = await probe({ path: `pi-tui-pr1-relative-${unique}` }, 'PR1 relative Host path')
    assert(relative.phase === 'directory-browse' && relative.outcome.kind === 'failed',
      `PR1 a relative path produced ${JSON.stringify(relative.outcome ?? relative)}`)
    assert(relative.outcome.code === 'directory-picker/unreadable',
      `PR1 a relative path carries ${String(relative.outcome.code)}`)

    // ── PR1-E1: a caller abort after dispatch never yields a ready listing ──
    const aborted = await probe({ path: markerPath, abort: true }, 'PR1 abort after dispatch')
    assert(aborted.phase === 'directory-browse-rejected' && aborted.rejected === true,
      `PR1 an aborted read delivered ${JSON.stringify(aborted)}`)
    assert(aborted.errorName === 'AbortError',
      `PR1 the aborted read failed as ${String(aborted.errorName)}, expected AbortError`)

    // ── PR1-E2: a provably in-flight read across a physical mux drop ────────
    //
    // The probe creates the read and drops the mux socket SYNCHRONOUSLY in the
    // same task, so no RPC response can have been delivered yet: the request is
    // in flight when its Connection generation is replaced. Such a read must
    // never deliver a ready listing (its content being correct is irrelevant),
    // and the replacement must be visible in the recorded generations.
    assert(typeof home.generationAtDispatch === 'number', 'PR1 the Client reported no official transport generation')
    const dropRecord = await probe({ path: markerPath, abort: 'drop' }, 'PR1 drop during read')
    assert(dropRecord.phase === 'directory-browse-rejected' && dropRecord.rejected === true,
      `PR1 a read provably in flight at the mux drop delivered ${JSON.stringify(dropRecord)}`)
    assert(['SupersededReadError', 'AbortError', 'RemoteError'].includes(dropRecord.errorName),
      `PR1 a dropped read failed as ${String(dropRecord.errorName)}, expected supersession/cancellation/carrier failure`)
    assert(dropRecord.outcome === undefined, 'PR1 a dropped read emitted a listing outcome')
    // The SAME Client must observe the official generation rollover and keep
    // reading the SAME Host afterwards, on the NEW generation.
    await waitForSurfaceStatus(client,
      record => typeof record.generationId === 'number'
        && record.generationId !== dropRecord.generationAtDispatch,
      'PR1 connection generation rollover', 120_000)
    const afterDrop = await probe({}, 'PR1 read after rollover')
    assert(afterDrop.phase === 'directory-browse' && afterDrop.outcome.kind === 'ready',
      `PR1 the post-rollover read is ${JSON.stringify(afterDrop.outcome ?? afterDrop)}`)
    assert(namesOf(afterDrop.outcome).includes(markerName),
      'PR1 the post-rollover read lost the Host home marker directory')
    assert(typeof afterDrop.generationAtDispatch === 'number'
      && afterDrop.generationAtDispatch !== dropRecord.generationAtDispatch,
    `PR1 the stale request did not cross a replaced generation (${String(dropRecord.generationAtDispatch)} -> ${String(afterDrop.generationAtDispatch)})`)
    assert(afterDrop.generationAtDispatch === afterDrop.generationAtDelivery,
      'PR1 the post-rollover read was delivered on a different generation than it started on')

    // ── PR1-C/H: no Session, no Workspace, no second browse backend ─────────
    const sessionsAfter = sessionInventory(dshHome)
    deepEqual(sessionsAfter, sessionsBefore,
      'PR1 the directory reads changed the durable Host Session inventory')
    const workspacesAfter = await workspaceBaselineIds('PR1 after')
    const addedWorkspaces = workspacesAfter.filter(workspace =>
      !workspacesBefore.some(before => before.workspaceId === workspace.workspaceId))
    const removedWorkspaces = workspacesBefore.filter(before =>
      !workspacesAfter.some(workspace => workspace.workspaceId === before.workspaceId))
    deepEqual(removedWorkspaces, [],
      `PR1 the directory reads REMOVED a Host Workspace: ${JSON.stringify(removedWorkspaces)}`)
    deepEqual(addedWorkspaces, [],
      `PR1 the directory reads created a Host Workspace: ${JSON.stringify(addedWorkspaces)}`)
    assert(afterDrop.listedSessions === home.listedSessions,
      'PR1 the directory reads changed the official Session list')
    assert(afterDrop.sessionOpen === false && afterDrop.openSessionId === null,
      'PR1 the post-rollover surface opened a Session')
    const status = await hostStatus(host)
    const pickerRows = (status.entries ?? []).filter(entry =>
      entry.name === '@deepseek-ai/dsh-host-directory-picker-browse')
    assert(pickerRows.length === 1 && pickerRows[0].state === 'active',
      `PR1 after the reads the browse backend rows are ${JSON.stringify(pickerRows.map(row => [row.id, row.state]))}`)
    assert(pickerRows[0].fiberUid === pickerFiberUid,
      'PR1 the browse backend row was remounted by the reads')
    assert(status.pid === ready.pid,
      `PR1 the reads replaced the Host identity (${String(status.pid)} != ${String(ready.pid)})`)

    await exitC1Client(client, 'PR1 read client')
    context.trace?.('pr1-host-directory-browse', {
      hostHome: 'Host-owned',
      markerVisible: true,
      clientOnlyExcluded: true,
      explicitPathRows: namesOf(explicitListing).sort(),
      missingPathRefused: missing.outcome.code,
      relativePathRefused: relative.outcome.code,
      sessionless: true,
      workspaceBaselineStable: true,
      browseBackendActiveExactlyOnce: true,
    })
    return { status: 'PASS' }
  } finally {
    await dispose()
  }
}
