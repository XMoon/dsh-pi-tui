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
import { CAPABILITIES, DIRECT_IMPLEMENTED_CAPABILITIES } from '../src/runtime/capability.ts'
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

test('the Direct backend is the current production surface and serves EXACTLY the implemented capabilities', () => {
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
  const interaction = {
    registerQuestionProvider: () => true,
    onApprovalRequest: () => {},
    setApprovalPolicy: () => true,
  }
  const backend = createDirectBackend(subagent, sessionReader, sessionWriter, sessionLifecycle, interaction)
  assert.equal(backend.kind, 'direct')
  assert.equal(backend.subagent, subagent)
  assert.equal(backend.sessionReader, sessionReader)
  assert.equal(backend.sessionWriter, sessionWriter)
  assert.equal(backend.sessionLifecycle, sessionLifecycle)
  assert.equal(backend.interaction, interaction)
  // Truthful advertisement: the backend serves ONLY the implemented ports
  // (catalog/config/host-file have no port yet — never advertised).
  for (const capability of DIRECT_IMPLEMENTED_CAPABILITIES) {
    assert.ok(backend.capabilities.has(capability), `direct serves ${capability}`)
  }
  for (const capability of ['catalog', 'config', 'host-file'] as const) {
    assert.ok(!backend.capabilities.has(capability), `direct does NOT advertise ${capability} (no port yet)`)
  }
})
