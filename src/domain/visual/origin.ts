/**
 * Verified session-origin ranges over one committed visual log.
 *
 * A forked Session inherits a prefix of its parent's durable event log. The
 * publication authority derives every generating result's `sv1_…` reference
 * from the ORIGINAL session identity, so replaying an inherited prefix with the
 * CHILD's id would recompute different references and revoke publications the
 * ancestor legitimately made.
 *
 * This module owns the ONE read-only shape of that provenance:
 *
 * - a span is a half-open `[startSeq, endSeqExclusive)` range of one committed
 *   log, attributed to the Session whose events originally recorded it;
 * - spans are ordered and non-overlapping, and a seq no span covers is
 *   UNPROVEN — never "the current session" and never "the direct parent";
 * - merging and intersecting refuse malformed input, and the lookup fails
 *   closed (`undefined`) for an unproven seq.
 *
 * It is pure: no Host, Session SDK or TUI import, no IO and no publication
 * grant. A span only states which already-verified ancestor recorded those
 * events; whether a figure may be published stays the publication authority's
 * decision.
 * @module @xmoon76/dsh-pi-tui/domain/visual/origin
 */

/**
 * One proven origin range of a committed log.
 *
 * Immutable by construction (every producer freezes its spans): the ranges are
 * derived once from an official observation and then only read.
 */
export interface VerifiedVisualOriginSpan {
  /** Inclusive first seq covered by this span. */
  readonly startSeq: number
  /** Exclusive end seq: the first seq NOT covered by this span. */
  readonly endSeqExclusive: number
  /** The Session whose durable events these seqs originally were. */
  readonly sessionId: string
}

/** The empty proof: no seq is attributed to any Session. */
const NO_SPANS: readonly VerifiedVisualOriginSpan[] = Object.freeze([])

/** Whether one value is a structurally usable, non-empty range. */
function isValidSpan(span: VerifiedVisualOriginSpan): boolean {
  return typeof span.sessionId === 'string'
    && span.sessionId !== ''
    && Number.isSafeInteger(span.startSeq)
    && Number.isSafeInteger(span.endSeqExclusive)
    && span.startSeq >= 0
    && span.endSeqExclusive > span.startSeq
}

/** Freeze one validated range. */
function frozenSpan(span: VerifiedVisualOriginSpan): VerifiedVisualOriginSpan {
  return Object.freeze({
    startSeq: span.startSeq,
    endSeqExclusive: span.endSeqExclusive,
    sessionId: span.sessionId,
  })
}

/**
 * The ONE always-proven range of a log: a Session's OWN events.
 *
 * Events at or after the fork cut belong to the current Session by
 * construction, so this needs no ancestry read. An empty range covers nothing.
 * @param sessionId - the owning Session id.
 * @param startSeq - the first own seq (the inherited cut).
 * @param endSeqExclusive - the exclusive end (the log length).
 * @returns one frozen span, or the empty list for an empty/invalid range.
 */
export function ownVisualOriginSpans(
  sessionId: string,
  startSeq: number,
  endSeqExclusive: number,
): readonly VerifiedVisualOriginSpan[] {
  const span = { startSeq, endSeqExclusive, sessionId }
  if (!isValidSpan(span)) return NO_SPANS
  return Object.freeze([frozenSpan(span)])
}

/**
 * Merge ranges into the canonical ordered, non-overlapping form.
 *
 * Adjacent ranges of the SAME Session are coalesced; adjacent ranges of
 * DIFFERENT Sessions stay separate because the cut is a real identity change.
 * An overlapping, duplicated or malformed range set is refused as a whole
 * (`undefined`) instead of silently attributing one seq twice.
 * @param parts - the candidate ranges, in any order.
 * @returns the canonical frozen ranges, or undefined for an unusable set.
 */
export function mergeVisualOriginSpans(
  parts: readonly VerifiedVisualOriginSpan[],
): readonly VerifiedVisualOriginSpan[] | undefined {
  const sorted = [...parts].sort((left, right) => left.startSeq - right.startSeq)
  const spans: VerifiedVisualOriginSpan[] = []
  for (const part of sorted) {
    if (!isValidSpan(part)) return undefined
    const last = spans[spans.length - 1]
    if (last === undefined) {
      spans.push(frozenSpan(part))
      continue
    }
    if (part.startSeq < last.endSeqExclusive) return undefined
    if (part.startSeq === last.endSeqExclusive && part.sessionId === last.sessionId) {
      spans[spans.length - 1] = frozenSpan({
        startSeq: last.startSeq,
        endSeqExclusive: part.endSeqExclusive,
        sessionId: last.sessionId,
      })
      continue
    }
    spans.push(frozenSpan(part))
  }
  return Object.freeze(spans)
}

/**
 * Clip proven ranges to one half-open window.
 *
 * This is how a descendant reuses an ancestor's proof: the ancestor's full
 * range list is intersected with the prefix window the descendant inherited.
 * An invalid input set proves nothing.
 * @param spans - the proven ranges.
 * @param startSeq - inclusive window start.
 * @param endSeqExclusive - exclusive window end.
 * @returns the clipped ranges, still ordered and non-overlapping.
 */
export function intersectVisualOriginSpans(
  spans: readonly VerifiedVisualOriginSpan[],
  startSeq: number,
  endSeqExclusive: number,
): readonly VerifiedVisualOriginSpan[] {
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeqExclusive) || endSeqExclusive <= startSeq) {
    return NO_SPANS
  }
  const merged = mergeVisualOriginSpans(spans)
  if (merged === undefined) return NO_SPANS
  const clipped: VerifiedVisualOriginSpan[] = []
  for (const span of merged) {
    const start = Math.max(span.startSeq, startSeq)
    const end = Math.min(span.endSeqExclusive, endSeqExclusive)
    if (end <= start) continue
    clipped.push(frozenSpan({ startSeq: start, endSeqExclusive: end, sessionId: span.sessionId }))
  }
  return Object.freeze(clipped)
}

/**
 * Resolve the proven origin of one seq, once.
 * @param spans - the proven ranges.
 * @param seq - one log seq.
 * @returns the original Session id, or undefined when the seq is unproven.
 */
export function originSessionIdAt(
  spans: readonly VerifiedVisualOriginSpan[],
  seq: number,
): string | undefined {
  return createVisualOriginReader(spans)(seq)
}

/**
 * Build the ONE seq→origin lookup of a replay scan.
 *
 * The ranges are validated once; a malformed set proves nothing. The lookup is
 * a binary search, so one replay pass costs `O(events · log(spans))` and never
 * rescans the ranges per event.
 * @param spans - the proven ranges.
 * @returns the lookup (undefined for an unproven seq).
 */
export function createVisualOriginReader(
  spans: readonly VerifiedVisualOriginSpan[],
): (seq: number) => string | undefined {
  const merged = mergeVisualOriginSpans(spans)
  if (merged === undefined) return () => undefined
  return (seq: number): string | undefined => {
    let low = 0
    let high = merged.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const span = merged[middle] as VerifiedVisualOriginSpan
      if (seq < span.startSeq) high = middle - 1
      else if (seq >= span.endSeqExclusive) low = middle + 1
      else return span.sessionId
    }
    return undefined
  }
}
