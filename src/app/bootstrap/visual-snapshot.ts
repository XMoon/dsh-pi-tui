/**
 * The composition-root's ONE read-only visual-event snapshot selector.
 *
 * The mounted surface only asks this provider for the exact live Session that
 * owns the active display subject. The provider owns no Host service, no
 * publication authority and no persistent state: it selects the Direct main
 * attachment or the mounted viewed child's Agent, fences the requested subject
 * id against the Session id, and hands the complete committed log plus its
 * PROVEN event-origin ranges to PR1's read-only authority. A per-instance seq
 * memo avoids filtering the same log again on theme/resize/scroll repaints.
 *
 * A forked Session inherits a durable prefix that still belongs to its
 * ancestor's identity. The provider therefore also owns the ONE bounded,
 * read-only ancestry task per selected Session identity:
 *
 * - the CURRENT Session's own range (`[inheritedEventCount, seq)`) is proven
 *   synchronously, so a child's own new figures work on the first frame;
 * - the inherited prefix starts UNPROVEN and is handed to the injected
 *   `lineage.prove` seam once; until it settles, the existing Tool/Work
 *   fallback stands and nothing inherited may be published;
 * - a settled proof updates the origin revision and requests ONE repaint
 *   through the injected currentness fence, so a late result for a replaced
 *   subject (A→B→A, a disposed surface, a new binding) can never rewrite it;
 * - a failed/unprovable prefix is cached for that identity: later frames reuse
 *   the conclusion instead of re-reading the parent, and a real rebind retries.
 *
 * Remote has no trusted complete-log seam, so it returns undefined and keeps
 * the PR1 Tool/Work behavior. This module is wiring-only; it is not a second
 * fold, writer or display store.
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/visual-snapshot
 */

import {
  intersectVisualOriginSpans,
  mergeVisualOriginSpans,
  ownVisualOriginSpans,
  type VerifiedVisualOriginSpan,
} from '../../domain/visual/origin.ts'
import { asVisualSessionEvents, type VisualSessionEvent } from '../../domain/visual/publication.ts'
import type { VisualEventSnapshot } from '../../domain/visual/presentation.ts'
import type { VisualLineageProof } from './visual-lineage.ts'

/** The display subject the surface repaint selected. */
export interface VisualSnapshotSubject {
  readonly subjectKind: 'main' | 'viewed-child'
  readonly subjectId: string | undefined
}

/** The structural live-Session face the selector needs. */
export interface VisualSnapshotSessionLike {
  readonly id: string
  readonly seq: number
  /** Official storage metadata: fork lineage is a header fact, not a guess. */
  readonly header: {
    readonly isSeeded?: boolean
    readonly parentSession?: unknown
  }
  /** Official exact fork-inherited prefix length (`0` without lineage). */
  readonly inheritedEventCount: number
  snapshotEvents(): readonly { readonly type: string }[]
}

/** The structural live-Agent face the selector needs. */
export interface VisualSnapshotAgentLike {
  readonly session: VisualSnapshotSessionLike
}

/**
 * The composition root's ONE read-only ancestry wiring.
 *
 * `prove` is the official `sessionQuery.observeSession()` proof and `run` is
 * the repository's owned background-task seam, so a failure is classified
 * instead of escaping as a bare promise. The two callbacks fence a settled
 * result against the LIVE subject before it repaints.
 */
export interface VisualSnapshotLineage {
  readonly prove: (sessionId: string) => Promise<VisualLineageProof>
  readonly run: (label: string, task: () => Promise<void>) => void
  /** Whether the captured subject still owns this exact Session object. */
  readonly isCurrentSubject?: (subject: VisualSnapshotSubject, session: object) => boolean
  /** Request ONE repaint of the mounted surface after the ranges changed. */
  readonly requestRepaint?: () => void
  /** Bounded diagnostics for an unproven/failed inherited prefix. */
  readonly reportProblem?: (message: string) => void
}

/** Dependencies supplied by the composition root; every read is lazy. */
export interface VisualSnapshotProviderOptions {
  readonly isRemote: () => boolean
  readonly mainAgent: () => object | undefined
  readonly viewedChildAgent: () => object | undefined
  /** The ONE ancestry proof seam; undefined keeps current-session-only attribution. */
  readonly lineage?: VisualSnapshotLineage
}

/** The exact read-only provider injected into `SurfaceRuntimeOptions`. */
export type VisualEventSnapshotProvider = (subject: VisualSnapshotSubject) => VisualEventSnapshot | undefined

/** One selected Session identity's proven provenance state. */
interface OriginState {
  readonly session: VisualSnapshotSessionLike
  readonly subject: VisualSnapshotSubject
  readonly sessionId: string
  /** Whether the official seed facts are consistent (see {@link visualSeedFacts}). */
  readonly consistent: boolean
  /** The official inherited cut: own events start here. */
  readonly cut: number
  readonly parentSession: string | undefined
  /** The PROVEN inherited ranges, always inside `[0, cut)`. */
  inherited: readonly VerifiedVisualOriginSpan[]
  /** The monotonic origin revision served with every snapshot. */
  revision: number
}

/**
 * The Session's official seed facts, or undefined when they are inconsistent.
 *
 * A log may only be split into "inherited" and "current Session" history when
 * the official header flag and the inherited count AGREE: a boolean
 * `header.isSeeded`, a non-negative safe-integer count, and a zero count for a
 * non-seeded log. Anything else — an absent flag, a non-integer count, or a
 * non-seeded header claiming inherited events — proves NOTHING: treating the
 * whole log as the current Session's own would grant it over inherited events.
 * @param session - the selected live Session face.
 * @returns the own-range start, or undefined for inconsistent metadata.
 */
function visualSeedFacts(
  session: VisualSnapshotSessionLike,
): { readonly cut: number; readonly parentSession: string | undefined } | undefined {
  const seeded = session.header.isSeeded
  const inherited = Number(session.inheritedEventCount)
  if (typeof seeded !== 'boolean' || !Number.isSafeInteger(inherited) || inherited < 0) return undefined
  if (!seeded && inherited !== 0) return undefined
  if (!seeded) return { cut: 0, parentSession: undefined }
  return {
    cut: inherited,
    parentSession: session.header.parentSession === undefined ? undefined : String(session.header.parentSession),
  }
}

/** Whether two proven range lists are the same conclusion. */
function sameSpans(
  left: readonly VerifiedVisualOriginSpan[],
  right: readonly VerifiedVisualOriginSpan[],
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] as VerifiedVisualOriginSpan
    const b = right[index] as VerifiedVisualOriginSpan
    if (a.startSeq !== b.startSeq || a.endSeqExclusive !== b.endSeqExclusive || a.sessionId !== b.sessionId) {
      return false
    }
  }
  return true
}

/**
 * Create the ONE visual-event snapshot provider for one mounted surface.
 * The returned function owns only the bounded selector memo and the current
 * identity's origin state; it never creates a Session, Host service or
 * publication index.
 * @param options - lazy composition-root reads.
 * @returns the provider consumed by the SurfaceRuntime.
 */
export function createVisualEventSnapshotProvider(
  options: VisualSnapshotProviderOptions,
): VisualEventSnapshotProvider {
  let memo: {
    readonly session: VisualSnapshotSessionLike
    readonly seq: number
    readonly events: readonly VisualSessionEvent[]
  } | undefined
  let state: OriginState | undefined
  let revision = 0

  /**
   * The proven ranges served for one exact log revision: the settled inherited
   * ranges plus the CURRENT Session's own range, which always ends at the live
   * `seq` (new child events are own events by construction).
   */
  const provenSpans = (origin: OriginState, seq: number): readonly VerifiedVisualOriginSpan[] => {
    // Inconsistent seed metadata has no proven history at all (fail closed):
    // the own range cannot even be located without an agreed cut.
    if (!origin.consistent) return []
    const own = ownVisualOriginSpans(origin.sessionId, origin.cut, seq)
    return mergeVisualOriginSpans([...origin.inherited, ...own]) ?? own
  }

  /** The ONE ancestry task for one selected identity. */
  const startLineage = (origin: OriginState): void => {
    const lineage = options.lineage
    if (lineage === undefined) return
    lineage.run('published-visual fork lineage', async () => {
      let proof: VisualLineageProof
      try {
        proof = await lineage.prove(origin.sessionId)
      } catch (error) {
        // Only the CURRENT identity's failure is a fact; a replaced subject's
        // result is dropped with the state that requested it.
        if (state !== origin) return
        lineage.reportProblem?.(
          `${origin.sessionId}: the fork lineage proof failed (${error instanceof Error ? error.message : String(error)})`,
        )
        return
      }
      if (state !== origin) return
      if (proof.unproven !== undefined) lineage.reportProblem?.(proof.unproven)
      // Only the inherited window is stored: the own range always follows the
      // live seq, so a later append cannot be masked by a settled range list.
      const inherited = intersectVisualOriginSpans(proof.spans, 0, origin.cut)
      if (sameSpans(inherited, origin.inherited)) return
      origin.inherited = inherited
      revision += 1
      origin.revision = revision
      if (lineage.isCurrentSubject?.(origin.subject, origin.session) === true) {
        lineage.requestRepaint?.()
      }
    })
  }

  return subject => {
    if (options.isRemote()) return undefined
    const raw = subject.subjectKind === 'main' ? options.mainAgent() : options.viewedChildAgent()
    if (raw === undefined) return undefined
    const agent = raw as VisualSnapshotAgentLike
    const session = agent.session
    if (subject.subjectId !== undefined && session.id !== subject.subjectId) return undefined
    const seq = session.seq
    const events = memo !== undefined && memo.session === session && memo.seq === seq
      ? memo.events
      : asVisualSessionEvents(session.snapshotEvents())
    memo = { session, seq, events }
    const seed = visualSeedFacts(session)
    const sameIdentity = state !== undefined
      && state.session === session
      && state.sessionId === session.id
      && state.consistent === (seed !== undefined)
      && state.cut === (seed?.cut ?? 0)
      && state.parentSession === seed?.parentSession
    if (!sameIdentity) {
      revision += 1
      state = {
        session,
        subject,
        sessionId: session.id,
        consistent: seed !== undefined,
        cut: seed?.cut ?? 0,
        parentSession: seed?.parentSession,
        inherited: [],
        revision,
      }
      if (seed !== undefined && seed.cut > 0) startLineage(state)
    }
    const origin = state as OriginState
    return {
      session,
      sessionId: session.id,
      seq,
      events,
      verifiedOriginSpans: provenSpans(origin, seq),
      originRevision: origin.revision,
    }
  }
}
