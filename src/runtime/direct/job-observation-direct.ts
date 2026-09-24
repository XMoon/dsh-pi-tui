/**
 * The Direct selected-Job observation adapter (P1-B0/B1): the ONLY module
 * that knows the official `@deepseek-ai/dsh-api-job-controller` Host service.
 *
 * It calls `JobController.follow()` — the official NON-CONSUMING Host
 * observer (upstream proof: `packages/api/job-controller/src/observe.ts`
 * reads ONLY `registry.readAt()` and never `registry.read()`; it neither
 * advances the model `job_output` cursor nor acknowledges a completion
 * notice) — and maps its frames onto detached snapshots. It never polls,
 * never builds a custom cursor/gap state machine and never calls
 * `jobs.read()`.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/job-observation-direct
 */

import { runOwned } from '../../detached.ts'
import type { Diag } from '../../diag.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import type { JobObservationPort, JobObservedSnapshot } from '../job-observation-port.ts'

/** The minimal Cordis context surface this adapter needs (structural). */
export interface JobObservationHostContextLike {
  get(name: string): unknown
}

interface JobViewLike {
  readonly id: unknown
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly progress?: string
  readonly detail?: string
  readonly output: {
    readonly earliest: number
    readonly total: number
  }
}

interface JobChunkLike {
  readonly text: string
  readonly gapBefore?: true
}

type JobFollowFrameLike =
  | { readonly type: 'opened'; readonly job: JobViewLike; readonly from: number }
  | { readonly type: 'output'; readonly chunks: readonly JobChunkLike[]; readonly next: number; readonly lossy?: true }
  | { readonly type: 'status'; readonly job: JobViewLike }

/** The official Host service shape this adapter consumes. */
export interface JobControllerServiceLike {
  follow(
    request: { readonly sessionId?: string; readonly jobId: unknown },
    signal: AbortSignal,
  ): AsyncIterable<JobFollowFrameLike>
}

/** The retained-output tail bound (a presentation preview, not an archive). */
const TAIL_MAX_CHARS = 65536

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

/** The Direct backend's selected-Job observation port. */
export class DirectJobObservationPort implements JobObservationPort {
  private readonly ctx: JobObservationHostContextLike
  private readonly diag: Diag

  constructor(ctx: JobObservationHostContextLike, diag: Diag) {
    this.ctx = ctx
    this.diag = diag
  }

  open(
    sessionId: string | undefined,
    jobId: string,
    listener: (snapshot: JobObservedSnapshot) => void,
  ): () => void {
    const abort = new AbortController()
    let closed = false
    let text = ''
    let current: JobViewLike | undefined
    let last: JobObservedSnapshot | undefined

    const emit = (patch: Partial<JobObservedSnapshot> = {}): void => {
      const job = current
      last = Object.freeze({
        jobId: job === undefined ? jobId : String(job.id),
        kind: job?.kind ?? '',
        label: job?.label ?? '',
        status: job?.status ?? 'running',
        ...(job?.progress === undefined ? {} : { progress: job.progress }),
        ...(job?.detail === undefined ? {} : { detail: job.detail }),
        text,
        gapBefore: false,
        settled: job !== undefined && isTerminalStatus(job.status),
        ...patch,
      })
      listener(last)
    }

    const service = this.ctx.get('jobController') as JobControllerServiceLike | undefined
    if (service === undefined) {
      throw new Error('jobController service unavailable: the supported DSH base plus the pi-tui bundle must mount @deepseek-ai/dsh-api-job-controller')
    }

    runOwned('job observation', async () => {
      let gap = false
      for await (const frame of service.follow({ sessionId, jobId }, abort.signal)) {
        if (abort.signal.aborted) return
        if (frame.type === 'opened') {
          // The official observer starts at `job.output.earliest`; when that
          // is above 0 the earlier output was already evicted by retention
          // BEFORE this viewer opened, and no later `lossy` frame will say so.
          gap = frame.job.output.earliest > 0
          current = frame.job
          emit({ gapBefore: gap })
          continue
        }
        if (frame.type === 'output') {
          if (frame.lossy === true) gap = true
          for (const chunk of frame.chunks) {
            if (chunk.gapBefore === true) gap = true
            text += chunk.text
          }
          if (text.length > TAIL_MAX_CHARS) text = text.slice(text.length - TAIL_MAX_CHARS)
          emit({ gapBefore: gap })
          continue
        }
        // `status`: terminal settlement, or an out-of-band status change.
        current = frame.job
        emit({ gapBefore: gap })
        if (isTerminalStatus(frame.job.status)) return
      }
    }, {
      diag: this.diag,
      isCancellation: () => abort.signal.aborted,
      onError: (error) => {
        if (closed || abort.signal.aborted) return
        const base = last
        listener(Object.freeze({
          jobId,
          kind: base?.kind ?? '',
          label: base?.label ?? '',
          status: base?.status ?? 'running',
          text,
          gapBefore: base?.gapBefore ?? false,
          settled: base?.settled ?? false,
          error: safeErrorMessage(error),
        }))
      },
    })

    return () => {
      if (closed) return
      closed = true
      abort.abort()
    }
  }
}
