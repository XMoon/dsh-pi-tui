/**
 * Transitional Context semantic source: the producer-declared Context form and
 * the ambient-eligibility predicate.
 *
 * The producer-declared `MessageSource.form` (recorded on the folded system
 * row as `TranscriptContextPresentation`) decides WHAT one injected Context row
 * semantically is: `instructions`/`catalog`/`snapshot` are the ambient
 * foundation, `notice`/`relay`/`recall` are standalone accounts. The semantic
 * class of every row stays `Context` and `context:true` stays the surfaced
 * authority.
 *
 * TS7 moves/re-homes this A authority into `domain/transcript/**`. The
 * renderer-neutral PRESENTATION consequences — the presentation kind, ambient
 * clustering and the structured summary — already live under
 * `tui/transcript/**` (TS6); this module must not grow presentation behavior
 * again.
 * @module @xmoon76/dsh-pi-tui/context-presentation
 */

import type { TranscriptContextForm } from './context.ts'
import type { TranscriptMessage } from './transcript.ts'
import { isSurfacedContext } from './transcript-semantics.ts'

/** The ambient foundation forms: their adjacent rows may cluster. */
export const AMBIENT_CONTEXT_FORMS: readonly TranscriptContextForm[] = ['instructions', 'catalog', 'snapshot']

/** One injected Context row's presentation provenance, or undefined. */
function presentationOf(message: TranscriptMessage): NonNullable<Extract<TranscriptMessage, { kind: 'system' }>['contextPresentation']> | undefined {
  return message.kind === 'system' ? message.contextPresentation : undefined
}

/** The producer-declared form of one row, when recorded. */
export function contextFormOf(message: TranscriptMessage): TranscriptContextForm | undefined {
  return presentationOf(message)?.form
}

/** Whether one row is ambient foundation (instructions/catalog/snapshot). */
export function isAmbientContext(message: TranscriptMessage): message is Extract<TranscriptMessage, { kind: 'system' }> & { context: true } {
  const form = contextFormOf(message)
  return isSurfacedContext(message) && form !== undefined && AMBIENT_CONTEXT_FORMS.includes(form)
}
