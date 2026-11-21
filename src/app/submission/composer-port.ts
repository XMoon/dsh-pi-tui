/**
 * SubmissionComposerPort (PR3-B §3.1): the renderer-facing composer seam the
 * {@link SubmissionController} consumes instead of the PiTui `TuiApp`.
 *
 * The contract is deliberately EXACTLY the seven members the submission
 * controller actually uses (the PR3-B §0.1 source audit): draft read/write,
 * the editor-text restore, the cursor insertion, the transient notice, the
 * local submit-ack row and the settled-local-card clear. Nothing else — no
 * panels, theme, search or chrome members — so a non-PiTui renderer can
 * implement it without impersonating `TuiApp`, and no new TuiApp import may
 * enter `app/submission/**` through the back door.
 *
 * `TuiApp` satisfies this interface structurally; the PiTui implementation is
 * the mounted app itself. A TSP implementation is backed by the renderer's
 * own composer object (never a hidden PiTui instance).
 * @module @xmoon76/dsh-pi-tui/app/submission/composer-port
 */

import type { SubmitPendingDetail } from './ack.ts'

/**
 * The composer capabilities the submission owner consumes. Each member's
 * semantics follow the OFFICIAL Client composer contract (the DSH
 * ui-conversation SubmitMachine): a sending submission keeps the editor
 * read-only with its draft retained, and only the Host acceptance commits
 * (clears) the draft — a refusal or an unknown outcome returns the editor to
 * editing with the draft intact.
 */
export interface SubmissionComposerPort {
  /** The editor's current draft in its WIRE form (`TuiApp.getDraft`). */
  getDraft(): string
  /** Write the editor draft (`TuiApp.setDraft`). */
  setDraft(text: string): void
  /** Replace the visible editor text (`TuiApp.setEditorText`) — the draft
   *  restore path of a refused/failed submission. */
  setEditorText(text: string): void
  /** Insert text at the editor cursor (`TuiApp.insertIntoEditor`). */
  insertIntoEditor(text: string): void
  /**
   * PR2/R5-1: whether the renderer would ACCEPT a draft write RIGHT NOW. A
   * stopped/disposed surface (or a held composer) refuses writes, and a
   * caller that must not lose its restore obligation can wait for the
   * renderer instead of having a void setter silently consume it. ABSENT
   * keeps the pre-existing fire-and-forget write semantics.
   */
  readonly draftWriteAccepted?: () => boolean
  /** One transient user-facing notice (`TuiApp.notify`). */
  notify(message: string, kind?: 'info' | 'error'): void
  /** Show/clear the local submit-ack row (`TuiApp.setSubmitPending`). */
  setSubmitPending(detail: SubmitPendingDetail | undefined): void
  /**
   * PR2: freeze the composer for one submission attempt — the document
   * stays exactly as submitted (read-only, no second submit) until the
   * matching {@link settleSubmission}. The renderer owns the freeze
   * mechanism (its input ladder / SDK `readonly`); the attempt id is opaque
   * correlation only. ABSENT means this composition cannot present a held
   * submission: the application then keeps the pre-PR2 (renderer-clears
   * first) admission for every line.
   */
  holdSubmission?(attemptId: string): void
  /**
   * PR2: end one submission attempt's hold. `'accepted'` clears the
   * committed draft (the renderer's own undo-retiring clear) and releases
   * the freeze; `'not-accepted'` and `'unknown'` release the freeze with
   * the draft intact. Settling an unknown attempt id is a no-op.
   */
  settleSubmission?(attemptId: string, result: 'accepted' | 'not-accepted' | 'unknown'): void
}
