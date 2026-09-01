/**
 * Adapter contract tests for the Direct subagent port
 * (runtime/direct/subagent-direct.ts, migration M1.2): the port is the
 * semantic boundary — the runner depends on `SubagentPort`, the Direct
 * adapter owns the `ctx` access and the requestId minting, and a Remote
 * adapter must satisfy the SAME contract in a later milestone. These tests
 * pin the contract with a fake Host context, so the two backends cannot
 * drift.
 * @module @xmoon76/dsh-pi-tui/subagent-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSubagentPort, type HostContextLike } from '../src/runtime/direct/subagent-direct.ts'
import type { SubagentPromptService } from '../src/subagent-viewer-submit.ts'
import type { SubagentPromptContext } from '../src/runtime/subagent-port.ts'

const request = {
  parentSessionId: 'session-parent',
  childSessionId: 'session-child',
  content: [{ type: 'text' as const, text: 'continue the plan' }],
}

function context(overrides: Partial<SubagentPromptContext> = {}): SubagentPromptContext {
  return {
    makeSignal: () => new AbortController().signal,
    ...overrides,
  }
}

interface RecordedCall {
  requestId: string
  parentSessionId: string
  childSessionId: string
  mode: string
  content: readonly { type: 'text'; text: string }[]
}

function service(calls: RecordedCall[]): SubagentPromptService {
  return {
    prompt: async (payload) => {
      calls.push({
        requestId: payload.requestId,
        parentSessionId: payload.parentSessionId,
        childSessionId: payload.childSessionId,
        mode: payload.mode,
        content: payload.content,
      })
      return { messageId: `inbox-${payload.childSessionId}-1` }
    },
  }
}

function host(serviceValue: unknown, gets: string[] = []): HostContextLike {
  return {
    get(name: string): unknown {
      gets.push(name)
      return serviceValue
    },
  }
}

test('delivers through ctx.subagents.prompt with the official request shape and a minted requestId', async () => {
  const calls: RecordedCall[] = []
  const gets: string[] = []
  const port = new DirectSubagentPort(host(service(calls), gets))
  const signal = new AbortController().signal
  const outcome = await port.prompt(request, context({ makeSignal: () => signal }))
  assert.equal(outcome.kind, 'ok')
  if (outcome.kind === 'ok') assert.equal(outcome.messageId, 'inbox-session-child-1')
  assert.equal(calls.length, 1, 'prompt called exactly once')
  assert.equal(calls[0].parentSessionId, 'session-parent')
  assert.equal(calls[0].childSessionId, 'session-child')
  assert.equal(calls[0].mode, 'continuable')
  assert.deepEqual(calls[0].content, request.content)
  assert.match(calls[0].requestId, /^[0-9a-f-]{36}$/u, 'the adapter mints a UUID identity before the call')
  assert.deepEqual(gets, ['subagents'], 'the adapter reads the ctx.subagents service')
})

test('applies the caller canonicalization before delivery', async () => {
  const calls: RecordedCall[] = []
  const port = new DirectSubagentPort(host(service(calls)))
  const outcome = await port.prompt(
    { ...request, content: [{ type: 'text', text: 'check @src/foo.ts' }] },
    context({ canonicalizeText: (text) => text.replace('@src/foo.ts', '/abs/src/foo.ts') }),
  )
  assert.equal(outcome.kind, 'ok')
  assert.equal(calls[0].content[0].text, 'check /abs/src/foo.ts')
})

test('rejects unavailable when the ctx.subagents service is absent', async () => {
  const port = new DirectSubagentPort(host(undefined))
  const outcome = await port.prompt(request, context())
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'unavailable' } })
})

test('classifies an official subagent/unauthorized service error as unauthorized', async () => {
  const failing: SubagentPromptService = {
    prompt: async () => {
      const error = new Error('subagent does not belong to this parent') as Error & { code?: string }
      error.code = 'subagent/unauthorized'
      throw error
    },
  }
  const port = new DirectSubagentPort(host(failing))
  const outcome = await port.prompt(request, context())
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'unauthorized' } })
})

test('reads the service lazily per call (session switches are observed at send time)', async () => {
  const gets: string[] = []
  let current: SubagentPromptService | undefined = service([])
  const port = new DirectSubagentPort({
    get(name: string): unknown {
      gets.push(name)
      return current
    },
  })
  const first = await port.prompt(request, context())
  assert.equal(first.kind, 'ok')
  current = undefined // the continuation runtime disappears between calls
  const second = await port.prompt(request, context())
  assert.deepEqual(second, { kind: 'rejected', reason: { kind: 'unavailable' } })
  assert.equal(gets.length, 2, 'ctx.get runs per call, never at construction')
})
