/**
 * Contract tests for the D2.2 Remote subagent port: continuation prompts use the
 * official `subagents.prompt` address with a fresh pre-call identity, and
 * interruption uses `interruptByParent` with the exact durable direct parent.
 * @module @xmoon76/dsh-pi-tui/remote-subagent-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentPromptRequest } from '@deepseek-ai/dsh-subagent/client'
import {
  RemoteSubagentPort,
  type RemoteSubagentPromptRequest,
  type RemoteSubagentSource,
} from '../src/runtime/remote/subagent-remote.ts'
import type { SubagentPromptContext } from '../src/runtime/subagent-port.ts'

interface PromptCall {
  readonly request: RemoteSubagentPromptRequest
  readonly signal: AbortSignal | undefined
}

interface Harness {
  readonly port: RemoteSubagentPort
  readonly promptCalls: PromptCall[]
  readonly interruptCalls: { child: string; parent: string; mode: string }[]
  setPromptResult(result: { ok: true; value: { messageId: unknown } } | { ok: false; error: unknown }): void
  setInterruptResult(result: { ok: true; value: { accepted: true } } | { ok: false; error: unknown }): void
  setPromptThrows(error: unknown): void
}

function harness(): Harness {
  const promptCalls: PromptCall[] = []
  const interruptCalls: { child: string; parent: string; mode: string }[] = []
  let promptResult: { ok: true; value: { messageId: unknown } } | { ok: false; error: unknown } = {
    ok: true,
    value: { messageId: 'msg-1' },
  }
  let promptThrows: unknown
  let interruptResult: { ok: true; value: { accepted: true } } | { ok: false; error: unknown } = {
    ok: true,
    value: { accepted: true },
  }
  const source: RemoteSubagentSource = {
    prompt: async (request, signal) => {
      promptCalls.push({ request, signal })
      if (promptThrows !== undefined) throw promptThrows
      return promptResult
    },
    interruptByParent: async (child, parent, mode) => {
      interruptCalls.push({ child, parent, mode })
      return interruptResult
    },
  }
  return {
    port: new RemoteSubagentPort(source),
    promptCalls,
    interruptCalls,
    setPromptResult: value => { promptResult = value },
    setInterruptResult: value => { interruptResult = value },
    setPromptThrows: value => { promptThrows = value },
  }
}

function context(overrides: Partial<SubagentPromptContext> = {}): SubagentPromptContext {
  return {
    makeSignal: () => new AbortController().signal,
    ...overrides,
  }
}

test('the official subagent Remote surface satisfies the adapter boundary structurally', () => {
  const constructFromOfficial = (source: {
    prompt(
      request: SubagentPromptRequest,
      signal?: AbortSignal,
    ): Promise<{ ok: true; value: { messageId: string } } | { ok: false; error: unknown }>
    interruptByParent(
      childSessionId: SessionId,
      parentSessionId: SessionId,
      mode: 'continuable',
    ): Promise<{ ok: true; value: { accepted: true } } | { ok: false; error: unknown }>
  }): RemoteSubagentPort => new RemoteSubagentPort(source)
  assert.equal(typeof constructFromOfficial, 'function')
})

test('a continuation prompt carries the exact parent/child address and continuable mode', async () => {
  const h = harness()
  const outcome = await h.port.prompt(
    { parentSessionId: 'parent-1', childSessionId: 'child-1', delivery: 'queue', content: [{ type: 'text', text: 'hello' }] },
    context(),
  )
  assert.deepEqual(outcome, { kind: 'ok', messageId: 'msg-1' })
  assert.equal(h.promptCalls.length, 1)
  assert.equal(h.promptCalls[0]?.request.parentSessionId, 'parent-1')
  assert.equal(h.promptCalls[0]?.request.childSessionId, 'child-1')
  assert.equal(h.promptCalls[0]?.request.mode, 'continuable')
  assert.equal(h.promptCalls[0]?.request.delivery, 'queue')
})

test('each human submit mints a fresh pre-call request identity', async () => {
  const h = harness()
  const request = { parentSessionId: 'parent-1', childSessionId: 'child-1', delivery: 'steer' as const, content: [{ type: 'text' as const, text: 'again' }] }
  await h.port.prompt(request, context())
  await h.port.prompt(request, context())
  assert.equal(h.promptCalls.length, 2)
  assert.notEqual(h.promptCalls[0]?.request.requestId, h.promptCalls[1]?.request.requestId)
  assert.equal(h.promptCalls[0]?.request.delivery, 'steer')
})

test('viewer text is canonicalized against the child scope before delivery', async () => {
  const h = harness()
  await h.port.prompt(
    { parentSessionId: 'p', childSessionId: 'c', delivery: 'queue', content: [{ type: 'text', text: '@src/foo.ts' }] },
    context({ canonicalizeText: text => `/child/root/${text}` }),
  )
  assert.deepEqual(h.promptCalls[0]?.request.content, [{ type: 'text', text: '/child/root/@src/foo.ts' }])
})

test('an already-aborted pre-call signal is a cancelled rejection without delivery', async () => {
  const h = harness()
  const controller = new AbortController()
  controller.abort()
  const outcome = await h.port.prompt(
    { parentSessionId: 'p', childSessionId: 'c', delivery: 'queue', content: [{ type: 'text', text: 'x' }] },
    context({ makeSignal: () => controller.signal }),
  )
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'cancelled' } })
  assert.equal(h.promptCalls.length, 0)
})

test('a parent-unavailable refusal is classified without a false sent state', async () => {
  const h = harness()
  h.setPromptResult({ ok: false, error: new RemoteError('subagent/parent-unavailable', 'gone', { parentSessionId: 'p' as SessionId }) })
  const outcome = await h.port.prompt(
    { parentSessionId: 'p', childSessionId: 'c', delivery: 'queue', content: [{ type: 'text', text: 'x' }] },
    context(),
  )
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'parent-unavailable' } })
})

test('interrupt uses interruptByParent with the explicit direct parent and continuable mode', async () => {
  const h = harness()
  const outcome = await h.port.interrupt({ parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'continuable' })
  assert.deepEqual(outcome, { kind: 'committed' })
  assert.deepEqual(h.interruptCalls, [{ child: 'child-1', parent: 'parent-1', mode: 'continuable' }])
})

test('a deep descendant interrupt addresses its actual durable direct parent', async () => {
  const h = harness()
  await h.port.interrupt({ parentSessionId: 'mid-parent', childSessionId: 'deep-child', mode: 'continuable' })
  assert.deepEqual(h.interruptCalls, [{ child: 'deep-child', parent: 'mid-parent', mode: 'continuable' }])
})

test('an unauthorized interrupt is rejected and never reported as stopped', async () => {
  const h = harness()
  h.setInterruptResult({ ok: false, error: new RemoteError('subagent/unauthorized', 'not yours', { childSessionId: 'child-1' as SessionId }) })
  const outcome = await h.port.interrupt({ parentSessionId: 'p', childSessionId: 'child-1', mode: 'continuable' })
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.kind === 'rejected' ? outcome.reason.kind : undefined, 'unauthorized')
})

test('a not-found child interrupt is an unavailable rejection, not a false stop', async () => {
  const h = harness()
  h.setInterruptResult({ ok: false, error: new RemoteError('subagent/not-found', 'missing', { parentSessionId: 'p' as SessionId, childSessionId: 'c' as SessionId }) })
  const outcome = await h.port.interrupt({ parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' })
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.kind === 'rejected' ? outcome.reason.kind : undefined, 'unavailable')
})

test('a plain wire interrupt failure keeps its human message, not [object Object]', async () => {
  const h = harness()
  h.setInterruptResult({ ok: false, error: { code: 'subagent/not-found', message: 'child is gone' } })
  const outcome = await h.port.interrupt({ parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' })
  assert.equal(outcome.kind, 'rejected')
  assert.deepEqual(outcome.kind === 'rejected' ? outcome.reason : undefined, {
    kind: 'unavailable',
    message: 'child is gone',
  })
})

test('a plain wire prompt carrier failure is indeterminate with its human message preserved', async () => {
  const h = harness()
  h.setPromptResult({ ok: false, error: { code: 'gateway/internal', message: 'carrier reset' } })
  const outcome = await h.port.prompt(
    { parentSessionId: 'p', childSessionId: 'c', delivery: 'queue', content: [{ type: 'text', text: 'x' }] },
    context(),
  )
  // The child may already own the message; never a proven "not sent".
  assert.deepEqual(outcome, { kind: 'indeterminate', message: 'carrier reset' })
})

test('a pre-dispatch canonicalization failure is rejected, never indeterminate', async () => {
  const h = harness()
  const outcome = await h.port.prompt(
    { parentSessionId: 'p', childSessionId: 'c', delivery: 'queue', content: [{ type: 'text', text: '@a' }] },
    context({ canonicalizeText: () => { throw new Error('mention failed') } }),
  )
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'error', message: 'mention failed' } })
  assert.equal(h.promptCalls.length, 0, 'prompt must not be called after a preparation failure')
})

test('a missing addressed child settles rejected stale-child, not indeterminate', async () => {
  const h = harness()
  h.setPromptResult({ ok: false, error: { code: 'subagent/not-found', message: 'gone' } })
  const outcome = await h.port.prompt(
    { parentSessionId: 'p', childSessionId: 'c', delivery: 'queue', content: [{ type: 'text', text: 'x' }] },
    context(),
  )
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'stale-child' } })
})

test('a prompt assembly fault propagates instead of becoming indeterminate', async () => {
  const h = harness()
  h.setPromptThrows(new Error('assembly fault'))
  // The generated Remote resolves carrier failures into RemoteResult; only an
  // assembly/programming defect rejects, and that must stay visible.
  await assert.rejects(
    () => h.port.prompt(
      { parentSessionId: 'p', childSessionId: 'c', delivery: 'queue', content: [{ type: 'text', text: 'x' }] },
      context(),
    ),
    /assembly fault/,
  )
})

test('a carrier failure on interrupt is indeterminate and never a false stop', async () => {
  const h = harness()
  h.setInterruptResult({ ok: false, error: { code: 'gateway/internal', message: 'carrier reset' } })
  const outcome = await h.port.interrupt({ parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' })
  assert.deepEqual(outcome, { kind: 'indeterminate', message: 'carrier reset' })
})

test('interrupt separates a pre-invocation gateway refusal from a post-invocation result failure', async () => {
  const h = harness()
  h.setInterruptResult({ ok: false, error: { code: 'gateway/invocation-unavailable', message: 'no active method' } })
  assert.deepEqual(
    await h.port.interrupt({ parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' }),
    { kind: 'rejected', reason: { kind: 'error', message: 'no active method' } },
  )
  h.setInterruptResult({ ok: false, error: { code: 'gateway/result-invalid', message: 'bad result' } })
  assert.deepEqual(
    await h.port.interrupt({ parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' }),
    { kind: 'indeterminate', message: 'bad result' },
  )
})

test('an unexpected prompt rejection keeps a proven domain refusal as rejected', async () => {
  const h = harness()
  h.setPromptResult({ ok: false, error: { code: 'subagent/delivery-unavailable', message: 'busy child' } })
  const outcome = await h.port.prompt(
    { parentSessionId: 'p', childSessionId: 'c', delivery: 'queue', content: [{ type: 'text', text: 'x' }] },
    context(),
  )
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'unavailable' } })
})
