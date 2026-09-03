import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TaskBrowserRuntime, type TaskBrowserSummary } from '../src/task-browser-runtime.ts'

const entry = { kind: 'child' as const, id: 'child-1' as SessionId, label: 'child', mode: 'continuable' as const, activity: 'running' as const, hasChildren: false, depth: 1, parentId: '' as SessionId }

test('runtime commits independent totals and clears acknowledged failure attention', async () => {
  let jobs = [{ id: 'j1', kind: 'bash', label: 'failed', status: 'failed', startedAt: 1 }]
  const summaries: TaskBrowserSummary[] = []
  const runtime = new TaskBrowserRuntime({
    currentKey: () => 'session',
    listDescendants: async () => [entry],
    readJobs: () => jobs,
    agentStatusOf: () => 'running',
    commitRows: () => {},
    commitBadge: () => {},
    commitSummary: summary => summaries.push(summary),
  })
  await runtime.refreshCatalog()
  assert.deepEqual(summaries.at(-1), {
    runningAgents: 1,
    totalAgents: 1,
    runningJobs: 0,
    totalJobs: 1,
    failedAttention: 1,
    failedTotal: 1,
  })
  runtime.acknowledge(['job:j1'])
  assert.equal(summaries.at(-1)!.failedAttention, 0)
  jobs = []
  runtime.refreshRuntime()
  assert.equal(summaries.at(-1)!.totalJobs, 0)
})
