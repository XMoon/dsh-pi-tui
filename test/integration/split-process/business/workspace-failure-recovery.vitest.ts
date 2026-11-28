/**
 * Split-process business anchors: Host Workspace refusal recovery for `/new`
 * and first-submit flows.
 *
 * Each test uses an independent `observer` Client (`readAuthorityProof: true`)
 * to read the official Workspace registry baseline and a separate `target`
 * Client (`invalidWorkspacePath: true`) whose initial Host proposal is refused
 * by the Host. The existing Cancel recovery case remains in
 * `session-write-recovery.vitest.ts`; these two cases cover `/new` -> full tree
 * -> explicit Folder New and first-submit -> inline Verify (no auto replay) ->
 * explicit second submit.
 */

import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type SessionEvent,
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
      if (typeof draft === 'string'
        && (draft === '' || /^…{1,2}$/u.test(draft) || /^\[tui\].*WARN/u.test(draft))) {
        return
      }
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

async function readWorkspaceBaseline(observer: SplitProcessClient, label: string): Promise<WorkspaceSnapshotItem[]> {
  const dispatched = await observer.readAuthority({ op: 'workspaces', window: 'peer-baseline' })
  expect(dispatched.op, `${label}: unexpected read-authority op`).toBe('workspaces')
  const frame = await observer.waitForRecord(
    record => record.m4b2s === 'qualification'
      && record.op === 'read-authority-proof'
      && record.nonce === dispatched.nonce
      && record.phase === 'workspaces-frame',
    `${label}: workspaces baseline frame`,
  )
  await observer.waitForRecord(
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

function selectedRow(frame: string): string | undefined {
  return frame.split('\n').find(line => /(?:^|[\s│])>\s/u.test(line))
}

function messageText(message: Record<string, any> | undefined): string {
  return (message?.content ?? [])
    .map((part: Record<string, any>) => part?.type === 'text' && typeof part.text === 'string' ? part.text : '')
    .join('')
}

function isHumanUserEvent(event: SessionEvent, prompt: string): boolean {
  return event.type === 'user/message'
    && event.data?.source?.kind === 'user'
    && messageText(event.data) === prompt
}

function eventSeq(event: SessionEvent): number | undefined {
  const seq = (event as Record<string, any>).seq
  return typeof seq === 'number' ? seq : undefined
}

async function waitForCompletedTurn(
  scene: SplitProcessScene,
  sessionId: string,
  prompt: string,
  answer: string,
  label: string,
): Promise<{ user: SessionEvent; turn: number; end: SessionEvent }> {
  const user = await scene.waitForSessionEvent(
    sessionId, 0, event => isHumanUserEvent(event, prompt), `${label}: durable human user/message`)
  const userSeq = eventSeq(user)
  expect(userSeq, `${label}: durable user sequence`).toBeTypeOf('number')
  let start: SessionEvent | undefined
  const started = Date.now()
  while (Date.now() - started < 120_000) {
    start = (scene.sessionEvents(sessionId) ?? [])
      .filter(event => event.type === 'turn/start' && (eventSeq(event) ?? Number.POSITIVE_INFINITY) < userSeq!)
      .at(-1)
    if (start !== undefined) break
    await sleep(25)
  }
  expect(start, `${label}: enclosing turn/start`).toBeDefined()
  const turn = start!.data?.turn
  expect(turn, `${label}: numeric turn identity`).toBeTypeOf('number')
  const end = await scene.waitForSessionEvent(
    sessionId, 0,
    event => event.type === 'turn/end' && event.data?.turn === turn && event.data?.reason?.kind === 'completed',
    `${label}: completed turn/end`,
  )
  await scene.waitForSessionEvent(
    sessionId, 0,
    event => event.type === 'assistant/message' && event.data?.turn === turn && messageText(event.data?.message).includes(answer),
    `${label}: durable assistant answer in the same Turn`,
  )
  return { user, turn: turn as number, end }
}

function hostDirectoryEditorValue(frame: string): string | undefined {
  const row = frame.split('\n').find(line => line.includes('Host directory:'))
  if (row === undefined) return undefined
  const at = row.indexOf('Host directory:')
  return row.slice(at + 'Host directory:'.length).trim()
}

async function openAddDirectoryFromTree(
  client: SplitProcessClient,
  hostHome: string,
  label: string,
): Promise<void> {
  await client.press('Home')
  await waitForFrame(
    client,
    frame => frame.split('\n').some(line => line.includes('>') && line.includes('Add directory')),
    `${label}: selected Add directory row`,
  )
  await client.press('Enter')
  await waitForFrame(
    client,
    frame => frame.includes('Host directory:') && frame.includes(hostHome),
    `${label}: inline Host editor with Host HOME prefill`,
  )
}

function assertWorkspaceAdded(
  before: WorkspaceSnapshotItem[],
  after: WorkspaceSnapshotItem[],
  canonicalPath: string,
  label: string,
): string {
  const beforeIds = new Set(before.map(item => item.workspaceId))
  const added = after.filter(item => !beforeIds.has(item.workspaceId))
  expect(added, `${label}: expected exactly one new Workspace`).toHaveLength(1)
  expect(added[0]!.path, `${label}: registered Workspace path`).toBe(canonicalPath)
  expect(added[0]!.sessionIds, `${label}: registered Workspace must start with zero Sessions`).toEqual([])
  for (const existing of before) {
    const matching = after.find(item => item.workspaceId === existing.workspaceId)
    expect(matching, `${label}: existing Workspace ${existing.workspaceId} changed`).toEqual(existing)
  }
  return added[0]!.workspaceId
}

async function disposeScene(scene: SplitProcessScene, primary: unknown, label: string): Promise<void> {
  try {
    await scene.dispose()
  } catch (cleanupError) {
    if (primary !== undefined) {
      throw new AggregateError([primary, cleanupError], `${label}: test failed and Scene cleanup also failed`)
    }
    throw cleanupError
  }
}

test('a refused new Session opens the Workspace tree and creates only after an explicit Folder New', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const hostHome = scene.installation.base.env.HOME
    expect(hostHome, 'the Scene installation must expose its isolated Host HOME').toBeTypeOf('string')
    const canonicalHostHome = realpathSync(hostHome!)
    const destName = 'recovery-destination'
    const destDir = join(canonicalHostHome, destName)
    mkdirSync(destDir, { recursive: true, mode: 0o700 })
    const canonicalDest = realpathSync(destDir)

    const observerHome = join(scene.workDir, 'new-observer-home')
    const observerCwd = join(scene.workDir, 'new-observer-cwd')
    const targetHome = join(scene.workDir, 'new-target-home')
    const targetCwd = join(scene.workDir, 'new-target-cwd')
    for (const dir of [observerHome, observerCwd, targetHome, targetCwd]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const canonicalObserverCwd = realpathSync(observerCwd)

    const host = await scene.startHost()
    const hostPid = host.ready.localHost?.hostPid
    const hostInstanceId = host.ready.localHost?.instanceId

    const observer = await scene.startClient({
      label: 'recovery-new-observer',
      cwd: observerCwd,
      home: observerHome,
      readAuthorityProof: true,
    })
    await waitForConfirmedDirectory(observer, canonicalObserverCwd, 'observer initial auto-confirmed directory')

    const target = await scene.startClient({
      label: 'recovery-new-target',
      cwd: targetCwd,
      home: targetHome,
      invalidWorkspacePath: true,
    })
    expect(target.ready.sessionOpen).toBe(false)
    await waitForFrame(target, frame => frame.includes('Host directory unavailable'), 'target initial refusal notice')

    const sessionsBefore = [...await scene.sessionIds()].sort()
    const logCountBefore = scene.hostSessionLogCount()
    const workspacesBefore = await readWorkspaceBaseline(observer, 'new-recovery before')
    expect(workspacesBefore.some(item => item.path === canonicalDest)).toBe(false)

    // 1. `/new` opens the full Workspace tree (never the inline `Host directory:` editor)
    await waitForComposerDraft(target, '', 'target empty composer before /new')
    await target.type('/new')
    await waitForComposerDraft(target, '/new', 'target typed /new')
    await target.press('Enter')
    const treeFrame = await waitForFrame(
      target,
      frame => frame.includes('Sessions ·') && frame.includes('Add directory'),
      'target refused /new full Workspace tree',
    )
    expect(treeFrame).not.toContain('Host directory:')
    expect([...await scene.sessionIds()].sort()).toEqual(sessionsBefore)
    expect(scene.hostSessionLogCount()).toBe(logCountBefore)
    expect(await readWorkspaceBaseline(observer, 'new-recovery after refusal')).toEqual(workspacesBefore)

    // 2. Esc closes only the tree with zero writes
    await target.press('Escape')
    await waitForFrame(target, frame => !frame.includes('Sessions ·'), 'target Esc closes tree')
    expect([...await scene.sessionIds()].sort()).toEqual(sessionsBefore)
    expect(scene.hostSessionLogCount()).toBe(logCountBefore)
    expect(await readWorkspaceBaseline(observer, 'new-recovery after cancel')).toEqual(workspacesBefore)

    // 3. Reopen via `/new`, browse Host home, Verify `recovery-destination`
    await waitForComposerDraft(target, '', 'target empty composer before second /new')
    await target.type('/new')
    await waitForComposerDraft(target, '/new', 'target typed second /new')
    await target.press('Enter')
    await waitForFrame(target, frame => frame.includes('Sessions ·') && frame.includes('Add directory'), 'target reopened tree')

    await openAddDirectoryFromTree(target, canonicalHostHome, 'new-recovery Add directory')
    await target.type(destName)
    await waitForFrame(target, frame => frame.includes(`> ${destName}/`), 'new-recovery Host destination candidate')
    await target.press('Tab')
    await waitForFrame(target, frame => frame.includes(`${destName}/`), 'new-recovery accepted destination path')
    await target.press('Enter')
    await waitForFrame(target, frame => frame.includes('Directory added:'), 'new-recovery Verify registration notice')

    const workspacesAfterAdd = await readWorkspaceBaseline(observer, 'new-recovery after Add')
    const destinationWorkspaceId = assertWorkspaceAdded(workspacesBefore, workspacesAfterAdd, canonicalDest, 'new-recovery Add')
    expect([...await scene.sessionIds()].sort()).toEqual(sessionsBefore)
    expect(scene.hostSessionLogCount()).toBe(logCountBefore)
    expect(target.readRecords()
      .filter(record => record?.m4b2s === 'surface-status')
      .some(record => record.sessionOpen === true)).toBe(false)

    // 4. Visibly locate the registered `recovery-destination` folder, expand and select `+ New session`
    await target.press('Home')
    await waitForFrame(
      target,
      frame => frame.split('\n').some(line => line.includes('>') && line.includes('Add directory')),
      'new-recovery cursor at Add directory before navigating to folder',
    )
    let focusedDestination = false
    for (let step = 0; step < 12; step += 1) {
      const current = selectedRow(await target.text()) ?? ''
      if (current.includes(destName)) {
        focusedDestination = true
        break
      }
      const prevFrame = await target.text()
      await target.press('Down')
      await waitForFrame(target, frame => frame !== prevFrame, `new-recovery Down step ${String(step)}`, 15_000)
    }
    expect(focusedDestination, 'the newly registered recovery-destination folder was not selectable in the tree').toBe(true)

    // Expand the folder with Right and step down if needed until `New session` is selected
    const beforeExpand = await target.text()
    await target.press('Right')
    await waitForFrame(
      target,
      frame => frame !== beforeExpand && frame.includes('New session'),
      'new-recovery expanded destination folder shows New session',
    )
    let focusedNewSession = false
    for (let step = 0; step < 6; step += 1) {
      const current = selectedRow(await target.text()) ?? ''
      if (current.includes('New session')) {
        focusedNewSession = true
        break
      }
      const prevFrame = await target.text()
      await target.press('Down')
      await waitForFrame(target, frame => frame !== prevFrame, `new-recovery focus New session step ${String(step)}`, 15_000)
    }
    expect(focusedNewSession, 'New session row under recovery-destination was not selected').toBe(true)

    const beforeCommitSet = new Set(sessionsBefore)
    await target.press('Enter')

    const newSessionId = await scene.waitForNewSessionId(beforeCommitSet, 'new-recovery explicit Folder New Session')
    const opened = await target.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === newSessionId,
      'new-recovery target opened new Session',
    )
    expect(opened.openSessionId).toBe(newSessionId)
    await waitForFrame(target, frame => !frame.includes('Sessions ·'), 'new-recovery Browser closed after commit')

    expect([...await scene.sessionIds()].sort()).toEqual([...sessionsBefore, newSessionId].sort())
    expect(scene.hostSessionLogCount()).toBe(logCountBefore + 1)
    const header = await scene.waitForHostSessionHeader(newSessionId, 'new-recovery durable header')
    expect((header as Record<string, any>).cwd).toBe(canonicalDest)
    const events = scene.sessionEvents(newSessionId) ?? []
    expect(events.some(event => event.type === 'user/message')).toBe(false)

    const workspacesAfterCommit = await readWorkspaceBaseline(observer, 'new-recovery after commit')
    const destinationRow = workspacesAfterCommit.find(item => item.workspaceId === destinationWorkspaceId)
    expect(destinationRow?.sessionIds).toEqual([newSessionId])

    expect(observer.readRecords()
      .filter(record => record?.m4b2s === 'surface-status')
      .some(record => record.sessionOpen === true)).toBe(false)

    await target.exitGracefully()
    await observer.exitGracefully()
    const hostAfter = await scene.hostStatus(host)
    expect(hostAfter.localHost?.hostPid).toBe(hostPid)
    expect(hostAfter.localHost?.instanceId).toBe(hostInstanceId)
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'workspace-new-failure-recovery')
  }
})

test('a refused first submit restores its exact draft and Verify never replays it', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const hostHome = scene.installation.base.env.HOME
    expect(hostHome, 'the Scene installation must expose its isolated Host HOME').toBeTypeOf('string')
    const canonicalHostHome = realpathSync(hostHome!)
    const destName = 'recovery-destination'
    const destDir = join(canonicalHostHome, destName)
    mkdirSync(destDir, { recursive: true, mode: 0o700 })
    const canonicalDest = realpathSync(destDir)

    const observerHome = join(scene.workDir, 'submit-observer-home')
    const observerCwd = join(scene.workDir, 'submit-observer-cwd')
    const targetHome = join(scene.workDir, 'submit-target-home')
    const targetCwd = join(scene.workDir, 'submit-target-cwd')
    const clientTwinName = 'recovery-destination-client-twin'
    for (const dir of [observerHome, observerCwd, targetHome, targetCwd, join(targetHome, clientTwinName)]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const canonicalObserverCwd = realpathSync(observerCwd)

    const host = await scene.startHost()
    const hostPid = host.ready.localHost?.hostPid
    const hostInstanceId = host.ready.localHost?.instanceId

    const observer = await scene.startClient({
      label: 'recovery-submit-observer',
      cwd: observerCwd,
      home: observerHome,
      readAuthorityProof: true,
    })
    await waitForConfirmedDirectory(observer, canonicalObserverCwd, 'submit observer initial auto-confirmed directory')

    const target = await scene.startClient({
      label: 'recovery-submit-target',
      cwd: targetCwd,
      home: targetHome,
      invalidWorkspacePath: true,
      cols: 240,
      rows: 40,
    })
    expect(target.ready.sessionOpen).toBe(false)
    await waitForFrame(target, frame => frame.includes('Host directory unavailable'), 'submit target initial refusal notice')

    const sessionsBefore = [...await scene.sessionIds()].sort()
    const logCountBefore = scene.hostSessionLogCount()
    const workspacesBefore = await readWorkspaceBaseline(observer, 'submit-recovery before')

    // 1. Type authored prompt and submit once -> refused into inline Host directory editor
    const prompt = 'workspace recovery keep this draft'
    await waitForComposerDraft(target, '', 'submit target empty composer')
    await target.type(prompt)
    await waitForComposerDraft(target, prompt, 'submit target typed prompt')
    await target.press('Enter')

    const editorFrame = await waitForFrame(
      target,
      frame => frame.includes('Host directory:') && frame.includes('invalid-workspace'),
      'submit target inline Host editor with refused proposal prefill',
    )
    expect(editorFrame).not.toContain(clientTwinName)
    const receipt = await scene.readSupervisorReceipt()
    const refusedClient = (receipt.processClients ?? []).find(item => item.clientId === target.clientId)
    const refusedPath = refusedClient?.workspaceIntentPath
    expect(refusedPath, 'the Supervisor must allocate the refused Host proposal for this target Client').toBeTypeOf('string')
    expect(existsSync(refusedPath!), 'the refused Host proposal must not exist').toBe(false)
    expect(hostDirectoryEditorValue(editorFrame),
      'the inline editor must be prefilled with the exact refused Host proposal').toBe(refusedPath)
    expect([...await scene.sessionIds()].sort()).toEqual(sessionsBefore)
    expect(scene.hostSessionLogCount()).toBe(logCountBefore)
    expect(await readWorkspaceBaseline(observer, 'submit-recovery after refusal')).toEqual(workspacesBefore)
    expect(target.readRecords()
      .filter(record => record?.m4b2s === 'surface-status')
      .some(record => record.sessionOpen === true)).toBe(false)

    // 2. Clear refused path with Ctrl+U, enter Host destination, Tab, Enter Verify
    await target.press('Ctrl+U')
    await waitForFrame(
      target,
      frame => frame.includes('Host directory:') && !frame.includes('invalid-workspace'),
      'submit target cleared refused proposal from inline editor',
    )
    await target.type(`${canonicalHostHome}/${destName}`)
    await waitForFrame(target, frame => frame.includes(`> ${destName}/`), 'submit target Host destination candidate')
    await target.press('Tab')
    await waitForFrame(target, frame => frame.includes(`${canonicalDest}/`), 'submit target accepted Host destination')
    await target.press('Enter')

    // 3. Verify returns to Welcome with the exact draft intact and ZERO auto-replay
    await waitForFrame(
      target,
      frame => !frame.includes('Sessions ·') && !frame.includes('Cancel [Esc]'),
      'submit target Verify returned to Welcome',
    )
    await waitForConfirmedDirectory(target, canonicalDest, 'submit target Welcome confirmed destination')
    await waitForComposerDraft(target, prompt, 'submit target exact draft restored without auto replay')
    expect([...await scene.sessionIds()].sort()).toEqual(sessionsBefore)
    expect(scene.hostSessionLogCount()).toBe(logCountBefore)
    const workspacesAfterVerify = await readWorkspaceBaseline(observer, 'submit-recovery after Verify')
    const destinationWorkspaceId = assertWorkspaceAdded(workspacesBefore, workspacesAfterVerify, canonicalDest, 'submit-recovery Verify')
    expect(target.readRecords()
      .filter(record => record?.m4b2s === 'surface-status')
      .some(record => record.sessionOpen === true)).toBe(false)

    // 4. User explicitly presses Enter once -> exactly one durable Session & Turn
    await waitForComposerDraft(target, prompt, 'submit target draft ready for explicit second submit')
    const beforeSubmitSet = new Set(sessionsBefore)
    await target.press('Enter')

    const newSessionId = await scene.waitForNewSessionId(beforeSubmitSet, 'submit-recovery explicit second submit Session')
    const opened = await target.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === newSessionId,
      'submit-recovery target opened new Session',
    )
    expect(opened.openSessionId).toBe(newSessionId)
    const header = await scene.waitForHostSessionHeader(newSessionId, 'submit-recovery durable header')
    expect((header as Record<string, any>).cwd).toBe(canonicalDest)

    const settled = await waitForCompletedTurn(
      scene, newSessionId, prompt, 'stub answer', 'submit-recovery')
    expect(settled.user.data?.id).toBeTypeOf('string')

    const finalEvents = scene.sessionEvents(newSessionId) ?? []
    expect(finalEvents.filter(event => isHumanUserEvent(event, prompt))).toHaveLength(1)
    expect(finalEvents
      .filter(event => event.type === 'user/message'
        && messageText(event.data) === prompt
        && event.data?.source?.kind !== 'user')
      .map(event => event.data?.source?.kind ?? 'missing')).toEqual([])
    expect(finalEvents.some(event => event.type === 'turn/end'
      && event.data?.turn === settled.turn && event.data?.reason?.kind === 'completed')).toBe(true)
    expect([...await scene.sessionIds()].sort()).toEqual([...sessionsBefore, newSessionId].sort())
    expect(scene.hostSessionLogCount()).toBe(logCountBefore + 1)

    const workspacesAfterSubmit = await readWorkspaceBaseline(observer, 'submit-recovery after submit')
    const destinationRow = workspacesAfterSubmit.find(item => item.workspaceId === destinationWorkspaceId)
    expect(destinationRow?.sessionIds).toEqual([newSessionId])

    expect(observer.readRecords()
      .filter(record => record?.m4b2s === 'surface-status')
      .some(record => record.sessionOpen === true)).toBe(false)

    await target.exitGracefully()
    await observer.exitGracefully()
    const hostAfter = await scene.hostStatus(host)
    expect(hostAfter.localHost?.hostPid).toBe(hostPid)
    expect(hostAfter.localHost?.instanceId).toBe(hostInstanceId)
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'workspace-first-submit-failure-recovery')
  }
})
