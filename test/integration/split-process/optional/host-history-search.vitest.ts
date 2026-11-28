/**
 * Split-process optional anchor: Host accepted-input history search, exact
 * text chunking, cursor staleness, directory/session/fork scopes, Ctrl+R UI
 * restore, cold index rebuild, Up-arrow recall across Sessions, and live queue
 * edit/remove/steer stability.
 *
 * Runs only under the `split-process-optional` Vitest project. One Scene with
 * two sequential Host generations (`history-search` -> `history-queue`) sharing
 * the same installed profile and durable Session store.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type ProcessReadAuthorityRequest,
  type SessionEvent,
  type SplitProcessClient,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

type WorkEvent = Record<string, any>

const { waitForC1WorkEvent } = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-fixtures.mjs')).href
) as {
  waitForC1WorkEvent(
    root: string,
    predicate: (event: WorkEvent) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<WorkEvent>
}

type HistoryRecord = Record<string, any>
type HistorySearchItem = {
  sessionId: string
  messageId: string
  firstEventSeq: number
  acceptedAt: number
  effectiveCwd: string | null
  preview: string
  contentLength: number
  contentSha256: string
  hasNonText: boolean
}

function splitFrame(frame: string): { composer: string; below: string } {
  const lines = frame.split('\n')
  const ruleIndices: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^─{10,}$/u.test(lines[index]!.trim())) ruleIndices.push(index)
  }
  if (ruleIndices.length < 2) return { composer: '', below: '' }
  const top = ruleIndices.at(-2)!
  const bottom = ruleIndices.at(-1)!
  return {
    composer: lines.slice(top + 1, bottom).join('\n'),
    below: lines.slice(bottom + 1).join('\n'),
  }
}

function composerDraftOf(frame: string): string | undefined {
  const row = frame.split('\n').filter(line => line.trimStart().startsWith('❯')).at(-1)
  if (row === undefined) return undefined
  const at = row.indexOf('❯')
  const raw = row.slice(at + '❯'.length).trim()
  return /^[…·]+$/u.test(raw) ? '' : raw
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

function textOfMessage(value: unknown): string {
  if (value === null || typeof value !== 'object') return ''
  const content = (value as Record<string, any>).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part: Record<string, any>) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: Record<string, any>) => String(part.text))
    .join('\n')
}

function isAcceptedUserMessage(message: unknown): message is { id: string; content: unknown[]; source: { kind: 'user' } } {
  if (message === null || typeof message !== 'object') return false
  const record = message as Record<string, any>
  return typeof record.id === 'string' && record.id !== '' && record.source?.kind === 'user'
}

interface AcceptedOccurrence {
  messageId: string
  text: string
  firstEventSeq: number
  acceptedAt: number
}

function acceptedOccurrencesOf(events: readonly SessionEvent[]): AcceptedOccurrence[] {
  const seen = new Set<string>()
  const out: AcceptedOccurrence[] = []
  for (const event of events) {
    const data = event.data as Record<string, any> | undefined
    const messages = event.type === 'agent/inbox/spliced' && Array.isArray(data?.inserted)
      ? data.inserted
      : event.type === 'user/message'
        ? [data]
        : []
    for (const message of messages) {
      if (!isAcceptedUserMessage(message) || seen.has(message.id)) continue
      seen.add(message.id)
      out.push({
        messageId: message.id,
        text: textOfMessage(message),
        firstEventSeq: Number(event.seq),
        acceptedAt: Number(event.time),
      })
    }
  }
  return out
}

async function waitForAcceptedOccurrence(
  scene: SplitProcessScene,
  sessionId: string,
  text: string,
  knownIds: ReadonlySet<string>,
  label: string,
  timeoutMs = 120_000,
): Promise<AcceptedOccurrence> {
  const started = Date.now()
  for (;;) {
    const found = acceptedOccurrencesOf(scene.sessionEvents(sessionId) ?? [])
      .find(item => item.text === text && !knownIds.has(item.messageId))
    if (found !== undefined) return found
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: no new durable accepted occurrence for ${JSON.stringify(text)} in ${sessionId}`)
    }
    await sleep(50)
  }
}

async function waitForConsumedTurn(
  scene: SplitProcessScene,
  sessionId: string,
  messageId: string,
  label: string,
): Promise<void> {
  const userEvent = await scene.waitForSessionEvent(
    sessionId,
    0,
    event => event.type === 'user/message' && (event.data as Record<string, any>)?.id === messageId,
    `${label}: consumed user/message ${messageId}`,
  )
  const events = scene.sessionEvents(sessionId) ?? []
  const userIndex = events.findIndex(event => event.seq === userEvent.seq)
  const priorTurnStart = events
    .slice(0, userIndex + 1)
    .findLast(event => event.type === 'turn/start' && typeof (event.data as Record<string, any>)?.turn === 'number')
  const turnStart = priorTurnStart ?? await scene.waitForSessionEvent(
    sessionId,
    userIndex + 1,
    event => event.type === 'turn/start' && typeof (event.data as Record<string, any>)?.turn === 'number',
    `${label}: turn/start`,
  )
  const turn = (turnStart.data as Record<string, any>).turn as number
  const startIndex = (scene.sessionEvents(sessionId) ?? []).findIndex(event => event.seq === turnStart.seq)
  await scene.waitForSessionEvent(
    sessionId,
    startIndex + 1,
    event => event.type === 'assistant/message' && (event.data as Record<string, any>)?.turn === turn,
    `${label}: assistant/message`,
  )
  await scene.waitForSessionEvent(
    sessionId,
    startIndex + 1,
    event => event.type === 'turn/end'
      && (event.data as Record<string, any>)?.turn === turn
      && (event.data as Record<string, any>)?.reason?.kind === 'completed',
    `${label}: turn/end completed`,
  )
}

async function submitPromptAndWait(
  scene: SplitProcessScene,
  client: SplitProcessClient,
  sessionId: string,
  text: string,
  label: string,
): Promise<AcceptedOccurrence> {
  const knownIds = new Set(acceptedOccurrencesOf(scene.sessionEvents(sessionId) ?? []).map(item => item.messageId))
  await waitForFrame(client, frame => composerDraftOf(frame) === '', `${label}: empty composer`)
  await client.type(text)
  await waitForFrame(client, frame => splitFrame(frame).composer.includes(text), `${label}: typed draft`)
  await client.press('Enter')
  const occurrence = await waitForAcceptedOccurrence(scene, sessionId, text, knownIds, label)
  await waitForConsumedTurn(scene, sessionId, occurrence.messageId, label)
  return occurrence
}

async function historyProbe(
  client: SplitProcessClient,
  request: Extract<ProcessReadAuthorityRequest, { op: 'history-search' | 'history-read-text' | 'history-session-recall' }>,
  label: string,
  timeoutMs = 120_000,
): Promise<HistoryRecord> {
  const dispatched = await client.readAuthority(request)
  expect(dispatched.op, `${label}: unexpected read-authority op`).toBe(request.op)
  const record = await client.waitForRecord(
    candidate => candidate.m4b2s === 'qualification'
      && candidate.op === 'history-search-proof'
      && candidate.nonce === dispatched.nonce
      && (candidate.phase === 'result' || candidate.phase === 'failed'),
    `${label}: history-search-proof terminal`,
    timeoutMs,
  )
  expect(record.phase, `${label}: history read failed: ${JSON.stringify(record)}`).toBe('result')
  return record.answer as HistoryRecord
}

async function historySearchReady(
  client: SplitProcessClient,
  request: Extract<ProcessReadAuthorityRequest, { op: 'history-search' }>,
  label: string,
  timeoutMs = 120_000,
): Promise<{ kind: 'ready'; generation: string; items: HistorySearchItem[]; nextCursor: string | null }> {
  const started = Date.now()
  for (;;) {
    const answer = await historyProbe(client, request, label, timeoutMs)
    if (answer.kind === 'ready') {
      return answer as { kind: 'ready'; generation: string; items: HistorySearchItem[]; nextCursor: string | null }
    }
    expect(
      answer.kind === 'loading' || answer.kind === 'partial' || answer.kind === 'incomplete',
      `${label}: unexpected search state ${JSON.stringify(answer)}`,
    ).toBe(true)
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: search never became ready: ${JSON.stringify(answer)}`)
    }
    await sleep(50)
  }
}

async function waitForIndexedMessage(
  client: SplitProcessClient,
  request: Extract<ProcessReadAuthorityRequest, { op: 'history-search' }>,
  messageId: string,
  label: string,
  timeoutMs = 120_000,
): Promise<{ kind: 'ready'; generation: string; items: HistorySearchItem[]; nextCursor: string | null }> {
  const started = Date.now()
  for (;;) {
    const answer = await historySearchReady(client, request, label, timeoutMs)
    if (answer.items.some(item => item.messageId === messageId)) return answer
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: message ${messageId} never appeared in ready index: ${JSON.stringify(answer)}`)
    }
    await sleep(50)
  }
}

async function historyRecallReady(
  client: SplitProcessClient,
  sessionId: string,
  label: string,
  timeoutMs = 120_000,
): Promise<{ kind: 'ready'; items: Array<{ messageId: string; firstEventSeq: number; text: string }> }> {
  const started = Date.now()
  for (;;) {
    const answer = await historyProbe(client, { op: 'history-session-recall', sessionId }, label, timeoutMs)
    if (answer.kind === 'ready') {
      return answer as { kind: 'ready'; items: Array<{ messageId: string; firstEventSeq: number; text: string }> }
    }
    expect(
      answer.kind === 'loading' || answer.kind === 'incomplete',
      `${label}: unexpected recall state ${JSON.stringify(answer)}`,
    ).toBe(true)
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: session recall never became ready: ${JSON.stringify(answer)}`)
    }
    await sleep(50)
  }
}

async function readFullTextChunks(
  client: SplitProcessClient,
  item: Pick<HistorySearchItem, 'sessionId' | 'messageId' | 'contentSha256' | 'contentLength'>,
  label: string,
): Promise<{ text: string; chunks: number }> {
  let offset = 0
  let chunks = 0
  let text = ''
  for (let step = 0; step < 256; step += 1) {
    const answer = await historyProbe(
      client,
      {
        op: 'history-read-text',
        sessionId: item.sessionId,
        messageId: item.messageId,
        contentSha256: item.contentSha256,
        offset,
      },
      `${label} chunk ${String(step)}`,
    )
    expect(answer.kind, `${label}: readText returned ${JSON.stringify(answer)}`).toBe('ready')
    expect(answer.contentLength).toBe(item.contentLength)
    text += String(answer.chunk)
    chunks += 1
    if (answer.nextOffset === null) break
    expect(answer.nextOffset).toBeGreaterThan(offset)
    offset = Number(answer.nextOffset)
  }
  expect(text.length).toBe(item.contentLength)
  expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(item.contentSha256)
  return { text, chunks }
}

function readExtraProof(proofPath: string): HistoryRecord[] {
  if (!existsSync(proofPath)) return []
  return readFileSync(proofPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

async function waitForExtraProof(
  proofPath: string,
  predicate: (event: HistoryRecord) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<HistoryRecord> {
  const started = Date.now()
  for (;;) {
    const found = readExtraProof(proofPath).find(predicate)
    if (found !== undefined) return found
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: no matching extra proof event within ${String(timeoutMs)}ms`)
    }
    await sleep(50)
  }
}

function visibleRecallProjection(textsOldestFirst: readonly string[]): string[] {
  const out: string[] = []
  for (let index = textsOldestFirst.length - 1; index >= 0; index -= 1) {
    if (out.length > 0 && out[out.length - 1] === textsOldestFirst[index]) continue
    out.push(textsOldestFirst[index]!)
    if (out.length >= 100) break
  }
  return out
}

async function assertRecallBrowse(
  client: SplitProcessClient,
  expectedNewestFirst: readonly string[],
  label: string,
): Promise<void> {
  expect(expectedNewestFirst.length).toBeGreaterThan(0)
  const started = Date.now()
  for (;;) {
    const draft = composerDraftOf(await client.text())
    if (draft === expectedNewestFirst[0]) break
    expect(draft === undefined || draft === '', `${label}: first Up yielded ${JSON.stringify(draft)}`).toBe(true)
    if (Date.now() - started >= 60_000) {
      throw new Error(`${label}: first Up never recalled ${JSON.stringify(expectedNewestFirst[0])}`)
    }
    await client.press('Up')
    await sleep(60)
  }
  for (let index = 1; index < expectedNewestFirst.length; index += 1) {
    await client.press('Up')
    await waitForFrame(
      client,
      frame => composerDraftOf(frame) === expectedNewestFirst[index],
      `${label}: Up position ${String(index)}`,
      15_000,
    )
  }
  // Clear recall back to empty draft via Down
  for (let step = 0; step < expectedNewestFirst.length + 5; step += 1) {
    if ((composerDraftOf(await client.text()) ?? '') === '') break
    await client.press('Down')
    await sleep(50)
  }
  await waitForFrame(client, frame => (composerDraftOf(frame) ?? '') === '', `${label}: cleared recall draft`, 15_000)
}

async function disposeScene(scene: SplitProcessScene, primary: unknown): Promise<void> {
  try {
    await scene.dispose()
  } catch (cleanupError) {
    if (primary !== undefined) {
      throw new AggregateError([primary, cleanupError], 'host-history-search failed and Scene cleanup also failed')
    }
    throw cleanupError
  }
}

test('keeps accepted input identities through peer search, recall, queue changes and a cold rebuild', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const dirFirst = join(scene.workDir, 'history-cwd-first')
    const dirSecond = join(scene.workDir, 'history-cwd-second')
    const dirOther = join(scene.workDir, 'history-cwd-other')
    const clientAHome = join(scene.workDir, 'history-client-a-home')
    const clientBHome = join(scene.workDir, 'history-client-b-home')
    const freshClientHome = join(scene.workDir, 'history-fresh-client-home')
    for (const dir of [dirFirst, dirSecond, dirOther, clientAHome, clientBHome, freshClientHome]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const canonicalFirst = realpathSync(dirFirst)
    const canonicalSecond = realpathSync(dirSecond)
    const canonicalOther = realpathSync(dirOther)

    // ── A. First Host generation: live cross-client / currentness ───────────
    const host1 = await scene.startHost({ scenario: 'history-search' })
    expect(host1.workloadRoot).toBeTypeOf('string')
    const extraProof1 = join(host1.workloadRoot!, 'history-events.jsonl')
    const host1Pid = host1.ready.localHost?.hostPid
    const host1InstanceId = host1.ready.localHost?.instanceId
    await waitForExtraProof(extraProof1, event => event.kind === 'plugin-loaded', 'gen1 extra fixture loaded')

    const clientA = await scene.startClient({
      label: 'history-client-a',
      cwd: dirFirst,
      home: clientAHome,
    })
    const clientB = await scene.startClient({
      label: 'history-client-b',
      cwd: dirOther,
      home: clientBHome,
      readAuthorityProof: true,
    })
    expect(clientA.ready.businessPid).not.toBe(clientB.ready.businessPid)
    await waitForConfirmedDirectory(clientA, canonicalFirst, 'client A confirmed first directory')
    await waitForConfirmedDirectory(clientB, canonicalOther, 'client B confirmed other directory')

    // Bounded IPC negative control: raw `cwd` field and unknown op are refused before dispatch
    const recordsBeforeInvalid = clientB.readRecords().length
    await expect(scene.request('PROCESS_CLIENT_READ_AUTHORITY', {
      clientId: clientB.clientId,
      request: { op: 'history-search', scope: 'directory', target: 'first', cwd: canonicalFirst, query: '', limit: 25 },
    })).rejects.toThrow(/INPUT_UNQUALIFIED/u)
    await expect(scene.request('PROCESS_CLIENT_READ_AUTHORITY', {
      clientId: clientB.clientId,
      request: { op: 'read' },
    })).rejects.toThrow(/INPUT_UNQUALIFIED/u)
    expect(clientB.readRecords().length).toBe(recordsBeforeInvalid)

    // A1. Sessionless prompt -> cross-client exact identity, readText chunks, wrong-hash refusal, recall
    const uniqueText = 'history-accepted-unique-prompt-spanning-multiple-chunks'
    const uniqueSha256 = createHash('sha256').update(uniqueText, 'utf8').digest('hex')
    const sessionsBeforeA = new Set(await scene.sessionIds())
    await clientA.type(uniqueText)
    await waitForFrame(clientA, frame => splitFrame(frame).composer.includes(uniqueText), 'client A unique draft')
    await clientA.press('Enter')

    const sessionA = await scene.waitForNewSessionId(sessionsBeforeA, 'client A first Session')
    await clientA.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionA,
      'client A mounted Session A',
    )
    const occ1 = await waitForAcceptedOccurrence(scene, sessionA, uniqueText, new Set(), 'first accepted occurrence')
    await waitForConsumedTurn(scene, sessionA, occ1.messageId, 'first accepted turn')

    const search1 = await waitForIndexedMessage(
      clientB,
      { op: 'history-search', scope: 'all', query: uniqueText, limit: 25 },
      occ1.messageId,
      'peer search first occurrence',
    )
    expect(search1.items).toHaveLength(1)
    const item1 = search1.items[0]!
    expect(item1.sessionId).toBe(sessionA)
    expect(item1.messageId).toBe(occ1.messageId)
    expect(item1.firstEventSeq).toBe(occ1.firstEventSeq)
    expect(item1.acceptedAt).toBe(occ1.acceptedAt)
    expect(realpathSync(String(item1.effectiveCwd))).toBe(canonicalFirst)
    expect(item1.contentLength).toBe(uniqueText.length)
    expect(item1.contentSha256).toBe(uniqueSha256)

    const read1 = await readFullTextChunks(clientB, item1, 'readText multi-chunk')
    expect(read1.text).toBe(uniqueText)
    expect(read1.chunks).toBeGreaterThan(1)

    const wrongHash = uniqueSha256.startsWith('0') ? `1${uniqueSha256.slice(1)}` : `0${uniqueSha256.slice(1)}`
    const wrongHashAnswer = await historyProbe(
      clientB,
      {
        op: 'history-read-text',
        sessionId: sessionA,
        messageId: occ1.messageId,
        contentSha256: wrongHash,
        offset: 0,
      },
      'wrong-hash readText refusal',
    )
    expect(wrongHashAnswer.kind).toBe('unavailable')
    expect(wrongHashAnswer.reason).toBe('stale-content')

    const recall1 = await historyRecallReady(clientB, sessionA, 'initial session recall')
    expect(recall1.items).toHaveLength(1)
    expect(recall1.items[0]!.messageId).toBe(occ1.messageId)
    expect(recall1.items[0]!.firstEventSeq).toBe(occ1.firstEventSeq)
    expect(recall1.items[0]!.text).toBe(uniqueText)

    // A2. Same-text second occurrence, pagination limit=1, cursor staleness, directory/session scopes
    const occ2 = await submitPromptAndWait(scene, clientA, sessionA, uniqueText, 'second identical occurrence')
    expect(occ2.messageId).not.toBe(occ1.messageId)
    const search2 = await waitForIndexedMessage(
      clientB,
      { op: 'history-search', scope: 'all', query: uniqueText, limit: 25 },
      occ2.messageId,
      'peer search two identical occurrences',
    )
    expect(search2.items.map(i => i.messageId).sort()).toEqual([occ1.messageId, occ2.messageId].sort())

    const page1 = await historySearchReady(
      clientB,
      { op: 'history-search', scope: 'all', query: uniqueText, limit: 1 },
      'page 1 limit=1',
    )
    expect(page1.items).toHaveLength(1)
    expect(typeof page1.nextCursor === 'string' && page1.nextCursor.length > 0).toBe(true)
    const page2 = await historySearchReady(
      clientB,
      { op: 'history-search', scope: 'all', query: uniqueText, limit: 1, cursor: page1.nextCursor! },
      'page 2 limit=1',
    )
    expect(page2.items).toHaveLength(1)
    expect(page2.items[0]!.messageId).not.toBe(page1.items[0]!.messageId)
    expect(page2.nextCursor).toBeNull()

    const cursorMutationText = 'history-cursor-mutation-marker'
    const occMutation = await submitPromptAndWait(scene, clientA, sessionA, cursorMutationText, 'cursor mutation prompt')
    await waitForIndexedMessage(
      clientB,
      { op: 'history-search', scope: 'all', query: cursorMutationText, limit: 25 },
      occMutation.messageId,
      'indexed cursor mutation',
    )
    const staleCursorAnswer = await historyProbe(
      clientB,
      { op: 'history-search', scope: 'all', query: uniqueText, limit: 1, cursor: page1.nextCursor! },
      'stale cursor refusal',
    )
    expect(staleCursorAnswer).toEqual({ kind: 'stale', reason: 'cursor-stale' })

    const sessionScope = await historySearchReady(
      clientB,
      { op: 'history-search', scope: 'session', sessionId: sessionA, query: uniqueText, limit: 25 },
      'session scope search',
    )
    expect(sessionScope.items.map(i => i.messageId).sort()).toEqual([occ1.messageId, occ2.messageId].sort())
    const firstDirScope = await historySearchReady(
      clientB,
      { op: 'history-search', scope: 'directory', target: 'first', query: uniqueText, limit: 25 },
      'first directory scope search',
    )
    expect(firstDirScope.items.map(i => i.messageId).sort()).toEqual([occ1.messageId, occ2.messageId].sort())
    const otherDirScope = await historySearchReady(
      clientB,
      { op: 'history-search', scope: 'directory', target: 'other', query: uniqueText, limit: 25 },
      'other directory scope search',
    )
    expect(otherDirScope.items).toHaveLength(0)

    // A3. Client B `/resume sessionA` + real Ctrl+R Restore (Enter #1 restores only, Enter #2 submits)
    await clientB.type(`/resume ${sessionA}`)
    await waitForFrame(clientB, frame => splitFrame(frame).composer.includes(`/resume ${sessionA}`), 'client B /resume draft')
    await clientB.press('Enter')
    await clientB.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionA,
      'client B resumed Session A',
    )
    await waitForFrame(clientB, frame => (composerDraftOf(frame) ?? '') === '', 'client B empty composer after resume')

    const acceptedIdsBeforeCtrlR = new Set(acceptedOccurrencesOf(scene.sessionEvents(sessionA) ?? []).map(o => o.messageId))
    await clientB.press('Ctrl+R')
    await waitForFrame(clientB, frame => frame.includes('Input History'), 'Ctrl+R Input History open')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const frame = await clientB.text()
      const headerRow = frame.split('\n').find(line => line.includes('Input History'))
      if (headerRow?.includes('[All Directories]')) break
      await clientB.press('Tab')
      await sleep(120)
    }
    await waitForFrame(
      clientB,
      frame => frame.split('\n').some(line => line.includes('Input History') && line.includes('[All Directories]')),
      'Ctrl+R active All Directories scope',
      15_000,
    )
    await clientB.type(uniqueText)
    let prevCtrlRFrame = ''
    await waitForFrame(clientB, frame => {
      const lines = frame.split('\n')
      const selected = lines.some(line => /^\s*>\s/u.test(line) && line.includes(uniqueText))
      const bodyReady = lines.some(line => line.includes('Copy All [Alt+C]'))
      const useReady = lines.some(line => line.includes('Use Selected [Enter]'))
      const results = lines.some(line => line.includes('Results ·'))
      const stable = selected && bodyReady && useReady && results && frame === prevCtrlRFrame
      prevCtrlRFrame = frame
      return stable
    }, 'Ctrl+R stable selected result', 60_000)

    // Enter #1 restores only — no new durable occurrence
    await clientB.press('Enter')
    await waitForFrame(clientB, frame => !frame.includes('Input History'), 'Ctrl+R closed after Restore Enter', 15_000)
    await waitForFrame(clientB, frame => composerDraftOf(frame) === uniqueText, 'Ctrl+R restored exact draft', 15_000)
    expect(acceptedOccurrencesOf(scene.sessionEvents(sessionA) ?? []).map(o => o.messageId).sort())
      .toEqual([...acceptedIdsBeforeCtrlR].sort())

    // Enter #2 submits a new distinct occurrence
    await clientB.press('Enter')
    const occ3 = await waitForAcceptedOccurrence(scene, sessionA, uniqueText, acceptedIdsBeforeCtrlR, 'Ctrl+R second Enter submission')
    await waitForConsumedTurn(scene, sessionA, occ3.messageId, 'Ctrl+R submitted turn')
    const search3 = await waitForIndexedMessage(
      clientB,
      { op: 'history-search', scope: 'all', query: uniqueText, limit: 25 },
      occ3.messageId,
      'Ctrl+R occurrence indexed',
    )
    expect(search3.items.map(i => i.messageId).sort()).toEqual([occ1.messageId, occ2.messageId, occ3.messageId].sort())

    // A4. Event-time cwd switch + `/fork` isolation
    const occSwitch = await submitPromptAndWait(scene, clientA, sessionA, 'hsp-cwd-switch', 'cwd switch prompt')
    const cwdSetProof = await waitForExtraProof(
      extraProof1,
      event => event.kind === 'cwd-set' && event.sessionId === sessionA,
      'extra fixture cwd-set',
    )
    expect(realpathSync(String(cwdSetProof.cwd))).toBe(canonicalSecond)
    await scene.waitForSessionEvent(
      sessionA,
      0,
      event => event.type === 'working-directory/change',
      'durable working-directory/change event',
    )

    const occAfterSwitch = await submitPromptAndWait(scene, clientA, sessionA, 'hsp-cwd-two', 'post-cwd-switch prompt')
    await waitForIndexedMessage(
      clientB,
      { op: 'history-search', scope: 'directory', target: 'second', query: 'hsp-cwd-two', limit: 25 },
      occAfterSwitch.messageId,
      'second-directory occurrence indexed',
    )
    const switchInFirst = await historySearchReady(
      clientB,
      { op: 'history-search', scope: 'directory', target: 'first', query: 'hsp-cwd-switch', limit: 25 },
      'switch marker stays in first directory',
    )
    expect(switchInFirst.items.map(i => i.messageId)).toEqual([occSwitch.messageId])
    const postSwitchInFirst = await historySearchReady(
      clientB,
      { op: 'history-search', scope: 'directory', target: 'first', query: 'hsp-cwd-two', limit: 25 },
      'post-switch absent from first directory',
    )
    expect(postSwitchInFirst.items).toHaveLength(0)
    const postSwitchInOther = await historySearchReady(
      clientB,
      { op: 'history-search', scope: 'directory', target: 'other', query: 'hsp-cwd-two', limit: 25 },
      'post-switch absent from other directory',
    )
    expect(postSwitchInOther.items).toHaveLength(0)

    // Fork child F from Session A
    const sessionsBeforeFork = new Set(await scene.sessionIds())
    await waitForFrame(clientA, frame => (composerDraftOf(frame) ?? '') === '', 'client A empty before /fork')
    await clientA.type('/fork')
    await waitForFrame(clientA, frame => splitFrame(frame).composer.includes('/fork'), 'client A /fork draft')
    await clientA.press('Enter')
    const sessionFork = await scene.waitForNewSessionId(sessionsBeforeFork, 'fork child Session')
    await clientA.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionFork,
      'client A mounted fork child',
    )
    const forkOwnText = 'history-fork-own-input'
    const occFork = await submitPromptAndWait(scene, clientA, sessionFork, forkOwnText, 'fork child own prompt')
    await waitForIndexedMessage(
      clientB,
      { op: 'history-search', scope: 'session', sessionId: sessionFork, query: forkOwnText, limit: 25 },
      occFork.messageId,
      'fork child occurrence indexed',
    )
    const forkParentSearch = await historySearchReady(
      clientB,
      { op: 'history-search', scope: 'session', sessionId: sessionFork, query: uniqueText, limit: 25 },
      'fork child excludes parent inherited prompt',
    )
    expect(forkParentSearch.items).toHaveLength(0)
    const forkRecall = await historyRecallReady(clientB, sessionFork, 'fork child recall')
    expect(forkRecall.items.map(i => i.messageId)).toEqual([occFork.messageId])

    // A5. Prepare non-adjacent duplicate recall Session S_B on Client B
    const sessionsBeforeNewB = new Set(await scene.sessionIds())
    await waitForFrame(clientB, frame => (composerDraftOf(frame) ?? '') === '', 'client B empty before /new')
    await clientB.type('/new')
    await waitForFrame(clientB, frame => splitFrame(frame).composer.includes('/new'), 'client B /new draft')
    await clientB.press('Enter')
    const sessionB = await scene.waitForNewSessionId(sessionsBeforeNewB, 'client B new Session S_B')
    await clientB.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionB,
      'client B mounted Session S_B',
    )
    const occB1 = await submitPromptAndWait(scene, clientB, sessionB, 'history-peer-one', 'S_B peer-one #1')
    const occB2 = await submitPromptAndWait(scene, clientB, sessionB, 'history-peer-two', 'S_B peer-two')
    const occB3 = await submitPromptAndWait(scene, clientB, sessionB, 'history-peer-one', 'S_B peer-one #2')
    await waitForIndexedMessage(
      clientB,
      { op: 'history-search', scope: 'session', sessionId: sessionB, query: 'history-peer-one', limit: 25 },
      occB3.messageId,
      'S_B peer-one indexed',
    )

    // Snapshot semantic expectations for A, B, and Fork before stopping Host 1
    const baselineA = await historySearchReady(
      clientB,
      { op: 'history-search', scope: 'session', sessionId: sessionA, query: '', limit: 25 },
      'baseline Session A rows',
    )
    const baselineB = await historySearchReady(
      clientB,
      { op: 'history-search', scope: 'session', sessionId: sessionB, query: '', limit: 25 },
      'baseline Session B rows',
    )
    const baselineFork = await historySearchReady(
      clientB,
      { op: 'history-search', scope: 'session', sessionId: sessionFork, query: '', limit: 25 },
      'baseline Fork rows',
    )
    const expectedRecallA = visibleRecallProjection(acceptedOccurrencesOf(scene.sessionEvents(sessionA) ?? []).map(o => o.text))
    const expectedRecallB = visibleRecallProjection([occB1.text, occB2.text, occB3.text])
    expect(expectedRecallB).toEqual(['history-peer-one', 'history-peer-two', 'history-peer-one'])

    await clientA.exitGracefully()
    await clientB.exitGracefully()
    const host1Status = await scene.hostStatus(host1)
    expect(host1Status.localHost?.hostPid).toBe(host1Pid)
    expect(host1Status.localHost?.instanceId).toBe(host1InstanceId)
    await scene.stopHost(host1)

    // ── B. Cold rebuild + fresh read + Up recall + Queue edit/remove/steer ──
    const historyDir = join(scene.installation.profileDir, '.dsh-pi-tui', 'history-search')
    const canonicalHistoryDir = realpathSync(historyDir)
    expect(relative(scene.workDir, canonicalHistoryDir).startsWith(`..${sep}`)).toBe(false)
    const dbPath = join(canonicalHistoryDir, 'v3.sqlite')
    expect(existsSync(dbPath), 'derived v3.sqlite must exist before cold rebuild').toBe(true)
    const dbStat = lstatSync(dbPath)
    expect(dbStat.isFile() && !dbStat.isSymbolicLink()).toBe(true)
    if (typeof process.getuid === 'function') {
      expect(dbStat.uid).toBe(process.getuid())
    }
    const backupDir = join(scene.workDir, 'history-v3-backup')
    mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    for (const suffix of ['', '-wal', '-shm']) {
      const candidate = `${dbPath}${suffix}`
      if (!existsSync(candidate)) continue
      const stat = lstatSync(candidate)
      expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true)
      renameSync(candidate, join(backupDir, `v3.sqlite${suffix}`))
    }
    expect(existsSync(dbPath)).toBe(false)

    const host2 = await scene.startHost({ scenario: 'history-queue' })
    expect(host2.workloadRoot).toBeTypeOf('string')
    expect(host2.holdReleasePath).toBeTypeOf('string')
    const extraProof2 = join(host2.workloadRoot!, 'history-events.jsonl')
    const host2Pid = host2.ready.localHost?.hostPid
    const host2InstanceId = host2.ready.localHost?.instanceId
    expect(host2InstanceId).not.toBe(host1InstanceId)
    await waitForExtraProof(extraProof2, event => event.kind === 'plugin-loaded', 'gen2 extra fixture loaded')

    const freshClient = await scene.startClient({
      label: 'history-fresh-client',
      cwd: dirFirst,
      home: freshClientHome,
      sessionId: sessionA,
      readAuthorityProof: true,
    })
    await freshClient.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionA,
      'fresh Client mounted Session A',
    )

    // B2. Cold rebuild semantic equality BEFORE any new user write on Host 2
    const rebuiltA = await historySearchReady(
      freshClient,
      { op: 'history-search', scope: 'session', sessionId: sessionA, query: '', limit: 25 },
      'rebuilt Session A rows',
    )
    const rebuiltB = await historySearchReady(
      freshClient,
      { op: 'history-search', scope: 'session', sessionId: sessionB, query: '', limit: 25 },
      'rebuilt Session B rows',
    )
    const rebuiltFork = await historySearchReady(
      freshClient,
      { op: 'history-search', scope: 'session', sessionId: sessionFork, query: '', limit: 25 },
      'rebuilt Fork rows',
    )
    expect(rebuiltA.items).toEqual(baselineA.items)
    expect(rebuiltB.items).toEqual(baselineB.items)
    expect(rebuiltFork.items).toEqual(baselineFork.items)
    const rebuiltUnique = rebuiltA.items.find(item => item.messageId === occ1.messageId)!
    const rebuiltText = await readFullTextChunks(freshClient, rebuiltUnique, 'rebuilt readText')
    expect(rebuiltText.text).toBe(uniqueText)
    const rebuiltForkParent = await historySearchReady(
      freshClient,
      { op: 'history-search', scope: 'session', sessionId: sessionFork, query: uniqueText, limit: 25 },
      'rebuilt Fork still excludes parent prompt',
    )
    expect(rebuiltForkParent.items).toHaveLength(0)

    // B3. Up-arrow recall across Session A -> Session B -> Session A without writes
    const idsABeforeRecall = acceptedOccurrencesOf(scene.sessionEvents(sessionA) ?? []).map(o => o.messageId).sort()
    const idsBBeforeRecall = acceptedOccurrencesOf(scene.sessionEvents(sessionB) ?? []).map(o => o.messageId).sort()
    await assertRecallBrowse(freshClient, expectedRecallA, 'fresh Client recall Session A')

    const statusBeforeB = freshClient.readRecords().filter(r => r.m4b2s === 'surface-status').length
    await freshClient.type(`/resume ${sessionB}`)
    await waitForFrame(freshClient, frame => splitFrame(frame).composer.includes(`/resume ${sessionB}`), 'resume S_B draft')
    await freshClient.press('Enter')
    await waitForFrame(
      freshClient,
      () => freshClient.readRecords().filter(r => r.m4b2s === 'surface-status').slice(statusBeforeB)
        .some(r => r.sessionOpen === true && r.openSessionId === sessionB),
      'fresh Client mounted Session B',
    )
    await waitForFrame(freshClient, frame => (composerDraftOf(frame) ?? '') === '', 'empty draft on Session B')
    await assertRecallBrowse(freshClient, expectedRecallB, 'fresh Client recall Session B')

    const statusBeforeBackA = freshClient.readRecords().filter(r => r.m4b2s === 'surface-status').length
    await freshClient.type(`/resume ${sessionA}`)
    await waitForFrame(freshClient, frame => splitFrame(frame).composer.includes(`/resume ${sessionA}`), 'resume S_A draft')
    await freshClient.press('Enter')
    await waitForFrame(
      freshClient,
      () => freshClient.readRecords().filter(r => r.m4b2s === 'surface-status').slice(statusBeforeBackA)
        .some(r => r.sessionOpen === true && r.openSessionId === sessionA),
      'fresh Client returned to Session A',
    )
    await waitForFrame(freshClient, frame => (composerDraftOf(frame) ?? '') === '', 'empty draft back on Session A')
    await assertRecallBrowse(freshClient, expectedRecallA, 'fresh Client recall Session A after B')
    expect(acceptedOccurrencesOf(scene.sessionEvents(sessionA) ?? []).map(o => o.messageId).sort()).toEqual(idsABeforeRecall)
    expect(acceptedOccurrencesOf(scene.sessionEvents(sessionB) ?? []).map(o => o.messageId).sort()).toEqual(idsBBeforeRecall)

    // B4. Queue edit / remove / steer stability on held Turn in Session Q
    const sessionsBeforeQ = new Set(await scene.sessionIds())
    await freshClient.type('/new')
    await waitForFrame(freshClient, frame => splitFrame(frame).composer.includes('/new'), 'new Session Q draft')
    await freshClient.press('Enter')
    const sessionQ = await scene.waitForNewSessionId(sessionsBeforeQ, 'queue Session Q')
    await freshClient.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionQ,
      'fresh Client mounted Session Q',
    )
    await waitForFrame(freshClient, frame => (composerDraftOf(frame) ?? '') === '', 'empty composer on Session Q')

    await freshClient.type('hsp-queue-seed')
    await waitForFrame(freshClient, frame => splitFrame(frame).composer.includes('hsp-queue-seed'), 'queue seed draft')
    await freshClient.press('Enter')
    await waitForC1WorkEvent(
      host2.workloadRoot!,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionQ,
      'Session Q long-turn held',
    )

    // Queue target: inserted -> edited -> removed (same itemId); index keeps original accepted text once, edited text 0
    await waitForFrame(freshClient, frame => (composerDraftOf(frame) ?? '') === '', 'composer empty while turn held')
    await freshClient.type('hsp-queue-target')
    await waitForFrame(freshClient, frame => splitFrame(frame).composer.includes('hsp-queue-target'), 'queue target draft')
    await freshClient.press('Enter')
    const targetInserted = await waitForExtraProof(
      extraProof2,
      event => event.kind === 'queue-inserted' && event.sessionId === sessionQ,
      'queue target inserted',
    )
    const targetEdited = await waitForExtraProof(
      extraProof2,
      event => event.kind === 'queue-edited' && event.sessionId === sessionQ && event.itemId === targetInserted.itemId,
      'queue target edited',
    )
    const targetRemoved = await waitForExtraProof(
      extraProof2,
      event => event.kind === 'queue-removed' && event.sessionId === sessionQ && event.itemId === targetInserted.itemId,
      'queue target removed',
    )
    expect(targetEdited.itemId).toBe(targetInserted.itemId)
    expect(targetRemoved.itemId).toBe(targetInserted.itemId)

    const targetSearch = await waitForIndexedMessage(
      freshClient,
      { op: 'history-search', scope: 'session', sessionId: sessionQ, query: 'hsp-queue-target', limit: 25 },
      String(targetInserted.itemId),
      'queue target original text indexed once',
    )
    expect(targetSearch.items).toHaveLength(1)
    const editedSearch = await historySearchReady(
      freshClient,
      { op: 'history-search', scope: 'session', sessionId: sessionQ, query: 'hsp-queue-edited', limit: 25 },
      'queue edited text must not appear as accepted input',
    )
    expect(editedSearch.items).toHaveLength(0)

    // Queue steer: inserted -> steered -> released & consumed (same itemId, count remains 1)
    await waitForFrame(freshClient, frame => (composerDraftOf(frame) ?? '') === '', 'composer empty before steer')
    await freshClient.type('hsp-queue-steer')
    await waitForFrame(freshClient, frame => splitFrame(frame).composer.includes('hsp-queue-steer'), 'queue steer draft')
    await freshClient.press('Enter')
    const steerInserted = await waitForExtraProof(
      extraProof2,
      event => event.kind === 'queue-steer-inserted' && event.sessionId === sessionQ,
      'queue steer inserted',
    )
    await waitForExtraProof(
      extraProof2,
      event => event.kind === 'queue-steered' && event.sessionId === sessionQ && event.itemId === steerInserted.itemId,
      'queue steered',
    )
    const steerBeforeRelease = await waitForIndexedMessage(
      freshClient,
      { op: 'history-search', scope: 'session', sessionId: sessionQ, query: 'hsp-queue-steer', limit: 25 },
      String(steerInserted.itemId),
      'steered occurrence indexed before release',
    )
    expect(steerBeforeRelease.items).toHaveLength(1)

    writeFileSync(host2.holdReleasePath!, 'release\n', { mode: 0o600 })
    await waitForC1WorkEvent(
      host2.workloadRoot!,
      event => event.kind === 'long-turn-released' && event.sessionId === sessionQ,
      'Session Q long-turn released',
    )
    await waitForConsumedTurn(scene, sessionQ, String(steerInserted.itemId), 'steered message consumed and settled')
    const steerAfterConsume = await historySearchReady(
      freshClient,
      { op: 'history-search', scope: 'session', sessionId: sessionQ, query: 'hsp-queue-steer', limit: 25 },
      'steered occurrence remains count=1 after consume',
    )
    expect(steerAfterConsume.items.map(i => i.messageId)).toEqual([String(steerInserted.itemId)])

    await freshClient.exitGracefully()
    const host2Status = await scene.hostStatus(host2)
    expect(host2Status.localHost?.hostPid).toBe(host2Pid)
    expect(host2Status.localHost?.instanceId).toBe(host2InstanceId)
    await scene.stopHost(host2)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary)
  }
})
