/**
 * The application-owned prepared-prompt builder (TS8-C).
 *
 * PreparedPrompt is the immutable application snapshot used by the REMOTE
 * transport preparation path: ONE representation of a user submission produced
 * from the Client draft stores, then serialized by the Remote serializer.
 *
 * ```text
 * DraftImageStore / DraftFileStore
 *         │  pin + snapshot (prepare time, inside the writer admission)
 *         ▼
 * PreparedPrompt  (canonical ordered text + staged image bytes + names +
 *                  generic-file snapshots)
 *         └── Remote  -> preflight -> (file receipts) -> beginSubmission
 *                        -> PromptContentPart -> Session.prompt
 * ```
 *
 * Direct does NOT consume PreparedPrompt today. It keeps its SEPARATE Direct
 * `UserMessage` preparation (`app/submission/direct-message-preparation.ts` →
 * `prepareUserMessage()` → Direct Host attachment admission → durable refs) —
 * the historical split this stage preserves; converging Direct onto this
 * snapshot is a later step, not TS8-C.
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
import { streamDraftFile } from '../../client/media/attachment/file-stream.ts'
import type { DraftFile } from '../../client/media/attachment/file-draft.ts'
import type { ImageAttachmentRefLike, ImageMediaType } from '../../domain/media/types.ts'
import type { PreparedFile, PreparedPrompt, PreparedSegment } from '../../runtime/prepared-prompt.ts'

/** The draft-store faces the snapshot reads (structural; one pass). */
export interface PreparedPromptStores {
  readonly images: { values(): readonly PreparedImageSource[] }
  readonly files?: { values(): readonly DraftFile[] } | undefined
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
 * Freeze ONE submit-time segment snapshot from the live draft stores: the
 * exact ordered text/image/file slices this gesture references, with each
 * referenced file copied as an immutable Client-local source closure
 * (attach-time path + fingerprint). No Host call, no session id, no I/O.
 */
export function snapshotPreparedSegments(
  text: string,
  stores: PreparedPromptStores,
): readonly PreparedSegment[] {
  // Generic-file placeholders expand through the same strict store pass. Each
  // referenced draft is copied as an immutable Client-local source snapshot so
  // the serializer can stream the exact attach-time version later.
  const expanded = expandAttachmentPlaceholders(
    text,
    stores.images as never,
    stores.files as never,
  )
  const segments: PreparedSegment[] = expanded.map(segment => {
    if (segment.type === 'text') return { type: 'text' as const, text: segment.text }
    if (segment.type === 'file') {
      const draft = segment.file
      const source = draft.source
      let preparedSource: PreparedFile['source']
      if (source.type === 'recalled') {
        preparedSource = { kind: 'recalled-unsupported' }
      } else {
        const captured: DraftFile = {
          id: draft.id,
          kind: 'file',
          name: draft.name,
          byteLength: draft.byteLength,
          placeholder: draft.placeholder,
          source: Object.freeze({
            type: 'path',
            path: source.path,
            fingerprint: Object.freeze({
              dev: source.fingerprint.dev,
              ino: source.fingerprint.ino,
              size: source.fingerprint.size,
              mtimeNs: source.fingerprint.mtimeNs,
            }),
          }),
        }
        preparedSource = {
          kind: 'client-stream',
          open: signal => streamDraftFile(captured, signal),
        }
      }
      return {
        type: 'file' as const,
        file: Object.freeze({
          name: draft.name,
          byteLength: draft.byteLength,
          source: Object.freeze(preparedSource),
        }),
      }
    }
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
  return Object.freeze(segments)
}

/**
 * Build the immutable PreparedPrompt from the (already canonicalized) draft
 * text and the live draft stores. ONE pass, no Host calls, no admission:
 * this is the snapshot the Remote transport preparation path forks from.
 */
export function preparePrompt(sessionId: string, text: string, stores: PreparedPromptStores, requestId?: string): PreparedPrompt {
  return Object.freeze({
    sessionId,
    text,
    segments: snapshotPreparedSegments(text, stores),
    ...(requestId !== undefined ? { requestId } : {}),
  })
}
