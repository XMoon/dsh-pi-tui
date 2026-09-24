import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteTaskReader,
  type RemoteJobView,
  type RemoteSubagentCatalogEntry,
  type RemoteTaskJobsSource,
  type RemoteTaskSessionsSource,
} from '../src/runtime/remote/task-read-remote.ts'
import { DirectTaskReader, type DirectTaskAgent, type DirectTaskChildEntry } from '../src/runtime/direct/task-read-direct.ts'
import type { RemoteConnectionGeneration, RemoteConnectionGenerationSource } from '../src/runtime/remote/session-reader-remote.ts'
import type { TaskJobEntry, TaskSubagentEntry } from '../src/runtime/task-read-port.ts'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IJobs } from '@deepseek-ai/dsh-api-job-controller/client'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'

function constructOfficialReader(sessions: ISessions, jobs: IJobs, generation: ConnectionGenerationState): RemoteTaskReader {
  return new RemoteTaskReader(sessions, jobs, generation)
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

function catalogEntry(
  id: string,
  mode: RemoteSubagentCatalogEntry['mode'] = 'continuable',
  label = `child ${id}`,
): RemoteSubagentCatalogEntry {
  return { id, createdAt: 10, mode, ...(label === undefined ? {} : { label }) }
}

function job(id: string, status = 'running'): TaskJobEntry {
  return { id, kind: 'bash', label: `job ${id}`, status, startedAt: 10, detail: 'fixture' }
}

function jobView(id: string, status = 'running'): RemoteJobView {
  return { id, kind: 'bash', label: `job ${id}`, status, startedAt: 10, detail: 'fixture' }
}

/** One official projection snapshot slice, `values`-shaped. */
interface ProjectionFixture {
  /** undefined = never loaded (idle-without-values); an array = loaded. */
  entries?: readonly RemoteSubagentCatalogEntry[] | undefined
  state?: 'idle' | 'loading' | 'ready' | 'error'
  error?: unknown
}

/** Official ClientSessions-shaped source with observable refresh calls. */
function sessionsFixture(options: {
  byId?: Record<string, { running: boolean }>
  projections?: Record<string, ProjectionFixture>
  refresh?: (sessionId: string) => Promise<void>
}): RemoteTaskSessionsSource & { refreshCalls: number; setProjection(id: string, fixture: ProjectionFixture | undefined): void } {
  const projections: Record<string, ProjectionFixture | undefined> = { ...options.projections }
  let refreshCalls = 0
  return {
    list: {
      getSnapshot: () => ({
        byId: options.byId ?? {},
        projectionsBySession: Object.fromEntries(Object.entries(projections).map(([id, fixture]) => [id, fixture === undefined ? undefined : {
          values: { subagentCatalog: fixture.entries },
          state: fixture.state ?? (fixture.entries === undefined ? 'idle' : 'ready'),
          error: fixture.error ?? null,
        }])),
      }),
    },
    async refreshProjections(sessionId: string) {
      refreshCalls += 1
      await options.refresh?.(sessionId)
    },
    get refreshCalls() { return refreshCalls },
    setProjection(id, fixture) { projections[id] = fixture },
  }
}

/** Official ClientJobs-shaped source recording the retained-watch lifecycle. */
function jobsFixture(options: {
  rows?: Record<string, readonly RemoteJobView[]>
}): RemoteTaskJobsSource & {
  watchCalls: string[]
  releases: string[]
  droppedByRelease: string[]
  setRows(sessionId: string, rows: readonly RemoteJobView[] | undefined): void
} {
  const rows: Record<string, readonly RemoteJobView[]> = { ...options.rows }
  const watchCalls: string[] = []
  const releases: string[] = []
  // Entry-bound releases, mirroring the official ClientJobs contract: a
  // release only drops ITS OWN acquisition, never a successor's rows.
  const droppedByRelease: string[] = []
  return {
    state: { getSnapshot: () => ({ rows: Object.fromEntries(Object.entries(rows).filter(([, value]) => value.length > 0)) }) },
    watchRows(sessionId: string) {
      watchCalls.push(sessionId)
      let released = false
      return () => {
        if (released) return
        released = true
        releases.push(sessionId)
        // The official refcount drops with the LAST release; the fixture
        // records every bounded release for the invariant assertions.
        droppedByRelease.push(sessionId)
        delete rows[sessionId]
      }
    },
    get watchCalls() { return watchCalls },
    get releases() { return releases },
    get droppedByRelease() { return droppedByRelease },
    setRows(sessionId, value) {
      if (value === undefined || value.length === 0) delete rows[sessionId]
      else rows[sessionId] = value
    },
  }
}

test('official Client Sessions and Jobs faces satisfy the Task adapter boundary', () => {
  assert.equal(typeof constructOfficialReader, 'function')
})

test('reads a settled projection and roster without sorting or leaking extra fields', async () => {
  const generations = generationHarness()
  const client = sessionsFixture({
    byId: {
      parent: { running: true },
      'child-b': { running: true },
      'child-one-shot': { running: false },
    },
    projections: {
      parent: { entries: [catalogEntry('child-b'), catalogEntry('child-one-shot', 'one-shot')], state: 'ready' },
    },
  })
  const jobs = jobsFixture({ rows: { parent: [jobView('j1', 'completed'), jobView('j2')] } })
  const reader = new RemoteTaskReader(client, jobs, generations.source)

  const snapshot = await reader.readDirectChildren('parent')
  assert.deepEqual(snapshot, {
    parentSessionId: 'parent',
    parentAvailable: true,
    children: [
      { kind: 'child', id: 'child-b', label: 'child child-b', mode: 'continuable', activity: 'running', hasChildren: false },
      { kind: 'child', id: 'child-one-shot', label: 'child child-one-shot', mode: 'one-shot', activity: 'inactive', hasChildren: false },
    ],
    jobs: [job('j1', 'completed'), job('j2')],
  })
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot?.children), true)
  assert.equal(Object.isFrozen(snapshot?.jobs), true)
  // The settled read never needed an explicit refresh.
  assert.equal(client.refreshCalls, 0)
})

test('waits for a Client-owned trailing projection refresh before settling', async () => {
  const generations = generationHarness()
  let refreshCalls = 0
  const jobs = jobsFixture({ rows: { parent: [jobView('trailing-job')] } })
  const reader = new RemoteTaskReader({
    list: {
      getSnapshot: () => ({
        byId: { parent: { running: false } },
        // The Client's trailing refresh is still armed after the first
        // refresh resolves: the projection reads loading until the second
        // official single-flight round settles it.
        projectionsBySession: refreshCalls < 2 ? {} : {
          parent: { values: { subagentCatalog: [catalogEntry('after-trailing')] }, state: 'ready' as const, error: null },
        },
      }),
    },
    async refreshProjections() {
      refreshCalls += 1
    },
  }, jobs, generations.source)
  const snapshot = await reader.readDirectChildren('parent')
  assert.equal(refreshCalls, 2)
  assert.deepEqual(snapshot?.children.map(entry => entry.id), ['after-trailing'])
  assert.deepEqual(snapshot?.jobs, [job('trailing-job')])
})

test('a ready projection with an empty catalog is an authoritative empty membership', async () => {
  const generations = generationHarness()
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [], state: 'ready' } },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const snapshot = await reader.readDirectChildren('parent')
  assert.deepEqual(snapshot?.children, [])
  assert.equal(snapshot?.parentAvailable, true)
})

test('a projection error surfaces as an error, never an empty catalog', async () => {
  const generations = generationHarness()
  const failure = new Error('projection unavailable')
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [], state: 'error', error: failure } },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  await assert.rejects(reader.readDirectChildren('parent'), error => error === failure)
})

test('an unknown official catalog mode maps to the read-only presentation', async () => {
  const generations = generationHarness()
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [catalogEntry('child-unknown', 'unknown')], state: 'ready' } },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const snapshot = await reader.readDirectChildren('parent')
  assert.equal(snapshot?.children[0]?.kind === 'child' && snapshot.children[0].mode, 'one-shot')
})

test('membership and parent availability are separate authorities', async () => {
  const generations = generationHarness()
  // A parent ABSENT from the official list (no byId row) is unavailable
  // even though its projection is ready with children.
  const client = sessionsFixture({
    projections: { parent: { entries: [catalogEntry('child-a')], state: 'ready' } },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const snapshot = await reader.readDirectChildren('parent')
  assert.equal(snapshot?.parentAvailable, false)
  assert.deepEqual(snapshot?.children.map(entry => entry.id), ['child-a'])
})

test('child rows never claim known children — the read faces carry no descendant fact', async () => {
  const generations = generationHarness()
  // Even a child whose own projection is loaded and non-empty keeps
  // hasChildren false: the client-side derivation would be load-dependent
  // and diverge from the Direct face (which cannot know it at all).
  const client = sessionsFixture({
    byId: { parent: { running: false }, 'child-a': { running: false } },
    projections: {
      parent: { entries: [catalogEntry('child-a')], state: 'ready' },
      'child-a': { entries: [catalogEntry('grandchild')], state: 'ready' },
    },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const snapshot = await reader.readDirectChildren('parent')
  assert.equal(snapshot?.children[0]?.kind === 'child' && snapshot.children[0].hasChildren, false)
})

test('a parent present only as a retained fallback row is still known to exist', async () => {
  const generations = generationHarness()
  // `byId` includes retained subagent fallbacks beyond the Host list; a
  // parent that is itself a subagent is omitted from `ids` while still
  // existing, so availability follows byId presence, not ids membership.
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [catalogEntry('child-a')], state: 'ready' } },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const snapshot = await reader.readDirectChildren('parent')
  assert.equal(snapshot?.parentAvailable, true)
})

test('discards a refresh result when Connection generation changes', async () => {
  const generations = generationHarness()
  let releaseRefresh!: () => void
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    refresh: () => refreshGate,
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const pending = reader.readDirectChildren('parent')
  generations.set({ id: 2 })
  releaseRefresh()
  assert.equal(await pending, undefined)
})

test('honors caller cancellation before and after the official refresh', async () => {
  const generations = generationHarness()
  let releaseRefresh!: () => void
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    refresh: () => refreshGate,
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const controller = new AbortController()
  const pending = reader.readDirectChildren('parent', controller.signal)
  controller.abort()
  releaseRefresh()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('dispose during an awaited projection refresh discards the in-flight read', async () => {
  const generations = generationHarness()
  let releaseRefresh!: () => void
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    refresh: () => refreshGate,
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const pending = reader.readDirectChildren('parent')
  await Promise.resolve()
  reader.dispose()
  releaseRefresh()
  assert.equal(await pending, undefined, 'a read that was in flight at dispose must never return a snapshot')
})

test('a newer read for another parent supersedes the older in-flight read', async () => {
  const generations = generationHarness()
  let releaseA!: () => void
  const gateA = new Promise<void>(resolve => { releaseA = resolve })
  const client = sessionsFixture({
    byId: { 'parent-a': { running: false }, 'parent-b': { running: false } },
    projections: { 'parent-b': { entries: [], state: 'ready' } },
    refresh: sessionId => sessionId === 'parent-a' ? gateA : Promise.resolve(),
  })
  const jobs = jobsFixture({})
  const reader = new RemoteTaskReader(client, jobs, generations.source)
  const pendingA = reader.readDirectChildren('parent-a')
  await Promise.resolve()
  // A newer read (also switching the roster watch) supersedes the older
  // one even though the Connection generation never changed.
  const snapshotB = await reader.readDirectChildren('parent-b')
  assert.ok(snapshotB !== undefined, 'the newer read must complete normally')
  releaseA()
  assert.equal(await pendingA, undefined, 'the superseded in-flight read must be discarded')
  assert.deepEqual(jobs.watchCalls, ['parent-a', 'parent-b'])
})

test('an absent Connection generation reads as unavailable', async () => {
  const generations = generationHarness()
  generations.set(undefined)
  const reader = new RemoteTaskReader(
    sessionsFixture({ byId: { parent: { running: false } }, projections: { parent: { entries: [], state: 'ready' } } }),
    jobsFixture({}),
    generations.source,
  )
  assert.equal(await reader.readDirectChildren('parent'), undefined)
})

test('the roster watch is retained across reads and switches with the parent session', async () => {
  const generations = generationHarness()
  const client = sessionsFixture({
    byId: { 'parent-a': { running: false }, 'parent-b': { running: false } },
    projections: {
      'parent-a': { entries: [], state: 'ready' },
      'parent-b': { entries: [], state: 'ready' },
    },
  })
  const jobs = jobsFixture({ rows: { 'parent-a': [jobView('a-1')], 'parent-b': [jobView('b-1')] } })
  const reader = new RemoteTaskReader(client, jobs, generations.source)

  // First read acquires exactly one watch for that parent.
  const first = await reader.readDirectChildren('parent-a')
  assert.deepEqual(first?.jobs.map(entry => entry.id), ['a-1'])
  assert.deepEqual(jobs.watchCalls, ['parent-a'])

  // Repeated reads of the SAME parent keep the watch (no re-acquire).
  await reader.readDirectChildren('parent-a')
  assert.deepEqual(jobs.watchCalls, ['parent-a'])

  // Reading another parent releases the old watch and acquires the new
  // one — the successor is acquired BEFORE the predecessor is released.
  const switched = await reader.readDirectChildren('parent-b')
  assert.deepEqual(switched?.jobs.map(entry => entry.id), ['b-1'])
  assert.deepEqual(jobs.watchCalls, ['parent-a', 'parent-b'])
  assert.deepEqual(jobs.releases, ['parent-a'])
  // The successor's rows survive the predecessor's release (the official
  // release is entry-bound; the reader also never re-releases the old one).
  assert.deepEqual((jobs.state.getSnapshot().rows)['parent-b']?.map(entry => entry.id), ['b-1'])

  // Switching back re-acquires (the old watch for parent-a was dropped).
  await reader.readDirectChildren('parent-a')
  assert.deepEqual(jobs.watchCalls, ['parent-a', 'parent-b', 'parent-a'])
})

test('dispose releases the retained watch exactly once and reacquisition stays safe', async () => {
  const generations = generationHarness()
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [], state: 'ready' } },
  })
  const jobs = jobsFixture({ rows: { parent: [jobView('j1')] } })
  const reader = new RemoteTaskReader(client, jobs, generations.source)
  await reader.readDirectChildren('parent')
  assert.deepEqual(jobs.watchCalls, ['parent'])

  reader.dispose()
  reader.dispose()
  assert.deepEqual(jobs.releases, ['parent'], 'dispose must release exactly once')

  // Reacquisition after dispose is safe: a fresh read opens a new watch.
  jobs.setRows('parent', [jobView('j1', 'completed')])
  const again = await reader.readDirectChildren('parent')
  assert.deepEqual(again?.jobs.map(entry => entry.status), ['completed'])
  assert.deepEqual(jobs.watchCalls, ['parent', 'parent'])
})

test('an in-flight first roster frame reads as an empty roster, never an error', async () => {
  const generations = generationHarness()
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [catalogEntry('child-a')], state: 'ready' } },
  })
  // No rows key yet: the watch is open but the first frame has not landed.
  const jobs = jobsFixture({})
  const reader = new RemoteTaskReader(client, jobs, generations.source)
  const snapshot = await reader.readDirectChildren('parent')
  assert.deepEqual(jobs.watchCalls, ['parent'])
  assert.deepEqual(snapshot?.jobs, [])
})

test('a roster settlement while the watch is retained updates the next read', async () => {
  const generations = generationHarness()
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [catalogEntry('child-a')], state: 'ready' } },
  })
  const jobs = jobsFixture({})
  const reader = new RemoteTaskReader(client, jobs, generations.source)
  assert.deepEqual((await reader.readDirectChildren('parent'))?.jobs, [])
  // The official stream delivers the whole-set frame.
  jobs.setRows('parent', [jobView('bash-1', 'completed')])
  const updated = await reader.readDirectChildren('parent')
  assert.deepEqual(updated?.jobs, [job('bash-1', 'completed')])
  // Still exactly one watch: the retained roster follows the official source.
  assert.deepEqual(jobs.watchCalls, ['parent'])
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
      list(caller) {
        // DSH 0.1.7 JobRegistry ownership: the caller is the parent
        // SessionId, never the Agent object.
        assert.equal(caller, 'parent')
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

test('a settled continuable child keeps its status and result fields (plan §9.3)', async () => {
  // The parent settlement notice projection must never make the TUI drop the
  // child's own task fields: the task read reports the settled child's
  // mode/activity (status) and label (result metadata) independently.
  const direct = new DirectTaskReader({
    agentFor: id => id === 'parent' ? { status: 'idle' } : undefined,
    subagents: {
      async listChildren() {
        return [{ kind: 'child', id: 'child', label: 'Child result', mode: 'continuable', activity: 'inactive', hasChildren: false }]
      },
    },
    jobs: { list: () => [] },
  })
  const read = await direct.readDirectChildren('parent')
  const child = read?.children[0]
  assert.ok(child !== undefined && child.kind === 'child', 'the settled child must stay a readable row')
  assert.equal(child.mode, 'continuable', 'the continuable mode must survive settlement')
  assert.equal(child.activity, 'inactive', 'the settled activity must survive')
  assert.equal(child.label, 'Child result', 'the child result metadata must survive')
})

test('Direct passes the parent SessionId to jobs after an awaited listing and fences a vanished parent', async () => {
  const parent: DirectTaskAgent = { status: 'running' }
  let parentLive = true
  let release!: () => void
  let signalListingStarted!: () => void
  const listingStarted = new Promise<void>(resolve => { signalListingStarted = resolve })
  const listingGate = new Promise<void>(resolve => { release = resolve })
  let jobsReads = 0
  const direct = new DirectTaskReader({
    agentFor: id => id === 'parent' && parentLive ? parent : undefined,
    subagents: {
      async listChildren() {
        signalListingStarted()
        await listingGate
        return []
      },
    },
    jobs: {
      list(caller) {
        jobsReads += 1
        // DSH 0.1.7 JobRegistry ownership: the caller is the parent
        // SessionId, never the Agent object — even after the awaited
        // listing re-resolved the parent Agent.
        assert.equal(caller, 'parent')
        return [job('owner-job')]
      },
    },
  })

  // While the official listing is still in flight, the SessionId-owned
  // jobs read must not have happened: it follows the awaited catalog.
  const pending = direct.readDirectChildren('parent')
  await listingStarted
  assert.equal(jobsReads, 0, 'jobs.list must not run before the listing settles')
  release()
  assert.deepEqual((await pending)?.jobs, [job('owner-job')])
  assert.equal(jobsReads, 1)

  // The parent vanishing WHILE the listing is awaited fences the read at
  // the post-await availability re-check: no snapshot, no jobs read. The
  // initial check must have PASSED (the read started), so only the
  // re-resolution after the await can produce the fence.
  let releaseAgain!: () => void
  let signalAgain!: () => void
  const startedAgain = new Promise<void>(resolve => { signalAgain = resolve })
  const gateAgain = new Promise<void>(resolve => { releaseAgain = resolve })
  const directAgain = new DirectTaskReader({
    agentFor: id => id === 'parent' && parentLive ? parent : undefined,
    subagents: {
      async listChildren() {
        signalAgain()
        await gateAgain
        return []
      },
    },
    jobs: {
      list: () => {
        jobsReads += 1
        return [job('must-not-appear')]
      },
    },
  })
  const pendingAgain = directAgain.readDirectChildren('parent')
  // The read STARTED with the parent live (initial availability check
  // passed and the listing is awaited); only NOW does the parent vanish.
  await startedAgain
  parentLive = false
  releaseAgain()
  assert.equal(await pendingAgain, undefined)
  assert.equal(jobsReads, 1, 'a parent vanishing during the awaited listing must not produce a jobs read')
})

test('Direct and Remote expose the SAME read-only DTO for an official unknown-mode child', async () => {
  // D1 semantic convergence: a historical/descriptor-missing child carries
  // the official `mode: 'unknown'`. Both readers must present the identical
  // port DTO (read-only one-shot) — the parity smoke injects official
  // entries through JS, so this typed test is the contract proof.
  const generations = generationHarness()
  const direct = new DirectTaskReader({
    agentFor: id => id === 'parent' ? { status: 'idle' } : undefined,
    subagents: {
      async listChildren() {
        return [{ id: 'child-unknown', mode: 'unknown' }]
      },
    },
    jobs: { list: () => [] },
  })
  const remote = new RemoteTaskReader(
    sessionsFixture({
      byId: { parent: { running: false } },
      projections: { parent: { entries: [{ id: 'child-unknown', createdAt: 10, mode: 'unknown' }], state: 'ready' } },
    }),
    jobsFixture({}),
    generations.source,
  )
  const directChild = (await direct.readDirectChildren('parent'))?.children[0]
  const remoteChild = (await remote.readDirectChildren('parent'))?.children[0]
  assert.deepEqual(directChild, remoteChild)
  assert.deepEqual(directChild, { kind: 'child', id: 'child-unknown', mode: 'one-shot', activity: 'inactive', hasChildren: false })
})

test('Direct maps an official unknown catalog mode to the read-only presentation (Remote parity)', async () => {
  // The official rc.1 SubagentCatalogEntry vocabulary includes 'unknown'
  // (descriptor-missing / historical child). The Direct reader must apply
  // the SAME mapping as the Remote projection reader — the smoke injects
  // raw official entries through JS, so only this typed test pins the
  // port contract.
  const direct = new DirectTaskReader({
    agentFor: id => id === 'parent' ? { status: 'idle' } : undefined,
    subagents: {
      async listChildren() {
        const unknownChild: DirectTaskChildEntry = { id: 'child-unknown', mode: 'unknown' }
        const continuableChild: DirectTaskChildEntry = { id: 'child-known', mode: 'continuable', label: 'Known' }
        return [unknownChild, continuableChild]
      },
    },
    jobs: { list: () => [] },
  })
  const read = await direct.readDirectChildren('parent')
  const unknown = read?.children.find(entry => entry.id === 'child-unknown')
  const known = read?.children.find(entry => entry.id === 'child-known')
  assert.ok(unknown !== undefined && unknown.kind === 'child')
  assert.equal(unknown.kind === 'child' && unknown.mode, 'one-shot',
    'an unclassified child must map to the read-only presentation, never leak the raw official mode')
  assert.equal(known?.kind === 'child' && known.mode, 'continuable')
  assert.equal(known?.kind === 'child' && known.label, 'Known')
})
