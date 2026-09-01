/**
 * Transcript search-index tests (PR D1): the incremental full-history search
 * projection must be SEMANTICALLY IDENTICAL to the legacy full search
 * (`folder.messages()` + filter + per-message lowercase) on the whole corpus
 * — same count, same order, same turn, same resolved visible card — while
 * the query path never materializes the grouped transcript and never
 * re-lowercases history per query.
 *
 * The parity oracle (`legacySearchForTest`) exists ONLY in this test file —
 * production keeps the single indexed implementation.
 * @module @xmoon76/dsh-pi-tui/transcript-search-index.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder, transcriptSearchText, type TranscriptMessage, type TranscriptSearchMatch } from '../src/transcript.ts'

/** Build a minimal event envelope for tests. */
function event<K extends SessionEvent['type']>(
  type: K,
  data: SessionEvent<K>['data'],
  seq: number,
): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

/** Build a surface event carrying its surface metadata marker. */
function surfaceEvent<K extends SessionEvent['type']>(
  type: K,
  data: SessionEvent<K>['data'],
  seq: number,
  surfaceOp: 'append' | { op: 'replace'; start: number; end: number },
): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data, surfaceOp } as SessionEvent
}

function userMessage(seq: number, text: string, turn = 0): SessionEvent {
  return event('user/message', {
    id: MessageId(`msg-${seq}`),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }, seq)
}

function assistantChunks(seq: number, turn: number, step: number, chunks: string[]): SessionEvent[] {
  return chunks.map((text, index) => event('assistant/chunk', {
    turn, step, chunk: { type: 'text-delta', index, text },
  }, seq + index))
}

function assistantMessage(seq: number, turn: number, step: number, text: string): SessionEvent {
  return event('assistant/message', {
    turn, step,
    message: { id: MessageId(`am-${seq}`), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'test', model: 'test' } },
  }, seq)
}

function turnStart(seq: number, turn: number): SessionEvent {
  return event('turn/start', { turn }, seq)
}

function turnEnd(seq: number, turn: number, reason: SessionEvent<'turn/end'>['data']['reason'] = { kind: 'completed' }): SessionEvent {
  return event('turn/end', { turn, reason }, seq)
}

/** One append-origin tool result for `callId`. */
function toolResult(seq: number, callId: string, text: string, name = 'bash', turn = 0): SessionEvent {
  return surfaceEvent('tool/result', {
    turn, step: 0,
    message: {
      id: MessageId(`msg-${seq}`),
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId(callId),
        content: [{ type: 'text', text }],
      }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, seq, 'append')
}

function toolCall(seq: number, callId: string, name: string, args: unknown, turn = 0): SessionEvent {
  return event('tool/call', {
    turn, step: 0, callId: ToolCallId(callId), name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  }, seq)
}

function readToolCall(seq: number, callId: string, file: string, turn = 0): SessionEvent {
  return toolCall(seq, callId, 'read', { file }, turn)
}

/** Build an event with loosely-typed data (plugin/extension event kinds). */
function rawEvent(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

function compactionEvent(type: 'compaction/start' | 'compaction/summary' | 'compaction/end', data: Record<string, unknown>, seq: number): SessionEvent {
  return rawEvent(type, data, seq)
}

function cardText(message: TranscriptMessage | undefined): string {
  if (message === undefined) return ''
  if (message.kind === 'tool') return `${message.name} ${message.args} ${message.result}`
  return message.text ?? ''
}

/**
 * The legacy full-history search semantics — the PARITY ORACLE. This is the
 * exact pre-D1 production path: every query materialized the grouped
 * transcript and re-lowercased every message. Test-only; never production.
 */
function legacySearchForTest(folder: TranscriptFolder, query: string): TranscriptMessage[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  return folder.messages().filter(message => {
    const text = message.kind === 'tool' ? `${message.name} ${message.args} ${message.result}` : message.text
    return text.toLowerCase().includes(needle)
  })
}

/**
 * Semantic parity: same count, same order, same turn, and every indexed
 * match resolves to the EXACT legacy card object (identity — a merged read
 * group must resolve to the same card legacy emitted).
 */
function assertSearchParity(folder: TranscriptFolder, query: string, label = ''): void {
  const legacy = legacySearchForTest(folder, query)
  const indexed = folder.search(query)
  assert.equal(indexed.length, legacy.length, `${label} count for ${JSON.stringify(query)} (indexed ${indexed.length} vs legacy ${legacy.length})`)
  for (let i = 0; i < legacy.length; i += 1) {
    const resolved = folder.resolveSearchMatch(indexed[i]!)
    assert.equal(resolved, legacy[i], `${label} match ${i} for ${JSON.stringify(query)} must resolve to the legacy card`)
    const legacyCard = legacy[i]!
    const legacyTurn = 'turn' in legacyCard ? legacyCard.turn : undefined
    assert.equal(indexed[i]!.turn, legacyTurn, `${label} match ${i} turn for ${JSON.stringify(query)}`)
  }
}

/** Search corpus parity across a folder for a battery of queries. */
function assertCorpusParity(folder: TranscriptFolder, queries: string[], label = ''): void {
  for (const query of queries) assertSearchParity(folder, query, label)
}

test('parity: a plain user + assistant session (case-insensitive, empty query)', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    turnStart(0, 0),
    userMessage(1, 'Hello Searchable World'),
    ...assistantChunks(2, 0, 0, ['The ', 'quick brown ', 'fox.']),
    assistantMessage(5, 0, 0, 'The quick brown fox.'),
    turnEnd(6, 0),
  ])
  assertCorpusParity(folder, ['', 'hello', 'HELLO', 'searchable', 'brown', 'fox', 'missing', '   hello   '])
  assert.deepEqual(folder.search(''), [], 'empty query yields no matches')
  const first = folder.search('hello')
  assert.equal(first.length, 1)
  assert.equal(first[0]!.turn, 0)
  const resolved = folder.resolveSearchMatch(first[0]!)
  assert.equal(resolved?.kind, 'user')
})

test('parity: streaming text is searchable as it accumulates (running -> settled)', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    turnStart(0, 0),
    ...assistantChunks(1, 0, 0, ['running ', 'needle', '-in-stream']),
  ])
  // Partial streamed text is searchable (legacy searched message.text too).
  assertCorpusParity(folder, ['needle', 'running'])
  folder.apply([assistantMessage(4, 0, 0, 'settled final answer')])
  assertCorpusParity(folder, ['needle', 'settled', 'final'])
})

test('parity: tool cards search name + args + result; running args first', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(0, 0),
    toolCall(1, 'c1', 'bash', { command: 'ls unusual-dir' }, 0),
    toolResult(2, 'c1', 'file listing result content'),
    turnEnd(3, 0),
  ])
  assertCorpusParity(folder, ['ls unusual-dir', 'file listing', 'result', 'bash', 'unusual-dir'])
  // A still-running tool's ARGS are searchable before the result lands.
  const runningFolder = new TranscriptFolder()
  runningFolder.apply([
    turnStart(0, 0),
    toolCall(1, 'c2', 'bash', { command: 'grep live-needle' }, 0),
  ])
  assertCorpusParity(runningFolder, ['live-needle', 'grep'])
  runningFolder.apply([toolResult(2, 'c2', 'the settled payload')])
  assertCorpusParity(runningFolder, ['live-needle', 'settled payload', 'grep'])
})

test('parity: system cards, compaction summary and the image marker in user text', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(0, 0),
    userMessage(1, 'Look at this 🖼️ screenshot.png content'),
    rawEvent('llm/retry', { retry: 1, delayMs: 2000, failure: { code: 'E_RATE', message: 'too many requests' } }, 2),
    compactionEvent('compaction/start', { compactionId: 'k1' }, 3),
    compactionEvent('compaction/summary', { compactionId: 'k1', summary: [{ type: 'text', text: 'compressed earlier discussion about token budgets' }] }, 4),
    compactionEvent('compaction/end', { compactionId: 'k1' }, 5),
    turnEnd(6, 0),
  ])
  assertCorpusParity(folder, ['screenshot.png', '🖼️', 'E_RATE', 'too many requests', 'token budgets', 'compressed'])
})

test('case-insensitivity: Unicode lowercases exactly like the legacy path', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(0, 0),
    userMessage(1, 'Ünïcödé Ärchiv Överflow'),
  ])
  assertCorpusParity(folder, ['ünïcödé', 'ÜNÏCÖDÉ', 'ärchiv', 'overflow'])
})

test('G1: same-turn adjacent reads merge into ONE visible match, parity kept', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(0, 0),
    readToolCall(1, 'r1', 'src/a.ts', 0),
    toolResult(2, 'r1', 'content of shared-keyword file A'),
    readToolCall(3, 'r2', 'src/b.ts', 0),
    toolResult(4, 'r2', 'content of shared-keyword file B'),
    readToolCall(5, 'r3', 'src/c.ts', 0),
    toolResult(6, 'r3', 'content of shared-keyword file C'),
    turnEnd(7, 0),
  ])
  const messages = folder.messages()
  const grouped = messages.filter(message => message.kind === 'tool' && message.name === 'read')
  assert.equal(grouped.length, 1, 'the three reads merge into one card')
  assertCorpusParity(folder, ['shared-keyword', 'file A', 'file B', 'file C', 'read'])
  const matches = folder.search('shared-keyword')
  assert.equal(matches.length, 1, 'one logical card -> one search result, never three')
  assert.equal(matches[0]!.turn, 0)
  // The legacy merged card searches "read N files <results>" — no member paths.
  assert.equal(legacySearchForTest(folder, 'src/b.ts').length, 0)
  assert.equal(folder.search('src/b.ts').length, 0, 'member paths are NOT searchable: strict legacy parity')
})

test('G2: cross-turn read grouping keeps one visible match with the max turn', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(0, 0),
    readToolCall(1, 'r1', 'src/a.ts', 0),
    toolResult(2, 'r1', 'cross-turn keyword part one'),
    turnEnd(3, 0),
    turnStart(4, 1),
    readToolCall(5, 'r2', 'src/b.ts', 1),
    toolResult(6, 'r2', 'cross-turn keyword part two'),
    turnEnd(7, 1),
  ])
  const grouped = folder.messages().filter((message): message is Extract<TranscriptMessage, { turn: number }> => message.kind === 'tool' && message.name === 'read')
  assert.equal(grouped.length, 1, 'the cross-turn reads merge into one card')
  assert.equal(grouped[0]!.turn, 1, 'the merged card carries the max turn')
  assertCorpusParity(folder, ['cross-turn', 'keyword', 'part one', 'part two'])
  const matches = folder.search('cross-turn')
  assert.equal(matches.length, 1)
  assert.equal(matches[0]!.turn, 1)
})

test('G3: a late non-tail result reflows the run; search text updates, no duplicate', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(0, 0),
    readToolCall(1, 'r1', 'src/a.ts', 0),
    toolResult(2, 'r1', 'first file content'),
    turnEnd(3, 0),
    turnStart(4, 1),
    userMessage(5, 'unrelated later turn'),
    // The late result of an earlier call lands AFTER later items: the
    // defensive reflow path must merge the run and refresh the projection.
    toolResult(6, 'r1-again', 'late-second-file content'),
    turnEnd(7, 1),
  ])
  // The orphan result appends a new read card AFTER the user message: no
  // adjacency, so it stays a singleton — parity with the grouped output.
  assertCorpusParity(folder, ['first file', 'late-second-file', 'unrelated'])
  const before = folder.search('first file')
  assert.equal(before.length, 1)
  // A live late settle of an ADJACENT pending read (running -> settled in
  // the middle of a run) must reflow and refresh.
  const live = new TranscriptFolder()
  live.hydrate([
    turnStart(0, 0),
    readToolCall(1, 'a', 'src/a.ts', 0),
    toolResult(2, 'a', 'alpha payload'),
    readToolCall(3, 'b', 'src/b.ts', 0),
    readToolCall(4, 'c', 'src/c.ts', 0),
    toolResult(5, 'c', 'gamma payload'),
  ])
  // b is still RUNNING: a and c are separate singletons; b searchable by args.
  assertCorpusParity(live, ['alpha payload', 'gamma payload', 'src/b.ts'])
  live.apply([toolResult(6, 'b', 'beta payload')])
  // Now a+b+c merge into ONE card: one match for any member content.
  const matches = live.search('payload')
  assert.equal(matches.length, 1, 'late settlement merges the run into one visible match')
  assertCorpusParity(live, ['alpha payload', 'beta payload', 'gamma payload', 'payload', 'src/b.ts'])
})

test('G4: running -> settled read args searchable, then merged group text', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    turnStart(0, 0),
    readToolCall(1, 'r1', 'src/alpha.ts', 0),
    readToolCall(2, 'r2', 'src/beta.ts', 0),
  ])
  assertCorpusParity(folder, ['src/alpha.ts', 'src/beta.ts', 'read'])
  folder.apply([toolResult(3, 'r1', 'alpha-result needle')])
  // r1 settled; r2 still running: r1 alone is not groupable (needs a run).
  assertCorpusParity(folder, ['alpha-result needle', 'src/beta.ts'])
  folder.apply([toolResult(4, 'r2', 'beta-result needle')])
  assertCorpusParity(folder, ['needle'])
  const matches = folder.search('needle')
  assert.equal(matches.length, 1, 'the merged read card is one match')
})

test('G5: error results and synthetic error cards keep legacy semantics', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(0, 0),
    toolCall(1, 'e1', 'read', { file: 'src/missing.ts' }, 0),
    surfaceEvent('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('msg-e1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId('e1'), isError: true, content: [{ type: 'text', text: 'ENOENT: no such file' }] }],
        source: { kind: 'tool', callId: ToolCallId('e1') },
      },
    }, 2, 'append'),
    turnEnd(3, 0, { kind: 'error', error: { code: 'E_TURN', message: 'the turn failed loudly' } }),
  ])
  // The failed read stays a singleton (error results never group) and the
  // synthetic error card is searchable exactly like legacy.
  assertCorpusParity(folder, ['ENOENT', 'missing.ts', 'E_TURN', 'failed loudly'])
  const errorCards = folder.search('E_TURN')
  assert.equal(errorCards.length, 1)
  assert.equal(folder.resolveSearchMatch(errorCards[0]!)?.kind, 'tool')
})

test('system reminder rows search their text (skill/context injection)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(0, 0),
    rawEvent('user/message', {
      id: 'ctx-1', role: 'user',
      content: [{ type: 'text', text: '<system-reminder>follow the injected skill guidance</system-reminder>' }],
      source: { kind: 'instruction', ref: 'skill-catalog' },
    }, 1),
    turnEnd(2, 0),
  ])
  assertCorpusParity(folder, ['injected skill', 'system-reminder'])
})

test('order: matches follow the logical transcript order across turns', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(0, 0),
    userMessage(1, 'first needle'),
    turnEnd(2, 0),
    turnStart(3, 1),
    userMessage(4, 'middle needle'),
    turnEnd(5, 1),
    turnStart(6, 2),
    userMessage(7, 'last needle'),
    turnEnd(8, 2),
  ])
  const matches = folder.search('needle')
  assert.deepEqual(matches.map(match => match.turn), [0, 1, 2])
  const resolved = matches.map(match => cardText(folder.resolveSearchMatch(match)))
  assert.deepEqual(resolved, ['first needle', 'middle needle', 'last needle'])
})

test('stable ids survive settlement and group reflow (never object identity)', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    turnStart(0, 0),
    readToolCall(1, 'r1', 'src/a.ts', 0),
    toolResult(2, 'r1', 'result one'),
    readToolCall(3, 'r2', 'src/b.ts', 0),
    toolResult(4, 'r2', 'result two'),
    turnEnd(5, 0),
  ])
  const matches = folder.search('result')
  assert.equal(matches.length, 1, 'merged group -> one match')
  const id = matches[0]!.id
  // A later live append must not change the id namespace of earlier matches.
  folder.apply([
    turnStart(6, 1),
    userMessage(7, 'result three in a new turn'),
    turnEnd(8, 1),
  ])
  assert.equal(id, matches[0]!.id, 'the id stays stable across live appends')
  const resolved = folder.resolveSearchMatch({ id, turn: 0 })
  assert.equal(resolved?.kind, 'tool', 'the id still resolves to the merged card')
  assert.ok(resolved!.result.includes('result one') && resolved!.result.includes('result two'))
})

test('query refinement: prefix typing narrows candidates only when the revision is unchanged', () => {
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 0; turn < 50; turn += 1) {
    events.push(turnStart(seq++, turn))
    events.push(userMessage(seq++, `needle candidate ${turn}`, turn))
    events.push(userMessage(seq++, `other filler ${turn}`, turn))
    events.push(turnEnd(seq++, turn))
  }
  folder.hydrate(events)
  const diagnosticsBefore = folder.searchDiagnosticsForTest()

  let matches: TranscriptSearchMatch[] = folder.search('n')
  let revision = folder.searchRevision()
  assert.equal(matches.length, 50, 'every turn has a needle candidate')
  assert.equal(folder.searchDiagnosticsForTest().fullScans, diagnosticsBefore.fullScans + 1)
  const scansAtStart = folder.searchDiagnosticsForTest()

  // Refined typing: n -> ne -> nee -> need -> needle.
  for (const partial of ['ne', 'nee', 'need', 'needle']) {
    matches = folder.search(partial, { previousQuery: partial.slice(0, -1), previousMatches: matches, revision })
    revision = folder.searchRevision()
  }
  const diagnostics = folder.searchDiagnosticsForTest()
  assert.equal(matches.length, 50)
  assert.equal(diagnostics.fullScans, scansAtStart.fullScans, 'no full scan while refining')
  assert.equal(diagnostics.refinedScans, scansAtStart.refinedScans + 4)
  assert.deepEqual(matches.map(match => match.turn), Array.from({ length: 50 }, (_, index) => index), 'order preserved under refinement')

  // A projection mutation between queries (live append) invalidates the
  // refinement: the next query must full-scan.
  folder.apply([userMessage(100, 'needle appended later', 50)])
  const afterAppend = folder.search('needle', { previousQuery: 'needl', previousMatches: matches, revision })
  assert.equal(afterAppend.length, 51, 'the new message is visible')
  assert.equal(folder.searchDiagnosticsForTest().fullScans, scansAtStart.fullScans + 1, 'revision change forces a full lightweight scan')
})

test('live mutation while matches are held: no stale object, no crash, next query sees new content', () => {
  const folder = new TranscriptFolder()
  folder.hydrate([
    turnStart(0, 0),
    userMessage(1, 'needle here'),
    turnEnd(2, 0),
  ])
  const held = folder.search('needle')
  assert.equal(held.length, 1)
  // Stream a new message containing the needle while the old matches live.
  folder.apply([
    turnStart(3, 1),
    ...assistantChunks(4, 1, 0, ['a brand new ', 'needle message']),
  ])
  const resolved = folder.resolveSearchMatch(held[0]!)
  assert.equal(cardText(resolved), 'needle here', 'old match still resolves to its own card')
  assert.equal(folder.search('needle').length, 2, 'a new query sees the streamed needle')
})

test('structural gate: search never materializes the transcript nor re-lowercases on query', () => {
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 0; turn < 1000; turn += 1) {
    events.push(turnStart(seq++, turn))
    events.push(userMessage(seq++, `user prompt ${turn} with needle occasionally`, turn))
    events.push(assistantMessage(seq++, turn, 0, `assistant answer ${turn}`))
    events.push(toolCall(seq++, `t${turn}`, 'bash', { command: `echo needle ${turn}` }, turn))
    events.push(toolResult(seq++, `t${turn}`, `output of tool ${turn}`))
    events.push(turnEnd(seq++, turn))
  }
  folder.hydrate(events)
  const diagnosticsAfterHydrate = folder.searchDiagnosticsForTest()
  assert.equal(diagnosticsAfterHydrate.entries, folder.messages().length, 'one entry per visible logical card')

  // Spy on messages(): the indexed query path must NEVER call it.
  let messagesCalls = 0
  const originalMessages = folder.messages.bind(folder)
  Object.defineProperty(folder, 'messages', {
    configurable: true,
    value: (...args: unknown[]) => {
      messagesCalls += 1
      return (originalMessages as (...a: unknown[]) => TranscriptMessage[])(...args)
    },
  })
  const miss = folder.search('unlikely-needle-not-present')
  assert.equal(miss.length, 0)
  const hits = folder.search('needle')
  assert.ok(hits.length >= 1000, `every turn hits: ${hits.length}`)
  assert.equal(messagesCalls, 0, 'the indexed query path never calls messages()')
  const afterQueries = folder.searchDiagnosticsForTest()
  assert.equal(afterQueries.normalizedRefreshes, diagnosticsAfterHydrate.normalizedRefreshes, 'queries never re-lowercase search text')
  assert.equal(afterQueries.groupingRebuilds, diagnosticsAfterHydrate.groupingRebuilds, 'queries never rebuild grouping')
})

test('10k-turn structural complexity gate: lightweight scan + refinement, no projection', () => {
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 0; turn < 10_000; turn += 1) {
    events.push(turnStart(seq++, turn))
    events.push(userMessage(seq++, `prompt ${turn}`, turn))
    events.push(assistantMessage(seq++, turn, 0, `answer ${turn} with filler text`))
    events.push(turnEnd(seq++, turn))
  }
  folder.hydrate(events)
  const afterHydrate = folder.searchDiagnosticsForTest()
  let messagesCalls = 0
  const originalMessages = folder.messages.bind(folder)
  Object.defineProperty(folder, 'messages', {
    configurable: true,
    value: (...args: unknown[]) => {
      messagesCalls += 1
      return (originalMessages as (...a: unknown[]) => TranscriptMessage[])(...args)
    },
  })
  const matches = folder.search('answer')
  assert.equal(matches.length, 10_000)
  assert.equal(messagesCalls, 0, 'full history is never materialized on the query path')
  assert.equal(folder.searchDiagnosticsForTest().normalizedRefreshes, afterHydrate.normalizedRefreshes, 'no re-lowercase on query')
  // 'answer 999' hits turn 999 and every 999x turn (9990..9999).
  const before: TranscriptSearchMatch[] = folder.search('answer 999')
  assert.equal(before.length, 11)
  const fullScans = folder.searchDiagnosticsForTest().fullScans
  const after = folder.search('answer 9999', { previousQuery: 'answer 999', previousMatches: before, revision: folder.searchRevision() })
  assert.equal(after.length, 1, 'refinement narrows candidates to the exact turn')
  assert.equal(folder.searchDiagnosticsForTest().fullScans, fullScans, 'refinement avoids the full scan')
  assert.equal(folder.searchDiagnosticsForTest().refinedScans, 1)
})

test('session/folder isolation: each folder owns its projection and matches', () => {
  const folderA = new TranscriptFolder()
  folderA.hydrate([turnStart(0, 0), userMessage(1, 'needle in session A'), turnEnd(2, 0)])
  const folderB = new TranscriptFolder()
  folderB.hydrate([turnStart(3, 0), userMessage(4, 'needle in session B'), turnEnd(5, 0)])
  const a = folderA.search('needle')
  const b = folderB.search('needle')
  assert.equal(a.length, 1)
  assert.equal(b.length, 1)
  assert.equal(cardText(folderA.resolveSearchMatch(a[0]!)), 'needle in session A')
  assert.equal(cardText(folderB.resolveSearchMatch(b[0]!)), 'needle in session B')
  // Ids are namespace-local: identical ids resolve to different sessions.
  assert.equal(a[0]!.id, b[0]!.id)
})

test('failed-read singleton never merges; its search text keeps the path', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(0, 0),
    readToolCall(1, 'ok1', 'src/ok.ts', 0),
    toolResult(2, 'ok1', 'ok result'),
    readToolCall(3, 'bad1', 'src/missing.ts', 0),
    surfaceEvent('tool/result', {
      turn: 0, step: 0,
      message: {
        id: MessageId('bad'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId('bad1'), isError: true, content: [{ type: 'text', text: 'read failed' }] }],
        source: { kind: 'tool', callId: ToolCallId('bad1') },
      },
    }, 4, 'append'),
    turnEnd(5, 0),
  ])
  assertCorpusParity(folder, ['src/ok.ts', 'ok result', 'src/missing.ts', 'read failed'])
  const reads = folder.messages().filter(message => message.kind === 'tool' && message.name === 'read')
  assert.equal(reads.length, 2, 'ok run and failed singleton stay separate cards')
})

test('command/done and workflow cards are searchable exactly like legacy', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(0, 0),
    rawEvent('command/run', { commandId: 'cmd1', name: 'theme', args: '' }, 1),
    rawEvent('command/done', { commandId: 'cmd1', kind: 'success', text: 'theme set to dark' }, 2),
    rawEvent('tool-workflow/run-start', { runId: 'run1', name: 'audit' }, 3),
    rawEvent('tool-workflow/run-end', { runId: 'run1', stopReason: 'completed' }, 4),
    turnEnd(5, 0),
  ])
  assertCorpusParity(folder, ['theme set to dark', '/theme', 'audit', 'stop: completed'])
  const workflow = folder.search('stop: completed')
  assert.equal(workflow.length, 1)
  assert.equal(folder.resolveSearchMatch(workflow[0]!)?.kind, 'tool')
})

test('transcriptSearchText is the single corpus source (tool = name args result)', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    turnStart(0, 0),
    toolCall(1, 'c1', 'bash', { command: 'echo hi' }, 0),
  ])
  const running = folder.messages()[0]!
  assert.equal(transcriptSearchText(running), 'bash {"command":"echo hi"} ')
  assert.ok(transcriptSearchText(running).toLowerCase().includes('echo hi'))
})
