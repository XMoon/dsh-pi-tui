import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSessionLifecycle } from '../src/runtime/direct/session-lifecycle-direct.ts'

test('Direct fork uses the requested completed boundary and Host-owned metadata mapping', async () => {
  const calls: Array<Record<string, unknown>> = []
  const source = {
    header: { id: 'session-source', cwd: '/ws' },
    events: [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'A' }] } },
      { type: 'turn/end', seq: 2, data: { turn: 1 } },
      { type: 'turn/start', seq: 3, data: { turn: 2 } },
    ],
    projections: { values: { agentPreset: 'minimal' } },
    [Symbol.dispose]: () => {},
  }
  const lifecycle = new DirectSessionLifecycle({
    get: name => name === 'sessionQuery'
      ? { observeSession: async () => source }
      : name === 'agents'
        ? {
            create: async (options: Record<string, unknown>) => {
              calls.push(options)
              return { agent: { session: { id: options.sessionId } }, dispose: async () => {} }
            },
            resume: async () => { throw new Error('resume should not run') },
          }
        : name === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
          : undefined,
  }, async preset => ({ agentPreset: preset, setup: () => {} }))

  const result = await lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 2 })
  assert.equal(result.outcome.kind, 'forked')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.seed, source.events.slice(0, 3))
  assert.equal(calls[0]?.inheritedEventCount, 3)
  assert.deepEqual(calls[0]?.agentOptions, { provider: 'p', model: 'm' })
  assert.deepEqual(calls[0]?.meta, {
    cwd: '/ws',
    parentSession: 'session-source',
    isSeeded: true,
    agentPreset: 'minimal',
  })
})

test('Direct preserves the official not-found code for a missing fork source', async () => {
  const lifecycle = new DirectSessionLifecycle({
    get: name => name === 'sessionQuery'
      ? { observeSession: async () => { throw { code: 'SESSION_QUERY_SESSION_NOT_FOUND', message: 'missing' } } }
      : name === 'agents'
        ? { create: async () => { throw new Error('create should not run') }, resume: async () => { throw new Error('resume should not run') } }
        : undefined,
  }, async () => ({ setup: () => {} }))

  const result = await lifecycle.fork({ sourceSessionId: 'session-missing' })
  assert.equal(result.outcome.kind, 'rejected')
  if (result.outcome.kind === 'rejected') assert.equal(result.outcome.error.code, 'session/not-found')
})

test('Direct maps a persistence failure during fork observation to gateway/internal', async () => {
  const lifecycle = new DirectSessionLifecycle({
    get: name => name === 'sessionQuery'
      ? { observeSession: async () => {
          throw Object.assign(new Error('corrupt log'), { code: 'SESSION_QUERY_PERSISTENCE_FAILED' })
        } }
      : name === 'agents'
        ? { create: async () => { throw new Error('create should not run') }, resume: async () => { throw new Error('resume should not run') } }
        : undefined,
  }, async () => ({ setup: () => {} }))

  const result = await lifecycle.fork({ sourceSessionId: 'session-corrupt' })
  assert.equal(result.outcome.kind, 'rejected')
  if (result.outcome.kind === 'rejected') {
    assert.equal(result.outcome.error.code, 'gateway/internal')
    assert.match(result.outcome.error.message, /corrupt log/)
  }
})

test('Direct preserves a published child owner when workspace attach fails', async () => {
  let disposed = 0
  const childHandle = {
    agent: { session: { id: 'session-child' } },
    dispose: async () => { disposed += 1 },
  }
  const source = {
    header: { id: 'session-source', cwd: '/ws' },
    events: [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, data: { turn: 1 } },
    ],
    projections: { values: {} },
    [Symbol.dispose]: () => {},
  }
  const lifecycle = new DirectSessionLifecycle({
    get: name => name === 'sessionQuery'
      ? { observeSession: async () => source }
      : name === 'workspaceRegistry'
        ? { list: () => [{ id: 'workspace-a', sessionIds: ['session-source'], attachSession: async () => { throw new Error('attach failed') } }] }
        : name === 'agents'
          ? { create: async () => childHandle, resume: async () => { throw new Error('resume should not run') } }
          : name === 'agentDefaultModel'
            ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
            : undefined,
  }, async () => ({ setup: () => {} }))

  const result = await lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind === 'published-with-error') {
    assert.equal(result.outcome.sessionId, 'session-child')
    assert.equal(result.outcome.handle?.direct?.ownerHandle, childHandle)
    assert.equal(result.outcome.error.code, 'session/workspace-attach-failed')
  }
  assert.equal(disposed, 0, 'a published child owner must remain available for later adoption or teardown')
})

test('Direct subagent fork inherits the nearest ancestor workspace', async () => {
  let attached: string | undefined
  const source = {
    header: { id: 'session-subagent', origin: 'subagent' },
    events: [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, data: { turn: 1 } },
    ],
    projections: { values: {} },
    [Symbol.dispose]: () => {},
  }
  const lifecycle = new DirectSessionLifecycle({
    get: name => name === 'sessionQuery'
      ? {
          observeSession: async () => source,
          traceSession: async () => ({ ancestors: [{ header: { id: 'session-parent' } }] }),
        }
      : name === 'workspaceRegistry'
        ? { list: () => [{ id: 'workspace-parent', sessionIds: ['session-parent'], attachSession: async (id: unknown) => { attached = String(id) } }] }
        : name === 'agents'
          ? {
              create: async () => ({ agent: { session: { id: 'session-child' } }, dispose: async () => {} }),
              resume: async () => { throw new Error('resume should not run') },
            }
          : name === 'agentDefaultModel'
            ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
            : undefined,
  }, async () => ({ setup: () => {} }))

  const result = await lifecycle.fork({ sourceSessionId: 'session-subagent' })
  assert.equal(result.outcome.kind, 'forked')
  assert.equal(attached, 'session-child')
})

test('Direct rejects a non-canonical fork anchor before Host observation', async () => {
  let observed = false
  const lifecycle = new DirectSessionLifecycle({
    get: name => name === 'sessionQuery'
      ? { observeSession: async () => { observed = true; throw new Error('observation should not run') } }
      : name === 'agents'
        ? { create: async () => { throw new Error('create should not run') }, resume: async () => { throw new Error('resume should not run') } }
        : undefined,
  }, async () => ({ setup: () => {} }))
  const result = await lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 0.5 })
  assert.equal(result.outcome.kind, 'rejected')
  assert.equal(observed, false)
})

test('Direct open claims a parked fork owner before resume', async () => {
  const parked = { agent: { session: { id: 'session-parked' } }, dispose: async () => {} }
  let claimed = false
  const lifecycle = new DirectSessionLifecycle({
    get: name => name === 'agents'
      ? { create: async () => { throw new Error('create should not run') }, resume: async () => { throw new Error('resume should not run') } }
      : undefined,
  }, async () => ({ setup: () => {} }), {
    claim: id => id === 'session-parked' && !claimed ? (claimed = true, parked as never) : undefined,
    park: () => { throw new Error('park should not run') },
  })
  const result = await lifecycle.open({ sessionId: 'session-parked' })
  assert.equal(result.outcome.kind, 'opened')
  assert.equal(claimed, true)
})
