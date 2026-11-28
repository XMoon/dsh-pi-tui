/**
 * Split-process business anchor: read-only Host directory browsing through the
 * mounted production `HostDirectoryBrowsePort`.
 *
 * Exercises the real installed Host and a real sessionless PTY Client with a
 * distinct Client HOME/cwd. Every directory listing and interruption fact is
 * emitted by the production Backend port via the bounded read-authority probe.
 */

import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type SplitProcessClient,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

type ProbeRecord = Record<string, any>

interface WorkspaceSnapshotItem {
  workspaceId: string
  path: string | null
  sessionIds: string[]
}

function canonicalExistingPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path
}

async function waitForConfirmedDirectory(
  client: SplitProcessClient,
  canonicalPath: string,
  label: string,
  timeoutMs = 120_000,
): Promise<void> {
  const flatPath = canonicalPath.replace(/\s+/gu, '')
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    const rows = frame.split('\n')
    const labelRow = rows.find(row => row.includes('Host directory:'))
    if (labelRow !== undefined) {
      const factsStart = labelRow.indexOf('Host directory:')
      const flat = rows
        .map(row => (row.length > factsStart ? row.slice(factsStart) : ''))
        .join('')
        .replace(/[\u2502\u256d\u256e\u2570\u256f\u2500]/gu, '')
        .replace(/\s+/gu, '')
      if (!flat.includes('CheckingHostdirectory:')
        && !flat.includes('Hostdirectoryunavailable:')
        && flat.includes(flatPath)) {
        return
      }
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: the Welcome never confirmed ${canonicalPath}; frame=${JSON.stringify((await client.text()).slice(-2000))}`)
    }
    await sleep(50)
  }
}

async function readWorkspaceBaseline(client: SplitProcessClient, label: string): Promise<WorkspaceSnapshotItem[]> {
  const dispatched = await client.readAuthority({ op: 'workspaces', window: 'peer-baseline' })
  expect(dispatched.op, `${label}: unexpected read-authority op`).toBe('workspaces')
  const frame = await client.waitForRecord(
    record => record.m4b2s === 'qualification'
      && record.op === 'read-authority-proof'
      && record.nonce === dispatched.nonce
      && record.phase === 'workspaces-frame',
    `${label}: workspaces baseline frame`,
  )
  await client.waitForRecord(
    record => record.m4b2s === 'qualification'
      && record.op === 'read-authority-proof'
      && record.nonce === dispatched.nonce
      && record.phase === 'workspaces-ended',
    `${label}: workspaces baseline terminal`,
  )
  const items: WorkspaceSnapshotItem[] = (Array.isArray(frame.items) ? frame.items : []).map((item: ProbeRecord) => ({
    workspaceId: String(item.workspaceId),
    path: typeof item.path === 'string' ? canonicalExistingPath(item.path) : null,
    sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.map(String).sort() : [],
  }))
  return items.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
}

async function directoryBrowseProbe(
  client: SplitProcessClient,
  request: Extract<Parameters<SplitProcessClient['readAuthority']>[0], { op: 'directory-browse' }>,
  label: string,
): Promise<ProbeRecord> {
  const dispatched = await client.readAuthority(request)
  expect(dispatched.op, `${label}: unexpected read-authority op`).toBe('directory-browse')
  return await client.waitForRecord(
    record => record.m4b2s === 'qualification'
      && record.op === 'read-authority-proof'
      && record.nonce === dispatched.nonce
      && (record.phase === 'directory-browse' || record.phase === 'directory-browse-rejected' || record.phase === 'failed'),
    `${label}: directory-browse terminal record`,
  )
}

function browseBackendRows(status: Record<string, any>): Record<string, any>[] {
  return (Array.isArray(status.entries) ? status.entries : [])
    .filter((entry: Record<string, any>) => entry.name === '@deepseek-ai/dsh-host-directory-picker-browse')
}

async function disposeScene(scene: SplitProcessScene, primary: unknown): Promise<void> {
  try {
    await scene.dispose()
  } catch (cleanupError) {
    if (primary !== undefined) {
      throw new AggregateError([primary, cleanupError], 'host-directory-browse failed and Scene cleanup also failed')
    }
    throw cleanupError
  }
}

test('lists only Host directories and rejects interrupted reads without registering Workspaces or Sessions', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const hostHome = scene.installation.base.env.HOME
    expect(hostHome, 'the Scene installation must expose its isolated Host HOME').toBeTypeOf('string')
    const canonicalHostHome = realpathSync(hostHome!)
    const probeDir = join(canonicalHostHome, 'directory-probe')
    const alphaDir = join(probeDir, 'alpha')
    const hiddenDir = join(probeDir, '.hidden-child')
    mkdirSync(alphaDir, { recursive: true, mode: 0o700 })
    mkdirSync(hiddenDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(probeDir, 'not-a-directory.txt'), 'file-not-directory\n', { mode: 0o600 })

    const clientHome = join(scene.workDir, 'browse-client-home')
    const clientCwd = join(scene.workDir, 'browse-client-cwd')
    mkdirSync(join(clientHome, 'directory-probe-client'), { recursive: true, mode: 0o700 })
    mkdirSync(clientCwd, { recursive: true, mode: 0o700 })
    const canonicalClientHome = realpathSync(clientHome)
    const canonicalClientCwd = realpathSync(clientCwd)
    expect(canonicalClientHome).not.toBe(canonicalHostHome)

    const host = await scene.startHost()
    const initialPickerRows = browseBackendRows(host.ready)
    expect(initialPickerRows).toHaveLength(1)
    expect(initialPickerRows[0]!.state).toBe('active')
    expect(initialPickerRows[0]!.id).toBe('directory-picker')
    const pickerFiberUid = initialPickerRows[0]!.fiberUid
    expect(pickerFiberUid).toBeTypeOf('number')
    expect(host.ready.ownerEntries?.directoryPicker).toEqual(['directory-picker'])
    const hostPid = host.ready.localHost?.hostPid
    const hostInstanceId = host.ready.localHost?.instanceId

    const client = await scene.startClient({
      label: 'directory-browse',
      cwd: clientCwd,
      home: clientHome,
      readAuthorityProof: true,
    })
    expect(client.ready.transport).toBe('connected')
    expect(client.ready.surfaceMounted).toBe(true)
    expect(client.ready.sessionOpen).toBe(false)
    expect(client.ready.hostPid).toBe(hostPid)
    expect(client.ready.instanceId).toBe(hostInstanceId)
    await waitForConfirmedDirectory(client, canonicalClientCwd, 'directory-browse initial confirmed Host directory')

    const sessionsBefore = [...await scene.sessionIds()].sort()
    const logCountBefore = scene.hostSessionLogCount()
    const workspacesBefore = await readWorkspaceBaseline(client, 'directory-browse before')

    // Typed IPC boundary: an arbitrary raw path field is refused before any
    // probe record or signal is dispatched, and subsequent valid reads succeed.
    const recordsBeforeInvalid = client.readRecords().length
    await expect(scene.request('PROCESS_CLIENT_READ_AUTHORITY', {
      clientId: client.clientId,
      request: { op: 'directory-browse', target: 'home', path: canonicalHostHome },
    })).rejects.toThrow(/INPUT_UNQUALIFIED/u)
    expect(client.readRecords().length).toBe(recordsBeforeInvalid)

    // 1. Default Host home read (`path` omitted)
    const home = await directoryBrowseProbe(client, { op: 'directory-browse', target: 'home' }, 'Host home')
    expect(home.phase).toBe('directory-browse')
    expect(home.mode).toBe('read')
    expect(home.outcome?.kind).toBe('ready')
    expect(realpathSync(home.outcome.home)).toBe(canonicalHostHome)
    expect(realpathSync(home.outcome.path)).toBe(canonicalHostHome)
    expect(Array.isArray(home.outcome.crumbs) && home.outcome.crumbs.length > 0).toBe(true)
    const homeNames = (home.outcome.entries as ProbeRecord[]).map(entry => entry.name)
    expect(homeNames).toContain('directory-probe')
    expect(homeNames).not.toContain('directory-probe-client')
    expect(home.sessionOpen).toBe(false)
    expect(home.openSessionId).toBeNull()
    expect(home.generationAtDispatch).toBeTypeOf('number')
    expect(home.generationAtDelivery).toBe(home.generationAtDispatch)

    // 2. Fixed Host fixture directory: exact child directories only, hidden flags preserved
    const fixture = await directoryBrowseProbe(client, { op: 'directory-browse', target: 'fixture' }, 'Host fixture level')
    expect(fixture.phase).toBe('directory-browse')
    expect(fixture.mode).toBe('read')
    expect(fixture.outcome?.kind).toBe('ready')
    expect(realpathSync(fixture.outcome.path)).toBe(realpathSync(probeDir))
    expect(fixture.outcome.truncated).toBe(false)
    const fixtureEntries = fixture.outcome.entries as ProbeRecord[]
    expect(fixtureEntries.map(entry => entry.name).sort()).toEqual(['.hidden-child', 'alpha'])
    const alphaEntry = fixtureEntries.find(entry => entry.name === 'alpha')
    const hiddenEntry = fixtureEntries.find(entry => entry.name === '.hidden-child')
    expect(alphaEntry?.hidden).toBe(false)
    expect(hiddenEntry?.hidden).toBe(true)
    expect(realpathSync(String(alphaEntry?.path))).toBe(realpathSync(alphaDir))
    expect(realpathSync(String(hiddenEntry?.path))).toBe(realpathSync(hiddenDir))
    expect(fixtureEntries.some(entry => entry.name === 'not-a-directory.txt')).toBe(false)

    // 3. Path refusals stay `failed` with `directory-picker/unreadable`
    const missing = await directoryBrowseProbe(client, { op: 'directory-browse', target: 'missing' }, 'missing Host path')
    expect(missing.phase).toBe('directory-browse')
    expect(missing.outcome?.kind).toBe('failed')
    expect(missing.outcome?.code).toBe('directory-picker/unreadable')

    const relative = await directoryBrowseProbe(client, { op: 'directory-browse', target: 'relative' }, 'relative Host path')
    expect(relative.phase).toBe('directory-browse')
    expect(relative.outcome?.kind).toBe('failed')
    expect(relative.outcome?.code).toBe('directory-picker/unreadable')

    // 4. Caller abort rejects without emitting a listing
    const callerAbort = await directoryBrowseProbe(
      client,
      { op: 'directory-browse', target: 'fixture', interruption: 'caller' },
      'caller abort',
    )
    expect(callerAbort.phase).toBe('directory-browse-rejected')
    expect(callerAbort.rejected).toBe(true)
    expect(callerAbort.errorName).toBe('AbortError')
    expect(callerAbort.outcome).toBeUndefined()

    // 5. Physical carrier drop rejects in-flight read and recovers on a new generation
    const carrierDrop = await directoryBrowseProbe(
      client,
      { op: 'directory-browse', target: 'fixture', interruption: 'carrier' },
      'carrier drop',
    )
    expect(carrierDrop.phase).toBe('directory-browse-rejected')
    expect(carrierDrop.rejected).toBe(true)
    expect(['SupersededReadError', 'AbortError', 'RemoteError']).toContain(carrierDrop.errorName)
    expect(carrierDrop.outcome).toBeUndefined()
    expect(carrierDrop.generationAtDispatch).toBeTypeOf('number')

    await client.waitForSurfaceStatus(
      record => record.transport === 'connected'
        && typeof record.generationId === 'number'
        && record.generationId !== carrierDrop.generationAtDispatch,
      'connection generation rollover after carrier drop',
    )

    const afterRollover = await directoryBrowseProbe(client, { op: 'directory-browse', target: 'home' }, 'post-rollover Host home')
    expect(afterRollover.phase).toBe('directory-browse')
    expect(afterRollover.outcome?.kind).toBe('ready')
    expect((afterRollover.outcome.entries as ProbeRecord[]).map(entry => entry.name)).toContain('directory-probe')
    expect(afterRollover.generationAtDispatch).toBeTypeOf('number')
    expect(afterRollover.generationAtDispatch).not.toBe(carrierDrop.generationAtDispatch)
    expect(afterRollover.generationAtDelivery).toBe(afterRollover.generationAtDispatch)
    expect(afterRollover.listedSessions).toBe(home.listedSessions)
    expect(afterRollover.sessionOpen).toBe(false)
    expect(afterRollover.openSessionId).toBeNull()

    // 6. No Workspace or Session mutations; same Host and browse backend survive
    const workspacesAfter = await readWorkspaceBaseline(client, 'directory-browse after')
    expect(workspacesAfter).toEqual(workspacesBefore)
    expect([...await scene.sessionIds()].sort()).toEqual(sessionsBefore)
    expect(scene.hostSessionLogCount()).toBe(logCountBefore)

    await client.exitGracefully()
    const statusAfter = await scene.hostStatus(host)
    expect(statusAfter.localHost?.hostPid).toBe(hostPid)
    expect(statusAfter.localHost?.instanceId).toBe(hostInstanceId)
    const finalPickerRows = browseBackendRows(statusAfter)
    expect(finalPickerRows).toHaveLength(1)
    expect(finalPickerRows[0]!.state).toBe('active')
    expect(finalPickerRows[0]!.fiberUid).toBe(pickerFiberUid)
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary)
  }
})
