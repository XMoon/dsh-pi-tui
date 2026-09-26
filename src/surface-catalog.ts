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
 *
 * The module also owns the pre-mount catalog RESOLUTION
 * (`resolveInitialCatalog`): the resume prefetch or the cold standing-scope
 * skill read, with their one-shot degradation notices.
 * @module @xmoon76/dsh-pi-tui/surface-catalog
 */

import { safeErrorMessage } from './error-boundary.ts'
import {
  readHumanSkillCatalog,
  resolveColdSkillTarget,
  resolveLiveSkillTarget,
  type HumanSkillCatalog,
  type HumanSkillSummary,
  type SkillCatalogContext,
} from './skill-catalog.ts'
import { isCancellation } from './detached.ts'
import type { Diag } from './diag.ts'

/** Minimal live-agent face consumed by the effective catalog readers — and by
 * {@link ResolveInitialCatalogOptions}, so the published option type stays
 * structural instead of inlining the Host Agent. */
export interface SurfaceCatalogAgent {
  readonly ctx: object
  readonly session: {
    readonly header: {
      readonly cwd?: string
    }
  }
}

/** Local structural command face, compatible with both npm and Source Mode DSH.
 * The optional identity is part of the official 0.1.6 descriptor; an older
 * runtime's descriptor may omit it. */
interface SurfaceCommandDescriptor {
  readonly definitionId?: string
  readonly name: string
  readonly description: string
  readonly input?: {
    readonly hint: string
    readonly attachments?: boolean
  }
}

/** One effective command's discovery metadata (the official descriptor's
 * display fields and optional stable identity; never a handler or definition). */
export interface SurfaceCommandSummary {
  /** Stable plugin-owned identity from the official command descriptor. */
  readonly definitionId?: string
  readonly name: string
  readonly description: string
  readonly input?: {
    readonly hint: string
    /** The descriptor's attachment declaration (DSH
     * `CommandInputDescriptor.attachments`): ONLY a command declaring it may
     * be invoked with composer attachments (the composer-side half of the
     * contract — the host executor enforces the other half at admission). */
    readonly attachments?: boolean
  }
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
  list(agent: SurfaceCatalogAgent): readonly SurfaceCommandDescriptor[]
}

/** The narrow context surface {@link readSurfaceCatalog} consumes. The
 * SKILL services are NOT reached here: every dsh skill/agent-presets
 * access goes through `src/skill-catalog.ts` (the single-point adapter,
 * plan appendix B.1). */
export interface SurfaceCatalogContext {
  get(name: 'commands'): SurfaceCommandsService | undefined
}

/**
 * The in-process global-layer command view. The upstream service requires an
 * agent, but `commands.list(undefined)` resolves the global layer only
 * (ScopedLayers merges no overlays for an undefined key); the current TUI
 * already depends on this in-process behavior. The cast is isolated HERE so
 * the undefined key never reaches a remote RPC path, and the helper is the
 * single seam to replace if upstream ever ships a typed global-list API.
 * @param commands - the commands service.
 * @returns the global-layer descriptors (name-sorted by the registry).
 */
export function listGlobalCommands(commands: SurfaceCommandsService): readonly SurfaceCommandDescriptor[] {
  return commands.list(undefined as unknown as SurfaceCatalogAgent)
}

/** Copy one descriptor into a fresh frozen summary (never borrowed). */
export function commandSummaryOf(descriptor: SurfaceCommandDescriptor): SurfaceCommandSummary {
  return Object.freeze({
    ...descriptor.definitionId === undefined ? {} : { definitionId: descriptor.definitionId },
    name: descriptor.name,
    description: descriptor.description,
    ...descriptor.input === undefined
      ? {}
      : {
          input: Object.freeze({
            hint: descriptor.input.hint,
            ...descriptor.input.attachments === true ? { attachments: true } : {},
          }),
        },
  })
}

/** Whether two descriptors expose identical authority metadata (origin-blind:
 * an identical scoped entry needs no override because the visible result and
 * the real-agent execution are the same either way). */
function sameCommand(left: SurfaceCommandDescriptor, right: SurfaceCommandDescriptor): boolean {
  return left.definitionId === right.definitionId
    && left.name === right.name
    && left.description === right.description
    && left.input?.hint === right.input?.hint
    // The attachment DECLARATION is part of the effective behavior (it
    // decides whether a composer may attach anything), so a scoped entry
    // that differs only in it is NOT the identical visible result.
    && (left.input?.attachments === true) === (right.input?.attachments === true)
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
  agent: SurfaceCatalogAgent,
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

export interface InitialCatalogResolution {
  /** The resume prefetch snapshot to install at mount. */
  readonly snapshot?: SurfaceCatalogSnapshot
  /** The cold standing-scope human skill catalog (deferred start). */
  readonly skills?: HumanSkillCatalog
  /** A user-facing notice when the prefetch/standing read degraded. */
  readonly notice?: string
}

/** Options for {@link resolveInitialCatalog}. */
export interface ResolveInitialCatalogOptions {
  /** The resumed live agent, if any (prefetch path). */
  readonly liveAgent?: SurfaceCatalogAgent
  /** The effective preset id for the cold standing read (undefined = the
   * deployment default; only consulted for the deferred start). */
  readonly presetId?: string
  readonly signal: AbortSignal
  /** The context surface the collectors read services from. */
  readonly ctx: SurfaceCatalogContext
  readonly diag: Diag
  /** Suspend the pre-mount startup status before an ordinary log write
   * (the status owns the current terminal line; a TTY shares one cursor
   * between stdout and stderr). Called right before every diag.warn this
   * function may emit. */
  readonly onLog?: () => void
}

/**
 * The pre-mount surface catalog resolution:
 * - an explicit `--session` start PREFETCHES the resumed agent's effective
 *   catalog (a live read emits no session events);
 * - the deferred start (no `--session`) reads the cold HUMAN SKILL catalog
 *   through the preset's STANDING SCOPE — no Agent, no session, no turn —
 *   so the first input sees human-invocable skills without any durable
 *   side effect (the mechanism that avoids the probe dead end: host
 *   `session/created` observers write durable knob events into every fresh
 *   session).
 *
 * The snapshot (resume) or the skill catalog (cold) installs synchronously
 * after mount (the ready barrier).
 *
 * Failure taxonomy (plan appendix B):
 * - lifecycle cancellation: nothing installed, no notice;
 * - a prefetch/standing read failure degrades to a one-shot notice (the
 *   TUI mounts with the global view and built-in commands);
 * - a missing/unknown preset or a broken standing mount degrades the cold
 *   target to the global layer with a one-shot notice — never a probe
 *   Agent, never a startup failure;
 * - an ordinary provider read failure never rejects here: it becomes an
 *   empty field + detached issue inside the catalog.
 * @param options - injected dependencies (see {@link ResolveInitialCatalogOptions}).
 * @returns the snapshot / skill catalog to install and an optional notice.
 */
export async function resolveInitialCatalog(options: ResolveInitialCatalogOptions): Promise<InitialCatalogResolution> {
  const { liveAgent, presetId, signal, ctx, diag, onLog } = options
  if (liveAgent !== undefined) {
    try {
      const snapshot = await readSurfaceCatalog(liveAgent, signal, ctx)
      diag.info('surface catalog prefetched', {
        commands: snapshot.commands.length,
        scopedCommands: snapshot.scopedCommands.length,
        skills: snapshot.skills.length,
      })
      return { snapshot }
    } catch (error) {
      if (isCancellation(error)) return {}
      const message = safeErrorMessage(error)
      onLog?.()
      diag.warn('surface catalog unavailable', { phase: 'resume', error: message })
      return { notice: `surface catalog unavailable: ${message}` }
    }
  }
  // Deferred start: the cold standing-scope skill read. No Agent, no
  // session, no turn — and no probe fallback on any failure. The standing
  // scope rides the official revision lease; it is released once the read
  // settles on ANY path (the lease must never outlive its read).
  const target = await resolveColdSkillTarget(ctx as unknown as SkillCatalogContext, presetId, process.cwd())
  if (target.target === undefined) return {}
  try {
    const catalog = await readHumanSkillCatalog(target.target.registry, {
      cwd: target.target.cwd,
      scope: target.target.scope,
      signal,
    })
    diag.info('skill catalog standing ready', {
      preset: presetId ?? 'default',
      skills: catalog.skills.length,
      complete: catalog.complete,
    })
    return { skills: catalog, ...target.degraded === undefined ? {} : { notice: target.degraded } }
  } catch (error) {
    if (isCancellation(error)) return {}
    const message = safeErrorMessage(error)
    onLog?.()
    diag.warn('skill catalog unavailable', { phase: 'cold', error: message })
    return { notice: `skill catalog unavailable: ${message}` }
  } finally {
    await target.release?.()
  }
}
