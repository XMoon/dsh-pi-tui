import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteTaskReader,
  type RemoteSubagentCatalog,
  type RemoteTaskSessionsSource,
} from '../src/runtime/remote/task-read-remote.ts'
import { DirectTaskReader, type DirectTaskAgent } from '../src/runtime/direct/task-read-direct.ts'
import type { RemoteConnectionGeneration, RemoteConnectionGenerationSource } from '../src/runtime/remote/session-reader-remote.ts'
import type { TaskJobEntry, TaskSubagentEntry } from '../src/runtime/task-read-port.ts'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'

function constructOfficialReader(sessions: ISessions, generation: ConnectionGenerationState): RemoteTaskReader {
  return new RemoteTaskReader(sessions, generation)
}

interface GenerationHarness {
  readonly source: RemoteConnectionGenerationSource
  set(value: RemoteConnectionGeneration | undefined): void
}

function generationHarness(): GenerationHarness {
  let current: RemoteConnectionGeneration | undefined = { id: 1 }
  return {
    source: { getSnapshot: () => current, subscribe: () => () => {} },
    set(value) { current = value },
  }
}

function child(
  id: string,
  activity: 'running' | 'inactive' = 'inactive',
  mode: 'one-shot' | 'continuable' = 'continuable',
): TaskSubagentEntry {
  return { kind: 'child', id, label: `child ${id}`, mode, activity, hasChildren: false }
}

function job(id: string, status = 'running'): TaskJobEntry {
  return { id, kind: 'bash', label: `job ${id}`, status, startedAt: 10, detail: 'fixture' }
}

function catalog(entries: readonly TaskSubagentEntry[], parentAvailable = true): RemoteSubagentCatalog {
  return { entries, parentAvailable, state: 'ready', error: undefined }
}

function source(options: {
  catalog?: RemoteSubagentCatalog | undefined
  jobs?: readonly TaskJobEntry[]
  refresh?: () => Promise<void>
}): RemoteTaskSessionsSource & { refreshCalls: number } {
  let refreshCalls = 0
  const subagentsByParent: Record<string, RemoteSubagentCatalog> = {}
  if (options.catalog !== undefined) subagentsByParent.parent = options.catalog
  return {
    list: {
      getSnapshot: () => ({
        subagentsByParent,
        jobsBySession: { parent: options.jobs ?? [] },
      }),
    },
    async refreshSubagents() {
      refreshCalls += 1
      await options.refresh?.()
    },
    get refreshCalls() { return refreshCalls },
  }
}

test('official Client Sessions and Connection faces satisfy the Task adapter boundary', () => {
  assert.equal(typeof constructOfficialReader, 'function')
})

test('reads the settled Client catalog and jobs without sorting or leaking extra fields', async () => {
  const generations = generationHarness()
  const entries = [
    child('b', 'running'),
    child('one-shot', 'inactive', 'one-shot'),
    { kind: 'diagnostic', id: 'bad', reason: 'unavailable' } as const,
  ]
  const jobs = [
    job('j2', 'completed'),
    job('j3', 'stopping'),
    job('j4', 'killed'),
    job('j5', 'failed'),
    job('j1'),
  ]
  const client = source({ catalog: catalog(entries), jobs })
  const reader = new RemoteTaskReader(client, generations.source)

  const snapshot = await reader.readDirectChildren('parent')
  assert.deepEqual(snapshot, {
    parentSessionId: 'parent',
    parentAvailable: true,
    children: entries,
    jobs,
  })
  assert.equal(client.refreshCalls, 1)
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot?.children), true)
  assert.equal(Object.isFrozen(snapshot?.children[0]), true)
})

test('waits for a Client-owned trailing catalog refresh before reading jobs', async () => {
  const generations = generationHarness()
  let refreshCalls = 0
  const trailing = catalog([child('after-trailing')])
  const client: RemoteTaskSessionsSource = {
    list: {
      getSnapshot: () => ({
        subagentsByParent: {
          parent: refreshCalls < 2
            ? { entries: [], parentAvailable: true, state: 'loading', error: undefined }
            : trailing,
        },
        jobsBySession: { parent: [job('trailing-job')] },
      }),
    },
    async refreshSubagents() {
      refreshCalls += 1
    },
  }
  const snapshot = await new RemoteTaskReader(client, generations.source).readDirectChildren('parent')
  assert.equal(refreshCalls, 2)
  assert.deepEqual(snapshot?.children, [child('after-trailing')])
  assert.deepEqual(snapshot?.jobs, [job('trailing-job')])
})

test('Direct re-projects child activity from the live Agent registry and reads parent jobs', async () => {
  const parent: DirectTaskAgent = { status: 'running' }
  let childStatus = 'idle'
  const direct = new DirectTaskReader({
    agentFor: id => id === 'parent' ? parent : id === 'child' ? { status: childStatus } : undefined,
    subagents: {
      async listChildren() {
        return [{ kind: 'child', id: 'child', label: 'Child', mode: 'continuable', activity: 'running', hasChildren: false }]
      },
    },
    jobs: {
      list(owner) {
        assert.equal(owner, parent)
        return [job('job')]
      },
    },
  })

  const inactive = await direct.readDirectChildren('parent')
  assert.equal(inactive?.children[0]?.kind, 'child')
  assert.equal(inactive?.children[0]?.kind === 'child' && inactive.children[0].activity, 'inactive')
  childStatus = 'running'
  const active = await direct.readDirectChildren('parent')
  assert.equal(active?.children[0]?.kind === 'child' && active.children[0].activity, 'running')
  assert.deepEqual(active?.jobs, [job('job')])
})

test('Direct re-resolves the parent Agent before reading jobs after an awaited listing', async () => {
  const oldParent: DirectTaskAgent = { status: 'running' }
  const newParent: DirectTaskAgent = { status: 'running' }
  let currentParent = oldParent
  let release!: () => void
  const listing = new Promise<void>(resolve => { release = resolve })
  const direct = new DirectTaskReader({
    agentFor: id => id === 'parent' ? currentParent : undefined,
    subagents: {
      async listChildren() {
        await listing
        currentParent = newParent
        return []
      },
    },
    jobs: {
      list(owner) {
        assert.equal(owner, newParent)
        return [job('new-owner-job')]
      },
    },
  })

  const pending = direct.readDirectChildren('parent')
  release()
  assert.deepEqual((await pending)?.jobs, [job('new-owner-job')])
})

test('returns an authoritative empty catalog but treats a catalog error as an error', async () => {
  const generations = generationHarness()
  const empty = new RemoteTaskReader(source({ catalog: catalog([]), jobs: [] }), generations.source)
  assert.deepEqual(await empty.readDirectChildren('parent'), {
    parentSessionId: 'parent',
    parentAvailable: true,
    children: [],
    jobs: [],
  })

  const failure = new Error('catalog unavailable')
  const failed = new RemoteTaskReader(source({ catalog: { entries: [], parentAvailable: false, state: 'error', error: failure } }), generations.source)
  await assert.rejects(failed.readDirectChildren('parent'), error => error === failure)
})

test('distinguishes missing Client catalog/binding generation from an empty catalog', async () => {
  const generations = generationHarness()
  const reader = new RemoteTaskReader(source({}), generations.source)
  assert.equal(await reader.readDirectChildren('parent'), undefined)

  generations.set(undefined)
  assert.equal(await reader.readDirectChildren('parent'), undefined)
})

test('discards a refresh result when Connection generation changes', async () => {
  const generations = generationHarness()
  let release!: () => void
  const refresh = new Promise<void>(resolve => { release = resolve })
  const client = source({ catalog: catalog([child('a')]), refresh: () => refresh })
  const reader = new RemoteTaskReader(client, generations.source)
  const pending = reader.readDirectChildren('parent')
  generations.set({ id: 2 })
  release()
  assert.equal(await pending, undefined)
})

test('honors caller cancellation before and after the official refresh', async () => {
  const generations = generationHarness()
  const before = new AbortController()
  before.abort()
  const reader = new RemoteTaskReader(source({ catalog: catalog([]) }), generations.source)
  await assert.rejects(reader.readDirectChildren('parent', before.signal), { name: 'AbortError' })

  let release!: () => void
  const refresh = new Promise<void>(resolve => { release = resolve })
  const client = source({ catalog: catalog([]), refresh: () => refresh })
  const after = new AbortController()
  const pending = new RemoteTaskReader(client, generations.source).readDirectChildren('parent', after.signal)
  after.abort()
  release()
  await assert.rejects(pending, { name: 'AbortError' })
})
