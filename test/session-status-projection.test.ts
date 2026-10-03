/**
 * M3-3A Session-scoped projection facts (W1/W5/W6): the Direct mapping of
 * the official `contextPressure` / `turnOutline` / status projections and
 * the subject-neutrality rules the M3-5 child surfaces will rely on — one
 * session's facts only, no parent fallback, no invented values.
 * @module @xmoon76/dsh-pi-tui/session-status-projection.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DirectSessionReader, type HostContextLike } from '../src/runtime/direct/session-direct.ts'
import { contextPressureOccupancy } from '../src/runtime/session-reader-port.ts'

/** The structural Host projection reader face the M3-3A reads consume. */
function projectionsHost(valuesBySession: Readonly<Record<string, Readonly<Record<string, unknown>>>>): {
  host: HostContextLike
  snapshotKeys: string[][]
} {
  const snapshotKeys: string[][] = []
  return {
    snapshotKeys,
    host: {
      get: (name: string) => name === 'sessionProjections'
        ? {
            snapshot: (session: { header: { id: string } }, keys?: readonly string[]) => {
              snapshotKeys.push([...(keys ?? [])])
              const values = valuesBySession[session.header.id]
              return values === undefined ? { values: {} } : { values }
            },
          }
        : undefined,
    },
  }
}

function reader(
  valuesBySession: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  cwds: Readonly<Record<string, string>> = {},
  liveIds: readonly string[] = Object.keys(valuesBySession),
  /** Sessions ATTACHED/retained in the Host registry without a live Agent
   *  (the M3-5 retained-Session subject). Defaults to the live ids so the
   *  historical fixtures keep their exact meaning. */
  retainedIds: readonly string[] = liveIds,
): {
  direct: DirectSessionReader
  snapshotKeys: string[][]
} {
  const projections = projectionsHost(valuesBySession)
  const live = new Set(liveIds)
  const retained = new Set([...liveIds, ...retainedIds])
  const agentOf = (id: string): unknown =>
    live.has(String(id))
      ? { session: { header: { id: SessionId(String(id)), cwd: cwds[String(id)] } } }
      : undefined
  const direct = new DirectSessionReader(projections.host, {
    sessionOf: id => retained.has(String(id))
      ? ({ header: { id: SessionId(String(id)), cwd: cwds[String(id)] } }) as never
      : undefined,
    agentOf: id => agentOf(id) as never,
  })
  return { direct, snapshotKeys: projections.snapshotKeys }
}

test('R1/R2 (Direct): measureContext reads projectedTokens first, then pressureTokens', () => {
  const { direct } = reader({ s: { contextPressure: { pressureTokens: 100, projectedTokens: 125 } } })
  assert.equal(direct.measureContext('s'), 125, 'projectedTokens wins')
  const { direct: fallback } = reader({ s: { contextPressure: { pressureTokens: 100 } } })
  assert.equal(fallback.measureContext('s'), 100, 'pressureTokens is the fallback')
})

test('R3 (Direct): an absent projection capability or value reads unmeasured', () => {
  const { direct } = reader({ s: { contextPressure: {} } })
  assert.equal(direct.measureContext('s'), undefined, 'no fields yet — absent until a provider reports usage')
  const noService = new DirectSessionReader({ get: () => undefined }, {
    sessionOf: () => ({ header: {} }) as never,
    agentOf: () => ({ session: { header: {} } }) as never,
  })
  assert.equal(noService.measureContext('s'), undefined, 'no sessionProjections service = unavailable')
  const { direct: noAgent } = reader({})
  assert.equal(noAgent.measureContext('unknown'), undefined, 'no live agent = unavailable')
})

test('R5 (Direct): the Direct mapping equals the one shared semantic numerator', () => {
  const pressure = { pressureTokens: 100, projectedTokens: 125, contextWindow: 1000 }
  const { direct } = reader({ s: { contextPressure: pressure } })
  assert.equal(direct.measureContext('s'), contextPressureOccupancy(pressure))
})

test('R6 (Direct): a throwing projection read is unmeasured, never a crash', () => {
  const direct = new DirectSessionReader({
    get: () => ({
      snapshot: () => { throw new Error('teardown race') },
    }),
  }, {
    sessionOf: () => ({ header: {} }) as never,
    agentOf: () => ({ session: { header: {} } }) as never,
  })
  assert.equal(direct.measureContext('s'), undefined)
  assert.equal(direct.turnOutline('s'), undefined)
  assert.equal(direct.sessionStatus('s'), undefined)
})

test('W5 (Direct): turnOutline reads the official projection without paging', () => {
  const outline = [{ turn: 1, seq: 10, prompt: 'p1', response: 'r1' }]
  const { direct, snapshotKeys } = reader({ s: { turnOutline: outline } })
  assert.deepEqual(direct.turnOutline('s'), outline)
  assert.deepEqual(snapshotKeys.at(-1), ['turnOutline'], 'the read names the official key')
})

test('W6 (Direct): sessionStatus maps every official projection fact with the session cwd', () => {
  const { direct } = reader({
    s: {
      modelSelection: { lastUsed: { provider: 'p', model: 'm1' }, next: { provider: 'p', model: 'm2', reasoningEffort: 'high' } },
      contextPressure: { projectedTokens: 900, contextWindow: 1000 },
      contextBreakdown: { systemTokens: 10, toolsTokens: 20, messageTokens: 870 },
      tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      todos: [{ content: 't', status: 'in_progress' }],
    },
  }, { s: '/host/ws' })
  assert.deepEqual(direct.sessionStatus('s'), {
    sessionId: 's',
    cwd: '/host/ws',
    model: { provider: 'p', model: 'm2', reasoningEffort: 'high' },
    context: {
      projectedTokens: 900,
      contextWindow: 1000,
      breakdown: { systemTokens: 10, toolsTokens: 20, messageTokens: 870 },
    },
    todos: [{ content: 't', status: 'in_progress' }],
    usage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
  })
})

test('W6 (Direct): model falls back to lastUsed when next is null', () => {
  const { direct } = reader({
    s: { modelSelection: { lastUsed: { provider: 'p', model: 'used' }, next: null } },
  })
  assert.deepEqual(direct.sessionStatus('s')?.model, { provider: 'p', model: 'used' })
})

test('W6 child correctness: each session reads only ITS OWN facts', () => {
  const { direct } = reader({
    main: { contextPressure: { projectedTokens: 500 }, todos: [{ content: 'main', status: 'pending' }] },
    'child-b': { contextPressure: { projectedTokens: 50 } },
  }, { main: '/main', 'child-b': '/child-b', 'child-c': '/child-c' }, ['main', 'child-b', 'child-c'])
  // main -> child B: B facts only.
  assert.deepEqual(direct.sessionStatus('child-b'), {
    sessionId: 'child-b',
    cwd: '/child-b',
    context: { projectedTokens: 50 },
  })
  // child B -> child C: no stale B facts.
  assert.deepEqual(direct.sessionStatus('child-c'), { sessionId: 'child-c', cwd: '/child-c' })
  // child -> main: main facts clean.
  assert.equal(direct.sessionStatus('main')?.context?.projectedTokens, 500)
  assert.deepEqual(direct.sessionStatus('main')?.todos, [{ content: 'main', status: 'pending' }])
  // A cold child without a live agent reads NO facts (never invented).
  assert.equal(direct.sessionStatus('child-cold'), undefined)
})

test('W6: the official todos null (no write yet) stays null — distinct from capability-absent', () => {
  const { direct } = reader({ s: { todos: null } })
  assert.equal(direct.sessionStatus('s')?.todos, null,
    'null is the legal "projection present, no todo yet" business value')
  const { direct: bare } = reader({ s: {} })
  assert.equal(bare.sessionStatus('s')?.todos, undefined,
    'an absent projection value reads capability-unavailable')
})

test('W6 (Direct): malformed projection values stay absent — never coerced', () => {
  const { direct } = reader({
    s: {
      modelSelection: { lastUsed: null, next: { provider: '', model: 'x' } },
      contextPressure: { projectedTokens: 'many' },
      todos: [{ content: 't', status: 'unknown-status' }],
      tokenUsage: { uncachedInputTokens: 1 },
    },
  })
  const status = direct.sessionStatus('s')!
  assert.deepEqual(status, { sessionId: 's' }, 'no field is invented from malformed values')
})

// ── M3-5 PR1: the projection SUBJECT is the retained/attached Session ──────
// A retained Session whose Agent is inactive (or never mounted in this
// process) still owns its official projection facts. The read must never
// require a live Agent, must never start/materialize a Session, and must
// never fall back to another subject.

test('M3-5 §9.1: a RETAINED Session with no live Agent still answers its own status', () => {
  const { direct } = reader(
    {
      'retained-child': {
        modelSelection: { lastUsed: { provider: 'p', model: 'child' } },
        contextPressure: { projectedTokens: 100, contextWindow: 2000 },
        tokenUsage: { uncachedInputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        todos: [{ content: 'child todo', status: 'in_progress' }],
      },
      main: { contextPressure: { projectedTokens: 900 }, todos: [{ content: 'parent todo', status: 'pending' }] },
    },
    { 'retained-child': '/child/ws', main: '/main/ws' },
    ['main'],
    ['retained-child'],
  )
  assert.deepEqual(direct.sessionStatus('retained-child'), {
    sessionId: 'retained-child',
    cwd: '/child/ws',
    model: { provider: 'p', model: 'child' },
    context: { projectedTokens: 100, contextWindow: 2000 },
    todos: [{ content: 'child todo', status: 'in_progress' }],
    usage: { uncachedInputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }, 'the retained Session own facts only — the live MAIN session must not fill any field')
})

test('M3-5 §9.1: retained child A / child B stay isolated and an absent Session stays unavailable', () => {
  const { direct } = reader(
    {
      'child-a': { contextPressure: { projectedTokens: 10 }, todos: [{ content: 'a', status: 'pending' }] },
      'child-b': { contextPressure: { projectedTokens: 20 } },
    },
    { 'child-a': '/a', 'child-b': '/b' },
    [],
    ['child-a', 'child-b'],
  )
  assert.deepEqual(direct.sessionStatus('child-a'), {
    sessionId: 'child-a',
    cwd: '/a',
    context: { projectedTokens: 10 },
    todos: [{ content: 'a', status: 'pending' }],
  })
  // A -> B: no stale A facts ride along.
  assert.deepEqual(direct.sessionStatus('child-b'), {
    sessionId: 'child-b',
    cwd: '/b',
    context: { projectedTokens: 20 },
  })
  assert.equal(direct.sessionStatus('not-attached'), undefined, 'an unattached Session reads unavailable')
})

test('M3-5 §9.1: a retained Session without the projection service reads unavailable', () => {
  const direct = new DirectSessionReader({ get: () => undefined }, {
    sessionOf: () => ({ header: { id: SessionId('s'), cwd: '/s' } }) as never,
    agentOf: () => undefined,
  })
  assert.equal(direct.sessionStatus('s'), undefined)
})
