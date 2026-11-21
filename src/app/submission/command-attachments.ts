/**
 * The application-owned command-attachment snapshot and serializer (M6 PR-C).
 *
 * One genuine Host command that declares `input.attachments` carries the
 * official `CommandSubmitAttachment` wire: encoded images, plus FILE entries
 * whose `receiptId` is minted by the Host's own staged-receipt authority. The
 * snapshot is captured at the submission gesture (before the first await); the
 * upload happens only inside the writer-admitted section, against the ACTUAL
 * Session the command executes in.
 *
 * ```text
 * submit gesture: snapshotPreparedSegments (ONE immutable ordered snapshot)
 *   → writer admission + actual SessionId
 *     → serializeCommandAttachments
 *          preflight over EVERY segment (zero upload on any invalid input)
 *          ordered image → encoded data / file → Host stageFileReceipt
 *     → commands.execute (one dispatch with the prepared wire)
 * ```
 *
 * The snapshot never re-reads the mutable draft stores: a draft edited or
 * removed while the deferred session resolves cannot change what this gesture
 * uploads. Recalled drafts are rejected before any upload: no official command
 * wire variant re-binds a durable reference.
 *
 * @module @xmoon76/dsh-pi-tui/app/submission/command-attachments
 */

import type { CommandSubmitAttachment } from '@deepseek-ai/dsh-commands/types'
import type { PreparedSegment } from '../../runtime/prepared-prompt.ts'
import type { HostCommandPort } from '../../runtime/host-command-port.ts'
import { snapshotPreparedSegments, type PreparedPromptStores } from './prepared-prompt.ts'

/** One immutable command-attachment snapshot: the gesture's ordered segments. */
export interface PreparedCommandAttachments {
  readonly segments: readonly PreparedSegment[]
}

/**
 * Freeze the command-attachment source snapshot from the live draft stores.
 * Synchronous and Host-free: only what the submission gesture references now.
 */
export function snapshotCommandAttachments(
  text: string,
  stores: PreparedPromptStores,
): PreparedCommandAttachments {
  return Object.freeze({ segments: snapshotPreparedSegments(text, stores) })
}

/**
 * Serialize the snapshot into the official command wire, staging each FILE in
 * its original order. `assertCurrent` is the application-supplied exact
 * captured-scope / signal fence: it throws when the write may no longer reach
 * the captured Session.
 *
 * A rejected preflight or a failed upload throws BEFORE `commands.execute`, so
 * the caller may treat it as a proven no-dispatch failure. The staged receipts
 * of earlier files are Host-owned and are never guessed back.
 */
export async function serializeCommandAttachments(
  snapshot: PreparedCommandAttachments,
  sessionId: string,
  hostCommand: HostCommandPort,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<readonly CommandSubmitAttachment[]> {
  // Pass 1 — zero-upload preflight over EVERY segment. Nothing is staged until
  // the whole submission is known to be representable.
  for (const segment of snapshot.segments) {
    signal.throwIfAborted()
    if (segment.type === 'file') {
      if (segment.file.source.kind !== 'client-stream') {
        throw new Error('stored files cannot be re-uploaded by this Client')
      }
      continue
    }
    if (segment.type === 'image' && segment.image.bytes.byteLength === 0) {
      throw new Error('a recalled image cannot be attached to a command; attach it again')
    }
  }
  // Pass 2 — original-order upload. Text is routing context only.
  const wire: CommandSubmitAttachment[] = []
  for (const segment of snapshot.segments) {
    signal.throwIfAborted()
    if (segment.type === 'text') continue
    if (segment.type === 'image') {
      wire.push({
        type: 'image',
        mediaType: segment.image.mediaType,
        data: Buffer.from(
          segment.image.bytes.buffer,
          segment.image.bytes.byteOffset,
          segment.image.bytes.byteLength,
        ).toString('base64'),
        ...(segment.image.name === undefined ? {} : { name: segment.image.name }),
      })
      continue
    }
    assertCurrent()
    const staged = await hostCommand.stageFileReceipt({
      sessionId,
      file: segment.file,
      signal,
    })
    assertCurrent()
    wire.push({ type: 'file', receiptId: staged.receiptId })
  }
  return wire
}
