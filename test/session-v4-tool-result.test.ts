/**
 * Session V4 first-class tool-role results (DSH 0.1.7-alpha.2, P0 PR B1).
 *
 * The durable `tool/result` event still exists, but its `data.message` is now
 * a first-class `ToolResultMessage` (`role: 'tool'`, `toolCallId`, direct
 * `content`, optional `isError`) instead of the released-V3 user-role wrapper
 * carrying one `tool-result` content block. These tests pin the TUI's
 * consumption of that native shape end to end:
 *
 * - native success / error / absent-error-detail outcomes (status authority is
 *   `message.isError`, never `data.error` alone);
 * - call/result pairing by native `toolCallId` for interleaved parallel calls
 *   including same-name calls;
 * - empty and multimodal result content preserved verbatim (order included);
 * - the Markdown transcript projection reading `message.content` directly;
 * - historical released-V3 data reaching the fold ONLY through the official
 *   `@deepseek-ai/dsh-session-format-v3-to-v4` migration.
 *
 * @module @xmoon76/dsh-pi-tui/session-v4-tool-result.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createToolResultMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatV3ToV4, sessionFormatV3ToV4 } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { resultTextLines, type JsonValue } from '../src/present.ts'
import { renderTranscriptMarkdown, TranscriptFolder, type TranscriptMessage } from '../src/transcript.ts'

type ToolCard = Extract<TranscriptMessage, { kind: 'tool' }>

const FILE_BLOCK = {
  type: 'file',
  attachment: { attachmentId: 'att-file-1', name: 'report.pdf', bytes: 12_600 },
} as unknown as ContentBlock

const IMAGE_BLOCK = {
  type: 'image',
  attachment: { attachmentId: 'att-img-1', mediaType: 'image/png', bytes: 4, width: 800, height: 600, name: 'shot.png' },
} as unknown as ContentBlock

const text = (value: string): ContentBlock => ({ type: 'text', text: value })

/** One durable envelope event (no surface metadata). */
function event(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 1000 + seq, data } as unknown as SessionEvent
}

/** One append-origin surface event. */
function surfaceEvent(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 1000 + seq, surfaceOp: 'append', data } as unknown as SessionEvent
}

function turnStart(seq = 0, turn = 0): SessionEvent {
  return event('turn/start', { turn }, seq)
}

function turnEnd(seq: number, turn = 0): SessionEvent {
  return event('turn/end', { turn, reason: { kind: 'completed' } }, seq)
}

function toolCall(seq: number, callId: string, name = 'bash', args: unknown = {}): SessionEvent {
  return event('tool/call', {
    turn: 0,
    step: 0,
    callId: ToolCallId(callId),
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  }, seq)
}

/** One native V4 `tool/result` event built through the official constructor. */
function toolResult(
  seq: number,
  callId: string,
  content: readonly ContentBlock[],
  options: {
    isError?: boolean
    error?: { name: string; code: string; reason?: string }
    meta?: JsonValue
  } = {},
): SessionEvent {
  return surfaceEvent('tool/result', {
    turn: 0,
    step: 0,
    message: createToolResultMessage({ callId: ToolCallId(callId), content, isError: options.isError === true }),
    ...(options.error === undefined ? {} : { error: options.error }),
    ...(options.meta === undefined ? {} : { meta: options.meta }),
  }, seq)
}

function fold(events: readonly SessionEvent[]): TranscriptMessage[] {
  const folder = new TranscriptFolder()
  folder.apply(events)
  return folder.messages()
}

function toolCards(messages: readonly TranscriptMessage[]): ToolCard[] {
  return messages.filter((message): message is ToolCard => message.kind === 'tool')
}

test('a native V4 successful result settles its call with ok status and exact content', () => {
  const messages = fold([
    turnStart(),
    toolCall(1, 'c1', 'read', { file: 'a.ts' }),
    toolResult(2, 'c1', [text('ok')], { meta: { diff: '+line' } }),
    turnEnd(3),
  ])
  const card = toolCards(messages)[0]!
  assert.equal(card.status, 'ok')
  assert.equal(card.name, 'read')
  assert.equal(card.result, 'ok')
  assert.deepEqual(card.resultBlocks, [text('ok')])
  assert.deepEqual(card.meta, { diff: '+line' })
})

test('a native V4 error result keeps the structured error detail beside the error status', () => {
  const messages = fold([
    turnStart(),
    toolCall(1, 'c1', 'read'),
    toolResult(2, 'c1', [text('ENOENT: no such file')], {
      isError: true,
      error: { name: 'read-failed', code: 'ENOENT', reason: 'missing file' },
    }),
    turnEnd(3),
  ])
  const card = toolCards(messages)[0]!
  assert.equal(card.status, 'error')
  assert.equal(card.result, 'ENOENT: no such file')
  assert.deepEqual(card.resultBlocks, [text('ENOENT: no such file')])
  assert.deepEqual(card.error, { name: 'read-failed', code: 'ENOENT', reason: 'missing file' })
})

test('message.isError alone is the outcome authority when no structured error detail is present', () => {
  const messages = fold([
    turnStart(),
    toolCall(1, 'c1', 'read'),
    toolResult(2, 'c1', [text('read failed')], { isError: true }),
    turnEnd(3),
  ])
  const card = toolCards(messages)[0]!
  assert.equal(card.status, 'error')
  assert.equal(card.error, undefined)
})

test('parallel results settle their own call regardless of arrival order', () => {
  const messages = fold([
    turnStart(),
    toolCall(1, 'call-a', 'bash', { command: 'a' }),
    toolCall(2, 'call-b', 'bash', { command: 'b' }),
    toolResult(3, 'call-b', [text('B-result')]),
    toolResult(4, 'call-a', [text('A-result')]),
    turnEnd(5),
  ])
  const cards = toolCards(messages)
  assert.equal(cards.length, 2)
  assert.equal(cards[0]!.args, JSON.stringify({ command: 'a' }))
  assert.equal(cards[0]!.result, 'A-result')
  assert.equal(cards[1]!.args, JSON.stringify({ command: 'b' }))
  assert.equal(cards[1]!.result, 'B-result')
})

test('same-name parallel calls never cross-settle by name or arrival order', () => {
  const messages = fold([
    turnStart(),
    toolCall(1, 'first', 'grep', { pattern: 'first' }),
    toolCall(2, 'second', 'grep', { pattern: 'second' }),
    toolResult(3, 'second', [text('second body')]),
    toolResult(4, 'first', [text('first body')]),
    turnEnd(5),
  ])
  const cards = toolCards(messages)
  assert.equal(cards[0]!.args, JSON.stringify({ pattern: 'first' }))
  assert.equal(cards[0]!.result, 'first body')
  assert.equal(cards[1]!.args, JSON.stringify({ pattern: 'second' }))
  assert.equal(cards[1]!.result, 'second body')
})

test('an empty native V4 result content still completes the card and keeps the error fallback', () => {
  const messages = fold([
    turnStart(),
    toolCall(1, 'c1', 'read'),
    toolResult(2, 'c1', [], { isError: true, error: { name: 'read-failed', code: 'ENOENT' } }),
    turnEnd(3),
  ])
  const card = toolCards(messages)[0]!
  assert.equal(card.status, 'error')
  assert.equal(card.result, '')
  assert.deepEqual(card.resultBlocks, [])
  assert.deepEqual(resultTextLines(card.resultBlocks ?? [], card.error), ['read-failed: ENOENT'])
})

test('multimodal result content keeps its exact block order and text summary', () => {
  const content = [text('before'), IMAGE_BLOCK, FILE_BLOCK, text('after')]
  const messages = fold([
    turnStart(),
    toolCall(1, 'c1', 'screenshot_tool'),
    toolResult(2, 'c1', content),
    turnEnd(3),
  ])
  const card = toolCards(messages)[0]!
  assert.deepEqual(card.resultBlocks, content)
  assert.equal(card.result, 'beforeafter')
  assert.deepEqual(resultTextLines(card.resultBlocks ?? []), ['before', '[image]', '📄 report.pdf · 12.3 KiB', 'after'])
})

test('the Markdown transcript reads the native message.content in order', () => {
  const events = [
    turnStart(),
    toolCall(1, 'c1', 'screenshot_tool'),
    toolResult(2, 'c1', [text('tool before'), FILE_BLOCK, text('tool after')]),
    turnEnd(3),
  ]
  const markdown = renderTranscriptMarkdown({
    header: { id: 'session-v4-tool-result', cwd: '/ws', version: 4, createdAt: 0, isSeeded: false, delegationDepth: 0 },
    snapshotEvents: () => events,
  } as never)
  assert.ok(markdown.includes('tool before'))
  assert.ok(markdown.includes('tool after'))
  assert.ok(markdown.indexOf('tool before') < markdown.indexOf('📄 report.pdf · 12.3 KiB'))
  assert.ok(markdown.indexOf('📄 report.pdf · 12.3 KiB') < markdown.indexOf('tool after'))
})

/** Drive one released-V3 body through the OFFICIAL V3→V4 migration stage. */
function migrateReleasedV3(rows: readonly Record<string, unknown>[]): SessionEvent[] {
  const sourceHeader = { version: 3, id: 'b1-historical-v3', createdAt: 1, cwd: '/ws', isSeeded: false, delegationDepth: 0 }
  const stage = createSessionFormatV3ToV4([]).createStage({
    sourceHeader,
    targetHeader: sessionFormatV3ToV4.migrateHeader(sourceHeader),
    sourceInheritedEventCount: undefined,
    sourceKind: 'decoded',
  })
  const output = new SessionFormatEventCollector()
  for (const row of rows) stage.transformEvent(row as never, output)
  stage.finish(output)
  return output.values as unknown as SessionEvent[]
}

test('historical released V3 results reach the fold only through the official migration', () => {
  const migrated = migrateReleasedV3([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 0, step: 0 } },
    { type: 'tool/call', seq: 2, time: 3, data: { turn: 0, step: 0, callId: 'hist-call-1', name: 'read', arguments: '{}' } },
    {
      type: 'tool/result',
      seq: 3,
      time: 4,
      // Released V3 canonical user-role wrapper — intentionally NOT the
      // current Session shape; only the official migration may lift it.
      data: {
        turn: 0,
        step: 0,
        message: {
          id: 'hist-result-1',
          role: 'user',
          source: { kind: 'tool', callId: 'hist-call-1' },
          content: [{
            type: 'tool-result',
            toolCallId: 'hist-call-1',
            isError: false,
            content: [{ type: 'text', text: 'historical result' }],
          }],
        },
      },
    },
    { type: 'step/end', seq: 4, time: 5, data: { turn: 0, step: 0 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 0, reason: { kind: 'completed' } } },
  ])

  const migratedResult = migrated.find(candidate => candidate.type === 'tool/result')!
  const message = (migratedResult.data as { message: { role: string; toolCallId: string; content: readonly ContentBlock[] } }).message
  assert.equal(message.role, 'tool')
  assert.equal(message.toolCallId, 'hist-call-1')
  assert.deepEqual(message.content, [text('historical result')])

  const card = toolCards(fold(migrated))[0]!
  assert.equal(card.status, 'ok')
  assert.equal(card.result, 'historical result')
  assert.deepEqual(card.resultBlocks, [text('historical result')])
})
