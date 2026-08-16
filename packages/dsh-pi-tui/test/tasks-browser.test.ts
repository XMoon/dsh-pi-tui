/**
 * Unit tests for the merged task-browser row model. The browser is the
 * union of the jobs registry (status-only rows) and the subagent registry
 * (viewable rows): continuable children always, one-shot children while
 * running; finished one-shot children stay out.
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
  rowGroup,
  taskRowLabel,
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

test('continuable children map to viewable rows; running one-shot children join them', () => {
  const rows = buildTaskRows([], [
    agent({ id: 'child-a', activity: 'inactive' }),
    agent({ id: 'child-b' }),
    // A RUNNING one-shot child (the parent's pending foreground tool
    // call) IS a browser row: it has no job record and its transcript is
    // viewable while it works.
    agent({ id: 'child-c', mode: 'one-shot', activity: 'running' }),
    // A finished one-shot child is not: its surface is /subagents.
    agent({ id: 'child-d', mode: 'one-shot', activity: 'inactive' }),
  ])
  assert.deepEqual(kinds(rows), ['subagent', 'subagent', 'subagent'])
  const [first, second, third] = rows as Extract<TaskBrowserRow, { kind: 'subagent' }>[]
  // Registry order is preserved (running first, then inactive — the caller
  // passes listChildren's createdAt order).
  assert.equal(first.childId, 'child-b')
  assert.equal(first.activity, 'running')
  assert.equal(first.value, `${AGENT_ROW_PREFIX}child-b`)
  assert.equal(taskRowLabel(first), 'subagent · research')
  assert.equal(rowGroup(first), SUBAGENT_GROUP)
  assert.equal(describeTaskRow(first, 5_000), 'running')
  assert.equal(second.childId, 'child-c')
  assert.equal(second.activity, 'running')
  assert.equal(taskRowLabel(second), 'subagent · research')
  assert.equal(third.childId, 'child-a')
  assert.equal(describeTaskRow(third, 5_000), 'inactive')
})

test('one-shot children without a label fall back to the child id', () => {
  const rows = buildTaskRows([], [
    { kind: 'child', id: 'child-nolabel', mode: 'one-shot', activity: 'running', hasChildren: false },
  ])
  assert.equal(rows.length, 1)
  assert.equal(taskRowLabel(rows[0]!), 'subagent · child-nolabel')
})

test('diagnostic children never become rows', () => {
  const rows = buildTaskRows([], [
    { kind: 'diagnostic', id: 'child-x', reason: 'corrupt' },
  ])
  assert.deepEqual(rows, [])
})

test('ordering: running children, then inactive children, then active jobs, then terminal jobs', () => {
  const rows = buildTaskRows([
    job({ id: 'bash-old', status: 'completed', finishedAt: 900 }),
    job({ id: 'bash-live', startedAt: 100 }),
    job({ id: 'subagent-1', kind: 'subagent', label: 'delegate', status: 'failed', detail: 'max-tokens', startedAt: 500, finishedAt: 800 }),
    job({ id: 'bash-new', startedAt: 300 }),
  ], [
    agent({ id: 'child-idle', activity: 'inactive' }),
    agent({ id: 'child-busy' }),
  ])
  assert.deepEqual(rows.map(row => row.value), [
    `${AGENT_ROW_PREFIX}child-busy`,
    `${AGENT_ROW_PREFIX}child-idle`,
    `${JOB_ROW_PREFIX}bash-live`,
    `${JOB_ROW_PREFIX}bash-new`,
    `${JOB_ROW_PREFIX}bash-old`,
    `${JOB_ROW_PREFIX}subagent-1`,
  ])
  // Terminal jobs sort newest-finish first (kimi ordering).
  const terminal = rows.filter(row => row.kind === 'job' && row.status !== 'running')
  assert.deepEqual(terminal.map(row => row.value), [`${JOB_ROW_PREFIX}bash-old`, `${JOB_ROW_PREFIX}subagent-1`])
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

test('subagent job rows stay status-only with their kind label', () => {
  const rows = buildTaskRows([job({ id: 'subagent-2', kind: 'subagent', label: 'audit', status: 'running' })], [])
  const row = rows[0]
  assert.equal(taskRowLabel(row), 'subagent · audit')
  assert.equal(describeTaskRow(row, 10_000), 'running · 9s')
})
