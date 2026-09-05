/**
 * Direct adapter contract tests for the live assistant stream seam (Session
 * v2): official `agent/assistant-stream` frames carry turn/step ONLY on
 * `start` — a chunk/end names its attempt, and the adapter resolves
 * turn/step through per-Agent attempt state. These tests build the frames
 * EXACTLY as upstream `AssistantStreamAttempt` emits them (no invented
 * fields) and pin the ordering guards (dense revision, dense index),
 * the Agent-object identity fence, and the committed/abandoned settlement
 * vocabulary.
 * @module @xmoon76/dsh-pi-tui/assistant-stream-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  installAssistantStreamDirect,
  type AssistantStreamFrameLike,
} from '../src/runtime/direct/assistant-stream-direct.ts'
import type { AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'

/** A minimal current Agent object (the identity fence compares OBJECTS). */
function agent(id: string): { id: string; session: { id: string } } {
  return { id, session: { id: `session-${id}` } }
}

interface Sink {
  inputs: AssistantLiveInput[]
  onInput(input: AssistantLiveInput): void
}

function makeSink(): Sink {
  const sink: Sink = { inputs: [], onInput: () => {} }
  sink.onInput = (input) => sink.inputs.push(input)
  return sink
}

/** One upstream-shaped frame sequence helper: installs the adapter over a
 * current-agent predicate and returns { emit, sink, dispose }. */
function harness(accept: (subject: unknown) => boolean): { emit: (agent: unknown, frame: AssistantStreamFrameLike) => void; sink: Sink; dispose: () => void } {
  const sink = makeSink()
  let listener: ((payload: unknown) => void) | undefined
  const ctx = {
    on: (_event: string, handler: (payload: unknown) => void) => {
      listener = handler
      return () => { listener = undefined }
    },
  }
  const dispose = installAssistantStreamDirect({ ctx, isCurrentAgent: accept, onInput: sink.onInput })
  return {
    emit: (subject, frame) => { listener?.({ agent: subject, frame }) },
    sink,
    dispose,
  }
}

/** Upstream frame builders — the shapes master emits (see
 * AssistantStreamAttempt.start/push/settle in @deepseek-ai/dsh-agent-loop). */
let revision = 0
function nextRevision(): number { return ++revision }
test.beforeEach(() => { revision = 0 })

function startFrame(attemptId: string, turn: number, step: number): AssistantStreamFrameLike {
  return { type: 'start', attemptId, revision: nextRevision(), turn, step }
}

function chunkFrame(attemptId: string, index: number, chunk: unknown): AssistantStreamFrameLike {
  return { type: 'chunk', attemptId, revision: nextRevision(), index, time: 1_700_000_000_000 + index, chunk }
}

function textChunk(index: number, text: string): unknown {
  return { type: 'text-delta', index, text }
}

function committedEnd(attemptId: string, chunkCount: number, eventType: 'assistant/message' | 'assistant/attempt'): AssistantStreamFrameLike {
  return { type: 'end', attemptId, revision: nextRevision(), index: chunkCount, outcome: { kind: 'committed', eventType, seq: 7 } }
}

function abandonedEnd(attemptId: string, chunkCount: number): AssistantStreamFrameLike {
  return { type: 'end', attemptId, revision: nextRevision(), index: chunkCount, outcome: { kind: 'abandoned' } }
}

test('chunk and end frames carry NO turn/step upstream; the adapter resolves them from the attempt', () => {
  const current = agent('a')
  const { emit, sink, dispose } = harness(subject => subject === current)
  try {
    emit(current, startFrame('a1', 3, 1))
    // Upstream chunk shape: attemptId/revision/index/time/chunk — no turn/step.
    emit(current, chunkFrame('a1', 0, textChunk(0, 'hello ')))
    emit(current, chunkFrame('a1', 1, textChunk(1, 'world')))
    emit(current, committedEnd('a1', 2, 'assistant/message'))
    assert.equal(sink.inputs.length, 4)
    assert.deepEqual(sink.inputs[0], { kind: 'start', sessionId: 'session-a', attemptId: 'a1', turn: 3, step: 1 })
    assert.deepEqual(sink.inputs[1], {
      kind: 'chunk', sessionId: 'session-a', attemptId: 'a1', turn: 3, step: 1,
      time: 1_700_000_000_000, chunk: { type: 'text-delta', index: 0, text: 'hello ' },
    })
    assert.deepEqual(sink.inputs[2], {
      kind: 'chunk', sessionId: 'session-a', attemptId: 'a1', turn: 3, step: 1,
      time: 1_700_000_000_001, chunk: { type: 'text-delta', index: 1, text: 'world' },
    })
    assert.deepEqual(sink.inputs[3], {
      kind: 'end', sessionId: 'session-a', attemptId: 'a1', turn: 3, step: 1,
      status: 'committed', settlement: 'message',
    })
  } finally {
    dispose()
  }
})

test('a committed assistant/attempt end names its settlement; an abandoned end carries none', () => {
  const current = agent('b')
  const { emit, sink, dispose } = harness(subject => subject === current)
  try {
    emit(current, startFrame('b1', 1, 0))
    emit(current, chunkFrame('b1', 0, textChunk(0, 'partial')))
    emit(current, committedEnd('b1', 1, 'assistant/attempt'))
    const attemptEnd = sink.inputs.at(-1)
    assert.equal(attemptEnd?.kind, 'end')
    assert.equal((attemptEnd as { status: string }).status, 'committed')
    assert.equal((attemptEnd as { settlement?: string }).settlement, 'attempt')

    emit(current, startFrame('b2', 1, 0))
    emit(current, chunkFrame('b2', 0, textChunk(0, 'again')))
    emit(current, abandonedEnd('b2', 1))
    const abandoned = sink.inputs.at(-1)
    assert.equal(abandoned?.kind, 'end')
    assert.equal((abandoned as { status: string }).status, 'abandoned')
    assert.equal((abandoned as { settlement?: string }).settlement, undefined)
  } finally {
    dispose()
  }
})

test('a chunk or end without an open attempt (missed start, after end, unknown attempt) is dropped', () => {
  const current = agent('c')
  const { emit, sink, dispose } = harness(subject => subject === current)
  try {
    emit(current, { type: 'chunk', attemptId: 'orphan', revision: 1, index: 0, time: 1, chunk: textChunk(0, 'orphan') })
    emit(current, { type: 'end', attemptId: 'orphan', revision: 2, index: 0, outcome: { kind: 'abandoned' } })
    emit(current, { type: 'start', attemptId: 'c1', revision: 3, turn: 1, step: 0 })
    emit(current, { type: 'chunk', attemptId: 'c1', revision: 4, index: 0, time: 2, chunk: textChunk(0, 'ok') })
    emit(current, { type: 'end', attemptId: 'c1', revision: 5, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 7 } })
    emit(current, { type: 'chunk', attemptId: 'c1', revision: 6, index: 1, time: 3, chunk: textChunk(1, 'late') }) // after end
    assert.equal(sink.inputs.length, 3, 'only the complete attempt flows')
  } finally {
    dispose()
  }
})

test('a non-dense chunk index clears the attempt but not the Agent revision clock', () => {
  const current = agent('d')
  const { emit, sink, dispose } = harness(subject => subject === current)
  try {
    emit(current, { type: 'start', attemptId: 'd1', revision: 1, turn: 2, step: 0 })
    emit(current, { type: 'chunk', attemptId: 'd1', revision: 2, index: 0, time: 1, chunk: textChunk(0, 'first') })
    // Skipped index (2 instead of 1): consume rev 3, clear d1, and drop it.
    emit(current, { type: 'chunk', attemptId: 'd1', revision: 3, index: 2, time: 2, chunk: textChunk(2, 'gap') })
    emit(current, { type: 'chunk', attemptId: 'd1', revision: 4, index: 1, time: 3, chunk: textChunk(1, 'stale d1') })
    emit(current, { type: 'end', attemptId: 'd1', revision: 5, index: 1, outcome: { kind: 'abandoned' } })
    // The Agent clock kept moving, so a fresh attempt at rev 6 is accepted.
    emit(current, { type: 'start', attemptId: 'd2', revision: 6, turn: 2, step: 0 })
    emit(current, { type: 'chunk', attemptId: 'd2', revision: 7, index: 0, time: 4, chunk: textChunk(0, 'recovered') })
    emit(current, { type: 'end', attemptId: 'd2', revision: 8, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 7 } })
    const texts = sink.inputs.filter(input => input.kind === 'chunk').map(input => (input as { chunk: { text: string } }).chunk.text)
    assert.deepEqual(texts, ['first', 'recovered'], 'a bad attempt does not freeze later revisions')
  } finally {
    dispose()
  }
})

test('a revision gap clears open attempts, consumes dropped frames, and recovers', () => {
  const current = agent('gap')
  const { emit, sink, dispose } = harness(subject => subject === current)
  try {
    emit(current, { type: 'start', attemptId: 'a', revision: 1, turn: 0, step: 0 })
    emit(current, { type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 1, chunk: textChunk(0, 'A') })
    // Rev 3 is missing: the gap frame is dropped and A is no longer open.
    emit(current, { type: 'start', attemptId: 'b', revision: 4, turn: 0, step: 0 })
    // B has no accepted start, but its structurally-valid frames still
    // consume revisions so the next real start can recover at rev 7.
    emit(current, { type: 'chunk', attemptId: 'b', revision: 5, index: 0, time: 2, chunk: textChunk(0, 'dropped B') })
    emit(current, { type: 'end', attemptId: 'b', revision: 6, index: 1, outcome: { kind: 'abandoned' } })
    emit(current, { type: 'start', attemptId: 'c', revision: 7, turn: 0, step: 0 })
    emit(current, { type: 'chunk', attemptId: 'c', revision: 8, index: 0, time: 3, chunk: textChunk(0, 'C') })
    emit(current, { type: 'end', attemptId: 'c', revision: 9, index: 1, outcome: { kind: 'abandoned' } })
    assert.deepEqual(sink.inputs.map(input => input.kind), ['start', 'chunk', 'start', 'chunk', 'end'])
    assert.deepEqual(sink.inputs.filter(input => input.kind === 'chunk').map(input => (input as { chunk: { text: string } }).chunk.text), ['A', 'C'])
  } finally {
    dispose()
  }
})

test('control chunks are forwarded while dense indexes remain authoritative', () => {
  const current = agent('e')
  const { emit, sink, dispose } = harness(subject => subject === current)
  try {
    emit(current, startFrame('e1', 0, 0))
    emit(current, chunkFrame('e1', 0, { type: 'block-start', index: 0, blockType: 'reasoning' })) // unconsumed kind
    emit(current, chunkFrame('e1', 1, textChunk(1, 'after block-start')))
    emit(current, chunkFrame('e1', 2, { type: 'finish', reason: { kind: 'stop' } })) // unconsumed kind
    emit(current, chunkFrame('e1', 3, textChunk(3, 'tail')))
    emit(current, committedEnd('e1', 4, 'assistant/message'))
    const chunks = sink.inputs.filter(input => input.kind === 'chunk').map(input => (input as { chunk: { type: string; text?: string } }).chunk)
    assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'finish', 'text-delta'])
    assert.deepEqual(chunks.map(chunk => chunk.text), [undefined, 'after block-start', undefined, 'tail'])
    assert.deepEqual(chunks.map(chunk => (chunk as { index?: number }).index), [0, 1, undefined, 3], 'index slots remain authoritative')
  } finally {
    dispose()
  }
})

test('block-end keeps the complete block and control payload fields', () => {
  const current = agent('payload')
  const { emit, sink, dispose } = harness(subject => subject === current)
  try {
    emit(current, startFrame('payload-1', 0, 0))
    const block = {
      type: 'tool-call',
      id: 'call-1',
      name: 'edit',
      arguments: '{"path":"file"}',
      providerMetadata: { traceId: 'trace-1' },
    }
    emit(current, chunkFrame('payload-1', 0, { type: 'block-end', index: 0, block }))
    emit(current, chunkFrame('payload-1', 1, {
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, reasoningTokens: 2 },
    }))
    emit(current, chunkFrame('payload-1', 2, { type: 'finish', reason: { kind: 'tool-calls' }, replayState: 'complete' }))
    const chunks = sink.inputs.filter(input => input.kind === 'chunk').map(input => input.chunk)
    assert.deepEqual(chunks, [
      { type: 'block-end', index: 0, block },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, reasoningTokens: 2 } },
      { type: 'finish', reason: { kind: 'tool-calls' }, replayState: 'complete' },
    ])
  } finally {
    dispose()
  }
})

test('the identity fence is EXACT Agent object identity: a retired agent is refused even for the same session', () => {
  const current = agent('f')
  const retired = agent('f') // same session id, DIFFERENT object
  assert.notEqual(current, retired)
  const { emit, sink, dispose } = harness(subject => subject === current)
  try {
    emit(retired, startFrame('f1', 1, 0))
    emit(retired, chunkFrame('f1', 0, textChunk(0, 'stale stream')))
    emit(retired, committedEnd('f1', 1, 'assistant/message'))
    emit(current, { type: 'start', attemptId: 'f1', revision: 1, turn: 1, step: 0 })
    emit(current, { type: 'chunk', attemptId: 'f1', revision: 2, index: 0, time: 1, chunk: textChunk(0, 'current stream') })
    emit(current, { type: 'end', attemptId: 'f1', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 7 } })
    const texts = sink.inputs.filter(input => input.kind === 'chunk').map(input => (input as { chunk: { text: string } }).chunk.text)
    assert.deepEqual(texts, ['current stream'], 'only the exact current Agent object flows')
  } finally {
    dispose()
  }
})

test('two live Agents (main + viewed child) keep separate revision and attempt state', () => {
  const main = agent('m')
  const child = agent('k')
  const { emit, sink, dispose } = harness(subject => subject === main || subject === child)
  try {
    emit(main, { type: 'start', attemptId: 'm1', revision: 1, turn: 5, step: 0 })
    emit(child, { type: 'start', attemptId: 'k1', revision: 1, turn: 1, step: 0 })
    emit(main, { type: 'chunk', attemptId: 'm1', revision: 2, index: 0, time: 1, chunk: textChunk(0, 'main text') })
    emit(child, { type: 'chunk', attemptId: 'k1', revision: 2, index: 0, time: 1, chunk: textChunk(0, 'child text') })
    emit(child, { type: 'end', attemptId: 'k1', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 7 } })
    emit(main, { type: 'chunk', attemptId: 'm1', revision: 3, index: 1, time: 2, chunk: textChunk(1, 'main tail') })
    emit(main, { type: 'end', attemptId: 'm1', revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 7 } })
    const mainChunks = sink.inputs.filter(input => input.kind === 'chunk' && input.sessionId === 'session-m')
    const childChunks = sink.inputs.filter(input => input.kind === 'chunk' && input.sessionId === 'session-k')
    assert.deepEqual(mainChunks.map(input => (input as { chunk: { text: string } }).chunk.text), ['main text', 'main tail'])
    assert.deepEqual(childChunks.map(input => (input as { chunk: { text: string } }).chunk.text), ['child text'])
  } finally {
    dispose()
  }
})

test('the Agent revision fence rejects delayed frames and resumes on a fresh attempt', () => {
  const current = agent('retry')
  const { emit, sink, dispose } = harness(subject => subject === current)
  try {
    const oldChunk = { type: 'chunk' as const, attemptId: 'a', revision: 2, index: 0, time: 1, chunk: textChunk(0, 'A') }
    emit(current, { type: 'start', attemptId: 'a', revision: 1, turn: 0, step: 0 })
    emit(current, oldChunk)
    emit(current, { type: 'end', attemptId: 'a', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 7 } })
    emit(current, { type: 'start', attemptId: 'b', revision: 4, turn: 0, step: 0 })
    emit(current, { type: 'chunk', attemptId: 'b', revision: 5, index: 0, time: 2, chunk: textChunk(0, 'B') })
    // This delayed frame is a revision gap. It clears B's open record and is
    // not presented; the already-delivered B prefix remains visible.
    emit(current, oldChunk)
    // B's remaining frames are consumed but cannot resurrect its attempt.
    emit(current, { type: 'chunk', attemptId: 'b', revision: 6, index: 1, time: 3, chunk: textChunk(1, 'B tail') })
    emit(current, { type: 'end', attemptId: 'b', revision: 7, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 8 } })
    emit(current, { type: 'start', attemptId: 'c', revision: 8, turn: 0, step: 0 })
    emit(current, { type: 'chunk', attemptId: 'c', revision: 9, index: 0, time: 4, chunk: textChunk(0, 'C') })
    emit(current, { type: 'end', attemptId: 'c', revision: 10, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } })
    const chunks = sink.inputs.filter(input => input.kind === 'chunk')
    assert.deepEqual(chunks.map(input => (input as { chunk: { text: string } }).chunk.text), ['A', 'B', 'C'])
  } finally {
    dispose()
  }
})

test('malformed frames are dropped without throwing', () => {
  const current = agent('g')
  const { emit, sink, dispose } = harness(subject => subject === current)
  try {
    // The adapter narrows at an UNKNOWN boundary — hostile shapes must be
    // dropped, so they are fed here through the same cast a wire would.
    const malformed = (frame: unknown): AssistantStreamFrameLike => frame as AssistantStreamFrameLike
    emit(current, malformed({ type: 'start', attemptId: '', revision: 1, turn: 0, step: 0 })) // empty attempt id
    emit(current, malformed({ type: 'chunk', attemptId: 'g1', revision: 1, index: 0, time: 1, chunk: null })) // null chunk
    // A structurally-valid unknown-attempt frame consumes its revision even
    // though it cannot be presented.
    emit(current, malformed({ type: 'chunk', attemptId: 'g1', revision: 100, index: 0, time: 1, chunk: textChunk(0, 'unknown attempt') })) // high unknown revision
    emit(current, malformed({ type: 'chunk', attemptId: 'g1', revision: 'x', index: 0, time: 1, chunk: { type: 'text-delta' } })) // bad revision
    emit(current, malformed({ type: 'end', attemptId: 'g1', revision: 3, index: 0, outcome: { kind: 'bogus' } })) // bad outcome
    emit(current, malformed({ type: 'start', attemptId: 'g1', revision: 101, turn: 0, step: 0 }))
    emit(current, malformed({ type: 'chunk', attemptId: 'g1', revision: 102, index: 0, time: 1, chunk: { type: 'future-chunk' } })) // unknown chunk kind
    emit(current, malformed({ type: 'chunk', attemptId: 'g1', revision: 102, index: 0, time: 1, chunk: textChunk(0, 'valid') }))
    // A semantically invalid dense terminal still consumes its revision and
    // clears the attempt; the following end is dropped without a record.
    emit(current, malformed({ type: 'end', attemptId: 'g1', revision: 103, index: 2, outcome: { kind: 'abandoned' } })) // invalid dense terminal index
    emit(current, malformed({ type: 'end', attemptId: 'g1', revision: 104, index: 1, outcome: { kind: 'abandoned' } }))
    assert.deepEqual(sink.inputs.map(input => input.kind), ['start', 'chunk'])
  } finally {
    dispose()
  }
})
