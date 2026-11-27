import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'vitest'

import { readOfficialClientRecords } from '../../../support/split-process-client.ts'
import {
  createSplitProcessScene,
  type SplitProcessClient,
  type SplitProcessHostHandle,
  type SplitProcessScene,
  type SessionEvent,
} from '../../../support/split-process-fixture.ts'

type WorkEvent = Record<string, any>

interface PromptEvidence {
  focusSection: boolean
  progressSection: boolean
  userText: string
  userTexts: string[]
  userMessageSources: string[]
}

function rowCarriesCurrentToken(row: PromptEvidence, token: string): boolean {
  for (let index = row.userTexts.length - 1; index >= 0; index -= 1) {
    if (row.userMessageSources[index] !== 'user') continue
    return row.userTexts[index]?.includes(token) ?? false
  }
  return false
}

const fixtureHelpers = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-fixtures.mjs')).href
) as {
  readC1WorkEvents(root: string): WorkEvent[]
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

function composerDraft(frame: string): string | undefined {
  const lines = frame.split('\n')
  const marker = lines.findLastIndex(line => line.includes('❯'))
  if (marker < 0) return undefined
  const at = lines[marker]!.indexOf('❯')
  return lines[marker]!.slice(at + '❯'.length).trim()
}

async function waitForComposerDraft(client: SplitProcessClient, expected: string, label: string): Promise<void> {
  const started = Date.now()
  for (;;) {
    const draft = composerDraft(await client.text())
    if (draft === expected) return
    if (Date.now() - started >= 120_000) {
      throw new Error(`${label}: composer draft was ${JSON.stringify(draft)}, expected ${JSON.stringify(expected)}`)
    }
    await sleep(25)
  }
}

function recordCount(client: SplitProcessClient): number {
  return readOfficialClientRecords(client.recordFile, client.label, { allowIncompleteTail: true }).length
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
    const record = readOfficialClientRecords(client.recordFile, client.label, { allowIncompleteTail: true })
      .slice(afterIndex)
      .filter(candidate => candidate.m4b2s === 'surface-status')
      .find(predicate)
    if (record !== undefined) return record
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: no fresh matching surface-status record within ${String(timeoutMs)}ms`)
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

function rehold(host: SplitProcessHostHandle): void {
  rmSync(holdPath(host), { force: true })
}

function readPromptEvidence(path: string): PromptEvidence[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  const lastBreak = text.endsWith('\n') ? text.length - 1 : text.lastIndexOf('\n')
  const complete = lastBreak < 0 ? '' : text.slice(0, lastBreak)
  if (complete === '') return []
  return complete.split('\n').map((line, index) => {
    try {
      return JSON.parse(line) as PromptEvidence
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`prompt evidence line ${String(index + 1)} is invalid JSON: ${message}`)
    }
  })
}

async function waitForPromptRow(
  path: string,
  afterIndex: number,
  token: string,
  expected: { focusSection: boolean; progressSection: boolean },
  label: string,
  timeoutMs = 120_000,
): Promise<{ row: PromptEvidence; index: number }> {
  const started = Date.now()
  for (;;) {
    const rows = readPromptEvidence(path)
    const matches = rows.slice(afterIndex)
      .map((row, index) => ({ row, index: afterIndex + index }))
      .filter(candidate => rowCarriesCurrentToken(candidate.row, token))
    if (matches.length > 1) throw new Error(`${label}: the unique prompt produced more than one model request`)
    if (matches.length === 1) {
      const match = matches[0]!
      expect(rowCarriesCurrentToken(match.row, token), `${label}: model request did not carry the current unique prompt`).toBe(true)
      expect(match.row.focusSection, `${label}: model-facing Focus policy`).toBe(expected.focusSection)
      expect(match.row.progressSection, `${label}: model-facing progress policy`).toBe(expected.progressSection)
      return match
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: no model request carried ${JSON.stringify(token)} within ${String(timeoutMs)}ms`)
    }
    await sleep(25)
  }
}

async function waitForHeldAfter(
  host: SplitProcessHostHandle,
  sessionId: string,
  afterIndex: number,
  label: string,
): Promise<WorkEvent> {
  expect(host.workloadRoot, 'the Host has no registered workload root').toBeTypeOf('string')
  const started = Date.now()
  for (;;) {
    const event = fixtureHelpers.readC1WorkEvents(host.workloadRoot!).slice(afterIndex)
      .find(candidate => candidate.kind === 'long-turn-held' && candidate.sessionId === sessionId)
    if (event !== undefined) return event
    if (Date.now() - started >= 120_000) throw new Error(`${label}: no fresh held-Turn proof within 120000ms`)
    await sleep(25)
  }
}

async function waitForUserMessage(
  scene: SplitProcessScene,
  sessionId: string,
  afterIndex: number,
  text: string,
  label: string,
): Promise<SessionEvent> {
  return await scene.waitForSessionEvent(sessionId, afterIndex,
    event => event.type === 'user/message' && userText(event) === text, label)
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

async function queueAndSteer(
  scene: SplitProcessScene,
  sessionId: string,
  client: SplitProcessClient,
  text: string,
  label: string,
): Promise<Record<string, any>> {
  const queueBoundary = scene.sessionEvents(sessionId)?.length ?? 0
  await waitForComposerDraft(client, '', `${label}: composer ready for one queue submission`)
  await client.type(text)
  await waitForComposerDraft(client, text, `${label}: exact queued draft`)
  await client.submit()
  await waitFrame(client, text, `${label}: queued prompt painted`)
  const queued = await scene.waitForSessionEvent(sessionId, queueBoundary,
    event => event.type === 'agent/inbox/spliced' && event.data?.target === 'next-turn'
      && (event.data.inserted ?? []).some((message: Record<string, any>) => messageText(message) === text),
    `${label}: exact queued occurrence`)
  const item = (queued.data?.inserted ?? [])
    .find((message: Record<string, any>) => messageText(message) === text)
  expect(item?.id, `${label}: Host occurrence identity`).toBeTypeOf('string')
  expect(item.id, `${label}: empty Host occurrence identity`).not.toBe('')
  const steerBoundary = scene.sessionEvents(sessionId)?.length ?? 0
  await client.press('Ctrl+S')
  await scene.waitForSessionEvent(sessionId, steerBoundary,
    event => event.type === 'agent/inbox/spliced' && event.data?.target === 'next-turn'
      && event.data?.removedCount === 1 && (event.data.inserted ?? []).length === 0,
    `${label}: occurrence removed from next-turn`)
  await scene.waitForSessionEvent(sessionId, steerBoundary,
    event => event.type === 'agent/inbox/spliced' && event.data?.target === 'next-step'
      && (event.data.inserted ?? []).filter((message: Record<string, any>) => message?.id === item.id).length === 1,
    `${label}: exact occurrence steered into next-step`)
  return item
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

test('freezes Focus policy per Turn across Full viewers, mid-Turn exit, Session switch and fresh Peer attach', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'long-turn' })
    expect(host.generation, 'prompt evidence requires one Host generation').toBe(1)
    const evidencePath = join(scene.workDir, 'prompt-evidence.jsonl')
    expect(existsSync(evidencePath), 'the isolated Host has no prompt-evidence sink').toBe(true)
    const hostBefore = await scene.hostStatus(host)

    const clientA = await scene.startClient({ label: 'prompt-a', ...clientDirectories(scene, 'prompt-a') })
    await clientA.submit('/display focus')
    await waitFrame(clientA, 'Display: focus.', 'A applied Focus display')

    const seedToken = 'prompt-policy-a-seed'
    const seedEvidenceBoundary = readPromptEvidence(evidencePath).length
    const seedWorkBoundary = fixtureHelpers.readC1WorkEvents(host.workloadRoot!).length
    const beforeSessions = new Set(await scene.sessionIds())
    await waitForComposerDraft(clientA, '', 'A composer ready for one Focus seed submission')
    await clientA.type(seedToken)
    await waitForComposerDraft(clientA, seedToken, 'A exact Focus seed draft')
    await clientA.submit()
    const sessionX = await scene.waitForNewSessionId(beforeSessions, 'Focus Session X creation')
    await waitForHeldAfter(host, sessionX, seedWorkBoundary, 'first Focus Turn held')
    const seed = await waitForUserMessage(scene, sessionX, 0, seedToken, 'Focus seed user/message')
    const seedClaim = claimedTurn(scene.sessionEvents(sessionX) ?? [], seed, 'Focus seed claim')
    await scene.waitForSessionEvent(sessionX, 0,
      event => event.type === 'turn/start' && event.data?.turn === seedClaim.turn,
      'first Focus turn/start')
    const firstRow = await waitForPromptRow(evidencePath, seedEvidenceBoundary, seedToken,
      { focusSection: true, progressSection: false }, 'A Focus seed request')
    expect(firstRow.index, 'the first model request was not the seed').toBe(seedEvidenceBoundary)

    const clientB = await scene.startClient({ label: 'prompt-b', ...clientDirectories(scene, 'prompt-b'), sessionId: sessionX })
    expect(clientB.ready.openSessionId, 'B attached to another Session').toBe(sessionX)
    expect(clientB.ready.hostPid, 'B attached to another Host').toBe(hostBefore.localHost.hostPid)
    await waitFrame(clientB, seedToken, 'B read X durable history')
    await clientB.submit('/display full')
    await waitFrame(clientB, 'Display: full.', 'B applied Full display')

    const queuedToken = 'prompt-policy-b-queued-step'
    const queuedItem = await queueAndSteer(scene, sessionX, clientB, queuedToken, 'first queued step')
    const stepEventBoundary = scene.sessionEvents(sessionX)?.length ?? 0
    const stepEvidenceBoundary = readPromptEvidence(evidencePath).length
    releaseHold(host)
    const stepRow = await waitForPromptRow(evidencePath, stepEvidenceBoundary, queuedToken,
      { focusSection: true, progressSection: false }, 'steered step kept frozen Focus')
    expect(stepRow.index, 'the steered request was not the next model request').toBe(stepEvidenceBoundary)
    const stepped = await waitForUserMessage(scene, sessionX, stepEventBoundary, queuedToken, 'steered occurrence claimed')
    expect(stepped.data?.id, 'steered claim changed Host occurrence identity').toBe(queuedItem.id)
    const stepClaim = claimedTurn(scene.sessionEvents(sessionX) ?? [], stepped, 'steered step claim')
    expect(stepClaim.turn, 'steered occurrence moved to another Turn').toBe(seedClaim.turn)
    await waitForTurnEnd(scene, sessionX, stepEventBoundary, stepClaim.turn, 'first frozen Focus Turn end')
    rehold(host)

    const secondToken = 'prompt-policy-b-with-a-focus'
    const secondEventBoundary = scene.sessionEvents(sessionX)?.length ?? 0
    const secondEvidenceBoundary = readPromptEvidence(evidencePath).length
    const secondWorkBoundary = fixtureHelpers.readC1WorkEvents(host.workloadRoot!).length
    await clientB.submit(secondToken)
    const second = await waitForUserMessage(scene, sessionX, secondEventBoundary, secondToken, 'B-submitted Turn user/message')
    const secondClaim = claimedTurn(scene.sessionEvents(sessionX) ?? [], second, 'B-submitted Turn claim')
    expect(secondClaim.startIndex, 'B-submitted occurrence has no new authoritative turn/start').toBeGreaterThan(seedClaim.startIndex)
    await waitForHeldAfter(host, sessionX, secondWorkBoundary, 'B-submitted Turn held before A exit')
    const secondRow = await waitForPromptRow(evidencePath, secondEvidenceBoundary, secondToken,
      { focusSection: true, progressSection: false }, 'B Full submit with A Focus viewer')
    expect(secondRow.index, 'the B-submitted request was not the next model request').toBe(secondEvidenceBoundary)

    await exitClient(clientA, 'Focus viewer A mid-Turn')
    await expectHostIdentity(scene, host, 'Host after Focus viewer exit')
    expect(clientB.closed, 'B exited with the Focus viewer').toBe(false)
    const postExitToken = 'prompt-policy-b-after-a-exit-step'
    await queueAndSteer(scene, sessionX, clientB, postExitToken, 'post-exit queued step')
    const frozenEventBoundary = scene.sessionEvents(sessionX)?.length ?? 0
    const frozenEvidenceBoundary = readPromptEvidence(evidencePath).length
    releaseHold(host)
    const frozenRow = await waitForPromptRow(evidencePath, frozenEvidenceBoundary, postExitToken,
      { focusSection: true, progressSection: false }, 'open Turn kept Focus after viewer exit')
    expect(frozenRow.index, 'the post-exit step was not the next model request').toBe(frozenEvidenceBoundary)
    const frozenClaim = await waitForUserMessage(scene, sessionX, frozenEventBoundary, postExitToken, 'post-exit step claimed')
    const frozenTurn = claimedTurn(scene.sessionEvents(sessionX) ?? [], frozenClaim, 'post-exit step claim')
    expect(frozenTurn.turn, 'post-exit step moved to another Turn').toBe(secondClaim.turn)
    await waitForTurnEnd(scene, sessionX, frozenEventBoundary, frozenTurn.turn, 'post-exit frozen Turn end')

    const nextToken = 'prompt-policy-b-next-turn'
    const nextEventBoundary = scene.sessionEvents(sessionX)?.length ?? 0
    const nextEvidenceBoundary = readPromptEvidence(evidencePath).length
    await clientB.submit(nextToken)
    const next = await waitForUserMessage(scene, sessionX, nextEventBoundary, nextToken, 'B-only next Turn user/message')
    const nextClaim = claimedTurn(scene.sessionEvents(sessionX) ?? [], next, 'B-only next Turn claim')
    expect(nextClaim.startIndex, 'B-only next Turn has no new authoritative turn/start').toBeGreaterThan(secondClaim.startIndex)
    const nextRow = await waitForPromptRow(evidencePath, nextEvidenceBoundary, nextToken,
      { focusSection: false, progressSection: true }, 'next Turn dropped Focus after viewer exit')
    expect(nextRow.index, 'the next-Turn request was not the next model request').toBe(nextEvidenceBoundary)
    await waitForTurnEnd(scene, sessionX, nextEventBoundary, nextClaim.turn, 'B-only next Turn end')

    const switchBoundary = recordCount(clientB)
    await clientB.submit('/new')
    const switched = await waitForSurfaceStatusAfter(clientB, switchBoundary,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string'
        && record.openSessionId !== sessionX && record.transport === 'connected' && record.surfaceMounted === true,
      'B switched to Full-only Session S2')
    const sessionS2 = String(switched.openSessionId)
    const s2Token = 'prompt-policy-s2-full-turn'
    const s2Boundary = readPromptEvidence(evidencePath).length
    await clientB.submit(s2Token)
    const s2Message = await waitForUserMessage(scene, sessionS2, 0, s2Token, 'S2 Full-only user/message')
    const s2Row = await waitForPromptRow(evidencePath, s2Boundary, s2Token,
      { focusSection: false, progressSection: true }, 'S2 Full-only request')
    expect(s2Row.index, 'the S2 request was not the next model request').toBe(s2Boundary)
    await waitForTurnEnd(scene, sessionS2, 0,
      claimedTurn(scene.sessionEvents(sessionS2) ?? [], s2Message, 'S2 Full-only claim').turn,
      'S2 Full-only Turn end')

    await exitClient(clientB, 'Full viewer B')
    await expectHostIdentity(scene, host, 'Host after Full viewer exit')
    const clientC = await scene.startClient({ label: 'prompt-c', ...clientDirectories(scene, 'prompt-c'), sessionId: sessionX })
    expect(clientC.ready.openSessionId, 'fresh Peer reopened another Session').toBe(sessionX)
    expect(clientC.ready.hostPid, 'fresh Peer attached to another Host').toBe(hostBefore.localHost.hostPid)
    expect(clientC.ready.businessPid, 'fresh Peer reused a retired business PID').not.toBe(clientB.ready.businessPid)
    await waitFrame(clientC, seedToken, 'fresh Peer read X history')
    await clientC.submit('/display focus')
    await waitFrame(clientC, 'Display: focus.', 'fresh Peer applied Focus display')

    const peerToken = 'prompt-policy-c-focus-turn'
    const peerEventBoundary = scene.sessionEvents(sessionX)?.length ?? 0
    const peerEvidenceBoundary = readPromptEvidence(evidencePath).length
    await clientC.submit(peerToken)
    const peerMessage = await waitForUserMessage(scene, sessionX, peerEventBoundary, peerToken, 'fresh Peer user/message')
    const peerClaim = claimedTurn(scene.sessionEvents(sessionX) ?? [], peerMessage, 'fresh Peer claim')
    expect(peerClaim.startIndex, 'fresh Peer Turn has no new authoritative turn/start').toBeGreaterThan(nextClaim.startIndex)
    const peerRow = await waitForPromptRow(evidencePath, peerEvidenceBoundary, peerToken,
      { focusSection: true, progressSection: false }, 'fresh Peer Focus request')
    expect(peerRow.index, 'the fresh-Peer request was not the next model request').toBe(peerEvidenceBoundary)
    await waitForTurnEnd(scene, sessionX, peerEventBoundary, peerClaim.turn, 'fresh Peer Focus Turn end')
    await expectHostIdentity(scene, host, 'Host after fresh Peer Turn')

    const tokens = [seedToken, queuedToken, secondToken, postExitToken, nextToken, s2Token, peerToken]
    const rows = readPromptEvidence(evidencePath)
    expect(rows, 'the chain produced an unexpected number of model requests').toHaveLength(tokens.length)
    for (const [index, token] of tokens.entries()) {
      expect(rowCarriesCurrentToken(rows[index]!, token), `model request ${String(index + 1)} lost its unique prompt`).toBe(true)
      expect(rows.filter(row => rowCarriesCurrentToken(row, token)), `${token}: duplicate model request`).toHaveLength(1)
    }

    await exitClient(clientC, 'fresh Peer C')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'prompt Focus/Full chain')
  }
})
