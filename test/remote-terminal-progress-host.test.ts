/**
 * L3 contract of the Remote terminal-progress Host row
 * (`app/remote/terminal-progress-host.ts`).
 *
 * The row is mounted over a REAL Cordis Context and a REAL Typert registry, and
 * every frame is produced by REAL event dispatch (`ctx.emit`): the Agent/Session
 * objects are minimal stand-ins, but the subscription scope, the identity
 * fences, the shared interval fold and the per-session stream state under test
 * are the production ones.
 *
 * FIXTURE MANIFEST
 * - REAL: Cordis event dispatch on a real Context, the real `TypertRemoteService`
 *   binding, the real shared `domain/terminal-progress/interval.ts` fold, the
 *   production `watch()` generator and its subscriber queues, the production
 *   identity fences (`agentFor` + `agent.session` object identity).
 * - STAND-IN: the `agents` registry (`agentFor` reads a Map, the same read the
 *   production composition performs through `ctx.reflect.get('agents')`), and
 *   the Agent/Session objects (no AgentLoop is started here — the real
 *   AgentLoop → Host → wire chain is the L5 suite).
 * - ABSENT: the official Gateway/Client transport (L5) and any terminal sink (L6).
 *
 * @module @xmoon76/dsh-pi-tui/remote-terminal-progress-host.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import {
  PiTuiTerminalProgressHostService,
  type LiveAgentLike,
} from '../src/app/remote/terminal-progress-host.ts'
import type { PiTuiTerminalProgressFrame } from '../src/runtime/remote/pi-tui-terminal-progress-contract.ts'

const SESSION_ID = 'l3-main-session'

/** One minimal live Agent: the Session object is the identity fence. */
function agent(id: string, session: { readonly id: string }, status = 'idle'): LiveAgentLike {
  return { id, session, status }
}

/** Mount the production row over a real Context + registry with the given deps. */
async function mountHost(deps: {
  agentFor(sessionId: string): LiveAgentLike | undefined
  onUnknownReason(kind: string): void
}): Promise<{
  readonly ctx: Context
  readonly service: PiTuiTerminalProgressHostService
  readonly fiber: Fiber
  emit(name: string, ...args: unknown[]): void
}> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  let service: PiTuiTerminalProgressHostService | undefined
  const fiber = ctx.inject(PiTuiTerminalProgressHostService.inject, pluginCtx => {
    service = new PiTuiTerminalProgressHostService(pluginCtx, deps)
  })
  await fiber
  assert.ok(service !== undefined, 'the Host row must be constructed')
  // The event parameters are structurally widened here: the row's own contract
  // is the production one, the dispatch call site is a test boundary.
  const emit = ctx.emit.bind(ctx) as unknown as (name: string, ...args: unknown[]) => void
  return { ctx, service, fiber, emit }
}

/** Read exactly `count` frames from one watch. */
async function read(
  iterator: AsyncIterator<PiTuiTerminalProgressFrame>,
  count: number,
  label = '',
): Promise<PiTuiTerminalProgressFrame[]> {
  const frames: PiTuiTerminalProgressFrame[] = []
  for (let index = 0; index < count; index += 1) {
    const next = await iterator.next()
    assert.equal(next.done, false, label + ' the watch must still yield frame ' + String(index))
    frames.push(next.value)
  }
  return frames
}

test('one interval publishes working and then ONE atomic settle, with no interim frame', async (t) => {
  const session = { id: SESSION_ID }
  const live = agent('agent-a', session)
  const host = await mountHost({ agentFor: id => id === SESSION_ID ? live : undefined, onUnknownReason: () => {} })
  t.after(async () => { await host.ctx.fiber.dispose() })
  const controller = new AbortController()
  t.after(() => { controller.abort() })
  const iterator = host.service.watch(SESSION_ID, controller.signal)[Symbol.asyncIterator]()

  // The binding of the live Agent is itself a published fact (the epoch change
  // must reach the Client), and the opening snapshot carries the post-bind cut.
  const [snapshot] = await read(iterator, 1, 'L1')
  assert.deepEqual(
    { kind: snapshot.kind, running: snapshot.running, outcome: snapshot.outcome, agentEpoch: snapshot.agentEpoch },
    { kind: 'snapshot', running: false, outcome: 'idle', agentEpoch: 1 },
  )

  host.emit('agent/status', { agent: live, status: 'running' })
  const [working] = await read(iterator, 1, 'L2')
  assert.deepEqual(
    { kind: working.kind, running: working.running, outcome: working.outcome, revision: working.revision },
    { kind: 'update', running: true, outcome: 'idle', revision: 2 },
    'the running edge publishes working with an idle outcome',
  )

  // The durable turn evidence is captured but NEVER published: a done/error frame
  // may only appear with the settle (plan §6.4).
  host.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  host.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  host.emit('agent/status', { agent: live, status: 'idle' })
  const [settled] = await read(iterator, 1, 'L3')
  assert.deepEqual(
    { kind: settled.kind, running: settled.running, outcome: settled.outcome, revision: settled.revision },
    { kind: 'update', running: false, outcome: 'done', revision: 3 },
    'the falling edge settles ONE frame carrying both facts',
  )
  assert.equal(snapshot.hostEpoch, settled.hostEpoch, 'one Host instance keeps one host epoch')
})

test('every official reason classifies, an unknown one is reported, an unmatched end proves nothing', async (t) => {
  const session = { id: SESSION_ID }
  const reported: string[] = []
  const live = agent('agent-a', session)
  const host = await mountHost({ agentFor: () => live, onUnknownReason: kind => reported.push(kind) })
  t.after(async () => { await host.ctx.fiber.dispose() })
  const controller = new AbortController()
  t.after(() => { controller.abort() })

  const cases: ReadonlyArray<readonly [string | undefined, string]> = [
    ['completed', 'done'],
    ['error', 'error'],
    ['max-tokens', 'error'],
    ['aborted', 'idle'],
    ['blocked', 'idle'],
    ['interrupted', 'idle'],
    ['forked', 'idle'],
    ['a-future-kind', 'idle'],
    // No turn/end at all, and an end that closes a DIFFERENT turn: neither can
    // prove a settlement.
    [undefined, 'idle'],
    ['unmatched-turn', 'idle'],
  ]
  for (const [kind, expected] of cases) {
    const iterator = host.service.watch(SESSION_ID, controller.signal)[Symbol.asyncIterator]()
    await read(iterator, 1, 'L4')
    host.emit('agent/status', { agent: live, status: 'running' })
    await read(iterator, 1, 'L5')
    host.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    if (kind === 'unmatched-turn') {
      host.emit('session/event', session, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
    } else if (kind !== undefined) {
      host.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind } } })
    }
    host.emit('agent/status', { agent: live, status: 'idle' })
    const [settled] = await read(iterator, 1, 'L6')
    assert.equal(settled.outcome, expected, `reason ${kind ?? '<none>'} must settle ${expected}`)
    await iterator.return?.(undefined)
  }
  assert.deepEqual(reported, ['a-future-kind'], 'exactly the unknown upstream kind is reported')
})

test('the latest closed turn decides and the Session OBJECT is the identity fence', async (t) => {
  const session = { id: SESSION_ID }
  const live = agent('agent-a', session)
  const host = await mountHost({ agentFor: () => live, onUnknownReason: () => {} })
  t.after(async () => { await host.ctx.fiber.dispose() })
  const controller = new AbortController()
  t.after(() => { controller.abort() })

  // 1. A newer turn invalidates the older proven candidate.
  const first = host.service.watch(SESSION_ID, controller.signal)[Symbol.asyncIterator]()
  await read(first, 1, 'L7')
  host.emit('agent/status', { agent: live, status: 'running' })
  await read(first, 1, 'L8')
  host.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  host.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  host.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } })
  host.emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } })
  host.emit('agent/status', { agent: live, status: 'idle' })
  const [settled] = await read(first, 1, 'L9')
  assert.equal(settled.outcome, 'error', 'the LAST valid closed turn of the interval decides')
  await first.return?.(undefined)

  // 2. A same-id but DIFFERENT Session object cannot contribute evidence.
  const replacedSession = { id: SESSION_ID }
  const second = host.service.watch(SESSION_ID, controller.signal)[Symbol.asyncIterator]()
  await read(second, 1, 'L10')
  host.emit('agent/status', { agent: live, status: 'running' })
  await read(second, 1, 'L11')
  host.emit('session/event', replacedSession, { type: 'turn/start', data: { turn: 3 } })
  host.emit('session/event', replacedSession, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  host.emit('agent/status', { agent: live, status: 'idle' })
  const [fenced] = await read(second, 1, 'L12')
  assert.equal(fenced.outcome, 'idle', 'a foreign Session object never contributes terminal evidence')
  await second.return?.(undefined)

  // 3. The SAME Session object still does.
  const third = host.service.watch(SESSION_ID, controller.signal)[Symbol.asyncIterator]()
  await read(third, 1, 'L13')
  host.emit('agent/status', { agent: live, status: 'running' })
  await read(third, 1, 'L14')
  host.emit('session/event', session, { type: 'turn/start', data: { turn: 4 } })
  host.emit('session/event', session, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
  host.emit('agent/status', { agent: live, status: 'idle' })
  const [proven] = await read(third, 1, 'L15')
  assert.equal(proven.outcome, 'done', 'the bound Agent Session object still proves its own turn')
  await third.return?.(undefined)
})

test('an Agent replacement opens a new epoch and inherits nothing', async (t) => {
  const session = { id: SESSION_ID }
  const first = agent('agent-a', session)
  const second = agent('agent-b', session)
  let live: LiveAgentLike = first
  const host = await mountHost({ agentFor: () => live, onUnknownReason: () => {} })
  t.after(async () => { await host.ctx.fiber.dispose() })
  const controller = new AbortController()
  t.after(() => { controller.abort() })
  const iterator = host.service.watch(SESSION_ID, controller.signal)[Symbol.asyncIterator]()

  const [snapshot] = await read(iterator, 1, 'L16')
  assert.equal(snapshot.agentEpoch, 1)
  host.emit('agent/status', { agent: first, status: 'running' })
  await read(iterator, 1, 'L17')
  host.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  host.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  // The Agent object is replaced under the SAME session id before the settle: the
  // next event resolves the new object, opens a new epoch and discards the old
  // interval's proven candidate instead of publishing it.
  live = second
  host.emit('agent/status', { agent: second, status: 'idle' })
  const [rebound] = await read(iterator, 1, 'L18')
  assert.deepEqual(
    { kind: rebound.kind, running: rebound.running, outcome: rebound.outcome, agentEpoch: rebound.agentEpoch },
    { kind: 'update', running: false, outcome: 'idle', agentEpoch: 2 },
    'the replacement publishes a fresh idle interval under a new epoch',
  )
  await iterator.return?.(undefined)
})

test('an Agent disposal retires a live interval, ends the watchers and drops the record', async (t) => {
  const session = { id: SESSION_ID }
  const live = agent('agent-a', session)
  let liveAgent: LiveAgentLike | undefined = live
  const host = await mountHost({ agentFor: () => liveAgent, onUnknownReason: () => {} })
  t.after(async () => { await host.ctx.fiber.dispose() })
  const controller = new AbortController()
  t.after(() => { controller.abort() })
  const iterator = host.service.watch(SESSION_ID, controller.signal)[Symbol.asyncIterator]()

  await read(iterator, 1, 'L19')
  host.emit('agent/status', { agent: live, status: 'running' })
  await read(iterator, 1, 'L20')
  liveAgent = undefined
  host.emit('agent/disposed', { agent: live })
  const [retired] = await read(iterator, 1, 'L21')
  assert.deepEqual(
    { running: retired.running, outcome: retired.outcome },
    { running: false, outcome: 'idle' },
    'a live interval retires to idle, never a fabricated settlement',
  )
  const done = await iterator.next()
  assert.equal(done.done, true, 'the disposal ends the watch stream')
  // A late event from the disposed lifetime can neither revive it nor create a
  // record again.
  host.emit('agent/status', { agent: live, status: 'running' })
  const reopened = host.service.watch(SESSION_ID, controller.signal)[Symbol.asyncIterator]()
  const [after] = await read(reopened, 1, 'L22')
  assert.deepEqual(
    { running: after.running, outcome: after.outcome },
    { running: false, outcome: 'idle' },
    'a disposed Agent leaves no retained completion behind',
  )
  await reopened.return?.(undefined)
})

test('a subscriber that stops draining fails explicitly instead of losing an edge', async (t) => {
  const session = { id: SESSION_ID }
  const live = agent('agent-a', session)
  const host = await mountHost({ agentFor: () => live, onUnknownReason: () => {} })
  t.after(async () => { await host.ctx.fiber.dispose() })
  const controller = new AbortController()
  t.after(() => { controller.abort() })
  const iterator = host.service.watch(SESSION_ID, controller.signal)[Symbol.asyncIterator]()
  await read(iterator, 1, 'overflow-baseline')
  // The consumer never reads again: the queue must fail the stream instead of
  // dropping the edges it cannot hold.
  for (let index = 0; index < 200; index += 1) {
    host.emit('agent/status', { agent: live, status: index % 2 === 0 ? 'running' : 'idle' })
  }
  await assert.rejects(
    async () => { await read(iterator, 1, 'overflow') },
    /subscriber queue overflowed/u,
    'an overflowing subscriber stream fails explicitly',
  )
})

test('the cut loses no edge and replays none, and the fiber disposal closes the watchers', async (t) => {
  const session = { id: SESSION_ID }
  const live = agent('agent-a', session)
  const host = await mountHost({ agentFor: () => live, onUnknownReason: () => {} })
  const controller = new AbortController()
  t.after(() => { controller.abort() })
  const iterator = host.service.watch(SESSION_ID, controller.signal)[Symbol.asyncIterator]()
  const [snapshot] = await read(iterator, 1, 'L23')

  // Four distinct transitions emitted back-to-back, with no read in between: the
  // subscriber queue must deliver every one of them, in order, exactly once.
  host.emit('agent/status', { agent: live, status: 'running' })
  host.emit('agent/status', { agent: live, status: 'idle' })
  host.emit('agent/status', { agent: live, status: 'running' })
  host.emit('agent/status', { agent: live, status: 'idle' })
  const burst = await read(iterator, 4, 'L24')
  assert.deepEqual(
    burst.map(frame => frame.running),
    [true, false, true, false],
    'every edge is delivered in order',
  )
  assert.deepEqual(
    burst.map(frame => frame.revision),
    [snapshot.revision + 1, snapshot.revision + 2, snapshot.revision + 3, snapshot.revision + 4],
    'revisions are contiguous: no frame lost, none replayed',
  )

  await host.fiber.dispose()
  const closed = await iterator.next()
  assert.equal(closed.done, true, 'disposing the Host row fiber ends the watch stream')
  await host.ctx.fiber.dispose()
})
