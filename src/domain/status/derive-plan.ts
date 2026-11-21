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
 * @module @xmoon76/dsh-pi-tui/domain/status/derive-plan
 */

import type { PlanStatus } from './types.ts'

/** The official plan-mode controller surface (structural). */
export interface PlanModeLike {
  get(agent: unknown): { active: boolean; pending?: boolean }
}

/** The official `plan` projection's internal state. The wire view derives
 *  `pending` from `wanted`/`running`; `active` is the committed flag. */
export interface PlanProjectionState {
  readonly active: boolean
  readonly wanted: boolean | null
  readonly running: { readonly wanted: boolean } | null
}

/** The official projection registry surface (structural). DSH 0.2.2 narrowed
 *  the deprecated string-key read to `unknown` (the typed per-key handle is the
 *  supported route; this fallback read is deferred S2 work), so the ONE
 *  `stateOf` caller asserts the plan shape at this boundary. */
export interface PlanProjectionLike {
  stateOf(session: unknown, key: 'plan'): unknown
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
      const state = projections.stateOf(session, 'plan') as PlanProjectionState | undefined
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
    return (projections.stateOf(session, 'plan') as PlanProjectionState | undefined)?.active
  } catch {
    return undefined
  }
}

/**
 * Derive the plan section from the Remote-branch `plan` projection wire view
 * (M3-4 PR2): `{ active, pending }` is the official whole-value shape, so the
 * mapping is direct — a foreign-shaped value reads `effective: false` never
 * a guessed pending.
 */
export function deriveRemotePlanStatus(
  plan: { readonly active: boolean; readonly pending: boolean } | undefined,
): PlanStatus {
  if (plan === undefined) return { effective: false }
  return plan.pending ? { effective: plan.active, pending: true } : { effective: plan.active }
}
