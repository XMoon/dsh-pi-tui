/**
 * Plan status derivation (plan §4.3): the official `planMode.get(agent)`
 * service is the preferred source (it reports the logged effective state
 * AND any pending selection). When the service is absent, the official
 * `plan` projection state is read through the projection registry — the
 * TUI never re-folds plan events itself (no second event fold). When
 * neither is available the plan fact degrades to the neutral
 * `{ effective: false }`; pending is NEVER guessed from recent commands.
 *
 * The module stays free of Host type imports (the boundary gate): the
 * runner instantiates it with the real services.
 * @module @xmoon76/dsh-pi-tui/status/derive-plan
 */

import type { PlanStatus } from './types.ts'

/** The official plan-mode controller surface (structural). */
export interface PlanModeLike {
  get(agent: unknown): { active: boolean; pending?: boolean }
}

/** The official projection registry surface (structural) — the `plan`
 * projection's internal state. The wire view derives `pending` from
 * `wanted`/`running`; `active` is the committed flag. */
export interface PlanProjectionLike {
  stateOf(session: unknown, key: 'plan'): {
    active: boolean
    wanted: boolean | null
    running: { wanted: boolean } | null
  } | undefined
}

/**
 * Derive the plan section.
 * @param planMode - the official controller, when composed.
 * @param agent - the live agent object the controller reads.
 * @param projections - the official projection registry, when composed.
 * @param session - the live session the projection reads.
 */
export function derivePlanStatus(
  planMode: PlanModeLike | undefined,
  agent: unknown | undefined,
  projections: PlanProjectionLike | undefined,
  session: unknown | undefined,
): PlanStatus {
  if (planMode !== undefined && agent !== undefined) {
    try {
      const state = planMode.get(agent)
      return state.pending === undefined
        ? { effective: state.active }
        : { effective: state.active, pending: state.pending }
    } catch {
      // A throwing controller degrades to the projection fallback.
    }
  }
  if (projections !== undefined && session !== undefined) {
    try {
      const state = projections.stateOf(session, 'plan')
      if (state !== undefined) {
        // The projection's wire view: a wanted change that differs from the
        // committed active state is pending.
        const wanted = state.running?.wanted ?? state.wanted
        const pending = wanted !== null && wanted !== state.active
        return pending ? { effective: state.active, pending } : { effective: state.active }
      }
    } catch {
      // A throwing projection read degrades to an absent fact.
    }
  }
  return { effective: false }
}

/**
 * Read the committed plan-mode flag from the official `plan` projection
 * (the projection's `active` view). `undefined` when the registry or the
 * projection is unavailable — the TUI never re-folds plan events.
 */
export function projectedPlanActive(
  projections: PlanProjectionLike | undefined,
  session: unknown,
): boolean | undefined {
  if (projections === undefined || session === undefined) return undefined
  try {
    return projections.stateOf(session, 'plan')?.active
  } catch {
    return undefined
  }
}
