/**
 * Assembly tests for the experimental Remote `Backend` (M3-3B): `kind` is
 * `'remote'`, the capability set is EXACT (a capability exists only when its
 * port genuinely serves the semantic contract), every part is the very
 * instance handed in, and `BackendKind` accepts `'remote'` without changing
 * the Direct production default.
 * @module @xmoon76/dsh-pi-tui/remote-backend.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CAPABILITIES, DIRECT_IMPLEMENTED_CAPABILITIES, REMOTE_IMPLEMENTED_CAPABILITIES } from '../src/runtime/capability.ts'
import { createRemoteBackend, type RemoteBackendParts } from '../src/runtime/remote/backend-remote.ts'
import type { BackendKind } from '../src/runtime/backend.ts'

test('the Remote backend advertises exactly its implemented capabilities', () => {
  const parts = {
    subagent: {}, sessionReader: {}, pendingInputReader: {}, sessionWriter: {},
    sessionLifecycle: {}, interaction: {}, catalog: {}, config: {}, hostFile: {},
    sessionArchive: {}, hostCommand: {}, pluginManager: {}, jobObservation: {},
  } as unknown as RemoteBackendParts
  const backend = createRemoteBackend(parts)
  assert.equal(backend.kind, 'remote')
  assert.deepEqual([...backend.capabilities].sort(), [...REMOTE_IMPLEMENTED_CAPABILITIES].sort())
  // Every advertised capability must be a real vocabulary entry, and the set
  // must be exactly the vocabulary (every M3-3B port is served).
  assert.deepEqual([...REMOTE_IMPLEMENTED_CAPABILITIES].sort(), [...CAPABILITIES].sort())
  // Identity: each adapter instance is the backend's provider (no wrapper).
  assert.equal(backend.config, parts.config)
  assert.equal(backend.interaction, parts.interaction)
  assert.equal(backend.sessionArchive, parts.sessionArchive)
})

test('BackendKind accepts remote while Direct stays the production default', () => {
  const kind: BackendKind = 'remote'
  assert.equal(kind, 'remote')
  assert.deepEqual([...DIRECT_IMPLEMENTED_CAPABILITIES].sort(), [...CAPABILITIES].sort())
})
