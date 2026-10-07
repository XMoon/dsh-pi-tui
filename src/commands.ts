/**
 * The TUI command layer's stable facade and SINGLE registration/catalog
 * coordinator. The built-in slash command definitions live in
 * `src/tui/commands/**` (settings, sessions, models, skills, tasks, artifacts,
 * status, auth, utility); this module owns what must stay singular:
 *
 * - the shared command-layer types (`TuiCommandRunner`, `TuiCommandSpec`,
 *   `RegisterOne`/`RegisterTuiCommand`, `SubmitDelivery`, …) and their stable
 *   re-exports (moved definitions are re-exported here so callers and tests keep
 *   importing `src/commands.ts`);
 * - the Client-first registration seam + Direct compatibility-mirror
 *   provenance, the catalog/claims/collision state machine, completion
 *   synthesis and the single `commands/change` listener;
 * - the dynamic human-skill wrappers (`replaceSkillCommands`, `loadSkill`, the
 *   skill disposers, snapshot install and transition revalidation) — the
 *   static `/skill` and `/reload` definitions live in
 *   `src/tui/commands/skills.ts`;
 * - the draft-disposition side channel and the submit-resolved delivery
 *   binding shared by the skill paths.
 *
 * `registerTuiCommands()` calls every domain registrar at its frozen position
 * in the built-in registration sequence (changing that interleaving changes the
 * synchronous `commands/change` behavior); the domain modules never register
 * themselves at module load.
 *
 * Every command reads the live runner state through the {@link TuiCommandRunner}
 * interface, whose accessors re-read the current agent/settings on every access
 * (sessions can swap the live agent).
 * @module @xmoon76/dsh-pi-tui/commands
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult, CommandDescriptor, CommandDefinition } from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import { TransitionInProgressError } from './session-operation-barrier.ts'
import { SessionScopeSupersededError, type LiveSessionScope, type SessionScope } from './app/session/scope.ts'
import type { DefaultIntentRecord } from './default-intent.ts'
import type { Component } from '@xmoon76/pi-tui'
import type { ComposerSubmitGesture } from './tui-app.ts'
import { mergeDraft } from './steer.ts'
import type { DisplayPreset, DisplayPresetApplyResult } from './display-preset.ts'
import type { ProgressUpdatesState, ResponseStyleState } from './communication-policy.ts'
import type { GitAttributionState } from './git-attribution.ts'
import type { FooterCustomItemSettings } from './domain/footer/custom-items.ts'
import type { TuiApp } from './tui-app.ts'
import type { Diag } from './diag.ts'
import { cancellationError, runDetached } from './detached.ts'
import { safeErrorMessage } from './error-boundary.ts'
import { consumeDraftAttachments, pinDraftAttachments } from './client/media/draft-attachments.ts'
import { suggestPathArgument } from './tui/file-completion/path-argument.ts'
import { FILE_ARGUMENT_COMMANDS } from './domain/file-completion/path-argument-commands.ts'
import type { OperationOwnership } from './runtime/write-outcome.ts'
import { SupersededReadError } from './runtime/read-error.ts'
import type { SessionStatsFacts } from './stats.ts'
import type { SessionReader } from './runtime/session-reader-port.ts'
import type { SessionWriter } from './runtime/session-writer-port.ts'
import type { InteractionPort } from './runtime/interaction-port.ts'
import type { CreateSessionRequest, OpenSessionRequest, SessionHandle } from './runtime/session-lifecycle-port.ts'
import type { Catalog } from './runtime/catalog-port.ts'
import type { SkillDefinitionResult } from './runtime/catalog-port.ts'
import type { ConfigPort } from './runtime/config-port.ts'
import type { HostFilePort } from './runtime/host-file-port.ts'
import type { CatalogRefreshOutcome, CatalogRefreshSource } from './skill-catalog-refresh.ts'
import type { ClientCommandRegistry } from './app/command/client-command-registry.ts'
import { commandSummaryOf, listGlobalCommands, type SurfaceCatalogSnapshot, type SurfaceCommandSummary } from './surface-catalog.ts'
import { isUserInvocableSkill, type HumanSkillCatalog, type HumanSkillSummary } from './skill-catalog.ts'
import { registerExitCommand, registerHelpCommand } from './tui/commands/utility.ts'
import { registerPluginsCommand, registerTasksCommand } from './tui/commands/tasks.ts'
import { createModelCommands } from './tui/commands/models.ts'
import { registerReloadCommand, registerSkillCommand, type SkillsCommandDeps } from './tui/commands/skills.ts'
import { createArtifactsCommands } from './tui/commands/artifacts.ts'
import { createAuthCommands } from './tui/commands/auth.ts'
import { createSettingsCommands } from './tui/commands/settings.ts'
import { createSessionCommands } from './tui/commands/sessions.ts'
import { registerStatusCommand } from './tui/commands/status.ts'


/**
 * The `/sessions` category tabs (the 2026-08-22 plan, item 3): the session
 * picker is a HUMAN surface, so subagent children never appear in either
 * scope — /tasks and the subagent viewer own that surface now (kimi's
 * directory-scope direction). `current` scopes to the live session's
 * workspace (the sessionCwd the whole surface follows); `all` lists every
 * main session, grouped by its workspace. Exported so the scope contract
 * is unit-testable without a runner.
 *
 * The `items` factories read the SHARED `rows` array at activation time
 * (not a snapshot taken here): the picker opens input-first on a loading
 * placeholder and `list()` lands AFTER the categories were built — the
 * late rows appear through the same factories on the next refresh. When
 * `rows` is still empty and a `placeholder` is supplied, both categories
 * render it (the loading row); once rows land the placeholder disappears
 * naturally.
 * @param rows - the picker rows, newest first (the FULL row set — a main
 *   session beyond any read-window is still listed here, so the projection
 *   loader must cover every row this function can show). The array is read
 *   lazily and may be filled after the picker opens.
 * @param currentCwd - the live session's workspace.
 * @param header - the picker header prefix (`sessions` / `resume`).
 * @param itemFor - the row → picker item mapper (titles + current marker).
 * @param placeholder - the loading row shown while `rows` is still empty.
 */



/** The TUI settings document surface (theme/footer/footerLayout/
 * fullscreen/busyEnter/localShellSandbox/homeEndKeys/displayPreset/focusMode). The old
 * `history` field moved to $DSH_HOME/user-history/*.jsonl and is
 * deliberately NOT part of the document anymore. The type now lives on
 * the config port (M1.9); the re-export keeps the public commands-surface
 * name stable for tests. The user keybinding overrides (`keybindings`,
 * an unknown-key pass-through in the config port's document schema — see
 * index.ts) ride along. */
export type { TuiSettingsLike, TuiSettingsDoc } from './runtime/config-port.ts'
import type { TuiSettingsLike } from './runtime/config-port.ts'


/** The minimal commands-registry surface the TUI command surface needs
 * (migration M1.11): registration + listing. This is a runner ASSEMBLY
 * dependency for the TUI's own registrations — never a Host backend
 * capability (the /yolo permission switch no longer reaches a commands
 * service; it goes through the config port). */
export interface CommandRegistryLike {
  register(definition: CommandDefinition): () => void
  list(agent?: unknown): readonly CommandDescriptor[]
}

/** The single registration seam handed to the command-domain modules
 * (`src/tui/commands/*.ts`): the coordinator owns provenance, catalog state and
 * disposal; a domain registrar only supplies definitions. */
export type RegisterOne = (definition: CommandDefinition) => void

/** One TUI command definition plus its aliases: an alias is another NAME of
 * the same logical command, registered through the same seam. */
export interface TuiCommandSpec {
  name: string
  description: string
  aliases?: readonly string[]
  input?: { hint: string }
  handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  aliasHandlers?: Record<string, (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>>
  aliasDescriptions?: Record<string, string>
}

/** Register one {@link TuiCommandSpec} plus its aliases (coordinator primitive). */
export type RegisterTuiCommand = (spec: TuiCommandSpec) => void

/** Fire-and-forget through the coordinator's diagnostics ownership (see the
 * local `detach`): cancellations debug-only, recoverable failures notify, the
 * rest warn. Domain command modules receive this instead of re-deriving it. */
export type DetachTask = (
  label: string,
  task: () => unknown | Promise<unknown>,
  options?: { notify?: boolean },
) => void
/** The coordinator's skill-execution boundary, handed to the skill command domain
 * (the dynamic wrapper state machine stays here). */
export type LoadSkill = (
  scope: LiveSessionScope,
  name: string,
  args: string,
  signal: AbortSignal,
  delivery: SubmitDelivery | undefined,
  commandId?: string,
) => Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }>


/** One default-intent operation's ownership record: the id is the settle
 *  authority (an older operation settling must never clear or restore a
 *  newer operation's pending intent), the selection is the intent value. */
export type { DefaultIntentRecord } from './default-intent.ts'

/** The /new session-id constructor: the ONE place the dsh-session `SessionId`
 * value import lives (domain modules consume the typed result, never the package). */
export type NewSessionId = () => SessionId

/** The /sessions category/search helpers (moved to `src/tui/commands/sessions.ts`,
 * re-exported here to keep the stable command-surface import path). */
export { sessionPickerCategories, sessionSearchCategory } from './tui/commands/sessions.ts'

/** The /status extension-health rows (moved to `src/tui/commands/status.ts`,
 * re-exported here to keep the stable command-surface import path). */
export { extensionHealthRows } from './tui/commands/status.ts'
/** The shipped-preset display copy (moved to `src/tui/commands/models.ts`,
 * re-exported here to keep the stable command-surface import path). */
export { isBuiltInPresetRow, presetDisplayText } from './tui/commands/models.ts'

/**
 * The effective mode ONE submission resolved at the submit boundary: whether
 * an agent-facing delivery steers into the running turn or queues behind it
 * (web `ComposerSubmissionPolicy` parity — an idle agent queues, plain Enter
 * takes the preference, and the accelerated chord takes its OPPOSITE).
 *
 * It is a property of the GESTURE, not of the persisted settings: a one-shot
 * gesture exists only inside the dispatch that resolved it, so every
 * downstream consumer (the TUI skill delivery) accepts this value instead of
 * re-deriving the mode from `busyEnter`.
 */
export type SubmitDelivery = 'steer' | 'queue'

/**
 * Resolve one submission's delivery mode — the DSH WEB
 * `ComposerSubmissionPolicy.resolve()` contract (baseline established in DSH
 * `0.1.6-alpha.1`, shared by every UI client):
 *
 * ```text
 * !running              -> queue
 * gesture === 'enter'   -> the preferred mode (busyEnter)
 * accelerated           -> the OPPOSITE of the preferred mode
 * ```
 *
 * The accelerated chord is therefore "the other behavior", never a fixed
 * queue: with the default preference ('queue') it steers. A non-steering
 * transport always queues (the TUI's Direct surface always steers).
 * @param running - whether the live agent reports running.
 * @param gesture - the composer gesture that raised the submission.
 * @param busyEnter - the persisted preference (''/undefined = queue).
 */
export function resolveComposerDelivery(
  running: boolean,
  gesture: ComposerSubmitGesture,
  busyEnter: string | undefined,
): SubmitDelivery {
  if (!running) return 'queue'
  const preferred: SubmitDelivery = busyEnter === 'steer' ? 'steer' : 'queue'
  if (gesture === 'enter') return preferred
  return preferred === 'queue' ? 'steer' : 'queue'
}

/** A skill write reached the command boundary without a known settlement. */
class IndeterminateSkillWriteError extends Error {
  constructor() {
    super('skill write result is indeterminate — do not retry automatically')
    this.name = 'IndeterminateSkillWriteError'
  }
}

/** Recognize the internal skill uncertainty marker after commands.execute(). */
export function isIndeterminateSkillWrite(error: unknown): boolean {
  return error instanceof IndeterminateSkillWriteError
}

/** TUI-local disposition for a command submission's cleared draft. This is
 * correlated by the DSH command execution id outside the normalized result. */
type CommandDraftDisposition = 'restored' | 'suppressed'

/** The permission-preset port's own settlement vocabulary. */
export type PermissionPresetOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'unavailable'; readonly cause: 'commands' | 'permission' }
  /** §6.3: dispatched but unobservable (e.g. a post-dispatch transport
   *  cancellation) — never masked as unavailable, never retried. */
  | { readonly kind: 'indeterminate'; readonly reason: string }

/**
 * One permission-preset attempt. The LOCAL ownership axis stays INDEPENDENT from
 * the port settlement (`src/runtime/write-outcome.ts`): `refused` proves nothing
 * ran, while a `superseded` result still carries what the port settled — a
 * dispatched operation may already have applied to the previous owner.
 */
export type PermissionPresetResult =
  | { readonly ownership: 'refused' }
  | { readonly ownership: OperationOwnership; readonly outcome: PermissionPresetOutcome }

/** Everything the TUI-owned commands read from the runner. */
export interface TuiCommandRunner {
  ctx: Context
  app: TuiApp
  /** The runner's diagnostics channel (stderr + $DSH_HOME/logs). */
  diag: Diag
  /** The current session id. SYNC display/diagnostics ONLY — never an operation
   *  admission and never a fence (use a captured {@link SessionScope} there). */
  readonly currentSessionId: string | undefined
  /** ONE synchronous capture of `{ owner subject, generation, sessionId }` for
   *  sessionless-ALLOWED paths (a sessionless capture is meaningful: it fails
   *  once any Session appears, including mid-commit). */
  captureSessionScope(): SessionScope
  /** The same atomic capture for a session-backed path, or `undefined` while
   *  sessionless. Never creates a Session. */
  captureLiveSessionScope(): LiveSessionScope | undefined
  /** True only for the same exact owner AND generation — or, for a sessionless
   *  capture, the same sessionless generation. */
  isSessionScopeCurrent(scope: SessionScope): boolean
  /** Ensure the lazy first session exists, then capture an atomic LIVE scope.
   *  Throws when the surface is still sessionless (creation failed). */
  requireLiveSessionScope(): Promise<LiveSessionScope>
  /** Create the first session lazily when none exists (deferred start). */
  ensureSession(): Promise<void>
  /**
   * TUI-facing live selection facade (footer + /model). It follows the
   * current Agent; with deferred start it holds only the sessionless
   * optimistic choice and never gets installed into an Agent context.
   */
  readonly selected: ModelSelectionRef
  /** Legacy/display facade: the newest SESSIONLESS `/model` intent (pending or
   * unresolved) falling back to the persisted global default. A fresh create
   * NEVER seeds from it — the Direct adapter captures the persisted Host default
   * at admission, and a failed/ambiguous intent is never seeded (v2 §0.8.4).
   * Distinct from {@link selected}: it never exposes a live Session's local
   * choice. Retained for the footer/legacy facade and tests. */
  defaultSelection(): ModelSelection | undefined
  /** The newest SESSIONLESS `/model` intent (pending or unresolved), or
   * undefined when no sessionless commit happened this run. A fresh create
   * never seeds from it (it reads the persisted Host default). */
  readonly defaultIntent: ModelSelection | undefined
  /** The current default-intent OWNERSHIP record (id + selection), or
   * undefined when no intent is active. The id is the operation's settle
   * authority: an older /model operation settling must never clear or
   * restore a NEWER operation's pending intent. */
  readonly defaultIntentRecord: DefaultIntentRecord | undefined
  /** Record a NEW default-intent operation (allocates a fresh ownership id
   * and links the previous operation as ancestry). The Session selection is
   * NEVER written through this seam: the catalog port commits it after the
   * durable append succeeds. */
  setDefaultIntent(selection: ModelSelection | undefined): void
  /** Report one operation's save outcome to the intent state machine. The
   * machine decides whether the intent clears (committed), walks the
   * ancestry back to the nearest still-PENDING ancestor, retains the nearest
   * UNRESOLVED ancestor (an ambiguous write still needs a Host read), or
   * clears on committed — the caller never restores or settles the intent
   * itself. */
  settleIntent(id: number, outcome: 'committed' | 'failed' | 'unresolved'): void
  /** Reconcile an UNRESOLVED sessionless default intent against an
   *  authoritative Host read (v2 §0.3.2): the persisted default either carries
   *  the choice (committed) or proves it did not land (clear). Never guesses. */
  reconcileDefaultIntent(persisted: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined): void
  /** Await EVERY in-flight sessionless `/model` global-default write (each
   * includes its own fenced correction) so a fresh create observes the settled
   * newest Host default instead of racing it. Aborts as soon as the lifetime
   * signal aborts, so a hung Host save can never block first creation past
   * shutdown. */
  awaitPendingDefaultWrite(signal?: AbortSignal): Promise<void>
  /** Register one sessionless `/model` global-default write. The barrier
   * tracks ALL of them: an older write can still be settling (and re-asserting
   * the newest committed value) after a newer one resolved. */
  trackDefaultWrite(write: Promise<unknown>): void
  /** The newest default-write settle: 'committed' (the persisted default
   * carries the choice), 'failed' (the UI walks back; a failed choice is NEVER
   * seeded into a create, v2 §0.8.4), 'unresolved' (dispatched but unprovable —
   * keep the explicit unresolved state until a Host read, v2 §0.3.2), or
   * undefined while pending. */
  readonly defaultIntentOutcome: 'committed' | 'failed' | 'unresolved' | undefined
  /** Record (or clear) the in-flight Session model selection the footer
   *  reports as `selecting` while the semantic write settles. A newer
   *  surface generation makes a stale record invisible; the display always
   *  follows the authoritative Session selection, never this request. */
  /** Set (or clear) the footer's in-flight model marker. `token` is the
   *  owning `/model` operation: a clear from an older operation is ignored so
   *  it can never wipe a newer operation's marker (v2 §0.2.5). `status`
   *  distinguishes `selecting…` from an explicit `unresolved` state. */
  setModelSelectionPending(selection: ModelSelection | undefined, token?: number, status?: 'pending' | 'unresolved'): void
  /** The TUI settings document, when the settings service is present. */
  readonly tuiSettings: TuiSettingsLike | undefined
  /** The session lifecycle port (D2.1): /new and /fork create/open sessions
   * through semantic requests (the Direct adapter resolves the preset
   * composition internally). */
  readonly agents: {
    create(options: CreateSessionRequest): Promise<SessionHandle>
    open(options: OpenSessionRequest): Promise<SessionHandle>
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
  /** The session WRITE port (D2.1): ordinary prompts, occurrence-level queue
   * steering/removal, cancel and title ops go through the port. Multi-message
   * gestures use runner-level FIFO orchestration; no batch verb crosses it. */
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
  /** Whether Host-shell completion facts are reachable on this backend
   * (shell amendment M3-4 PR3): true on Direct (the process IS the Host, so
   * the compgen bridge reads Host state); false on Remote — no shell carrier
   * means NO shell-specific suggestions, never Client PATH/filesystem
   * guesses. Absent defaults to false (no shell completion). */
  readonly hostShellCompletion: boolean
  /** The minimal commands registry for the TUI's OWN registrations
   * (migration M1.11) — a runner assembly dependency, not a Host
   * capability. On the Remote branch (PR4 §D2) this is `undefined` and the
   * TUI's OWN definitions register into {@link clientCommands} instead;
   * Direct keeps the Host registration so the in-process dispatch surface
   * (busy-Enter, sessionless execution) is unchanged. */
  readonly commandRegistry: CommandRegistryLike | undefined
  /** Whether the readable-transcript artifact is renderable on this backend
   * (M3-4 PR5): `true` on Direct — the Markdown renderer reads the whole
   * in-process Session event history; `false` on the wire backend, where no
   * transport-neutral whole-history seam exists yet. This is a business
   * CAPABILITY, deliberately NOT derived from {@link commandRegistry}: that
   * field is the Direct Host-registry compatibility mirror whose retirement
   * is owned by M8, and a business decision must never hang off a
   * compatibility implementation.
   *
   * REQUIRED: every runner assembly declares it explicitly (the production
   * composition and every typed test stub); the handler refuses unless the
   * declared value is exactly `true`. */
  readonly transcriptExportAvailable: boolean
  /** The Client-owned command registry (M3-4 PR4 §D2): every TUI built-in
   *  and dynamic skill-wrapper definition registers here FIRST. On Direct
   *  the same definitions additionally register into the Host commands
   *  service (compatibility: the in-process dispatch stays identical); on
   *  Remote ONLY this registry holds them — the Host service never receives
   *  a TUI callback. */
  readonly clientCommands: ClientCommandRegistry
  /** The ONE exit orchestration (latch → surface cleanup → resume hint →
   * appExit; the Direct owned-session retirement runs inside the appExit
   * disposal) — shared by Ctrl+C/Ctrl+D, /exit and /quit. Command handlers
   * must NEVER stop the app, flush or exit themselves. */
  requestExit(): void
  cwd: string
  /** The per-TUI draft image registry (image pipeline, plan M1). Shared by
   * the /image command, the clipboard intake and the submission path; the
   * runner clears it on submit/session-switch/dispose, never on durable
   * attachments. */
  imageStore: import('./client/media/image/draft-store.ts').DraftImageStore
  /** The per-TUI metadata-only generic file draft registry. */
  readonly fileStore?: import('./client/media/attachment/file-draft.ts').DraftFileStore
  /** The shared user-clipboard WRITE policy (issue #7). Delivers through
   * two independent legs — terminal-client OSC 52 and native/platform
   * helpers — and is the SAME policy the fullscreen drag selection uses. */
  copyToClipboard(text: string): Promise<boolean>
  /** The deployment image policy, re-read dynamically.
   * Direct: the detached live Host deployment preflight
   * (`ctx.attachments.imageLimits`); the Host re-checks at admission.
   * Remote: `undefined` at Client intake — the Client applies only its own
   * safety/resident caps, and the exact Session's official `imageLimits`
   * projection is checked later by the Remote serializer before
   * `session/prompt` (the final admission authority). */
  imageLimits(): import('./domain/media/types.ts').ImageLimitsLike | undefined
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
   * The TRANSPORT-AWARE prepared-prompt builder (PR4 review round: the Remote
   * branch's session writer requires the serializer's PreparedPrompt — a raw
   * UserMessage fails its preflight with "no prepared prompt snapshot"). Wired
   * on Remote to the SAME builder the ordinary submission path uses
   * (`prepareRemotePrompt`), so a skill gesture is delivered exactly like a
   * plain prompt; absent on Direct, where `prepareDraftMessage` stays
   * authoritative.
   */
  prepareTransportMessage?(text: string, requestId: string): Promise<unknown>
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
  switchSession(sessionId: string): Promise<string | undefined>
  /** Host-owned /fork navigation. The runner dispatches the semantic fork
   * outside the destructive transition FIFO and only commits the visible child
   * while the captured navigation intent is still current. Optional keeps
   * command-only test runners focused on unrelated commands. */
  forkSession?: (sourceSessionId: string) => Promise<CommandResult>
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
    /** The child's pre-generated session identity (mandatory). */
    target: { id: string; header?: { cwd?: string } }
    prepare?: () => Promise<void> | void
    create: () => Promise<T>
  }): Promise<{ ok: true; next: T } | { ok: false; message: string; error?: unknown }>
  /** The preset the live agent runs on, when the deployment composes one. */
  currentPreset(): string | undefined
  /** The Host turn-boundary authority's blank state for the live Session
   *  (`undefined` when the projection is unavailable — the Host then remains
   *  the final authority). Never derived from the TUI transcript. */
  sessionBlank(): boolean | undefined
  /** The preset chosen with /preset while no session exists yet; the next
   * session composes on it (run-local, ahead of launchPreset/default). */
  pendingPreset: string | undefined
  /** The effective preset id for COLD (sessionless) reads: the run-local
   * pending override ahead of the launch-time --preset (the SAME precedence
   * the runner's ensureSession uses); undefined = the saved/default preset
   * applies. */
  readonly effectivePresetId: string | undefined
  /**
   * The scoped command view of the CURRENT surface: the live Session's
   * effective view (global + its scoped shadows) when one exists, else the
   * global layer. A synchronous current read (display/collision baseline),
   * never a fence.
   */
  listScopedCommands(): readonly SurfaceCommandSummary[]
  /** Resolve ONE skill definition of the exact owner the scope pins: validated
   *  BEFORE the dispatch and again after the read settles. A stale scope throws
   *  {@link SupersededReadError}. */
  resolveScopedSkill(scope: LiveSessionScope, name: string): Promise<SkillDefinitionResult>
  /** Whether the Host's skill pre-step loads the body for the exact owner the
   *  scope pins: validated BEFORE the synchronous read. A stale scope throws
   *  {@link SupersededReadError}. */
  hostLoadsSkillBody(scope: LiveSessionScope): boolean
  /** Read the human skill catalog of the exact owner the scope pins: validated
   *  BEFORE the dispatch and again after the read settles. A stale scope throws
   *  {@link SupersededReadError}. */
  listScopedSkills(scope: LiveSessionScope, signal?: AbortSignal): Promise<HumanSkillCatalog | undefined>
  /** Whether the live Session's owner is running. A stale scope throws
   *  {@link SupersededReadError}. */
  currentSessionActivity(scope: LiveSessionScope): { readonly running: boolean }
  /** The routing facts of the exact owner the scope pins. `provider`/`model`
   *  are OPTIONAL in the DSH AgentOptions contract (the presentation renders
   *  "unconfigured"); a stale scope throws {@link SupersededReadError}. */
  currentSessionRouting(scope: LiveSessionScope): {
    readonly provider: string | undefined
    readonly model: string | undefined
    readonly cwd: string
  }
  /** The pinned Session's approval-policy override, or `undefined` when it
   *  has none. A stale scope throws {@link SupersededReadError}. */
  currentApprovalOverride(scope: LiveSessionScope): 'ask' | 'never' | undefined
  /**
   * The pinned Session's whole-log stats, or `undefined` when the owner
   * exposes none. Async since M3-4 PR4 §D5: the Remote branch composes the
   * official projections with bounded paging for the recent window. A stale
   * scope throws {@link SupersededReadError}.
   */
  currentSessionStats(scope: LiveSessionScope, signal?: AbortSignal): Promise<SessionStatsFacts | undefined>
  /**
   * PR5 (plan §3.2): whether the CURRENT main window's recent-performance
   * figures are presentation-authoritative (Direct full log, or a Remote
   * window that proved its samples / reached the history start). Absent on
   * stub compositions = `true` (the fold's own complete-log semantics).
   */
  readonly recentPerformanceAvailable?: () => boolean
  /**
   * The pinned Session's last assistant-message text ('' when the message
   * carries no text block), or `undefined` when there is none. Async since
   * M3-4 PR4 §D5: the Remote branch pages loadOlder until the newest
   * durable assistant message is inside the window. A stale scope throws
   * {@link SupersededReadError}.
   */
  lastAssistantText(scope: LiveSessionScope, signal?: AbortSignal): Promise<string | undefined>
  /** Refresh the LIVE Session's scoped catalog through the coordinator. The
   *  scope is validated at the SYNC admission (the exact owner is captured
   *  there) and again after the read settles; a stale scope throws
   *  {@link SupersededReadError}. Accepts a sessionless-capable capture so
   *  /preset's live branch can pass the scope it fences with. */
  refreshSessionCatalog(scope: SessionScope, source: CatalogRefreshSource): Promise<CatalogRefreshOutcome>
  /** Refresh the sessionless STANDING catalog of `presetId` (undefined = the
   *  deployment default) through the coordinator. */
  refreshStandingCatalog(presetId: string | undefined, source: CatalogRefreshSource): Promise<CatalogRefreshOutcome>
  /** Apply one permission preset to the Session the scope pins.
   *
   *  Two INDEPENDENT axes (D2.3 v2 §0.2.1): `ownership` says whether the result
   *  still owns the current surface, and `outcome` carries what the port actually
   *  settled. `refused` means the dispatch never happened (a stale scope), so the
   *  caller may say "not applied". `superseded` means the operation WAS dispatched
   *  and its settlement is PRESERVED — the caller must never report it as
   *  "not applied" and never invite a blind retry (it would target the replacement
   *  owner). */
  applyPermissionPreset(
    scope: LiveSessionScope,
    presetId: string,
    signal?: AbortSignal,
  ): Promise<PermissionPresetResult>
  /** Set the approval-policy override of the owner the scope pins. A stale scope
   *  is REFUSED (`superseded`) before any dispatch — never retargeted. This write
   *  is SYNCHRONOUS, so `superseded` always means "nothing ran". */
  setSessionApprovalPolicy(scope: LiveSessionScope, value: 'ask' | 'never'): 'applied' | 'superseded'
  refreshStatus(): void
  /** PR D2: the /status explicit context force — measures NOW through the
   * runner's context coordinator (mark dirty + semantic SessionReader),
   * repaints the footer cheaply, and returns the fresh (or last-good)
   * value for the panel. Panel and footer share ONE cached measurement —
   * a caller SHOULD prefer this over a direct sessionReader read (which
   * would bypass the cache and could duplicate an in-flight measurement).
   * Optional: stubs without the coordinator fall back to a direct
   * sessionReader read. */
  forceContextMeasurement?(): number | undefined
  /** Shared with prompt assembly; settings changes take effect on the next step. */
  readonly progressUpdatesState: ProgressUpdatesState
  /** Shared with prompt assembly; settings changes take effect on the next step. */
  readonly responseStyleState: ResponseStyleState
  /** Shared with prompt assembly; settings changes take effect on the next step. */
  readonly gitAttributionState: GitAttributionState
  /** The canonical display preset (the authoritative runtime state). */
  displayPreset?(): DisplayPreset
  /** Apply a canonical display preset through the shared setter. */
  setDisplayPreset?(preset: DisplayPreset): DisplayPresetApplyResult
  /** @deprecated Compatibility facade for existing command-only callers. */
  focusEnabled(): boolean
  /** @deprecated Compatibility facade; production commands use setDisplayPreset. */
  setFocusMode(enabled: boolean): void
  /** Apply the completion-notification MODE ('unfocused' | 'always' |
   * 'off') to the runtime controller (the /settings panel write; the
   * panel persists the raw string through the config port). */
  setNotificationMode(mode: string): void
  /** Apply the completion-notification METHOD ('auto' | 'osc9' |
   * 'osc777' | 'bell') to the runtime controller (the /settings panel
   * write; the panel persists the raw string through the config port). */
  setNotificationMethod(method: string): void
  /** Apply the native terminal-progress preference ('on' | 'off') to the
   * mounted surface (the /settings panel write; the panel persists the raw
   * string through the config port). Presentation gate only — it never
   * changes the Agent lifecycle. */
  setTerminalProgressMode(mode: string): void
  /** Repaint the welcome card from the live agent's current facts (e.g. after a preset switch). */
  updateWelcomeCard(): void
  /**
   * Open one job's detail from a task list: bash jobs show the status
   * viewer, subagent jobs the child transcript. Shared by the footer ↓
   * Quick Tasks browser and `/tasks`.
   */
  openJobView(jobId: string): void
  /**
   * Open the full Task Center (jobs + subagents, searchable, with
   * confirmed row-level Stop on capable rows). This is the command-side
   * entry behind `/tasks` (and its `subagents` alias); the footer ↓ opens
   * the compact Quick Tasks view.
   */
  openTasksBrowser(): void
  /**
   * Open the shared Plugin Manager surface directly (`/plugins`, P1-A). It is
   * profile-wide and sessionless: it never creates or switches a Session.
   */
  openPluginManager(): void
  /**
   * Build the SAME Plugin Manager panel as a lazy `/settings` submenu
   * component (`/settings → Plugins  Manage…`). The single runner-owned
   * controller owns operation state; `done` returns to the Settings list.
   * Opening `/settings` alone never calls this (no eager inventory read).
   */
  createPluginManagerSubmenu(done: (selected?: string) => void): Component
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
   * Run one destructive session-transition workflow exclusively through the
   * process-local single-writer gate. Host-owned fork dispatch is intentionally
   * outside this FIFO; only its current visible adoption and Direct retirement
   * handoff use the gate. Re-entering the gate from inside a task is refused
   * loudly (it would deadlock).
   */
  withSessionTransition<T>(task: () => Promise<T> | T): Promise<T>
  /**
   * Run one scope-bound TUI session write (A3 §1.3): the captured scope is
   * validated ONCE, synchronously, before the operation barrier is entered, so
   * a transition started immediately after waits for this writer. A stale
   * scope rejects with `SessionScopeSupersededError` before the task
   * runs; a frozen transition keeps the barrier's `TransitionInProgressError`.
   */
  withWriter<T>(scope: LiveSessionScope, task: () => Promise<T> | T): Promise<T>
  /**
   * Run one prompt admission + commit inside the per-Agent serialization
   * window shared with `/model` selection (rc.2 `serializeImageAdmission`)
   * when `line` references an image draft; a text-only prompt runs directly.
   * This keeps an image capability check + attachment admission + delivery
   * commit atomic against a concurrent model switch. The provider reads the
   * CURRENT Direct attachment at call time — the caller must already hold the
   * writer section for the scope's session.
   */
  withPromptAdmission<T>(scope: LiveSessionScope, line: string, task: () => Promise<T> | T): Promise<T>
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
 * The CURRENT host catalog's view of ONE parsed line (the DSH client
 * `CommandUiRuntime.matchEnter` decision table): whether the host CLAIMS the
 * line, and — for a claimed line — the claiming descriptor's attachment
 * declaration, so the dispatch can never consult two different catalog views
 * for the claim and the declaration.
 */
export type HostCommandClaim =
  | {
    readonly claimed: true
    /** The claiming descriptor's `input.attachments`
     * (DSH `CommandInputDescriptor.attachments`): only a declaring command
     * may be invoked with composer attachments. */
    readonly attachments: boolean
  }
  // The catalog RESOLVES the name but this LINE is not an invocation (an
  // argued line of an execute-kind command): the line is never handed to the
  // command plane, and it is an ordinary submission.
  | { readonly claimed: false }



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
  /** Per-name registration failures (a Host-claimed name degraded loudly;
   *  later registrations still installed). */
  registrationFailures: readonly string[]
  wasAdvertised(name: string): boolean
  /** The CURRENT host catalog's view of ONE parsed line (see
   * {@link HostCommandClaim}): `undefined` when the catalog does not RESOLVE
   * the name, `claimed: false` when it resolves the name without claiming
   * this line. This is the ADVERTISED union view (completion/advertised-miss
   * semantics); routing authority is {@link hostOriginClaimOf}. */
  hostClaimOf(parsed: { name: string; rawInput?: string }): HostCommandClaim | undefined
  /** PR5 v2 §1C-4: the GENUINE Host-origin line authority — the Host
   *  descriptor view with this TUI's own Direct compatibility mirrors
   *  excluded and Client synthesis never able to overwrite it. Routing
   *  (delivery/echo/attachments/command-plane/collision) consumes THIS,
   *  never the advertised union or raw registry membership. */
  hostOriginClaimOf(parsed: { name: string; rawInput?: string }): HostCommandClaim | undefined
  /** §D3 precedence: whether the AUTHORITATIVE HOST catalog (never the
   *  claim-set union, which also carries this surface's own Client
   *  registrations) resolves one slash name. */
  hostCatalogResolves(name: string): boolean
  /** Whether one slash name is a LIVE TUI-owned skill wrapper (an
   * agent-facing invocation whose `/name` line the host may resolve into an
   * injected skill body). */
  isSkillWrapper(name: string): boolean
  /** One synchronous catalog commit (the coordinator's install hook). */
  installSnapshot(snapshot: SurfaceCatalogSnapshot): void
  /** Consume a TUI-local draft disposition correlated by DSH command id.
   * When the command handler throws, no execution result returns the id; in
   * that serialized path the oldest pending disposition is consumed instead. */
  takeCommandDraftDisposition(commandId?: string): CommandDraftDisposition | undefined
  /** Re-synthesize the slash completions from the CURRENT host catalog plus
   * the live client contributions (the extension-invalidate hook: a late
   * contribution joins the menu without waiting for a session refresh). */
  refreshCommandCompletions(): void
  /** The revalidating transition (the coordinator's target-change hook). */
  enterTransition(): void
  /** Bind one submission's resolved delivery mode for the synchronous window
   * that launches a command execution (see the TUI skill handlers). */
  withDelivery<T>(delivery: SubmitDelivery, run: () => T): T
} {
  const { ctx, app } = runner
  const cwd = runner.cwd
  const signal = runner.signal
  const commands = runner.commandRegistry
  const clientCommands = runner.clientCommands
  const recordExtensionError = runner.recordExtensionError
  const clearExtensionError = runner.clearExtensionError
  const captureExtensionHealthRef = runner.captureExtensionHealthRef
  // M3-4 PR4 (§D2): every TUI-owned definition registers into the CLIENT
  // registry unconditionally — that is the Remote branch's ONLY registration
  // (the Host commands service must never receive a TUI callback there). On
  // Direct the Host registration additionally happens below (the compatibility
  // adapter: the in-process dispatch surface — busy-Enter, sessionless
  // execution, `commands/change` refresh — is unchanged). The client registry
  // is a runner assembly dependency; its absence is a composition error.
  if (clientCommands === undefined) throw new Error('client command registry unavailable')

  // Per-name registration isolation (M3-4 PR2), NARROW BY CONSTRUCTION: only
  // the official registry's duplicate-name refusal is tolerated (a Host-owned
  // name such as the Remote Host composition's `/export`), so the remaining
  // built-ins still install. Every OTHER throw from the official registry —
  // an invalid name/description/handler/input, or a Cordis lifecycle failure —
  // is a programming error and fails fast exactly as before (a best-effort
  // whole pass would silently leave a partial command surface).
  const registrationFailures: string[] = []
  // ── Direct compatibility-mirror provenance (PR5 v2 §1C-2) ────────────────
  // A SUCCESSFUL Direct `commands.register` of a TUI-owned definition is a
  // COMPATIBILITY MIRROR: it exists so the in-process dispatch surface
  // (busy-Enter, sessionless execution) keeps working — it is NOT evidence
  // of genuine Host-origin ownership. This set records exactly those
  // successful mirrors so the Host-origin view (§1C-3) can subtract them.
  //   • Only a SUCCESSFUL Host registration marks the name (a duplicate-name
  //     refusal means the pre-existing Host name IS genuine Host authority).
  //   • The marker is removed BEFORE `disposeHost()` runs: disposal fires
  //     `commands/change` SYNCHRONOUSLY, and that refresh must not see the
  //     dying mirror as genuine Host origin.
  //   • `registerOne` is the SINGLE registration seam (built-ins, aliases,
  //     skill wrappers and the revalidating transitions all pass through),
  //     so provenance cannot drift for any registration kind.
  // Remote never populates this set (no Host registration happens there).
  // PR5 v2 §1C-2/§1C-3 (review R6-1): the provenance is the EXACT
  // official `definitionId` this surface stamped onto its own Direct Host
  // registration (created with the official `CommandDefinitionId`
  // constructor — never a string-prefix convention; identity, not
  // authorization). The origin derivation compares the EFFECTIVE WINNER's
  // definitionId against this set: a genuine Agent-scoped Host shadow that
  // overrides our global mirror has its own (or no) definitionId and is
  // therefore genuine Host authority — a name alone never subtracts it.
  const mirrorDefinitionIds = new Set<string>()
  const registerOne = (definition: Parameters<typeof clientCommands.register>[0]): (() => void) => {
    // The CLIENT registration is unconditional (PR4 §D2): the definition is
    // owned here on BOTH branches. A same-name overwrite inside the Client
    // registry is this surface's OWN replace semantics (skill wrappers
    // dispose before re-registering), so it is never a "collision". The
    // Client registration keeps the ORIGINAL identity — only the Direct
    // Host compatibility mirror carries the provenance id.
    const disposeClient = clientCommands.register(definition)
    if (commands === undefined) return disposeClient
    const mirrorName = String((definition as { name?: unknown }).name)
    const mirrorId = CommandDefinitionId(`@xmoon76/dsh-pi-tui/mirror/${mirrorName}`)
    try {
      const disposeHost = commands.register({
        ...definition,
        definitionId: mirrorId,
      })
      mirrorDefinitionIds.add(mirrorId)
      return () => {
        mirrorDefinitionIds.delete(mirrorId)
        disposeHost()
        disposeClient()
      }
    } catch (error) {
      // A Host-side duplicate-name refusal degrades ONLY the Host
      // registration (a Host-owned name such as the Remote Host composition's
      // `/export`): the Client registration stays live — on Remote that IS
      // the execution surface — and the name is reported. Every OTHER throw
      // from the official registry is a programming error and fails fast
      // exactly as before.
      const message = error instanceof Error ? error.message : String(error)
      if (!/^command "[^"]+" is already registered/.test(message)) throw error
      registrationFailures.push(`/${mirrorName}: ${message}`)
      return disposeClient
    }
  }

  // `commands.execute()` normalizes handler results to the official
  // CommandResult shape. Draft restoration therefore travels through this
  // TUI-local side channel, correlated by the execution's command id, rather
  // than through private fields that the Host normalizer discards.
  const commandDraftDispositions = new Map<string, CommandDraftDisposition>()
  const recordCommandDraftDisposition = (commandId: string | undefined, disposition: CommandDraftDisposition): void => {
    if (commandId !== undefined) commandDraftDispositions.set(commandId, disposition)
  }

  // ── submit-resolved delivery binding ────────────────────────────────────
  /**
   * The delivery mode bound to the command execution launched in the CURRENT
   * synchronous window (`withDelivery`). `commands.execute` invokes a
   * resolved handler in the SAME call stack as the dispatch (the TUI submits
   * no attachments), so a TUI-owned skill handler captures its invocation's
   * mode before any await and passes it to the delivery — never re-deriving
   * the mode from the persisted preference, which cannot reconstruct a
   * one-shot gesture (the accelerated chord's opposite mode).
   */
  let boundDelivery: SubmitDelivery | undefined
  /**
   * Bind `delivery` for one synchronous window and run the launch. Commands
   * that own their own busy semantics (Host commands, dispatched without a
   * binding) simply never consume it.
   *
   * The binding belongs to the dispatch that armed it: it is consumed by the
   * TUI-owned handler launched in the SAME synchronous window (a handler
   * that awaits still captures it, because capture is its first statement).
   * KNOWN LIMITATION: a command handler that SYNCHRONOUSLY re-enters the
   * command service (`ctx.commands.execute`) for a TUI skill wrapper would
   * inherit this delivery instead of resolving as "no submission" (queued) —
   * no in-tree caller does that, and the public `CommandRuntime.execute`
   * contract has no channel for a per-invocation mode, so such a caller must
   * pass its own explicit mode rather than rely on the ambient one.
   * @param delivery - the mode the submit boundary resolved for this gesture.
   * @param run - the launch (the command execution) to run inside the window.
   */
  const withDelivery = <T>(delivery: SubmitDelivery, run: () => T): T => {
    const previous = boundDelivery
    boundDelivery = delivery
    try {
      return run()
    } finally {
      // Restore the enclosing window (undefined at the top level).
      boundDelivery = previous
    }
  }
  /**
   * Consume the delivery mode bound for the execution launching in this call
   * stack. `undefined` means no TUI submission launched it (the command
   * plane driven from outside the submit boundary): there is no chord to
   * honor, so the skill delivery falls back to the safe queue mode.
   */
  const takeDelivery = (): SubmitDelivery | undefined => {
    const delivery = boundDelivery
    boundDelivery = undefined
    return delivery
  }


  // Fire-and-forget with the runner's diag: cancellations debug-only,
  // recoverable (persistence) failures notify + warn, everything else
  // warns — never a bare `void somePromise()` (AGENTS.md hard rule). The
  // task is a FACTORY (runDetached runs it), so a synchronous throw from
  // the service call is classified like a rejection, not an escape.
  /** Construct the /new session id (the coordinator owns the dsh-session value
   * import; `src/tui/commands/sessions.ts` consumes the typed result). */
  const newSessionId: NewSessionId = () => SessionId(`session-${randomUUID()}`)

  const detach: DetachTask = (label, task, options = {}) => {
    runDetached(label, task, {
      diag: runner.diag,
      // Diagnostics name the live session at settle time, never the payload.
      sessionId: () => runner.currentSessionId,
      notify: options.notify === true ? (message) => app.notify(message, 'error') : undefined,
      recoverable: options.notify === true ? () => true : undefined,
    })
  }


  // ── completion surface + advertised command claims ─────────────────────
  // The completion list doubles as the ADVERTISED set: every name shown to
  // the user is a claim that submitting `/name` will resolve to a real
  // command. The dispatch captures the claim BEFORE any session creation
  // (wasAdvertised below); a probed command that the real session then
  // lacks must be consumed with an explicit error, never sent to the model.
  /** The advertised HOST commands of the currently installed completion
   * list, by name — the host's AUTHORITY record. A contribution never enters
   * it, and the descriptor's INPUT KIND is kept with it (see
   * {@link hostClaimOf}): the DSH command UI distinguishes a `leadingInput`
   * command (`/goal <objective>`) from an execute-kind one (`/compact`) by
   * `CommandDescriptor.input`, and only the former claims an argued line. */
  let claims = new Map<string, { leadingInput: boolean; attachments: boolean }>()
  /**
   * The detached human skill catalog for INLINE skill reference completion
   * (the plain-text `/name` lexicon). A Client presentation cache: it owns
   * no skill body, no registry, and is NOT an authorization — the Host
   * pre-step decides invocation. Deliberately NOT part of the command
   * `claims`: a skill reference is not a command advertisement (the
   * per-skill command wrappers keep their own completion/claim path, so
   * the command plane can retire them independently later).
   */
  let currentSkillReferences: readonly HumanSkillSummary[] = []
  /** Slash commands whose single argument is a path: the fork's
   * `getArgumentCompletions` extension point completes it against the
   * Client-local cwd (natural typing shows candidates, Tab accepts them).
   * Host session cwd remains reserved for `@` via HostFilePort. */
  const PATH_ARGUMENT_COMMANDS = FILE_ARGUMENT_COMMANDS
  /**
   * Candidate synthesis (the DSH `CommandUiRuntime.candidates` parity): the
   * host catalog merged with the live CLIENT command contributions by name.
   * A contribution whose name is already a host command (or a TUI-owned
   * name) is a COLLISION: this pass FAILS — no merged list is installed, the
   * command source is marked failed downstream (`source-failed` parity
   * withdraws its rows), and EVERY collision of the pass is recorded against
   * its contribution and reported. Never a silent shadow, never a partial
   * list.
   * @param host - the host catalog rows for the current scope.
   * @throws when a contribution collides with a host name.
   */
  const mergeContributions = (host: readonly SurfaceCommandSummary[]): readonly SurfaceCommandSummary[] => {
    const bridge = runner.extensions?.commands
    if (bridge === undefined) return host
    const contributions = bridge.snapshot().entries
    // PURGE the bookkeeping of contributions that are GONE. A disposed
    // contribution leaves the snapshot entirely — the recovery loop below
    // only visits LIVE entries — while its notice key would survive and
    // silence a RE-registration under the same id/owner (a plugin
    // reload/HMR): that is a NEW failure generation, and its health record
    // fails again. The registration's ledger record was untracked with it,
    // so only these local records remain to drop.
    const live = new Set(contributions.map(contribution => contributionIdentity(contribution)))
    for (const identity of [...collisionHealth.keys()]) {
      if (live.has(identity)) continue
      collisionHealth.delete(identity)
      notifiedCollisions.delete(identity)
    }
    if (contributions.length === 0) return host
    const byName = new Map(host.map(entry => [entry.name, entry] as const))
    // Record EVERY collision of this pass before failing it: the health
    // surface must list all offenders, not only the first one scanned.
    const colliding = new Set<string>()
    const collisions: { identity: string; message: string }[] = []
    let firstCollision: Error | undefined
    for (const contribution of contributions) {
      if (!byName.has(contribution.name)) continue
      const identity = contributionIdentity(contribution)
      colliding.add(identity)
      const collision = new Error(`command contribution /${contribution.name} collides with a host command`)
      collisions.push({ identity, message: collision.message })
      const ref = { slot: 'command', id: contribution.id, owner: contribution.owner }
      collisionHealth.set(identity, { ref, message: collision.message })
      recordExtensionError?.(ref, collision)
      firstCollision ??= collision
    }
    // HEALTH RECOVERY, scoped to the COLLISION records this synthesis wrote: a
    // contribution that merges cleanly again is no longer failed — even while
    // another contribution keeps this pass failing. A handler failure that
    // OPENED the record is protected by the message guard below (the ledger
    // deduplicates into it, keeping the handler message); one deduplicated
    // INTO a live collision record is not — the documented diagnostic
    // limitation (docs/surface-decisions.md).
    for (const contribution of contributions) {
      const identity = contributionIdentity(contribution)
      if (colliding.has(identity)) continue
      const recorded = collisionHealth.get(identity)
      if (recorded === undefined) continue
      collisionHealth.delete(identity)
      // A recovered collision may notify again in a later generation.
      notifiedCollisions.delete(identity)
      // Clear ONLY when the health record currently shows OUR collision: the
      // same slot also carries handler runtime failures, and the ledger
      // DEDUPLICATES a later failure into an already-failed record (keeping
      // the first message) — clearing blindly would erase a handler failure
      // that this synthesis never wrote (and that has not recovered). A
      // failure deduplicated into OUR live collision record is
      // indistinguishable here (documented limitation). The record identity
      // is (slot, owner, id): one plugin may legally reuse an id in another
      // slot (a theme and a command), so the extension point MUST match too.
      const current = runner.extensions?.health?.().find(
        entry => entry.extensionPoint === recorded.ref.slot
          && entry.id === recorded.ref.id
          && entry.owner === recorded.ref.owner,
      )
      if (current === undefined || current.state !== 'failed' || current.lastError !== recorded.message) continue
      clearExtensionError?.(recorded.ref)
    }
    if (firstCollision !== undefined) throw Object.assign(firstCollision, { collisions })
    for (const contribution of contributions) {
      byName.set(contribution.name, { name: contribution.name, description: contribution.description })
    }
    return [...byName.values()]
  }
  /**
  /**
   * One collision notice per contribution IDENTITY and failure GENERATION
   * (the key is dropped when the collision recovers): a new owner reusing a
   * released name, or the same contribution colliding again after the host
   * descriptor went away and came back, is surfaced again. A pass that finds
   * a fresh collision anywhere re-states the WHOLE current collision set.
   */
  const notifiedCollisions = new Set<string>()
  /** The identity of one contribution GENERATION (id + owner + registration
   * generation): the owner keeps a reused id honest, and the generation keeps
   * a dispose + re-register under the same id/owner apart — an HMR reload may
   * coalesce both into ONE invalidate flush, so a purge that only observes
   * absent identities can never see the gap. */
  const contributionIdentity = (entry: { id: string; owner: string; generation: number }): string =>
    `${entry.id}\u0000${entry.owner}\u0000${entry.generation}`
  /** The COLLISION records THIS synthesis wrote, by identity — the only
   * health entries a successful merge may clear, and only while the record
   * still shows that collision message (see the recovery loop). */
  const collisionHealth = new Map<string, { ref: { slot: string; id: string; owner: string }; message: string }>()
  const installCompletions = (
    entries: readonly SurfaceCommandSummary[],
    options: { display?: 'merged' | 'none'; claimsFrom?: readonly SurfaceCommandSummary[] } = {},
  ): void => {
    const sorted = [...entries].sort((left, right) => left.name < right.name ? -1 : 1)
    // PR4 §D3: the CLAIM set is the Host authority record. On the Remote
    // branch the display list may be a Client-only merge (an ad-hoc
    // re-synthesis), so the claims are built from the LAST AUTHORITATIVE Host
    // catalog instead — a client-only refresh must never erase a Host claim.
    // The union of (a) the Host-authoritative catalog and (b) THIS surface's
    // own registrations (TUI built-ins + live skill wrappers). On Direct the
    // Host registry already carries (b), so the union is idempotent; on
    // Remote (b) lives only in the Client registry and must still be
    // advertised. A Client-only refresh can never ERASE a Host claim.
    const ownRegistrations = clientCommands.list().map(definition => commandSummaryOf(definition))
    const claimsSource = [...(options.claimsFrom ?? entries), ...ownRegistrations]
      .sort((left, right) => left.name < right.name ? -1 : 1)
    // HOST CLAIMS first: the claim set is the host's AUTHORITY record (the
    // dispatch consults it), so it must never depend on the client merge — a
    // failed synthesis must not cost a host command its claim. The INPUT KIND
    // and the attachment DECLARATION (`CommandInputDescriptor`) ride in the
    // same record: which line the command claims and whether that line may
    // carry attachments are both descriptor facts, so they can never describe
    // two different catalogs.
    claims = new Map(claimsSource.map(command => [command.name, {
      leadingInput: command.input !== undefined,
      attachments: command.input?.attachments === true,
    }]))
    // The display list carries the client contributions too; the CLAIM set
    // never does (see the parameter doc). 'none' is the FAILED-SOURCE state
    // (upstream `source-failed` removes the source's group): no command rows
    // are offered until a synthesis succeeds again, while the claims above
    // stay live.
    const display = options.display === 'none'
      ? []
      : [...mergeContributions(sorted)]
          .sort((left, right) => left.name < right.name ? -1 : 1)
    // M5: the plugin autocomplete chain (AutocompleteRegistry) is consulted
    // after the host's own provider returns null. The registry's suggest()
    // handles cancellation (latest-only commit) and per-provider isolation.
    const extensionAutocomplete = runner.extensions?.autocomplete
    app.setCommandCompletions(
      display.map(command => ({
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
      // session id (session identity when one exists — even mid-transition —
      // the workspace cwd otherwise): a session switch or first create is
      // picked up immediately, never requiring a reinstall.
      () => {
        const sessionId = runner.currentSessionId
        return sessionId === undefined
          ? { kind: 'workspace', cwd: runner.sessionCwd() }
          : { kind: 'session', sessionId }
      },
      // `/attach` and `/image` are Client-local. Direct mode uses the process cwd; a remote
      // adapter can keep this independent from the Host session scope.
      () => runner.cwd,
      // The inline skill reference lexicon rides the same install: the
      // provider completes plain-text `/name` tokens from this detached
      // list, never from the command registry.
      currentSkillReferences,
      // Shell amendment (M3-4 PR3): Host shell completion facts exist only
      // on Direct; Remote must show no shell-specific suggestions at any
      // position (command or path).
      runner.hostShellCompletion,
    )
  }
  /** The saved probed scoped overrides (see installSurfaceSnapshot). */
  let savedScopedCommands: readonly SurfaceCommandSummary[] = []
  /**
   * The LAST AUTHORITATIVE Host command catalog (PR4 §D3): every claim the
   * dispatch consults comes from here, never from a client-merged display
   * list. Written by the snapshot install and by the Direct live read; the
   * Remote branch's ad-hoc completion re-synthesis never touches it.
   */
  let authoritativeHostCatalog: readonly SurfaceCommandSummary[] = []
  /**
   * The GENUINE HOST-ORIGIN descriptor map (PR5 v2 §1C-3): the winning Host
   * descriptor facts (`leadingInput`, `attachments`) per name, built from the
   * authoritative Host catalog with this TUI's own successful Direct
   * compatibility MIRRORS subtracted on Direct (a mirror is execution
   * compatibility, never Host-origin ownership — §1C-2). On Remote the
   * generation-fenced Host snapshot is already mirror-free (the TUI never
   * registers into the Host there). This map is the ONLY Host-name-authority
   * source: Client descriptor synthesis can never overwrite it, and a
   * same-name Client definition never masquerades as Host origin.
   */
  let hostOriginDescriptors = new Map<string, { leadingInput: boolean; attachments: boolean }>()
  /** Derive the Host-origin map from a Host catalog view (§1C-3): the
   *  entries whose EFFECTIVE WINNER is one of THIS surface's own Direct
   *  compatibility mirrors (exact `definitionId` membership — the winner
   *  IS our registered mirror definition) are excluded; every other
   *  winner — including a genuine Agent-scoped Host shadow that overrides
   *  our global mirror — is genuine Host authority and keeps its WINNING
   *  descriptor facts. Remote never sees a mirror id (its Host snapshot
   *  is mirror-free by construction), so the set stays empty there. */
  const deriveHostOriginDescriptors = (hostCatalog: readonly SurfaceCommandSummary[]): void => {
    const derived = new Map<string, { leadingInput: boolean; attachments: boolean }>()
    for (const command of hostCatalog) {
      if (command.definitionId !== undefined && mirrorDefinitionIds.has(command.definitionId)) continue
      derived.set(command.name, {
        leadingInput: command.input !== undefined,
        attachments: command.input?.attachments === true,
      })
    }
    hostOriginDescriptors = derived
  }
  /**
   * The sessionless completion view: the CURRENT global layer (fresh read —
   * TUI built-ins, global plugins and installed skill wrappers all flow in)
   * overlaid with the saved scoped overrides from the latest snapshot.
   */
  const mergeGlobalAndSavedScoped = (): readonly SurfaceCommandSummary[] => {
    const byName = new Map<string, SurfaceCommandSummary>()
    // The global baseline is branch-aware (PR4 §D2): Direct reads the Host
    // registry's global layer (TUI built-ins flow in through the compatibility
    // registration); Remote builds it from the CLIENT registry's own
    // descriptors — the Host commands service is metadata-only there and its
    // in-process `list` must never be consulted for the TUI's registrations.
    if (commands !== undefined) {
      for (const descriptor of listGlobalCommands(commands)) {
        byName.set(descriptor.name, commandSummaryOf(descriptor))
      }
    }
    for (const definition of clientCommands.list()) {
      byName.set(definition.name, commandSummaryOf(definition))
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
  /**
   * The CONTAINING seam every catalog commit funnels through: a failed
   * candidate synthesis (a contribution/host name collision) installs no
   * merged list — the source's rows are withdrawn downstream — while every
   * collision is already recorded on its contribution's health and reported
   * to the user. The HOST CLAIMS were refreshed before the merge, so a
   * collision never costs a host command its claim.
   * @param entries - the host catalog rows for the current scope.
   */
  const installCompletionsContained = (
    entries: readonly SurfaceCommandSummary[],
    options: { claimsFrom?: readonly SurfaceCommandSummary[] } = {},
  ): void => {
    try {
      installCompletions(entries, options)
    } catch (error) {
      // The failed pass marks the command SOURCE failed (upstream
      // `source-failed` parity: the source's whole group is removed): no
      // command row — client OR host — is offered until a synthesis succeeds
      // again, so no displayed row can ever execute a different command than
      // it shows. The HOST CLAIMS were refreshed before the merge, so the
      // input authority of a host command is never lost while the menu is
      // empty.
      const message = safeErrorMessage(error)
      // A failed pass surfaces EVERY collision it found, not only the first:
      // with one notice slot, the aggregated text names all offenders. It
      // notifies only while at least one identity is FRESH (per identity and
      // failure generation), so a refresh re-failing on the same collisions
      // stays silent instead of re-raising the notice. A throw carrying no
      // collision list (a core bug, not a contribution) falls back to its own
      // message as the notice identity.
      const reported = (error as { collisions?: readonly { identity: string; message: string }[] })
        .collisions ?? [{ identity: message, message }]
      const fresh = reported.filter(entry => !notifiedCollisions.has(entry.identity))
      if (fresh.length > 0) {
        for (const entry of fresh) notifiedCollisions.add(entry.identity)
        app.notify(reported.map(entry => entry.message).join(' · '), 'error')
      }
      try {
        ctx.logger.error(`tui-runner: ${message}`)
      } catch {
        // The cordis logger must not block the submission path.
      }
      try {
        installCompletions(entries, { display: 'none', ...options })
      } catch {
        // Clearing the display is plain work: a failure here is a core bug,
        // not a contribution problem — leave the previous list in place.
      }
    }
  }
  const refreshCompletions = (): void => {
    // The sessionless view keeps the saved scoped overrides (the standing
    // snapshot's scoped commands); a live session reads its own scoped view
    // — MERGED with the Client registry's own descriptors on every branch
    // (PR4 §D2): the Client registrations are visible even where the scoped
    // view's Host source does not carry them (Remote).
    //
    // PR4 §D3: the DISPLAY list and the CLAIM source are separate inputs.
    // The Direct live read IS the Host authority (refresh it); the Remote
    // branch's view is a Client-side merge, so its claims keep coming from
    // the last authoritative Host catalog the coordinator installed.
    if (runner.currentSessionId === undefined) {
      const entries = mergeGlobalAndSavedScoped()
      if (commands !== undefined) {
        // PR5 v2 §1C-3 (review R6-2): the SESSIONLESS Host authority is the
        // pure Host view — the global layer plus the SAVED SCOPED overrides
        // (both Host-sourced) — NEVER the Client-synthesized display merge
        // (whose by-name Client definitions would overwrite a genuine Host
        // descriptor such as the rc.2 Host `/export`). The display list and
        // the advertised claims keep the merged `entries`.
        const hostView = [...listGlobalCommands(commands).map(commandSummaryOf).reduce(
          (byName, descriptor) => { byName.set(descriptor.name, descriptor); return byName },
          new Map<string, SurfaceCommandSummary>(),
        ).values()]
        for (const scoped of savedScopedCommands) {
          const idx = hostView.findIndex(row => row.name === scoped.name)
          if (idx >= 0) hostView[idx] = scoped
          else hostView.push(scoped)
        }
        authoritativeHostCatalog = entries
        deriveHostOriginDescriptors(hostView)
      }
      installCompletionsContained(entries, commands === undefined
        ? { claimsFrom: authoritativeHostCatalog }
        : {})
      return
    }
    const scoped = runner.listScopedCommands()
    if (commands !== undefined) {
      authoritativeHostCatalog = scoped
      deriveHostOriginDescriptors(scoped)
    }
    const byName = new Map<string, SurfaceCommandSummary>()
    for (const entry of scoped) byName.set(entry.name, entry)
    for (const definition of clientCommands.list()) {
      byName.set(definition.name, commandSummaryOf(definition))
    }
    installCompletionsContained([...byName.values()], commands === undefined
      ? { claimsFrom: authoritativeHostCatalog }
      : {})
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
  const registerTuiCommand: RegisterTuiCommand = (spec): void => {
    registerOne({
      name: spec.name,
      description: spec.description,
      ...(spec.input === undefined ? {} : { input: spec.input }),
      handler: spec.handler,
    })
    for (const alias of spec.aliases ?? []) {
      const handler = spec.aliasHandlers?.[alias] ?? spec.handler
      registerOne({
        name: alias,
        description: spec.aliasDescriptions?.[alias] ?? `${spec.description} (alias of /${spec.name})`,
        ...(spec.input === undefined ? {} : { input: spec.input }),
        handler,
      })
    }
  }

  // ── Built-in command registration order (FROZEN) ─────────────────────────
  // Domain definitions live in `src/tui/commands/*.ts`; this coordinator owns the
  // single registration/catalog state machine and calls each registrar at its
  // exact historical position. Do not reorder by module grouping: the
  // synchronous `commands/change` effects and the Direct compatibility mirror
  // depend on the sequence.
  registerExitCommand({ runner, registerTuiCommand })

  const settingsCommands = createSettingsCommands({
    runner,
    app,
    registerOne,
    registerTuiCommand,
    detach,
    recordExtensionError,
    clearExtensionError,
    captureExtensionHealthRef,
  })
  settingsCommands.registerSettings()
  settingsCommands.registerFooter()
  settingsCommands.registerDisplay()
  settingsCommands.registerFocus()

  const sessionCommands = createSessionCommands({
    runner,
    app,
    registerOne,
    registerTuiCommand,
    detach,
    recordCommandDraftDisposition,
    newSessionId,
  })
  sessionCommands.registerSessions()

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
   * @param scope - the captured owner identity at the caller's resolution
   *   boundary; every await below re-fences against it. Capturing it here
   *   instead would lose the check that the PASSED owner is still the current
   *   one on the async picker path.
   * @param delivery - the delivery mode the caller's boundary resolved for
   *   this gesture, or undefined when no TUI submission launched it.
   */
  const loadSkill = async (
    scope: LiveSessionScope,
    name: string,
    args = '',
    signal: AbortSignal = runner.signal,
    delivery: SubmitDelivery | undefined,
    commandId?: string,
  ): Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }> => {
    const skillSignal = signal === runner.signal ? runner.signal : AbortSignal.any([runner.signal, signal])
    skillSignal.throwIfAborted()
    // PR4 §1.6 (D4) — the REMOTE literal-gesture path: the Client NEVER loads
    // a skill body there (no `skills/read` exists on the wire), so the whole
    // definition resolution is skipped. The wrapper's OWN live presence in
    // the human catalog (isSkillWrapperName) is the claim the caller already
    // validated; the Host's dsh-tool-skill pre-step owns body resolution,
    // isUserInvocable re-check and injection at gesture time.
    const remoteLiteralGesture = runner.commandRegistry === undefined
    let resolved: SkillDefinitionResult | undefined
    if (!remoteLiteralGesture) {
      // The scope-bound catalog facade validates the captured owner BEFORE the
      // dispatch and again after the read settles — the scope is never downgraded
      // to a bare session id handed to a current-owner resolver.
      try {
        resolved = await runner.resolveScopedSkill(scope, name)
      } catch (error) {
        if (error instanceof SupersededReadError) {
          return { kind: 'error', text: 'the session changed while loading the skill — try again' }
        }
        throw error
      }
      skillSignal.throwIfAborted()
      if (!runner.isSessionScopeCurrent(scope)) {
        return { kind: 'error', text: 'the session changed while loading the skill — try again' }
      }
      if (resolved!.kind === 'unavailable') return { kind: 'error', text: 'skill service unavailable' }
      if (resolved!.kind === 'unknown') return { kind: 'error', text: 'unknown skill "' + name + '"' }
      if (resolved!.kind === 'malformed') return { kind: 'error', text: `skill "${name}" returned a malformed definition` }
      const skill = resolved!.skill
      if (!isUserInvocableSkill(skill)) return { kind: 'error', text: `skill "${name}" is not invocable by the user` }
    }
    // Web parity (the dsh-tool-skill pre-step boundary): a user-explicit
    // skill invocation is a PLAIN user message whose leading `/name` line
    // the host recognizes — the user's own words (including any `/name args`
    // the wrapper was invoked with) always travel as the original text, and
    // the rendered skill body follows as injected instructions context.
    // Arguments are never carved out and never dropped: the bug this fixes
    // was the wrapper discarding `rawInput` and injecting a hand-rolled body
    // card that swallowed the user's request.
    const line = remoteLiteralGesture || resolved === undefined || resolved.kind !== 'found'
      ? (args.trim() === '' ? '/' + name : '/' + name + ' ' + args.trimStart())
      : (() => {
        const skill = resolved.skill
        return args.trim() === '' ? '/' + skill.name : '/' + skill.name + ' ' + args.trimStart()
      })()
    // The skill invocation is an AGENT-FACING prompt: build its message
    // through the shared prepared-input pipeline so an image-bearing
    // `/skill [image #1 ...]` line is a real multimodal prompt, exactly
    // like a plain prompt (review finding 4). The referenced drafts are
    // pinned across the WHOLE invocation — the async prepare, the steer
    // and the draft consumption — so a concurrent /image prune can never
    // delete images this invocation is still admitting (review finding 1).
    // The host's pre-step listener (dsh-tool-skill) injects the rendered
    // body only when its tool registration is visible to this agent. Probe
    // that semantic catalog fact before choosing the delivery path.
    let hostLoadsSkillBody = false
    try {
      hostLoadsSkillBody = runner.hostLoadsSkillBody(scope)
    } catch (error) {
      if (error instanceof SupersededReadError) {
        return { kind: 'error', text: 'the session changed while loading the skill — try again' }
      }
      throw error
    }
    // When the Host skill pre-step is absent, deliver the original invocation
    // and its rendered body as two ordered single prompts. This preserves the
    // original-line-before-body ordering without bypassing the semantic writer.
    // Remote (the literal-gesture branch) never builds a fallback body: there
    // is no Client-side definition to render, and its composition invariant
    // already answers hostLoadsSkillBody=true.
    const fallbackBody = !hostLoadsSkillBody && !remoteLiteralGesture && resolved !== undefined && resolved.kind === 'found'
      ? (() => {
        const skill = resolved.skill
        const body = typeof skill.content === 'string' && skill.content !== '' ? skill.content : skill.description
        const resourceBase = readResourceBase(skill.resourceBase)
        return createUserMessage({
          content: [{ type: 'text', text: renderSkillContent({
            name: skill.name,
            provider: typeof skill.provider === 'string' && skill.provider !== '' ? skill.provider : 'tui',
            ...resourceBase === undefined ? {} : { resourceBase },
            content: body,
          }) }],
          source: { kind: 'skill-invocation', name: skill.name, form: 'instructions' },
        })
      })()
      : undefined
    // Acquire the pin HERE, immediately before the `try` that owns its release:
    // every earlier step is synchronous, so a throw above can no longer strand
    // the pin and permanently block pruning of the referenced drafts.
    const releasePin = pinDraftAttachments(line, runner.imageStore, runner.fileStore)
    let userMessage: import('@deepseek-ai/dsh-llm').UserMessage | undefined
    // The delivery payload the session writer receives: on Remote the writer's
    // serializer requires the PreparedPrompt built by the SAME transport-aware
    // preparation the ordinary submission uses; on Direct the immutable
    // UserMessage stays the contract.
    let deliveryMessage: unknown
    try {
      // A transition ALREADY pending when this invocation is about to enter the
      // writer is refused by the admission itself (draft restored by the catch
      // below). Once the writer owns the barrier, a transition that starts LATER
      // MUST wait for this writer to drain — `SessionOperationBarrier`'s
      // writer-first contract — so there is deliberately NO transition re-check
      // inside the section (a re-check would let a later transition cancel a
      // writer that started first).
      // The whole image admission + commit runs inside the operation barrier
      // (transition drain) and, when the invocation references an image draft,
      // inside the SAME per-Agent serialization window as a `/model` selection
      // (rc.2 `serializeImageAdmission`): a concurrent model switch can never
      // change the model between the image capability check and the commit.
      const admission = await runner.withWriter(scope, () =>
        runner.withPromptAdmission(scope, line, async (): Promise<
          | { readonly kind: 'stale' }
          | { readonly kind: 'written'; readonly outcome: Awaited<ReturnType<typeof runner.sessionWriter.prompt>> | undefined }
        > => {
          skillSignal.throwIfAborted()
          if (!runner.isSessionScopeCurrent(scope)) return { kind: 'stale' }
          deliveryMessage = runner.prepareTransportMessage !== undefined
            ? await runner.prepareTransportMessage(line, commandId ?? `skill-${name}`)
            : (userMessage = await runner.prepareDraftMessage(line))
          skillSignal.throwIfAborted()
          if (!runner.isSessionScopeCurrent(scope)) return { kind: 'stale' }
          // Web parity (busyEnter): a skill invocation is an agent-facing
          // prompt — under the queue mode it QUEUES like a plain prompt
          // (web: session.prompt with the policy-resolved mode). The mode
          // was resolved ONCE at the gesture's own boundary and handed in;
          // re-deriving it here from the persisted preference would lose the
          // accelerated chord's opposite mode, which exists only in the
          // dispatch that resolved it.
          // The no-loader fallback follows the dsh-web style: the original line
          // and the rendered body are two ordered steer prompts. This is
          // intentionally best-effort rather than a same-step batch; if the
          // first prompt does not commit, the body is never sent.
          if (delivery !== 'steer' && hostLoadsSkillBody) {
            return { kind: 'written', outcome: await runner.sessionWriter.prompt(scope.sessionId, deliveryMessage, 'queue') }
          }
          if (fallbackBody !== undefined) {
            const first = await runner.sessionWriter.prompt(scope.sessionId, deliveryMessage, 'steer')
            if (first.kind !== 'committed') return { kind: 'written', outcome: first }
            // The original invocation is durable once the first prompt
            // commits. Consume its attachments before the body prompt so a
            // later body failure cannot make a retry duplicate the line or
            // re-admit its images.
            try {
              consumeDraftAttachments(line, runner.imageStore, runner.fileStore)
              const body = await runner.sessionWriter.prompt(scope.sessionId, fallbackBody, 'steer')
              if (body.kind !== 'committed') recordCommandDraftDisposition(commandId, 'suppressed')
              return { kind: 'written', outcome: body }
            } catch (error) {
              // The first prompt already committed; the outer command sink
              // must not restore/replay its invocation after a body failure.
              recordCommandDraftDisposition(commandId, 'suppressed')
              throw error
            }
          }
          return { kind: 'written', outcome: await runner.sessionWriter.prompt(scope.sessionId, deliveryMessage, 'steer') }
        }))
      if (admission.kind === 'stale') return { kind: 'error', text: 'the session changed while loading the skill — try again' }
      const outcome = admission.outcome
      if (outcome === undefined) return { kind: 'error', text: 'the session changed while loading the skill — try again' }
      if (outcome.kind !== 'committed') {
        if (outcome.kind === 'indeterminate') { throw new IndeterminateSkillWriteError() }
        if (outcome.kind === 'cancelled') throw cancellationError('skill write cancelled')
        const message = outcome.kind === 'rejected' ? outcome.error.message : outcome.reason
        return { kind: 'error', text: message }
      }
    } catch (error) {
      if (error instanceof TransitionInProgressError) {
        const merged = mergeDraft(app.getDraft(), line)
        app.setEditorText(merged)
        recordCommandDraftDisposition(commandId, 'restored')
        return { kind: 'error', text: merged === line
          ? 'a session transition is in progress — try again in a moment'
          : 'the draft changed while transitioning — review it before submitting again' }
      }
      // A stale capture is refused at the writer admission (BEFORE the task
      // body) with its OWN signal — never the frozen-transition refusal. It
      // takes the same user-visible stale path as the in-task scope checks.
      if (error instanceof SessionScopeSupersededError) {
        return { kind: 'error', text: 'the session changed while loading the skill — try again' }
      }
      throw error
    } finally {
      // The pin releases on EVERY exit — including a synchronous steer
      // throw (review finding: a leaked pin would block pruning and eat
      // draft capacity forever).
      releasePin()
    }
    // The invocation COMMITTED: consume the image drafts it referenced (the
    // prepared message holds the durable refs now; a concurrent intake's newer
    // draft survives — review finding).
    consumeDraftAttachments(line, runner.imageStore, runner.fileStore)
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
    const view = runner.listScopedCommands()
    for (const command of view) if (!owned.has(command.name)) taken.add(command.name)
    for (const name of scopedNames) taken.add(name)
    // §D3: the AUTHORITATIVE Host catalog participates in the collision
    // baseline — a skill wrapper must never register over a live Host
    // command name (on Remote, `listScopedCommands()` is the Client
    // registry's view, which does NOT carry the Host descriptors).
    for (const command of authoritativeHostCatalog) taken.add(command.name)
    for (const dispose of skillDisposers.values()) dispose()
    skillDisposers.clear()
    let count = 0
    for (const skill of skills) {
      // A colliding name (a built-in, a scoped command or another plugin's
      // command) skips the slash command; the catalog picker still lists it.
      if (taken.has(skill.name)) continue
      try {
        const dispose = registerOne({
          name: skill.name,
          description: '[skill] ' + skill.description,
          // §1C-6 (whole-PR F4 sink): a per-skill wrapper CLAIMS its argued
          // line (`/name args` — everything after the name is the skill's
          // args), exactly like a Host skill command's leading input. Without
          // the descriptor the Client registry's exact-line admission rejects
          // the argued gesture at `execute()`, and the wrapper's own handler
          // never runs on the Remote branch (the line is swallowed instead of
          // delivered).
          input: { hint: '<args>' },
          // The handler captures ONLY the skill name; execution re-fetches
          // from the current live agent and re-checks the policy. Trailing
          // input (`/name args`) travels VERBATIM as the invocation's
          // arguments (web parity: the user's words stay on the original
          // line, never carved out or dropped — the wrapper's own name is
          // the skill name, everything after it is args).
          handler: async (invocation) => {
            // The FIRST synchronous statement: the submit boundary bound this
            // invocation's delivery mode for exactly this call stack (see
            // withDelivery). Everything below may await.
            const delivery = takeDelivery()
            const scope = await runner.requireLiveSessionScope()
            return loadSkill(scope, skill.name, invocation?.rawInput ?? '', invocation?.signal ?? runner.signal, delivery, invocation?.commandId)
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
    // The snapshot's command rows ARE the Host authority (PR4 §D3); the
    // Host-origin map derives with the same mirror subtraction (§1C-3).
    authoritativeHostCatalog = snapshot.commands
    deriveHostOriginDescriptors(snapshot.commands)
    const scopedNames = new Set(snapshot.scopedCommands.map(command => command.name))
    const skillsFailed = snapshot.issues.some(issue => issue.provider === 'skills')
    withCommandCommit(() => {
      if (!skillsFailed) replaceSkillCommands(snapshot.skills, scopedNames)
      // The inline skill lexicon follows the same success rule as the
      // wrappers: a FAILED or incomplete skills observation never replaces
      // the current lexicon (a target change already cleared it; a
      // same-target refresh keeps the last-good list — the coordinator's
      // mergePartial already retained it in `snapshot.skills`).
      if (!skillsFailed) currentSkillReferences = snapshot.skills
      savedScopedCommands = snapshot.scopedCommands
      // PR4 §D3: the claim source is branch-dependent. On DIRECT the merge
      // below reads the LIVE Host global layer (TUI registrations + every
      // in-process Host command), which IS the authority. On REMOTE that
      // merge is a Client-only view (no Host global layer exists there), so
      // the claims come from THIS snapshot's command rows instead — a
      // Client-only re-synthesis must never erase a Host claim.
      installCompletionsContained(
        mergeGlobalAndSavedScoped(),
        commands === undefined ? { claimsFrom: snapshot.commands } : {},
      )
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
      // The inline skill lexicon clears with the target change: the new
      // owner's suggestions must never come from the old owner's catalog.
      currentSkillReferences = []
      for (const name of names) {
        try {
          const dispose = registerOne({
            name,
            description: `[skill: revalidating] ${name}`,
            // §1C-6 (whole-PR F4 sink): the revalidating transition claims its
            // argued line exactly like the direct wrapper — it accepts
            // `/name args` and forwards them to loadSkill, so the Client
            // registry's exact-line admission must accept it too.
            input: { hint: '<args>' },
            handler: async (invocation) => {
              // Captured before any await, exactly like the direct wrapper.
              const delivery = takeDelivery()
              const scope = await runner.requireLiveSessionScope()
              return loadSkill(scope, name, invocation?.rawInput ?? '', invocation?.signal ?? runner.signal, delivery, invocation?.commandId)
            },
          })
          skillDisposers.set(name, dispose)
        } catch {
          // Registration raced with another plugin; the picker still works.
        }
      }
      installCompletionsContained(mergeGlobalAndSavedScoped())
    })
  }
  /** Whether one command name is advertised by the CURRENT completion list
   * (the claim captured at submit time, before any session creation). */
  const wasAdvertised = (name: string): boolean => claims.has(name)
  /** The CURRENT host catalog's view of ONE parsed line (see
   * {@link HostCommandClaim}): `undefined` when the catalog does not RESOLVE
   * the name at all (a session-scoped command the standing view cannot see —
   * the command plane decides), `claimed: false` when it resolves the name
   * but this line is not an invocation (an argued line of an execute-kind
   * command: a bare token is claimed by every host command, an argued line
   * only by a `leadingInput` descriptor).
   * HOST AUTHORITY: a client command contribution never removes a name from
   * this catalog — upstream's candidate synthesis merges contributions with
   * the host catalog and FAILS LOUD on a collision instead of shadowing, so
   * a resolved host command always keeps its execution. A skill wrapper is a
   * thin agent-facing invocation (loadSkill builds the prompt), never a host
   * claim. */
  const hostClaimOf = (parsed: { name: string; rawInput?: string }): HostCommandClaim | undefined => {
    // A TUI-owned skill wrapper is an agent-facing invocation — never a
    // Host-command claim (its `/name args` line still belongs to the command
    // PLANE through the LOCAL/skill ownership checks). §D3 Host-vs-wrapper
    // PRECEDENCE is decided separately by `hostOriginClaimOf` against the
    // GENUINE Host-origin descriptors, so a wrapper sharing a REAL Host name
    // can never shadow it (the registration side also refuses taken Host
    // names).
    if (skillDisposers.has(parsed.name)) return undefined
    const descriptor = claims.get(parsed.name)
    if (descriptor === undefined) return undefined
    if (!descriptor.leadingInput && (parsed.rawInput?.trim() ?? '') !== '') return { claimed: false }
    return { claimed: true, attachments: descriptor.attachments }
  }

  /**
   * The ONE Host-origin line authority (PR5 v2 §1C-4): the GENUINE
   * Host-origin descriptor view of ONE parsed line, excluding this TUI's own
   * successful Direct compatibility mirrors (§1C-2) and never influenced by
   * Client descriptor synthesis (§1C-3).
   *
   *   `undefined`          — no genuine Host-origin command owns the name.
   *   `{ claimed: false }` — a genuine Host command owns the NAME but does
   *                          not claim THIS exact line (an execute-kind
   *                          descriptor with trailing input): the line is an
   *                          ordinary submission whose name is Host-reserved.
   *   `{ claimed: true, attachments }` — a genuine Host command owns the
   *                          name AND claims this exact line; `attachments`
   *                          is the HOST descriptor's own declaration.
   *
   * Routing (delivery, echo, attachments, the command plane, collisions)
   * must consume THIS primitive — never `hostClaimOf` (the advertised
   * union view) or `hostCatalogResolves` (raw registry membership).
   */
  const hostOriginClaimOf = (parsed: { name: string; rawInput?: string }): HostCommandClaim | undefined => {
    // §1C-4 (review R7-3): the GENUINE Host-origin descriptor is consulted
    // FIRST. A live TUI skill wrapper must not erase a Host winner that was
    // installed LATER: the registration side refuses to mirror a name the
    // Host already owns, but the reverse order (wrapper first, then a plugin's
    // genuine Agent-scoped Host command) leaves the wrapper disposer live, so a
    // name-based wrapper shortcut would hide that Host winner forever. When no
    // genuine Host descriptor owns the name the lookup below is `undefined`
    // anyway, so the wrapper term is not needed here at all.
    const descriptor = hostOriginDescriptors.get(parsed.name)
    if (descriptor === undefined) return undefined
    if (!descriptor.leadingInput && (parsed.rawInput?.trim() ?? '') !== '') return { claimed: false }
    return { claimed: true, attachments: descriptor.attachments }
  }

  const skillsCommandDeps: SkillsCommandDeps = {
    runner,
    app,
    registerOne,
    detach,
    recordExtensionError,
    clearExtensionError,
    captureExtensionHealthRef,
    loadSkill,
    takeDelivery,
    splitSkillLine,
    resolveComposerDelivery,
  }
  registerSkillCommand(skillsCommandDeps)



  registerReloadCommand(skillsCommandDeps)
  const modelCommands = createModelCommands({ runner, app, registerOne, recordCommandDraftDisposition })
  modelCommands.registerModel()

  sessionCommands.registerNew()

  registerTasksCommand({ runner, registerTuiCommand })

  // `/plugins` (P1-A): the canonical sessionless entry into the shared
  // profile-wide Plugin Manager surface (see `src/tui/commands/tasks.ts`).
  registerPluginsCommand({ runner, registerTuiCommand })

  // `/permission` is NOT registered here: dsh-permission-presets in the
  // base layer already registers it (text form: `/permission` shows the
  // current preset, `/permission <name>` switches). Registering it again
  // would throw "command already registered" and kill the TUI.
  // `/yolo` IS a TUI-owned alias: it delegates to the official command line,
  // so the switch takes the exact official path (sandbox + live approval
  // writer + the injected policy-change model message + the preset log).
  modelCommands.registerYolo()

  modelCommands.registerPreset()

  sessionCommands.registerSearch()


  sessionCommands.registerTitle()

  const artifactCommands = createArtifactsCommands({ runner, app, registerOne, registerTuiCommand, detach })
  artifactCommands.registerCopy()


  artifactCommands.registerAttach()

  artifactCommands.registerExport()

  artifactCommands.registerTranscript()

  sessionCommands.registerFork()

  sessionCommands.registerRewind()

  registerStatusCommand({ runner, registerOne })

  const authCommands = createAuthCommands({ runner, app, registerOne })
  authCommands.registerLogin()

  authCommands.registerLogout()

  registerHelpCommand({ runner, registerOne })

  // M4: the keybinding command. Bare /keybindings opens the action-first
  // Keyboard Shortcuts Editor; conflicts/reload/reset remain read-only or
  // explicit diagnostics seams and persist only through the settings port.
  settingsCommands.registerKeybindings()

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
      currentSkillReferences = initial.skills!.skills
      savedScopedCommands = []
      installCompletionsContained(mergeGlobalAndSavedScoped())
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
  // use withCommandCommit instead). Direct-only: the Host event exists only
  // where the in-process commands service does (Remote has no such event
  // seam; its catalog refresh boundaries own freshness instead).
  if (commands !== undefined) {
    ctx.on('commands/change', () => {
      if (commandCommitDepth > 0) {
        commandCommitDirty = true
        return
      }
      refreshCompletions()
    })
  }
  return {
    /** Per-name registration failures (a Host-claimed name degraded loudly;
     *  later registrations still installed). */
    registrationFailures,
    /** The claim test for the dispatch: is /name advertised right now? */
    wasAdvertised,
    /** The host catalog's view of ONE parsed line (see
     * {@link HostCommandClaim}): the name is advertised by the completion list
     * and owned by neither the TUI as a skill wrapper nor an extension
     * contribution (the dispatch caller excludes TUI-local commands itself via
     * LOCAL_COMMANDS). */
    hostClaimOf,
    hostOriginClaimOf,
    /** §D3 precedence discriminator: whether a GENUINE HOST-ORIGIN command
     *  (§1C-3: the authoritative Host catalog minus this TUI's own Direct
     *  compatibility mirrors — never raw registry membership, never the
     *  claim-set union) resolves one slash name. A same-named TUI built-in
     *  or skill wrapper must never shadow a resolved Host command. */
    hostCatalogResolves: (name: string): boolean =>
      // PR5 v2 §1C-4: NAME authority is the GENUINE Host-origin view — the
      // authoritative catalog with this TUI's own Direct compatibility
      // mirrors subtracted. Raw registry membership is NOT Host origin (a
      // successfully mirrored TUI built-in must still answer false here).
      hostOriginDescriptors.has(name),
    /** Whether one slash name is a LIVE TUI-owned skill wrapper (the
     * revalidating transition wrappers included). */
    isSkillWrapper: (name: string): boolean => skillDisposers.has(name),
    /** One synchronous catalog commit (the coordinator's install hook). */
    installSnapshot: (snapshot: SurfaceCatalogSnapshot): void => installSurfaceSnapshot(snapshot),
    refreshCommandCompletions: (): void => refreshCompletions(),
    /** The revalidating transition (the coordinator's target-change hook). */
    enterTransition: (): void => enterCatalogTransition(),
    withDelivery,
    takeCommandDraftDisposition: (commandId?: string): CommandDraftDisposition | undefined => {
      if (commandId !== undefined) {
        const disposition = commandDraftDispositions.get(commandId)
        commandDraftDispositions.delete(commandId)
        return disposition
      }
      const pending = commandDraftDispositions.entries().next()
      if (pending.done) return undefined
      commandDraftDispositions.delete(pending.value[0])
      return pending.value[1]
    },
  }
}
