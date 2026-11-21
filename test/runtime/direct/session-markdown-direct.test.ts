/**
 * L1/L2 Direct Session Markdown Port tests (S5-PR3 official Markdown export).
 *
 * L1 pins the OFFICIAL format contract: the adapter's bytes are the locked
 * `formatSessionMarkdown` output over the SAME Host Session Query snapshot —
 * title, user blockquote, collapsible previous-message/tool activity, final
 * answer, attachment labels, replacement exclusion, reasoning/system/injected
 * exclusion, UTF-8, exactly one trailing LF and the optional source path. The
 * upstream formatter is the oracle; no local formatter may reappear.
 *
 * L2 pins the Direct refusal classification: absent service → `unavailable`,
 * official stable not-found code → `none`, every other read/stat/abort
 * failure → reject (never empty success), with no Agent/Session creation.
 *
 * @module @xmoon76/dsh-pi-tui/session-markdown-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { formatSessionMarkdown } from '@deepseek-ai/dsh-session-log-export'
import { DirectSessionMarkdown } from '../../../src/runtime/direct/session-markdown-direct.ts'

const SESSION = 'session-s5-pr3'

/** Build one structurally valid Session event fixture (the official type is
 *  merge-extensible; the formatter reads only these fields). */
function ev(type: string, data: unknown, extra: Record<string, unknown> = {}): SessionEvent {
  return { type, seq: 0, time: 1, data, ...extra } as unknown as SessionEvent
}

/** A complete committed turn: user question, assistant commentary, one tool
 *  call/result, then the final assistant answer. */
function richEvents(): SessionEvent[] {
  return [
    ev('session/title', { title: 'S5 PR3 计划 🙂' }),
    ev('turn/start', { turn: 0 }),
    ev('user/message', {
      id: 'u1',
      role: 'user',
      content: [
        { type: 'text', text: '请检查 汉字 🙂' },
        { type: 'image', attachment: { attachmentId: 'att-img', mediaType: 'image/png', bytes: 10, width: 64, height: 32, name: 'shot.png' } },
        { type: 'file', attachment: { attachmentId: 'sha256:abc', name: 'report.pdf', mediaType: 'application/pdf', bytes: 12 } },
      ],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' }),
    ev('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: 'I will check the log.' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }, { surfaceOp: 'append' }),
    ev('tool/call', { turn: 0, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }),
    ev('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: 'r1',
        role: 'tool',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'file-a\nfile-b' }],
        isError: false,
        source: { kind: 'tool', callId: 'call-1' },
      },
    }, { surfaceOp: 'append' }),
    ev('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: 'a2',
        role: 'assistant',
        content: [{ type: 'text', text: '最终答案 🚀' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }, { surfaceOp: 'append' }),
    ev('turn/end', { turn: 0, reason: { kind: 'completed' } }),
  ]
}

/** A fake Host context carrying only the two official services. */
function hostContext(services: {
  sessionQuery?: unknown
  sessionPersistence?: unknown
}): { get(name: string): unknown } {
  const values = new Map<string, unknown>([
    ['sessionQuery', services.sessionQuery],
    ['sessionPersistence', services.sessionPersistence],
  ].filter(([, value]) => value !== undefined) as Array<[string, unknown]>)
  return { get: (name: string) => values.get(name) }
}

function notFoundError(): Error & { code: string } {
  return Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
}

test('L1: the Direct read is byte-identical to the official formatter over the same snapshot', async () => {
  const events = richEvents()
  const reads: string[] = []
  const adapter = new DirectSessionMarkdown(hostContext({
    sessionQuery: {
      readSession: async (id: unknown) => {
        reads.push(String(id))
        return { events }
      },
    },
    sessionPersistence: { stat: async () => ({ location: { path: '/host/sessions/session-s5-pr3.jsonl' } }) },
  }))
  const read = await adapter.read(SESSION)
  assert.deepEqual(reads, [SESSION], 'the adapter reads the requested Session by id')
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  assert.equal(read.markdown, formatSessionMarkdown(events, '/host/sessions/session-s5-pr3.jsonl'),
    'the returned bytes are the official formatter output — never a local reconstruction')
  // Explicit official-contract facts (not merely oracle equality):
  assert.match(read.markdown, /^# S5 PR3 计划 🙂\n/u, 'the LAST session/title supplies the heading')
  assert.match(read.markdown, /Session file:/u, 'the Host artifact path is emitted in the official source block')
  assert.match(read.markdown, /\/host\/sessions\/session-s5-pr3\.jsonl/u)
  assert.match(read.markdown, /> 请检查 汉字 🙂/u, 'the human user message is a blockquote')
  assert.match(read.markdown, /\[Image: shot\.png \(64×32, 10 bytes\)\]/u, 'the image is a readable label, never bytes')
  assert.match(read.markdown, /\[File: report\.pdf \(12 bytes\)\]/u, 'the file is a readable label, never bytes')
  assert.match(read.markdown, /<details><summary>2 previous messages<\/summary>/u,
    'pre-final commentary and tool activity collapse into one details block')
  assert.match(read.markdown, /\*\*Tool: `bash`\*\*/u, 'the official tool heading')
  assert.match(read.markdown, /最终答案 🚀/u, 'the final answer stays plain Markdown')
  assert.equal(read.markdown.endsWith('\n'), true)
  assert.equal(read.markdown.endsWith('\n\n'), false, 'exactly one trailing LF')
  assert.match(read.markdown, /汉字/u)
  assert.match(read.markdown, /🙂/u)
})

test('L1: reasoning, system/developer and injected context never enter the official Markdown', async () => {
  const events: SessionEvent[] = [
    ev('session/title', { title: 'hidden material' }),
    ev('turn/start', { turn: 0 }),
    ev('user/message', {
      id: 'sys',
      role: 'user',
      content: [{ type: 'text', text: 'INJECTED CONTEXT SHOULD NOT APPEAR' }],
      source: { kind: 'system-prompt' },
    }, { surfaceOp: 'append' }),
    ev('system/message', {
      id: 'system-1',
      role: 'system',
      content: [{ type: 'text', text: 'SYSTEM PROMPT SHOULD NOT APPEAR' }],
      source: { kind: 'system-prompt' },
    }),
    ev('developer/message', {
      id: 'developer-1',
      role: 'developer',
      content: [{ type: 'text', text: 'DEVELOPER NOTE SHOULD NOT APPEAR' }],
      source: { kind: 'system-prompt' },
    }),
    ev('assistant/attempt', {
      turn: 0,
      step: 0,
      stream: [{ type: 'chunk', time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'REASONING SHOULD NOT APPEAR' } }],
    }),
    ev('user/message', {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: 'VISIBLE QUESTION' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' }),
    ev('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: 'VISIBLE ANSWER' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, { surfaceOp: 'append' }),
    ev('turn/end', { turn: 0, reason: { kind: 'completed' } }),
  ]
  const adapter = new DirectSessionMarkdown(hostContext({
    sessionQuery: { readSession: async () => ({ events }) },
  }))
  const read = await adapter.read(SESSION)
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  assert.match(read.markdown, /VISIBLE QUESTION/u)
  assert.match(read.markdown, /VISIBLE ANSWER/u)
  for (const hidden of [
    'INJECTED CONTEXT SHOULD NOT APPEAR',
    'SYSTEM PROMPT SHOULD NOT APPEAR',
    'DEVELOPER NOTE SHOULD NOT APPEAR',
    'REASONING SHOULD NOT APPEAR',
  ]) {
    assert.doesNotMatch(read.markdown, new RegExp(hidden, 'u'), `"${hidden}" must be excluded by the official boundary`)
  }
})

test('L1: a surface replacement is never replayed and the append-origin result stays', async () => {
  const events: SessionEvent[] = [
    ev('session/title', { title: 'replacement' }),
    ev('turn/start', { turn: 0 }),
    ev('user/message', {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: 'run it' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' }),
    ev('tool/call', { turn: 0, step: 0, callId: 'call-1', name: 'bash', arguments: '{}' }),
    ev('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: 'r1',
        role: 'tool',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'ORIGINAL RESULT' }],
        isError: false,
        source: { kind: 'tool', callId: 'call-1' },
      },
    }, { surfaceOp: 'append' }),
    ev('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: 'r2',
        role: 'tool',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'PRUNED RESULT' }],
        isError: false,
        source: { kind: 'tool', callId: 'call-1' },
      },
    }, { surfaceOp: { op: 'replace', start: 1, end: 1 } }),
    ev('turn/end', { turn: 0, reason: { kind: 'completed' } }),
  ]
  const adapter = new DirectSessionMarkdown(hostContext({
    sessionQuery: { readSession: async () => ({ events }) },
  }))
  const read = await adapter.read(SESSION)
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  assert.match(read.markdown, /ORIGINAL RESULT/u, 'the append-origin result renders')
  assert.doesNotMatch(read.markdown, /PRUNED RESULT/u, 'the replacement never renders')
})

test('L1: no metadata path means no Session file block (an empty log still has a heading)', async () => {
  const adapter = new DirectSessionMarkdown(hostContext({
    sessionQuery: { readSession: async () => ({ events: [] }) },
    sessionPersistence: { stat: async () => undefined },
  }))
  const read = await adapter.read(SESSION)
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  assert.equal(read.markdown, formatSessionMarkdown([], undefined))
  assert.equal(read.markdown, '# Untitled Session\n', 'the official empty-session result is kept verbatim')
  assert.doesNotMatch(read.markdown, /Session file:/u)
})

test('L2: a missing sessionQuery service is unavailable (never an empty transcript)', async () => {
  const adapter = new DirectSessionMarkdown(hostContext({}))
  assert.deepEqual(await adapter.read(SESSION), { kind: 'unavailable' })
})

test('L2: the official not-found code is none; any other code is a real failure', async () => {
  const notFound = new DirectSessionMarkdown(hostContext({
    sessionQuery: { readSession: async () => { throw notFoundError() } },
  }))
  assert.deepEqual(await notFound.read(SESSION), { kind: 'none' })

  const otherCode = new DirectSessionMarkdown(hostContext({
    sessionQuery: {
      readSession: async () => {
        throw Object.assign(new Error('query failed'), { code: 'SESSION_QUERY_INTERNAL' })
      },
    },
  }))
  await assert.rejects(otherCode.read(SESSION), /query failed/u,
    'an unrelated machine code is never collapsed to none')

  const plainFailure = new DirectSessionMarkdown(hostContext({
    sessionQuery: { readSession: async () => { throw new Error('disk failed') } },
  }))
  await assert.rejects(plainFailure.read(SESSION), /disk failed/u)
})

test('L2: a stat failure rejects with the real error (never silently drops the source path)', async () => {
  const adapter = new DirectSessionMarkdown(hostContext({
    sessionQuery: { readSession: async () => ({ events: [] }) },
    sessionPersistence: {
      stat: async () => { throw new Error('stat unavailable') },
    },
  }))
  await assert.rejects(adapter.read(SESSION), /stat unavailable/u)
})

test('L2: abort before the read and after the query read is honoured, with no fabricated result', async () => {
  let reads = 0
  const before = new AbortController()
  before.abort()
  const adapter = new DirectSessionMarkdown(hostContext({
    sessionQuery: {
      readSession: async () => {
        reads += 1
        return { events: [] }
      },
    },
  }))
  await assert.rejects(adapter.read(SESSION, before.signal),
    error => error instanceof Error && error.name === 'AbortError')
  assert.equal(reads, 0, 'a pre-aborted read never reaches the Host')

  const after = new AbortController()
  const abortingAdapter = new DirectSessionMarkdown(hostContext({
    sessionQuery: {
      readSession: async () => {
        after.abort()
        return { events: [] }
      },
    },
    sessionPersistence: {
      stat: async () => { throw new Error('the post-query abort must win before stat') },
    },
  }))
  await assert.rejects(abortingAdapter.read(SESSION, after.signal),
    error => error instanceof Error && error.name === 'AbortError',
    'an abort observed after the query read rejects instead of returning a result')
})
