import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'vitest'

import { historyFilePath, parseHistoryRecordLine } from '../../../../src/client/history/store.ts'
import { readOfficialClientRecords } from '../../../support/split-process-client.ts'
import {
  createSplitProcessScene,
  type SplitProcessClient,
  type SplitProcessHostHandle,
  type SplitProcessScene,
  type SessionEvent,
} from '../../../support/split-process-fixture.ts'

type WorkEvent = Record<string, any>

const fixtureHelpers = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-fixtures.mjs')).href
) as {
  readC1WorkEvents(root: string): WorkEvent[]
  waitForC1WorkEvent(root: string, predicate: (event: WorkEvent) => boolean, label: string, timeoutMs?: number): Promise<WorkEvent>
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

function clientDirectories(scene: SplitProcessScene, label: string): { home: string; cwd: string } {
  const root = join(scene.workDir, 'clients', label)
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  return { home, cwd }
}

async function waitFrame(client: SplitProcessClient, text: string, label: string, timeoutMs = 120_000): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (frame.includes(text)) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: ${JSON.stringify(text)} was not painted; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(25)
  }
}

async function waitFrameGone(client: SplitProcessClient, text: string, label: string, timeoutMs = 120_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (!frame.includes(text)) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: ${JSON.stringify(text)} remained painted; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(25)
  }
}

function composerDraft(frame: string): string | undefined {
  const lines = frame.split('\n')
  const marker = lines.findLastIndex(line => line.includes('❯'))
  if (marker < 0) return undefined
  const at = lines[marker]!.indexOf('❯')
  return lines[marker]!.slice(at + '❯'.length).trim()
}

async function waitForComposerDraft(client: SplitProcessClient, expected: string, label: string, timeoutMs = 120_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    const draft = composerDraft(await client.text())
    if (draft === expected) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: composer draft was ${JSON.stringify(draft)}, expected ${JSON.stringify(expected)}`)
    }
    await sleep(25)
  }
}

function recordCount(client: SplitProcessClient): number {
  return readOfficialClientRecords(client.recordFile, client.label, { allowIncompleteTail: true }).length
}

function recordsAfter(client: SplitProcessClient, afterIndex: number): Record<string, any>[] {
  return readOfficialClientRecords(client.recordFile, client.label, { allowIncompleteTail: true }).slice(afterIndex)
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
    const record = recordsAfter(client, afterIndex)
      .filter(candidate => candidate.m4b2s === 'surface-status')
      .find(predicate)
    if (record !== undefined) return record
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: no fresh matching surface-status record within ${String(timeoutMs)}ms`)
    }
    await sleep(25)
  }
}

async function waitForWork(
  host: SplitProcessHostHandle,
  predicate: (event: WorkEvent) => boolean,
  label: string,
): Promise<WorkEvent> {
  expect(host.workloadRoot, 'the Host has no registered workload root').toBeTypeOf('string')
  return await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!, predicate, label)
}

function holdPath(host: SplitProcessHostHandle): string {
  expect(host.holdReleasePath, 'the Host has no registered hold barrier').toBeTypeOf('string')
  return host.holdReleasePath!
}

function releaseHold(host: SplitProcessHostHandle): void {
  writeFileSync(holdPath(host), 'release\n', { mode: 0o600, flag: 'wx' })
}

function rehold(host: SplitProcessHostHandle): void {
  rmSync(holdPath(host), { force: true })
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

async function waitForAnswer(
  scene: SplitProcessScene,
  sessionId: string,
  afterIndex: number,
  text: string,
  label: string,
): Promise<SessionEvent> {
  return await scene.waitForSessionEvent(sessionId, afterIndex,
    event => event.type === 'assistant/message' && assistantText(event).includes(text), label)
}

function expectOneUser(
  events: SessionEvent[],
  id: string,
  text: string,
  source: Record<string, any>,
  label: string,
): void {
  const matches = events.filter(event => event.type === 'user/message' && event.data?.id === id)
  expect(matches, `${label}: exact user occurrence count`).toHaveLength(1)
  expect(userText(matches[0]), `${label}: exact user occurrence text`).toBe(text)
  expect(matches[0]?.data?.source?.kind, `${label}: claimed occurrence is not human-authored`).toBe('user')
  expect(matches[0]?.data?.source, `${label}: claimed occurrence provenance changed`).toEqual(source)
}

async function exitClient(client: SplitProcessClient, label: string): Promise<void> {
  await client.exitGracefully()
  const exit = await client.close()
  expect(exit.code, `${label}: native exit code`).toBe(0)
  expect(exit.signal, `${label}: native exit signal`).toBeNull()
  expect(client.closed, `${label}: Supervisor close settlement`).toBe(true)
  const state = await client.state()
  expect(state.exited, `${label}: native terminal is not exited`).toBe(true)
  expect(state.businessPids.length, `${label}: no historical business identity was captured`).toBeGreaterThan(0)
  expect(state.businessStates, `${label}: historical business identity facts are missing`).toHaveLength(state.businessPids.length)
  for (const business of state.businessStates) {
    expect(['gone', 'reused'], `${label}: business PID ${String(business.pid)} is not terminal`).toContain(business.state)
  }
  expect(state.sessionListed, `${label}: native session remains listed`).toBe(false)
  const closed = readOfficialClientRecords(client.recordFile, client.label)
    .filter(record => record.m4b2s === 'client-closed').at(-1)
  expect(closed, `${label}: no official close record`).toBeDefined()
  expect(closed?.activeWrappers, `${label}: wrappers remain`).toBe(0)
  expect(closed?.liveSockets, `${label}: sockets remain`).toBe(0)
  expect(closed?.transport, `${label}: transport remains connected`).not.toBe('connected')
}

async function expectHostIdentity(scene: SplitProcessScene, host: SplitProcessHostHandle, label: string): Promise<void> {
  const status = await scene.hostStatus(host)
  const initial = host.ready.localHost
  expect(status.localHost.hostPid, `${label}: Host PID changed`).toBe(initial.hostPid)
  expect(status.localHost.instanceId, `${label}: Host instance changed`).toBe(initial.instanceId)
  if (initial.hostStarttime !== undefined) {
    expect(status.localHost.hostStarttime, `${label}: Host birth changed`).toBe(initial.hostStarttime)
  } else {
    expect(initial.hostKernelIdentity, `${label}: initial native Host birth is missing`).toBeDefined()
    expect(status.localHost.hostKernelIdentity, `${label}: native Host birth changed`).toEqual(initial.hostKernelIdentity)
  }
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
  const boundary = 0
  await client.submit(prompt)
  const sessionId = await scene.waitForNewSessionId(before, `${label}: Session creation`)
  await waitForWork(host,
    event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
    `${label}: held Turn`)
  const seed = await waitForUserMessage(scene, sessionId, boundary,
    event => userText(event) === prompt, `${label}: seed user/message`)
  expect(seed.data?.id, `${label}: seed identity`).toBeTypeOf('string')
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
  expect(item.id, `${label}: empty Host occurrence identity`).not.toBe('')
  expect(item.source?.kind, `${label}: queued occurrence is not human-authored`).toBe('user')
  return { event, item }
}

function queueBody(frame: string): string {
  const lines = frame.split('\n')
  const end = lines.findIndex(line => line.includes('Delete [D]') || line.includes('Esc close'))
  if (end < 0) return ''
  const start = lines.slice(0, end).findLastIndex(line => /Queue\b/u.test(line) && line.includes('queued'))
  return start < 0 ? '' : lines.slice(start + 1, end).join('\n')
}

function queueRows(frame: string, candidates: string[]): Array<{ text: string; selected: boolean }> {
  return queueBody(frame).split('\n').flatMap(line => {
    const text = candidates.find(candidate => line.includes(candidate))
    const row = line.replace(/^\s*│\s?/u, '').trimStart()
    return text === undefined ? [] : [{ text, selected: row.startsWith('> ') }]
  })
}

async function selectQueueRow(
  client: SplitProcessClient,
  target: string,
  candidates: string[],
  label: string,
): Promise<void> {
  const rows = queueRows(await client.text(), candidates)
  const selectedIndex = rows.findIndex(row => row.selected)
  const targetIndex = rows.findIndex(row => row.text === target)
  expect(selectedIndex, `${label}: the current painted queue row is not uniquely selected`).toBeGreaterThanOrEqual(0)
  expect(targetIndex, `${label}: target ${JSON.stringify(target)} is not painted`).toBeGreaterThanOrEqual(0)
  if (selectedIndex === targetIndex) return
  const key = targetIndex > selectedIndex ? 'Down' : 'Up'
  const distance = Math.abs(targetIndex - selectedIndex)
  for (let step = 0; step < distance; step += 1) {
    const before = queueRows(await client.text(), candidates).find(row => row.selected)?.text
    await client.press(key)
    const started = Date.now()
    for (;;) {
      const after = queueRows(await client.text(), candidates).find(row => row.selected)?.text
      if (after !== undefined && after !== before) break
      if (Date.now() - started >= 30_000) {
        throw new Error(`${label}: ${key} did not repaint the queue selection; frame=${JSON.stringify((await client.text()).slice(-2000))}`)
      }
      await sleep(25)
    }
  }
  expect(queueRows(await client.text(), candidates).find(row => row.selected)?.text,
    `${label}: deterministic navigation did not select ${JSON.stringify(target)}`).toBe(target)
}

async function expectQueuedProjection(
  client: SplitProcessClient,
  present: string[],
  absent: string[],
  label: string,
): Promise<void> {
  await client.submit('/queue')
  await waitFrame(client, 'Delete [D]', `${label}: queue manager`)
  const body = queueBody(await client.text())
  for (const text of present) expect(body, `${label}: missing queued projection ${JSON.stringify(text)}`).toContain(text)
  for (const text of absent) expect(body, `${label}: stale queued projection ${JSON.stringify(text)}`).not.toContain(text)
  await client.press('Esc')
  await waitFrameGone(client, 'Delete [D]', `${label}: queue manager closed`)
}

async function replaceEditDraft(client: SplitProcessClient, text: string, label: string): Promise<void> {
  await client.press('Ctrl+E', 'Ctrl+U')
  await client.type(text)
  await waitFrame(client, text, `${label}: replacement draft`)
}

interface HistorySnapshot {
  directory: { ino: number; mode: number; mtimeMs: number } | undefined
  files: Array<{ name: string; ino: number; mode: number; size: number; mtimeMs: number; bytes: string }>
}

function snapshotHistory(directory: string): HistorySnapshot {
  if (!existsSync(directory)) return { directory: undefined, files: [] }
  const dir = statSync(directory)
  return {
    directory: { ino: dir.ino, mode: dir.mode, mtimeMs: dir.mtimeMs },
    files: readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const path = join(directory, entry.name)
        const stat = statSync(path)
        return {
          name: entry.name,
          ino: stat.ino,
          mode: stat.mode,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          bytes: readFileSync(path, 'utf8'),
        }
      })
      .sort((left, right) => left.name.localeCompare(right.name)),
  }
}

test('shares queued occurrences across Clients and claims the steered occurrence before the next Turn', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'long-turn' })
    const clientA = await scene.startClient({ label: 'queue-a', ...clientDirectories(scene, 'queue-a') })
    const { sessionId } = await startHeldSession(scene, host, clientA, 'shared-queue-seed', 'shared queue seed')
    const clientB = await scene.startClient({ label: 'queue-b', ...clientDirectories(scene, 'queue-b'), sessionId })
    expect(clientB.ready.openSessionId, 'B attached to another Session').toBe(sessionId)
    await waitFrame(clientB, 'shared-queue-seed', 'B read shared history')

    const bQueued = await queueMessage(scene, sessionId, clientB, 'shared-b-queued', 'B queue')
    await waitFrame(clientA, 'shared-b-queued', 'A read B pending occurrence')
    const steerBoundary = scene.sessionEvents(sessionId)?.length ?? 0
    await clientA.press('Ctrl+S')
    const removal = await scene.waitForSessionEvent(sessionId, steerBoundary,
      event => event.type === 'agent/inbox/spliced' && event.data?.target === 'next-turn'
        && event.data?.removedCount === 1 && (event.data.inserted ?? []).length === 0,
      'Ctrl+S removed B occurrence from next-turn')
    const steered = await scene.waitForSessionEvent(sessionId, steerBoundary,
      event => event.type === 'agent/inbox/spliced' && event.data?.target === 'next-step'
        && (event.data.inserted ?? []).filter((message: Record<string, any>) => message?.id === bQueued.item.id).length === 1,
      'Ctrl+S inserted the exact B occurrence into next-step')
    expect(removal.data?.start, 'Ctrl+S removed a different queue position').toBe(bQueued.event.data?.start)
    expect(steered.data?.inserted, 'Ctrl+S duplicated the B occurrence').toHaveLength(1)

    const aQueued = await queueMessage(scene, sessionId, clientA, 'shared-a-queued', 'A queue')
    await waitFrame(clientB, 'shared-a-queued', 'B read A pending occurrence')
    const beforeRelease = scene.sessionEvents(sessionId) ?? []
    expect(beforeRelease.some(event => event.type === 'user/message'
      && (event.data?.id === bQueued.item.id || event.data?.id === aQueued.item.id)),
    'a pending occurrence was claimed before release').toBe(false)

    const releaseBoundary = beforeRelease.length
    releaseHold(host)
    const claimedB = await waitForUserMessage(scene, sessionId, releaseBoundary,
      event => event.data?.id === bQueued.item.id, 'B occurrence claimed in the running Turn')
    const claimedA = await waitForUserMessage(scene, sessionId, releaseBoundary,
      event => event.data?.id === aQueued.item.id, 'A occurrence claimed in the next Turn')
    const claimEvents = scene.sessionEvents(sessionId) ?? []
    const bClaim = claimedTurn(claimEvents, claimedB, 'B steered claim')
    const aClaim = claimedTurn(claimEvents, claimedA, 'A next-Turn claim')
    expect(aClaim.turn, 'the next queued occurrence did not start a later Turn').toBe(bClaim.turn + 1)
    expect(aClaim.startIndex, 'next-Turn occurrence has no new authoritative turn/start').toBeGreaterThan(
      durableEventIndex(claimEvents, claimedB, 'B claim'))
    const bClaimIndex = durableEventIndex(claimEvents, claimedB, 'B claim')
    const aClaimIndex = durableEventIndex(claimEvents, claimedA, 'A claim')
    expect(bClaimIndex, 'B was not claimed before A').toBeLessThan(aClaimIndex)
    await waitForTurnEnd(scene, sessionId, releaseBoundary, bClaim.turn, 'steered Turn end')
    await waitForTurnEnd(scene, sessionId, releaseBoundary, aClaim.turn, 'next Turn end')
    const bAnswer = await waitForAnswer(scene, sessionId, bClaimIndex, 'long-turn answer 2', 'B steered answer')
    const aAnswer = await waitForAnswer(scene, sessionId, aClaimIndex, 'long-turn answer 3', 'A next-Turn answer')
    const finalEvents = scene.sessionEvents(sessionId) ?? []
    expect(durableEventIndex(finalEvents, bAnswer, 'B answer'), 'B answer was not in its Turn')
      .toBeLessThan(aClaimIndex)
    await waitFrame(clientA, assistantText(aAnswer), 'A painted its own settlement')
    await waitFrame(clientB, assistantText(bAnswer), 'B painted the shared steered settlement')
    expectOneUser(finalEvents, bQueued.item.id, 'shared-b-queued', bQueued.item.source, 'B occurrence')
    expectOneUser(finalEvents, aQueued.item.id, 'shared-a-queued', aQueued.item.source, 'A occurrence')

    await exitClient(clientB, 'shared queue B')
    await expectHostIdentity(scene, host, 'shared queue after B exit')
    await exitClient(clientA, 'shared queue A')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'shared queue')
  }
})

test('keeps two independent same-text submissions as distinct Host occurrences', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'long-turn' })
    const clientA = await scene.startClient({ label: 'same-a', ...clientDirectories(scene, 'same-a') })
    const before = new Set(await scene.sessionIds())
    await clientA.submit('shared-same-text')
    const sessionId = await scene.waitForNewSessionId(before, 'same-text Session creation')
    await waitForWork(host,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
      'first same-text Turn held')
    const first = await waitForUserMessage(scene, sessionId, 0,
      event => userText(event) === 'shared-same-text', 'first same-text user/message')
    const firstEvents = scene.sessionEvents(sessionId) ?? []
    const firstClaim = claimedTurn(firstEvents, first, 'first same-text claim')
    releaseHold(host)
    await waitForTurnEnd(scene, sessionId, 0, firstClaim.turn, 'first same-text Turn end')
    await waitForAnswer(scene, sessionId, durableEventIndex(firstEvents, first, 'first same-text claim'),
      'long-turn answer 1', 'first same-text answer')

    const clientB = await scene.startClient({ label: 'same-b', ...clientDirectories(scene, 'same-b'), sessionId })
    await waitFrame(clientB, 'shared-same-text', 'B read the first same-text occurrence')
    const boundary = scene.sessionEvents(sessionId)?.length ?? 0
    await clientB.submit('shared-same-text')
    const second = await waitForUserMessage(scene, sessionId, boundary,
      event => userText(event) === 'shared-same-text', 'second same-text user/message')
    expect(first.data?.id, 'first same-text identity').toBeTypeOf('string')
    expect(second.data?.id, 'second same-text identity').toBeTypeOf('string')
    expect(second.data?.id, 'same-text submissions reused one identity').not.toBe(first.data?.id)
    const secondEvents = scene.sessionEvents(sessionId) ?? []
    const secondClaim = claimedTurn(secondEvents, second, 'second same-text claim')
    expect(secondClaim.startIndex, 'second same-text submission has no new turn/start').toBeGreaterThan(
      durableEventIndex(firstEvents, first, 'first same-text claim'))
    await waitForTurnEnd(scene, sessionId, boundary, secondClaim.turn, 'second same-text Turn end')
    const answer = await waitForAnswer(scene, sessionId, boundary, 'long-turn answer 2', 'second same-text answer')
    await waitFrame(clientA, assistantText(answer), 'A painted the second same-text answer')
    await waitFrame(clientB, assistantText(answer), 'B painted its same-text answer')
    const events = scene.sessionEvents(sessionId) ?? []
    expect(events.filter(event => event.type === 'user/message' && userText(event) === 'shared-same-text'),
      'same-text durable occurrence count').toHaveLength(2)

    await exitClient(clientA, 'same-text A')
    await exitClient(clientB, 'same-text B')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'same-text submissions')
  }
})

test('keeps sibling Session writes separate and survives one Client exit', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'long-turn' })
    const clientA = await scene.startClient({ label: 'sibling-a', ...clientDirectories(scene, 'sibling-a') })
    const { sessionId: sessionX, seed } = await startHeldSession(scene, host, clientA, 'sibling-x-seed', 'sibling X seed')
    const seedEvents = scene.sessionEvents(sessionX) ?? []
    releaseHold(host)
    await waitForTurnEnd(scene, sessionX, 0, claimedTurn(seedEvents, seed, 'sibling X seed claim').turn,
      'sibling X seed Turn end')
    const xHeader = await scene.waitForHostSessionHeader(sessionX, 'sibling X header')
    const clientB = await scene.startClient({ label: 'sibling-b', ...clientDirectories(scene, 'sibling-b'), sessionId: sessionX })
    expect(clientB.ready.openSessionId, 'B did not retain X').toBe(sessionX)

    const navigationBoundary = recordCount(clientA)
    await clientA.submit('/new')
    const aLeft = await waitForSurfaceStatusAfter(clientA, navigationBoundary,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string'
        && record.openSessionId !== sessionX && record.transport === 'connected' && record.surfaceMounted === true,
      'A navigated to Y')
    const sessionY = String(aLeft.openSessionId)
    const yBoundary = 0
    await clientA.submit('sibling-y-only')
    const yMessage = await waitForUserMessage(scene, sessionY, yBoundary,
      event => userText(event) === 'sibling-y-only', 'A wrote only Y')
    await waitForTurnEnd(scene, sessionY, yBoundary,
      claimedTurn(scene.sessionEvents(sessionY) ?? [], yMessage, 'Y write claim').turn, 'Y Turn end')
    await waitFrame(clientA, 'long-turn answer 1', 'A painted Y answer')
    await waitFrameGone(clientA, 'sibling-x-seed', 'A current frame lost X history')

    const xBoundary = scene.sessionEvents(sessionX)?.length ?? 0
    await clientB.submit('sibling-x-only')
    const xMessage = await waitForUserMessage(scene, sessionX, xBoundary,
      event => userText(event) === 'sibling-x-only', 'B wrote only X')
    await waitForTurnEnd(scene, sessionX, xBoundary,
      claimedTurn(scene.sessionEvents(sessionX) ?? [], xMessage, 'X write claim').turn, 'X Turn end')
    await waitFrame(clientB, 'long-turn answer 2', 'B painted X answer')
    await waitFrameGone(clientB, 'sibling-y-only', 'B current frame never imported Y')
    const yEvents = scene.sessionEvents(sessionY) ?? []
    const xEvents = scene.sessionEvents(sessionX) ?? []
    expect(yEvents.some(event => event.type === 'user/message' && userText(event) === 'sibling-x-only'),
      'Y contains B X write').toBe(false)
    expect(xEvents.some(event => event.type === 'user/message' && userText(event) === 'sibling-y-only'),
      'X contains A Y write').toBe(false)
    expect((await scene.waitForHostSessionHeader(sessionX, 'X header after sibling writes')).data,
      'X immutable header changed').toEqual(xHeader.data)

    const bExitBoundary = recordCount(clientB)
    await exitClient(clientB, 'sibling B')
    const bClosed = readOfficialClientRecords(clientB.recordFile, clientB.label)
      .slice(bExitBoundary)
      .find(record => record.m4b2s === 'client-closed')
    expect(bClosed, 'B published no fresh close record').toBeDefined()
    expect(bClosed?.activeWrappers, 'B wrappers after exit').toBe(0)
    expect(bClosed?.liveSockets, 'B sockets after exit').toBe(0)
    expect(bClosed?.transport, 'B transport after exit').not.toBe('connected')
    await expectHostIdentity(scene, host, 'sibling Host after B exit')
    expect(clientA.closed, 'A exited with B').toBe(false)
    expect(scene.sessionEvents(sessionX), 'B exit changed X durable facts').toEqual(xEvents)

    const yAfterBoundary = scene.sessionEvents(sessionY)?.length ?? 0
    await clientA.submit('sibling-y-after-b-exit')
    const yAfter = await waitForUserMessage(scene, sessionY, yAfterBoundary,
      event => userText(event) === 'sibling-y-after-b-exit', 'A wrote Y after B exit')
    await waitForTurnEnd(scene, sessionY, yAfterBoundary,
      claimedTurn(scene.sessionEvents(sessionY) ?? [], yAfter, 'post-exit Y claim').turn, 'post-exit Y Turn end')
    await waitFrame(clientA, 'long-turn answer 2', 'A painted post-exit Y answer')
    await expectHostIdentity(scene, host, 'sibling Host after A continuation')

    await exitClient(clientA, 'sibling A')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'sibling navigation')
  }
})

test('recalls accepted Session input without importing legacy history or modifying its files', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'long-turn' })
    const clientA = await scene.startClient({ label: 'history-a', ...clientDirectories(scene, 'history-a') })
    const { sessionId: sessionX, seed } = await startHeldSession(scene, host, clientA, 'history-x-seed', 'history X seed')
    releaseHold(host)
    await waitForTurnEnd(scene, sessionX, 0,
      claimedTurn(scene.sessionEvents(sessionX) ?? [], seed, 'history X seed claim').turn,
      'history X seed Turn end')
    await waitFrame(clientA, 'long-turn answer 1', 'history X seed answer')
    const xBefore = scene.sessionEvents(sessionX) ?? []

    const bDirs = clientDirectories(scene, 'history-b')
    const historyDirectory = join(scene.installation.dshHome, 'user-history')
    mkdirSync(historyDirectory, { recursive: true, mode: 0o700 })
    const sentinel = 'history-file-only-sentinel-never-host-accepted'
    const sentinelPath = historyFilePath(scene.installation.dshHome, bDirs.cwd)
    const sentinelLine = JSON.stringify({
      v: 2,
      content: sentinel,
      cwd: bDirs.cwd,
      ts: Date.now(),
      sessionId: sessionX,
    })
    writeFileSync(sentinelPath, `${sentinelLine}\n`, { mode: 0o600, flag: 'wx' })
    const parsed = parseHistoryRecordLine(sentinelLine)
    expect(parsed, 'the real history parser did not accept the positive control').toMatchObject({
      version: 2,
      content: sentinel,
      cwd: bDirs.cwd,
      sessionId: sessionX,
    })
    const historyBefore = snapshotHistory(historyDirectory)

    const clientB = await scene.startClient({ label: 'history-b', ...bDirs })
    await waitFrame(clientB, 'dsh-pi-tui', 'B painted the sessionless welcome')
    await waitForComposerDraft(clientB, '', 'B sessionless composer is empty')
    await clientB.press('Up')
    await clientB.type('history-b-probe')
    await waitForComposerDraft(clientB, 'history-b-probe', 'B Up did not import the file-only sentinel')
    expect((await clientB.text()).includes(sentinel), 'B imported the file-only sentinel').toBe(false)
    await clientB.press('Ctrl+U')
    await waitForComposerDraft(clientB, '', 'B probe cleared')
    const resumeBoundary = recordCount(clientB)
    await clientB.submit(`/resume ${sessionX}`)
    const resumed = await waitForSurfaceStatusAfter(clientB, resumeBoundary,
      record => record.sessionOpen === true && record.openSessionId === sessionX
        && record.transport === 'connected' && record.surfaceMounted === true,
      'B resumed exact Session X')
    expect(resumed.openSessionId, 'B resumed another Session').toBe(sessionX)
    await waitFrame(clientB, 'history-x-seed', 'B read X history')
    await waitForComposerDraft(clientB, '', 'B Session composer is empty before the single recall key')
    const xBeforeHostRecall = scene.sessionEvents(sessionX) ?? []
    await clientB.press('Up')
    await waitForComposerDraft(clientB, 'history-x-seed', 'B recalled the legitimate Host seed with one Up')
    expect((await clientB.text()).includes(sentinel), 'B recalled the file-only sentinel in Session X').toBe(false)
    expect(scene.sessionEvents(sessionX), 'Host-seed recall changed durable X facts').toEqual(xBeforeHostRecall)
    await clientB.press('Down')
    await waitForComposerDraft(clientB, '', 'B returned from Host-seed recall to the empty Session draft')
    expect((await clientB.text()).includes(sentinel), 'file-only sentinel appeared after leaving recall').toBe(false)
    await exitClient(clientB, 'history B')
    expect(snapshotHistory(historyDirectory), 'B changed legacy history files').toEqual(historyBefore)

    const navigationBoundary = recordCount(clientA)
    await clientA.submit('/new')
    const aLeft = await waitForSurfaceStatusAfter(clientA, navigationBoundary,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string'
        && record.openSessionId !== sessionX && record.transport === 'connected' && record.surfaceMounted === true,
      'A navigated to Y for accepted recall')
    const sessionY = String(aLeft.openSessionId)
    await clientA.submit('history-y-own-accepted')
    const own = await waitForUserMessage(scene, sessionY, 0,
      event => userText(event) === 'history-y-own-accepted', 'A own accepted Y input')
    await waitForTurnEnd(scene, sessionY, 0,
      claimedTurn(scene.sessionEvents(sessionY) ?? [], own, 'A own Y claim').turn, 'A own Y Turn end')
    await waitFrame(clientA, 'long-turn answer 1', 'A own Y answer')

    const recallBoundary = scene.sessionEvents(sessionY)?.length ?? 0
    await clientA.press('Up')
    await waitForComposerDraft(clientA, 'history-y-own-accepted', 'A recalled its own accepted input')
    expect(scene.sessionEvents(sessionY)?.length, 'recall browse wrote a durable event').toBe(recallBoundary)
    expect(snapshotHistory(historyDirectory), 'recall browse changed legacy history files').toEqual(historyBefore)
    await clientA.submit()
    const recalled = await waitForUserMessage(scene, sessionY, recallBoundary,
      event => userText(event) === 'history-y-own-accepted', 'recalled input submitted once')
    expect(recalled.data?.id, 'recalled submission reused the original identity').not.toBe(own.data?.id)
    await waitForTurnEnd(scene, sessionY, recallBoundary,
      claimedTurn(scene.sessionEvents(sessionY) ?? [], recalled, 'recalled Y claim').turn,
      'recalled input Turn end')
    await waitFrame(clientA, 'long-turn answer 2', 'A painted recalled settlement')
    expect(scene.sessionEvents(sessionX), 'recall or Y writes changed X').toEqual(xBefore)
    expect((await scene.waitForHostSessionHeader(sessionX, 'X header after recall')).data,
      'recall changed X header').toEqual(xBefore[0]?.data)

    await exitClient(clientA, 'history A')
    expect(snapshotHistory(historyDirectory), 'normal Client exit changed legacy history files').toEqual(historyBefore)
    await expectHostIdentity(scene, host, 'history Host after normal exits')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'accepted recall and legacy history')
  }
})

async function runApprovalCase(outcome: 'allowed-once' | 'rejected'): Promise<void> {
  const scene = await createSplitProcessScene()
  let primary: unknown
  const allow = outcome === 'allowed-once'
  try {
    const host = await scene.startHost({ scenario: 'approval-allow' })
    const clientA = await scene.startClient({ label: `approval-${outcome}-a`, ...clientDirectories(scene, `approval-${outcome}-a`) })
    const before = new Set(await scene.sessionIds())
    const aOpenBoundary = recordCount(clientA)
    await clientA.submit('/new')
    await clientA.submit(`/title approval-${outcome}`)
    const sessionId = await scene.waitForNewSessionId(before, `${outcome}: empty Session materialization`)
    const clientB = await scene.startClient({
      label: `approval-${outcome}-b`,
      ...clientDirectories(scene, `approval-${outcome}-b`),
      sessionId,
    })
    const aOpen = await waitForSurfaceStatusAfter(clientA, aOpenBoundary,
      record => record.sessionOpen === true && record.openSessionId === sessionId
        && record.transport === 'connected' && record.surfaceMounted === true,
      `${outcome}: A opened exact Session`)
    expect(aOpen.openSessionId, 'A and B do not share one Session').toBe(sessionId)
    expect(clientB.ready.openSessionId, 'B attached to another Session').toBe(sessionId)
    const quiet = scene.sessionEvents(sessionId) ?? []
    expect(quiet.some(event => event.type === 'turn/start' || event.type === 'tool/call' || event.type === 'approval/asked'),
      `${outcome}: Host activity existed before the trigger`).toBe(false)
    expect(fixtureHelpers.readC1WorkEvents(host.workloadRoot!).every(event =>
      event.kind !== 'approval-request' && event.kind !== 'question-request'),
    `${outcome}: fixture interaction existed before the trigger`).toBe(true)

    const triggerBoundary = quiet.length
    await clientA.submit(`approval-${outcome}-trigger`)
    const call = await scene.waitForSessionEvent(sessionId, triggerBoundary,
      event => event.type === 'tool/call' && event.data?.name === 'bash', `${outcome}: bash tool/call`)
    const toolCallId = call.data?.callId
    expect(toolCallId, `${outcome}: tool call identity`).toBeTypeOf('string')
    const asked = await scene.waitForSessionEvent(sessionId, triggerBoundary,
      event => event.type === 'approval/asked', `${outcome}: approval/asked`)
    const requestId = asked.data?.id
    expect(requestId, `${outcome}: approval request identity`).toBeTypeOf('string')
    expect(asked.data?.callId === undefined || asked.data.callId === toolCallId,
      `${outcome}: approval/tool correlation`).toBe(true)
    const request = await waitForWork(host,
      event => event.kind === 'approval-request' && event.sessionId === sessionId,
      `${outcome}: fixture observed the official request`)
    expect(request.callId, `${outcome}: fixture call correlation`).toBe(toolCallId)

    await waitFrame(clientA, '[y] Allow once', `${outcome}: A approval sheet`)
    await waitFrame(clientB, '[y] Allow once', `${outcome}: B approval sheet`)
    await waitFrame(clientA, '[n] Reject', `${outcome}: A reject affordance`)
    await waitFrame(clientB, '[n] Reject', `${outcome}: B reject affordance`)
    const decisionBoundary = scene.sessionEvents(sessionId)?.length ?? 0
    const winner = allow ? clientA : clientB
    const loser = allow ? clientB : clientA
    await winner.press(allow ? 'y' : 'n')
    const decided = await scene.waitForSessionEvent(sessionId, decisionBoundary,
      event => event.type === 'approval/decided' && event.data?.id === requestId && event.data?.outcome === outcome,
      `${outcome}: exact approval decision`)
    expect(decided.data?.id, `${outcome}: decision identity`).toBe(requestId)
    const settled = await waitForWork(host,
      event => event.kind === 'approval-settled' && event.callId === toolCallId && event.outcome === outcome,
      `${outcome}: official fixture settlement`)
    expect(settled.callId, `${outcome}: settlement call identity`).toBe(toolCallId)
    const toolResult = await scene.waitForSessionEvent(sessionId, decisionBoundary,
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolCallId,
      `${outcome}: exact tool/result`)
    expect(Boolean(toolResult.data?.message?.isError), `${outcome}: tool error flag`).toBe(!allow)
    const approvalTurn = call.data?.turn
    expect(approvalTurn, `${outcome}: tool/call carries no authoritative Turn identity`).toBeTypeOf('number')
    await waitForTurnEnd(scene, sessionId, decisionBoundary,
      approvalTurn as number, `${outcome}: approval Turn end`)
    await waitFrame(winner, 'approval settled', `${outcome}: winner sheet settled`)
    await waitFrameGone(loser, '[y] Allow once', `${outcome}: loser sheet withdrawn`)

    const lateBoundary = scene.sessionEvents(sessionId)?.length ?? 0
    const lateKey = allow ? 'n' : 'y'
    await loser.press(lateKey)
    await loser.type('-late-editor')
    await waitFrame(loser, `${lateKey}-late-editor`, `${outcome}: loser key became ordinary editor input`)
    await loser.press('Ctrl+U')
    await waitFrameGone(loser, `${lateKey}-late-editor`, `${outcome}: late editor draft cleared`)
    const afterLate = scene.sessionEvents(sessionId) ?? []
    expect(afterLate.slice(lateBoundary).some(event => event.type === 'approval/asked' || event.type === 'approval/decided'),
      `${outcome}: late loser key produced another approval`).toBe(false)
    expect(afterLate.slice(lateBoundary).some(event => event.type === 'tool/result'
      && String(event.data?.message?.toolCallId) === toolCallId),
    `${outcome}: late loser key produced another tool result`).toBe(false)

    const marker = join(host.workloadRoot!, 'approval-allow.marker')
    expect(existsSync(marker), `${outcome}: allow marker presence`).toBe(allow)
    if (allow) expect(readFileSync(marker, 'utf8'), 'allow marker content').toBe('c1-approval-allow')
    await exitClient(loser, `${outcome} loser`)
    await expectHostIdentity(scene, host, `${outcome} Host after loser exit`)
    expect(winner.closed, `${outcome}: winner exited with loser`).toBe(false)
    await waitFrame(winner, `approval-${outcome}-trigger`, `${outcome}: winner kept its Session`)

    const finalEvents = scene.sessionEvents(sessionId) ?? []
    expect(finalEvents.filter(event => event.type === 'approval/asked' && event.data?.id === requestId),
      `${outcome}: asked count`).toHaveLength(1)
    expect(finalEvents.filter(event => event.type === 'approval/decided' && event.data?.id === requestId),
      `${outcome}: decision count`).toHaveLength(1)
    expect(finalEvents.filter(event => event.type === 'tool/result'
      && String(event.data?.message?.toolCallId) === toolCallId),
    `${outcome}: tool result count`).toHaveLength(1)
    const proofs = fixtureHelpers.readC1WorkEvents(host.workloadRoot!)
    expect(proofs.filter(event => event.kind === 'approval-settled' && event.callId === toolCallId),
      `${outcome}: fixture settlement count`).toHaveLength(1)
    expect(proofs.filter(event => event.kind === 'approval-failed' && event.callId === toolCallId),
      `${outcome}: fixture failure count`).toHaveLength(0)

    await exitClient(winner, `${outcome} winner`)
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, `approval ${outcome}`)
  }
}

test('allows one shared approval and ignores the loser late reject', async () => {
  await runApprovalCase('allowed-once')
})

test('rejects one shared approval and ignores the loser late allow', async () => {
  await runApprovalCase('rejected')
})

test('edits and removes exact queued occurrences without claiming the cancelled draft or removed message', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'long-turn' })
    const clientA = await scene.startClient({ label: 'mutate-a', ...clientDirectories(scene, 'mutate-a') })
    const { sessionId } = await startHeldSession(scene, host, clientA, 'queue-mutation-seed', 'queue mutation seed')
    const clientB = await scene.startClient({ label: 'mutate-b', ...clientDirectories(scene, 'mutate-b'), sessionId })
    const editOriginal = 'queue-edit-original'
    const removeOriginal = 'queue-remove-original'
    const editReplacement = 'queue-edit-replacement-accepted'
    const cancelledDraft = 'queue-edit-cancelled-draft'
    const queuedEdit = await queueMessage(scene, sessionId, clientB, editOriginal, 'queue edit target')
    const queuedRemove = await queueMessage(scene, sessionId, clientB, removeOriginal, 'queue remove target')
    await waitFrame(clientA, editOriginal, 'A queue edit target')
    await waitFrame(clientA, removeOriginal, 'A queue remove target')

    const browseBoundary = scene.sessionEvents(sessionId)?.length ?? 0
    await clientA.submit('/queue')
    await waitFrame(clientA, 'Delete [D]', 'A queue manager')
    await selectQueueRow(clientA, editOriginal, [editOriginal, removeOriginal], 'select edit target')
    await clientA.press('Enter')
    await waitFrame(clientA, 'Edit queued message', 'A edit page')
    await replaceEditDraft(clientA, cancelledDraft, 'cancelled edit')
    await clientA.press('Esc')
    await waitFrame(clientA, 'Delete [D]', 'cancelled edit returned to browse')
    await waitFrame(clientA, editOriginal, 'cancelled edit restored the Host text')
    await waitFrameGone(clientA, cancelledDraft, 'cancelled edit draft disappeared')
    expect((scene.sessionEvents(sessionId) ?? []).slice(browseBoundary).some(event =>
      event.type === 'agent/inbox/spliced' || event.type === 'user/message'),
    'cancelled edit changed the Host queue or claimed a message').toBe(false)

    await selectQueueRow(clientA, editOriginal, [editOriginal, removeOriginal], 'reselect edit target')
    await clientA.press('Enter')
    await waitFrame(clientA, 'Edit queued message', 'A reopened edit page')
    await replaceEditDraft(clientA, editReplacement, 'saved edit')
    const editBoundary = scene.sessionEvents(sessionId)?.length ?? 0
    await clientA.press('Ctrl+S')
    const edited = await scene.waitForSessionEvent(sessionId, editBoundary,
      event => event.type === 'agent/inbox/spliced' && event.data?.target === 'next-turn'
        && event.data?.removedCount === 1
        && (event.data.inserted ?? []).some((message: Record<string, any>) =>
          message.id === queuedEdit.item.id && messageText(message) === editReplacement),
      'official edit splice kept the exact occurrence identity')
    expect(edited.data?.start, 'edit moved the occurrence to another queue position').toBe(queuedEdit.event.data?.start)
    const editedItem = (edited.data?.inserted ?? [])
      .find((message: Record<string, any>) => message.id === queuedEdit.item.id)
    expect(editedItem?.source, 'edit changed the original Host provenance').toEqual(queuedEdit.item.source)
    expect((scene.sessionEvents(sessionId) ?? []).slice(editBoundary).some(event =>
      event.type === 'agent/inbox/spliced' && event.data?.target === 'next-step'),
    'queue-page Ctrl+S reached the global steer path').toBe(false)
    await waitFrame(clientA, 'Delete [D]', 'saved edit returned to browse')
    await expectQueuedProjection(clientB, [editReplacement], [editOriginal], 'B edited queue projection')

    await selectQueueRow(clientA, removeOriginal, [editReplacement, removeOriginal], 'select remove target')
    await clientA.press('d')
    await waitFrame(clientA, 'Delete queued message', 'A delete confirmation')
    const removeBoundary = scene.sessionEvents(sessionId)?.length ?? 0
    await clientA.press('Enter')
    const removed = await scene.waitForSessionEvent(sessionId, removeBoundary,
      event => event.type === 'agent/inbox/spliced' && event.data?.target === 'next-turn'
        && event.data?.outcome === 'canceled' && event.data?.removedCount === 1
        && (event.data.inserted ?? []).length === 0,
      'official remove splice canceled the exact queued position')
    expect(removed.data?.start, 'remove deleted a different queue position').toBe(queuedRemove.event.data?.start)
    await expectQueuedProjection(clientB, [editReplacement], [removeOriginal], 'B removed queue projection')
    await clientA.press('Esc')
    await waitFrameGone(clientA, 'Delete [D]', 'A queue manager closed')
    await waitForComposerDraft(clientA, '', 'removed occurrence did not restore a draft')

    const beforeRelease = scene.sessionEvents(sessionId) ?? []
    const startsBeforeRelease = beforeRelease.filter(event => event.type === 'turn/start').length
    expect(beforeRelease.some(event => event.type === 'user/message'
      && (event.data?.id === queuedEdit.item.id || event.data?.id === queuedRemove.item.id)),
    'a queued mutation target was claimed before release').toBe(false)
    const releaseBoundary = beforeRelease.length
    releaseHold(host)
    const claimedEdit = await waitForUserMessage(scene, sessionId, releaseBoundary,
      event => event.data?.id === queuedEdit.item.id && userText(event) === editReplacement,
      'edited occurrence claimed once with its replacement text')
    await waitForTurnEnd(scene, sessionId, releaseBoundary,
      claimedTurn(scene.sessionEvents(sessionId) ?? [], claimedEdit, 'edited occurrence claim').turn,
      'edited occurrence Turn end')
    await waitForAnswer(scene, sessionId, releaseBoundary, 'long-turn answer 2', 'edited occurrence answer')
    await waitFrame(clientA, 'long-turn answer 2', 'A painted edited settlement')
    await waitFrame(clientB, 'long-turn answer 2', 'B painted edited settlement')
    const finalEvents = scene.sessionEvents(sessionId) ?? []
    expectOneUser(finalEvents, queuedEdit.item.id, editReplacement, queuedEdit.item.source, 'edited occurrence')
    expect(finalEvents.some(event => event.type === 'user/message' && event.data?.id === queuedRemove.item.id),
      'removed occurrence was claimed').toBe(false)
    expect(finalEvents.some(event => event.type === 'user/message' && userText(event) === editOriginal),
      'original edit text became an independent occurrence').toBe(false)
    expect(finalEvents.some(event => event.type === 'user/message' && userText(event) === cancelledDraft),
      'cancelled edit draft became an independent occurrence').toBe(false)
    expect(finalEvents.filter(event => event.type === 'turn/start').length,
      'removed occurrence started an extra Turn').toBe(startsBeforeRelease + 1)
    expect(finalEvents.slice(removeBoundary).some(event => event.type === 'tool/call' || event.type === 'tool/result'),
      'removed occurrence produced Host tool activity').toBe(false)
    expect(finalEvents.some(event => event.type === 'turn/end' && event.data?.reason?.kind === 'interrupted'),
      'queue remove cancelled the running Agent Turn').toBe(false)

    await exitClient(clientA, 'queue mutation A')
    await exitClient(clientB, 'queue mutation B')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'queue edit/remove/cancel')
  }
})
