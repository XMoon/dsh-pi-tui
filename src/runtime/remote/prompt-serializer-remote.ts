/**
 * The production Remote prompt serializer (M3-4 PR3 Step 7): maps the
 * application-owned {@link PreparedPrompt} onto the official
 * `PromptContentPart[]` wire contract.
 *
 * Two-phase, mirroring the official Client contract consumed by
 * `RemoteSessionWriter`:
 *
 * - `preflight` is CHEAP and runs BEFORE any Host mutation: plain text is always
 *   supported; staged images are supported when their metadata is representable;
 *   a fresh generic file is supported when the official raw upload capability is
 *   composed, while a RECALLED durable generic file is reported unsupported
 *   (no official Client carrier re-binds a new receipt) — zero
 *   `beginSubmission`, zero Host prompt.
 * - `serialize` may upload each fresh generic file through the official
 *   authenticated raw route and maps the returned receipt; text parts pass
 *   through verbatim and fresh image drafts become official image parts
 *   carrying their OWN bytes. A RECALLED image (no local bytes; already
 *   durable) first reads its authorized bytes through the official
 *   `session/attachment` — never by citing the Host-private reference.
 *
 * The serializer never re-queries the mutable DraftImageStore: it consumes
 * the gesture's immutable PreparedPrompt snapshot only.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/prompt-serializer-remote
 */

import type { PreparedPrompt } from '../prepared-prompt.ts'
import type { ImageAttachmentRefLike } from '../../domain/media/types.ts'
import type { RemoteFileReceiptUploader, UploadedPromptFile } from './file-upload-remote.ts'
import type {
  RemotePendingAttachment,
  RemotePromptContentPart,
  RemotePromptSerializer,
  RemotePreflightResult,
  RemoteSerializeResult,
} from './session-writer-remote.ts'

/** The official attachment-bytes read for recalled images (structural
 * `SessionFace.readAttachment`): addressed by session + the FULL durable
 * reference the recalled draft carries. */
export interface RemoteAttachmentBytesSource {
  readAttachment(sessionId: string, attachment: ImageAttachmentRefLike): Promise<
    | { readonly ok: true; readonly data: Uint8Array }
    | { readonly ok: false; readonly error: unknown }
  >
}

/** Base64-encode one byte buffer (Node Buffer, kept inside the adapter). */
function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/** The echo attachment view of one staged image (display facts only). */
function previewOf(image: { readonly name?: string; readonly width: number; readonly height: number }): RemotePendingAttachment {
  return {
    type: 'image',
    value: {
      // The TUI has no browser preview URL; the placeholder text itself is
      // the display form, and width/height give the row its compact facts.
      previewUrl: '',
      ...(image.name !== undefined ? { name: image.name } : {}),
      width: image.width,
      height: image.height,
    },
  }
}

/** The sessions face the binding-based recall read borrows: the official
 * `ClientSessions.binding(id).session.readAttachment(fullRef)` chain, kept
 * structural so tests can stand in. */
export interface RemoteSerializerSessionsSource {
  binding(sessionId: string): {
    readonly session: {
      readAttachment(attachment: ImageAttachmentRefLike): Promise<
        | { readonly ok: true; readonly value: { readonly data: Uint8Array } }
        | { readonly ok: false; readonly error: unknown }
      >
      readonly projections: {
        faceOf(key: string): { getSnapshot(): unknown }
      }
    }
  } | undefined
}

/** The official `imageLimits` projection values (structural subset the
 * recheck consumes; boot-constant per the session-controller contract). */
export interface RemoteImageLimits {
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
}

/** Detach the official imageLimits projection value; `undefined` when the
 * projection is absent for this session (the recheck then keeps only the
 * Client-side conservative caps — never a guessed limit). */
export function detachedImageLimits(value: unknown): RemoteImageLimits | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const limits = value as { readonly maxImagesPerMessage?: unknown; readonly maxMessageImageBytes?: unknown }
  if (typeof limits.maxImagesPerMessage !== 'number' || typeof limits.maxMessageImageBytes !== 'number') return undefined
  return { maxImagesPerMessage: limits.maxImagesPerMessage, maxMessageImageBytes: limits.maxMessageImageBytes }
}

/** The production Remote prompt serializer. */
export class RemotePromptSerializerProduction implements RemotePromptSerializer {
  private readonly attachments: RemoteAttachmentBytesSource | undefined
  private readonly uploader: RemoteFileReceiptUploader | undefined
  private sessions: RemoteSerializerSessionsSource | undefined

  constructor(attachments?: RemoteAttachmentBytesSource, uploader?: RemoteFileReceiptUploader) {
    this.attachments = attachments
    this.uploader = uploader
  }

  /** Build the production serializer over the official Client sessions face:
   * recalled durable images read their authorized bytes through the exact
   * retained binding, addressed by the PreparedPrompt's own session id. */
  static overSessions(
    sessions: RemoteSerializerSessionsSource,
    uploader?: RemoteFileReceiptUploader,
  ): RemotePromptSerializerProduction {
    const serializer = new RemotePromptSerializerProduction({
      async readAttachment(sessionId, attachment) {
        const binding = sessions.binding(sessionId)
        if (binding === undefined) {
          return { ok: false, error: new Error(`session "${sessionId}" is not available for an attachment read`) }
        }
        const result = await binding.session.readAttachment(attachment)
        if (result.ok) return { ok: true, data: result.value.data }
        return { ok: false, error: (result as { readonly error: unknown }).error }
      },
    }, uploader)
    serializer.sessions = sessions
    return serializer
  }

  preflight(prepared: unknown): RemotePreflightResult {
    const prompt = prepared as PreparedPrompt
    if (prompt === undefined || prompt === null || typeof prompt !== 'object' || !Array.isArray(prompt.segments)) {
      return { kind: 'unsupported', reason: 'the submission carries no prepared prompt snapshot' }
    }
    const fileSegments = prompt.segments
      .filter((segment): segment is Extract<typeof segment, { type: 'file' }> => segment.type === 'file')
    if (fileSegments.some(segment => segment.file.source.kind === 'recalled-unsupported')) {
      return { kind: 'unsupported', reason: 'stored files cannot be re-uploaded by this Client' }
    }
    if (fileSegments.length > 0 && this.uploader === undefined) {
      return { kind: 'unsupported', reason: 'the official file upload capability is unavailable in this composition' }
    }
    // Every image must be representable: a fresh draft carries its own
    // bytes; a recalled draft needs the official attachment read.
    for (const segment of prompt.segments) {
      if (segment.type === 'image') {
        if (segment.image.recalledRef === undefined && segment.image.byteLength === 0) {
          return { kind: 'unsupported', reason: 'a staged image carries neither local bytes nor a durable reference' }
        }
        if (segment.image.recalledRef !== undefined && this.attachments === undefined) {
          return { kind: 'unsupported', reason: 'recalled durable images need the official attachment read, which this composition does not provide' }
        }
      }
    }
    // The official imageLimits RECHECK (plan §15.1): staged drafts passed the
    // Client-side conservative caps at intake; now that an exact session
    // scope exists, the session's OWN limits are re-applied before any
    // official echo. An absent projection keeps the intake caps (never a
    // guessed limit); the Host remains the final admission authority.
    if (this.sessions !== undefined) {
      const images = prompt.segments.filter((segment): segment is Extract<typeof segment, { type: 'image' }> => segment.type === 'image')
      if (images.length > 0) {
        const binding = this.sessions.binding(prompt.sessionId)
        const limits = binding === undefined
          ? undefined
          : detachedImageLimits(binding.session.projections.faceOf('imageLimits').getSnapshot())
        if (limits !== undefined) {
          if (images.length > limits.maxImagesPerMessage) {
            return { kind: 'unsupported', reason: `too many images: ${images.length} attached, the current limit is ${limits.maxImagesPerMessage} per message` }
          }
          const aggregate = images.reduce((total, segment) => total + segment.image.byteLength, 0)
          if (aggregate > limits.maxMessageImageBytes) {
            return { kind: 'unsupported', reason: `images total ${aggregate} bytes; the current aggregate limit is ${limits.maxMessageImageBytes} bytes` }
          }
        }
      }
    }
    const echoText = prompt.segments
      .map(segment => segment.type === 'text' ? segment.text : segment.type === 'image' ? '[image]' : '[file]')
      .join('')
    return {
      kind: 'ok',
      needsFileUploads: fileSegments.length > 0,
      echo: {
        text: echoText,
        attachments: prompt.segments
          .filter((segment): segment is Extract<typeof segment, { type: 'image' }> => segment.type === 'image')
          .map(segment => previewOf(segment.image)),
      },
    }
  }

  async serialize(prepared: unknown, signal?: AbortSignal): Promise<RemoteSerializeResult> {
    const prompt = prepared as PreparedPrompt
    if (prompt === undefined || prompt === null || typeof prompt !== 'object' || !Array.isArray(prompt.segments)) {
      return { kind: 'unsupported', reason: 'the submission carries no prepared prompt snapshot' }
    }
    const hasFiles = prompt.segments.some(segment => segment.type === 'file')
    const parts: RemotePromptContentPart[] = []
    const echoAttachments: RemotePendingAttachment[] = []
    for (const segment of prompt.segments) {
      signal?.throwIfAborted()
      if (segment.type === 'text') {
        if (segment.text !== '') parts.push({ type: 'text', text: segment.text })
        continue
      }
      if (segment.type === 'image') {
        const image = segment.image
        let bytes = image.bytes
        if (image.recalledRef !== undefined) {
          // Recalled images use the exact retained Session's authorized read;
          // generic recalled files have no matching official Client carrier.
          const source = this.attachments!
          const read = await source.readAttachment(prompt.sessionId, image.recalledRef)
          signal?.throwIfAborted()
          if (!read.ok) {
            return { kind: 'unsupported', reason: `the durable image bytes could not be read for re-send (${String(read.error)})` }
          }
          bytes = read.data
        }
        parts.push({
          type: 'image',
          mediaType: image.mediaType,
          data: base64Of(bytes),
          ...(image.name !== undefined ? { name: image.name } : {}),
        })
        echoAttachments.push(previewOf(image))
        continue
      }
      const file = segment.file
      if (file.source.kind === 'recalled-unsupported') {
        return { kind: 'unsupported', reason: 'stored files cannot be re-uploaded by this Client' }
      }
      if (this.uploader === undefined) {
        return { kind: 'unsupported', reason: 'the official file upload capability is unavailable in this composition' }
      }
      if (signal === undefined) {
        return { kind: 'unsupported', reason: 'file upload requires a live Client surface signal' }
      }
      const uploaded: UploadedPromptFile = await this.uploader.upload(prompt.sessionId, file, signal)
      signal.throwIfAborted()
      parts.push({ type: 'file', receiptId: uploaded.receiptId })
      echoAttachments.push({ type: 'file', value: uploaded.file })
    }
    const echoText = hasFiles
      ? prompt.segments.filter((segment): segment is Extract<typeof segment, { type: 'text' }> => segment.type === 'text')
        .map(segment => segment.text).join('')
      : prompt.segments
        .map(segment => segment.type === 'text' ? segment.text : segment.type === 'image' ? '[image]' : '[file]')
        .join('')
    return {
      kind: 'ok',
      content: Object.freeze(parts),
      echo: { text: echoText, attachments: Object.freeze(echoAttachments) },
    }
  }
}
