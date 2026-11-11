/**
 * The composition-root's ONE read-only visual-event snapshot selector.
 *
 * The mounted surface only asks this provider for the exact live Session that
 * owns the active display subject. The provider owns no Host service, no
 * publication authority and no persistent state: it selects the Direct main
 * attachment or the mounted viewed child's Agent, fences the requested subject
 * id against the Session id, validates the official seed facts, and hands the
 * complete committed log to PR1's read-only authority. A per-instance seq memo
 * avoids filtering the same log again on theme/resize/scroll repaints.
 *
 * Fork identity is SESSION-FREE: the authority derives the fork event epoch
 * from the committed `session/end-seed { inherited: true }` markers, so the
 * provider needs no ancestor read, no async proof and no second repaint. The
 * official seed metadata is still validated here: an inconsistent
 * `isSeeded`/`inheritedEventCount` pair, an out-of-range cut, or a cut that is
 * not the official inherited marker makes the whole visual snapshot unavailable
 * (fail closed) — never "treat the log as the current Session's own".
 *
 * Remote has no trusted complete-log seam, so it returns undefined and keeps
 * the PR1 Tool/Work behavior. This module is wiring-only; it is not a second
 * fold, writer or display store.
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/visual-snapshot
 */

import { asVisualSessionEvents, type VisualSessionEvent } from '../../domain/visual/publication.ts'
import type { VisualEventSnapshot } from '../../domain/visual/presentation.ts'

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
  }
  /** Official exact fork-inherited prefix length (`0` without lineage). */
  readonly inheritedEventCount: number
  snapshotEvents(): readonly { readonly type: string; readonly seq?: unknown; readonly data?: unknown }[]
}

/** The structural live-Agent face the selector needs. */
export interface VisualSnapshotAgentLike {
  readonly session: VisualSnapshotSessionLike
}

/** Dependencies supplied by the composition root; every read is lazy. */
export interface VisualSnapshotProviderOptions {
  readonly isRemote: () => boolean
  readonly mainAgent: () => object | undefined
  readonly viewedChildAgent: () => object | undefined
}

/** The exact read-only provider injected into `SurfaceRuntimeOptions`. */
export type VisualEventSnapshotProvider = (subject: VisualSnapshotSubject) => VisualEventSnapshot | undefined

/** The ONE official fork cut marker, validated at its exact seq. */
function isInheritedCutMarker(event: { readonly type: string; readonly seq?: unknown; readonly data?: unknown }): boolean {
  if (event.type !== 'session/end-seed' || typeof event.seq !== 'number') return false
  const data = event.data
  return typeof data === 'object' && data !== null
    && (data as { readonly inherited?: unknown }).inherited === true
}

/**
 * The Session's official own-range start, or undefined when the seed facts are
 * inconsistent.
 *
 * A log may only be split into "inherited" and "current Session" history when
 * the official header flag, the inherited count and the actual cut agree: a
 * boolean `header.isSeeded`, a non-negative safe-integer count, a zero count for
 * a non-seeded log, a cut inside the real log, and — for a non-empty cut — the
 * official child-owned `session/end-seed { inherited: true }` marker at exactly
 * that seq. Anything else proves NOTHING: treating the whole log as the current
 * Session's own would grant it authority over inherited events.
 * @param session - the selected live Session face.
 * @param rawEvents - its complete committed event log, in seq order.
 * @returns the own-range start, or undefined for inconsistent metadata.
 */
function visualSeedCut(
  session: VisualSnapshotSessionLike,
  rawEvents: readonly { readonly type: string; readonly seq?: unknown; readonly data?: unknown }[],
): number | undefined {
  const seeded = session.header.isSeeded
  const inherited = Number(session.inheritedEventCount)
  if (typeof seeded !== 'boolean' || !Number.isSafeInteger(inherited) || inherited < 0) return undefined
  if (!seeded && inherited !== 0) return undefined
  if (!seeded) return 0
  if (inherited > rawEvents.length) return undefined
  if (inherited === 0) return 0
  const cut = rawEvents[inherited]
  if (cut === undefined || cut.seq !== inherited || !isInheritedCutMarker(cut)) return undefined
  return inherited
}

/**
 * Create the ONE visual-event snapshot provider for one mounted surface.
 * The returned function owns only the bounded selector memo; it never creates a
 * Session, Host service or publication index.
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

  return subject => {
    if (options.isRemote()) return undefined
    const raw = subject.subjectKind === 'main' ? options.mainAgent() : options.viewedChildAgent()
    if (raw === undefined) return undefined
    const agent = raw as VisualSnapshotAgentLike
    const session = agent.session
    if (subject.subjectId !== undefined && session.id !== subject.subjectId) return undefined
    const seq = session.seq
    if (memo !== undefined && memo.session === session && memo.seq === seq) {
      return { session, sessionId: session.id, events: memo.events }
    }
    const rawEvents = session.snapshotEvents()
    const cut = visualSeedCut(session, rawEvents)
    // Inconsistent seed metadata makes the whole snapshot unavailable: a
    // partial/"own whole log" guess could attribute inherited events to this
    // Session.
    if (cut === undefined) return undefined
    const events = asVisualSessionEvents(rawEvents)
    memo = { session, seq, events }
    return { session, sessionId: session.id, events }
  }
}
