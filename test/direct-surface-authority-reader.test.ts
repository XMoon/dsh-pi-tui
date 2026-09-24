/**
 * Contract tests for the Direct live-Agent surface-authority adapter.
 * @module @xmoon76/dsh-pi-tui/direct-surface-authority-reader.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DirectSurfaceAuthorityReader,
  type DirectSurfaceAuthorityAgent,
  type DirectSurfaceAuthorityContext,
} from '../src/runtime/direct/surface-authority-direct.ts'

test('checks live eligibility without reading catalog services', () => {
  const ctx = { get: () => { assert.fail('eligibility must not discover catalogs') } }
  let agent: DirectSurfaceAuthorityAgent | undefined
  const reader = new DirectSurfaceAuthorityReader(ctx, sessionId => {
    assert.equal(sessionId, 'session-a')
    return agent
  })
  assert.equal(reader.isLive('session-a'), false)
  agent = { ctx, session: { header: {} } }
  assert.equal(reader.isLive('session-a'), true)
  agent = undefined
  assert.equal(reader.isLive('session-a'), false)
})

test('requires and forwards the live Agent context for scoped skill authority', async () => {
  let scopedAgent: object | undefined
  const skillRegistry = {
    list: async () => [{
      name: 'scoped-skill',
      description: 'Scoped skill',
      invocation: { modelInvocable: true, userInvocable: true },
    }],
  }
  const ctx: DirectSurfaceAuthorityContext = {
    get: (name) => {
      if (name === 'commands') return { list: () => [] }
      if (name === 'agentPresets') {
        return {
          serviceFor: (agent: { ctx: unknown }) => {
            scopedAgent = agent
            return skillRegistry
          },
        }
      }
      return undefined
    },
  }
  const agent: DirectSurfaceAuthorityAgent = {
    ctx,
    session: { header: { cwd: '/workspace' } },
  }
  const reader = new DirectSurfaceAuthorityReader(ctx, () => agent)

  const snapshot = await reader.read('session-a')

  assert.deepEqual(snapshot?.commands, [])
  assert.deepEqual(snapshot?.skills, [{
    name: 'scoped-skill',
    description: 'Scoped skill',
    modelInvocable: true,
  }])
  assert.equal(scopedAgent, agent)
})
