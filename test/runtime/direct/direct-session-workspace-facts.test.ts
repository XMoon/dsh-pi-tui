/**
 * L2 contract tests for the M5-U-A Direct read-authority adapter.
 *
 * The tests prove the Direct parity that U-A claims: `running` from the exact
 * live Agent status (and NEVER from the old `live` attachment bit), no
 * fabricated cross-Session pending fact, and the official `workspaceRegistry`
 * baseline plus `domain/changed` re-read (no second Workspace table). They use
 * a structural Host fake: this is Adapter semantics (L2), not a real Host
 * composition.
 *
 * @module @xmoon76/dsh-pi-tui/direct-session-workspace-facts.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DirectSessionWorkspaceFacts,
  directRunningOf,
  type DirectFactsAgentLike,
  type DirectFactsContextLike,
  type DirectInspectorReads,
} from '../../../src/runtime/direct/session-workspace-facts-direct.ts'
import type { WorkspaceFactEntityLike } from '../../../src/runtime/direct/session-lifecycle-direct.ts'
import type { SessionSummary } from '../../../src/runtime/session-reader-port.ts'
import { SupersededReadError } from '../../../src/runtime/read-error.ts'

const row = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, updatedAt: 1, live: false, ...overrides })

interface DirectHarness {
  readonly ctx: DirectFactsContextLike
  readonly facts: DirectSessionWorkspaceFacts
  readonly agents: Record<string, DirectFactsAgentLike>
  setWorkspaceRows(rows: readonly WorkspaceFactEntityLike[]): void
  emitDomainChange(domain: string): void
  /** Fire one official Agent lifecycle event (agent/status|created|disposed). */
  emitAgent(event: 'agent/status' | 'agent/created' | 'agent/disposed', id: string): void
  readonly offCount: () => number
}

function directHarness(options: {
  registry?: boolean
  agents?: Record<string, DirectFactsAgentLike>
  workspaces?: readonly WorkspaceFactEntityLike[]
}): DirectHarness {
  let rows = options.workspaces ?? []
  const agents = options.agents ?? {}
  let offCount = 0
  const listeners: Array<(change: { readonly domain: string }) => void> = []
  const agentListeners = new Map<string, Array<(payload: { readonly agent: { readonly id: string } }) => void>>()
  const registry = {
    list: () => rows,
  }
  const ctx = {
    get: (name: string) => (name === 'workspaceRegistry' && options.registry !== false ? registry : undefined),
    on: (name: string, listener: (payload: never) => unknown) => {
      if (name === 'domain/changed') {
        listeners.push(listener as unknown as (change: { readonly domain: string }) => void)
      } else {
        const registered = agentListeners.get(name) ?? []
        registered.push(listener as unknown as (payload: { readonly agent: { readonly id: string } }) => void)
        agentListeners.set(name, registered)
      }
      return () => { offCount += 1; return true }
    },
  } as unknown as DirectFactsContextLike
  return {
    ctx,
    agents,
    facts: new DirectSessionWorkspaceFacts(ctx, id => agents[id]),
    setWorkspaceRows: next => { rows = next },
    emitDomainChange: domain => { for (const listener of listeners) listener({ domain }) },
    emitAgent: (event, id) => {
      for (const listener of agentListeners.get(event) ?? []) listener({ agent: { id } })
    },
    offCount: () => offCount,
  }
}

test('UA-08 Direct running comes from the exact live Agent status, never from the old live bit', async () => {
  const h = directHarness({
    agents: {
      running: { status: 'running' },
      idle: { status: 'idle' },
    },
  })
  const facts = await h.facts.readActivity([
    row('running', { live: false }),
    row('idle', { live: true }),
    row('unmounted', { live: true }),
  ])
  assert.deepEqual(facts.map(fact => fact.running), [true, false, undefined],
    'a missing live Agent is unknown, and the stale `live` bit never supplies running')
})

test('UA-08 an unrecognized Agent status is unknown, never idle', () => {
  assert.equal(directRunningOf('running'), true)
  assert.equal(directRunningOf('idle'), false)
  assert.equal(directRunningOf('stopping'), undefined)
  assert.equal(directRunningOf(undefined), undefined)
})

test('UA-08 Direct never fabricates a cross-Session pending fact', async () => {
  const h = directHarness({ agents: { x: { status: 'running' } } })
  const facts = await h.facts.readActivity([row('x'), row('child', { origin: 'subagent' })])
  assert.deepEqual(facts.map(fact => fact.sessionId), ['x'], 'a subagent child never enters the facts')
  for (const fact of facts) {
    assert.equal(fact.pendingKinds, undefined)
    assert.equal(fact.continuedQuestionCallIds, undefined)
    assert.equal(fact.attention, 'unknown')
    assert.equal(fact.attentionSourceState, 'unknown')
  }
})

test('UA-07 the Direct Workspace baseline is the official registry list', async () => {
  const h = directHarness({
    workspaces: [
      { id: 'ws-a', path: '/host/a', title: 'A', sessionIds: ['s1'] },
      { id: 'ws-b', path: '/host/b', title: 'B', sessionIds: [] },
    ],
  })
  const handle = h.facts.followWorkspaces()
  assert.equal(handle.isCurrent(), true, 'the open Direct registry observation is current')
  const iterator = handle[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: {
      type: 'baseline',
      items: [
        { workspaceId: 'ws-a', path: '/host/a', title: 'A', sessionIds: ['s1'] },
        { workspaceId: 'ws-b', path: '/host/b', title: 'B', sessionIds: [] },
      ],
    },
  })
  handle.dispose()
  assert.equal(handle.isCurrent(), false, 'a disposed observation is no longer current')
  assert.deepEqual(await iterator.next(), { done: true, value: undefined })
  assert.equal(h.offCount(), 1, 'the domain subscription is released exactly once')
})

test('UA-07 a Workspace domain change publishes a REPLACEMENT re-read from the registry', async () => {
  const h = directHarness({
    workspaces: [{ id: 'ws-a', path: '/host/a', title: 'A', sessionIds: [] }],
  })
  const handle = h.facts.followWorkspaces()
  const iterator = handle[Symbol.asyncIterator]()
  await iterator.next()
  const next = iterator.next()
  // The authoritative table changed between the baseline and the commit event:
  // the replacement must carry the CURRENT registry, not the event payload.
  h.setWorkspaceRows([{ id: 'ws-b', path: '/host/b', title: 'B', sessionIds: ['s2'] }])
  h.emitDomainChange('workspace')
  assert.deepEqual(await next, {
    done: false,
    value: { type: 'replace', items: [{ workspaceId: 'ws-b', path: '/host/b', title: 'B', sessionIds: ['s2'] }] },
  })
  // A non-Workspace domain write is not a Workspace fact.
  h.emitDomainChange('session-log')
  const after = iterator.next()
  handle.dispose()
  assert.deepEqual(await after, { done: true, value: undefined }, 'an unrelated domain frame is never published')
})

test('UA-09 an unavailable Host Workspace registry fails instead of publishing an empty set', () => {
  const h = directHarness({ registry: false })
  assert.throws(() => h.facts.followWorkspaces(), /Workspace registry is unavailable/u)
})

test('UA-10 an already-aborted signal never opens a Direct Workspace generation', () => {
  const h = directHarness({ workspaces: [{ id: 'ws-a', path: '/host/a', title: 'A', sessionIds: [] }] })
  const controller = new AbortController()
  controller.abort()
  assert.throws(() => h.facts.followWorkspaces(controller.signal),
    (error: unknown) => (error as Error).name === 'AbortError')
  assert.equal(h.offCount(), 0, 'no domain subscription is installed for an aborted open')
})

test('UA-09 dispose drops queued Workspace frames with the subscription', async () => {
  const h = directHarness({ workspaces: [{ id: 'ws-a', path: '/host/a', title: 'A', sessionIds: [] }] })
  const handle = h.facts.followWorkspaces()
  const iterator = handle[Symbol.asyncIterator]()
  // A committed change queues a replacement BEFORE the caller iterates.
  h.setWorkspaceRows([{ id: 'ws-b', path: '/host/b', title: 'B', sessionIds: [] }])
  h.emitDomainChange('workspace')
  handle.dispose()
  assert.deepEqual(await iterator.next(), { done: true, value: undefined },
    'a disposed generation publishes neither the baseline nor the queued replacement')
  assert.equal(h.offCount(), 1)
})

test('UA-10 the caller abort ends the Direct Workspace generation and releases the subscription', async () => {
  const h = directHarness({ workspaces: [{ id: 'ws-a', path: '/host/a', title: 'A', sessionIds: [] }] })
  const controller = new AbortController()
  const handle = h.facts.followWorkspaces(controller.signal)
  const iterator = handle[Symbol.asyncIterator]()
  await iterator.next()
  const pending = iterator.next()
  controller.abort()
  assert.deepEqual(await pending, { done: true, value: undefined })
  assert.equal(h.offCount(), 1)
})

// ── L2: the per-open incremental Direct observation ─────────────────────────

test('UA-11 Direct publishes the exact live Agent running state for every main row, synchronously', () => {
  const h = directHarness({
    agents: { running: { status: 'running' }, idle: { status: 'idle' }, broken: { status: 'compacting' } },
  })
  const controller = new AbortController()
  const observation = h.facts.observeActivity(controller.signal)
  observation.setRoster([
    row('running'),
    row('idle'),
    row('broken'),
    row('child', { origin: 'subagent' }),
    row('unknown'),
  ], 1, 'running')
  const snapshot = observation.getSnapshot()
  assert.equal(snapshot.rosterRevision, 1)
  assert.deepEqual(snapshot.facts.map(fact => fact.sessionId), ['running', 'idle', 'broken', 'unknown'],
    'one fact per authorized main row, in roster order; a subagent child never enters')
  assert.deepEqual(snapshot.facts.map(fact => fact.running), [true, false, undefined, undefined],
    'the live Agent status is the ONLY running source; an unknown status is never idle')
  assert.ok(snapshot.facts.every(fact => fact.attention === 'unknown' && fact.attentionSourceState === 'unknown'),
    'Direct owns no cross-Session Gateway pending truth')
  observation.dispose()
  controller.abort()
})

test('UA-11 an official Agent lifecycle event invalidates ONLY the exact changed row', () => {
  const h = directHarness({ agents: { a: { status: 'idle' }, b: { status: 'idle' } } })
  const controller = new AbortController()
  const observation = h.facts.observeActivity(controller.signal)
  observation.setRoster([row('a'), row('b')], 1, undefined)
  const first = observation.getSnapshot()
  assert.deepEqual(first.facts.map(fact => fact.running), [false, false])
  // The live Agent flips to running and the official Host event names it.
  h.agents.a = { status: 'running' }
  h.emitAgent('agent/status', 'a')
  const next = observation.getSnapshot()
  assert.equal(next.revision, first.revision + 1)
  assert.deepEqual(next.facts.map(fact => fact.running), [true, false], 'only the named row changed')
  // An event for an id outside this observation's roster is inert.
  h.agents.ghost = { status: 'running' }
  const before = observation.getSnapshot().revision
  h.emitAgent('agent/status', 'ghost')
  assert.equal(observation.getSnapshot().revision, before, 'a row outside the roster publishes nothing')
  observation.dispose()
  controller.abort()
})

test('UA-11 a disposed Direct observation removes its official listeners exactly once', () => {
  const h = directHarness({ agents: { a: { status: 'idle' } } })
  const controller = new AbortController()
  const observation = h.facts.observeActivity(controller.signal)
  observation.setRoster([row('a')], 1, undefined)
  const offs = h.offCount()
  observation.dispose()
  observation.dispose()
  assert.equal(h.offCount(), offs + 3, 'each official listener is removed exactly once on the first dispose')
  controller.abort()
  h.agents.a = { status: 'running' }
  h.emitAgent('agent/status', 'a')
  assert.equal(observation.getSnapshot().facts[0]?.running, false, 'a disposed observation never repaints')
})

// ── L2: the per-selection Direct Inspector source ───────────────────────────

const INSPECTOR_SESSION = 'session-inspector-direct'

interface InspectorSnapshot {
  readonly asOfSeq: number
  readonly values?: Readonly<Record<string, unknown>>
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

interface InspectorHarness {
  readonly facts: DirectSessionWorkspaceFacts
  readonly calls: { readonly snapshot: number; readonly stat: number; readonly observe: number }
  readonly observeStarted: () => Promise<void>
  readonly disposedObservations: () => number
  attach(): void
  emitProjection(sessionId: string, key: string): void
  emitSession(event: 'session/created' | 'session/disposed', sessionId: string): void
  offCount(): number
  source(onInvalidated: (reason: 'changed' | 'source-replaced') => void): ReturnType<DirectSessionWorkspaceFacts['openInspector']>
}

function inspectorHarness(options: {
  readonly attached?: boolean
  readonly snapshot?: InspectorSnapshot | Error
  readonly stat?: { readonly formatStatus?: 'current' | 'migration-required' } | undefined | Error
  readonly observation?: {
    readonly header: { readonly id: string }
    readonly projections?: InspectorSnapshot
  } | Error
  readonly observationGate?: Promise<void>
  readonly withProjections?: boolean
  readonly withPersistence?: boolean
  readonly withQuery?: boolean
} = {}): InspectorHarness {
  let attached = options.attached === true
  // The official Session store returns the SAME attached Session object for
  // every lookup; the source's identity fence depends on that contract.
  const attachedSession = { id: INSPECTOR_SESSION }
  let offCount = 0
  let disposedObservations = 0
  const calls = { snapshot: 0, stat: 0, observe: 0 }
  const sessionListeners = new Map<string, Array<(session: { readonly id: string }) => void>>()
  const projectionListeners: Array<(sessionId: string, key: string) => void> = []
  let observeStartedResolve!: () => void
  const observeStarted = new Promise<void>((resolve) => { observeStartedResolve = resolve })
  const reads: DirectInspectorReads = {
    liveSession: () => attached ? attachedSession : undefined,
    ...(options.withProjections === false ? {} : {
      snapshot: (): InspectorSnapshot => {
        calls.snapshot += 1
        if (options.snapshot instanceof Error) throw options.snapshot
        return options.snapshot ?? { asOfSeq: -1, values: {} }
      },
      onProjectionChanged: (listener): (() => void) => {
        projectionListeners.push(listener)
        return () => { offCount += 1 }
      },
    }),
    ...(options.withPersistence === false ? {} : {
      stat: async (): Promise<{ readonly formatStatus?: 'current' | 'migration-required' } | undefined> => {
        calls.stat += 1
        if (options.stat instanceof Error) throw options.stat
        return options.stat
      },
    }),
    ...(options.withQuery === false ? {} : {
      observe: async (): Promise<{
        readonly header: { readonly id: string }
        readonly projections?: InspectorSnapshot
        [Symbol.dispose](): void
      }> => {
        calls.observe += 1
        observeStartedResolve()
        if (options.observationGate !== undefined) await options.observationGate
        if (options.observation instanceof Error) throw options.observation
        if (options.observation === undefined) throw new Error('no observation configured')
        return {
          header: options.observation.header,
          ...(options.observation.projections === undefined ? {} : { projections: options.observation.projections }),
          [Symbol.dispose]: () => { disposedObservations += 1 },
        }
      },
    }),
  }
  const ctx = {
    get: (): undefined => undefined,
    on: (name: string, listener: (payload: never) => unknown): (() => void) => {
      if (name === 'session/created' || name === 'session/disposed') {
        const registered = sessionListeners.get(name) ?? []
        registered.push(listener as unknown as (session: { readonly id: string }) => void)
        sessionListeners.set(name, registered)
        return () => { offCount += 1 }
      }
      throw new Error(`the Inspector fixture received an unexpected Host event "${name}"`)
    },
  } as unknown as DirectFactsContextLike
  const facts = new DirectSessionWorkspaceFacts(ctx, () => undefined, reads)
  return {
    facts,
    calls,
    observeStarted: () => observeStarted,
    disposedObservations: () => disposedObservations,
    attach: () => { attached = true },
    emitProjection: (sessionId, key) => {
      for (const listener of [...projectionListeners]) listener(sessionId, key)
    },
    emitSession: (event, sessionId) => {
      for (const listener of [...sessionListeners.get(event) ?? []]) listener({ id: sessionId })
    },
    offCount: () => offCount,
    source: (onInvalidated) => facts.openInspector(INSPECTOR_SESSION, reason => onInvalidated(reason)),
  }
}

const legalStats = {
  turns: 2,
  steps: 3,
  llmMs: 30,
  toolMs: 7,
  ttftMs: 6,
  ttftSteps: 2,
  decodeMs: 15,
  decodeTokens: 120,
}

test('INSP-D1 an attached Session reads ONE exact official projection cut and calls no persistence/query read', async () => {
  const h = inspectorHarness({
    attached: true,
    snapshot: {
      asOfSeq: 7,
      values: {
        sessionStats: legalStats,
        workingDirectory: '/host/project',
      },
    },
  })
  const result = await h.source(() => { throw new Error('an exact attached cut never invalidates itself') })
    .read(new AbortController().signal)
  assert.equal(result.kind, 'ready')
  if (result.kind === 'ready') {
    assert.equal(result.data.sessionId, INSPECTOR_SESSION)
    assert.equal(result.data.asOfSeq, 7)
    assert.equal(result.data.stats?.turns, 2)
    assert.equal(result.data.effectiveCwd, '/host/project')
  }
  assert.equal(h.calls.snapshot, 1, 'one exact attached snapshot cut')
  assert.equal(h.calls.stat, 0, 'an attached Session never stats/opens persistence')
  assert.equal(h.calls.observe, 0, 'an attached Session never opens a cold observation')
  assert.equal(h.disposedObservations(), 0)
})

test('INSP-D2 a cold Session stats first, observes exactly once and disposes the lease exactly once', async () => {
  const h = inspectorHarness({
    stat: { formatStatus: 'current' },
    observation: {
      header: { id: INSPECTOR_SESSION },
      projections: {
        asOfSeq: 9,
        values: {
          tokenUsage: {
            uncachedInputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
          },
        },
      },
    },
  })
  const result = await h.source(() => {}).read(new AbortController().signal)
  assert.equal(result.kind, 'ready')
  if (result.kind === 'ready') {
    assert.equal(result.data.asOfSeq, 9)
    assert.equal(result.data.usage?.totalTokens, 10)
  }
  assert.equal(h.calls.stat, 1)
  assert.equal(h.calls.observe, 1)
  assert.equal(h.disposedObservations(), 1, 'the caller-owned observation lease is released exactly once')
})

test('INSP-D3 migration-required and not-found refuse WITHOUT opening a cold observation', async () => {
  const migration = inspectorHarness({
    stat: { formatStatus: 'migration-required' },
    observation: { header: { id: INSPECTOR_SESSION } },
  })
  assert.deepEqual(
    await migration.source(() => {}).read(new AbortController().signal),
    { kind: 'migration-required', message: 'Session migration is required' },
  )
  assert.equal(migration.calls.observe, 0, 'a required migration is refused before observeSession')
  assert.equal(migration.calls.stat, 1)

  const absent = inspectorHarness({ stat: undefined })
  assert.equal((await absent.source(() => {}).read(new AbortController().signal)).kind, 'unavailable')
  assert.equal(absent.calls.observe, 0, 'a not-found cold Session opens no observation')
})

test('INSP-D4 a missing capability is a truthful unavailable, never a fallback read', async () => {
  const noProjections = inspectorHarness({ attached: true, withProjections: false })
  assert.equal((await noProjections.source(() => {}).read(new AbortController().signal)).kind, 'unavailable')
  assert.equal(noProjections.calls.snapshot, 0)

  const noPersistence = inspectorHarness({ withPersistence: false })
  assert.equal((await noPersistence.source(() => {}).read(new AbortController().signal)).kind, 'unavailable')
  assert.equal(noPersistence.calls.stat, 0)

  const noQuery = inspectorHarness({ stat: { formatStatus: 'current' }, withQuery: false })
  assert.equal((await noQuery.source(() => {}).read(new AbortController().signal)).kind, 'unavailable')
  assert.equal(noQuery.calls.observe, 0)
})

test('INSP-D5 a cold result whose Session attached meanwhile is superseded and its lease disposed', async () => {
  const gate = deferred()
  const h = inspectorHarness({
    stat: { formatStatus: 'current' },
    observation: { header: { id: INSPECTOR_SESSION } },
    observationGate: gate.promise,
  })
  const pending = h.source(() => {}).read(new AbortController().signal)
  await h.observeStarted()
  h.attach()
  gate.resolve()
  await assert.rejects(pending, (error: unknown) => error instanceof SupersededReadError)
  assert.equal(h.disposedObservations(), 1, 'the superseded cold lease is still released')
})

test('INSP-D6 a caller abort during the cold observation disposes the lease and rejects as cancellation', async () => {
  const gate = deferred()
  const h = inspectorHarness({
    stat: { formatStatus: 'current' },
    observation: { header: { id: INSPECTOR_SESSION } },
    observationGate: gate.promise,
  })
  const controller = new AbortController()
  const pending = h.source(() => {}).read(controller.signal)
  await h.observeStarted()
  controller.abort()
  gate.resolve()
  await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError')
  assert.equal(h.disposedObservations(), 1, 'the aborted cold lease is released exactly once')
})

test('INSP-D7 a broken persistence/observation read propagates and never fabricates data', async () => {
  const statFailure = inspectorHarness({ stat: new Error('stat exploded') })
  await assert.rejects(statFailure.source(() => {}).read(new AbortController().signal), /stat exploded/u)
  assert.equal(statFailure.calls.observe, 0, 'a failed stat never reaches observeSession')

  const observationFailure = inspectorHarness({
    stat: { formatStatus: 'current' },
    observation: new Error('observation exploded'),
  })
  await assert.rejects(observationFailure.source(() => {}).read(new AbortController().signal), /observation exploded/u)
  assert.equal(observationFailure.disposedObservations(), 0, 'a failed observation has no lease to release')
})

test('INSP-D8 only the selected Session relevant keys invalidate; identity/lifecycle dispose releases every watch', () => {
  const reasons: Array<'changed' | 'source-replaced'> = []
  const h = inspectorHarness({ attached: true, withPersistence: false, withQuery: false })
  const source = h.source(reason => { reasons.push(reason) })
  h.emitProjection(INSPECTOR_SESSION, 'sessionStats')
  assert.deepEqual(reasons, ['changed'], 'a relevant key of the selected Session is a real change')
  h.emitProjection(INSPECTOR_SESSION, 'title')
  assert.deepEqual(reasons, ['changed', 'changed'])
  h.emitProjection(INSPECTOR_SESSION, 'userQuestions')
  assert.equal(reasons.length, 2, 'a non-Inspector key never invalidates')
  h.emitProjection('session-someone-else', 'sessionStats')
  assert.equal(reasons.length, 2, 'another Session never invalidates')
  h.emitSession('session/created', 'session-someone-else')
  assert.equal(reasons.length, 2, 'another Session lifecycle never invalidates')
  h.emitSession('session/created', INSPECTOR_SESSION)
  assert.deepEqual(reasons, ['changed', 'changed', 'source-replaced'],
    'the selected attached identity changing is a source replacement')
  source.dispose()
  assert.equal(h.offCount(), 3, 'two session lifecycle watches + one projection feed are released')
  h.emitProjection(INSPECTOR_SESSION, 'sessionStats')
  h.emitSession('session/disposed', INSPECTOR_SESSION)
  assert.equal(reasons.length, 3, 'a disposed source never publishes a later callback')
})

test('INSP-D9 a malformed attached cut is unavailable, never a partial ready DTO', async () => {
  const badCut = inspectorHarness({
    attached: true,
    snapshot: { asOfSeq: 1.5, values: { sessionStats: legalStats } },
  })
  assert.equal((await badCut.source(() => {}).read(new AbortController().signal)).kind, 'unavailable',
    'a non-integer cut is not an exact Inspector answer')

  const badValues = inspectorHarness({
    attached: true,
    snapshot: { asOfSeq: 1, values: [] as unknown as Readonly<Record<string, unknown>> },
  })
  assert.equal((await badValues.source(() => {}).read(new AbortController().signal)).kind, 'unavailable',
    'a non-record projection value set is not an exact Inspector answer')
})
