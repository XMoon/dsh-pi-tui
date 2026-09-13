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

test('does not rewrite an already-aborted signal before official execution', async () => {
  const live = new Map([['session-a', { session: { id: 'session-a' } }]])
  const controller = new AbortController()
  controller.abort()
  let receivedSignal: AbortSignal | undefined
  const port = new DirectHostCommandPort(host({
    execute: async (_agent: unknown, _line: string, _attachments: readonly unknown[], signal: AbortSignal) => {
      receivedSignal = signal
      return undefined
    },
  }, live), sessionId => live.get(sessionId))
  await port.execute({ sessionId: 'session-a', line: '/command', attachments: [], signal: controller.signal })
  assert.equal(receivedSignal, controller.signal)
})

test('unexpected command exceptions reject instead of claiming committed', async () => {
  const failure = new Error('command invariant failure')
  const live = new Map([['session-a', { session: { id: 'session-a' } }]])
  const port = new DirectHostCommandPort(host({
    execute: async () => { throw failure },
  }, live), sessionId => live.get(sessionId))
  await assert.rejects(port.execute({ sessionId: 'session-a', line: '/x', attachments: [], signal: new AbortController().signal }), failure)
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
