import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { DirectSessionLifecycle } from '../src/runtime/direct/session-lifecycle-direct.ts'

/** Fixture timestamp base; synthetic closers reuse the last real event time. */
const T0 = 1_700_000_000_000

/** A minimal observation source. Untyped on purpose: the Direct adapter
 * consumes it structurally through the untyped Host context stub. */
function observation(overrides: Record<string, unknown> = {}) {
  return {
    header: { id: 'session-source' },
    events: [],
    projections: { values: {} },
    [Symbol.dispose]: () => {},
    ...overrides,
  }
}

/** A Direct lifecycle over untyped Host service stubs, recording creates. */
function directLifecycle(
  source: unknown,
  options: {
    create?: (options: Record<string, unknown>) => Promise<unknown> | unknown
    compose?: (presetId?: string) => Promise<{ agentPreset?: string; setup: () => void }>
    services?: Record<string, unknown>
    preset?: string
  } = {},
) {
  const calls: Array<Record<string, unknown>> = []
  const lifecycle = new DirectSessionLifecycle({
    get: name => {
      if (name === 'sessionQuery') {
        return {
          observeSession: async () => source,
          ...(options.services?.sessionQuery as object ?? {}),
        }
      }
      if (name === 'agents') {
        return {
          create: async (createOptions: Record<string, unknown>) => {
            calls.push(createOptions)
            if (options.create !== undefined) return options.create(createOptions)
            return { agent: { session: { id: createOptions.sessionId } }, dispose: async () => {} }
          },
          resume: async () => { throw new Error('resume should not run') },
        }
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (name in (options.services ?? {})) return (options.services as Record<string, unknown>)[name]
      return undefined
    },
  }, options.compose ?? (async preset => ({ agentPreset: preset, setup: () => {} })))
  return { lifecycle, calls }
}

test('Direct exact turn/end cut uses the official buildForkSeed and Host metadata mapping', async () => {
  const source = observation({
    header: { id: 'session-source', cwd: '/ws' },
    events: [
      { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: T0, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } } },
      { type: 'turn/end', seq: 2, time: T0, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 3, time: T0, data: { turn: 2 } },
    ],
    projections: { values: { agentPreset: 'minimal' } },
  })
  const { lifecycle, calls } = directLifecycle(source)

  const result = await lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 2 })
  assert.equal(result.outcome.kind, 'forked')
  assert.equal(calls.length, 1)
  // The seed is the OFFICIAL helper output for the same boundary, never a
  // TUI-side reconstruction: inherited prefix + child-owned end-seed marker.
  assert.deepEqual(calls[0]?.seed, buildForkSeed(source.events, SessionSeq(2)))
  assert.equal(calls[0]?.inheritedEventCount, 3)
  const seed = calls[0]?.seed as Array<Record<string, unknown>>
  assert.equal(seed.length, 4, 'a closed-turn cut appends exactly the end-seed marker')
  assert.deepEqual(seed[3], { type: 'session/end-seed', seq: 3, time: T0, data: { inherited: true } })
  assert.deepEqual(calls[0]?.agentOptions, { provider: 'p', model: 'm' })
  assert.deepEqual(calls[0]?.meta, {
    cwd: '/ws',
    parentSession: 'session-source',
    isSeeded: true,
    agentPreset: 'minimal',
  })
})

test('Direct explicit mid-turn cut stays EXACT: inheritedEventCount is the cut, never the closing turn/end', async () => {
  // The clearest old-semantic-is-gone regression (plan §21): the old D2.4
  // adapter moved atSeq=1 forward to the closing turn/end at seq 4 and
  // inherited 5 events; alpha.2 cuts exactly at seq 1.
  const source = observation({
    events: [
      { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: T0, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, time: T0, surfaceOp: 'append', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'partial' }] } } },
      { type: 'step/end', seq: 3, time: T0, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 4, time: T0, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
  const { lifecycle, calls } = directLifecycle(source)

  const result = await lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 1 })
  assert.equal(result.outcome.kind, 'forked')
  assert.equal(calls[0]?.inheritedEventCount, 2, 'an exact cut inherits exactly boundary + 1 events')
  const seed = calls[0]?.seed as Array<Record<string, unknown>>
  assert.deepEqual(seed.slice(0, 2), source.events.slice(0, 2),
    'the inherited prefix contains only source events through the exact cut')
  assert.equal(seed[2]?.type, 'session/end-seed')
  assert.equal(seed[2]?.seq, 2, 'the end-seed marker sits at seq = inheritedEventCount')
  // Child-owned fork repair closes the open turn after the marker.
  assert.equal(seed.at(-1)?.type, 'turn/end')
  assert.deepEqual(seed.at(-1)?.data, { turn: 1, reason: { kind: 'forked' } })
  assert.ok(seed.length > 2 + 1, 'an open-tail cut receives child-owned repair beyond the marker')
})

test('Direct mid-turn cut with a dispatched tool call receives the official fork repair', async () => {
  const source = observation({
    events: [
      { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: T0, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } } },
      { type: 'step/start', seq: 2, time: T0, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 3, time: T0, surfaceOp: 'append', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-call', id: 'call-1' }] } } },
      { type: 'tool/call', seq: 4, time: T0, surfaceOp: 'append', data: { callId: 'call-1' } },
      // No tool/result: the cut at seq 4 leaves the dispatched call result-less.
    ],
  })
  const { lifecycle, calls } = directLifecycle(source)

  const result = await lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 4 })
  assert.equal(result.outcome.kind, 'forked')
  const seed = calls[0]?.seed as Array<Record<string, unknown>>
  const inheritedEventCount = calls[0]?.inheritedEventCount as number
  assert.equal(inheritedEventCount, 5)
  assert.ok(seed.length > inheritedEventCount,
    'a result-less dispatched call must add child-owned repair beyond the inherited prefix')
  // The official repair: one synthetic error result for the pending call, the
  // open step end, and the forked turn end — in that order, after the marker.
  const childOwned = seed.slice(inheritedEventCount)
  assert.deepEqual(childOwned.map(event => event.type), ['session/end-seed', 'tool/result', 'step/end', 'turn/end'])
  const repair = childOwned[1] as { data: { message: { isError: boolean; toolCallId: string }; error: { code: string } } }
  assert.equal(repair.data.message.toolCallId, 'call-1')
  assert.equal(repair.data.message.isError, true)
  assert.equal(repair.data.error.code, 'TOOL_OUTCOME_UNKNOWN')
  assert.deepEqual((childOwned.at(-1) as { data: unknown }).data, { turn: 1, reason: { kind: 'forked' } })
  // The whole seed equals the official helper output for the same cut.
  assert.deepEqual(seed, buildForkSeed(source.events, SessionSeq(4)))
})

test('Direct cut after a closed step closes only the open turn, never the closed step', async () => {
  const source = observation({
    events: [
      { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: T0, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } } },
      { type: 'step/start', seq: 2, time: T0, data: { turn: 1, step: 1 } },
      { type: 'tool/call', seq: 3, time: T0, surfaceOp: 'append', data: { callId: 'call-1' } },
      { type: 'tool/result', seq: 4, time: T0, surfaceOp: 'append', data: { message: { source: { callId: 'call-1' } } } },
      { type: 'step/end', seq: 5, time: T0, data: { turn: 1, step: 1 } },
      // The turn stays open; the cut lands right after the closed step.
    ],
  })
  const { lifecycle, calls } = directLifecycle(source)

  const result = await lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 5 })
  assert.equal(result.outcome.kind, 'forked')
  const seed = calls[0]?.seed as Array<Record<string, unknown>>
  const inheritedEventCount = calls[0]?.inheritedEventCount as number
  assert.equal(inheritedEventCount, 6)
  const childOwned = seed.slice(inheritedEventCount)
  // Only the marker plus the turn closer: no second step/end, no tool repair
  // for the already-matched call inside the closed step.
  assert.deepEqual(childOwned.map(event => event.type), ['session/end-seed', 'turn/end'])
  assert.deepEqual(seed, buildForkSeed(source.events, SessionSeq(5)))
})

test('Direct closed historical failure is not retroactively repaired before the cut', async () => {
  const source = observation({
    events: [
      { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: T0, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } } },
      { type: 'step/start', seq: 2, time: T0, data: { turn: 1, step: 1 } },
      { type: 'tool/call', seq: 3, time: T0, surfaceOp: 'append', data: { callId: 'call-1' } },
      // Historical missing result, but the step AND turn closed anyway:
      { type: 'step/end', seq: 4, time: T0, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 5, time: T0, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
  const { lifecycle, calls } = directLifecycle(source)

  const result = await lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 5 })
  assert.equal(result.outcome.kind, 'forked')
  const seed = calls[0]?.seed as Array<Record<string, unknown>>
  assert.equal(calls[0]?.inheritedEventCount, 6)
  // A balanced prefix gets no repair: only the child-owned end-seed marker.
  assert.equal(seed.length, 7)
  assert.equal(seed.filter(event => event.type === 'tool/result').length, 0,
    'a closed historical failure before the cut must stay untouched')
  assert.deepEqual(seed, buildForkSeed(source.events, SessionSeq(5)))
})

test('Direct fork does not synthetically close an open plugin bracket', async () => {
  const source = observation({
    events: [
      { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: T0, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } } },
      // An open plugin bracket the core repair vocabulary does not own:
      { type: 'compaction/start', seq: 2, time: T0, data: { attempt: 1 } },
    ],
  })
  const { lifecycle, calls } = directLifecycle(source)

  const result = await lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 2 })
  assert.equal(result.outcome.kind, 'forked')
  const seed = calls[0]?.seed as Array<Record<string, unknown>>
  assert.equal(seed.filter(event => event.type === 'compaction/end').length, 0,
    'core fork repair owns turn/step/tool vocabulary only; it must not invent a plugin closer')
  assert.equal(seed.at(-1)?.type, 'turn/end')
  assert.deepEqual(seed.at(-1)?.data, { turn: 1, reason: { kind: 'forked' } })
})

test('Direct nonexistent explicit seq rejects with no flooring and no latest fallback', async () => {
  const source = observation({
    events: [
      { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: T0, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
  const { lifecycle, calls } = directLifecycle(source)

  const result = await lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 100 })
  assert.equal(result.outcome.kind, 'rejected')
  if (result.outcome.kind === 'rejected') {
    assert.equal(result.outcome.error.code, 'session/fork-unavailable')
    assert.match(result.outcome.error.message, /event 100 does not exist/u)
    assert.match(result.outcome.error.message, /last seq: 1/u)
  }
  assert.equal(calls.length, 0, 'a nonexistent seq must never create a child')
})

test('Direct rejects a non-canonical source log seq instead of coercing it', async () => {
  // A forged string seq at the cut index must fail the STRICT canonical-event
  // proof (`events[boundary]?.seq === boundary`, exactly like the official
  // controller) — never pass through Number() coercion into seed construction.
  const source = observation({
    events: [
      { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
      { type: 'turn/end', seq: '1', time: T0, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
  const { lifecycle, calls } = directLifecycle(source)

  const result = await lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 1 })
  assert.equal(result.outcome.kind, 'rejected')
  if (result.outcome.kind === 'rejected') {
    assert.equal(result.outcome.error.code, 'session/fork-unavailable')
  }
  assert.equal(calls.length, 0, 'a non-canonical seq must never reach seed construction')
})

test('Direct omitted cut includes a stable standalone event after the latest turn/end', async () => {
  const source = observation({
    events: [
      { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: T0, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } } },
      { type: 'turn/end', seq: 2, time: T0, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'session/title', seq: 3, time: T0, data: { title: 'Later title' } },
    ],
  })
  const { lifecycle, calls } = directLifecycle(source)

  const result = await lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(result.outcome.kind, 'forked')
  assert.equal(calls[0]?.inheritedEventCount, 4,
    'the omitted default extends through stable standalone post-turn events')
  assert.deepEqual(calls[0]?.seed, buildForkSeed(source.events, SessionSeq(3)))
})

test('Direct omitted cut stops before each queued-input boundary', async () => {
  const cases: Array<{ label: string; tail: Record<string, unknown> }> = [
    {
      label: 'appended user/message',
      tail: { type: 'user/message', seq: 3, time: T0, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } } },
    },
    { label: 'agent/inbox/spliced', tail: { type: 'agent/inbox/spliced', seq: 3, time: T0, data: { entries: [] } } },
    { label: 'turn/start', tail: { type: 'turn/start', seq: 3, time: T0, data: { turn: 2 } } },
  ]
  for (const { label, tail } of cases) {
    const source = observation({
      events: [
        { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: T0, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } } },
        { type: 'turn/end', seq: 2, time: T0, data: { turn: 1, reason: { kind: 'completed' } } },
        tail,
      ],
    })
    const { lifecycle, calls } = directLifecycle(source)
    const result = await lifecycle.fork({ sourceSessionId: 'session-source' })
    assert.equal(result.outcome.kind, 'forked', `the omitted cut must still fork with a ${label} tail`)
    assert.equal(calls[0]?.inheritedEventCount, 3,
      `the omitted cut must stop before the ${label} queued-input boundary`)
    const seed = calls[0]?.seed as Array<Record<string, unknown>>
    assert.equal(seed.some(event => event.seq === 3 && event.type === tail.type), false,
      `the ${label} tail event must not enter the child seed`)
  }
})

test('Direct omitted cut with no completed turn rejects', async () => {
  const source = observation({
    events: [
      { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: T0, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } } },
    ],
  })
  const { lifecycle, calls } = directLifecycle(source)

  const result = await lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(result.outcome.kind, 'rejected')
  if (result.outcome.kind === 'rejected') {
    assert.equal(result.outcome.error.code, 'session/fork-unavailable')
    assert.match(result.outcome.error.message, /no completed turn to fork from/u)
  }
  assert.equal(calls.length, 0)
})

test('Direct rejects non-canonical fork cuts before Host observation', async () => {
  let observed = false
  const lifecycle = new DirectSessionLifecycle({
    get: name => name === 'sessionQuery'
      ? { observeSession: async () => { observed = true; throw new Error('observation should not run') } }
      : name === 'agents'
        ? { create: async () => { throw new Error('create should not run') }, resume: async () => { throw new Error('resume should not run') } }
        : undefined,
  }, async () => ({ setup: () => {} }))
  for (const atSeq of [0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    const result = await lifecycle.fork({ sourceSessionId: 'session-source', atSeq })
    assert.equal(result.outcome.kind, 'rejected', `atSeq ${String(atSeq)} must be rejected`)
    if (result.outcome.kind === 'rejected') {
      assert.equal(result.outcome.error.code, 'gateway/bad-request')
    }
  }
  assert.equal(observed, false)
})

test('Direct fork does not copy origin or delegationDepth onto the ordinary child', async () => {
  const source = observation({
    header: { id: 'session-subagent-source', origin: 'subagent', delegationDepth: 1 },
    events: [
      { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: T0, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
  const { lifecycle, calls } = directLifecycle(source)

  const result = await lifecycle.fork({ sourceSessionId: 'session-subagent-source' })
  assert.equal(result.outcome.kind, 'forked')
  assert.deepEqual(calls[0]?.meta, {
    parentSession: 'session-subagent-source',
    isSeeded: true,
  })
})

test('Direct disposes the source observation on every settlement path', async () => {
  const completedEvents = [
    { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: T0, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const countingSource = (events: Array<Record<string, unknown>> = completedEvents) => {
    let disposed = 0
    const base = observation({
      events,
      [Symbol.dispose]: () => { disposed += 1 },
    })
    return { source: base, disposedCount: () => disposed }
  }

  // Success path.
  {
    const { source, disposedCount } = countingSource()
    const { lifecycle } = directLifecycle(source)
    const result = await lifecycle.fork({ sourceSessionId: 'session-source' })
    assert.equal(result.outcome.kind, 'forked')
    assert.equal(disposedCount(), 1)
  }
  // Boundary rejection path.
  {
    const { source, disposedCount } = countingSource()
    const { lifecycle } = directLifecycle(source)
    const result = await lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 9 })
    assert.equal(result.outcome.kind, 'rejected')
    assert.equal(disposedCount(), 1)
  }
  // Composition failure path.
  {
    const { source, disposedCount } = countingSource()
    const { lifecycle } = directLifecycle(source, { compose: async () => { throw new Error('preset unavailable') } })
    const result = await lifecycle.fork({ sourceSessionId: 'session-source' })
    assert.equal(result.outcome.kind, 'rejected')
    assert.equal(disposedCount(), 1)
  }
  // agents.create failure path.
  {
    const { source, disposedCount } = countingSource()
    const { lifecycle } = directLifecycle(source, { create: async () => { throw new Error('activation exploded') } })
    const result = await lifecycle.fork({ sourceSessionId: 'session-source' })
    assert.equal(result.outcome.kind, 'rejected')
    assert.equal(disposedCount(), 1)
  }
  // Workspace attach failure path (published-with-error still settles).
  {
    const { source, disposedCount } = countingSource()
    const { lifecycle } = directLifecycle(source, {
      services: {
        workspaceRegistry: {
          list: () => [{ id: 'workspace-a', sessionIds: ['session-source'], attachSession: async () => { throw new Error('attach failed') } }],
        },
      },
    })
    const result = await lifecycle.fork({ sourceSessionId: 'session-source' })
    assert.equal(result.outcome.kind, 'published-with-error')
    assert.equal(disposedCount(), 1)
  }
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
  const source = observation({
    header: { id: 'session-source', cwd: '/ws' },
    events: [
      { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: T0, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
  const { lifecycle } = directLifecycle(source, {
    create: async () => childHandle,
    services: {
      workspaceRegistry: {
        list: () => [{ id: 'workspace-a', sessionIds: ['session-source'], attachSession: async () => { throw new Error('attach failed') } }],
      },
    },
  })

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
  const source = observation({
    header: { id: 'session-subagent', origin: 'subagent' },
    events: [
      { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: T0, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
  const { lifecycle } = directLifecycle(source, {
    services: {
      sessionQuery: {
        traceSession: async () => ({ ancestors: [{ header: { id: 'session-parent' } }] }),
      },
      workspaceRegistry: {
        list: () => [{ id: 'workspace-parent', sessionIds: ['session-parent'], attachSession: async (id: unknown) => { attached = String(id) } }],
      },
    },
  })

  const result = await lifecycle.fork({ sourceSessionId: 'session-subagent' })
  assert.equal(result.outcome.kind, 'forked')
  assert.ok(attached !== undefined && attached.startsWith('session-') && attached !== 'session-subagent',
    'the child attaches through the ancestor workspace, never its own absent membership')
})

test('Direct maps a fork composition failure to gateway/internal, never fork-unavailable', async () => {
  const source = observation({
    events: [{ type: 'turn/end', seq: 0, time: T0, data: { turn: 1, reason: { kind: 'completed' } } }],
  })
  const { lifecycle } = directLifecycle(source, { compose: async () => { throw new Error('preset unavailable') } })

  const result = await lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(result.outcome.kind, 'rejected')
  if (result.outcome.kind === 'rejected') {
    assert.equal(result.outcome.error.code, 'gateway/internal')
    assert.match(result.outcome.error.message, /compose/u)
  }
})

test('Direct maps an agents.create failure to gateway/internal, never session/fork-failed', async () => {
  const source = observation({
    events: [{ type: 'turn/end', seq: 0, time: T0, data: { turn: 1, reason: { kind: 'completed' } } }],
  })
  const { lifecycle } = directLifecycle(source, { create: async () => { throw new Error('activation exploded') } })

  const result = await lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(result.outcome.kind, 'rejected')
  if (result.outcome.kind === 'rejected') {
    assert.equal(result.outcome.error.code, 'gateway/internal')
    assert.match(result.outcome.error.message, /activation exploded/u)
  }
})

test('Direct maps a missing Host fork service to gateway/internal', async () => {
  const lifecycle = new DirectSessionLifecycle({ get: () => undefined }, async () => ({ setup: () => {} }))
  const result = await lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(result.outcome.kind, 'rejected')
  if (result.outcome.kind === 'rejected') assert.equal(result.outcome.error.code, 'gateway/internal')
})

test('Direct open waits for a pending owner release before resuming', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const waits: string[] = []
  const resumed: string[] = []
  const lifecycle = new DirectSessionLifecycle({
    get: name => name === 'agents'
      ? {
          create: async () => { throw new Error('create should not run') },
          resume: async ({ resumeSessionId }: { resumeSessionId: unknown }) => {
            resumed.push(String(resumeSessionId))
            return { agent: { session: { id: resumeSessionId } }, dispose: async () => {} }
          },
        }
      : undefined,
  }, async () => ({ setup: () => {} }), {
    claim: () => undefined,
    park: () => { throw new Error('park should not run') },
    waitForRelease: async (sessionId: string) => { waits.push(sessionId); await gate },
  })

  const opening = lifecycle.open({ sessionId: 'session-source' })
  await new Promise(resolve => { setTimeout(resolve, 0) })
  assert.deepEqual(waits, ['session-source'], 'open must wait for the pending owner release')
  assert.deepEqual(resumed, [], 'the source must not be resumed while its release is pending')
  release()
  const result = await opening
  assert.equal(result.outcome.kind, 'opened')
  assert.deepEqual(resumed, ['session-source'])
})

test('Direct open cancels while waiting for a pending owner release', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const controller = new AbortController()
  const resumed: string[] = []
  const lifecycle = new DirectSessionLifecycle({
    get: name => name === 'agents'
      ? {
          create: async () => { throw new Error('create should not run') },
          resume: async ({ resumeSessionId }: { resumeSessionId: unknown }) => {
            resumed.push(String(resumeSessionId))
            return { agent: { session: { id: resumeSessionId } }, dispose: async () => {} }
          },
        }
      : undefined,
  }, async () => ({ setup: () => {} }), {
    claim: () => undefined,
    park: () => {},
    waitForRelease: async () => { await gate },
  })

  const opening = lifecycle.open({ sessionId: 'session-source', signal: controller.signal })
  controller.abort()
  const result = await opening
  assert.equal(result.outcome.kind, 'cancelled', 'an aborted open must not stay pending behind the release')
  assert.deepEqual(resumed, [], 'an aborted open must never resume the source')
  release()
})

test('Direct open freezes the activation fallback before waiting for a release', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let defaultSelection = { provider: 'p1', model: 'm1' }
  const resumedOptions: unknown[] = []
  const lifecycle = new DirectSessionLifecycle({
    get: name => {
      if (name === 'agents') {
        return {
          create: async () => { throw new Error('create should not run') },
          resume: async (options: { agentOptions: unknown }) => {
            resumedOptions.push(options.agentOptions)
            return { agent: { session: { id: 'session-source' } }, dispose: async () => {} }
          },
        }
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => defaultSelection }
      return undefined
    },
  }, async () => ({ setup: () => {} }), {
    claim: () => undefined,
    park: () => {},
    waitForRelease: async () => { await gate },
  })

  const opening = lifecycle.open({ sessionId: 'session-source' })
  // A global `/model` default change WHILE this open waits must not leak into it:
  // the activation fallback is frozen at admission (v2 §0.8.3).
  defaultSelection = { provider: 'p2', model: 'm2' }
  release()
  const result = await opening
  assert.equal(result.outcome.kind, 'opened')
  assert.deepEqual(resumedOptions[0], { provider: 'p1', model: 'm1' })
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
