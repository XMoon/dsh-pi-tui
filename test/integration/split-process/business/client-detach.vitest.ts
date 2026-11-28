import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'vitest'

import { readOfficialClientRecords } from '../../../support/split-process-client.ts'
import {
  createSplitProcessScene,
  keepAndDisconnect,
  type SessionEvent,
  type SplitProcessClient,
  type SplitProcessHostHandle,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

type WorkEvent = Record<string, any>
type ClientRecord = Record<string, any>

const fixtureHelpers = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-fixtures.mjs')).href
) as {
  readC1WorkEvents(root: string): WorkEvent[]
  waitForC1WorkEvent(
    root: string,
    predicate: (event: WorkEvent) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<WorkEvent>
}

function clientDirectories(scene: SplitProcessScene, label: string): { home: string; cwd: string } {
  const root = join(scene.workDir, 'clients', label)
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  return { home, cwd }
}

function messageText(message: Record<string, any> | undefined): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => typeof part?.text === 'string' ? part.text : '').join('')
}

function userText(event: SessionEvent | undefined): string {
  return messageText(event?.data)
}

function assistantText(event: SessionEvent | undefined): string {
  return messageText(event?.data?.message)
}

async function waitFrame(client: SplitProcessClient, text: string, label: string): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (frame.includes(text)) return frame
    if (Date.now() - started >= 120_000) {
      throw new Error(`${label}: ${JSON.stringify(text)} was not painted; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(25)
  }
}

async function waitFrameGone(client: SplitProcessClient, text: string, label: string): Promise<void> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (!frame.includes(text)) return
    if (Date.now() - started >= 120_000) {
      throw new Error(`${label}: ${JSON.stringify(text)} stayed painted; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(25)
  }
}

function composerDraft(frame: string): string | undefined {
  const lines = frame.split('\n')
  const marker = lines.findLastIndex(line => line.trimStart().startsWith('❯'))
  if (marker < 0) return undefined
  const at = lines[marker]!.indexOf('❯')
  return lines[marker]!.slice(at + '❯'.length).trim()
}

async function waitForComposerDraft(client: SplitProcessClient, expected: string, label: string): Promise<void> {
  const started = Date.now()
  for (;;) {
    const draft = composerDraft(await client.text())
    if (draft === expected) return
    if (Date.now() - started >= 30_000) {
      throw new Error(`${label}: composer draft was ${JSON.stringify(draft)}, expected ${JSON.stringify(expected)}`)
    }
    await sleep(25)
  }
}

function clientRecords(client: SplitProcessClient, streaming = false): ClientRecord[] {
  return readOfficialClientRecords(client.recordFile, client.label, { allowIncompleteTail: streaming })
}

function recordCount(client: SplitProcessClient): number {
  return clientRecords(client, true).length
}

function recordsAfter(client: SplitProcessClient, afterIndex: number): ClientRecord[] {
  return clientRecords(client, true).slice(afterIndex)
}

async function waitForSurfaceStatusAfter(
  client: SplitProcessClient,
  afterIndex: number,
  predicate: (record: ClientRecord) => boolean,
  label: string,
): Promise<ClientRecord> {
  const started = Date.now()
  for (;;) {
    const record = recordsAfter(client, afterIndex)
      .filter(candidate => candidate.m4b2s === 'surface-status')
      .find(predicate)
    if (record !== undefined) return record
    if (Date.now() - started >= 120_000) {
      throw new Error(`${label}: no fresh surface-status record within 120000ms`)
    }
    await sleep(25)
  }
}

async function waitRecordAfter(
  client: SplitProcessClient,
  afterIndex: number,
  predicate: (record: ClientRecord) => boolean,
  label: string,
): Promise<ClientRecord> {
  const started = Date.now()
  for (;;) {
    const record = recordsAfter(client, afterIndex).find(predicate)
    if (record !== undefined) return record
    if (Date.now() - started >= 120_000) {
      throw new Error(`${label}: no fresh official record within 120000ms`)
    }
    await sleep(25)
  }
}

async function waitForWorkAfter(
  host: SplitProcessHostHandle,
  afterIndex: number,
  predicate: (event: WorkEvent) => boolean,
  label: string,
): Promise<WorkEvent> {
  expect(host.workloadRoot, 'the Host has no registered workload root').toBeTypeOf('string')
  const root = host.workloadRoot!
  const started = Date.now()
  for (;;) {
    const event = fixtureHelpers.readC1WorkEvents(root).slice(afterIndex).find(predicate)
    if (event !== undefined) return event
    if (Date.now() - started >= 120_000) {
      throw new Error(`${label}: no fresh Host workload event within 120000ms`)
    }
    await sleep(25)
  }
}

function holdPath(host: SplitProcessHostHandle): string {
  expect(host.holdReleasePath, 'the Host has no registered hold barrier').toBeTypeOf('string')
  return host.holdReleasePath!
}

function releaseHold(host: SplitProcessHostHandle): void {
  writeFileSync(holdPath(host), 'release\n', { mode: 0o600, flag: 'wx' })
}

async function waitForUserMessage(
  scene: SplitProcessScene,
  sessionId: string,
  afterIndex: number,
  predicate: (event: SessionEvent) => boolean,
  label: string,
): Promise<SessionEvent> {
  return await scene.waitForSessionEvent(sessionId, afterIndex,
    event => event.type === 'user/message' && predicate(event), label)
}

function durableEventIndex(events: SessionEvent[], event: SessionEvent, label: string): number {
  const seq = (event as SessionEvent & { seq?: unknown }).seq
  expect(seq, `${label}: durable event has no sequence`).toBeTypeOf('number')
  const index = events.findIndex(candidate => (candidate as SessionEvent & { seq?: unknown }).seq === seq)
  expect(index, `${label}: durable event is absent from the cut`).toBeGreaterThanOrEqual(0)
  return index
}

function claimedTurn(
  events: SessionEvent[],
  claim: SessionEvent,
  label: string,
): { turn: number; startIndex: number } {
  const messageId = claim.data?.id
  expect(messageId, `${label}: claimed message identity`).toBeTypeOf('string')
  const claimIndex = durableEventIndex(events, claim, `${label} claim`)
  const startIndex = events.slice(0, claimIndex).findLastIndex(event => event.type === 'turn/start')
  expect(startIndex, `${label}: no authoritative turn/start precedes the claim`).toBeGreaterThanOrEqual(0)
  const turn = events[startIndex]?.data?.turn
  expect(turn, `${label}: turn/start carries no numeric Turn identity`).toBeTypeOf('number')
  expect(events.slice(startIndex + 1, claimIndex).some(event =>
    event.type === 'turn/end' && event.data?.turn === turn),
  `${label}: the preceding Turn already ended before the claim`).toBe(false)
  return { turn: turn as number, startIndex }
}

async function waitForTurnEnd(
  scene: SplitProcessScene,
  sessionId: string,
  afterIndex: number,
  turn: number,
  label: string,
): Promise<SessionEvent> {
  return await scene.waitForSessionEvent(sessionId, afterIndex,
    event => event.type === 'turn/end' && event.data?.turn === turn, label)
}

function expectOneUser(
  events: SessionEvent[],
  id: string,
  text: string,
  label: string,
): void {
  const matches = events.filter(event => event.type === 'user/message' && event.data?.id === id)
  expect(matches, `${label}: exact occurrence count`).toHaveLength(1)
  expect(userText(matches[0]), `${label}: exact occurrence text`).toBe(text)
  expect(matches[0]?.data?.source?.kind, `${label}: occurrence is not human-authored`).toBe('user')
}

async function stopAndDisconnect(client: SplitProcessClient, label: string): Promise<void> {
  await client.submit('/exit')
  await waitFrame(client, 'Disconnect from dsh-pi-tui', `${label}: busy exit choice`)
  await waitFrame(client, '> Keep working and disconnect', `${label}: Keep is the default row`)
  await client.press('Down')
  await waitFrame(client, '> Stop current work and disconnect', `${label}: Stop row focused`)
  await client.press('Enter')
  const exit = await client.waitForExit()
  expect(exit, `${label}: native Stop exit`).toMatchObject({ code: 0, signal: null })
  const closed = await client.close()
  expect(closed, `${label}: Supervisor Stop close`).toMatchObject({ code: 0, signal: null })
  expect(client.closed, `${label}: Supervisor close settlement`).toBe(true)
}

async function expectHostIdentity(scene: SplitProcessScene, host: SplitProcessHostHandle, label: string): Promise<void> {
  const status = await scene.hostStatus(host)
  expect(status.localHost.hostPid, `${label}: Host PID changed`).toBe(host.ready.localHost.hostPid)
  expect(status.localHost.instanceId, `${label}: Host instance changed`).toBe(host.ready.localHost.instanceId)
}

async function disposeScene(scene: SplitProcessScene, primary: unknown, label: string): Promise<void> {
  try {
    await scene.dispose()
  } catch (cleanupError) {
    if (primary !== undefined) {
      throw new AggregateError([primary, cleanupError], `${label}: test failure and Scene cleanup failure`)
    }
    throw cleanupError
  }
}

async function startHeldSession(
  scene: SplitProcessScene,
  host: SplitProcessHostHandle,
  client: SplitProcessClient,
  prompt: string,
  label: string,
): Promise<{ sessionId: string; seed: SessionEvent }> {
  const before = new Set(await scene.sessionIds())
  const workBoundary = fixtureHelpers.readC1WorkEvents(host.workloadRoot!).length
  await client.submit(prompt)
  const sessionId = await scene.waitForNewSessionId(before, `${label}: Session creation`)
  await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!,
    event => event.kind === 'long-turn-held' && event.sessionId === sessionId, `${label}: held Turn`)
  const seed = await waitForUserMessage(scene, sessionId, 0,
    event => userText(event) === prompt, `${label}: accepted occurrence`)
  expect(seed.data?.id, `${label}: occurrence identity`).toBeTypeOf('string')
  await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/start', `${label}: turn/start`)
  return { sessionId, seed }
}

function expectBusinessHangupExit(
  exit: { code: number | null; signal: string | null },
  label: string,
): void {
  expect(exit.code === null && exit.signal === 'SIGHUP' || exit.code === 129 && exit.signal === null,
    `${label}: unexpected native business-hangup terminal ${JSON.stringify(exit)}`).toBe(true)
}

test('finishes accepted work after the last Client disconnects', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'long-turn' })
    const clientA = await scene.startClient({
      label: 'last-detach-source',
      ...clientDirectories(scene, 'last-detach-source'),
    })
    const prompt = 'last detach accepted prompt'
    const { sessionId, seed } = await startHeldSession(scene, host, clientA, prompt, 'last detach source')
    const clientB = await scene.startClient({
      label: 'last-detach-peer',
      ...clientDirectories(scene, 'last-detach-peer'),
      sessionId,
    })
    expect(clientB.ready.openSessionId, 'peer did not attach to the accepted Session').toBe(sessionId)
    await waitFrame(clientB, prompt, 'peer read the accepted occurrence')
    const bBefore = await clientB.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionId
        && record.transport === 'connected' && record.surfaceMounted === true,
      'peer surface before the first detach')
    const aBoundary = recordCount(clientA)
    const bBoundary = recordCount(clientB)
    const sourceBoundary = scene.sessionEvents(sessionId)?.length ?? 0

    await keepAndDisconnect(clientA, 'last detach source Client')
    const aClosed = recordsAfter(clientA, aBoundary).find(record => record.m4b2s === 'client-closed')
    expect(aClosed, 'source Client published no fresh close inventory').toBeDefined()
    expect(aClosed?.pid, 'close inventory came from another process').toBe(clientA.ready.businessPid)
    const bAfterA = await clientB.waitForSurfaceStatus(
      record => record.surfaceRevision === bBefore.surfaceRevision
        && record.rootFiberUid === bBefore.rootFiberUid
        && record.generationId === bBefore.generationId,
      'peer surface after the first detach')
    expect(bAfterA.pid, 'peer business PID changed').toBe(bBefore.pid)
    expect(bAfterA.openSessionId, 'peer Session changed').toBe(sessionId)
    expect(bAfterA.host?.instanceId, 'peer Host instance changed').toBe(bBefore.host?.instanceId)
    expect(recordsAfter(clientB, bBoundary).some(record => record.m4b2s === 'client-closed'),
      'peer emitted a close inventory with the source').toBe(false)
    expect((scene.sessionEvents(sessionId) ?? []).slice(sourceBoundary).some(event => event.type === 'turn/end'),
      'first detach cancelled the accepted Turn').toBe(false)
    expect(existsSync(holdPath(host)), 'first detach released the held Turn').toBe(false)

    await keepAndDisconnect(clientB, 'last detach peer Client')
    const bClosed = recordsAfter(clientB, bBoundary).find(record => record.m4b2s === 'client-closed')
    expect(bClosed, 'peer published no fresh close inventory').toBeDefined()
    expect(bClosed?.pid, 'peer close inventory came from another process').toBe(clientB.ready.businessPid)
    await expectHostIdentity(scene, host, 'Host after the last Client detach')
    for (const [client, label] of [[clientA, 'source'], [clientB, 'peer']] as const) {
      const state = await client.state()
      expect(state.exited, `${label}: native terminal is still live`).toBe(true)
      expect(state.sessionListed, `${label}: native terminal session remains listed`).toBe(false)
      for (const business of state.businessStates) {
        expect(['gone', 'reused'], `${label}: business process ${String(business.pid)} is still live`).toContain(business.state)
      }
    }
    expect(existsSync(holdPath(host)), 'last detach released the held Turn').toBe(false)
    expect((scene.sessionEvents(sessionId) ?? []).slice(sourceBoundary).some(event => event.type === 'turn/end'),
      'last detach cancelled the accepted Turn').toBe(false)

    const releaseIndex = scene.sessionEvents(sessionId)?.length ?? 0
    releaseHold(host)
    const ended = await waitForTurnEnd(scene, sessionId, releaseIndex,
      claimedTurn(scene.sessionEvents(sessionId) ?? [], seed, 'last detach Turn').turn,
      'accepted Turn completed without a Client')
    expect(ended.data?.reason?.kind, 'accepted Turn did not complete normally').toBe('completed')
    const finalEvents = scene.sessionEvents(sessionId) ?? []
    expectOneUser(finalEvents, String(seed.data?.id), prompt, 'accepted occurrence after detach')
    expect(finalEvents.filter(event => event.type === 'user/message' && userText(event) === prompt),
      'accepted occurrence was replayed').toHaveLength(1)
    expect(finalEvents.some(event => event.type === 'turn/end'
      && event.data?.reason?.kind === 'aborted'), 'a Turn was aborted without a user gesture').toBe(false)
    expect(finalEvents.some(event => event.type === 'assistant/message'
      && assistantText(event).includes('long-turn answer')), 'no durable answer settled').toBe(true)

    const fresh = await scene.startClient({
      label: 'last-detach-reader',
      ...clientDirectories(scene, 'last-detach-reader'),
      sessionId,
    })
    expect(fresh.ready.openSessionId, 'fresh Client did not attach to the accepted Session').toBe(sessionId)
    await waitFrame(fresh, prompt, 'fresh Client read the accepted occurrence')
    await waitFrame(fresh, 'long-turn answer 1', 'fresh Client read the settled answer')
    const freshBoundary = (scene.sessionEvents(sessionId) ?? []).length
    await fresh.submit('last detach follow-up prompt')
    const followUp = await waitForUserMessage(scene, sessionId, freshBoundary,
      event => userText(event) === 'last detach follow-up prompt', 'fresh Client wrote the Session')
    const followUpTurn = claimedTurn(scene.sessionEvents(sessionId) ?? [], followUp, 'fresh Client Turn')
    await waitForTurnEnd(scene, sessionId, freshBoundary, followUpTurn.turn, 'fresh Client Turn completed')
    await waitFrame(fresh, 'long-turn answer 2', 'fresh Client painted its own answer')
    await keepAndDisconnect(fresh, 'last detach reader Client')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'last Client detach')
  }
})

test('stops only the captured work when disconnecting explicitly', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'long-turn' })
    const sibling = await scene.startClient({
      label: 'explicit-stop-sibling',
      ...clientDirectories(scene, 'explicit-stop-sibling'),
    })
    const siblingPrompt = 'explicit stop sibling prompt'
    const { sessionId: siblingSession, seed: siblingSeed } = await startHeldSession(
      scene, host, sibling, siblingPrompt, 'explicit stop sibling')

    const clientA = await scene.startClient({
      label: 'explicit-stop-source',
      ...clientDirectories(scene, 'explicit-stop-source'),
    })
    const sourcePrompt = 'explicit stop captured prompt'
    const { sessionId, seed } = await startHeldSession(scene, host, clientA, sourcePrompt, 'explicit stop source')
    const clientB = await scene.startClient({
      label: 'explicit-stop-peer',
      ...clientDirectories(scene, 'explicit-stop-peer'),
      sessionId,
    })
    expect(clientB.ready.openSessionId, 'peer did not attach to the captured Session').toBe(sessionId)
    await waitFrame(clientB, sourcePrompt, 'peer read the captured occurrence')
    const bBefore = await clientB.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionId
        && record.transport === 'connected' && record.surfaceMounted === true,
      'peer surface before explicit Stop')
    const siblingBefore = await sibling.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === siblingSession
        && record.transport === 'connected' && record.surfaceMounted === true,
      'sibling surface before explicit Stop')
    const sourceTurn = claimedTurn(scene.sessionEvents(sessionId) ?? [], seed, 'captured Turn')
    const siblingTurn = claimedTurn(scene.sessionEvents(siblingSession) ?? [], siblingSeed, 'sibling Turn')
    const sourceBoundary = scene.sessionEvents(sessionId)?.length ?? 0
    const siblingBoundary = scene.sessionEvents(siblingSession)?.length ?? 0
    const siblingRecordsBoundary = recordCount(sibling)

    await stopAndDisconnect(clientA, 'explicit Stop source Client')
    const stopped = await waitForTurnEnd(scene, sessionId, sourceBoundary,
      sourceTurn.turn, 'explicit Stop settled only the captured Turn')
    expect(stopped.data?.reason, 'explicit Stop did not abort a user Turn').toMatchObject({
      kind: 'aborted',
      reason: { kind: 'user' },
    })
    expect(existsSync(holdPath(host)), 'explicit Stop released the shared hold').toBe(false)
    expect((scene.sessionEvents(siblingSession) ?? []).slice(siblingBoundary).some(event => event.type === 'turn/end'),
      'explicit Stop cancelled the sibling Turn').toBe(false)
    const siblingAfter = await sibling.waitForSurfaceStatus(
      record => record.surfaceRevision === siblingBefore.surfaceRevision,
      'sibling surface after explicit Stop')
    expect(siblingAfter.pid, 'sibling business PID changed').toBe(siblingBefore.pid)
    expect(siblingAfter.openSessionId, 'sibling Session changed').toBe(siblingSession)
    expect(recordsAfter(sibling, siblingRecordsBoundary).some(record => record.m4b2s === 'client-closed'),
      'explicit Stop closed the sibling Client').toBe(false)
    await clientB.waitForSurfaceStatus(
      record => record.surfaceRevision === bBefore.surfaceRevision
        && record.openSessionId === sessionId && record.transport === 'connected',
      'peer surface after explicit Stop')
    expect(clientB.closed, 'explicit Stop closed the peer').toBe(false)
    await expectHostIdentity(scene, host, 'Host after explicit Stop')

    const nextBoundary = scene.sessionEvents(sessionId)?.length ?? 0
    const nextPrompt = 'explicit stop peer replacement prompt'
    const workBoundary = fixtureHelpers.readC1WorkEvents(host.workloadRoot!).length
    await clientB.submit(nextPrompt)
    await waitForWorkAfter(host, workBoundary,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
      'peer replacement Turn held')
    const nextMessage = await waitForUserMessage(scene, sessionId, nextBoundary,
      event => userText(event) === nextPrompt, 'peer replacement occurrence committed')
    const nextTurn = claimedTurn(scene.sessionEvents(sessionId) ?? [], nextMessage, 'peer replacement Turn')

    releaseHold(host)
    const nextEnd = await waitForTurnEnd(scene, sessionId, nextBoundary, nextTurn.turn,
      'peer replacement Turn completed')
    expect(nextEnd.data?.reason?.kind, 'peer replacement Turn did not complete').toBe('completed')
    const siblingEnd = await waitForTurnEnd(scene, siblingSession, siblingBoundary,
      siblingTurn.turn, 'sibling Turn completed after the release')
    expect(siblingEnd.data?.reason?.kind, 'sibling Turn did not complete').toBe('completed')
    await waitFrame(clientB, 'long-turn answer 2', 'peer painted its replacement answer')
    const finalEvents = scene.sessionEvents(sessionId) ?? []
    expect(finalEvents.some(event => event.type === 'assistant/message'
      && assistantText(event).includes('long-turn answer 1')),
    'the explicitly stopped Turn produced an answer').toBe(false)
    expect(finalEvents.filter(event => event.type === 'turn/end'
      && event.data?.reason?.kind === 'aborted'), 'explicit Stop aborted more than the captured Turn')
      .toHaveLength(1)
    expect((scene.sessionEvents(siblingSession) ?? []).filter(event =>
      event.type === 'user/message' && userText(event) === sourcePrompt),
    'captured prompt leaked into the sibling Session').toHaveLength(0)
    await keepAndDisconnect(clientB, 'explicit Stop peer Client')
    await keepAndDisconnect(sibling, 'explicit Stop sibling Client')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'explicit Stop and Disconnect')
  }
})

test('keeps a peer and its held Turn across a Client carrier replacement', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'long-turn' })
    const clientA = await scene.startClient({
      label: 'carrier-source',
      ...clientDirectories(scene, 'carrier-source'),
    })
    const prompt = 'carrier held source prompt'
    const { sessionId, seed } = await startHeldSession(scene, host, clientA, prompt, 'carrier source')
    const clientB = await scene.startClient({
      label: 'carrier-peer',
      ...clientDirectories(scene, 'carrier-peer'),
      sessionId,
    })
    expect(clientB.ready.openSessionId, 'peer did not attach to the held Session').toBe(sessionId)
    await waitFrame(clientB, prompt, 'peer read the held occurrence')
    const aBefore = await clientA.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionId
        && record.transport === 'connected' && record.surfaceMounted === true,
      'source surface before carrier replacement')
    const bBefore = await clientB.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionId
        && record.transport === 'connected' && record.surfaceMounted === true,
      'peer surface before carrier replacement')
    const aBoundary = recordCount(clientA)
    const bBoundary = recordCount(clientB)
    const turn = claimedTurn(scene.sessionEvents(sessionId) ?? [], seed, 'carrier held Turn')

    await clientA.signal('SIGUSR1')
    const lost = await waitForSurfaceStatusAfter(clientA, aBoundary,
      record => record.transport !== 'connected' && record.generationId === undefined,
      'source observed the dropped carrier generation')
    expect(lost.host?.instanceId, 'the old Host identity was dropped before a replacement').toBe(aBefore.host?.instanceId)
    const replaced = await waitForSurfaceStatusAfter(clientA, aBoundary,
      record => record.transport === 'connected' && record.sessionOpen === true
        && record.openSessionId === sessionId && typeof record.generationId === 'number'
        && record.generationId > (aBefore.generationId ?? 0),
      'source published a newer connected generation')
    expect(replaced.pid, 'carrier replacement changed the business process').toBe(aBefore.pid)
    expect(replaced.rootFiberUid, 'carrier replacement remounted the root fiber').toBe(aBefore.rootFiberUid)
    expect(replaced.surfaceRevision, 'carrier replacement changed the surface revision').toBe(aBefore.surfaceRevision)
    expect(replaced.host?.instanceId, 'carrier replacement changed the Host').toBe(aBefore.host?.instanceId)

    const peerRecords = recordsAfter(clientB, bBoundary)
    expect(peerRecords.some(record => record.m4b2s === 'qualification' && record.op === 'drop-websocket'),
      'peer dropped its own carrier').toBe(false)
    expect(peerRecords.some(record => record.m4b2s === 'surface-status'
      && record.generationId !== bBefore.generationId), 'peer generation changed').toBe(false)
    expect(peerRecords.some(record => record.m4b2s === 'surface-status'
      && record.openSessionId !== sessionId), 'peer left the held Session').toBe(false)
    expect(peerRecords.some(record => record.m4b2s === 'surface-status'
      && record.host?.instanceId !== bBefore.host?.instanceId), 'peer Host identity changed').toBe(false)
    expect(peerRecords.some(record => record.m4b2s === 'client-closed'), 'peer closed during replacement').toBe(false)
    expect(peerRecords.some(record => record.m4b2s === 'qualification'
      && String(record.op ?? '').startsWith('hmr-revision')), 'peer remounted its surface').toBe(false)
    const peerAfter = await clientB.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionId
        && record.transport === 'connected' && record.surfaceMounted === true,
      'peer still serves the held Session')
    expect(peerAfter.pid, 'peer business PID changed').toBe(bBefore.pid)
    expect((await clientB.state()).exited, 'peer exited during carrier replacement').toBe(false)
    expect((scene.sessionEvents(sessionId) ?? []).some(event => event.type === 'turn/end'),
      'carrier replacement cancelled the held Turn').toBe(false)
    expect(existsSync(holdPath(host)), 'carrier replacement released the held Turn').toBe(false)

    const releaseIndex = scene.sessionEvents(sessionId)?.length ?? 0
    releaseHold(host)
    const ended = await waitForTurnEnd(scene, sessionId, releaseIndex, turn.turn,
      'held Turn completed through the surviving peer')
    expect(ended.data?.reason?.kind, 'held Turn did not complete normally').toBe('completed')
    await waitFrame(clientB, 'long-turn answer 1', 'peer read the completed Turn')

    const nextBoundary = scene.sessionEvents(sessionId)?.length ?? 0
    await clientB.submit('carrier peer follow-up prompt')
    const followUp = await waitForUserMessage(scene, sessionId, nextBoundary,
      event => userText(event) === 'carrier peer follow-up prompt', 'peer wrote after carrier replacement')
    const followUpTurn = claimedTurn(scene.sessionEvents(sessionId) ?? [], followUp, 'peer follow-up Turn')
    await waitForTurnEnd(scene, sessionId, nextBoundary, followUpTurn.turn, 'peer follow-up completed')
    await waitFrame(clientB, 'long-turn answer 2', 'peer painted its follow-up answer')
    await expectHostIdentity(scene, host, 'Host after carrier replacement')
    await keepAndDisconnect(clientA, 'carrier source Client')
    await keepAndDisconnect(clientB, 'carrier peer Client')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'Client carrier replacement')
  }
})

test('reoffers a pending Question through a held surface replacement without settling it', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'question' })
    const clientA = await scene.startClient({
      label: 'held-question-source',
      ...clientDirectories(scene, 'held-question-source'),
      hmr: 'hold',
    })
    const prompt = 'held question source prompt'
    const before = new Set(await scene.sessionIds())
    const workBoundary = fixtureHelpers.readC1WorkEvents(host.workloadRoot!).length
    await clientA.submit(prompt)
    const sessionId = await scene.waitForNewSessionId(before, 'held Question Session')
    await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!,
      event => event.kind === 'question-request' && event.sessionId === sessionId,
      'Host published the pending Question')
    const call = await scene.waitForSessionEvent(sessionId, 0,
      event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
      'pending Question tool/call')
    const callId = String(call.data?.callId)
    expect(callId, 'pending Question has no call identity').not.toBe('')
    await waitFrame(clientA, '[1] Proceed', 'source painted the pending Question')

    const clientB = await scene.startClient({
      label: 'held-question-peer',
      ...clientDirectories(scene, 'held-question-peer'),
      sessionId,
    })
    expect(clientB.ready.openSessionId, 'peer did not attach to the pending Question').toBe(sessionId)
    await waitFrame(clientB, '[1] Proceed', 'peer painted the same Question')
    const aBefore = await clientA.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionId
        && record.transport === 'connected' && record.surfaceMounted === true,
      'source surface before the held replacement')
    const aBoundary = recordCount(clientA)
    const bBoundary = recordCount(clientB)
    const requestBoundary = (scene.sessionEvents(sessionId) ?? []).length

    await clientA.signal('SIGUSR2')
    const start = await waitRecordAfter(clientA, aBoundary,
      record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start',
      'held surface replacement started')
    const retired = await waitRecordAfter(clientA, aBoundary,
      record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired',
      'old surface retired before the replacement mounted')
    expect(retired.revision, 'retired surface is not the captured revision').toBe(aBefore.surfaceRevision)
    expect(start.revision, 'replacement revision did not advance').not.toBe(aBefore.surfaceRevision)
    expect(recordsAfter(clientA, aBoundary).some(record =>
      record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready'),
    'held replacement published a Ready before release').toBe(false)
    await clientA.waitForSurfaceStatus(
      record => record.surfaceMounted === false && record.sessionOpen === true,
      'source surface retired while the replacement is held')
    await waitFrame(clientB, '[1] Proceed', 'peer still offers the same Question')
    expect((scene.sessionEvents(sessionId) ?? []).slice(requestBoundary).some(event =>
      event.type === 'tool/result' || event.type === 'turn/end'),
    'held replacement settled the Question').toBe(false)

    clientA.releaseHmrHold()
    const ready = await waitRecordAfter(clientA, aBoundary,
      record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready',
      'held replacement became Ready')
    expect(ready.revision, 'replacement Ready is not the announced revision').toBe(start.revision)
    const aAfter = await clientA.waitForSurfaceStatus(
      record => record.surfaceMounted === true && record.surfaceRevision === ready.revision,
      'source mounted the replacement surface')
    expect(aAfter.pid, 'replacement changed the business process').toBe(aBefore.pid)
    expect(aAfter.rootFiberUid, 'replacement remounted the root fiber').toBe(aBefore.rootFiberUid)
    expect(aAfter.generationId, 'replacement changed the carrier generation').toBe(aBefore.generationId)
    expect(aAfter.openSessionId, 'replacement changed the Session').toBe(sessionId)
    expect(aAfter.surfaceFiberUid, 'replacement reused the old surface fiber').not.toBe(aBefore.surfaceFiberUid)
    await waitFrame(clientA, '[1] Proceed', 'source reoffered the same Question')

    await clientB.type('1')
    await waitFrame(clientB, 'Review your answer before submit', 'peer Question review')
    await clientB.press('Enter')
    const settled = await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!,
      event => event.kind === 'question-settled' && event.sessionId === sessionId,
      'Question settled exactly once by the peer')
    expect(settled.answers?.[0]?.selected?.[0], 'peer answer changed').toBe('Proceed')
    const result = await scene.waitForSessionEvent(sessionId, requestBoundary,
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
      'original Question result')
    expect(result.data?.message?.isError, 'Question result reported an error').not.toBe(true)
    await scene.waitForSessionEvent(sessionId, requestBoundary,
      event => event.type === 'turn/end', 'Question Turn ended')
    await waitFrameGone(clientA, '[1] Proceed', 'source Question modal withdrawn after settlement')
    const work = fixtureHelpers.readC1WorkEvents(host.workloadRoot!)
    expect(work.filter(event => event.kind === 'question-request' && event.sessionId === sessionId),
      'Question was requested more than once').toHaveLength(1)
    expect(work.filter(event => event.kind === 'question-settled' && event.sessionId === sessionId),
      'Question was settled more than once').toHaveLength(1)
    expect((scene.sessionEvents(sessionId) ?? []).filter(event =>
      event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId),
    'Question result committed more than once').toHaveLength(1)
    expect(recordsAfter(clientB, bBoundary).some(record => record.m4b2s === 'client-closed'),
      'peer closed while answering').toBe(false)
    await expectHostIdentity(scene, host, 'Host after held Question replacement')
    await keepAndDisconnect(clientA, 'held Question source Client')
    await keepAndDisconnect(clientB, 'held Question peer Client')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'held Question surface replacement')
  }
})

test('keeps a held Turn after a Client business hangup', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'long-turn' })
    const clientA = await scene.startClient({
      label: 'business-hangup-source',
      ...clientDirectories(scene, 'business-hangup-source'),
      terminal: 'business-hangup',
    })
    const prompt = 'business hangup held prompt'
    const { sessionId, seed } = await startHeldSession(scene, host, clientA, prompt, 'business hangup source')
    const clientB = await scene.startClient({
      label: 'business-hangup-peer',
      ...clientDirectories(scene, 'business-hangup-peer'),
      sessionId,
    })
    expect(clientB.ready.openSessionId, 'peer did not attach to the held Session').toBe(sessionId)
    await waitFrame(clientB, prompt, 'peer read the held occurrence')
    const bBefore = await clientB.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionId
        && record.transport === 'connected' && record.surfaceMounted === true,
      'peer surface before business hangup')
    const aBoundary = recordCount(clientA)
    const bBoundary = recordCount(clientB)
    const aState = await clientA.state()
    expect(aState.businessStates.map(value => value.pid)).toContain(clientA.ready.businessPid)

    await expect(scene.request('SIGNAL_PROCESS_CLIENT',
      { clientId: clientB.clientId, signal: 'SIGHUP' }, 120_000))
      .rejects.toThrow(/declared business-hangup terminal/)
    await expect(scene.request('SIGNAL_PROCESS_CLIENT',
      { clientId: clientA.clientId, signal: 'SIGKILL' }, 120_000))
      .rejects.toThrow(/declared business-kill terminal/)
    expect((await clientA.state()).exited, 'rejected signal terminated the declared Client').toBe(false)
    expect((await clientB.state()).exited, 'rejected signal terminated the ordinary Client').toBe(false)
    const receiptAfterRefusals = await scene.readSupervisorReceipt()
    expect(receiptAfterRefusals.notes?.some(note => note.event === 'process-client-business-hangup-sent'),
      'a refused admission dispatched a business hangup').toBe(false)
    expect(recordsAfter(clientA, aBoundary).some(record => record.m4a0 === 'signal'),
      'a refused admission published a signal record').toBe(false)

    const sent = await clientA.hangupBusiness()
    expect(sent.signal, 'wrong business signal was dispatched').toBe('SIGHUP')
    expect(sent.pid, 'hangup did not reach the captured business PID').toBe(clientA.ready.businessPid)
    expect(sent.birth, 'hangup has no captured kernel birth').toBeTypeOf('string')
    const receipt = await scene.readSupervisorReceipt()
    const note = receipt.notes?.find(value => value.event === 'process-client-business-hangup-sent'
      && value.detail?.clientId === clientA.clientId)
    expect(note, 'Supervisor recorded no live business hangup dispatch').toBeDefined()
    expect(note?.detail?.pid, 'hangup dispatch named another PID').toBe(sent.pid)
    expect(note?.detail?.birth, 'hangup dispatch named another kernel birth').toBe(sent.birth)
    expect(note?.detail?.signal, 'hangup dispatch named another signal').toBe('SIGHUP')
    expectBusinessHangupExit(await clientA.waitForExit(), 'business hangup waitForExit')
    expectBusinessHangupExit(await clientA.close(), 'business hangup close')
    expect(clientA.closed, 'business hangup was not settled by its declared close').toBe(true)
    expect(clientA.readRecords().some(record => record.m4b2s === 'client-closed'),
      'business hangup fabricated a graceful owner inventory').toBe(false)
    const aRow = (await scene.readSupervisorReceipt()).processClients?.find(
      value => value.clientId === clientA.clientId,
    ) as Record<string, any> | undefined
    expect(aRow?.businessHangupSent, 'Supervisor has no successful business hangup fact').toBe(true)
    expect(aRow?.verifiedTerminal?.kind, 'business hangup has no verified native terminal').toBe('native')

    await expectHostIdentity(scene, host, 'Host after business hangup')
    const bAfter = await clientB.waitForSurfaceStatus(
      record => record.surfaceRevision === bBefore.surfaceRevision
        && record.openSessionId === sessionId && record.transport === 'connected',
      'peer surface after business hangup')
    expect(bAfter.pid, 'peer business PID changed').toBe(bBefore.pid)
    expect(recordsAfter(clientB, bBoundary).some(record => record.m4b2s === 'client-closed'),
      'peer closed during business hangup').toBe(false)
    expect((scene.sessionEvents(sessionId) ?? []).some(event => event.type === 'turn/end'),
      'business hangup cancelled the held Turn').toBe(false)
    expect(existsSync(holdPath(host)), 'business hangup released the held Turn').toBe(false)

    const releaseIndex = scene.sessionEvents(sessionId)?.length ?? 0
    releaseHold(host)
    const ended = await waitForTurnEnd(scene, sessionId, releaseIndex,
      claimedTurn(scene.sessionEvents(sessionId) ?? [], seed, 'business hangup Turn').turn,
      'held Turn completed after business hangup')
    expect(ended.data?.reason?.kind, 'original Turn did not complete').toBe('completed')
    await waitFrame(clientB, 'long-turn answer 1', 'peer read the original answer')

    const nextBoundary = scene.sessionEvents(sessionId)?.length ?? 0
    await clientB.submit('business hangup peer follow-up')
    const followUp = await waitForUserMessage(scene, sessionId, nextBoundary,
      event => userText(event) === 'business hangup peer follow-up', 'peer wrote after business hangup')
    const followUpTurn = claimedTurn(scene.sessionEvents(sessionId) ?? [], followUp, 'peer follow-up Turn')
    await waitForTurnEnd(scene, sessionId, nextBoundary, followUpTurn.turn, 'peer follow-up completed')
    await waitFrame(clientB, 'long-turn answer 2', 'peer painted its follow-up answer')
    await keepAndDisconnect(clientB, 'business hangup peer Client')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'Client business hangup')
  }
})

test('refuses a replacement Host on both old Clients and resumes from a fresh Client', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'long-turn', crashSignal: 'SIGKILL' })
    const clientA = await scene.startClient({
      label: 'host-replacement-source',
      ...clientDirectories(scene, 'host-replacement-source'),
      terminal: 'host-replacement-refusal',
    })
    const prompt = 'host replacement held prompt'
    const { sessionId, seed } = await startHeldSession(scene, host, clientA, prompt, 'host replacement source')
    const clientB = await scene.startClient({
      label: 'host-replacement-peer',
      ...clientDirectories(scene, 'host-replacement-peer'),
      sessionId,
      terminal: 'host-replacement-refusal',
    })
    expect(clientB.ready.openSessionId, 'peer did not attach to the source Session').toBe(sessionId)
    await waitFrame(clientB, prompt, 'peer read the held source occurrence')
    const aBoundary = recordCount(clientA)
    const bBoundary = recordCount(clientB)
    const originalBoundary = scene.sessionEvents(sessionId)?.length ?? 0
    const oldInstance = host.ready.localHost.instanceId
    expect(existsSync(holdPath(host)), 'held source Turn was released before the Host crash').toBe(false)

    await scene.signalEntry(host, 'SIGKILL')
    const terminal = await scene.finishEntry(host)
    expect(terminal.exit, 'old Host did not end as a SIGKILL business crash')
      .toEqual({ code: null, signal: 'SIGKILL' })
    expect(terminal.outcome, 'old Host terminal is not a business crash').toBe('business-crash')
    for (const [client, label] of [[clientA, 'source'], [clientB, 'peer']] as const) {
      const lost = await waitForSurfaceStatusAfter(client, label === 'source' ? aBoundary : bBoundary,
        record => record.transport !== 'connected' && record.generationId === undefined,
        `${label} Client observed the old Host loss`)
      expect(lost.host?.instanceId, `${label} Client dropped the old Host identity`).toBe(oldInstance)
      expect((await client.state()).exited, `${label} Client treated carrier loss as a fatal exit`).toBe(false)
    }
    expect((scene.sessionEvents(sessionId) ?? []).slice(originalBoundary).some(event => event.type === 'turn/end'),
      'Host crash fabricated a Turn settlement').toBe(false)
    expect(existsSync(holdPath(host)), 'Host crash released the held source Turn').toBe(false)

    const successor = await scene.startHost({ scenario: 'long-turn' })
    expect(successor.hostId, 'replacement reused the old Host identity').not.toBe(host.hostId)
    expect(successor.ready.localHost.instanceId, 'replacement reused the old Host instance').not.toBe(oldInstance)
    expect(successor.ready.localHost.scopeId, 'replacement left the Scene scope').toBe(host.ready.localHost.scopeId)
    const successorStatus = await scene.hostStatus(successor)
    expect(successorStatus.localHost.instanceId, 'replacement is not authenticated Ready').toBe(
      successor.ready.localHost.instanceId)

    for (const [client, boundary, label] of [
      [clientA, aBoundary, 'source'],
      [clientB, bBoundary, 'peer'],
    ] as const) {
      const failure = await waitRecordAfter(client, boundary,
        record => record.m4a0 === 'failure' && record.code === 'HOST_IDENTITY_MISMATCH',
        `${label} Client classified the replacement Host`)
      expect(failure.phase, `${label} Client refusal was not fail-closed`).toBeTypeOf('string')
      expect(recordsAfter(client, boundary).some(record => record.host?.instanceId
        === successor.ready.localHost.instanceId), `${label} Client recorded the successor Host`).toBe(false)
      expect(recordsAfter(client, boundary).some(record => record.m4b2s === 'surface-status'
        && record.transport === 'connected' && record.generationId !== undefined
        && record.host?.instanceId === successor.ready.localHost.instanceId),
      `${label} Client adopted a successor generation`).toBe(false)
      const exit = await client.waitForExit()
      expect(exit, `${label} Client fail-closed exit`).toMatchObject({ code: 1, signal: null })
      const closed = await client.close()
      expect(closed, `${label} Client verified refusal close`).toMatchObject({ code: 1, signal: null })
      expect(client.closed, `${label} Client refusal was not settled by its declared close`).toBe(true)
    }
    expect(existsSync(holdPath(host)), 'old Client refusal released the held source Turn').toBe(false)

    const fresh = await scene.startClient({
      label: 'host-replacement-reader',
      ...clientDirectories(scene, 'host-replacement-reader'),
      sessionId,
    })
    expect(fresh.ready.openSessionId, 'fresh Client did not resume the source Session').toBe(sessionId)
    expect(fresh.ready.instanceId, 'fresh Client did not authenticate the replacement Host').toBe(
      successor.ready.localHost.instanceId)
    await waitFrame(fresh, prompt, 'fresh Client read the original occurrence')
    await scene.waitForSessionEvent(sessionId, originalBoundary,
      event => event.type === 'turn/end' && event.data?.reason?.kind === 'interrupted',
      'lost Turn settled as interrupted by the replacement Host')
    expect((scene.sessionEvents(sessionId) ?? []).slice(originalBoundary).some(event =>
      event.type === 'turn/start'), 'replacement replayed the lost Turn').toBe(false)
    expect((scene.sessionEvents(sessionId) ?? []).filter(event =>
      event.type === 'assistant/message' && assistantText(event).includes('long-turn answer')),
    'replacement fabricated an answer for the lost Turn').toHaveLength(0)
    expectOneUser(scene.sessionEvents(sessionId) ?? [], String(seed.data?.id), prompt,
      'original occurrence after Host replacement')
    expect((scene.sessionEvents(sessionId) ?? []).filter(event =>
      event.type === 'user/message' && userText(event) === prompt),
    'original occurrence was replayed').toHaveLength(1)
    expect((scene.sessionEvents(sessionId) ?? []).slice(originalBoundary).filter(event =>
      event.type === 'turn/end'), 'lost Turn was settled more than once').toHaveLength(1)

    const nextBoundary = scene.sessionEvents(sessionId)?.length ?? 0
    const workBoundary = fixtureHelpers.readC1WorkEvents(successor.workloadRoot!).length
    const nextPrompt = 'host replacement fresh prompt'
    await fresh.submit(nextPrompt)
    await waitForWorkAfter(successor, workBoundary,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
      'replacement Host accepted fresh work')
    const nextMessage = await waitForUserMessage(scene, sessionId, nextBoundary,
      event => userText(event) === nextPrompt, 'fresh occurrence committed on the replacement Host')
    const nextTurn = claimedTurn(scene.sessionEvents(sessionId) ?? [], nextMessage, 'replacement Host Turn')
    releaseHold(successor)
    const nextEnd = await waitForTurnEnd(scene, sessionId, nextBoundary, nextTurn.turn,
      'replacement Host completed fresh work')
    expect(nextEnd.data?.reason?.kind, 'fresh work did not complete').toBe('completed')
    await waitFrame(fresh, 'long-turn answer 1', 'fresh Client read the replacement answer')
    await keepAndDisconnect(fresh, 'host replacement reader Client')
    await scene.stopHost(successor)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'replacement Host refusal')
  }
})
