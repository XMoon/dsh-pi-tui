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
 * it is removed only on the durable `user/message`, a known terminal exit, the
 * application-level settlement of a queue mutation this Client itself issued,
 * or the official Host terminal reconciliation below. The Host claims a pending
 * occurrence — removing it from the inbox — BEFORE its durable `user/message` is
 * emitted (asynchronous pre-step), so an echo that were deleted at first
 * observation would leave the accepted content blank until the transcript
 * materialized. Re-presenting the echo during that window keeps the content
 * continuously visible; only a strictly later authoritative turn boundary
 * without a durable admission proves that content can no longer arrive, and
 * then the echo retires as failed.
 *
 * An Inbox occurrence removal — INCLUDING the producer's `outcome: 'canceled'`
 * splice marker — proves only that the occurrence left its list, never that the
 * business submission was cancelled. A queued message promoted to steering is
 * exactly such a removal followed by a later insertion of the SAME request id
 * into `next-step`; retiring the echo on the removal would lose the only local
 * representation of a message the Host is still working on. Genuine queue
 * removals this Client issued are terminal at their own committed write
 * (application-level identity settlement), not inferred from the splice.
 *
 * This module is transport-neutral and pure: it never reads a Host inbox and
 * never touches the terminal. The runner owns the refresh scheduling and the
 * atomic presentation handoff.
 * @module @xmoon76/dsh-pi-tui/app/submission/pending-submission
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
  /** Whether `text` is the submission's COMPLETE content (text-only input):
   * attachment markers make it false, so a pending row never folds only to
   * materialize as a full mixed-content durable bubble. ABSENT means unknown
   * and fails open to the full presentation. */
  readonly foldableText?: boolean
}

/**
 * The exact Host event shapes Direct maps onto its local echo lifecycle
 * (official Client `observeSubmissionEvent()` parity). Structural on purpose:
 * the Host event types never enter this Client-local module, and no renderer
 * ever reads the receipt below.
 */
export interface DirectPendingSubmissionEvent {
  readonly type: 'agent/inbox/spliced' | 'request/context' | 'turn/end'
  /** The durable Session event seq (Host-authoritative ordering, never a
   *  wall clock or a local frame counter). */
  readonly seq: number
  readonly data: unknown
}

/**
 * The private per-echo projection of the Host Inbox occurrence: the official
 * receipt tuple the Direct adapter mirrors. `index: null` means the occurrence
 * was removed from the inbox (claimed, moved, or cancelled) and is no longer
 * visible to the pending-input projection; `seq` is the durable event watermark
 * the tuple was derived from. This is a temporary Client projection of a Host
 * fact — it is never Host Queue authority and never reaches the renderer.
 */
interface PendingSubmissionReceipt {
  readonly target: 'next-turn' | 'next-step'
  readonly index: number | null
  readonly seq: number
}

/** One ledger record: the presentation echo plus its private Host receipt.
 *  The presentation fields are mutable ONLY for the authoritative placement
 *  transfer (a queued occurrence promoted to steering); identity and text never
 *  change. */
type PendingSubmissionRecord =
  { -readonly [K in keyof PendingSubmissionEcho]: PendingSubmissionEcho[K] }
  & { receipt?: PendingSubmissionReceipt }

/** Input accepted by {@link PendingSubmissions.begin}. */
export interface PendingSubmissionBegin {
  readonly requestId: string
  readonly placement: PendingSubmissionPlacement
  readonly text: string
  readonly createdAt: number
  readonly sessionId?: string
  readonly generation?: number
  readonly foldableText?: boolean
}

/**
 * The echoes whose authoritative replacement is NOT visible in the current
 * projection. Identity only — an echo is never suppressed by another echo's
 * text, and it re-appears the moment its counterpart leaves the inbox before
 * the durable message lands.
 */
export function pendingSubmissionsNotReplaced<T extends { readonly requestId: string }>(
  echoes: readonly T[],
  authoritativeRpcIds: ReadonlySet<string>,
): readonly T[] {
  return echoes.filter(echo => !authoritativeRpcIds.has(echo.requestId))
}

/**
 * The insertion-ordered ledger. Multiple in-flight submissions are kept by
 * identity: two same-text submissions stay distinct because their request ids
 * differ, and a late settlement of one never removes another.
 */
export class PendingSubmissions {
  private records: PendingSubmissionRecord[] = []

  /** Register one echo. A duplicate request id replaces its own record only
   *  (and never inherits the previous record's Host receipt). */
  begin(input: PendingSubmissionBegin): void {
    this.records = this.records.filter(record => record.requestId !== input.requestId)
    this.records.push({
      requestId: input.requestId,
      placement: input.placement,
      text: input.text,
      createdAt: input.createdAt,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.generation === undefined ? {} : { generation: input.generation }),
      ...(input.foldableText === undefined ? {} : { foldableText: input.foldableText }),
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

  /**
   * Fold ONE authoritative Host event into the Direct echo lifecycle (official
   * Client `observeSubmissionEvent()` semantics, mapped to this ledger):
   *
   * - `agent/inbox/spliced` maintains the exact receipt index/seq of a matching
   *   Inbox occurrence. A removal marks `index: null`; a same-mutation
   *   reinsertion of the same `rpcId` rebinds the new index. A LATER insertion
   *   of the same identity (a queued message promoted to steering) rebinds it
   *   too and follows the occurrence into the steering lane. A producer-marked
   *   `outcome: 'canceled'` is NOT a business terminal: it proves only that the
   *   occurrence left its list, so the echo stays pending for the authoritative
   *   successor (an insertion here, or a claimed boundary below). A genuine
   *   queue removal this Client issued is retired by its own committed-write
   *   settlement, never inferred from this splice.
   * - `request/context` / `turn/end` retire the echoes whose receipt was
   *   already removed from the inbox (`index === null`) and whose receipt seq is
   *   STRICTLY earlier than the terminal boundary: the Host claimed the input
   *   and then crossed a turn boundary without the matching durable
   *   `user/message`, so the accepted content can no longer become visible.
   *
   * Only echoes belonging to the exact session identity and ownership
   * generation are observed: a late event from an old subject never mutates the
   * current one. Returns whether the VISIBLE echo set actually changed (a
   * retirement or an authoritative placement transfer); a pure receipt-index
   * update returns false — the caller's queue projection refresh owns that
   * presentation change.
   */
  observeDirectHostEvent(input: {
    readonly sessionId: string
    readonly generation: number
    readonly event: DirectPendingSubmissionEvent
  }): boolean {
    const subject = this.records.filter(record =>
      record.sessionId === input.sessionId && record.generation === input.generation)
    if (subject.length === 0) return false
    if (input.event.type === 'agent/inbox/spliced') {
      return this.observeInboxSplice(subject, input.event.seq, input.event.data)
    }
    return this.retireClaimed(subject, input.event.seq)
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

  /** The insertion-ordered echoes, newest last. The private receipt never
   *  leaves the ledger: presentation reads exactly the echo shape. */
  snapshot(): readonly PendingSubmissionEcho[] {
    return this.records.map(record => {
      const { receipt: _receipt, ...echo } = record
      return echo
    })
  }

  /** Fold one durable Inbox splice into the matching receipts. A removal only
   *  clears the receipt position — never the echo — and the authoritative
   *  insertion (same mutation or a later one) rebinds the exact identity. */
  private observeInboxSplice(
    subject: readonly PendingSubmissionRecord[],
    seq: number,
    data: unknown,
  ): boolean {
    const splice = data as {
      readonly target: 'next-turn' | 'next-step'
      readonly start: number
      readonly removedCount?: number
      readonly inserted: readonly { readonly source?: unknown }[]
    }
    const removedCount = splice.removedCount ?? 0
    const removedEnd = splice.start + removedCount
    for (const record of subject) {
      const receipt = record.receipt
      if (receipt === undefined || receipt.target !== splice.target || receipt.seq >= seq) continue
      const removed = receipt.index !== null
        && receipt.index >= splice.start && receipt.index < removedEnd
      // Mirror the official receipt shift: a removal marks the occurrence
      // absent; an unaffected index before the splice point stays; anything at
      // or after the removal region moves by the net insertion delta. The
      // producer's `outcome` marker is deliberately NOT read: a `canceled`
      // splice is a list mutation, not a business terminal (a queue steer is
      // remove-then-insert of the SAME identity in two splices).
      const index = removed
        ? null
        : receipt.index !== null && receipt.index >= removedEnd
          ? receipt.index + splice.inserted.length - removedCount
          : receipt.index
      record.receipt = { target: receipt.target, index, seq }
    }
    // The authoritative insertion wins over any removal: rebind the exact
    // identity so a replace/requeue/promotion remains pending at its new
    // position. A queued occurrence promoted to steering follows the
    // authoritative placement, so the claim→durable window re-presents it in
    // the lane the Host last had it in — never as a queued row.
    let transferred = false
    for (const [offset, message] of splice.inserted.entries()) {
      const rpcId = userRpcIdOf(message.source)
      if (rpcId === undefined) continue
      const record = subject.find(candidate => candidate.requestId === rpcId)
      if (record === undefined) continue
      if (record.receipt !== undefined && record.receipt.seq > seq) continue
      record.receipt = { target: splice.target, index: splice.start + offset, seq }
      if (splice.target === 'next-step' && record.placement !== 'steering') {
        record.placement = 'steering'
        transferred = true
      }
    }
    return transferred
  }

  /** Retire every echo the Host claimed and then left behind a strictly later
   *  turn boundary without a durable admission. */
  private retireClaimed(subject: readonly PendingSubmissionRecord[], seq: number): boolean {
    const retiring = subject.filter(record =>
      record.receipt !== undefined && record.receipt.index === null && record.receipt.seq < seq)
    if (retiring.length === 0) return false
    const ids = new Set(retiring.map(record => record.requestId))
    this.records = this.records.filter(record => !ids.has(record.requestId))
    return true
  }

  private remove(requestId: string): void {
    this.records = this.records.filter(record => record.requestId !== requestId)
  }
}

/** The plain correlation identity of one Host user-message source. Only a
 *  string `rpcId` on a `kind: 'user'` source is an identity; the source object
 *  itself never leaves the event. */
function userRpcIdOf(source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  if ((source as { readonly kind?: unknown }).kind !== 'user') return undefined
  const rpcId = (source as { readonly rpcId?: unknown }).rpcId
  return typeof rpcId === 'string' ? rpcId : undefined
}
