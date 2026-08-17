/**
 * Surface catalog snapshot: the frozen, detached command + human-skill views
 * a surface needs before the first input arrives. The collector reads the
 * EFFECTIVE catalogs one agent sees — `commands.list(agent)` (global layer
 * plus agent-scoped shadows) and the agent-scoped skill service filtered by
 * the official user-invocation policy — and returns plain frozen data that
 * survives the agent's disposal.
 *
 * Only discovery metadata crosses the boundary: command HANDLERS and skill
 * BODIES never enter a snapshot, and nothing here holds an Agent, a service,
 * or a provider. Execution always re-binds to the live agent later.
 * @module @xmoon76/dsh-pi-tui/surface-catalog
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { safeErrorMessage } from './error-boundary.ts'
import {
  readHumanSkillCatalog,
  resolveLiveSkillTarget,
  type HumanSkillSummary,
  type SkillCatalogContext,
} from './skill-catalog.ts'

/** One effective command's discovery metadata (the official descriptor's
 * display fields; never a handler or a definition). */
export interface SurfaceCommandSummary {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
}

/** One provider's detached failure text (never the thrown value itself). */
export interface SurfaceCatalogIssue {
  readonly provider: 'commands' | 'skills'
  readonly message: string
}

/**
 * The complete frozen catalog view installed before the first input:
 * - `commands` — the full effective view at read time (diagnostics/tests);
 * - `scopedCommands` — effective entries absent from, or shadowing, the
 *   read-time global baseline (completion overrides while sessionless);
 * - `skills` — human-invocable skill summaries (official policy applied);
 * - `issues` — per-provider failures; an absent service is NOT an issue.
 */
export interface SurfaceCatalogSnapshot {
  readonly commands: readonly SurfaceCommandSummary[]
  readonly scopedCommands: readonly SurfaceCommandSummary[]
  readonly skills: readonly HumanSkillSummary[]
  readonly issues: readonly SurfaceCatalogIssue[]
}

/** The commands-service surface the collector reads. */
export interface SurfaceCommandsService {
  list(agent: Agent): readonly CommandDescriptor[]
}

/** The narrow context surface {@link readSurfaceCatalog} consumes. The
 * SKILL services are NOT reached here: every dsh skill/agent-presets
 * access goes through `src/skill-catalog.ts` (the single-point adapter,
 * plan appendix B.1). */
export interface SurfaceCatalogContext {
  get(name: 'commands'): SurfaceCommandsService | undefined
}

/**
 * The in-process global-layer command view. The public type requires an
 * `Agent`, but `commands.list(undefined)` resolves the global layer only
 * (ScopedLayers merges no overlays for an undefined key); the current TUI
 * already depends on this in-process behavior. The cast is isolated HERE so
 * the undefined key never reaches a remote RPC path, and the helper is the
 * single seam to replace if upstream ever ships a typed global-list API.
 * @param commands - the commands service.
 * @returns the global-layer descriptors (name-sorted by the registry).
 */
export function listGlobalCommands(commands: SurfaceCommandsService): readonly CommandDescriptor[] {
  return commands.list(undefined as unknown as Agent)
}

/** Copy one descriptor into a fresh frozen summary (never borrowed). */
export function commandSummaryOf(descriptor: CommandDescriptor): SurfaceCommandSummary {
  return Object.freeze({
    name: descriptor.name,
    description: descriptor.description,
    ...descriptor.input === undefined
      ? {}
      : { input: Object.freeze({ hint: descriptor.input.hint }) },
  })
}

/** Whether two descriptors expose identical display fields (origin-blind:
 * an identical scoped entry needs no override because the visible result and
 * the real-agent execution are the same either way). */
function sameCommand(left: CommandDescriptor, right: CommandDescriptor): boolean {
  return left.name === right.name
    && left.description === right.description
    && left.input?.hint === right.input?.hint
}

/**
 * Read one agent's effective surface catalog: global + scoped commands and
 * human-invocable skills, fully detached and frozen.
 *
 * Provider isolation (per the probe contract):
 * - lifecycle/refresh cancellation terminates the WHOLE read and propagates;
 * - an ordinary provider failure empties only that field and records a
 *   detached issue; other providers continue;
 * - a missing service is that provider's successful empty result (no issue).
 *
 * This function only READS: it registers nothing, mutates nothing, and never
 * touches a runner's live agent. Probe and live agent share this collector
 * so the two surfaces cannot drift apart.
 * @param agent - the agent whose effective view to read.
 * @param signal - lifecycle/refresh cancellation.
 * @param ctx - the context surface resolving the services.
 * @returns a frozen, detached snapshot.
 */
export async function readSurfaceCatalog(
  agent: Agent,
  signal: AbortSignal,
  ctx: SurfaceCatalogContext,
): Promise<SurfaceCatalogSnapshot> {
  signal.throwIfAborted()
  const issues: SurfaceCatalogIssue[] = []
  let commands: readonly SurfaceCommandSummary[] = []
  let scopedCommands: readonly SurfaceCommandSummary[] = []
  const commandsService = ctx.get('commands')
  if (commandsService !== undefined) {
    try {
      const global = listGlobalCommands(commandsService)
      const globalBy = new Map(global.map(descriptor => [descriptor.name, descriptor]))
      const effective = commandsService.list(agent)
      const scoped: SurfaceCommandSummary[] = []
      for (const descriptor of effective) {
        const summary = commandSummaryOf(descriptor)
        const baseline = globalBy.get(descriptor.name)
        if (baseline === undefined || !sameCommand(descriptor, baseline)) scoped.push(summary)
      }
      commands = sortCommands(effective.map(commandSummaryOf))
      scopedCommands = sortCommands(scoped)
    } catch (error) {
      issues.push({ provider: 'commands', message: safeErrorMessage(error) })
    }
  }
  let skills: readonly HumanSkillSummary[] = []
  // The skill read goes through the single-point adapter (plan appendix
  // B.1): the agent's own registry (preset-scoped or host) and the AGENT
  // OBJECT as scope, snapshot-first with the list() compatibility path.
  const skillTarget = resolveLiveSkillTarget(ctx as unknown as SkillCatalogContext, agent, agent.session.header.cwd ?? process.cwd())
  if (skillTarget !== undefined) {
    try {
      signal.throwIfAborted()
      const catalog = await readHumanSkillCatalog(skillTarget.registry, {
        cwd: skillTarget.cwd,
        scope: skillTarget.scope,
        signal,
      })
      skills = catalog.skills
      // An INCOMPLETE live observation is never authoritative (plan
      // §10.2): it carries a detached skills issue, so the install side
      // (mergePartial / installSurfaceSnapshot) keeps the last-good
      // skills instead of replacing them with a partial catalog.
      if (catalog.complete !== true) {
        issues.push({ provider: 'skills', message: 'incomplete skill observation' })
      }
    } catch (error) {
      // Cancellation is a lifecycle signal, not a provider failure: the
      // whole read must propagate it, never degrade it into an issue.
      if (signal.aborted) throw error
      issues.push({ provider: 'skills', message: safeErrorMessage(error) })
    }
  }
  return Object.freeze({
    commands,
    scopedCommands,
    skills,
    issues: Object.freeze(issues.map(issue => Object.freeze({ ...issue }))),
  })
}

/** Name-stable sort for command summaries (copies, never mutates input). */
function sortCommands(commands: readonly SurfaceCommandSummary[]): readonly SurfaceCommandSummary[] {
  return Object.freeze([...commands].sort((left, right) => left.name < right.name ? -1 : 1))
}
