/**
 * The Assistant-owned, presentation-only visual projection sidecar.
 *
 * `collectPublishedVisuals` is the ONE authority: every render re-derives the
 * published facts from the current official Session log. This module only
 * caches the ALREADY-PROVEN display projection on the exact transcript row it
 * belongs to, together with the source identity that produced it. The WeakMap
 * dies with the row; nothing here is durable, searchable, exported or written
 * back to the Session.
 *
 * A later re-derivation replaces the sidecar when ANY identity part changes
 * (display subject, projection source, session instance, committed seq, the
 * Assistant's own text/content revision or its turn/step). A → B → A can
 * therefore never resurrect a stale attribution, while an equivalent
 * re-derivation keeps the same revision so the TuiApp render cache stays warm.
 * @module @xmoon76/dsh-pi-tui/domain/visual/presentation
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PublishedVisual, VisualSessionEvent } from './publication.ts'
import type { VerifiedVisualOriginSpan } from './origin.ts'

/** One read-only snapshot of the exact Session instance that owns a display
 * subject. Supplied by the composition root; never a Host service. */
export interface VisualEventSnapshot {
  /** The exact live Session object (identity comparison only). */
  readonly session: object
  readonly sessionId: string
  /** The committed log revision (`Session.seq`). */
  readonly seq: number
  /** The complete committed event log of that Session. */
  readonly events: readonly VisualSessionEvent[]
  /**
   * The PROVEN event-origin ranges of this exact log revision, in seq order.
   *
   * A forked Session inherits a prefix of its parent's log; those events
   * derive their `sv1_…` references from the ANCESTOR's id. Replay therefore
   * recomputes each call's reference from the range that recorded it, and a
   * seq no range covers has no publication authority at all (fail closed).
   */
  readonly verifiedOriginSpans: readonly VerifiedVisualOriginSpan[]
  /**
   * The monotonic revision of {@link verifiedOriginSpans}: an async lineage
   * proof settling for the SAME Session `seq` changes it, so a memo keyed on
   * the Session seq alone can never mask the newly proven origins. It is NOT a
   * second Session sequence and never a durable value.
   */
  readonly originRevision: number
}

/** The exact identity a visual presentation was derived from. */
export interface VisualPresentationKey {
  readonly subjectKind: 'main' | 'viewed-child'
  readonly subjectId: string | undefined
  /** The opaque per-projection-source token (session commit / cold rehydrate
   * / viewer switch changes it). */
  readonly sourceIdentity: object
  /** The exact Session instance. */
  readonly session: object
  readonly sessionId: string
  readonly seq: number
  /** The owning Assistant's turn and durable step. */
  readonly turn: number
  readonly step: number | undefined
  /** The Assistant's own body identity at derivation time. */
  readonly text: string
  readonly content: readonly ContentBlock[] | undefined
  readonly assistantRevision: number
}

/** One cached visual projection for an exact Assistant row. */
export interface AssistantVisualPresentation {
  readonly key: VisualPresentationKey
  readonly publications: readonly PublishedVisual[]
  readonly revision: number
}

const presentations = new WeakMap<object, AssistantVisualPresentation>()

function sameKey(left: VisualPresentationKey, right: VisualPresentationKey): boolean {
  return left.subjectKind === right.subjectKind
    && left.subjectId === right.subjectId
    && left.sourceIdentity === right.sourceIdentity
    && left.session === right.session
    && left.sessionId === right.sessionId
    && left.seq === right.seq
    && left.turn === right.turn
    && left.step === right.step
    && left.text === right.text
    && left.content === right.content
    && left.assistantRevision === right.assistantRevision
}

function samePublications(
  left: readonly PublishedVisual[],
  right: readonly PublishedVisual[],
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Publish the proven visual projection of one Assistant row.
 *
 * The publication ARRAY IS COPIED so a caller mutating its working list cannot
 * change an already-committed display fact.
 * @param message - the exact Assistant transcript row.
 * @param key - the complete identity the projection was derived from.
 * @param publications - the PR1-authorized publications, in durable order.
 * @returns whether the presentation revision advanced.
 */
export function setAssistantVisualPresentation(
  message: object,
  key: VisualPresentationKey,
  publications: readonly PublishedVisual[],
): boolean {
  const existing = presentations.get(message)
  if (existing !== undefined
    && sameKey(existing.key, key)
    && samePublications(existing.publications, publications)) {
    return false
  }
  presentations.set(message, {
    key,
    publications: [...publications],
    revision: (existing?.revision ?? 0) + 1,
  })
  return true
}

/**
 * Clear the visual projection of one Assistant row (a new derivation found no
 * eligible final / no publication, or the subject/source is no longer trusted).
 * @param message - the exact Assistant transcript row.
 * @returns whether a presentation existed.
 */
export function clearAssistantVisualPresentation(
  message: object,
): boolean {
  return presentations.delete(message)
}

/** Read the committed visual projection of one Assistant row, if any. */
export function assistantVisualPresentation(message: object): AssistantVisualPresentation | undefined {
  return presentations.get(message)
}

/** The render-cache revision of one Assistant row's visual projection (0 when
 * no visual projection has ever been committed to it). */
export function assistantVisualPresentationRevision(message: object): number {
  return presentations.get(message)?.revision ?? 0
}
