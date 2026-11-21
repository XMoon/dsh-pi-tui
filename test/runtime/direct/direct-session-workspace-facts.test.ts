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
} from '../../../src/runtime/direct/session-workspace-facts-direct.ts'
import type { WorkspaceFactEntityLike } from '../../../src/runtime/direct/session-lifecycle-direct.ts'
import type { SessionSummary } from '../../../src/runtime/session-reader-port.ts'

const row = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, updatedAt: 1, live: false, ...overrides })

interface DirectHarness {
  readonly ctx: DirectFactsContextLike
  readonly facts: DirectSessionWorkspaceFacts
  setWorkspaceRows(rows: readonly WorkspaceFactEntityLike[]): void
  emitDomainChange(domain: string): void
  readonly offCount: () => number
}

function directHarness(options: {
  registry?: boolean
  agents?: Readonly<Record<string, DirectFactsAgentLike>>
  workspaces?: readonly WorkspaceFactEntityLike[]
}): DirectHarness {
  let rows = options.workspaces ?? []
  let offCount = 0
  const listeners: Array<(change: { readonly domain: string }) => void> = []
  const registry = {
    list: () => rows,
  }
  const ctx = {
    get: (name: string) => (name === 'workspaceRegistry' && options.registry !== false ? registry : undefined),
    on: (name: string, listener: (change: { readonly domain: string }) => void) => {
      if (name === 'domain/changed') listeners.push(listener)
      return () => { offCount += 1; return true }
    },
  } as unknown as DirectFactsContextLike
  return {
    ctx,
    facts: new DirectSessionWorkspaceFacts(ctx, id => options.agents?.[id]),
    setWorkspaceRows: next => { rows = next },
    emitDomainChange: domain => { for (const listener of listeners) listener({ domain }) },
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
