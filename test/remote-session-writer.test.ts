/**
 * Contract tests for the D2.2 Remote session writer: identity-addressed binding
 * resolution, the official beginSubmission/prompt identity handoff, official
 * queue mutations, cancel/rename mapping, and settlement classification.
 * @module @xmoon76/dsh-pi-tui/remote-session-writer.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ISession, ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'
import {
  RemoteSessionWriter,
  type RemotePromptSerializer,
  type RemoteWriteSessionFace,
  type RemoteWriteSessionsSource,
} from '../src/runtime/remote/session-writer-remote.ts'
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
      subscribe: listener => {
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

interface SessionCalls {
  beginInputs: unknown[]
  promptCalls: { content: unknown; mode: string; requestId: string | undefined }[]
  updateQueueCalls: { itemId: string; action: unknown }[]
  cancelCalls: number
  renameCalls: string[]
  abandonCalls: number
  openCalls: number
}

interface WriterHarness {
  readonly source: RemoteWriteSessionsSource
  readonly calls: SessionCalls
  readonly generation: GenerationHarness
  setPromptResult(result: { ok: true; value: { accepted: true } } | { ok: false; error: unknown }): void
  setPromptThrows(error: unknown): void
  setQueueResult(result: { ok: true; value: { accepted: true } } | { ok: false; error: unknown }): void
  setCancelResult(result: { ok: true; value: { accepted: true } } | { ok: false; error: unknown }): void
  setRenameResult(result: { ok: true; value: { title: string; seq: number } } | { ok: false; error: unknown }): void
  setPromptHook(hook: () => void): void
  setQueueHook(hook: () => void): void
  setBeginHook(hook: () => void): void
  setBeginThrows(error: unknown): void
}

function writerHarness(): WriterHarness {
  const calls: SessionCalls = {
    beginInputs: [],
    promptCalls: [],
    updateQueueCalls: [],
    cancelCalls: 0,
    renameCalls: [],
    abandonCalls: 0,
    openCalls: 0,
  }
  const generation = generationHarness()
  let promptResult: { ok: true; value: { accepted: true } } | { ok: false; error: unknown } = {
    ok: true,
    value: { accepted: true },
  }
  let promptThrows: unknown
  let promptHook: (() => void) | undefined
  let queueResult: { ok: true; value: { accepted: true } } | { ok: false; error: unknown } = {
    ok: true,
    value: { accepted: true },
  }
  let queueHook: (() => void) | undefined
  let cancelResult: { ok: true; value: { accepted: true } } | { ok: false; error: unknown } = {
    ok: true,
    value: { accepted: true },
  }
  let renameResult: { ok: true; value: { title: string; seq: number } } | { ok: false; error: unknown } = {
    ok: true,
    value: { title: 'accepted', seq: 7 },
  }
  let beginThrows: unknown
  let beginHook: (() => void) | undefined
  const session: RemoteWriteSessionFace = {
    beginSubmission: input => {
      calls.beginInputs.push(input)
      beginHook?.()
      if (beginThrows !== undefined) throw beginThrows
      return {
        requestId: `req-${calls.beginInputs.length}`,
        abandon: () => { calls.abandonCalls += 1 },
      }
    },
    prompt: async (content, mode, _signal, requestId) => {
      calls.promptCalls.push({ content, mode, requestId })
      promptHook?.()
      if (promptThrows !== undefined) throw promptThrows
      return promptResult
    },
    updateQueue: async (itemId, action) => {
      calls.updateQueueCalls.push({ itemId, action })
      queueHook?.()
      return queueResult
    },
    cancel: async () => {
      calls.cancelCalls += 1
      return cancelResult
    },
    rename: async title => {
      calls.renameCalls.push(title)
      return renameResult
    },
  }
  const source: RemoteWriteSessionsSource = {
    binding: id => id === 'session-a' ? { session } : undefined,
  }
  return {
    source,
    calls,
    generation,
    setPromptResult: result => { promptResult = result },
    setPromptThrows: error => { promptThrows = error },
    setQueueResult: result => { queueResult = result },
    setCancelResult: result => { cancelResult = result },
    setRenameResult: result => { renameResult = result },
    setPromptHook: hook => { promptHook = hook },
    setQueueHook: hook => { queueHook = hook },
    setBeginHook: hook => { beginHook = hook },
    setBeginThrows: error => { beginThrows = error },
  }
}

function okSerializer(overrides: {
  text?: string
  preflightUnsupported?: string
  serializeUnsupported?: string
  serializeThrows?: unknown
  onSerialize?: () => void
} = {}): RemotePromptSerializer {
  return {
    preflight: () => overrides.preflightUnsupported !== undefined
      ? { kind: 'unsupported', reason: overrides.preflightUnsupported }
      : { kind: 'ok', echo: { text: overrides.text ?? 'hello', attachments: [] } },
    serialize: async () => {
      overrides.onSerialize?.()
      if (overrides.serializeThrows !== undefined) throw overrides.serializeThrows
      if (overrides.serializeUnsupported !== undefined) {
        return { kind: 'unsupported', reason: overrides.serializeUnsupported }
      }
      return { kind: 'ok', content: [{ type: 'text' as const, text: overrides.text ?? 'hello' }] }
    },
  }
}

test('official Client faces satisfy the writer boundary structurally', () => {
  const constructFromOfficial = (
    sessions: ISessions,
    generation: ConnectionGenerationState,
    serializer: RemotePromptSerializer,
  ): RemoteSessionWriter => new RemoteSessionWriter(sessions, generation, serializer)
  const faceToRemote = (session: ISession): RemoteWriteSessionFace => session
  assert.equal(typeof constructFromOfficial, 'function')
  assert.equal(typeof faceToRemote, 'function')
})

test('queue prompt resolves the binding by id, echoes once, and reuses the official requestId', async () => {
  const harness = writerHarness()
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer({ text: 'queued hi' }))

  const outcome = await writer.prompt('session-a', { prepared: true }, 'queue')
  assert.deepEqual(outcome, { kind: 'committed', value: undefined })
  assert.equal(harness.calls.beginInputs.length, 1)
  assert.deepEqual(harness.calls.beginInputs[0], {
    mode: 'queue',
    text: 'queued hi',
    attachments: [],
  })
  assert.equal(harness.calls.promptCalls.length, 1)
  assert.equal(harness.calls.promptCalls[0]?.mode, 'queue')
  assert.equal(harness.calls.promptCalls[0]?.requestId, 'req-1')
  assert.equal(harness.calls.abandonCalls, 0)
})

test('steer prompt preserves the official steer mode', async () => {
  const harness = writerHarness()
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const outcome = await writer.prompt('session-a', {}, 'steer')
  assert.equal(outcome.kind, 'committed')
  assert.deepEqual(harness.calls.beginInputs[0], { mode: 'steer', text: 'hello', attachments: [] })
  assert.equal(harness.calls.promptCalls[0]?.mode, 'steer')
})

test('an unsupported preflight is refused before any official echo or Host mutation', async () => {
  const harness = writerHarness()
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer({ preflightUnsupported: 'file upload requires D4' }))
  const outcome = await writer.prompt('session-a', {}, 'queue')
  assert.deepEqual(outcome, { kind: 'unsupported', reason: 'file upload requires D4' })
  assert.equal(harness.calls.beginInputs.length, 0)
  assert.equal(harness.calls.promptCalls.length, 0)
})

test('the official echo is registered after preflight and before serialization', async () => {
  const harness = writerHarness()
  const order: string[] = []
  harness.setBeginHook(() => order.push('begin'))
  harness.setPromptHook(() => order.push('prompt'))
  const serializer: RemotePromptSerializer = {
    preflight: () => {
      order.push('preflight')
      return { kind: 'ok', echo: { text: 'ordered', attachments: [] } }
    },
    serialize: async () => {
      order.push('serialize')
      return { kind: 'ok', content: [{ type: 'text', text: 'ordered' }] }
    },
  }
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, serializer)
  assert.equal((await writer.prompt('session-a', {}, 'queue')).kind, 'committed')
  // `begin` is recorded AT the registration call, so the assertion actually
  // pins the official ordering (it would fail if begin ran after serialize).
  assert.deepEqual(order, ['preflight', 'begin', 'serialize', 'prompt'])
  assert.equal(harness.calls.beginInputs.length, 1)
})

test('an echo-registration failure is a pre-dispatch refusal, never indeterminate', async () => {
  const harness = writerHarness()
  harness.setBeginThrows(new Error('echo store closed'))
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const outcome = await writer.prompt('session-a', {}, 'queue')
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.kind === 'rejected' ? outcome.error.code : undefined, 'session/prompt-echo-failed')
  assert.equal(harness.calls.promptCalls.length, 0)
})

test('a post-begin serialization failure abandons the official echo and is a known local refusal', async () => {
  const harness = writerHarness()
  const writer = new RemoteSessionWriter(
    harness.source,
    harness.generation.source,
    okSerializer({ serializeThrows: new Error('encode failed') }),
  )
  const outcome = await writer.prompt('session-a', {}, 'queue')
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.kind === 'rejected' ? outcome.error.code : undefined, 'session/prompt-serialize-failed')
  assert.equal(harness.calls.beginInputs.length, 1)
  assert.equal(harness.calls.abandonCalls, 1)
  assert.equal(harness.calls.promptCalls.length, 0)
})

test('a serialization that declares unsupported after begin abandons the echo without prompting', async () => {
  const harness = writerHarness()
  const writer = new RemoteSessionWriter(
    harness.source,
    harness.generation.source,
    okSerializer({ serializeUnsupported: 'image conversion unavailable' }),
  )
  const outcome = await writer.prompt('session-a', {}, 'queue')
  assert.deepEqual(outcome, { kind: 'unsupported', reason: 'image conversion unavailable' })
  assert.equal(harness.calls.beginInputs.length, 1)
  assert.equal(harness.calls.abandonCalls, 1)
  assert.equal(harness.calls.promptCalls.length, 0)
})

test('a prompt assembly fault propagates instead of being disguised as indeterminate', async () => {
  const harness = writerHarness()
  harness.setPromptThrows(new Error('assembly fault'))
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  // The generated Remote resolves carrier failures into RemoteResult; a
  // rejection is an assembly/programming defect and must not become an
  // ambiguous write. The identified echo is never abandoned here.
  await assert.rejects(() => writer.prompt('session-a', {}, 'queue'), /assembly fault/)
  assert.equal(harness.calls.promptCalls.length, 1)
  assert.equal(harness.calls.abandonCalls, 0)
})

test('a plain wire failure object keeps its human message, not [object Object]', async () => {
  const harness = writerHarness()
  // The official Client carrier delivers plain `{code, message, details}`
  // values, not necessarily Error instances.
  harness.setPromptResult({ ok: false, error: { code: 'session/title-invalid', message: 'bad title' } })
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const outcome = await writer.prompt('session-a', {}, 'queue')
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.kind === 'rejected' ? outcome.error.code : undefined, 'session/title-invalid')
  assert.equal(outcome.kind === 'rejected' ? outcome.error.message : undefined, 'bad title')
})

test('a plain wire carrier failure is indeterminate with its human message preserved', async () => {
  const harness = writerHarness()
  harness.setCancelResult({ ok: false, error: { code: 'gateway/internal', message: 'carrier reset' } })
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const outcome = await writer.cancel('session-a')
  assert.equal(outcome.kind, 'indeterminate')
  assert.equal(outcome.kind === 'indeterminate' ? outcome.error.message : undefined, 'carrier reset')
})

test('a business RemoteFailure is rejected with its stable code preserved', async () => {
  const harness = writerHarness()
  harness.setPromptResult({ ok: false, error: new RemoteError('session/agent-busy', 'busy', { reason: 'running' }) })
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const outcome = await writer.prompt('session-a', {}, 'queue')
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.kind === 'rejected' ? outcome.error.code : undefined, 'session/agent-busy')
  // The official Client retires the identified echo for a failed prompt.
  assert.equal(harness.calls.abandonCalls, 0)
})

test('a gateway cancellation is cancelled, not rejected', async () => {
  const harness = writerHarness()
  harness.setPromptResult({ ok: false, error: new RemoteError('gateway/cancelled', 'cancelled', {}) })
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  assert.deepEqual(await writer.prompt('session-a', {}, 'queue'), { kind: 'cancelled' })
})

test('a gateway carrier failure is indeterminate, never a proven rejection', async () => {
  const harness = writerHarness()
  harness.setPromptResult({ ok: false, error: new RemoteError('gateway/internal', 'carrier reset', {}) })
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const outcome = await writer.prompt('session-a', {}, 'queue')
  assert.equal(outcome.kind, 'indeterminate')
})

test('an absent binding is a session-not-found rejection and never opens a session', async () => {
  const harness = writerHarness()
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const outcome = await writer.prompt('missing', {}, 'queue')
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.kind === 'rejected' ? outcome.error.code : undefined, 'session/not-found')
  assert.equal(harness.calls.promptCalls.length, 0)
  assert.equal(harness.calls.openCalls, 0)
})

test('a generation replaced during serialization abandons the echo without prompting', async () => {
  const harness = writerHarness()
  const writer = new RemoteSessionWriter(
    harness.source,
    harness.generation.source,
    okSerializer({ onSerialize: () => harness.generation.set({ id: 2 }) }),
  )
  assert.deepEqual(await writer.prompt('session-a', {}, 'queue'), { kind: 'cancelled' })
  assert.equal(harness.calls.beginInputs.length, 1)
  assert.equal(harness.calls.abandonCalls, 1)
  assert.equal(harness.calls.promptCalls.length, 0)
})

test('a generation replaced by preflight cancels before any official echo', async () => {
  const harness = writerHarness()
  const serializer: RemotePromptSerializer = {
    preflight: () => {
      harness.generation.set({ id: 2 })
      return { kind: 'ok', echo: { text: 'late', attachments: [] } }
    },
    serialize: async () => ({ kind: 'ok', content: [{ type: 'text', text: 'late' }] }),
  }
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, serializer)
  assert.deepEqual(await writer.prompt('session-a', {}, 'queue'), { kind: 'cancelled' })
  assert.equal(harness.calls.beginInputs.length, 0)
  assert.equal(harness.calls.promptCalls.length, 0)
})

test('a disconnected generation is unavailable without dispatch', async () => {
  const harness = writerHarness()
  harness.generation.set(undefined)
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  assert.deepEqual(await writer.prompt('session-a', {}, 'queue'), { kind: 'cancelled' })
  assert.equal(harness.calls.promptCalls.length, 0)
})

test('a generation replaced AFTER dispatch with an unknown settlement is indeterminate, never replayed', async () => {
  const harness = writerHarness()
  harness.setPromptHook(() => harness.generation.set({ id: 2 }))
  harness.setPromptResult({ ok: false, error: new RemoteError('gateway/internal', 'carrier reset', {}) })
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const outcome = await writer.prompt('session-a', {}, 'queue')
  assert.equal(outcome.kind, 'indeterminate')
  // The dispatch happened exactly once: an indeterminate settlement is never
  // automatically replayed, and the replacement generation does not make it a
  // proven rejection.
  assert.equal(harness.calls.promptCalls.length, 1)
})

test('queue edit/remove/steer address the exact occurrence id and preserve the action', async () => {
  const harness = writerHarness()
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const edit = { kind: 'edit' as const, content: [{ type: 'text', text: 'fixed' }] }
  assert.equal((await writer.updateQueue('session-a', 'item-7', edit)).kind, 'committed')
  assert.equal((await writer.updateQueue('session-a', 'item-7', { kind: 'remove' })).kind, 'committed')
  assert.equal((await writer.updateQueue('session-a', 'item-7', { kind: 'steer' })).kind, 'committed')
  assert.deepEqual(harness.calls.updateQueueCalls.map(call => [call.itemId, call.action]), [
    ['item-7', edit],
    ['item-7', { kind: 'remove' }],
    ['item-7', { kind: 'steer' }],
  ])
})

test('a queue-item-not-found refusal keeps its stable code and leaves the row to the snapshot', async () => {
  const harness = writerHarness()
  harness.setQueueResult({ ok: false, error: new RemoteError('session/queue-item-not-found', 'gone', { itemId: 'item-7' as never }) })
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const outcome = await writer.updateQueue('session-a', 'item-7', { kind: 'remove' })
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.kind === 'rejected' ? outcome.error.code : undefined, 'session/queue-item-not-found')
})

test('a queue EDIT business rejection is rejected with its stable code and exact content preserved', async () => {
  const harness = writerHarness()
  harness.setQueueResult({ ok: false, error: { code: 'session/attachment-invalid', message: 'queue edits accept text content only' } })
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const edit = { kind: 'edit' as const, content: [{ type: 'text', text: 'fixed' }] }
  const outcome = await writer.updateQueue('session-a', 'item-7', edit)
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.kind === 'rejected' ? outcome.error.code : undefined, 'session/attachment-invalid')
  assert.deepEqual(harness.calls.updateQueueCalls[0]?.action, edit)
})

test('a queue EDIT carrier failure is indeterminate, never replayed', async () => {
  const harness = writerHarness()
  harness.setQueueResult({ ok: false, error: { code: 'gateway/internal', message: 'carrier reset' } })
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const outcome = await writer.updateQueue('session-a', 'item-7', { kind: 'edit', content: [{ type: 'text', text: 'fixed' }] })
  assert.equal(outcome.kind, 'indeterminate')
  assert.equal(harness.calls.updateQueueCalls.length, 1)
})

test('a queue STEER refusal keeps session/steer-unavailable and leaves the occurrence to the snapshot', async () => {
  const harness = writerHarness()
  harness.setQueueResult({ ok: false, error: new RemoteError('session/steer-unavailable', 'not running', { itemId: 'item-7' as never }) })
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const outcome = await writer.updateQueue('session-a', 'item-7', { kind: 'steer' })
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.kind === 'rejected' ? outcome.error.code : undefined, 'session/steer-unavailable')
})

test('a generation replaced AFTER dispatch on updateQueue is indeterminate, never replayed', async () => {
  const harness = writerHarness()
  harness.setQueueHook(() => harness.generation.set({ id: 2 }))
  harness.setQueueResult({ ok: false, error: { code: 'gateway/internal', message: 'carrier reset' } })
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const outcome = await writer.updateQueue('session-a', 'item-7', { kind: 'remove' })
  assert.equal(outcome.kind, 'indeterminate')
  assert.equal(harness.calls.updateQueueCalls.length, 1)
})

test('a generation replaced while resolving the binding cancels an updateQueue before dispatch', async () => {
  const harness = writerHarness()
  const captured = harness.generation.source
  // The generation moves between the pre-dispatch capture and the binding
  // resolution; the occurrence write must not be dispatched.
  const sessions: RemoteWriteSessionsSource = {
    binding: id => {
      harness.generation.set({ id: 2 })
      return harness.source.binding(id)
    },
  }
  const writer = new RemoteSessionWriter(sessions, captured, okSerializer())
  assert.deepEqual(await writer.updateQueue('session-a', 'item-7', { kind: 'remove' }), { kind: 'cancelled' })
  assert.equal(harness.calls.updateQueueCalls.length, 0)
})

test('cancel maps the official verb without Direct knobs crossing the boundary', async () => {
  const harness = writerHarness()
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  assert.equal((await writer.cancel('session-a')).kind, 'committed')
  assert.equal(harness.calls.cancelCalls, 1)
})

test('rename returns the normalized accepted title and keeps the old one on rejection', async () => {
  const harness = writerHarness()
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  assert.deepEqual(await writer.rename('session-a', '  spaced  '), { kind: 'committed', value: { title: 'accepted' } })
  harness.setRenameResult({ ok: false, error: new RemoteError('session/title-invalid', 'invalid', { sessionId: 'session-a' as never }) })
  const rejected = await writer.rename('session-a', '   ')
  assert.equal(rejected.kind, 'rejected')
  assert.equal(rejected.kind === 'rejected' ? rejected.error.code : undefined, 'session/title-invalid')
})

test('refreshTitle is explicitly unsupported on the Remote path', async () => {
  const harness = writerHarness()
  const writer = new RemoteSessionWriter(harness.source, harness.generation.source, okSerializer())
  const outcome = await writer.refreshTitle('session-a', new AbortController().signal)
  assert.equal(outcome.kind, 'unsupported')
})
