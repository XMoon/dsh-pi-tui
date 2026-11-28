import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'vitest'

import { readOfficialClientRecords } from '../../../support/split-process-client.ts'
import {
  createSplitProcessScene,
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

function rehold(host: SplitProcessHostHandle, label: string): void {
  const path = holdPath(host)
  expect(existsSync(path), `${label}: the released hold barrier is absent`).toBe(true)
  rmSync(path, { force: true })
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

function headerFacts(header: SessionEvent, label: string): Record<string, any> {
  expect(header.type, `${label}: durable event is not a Session header`).toBe('session')
  return header as Record<string, any>
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
  source: Record<string, any>,
  label: string,
): void {
  const matches = events.filter(event => event.type === 'user/message' && event.data?.id === id)
  expect(matches, `${label}: exact occurrence count`).toHaveLength(1)
  expect(userText(matches[0]), `${label}: exact occurrence text`).toBe(text)
  expect(matches[0]?.data?.source?.kind, `${label}: occurrence is not human-authored`).toBe('user')
  expect(matches[0]?.data?.source, `${label}: occurrence provenance changed`).toEqual(source)
}

async function keepAndDisconnect(client: SplitProcessClient, label: string): Promise<void> {
  await client.press('Ctrl+U')
  await client.submit('/exit')
  const deadline = Date.now() + 60_000
  let choiceTaken = false
  for (;;) {
    const state = await client.state().catch(() => undefined)
    if (state !== undefined && state.exited) break
    if (!choiceTaken) {
      const frame = await client.text().catch(() => '')
      if (frame.includes('Disconnect from dsh-pi-tui') && frame.includes('> Keep working and disconnect')) {
        await client.press('Enter')
        choiceTaken = true
      }
    }
    if (Date.now() >= deadline) {
      const frame = await client.text().catch(() => '')
      throw new Error(`${label}: did not exit after /exit; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(50)
  }
  const exit = await client.waitForExit()
  expect(exit, `${label}: native Keep exit`).toMatchObject({ code: 0, signal: null })
  const closed = await client.close()
  expect(closed, `${label}: Supervisor Keep close`).toMatchObject({ code: 0, signal: null })
  expect(client.closed, `${label}: Supervisor close settlement`).toBe(true)
  const inventory = clientRecords(client).filter(record => record.m4b2s === 'client-closed').at(-1)
  expect(inventory, `${label}: official close inventory`).toBeDefined()
  for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
    expect(inventory?.owners?.[owner], `${label}: ${owner} owner remains`).toBe(0)
  }
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
  await waitForWorkAfter(host, workBoundary,
    event => event.kind === 'long-turn-held' && event.sessionId === sessionId, `${label}: held Turn`)
  const seed = await waitForUserMessage(scene, sessionId, 0,
    event => userText(event) === prompt, `${label}: accepted occurrence`)
  expect(seed.data?.id, `${label}: occurrence identity`).toBeTypeOf('string')
  await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/start', `${label}: turn/start`)
  return { sessionId, seed }
}

async function queueMessage(
  scene: SplitProcessScene,
  sessionId: string,
  client: SplitProcessClient,
  text: string,
  label: string,
): Promise<{ event: SessionEvent; item: Record<string, any> }> {
  const boundary = scene.sessionEvents(sessionId)?.length ?? 0
  await client.submit(text)
  const event = await scene.waitForSessionEvent(sessionId, boundary,
    candidate => candidate.type === 'agent/inbox/spliced'
      && candidate.data?.target === 'next-turn'
      && (candidate.data.inserted ?? []).some((message: Record<string, any>) => messageText(message) === text),
    `${label}: queued occurrence`)
  const item = (event.data?.inserted ?? [])
    .find((message: Record<string, any>) => messageText(message) === text)
  expect(item?.id, `${label}: Host occurrence identity`).toBeTypeOf('string')
  expect(item.source?.kind, `${label}: queued occurrence is not human-authored`).toBe('user')
  return { event, item }
}

test('navigates between running Sessions without stopping or moving their queued work', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'long-turn' })
    const clientA = await scene.startClient({
      label: 'navigation-source',
      ...clientDirectories(scene, 'navigation-source'),
    })
    const sourceText = 'navigation source prompt'
    const { sessionId: sessionX, seed } = await startHeldSession(scene, host, clientA, sourceText, 'navigation source')
    const sourceHeader = headerFacts(await scene.waitForHostSessionHeader(sessionX, 'source header before navigation'),
      'source header before navigation')
    const sourceTurn = claimedTurn(scene.sessionEvents(sessionX) ?? [], seed, 'source held Turn')
    expect(existsSync(holdPath(host)), 'source Turn hold was released before navigation').toBe(false)

    const clientB = await scene.startClient({
      label: 'navigation-peer',
      ...clientDirectories(scene, 'navigation-peer'),
      sessionId: sessionX,
    })
    expect(clientB.ready.openSessionId, 'peer did not attach to the source Session').toBe(sessionX)
    expect(clientB.ready.businessPid, 'the two Clients share one business process').not.toBe(clientA.ready.businessPid)
    await waitFrame(clientB, sourceText, 'peer read source history')

    const sessionsBeforeNew = new Set(await scene.sessionIds())
    const navigationBoundary = recordCount(clientA)
    await clientA.submit('/new')
    const onTarget = await waitForSurfaceStatusAfter(clientA, navigationBoundary,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string'
        && record.openSessionId !== sessionX && record.transport === 'connected'
        && record.surfaceMounted === true,
      'A opened a fresh Session while the source was running')
    const sessionY = String(onTarget.openSessionId)
    await scene.waitForNewSessionId(sessionsBeforeNew, 'fresh Session published by /new')
    const targetHeader = headerFacts(await scene.waitForHostSessionHeader(sessionY, 'fresh Session header'),
      'fresh Session header')
    expect(targetHeader.cwd, 'fresh Session left the source Workspace').toBe(sourceHeader.cwd)
    expect(headerFacts(await scene.waitForHostSessionHeader(sessionX, 'source header after /new'),
      'source header after /new'), '/new changed the source Session header').toEqual(sourceHeader)
    await waitFrameGone(clientA, sourceText, 'A current frame lost the source prompt')
    expect((await clientB.text()).includes(sourceText), 'peer lost the source Session').toBe(true)
    expect(scene.sessionEvents(sessionX)?.some(event => event.type === 'turn/end'),
      '/new stopped the held source Turn').toBe(false)
    expect(existsSync(holdPath(host)), '/new released the source hold').toBe(false)

    const targetText = 'navigation target prompt'
    const targetWorkBoundary = fixtureHelpers.readC1WorkEvents(host.workloadRoot!).length
    await clientA.submit(targetText)
    await waitForWorkAfter(host, targetWorkBoundary,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionY,
      'target Session held its own Turn')
    const targetMessage = await waitForUserMessage(scene, sessionY, 0,
      event => userText(event) === targetText, 'target accepted occurrence')
    const targetTurn = claimedTurn(scene.sessionEvents(sessionY) ?? [], targetMessage, 'target held Turn')

    const resumeBoundary = recordCount(clientA)
    await clientA.submit(`/resume ${sessionX}`)
    await waitForSurfaceStatusAfter(clientA, resumeBoundary,
      record => record.sessionOpen === true && record.openSessionId === sessionX
        && record.transport === 'connected' && record.surfaceMounted === true,
      'A resumed the running source Session')
    await waitFrame(clientA, sourceText, 'A painted the running source surface')
    await waitFrameGone(clientA, targetText, 'A current frame lost the target-only prompt')

    const noopBoundary = recordCount(clientA)
    await clientA.submit(`/resume ${sessionX}`)
    await waitFrame(clientA, 'already on this session', 'already-current switch refused')
    await waitForComposerDraft(clientA, `/resume ${sessionX}`, 'refused command stayed in the editor')
    await clientA.press('Ctrl+U')
    await waitForComposerDraft(clientA, '', 'refused command cleared from the editor')
    expect(recordsAfter(clientA, noopBoundary).some(record =>
      record.m4b2s === 'surface-status' && record.openSessionId === sessionY),
    'an already-current switch opened another Session').toBe(false)
    expect(scene.sessionEvents(sessionX)?.some(event => event.type === 'turn/end'),
      'an already-current switch ended the held source Turn').toBe(false)

    const queued = await queueMessage(scene, sessionX, clientA, 'navigation queued occurrence', 'source queue')
    await waitFrame(clientB, 'navigation queued occurrence', 'peer read the pending occurrence')

    await clientA.submit(`/resume ${sessionY}`)
    await waitForSurfaceStatusAfter(clientA, noopBoundary,
      record => record.sessionOpen === true && record.openSessionId === sessionY
        && record.transport === 'connected' && record.surfaceMounted === true,
      'A left the running source for the target Session')
    await waitFrame(clientA, targetText, 'A painted the target-only surface')
    await waitFrameGone(clientA, 'navigation queued occurrence', 'source queued occurrence stayed off the target')
    expect(scene.sessionEvents(sessionX)?.some(event => event.type === 'turn/end'),
      'leaving the source stopped its held Turn').toBe(false)
    expect(scene.sessionEvents(sessionY)?.some(event =>
      event.type === 'user/message' && userText(event) === 'navigation queued occurrence'),
    'source queued occurrence moved to the target Session').toBe(false)
    expect(existsSync(holdPath(host)), 'navigation released the source hold').toBe(false)

    await keepAndDisconnect(clientA, 'navigation source Client')
    await expectHostIdentity(scene, host, 'Host after navigation and exit')
    expect(clientB.closed, 'peer exited with the navigating Client').toBe(false)

    const sourceReleaseIndex = scene.sessionEvents(sessionX)?.length ?? 0
    const targetReleaseIndex = scene.sessionEvents(sessionY)?.length ?? 0
    releaseHold(host)
    const sourceEnd = await waitForTurnEnd(scene, sessionX, sourceReleaseIndex,
      sourceTurn.turn, 'source original Turn completed')
    expect(sourceEnd.data?.reason?.kind, 'source original Turn did not complete normally').toBe('completed')
    const claimed = await waitForUserMessage(scene, sessionX, sourceReleaseIndex,
      event => event.data?.id === queued.item.id, 'queued occurrence claimed')
    const claimedTurnFacts = claimedTurn(scene.sessionEvents(sessionX) ?? [], claimed, 'claimed queue Turn')
    expect(claimedTurnFacts.turn, 'queued occurrence did not claim the next Turn').toBe(sourceTurn.turn + 1)
    await waitForTurnEnd(scene, sessionX, sourceReleaseIndex,
      claimedTurnFacts.turn, 'queued occurrence Turn completed')
    const targetEnd = await waitForTurnEnd(scene, sessionY, targetReleaseIndex,
      targetTurn.turn, 'target original Turn completed')
    expect(targetEnd.data?.reason?.kind, 'target original Turn did not complete normally').toBe('completed')
    await waitFrame(clientB, 'long-turn answer 1', 'peer read the source completion')
    const finalSourceEvents = scene.sessionEvents(sessionX) ?? []
    expectOneUser(finalSourceEvents, queued.item.id, 'navigation queued occurrence', queued.item.source,
      'claimed queued occurrence')
    expect(finalSourceEvents.filter(event =>
      event.type === 'user/message' && userText(event) === 'navigation queued occurrence'),
    'queued occurrence committed more than once').toHaveLength(1)
    expect(finalSourceEvents.some(event => event.type === 'turn/end'
      && event.data?.reason?.kind === 'aborted'), 'navigation aborted a source Turn').toBe(false)
    expect((scene.sessionEvents(sessionY) ?? []).some(event =>
      event.type === 'user/message' && userText(event) === 'navigation queued occurrence'),
    'queued occurrence leaked into the target Session').toBe(false)

    const peerBoundary = finalSourceEvents.length
    await clientB.submit('navigation peer follow-up')
    const peerMessage = await waitForUserMessage(scene, sessionX, peerBoundary,
      event => userText(event) === 'navigation peer follow-up', 'peer wrote the source Session')
    const peerTurn = claimedTurn(scene.sessionEvents(sessionX) ?? [], peerMessage, 'peer follow-up Turn')
    await waitForTurnEnd(scene, sessionX, peerBoundary, peerTurn.turn, 'peer follow-up completed')
    await waitFrame(clientB, 'long-turn answer 3', 'peer painted its own answer')

    const fresh = await scene.startClient({
      label: 'navigation-reader',
      ...clientDirectories(scene, 'navigation-reader'),
      sessionId: sessionY,
    })
    expect(fresh.ready.openSessionId, 'fresh Client did not read the target Session').toBe(sessionY)
    await waitFrame(fresh, targetText, 'fresh Client read target history')
    await waitFrame(fresh, 'long-turn answer 1', 'fresh Client read target answer')
    await keepAndDisconnect(fresh, 'navigation reader Client')
    await keepAndDisconnect(clientB, 'navigation peer Client')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'busy Session navigation')
  }
})

async function runCompletedPrefixCase(kind: 'fork' | 'rewind'): Promise<void> {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'long-turn' })
    const clientA = await scene.startClient({
      label: `${kind}-source`,
      ...clientDirectories(scene, `${kind}-source`),
    })
    const firstText = `${kind} prefix first`
    const secondText = `${kind} prefix second`
    const heldText = `${kind} held source prompt`
    const { sessionId: sessionX, seed } = await startHeldSession(scene, host, clientA, firstText, `${kind} first prefix`)
    const firstTurn = claimedTurn(scene.sessionEvents(sessionX) ?? [], seed, `${kind} first prefix Turn`)
    releaseHold(host)
    await waitForTurnEnd(scene, sessionX, 0, firstTurn.turn, `${kind} first prefix completed`)

    const secondBoundary = scene.sessionEvents(sessionX)?.length ?? 0
    await clientA.submit(secondText)
    const secondMessage = await waitForUserMessage(scene, sessionX, secondBoundary,
      event => userText(event) === secondText, `${kind} second prefix accepted`)
    const secondTurn = claimedTurn(scene.sessionEvents(sessionX) ?? [], secondMessage, `${kind} second prefix Turn`)
    await waitForTurnEnd(scene, sessionX, secondBoundary, secondTurn.turn, `${kind} second prefix completed`)

    rehold(host, `${kind} held wave`)
    const heldWorkBoundary = fixtureHelpers.readC1WorkEvents(host.workloadRoot!).length
    const heldBoundary = scene.sessionEvents(sessionX)?.length ?? 0
    await clientA.submit(heldText)
    await waitForWorkAfter(host, heldWorkBoundary,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionX,
      `${kind} source Turn held`)
    const heldMessage = await waitForUserMessage(scene, sessionX, heldBoundary,
      event => userText(event) === heldText, `${kind} held source occurrence`)
    const heldTurn = claimedTurn(scene.sessionEvents(sessionX) ?? [], heldMessage, `${kind} held source Turn`)
    expect(existsSync(holdPath(host)), `${kind}: source hold was released before ${kind}`).toBe(false)

    const clientB = await scene.startClient({
      label: `${kind}-peer`,
      ...clientDirectories(scene, `${kind}-peer`),
      sessionId: sessionX,
    })
    expect(clientB.ready.openSessionId, 'peer lost the source Session').toBe(sessionX)
    await waitFrame(clientB, heldText, 'peer read the held source Turn')

    const sessionsBefore = new Set(await scene.sessionIds())
    const navigationBoundary = recordCount(clientA)
    if (kind === 'rewind') {
      await clientA.submit('/rewind')
      await waitFrame(clientA, `turn 2 · ${secondText}`, 'rewind picker listed the completed Turn')
      const selectedTurn = (frame: string): number | undefined => {
        const row = frame.split('\n').find(line => /> +turn \d+ ·/u.test(line))
        const match = row?.match(/> +turn (\d+) ·/u)
        return match === null || match === undefined ? undefined : Number(match[1])
      }
      let selected = selectedTurn(await clientA.text())
      expect(selected, 'rewind picker painted no selected Turn').toBeTypeOf('number')
      for (let step = 0; step < 6 && selected !== 2; step += 1) {
        const before = selected
        await clientA.press('Down')
        const started = Date.now()
        for (;;) {
          selected = selectedTurn(await clientA.text())
          if (selected !== undefined && selected !== before) break
          if (Date.now() - started >= 30_000) {
            throw new Error('rewind picker did not repaint its selected Turn')
          }
          await sleep(25)
        }
      }
      expect(selected, 'rewind picker never selected the intended completed Turn').toBe(2)
      await clientA.press('Enter')
    } else {
      await clientA.submit('/fork')
    }
    const onChild = await waitForSurfaceStatusAfter(clientA, navigationBoundary,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string'
        && record.openSessionId !== sessionX && record.transport === 'connected'
        && record.surfaceMounted === true,
      `${kind}: Client adopted the published child Session`)
    const childId = String(onChild.openSessionId)
    const newIds = (await scene.sessionIds()).filter(id => !sessionsBefore.has(id))
    expect(newIds, `${kind}: ${newIds.length} child Sessions were published`).toEqual([childId])
    const childHeader = headerFacts(await scene.waitForHostSessionHeader(childId, `${kind} child header`),
      `${kind} child header`)
    expect(childHeader.isSeeded, `${kind}: child is not a seeded Session`).toBe(true)
    expect(childHeader.parentSession, `${kind}: child claimed a parent Session`).toBeUndefined()
    expect(childHeader.origin, `${kind}: child claimed a subagent origin`).toBeUndefined()
    const childTexts = (scene.sessionEvents(childId) ?? [])
      .filter(event => event.type === 'user/message').map(event => userText(event))
    expect(childTexts.filter(text => text === firstText), `${kind}: child lost the first completed Turn`)
      .toHaveLength(1)
    if (kind === 'fork') {
      expect(childTexts.filter(text => text === secondText), 'fork lost the latest completed Turn')
        .toHaveLength(1)
    } else {
      expect(childTexts.filter(text => text === secondText), 'rewind kept the selected Turn')
        .toHaveLength(0)
      await waitForComposerDraft(clientA, secondText, 'rewind restored the selected prompt into the editor')
      await clientA.press('Ctrl+U')
      await waitForComposerDraft(clientA, '', 'rewind restored prompt cleared from the editor')
    }
    expect(childTexts.filter(text => text === heldText), `${kind}: child inherited the running source Turn`)
      .toHaveLength(0)
    expect(scene.sessionEvents(sessionX)?.slice(heldBoundary).some(event => event.type === 'turn/end'),
      `${kind}: source Turn ended before the hold was released`).toBe(false)
    expect(existsSync(holdPath(host)), `${kind}: source hold was released by navigation`).toBe(false)
    expect(clientB.readRecords().some(record => record.m4b2s === 'client-closed'),
      `${kind}: peer closed during navigation`).toBe(false)

    const childOwnText = `${kind} child own prompt`
    const childBoundary = scene.sessionEvents(childId)?.length ?? 0
    const childWorkBoundary = fixtureHelpers.readC1WorkEvents(host.workloadRoot!).length
    await clientA.submit(childOwnText)
    await waitForWorkAfter(host, childWorkBoundary,
      event => event.kind === 'long-turn-held' && event.sessionId === childId,
      `${kind}: child prompt held`)
    await waitForUserMessage(scene, childId, childBoundary,
      event => userText(event) === childOwnText, `${kind}: child prompt committed`)

    const sourceReleaseIndex = scene.sessionEvents(sessionX)?.length ?? 0
    releaseHold(host)
    const sourceEnd = await waitForTurnEnd(scene, sessionX, sourceReleaseIndex,
      heldTurn.turn, `${kind}: source Turn completed`)
    expect(sourceEnd.data?.reason?.kind, `${kind}: source Turn did not complete normally`).toBe('completed')
    await waitFrame(clientB, 'long-turn answer 1', `${kind}: peer read the source completion`)
    const childTurnEvent = await waitForUserMessage(scene, childId, childBoundary,
      event => userText(event) === childOwnText, `${kind}: child occurrence after release`)
    const childTurn = claimedTurn(scene.sessionEvents(childId) ?? [], childTurnEvent, `${kind}: child Turn`)
    await waitForTurnEnd(scene, childId, childBoundary, childTurn.turn, `${kind}: child Turn completed`)
    expect((scene.sessionEvents(sessionX) ?? []).some(event =>
      event.type === 'user/message' && userText(event) === childOwnText),
    `${kind}: child-only prompt leaked into the source Session`).toBe(false)

    await expectHostIdentity(scene, host, `${kind} Host after ${kind}`)
    await keepAndDisconnect(clientA, `${kind} source Client`)
    await keepAndDisconnect(clientB, `${kind} peer Client`)
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, `${kind} completed prefix`)
  }
}

test('forks a completed prefix while the source Turn continues', async () => {
  await runCompletedPrefixCase('fork')
})

test('rewinds to a completed prefix without cancelling the source', async () => {
  await runCompletedPrefixCase('rewind')
})

test('stops the captured running Session only on explicit cancellation', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'long-turn' })
    const clientA = await scene.startClient({
      label: 'cancellation-source',
      ...clientDirectories(scene, 'cancellation-source'),
    })
    const sourceText = 'cancellation source prompt'
    const { sessionId: sessionX, seed } = await startHeldSession(
      scene, host, clientA, sourceText, 'cancellation source')
    const sourceTurn = claimedTurn(scene.sessionEvents(sessionX) ?? [], seed, 'cancellation source Turn')
    const clientB = await scene.startClient({
      label: 'cancellation-peer',
      ...clientDirectories(scene, 'cancellation-peer'),
      sessionId: sessionX,
    })
    expect(clientB.ready.openSessionId, 'peer did not attach to the source Session').toBe(sessionX)
    await waitFrame(clientB, sourceText, 'peer read the source history')

    await clientA.submit('/new')
    const targetBoundary = 0
    const targetSession = await scene.waitForNewSessionId(new Set([sessionX]), 'cancellation target Session')
    await scene.waitForHostSessionHeader(targetSession, 'cancellation target Session header')
    await clientA.waitForSurfaceStatus(record => record.openSessionId === targetSession
      && record.transport === 'connected' && record.surfaceMounted === true,
    'cancellation target surface ready')
    await waitForComposerDraft(clientA, '', 'cancellation target editor ready')
    const targetText = 'cancellation target prompt'
    const targetWorkBoundary = fixtureHelpers.readC1WorkEvents(host.workloadRoot!).length
    await clientA.submit(targetText)
    await waitForWorkAfter(host, targetWorkBoundary,
      event => event.kind === 'long-turn-held' && event.sessionId === targetSession,
      'cancellation target Turn held')
    const targetMessage = await waitForUserMessage(scene, targetSession, targetBoundary,
      event => userText(event) === targetText, 'cancellation target accepted')
    const targetTurn = claimedTurn(scene.sessionEvents(targetSession) ?? [], targetMessage,
      'cancellation target Turn')

    const backBoundary = recordCount(clientA)
    await clientA.submit(`/resume ${sessionX}`)
    await waitForSurfaceStatusAfter(clientA, backBoundary,
      record => record.sessionOpen === true && record.openSessionId === sessionX
        && record.transport === 'connected' && record.surfaceMounted === true,
      'A returned to the running source Session')
    await waitFrame(clientA, sourceText, 'A painted the source Turn before cancelling it')

    const cancelBoundary = scene.sessionEvents(sessionX)?.length ?? 0
    await clientA.press('Escape')
    const aborted = await waitForTurnEnd(scene, sessionX, cancelBoundary,
      sourceTurn.turn, 'explicit cancellation settled the source Turn')
    expect(aborted.data?.reason, 'explicit cancellation did not abort a user Turn').toMatchObject({
      kind: 'aborted',
      reason: { kind: 'user' },
    })
    expect(existsSync(holdPath(host)), 'explicit cancellation released the shared hold').toBe(false)
    expect(scene.sessionEvents(targetSession)?.some(event => event.type === 'turn/end'),
      'explicit cancellation also stopped the target Session').toBe(false)
    expect(clientB.readRecords().some(record => record.m4b2s === 'client-closed'),
      'explicit cancellation closed the peer').toBe(false)

    const targetReleaseIndex = scene.sessionEvents(targetSession)?.length ?? 0
    releaseHold(host)
    const targetEnd = await waitForTurnEnd(scene, targetSession, targetReleaseIndex,
      targetTurn.turn, 'cancellation target completed after the release')
    expect(targetEnd.data?.reason?.kind, 'target did not complete normally').toBe('completed')
    await waitFrameGone(clientA, 'long-turn answer 1', 'cancelled source painted no fabricated answer')
    const returnBoundary = recordCount(clientA)
    await clientA.submit(`/resume ${targetSession}`)
    await waitForSurfaceStatusAfter(clientA, returnBoundary,
      record => record.sessionOpen === true && record.openSessionId === targetSession
        && record.transport === 'connected' && record.surfaceMounted === true,
      'A returned to the target Session after cancelling the source')
    await waitFrame(clientA, 'long-turn answer 1', 'A read the target settlement')

    const peerBoundary = scene.sessionEvents(sessionX)?.length ?? 0
    await clientB.submit('cancellation peer follow-up')
    const peerMessage = await waitForUserMessage(scene, sessionX, peerBoundary,
      event => userText(event) === 'cancellation peer follow-up', 'peer continued on the source Session')
    const peerTurn = claimedTurn(scene.sessionEvents(sessionX) ?? [], peerMessage, 'peer continuation Turn')
    await waitForTurnEnd(scene, sessionX, peerBoundary, peerTurn.turn, 'peer continuation completed')
    await waitFrame(clientB, 'long-turn answer 2', 'peer painted its own answer')
    await expectHostIdentity(scene, host, 'Host after explicit cancellation')
    await keepAndDisconnect(clientA, 'cancellation source Client')
    await keepAndDisconnect(clientB, 'cancellation peer Client')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'explicit cancellation')
  }
})
