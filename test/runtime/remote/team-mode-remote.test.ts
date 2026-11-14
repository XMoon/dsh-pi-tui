/**
 * The Remote `TeamModePort` (FR1): the official generated `agentTeams`
 * namespace over the ONE Client Session binding and Connection generation.
 * Structural stand-ins cover the exact projection/currentness/classification
 * contract; the real split-Host smoke owns the wire itself.
 *
 * @module @xmoon76/dsh-pi-tui/team-mode-remote.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteTeamModePort, type RemoteTeamModeNamespace } from '../../../src/runtime/remote/team-mode-remote.ts'

const AGENT_TEAM = 'agentTeam'
const MODEL_SELECTION = 'modelSelection'

class FakeFace {
  private value: unknown
  private readonly listeners = new Set<() => void>()

  constructor(value: unknown) {
    this.value = value
  }

  getSnapshot(): unknown {
    return this.value
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(value: unknown): void {
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }

  size(): number {
    return this.listeners.size
  }
}

function generationSource(initial: unknown): {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
  set(value: unknown): void
} {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

interface BindingFixture {
  readonly team: FakeFace
  readonly model: FakeFace
  readonly binding: {
    readonly session: {
      readonly projections: { faceOf(key: string): FakeFace }
      getSnapshot?(): { subagent?: unknown; removed?: unknown }
    }
  }
}

function makeBinding(options: {
  readonly enabled?: boolean
  readonly lastUsed?: unknown
  readonly subagent?: unknown
  readonly removed?: boolean
  readonly withSnapshot?: boolean
  readonly missingModel?: boolean
} = {}): BindingFixture {
  const team = new FakeFace({ enabled: options.enabled ?? false, tasks: [] })
  const model = new FakeFace(options.missingModel === true
    ? undefined
    : { lastUsed: options.lastUsed === undefined ? null : options.lastUsed, next: null })
  const session: BindingFixture['binding']['session'] = {
    projections: {
      faceOf: (key: string) => {
        if (key === AGENT_TEAM) return team
        if (key === MODEL_SELECTION) return model
        throw new Error(`unexpected projection key ${key}`)
      },
    },
    ...(options.withSnapshot === false
      ? {}
      : { getSnapshot: () => ({ subagent: options.subagent ?? null, removed: options.removed ?? false }) }),
  }
  return { team, model, binding: { session } }
}

function makeSessions(binding: BindingFixture['binding'] | undefined): {
  readonly sessions: {
    binding(sessionId: string): BindingFixture['binding'] | undefined
    readonly list: {
      getSnapshot(): { byId: Record<string, { origin?: 'subagent' } | undefined> }
      subscribe?(listener: () => void): () => void
    }
  }
  setBinding(next: BindingFixture['binding'] | undefined): void
  setOrigin(origin: 'subagent' | undefined): void
} {
  let current = binding
  let row: { origin?: 'subagent' } | undefined = { origin: undefined }
  const listListeners = new Set<() => void>()
  const notify = (): void => { for (const listener of [...listListeners]) listener() }
  return {
    sessions: {
      binding: () => current,
      list: {
        getSnapshot: () => ({ byId: { s1: row } }),
        subscribe(listener) {
          listListeners.add(listener)
          return () => { listListeners.delete(listener) }
        },
      },
    },
    setBinding(next) { current = next; notify() },
    setOrigin(origin) { row = { origin }; notify() },
  }
}

function makeNamespace(
  handler: (sessionId: string, enabled: boolean, signal?: AbortSignal) => Promise<unknown>,
): { namespace: RemoteTeamModeNamespace; calls: Array<{ sessionId: string; enabled: boolean }> } {
  const calls: Array<{ sessionId: string; enabled: boolean }> = []
  return {
    namespace: {
      setEnabled(sessionId, enabled, signal) {
        calls.push({ sessionId, enabled })
        return handler(sessionId, enabled, signal) as ReturnType<RemoteTeamModeNamespace['setEnabled']>
      },
    },
    calls,
  }
}

const READY_NAMESPACE: RemoteTeamModeNamespace = {
  setEnabled: async () => ({ ok: true, value: undefined }),
}

function portOf(options: {
  readonly binding?: BindingFixture['binding']
  readonly generation?: unknown
  /** `null` = the generated namespace is NOT mounted; omitted = a ready stub. */
  readonly namespace?: RemoteTeamModeNamespace | null
}): {
  readonly port: RemoteTeamModePort
  readonly sessions: ReturnType<typeof makeSessions>
  readonly generation: ReturnType<typeof generationSource>
} {
  const sessions = makeSessions(options.binding)
  const generation = generationSource(
    options.generation === null ? undefined : options.generation === undefined ? { id: 'gen-1' } : options.generation,
  )
  const port = new RemoteTeamModePort({
    sessions: sessions.sessions,
    remote: { agentTeams: options.namespace === null ? undefined : options.namespace ?? READY_NAMESPACE },
    connection: { generation: generation as never },
  })
  return { port, sessions, generation }
}

const signal = new AbortController().signal

test('Remote Team port: reads the official two-projection cut for the exact binding', () => {
  const off = makeBinding({ enabled: false, lastUsed: null })
  const { port } = portOf({ binding: off.binding })
  assert.deepEqual(port.read('s1'), { kind: 'ready', enabled: false, modelRequestHistory: 'none' })

  const on = makeBinding({ enabled: true, lastUsed: { provider: 'p', model: 'm' } })
  const second = portOf({ binding: on.binding })
  assert.deepEqual(second.port.read('s1'), { kind: 'ready', enabled: true, modelRequestHistory: 'recorded' })
})

test('Remote Team port: an absent modelSelection projection is stale, never "no request"', () => {
  const missing = makeBinding({ missingModel: true })
  const { port } = portOf({ binding: missing.binding })
  const snapshot = port.read('s1')
  assert.equal(snapshot.kind, 'stale')
  assert.match(snapshot.kind === 'stale' ? snapshot.reason : '', /model request history/u)

  const malformed = makeBinding({ lastUsed: { provider: '', model: 'm' } })
  assert.equal(portOf({ binding: malformed.binding }).port.read('s1').kind, 'stale')
})

test('Remote Team port: a child binding is root-only unavailable and cannot dispatch', async () => {
  const child = makeBinding({ subagent: { parentSessionId: 'root', childSessionId: 's1', mode: 'continuable' } })
  const { calls, namespace } = makeNamespace(async () => ({ ok: true, value: undefined }))
  const { port } = portOf({ binding: child.binding, namespace })
  assert.deepEqual(port.read('s1'), {
    kind: 'unavailable',
    reason: 'Agent Team mode is available only for the root Session',
  })
  const outcome = await port.setEnabled('s1', true, signal)
  assert.equal(outcome.kind, 'rejected')
  assert.equal(calls.length, 0, 'a child never reaches the generated write')
})

test('Remote Team port: missing binding / removed Session / missing generation fail closed', async () => {
  const absent = portOf({ binding: undefined })
  assert.equal(absent.port.read('s1').kind, 'unavailable')
  assert.equal((await absent.port.setEnabled('s1', true, signal)).kind, 'rejected')

  const removed = makeBinding({ removed: true })
  assert.equal(portOf({ binding: removed.binding }).port.read('s1').kind, 'stale')

  const disconnected = portOf({ binding: makeBinding().binding, generation: null })
  assert.equal(disconnected.port.read('s1').kind, 'stale')
  const { calls, namespace } = makeNamespace(async () => ({ ok: true, value: undefined }))
  const offline = portOf({ binding: makeBinding().binding, generation: null, namespace })
  assert.equal((await offline.port.setEnabled('s1', true, signal)).kind, 'cancelled')
  assert.equal(calls.length, 0)
})

test('Remote Team port: the generated write settle is classified, never guessed', async () => {
  const success = makeNamespace(async () => ({ ok: true, value: undefined }))
  const okPort = portOf({ binding: makeBinding().binding, namespace: success.namespace })
  assert.deepEqual(await okPort.port.setEnabled('s1', true, signal), { kind: 'committed' })
  assert.deepEqual(success.calls, [{ sessionId: 's1', enabled: true }])

  // A domain refusal proves the write did not happen.
  const refused = makeNamespace(async () => ({
    ok: false,
    error: { code: 'TEAM_LEAD_REQUIRED', message: 'change Team mode from the root Session' },
  }))
  const refusedOutcome = await portOf({ binding: makeBinding().binding, namespace: refused.namespace })
    .port.setEnabled('s1', true, signal)
  assert.equal(refusedOutcome.kind, 'rejected')
  assert.match(refusedOutcome.kind === 'rejected' ? refusedOutcome.reason : '', /root Session/u)

  // A thrown transport/envelope failure after dispatch is indeterminate.
  const thrown = makeNamespace(async () => { throw new Error('socket closed') })
  const thrownOutcome = await portOf({ binding: makeBinding().binding, namespace: thrown.namespace })
    .port.setEnabled('s1', true, signal)
  assert.equal(thrownOutcome.kind, 'indeterminate')
  assert.match(thrownOutcome.kind === 'indeterminate' ? thrownOutcome.reason : '', /socket closed/u)

  // A pre-dispatch abort and a missing mounted namespace are both refusals to
  // dispatch, never a fabricated commit.
  const controller = new AbortController()
  controller.abort()
  const abortedNamespace = makeNamespace(async () => { throw new Error('must not run') })
  assert.equal((await portOf({ binding: makeBinding().binding, namespace: abortedNamespace.namespace })
    .port.setEnabled('s1', true, controller.signal)).kind, 'cancelled')
  assert.equal(abortedNamespace.calls.length, 0)
  assert.equal((await portOf({ binding: makeBinding().binding, namespace: null }).port.setEnabled('s1', true, signal)).kind, 'rejected')
})

test('Remote Team port: subscribes the exact faces and re-arms across a rebind', () => {
  const first = makeBinding({ enabled: false })
  const sessions = makeSessions(first.binding)
  const generation = generationSource({ id: 'gen-1' })
  const port = new RemoteTeamModePort({
    sessions: sessions.sessions,
    remote: { agentTeams: undefined },
    connection: { generation: generation as never },
  })
  let notifications = 0
  const dispose = port.subscribe('s1', () => { notifications += 1 })
  assert.equal(first.team.size(), 1)
  assert.equal(first.model.size(), 1)
  first.team.set({ enabled: true, tasks: [] })
  assert.equal(notifications, 1, 'the face subscription forwards')

  // A same-id rebind must re-arm on the NEW binding and release the old faces.
  const second = makeBinding({ enabled: true })
  sessions.setBinding(second.binding)
  generation.set({ id: 'gen-2' })
  // The Session-list invalidation (binding arrived/replaced) notifies once, and
  // the Connection generation replacement notifies once more.
  assert.equal(notifications, 3, 'the binding replacement and generation change notify')
  assert.equal(first.team.size(), 0, 'the retired binding face is released')
  assert.equal(second.team.size(), 1)
  second.team.set({ enabled: false, tasks: [] })
  assert.equal(notifications, 4)

  dispose()
  dispose()
  assert.equal(second.team.size(), 0, 'the disposer releases every owned face')
  second.team.set({ enabled: true, tasks: [] })
  assert.equal(notifications, 4, 'the disposer is idempotent and final')
})

test('Remote Team port: the Session-list origin resolves Root identity when the binding cannot', () => {
  const structural = makeBinding({ withSnapshot: false })
  const sessions = makeSessions(structural.binding)
  const port = new RemoteTeamModePort({
    sessions: sessions.sessions,
    remote: { agentTeams: READY_NAMESPACE },
    connection: { generation: generationSource({ id: 'gen-1' }) as never },
  })
  assert.deepEqual(port.read('s1'), { kind: 'ready', enabled: false, modelRequestHistory: 'none' })
  sessions.setOrigin('subagent')
  assert.equal(port.read('s1').kind, 'unavailable')
})

test('Remote Team port: a readable projection without the mounted namespace is unavailable', () => {
  const { port } = portOf({ binding: makeBinding({ enabled: false }).binding, namespace: null })
  assert.deepEqual(port.read('s1'), {
    kind: 'unavailable',
    reason: 'the Agent Team Remote namespace is not mounted',
  })
})

test('Remote Team port: an initially absent binding recovers when the Session arrives', () => {
  const sessions = makeSessions(undefined)
  const port = new RemoteTeamModePort({
    sessions: sessions.sessions,
    remote: { agentTeams: READY_NAMESPACE },
    connection: { generation: generationSource({ id: 'gen-1' }) as never },
  })
  let notifications = 0
  const dispose = port.subscribe('s1', () => { notifications += 1 })
  assert.equal(port.read('s1').kind, 'unavailable')

  const bound = makeBinding({ enabled: false })
  sessions.setBinding(bound.binding)
  assert.equal(notifications, 1, 'the arriving binding notifies the view')
  assert.equal(bound.team.size(), 1, 'the faces are armed once the binding exists')
  assert.deepEqual(port.read('s1'), { kind: 'ready', enabled: false, modelRequestHistory: 'none' })

  dispose()
  assert.equal(bound.team.size(), 0)
})
