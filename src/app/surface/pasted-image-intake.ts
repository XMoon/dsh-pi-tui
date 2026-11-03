/**
 * The ONE application intake owner for a terminal pasted image file path.
 *
 * A real terminal bracketed paste can carry a local image file path (Tern and
 * Hedr both paste `<absolute path><one ASCII space>`). The renderers keep the
 * pasted text as ordinary editable text and hand the app a narrow
 * {@link PastedPathReceipt}: the paste body, the seat currency, the live
 * tracked path span and the one replacement operation. This owner is the only
 * place that
 *
 * - applies the pure path grammar ({@link candidateImagePathFromPaste}), so a
 *   non-candidate paste stays completely inert (no read, no pending entry);
 * - reads the file through the EXISTING {@link readImageFile} intake and
 *   stages it in the EXISTING Client-local {@link DraftImageStore} — there is
 *   no second store, writer or Host API;
 * - owns the asynchronous lifetime: the exact composer object, ownership
 *   generation, session id and editor seat are captured at acceptance and
 *   re-checked before the synchronous commit, so a stale read can never write
 *   a replacement into a later seat, session or draft;
 * - answers the one read-only delivery predicate
 *   ({@link PastedImageIntakePort.blocksDelivery}) that every submit, queue
 *   and steer path consults BEFORE clearing the draft, so a path still being
 *   attached is never delivered as plain text.
 *
 * The image bytes/token lifecycle stays with the existing draft store and
 * editor; this owner never keeps a second draft.
 * @module @xmoon76/dsh-pi-tui/app/surface/pasted-image-intake
 */

import { pruneUnreferencedDraftAttachments } from '../../client/media/draft-attachments.ts'
import type { DraftFileStore } from '../../client/media/attachment/file-draft.ts'
import type { DraftImageStore } from '../../client/media/image/draft-store.ts'
import { readImageFile, type ImageFileIntake } from '../../client/media/image/intake.ts'
import { candidateImagePathFromPaste } from '../../client/media/image/pasted-path.ts'
import type { ImageLimitsLike } from '../../domain/media/types.ts'
import type { SubmissionComposerPort } from '../submission/composer-port.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'

/** The one user-facing refusal notice of a delivery attempt that would carry
 *  a still-attaching pasted path. Shared by every gate so the wording can
 *  never drift. */
export const PASTE_PENDING_NOTICE = 'Image paste is still being attached — retry after it finishes.'

/**
 * The renderer-owned receipt of ONE real bracketed paste. Every member is a
 * live closure onto that renderer's composer: the paste body, whether the
 * exact editor/composer seat is still current, whether the tracked path span
 * still holds the same bytes, and the single replacement operation. The app
 * never re-reads a "current" editor instead.
 */
export interface PastedPathReceipt {
  /** The complete bracketed-paste body (no `ESC[200~` markers). */
  readonly text: string
  /** The exact editor/composer seat that accepted the paste is still current. */
  readonly seatCurrent: () => boolean
  /** The tracked span of this paste still holds exactly `path`. */
  readonly hasLivePath: (path: string) => boolean
  /** Replace the tracked span with the canonical placeholder. Returns false
   *  when the span is no longer live/provable; never touches another
   *  occurrence. */
  readonly replacePastedPath: (path: string, placeholder: string) => boolean
}

/** The read-only delivery gate every submit/queue/steer path consults. */
export interface PastedImageIntakePort {
  /** Accept one real paste receipt (synchronous; the read runs as an owned
   *  task). A non-candidate paste is completely inert. */
  accept(receipt: PastedPathReceipt): void
  /** Whether `text` still carries a path whose attachment read is pending. */
  blocksDelivery(text: string): boolean
}

/** The application-lifetime owner; `dispose` retires every pending read. */
export interface PastedImageIntakeOwner extends PastedImageIntakePort {
  dispose(): void
}

/** The narrow owner/lifecycle seams the intake consumes. */
export interface PastedImageIntakeDeps {
  readonly drafts: {
    readonly images: DraftImageStore
    readonly files: DraftFileStore
  }
  /** The LIVE mounted composer (never a re-read seat): the object captured at
   *  acceptance is the only one this read may write. */
  readonly composer: () => SubmissionComposerPort
  /** The Client-local working directory (the pasted path is absolute, but the
   *  existing intake resolves against a cwd). */
  readonly clientCwd: () => string
  /** The deployment image policy (undefined on Remote: the Client caps apply). */
  readonly imageLimits: () => ImageLimitsLike | undefined
  readonly lifecycle: {
    generation(): number
    currentSessionId(): string | undefined
    isCleanedUp(): boolean
    runOwned(
      label: string,
      task: () => Promise<void>,
      options: {
        readonly sessionId: () => string | undefined
        readonly onError: (error: unknown) => void
      },
    ): void
  }
}

/** One live pending attachment read. */
interface PendingPaste {
  readonly receipt: PastedPathReceipt
  readonly path: string
  readonly composer: SubmissionComposerPort
  readonly generation: number
  readonly sessionId: string | undefined
}

/** Create the per-mounted-surface intake owner. */
export function createPastedImageIntakeOwner(deps: PastedImageIntakeDeps): PastedImageIntakeOwner {
  /** The asynchronous lifetime authority: a path is "being attached" exactly
   *  while its read is registered here. */
  const pending = new Set<PendingPaste>()
  let disposed = false

  const current = (entry: PendingPaste): boolean =>
    !disposed
    && !deps.lifecycle.isCleanedUp()
    && deps.lifecycle.generation() === entry.generation
    && deps.lifecycle.currentSessionId() === entry.sessionId
    && deps.composer() === entry.composer
    && entry.receipt.seatCurrent()
    && entry.receipt.hasLivePath(entry.path)

  /**
   * The synchronous commit segment: prune, stage, replace the exact tracked
   * span, then announce. No await may enter it — the currentness read above
   * and the draft write must describe the same instant. Reentrancy is
   * tolerated by only ever removing a staged image whose canonical token
   * really never reached the live draft.
   */
  const commit = (entry: PendingPaste, resolved: ImageFileIntake): void => {
    const composer = entry.composer
    pruneUnreferencedDraftAttachments(composer.getDraft(), deps.drafts.images, deps.drafts.files)
    const staged = deps.drafts.images.add({
      bytes: resolved.bytes,
      mediaType: resolved.mediaType,
      width: resolved.width,
      height: resolved.height,
      source: { type: 'path', path: resolved.path },
      name: resolved.name,
    })
    const dropStaged = (): void => {
      if (!composer.getDraft().includes(staged.placeholder)) deps.drafts.images.remove(staged.id)
    }
    let replaced: boolean
    try {
      replaced = entry.receipt.replacePastedPath(entry.path, staged.placeholder)
    } catch (error) {
      dropStaged()
      throw error
    }
    if (!replaced) {
      dropStaged()
      return
    }
    composer.notify(`attached ${staged.placeholder} — Enter to send`)
  }

  const accept = (receipt: PastedPathReceipt): void => {
    if (disposed) return
    const candidate = candidateImagePathFromPaste(receipt.text)
    if (candidate === undefined) return
    if (!receipt.seatCurrent() || !receipt.hasLivePath(candidate.path)) return
    const entry: PendingPaste = {
      receipt,
      path: candidate.path,
      composer: deps.composer(),
      generation: deps.lifecycle.generation(),
      sessionId: deps.lifecycle.currentSessionId(),
    }
    pending.add(entry)
    deps.lifecycle.runOwned('terminal image paste', async () => {
      try {
        if (!current(entry)) return
        const resolved = await readImageFile(
          entry.path,
          deps.clientCwd(),
          deps.imageLimits(),
          deps.drafts.images.remainingBytes(),
        )
        // The commit segment is fully synchronous: this ONE currency read
        // governs the prune, the stage and the replacement together.
        if (!current(entry)) return
        commit(entry, resolved)
      } finally {
        // The path stops blocking delivery the moment its read settles,
        // whether it converted, lost authority or failed.
        pending.delete(entry)
      }
    }, {
      sessionId: () => entry.sessionId,
      onError: (error) => {
        // Only the exact seat that started the read — and whose pasted path is
        // still live — is told; a stale task settles silently after a switch,
        // replacement or edit.
        if (!current(entry)) return
        entry.composer.notify(safeErrorMessage(error), 'error')
      },
    })
  }

  return {
    accept,
    blocksDelivery: (text) => {
      if (disposed || text === '') return false
      for (const entry of pending) {
        if (text.includes(entry.path) && entry.receipt.hasLivePath(entry.path)) return true
      }
      return false
    },
    dispose: () => {
      disposed = true
      pending.clear()
    },
  }
}
