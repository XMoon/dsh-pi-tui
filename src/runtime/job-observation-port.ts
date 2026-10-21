/**
 * The selected-Job semantic port (P1-B): detached presentation facts about ONE
 * intentionally viewed JobRegistry row (any listed Job — handed-out background
 * work, or foreground shell work while it is still registered and observable),
 * plus the one human mutation over that same seam — Stop.
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
 * The semantic settlement of one human Job Stop. It preserves CERTAINTY: a
 * proven admission (`requested`), a proven already-terminal row
 * (`already-finished`), a proven business non-commit (`not-found`), a proven
 * refusal (`rejected`), or a dispatched request whose commit state cannot be
 * proven (`indeterminate`).
 *
 * `indeterminate` is NEVER auto-replayed and must never be reported as "not
 * stopped": the authoritative roster/follow streams decide the outcome.
 */
export type JobStopOutcome =
  | { readonly kind: 'requested' }
  | { readonly kind: 'already-finished' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'rejected'; readonly message: string }
  | { readonly kind: 'indeterminate'; readonly message: string }

/**
 * Observe one selected Job, or stop it on the human's behalf.
 */
export interface JobObservationPort {
  /**
   * Open one observer for the selected Job. The returned closer aborts the
   * official stream and is idempotent. Only the selected Job is observed.
   */
  open(
    sessionId: string | undefined,
    jobId: string,
    listener: (snapshot: JobObservedSnapshot) => void,
  ): () => void
  /**
   * Stop one Job on the human's behalf — the ONLY mutation this port exposes
   * (`open` stays read/observe-only). A settlement never mutates local
   * observation/roster state: the authoritative Job streams converge on their
   * own.
   */
  stop(sessionId: string, jobId: string): Promise<JobStopOutcome>
}
