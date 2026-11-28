/**
 * Split-process business anchor: real PTY inline Host directory chooser.
 *
 * Drives `/sessions` -> `Add directory` through real keyboard input on a
 * sessionless Client with a distinct Client HOME/cwd: browsing Host levels with
 * Tab never registers a Workspace or Session, a carrier drop never falls back
 * to the Client filesystem, and only an explicit Enter Verify registers the
 * target Host directory.
 */

import { existsSync, mkdirSync, realpathSync } from 'node:fs'
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

function composerDraft(frame: string): string | undefined {
  const lines = frame.split('\n')
  const marker = lines.findLastIndex(line => line.trimStart().startsWith('❯')
    && !line.includes('[connection]'))
  if (marker < 0) return undefined
  const at = lines[marker]!.indexOf('❯')
  return lines[marker]!.slice(at + '❯'.length).trim()
}

async function waitForComposerDraft(
  client: SplitProcessClient,
  expected: string,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    const draft = composerDraft(await client.text())
    if (expected === '') {
      if (typeof draft === 'string' && (draft === '' || /^…{1,2}$/u.test(draft))) return
    } else if (draft === expected) {
      return
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: composer did not hold ${JSON.stringify(expected)} (saw ${JSON.stringify(draft)})`)
    }
    await sleep(25)
  }
}

async function waitForFrame(
  client: SplitProcessClient,
  predicate: (frame: string) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (predicate(frame)) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: condition not met within ${String(timeoutMs)}ms; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(50)
  }
}

async function waitForConfirmedDirectory(
  client: SplitProcessClient,
  canonicalPath: string,
  label: string,
  timeoutMs = 120_000,
): Promise<void> {
  const flatPath = canonicalPath.replace(/\s+/gu, '')
  await waitForFrame(client, frame => {
    const rows = frame.split('\n')
    const labelRow = rows.find(row => row.includes('Host directory:'))
    if (labelRow === undefined) return false
    const factsStart = labelRow.indexOf('Host directory:')
    const flat = rows
      .map(row => (row.length > factsStart ? row.slice(factsStart) : ''))
      .join('')
      .replace(/[\u2502\u256d\u256e\u2570\u256f\u2500]/gu, '')
      .replace(/\s+/gu, '')
    return !flat.includes('CheckingHostdirectory:')
      && !flat.includes('Hostdirectoryunavailable:')
      && flat.includes(flatPath)
  }, label, timeoutMs)
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

function hasSelectedRow(frame: string, fragment: string): boolean {
  return frame.split('\n').some(line => line.includes('>') && line.includes(fragment))
}

async function disposeScene(scene: SplitProcessScene, primary: unknown): Promise<void> {
  try {
    await scene.dispose()
  } catch (cleanupError) {
    if (primary !== undefined) {
      throw new AggregateError([primary, cleanupError], 'workspace-directory-chooser failed and Scene cleanup also failed')
    }
    throw cleanupError
  }
}

test('browses Host directory levels without registration and registers only on explicit Verify', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const hostHome = scene.installation.base.env.HOME
    expect(hostHome, 'the Scene installation must expose its isolated Host HOME').toBeTypeOf('string')
    const canonicalHostHome = realpathSync(hostHome!)
    const probeDir = join(canonicalHostHome, 'directory-probe')
    const childDir = join(probeDir, 'child')
    const hiddenDir = join(probeDir, '.hidden-child')
    mkdirSync(childDir, { recursive: true, mode: 0o700 })
    mkdirSync(hiddenDir, { recursive: true, mode: 0o700 })
    const canonicalChildDir = realpathSync(childDir)

    const clientHome = join(scene.workDir, 'chooser-client-home')
    const clientCwd = join(scene.workDir, 'chooser-client-cwd')
    mkdirSync(join(clientHome, 'directory-probe-client'), { recursive: true, mode: 0o700 })
    mkdirSync(clientCwd, { recursive: true, mode: 0o700 })
    const canonicalClientHome = realpathSync(clientHome)
    const canonicalClientCwd = realpathSync(clientCwd)
    expect(canonicalClientHome).not.toBe(canonicalHostHome)

    const host = await scene.startHost()
    const hostPid = host.ready.localHost?.hostPid
    const hostInstanceId = host.ready.localHost?.instanceId

    const client = await scene.startClient({
      label: 'directory-chooser',
      cwd: clientCwd,
      home: clientHome,
      readAuthorityProof: true,
      cols: 180,
      rows: 40,
    })
    expect(client.ready.sessionOpen).toBe(false)
    expect(client.ready.surfaceMounted).toBe(true)
    await waitForConfirmedDirectory(client, canonicalClientCwd, 'chooser initial confirmed Host directory')

    const sessionsBefore = [...await scene.sessionIds()].sort()
    const logCountBefore = scene.hostSessionLogCount()
    const workspacesBefore = await readWorkspaceBaseline(client, 'chooser before')

    // 1. Open `/sessions` -> select `Add directory` -> verify Host HOME prefill
    await waitForComposerDraft(client, '', 'chooser empty composer before /sessions')
    await client.type('/sessions')
    await waitForComposerDraft(client, '/sessions', 'chooser typed /sessions')
    await client.press('Enter')
    await waitForFrame(client, frame => frame.includes('Sessions ·') && frame.includes('Add directory'), 'chooser Workspace tree')

    await client.press('Home')
    await waitForFrame(client, frame => hasSelectedRow(frame, 'Add directory'), 'chooser selected Add directory row')
    await client.press('Enter')
    const editorOpened = await waitForFrame(
      client,
      frame => frame.includes('Host directory:') && frame.includes(canonicalHostHome),
      'chooser inline Host editor with Host HOME prefill',
    )
    expect(editorOpened).not.toContain('directory-probe-client')

    // 2. Filter Host level -> Tab into child level -> Tab accepts child path without writes
    await client.type('directory-probe')
    const filteredTop = await waitForFrame(
      client,
      frame => frame.includes('> directory-probe/'),
      'chooser filtered Host marker candidate',
    )
    expect(filteredTop).not.toContain('.hidden-child')
    expect(filteredTop).not.toContain('directory-probe-client')

    await client.press('Tab')
    await waitForFrame(
      client,
      frame => frame.includes('child/') && frame.includes('.hidden-child/'),
      'chooser next-level Host candidates',
    )
    await client.type('child')
    await waitForFrame(client, frame => frame.includes('> child/'), 'chooser filtered child candidate')
    await client.press('Tab')
    const acceptedChild = await waitForFrame(
      client,
      frame => frame.includes(`${canonicalChildDir}/`),
      'chooser accepted child path in inline editor',
    )
    expect(acceptedChild).not.toContain('directory-probe-client')

    const workspacesAfterTabs = await readWorkspaceBaseline(client, 'chooser after Tab navigation')
    expect(workspacesAfterTabs).toEqual(workspacesBefore)
    expect([...await scene.sessionIds()].sort()).toEqual(sessionsBefore)
    expect(scene.hostSessionLogCount()).toBe(logCountBefore)
    const statusAfterTabs = await client.waitForSurfaceStatus(
      record => record.sessionOpen === false && record.transport === 'connected',
      'chooser stays sessionless after Tab',
    )
    expect(statusAfterTabs.sessionOpen).toBe(false)

    // 3. Carrier drop via the qualification read probe while the editor is open;
    //    subsequent real editor keystroke keeps reading the Host on the new generation.
    const dropDispatched = await client.readAuthority({
      op: 'directory-browse',
      target: 'fixture',
      interruption: 'carrier',
    })
    const dropRecord = await client.waitForRecord(
      record => record.m4b2s === 'qualification'
        && record.op === 'read-authority-proof'
        && record.nonce === dropDispatched.nonce
        && (record.phase === 'directory-browse-rejected' || record.phase === 'directory-browse'),
      'chooser carrier drop probe settlement',
    )
    expect(dropRecord.phase).toBe('directory-browse-rejected')
    expect(dropRecord.rejected).toBe(true)

    await client.waitForSurfaceStatus(
      record => record.transport === 'connected'
        && typeof record.generationId === 'number'
        && record.generationId !== dropRecord.generationAtDispatch,
      'chooser connection generation rollover',
    )
    expect((await scene.hostStatus(host)).localHost?.instanceId).toBe(hostInstanceId)

    // Delete the trailing `/` so the editor issues a fresh Host browse for `child`
    await client.press('Backspace')
    const afterDropFrame = await waitForFrame(
      client,
      frame => frame.includes('> child/'),
      'chooser fresh Host candidate on the new generation',
    )
    expect(afterDropFrame).not.toContain('directory-probe-client')

    // 4. Explicit Enter verifies and registers ONLY the target Workspace
    await client.press('Enter')
    await waitForFrame(client, frame => frame.includes('Directory added:'), 'chooser Verify registration notice')
    const workspacesAfterVerify = await readWorkspaceBaseline(client, 'chooser after Verify')
    const beforeIds = new Set(workspacesBefore.map(item => item.workspaceId))
    const added = workspacesAfterVerify.filter(item => !beforeIds.has(item.workspaceId))
    expect(added).toHaveLength(1)
    expect(added[0]!.path).toBe(canonicalChildDir)
    expect(added[0]!.sessionIds).toEqual([])
    for (const previous of workspacesBefore) {
      const current = workspacesAfterVerify.find(item => item.workspaceId === previous.workspaceId)
      expect(current).toEqual(previous)
    }
    expect([...await scene.sessionIds()].sort()).toEqual(sessionsBefore)
    expect(scene.hostSessionLogCount()).toBe(logCountBefore)

    // 5. Esc returns to Welcome with the verified Host directory and no editor chrome
    await client.press('Escape')
    await waitForFrame(client, frame => !frame.includes('Sessions ·'), 'chooser closes back to Welcome')
    await waitForConfirmedDirectory(client, canonicalChildDir, 'chooser Welcome confirms verified Host directory')
    const welcomeFrame = await client.text()
    expect(welcomeFrame).not.toContain('Suggestions (Host)')
    expect(welcomeFrame).not.toContain('Esc cancel')

    await client.exitGracefully()
    const statusAfter = await scene.hostStatus(host)
    expect(statusAfter.localHost?.hostPid).toBe(hostPid)
    expect(statusAfter.localHost?.instanceId).toBe(hostInstanceId)
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary)
  }
})
