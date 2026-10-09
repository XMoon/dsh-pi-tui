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
 * The composer capabilities the submission owner consumes. Semantics of each
 * member mirror the same-named `TuiApp` method exactly (the PiTui behavior is
 * the contract, not an approximation).
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
  /** One transient user-facing notice (`TuiApp.notify`). */
  notify(message: string, kind?: 'info' | 'error'): void
  /** Show/clear the local submit-ack row (`TuiApp.setSubmitPending`). */
  setSubmitPending(detail: SubmitPendingDetail | undefined): void
  /** Drop every client-local settled card (`TuiApp.clearSettledLocalMessages`). */
  clearSettledLocalMessages(): void
}
