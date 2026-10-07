/**
 * The application-owned prepared-prompt builder (TS8-C).
 *
 * ONE immutable representation of a user submission produced by the SHARED
 * draft-preparation authority, consumed by both transports. The fork happens
 * at the adapter/admission layer, never at the draft semantic preparation
 * layer:
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
 * A PreparedPrompt NEVER holds a Direct Agent, a Direct AttachmentStore ref, a
 * Host local filesystem path as wire content, or a generated Client object. It
 * is frozen at prepare time: the serializer must not re-query the mutable draft
 * stores later — the snapshot is this gesture's truth. The transport-neutral
 * contract itself lives in `runtime/prepared-prompt.ts`.
 *
 * @module @xmoon76/dsh-pi-tui/app/submission/prepared-prompt
 */

import { expandAttachmentPlaceholders } from '../../client/media/attachment/placeholder.ts'
import type { ImageAttachmentRefLike, ImageMediaType } from '../../domain/media/types.ts'
import type { PreparedPrompt, PreparedSegment } from '../../runtime/prepared-prompt.ts'

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
