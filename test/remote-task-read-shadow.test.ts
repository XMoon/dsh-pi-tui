import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteTaskReadShadow,
  type TaskReadShadowOutcome,
} from '../src/runtime/remote/task-read-shadow.ts'
import type { RemoteConnectionGeneration, RemoteConnectionGenerationSource } from '../src/runtime/remote/session-reader-remote.ts'
import type { TaskReader, TaskReadSnapshot } from '../src/runtime/task-read-port.ts'

interface GenerationHarness {
  readonly source: RemoteConnectionGenerationSource
  set(value: RemoteConnectionGeneration | undefined): void
}

function generationHarness(): GenerationHarness {
  let current: RemoteConnectionGeneration | undefined = { id: 1 }
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => current,
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(value) {
      current = value
      for (const listener of [...listeners]) listener()
    },
  }
}

function snapshot(overrides: Partial<TaskReadSnapshot> = {}): TaskReadSnapshot {
  return {
    parentSessionId: 'parent',
    parentAvailable: true,
    children: [{ kind: 'child', id: 'child', label: 'Child', mode: 'continuable', activity: 'running', hasChildren: false }],
    jobs: [{ id: 'job', kind: 'bash', label: 'Job', status: 'running', startedAt: 1 }],
    ...overrides,
  }
}

function fixedReader(value: TaskReadSnapshot | undefined): TaskReader {
  return { readDirectChildren: async (_parent, signal) => { signal?.throwIfAborted(); return value } }
}

function reportOf(outcome: TaskReadShadowOutcome) {
  if (outcome.status !== 'compared') throw new Error(`expected compared, got ${outcome.status}`)
  return outcome.report
}

test('compares task catalog/jobs and records the explicit descendant-tree upstream gap', async () => {
  const generations = generationHarness()
  const value = snapshot()
  const shadow = new RemoteTaskReadShadow(fixedReader(value), fixedReader(structuredClone(value)), generations.source)

  const report = reportOf(await shadow.compare({ parentSessionId: 'parent' }))
  assert.equal(report.generation, '1')
  assert.equal(report.comparable, true)
  assert.deepEqual(report.mismatches, [])
  assert.deepEqual(report.skipped.map(field => field.field), ['subagent.descendantTree'])
  shadow.dispose()
})

test('reports semantic child/job fields and projected task-row differences', async () => {
  const generations = generationHarness()
  const direct = snapshot()
  const remote = snapshot({
    parentAvailable: false,
    children: [{ kind: 'child', id: 'child', label: 'Remote Child', mode: 'one-shot', activity: 'inactive', hasChildren: true }],
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

test('bounds large Task parity diagnostics', async () => {
  const generations = generationHarness()
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
  const generations = generationHarness()
  generations.set(undefined)
  let reads = 0
  const reader: TaskReader = { readDirectChildren: async () => { reads += 1; return snapshot() } }
  const shadow = new RemoteTaskReadShadow(reader, reader, generations.source)
  assert.deepEqual(await shadow.compare({ parentSessionId: 'parent' }), { status: 'unavailable', reason: 'disconnected' })
  assert.equal(reads, 0)
  shadow.dispose()
})

test('discards stale generation success and stale failure', async () => {
  const generations = generationHarness()
  let releaseSuccess!: () => void
  const successGate = new Promise<void>(resolve => { releaseSuccess = resolve })
  const delayedSuccess: TaskReader = {
    readDirectChildren: async () => {
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
    readDirectChildren: async () => {
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
  const generations = generationHarness()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const reader: TaskReader = {
    readDirectChildren: async (_parent, signal) => {
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
    readDirectChildren: async (_parent, signal) => {
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
  const generations = generationHarness()
  const failure = new Error('direct read failed')
  let siblingAborted = false
  const failing: TaskReader = {
    readDirectChildren: async () => { throw failure },
  }
  const sibling: TaskReader = {
    readDirectChildren: async (_parent, signal) => await new Promise<TaskReadSnapshot | undefined>(resolve => {
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
  const generations = generationHarness()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reader: TaskReader = {
    readDirectChildren: async (_parent, signal) => {
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
