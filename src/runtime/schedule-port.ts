/**
 * The Host Schedule management port (S5-PR4): ONE transport-neutral semantic
 * capability over the official Host Schedule domain. Direct forwards to the
 * in-process `ctx.schedule` service; Remote forwards to the official generated
 * `schedule` Client namespace. Both carry the SAME official value types, so a
 * task record, a delivery receipt, a CAS revision and an official refusal code
 * mean exactly the same thing on either transport — there is no second task
 * store, no Client cron and no UI-shaped DTO of a Host fact.
 *
 * `signal` is a CLIENT-LOCAL cancellation/currentness fence, never a wire
 * parameter: the official Remote signatures that accept one receive it, and
 * the read operations that have no cancellation parameter are checked before
 * and after the awaited call.
 *
 * Full contract: docs/architecture/host-client.md (Host Schedule management).
 * @module @xmoon76/dsh-pi-tui/runtime/schedule-port
 */

import type {
  ScheduleCatalogEntry,
  ScheduleCreateRequest,
  ScheduleDeleteInactiveResult,
  ScheduleDeliveryHistoryRequest,
  ScheduleDeliveryHistoryResult,
  ScheduleEditRequest,
  ScheduleEditResult,
  ScheduleListRequest,
  ScheduleListResult,
  SchedulePatch,
  ScheduleRecord,
  ScheduleRunRequest,
  ScheduleRunResult,
  ScheduleSessionCreateSpec,
  ScheduleTargetRequest,
  ScheduleTiming,
  ScheduleViewRequest,
  ScheduleViewResult,
} from '@deepseek-ai/dsh-schedule/client'

export type {
  ScheduleCatalogEntry,
  ScheduleCreateRequest,
  ScheduleDeleteInactiveResult,
  ScheduleDeliveryHistoryRequest,
  ScheduleDeliveryHistoryResult,
  ScheduleEditRequest,
  ScheduleEditResult,
  ScheduleListRequest,
  ScheduleListResult,
  SchedulePatch,
  ScheduleRecord,
  ScheduleRunRequest,
  ScheduleRunResult,
  ScheduleSessionCreateSpec,
  ScheduleTargetRequest,
  ScheduleTiming,
  ScheduleViewRequest,
  ScheduleViewResult,
}

/** The Host's own delivery floor between two Session-creating deliveries. */
export interface ScheduleDeliveryLimits {
  readonly newSessionIntervalSeconds: number
}

/**
 * The ONE truthful "this backend serves no Schedule domain" failure. It is
 * thrown when the Direct Host mounts no `schedule` service or the authenticated
 * Remote composition exposes no `schedule` namespace; it is never replaced by
 * an empty catalog, a Client-side store or a Direct fallback write.
 */
export class ScheduleUnavailableError extends Error {
  readonly code = 'schedule_unavailable'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ScheduleUnavailableError'
  }
}

/**
 * A mutation that was DISPATCHED but whose settlement the current Client can no
 * longer prove (the Connection generation was replaced, the transport failed,
 * or a cancellation raced the Host transaction). The Host may still have
 * committed it, so the caller must re-read the authoritative catalog and must
 * NEVER replay the write. This is the ONE unknown-outcome error: an official
 * refusal keeps its own code and is never reported through this type.
 */
export class ScheduleOutcomeUnknownError extends Error {
  readonly code = 'schedule_outcome_unknown'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ScheduleOutcomeUnknownError'
  }
}

/**
 * The Host Schedule management surface. Every method returns the OFFICIAL
 * value or throws; a refusal that the official API models as a value
 * (`schedule_not_found`, `schedule_conflict`, `schedule_execution_pending`,
 * `delivery_cursor_not_found`, `{deleted: 0}`) is returned unchanged, so the
 * caller can never mistake a refusal for a success entry.
 */
export interface SchedulePort {
  /** Every Host task, active first, with target and execution metadata. */
  catalog(signal?: AbortSignal): Promise<readonly ScheduleCatalogEntry[]>
  /** One page of the Host task list. */
  list(request: ScheduleListRequest, signal?: AbortSignal): Promise<ScheduleListResult>
  /** One task by identity, or the official non-mutating `schedule_not_found`. */
  view(request: ScheduleViewRequest, signal?: AbortSignal): Promise<ScheduleViewResult>
  /** One newest-first page of saved deliveries. */
  history(
    request: ScheduleDeliveryHistoryRequest,
    signal?: AbortSignal,
  ): Promise<ScheduleDeliveryHistoryResult>
  /** The effective new-Session delivery floor, without activating a Session. */
  deliveryLimits(signal?: AbortSignal): Promise<ScheduleDeliveryLimits>
  /** Create one Host task with a Host-generated identity. */
  create(request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleCatalogEntry>
  /** Apply one atomic CAS update or delete. */
  edit(request: ScheduleEditRequest, signal?: AbortSignal): Promise<ScheduleEditResult>
  /** Deliver one task now without consuming its scheduled occurrence. */
  run(request: ScheduleRunRequest, signal?: AbortSignal): Promise<ScheduleRunResult>
  /** Remove every ended Host task. */
  deleteInactive(signal?: AbortSignal): Promise<ScheduleDeleteInactiveResult>
  /**
   * Subscribe to the Host's post-commit `schedule/changed` notification. The
   * event carries NO content: it only invalidates, so a listener re-reads the
   * authoritative catalog. Returns the unsubscribe.
   */
  onChanged(listener: () => void): () => void
}
