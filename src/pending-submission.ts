/**
 * Client-local pending-submission ledger (D2.1 follow-up): the presentation
 * half of the official Client's `pendingSubmissions`. Between the editor
 * clearing and the Host inbox acceptance (or the durable `user/message`), a
 * submission has no authoritative representation anywhere; this ledger holds a
 * lightweight, insertion-ordered echo per human submission so the accepted
 * content is never visually silent — most visibly on a running steer during a
 * long tool/`job_output` wait.
 *
 * Identity is the correlation key: each echo carries the request id minted
 * before the first asynchronous preparation and persisted on the Direct
 * user-message source as `rpcId`. An authoritative queued/steering occurrence
 * (or the durable user message) exposing the same id suppresses/retires the
 * echo. Text is never used as a correlation key.
 *
 * Suppression is RENDER-TIME and one-directional: an echo is hidden only while
 * an authoritative counterpart is actually visible in the same projection, and
 * it is removed only on the durable `user/message` (or a known terminal exit).
 * The Host claims a pending occurrence — removing it from the inbox — BEFORE
 * its durable `user/message` is emitted (asynchronous pre-step), so an echo
 * that were deleted at first observation would leave the accepted content
 * blank until the transcript materialized. Re-presenting the echo during that
 * window keeps the content continuously visible.
 *
 * This module is transport-neutral and pure: it never reads a Host inbox and
 * never touches the terminal. The runner owns the refresh scheduling and the
 * atomic presentation handoff.
 * @module @xmoon76/dsh-pi-tui/pending-submission
 */

/** Where a local submission is presented while pending. */
export type PendingSubmissionPlacement =
  /** Idle prompt: the conversation tail until the durable user message lands. */
  | 'transcript'
  /** Running + queue delivery: the queue pane. */
  | 'queued'
  /** Running + steer delivery: the ephemeral conversation-tail steering lane. */
  | 'steering'

/** One client-local submission echo, keyed by its request id. */
export interface PendingSubmissionEcho {
  readonly requestId: string
  readonly placement: PendingSubmissionPlacement
  /** Display text (including attachment markers) shown while pending. */
  readonly text: string
  readonly createdAt: number
  /** The owning session identity captured at submit time. */
  readonly sessionId?: string
  /** The session generation captured at submit time. */
  readonly generation?: number
}

/** Input accepted by {@link PendingSubmissions.begin}. */
export interface PendingSubmissionBegin {
  readonly requestId: string
  readonly placement: PendingSubmissionPlacement
  readonly text: string
  readonly createdAt: number
  readonly sessionId?: string
  readonly generation?: number
}

/**
 * The echoes whose authoritative replacement is NOT visible in the current
 * projection. Identity only — an echo is never suppressed by another echo's
 * text, and it re-appears the moment its counterpart leaves the inbox before
 * the durable message lands.
 */
export function pendingSubmissionsNotReplaced(
  echoes: readonly PendingSubmissionEcho[],
  authoritativeRpcIds: ReadonlySet<string>,
): readonly PendingSubmissionEcho[] {
  return echoes.filter(echo => !authoritativeRpcIds.has(echo.requestId))
}

/**
 * The insertion-ordered ledger. Multiple in-flight submissions are kept by
 * identity: two same-text submissions stay distinct because their request ids
 * differ, and a late settlement of one never removes another.
 */
export class PendingSubmissions {
  private records: PendingSubmissionEcho[] = []

  /** Register one echo. A duplicate request id replaces its own record only. */
  begin(input: PendingSubmissionBegin): void {
    this.records = this.records.filter(record => record.requestId !== input.requestId)
    this.records.push({
      requestId: input.requestId,
      placement: input.placement,
      text: input.text,
      createdAt: input.createdAt,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.generation === undefined ? {} : { generation: input.generation }),
    })
  }

  /** Remove one echo after its durable `user/message` became renderable. */
  observeDurable(requestId: string): void {
    this.remove(requestId)
  }

  /** Remove one echo on a known terminal exit (rejection/cancel/indeterminate). */
  settle(requestId: string): void {
    this.remove(requestId)
  }

  /** Drop echoes that do not belong to the current session/generation. */
  clearForSubject(sessionId: string | undefined, generation: number): void {
    this.records = this.records.filter(
      record => record.sessionId === sessionId && record.generation === generation,
    )
  }

  /** Drop every echo (session switch / surface teardown). */
  clear(): void {
    this.records = []
  }

  /** The insertion-ordered echoes, newest last. */
  snapshot(): readonly PendingSubmissionEcho[] {
    return this.records.map(record => ({ ...record }))
  }

  private remove(requestId: string): void {
    this.records = this.records.filter(record => record.requestId !== requestId)
  }
}
