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

/** A harness with a DEFERRED listDescendants (each catalog request gets
 * its own deferred; the test settles or rejects them in any order), a
 * mutable registry-status map, and commit/badge journals. */
function makeHarness(): {
  runtime: TaskBrowserRuntime
  listings(): number
  commits(): readonly TaskBrowserRow[][]
  preferreds(): readonly (string | undefined)[]
  badges(): readonly ReadonlyArray<{ id: string; label: string }>[]
  setKey(key: string | undefined): void
  setStatus(id: string, status: string | undefined): void
  setJobs(jobs: readonly TaskBrowserJobInput[]): void
  /** Resolve the listing of the i-th refreshCatalog call (0-based). */
  settleListing(index: number, entries: readonly SubagentDescendantListEntry[]): void
  /** Reject the listing of the i-th refreshCatalog call (0-based). */
  rejectListing(index: number, error: Error): void
} {
  let key: string | undefined = 'g1:sess-main'
  const statuses = new Map<string, string>()
  let jobs: TaskBrowserJobInput[] = [job()]
  let listingCount = 0
  const pendingSettles: ((entries: readonly SubagentDescendantListEntry[]) => void)[] = []
  const pendingRejects: ((error: Error) => void)[] = []
  const commits: TaskBrowserRow[][] = []
  const preferreds: (string | undefined)[] = []
  const badges: ReadonlyArray<{ id: string; label: string }>[] = []
  const runtime = new TaskBrowserRuntime({
    currentKey: () => key,
    listDescendants: () => {
      listingCount += 1
      return new Promise((resolve, reject) => {
        pendingSettles.push(resolve)
        pendingRejects.push(reject)
      })
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
    settleListing: (index, entries) => { pendingSettles[index]?.(entries) },
    rejectListing: (index, error) => { pendingRejects[index]?.(error) },
  }
}

test('Case A: a running continuable child turns inactive on agent idle without re-listing', async () => {
  const h = makeHarness()
  h.setStatus('child-a', 'running')
  const listing = h.runtime.refreshCatalog()
  h.settleListing(0, [child({ activity: 'running' })])
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
  h.settleListing(0, [child({ activity: 'running' })])
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
  h.settleListing(0, catalog)
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
  h.settleListing(0, [child({ activity: 'running' })])
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
  h.settleListing(0, [child({ activity: 'running' })])
  await listing
  assert.equal(h.commits().length, 0, 'the fenced listing must not commit')
  assert.equal(h.badges().length, 0)
  assert.equal(h.runtime.has('child-a'), false, 'nothing may be cached from the old root')
})

test('the membership gate admits only cached descendants', async () => {
  const h = makeHarness()
  const listing = h.runtime.refreshCatalog()
  h.settleListing(0, [
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
  h.settleListing(0, [child({ activity: 'running' })])
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
  h.settleListing(0, [child({ activity: 'running' })])
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
  h.settleListing(0, [
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

test('Case D3: overlapping catalog refreshes commit in REQUEST order (epoch supersede)', async () => {
  // The initial badge refresh and an open-browser refresh can be in
  // flight together; the NEWER request must stay authoritative even when
  // its listing settles FIRST and the older one settles later (review
  // round 1, P1): an older response must never overwrite newer
  // membership/tree state.
  const h = makeHarness()
  h.setStatus('child-new', 'running')
  const initial = h.runtime.refreshCatalog()
  const openRefresh = h.runtime.refreshCatalog()
  // The OPEN refresh (request 2) settles first with the NEWER
  // membership: child-new exists.
  h.settleListing(1, [child({ id: 'child-new' as SessionId, activity: 'running', depth: 1 })])
  await openRefresh
  assert.equal(h.commits().length, 1)
  assert.equal(h.runtime.has('child-new'), true)
  assert.deepEqual(rowValue(h.commits()[0]!), [`${AGENT_ROW_PREFIX}child-new`, 'job:bash-1'])
  // The INITIAL refresh (older request) settles LAST with a STALE
  // membership that never saw child-new: it must neither commit nor
  // overwrite the cache (without the epoch, the stale response would
  // drop the child from the open browser and gate out its agent/status).
  h.settleListing(0, [child({ id: 'child-old' as SessionId, activity: 'running', depth: 1 })])
  await initial
  assert.equal(h.commits().length, 1, 'the superseded listing must not commit')
  assert.equal(h.runtime.has('child-new'), true, 'the cache must keep the newer membership')
  assert.equal(h.runtime.has('child-old'), false, 'the stale membership must never land')
})

test('Case D4: a FAILED newer request must not invalidate a valid older response', async () => {
  // "Latest successfully committed wins", never "latest requested wins"
  // (PR review P2): a newer listing that REJECTS (e.g. a persistence
  // read failure on open) must not discard an older in-flight request
  // whose response is valid — the badge/browser would otherwise stay
  // empty/stale until the next catalog event.
  const h = makeHarness()
  h.setStatus('child-a', 'running')
  const older = h.runtime.refreshCatalog()
  const newer = h.runtime.refreshCatalog()
  // The newer (open-browser) listing fails first.
  h.rejectListing(1, new Error('persistence read failed'))
  await assert.rejects(newer)
  // The older listing still succeeds with a valid catalog: it must
  // commit (its epoch is not below the committed fence).
  h.settleListing(0, [child({ activity: 'running' })])
  await older
  assert.equal(h.commits().length, 1, 'the older success must still commit after a newer failure')
  assert.equal(h.runtime.has('child-a'), true)
  assert.deepEqual(h.badges()[0]!.map(entry => entry.id), ['child-a'])
})

test('a failure never advances the committed fence for LATER requests', async () => {
  const h = makeHarness()
  h.setStatus('child-a', 'running')
  const first = h.runtime.refreshCatalog()
  const failing = h.runtime.refreshCatalog()
  h.rejectListing(1, new Error('boom'))
  await assert.rejects(failing)
  // The first request commits (committed fence = its epoch).
  h.settleListing(0, [child({ activity: 'running' })])
  await first
  assert.equal(h.runtime.has('child-a'), true)
  // A LATER request after the failure still commits normally.
  const later = h.runtime.refreshCatalog()
  h.settleListing(2, [child({ id: 'child-later' as SessionId, activity: 'running', depth: 1 })])
  await later
  assert.equal(h.runtime.has('child-later'), true)
  assert.equal(h.commits().length, 2)
})

test('reset() also supersedes a listing still in flight', async () => {
  const h = makeHarness()
  const listing = h.runtime.refreshCatalog()
  h.runtime.reset()
  h.settleListing(0, [child({ activity: 'running' })])
  await listing
  assert.equal(h.commits().length, 0, 'a post-reset listing must not commit')
  assert.equal(h.runtime.has('child-a'), false)
})

test('the open-browser FIRST FRAME reuses the cached catalog and survives a failed fresh listing (PR review P3)', async () => {
  // The runner seeds the first frame with refreshRuntime() (the cached
  // catalog + current jobs + registry statuses — synchronous, no
  // persistence) BEFORE the async membership refresh starts. The seeded
  // frame must match the badge, and a FAILED fresh listing must never
  // leave the panel contradicting the badge (both keep the cached
  // membership).
  const h = makeHarness()
  h.setStatus('child-a', 'running')
  const listing = h.runtime.refreshCatalog()
  h.settleListing(0, [child({ activity: 'running' })])
  await listing
  assert.equal(h.runtime.has('child-a'), true)
  // Simulate the open: seed the first frame from the cache.
  h.runtime.refreshRuntime()
  const seed = h.runtime.rows()
  assert.deepEqual(rowValue(seed), [`${AGENT_ROW_PREFIX}child-a`, 'job:bash-1'],
    'the first frame must carry the cached subagent, not a jobs-only flash')
  assert.equal(subagentActivity(seed, 'child-a'), 'running')
  // The fresh listing the open triggers FAILS: the seeded frame (and the
  // badge) must stay intact — no commit, cache untouched.
  const fresh = h.runtime.refreshCatalog()
  h.rejectListing(1, new Error('persistence read failed'))
  await assert.rejects(fresh)
  assert.equal(h.commits().length, 2, 'the failed listing must not commit')
  assert.equal(h.runtime.has('child-a'), true, 'the cache keeps the child after the failure')
  assert.deepEqual(rowValue(h.runtime.rows()), [`${AGENT_ROW_PREFIX}child-a`, 'job:bash-1'])
  assert.deepEqual(h.badges()[0]!.map(entry => entry.id), ['child-a'])
})

// ── production wiring lock (review round 1, P2) ───────────────────────────
// The coordinator tests alone would pass even if the runner never wired
// `agent/status` (or wired it to the catalog refresh). The runner cannot
// be booted headlessly, so the WIRING ITSELF is locked by a source audit
// (the rules.test.ts precedent): the listener must exist, must be
// membership-gated, must route to the RUNTIME-only refresh (never a
// re-listing), and a session bump must close the open browser and reset
// the coordinator.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const indexSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'),
  'utf8',
)

test('the runner wires agent/status to the membership-gated RUNTIME-only refresh', () => {
  assert.ok(indexSource.includes("ctx.on('agent/status', ({ agent, status }) => {"),
    'the runner must register the agent/status listener')
  assert.ok(indexSource.includes('if (taskRuntime?.has(agent.id) !== true) return'),
    'the listener must be membership-gated (main-agent flips must never repaint)')
  // The handler must route to the runtime-only refresh — a re-listing
  // here would defeat the whole split (and the membership gate).
  const marker = "ctx.on('agent/status', ({ agent, status }) => {"
  const handler = indexSource.slice(indexSource.indexOf(marker), indexSource.indexOf(marker) + 500)
  assert.ok(handler.includes('refreshAgentRuntimeOnly()'),
    'agent/status must refresh RUNTIME only, never refreshAgents()')
  assert.ok(!handler.includes('refreshAgents()'),
    'agent/status must never trigger a catalog re-listing')
  // The MAIN agent's transitions route to the completion-notification
  // controller (the settled boundary) BEFORE the child membership gate —
  // children still never repaint and never notify.
  assert.ok(handler.includes('completionController.onAgentStatus(agent.id, status)'),
    'the main agent\'s status must feed the completion controller')
})

test('a session switch closes the open task browser, CLEARS the badge synchronously and resets the runtime coordinator', () => {
  const bump = indexSource.slice(
    indexSource.indexOf('const bumpSessionGeneration'),
    indexSource.indexOf('const jumpToSearchMatch'),
  )
  assert.ok(bump.includes('activeTaskBrowser?.close()'), 'the session bump must close the open browser')
  assert.ok(bump.includes('taskRuntime?.reset()'), 'the session bump must drop the cached catalog')
  // PR review P2: the OLD session's running badge must not hang on the
  // footer until the new session's async listing lands (a failed listing
  // must never leave a stale badge either) — the bump clears it
  // SYNCHRONOUSLY.
  assert.ok(bump.includes('app.setAgents([])'), 'the session bump must clear the badge synchronously')
  assert.ok(bump.includes('taskBrowserRows = []'), 'the session bump must clear the row identity source')
})

test('openTasksBrowser seeds the FIRST FRAME from the cached runtime and gates interrupt execution with the SAME predicate (PR review P3)', () => {
  const open = indexSource.slice(
    indexSource.indexOf('const openTasksBrowser'),
    indexSource.indexOf('// M3: attach the extension host'),
  )
  // The first frame must be seeded from the coordinator's CURRENT state
  // (cached catalog + current jobs + registry statuses), never a
  // jobs-only flash that could contradict the badge until the async
  // listing lands — or after it fails.
  assert.ok(open.includes('runtime.refreshRuntime()'),
    'the open must seed the first frame from the cached runtime')
  const seedStart = open.indexOf('const runtime = taskRuntime')
  const seedBlock = open.slice(seedStart, seedStart + 220)
  assert.ok(seedBlock.includes('buildTaskRows(jobSnapshots, [])'),
    'the jobs-only fallback must apply only without the runtime')
  // The interrupt EXECUTION gate must be the SAME predicate as the
  // panel's advertisement gate — a panel change can never release an
  // idle/one-shot interrupt.
  assert.ok(open.includes('!isSubagentRowInterruptible(row)'),
    'the interrupt execution gate must use isSubagentRowInterruptible')
  assert.ok(!open.replace(/\/\/.*$/gm, '').includes("row.mode !== 'continuable'"),
    'the interrupt execution gate must not drift back to a mode-only check')
})
