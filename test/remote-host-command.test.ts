/**
 * Contract tests for the D2.2 Remote Host command port: the full line, declared
 * attachments, and the caller signal reach the official generated commands
 * Remote unchanged, and settlement is classified without a model fallback.
 * @module @xmoon76/dsh-pi-tui/remote-host-command.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { CommandSubmitAttachment } from '@deepseek-ai/dsh-commands/types'
import {
  RemoteHostCommandPort,
  type RemoteCommandsSource,
} from '../src/runtime/remote/host-command-remote.ts'
import type { HostCommandRequest } from '../src/runtime/host-command-port.ts'

interface CommandCall {
  readonly agentId: string
  readonly line: string
  readonly attachments: readonly unknown[]
  readonly signal: AbortSignal | undefined
}

interface Harness {
  readonly port: RemoteHostCommandPort
  readonly calls: CommandCall[]
  setResult(result: { ok: true; value: unknown } | { ok: false; error: unknown }): void
  setThrows(error: unknown): void
}

function harness(): Harness {
  const calls: CommandCall[] = []
  let result: { ok: true; value: unknown } | { ok: false; error: unknown } = { ok: true, value: undefined }
  let throws: unknown
  const source: RemoteCommandsSource = {
    execute: async (agentId, line, attachments, signal) => {
      calls.push({ agentId, line, attachments, signal })
      if (throws !== undefined) throw throws
      return result
    },
  }
  return {
    port: new RemoteHostCommandPort(source),
    calls,
    setResult: value => { result = value },
    setThrows: error => { throws = error },
  }
}

function request(overrides: Partial<HostCommandRequest> = {}): HostCommandRequest {
  return {
    sessionId: 'session-a',
    line: '/status extra args',
    attachments: [],
    signal: new AbortController().signal,
    ...overrides,
  }
}

test('the generated commands Remote accepts the structural command attachments', () => {
  const source: RemoteCommandsSource = {
    execute: async (_agentId, _line, attachments: readonly CommandSubmitAttachment[]) => attachments.length > 0
      ? { ok: true as const, value: { commandId: 'c' } }
      : { ok: true as const, value: undefined },
  }
  assert.equal(typeof source.execute, 'function')
})

test('the full original line, attachments, agent id, and signal are forwarded unchanged', async () => {
  const h = harness()
  const signal = new AbortController().signal
  const attachments = [{ type: 'image', data: 'AAAA', name: 'shot.png' }]
  await h.port.execute(request({ line: '/shot --flag value', attachments, signal }))
  assert.deepEqual(h.calls, [
    { agentId: 'session-a', line: '/shot --flag value', attachments, signal },
  ])
})

test('an undefined official result is a committed unmatched command, never a model prompt', async () => {
  const h = harness()
  h.setResult({ ok: true, value: undefined })
  assert.deepEqual(await h.port.execute(request()), { kind: 'committed', matched: false })
})

test('an official execution result is a committed matched command with its settled result', async () => {
  const h = harness()
  const execution = { commandId: 'cmd-1', result: { kind: 'success', text: 'ok' } }
  h.setResult({ ok: true, value: execution })
  const outcome = await h.port.execute(request())
  // The official value is the whole `CommandExecution`; the adapter must pass
  // it through unchanged so the runner keeps `execution.commandId`.
  assert.deepEqual(outcome, {
    kind: 'committed',
    matched: true,
    execution,
  })
  assert.equal(outcome.kind === 'committed' && outcome.matched ? (outcome.execution as { commandId?: string }).commandId : undefined, 'cmd-1')
})

test('a business RemoteFailure is rejected with its stable code', async () => {
  const h = harness()
  h.setResult({ ok: false, error: new RemoteError('gateway/bad-request', 'bad line', {}) })
  const outcome = await h.port.execute(request())
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.kind === 'rejected' ? outcome.error.code : undefined, 'gateway/bad-request')
})

test('a caller/backend cancellation is cancelled', async () => {
  const h = harness()
  h.setResult({ ok: false, error: new RemoteError('gateway/cancelled', 'cancelled', {}) })
  assert.deepEqual(await h.port.execute(request()), { kind: 'cancelled' })
})

test('a carrier failure after dispatch is indeterminate, never an automatic re-execution', async () => {
  const h = harness()
  h.setResult({ ok: false, error: new RemoteError('gateway/internal', 'carrier reset', {}) })
  const outcome = await h.port.execute(request())
  assert.equal(outcome.kind, 'indeterminate')
  assert.equal(h.calls.length, 1)
})

test('an unsupported attachment payload is rejected before a text-only execution', async () => {
  const h = harness()
  // The official contract refuses an attachment the command does not declare;
  // the adapter must propagate that refusal and never retry without them.
  h.setResult({ ok: false, error: new RemoteError('gateway/bad-request', 'attachments refused', {}) })
  const attachments = [{ type: 'file', receiptId: 'unresolved-local-file' }]
  const outcome = await h.port.execute(request({ line: '/needs-file', attachments }))
  assert.equal(outcome.kind, 'rejected')
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0]?.attachments, attachments)
})
