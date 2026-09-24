/**
 * The selected-Job observation semantic port (P1-B): detached presentation
 * facts about ONE intentionally viewed background Job.
 *
 * The official `@deepseek-ai/dsh-api-job-controller` owns the non-consuming
 * follow semantics (gap awareness, settlement, abort); this port carries only
 * what the Task Center Job detail renders and never exposes a Host object, a
 * registry cursor, or a transport.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/job-observation-port
 */

/** One detached observation of the selected Job. */
export interface JobObservedSnapshot {
  readonly jobId: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly progress?: string
  readonly detail?: string
  /** The bounded retained-output tail (`readAt` based, best-effort preview). */
  readonly text: string
  /** The official follow stream reported evicted bytes before this tail. */
  readonly gapBefore: boolean
  /** The job reached a terminal status and its retained output was delivered. */
  readonly settled: boolean
  /** Set when the follow stream failed (the last good snapshot is retained). */
  readonly error?: string
}

/**
 * Open one observer for the selected Job. The returned closer aborts the
 * official stream and is idempotent. Only the selected Job is observed.
 */
export interface JobObservationPort {
  open(
    sessionId: string | undefined,
    jobId: string,
    listener: (snapshot: JobObservedSnapshot) => void,
  ): () => void
}
