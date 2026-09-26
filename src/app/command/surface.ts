/**
 * CommandSurface (A5b-3, plan §A5b-3): the ONE owner of the command authority
 * and its registration/catalog state machine.
 *
 * Ownership:
 *
 * - the claim tests installed by TUI command registration (the advertised
 *   completion claim, the effective Host command-line claim + attachment
 *   declaration, the live skill-wrapper test, the delivery binding and the
 *   command draft disposition);
 * - the catalog refresh coordinator + the late completion re-synthesis, the
 *   `skills/change` coalescing gate and its one-shot subscription;
 * - the exact-Agent admission helpers for a fenced live scope;
 * - `registerCommands` (the one registration entry) and the live-session
 *   catalog refresh.
 *
 * The module is deliberately neutral: the exact Agent type is a generic
 * parameter, and the Cordis context, the semantic backend slices, the command
 * registry lookup and the TuiCommandRunner facade (late-bound, 3b-2) all
 * arrive as narrow injected capabilities.
 * @module @xmoon76/dsh-pi-tui/app/command/surface
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Diag } from '../../diag.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'
import { runOwned } from '../../detached.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import { normalizeSkillInvocation } from '../../command-policy.ts'
import { readSurfaceCatalog, type SurfaceCatalogContext } from '../../surface-catalog.ts'
import type { SkillCatalogCapability } from '../../runtime/catalog-port.ts'
import { CatalogRefreshCoordinator, CoalescingRefreshGate, type CatalogRefreshOutcome, type CatalogRefreshRequest } from '../../skill-catalog-refresh.ts'
import { registerTuiCommands, type CommandRegistryLike, type HostCommandClaim, type InitialCommandCatalog, type SubmitDelivery, type TuiCommandRunner } from '../../commands.ts'
import type { SessionScope } from '../session/scope.ts'
import type { TuiApp } from '../../tui-app.ts'

/** The catalog capability slice the command surface subscribes to. */
export interface CommandCatalogCapability {
  readonly skills: Pick<SkillCatalogCapability, 'standing'> & {
    onSkillsChange(listener: () => void): void
  }
}

/** One catalog refresh target (the semantic target, no Host type). */
export type CommandCatalogTarget =
  | { readonly kind: 'preset'; readonly presetId: string | undefined }
  | { readonly kind: 'agent'; readonly key: number }

/** One catalog refresh request as this owner builds it. The composition root
 *  adapts it onto the port's request shape. */
export interface CommandCatalogRequest<ExactAgent> {
  readonly source: 'invalidation' | 'live-session'
  readonly target: CommandCatalogTarget
  readonly agent?: ExactAgent
}

/** The narrow capabilities the command surface consumes. */
export interface CommandSurfaceDeps<ExactAgent extends { readonly session: { readonly id: string } }> {
  /** The Cordis context: part of the frozen TuiCommandRunner contract (and the
   *  surface-catalog context); never used for Host service lookups here. */
  readonly ctx: Context
  readonly diag: Diag
  /** The runner lifetime signal (the catalog coordinator). */
  readonly signal: AbortSignal
  /** The mounted app, read live (the mount precedes every command path). */
  readonly app: () => TuiApp
  /** The exact live Agent of the current owner, or undefined. */
  readonly liveAgent: () => ExactAgent | undefined
  /** The scope authority (the ONLY currentness source). */
  readonly sessionScope: { isCurrent(scope: SessionScope): boolean }
  /** The ownership core (generation fence). */
  readonly ownership: { readonly generation: () => number }
  /** The command registry lookup (the Host commands service), or undefined. */
  readonly commandsRegistry: () => CommandRegistryLike | undefined
  /** The semantic catalog capability (skills/change + standing read). */
  readonly catalog: CommandCatalogCapability
  /** Map one exact Agent onto the semantic catalog port's agent field. The
   *  composition root owns the mapping (the port type stays out of this
   *  module's contract). */
  readonly toCatalogAgent: (agent: ExactAgent) => CatalogRefreshRequest['agent']
  /** The launch-time preset (the sessionless refresh target). */
  readonly launchPreset: string | undefined
  /** The run-local preset override, read live. */
  readonly pendingPreset: () => string | undefined
  /** The resolved CLIENT working directory (the standing read scope). */
  readonly clientCwd: string
  /** The TuiCommandRunner facade; late-bound because it is assembled after
   *  this owner (it consumes the submission deps, A5b-4). */
  readonly runner: () => TuiCommandRunner
}

/** The command authority as the rest of the application consumes it. */
export interface CommandSurface<ExactAgent extends { readonly session: { readonly id: string } }> {
  /** Register the TUI command surface once. */
  register(initial?: InitialCommandCatalog): void
  /** Refresh the live owner's scoped catalog through the coordinator. */
  refreshLiveCatalog(agent: ExactAgent): Promise<void>
  /** Is a slash name advertised by the CURRENT completion list? */
  wasAdvertisedClaim(name: string): boolean
  /** Does the CURRENT effective host catalog claim this line? */
  hostClaimOf(parsed: { name: string; rawInput?: string }): HostCommandClaim | undefined
  /** Is a slash name a LIVE TUI-owned skill wrapper? */
  isSkillWrapperName(name: string): boolean
  /** Consume one TUI-local command draft disposition. */
  takeCommandDraftDisposition(commandId?: string): 'restored' | 'suppressed' | undefined
  /** Re-synthesize the completion list (a late client contribution). */
  refreshCompletions(): void
  /** Bind one submission's resolved delivery for its launch window. */
  withCommandDelivery<T>(delivery: SubmitDelivery, run: () => T): T
  /** Request one catalog refresh through the coordinator. */
  requestCatalogRefresh(request: CatalogRefreshRequest): Promise<CatalogRefreshOutcome>
  /** Whether the catalog coordinator is registered yet. */
  catalogRefreshAvailable(): boolean
  /** Whether one submission is a TUI-owned skill invocation. */
  isSkillInvocation(parsed: { name: string } | undefined, text: string): boolean
  /** The exact Direct attachment of a fenced live scope. */
  agentForLiveScope(scope: SessionScope): ExactAgent
  /** The exact Direct attachment of an already-fenced live session id. */
  attachmentForSession(sessionId: string): ExactAgent
  /** Release the catalog coordinator (disposal orchestration). */
  disposeCatalog(): void
}

/** Create the command authority owner (plan §A5b-3). */
export function createCommandSurface<ExactAgent extends { readonly session: { readonly id: string } }>(
  deps: CommandSurfaceDeps<ExactAgent>,
): CommandSurface<ExactAgent> {
  // M2: the plugin keybinding-sync unsubscribe slot is A4-5 surface-owned
  // (`surface.bindPluginKeybinds` / `surface.dispose`); the runner no longer
  // holds it.
  // The catalog refresh coordinator: the ONE post-mount refresh owner
  // (first session, switches, /preset, /reload). Declared here (before
  // cleanup) for the same TDZ guard — cleanup disposes it, and a
  // mid-startup HMR unload must never reference it while it is still in
  // the temporal dead zone; it is assigned during command registration.
  
  let catalogCoordinator: CatalogRefreshCoordinator | undefined

  /**
   * Whether one submission is a TUI-owned skill invocation: a LIVE skill
   * wrapper, or the explicit `/skill <name>` form. Skill delivery belongs
   * to loadSkill in BOTH modes — it builds the normalized `/name` line,
   * steers or queues it with the resolved mode, and injects the body
   * whenever the host's dsh-tool-skill pre-step does not (a composition
   * without that loader). A bare steered line would silently skip the
   * skill body, and a missing skill registry is reported there too.
   * @param parsed - the parsed slash command, undefined for a plain prompt.
   * @param text - the submitted line.
   */
  
  const isSkillInvocation = (parsed: { name: string } | undefined, text: string): boolean =>
    parsed !== undefined && (parsed.name === 'skill'
      ? normalizeSkillInvocation(text) !== undefined
      : isSkillWrapperName?.(parsed.name) === true)

  // The TUI-owned slash commands live on the commands service's global
  // layer, which needs no agent — register them up front so the whole
  // surface (including Tab completion) works before the first session
  // exists. Session-backed handlers call runner.ensureSession() first;
  // `refreshSkills` rebuilds the agent-scoped per-skill commands once a
  // session becomes live.
  
  let commandsRegistered = false

  /** The claim test installed by registerTuiCommands: is a slash name
   * advertised by the CURRENT completion list? The dispatch captures it
   * BEFORE any session creation (see dispatchViaSession). */
  
  let wasAdvertisedClaim: ((name: string) => boolean) | undefined

  /** The claim test installed by registerTuiCommands: does the CURRENT
   * effective host catalog claim THIS LINE (and does the claiming
   * descriptor declare `input.attachments`)? The dispatch consults it
   * BEFORE the busy queue/steer policy and for every attachment decision
   * (PR115-fix problem 1). */
  
  let hostClaimOf: ((parsed: { name: string; rawInput?: string }) => HostCommandClaim | undefined) | undefined

  /** The skill-wrapper test installed by registerTuiCommands: is a slash
   * name a LIVE TUI-owned skill wrapper? The steer path consults it to
   * decide whether a composition without the host skill-body loader must
   * deliver through loadSkill instead of steering a bare line. */
  
  let isSkillWrapperName: ((name: string) => boolean) | undefined

  /** The completion re-synthesis installed by registerTuiCommands: a late
   * CLIENT command contribution must join the `/` menu without waiting for
   * a session refresh (the extension-invalidate hook calls it). */
  
  let refreshCommandCompletions: (() => void) | undefined

  /** The delivery binding installed by registerTuiCommands: bind one
   * submission's resolved queue/steer mode for the synchronous window that
   * launches a command execution (the TUI skill handlers consume it).
   * Before the command surface is wired nothing can consume a binding, so
   * the unwired default simply runs the launch. */
  
  let withCommandDelivery = <T>(_delivery: SubmitDelivery, run: () => T): T => run()

  /** Consume TUI-local command draft dispositions after DSH normalizes the
   * public CommandResult. A missing id is used only for a thrown command
   * execution, which cannot return its generated id to this sink. */
  
  let takeCommandDraftDisposition: ((commandId?: string) => 'restored' | 'suppressed' | undefined) | undefined

  /** The catalog refresh coordinator: the ONE post-mount refresh owner
   * (first session, switches, /preset, /reload). Built inside
   * registerCommands once the surface hooks exist. (Declared before
   * cleanup — see the hoisted slot above.) */
  
  let catalogRefreshRequest: ((request: CatalogRefreshRequest) => Promise<CatalogRefreshOutcome>) | undefined

  /** `skills/change` coalescing: bursts of invalidation notifications cost
   * at most two reads, and the follow-up re-read observes the CURRENT
   * ownership (live agent vs standing preset). */
  
  let skillsChangeSubscribed = false

  const skillsChangeGate = new CoalescingRefreshGate(() => {
    runOwned('skills/change refresh', async () => {
      const refresh = catalogRefreshRequest
      if (refresh === undefined) return undefined
      const liveAgent = deps.liveAgent()
      const target = liveAgent === undefined
        ? { kind: 'preset', presetId: deps.pendingPreset() ?? deps.launchPreset } as const
        : { kind: 'agent', key: deps.ownership.generation() } as const
      return refresh({
        source: 'invalidation',
        target,
        ...target.kind === 'agent' ? { agent: deps.toCatalogAgent(liveAgent!) } : {},
      })
    }, {
      diag: deps.diag,
      sessionId: () => deps.liveAgent()?.session.id,
      onResult: (outcome) => {
        // NOTIFY BEFORE settled(): if app.notify throws, runOwned routes
        // to onError, whose settled() is then the ONLY settle — a dirty
        // follow-up cannot be double-settled (a second settle would clear
        // the follow-up's in-flight flag while it is still running).
        if (outcome !== undefined && outcome.kind === 'applied' && outcome.notice !== undefined) {
          deps.app().notify(outcome.notice, 'error')
        }
        skillsChangeGate.settled()
      },
      onCancel: () => { skillsChangeGate.settled() },
      onError: (error) => {
        skillsChangeGate.settled()
        deps.app().notify(`skill catalog refresh failed: ${safeErrorMessage(error)}`, 'error')
      },
    })
  })

  /** Subscribe to the dsh-skill invalidation notification once, through
   * the catalog capability (migration M1.8). The event carries no
   * scope or cwd, so the refresh target follows the CURRENT ownership; an
   * unavailable or throwing subscription degrades to no subscription —
   * owner switches and /reload still refresh. The flag is set only after
   * a successful subscribe, so a throwing subscribe can retry on a later
   * registration attempt. */
  
  const subscribeSkillsChangeEvents = (): void => {
    if (skillsChangeSubscribed) return
    try {
      deps.catalog.skills.onSkillsChange(() => skillsChangeGate.notify())
      skillsChangeSubscribed = true
    } catch (error) {
      deps.diag.warn('skills/change subscription unavailable', { error: safeErrorMessage(error) })
    }
  }

  /**
   * The exact Direct attachment of a scope, validated in ONE synchronous
   * admission step: a stale scope throws `SupersededReadError` (never
   * retargets to the current owner), a sessionless scope has no live read,
   * and a current live scope that cannot resolve its matching Direct
   * attachment breaks an internal invariant loudly.
   */
  
  const agentForLiveScope = (scope: SessionScope): ExactAgent => {
    if (!deps.sessionScope.isCurrent(scope)) {
      throw new SupersededReadError('the session changed before the read')
    }
    const sessionId = scope.sessionId
    if (sessionId === undefined) throw new Error('a live read requires a Session scope')
    const agent = deps.liveAgent()
    if (agent === undefined || agent.session.id !== sessionId) {
      throw new Error('a current live scope must resolve its exact Direct owner')
    }
    return agent
  }

  /**
   * The exact Direct attachment of an already-fenced live session id: the
   * command runtime's synchronous `liveSessionId` fence proved the scope
   * current in the SAME stack, so this only resolves the attachment and
   * asserts the exact-owner invariant loudly.
   */
  
  const attachmentForSession = (sessionId: string): ExactAgent => {
    const agent = deps.liveAgent()
    if (agent === undefined || agent.session.id !== sessionId) {
      throw new Error('a current live scope must resolve its exact Direct owner')
    }
    return agent
  }

  /** Await one live-owner catalog refresh through the coordinator (the
   * first deferred create and every session switch): the refresh attempt
   * settles before the caller continues, and its outcome is an outcome —
   * provider issues degrade fields, failures warn, the submission or the
   * switch proceeds either way. */
  
  const refreshLiveCatalog = async (agent: ExactAgent): Promise<void> => {
    const refresh = catalogRefreshRequest
    if (refresh === undefined) return
    await refresh({
      source: 'live-session',
      target: { kind: 'agent', key: deps.ownership.generation() },
      agent: deps.toCatalogAgent(agent),
    })
  }

  const registerCommands = (initial?: InitialCommandCatalog): void => {
    if (commandsRegistered) return
    const commands = deps.commandsRegistry()
    if (commands === undefined) return
    commandsRegistered = true
    try {
      const installed = registerTuiCommands(deps.runner(), initial)
      wasAdvertisedClaim = installed.wasAdvertised
      hostClaimOf = installed.hostClaimOf
      isSkillWrapperName = installed.isSkillWrapper
      refreshCommandCompletions = installed.refreshCommandCompletions
      withCommandDelivery = installed.withDelivery
      takeCommandDraftDisposition = installed.takeCommandDraftDisposition
      // The coordinator's surface hooks point INTO the command surface;
      // the command runtime's refresh facades (and the switch/first-session
      // path) route every post-mount refresh through `catalogRefreshRequest`.
      catalogCoordinator = new CatalogRefreshCoordinator({
        readAgent: (agent, readSignal) => readSurfaceCatalog(agent, readSignal, deps.ctx as unknown as SurfaceCatalogContext),
        // The sessionless (preset) target reads the STANDING skill catalog
        // through the catalog capability (migration M1.8) — the
        // capability-gated cold path (standing key → global → degraded
        // global with a notice), never an Agent probe: probes emit
        // durable session events in this deployment (see
        // docs/surface-catalog.md).
        readStanding: (presetId, readSignal) =>
          deps.catalog.skills.standing(presetId, deps.clientCwd, readSignal),
        installSnapshot: (next) => installed.installSnapshot(next),
        enterCatalogTransition: () => installed.enterTransition(),
      }, deps.signal, deps.diag)
      catalogRefreshRequest = (request) => catalogCoordinator!.refresh(request)
      subscribeSkillsChangeEvents()
    } catch (error) {
      // A failed registration must not lock the surface forever (a locked
      // flag would leave every later command resolving to a plain message
      // silently): reset the flag for a later retry and surface the
      // failure visibly instead of swallowing it.
      commandsRegistered = false
      const message = safeErrorMessage(error)
      deps.ctx.logger.error(`tui-runner: command registration failed: ${message}`)
      deps.diag.error('command registration failed', { error: message })
      deps.app().notify(`command registration failed: ${message}`, 'error')
    }
  }


  const catalogRefreshAvailable = (): boolean => catalogRefreshRequest !== undefined
  const requestCatalogRefresh = (request: CatalogRefreshRequest): Promise<CatalogRefreshOutcome> => {
    if (catalogRefreshRequest === undefined) return Promise.reject(new Error('the command catalog is not registered'))
    return catalogRefreshRequest(request)
  }
  const disposeCatalog = (): void => {
    catalogCoordinator?.dispose()
    catalogCoordinator = undefined
  }

  return {
    register: registerCommands,
    refreshLiveCatalog,
    wasAdvertisedClaim: (name) => wasAdvertisedClaim?.(name) === true,
    hostClaimOf: (parsed) => hostClaimOf?.(parsed),
    isSkillWrapperName: (name) => isSkillWrapperName?.(name) === true,
    takeCommandDraftDisposition: (commandId) => takeCommandDraftDisposition?.(commandId),
    refreshCompletions: () => refreshCommandCompletions?.(),
    // The delivery binding is a LATE-REBOUND slot: read it on every call, or the
    // owner would hand out the pre-registration default forever.
    withCommandDelivery: (delivery, run) => withCommandDelivery(delivery, run),
    requestCatalogRefresh,
    catalogRefreshAvailable,
    isSkillInvocation,
    agentForLiveScope,
    attachmentForSession,
    disposeCatalog,
  }
}
