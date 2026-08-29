/**
 * The TUI-owned slash commands (/exit /settings /sessions /skill /model
 * /new /tasks /preset /search /title /copy /export
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
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult, CommandDescriptor, CommandDefinition } from '@deepseek-ai/dsh-commands'
import { TransitionInProgressError } from './session-operation-barrier.ts'
import { createForkedAgent } from './session-fork.ts'
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { SettingsList, type SettingItem } from '@xmoon76/pi-tui'
import { mergeDraft } from './steer.ts'
import { applyHomeEndKeyMode, homeEndKeysModeOf } from './home-end-keys.ts'
import { iconStyleOf } from './icons.ts'
import { parseUserKeybindings } from './keybindings/config.ts'
import { formatKeyId } from './keybindings/hints.ts'
import type { AppKeybindingId } from './keybindings/types.ts'
import { KeybindingEditorController } from './keybinding-ui/controller.ts'
import { KeybindingEditorPanel, KeybindingEditorUnavailablePanel } from './keybinding-ui/list.ts'
import type { KeybindingEditorModel } from './keybinding-ui/model.ts'
import { parseFooterLayout, isFooterLayout } from './footer/layout.ts'
import { DEFAULT_FOOTER_LAYOUT } from './footer/presets.ts'
import { FooterComposer } from './footer/composer.ts'
import {
  FooterCustomItemCatalog,
  parseFooterCustomItem,
  parseFooterCustomItems,
  type FooterCustomItemSettings,
} from './footer/custom-items.ts'
import { FooterItemRegistry } from './footer/item-registry.ts'
import { FooterConfiguratorModel } from './footer/configurator-model.ts'
import type { TuiApp } from './tui-app.ts'
import type { PickerCategory, PickerItem } from './tui-app.ts'
import type { Diag } from './diag.ts'
import { runDetached, runOwned, type OwnedTaskOptions } from './detached.ts'
import { safeErrorMessage } from './error-boundary.ts'
import { consumeDraftImages, pruneUnreferencedDrafts } from './image/submit.ts'
import { readImageFile } from './image/intake.ts'
import { parseShellWords } from './shell-words.ts'
import { color, loadCustomTheme, customThemeNames, settingsListTheme } from './theme.ts'
import { ThemeSubmenu, themeDisplayName as themeDisplayNameOf } from './theme-menu.ts'
import { resolveThemeSelection, normalizePersistedTheme } from './theme-source.ts'
import { suggestPathArgument } from './mentions.ts'
import { FILE_ARGUMENT_COMMANDS } from './file-completion/context.ts'
import { ModelSubmenu } from './model-menu.ts'
import { computeStats, formatStats } from './stats.ts'
import { renderTranscriptMarkdown, textOf } from './transcript.ts'
import {
  TITLE_BATCH_SIZE,
  TITLE_FIRST_BATCH,
  buildSessionTree,
  findSessionMatch,
  sameWorkspace,
  sessionLabelParts,
  sessionPickerItem,
  type SessionPickerItem,
  type SessionPickerRow,
} from './sessions.ts'
import type { SessionReader } from './runtime/session-reader-port.ts'
import type { SessionWriter } from './runtime/session-writer-port.ts'
import type { InteractionPort } from './runtime/interaction-port.ts'
import type { CreateSessionRequest, ResumeSessionRequest, SessionHandle } from './runtime/session-lifecycle-port.ts'
import type { Catalog } from './runtime/catalog-port.ts'
import type { ConfigPort, CredentialProviderOption } from './runtime/config-port.ts'
import type { HostFilePort } from './runtime/host-file-port.ts'
import {
  credentialOptionsFor,
  deriveKeyRef,
  providerOptionsFor,
  resolveCredentialArg,
  ROUTE_PATTERN,
  PROTOCOL_CHOICES,
} from './provider-catalog.ts'
import {
  authorizationFailureText,
  createAuthorizationFlow,
  flowForRoute,
  mergeLoginTargets,
  type AuthorizationTarget,
  type LoginTarget,
} from './authorization.ts'
import type { CatalogRefreshOutcome, CatalogRefreshRequest } from './skill-catalog-refresh.ts'
import {
  commandSummaryOf,
  listGlobalCommands,
  type SurfaceCatalogSnapshot,
  type SurfaceCommandSummary,
} from './surface-catalog.ts'
import {
  isUserInvocableSkill,
  type HumanSkillCatalog,
  type HumanSkillSummary,
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
 * The `/sessions` category tabs (the 2026-08-22 plan, item 3): the session
 * picker is a HUMAN surface, so subagent children never appear in either
 * scope — /tasks and the subagent viewer own that surface now (kimi's
 * directory-scope direction). `current` scopes to the live session's
 * workspace (the sessionCwd the whole surface follows); `all` lists every
 * main session, grouped by its workspace. Exported so the scope contract
 * is unit-testable without a runner.
 * @param rows - the picker rows, newest first (the FULL row set — a main
 *   session beyond any read-window is still listed here, so the title
 *   loader must cover every row this function can show).
 * @param currentCwd - the live session's workspace.
 * @param header - the picker header prefix (`sessions` / `resume`).
 * @param itemFor - the row → picker item mapper (titles + current marker).
 */
export function sessionPickerCategories(
  rows: readonly SessionPickerRow[],
  currentCwd: string,
  header: string,
  itemFor: (row: SessionPickerRow, indent?: number) => SessionPickerItem,
): PickerCategory[] {
  const mainRows = rows.filter(row => row.origin !== 'subagent')
  return [
    {
      id: 'current',
      label: 'Current directory',
      header: `${header} · Current directory`,
      // The same lineage tree as "All directories", built over the CURRENT
      // workspace's subset: a fork/rewind branch whose parent lives in
      // another workspace (or outside the window) is an orphan at depth 1 —
      // never lost, never mis-nested under an unrelated root.
      items: () => buildSessionTree(
        mainRows.filter(row => sameWorkspace(row.cwd, currentCwd)),
      ).map(entry => itemFor(entry.row, entry.depth)),
    },
    {
      id: 'all',
      label: 'All directories',
      header: `${header} · All directories`,
      // The lineage tree (plan §20): fork/rewind children and subagents
      // hang under their parentSession chain with a └─ prefix — never flat
      // roots. Orphans sit at depth 1; the tree's `placed` guard keeps
      // corrupt metadata from looping.
      items: () => buildSessionTree(mainRows).map(entry => itemFor(entry.row, entry.depth)),
    },
  ]
}

/**
 * Display copy for the four shipped agent presets, fixed in English — the
 * web surface's `BUILT_IN_PRESET_KEYS` mapping (`dsh-client-ui-agent-preset`),
 * TUI-side. The effective roster root is the DSH agent-presets package's
 * official shipped root; its preset metadata language is not ours to control. Mapping the known ids keeps the picker English regardless of
 * what the files say; everything else renders file metadata. Names follow
 * the upstream English locale (`presetCodeName` is 'PTC mode').
 */
const BUILT_IN_PRESET_COPY: Readonly<Record<string, { name: string; description: string }>> = {
  standard: {
    name: 'Standard mode',
    description: 'Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.',
  },
  ptc: {
    name: 'PTC mode',
    description: 'All Standard mode capabilities, with tools exposed through the PTC mode SDK so the model can combine multi-step operations in one TypeScript program.',
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

/** The TUI settings document surface (theme/footer/footerLayout/
 * fullscreen/busyEnter/localShellSandbox/homeEndKeys/focusMode). The old
 * `history` field moved to $DSH_HOME/user-history/*.jsonl and is
 * deliberately NOT part of the document anymore. The type now lives on
 * the config port (M1.9); the re-export keeps the public commands-surface
 * name stable for tests. The user keybinding overrides (`keybindings`,
 * an unknown-key pass-through in the config port's document schema — see
 * index.ts) ride along. */
export type { TuiSettingsLike, TuiSettingsDoc } from './runtime/config-port.ts'
import { serializeTuiSettingsMutation, type TuiSettingsDoc, type TuiSettingsLike } from './runtime/config-port.ts'


/** The minimal commands-registry surface the TUI command surface needs
 * (migration M1.11): registration + listing. This is a runner ASSEMBLY
 * dependency for the TUI's own registrations — never a Host backend
 * capability (the /yolo permission switch no longer reaches a commands
 * service; it goes through the config port). */
export interface CommandRegistryLike {
  register(definition: CommandDefinition): () => void
  list(agent?: unknown): readonly CommandDescriptor[]
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
  /** The session lifecycle port (migration M1.5): /new and /fork create
   * sessions through semantic requests (the Direct adapter resolves the
   * preset composition internally). */
  readonly agents: {
    create(options: CreateSessionRequest): Promise<SessionHandle>
    resume(options: ResumeSessionRequest): Promise<SessionHandle>
  }
  /** M2/PR C: apply the persisted footer mode and layout to the app (shared
   * by /settings, /reload and startup; fail-soft on invalid configs). The
   * optional definitions are a validated /footer-save result, not the merged
   * settings value; ordinary calls resolve definitions from the USER layer
   * through the config port. */
  applyFooterSettings(
    doc: { footer: string; footerLayout?: unknown; footerCustomItems?: unknown } | undefined,
    savedCustomItems?: readonly FooterCustomItemSettings[],
  ): void
  /** The session READ port (migration M1.3): /sessions, /resume, /search,
   * the title batches, the context measurement and the export read go
   * through the port, never ctx directly. */
  readonly sessionReader: SessionReader
  /** The session WRITE port (migration M1.4): follow-up delivery, steer,
   * queue pull-back, cancel and title ops go through the port. */
  readonly sessionWriter: SessionWriter
  /** The interaction port (migration M1.6): approval/question authority. */
  readonly interaction: InteractionPort
  /** The catalog port (migration M1.8): models/providers, presets and
   * skills — commands read Host catalogs through semantic DTOs, never
   * `ctx.llm` / `ctx.agentPresets` / `ctx.tools` service objects. */
  readonly catalog: Catalog
  /** The config port (migration M1.9): settings, provider profiles,
   * credentials, authorization, permissions and the preset default —
   * commands never touch the raw settings/credentials/authorization
   * services. */
  readonly config: ConfigPort
  /** The Host-file port (migration M1.10): `@`-mention discovery and
   * send-time canonicalization against the HOST filesystem — never the
   * client's fs assumption. */
  readonly hostFile: HostFilePort
  /** The minimal commands registry for the TUI's OWN registrations
   * (migration M1.11) — a runner assembly dependency, not a Host
   * capability. */
  readonly commandRegistry: CommandRegistryLike | undefined
  /** The ONE exit orchestration (flush with a hard timeout, cleanup, warn,
   * resume hint, process exit) — shared by Ctrl+C/Ctrl+D, /exit and /quit.
   * Command handlers must NEVER stop the app, flush or exit themselves. */
  requestExit(): void
  cwd: string
  /** The per-TUI draft image registry (image pipeline, plan M1). Shared by
   * the /image command, the clipboard intake and the submission path; the
   * runner clears it on submit/session-switch/dispose, never on durable
   * attachments. */
  imageStore: import('./image/draft-store.ts').DraftImageStore
  /** The shared clipboard WRITE policy (issue #7): tmux → platform helper
   * → OSC 52 best-effort. Used by /copy; the fullscreen drag selection
   * routes through the same policy via the app's copySelection option. */
  copyToClipboard(text: string): Promise<boolean>
  /** The deployment image policy (`ctx.attachments.imageLimits`), re-read
   * dynamically; undefined when the attachment service is unavailable. */
  imageLimits(): import('./image/intake.ts').ImageLimitsLike | undefined
  /** Insert text at the editor cursor (the image placeholder path). */
  insertIntoEditor(text: string): void
  /**
   * Prepare one draft text as an immutable UserMessage — the SAME pipeline
   * the submit/steer paths use (placeholder expansion, capability gate,
   * batched admission). Skill invocations build their message through this
   * so an image-bearing `/skill ...` line is a real multimodal prompt
   * (review finding 4).
   */
  prepareDraftMessage(text: string): Promise<import('@deepseek-ai/dsh-llm').UserMessage>
  /**
   * The live session's workspace (its header cwd), falling back to the
   * process cwd before any session exists. The editor autocomplete, the
   * footer/welcome cwd, and the per-directory input history follow THIS,
   * so switching sessions moves the whole surface with the session.
   */
  sessionCwd(): string
  signal: AbortSignal
  /** M11: callback-health bridge for extension registries. The REF
   * protocol: capture the identity ({slot, id, owner}) at INVOCATION
   * START via {@link TuiCommandRunner.captureExtensionHealthRef} and
   * report settlements against the captured ref — never the live
   * registry (an HMR reload may replace the id with a new owner by
   * settle time; a stale settlement must not land on the reloaded
   * plugin — the review's P2 generation fence). */
  captureExtensionHealthRef?: (slot: string, id: string) => { slot: string; id: string; owner: string } | undefined
  recordExtensionError?: (ref: { slot: string; id: string; owner: string }, error: unknown) => void
  clearExtensionError?: (ref: { slot: string; id: string; owner: string }) => void
  /** The runner's monotonic session generation; bumped on every session
   * swap. Late async work must re-check it before committing state. */
  readonly sessionGeneration: number
  switchSession(sessionId: string): Promise<string | undefined>
  /**
   * The unified session-transition transaction: the old session is flushed
   * BEFORE the child is created, the commit is a synchronous critical
   * section, and once `create` succeeds the child is published — there is
   * NO failure path afterwards that may be interpreted as "the child never
   * happened" (dsh has no durable rollback; `dispose()` stops an agent but
   * never deletes a persisted session). Callers create their child INSIDE
   * this transaction and must run it inside {@link withSessionTransition}.
   */
  transitionTo<T>(steps: {
    /** The child's PRE-GENERATED session identity (MANDATORY): the
     * transaction reserves its lease BEFORE the DSH call (while the old
     * lock is still held), so a refusal aborts with zero child side
     * effects; a create/resume rejection is NEVER retried (no same-ID
     * recovery) — once the DSH boundary is crossed, the target is PINNED
     * immediately and stays locked for this process's lifetime. */
    target: { id: string; header?: { cwd?: string } }
    /** Whether the target is a FRESH session: the target lock must settle
     * as acquired, or the transaction aborts before the create. */
    fresh?: boolean
    prepare?: () => Promise<void> | void
    create: () => Promise<T>
  }): Promise<{ ok: true; next: T } | { ok: false; message: string }>
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
  /** Whether Focus Mode is currently on (the authoritative runtime state). */
  focusEnabled(): boolean
  /** The UNIFIED Focus setter: mutates the runtime state and the TUI
   * surface immediately, persists best-effort (plan §7 — /settings and
   * /focus both route through this, never a direct settings write). */
  setFocusMode(enabled: boolean): void
  /** Repaint the welcome card from the live agent's current facts (e.g. after a preset switch). */
  updateWelcomeCard(): void
  /**
   * Open one job's detail from a task list: bash jobs show the status
   * viewer, subagent jobs the child transcript. Shared by the ↓/Ctrl+J
   * browser and `/tasks`.
   */
  openJobView(jobId: string): void
  /**
   * Open the MERGED task browser (jobs + subagents, searchable, row-level
   * interrupt on subagent rows). The single command-side entry behind
   * `/tasks` (and its `subagents` alias) — identical to the ↓ trigger.
   */
  openTasksBrowser(): void
  /**
   * Open the conversation rewind picker (plan: the ONE entry shared by the
   * idle empty-editor double-Esc and `/rewind`). The runner decides what
   * rewind means: it lists the completed user turns, and a selection forks
   * a child session before the chosen turn and restores its prompt into
   * the editor. Sessionless it degrades to a notify — it never creates a
   * session just to be rewound.
   */
  openRewindPicker(): void
  /**
   * The session-transition write fence: true while a session transition is
   * in flight (quiesce → commit). Agent-write entry points (plain submits,
   * steers, skill invocations, shell submits) check it right before the
   * write and refuse — the old agent may be woken again between whenIdle
   * and the lock handover, so a write in that window would target a
   * session whose lock is about to be released.
   */
  sessionTransitionPending(): boolean
  /**
   * Run one session-transition workflow exclusively through the
   * process-local single-writer gate: /new, /fork and /rewind must create
   * their child AND swap inside ONE exclusive section, so a transition can
   * never interleave with another — no mixed-parent child (cwd captured
   * across a concurrent switch), no stale commit after a switch, no ghost
   * child published to persistence once the surface moved. Re-entering the
   * gate from inside a task is refused loudly (it would deadlock).
   */
  withSessionTransition<T>(task: () => Promise<T> | T): Promise<T>
  /**
   * Run one TUI-owned session write inside the session operation barrier
   * (convergence plan phase 3): a transition started while this write
   * awaits drains it first; a write entering during a transition throws
   * TransitionInProgressError (the caller refuses with the fence UX).
   */
  withSessionWriter<T>(sessionId: string, task: () => Promise<T> | T): Promise<T>
  /**
   * Enter the subagent viewer for one child session: the target carries
   * the catalog MODE (continuable = interactive editor, one-shot =
   * read-only) and the exact direct-parent session id the follow-up write
   * path is pinned to.
   */
  enterView(
    childId: SessionId,
    label: string | undefined,
    mode: 'one-shot' | 'continuable',
    parentSessionId: SessionId,
    activity: 'running' | 'inactive',
  ): Promise<void>
  exit(code: number): void
  /**
   * The M5 extension registries (commands/themes/settings/autocomplete/
   * keybindings), when the extension service is mounted. Undefined
   * degrades to the host-only surface.
   */
  readonly extensions: {
    readonly commands: import('./command-bridge.ts').CommandBridge
    readonly themes: import('./theme-registry.ts').ThemeRegistry
    readonly settings: import('./settings-registry.ts').SettingsRegistry
    readonly autocomplete: import('./autocomplete-registry.ts').AutocompleteRegistry
    readonly keybindings: import('./keybinding-registry.ts').KeybindingRegistry
    readonly renderers: import('./renderer-registry.ts').RendererRegistry
    readonly editors: import('./editor-registry.ts').EditorRegistry
    /** The live extension API info (capabilities + deprecations — M11). */
    readonly api: (() => import('./extension/public-types.ts').PiTuiApiInfo) | undefined
    /** P1-08: the live contribution-health snapshot (failed/shadowed
     * states + lastError across EVERY registry incl. renderers/editors).
     * Undefined without the extension service. */
    readonly health: (() => readonly import('./extension/public-types.ts').ContributionHealth[]) | undefined
  } | undefined
}

/** The sentinel picker value for the "add a brand-new provider" action row. */
const ADD_PROVIDER_VALUE = '\u0000add-provider'
/** The sentinel prefix for an authorization-target picker row (a credential
 * key can never start with NUL, so route values cannot collide). */
const AUTH_VALUE_PREFIX = '\u0000auth:'

/**
 * M11: the /status extension-health rows (plan §16 — /status extension
 * health). Reads the extension registries' live snapshots: contribution
 * health (failed/shadowed states + last error), the registry revision
 * counts, and the capability set. Renders as read-only settings rows.
 * @param runner - the TuiCommandRunner (its extensions accessor is
 *   undefined without the extension service — the rows vanish).
 */
export function extensionHealthRows(runner: TuiCommandRunner): { id: string; label: string; description: string; currentValue: string }[] {
  const extensions = runner.extensions
  if (extensions === undefined) return []
  const rows: { id: string; label: string; description: string; currentValue: string }[] = []
  const health = extensions.commands.snapshot()
  const commandCount = health.entries.length
  // P1-08: the LIVE contribution-health snapshot (failed/shadowed states
  // + lastError) — the M11 health requirement is a real observable
  // surface, not registry counts only.
  const healthRecords = extensions.health?.() ?? []
  const themeCount = extensions.themes.snapshot().themes.length
  const settingCount = extensions.settings.snapshot().rows.length
  const autocompleteCount = extensions.autocomplete.snapshot().providers.length
  const bindingCount = extensions.keybindings.snapshot().bindings.length
  const rendererCount = extensions.renderers.snapshot().messageRenderers.length
    + extensions.renderers.snapshot().toolRenderers.length
  const editorCount = extensions.editors.snapshot().editors.length
  rows.push({
    id: 'ext-registry-counts',
    label: color.textDim('Extensions'),
    description: 'Live contributions across every registry (M1–M9)',
    currentValue: color.textDim(
      `cmd ${commandCount} · theme ${themeCount} · set ${settingCount} · ac ${autocompleteCount} · kb ${bindingCount} · ren ${rendererCount} · ed ${editorCount}`,
    ),
  })
  // The capability row must reflect the REAL capability set (round-1
  // finding 1): the live PiTuiApiInfo.capabilities — never a hardcoded
  // or count-inferred list (the registry presence is a separate
  // diagnostic, not a capability claim).
  const api = extensions.api
  const capabilities = api === undefined ? [] : [...api().capabilities].sort()
  rows.push({
    id: 'ext-capabilities',
    label: color.textDim('Capabilities'),
    description: 'The host extension capabilities (feature-detect, never parse versions)',
    currentValue: color.textDim(capabilities.length === 0 ? 'none' : capabilities.join(' · ')),
  })
  // The registry-type diagnostic (separate from capabilities — a
  // registry with live contributions is a FACT, not a capability).
  const registryTypes = [
    commandCount > 0 ? 'commands' : '',
    themeCount > 0 ? 'themes' : '',
    settingCount > 0 ? 'settings' : '',
    autocompleteCount > 0 ? 'autocomplete' : '',
    bindingCount > 0 ? 'keybindings' : '',
    rendererCount > 0 ? 'renderers' : '',
    editorCount > 0 ? 'editors' : '',
  ].filter(Boolean)
  rows.push({
    id: 'ext-registries',
    label: color.textDim('Registries'),
    description: 'Live registries with contributions (diagnostic, not capabilities)',
    currentValue: color.textDim(registryTypes.length === 0 ? 'none' : registryTypes.join(' · ')),
  })
  // P1-08: the live health row — failed/shadowed contributions with their
  // last error, across EVERY registry (incl. transcript renderers). A
  // healthy surface shows 'all active'; failures are surfaced verbatim
  // (single-line, bounded — the ledger's error policy).
  const failed = healthRecords.filter(record => record.state !== 'active')
  rows.push({
    id: 'ext-health',
    label: color.textDim('Health'),
    description: 'Live contribution states (failed/shadowed + last error; recovery clears)',
    currentValue: failed.length === 0
      ? color.textDim('all active')
      : failed.map(record =>
          `${record.extensionPoint}:${record.id} ${record.state}${record.lastError === undefined ? '' : ` — ${record.lastError}`}`,
        ).join(' · '),
  })
  return rows
}

/** Build the merged /login picker rows: reference targets (the API-key
 * path) keep their configured/available/custom groups, prefixed with the
 * `API key` category so the two credential planes are visible at a glance
 * (the fork renders a non-interactive header row per group); authorization
 * targets (the provider sign-in path) get their own group, and the Add New
 * Platform action row is pinned last. Authorization row values carry the
 * AUTH_VALUE_PREFIX so they can never collide with a route. */
function mergedPickerRows(merged: readonly LoginTarget[]): PickerItem[] {
  const rows: PickerItem[] = []
  const groupLabels: Record<string, string> = {
    configured: 'API key · configured',
    available: 'API key · available',
    custom: 'API key · custom',
    authorization: 'sign in with provider',
  }
  for (const target of merged) {
    if (target.kind === 'reference') {
      const group = target.configured ? 'configured' : target.declared ? 'custom' : 'available'
      rows.push({
        value: target.route,
        label: `${target.label} (${target.ref})`,
        group: groupLabels[group],
      })
    } else {
      rows.push({
        value: AUTH_VALUE_PREFIX + target.key,
        label: target.inFlight ? `${target.label} — sign-in in progress` : `${target.label} — sign in`,
        group: groupLabels.authorization,
      })
    }
  }
  rows.push({ value: ADD_PROVIDER_VALUE, label: '[ Add New Platform ]' })
  return rows
}

/** Recover an authorization target from a picked row value (the marker
 * prefix guarantees no collision with reference route values). */
function targetFromPickerValue(merged: readonly LoginTarget[], value: string): AuthorizationTarget | undefined {
  if (!value.startsWith(AUTH_VALUE_PREFIX)) return undefined
  const key = value.slice(AUTH_VALUE_PREFIX.length)
  for (const target of merged) {
    if (target.kind === 'authorization' && target.key === key) return target
  }
  return undefined
}

/** One-line summary of every merged target, for the unknown-target error. */
function mergedTargetsSummary(merged: readonly LoginTarget[]): string {
  return merged.map(target => target.kind === 'reference'
    ? `${target.label} (${target.ref})`
    : `${target.label} (provider sign-in)`).join(', ')
}

/**
 * Run one authorization attempt on the port and report it. Method picking
 * (single method → direct; multiple → a picker) is a client concern; the
 * attempt itself is EVENT-DRIVEN (migration M1.9): the port emits detached
 * notice/prompt events and the TUI answers through `respond`/`cancel` —
 * no callback-bearing interaction ever crosses the contract. On success, a
 * catalog route that is not configured yet gets a minimal keyless profile
 * so the runtime keeps reading the credential record (§12.1 — never an
 * apiKeyEnv, which would switch the request path back to a reference that
 * is not set).
 */
async function runAuthorizationLogin(
  app: TuiApp,
  runner: TuiCommandRunner,
  target: AuthorizationTarget,
  options: readonly CredentialProviderOption[],
): Promise<CommandResult> {
  const authorization = runner.config.authorization
  if (!authorization.available()) return { kind: 'error', text: 'authorization service unavailable' }
  if (target.inFlight) return { kind: 'error', text: `sign-in already in progress for ${target.label}` }
  let method = target.methods[0]?.id
  if (method === undefined) return { kind: 'error', text: `no sign-in method available for ${target.label}` }
  if (target.methods.length > 1) {
    const picked = await new Promise<string | undefined>((resolve) => {
      app.openPicker(
        target.methods.map(candidate => ({ value: candidate.id, label: candidate.label })),
        (value) => resolve(value),
        () => resolve(undefined),
        { header: `Sign in method · ${target.label}`, enableSearch: false },
      )
    })
    if (picked === undefined) return { kind: 'error', text: 'login cancelled' }
    method = picked
  }
  // The client flow driver renders notices and prompts and answers them
  // through the port (never a callback across the contract). The
  // subscription is registered BEFORE begin so no early event (a settled
  // outcome can land in the same microtask turn) is ever missed; the
  // flow is BOUND to the attempt id once begin returns, so a concurrent
  // login's events can never be consumed by this flow. The whole attempt
  // is wrapped in try/finally: a throwing begin (or any failure) still
  // unsubscribes and closes the UI — no leaked listener or panel.
  const flow = createAuthorizationFlow(app, authorization)
  const off = authorization.onEvent(flow.onEvent)
  try {
    let started: { kind: 'started'; attemptId: string } | { kind: 'unavailable' }
    try {
      started = await authorization.begin({ key: target.key, method, signal: runner.signal })
    } catch (error) {
      // A begin that REJECTED (or threw synchronously) before any attempt
      // existed is a failed login, not a crash: map it like any other
      // attempt failure. The finally below still unsubscribes and closes
      // the flow UI — no leaked listener or panel.
      if (runner.signal.aborted) return { kind: 'error', text: 'login cancelled' }
      return { kind: 'error', text: authorizationFailureText(error, safeErrorMessage(error)) }
    }
    if (started.kind !== 'started') {
      return { kind: 'error', text: 'authorization service unavailable' }
    }
    flow.bind(started.attemptId)
    // The wait RACES the runner signal: a provider that ignores its abort
    // signal must never hang the command on an outcome that never settles
    // (the adapter already withdrew the prompt bridges on the abort — the
    // UI is closed either way). Whichever finishes first wins; the
    // listener is removed on every path.
    const outcome = await new Promise<{ status: 'authorized' | 'cancelled' | 'failed'; code?: string; message?: string }>((resolve) => {
      let done = false
      const finish = (value: { status: 'authorized' | 'cancelled' | 'failed'; code?: string; message?: string }): void => {
        if (done) return
        done = true
        runner.signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = (): void => finish({ status: 'cancelled' })
      flow.outcome.then(finish, () => finish({ status: 'failed', message: 'login failed' }))
      if (runner.signal.aborted) {
        finish({ status: 'cancelled' })
        return
      }
      runner.signal.addEventListener('abort', onAbort, { once: true })
    })
    if (outcome.status === 'cancelled' || runner.signal.aborted) return { kind: 'error', text: 'login cancelled' }
    if (outcome.status === 'failed') {
      if (outcome.code === 'NOT_COMMITTED') {
        // A provider flow bug/abnormality: worth a diagnostic line.
        runner.diag.error('authorization', { key: target.key, error: outcome.message })
      }
      return { kind: 'error', text: authorizationFailureText({ code: outcome.code }, outcome.message ?? 'login failed') }
    }
    const profileNote = await provisionKeylessProfile(runner, target, options)
    return { kind: 'success', text: `signed in to ${target.label}${profileNote}` }
  } finally {
    off()
    flow.close()
  }
}

/**
 * After a successful authorization, write a MINIMAL keyless profile for a
 * catalog route that is not configured yet (§12.1). The record alone does
 * not make the route selectable — llm-pi-ai registers a route only when
 * its settings section names it — and the profile must NOT carry
 * apiKeyEnv, or the request path would switch back to a reference that was
 * never set. Hand-declared/custom routes are left to the add wizard
 * (§12.2). Any failure degrades silently (the sign-in itself succeeded).
 * @returns a user-facing note, or '' when nothing was provisioned.
 */
async function provisionKeylessProfile(
  runner: TuiCommandRunner,
  target: AuthorizationTarget,
  options: readonly CredentialProviderOption[],
): Promise<string> {
  if (target.route === undefined) return ''
  const option = options.find(candidate => candidate.route === target.route)
  // The option's SEMANTIC flag decides whether a keyless write could ever
  // be accepted (a writable slot exists) — the schema facts behind it
  // (namespace/path) stay inside the adapter; a Remote adapter computes
  // the same flag from the wire.
  if (option === undefined || option.configured || option.declared || !option.canProvisionProfile) return ''
  if (!runner.config.providers.available()) return ''
  try {
    // The adapter resolves the route's profile location internally —
    // only the ROUTE crosses (migration M1.9: no settings schema in the
    // command surface). The outcome is EXPLICIT: only a real write is
    // presented as "recorded"; a directory race or hostile layout is a
    // SKIP (never a fake success, never a fallback guess).
    const outcome = await runner.config.providers.writeKeylessProfile(option.route)
    return outcome.kind === 'written' ? ' — provider profile recorded' : ''
  } catch (error) {
    runner.diag.warn('authorization', { key: target.key, note: 'profile write failed', error: safeErrorMessage(error) })
    return ''
  }
}

/** The credential surface /logout's picker needs — the config port's
 * credentials sub-interface (presence-only reads). */
type LogoutCredentialsLike = Pick<import('./runtime/config-port.ts').CredentialConfig, 'listRecords' | 'describeReference'>

/** Value prefixes for the /logout picker rows (no collision with a ref). */
const LOGOUT_REF_VALUE = '\u0000ref:'
const LOGOUT_RECORD_VALUE = '\u0000record:'

/** Build the /logout picker rows: every stored credential record plus every
 * configured reference (presence only — a secret's value never leaves the
 * credentials service). Records are deduplicated by key and labelled with
 * the authorization flow's user-facing name when one owns the key (a
 * record row must say what signing out actually clears). */
async function logoutPickerRows(
  credentials: LogoutCredentialsLike,
  options: readonly CredentialProviderOption[],
  targets: readonly AuthorizationTarget[],
): Promise<PickerItem[]> {
  const rows: PickerItem[] = []
  const seenRefs = new Set<string>()
  for (const option of options) {
    if (seenRefs.has(option.ref)) continue
    seenRefs.add(option.ref)
    try {
      const info = await credentials.describeReference(option.ref)
      if (info.configured) {
        rows.push({ value: LOGOUT_REF_VALUE + option.ref, label: `${option.label} (${option.ref})`, group: 'API keys' })
      }
    } catch {
      // A throwing describe degrades to "not configured".
    }
  }
  const records = await credentials.listRecords()
  const seenKeys = new Set<string>()
  for (const record of records) {
    if (seenKeys.has(record.key)) continue
    seenKeys.add(record.key)
    const owner = targets.find(target => target.key === record.key)
    const label = owner !== undefined
      ? `${owner.label} — stored credential${record.kind === undefined ? '' : ` (${record.kind})`}`
      : `${record.key}${record.kind === undefined ? '' : ` (${record.kind})`}`
    rows.push({ value: LOGOUT_RECORD_VALUE + record.key, label, group: 'stored credentials' })
  }
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
  runner: TuiCommandRunner,
  app: TuiApp,
  signal: AbortSignal,
  prefilledRoute?: string,
): Promise<AddProviderOutcome> {
  const credentials = runner.config.credentials
  const providers = runner.config.providers
  if (!credentials.available() || !providers.available()) {
    // The settings service and the llm-pi-ai namespace must exist to persist a
    // hand-declared profile; without them the add cannot complete. This is a
    // capability failure, not a user cancellation.
    return { kind: 'error', text: 'adding a provider needs the settings service, which is unavailable' }
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
  try {
    discovered = await runner.catalog.models.discoverModels({
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
  // parity: a keyless route keeps provider-native auth). The two writes are
  // reported separately: a persisted profile with a failed key write (e.g.
  // the reference is shadowed read-only by the environment) must say the
  // provider WAS added and only the key failed, not claim the whole add
  // failed.
  const ref = deriveKeyRef(routeValue)
  const profile: Record<string, unknown> = {
    ...displayName === routeValue ? {} : { displayName },
    api,
    baseURL,
    models: allModels.map(id => ({ id })),
    ...key === '' ? {} : { apiKeyEnv: ref },
  }
  try {
    await providers.writeProfile(routeValue, profile)
  } catch (error) {
    return { kind: 'error', text: `could not add provider: ${safeErrorMessage(error)}` }
  }
  if (key !== '') {
    try {
      await credentials.setReference(ref, key)
    } catch (error) {
      return { kind: 'error', text: `provider ${routeValue} added, but storing the key failed: ${safeErrorMessage(error)}` }
    }
  }
  return {
    kind: 'ok',
    text: key === ''
      ? `provider ${routeValue} added (no key; provider-native authentication)`
      : `API key ${ref} set · provider ${routeValue} added`,
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

/** Keep USER-owned Custom Text definitions out of whole-document writes that
 * start from a merged settings document. A project layer may contribute the
 * pass-through `footerCustomItems` field, but it must never be copied into
 * USER settings merely because an unrelated setting changed. The raw USER
 * value is intentional here: parsed runtime items would erase unknown/future
 * definitions during a downgrade or a fail-soft read. */
function withUserFooterCustomItems(doc: TuiSettingsDoc, config: ConfigPort): TuiSettingsDoc {
  const raw = config.footerCustomItems.rawForPersistence()
  if (raw.kind === 'unavailable') throw new Error('custom footer definitions unavailable; settings write aborted')
  return { ...doc, footerCustomItems: raw.value }
}

/**
 * Merge an intentional `/footer` save into the detached USER raw collection.
 * The editor owns every recognized v1 text definition: an existing known id
 * is replaced by its validated draft, and a missing known id is a deliberate
 * delete. Entries this client cannot parse (future kinds or future fields)
 * remain unchanged in their original slots so opening and saving the
 * current UI does not destroy definitions owned by a newer client.
 */
function mergeFooterCustomItemsForSave(raw: unknown, saved: readonly FooterCustomItemSettings[]): readonly unknown[] {
  if (!Array.isArray(raw)) return saved.map(item => ({ ...item }))
  const savedById = new Map(saved.map(item => [item.id, item] as const))
  const emittedKnown = new Set<string>()
  const result: unknown[] = []
  for (const candidate of raw) {
    const known = parseFooterCustomItem(candidate)
    if (known !== undefined) {
      const replacement = savedById.get(known.id)
      if (replacement !== undefined && !emittedKnown.has(known.id)) {
        result.push({ ...replacement })
        emittedKnown.add(known.id)
      }
      continue
    }
    // An explicitly-created v1 item wins an id collision with a future
    // definition; otherwise preserving both would make the raw collection
    // ambiguous to the newer owner.
    const candidateId = typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
      ? (candidate as { id?: unknown }).id
      : undefined
    if (typeof candidateId !== 'string' || !savedById.has(candidateId)) result.push(candidate)
  }
  for (const item of saved) {
    if (!emittedKnown.has(item.id)) result.push({ ...item })
  }
  return result
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
  const commands = runner.commandRegistry
  const recordExtensionError = runner.recordExtensionError
  const clearExtensionError = runner.clearExtensionError
  const captureExtensionHealthRef = runner.captureExtensionHealthRef
  // The commands service is part of the base layer; its absence means the
  // TUI commands cannot be registered at all — the caller surfaces this.
  if (commands === undefined) throw new Error('commands service unavailable')

  /** The EFFECTIVE key label for user-facing descriptions (plan §18): a
   * remap updates every row; a disabled action shows a neutral dash. */
  const keyHint = (id: AppKeybindingId): string => {
    const hint = app.keybindingsManager().keyHint(id)
    return hint === '' ? '—' : hint
  }

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
  /** Build the one editor used by /keybindings and the /settings submenu.
   * The settings row is only a launcher; all reads/writes still go through
   * the controller and the same panel state machine. */
  const createKeybindingEditorPanel = (
    onClose: () => void,
    onModelChange: (model: KeybindingEditorModel) => void = () => {},
  ): KeybindingEditorPanel | undefined => {
    const settings = runner.tuiSettings
    if (settings === undefined) return undefined
    const controller = new KeybindingEditorController({
      settings,
      manager: app.keybindingsManager(),
      projectSettingsForWrite: doc => withUserFooterCustomItems(doc, runner.config),
      onDiagnostic: diagnostic => runner.diag.debug('keybinding configuration', { error: diagnostic }),
    })
    let panel: KeybindingEditorPanel | undefined
    try {
      const model = controller.readModel()
      let unregister = (): void => {}
      panel = new KeybindingEditorPanel({
        model,
        onClose,
        onModelChange,
        onDispose: () => unregister(),
        maxRows: () => app.keybindingEditorMaxRows(),
        requestRender: () => app.requestRender(),
        runMutation: (mutation, onResult, onError) => {
          runOwned('keybinding editor mutation', () => controller.mutate(mutation), {
            diag: runner.diag,
            sessionId: () => runner.liveAgent?.session.id,
            onResult,
            onError,
          })
        },
      })
      unregister = app.trackKeybindingEditor(panel)
      return panel
    } catch (error) {
      app.notify(`Could not open keyboard shortcuts: ${safeErrorMessage(error)}`, 'error')
      return undefined
    }
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
  /** Slash commands whose single argument is a path: the fork's
   * `getArgumentCompletions` extension point completes it against the
   * Client-local cwd (natural typing shows candidates, Tab accepts them).
   * Host session cwd remains reserved for `@` via HostFilePort. */
  const PATH_ARGUMENT_COMMANDS = FILE_ARGUMENT_COMMANDS
  /**
   * Install one completion list (sorted, claims refreshed). The single
   * synchronous seam every catalog commit funnels through.
   */
  const installCompletions = (entries: readonly SurfaceCommandSummary[]): void => {
    const sorted = [...entries].sort((left, right) => left.name < right.name ? -1 : 1)
    // M5: the plugin autocomplete chain (AutocompleteRegistry) is consulted
    // after the host's own provider returns null. The registry's suggest()
    // handles cancellation (latest-only commit) and per-provider isolation.
    const extensionAutocomplete = runner.extensions?.autocomplete
    app.setCommandCompletions(
      sorted.map(command => ({
        name: command.name,
        description: command.description,
        argumentHint: command.input?.hint,
        ...(PATH_ARGUMENT_COMMANDS.has(command.name)
          ? { getArgumentCompletions: (argument: string) => suggestPathArgument(argument, runner.cwd) }
          : {}),
      })),
      runner.sessionCwd(),
      // The Host-file port owns the `@`-mention discovery (migration
      // M1.10) — the command surface never resolves fd itself.
      runner.hostFile,
      extensionAutocomplete === undefined
        ? undefined
        : async (query) => {
            const result = await extensionAutocomplete.suggestOwned(query, (id, owner, error) => {
              recordExtensionError?.({ slot: 'autocomplete', id, owner }, error)
              try {
                ctx.logger.warn(`tui-runner: autocomplete provider ${id} failed: ${safeErrorMessage(error)}`)
              } catch {
                // The cordis logger must not block completion.
              }
            }, (id, owner) => clearExtensionError?.({ slot: 'autocomplete', id, owner }))
            if (result === null) return null
            return { items: [...result.items], prefix: result.prefix }
          },
      // The completion scope is resolved at SUGGESTION time from the LIVE
      // agent (session identity when one exists — even mid-transition —
      // the workspace cwd otherwise): a session switch or first create is
      // picked up immediately, never requiring a reinstall.
      () => runner.liveAgent === undefined
        ? { kind: 'workspace', cwd: runner.sessionCwd() }
        : { kind: 'session', sessionId: runner.liveAgent.session.id },
      // `/image` is Client-local. Direct mode uses the process cwd; a remote
      // adapter can keep this independent from the Host session scope.
      () => runner.cwd,
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

  /**
   * Register one TUI command plus its aliases (kimi parity: an alias is
   * another NAME of the same logical command). Every alias registers with
   * the host commands service — the shared handler by default, or its own
   * handler when the alias keeps a fast path (e.g. /resume's direct-resume
   * lookup) — so host dispatch, the completion catalog (aliases are
   * searchable: typing `resume` completes `/resume`) and the busy-Enter
   * gate all see it, while the command surface lists one logical command
   * and the docs mark the alias.
   * @param spec - the primary command; `aliases` register with the shared
   *   handler unless `aliasHandlers` overrides one.
   */
  const registerTuiCommand = (spec: {
    name: string
    description: string
    aliases?: readonly string[]
    input?: { hint: string }
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
    aliasHandlers?: Record<string, (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>>
  }): void => {
    commands.register({
      name: spec.name,
      description: spec.description,
      ...(spec.input === undefined ? {} : { input: spec.input }),
      handler: spec.handler,
    })
    for (const alias of spec.aliases ?? []) {
      const handler = spec.aliasHandlers?.[alias] ?? spec.handler
      commands.register({
        name: alias,
        description: `${spec.description} (alias of /${spec.name})`,
        ...(spec.input === undefined ? {} : { input: spec.input }),
        handler,
      })
    }
  }

  // Shared by /exit and its /quit alias. The exit orchestration lives in
  // the runner (createExitController): flush with a hard timeout, idempotent
  // cleanup, warning, resume hint, process exit. Handlers never stop the app
  // or flush themselves — that kept /exit diverging from Ctrl+C/Ctrl+D (no
  // timeout, no catch, no warning) and could hang a stopped UI forever.
  const exitHandler = (): { kind: 'success' } => {
    runner.requestExit()
    return { kind: 'success' }
  }

  registerTuiCommand({
    name: 'exit',
    description: 'Quit the terminal UI (flush and exit)',
    aliases: ['quit'],
    handler: exitHandler,
  })

  commands.register({
    name: 'settings',
    description: 'Open the TUI settings panel',
    handler: () => {
      const liveAgent = runner.liveAgent
      const tuiSettings = runner.tuiSettings
      let settingsDoc: TuiSettingsDoc | undefined
      if (tuiSettings !== undefined) {
        try {
          settingsDoc = tuiSettings.get()
        } catch (error) {
          // A present but temporarily unreadable settings service must degrade
          // to the same unavailable keyboard-shortcuts fallback as absence.
          runner.diag.warn('settings read failed', { error: safeErrorMessage(error) })
        }
      }
      const theme = settingsDoc?.theme ?? 'auto'
      // The DISPLAYED current theme: the friendly name (the persisted
      // value may still be the legacy `custom:<name>` / bare-name form —
      // the display derives from it, the /settings handler reads and
      // writes SOURCE-QUALIFIED values).
      const themeDisplayName = themeDisplayNameOf(theme, runner.extensions?.themes)
      // The autodetect guard reads THIS synchronous "latest choice", never
      // the persisted doc: the settings write is asynchronous, so at the
      // moment an OSC 11 reply lands the doc may still hold the PREVIOUS
      // theme — a doc-based guard would wrongly refuse a just-selected
      // `auto` (and wrongly apply over a just-selected explicit theme).
      // The choice is the SOURCE-QUALIFIED IDENTITY (normalized — a legacy
      // `custom:X` doc value becomes `file:X`), never a display label: the
      // submenu's `← current` marker compares this identity against the
      // live row values (the review's P3 — the current-state identity must
      // not be a display string a dynamic same-named source can mimic).
      let lastThemeChoice = normalizePersistedTheme(theme)
      // The permission-presets service owns the composed preset table and the
      // persisted default for new sessions (settings namespace 'permission').
      // Both panel rows degrade gracefully when the service is absent.
      const permissions = runner.config.permissions
      const permissionNames: string[] = [...permissions.presetNames()]
      const defaultPermission = permissions.defaultPreset()
      // Before the first session (deferred start) the session-scoped rows —
      // approval policy and the read-only session facts — do not exist yet;
      // everything process-wide stays available.
      const keyboardShortcutsRow: SettingItem = {
        id: 'keyboard-shortcuts',
        label: 'Keyboard shortcuts',
        description: 'Browse and customize action shortcuts, leader keys, and conflict-safe bindings',
        currentValue: 'Unavailable',
      }
      if (runner.tuiSettings !== undefined && settingsDoc !== undefined) {
        try {
          const model = new KeybindingEditorController({
            settings: runner.tuiSettings,
            manager: app.keybindingsManager(),
          }).readModel()
          keyboardShortcutsRow.currentValue = model.summary
        } catch {
          keyboardShortcutsRow.currentValue = 'Unavailable'
        }
      }
      keyboardShortcutsRow.submenu = (_currentValue, done) => createKeybindingEditorPanel(
        done,
        model => {
          keyboardShortcutsRow.currentValue = model.summary
        },
      ) ?? new KeybindingEditorUnavailablePanel(done)
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
            description: `Preset new sessions start with (persisted; ${keyHint('app.permission.cycle')} cycles this session)`,  // keysLabel? no — keyHint
            currentValue: defaultPermission ?? permissionNames[0] ?? '',
            values: permissionNames,
          }] : [],
          {
            id: 'theme',
            label: 'Theme',
            description: 'Palette: auto follows the terminal; custom from ~/.dsh-pi-tui/themes',
            // M5: plugin-registered themes (ThemeRegistry) join the
            // picker's built-in auto/dark/light + custom list. The theme
            // row DISPLAYS the friendly name; the picker is an in-place
            // submenu (the fork's SettingItem.submenu slot — the /model
            // pattern) whose row ids ARE the SOURCE-QUALIFIED selectable
            // values (`auto|dark|light`, `file:<name>`,
            // `plugin:<owner>/<id>` — the review's P2: a plugin theme must
            // never share the value namespace of a custom FILE of the same
            // name, and the identity is carried end-to-end, never
            // round-tripped through the display label). The submenu
            // receives the runner's own synchronous `lastThemeChoice`
            // IDENTITY (never the fork's outer currentValue — that string
            // is the FRIENDLY DISPLAY, purely presentational after the
            // updateValue rewrite, and a display-label comparison would
            // let a same-named row from ANOTHER source steal the
            // `← current` marker — the review's P3). A re-open after a
            // successful pick sees the committed identity; a FAILED pick
            // keeps the previous one.
            currentValue: themeDisplayName,
            submenu: (_currentValue, done) => new ThemeSubmenu(lastThemeChoice, runner.extensions?.themes, (picked) => {
              if (picked !== undefined) done(picked)
              else done()
            }),
          },
          {
            id: 'icon-style',
            label: 'Icon style',
            description: 'Choose between emoji, compact symbols, or minimal structural markers',
            // The fallback applies HERE too: an invalid/missing persisted
            // value must never render as a row outside the values list.
            currentValue: iconStyleOf(settingsDoc?.iconStyle),
            values: ['emoji', 'symbols', 'minimal'],
          },
          {
            id: 'expand',
            label: 'Tool output',
            description: 'Whether recent tool/system entries start expanded',
            currentValue: app.isToolOutputExpanded() ? 'expanded' : 'collapsed',
            values: ['collapsed', 'expanded'],
          },
          {
            id: 'thinking',
            label: 'Thinking detail',
            description: 'Default detail level for reasoning blocks; blocks stay visible',
            currentValue: app.isThinkingExpanded() ? 'expanded' : 'collapsed',
            values: ['collapsed', 'expanded'],
          },
          {
            id: 'footer',
            label: 'Status line',
            description: 'Footer layout: default (full), compact (stats line hidden), or custom (see /footer)',
            currentValue: app.getFooterMode(),
            values: ['default', 'compact', 'custom'],
          },
          {
            id: 'busy-enter',
            label: 'Submit while busy',
            description: `Steer injects the draft into the running turn; ${keyHint('app.input.queue')} uses the other behavior`,
            currentValue: settingsDoc?.busyEnter ?? 'queue',
            values: ['queue', 'steer'],
          },
          {
            id: 'local-shell-sandbox',
            label: 'Local shell sandbox',
            description: '! / !! commands run outside the dsh sandbox (bypass, default) or under the sandbox policy',
            currentValue: settingsDoc?.localShellSandbox ?? 'bypass',
            values: ['bypass', 'sandbox'],
          },
          {
            id: 'home-end-keys',
            label: 'Home/End keys',
            description: 'Input: Home/End move within the input; Ctrl+Home/End scroll the conversation. Viewport: Home/End scroll the conversation; Ctrl+Home/End move within the input',
            // The fallback applies HERE too: an invalid persisted value
            // must never render as a row outside the values list (round-1
            // finding).
            currentValue: homeEndKeysModeOf(settingsDoc?.homeEndKeys),
            values: ['input', 'viewport'],
          },
          {
            id: 'focus-mode',
            label: 'Focus mode',
            description: 'Collapse intermediate activity into a live Thought block; click to reveal the full turn',
            currentValue: runner.focusEnabled() ? 'on' : 'off',
            values: ['off', 'on'],
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
          keyboardShortcutsRow,
          // ── M5: plugin-registered settings rows ───────────────────
          ...(runner.extensions?.settings.rows() ?? []).map(row => ({
            id: `ext-setting:${row.id}`,
            label: row.label,
            description: row.description,
            currentValue: row.currentValue,
            ...(row.values.length > 0 ? { values: [...row.values] } : {}),
          })),
        ],
        (id, value, revert) => {
          if (id === 'approval') {
            if ((value === 'ask' || value === 'never') && liveAgent !== undefined) {
              runner.interaction.setApprovalPolicy(liveAgent.session.id, value)
              // The footer's permission badge derives from the knob folds;
              // reflect the change immediately.
              runner.refreshStatus()
            }
          } else if (id === 'default-permission') {
            if (permissionNames.includes(value)) {
              detach('permission default write', () => runner.config.permissions.setDefaultPreset(value) as Promise<unknown>, { notify: true })
            }
          } else if (id === 'theme') {
            // The submenu fires onChange with the SOURCE-QUALIFIED selectable
            // value DIRECTLY (the row id IS the identity — the review's P2:
            // no display-label round-trip, so an HMR unload between open
            // and confirm can never redirect the selection to a same-named
            // new contribution). The value is applied and persisted as-is.
            //
            // TRANSACTIONAL CHOICE COMMIT (the review's P2): the fork's
            // SettingsList already wrote the RAW selected value into the
            // outer row BEFORE this callback runs, so a FAILED selection
            // (the contribution unloaded between open and confirm — the
            // HMR window — or an apply error) must roll the visible row
            // AND `lastThemeChoice` back to the previous choice. A failed
            // pick can never fake a current selection (the next re-open
            // would mark a row that was never applied) and can never steal
            // an in-flight `auto` detection whose guard reads
            // `lastThemeChoice`.
            const qualified = value
            if (qualified !== undefined) {
              const previousChoice = lastThemeChoice
              // SUCCESS only: persist the choice, commit it, and rewrite
              // the fork's raw write back to the FRIENDLY label (the
              // openSettings updateValue seam — the row must never show a
              // raw `plugin:owner/id`, and a re-open must mark the right
              // row). EVERY branch persists through here — builtins
              // included (the review's P1: moving the write inside the
              // file/plugin branch would silently stop persisting
              // auto/dark/light and the next start would restore the old
              // theme).
              const commit = (): void => {
                const settings = tuiSettings
                if (settings !== undefined) {
                  // Spread the current doc: a replace is wholesale, so the
                  // other preference keys must ride along. The persisted
                  // value IS the source-qualified identity.
                  detach('settings theme write', () => serializeTuiSettingsMutation(
                    settings,
                    () => settings.replace(withUserFooterCustomItems({ ...settings.get(), theme: qualified }, runner.config)),
                  ), { notify: true })
                }
                lastThemeChoice = qualified
                revert(themeDisplayNameOf(qualified, runner.extensions?.themes))
              }
              // FAILURE only: restore the PREVIOUS choice's friendly
              // display; `lastThemeChoice` stays untouched.
              const rollback = (): void => {
                revert(themeDisplayNameOf(previousChoice, runner.extensions?.themes))
              }
              if (qualified === 'auto') {
                // The settled detection applies only while the preference is
                // STILL auto — a late result must never override a theme the
                // user picked while the query was in flight (rapid cycling).
                // The guard reads the synchronous lastThemeChoice, NOT the
                // persisted doc (whose write is asynchronous and may lag the
                // query settlement by hundreds of ms). `auto` has no
                // fallible apply step (starting the detection IS the
                // apply): the choice commits BEFORE the query starts, so
                // the guard already sees the new choice if a reply raced
                // in synchronously.
                app.clearActivePluginTheme()
                commit()
                detach('theme autodetect', () => app.autoDetectTheme({
                  shouldApply: () => lastThemeChoice === 'auto',
                }))
                app.trackTerminalTheme(true)
              } else if (qualified === 'dark' || qualified === 'light') {
                try {
                  app.clearActivePluginTheme()
                  app.applyTheme(qualified)
                  app.trackTerminalTheme(false)
                } catch (error) {
                  app.notify(`theme ${value} failed: ${safeErrorMessage(error)}`, 'error')
                  rollback()
                  return
                }
                commit()
              } else {
                // M5: a plugin-registered theme applies through the host's
                // applyPalette (the ONLY application path — the registry
                // never applies itself). Custom files resolve as before.
                // SOURCE-QUALIFIED resolution (the review's P2): a `file:`
                // value resolves the FILE, a `plugin:` value resolves the
                // registry — a bare name can never be a selection identity.
                const selection = resolveThemeSelection(qualified, runner.extensions?.themes)
                // VALUE-addressed (the unified theme protocol — the health
                // bridge resolves the selectable value only).
                const themeRef = captureExtensionHealthRef?.('theme', qualified)
                if (selection === undefined) {
                  // A stale selection (the source unloaded between open and
                  // confirm): notify, record health, roll the row AND the
                  // choice back — never commit.
                  if (themeRef !== undefined) recordExtensionError?.(themeRef, new Error('theme not found'))
                  app.notify(`theme ${value} not found`, 'error')
                  rollback()
                  return
                }
                try {
                  // A PLUGIN palette records the selection (the unload
                  // fallback restores builtin dark when it disappears);
                  // a custom FILE clears it.
                  if (selection.kind === 'plugin') app.applyPluginPalette(selection.value, selection.palette)
                  else {
                    app.clearActivePluginTheme()
                    app.applyPalette(selection.palette)
                  }
                  if (themeRef !== undefined) clearExtensionError?.(themeRef)
                  app.trackTerminalTheme(false)
                } catch (error) {
                  if (themeRef !== undefined) recordExtensionError?.(themeRef, error)
                  app.notify(`theme ${value} failed: ${safeErrorMessage(error)}`, 'error')
                  rollback()
                  return
                }
                commit()
              }
            }
          } else if (id.startsWith('ext-setting:')) {
            // M5: a plugin-registered settings row change. The row's own
            // onChange decides acceptance; the panel value follows the
            // accepted value. Detached (AGENTS.md — never a bare void).
            // The fork optimistically mutated the row BEFORE this callback:
            // on rejection, revert() restores the previous DISPLAYED value
            // so the open panel never shows a value the registry rejected.
            const extSettings = runner.extensions?.settings
            const settingId = id.slice('ext-setting:'.length)
            const previous = extSettings?.rows().find(row => row.id === settingId)?.currentValue
            if (extSettings !== undefined) {
              // Captured BEFORE the async apply starts: an HMR reload may
              // replace this id with a new owner while onChange is in
              // flight — the settlement must report against the INVOKING
              // owner, never the reloaded one (the review's P2 fence).
              const settingRef = captureExtensionHealthRef?.('setting', settingId)
              detach('extension setting apply', () => extSettings.applyDetailed(settingId, value).then(outcome => {
                if (outcome === 'rejected') {
                  // ONLY a real plugin rejection is a failure: record
                  // health, revert the optimistic row and notify. A
                  // 'stale' outcome (a newer apply superseded this one)
                  // or 'gone' (the row was disposed mid-apply) is NOT a
                  // plugin refusal — recording/reverting/notifying would
                  // be a false alarm that rolls the panel back from the
                  // value the user actually sees (the review's P2).
                  if (settingRef !== undefined) recordExtensionError?.(settingRef, new Error('setting rejected'))
                  if (previous !== undefined) revert(previous)
                  app.notify('setting rejected', 'error')
                } else if (outcome === 'accepted') {
                  if (settingRef !== undefined) clearExtensionError?.(settingRef)
                }
              }).catch(error => {
                if (settingRef !== undefined) recordExtensionError?.(settingRef, error)
                throw error
              }))
            }
          } else if (id === 'expand') {
            app.setToolOutputExpanded(value === 'expanded')
          } else if (id === 'thinking') {
            // The declarative surface sets the SHARED bulk preference —
            // `/settings` and Alt+T are the same state (plan §10.4).
            app.setThinkingExpanded(value === 'expanded')
          } else if (id === 'footer') {
            if (value === 'default' || value === 'compact' || value === 'custom') {
              const settings = tuiSettings
              if (settings !== undefined) {
                // footerFallbackMode records the LAST NATIVE mode (M5):
                // `footer` is overwritten by 'command' when the command
                // surface arms, so the command failure fallback must be
                // able to recover THIS choice (a compact user's fallback
                // survives a restart). Read and replace inside the shared
                // transaction so a concurrent whole-document writer cannot
                // be overwritten by this stale panel snapshot.
                // PERSIST FIRST (the configurator's discipline): the app
                // applies only from the successful write — a failed
                // settings write must not leave the live layout ahead of
                // the document (the next reload would silently revert).
                detach('settings footer write', async () => {
                  if (app.isDisposed()) return
                  const next = await serializeTuiSettingsMutation(settings, async () => {
                    if (app.isDisposed()) return undefined
                    const doc = settings.get()
                    // Selecting custom with no (valid) layout initializes an
                    // editable copy of the default layout (plan §14.8).
                    const layout = value === 'custom'
                      ? !isFooterLayout(parseFooterLayout(doc.footerLayout))
                        ? DEFAULT_FOOTER_LAYOUT
                        : doc.footerLayout
                      : doc.footerLayout
                    // Preserve the detached USER value, not a merged/project
                    // projection, while the whole-document write is queued.
                    const raw = runner.config.footerCustomItems.rawForPersistence()
                    if (raw.kind === 'unavailable') throw new Error('custom footer definitions unavailable; settings write aborted')
                    await settings.replace({ ...doc, footer: value, footerLayout: layout, footerFallbackMode: value, footerCustomItems: raw.value })
                    return { layout, customItems: raw.value }
                  })
                  if (app.isDisposed() || next === undefined) return
                  runner.applyFooterSettings({ footer: value, footerLayout: next.layout, footerCustomItems: next.customItems })
                }, { notify: true })
              } else {
                runner.applyFooterSettings({ footer: value })
              }
            }
          } else if (id === 'busy-enter') {
            if (value === 'queue' || value === 'steer') {
              const settings = tuiSettings
              if (settings !== undefined) {
                detach('settings busy enter write', () => serializeTuiSettingsMutation(
                   settings,
                   () => settings.replace(withUserFooterCustomItems({ ...settings.get(), busyEnter: value }, runner.config)),
                 ), { notify: true })
              }
            }
          } else if (id === 'icon-style') {
            if (value === 'emoji' || value === 'symbols' || value === 'minimal') {
              // The visual preference applies FIRST — the UI must not wait
              // for disk persistence (same policy as theme/focus). A
              // persistence failure keeps this session's preference and
              // notifies through the shared error policy; the next start
              // restores the persisted value.
              app.setIconStyle(value)
              const settings = tuiSettings
              if (settings !== undefined) {
                detach('settings icon style write', () => serializeTuiSettingsMutation(
                   settings,
                   () => settings.replace(withUserFooterCustomItems({ ...settings.get(), iconStyle: value }, runner.config)),
                 ), { notify: true })
              }
            }
          } else if (id === 'local-shell-sandbox') {
            if (value === 'bypass' || value === 'sandbox') {
              const settings = tuiSettings
              if (settings !== undefined) {
                detach('settings local shell sandbox write', () => serializeTuiSettingsMutation(
                   settings,
                   () => settings.replace(withUserFooterCustomItems({ ...settings.get(), localShellSandbox: value }, runner.config)),
                 ), { notify: true })
              }
            }
          } else if (id === 'home-end-keys') {
            if (value === 'input' || value === 'viewport') {
              // Issue #9: apply immediately (no restart, no fullscreen
              // round-trip) and persist.
              applyHomeEndKeyMode(value)
              const settings = tuiSettings
              if (settings !== undefined) {
                detach('settings home end keys write', () => serializeTuiSettingsMutation(
                   settings,
                   () => settings.replace(withUserFooterCustomItems({ ...settings.get(), homeEndKeys: value }, runner.config)),
                 ), { notify: true })
              }
            }
          } else if (id === 'focus-mode') {
            if (value === 'off' || value === 'on') {
              // The UNIFIED setter: runtime mutation first, persistence
              // best-effort (plan §7 — never a direct settings write).
              runner.setFocusMode(value === 'on')
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

  // `/footer` — the interactive footer configurator (plan M3): LOCAL +
  // SESSIONLESS (usable before any session exists — the preview shows
  // placeholders/unavailable items and the config stays editable). The
  // panel is a hierarchical editor; S on its Row Selector page validates
  // + persists + applies, Enter is a navigation key, and Esc walks back
  // page by page, closing on the selector without touching the active
  // layout.
  //
  // `/statusline` is a deliberate alias (approved): other agents (and
  // users coming from tools that name this surface "statusline") reach
  // the SAME configurator through it. The name is a PREFIX-neighbor of
  // the existing `/status` command — the AGENTS near-synonym rule usually
  // forbids that, and it stays forbidden for NEW independent commands —
  // but as an EXPLICIT alias of `/footer` the pairing is unambiguous:
  // `/status` keeps priority matching (a bare `status` input always
  // resolves to the session-status command), `/statusline` resolves to
  // the footer configurator, and the completion catalog shows both with
  // the alias marked "(alias of /footer)". The alias rides the same
  // LOCAL/SESSIONLESS ownership sets, so it never steers while busy.
  registerTuiCommand({
    name: 'footer',
    description: 'Configure the footer layout interactively',
    aliases: ['statusline'],
    handler: () => {
      const settings = runner.tuiSettings
      const doc = settings?.get()
      // The configurator starts from the CURRENT EFFECTIVE layout: the
      // persisted custom layout when active, else whatever the composer
      // renders right now — getEffectiveFooterLayout() maps the active
      // MODE (default/compact/custom). The old `getFooterLayout() ??
      // DEFAULT` fallback lost the compact mode: a compact user opening
      // /footer and pressing Enter unchanged would have saved the full
      // two-row default as their custom layout (the review's P2).
      const persisted = doc !== undefined && doc.footer === 'custom' ? parseFooterLayout(doc.footerLayout) : undefined
      const initial = persisted !== undefined && isFooterLayout(persisted)
        ? persisted
        : app.getEffectiveFooterLayout()
      // Layer the draft catalog over the live app registry. Unsaved create /
      // edit / rename / delete operations stay inside this catalog, so Esc
      // cannot mutate the active footer or its persisted definitions.
      const registry = new FooterItemRegistry(app.getFooterItemRegistry())
      const customItems = new FooterCustomItemCatalog(app.getFooterCustomItems())
      registry.setCustomSource(customItems)
      const composer = new FooterComposer(registry)
      const model = new FooterConfiguratorModel(initial, registry, customItems)
      app.openFooterConfigurator({
        model,
        registry,
        composer,
        onSave: (layout, draftCustomItems) => {
          // Validate the draft (the model's operations keep it well-formed,
          // but the persisted value is never trusted).
          const parsed = parseFooterLayout(layout)
          if (!isFooterLayout(parsed)) {
            app.notify(`footer layout invalid: ${parsed.message}`, 'error')
            return
          }
          const customResult = parseFooterCustomItems(draftCustomItems ?? [])
          if (customResult.invalidCount > 0 || customResult.items.length !== (draftCustomItems ?? []).length) {
            app.notify('custom footer items invalid', 'error')
            return
          }
          const savedCustomItems = customResult.items.map(item => ({ ...item }))
          if (settings !== undefined) {
            // Persist FIRST; the memory commit happens only after the
            // settings write succeeds (plan §15.7 — a failed write keeps
            // the old layout and definitions and notifies). footerFallbackMode
            // rides ALONG: the /settings path records the last native mode,
            // and saving a custom layout IS a native-mode change — the command
            // surface's restart fallback must resolve to THIS custom layout.
            detach('footer configurator write', async () => {
              if (app.isDisposed()) return
              await serializeTuiSettingsMutation(settings, async () => {
                if (app.isDisposed()) return
                // `/footer` intentionally edits the custom-definition
                // collection, but it only owns the v1 text entries this client
                // understands. Re-read the detached USER value at the commit
                // point so queued saves do not erase intervening future data.
                const raw = runner.config.footerCustomItems.rawForPersistence()
                if (raw.kind === 'unavailable') throw new Error('custom footer definitions unavailable; settings write aborted')
                const persistedCustomItems = mergeFooterCustomItemsForSave(raw.value, savedCustomItems)
                await settings.replace({
                  ...settings.get(),
                  footer: 'custom',
                  footerFallbackMode: 'custom',
                  footerLayout: parsed,
                  footerCustomItems: persistedCustomItems,
                })
              })
              if (app.isDisposed()) return
              app.setFooterCustomItems(savedCustomItems)
              runner.applyFooterSettings({ footer: 'custom', footerLayout: parsed, footerCustomItems: savedCustomItems }, savedCustomItems)
              app.notify('footer layout saved', 'info')
            }, { notify: true })
          } else {
            app.setFooterCustomItems(savedCustomItems)
            runner.applyFooterSettings({ footer: 'custom', footerLayout: parsed, footerCustomItems: savedCustomItems }, savedCustomItems)
            app.notify('footer layout saved', 'info')
          }
        },
        onCancel: () => {
          // Esc: close without writing (the configurator's live preview
          // never touched the active layout).
        },
      })
      return { kind: 'success' }
    },
  })

  // `/focus` — the Focus Mode control (plan §8): LOCAL + SESSIONLESS (the
  // runner's ownership sets), so it always executes directly — never
  // queued/steered while busy, never sent to the model, and usable before
  // the first session exists (the first real prompt then composes with the
  // Focus section already installed). Every mutation goes through the
  // runner's ONE setter.
  commands.register({
    name: 'focus',
    description: 'Toggle Focus Mode (intermediate activity folds into a live Thought block)',
    input: { hint: '[on|off|toggle|status]' },
    handler: (invocation) => {
      const verb = invocation.rawInput.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
      const enabled = runner.focusEnabled()
      // The command feedback is a transient notify (the same pattern as
      // /reload): a sessionless local command writes no command/done card,
      // so the success text must be surfaced HERE or the toggle would be
      // silent.
      const report = (text: string): { kind: 'success'; text: string } => {
        app.notify(text, 'info')
        return { kind: 'success', text }
      }
      if (verb === '' || verb === 'toggle') {
        runner.setFocusMode(!enabled)
        return report(`Focus mode ${enabled ? 'off' : 'on'}.`)
      }
      if (verb === 'on') {
        if (enabled) return report('Focus mode is on.')
        runner.setFocusMode(true)
        return report('Focus mode on.')
      }
      if (verb === 'off') {
        if (!enabled) return report('Focus mode is off.')
        runner.setFocusMode(false)
        return report('Focus mode off.')
      }
      if (verb === 'status') {
        return report(`Focus mode is ${enabled ? 'on' : 'off'}.`)
      }
      return { kind: 'error', text: `unknown /focus verb "${verb}" (on|off|toggle|status)` }
    },
  })

  // Shared /sessions + /resume body: list lightweight session headers
  // newest-first, open the picker, and enrich effective presets/titles in the
  // background. The header parameter lets the resume alias present itself
  // under its own name.
  const openSessionPicker = async (invocation: { rawInput: string }, header: string): Promise<{ kind: 'success' } | { kind: 'error'; text: string }> => {    // The current marker is the live session's id; before the first session
    // (deferred start) no row is marked current, and the picker can still
    // browse and switch to a persisted session without creating one.
    const currentId = runner.liveAgent?.session.id
    // The session READ port (migration M1.3): live-preferred listing with
    // the persistence fallback lives in the Direct adapter, never here.
    const rows = await runner.sessionReader.list(currentId, signal)
    if (rows === undefined) return { kind: 'error', text: 'session persistence unavailable' }
    if (rows.length === 0) return { kind: 'error', text: 'no persisted sessions' }
    // The picker opens instantly on the headers; titles land in the
    // background below. The category scopes see the FULL row set, so "All
    // directories" really lists every main session (round-1 review finding:
    // the old code capped the rows themselves at MAX_PICKER_SESSIONS).
    // Live title map: the background loader fills it, and the category
    // factories re-read it on every activation (Tab cycle, refresh).
    const titlesById = new Map<string, string>()
    const presetsById = new Map<string, string>()
    const itemFor = (row: SessionPickerRow, indent = 0): SessionPickerItem =>
      sessionPickerItem({
        ...row,
        title: titlesById.get(row.id),
        preset: presetsById.get(row.id) ?? row.preset,
      }, runner.liveAgent?.session.id ?? '', indent)
    // Category tabs (Tab cycles while the picker is open): the session
    // picker is a HUMAN surface, so subagent children never appear in
    // either scope — /tasks and the subagent viewer own that surface now
    // (the 2026-08-22 plan, item 3; kimi's directory-scope direction).
    // Current directory scopes to the live session's workspace (the
    // sessionCwd the whole surface follows); All directories lists every
    // main session, grouped by its workspace.
    const categories = sessionPickerCategories(rows, runner.sessionCwd(), header, itemFor)
    const picker = app.openPicker(
      categories[0]!.items(),
      (id) => {
        if (id === currentId) return
        switchSession(id)
      },
      () => {},
      {
        enableSearch: true,
        header: categories[0]!.header,
        noMatchText: '  no matching sessions',
        initialQuery: invocation.rawInput.trim(),
        width: 76,
        maxHeight: 26,
        showHint: true,
        categories,
        // The selected session's long title marquees; the lineage tree
        // connector and the `●` current marker stay fixed (plan §7.6/§7.7).
        marquee: { labelPartsOf: sessionLabelParts },
      },
    )
    // Enrich rows with titles as they load (progressive: the first
    // TITLE_FIRST_BATCH rows land immediately so the visible window fills,
    // then TITLE_BATCH_SIZE chunks refresh behind it — the picker's own
    // factory re-reads the shared title map). The local cache under
    // $DSH_HOME skips the expensive full-log reads while the log files are
    // unchanged. Cancellations (TUI quit, the abort signal) are debug-level
    // through the unified entry; a real batch failure lands in diagnostics
    // instead of being swallowed.
    //
    // The batches cover MAIN rows only (the categories never show subagents)
    // and the FULL main-row set — NOT the `shown` window: the category scopes
    // see every main session (round-1 review finding), so a session beyond
    // MAX_PICKER_SESSIONS that IS displayed (e.g. an old session in the
    // "Current directory" scope) would otherwise never get a title read and
    // would show a bare short id forever.
    const mainRows = rows.filter(row => row.origin !== 'subagent')
    if (runner.sessionReader.presetBatch !== undefined) {
      detach('session presets', async () => {
        const presets = await runner.sessionReader.presetBatch!(mainRows, signal)
        for (const [id, preset] of presets) presetsById.set(id, preset)
        if (presets.size > 0) picker.refresh?.()
      })
    }
    detach('session titles', async () => {
      const loadBatch = async (batch: SessionPickerRow[]): Promise<void> => {
        const titles = await runner.sessionReader.titles(batch, signal)
        if (titles.size === 0) return
        for (const [id, title] of titles) titlesById.set(id, title)
        picker.refresh?.()
      }
      await loadBatch(mainRows.slice(0, TITLE_FIRST_BATCH))
      for (let offset = TITLE_FIRST_BATCH; offset < mainRows.length; offset += TITLE_BATCH_SIZE) {
        await loadBatch(mainRows.slice(offset, offset + TITLE_BATCH_SIZE))
      }
    })
    return { kind: 'success' }
  }

  registerTuiCommand({
    name: 'sessions',
    description: 'List, search, and switch persisted sessions',
    input: { hint: '[query]' },
    handler: (invocation) => openSessionPicker(invocation, 'sessions'),
    aliases: ['resume'],
    // /resume keeps its direct-resume fast path (exact/prefix id match);
    // without a match it falls back to the same picker under its own name.
    aliasHandlers: {
      resume: async (invocation) => {
        const raw = invocation.rawInput.trim()
        if (raw !== '') {
          // Direct resume: exact id, a session- prefixed prefix, or the short
          // id prefix. Falls back to the picker when nothing matches.
          const currentId = runner.liveAgent?.session.id
          const rows = await runner.sessionReader.list(currentId, signal)
          if (rows !== undefined) {
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
    },
  })

  /** The workspace the live session runs in; fallback to the TUI's cwd. */
  const sessionCwd = (agent: Agent): string => agent.session.header.cwd ?? cwd

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
    // The skill read goes through the catalog port (migration M1.8): the
    // Direct adapter resolves the session's live skill target internally —
    // the loaded definition is a detached DTO, never the registry object.
    const resolved = await runner.catalog.skills.resolveSkill(agent.session.id, name)
    if (resolved.kind === 'unavailable') return { kind: 'error', text: 'skill service unavailable' }
    if (resolved.kind === 'unknown') return { kind: 'error', text: 'unknown skill "' + name + '"' }
    if (resolved.kind === 'malformed') return { kind: 'error', text: `skill "${name}" returned a malformed definition` }
    const skill = resolved.skill
    if (!isUserInvocableSkill(skill)) return { kind: 'error', text: `skill "${name}" is not invocable by the user` }
    // Web parity (the dsh-tool-skill pre-step boundary): a user-explicit
    // skill invocation is a PLAIN user message whose leading `/name` line
    // the host recognizes — the user's own words (including any `/name args`
    // the wrapper was invoked with) always travel as the original text, and
    // the rendered skill body follows as injected instructions context.
    // Arguments are never carved out and never dropped: the bug this fixes
    // was the wrapper discarding `rawInput` and injecting a hand-rolled body
    // card that swallowed the user's request.
    const line = args.trim() === '' ? '/' + skill.name : '/' + skill.name + ' ' + args.trimStart()
    // The skill invocation is an AGENT-FACING prompt: build its message
    // through the shared prepared-input pipeline so an image-bearing
    // `/skill [image #1 ...]` line is a real multimodal prompt, exactly
    // like a plain prompt (review finding 4). The referenced drafts are
    // PINNED across the WHOLE invocation — the async prepare, the steer
    // and the draft consumption — so a concurrent /image prune can never
    // delete images this invocation is still admitting (review finding 1).
    const releasePin = runner.imageStore.pinReferenced(line)
    let userMessage: import('@deepseek-ai/dsh-llm').UserMessage
    try {
      userMessage = await runner.prepareDraftMessage(line)
      // The session-transition write fence (review round 5): while a
      // transition is in flight the old agent may be woken again — a steer
      // in that window would target a session whose lock is about to be
      // released. Refuse WITHOUT injecting the body; the invocation line is
      // restored to the editor (nothing is lost) and the user retries after
      // the transition settles.
      if (runner.sessionTransitionPending()) {
        const merged = mergeDraft(app.getDraft(), line)
        app.setEditorText(merged)
        return { kind: 'error', text: merged === line
          ? 'a session transition is in progress — try again in a moment'
          : 'the draft changed while transitioning — review it before submitting again' }
      }
      // The invocation's own write runs inside the operation barrier
      // (convergence plan phase 3): a transition started while the draft
      // prepared drains it first; a transition already running refuses the
      // write with the standard fence UX (the check above is the quick
      // path, this is the authoritative one).
      try {
        await runner.withSessionWriter(agent.session.id, async () => {
          agent.steer(userMessage)
        })
      } catch (error) {
        if (error instanceof TransitionInProgressError) {
          const merged = mergeDraft(app.getDraft(), line)
          app.setEditorText(merged)
          return { kind: 'error', text: merged === line
            ? 'a session transition is in progress — try again in a moment'
            : 'the draft changed while transitioning — review it before submitting again' }
        }
        throw error
      }
      // The invocation COMMITTED: consume the image drafts it referenced
      // (the prepared message holds the durable refs now; a concurrent
      // intake's newer draft survives — review finding).
      consumeDraftImages(line, runner.imageStore)
    } finally {
      // The pin releases on EVERY exit — including a synchronous steer
      // throw (review finding: a leaked pin would block pruning and eat
      // draft capacity forever).
      releasePin()
    }
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
    // The probe is a SEMANTIC catalog operation now (migration M1.8) — the
    // raw tools service never crosses into the command surface.
    const hostLoadsSkillBody = runner.catalog.skills.hostLoadsSkillBody(agent.session.id)
    // Deliver the batch through the steer path (and unlike
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
      // `/skill <name> [args...]`: the first whitespace token is the skill
      // name, the remainder its arguments (forwarded verbatim on the
      // original line, web parity — never carved out or dropped). The
      // invocation line is normalized to `/name args` so the host's pre-step
      // gesture (dsh-tool-skill) also recognizes it when visible.
      const [name, ...args] = splitSkillLine(invocation.rawInput)
      if (name !== '') return loadSkill(liveAgent, name, args.join(' '))
      // No argument: pick from the catalog — the same validated, policy-
      // filtered, sorted view the collector builds (the catalog port's
      // live read), so hostile or model-only entries never reach the
      // picker.
      const catalog = await runner.catalog.skills.listHumanSkills(liveAgent.session.id)
      if (catalog === undefined) return { kind: 'error', text: 'skill service unavailable' }
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
          app.clearActivePluginTheme()
          detach('theme autodetect', () => app.autoDetectTheme({
            // A settings panel write may complete while OSC 11 is in flight;
            // only apply the late result if auto is still the latest choice.
            shouldApply: () => settings.get().theme === 'auto',
          }))
          app.trackTerminalTheme(true)
        } else if (reloadTheme === 'dark' || reloadTheme === 'light') {
          app.clearActivePluginTheme()
          app.applyTheme(reloadTheme)
          app.trackTerminalTheme(false)
        } else if (reloadTheme !== 'auto') {
          // Any non-builtin persisted theme: SOURCE-QUALIFIED resolution
          // (the review's P2). The persisted value is the identity —
          // `file:<name>` resolves the file, `plugin:<owner>/<id>`
          // resolves the registry, and the legacy `custom:<name>` /
          // bare-name forms normalize to `file:<name>` (existing
          // documents keep working). A selection whose source is gone
          // (an unloaded plugin, a deleted file) falls back to the
          // builtin dark palette.
          const qualified = normalizePersistedTheme(reloadTheme)
          const themes = runner.extensions?.themes
          const selection = resolveThemeSelection(qualified, themes)
          // VALUE-addressed (the unified theme protocol).
          const themeRef = captureExtensionHealthRef?.('theme', qualified)
          if (selection !== undefined) {
            try {
              // A PLUGIN palette records the selection (the unload
              // fallback restores builtin dark when it disappears); a
              // custom FILE clears it.
              if (selection.kind === 'plugin') app.applyPluginPalette(selection.value, selection.palette)
              else {
                app.clearActivePluginTheme()
                app.applyPalette(selection.palette)
              }
              if (themeRef !== undefined) clearExtensionError?.(themeRef)
            } catch (error) {
              if (themeRef !== undefined) recordExtensionError?.(themeRef, error)
              else app.notify(`theme ${reloadTheme} failed: ${safeErrorMessage(error)}`, 'error')
            }
          } else {
            // A missing selection is a host settings problem, not a
            // plugin contribution failure. Do not create a theme health
            // row. The plugin selection is cleared (same rationale as
            // startup).
            app.clearActivePluginTheme()
            app.notify(`theme ${reloadTheme} not found`, 'error')
          }
          app.trackTerminalTheme(false)
        }
        runner.applyFooterSettings(doc)
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
      const models = runner.catalog.models
      if (!models.available()) return { kind: 'error', text: 'model service unavailable' }
      const providers = models.listProviders()
      const current = models.currentSelection() ?? { provider: '', model: '' }
      /** Commit a selection (model, optional effort) and refresh the footer. */
      const apply = (next: ModelSelection): void => {
        // Persist and reflect with LATEST-WINS semantics: saves run
        // concurrently, so a failure must only roll back when the current
        // selection is still the one THIS save was for — an older failed
        // save must never overwrite a newer successful selection (out-of-
        // order completion must not regress the persistent state either;
        // the UI at least never lies about what is current).
        const previous = selected.current
        runDetached('model selection save', () => models.saveSelection(next), {
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
      const closer = app.openSettings(
        providers.map(provider => ({
          id: provider.id,
          label: provider.name,
          currentValue: current.provider === provider.id ? current.model : '',
          submenu: (value, done) => new ModelSubmenu(provider.id, current.model, selected.current?.reasoningEffort, {
            listModels: (id) => models.listModels(id),
            resolveModelInfo: (id, modelId) => models.resolveModelInfo(id, modelId),
            apply,
            requestRender: () => app.requestRender(),
            // An APPLIED selection (non-undefined) closes the WHOLE overlay
            // (web ModelSelect settleSelection parity): picking a model
            // walks into the effort submenu, picking an effort (or Default)
            // commits and dismisses the panel. Esc (undefined) keeps the
            // step-by-step walk-back. closer() runs BEFORE done() — close
            // the overlay first, then the submenu level (order-safe).
            done: (picked) => {
              if (picked !== undefined) closer()
              done(picked)
            },
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
    handler: () => runner.withSessionTransition(async () => {
      // The unified transaction: the old session is flushed BEFORE the
      // fresh session is created, the child's lock is acquired BEFORE the
      // create publishes it (pre-generated id — review round 6), the commit
      // is synchronous, and a failure anywhere before the create leaves
      // the current session untouched (no published child to roll back).
      const sessionId = SessionId(`session-${randomUUID()}`)
      // The concrete preset id is resolved ONCE and rides the create (a
      // rejected create is NEVER retried — the first DSH call may have left
      // a hidden lifecycle, so the target is PINNED immediately). The preset
      // COMPOSITION (setup callback) is resolved inside the Direct session
      // lifecycle from this id — the command surface only ever sees the
      // identity (migration M1.11).
      const resolved = await runner.catalog.presets.resolve(runner.effectivePresetId)
      const newOptions = {
        provider: runner.liveAgent?.options.provider ?? runner.selected.current?.provider,
        model: runner.liveAgent?.options.model ?? runner.selected.current?.model,
      }
      const result = await runner.transitionTo({
        target: { id: String(sessionId), header: { cwd } },
        fresh: true,
        create: () => runner.agents.create({
          sessionId: String(sessionId),
          meta: metaOf(cwd, resolved.id),
          // Before the first session the process-wide selection stands in.
          provider: newOptions.provider,
          model: newOptions.model,
          agentPreset: resolved.id,
        }),
      })
      if (!result.ok) return { kind: 'error', text: result.message }
      // The transaction COMMITTED: staged drafts are per-TUI-run UI state —
      // drop the UNPINNED ones now, never before (a failed create keeps
      // the current session and its drafts intact; in-flight submissions
      // keep their pinned drafts — review finding 2).
      runner.imageStore.clearUnpinned()
      return { kind: 'success', text: 'started a fresh session' }
    }),
  })

  registerTuiCommand({
    name: 'tasks',
    description: 'Browse background jobs and subagents for this session (search filters rows)',
    aliases: ['subagents'],
    handler: async () => {
      // The merged browser: jobs + subagents in one searchable list, with
      // row-level interrupt on subagent rows — the same surface as the ↓
      // trigger (runner.openTasksBrowser). Completed jobs and finished
      // one-shot children are reachable exactly through this path.
      await requireAgent()
      runner.openTasksBrowser()
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
      // The permission switch is a CONFIG semantic operation (migration
      // M1.9): the Direct adapter still executes the OFFICIAL command line
      // (sandbox + live approval writer + the injected policy-change model
      // message + the preset log) — the raw commands service never crosses
      // into the command surface.
      const outcome = await runner.config.permissions.applyPermissionPreset(liveAgent.session.id, 'danger-full-access', signal)
      if (outcome.kind === 'unavailable') {
        return { kind: 'error', text: outcome.cause === 'commands'
          ? 'commands service unavailable'
          : '/permission unavailable (permission presets not composed)' }
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
      const presets = runner.catalog.presets
      if (!presets.available()) {
        return { kind: 'error', text: 'agent presets unavailable in this deployment' }
      }
      const liveAgent = runner.liveAgent
      // The live composition is the runner's own read (Direct ownership);
      // the roster catalog the command surface needs is the port's.
      const current = runner.currentPreset()
      const displayedDefault = async (): Promise<string | undefined> => {
        const configured = runner.config.presetDefault.get()
        if (configured !== 'code') return configured ?? presets.defaultId()
        // A persisted legacy `code` value is resolved through the roster. This
        // keeps status/default display consistent with composition: a real
        // custom code remains code, while old data without code displays ptc.
        try {
          return (await presets.resolve()).id ?? configured
        } catch {
          return configured
        }
      }
      const presetErrorText = (error: unknown, id: string): string => {
        const message = safeErrorMessage(error)
        if (id !== 'code' || !/\b(?:not found|unknown|unavailable)\b/iu.test(message)) return message
        return `${message}; if you meant the legacy PTC session identity, use preset "ptc"`
      }
      const matched = invocation.rawInput.trim().match(/^(\S+)(?:\s+(.*))?$/)
      const verb = matched?.[1] ?? ''
      const rest = matched?.[2]?.trim() ?? ''
      if (verb === 'status') {
        return { kind: 'success', text: `preset: ${current ?? 'none'} · default: ${await displayedDefault()}` }
      }
      if (verb === 'default') {
        if (!runner.config.presetDefault.available()) return { kind: 'error', text: 'settings service unavailable' }
        if (rest === '') {
          return { kind: 'success', text: `default preset: ${await displayedDefault()}` }
        }
        // The saved default only affects sessions created from now on. A
        // standing catalog refresh follows ONLY when no higher-precedence
        // override (run-local pending or launch-time --preset) masks the
        // new default — the masked case must not re-read a preset the next
        // session will not compose on.
        try {
          // Validate before writing settings. `code` is legal when the current
          // DSH roster contains a custom preset with that id; an unknown code
          // remains an ordinary unknown-preset failure and is never aliased.
          await presets.resolve(rest)
          await runner.config.presetDefault.set(rest)
        } catch (error) {
          return { kind: 'error', text: presetErrorText(error, rest) }
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
          // A roster that vanished between the availability check and the
          // resolve is a hard failure (the old compose path threw too) —
          // never a "preset undefined" success.
          if (resolved.id === undefined) throw new Error('agent presets unavailable in this deployment')
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
        // The live-session preset swap runs INSIDE the session-transition
        // gate (review round 27): recompose + the agent-preset/selected
        // append must never interleave with a concurrent /new, /fork,
        // rewind or switch — inside the gate the captured agent cannot be
        // quiesced or have its lock released mid-append.
        const outcome = await runner.withSessionTransition(() => runner.recomposeBlank(id))
        if (outcome.kind === 'locked') return { kind: 'locked', sessionId: runner.liveAgent!.session.id }
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
          app.notify(presetErrorText(error, id), 'error')
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
          return { kind: 'error', text: presetErrorText(error, verb) }
        }
      }
      const roster = await presets.list()
      if (roster.length === 0) return { kind: 'success', text: 'no agent presets configured' }
      const defaultId = await displayedDefault()
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
              preset.id === defaultId ? 'default' : undefined,
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
    name: 'search',
    description: 'Search persisted sessions for text and switch to a hit',
    input: { hint: '<query>' },
    handler: async (invocation) => {
      const currentId = runner.liveAgent?.session.id
      const query = invocation.rawInput.trim()
      if (query === '') return { kind: 'error', text: 'search needs a query' }
      // The session READ port (migration M1.3): the bounded content scan
      // lives in the Direct adapter, never here.
      const hits = await runner.sessionReader.search(query)
      if (hits === undefined) return { kind: 'error', text: 'session persistence unavailable' }
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
    const name = invocation.rawInput.trim()
    if (name !== '') {
      // The session WRITE port (migration M1.4): the title service access
      // lives in the Direct adapter, never here.
      try {
        if (!runner.sessionWriter.rename(liveAgent.session.id, name)) {
          return { kind: 'error', text: 'session title service unavailable' }
        }
      } catch (error) {
        return { kind: 'error', text: safeErrorMessage(error) }
      }
      return { kind: 'success', text: `title set: ${name}` }
    }
    try {
      const outcome = await runner.sessionWriter.refreshTitle(liveAgent.session.id, invocation.signal)
      if (outcome.kind === 'unavailable') {
        return { kind: 'error', text: 'session title service unavailable' }
      }
      if (outcome.title === undefined) {
        app.notify('no conversation yet — title left as-is', 'info')
        return { kind: 'success' }
      }
      app.notify(`title regenerated: ${outcome.title}`, 'info')
      return { kind: 'success' }
    } catch (error) {
      return { kind: 'error', text: safeErrorMessage(error) }
    }
  }

  registerTuiCommand({
    name: 'title',
    description: 'Set the session title; without an argument, regenerate it from the conversation (overwrites the current title)',
    input: { hint: '<title>' },
    aliases: ['rename'],
    handler: titleHandler,
  })

  commands.register({
    name: 'copy',
    description: 'Copy the last assistant message to the system clipboard (tmux-aware)',
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
      // Issue #7: the SAME policy as the fullscreen drag selection (tmux →
      // platform helper → OSC 52 best-effort) — a bare OSC 52 write is a
      // silent lie under tmux `set-clipboard external` / restricted
      // terminals.
      const ok = await runner.copyToClipboard(text)
      return ok
        ? { kind: 'success', text: 'copied last assistant message' }
        : { kind: 'error', text: 'failed to copy last assistant message' }
    },
  })

  commands.register({
    name: 'image',
    description: 'Attach an image file to the draft (tab completes the path; [image #N (W×H)] placeholder)',
    input: { hint: '<path>' },
    handler: (invocation) => {
      // The /image command is a TUI-LOCAL UI action (plan M2): it stages
      // the file into the draft store and inserts its placeholder into the
      // editor — it NEVER submits, so no session is created (deferred
      // start preserved) and no model call happens here.
      const words = parseShellWords(invocation.rawInput)
      if (words.length !== 1 || words[0] === '') {
        return { kind: 'error', text: 'Usage: /image <path>' }
      }
      const raw = words[0]!
      // The intake is ASYNC: capture the session identity at launch and
      // discard the result if the user switched sessions meanwhile — a late
      // intake must never stage an image into the NEW session's draft
      // (round-5 finding 2).
      const intakeGeneration = runner.sessionGeneration
      const detach = (label: string, task: () => unknown): void => {
        runDetached(label, task, {
          diag: runner.diag,
          sessionId: () => runner.liveAgent?.session.id,
          notify: (message) => app.notify(message, 'error'),
          recoverable: () => true,
        })
      }
      detach('image intake', () => {
        // An owned workflow: the intake outcome decides the notice and the
        // draft insertion — runOwned (AGENTS.md), never a bare void. The
        // limits are read INSIDE the task so a mid-run policy change is
        // honored (round-2 finding 5); the intake itself is ASYNC
        // (fs/promises) so a slow disk or NFS never blocks the TUI event
        // loop (review finding 1).
        runOwned('image intake', () => {
          // Attach-time prune: a placeholder deleted (or Ctrl+C-cleared)
          // since the last attach must not hold its bytes hostage until the
          // store fills up (review finding 2).
          pruneUnreferencedDrafts(app.getDraft(), runner.imageStore)
          // The intake's pre-read cap is the SMALLEST of the attachment
          // limit and the draft store's remaining RESIDENT budget — a file
          // that could never be staged is refused before any read.
          const intake = readImageFile(raw, runner.sessionCwd(), runner.imageLimits(), runner.imageStore.remainingBytes())
          return intake.then((resolved) => {
            if (runner.sessionGeneration !== intakeGeneration) {
              app.notify('the session changed while reading the image — try again', 'error')
              return undefined
            }
            // Re-prune AFTER the async read: the user may have deleted the
            // placeholder or Ctrl+C-cleared the editor while the file was
            // in flight — those drafts must not linger past the attach
            // (review finding 2 follow-up).
            pruneUnreferencedDrafts(app.getDraft(), runner.imageStore)
            const draft = runner.imageStore.add({
              bytes: resolved.bytes,
              mediaType: resolved.mediaType,
              width: resolved.width,
              height: resolved.height,
              source: { type: 'path', path: resolved.path },
              name: resolved.name,
            })
            runner.insertIntoEditor(`${draft.placeholder} `)
            app.notify(`attached ${draft.placeholder} — Enter to send`)
            return undefined
          })
        }, {
          diag: runner.diag,
          sessionId: () => runner.liveAgent?.session.id,
          onError: (error) => {
            app.notify(safeErrorMessage(error), 'error')
          },
        })
      })
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'export',
    description: 'Export this session log (JSONL by default, `md` for a readable transcript)',
    input: { hint: '[md|<path>]' },
    handler: async (invocation) => {
      const liveAgent = await requireAgent()
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
        // its physical encoding) — a faithful, portable session log. The
        // log READ is a session-read semantic (migration M1.11); only the
        // FILE WRITE below is client-local export behavior.
        const raw = await runner.sessionReader.readExportData(liveAgent.session.id)
        if (raw.kind === 'unavailable') return { kind: 'error', text: 'session persistence unavailable' }
        if (raw.kind === 'none') return { kind: 'error', text: 'no materialized session log to export' }
        if (raw.kind === 'error') return { kind: 'error', text: raw.message }
        writeFileSync(target, raw.data.content)
        return { kind: 'success', text: `exported ${raw.data.filename} to ${target}` }
      } catch (error) {
        return { kind: 'error', text: safeErrorMessage(error) }
      }
    },
  })

  commands.register({
    name: 'fork',
    description: 'Fork this session at the last completed turn',
    handler: () => runner.withSessionTransition(async () => {
      const source = runner.liveAgent
      const seed = source === undefined ? undefined : forkSeed(source.session.events)
      if (seed === undefined || source === undefined) return { kind: 'error', text: 'no completed turn to fork from' }
      // Shared child creation with rewind (plan §6.2): preset inheritance,
      // live session cwd, provider/model inheritance, parentSession +
      // seedLength metadata — one chain, no drift between the two surfaces.
      // The child's id is PRE-GENERATED so the transaction acquires its
      // open lock BEFORE the create publishes it (review round 6); the
      // create runs inside the unified transaction, and a failure before
      // the create leaves nothing behind (no published child, no ghost,
      // no rollback attempt).
      const sessionId = SessionId(`session-${randomUUID()}`)
      const childCwd = source.session.header.cwd || runner.sessionCwd()
      // The current preset is read once from the DSH projection and rides the
      // create (a rejected create is NEVER retried — the first DSH call may
      // have left a hidden lifecycle, so the target is PINNED immediately).
      // The composition setup stays inside the Direct session lifecycle — the
      // command surface only ever sees the identity (migration M1.11).
      const sourcePreset = runner.currentPreset()
      const result = await runner.transitionTo({
        target: { id: String(sessionId), header: { cwd: childCwd } },
        fresh: true,
        create: () => createForkedAgent(runner, source, seed, sessionId, sourcePreset),
      })
      if (!result.ok) return { kind: 'error', text: result.message }
      // The transaction COMMITTED: staged drafts are per-TUI-run UI state —
      // drop the UNPINNED ones now (durable attachments are untouched, plan
      // §14; in-flight submissions keep their pinned drafts — review
      // finding 2).
      runner.imageStore.clearUnpinned()
      // A Direct create always yields the live agent (port contract);
      // Remote handles surface the session identity only.
      return { kind: 'success', text: `forked as ${result.next.session.id}` }
    }),
  })

  commands.register({
    name: 'rewind',
    description: 'Fork this conversation from an earlier user turn (the workspace is not reverted)',
    handler: () => {
      // The SAME surface as the idle empty-editor double-Esc — one
      // implementation, two entries (plan §22). Sessionless it notifies
      // "no conversation to rewind" and never creates a session.
      runner.openRewindPicker()
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'status',
    description: 'Show session stats and identity',
    handler: async () => {
      const liveAgent = await requireAgent()
      const stats = computeStats(liveAgent.session.events)
      // Best-effort context measurement through the session-read port
      // (migration M1.11): unavailable/unmeasurable → the panel falls back
      // to unmeasured — never a crash.
      const contextTokens = runner.sessionReader.measureContext(liveAgent.session.id)
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
          // ── M11: extension health (plan §16) ───────────────────
          ...extensionHealthRows(runner),
        ],
        () => {},
        () => {},
      )
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'login',
    description: 'Sign in with a provider or set an API key — deepseek official or an llm-pi-ai provider route',
    input: { hint: '[<route|env-var>]' },
    handler: async (invocation) => {
      const credentials = runner.config.credentials
      if (!credentials.available()) return { kind: 'error', text: 'credentials service unavailable' }
      // The two credential planes: reference targets from the provider
      // catalog, authorization flows from the seam. An absent authorization
      // service degrades to the reference-only surface.
      const targets = runner.config.authorization.listTargets()
      const options = runner.config.providers.listCredentialOptions()
      const merged = mergeLoginTargets(options, targets)
      const arg = invocation.rawInput.trim()
      let route: string | undefined
      let ref: string | undefined
      let target: AuthorizationTarget | undefined
      if (arg !== '') {
        // An explicit env-var / known-ref name ALWAYS keeps the reference
        // path, even when the same route has an authorization flow (§11.1,
        // §11.2, §11.5 case D): the typed name is the escape hatch.
        const known = resolveCredentialArg(arg, options)
        if (known !== undefined) {
          const option = options.find(candidate => candidate.ref === known)
          if (option !== undefined) {
            // Known route: a profile that explicitly names apiKeyEnv keeps
            // the reference path; a KEYLESS route with a flow goes
            // provider-native (§11.3 vs §11.4).
            const flow = option.route !== 'deepseek-official' ? flowForRoute(targets, option.route) : undefined
            if (flow !== undefined && option.namesCredential === false) {
              target = flow
            } else {
              route = option.route
              ref = option.ref
            }
          } else {
            // Novel env-var name: use it verbatim (no route to map to).
            ref = known
          }
        } else if (ROUTE_PATTERN.test(arg)) {
          // A route that has no credential option but IS offered by an
          // authorization flow starts the flow (§11.4); a genuinely new
          // route starts the add wizard.
          const flow = flowForRoute(targets, arg)
          if (flow !== undefined) {
            target = flow
          } else {
            const outcome = await askAddProvider(runner, app, runner.signal, arg)
            if (outcome.kind === 'cancelled') return { kind: 'error', text: 'add provider cancelled' }
            if (outcome.kind === 'error') return { kind: 'error', text: outcome.text }
            return { kind: 'success', text: outcome.text }
          }
        } else {
          return { kind: 'error', text: `unknown credential target "${arg}" — ${mergedTargetsSummary(merged)}` }
        }
      } else if (merged.length > 1) {
        // Picker with search + grouping + the Add New Platform action row.
        // Reference rows keep their route value; authorization rows carry a
        // key marker so the two address spaces never collide.
        const picked = await new Promise<string | undefined>((resolve) => {
          app.openPicker(
            mergedPickerRows(merged),
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
          const outcome = await askAddProvider(runner, app, runner.signal)
          if (outcome.kind === 'cancelled') return { kind: 'error', text: 'add provider cancelled' }
          if (outcome.kind === 'error') return { kind: 'error', text: outcome.text }
          return { kind: 'success', text: outcome.text }
        }
        const authTarget = targetFromPickerValue(merged, picked)
        if (authTarget !== undefined) {
          target = authTarget
        } else {
          route = picked
        }
      } else {
        const only = merged[0]
        if (only === undefined) return { kind: 'error', text: 'no credential targets available' }
        if (only.kind === 'authorization') {
          target = only
        } else {
          route = only.route
          ref = only.ref
        }
      }
      if (target !== undefined) {
        return runAuthorizationLogin(app, runner, target, options)
      }
      if (route === undefined && ref === undefined) return { kind: 'error', text: 'no credential targets available' }
      const option = route === undefined ? undefined : options.find(candidate => candidate.route === route)
      const targetRef = ref ?? option?.ref ?? deriveKeyRef(route ?? '')
      const label = option?.label ?? route ?? targetRef
      try {
        const answers = await app.askQuestions([
          { id: 'key', question: `Enter the API key for ${label}:`, masked: true },
        ])
        const key = answers[0]?.custom ?? ''
        if (key === '') return { kind: 'error', text: 'empty key; nothing set' }
        await credentials.setReference(targetRef, key)
        return { kind: 'success', text: `API key ${targetRef} set` }
      } catch {
        return { kind: 'error', text: 'login cancelled' }
      }
    },
  })

  commands.register({
    name: 'logout',
    description: 'Clear a stored credential — deepseek official or an llm-pi-ai provider route (API key or stored record)',
    input: { hint: '[<route|env-var>]' },
    handler: async (invocation) => {
      const credentials = runner.config.credentials
      if (!credentials.available()) return { kind: 'error', text: 'credentials service unavailable' }
      const targets = runner.config.authorization.listTargets()
      const options = runner.config.providers.listCredentialOptions()
      const arg = invocation.rawInput.trim()
      if (arg !== '') {
        // A configured/derived reference name takes the reference path
        // (§13.1) — EXCEPT a keyless route with a flow, whose login stores
        // a RECORD: clearing the never-set derived ref would be a silent
        // no-op, so the record is what gets cleared (§13.2).
        const resolved = resolveCredentialArg(arg, options)
        if (resolved !== undefined) {
          const option = options.find(candidate => candidate.ref === resolved)
          const flow = option !== undefined && option.route !== 'deepseek-official' && !option.namesCredential
            ? flowForRoute(targets, option.route)
            : undefined
          if (flow !== undefined) {
            await credentials.deleteRecord(flow.key)
            return { kind: 'success', text: `${flow.label} signed out locally — stored credential cleared` }
          }
          await credentials.unsetReference(resolved)
          return { kind: 'success', text: `API key ${resolved} cleared` }
        }
        // A route naming a flow directly (no provider option for it).
        const flow = flowForRoute(targets, arg.toLowerCase())
        if (flow !== undefined) {
          await credentials.deleteRecord(flow.key)
          return { kind: 'success', text: `${flow.label} signed out locally — stored credential cleared` }
        }
        return { kind: 'error', text: `unknown credential target "${arg}" — ${mergedTargetsSummary(mergeLoginTargets(options, targets))}` }
      }
      // No argument: aggregate what actually exists — stored records plus
      // configured references (§13.3). Presence and kind only; a secret's
      // value never leaves the credentials service.
      const rows = await logoutPickerRows(credentials, options, targets)
      if (rows.length === 0) return { kind: 'error', text: 'nothing to sign out' }
      const picked = await new Promise<string | undefined>((resolve) => {
        app.openPicker(
          rows,
          (value) => resolve(value),
          () => resolve(undefined),
          { enableSearch: true, header: 'logout · credentials', noMatchText: '  nothing to sign out', width: 76, maxHeight: 26, showHint: true },
        )
      })
      if (picked === undefined) return { kind: 'error', text: 'logout cancelled' }
      if (picked.startsWith(LOGOUT_RECORD_VALUE)) {
        await credentials.deleteRecord(picked.slice(LOGOUT_RECORD_VALUE.length))
        return { kind: 'success', text: `${picked.slice(LOGOUT_RECORD_VALUE.length)} signed out locally — stored credential cleared` }
      }
      const targetRef = picked.slice(LOGOUT_REF_VALUE.length)
      await credentials.unsetReference(targetRef)
      return { kind: 'success', text: `API key ${targetRef} cleared` }
    },
  })

  commands.register({
    name: 'help',
    description: 'Show keybindings and available commands',
    handler: () => {
      // M4: the key labels come from the EFFECTIVE keymap (plan §18) — a
      // user remap updates /help automatically; the UI never hard-codes a
      // physical shortcut.
      const keybindings = app.keybindingsManager()
      const keysLabel = (action: AppKeybindingId): string => {
        // The full effective label: ALL direct keys AND ALL leader
        // sequences (a mixed `['ctrl+z', '<leader>h']` shows
        // `Ctrl+Z / Leader H`; a disabled action advertises nothing) —
        // review finding: keysFor() alone dropped the leader bindings.
        const label = keybindings.keysLabelFor(action)
        return label === '' ? '—' : label
      }
      const rows: SettingItem[] = [        { id: 'k-enter', label: keysLabel('app.input.submit'), description: 'Submit the draft; while the agent is busy, delivery follows the "Submit while busy" preference (skill commands steer too, UI commands run locally)', currentValue: '' },
        { id: 'k-queue', label: keysLabel('app.input.queue'), description: 'Queue the draft while the agent is busy (the opposite of "Submit while busy")', currentValue: '' },
        { id: 'k-exit', label: keysLabel('app.exit.request'), description: 'Quit the TUI (flushes the session)', currentValue: '' },
        { id: 'k-cancel', label: keysLabel('app.agent.interrupt'), description: 'Cancel the active turn / tool / shell command (one interrupt while the agent is busy; press the interrupt action twice while idle — with an empty editor it opens the rewind picker)', currentValue: '' },
        { id: 'k-fold', label: keysLabel('app.transcript.toggleExpand'), description: `Expand/collapse recent tool and system output; in regular Focus it reveals the recent Thoughts; in fullscreen Focus it bulk-expands the recent Thoughts or collapses them all (per-card detail stays mouse-owned). Thinking detail is ${keysLabel('app.transcript.toggleThinking')}`, currentValue: '' },
        { id: 'k-todo', label: keysLabel('app.todo.toggle'), description: 'Toggle the todo panel', currentValue: '' },
        { id: 'k-think', label: keysLabel('app.transcript.toggleThinking'), description: 'Collapse/expand thinking blocks (detail level — blocks stay visible)', currentValue: '' },
        { id: 'k-steer', label: keysLabel('app.input.steer'), description: 'Steer the running turn with the draft', currentValue: '' },
        { id: 'k-editor', label: keysLabel('app.editor.external'), description: 'Edit the draft in $VISUAL/$EDITOR', currentValue: '' },

        { id: 'k-search', label: keysLabel('app.transcript.search'), description: `Search the transcript (${keysLabel('app.transcript.search.next')}/${keysLabel('app.transcript.search.previous')} jump, ${keysLabel('app.transcript.search.close')} closes)`, currentValue: '' },

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

  // M4: the keybinding command. Bare /keybindings opens the action-first
  // Keyboard Shortcuts Editor; conflicts/reload/reset remain read-only or
  // explicit diagnostics seams and persist only through the settings port.
  commands.register({
    name: 'keybindings',
    description: 'Edit keyboard shortcuts (conflicts / reload / reset)',
    input: { hint: '[conflicts|reload|reset]' },
    handler: (invocation) => {
      const verb = invocation.rawInput.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
      const keybindings = app.keybindingsManager()
      if (verb === 'conflicts') {
        const conflicts = keybindings.snapshot().conflicts
        if (conflicts.length === 0) {
          app.notify('No keybinding conflicts.', 'info')
          return { kind: 'success', text: 'No keybinding conflicts.' }
        }
        const rows: SettingItem[] = conflicts.flatMap(conflict => [{
          id: `conflict-${conflict.key}`,
          label: color.warning(formatKeyId(conflict.key)),
          description: conflict.actions
            .map(entry => `${entry.action} (${entry.scope}, ${entry.source})`)
            .join('  vs  '),
          currentValue: 'conflict',
        }])
        app.openSettings(rows, () => {}, () => {})
        return { kind: 'success' }
      }
      if (verb === 'reload') {
        const settings = runner.tuiSettings
        // The reload seam needs a settings document (review round 35:
        // without the backend, "reading the defaults" would be a lie —
        // mirror /keybindings reset's explicit refusal so a degraded /
        // Remote backend cannot misrepresent an absent settings service
        // as a successful defaults read).
        if (settings === undefined) return { kind: 'error', text: 'settings service unavailable' }
        // Re-validate the settings document and rebuild the keymap
        // (fail-soft: bad entries are diagnostics, never a crash). Failures
        // are two distinct classes: a READ/PARSE failure (settings.get() or
        // parseUserKeybindings) leaves the previous keymap intact — the
        // last-known-good configuration stays active — whereas a throw
        // AFTER the rebuild (the post-rebuild UI invalidation — the
        // rebuild is keymap-first, invalidate-last) leaves the NEW keymap
        // active, so the diagnostic must not claim a rollback either.
        // Neither class may throw out of the handler
        // (review round 28: reload is now the ONLY reload seam, so its
        // fail-soft contract must match the startup application).
        return serializeTuiSettingsMutation(settings, (): CommandResult => {
          try {
            const parsed = parseUserKeybindings(settings.get().keybindings)
            for (const message of parsed.diagnostics) runner.diag.warn('keybindings', { message })
            keybindings.setUserConfiguration(parsed)
          } catch (error: unknown) {
            const message = safeErrorMessage(error)
            runner.diag.warn('keybindings', { error: message, message: 'keybindings reload failed — the error may come from the post-rebuild UI invalidation, so the keymap may already be rebuilt' })
            app.notify(`keybindings reload failed: ${message}`, 'error')
            return { kind: 'error', text: `keybindings reload failed: ${message}` }
          }
          app.notify('Keybindings reloaded.', 'info')
          return { kind: 'success', text: 'Keybindings reloaded.' }
        })
      }
      if (verb === 'reset') {
        const settings = runner.tuiSettings
        if (settings === undefined) return { kind: 'error', text: 'settings service unavailable' }
        // The whole reset is guarded — INCLUDING the initial read (review
        // round 30): a throwing first `get()` must not escape the handler;
        // it reports an error and the running keymap stays untouched.
        return serializeTuiSettingsMutation(settings, async (): Promise<CommandResult> => {
          try {
            // The outer serializeTuiSettingsMutation call owns the whole
            // transaction. Read and build the reset document only after all
            // earlier footer/focus/fullscreen writes have settled, then
            // persist it as the single next whole-document commit point.
            const doc = { ...withUserFooterCustomItems(settings.get(), runner.config) } as Record<string, unknown>
            delete doc.keybindings
            // Await the persistence write: the command result reflects the
            // ACTUAL outcome (a failed write must not report success — review
            // finding). The handler may return a Promise<CommandResult>.
            // NOTE (review round 35): after a successful write there is
            // deliberately NO second `settings.get()`. The reset doc is
            // already the canonical projection (the `keybindings` field was
            // deleted above), so the runtime is rebuilt from THAT local
            // state — `parseUserKeybindings(doc.keybindings)` — never from
            // a second Host read. A post-write read could fail (leaving the
            // disk reset but the runtime claiming "reset failed"), and a
            // Remote adapter must not be a GET → PUT → GET round trip:
            // reset is write + local projection.
            await settings.replace(doc as unknown as import('./runtime/config-port.ts').TuiSettingsDoc)
            // Apply the cleared configuration NOW: with the automatic
            // settings watch removed (review round 28 — the reload seam is
            // explicit), a reset that only persisted would leave the
            // RUNNING keymap with the old overrides until a manual
            // /keybindings reload. The reset is a full reset: persist AND
            // rebuild from the cleared document.
            const parsed = parseUserKeybindings(doc.keybindings)
            for (const message of parsed.diagnostics) runner.diag.warn('keybindings', { message })
            keybindings.setUserConfiguration(parsed)
            app.notify('Keybindings reset to defaults.', 'info')
            return { kind: 'success', text: 'Keybindings reset to defaults.' }
          } catch (error: unknown) {
            const message = safeErrorMessage(error)
            runner.diag.warn('keybindings', { error: message })
            app.notify(`keybindings reset failed: ${message}`, 'error')
            return { kind: 'error', text: `keybindings reset failed: ${message}` }
          }
        })
      }
      // Bare /keybindings opens the action-first editor. The historical
      // conflicts/reload/reset verbs above remain explicit diagnostics seams.
      let closeEditor: () => void = () => {}
      const panel = createKeybindingEditorPanel(() => closeEditor())
      if (panel === undefined) return { kind: 'error', text: 'settings service unavailable' }
      closeEditor = app.openKeybindingEditor(panel)
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
