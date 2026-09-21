/**
 * Neutral transcript-disclosure container vocabulary.
 *
 * F5 made Work and Context-cluster semantic identity preset-neutral; this
 * module owns the ONE container-owner vocabulary the disclosure layer uses to
 * answer "which semantic container hides this row?" regardless of preset or
 * surface. Owner equality is OBJECT IDENTITY for Work/cluster (the canonical
 * first-member `TranscriptMessage` returned by
 * `projectTranscriptStructure`) and the turn number for a Focus root — never a
 * display string, array index or screen coordinate.
 *
 * This file holds pure vocabulary/equality helpers only. Mutable TuiApp
 * disclosure state stays in `tui-app.ts`, and the canonical segmentation stays
 * in `transcript-projection.ts`.
 * @module @xmoon76/dsh-pi-tui/transcript-disclosure
 */

import type { TranscriptMessage } from './transcript.ts'

/**
 * One semantic container that can own a disclosure on the current surface.
 * `focus-root` is addressed by turn; `work` / `context-cluster` are addressed
 * by the canonical owner message object (the first span/cluster member), so two
 * spans in the same turn stay independently identifiable.
 */
export type TranscriptContainerOwner =
  | { readonly kind: 'focus-root'; readonly turn: number }
  | { readonly kind: 'work'; readonly owner: TranscriptMessage }
  | { readonly kind: 'context-cluster'; readonly owner: TranscriptMessage }

/** One outer-to-inner semantic ancestry path of one rendered row. */
export type TranscriptContainerPath = readonly TranscriptContainerOwner[]

/** Stable owner equality (object identity for Work/cluster, turn for Focus). */
export function sameTranscriptContainerOwner(
  left: TranscriptContainerOwner,
  right: TranscriptContainerOwner,
): boolean {
  if (left.kind === 'focus-root') return right.kind === 'focus-root' && left.turn === right.turn
  if (left.kind === 'work') return right.kind === 'work' && left.owner === right.owner
  return right.kind === 'context-cluster' && left.owner === right.owner
}

/** Stable outer-to-inner path equality. */
export function sameTranscriptContainerPath(
  left: TranscriptContainerPath,
  right: TranscriptContainerPath,
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (!sameTranscriptContainerOwner(left[index]!, right[index]!)) return false
  }
  return true
}

/**
 * The deepest container shared by two rendered rows: the last node of their
 * longest common outer-to-inner prefix. A trailing blank spacer between two
 * rows inside the same container is owned by that container; no shared
 * container means the spacer is a boundary/global blank and is inert.
 */
export function deepestCommonTranscriptContainer(
  left: TranscriptContainerPath,
  right: TranscriptContainerPath,
): TranscriptContainerOwner | undefined {
  let deepest: TranscriptContainerOwner | undefined
  const limit = Math.min(left.length, right.length)
  for (let index = 0; index < limit; index += 1) {
    const candidate = left[index]!
    if (!sameTranscriptContainerOwner(candidate, right[index]!)) break
    deepest = candidate
  }
  return deepest
}
