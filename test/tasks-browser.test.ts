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
  isViewerAccessInteractive,
  resolveViewerAccess,
  rowGroup,
  taskRowLabel,
  taskTreePrefix,
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
