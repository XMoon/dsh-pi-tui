/**
 * The application-owned prepared prompt (shell amendment sibling, M3-4 PR3
 * Step 7): ONE immutable representation of a user submission produced by the
 * SHARED draft-preparation authority, consumed by both transports.
 *
 * The fork happens at the adapter/admission layer, never at the draft
 * semantic preparation layer (Direct keeps its existing prepareUserMessage
 * pipeline today — only the Remote transport consumes PreparedPrompt at this
 * cut; Direct convergence onto the same snapshot is a later step):
 *
 * ```text
 * DraftImageStore / DraftFileStore
 *         │  pin + snapshot (prepare time, inside the writer admission)
 *         ▼
 * PreparedPrompt  (canonical ordered text + staged image bytes + names +
 *                  generic-file markers)
 *         ├── Direct  -> Host attachment admission -> UserMessage/durable refs
 *         └── Remote  -> preflight -> beginSubmission -> image
 *                        PromptContentPart -> Session.prompt
 * ```
 *
 * A PreparedPrompt NEVER holds a Direct Agent, a Direct AttachmentStore ref,
 * a Host local filesystem path as wire content, or a generated Client
 * object. It is frozen at prepare time: the serializer must not re-query the
 * mutable DraftImageStore later — the snapshot is this gesture's truth.
 *
 * Recalled drafts (already-durable images pulled back from the queue) carry
 * no local bytes: the snapshot keeps their durable ref, and the Remote
 * serializer reads the authorized bytes through the official
 * `session/attachment` before building the image part (never by citing the
 * Host-private reference).
 *
 * @module @xmoon76/dsh-pi-tui/image/prepared-prompt
 */

import { expandAttachmentPlaceholders } from '../client/media/attachment/placeholder.ts'
import type { ImageAttachmentRefLike, ImageMediaType } from '../domain/media/types.ts'

/** One staged image snapshot: the bytes (when locally held) or the durable
 * ref (a recalled draft), plus the display facts both transports need. */
export interface PreparedImage {
  /** Exact encoded bytes; empty ONLY for a recalled draft (see recalledRef). */
  readonly bytes: Uint8Array
  readonly mediaType: ImageMediaType
  readonly width: number
  readonly height: number
  readonly byteLength: number
  readonly name?: string
  /** The durable ref a recalled draft reuses; absent for fresh images. */
  readonly recalledRef?: ImageAttachmentRefLike
}

/** One ordered slice of the prepared prompt. */
export type PreparedSegment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly image: PreparedImage }
  /** A generic-file placeholder: Remote has no receipt transaction (D4), so
   * its PRESENCE alone makes the submission fail closed before dispatch. */
  | { readonly type: 'file' }

/** The immutable application-owned prepared prompt. */
export interface PreparedPrompt {
  /** The Session this prompt was prepared for (the writer-admission scope's
   * session id): recalls/reads address THAT session, never whatever session
   * happens to be current at serialize time. */
  readonly sessionId: string
  /** The canonical text exactly as submitted (mention canonicalization ran
   * before the snapshot; the snapshot preserves the canonical bytes). */
  readonly text: string
  /** Ordered content segments (text/image/file interleaving preserved). */
  readonly segments: readonly PreparedSegment[]
  /** Whether any generic-file placeholder is present (fail-closed marker). */
  readonly hasFiles: boolean
  /** The optional request identity (the local-echo correlation id). */
  readonly requestId?: string
}

/** The draft-store faces the snapshot reads (structural; one pass). */
export interface PreparedPromptStores {
  readonly images: { values(): readonly PreparedImageSource[] }
  readonly files?: { values(): readonly unknown[] } | undefined
}

/** The image-draft fields the snapshot copies (a superset check of
 * DraftImage — structural so tests can hand-build minimal stores). */
export interface PreparedImageSource {
  readonly bytes: Uint8Array
  readonly mediaType: ImageMediaType
  readonly width: number
  readonly height: number
  readonly byteLength: number
  readonly name?: string
  readonly recalledRef?: ImageAttachmentRefLike
  readonly placeholder: string
}

/**
 * Build the immutable PreparedPrompt from the (already canonicalized) draft
 * text and the live draft stores. ONE pass, no Host calls, no admission:
 * this is the shared preparation authority both transports fork from.
 */
export function preparePrompt(sessionId: string, text: string, stores: PreparedPromptStores, requestId?: string): PreparedPrompt {
  // Generic-file placeholders only need PRESENCE for the fail-closed
  // decision, so the file store is read through the same strict expansion.
  const expanded = expandAttachmentPlaceholders(
    text,
    stores.images as never,
    stores.files as never,
  )
  const segments: PreparedSegment[] = expanded.map(segment => {
    if (segment.type === 'text') return { type: 'text' as const, text: segment.text }
    if (segment.type === 'file') return { type: 'file' as const }
    const image = segment.image as PreparedImageSource
    return {
      type: 'image' as const,
      image: {
        bytes: image.bytes,
        mediaType: image.mediaType,
        width: image.width,
        height: image.height,
        byteLength: image.byteLength,
        ...(image.name !== undefined ? { name: image.name } : {}),
        ...(image.recalledRef !== undefined ? { recalledRef: image.recalledRef } : {}),
      },
    }
  })
  return Object.freeze({
    sessionId,
    text,
    segments: Object.freeze(segments),
    hasFiles: segments.some(segment => segment.type === 'file'),
    ...(requestId !== undefined ? { requestId } : {}),
  })
}
