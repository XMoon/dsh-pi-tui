/**
 * The per-row display mutation revision of `TranscriptFolder`.
 *
 * The revision is the ONLY change signal a lazy transcript renderer has:
 * folded rows are mutated IN PLACE, so object identity never proves that a
 * materialized row is still current. These cases drive a REAL
 * `TranscriptFolder.apply()` with official events — never a hand-written stamp —
 * and assert the revision moves exactly when the displayed row can change.
 *
 * @module @xmoon76/dsh-pi-tui/transcript-display-revision.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { assistantPresentationRevision, TranscriptFolder, transcriptDisplayRevisionOf, transcriptTimingOf } from '../../src/domain/transcript/folder.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'

const T0 = 1_700_000_000_000

function ev(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: T0 + seq * 1000, data } as SessionEvent
}

function userMessage(seq: number, turn: number, id: string, text: string): SessionEvent {
  return ev('user/message', { id: MessageId(id), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, seq)
}

function toolCall(seq: number, turn: number, callId: string, name: string, step = 0, args: Record<string, unknown> = {}): SessionEvent {
  return ev('tool/call', { turn, step, callId: ToolCallId(callId), name, arguments: JSON.stringify(args) }, seq)
}

function toolResult(seq: number, turn: number, callId: string, text: string, step = 0): SessionEvent {
  return ev('tool/result', {
    turn,
    step,
    message: {
      id: MessageId(`result-${callId}`),
      role: 'tool',
      toolCallId: ToolCallId(callId),
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, seq)
}

const findRow = (
  folder: TranscriptFolder,
  predicate: (message: TranscriptMessage) => boolean,
): TranscriptMessage => {
  const row = folder.messages().find(predicate)
  assert.ok(row !== undefined, 'fixture row exists')
  return row
}

test('a late tool result for an OLD turn bumps exactly that old row', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 1, 'user-1', 'first question'),
    toolCall(2, 1, 'call-open', 'bash', 1),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
    ev('turn/start', { turn: 2 }, 4),
    userMessage(5, 2, 'user-2', 'second question'),
  ])
  const openTool = findRow(folder, message => message.kind === 'tool' && message.status === 'running')
  const other = findRow(folder, message => message.kind === 'user' && message.turn === 2)
  const before = transcriptDisplayRevisionOf(openTool)
  const otherBefore = transcriptDisplayRevisionOf(other)

  folder.apply([toolResult(6, 1, 'call-open', 'late result', 1)])

  assert.equal(transcriptDisplayRevisionOf(openTool), before + 1, 'the old tool row carries a new display revision')
  assert.equal(transcriptDisplayRevisionOf(other), otherBefore, 'an unrelated row keeps its revision')
  assert.equal(openTool.kind === 'tool' ? openTool.status : undefined, 'ok', 'the row really changed')
})

test('a same-step re-settlement rewrites the SAME row object and stamps it monotonically', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 1, 'user-1', 'stream please'),
    ev('assistant/message', {
      turn: 1,
      step: 0,
      message: {
        id: MessageId('settled-1'),
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'settled reasoning' }, { type: 'text', text: 'settled answer' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
        stream: [
          { type: 'chunk', time: T0 + 2000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
          { type: 'chunk', time: T0 + 2100, chunk: { type: 'reasoning-delta', index: 0, text: 'settled reasoning' } },
          { type: 'chunk', time: T0 + 2200, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'settled reasoning' } } },
        ],
      },
    }, 2),
  ])
  const thinking = findRow(folder, message => message.kind === 'thinking')
  const assistant = findRow(folder, message => message.kind === 'assistant')
  const revisions = [transcriptDisplayRevisionOf(thinking), transcriptDisplayRevisionOf(assistant)]

  // A projection read never moves a stamp: only real body changes do.
  folder.messages()
  folder.search('settled')
  assert.deepEqual(
    [transcriptDisplayRevisionOf(thinking), transcriptDisplayRevisionOf(assistant)],
    revisions,
    'reading the projection or searching never bumps a row',
  )

  // Two same-step re-settlements: the row OBJECT survives and the revision
  // strictly increases on every real body replacement.
  for (const [index, text] of ['a REPLACED settled answer', 'a THIRD settled answer'].entries()) {
    const before = transcriptDisplayRevisionOf(assistant)
    folder.apply([ev('assistant/message', {
      turn: 1,
      step: 0,
      message: {
        id: MessageId(`settled-1-${index}`),
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'settled reasoning' }, { type: 'text', text }],
        source: { kind: 'model', provider: 'p', model: 'm' },
        stream: [],
      },
    }, 3 + index)])
    assert.equal(findRow(folder, message => message.kind === 'assistant'), assistant, 'the same step keeps the SAME row object')
    assert.ok(transcriptDisplayRevisionOf(assistant) > before, `replacement ${index} stamps the row`)
    assert.ok(String((assistant as { text?: string }).text).includes(index === 0 ? 'REPLACED' : 'THIRD'), 'the body really changed')
  }
})

test('a PTC root gains a child: the root row revision changes', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 1, 'user-1', 'run the program'),
    ev('tool/call', { turn: 1, step: 0, callId: ToolCallId('code-1'), name: 'run_code', arguments: JSON.stringify({ code: 'print(1)' }) }, 2),
  ])
  const root = findRow(folder, message => message.kind === 'tool' && message.name === 'run_code')
  const before = transcriptDisplayRevisionOf(root)
  folder.apply([ev('tool/ptc-dispatch-start', {
    rootCallId: ToolCallId('code-1'),
    parentCallId: ToolCallId('code-1'),
    subCallId: ToolCallId('code-1:code:1'),
    name: 'read',
    arguments: { file_path: 'src/a.ts' },
  }, 3)])
  assert.ok(transcriptDisplayRevisionOf(root) > before, 'the PTC root row is stamped for its new child')
})

test('a consecutive-read group reflow bumps the EMITTED group card', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 1, 'user-1', 'read two files'),
    toolCall(2, 1, 'call-read-a', 'read', 1, { file_path: 'src/a.ts' }),
    toolResult(3, 1, 'call-read-a', 'a', 1),
    toolCall(4, 1, 'call-read-b', 'read', 1, { file_path: 'src/b.ts' }),
    toolResult(5, 1, 'call-read-b', 'b', 1),
  ])
  const grouped = folder.messages().filter(message => message.kind === 'tool')
  const emitted = grouped.find(message => (message.callCount ?? 0) > 1) ?? grouped[0]
  assert.ok(emitted !== undefined)
  const before = transcriptDisplayRevisionOf(emitted)
  // A THIRD adjacent read joins the same run: the emitted group card's body,
  // args and result are rewritten in place by the regroup path.
  folder.apply([
    toolCall(6, 1, 'call-read-c', 'read', 1, { file_path: 'src/c.ts' }),
    toolResult(7, 1, 'call-read-c', 'c', 1),
  ])
  const after = folder.messages().filter(message => message.kind === 'tool')
  const emittedAfter = after.find(message => (message.callCount ?? 0) > 2) ?? after[0]
  assert.ok(emittedAfter !== undefined)
  assert.ok(
    transcriptDisplayRevisionOf(emittedAfter) > before || after.length !== grouped.length,
    'the regroup stamps the card that is actually displayed',
  )
})

test('a pure projection never bumps anything, and a fresh Fold starts its own revisions', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 1, 'user-1', 'no-op please'),
    toolCall(2, 1, 'call-1', 'bash', 1),
    toolResult(3, 1, 'call-1', 'done', 1),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4),
  ])
  const rows = folder.messages()
  const revisions = rows.map(row => transcriptDisplayRevisionOf(row))
  for (let index = 0; index < 3; index += 1) {
    const again = folder.messages()
    assert.deepEqual(again.map(row => transcriptDisplayRevisionOf(row)), revisions, 'reading the projection never bumps')
    folder.search('done')
  }
  assert.deepEqual(rows.map(row => transcriptDisplayRevisionOf(row)), revisions, 'searching never bumps')

  const fresh = new TranscriptFolder()
  fresh.apply([userMessage(1, 1, 'user-other', 'other subject')])
  const freshRow = fresh.messages()[0]!
  assert.notEqual(freshRow, rows[0], 'the cold fold owns NEW objects')
  assert.equal(transcriptDisplayRevisionOf(freshRow), 0, 'a fresh row starts at revision 0')
})

test('a compaction card is stamped by its counts-only summary and by an end-seed settle', () => {
  const folder = new TranscriptFolder()
  folder.apply([ev('compaction/start', { compactionId: 'cp-1' }, 0)])
  const card = findRow(folder, message => message.kind === 'compaction')
  assert.equal(card.kind === 'compaction' ? card.running : undefined, true, 'the card starts running')
  const started = transcriptDisplayRevisionOf(card)

  // Counts-only summary: no body text, but the rendered counts badge changes.
  folder.apply([ev('compaction/summary', {
    compactionId: 'cp-1',
    shadowedSeqs: [1, 2, 3],
    shadowedTokenCount: 4242,
  }, 1)])
  const afterCounts = transcriptDisplayRevisionOf(card)
  assert.ok(afterCounts > started, 'a counts-only summary stamps the card')
  assert.equal(card.kind === 'compaction' ? card.items : undefined, 3)
  assert.equal(card.kind === 'compaction' ? card.tokens : undefined, 4242)

  // A second identical summary is a no-op: nothing visible changed.
  folder.apply([ev('compaction/summary', {
    compactionId: 'cp-1',
    shadowedSeqs: [1, 2, 3],
    shadowedTokenCount: 4242,
  }, 2)])
  assert.equal(transcriptDisplayRevisionOf(card), afterCounts, 'an identical counts summary does not re-stamp')

  // The resume seed boundary settles every card still open at it.
  folder.apply([ev('session/end-seed', {}, 3)])
  assert.equal(card.kind === 'compaction' ? card.running : undefined, false, 'the seed boundary settles the card')
  assert.ok(transcriptDisplayRevisionOf(card) > afterCounts, 'the settled card is stamped')
})

test('a proven EARLIER Preparing start stamps the materialized tool card', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    ev('step/start', { turn: 1, step: 0 }, 1),
    userMessage(2, 1, 'user-1', 'run it'),
    // The durable tool/call creates the card at the settlement time...
    ev('tool/call', { turn: 1, step: 0, callId: ToolCallId('call-timing'), name: 'bash', arguments: JSON.stringify({ command: 'ls' }) }, 3),
  ])
  const card = findRow(folder, message => message.kind === 'tool' && message.callId === 'call-timing')
  const before = transcriptDisplayRevisionOf(card)
  const beforeTiming = transcriptTimingOf(card)?.startedAt
  assert.ok(beforeTiming !== undefined)
  // ...and the attempt's embedded stream proves an EARLIER start for the SAME
  // call. The Work header duration is computed from that sidecar, so the card
  // must be stamped or a lazy renderer keeps the stale duration.
  folder.apply([ev('assistant/attempt', {
    turn: 1,
    step: 0,
    stream: [
      { type: 'chunk', time: T0 + 50, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } },
      { type: 'chunk', time: T0 + 100, chunk: { type: 'tool-call-delta', index: 0, id: 'call-timing', name: 'bash', argumentsDelta: '{}' } },
    ],
  }, 4)])
  const afterTiming = transcriptTimingOf(card)?.startedAt
  assert.ok(afterTiming !== undefined && afterTiming < beforeTiming,
    `the fold really moved the proven start earlier (${String(beforeTiming)} -> ${String(afterTiming)})`)
  assert.ok(transcriptDisplayRevisionOf(card) > before, 'the earlier start stamps the owning card')
})

test('interruption evidence stamps the attempt row even when its visibility does not move', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 1, 'user-1', 'answer me'),
    ev('step/start', { turn: 1, step: 0 }, 2),
    ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'partial answer' } }, 3),
    ev('assistant/attempt', {
      turn: 1,
      step: 0,
      stream: [
        { type: 'chunk', time: T0 + 400, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'chunk', time: T0 + 500, chunk: { type: 'text-delta', index: 0, text: 'partial answer' } },
      ],
    }, 4),
  ])
  const row = findRow(folder, message => message.kind === 'assistant')
  const displayBefore = transcriptDisplayRevisionOf(row)
  const presentationBefore = assistantPresentationRevision(row)
  // The step fails: the attempt row keeps its visibility (it was already
  // visible) but gains interruption evidence, which changes what it renders and
  // disqualifies it as the turn's final Assistant.
  folder.apply([ev('step/end', { turn: 1, step: 0, reason: { kind: 'error', error: { code: 'model_error', message: 'boom' } } }, 5)])
  assert.equal(row.kind === 'assistant' ? row.interrupted : undefined, true, 'the row really carries interruption evidence')
  assert.ok(transcriptDisplayRevisionOf(row) > displayBefore, 'the interrupted row is stamped for display')
  assert.ok(assistantPresentationRevision(row) > presentationBefore, 'the Assistant presentation revision moves too')
})
