/**
 * Direct backend assembly tests (Pre-M3 PR1): the Direct semantic adapters are
 * constructed by ONE assembly owner and exposed only through `Backend`. The
 * Job observation port that P1 added as a runner-local side channel must be
 * served by the backend instead, so the migration can never grow a second
 * semantic port that bypasses the vocabulary.
 * @module @xmoon76/dsh-pi-tui/direct-backend-assembly.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createDirectRuntimeBackend } from '../src/runtime/direct/backend-direct.ts'
import { DIRECT_IMPLEMENTED_CAPABILITIES } from '../src/runtime/capability.ts'
import type { DirectBackendDeps } from '../src/runtime/direct/backend-direct.ts'
import type { Diag } from '../src/diag.ts'
import { compositionSource } from './support/composition-surface.ts'

function makeDeps(): DirectBackendDeps {
  const diag: Diag = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    dispose: () => {},
  }
  return {
    ctx: { get: () => undefined, on: () => () => {} },
    diag,
    tuiSettings: undefined,
    modelSelections: {
      current: () => undefined,
      appendSelection: () => {},
      setCurrent: () => {},
      selectForNextRequest: () => {},
      serializeImageAdmission: async (_agent, operation) => operation(),
    },
    ownerPool: { claim: () => undefined, park: () => {} },
    compose: async () => ({ setup: () => {} }),
    agentFor: () => undefined,
    queueAgentFor: () => undefined,
    liveResolvers: { sessionOf: () => undefined, agentOf: () => undefined },
  }
}

test('the Direct assembly exposes the Job observation port through the Backend', () => {
  const backend = createDirectRuntimeBackend(makeDeps())
  assert.equal(backend.kind, 'direct')
  assert.equal(typeof backend.jobObservation.open, 'function')
  assert.equal(typeof backend.pluginManager.snapshot, 'function')
  assert.ok(backend.capabilities.has('job-observation'))
  assert.deepEqual([...backend.capabilities].sort(), [...DIRECT_IMPLEMENTED_CAPABILITIES].sort())
})

test('each backend domain is served by its own adapter instance', () => {
  const backend = createDirectRuntimeBackend(makeDeps())
  const ports = [
    backend.subagent,
    backend.sessionReader,
    backend.pendingInputReader,
    backend.sessionWriter,
    backend.sessionLifecycle,
    backend.interaction,
    backend.catalog,
    backend.config,
    backend.hostFile,
    backend.sessionArchive,
    backend.hostCommand,
    backend.pluginManager,
    backend.jobObservation,
  ]
  assert.equal(new Set(ports).size, ports.length, 'no adapter instance may serve two domains')
})

test('the runner no longer constructs the Direct Job observation adapter itself', () => {
  const source = compositionSource()
  assert.doesNotMatch(source, /DirectJobObservationPort/,
    'the composition surface must consume backend.jobObservation instead of constructing the Direct adapter')
})
