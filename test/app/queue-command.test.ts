/**
 * PR-Q L6 command surface: `/queue` admission.
 *
 * `/queue` is a sessionless, Client-local panel entry: the bare line opens the
 * ONE per-occurrence queue manager, it never sends the line to the agent, never
 * creates a Session and never shadows a genuine Host-origin command. The
 * argument shape is an explicit error, and the TSP renderer admits it only when
 * its native Queue sheet really mounted.
 *
 * @module @xmoon76/dsh-pi-tui/queue-command.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { registerQueueCommand } from '../../src/tui/commands/queue.ts'
import {
  HOST_COMMAND_CATALOG,
  LOCAL_COMMANDS,
  SESSIONLESS_COMMANDS,
  classifyCommandLine,
} from '../../src/domain/command/policy.ts'
import { TSP_SUPPORTED_TUI_BUILTINS, tspBuiltinAvailability } from '../../src/app/command/tsp-capability.ts'
import type { TuiCommandSpec } from '../../src/commands.ts'

function register(openQueueManager?: () => import('@deepseek-ai/dsh-commands').CommandResult): TuiCommandSpec {
  let spec: TuiCommandSpec | undefined
  registerQueueCommand({
    runner: openQueueManager === undefined ? {} : { openQueueManager },
    registerTuiCommand: value => { spec = value },
  })
  assert.ok(spec !== undefined, 'the command registered no specification')
  return spec
}

function invocation(rawInput: string): Parameters<TuiCommandSpec['handler']>[0] {
  return {
    commandId: 'command-1' as never,
    agent: {} as never,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  }
}

test('/queue is a reserved sessionless local command', () => {
  assert.ok(LOCAL_COMMANDS.has('queue'))
  assert.ok(SESSIONLESS_COMMANDS.has('queue'))
  assert.ok(HOST_COMMAND_CATALOG.has('queue'))
  const classification = classifyCommandLine({
    hostOriginClaim: undefined,
    tuiCommand: true,
    extensionCommand: false,
    skillInvocation: false,
  })
  assert.deepEqual(classification, { kind: 'client-command', source: 'tui' })
})

test('/queue forwards to the ONE manager opener and returns a normal success', async () => {
  let opened = 0
  const spec = register(() => {
    opened += 1
    return { kind: 'success' }
  })
  assert.equal(spec.name, 'queue')
  assert.equal(spec.description, 'Manage queued messages')
  assert.equal(spec.input, undefined, 'no argument grammar is declared')
  assert.deepEqual(await spec.handler(invocation('')), { kind: 'success' })
  assert.equal(opened, 1)
})

test('/queue with an argument is an explicit error and never opens the panel', async () => {
  let opened = 0
  const spec = register(() => {
    opened += 1
    return { kind: 'success' }
  })
  assert.deepEqual(await spec.handler(invocation('clear')), {
    kind: 'error',
    text: 'The /queue command does not accept arguments.',
  })
  assert.equal(opened, 0)
})

test('a headless runner without the manager opener reports an honest error', async () => {
  const spec = register()
  assert.deepEqual(await spec.handler(invocation('')), {
    kind: 'error',
    text: 'Queue management is unavailable on this renderer',
  })
})

test('a genuine Host-origin /queue claim outranks the Client-local entry', () => {
  const classification = classifyCommandLine({
    hostOriginClaim: { claimed: false },
    tuiCommand: true,
    extensionCommand: false,
    skillInvocation: false,
  })
  assert.deepEqual(classification, { kind: 'ordinary-submission', hostNameReserved: true })
  assert.ok(!TSP_SUPPORTED_TUI_BUILTINS.has('queue'), 'the native Queue sheet is capability-gated')
})

test('TSP admits /queue only with the native Queue sheet capability', () => {
  const facts = classifyCommandLine({
    hostOriginClaim: undefined,
    tuiCommand: true,
    extensionCommand: false,
    skillInvocation: false,
  })
  assert.deepEqual(tspBuiltinAvailability(facts, 'queue', { queueManager: true }, ''), { kind: 'available' })
  assert.deepEqual(tspBuiltinAvailability(facts, 'queue', {}, ''), { kind: 'unsupported' })
})
