import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type PublicDaemonLaunch,
  type SplitProcessClient,
  type SplitProcessHostHandle,
  type SplitProcessScene,
  type SessionEvent,
} from '../../../support/split-process-fixture.ts'

const fixtureHelpers = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-fixtures.mjs')).href
) as {
  waitForC1WorkEvent(
    root: string,
    predicate: (event: Record<string, any>) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<Record<string, any>>
}

const sessionHelpers = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-sessions.mjs')).href
) as {
  sha16(value: string): string
}

interface TextSurface {
  text(): Promise<string>
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function disposeScene(scene: SplitProcessScene, primary: unknown, label: string): Promise<void> {
  try {
    await scene.dispose()
  } catch (cleanupError) {
    if (primary !== undefined) {
      throw new AggregateError([primary, cleanupError], `${label}: the business test and its Scene cleanup both failed`)
    }
    throw cleanupError
  }
}

function clientDirectories(scene: SplitProcessScene, label: string): { home: string; cwd: string } {
  const root = join(scene.workDir, 'clients', label)
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  return { home, cwd }
}

function releaseFile(path: string, label: string): void {
  writeFileSync(path, 'release\n', { mode: 0o600, flag: 'wx' })
}

async function waitFrame(surface: TextSurface, text: string, label: string, timeoutMs = 120_000): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await surface.text()
    if (frame.includes(text)) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: the current frame never showed ${JSON.stringify(text)}; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(50)
  }
}

async function waitFrameOrder(
  surface: TextSurface,
  prompt: string,
  answer: string,
  label: string,
  timeoutMs = 120_000,
): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await surface.text()
    const promptAt = frame.lastIndexOf(prompt)
    const answerAt = frame.lastIndexOf(answer)
    if (promptAt >= 0 && answerAt > promptAt) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: the current frame never painted ${JSON.stringify(answer)} after ${JSON.stringify(prompt)}`)
    }
    await sleep(50)
  }
}

async function waitForRecordAfter(
  client: SplitProcessClient,
  afterIndex: number,
  predicate: (record: Record<string, any>) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<Record<string, any>> {
  const started = Date.now()
  for (;;) {
    const record = client.readRecords().slice(afterIndex).find(predicate)
    if (record !== undefined) return record
    const state = await client.state()
    if (state.exited) throw new Error(`${label}: the Client exited before the expected official record`)
    if (Date.now() - started >= timeoutMs) throw new Error(`${label}: no matching after-boundary record`)
    await sleep(25)
  }
}

async function waitForSurfaceStatusAfter(
  client: SplitProcessClient,
  afterIndex: number,
  predicate: (record: Record<string, any>) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<Record<string, any>> {
  const started = Date.now()
  for (;;) {
    const status = client.readRecords().slice(afterIndex)
      .filter(record => record?.m4b2s === 'surface-status')
      .find(predicate)
    if (status !== undefined) return status
    const state = await client.state()
    if (state.exited) throw new Error(`${label}: the Client exited before the expected surface status`)
    if (Date.now() - started >= timeoutMs) throw new Error(`${label}: no matching after-boundary surface status`)
    await sleep(25)
  }
}

function messageText(message: Record<string, any> | undefined): string {
  return (message?.content ?? [])
    .map((part: Record<string, any>) => part?.type === 'text' && typeof part.text === 'string' ? part.text : '')
    .join('')
}

function userText(event: SessionEvent): string {
  return messageText(event.data)
}

function isHumanUserEvent(event: SessionEvent): boolean {
  return event.type === 'user/message' && event.data?.source?.kind === 'user'
}

function humanUserTexts(events: SessionEvent[]): string[] {
  return events.filter(isHumanUserEvent).map(userText)
}

function expectHumanPromptCount(events: SessionEvent[], text: string, expected: number): void {
  const matching = events.filter(event => event.type === 'user/message' && userText(event) === text)
  expect(matching.filter(isHumanUserEvent), `human-authored occurrences of ${JSON.stringify(text)}`).toHaveLength(expected)
  expect(
    matching.filter(event => !isHumanUserEvent(event)).map(event => event.data?.source?.kind ?? 'missing'),
    `a non-human or unknown source wrote the authored business prompt ${JSON.stringify(text)}`,
  ).toEqual([])
}

function assistantText(event: SessionEvent): string {
  return messageText(event.data?.message)
}

function eventSeq(event: SessionEvent | undefined): number | undefined {
  const seq = (event as Record<string, any> | undefined)?.seq
  return typeof seq === 'number' ? seq : undefined
}

function headerCwd(event: SessionEvent): string | undefined {
  const cwd = (event as Record<string, any>).cwd
  return typeof cwd === 'string' ? cwd : undefined
}

function composerOf(frame: string): string | undefined {
  const lines = frame.split('\n')
  const marker = lines.findLastIndex(line => line.includes('❯'))
  if (marker < 0) return undefined
  const rules: number[] = []
  lines.forEach((line, index) => { if (/^─+$/u.test(line.trim())) rules.push(index) })
  const top = rules.filter(index => index < marker).at(-1)
  const bottom = rules.find(index => index > marker)
  if (top === undefined || bottom === undefined) return undefined
  return lines.slice(top + 1, bottom).join('\n')
}

async function exitChat(client: SplitProcessClient, label: string): Promise<void> {
  if (!client.closed) await client.exitGracefully()
  const facts = await client.close()
  expect(facts.code, `${label}: exit code`).toBe(0)
  expect(facts.signal, `${label}: exit signal`).toBeNull()
}

async function exitPublicLaunch(launch: PublicDaemonLaunch, label: string): Promise<void> {
  await launch.submit('/exit')
  const started = Date.now()
  for (;;) {
    const state = await launch.state()
    if (state.exited) {
      const exit = await launch.waitForExit(5_000)
      expect(exit.code, `${label}: public CLI exit code`).toBe(0)
      expect(exit.signal, `${label}: public CLI exit signal`).toBeNull()
      expect(exit.text, `${label}: daemon detach line`).toContain('Disconnected from dsh-pi-tui (daemon client).')
      await launch.close()
      return
    }
    const frame = await launch.text()
    if (frame.includes('Keep working and disconnect')) await launch.press('Enter')
    if (Date.now() - started >= 120_000) {
      throw new Error(`${label}: /exit did not reach a terminal fact; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(100)
  }
}

function assertClientHost(client: SplitProcessClient, host: SplitProcessHostHandle): void {
  expect(client.ready.hostPid).toBe(host.ready.localHost.hostPid)
  expect(client.ready.instanceId).toBe(host.ready.localHost.instanceId)
  expect(client.ready.scopeId).toBe(host.ready.localHost.scopeId)
  expect(client.ready.buildId).toBe(host.ready.localHost.buildId)
}

async function assertClientOwners(client: SplitProcessClient, count: 0 | 1): Promise<Record<string, any>> {
  const record = client.readRecords().find(value => value?.m4a0 === 'ready' && value.pid === client.ready.businessPid)
  expect(record, 'the real Client ready record').toBeDefined()
  for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
    expect(record?.owners?.[owner], `${owner} owner count`).toBe(count)
  }
  expect(record?.privateNamespaces, 'private Domain namespace count').toBe(3)
  return record!
}

async function startHeldSession(
  scene: SplitProcessScene,
  host: SplitProcessHostHandle,
  client: SplitProcessClient,
  prompt: string,
  label: string,
): Promise<string> {
  const before = new Set(await scene.sessionIds())
  await client.type(prompt)
  await waitFrame(client, prompt, `${label}: typed draft`)
  await client.submit()
  const sessionId = await scene.waitForNewSessionId(before, `${label}: Session id`)
  await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/start', `${label}: turn/start`)
  await fixtureHelpers.waitForC1WorkEvent(
    host.workloadRoot!,
    event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
    `${label}: held Turn`,
  )
  return sessionId
}

async function waitForTurnSettlement(
  scene: SplitProcessScene,
  sessionId: string,
  afterIndex: number,
  prompt: string,
  answer: string,
  label: string,
): Promise<{ user: SessionEvent; start: SessionEvent; end: SessionEvent; assistant: SessionEvent }> {
  const user = await scene.waitForSessionEvent(sessionId, afterIndex,
    event => isHumanUserEvent(event) && userText(event) === prompt,
    `${label}: durable human user/message`)
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
  const end = await scene.waitForSessionEvent(sessionId, afterIndex,
    event => event.type === 'turn/end' && event.data?.turn === turn,
    `${label}: matching turn/end`)
  const assistant = await scene.waitForSessionEvent(sessionId, afterIndex,
    event => event.type === 'assistant/message' && event.data?.turn === turn
      && assistantText(event).includes(answer),
    `${label}: durable assistant/message in the same Turn`)
  return { user, start: start!, end, assistant }
}

async function submitSettledPrompt(
  scene: SplitProcessScene,
  client: SplitProcessClient,
  sessionId: string,
  prompt: string,
  answer: string,
  label: string,
): Promise<{ boundary: number; turn: Awaited<ReturnType<typeof waitForTurnSettlement>> }> {
  const boundary = (scene.sessionEvents(sessionId) ?? []).length
  await client.type(prompt)
  await waitFrame(client, prompt, `${label}: typed draft`)
  await client.submit()
  const turn = await waitForTurnSettlement(scene, sessionId, boundary, prompt, answer, label)
  await waitFrameOrder(client, prompt, answer, `${label}: painted settlement`)
  return { boundary, turn }
}

test('two real Clients create isolated Sessions in their own launch workspaces and navigation keeps the captured Workspace', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let clientA: SplitProcessClient | undefined
  let clientB: SplitProcessClient | undefined
  let clientC: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'long-turn' })
    const directoriesA = clientDirectories(scene, 'workspace-a')
    writeFileSync(join(directoriesA.cwd, 'ws2-host-marker.txt'), 'client-workspace-A\n', { mode: 0o600, flag: 'wx' })
    clientA = await scene.startClient({ label: 'workspace-a', ...directoriesA })
    assertClientHost(clientA, host)
    await assertClientOwners(clientA, 1)
    expect(clientA.ready.sessionOpen).toBe(false)
    await waitFrame(clientA, 'type a message to start a session', 'A: sessionless Welcome')

    const sessionA = await startHeldSession(scene, host, clientA, 'session a', 'A')
    const beforeReleaseA = scene.sessionEvents(sessionA) ?? []
    expect(beforeReleaseA.some(event => event.type === 'turn/end')).toBe(false)
    releaseFile(host.holdReleasePath!, 'A: release held Turn')
    await waitForTurnSettlement(scene, sessionA, 0, 'session a', 'long-turn answer', 'A')
    const headerA = await scene.waitForHostSessionHeader(sessionA, 'A: durable header')
    expect(headerCwd(headerA)).toBe(directoriesA.cwd)

    const directoriesB = clientDirectories(scene, 'workspace-b')
    clientB = await scene.startClient({ label: 'workspace-b', ...directoriesB })
    assertClientHost(clientB, host)
    await assertClientOwners(clientB, 1)
    expect(clientB.ready.businessPid).not.toBe(clientA.ready.businessPid)
    await waitFrame(clientB, 'type a message to start a session', 'B: sessionless Welcome')
    const beforeB = new Set(await scene.sessionIds())
    await clientB.submit('session b')
    const sessionB = await scene.waitForNewSessionId(beforeB, 'B: distinct Session id')
    expect(sessionB).not.toBe(sessionA)
    await waitForTurnSettlement(scene, sessionB, 0, 'session b', 'long-turn answer', 'B')
    const headerB = await scene.waitForHostSessionHeader(sessionB, 'B: durable header')
    expect(headerCwd(headerB)).toBe(directoriesB.cwd)

    const eventsA = scene.sessionEvents(sessionA) ?? []
    const eventsB = scene.sessionEvents(sessionB) ?? []
    expect(humanUserTexts(eventsA)).toEqual(['session a'])
    expect(humanUserTexts(eventsB)).toEqual(['session b'])
    expectHumanPromptCount(eventsA, 'session a', 1)
    expectHumanPromptCount(eventsB, 'session b', 1)
    expect((await clientA.text()).includes('session b')).toBe(false)
    expect((await clientB.text()).includes('session a')).toBe(false)

    const bCloseBoundary = clientB.readRecords().length
    await exitChat(clientB, 'B')
    const bClosed = await waitForRecordAfter(clientB, bCloseBoundary,
      record => record?.m4b2s === 'client-closed', 'B: client-closed')
    for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
      expect(bClosed.owners?.[owner], `B: ${owner} released`).toBe(0)
    }
    expect(bClosed.activeWrappers).toBe(0)
    expect(bClosed.liveSockets).toBe(0)
    expect((await clientA.state()).exited).toBe(false)
    expect((await scene.hostStatus(host)).localHost.instanceId).toBe(host.ready.localHost.instanceId)

    const newBoundary = clientA.readRecords().length
    await clientA.submit('/new')
    const navigationSession = await waitForSurfaceStatusAfter(clientA, newBoundary,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string'
        && record.openSessionId !== sessionA && record.openSessionId !== sessionB,
      'A: /new published a distinct Session')
    const navigationId = String(navigationSession.openSessionId)
    await submitSettledPrompt(scene, clientA, navigationId, 'session navigation', 'long-turn answer', 'A: navigation Session')
    const navigationHeader = await scene.waitForHostSessionHeader(navigationId, 'A: navigation header')
    expect(headerCwd(navigationHeader)).toBe(headerCwd(headerA))

    for (const target of [sessionA, navigationId, sessionA]) {
      const boundary = clientA.readRecords().length
      await clientA.submit(`/resume ${target}`)
      const status = await waitForSurfaceStatusAfter(clientA, boundary,
        record => record.sessionOpen === true && record.openSessionId === target,
        `A: resumed ${target}`)
      expect(status.surfaceMounted).toBe(true)
      await waitFrame(clientA, target === sessionA ? 'session a' : 'session navigation', `A: ${target} history`)
    }
    expect(headerCwd(await scene.waitForHostSessionHeader(sessionA, 'A: header after navigation'))).toBe(headerCwd(headerA))
    expect(headerCwd(await scene.waitForHostSessionHeader(sessionB, 'B: header after A navigation'))).toBe(headerCwd(headerB))

    const directoriesC = clientDirectories(scene, 'workspace-c')
    writeFileSync(join(directoriesC.cwd, 'ws2-host-marker.txt'), 'client-workspace-C\n', { mode: 0o600, flag: 'wx' })
    clientC = await scene.startClient({ label: 'workspace-c', ...directoriesC, privateRpcProof: true })
    assertClientHost(clientC, host)
    const beforeC = new Set(await scene.sessionIds())
    await clientC.submit('session c')
    const sessionC = await scene.waitForNewSessionId(beforeC, 'C: own Session')
    await waitForTurnSettlement(scene, sessionC, 0, 'session c', 'long-turn answer', 'C')
    const headerC = await scene.waitForHostSessionHeader(sessionC, 'C: durable header')
    expect(headerCwd(headerC)).toBe(directoriesC.cwd)

    const ownProofBoundary = clientC.readRecords().length
    await clientC.signal('SIGUSR2')
    const ownProof = await waitForRecordAfter(clientC, ownProofBoundary,
      record => record?.m4b2s === 'qualification' && record.op === 'private-rpc-proof'
        && record.sessionId === sessionC,
      'C: own-Workspace private proof')
    expect(ownProof.workspaceMatchesClientCwd).toBe(true)
    expect(ownProof.workspacePathDigest).toBe(sessionHelpers.sha16(directoriesC.cwd))
    expect(ownProof.workspaceListCwdDigest).toBe(sessionHelpers.sha16(directoriesC.cwd))
    expect(ownProof.workspaceSessionDigests).toContain(sessionHelpers.sha16(sessionC))
    expect(ownProof.workspaceMarkerText).toBe('client-workspace-C')

    const resumeBoundary = clientC.readRecords().length
    await clientC.submit(`/resume ${sessionA}`)
    await waitForSurfaceStatusAfter(clientC, resumeBoundary,
      record => record.sessionOpen === true && record.openSessionId === sessionA,
      'C: resumed A from another launch Workspace')
    const crossNewBoundary = clientC.readRecords().length
    await clientC.submit('/new')
    const crossOpened = await waitForSurfaceStatusAfter(clientC, crossNewBoundary,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string'
        && record.openSessionId !== sessionA && record.openSessionId !== sessionC,
      'C: /new from A')
    const sessionD = String(crossOpened.openSessionId)
    await submitSettledPrompt(scene, clientC, sessionD, 'session d', 'long-turn answer', 'D')
    const headerD = await scene.waitForHostSessionHeader(sessionD, 'D: durable header')
    expect(headerCwd(headerD)).toBe(headerCwd(headerA))

    const proofBoundary = clientC.readRecords().length
    await clientC.signal('SIGUSR2')
    const crossProof = await waitForRecordAfter(clientC, proofBoundary,
      record => record?.m4b2s === 'qualification' && record.op === 'private-rpc-proof',
      'C: cross-Workspace private proof')
    expect(crossProof.sessionId).toBe(sessionD)
    expect(crossProof.workspaceMatchesClientCwd).toBe(false)
    expect(crossProof.workspacePathDigest).toBe(sessionHelpers.sha16(directoriesA.cwd))
    expect(crossProof.workspaceListCwdDigest).toBe(sessionHelpers.sha16(directoriesA.cwd))
    expect(crossProof.workspaceMarkerText).toBe('client-workspace-A')
    const rows = Array.isArray(crossProof.workspaceRows) ? crossProof.workspaceRows : []
    const rowA = rows.find(row => row.pathDigest === sessionHelpers.sha16(directoriesA.cwd))
    const rowC = rows.find(row => row.pathDigest === sessionHelpers.sha16(directoriesC.cwd))
    expect(rowA?.sessionDigests).toContain(sessionHelpers.sha16(sessionA))
    expect(rowA?.sessionDigests).toContain(sessionHelpers.sha16(sessionD))
    expect(rowC?.sessionDigests).toContain(sessionHelpers.sha16(sessionC))
    expect(headerCwd(await scene.waitForHostSessionHeader(sessionC, 'C: header after cross-Workspace /new'))).toBe(directoriesC.cwd)
    await exitChat(clientC, 'C')
    clientC = undefined
    expect((await clientA.state()).exited).toBe(false)

    await exitChat(clientA, 'A')
    await scene.stopHost(host)
    host = undefined
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'workspace isolation')
  }
})

test('a dropped prompt ACK reconciles once through the live Host without replaying the write', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'long-turn' })
    const seed = await scene.startClient({ label: 'ack-seed', ...clientDirectories(scene, 'ack-seed') })
    const sessionId = await startHeldSession(scene, host, seed, 'ack seed', 'seed')
    releaseFile(host.holdReleasePath!, 'seed: release held Turn')
    await waitForTurnSettlement(scene, sessionId, 0, 'ack seed', 'long-turn answer', 'seed')
    await exitChat(seed, 'seed')

    client = await scene.startClient({
      label: 'ack-drop',
      ...clientDirectories(scene, 'ack-drop'),
      sessionId,
      dropPromptAck: true,
    })
    assertClientHost(client, host)
    const token = 'ackdrop live host'
    await client.type(token)
    await waitFrame(client, token, 'ACK-drop: exact draft')
    const boundary = (scene.sessionEvents(sessionId) ?? []).length
    await client.submit()
    await client.waitForRecord(record => record?.m4b2s === 'qualification' && record.op === 'prompt-ack-dropped',
      'ACK-drop: real post-Host receipt witness')
    const turn = await waitForTurnSettlement(scene, sessionId, boundary, token, 'long-turn answer', 'ACK-drop')
    expect(turn.user.data?.id, 'the durable user occurrence identity').toBeTypeOf('string')

    let disposition: 'accepted' | 'unknown' | undefined
    const started = Date.now()
    while (Date.now() - started < 120_000) {
      const frame = await client.text()
      const composer = composerOf(frame)
      if (composer === undefined) throw new Error('ACK-drop: the current frame has no composer')
      const pending = frame.includes('Submitting…') || frame.includes('Queued…')
      const draft = composer.replace(/❯/gu, '').trim()
      if (!pending && draft === '') {
        expect(frame.includes('indeterminate')).toBe(false)
        disposition = 'accepted'
        break
      }
      if (!pending && draft === token && frame.includes('indeterminate')) {
        disposition = 'unknown'
        break
      }
      await sleep(50)
    }
    expect(disposition, 'ACK-drop: one legal settled Composer disposition').toBeDefined()
    expect(client.readRecords().filter(record => record?.m4b2s === 'qualification'
      && record.op === 'prompt-ack-dropped')).toHaveLength(1)
    await exitChat(client, 'ACK-drop')
    client = undefined

    const fresh = await scene.startClient({
      label: 'ack-reconcile',
      ...clientDirectories(scene, 'ack-reconcile'),
      sessionId,
    })
    assertClientHost(fresh, host)
    await waitFrame(fresh, token, 'fresh Client: reconciled history')
    const finalEvents = scene.sessionEvents(sessionId) ?? []
    expectHumanPromptCount(finalEvents, token, 1)
    expect(finalEvents.filter(event => isHumanUserEvent(event) && userText(event) === token)).toHaveLength(1)
    await exitChat(fresh, 'fresh Client')
    expect((await scene.hostStatus(host)).localHost.instanceId).toBe(host.ready.localHost.instanceId)
    await scene.stopHost(host)
    host = undefined
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'live-Host ACK recovery')
  }
})

test('public Clients keep private launch workspaces and one resumed writer appends exactly once', async () => {
  const scene = await createSplitProcessScene()
  const launches: PublicDaemonLaunch[] = []
  let primary: unknown
  try {
    const a = await scene.startPublicDaemon({
      label: 'public-workspace-a', backend: 'daemon', ownWorkspace: true, cols: 140, rows: 40,
    })
    launches.push(a)
    expect(a.ready).toBe(true)
    expect(a.launchCwd).not.toBe(scene.installation.profileDir)
    await waitFrame(a, '❯', 'A: public composer')
    const beforeA = new Set(await scene.sessionIds())
    await a.submit('public workspace seed A')
    const sessionX = await scene.waitForNewSessionId(beforeA, 'A: public Session X')
    const headerX = await scene.waitForHostSessionHeader(sessionX, 'A: public X header')
    expect(headerCwd(headerX)).toBe(a.launchCwd)
    await waitForTurnSettlement(scene, sessionX, 0, 'public workspace seed A', 'stub answer', 'A')
    await waitFrameOrder(a, 'public workspace seed A', 'stub answer', 'A: public seed settlement')

    const b = await scene.startPublicDaemon({
      label: 'public-workspace-b', backend: 'daemon', ownWorkspace: true, cols: 140, rows: 40,
    })
    launches.push(b)
    expect(b.ready).toBe(true)
    expect(b.launchCwd).not.toBe(a.launchCwd)
    expect(b.launchCwd).not.toBe(scene.installation.profileDir)
    expect(b.host?.pid).toBe(a.host?.pid)
    expect(b.host?.birth).toBe(a.host?.birth)
    expect(b.host?.instanceId).toBe(a.host?.instanceId)
    await waitFrame(b, '❯', 'B: public composer')
    const beforeB = new Set(await scene.sessionIds())
    await b.submit('public workspace seed B')
    const sessionY = await scene.waitForNewSessionId(beforeB, 'B: public Session Y')
    expect(sessionY).not.toBe(sessionX)
    const headerY = await scene.waitForHostSessionHeader(sessionY, 'B: public Y header')
    expect(headerCwd(headerY)).toBe(b.launchCwd)
    await waitForTurnSettlement(scene, sessionY, 0, 'public workspace seed B', 'stub answer', 'B')
    await waitFrameOrder(b, 'public workspace seed B', 'stub answer', 'B: public seed settlement')
    expect((await a.text()).includes('public workspace seed B')).toBe(false)
    expect((await b.text()).includes('public workspace seed A')).toBe(false)

    const beforeC = new Set(await scene.sessionIds())
    const yBeforeC = scene.sessionEvents(sessionY) ?? []
    const c = await scene.startPublicDaemon({
      label: 'public-workspace-c', backend: 'daemon', ownWorkspace: true,
      args: { session: sessionX }, cols: 140, rows: 40,
    })
    launches.push(c)
    expect(c.ready).toBe(true)
    expect(c.launchCwd).not.toBe(a.launchCwd)
    expect(c.launchCwd).not.toBe(b.launchCwd)
    expect(c.launchCwd).not.toBe(scene.installation.profileDir)
    expect(c.host?.pid).toBe(a.host?.pid)
    expect(c.host?.birth).toBe(a.host?.birth)
    expect(c.host?.instanceId).toBe(a.host?.instanceId)
    expect(new Set([a.cli?.pid, b.cli?.pid, c.cli?.pid]).size).toBe(3)
    expect(new Set([a.client?.pid, b.client?.pid, c.client?.pid]).size).toBe(3)
    expect(new Set([a.sessionId, b.sessionId, c.sessionId]).size).toBe(3)
    await waitFrame(c, 'public workspace seed A', 'C: resumed X history')
    expect((await a.kernelState()).clientState).toBe('alive')
    expect((await b.kernelState()).clientState).toBe('alive')
    expect((await c.kernelState()).clientState).toBe('alive')
    expect((await scene.sessionIds()).sort()).toEqual([...beforeC].sort())
    expect(scene.sessionEvents(sessionY)).toEqual(yBeforeC)
    const expectedSessions = [...beforeC].sort()

    const beforeCut = scene.sessionEvents(sessionX) ?? []
    expect(beforeCut.some(event => event.type === 'turn/end'), 'X must be terminal before C submits').toBe(true)
    const cut = beforeCut.length
    const lastSeq = eventSeq(beforeCut.at(-1))
    const yBefore = scene.sessionEvents(sessionY) ?? []
    const writerText = 'public concurrent single writer'
    await c.submit(writerText)
    const turn = await waitForTurnSettlement(scene, sessionX, cut, writerText, 'stub answer', 'C')
    expect(eventSeq(turn.user)).toBeTypeOf('number')
    expect(eventSeq(turn.user)!).toBeGreaterThan(lastSeq ?? 0)
    await waitFrameOrder(a, writerText, 'stub answer', 'A: observed C write')
    await waitFrameOrder(c, writerText, 'stub answer', 'C: observed own write')

    const finalX = scene.sessionEvents(sessionX) ?? []
    const afterCut = finalX.slice(cut)
    const committedWrites = afterCut.filter(event => isHumanUserEvent(event) && userText(event) === writerText)
    expect(committedWrites).toHaveLength(1)
    const occurrenceId = committedWrites[0]?.data?.id
    expect(occurrenceId, 'the new durable human occurrence identity').toBeTypeOf('string')
    expect(occurrenceId).not.toBe('')
    const insertedWrites = afterCut
      .filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => Array.isArray(event.data?.inserted) ? event.data.inserted : [])
      .filter(message => messageText(message) === writerText)
    for (const message of insertedWrites) {
      expect(message.source?.kind, 'an inbox occurrence of the authored prompt must carry the human source').toBe('user')
      expect(message.id).toBe(occurrenceId)
    }
    expectHumanPromptCount(finalX, writerText, 1)
    expect(afterCut.filter(event => event.type === 'turn/start' && event.data?.turn === turn.start.data?.turn)).toHaveLength(1)
    expect(afterCut.filter(event => event.type === 'turn/end' && event.data?.turn === turn.end.data?.turn)).toHaveLength(1)
    expect(afterCut.filter(event => event.type === 'assistant/message'
      && event.data?.turn === turn.end.data?.turn
      && assistantText(event).includes('stub answer'))).toHaveLength(1)
    expect(headerCwd(await scene.waitForHostSessionHeader(sessionX, 'X: header after C write'))).toBe(a.launchCwd)
    expect(scene.sessionEvents(sessionY)).toEqual(yBefore)
    expect((await scene.sessionIds()).sort()).toEqual(expectedSessions)

    await exitPublicLaunch(c, 'C')
    await exitPublicLaunch(b, 'B')
    await exitPublicLaunch(a, 'A')
    expect((await a.kernelState()).hostState).toBe('alive')
    expect((await a.daemonStatus()).fields.host).toBe('ready')
    await a.stopHost()
    expect((await a.daemonStatus()).fields.host).toBe('stopped')
  } catch (error) {
    primary = error
    throw error
  } finally {
    const cleanupErrors: Error[] = []
    for (const launch of [...launches].reverse()) {
      if (launch.closed) continue
      try { await launch.reclaim() } catch (error) { cleanupErrors.push(asError(error)) }
    }
    try { await scene.dispose() } catch (error) { cleanupErrors.push(asError(error)) }
    if (cleanupErrors.length > 0) {
      if (primary !== undefined) throw new AggregateError([primary, ...cleanupErrors], 'public A06/A13 and cleanup both failed')
      throw new AggregateError(cleanupErrors, 'public A06/A13 cleanup failed')
    }
  }
})

async function waitForComposerDraft(client: SplitProcessClient, text: string, label: string): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    const composer = composerOf(frame)
    if (composer !== undefined) {
      const occurrences = composer.split(text).length - 1
      if (occurrences === 1) return composer
    }
    if (Date.now() - started >= 120_000) {
      throw new Error(`${label}: the exact draft was not restored once; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(50)
  }
}

async function waitForComposerSettled(client: SplitProcessClient, label: string): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (composerOf(frame) !== undefined && !frame.includes('Submitting…') && !frame.includes('Queued…')) return frame
    if (Date.now() - started >= 120_000) throw new Error(`${label}: the Composer/ACK did not settle`)
    await sleep(50)
  }
}

async function proveDraftEditableAndClear(client: SplitProcessClient, text: string, label: string): Promise<void> {
  await client.type('x')
  const edited = await waitForComposerDraft(client, `${text}x`, `${label}: editable draft`)
  expect(edited.split(text).length - 1, `${label}: original draft occurrence count`).toBe(1)
  await client.press('Ctrl+U')
  const started = Date.now()
  for (;;) {
    const composer = composerOf(await client.text())
    if (composer !== undefined && !composer.includes(text)) return
    if (Date.now() - started >= 120_000) throw new Error(`${label}: the restored draft did not clear`)
    await sleep(50)
  }
}

test('the mounted private Namespaces read the Session Workspace and official file authorities', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    const directories = clientDirectories(scene, 'private-proof')
    mkdirSync(join(directories.cwd, 'dist'), { recursive: true, mode: 0o700 })
    writeFileSync(join(directories.cwd, 'ws2-host-marker.txt'), 'client-workspace-A\n', { mode: 0o600, flag: 'wx' })
    writeFileSync(join(directories.cwd, 't36notes.md'), 'private file reference\n', { mode: 0o600, flag: 'wx' })
    writeFileSync(join(directories.cwd, 'dist', 't36only-scoped.js'), 'x\n', { mode: 0o600, flag: 'wx' })
    writeFileSync(join(scene.installation.base.env.HOME!, 't36home-note.md'), 'private home reference\n', { mode: 0o600, flag: 'wx' })

    host = await scene.startHost({ scenario: 'long-turn' })
    client = await scene.startClient({ label: 'private-proof', ...directories, privateRpcProof: true })
    const sessionA = await startHeldSession(scene, host, client, 'private proof a', 'private A')
    releaseFile(host.holdReleasePath!, 'private A: release held Turn')
    await waitForTurnSettlement(scene, sessionA, 0, 'private proof a', 'long-turn answer', 'private A')

    const newBoundary = client.readRecords().length
    await client.submit('/new')
    const opened = await waitForSurfaceStatusAfter(client, newBoundary,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string'
        && record.openSessionId !== sessionA,
      'private proof: /new Session')
    const sessionB = String(opened.openSessionId)
    await submitSettledPrompt(scene, client, sessionB, 'private proof b', 'long-turn answer', 'private B')

    const boundary = client.readRecords().length
    await client.signal('SIGUSR2')
    const proof = await waitForRecordAfter(client, boundary,
      record => record?.m4b2s === 'qualification' && record.op === 'private-rpc-proof',
      'private proof: real wire witness')
    expect(proof.error).toBeUndefined()
    expect(proof.sessionId).toBe(sessionB)
    expect(proof.fileOk).toBe(true)
    expect(proof.fileKind).toBeTypeOf('string')
    expect(proof.terminalKind).toBe('snapshot')
    expect(proof.owners?.sessions).toBe(1)
    expect(proof.privateNamespaces).toBe(3)
    expect(proof.bareOfficial).toBe(true)
    expect(proof.officialEmpty).toBe(true)
    expect(proof.officialExcludesDist).toBe(true)
    expect(proof.scopedOk).toBe(true)
    expect(proof.scopedHostScanner).toBe(true)
    expect(proof.homeAbsolute).toBe(true)
    expect(proof.workspaceMatchesClientCwd).toBe(true)
    expect(proof.workspacePathDigest).toBe(sessionHelpers.sha16(directories.cwd))
    expect(proof.workspaceSessionDigests).toContain(sessionHelpers.sha16(sessionA))
    expect(proof.workspaceSessionDigests).toContain(sessionHelpers.sha16(sessionB))
    expect(proof.workspaceListCwdDigest).toBe(sessionHelpers.sha16(directories.cwd))
    expect(proof.workspaceMarkerText).toBe('client-workspace-A')
    await exitChat(client, 'private proof')
    client = undefined
    await scene.stopHost(host)
    host = undefined
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'private wire proof')
  }
})

test('an invalid Host workspace proposal creates no Session and leaves the draft editable', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost()
    const before = new Set(await scene.sessionIds())
    const logsBefore = scene.hostSessionLogCount()
    client = await scene.startClient({
      label: 'invalid-workspace', ...clientDirectories(scene, 'invalid-workspace'), invalidWorkspacePath: true,
    })
    expect(client.ready.sessionOpen).toBe(false)
    const token = 'invalid workspace draft'
    await client.type(token)
    await waitFrame(client, token, 'invalid Workspace: typed draft')
    await client.submit()
    const refusal = await waitFrame(client, 'could not start a session', 'invalid Workspace: real refusal')
    expect(refusal).toContain('Host directory:')
    expect(refusal).toContain('Cancel [Esc]')
    await client.press('Escape')
    const chooser = await waitFrame(client, 'Enter Add directory', 'invalid Workspace: returned to workspace chooser')
    expect(chooser).toContain('Close [Esc]')
    await client.press('Escape')
    const returned = await waitFrame(client, 'type a message to start a session', 'invalid Workspace: cancelled picker')
    expect(returned).toContain('❯')
    await waitForComposerDraft(client, token, 'invalid Workspace: restored draft')
    await waitForComposerSettled(client, 'invalid Workspace: settled refusal')
    await proveDraftEditableAndClear(client, token, 'invalid Workspace')
    expect((await scene.sessionIds()).sort()).toEqual([...before].sort())
    expect(scene.hostSessionLogCount()).toBe(logsBefore)
    expect((await scene.hostStatus(host)).localHost.instanceId).toBe(host.ready.localHost.instanceId)
    await exitChat(client, 'invalid Workspace')
    client = undefined
    await scene.stopHost(host)
    host = undefined
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'invalid Host Workspace')
  }
})

test('stops a surface in each declared pre-ready window', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let primary: unknown
  try {
    host = await scene.startHost()
    for (const stage of ['domain', 'surface', 'loader-gate', 'before-start'] as const) {
      const stopped = await scene.startClientStop({
        label: `stop-${stage}`, ...clientDirectories(scene, `stop-${stage}`), startupStop: stage,
      })
      expect(stopped.stage).toBe(stage)
      expect(stopped.pid).toBeTypeOf('number')
      expect(stopped.birth).toBeTypeOf('string')
      expect(stopped.hostPid).toBe(host.ready.localHost.hostPid)
      expect(stopped.hostInstanceId).toBe(host.ready.localHost.instanceId)
      expect(stopped.exit).toEqual({ code: 0, signal: null })
      expect(stopped.terminal).toEqual({ kind: 'native', code: 0, signal: null })

      const reuse = await scene.startClient({
        label: `reuse-${stage}`, ...clientDirectories(scene, `reuse-${stage}`),
      })
      expect(reuse.ready.surfaceMounted).toBe(true)
      assertClientHost(reuse, host)
      await exitChat(reuse, `reuse-${stage}`)
      expect((await scene.hostStatus(host)).localHost.instanceId).toBe(host.ready.localHost.instanceId)
    }
    await scene.stopHost(host)
    host = undefined
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'pre-ready stop windows')
  }
})

test('closing writer admission while serialization is held restores the draft without a Host write', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'long-turn' })
    const seed = await scene.startClient({ label: 'hold-seed', ...clientDirectories(scene, 'hold-seed') })
    const sessionId = await startHeldSession(scene, host, seed, 'hold seed', 'hold seed')
    releaseFile(host.holdReleasePath!, 'hold seed: release held Turn')
    await waitForTurnSettlement(scene, sessionId, 0, 'hold seed', 'long-turn answer', 'hold seed')
    await exitChat(seed, 'hold seed')

    client = await scene.startClient({
      label: 'serializer-stop', ...clientDirectories(scene, 'serializer-stop'), sessionId, holdSerialize: true,
    })
    expect(client.serializeBarrierPath).not.toBeNull()
    const stale = 'held admission stop'
    await client.type(stale)
    await waitFrame(client, stale, 'serializer stop: typed draft')
    const boundary = client.readRecords().length
    await client.submit()
    await waitForRecordAfter(client, boundary,
      record => record?.m4b2s === 'qualification' && record.op === 'serialize-held',
      'serializer stop: real serializer hold')
    await client.signal('SIGUSR2')
    await waitForRecordAfter(client, boundary,
      record => record?.m4b2s === 'qualification' && record.op === 'stop-surface-admission',
      'serializer stop: admission closed')
    client.releaseSerializeHold()
    await waitForComposerDraft(client, stale, 'serializer stop: restored draft')
    await waitForComposerSettled(client, 'serializer stop: settled cancellation')
    expect((await client.text()).includes('indeterminate')).toBe(false)
    await proveDraftEditableAndClear(client, stale, 'serializer stop')
    await exitChat(client, 'serializer stop: held Client')
    client = undefined

    client = await scene.startClient({
      label: 'serializer-stop-positive', ...clientDirectories(scene, 'serializer-stop-positive'), sessionId,
    })
    assertClientHost(client, host)
    expect(client.ready.sessionOpen).toBe(true)
    expect(client.ready.openSessionId).toBe(sessionId)
    const positive = await submitSettledPrompt(scene, client, sessionId, 'after admission stop', 'long-turn answer', 'serializer stop: positive write')
    const finalEvents = scene.sessionEvents(sessionId) ?? []
    expectHumanPromptCount(finalEvents, stale, 0)
    expectHumanPromptCount(finalEvents, 'after admission stop', 1)
    expect(finalEvents.filter(event => event.type === 'turn/start'
      && event.data?.turn === positive.turn.start.data?.turn)).toHaveLength(1)
    expect(finalEvents.filter(event => event.type === 'turn/end'
      && event.data?.turn === positive.turn.end.data?.turn)).toHaveLength(1)
    await exitChat(client, 'serializer stop: positive Client')
    client = undefined
    await scene.stopHost(host)
    host = undefined
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'serializer admission stop')
  }
})

test('a generation rollover refuses the held stale write and accepts one fresh write on the same Session', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'long-turn' })
    const seed = await scene.startClient({ label: 'rollover-seed', ...clientDirectories(scene, 'rollover-seed') })
    const sessionId = await startHeldSession(scene, host, seed, 'rollover seed', 'rollover seed')
    releaseFile(host.holdReleasePath!, 'rollover seed: release held Turn')
    await waitForTurnSettlement(scene, sessionId, 0, 'rollover seed', 'long-turn answer', 'rollover seed')
    await exitChat(seed, 'rollover seed')

    client = await scene.startClient({
      label: 'rollover-held', ...clientDirectories(scene, 'rollover-held'), sessionId, holdSerialize: true,
    })
    const generationBefore = client.ready.generationId
    expect(generationBefore).toBeTypeOf('number')
    const stale = 'stale generation token'
    await client.type(stale)
    await waitFrame(client, stale, 'rollover: typed stale draft')
    const boundary = client.readRecords().length
    await client.submit()
    await waitForRecordAfter(client, boundary,
      record => record?.m4b2s === 'qualification' && record.op === 'serialize-held',
      'rollover: real serializer hold')
    await client.signal('SIGUSR1')
    const rolled = await waitForSurfaceStatusAfter(client, boundary,
      record => record.transport === 'connected' && record.sessionOpen === true
        && record.openSessionId === sessionId && typeof record.generationId === 'number'
        && record.generationId > generationBefore!,
      'rollover: strictly newer connected generation')
    const rolledHost = await scene.hostStatus(host)
    expect(rolledHost.localHost.hostPid).toBe(host.ready.localHost.hostPid)
    expect(rolledHost.localHost.instanceId).toBe(host.ready.localHost.instanceId)
    client.releaseSerializeHold()
    await waitForComposerDraft(client, stale, 'rollover: restored stale draft')
    await waitForComposerSettled(client, 'rollover: settled cancellation')
    expect((await client.text()).includes('indeterminate')).toBe(false)
    await proveDraftEditableAndClear(client, stale, 'rollover')

    const liveBoundary = (scene.sessionEvents(sessionId) ?? []).length
    const live = await submitSettledPrompt(scene, client, sessionId, 'fresh generation token', 'long-turn answer', 'rollover: fresh write')
    const finalEvents = scene.sessionEvents(sessionId) ?? []
    const afterLive = finalEvents.slice(liveBoundary)
    expectHumanPromptCount(finalEvents, stale, 0)
    expectHumanPromptCount(finalEvents, 'fresh generation token', 1)
    expect(afterLive.filter(event => event.type === 'turn/start' && event.data?.turn === live.turn.start.data?.turn)).toHaveLength(1)
    expect(afterLive.filter(event => event.type === 'turn/end' && event.data?.turn === live.turn.end.data?.turn)).toHaveLength(1)
    await exitChat(client, 'rollover')
    client = undefined
    await scene.stopHost(host)
    host = undefined
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'generation rollover')
  }
})

test('refuses an absent installed Client Domain module and restores the same Host', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let primary: unknown
  try {
    host = await scene.startHost()
    const sessionsBefore = await scene.sessionIds()
    const fault = await scene.setInstallationFault('client-domain-module-absent')
    expect(fault.fault).toBe('client-domain-module-absent')
    const failure = await scene.startClientFailure({
      label: 'missing-domain', ...clientDirectories(scene, 'missing-domain'),
      expectedFailure: 'client-domain-module-absent',
    })
    expect(failure.hostPid).toBe(host.ready.localHost.hostPid)
    expect(failure.hostInstanceId).toBe(host.ready.localHost.instanceId)
    expect(failure.exit).toEqual({ code: 1, signal: null })
    expect(failure.terminal).toEqual({ kind: 'native', code: 1, signal: null })
    expect(failure.failure.moduleAbsent).toBe(true)
    expect((await scene.sessionIds()).sort()).toEqual([...sessionsBefore].sort())
    expect((await scene.hostStatus(host)).localHost.instanceId).toBe(host.ready.localHost.instanceId)

    await scene.restoreInstallation()
    const restored = await scene.startClient({
      label: 'missing-domain-restored', ...clientDirectories(scene, 'missing-domain-restored'),
    })
    expect(restored.ready.surfaceMounted).toBe(true)
    assertClientHost(restored, host)
    await exitChat(restored, 'restored Domain Client')
    expect((await scene.hostStatus(host)).localHost.instanceId).toBe(host.ready.localHost.instanceId)
    await scene.stopHost(host)
    host = undefined
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'missing Client Domain module')
  }
})

test('keeps a held Turn across a declared Client business kill', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'long-turn' })
    client = await scene.startClient({
      label: 'business-kill', ...clientDirectories(scene, 'business-kill'), terminal: 'business-kill',
    })
    const sessionId = await startHeldSession(scene, host, client, 'held business kill', 'business kill')
    const beforeKill = scene.sessionEvents(sessionId) ?? []
    const heldStart = beforeKill.filter(event => event.type === 'turn/start').at(-1)
    expect(heldStart?.data?.turn, 'the held human Turn identity').toBeTypeOf('number')
    const heldTurn = heldStart!.data!.turn
    expect(beforeKill.some(event => event.type === 'turn/end' && event.data?.turn === heldTurn)).toBe(false)
    const hostBefore = await scene.hostStatus(host)

    const dispatched = await client.killBusiness()
    expect(dispatched.pid).toBe(client.ready.businessPid)
    expect(dispatched.birth).toBeTypeOf('string')
    expect(dispatched.signal).toBe('SIGKILL')
    const exited = await client.waitForExit(120_000)
    expect([
      { code: null, signal: 'SIGKILL' },
      { code: 137, signal: null },
    ]).toContainEqual({ code: exited.code, signal: exited.signal })
    const closed = await client.close()
    const terminal = closed.terminal ?? { kind: 'native', code: closed.code, signal: closed.signal }
    expect([
      { code: null, signal: 'SIGKILL' },
      { code: 137, signal: null },
    ]).toContainEqual({ code: terminal.code, signal: terminal.signal })
    const killedState = await client.state()
    expect(killedState.exited).toBe(true)
    expect(['gone', 'reused']).toContain(killedState.businessStates[0]?.state)
    expect((await scene.hostStatus(host)).localHost.instanceId).toBe(hostBefore.localHost.instanceId)
    expect((scene.sessionEvents(sessionId) ?? []).some(event => event.type === 'turn/end' && event.data?.turn === heldTurn)).toBe(false)
    client = undefined

    releaseFile(host.holdReleasePath!, 'business kill: release held Turn')
    const firstTurn = await waitForTurnSettlement(scene, sessionId, 0, 'held business kill', 'long-turn answer', 'business kill: detached settlement')
    expect(firstTurn.start.data?.turn).toBe(heldTurn)
    const fresh = await scene.startClient({
      label: 'business-kill-readback', ...clientDirectories(scene, 'business-kill-readback'), sessionId,
    })
    assertClientHost(fresh, host)
    await waitFrame(fresh, 'held business kill', 'business kill: fresh history')
    await waitFrame(fresh, 'long-turn answer', 'business kill: fresh answer')
    const secondTurn = await submitSettledPrompt(scene, fresh, sessionId, 'after business kill', 'long-turn answer', 'business kill: live append')
    expect(secondTurn.turn.start.data?.turn).not.toBe(firstTurn.start.data?.turn)
    const finalEvents = scene.sessionEvents(sessionId) ?? []
    expectHumanPromptCount(finalEvents, 'held business kill', 1)
    expectHumanPromptCount(finalEvents, 'after business kill', 1)
    for (const turn of [firstTurn, secondTurn.turn]) {
      expect(finalEvents.filter(event => event.type === 'turn/start'
        && event.data?.turn === turn.start.data?.turn)).toHaveLength(1)
      expect(finalEvents.filter(event => event.type === 'turn/end'
        && event.data?.turn === turn.end.data?.turn)).toHaveLength(1)
    }
    await exitChat(fresh, 'business kill readback')
    await scene.stopHost(host)
    host = undefined
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'declared Client business kill')
  }
})
