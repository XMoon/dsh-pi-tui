/**
 * Plan status derivation (plan §4.3): the official `planMode.get(agent)`
 * service is the preferred source (it reports the logged effective state
 * AND any pending selection). The local fold fallback is allowed only when
 * the service is absent; pending is then undefined. Pending is NEVER
 * guessed from recent commands.
 *
 * The module is generic over the event type so it stays free of Host type
 * imports (the boundary gate): the runner instantiates it with the real
 * session event type.
 * @module @xmoon76/dsh-pi-tui/status/derive-plan
 */

import type { PlanStatus } from './types.ts'

/** The official plan-mode controller surface (structural). */
export interface PlanModeLike {
  get(agent: unknown): { active: boolean; pending?: boolean }
}

/** The local plan-mode fold (dsh-plan-mode's removed `foldPlanMode`). */
export type PlanFold<E> = (events: readonly E[], end?: number) => boolean

/**
 * Fold the logged effective plan-mode flag: the last `plan/mode` event's
 * `active` value (false before any selection). DSH 0.1.2-alpha.2 removed
 * dsh-plan-mode's exported fold in favor of the `plan` projection; this
 * mirrors the projection's `active` view exactly (the projection changes
 * `active` only on `plan/mode` — `command/run`/`command/done` only feed
 * the pending intent, which the service reports and this fallback never
 * guesses).
 */
export function foldPlanMode<E extends { type: string }>(
  events: readonly E[],
  end: number = events.length,
): boolean {
  let active = false
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index += 1
    if (event.type === 'plan/mode') {
      const data = (event as { data?: { active?: unknown } }).data
      active = data?.active === true
    }
  }
  return active
}

/**
 * Derive the plan section.
 * @param planMode - the official controller, when composed.
 * @param agent - the live agent object the controller reads.
 * @param events - the session events (fallback source).
 * @param fold - the local fold function (fallback).
 */
export function derivePlanStatus<E>(
  planMode: PlanModeLike | undefined,
  agent: unknown | undefined,
  events: readonly E[],
  fold: PlanFold<E>,
): PlanStatus {
  if (planMode !== undefined && agent !== undefined) {
    try {
      const state = planMode.get(agent)
      return state.pending === undefined
        ? { effective: state.active }
        : { effective: state.active, pending: state.pending }
    } catch {
      // A throwing controller degrades to the fold fallback.
    }
  }
  return { effective: fold(events) }
}
