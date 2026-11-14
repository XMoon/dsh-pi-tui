/**
 * FR3 — the Direct MCP configuration-source read.
 *
 * Evidence level: unit/contract (L2). The READ-ONLY key set comes from the
 * official in-process `mcp-manager` settings descriptor; it never exposes a
 * namespace, entry, transport or secret, and a missing/unreadable section is
 * `unavailable` (never an empty configured list).
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/mcp-server-sources-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectMcpServerSourcesConfig, type HostContextLike } from '../../../src/runtime/direct/config-direct.ts'

function contextWith(settings: unknown): HostContextLike {
  return { get: name => (name === 'settings' ? settings : undefined) }
}

test('a readable mcp-manager section yields its effective configured keys', () => {
  const config = new DirectMcpServerSourcesConfig(contextWith({
    describe: () => [{
      ns: 'mcp-manager',
      value: { servers: { alpha: { transport: 'stdio' }, beta: { transport: 'streamable-http' } } },
      revision: 4,
    }],
  }))
  assert.deepEqual(config.read(), { kind: 'ready', configuredNames: ['alpha', 'beta'], revision: 4 })
})

test('an empty server map is a real ready empty list', () => {
  const config = new DirectMcpServerSourcesConfig(contextWith({
    describe: () => [{ ns: 'mcp-manager', value: { servers: {} }, revision: 0 }],
  }))
  assert.deepEqual(config.read(), { kind: 'ready', configuredNames: [], revision: 0 })
})

test('a missing settings service or namespace is unavailable', () => {
  assert.equal(new DirectMcpServerSourcesConfig(contextWith(undefined)).read().kind, 'unavailable')
  const config = new DirectMcpServerSourcesConfig(contextWith({ describe: () => [{ ns: 'llm-pi-ai', value: {} }] }))
  assert.equal(config.read().kind, 'unavailable')
})

test('an unreadable servers field is unavailable, never an empty configured set', () => {
  for (const value of [{}, { servers: 'not-a-map' }, { servers: [] }]) {
    const config = new DirectMcpServerSourcesConfig(contextWith({ describe: () => [{ ns: 'mcp-manager', value }] }))
    assert.equal(config.read().kind, 'unavailable')
  }
})

test('a throwing descriptor projection degrades to unavailable', () => {
  const config = new DirectMcpServerSourcesConfig(contextWith({ describe: () => { throw new Error('projection failed') } }))
  assert.equal(config.read().kind, 'unavailable')
})

test('Direct refresh resolves immediately (the read is already current)', async () => {
  const config = new DirectMcpServerSourcesConfig(contextWith({ describe: () => [] }))
  await config.refresh()
})
