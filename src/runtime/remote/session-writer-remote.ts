/**
 * Experimental Remote implementation of the semantic SessionWriter port (D2.2),
 * generation-fenced for the published DSH 0.1.7-rc.2 Client contract.
 *
 * Every ordinary write is addressed by session id and resolved through the
 * official `ClientSessions.binding(id)` identity face — never through a
 * Client-global selection, and never by materializing a cold Session. Because the
 * published `binding()` only BORROWS a retained generation, the adapter pins the
 * borrowed generation with a temporary `tuiOperation` reference for the whole
 * operation (see `session-reference.ts`). A plain write therefore still cannot
 * make a cold/unowned Session writable, while a same-id generation replacement
 * cannot slip in between the borrow and the dispatch.
 *
 * The official `SessionFace` owns submission echoing, prompt admission, queue
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
import { pinExistingGeneration, type RemoteReferenceSessionsSource } from './session-reference.ts'
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

/** The official `ClientSessions` identity + reference lifetime face. */
export interface RemoteWriteSessionsSource extends RemoteReferenceSessionsSource<RemoteWriteBinding> {}

/** One resolved binding, the Connection generation captured before dispatch,
 *  and the release of the temporary pin that keeps this exact generation
 *  alive for the whole operation. */
interface RemoteResolvedWrite {
  readonly binding: RemoteWriteBinding
  readonly captured: unknown
  release(): void
}

/** Cheap preflight of one prepared submission, BEFORE any Host mutation:
 * decides D2.2 support and extracts the official local-echo presentation. */
export type RemotePreflightResult =
  | {
    readonly kind: 'ok'
    /** Display facts for the official local submission echo. */
    readonly echo: {
      readonly text: string
      readonly attachments: readonly RemotePendingAttachment[]
    }
  }
  | { readonly kind: 'unsupported'; readonly reason: string }

/** Expensive prompt serialization, run AFTER the official echo is registered. */
export type RemoteSerializeResult =
  | { readonly kind: 'ok'; readonly content: readonly RemotePromptContentPart[] }
  | { readonly kind: 'unsupported'; readonly reason: string }

/**
 * The migration-local seam that maps the TUI's prepared submission onto
 * official `PromptContentPart[]`. It must not inspect Direct Agent message
 * implementation fields: a message kind without an official representation is
 * reported `unsupported`.
 *
 * The seam is deliberately two-phase, mirroring the official Client contract:
 * `preflight()` is cheap and runs BEFORE `beginSubmission()` (so an unsupported
 * payload never creates an echo), while `serialize()` may be expensive (image
 * encoding) and runs AFTER the echo is registered, so the local submission is
 * visible immediately and only a genuine pre-prompt serialization failure
 * abandons it.
 */
export interface RemotePromptSerializer {
  preflight(prepared: unknown): RemotePreflightResult
  serialize(prepared: unknown, signal?: AbortSignal): Promise<RemoteSerializeResult>
}

function generationChanged(generation: RemoteConnectionGenerationSource, captured: unknown): boolean {
  return !Object.is(captured, generation.getSnapshot())
}

/** A local failure that happens BEFORE the identified prompt dispatch: the Host
 * was never called, so the caller may safely restore its draft (unlike an
 * indeterminate write). */
function preDispatchFailure(code: string, error: unknown): WriteOutcome {
  return {
    kind: 'rejected',
    error: { code, message: safeErrorMessage(error) },
  }
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
   * Resolve and PIN the exact generation for one addressed session after
   * capturing the current generation. A disconnected Client or an unbound
   * session is unavailable; a generation replaced while resolving is a
   * pre-dispatch cancellation. The returned `release()` must run exactly once.
   */
  private resolve<T>(sessionId: string): RemoteResolvedWrite | WriteOutcome<T> | undefined {
    const captured = this.generation.getSnapshot()
    if (captured === undefined) return undefined
    // Borrow first: an absent generation means the addressed Session is not
    // available here. It is never a reason to materialize a cold Session.
    if (this.sessions.binding(sessionId) === undefined) {
      return remoteRejected('session/not-found', `session "${sessionId}" is not available`)
    }
    // A replacement observed between the borrow and the pin means the borrowed
    // generation is already gone; the operation must not dispatch into it.
    const pinned = pinExistingGeneration(this.sessions, sessionId)
    if (pinned === undefined) return remoteNotDispatched()
    if (generationChanged(this.generation, captured)) {
      pinned.release()
      return remoteNotDispatched()
    }
    return { binding: pinned.binding, captured, release: (): void => { pinned.release() } }
  }

  async prompt(sessionId: string, message: unknown, mode: 'queue' | 'steer'): Promise<WriteOutcome> {
    const resolved = this.resolve<undefined>(sessionId)
    if (resolved === undefined) return remoteNotDispatched()
    if ('kind' in resolved) return resolved
    const { binding, captured, release } = resolved
    try {
      // 1. Cheap preflight BEFORE any Host mutation: decide D2.2 support and
      //    extract the echo presentation. An unsupported payload never creates an
      //    official echo.
      let preflight: RemotePreflightResult
      try {
        preflight = this.serializer.preflight(message)
      } catch (error) {
        // No dispatch happened, so this is a known local refusal.
        return preDispatchFailure('session/prompt-preflight-failed', error)
      }
      if (preflight.kind === 'unsupported') {
        return { kind: 'unsupported', reason: preflight.reason }
      }
      if (generationChanged(this.generation, captured)) return remoteNotDispatched()

      // 2. Register the official echo synchronously, BEFORE the potentially
      //    expensive serialization, so the submission is visible immediately
      //    (the official Client contract: beginSubmission precedes serialization).
      let handle: RemoteSubmissionHandle
      try {
        handle = binding.session.beginSubmission({
          mode,
          text: preflight.echo.text,
          attachments: preflight.echo.attachments,
        })
      } catch (error) {
        // Local registration is still BEFORE the prompt dispatch, so the Host
        // was never called: a known refusal, never indeterminate.
        return preDispatchFailure('session/prompt-echo-failed', error)
      }

      // 3. Serialize. This runs AFTER the echo exists, so a failure here is a
      //    genuine pre-prompt failure: abandon the official echo and restore the
      //    caller's draft.
      let serialized: RemoteSerializeResult
      try {
        serialized = await this.serializer.serialize(message)
      } catch (error) {
        handle.abandon()
        return preDispatchFailure('session/prompt-serialize-failed', error)
      }
      if (serialized.kind === 'unsupported') {
        handle.abandon()
        return { kind: 'unsupported', reason: serialized.reason }
      }
      // The pin keeps THIS exact generation alive across the serialization, so
      // a same-id release/re-retain cannot substitute a different binding; only
      // a Connection replacement can still invalidate the dispatch. The
      // identity re-check is the same fence stated explicitly: binding()
      // PRESENCE must never authorize a write, only binding IDENTITY.
      if (generationChanged(this.generation, captured)
        || !Object.is(binding, this.sessions.binding(sessionId))) {
        handle.abandon()
        return remoteNotDispatched()
      }

      // 4. Dispatch. The generated Remote resolves to `RemoteResult` — carrier
      //    failures arrive in the error branch, and only an assembly/programming
      //    defect rejects. A rejection here is therefore NOT an ambiguous write
      //    and must propagate instead of being disguised as `indeterminate`; the
      //    identified echo is never abandoned (the official Client retires it on
      //    an identified prompt failure).
      const result = await binding.session.prompt(serialized.content, mode, undefined, handle.requestId)
      if (result.ok) return { kind: 'committed', value: undefined }
      return classifyRemoteWriteFailure(result.error)
    } finally {
      release()
    }
  }

  async updateQueue(sessionId: string, itemId: string, action: QueueAction): Promise<WriteOutcome> {
    const resolved = this.resolve<undefined>(sessionId)
    if (resolved === undefined) return remoteNotDispatched()
    if ('kind' in resolved) return resolved
    try {
      const result = await resolved.binding.session.updateQueue(itemId, action)
      if (result.ok) return { kind: 'committed', value: undefined }
      return classifyRemoteWriteFailure(result.error)
    } finally {
      resolved.release()
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
    } finally {
      resolved.release()
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
    } finally {
      resolved.release()
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
