/**
 * Experimental Remote implementation of the semantic SessionWriter port (D2.2).
 *
 * Every ordinary write is addressed by session id and resolved through the
 * official `ClientSessions.binding(id)` identity face — never through
 * `sessions.open()`, which would move the Client's current selection. The
 * official `SessionFace` owns submission echoing, prompt admission, queue
 * mutation, cancellation, and title normalization; this adapter maps those
 * outward verbs onto the shared `WriteOutcome` vocabulary.
 *
 * Prompt identity is the official Client's: one `beginSubmission()` echo per
 * human submit, its `requestId` handed to the identified `prompt()`. The TUI
 * presentation reads the resulting `SessionSnapshot.pendingSubmissions`
 * through the submission-presentation seam; this adapter never mints a second
 * client-local identity.
 *
 * A Connection generation captured before dispatch fences the binding; a
 * generation replaced before the call is cancelled (no dispatch) and a
 * generation replaced after dispatch never turns an unproven carrier failure
 * into a rejection. Title regeneration has no official Client verb and is
 * reported `unsupported`.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/session-writer-remote
 */

import { safeErrorMessage } from '../../error-boundary.ts'
import type { QueueAction, SessionWriter, WriteOutcome } from '../session-writer-port.ts'
import type {
  RemoteConnectionGenerationSource,
} from './session-reader-remote.ts'
import {
  classifyRemoteWriteFailure,
  remoteNotDispatched,
  remoteRejected,
} from './write-failure.ts'

/** Structural official `RemoteResult`. */
export type RemoteResultLike<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

/** One official prompt content part. */
export type RemotePromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: string
    readonly data: string
    readonly name?: string
  }
  | { readonly type: 'file'; readonly receiptId: string }

/** One official image preview retained by a local submission echo. */
export interface RemotePendingImage {
  readonly previewUrl: string
  readonly name?: string
  readonly width?: number
  readonly height?: number
}

/** Durable file reference displayed by one official local submission echo. */
export interface RemoteFileAttachment {
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
}

/** One official local-submission echo attachment, in prompt order. */
export type RemotePendingAttachment =
  | { readonly type: 'image'; readonly value: RemotePendingImage }
  | { readonly type: 'file'; readonly value: RemoteFileAttachment }

/** One official local submission echo input. */
export interface RemoteBeginSubmissionInput {
  readonly mode: 'queue' | 'steer'
  readonly text: string
  readonly attachments: readonly RemotePendingAttachment[]
}

/** One official submission handle. */
export interface RemoteSubmissionHandle {
  readonly requestId: string
  abandon(): void
}

/** The official `SessionFace` write verbs this adapter drives. */
export interface RemoteWriteSessionFace {
  beginSubmission(input: RemoteBeginSubmissionInput): RemoteSubmissionHandle
  prompt(
    content: readonly RemotePromptContentPart[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<RemoteResultLike<{ readonly accepted: true }>>
  updateQueue(itemId: string, action: QueueAction): Promise<RemoteResultLike<{ readonly accepted: true }>>
  cancel(): Promise<RemoteResultLike<{ readonly accepted: true }>>
  rename(title: string): Promise<RemoteResultLike<{ readonly title: string; readonly seq: number }>>
}

/** The official `SessionBinding` identity face. */
export interface RemoteWriteBinding {
  readonly session: RemoteWriteSessionFace
}

/** The official `ClientSessions` identity face. */
export interface RemoteWriteSessionsSource {
  binding(sessionId: string): RemoteWriteBinding | undefined
}

/** One resolved binding plus the Connection generation captured before dispatch. */
interface RemoteResolvedWrite {
  readonly binding: RemoteWriteBinding
  readonly captured: unknown
}

/** Result of mapping one prepared TUI submission onto official prompt content. */
export type RemoteSerializeResult =
  | {
    readonly kind: 'ok'
    readonly content: readonly RemotePromptContentPart[]
    /** Display facts for the official local submission echo. */
    readonly echo: {
      readonly text: string
      readonly attachments: readonly RemotePendingAttachment[]
    }
  }
  | { readonly kind: 'unsupported'; readonly reason: string }

/**
 * The migration-local seam that maps the TUI's prepared submission onto
 * official `PromptContentPart[]`. It must not inspect Direct Agent message
 * implementation fields: a message kind without an official representation is
 * reported `unsupported` before any Host mutation.
 */
export interface RemotePromptSerializer {
  serialize(prepared: unknown, signal?: AbortSignal): Promise<RemoteSerializeResult>
}

function generationChanged(generation: RemoteConnectionGenerationSource, captured: unknown): boolean {
  return !Object.is(captured, generation.getSnapshot())
}

/** The experimental Remote session writer. */
export class RemoteSessionWriter implements SessionWriter {
  private readonly sessions: RemoteWriteSessionsSource
  private readonly generation: RemoteConnectionGenerationSource
  private readonly serializer: RemotePromptSerializer

  constructor(
    sessions: RemoteWriteSessionsSource,
    generation: RemoteConnectionGenerationSource,
    serializer: RemotePromptSerializer,
  ) {
    this.sessions = sessions
    this.generation = generation
    this.serializer = serializer
  }

  /**
   * Resolve the binding for one addressed session after capturing the current
   * generation. A disconnected Client or an unbound session is unavailable;
   * a generation replaced while resolving is a pre-dispatch cancellation.
   */
  private resolve<T>(sessionId: string): RemoteResolvedWrite | WriteOutcome<T> | undefined {
    const captured = this.generation.getSnapshot()
    if (captured === undefined) return undefined
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) return remoteRejected('session/not-found', `session "${sessionId}" is not available`)
    if (generationChanged(this.generation, captured)) return remoteNotDispatched()
    return { binding, captured }
  }

  async prompt(sessionId: string, message: unknown, mode: 'queue' | 'steer'): Promise<WriteOutcome> {
    const resolved = this.resolve<undefined>(sessionId)
    if (resolved === undefined) return remoteNotDispatched()
    if ('kind' in resolved) return resolved
    const { binding, captured } = resolved

    let serialized: RemoteSerializeResult
    try {
      serialized = await this.serializer.serialize(message)
    } catch (error) {
      return classifyRemoteWriteFailure(error)
    }
    // A payload without an official representation is refused BEFORE any Host
    // mutation or local echo; the caller restores/preserves its own draft.
    if (serialized.kind === 'unsupported') {
      return { kind: 'unsupported', reason: serialized.reason }
    }
    // A generation replaced while serializing must not dispatch into the
    // replacement Client's UI state.
    if (generationChanged(this.generation, captured)) {
      return remoteNotDispatched()
    }

    let handle: RemoteSubmissionHandle
    try {
      handle = binding.session.beginSubmission({
        mode,
        text: serialized.echo.text,
        attachments: serialized.echo.attachments,
      })
    } catch (error) {
      // Registration is a local synchronous step; an assembly fault here is not
      // a business refusal, so it settles through the same vocabulary rather
      // than escaping the port as a throw.
      return classifyRemoteWriteFailure(error)
    }
    let result: RemoteResultLike<{ readonly accepted: true }>
    try {
      result = await binding.session.prompt(serialized.content, mode, undefined, handle.requestId)
    } catch (error) {
      // prompt() was never reached: retire the official echo as failed rather
      // than leaving a stranded local submission.
      handle.abandon()
      return classifyRemoteWriteFailure(error)
    }
    if (result.ok) return { kind: 'committed', value: undefined }
    return classifyRemoteWriteFailure(result.error)
  }

  async updateQueue(sessionId: string, itemId: string, action: QueueAction): Promise<WriteOutcome> {
    const resolved = this.resolve<undefined>(sessionId)
    if (resolved === undefined) return remoteNotDispatched()
    if ('kind' in resolved) return resolved
    try {
      const result = await resolved.binding.session.updateQueue(itemId, action)
      if (result.ok) return { kind: 'committed', value: undefined }
      return classifyRemoteWriteFailure(result.error)
    } catch (error) {
      return classifyRemoteWriteFailure(error)
    }
  }

  async cancel(sessionId: string): Promise<WriteOutcome> {
    const resolved = this.resolve<undefined>(sessionId)
    if (resolved === undefined) return remoteNotDispatched()
    if ('kind' in resolved) return resolved
    try {
      const result = await resolved.binding.session.cancel()
      if (result.ok) return { kind: 'committed', value: undefined }
      return classifyRemoteWriteFailure(result.error)
    } catch (error) {
      return classifyRemoteWriteFailure(error)
    }
  }

  async rename(sessionId: string, title: string): Promise<WriteOutcome<{ readonly title: string }>> {
    const resolved = this.resolve<{ readonly title: string }>(sessionId)
    if (resolved === undefined) return remoteNotDispatched()
    if ('kind' in resolved) return resolved
    try {
      const result = await resolved.binding.session.rename(title)
      if (result.ok) return { kind: 'committed', value: { title: result.value.title } }
      return classifyRemoteWriteFailure(result.error)
    } catch (error) {
      return classifyRemoteWriteFailure(error)
    }
  }

  async refreshTitle(_sessionId: string, _signal: AbortSignal): Promise<
    | { readonly kind: 'ok'; readonly title: string | undefined }
    | { readonly kind: 'unsupported'; readonly reason: string }
  > {
    return {
      kind: 'unsupported',
      reason: 'title regeneration has no official Client verb; the Remote path cannot run the Host title provider',
    }
  }
}
