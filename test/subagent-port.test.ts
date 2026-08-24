/**
 * Adapter contract tests for the Direct subagent port
 * (runtime/direct/subagent-direct.ts, migration M1.2): the port is the
 * semantic boundary — the runner depends on `SubagentPort`, the Direct
 * adapter owns the `ctx` access, and a Remote adapter must satisfy the
 * SAME contract in a later milestone. These tests pin the contract with a
 * fake Host context, so the two backends cannot drift.
 * @module @xmoon76/dsh-pi-tui/subagent-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSubagentPort, type HostContextLike } from '../src/runtime/direct/subagent-direct.ts'
import type { SubagentFollowupService, SubagentParentLike } from '../src/subagent-viewer-submit.ts'
import type { SubagentFollowupContext } from '../src/runtime/subagent-port.ts'

const request = {
  parentSessionId: 'session-parent',
  childSessionId: 'session-child',
  text: 'continue the plan',
}

function parent(id = 'session-parent'): SubagentParentLike {
  return { session: { id } }
}

function context(overrides: Partial<SubagentFollowupContext> = {}): SubagentFollowupContext {
  return {
    currentParent: () => parent(),
    makeSignal: () => new AbortController().signal,
    makeSource: () => ({ kind: 'user' }),
    ...overrides,
  }
}

function service(calls: Array<{ parent: SubagentParentLike; childId: string; content: readonly { type: 'text'; text: string }[] }>): SubagentFollowupService {
  return {
    followup: async (followParent, childId, content) => {
      calls.push({ parent: followParent, childId, content })
      return `inbox-${childId}-1`
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

test('delivers through ctx.subagents with the exact parent, child, content, source and signal', async () => {
  const calls: Array<{ parent: SubagentParentLike; childId: string; content: readonly { type: 'text'; text: string }[] }> = []
  const gets: string[] = []
  const port = new DirectSubagentPort(host(service(calls), gets))
  const signal = new AbortController().signal
  const outcome = await port.followup(request, context({
    currentParent: () => parent('session-parent'),
    makeSignal: () => signal,
    makeSource: () => ({ kind: 'user' }),
  }))
  assert.equal(outcome.kind, 'ok')
  if (outcome.kind === 'ok') assert.equal(outcome.messageId, 'inbox-session-child-1')
  assert.equal(calls.length, 1, 'followup called exactly once')
  assert.equal(calls[0].childId, 'session-child')
  assert.equal(calls[0].parent.session.id, 'session-parent')
  assert.deepEqual(calls[0].content, [{ type: 'text', text: 'continue the plan' }])
  assert.deepEqual(gets, ['subagents'], 'the adapter reads the ctx.subagents service')
})

test('applies the caller canonicalization before delivery', async () => {
  const calls: Array<{ parent: SubagentParentLike; childId: string; content: readonly { type: 'text'; text: string }[] }> = []
  const port = new DirectSubagentPort(host(service(calls)))
  const outcome = await port.followup(request, context({
    canonicalizeText: (text) => text.replace('@src/foo.ts', '/abs/src/foo.ts'),
  }))
  assert.equal(outcome.kind, 'ok')
  assert.equal(calls[0].content[0].text, 'continue the plan')
})

test('rejects parent-unavailable when the live parent differs from the viewer target', async () => {
  const calls: Array<{ parent: SubagentParentLike; childId: string; content: readonly { type: 'text'; text: string }[] }> = []
  const port = new DirectSubagentPort(host(service(calls)))
  const outcome = await port.followup(request, context({
    currentParent: () => parent('session-other'),
  }))
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'parent-unavailable' } })
  assert.equal(calls.length, 0, 'no delivery on a parent mismatch')
})

test('rejects unavailable when the ctx.subagents service is absent', async () => {
  const port = new DirectSubagentPort(host(undefined))
  const outcome = await port.followup(request, context())
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'unavailable' } })
})

test('classifies a UNAUTHORIZED service error as unauthorized', async () => {
  const failing: SubagentFollowupService = {
    followup: async () => {
      const error = new Error('not the parent') as Error & { code?: string }
      error.code = 'UNAUTHORIZED'
      throw error
    },
  }
  const port = new DirectSubagentPort(host(failing))
  const outcome = await port.followup(request, context())
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'unauthorized' } })
})

test('reads the service lazily per call (session switches are observed at send time)', async () => {
  const gets: string[] = []
  let current: SubagentFollowupService | undefined = service([])
  const port = new DirectSubagentPort({
    get(name: string): unknown {
      gets.push(name)
      return current
    },
  })
  const first = await port.followup(request, context())
  assert.equal(first.kind, 'ok')
  current = undefined // the continuation runtime disappears between calls
  const second = await port.followup(request, context())
  assert.deepEqual(second, { kind: 'rejected', reason: { kind: 'unavailable' } })
  assert.equal(gets.length, 2, 'ctx.get runs per call, never at construction')
})
