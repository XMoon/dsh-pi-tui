/**
 * Contract tests for the Direct Host command execution port (D2.1). Claim
 * precedence remains in the runner; this seam must forward the selected full
 * line, existing attachments, live session identity and cancellation signal.
 * @module @xmoon76/dsh-pi-tui/host-command-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectHostCommandPort, type HostContextLike } from '../src/runtime/direct/host-command-direct.ts'

function host(services: unknown, live: Map<string, { session: { id: string } }>): HostContextLike {
  return {
    get(name: string): unknown {
      if (name === 'commands') return services
      return undefined
    },
  }
}

test('forwards the full selected line, attachments, live agent and signal', async () => {
  const liveAgent = { session: { id: 'session-a' } }
  const live = new Map([['session-a', liveAgent]])
  const attachments = [{ type: 'image', data: 'bytes' }]
  const signal = new AbortController().signal
  const calls: unknown[] = []
  const execution = { commandId: 'command-1', result: { kind: 'success' as const, text: 'done' } }
  const port = new DirectHostCommandPort(host({
    execute: async (agent: unknown, line: string, received: readonly unknown[], receivedSignal: AbortSignal) => {
      calls.push({ agent, line, attachments: received, signal: receivedSignal })
      return execution
    },
  }, live), sessionId => live.get(sessionId))

  const outcome = await port.execute({
    sessionId: 'session-a',
    line: '/export   report',
    attachments,
    signal,
  })
  assert.deepEqual(outcome, { kind: 'committed', matched: true, execution })
  assert.deepEqual(calls, [{ agent: liveAgent, line: '/export   report', attachments, signal }])
})

test('maps an unmatched official command to committed matched:false', async () => {
  const live = new Map([['session-a', { session: { id: 'session-a' } }]])
  const port = new DirectHostCommandPort(host({ execute: async () => undefined }, live), sessionId => live.get(sessionId))
  assert.deepEqual(await port.execute({ sessionId: 'session-a', line: '/unknown', attachments: [], signal: new AbortController().signal }), {
    kind: 'committed',
    matched: false,
  })
})

test('resolves a replacement live Agent on the next call', async () => {
  const first = { session: { id: 'session-a' } }
  const second = { session: { id: 'session-a' } }
  let current = first
  const seen: unknown[] = []
  const port = new DirectHostCommandPort(host({
    execute: async (agent: unknown) => {
      seen.push(agent)
      return { result: { kind: 'success' } }
    },
  }, new Map()), sessionId => sessionId === 'session-a' ? current : undefined)
  await port.execute({ sessionId: 'session-a', line: '/one', attachments: [], signal: new AbortController().signal })
  current = second
  await port.execute({ sessionId: 'session-a', line: '/two', attachments: [], signal: new AbortController().signal })
  assert.deepEqual(seen, [first, second])
})

test('an already-aborted signal before dispatch settles cancelled without executing', async () => {
  const live = new Map([['session-a', { session: { id: 'session-a' } }]])
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const port = new DirectHostCommandPort(host({
    execute: async () => { calls += 1; return undefined },
  }, live), sessionId => live.get(sessionId))
  // A signal already aborted BEFORE dispatch proves the command never ran, so
  // this is a known cancellation and the executor is not invoked.
  assert.deepEqual(
    await port.execute({ sessionId: 'session-a', line: '/command', attachments: [], signal: controller.signal }),
    { kind: 'cancelled' },
  )
  assert.equal(calls, 0)
})

test('maps non-cancellation command exceptions to indeterminate', async () => {
  const unreadable = new Error('unreadable command error')
  Object.defineProperty(unreadable, 'message', { get: () => { throw new Error('message getter failure') } })
  for (const [failure, message] of [
    [new Error('command invariant failure'), 'command invariant failure'],
    ['non-error command failure', 'non-error command failure'],
    [{ toString: () => { throw new Error('coercion failure') } }, '<unprintable error>'],
    [unreadable, '<error with unreadable message>'],
  ] as const) {
    const live = new Map([['session-a', { session: { id: 'session-a' } }]])
    const port = new DirectHostCommandPort(host({
      execute: async () => { throw failure },
    }, live), sessionId => live.get(sessionId))
    assert.deepEqual(await port.execute({ sessionId: 'session-a', line: '/x', attachments: [], signal: new AbortController().signal }), {
      kind: 'indeterminate',
      error: { code: 'session/write-indeterminate', message },
    })
  }
})

test('a cancellation-shaped exception AFTER dispatch is indeterminate, never a known cancellation', async () => {
  const failure = new Error('command cancelled')
  failure.name = 'AbortError'
  const live = new Map([['session-a', { session: { id: 'session-a' } }]])
  const port = new DirectHostCommandPort(host({
    execute: async () => { throw failure },
  }, live), sessionId => live.get(sessionId))
  // The pinned executor appends command/run before the handler, so an aborted
  // handler may already have run: the outcome cannot claim "not executed".
  assert.deepEqual(await port.execute({ sessionId: 'session-a', line: '/x', attachments: [], signal: new AbortController().signal }), {
    kind: 'indeterminate',
    error: { code: 'session/write-indeterminate', message: 'command cancelled' },
  })
})

test('rejects when the command service or live session is unavailable', async () => {
  const noService = new DirectHostCommandPort(host(undefined, new Map()), () => undefined)
  assert.deepEqual(await noService.execute({ sessionId: 'session-a', line: '/x', attachments: [], signal: new AbortController().signal }), {
    kind: 'rejected',
    error: { code: 'service/unavailable', message: 'commands service unavailable' },
  })
  const noSession = new DirectHostCommandPort(host({ execute: async () => undefined }, new Map()), () => undefined)
  assert.deepEqual(await noSession.execute({ sessionId: 'session-a', line: '/x', attachments: [], signal: new AbortController().signal }), {
    kind: 'rejected',
    error: { code: 'session/not-found', message: 'session "session-a" is not available' },
  })
})
