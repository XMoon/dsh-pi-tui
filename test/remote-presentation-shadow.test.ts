import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemotePresentationReadShadow,
  projectPresentationSnapshot,
  type PresentationReadShadowOutcome,
} from '../src/runtime/remote/presentation-read-shadow.ts'
import { DirectPresentationReader } from '../src/runtime/direct/presentation-read-direct.ts'
import { TranscriptWindowController } from '../src/transcript-window.ts'
import {
  RemotePresentationReader,
  type RemotePresentationBinding,
  type RemotePresentationEventEntry,
  type RemotePresentationSessionsSource,
} from '../src/runtime/remote/presentation-read-remote.ts'
import type { AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'
import type {
  PresentationDurableEvent,
  PresentationReadSnapshot,
  PresentationReader,
} from '../src/runtime/presentation-read-port.ts'
import type { RemoteConnectionGeneration, RemoteConnectionGenerationSource } from '../src/runtime/remote/session-reader-remote.ts'

interface GenerationHarness {
  readonly source: RemoteConnectionGenerationSource
  set(value: RemoteConnectionGeneration | undefined): void
}

function generationHarness(): GenerationHarness {
  let current: RemoteConnectionGeneration | undefined = { id: 1 }
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => current,
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(value) {
      current = value
      for (const listener of [...listeners]) listener()
    },
  }
}

function event(type: string, seq: number, data: Record<string, unknown>): PresentationDurableEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data }
}

function textChunk(text: string): AssistantLiveInput {
  return {
    kind: 'chunk',
    sessionId: 'session',
    attemptId: 'attempt-a',
    turn: 0,
    step: 0,
    time: 1_700_000_000_010,
    chunk: { type: 'text-delta', index: 0, text },
  }
}

function start(): AssistantLiveInput {
  return { kind: 'start', sessionId: 'session', attemptId: 'attempt-a', turn: 0, step: 0 }
}

function directSnapshot(events: readonly PresentationDurableEvent[], liveInputs: readonly AssistantLiveInput[] = []): PresentationReadSnapshot {
  return {
    sessionId: 'session',
    durableEvents: events,
    liveInputs,
    revision: events.length,
    coverage: 'full',
    hasMore: false,
    loadingOlder: false,
    openState: 'open',
  }
}

function officialBinding(entries: readonly RemotePresentationEventEntry[], hasMore = false): RemotePresentationBinding {
  return {
    session: {
      getSnapshot: () => ({ openState: 'open', loadingOlder: false }),
      async loadOlder() {},
    },
    eventSource: { getSnapshot: () => ({ entries, hasMore, revision: entries.length }) },
  }
}

function reader(value: PresentationReadSnapshot | undefined): PresentationReader {
  return {
    read: async (_sessionId, signal) => { signal?.throwIfAborted(); return value },
    loadOlder: async (_sessionId, signal) => { signal?.throwIfAborted(); return value },
  }
}

function reportOf(outcome: PresentationReadShadowOutcome) {
  if (outcome.status !== 'compared') throw new Error(`expected compared, got ${outcome.status}`)
  return outcome.report
}

function settledEvents(): PresentationDurableEvent[] {
  return [
    event('turn/start', 0, { turn: 0 }),
    event('user/message', 1, {
      id: 'user-1',
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }),
    event('step/start', 2, { turn: 0, step: 0 }),
    event('assistant/message', 3, {
      turn: 0,
      step: 0,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'world' }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      },
    }),
    event('turn/end', 4, { turn: 0, reason: { kind: 'completed' } }),
  ]
}

test('compares an official eventSource cut through Transcript, Window, and Focus semantics', async () => {
  const generations = generationHarness()
  const events = settledEvents()
  const liveInputs = [start(), textChunk('live')]
  const directAgent = { session: { snapshotEvents: () => events } }
  const direct = new DirectPresentationReader({
    agentFor: id => id === 'session' ? directAgent : undefined,
    assistantStreamBaselineFor: () => liveInputs,
  })
  const entries: RemotePresentationEventEntry[] = [
    ...events.map(eventValue => ({ type: 'event' as const, event: eventValue })),
    {
      type: 'transient',
      event: {
        type: 'assistant/live-chunk' as const,
        time: liveInputs[1]!.kind === 'chunk' ? liveInputs[1]!.time : 0,
        data: {
          attemptId: 'attempt-a',
          turn: 0,
          step: 0,
          chunk: { type: 'text-delta', index: 0, text: 'live' },
        },
      },
    },
  ]
  const binding = officialBinding(entries)
  const remote = new RemotePresentationReader({ binding: id => id === 'session' ? binding : undefined }, generations.source)
  const shadow = new RemotePresentationReadShadow(direct, remote, generations.source)

  const report = reportOf(await shadow.compare({ sessionId: 'session', projection: { focusMode: true } }))
  assert.equal(report.comparable, true)
  assert.deepEqual(report.mismatches, [])
  assert.deepEqual(report.skipped, [])
  shadow.dispose()
})

test('fresh same-turn steer parity hydrates durable history before replaying the later live owner', async () => {
  const generations = generationHarness()
  const events = [
    event('turn/start', 0, { turn: 0 }),
    event('step/start', 1, { turn: 0, step: 1 }),
    event('user/message', 2, {
      id: 'initial',
      role: 'user',
      content: [{ type: 'text', text: 'initial prompt' }],
      source: { kind: 'user' },
    }),
    event('assistant/chunk', 3, {
      turn: 0,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'assistant A' },
    }),
    event('assistant/message', 4, {
      turn: 0,
      step: 1,
      message: {
        id: 'assistant-a',
        role: 'assistant',
        content: [{ type: 'text', text: 'assistant A' }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      },
    }),
    event('step/end', 5, { turn: 0, step: 1 }),
    event('step/start', 6, { turn: 0, step: 2 }),
    event('user/message', 7, {
      id: 'steer',
      role: 'user',
      content: [{ type: 'text', text: 'human steer' }],
      source: { kind: 'user' },
    }),
  ]
  const liveInputs: AssistantLiveInput[] = [
    { kind: 'start', sessionId: 'session', attemptId: 'attempt-b', turn: 0, step: 2 },
    {
      kind: 'chunk',
      sessionId: 'session',
      attemptId: 'attempt-b',
      turn: 0,
      step: 2,
      time: 1_700_000_000_010,
      chunk: { type: 'text-delta', index: 0, text: 'assistant B' },
    },
  ]
  const direct = directSnapshot(events, liveInputs)
  const remote = { ...directSnapshot(events, liveInputs), coverage: 'bounded' as const }
  const shadow = new RemotePresentationReadShadow(reader(direct), reader(remote), generations.source)

  const report = reportOf(await shadow.compare({ sessionId: 'session', projection: { focusMode: true } }))
  assert.equal(report.comparable, true)
  assert.deepEqual(report.mismatches, [])

  const projection = projectPresentationSnapshot(direct, { focusMode: true, windowTurns: 20 })
  assert.deepEqual(
    projection.messages.map(message => `${(message as { kind: string }).kind}:${(message as { text?: string }).text ?? ''}`),
    ['user:initial prompt', 'assistant:assistant A', 'user:human steer', 'assistant:assistant B'],
  )
  assert.equal(
    projection.messages.filter(message => (message as { kind: string; text?: string }).kind === 'assistant' && (message as { text?: string }).text === 'assistant A').length,
    1,
    'the pre-steer Assistant must occur exactly once',
  )
  const activity = projection.activities[0] as { message?: { text?: string } } | undefined
  assert.equal(activity?.message?.text, 'assistant B', 'the later step owns the final Message slot')
  shadow.dispose()
})

test('reports durable payload, live inputs, and presentation semantic mismatches with bounded output', async () => {
  const generations = generationHarness()
  const events = settledEvents()
  const direct = directSnapshot(events, [start(), textChunk('direct')])
  const remote = directSnapshot(
    events.map((value, index) => index === 3
      ? { ...value, data: { ...(value.data as Record<string, unknown>), message: { id: 'assistant-1', content: [{ type: 'text', text: 'remote' }] } } }
      : value),
    [start(), textChunk('remote')],
  )
  const remoteBounded: PresentationReadSnapshot = { ...remote, coverage: 'bounded', hasMore: false }
  const shadow = new RemotePresentationReadShadow(reader(direct), reader(remoteBounded), generations.source)

  const report = reportOf(await shadow.compare({ sessionId: 'session' }))
  assert.equal(report.comparable, false)
  assert.ok(report.mismatches.some(mismatch => mismatch.field === 'durable.payload'))
  assert.ok(report.mismatches.some(mismatch => mismatch.field === 'live.inputs'))
  assert.ok(report.mismatches.some(mismatch => mismatch.field === 'projection.messages'))
  assert.ok(report.mismatches.some(mismatch => mismatch.field === 'projection.focus'))
  assert.ok(JSON.stringify(report).length < 100_000)
  shadow.dispose()
})

test('preserves Focus context/final ownership and history no-op semantics', () => {
  const events = [
    event('turn/start', 0, { turn: 0 }),
    event('user/message', 1, {
      id: 'context-1', role: 'user', content: [{ type: 'text', text: 'injected context' }],
      source: { kind: 'agent-instructions', changes: [{ path: 'AGENTS.md' }] },
    }),
    event('user/message', 2, {
      id: 'human-1', role: 'user', content: [{ type: 'text', text: 'human prompt' }], source: { kind: 'user' },
    }),
    event('step/start', 3, { turn: 0, step: 0 }),
    event('assistant/message', 4, {
      turn: 0, step: 0,
      message: { id: 'answer-0', role: 'assistant', content: [{ type: 'text', text: 'intermediate' }] },
    }),
    event('assistant/message', 5, {
      turn: 0, step: 1,
      message: { id: 'answer-1', role: 'assistant', content: [{ type: 'text', text: 'final' }] },
    }),
    event('turn/end', 6, { turn: 0, reason: { kind: 'completed' } }),
  ]
  const projection = projectPresentationSnapshot(directSnapshot(events), { focusMode: true, windowTurns: 20 })
  assert.equal(projection.messages.some(message => (message as { context?: true }).context === true), true)
  const focus = projection.focus as readonly { kind: string; message?: { text?: string } }[]
  assert.equal(focus.filter(block => block.kind === 'message' && block.message?.text === 'final').length, 1)
  assert.equal(focus.filter(block => block.kind === 'message' && block.message?.text === 'intermediate').length, 0)

  const controller = new TranscriptWindowController({ turns: [0], windowTurns: 20 })
  const before = controller.snapshot()
  assert.equal(before.hasOlder, false)
  assert.equal(controller.moveOlder(), false)
  assert.deepEqual(controller.snapshot(), before)
})

test('discards stale presentation success and failure after generation reset', async () => {
  const generations = generationHarness()
  let releaseSuccess!: () => void
  const successGate = new Promise<void>(resolve => { releaseSuccess = resolve })
  const delayedSuccess: PresentationReader = {
    read: async () => {
      await successGate
      return directSnapshot(settledEvents())
    },
    loadOlder: async () => directSnapshot(settledEvents()),
  }
  const successShadow = new RemotePresentationReadShadow(delayedSuccess, delayedSuccess, generations.source)
  const success = successShadow.compare({ sessionId: 'session' })
  generations.set({ id: 2 })
  releaseSuccess()
  assert.deepEqual(await success, { status: 'discarded', generation: '1', reason: 'stale-generation' })
  successShadow.dispose()

  let releaseFailure!: () => void
  const failureGate = new Promise<void>(resolve => { releaseFailure = resolve })
  const delayedFailure: PresentationReader = {
    read: async () => {
      await failureGate
      throw new Error('late old-generation failure')
    },
    loadOlder: async () => directSnapshot(settledEvents()),
  }
  const failureShadow = new RemotePresentationReadShadow(delayedFailure, delayedFailure, generations.source)
  const failure = failureShadow.compare({ sessionId: 'session' })
  generations.set({ id: 3 })
  releaseFailure()
  assert.deepEqual(await failure, { status: 'discarded', generation: '2', reason: 'stale-generation' })
  failureShadow.dispose()
})

test('generation reset, supersession, cancellation, and dispose discard stale presentation work', async () => {
  const generations = generationHarness()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const delayed: PresentationReader = {
    read: async (_id, signal) => {
      calls += 1
      await gate
      signal?.throwIfAborted()
      if (calls === 1) throw new Error('late failure')
      return directSnapshot(settledEvents())
    },
    loadOlder: async (_id, signal) => { signal?.throwIfAborted(); return directSnapshot(settledEvents()) },
  }
  const shadow = new RemotePresentationReadShadow(delayed, delayed, generations.source)
  const stale = shadow.compare({ sessionId: 'session' })
  generations.set({ id: 2 })
  release()
  assert.deepEqual(await stale, { status: 'discarded', generation: '1', reason: 'stale-generation' })
  shadow.dispose()

  const secondGenerations = generationHarness()
  let secondRelease!: () => void
  const secondGate = new Promise<void>(resolve => { secondRelease = resolve })
  let secondCalls = 0
  const supersedable: PresentationReader = {
    read: async (_id, signal) => {
      secondCalls += 1
      if (secondCalls <= 2) await secondGate
      signal?.throwIfAborted()
      return directSnapshot(settledEvents())
    },
    loadOlder: async (_id, signal) => { signal?.throwIfAborted(); return directSnapshot(settledEvents()) },
  }
  const superseding = new RemotePresentationReadShadow(supersedable, supersedable, secondGenerations.source)
  const old = superseding.compare({ sessionId: 'session' })
  const next = superseding.compare({ sessionId: 'session' })
  secondRelease()
  assert.deepEqual(await old, { status: 'discarded', generation: '1', reason: 'superseded' })
  assert.equal((await next).status, 'compared')
  superseding.dispose()

  const thirdGenerations = generationHarness()
  let thirdRelease!: () => void
  const thirdGate = new Promise<void>(resolve => { thirdRelease = resolve })
  const pendingReader: PresentationReader = {
    read: async (_id, signal) => { await thirdGate; signal?.throwIfAborted(); return directSnapshot(settledEvents()) },
    loadOlder: async (_id, signal) => { signal?.throwIfAborted(); return directSnapshot(settledEvents()) },
  }
  const cancelledShadow = new RemotePresentationReadShadow(pendingReader, pendingReader, thirdGenerations.source)
  const controller = new AbortController()
  const cancelled = cancelledShadow.compare({ sessionId: 'session', signal: controller.signal })
  controller.abort()
  thirdRelease()
  assert.deepEqual(await cancelled, { status: 'cancelled', generation: '1' })
  cancelledShadow.dispose()

  const disposeGenerations = generationHarness()
  let disposeRelease!: () => void
  const disposeGate = new Promise<void>(resolve => { disposeRelease = resolve })
  const disposable: PresentationReader = {
    read: async (_id, signal) => { await disposeGate; signal?.throwIfAborted(); return directSnapshot(settledEvents()) },
    loadOlder: async (_id, signal) => { signal?.throwIfAborted(); return directSnapshot(settledEvents()) },
  }
  const disposedShadow = new RemotePresentationReadShadow(disposable, disposable, disposeGenerations.source)
  const disposed = disposedShadow.compare({ sessionId: 'session' })
  disposedShadow.dispose()
  disposeRelease()
  assert.deepEqual(await disposed, { status: 'discarded', generation: '1', reason: 'disposed' })
})
