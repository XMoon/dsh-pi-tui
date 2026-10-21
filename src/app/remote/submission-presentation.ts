/**
 * The Remote optimistic submission projection (TS8-E): the official Client's
 * own `SessionSnapshot.pendingSubmissions`, projected onto the shared
 * application submission-presentation contract.
 *
 * This is the sole optimistic identity on the Remote path — the TUI must not
 * run a second ledger beside it. A lost/replaced Connection generation yields
 * `undefined` rather than presenting a stale echo. This module alone may
 * consume the Remote connection-generation faces.
 * @module @xmoon76/dsh-pi-tui/app/remote/submission-presentation
 */

import type { PendingSubmissionPlacement } from '../submission/pending-submission.ts'
import type {
  PresentationAttachment,
  SubmissionPresentationItem,
  SubmissionPresentationSource,
} from '../submission/presentation.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from '../../runtime/remote/session-reader-remote.ts'

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
      // The official Remote echo carries structured attachments and a raw
      // text body: text-only exactly when no attachment is present.
      foldableText: submission.attachments.length === 0,
    }))
  }
}
