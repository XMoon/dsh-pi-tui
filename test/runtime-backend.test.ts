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
  const backend = createDirectBackend(subagent)
  assert.equal(backend.kind, 'direct')
  assert.equal(backend.subagent, subagent)
  for (const capability of CAPABILITIES) {
    assert.ok(backend.capabilities.has(capability), `direct serves ${capability}`)
  }
})
