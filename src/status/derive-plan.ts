/**
 * Plan status derivation (plan §4.3): the official `planMode.get(agent)`
 * service is the preferred source (it reports the logged effective state
 * AND any pending selection). The `foldPlanMode(events)` fallback is
 * allowed only when the service is absent; pending is then undefined.
 * Pending is NEVER guessed from recent commands.
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

/** The official fold (dsh-plan-mode's foldPlanMode). */
export type PlanFold<E> = (events: readonly E[], end?: number) => boolean

/**
 * Derive the plan section.
 * @param planMode - the official controller, when composed.
 * @param agent - the live agent object the controller reads.
 * @param events - the session events (fallback source).
 * @param fold - the official fold function (fallback).
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
