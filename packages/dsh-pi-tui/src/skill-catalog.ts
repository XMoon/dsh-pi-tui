/**
 * The standing-scope skill catalog adapter: the SINGLE narrow seam between
 * the TUI and the dsh skill services (the non-public-API isolation
 * contract, plan appendix B).
 *
 * Everything the TUI knows about dsh-skill and agent-presets lives here:
 * - structural service types (never upstream classes) with OPTIONAL
 *   capability members — `snapshot` and `standingKeyFor` are detected at
 *   call time, so an upstream change degrades instead of breaking;
 * - `readHumanSkillCatalog()`: snapshot-first collector (list() fallback),
 *   official `isUserInvocable` filter, field validation, stable sort,
 *   deep freeze, distinct abort propagation;
 * - `resolveColdSkillTarget()`: capability-gated cold target selection
 *   (standing scope → rosterless global → degraded global with a notice);
 * - `resolveLiveSkillTarget()`: the agent's own registry + agent scope.
 *
 * Failure contract: ordinary provider/composition failures surface as
 * degraded targets or rethrown errors for the coordinator to classify;
 * aborts ALWAYS propagate as aborts. No failure may hang or crash the TUI —
 * the worst outcome is "the corresponding commands are missing".
 * @module @xmoon76/dsh-pi-tui/skill-catalog
 */

import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import { safeErrorMessage } from './error-boundary.ts'

/** The human-facing slice of one skill: display fields only. */
export interface HumanSkillSummary {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
}

/** The detached human skill catalog one observation produced. */
export interface HumanSkillCatalog {
  readonly skills: readonly HumanSkillSummary[]
  /** Whether discovery completed within a stable revision (an incomplete
   * observation must not replace a last-good catalog). */
  readonly complete: boolean
}

/** Read options (structural mirror of the upstream view options; keeps the
 * adapter decoupled from upstream type shapes). */
export interface SkillCatalogReadOptions {
  readonly cwd?: string
  /** The view scope: a preset standing key, a live Agent, or undefined for
   * the global layer. */
  readonly scope?: object
  readonly signal?: AbortSignal
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

/** The dsh-skill registry as the adapter sees it. `snapshot` is OPTIONAL:
 * its absence selects the list() compatibility path (capability detection). */
export interface SkillRegistryLike {
  snapshot?(options: SkillCatalogReadOptions): Promise<{ skills: readonly SkillSummaryLike[]; complete: boolean }>
  list?(options: SkillCatalogReadOptions): Promise<readonly SkillSummaryLike[]>
  get?(name: string, options: SkillCatalogReadOptions): Promise<SkillSummaryLike | undefined>
}

/** The agent-presets service as the adapter sees it. `standingKeyFor` is
 * OPTIONAL: its absence (or failure) degrades the cold target to the
 * global layer. */
export interface AgentPresetsLike {
  standingKeyFor?(id?: string): Promise<object>
  serviceFor?(agent: { ctx: unknown }, name: 'skills'): SkillRegistryLike | undefined
}

/** The context surface the adapter resolves services from. */
export interface SkillCatalogContext {
  get(name: 'skills'): SkillRegistryLike | undefined
  get(name: 'agentPresets'): AgentPresetsLike | undefined
}

/** The Cordis event surface the `skills/change` subscription needs
 * (structural; an absent `on` degrades to no subscription). */
export interface SkillCatalogEventsContext {
  on?(event: 'skills/change', listener: () => void): unknown
}

/**
 * Subscribe to the dsh-skill invalidation notification. The event carries
 * no scope or cwd — consumers refetch for their own cwd and scope — and the
 * subscription itself is optional: an unavailable `on` or a throwing
 * subscribe degrades to NO subscription (owner switches and `/reload` still
 * refresh). The CALLER owns the listener's failure totality (route the
 * refresh through `runOwned`).
 * @param ctx - the context surface exposing the event bus.
 * @param listener - the notification listener (must be synchronous and
 *   never throw).
 */
export function subscribeSkillsChange(ctx: SkillCatalogEventsContext, listener: () => void): void {
  ctx.on?.('skills/change', listener)
}

/**
 * Whether one summary passes the OFFICIAL user-invocation policy — the
 * adapter's exported guard, used by every human entry point (direct
 * wrappers, `/skill`, the picker, and final body loads). A malformed
 * `invocation` (missing, non-object, non-boolean flag) is treated as NOT
 * user-invocable: the policy defaults are never reinterpreted, and a
 * hostile entry can neither throw nor sneak into a human surface.
 */
export function isUserInvocableSkill(skill: SkillSummaryLike): boolean {
  const invocation = skill.invocation
  if (typeof invocation !== 'object' || invocation === null) return false
  if (typeof invocation.userInvocable !== 'boolean') return false
  // The official policy function: the guards above already proved the
  // invocation shape, so the cast crosses unknown deliberately.
  return isUserInvocable(skill as unknown as { invocation: { modelInvocable: boolean; userInvocable: boolean } })
}

/** One readable catalog target. */
export type SkillCatalogTarget =
  | { readonly kind: 'cold-standing'; readonly registry: SkillRegistryLike; readonly cwd: string; readonly scope: object }
  | { readonly kind: 'cold-global'; readonly registry: SkillRegistryLike; readonly cwd: string; readonly scope: undefined }
  | { readonly kind: 'live'; readonly registry: SkillRegistryLike; readonly cwd: string; readonly scope: object }

/** The outcome of a cold target resolution. */
export interface ColdSkillTargetResolution {
  readonly target?: SkillCatalogTarget
  /** One-shot user notice when the standing path degraded to the global
   * layer (absent when nothing degraded). */
  readonly degraded?: string
}

/** Copy one summary, keeping ONLY the supported display fields. An entry
 * with a non-string name or description is rejected (never copied, never
 * trusted); a non-string `whenToUse` is dropped. */
function toHumanSummary(skill: SkillSummaryLike): HumanSkillSummary | undefined {
  if (typeof skill.name !== 'string' || skill.name === '') return undefined
  if (typeof skill.description !== 'string') return undefined
  return Object.freeze({
    name: skill.name,
    description: skill.description,
    ...typeof skill.whenToUse === 'string' && skill.whenToUse !== ''
      ? { whenToUse: skill.whenToUse }
      : {},
  })
}

/** Whether one summary passes the OFFICIAL user-invocation policy. A
 * malformed `invocation` (missing, non-object, non-boolean flag) is treated
 * as NOT user-invocable — the policy defaults are never reinterpreted, and
 * a hostile entry can neither throw nor sneak into the human catalog. */
function userInvocable(skill: SkillSummaryLike): boolean {
  return isUserInvocableSkill(skill)
}

/**
 * Read one human skill catalog from a registry: snapshot-first, official
 * policy filter, validated detached copies, stable name sort, deep freeze.
 * @param registry - the registry to read (the adapter's structural type).
 * @param options - cwd/scope/signal for the read.
 * @returns the detached catalog.
 * @throws on cancellation (ALWAYS, distinctly) and on non-abort read
 *   failures (the coordinator classifies them: retain last-good + diag).
 */
export async function readHumanSkillCatalog(
  registry: SkillRegistryLike,
  options: SkillCatalogReadOptions,
): Promise<HumanSkillCatalog> {
  options.signal?.throwIfAborted()
  const observed = typeof registry.snapshot === 'function'
    ? await registry.snapshot(options)
    : { skills: await registry.list?.(options) ?? [], complete: true }
  // Re-check after the await: a read that settled past an abort is stale.
  options.signal?.throwIfAborted()
  const skills = observed.skills
    .filter(userInvocable)
    .map(toHumanSummary)
    .filter((summary): summary is HumanSkillSummary => summary !== undefined)
    .sort((left, right) => left.name < right.name ? -1 : 1)
  return Object.freeze({
    skills: Object.freeze(skills),
    complete: observed.complete === true,
  })
}

/**
 * Resolve the COLD (sessionless) skill target with capability detection:
 * - a preset roster with `standingKeyFor` → the standing scope of the
 *   effective preset;
 * - no roster / no `standingKeyFor` / a standing resolution failure → the
 *   global layer (with a one-shot degradation notice on failure);
 * - no skill registry at all → no target (nothing to read, no notice).
 * @param ctx - the context surface.
 * @param presetId - the effective preset id, or undefined for the default.
 * @param cwd - the workspace cwd for provider selection.
 */
export async function resolveColdSkillTarget(
  ctx: SkillCatalogContext,
  presetId: string | undefined,
  cwd: string,
): Promise<ColdSkillTargetResolution> {
  const registry = ctx.get('skills')
  if (registry === undefined) return {}
  const presets = ctx.get('agentPresets')
  if (presets === undefined || typeof presets.standingKeyFor !== 'function') {
    // Rosterless deployment: the global layer is the correct cold view.
    return { target: { kind: 'cold-global', registry, cwd, scope: undefined } }
  }
  try {
    const scope = await presets.standingKeyFor(presetId)
    return { target: { kind: 'cold-standing', registry, cwd, scope } }
  } catch (error) {
    // Unknown/broken preset or a mount failure: degrade to the global view
    // with a one-shot notice. Never fall back to creating a probe Agent.
    const message = safeErrorMessage(error)
    return {
      target: { kind: 'cold-global', registry, cwd, scope: undefined },
      degraded: `skill catalog unavailable for preset "${presetId ?? 'default'}": ${message}`,
    }
  }
}

/**
 * Resolve the LIVE skill target: the registry the agent actually sees
 * (its preset's scoped instance when the preset mounts one, else the host
 * registry), with the AGENT OBJECT as the view scope.
 * @param ctx - the context surface.
 * @param agent - the live agent.
 * @param cwd - the session workspace cwd.
 * @returns the live target, or undefined when no registry is reachable.
 */
export function resolveLiveSkillTarget(
  ctx: SkillCatalogContext,
  agent: { ctx: unknown },
  cwd: string,
): SkillCatalogTarget | undefined {
  const presets = ctx.get('agentPresets')
  const registry = presets?.serviceFor?.(agent, 'skills') ?? ctx.get('skills')
  if (registry === undefined) return undefined
  return { kind: 'live', registry, cwd, scope: agent }
}
