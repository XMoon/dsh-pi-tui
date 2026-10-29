/**
 * Neutral media vocabulary shared by Client-local media capability, Direct
 * application preparation, the transport-neutral prepared prompt and TUI
 * presentation (TS8-C).
 *
 * Every shape here is a DETACHED structural fact — the accepted raster media
 * types, one durable attachment reference and one deployment's image policy —
 * that crosses several layers without carrying service, `Context`, `Agent` or
 * Session authority. They deliberately mirror the `@deepseek-ai/dsh-attachment`
 * shapes structurally, so no module needs a runtime dependency on that package
 * (AGENTS.md decision 7).
 *
 * Host service interfaces (`saveImages`, `saveFileStream`, `resolveModelInfo`)
 * MUST NOT enter this module: those are injected at the composition root and
 * owned by the Direct application preparation.
 * @module @xmoon76/dsh-pi-tui/domain/media/types
 */

/** Raster media types accepted by the TUI image intake. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Structural subset of `ImageAttachmentRef`. */
export interface ImageAttachmentRefLike {
  readonly attachmentId: string
  readonly mediaType: ImageMediaType
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** Structural subset of DSH's durable file reference. */
export interface FileAttachmentRefLike {
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
}

/** The deployment image policy, structural subset of
 * `ctx.attachments.imageLimits`. A detached preflight fact, never the
 * Client's business authority. */
export interface ImageLimitsLike {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
  readonly maxImagePixels: number
  readonly maxImageDimension: number
  readonly mediaTypes: readonly ImageMediaType[]
}

/** The graphics protocol a surface currently reports, as the terminal
 * capability source describes it. `null` means no inline graphics at all. */
export type InlineImageProtocol = 'kitty' | 'iterm2' | 'sixel' | null

/**
 * Whether a surface with `protocol` paints REAL PIXELS for `mediaType`.
 *
 * This answers ONE question: may this surface paint `mediaType` as pixels? It
 * does not absorb a surface's own extra admission rules, and it does not decide
 * a surface's protocol SCOPE.
 *
 * Current consumers compose it with their own constraints instead of repeating
 * the protocol/MIME table: the transcript thumbnail and `ImageViewerPanel` both
 * call it (the panel additionally restricts the workspace to Kitty, which is a
 * scope decision, not a MIME one).
 *
 * KNOWN EXCEPTION, not implied to be unified here: `DraftImagePreview` keeps its
 * own copy of the protocol/MIME check inside `canRenderPixels()` alongside its
 * byte budget. That duplication predates this helper and is deliberately out of
 * this change's scope; a future cleanup should have it compose this answer with
 * its budget.
 *
 * The table this answers:
 *
 * - `null` (no inline graphics) — never.
 * - Kitty accepts PNG only. This bundle installs no transcoder, so another
 *   raster format renders as the fork's `imageFallback` TEXT row, which must
 *   never be treated as a clickable pixel body.
 * - Direct SIXEL also accepts PNG only — its codec decodes a trusted PNG, so a
 *   JPEG/WebP occurrence reaches the surface as the existing DERIVED PNG (that
 *   call therefore asks with `image/png`). Asking about the original MIME here
 *   correctly answers "no pixels".
 * - iTerm2 carries the original MIME capability, so every accepted raster type
 *   is a real pixel render.
 *
 * A caller that paints a fallback TEXT row must therefore report no pixel body
 * for it (see `ImageThumbnail.paintedImageBody`).
 */
export function imagePixelsSupported(
  protocol: InlineImageProtocol,
  mediaType: ImageMediaType,
): boolean {
  if (protocol === null) return false
  if (protocol === 'kitty' || protocol === 'sixel') return mediaType === 'image/png'
  return true
}
