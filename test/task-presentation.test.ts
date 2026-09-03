import assert from 'node:assert/strict'
import test from 'node:test'
import { projectTaskItems, type TaskPresentationProjectionOptions } from '../src/task-presentation.ts'
import type { TaskPanelItem } from '../src/task-panel.ts'

const options = (patch: Partial<TaskPresentationProjectionOptions> = {}): TaskPresentationProjectionOptions => ({
  scope: 'all', query: '', typeFilter: null, expandedIds: new Set(), collapsedIds: new Set(), ...patch,
})

const rows: TaskPanelItem[] = [
  { value: 'agent:a', label: 'a', status: 'inactive', active: false, source: 'subagent', type: 'subagent', parentId: undefined, depth: 1, hasChildren: true },
  { value: 'agent:a1', label: 'a1', status: 'completed', active: false, source: 'subagent', type: 'subagent', parentId: 'agent:a', depth: 2 },
  { value: 'agent:a2', label: 'a2', status: 'running', active: true, source: 'subagent', type: 'subagent', parentId: 'agent:a', depth: 2 },
  { value: 'job:b', label: 'b', status: 'running', active: true, source: 'job', type: 'bash', parentId: undefined, depth: 0 },
]

test('active projection closes ancestors without reordering durable preorder', () => {
  const projection = projectTaskItems(rows, options({ scope: 'active' }))
  assert.deepEqual(projection.rows.map(row => row.value), ['agent:a', 'agent:a2', 'job:b'])
  assert.equal(projection.rows[0]!.ancestorContext, true)
  assert.equal(projection.rows[1]!.ancestorContext, false)
})

test('scope and type filters stay orthogonal', () => {
  const projection = projectTaskItems(rows, options({ scope: 'all', typeFilter: 'bash' }))
  assert.deepEqual(projection.rows.map(row => row.value), ['job:b'])
  const activeSubagents = projectTaskItems(rows, options({ scope: 'active', typeFilter: 'subagent' }))
  assert.deepEqual(activeSubagents.rows.map(row => row.value), ['agent:a', 'agent:a2'])
})

test('settled branches collapse by default and connectors follow projected siblings', () => {
  const settled = rows.map(row => row.value === 'agent:a2' ? { ...row, status: 'completed', active: false } : row)
  const collapsed = projectTaskItems(settled, options())
  assert.deepEqual(collapsed.rows.map(row => row.value), ['agent:a', 'job:b'])
  const expanded = projectTaskItems(settled, options({ expandedIds: new Set(['agent:a']) }))
  assert.deepEqual(expanded.rows.map(row => row.value), ['agent:a', 'agent:a1', 'agent:a2', 'job:b'])
  assert.match(expanded.rows[1]!.treePrefix ?? '', /├─/)
  assert.match(expanded.rows[2]!.treePrefix ?? '', /└─/)
})

test('query auto-expands matching descendants and keeps their lineage', () => {
  const projection = projectTaskItems(rows, options({ query: 'a2' }))
  assert.deepEqual(projection.rows.map(row => row.value), ['agent:a', 'agent:a2'])
  assert.equal(projection.rows[0]!.ancestorContext, true)
})

test('Quick can surface an attention row when no work is active', () => {
  const failed = rows.map(row => row.value === 'agent:a2' || row.value === 'job:b'
    ? { ...row, status: 'failed', active: false, attention: true }
    : row)
  const projection = projectTaskItems(failed, options({ scope: 'active', includeAttentionInActive: true }))
  assert.deepEqual(projection.rows.map(row => row.value), ['agent:a', 'agent:a2', 'job:b'])
})
