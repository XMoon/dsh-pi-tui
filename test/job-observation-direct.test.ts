/**
 * Direct Job observation adapter tests (P1-B0). The decisive regression: the
 * adapter consumes ONLY the official non-consuming follow stream, so observing
 * a job never advances the model's `job_output` cursor.
 *
 * Upstream proof relied on here (`dsh-v0.1.7-rc.2`,
 * `packages/api/job-controller/src/observe.ts`): `follow()` reads ONLY
 * `JobRegistry.readAt()` and never `JobRegistry.read()`; it neither advances
 * the model cursor nor acknowledges a completion notice.
 * @module @xmoon76/dsh-pi-tui/job-observation-direct.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DirectJobObservationPort } from '../src/runtime/direct/job-observation-direct.ts'
import type { JobObservedSnapshot } from '../src/runtime/job-observation-port.ts'
import { createDiag } from '../src/diag.ts'

const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })

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

function service(frames: readonly Frame[], behavior: { reject?: Error } = {}): {
  get: (name: string) => unknown
  aborted: () => boolean
} {
  let aborted = false
  const controller = {
    follow: (_request: unknown, signal: AbortSignal) => (async function* () {
      for (const frame of frames) {
        if (signal.aborted) { aborted = true; return }
        yield frame
        await Promise.resolve()
      }
      if (behavior.reject !== undefined) throw behavior.reject
    })(),
  }
  return { get: (name: string) => name === 'jobController' ? controller : undefined, aborted: () => aborted }
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

test('maps opened/output/status frames into a detached snapshot', async () => {
  const host = service([
    { type: 'opened', job: { id: 'job-1', kind: 'bash', label: 'build', status: 'running', output: { earliest: 0, total: 0 } }, from: 0 },
    { type: 'output', chunks: [{ text: 'line one\n' }], next: 9 },
    { type: 'output', chunks: [{ text: 'line two\n', gapBefore: true }], next: 18, lossy: true },
    { type: 'status', job: { id: 'job-1', kind: 'bash', label: 'build', status: 'completed', detail: 'exit 0', output: { earliest: 0, total: 0 } } },
  ])
  const port = new DirectJobObservationPort(host, diag)
  const seen: JobObservedSnapshot[] = []
  port.open('session-1', 'job-1', snapshot => seen.push(snapshot))
  await flush()

  const final = seen[seen.length - 1]!
  assert.equal(final.jobId, 'job-1')
  assert.equal(final.label, 'build')
  assert.equal(final.status, 'completed')
  assert.equal(final.detail, 'exit 0')
  assert.equal(final.text, 'line one\nline two\n')
  assert.equal(final.gapBefore, true)
  assert.equal(final.settled, true)
  assert.ok(Object.isFrozen(final))
})

test('a follow failure is surfaced while the last good snapshot is retained', async () => {
  const host = service([
    { type: 'opened', job: { id: 'job-2', kind: 'bash', label: 'run', status: 'running', output: { earliest: 0, total: 0 } }, from: 0 },
    { type: 'output', chunks: [{ text: 'partial' }], next: 7 },
  ], { reject: new Error('stream broke') })
  const port = new DirectJobObservationPort(host, diag)
  const seen: JobObservedSnapshot[] = []
  port.open(undefined, 'job-2', snapshot => seen.push(snapshot))
  await flush(10)
  const final = seen[seen.length - 1]!
  assert.equal(final.error, 'stream broke')
  assert.equal(final.text, 'partial')
  assert.equal(final.status, 'running')
})

test('closing the observer aborts the official stream and ignores late frames', async () => {
  let release: (() => void) | undefined
  const controller = {
    follow: (_request: unknown, signal: AbortSignal) => (async function* () {
      yield { type: 'opened', job: { id: 'job-3', kind: 'bash', label: 'x', status: 'running', output: { earliest: 0, total: 0 } }, from: 0 }
      await new Promise<void>(resolve => { release = resolve })
      if (signal.aborted) return
      yield { type: 'output', chunks: [{ text: 'late' }], next: 4 }
    })(),
  }
  const port = new DirectJobObservationPort({ get: () => controller }, diag)
  const seen: JobObservedSnapshot[] = []
  const close = port.open('s', 'job-3', snapshot => seen.push(snapshot))
  await flush()
  const countAfterOpen = seen.length
  close()
  close() // idempotent
  release?.()
  await flush(10)
  assert.equal(seen.length, countAfterOpen, 'no frame may arrive after the closer ran')
})

test('a missing jobController service fails loud', () => {
  const port = new DirectJobObservationPort({ get: () => undefined }, diag)
  assert.throws(() => port.open('s', 'j', () => {}), /jobController service unavailable/)
})

test('output already evicted before the viewer opened is reported as a gap', async () => {
  // The official observer starts at `output.earliest`; when that is above 0
  // the earlier bytes were evicted BEFORE this viewer opened and no later
  // `lossy` frame reports it.
  const host = service([
    { type: 'opened', job: { id: 'job-5', kind: 'bash', label: 'trimmed', status: 'running', output: { earliest: 4096, total: 8192 } }, from: 4096 },
    { type: 'output', chunks: [{ text: 'retained tail' }], next: 8192 },
    { type: 'status', job: { id: 'job-5', kind: 'bash', label: 'trimmed', status: 'completed', output: { earliest: 4096, total: 8192 } } },
  ])
  const port = new DirectJobObservationPort(host, diag)
  const seen: JobObservedSnapshot[] = []
  port.open('s', 'job-5', snapshot => seen.push(snapshot))
  await flush()
  const final = seen[seen.length - 1]!
  assert.equal(final.text, 'retained tail')
  assert.equal(final.gapBefore, true, 'the pre-viewer retention loss must be reported')
})

test('a job that starts at offset 0 reports no gap', async () => {
  const host = service([
    { type: 'opened', job: { id: 'job-6', kind: 'bash', label: 'fresh', status: 'running', output: { earliest: 0, total: 7 } }, from: 0 },
    { type: 'output', chunks: [{ text: 'all here' }], next: 7 },
    { type: 'status', job: { id: 'job-6', kind: 'bash', label: 'fresh', status: 'completed', output: { earliest: 0, total: 7 } } },
  ])
  const port = new DirectJobObservationPort(host, diag)
  const seen: JobObservedSnapshot[] = []
  port.open('s', 'job-6', snapshot => seen.push(snapshot))
  await flush()
  assert.equal(seen[seen.length - 1]!.gapBefore, false)
})

/**
 * The model-cursor regression: the adapter's follow reads retained output
 * WITHOUT consuming it, so a later model-side `read()` still receives the
 * same unread output. This mirrors the upstream readAt/read split.
 */
test('observing never advances the model job_output cursor', async () => {
  const chunks = ['alpha', 'beta', 'gamma']
  let modelCursor = 0
  const total = chunks.join('').length
  const readAt = (from: number): { chunks: { text: string; at: number }[]; next: number } => {
    const joined = chunks.join('')
    const text = joined.slice(from)
    return { chunks: text === '' ? [] : [{ text, at: from }], next: total }
  }
  const modelRead = (): string => {
    const remaining = chunks.join('').slice(modelCursor)
    modelCursor = total
    return remaining
  }
  let jobsReadCalls = 0
  const jobsRegistry = {
    read: (): string => {
      jobsReadCalls += 1
      return modelRead()
    },
  }
  const controller = {
    follow: (request: { jobId: unknown }, signal: AbortSignal) => (async function* () {
      let cursor = 0
      yield { type: 'opened', job: { id: String(request.jobId), kind: 'bash', label: 'j', status: 'running', output: { earliest: 0, total: 0 } }, from: cursor }
      while (!signal.aborted) {
        const read = readAt(cursor)
        if (read.chunks.length > 0) {
          yield { type: 'output', chunks: read.chunks.map(chunk => ({ text: chunk.text })), next: read.next }
          cursor = read.next
        }
        yield { type: 'status', job: { id: String(request.jobId), kind: 'bash', label: 'j', status: 'completed', output: { earliest: total, total } } }
        return
      }
    })(),
  }
  const port = new DirectJobObservationPort({
    // The adapter may only reach the job-controller observer; a `jobs` registry
    // (whose `read()` consumes the model cursor) is available but must never be
    // touched.
    get: (name: string) => name === 'jobController' ? controller : name === 'jobs' ? jobsRegistry : undefined,
  }, diag)

  const a: JobObservedSnapshot[] = []
  const b: JobObservedSnapshot[] = []
  const closeA = port.open('s', 'job-4', snapshot => a.push(snapshot))
  await flush()
  // Two independent observers both see the retained output.
  const closeB = port.open('s', 'job-4', snapshot => b.push(snapshot))
  await flush()
  closeA()
  closeB()

  assert.equal(a[a.length - 1]!.text, chunks.join(''))
  assert.equal(b[b.length - 1]!.text, chunks.join(''))
  // Observing used the non-consuming observer only: the model's consuming
  // read was never invoked (a spy would have fired) and its cursor is intact.
  assert.equal(jobsReadCalls, 0, 'the adapter must never call the consuming jobs.read()')
  assert.equal(modelCursor, 0)
  // The model's own consuming read still receives every unread byte.
  assert.equal(jobsRegistry.read(), chunks.join(''))
  assert.equal(jobsReadCalls, 1)
  assert.equal(modelCursor, total)
})

test('the pi-tui composition mounts the official job-controller row and injects both P1 services', () => {
  const yml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(yml, /- id: job-controller\r?\n\s+name: '@deepseek-ai\/dsh-api-job-controller'/)
  assert.match(yml, /inject: \[tuiStartup, piTuiExtensions, authorization, workspaceRegistry, pluginManager, jobController\]/)
  // No second plugin-manager row: the base layer already mounts it.
  assert.equal((yml.match(/- id: plugin-manager\b/g) ?? []).length, 0)
})
