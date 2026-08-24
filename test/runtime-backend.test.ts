/**
 * Vocabulary tests for the runtime backend (M1.1): the capability list is
 * the migration's domain vocabulary, and the Direct backend is the current
 * production surface. These pin the vocabulary so a later milestone cannot
 * silently drop or rename a capability the ports depend on.
 * @module @xmoon76/dsh-pi-tui/runtime-backend.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CAPABILITIES } from '../src/runtime/capability.ts'
import { directBackend } from '../src/runtime/backend.ts'

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
  assert.equal(directBackend.kind, 'direct')
  for (const capability of CAPABILITIES) {
    assert.ok(directBackend.capabilities.has(capability), `direct serves ${capability}`)
  }
})
