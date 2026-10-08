/**
 * The transport-neutral PreparedPrompt contract (TS8-C).
 *
 * ONE immutable representation of a prepared user submission, produced by the
 * application builder (`app/submission/prepared-prompt.ts`) and consumed by the
 * Remote serializer. The runtime layer owns only the transport-neutral
 * vocabulary: no Client draft-store, placeholder, filesystem or `Context` type
 * may enter this module (the TS8-B `runtime/** !-> client/**` rule is
 * mechanical).
 *
 * It never carries a Direct Agent, a Direct AttachmentStore ref, a Host local
 * filesystem path as wire content, or a generated Client object. Recalled
 * drafts (already-durable images pulled back from the queue) carry no local
 * bytes: the snapshot keeps their durable ref, and the Remote serializer reads
 * the authorized bytes through the official `session/attachment` before
 * building the image part (never by citing the Host-private reference).
 * @module @xmoon76/dsh-pi-tui/runtime/prepared-prompt
 */

import type { ImageAttachmentRefLike, ImageMediaType } from '../domain/media/types.ts'

/** One staged image snapshot: the bytes (when locally held) or the durable
 * ref (a recalled draft), plus the display facts the Remote serializer needs. */
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
  /** A generic-file placeholder: Remote has no receipt transaction, so its
   * PRESENCE alone makes the submission fail closed before dispatch. */
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
