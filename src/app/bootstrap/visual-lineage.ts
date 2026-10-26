/**
 * The ONE read-only fork-lineage proof behind published-visual replay.
 *
 * A forked Session inherits a prefix of its parent's durable event log, and
 * `buildForkSeed()` keeps those events verbatim. The inherited prefix therefore
 * still belongs to the ANCESTOR's identity — the very identity its `sv1_…`
 * references were derived from — while the child owns only the events after its
 * `session/end-seed { inherited: true }` cut.
 *
 * This module proves that split from official facts only, starting with the
 * official observation of the Session itself:
 *
 * ```text
 * official sessionQuery.observeSession(child, { projectionMode: 'none' })
 *   -> child header.isSeeded + inheritedEventCount + the exact cut marker
 *      -> official sessionQuery.observeSession(parent, { projectionMode: 'none' })
 *      -> parent header identity + parent inherited cut
 *      -> the child's inherited prefix EQUALS the parent's prefix, event by event
 *         -> the parent's OWN proof (recursively, with an actual-chain cycle guard)
 *            -> per-seq origin ranges, trimmed to what this descendant inherited
 * ```
 *
 * It emits provenance ranges only, never a publication grant: which figures may
 * be shown stays the publication authority's decision. Anything that cannot be
 * proven — a missing parent, a mismatched prefix, a missing cut marker, a
 * repeated Session id — leaves that inherited prefix UNPROVEN (fail closed)
 * and returns a bounded, non-sensitive reason for diagnostics. The current
 * Session's own events stay attributable in every failure case.
 *
 * Every observation is released (`Symbol.dispose`) as soon as its level is
 * proven, and the proof runs once per selected Session identity — never per
 * frame and never as a second Session service.
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/visual-lineage
 */

import {
  intersectVisualOriginSpans,
  mergeVisualOriginSpans,
  ownVisualOriginSpans,
  type VerifiedVisualOriginSpan,
} from '../../domain/visual/origin.ts'

/**
 * The structural Session facts one lineage proof starts from.
 *
 * Declared structurally (like the other Direct spokes) so this module needs no
 * Session SDK import: the live `Session` satisfies it.
 */
export interface VisualLineageLog {
  readonly sessionId: string
  /** `Session.header.isSeeded`: whether this log starts with inherited events. */
  readonly isSeeded: boolean
  /** `Session.inheritedEventCount`: the exact fork-inherited prefix length. */
  readonly inheritedEventCount: number
  /** `Session.header.parentSession`: the recorded fork source, when any. */
  readonly parentSession: string | undefined
  /** The COMPLETE raw committed log (all event types, at their exact seqs). */
  readonly events: readonly unknown[]
}

/**
 * The structural face of one official `sessionQuery.observeSession()` read.
 *
 * The real `SessionObservation` carries the header, the paired inherited count
 * and an immutable event cut; a caller-owned lease is released by the proof.
 */
export interface VisualLineageObservation {
  readonly header: {
    readonly id: string
    readonly isSeeded?: boolean
    readonly parentSession?: unknown
  }
  readonly inheritedEventCount: number
  readonly events: readonly unknown[]
  [Symbol.dispose](): void
}

/** The official live-preferred point-observation seam (never persistence IO). */
export interface VisualLineageQuery {
  observeSession(
    sessionId: string,
    options: { readonly projectionMode: 'none' },
  ): Promise<VisualLineageObservation>
}

/** The proven provenance of one log, plus why anything stayed unproven. */
export interface VisualLineageProof {
  /** Ordered, non-overlapping origin ranges covering exactly the proven seqs. */
  readonly spans: readonly VerifiedVisualOriginSpan[]
  /** A short, non-sensitive reason when an inherited prefix stayed unproven. */
  readonly unproven: string | undefined
}

/** The maximum length of a diagnostic reason (bound the retained failure text). */
const PROBLEM_MAX_LENGTH = 240

/** One bounded, non-sensitive refusal reason. */
function problem(detail: string): string {
  return detail.length <= PROBLEM_MAX_LENGTH
    ? detail
    : `${detail.slice(0, PROBLEM_MAX_LENGTH - 3)}...`
}

/** The error text of one unknown thrown value, bounded by the caller. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether one event is the official child-owned inherited cut marker. */
function isInheritedMarker(event: unknown, seq: number): boolean {
  if (typeof event !== 'object' || event === null) return false
  const record = event as { readonly type?: unknown; readonly seq?: unknown; readonly data?: unknown }
  if (record.type !== 'session/end-seed' || record.seq !== seq) return false
  const data = record.data
  return typeof data === 'object' && data !== null
    && (data as { readonly inherited?: unknown }).inherited === true
}

/**
 * One canonical JSON spelling of a stored value.
 *
 * Object keys are sorted because the durable representation — live objects,
 * JSONL restore and the official observation — is semantically equal but not
 * guaranteed to preserve key insertion order. Arrays keep their order, and
 * every scalar keeps its exact value.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner
    const record = inner as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = record[key]
    return sorted
  })
}

/** Whether two stored events are the exact same durable content. */
function sameStoredEvent(left: unknown, right: unknown): boolean {
  return left === right || canonicalJson(left) === canonicalJson(right)
}

/** Whether the first `length` events are the same durable content, in order. */
function sameStoredPrefix(
  left: readonly unknown[],
  right: readonly unknown[],
  length: number,
): boolean {
  for (let index = 0; index < length; index += 1) {
    if (!sameStoredEvent(left[index], right[index])) return false
  }
  return true
}

/** One level's proven ranges over its whole log. */
interface LevelProof {
  readonly spans: readonly VerifiedVisualOriginSpan[]
  readonly unproven: string | undefined
}

/** The own-only refusal of one level: its own events remain attributable. */
function ownOnly(level: VisualLineageLog, cut: number, reason: string): LevelProof {
  return { spans: ownVisualOriginSpans(level.sessionId, cut, level.events.length), unproven: problem(reason) }
}

/**
 * Prove one Session level, recursing through its own fork parent.
 *
 * A non-seeded Session owns its whole log. A seeded Session owns `[cut, len)`
 * and may inherit `[0, cut)`: that prefix is attributable only when the
 * recorded parent is readable, its header identifies it, its log covers the
 * cut, the inherited events are byte-equivalent, and the parent's own level
 * proves down to the same seqs.
 * @param level - this level's exact facts.
 * @param chain - the Session ids already visited in THIS recursion chain.
 * @param query - the official observation seam.
 * @returns the proven ranges over this level's whole log.
 */
async function proveLevel(
  level: VisualLineageLog,
  chain: ReadonlySet<string>,
  query: VisualLineageQuery,
): Promise<LevelProof> {
  const length = level.events.length
  if (!level.isSeeded) {
    return { spans: ownVisualOriginSpans(level.sessionId, 0, length), unproven: undefined }
  }
  const cut = level.inheritedEventCount
  if (!Number.isSafeInteger(cut) || cut < 0 || cut > length) {
    // Without a usable cut the own range is unknowable too: prove nothing.
    return {
      spans: [],
      unproven: problem(`${level.sessionId}: the fork-inherited event count ${String(cut)} does not fit its log`),
    }
  }
  if (cut > 0 && !isInheritedMarker(level.events[cut], cut)) {
    return ownOnly(level, cut, `${level.sessionId}: the inherited cut is not the official session/end-seed marker`)
  }
  const parentSession = level.parentSession
  if (cut === 0 || parentSession === undefined || parentSession === '') {
    return cut === 0
      ? { spans: ownVisualOriginSpans(level.sessionId, 0, length), unproven: undefined }
      : ownOnly(level, cut, `${level.sessionId}: the inherited prefix has no recorded parent Session`)
  }
  if (chain.has(parentSession)) {
    return ownOnly(level, cut, `${level.sessionId}: the fork parent chain repeats "${parentSession}"`)
  }

  let observation: VisualLineageObservation
  try {
    observation = await query.observeSession(parentSession, { projectionMode: 'none' })
  } catch (error) {
    return ownOnly(level, cut, `${level.sessionId}: the fork parent could not be read (${errorText(error)})`)
  }
  // The lease stays open through the recursion so this exact parent cut is
  // valid while its prefix is compared and lifted.
  try {
    const parentHeader = observation.header
    if (String(parentHeader.id) !== parentSession) {
      return ownOnly(level, cut, `${level.sessionId}: the observed parent identifies another Session`)
    }
    if (observation.events.length < cut) {
      return ownOnly(level, cut, `${level.sessionId}: the fork parent log is shorter than the inherited prefix`)
    }
    if (!sameStoredPrefix(level.events, observation.events, cut)) {
      return ownOnly(level, cut, `${level.sessionId}: the fork parent prefix differs from the inherited events`)
    }
    const parentSeeded = parentHeader.isSeeded === true
    const parentCut = observation.inheritedEventCount
    if (!parentSeeded && parentCut !== 0) {
      return ownOnly(level, cut, `${level.sessionId}: the fork parent reports an inherited cut without seed lineage`)
    }
    const parentLevel: VisualLineageLog = {
      sessionId: parentSession,
      isSeeded: parentSeeded,
      inheritedEventCount: parentSeeded ? parentCut : 0,
      parentSession: parentHeader.parentSession === undefined ? undefined : String(parentHeader.parentSession),
      events: observation.events,
    }
    // The CURRENT level joins the actual chain before the recursion, so a
    // metadata cycle is detected on the nearest repetition (and a parent
    // pointing back at this Session is caught here, not one level too late).
    const parentProof = await proveLevel(parentLevel, new Set([...chain, level.sessionId]), query)
    const inherited = intersectVisualOriginSpans(parentProof.spans, 0, cut)
    const own = ownVisualOriginSpans(level.sessionId, cut, length)
    const merged = mergeVisualOriginSpans([...inherited, ...own])
    if (merged === undefined) {
      return ownOnly(level, cut, `${level.sessionId}: the verified origin ranges overlap`)
    }
    return { spans: merged, unproven: parentProof.unproven }
  } finally {
    observation[Symbol.dispose]()
  }
}

/**
 * Prove the per-seq origin ranges of one committed visual log.
 *
 * The Session itself is read through the same official live-preferred
 * observation as its ancestors: this module never touches a deprecated
 * synchronous history reader. The caller awaits this ONCE per selected Session
 * identity. A failure never throws for an ordinary official refusal (a
 * missing/mismatched parent is reported through `unproven`); only a
 * programming failure rejects.
 * @param sessionId - the log whose provenance is wanted.
 * @param query - the official live-preferred observation seam.
 * @returns the proven ranges plus the first bounded refusal reason, if any.
 */
export async function proveVisualLineage(
  sessionId: string,
  query: VisualLineageQuery,
): Promise<VisualLineageProof> {
  let observation: VisualLineageObservation
  try {
    observation = await query.observeSession(sessionId, { projectionMode: 'none' })
  } catch (error) {
    return { spans: [], unproven: problem(`${sessionId}: the Session could not be observed (${errorText(error)})`) }
  }
  try {
    if (String(observation.header.id) !== sessionId) {
      return { spans: [], unproven: problem(`${sessionId}: the observation identifies another Session`) }
    }
    const level: VisualLineageLog = {
      sessionId,
      isSeeded: observation.header.isSeeded === true,
      inheritedEventCount: observation.inheritedEventCount,
      parentSession: observation.header.parentSession === undefined
        ? undefined
        : String(observation.header.parentSession),
      events: observation.events,
    }
    return await proveLevel(level, new Set(), query)
  } finally {
    observation[Symbol.dispose]()
  }
}
