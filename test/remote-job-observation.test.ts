/**
 * Remote Job observation adapter tests (Pre-M3 PR2): the official Client
 * `IJobs` state is projected onto {@link JobObservedSnapshot} without building
 * a second follow/cursor state machine, and the reference-counted leases are
 * acquired and released exactly once per observer.
 * @module @xmoon76/dsh-pi-tui/remote-job-observation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteJobObservationPort,
  type RemoteJobObservationSource,
  type RemoteObservedJobRow,
  type RemoteObservedJobState,
} from '../src/runtime/remote/job-observation-remote.ts'
import type { JobObservedSnapshot } from '../src/runtime/job-observation-port.ts'

interface JobsFixture extends RemoteJobObservationSource {
  readonly watchCalls: string[]
  readonly observeCalls: Array<readonly [string | undefined, string]>
  readonly rowReleases: string[]
  readonly observeReleases: string[]
  subscriberCount(): number
  setRows(sessionId: string, rows: readonly RemoteObservedJobRow[]): void
  setObserved(jobId: string, state: RemoteObservedJobState | undefined): void
  failWatch(error: unknown): void
  failObserve(error: unknown): void
}

function jobsFixture(): JobsFixture {
  const rows: Record<string, readonly RemoteObservedJobRow[]> = {}
  const observed: Record<string, RemoteObservedJobState | undefined> = {}
  const listeners = new Set<() => void>()
  const watchCalls: string[] = []
  const observeCalls: Array<readonly [string | undefined, string]> = []
  const rowReleases: string[] = []
  const observeReleases: string[] = []
  let watchError: unknown
  let observeError: unknown
  const notify = (): void => { for (const listener of [...listeners]) listener() }
  return {
    state: {
      getSnapshot: () => ({ rows: { ...rows }, observed: { ...observed } }),
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    watchRows(sessionId) {
      watchCalls.push(sessionId)
      // The official ClientJobs creates the roster stream inside the first
      // acquire, which can throw synchronously while the connection tears down.
      if (watchError !== undefined) throw watchError
      let released = false
      return () => {
        if (released) return
        released = true
        rowReleases.push(sessionId)
      }
    },
    observe(sessionId, jobId) {
      observeCalls.push([sessionId, jobId])
      if (observeError !== undefined) throw observeError
      let released = false
      return () => {
        if (released) return
        released = true
        observeReleases.push(jobId)
      }
    },
    get watchCalls() { return watchCalls },
    get observeCalls() { return observeCalls },
    get rowReleases() { return rowReleases },
    get observeReleases() { return observeReleases },
    subscriberCount: () => listeners.size,
    failWatch(error) { watchError = error },
    failObserve(error) { observeError = error },
    setRows(sessionId, value) {
      if (value.length === 0) delete rows[sessionId]
      else rows[sessionId] = value
      notify()
    },
    setObserved(jobId, value) {
      if (value === undefined) delete observed[jobId]
      else observed[jobId] = value
      notify()
    },
  }
}

const row = (overrides: Partial<RemoteObservedJobRow> = {}): RemoteObservedJobRow => ({
  id: 'job-1',
  kind: 'bash',
  label: 'Run the thing',
  status: 'running',
  ...overrides,
})

const observed = (overrides: Partial<RemoteObservedJobState> = {}): RemoteObservedJobState => ({
  jobId: 'job-1',
  text: 'line one\n',
  gapBefore: false,
  streaming: true,
  ...overrides,
})

/** Open one observer and return its recorded snapshots plus the closer. */
function observe(
  port: RemoteJobObservationPort,
  sessionId: string | undefined,
  jobId = 'job-1',
): { readonly snapshots: JobObservedSnapshot[]; readonly close: () => void } {
  const snapshots: JobObservedSnapshot[] = []
  const close = port.open(sessionId, jobId, snapshot => snapshots.push(snapshot))
  return { snapshots, close }
}

test('open acquires one row watch and one observation and emits the current state immediately', () => {
  const jobs = jobsFixture()
  jobs.setRows('s1', [row()])
  jobs.setObserved('job-1', observed())
  const { snapshots } = observe(new RemoteJobObservationPort(jobs), 's1')
  assert.deepEqual(jobs.watchCalls, ['s1'])
  assert.deepEqual(jobs.observeCalls, [['s1', 'job-1']])
  assert.equal(snapshots.length, 1)
  assert.deepEqual(snapshots[0], {
    jobId: 'job-1',
    kind: 'bash',
    label: 'Run the thing',
    status: 'running',
    text: 'line one\n',
    gapBefore: false,
    settled: false,
  })
})

test('an unowned job acquires no roster watch', () => {
  const jobs = jobsFixture()
  const port = new RemoteJobObservationPort(jobs)
  const { snapshots } = observe(port, undefined)
  assert.deepEqual(jobs.watchCalls, [])
  assert.deepEqual(jobs.observeCalls, [[undefined, 'job-1']])
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0]?.kind, '')
  assert.equal(snapshots[0]?.status, 'running')
})

test('output updates re-emit the official bounded tail, preserving gapBefore', () => {
  const jobs = jobsFixture()
  jobs.setRows('s1', [row()])
  jobs.setObserved('job-1', observed())
  const { snapshots } = observe(new RemoteJobObservationPort(jobs), 's1')
  jobs.setObserved('job-1', observed({ text: 'line one\nline two\n', gapBefore: true }))
  assert.equal(snapshots.length, 2)
  assert.equal(snapshots[1]?.text, 'line one\nline two\n')
  assert.equal(snapshots[1]?.gapBefore, true)
  assert.equal(snapshots[1]?.settled, false)
})

test('a terminal observation settles, and a failed one reports the error WITHOUT settling', () => {
  const jobs = jobsFixture()
  jobs.setRows('s1', [row({ status: 'completed' })])
  jobs.setObserved('job-1', observed({ streaming: false, text: 'done\n' }))
  const { snapshots } = observe(new RemoteJobObservationPort(jobs), 's1')
  assert.equal(snapshots[0]?.settled, true)
  assert.equal(snapshots[0]?.error, undefined)

  const failed = jobsFixture()
  failed.setRows('s1', [row({ status: 'failed' })])
  failed.setObserved('job-1', observed({ streaming: false, error: 'stream reset' }))
  const failing = observe(new RemoteJobObservationPort(failed), 's1')
  assert.equal(failing.snapshots[0]?.settled, false, 'an observation failure is not a settlement')
  assert.equal(failing.snapshots[0]?.error, 'stream reset')
})

test('row metadata updates are reflected, and a roster that drops the row keeps the last metadata', () => {
  const jobs = jobsFixture()
  jobs.setRows('s1', [row()])
  jobs.setObserved('job-1', observed())
  const { snapshots } = observe(new RemoteJobObservationPort(jobs), 's1')
  jobs.setRows('s1', [row({ status: 'failed', progress: undefined, detail: 'exit code: 3' })])
  assert.equal(snapshots[1]?.status, 'failed')
  assert.equal(snapshots[1]?.detail, 'exit code: 3')
  // The roster drops the job (a session switch or stream gap): the viewer keeps
  // the last authoritative metadata instead of blanking the header.
  jobs.setRows('s1', [])
  assert.equal(snapshots.at(-1)?.status, 'failed')
  assert.equal(snapshots.at(-1)?.label, 'Run the thing')
  assert.equal(snapshots.at(-1)?.kind, 'bash')
  // A fresh authoritative row wins over the remembered one.
  jobs.setRows('s1', [row({ status: 'killed' })])
  assert.equal(snapshots.at(-1)?.status, 'killed')
})

test('close releases both leases exactly once and stops later emissions', () => {
  const jobs = jobsFixture()
  jobs.setRows('s1', [row()])
  jobs.setObserved('job-1', observed())
  const { snapshots, close } = observe(new RemoteJobObservationPort(jobs), 's1')
  close()
  close()
  assert.deepEqual(jobs.rowReleases, ['s1'])
  assert.deepEqual(jobs.observeReleases, ['job-1'])
  assert.equal(jobs.subscriberCount(), 0)
  jobs.setObserved('job-1', observed({ text: 'late\n' }))
  jobs.setRows('s1', [row({ status: 'completed' })])
  assert.equal(snapshots.length, 1, 'a closed observer must not emit again')
})

test('two observers share nothing: each acquires and releases its own leases', () => {
  const jobs = jobsFixture()
  jobs.setRows('s1', [row()])
  jobs.setObserved('job-1', observed())
  const port = new RemoteJobObservationPort(jobs)
  const first = observe(port, 's1')
  const second = observe(port, 's1')
  assert.deepEqual(jobs.watchCalls, ['s1', 's1'])
  assert.deepEqual(jobs.observeCalls, [['s1', 'job-1'], ['s1', 'job-1']])
  first.close()
  assert.deepEqual(jobs.rowReleases, ['s1'])
  assert.deepEqual(jobs.observeReleases, ['job-1'])
  // The surviving observer still sees updates.
  jobs.setObserved('job-1', observed({ text: 'still live\n' }))
  assert.equal(second.snapshots.at(-1)?.text, 'still live\n')
  second.close()
  assert.deepEqual(jobs.rowReleases, ['s1', 's1'])
  assert.deepEqual(jobs.observeReleases, ['job-1', 'job-1'])
})

test('a synchronous roster acquisition failure rolls back the state subscription already acquired', () => {
  const jobs = jobsFixture()
  jobs.failWatch(new Error('the connection is going away'))
  const port = new RemoteJobObservationPort(jobs)
  assert.throws(() => port.open('s1', 'job-1', () => {}), /connection is going away/)
  assert.equal(jobs.subscriberCount(), 0, 'the state subscription must not leak when a later acquisition throws')
  assert.deepEqual(jobs.rowReleases, [], 'no row watch was acquired')
  // The adapter stays usable: once the transport recovers, a later open
  // acquires everything afresh.
  jobs.failWatch(undefined)
  const { snapshots, close } = observe(port, 's1')
  assert.equal(jobs.subscriberCount(), 1)
  assert.equal(snapshots.length, 1)
  close()
  assert.equal(jobs.subscriberCount(), 0)
})

test('a synchronous observation acquisition failure rolls back the row watch and the state subscription', () => {
  const jobs = jobsFixture()
  jobs.failObserve(new Error('the context is tearing down'))
  const port = new RemoteJobObservationPort(jobs)
  assert.throws(() => port.open('s1', 'job-1', () => {}), /context is tearing down/)
  assert.equal(jobs.subscriberCount(), 0, 'the state subscription must not leak')
  assert.deepEqual(jobs.rowReleases, ['s1'], 'the row watch must be released when the observation acquisition fails')
  assert.deepEqual(jobs.observeReleases, [], 'no observation lease was acquired')
})
