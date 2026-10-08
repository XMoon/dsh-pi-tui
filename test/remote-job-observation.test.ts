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
  type RemoteJobKillResult,
  type RemoteJobObservationSource,
  type RemoteObservedJobRow,
  type RemoteObservedJobState,
} from '../src/runtime/remote/job-observation-remote.ts'
import type { JobObservedSnapshot } from '../src/runtime/job-observation-port.ts'

interface JobsFixture extends RemoteJobObservationSource {
  readonly watchCalls: string[]
  readonly observeCalls: Array<readonly [string | undefined, string]>
  readonly killCalls: Array<readonly [string, string]>
  readonly rowReleases: string[]
  readonly observeReleases: string[]
  subscriberCount(): number
  setRows(sessionId: string, rows: readonly RemoteObservedJobRow[]): void
  setObserved(jobId: string, state: RemoteObservedJobState | undefined): void
  setKill(result: RemoteJobKillResult): void
  setSyncEmitOnObserve(value: boolean): void
  failWatch(error: unknown): void
  failObserve(error: unknown): void
}

function jobsFixture(): JobsFixture {
  const rows: Record<string, readonly RemoteObservedJobRow[]> = {}
  const observed: Record<string, RemoteObservedJobState | undefined> = {}
  const listeners = new Set<() => void>()
  const watchCalls: string[] = []
  const observeCalls: Array<readonly [string | undefined, string]> = []
  const killCalls: Array<readonly [string, string]> = []
  const rowReleases: string[] = []
  const observeReleases: string[] = []
  let watchError: unknown
  let observeError: unknown
  let syncEmitOnObserve = false
  let killResult: RemoteJobKillResult = { ok: true, value: { outcome: 'requested' } }
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
      // Fault injection: the structural source may fail synchronously in
      // `watchRows`, and the adapter must not leak a partial acquisition.
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
      // A structural source that publishes synchronously on acquisition: the
      // state listener runs re-entrantly while `observe` is still in flight,
      // BEFORE the (optional) acquisition failure.
      if (syncEmitOnObserve) notify()
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
    kill(sessionId, jobId) {
      killCalls.push([sessionId, jobId])
      return Promise.resolve(killResult)
    },
    get killCalls() { return killCalls },
    get rowReleases() { return rowReleases },
    get observeReleases() { return observeReleases },
    subscriberCount: () => listeners.size,
    setKill(result) { killResult = result },
    setSyncEmitOnObserve(value) { syncEmitOnObserve = value },
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

/** One failed official `job.kill` result. */
const killFailure = (error: unknown): RemoteJobKillResult => ({ ok: false, error })

test('stop maps the official kill admission and never mutates observation state', async () => {
  const jobs = jobsFixture()
  jobs.setRows('s1', [row()])
  jobs.setObserved('job-1', observed())
  const port = new RemoteJobObservationPort(jobs)
  const { snapshots } = observe(port, 's1')
  assert.equal(snapshots.length, 1)

  // An independent DEEP copy: a shallow `getSnapshot()` would alias the row
  // arrays and the observed OBJECT, so an in-place mutation would change the
  // "before" too and the comparison could not see it.
  const before = structuredClone(jobs.state.getSnapshot())
  jobs.setKill({ ok: true, value: { outcome: 'requested' } })
  assert.deepEqual(await port.stop('s1', 'job-1'), { kind: 'requested' })
  assert.deepEqual(structuredClone(jobs.state.getSnapshot()), before, 'stop must not rewrite the source roster/observed state')
  jobs.setKill({ ok: true, value: { outcome: 'already-finished' } })
  assert.deepEqual(await port.stop('s1', 'job-1'), { kind: 'already-finished' })
  assert.deepEqual(structuredClone(jobs.state.getSnapshot()), before, 'stop must not rewrite the source roster/observed state')
  assert.deepEqual(jobs.killCalls, [['s1', 'job-1'], ['s1', 'job-1']])

  // No optimistic local mutation: stop emitted no snapshot, and the source
  // still reports the running row.
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0]?.status, 'running')

  // The next authoritative emission still reports the LIVE status: the adapter
  // cached nothing from the stop settlement.
  jobs.setObserved('job-1', observed({ text: 'line one\nline two\n' }))
  assert.equal(snapshots.at(-1)?.status, 'running')
  assert.equal(snapshots.at(-1)?.text, 'line one\nline two\n')
})

test('stop maps job/not-found to not-found and does not retry', async () => {
  const jobs = jobsFixture()
  const port = new RemoteJobObservationPort(jobs)
  jobs.setKill(killFailure({ code: 'job/not-found', message: 'no such job' }))
  assert.deepEqual(await port.stop('s1', 'job-1'), { kind: 'not-found' })
  assert.equal(jobs.killCalls.length, 1, 'a not-found settlement is never replayed')
})

test('stop maps a proven pre-dispatch refusal to rejected and does not retry', async () => {
  for (const error of [
    { code: 'gateway/bad-request', message: 'the gateway rejected the request' },
    { code: 'gateway/arguments-invalid', message: 'the arguments were invalid' },
  ]) {
    const jobs = jobsFixture()
    const port = new RemoteJobObservationPort(jobs)
    jobs.setKill(killFailure(error))
    assert.deepEqual(await port.stop('s1', 'job-1'), { kind: 'rejected', message: error.message })
    assert.equal(jobs.killCalls.length, 1, 'a rejected settlement is never replayed')
  }
})

test('stop keeps every UNPROVEN settlement indeterminate (unknown != proven refusal)', async () => {
  for (const error of [
    { code: 'gateway/internal', message: 'internal' },
    { code: 'gateway/result-invalid', message: 'invalid result' },
    { code: 'gateway/cancelled', message: 'cancelled' },
    { code: 'gateway/some-future-gateway-code', message: 'an unknown gateway code' },
    // The Job operation family's proven vocabulary is only `job/not-found`:
    // a future/unknown Job domain code must NOT be reported as a refusal.
    { code: 'job/some-future-code', message: 'an unknown Job domain code' },
    { code: 'subagent/foreign-domain', message: 'a foreign domain code' },
    new Error('carrier went away'),
  ]) {
    const jobs = jobsFixture()
    const port = new RemoteJobObservationPort(jobs)
    jobs.setKill(killFailure(error))
    const outcome = await port.stop('s1', 'job-1')
    assert.equal(outcome.kind, 'indeterminate', `an unproven settlement must stay indeterminate for ${JSON.stringify(error)}`)
    assert.equal(jobs.killCalls.length, 1, 'an indeterminate settlement is never replayed')
  }
})

test('a late re-release of a closed observer cannot tear down its successor', () => {
  const jobs = jobsFixture()
  jobs.setRows('s1', [row()])
  jobs.setObserved('job-1', observed())
  const port = new RemoteJobObservationPort(jobs)

  const first = observe(port, 's1')
  first.close()
  assert.deepEqual(jobs.rowReleases, ['s1'])
  assert.deepEqual(jobs.observeReleases, ['job-1'])

  // A successor observer for the SAME job id after the first fully released.
  const successor = observe(port, 's1')
  assert.equal(jobs.subscriberCount(), 1, 'the successor owns its own state subscription')
  // The closed observer's closer is invoked again (a late duplicate release):
  // its idempotent guard must leave the successor's leases intact.
  first.close()
  assert.deepEqual(jobs.rowReleases, ['s1'], 'the successor row watch must survive the old release')
  assert.deepEqual(jobs.observeReleases, ['job-1'], 'the successor observation must survive the old release')
  assert.equal(jobs.subscriberCount(), 1)

  // The successor is genuinely live, and only ITS close releases its leases.
  jobs.setObserved('job-1', observed({ text: 'successor\n' }))
  assert.equal(successor.snapshots.at(-1)?.text, 'successor\n')
  successor.close()
  assert.deepEqual(jobs.rowReleases, ['s1', 's1'])
  assert.deepEqual(jobs.observeReleases, ['job-1', 'job-1'])
  assert.equal(jobs.subscriberCount(), 0)
})

test('a source that notifies re-entrantly during acquisition still owns and releases every lease', () => {
  const jobs = jobsFixture()
  jobs.setRows('s1', [row()])
  jobs.setObserved('job-1', observed())
  jobs.setSyncEmitOnObserve(true)
  const port = new RemoteJobObservationPort(jobs)
  const { snapshots, close } = observe(port, 's1')
  // One emission re-enters from inside `observe`, plus the explicit emit after
  // acquisition: both carry the current source state.
  assert.equal(snapshots.length, 2)
  assert.equal(snapshots.at(-1)?.text, 'line one\n')
  close()
  assert.deepEqual(jobs.rowReleases, ['s1'])
  assert.deepEqual(jobs.observeReleases, ['job-1'])
  assert.equal(jobs.subscriberCount(), 0)
  jobs.setObserved('job-1', observed({ text: 'late\n' }))
  assert.equal(snapshots.length, 2, 'a closed observer must not emit after the re-entrant acquisition')
})

test('a re-entrant acquisition failure unwinds every lease acquired before it', () => {
  const jobs = jobsFixture()
  jobs.setRows('s1', [row()])
  jobs.setObserved('job-1', observed())
  jobs.setSyncEmitOnObserve(true)
  jobs.failObserve(new Error('the context is tearing down'))
  const port = new RemoteJobObservationPort(jobs)
  let callbacks = 0
  assert.throws(() => port.open('s1', 'job-1', () => { callbacks += 1 }), /context is tearing down/)
  // The re-entrant emission genuinely ran BEFORE the failure: the listener saw
  // the current snapshot, then the original acquisition error propagated.
  assert.equal(callbacks, 1, 'the synchronous in-acquisition emission must have reached the listener')
  assert.equal(jobs.subscriberCount(), 0, 'the state subscription must not leak through the re-entrant failure')
  assert.deepEqual(jobs.rowReleases, ['s1'], 'the row watch must be released through the re-entrant failure')
  assert.deepEqual(jobs.observeReleases, [], 'no observation lease was acquired')
})
