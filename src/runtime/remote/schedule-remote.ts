/**
 * The Remote Host Schedule adapter (S5-PR4): the semantic {@link SchedulePort}
 * over the official generated `schedule` Client namespace that the ONE
 * `@deepseek-ai/dsh-schedule/remote` contribution publishes through the
 * authenticated Gateway.
 *
 * Currentness: every operation captures the Connection generation BEFORE it
 * dispatches. A read whose reply (or failure) belongs to a superseded
 * generation is a {@link SupersededReadError}, never the new generation's
 * state. A MUTATION that was dispatched and whose settlement can no longer be
 * proven is a {@link ScheduleOutcomeUnknownError}: the Host may have committed
 * it, the adapter never replays it, and the caller re-reads the authoritative
 * catalog once the connection is back.
 *
 * Invalidations: `onChanged` carries BOTH the Host's post-commit
 * `schedule/changed` notification (through the official forwarded-event
 * stream) and a Connection generation replacement — the latter because a
 * re-subscription or re-read from a previous generation cannot be trusted as
 * the current Host state. Neither carries content, so every listener re-reads.
 *
 * Full contract: docs/architecture/host-client.md (Host Schedule management).
 * @module @xmoon76/dsh-pi-tui/runtime/remote/schedule-remote
 */

import type {
  ScheduleCatalogEntry,
  ScheduleCreateRequest,
  ScheduleDeleteInactiveResult,
  ScheduleDeliveryHistoryRequest,
  ScheduleDeliveryHistoryResult,
  ScheduleDeliveryLimits,
  ScheduleEditRequest,
  ScheduleEditResult,
  ScheduleListRequest,
  ScheduleListResult,
  SchedulePort,
  ScheduleRunRequest,
  ScheduleRunResult,
  ScheduleViewRequest,
  ScheduleViewResult,
} from '../schedule-port.ts'
import { ScheduleOutcomeUnknownError, ScheduleUnavailableError } from '../schedule-port.ts'
import { SupersededReadError } from '../read-error.ts'
import { classifyRemoteWriteFailure, remoteFailureMessage } from './write-failure.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'

/** The official generated `schedule` namespace the mounted contribution
 *  publishes. The concrete methods are typed by the contract module's
 *  `TypertRemoteNamespaceMap` augmentation; this is the slice this adapter
 *  calls. */
export interface RemoteScheduleNamespace {
  catalog(): Promise<RemoteResultLike<readonly ScheduleCatalogEntry[]>>
  create(request: ScheduleCreateRequest, signal?: AbortSignal): Promise<RemoteResultLike<ScheduleCatalogEntry>>
  deleteInactive(): Promise<RemoteResultLike<ScheduleDeleteInactiveResult>>
  deliveryLimits(): Promise<RemoteResultLike<ScheduleDeliveryLimits>>
  edit(request: ScheduleEditRequest, signal?: AbortSignal): Promise<RemoteResultLike<ScheduleEditResult>>
  history(request: ScheduleDeliveryHistoryRequest): Promise<RemoteResultLike<ScheduleDeliveryHistoryResult>>
  list(request: ScheduleListRequest): Promise<RemoteResultLike<ScheduleListResult>>
  run(request: ScheduleRunRequest, signal?: AbortSignal): Promise<RemoteResultLike<ScheduleRunResult>>
  view(request: ScheduleViewRequest): Promise<RemoteResultLike<ScheduleViewResult>>
}

/** The forwarded-event seat this adapter subscribes on: the official
 *  `schedule/changed` key of the ONE Client `$on`. */
export interface RemoteScheduleEvents {
  $on(event: 'schedule/changed', listener: () => void): () => void
}

/** The ONE statement of the Remote capability gap (presentation reads it). */
export const REMOTE_SCHEDULE_UNAVAILABLE_REASON =
  'This Client has no authenticated official Schedule Remote namespace.'

/** The Remote `SchedulePort` adapter over the generated Client namespace. */
export class RemoteSchedulePort implements SchedulePort {
  private readonly namespace: RemoteScheduleNamespace | undefined
  private readonly events: RemoteScheduleEvents | undefined
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    namespace: RemoteScheduleNamespace | undefined,
    events: RemoteScheduleEvents | undefined,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.namespace = namespace
    this.events = events
    this.generation = generation
  }

  catalog(signal?: AbortSignal): Promise<readonly ScheduleCatalogEntry[]> {
    return this.read(signal, namespace => namespace.catalog())
  }

  list(request: ScheduleListRequest, signal?: AbortSignal): Promise<ScheduleListResult> {
    return this.read(signal, namespace => namespace.list(request))
  }

  view(request: ScheduleViewRequest, signal?: AbortSignal): Promise<ScheduleViewResult> {
    return this.read(signal, namespace => namespace.view(request))
  }

  history(
    request: ScheduleDeliveryHistoryRequest,
    signal?: AbortSignal,
  ): Promise<ScheduleDeliveryHistoryResult> {
    return this.read(signal, namespace => namespace.history(request))
  }

  deliveryLimits(signal?: AbortSignal): Promise<ScheduleDeliveryLimits> {
    return this.read(signal, namespace => namespace.deliveryLimits())
  }

  create(request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleCatalogEntry> {
    return this.write('create', signal, namespace => namespace.create(request, signal))
  }

  edit(request: ScheduleEditRequest, signal?: AbortSignal): Promise<ScheduleEditResult> {
    return this.write('edit', signal, namespace => namespace.edit(request, signal))
  }

  run(request: ScheduleRunRequest, signal?: AbortSignal): Promise<ScheduleRunResult> {
    return this.write('run', signal, namespace => namespace.run(request, signal))
  }

  deleteInactive(signal?: AbortSignal): Promise<ScheduleDeleteInactiveResult> {
    return this.write('deleteInactive', signal, namespace => namespace.deleteInactive())
  }

  onChanged(listener: () => void): () => void {
    const disposeEvent = this.events?.$on('schedule/changed', listener)
    // A Connection replacement invalidates every projection of the previous
    // generation, including a `schedule/changed` subscription made on it.
    const disposeGeneration = this.generation.subscribe(listener)
    return () => {
      disposeEvent?.()
      disposeGeneration()
    }
  }

  /** The ONE namespace, or the truthful unavailable refusal. */
  private namespaceOrThrow(): RemoteScheduleNamespace {
    if (this.namespace === undefined) throw new ScheduleUnavailableError(REMOTE_SCHEDULE_UNAVAILABLE_REASON)
    if (this.generation.getSnapshot() === undefined) {
      throw new ScheduleUnavailableError('This Client is not connected to a Host.')
    }
    return this.namespace
  }

  /** One generation-fenced read: a reply or failure from a superseded
   *  generation is never presented as the current Host state. */
  private async read<T>(
    signal: AbortSignal | undefined,
    call: (namespace: RemoteScheduleNamespace) => Promise<RemoteResultLike<T>>,
  ): Promise<T> {
    signal?.throwIfAborted()
    const namespace = this.namespaceOrThrow()
    const captured = this.generation.getSnapshot()
    const stillCurrent = (): boolean => Object.is(captured, this.generation.getSnapshot())
    let result: RemoteResultLike<T>
    try {
      result = await call(namespace)
    } catch (error) {
      if (!stillCurrent()) throw new SupersededReadError('schedule read superseded by a new Connection generation')
      throw error
    }
    if (!stillCurrent()) throw new SupersededReadError('schedule read superseded by a new Connection generation')
    signal?.throwIfAborted()
    if (!result.ok) throw result.error
    return result.value
  }

  /**
   * One generation-fenced mutation. Reaching the Host is proven only by a
   * reply settled inside the SAME generation: anything else — a transport
   * failure, a cancellation that raced the Host transaction, or a reply that
   * lands after the generation was replaced — is a dispatched write with an
   * UNKNOWN outcome, never a replay and never a claimed rollback.
   */
  private async write<T>(
    operation: string,
    signal: AbortSignal | undefined,
    call: (namespace: RemoteScheduleNamespace) => Promise<RemoteResultLike<T>>,
  ): Promise<T> {
    signal?.throwIfAborted()
    const namespace = this.namespaceOrThrow()
    const captured = this.generation.getSnapshot()
    const stillCurrent = (): boolean => Object.is(captured, this.generation.getSnapshot())
    let result: RemoteResultLike<T>
    try {
      result = await call(namespace)
    } catch (error) {
      // A proven business/pre-invocation refusal definitely did not commit; a
      // cancellation or transport failure that raced the Host transaction
      // did not prove that.
      if (classifyRemoteWriteFailure(error).kind === 'rejected') throw error
      throw new ScheduleOutcomeUnknownError(
        `Schedule ${operation} was dispatched but its outcome could not be proven: ${remoteFailureMessage(error)}`,
        { cause: error },
      )
    }
    if (!stillCurrent()) {
      throw new ScheduleOutcomeUnknownError(
        `Schedule ${operation} settled in a superseded Connection generation; re-read the Host before retrying.`,
      )
    }
    if (!result.ok) {
      const failure = classifyRemoteWriteFailure(result.error)
      if (failure.kind !== 'rejected') {
        throw new ScheduleOutcomeUnknownError(
          `Schedule ${operation} was refused without a proven non-commit: ${remoteFailureMessage(result.error)}`,
          { cause: result.error },
        )
      }
      throw result.error
    }
    return result.value
  }
}
