/**
 * The application submission-presentation contract (D2.2 / TS8-E): one
 * read-only source of optimistic prompt echoes for the TUI presentation layer,
 * plus the Direct application-ledger source.
 *
 * The Direct source reads the existing `PendingSubmissions` ledger (rpcId
 * correlation). The Remote source is owned separately by
 * `app/remote/submission-presentation.ts` (official
 * `SessionSnapshot.pendingSubmissions`), so the two optimistic identities
 * never merge their ownership.
 *
 * This is presentation state, never Host queue state. The renderer joins these
 * items with the authoritative pending-input rows by request/rpc identity only;
 * it must never dedupe by text. The source applies no suppression itself — the
 * caller keeps the existing "visible authoritative counterpart" rule.
 * @module @xmoon76/dsh-pi-tui/app/submission/presentation
 */

import type {
  PendingSubmissionEcho,
  PendingSubmissionPlacement,
} from './pending-submission.ts'

/** One display attachment retained by a client-local echo. */
export interface PresentationAttachment {
  readonly kind: 'image' | 'file'
  readonly label: string
}

/** One transport-neutral optimistic submission echo. */
export interface SubmissionPresentationItem {
  readonly requestId: string
  readonly placement: PendingSubmissionPlacement
  readonly text: string
  readonly createdAt: number
  readonly attachments: readonly PresentationAttachment[]
  /** Whether `text` is the submission's complete content (text-only input),
   * so the pending row may join the long-user visual-row fold. ABSENT means
   * unknown and fails open to the full presentation. */
  readonly foldableText?: boolean
}

/**
 * The read-only submission-presentation source. `undefined` means the session is
 * not available to the current backend (never an authoritative empty list).
 */
export interface SubmissionPresentationSource {
  snapshot(sessionId: string | undefined): readonly SubmissionPresentationItem[] | undefined
}

/** The Direct ledger read face (the production source). */
export interface DirectSubmissionLedger {
  snapshot(): readonly PendingSubmissionEcho[]
}

/**
 * Direct source: the existing insertion-ordered ledger. Attachment text is
 * already serialized into `text` by the Direct submit path, so the structured
 * attachment list is empty here — the presentation stays byte-faithful.
 */
export class DirectSubmissionPresentation implements SubmissionPresentationSource {
  private readonly ledger: DirectSubmissionLedger

  constructor(ledger: DirectSubmissionLedger) {
    this.ledger = ledger
  }

  snapshot(sessionId: string | undefined): readonly SubmissionPresentationItem[] {
    return this.ledger.snapshot()
      .filter(echo => echo.sessionId === sessionId)
      .map(echo => ({
        requestId: echo.requestId,
        placement: echo.placement,
        text: echo.text,
        createdAt: echo.createdAt,
        attachments: [],
        ...(echo.foldableText === undefined ? {} : { foldableText: echo.foldableText }),
      }))
  }
}
