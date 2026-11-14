/**
 * The Remote `TeamBoardReadPort` (FR2): the official `agentTeam` Client
 * projection over the ONE binding + Connection generation. Structural
 * stand-ins cover Root/Child/Off/failure/stale/unavailable, the wire shape
 * checks (invalid status/arrays never read as empty), and the re-arming
 * subscription lifecycle. The real split-Host smoke owns the wire itself.
 *
 * @module @xmoon76/dsh-pi-tui/team-board-read-remote.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteTeamBoardReadPort, type RemoteTeamBoardSessionsSource } from '../../../src/runtime/remote/team-board-read-remote.ts'
import type { RemoteConnectionGenerationSource } from '../../../src/runtime/remote/session-reader-remote.ts'

const AGENT_TEAM = 'agentTeam'

class FakeFace {
  private value: unknown
  private readonly listeners = new Set<() => void>()
  constructor(value: unknown) { this.value = value }
  getSnapshot(): unknown { return this.value }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(value: unknown): void {
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }
  size(): number { return this.listeners.size }
}

function generation(initial: unknown): RemoteConnectionGenerationSource & { set(next: unknown): void } {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value as never,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: unknown) { value = next; for (const listener of [...listeners]) listener() },
  }
}

function makeSession(options: {
  readonly face?: FakeFace
  readonly subagent?: unknown
  readonly removed?: boolean
  readonly withSnapshot?: boolean
}) {
  const face = options.face ?? new FakeFace({ enabled: true, tasks: [] })
  const session = {
    projections: { faceOf: (key: string) => { if (key === AGENT_TEAM) return face; throw new Error(`unexpected key ${key}`) } },
    ...(options.withSnapshot === false
      ? {}
      : { getSnapshot: () => ({ subagent: options.subagent ?? null, removed: options.removed ?? false }) }),
  }
  return { session, face }
}

function makeSessions(initial: { session: unknown } | undefined) {
  // A STABLE binding wrapper per value (the adapter's same-id-rebind fence
  // compares binding identity, exactly like the real ClientSessions).
  let wrapper: { session: unknown } | undefined = initial
  let row: { origin?: 'subagent' } | undefined = { origin: undefined }
  const listeners = new Set<() => void>()
  const sessions = {
    binding: () => wrapper,
    list: {
      getSnapshot: () => ({ byId: row === undefined ? {} : { root: row } }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
  }
  return {
    sessions: sessions as unknown as RemoteTeamBoardSessionsSource,
    setBinding(next: { session: unknown } | undefined) { wrapper = next },
    setOrigin(origin: 'subagent' | undefined) { row = origin === undefined ? undefined : { origin } },
    emitList() { for (const listener of [...listeners]) listener() },
    listSize: () => listeners.size,
  }
}

function board(tasks: unknown[], enabled = true): unknown {
  return { enabled, tasks }
}

const task = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'task-1', revision: 1, subject: 'Implement adapter', description: 'read-only board',
  status: 'in_progress', blockedBy: [], writeScopes: ['src/runtime'], ready: false, writeScopeWarnings: [],
  ...overrides,
})

test('Remote board reads the official projection for the root binding and detaches it', () => {
  const { session } = makeSession({ face: new FakeFace(board([task(), task({ id: 'task-2', status: 'pending', ready: true, ownerId: 's-rev', ownerName: 'reviewer' })])) })
  const s = makeSessions({ session })
  const port = new RemoteTeamBoardReadPort({ sessions: s.sessions, connection: { generation: generation({ id: 'g1' }) } })
  const snapshot = port.read('root')
  assert.equal(snapshot.kind, 'ready')
  if (snapshot.kind !== 'ready') return
  assert.equal(snapshot.tasks.length, 2)
  assert.deepEqual(snapshot.tasks[1], {
    id: 'task-2', revision: 1, subject: 'Implement adapter', description: 'read-only board',
    status: 'pending', ownerId: 's-rev', ownerName: 'reviewer', ready: true,
    blockedBy: [], writeScopes: ['src/runtime'], writeScopeWarnings: [],
  })
})

test('Remote board keeps an OFF board ready and retains failure alongside tasks', () => {
  const off = makeSession({ face: new FakeFace(board([task({ status: 'completed' })], false)) })
  const offPort = new RemoteTeamBoardReadPort({ sessions: makeSessions({ session: off.session }).sessions, connection: { generation: generation({ id: 'g' }) } })
  const offSnap = offPort.read('root')
  assert.equal(offSnap.kind, 'ready')
  if (offSnap.kind === 'ready') assert.equal(offSnap.enabled, false)

  const failed = makeSession({ face: new FakeFace({ enabled: true, tasks: [task()], failure: 'persisted invalid' }) })
  const failPort = new RemoteTeamBoardReadPort({ sessions: makeSessions({ session: failed.session }).sessions, connection: { generation: generation({ id: 'g' }) } })
  const failSnap = failPort.read('root')
  assert.equal(failSnap.kind, 'ready')
  if (failSnap.kind === 'ready') { assert.equal(failSnap.failure, 'persisted invalid'); assert.equal(failSnap.tasks.length, 1) }
})

test('Remote board refuses a confirmed child, and distinguishes a missing binding from a child', () => {
  const child = makeSession({ face: new FakeFace(board([])), subagent: { parent: 'root' } })
  const childPort = new RemoteTeamBoardReadPort({ sessions: makeSessions({ session: child.session }).sessions, connection: { generation: generation({ id: 'g' }) } })
  assert.deepEqual(childPort.read('root'), { kind: 'unavailable', cause: 'not-root', reason: 'The Team board is available only for the root Session' })

  const missing = makeSessions(undefined)
  missing.setOrigin('subagent')
  const missPort = new RemoteTeamBoardReadPort({ sessions: missing.sessions, connection: { generation: generation({ id: 'g' }) } })
  assert.equal((missPort.read('root') as { cause?: string }).cause, 'not-root', 'a Session-list subagent origin proves the refusal')

  const absent = makeSessions(undefined)
  absent.setOrigin(undefined)
  const absentPort = new RemoteTeamBoardReadPort({ sessions: absent.sessions, connection: { generation: generation({ id: 'g' }) } })
  assert.equal((absentPort.read('root') as { cause?: string }).cause, 'session-missing')
})

test('Remote board reports stale when the connection generation is absent', () => {
  const { session } = makeSession({ face: new FakeFace(board([])) })
  const port = new RemoteTeamBoardReadPort({ sessions: makeSessions({ session }).sessions, connection: { generation: generation(undefined) } })
  assert.deepEqual(port.read('root'), { kind: 'stale', reason: 'the Host connection is not ready' })
})

test('Remote board fails CLOSED on an invalid status or array (never an empty board)', () => {
  const invalidStatus = makeSession({ face: new FakeFace(board([task({ status: 'archived' })])) })
  const p1 = new RemoteTeamBoardReadPort({ sessions: makeSessions({ session: invalidStatus.session }).sessions, connection: { generation: generation({ id: 'g' }) } })
  assert.equal(p1.read('root').kind, 'stale', 'an unknown status is never coerced to completed')

  const invalidArray = makeSession({ face: new FakeFace(board([task({ blockedBy: 'nope' })])) })
  const p2 = new RemoteTeamBoardReadPort({ sessions: makeSessions({ session: invalidArray.session }).sessions, connection: { generation: generation({ id: 'g' }) } })
  assert.equal(p2.read('root').kind, 'stale', 'a non-array field is never read as empty')
})

test('Remote board filters deleted tasks from the visible board', () => {
  const { session } = makeSession({ face: new FakeFace(board([task(), task({ id: 'task-del', status: 'deleted' })])) })
  const port = new RemoteTeamBoardReadPort({ sessions: makeSessions({ session }).sessions, connection: { generation: generation({ id: 'g' }) } })
  const snapshot = port.read('root')
  assert.equal(snapshot.kind, 'ready')
  if (snapshot.kind === 'ready') assert.deepEqual(snapshot.tasks.map(t => t.id), ['task-1'])
})

test('Remote board reports stale when the connection changes during the read', () => {
  const gen = generation({ id: 'g1' })
  let armed = false
  const face = new FakeFace(board([]))
  const flipping = {
    getSnapshot(): unknown {
      // The FIRST read (inside the adapter) reconnects; the fence must reject.
      if (armed) { armed = false; gen.set({ id: 'g2' }) }
      return board([])
    },
    subscribe: () => () => {},
  }
  const { session } = makeSession({ face: face as unknown as FakeFace })
  // Replace the binding face with the flipping one.
  ;(session.projections as { faceOf: (key: string) => unknown }).faceOf = (key: string) => (key === AGENT_TEAM ? flipping : face)
  const port = new RemoteTeamBoardReadPort({ sessions: makeSessions({ session }).sessions, connection: { generation: gen } })
  armed = true
  const snapshot = port.read('root')
  assert.deepEqual(snapshot, { kind: 'stale', reason: 'the Host connection changed while reading the Team board' })
})

test('Remote board subscription re-arms on binding arrival and generation change and disposes once', () => {
  const first = makeSession({ face: new FakeFace(board([task()])) })
  const s = makeSessions({ session: first.session })
  const gen = generation({ id: 'g1' })
  const port = new RemoteTeamBoardReadPort({ sessions: s.sessions, connection: { generation: gen } })
  let calls = 0
  const dispose = port.subscribe('root', () => { calls += 1 })
  assert.equal(first.face.size(), 1, 'the current binding face is subscribed')

  first.face.set(board([task({ status: 'completed' })]))
  assert.equal(calls, 1, 'a same-binding agentTeam change fires')

  // A same-id rebind produces a NEW face; the generation change re-arms it.
  const rebuilt = makeSession({ face: new FakeFace(board([])) })
  s.setBinding({ session: rebuilt.session })
  gen.set({ id: 'g2' })
  assert.equal(calls, 2, 'a generation change re-arms and notifies')
  assert.equal(rebuilt.face.size(), 1, 'the rebuilt binding face is subscribed')
  assert.equal(first.face.size(), 0, 'the retired binding face is released')

  dispose()
  dispose()
  const callsAfter = calls
  rebuilt.face.set(board([task()]))
  assert.equal(calls, callsAfter, 'a disposed subscription never fires again')
})

test('Remote board subscribe is Root-only: a confirmed child binding never attaches or notifies', () => {
  const child = makeSession({ face: new FakeFace(board([task()])), subagent: { parent: 'root' } })
  const s = makeSessions({ session: child.session })
  const gen = generation({ id: 'g' })
  const port = new RemoteTeamBoardReadPort({ sessions: s.sessions, connection: { generation: gen } })
  let calls = 0
  const dispose = port.subscribe('root', () => { calls += 1 })
  assert.equal(child.face.size(), 0, 'a child binding never gets a face listener')
  gen.set({ id: 'g2' })
  assert.equal(calls, 0, 'a generation change never notifies a confirmed child')
  dispose()
})

test('Remote board subscribe stays silent when an initially absent binding resolves to a child', () => {
  const s = makeSessions(undefined)
  const gen = generation({ id: 'g' })
  const port = new RemoteTeamBoardReadPort({ sessions: s.sessions, connection: { generation: gen } })
  let calls = 0
  const dispose = port.subscribe('root', () => { calls += 1 })
  const child = makeSession({ face: new FakeFace(board([task()])), subagent: { parent: 'root' } })
  s.setBinding({ session: child.session })
  s.emitList()
  gen.set({ id: 'g2' })
  assert.equal(child.face.size(), 0, 'a late child binding never gets a face listener')
  assert.equal(calls, 0, 'a generation/list change never notifies once the binding proves a child')
  dispose()
})

test('Remote board disposer is idempotent even when a lower-layer off is not', () => {
  let genOffCalls = 0
  const gen = {
    getSnapshot: () => ({ id: 'g' }) as never,
    subscribe: () => () => { genOffCalls += 1; if (genOffCalls > 1) throw new Error('double generation off') },
  }
  let faceOffCalls = 0
  const face = {
    getSnapshot: () => board([task()]),
    subscribe: () => () => { faceOffCalls += 1; if (faceOffCalls > 1) throw new Error('double face off') },
  }
  const session = { projections: { faceOf: (key: string) => { if (key === AGENT_TEAM) return face; throw new Error('key') } }, getSnapshot: () => ({ subagent: null }) }
  const port = new RemoteTeamBoardReadPort({ sessions: makeSessions({ session }).sessions, connection: { generation: gen } })
  const dispose = port.subscribe('root', () => {})
  assert.equal(faceOffCalls, 0)
  assert.doesNotThrow(() => { dispose(); dispose() })
  assert.equal(genOffCalls, 1, 'the generation off runs once')
  assert.equal(faceOffCalls, 1, 'the face off runs once')
})
