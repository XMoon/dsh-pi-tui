/**
 * Direct ↔ Remote read-authority parity (L4): both backends serve the SAME
 * `SessionWorkspaceFactsPort` shape. For equivalent official facts they must
 * agree on everything the port owns — roster order/identity, subagent
 * exclusion, the running mapping, the detached Workspace row and the Unknown
 * fail-closed answer. The one deliberate asymmetry is documented: Direct owns
 * no Gateway forwarded-event truth, so it cannot report a provable `none` or a
 * pending kind; a readable Remote projection can. That is a source-capability
 * difference, never a different semantic for the same fact.
 *
 * @module @xmoon76/dsh-pi-tui/session-workspace-facts-parity.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DirectSessionWorkspaceFacts,
  type DirectFactsAgentLike,
  type DirectFactsContextLike,
} from '../../../src/runtime/direct/session-workspace-facts-direct.ts'
import type { WorkspaceFactEntityLike } from '../../../src/runtime/direct/session-lifecycle-direct.ts'
import {
  RemoteSessionWorkspaceFacts,
  type RemoteSessionFactsRemotes,
  type RemoteSessionWorkspaceFactsSource,
} from '../../../src/runtime/remote/session-workspace-facts-remote.ts'
import type { RemoteWorkspaceNamespaceLike } from '../../../src/runtime/remote/session-lifecycle-remote.ts'
import type { RemoteSessionsReadSource } from '../../../src/runtime/remote/session-reader-remote.ts'
import type { SessionSummary } from '../../../src/runtime/session-reader-port.ts'

const row = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, updatedAt: 1, live: false, ...overrides })

const workspaceRows: readonly WorkspaceFactEntityLike[] = [
  { id: 'ws-a', path: '/host/a', title: 'Alpha', sessionIds: ['s1', 's2'] },
  { id: 'ws-b', path: '/host/b', title: 'Beta', sessionIds: [] },
]

function directFacts(options: {
  agents?: Readonly<Record<string, DirectFactsAgentLike>>
  workspaces?: readonly WorkspaceFactEntityLike[]
}): DirectSessionWorkspaceFacts {
  const ctx = {
    get: (name: string) => (name === 'workspaceRegistry' ? { list: () => options.workspaces ?? [] } : undefined),
    on: () => () => true,
  } as unknown as DirectFactsContextLike
  return new DirectSessionWorkspaceFacts(ctx, id => options.agents?.[id])
}

function remoteFacts(options: {
  listed: readonly SessionSummary[]
  listedRunning?: Readonly<Record<string, boolean>>
  states?: Readonly<Record<string, { readonly running: boolean; readonly pendingInput: readonly string[] }>>
  stateFailures?: readonly string[]
  workspace?: RemoteWorkspaceNamespaceLike
}): RemoteSessionWorkspaceFacts {
  // A STABLE generation identity: the fence compares identity, so a fresh
  // object per read would (correctly) never commit.
  const generationIdentity = { id: 'gen-1' }
  const generation = { getSnapshot: () => generationIdentity, subscribe: () => () => {} }
  const sessions = {
    list: {
      getSnapshot: () => ({
        ids: options.listed.map(item => item.id),
        byId: Object.fromEntries(options.listed.map(item => [item.id, {
          id: item.id,
          running: options.listedRunning?.[item.id] ?? false,
          updatedAt: item.updatedAt,
        }])),
        phase: 'ready',
      }),
      subscribe: () => () => {},
    },
    refresh: async () => {},
    search: async () => ({ ok: true, value: { items: [], hasMore: false } }),
    binding: () => undefined,
  } as unknown as RemoteSessionsReadSource
  const session: RemoteSessionFactsRemotes['session'] = {
    state: async request => {
      if (options.stateFailures?.includes(request.sessionId) === true) {
        return { ok: false, error: { code: 'gateway/internal' } }
      }
      return { ok: true, value: options.states?.[request.sessionId] ?? { running: false, pendingInput: [] } }
    },
    projections: async () => ({ ok: true, value: null }),
  }
  const source: RemoteSessionWorkspaceFactsSource = {
    sessions,
    remote: {
      session,
      workspace: options.workspace ?? { create: async () => ({ ok: false, error: {} }), follow: () => { throw new Error('no stream') } },
    },
    connection: { generation },
  }
  return new RemoteSessionWorkspaceFacts(source)
}

test('L4 both adapters project the SAME detached Workspace facts from the official rows', async () => {
  const direct = directFacts({ workspaces: workspaceRows })
  const directHandle = direct.followWorkspaces()
  const directIterator = directHandle[Symbol.asyncIterator]()
  const directFirst = await directIterator.next()
  directHandle.dispose()
  const frames: Array<Record<string, unknown>> = directFirst.done === true ? [] : [{ ...directFirst.value }]
  assert.deepEqual(frames, [{
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/host/a', title: 'Alpha', sessionIds: ['s1', 's2'] },
      { workspaceId: 'ws-b', path: '/host/b', title: 'Beta', sessionIds: [] },
    ],
  }])

  const remote = remoteFacts({
    listed: [],
    workspace: {
      create: async () => ({ ok: false, error: {} }),
      follow: () => {
        let disposed = false
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'baseline', value: { items: workspaceRows.map(view => ({
              workspaceId: view.id, path: view.path, title: view.title, sessionIds: view.sessionIds,
            })) } }
          },
          dispose: () => { if (disposed) return; disposed = true },
        }
      },
    },
  })
  const remoteHandle = remote.followWorkspaces()
  const remoteIterator = remoteHandle[Symbol.asyncIterator]()
  const remoteFirst = await remoteIterator.next()
  remoteHandle.dispose()
  const remoteFrames: Array<Record<string, unknown>> = remoteFirst.done === true ? [] : [{ ...remoteFirst.value }]
  assert.deepEqual(remoteFrames, frames, 'the same official Workspace row yields the same detached fact')
})

test('L4 both adapters keep caller order, exclude subagents and map running from the official fact', async () => {
  const roster = [row('x', { live: false }), row('child', { origin: 'subagent' }), row('y', { live: true })]
  const direct = await directFacts({
    agents: { x: { status: 'running' }, y: { status: 'idle' } },
  }).readActivity(roster)
  const remote = await remoteFacts({
    listed: [row('x'), row('y')],
    listedRunning: { x: true, y: false },
    states: { x: { running: true, pendingInput: [] }, y: { running: false, pendingInput: [] } },
  }).readActivity(roster)
  assert.deepEqual(direct.map(fact => fact.sessionId), ['x', 'y'])
  assert.deepEqual(remote.map(fact => fact.sessionId), ['x', 'y'])
  assert.deepEqual(direct.map(fact => fact.running), [true, false])
  assert.deepEqual(remote.map(fact => fact.running), [true, false])
  // Direct owns no Gateway forwarded-event truth, so its attention is the
  // fail-closed unknown; an unreadable Remote projection answers the same.
  assert.deepEqual(direct.map(fact => fact.attention), ['unknown', 'unknown'])
  assert.deepEqual(remote.map(fact => fact.attention), ['unknown', 'unknown'])
  assert.deepEqual(direct.map(fact => fact.attentionSourceState), ['unknown', 'unknown'])
  assert.deepEqual(remote.map(fact => fact.attentionSourceState), ['unknown', 'unknown'])
})

test('L4 running is never the old live bit: a proven list row still answers, an unprovable fact is undefined', async () => {
  const direct = await directFacts({}).readActivity([row('x', { live: true })])
  assert.equal(direct[0].running, undefined, 'Direct has no live Agent for x, and the live bit is not running')
  const remote = await remoteFacts({ listed: [row('x')], stateFailures: ['x'] }).readActivity([row('x')])
  assert.equal(remote[0].running, false,
    'a ready official list row still proves the running fact even when the passive state fails')
  const remoteNoRow = await remoteFacts({ listed: [], stateFailures: ['x'] })
    .readActivity([row('x', { live: true })])
  assert.equal(remoteNoRow[0].running, undefined,
    'with no list row and a failed passive state there is no proven running fact')
})
