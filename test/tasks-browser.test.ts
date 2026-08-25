/**
 * Unit tests for the merged task-browser row model. The browser is the
 * union of the jobs registry (status-only rows) and the subagent registry
 * (viewable rows): the durable descendant tree in stable pre-order, with
 * every healthy child — continuable AND one-shot, running AND inactive —
 * as a viewable row (a settled one-shot's persisted transcript stays
 * reachable, plan §6.4).
 * @module @xmoon76/dsh-pi-tui/tasks-browser.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_ROW_PREFIX,
  JOB_GROUP,
  JOB_ROW_PREFIX,
  SUBAGENT_GROUP,
  buildTaskRows,
  describeTaskRow,
  isSubagentRowInterruptible,
  isViewerAccessInteractive,
  projectSubagentActivity,
  resolveViewerAccess,
  rowGroup,
  subagentInterruptParent,
  taskRowLabel,
  taskTreePrefix,
  viewerAccessHint,
  viewerAccessOf,
  type TaskBrowserAgentInput,
  type TaskBrowserJobInput,
  type TaskBrowserRow,
} from '../src/tasks-browser.ts'

const job = (overrides: Partial<TaskBrowserJobInput> = {}): TaskBrowserJobInput => ({
  id: 'bash-1',
  kind: 'bash',
  label: 'pnpm build',
  status: 'running',
  startedAt: 1_000,
  ...overrides,
})

const agent = (overrides: Partial<TaskBrowserAgentInput> = {}): TaskBrowserAgentInput => ({
  kind: 'child',
  id: 'child-abc',
  label: 'research',
  mode: 'continuable',
  activity: 'running',
  hasChildren: false,
  ...overrides,
})

const kinds = (rows: TaskBrowserRow[]): string[] => rows.map(row => row.kind)

test('jobs map to status-only rows with prefixed picker values', () => {
  const rows = buildTaskRows([job()], [])
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.kind, 'job')
  assert.equal(row.value, `${JOB_ROW_PREFIX}bash-1`)
  assert.equal(taskRowLabel(row), 'bash · pnpm build')
  assert.equal(rowGroup(row), JOB_GROUP)
  assert.equal(describeTaskRow(row, 3_000), 'running · 2s')
})

test('every healthy child maps to a viewable row — settled one-shots stay reachable', () => {
  const rows = buildTaskRows([], [
    agent({ id: 'child-a', activity: 'inactive' }),
    agent({ id: 'child-b' }),
    // A RUNNING one-shot child (the parent's pending foreground tool
    // call) IS a browser row: it has no job record and its transcript is
    // viewable while it works.
    agent({ id: 'child-c', mode: 'one-shot', activity: 'running' }),
    // A FINISHED one-shot child stays a row too (plan §6.4): `activity`
    // is live-store presence, never an outcome — its persisted transcript
    // is still viewable from the browser.
    agent({ id: 'child-d', mode: 'one-shot', activity: 'inactive' }),
  ])
  assert.deepEqual(kinds(rows), ['subagent', 'subagent', 'subagent', 'subagent'])
  const [first, second, third, fourth] = rows as Extract<TaskBrowserRow, { kind: 'subagent' }>[]
  // The catalog's pre-order is preserved VERBATIM (plan §6.5) — no
  // running-first re-sort (the caller passes listDescendants' order).
  assert.equal(first.childId, 'child-a')
  assert.equal(first.activity, 'inactive')
  assert.equal(first.mode, 'continuable')
  assert.equal(first.value, `${AGENT_ROW_PREFIX}child-a`)
  // The label carries the catalog MODE — never inferred from activity.
  assert.equal(taskRowLabel(first), 'subagent · research · continuable')
  assert.equal(rowGroup(first), SUBAGENT_GROUP)
  assert.equal(describeTaskRow(first, 5_000), 'inactive')
  assert.equal(second.childId, 'child-b')
  assert.equal(second.activity, 'running')
  assert.equal(second.mode, 'continuable')
  assert.equal(taskRowLabel(second), 'subagent · research · continuable')
  assert.equal(third.childId, 'child-c')
  assert.equal(third.activity, 'running')
  assert.equal(third.mode, 'one-shot')
  assert.equal(taskRowLabel(third), 'subagent · research · one-shot')
  assert.equal(fourth.childId, 'child-d')
  assert.equal(fourth.activity, 'inactive')
  assert.equal(fourth.mode, 'one-shot')
  assert.equal(taskRowLabel(fourth), 'subagent · research · one-shot')
  assert.equal(describeTaskRow(fourth, 5_000), 'inactive')
})

test('mode and activity are independent dimensions on every subagent row', () => {
  const rows = buildTaskRows([], [
    // Running continuable, inactive continuable, running one-shot: each
    // combination keeps BOTH facts — neither may be inferred from the
    // other.
    agent({ id: 'child-run-cont', mode: 'continuable', activity: 'running' }),
    agent({ id: 'child-idle-cont', mode: 'continuable', activity: 'inactive' }),
    agent({ id: 'child-run-one', mode: 'one-shot', activity: 'running' }),
  ])
  const subagentRows = rows as Extract<TaskBrowserRow, { kind: 'subagent' }>[]
  assert.deepEqual(subagentRows.map(row => `${row.mode}/${row.activity}`), [
    'continuable/running',
    'continuable/inactive',
    'one-shot/running',
  ])
})

test('subagent rows keep the descendant PRE-ORDER verbatim — no running re-sort', () => {
  // plan §6.5: a running grandchild must NEVER jump above its inactive
  // parent. The catalog order IS the tree.
  const rows = buildTaskRows([], [
    agent({ id: 'parent', activity: 'inactive', hasChildren: true }),
    agent({ id: 'grandchild', mode: 'one-shot', activity: 'running', depth: 2 }),
    agent({ id: 'second-parent', activity: 'running' }),
    agent({ id: 'second-child', activity: 'inactive', depth: 2 }),
  ])
  assert.deepEqual(rows.map(row => row.value), [
    `${AGENT_ROW_PREFIX}parent`,
    `${AGENT_ROW_PREFIX}grandchild`,
    `${AGENT_ROW_PREFIX}second-parent`,
    `${AGENT_ROW_PREFIX}second-child`,
  ])
})

test('parentId/depth ride the row from the catalog facts', () => {
  const rows = buildTaskRows([], [
    agent({ id: 'child-a', parentId: 'session-main', depth: 1 }),
    agent({ id: 'child-b', parentId: 'session-child-a', depth: 2 }),
  ])
  const subagentRows = rows as Extract<TaskBrowserRow, { kind: 'subagent' }>[]
  assert.equal(subagentRows[0]!.parentId, 'session-main')
  assert.equal(subagentRows[0]!.depth, 1)
  assert.equal(subagentRows[1]!.parentId, 'session-child-a')
  assert.equal(subagentRows[1]!.depth, 2)
  // Direct children without an explicit parent fall back to the root.
  const direct = buildTaskRows([], [agent({ id: 'child-x' })])[0] as Extract<TaskBrowserRow, { kind: 'subagent' }>
  assert.equal(direct.parentId, '')
  assert.equal(direct.depth, 1)
})

test('tree prefixes indent by depth and stay fixed layout regions', () => {
  assert.equal(taskTreePrefix(1), '├─ ')
  assert.equal(taskTreePrefix(2), '  ├─ ')
  assert.equal(taskTreePrefix(3), '    ├─ ')
  assert.equal(taskTreePrefix(0), '├─ ')
})

test('viewer access classifies by mode AND depth, never activity', () => {
  const subagent = (overrides: Partial<Extract<TaskBrowserRow, { kind: 'subagent' }>> = {}): Extract<TaskBrowserRow, { kind: 'subagent' }> => ({
    kind: 'subagent',
    value: 'agent:child-abc',
    childId: 'child-abc',
    label: 'research',
    mode: 'continuable',
    activity: 'inactive',
    hasChildren: false,
    parentId: '',
    depth: 1,
    ...overrides,
  })
  // Depth 1 continuable: interactive.
  assert.equal(viewerAccessOf(subagent()), 'interactive-direct-child')
  assert.equal(isViewerAccessInteractive(viewerAccessOf(subagent())), true)
  // One-shot → read-only regardless of depth.
  assert.equal(viewerAccessOf(subagent({ mode: 'one-shot' })), 'readonly-one-shot')
  // Nested continuable → read-only (the mode stays continuable).
  assert.equal(viewerAccessOf(subagent({ depth: 2 })), 'readonly-nested')
  assert.equal(isViewerAccessInteractive(viewerAccessOf(subagent({ depth: 2 }))), false)
  assert.equal(viewerAccessOf(subagent({ depth: 2, mode: 'one-shot' })), 'readonly-nested')
})

test('resolveViewerAccess derives the default from mode and honors explicit access', () => {
  assert.equal(resolveViewerAccess('continuable', undefined), 'interactive-direct-child')
  assert.equal(resolveViewerAccess('one-shot', undefined), 'readonly-one-shot')
  assert.equal(resolveViewerAccess('continuable', 'readonly-nested'), 'readonly-nested')
})

test('viewerAccessHint renders the REAL mode beside the nested authority (review P2)', () => {
  // Mode is the durable semantic, access the surface authority — the hint
  // must show BOTH: a nested one-shot child is NOT continuable just
  // because it is nested.
  assert.equal(viewerAccessHint('continuable', 'readonly-nested'), 'continuable · nested · read-only from this parent')
  assert.equal(viewerAccessHint('one-shot', 'readonly-nested'), 'one-shot · nested · read-only from this parent')
  assert.equal(viewerAccessHint('continuable', 'interactive-direct-child'), 'continuable · interactive')
  assert.equal(viewerAccessHint('one-shot', 'readonly-one-shot'), 'one-shot · read-only')
})

test('a catalog entry with a MISSING mode is never treated as a healthy child', () => {
  // The catalog contract always classifies a child, but a structurally
  // mode-less entry must not silently degrade into an interactive row
  // (it can neither default to continuable nor be guessed from activity).
  const rows = buildTaskRows([], [
    { kind: 'child', id: 'child-nomode', label: 'mystery', activity: 'running', hasChildren: false },
  ])
  assert.deepEqual(rows, [], 'a mode-less child stays out of the browser')
})

test('one-shot children without a label fall back to the child id', () => {
  const rows = buildTaskRows([], [
    { kind: 'child', id: 'child-nolabel', mode: 'one-shot', activity: 'running', hasChildren: false },
  ])
  assert.equal(rows.length, 1)
  assert.equal(taskRowLabel(rows[0]!), 'subagent · child-nolabel · one-shot')
})

test('diagnostic children never become rows', () => {
  const rows = buildTaskRows([], [
    { kind: 'diagnostic', id: 'child-x', reason: 'corrupt' },
  ])
  assert.deepEqual(rows, [])
})

test('ordering: subagent tree pre-order verbatim, then active jobs, then terminal jobs', () => {
  const rows = buildTaskRows([
    job({ id: 'bash-old', status: 'completed', finishedAt: 900 }),
    job({ id: 'bash-live', startedAt: 100 }),
    job({ id: 'subagent-1', kind: 'subagent', label: 'delegate', status: 'failed', detail: 'max-tokens', startedAt: 500, finishedAt: 800 }),
    job({ id: 'bash-new', startedAt: 300 }),
  ], [
    agent({ id: 'child-idle', activity: 'inactive' }),
    agent({ id: 'child-busy' }),
  ])
  // The subagent tree keeps its catalog pre-order (plan §6.5) — activity
  // never re-sorts it; jobs form their own flat group after it.
  assert.deepEqual(rows.map(row => row.value), [
    `${AGENT_ROW_PREFIX}child-idle`,
    `${AGENT_ROW_PREFIX}child-busy`,
    `${JOB_ROW_PREFIX}bash-live`,
    `${JOB_ROW_PREFIX}bash-new`,
    `${JOB_ROW_PREFIX}bash-old`,
    `${JOB_ROW_PREFIX}subagent-1`,
  ])
  // Terminal jobs sort newest-finish first (kimi ordering).
  const terminal = rows.filter(row => row.kind === 'job' && row.status !== 'running')
  assert.deepEqual(terminal.map(row => row.value), [`${JOB_ROW_PREFIX}bash-old`, `${JOB_ROW_PREFIX}subagent-1`])
})

test('a background one-shot appears as BOTH a job row and a child row (no guess-dedup)', () => {
  // plan §2.2: the job record and the child record share no identity, so
  // the duplication is contract — a test locks it so nobody "fixes" it by
  // label/order guessing later.
  const rows = buildTaskRows([
    job({ id: 'job-1', kind: 'subagent', label: 'delegate', status: 'running' }),
  ], [
    { kind: 'child', id: 'session-delegate', mode: 'one-shot', activity: 'running', hasChildren: false },
  ])
  assert.deepEqual(kinds(rows), ['subagent', 'job'])
  assert.equal((rows[0] as Extract<TaskBrowserRow, { kind: 'subagent' }>).childId, 'session-delegate')
  assert.equal((rows[1] as Extract<TaskBrowserRow, { kind: 'job' }>).jobId, 'job-1')
})

test('stopping jobs count as active and sort by registration order', () => {
  const rows = buildTaskRows([
    job({ id: 'bash-a', status: 'stopping', startedAt: 200 }),
    job({ id: 'bash-b', status: 'running', startedAt: 100 }),
  ], [])
  assert.deepEqual(rows.map(row => row.value), [`${JOB_ROW_PREFIX}bash-b`, `${JOB_ROW_PREFIX}bash-a`])
})

test('empty inputs produce an empty browser', () => {
  assert.deepEqual(buildTaskRows([], []), [])
})

test('subagent job rows stay status-only with their kind label and the one-shot mode', () => {
  const rows = buildTaskRows([job({ id: 'subagent-2', kind: 'subagent', label: 'audit', status: 'running' })], [])
  const row = rows[0]
  // The jobs registry's `subagent` kind IS the reliable contract for a
  // background one-shot delegation (continuable children never register
  // jobs), so the label carries `one-shot` — but the row stays status-only.
  assert.equal(taskRowLabel(row), 'subagent job · audit · one-shot')
  assert.equal(describeTaskRow(row, 10_000), 'running · 9s')
  // Any other job kind keeps its own semantics — no fabricated mode.
  const bash = buildTaskRows([job({ id: 'bash-3', kind: 'bash', label: 'build' })], [])[0]!
  assert.equal(taskRowLabel(bash), 'bash · build')
})

test('interrupt authority names the DURABLE direct parent, never the root (review P1)', () => {
  // main └─ A └─ B: interrupting B must carry parent=A (DSH contract:
  // `{ kind: 'user', parentSessionId }` is the exact direct parent; the
  // main session id would be rejected as unauthorized for a deep
  // descendant).
  const subagent = (overrides: Partial<Extract<TaskBrowserRow, { kind: 'subagent' }>> = {}): Extract<TaskBrowserRow, { kind: 'subagent' }> => ({
    kind: 'subagent',
    value: 'agent:child-abc',
    childId: 'child-abc',
    label: 'research',
    mode: 'continuable',
    activity: 'running',
    hasChildren: false,
    parentId: '',
    depth: 1,
    ...overrides,
  })
  // A nested descendant carries its durable parent.
  assert.equal(subagentInterruptParent(subagent({ parentId: 'session-A', depth: 2 }), 'session-main'), 'session-A')
  // A direct child falls back to the browser root (the live main session).
  assert.equal(subagentInterruptParent(subagent({ parentId: '', depth: 1 }), 'session-main'), 'session-main')
  // The root is NEVER used for a nested row, whatever the depth.
  assert.equal(subagentInterruptParent(subagent({ parentId: 'session-A', depth: 3 }), 'session-main'), 'session-A')
})

// ── `has children` display removal (the tree connector already expresses
// parenthood — the DATA fact stays for future fold/disclosure work) ───────

test('a parent row never renders "has children" while the data fact survives', () => {
  const rows = buildTaskRows([], [
    agent({ id: 'parent', activity: 'inactive', hasChildren: true }),
    agent({ id: 'child', mode: 'one-shot', activity: 'running', hasChildren: false, depth: 2 }),
  ])
  const parent = rows[0] as Extract<TaskBrowserRow, { kind: 'subagent' }>
  // The DATA fact stays a row field…
  assert.equal(parent.hasChildren, true)
  assert.equal(parent.depth, 1)
  // …but neither the description nor the label render the text.
  assert.equal(describeTaskRow(parent, 5_000), 'inactive')
  assert.ok(!describeTaskRow(parent, 5_000).includes('has children'))
  assert.ok(!taskRowLabel(parent).includes('has children'))
  // A nested row keeps its depth description (unchanged).
  const child = rows[1] as Extract<TaskBrowserRow, { kind: 'subagent' }>
  assert.equal(describeTaskRow(child, 5_000), 'running · depth 2')
  assert.ok(!describeTaskRow(child, 5_000).includes('has children'))
})

// ── runtime activity projection (plan §7.3: the Agent registry decides,
// never the catalog's store-presence activity) ─────────────────────────────

test('projectSubagentActivity overwrites child activity from the Agent registry at commit time', () => {
  // The core repro: an idle continuable child whose session is still
  // live in the store (catalog `activity: 'running'`) must project
  // INACTIVE — the registry says its driver is idle.
  const entries = [
    agent({ id: 'child-idle', activity: 'running' }),
    agent({ id: 'child-cold', activity: 'inactive' }),
    agent({ id: 'child-one', mode: 'one-shot', activity: 'inactive' }),
  ]
  const projected = projectSubagentActivity(entries, (id) =>
    id === 'child-idle' ? 'idle' : 'running')
  // TaskBrowserAgentInput is a single object type (kind is a union), so
  // the child facts are read through a structural pick.
  const child = (entry: TaskBrowserAgentInput): string =>
    (entry as TaskBrowserAgentInput & { activity: 'running' | 'inactive' }).activity
  assert.equal(child(projected[0]!), 'inactive')
  assert.equal(child(projected[1]!), 'running')
  assert.equal(child(projected[2]!), 'running')
})

test('projectSubagentActivity never touches catalog facts or the pre-order', () => {
  const entries: TaskBrowserAgentInput[] = [
    agent({ id: 'parent', activity: 'inactive', hasChildren: true, parentId: 'root', depth: 1 }),
    agent({ id: 'grand', mode: 'one-shot', activity: 'inactive', hasChildren: false, parentId: 'parent', depth: 2 }),
    { kind: 'diagnostic', id: 'child-x', reason: 'corrupt' },
  ]
  const projected = projectSubagentActivity(entries, () => 'running')
  assert.deepEqual(projected.map(entry => entry.id), ['parent', 'grand', 'child-x'])
  type ChildEntry = TaskBrowserAgentInput & { kind: 'child' }
  const parent = projected[0] as ChildEntry
  const grand = projected[1] as ChildEntry
  assert.equal(parent.parentId, 'root')
  assert.equal(parent.depth, 1)
  assert.equal(parent.hasChildren, true)
  assert.equal(parent.activity, 'running')
  assert.equal(grand.parentId, 'parent')
  assert.equal(grand.depth, 2)
  assert.equal(grand.mode, 'one-shot')
  // Diagnostic rows pass through unchanged (never projected).
  assert.deepEqual(projected[2], { kind: 'diagnostic', id: 'child-x', reason: 'corrupt' })
})

test('projectSubagentActivity: an absent registry agent reads inactive (disposed/cold)', () => {
  const projected = projectSubagentActivity([agent({ id: 'child-a', activity: 'running' })], () => undefined)
  const child = projected[0] as TaskBrowserAgentInput & { kind: 'child' }
  assert.equal(child.activity, 'inactive')
})

// ── interrupt authority (plan §I: only a continuable row with a LIVE
// running driver may advertise/fire the stop verb) ─────────────────────────

test('only a running continuable subagent is interruptible (plan §I)', () => {
  const subagent = (overrides: Partial<Extract<TaskBrowserRow, { kind: 'subagent' }>> = {}): Extract<TaskBrowserRow, { kind: 'subagent' }> => ({
    kind: 'subagent',
    value: 'agent:child-abc',
    childId: 'child-abc',
    label: 'research',
    mode: 'continuable',
    activity: 'running',
    hasChildren: false,
    parentId: '',
    depth: 1,
    ...overrides,
  })
  // Running continuable: interruptible.
  assert.equal(isSubagentRowInterruptible(subagent()), true)
  // Idle continuable: no driver to stop — NOT interruptible (the UI must
  // not advertise a dead stop verb).
  assert.equal(isSubagentRowInterruptible(subagent({ activity: 'inactive' })), false)
  // One-shot: never interruptible, running or not.
  assert.equal(isSubagentRowInterruptible(subagent({ mode: 'one-shot', activity: 'running' })), false)
  assert.equal(isSubagentRowInterruptible(subagent({ mode: 'one-shot', activity: 'inactive' })), false)
  // Nested continuable rows follow the same rule (depth is orthogonal).
  assert.equal(isSubagentRowInterruptible(subagent({ depth: 2, activity: 'running' })), true)
  assert.equal(isSubagentRowInterruptible(subagent({ depth: 2, activity: 'inactive' })), false)
})
