/**
 * Tests for the TaskBrowserRuntime coordinator: the split between CATALOG
 * refreshes (the only path that re-lists descendants) and RUNTIME-only
 * refreshes (reuse the cached catalog, re-project activity from the Agent
 * registry). These are the plan's runner-level repro cases (plan §6.2):
 *
 * - Case A: a continuable direct child flips running → idle while the
 *   task browser stays open — the row must turn `inactive` WITHOUT a
 *   re-listing (the core bug: store-presence activity read as execution
 *   state).
 * - Case B: an idle continuable child reactivates on followup — the row
 *   must turn `running` again.
 * - Case C: nested continuable children — rows and the badge follow the
 *   registry projection; tree order never moves.
 * - Case D: a stale catalog response must not overwrite a newer runtime
 *   state (statuses are projected at COMMIT time), and a session switch
 *   mid-flight must never commit (the key fence).
 * @module @xmoon76/dsh-pi-tui/task-browser-runtime.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TaskBrowserRuntime, type TaskBrowserRuntimeHooks } from '../src/task-browser-runtime.ts'
import { AGENT_ROW_PREFIX, type TaskBrowserJobInput, type TaskBrowserRow } from '../src/tasks-browser.ts'

const child = (overrides: Partial<SubagentDescendantListEntry> = {}): SubagentDescendantListEntry => ({
  kind: 'child',
  id: 'child-a' as SessionId,
  label: 'research',
  mode: 'continuable' as const,
  activity: 'running',
  hasChildren: false,
  parentId: 'sess-main' as SessionId,
  depth: 1,
  ...overrides,
} as SubagentDescendantListEntry)

const job = (overrides: Partial<TaskBrowserJobInput> = {}): TaskBrowserJobInput => ({
  id: 'bash-1',
  kind: 'bash',
  label: 'pnpm build',
  status: 'running',
  startedAt: 1_000,
  ...overrides,
})

/** The activity word of one committed subagent row (undefined = no row). */
const subagentActivity = (rows: readonly TaskBrowserRow[], childId: string): string | undefined => {
  const row = rows.find(candidate =>
    candidate.kind === 'subagent' && candidate.childId === childId) as
    Extract<TaskBrowserRow, { kind: 'subagent' }> | undefined
  return row?.activity
}

const rowValue = (rows: readonly TaskBrowserRow[]): string[] => rows.map(row => row.value)

/** A harness with a DEFERRED listDescendants (the async catalog listing
 * completes only when the test settles it), a mutable registry-status
 * map, and commit/badge journals. */
function makeHarness(): {
  runtime: TaskBrowserRuntime
  listings(): number
  commits(): readonly TaskBrowserRow[][]
  preferreds(): readonly (string | undefined)[]
  badges(): readonly ReadonlyArray<{ id: string; label: string }>[]
  setKey(key: string | undefined): void
  setStatus(id: string, status: string | undefined): void
  setJobs(jobs: readonly TaskBrowserJobInput[]): void
  settleList(entries: readonly SubagentDescendantListEntry[]): void
} {
  let key: string | undefined = 'g1:sess-main'
  const statuses = new Map<string, string>()
  let jobs: TaskBrowserJobInput[] = [job()]
  let listingCount = 0
  let pendingResolve: ((entries: readonly SubagentDescendantListEntry[]) => void) | undefined
  const commits: TaskBrowserRow[][] = []
  const preferreds: (string | undefined)[] = []
  const badges: ReadonlyArray<{ id: string; label: string }>[] = []
  const runtime = new TaskBrowserRuntime({
    currentKey: () => key,
    listDescendants: () => {
      listingCount += 1
      return new Promise(resolve => { pendingResolve = resolve })
    },
    readJobs: () => jobs,
    agentStatusOf: (id) => statuses.get(id),
    commitRows: (rows, preferred) => {
      commits.push([...rows])
      preferreds.push(preferred)
    },
    commitBadge: (running) => badges.push([...running]),
  })
  return {
    runtime,
    listings: () => listingCount,
    commits: () => commits,
    preferreds: () => preferreds,
    badges: () => badges,
    setKey: (next) => { key = next },
    setStatus: (id, status) => { if (status === undefined) statuses.delete(id); else statuses.set(id, status) },
    setJobs: (next) => { jobs = [...next] },
    settleList: (entries) => { const resolve = pendingResolve; pendingResolve = undefined; resolve?.(entries) },
  }
}

test('Case A: a running continuable child turns inactive on agent idle without re-listing', async () => {
  const h = makeHarness()
  h.setStatus('child-a', 'running')
  const listing = h.runtime.refreshCatalog()
  h.settleList([child({ activity: 'running' })])
  await listing
  assert.equal(h.listings(), 1)
  assert.equal(h.commits().length, 1)
  assert.equal(subagentActivity(h.commits()[0]!, 'child-a'), 'running')
  assert.deepEqual(h.badges()[0]!.map(entry => entry.id), ['child-a'])
  // The child's turn ends: the driver goes idle while the browser stays
  // open. A runtime-only refresh must flip the SAME row to inactive
  // WITHOUT calling listDescendants again.
  h.setStatus('child-a', 'idle')
  h.runtime.refreshRuntime()
  assert.equal(h.listings(), 1, 'a runtime refresh must never re-list')
  assert.equal(h.commits().length, 2)
  assert.equal(subagentActivity(h.commits()[1]!, 'child-a'), 'inactive')
  assert.deepEqual(h.badges()[1], [], 'an idle child must leave the badge')
})

test('Case B: a followup reactivation flips an inactive row back to running', async () => {
  const h = makeHarness()
  h.setStatus('child-a', 'idle')
  const listing = h.runtime.refreshCatalog()
  h.settleList([child({ activity: 'running' })])
  await listing
  assert.equal(subagentActivity(h.commits()[0]!, 'child-a'), 'inactive', 'store presence never means running')
  // The user sends a followup to the continuable child: the driver
  // reactivates, and the runtime-only refresh flips the row back.
  h.setStatus('child-a', 'running')
  h.runtime.refreshRuntime()
  assert.equal(h.listings(), 1, 'no re-listing on a runtime flip')
  assert.equal(subagentActivity(h.commits()[1]!, 'child-a'), 'running')
  assert.deepEqual(h.badges()[1]!.map(entry => entry.id), ['child-a'])
})

test('Case C: nested children project independently and the tree order never moves', async () => {
  const h = makeHarness()
  h.setJobs([])
  // main └─ A (continuable) └─ B (continuable): B runs, A idles.
  h.setStatus('A', 'idle')
  h.setStatus('B', 'running')
  const catalog = [
    child({ id: 'A' as SessionId, activity: 'running', hasChildren: true, depth: 1 }),
    child({ id: 'B' as SessionId, activity: 'running', hasChildren: false, parentId: 'A' as SessionId, depth: 2 }),
  ]
  const listing = h.runtime.refreshCatalog()
  h.settleList(catalog)
  await listing
  assert.deepEqual(rowValue(h.commits()[0]!), [`${AGENT_ROW_PREFIX}A`, `${AGENT_ROW_PREFIX}B`])
  assert.equal(subagentActivity(h.commits()[0]!, 'A'), 'inactive')
  assert.equal(subagentActivity(h.commits()[0]!, 'B'), 'running')
  assert.deepEqual(h.badges()[0]!.map(entry => entry.id), ['B'], 'only the running descendant arms the badge')
  // B's turn ends: the runtime-only refresh flips it, and the TREE ORDER
  // never moves (the row values are byte-identical).
  h.setStatus('B', 'idle')
  h.runtime.refreshRuntime()
  assert.deepEqual(rowValue(h.commits()[1]!), [`${AGENT_ROW_PREFIX}A`, `${AGENT_ROW_PREFIX}B`])
  assert.equal(subagentActivity(h.commits()[1]!, 'B'), 'inactive')
  assert.deepEqual(h.badges()[1], [], 'the badge count drops with the driver')
})

test('Case D: a stale catalog response cannot overwrite a newer runtime state', async () => {
  const h = makeHarness()
  // T0: the listing starts while the driver is already idle (the flip
  // landed while the async listing was in flight).
  h.setStatus('child-a', 'idle')
  const listing = h.runtime.refreshCatalog()
  // T3: the OLD listing returns with its stale store-presence `running` —
  // the commit must re-project from the registry and show inactive.
  h.settleList([child({ activity: 'running' })])
  await listing
  assert.equal(h.commits().length, 1)
  assert.equal(subagentActivity(h.commits()[0]!, 'child-a'), 'inactive', 'the commit reads the registry, not the response')
  assert.deepEqual(h.badges()[0], [])
})

test('Case D2: a session switch mid-listing never commits the old catalog', async () => {
  const h = makeHarness()
  h.setStatus('child-a', 'running')
  const listing = h.runtime.refreshCatalog()
  // The user switches sessions while the listing is in flight.
  h.setKey('g2:sess-other')
  h.settleList([child({ activity: 'running' })])
  await listing
  assert.equal(h.commits().length, 0, 'the fenced listing must not commit')
  assert.equal(h.badges().length, 0)
  assert.equal(h.runtime.has('child-a'), false, 'nothing may be cached from the old root')
})

test('the membership gate admits only cached descendants', async () => {
  const h = makeHarness()
  const listing = h.runtime.refreshCatalog()
  h.settleList([
    child({ id: 'child-a' as SessionId, activity: 'running', depth: 1 }),
    child({ id: 'child-b' as SessionId, activity: 'running', parentId: 'child-a' as SessionId, depth: 2 }),
  ])
  await listing
  assert.equal(h.runtime.has('child-a'), true)
  assert.equal(h.runtime.has('child-b'), true)
  assert.equal(h.runtime.has('sess-main'), false, 'the main session is never a descendant')
  assert.equal(h.runtime.has('child-ghost'), false)
})

test('reset() drops the cached catalog and the committed rows', async () => {
  const h = makeHarness()
  const listing = h.runtime.refreshCatalog()
  h.settleList([child({ activity: 'running' })])
  await listing
  assert.equal(h.runtime.has('child-a'), true)
  h.runtime.reset()
  assert.equal(h.runtime.has('child-a'), false)
  assert.deepEqual(h.runtime.rows(), [])
})

test('no live session: neither refresh lists nor commits', async () => {
  const h = makeHarness()
  h.setKey(undefined)
  await h.runtime.refreshCatalog()
  assert.equal(h.listings(), 0, 'no listing without a live root')
  h.runtime.refreshRuntime()
  assert.equal(h.commits().length, 0, 'no commit without a live root')
})

test('every commit re-reads the CURRENT jobs snapshot', async () => {
  const h = makeHarness()
  h.setStatus('child-a', 'running')
  const listing = h.runtime.refreshCatalog()
  h.settleList([child({ activity: 'running' })])
  await listing
  assert.deepEqual(rowValue(h.commits()[0]!), [`${AGENT_ROW_PREFIX}child-a`, 'job:bash-1'])
  // A job settles while the browser stays open: the NEXT commit re-reads
  // the jobs registry (the runner's jobs.onJobsChanged → refreshAgents).
  h.setJobs([])
  h.runtime.refreshRuntime()
  assert.deepEqual(rowValue(h.commits()[1]!), [`${AGENT_ROW_PREFIX}child-a`])
})

test('the preferred cursor is the first running subagent, else the first active job', async () => {
  const h = makeHarness()
  h.setStatus('child-a', 'running')
  h.setStatus('child-b', 'idle')
  const listing = h.runtime.refreshCatalog()
  h.settleList([
    child({ id: 'child-a' as SessionId, activity: 'running', depth: 1 }),
    child({ id: 'child-b' as SessionId, activity: 'running', parentId: 'child-a' as SessionId, depth: 2 }),
  ])
  await listing
  assert.equal(h.preferreds()[0], `${AGENT_ROW_PREFIX}child-a`, 'the first running subagent in tree order')
  // Everything idle: the first active job wins.
  h.setStatus('child-a', 'idle')
  h.runtime.refreshRuntime()
  assert.equal(h.preferreds()[1], 'job:bash-1')
  // Everything idle and no jobs: no preferred cursor.
  h.setJobs([])
  h.runtime.refreshRuntime()
  assert.equal(h.preferreds()[2], undefined)
})
