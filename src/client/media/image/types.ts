/**
 * Image draft vocabulary for the TUI input pipeline (plan M1).
 *
 * The draft layer is TUI-owned: it stages clipboard/file bytes until a
 * submission turns them into durable `ImageAttachmentRef`s through the dsh
 * attachment service. Nothing in this module persists; the durable boundary
 * is the harness's `ctx.attachments.saveImages()`.
 *
 * The neutral media vocabulary (the media-type union and the durable
 * attachment ref) is owned by `domain/media/types.ts`; the draft layer only
 * adds the Client-local draft shapes.
 * @module @xmoon76/dsh-pi-tui/client/media/image/types
 */

import type { ImageAttachmentRefLike, ImageMediaType } from '../../../domain/media/types.ts'

/** Per-TUI draft image identity; only meaningful inside one TUI run. */
export type DraftImageId = number

/** Where a staged image's bytes came from. */
export type DraftImageSource =
  | { readonly type: 'clipboard' }
  | { readonly type: 'path'; readonly path: string }
  /** The image was pulled back from a queued message: its bytes are ALREADY
   * durable with the harness (the recalled ref) — the draft holds no local
   * copy and re-submitting reuses the ref instead of re-uploading. */
  | { readonly type: 'recalled' }

/**
 * One image staged in the editor draft. The draft holds the raw bytes so
 * clipboard and path entries share one shape and a submit never depends on
 * the source file still existing (plan §5.1). A RECALLED draft (pulled
 * back from the queue) instead carries the durable `ImageAttachmentRef`
 * and NO local bytes — the bytes stay in harness storage and re-submitting
 * reuses the ref.
 */
export interface DraftImage {
  /** Per-TUI draft identity (the `#N` of the placeholder). */
  readonly id: DraftImageId
  readonly kind: 'image'
  readonly source: DraftImageSource
  /** Exact encoded bytes, held only for the draft lifetime. Empty for a
   * recalled draft (its bytes live in harness storage). */
  readonly bytes: Uint8Array
  readonly mediaType: ImageMediaType
  /** Intrinsic encoded width in pixels. */
  readonly width: number
  /** Intrinsic encoded height in pixels. */
  readonly height: number
  /** Exact encoded byte length (`bytes.byteLength` for local drafts; the
   * durable ref's recorded `bytes` for recalled drafts). */
  readonly byteLength: number
  /** Optional display name (basename for path sources), never a path. */
  readonly name?: string
  /** The canonical editor placeholder text for this draft. */
  readonly placeholder: string
  /** The durable ref this draft reuses on submit; present ONLY for
   * recalled drafts (already-durable images are never re-uploaded). */
  readonly recalledRef?: ImageAttachmentRefLike
}

/** Input accepted by {@link DraftImageStore.add}. */
export interface DraftImageInput {
  /** Local bytes; REQUIRED unless `recalledRef` is present (a recalled
   * draft carries no local copy). */
  readonly bytes?: Uint8Array
  readonly mediaType: ImageMediaType
  readonly width: number
  readonly height: number
  readonly source?: DraftImageSource
  readonly name?: string
  /** The durable ref of a recalled (queue-pulled-back) image. */
  readonly recalledRef?: ImageAttachmentRefLike
}

/** The store surface the placeholder expansion needs (structural). */
export interface DraftImageStoreLike {
  values(): readonly DraftImage[]
}
