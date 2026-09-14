/**
 * The client-local submission-presentation seam (D2.2): one read-only source of
 * optimistic prompt echoes for the TUI presentation layer.
 *
 * Two official-shaped sources implement it without merging their ownership:
 *
 * ```text
 * Direct  -> the existing PendingSubmissions ledger (rpcId correlation)
 * Remote  -> official SessionSnapshot.pendingSubmissions (official requestId)
 * ```
 *
 * This is presentation state, never Host queue state. The renderer joins these
 * items with the authoritative pending-input rows by request/rpc identity only;
 * it must never dedupe by text. The source applies no suppression itself — the
 * caller keeps the existing "visible authoritative counterpart" rule.
 *
 * @module @xmoon76/dsh-pi-tui/submission-presentation
 */

import type {
  PendingSubmissionEcho,
  PendingSubmissionPlacement,
} from './pending-submission.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from './runtime/remote/session-reader-remote.ts'

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
      }))
  }
}

/** One official local-submission echo attachment (the subset displayed here). */
export type RemotePresentationAttachment =
  | { readonly type: 'image'; readonly value: { readonly previewUrl?: string; readonly name?: string } }
  | { readonly type: 'file'; readonly value: { readonly name: string } }

/** One official local pending submission retained by the Session snapshot. */
export interface RemotePendingSubmission {
  readonly requestId: string
  readonly placement: PendingSubmissionPlacement
  readonly time: number
  readonly text: string
  readonly attachments: readonly RemotePresentationAttachment[]
}

/** The official Session snapshot subset consumed here. */
export interface RemoteSubmissionSessionSnapshot {
  readonly pendingSubmissions: readonly RemotePendingSubmission[]
}

/** The official Session face read face. */
export interface RemoteSubmissionSessionFace {
  getSnapshot(): RemoteSubmissionSessionSnapshot
}

/** The official `ClientSessions` identity face. */
export interface RemoteSubmissionSessionsSource {
  binding(sessionId: string): { readonly session: RemoteSubmissionSessionFace } | undefined
}

function attachmentLabel(attachment: RemotePresentationAttachment): PresentationAttachment {
  if (attachment.type === 'image') {
    return { kind: 'image', label: attachment.value.name ?? 'image' }
  }
  return { kind: 'file', label: attachment.value.name }
}

/**
 * Remote source: the official Client's own `pendingSubmissions`. This is the
 * sole optimistic identity on the Remote path — the TUI must not run a second
 * ledger beside it. A lost/replaced Connection generation yields `undefined`
 * rather than presenting a stale echo.
 */
export class RemoteSubmissionPresentation implements SubmissionPresentationSource {
  private readonly sessions: RemoteSubmissionSessionsSource
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    sessions: RemoteSubmissionSessionsSource,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.sessions = sessions
    this.generation = generation
  }

  snapshot(sessionId: string | undefined): readonly SubmissionPresentationItem[] | undefined {
    // No active session is "not available to this backend" — never an
    // authoritative empty echo list.
    if (sessionId === undefined) return undefined
    const captured: RemoteConnectionGeneration | undefined = this.generation.getSnapshot()
    if (captured === undefined) return undefined
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) return undefined
    const snapshot = binding.session.getSnapshot()
    if (!Object.is(captured, this.generation.getSnapshot())) return undefined
    return snapshot.pendingSubmissions.map(submission => ({
      requestId: submission.requestId,
      placement: submission.placement,
      text: submission.text,
      createdAt: submission.time,
      attachments: submission.attachments.map(attachmentLabel),
    }))
  }
}
