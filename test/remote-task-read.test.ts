import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteTaskReader,
  type RemoteJobView,
  type RemoteSubagentCatalogEntry,
  type RemoteTaskJobsSource,
  type RemoteTaskSessionsSource,
} from '../src/runtime/remote/task-read-remote.ts'
import { DirectTaskReader, type DirectTaskAgent, type DirectTaskReadSource } from '../src/runtime/direct/task-read-direct.ts'
import { createSnapshotGenerationHarness } from './support/remote-generation.ts'
import type { TaskJobEntry, TaskSubagentEntry } from '../src/runtime/task-read-port.ts'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IJobs } from '@deepseek-ai/dsh-api-job-controller/client'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'

function constructOfficialReader(sessions: ISessions, jobs: IJobs, generation: ConnectionGenerationState): RemoteTaskReader {
  return new RemoteTaskReader(sessions, jobs, generation)
}

/** Compile-time proof: the official recursive catalog row satisfies the
 * Direct adapter's descendant source with no cast (Step 2 wires the official
 * `subagents.listDescendants` straight into this source). */
function officialDescendantSource(
  list: (parentSessionId: string, signal?: AbortSignal) => Promise<readonly SubagentDescendantListEntry[]>,
): DirectTaskReadSource['subagents']['listDescendants'] {
  return list
}

function child(
  id: string,
  parentId: string,
  depth: number,
  options: {
    label?: string
    mode?: 'one-shot' | 'continuable'
    activity?: 'running' | 'inactive'
    hasChildren?: boolean
  } = {},
): TaskSubagentEntry {
  return {
    kind: 'child',
    id,
    ...(options.label === undefined ? {} : { label: options.label }),
    mode: options.mode ?? 'continuable',
    activity: options.activity ?? 'inactive',
    hasChildren: options.hasChildren ?? false,
    parentId,
    depth,
  }
}

function catalogEntry(
  id: string,
  mode: RemoteSubagentCatalogEntry['mode'] = 'continuable',
  label: string | undefined = `child ${id}`,
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
  projections?: Record<string, ProjectionFixture | undefined>
  refresh?: (sessionId: string) => Promise<void>
}): RemoteTaskSessionsSource & {
  refreshCalls: number
  retainCalls: number
  openLogCalls: number
  setProjection(id: string, fixture: ProjectionFixture | undefined): void
  setRunning(id: string, running: boolean): void
  retain(sessionId: string): void
  openLog(sessionId: string): void
} {
  const projections: Record<string, ProjectionFixture | undefined> = { ...options.projections }
  const byId: Record<string, { running: boolean }> = { ...options.byId }
  let refreshCalls = 0
  let retainCalls = 0
  let openLogCalls = 0
  return {
    list: {
      getSnapshot: () => ({
        byId,
        projectionsBySession: Object.fromEntries(Object.entries(projections).map(([id, fixture]) => [id, fixture === undefined ? undefined : {
          values: { subagentCatalog: fixture.entries },
          state: fixture.state ?? (fixture.entries === undefined ? 'idle' : 'ready'),
          error: fixture.error ?? null,
        }])),
      }),
    },
    async refreshProjections(sessionId: string) {
      refreshCalls += 1
      if (options.refresh !== undefined) {
        await options.refresh(sessionId)
        return
      }
      // The default official single-flight settlement: an unset/loading
      // projection settles as an authoritative empty catalog. Tests that
      // gate or observe the refresh provide their own callback instead.
      const current = projections[sessionId]
      if (current === undefined || current.state === 'loading' || current.state === 'idle') {
        projections[sessionId] = { entries: [], state: 'ready' }
      }
    },
    get refreshCalls() { return refreshCalls },
    get retainCalls() { return retainCalls },
    get openLogCalls() { return openLogCalls },
    setProjection(id, fixture) { projections[id] = fixture },
    setRunning(id, running) { byId[id] = { running } },
    retain() { retainCalls += 1 },
    openLog() { openLogCalls += 1 },
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
  failWatch(error: unknown): void
} {
  const rows: Record<string, readonly RemoteJobView[]> = { ...options.rows }
  const watchCalls: string[] = []
  const releases: string[] = []
  let watchError: unknown
  // Entry-bound releases, mirroring the official ClientJobs contract: a
  // release only drops ITS OWN acquisition, never a successor's rows.
  const droppedByRelease: string[] = []
  return {
    state: { getSnapshot: () => ({ rows: Object.fromEntries(Object.entries(rows).filter(([, value]) => value.length > 0)) }) },
    watchRows(sessionId: string) {
      watchCalls.push(sessionId)
      // Fault injection: the structural source may fail synchronously in
      // `watchRows`, and the reader must not orphan an owned lease.
      if (watchError !== undefined) throw watchError
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
    failWatch(error) { watchError = error },
    setRows(sessionId, value) {
      if (value === undefined || value.length === 0) delete rows[sessionId]
      else rows[sessionId] = value
    },
  }
}

/** Two-level fixture: root -> child-a (with two grandchildren) + child-b. */
function twoLevelFixture(): RemoteTaskSessionsSource & {
  refreshCalls: number
  retainCalls: number
  openLogCalls: number
  setRunning(id: string, running: boolean): void
} {
  return sessionsFixture({
    byId: {
      parent: { running: true },
      'child-a': { running: true },
      'child-b': { running: false },
      'grandchild-a1': { running: false },
      'grandchild-a2': { running: false },
    },
    projections: {
      parent: { entries: [catalogEntry('child-a'), catalogEntry('child-b', 'one-shot')], state: 'ready' },
      'child-a': { entries: [catalogEntry('grandchild-a1', 'one-shot'), catalogEntry('grandchild-a2')], state: 'ready' },
      'child-b': { entries: [], state: 'ready' },
      'grandchild-a1': { entries: [], state: 'ready' },
      'grandchild-a2': { entries: [], state: 'ready' },
    },
  })
}

test('official Client Sessions and Jobs faces satisfy the Task adapter boundary', () => {
  assert.equal(typeof constructOfficialReader, 'function')
  assert.equal(typeof officialDescendantSource, 'function')
})

test('recursively reads the full descendant tree in stable pre-order with exact parent/depth', async () => {
  const generations = createSnapshotGenerationHarness()
  const client = twoLevelFixture()
  const jobs = jobsFixture({ rows: { parent: [jobView('j1', 'completed'), jobView('j2')] } })
  const reader = new RemoteTaskReader(client, jobs, generations.source)

  const snapshot = await reader.readDescendants('parent')
  assert.deepEqual(snapshot, {
    parentSessionId: 'parent',
    parentAvailable: true,
    descendants: [
      // child-a's whole subtree precedes the later sibling child-b.
      child('child-a', 'parent', 1, { label: 'child child-a', activity: 'running', hasChildren: true }),
      child('grandchild-a1', 'child-a', 2, { label: 'child grandchild-a1', mode: 'one-shot' }),
      child('grandchild-a2', 'child-a', 2, { label: 'child grandchild-a2' }),
      child('child-b', 'parent', 1, { label: 'child child-b', mode: 'one-shot' }),
    ],
    jobs: [job('j1', 'completed'), job('j2')],
  })
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot?.descendants), true)
  assert.equal(Object.isFrozen(snapshot?.jobs), true)
  // The settled read never needed an explicit refresh (every projection was ready).
  assert.equal(client.refreshCalls, 0)
})

test('child activity comes from the official Session running bit, never catalog presence', async () => {
  const generations = createSnapshotGenerationHarness()
  const client = twoLevelFixture()
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)

  const first = await reader.readDescendants('parent')
  assert.equal(first?.descendants[0]?.kind === 'child' && first.descendants[0].activity, 'running')
  // child-b is durably catalogued but not running: inactivity is a Session
  // fact, not a membership fact.
  assert.equal(first?.descendants[3]?.kind === 'child' && first.descendants[3].activity, 'inactive')

  client.setRunning('child-a', false)
  const flipped = await reader.readDescendants('parent')
  assert.equal(flipped?.descendants[0]?.kind === 'child' && flipped.descendants[0].activity, 'inactive')
})

test('unknown mode becomes an unsupported diagnostic and its children are still traversed', async () => {
  const generations = createSnapshotGenerationHarness()
  const client = sessionsFixture({
    byId: {
      parent: { running: true },
      'child-unknown': { running: false },
      'child-sibling': { running: false },
      grandchild: { running: false },
    },
    projections: {
      parent: { entries: [catalogEntry('child-unknown', 'unknown'), catalogEntry('child-sibling')], state: 'ready' },
      'child-unknown': { entries: [catalogEntry('grandchild')], state: 'ready' },
      'child-sibling': { entries: [], state: 'ready' },
      grandchild: { entries: [], state: 'ready' },
    },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)

  const snapshot = await reader.readDescendants('parent')
  assert.deepEqual(snapshot?.descendants, [
    { kind: 'diagnostic', id: 'child-unknown', reason: 'unsupported', parentId: 'parent', depth: 1 },
    // The unknown child's readable catalog is still traversed.
    child('grandchild', 'child-unknown', 2, { label: 'child grandchild' }),
    // A different sibling survives.
    child('child-sibling', 'parent', 1, { label: 'child child-sibling' }),
  ])
})

// ADAPTER/SHAPE-LEVEL ONLY (NOT wire parity): this case feeds the adapter a
// surviving structured `SESSION_QUERY_*` reason, which the rc.2 Client carrier
// does NOT deliver (see the carrier-shaped case below). It pins the adapter's
// semantic mapping — `corrupt` stays part of the official Subagent vocabulary —
// and the branch-scoped sibling survival rule.
test('ADAPTER-SHAPE: a branch read failure with a SURVIVING structured reason maps to corrupt/unavailable and siblings survive', async () => {
  const generations = createSnapshotGenerationHarness()
  const corrupt = Object.assign(new Error('corrupt session'), { code: 'SESSION_QUERY_CORRUPT_SESSION' })
  const conflict = Object.assign(new Error('source conflict'), { code: 'SESSION_QUERY_SOURCE_CONFLICT' })
  const unavailable = new Error('projection unavailable')
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: {
      parent: {
        entries: [catalogEntry('child-corrupt'), catalogEntry('child-conflict'), catalogEntry('child-plain'), catalogEntry('child-ok')],
        state: 'ready',
      },
      'child-corrupt': { entries: [], state: 'error', error: corrupt },
      'child-conflict': { entries: [], state: 'error', error: conflict },
      'child-plain': { entries: [], state: 'error', error: unavailable },
      'child-ok': { entries: [], state: 'ready' },
    },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)

  const snapshot = await reader.readDescendants('parent')
  assert.deepEqual(snapshot?.descendants, [
    { kind: 'diagnostic', id: 'child-corrupt', reason: 'corrupt', parentId: 'parent', depth: 1 },
    { kind: 'diagnostic', id: 'child-conflict', reason: 'corrupt', parentId: 'parent', depth: 1 },
    { kind: 'diagnostic', id: 'child-plain', reason: 'unavailable', parentId: 'parent', depth: 1 },
    child('child-ok', 'parent', 1, { label: 'child child-ok' }),
  ])
})

test('a root catalog read failure rejects instead of returning an empty catalog', async () => {
  const generations = createSnapshotGenerationHarness()
  const failure = new Error('root projection unavailable')
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [], state: 'error', error: failure } },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  await assert.rejects(reader.readDescendants('parent'), error => error === failure)
})

test('a ready projection with an empty catalog is an authoritative empty membership', async () => {
  const generations = createSnapshotGenerationHarness()
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [], state: 'ready' } },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const snapshot = await reader.readDescendants('parent')
  assert.deepEqual(snapshot?.descendants, [])
  assert.equal(snapshot?.parentAvailable, true)
})

test('F4 regression: ready WITHOUT the catalog is a read failure, never an authoritative empty root', async () => {
  const generations = createSnapshotGenerationHarness()
  // The official Client clears the projection store and still settles `ready`
  // when `session.projections` answers a null/missing Session (manager.ts), so
  // `ready + no subagentCatalog` is a REAL failure — the same one upstream
  // `listChildren` reports as SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE.
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: undefined, state: 'ready' } },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  await assert.rejects(reader.readDescendants('parent'), /subagentCatalog projection is unavailable/)
})

test('F4 regression: ready without the catalog on a BRANCH becomes an unavailable diagnostic, never a normal child', async () => {
  const generations = createSnapshotGenerationHarness()
  const client = sessionsFixture({
    byId: { parent: { running: false }, child: { running: false } },
    projections: {
      parent: { entries: [catalogEntry('child', 'continuable', 'child child')], state: 'ready' },
      child: { entries: undefined, state: 'ready' },
    },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const snapshot = await reader.readDescendants('parent')
  assert.deepEqual(snapshot?.descendants, [
    { kind: 'diagnostic', id: 'child', reason: 'unavailable', parentId: 'parent', depth: 1 },
  ], 'a ghost branch must never present as a normal inactive child with hasChildren:false')
})

test('F4d/OWNER-RULED: a BRANCH whose projections are unavailable degrades BRANCH-LOCALLY (siblings survive)', async () => {
  const generations = createSnapshotGenerationHarness()
  // The official `session.projections` handler answers
  // `session/projections-unavailable` when the Session is readable but its
  // projections are not — Direct's `listChildren`
  // SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE, which the CURRENT Host
  // `listDescendants` re-throws (a whole-traversal abort). That propagation is a
  // Host-implementation/contract tension, NOT the shared semantic: the released
  // Client/Web catalog contract keeps an unreadable child catalog expandable and
  // retryable and only treats `ready + empty` as a known leaf. The plan owner
  // RULED (F4d) that the Remote adapter follows the branch-isolation product
  // semantic: a branch-local `unavailable` diagnostic, siblings survive. Exact
  // failure-scope parity is NOT representable on rc.2 (recorded carrier
  // limitation) — do not "fix" this back into a whole-traversal abort.
  const wireFailure = Object.assign(new Error('Session projections are unavailable'), {
    code: 'session/projections-unavailable',
  })
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: {
      parent: { entries: [catalogEntry('child-x'), catalogEntry('child-ok')], state: 'ready' },
      'child-x': { entries: [], state: 'error', error: wireFailure },
      'child-ok': { entries: [], state: 'ready' },
    },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const snapshot = await reader.readDescendants('parent')
  assert.deepEqual(snapshot?.descendants, [
    { kind: 'diagnostic', id: 'child-x', reason: 'unavailable', parentId: 'parent', depth: 1 },
    child('child-ok', 'parent', 1, { label: 'child child-ok' }),
  ], 'the unreadable branch degrades locally and its sibling stays visible')
})

test('F4d: a `ready` baseline without the catalog stays branch-scoped for BOTH provenances (carrier cannot distinguish them)', async () => {
  const generations = createSnapshotGenerationHarness()
  // The official handler returns NULL for a missing Session and a non-null
  // `{asOfSeq, values}` for a readable Session whose baseline omits the catalog;
  // the rc.2 Client collapses both into `ready` + key absent (it never exposes the
  // provenance), so the adapter cannot tell them apart and MUST NOT guess from
  // Session-list membership/catalog presence. The ruled policy is branch-local for
  // both; this test pins the missing-Session provenance (the one the real-wire
  // ghost L5 proves), and the non-null provenance reaches the SAME observable.
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: {
      parent: { entries: [catalogEntry('ghost'), catalogEntry('child-ok')], state: 'ready' },
      ghost: { entries: undefined, state: 'ready' },
      'child-ok': { entries: [], state: 'ready' },
    },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const snapshot = await reader.readDescendants('parent')
  assert.deepEqual(snapshot?.descendants, [
    { kind: 'diagnostic', id: 'ghost', reason: 'unavailable', parentId: 'parent', depth: 1 },
    child('child-ok', 'parent', 1, { label: 'child child-ok' }),
  ], 'a missing/absent child baseline loses only its own branch and the sibling survives')
})

test('rc.2 CARRIER shape: a REAL wire branch failure (RemoteError code=gateway/internal) is unavailable, never corrupt', async () => {
  const generations = createSnapshotGenerationHarness()
  // The official `session.projections` handler collapses corrupt /
  // source-conflicting SessionQuery failures into `gateway/internal`, and the
  // wire only carries the fixed RemoteErrorCode union — the legacy
  // SESSION_QUERY_* taxonomy never crosses the carrier. Such a FOREIGN branch
  // failure maps to `unavailable`, and `corrupt` must never be inferred from
  // messages, causes, child state or log shape. (This is one of several wire
  // shapes, not the only one: `session/projections-unavailable` and
  // `gateway/cancelled` reach the SAME branch-local degradation — see the F4d
  // owner-ruled cases above; no wire shape aborts the whole traversal.)
  const wireFailure = Object.assign(new Error('internal failure'), { code: 'gateway/internal' })
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: {
      parent: { entries: [catalogEntry('child', 'continuable', 'child child')], state: 'ready' },
      child: { entries: [], state: 'error', error: wireFailure },
    },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const snapshot = await reader.readDescendants('parent')
  assert.deepEqual(snapshot?.descendants, [
    { kind: 'diagnostic', id: 'child', reason: 'unavailable', parentId: 'parent', depth: 1 },
  ], 'the rc.2 carrier cannot express corrupt, so the honest diagnostic is unavailable')
})

test('F5 regression: a transient projection error re-enters the official retryable refresh ONCE, then succeeds', async () => {
  const generations = createSnapshotGenerationHarness()
  let client!: ReturnType<typeof sessionsFixture>
  client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [], state: 'error', error: new Error('transient projection failure') } },
    // The official `refreshProjections` retries an unsuccessful read (it
    // short-circuits only on a settled `ready`): the repaired read must land.
    refresh: async (sessionId) => { client.setProjection(sessionId, { entries: [], state: 'ready' }) },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const snapshot = await reader.readDescendants('parent')
  assert.equal(client.refreshCalls, 1, 'the error state must re-enter the official retry face exactly once')
  assert.equal(snapshot?.parentAvailable, true)
  assert.deepEqual(snapshot?.descendants, [])
})

test('F5 regression: a STILL-failing projection rejects after exactly ONE retry (no hot loop)', async () => {
  const generations = createSnapshotGenerationHarness()
  const failure = new Error('permanent projection failure')
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [], state: 'error', error: failure } },
    // A retry that leaves the state in error (the default fixture settlement
    // never promotes an errored projection).
    refresh: async () => {},
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  await assert.rejects(reader.readDescendants('parent'), error => error === failure)
  assert.equal(client.refreshCalls, 1, 'the read is bounded to one official retry per attempt')
})

test('listing never retains or opens a Session', async () => {
  const generations = createSnapshotGenerationHarness()
  const client = twoLevelFixture()
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  await reader.readDescendants('parent')
  assert.equal(client.retainCalls, 0)
  assert.equal(client.openLogCalls, 0)
})

test('waits for a Client-owned trailing projection refresh before settling', async () => {
  const generations = createSnapshotGenerationHarness()
  let refreshCalls = 0
  const jobs = jobsFixture({ rows: { parent: [jobView('trailing-job')] } })
  const reader = new RemoteTaskReader({
    list: {
      getSnapshot: () => ({
        byId: { parent: { running: false }, 'after-trailing': { running: false } },
        // The Client's trailing refresh is still armed after the first
        // refresh resolves: the parent projection reads loading until the
        // second official single-flight round settles it. The child's own
        // catalog is already settled.
        projectionsBySession: refreshCalls < 2 ? {} : {
          parent: { values: { subagentCatalog: [catalogEntry('after-trailing')] }, state: 'ready' as const, error: null },
          'after-trailing': { values: { subagentCatalog: [] }, state: 'ready' as const, error: null },
        },
      }),
    },
    async refreshProjections() {
      refreshCalls += 1
    },
  }, jobs, generations.source)
  const snapshot = await reader.readDescendants('parent')
  assert.equal(refreshCalls, 2)
  assert.deepEqual(snapshot?.descendants.map(entry => entry.id), ['after-trailing'])
  assert.deepEqual(snapshot?.jobs, [job('trailing-job')])
})

test('membership and parent availability are separate authorities', async () => {
  const generations = createSnapshotGenerationHarness()
  // A parent ABSENT from the official list (no byId row) is unavailable
  // even though its projection is ready with children.
  const client = sessionsFixture({
    projections: { parent: { entries: [catalogEntry('child-a')], state: 'ready' } },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const snapshot = await reader.readDescendants('parent')
  assert.equal(snapshot?.parentAvailable, false)
  assert.deepEqual(snapshot?.descendants.map(entry => entry.id), ['child-a'])
})

test('a parent present only as a retained fallback row is still known to exist', async () => {
  const generations = createSnapshotGenerationHarness()
  // `byId` includes retained subagent fallbacks beyond the Host list; a
  // parent that is itself a subagent is omitted from `ids` while still
  // existing, so availability follows byId presence, not ids membership.
  const client = sessionsFixture({
    byId: { parent: { running: false }, 'child-a': { running: false } },
    projections: { parent: { entries: [catalogEntry('child-a')], state: 'ready' } },
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const snapshot = await reader.readDescendants('parent')
  assert.equal(snapshot?.parentAvailable, true)
})

test('discards a refresh result when Connection generation changes', async () => {
  const generations = createSnapshotGenerationHarness()
  let releaseRefresh!: () => void
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    refresh: () => refreshGate,
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const pending = reader.readDescendants('parent')
  generations.set({ id: 2 })
  releaseRefresh()
  assert.equal(await pending, undefined)
})

test('honors caller cancellation before and after the official refresh', async () => {
  const generations = createSnapshotGenerationHarness()
  let releaseRefresh!: () => void
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    refresh: () => refreshGate,
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const controller = new AbortController()
  const pending = reader.readDescendants('parent', controller.signal)
  controller.abort()
  releaseRefresh()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('a caller cancellation during a child catalog read propagates instead of becoming a diagnostic', async () => {
  const generations = createSnapshotGenerationHarness()
  let releaseChild!: () => void
  const childGate = new Promise<void>(resolve => { releaseChild = resolve })
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [catalogEntry('child-a')], state: 'ready' } },
    refresh: sessionId => sessionId === 'child-a' ? childGate : Promise.resolve(),
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const controller = new AbortController()
  const pending = reader.readDescendants('parent', controller.signal)
  // Let the root settle and the child catalog read enter its refresh.
  await Promise.resolve()
  await Promise.resolve()
  controller.abort()
  releaseChild()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('dispose during an awaited projection refresh discards the in-flight read', async () => {
  const generations = createSnapshotGenerationHarness()
  let releaseRefresh!: () => void
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    refresh: () => refreshGate,
  })
  const reader = new RemoteTaskReader(client, jobsFixture({}), generations.source)
  const pending = reader.readDescendants('parent')
  await Promise.resolve()
  reader.dispose()
  releaseRefresh()
  assert.equal(await pending, undefined, 'a read that was in flight at dispose must never return a snapshot')
})

test('a newer read for another parent supersedes the older in-flight read', async () => {
  const generations = createSnapshotGenerationHarness()
  let releaseA!: () => void
  const gateA = new Promise<void>(resolve => { releaseA = resolve })
  const client = sessionsFixture({
    byId: { 'parent-a': { running: false }, 'parent-b': { running: false } },
    projections: { 'parent-b': { entries: [], state: 'ready' } },
    refresh: sessionId => sessionId === 'parent-a' ? gateA : Promise.resolve(),
  })
  const jobs = jobsFixture({})
  const reader = new RemoteTaskReader(client, jobs, generations.source)
  const pendingA = reader.readDescendants('parent-a')
  await Promise.resolve()
  // A newer read (also switching the roster watch) supersedes the older
  // one even though the Connection generation never changed.
  const snapshotB = await reader.readDescendants('parent-b')
  assert.ok(snapshotB !== undefined, 'the newer read must complete normally')
  releaseA()
  assert.equal(await pendingA, undefined, 'the superseded in-flight read must be discarded')
  assert.deepEqual(jobs.watchCalls, ['parent-a', 'parent-b'])
})

test('an absent Connection generation reads as unavailable', async () => {
  const generations = createSnapshotGenerationHarness()
  generations.set(undefined)
  const reader = new RemoteTaskReader(
    sessionsFixture({ byId: { parent: { running: false } }, projections: { parent: { entries: [], state: 'ready' } } }),
    jobsFixture({}),
    generations.source,
  )
  assert.equal(await reader.readDescendants('parent'), undefined)
})

test('the roster watch is retained across reads and switches with the parent session', async () => {
  const generations = createSnapshotGenerationHarness()
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
  const first = await reader.readDescendants('parent-a')
  assert.deepEqual(first?.jobs.map(entry => entry.id), ['a-1'])
  assert.deepEqual(jobs.watchCalls, ['parent-a'])

  // Repeated reads of the SAME parent keep the watch (no re-acquire).
  await reader.readDescendants('parent-a')
  assert.deepEqual(jobs.watchCalls, ['parent-a'])

  // Reading another parent releases the old watch and acquires the new
  // one — the successor is acquired BEFORE the predecessor is released.
  const switched = await reader.readDescendants('parent-b')
  assert.deepEqual(switched?.jobs.map(entry => entry.id), ['b-1'])
  assert.deepEqual(jobs.watchCalls, ['parent-a', 'parent-b'])
  assert.deepEqual(jobs.releases, ['parent-a'])
  // The successor's rows survive the predecessor's release (the official
  // release is entry-bound; the reader also never re-releases the old one).
  assert.deepEqual((jobs.state.getSnapshot().rows)['parent-b']?.map(entry => entry.id), ['b-1'])

  // Switching back re-acquires (the old watch for parent-a was dropped).
  await reader.readDescendants('parent-a')
  assert.deepEqual(jobs.watchCalls, ['parent-a', 'parent-b', 'parent-a'])
})

test('a failed successor roster watch keeps the previous watch owned (no orphaned lease)', async () => {
  const generations = createSnapshotGenerationHarness()
  const client = sessionsFixture({
    byId: { 'parent-a': { running: false }, 'parent-b': { running: false } },
    projections: {
      'parent-a': { entries: [], state: 'ready' },
      'parent-b': { entries: [], state: 'ready' },
    },
  })
  const jobs = jobsFixture({ rows: { 'parent-a': [jobView('a-1')], 'parent-b': [jobView('b-1')] } })
  const reader = new RemoteTaskReader(client, jobs, generations.source)
  await reader.readDescendants('parent-a')
  assert.deepEqual(jobs.watchCalls, ['parent-a'])

  // The successor acquisition fails synchronously (connection teardown). The
  // reader must still OWN the predecessor watch, so dispose can release it.
  jobs.failWatch(new Error('the connection is going away'))
  await assert.rejects(() => reader.readDescendants('parent-b'), /connection is going away/)
  assert.deepEqual(jobs.releases, [], 'a failed acquire must not release the predecessor early')

  jobs.failWatch(undefined)
  reader.dispose()
  assert.deepEqual(jobs.releases, ['parent-a'],
    'the predecessor watch must still be reachable and released by dispose')
})

test('dispose releases the retained watch exactly once and reacquisition stays safe', async () => {
  const generations = createSnapshotGenerationHarness()
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [], state: 'ready' } },
  })
  const jobs = jobsFixture({ rows: { parent: [jobView('j1')] } })
  const reader = new RemoteTaskReader(client, jobs, generations.source)
  await reader.readDescendants('parent')
  assert.deepEqual(jobs.watchCalls, ['parent'])

  reader.dispose()
  reader.dispose()
  assert.deepEqual(jobs.releases, ['parent'], 'dispose must release exactly once')

  // Reacquisition after dispose is safe: a fresh read opens a new watch.
  jobs.setRows('parent', [jobView('j1', 'completed')])
  const again = await reader.readDescendants('parent')
  assert.deepEqual(again?.jobs.map(entry => entry.status), ['completed'])
  assert.deepEqual(jobs.watchCalls, ['parent', 'parent'])
})

test('an in-flight first roster frame reads as an empty roster, never an error', async () => {
  const generations = createSnapshotGenerationHarness()
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [catalogEntry('child-a')], state: 'ready' } },
  })
  // No rows key yet: the watch is open but the first frame has not landed.
  const jobs = jobsFixture({})
  const reader = new RemoteTaskReader(client, jobs, generations.source)
  const snapshot = await reader.readDescendants('parent')
  assert.deepEqual(jobs.watchCalls, ['parent'])
  assert.deepEqual(snapshot?.jobs, [])
})

test('a roster settlement while the watch is retained updates the next read', async () => {
  const generations = createSnapshotGenerationHarness()
  const client = sessionsFixture({
    byId: { parent: { running: false } },
    projections: { parent: { entries: [catalogEntry('child-a')], state: 'ready' } },
  })
  const jobs = jobsFixture({})
  const reader = new RemoteTaskReader(client, jobs, generations.source)
  assert.deepEqual((await reader.readDescendants('parent'))?.jobs, [])
  // The official stream delivers the whole-set frame.
  jobs.setRows('parent', [jobView('bash-1', 'completed')])
  const updated = await reader.readDescendants('parent')
  assert.deepEqual(updated?.jobs, [job('bash-1', 'completed')])
  // Still exactly one watch: the retained roster follows the official source.
  assert.deepEqual(jobs.watchCalls, ['parent'])
})

test('Direct maps listDescendants order/parent/depth, reprojects Agent activity, and reads parent jobs', async () => {
  const parent: DirectTaskAgent = { status: 'running' }
  let childStatus = 'idle'
  const direct = new DirectTaskReader({
    agentFor: id => id === 'parent' ? parent : id === 'child-a' ? { status: childStatus } : undefined,
    subagents: {
      async listDescendants() {
        return [
          child('child-a', 'parent', 1, { label: 'Child A', hasChildren: true }),
          child('grandchild', 'child-a', 2, { mode: 'one-shot' }),
          child('child-b', 'parent', 1, { mode: 'one-shot' }),
        ]
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

  const inactive = await direct.readDescendants('parent')
  assert.deepEqual(inactive?.descendants, [
    child('child-a', 'parent', 1, { label: 'Child A', hasChildren: true }),
    child('grandchild', 'child-a', 2, { mode: 'one-shot' }),
    child('child-b', 'parent', 1, { mode: 'one-shot' }),
  ])
  childStatus = 'running'
  const active = await direct.readDescendants('parent')
  assert.equal(active?.descendants[0]?.kind === 'child' && active.descendants[0].activity, 'running')
  assert.deepEqual(active?.jobs, [job('job')])
})

test('Direct copies a listDescendants diagnostic reason/parent/depth verbatim', async () => {
  const direct = new DirectTaskReader({
    agentFor: id => id === 'parent' ? { status: 'idle' } : undefined,
    subagents: {
      async listDescendants() {
        return [
          { kind: 'diagnostic', id: 'child-unknown', reason: 'unsupported', parentId: 'parent', depth: 1 },
          child('child-ok', 'parent', 1, { label: 'Child OK' }),
        ]
      },
    },
    jobs: { list: () => [] },
  })
  const read = await direct.readDescendants('parent')
  assert.deepEqual(read?.descendants, [
    { kind: 'diagnostic', id: 'child-unknown', reason: 'unsupported', parentId: 'parent', depth: 1 },
    child('child-ok', 'parent', 1, { label: 'Child OK' }),
  ])
})

test('a settled continuable child keeps its status and result fields (plan §9.3)', async () => {
  // The parent settlement notice projection must never make the TUI drop the
  // child's own task fields: the task read reports the settled child's
  // mode/activity (status) and label (result metadata) independently.
  const direct = new DirectTaskReader({
    agentFor: id => id === 'parent' ? { status: 'idle' } : undefined,
    subagents: {
      async listDescendants() {
        return [child('child', 'parent', 1, { label: 'Child result' })]
      },
    },
    jobs: { list: () => [] },
  })
  const read = await direct.readDescendants('parent')
  const entry = read?.descendants[0]
  assert.ok(entry !== undefined && entry.kind === 'child', 'the settled child must stay a readable row')
  assert.equal(entry.mode, 'continuable', 'the continuable mode must survive settlement')
  assert.equal(entry.activity, 'inactive', 'the settled activity must survive')
  assert.equal(entry.label, 'Child result', 'the child result metadata must survive')
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
      async listDescendants() {
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
  const pending = direct.readDescendants('parent')
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
      async listDescendants() {
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
  const pendingAgain = directAgain.readDescendants('parent')
  // The read STARTED with the parent live (initial availability check
  // passed and the listing is awaited); only NOW does the parent vanish.
  await startedAgain
  parentLive = false
  releaseAgain()
  assert.equal(await pendingAgain, undefined)
  assert.equal(jobsReads, 1, 'a parent vanishing during the awaited listing must not produce a jobs read')
})

test('Direct and Remote expose the SAME unsupported diagnostic for an official unknown-mode child', async () => {
  // D1 semantic convergence: a historical/descriptor-missing child carries
  // the official `mode: 'unknown'`. Both readers must present the identical
  // port DTO (branch diagnostic) — the parity smoke injects official
  // entries through JS, so this typed test is the contract proof.
  const generations = createSnapshotGenerationHarness()
  const direct = new DirectTaskReader({
    agentFor: id => id === 'parent' ? { status: 'idle' } : undefined,
    subagents: {
      async listDescendants() {
        return [{ kind: 'diagnostic', id: 'child-unknown', reason: 'unsupported', parentId: 'parent', depth: 1 }]
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
  const directChild = (await direct.readDescendants('parent'))?.descendants[0]
  const remoteChild = (await remote.readDescendants('parent'))?.descendants[0]
  assert.deepEqual(directChild, remoteChild)
  assert.deepEqual(directChild, { kind: 'diagnostic', id: 'child-unknown', reason: 'unsupported', parentId: 'parent', depth: 1 })
})
