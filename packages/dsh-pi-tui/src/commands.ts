/**
 * The TUI-owned slash commands (/exit /settings /sessions /skill /model
 * /new /tasks /preset /subagents /search /title /rename /copy /export
 * /fork /status /login /logout /help), extracted from the runner's
 * monolithic apply() so the registration surface is testable and the runner
 * closure shrinks. Every command reads the live runner state through the
 * {@link TuiCommandRunner} interface, whose accessors re-read the current
 * agent/settings on every access (sessions can swap the live agent).
 * @module @xmoon76/dsh-pi-tui/commands
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult, CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { SettingsList, type SettingItem } from '@xmoon76/pi-tui'
import type { TuiApp } from './tui-app.ts'
import type { PickerItem } from './tui-app.ts'
import type { Diag } from './diag.ts'
import { runDetached, runOwned, type OwnedTaskOptions } from './detached.ts'
import { safeErrorMessage } from './error-boundary.ts'
import { color, loadCustomTheme, customThemeNames, settingsListTheme } from './theme.ts'
import { resolveFdPath } from './mentions.ts'
import { ModelSubmenu } from './model-menu.ts'
import { computeStats, formatStats } from './stats.ts'
import { renderTranscriptMarkdown, textOf } from './transcript.ts'
import {
  MAX_PICKER_SESSIONS,
  findSessionMatch,
  headerToPickerRow,
  loadSessionTitles,
  sessionPickerItem,
  type SessionPickerRow,
  type SessionQueryLike,
} from './sessions.ts'
import {
  credentialOptionsFor,
  deriveKeyRef,
  providerOptionsFor,
  resolveCredentialArg,
  ROUTE_PATTERN,
  PROTOCOL_CHOICES,
  type ProviderCatalogLlm,
  type ProviderCatalogSettings,
  type ProviderOption,
} from './provider-catalog.ts'
import type { CatalogRefreshOutcome, CatalogRefreshRequest } from './skill-catalog-refresh.ts'
import {
  commandSummaryOf,
  listGlobalCommands,
  type SurfaceCatalogSnapshot,
  type SurfaceCommandSummary,
} from './surface-catalog.ts'
import {
  isUserInvocableSkill,
  readHumanSkillCatalog,
  resolveLiveSkillTarget,
  type HumanSkillCatalog,
  type HumanSkillSummary,
  type SkillCatalogContext,
  type SkillCatalogTarget,
} from './skill-catalog.ts'

/** A balanced completed-turn prefix for forking: the log up to (and including)
 * the last `turn/end`. Undefined when no turn has completed yet.
 * @param events - the session log.
 * @returns the fork seed events, or undefined.
 */
export function forkSeed(events: readonly SessionEvent[]): readonly SessionEvent[] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/end') return events.slice(0, index + 1)
  }
  return undefined
}

/** Shorten a session id for read-only display rows, capped at 28 characters. */
function displaySessionId(id: string): string {
  return id.length > 28 ? `${id.slice(0, 28)}…` : id
}

/** Session meta for a fresh/forked session: the cwd plus the preset id when composed. */
function metaOf(cwd: string, presetId: string | undefined): Record<string, unknown> {
  return presetId === undefined ? { cwd } : { cwd, agentPreset: presetId }
}

/**
 * Display copy for the four shipped agent presets, fixed in English — the
 * web surface's `BUILT_IN_PRESET_KEYS` mapping (`dsh-client-ui-agent-preset`),
 * TUI-side. The EFFECTIVE roster root is the dsh install's own
 * `config/agent-presets`: the dsh CLI's profile composition replaces this
 * bundle's shipped root with that one at boot (the `composeProfile`
 * agent-presets overlay), and its preset.yml language is not ours to
 * control. Mapping the known ids keeps the picker English regardless of
 * what the files say; everything else renders file metadata. Names follow
 * the upstream English locale (`presetCodeName` is 'PTC mode' since dsh
 * 0.1.0-rc.7, renamed from 'Code mode').
 */
const BUILT_IN_PRESET_COPY: Readonly<Record<string, { name: string; description: string }>> = {
  standard: {
    name: 'Standard mode',
    description: 'Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.',
  },
  code: {
    name: 'PTC mode',
    description: 'All Standard mode capabilities, with tools exposed through the Code Mode SDK so the model can combine multi-step operations in one TypeScript program.',
  },
  minimal: {
    name: 'Minimal mode',
    description: 'Two-tool coding agent with persistent bash and str_replace_editor.',
  },
  cordis: {
    name: 'Creator mode',
    description: 'Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.',
  },
}

/** Resolve one roster row's display copy: fixed English for a shipped
 * (system-trust) preset id, otherwise the preset's file metadata. */
export function presetDisplayText(preset: {
  id: string
  trust: string
  name?: string
  description?: string
}): { name: string; description?: string } {
  const builtIn = preset.trust === 'system' ? BUILT_IN_PRESET_COPY[preset.id] : undefined
  if (builtIn !== undefined) return { name: builtIn.name, description: builtIn.description }
  return {
    name: preset.name ?? preset.id,
    ...preset.description === undefined ? {} : { description: preset.description },
  }
}

/** The TUI settings document surface (theme/footer/fullscreen/busyEnter).
 * The old `history` field moved to $DSH_HOME/user-history/*.jsonl and is
 * deliberately NOT part of the document anymore. */
export interface TuiSettingsLike {
  get(): { theme: string; footer: string; fullscreen: string; busyEnter: string }
  replace(doc: { theme: string; footer: string; fullscreen: string; busyEnter: string }): unknown
}

/** The agents-service surface /new and /fork create sessions through. */
export interface AgentsLike {
  create(options: {
    sessionId: SessionId
    meta: Record<string, unknown>
    // AgentOptions' provider/model are optional; mirror that shape.
    agentOptions: { provider?: string; model?: string }
    setup: (agentCtx: Context) => Promise<void> | void
    seed?: readonly SessionEvent[]
    // Creation-only cancellation (upstream CreateAgentOptions.signal); the
    // handle detaches from it on publication.
    signal?: AbortSignal
  }): Promise<AgentHandle>
}

/** Everything the TUI-owned commands read from the runner. */
export interface TuiCommandRunner {
  ctx: Context
  app: TuiApp
  /** The runner's diagnostics channel (stderr + $DSH_HOME/logs). */
  diag: Diag
  /** The live agent handle; re-read on every access (swaps on switch).
   * `undefined` until the first user message creates the session (deferred
   * start) — sessionless commands must degrade, session commands call
   * {@link ensureSession} first. */
  readonly liveAgent: Agent | undefined
  /** Create the first session lazily when none exists (deferred start). */
  ensureSession(): Promise<void>
  /** The process-wide mutable model selection (footer + /model). */
  readonly selected: ModelSelectionRef
  /** The TUI settings document, when the settings service is present. */
  readonly tuiSettings: TuiSettingsLike | undefined
  /** The agents service, for /new and /fork. */
  readonly agents: AgentsLike
  /** The sessions service, for the /exit flush. */
  readonly sessions: { flush(session: Session): Promise<unknown> }
  /** The ONE exit orchestration (flush with a hard timeout, cleanup, warn,
   * resume hint, process exit) — shared by Ctrl+C/Ctrl+D, /exit and /quit.
   * Command handlers must NEVER stop the app, flush or exit themselves. */
  requestExit(): void
  cwd: string
  /**
   * The live session's workspace (its header cwd), falling back to the
   * process cwd before any session exists. The editor autocomplete, the
   * footer/welcome cwd, and the per-directory input history follow THIS,
   * so switching sessions moves the whole surface with the session.
   */
  sessionCwd(): string
  signal: AbortSignal
  /** The runner's monotonic session generation; bumped on every session
   * swap. Late async work must re-check it before committing state. */
  readonly sessionGeneration: number
  compose(presetId?: string): Promise<{ agentPreset?: string; setup: (agentCtx: Context) => Promise<void> | void }>
  switchSession(sessionId: string): Promise<string | undefined>
  swapTo(next: AgentHandle): Promise<string | undefined>
  /** The preset the live agent runs on, when the deployment composes one. */
  currentPreset(): string | undefined
  /** The preset chosen with /preset while no session exists yet; the next
   * session composes on it (run-local, ahead of launchPreset/default). */
  pendingPreset: string | undefined
  /** The effective preset id for COLD (sessionless) reads: the run-local
   * pending override ahead of the launch-time --preset (the SAME precedence
   * the runner's ensureSession uses); undefined = the saved/default preset
   * applies. */
  readonly effectivePresetId: string | undefined
  /** Run one catalog refresh through the coordinator (the surface's only
   * post-mount refresh path: live-agent targets and sessionless standing
   * preset targets — composition probes are disabled in this deployment,
   * see docs/surface-catalog.md). Never rejects: outcomes are `applied`,
   * `failed` or `superseded`. */
  refreshCatalog(request: CatalogRefreshRequest): Promise<CatalogRefreshOutcome>
  /** Re-compose a still-blank session onto another preset (see recomposeBlank). */
  recomposeBlank(presetId: string): Promise<{ kind: 'switched'; preset: string } | { kind: 'locked' }>
  refreshStatus(): void
  /** Repaint the welcome card from the live agent's current facts (e.g. after a preset switch). */
  updateWelcomeCard(): void
  /**
   * Open one job's detail from a task list: bash jobs show the status
   * viewer, subagent jobs the child transcript. Shared by the ↓/Ctrl+J
   * browser and `/tasks`.
   */
  openJobView(jobId: string): void
  enterView(childId: SessionId, label?: string): Promise<void>
  exit(code: number): void
}

/** The sentinel picker value for the "add a brand-new provider" action row. */
const ADD_PROVIDER_VALUE = '\u0000add-provider'

/** The structural llm model-discovery surface /login probes. */
interface ProviderCatalogDiscovery {
  discoverModels(
    settingsNs: string,
    request: { provider?: string; baseURL?: string; api?: string; apiKey?: string; signal?: AbortSignal },
  ): Promise<readonly { id: string; name?: string }[]>
}

/** The structural settings write surface the add wizard persists through. */
interface ProviderCatalogSettingsWrite {
  mutate(ns: string, ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[]): Promise<unknown>
}

/** Read the llm-pi-ai adapter's `providers` dict from its settings section,
 * or undefined when the settings service or the section is absent. */
function readLlmpiAiProviders(ctx: Context): Record<string, { apiKeyEnv?: string } | undefined> | undefined {
  const settings = ctx.get('settings')
  if (settings === undefined) return undefined
  try {
    const section = settings.get(settingsNamespace('llm-pi-ai')) as
      | { providers?: Record<string, { apiKeyEnv?: string } | undefined> }
      | undefined
    return section?.providers
  } catch {
    return undefined
  }
}

/** Read the merged /login option list: the llm configurable-provider
 * directory when the llm service is present, the settings-only fallback
 * otherwise. */
function readProviderOptions(ctx: Context): ProviderOption[] {
  const llm = ctx.get('llm') as ProviderCatalogLlm | undefined
  const settings = ctx.get('settings') as ProviderCatalogSettings | undefined
  const readSection = (ns: string): unknown => {
    if (settings === undefined) return undefined
    try {
      return settings.get(ns)
    } catch {
      return undefined
    }
  }
  if (llm !== undefined) {
    try {
      return providerOptionsFor(llm.listConfigurableProviders(), readSection)
    } catch {
      // A throwing directory read degrades to the settings-only fallback.
    }
  }
  // Settings-only fallback (old behavior): deepseek official plus every
  // llm-pi-ai route the section declares.
  const settingsOnly = credentialOptionsFor(readLlmpiAiProviders(ctx))
  return settingsOnly.map((option, index) => index === 0 ? {
    ...option,
    route: 'deepseek-official',
    configured: true,
    declared: false,
    group: 'configured' as const,
    settingsNs: '',
    settingsPath: [],
  } : {
    ...option,
    route: option.label,
    configured: true,
    declared: false,
    group: 'configured' as const,
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', option.label],
  })
}

/** Build the picker rows from the merged options: grouped by configured /
 * available / custom, with the Add New Platform action row pinned last. */
function providerPickerRows(options: readonly ProviderOption[]): PickerItem[] {
  const rows: PickerItem[] = []
  const groups: ReadonlyArray<readonly [ProviderOption['group'], string]> = [
    ['configured', 'configured'],
    ['available', 'available · catalog'],
    ['custom', 'custom'],
  ]
  for (const [group, label] of groups) {
    const members = options.filter(option => option.group === group)
    if (members.length === 0) continue
    rows.push({ value: `\u0000group-${group}`, label: `── ${label} (${members.length}) ──`, group })
    for (const option of members) {
      rows.push({ value: option.route, label: `${option.label} (${option.ref})`, group })
    }
  }
  rows.push({ value: ADD_PROVIDER_VALUE, label: '[ Add New Platform ]' })
  return rows
}

/** The add-provider wizard outcome. */
type AddProviderOutcome =
  | { kind: 'ok'; text: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; text: string }

/** Run the add-provider wizard: collect route/api/baseURL/displayName/key
 * through question flows, probe the endpoint for its models (falling back to
 * hand entry), review, then persist the profile + credential.
 * @param ctx - the command context.
 * @param app - the TUI surface (question flows / pickers).
 * @param signal - the runner's abort signal (probe cancellation).
 * @param prefilledRoute - route pre-filled from `/login <route>`.
 * @returns the outcome: ok (persisted), cancelled (user aborted), or error
 *   (a validation or persistence failure with a user-facing message).
 */
async function askAddProvider(
  ctx: Context,
  app: TuiApp,
  signal: AbortSignal,
  prefilledRoute?: string,
): Promise<AddProviderOutcome> {
  const credentials = ctx.get('credentials')
  const settings = ctx.get('settings') as ProviderCatalogSettingsWrite | undefined
  if (credentials === undefined || settings === undefined) {
    // The settings service and the llm-pi-ai namespace must exist to persist a
    // hand-declared profile; without them the add cannot complete.
    return { kind: 'cancelled' }
  }

  const route = prefilledRoute ?? ''
  const questions = [
    ...(route === '' ? [{ id: 'route', question: 'Provider route (lowercase letters, digits and dashes; e.g. acme-gateway)' }] : []),
    { id: 'api', question: 'Wire protocol', options: PROTOCOL_CHOICES.map(choice => ({ label: choice })) },
    { id: 'baseURL', question: 'Base URL (required for a hand-declared route)' },
    { id: 'displayName', question: 'Display name (optional; defaults to the route)' },
    { id: 'key', question: 'API key (leave empty to keep provider-native authentication)' },
  ]
  const answers = await app.askQuestions(questions)
  const routeValue = (answers.find(answer => answer.id === 'route')?.custom ?? route).trim().toLowerCase()
  if (!ROUTE_PATTERN.test(routeValue)) {
    return { kind: 'error', text: `invalid provider route "${routeValue}" — lowercase letters, digits and dashes only, no leading digit` }
  }
  const api = answers.find(answer => answer.id === 'api')?.selected[0] ?? PROTOCOL_CHOICES[0]
  const baseURL = (answers.find(answer => answer.id === 'baseURL')?.custom ?? '').trim()
  if (baseURL === '') return { kind: 'error', text: 'base URL is required for a hand-declared provider route' }
  const displayName = (answers.find(answer => answer.id === 'displayName')?.custom ?? '').trim() || routeValue
  const key = (answers.find(answer => answer.id === 'key')?.custom ?? '').trim()

  // Probe the endpoint for its advertised models (pi custom-registry fetch
  // equivalent): a discovery success fills the models list; any failure is a
  // hint and falls back to hand entry.
  let discovered: readonly { id: string }[] = []
  let discoveryNote: string | undefined
  const llm = ctx.get('llm') as ProviderCatalogDiscovery | undefined
  if (llm !== undefined) {
    try {
      discovered = await llm.discoverModels('llm-pi-ai', {
        baseURL,
        api,
        ...key === '' ? {} : { apiKey: key },
        signal,
      })
      if (discovered.length > 0) {
        discoveryNote = `probed ${discovered.length} model${discovered.length > 1 ? 's' : ''}`
      }
    } catch {
      discoveryNote = 'model probe failed — enter model ids by hand'
    }
  }
  const modelAnswers = await app.askQuestions([
    {
      id: 'models',
      question: discoveryNote === undefined
        ? 'Model ids this route serves (one per line)'
        : `Models advertised by the endpoint (${discoveryNote})`,
      ...(discovered.length > 0
        ? { options: discovered.map(model => ({ label: model.id })), multiSelect: true }
        : {}),
    },
  ])
  const modelAnswer = modelAnswers.find(answer => answer.id === 'models')
  const models = modelAnswer?.selected ?? []
  const customModels = (modelAnswer?.custom ?? '')
    .split('\n').map(line => line.trim()).filter(line => line !== '')
  const allModels = [...new Set([...models, ...customModels])]
  if (allModels.length === 0) {
    return { kind: 'error', text: 'at least one model id is required for a hand-declared route' }
  }

  // Persist the profile (settings.mutate) and, when a key was entered, the
  // credential. apiKeyEnv is written ONLY when a key is stored (web Models
  // parity: a keyless route keeps provider-native auth).
  const ref = deriveKeyRef(routeValue)
  const profile: Record<string, unknown> = {
    ...displayName === routeValue ? {} : { displayName },
    api,
    baseURL,
    models: allModels.map(id => ({ id })),
    ...key === '' ? {} : { apiKeyEnv: ref },
  }
  try {
    await settings.mutate('llm-pi-ai', [
      { op: 'set', path: ['providers', routeValue], value: profile },
    ])
    if (key !== '') {
      await credentials.set(ref as CredentialRef, key)
    }
  } catch (error) {
    return { kind: 'error', text: `could not add provider: ${safeErrorMessage(error)}` }
  }
  return {
    kind: 'ok',
    text: key === ''
      ? `provider ${routeValue} added (no key; provider-native authentication)`
      : `${ref} set · provider ${routeValue} added`,
  }
}

/**
 * The initial catalog a startup hands the command surface:
 * - `snapshot` — the RESUME prefetch (commands + skills + scoped
 *   overrides, from `readSurfaceCatalog`);
 * - `skills` — the cold STANDING-SCOPE skill catalog (deferred start,
 *   skill-only, from the standing-scope adapter).
 * Both install synchronously during registration (the first-input ready
 * barrier); `snapshot` wins when both are somehow present.
 */
export interface InitialCommandCatalog {
  readonly snapshot?: SurfaceCatalogSnapshot
  readonly skills?: HumanSkillCatalog
}

/**
 * Register the TUI-owned slash commands on the commands service. The
 * completion list is refreshed after every registration so TUI-owned
 * commands appear in the editor's tab list. Registration is sessionless:
 * the commands service's global layer needs no agent, so the whole surface
 * is available before the first session exists (deferred start).
 *
 * When an `initial` catalog was prefetched (resume snapshot or cold
 * standing-scope skills), it installs SYNCHRONOUSLY at the end of
 * registration — direct skill wrappers plus the completion merge — so the
 * first input is served by the complete catalog with zero async I/O in
 * between.
 * @param runner - the live runner surface.
 * @param initial - optional prefetched catalogs installed synchronously.
 */
export function registerTuiCommands(
  runner: TuiCommandRunner,
  initial?: InitialCommandCatalog,
): {
  wasAdvertised(name: string): boolean
  /** One synchronous catalog commit (the coordinator's install hook). */
  installSnapshot(snapshot: SurfaceCatalogSnapshot): void
  /** The revalidating transition (the coordinator's target-change hook). */
  enterTransition(): void
} {
  const { ctx, app } = runner
  const cwd = runner.cwd
  const signal = runner.signal
  // `@`-file mentions use fd when it is on PATH (whole-tree fuzzy search);
  // without it the MentionProvider falls back to a bounded recursive scan.
  const fdPath = resolveFdPath()
  const commands = ctx.get('commands')
  // The commands service is part of the base layer; its absence means the
  // TUI commands cannot be registered at all — the caller surfaces this.
  if (commands === undefined) throw new Error('commands service unavailable')

  // Fire-and-forget with the runner's diag: cancellations debug-only,
  // recoverable (persistence) failures notify + warn, everything else
  // warns — never a bare `void somePromise()` (AGENTS.md hard rule). The
  // task is a FACTORY (runDetached runs it), so a synchronous throw from
  // the service call is classified like a rejection, not an escape.
  const detach = (label: string, task: () => unknown | Promise<unknown>, options: { notify?: boolean } = {}): void => {
    runDetached(label, task, {
      diag: runner.diag,
      // Diagnostics name the live session at settle time, never the payload.
      sessionId: () => runner.liveAgent?.session.id,
      notify: options.notify === true ? (message) => app.notify(message, 'error') : undefined,
      recoverable: options.notify === true ? () => true : undefined,
    })
  }
  /** Switch sessions with full rejection handling (the runner resolves an
   * error STRING for user-facing failures, but an unexpected rejection must
   * not become an unhandled rejection either). An owned workflow: the
   * outcome drives the notify — runOwned (AGENTS.md); the classification
   * diagnostics are recorded by runOwned itself. */
  const switchSession = (id: string): void => {
    runOwned('session switch', () => runner.switchSession(id), {
      diag: runner.diag,
      sessionId: () => id,
      onResult: (error) => {
        if (error !== undefined) app.notify(error, 'error')
      },
      onError: (error: unknown) => {
        const message = safeErrorMessage(error)
        app.notify(`session switch failed: ${message}`, 'error')
      },
    })
  }

  /**
   * Resolve the live agent for a session-backed command, creating the first
   * session lazily when the deferred start has not run yet. Throws when the
   * creation failed — the executor surfaces the error to the user.
   */
  const requireAgent = async (): Promise<Agent> => {
    await runner.ensureSession()
    const agent = runner.liveAgent
    if (agent === undefined) throw new Error('session could not be created')
    return agent
  }

  // ── completion surface + advertised command claims ─────────────────────
  // The completion list doubles as the ADVERTISED set: every name shown to
  // the user is a claim that submitting `/name` will resolve to a real
  // command. The dispatch captures the claim BEFORE any session creation
  // (wasAdvertised below); a probed command that the real session then
  // lacks must be consumed with an explicit error, never sent to the model.
  /** The advertised names of the currently installed completion list. */
  let claims = new Set<string>()
  /**
   * Install one completion list (sorted, claims refreshed). The single
   * synchronous seam every catalog commit funnels through.
   */
  const installCompletions = (entries: readonly SurfaceCommandSummary[]): void => {
    const sorted = [...entries].sort((left, right) => left.name < right.name ? -1 : 1)
    app.setCommandCompletions(
      sorted.map(command => ({
        name: command.name,
        description: command.description,
        argumentHint: command.input?.hint,
      })),
      runner.sessionCwd(),
      fdPath,
    )
    claims = new Set(sorted.map(command => command.name))
  }
  /** The saved probed scoped overrides (see installSurfaceSnapshot). */
  let savedScopedCommands: readonly SurfaceCommandSummary[] = []
  /**
   * The sessionless completion view: the CURRENT global layer (fresh read —
   * TUI built-ins, global plugins and installed skill wrappers all flow in)
   * overlaid with the saved scoped overrides from the latest snapshot.
   */
  const mergeGlobalAndSavedScoped = (): readonly SurfaceCommandSummary[] => {
    const byName = new Map<string, SurfaceCommandSummary>()
    for (const descriptor of listGlobalCommands(commands)) {
      byName.set(descriptor.name, commandSummaryOf(descriptor))
    }
    for (const scoped of savedScopedCommands) byName.set(scoped.name, scoped)
    return [...byName.values()]
  }
  /**
   * Refresh completions from the registry: the LIVE agent's effective view
   * when one exists (global + its scoped shadows), else the global layer
   * overlaid with the saved scoped overrides (sessionless merge). The agent
   * may be undefined before the first session exists: in-process
   * `commands.list(undefined)` safely returns the global layer only (the
   * remote RPC path's lookup guard does not apply in-process).
   */
  const refreshCompletions = (): void => {
    const liveAgent = runner.liveAgent
    installCompletions(liveAgent === undefined
      ? mergeGlobalAndSavedScoped()
      : commands.list(liveAgent).map(commandSummaryOf))
  }
  // ── registry-change coalescing ─────────────────────────────────────────
  // `commands.register/dispose` fire `commands/change` SYNCHRONOUSLY per
  // command; a bulk commit (the skill wrappers, the transitions) would
  // otherwise repaint the completions once per wrapper. The commit depth
  // wraps a whole bulk phase: listeners only mark dirty, and the outermost
  // commit recomputes ONCE.
  let commandCommitDepth = 0
  let commandCommitDirty = false
  /** Run one bulk command commit; registry changes inside are coalesced. */
  const withCommandCommit = (phase: () => void): void => {
    commandCommitDepth += 1
    try {
      phase()
    } finally {
      commandCommitDepth -= 1
      if (commandCommitDepth === 0 && commandCommitDirty) {
        commandCommitDirty = false
        refreshCompletions()
      }
    }
  }
  // The commands/change listener is registered at the END of registration
  // (see below): the TUI's built-in registrations need no coalescing, and
  // the snapshot/wrapper bulk commits use withCommandCommit instead.
  refreshCompletions()

  // Shared by /exit and its /quit alias. The exit orchestration lives in
  // the runner (createExitController): flush with a hard timeout, idempotent
  // cleanup, warning, resume hint, process exit. Handlers never stop the app
  // or flush themselves — that kept /exit diverging from Ctrl+C/Ctrl+D (no
  // timeout, no catch, no warning) and could hang a stopped UI forever.
  const exitHandler = (): { kind: 'success' } => {
    runner.requestExit()
    return { kind: 'success' }
  }

  commands.register({
    name: 'exit',
    description: 'Quit the terminal UI (flush and exit)',
    handler: exitHandler,
  })

  commands.register({
    name: 'quit',
    description: 'Quit the terminal UI (flush and exit) — alias of /exit',
    handler: exitHandler,
  })

  commands.register({
    name: 'settings',
    description: 'Open the TUI settings panel',
    handler: () => {
      const liveAgent = runner.liveAgent
      const tuiSettings = runner.tuiSettings
      const theme = tuiSettings?.get().theme ?? 'auto'
      const themeValue = theme.startsWith('custom:') ? theme.slice('custom:'.length) : theme
      // The autodetect guard reads THIS synchronous "latest choice", never
      // the persisted doc: the settings write is asynchronous, so at the
      // moment an OSC 11 reply lands the doc may still hold the PREVIOUS
      // theme — a doc-based guard would wrongly refuse a just-selected
      // `auto` (and wrongly apply over a just-selected explicit theme).
      let lastThemeChoice = themeValue
      // The permission-presets service owns the composed preset table and the
      // persisted default for new sessions (settings namespace 'permission').
      // Both panel rows degrade gracefully when the service is absent.
      const settings = ctx.get('settings')
      const permission = ctx.get('permissionPresets')
      const permissionNames: string[] = [...(permission?.names ?? [])]
      let defaultPermission: string | undefined
      if (settings !== undefined) {
        try {
          const doc = settings.get(settingsNamespace('permission')) as { defaultPreset?: string } | undefined
          defaultPermission = doc?.defaultPreset
        } catch {
          // The namespace is absent until the presets service registers it.
        }
      }
      // Before the first session (deferred start) the session-scoped rows —
      // approval policy and the read-only session facts — do not exist yet;
      // everything process-wide stays available.
      app.openSettings(
        [
          ...liveAgent === undefined ? [] : [{
            id: 'approval',
            label: 'Approval policy (this session)',
            description: 'How tool approvals are handled in this session',
            currentValue: effectiveApprovalPolicy(liveAgent.session.events) ?? 'ask',
            values: ['ask', 'never'],
          }],
          ...permissionNames.length > 0 ? [{
            id: 'default-permission',
            label: 'Default permission',
            description: 'Preset new sessions start with (persisted; Shift+Tab cycles this session)',
            currentValue: defaultPermission ?? permissionNames[0] ?? '',
            values: permissionNames,
          }] : [],
          {
            id: 'theme',
            label: 'Theme',
            description: 'Palette: auto follows the terminal; custom from ~/.dsh-pi-tui/themes',
            currentValue: themeValue,
            values: ['auto', 'dark', 'light', ...customThemeNames()],
          },
          {
            id: 'expand',
            label: 'Tool output',
            description: 'Whether thinking/tool entries start expanded',
            currentValue: app.isToolOutputExpanded() ? 'expanded' : 'collapsed',
            values: ['collapsed', 'expanded'],
          },
          {
            id: 'thinking',
            label: 'Thinking blocks',
            description: 'Whether reasoning entries render at all',
            currentValue: app.isThinkingHidden() ? 'hidden' : 'shown',
            values: ['shown', 'hidden'],
          },
          {
            id: 'footer',
            label: 'Status line',
            description: 'Footer density: full keeps the stats line',
            currentValue: app.getFooterPreset(),
            values: ['full', 'compact'],
          },
          {
            id: 'busy-enter',
            label: 'Enter while busy',
            description: 'Steer injects the draft into the running turn; Ctrl+Enter uses the other behavior',
            currentValue: tuiSettings?.get().busyEnter ?? 'queue',
            values: ['queue', 'steer'],
          },
          {
            id: 'fullscreen',
            label: 'Fullscreen',
            description: 'Alt-screen mode: on keeps the terminal clean (default); off keeps the scrollback',
            currentValue: app.isFullscreen() ? 'on' : 'off',
            values: ['off', 'on'],
          },
          // ── read-only session facts ─────────────────────────────
          {
            id: 'separator',
            label: color.border('─'.repeat(34)),
            currentValue: '',
          },
          ...liveAgent === undefined ? [] : [
            {
              id: 'session',
              label: color.textDim('Session'),
              description: color.textDim(liveAgent.session.id),
              currentValue: color.textDim(displaySessionId(liveAgent.session.id)),
            },
            {
              id: 'model',
              label: color.textDim('Model'),
              description: color.textDim('Provider and model routing this session'),
              currentValue: color.textDim(`${liveAgent.options.provider}/${liveAgent.options.model}`),
            },
            {
              id: 'preset',
              label: color.textDim('Agent preset'),
              description: color.textDim('Composition this session runs on (see /preset)'),
              currentValue: color.textDim(runner.currentPreset() ?? 'none'),
            },
          ],
          {
            id: 'cwd',
            label: color.textDim('Working directory'),
            description: color.textDim('The live session workspace (follows session switches)'),
            currentValue: color.textDim(runner.sessionCwd()),
          },
        ],
        (id, value) => {
          if (id === 'approval') {
            if ((value === 'ask' || value === 'never') && liveAgent !== undefined) {
              ctx.get('approval')?.setPolicy(liveAgent, value)
              // The footer's permission badge derives from the knob folds;
              // reflect the change immediately.
              runner.refreshStatus()
            }
          } else if (id === 'default-permission') {
            const settings = ctx.get('settings')
            if (settings !== undefined && permissionNames.includes(value)) {
              detach('permission default write', () => settings.mutate(settingsNamespace('permission'), [{ op: 'set', path: ['defaultPreset'], value }]) as Promise<unknown>, { notify: true })
            }
          } else if (id === 'theme') {
            if (value === 'auto' || value === 'dark' || value === 'light' || customThemeNames().includes(value)) {
              lastThemeChoice = value
              if (value === 'auto') {
                // The settled detection applies only while the preference is
                // STILL auto — a late result must never override a theme the
                // user picked while the query was in flight (rapid cycling).
                // The guard reads the synchronous lastThemeChoice, NOT the
                // persisted doc (whose write is asynchronous and may lag the
                // query settlement by hundreds of ms).
                detach('theme autodetect', () => app.autoDetectTheme({
                  shouldApply: () => lastThemeChoice === 'auto',
                }))
                app.trackTerminalTheme(true)
              } else if (value === 'dark' || value === 'light') {
                app.applyTheme(value)
                app.trackTerminalTheme(false)
              } else {
                const palette = loadCustomTheme(value)
                if (palette !== undefined) {
                  app.applyPalette(palette)
                  app.trackTerminalTheme(false)
                } else {
                  app.notify(`theme ${value} not found`, 'error')
                  return
                }
              }
              // Spread the current doc: a replace is wholesale, so the
              // other preference keys must ride along.
              const settings = tuiSettings
              if (settings !== undefined) {
                detach('settings theme write', () => settings.replace({ ...settings.get(), theme: value === 'auto' || value === 'dark' || value === 'light' ? value : `custom:${value}` }) as Promise<unknown>, { notify: true })
              }
            }
          } else if (id === 'expand') {
            app.setToolOutputExpanded(value === 'expanded')
          } else if (id === 'thinking') {
            if ((value === 'shown') === app.isThinkingHidden()) app.toggleThinkingHidden()
          } else if (id === 'footer') {
            if (value === 'full' || value === 'compact') {
              app.setFooterPreset(value)
              const settings = tuiSettings
              if (settings !== undefined) {
                detach('settings footer write', () => settings.replace({ ...settings.get(), footer: value }) as Promise<unknown>, { notify: true })
              }
            }
          } else if (id === 'busy-enter') {
            if (value === 'queue' || value === 'steer') {
              const settings = tuiSettings
              if (settings !== undefined) {
                detach('settings busy enter write', () => settings.replace({ ...settings.get(), busyEnter: value }) as Promise<unknown>, { notify: true })
              }
            }
          } else if (id === 'fullscreen') {
            if (value === 'off' || value === 'on') {
              app.setFullscreen(value === 'on')
              // setFullscreen reports through onFullscreenChange, which
              // persists the same field (this branch is the panel write).
            }
          }
        },
        () => {},
      )
      return { kind: 'success' }
    },
  })

  // Shared /sessions + /resume body: list persisted sessions newest-first,
  // open the picker, and enrich rows with titles in the background. The
  // header parameter lets the resume alias present itself under its own name.
  const openSessionPicker = async (invocation: { rawInput: string }, header: string): Promise<{ kind: 'success' } | { kind: 'error'; text: string }> => {
    // The current marker is the live session's id; before the first session
    // (deferred start) no row is marked current, and the picker can still
    // browse and switch to a persisted session without creating one.
    const currentId = runner.liveAgent?.session.id
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return { kind: 'error', text: 'session persistence unavailable' }
    // Live-preferred listing (sessionQuery) marks sessions currently
    // loaded in the store; the persistence fallback is the plain list.
    // The engine is read structurally off the context (no package
    // import): `dsh-base` mounts it in every profile.
    const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
    let rows: SessionPickerRow[]
    if (query !== undefined) {
      rows = (await query.listSessions()).map(record => headerToPickerRow(record.header, record.live))
    } else {
      rows = (await persistence.list()).map(header =>
        headerToPickerRow(header, header.id === currentId))
    }
    rows.sort((a, b) => b.createdAt - a.createdAt)
    if (rows.length === 0) return { kind: 'error', text: 'no persisted sessions' }
    // The picker opens instantly on the headers; titles land in the
    // background below. The cap keeps the title read bounded.
    const shown = rows.slice(0, MAX_PICKER_SESSIONS)
    const picker = app.openPicker(
      shown.map(row => sessionPickerItem(row, currentId ?? '')),
      (id) => {
        if (id === currentId) return
        switchSession(id)
      },
      () => {},
      {
        enableSearch: true,
        header,
        noMatchText: '  no matching sessions',
        initialQuery: invocation.rawInput.trim(),
        width: 76,
        maxHeight: 26,
        showHint: true,
      },
    )
    // Enrich rows with titles as they load; the active search query is
    // re-applied by the picker, and the current marker is re-read so a
    // session switch mid-load does not mislabel. Cancellations (TUI quit,
    // the abort signal) are debug-level through the unified entry; a real
    // batch failure lands in diagnostics instead of being swallowed.
    detach('session titles', () => loadSessionTitles(query, persistence, shown.map(row => row.id), signal)
      .then(titles => {
        if (titles.size === 0) return
        picker.setItems(shown.map(row => sessionPickerItem({ ...row, title: titles.get(row.id) }, runner.liveAgent?.session.id ?? '')))
      }))
    return { kind: 'success' }
  }

  commands.register({
    name: 'sessions',
    description: 'List, search, and switch persisted sessions',
    input: { hint: '[query]' },
    handler: (invocation) => openSessionPicker(invocation, 'sessions'),
  })

  commands.register({
    name: 'resume',
    description: 'Resume a session by id or pick from the list (alias of /sessions)',
    input: { hint: '[id|query]' },
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim()
      if (raw !== '') {
        // Direct resume: exact id, a session- prefixed prefix, or the short
        // id prefix. Falls back to the picker when nothing matches.
        const currentId = runner.liveAgent?.session.id
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined) {
          const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
          let rows: SessionPickerRow[]
          if (query !== undefined) {
            rows = (await query.listSessions()).map(record => headerToPickerRow(record.header, record.live))
          } else {
            rows = (await persistence.list()).map(header =>
              headerToPickerRow(header, header.id === currentId))
          }
          rows.sort((a, b) => b.createdAt - a.createdAt)
          const match = findSessionMatch(rows, raw)
          if (match !== undefined) {
            if (match.id === currentId) return { kind: 'error', text: 'already on this session' }
            switchSession(match.id)
            return { kind: 'success' }
          }
        }
      }
      return openSessionPicker(invocation, 'resume')
    },
  })

  /** The workspace the live session runs in; fallback to the TUI's cwd. */
  const sessionCwd = (agent: Agent): string => agent.session.header.cwd ?? cwd

  // The skills registry the live agent actually sees — resolved through the
  // single-point adapter (plan appendix B.1): its preset's scoped instance
  // when the preset mounts one (the web surface's serviceFor path), else the
  // host registry. The scope passed to lookups is the AGENT itself, exactly
  // like the host apiproxy's presenterScopeFor — an agent context object
  // does not identity-match the preset's standing mount.
  const skillTarget = (agent: Agent): SkillCatalogTarget | undefined =>
    resolveLiveSkillTarget(ctx as unknown as SkillCatalogContext, agent, sessionCwd(agent))

  /**
   * Split a skill invocation's trailing input into the skill name and its
   * arguments: the first whitespace-bounded token is the name (the public
   * skill-name grammar), everything after it the arguments. Used by the
   * per-skill wrappers and `/skill`, so `/name args` never looks up a name
   * containing the whole rest of the line.
   * @param raw - the invocation's rawInput ('' for a bare command).
   * @returns the name token ('' when the input is blank) plus the args.
   */
  const splitSkillLine = (raw: string): [string, ...string[]] => {
    const trimmed = raw.trimStart()
    const space = trimmed.search(/\s/)
    if (space === -1) return [trimmed.trim(), ...[]]
    return [trimmed.slice(0, space).trim(), trimmed.slice(space).trimStart()]
  }

  /**
   * Structurally validate a skill's optional resource base, so a malformed
   * provider-supplied value degrades to no hint instead of throwing inside
   * the fallback rendering (the adapter's conservative rule — hostile
   * entries are refused, never coerced or thrown on).
   * @param value - the loaded skill's `resourceBase` (opaque from the adapter).
   * @returns the validated resource base, or undefined when unreadable.
   */
  const readResourceBase = (value: unknown): { kind: 'directory'; path: string } | { kind: 'url'; url: string } | { kind: 'opaque'; description: string } | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    switch (record.kind) {
      case 'directory':
        return typeof record.path === 'string' && record.path !== '' ? { kind: 'directory', path: record.path } : undefined
      case 'url':
        return typeof record.url === 'string' && record.url !== '' ? { kind: 'url', url: record.url } : undefined
      case 'opaque':
        return typeof record.description === 'string' && record.description !== '' ? { kind: 'opaque', description: record.description } : undefined
      default:
        return undefined
    }
  }

  /**
   * The execution boundary for loading one skill into the live session;
   * shared by /skill and the per-skill slash commands. The skill is fetched
   * from the CURRENT agent's registry and its invocation policy is RE-CHECKED
   * here — a summary that passed the cold/live filter is never execution
   * authorization. A model-only skill is refused with an explicit error and
   * never injected.
   */
  const loadSkill = async (agent: Agent, name: string, args = ''): Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }> => {
    const target = skillTarget(agent)
    if (target === undefined) return { kind: 'error', text: 'skill service unavailable' }
    const skill = await target.registry.get?.(name, { cwd: target.cwd, scope: target.scope })
    if (skill === undefined) return { kind: 'error', text: 'unknown skill "' + name + '"' }
    if (!isUserInvocableSkill(skill)) return { kind: 'error', text: `skill "${name}" is not invocable by the user` }
    // Hostile-field guard on the LOADED definition too: only string display
    // fields may cross into the injected body (the adapter's conservative
    // rule — malformed entries are refused, never coerced or thrown on).
    if (typeof skill.name !== 'string' || skill.name === '' || typeof skill.description !== 'string') {
      return { kind: 'error', text: `skill "${name}" returned a malformed definition` }
    }
    // Web parity (the dsh-tool-skill pre-step boundary): a user-explicit
    // skill invocation is a PLAIN user message whose leading `/name` line
    // the host recognizes — the user's own words (including any `/name args`
    // the wrapper was invoked with) always travel as the original text, and
    // the rendered skill body follows as injected instructions context.
    // Arguments are never carved out and never dropped: the bug this fixes
    // was the wrapper discarding `rawInput` and injecting a hand-rolled body
    // card that swallowed the user's request.
    const line = args.trim() === '' ? '/' + skill.name : '/' + skill.name + ' ' + args.trimStart()
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: line }],
      source: { kind: 'user' },
    })
    // The host's pre-step listener (dsh-tool-skill) injects the rendered
    // body only when ITS tool registration is visible to this agent — the
    // same visibility test the listener itself uses. A composition without
    // the loader (e.g. a stripped-down custom preset) never recognizes the
    // gesture, so the TUI falls back to injecting the body itself with the
    // OFFICIAL rendering and the OFFICIAL durable source, so transcript
    // consumers present it exactly like a host injection (context.ts already
    // projects skill-invocation rows). With the host present, the body is
    // left to it: double injection would duplicate the skill body.
    // The check is an existence probe shaped like the loader: the tool must
    // be named `skill` and carry an execute function (the dsh-tool-skill
    // definition always does). A scoped shadow merely named `skill` without
    // a loader shape is treated as absent — the host's gesture listener
    // would not inject for it either, so the TUI's fallback must cover it.
    const tools = ctx.get('tools') as { get?(name: string, agent: Agent): { execute?: unknown; parameters?: unknown } | undefined } | undefined
    const hostSkillLoader = tools?.get?.('skill', agent)
    const hostLoadsSkillBody = hostSkillLoader !== undefined && typeof hostSkillLoader.execute === 'function'
    // Deliver the batch like the /queue steer action (and unlike
    // agent.inject alone, which queues for the next pre-step WITHOUT waking
    // the driver): the ORIGINAL line is steered — a running turn takes it
    // at the next step boundary, an idle agent's steer wakes the driver and
    // opens the next turn with it (web parity, where the `/name` prompt is
    // a plain session.prompt). The fallback body injection rides the SAME
    // next-step batch via inject (no wake): a RUNNING agent's next step
    // claim takes all next-step messages at once in insertion order, so the
    // original line precedes the body in one step; an IDLE agent's steer
    // wake claims the original line synchronously inside steer(), so the
    // body lands as step 2 of the same turn (the loop only ends when
    // next-step drains). Either way the original line reaches the model
    // before the body, exactly like the web's message order.
    // Never follow-up the original line here: followup parks the line in
    // next-turn while the body sits in next-step, and the driver's first
    // step boundary claims next-step FIRST — the body would arrive BEFORE
    // the user's words, inverting the web's message order. (A second
    // follow-up would not help either: a turn boundary claims ONE next-turn
    // message, so the pair would split across two turns.)
    agent.steer(userMessage)
    if (!hostLoadsSkillBody) {
      const body = typeof skill.content === 'string' && skill.content !== '' ? skill.content : skill.description
      // Forward the resource base too, so the fallback rendering matches
      // what the host would render (directory/url/opaque hints).
      const resourceBase = readResourceBase(skill.resourceBase)
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: renderSkillContent({
          name: skill.name,
          provider: typeof skill.provider === 'string' && skill.provider !== '' ? skill.provider : 'tui',
          ...resourceBase === undefined ? {} : { resourceBase },
          content: body,
        }) }],
        source: { kind: 'skill-invocation', name: skill.name, form: 'instructions' },
      }))
    }
    return { kind: 'success', text: 'skill ' + name + ' loaded' }
  }

  // Per-skill slash commands (/glab, /find-skills, ...), pi-style: each
  // human-invocable catalog skill is directly selectable from the editor
  // autocomplete and delivers its loaded body on Enter (through loadSkill,
  // which steers the original line and injects the body alongside it). The
  // description carries a [skill] tag so skill rows stand apart from
  // built-in commands.
  const skillDisposers = new Map<string, () => void>()
  /**
   * Synchronously replace every direct skill wrapper from a snapshot. Pure
   * install: no catalog fetch, no await — the callers (the initial snapshot
   * commit, the live refresh, the coordinator) provide the data. The target
   * set is computed FIRST (current global/effective view minus the wrappers
   * this surface owns, plus the snapshot's scoped overrides), then the old
   * wrappers are disposed and the new ones registered in one synchronous
   * commit.
   * @param skills - the human-invocable summaries to install.
   * @param scopedNames - the snapshot's scoped command names: a preset-scoped
   *   command must block a same-name wrapper even though the global view
   *   cannot see it yet (sessionless install).
   * @returns the number of wrappers installed.
   */
  const replaceSkillCommands = (skills: readonly HumanSkillSummary[], scopedNames: ReadonlySet<string>): number => {
    // Own wrapper names are excluded from the collision baseline: they are
    // about to be replaced, not external collisions.
    const owned = new Set(skillDisposers.keys())
    const taken = new Set<string>()
    const view = commands.list(runner.liveAgent as unknown as Agent)
    for (const command of view) if (!owned.has(command.name)) taken.add(command.name)
    for (const name of scopedNames) taken.add(name)
    for (const dispose of skillDisposers.values()) dispose()
    skillDisposers.clear()
    let count = 0
    for (const skill of skills) {
      // A colliding name (a built-in, a scoped command or another plugin's
      // command) skips the slash command; the catalog picker still lists it.
      if (taken.has(skill.name)) continue
      try {
        const dispose = commands.register({
          name: skill.name,
          description: '[skill] ' + skill.description,
          // The handler captures ONLY the skill name; execution re-fetches
          // from the current live agent and re-checks the policy. Trailing
          // input (`/name args`) travels VERBATIM as the invocation's
          // arguments (web parity: the user's words stay on the original
          // line, never carved out or dropped — the wrapper's own name is
          // the skill name, everything after it is args).
          handler: async (invocation) => {
            const agent = await requireAgent()
            return loadSkill(agent, skill.name, invocation?.rawInput ?? '')
          },
        })
        skillDisposers.set(skill.name, dispose)
        count += 1
      } catch {
        // Registration raced with another plugin; the picker still works.
      }
    }
    return count
  }
  /**
   * Install one whole snapshot on the surface in ONE synchronous commit:
   * replace the direct skill wrappers, save the scoped overrides, and merge
   * the completions (fresh global view + saved overrides). No await between
   * the pieces, so a first input can never observe a half-installed catalog.
   * A FAILED skills provider keeps the current wrappers (transitions or the
   * previous catalog): they re-validate against the current agent at
   * execution time, so a submitted skill name can never fall through to a
   * plain model message while the catalog is unavailable.
   */
  const installSurfaceSnapshot = (snapshot: SurfaceCatalogSnapshot): void => {
    const scopedNames = new Set(snapshot.scopedCommands.map(command => command.name))
    const skillsFailed = snapshot.issues.some(issue => issue.provider === 'skills')
    withCommandCommit(() => {
      if (!skillsFailed) replaceSkillCommands(snapshot.skills, scopedNames)
      savedScopedCommands = snapshot.scopedCommands
      installCompletions(mergeGlobalAndSavedScoped())
    })
  }
  /**
   * The revalidating transition (target/owner change): scoped previews clear
   * so new inputs complete against the current global view only, and every
   * old skill wrapper becomes a revalidating transition command whose
   * handler re-fetches from the CURRENT live agent and re-checks the policy
   * at execution time. The names survive so an already-submitted skill
   * command can never become a plain model message mid-switch.
   */
  const enterCatalogTransition = (): void => {
    const names = [...skillDisposers.keys()]
    withCommandCommit(() => {
      for (const dispose of skillDisposers.values()) dispose()
      skillDisposers.clear()
      savedScopedCommands = []
      for (const name of names) {
        try {
          const dispose = commands.register({
            name,
            description: `[skill: revalidating] ${name}`,
            handler: async (invocation) => {
              const agent = await requireAgent()
              return loadSkill(agent, name, invocation?.rawInput ?? '')
            },
          })
          skillDisposers.set(name, dispose)
        } catch {
          // Registration raced with another plugin; the picker still works.
        }
      }
      installCompletions(mergeGlobalAndSavedScoped())
    })
  }
  /** Whether one command name is advertised by the CURRENT completion list
   * (the claim captured at submit time, before any session creation). */
  const wasAdvertised = (name: string): boolean => claims.has(name)

  commands.register({
    name: 'skill',
    description: 'Load a skill into the session context',
    input: { hint: '<name>' },
    handler: async (invocation) => {
      const liveAgent = await requireAgent()
      const target = skillTarget(liveAgent)
      if (target === undefined) return { kind: 'error', text: 'skill service unavailable' }
      // `/skill <name> [args...]`: the first whitespace token is the skill
      // name, the remainder its arguments (forwarded verbatim on the
      // original line, web parity — never carved out or dropped). The
      // invocation line is normalized to `/name args` so the host's pre-step
      // gesture (dsh-tool-skill) also recognizes it when visible.
      const [name, ...args] = splitSkillLine(invocation.rawInput)
      if (name !== '') return loadSkill(liveAgent, name, args.join(' '))
      // No argument: pick from the catalog — the same validated, policy-
      // filtered, sorted view the collector builds (readHumanSkillCatalog),
      // so hostile or model-only entries never reach the picker.
      const catalog = await readHumanSkillCatalog(target.registry, { cwd: target.cwd, scope: target.scope })
      if (catalog.skills.length === 0) return { kind: 'error', text: 'no skills available' }
      // SettingsList rows: Enter cycles the value, which fires onChange.
      app.openSettings(
        catalog.skills.map(skill => ({
          id: skill.name,
          label: skill.name,
          description: skill.description,
          currentValue: '',
          values: ['✓'],
        })),
        (id) => {
          detach('skill load', () => loadSkill(liveAgent, id).then(result => {
            if (result.kind === 'error') app.notify(result.text)
          }), { notify: true })
        },
        () => {},
      )
      return { kind: 'success' }
    },
  })



  commands.register({
    name: 'reload',
    description: 'Reload TUI settings and refresh the live command/skill catalog',
    handler: async () => {
      // 1. Refresh the surface catalog through the coordinator: a LIVE agent
      // refreshes its authoritative surface; the sessionless state refreshes
      // the STANDING skill catalog of the effective preset (no Agent, no
      // session — the standing scope replaces the composition probe, which
      // emits durable events in this deployment, see docs/surface-catalog.md).
      // The handler awaits the attempt and reports the outcome (counts,
      // degradation notice, partial issues, supersession); provider or
      // composition failures never prevent the settings portion below.
      let catalogText = ''
      const liveAgent = runner.liveAgent
      if (liveAgent !== undefined) {
        const outcome = await runner.refreshCatalog({
          source: 'reload',
          target: { kind: 'agent', key: runner.sessionGeneration },
          agent: liveAgent,
        })
        if (outcome.kind === 'applied') {
          catalogText = `${outcome.snapshot.commands.length} commands \u00b7 ${outcome.snapshot.skills.length} skills`
          if (outcome.snapshot.issues.length > 0) {
            catalogText += ` \u00b7 partial: ${outcome.snapshot.issues.map(issue => issue.provider).join(', ')} unavailable`
          }
        } else if (outcome.kind === 'failed') {
          catalogText = `catalog refresh failed: ${outcome.error}`
        } else {
          catalogText = 'catalog refresh superseded'
        }
      } else {
        const outcome = await runner.refreshCatalog({
          source: 'reload',
          target: { kind: 'preset', presetId: runner.effectivePresetId },
        })
        if (outcome.kind === 'applied') {
          catalogText = `${outcome.snapshot.skills.length} human skills`
          if (outcome.notice !== undefined) catalogText += ` \u00b7 ${outcome.notice}`
        } else if (outcome.kind === 'failed') {
          catalogText = `catalog refresh failed: ${outcome.error}`
        } else {
          catalogText = 'catalog refresh superseded'
        }
      }
      // 2. Re-apply the persisted TUI settings (theme, footer, fullscreen),
      // the same policy the runner applies at boot.
      const settings = runner.tuiSettings
      if (settings !== undefined) {
        const doc = settings.get()
        // The autodetect guard reads this synchronous snapshot of the
        // reload-time theme, never a re-read of the doc: a settings write
        // from the panel may still be in flight when the reply lands.
        const reloadTheme = doc.theme
        if (reloadTheme === 'auto') {
          detach('theme autodetect', () => app.autoDetectTheme({
            shouldApply: () => reloadTheme === 'auto',
          }))
          app.trackTerminalTheme(true)
        } else if (reloadTheme === 'dark' || reloadTheme === 'light') {
          app.applyTheme(reloadTheme)
          app.trackTerminalTheme(false)
        } else if (reloadTheme.startsWith('custom:')) {
          const palette = loadCustomTheme(reloadTheme.slice('custom:'.length))
          if (palette !== undefined) app.applyPalette(palette)
          app.trackTerminalTheme(false)
        }
        app.setFooterPreset(doc.footer === 'compact' ? 'compact' : 'full')
        app.setFullscreen(doc.fullscreen === 'on')
      }
      app.notify(`reloaded — ${catalogText} \u00b7 settings reapplied`, 'info')
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'model',
    description: 'Switch the model (and reasoning effort) for this session',
    handler: async () => {
      const selected = runner.selected
      const llm = ctx.get('llm')
      const defaultModel = ctx.get('agentDefaultModel')
      if (llm === undefined || defaultModel === undefined) return { kind: 'error', text: 'model service unavailable' }
      const providers = llm.listProviders()
      const current = defaultModel.currentSelection()
      /** Commit a selection (model, optional effort) and refresh the footer. */
      const apply = (next: ModelSelection): void => {
        // Persist and reflect with LATEST-WINS semantics: saves run
        // concurrently, so a failure must only roll back when the current
        // selection is still the one THIS save was for — an older failed
        // save must never overwrite a newer successful selection (out-of-
        // order completion must not regress the persistent state either;
        // the UI at least never lies about what is current).
        const previous = selected.current
        runDetached('model selection save', () => defaultModel.saveSelection(next), {
          diag: runner.diag,
          notify: (message) => {
            if (selected.current === next) {
              selected.current = previous
              runner.refreshStatus()
            }
            app.notify(message, 'error')
          },
          recoverable: () => true,
        })
        selected.current = next
        runner.refreshStatus()
      }
      // The model and effort levels render INSIDE the provider list's
      // submenu slot (ModelSubmenu/EffortSubmenu): selecting applies
      // immediately and Esc walks back one level. A nested openSettings
      // would mount a second overlay and leave the first one hanging
      // (the ghost-overlay trap the /subagents flow documents).
      app.openSettings(
        providers.map(provider => ({
          id: provider.id,
          label: provider.name,
          currentValue: current.provider === provider.id ? current.model : '',
          submenu: (value, done) => new ModelSubmenu(provider.id, current.model, selected.current?.reasoningEffort, {
            listModels: (id) => llm.listModels(id),
            resolveModelInfo: (id, modelId) => llm.resolveModelInfo(id, modelId),
            apply,
            requestRender: () => app.requestRender(),
            done,
            // The owned-task entry for the menu loads: runOwned with the
            // runner's diag pre-attached (AGENTS.md — never a bare void).
            runOwned: <T>(label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => {
              runOwned(label, task, { ...options, diag: runner.diag, sessionId: () => runner.liveAgent?.session.id })
            },
          }),
        })),
        () => {},
        () => {},
      )
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'new',
    description: 'Start a fresh session in this workspace',
    handler: async () => {
      const liveAgent = runner.liveAgent
      const composition = await runner.compose(runner.pendingPreset)
      const presetId = composition.agentPreset
      const next = await runner.agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: metaOf(cwd, presetId),
        // Before the first session the process-wide selection stands in.
        agentOptions: {
          provider: liveAgent?.options.provider ?? runner.selected.current?.provider,
          model: liveAgent?.options.model ?? runner.selected.current?.model,
        },
        setup: composition.setup,
      })
      const error = await runner.swapTo(next)
      if (error !== undefined) app.notify(error, 'error')
      return { kind: 'success', text: 'started a fresh session' }
    },
  })

  commands.register({
    name: 'queue',
    description: 'Manage queued input: edit, delete, steer, or insert',
    handler: async () => {
      const liveAgent = await requireAgent()
      const inbox = liveAgent.inbox
      // Each row remembers which pending list it lives in, so "Insert
      // before" can splice at the exact spot instead of prepending to the
      // head of the queue.
      const queued = [
        ...inbox.nextTurn.map((message, index) => ({ message, slot: `next ${index + 1}`, list: 'next-turn' as const })),
        ...inbox.nextStep.map((message, index) => ({ message, slot: `steer ${index + 1}`, list: 'next-step' as const })),
      ]
      if (queued.length === 0) return { kind: 'success', text: 'no queued input' }
      // The pane covers the fine-grained verbs; the queue strip above the
      // editor handles the at-a-glance view and Alt+↑ pulls everything back.
      app.openSettings(
        queued.map(({ message, slot }) => ({
          id: message.id,
          label: `[${slot}] ${textOf(message.content).replace(/\s+/g, ' ').trim().slice(0, 40)}`,
          description: message.id,
          currentValue: '',
          submenu: (value, done) => new SettingsList(
            [
              { id: 'edit', label: 'Edit', description: 'Rewrite this queued message', currentValue: '', values: ['✓'] },
              { id: 'delete', label: 'Delete', description: 'Remove it from the queue', currentValue: '', values: ['✓'] },
              { id: 'steer', label: 'Steer', description: 'Send it now: into the running turn, or start one when idle', currentValue: '', values: ['✓'] },
              { id: 'insert', label: 'Insert before', description: 'Queue a new message ahead of this one', currentValue: '', values: ['✓'] },
            ],
            6,
            settingsListTheme(),
            (action) => done(action),
            () => done(),
            {},
          ),
        })),
        (id, action) => {
          const target = queued.find(item => item.message.id === id)
          if (target === undefined) return
          const message = target.message
          if (action === 'delete') {
            inbox.remove(message.id)
            app.notify('queued message deleted', 'info')
          } else if (action === 'steer') {
            // Mirrors Ctrl+S on a single message: a running turn takes the
            // steer immediately; an idle agent starts a fresh turn with it.
            inbox.remove(message.id)
            if (liveAgent.status === 'running') {
              liveAgent.steer(message)
            } else {
              liveAgent.followup(message)
            }
            app.notify('steering queued message', 'info')
          } else if (action === 'edit' || action === 'insert') {
            // The free-text question flow collects the replacement/new text;
            // every mutation commits an inbox splice that refreshes the
            // pane. An owned workflow: the answers drive the splice —
            // runOwned (AGENTS.md), never a bare void. The question flow
            // rejects with a cancellation-shaped error on Esc/abort (so the
            // user cancel is debug-only through runOwned) and with a real
            // error otherwise (default error diagnostics — no silent
            // swallowing); either way the queue stays untouched.
            runOwned('queued message edit', () => app.askQuestions([{ id: 'q', question: action === 'edit' ? 'Edit queued message:' : 'New message to insert:' }]), {
              diag: runner.diag,
              sessionId: () => runner.liveAgent?.session.id,
              onResult: (answers) => {
                const text = answers[0]?.custom?.trim() ?? ''
                if (text === '') return
                const next = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
                if (action === 'edit') {
                  inbox.replace(message.id, next)
                  app.notify('queued message updated', 'info')
                } else {
                  // Insert at the selected message's CURRENT position: the
                  // queue may have shifted while the panel was open (a claim
                  // or another splice), so re-locate instead of trusting the
                  // snapshot index. A consumed message has nothing left to
                  // insert before.
                  const list = target.list === 'next-turn' ? inbox.nextTurn : inbox.nextStep
                  const position = list.findIndex(item => item.id === message.id)
                  if (position < 0) return
                  inbox.splice(target.list, position, 0, [next])
                  app.notify('message inserted before the selected one', 'info')
                }
              },
            })
          }
        },
        () => {},
      )
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'tasks',
    description: 'List background jobs for this session',
    handler: async () => {
      const liveAgent = await requireAgent()
      const jobs = ctx.get('jobs')
      if (jobs === undefined) return { kind: 'error', text: 'jobs service unavailable' }
      const snapshots = jobs.list(liveAgent)
      if (snapshots.length === 0) return { kind: 'error', text: 'no background jobs' }
      app.openTaskBrowser(
        snapshots.map(job => ({
          value: job.id,
          label: `${job.kind} · ${job.label}`,
          status: job.status,
          detail: job.detail,
          startedAt: job.startedAt,
          group: 'jobs',
        })),
        // Enter on a row opens the SAME detail as the ↓ browser: the status
        // viewer for bash jobs, the child transcript for subagent jobs.
        // (Completed jobs are reachable exactly through this path — the ↓
        // trigger only arms while a task is running.)
        (jobId) => runner.openJobView(jobId),
        () => {},
        { header: 'tasks', enableSearch: true },
      )
      return { kind: 'success' }
    },
  })

  // `/permission` is NOT registered here: dsh-permission-presets in the
  // base layer already registers it (text form: `/permission` shows the
  // current preset, `/permission <name>` switches). Registering it again
  // would throw "command already registered" and kill the TUI.
  // `/yolo` IS a TUI-owned alias: it delegates to the official command line,
  // so the switch takes the exact official path (sandbox + live approval
  // writer + the injected policy-change model message + the preset log).
  commands.register({
    name: 'yolo',
    description: 'Switch to danger-full-access (alias of /permission danger-full-access)',
    handler: async () => {
      const liveAgent = await requireAgent()
      const commands = ctx.get('commands')
      if (commands === undefined) return { kind: 'error', text: 'commands service unavailable' }
      const execution = await commands.execute(liveAgent, '/permission danger-full-access', signal)
      if (execution === undefined) {
        return { kind: 'error', text: '/permission unavailable (permission presets not composed)' }
      }
      return { kind: 'success', text: 'danger-full-access — approvals off' }
    },
  })

  // `/preset` IS TUI-owned: the base composes no roster and registers no
  // preset command, so this cannot collide (P5.7 lesson, positive case).
  //
  // Sessionless by design (deferred start): typing /preset before any
  // session exists used to CREATE one (dispatchViaSession calls
  // ensureSession() for anything outside SESSIONLESS_COMMANDS), and the
  // roster's rows were inert — SettingsList only fires onChange for rows
  // with values or a submenu, and /preset rows had neither, so the switch
  // the picker promised was impossible. The handler reads
  // runner.liveAgent optionally and never creates a session itself.
  commands.register({
    name: 'preset',
    description: 'Show or switch the session agent preset',
    input: { hint: '[status|<id>|default [<id>]]' },
    handler: async (invocation) => {
      const presets = ctx.get('agentPresets')
      if (presets === undefined) {
        return { kind: 'error', text: 'agent presets unavailable in this deployment' }
      }
      const liveAgent = runner.liveAgent
      const current = liveAgent === undefined
        ? undefined
        : presets.composedPreset(liveAgent.ctx) ?? resolveSessionPreset(liveAgent.session)
      const matched = invocation.rawInput.trim().match(/^(\S+)(?:\s+(.*))?$/)
      const verb = matched?.[1] ?? ''
      const rest = matched?.[2]?.trim() ?? ''
      if (verb === 'status') {
        return { kind: 'success', text: `preset: ${current ?? 'none'} · default: ${presets.defaultId}` }
      }
      if (verb === 'default') {
        const settings = ctx.get('settings')
        if (settings === undefined) return { kind: 'error', text: 'settings service unavailable' }
        const ns = settingsNamespace('agent-presets')
        if (rest === '') {
          const doc = settings.get(ns) as { default?: string } | undefined
          return { kind: 'success', text: `default preset: ${doc?.default ?? presets.defaultId}` }
        }
        // The saved default only affects sessions created from now on. A
        // standing catalog refresh follows ONLY when no higher-precedence
        // override (run-local pending or launch-time --preset) masks the
        // new default — the masked case must not re-read a preset the next
        // session will not compose on.
        try {
          await settings.mutate(ns, [{ op: 'set', path: ['default'], value: rest }])
        } catch (error) {
          return { kind: 'error', text: safeErrorMessage(error) }
        }
        if (runner.effectivePresetId === undefined) {
          const outcome = await runner.refreshCatalog({
            source: 'preset',
            target: { kind: 'preset', presetId: rest },
          })
          if (outcome.kind === 'applied' && outcome.notice !== undefined) app.notify(outcome.notice, 'error')
        }
        return { kind: 'success', text: `default preset set: ${rest}` }
      }
      // Selecting swaps the composition; only a blank session (no turn
      // has run yet) may do so — a started conversation's history was
      // produced under its preset's tools. Same rule as the official
      // `agentPreset.select` RPC and the launch-time --preset path. With
      // no session at all the choice lands on the run-local pending
      // preset the next session composes on (nothing is created here).
      const applyPresetSelection = async (id: string):
        Promise<{ kind: 'pending'; preset: string } | { kind: 'switched'; preset: string } | { kind: 'locked'; sessionId: string }> => {
        if (liveAgent === undefined) {
          const resolved = await presets.resolve(id)
          runner.pendingPreset = resolved.id
          // The sessionless catalog follows the choice through the STANDING
          // scope of the new preset (no Agent, no session — composition
          // probes are disabled in this deployment, see
          // docs/surface-catalog.md). A failed read degrades inside the
          // coordinator: the choice itself still applies.
          const outcome = await runner.refreshCatalog({
            source: 'preset',
            target: { kind: 'preset', presetId: resolved.id },
          })
          if (outcome.kind === 'applied' && outcome.notice !== undefined) app.notify(outcome.notice, 'error')
          return { kind: 'pending', preset: resolved.id }
        }
        const outcome = await runner.recomposeBlank(id)
        if (outcome.kind === 'locked') return { kind: 'locked', sessionId: liveAgent.session.id }
        // The still-blank session's agent layer changed: refresh the live
        // catalog for the SAME owner (no transition — the old scoped
        // previews are being replaced by the new composition's).
        await runner.refreshCatalog({
          source: 'preset',
          target: { kind: 'agent', key: runner.sessionGeneration },
          agent: runner.liveAgent,
        })
        // A still-blank session's welcome card shows the preset: repaint it
        // so the switch is visible before any conversation starts.
        runner.updateWelcomeCard()
        return { kind: 'switched', preset: outcome.preset }
      }
      const pickPreset = async (id: string): Promise<void> => {
        let outcome: Awaited<ReturnType<typeof applyPresetSelection>>
        try {
          outcome = await applyPresetSelection(id)
        } catch (error) {
          app.notify(safeErrorMessage(error), 'error')
          return
        }
        if (outcome.kind === 'pending') {
          app.notify(`new sessions will start on preset ${outcome.preset}`, 'info')
        } else if (outcome.kind === 'switched') {
          app.notify(`session preset switched to ${outcome.preset}`, 'info')
        } else {
          app.notify(
            `session "${outcome.sessionId}" has already started; its agent preset is fixed — preset switching is only available in a new session`,
            'error',
          )
        }
      }
      if (verb !== '') {
        try {
          const outcome = await applyPresetSelection(verb)
          if (outcome.kind === 'pending') {
            return { kind: 'success', text: `new sessions will start on preset ${outcome.preset}` }
          }
          if (outcome.kind === 'locked') {
            const message = `session "${outcome.sessionId}" has already started; its agent preset is fixed — preset switching is only available in a new session`
            app.notify(message, 'error')
            return { kind: 'error', text: message }
          }
          return { kind: 'success', text: `session preset switched to ${outcome.preset}` }
        } catch (error) {
          return { kind: 'error', text: safeErrorMessage(error) }
        }
      }
      const roster = await presets.list()
      if (roster.length === 0) return { kind: 'success', text: 'no agent presets configured' }
      // A started conversation's history was produced under its preset's
      // tools: offer no selectable roster — say why instead (the typed
      // /preset <id> path above refuses the same way).
      if (liveAgent !== undefined && liveAgent.session.events.some(event => event.type === 'turn/start')) {
        const message = `preset switching is only available in a new session — session "${liveAgent.session.id}" has already started; its preset is fixed (use /new for a fresh session, or /preset default <id> for future sessions)`
        app.notify(message, 'error')
        return { kind: 'error', text: message }
      }
      const close = app.openSettings(
        roster.map(preset => {
          const display = presetDisplayText(preset)
          return {
            id: preset.id,
            label: `${display.name} (${preset.id})`,
            description: [
              display.description,
              preset.trust === 'system' ? 'system' : 'user',
              preset.id === presets.defaultId ? 'default' : undefined,
              preset.id === current ? '← current' : undefined,
              preset.broken,
            ].filter(Boolean).join(' · '),
            currentValue: '',
            // The values entry makes SettingsList.activateItem fire
            // onChange on Enter/Space (rows without values or a submenu
            // are inert) — one key confirms the switch while the selected
            // row's description still renders in full below the list.
            values: [preset.id],
          }
        }),
        (id) => {
          close()
          // The picker's selection is an async result-consuming flow: the
          // outcome drives the notices — runOwned (AGENTS.md), never a bare
          // void; cancellation (a torn-down TUI) is debug-only.
          runOwned('preset pick', () => pickPreset(id), {
            diag: runner.diag,
            sessionId: () => runner.liveAgent?.session.id,
            onError: (error) => app.notify(`preset selection failed: ${safeErrorMessage(error)}`, 'error'),
          })
        },
        () => {},
      )
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'subagents',
    description: 'List child agents; view a transcript or interrupt one',
    handler: async () => {
      const liveAgent = await requireAgent()
      const subagents = ctx.get('subagents')
      if (subagents === undefined) return { kind: 'error', text: 'subagent service unavailable' }
      const children = (await subagents.listChildren(liveAgent.session.id))
        .filter(child => child.kind === 'child')
      if (children.length === 0) return { kind: 'success', text: 'no subagents for this session' }
      const labelOf = (child: (typeof children)[number]): string => child.label ?? child.id
      const closeSubagents = app.openSettings(
        children.map(child => ({
          id: child.id,
          label: labelOf(child),
          description: `${child.mode} · ${child.activity}${child.hasChildren ? ' · has children' : ''}`,
          currentValue: '',
          // The submenu is rendered INSIDE the list (SettingsList mounts
          // the returned component in place); picking an action reports
          // it through the list's onChange. Opening a second panel here
          // would leave this list mounted as a ghost overlay that eats
          // every later Esc.
          submenu: (value, done) => new SettingsList(
            [
              { id: 'view', label: 'View transcript', description: 'Watch this session read-only (Esc to return)', currentValue: '', values: ['✓'] },
              { id: 'interrupt', label: 'Interrupt', description: 'Cancel the child agent', currentValue: '', values: ['✓'] },
            ],
            6,
            settingsListTheme(),
            // The action is the row ID; the cycled value is a checkmark.
            (id) => done(id),
            () => done(),
            {},
          ),
        })),
        (childId, action) => {
          const child = children.find(candidate => candidate.id === childId)
          if (child === undefined) return
          // Action-style row: dismiss the list AFTER the action so it never
          // stays mounted as a ghost overlay eating every later key.
          closeSubagents()
          if (action === 'view') {
            detach('subagent view', () => runner.enterView(child.id, labelOf(child)), { notify: true })
          } else if (action === 'interrupt') {
            subagents.interrupt(child.id, { kind: 'user', parentSessionId: liveAgent.session.id })
            app.notify(`interrupting ${labelOf(child)}`, 'info')
          }
        },
        () => {},
      )
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'search',
    description: 'Search persisted sessions for text and switch to a hit',
    input: { hint: '<query>' },
    handler: async (invocation) => {
      const currentId = runner.liveAgent?.session.id
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) return { kind: 'error', text: 'session persistence unavailable' }
      const query = invocation.rawInput.trim()
      if (query === '') return { kind: 'error', text: 'search needs a query' }
      const needle = query.toLowerCase()
      const headers = (await persistence.list())
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 100)
      const hits: { id: string; createdAt: number; snippet: string }[] = []
      for (const header of headers) {
        let raw: { content: string } | undefined
        try {
          raw = await persistence.readRaw(header.id)
        } catch {
          continue
        }
        if (raw === undefined) continue
        const index = raw.content.toLowerCase().indexOf(needle)
        if (index === -1) continue
        const start = Math.max(0, index - 40)
        const snippet = raw.content.slice(start, index + query.length + 40).replace(/\s+/g, ' ').trim()
        hits.push({ id: header.id, createdAt: header.createdAt, snippet })
        if (hits.length >= 20) break
      }
      if (hits.length === 0) return { kind: 'success', text: `no persisted session contains "${query}"` }
      const now = Date.now()
      app.openPicker(
        hits.map(hit => ({
          value: hit.id,
          label: hit.id.length > 26 ? `${hit.id.slice(0, 26)}…` : hit.id,
          description: `${Math.max(0, Math.floor((now - hit.createdAt) / 60000))}m ago · …${hit.snippet}…`,
        })),
        (id) => {
          if (id === currentId) return
          switchSession(id)
        },
        () => {},
      )
      return { kind: 'success' }
    },
  })

  // Shared by /title and its /rename alias. With an argument, pins the
  // session title (explicit user rename). WITHOUT an argument, regenerates
  // it from the conversation through the sessionTitle service's explicit
  // refresh — the deliberate unpin: regeneration OVERWRITES the current
  // title, including one the user pinned earlier. A blank session (no user
  // message yet) leaves the title untouched and informs the user.
  const titleHandler = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const liveAgent = await requireAgent()
    const titles = ctx.get('sessionTitle')
    if (titles === undefined) return { kind: 'error', text: 'session title service unavailable' }
    const name = invocation.rawInput.trim()
    if (name !== '') {
      try {
        titles.rename(liveAgent.session, name)
      } catch (error) {
        return { kind: 'error', text: safeErrorMessage(error) }
      }
      return { kind: 'success', text: `title set: ${name}` }
    }
    try {
      const regenerated = await titles.refresh(liveAgent.session, invocation.signal)
      if (regenerated === undefined) {
        app.notify('no conversation yet — title left as-is', 'info')
        return { kind: 'success' }
      }
      app.notify(`title regenerated: ${regenerated.title}`, 'info')
      return { kind: 'success' }
    } catch (error) {
      return { kind: 'error', text: safeErrorMessage(error) }
    }
  }

  commands.register({
    name: 'title',
    description: 'Set the session title; without an argument, regenerate it from the conversation (overwrites the current title)',
    input: { hint: '<title>' },
    handler: titleHandler,
  })

  commands.register({
    name: 'rename',
    description: 'Alias of /title: set the session title, or regenerate it without an argument (overwrites the current title)',
    input: { hint: '<title>' },
    handler: titleHandler,
  })

  commands.register({
    name: 'copy',
    description: 'Copy the last assistant message (OSC 52 clipboard)',
    handler: async () => {
      const liveAgent = await requireAgent()
      const last = liveAgent.session.events.findLast((event): event is SessionEvent<'assistant/message'> =>
        event.type === 'assistant/message')
      if (last === undefined) return { kind: 'error', text: 'no assistant message yet' }
      const text = last.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (text === '') return { kind: 'error', text: 'last assistant message has no text' }
      if (process.stdout.isTTY !== true) return { kind: 'error', text: 'clipboard needs a TTY (OSC 52)' }
      process.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`)
      return { kind: 'success', text: 'copied last assistant message' }
    },
  })

  commands.register({
    name: 'export',
    description: 'Export this session log (JSONL by default, `md` for a readable transcript)',
    input: { hint: '[md|<path>]' },
    handler: async (invocation) => {
      const liveAgent = await requireAgent()
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) return { kind: 'error', text: 'session persistence unavailable' }
      const arg = invocation.rawInput.trim()
      const shortId = liveAgent.session.id.replace(/^session-/, '').slice(0, 8)
      const markdown = arg === 'md'
      const target = arg !== '' && !markdown
        ? arg
        : join(cwd, markdown ? `dsh-session-${shortId}.md` : `dsh-session-${shortId}.jsonl`)
      try {
        if (markdown) {
          writeFileSync(target, renderTranscriptMarkdown(liveAgent.session))
          return { kind: 'success', text: `exported markdown transcript to ${target}` }
        }
        // The raw artifact is the backend's verbatim JSONL (decoded from
        // its physical encoding) — a faithful, portable session log.
        const raw = await persistence.readRaw(liveAgent.session.id)
        if (raw === undefined) return { kind: 'error', text: 'no materialized session log to export' }
        writeFileSync(target, raw.content)
        return { kind: 'success', text: `exported ${raw.filename} to ${target}` }
      } catch (error) {
        return { kind: 'error', text: safeErrorMessage(error) }
      }
    },
  })

  commands.register({
    name: 'fork',
    description: 'Fork this session at the last completed turn',
    handler: async () => {
      const liveAgent = runner.liveAgent
      const seed = liveAgent === undefined ? undefined : forkSeed(liveAgent.session.events)
      if (seed === undefined) return { kind: 'error', text: 'no completed turn to fork from' }
      // The child inherits the parent's recorded preset (official fork
      // semantics: forkComposition = composeAgent(resolveSessionPreset(source))).
      const composition = await runner.compose(resolveSessionPreset(liveAgent!.session))
      const presetId = composition.agentPreset
      const next = await runner.agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { ...metaOf(cwd, presetId), parentSession: liveAgent!.session.id, seedLength: seed.length },
        agentOptions: { provider: liveAgent!.options.provider, model: liveAgent!.options.model },
        setup: composition.setup,
        seed,
      })
      const error = await runner.swapTo(next)
      if (error !== undefined) app.notify(error, 'error')
      return { kind: 'success', text: `forked as ${next.agent.session.id}` }
    },
  })

  commands.register({
    name: 'status',
    description: 'Show session stats and identity',
    handler: async () => {
      const liveAgent = await requireAgent()
      const stats = computeStats(liveAgent.session.events)
      let contextTokens: number | undefined
      const meter = ctx.get('tokenMeter')
      if (meter !== undefined) {
        try {
          contextTokens = meter.measure(liveAgent.session).totalTokens
        } catch {
          // Measurement is best-effort; the panel falls back to unmeasured.
        }
      }
      app.openSettings(
        [
          {
            id: 'session-id',
            label: color.textDim('Session'),
            description: color.textDim(liveAgent.session.id),
            currentValue: color.textDim(displaySessionId(liveAgent.session.id)),
          },
          { id: 'session-stats', label: 'Stats', description: formatStats(stats), currentValue: '' },
          {
            id: 'session-context',
            label: 'Context',
            description: contextTokens === undefined ? 'unmeasured' : `${Math.round(contextTokens / 1000)}k tokens in window`,
            currentValue: '',
          },
        ],
        () => {},
        () => {},
      )
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'login',
    description: 'Set an API key — deepseek official or an llm-pi-ai provider route',
    input: { hint: '[<route|env-var>]' },
    handler: async (invocation) => {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return { kind: 'error', text: 'credentials service unavailable' }
      // One merged credential catalog: deepseek official plus every
      // configurable-provider directory route (the installed catalog, dormant
      // or not, plus hand-declared profiles), each carrying its apiKeyEnv ref
      // (or the derived conventional one). The llm directory is the primary
      // source; the settings-only read is the fallback when the llm service
      // is absent.
      const options = readProviderOptions(ctx)
      const arg = invocation.rawInput.trim()
      let route: string | undefined
      if (arg !== '') {
        // A route name that resolves to a known target sets that target's key;
        // an env-var-looking name is used verbatim (the old escape hatch); a
        // NEW route name (valid route pattern, not in the catalog) starts the
        // add wizard with the route pre-filled.
        const known = resolveCredentialArg(arg, options)
        if (known !== undefined) {
          route = options.find(option => option.ref === known)?.route ?? arg
        } else if (ROUTE_PATTERN.test(arg)) {
          const outcome = await askAddProvider(ctx, app, runner.signal, arg)
          if (outcome.kind === 'cancelled') return { kind: 'error', text: 'add provider cancelled' }
          if (outcome.kind === 'error') return { kind: 'error', text: outcome.text }
          return { kind: 'success', text: outcome.text }
        } else {
          return { kind: 'error', text: `unknown credential target "${arg}" — ${options.map(option => `${option.label} (${option.ref})`).join(', ')}` }
        }
      } else if (options.length > 1) {
        // Picker with search + grouping + the Add New Platform action row.
        const picked = await new Promise<string | undefined>((resolve) => {
          app.openPicker(
            providerPickerRows(options),
            (value) => resolve(value),
            () => resolve(undefined),
            {
              enableSearch: true,
              header: 'login · providers',
              noMatchText: '  no matching providers',
              width: 76,
              maxHeight: 26,
              showHint: true,
            },
          )
        })
        if (picked === undefined) return { kind: 'error', text: 'login cancelled' }
        if (picked === ADD_PROVIDER_VALUE) {
          const outcome = await askAddProvider(ctx, app, runner.signal)
          if (outcome.kind === 'cancelled') return { kind: 'error', text: 'add provider cancelled' }
          if (outcome.kind === 'error') return { kind: 'error', text: outcome.text }
          return { kind: 'success', text: outcome.text }
        }
        route = picked
      } else {
        route = options[0]?.route
      }
      if (route === undefined) return { kind: 'error', text: 'no credential targets available' }
      const option = options.find(candidate => candidate.route === route)
      const ref = option?.ref ?? deriveKeyRef(route)
      try {
        const answers = await app.askQuestions([
          { id: 'key', question: `Paste the API key for ${option?.label ?? route}:` },
        ])
        const key = answers[0]?.custom ?? ''
        if (key === '') return { kind: 'error', text: 'empty key; nothing set' }
        await credentials.set(ref as CredentialRef, key)
        return { kind: 'success', text: `${ref} set` }
      } catch {
        return { kind: 'error', text: 'login cancelled' }
      }
    },
  })

  commands.register({
    name: 'logout',
    description: 'Clear a stored API key — deepseek official or an llm-pi-ai provider route',
    input: { hint: '[<route|env-var>]' },
    handler: async (invocation) => {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return { kind: 'error', text: 'credentials service unavailable' }
      const options = readProviderOptions(ctx)
      const arg = invocation.rawInput.trim()
      if (arg !== '') {
        const resolved = resolveCredentialArg(arg, options)
        if (resolved === undefined) {
          return { kind: 'error', text: `unknown credential target "${arg}" — ${options.map(option => `${option.label} (${option.ref})`).join(', ')}` }
        }
        await credentials.unset(resolved as CredentialRef)
        return { kind: 'success', text: `${resolved} cleared` }
      }
      await credentials.unset(options[0]!.ref as CredentialRef)
      return { kind: 'success', text: `${options[0]!.ref} cleared` }
    },
  })

  commands.register({
    name: 'help',
    description: 'Show keybindings and available commands',
    handler: () => {
      const rows: SettingItem[] = [        { id: 'k-enter', label: 'Enter', description: 'Submit (steers the running turn while busy when Enter while busy is Steer; skill commands steer too, UI commands run locally)', currentValue: '' },
        { id: 'k-queue', label: 'Ctrl+Enter', description: 'Queue the draft while the agent is busy (the opposite of Enter while busy)', currentValue: '' },
        { id: 'k-exit', label: 'Ctrl+C / Ctrl+D', description: 'Quit the TUI (flushes the session)', currentValue: '' },
        { id: 'k-cancel', label: 'Double-Esc', description: 'Cancel the active turn / tool / shell command', currentValue: '' },
        { id: 'k-fold', label: 'Ctrl+O', description: 'Expand/collapse recent tool output and thinking', currentValue: '' },
        { id: 'k-todo', label: 'Ctrl+T', description: 'Toggle the todo panel', currentValue: '' },
        { id: 'k-think', label: 'Alt+T', description: 'Hide/show thinking blocks', currentValue: '' },
        { id: 'k-steer', label: 'Ctrl+S', description: 'Steer the running turn with the draft', currentValue: '' },
        { id: 'k-editor', label: 'Ctrl+G', description: 'Edit the draft in $VISUAL/$EDITOR', currentValue: '' },
        { id: 'k-search', label: 'Ctrl+F', description: 'Search the transcript (Enter/Shift+Enter jump, Esc closes)', currentValue: '' },
        { id: 'k-tab', label: 'Tab', description: 'Autocomplete slash commands and file paths', currentValue: '' },
        { id: 'k-hist', label: '↑/↓', description: 'Recall input history on an empty line', currentValue: '' },
        { id: 'k-bang', label: '! cmd', description: 'Run a shell command and submit the command and its output to the session; !! runs locally without recording', currentValue: '' },
        { id: 'sep-help', label: color.border('─'.repeat(34)), currentValue: '' },
        ...commands.list(runner.liveAgent as unknown as Agent).map(command => ({
          id: `cmd-${command.name}`,
          label: `/${command.name}`,
          description: command.description,
          currentValue: '',
        })),
      ]
      app.openSettings(rows, () => {}, () => {})
      return { kind: 'success' }
    },
  })

  // All TUI commands are registered now. The initial snapshot (when one was
  // prefetched before the TUI mounted) installs SYNCHRONOUSLY here: no
  // detached refresh, no await — the first input can never beat it. Without
  // a snapshot the plain global completion refresh runs as before, and the
  // per-skill commands wait for the first live session's coordinator refresh
  // or /reload.
  if (initial?.snapshot !== undefined) {
    installSurfaceSnapshot(initial.snapshot)
  } else if (initial?.skills !== undefined) {
    // Cold standing-scope skills (deferred start): wrappers + the global
    // completion merge in one synchronous commit — no scoped overrides
    // exist before a session, so the merge base is the current global view.
    withCommandCommit(() => {
      replaceSkillCommands(initial.skills!.skills, new Set())
      savedScopedCommands = []
      installCompletions(mergeGlobalAndSavedScoped())
    })
  } else {
    refreshCompletions()
  }
  // Registry changes from OUTSIDE this surface (global plugins, agent
  // mounts/unmounts) refresh the completions immediately: sessionless →
  // fresh global view + saved scoped overrides (never a re-probe); live →
  // the live agent's effective view. The probe's own scoped registrations
  // fire the same event; the merge rules keep them from recursing. The
  // listener is registered AFTER the TUI's built-in commands (whose
  // registrations need no coalescing — the snapshot/wrapper bulk commits
  // use withCommandCommit instead).
  ctx.on('commands/change', () => {
    if (commandCommitDepth > 0) {
      commandCommitDirty = true
      return
    }
    refreshCompletions()
  })
  return {
    /** The claim test for the dispatch: is /name advertised right now? */
    wasAdvertised,
    /** One synchronous catalog commit (the coordinator's install hook). */
    installSnapshot: (snapshot: SurfaceCatalogSnapshot): void => installSurfaceSnapshot(snapshot),
    /** The revalidating transition (the coordinator's target-change hook). */
    enterTransition: (): void => enterCatalogTransition(),
  }
}
