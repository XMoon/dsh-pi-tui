/**
 * Stateless Delivered-files catalog (Delivered files PR1 / M1).
 *
 * ONE pure projection answers "which Turns of this already-selected full
 * transcript projection declare delivered files, and in which order": the
 * official `deliverables/presented` fold owns declaration validity, attribution
 * and de-duplication, so this module never parses tool output, Assistant text
 * or file existence. It also owns the ONE filter predicate the browsing surface
 * uses over a set of DECLARED files.
 *
 * No cache, no Session state: the caller derives a fresh catalog on every
 * explicit open of the browsing surface.
 * @module @xmoon76/dsh-pi-tui/domain/deliverables/catalog
 */

import type { PresentedFilePresentation, TranscriptMessage } from '../transcript/types.ts'

/** One Turn's declared delivery, newest-first ordering is the caller's view. */
export interface DeliveredTurn {
  readonly turn: number
  readonly files: readonly PresentedFilePresentation[]
}

/**
 * One read-only snapshot of the CURRENT display subject's delivered Turns.
 *
 * The application owner captures it on demand (one explicit open of the
 * browsing surface), never per repaint: it derives from the full canonical
 * transcript projection, so it is a DERIVED catalog rather than a second
 * transcript store. `sourceIdentity` is the opaque per-projection-source token
 * the transcript projection already publishes (compare with `===`): a replaced
 * Folder for the same session id yields a different identity, which is what
 * keeps a stale panel from reading a new owner's data.
 */
export interface DeliveredFilesSnapshot {
  readonly subjectKind: 'main' | 'viewed-child'
  readonly sessionId: string
  readonly sourceIdentity: object
  readonly turns: readonly DeliveredTurn[]
}

/**
 * The narrow read capability a mounted surface receives for the delivered
 * files browser: derive the current display subject's catalog on demand, and
 * re-check that an already-captured snapshot still describes the SAME
 * subject/projection after any await or callback.
 *
 * It is deliberately two functions rather than a Folder/Transcript handle: a
 * renderer can read and validate, but it can never re-project, window or mutate
 * the transcript through this seam.
 */
export interface DeliveredFilesCapability {
  snapshot(): DeliveredFilesSnapshot | undefined
  isCurrent(snapshot: DeliveredFilesSnapshot): boolean
}

/**
 * Project the delivered Turns out of ONE full grouped transcript projection.
 *
 * The fold attaches the declared files to the Turn's structurally CLOSING
 * Assistant row, so a Turn yields at most one delivery. Should a projection
 * still carry several delivered Assistant rows for one Turn (an older fold or a
 * hand-built fixture), the LAST one in projection order is the authoritative
 * closing row — the same row the transcript tail renders — and the earlier ones
 * never form a second entry.
 *
 * Turns are returned in descending numeric order (newest first) with each
 * group's files kept in the fold's declaration order.
 * @param messages - the full grouped projection (`TranscriptFolder.messages()` without a window).
 * @returns one entry per Turn that declares delivered files, newest first.
 */
export function deliveredTurnsOf(messages: readonly TranscriptMessage[]): readonly DeliveredTurn[] {
  const byTurn = new Map<number, readonly PresentedFilePresentation[]>()
  for (const message of messages) {
    if (message.kind !== 'assistant') continue
    const files = message.deliverables
    if (files === undefined || files.length === 0) continue
    // Later rows of the same Turn replace the earlier entry: the closing
    // Assistant is the authoritative one.
    byTurn.set(message.turn, files)
  }
  const turns: DeliveredTurn[] = []
  for (const [turn, files] of byTurn) turns.push({ turn, files })
  turns.sort((left, right) => right.turn - left.turn)
  return turns
}

/**
 * Filter DECLARED files by a case-insensitive substring over the basename, the
 * full declared path and the description.
 *
 * The predicate is locale-neutral (plain `toLowerCase`) and never consults the
 * filesystem, the extension, a fuzzy score or a directory listing: the
 * declaration set the fold produced is the whole search space. An empty or
 * whitespace-only query returns the input as-is, so callers can rely on object
 * identity while the filter is untouched.
 * @param files - the declared files of one Turn, in fold order.
 * @param query - the user's filter string.
 * @returns the matching files, in their original order (never mutated).
 */
export function filterDeliveredFiles(
  files: readonly PresentedFilePresentation[],
  query: string,
): readonly PresentedFilePresentation[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return files
  return files.filter((file) =>
    file.path.toLowerCase().includes(needle)
    || deliveredFileBasename(file.path).toLowerCase().includes(needle)
    || (file.description ?? '').toLowerCase().includes(needle))
}

/**
 * The display labels of one delivery: the basename, extended with the shortest
 * trailing directory suffix that makes it unique WITHIN THIS delivery.
 *
 * Disambiguation is a DISPLAY concern only and is scoped to the array: two
 * different Host paths that end in the same basename must stay distinguishable
 * on one screen, while a globally unique basename never grows a directory
 * prefix. Path comparison is case-sensitive (Host path semantics) even on a
 * case-insensitive client filesystem. A path repeated verbatim (the fold
 * normally de-duplicates it) keeps its basename.
 *
 * `project` is the SAME safe-display projection the caller paints with (the
 * terminal-control sanitizer). Collision detection runs on the PROJECTED
 * segments, so two declared paths that differ only in bytes the projection
 * removes cannot collapse into one visible label — the raw path stays the
 * search/copy authority either way.
 * @param files - the declared files of one Turn, in fold order.
 * @param options.project - the display projection applied to every path segment.
 * @returns one label per file, positionally aligned with `files`.
 */
export function deliveredFileLabels(
  files: readonly PresentedFilePresentation[],
  options: { readonly project?: (segment: string) => string } = {},
): readonly string[] {
  const project = options.project ?? ((segment: string) => segment)
  const segments = files.map(file => deliveredPathSegments(file.path).map(project))
  const basenames = segments.map(parts => parts[parts.length - 1] ?? '')
  return segments.map((parts, index) => {
    const basename = basenames[index] ?? ''
    if (basename === '') return files[index]?.path ?? ''
    const collision = segments.some((other, otherIndex) => otherIndex !== index
      && (other[other.length - 1] ?? '') === basename)
    if (!collision) return basename
    // Grow the suffix until it is unique among the colliding basenames. Two
    // identical paths never separate; the basename is the honest answer there.
    for (let depth = 2; depth <= parts.length; depth += 1) {
      const suffix = parts.slice(-depth).join('/')
      const shared = segments.some((other, otherIndex) => otherIndex !== index
        && other.slice(-depth).join('/') === suffix)
      if (!shared) return suffix
    }
    return basename
  })
}

/** The basename of a declared Host path (`/` or `\` separated). */
export function deliveredFileBasename(path: string): string {
  const parts = deliveredPathSegments(path)
  return parts[parts.length - 1] ?? path
}

/** Split a declared path into non-empty segments, treating both separators. */
function deliveredPathSegments(path: string): readonly string[] {
  return path.split(/[/\\]+/u).filter(segment => segment !== '')
}
