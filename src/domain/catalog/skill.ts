/**
 * Neutral skill catalog vocabulary (TS8-E): the human-facing skill summary
 * shape, the detached catalog (with its completeness flag) and the official
 * user-invocation policy guard.
 *
 * This module is the transport/UI-neutral semantic owner: it consumes only the
 * official `@deepseek-ai/dsh-skill` policy helper. It never resolves ctx
 * services, acquires standing scopes, holds revision leases, reads a live
 * Agent, or imports a Direct/Remote adapter — the structural Direct Host read
 * lives in `runtime/direct/skill-catalog.ts`.
 * @module @xmoon76/dsh-pi-tui/domain/catalog/skill
 */

import { isUserInvocable } from '@deepseek-ai/dsh-skill'

/** The human-facing slice of one skill: display fields only. */
export interface HumanSkillSummary {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  /** Official model-invocation capability; Host-local paths are omitted. */
  readonly modelInvocable?: boolean
}

/** The detached human skill catalog one observation produced. */
export interface HumanSkillCatalog {
  readonly skills: readonly HumanSkillSummary[]
  /** Whether discovery completed within a stable revision (an incomplete
   * observation must not replace a last-good catalog). */
  readonly complete: boolean
}

/** A summary-shaped entry the registry returns (structural; `snapshot()`
 * returns these with invocation metadata intact). `content` appears on
 * loaded DEFINITIONS (`get()`), never on summaries. */
export interface SkillSummaryLike {
  readonly name: unknown
  readonly description: unknown
  readonly whenToUse?: unknown
  readonly content?: unknown
  readonly provider?: unknown
  readonly resourceBase?: unknown
  readonly invocation?: { readonly modelInvocable?: unknown; readonly userInvocable?: unknown }
}

/**
 * Whether one summary passes the OFFICIAL user-invocation policy — the
 * neutral guard used by every human entry point (direct wrappers, `/skill`,
 * the picker, and final body loads). A malformed `invocation` (missing,
 * non-object, non-boolean flag) is treated as NOT user-invocable: the policy
 * defaults are never reinterpreted, and a hostile entry can neither throw nor
 * sneak into a human surface.
 */
export function isUserInvocableSkill(skill: SkillSummaryLike): boolean {
  const invocation = skill.invocation
  if (typeof invocation !== 'object' || invocation === null) return false
  if (typeof invocation.userInvocable !== 'boolean') return false
  // The official policy function: the guards above already proved the
  // invocation shape, so the cast crosses unknown deliberately.
  return isUserInvocable(skill as unknown as { invocation: { modelInvocable: boolean; userInvocable: boolean } })
}
