/**
 * Image draft vocabulary for the TUI input pipeline (plan M1).
 *
 * The draft layer is TUI-owned: it stages clipboard/file bytes until a
 * submission turns them into durable `ImageAttachmentRef`s through the dsh
 * attachment service. Nothing in this module persists; the durable boundary
 * is the harness's `ctx.attachments.saveImages()`.
 *
 * The media-type union mirrors `@deepseek-ai/dsh-attachment`'s
 * `ImageMediaType` structurally, so drafts flow into the harness without a
 * runtime dependency on the attachment package (AGENTS.md decision 7:
 * structural typing for dsh services).
 * @module @xmoon76/dsh-pi-tui/image/types
 */

/** Raster media types accepted by the TUI image intake. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Per-TUI draft image identity; only meaningful inside one TUI run. */
export type DraftImageId = number

/** Where a staged image's bytes came from. */
export type DraftImageSource =
  | { readonly type: 'clipboard' }
  | { readonly type: 'path'; readonly path: string }

/**
 * One image staged in the editor draft. The draft holds the raw bytes so
 * clipboard and path entries share one shape and a submit never depends on
 * the source file still existing (plan §5.1).
 */
export interface DraftImage {
  /** Per-TUI draft identity (the `#N` of the placeholder). */
  readonly id: DraftImageId
  readonly kind: 'image'
  readonly source: DraftImageSource
  /** Exact encoded bytes, held only for the draft lifetime. */
  readonly bytes: Uint8Array
  readonly mediaType: ImageMediaType
  /** Intrinsic encoded width in pixels. */
  readonly width: number
  /** Intrinsic encoded height in pixels. */
  readonly height: number
  /** Exact encoded byte length (`bytes.byteLength`, snapshot for free). */
  readonly byteLength: number
  /** Optional display name (basename for path sources), never a path. */
  readonly name?: string
  /** The canonical editor placeholder text for this draft. */
  readonly placeholder: string
}

/** Input accepted by {@link DraftImageStore.add}. */
export interface DraftImageInput {
  readonly bytes: Uint8Array
  readonly mediaType: ImageMediaType
  readonly width: number
  readonly height: number
  readonly source?: DraftImageSource
  readonly name?: string
}

/** The store surface the placeholder expansion needs (structural). */
export interface DraftImageStoreLike {
  values(): readonly DraftImage[]
}
