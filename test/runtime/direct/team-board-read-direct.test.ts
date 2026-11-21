/**
 * The Direct `TeamBoardReadPort` (FR2): the official `agentTeam` projection's
 * READ-ONLY board over the exact live Root Session. Structural stands-in cover
 * the Root/Child/Off/failure/stale/unavailable contract and the same-Session
 * `agentTeam` change feed; no Team write is reachable here.
 *
 * @module @xmoon76/dsh-pi-tui/team-board-read-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectTeamBoardReadPort } from '../../../src/runtime/direct/team-board-read-direct.ts'

interface TaskViewLike {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: 'pending' | 'in_progress' | 'completed'
  readonly blockedBy: readonly string[]
  readonly writeScopes: readonly string[]
  readonly ownerId?: string
  readonly ownerName?: string
  readonly ready: boolean
  readonly writeScopeWarnings: readonly string[]
}

function taskView(overrides: Partial<TaskViewLike> = {}): TaskViewLike {
  return {
    id: 'task-1',
    revision: 1,
    subject: 'Implement adapter',
    description: 'Build the read-only board',
    status: 'in_progress',
    blockedBy: [],
    writeScopes: ['src/runtime'],
    ready: false,
    writeScopeWarnings: [],
    ...overrides,
  }
}

interface HarnessOptions {
  readonly live?: boolean
  readonly isRoot?: boolean
  readonly projection?: unknown
  readonly withSubagents?: boolean
  readonly withProjections?: boolean
}

function harness(options: HarnessOptions = {}) {
  const session = {}
  const agent = { session }
  const listeners = new Set<(session: unknown, key: string, value: unknown, seq: unknown) => void>()
  const changed = { offCalls: 0 }
  const ctx = {
    get(name: string): unknown {
      if (name === 'subagents' && options.withSubagents !== false) {
        return { rootOf: () => (options.isRoot === false ? { other: true } : agent) }
      }
      if (name === 'sessionProjections' && options.withProjections !== false) {
        return {
          snapshot: () => ({ values: { agentTeam: options.projection } }),
          onChanged: (listener: (session: unknown, key: string, value: unknown, seq: unknown) => void) => {
            listeners.add(listener)
            return () => { listeners.delete(listener); changed.offCalls += 1 }
          },
        }
      }
      return undefined
    },
  }
  const port = new DirectTeamBoardReadPort(ctx, id => (options.live === false ? undefined : (id === 'root' ? agent : undefined)))
  const emit = (s: unknown, key: string): void => { for (const listener of [...listeners]) listener(s, key, undefined, 0) }
  return { port, agent, session, listeners, changed, emit }
}

test('Direct board reads the official projection for the live Root and detaches it', () => {
  const projection = {
    enabled: true,
    tasks: [taskView({ id: 'task-1', status: 'in_progress' }), taskView({ id: 'task-2', status: 'pending', ready: true, ownerId: 's-rev', ownerName: 'reviewer', writeScopeWarnings: ['write scopes overlap with task-1'] })],
  }
  const { port } = harness({ projection })
  const snapshot = port.read('root')
  assert.equal(snapshot.kind, 'ready')
  if (snapshot.kind !== 'ready') return
  assert.equal(snapshot.enabled, true)
  assert.equal(snapshot.tasks.length, 2)
  assert.deepEqual(snapshot.tasks[1], {
    id: 'task-2', revision: 1, subject: 'Implement adapter', description: 'Build the read-only board',
    status: 'pending', ownerId: 's-rev', ownerName: 'reviewer', ready: true,
    blockedBy: [], writeScopes: ['src/runtime'], writeScopeWarnings: ['write scopes overlap with task-1'],
  })
  assert.equal(Object.isFrozen(snapshot.tasks), true)
  assert.equal(Object.isFrozen(snapshot.tasks[1]!.blockedBy), true)
})

test('Direct board keeps an OFF board READY with its retained tasks (never unavailable)', () => {
  const { port } = harness({ projection: { enabled: false, tasks: [taskView({ status: 'completed' })] } })
  const snapshot = port.read('root')
  assert.equal(snapshot.kind, 'ready')
  if (snapshot.kind === 'ready') {
    assert.equal(snapshot.enabled, false)
    assert.equal(snapshot.tasks.length, 1)
  }
})

test('Direct board surfaces failure ALONGSIDE the retained tasks', () => {
  const { port } = harness({ projection: { enabled: true, tasks: [taskView()], failure: 'persisted task payload is invalid' } })
  const snapshot = port.read('root')
  assert.equal(snapshot.kind, 'ready')
  if (snapshot.kind === 'ready') {
    assert.equal(snapshot.failure, 'persisted task payload is invalid')
    assert.equal(snapshot.tasks.length, 1)
  }
})

test('Direct board refuses a child, a missing Session and a missing authority', () => {
  assert.deepEqual(harness({ isRoot: false, projection: { enabled: true, tasks: [] } }).port.read('root'),
    { kind: 'unavailable', cause: 'not-root', reason: 'The Team board is available only for the root Session' })
  assert.equal(harness({ live: false }).port.read('root').kind, 'unavailable')
  assert.deepEqual(harness({ live: false }).port.read('root'),
    { kind: 'unavailable', cause: 'session-missing', reason: 'Session "root" is not live' })
  assert.equal(harness({ withSubagents: false }).port.read('root').kind, 'unavailable')
  if (harness({ withSubagents: false }).port.read('root').kind === 'unavailable') {
    assert.equal((harness({ withSubagents: false }).port.read('root') as { cause?: string }).cause, 'authority-missing')
  }
})

test('Direct board reports stale when the projection value is not readable (never an empty board)', () => {
  const { port } = harness({ projection: undefined })
  assert.deepEqual(port.read('root'), { kind: 'stale', reason: 'the Agent Team board projection is not readable' })
})

test('Direct board subscribes to the SAME Session agentTeam changes only, and disposes idempotently', () => {
  const { port, agent, session, changed, emit } = harness({ projection: { enabled: true, tasks: [] } })
  let calls = 0
  const dispose = port.subscribe('root', () => { calls += 1 })
  emit(session, 'agentTeam')
  assert.equal(calls, 1, 'a same-Session agentTeam change fires the listener')
  emit({ other: true }, 'agentTeam')
  assert.equal(calls, 1, 'another Session never fires')
  emit(session, 'modelSelection')
  assert.equal(calls, 1, 'a different key never fires')
  assert.equal(agent, agent)
  dispose()
  dispose()
  emit(session, 'agentTeam')
  assert.equal(calls, 1, 'a disposed subscription never fires again')
  assert.equal(changed.offCalls, 1, 'dispose releases exactly once')
})

test('Direct board subscribe is Root-only: a confirmed child registers no listener', () => {
  const { port, listeners, session, emit } = harness({ isRoot: false, projection: { enabled: true, tasks: [] } })
  let calls = 0
  const dispose = port.subscribe('root', () => { calls += 1 })
  assert.equal(listeners.size, 0, 'a child never attaches an agentTeam listener')
  emit(session, 'agentTeam')
  assert.equal(calls, 0, 'a child receives no board callback')
  dispose()
})
