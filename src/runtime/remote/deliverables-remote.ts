/**
 * The experimental Remote delivered-file read adapter (Delivered files PR2 /
 * M11): the semantic {@link DeliveredFileReadPort} over the OFFICIAL generated
 * `workspaceFiles` Remote namespace.
 *
 * The Host remains the only authority for the Session's workspace scope, the
 * byte/line caps and the refusal taxonomy; this adapter owns no workspace
 * truth and never falls back to a Direct read or the Client filesystem.
 *
 * CURRENTNESS: the Connection generation is captured BEFORE dispatch and
 * compared after it — a reply (success OR refusal) carried by a superseded
 * generation is stale, so it becomes the repository's existing
 * `SupersededReadError` instead of the new generation's definite outcome. An
 * unchanged generation preserves the official refusal (mapped to the port's
 * vocabulary) and the caller's own cancellation.
 *
 * Full contract: docs/architecture/host-client.md.
 * @module @xmoon76/dsh-pi-tui/runtime/remote/deliverables-remote
 */

import { SupersededReadError } from '../read-error.ts'
import { DELIVERED_FILE_PAGE_LINES, DeliveredFileReadError, deliveredFileReadErrorFrom, type DeliveredFilePage, type DeliveredFileReadPort, type DeliveredFileStat } from '../deliverables-port.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'

/** The official `WorkspaceFileStat` fields the preview consumes. */
interface WorkspaceFileStatLike {
  readonly version: string
  readonly bytes?: number
}

/** The official `WorkspaceFileText` fields the preview consumes. */
interface WorkspaceFileTextLike extends WorkspaceFileStatLike {
  readonly text: string
  readonly lines: number
  readonly eof: boolean
}

/**
 * The generated `workspaceFiles` namespace slice this adapter calls. It is the
 * official generated shape (Session identity first, the Host resolves the
 * scope), kept structural so the adapter stays a semantic port.
 */
export interface RemoteWorkspaceFilesNamespace {
  stat(
    sessionId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<RemoteResultLike<WorkspaceFileStatLike>>
  read(
    sessionId: string,
    path: string,
    range: { readonly offset?: number; readonly limit?: number },
    signal?: AbortSignal,
  ): Promise<RemoteResultLike<WorkspaceFileTextLike>>
}

function statOf(value: WorkspaceFileStatLike): DeliveredFileStat {
  return value.bytes === undefined
    ? { version: value.version }
    : { version: value.version, bytes: value.bytes }
}

/** One official result's business value, or its refusal thrown. */
function unwrap<T>(result: RemoteResultLike<T>): T {
  if (!result.ok) throw result.error
  return result.value
}

/** Remote delivered-file reads over the generated `workspaceFiles` namespace. */
export class RemoteDeliveredFileReadPort implements DeliveredFileReadPort {
  private readonly namespace: RemoteWorkspaceFilesNamespace | undefined
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    namespace: RemoteWorkspaceFilesNamespace | undefined,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.namespace = namespace
    this.generation = generation
  }

  async stat(sessionId: string, path: string, signal: AbortSignal): Promise<DeliveredFileStat> {
    return statOf(await this.fenced('stat', signal, namespace => namespace.stat(sessionId, path, signal)))
  }

  async read(
    sessionId: string,
    path: string,
    offset: number,
    signal: AbortSignal,
  ): Promise<DeliveredFilePage> {
    const limit = DELIVERED_FILE_PAGE_LINES
    const page = await this.fenced('read', signal, namespace =>
      namespace.read(sessionId, path, { offset, limit }, signal))
    return { stat: statOf(page), offset, limit, text: page.text, lines: page.lines, eof: page.eof }
  }

  /**
   * One Remote read fenced to the Connection generation captured BEFORE
   * dispatch. `operation` names the intent in the stale diagnostic.
   */
  private async fenced<T>(
    operation: string,
    signal: AbortSignal,
    call: (namespace: RemoteWorkspaceFilesNamespace) => Promise<RemoteResultLike<T>>,
  ): Promise<T> {
    const namespace = this.namespace
    // The namespace is mounted by the Client contribution; a Host/connection
    // without it is a definite "unavailable", never a Direct or Client fallback.
    if (namespace === undefined) {
      throw new DeliveredFileReadError('service-unavailable', 'the workspaceFiles Remote namespace is not mounted')
    }
    if (signal.aborted) throw abortReason(signal)
    const captured = this.generation.getSnapshot()
    const stillCurrent = (): boolean => Object.is(captured, this.generation.getSnapshot())
    let value: T
    try {
      value = unwrap(await call(namespace))
    } catch (error) {
      // The caller's own cancellation is not a Host outcome.
      if (signal.aborted) throw abortReason(signal)
      // A refusal or a transport rejection is just as generation-bound as a
      // success: a stale failure must never be presented as the NEW
      // generation's definite state.
      if (!stillCurrent()) throw new SupersededReadError(`delivered file ${operation} superseded`)
      throw deliveredFileReadErrorFrom(error)
    }
    if (!stillCurrent()) throw new SupersededReadError(`delivered file ${operation} superseded`)
    return value
  }
}

/** The caller's cancellation reason (an `Error` for every standard abort). */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('delivered file read aborted')
}
