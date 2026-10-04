/**
 * Direct ↔ Remote selected-Job semantic parity (L4): both backends expose the
 * SAME detached {@link JobObservedSnapshot} and the SAME
 * {@link JobStopOutcome} for equivalent backend situations, so the surface can
 * consume either without a second feature semantic.
 *
 * The two adapters are driven over equivalent fixtures (a Direct
 * `JobController.follow` frame sequence and the official Client `IJobs`
 * snapshot state) and their owned fields are compared directly.
 *
 * @module @xmoon76/dsh-pi-tui/job-observation-parity.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectJobObservationPort } from '../src/runtime/direct/job-observation-direct.ts'
import {
  RemoteJobObservationPort,
  type RemoteJobKillResult,
  type RemoteJobObservationSource,
  type RemoteObservedJobRow,
  type RemoteObservedJobState,
} from '../src/runtime/remote/job-observation-remote.ts'
import type { JobObservedSnapshot, JobStopOutcome } from '../src/runtime/job-observation-port.ts'
import { createDiag } from '../src/diag.ts'

const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })

async function flush(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** The fields both adapters own, directly comparable across backends. */
function shape(snapshot: JobObservedSnapshot): JobObservedSnapshot {
  return {
    jobId: snapshot.jobId,
    kind: snapshot.kind,
    label: snapshot.label,
    status: snapshot.status,
    ...snapshot.progress === undefined ? {} : { progress: snapshot.progress },
    ...snapshot.detail === undefined ? {} : { detail: snapshot.detail },
    text: snapshot.text,
    gapBefore: snapshot.gapBefore,
    settled: snapshot.settled,
    ...snapshot.error === undefined ? {} : { error: snapshot.error },
  }
}

type JobFrame = {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly progress?: string
  readonly detail?: string
  readonly output: { readonly earliest: number; readonly total: number }
}

type Frame =
  | { readonly type: 'opened'; readonly job: JobFrame; readonly from: number }
  | { readonly type: 'output'; readonly chunks: readonly { text: string; gapBefore?: true }[]; readonly next: number; readonly lossy?: true }
  | { readonly type: 'status'; readonly job: JobFrame }

const jobFrame = (overrides: Partial<JobFrame> = {}): JobFrame => ({
  id: 'job-1',
  kind: 'bash',
  label: 'build',
  status: 'running',
  output: { earliest: 0, total: 0 },
  ...overrides,
})

/** Drive a Direct observer over a frame sequence and return every snapshot. */
async function directSnapshots(frames: readonly Frame[], reject?: Error): Promise<readonly JobObservedSnapshot[]> {
  const host = {
    get: (name: string) => name === 'jobController'
      ? {
          follow: (_request: unknown, signal: AbortSignal) => (async function* () {
            for (const frame of frames) {
              if (signal.aborted) return
              yield frame
              await Promise.resolve()
            }
            if (reject !== undefined) throw reject
          })(),
        }
      : undefined,
  }
  const port = new DirectJobObservationPort(host, diag)
  const seen: JobObservedSnapshot[] = []
  const close = port.open('s1', 'job-1', snapshot => seen.push(snapshot))
  await flush()
  close()
  assert.ok(seen.length > 0, 'the Direct observer must emit at least one snapshot')
  return seen
}

/** The last snapshot at one status (a stream's intermediate stage). */
function lastWithStatus(list: readonly JobObservedSnapshot[], status: string): JobObservedSnapshot | undefined {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]!.status === status) return list[index]
  }
  return undefined
}

/** A minimal official Client `IJobs`-shaped source (state + kill). */
function remoteJobs(options: {
  row?: RemoteObservedJobRow
  observed?: RemoteObservedJobState
  kill?: RemoteJobKillResult
} = {}): RemoteJobObservationSource {
  const rows: Record<string, readonly RemoteObservedJobRow[]> = {}
  const observed: Record<string, RemoteObservedJobState | undefined> = {}
  if (options.row !== undefined) rows.s1 = [options.row]
  if (options.observed !== undefined) observed['job-1'] = options.observed
  return {
    state: {
      getSnapshot: () => ({ rows, observed }),
      subscribe: () => () => {},
    },
    watchRows: () => () => {},
    observe: () => () => {},
    kill: () => Promise.resolve(options.kill ?? { ok: true, value: { outcome: 'requested' } }),
  }
}

/** Read the single immediate Remote snapshot. */
function remoteSnapshot(row: RemoteObservedJobRow, observed: RemoteObservedJobState): JobObservedSnapshot {
  const port = new RemoteJobObservationPort(remoteJobs({ row, observed }))
  const seen: JobObservedSnapshot[] = []
  port.open('s1', 'job-1', snapshot => seen.push(snapshot))
  const last = seen.at(-1)
  assert.ok(last !== undefined, 'the Remote observer emits its current snapshot on open')
  return last
}

test('Direct and Remote agree at BOTH the live running and the terminal stage', async () => {
  const direct = await directSnapshots([
    { type: 'opened', job: jobFrame(), from: 0 },
    { type: 'output', chunks: [{ text: 'line one\n' }], next: 9 },
    { type: 'output', chunks: [{ text: 'line two\n' }], next: 18 },
    { type: 'status', job: jobFrame({ status: 'completed', detail: 'exit 0' }) },
  ])
  const running = lastWithStatus(direct, 'running')
  const terminal = direct.at(-1)
  assert.ok(running !== undefined, 'the live running stage must be observed')
  assert.ok(terminal !== undefined)

  // The live stage: both backends report running + the appended tail, unsettled.
  const remoteRunning = remoteSnapshot(
    { id: 'job-1', kind: 'bash', label: 'build', status: 'running' },
    { jobId: 'job-1', text: 'line one\nline two\n', gapBefore: false, streaming: true },
  )
  assert.deepEqual(shape(running), shape(remoteRunning), 'the live running stage must match')
  assert.equal(running.settled, false)

  // The terminal stage: both backends report the settled projection.
  const remoteSettled = remoteSnapshot(
    { id: 'job-1', kind: 'bash', label: 'build', status: 'completed', detail: 'exit 0' },
    { jobId: 'job-1', text: 'line one\nline two\n', gapBefore: false, streaming: false },
  )
  assert.deepEqual(shape(terminal), shape(remoteSettled), 'the terminal stage must match')
  assert.equal(terminal.settled, true)
})

test('Direct and Remote agree that an observation failure is NOT a Job settlement', async () => {
  const direct = (await directSnapshots([
    { type: 'opened', job: jobFrame(), from: 0 },
    { type: 'output', chunks: [{ text: 'partial' }], next: 7 },
  ], new Error('stream broke'))).at(-1)!
  const remote = remoteSnapshot(
    { id: 'job-1', kind: 'bash', label: 'build', status: 'running' },
    { jobId: 'job-1', text: 'partial', gapBefore: false, streaming: false, error: 'stream broke' },
  )
  assert.deepEqual(shape(direct), shape(remote))
  assert.equal(direct.settled, false)
  assert.equal(direct.error, 'stream broke')
})

test('Direct and Remote agree that pre-viewer eviction is a gap', async () => {
  const direct = (await directSnapshots([
    { type: 'opened', job: jobFrame({ output: { earliest: 4096, total: 8192 } }), from: 4096 },
    { type: 'output', chunks: [{ text: 'retained tail' }], next: 8192 },
  ])).at(-1)!
  const remote = remoteSnapshot(
    { id: 'job-1', kind: 'bash', label: 'build', status: 'running' },
    { jobId: 'job-1', text: 'retained tail', gapBefore: true, streaming: true },
  )
  assert.equal(shape(direct).gapBefore, true)
  assert.equal(shape(remote).gapBefore, true)
  assert.deepEqual(shape(direct), shape(remote))
})

/** One comparable Stop situation expressed for both backends. */
interface StopScenario {
  readonly name: string
  readonly direct: {
    readonly get?: (jobId: unknown, caller: unknown) => unknown
    readonly kill?: (jobId: unknown, caller: unknown, reason: string) => 'requested' | 'already-finished'
  }
  readonly remote: RemoteJobKillResult
  readonly expected: JobStopOutcome
}

const STOP_SCENARIOS: readonly StopScenario[] = [
  {
    name: 'requested',
    direct: { kill: () => 'requested' },
    remote: { ok: true, value: { outcome: 'requested' } },
    expected: { kind: 'requested' },
  },
  {
    name: 'already-finished',
    direct: { kill: () => 'already-finished' },
    remote: { ok: true, value: { outcome: 'already-finished' } },
    expected: { kind: 'already-finished' },
  },
  {
    name: 'no-longer-visible',
    direct: { get: () => { throw new Error('unknown job job-1') } },
    remote: { ok: false, error: { code: 'job/not-found', message: 'unknown job job-1' } },
    expected: { kind: 'not-found' },
  },
]

test('Direct and Remote agree on every comparable Job Stop settlement', async () => {
  for (const scenario of STOP_SCENARIOS) {
    const registry = {
      get: (jobId: unknown, caller: unknown) => scenario.direct.get?.(jobId, caller),
      kill: (jobId: unknown, caller: unknown, reason: string) =>
        scenario.direct.kill?.(jobId, caller, reason) ?? 'requested',
    }
    const direct = new DirectJobObservationPort(
      { get: (name: string) => name === 'jobs' ? registry : undefined },
      diag,
    )
    assert.deepEqual(await direct.stop('s1', 'job-1'), scenario.expected, `Direct ${scenario.name}`)

    const remote = new RemoteJobObservationPort(remoteJobs({ kill: scenario.remote }))
    assert.deepEqual(await remote.stop('s1', 'job-1'), scenario.expected, `Remote ${scenario.name}`)
  }
})
