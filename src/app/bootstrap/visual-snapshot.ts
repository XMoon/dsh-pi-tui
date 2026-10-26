/**
 * The composition-root's ONE read-only visual-event snapshot selector.
 *
 * The mounted surface only asks this provider for the exact live Session that
 * owns the active display subject. The provider owns no Host service, no
 * publication authority and no persistent state: it selects the Direct main
 * attachment or the mounted viewed child's Agent, fences the requested subject
 * id against the Session id, and hands the complete committed log to PR1's
 * read-only authority. A per-instance seq memo avoids filtering the same log
 * again on theme/resize/scroll repaints.
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

/** The structural live-Agent face the selector needs. */
export interface VisualSnapshotAgentLike {
  readonly session: {
    readonly id: string
    readonly seq: number
    snapshotEvents(): readonly { readonly type: string }[]
  }
}

/** Dependencies supplied by the composition root; every read is lazy. */
export interface VisualSnapshotProviderOptions {
  readonly isRemote: () => boolean
  readonly mainAgent: () => object | undefined
  readonly viewedChildAgent: () => object | undefined
}

/** The exact read-only provider injected into `SurfaceRuntimeOptions`. */
export type VisualEventSnapshotProvider = (subject: VisualSnapshotSubject) => VisualEventSnapshot | undefined

/**
 * Create the ONE visual-event snapshot provider for one mounted surface.
 * The returned function owns only a bounded last-log memo; it never creates a
 * Session, Host service or publication index.
 * @param options - lazy composition-root reads.
 * @returns the provider consumed by the SurfaceRuntime.
 */
export function createVisualEventSnapshotProvider(
  options: VisualSnapshotProviderOptions,
): VisualEventSnapshotProvider {
  let memo: {
    readonly session: object
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
    const events = memo !== undefined && memo.session === session && memo.seq === seq
      ? memo.events
      : asVisualSessionEvents(session.snapshotEvents())
    memo = { session, seq, events }
    return { session, sessionId: session.id, seq, events }
  }
}
