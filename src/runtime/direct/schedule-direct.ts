/**
 * The Direct Host Schedule adapter (S5-PR4): the semantic {@link SchedulePort}
 * over the ONE in-process official `ctx.schedule` service.
 *
 * Locality: the task store, the timer, the session FIFO, the delivery receipts
 * and the CAS revision are ALL Host-owned by `@deepseek-ai/dsh-schedule`. This
 * adapter owns no store, no cache and no timer; it resolves the service per
 * operation (a Host that mounts no Schedule domain answers the one truthful
 * unavailable error instead of an empty catalog), forwards the official
 * methods and maps nothing.
 *
 * The human management surface uses the official `remote*` forms for the
 * methods that have one (`remoteList`/`remoteHistory`/`remoteCreate`/
 * `remoteEdit`): the TUI is not an Agent acting on its own Session, so no
 * actor Session becomes "involved" and the validated Remote argument rules
 * apply exactly as they do for the official Web UI.
 *
 * Full contract: docs/architecture/host-client.md (Host Schedule management).
 * @module @xmoon76/dsh-pi-tui/runtime/direct/schedule-direct
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
import { ScheduleUnavailableError } from '../schedule-port.ts'

/**
 * The structural Host context the adapter reads: the SAME narrow `get`/`on`
 * seam the other Direct adapters use. The official service objects converge to
 * the structural faces below only at this adapter boundary.
 */
export interface DirectScheduleHostContext {
  get(name: string): unknown
  on(event: 'schedule/changed', listener: () => void): () => boolean
}

/** The official Host Schedule service surface this adapter consumes. */
interface HostScheduleServiceLike {
  catalog(): Promise<ScheduleCatalogEntry[]>
  remoteList(request: ScheduleListRequest): Promise<ScheduleListResult>
  view(request: ScheduleViewRequest): Promise<ScheduleViewResult>
  remoteHistory(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult>
  deliveryLimits(): ScheduleDeliveryLimits
  remoteCreate(request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleCatalogEntry>
  remoteEdit(request: ScheduleEditRequest, signal?: AbortSignal): Promise<ScheduleEditResult>
  run(request: ScheduleRunRequest, signal?: AbortSignal): Promise<ScheduleRunResult>
  deleteInactive(): Promise<ScheduleDeleteInactiveResult>
}

/** The ONE statement of the Direct capability gap (presentation reads it). */
export const DIRECT_SCHEDULE_UNAVAILABLE_REASON =
  'This Host did not mount the official Schedule domain.'

/** The Direct `SchedulePort` adapter over the in-process Host service. */
export class DirectSchedulePort implements SchedulePort {
  private readonly ctx: DirectScheduleHostContext

  constructor(ctx: DirectScheduleHostContext) {
    this.ctx = ctx
  }

  catalog(signal?: AbortSignal): Promise<readonly ScheduleCatalogEntry[]> {
    return this.read(signal, async service => service.catalog())
  }

  list(request: ScheduleListRequest, signal?: AbortSignal): Promise<ScheduleListResult> {
    return this.read(signal, async service => service.remoteList(request))
  }

  view(request: ScheduleViewRequest, signal?: AbortSignal): Promise<ScheduleViewResult> {
    return this.read(signal, async service => service.view(request))
  }

  history(
    request: ScheduleDeliveryHistoryRequest,
    signal?: AbortSignal,
  ): Promise<ScheduleDeliveryHistoryResult> {
    return this.read(signal, async service => service.remoteHistory(request))
  }

  async deliveryLimits(signal?: AbortSignal): Promise<ScheduleDeliveryLimits> {
    signal?.throwIfAborted()
    const service = this.service()
    const limits = service.deliveryLimits()
    signal?.throwIfAborted()
    return limits
  }

  create(request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleCatalogEntry> {
    // The official write form checks the caller's cancellation after its FIFO
    // wait, so the signal travels INTO the Host call, not only around it.
    return this.write(signal, async service => service.remoteCreate(request, signal))
  }

  edit(request: ScheduleEditRequest, signal?: AbortSignal): Promise<ScheduleEditResult> {
    return this.write(signal, async service => service.remoteEdit(request, signal))
  }

  run(request: ScheduleRunRequest, signal?: AbortSignal): Promise<ScheduleRunResult> {
    return this.write(signal, async service => service.run(request, signal))
  }

  deleteInactive(signal?: AbortSignal): Promise<ScheduleDeleteInactiveResult> {
    return this.write(signal, async service => service.deleteInactive())
  }

  onChanged(listener: () => void): () => void {
    // The Host commits the notification only after its durable write landed;
    // the event carries no content, so a listener re-reads the catalog.
    return this.ctx.on('schedule/changed', listener)
  }

  /** The ONE Host service, or the truthful unavailable refusal. */
  private service(): HostScheduleServiceLike {
    const service = this.ctx.get('schedule') as HostScheduleServiceLike | undefined
    if (service === undefined) throw new ScheduleUnavailableError(DIRECT_SCHEDULE_UNAVAILABLE_REASON)
    return service
  }

  /** A read has no official cancellation parameter: the fence is checked on
   *  both sides of the awaited Host call. */
  private async read<T>(
    signal: AbortSignal | undefined,
    call: (service: HostScheduleServiceLike) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted()
    const value = await call(this.service())
    signal?.throwIfAborted()
    return value
  }

  /** A mutation passes the signal to the official Host form, which observes it
   *  after entering its serialized queue. An abort after dispatch never
   *  pretends the durable write was rolled back. */
  private async write<T>(
    signal: AbortSignal | undefined,
    call: (service: HostScheduleServiceLike) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted()
    return call(this.service())
  }
}
