/**
 * Vocabulary tests for the runtime backend (M1.1/M1.2): the capability list
 * is the migration's domain vocabulary, and the Direct backend is the
 * current production surface. These pin the vocabulary so a later
 * milestone cannot silently drop or rename a capability the ports depend
 * on.
 * @module @xmoon76/dsh-pi-tui/runtime-backend.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CAPABILITIES } from '../src/runtime/capability.ts'
import { createDirectBackend } from '../src/runtime/backend.ts'
import type { SubagentPort } from '../src/runtime/subagent-port.ts'

test('the capability vocabulary covers the migration domains', () => {
  assert.deepEqual(CAPABILITIES, [
    'session-read',
    'session-write',
    'session-lifecycle',
    'subagent',
    'interaction',
    'catalog',
    'config',
    'host-file',
  ])
})

test('the Direct backend is the current production surface and serves every capability', () => {
  const subagent: SubagentPort = {
    followup: async () => ({ kind: 'rejected', reason: { kind: 'unavailable' } }),
  }
  const sessionReader = {
    list: async () => [],
    search: async () => [],
    titles: async () => new Map(),
  }
  const sessionWriter = {
    followup: () => {},
    steer: async () => 'ok' as const,
    dequeue: () => {},
    cancel: () => {},
    rename: () => true,
    refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
  }
  const sessionLifecycle = {
    create: async () => ({}) as never,
    resume: async () => ({}) as never,
  }
  const backend = createDirectBackend(subagent, sessionReader, sessionWriter, sessionLifecycle)
  assert.equal(backend.kind, 'direct')
  assert.equal(backend.subagent, subagent)
  assert.equal(backend.sessionReader, sessionReader)
  assert.equal(backend.sessionWriter, sessionWriter)
  assert.equal(backend.sessionLifecycle, sessionLifecycle)
  for (const capability of CAPABILITIES) {
    assert.ok(backend.capabilities.has(capability), `direct serves ${capability}`)
  }
})
