import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteTaskReadShadow,
  type TaskReadShadowOutcome,
} from '../src/runtime/remote/task-read-shadow.ts'
import { createObservableGenerationHarness } from './support/remote-generation.ts'
import type { TaskReader, TaskReadSnapshot, TaskSubagentEntry } from '../src/runtime/task-read-port.ts'
import { DirectTaskReader } from '../src/runtime/direct/task-read-direct.ts'
import { RemoteTaskReader, type RemoteSubagentCatalogEntry } from '../src/runtime/remote/task-read-remote.ts'

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

function snapshot(overrides: Partial<TaskReadSnapshot> = {}): TaskReadSnapshot {
  return {
    parentSessionId: 'parent',
    parentAvailable: true,
    descendants: [child('child', 'parent', 1, { label: 'Child', activity: 'running' })],
    jobs: [{ id: 'job', kind: 'bash', label: 'Job', status: 'running', startedAt: 1 }],
    ...overrides,
  }
}

function fixedReader(value: TaskReadSnapshot | undefined): TaskReader {
  return { readDescendants: async (_parent, signal) => { signal?.throwIfAborted(); return value } }
}

function reportOf(outcome: TaskReadShadowOutcome) {
  if (outcome.status !== 'compared') throw new Error(`expected compared, got ${outcome.status}`)
  return outcome.report
}

test('compares the full descendant catalog/jobs with an empty skipped list', async () => {
  const generations = createObservableGenerationHarness()
  const value = snapshot()
  const shadow = new RemoteTaskReadShadow(fixedReader(value), fixedReader(structuredClone(value)), generations.source)

  const report = reportOf(await shadow.compare({ parentSessionId: 'parent' }))
  assert.equal(report.generation, '1')
  assert.equal(report.comparable, true)
  assert.deepEqual(report.mismatches, [])
  assert.deepEqual(report.skipped, [])
  assert.equal(Object.isFrozen(report.skipped), true)
  shadow.dispose()
})

test('reports semantic descendant/job fields and projected task-row differences', async () => {
  const generations = createObservableGenerationHarness()
  const direct = snapshot({
    descendants: [
      child('child', 'parent', 1, { label: 'Child', activity: 'running' }),
      { kind: 'diagnostic', id: 'diag', reason: 'unavailable', parentId: 'parent', depth: 1 },
    ],
  })
  const remote = snapshot({
    parentAvailable: false,
    descendants: [
      child('child', 'other-parent', 3, { label: 'Remote Child', mode: 'one-shot', activity: 'inactive', hasChildren: true }),
      { kind: 'diagnostic', id: 'diag', reason: 'corrupt', parentId: 'other-parent', depth: 3 },
    ],
    jobs: [{ id: 'job', kind: 'python', label: 'Remote Job', status: 'failed', detail: 'boom', startedAt: 2, finishedAt: 3 }],
  })
  const shadow = new RemoteTaskReadShadow(fixedReader(direct), fixedReader(remote), generations.source)

  const report = reportOf(await shadow.compare({ parentSessionId: 'parent' }))
  assert.equal(report.comparable, false)
  assert.deepEqual(report.mismatches.map(mismatch => mismatch.field), [
    'parentAvailable',
    'child.label',
    'child.mode',
    'child.activity',
    'child.hasChildren',
    'child.parentId',
    'child.depth',
    'diagnostic.reason',
    'diagnostic.parentId',
    'diagnostic.depth',
    'job.kind',
    'job.label',
    'job.status',
    'job.detail',
    'job.startedAt',
    'job.finishedAt',
    'task.rows',
  ])
  shadow.dispose()
})

test('reports descendant id/order differences before per-entry fields', async () => {
  const generations = createObservableGenerationHarness()
  const direct = snapshot({
    descendants: [
      child('child-a', 'parent', 1),
      child('child-b', 'parent', 1),
    ],
  })
  const reordered = snapshot({
    descendants: [
      child('child-b', 'parent', 1),
      child('child-a', 'parent', 1),
    ],
  })
  const orderShadow = new RemoteTaskReadShadow(fixedReader(direct), fixedReader(reordered), generations.source)
  const orderReport = reportOf(await orderShadow.compare({ parentSessionId: 'parent' }))
  assert.equal(orderReport.mismatches[0]?.field, 'descendants.order')
  orderShadow.dispose()

  const extra = snapshot({
    descendants: [
      child('child-a', 'parent', 1),
      child('child-b', 'parent', 1),
      child('child-c', 'parent', 1),
    ],
  })
  const idsShadow = new RemoteTaskReadShadow(fixedReader(direct), fixedReader(extra), generations.source)
  const idsReport = reportOf(await idsShadow.compare({ parentSessionId: 'parent' }))
  assert.equal(idsReport.mismatches[0]?.field, 'descendants.ids')
  idsShadow.dispose()
})

test('bounds large Task parity diagnostics', async () => {
  const generations = createObservableGenerationHarness()
  const jobs = Array.from({ length: 300 }, (_, index) => ({
    id: `job-${index}`,
    kind: 'bash',
    label: 'x'.repeat(600),
    status: 'running',
    startedAt: index,
  }))
  const remoteJobs = jobs.map(job => ({ ...job, status: 'failed' }))
  remoteJobs.push({ id: 'extra', kind: 'bash', label: 'extra', status: 'running', startedAt: 0 })
  const shadow = new RemoteTaskReadShadow(
    fixedReader(snapshot({ jobs })),
    fixedReader(snapshot({ jobs: remoteJobs })),
    generations.source,
  )

  const report = reportOf(await shadow.compare({ parentSessionId: 'parent' }))
  assert.equal(report.mismatches.length, 256)
  assert.equal(report.mismatches[0]?.field, 'jobs.ids')
  assert.equal((report.mismatches[0]?.expected as { total?: number }).total, 300)
  assert.equal((report.mismatches[0]?.actual as { total?: number }).total, 301)
  assert.ok(JSON.stringify(report).length < 100_000)
  shadow.dispose()
})

test('returns disconnected without invoking either reader', async () => {
  const generations = createObservableGenerationHarness()
  generations.set(undefined)
  let reads = 0
  const reader: TaskReader = { readDescendants: async () => { reads += 1; return snapshot() } }
  const shadow = new RemoteTaskReadShadow(reader, reader, generations.source)
  assert.deepEqual(await shadow.compare({ parentSessionId: 'parent' }), { status: 'unavailable', reason: 'disconnected' })
  assert.equal(reads, 0)
  shadow.dispose()
})

test('discards stale generation success and stale failure', async () => {
  const generations = createObservableGenerationHarness()
  let releaseSuccess!: () => void
  const successGate = new Promise<void>(resolve => { releaseSuccess = resolve })
  const delayedSuccess: TaskReader = {
    readDescendants: async () => {
      await successGate
      return snapshot()
    },
  }
  const successShadow = new RemoteTaskReadShadow(delayedSuccess, delayedSuccess, generations.source)
  const success = successShadow.compare({ parentSessionId: 'parent' })
  generations.set({ id: 2 })
  releaseSuccess()
  assert.deepEqual(await success, { status: 'discarded', generation: '1', reason: 'stale-generation' })
  successShadow.dispose()

  let releaseFailure!: () => void
  const failureGate = new Promise<void>(resolve => { releaseFailure = resolve })
  const delayedFailure: TaskReader = {
    readDescendants: async () => {
      await failureGate
      throw new Error('late old-generation failure')
    },
  }
  const failureShadow = new RemoteTaskReadShadow(delayedFailure, delayedFailure, generations.source)
  const failure = failureShadow.compare({ parentSessionId: 'parent' })
  generations.set({ id: 3 })
  releaseFailure()
  assert.deepEqual(await failure, { status: 'discarded', generation: '2', reason: 'stale-generation' })
  failureShadow.dispose()
})

test('newer compare supersedes older and caller abort is cancelled', async () => {
  const generations = createObservableGenerationHarness()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const reader: TaskReader = {
    readDescendants: async (_parent, signal) => {
      calls += 1
      if (calls <= 2) {
        await gate
        signal?.throwIfAborted()
      }
      return snapshot()
    },
  }
  const shadow = new RemoteTaskReadShadow(reader, reader, generations.source)
  const old = shadow.compare({ parentSessionId: 'parent' })
  const next = shadow.compare({ parentSessionId: 'parent' })
  release()
  assert.deepEqual(await old, { status: 'discarded', generation: '1', reason: 'superseded' })
  assert.equal((await next).status, 'compared')
  shadow.dispose()

  let abortRelease!: () => void
  const abortGate = new Promise<void>(resolve => { abortRelease = resolve })
  const aborting: TaskReader = {
    readDescendants: async (_parent, signal) => {
      await abortGate
      signal?.throwIfAborted()
      return snapshot()
    },
  }
  const secondShadow = new RemoteTaskReadShadow(aborting, aborting, generations.source)
  const controller = new AbortController()
  const cancelled = secondShadow.compare({ parentSessionId: 'parent', signal: controller.signal })
  controller.abort()
  abortRelease()
  assert.deepEqual(await cancelled, { status: 'cancelled', generation: '1' })
  secondShadow.dispose()
})

test('aborts the sibling read when a current provider fails', async () => {
  const generations = createObservableGenerationHarness()
  const failure = new Error('direct read failed')
  let siblingAborted = false
  const failing: TaskReader = {
    readDescendants: async () => { throw failure },
  }
  const sibling: TaskReader = {
    readDescendants: async (_parent, signal) => await new Promise<TaskReadSnapshot | undefined>(resolve => {
      if (signal === undefined) throw new Error('shadow did not provide an operation signal')
      if (signal.aborted) {
        siblingAborted = true
        resolve(undefined)
        return
      }
      signal.addEventListener('abort', () => {
        siblingAborted = true
        resolve(undefined)
      }, { once: true })
    }),
  }
  const shadow = new RemoteTaskReadShadow(failing, sibling, generations.source)
  const outcome = await shadow.compare({ parentSessionId: 'parent' })
  assert.equal(outcome.status, 'error')
  if (outcome.status === 'error') assert.equal(outcome.error, failure)
  assert.equal(siblingAborted, true)
  shadow.dispose()
})

test('dispose discards an in-flight comparison', async () => {
  const generations = createObservableGenerationHarness()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reader: TaskReader = {
    readDescendants: async (_parent, signal) => {
      await gate
      signal?.throwIfAborted()
      return snapshot()
    },
  }
  const shadow = new RemoteTaskReadShadow(reader, reader, generations.source)
  const pending = shadow.compare({ parentSessionId: 'parent' })
  shadow.dispose()
  release()
  assert.deepEqual(await pending, { status: 'discarded', generation: '1', reason: 'disposed' })
})

// L4 scope note: these comparisons cover the REPRESENTABLE / common diagnostic
// semantics (child mode/activity/parent/depth/order, `unsupported`, branch
// survival, job roster). `corrupt` reason fidelity is NOT representable on the
// rc.2 Remote wire — the carrier collapses it into `gateway/internal` — so a
// same-shape `corrupt` comparison here is a DTO-level check of the adapter's
// semantic mapping, never a claim of real Direct↔Remote wire parity.
test('L4 representable-diagnostic parity: the Direct adapter and the Remote adapter produce the same snapshot through the shadow', async () => {
  const generations = createObservableGenerationHarness()
  const direct = new DirectTaskReader({
    agentFor: id => id === 'parent' || id === 'child-a' ? { status: 'running' } : undefined,
    subagents: {
      async listDescendants() {
        return [
          child('child-a', 'parent', 1, { label: 'A', activity: 'running', hasChildren: true }),
          child('gc', 'child-a', 2, { label: 'GC' }),
          child('child-b', 'parent', 1, { label: 'B', mode: 'one-shot' }),
        ]
      },
    },
    jobs: { list: () => [{ id: 'j1', kind: 'bash', label: 'job j1', status: 'running', startedAt: 10, detail: 'fixture' }] },
  })
  const remote = new RemoteTaskReader(
    {
      list: {
        getSnapshot: () => ({
          byId: {
            parent: { running: false },
            'child-a': { running: true },
            gc: { running: false },
            'child-b': { running: false },
          },
          projectionsBySession: {
            parent: { values: { subagentCatalog: [catalogEntry('child-a', 'continuable', 'A'), catalogEntry('child-b', 'one-shot', 'B')] }, state: 'ready', error: null },
            'child-a': { values: { subagentCatalog: [catalogEntry('gc', 'continuable', 'GC')] }, state: 'ready', error: null },
            'child-b': { values: { subagentCatalog: [] }, state: 'ready', error: null },
            gc: { values: { subagentCatalog: [] }, state: 'ready', error: null },
          },
        }),
      },
      async refreshProjections() {},
    },
    { state: { getSnapshot: () => ({ rows: { parent: [jobView('j1')] } }) }, watchRows: () => () => {} },
    generations.source,
  )
  const shadow = new RemoteTaskReadShadow(direct, remote, generations.source)
  const report = reportOf(await shadow.compare({ parentSessionId: 'parent' }))
  assert.equal(report.comparable, true)
  assert.deepEqual(report.mismatches, [])
  shadow.dispose()
})

test('L4 representable-diagnostic parity: an unknown-mode child is the SAME unsupported diagnostic on both backends', async () => {
  const generations = createObservableGenerationHarness()
  // Direct reports `unsupported` through the official listDescendants
  // diagnostic vocabulary; the Remote adapter derives it from the parent
  // catalog's `unknown` mode after reading (and still traversing) the child's
  // own catalog.
  const direct = new DirectTaskReader({
    agentFor: id => id === 'parent' ? { status: 'running' } : undefined,
    subagents: {
      async listDescendants() {
        return [
          { kind: 'diagnostic', id: 'child-u', reason: 'unsupported', parentId: 'parent', depth: 1 },
          child('child-ok', 'parent', 1, { label: 'OK' }),
        ]
      },
    },
    jobs: { list: () => [] },
  })
  const remote = new RemoteTaskReader(
    {
      list: {
        getSnapshot: () => ({
          byId: { parent: { running: false }, 'child-u': { running: false }, 'child-ok': { running: false } },
          projectionsBySession: {
            parent: {
              values: { subagentCatalog: [catalogEntry('child-u', 'unknown', 'U'), catalogEntry('child-ok', 'continuable', 'OK')] },
              state: 'ready',
              error: null,
            },
            'child-u': { values: { subagentCatalog: [] }, state: 'ready', error: null },
            'child-ok': { values: { subagentCatalog: [] }, state: 'ready', error: null },
          },
        }),
      },
      async refreshProjections() {},
    },
    { state: { getSnapshot: () => ({ rows: {} }) }, watchRows: () => () => {} },
    generations.source,
  )
  const shadow = new RemoteTaskReadShadow(direct, remote, generations.source)
  const report = reportOf(await shadow.compare({ parentSessionId: 'parent' }))
  assert.equal(report.comparable, true)
  assert.deepEqual(report.mismatches, [])
  assert.deepEqual(report.skipped, [], 'the descendant-tree gap stayed closed for the diagnostic case too')
  shadow.dispose()
})

function catalogEntry(
  id: string,
  mode: RemoteSubagentCatalogEntry['mode'],
  label: string,
): RemoteSubagentCatalogEntry {
  return { id, createdAt: 10, mode, label }
}

function jobView(id: string) {
  return { id, kind: 'bash', label: `job ${id}`, status: 'running', startedAt: 10, detail: 'fixture' }
}
