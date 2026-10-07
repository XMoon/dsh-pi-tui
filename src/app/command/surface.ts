/**
 * CommandSurface (A5b-3, plan §A5b-3): the ONE owner of the command authority
 * and its registration/catalog state machine, and of the TuiCommandRunner
 * facade it registers.
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
 *   catalog refresh;
 * - the TuiCommandRunner facade (`buildRunner`), assembled from the bound
 *   CommandRuntime plus the injected presentation/port capabilities.
 *
 * The module is deliberately neutral: the exact Agent, model-selection and
 * session-id types are generic parameters, and the Cordis context, the semantic
 * backend slices, the command registry lookup and the model/viewer/preset
 * capabilities all arrive as narrow injected capabilities.
 * @module @xmoon76/dsh-pi-tui/app/command/surface
 */

import type { Diag } from '../../runtime/process/diagnostics.ts'
import type { BackendKind } from '../../runtime/backend.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'
import { runSyncDisposalSteps } from '../../runtime/process/disposal.ts'
import { runOwned } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { normalizeSkillInvocation } from '../../command-policy.ts'
import type { SurfaceCatalogSnapshot, SurfaceCommandSummary } from '../../domain/catalog/surface.ts'
import type { SkillCatalogCapability } from '../../runtime/catalog-port.ts'
import type { SessionScopeAuthority } from '../session/scope.ts'
import { CatalogRefreshCoordinator, CoalescingRefreshGate, type CatalogRefreshOutcome, type CatalogRefreshRequest, type CatalogRefreshSource } from './catalog-refresh.ts'
import { registerTuiCommands, type CommandRegistryLike, type HostCommandClaim, type InitialCommandCatalog, type SubmitDelivery, type TuiCommandRunner } from '../../commands.ts'
import type { ClientCommandRegistry } from './client-command-registry.ts'
import type { RemoteCommandSourceFace } from '../application-runtime.ts'
import { bindCommandRuntime, type CommandRuntimeSurface, type CommandSessionRuntime } from './runtime.ts'
import { copyToClipboard } from '../../client/clipboard/copy.ts'
import { isFocusDisplayPreset, type DisplayState } from '../../domain/display/preset.ts'
import { draftHasImages } from '../../client/media/draft-attachments.ts'
import { prepareUserMessage } from '../submission/direct-message-preparation.ts'
import type { ModelSelectionValue } from '../../domain/session/model-selection.ts'
import type { SessionScope } from '../session/scope.ts'
import type { TuiApp } from '../../tui-app.ts'
import type { CommandRuntime } from './runtime.ts'
import type { ModelSelectionOwner, SelectionRef } from './model-selection.ts'

/** The catalog capability slice the command surface subscribes to. */
export interface CommandCatalogCapability {
  readonly skills: SkillCatalogCapability
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

/** One extension-registry settlement ref (the frozen runner shape). */
type ExtensionHealthRef = Parameters<NonNullable<TuiCommandRunner['recordExtensionError']>>[0]

/**
 * The frozen TuiCommandRunner with the Host-typed model-selection / session-id
 * members rebound to this owner's generic parameters. The composition
 * instantiates the generics with the Host types; this module never names them,
 * and `buildRunner` bridges the facade back onto the frozen contract.
 */
type RunnerFacade<Selection extends ModelSelectionValue, Id extends string> =
  Omit<TuiCommandRunner, 'selected' | 'defaultSelection' | 'defaultIntent' | 'setDefaultIntent' | 'setModelSelectionPending' | 'enterView'> & {
    readonly selected: SelectionRef<Selection>
    defaultSelection(): Selection | undefined
    readonly defaultIntent: Selection | undefined
    setDefaultIntent(selection: Selection | undefined): void
    setModelSelectionPending(selection: Selection | undefined, token?: number, status?: 'pending' | 'unresolved'): void
    enterView(
      childId: Id,
      label: string | undefined,
      mode: 'one-shot' | 'continuable',
      parentSessionId: Id,
      activity: 'running' | 'inactive',
    ): Promise<void>
  }

/** The structural minimum of the exact live Agent this owner reads (the
 *  session identity/header, the launch routing and the live status). */
export interface CommandAgentShape {
  readonly session: {
    readonly id: string
    readonly header: { readonly cwd?: string }
  }
  readonly options: { readonly provider?: string; readonly model?: string }
  readonly status: string
}

/** The narrow capabilities the command surface consumes. */
export interface CommandSurfaceDeps<Selection extends ModelSelectionValue, ExactAgent extends CommandAgentShape> {
  /** The Cordis context: carried ONLY as the frozen `TuiCommandRunner.ctx`
   *  member (the composition root also uses it for service lookups on its own
   *  side of the seam). */
  readonly ctx: TuiCommandRunner['ctx']
  /** The diagnostic sink for command registration failures. */
  readonly logError: (message: string) => void
  readonly diag: Diag
  /** The runner lifetime signal (the catalog coordinator). */
  readonly signal: AbortSignal
  /** The mounted app, read live (the mount precedes every command path). */
  readonly app: () => TuiApp
  /** The exact live Agent of the current owner, or undefined. */
  readonly liveAgent: () => ExactAgent | undefined
  /** The session scope authority (the ONLY currentness source). */
  readonly sessionScope: SessionScopeAuthority
  /** The ownership core (generation fence + session id). */
  readonly ownership: {
    readonly generation: () => number
    currentSessionId(): string | undefined
  }
  /** The single-writer session-transition gate (the runner's withSessionTransition
   *  and sessionTransitionPending seams). */
  readonly transition: {
    pending(): boolean
    run<T>(task: () => Promise<T> | T): Promise<T>
  }
  /** The command registry lookup (the Host commands service), or undefined. */
  readonly commandsRegistry: () => CommandRegistryLike | undefined
  /** The Client-owned command registry (M3-4 PR4 §D2): the TUI's OWN
   *  definitions register here on BOTH branches; on Remote this is their
   *  ONLY registration surface (the Host commands service never receives a
   *  TUI callback). */
  readonly clientCommands: ClientCommandRegistry
  /** The Remote branch's command authority read (PR4 §2.1/§2.2): Host
   *  command + human-skill metadata behind one generation-fenced snapshot.
   *  Absent on Direct (the Direct seams below own that branch's reads). */
  readonly remoteCommandSource?: RemoteCommandSourceFace
  /** The Remote branch's official Session facts (PR4 §2.2/§3): running,
   *  routing (modelSelection projection + session cwd) and the session
   *  status projection. Absent on Direct. */
  readonly remoteFacts?: {
    running(sessionId: string): boolean | undefined
    sessionStatus(sessionId: string): import('../../runtime/session-reader-port.ts').SessionStatusProjection | undefined
  }
  /** The narrow Direct seams the command runtime binding needs. These stay in
   *  the composition root: they read the in-process Host session log and the
   *  Host command registry. */
  readonly direct: {
    listScopedCommands: CommandRuntimeSurface['listScopedCommands']
    sessionStats: CommandRuntimeSurface['sessionStats']
    lastAssistantText: CommandRuntimeSurface['lastAssistantText']
    promptAdmission<T>(agent: ExactAgent, hasImages: boolean, task: () => Promise<T> | T): Promise<T>
  }
  /**
   * The narrow Direct CATALOG capability (TS8-E): the composition root captures
   * the Direct catalog context and the in-process `commands.list(undefined)`
   * convention and injects both as neutral-DTO operations, so this application
   * owner never imports a `runtime/direct/**` path. Absent on the Remote branch
   * (the Remote read goes through the generation-fenced command source).
   */
  readonly directCatalog?: {
    /** The Direct effective catalog read for one exact Agent. */
    readSurfaceCatalog(agent: ExactAgent, signal: AbortSignal): Promise<SurfaceCatalogSnapshot>
    /** The Direct Host global-layer command summaries (already detached). */
    listGlobalCommands(): readonly SurfaceCommandSummary[]
  }
  /** The TRANSPORT-AWARE prepared-prompt builder (PR4 review round): on Remote
   *  the session writer's serializer requires the PreparedPrompt the ordinary
   *  submission path builds — a raw UserMessage fails its preflight. Wired to
   *  the SAME builder; absent on Direct (the UserMessage stays authoritative). */
  readonly prepareTransportMessage?: (text: string, requestId: string) => Promise<unknown>
  /** The semantic catalog capability (skills/change + standing read). */
  readonly catalog: CommandCatalogCapability
  /** Map one exact Agent onto the semantic catalog port's agent field. The
   *  composition root owns the mapping (the port type stays out of this
   *  module's contract). */
  readonly toCatalogAgent: (agent: ExactAgent) => CatalogRefreshRequest['agent']
  /** The preset facts (launch/pending/effective/blank), read live. */
  readonly presets: {
    readonly launch: string | undefined
    pending(): string | undefined
    setPending(id: string | undefined): void
    current(): string | undefined
    blank(): boolean | undefined
  }
  /** The resolved CLIENT working directory (the standing read scope). */
  readonly clientCwd: string
  /**
   * PR5 (plan §3.2): the presentation-owned recent-performance availability
   * of the current main window (one bit beside the stats fold). Provided on
   * the Remote branch; absent on Direct (the complete log is authoritative).
   */
  readonly recentPerformanceAvailable?: () => boolean
  /** The mounted-surface seams the runner facade delegates to. */
  readonly surface: {
    setNotificationMode(mode: string): void
    setNotificationMethod(method: string): void
    setTerminalProgressMode(mode: string): void
    openJobView(jobId: string): void
    openTasksBrowser(viewMode: 'quick' | 'full'): void
  }
  /** The semantic backend port slices the runner exposes unchanged. */
  readonly backend: {
    readonly kind: BackendKind
    readonly sessionReader: TuiCommandRunner['sessionReader']
    readonly sessionWriter: TuiCommandRunner['sessionWriter']
    readonly interaction: TuiCommandRunner['interaction']
    readonly catalog: TuiCommandRunner['catalog']
    readonly config: TuiCommandRunner['config']
    readonly hostFile: TuiCommandRunner['hostFile']
    /** Shell amendment (M3-4 PR3): whether Host-shell completion facts are
     * reachable on the selected backend (Direct true / Remote false). */
    readonly hostShellCompletion: boolean
    /** M3-4 PR4 round 5: whether the readable-transcript artifact is
     * renderable on the selected backend (Direct true — the renderer reads
     * the in-process Session history; Remote false — no transport-neutral
     * whole-history seam yet). An explicit business capability, never
     * derived from the M8-retiring Host-registry compatibility mirror. */
    readonly transcriptExportAvailable: boolean
  }
  /** The bound session runtime entries the runner drives. */
  readonly session: {
    ensureSession(): Promise<void>
    withWriter: CommandSessionRuntime['withWriter']
    switchSession(sessionId: string): Promise<string | undefined>
    forkSession: NonNullable<TuiCommandRunner['forkSession']>
    transitionTo: TuiCommandRunner['transitionTo']
  }
  /** The status owner seams the runner delegates to. */
  readonly status: {
    forceContextMeasurement(): number | undefined
    sessionCwd(): string
    refresh(): void
    updateWelcomeCard(): void
  }
  /** The settings owner seams the runner delegates to. */
  readonly settings: {
    applyFooterSettings: TuiCommandRunner['applyFooterSettings']
    setDisplayPreset: NonNullable<TuiCommandRunner['setDisplayPreset']>
  }
  /** The model-selection owner (the generic selection type). */
  readonly model: ModelSelectionOwner<Selection>
  /** The viewer owner's enter seam (session ids stay strings). */
  readonly viewer: {
    enterView(
      childId: string,
      label: string | undefined,
      mode: 'one-shot' | 'continuable',
      parentSessionId: string,
      activity: 'running' | 'inactive',
    ): Promise<void>
  }
  /** The per-TUI draft stores. */
  readonly drafts: {
    readonly images: TuiCommandRunner['imageStore']
    readonly files: NonNullable<TuiCommandRunner['fileStore']>
  }
  /** The extension registries (the runner's narrow read surface). */
  readonly extensions: {
    current(): TuiCommandRunner['extensions']
    recordError(ref: ExtensionHealthRef, error: unknown): void
    clearError(ref: ExtensionHealthRef): void
  }
  /** The profile-wide Plugin Manager controller (never session-owned). */
  readonly pluginManager: {
    open(): void
    submenu(done: (selected?: string) => void): ReturnType<TuiCommandRunner['createPluginManagerSubmenu']>
  }
  /** The shared client clipboard delivery policy. */
  readonly client: {
    readonly runCopyCommand: Parameters<typeof copyToClipboard>[1]
    readonly copyEnv: Parameters<typeof copyToClipboard>[2]
  }
  /** The late-bound submission seams (A5b-4 owns the controller): both are read
   *  at call time, so neither can go stale. */
  readonly submission: {
    prepareDeps: () => Parameters<typeof prepareUserMessage>[2]
    settleQueueRecalls(committed: boolean): void
  }
  /** The shared prompt-assembly state objects. */
  readonly promptState: {
    readonly progressUpdates: TuiCommandRunner['progressUpdatesState']
    readonly responseStyle: TuiCommandRunner['responseStyleState']
    readonly gitAttribution: TuiCommandRunner['gitAttributionState']
  }
  /** The Direct TUI-settings facade (a Host value forwarded opaquely). */
  readonly tuiSettings: TuiCommandRunner['tuiSettings']
  /** The shared display state (read live by /display and the focus facade). */
  readonly displayState: DisplayState
  /** The session lifecycle port (/new and /fork). */
  readonly agents: TuiCommandRunner['agents']
  /** The deployment image policy, re-read dynamically. */
  readonly imageLimits: TuiCommandRunner['imageLimits']
  /** The rewind-picker entry (the runner's /rewind + double-Esc seam). */
  readonly openRewindPicker: () => void
  /** The ONE exit orchestration. */
  readonly requestExit: () => void
  /** The launcher's appExit. */
  readonly exit: TuiCommandRunner['exit']
}

/** The command authority as the rest of the application consumes it. */
export interface CommandSurface<Selection extends ModelSelectionValue, ExactAgent extends CommandAgentShape> {
  /** Register the TUI command surface once. */
  register(initial?: InitialCommandCatalog): void
  /** Refresh the live owner's scoped catalog through the coordinator. */
  refreshLiveCatalog(agent: ExactAgent): Promise<void>
  /** Refresh the live owner's catalog by SESSION id (the Remote branch:
   *  the coordinator target wraps the id; no Direct Agent is resolved). */
  refreshLiveCatalogById(sessionId: string): Promise<void>
  /** Is a slash name advertised by the CURRENT completion list? */
  wasAdvertisedClaim(name: string): boolean
  /** Does the CURRENT effective host catalog claim this line? (The
   *  advertised union view — completion/advertised-miss semantics.) */
  hostClaimOf(parsed: { name: string; rawInput?: string }): HostCommandClaim | undefined
  /** PR5 v2 §1C-4: the GENUINE Host-origin line authority (this TUI's own
   *  Direct compatibility mirrors excluded; Client synthesis can never
   *  overwrite it) — the ROUTING primitive. */
  hostOriginClaimOf(parsed: { name: string; rawInput?: string }): HostCommandClaim | undefined
  /** §D3 precedence: does a GENUINE HOST-ORIGIN command resolve the name?
   *  (The claim-set union cannot answer this — it also carries this
   *  surface's own Client registrations.) */
  hostCatalogResolves(name: string): boolean
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
  /** The Client-owned command registry (PR4 §1.3): the submission route's
   *  TUI_BUILTIN execution owner on the Remote branch. */
  readonly clientCommands: ClientCommandRegistry
  /** §1C-6: the LIVE Client registry's exact-line claim — the ONLY source the
   *  line classification may read for TUI ownership. Never a static name
   *  list: a name in `LOCAL_COMMANDS` without a live registration owns no
   *  production line. */
  clientClaimsLine(parsed: { name: string; rawInput?: string } | undefined): boolean
  /** The exact Direct attachment of a fenced live scope. */
  agentForLiveScope(scope: SessionScope): ExactAgent
  /** The exact Direct attachment of an already-fenced live session id. */
  attachmentForSession(sessionId: string): ExactAgent
  /** Release the catalog coordinator (disposal orchestration). */
  disposeCatalog(): void
  /** Bind the semantic command runtime AND build the facade: the composition
   *  root's single command-wiring step (plan §A5b-3, "Move together"). */
  attachRuntime(): void
  /** Build + store the TuiCommandRunner facade from a bound runtime. */
  buildRunner(runtime: CommandRuntime): TuiCommandRunner
  /** The stored TuiCommandRunner facade. */
  runner(): TuiCommandRunner
}

/** Create the command authority owner (plan §A5b-3). */
export function createCommandSurface<Selection extends ModelSelectionValue, Id extends string, ExactAgent extends CommandAgentShape>(
  deps: CommandSurfaceDeps<Selection, ExactAgent>,
): CommandSurface<Selection, ExactAgent> {
  let runnerFacade: TuiCommandRunner | undefined
  /** The stored facade accessor; the delivery binding and `registerCommands`
   *  read it at call time, never as a construction-time capture. */
  const runner = (): TuiCommandRunner => {
    if (runnerFacade === undefined) throw new Error('the command runner is not built')
    return runnerFacade
  }
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

  /** PR5 v2 §1C-4: the installed GENUINE Host-origin line authority. */
  let hostOriginClaimOf: ((parsed: { name: string; rawInput?: string }) => HostCommandClaim | undefined) | undefined

  /** The §D3 precedence discriminator installed by registerTuiCommands: does
   *  the AUTHORITATIVE HOST catalog resolve the name (never the union claim
   *  set, which also carries this surface's own Client registrations)? */
  let hostCatalogResolves: ((name: string) => boolean) | undefined

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

  // M3-6 PR2 §13.3.1: the Remote-only Connection-generation invalidation
  // lifetime. `observedRemoteConnectionGeneration` is the last token the
  // callback saw (the identity authority — never a `firstEvent` boolean);
  // `disposeRemoteConnectionGeneration` is the official unsubscribe slot,
  // released by `disposeCatalog()` BEFORE the coordinator goes away.
  let observedRemoteConnectionGeneration: unknown | undefined
  let disposeRemoteConnectionGeneration: (() => void) | undefined

  const skillsChangeGate = new CoalescingRefreshGate(() => {
    runOwned('skills/change refresh', async () => {
      const refresh = catalogRefreshRequest
      if (refresh === undefined) return undefined
      const liveAgent = deps.liveAgent()
      const target = liveAgent === undefined
        ? { kind: 'preset', presetId: deps.presets.pending() ?? deps.presets.launch } as const
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
   * PR4 §2.2: the Remote coordinator target — an opaque wrapper carrying the
   * session id (never an Agent). The coordinator's readAgent unwraps it and
   * reads through the generation-fenced command source.
   */
  const REMOTE_CATALOG_TARGET = Symbol('remote-catalog-target')
  const remoteCatalogTargetOf = (sessionId: string): object => ({
    [REMOTE_CATALOG_TARGET]: sessionId,
  })
  const remoteSessionIdOfCatalogTarget = (target: object): string | undefined => {
    const record = target as { [REMOTE_CATALOG_TARGET]?: string }
    return typeof record[REMOTE_CATALOG_TARGET] === 'string' ? record[REMOTE_CATALOG_TARGET] : undefined
  }
  /**
   * The Remote live-catalog read: the command source's generation-fenced
   * snapshot mapped onto the coordinator's snapshot shape (scoped overrides
   * do not exist on the Remote branch — the whole catalog is the effective
   * view; scopedCommands is empty). The composition itself lives in
   * {@link composeRemoteSurfaceCatalog} so the production read is directly
   * regression-testable.
   */
  const readRemoteSurfaceCatalog = async (
    sessionId: string,
    signal: AbortSignal,
  ): Promise<import('../../domain/catalog/surface.ts').SurfaceCatalogSnapshot> => {
    const source = deps.remoteCommandSource
    if (source === undefined) throw new Error('the Remote command source is unavailable')
    return composeRemoteSurfaceCatalog({
      source,
      listHumanSkills: (id, readSignal) => deps.catalog.skills.listHumanSkills(id, readSignal),
      sessionId,
      signal,
    })
  }
  /**
   * The Remote scoped-commands view (the command runtime's display/collision
   * baseline): the Client registry's OWN descriptors are the only
   * synchronously-readable authority (the Host catalog arrives through
   * async snapshots; its claim precedence is enforced separately by
   * hostClaimOf against the installed claims). Name-only summaries keep the
   * collision baseline honest without inventing Host metadata.
   */
  const remoteListScopedCommands = (): readonly import('../../domain/catalog/surface.ts').SurfaceCommandSummary[] =>
    deps.clientCommands.list().map(definition => ({
      name: definition.name,
      description: definition.description,
      ...definition.input === undefined ? {} : {
        input: {
          hint: definition.input.hint,
          ...definition.input.attachments === true ? { attachments: true } : {},
        },
      },
    }))

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

  /** PR4 §2.2: the Remote live refresh — the coordinator target wraps the
   *  session id (the command source reads the Host metadata generation-fenced).
   *  M3-6 PR2 §13.3.2: `source` names the refresh trigger for diagnostics
   *  ('invalidation' for the reconnect callback); existing callers keep the
   *  default 'live-session' behavior. */
  const refreshLiveCatalogById = async (
    sessionId: string,
    source: CatalogRefreshSource = 'live-session',
  ): Promise<void> => {
    const refresh = catalogRefreshRequest
    if (refresh === undefined) return
    await refresh({
      source,
      target: { kind: 'agent', key: deps.ownership.generation() },
      agent: remoteCatalogTargetOf(sessionId),
    })
  }

  const registerCommands = (initial?: InitialCommandCatalog): void => {
    if (commandsRegistered) return
    commandsRegistered = true
    try {
      const installed = registerTuiCommands(runner(), initial, {
        ...(deps.directCatalog === undefined ? {} : { listGlobalCommands: deps.directCatalog.listGlobalCommands }),
      })
      // Per-name degradation notice (M3-4 PR2): a Host-claimed name (the
      // Remote Host composition mounts `/export` itself) fails only ITS own
      // registration — later commands still installed. The user sees the
      // exact names, never a generic whole-pass failure.
      if (installed.registrationFailures.length > 0) {
        const names = installed.registrationFailures.join('; ')
        deps.logError(`tui-runner: commands not registered (claimed by the Host composition): ${names}`)
        deps.diag.warn('command name collisions', { failures: [...installed.registrationFailures] })
        deps.app().notify(`not registered (claimed elsewhere): ${names}`, 'error')
      }
      wasAdvertisedClaim = installed.wasAdvertised
      hostClaimOf = installed.hostClaimOf
      hostOriginClaimOf = installed.hostOriginClaimOf
      hostCatalogResolves = installed.hostCatalogResolves
      isSkillWrapperName = installed.isSkillWrapper
      refreshCommandCompletions = installed.refreshCommandCompletions
      withCommandDelivery = installed.withDelivery
      takeCommandDraftDisposition = installed.takeCommandDraftDisposition
      // The coordinator's surface hooks point INTO the command surface;
      // the command runtime's refresh facades (and the switch/first-session
      // path) route every post-mount refresh through `catalogRefreshRequest`.
      catalogCoordinator = new CatalogRefreshCoordinator({
        // PR4 §2.2: the coordinator target is branch-opaque. Direct feeds the
        // exact Agent to readSurfaceCatalog; Remote wraps its session id in a
        // target object and reads through the generation-fenced command
        // source (Host command + human-skill metadata, no Agent, no
        // Client-side fold).
        readAgent: (agent, readSignal) => {
          const remoteSessionId = remoteSessionIdOfCatalogTarget(agent)
          if (remoteSessionId !== undefined) {
            return readRemoteSurfaceCatalog(remoteSessionId, readSignal)
          }
          const directCatalog = deps.directCatalog
          if (directCatalog === undefined) {
            throw new Error('BUG: the Direct catalog read capability is unavailable')
          }
          return directCatalog.readSurfaceCatalog(agent as unknown as ExactAgent, readSignal)
        },
        // The sessionless (preset) target reads the STANDING skill catalog
        // through the catalog capability (migration M1.8) — the
        // capability-gated cold path (standing key → global → degraded
        // global with a notice), never an Agent probe: probes emit
        // durable session events in this deployment (see
        // docs/surface-catalog.md).
        readStanding: (presetId, readSignal) =>
          deps.catalog.skills.standing(presetId, deps.clientCwd, readSignal),
        // §2.2/§16 final-install fence: the Remote target's admission
        // transport identity (captured ONCE at refresh admission, only ever
        // COMPARED before installSnapshot — a same-id binding rollover in
        // the settle→install gap must not commit the retired read; review
        // round 2's final-gap finding). The Direct agent-scoped target has
        // no transport identity here — its reader owns the checks.
        ...(deps.remoteCommandSource === undefined ? {} : {
          captureTargetIdentity: () => {
            const sessionId = deps.ownership.currentSessionId()
            return sessionId === undefined ? undefined : deps.remoteCommandSource!.captureTransportToken(sessionId)
          },
          isTargetCurrent: (identity: unknown) => {
            const sessionId = deps.ownership.currentSessionId()
            return sessionId !== undefined
              && deps.remoteCommandSource!.isTransportTokenCurrent(sessionId, identity)
          },
        }),
        installSnapshot: (next) => installed.installSnapshot(next),
        enterCatalogTransition: () => installed.enterTransition(),
      }, deps.signal, deps.diag)
      catalogRefreshRequest = (request) => catalogCoordinator!.refresh(request)
      subscribeSkillsChangeEvents()
      // M3-6 PR2 §13.3.3: the Remote-only Connection-generation
      // invalidation subscription, installed AFTER the coordinator and the
      // refresh request slot exist. Capture-before-subscribe is mandatory
      // (§13.3.4): the official observable may notify SYNCHRONOUSLY at
      // subscription time, and the token identity (never a `firstEvent`
      // boolean) makes that immediate callback a no-op — no duplicate
      // startup refresh. The callback reads the CURRENT session id at
      // execution time (§6 Must 4), never a startup-captured id.
      if (deps.remoteCommandSource !== undefined) {
        observedRemoteConnectionGeneration = deps.remoteCommandSource.connectionGeneration()
        disposeRemoteConnectionGeneration =
          deps.remoteCommandSource.subscribeConnectionGeneration(() => {
            const source = deps.remoteCommandSource
            if (source === undefined) return
            const next = source.connectionGeneration()
            if (Object.is(next, observedRemoteConnectionGeneration)) return
            observedRemoteConnectionGeneration = next
            // Disconnected / connecting (§6 Must 2): keep the last-good
            // Host claims; NO catalog RPC, no Session retain, no UI clear.
            if (next === undefined) return
            const sessionId = deps.ownership.currentSessionId()
            if (sessionId === undefined) return
            runOwned(
              'remote reconnect catalog refresh',
              () => refreshLiveCatalogById(sessionId, 'invalidation'),
              {
                diag: deps.diag,
                sessionId: () => deps.ownership.currentSessionId(),
              },
            )
          })
      }
    } catch (error) {
      // A failed registration must not lock the surface forever (a locked
      // flag would leave every later command resolving to a plain message
      // silently): reset the flag for a later retry and surface the
      // failure visibly instead of swallowing it.
      commandsRegistered = false
      const message = safeErrorMessage(error)
      deps.logError(`tui-runner: command registration failed: ${message}`)
      deps.diag.error('command registration failed', { error: message })
      deps.app().notify(`command registration failed: ${message}`, 'error')
    }
  }


  /**
   * Build + store the TuiCommandRunner facade. Late-built on purpose: the
   * facade consumes the submission deps (A5b-4) and, through them, the whole
   * presentation surface. The composition calls this right after binding the
   * semantic command runtime, before any registration. Every moved `let` slot
   * that registration rebinds (`withCommandDelivery`) is read through the
   * local accessor at call time, never captured by value.
   */
  /** The BOUND semantic command runtime (A3-5): it owns the scope/currentness
   *  fence and the facade shapes; every Direct fact is injected here as a
   *  narrow surface hook, and the Host skill catalog reads go through the
   *  semantic capability. The binding is command-owned; only the Host-session
   *  reads it needs stay in the composition root (`deps.direct`). */
  const attachRuntime = (): void => {
    const runtime = bindCommandRuntime({
      scope: deps.sessionScope,
      session: {
        ensureSession: () => deps.session.ensureSession(),
        withWriter: (scope, task) => deps.session.withWriter(scope, task),
      },
      skills: deps.catalog.skills,
      surface: {
        // PR4 §2.2: the Direct seams above (scoped commands, running, routing,
        // stats, last assistant text) are Direct-only; the Remote branch
        // supplies its own projection-backed equivalents below through the
        // injected remote facts. The DISCRIMINATOR is the backend kind.
        listScopedCommands: () => deps.backend.kind === 'direct'
          ? deps.direct.listScopedCommands()
          : remoteListScopedCommands(),
        sessionRunning: (sessionId) => deps.backend.kind === 'direct'
          ? attachmentForSession(sessionId).status === 'running'
          : (deps.remoteFacts?.running(sessionId) ?? false),
        sessionRouting: (sessionId) => {
          if (deps.backend.kind !== 'direct') {
            // §3.2: provider/model from the modelSelection projection, cwd
            // from the official session row — never the Client cwd as if it
            // were the Host session cwd.
            const facts = deps.remoteFacts?.sessionStatus(sessionId)
            return {
              provider: facts?.model?.provider,
              model: facts?.model?.model,
              cwd: facts?.cwd ?? '',
            }
          }
          const agent = attachmentForSession(sessionId)
          // `provider`/`model` are OPTIONAL in the DSH AgentOptions contract and
          // the Direct composition may leave them unset: their absence is real
          // semantic optionality, never an invariant break.
          return {
            provider: agent.options.provider,
            model: agent.options.model,
            cwd: agent.session.header.cwd ?? deps.clientCwd,
          }
        },
        approvalOverride: (sessionId) =>
          deps.backend.config.permissions.approvalOverrideOf(sessionId),
        sessionStats: (sessionId) => deps.direct.sessionStats(sessionId),
        lastAssistantText: (sessionId) => deps.direct.lastAssistantText(sessionId),
        refreshLiveCatalog: async (sessionId, source) => {
          if (!catalogRefreshAvailable()) return { kind: 'failed', error: 'catalog refresh unavailable' }
          // PR4 §2.2: the Remote live refresh reads the command source
          // (generation-fenced metadata) with the session id as the target —
          // never a Direct Agent resolution.
          if (deps.backend.kind !== 'direct') {
            return requestCatalogRefresh({
              source,
              target: { kind: 'agent', key: deps.ownership.generation() },
              agent: remoteCatalogTargetOf(sessionId),
            })
          }
          // SYNC admission: the exact Direct owner is captured HERE, before the
          // read awaits (§10.2).
          const agent = attachmentForSession(sessionId)
          return requestCatalogRefresh({
            source,
            target: { kind: 'agent', key: deps.ownership.generation() },
            agent: deps.toCatalogAgent(agent),
          })
        },
        refreshStandingCatalog: (presetId, source) =>
          catalogRefreshAvailable()
            ? requestCatalogRefresh({ source, target: { kind: 'preset', presetId } })
            : Promise.resolve({ kind: 'failed', error: 'catalog refresh unavailable' }),
        promptAdmission: (sessionId, line, task) =>
          // M3-4 PR3 (§10.2): the Remote branch RETIRES the Direct-Agent
          // admission hook — the exact-owner resolution must not even run
          // (argument evaluation would throw); Host business admission lives
          // in the official Session write path. The DISCRIMINATOR is the
          // explicit backend kind, never a capability flag (a future Remote
          // shell-completion carrier must not silently re-open Direct
          // attachment admission).
          deps.backend.kind === 'direct'
            ? deps.direct.promptAdmission(attachmentForSession(sessionId), draftHasImages(line, deps.drafts.images), async () => task())
            : Promise.resolve(task()) as never,
      },
    })
    buildRunner(runtime)
  }

  const buildRunner = (runtime: CommandRuntime): TuiCommandRunner => {
    const facade: RunnerFacade<Selection, Id> = {
      ctx: deps.ctx,
      app: deps.app(),
      diag: deps.diag,
      get currentSessionId() { return deps.ownership.currentSessionId() },
      // The A3-5 semantic command runtime (scope/currentness, scoped catalog,
      // skill execution, stats/read, catalog refresh, prompt admission and the
      // writer exposure) — the runner delegates these members to it.
      ...runtime,
      // Completion-notification preference setters (the /settings panel
      // writes): the controller applies the parsed value immediately and
      // the panel persists the raw string through the config port.
      setNotificationMode: (mode) => deps.surface.setNotificationMode(mode),
      setNotificationMethod: (method) => deps.surface.setNotificationMethod(method),
      setTerminalProgressMode: (mode) => deps.surface.setTerminalProgressMode(mode),
      ensureSession: () => deps.session.ensureSession(),
      get selected() { return deps.model.selected },
      // Legacy/display facade: the newest SESSIONLESS `/model` intent (pending
      // or unresolved) falling back to the persisted global default. A fresh
      // create never seeds from it — the Direct adapter captures the persisted
      // Host default at admission.
      defaultSelection: () => deps.model.defaultIntent.intent ?? deps.model.currentDefault(),
      get defaultIntent() { return deps.model.defaultIntent.intent },
      get defaultIntentRecord() { return deps.model.defaultIntent.record },
      get defaultIntentOutcome() { return deps.model.defaultIntent.outcome },
      awaitPendingDefaultWrite: (signal) => deps.model.awaitPendingDefaultWrite(signal),
      trackDefaultWrite: (write) => deps.model.trackDefaultWrite(write),
      setModelSelectionPending: (selection, token, status) => deps.model.setPending(selection, token, status),
      reconcileDefaultIntent: (persisted) => deps.model.reconcileDefaultIntent(persisted),
      setDefaultIntent: (next) => deps.model.setDefaultIntent(next),
      settleIntent: (id, outcome) => deps.model.settleIntent(id, outcome),
      get tuiSettings() { return deps.tuiSettings },
      // /new and /fork create through the session lifecycle port (semantic
      // requests — the Direct adapter resolves the preset composition).
      agents: deps.agents,
// M2: apply the persisted footer mode + layout (shared by /settings,
      // /reload and the startup path).
      applyFooterSettings: (doc, saved) => deps.settings.applyFooterSettings(doc, saved),
      // The session READ port (migration M1.3): /sessions, /resume, /search,
      // the title batches, the context measurement and the export read go
      // through the port, never ctx directly.
      sessionReader: deps.backend.sessionReader,
      // PR D2: the /status explicit force — measure NOW through the
      // coordinator (mark dirty + semantic reader), repaint the footer
      // cheaply, and return the fresh (or last-good) value for the panel.
      // Panel and footer share ONE cached measurement: no duplicate reads
      // against the coordinator's cache, no stale footer after an explicit
      // status (round-8 finding).
      forceContextMeasurement: () => deps.status.forceContextMeasurement(),
      // The session WRITE port (D2.1): ordinary prompts, Ctrl+S batch
      // delivery, exact queue removal, cancel and title ops go through the port.
      sessionWriter: deps.backend.sessionWriter,
      // The interaction port (migration M1.6): approval/question authority.
      interaction: deps.backend.interaction,
      // The catalog port (migration M1.8): models/providers, presets and
      // skills — commands read Host catalogs through semantic DTOs.
      catalog: deps.backend.catalog,
      // The config port (migration M1.9): settings, provider profiles,
      // credentials, authorization, permissions and the preset default.
      config: deps.backend.config,
      // The Host-file port (migration M1.10): `@`-mention discovery and
      // send-time canonicalization against the Host filesystem.
      hostFile: deps.backend.hostFile,
      hostShellCompletion: deps.backend.hostShellCompletion,
      // PR5 (plan §3.2): the presentation-owned recent-performance
      // availability of the CURRENT main window — the /status panel reads
      // it beside the composed stats. Absent on Direct-shaped compositions
      // (the full log is authoritative by construction).
      ...(deps.recentPerformanceAvailable === undefined ? {} : {
        recentPerformanceAvailable: deps.recentPerformanceAvailable,
      }),
      // The readable-transcript business capability (round 5): explicitly
      // backend-owned, NEVER derived from the commandRegistry mirror below
      // (that mirror retires with M8).
      transcriptExportAvailable: deps.backend.transcriptExportAvailable,
      // The minimal commands registry for the TUI's OWN registrations
      // (migration M1.11) — the runner assembly dependency, never a Host
      // capability exposed to command handlers. Direct-only on PR4: the
      // Remote branch registers nothing into the Host service.
      commandRegistry: deps.commandsRegistry(),
      // The Client-owned registry (PR4 §D2): the TUI's OWN execution surface
      // on Remote; the shared definition owner on both branches.
      clientCommands: deps.clientCommands,
      cwd: deps.clientCwd,
      imageStore: deps.drafts.images,
      fileStore: deps.drafts.files,
      // Issue #7: `/copy` uses the SAME shared user-clipboard delivery
      // policy as the fullscreen selection (see copySelection above).
      copyToClipboard: (text) => copyToClipboard(text, deps.client.runCopyCommand, deps.client.copyEnv),
      // The deployment image policy, re-read dynamically so a runtime
      // reconfiguration is picked up (plan §10.1: never a cached copy).
      imageLimits: () => deps.imageLimits(),
      insertIntoEditor: (text) => deps.app().insertIntoEditor(text),
      // The shared prepared-input pipeline (skills build their message
      // through this — review finding 4).
      prepareDraftMessage: (text) => prepareUserMessage(text, deps.drafts.images, deps.submission.prepareDeps()),
      // PR4 review round: the Remote branch's skill-gesture delivery must use
      // the transport-aware preparation (PreparedPrompt), exactly like an
      // ordinary prompt; absent on Direct.
      ...(deps.prepareTransportMessage === undefined ? {} : {
        prepareTransportMessage: (text: string, requestId: string) => deps.prepareTransportMessage!(text, requestId),
      }),
      // M5: the extension registries (commands/themes/settings/autocomplete/
      // keybindings), when the extension service is mounted. The /settings
      // and /theme pickers read them; undefined degrades to the host-only
      // panel.
      get extensions() { return deps.extensions.current() },
      recordExtensionError: (ref, error) => deps.extensions.recordError(ref, error),
      clearExtensionError: (ref) => deps.extensions.clearError(ref),
      /** The live session's workspace cwd (header), falling back to the
       * process cwd before any session exists; the footer/welcome/
       * completions/history follow it so a session switch updates the
       * whole surface. */
      sessionCwd: () => deps.status.sessionCwd(),
      signal: deps.signal,
      progressUpdatesState: deps.promptState.progressUpdates,
      responseStyleState: deps.promptState.responseStyle,
      gitAttributionState: deps.promptState.gitAttribution,
      /** Canonical display surface: /display and /focus compatibility both
       * read and mutate the shared DisplayState through one setter. */
      displayPreset: () => deps.displayState.preset,
      setDisplayPreset: (preset) => deps.settings.setDisplayPreset(preset),
      /** @deprecated Focus compatibility facade. */
      focusEnabled: () => isFocusDisplayPreset(deps.displayState.preset),
      setFocusMode: (enabled) => { deps.settings.setDisplayPreset(enabled ? 'focus' : 'full') },
      get pendingPreset() { return deps.presets.pending() },
      set pendingPreset(id: string | undefined) { deps.presets.setPending(id) },
      /** The effective preset id for COLD (sessionless) reads: the run-local
       * pending override ahead of the launch-time --preset (the SAME
       * precedence ensureSession uses); undefined = the saved/default
       * preset applies. */
      get effectivePresetId() { return deps.presets.pending() ?? deps.presets.launch },
      applyPermissionPreset: async (scope, presetId, presetSignal) => {
        // A stale scope BEFORE the dispatch proves nothing ran: report `refused`.
        if (!deps.sessionScope.isCurrent(scope)) return { ownership: 'refused' as const }
        // PR5 v2 §1D: NO Direct-Agent prerequisite — the permission preset
        // apply is transport-neutral (ConfigPort → the official
        // /permission path); a Remote session must reach it without any
        // in-process Agent resolution.
        const outcome = await deps.backend.config.permissions.applyPermissionPreset(scope.sessionId, presetId, presetSignal)
        // The operation WAS dispatched. Losing the surface after the fact must NOT
        // erase what the port settled (`src/runtime/write-outcome.ts`: ownership and
        // settlement are independent axes) — the caller may not claim "not applied".
        if (!deps.sessionScope.isCurrent(scope)) return { ownership: 'superseded' as const, outcome }
        return { ownership: 'current' as const, outcome }
      },
      setSessionApprovalPolicy: (scope, value) => {
        // Same contract for the synchronous write: validate, then dispatch in
        // the SAME stack — the exact owner, never `sessionId` re-resolved later.
        if (!deps.sessionScope.isCurrent(scope)) return 'superseded' as const
        agentForLiveScope(scope)
        deps.backend.interaction.setApprovalPolicy(scope.sessionId, value)
        return 'applied' as const
      },
      switchSession: (sessionId) => deps.session.switchSession(sessionId),
      forkSession: (sourceSessionId) => deps.session.forkSession(sourceSessionId),
      transitionTo: (steps) => deps.session.transitionTo(steps),
      currentPreset: deps.presets.current,
      sessionBlank: deps.presets.blank,
      // PR D2: the command surface's generic refresh is UI-only (a
      // measurement-triggering command uses refreshContextMeasurement or
      // the /status port call directly).
      refreshStatus: () => deps.status.refresh(),
      updateWelcomeCard: () => deps.status.updateWelcomeCard(),
      openJobView: (jobId) => deps.surface.openJobView(jobId),
      // The zero-arg runner callback (commands.ts) is the `/tasks` surface:
      // it opens the FULL browser explicitly.
      openTasksBrowser: () => deps.surface.openTasksBrowser('full'),
      openRewindPicker: deps.openRewindPicker,
      // `/plugins` opens the profile-wide Plugin Manager panel (P1-A). It is
      // NOT session-owned: it never creates or switches a Session.
      openPluginManager: () => deps.pluginManager.open(),
      createPluginManagerSubmenu: (done) => deps.pluginManager.submenu(done),
      // The attachment-intake UX fence: the ONE production reader of the
      // transition gate. Staging an attachment while a transition is in flight
      // (quiesce → commit) would inject a draft into a session about to be
      // retired. Semantic session writes never read this flag — they admit
      // through the operation barrier (SessionRuntime.withWriter).
      sessionTransitionPending: () => deps.transition.pending(),
      // The single-writer session-transition gate: ordinary /new and
      // command-side switches run create AND commit inside one exclusive
      // section via this seam. Host fork dispatch is outside this FIFO;
      // forked-child adoption and rewind navigation use their own gated
      // adoption path.
      withSessionTransition: <T>(task: () => Promise<T> | T) =>
        deps.transition.run(async () => {
          try {
            return await task()
          } finally {
            // A command may fail during preflight before it calls
            // transitionTo; do not leave a deferred recall unresolved.
            deps.submission.settleQueueRecalls(false)
          }
        }),
      enterView: (childId: Id, label: string | undefined, mode: 'one-shot' | 'continuable', parentSessionId: Id, activity: 'running' | 'inactive') =>
        deps.viewer.enterView(childId, label, mode, parentSessionId, activity),
      requestExit: deps.requestExit,
      exit: deps.exit,
    }
    // The ONE generic→concrete bridge of this owner: the frozen
    // `TuiCommandRunner` contract names the Host selection/session-id types,
    // which cannot be imported here (boundary rule). The composition root
    // instantiates the generics with exactly those Host types, so this cast is
    // an identity at every instantiation; the facade itself is fully
    // type-checked against `RunnerFacade<Selection, Id>` above.
    runnerFacade = facade as unknown as TuiCommandRunner
    return runnerFacade
  }

  const catalogRefreshAvailable = (): boolean => catalogRefreshRequest !== undefined
  const requestCatalogRefresh = (request: CatalogRefreshRequest): Promise<CatalogRefreshOutcome> => {
    if (catalogRefreshRequest === undefined) return Promise.reject(new Error('the command catalog is not registered'))
    return catalogRefreshRequest(request)
  }
  const disposeCatalog = (): void => {
    // M3-6 PR2 §13.3.6: release the Remote generation listener FIRST (a
    // late generation callback after disposal must not start a read), then
    // dispose the coordinator. M3-6 PR3: both one-shot slots and the refresh
    // request are retired BEFORE either callback runs, so a throwing official
    // unsubscribe can neither skip the coordinator disposal nor leave a live
    // refresh path behind this surface; the collected failure is surfaced
    // after both attempts.
    const generationUnsubscribe = disposeRemoteConnectionGeneration
    const coordinator = catalogCoordinator
    disposeRemoteConnectionGeneration = undefined
    catalogCoordinator = undefined
    // The Direct `skills/change` capability offers no unsubscribe, so a late
    // event can still reach the coalescing gate after teardown. Clearing the
    // request slot makes both refresh paths no-ops (they guard on undefined)
    // instead of touching the disposed coordinator.
    catalogRefreshRequest = undefined
    runSyncDisposalSteps('command catalog disposal', [
      () => generationUnsubscribe?.(),
      () => coordinator?.dispose(),
    ])
  }

  return {
    attachRuntime,
    register: registerCommands,
    refreshLiveCatalog,
    refreshLiveCatalogById,
    wasAdvertisedClaim: (name) => wasAdvertisedClaim?.(name) === true,
    hostClaimOf: (parsed) => hostClaimOf?.(parsed),
    hostOriginClaimOf: (parsed) => hostOriginClaimOf?.(parsed),
    hostCatalogResolves: (name) => hostCatalogResolves?.(name) === true,
    isSkillWrapperName: (name) => isSkillWrapperName?.(name) === true,
    takeCommandDraftDisposition: (commandId) => takeCommandDraftDisposition?.(commandId),
    refreshCompletions: () => refreshCommandCompletions?.(),
    // The delivery binding is a LATE-REBOUND slot: read it on every call, or the
    // owner would hand out the pre-registration default forever.
    withCommandDelivery: (delivery, run) => withCommandDelivery(delivery, run),
    requestCatalogRefresh,
    catalogRefreshAvailable,
    isSkillInvocation,
    clientCommands: deps.clientCommands,
    clientClaimsLine: (parsed) => deps.clientCommands.claimsLine(parsed),
    agentForLiveScope,
    attachmentForSession,
    disposeCatalog,
    buildRunner,
    runner,
  }
}

/**
 * The Remote live-catalog composition (PR4 §2.2/§16), extracted so the
 * PRODUCTION read is directly regression-testable (review round 3: a
 * hand-made snapshot cannot prove the reader's provider isolation).
 *
 * Provider isolation is symmetric: a rejected commands provider degrades to
 * an `issues` entry — the coordinator's `mergePartial` then keeps the
 * last-good Host claims — while a FULFILLED skills provider still updates its
 * own field. A transport supersession (the admission token no longer live
 * after BOTH settles, or an authoritative `undefined` from the commands read)
 * invalidates the whole snapshot instead: it may mix two bindings' facts.
 * @param input - the production seams and the session/signal.
 * @returns the composed snapshot for the coordinator.
 */
export async function composeRemoteSurfaceCatalog(input: {
  readonly source: {
    readCommands(sessionId: string, signal?: AbortSignal): Promise<readonly import('../../domain/catalog/surface.ts').SurfaceCommandSummary[] | undefined>
    captureTransportToken(sessionId: string): unknown
    isTransportTokenCurrent(sessionId: string, token: unknown): boolean
  }
  readonly listHumanSkills: (sessionId: string, signal?: AbortSignal) => Promise<import('../../domain/catalog/skill.ts').HumanSkillCatalog | undefined>
  readonly sessionId: string
  readonly signal: AbortSignal
}): Promise<import('../../domain/catalog/surface.ts').SurfaceCatalogSnapshot> {
  const { source, listHumanSkills, sessionId, signal } = input
  // §2.2 admission capture: the transport identity (Connection generation +
  // exact binding) is taken BEFORE any provider read; every settle is
  // re-checked against THIS frozen token (§16: a same-id binding rollover or a
  // Connection replacement must invalidate the refresh — the reader's own
  // fences cover each provider's round-trip, this covers the COMBINED settle:
  // one provider may settle before the rollover and the other after).
  const admissionToken = source.captureTransportToken(sessionId)
  const [commandsResult, skillsResult] = await Promise.allSettled([
    source.readCommands(sessionId, signal),
    listHumanSkills(sessionId, signal),
  ])
  signal.throwIfAborted()
  // Combined-settle fence: after BOTH providers settled, the admission
  // transport must still be live.
  if (!source.isTransportTokenCurrent(sessionId, admissionToken)) {
    throw new SupersededReadError('the connection changed during the catalog refresh')
  }
  const issues: Array<import('../../domain/catalog/surface.ts').SurfaceCatalogIssue> = []
  let commands: readonly import('../../domain/catalog/surface.ts').SurfaceCommandSummary[] = []
  if (commandsResult.status === 'rejected') {
    const reason = commandsResult.reason
    if (reason instanceof SupersededReadError) throw reason
    // A FAILED commands provider degrades to an issue (never an empty
    // success): mergePartial keeps the last-good Host claims for this field.
    issues.push({ provider: 'commands', message: safeErrorMessage(reason) })
  } else if (commandsResult.value === undefined) {
    throw new SupersededReadError('the connection changed during the catalog refresh')
  } else {
    commands = [...commandsResult.value].sort((left, right) => left.name < right.name ? -1 : 1)
  }
  // The skills provider is handled INDEPENDENTLY: its fulfilled result is
  // always used (a commands failure never discards it), and its own failure
  // / incompleteness / unavailability degrades only its field. An
  // `undefined` fulfillment is the port's declared "no skill registry
  // reachable for this session" (catalog-port §listHumanSkills) — a
  // truthful-unavailable OBSERVATION, never an empty success: it degrades
  // to a skills issue so the coordinator's merge keeps the last-good
  // skills (a same-target transient registry loss must not erase the
  // installed set; a genuinely empty-but-complete catalog still clears it).
  let skills: readonly import('../../domain/catalog/skill.ts').HumanSkillSummary[] = []
  if (skillsResult.status === 'fulfilled') {
    if (skillsResult.value === undefined) {
      issues.push({ provider: 'skills', message: 'the skill registry is unreachable for this session' })
    } else {
      skills = skillsResult.value.skills
      if (skillsResult.value.complete !== true) {
        issues.push({ provider: 'skills', message: 'incomplete skill observation' })
      }
    }
  } else {
    issues.push({ provider: 'skills', message: safeErrorMessage(skillsResult.reason) })
  }
  return Object.freeze({
    commands: Object.freeze(commands),
    scopedCommands: Object.freeze([]),
    skills: Object.freeze([...skills]),
    issues: Object.freeze(issues.map(issue => Object.freeze({ ...issue }))),
  })
}
