/**
 * Contract tests for the Client-owned command execution registry (M3-4 PR4
 * Step 1 / plan §D2): registration/lookup/disposal, the Client-side
 * execution identity, result normalization, the official admission-vocabulary
 * miss, and the negative locks — no `ctx.commands`, no Host id, no callback
 * escaping the registry boundary.
 * @module @xmoon76/dsh-pi-tui/client-command-registry.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { createClientCommandRegistry } from '../src/app/command/client-command-registry.ts'

test('register/lookup/list/dispose: Client-owned definitions live only in the registry', () => {
  const registry = createClientCommandRegistry(parseCommand)
  const dispose = registry.register({
    name: 'display',
    description: 'display preset',
    handler: () => ({ kind: 'success' as const }),
  })
  registry.register({ name: 'alpha', description: 'a', handler: () => ({ kind: 'success' as const }) })
  assert.equal(registry.get('display')?.description, 'display preset')
  assert.equal(registry.get('missing'), undefined)
  // Name-sorted list like the official registry's listing contract.
  assert.deepEqual(registry.list().map(definition => definition.name), ['alpha', 'display'])
  dispose()
  assert.equal(registry.get('display'), undefined, 'the disposer removes exactly its registration')
  // A re-registration under the same name replaces the previous definition.
  const second = { name: 'alpha', description: 'replaced', handler: () => ({ kind: 'success' as const }) } as const
  registry.register(second)
  assert.equal(registry.get('alpha')?.description, 'replaced')
})

test('execute: a Client handler runs in-process with a Client-minted correlation id', async () => {
  const registry = createClientCommandRegistry(parseCommand)
  const seen: { commandId: string; rawInput: string }[] = []
  registry.register({
    name: 'status',
    description: 'stats',
    handler: (invocation) => {
      seen.push({ commandId: invocation.commandId, rawInput: invocation.rawInput })
      return { kind: 'success', text: 'ok' }
    },
  })
  const execution = await registry.execute({ line: '/status extra', signal: new AbortController().signal })
  assert.ok(execution !== undefined)
  assert.equal(execution.result.kind, 'success')
  assert.equal((execution.result as { text?: string }).text, 'ok')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.rawInput, ' extra', 'rawInput keeps the separator whitespace, like the official parse')
  assert.match(seen[0]!.commandId, /^cmd-client-/, 'the execution identity is Client-minted, never a Host command id')
  assert.equal(execution.commandId, seen[0]!.commandId, 'the returned pairing id matches the invocation')
})

test('execute: an unresolved name or non-command line is the official admission miss (undefined)', async () => {
  const registry = createClientCommandRegistry(parseCommand)
  registry.register({ name: 'display', description: 'd', handler: () => ({ kind: 'success' as const }) })
  assert.equal(await registry.execute({ line: 'plain text', signal: new AbortController().signal }), undefined)
  assert.equal(await registry.execute({ line: '/unknown', signal: new AbortController().signal }), undefined)
})

test('execute: a throwing handler rejects (the caller owns the failure settlement)', async () => {
  const registry = createClientCommandRegistry(parseCommand)
  registry.register({
    name: 'boom',
    description: 'throws',
    handler: () => { throw new Error('handler failed') },
  })
  await assert.rejects(
    () => registry.execute({ line: '/boom', signal: new AbortController().signal }),
    /handler failed/,
  )
})

test('negative lock: the registry module never reaches a Host commands service', () => {
  const source = readFileSync(new URL('../src/app/command/client-command-registry.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.equal(code.includes('ctx.commands'), false, 'the registry never calls the Host commands service')
  assert.equal(code.includes('commands.execute'), false, 'the registry never forwards execution to the Host')
  assert.equal(code.includes("ctx.get('"), false, 'the registry performs no Host service lookup')
})
