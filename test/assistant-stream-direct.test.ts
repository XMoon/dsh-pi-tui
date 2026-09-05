/**
 * Direct adapter contract tests for the live assistant stream seam (Session
 * v2): official `agent/assistant-stream` frames carry turn/step ONLY on
 * `start` — a chunk/end names its attempt, and the adapter resolves
 * turn/step through per-Agent attempt state. These tests build the frames
 * EXACTLY as upstream `AssistantStreamAttempt` emits them (no invented
 * fields) and pin the ordering guards (monotone revision, dense index),
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
    emit(current, chunkFrame('c1', 0, textChunk(0, 'orphan'))) // no start
    emit(current, committedEnd('c1', 0, 'assistant/message')) // no start
    emit(current, startFrame('c1', 1, 0))
    emit(current, chunkFrame('c1', 0, textChunk(0, 'ok')))
    emit(current, committedEnd('c1', 1, 'assistant/message'))
    emit(current, chunkFrame('c1', 1, textChunk(1, 'late'))) // after end
    assert.equal(sink.inputs.length, 3, 'only the complete attempt flows')
  } finally {
    dispose()
  }
})

test('ordering guards: a stale revision or a non-dense chunk index is dropped', () => {
  const current = agent('d')
  const { emit, sink, dispose } = harness(subject => subject === current)
  try {
    emit(current, startFrame('d1', 2, 0))
    emit(current, chunkFrame('d1', 0, textChunk(0, 'first')))
    // Replayed OLDER revision of the same dense index.
    emit(current, { type: 'chunk', attemptId: 'd1', revision: 2, index: 0, time: 1, chunk: textChunk(0, 'stale') })
    // Skipped index (2 instead of 1).
    emit(current, { type: 'chunk', attemptId: 'd1', revision: 99, index: 2, time: 2, chunk: textChunk(2, 'gap') })
    emit(current, chunkFrame('d1', 1, textChunk(1, 'second')))
    emit(current, committedEnd('d1', 2, 'assistant/message'))
    const texts = sink.inputs.filter(input => input.kind === 'chunk').map(input => (input as { chunk: { text: string } }).chunk.text)
    assert.deepEqual(texts, ['first', 'second'], 'stale and gapped chunks never reach the presentation')
  } finally {
    dispose()
  }
})

test('chunk kinds the presentation ignores still occupy their dense index slot', () => {
  const current = agent('e')
  const { emit, sink, dispose } = harness(subject => subject === current)
  try {
    emit(current, startFrame('e1', 0, 0))
    emit(current, chunkFrame('e1', 0, { type: 'block-start', blockType: 'reasoning' })) // unconsumed kind
    emit(current, chunkFrame('e1', 1, textChunk(1, 'after block-start')))
    emit(current, chunkFrame('e1', 2, { type: 'finish', reason: 'stop' })) // unconsumed kind
    emit(current, chunkFrame('e1', 3, textChunk(3, 'tail')))
    emit(current, committedEnd('e1', 4, 'assistant/message'))
    const texts = sink.inputs.filter(input => input.kind === 'chunk').map(input => (input as { chunk: { text: string } }).chunk.text)
    assert.deepEqual(texts, ['after block-start', 'tail'], 'index slots advance across unconsumed kinds')
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
    emit(current, startFrame('f1', 1, 0))
    emit(current, chunkFrame('f1', 0, textChunk(0, 'current stream')))
    emit(current, committedEnd('f1', 1, 'assistant/message'))
    const texts = sink.inputs.filter(input => input.kind === 'chunk').map(input => (input as { chunk: { text: string } }).chunk.text)
    assert.deepEqual(texts, ['current stream'], 'only the exact current Agent object flows')
  } finally {
    dispose()
  }
})

test('two live Agents (main + viewed child) keep separate attempt state', () => {
  const main = agent('m')
  const child = agent('k')
  const { emit, sink, dispose } = harness(subject => subject === main || subject === child)
  try {
    emit(main, startFrame('m1', 5, 0))
    emit(child, startFrame('k1', 1, 0))
    emit(main, chunkFrame('m1', 0, textChunk(0, 'main text')))
    emit(child, chunkFrame('k1', 0, textChunk(0, 'child text')))
    emit(child, committedEnd('k1', 1, 'assistant/attempt'))
    emit(main, chunkFrame('m1', 1, textChunk(1, 'main tail')))
    emit(main, committedEnd('m1', 2, 'assistant/message'))
    const mainChunks = sink.inputs.filter(input => input.kind === 'chunk' && input.sessionId === 'session-m')
    const childChunks = sink.inputs.filter(input => input.kind === 'chunk' && input.sessionId === 'session-k')
    assert.deepEqual(mainChunks.map(input => (input as { chunk: { text: string } }).chunk.text), ['main text', 'main tail'])
    assert.deepEqual(childChunks.map(input => (input as { chunk: { text: string } }).chunk.text), ['child text'])
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
    emit(current, malformed({ type: 'chunk', attemptId: 'g1', revision: 2, index: 0, time: 1, chunk: null })) // null chunk
    emit(current, malformed({ type: 'chunk', attemptId: 'g1', revision: 'x', index: 0, time: 1, chunk: { type: 'text-delta' } })) // bad revision
    emit(current, malformed({ type: 'end', attemptId: 'g1', revision: 3, index: 0, outcome: { kind: 'bogus' } })) // bad outcome
    assert.equal(sink.inputs.length, 0)
  } finally {
    dispose()
  }
})
