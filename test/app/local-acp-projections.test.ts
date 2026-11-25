/**
 * L1 owner tests for the pure ACP projection rules.
 *
 * These are the conversion, ordering, cursor and capability-gating decisions
 * that do not need a socket, an SDK connection or a Host: they prove exactly
 * what an official DSH fact becomes on the stable ACP v1 wire, and that a fact
 * with no standard v1 form fails closed instead of being silently dropped.
 *
 * @module test/app/local-acp-projections
 */

import assert from 'node:assert/strict'
import { constants as bufferConstants } from 'node:buffer'
import test from 'node:test'
import {
  ACP_SESSION_LIST_CURSOR_MAX,
  ACP_SESSION_LIST_PAGE_SIZE,
  AcpProjectionError,
  compactionUpdate,
  encodeSessionCursor,
  planEntriesFromTodos,
  planRemoval,
  planEntriesOf,
  planIdOf,
  planUpdate,
  projectSessionHistory,
  readSessionListRequest,
  selectSessionPage,
  sessionInfoUpdateOf,
  usageUpdateOf,
  type AcpHistoryEvent,
  type AcpNegotiatedCapabilities,
  type AcpSessionReadRow,
} from '../../src/app/remote-process/local-acp-projections.ts'

/** A connection that negotiated every optional read-only capability. */
const ALL_CAPABILITIES: AcpNegotiatedCapabilities = {
  plan: true,
  compaction: true,
  subagents: true,
  notices: true,
  booleanConfigOptions: false,
}

/** A connection that negotiated none of them (the stable v1 baseline). */
const NO_CAPABILITIES: AcpNegotiatedCapabilities = {
  plan: false,
  compaction: false,
  subagents: false,
  notices: false,
  booleanConfigOptions: false,
}

/** One assistant message event with the given blocks. */
function assistantEvent(seq: number, id: string, content: readonly unknown[]): AcpHistoryEvent {
  return { seq, type: 'assistant/message', data: { message: { id, content } } }
}

/** One user message event; its data IS the official message (id/source/content). */
function userEvent(seq: number, id: string, source: unknown, content: readonly unknown[]): AcpHistoryEvent {
  return { seq, type: 'user/message', data: { id, source, content, role: 'user' } }
}

/** The structural image block of one stored attachment. */
function imageBlock(attachmentId: string): unknown {
  return {
    type: 'image',
    attachment: { attachmentId, mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
  }
}

test('human user messages project as user chunks while injections and question replies never do', () => {
  const units = projectSessionHistory([
    userEvent(0, 'm-human', { kind: 'user' }, [{ type: 'text', text: 'hello' }]),
    userEvent(1, 'm-context', { kind: 'time-context' }, [{ type: 'text', text: 'now 12:00' }]),
    userEvent(2, 'm-skill', { kind: 'skill-invocation' }, [{ type: 'text', text: '<skill/>' }]),
    userEvent(3, 'm-reply', { kind: 'user-question-reply' }, [{ type: 'text', text: 'answer' }]),
  ], NO_CAPABILITIES)
  assert.deepEqual(units, [{
    kind: 'update',
    update: { sessionUpdate: 'user_message_chunk', messageId: 'm-human', content: { type: 'text', text: 'hello' } },
  }])
})

test('the official turn/start reset becomes one plan-reset step, and the removal matches the negotiated shape', () => {
  assert.deepEqual(projectSessionHistory([{ seq: 0, type: 'turn/start', data: { turn: 2 } }], ALL_CAPABILITIES), [
    { kind: 'plan-reset' },
  ])
  assert.deepEqual(planRemoval(true, 'S1'), { sessionUpdate: 'plan_removed', planId: 'dsh-todos:S1' })
  assert.deepEqual(planRemoval(false, 'S1'), { sessionUpdate: 'plan', entries: [] })
})

test('a durable agent-message replays as session_message only for a subagents-capable client', () => {
  const event = userEvent(0, 'am1', { kind: 'agent-message', form: 'relay', senderSessionId: 'SENDER' }, [
    { type: 'text', text: 'the child says hi' },
    imageBlock('img-9'),
  ])
  assert.deepEqual(projectSessionHistory([event], NO_CAPABILITIES), [])
  assert.deepEqual(projectSessionHistory([event], ALL_CAPABILITIES), [{
    kind: 'session-message',
    message: {
      messageId: 'am1',
      senderSessionId: 'SENDER',
      content: [
        { type: 'text', text: 'the child says hi' },
        { type: 'image', ref: { attachmentId: 'img-9', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
      ],
    },
  }])
  // The runtime's settlement account is never child-authored content.
  assert.deepEqual(projectSessionHistory([
    userEvent(1, 'settled', { kind: 'subagent-settled', form: 'notice', summary: 'done', senderSessionId: 'C' }, [
      { type: 'text', text: 'runtime account' },
    ]),
  ], ALL_CAPABILITIES), [])
})

test('assistant messages keep committed block order, skip tool-call blocks and defer images to the Store', () => {
  const units = projectSessionHistory([
    assistantEvent(0, 'a1', [
      { type: 'text', text: 'one' },
      { type: 'reasoning', text: 'thinking' },
      imageBlock('img-1'),
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
      { type: 'text', text: '' },
      { type: 'text', text: 'two' },
    ]),
  ], NO_CAPABILITIES)
  assert.deepEqual(units, [
    { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'one' } } },
    { kind: 'update', update: { sessionUpdate: 'agent_thought_chunk', messageId: 'a1', content: { type: 'text', text: 'thinking' } } },
    {
      kind: 'image',
      image: {
        messageId: 'a1',
        sessionUpdate: 'agent_message_chunk',
        ref: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
      },
    },
    { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'two' } } },
  ])
})

test('tool calls and results project as the standard pair, keeping real arguments and the official error status', () => {
  const units = projectSessionHistory([
    { seq: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' } },
    {
      seq: 1,
      type: 'tool/result',
      data: { message: { toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'boom' }, imageBlock('img-2')] } },
    },
  ], NO_CAPABILITIES)
  assert.deepEqual(units[0], {
    kind: 'update',
    update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash', kind: 'other', status: 'in_progress', rawInput: { cmd: 'ls' } },
  })
  assert.deepEqual(units[1], {
    kind: 'tool-result',
    result: {
      toolCallId: 'c1',
      status: 'failed',
      content: [
        { type: 'text', text: 'boom' },
        { type: 'image', ref: { attachmentId: 'img-2', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
      ],
    },
  })
})

test('malformed model tool arguments stay opaque instead of being dropped', () => {
  const units = projectSessionHistory([
    { seq: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{not json' } },
  ], NO_CAPABILITIES)
  assert.deepEqual((units[0] as { update: { rawInput?: unknown } }).update.rawInput, '{not json')
})

test('an unrepresentable committed block fails the WHOLE history closed', () => {
  assert.throws(
    () => projectSessionHistory([
      userEvent(0, 'm1', { kind: 'user' }, [{ type: 'text', text: 'ok' }]),
      userEvent(1, 'm2', { kind: 'user' }, [{ type: 'audio', data: 'AAAA' }]),
    ], NO_CAPABILITIES),
    (error: unknown) => error instanceof AcpProjectionError && error.code === 'LOCAL_ACP_LOAD_UNSUPPORTED_CONTENT',
  )
})

test('a non-monotonic canonical seq order is refused instead of being resorted', () => {
  for (const events of [
    [userEvent(2, 'm1', { kind: 'user' }, [{ type: 'text', text: 'a' }]), userEvent(2, 'm2', { kind: 'user' }, [{ type: 'text', text: 'b' }])],
    [userEvent(3, 'm1', { kind: 'user' }, [{ type: 'text', text: 'a' }]), userEvent(1, 'm2', { kind: 'user' }, [{ type: 'text', text: 'b' }])],
  ]) {
    assert.throws(
      () => projectSessionHistory(events, NO_CAPABILITIES),
      (error: unknown) => error instanceof AcpProjectionError && error.code === 'LOCAL_ACP_LOAD_INVALID_HISTORY',
    )
  }
})

test('host-internal durable events are never projected as message content', () => {
  const units = projectSessionHistory([
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'system/message', data: { message: { content: [{ type: 'text', text: 'prompt' }] } } },
    { seq: 2, type: 'developer/message', data: { message: { content: [{ type: 'tool-addition', toolName: 'x' }] } } },
    { seq: 3, type: 'session/title', data: { title: 'T', messageSeqs: [], source: 'user' } },
    { seq: 4, type: 'totally-unknown/event', data: {} },
  ], ALL_CAPABILITIES)
  // `turn/start` is the ONLY official plan-reset trigger; everything else in
  // this run projects no message content at all.
  assert.deepEqual(units, [{ kind: 'plan-reset' }])
  assert.deepEqual(projectSessionHistory([
    { seq: 1, type: 'system/message', data: { message: { content: [{ type: 'text', text: 'prompt' }] } } },
    { seq: 2, type: 'developer/message', data: { message: { content: [{ type: 'tool-addition', toolName: 'x' }] } } },
    { seq: 3, type: 'session/title', data: { title: 'T', messageSeqs: [], source: 'user' } },
    { seq: 4, type: 'totally-unknown/event', data: {} },
  ], ALL_CAPABILITIES), [])
})

test('plan projection uses the stable baseline without the client capability and plan_update with it', () => {
  const data = { todos: [{ content: 'one', status: 'pending' }, { content: 'two', status: 'completed' }] }
  const legacy = projectSessionHistory([{ seq: 0, type: 'todo/write', data }], NO_CAPABILITIES)
  assert.deepEqual(legacy, [{
    kind: 'update',
    update: {
      sessionUpdate: 'plan',
      entries: [
        { content: 'one', status: 'pending', priority: 'medium' },
        { content: 'two', status: 'completed', priority: 'medium' },
      ],
    },
  }])
  const negotiated = projectSessionHistory([{ seq: 0, type: 'todo/write', data }], ALL_CAPABILITIES, 'S1')
  assert.deepEqual(negotiated, [{
    kind: 'update',
    update: {
      sessionUpdate: 'plan_update',
      plan: {
        type: 'items',
        planId: planIdOf('S1'),
        entries: [
          { content: 'one', status: 'pending', priority: 'medium' },
          { content: 'two', status: 'completed', priority: 'medium' },
        ],
      },
    },
  }])
})

test('an empty todo snapshot is a real clear and a missing/invalid one sends nothing', () => {
  assert.deepEqual(planEntriesOf({ todos: [] }), [])
  assert.equal(planEntriesOf({ todos: null }), undefined)
  assert.equal(planEntriesOf({}), undefined)
  assert.equal(planEntriesOf({ todos: [{ content: 'x', status: 'blocked' }] }), undefined)
  assert.deepEqual(planUpdate([], false), { sessionUpdate: 'plan', entries: [] })
  assert.deepEqual(planUpdate([], true, 'S1'), {
    sessionUpdate: 'plan_update',
    plan: { type: 'items', planId: 'dsh-todos:S1', entries: [] },
  })
  assert.deepEqual(planEntriesFromTodos([{ content: 'y', status: 'in_progress' }]), [
    { content: 'y', status: 'in_progress', priority: 'medium' },
  ])
  assert.equal(planEntriesFromTodos(null), undefined)
})

test('compaction updates are lifecycle patches keyed by the durable id and gated by the client capability', () => {
  const start: AcpHistoryEvent = { seq: 0, type: 'compaction/start', data: { compactionId: 'c1', turn: null } }
  const summary: AcpHistoryEvent = {
    seq: 1,
    type: 'compaction/summary',
    data: { compactionId: 'c1', summary: [{ type: 'text', text: 'sum' }] },
  }
  const done: AcpHistoryEvent = { seq: 2, type: 'compaction/end', data: { compactionId: 'c1', turn: null } }
  const failed: AcpHistoryEvent = { seq: 3, type: 'compaction/end', data: { compactionId: 'c2', turn: null, error: 'nope' } }
  assert.deepEqual(projectSessionHistory([start, summary, done, failed], NO_CAPABILITIES), [])
  assert.deepEqual(projectSessionHistory([start, summary, done, failed], ALL_CAPABILITIES), [
    { kind: 'update', update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' } },
    { kind: 'update', update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress', summary: [{ type: 'text', text: 'sum' }] } },
    { kind: 'update', update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' } },
    { kind: 'update', update: { sessionUpdate: 'compaction_update', compactionId: 'c2', status: 'failed', error: 'nope' } },
  ])
  assert.equal(compactionUpdate(summary).sessionUpdate, 'compaction_update')
  assert.throws(
    () => compactionUpdate({ seq: 9, type: 'compaction/start', data: {} }),
    (error: unknown) => error instanceof AcpProjectionError && error.code === 'LOCAL_ACP_LOAD_UNSUPPORTED_CONTENT',
  )
})

test('usage projects only a real current occupancy with a positive capacity', () => {
  assert.deepEqual(usageUpdateOf({ projectedTokens: 12, pressureTokens: 10, contextWindow: 100 }), {
    sessionUpdate: 'usage_update',
    used: 12,
    size: 100,
  })
  assert.deepEqual(usageUpdateOf({ pressureTokens: 10, contextWindow: 100 }), {
    sessionUpdate: 'usage_update',
    used: 10,
    size: 100,
  })
  // No capacity, no sample, a non-finite/negative value or a zero capacity
  // NEVER becomes a fabricated 0/100%: the update is omitted.
  assert.equal(usageUpdateOf({ projectedTokens: 12 }), undefined)
  assert.equal(usageUpdateOf({ contextWindow: 100 }), undefined)
  assert.equal(usageUpdateOf({ projectedTokens: -1, contextWindow: 100 }), undefined)
  assert.equal(usageUpdateOf({ projectedTokens: 1, contextWindow: 0 }), undefined)
  assert.equal(usageUpdateOf({ projectedTokens: Number.NaN, contextWindow: 100 }), undefined)
  assert.equal(usageUpdateOf(null), undefined)
})

test('session info patches only the official title and its own durable time', () => {
  assert.deepEqual(sessionInfoUpdateOf({ title: 'Hello' }, 1_700_000_000_000), {
    sessionUpdate: 'session_info_update',
    title: 'Hello',
    updatedAt: new Date(1_700_000_000_000).toISOString(),
  })
  assert.deepEqual(sessionInfoUpdateOf({ title: 'Hello' }), { sessionUpdate: 'session_info_update', title: 'Hello' })
  assert.equal(sessionInfoUpdateOf({ title: '' }, 1), undefined)
  assert.equal(sessionInfoUpdateOf({}, 1), undefined)
})

/** One authorized roster row. */
function row(sessionId: string, updatedAt: number, extra: Partial<AcpSessionReadRow> = {}): AcpSessionReadRow {
  return { sessionId, updatedAt, cwd: '/host/proj', ...extra }
}

test('the roster excludes subagent sessions and rows without a standard absolute cwd', () => {
  const page = selectSessionPage([
    row('root', 10),
    row('child', 20, { origin: 'subagent' }),
    row('no-cwd', 30, { cwd: undefined }),
    row('relative', 40, { cwd: 'proj' }),
  ], {})
  assert.deepEqual(page.sessions.map(session => session.sessionId), ['root'])
  assert.equal(page.sessions[0]?.cwd, '/host/proj')
  assert.equal(page.sessions[0]?.updatedAt, new Date(10).toISOString())
  assert.equal(page.nextCursor, undefined)
})

test('the roster orders by (updatedAt DESC, sessionId UTF8 ASC) and filters by the exact request cwd', () => {
  const page = selectSessionPage([
    row('b', 10),
    row('a', 10),
    row('newest', 30),
    row('other', 20, { cwd: '/host/other' }),
    row('Z', 10),
  ], { cwd: '/host/proj' })
  assert.deepEqual(page.sessions.map(session => session.sessionId), ['newest', 'Z', 'a', 'b'])
})

test('pagination is a strict keyset continuation with a canonical filter-bound cursor', () => {
  const rows = Array.from({ length: ACP_SESSION_LIST_PAGE_SIZE + 3 }, (_, index) =>
    row(`s${String(index).padStart(3, '0')}`, 1_000 - index))
  const first = selectSessionPage(rows, { cwd: '/host/proj' })
  assert.equal(first.sessions.length, ACP_SESSION_LIST_PAGE_SIZE)
  assert.equal(typeof first.nextCursor, 'string')
  const second = selectSessionPage(rows, { cwd: '/host/proj', cursor: first.nextCursor })
  assert.deepEqual(second.sessions.map(session => session.sessionId), ['s050', 's051', 's052'])
  assert.equal(second.nextCursor, undefined, 'the last page carries no cursor')

  // The cursor is bound to its request filter: another cwd can never use it.
  assert.throws(() => selectSessionPage(rows, { cwd: '/host/other', cursor: first.nextCursor }), /cursor/)
  // And the same keyset at a page boundary resumes WITHOUT re-emitting the row.
  const boundary = selectSessionPage([row('a', 5), row('b', 4)], {})
  const cursor = encodeSessionCursor({ updatedAt: 5, sessionId: 'a', cwd: '' })
  assert.deepEqual(selectSessionPage([row('a', 5), row('b', 4)], { cursor }).sessions.map(s => s.sessionId), ['b'])
  assert.equal(boundary.nextCursor, undefined)
})

test('malformed, non-canonical and oversized cursors are refused', () => {
  const rows = [row('a', 5), row('b', 4)]
  const invalid = [
    'not-base64!!',
    Buffer.from(JSON.stringify([5, 'a']), 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify([5, '', '']), 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify([-1, 'a', '']), 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify([5.5, 'a', '']), 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify([5, 'a', '', 'extra']), 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify([5, 'a', '']), 'utf8').toString('base64').replaceAll('+', '-'),
    'A'.repeat(ACP_SESSION_LIST_CURSOR_MAX + 1),
  ]
  for (const cursor of invalid) {
    assert.throws(() => selectSessionPage(rows, { cursor }), /cursor/u, `cursor ${cursor.slice(0, 24)} must be refused`)
  }
  // A well-formed but non-canonical JSON spelling is refused too.
  const canonical = encodeSessionCursor({ updatedAt: 5, sessionId: 'a', cwd: '' })
  const spaced = Buffer.from('[5, "a", ""]', 'utf8').toString('base64url')
  assert.notEqual(spaced, canonical)
  assert.throws(() => selectSessionPage(rows, { cursor: spaced }), /cursor/u)
})

test('the list request accepts an omitted/null filter and refuses a relative cwd', () => {
  assert.deepEqual(readSessionListRequest({}), {})
  assert.deepEqual(readSessionListRequest({ cwd: null, cursor: null }), {})
  assert.deepEqual(readSessionListRequest({ cwd: '/host/proj' }), { cwd: '/host/proj' })
  assert.throws(() => readSessionListRequest({ cwd: 'proj' }), /absolute/u)
  assert.throws(() => readSessionListRequest({ cwd: '/host/\u0000proj' }), /absolute/u)
})

// ---------------------------------------------------------------------------
// PR4D: generic committed file content projects as standard resource steps.
// ---------------------------------------------------------------------------

/** One official durable file content-addressed id. */
const FILE_ID = `sha256:${'a'.repeat(64)}`
/** A second official durable file id (a distinct digest). */
const FILE_ID_B = `sha256:${'b'.repeat(64)}`
/** The canonical stored leaf name (space and CJK must be percent-encoded). */
const FILE_NAME = 'PR4D 附件.bin'

/** One committed generic file block naming a structural official file reference. */
function fileBlock(attachmentId = FILE_ID, name = FILE_NAME, bytes = 6): unknown {
  return { type: 'file', attachment: { attachmentId, name, bytes } }
}

test('human, assistant, tool and negotiated agent-message file blocks project ordered file steps', () => {
  const units = projectSessionHistory([
    userEvent(0, 'm-user-file', { kind: 'user' }, [
      { type: 'text', text: 'before' },
      fileBlock(),
      { type: 'text', text: 'after' },
    ]),
    assistantEvent(1, 'm-assistant-file', [fileBlock()]),
    {
      seq: 2,
      type: 'tool/result',
      data: { message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'tool' }, fileBlock()] } },
    },
    userEvent(3, 'am-file', { kind: 'agent-message', form: 'relay', senderSessionId: 'SENDER' }, [fileBlock()]),
  ], ALL_CAPABILITIES, 'S1', 64)
  assert.deepEqual(units, [
    { kind: 'update', update: { sessionUpdate: 'user_message_chunk', messageId: 'm-user-file', content: { type: 'text', text: 'before' } } },
    {
      kind: 'file',
      file: {
        messageId: 'm-user-file',
        sessionUpdate: 'user_message_chunk',
        ref: { attachmentId: FILE_ID, name: FILE_NAME, bytes: 6 },
      },
    },
    { kind: 'update', update: { sessionUpdate: 'user_message_chunk', messageId: 'm-user-file', content: { type: 'text', text: 'after' } } },
    {
      kind: 'file',
      file: {
        messageId: 'm-assistant-file',
        sessionUpdate: 'agent_message_chunk',
        ref: { attachmentId: FILE_ID, name: FILE_NAME, bytes: 6 },
      },
    },
    {
      kind: 'tool-result',
      result: {
        toolCallId: 'c1',
        status: 'completed',
        content: [
          { type: 'text', text: 'tool' },
          { type: 'file', ref: { attachmentId: FILE_ID, name: FILE_NAME, bytes: 6 } },
        ],
      },
    },
    {
      kind: 'session-message',
      message: {
        messageId: 'am-file',
        senderSessionId: 'SENDER',
        content: [{ type: 'file', ref: { attachmentId: FILE_ID, name: FILE_NAME, bytes: 6 } }],
      },
    },
  ])
})

test('a malformed committed file reference stays unsupported content, never a guessed file', () => {
  const malformed: unknown[] = [
    { type: 'file', attachment: { attachmentId: 'f', name: 'a.txt', bytes: 1 } },
    { type: 'file', attachment: { attachmentId: `sha256:${'A'.repeat(64)}`, name: 'a.txt', bytes: 1 } },
    { type: 'file', attachment: { attachmentId: FILE_ID, name: '', bytes: 1 } },
    { type: 'file', attachment: { attachmentId: FILE_ID, name: 'a.txt', bytes: -1 } },
    { type: 'file', attachment: { attachmentId: FILE_ID, name: 'a.txt', bytes: 1.5 } },
    { type: 'file', attachment: { attachmentId: FILE_ID, name: 'a.txt', bytes: '1' } },
    { type: 'file', attachment: { attachmentId: FILE_ID, name: 'a.txt' } },
  ]
  for (const block of malformed) {
    assert.throws(
      () => projectSessionHistory([assistantEvent(0, 'a1', [block])], NO_CAPABILITIES),
      (error: unknown) => error instanceof AcpProjectionError && error.code === 'LOCAL_ACP_LOAD_UNSUPPORTED_CONTENT',
      `a malformed file reference must fail closed: ${JSON.stringify(block)}`,
    )
  }
})

test('the per-event file budget is exact, counts every occurrence and requires a bound', () => {
  const threeBytes = 3
  const encodedThree = 4
  // 6 bytes -> 8 Base64 characters: cap 7 is over, cap 8 is exact.
  assert.throws(
    () => projectSessionHistory([assistantEvent(0, 'a1', [fileBlock(FILE_ID, FILE_NAME, 6)])], NO_CAPABILITIES, '', 7),
    (error: unknown) => error instanceof AcpProjectionError && error.code === 'LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE',
  )
  const exact = projectSessionHistory([assistantEvent(0, 'a1', [fileBlock(FILE_ID, FILE_NAME, 6)])], NO_CAPABILITIES, '', 8)
  assert.equal(exact.length, 1, 'an event exactly at the cap passes preflight')
  // Two 3-byte occurrences cost 4 + 4 characters; a repeated ref is two costs.
  assert.throws(
    () => projectSessionHistory([assistantEvent(0, 'a1', [
      fileBlock(FILE_ID_B, 'one.bin', threeBytes),
      fileBlock(FILE_ID_B, 'one.bin', threeBytes),
    ])], NO_CAPABILITIES, '', 2 * encodedThree - 1),
    (error: unknown) => error instanceof AcpProjectionError && error.code === 'LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE',
  )
  const sum = projectSessionHistory([assistantEvent(0, 'a1', [
    fileBlock(FILE_ID_B, 'one.bin', threeBytes),
    fileBlock(FILE_ID_B, 'two.bin', threeBytes),
  ])], NO_CAPABILITIES, '', 2 * encodedThree)
  assert.equal(sum.length, 2)
  // A file-bearing event with NO connection budget is refused instead of
  // reading an unbounded stream; a text-only event needs no budget.
  assert.throws(
    () => projectSessionHistory([assistantEvent(0, 'a1', [fileBlock()])], NO_CAPABILITIES),
    (error: unknown) => error instanceof AcpProjectionError && error.code === 'LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE',
  )
  assert.deepEqual(
    projectSessionHistory([assistantEvent(0, 'a1', [{ type: 'text', text: 'no files' }])], NO_CAPABILITIES),
    [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'no files' } } }],
  )
})

test('PR4D R1: an encoded blob above the runtime single-string capacity is refused before any read', () => {
  // 400 MiB has a canonical Base64 length of 559,240,536, above V8's
  // MAX_STRING_LENGTH (536,870,888) but below the image-derived frame budget.
  // Nothing is allocated: this is the declared metadata preflight.
  const declaredBytes = 400 * 1024 * 1024
  assert.ok(4 * Math.ceil(declaredBytes / 3) > bufferConstants.MAX_STRING_LENGTH)
  assert.throws(
    () => projectSessionHistory(
      [assistantEvent(0, 'a-big', [fileBlock(FILE_ID, 'big.bin', declaredBytes)])],
      NO_CAPABILITIES, '', 2_000_000_000,
    ),
    (error: unknown) => error instanceof AcpProjectionError && error.code === 'LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE',
  )
})

test('PR4D R1: one single-frame tool result charges the SUM of its representable blobs', () => {
  // Each blob alone fits one JS string; a tool result puts both in ONE update.
  const each = 300_000_000
  assert.ok(4 * Math.ceil(each / 3) < bufferConstants.MAX_STRING_LENGTH)
  const blocks = [fileBlock(FILE_ID, 'one.bin', each), fileBlock(FILE_ID_B, 'two.bin', each)]
  // Separate assistant chunks are separate frames: each blob is representable.
  assert.equal(projectSessionHistory(
    [assistantEvent(0, 'a-two', blocks)], NO_CAPABILITIES, '', 2_000_000_000,
  ).length, 2)
  // The tool result serializes both blobs into ONE string and must be refused.
  assert.throws(
    () => projectSessionHistory(
      [{ seq: 0, type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false, content: blocks } } }],
      NO_CAPABILITIES, '', 2_000_000_000,
    ),
    (error: unknown) => error instanceof AcpProjectionError && error.code === 'LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE',
  )
})

test('PR4D R2: an inter-agent file is never charged before official lineage is proven', () => {
  // The pure conversion cannot prove lineage, so it must not charge the file:
  // the View does that after the official header proof. A forged author with a
  // huge file therefore yields a structural unit, not a size rejection.
  const declaredBytes = 400 * 1024 * 1024
  const units = projectSessionHistory(
    [userEvent(0, 'am-big', { kind: 'agent-message', form: 'relay', senderSessionId: 'SENDER' }, [
      fileBlock(FILE_ID, 'big.bin', declaredBytes),
    ])],
    ALL_CAPABILITIES, '', 8,
  )
  assert.deepEqual(units.map(unit => unit.kind), ['session-message'])
})
