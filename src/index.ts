/**
 * @xmoon76/dsh-pi-tui — the bundle's runner plugin. Waits for the startup
 * service (the parsed `dsh --profile pi-tui` flags) and Loader settlement,
 * creates or resumes an Agent through the core registry, renders its session
 * log into the TUI transcript, and routes editor submissions back through
 * `agent.followup`. Streaming arrives through the `session/event` firehose;
 * a persistent `TranscriptFolder` folds appended events incrementally and a
 * coalesced repaint flushes the windowed transcript (older turns collapse
 * into a summary), so long sessions never re-scan the whole log per event.
 *
 * KEYS ARE NOT HARD-CODED HERE: host shortcuts are semantic actions (app.*)
 * resolved through the user-orchestrable keymap; the single source of truth
 * for default keys is src/keybindings/definitions.ts and the effective map
 * is inspectable at runtime with `/keybindings`. User-FACING strings derive
 * key labels through the keymap's keyHint(); key
 * names in comments are shorthand for the default binding and must never be
 * relied on as the live binding.
 * @module @xmoon76/dsh-pi-tui
 */

import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallId, ContentBlock } from '@deepseek-ai/dsh-llm'
// P7d: the subagent registry merge for ctx.subagents (listChildren/interrupt).
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
// P6: the agent-preset roster — ctx.agentPresets and the
// `agent-preset/selected` session projection owned by DSH.
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-tool-todo'
import { resolvePresetRequest } from './runtime/session-preset.ts'
import { recordedSessionPreset, sessionPresetOf } from './runtime/direct/session-preset-direct.ts'
import { DirectModelSelectionOwner, type DefaultModelServiceLike } from './runtime/direct/model-selection-direct.ts'
import { foldPendingModelSelection, rawSelectionFromRequestHeader } from './model-selection.ts'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
// The approval/request waterfall merge: the TUI is the interactive answerer.
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
// The commands service merge: ctx.commands typing for execute()/register().
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-commands'
// The skill registry merge for the /skill command.
import type {} from '@deepseek-ai/dsh-skill'
// The settings service merge for persisting TUI preferences.
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-settings'
// The user-questions service merge: ctx.userQuestions for ask_user_question.
import type {} from '@deepseek-ai/dsh-user-questions'
// The plan-mode merge for the header badge (the fold is local — alpha.2
// replaced dsh-plan-mode's exported fold with the `plan` projection).
import type {} from '@deepseek-ai/dsh-plan-mode'
// The persistence service for the session picker.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-settings'
// P5d service/event merges: goal badge, background jobs, permission
// presets, session titles, and the workflow/retry folds (transcript.ts).
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-jobs'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-permission-presets'
// The sandbox/mode knob event merge (permission presets fold it too).
// Alpha.4 removed the effectiveSandboxMode fold export: the sandbox fact
// is read through the official sandboxPolicy service (derive-access), so
// this import is type-only (the module augmentation) and never a value
// dependency.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
// P5e merges: shell capability for `!` mode and credentials for /login.
import type {} from '@deepseek-ai/dsh-shell'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { TUI_STARTUP_SERVICE } from './startup.ts'
import { toolPresenterFrom, type ToolDefinitionLike } from './present.ts'
import { childOwnEvents, textOf, TranscriptFolder, type TranscriptSearchMatch } from './transcript.ts'
import type { TranscriptMessage, TranscriptWindow } from './transcript.ts'
import { TranscriptWindowController } from './transcript-window.ts'
import type { TranscriptWindowState } from './transcript-window.ts'
import { focusModeOf, installFocusPrompt, type FocusState } from './focus.ts'
import { CompletionNotificationController } from './notification/controller.ts'
import { parseNotificationMethod, parseNotificationMode } from './notification/settings.ts'
import { DISABLE_FOCUS_REPORTING, ENABLE_FOCUS_REPORTING, FOCUS_IN_SEQUENCE, FOCUS_OUT_SEQUENCE, TerminalFocusTracker } from './notification/terminal-focus.ts'
import { guardedStreamWriter, TerminalNotifier } from './notification/terminal-notifier.ts'
import { formatStats, StatsFolder } from './stats.ts'
import { hydrateSessionUi } from './session-ui-hydrate.ts'
import { plainSectionEqual } from './status/equal.ts'
import { deriveRunnerPermission } from './status/derive-permission.ts'
import { StatusStore } from './status/store.ts'
import { initialStatusSnapshot } from './status/snapshot.ts'
import { deriveAccessStatus } from './status/derive-access.ts'
import { derivePlanStatus, projectedPlanActive, type PlanProjectionLike } from './status/derive-plan.ts'
import { usageFromStats } from './status/derive-usage.ts'
import { resolveDisplaySubject } from './status/resolve-subject.ts'
import { ContextMeasurementCoordinator, deferInitialContextMeasure, type ContextMeasureReason } from './status/context-measurement.ts'
import { refreshedSearchState, steppedSearchOverlayState, type SearchOverlayState } from './search-overlay.ts'
import type { CompositionStatus, HostStatus, WorkspaceStatus } from './status/types.ts'
import { DEFAULT_FOOTER_LAYOUT } from './footer/presets.ts'
import { parseFooterLayout, isFooterLayout, resolveCommandFooterFallback } from './footer/layout.ts'
import { parseFooterCustomItems, type FooterCustomCommandItemSettings, type FooterCustomItemSettings } from './footer/custom-items.ts'
import { FooterCommandRunner } from './footer/command-runner.ts'
import { FooterDynamicItemRuntime, activeFooterItemIds, executableCommandItemIds } from './footer/dynamic-item-runtime.ts'
import { color, type ColorPalette } from './theme.ts'
import { startProcessTui, type CompactionPhase, type QueueItem, type TuiApp } from './tui-app.ts'
import { parseUserKeybindings } from './keybindings/config.ts'

import { normalizedKeyToKeyId } from './keybindings/manager.ts'
import { Text } from '@xmoon76/pi-tui'
import { SurfaceHost } from './extension/internal/surface-host.ts'
import { PI_TUI_EXTENSIONS_SERVICE, type PiTuiExtensionService } from './extensions.ts'
import {
  buildTaskRows, isActiveJobStatus, isSubagentRowInterruptible, rowGroup, subagentInterruptParent, taskRowLabel, taskTreePrefix, viewerAccessHint, viewerAccessOf, isViewerAccessInteractive,
  type TaskBrowserRow, type ViewerAccess,
} from './tasks-browser.ts'
import type { TaskBrowserViewState, TaskPanelItem } from './task-panel.ts'
import { TaskBrowserRuntime } from './task-browser-runtime.ts'
import type { TaskBrowserHandle } from './tui-app.ts'
import { registerTuiCommands, type DefaultIntentRecord, type InitialCommandCatalog, type TuiCommandRunner } from './commands.ts'
import { normalizePersistedTheme, resolveThemeSelection } from './theme-source.ts'
import { diagFromEnv, dshHome, type Diag } from './diag.ts'
import { runDetached, runOwned, isCancellation, type OwnedTaskOptions } from './detached.ts'
import { appendHistoryLine, historyFilePath, loadHistoryFile, loadHistoryRecords, recallHistoryForSession } from './history.ts'
import { terminalTitleOf } from './terminal-title.ts'
import { historySessionIdFor, persistAfterSession, persistHistoryRecord } from './history-persist.ts'
import { FileHistorySearchSource } from './history-search.ts'
import { safeErrorMessage } from './error-boundary.ts'
import { DraftImageStore } from './image/draft-store.ts'
import { ImageInputError } from './image/errors.ts'
import { clipboardBackendOf, commandOnPath, createClipboardRunner, readClipboardImage, readClipboardText, type ClipboardEnvironment } from './image/clipboard.ts'
import { openExternalUrl } from './open-url.ts'
import { buildOsc52Sequence, copyToClipboard, type CopyEnvironment, type CopyExecutor } from './clipboard.ts'
import { applyHomeEndKeyMode, homeEndKeysModeOf } from './home-end-keys.ts'
import { wheelScrollLinesOf } from './wheel-scroll.ts'
import { createStartupStatus } from './startup-status.ts'
import { iconStyleOf } from './icons.ts'
import { checkImageLimits } from './image/intake.ts'
import { ImageLoadError } from './image/errors.ts'
import { ImageLoader } from './image/loader.ts'
import { consumeDraftImages, draftHasImages, prepareUserMessage, pruneUnreferencedDrafts, type PrepareInputDeps } from './image/submit.ts'
import { runReservedSubmit } from './image/submit-flow.ts'
import { dshVersion } from './dsh-version.ts'
import { createExitController, type ExitSessionLike } from './exit.ts'
import { mergeDraft, refuseByTransitionFence, steerAll, steerHasPayload, sessionUnchanged, type SteerAgentLike } from './steer.ts'
import {
  resolveSubagentSettleTarget,
  viewerCanonicalizeScope,
  type SubagentPromptOutcome,
  type SubagentPromptReject,
  type SubagentViewerSubmitRequest,
} from './subagent-viewer-submit.ts'
import { createDirectBackend } from './runtime/backend.ts'
import { DirectSubagentPort } from './runtime/direct/subagent-direct.ts'
import { DirectSessionReader } from './runtime/direct/session-direct.ts'
import { DirectSessionWriter } from './runtime/direct/session-writer-direct.ts'
import { DirectSessionLifecycle } from './runtime/direct/session-lifecycle-direct.ts'
import { DirectInteractionPort } from './runtime/direct/interaction-direct.ts'
import { DirectCatalogPort } from './runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from './runtime/direct/config-direct.ts'
import { serializeTuiSettingsMutation } from './runtime/config-port.ts'
import { DirectHostFilePort } from './runtime/direct/host-file-direct.ts'
import { directAgentOf, ownerHandleOf, type CreateSessionRequest, type ResumeSessionRequest, type SessionHandle } from './runtime/session-lifecycle-port.ts'
import { formatShellSubmitText, localShellSandboxPreferenceOf, shellCommandOf, shellModeOf, submitShellResult, type ShellSubmitAgentLike } from './shell-context.ts'
import { createBoundedOutput, createFileCapture, formatBytes, formatTruncation, SHELL_OUTPUT_CAP_BYTES, SHELL_OUTPUT_CAP_LINES, SHELL_OUTPUT_DISK_CAP_BYTES } from './bounded-output.ts'
import { parseShellWords } from './shell-words.ts'
import { CatalogRefreshCoordinator, CoalescingRefreshGate, type CatalogRefreshOutcome, type CatalogRefreshRequest } from './skill-catalog-refresh.ts'
import {
  readSurfaceCatalog,
  type SurfaceCatalogContext,
  type SurfaceCatalogSnapshot,
} from './surface-catalog.ts'
import {
  readHumanSkillCatalog,
  resolveColdSkillTarget,
  type HumanSkillCatalog,
  type SkillCatalogContext,
} from './skill-catalog.ts'

import {
  acquireSessionLock,
  type SessionLockInfo,
  type SessionLockPersistence,
} from './session-lock.ts'
import { createProcProbe, parseProcStat } from './session-lock-proc.ts'
import { collectRewindCandidates, rewindPickerItem } from './rewind.ts'
import {
  commitRewind,
  type RewindCommitHost,
  type RewindLiveIdentity,
} from './session-fork.ts'
import { SessionTransitionGate } from './transition-gate.ts'
import { freshSubmitAckState, acceptSubmitAck, settleSubmitAck, type SubmitAckState, type SubmitPendingDetail } from './submit-ack.ts'
import { SubmitLatencyTracker } from './submit-latency.ts'
import { SessionOperationBarrier, TransitionInProgressError } from './session-operation-barrier.ts'
import { runTransitionTo, type TransitionOutcome, type TransitionSteps } from './transition.ts'
import { OpenLockHolder } from './open-locks.ts'
import { acquireProcessLeaseManager } from './session-lease-manager.ts'
import { SessionLeaseCoolingCoordinator, snapshotSession, type CoolingPersistenceLike } from './session-lease-cooling.ts'
// The tokenMeter service merge for context-pressure measurement.
import type {} from '@deepseek-ai/dsh-token-meter'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the TUI can mount. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', TUI_STARTUP_SERVICE]

/** Plugin config: the session to resume, resolved from the startup service. */
export interface Config {
  /** Resumed session id; a fresh session is created when absent. */
  sessionId?: string
  /** Test seam: the pre-mount status output (defaults to process.stdout,
   * TTY-gated). Injectable so the runner tests capture the status writes
   * without patching the global stdout (which would fight the test
   * reporter's own writes). STRUCTURAL on purpose: the public Config type
   * must not reference the internal startup-status module (the public
   * .d.mts leak gate). */
  startupStatusOutput?: {
    readonly isTTY?: boolean
    write(text: string): unknown
  }
}

export const Config: z<Config> = z.object({
  sessionId: z.string(),
})

/** The launcher's bounded exit request; the TUI asks for it on Ctrl+C. */
interface AppExit {
  (code: number): void
}

/** Number of turns materialized by the transcript presentation window. */
const TRANSCRIPT_WINDOW_TURNS = 20
/** Overlapping turn step used when browsing older/newer history. */
const TRANSCRIPT_WINDOW_STEP = 10
/** Coalesced repaint interval for streaming events, in ms. */
const REPAINT_FLUSH_MS = 50
/** Throttle for re-chaining a RUNNING local shell card's result to the
 * bounded tail (plan §5.1): the running preview refreshes at most this
 * often, so a high-throughput log cannot rebuild the view per chunk. */
const LOCAL_SHELL_TAIL_FLUSH_MS = 200

/**
 * Slash commands that need no session: before the first user message
 * (deferred start) they run locally without creating one. Everything else
 * dispatches through `commands.execute`, which creates the session lazily
 * (the command line IS the first user input). Commands in this set must
 * tolerate `liveAgent === undefined` in their handlers.
 *
 * Exported for the headless suite: the gate is exactly where a sessionless
 * command silently starts creating sessions again.
 */
export const SESSIONLESS_COMMANDS = new Set([
  'exit', 'focus', 'footer', 'settings', 'help', 'image', 'login', 'logout', 'model', 'reload',
  'sessions', 'resume', 'search', 'new', 'fork', 'rewind', 'preset', 'keybindings',
  // `/statusline` is the approved alias of `/footer` (same configurator,
  // other-agent muscle memory) — it rides the same ownership sets, so it
  // executes locally, never steers, and works before any session exists.
  'statusline',
])

/**
 * The LOCAL-execute command set: TUI-owned UI/control commands AND core
 * control commands the TUI does not itself register (e.g. /kill) that
 * must ALWAYS run locally through the commands service, never steered,
 * regardless of the busyEnter preference. Everything NOT in this set —
 * plain prompts AND non-local commands (the per-skill slash commands like
 * /grilling or /matrix-cli) — flows through the busy-Enter submission
 * policy while the agent is running: web parity, where a skill invocation
 * is a plain `session.prompt` whose leading `/name` line the host's
 * pre-step listener (dsh-tool-skill) resolves into the injected skill
 * body — there is no command-execution wire for skills.
 */
export const LOCAL_COMMANDS = new Set([
  'copy', 'exit', 'export', 'focus', 'footer', 'fork', 'help', 'image', 'keybindings', 'kill', 'login', 'logout',
  'model', 'new', 'preset', 'quit', 'reload', 'rename', 'resume', 'rewind',
  'search', 'sessions', 'settings', 'skill', 'status', 'subagents', 'tasks',
  'title', 'yolo',
  // `/statusline` — the approved alias of `/footer` (see its registration
  // comment: the near-synonym rule stays, this pairing is an explicit
  // alias, and `/status` keeps priority matching).
  'statusline',
])

/**
 * Command semantics matrix (plan §19.3/M12): a LOCAL command line carrying a
 * staged image placeholder is REJECTED — local commands are pure UI
 * controls, never LLM prompts. AGENT-FACING input (plain prompts AND
 * per-skill slash invocations like `/grilling`) SUPPORTS images: the skill
 * wrapper builds its message through the same prepared-input path, so an
 * image-bearing skill line is a real multimodal prompt (review finding 4).
 * There is never a silent drop.
 * @param parsed - the parsed slash command, undefined for a plain prompt.
 * @param text - the submission text.
 * @param store - the live draft store.
 * @param isLocal - whether the command name is a LOCAL (TUI-owned/UI)
 *   command; skill names answer false.
 */
export function commandRejectsImages(
  parsed: { name: string } | undefined,
  text: string,
  store: import('./image/types.ts').DraftImageStoreLike,
  isLocal: (name: string) => boolean,
): boolean {
  return parsed !== undefined && isLocal(parsed.name) && draftHasImages(text, store)
}

/**
 * The AUTHORITATIVE host-owned command catalog (P1-04): every command name
 * the TUI registers itself (registerTuiCommands in commands.ts) plus the
 * ownership sets (LOCAL_COMMANDS and SESSIONLESS_COMMANDS — /kill and
 * other core commands the TUI does not register but dispatches locally).
 * A plugin command contribution is validated against this catalog at
 * register time: an exact or near-synonym collision is rejected loudly,
 * so a plugin can never shadow a built-in command.
 */
export const HOST_COMMAND_CATALOG: ReadonlySet<string> = new Set([
  ...LOCAL_COMMANDS,
  ...SESSIONLESS_COMMANDS,
  // `/plan` is handled specially by the runner (bare form toggles plan mode)
  // and must remain host-owned even though it is not registered by the TUI
  // command list.
  'plan',
])

/**
 * Whether one submission steers under the busy-Enter preference: NOT a
 * force-queued chord, NOT a TUI-owned local command, and the agent is
 * running with the preference set to 'steer'. Pure so the dispatch gate
 * (inside the runner closure) is testable headless.
 * @param parsed - the parsed slash command, undefined for a plain prompt.
 * @param running - whether the live agent reports running.
 * @param busyEnter - the persisted preference value (''/undefined = queue).
 * @param forceQueue - the Ctrl+Enter chord: always queue, never steer.
 * @param isDynamicLocal - M5: the CommandBridge's effective-local check for
 *   plugin-declared local commands (absent = static set only).
 */
export function shouldSteerOnEnter(
  parsed: { name: string; rawInput?: string } | undefined,
  running: boolean,
  busyEnter: string | undefined,
  forceQueue: boolean,
  isDynamicLocal?: (name: string) => boolean,
): boolean {
  if (forceQueue) return false
  if (parsed !== undefined) {
    // `/skill <name> [args...]` is an AGENT-facing invocation (loadSkill),
    // NOT the local picker: it steers like any other prompt. Only the bare
    // `/skill` picker counts as local (review finding — same classification
    // as the image-rejection gate).
    if (parsed.name === 'skill' && (parsed.rawInput?.trim() ?? '') !== '') return running && busyEnter === 'steer'
    if (LOCAL_COMMANDS.has(parsed.name)) return false
    if (isDynamicLocal !== undefined && isDynamicLocal(parsed.name)) return false
  }
  return running && busyEnter === 'steer'
}

/**
 * Normalize an explicit `/skill <name> <args>` invocation to the skill's
 * own slash line `/<name> <args>` (review finding 2). The harness's
 * explicit skill gesture scans for `/<skill-name>` — it would extract
 * `skill` from a raw `/skill grilling ...` line and never inject the
 * grilling body. The command handler already performs this conversion
 * (`loadSkill` builds `'/' + skill.name + ' ' + args`); the busy-Enter
 * steer path must use the SAME normalized line so the body injects and
 * any image placeholders ride along.
 * @param text - the submitted line.
 * @returns the normalized `/<name> <args>` line, or undefined when the
 *   line is not an explicit skill invocation (plain prompt, other
 *   commands, or the bare `/skill` picker).
 */
export function normalizeSkillInvocation(text: string): string | undefined {
  const parsed = parseCommand(text)
  if (parsed?.name !== 'skill') return undefined
  // Only the SEPARATOR whitespace is trimmed (the rawInput starts after
  // the command name): the argument text — INCLUDING its trailing
  // whitespace — travels verbatim (the skill-invocation contract).
  const raw = parsed.rawInput.trimStart()
  if (raw === '') return undefined
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/.exec(raw)
  if (match === null) return undefined
  const name = match[1]!
  const args = match[2]
  return args === undefined || args.trim() === '' ? `/${name}` : `/${name} ${args.trimStart()}`
}

/**
 * The advertised-claim miss decision (pure, exported for the headless
 * suite): a slash input whose name was advertised by the completion list at
 * submit time but that the REAL session's catalog lacks is CONSUMED with an
 * explicit error — never sent to the model as a plain user message. An
 * unadvertised miss keeps the existing plain-input fallback (the user may
 * deliberately send slash text to the model).
 * @param execution - the settled `commands.execute` outcome.
 * @param wasAdvertised - the claim captured BEFORE session creation.
 * @returns whether the miss must be consumed as an advertised miss.
 */
export function shouldConsumeAdvertisedMiss(
  execution: { readonly result: unknown } | undefined,
  wasAdvertised: boolean,
): boolean {
  return execution === undefined && wasAdvertised
}

/** The live-agent surface {@link interruptAgent} needs (structural — the
 * TUI never imports the agent runtime for this call). */
export interface InterruptAgentLike {
  readonly session: { readonly id: string }
  readonly status: string
  cancel(cause: { kind: 'user' }, options?: { keepInbox?: boolean }): void
}

/** The writer surface {@link interruptAgent} needs (structural — a LOCAL
 * type so the public declaration never inlines internal runtime modules;
 * the runner's SessionWriter satisfies it). */
export interface InterruptWriterLike {
  cancel(sessionId: string, reason: { kind: 'user' }, options: { keepInbox: boolean }): void
}

/**
 * Interrupt the live agent (web Stop parity): abort the current
 * turn/tool run while PRESERVING the pending queue. dsh's DEFAULT
 * `cancel()` clears queued AND steering input, so a bare cancel would
 * destroy everything the user queued with Ctrl+S / queue-mode Enter —
 * the Esc-interrupt semantic is "stop the current thinking", never
 * "drop the queue". `keepInbox: true` parks the preserved work; dsh's
 * cancel is a documented no-op when nothing is active, so an idle
 * interrupt (double-Esc while idle) is harmless and still aborts a
 * local shell / maintenance task through the caller.
 *
 * NOTE (upstream dependency): dsh currently PARKS the preserved queue
 * after an abort — the "Esc with a queue continues immediately" UX
 * needs an upstream `wakePending`/`continueInbox` capability (not yet
 * in dsh). A TUI-side emulation (remove + re-send a queue message)
 * would fabricate durable discarded/inserted events in the session
 * log, which the design explicitly rejects — the parked queue is the
 * agreed web-parity behavior until upstream lands the capability.
 */
export function interruptAgent(agent: InterruptAgentLike | undefined, writer: InterruptWriterLike): void {
  if (agent === undefined) return
  writer.cancel(agent.session.id, { kind: 'user' }, { keepInbox: true })
}

/** One unsettled subagent delegation, in tool/call order. */
export interface PendingSubagentCall {
  readonly callId: string
  readonly description: string
}

/**
 * The async viewer-OPEN invalidation token (pure, exported for the headless
 * suite — the runner closure itself is not drivable in the headless tests,
 * so the lifecycle rule is tested through these token semantics). An open
 * request captures a token; EVERY viewer session change — opening another
 * child, leaving the viewer (Esc), or a session swap (which routes through
 * exitView) — invalidates the token, so a slow transcript inspection can
 * never commit an obsolete child over the current surface. Invalidation is
 * unconditional: an exit that finds NO mounted viewer still invalidates,
 * because the open is exactly then still in flight (round-5 finding).
 */
export interface ViewerOpenToken {
  /** The current token value (bumped by every open and every invalidate). */
  readonly current: number
  /** Start one async open; returns the request's token. */
  open(): number
  /** Invalidate every in-flight open (a viewer session change). */
  invalidate(): void
  /** Whether a request may still commit. */
  isCurrent(request: number): boolean
}

export function createViewerOpenToken(): ViewerOpenToken {
  let value = 0
  return {
    get current(): number {
      return value
    },
    open: () => ++value,
    invalidate: () => {
      value += 1
    },
    isCurrent: (request) => request === value,
  }
}

/**
 * Session-swap viewer teardown (pure, exported for the headless suite —
 * the runner closure is not headless-drivable, so the rule is pinned
 * through this seam). A session swap must do BOTH: invalidate any
 * in-flight viewer OPEN — UNCONDITIONALLY, because the open may still be
 * loading when nothing is mounted yet, and the swap must still cancel it
 * (round-6 finding) — and close a MOUNTED viewer when there is one.
 * @param token - the shared viewer-open token.
 * @param mounted - whether a viewer is currently mounted.
 * @param closeMounted - closes the mounted viewer (a no-op when unmounted).
 * @returns whether a mounted viewer was closed.
 */
export function teardownViewerForSessionSwap(
  token: ViewerOpenToken,
  mounted: boolean,
  closeMounted: () => void,
): boolean {
  token.invalidate()
  if (!mounted) return false
  closeMounted()
  return true
}

/**
 * The viewer capability gate for SEMANTIC plugin actions (pure, exported
 * for the headless suite — the runner closure is not drivable there).
 * While a subagent viewer is open, only actions that stay CHILD- or
 * SURFACE-local are allowed; every action with PARENT-session side
 * effects (steer, cancel/interrupt, permission cycling, the main
 * transcript search) is blocked, so a plugin keybinding can never
 * interrupt/steer/reconfigure the parent from inside the viewer. The
 * raw-key viewer guard already consumes the parent chords — this gate
 * closes the plugin-keybinding path, the only other way a semantic
 * action reaches the runner.
 * @param action - the semantic action the plugin requested.
 * @param viewer - the open viewer (mode), or undefined when no viewer.
 * @returns whether the runner may execute the action.
 */
export function viewerActionCapability(
  action: import('./extension/public-types.ts').TuiAction,
  viewer: { mode: 'one-shot' | 'continuable' } | undefined,
): boolean {
  if (viewer === undefined) return true
  switch (action) {
    case 'submit-draft':
    case 'queue-draft':
    case 'toggle-fullscreen':
      // Child- or surface-local: submitDraft routes to the child (and
      // hard-rejects in a one-shot viewer); fullscreen is chrome-local.
      return true
    default:
      // steer-draft / cancel-activity / cycle-permission / open-search
      // all target the parent session — never while viewing.
      return false
  }
}

/**
 * Match the child a user is about to view against the unsettled subagent
 * calls (pure, exported for the headless suite). The child's durable label
 * is the delegation's `description`; duplicate descriptions take the MOST
 * RECENT call (the one the user is most likely watching), an empty/absent
 * label falls back to a LONE pending call, and no match disables the
 * auto-pop (the user exits the viewer with Esc as before — never a wrong
 * pop). Mutates `pending` by removing the matched call.
 * @param pending - the unsettled calls, in order (oldest first).
 * @param label - the child's durable label; '' or undefined = no description.
 * @returns the matched call, or undefined when nothing matches.
 */
export function matchPendingSubagentCall(
  pending: PendingSubagentCall[],
  label: string | undefined,
): PendingSubagentCall | undefined {
  if (label !== undefined && label !== '') {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index]!.description === label) {
        return pending.splice(index, 1)[0]
      }
    }
    // No description match: a lone pending call is the only remaining
    // candidate (the user can only be viewing the one unsettled child).
    if (pending.length === 1) return pending.splice(0, 1)[0]
    return undefined
  }
  // No usable label: only a lone pending call can be tied unambiguously.
  if (pending.length === 1) return pending.splice(0, 1)[0]
  return undefined
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
  readonly liveAgent?: Agent
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
  // session, no turn — and no probe fallback on any failure.
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
  }
}

export function subagentJobTranscriptId(snapshot: unknown): string | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined
  const childSessionId = (snapshot as { readonly childSessionId?: unknown }).childSessionId
  return typeof childSessionId === 'string' && childSessionId.trim() !== '' ? childSessionId : undefined
}

/** Viewer body for a subagent job with no uniquely matched child. */
export function subagentJobViewHint(status: string, detail: string | undefined): string {
  const tail = status === 'running' || status === 'stopping'
    ? ' — running in the background; its transcript updates live in /tasks'
    : ` — this subagent finished${detail === undefined ? '' : ` (${detail})`}`
  return [
    `status: ${status}${tail}`,
    '',
    'The job record does not carry the child session id, so this job cannot',
    'be matched to its child from the task browser (a same-label foreground',
    'run would be indistinguishable). Open /tasks and pick the child by',
    'its label to read the transcript.',
  ].join('\n')
}

/** The message-source projection the queue filter reads (a structural subset
 * of dsh's message sources, so the helpers are testable without dsh types). */
export interface QueueNoticeSource {
  readonly form?: string
  readonly kind?: string
  readonly summary?: string
  /** The reporting child's session id (subagent-report relays). */
  readonly senderSessionId?: string
}

/**
 * Whether an inbox message is USER-ORIGIN input — the queue pane's steerable
 * `❯` rows. Everything else is injected context, not the user's own queued
 * input, and must never read as one: plugin notices (background-job
 * completions), `subagent-report` relays (a child's active report, e.g.
 * "Background subagent X reported:"), injected skill/agent instructions,
 * goal messages. The web makes the same cut (`placement: source.kind ===
 * 'user' ? 'steering' : 'context'`), and this deployment's queue pane has
 * the same rule: only user-origin rows are steerable. A sourceless row
 * (undefined) is treated as user input — plain rows never carry a source.
 * @param source - the message source projection, or undefined for a plain row.
 */
export function isUserQueueInput(source: QueueNoticeSource | undefined): boolean {
  return source === undefined || source.kind === 'user'
}

/**
 * Whether a plain submitted draft is the quit word: exactly `exit` (trimmed,
 * lowercase). The runner intercepts this BEFORE any session creation or
 * submission (shell muscle memory); anything else — `exit!`, `Exit`, or a
 * draft with a recalled entry still in it — is an ordinary message.
 * @param text - the submitted draft.
 */
export function isPlainExitPrompt(text: string): boolean {
  return text.trim() === 'exit'
}

/**
 * Whether an inbox message is a BACKGROUND-SUBAGENT settlement notice — the
 * runtime's account of a child ending, not steerable user input. Two dsh
 * producers push these into the parent's inbox:
 *  - continuable children: `source.kind === 'subagent-settled'` (the
 *    continuation manager's settlement notice);
 *  - one-shot background subagent jobs: tool-jobs completion notices whose
 *    summary starts with the job kind (`subagent <label> [status: …]`).
 * The queue pane mirrors the inbox, but these belong to the task browser
 * (terminal job rows / inactive child rows), so the mirror drops them and
 * only failures surface as a transient error notify.
 * @param source - the message source projection, or undefined for a plain row.
 */
export function isSubagentSettlementNotice(source: QueueNoticeSource | undefined): boolean {
  if (source === undefined || source.form !== 'notice') return false
  if (source.kind === 'subagent-settled') return true
  return source.kind === 'plugin' && typeof source.summary === 'string' && source.summary.startsWith('subagent ')
}

/**
 * Whether a subagent settlement notice reports FAILURE, classified on the
 * producers' own deterministic wording:
 *  - `subagent-settled` summaries: "finished and will do no further work"
 *    is the only success wording; aborted / max-tokens / refusal / error /
 *    unknown endings all fail;
 *  - tool-jobs subagent summaries carry the terminal status line, whose
 *    failure statuses are `failed` and `killed` (dsh JobStatus).
 * A notice that cannot be classified is treated as success (silent).
 * @param source - the message source projection.
 */
export function subagentNoticeIsFailure(source: QueueNoticeSource | undefined): boolean {
  if (source === undefined || source.form !== 'notice') return false
  if (source.kind === 'subagent-settled') {
    return typeof source.summary === 'string' && !source.summary.includes('finished and')
  }
  if (source.kind === 'plugin' && typeof source.summary === 'string' && source.summary.startsWith('subagent ')) {
    return /\[status: (failed|killed)[,\]]/.test(source.summary)
  }
  return false
}

/** One inbox message as the queue mirror sees it (a structural projection). */
export interface QueueInboxMessage {
  readonly id: string
  readonly content: readonly ContentBlock[]
  readonly source?: QueueNoticeSource
}

/** The mirror result for one inbox batch: the rows to show plus the failed
 * settlement summaries the caller should notify (each once). */
export interface QueueFoldResult {
  /** Queue rows (background-subagent settlement notices excluded). */
  readonly rows: QueueItem[]
  /** Failed settlement summaries not yet notified (the caller notifies). */
  readonly failures: readonly string[]
}

/**
 * Build the queue-pane rows for one inbox batch, dropping background-subagent
 * settlement notices (the task browser is their surface) and reporting which
 * FAILED settlements should notify. Pure and injectable so the filter +
 * once-notify semantics are testable without the agent.
 * @param messages - one inbox batch (next-turn or next-step), in order.
 * @param mode - the delivery mode for surviving rows.
 * @param notified - the notify-once guard; failed notices already in it are
 *   skipped, and a newly-reported id is ADDED here so a re-render can never
 *   double-notify.
 */
/**
 * The queue-pane display text of one message's content (review finding 5):
 * text blocks verbatim, image blocks as a compact `🖼️ name` summary (the
 * marker carries U+FE0F so fonts with an emoji face render it 2 cells wide
 * — the width math's expectation — and never overlap the name) — an
 * image-only queued message shows `🖼️ shot.png` instead of an empty row,
 * and a mixed message advertises its image. The queue row stays one line.
 */
function queueTextOf(content: readonly import('@deepseek-ai/dsh-llm').ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push(`🖼️ ${block.attachment.name ?? 'image'}`)
  }
  return parts.join(' ')
}

export function foldQueueRows(
  messages: readonly QueueInboxMessage[],
  mode: 'followup' | 'steer',
  notified: Set<string>,
): QueueFoldResult {
  const rows: QueueItem[] = []
  const failures: string[] = []
  for (const message of messages) {
    const source = message.source
    if (isSubagentSettlementNotice(source)) {
      if (source?.summary !== undefined && subagentNoticeIsFailure(source) && !notified.has(message.id)) {
        notified.add(message.id)
        failures.push(source.summary)
      }
      continue
    }
    rows.push({
      id: message.id,
      text: queueTextOf(message.content),
      mode,
      // Only user-origin (or sourceless plain) rows are steerable user
      // input. Everything else — plugin notices, subagent-report relays,
      // injected instructions, goal messages — is a NOTICE: the queue pane
      // marks it with the ⏳ prefix and drops the steer hints (see
      // QueueItem.notice), so it can never read as the user's own queued
      // input (web parity: only user-origin messages render as steering).
      notice: !isUserQueueInput(source),
    })
  }
  return { rows, failures }
}

/**
 * The bundle's own version, read from package.json at runtime so the welcome
 * card never drifts from the shipped version. The DISPLAYED version prefers
 * the installed dsh version (`dshVersion` — shared with the header badge
 * via src/dsh-version.ts), falling back to this one.
 * @returns the version string, or a fallback when the file is unreadable.
 */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: string }
    return dshVersion() ?? pkg.version ?? '0.0.0'
  } catch {
    return dshVersion() ?? '0.0.0'
  }
}

/**
 * The BUNDLE's OWN version (`@xmoon76/dsh-pi-tui`'s package.json),
 * INDEPENDENT of the installed dsh version. The status snapshot's
 * host.tuiVersion and the footer's `version(format=tui)` item must report
 * the TUI's own patch level — the welcome-card helper above deliberately
 * prefers the dsh version for display, so reusing it made `tui` show the
 * harness version (and `both` show the dsh version twice) inside a real
 * dsh installation (the review's P2).
 * @returns the bundle version string, or a fallback when the file is unreadable.
 */
function bundleVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Repaint the transcript from the active folder's bounded window. Messages,
 * navigation facts, and turn activities come from one fold snapshot so a
 * repaint can never show a stale Thought header against fresh rows.
 */
function repaint(
  app: TuiApp,
  folder: TranscriptFolder,
  windowController: TranscriptWindowController,
): TranscriptWindow {
  windowController.setTurns(folder.groupedTurns())
  const endTurn = windowController.endTurn()
  const projection = folder.window({
    maxTurns: windowController.windowTurns,
    ...(endTurn === undefined ? {} : { endTurn }),
  })
  app.setTranscript(projection.messages, folder.turnActivities(), {
    ...windowController.state(),
     firstTurn: projection.firstTurn,
     lastTurn: projection.lastTurn,
    hasNewer: projection.hasNewer,
  })
  return projection
}

/** Current git branch from the nearest .git/HEAD, or empty outside a checkout. */
function gitBranch(cwd: string): string {
  let dir = cwd
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim()
      if (!head.startsWith('ref: refs/heads/')) return ''
      return head.slice('ref: refs/heads/'.length)
    } catch {
      const parent = join(dir, '..')
      if (parent === dir) return ''
      dir = parent
    }
  }
  return ''
}

/** Shell commands the approval dialog flags as dangerous (kimi-inspired). */
const DANGER_PATTERNS: readonly RegExp[] = [
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+if=.*of=\/dev\//,
  /^:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bgit\s+push\b[^\n|;]*(--force\b|\s-f\b)/,
  /\b(shutdown|reboot|poweroff|init\s+0)\b/,
  />+\s*\/dev\/sd/,
  /\bcurl\b[^\n|]*\|\s*(ba)?sh\b/,
]

/** Hard cap for the /exit session flush: a hung provider must not trap the
 * user; after this the TUI exits and warns that the tail may be lost. */
const EXIT_FLUSH_TIMEOUT_MS = 10_000

/**
 * Whether a shell command matches a destructive pattern. `rm` is treated
 * specially: any spelling of recursive + force flags (`rm -rf`, `rm -r -f`,
 * `rm -rf /`) is dangerous; the remaining patterns are verbatim matches.
 */
export function dangerCommand(command: string): boolean {
  // Slice the flags from the WORD-BOUNDED rm match itself: slicing from the
  // first "rm" substring (e.g. inside "alarm") would read flags from the
  // wrong offset and both miss and misfire depending on what follows.
  const rm = /\brm\b/i.exec(command)
  if (rm !== null) {
    const flags = command.slice(rm.index + rm[0].length)
    const combined = flags.match(/-\w+/g)?.join('') ?? ''
    if (combined.includes('r') && combined.includes('f')) return true
  }
  return DANGER_PATTERNS.some(pattern => pattern.test(command))
}

/**
 * The dsh profile this process was launched with (the `--profile` flag),
 * so the exit-time resume hint names the profile the TUI actually runs
 * under. Falls back to `pi-tui` when the flag is absent (the TUI bundle
 * cannot load without a profile, so this is defensive only).
 * @param argv - the process argument vector.
 * @param fallback - the default profile.
 */
export function runningProfile(argv: readonly string[] = process.argv, fallback = 'pi-tui'): string {
  // Scan backwards: like commander, the LAST occurrence wins.
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i]!
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length)
    if (arg === '--profile' && i + 1 < argv.length && argv[i + 1] !== undefined && argv[i + 1] !== '') {
      return argv[i + 1]!
    }
  }
  return fallback
}

/**
 * The interactive-quit resume hint (pi parity): `dsh --profile <p>
 * --session <id>`, printed after the terminal restores so the user can
 * re-enter the session later. Returns undefined when there is no session
 * to resume (deferred start never created one).
 * @param profile - the running profile ({@link runningProfile}).
 * @param sessionId - the live session id.
 * @returns the resume command line, or undefined without a session.
 */
export function resumeCommand(profile: string, sessionId: string): string | undefined {
  const id = sessionId.trim()
  if (id === '') return undefined
  return `dsh --profile ${profile} --session ${id}`
}

/** The lock identity of THIS process: pid + boot-relative starttime. */
// The lock identity of THIS process, computed once: pid + starttime are
// boot-constants, so re-reading /proc/self/stat per acquire is pure waste.
let cachedSelfLockInfo: SessionLockInfo | undefined
function selfLockInfo(): SessionLockInfo {
  if (cachedSelfLockInfo !== undefined) return cachedSelfLockInfo
  const info: SessionLockInfo = {
    pid: process.pid,
    starttime: 0,
    startedAt: Date.now(),
    profile: runningProfile(),
  }
  try {
    info.starttime = parseProcStat(readFileSync(`/proc/self/stat`, 'utf8'))?.starttime ?? 0
  } catch {
    // No /proc (non-Linux): starttime 0 is still a valid unique marker for
    // this process's own lock record (the same-process shortcut compares
    // pid AND starttime, so 0 is fine for self-consistency).
  }
  cachedSelfLockInfo = info
  return info
}
/** Human-readable lock owner description for the refusal notice. */
function lockOwnerText(owner: SessionLockInfo): string {
  const parts = [`pid ${owner.pid}`]
  if (owner.profile !== undefined) parts.push(`profile ${owner.profile}`)
  if (owner.startedAt > 0) {
    const started = new Date(owner.startedAt)
    parts.push(`started ${started.toLocaleTimeString()}`)
  }
  if (owner.tty !== undefined) parts.push(`tty ${owner.tty}`)
  return parts.join(', ')
}

/** The refusal notice for a session held by another live dsh process. */
function lockHeldNotice(sessionId: string, owner: SessionLockInfo): string {
  return `Session ${sessionId} is open in another dsh process (${lockOwnerText(owner)}); opening it here could corrupt the log. Close it there first, or restart that process.`
}

/**
 * A launch-time open-lock refusal: the requested session is held by another
 * live dsh process (or its lock cannot be verified). Unlike a stale/missing
 * session id, this is NOT recoverable by falling back to a fresh session —
 * the user asked for a specific session and must resolve the holder first.
 * Thrown from the resume path and re-thrown past the resume catch so the
 * runner exits with the refusal as the error message.
 */
export class SessionLockRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionLockRefusedError'
  }
}

/**
 * The active goal badge text from the session log, or undefined. The latest
 * `goal/change` wins; a clear or completed goal hides the badge.
 * @param events - the session log.
 * @returns e.g. `goal ● fix the build`, or undefined.
 */
/**
 * Whether the agent is busy from a session log: the newest turn-boundary
 * event decides. A resumed session can be persisted mid-turn, so the scan
 * cannot assume the log ends idle.
 * @param events - the session log.
 * @returns whether the newest turn is still open.
 */
function workingFromLog(events: readonly SessionEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'turn/start') return true
    if (event.type === 'turn/end') return false
  }
  return false
}

function foldGoal(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'goal/change') continue
    if (event.data.operation === 'clear') return undefined
    const goal = event.data.goal
    if (goal.phase === 'complete') return undefined
    const mark = goal.phase === 'active' ? '●' : goal.phase === 'paused' ? '‖' : '◌'
    const objective = goal.objective.length > 24 ? `${goal.objective.slice(0, 24)}…` : goal.objective
    return `goal ${mark} ${objective}`
  }
  return undefined
}

/** Time one cold-bootstrap fold without changing its authoritative semantics. */
function timedBootstrapScan<T>(diag: Diag, name: string, eventCount: number, scan: () => T): T {
  const started = performance.now()
  const result = scan()
  diag.debug('session bootstrap scan', {
    scan: name,
    eventCount,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
  })
  return result
}

/** A balanced completed-turn prefix for forking: the log up to (and including)
 * the last `turn/end`. Undefined when no turn has completed yet.
 * @param events - the session log.
 * @returns the fork seed events, or undefined.
 */
export { forkSeed } from './commands.ts'

/** One fold of a compaction lifecycle event over the runner's in-flight
 * compaction state. Pure (the firehose applies the returned surface
 * effects): dsh-compaction is not a peer, so the event is read
 * structurally. */
export interface CompactionFold {
  /** The updated in-flight compaction id (the newest start wins). */
  id: string | undefined
  /** compaction/start: the compacting flag turns ON (footer/working row). */
  active: boolean
  /** A MATCHED compaction/end: the compacting flag turns OFF and busy is
   * re-derived from the turn log (a stale end never clears a newer
   * compaction's state). */
  clear: boolean
  /** The compaction phase the event implies: compaction/start →
   * 'summarizing', a MATCHED compaction/summary → 'applying'. Undefined
   * when the event does not advance the phase (a stale summary, any
   * compaction/end — the settle clears via {@link clear}). */
  phase?: Exclude<CompactionPhase, 'idle'>
  /** The settle notification for compaction/end, when one fires. */
  notify: { text: string; kind: 'info' | 'error' } | undefined
}

/** Fold one compaction lifecycle event over the in-flight state. */
export function foldCompactionEvent(
  state: { id: string | undefined },
  event: { type: string; data: { compactionId?: unknown; error?: unknown } },
): CompactionFold {
  if (event.type === 'compaction/start') {
    return {
      id: typeof event.data.compactionId === 'string' ? event.data.compactionId : undefined,
      active: true,
      clear: false,
      phase: 'summarizing',
      notify: undefined,
    }
  }
  if (event.type === 'compaction/summary') {
    // ONLY a summary matching the in-flight compaction advances the phase
    // to 'applying': a stale summary (another compaction's, or an id-less
    // orphan) must not flip the label while the current compaction is
    // still summarizing.
    const matched = typeof event.data.compactionId === 'string' && event.data.compactionId === state.id
    return {
      id: state.id,
      active: false,
      clear: false,
      phase: matched ? 'applying' : undefined,
      notify: undefined,
    }
  }
  if (event.type === 'compaction/end') {
    const error = typeof event.data.error === 'string' && event.data.error !== '' ? event.data.error : undefined
    // ONLY an end whose id matches the in-flight compaction settles it:
    // a stale end (another compaction's, or an id-less orphan from a
    // foreign/corrupt log) must neither clear the state nor notify.
    const matched = typeof event.data.compactionId === 'string' && event.data.compactionId === state.id
    return {
      id: matched ? undefined : state.id,
      active: false,
      clear: matched,
      notify: matched
        ? {
          text: error === undefined ? 'Context compacted' : `Compaction failed: ${error}`,
          kind: error === undefined ? 'info' : 'error',
        }
        : undefined,
    }
  }
  return { id: state.id, active: false, clear: false, notify: undefined }
}

/** The minimal compaction-settle surface the runner passes in — STRUCTURAL
 * on purpose: referencing the full {@link TuiApp} class from a public
 * export would inline the whole surface (and its internal registry/
 * presentation dependencies) into the published declaration bundle. The
 * settle contract only needs the three phase/busy/working setters. */
export interface CompactionSettleSurface {
  setCompactionPhase(phase: 'idle'): void
  setBusy(busy: boolean): void
  setWorking(busy: boolean): void
}

/** The UI side effects of a MATCHED compaction settle: clear the phase,
 * hand the working row back to the turn state, and re-measure the session
 * surface so the footer context reflects the compacted log IMMEDIATELY —
 * the next step/start or turn/end would otherwise delay the refresh.
 * Exported as a seam so the settle contract is testable without a full
 * runner driver (the firehose closure is not). */
export function settleCompactionSurface(
  app: CompactionSettleSurface,
  refreshStatus: () => void,
  busyNow: boolean,
): void {
  app.setCompactionPhase('idle')
  app.setBusy(busyNow)
  app.setWorking(busyNow)
  refreshStatus()
}

/** The busy flag after a turn-boundary event: a turn end must NOT clear
 * the busy state while a compaction is still in flight — an interrupted
 * turn can close (turn/end) before its compaction settles, and the
 * single-Esc cancel must stay armed until compaction/end. */
export function busyAfterTurnBoundary(eventType: 'turn/start' | 'turn/end', compacting: boolean): boolean {
  return eventType === 'turn/start' || compacting
}

/** PR D2 test seam: whether a session event type marks the model-visible
 * context dirty (re-measure through the SessionReader port) or only
 * repaints cheaply (cached measurement). The firehose routes every event
 * through this classification — the single source of truth for the
 * status/measurement split. `compaction/end` is classified 'measure' but
 * the firehose deliberately SKIPS it here: a matched compaction settle
 * re-measures through the fold-outcome path (settleCompactionSurface), so
 * a STALE compaction/end can never trigger a measurement. */
export function contextRefreshKind(eventType: string): 'measure' | 'cheap' {
  switch (eventType) {
    case 'step/start':
    case 'turn/end':
    case 'compaction/end':
      return 'measure'
    default:
      return 'cheap'
  }
}

/**
 * The in-flight compaction state a resumed session log implies: the newest
 * compaction bracket decides. A `session/end-seed` boundary makes any
 * EARLIER unmatched `compaction/start` STALE — the upstream invariant
 * (inheritedOrphanStartSeqs) treats seed compactions that never settled
 * inside the seed as abandoned, so they must not re-arm the compacting
 * surface on resume.
 */
export function compactingFromLog(
  events: readonly { type: unknown; data?: unknown }[],
): { active: boolean; id: string | undefined } {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) break
    const kind = typeof event.type === 'string' ? event.type : ''
    if (kind === 'compaction/start') {
      const data = (event as { data?: { compactionId?: unknown } }).data
      return { active: true, id: typeof data?.compactionId === 'string' ? data.compactionId : undefined }
    }
    if (kind === 'compaction/end' || kind === 'session/end-seed') break
  }
  return { active: false, id: undefined }
}

/** One agent's preset composition: the id to record and the setup that installs it. */
export interface AgentComposition {
  /** Preset id for the session header, absent when the deployment composes no roster. */
  agentPreset?: string
  /** Agent-factory setup: model selection, then the preset mount when composed. */
  setup: (agentCtx: Context) => Promise<void> | void
}

/**
 * Resolve the preset an agent will be composed from, and the setup that
 * installs it.
 *
 * The id is resolved BEFORE the session exists because the session boundary
 * snapshots `meta` before asynchronous setup begins — a preset discovered
 * during setup could never reach the header. Mounting still happens in setup,
 * where a failure rolls the whole creation back rather than leaving a
 * published session whose capabilities are half-installed.
 *
 * A deployment with no roster composes nothing and every session shares the
 * host composition, which is the behavior before presets existed.
 * @param ctx - the runner context (services read through `ctx.get`).
 * @param installSelection - installs a fresh Agent-local model selection ref
 *   during setup. A ModelSelectionRef is still accepted for source
 *   compatibility with standalone composition callers; the runner always
 *   supplies the Agent-local installer.
 * @param presetId - the requested preset, or `undefined` for the default.
 * @param focusState - the shared Focus runtime state (STRUCTURAL on
 *   purpose: the public declaration bundle must not inline src/focus.ts —
 *   the parameter only ever carries the runner's FocusState object, so a
 *   bare `{ enabled: boolean }` keeps the shipped .d.mts clean); when
 *   provided, the setup ALSO installs the dynamic Focus system-prompt
 *   section exactly once per composed agent (plan §9 — every composed
 *   root TUI agent gets it; /focus toggles never re-register).
 * @param diag - the diagnostics channel, when the caller has one.
 * @returns the id to record on the header (absent without a roster) and the setup callback.
 * @throws when the roster supplies no such preset.
 */
export async function composeAgent(
  ctx: Context,
  installSelection: ((agentCtx: Context) => void) | ModelSelectionRef,
  presetId?: string,
  focusState?: { enabled: boolean },
  diag?: Diag,
): Promise<AgentComposition> {
  const presets = ctx.get('agentPresets')
  // Keep the old public helper shape usable by headless composition callers,
  // but make the runner's production path pass an installer that creates a
  // distinct ref for the Agent being composed.
  const install = typeof installSelection === 'function'
    ? installSelection
    : (agentCtx: Context): void => { installModelSelection(agentCtx, installSelection) }
  if (presets === undefined) {
    if (presetId === 'code') {
      throw new Error('preset "code" is unavailable in this deployment; use a configured preset')
    }
    return {
      setup: (agentCtx: Context): void => {
        install(agentCtx)
        // Focus is a TUI surface policy: install it only when the runner
        // supplied the shared state (other callers — the headless tests —
        // keep the plain composition).
        if (focusState !== undefined) installFocusPrompt(agentCtx, focusState, diag)
      },
    }
  }
  // DSH allows a user preset literally named `code`. Resolve the real roster
  // entry first; only an omitted persisted default falls back from old pi-tui
  // `code` data to the canonical `ptc` preset.
  const resolved = await resolvePresetRequest(presets, presetId)
  // The resolver returns the concrete roster identity, including a legitimate
  // custom `code` entry. The only compatibility rewrite is inside the shared
  // omitted-default resolver above.
  return {
    agentPreset: resolved.id,
    setup: async (agentCtx: Context): Promise<void> => {
      install(agentCtx)
      await presets.mount(agentCtx, resolved.id)
      // Focus is a TUI surface policy, installed AFTER the preset mount so
      // it exists consistently across every preset (standard/ptc/minimal/
      // cordis) without depending on what the preset itself installs
      // (plan §9.1). A preset recompose that only swaps preset-owned rows
      // keeps this outer scoped section; a full agent rebuild re-runs this
      // setup, so the section still lands exactly once. Only the runner
      // (which owns the shared state) requests the install.
      if (focusState !== undefined) installFocusPrompt(agentCtx, focusState, diag)
    },
  }
}

/**
 * The preset a persisted session actually runs, resolved by the DSH 0.1.2+
 * session projection (header initialization plus the latest selection event).
 * @param ctx - the runner context.
 * @param sessionId - the persisted session id.
 * @returns the recorded preset id, or undefined to compose the default.
 */
export async function recordedPreset(ctx: Context, sessionId: string): Promise<string | undefined> {
  return recordedSessionPreset(ctx, sessionId)
}

/** The session surface {@link recomposeBlank} needs: its log and the append seam. */
export interface RecomposableSession {
  readonly id: string
  snapshotEvents(): readonly SessionEvent[]
  append(type: 'agent-preset/selected', data: { agentPreset: string }): unknown
}

/** Outcome of {@link recomposeBlank}: the swap committed, or the session is locked. */
export type RecomposeOutcome = { kind: 'switched'; preset: string } | { kind: 'locked' }

/**
 * Re-compose one agent onto another preset while its session is still blank.
 *
 * A started conversation's history was produced under its preset's tools, so
 * only a session with no `turn/start` event may swap — the same rule as the
 * official `agentPreset.select` RPC. The selection is appended to the log only
 * after the swap committed (a rejected mount leaves the old composition).
 * @param ctx - the runner context.
 * @param agent - the live agent whose composition to swap.
 * @param id - the target preset id.
 * @returns `switched` with the committed preset id, or `locked` when a turn has run.
 * @throws when the roster supplies no such preset or its composition is unusable.
 */
export async function recomposeBlank(
  ctx: Context,
  agent: { ctx: Context; session: RecomposableSession },
  id: string,
): Promise<RecomposeOutcome> {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) throw new Error('agent presets unavailable in this deployment')
  if (agent.session.snapshotEvents().some(event => event.type === 'turn/start')) return { kind: 'locked' }
  const preset = await presets.recompose(agent.ctx, id)
  agent.session.append('agent-preset/selected', { agentPreset: preset.id })
  return { kind: 'switched', preset: preset.id }
}

/** Set the terminal window title (OSC 0); a no-op without a TTY. */
function setTerminalTitle(title: string): void {
  if (process.stdout.isTTY === true) process.stdout.write(`\x1b]0;${title}\x07`)
}

/**
 * The task-browser row → panel-item projection (runner glue, module-level
 * so the open browser AND the runtime refresh coordinator share ONE
 * mapping). JOB rows keep their status/detail; SUBAGENT rows carry the
 * projected runtime activity as the status word, the durable mode as the
 * non-truncatable suffix, and the tree connector from the catalog depth.
 * The Stop capability is advertised ONLY for a continuable child with a
 * LIVE running driver (`isSubagentRowInterruptible`) — an idle
 * continuable has no driver to stop. `has children` is deliberately NOT
 * a detail line: the tree connector already expresses parenthood.
 */
function taskPanelItems(target: readonly TaskBrowserRow[]): TaskPanelItem[] {
  const labels = new Map<string, string>()
  for (const row of target) {
    if (row.kind === 'subagent') labels.set(row.childId, row.label)
  }
  return target.map(row => row.kind === 'job'
    ? {
        value: row.value,
        // A `subagent`-kind job is the registry's reliable contract
        // for a background one-shot delegation: its `one-shot` mode
        // rides as the non-truncatable suffix, like the child rows.
        label: row.jobKind === 'subagent' ? `subagent job · ${row.label}` : taskRowLabel(row),
        suffix: row.jobKind === 'subagent' ? 'one-shot' : undefined,
        status: row.status,
        detail: row.detail,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        group: rowGroup(row),
        source: 'job' as const,
        active: isActiveJobStatus(row.status),
        attention: row.attention ?? (row.status === 'failed' || row.status === 'timed_out' || row.status === 'lost'),
        canOpen: true,
        canStop: isActiveJobStatus(row.status),
        // The Tab type filter: job rows filter by their job kind.
        type: row.jobKind,
      }
    : {
        value: row.value,
        // The mode rides as the panel's non-truncatable SUFFIX
        // (`subagent · <label> · continuable`): the label itself may
        // truncate on a narrow screen, the mode never silently does.
        label: `subagent · ${row.label}`,
        suffix: row.mode,
        status: row.activity,
        group: rowGroup(row),
        source: 'subagent' as const,
        type: 'subagent',
        active: row.activity === 'running',
        canOpen: true,
        canStop: isSubagentRowInterruptible(row),
        parentId: row.parentId === '' ? undefined : `agent:${row.parentId}`,
        parentLabel: row.parentId === '' ? undefined : labels.get(row.parentId),
        depth: row.depth,
        hasChildren: row.hasChildren,
        mode: row.mode,
        access: viewerAccessHint(row.mode, viewerAccessOf(row)),
        // Only a continuable row with a LIVE running driver is
        // Stop-capable (one-shot ids are accepted no-ops for the
        // interrupt transport; an idle continuable has no driver to
        // stop — the UI must not advertise a dead stop verb).
        interruptible: isSubagentRowInterruptible(row),
        // The durable descendant tree connector: indentation + branch
        // glyph from the catalog's `depth` (plan §6.7) — a fixed
        // region that never scrolls with the selected label.
        treePrefix: taskTreePrefix(row.depth),
      })
}

/**
 * Mount the TUI: resolve the model selection, create or resume the agent,
 * wire the surface to the agent, and subscribe to the session firehose.
 * @param ctx - plugin context carrying core services.
 * @param config - validated config with the optional resumed session id.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit') as AppExit | undefined
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const startup = ctx.get(TUI_STARTUP_SERVICE)
  if (startup === undefined) return
  // The semantic backend (server/client migration M1): the TUI consumes
  // Host domains through narrow ports, never ctx.* directly. Direct is the
  // only backend today; remote/wire adapters join in later milestones
  // behind the SAME port interfaces.
  // Process diagnostics: stderr + a log file under $DSH_HOME/logs. The cordis
  // logger has no exporter in this process, so it is NOT the troubleshooting
  // channel — diag is (see diag.ts).
  const diag: Diag = diagFromEnv(process.env)
  // The patch row carries a static config; the real session id comes from the
  // startup service (no `!!js` expression, so loader hot-reloads cannot race
  // the service's availability while evaluating the row).
  const sessionId = config.sessionId !== undefined && config.sessionId !== '' ? config.sessionId : startup.sessionId
  // Lifecycle cancellation: ONE controller owned by the runner fiber. It is
  // aborted by user exit, by the ctx.effect cleanup (loader hot-reload
  // unloads the row), and by startup failure. Every long-running load shares
  // its signal; per-action cancellation rides child controllers (the local
  // shell) or generation checks (menu latches).
  const lifecycleController = new AbortController()

  // The guarded notification writer is hoisted to the RUNNER scope: both
  // the startup body and the terminal-total fatal catch (which lives
  // OUTSIDE the IIFE) must be able to disable terminal focus reporting —
  // a startup failure after the TUI mount must never leak CSI ? 1004
  // into the shell. The guarded writer swallows broken-stream async
  // errors; every use is additionally wrapped for synchronous throws.
  const notificationWriter = guardedStreamWriter(process.stdout)

  void (async () => { // allowlist: startup lifecycle root — see AGENTS.md
    // Loader siblings mount concurrently. Await the complete application before
    // creating an Agent so its scoped tools and adapters are not half-composed.
    await ctx.get('loader')?.await()
    const agents = ctx.get('agents')
    const defaultModel = ctx.get('agentDefaultModel')
    const sessions = ctx.get('sessions')
    // Early process shutdown can dispose the tree while settlement is pending.
    if (agents === undefined || defaultModel === undefined || sessions === undefined) return

    // Persisted TUI preferences: register the namespace FIRST — before any
    // agent compose/resume — so the Focus runtime state is restored before
    // the first model step could assemble (plan §6.1: a resumed agent may
    // step during startup, and its first prompt assembly must already see
    // the persisted Focus state). The App-dependent VISUAL applications
    // (theme/footer/fullscreen/…) still run after the app exists.
    // Theme values: auto | dark | light | custom:<name>.
    const tuiSettings = ctx.get('settings')?.register(
      'dsh-pi-tui' as SettingsNamespace,
      z.object({
        theme: z.string(),
        footer: z.string(),
        // M5: the user's LAST NATIVE footer mode, persisted separately
        // because `footer` itself is overwritten by 'command' when the
        // command surface arms. The command surface's failure fallback
        // resolves from THIS (default | compact | custom) — a compact
        // user's fallback survives a restart. Absent on documents written
        // before the field existed → 'default'.
        footerFallbackMode: z.string(),
        // M2: the versioned custom footer layout (nested object — never a
        // JSON string). The base is the builtin default layout, so an
        // absent key always resolves to a valid layout. Schemastery object
        // fields are optional by default; parseFooterLayout is the
        // authority on the persisted value.
        footerLayout: z.object({
          schemaVersion: z.const(1),
          rows: z.array(z.object({
            left: z.array(z.object({
              id: z.string(),
              format: z.string(),
              tone: z.string(),
              prefix: z.string(),
              suffix: z.string(),
              importance: z.number(),
            })),
            right: z.array(z.object({
              id: z.string(),
              format: z.string(),
              tone: z.string(),
              prefix: z.string(),
              suffix: z.string(),
              importance: z.number(),
            })),
            separator: z.object({
              text: z.string(),
              tone: z.string(),
            }),
          })),
        }),
        // PR C: retain the definition collection as raw data. The custom-item
        // parser is the fail-soft authority, so malformed entries (or even a
        // malformed collection) are skipped instead of making the whole TUI
        // unavailable.
        footerCustomItems: z.any(),
        // M5: the trusted command status-line config (the command is
        // executed ONLY when it lives in the USER layer — see
        // resolveTrustedFooterCommand).
        footerCommand: z.object({
          schemaVersion: z.const(1),
          command: z.string(),
          timeoutMs: z.number(),
          refreshIntervalMs: z.number(),
          maxRows: z.number(),
        }),
        fullscreen: z.string(),
        // Busy-Enter delivery mode for plain Enter while the agent is
        // running (web busyEnter parity): 'queue' (default) or 'steer'.
        busyEnter: z.string(),
        // Local-shell sandbox for user-typed `!`/`!!` commands: 'bypass'
        // (default) runs them outside the dsh sandbox (pi/kimi parity —
        // the sandbox guards the model's autonomous commands, not the
        // user's own), 'sandbox' routes them through the dsh shell
        // capability's policy for deployments that want it applied.
        localShellSandbox: z.string(),
        // Home/End navigation behavior (issue #9): 'input' (default)
        // makes Home/End move within the input (Ctrl+Home/End scroll);
        // 'viewport' keeps Home/End scrolling the fullscreen conversation.
        homeEndKeys: z.string(),
        // Focus Mode: 'on' collapses turn-intermediate activity into a
        // live Thought block (default 'off' — Focus OFF == current UI).
        focusMode: z.string(),
        // Completion notifications: mode = when the main agent's
        // settlement notifies ('unfocused' default | 'always' | 'off'),
        // method = how ('auto' default | 'osc9' | 'osc777' | 'bell').
        notificationMode: z.string(),
        notificationMethod: z.string(),
        // Fullscreen mouse-wheel step: '1' (default) | '2' | '3' | '5' |
        // '8' — the transcript lines moved per wheel event. A Client
        // preference; wheelScrollLinesOf is the single parsing authority.
        wheelScrollLines: z.string(),
        // Icon style: 'emoji' (default) or 'symbols' — the first-party
        // structural icon palette (see src/icons.ts). A persisted invalid
        // value fails safe to emoji at consumption.
        iconStyle: z.string(),
        // NOTE: the user keybinding overrides (`keybindings`) are NOT in
        // the schema — schemastery's z.object keeps unknown keys in the
        // resolved doc (see the `history` migration note below), and the
        // keybindings parser (src/keybindings/config.ts) owns the
        // validation fail-soft. Adding a schema field here would break
        // the z<T> inference of the whole register call (probed).
      }),
      // `history` used to live here (a per-cwd map in the settings
      // document). It moved to $DSH_HOME/user-history/*.jsonl (see
      // history.ts); the schema deliberately no longer carries it, so the
      // stored section drops the key on the next settings write.
      // The base layout is the builtin default; the schemastery output
      // type is fully-populated, so the cast bridges the sparse literal
      // (the runtime validation accepts missing optional fields).
      { base: { theme: 'auto', iconStyle: 'emoji', footer: 'full', footerFallbackMode: 'default', footerLayout: DEFAULT_FOOTER_LAYOUT as never, footerCustomItems: undefined as never, footerCommand: undefined as never, fullscreen: 'on', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'input', focusMode: 'off', wheelScrollLines: '1', notificationMode: 'unfocused', notificationMethod: 'auto' } },
    )
    // The ONE authoritative Focus runtime state (plan §5): restored from
    // the persisted document BEFORE the first compose/resume below, mutated
    // only through the runner's unified setFocusMode. The system-prompt
    // section and the TUI projection both read THIS object.
    const focusState: FocusState = { enabled: focusModeOf(tuiSettings?.get().focusMode) === 'on' }

    // Completion notifications (plan: Client/TUI presentation capability —
    // settled detection, focus detection, terminal output and settings
    // parsing stay separate modules, never a blob in the runner). The
    // controller consumes the AUTHORITATIVE `agent/status` runtime fact
    // (same live main agent, observed running → idle) — never `turn/end`,
    // timers or debounces. The notifier writes through the HOISTED
    // guarded writer (declared with the runner scope so the fatal catch
    // can disable focus reporting too); the sink wrapper contains
    // synchronous throws so a notification failure can never crash the
    // TUI. The SAME guarded writer carries the focus-reporting mode
    // writes (enable at mount, disable at cleanup AND on the
    // startup-failure path).
    const terminalNotifier = new TerminalNotifier(notificationWriter)
    const completionController = new CompletionNotificationController((method, title, body) => {
      try {
        terminalNotifier.notify(method, title, body)
      } catch {
        // A notification failure is Client-local UX: never crash the TUI.
      }
    })
    const terminalFocusTracker = new TerminalFocusTracker()
    completionController.setMode(parseNotificationMode(tuiSettings?.get().notificationMode))
    completionController.setMethod(parseNotificationMethod(tuiSettings?.get().notificationMethod))

    // The live Agent is declared before the TUI-facing facade so every read
    // after a transition follows the current Session rather than a startup
    // snapshot. It remains undefined for deferred-start surfaces.
    let liveAgent: Agent | undefined
    const modelSelections = new DirectModelSelectionOwner(
      defaultModel as unknown as DefaultModelServiceLike,
    )
    // The latest explicit default-model intent: every /model commit
    // (sessionless or live) records the value a NEW Session should observe
    // while the global-default save is still in flight. It is TRANSIENT:
    // a settled save clears it (the next /new reads the persisted default
    // dynamically), and a failed save walks the operation ancestry back to
    // the nearest still-pending operation.
    //
    // The intent is a small OPERATION CHAIN state machine: each operation
    // carries its own save status and links the operation that owned the
    // intent before it (ancestry). A settle reports ONLY the operation id
    // and outcome; the machine decides whether the intent clears, restores
    // a pending ancestor, or stays with a newer operation. An operation's
    // status is retained as long as it is reachable along the chain, so a
    // deep rollback (C fails → restore B → B fails → restore A) can never
    // resurrect an already-settled operation as pending.
    interface DefaultIntentOperation {
      id: number
      selection: ModelSelection
      previous: DefaultIntentOperation | undefined
      status: 'pending' | 'committed' | 'failed'
    }
    let nextIntentId = 0
    let activeDefaultIntent: DefaultIntentOperation | undefined
    /** Why the intent is currently unset: 'committed' (the persisted default
     *  carries the latest committed choice — the blank Session observes it
     *  dynamically), 'failed' (the latest settle failed and no pending or
     *  committed operation remains — the deferred-create boundary seeds the
     *  captured choice), or undefined while an operation is still pending. */
    let defaultIntentOutcome: 'committed' | 'failed' | undefined
    const setDefaultIntent = (next: ModelSelection | undefined): void => {
      // A NEW operation owns the intent: allocate a fresh id and link the
      // previous operation as ancestry (the rollback chain).
      if (next === undefined) {
        activeDefaultIntent = undefined
      } else {
        nextIntentId += 1
        activeDefaultIntent = {
          id: nextIntentId,
          selection: next,
          previous: activeDefaultIntent,
          status: 'pending',
        }
      }
      defaultIntentOutcome = undefined
    }
    const settleIntent = (id: number, outcome: 'committed' | 'failed'): void => {
      // Find the operation in the active chain (every operation is an
      // ancestor of the active one).
      let op: DefaultIntentOperation | undefined = activeDefaultIntent
      while (op !== undefined && op.id !== id) op = op.previous
      if (op === undefined) return
      op.status = outcome
      if (op !== activeDefaultIntent) return // a newer operation owns the intent
      if (outcome === 'committed') {
        // The persisted default carries the choice: the transient intent
        // settles and the blank Session observes it dynamically.
        activeDefaultIntent = undefined
        defaultIntentOutcome = 'committed'
        return
      }
      // The active operation FAILED: walk the ancestry to the nearest
      // still-pending operation (it keeps its settle authority), skipping
      // settled ones. A committed ancestor means the persisted default
      // carries it (no seed); only failed ancestors leave the captured
      // choice to be seeded by the deferred-create boundary.
      let settledOutcome: 'committed' | 'failed' = 'failed'
      let cursor = op.previous
      while (cursor !== undefined) {
        if (cursor.status === 'pending') {
          activeDefaultIntent = cursor
          defaultIntentOutcome = undefined
          return
        }
        if (cursor.status === 'committed') settledOutcome = 'committed'
        cursor = cursor.previous
      }
      activeDefaultIntent = undefined
      defaultIntentOutcome = settledOutcome
    }
    /** TUI-only facade; this ref is NEVER installed into an Agent context. */
    const selected: ModelSelectionRef = {
      get current(): ModelSelection | undefined {
        return liveAgent === undefined
          ? activeDefaultIntent?.selection ?? (defaultModel.currentSelection() as ModelSelection | undefined)
          : modelSelections.current(liveAgent)
      },
      set current(next: ModelSelection | undefined) {
        // The facade write path: a live Session routes to its own selection
        // (in-memory; the durable commit belongs to the catalog port), a
        // sessionless surface records the default intent. /model uses the
        // runner's explicit setDefaultIntent for the durable path.
        if (liveAgent === undefined) {
          setDefaultIntent(next)
          return
        }
        modelSelections.setCurrent(liveAgent, next)
      },
      assembled: undefined,
    }
    const installSessionModelSelection = (agentCtx: Context): void => modelSelections.installForContext(agentCtx)
    const compose = (presetId?: string): Promise<AgentComposition> => composeAgent(ctx, installSessionModelSelection, presetId, focusState, diag)
    const withPresetMeta = (composition: AgentComposition): { agentPreset?: string } =>
      composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }

    // The semantic backend (server/client migration M1): the TUI consumes
    // Host domains through narrow ports, never ctx.* directly. Direct is the
    // only backend today; remote/wire adapters join in later milestones
    // behind the SAME port interfaces. Constructed here (after compose) so
    // the Direct session lifecycle can resolve preset compositions.
    const backend = createDirectBackend(
      new DirectSubagentPort(ctx),
      new DirectSessionReader(ctx, (sessionId) => liveAgent?.session.id === sessionId ? liveAgent : undefined, diag),
      new DirectSessionWriter(ctx, (sessionId) => liveAgent?.session.id === sessionId ? liveAgent as never : undefined),
      new DirectSessionLifecycle(ctx, (presetId) => compose(presetId)),
      new DirectInteractionPort(ctx, (sessionId) => liveAgent?.session.id === sessionId ? liveAgent : undefined),
      new DirectCatalogPort(
        ctx,
        (sessionId) => liveAgent?.session.id === sessionId ? liveAgent : undefined,
        modelSelections,
        diag,
      ),
      new DirectConfigPort(ctx, tuiSettings as unknown as import('./runtime/config-port.ts').TuiSettingsConfig | undefined, (sessionId) => liveAgent?.session.id === sessionId ? liveAgent : undefined),
      new DirectHostFilePort((sessionId) => liveAgent?.session.id === sessionId ? liveAgent : undefined),
    )

    // Whole-document settings writes must not copy a project-layer
    // footerCustomItems value into the USER section. The config port is the
    // only source allowed to supply definitions for a non-/footer write.
    // Declare this before mounting the TUI: fullscreen initialization can
    // synchronously invoke its persistence callback. Use the raw USER value so
    // unknown/future definitions survive unrelated writes unchanged.
    const userFooterCustomItemsForSave = (): unknown => {
      const raw = backend.config.footerCustomItems.rawForPersistence()
      if (raw.kind === 'unavailable') throw new Error('custom footer definitions unavailable; settings write aborted')
      return raw.value
    }

    // Launch-time preset entry: `--preset` wins over $DSH_PI_TUI_PRESET, and
    // both fall back to the saved default (settings `agent-presets.default`,
    // then the roster config) when absent. A fresh session starts on it; a
    // resumed BLANK session may still be re-composed onto it; a resumed
    // started session keeps its recorded preset (warned, never overridden).
    const launchPreset = startup.presetId ?? (process.env.DSH_PI_TUI_PRESET?.trim() || undefined)
    // Run-local preset override chosen with /preset before any session
    // exists (deferred start): the next session composes on it, ahead of
    // launchPreset and the saved default — the web's "applies to sessions
    // you start from now on" model scoped to this process. It stays until
    // changed or the TUI exits; sessions that already exist ignore it
    // (their composition is fixed).
    let pendingPreset: string | undefined
    diag.info('boot', {
      pid: process.pid,
      dsh: dshVersion() ?? 'unknown',
      bundle: packageVersion(),
      cwd: process.cwd(),
      session: sessionId ?? '(deferred)',
      preset: launchPreset ?? 'default',
      // Host capability check (plan stage K): the services the TUI surface
      // consumes. Each one degrades locally when absent (presets → default
      // composition, commands → plain
      // messages, shell → spawn fallback), so this line is diagnostic, not
      // a mount gate — the TUI never fails to mount without explanation.
      services: [
        'sessionPersistence', 'agents', 'commands', 'tools', 'shell', 'llm',
        'settings', 'skills', 'userQuestions', 'approval', 'permissionPresets',
      ].filter(name => ctx.get(name as never) !== undefined).join(','),
    })
    /** Resolve the launch composition, falling back to the default on an unknown id. */
    const launchComposition = async (): Promise<{ composition: AgentComposition; failure?: string }> => {
      try {
        return { composition: await compose(pendingPreset ?? launchPreset) }
      } catch (error) {
        const message = safeErrorMessage(error)
        ctx.logger.warn(`tui-runner: launch preset unavailable: ${message}`)
        diag.warn('preset unavailable', { preset: launchPreset ?? 'default', error: message })
        return {
          composition: await compose(),
          failure: `preset "${launchPreset}" unavailable; started with the default`,
        }
      }
    }

    // Open-time session lock: the ONE session this process currently holds
    // (acquired at resume/switch; a switch-away lock is released only by
    // the verified cooling release, and a clean exit leaves touched locks
    // as stale records for the next opener's takeover).
    // `undefined` means either no session yet (deferred start) or no lock
    // (deployment cannot lock — the fail-closed resume/refuse rules cover
    // it for existing sessions).
    // The multi-slot open-lock registry: a transition may hold the OLD and
    // the TARGET lock at once (the old lock is never released before the
    // target is acquired — releasing first opened a vacuum window where
    // another process could grab the old session while a switch was still
    // failing, and the current session would stay live WITHOUT its lock).
    const openLocks = new OpenLockHolder()
    // The /proc probe for stale-lock takeover, created once per mount.
    const lockProc = createProcProbe()
    /** One open-lock acquisition's settled result. `unavailable` and
     * `refused` are DISTINCT: an existing session may proceed sessionless
     * itself (nothing is written without a session), but a FRESH session's
     * target-lock-before-create transaction must see `acquired` — anything
     * else means the child would be published without its lock (review
     * round 7: the old `string | undefined` return conflated "locked" with
     * "cannot lock", so a fresh pre-acquire silently degenerated to
     * publish-before-lock via no-lock-dir). */
    type OpenLockResult =
      | { kind: 'acquired' }
      | { kind: 'unavailable'; reason: string }
      | { kind: 'refused'; message: string }
    /** The PHYSICAL open-time lock take (the lease manager's low-level
     * surface). Never throws. A FRESH session's artifact directory is
     * pre-created by the lock layer when needed, so the lock can
     * physically exist BEFORE the session log does. */
    const physicalAcquire = (target: { id: string; header?: { cwd?: string } }): {
      result: OpenLockResult
      release: () => void
    } => {
      const { id: sessionId, header } = target
      if (openLocks.has(sessionId)) return { result: { kind: 'acquired' }, release: () => openLocks.release(sessionId) }
      const persistence = ctx.get('sessionPersistence') as SessionLockPersistence | undefined
      const outcome = acquireSessionLock(
        {
          persistence,
          fs: {
            readFileSync: (path) => readFileSync(path, 'utf8'),
            writeFileSync: (path, content, options) => writeFileSync(path, content, options),
            unlinkSync,
            mkdirSync: (dir, options) => mkdirSync(dir, options),
            rmdirSync: (dir) => rmdirSync(dir),
          },
          proc: lockProc,
        },
        { id: sessionId, header },
        selfLockInfo(),
      )
      switch (outcome.kind) {
        case 'acquired':
        case 'taken-over-stale':
          openLocks.add(sessionId, outcome.release)
          if (outcome.kind === 'taken-over-stale') {
            diag.warn('session lock stale taken over', { session: sessionId })
          }
          return { result: { kind: 'acquired' }, release: () => openLocks.release(sessionId) }
        case 'held':
          diag.warn('session lock held', { session: sessionId, pid: outcome.owner.pid })
          return { result: { kind: 'refused', message: lockHeldNotice(sessionId, outcome.owner) }, release: () => {} }
        case 'unverifiable':
          diag.warn('session lock unverifiable', { session: sessionId, pid: outcome.owner?.pid })
          return {
            result: {
              kind: 'refused',
              message: outcome.owner === undefined
                ? `Session ${sessionId} has an unreadable or malformed lock file; refusing to open it here. If no other dsh process is using it, delete the owner.lock file next to the session log and retry.`
                : `Session ${sessionId} has a lock file whose owner (pid ${outcome.owner.pid}) cannot be verified; refusing to open it here. If that process is gone, delete the owner.lock file next to the session log and retry.`,
            },
            release: () => {},
          }
        case 'unavailable':
          // No persistence/artifact/dir/write access: proceed without a
          // lock for EXISTING sessions (fail-closed at the transition);
          // a fresh target's transition treats this as a failure too.
          return { result: { kind: 'unavailable', reason: outcome.reason }, release: () => {} }
      }
    }
    /** The process-global lease manager: ownership policy over the physical
     * locks. A remount (HMR) reuses the SAME manager so this process never
     * forgets the locks it physically holds. */
    const leaseWorld = acquireProcessLeaseManager({
      acquire: physicalAcquire,
    })
    const leaseManager = leaseWorld.manager
    // The retired-session cooling verifier: after a switch, the OLD
    // session's lease is verified (quiet window + durable parity) before
    // its physical lock may be released cross-process (convergence plan
    // phase 6).
    const coolingCoordinator = new SessionLeaseCoolingCoordinator({
      leaseManager,
      persistence: () => ctx.get('sessionPersistence') as CoolingPersistenceLike | undefined,
      diag,
      signal: lifecycleController.signal,
    })
    // HMR/plugin remount: the lease manager is process-global, so a new
    // runner instance must take over the pending COOLING verifications
    // (the old instance's verifier died with its lifecycle signal).
    coolingCoordinator.resumePending()
    /** Try to reserve the lease for a session about to be ACTIVATED
     * (physical acquire when this process does not hold it; idempotent
     * for held leases). Uses the LIFECYCLE-layer reservation: a held
     * COOLING/ACTIVE/TOUCHED/RESERVED lease is reactivated — the
     * previous lifecycle epoch is invalidated synchronously BEFORE any
     * DSH resume, so an older cooling verifier can never affect the new
     * lifecycle (the reactivation rule). A held PINNED lease is a STICKY
     * QUARANTINE and is REFUSED (never demoted to a new lifecycle). */
    const acquireOpenLock = (sessionId: string, header?: { cwd?: string }): OpenLockResult =>
      leaseManager.reserveForActivation({ id: sessionId, header })
    /** A rejected create/resume is NEVER retried and NEVER falls back (the
     * first DSH call may have left a hidden lifecycle — see the
     * sticky-quarantine rule). */
    // A failed --session resume pins the session and the surface starts
    // sessionless (the next input creates a new session); the failure is
    // surfaced as a notify line.
    let resumeFailure: string | undefined
    // Pre-mount startup status (explicit resume only): the resume
    // transaction (preflight, lock, DSH resume) and the whenIdle/catalog
    // barrier run BEFORE the TUI mounts — a single-line TTY hint keeps
    // the blank terminal from reading as a hang. Pure presentation: it
    // never owns lifecycle state, and every teardown path (success,
    // resume reject, abort/signal, HMR unload, startup exception) clears
    // it — the abort listener covers the teardown paths, the explicit
    // clear covers the success path.
    const startupStatus = createStartupStatus(config.startupStatusOutput ?? {
      isTTY: process.stdout.isTTY === true,
      write: (text) => process.stdout.write(text),
    })
    lifecycleController.signal.addEventListener('abort', () => startupStatus.clear(), { once: true })
    let handle: SessionHandle | undefined
    if (sessionId !== undefined) {
      // The explicit-resume path is the ONLY pre-mount wait worth
      // explaining: deferred / sessionless starts have nothing to resume.
      startupStatus.show('Resuming session…')
      try {
        // The lock file lives next to the session log, whose path needs the
        // session's stored cwd: resolve the header first (best-effort — an
        // unresolvable header still proceeds to the normal resume path).
        let lockHeader: { cwd?: string } | undefined
        try {
          const persistence = ctx.get('sessionPersistence')
          lockHeader = (await persistence?.list())?.find(candidate => candidate.id === sessionId)
        } catch {
          // Header lookup is best-effort; the resume path reports failures.
        }
        // The stored session's recorded preset wins (resolved from the log,
        // not the header): a session that switched while blank ran every turn
        // under the newer composition, and rebuilding it differently would
        // replay tool calls the model can no longer make. ALL fallible
        // preflight runs BEFORE the physical lock is taken (review
        // round 36): a preflight failure leaves no lock to release or pin.
        const recorded = await recordedPreset(ctx, sessionId)
        // Preflight: the preset composition is resolved BEFORE the physical
        // lock (a roster failure must never pin a session that did not enter
        // the DSH boundary). The RESOLVED composition (with its concrete
        // agentPreset) is what the adapter re-mounts — never a second
        // compose(undefined) that could resolve a different default preset.
        const launchComposition = await compose(recorded)
        // Refuse to resume a session another live dsh process holds: the
        // second open makes persistence synthesize interrupted-turn closers
        // into the shared log while the first process keeps appending from
        // its own in-memory seq — the classic seq-collision corruption (the
        // second opener's memory matches the file, so no post-open check
        // would see it). Refusing here avoids the collision entirely.
        const lock = acquireOpenLock(sessionId, lockHeader)
        if (lock.kind === 'refused') {
          throw new SessionLockRefusedError(lock.message)
        }
        // Fail-closed (convergence plan phase 2): a writable existing
        // session REQUIRES its physical owner lock — an unavailable lock
        // means this deployment cannot guarantee single-owner writes, so
        // the resume is refused instead of proceeding unowned.
        if (lock.kind === 'unavailable') {
          throw new SessionLockRefusedError(`cannot lock session ${sessionId} (${lock.reason}); refusing to resume without an owner lock`)
        }
        // The DSH boundary: the resume target is touched IMMEDIATELY
        // before the DSH call (ALL fallible preflight above already ran —
        // a preflight failure must not pin a session that never entered
        // the DSH boundary; review rounds 32/36). From here on a failure
        // pins it (no release, no automatic fallback).
        leaseManager.markTouched(sessionId)
        // A rejection is NEVER retried (no same-ID recovery): the first
        // DSH call may have left a hidden lifecycle, so a retry cannot
        // clear the uncertainty — the session is PINNED immediately
        // (fail-closed; no publication-phase inference, no second fresh
        // fallback).
        // Agent options are only the creation/resume fallback. The setup
        // installs an Agent-local selection and reconstructs the target
        // Session's durable model choice after resume.
        const fallback = defaultModel.currentSelection()
        handle = await backend.sessionLifecycle.resume({
          resumeSessionId: SessionId(sessionId),
          provider: fallback.provider,
          model: fallback.model,
          // The RESOLVED preset id from the preflight composition — the
          // adapter composes this EXACT id, never a re-resolved default.
          agentPreset: launchComposition.agentPreset,
        })
        // Suspend the pre-mount status before ANY ordinary log output
        // (uniform rule): the status owns the current terminal line, and
        // a logger/diag write on a TTY shares the cursor — the status
        // must be cleared first so the log line is clean and the later
        // clear can never erase the wrong line. The 'Preparing
        // conversation…' stage re-arms it.
        startupStatus.clear()
        diag.info('resume ok', {
          session: sessionId,
          seq: Number((handle.direct!.agent as Agent).session.seq),
          preset: launchComposition.agentPreset ?? 'default',
        })
        // A launch-time preset may still apply while the session is blank;
        // the blank check lives inside recomposeBlank (shared with /preset).
        if (launchPreset !== undefined && launchPreset !== recorded) {
          try {
            const outcome = await recomposeBlank(ctx, handle.direct!.agent as Agent, launchPreset)
            if (outcome.kind === 'locked') {
              const message = `session ${sessionId} has started; its agent preset ${recorded} is fixed, ignoring --preset ${launchPreset}`
              startupStatus.clear()
              ctx.logger.warn(`tui-runner: ${message}`)
              diag.warn('preset ignored on resume', { session: sessionId, preset: launchPreset })
            }
          } catch (error) {
            const message = `--preset ${launchPreset} not applied on resume: ${safeErrorMessage(error)}`
            startupStatus.clear()
            ctx.logger.warn(`tui-runner: ${message}`)
            diag.warn('preset not applied on resume', { session: sessionId, preset: launchPreset, error: message })
          }
        }
      } catch (error) {
        // Suspend the pre-mount status BEFORE the failure logs: the
        // status owns the current terminal line, and the logger/diag
        // writes below share the TTY cursor — without this clear the
        // warning would interleave with the status and the later
        // mount-time clear would erase the wrong line.
        startupStatus.clear()
        // A lock refusal is NOT recoverable: the user asked for a specific
        // held session. Re-throw so the runner exits with the refusal as
        // the message.
        if (error instanceof SessionLockRefusedError) {
          throw error
        }
        // The failed target is PINNED ONLY if it crossed the DSH boundary
        // (touched) — a PREFLIGHT failure leaves no lock and nothing to
        // pin (review round 36). There is NO second fresh fallback
        // (convergence plan phase 4): the surface starts sessionless and
        // the next user input creates a new session.
        const message = safeErrorMessage(error)
        if (leaseManager.state(sessionId)?.touchedByDsh === true) {
          leaseManager.pin(sessionId, `resume failed: ${message}`)
          diag.warn('session lease pinned', { session: sessionId, reason: `resume failed: ${message}` })
        }
        ctx.logger.warn(`tui-runner: resume ${sessionId} failed: ${message}`)
        diag.error('resume failed', { session: sessionId, error: message })
        resumeFailure = `session ${sessionId} could not be resumed; it stays locked by this TUI`
      }
    } else {
      // Deferred session creation: without --session the TUI opens with NO
      // session at all — zero agent, zero log, zero persistence — and the
      // first user message creates it (see ensureSession below).
    }
    let liveHandle = handle?.direct?.ownerHandle as AgentHandle | undefined
    liveAgent = handle?.direct?.agent as Agent | undefined
    // The completion-notification controller follows the live identity:
    // a resumed idle session must never notify (no observed running).
    completionController.setLiveAgent(liveAgent?.id)
    if (liveAgent !== undefined) {
      // The committed live session's lease becomes ACTIVE (a successful
      // launch resume must not stay TOUCHED — review round 32).
      leaseManager.markActive(liveAgent.session.id)
      // The resume transaction succeeded; the remaining pre-mount wait is
      // the conversation preparation (whenIdle + the catalog ready
      // barrier) — the second status stage replaces the first in place
      // and STAYS until the barrier completes (the catalog prefetch can
      // take seconds; a cleared line would read as a hang again).
      startupStatus.show('Preparing conversation…')
      await liveAgent.whenIdle()
    }
    // Surface catalog resolution BEFORE the TUI mounts (the ready barrier):
    // a resumed agent prefetches its effective catalog (a live read emits no
    // session events); the deferred start reads the cold HUMAN SKILL catalog
    // through the effective preset's STANDING SCOPE — no Agent, no session,
    // no turn, no durable artifact. `initialSnapshot` is undefined for the
    // deferred start; `initialSkills` carries the cold catalog; `surfaceNotice`
    // carries the one-shot degradation message on any failure.
    let initialSnapshot: SurfaceCatalogSnapshot | undefined
    let initialSkills: HumanSkillCatalog | undefined
    let surfaceNotice: string | undefined
    {
      // The effective preset for the cold standing read — the SAME
      // precedence ensureSession uses (pendingPreset → launch → default).
      // A failing launch preset falls back to the default inside
      // launchComposition; a fully broken roster must not block startup —
      // the cold read then uses the deployment default (and degrades
      // inside resolveColdSkillTarget if that is broken too), and
      // ensureSession surfaces the preset failure on the first input.
      let effectivePresetId: string | undefined
      try {
        const launched = await launchComposition()
        if (launched.failure !== undefined) resumeFailure = launched.failure
        effectivePresetId = launched.composition.agentPreset
      } catch (error) {
        // Suspend the status before the log, then re-arm it ONLY for a
        // live resumed session: the catalog barrier below is still part
        // of the pre-mount wait for a resume, but a fresh/deferred start
        // (or a failed resume) never shows any startup status — the
        // "fresh start stays silent" contract must hold on this failure
        // path too.
        startupStatus.clear()
        diag.warn('preset resolution failed at startup', { error: safeErrorMessage(error) })
        if (liveAgent !== undefined) {
          startupStatus.show('Preparing conversation…')
        }
      }
      const resolution = await resolveInitialCatalog({
        liveAgent,
        presetId: effectivePresetId,
        signal: lifecycleController.signal,
        ctx: ctx as unknown as SurfaceCatalogContext,
        diag,
        // The catalog read may emit its own failure warn: suspend the
        // status right before it (the barrier itself keeps the status
        // on screen).
        onLog: () => startupStatus.clear(),
      })
      initialSnapshot = resolution.snapshot
      initialSkills = resolution.skills
      surfaceNotice = resolution.notice
    }
    /** The preset the live agent runs on, when the deployment composes one. */
    const currentPreset = (): string | undefined => {
      if (liveAgent === undefined) return undefined
      const presets = ctx.get('agentPresets') as {
        composedPreset?: (agentCtx: unknown) => unknown
      } | undefined
      if (typeof presets?.composedPreset === 'function') {
        try {
          const composed = presets.composedPreset(liveAgent.ctx)
          if (typeof composed === 'string') return composed
        } catch {
          // During teardown, fall back to the DSH projection read below.
        }
      }
      return sessionPresetOf(ctx, liveAgent.session)
    }
    // Incremental fold state for the live session's log; reset on switch. A
    // resumed session is hydrated only by initLiveSession below, so startup
    // wiring never pre-folds the same event log a second time.
    let folder = new TranscriptFolder()
    let windowController = new TranscriptWindowController({
      windowTurns: TRANSCRIPT_WINDOW_TURNS,
      stepTurns: TRANSCRIPT_WINDOW_STEP,
      turns: folder.groupedTurns(),
    })
    let statsFolder = new StatsFolder()
    let goalText: string | undefined

    /** Repaint the welcome card from the live agent's current facts. Re-read
     * on every call so a still-blank session's preset switch shows up. */
    const updateWelcomeCard = (): void => {
      if (liveAgent === undefined) {
        app.setWelcomeIdle(true)
        return
      }
      const current = selected.current
      const provider = current?.provider ?? liveAgent.options.provider
      const model = current?.model ?? liveAgent.options.model
      app.setWelcomeCard({
        cwd: sessionCwd(),
        sessionId: liveAgent.session.id,
        model: `${provider}/${model}`,
        version: packageVersion(),
        ...currentPreset() === undefined ? {} : { preset: currentPreset() },
      })
    }

    /** The ONE writer for the live session: every path that changes which
     * session owns the surface — /new, /fork, rewind, `/sessions` switch,
     * the first-session creation — runs its WHOLE workflow (prepare/create
     * → flush → dispose old → assign new → generation bump) inside
     * {@link transitionGate}. Without the gate a transition can interleave
     * with another: a fork child could be created (and its seed published
     * to persistence) before a stale check sees the surface already moved —
     * `dispose()` stops the agent but never deletes the persisted session —
     * and a stale identity check could pass, then yield across an await
     * inside the commit preparation, letting a concurrent switch land and
     * later get overwritten. The rewind commit holds the gate from BEFORE
     * `createForkedAgent` (the create itself is inside the exclusive
     * section), so a stale rewind never creates a child at all.
     * @see SessionTransitionGate */
    const transitionGate = new SessionTransitionGate()
    // The writer/transition barrier: transitions freeze TUI writers and
    // wait for in-flight ones to drain; writers run inside runWriter so a
    // transition started later can never interleave with a write already
    // awaiting a provider/IO (convergence plan phase 3).
    const operationBarrier = new SessionOperationBarrier()

    /**
     * The ONE session-transition transaction, shared by /new, /fork,
     * conversation rewind and `/sessions` switch/resume. The canonical
     * ordering lives in `runTransitionTo` (src/transition.ts — unit-tested
     * against the exact phase order); this is the runner's host adapter.
     *
     * The ordering is the whole point (review rounds 2–3):
     *
     *   1. QUIESCE OLD — `whenIdle()` then the FINAL flush, with the old
     *      session's open lock still held. `dispose()` is an async
     *      quiescence and a cancelled RUNNING turn appends its closure
     *      events (interrupted assistant/message, step/end, turn/end) in
     *      finally blocks — releasing the old lock before the old agent is
     *      idle would let another dsh process resume the session while
     *      those closures are still appended (two-writers/seq-collision).
     *      Old-idle-then-flush closes that window; may fail → abort with
     *      ZERO child side effects.
     *   2. caller `prepare` (rewind's stale gate, switch lock pre-checks)
     *      — may fail → abort;
     *   3. create/resume the CHILD — may fail → abort; once it SUCCEEDS the
     *      child is published (session/created → persistence may already
     *      write its seed) and there is NO failure path afterwards that may
     *      be interpreted as "the child never happened" (`dispose()` stops
     *      an agent but never deletes a persisted session; dsh has no
     *      durable rollback);
     *   4. COMMIT — a synchronous critical section (generation bump, live
     *      handle/agent replacement — the target
     *      lock was acquired in phase 2 and stays held; NO lock changes
     *      happen here, review round 10) with no awaits between its
     *      steps;
     *   5. RETIRE — old-handle dispose (now idle: no abort closures), child
     *      whenIdle, surface rebuild, catalog refresh — failures WARN ONLY,
     *      the committed child always stands.
     *
     * Must be called inside {@link transitionGate} (via
     * `withSessionTransition` or the rewind commit's own gate wrapper).
     */

/** Extract the live in-process agent from a transition next value: the
 * Direct SessionHandle carries it via direct.agent; an AgentHandle IS the
 * agent handle. Remote handles carry neither (the client runtime owns the
 * session there — M2+). */
// transition agent/handle extraction lives in runtime/session-lifecycle-port.ts
// (ownerHandleOf / directAgentOf) so the runner AND the contract tests share
// the exact extraction the transition commit uses.
    const transitionTo = async <T>(steps: TransitionSteps<T> & { inheritSelection?: ModelSelection }): Promise<TransitionOutcome<T>> => {
      const from = liveAgent?.session.id
      const oldHandle = liveHandle
      return runTransitionTo<T>({
        quiesceOld: async () => {
          if (liveAgent === undefined) return undefined
          // QUIESCE first: after whenIdle the old agent can no longer
          // produce turn events, so the final flush below is truly final —
          // releasing its open lock afterwards cannot race our own
          // teardown appends. (A /new or /fork while the agent is busy now
          // WAITS for the current activity instead of aborting it — the
          // deliberate product semantics, see docs/concurrency.md.)
          await liveAgent.whenIdle()
          // Final flush, with the old session's lock still held; the
          // FINAL snapshot (event count, tail fingerprint) is captured
          // here — the cooling verifier compares the durable state
          // against it (convergence plan phase 5/6).
          await sessions.flush(liveAgent.session)
          return snapshotSession(liveAgent.session)
        },
        acquireTargetLease: (target) => leaseManager.reserveForActivation(target),
        releaseUntouchedTarget: (sessionId) => leaseManager.releaseUntouched(sessionId),
        markTargetTouched: (sessionId) => leaseManager.markTouched(sessionId),
        commit: (next) => {
          // A new session owns the surface: the OLD session's pending
          // submit ack must never leak into it, and its latency timeline
          // is meaningless now.
          settleLocalSubmitAck('session switched')
          submitLatencyTracker.reset()
          // A new session owns the surface: bump the generation so late
          // async work from the old session cannot commit, and clear
          // old-session state.
          bumpSessionGeneration()
          liveHandle = ownerHandleOf(next) as AgentHandle | undefined
          liveAgent = directAgentOf(next) as Agent
          // Session switch: the notification controller resets with the
          // new live identity — a late idle from the OLD agent is fenced
          // out and the new agent must be observed running before it can
          // ever notify.
          completionController.setLiveAgent(liveAgent.id)
          leaseManager.markActive((directAgentOf(next) as Agent).session.id)
          // A fresh target inherits the surface's explicit choice (/new):
          // the create options carried it, but the installed ref would
          // otherwise fall back to the global default while the default
          // save is still in flight (or after it failed). Record it
          // durably so the first request and any later resume both see it.
          // A target with durable model history (a resumed Session) keeps
          // its own reconstruction and is never touched.
          if (steps.inheritSelection !== undefined) {
            const target = directAgentOf(next) as Agent
            // The shared fold decides whether the target carries VALID
            // durable model history (pending intent or a usable request
            // header): malformed events are not durable history, and the
            // fold is null-safe, so a hostile log can never throw here.
            const folded = foldPendingModelSelection(target.session.snapshotEvents())
            if (folded.lastUsed === undefined && folded.pending === undefined) {
              modelSelections.selectForNextRequest(target, steps.inheritSelection)
            }
          }
        },
        pinTarget: (sessionId, reason) => {
          leaseManager.pin(sessionId, reason)
          diag.warn('session lease pinned', { session: sessionId, reason })
        },
        retireOld: async (next, oldSnapshot) => {
          const retired: string[] = []
          // 1. Dispose the OLD handle FIRST: whenIdle only idles the agent
          // machine — session-scoped async writers (e.g. the title
          // generator awaiting a provider) are aborted only by
          // session/disposed, which the dispose fires. The old session's
          // lock is still held throughout.
          let disposeSucceeded = true
          if (oldHandle !== undefined) {
            try {
              await oldHandle.dispose()
            } catch (error) {
              // A failed dispose means the old session may still have
              // writers: PIN it (never release), the child stays current,
              // and COOLING MUST NOT START (a pinned lease never
              // downgrades — review round 37).
              disposeSucceeded = false
              if (from !== undefined) {
                leaseManager.pin(from, `old handle dispose failed: ${safeErrorMessage(error)}`)
                diag.warn('session lease pinned', { session: from, reason: 'old handle dispose failed' })
              }
              retired.push(`old handle dispose: ${safeErrorMessage(error)}`)
            }
          }
          // 2. The OLD session enters COOLING — ONLY after a successful
          // dispose (review round 37): the lease manager / cooling
          // coordinator decides when its physical lock may be released
          // (quiet window + durable parity + stable signals; any
          // uncertainty pins it). The old lock is deliberately NOT
          // released here (convergence plan phase 5).
          if (from !== undefined && disposeSucceeded) {
            if (oldSnapshot === undefined) {
              leaseManager.pin(from, 'no final snapshot captured before the switch')
              diag.warn('session lease pinned', { session: from, reason: 'no final snapshot' })
            } else {
              // Local detach gate (convergence plan appendix): the dispose
              // must have REMOVED the old agent/session from the live
              // registries — release eligibility requires the old session
              // to be truly closed locally before any cross-process
              // handover can be considered.
              const agents = ctx.get('agents') as { get?: (id: string) => unknown } | undefined
              const sessions = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
              let detached = true
              try {
                if (agents?.get?.(from) !== undefined || sessions?.get?.(from) !== undefined) {
                  detached = false
                }
              } catch {
                detached = false
              }
              if (!detached) {
                leaseManager.pin(from, 'old agent/session remained registered after dispose')
                diag.warn('session lease pinned', { session: from, reason: 'old agent/session remained registered after dispose' })
              } else {
                // The old session enters COOLING with a NEW lifecycle
                // epoch; the cooling coordinator verifies under exactly
                // that epoch (the reactivation rule: a same-process
                // re-open invalidates it, and the old verifier then can
                // never release/pin the new lifecycle).
                const epoch = leaseManager.beginCooling(from, oldSnapshot)
                if (epoch !== undefined) {
                  diag.info('session lease cooling started', { session: from, events: oldSnapshot.eventCount, epoch })
                  coolingCoordinator.start(from, oldSnapshot, epoch)
                }
              }
            }
          }
          try {
            await (directAgentOf(next) as Agent).whenIdle()
          } catch (error) {
            retired.push(`child whenIdle: ${safeErrorMessage(error)}`)
          }
          try {
            await initLiveSession(directAgentOf(next) as Agent)
          } catch (error) {
            retired.push(`surface rebuild: ${safeErrorMessage(error)}`)
          }
          // The new owner's catalog refresh is AWAITED before the switch is
          // reported: the old wrappers became revalidating transitions at
          // the target change, and the report must not precede the new
          // catalog (a failed attempt still returns a successful switch —
          // the coordinator warns and the transition commands keep
          // re-validating).
          try {
            await refreshLiveCatalog(directAgentOf(next) as Agent)
          } catch (error) {
            retired.push(`catalog refresh: ${safeErrorMessage(error)}`)
          }
          if (retired.length > 0) {
            diag.error('transition retire failed (child committed)', { to: (directAgentOf(next) as Agent).session.id, failures: retired })
          }
          diag.info('switch ok', { from: from ?? '(none)', to: (directAgentOf(next) as Agent).session.id, seq: Number((directAgentOf(next) as Agent).session.seq) })
        },
        recordFailure: (phase, error) => {
          diag.error(`transition ${phase} failed`, { from, error: safeErrorMessage(error) })
        },
      }, steps)
    }

    /** Hand the TUI over to another persisted session. Never throws: every
     * failure (unknown session, broken log, preset mount) returns an error
     * string so callers' `.then(error => ...)` need no rejection path. The
     * whole switch (lock pre-checks → compose → resume → commit) runs inside the
     * session-transition gate, so it can never interleave with /new, /fork
     * or a rewind commit (the single-writer rule). */
    const switchSession = (sessionId: string): Promise<string | undefined> =>
      transitionGate.run(() => operationBarrier.runTransition(() => switchSessionLocked(sessionId)))

    const switchSessionLocked = async (sessionId: string): Promise<string | undefined> => {
      // A switch INTO the session we are already on is a no-op — refusing
      // it up front also keeps the failure branches from ever releasing the
      // CURRENT session's lock through a same-session target id (review
      // round 7: the idempotent acquire would not record a new lock, but an
      // unconditional releaseOpenLock(target) would drop the live one).
      if (liveAgent !== undefined && liveAgent.session.id === sessionId) {
        return 'already on this session'
      }
      // Draft cleanup happens ONLY after the switch committed (the
      // transaction returned ok): a refused/failed switch keeps the CURRENT
      // session and its staged drafts intact — clearing up front would
      // orphan the editor's placeholders on every failed switch (review
      // finding 2).
      try {
        // The unified transaction: the OLD session is flushed FIRST (with
        // its lock still held — the flush-before-release rule), then the
        // TARGET's lock is acquired WHILE STILL HOLDING the current one
        // (the multi-slot holder; a non-blocking refusal, never a wait),
        // then the resume publishes the child. A failure anywhere before
        // the create leaves the current session live WITH its lock — there
        // is no vacuum window and nothing to re-acquire.
        // The target's lock path needs its stored cwd: resolve the header
        // first (best-effort — an unresolvable header still proceeds).
        let lockHeader: { cwd?: string } | undefined
        try {
          const persistence = ctx.get('sessionPersistence')
          lockHeader = (await persistence?.list())?.find(candidate => candidate.id === sessionId)
        } catch {
          // Best-effort; the resume path reports failures.
        }
        // The recorded preset drives the resume; the composition is
        // resolved by the Direct adapter from that id (preflight here only
        // for lock ordering — a roster failure must not pin a session that
        // never entered the DSH boundary).
        const recorded = await recordedPreset(ctx, sessionId)
        // Preflight with the resolved composition (see the launch resume
        // note): the adapter re-mounts the EXACT resolved preset id.
        const switchComposition = await compose(recorded)
        // The target's setup reconstructs its own effective selection. These
        // values are only the dynamic fallback required by Agent resume; never
        // copy the old Session's selected ref into the target.
        const fallback = defaultModel.currentSelection()
        const resumeOptions = {
          resumeSessionId: SessionId(sessionId),
          provider: fallback.provider,
          model: fallback.model,
          agentPreset: switchComposition.agentPreset,
        }
        const result = await transitionTo({
          target: { id: sessionId, header: lockHeader },
          // A rejected resume is NEVER retried: the first DSH call may
          // have left a hidden lifecycle, so the target is PINNED
          // immediately (fail-closed; the session stays locked for this
          // process's lifetime).
          create: () => backend.sessionLifecycle.resume(resumeOptions),
        })
        if (!result.ok) {
          // The resume failed: the target is pinned (or refused before
          // the DSH call). The CURRENT session is still live AND still
          // holds its own lock.
          return result.message
        }
        // The switch COMMITTED: staged drafts are per-session UI state —
        // drop the UNPINNED ones now (never durable attachments, plan
        // §14). In-flight submissions keep their pinned drafts so a stale
        // submission can still restore its text with a live backing draft
        // (review finding: clear() would orphan the restored placeholders).
        draftImages.clearUnpinned()
        return undefined
      } catch (error) {
        const message = safeErrorMessage(error)
        ctx.logger.warn(`tui-runner: switch to ${sessionId} failed: ${message}`)
        diag.error('switch failed', { session: sessionId, error: message })
        // The CURRENT session is still live and still holds its own lock;
        // a target that crossed the DSH boundary stays pinned.
        return `switch failed: ${message}`
      }
    }

    // Footer state: model label, cwd, git branch, turn/step counters, and
    // the stats line (LLM timing, tokens, context pressure).
    const cwd = process.cwd()
    /**
     * The LIVE session's workspace: each session carries its own header cwd
     * (fixed at creation, e.g. a session birthed by the web in another
     * directory). The footer/welcome/completions AND `!`/`!!` shell runs
     * follow THIS cwd, so a session switch moves the whole surface with the
     * session (pi parity: `executeBash` runs in the session cwd) and a
     * shell command executes where the completions suggest files; `cwd`
     * (the process cwd) stays for launch-relative concerns (/export paths).
     */
    const sessionCwd = (): string => liveAgent?.session.header.cwd ?? cwd
    /**
     * Derive + write the terminal window title from the CURRENT surface
     * identity (the title policy in terminal-title.ts): session
     * presentation title first, the session (or launch) short cwd as the
     * fallback — never the full session UUID / model / preset. Called at
     * every identity change: fresh startup, session create/resume/switch,
     * and session/title events (the session title event lands in the
     * header through setSessionTitle; the OSC title follows).
     */
    const refreshTerminalTitle = (): void => {
      const title = terminalTitleOf({
        sessionTitle: app.getSessionTitle(),
        cwd: sessionCwd(),
      })
      setTerminalTitle(title)
    }
    /**
     * Every cwd this process has EVER known (launch cwd + every live
     * session's header cwd, accumulated across creates/resumes/swaps).
     * The Ctrl+R all-directory search resolves legacy files through this
     * set (plan §6.2 Rule 2 — an IDENTITY match, never a hash break).
     * A Set, not a Map, so the resolver below is rebuilt on every call:
     * the all-scope search must see the NEWEST known cwds, not a snapshot
     * from source construction.
     */
    const knownHistoryCwdSet = new Set<string>([cwd])
    const rememberHistoryCwd = (dir: string): void => {
      if (dir === '' || dir === undefined) return
      knownHistoryCwdSet.add(dir)
    }
    /**
     * The known-cwd identity map for Ctrl+R all-directory history recovery
     * (plan §6.2 Rule 2): `md5(cwd) → cwd` for every workspace this process
     * knows. Resolved fresh on EVERY call — the search source keeps the
     * RESOLVER, so a session created/switched after startup is immediately
     * recoverable (a legacy-only file in that cwd shows up on the next
     * search, no restart needed).
     */
    const knownHistoryCwds = (): Map<string, string> => {
      const map = new Map<string, string>()
      const seed = (dir: string): void => {
        if (dir === '' || dir === undefined) return
        const hash = historyFilePath(dshHome(process.env), dir).split('/').pop()!.replace(/\.jsonl$/, '')
        map.set(hash, dir)
      }
      for (const dir of knownHistoryCwdSet) seed(dir)
      seed(sessionCwd())
      return map
    }
    /** The footer model label: the live selection (with effort) when one exists. */
    const modelLabel = (): string => {
      const selection = selected.current
      if (selection !== undefined) {
        return selection.reasoningEffort === undefined
          ? `${selection.provider}/${selection.model}`
          : `${selection.provider}/${selection.model} @${selection.reasoningEffort}`
      }
      if (liveAgent === undefined) return 'no model'
      return `${liveAgent.options.provider}/${liveAgent.options.model}`
    }
    /** M0: the composition section (how the agent is composed — NOT
     * permission, NOT plan). */
    const deriveCompositionStatus = (): CompositionStatus => {
      const selection = selected.current
      const model = selection !== undefined
        ? {
            provider: selection.provider,
            id: selection.model,
            displayName: selection.model,
            ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
          }
        : liveAgent === undefined || liveAgent.options.provider === undefined || liveAgent.options.model === undefined
          ? undefined
          : {
              provider: liveAgent.options.provider,
              id: liveAgent.options.model,
              displayName: liveAgent.options.model,
            }
      const preset = currentPreset()
      return {
        ...model === undefined ? {} : { model },
        ...preset === undefined ? {} : { agentPreset: { id: preset, label: preset } },
      }
    }
    /** M0: the workspace section (cwd/project/branch — project and cwd are
     * deliberately separate facts). */
    const deriveWorkspaceStatus = (cwd: string): WorkspaceStatus => {
      const parts = cwd.split('/').filter(Boolean)
      return {
        cwd,
        ...parts.length === 0 ? {} : { project: parts[parts.length - 1]! },
        ...gitBranch(cwd) === '' ? {} : { branch: gitBranch(cwd) },
      }
    }
    /** M0: the host section (dsh + bundle versions). tuiVersion is the
     * BUNDLE's own version (bundleVersion), never the dsh version — the
     * welcome-card helper prefers dsh for display, which would show the
     * harness version under `version(format=tui)` (review finding). */
    const deriveHostStatus = (): HostStatus => ({
      ...dshVersion() === undefined ? {} : { dshVersion: dshVersion() },
      tuiVersion: bundleVersion(),
    })
    // PR D2: the session-bound context-measurement cache. The coordinator
    // owns the value/dirty/session identity; the runner owns the event
    // classification (which events mark dirty, which only repaint cheaply).
    const contextMeasurement = new ContextMeasurementCoordinator()
    const markContextDirty = (): void => { contextMeasurement.markDirty() }

    // PR D2: the cheap status refresh NEVER measures context. UI-only
    // events (theme, keybinding, permission, focus, resize, search,
    // credential/llm surface changes, …) read the CACHED measurement; the
    // only measuring path is refreshContextMeasurement below, driven by
    // model-visible lifecycle events through the semantic SessionReader
    // port (never a direct ctx.get('tokenMeter') read — the Direct adapter
    // owns that coupling).
    const refreshStatusCheap = (): void => {
      const stats = statsFolder.snapshot()
      // The CACHED context pressure of the live session (the only measured
      // subject — never a fresh measurement here). While the subagent
      // viewer is open, the usage PROJECTION below still refuses to ride
      // the parent's measurement on the child's stats (same rule as before
      // the split); the legacy setStatus field keeps carrying the parent's
      // cached value exactly like the old path.
      const contextTokens = contextMeasurement.valueFor(liveAgent?.session.id)
      // The footer's [yolo]/[workspace-write]/[read-only]/[custom] mode badge
      // rides the effective preset (derived from the sandbox+approval knob
      // folds).
      const permission = ctx.get('permissionPresets')
      const liveCwd = sessionCwd()
      // M0: project the DSH-derived facts into the unified status store
      // FIRST — the footer paints the store (setStatus below repaints it),
      // so the derived sections must be committed before the paint or the
      // footer always shows the previous cycle's facts. The DISPLAY
      // SUBJECT's facts feed the sections — while the subagent viewer is
      // open that is the viewed child's own fold and workspace, so the
      // footer layout never changes, only the data source.
      const displayCwd = viewing?.cwd ?? liveCwd
      // While the subagent viewer is open the DISPLAY SUBJECT is the
      // viewed CHILD: the parent's session-owned sections (composition/
      // access/plan) are NOT the child's — the child's are not derivable
      // here, so the sections are cleared (unavailable) instead of leaking
      // the parent's facts into the snapshot the footer items, extension
      // items and the command status surface read. The child's OWN facts
      // (workspace/usage) follow the display subject below; the parent
      // context measurement must not ride the child's usage either.
      // The derivations mint fresh objects every call: only sections whose
      // CONTENT actually changed are committed — an identical refresh must
      // not churn the store's revision (the store compares by identity) nor
      // wake the command runner's refresh on every streaming event.
      const current = statusStore.snapshot()
      const composition = viewing === undefined ? deriveCompositionStatus() : {}
      const access = viewing === undefined
        ? deriveAccessStatus(
            {
              permissionPresets: permission,
              sandboxPolicy: ctx.get('sandboxPolicy'),
              approval: ctx.get('approval'),
            },
            liveAgent?.session,
          )
        : {}
      const collaboration = viewing === undefined
        ? { plan: derivePlanStatus(ctx.get('planMode'), liveAgent, ctx.get('sessionProjections'), liveAgent?.session) }
        : { plan: { effective: false } }
      const workspace = deriveWorkspaceStatus(displayCwd)
      const usage = usageFromStats(viewing?.stats.snapshot() ?? stats, viewing === undefined ? contextTokens : undefined)
      const host = deriveHostStatus()
      const patch: {
        composition?: typeof composition
        access?: typeof access
        collaboration?: typeof collaboration
        workspace?: typeof workspace
        usage?: typeof usage
        host?: typeof host
      } = {}
      if (!plainSectionEqual(current.composition, composition)) patch.composition = composition
      if (!plainSectionEqual(current.access, access)) patch.access = access
      if (!plainSectionEqual(current.collaboration, collaboration)) patch.collaboration = collaboration
      if (!plainSectionEqual(current.workspace, workspace)) patch.workspace = workspace
      if (!plainSectionEqual(current.usage, usage)) patch.usage = usage
      if (!plainSectionEqual(current.host, host)) patch.host = host
      statusStore.update(patch)
      app.setStatus({
        model: modelLabel(),
        // The FULL cwd lands in the structured workspace section (the
        // footer cwd ITEM shortens for display itself); the legacy
        // display value (tail segments) is derived from it.
        cwd: liveCwd,
        branch: gitBranch(liveCwd),
        goal: goalText,
        turns: stats.turns,
        steps: stats.steps,
        statsLine: formatStats(stats),
        // EXPLICITLY clear the permission when the service/agent is
        // unavailable: the legacy merge keeps the old value otherwise,
        // and syncExtensionState would publish a STALE permission to the
        // extension snapshot (a state transition where the permission
        // preset service or the live agent is momentarily gone).
        permission: deriveRunnerPermission(permission, liveAgent),
        // EXPLICITLY CLEAR the legacy context fields when unmeasured: the
        // TuiApp merge keeps old fields otherwise, and the session
        // switch / cold-resume window before the deferred measurement
        // would show the PREVIOUS session's context pressure — exactly the
        // permission policy above (P1 finding: the previous conditional
        // spread skipped the fields, leaving session A's measurement on
        // session B's first frames, indefinitely when B's measurement
        // fails).
        contextTokens,
        contextWindow: contextTokens === undefined ? undefined : stats.contextWindow,
      })
    }

    // PR D2: the explicit, event-driven context measurement path. Call
    // sites FIRST mark the cache dirty (markContextDirty — only
    // model-visible lifecycle events may), then this function measures
    // through the semantic SessionReader port and repaints cheaply. A
    // clean cache skips the reader (same-sync-chain dedupe); a failed or
    // unavailable measurement keeps the last-good value and the footer
    // falls back — never a dialog, never a stale foreign session value
    // (the coordinator is session-bound).
    const refreshContextMeasurement = (_reason: ContextMeasureReason): void => {
      const session = liveAgent?.session
      if (session === undefined) return
      contextMeasurement.bind(session.id)
      contextMeasurement.measure(session.id, (id) => backend.sessionReader.measureContext(id))
      refreshStatusCheap()
    }

    // The /status explicit force: a user asking for status expects the
    // FRESH context (plan §15.1 — explicit-status may force). Measures now
    // through the coordinator so the panel AND the cached footer value
    // agree (round-8 finding: a direct sessionReader read from the command
    // surface bypassed the cache and could duplicate the deferred initial
    // measurement).
    const forceContextMeasurement = (): number | undefined => {
      const session = liveAgent?.session
      if (session === undefined) return undefined
      contextMeasurement.bind(session.id)
      contextMeasurement.markDirty()
      const value = contextMeasurement.measure(session.id, (id) => backend.sessionReader.measureContext(id))
      refreshStatusCheap()
      return value
    }

    // The initial/post-switch measurement is deferred one event-loop turn
    // past the first usable paint: cold resume must never block the first
    // frame on a long-session context scan (plan §16.2 — setImmediate, not
    // a microtask). The fence captures the session generation + id: a
    // switch,/new, viewer swap or dispose before the callback runs makes it
    // a no-op (a stale deferred measurement can never commit).
    let cancelDeferredContextMeasure: (() => void) | undefined
    const scheduleInitialContextMeasure = (agent: Agent): void => {
      const generation = sessionGeneration
      const sessionId = agent.session.id
      cancelDeferredContextMeasure?.()
      cancelDeferredContextMeasure = deferInitialContextMeasure(
        (callback) => setImmediate(callback),
        () => generation === sessionGeneration && liveAgent?.session.id === sessionId,
        () => {
          // Bind the captured session BEFORE the dirty guard: on a cold
          // resume the coordinator is still UNBOUND (reads as not dirty),
          // and on a switch it is still bound to the PREVIOUS session —
          // guarding before the bind would turn the deferred initial
          // measure into a permanent no-op (round-10 finding). Binding a
          // new identity clears the old value and arms a fresh measure;
          // binding the same session is a no-op, so an earlier successful
          // force/lifecycle measurement (dirty cleared) still makes this
          // deferral redundant (round-9 finding), while a FAILED earlier
          // attempt (dirty stays) is retried here.
          contextMeasurement.bind(sessionId)
          if (!contextMeasurement.isDirty()) return
          markContextDirty()
          refreshContextMeasurement('initial')
        },
      )
    }

    let app: TuiApp
    // M0: the unified status projection store — the footer's future single
    // input. The runner derives the DSH-owned sections (composition/access/
    // workspace/usage/host/plan); the app projects its own surface state
    // (interaction/activity/surface/view) through its setters.
    const statusStore = new StatusStore(initialStatusSnapshot(bundleVersion()))
    // The extension service + surface host (M3 wiring); declared here so
    // the cleanup closure can detach them.
    let extensionService: (PiTuiExtensionService & {
      /** The CONCRETE registries (the runner's dispatch/pickers need the
       * full read methods — handlerFor, isSessionless, etc. — beyond the
       * public narrow views). */
      readonly commands: import('./command-bridge.ts').CommandBridge
      readonly themes: import('./theme-registry.ts').ThemeRegistry
      readonly autocomplete: import('./autocomplete-registry.ts').AutocompleteRegistry
      readonly settings: import('./settings-registry.ts').SettingsRegistry
      readonly keybindings: import('./keybinding-registry.ts').KeybindingRegistry
      readonly renderers: import('./renderer-registry.ts').RendererRegistry
      readonly editors: import('./editor-registry.ts').EditorRegistry
      _ledger(): import('./extension/internal/ledger.ts').ExtensionLedger
      // The REF protocol: capture the identity at INVOCATION START and
      // report settlements against the captured ref — never the live
      // registry (an HMR reload may replace the id with a new owner by
      // settle time; the review's P2 generation fence). This shape is the
      // authoritative bridge protocol — keep it in sync with the
      // service's implementations.
      // Theme-unload notification (the selected-plugin-theme fallback):
      // called with the SOURCE-QUALIFIED selectable value (+ display
      // name) of every theme that unloads. Returns the GENERATION-LEASED
      // release (the review's P2: an old runner's cleanup must never
      // clear a newer generation's hook).
      setThemeUnloadedHook(hook: (unloaded: { selectableValue: string; name: string }) => void): () => void
      _recordRegistryHealthRef(slot: string, id: string): { slot: string; id: string; owner: string } | undefined
      _recordRegistryError(ref: { slot: string; id: string; owner: string }, error: unknown): void
      _clearRegistryError(ref: { slot: string; id: string; owner: string }): void
      attachSurface(bridge: { subscribe(listener: (state: never) => void): () => void }, capabilities: ReadonlySet<string>, surfaceId: string, requestRender?: (force?: boolean) => void): void
      detachSurface(surfaceId?: string): void
      // Phase 2: the ADVANCED seam (the `extensions/advanced` facade's
      // internal surface — the runner wires the app's input path and the
      // interactive-overlay/editor-control seams through it).
      _advancedInputRoute(data: string): 'consumed' | 'passed'
      setAdvancedOverlayMount(
        surfaceId: string,
        mount: (component: import('./extension/advanced-types.ts').AdvancedInteractiveComponent, options?: import('./extension/public-types.ts').TuiOverlayOptions) => import('./extension/advanced-types.ts').AdvancedOverlayLease,
      ): void
      setAdvancedEditorSeam(surfaceId: string, controls: import('./extension/advanced-types.ts').AdvancedEditorControls): void
      // Phase 4: the ADVANCED imperative-UI + host-state seams.
      setAdvancedUiSeam(
        surfaceId: string,
        ui: {
          select(options: import('./extension/advanced-types.ts').AdvancedSelectOptions): Promise<string | undefined>
          confirm(options: import('./extension/advanced-types.ts').AdvancedConfirmOptions): Promise<boolean>
          input(options: import('./extension/advanced-types.ts').AdvancedInputOptions): Promise<string | undefined>
          notify(message: string, options?: import('./extension/advanced-types.ts').AdvancedNotifyOptions): void
          custom(factory: (host: import('./extension/advanced-types.ts').AdvancedCustomHost) => import('./extension/advanced-types.ts').AdvancedInteractiveComponent, options?: import('./extension/public-types.ts').TuiOverlayOptions, signal?: AbortSignal): Promise<unknown>
        },
      ): void
      setAdvancedHostSeam(surfaceId: string, state: import('./extension/advanced-types.ts').AdvancedHostState): void
      // Phase 3: the UNSTABLE seam (the `extensions/unstable` facade's
      // internal surface — the runner wires the raw input route, the
      // fail-safe release and the low-level surface seam through it).
      _unstableInputRoute(data: string, surfaceId: string): import('./extension/internal/unstable-input.ts').UnstableRawRouteResult
      _unstableInputsLive(): boolean
      _unstableInputsRevision(): number
      _unstableEmergencyRelease(): void
      setUnstableSurfaceSeam(surfaceId: string, handle: import('./extension/unstable-types.ts').UnstableSurfaceHandle): void
    }) | undefined
    let extensionHost: SurfaceHost | undefined
    // The generation-LEASED release of THIS runner's theme-unload hook
    // (the review's P2): the HMR cleanup releases only its own hook, never
    // a newer runner generation's.
    let releaseThemeUnloadedHook: (() => void) | undefined
    // Tool-card presentation bridge: the Web's render intents resolved from
    // the LIVE tool registry as the agent sees it (scoped lookup), so the
    // rendered card matches the definition that actually executed. The scope
    // must be the AGENT OBJECT — the agent's scope layer is keyed by it
    // (createScope(loopCtx, this)), exactly like the host apiproxy's
    // ctx.tools.get(name, ctx.agents.get(session.id)). Passing the agent's
    // CONTEXT instead misses the agent layer entirely: presentCall/
    // presentResult would return no views and every card would fall back to
    // raw text (read still works via its envelope fallback, edit loses its
    // diff). The registry is read through ctx.get: property access
    // (ctx.tools) trips cordis's inject guard, and an absent registry must
    // degrade to generic cards rather than fail the render.
    const tools = ctx.get('tools') as { get(name: string, scope?: object): ToolDefinitionLike | undefined } | undefined
    const present = toolPresenterFrom(name => {
      if (liveAgent === undefined) return undefined
      return tools?.get(name, liveAgent)
    })
    // Stable signal snapshot of the runner-owned lifecycle controller.
    const signal = lifecycleController.signal
    // Abort handle for the currently running `!` shell command.
    let localShellController: AbortController | undefined
    // 0600 temp files holding FULL local-shell output (for truncated runs);
    // removed at TUI exit (default), never on their own.
    const shellTempFiles = new Set<string>()
    // M2: the plugin keybinding-sync unsubscribe slot. Hoisted here BEFORE
    // cleanup (TDZ guard, review finding): cleanup is already registered
    // into the effect below, so a throwing subscription registration at
    // startup must never turn the teardown into a second ReferenceError
    // that masks the original failure and skips the extension detach /
    // diag dispose.
    let stopPluginKeybindingSync: (() => void) | undefined
    // The catalog refresh coordinator: the ONE post-mount refresh owner
    // (first session, switches, /preset, /reload). Declared here (before
    // cleanup) for the same TDZ guard — cleanup disposes it, and a
    // mid-startup HMR unload must never reference it while it is still in
    // the temporal dead zone; it is assigned during command registration.
    let catalogCoordinator: CatalogRefreshCoordinator | undefined
    // M5: the footer command lifecycle slots. Hoisted here for TWO TDZ
    // guards: cleanup releases them, and — unlike the two slots above —
    // `onTerminalResize` (captured by startProcessTui below) READS
    // footerCommandRunner during startup itself: the first surface-geometry
    // sync fires it (lastCommandWidth starts at 0), and a keybinding
    // rebuild's invalidate → requestRender is reachable before the footer
    // settings block runs. Declaring at the footer block left the read in
    // the temporal dead zone — a ReferenceError swallowed by the keybinding
    // apply's fail-soft catch and misreported as a keybindings failure
    // (guarded by the startup-eager-callback audit in test/rules.test.ts).
    let footerCommandRunner: FooterCommandRunner | undefined
    let footerCommandUnsubscribe: (() => void) | undefined
    // PR D: the custom command item runtime (one runner per ACTIVE layout
    // command item). Hoisted with the whole-footer slots for the same TDZ
    // guards; cleanup disposes it so no child/timer survives a remount.
    let footerDynamicItemRuntime: FooterDynamicItemRuntime | undefined
    // Idempotent teardown: abort lifecycle loads, stop the TUI, close diag.
    // Shared by /exit, the effect cleanup, and the startup-failure path.
    let cleanedUp = false
    const cleanup = (): void => {
      if (cleanedUp) return
      cleanedUp = true
      // Fence the completion-notification controller: after teardown a
      // late `agent/status` idle from the old live agent must never emit
      // a notification into a dead surface (the identity fence drops
      // every event once the live id is undefined).
      completionController.setLiveAgent(undefined)
      // Disable terminal focus reporting FIRST — before any throwable
      // teardown step — so the mode can never leak into the shell even
      // when a later teardown operation throws (idempotent: a startup
      // failure that never enabled it writes a harmless no-op). The
      // guarded writer swallows a broken-stream error; a synchronous
      // throw is contained here so teardown can never crash.
      try {
        notificationWriter.write(DISABLE_FOCUS_REPORTING)
      } catch {
        // The stream may already be gone during teardown; best effort.
      }
      // The touched-session physical locks are DELIBERATELY NOT released
      // here (convergence plan phase 7): a clean TUI exit is not a proof
      // that the DSH persistence tree is quiet, so releasing an active /
      // cooling / pinned session's owner.lock would hand another process a
      // session this process may still be flushing. The locks stay on disk
      // as stale records; the next opener's stale-takeover mechanism
      // handles them (the system must support kill -9 stale locks anyway).
      lifecycleController.abort()
      // The process-global lease registry's ref count: this mount is done
      // with the manager (bookkeeping only — the physical locks stay;
      // review: a missing release leaked refCount across HMR remounts).
      leaseWorld.release()
      // Abort any in-flight catalog refresh: its late result must never
      // register commands or repaint after the app is gone.
      catalogCoordinator?.dispose()
      // PR D2: cancel the deferred initial context measure — a stale
      // callback must never measure/repaint into the disposed surface.
      cancelDeferredContextMeasure?.()
      cancelDeferredContextMeasure = undefined
      // M5: release the footer command surface BEFORE the app dies — a
      // late status-store notification must not refresh into a disposed
      // surface. The lifecycle abort above already disposes an armed
      // runner through its own abort listener; the explicit unsubscribe +
      // dispose keeps the release symmetric with the arm path and also
      // covers the teardown-before-arm window (both idempotent).
      footerCommandUnsubscribe?.()
      footerCommandUnsubscribe = undefined
      footerCommandRunner?.dispose()
      footerCommandRunner = undefined
      // PR D: release every per-item command runner (children, timers,
      // abort listeners) before the app dies.
      footerDynamicItemRuntime?.dispose()
      footerDynamicItemRuntime = undefined
      localShellController?.abort()
      for (const file of shellTempFiles) {
        try {
          rmSync(file, { force: true })
        } catch {
          // Best effort.
        }
      }
      shellTempFiles.clear()
      app?.dispose()
      // M2: unsubscribe the plugin keybinding sync (the registry outlives
      // the surface — a stale listener must not resync into a dead app).
      stopPluginKeybindingSync?.()
      stopPluginKeybindingSync = undefined
      // Release THIS generation's theme-unload hook BEFORE the app dies:
      // without the generation lease, the old callback (capturing the
      // disposed app) would stay installed until the next runner installed
      // its own — and a theme fiber unloading in the window would reach
      // into the disposed app (the review's P2).
      releaseThemeUnloadedHook?.()
      releaseThemeUnloadedHook = undefined
      // Detach the extension service's surface bridge (its capability set
      // and state listeners die with the surface). The surfaceId lease
      // makes a stale detach a no-op (P1).
      extensionService?.detachSurface(extensionHost?.surfaceId)
      extensionHost = undefined
      diag.dispose()
    }
    // The ONE exit orchestration, shared by every exit entry (the exit keys,
    // /exit, /quit): flush with a hard timeout → record → idempotent cleanup
    // → warn on a failed/timed-out flush → resume hint → process exit. A
    // later request while one is in flight is a no-op (createExitController
    // latches), so a command plus a key can never double-flush or double-exit.
    const { requestExit } = createExitController({
      session: () => liveAgent?.session as ExitSessionLike | undefined,
      flush: (session) => sessions.flush(session as Parameters<typeof sessions.flush>[0]),
      timeoutMs: EXIT_FLUSH_TIMEOUT_MS,
      diag,
      cleanup,
      warn: (message) => process.stderr.write(`\n${color.textDim('Warning:')} ${message}\n`),
      hint: (message) => process.stdout.write(`\n${message}\n`),
      resumeHint: () => {
        const resume = resumeCommand(runningProfile(), liveAgent?.session.id ?? '')
        return resume === undefined ? undefined : `${color.textDim('To resume this session:')} ${resume}`
      },
      exit,
    })
    // Stop the TUI when this fiber is disposed (a loader hot-reload unloads
    // the row; the reloaded row starts its own instance in the same process).
    ctx.effect(function* () {
      yield () => {
        cleanup()
      }
    })

    /**
     * Run a `!` shell command. `!` (context mode) runs the command and then
     * submits the completed command+output to the session as an ordinary
     * user message (kimi parity: the model sees both on the next
     * turn; the result wakes a turn but is never steered into a running
     * one); `!!` (local mode) runs purely off-session — the card is the
     * only record (pi's excluded-from-context escape hatch).
     */
    const runLocalShell = (text: string, ackToken: number | undefined): void => {
      const includeInContext = shellModeOf(text) === 'context'
      const command = shellCommandOf(text)
      if (command === '') return
      // NOTE: the context-mode submit ack is armed AT THE GESTURE in
      // dispatchUserInput (before ensureSession) — NEVER here, or the T0
      // baseline would rebase after the session create. `ackToken` scopes
      // every terminal settle below to THIS gesture: a newer submission
      // (bumped epoch) makes them no-ops.
      const shellTerminalAck = (reason: string): void => {
        if (ackToken === undefined) return
        settleLocalSubmitAck(reason, { token: ackToken, terminal: true })
      }
      // The generation the run STARTED under: a session switch while the
      // command runs must not post the output into the new session (the
      // switch already cleared the card; the notify explains what happened).
      // switch already cleared the card; the notify explains what happened).
      const generationAtRun = sessionGeneration
      localShellController?.abort()
      localShellController = new AbortController()
      const localSignal = localShellController.signal
      // The card reference this run owns: settling by identity keeps a
      // settled old run from overwriting a newer run's card (updateLastLocal
      // Message would hit whatever card is newest at settle time). The
      // reference is RE-CHAINED on every in-flight tail update (the array
      // element is replaced, so the old reference would no longer index).
      let card = app.pushLocalMessage({
        kind: 'tool',
        turn: Number.POSITIVE_INFINITY,
        name: 'shell',
        args: command,
        result: '',
        status: 'running',
      })
      /** Release the controller only when it still guards THIS run. */
      const releaseController = (): void => {
        if (localShellController?.signal === localSignal) localShellController = undefined
      }
      /**
       * Submit the completed run to the session (context mode only):
       * re-validate → followup. Accepted clears the settled card — the
       * transcript's user row becomes the record. An owned workflow: the
       * outcome drives the notify and the card — runOwned (AGENTS.md),
       * never a bare void.
       */
      const submitResult = (result: string): void => {
        // A session switch while the command ran: the output must not be
        // posted into a session the user has left (the switch already
        // cleared the card; the notify explains what happened). A session
        // switch between the check and the followup is caught by
        // submitShellResult's own re-validation. The ack row (armed at the
        // gesture) is TERMINAL here: nothing will be written for the old
        // session.
        if (sessionGeneration !== generationAtRun) {
          shellTerminalAck('shell submit skipped after a session switch')
          app.notify('the session changed while the command ran — the output was not submitted', 'error')
          return
        }
        const submitted = formatShellSubmitText(command, result)
        // T1 BEFORE the dispatch: same ordering rule as the Enter path —
        // the ack row keeps waiting for the authoritative event (plan D).
        submitLatencyTracker.mark(liveAgent?.session.id, 'dispatch')
        runOwned('shell submit', () => submitShellResult({
          currentAgent: () => liveAgent as unknown as ShellSubmitAgentLike | undefined,
          currentGeneration: () => sessionGeneration,
          notify: (message, kind) => app.notify(message, kind),
          staleNotice: () => 'the session changed while the submission was being checked — the output was not submitted',
          // The session-transition write fence (review round 4): while a
          // transition is in flight the followup would target a session
          // whose lock is about to be released.
          fence: () => transitionGate.busy,
          barrier: operationBarrier,
          fenceNotice: () => 'a session transition is in progress — the output stays on the card; re-run ! after it settles',
          createMessage: (text) => createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }),
          onSubmitted: () => {
            app.clearSettledLocalMessages()
            // The write was accepted. The ACK ROW STAYS until the first
            // authoritative event (the inbox insert) settles it — never
            // cleared at delivery time (plan D lifecycle: an event or a
            // failure ends the wait, not the send).
          },
        }, submitted), {
          diag,
          sessionId: () => liveAgent?.session.id,
          // A stalled shell submit (stale identity / transition fence /
          // no agent) wrote nothing: terminal — the pending row must not
          // outlive the submission (plan D exit enumeration).
          onResult: (outcome) => {
            if (outcome !== 'ok') shellTerminalAck(`shell submit ${outcome}`)
            else if (liveAgent === undefined) shellTerminalAck('shell submit without an agent')
          },
          // runOwned routes cancellations EXCLUSIVELY here: a
          // cancellation-shaped rejection from the write bypasses
          // onResult/onError, so the ack row armed at the gesture must
          // end terminally (the caller's card keeps the output).
          onCancel: () => {
            shellTerminalAck('shell submit cancelled')
          },
          onError: (error) => {
            // The submission failed before the write ran: keep the card
            // (the output is not lost) and surface the reason.
            shellTerminalAck('shell submit failure')
            app.notify(`shell submit failed: ${safeErrorMessage(error)}`, 'error')
          },
        })
      }
      // A settled latch: `error` and `close` can both fire (a spawn failure
      // usually closes with a non-zero code), and the card must settle
      // EXACTLY once — the first event wins.
      let settled = false
      const settle = (result: string, status: 'ok' | 'error'): void => {
        if (settled) return
        settled = true
        app.updateLocalMessage(card, {
          kind: 'tool',
          turn: Number.POSITIVE_INFINITY,
          name: 'shell',
          args: command,
          result,
          status,
        })
        // Context mode submits every settled outcome except an abort (the
        // run was cancelled; the partial output is noise). An aborted run
        // is also TERMINAL for the submit acknowledgement (plan D exit
        // enumeration): the aborted gate suppresses submitResult, so the
        // pending row would otherwise outlive the gesture forever.
        //
        // EVERY settle caller funnels through HERE — including the
        // synchronous `shell.resolve`/`spawn` catches and the child
        // `error` handler — so no additional ack settle is needed at
        // those sites: a non-abort failure continues into submitResult →
        // submitShellResult, whose onResult/onError/onCancel sinks end
        // the ack (or the authoritative event does), and an abort ends
        // it through the gate below. Adding token settles at the catch
        // sites instead would pre-clear the row and break the "ack
        // survives until the authoritative event" contract.
        if (includeInContext && localSignal.aborted) {
          shellTerminalAck('shell run aborted')
        }
        if (includeInContext && !localSignal.aborted) submitResult(result)
      }
      const sandboxPreference = localShellSandboxPreferenceOf(tuiSettings?.get())
      const shell = sandboxPreference === 'sandbox' ? ctx.get('shell') : undefined
      if (shell === undefined && sandboxPreference === 'sandbox') {
        // The user explicitly opted into the sandbox but the composition
        // provides no shell capability: running unsandboxed SILENTLY would
        // violate the preference, so the downgrade is surfaced every time.
        app.notify('local shell sandbox unavailable in this composition — running unsandboxed', 'error')
      }
      if (shell !== undefined) {
        // The dsh shell capability (sandbox policy + DSH env) when the
        // composition provides it AND the local-shell sandbox preference
        // opts in ('sandbox'); completion-based like the spawn fallback.
        // The default ('bypass') runs user-typed commands through the plain
        // spawn path below — pi/kimi parity: the sandbox guards the model's
        // autonomous commands, not commands the user typed and chose to run.
        // A synchronous resolve throw must not escape with the ack row
        // armed: settle the card (and the terminal ack) exactly like a
        // failed run (plan D exit enumeration).
        let spec: ReturnType<typeof shell.resolve>
        try {
          spec = shell.resolve({ command, workdir: sessionCwd(), signal: localSignal })
        } catch (error) {
          releaseController()
          settle(`failed: ${safeErrorMessage(error)}`, 'error')
          return
        }
        // An owned workflow: the RESULT settles the UI card, so the settle
        // logic stays in onResult and the cancellation/failure semantics
        // stay per-task (runOwned — AGENTS.md); the classification
        // diagnostics (cancellation → debug, failure → error) are recorded
        // by runOwned itself. The dsh shell may reject an abort with a
        // plain Error, so the task-local classifier routes it to onCancel
        // instead of a false ERROR line. Never a bare void.
        runOwned('local shell', () => shell.run(spec), {
          diag,
          sessionId: () => liveAgent?.session.id,
          isCancellation: () => localSignal.aborted,
          onResult: (result) => {
            releaseController()
            if (localSignal.aborted) {
              settle('aborted', 'error')
              return
            }
            const output = [result.stdout.text.trim(), result.stderr.text.trim()].filter(Boolean).join('\n')
            const exit = result.exitCode !== null ? `exit ${result.exitCode}` : `signal ${result.signal ?? '?'}`
            settle(output === '' ? exit : `${output}\n[${exit}]`, result.exitCode === 0 ? 'ok' : 'error')
          },
          onCancel: (error) => {
            // An abort-triggered rejection is a cancellation: settle the
            // card as aborted like the resolved path does. runOwned routes
            // cancellations EXCLUSIVELY here — a cancellation-shaped
            // rejection WITHOUT the signal aborted skips the aborted gate
            // inside settle(), so the ack row must be settled terminally
            // HERE too (idempotent with it).
            releaseController()
            settle('aborted', 'error')
            if (includeInContext && !localSignal.aborted) {
              shellTerminalAck('shell run cancelled')
            }
            void error
          },
          onError: (error) => {
            releaseController()
            const message = safeErrorMessage(error)
            settle(`failed: ${message}`, 'error')
            // A sandbox execution failure does NOT run submitResult (only
            // onResult does), so this exit is terminal for the ack row:
            // nothing will be written — the pending row must end here
            // (plan D exit enumeration). An abort settles through the
            // unified aborted gate above instead.
            if (includeInContext && !localSignal.aborted) {
              shellTerminalAck('shell sandbox run failed')
            }
          },
        })
        return
      }
      // A synchronous spawn throw must not escape with the ack row armed:
      // settle the card (and the terminal ack) exactly like a failed run
      // (plan D exit enumeration).
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(command, { cwd: sessionCwd(), stdio: ['ignore', 'pipe', 'pipe'], shell: true })
      } catch (error) {
        releaseController()
        settle(`failed: ${safeErrorMessage(error)}`, 'error')
        return
      }
      // Bounded capture: the card keeps only the TAIL (byte- and line-
      // capped, unterminated output included); the FULL output is streamed
      // to a 0600 temp file (disk-capped) so a truncated run still leaves
      // the complete transcript available. Untruncated runs delete the file
      // on close; the files that remain are removed at TUI exit (cleanup).
      const bounded = createBoundedOutput()
      const fullPath = join(tmpdir(), `dsh-pi-tui-shell-${process.pid}-${randomUUID()}.log`)
      const full = createFileCapture(fullPath, SHELL_OUTPUT_DISK_CAP_BYTES)
      if (full.active) shellTempFiles.add(fullPath)
      // ONE StringDecoder PER stream: stdout and stderr are independent
      // byte streams, so a character split across them would interleave
      // and corrupt — each stream's decoder buffers only its own partial
      // sequences and decodes across that stream's chunk boundaries.
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')
      // In-flight tail refresh (plan §5.1): the running card's result is
      // re-chained to the bounded TAIL on a throttle, so a streaming log
      // previews its newest rows instead of an empty body. The throttle
      // keeps high-throughput output from rebuilding the whole view per
      // chunk; settle/close clears the timer (dispose contract).
      let tailTimer: NodeJS.Timeout | undefined
      const clearTailTimer = (): void => {
        if (tailTimer !== undefined) {
          clearTimeout(tailTimer)
          tailTimer = undefined
        }
      }
      const scheduleTailFlush = (): void => {
        if (tailTimer !== undefined) return
        tailTimer = setTimeout(() => {
          tailTimer = undefined
          card = app.updateLocalMessage(card, {
            kind: 'tool',
            turn: Number.POSITIVE_INFINITY,
            name: 'shell',
            args: command,
            result: bounded.tail,
            status: 'running',
          })
        }, LOCAL_SHELL_TAIL_FLUSH_MS)
      }
      const onData = (decoder: StringDecoder, chunk: Buffer): void => {
        // The wire byte count rides along: an incomplete multi-byte
        // sequence buffered by the decoder produces no text yet, but its
        // bytes are real and must count toward the totals.
        bounded.append(decoder.write(chunk), chunk.length)
        full.append(chunk)
        scheduleTailFlush()
      }
      child.stdout?.on('data', (chunk) => onData(stdoutDecoder, chunk))
      child.stderr?.on('data', (chunk) => onData(stderrDecoder, chunk))
      localSignal.addEventListener('abort', () => child.kill(), { once: true })
      child.on('error', (error) => {
        releaseController()
        clearTailTimer()
        // A spawn failure leaves nothing worth keeping: drop the capture.
        full.dispose()
        shellTempFiles.delete(fullPath)
        settle(`failed: ${error.message}`, 'error')
      })
      child.on('close', (code, childSignal) => {
        releaseController()
        clearTailTimer()
        // Flush each decoder's remaining partial sequence. An incomplete
        // trailing multi-byte character surfaces as U+FFFD from end() — it
        // is shown as-is (the bytes were real); its wire bytes were already
        // counted by append's wireBytes, so pass 0 to avoid double counting.
        for (const decoder of [stdoutDecoder, stderrDecoder]) {
          const tail = decoder.end()
          if (tail !== '') bounded.append(tail, 0)
        }
        if (localSignal.aborted) {
          // The run was cancelled: the partial capture is noise, delete it.
          full.dispose()
          shellTempFiles.delete(fullPath)
          settle('aborted', 'error')
          return
        }
        if (bounded.truncated) {
          // Keep the full-output file for a truncated run — but only when
          // the capture is actually alive (creation/write failures are
          // never advertised, and a disk-capped file says so).
          if (full.exists) {
            full.close()
          } else {
            full.dispose()
            shellTempFiles.delete(fullPath)
          }
          const output = bounded.tail.trim()
          const lines: string[] = []
          if (output !== '') lines.push(output)
          lines.push(formatTruncation(bounded))
          if (full.exists) {
            lines.push(full.truncated
              ? `full output (disk capture truncated at ${formatBytes(SHELL_OUTPUT_DISK_CAP_BYTES)}): ${fullPath}`
              : `full output: ${fullPath}`)
          }
          const exit = code !== null ? `exit ${code}` : `signal ${childSignal ?? '?'}`
          lines.push(`[${exit}]`)
          settle(lines.join('\n'), code === 0 ? 'ok' : 'error')
        } else {
          // Untruncated output: no reason to keep a user-invisible temp
          // file around until TUI exit.
          full.dispose()
          shellTempFiles.delete(fullPath)
          const output = bounded.tail.trim()
          const exit = code !== null ? `exit ${code}` : `signal ${childSignal ?? '?'}`
          settle(output === '' ? exit : `${output}\n[${exit}]`, code === 0 ? 'ok' : 'error')
        }
      })
    }
    // Coalesced repaint: streaming events fold into the folder immediately
    // (cheap) but the view rebuild flushes at most every REPAINT_FLUSH_MS,
    // and immediately on turn/end.
    let repaintTimer: NodeJS.Timeout | undefined
    // P7d: subagent viewer — while set, the transcript shows another live
    // session's log and Esc returns to the parent session. The target is
    // MODE-AWARE: a continuable child's viewer is INTERACTIVE (the editor
    // submits human prompts through ctx.subagents.prompt), a one-shot
    // child's viewer stays read-only. The parent session id is pinned at
    // open time — follow-ups require the exact live direct parent, and
    // the viewer never guesses it from the current live agent.
    let viewing: {
      id: SessionId
      folder: TranscriptFolder
      /** Independent presentation state while browsing the child. */
      window: TranscriptWindowController
      /** The child's OWN event stats (turns/steps/tokens) for the footer. */
      stats: StatsFolder
      parentSessionId: SessionId
      label: string
      mode: 'one-shot' | 'continuable'
      activity: 'running' | 'inactive'
      /** The viewer's surface authority (plan §6.10): mode is the durable
       * semantic, access is what THIS surface may do — a nested descendant
       * is read-only even when continuable. */
      access: ViewerAccess
      /** The child session's workspace ('' when unknown, e.g. a cold child). */
      cwd: string
    } | undefined
    // Unsettled subagent delegations in the live session, in tool/call order.
    // The viewer matches one of these by description when the user opens a
    // child transcript, so the child's tool/result can pop the viewer back.
    const pendingSubagentCalls: { callId: string; description: string }[] = []
    // callId → child session id, established when the user opens a child's
    // transcript (see enterView). Consumed on the matching tool/result.
    const viewCallToChild = new Map<string, SessionId>()
    const activeFolder = (): TranscriptFolder => viewing?.folder ?? folder
     const activeWindow = (): TranscriptWindowController => viewing?.window ?? windowController
    const paintNow = (): void => {
      if (repaintTimer !== undefined) {
        clearTimeout(repaintTimer)
        repaintTimer = undefined
      }
      repaint(app, activeFolder(), activeWindow())
    }
    const schedulePaint = (): void => {
      if (repaintTimer !== undefined) return
      repaintTimer = setTimeout(() => {
        repaintTimer = undefined
        repaint(app, activeFolder(), activeWindow())
      }, REPAINT_FLUSH_MS)
    }
    // Tool-call arguments by callId, for the approval-preview dialog.
    const callArgs = new Map<ToolCallId, string>()
    // The in-flight compaction's id (paired start/end in the firehose): a
    // stale end must never clear a NEWER compaction's footer/busy state.
    let compactingId: string | undefined
    // Transcript-search state (see the onSearch* events below). Matches are
    // LIGHTWEIGHT stable identities ({id, turn} — never full message
    // objects): the full-history search runs over the folder's incremental
    // projection, so a query change never materializes the grouped
    // transcript nor re-lowercases history.
    let searchMatches: TranscriptSearchMatch[] = []
    let searchCurrent = -1
     let searchOrigin: { controller: TranscriptWindowController; state: TranscriptWindowState } | undefined
    // Query-refinement state (D1): the previous query's matches are reused
    // only when the new query PREFIX-extends the previous one on the SAME
    // folder with an UNCHANGED projection revision (the folder validates
    // both; the folder identity guard keeps a subagent viewer's matches
    // from ever being reused for the parent session or vice versa).
    let lastSearchQuery = ''
    let lastSearchRevision = 0
    let lastSearchFolder: TranscriptFolder | undefined
    const resetSearchState = (): void => {
      searchMatches = []
      searchCurrent = -1
      lastSearchQuery = ''
      lastSearchRevision = 0
      lastSearchFolder = undefined
    }
    // Monotonic session generation: bumped on EVERY session swap (switch,
    // resume, deferred creation). Late async work (the skill command
    // catalog refresh, model-menu info, title folds) captures the
    // generation it was issued for and refuses to commit state once a newer
    // session owns the surface. Bumping also tears down old-session-only
    // state: tool-call preview args, search results, and per-message
    // expansion overrides. Pending question/approval dialogs settle through
    // their own abort signals — the disposed agent aborts them — so they
    // need no explicit teardown here.
    let sessionGeneration = 0
    const bumpSessionGeneration = (): number => {
      sessionGeneration += 1
      callArgs.clear()
      // The new session's subagent delegations are a fresh namespace: stale
      // pending calls from the old session would consume viewer match slots,
      // and dead callId→child maps would silently disable the auto-pop.
      pendingSubagentCalls.length = 0
      viewCallToChild.clear()
      resetSearchState()
      searchOrigin = undefined
      windowController.latest()
      windowController.setTurns(folder.groupedTurns())
      app.setSearchResult(0, 0)
      app.clearSessionOverrides()
      // A new session owns the surface: close the task browser opened for
      // the old session (its rows would otherwise go stale — the runtime
      // refresh is fenced to the old root) and CLEAR the subagent badge
      // SYNCHRONOUSLY — the new session's first listing is async, and the
      // old session's running badge must not hang on the footer until it
      // lands (a failed listing must never leave a stale badge either).
      // The cached catalog is dropped too, so stale-session
      // `agent/status` flips find no membership and the next refresh
      // reads the new root. The coordinator is re-populated by
      // initLiveSession → refreshAgents.
      activeTaskBrowser?.close()
      activeTaskBrowser = undefined
      taskRuntime?.reset()
      app.setTaskSummary({ runningAgents: 0, totalAgents: 0, runningJobs: 0, totalJobs: 0, failedAttention: 0, failedTotal: 0 })
      app.setTasks([])
      app.setAgents([])
      taskBrowserRows = []
      // A new session owns the surface: tear down the subagent viewer. The
      // old viewer's parent session is gone (the continuation contract
      // requires the EXACT live parent), so the child transcript, the
      // viewer editor and the per-child drafts must not leak into the new
      // session. The teardown is UNCONDITIONAL — an open may still be
      // loading when nothing is mounted, and the swap must still cancel
      // it — and closes the mounted viewer when there is one. The MAIN
      // draft (the user's unsent text) restores into the new session's
      // editor — cross-session draft retention is the existing behavior.
      teardownViewerForSessionSwap(viewerOpen, viewing !== undefined, () => {
        viewing = undefined
        viewerSessionAbort?.abort()
        viewerSessionAbort = undefined
        app.clearLocalMessages()
        app.clearNotify()
        app.setViewerMode(undefined)
        // setViewerFooter(undefined) returns the display subject to main
        // (projected BEFORE its paint).
        app.setViewerFooter(undefined)
        // Session swap: the OLD parent session is gone — its parked Focus
        // disclosures must be DISCARDED, never restored into the new
        // session (clearSessionOverrides already dropped the stack; this
        // keeps the teardown's intent explicit and ordering-safe). The
        // Esc path uses exitFocusViewerScope instead (restore).
        app.discardFocusViewerScope()
        repaint(app, folder, windowController)
        windowController.isLatest() ? app.scrollToBottom() : app.scrollToTop({ disableFollow: true })
        // The new session's own measurement comes from its initLiveSession
        // deferred path — the teardown refresh is UI-only.
        refreshStatusCheap()
      })
      return sessionGeneration
    }
    // PR D1 P1: while the search overlay is open the transcript keeps
    // changing (settlements, read-group reflow, new messages), so Next/Prev
    // must never jump with a stale candidate list or a stale turn. This
    // re-runs the SAME lightweight query when the active folder's
    // projection revision moved (or the folder itself changed), recovers
    // the previously current match by stable id, and clamps the index.
    const refreshSearchMatchesIfStale = (): void => {
      const folder = activeFolder()
      const refreshed = refreshedSearchState(
        { matches: searchMatches, current: searchCurrent, query: lastSearchQuery, revision: lastSearchRevision, folder: lastSearchFolder },
        folder,
      )
      if (!refreshed.changed) return
      searchMatches = refreshed.matches
      searchCurrent = refreshed.current
      lastSearchRevision = refreshed.revision
      lastSearchFolder = folder
      app.setSearchResult(searchCurrent + 1, searchMatches.length)
    }
    const jumpToSearchMatch = (): void => {
      refreshSearchMatchesIfStale()
      const match = searchMatches[searchCurrent]
      if (match === undefined) return
      // ONE fold snapshot: the anchored message window and the activities
      // come from the same folder call (plan §19 — a jump must never
      // combine a fresh window with stale activity data).
      const folder = activeFolder()
      const controller = activeWindow()
      controller.anchorAt(match.turn)
      repaint(app, folder, controller)
      app.scrollToBottom({ disableFollow: !controller.isLatest() })

      // Focus Mode: the search hits the FULL transcript (hidden process
      // rows included — plan §23), so a jump into a collapsed turn must
      // open its Thought for the hit to be visible — and a hit inside a
      // SECONDARY card must full-reveal that card (plan §28; the compact
      // timeline is a FULLSCREEN property — regular Focus full-reveals
      // any expanded root anyway). The disclosure is not reverted when
      // search closes. The match resolves to its CURRENT visible card: a
      // group reflow after the query may have replaced the card object —
      // resolving by stable id fails soft (the turn jump above already
      // landed the window; only the exact-card reveal is skipped).
      if (app.isFocusModeEnabled()) {
        const message = folder.resolveSearchMatch(match)
        if (message !== undefined) app.revealSearchMatch(message)
      }
      app.setSearchResult(searchCurrent + 1, searchMatches.length)
    }
    /** Enter the subagent viewer for one session (live or persisted). The
     * target carries the catalog MODE (continuable = interactive editor,
     * one-shot = read-only — never guessed from running/inactive) and the
     * exact direct-parent session id the follow-up write path is pinned
     * to. The open is ASYNC (a cold child's log is read from persistence);
     * a viewer open/close/child switch — or a session swap — that lands
     * while the inspection is in flight invalidates this request (the
     * viewerOpen token), so a slow open can never commit an obsolete child
     * over the current surface (round-4/5 findings). */
    const viewerOpen = createViewerOpenToken()
    /** The CURRENT viewer session's abort source: aborted when the viewer
     * session ends (Esc / child switch / session swap), so an in-flight
     * follow-up that has NOT reached inbox acceptance is cancelled (the
     * rejected send restores the draft into the child's slot). Once a
     * follow-up is accepted the DSH continuation contract hands ownership
     * to the child — the signal no longer matters. */
    let viewerSessionAbort: AbortController | undefined
    /** Push the viewed child's OWN identity into the footer (label/mode/
     * activity/cwd + the child's own turns/steps/stats line) — the parent
     * session's status describes a session the user is not looking at.
     * M1: the unified status store follows the same display subject — the
     * view/workspace/usage sections switch to the child's facts. */
    const refreshViewerFooter = (): void => {
      if (viewing === undefined) return
      const stats = viewing.stats.snapshot()
      // setViewerFooter projects the display-subject sections (view/
      // workspace/usage) BEFORE its paint — the first frame after
      // entering (or leaving) the viewer already shows the new subject.
      app.setViewerFooter({
        label: viewing.label,
        childSessionId: viewing.id,
        mode: viewing.mode,
        activity: viewing.activity,
        cwd: viewing.cwd,
        turns: stats.turns,
        steps: stats.steps,
        statsLine: formatStats(stats),
        usage: usageFromStats(stats),
      })
    }
    const enterView = async (
      childId: SessionId,
      label: string | undefined,
      mode: 'one-shot' | 'continuable',
      parentSessionId: SessionId,
      activity: 'running' | 'inactive',
      depth = 1,
    ): Promise<void> => {
      // Surface authority (plan §6.10): mode is the durable semantic, the
      // access is what THIS surface may do — only a direct (depth 1)
      // continuable child is interactive from the root.
      const access: ViewerAccess = depth > 1
        ? 'readonly-nested'
        : mode === 'one-shot' ? 'readonly-one-shot' : 'interactive-direct-child'
      const request = viewerOpen.open()
      const childFolder = new TranscriptFolder()
      const childWindow = new TranscriptWindowController({
        windowTurns: TRANSCRIPT_WINDOW_TURNS,
        stepTurns: TRANSCRIPT_WINDOW_STEP,
        turns: childFolder.groupedTurns(),
      })
      const childStats = new StatsFolder()
      let childCwd = ''
      // Only the child's OWN events enter the viewer: a fork provider seeds
      // the child with the parent's completed-turn history (session/end-seed
      // boundary), and the parent's records — its subagent completion
      // notices included — must never render as the child's transcript.
      const child = sessions.get(childId)
      if (child !== undefined) {
        const own = childOwnEvents(child.snapshotEvents())
        childFolder.hydrate(own)
        childStats.hydrate(own)
        // The live child's session header carries its workspace (the child
        // may have been born in another directory).
        childCwd = typeof (child as { header?: { cwd?: unknown } }).header?.cwd === 'string'
          ? (child as { header: { cwd: string } }).header.cwd
          : ''
      } else {
        // An inactive child is no longer in the live store; load its log.
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined) {
          try {
            const own = childOwnEvents((await persistence.inspect(childId)).events)
            childFolder.hydrate(own)
            childStats.hydrate(own)
          } catch {
            // No persisted log either: the view stays empty.
          }
        }
      }
      // The user's deliberate look is the anchor for the auto-pop: match the
      // child's durable label (the delegation's description) against the
      // unsettled subagent calls so this child's tool/result can pop the
      // viewer back. Duplicate labels take the MOST RECENT call (the one the
      // user is most likely watching); an empty/absent label falls back to a
      // lone pending call, and no match simply disables the auto-pop (the
      // user exits with Esc as before).
      //
      // STALE-OPEN GUARD: while the inspection above was in flight the user
      // may have exited, switched children, or swapped sessions — every one
      // of those invalidates the viewerOpen token. A stale request must not
      // commit its child over the current surface (no viewing write, no
      // repaint, no viewer mount, no auto-pop match).
      if (!viewerOpen.isCurrent(request)) return
      const matched = matchPendingSubagentCall(pendingSubagentCalls, label)
      if (matched !== undefined) viewCallToChild.set(matched.callId, childId)
      viewerSessionAbort = new AbortController()
      viewing = {
        id: childId,
        folder: childFolder,
         window: childWindow,
        stats: childStats,
        parentSessionId,
        label: label ?? childId,
        mode,
        activity,
        access,
        cwd: childCwd,
      }
      // The child's turn numbers are its OWN namespace: the parent's Focus
      // disclosures must not leak into the child transcript (plan §26).
      app.enterFocusViewerScope()
      repaint(app, childFolder, childWindow)
      // The viewer bar covers the editor (a read-only placeholder for
      // one-shot, the child's own draft for continuable) and the header
      // badges the mode — the transient notify is no longer the only "you
      // are elsewhere" signal. The FOOTER switches to the child's own
      // identity at the same time.
      app.setViewerMode({ parentSessionId, childSessionId: childId, label: label ?? childId, mode, activity, access })
      refreshViewerFooter()
    }
    /** Leave the subagent viewer (single Esc). Returns whether it exited.
     * Invalidates any in-flight viewer OPEN UNCONDITIONALLY — an Esc (or a
     * session swap, which routes through this) must prevent a slow
     * transcript inspection from reopening the viewer afterwards, even when
     * no viewer is currently mounted (the open is still in flight). */
    const exitView = (): boolean => {
      viewerOpen.invalidate()
      if (viewing === undefined) return false
      viewing = undefined
      viewerSessionAbort?.abort() // cancel an in-flight, not-yet-accepted follow-up
      viewerSessionAbort = undefined
      app.clearLocalMessages()
      app.clearNotify() // a viewer notify (if any) is stale now
      app.setViewerMode(undefined)
      // setViewerFooter(undefined) returns the display subject to main
      // (projected BEFORE its paint); the parent's facts follow on the
      // refreshStatus below.
      app.setViewerFooter(undefined)
      // Restore the parent's Focus disclosures BEFORE the repaint so the
      // projection uses them (plan §26).
      app.exitFocusViewerScope()
      repaint(app, folder, windowController)
      // The main transcript may have grown while the viewer covered it (the
      // child's result, the parent's streaming): restore the parent's semantic latest/history position
      // so the pop never loses an intentional history anchor.
      windowController.isLatest() ? app.scrollToBottom() : app.scrollToTop({ disableFollow: true })
      refreshStatusCheap()
      return true
    }
    /** Error sink for a failed session creation: restore the draft and
     * surface the reason instead of silently dropping the submission. The
     * classification diagnostics are owned by runOwned (label + session +
     * error); this sink only restores the editor and notifies the user.
     * (Cancellation never reaches here: runOwned routes it to onCancel.) */
    const failSubmission = (draft: string) => (error: unknown): void => {
      // Correctness side effect FIRST: restore the draft (the editor was
      // cleared before submit) — the error text is best-effort afterwards,
      // so a hostile value can never prevent the user's input from coming
      // back. (The classification diagnostics are owned by runOwned.)
      app.setEditorText(mergeDraft(app.getDraft(), draft))
      const message = safeErrorMessage(error)
      // Image intake/admission/capability failures are THEIR OWN actionable
      // errors ("Current model ... does not support image input") — wrapping
      // them in "could not start a session" misleads when a session already
      // exists (review finding).
      if (error instanceof ImageInputError) {
        app.notify(message, 'error')
        return
      }
      try {
        ctx.logger.error(`tui-runner: session creation failed: ${message}`)
      } catch {
        // The cordis logger must not block the notice.
      }
      app.notify(`could not start a session: ${message}`, 'error')
    }
    /**
     * Restore the submitted text into the editor after a failed submission
     * (review finding: the restore MUST run BEFORE the reservation pin
     * releases — the restored placeholders must keep their backing drafts
     * against concurrent attach-time prunes). Correctness side effect
     * first; never throws.
     */
    const restoreSubmissionDraft = (draft: string): void => {
      app.setEditorText(mergeDraft(app.getDraft(), draft))
    }
    // ── Local submit acknowledgement + latency timeline (submit-ack.ts /
    // submit-latency.ts) ── the immediate "Submitting…" / "Queued…" row
    // between the editor clearing and the FIRST authoritative DSH event,
    // and the T0-T5 phase timings for the diag channel. The window is real
    // even without any per-submit persistence check: session create, image
    // admission
    // and the host pre-step all delay `user/message`.
    const localSubmitAck: SubmitAckState = freshSubmitAckState()
    const submitLatencyTracker = new SubmitLatencyTracker({ sink: diag })
    /**
     * Accept one submission: show the pending row NOW (Submit/Queued by
     * the agent's live status) and start the latency timeline. Returns
     * the gesture's EPOCH TOKEN: the enclosing workflow's terminal exits
     * (failure / stale / fence / cancel / command routing) must settle
     * with THIS token — the settle is ignored once a newer gesture has
     * superseded it, so an older submission dying late can never clear
     * the newer row (or reset its latency timeline).
     */
    const acceptLocalSubmitAck = (): number => {
      const detail: SubmitPendingDetail = liveAgent?.status === 'running' ? 'queued' : 'submit'
      const token = acceptSubmitAck(localSubmitAck, { detail, now: Date.now() })
      submitLatencyTracker.accept(liveAgent?.session.id)
      app.setSubmitPending(detail)
      return token
     }
    /**
     * Settle the pending row: clears it when something is pending and
     * records the wait duration at debug level. Called from the
     * authoritative event branches, the failure sinks and the refusal
     * paths — idempotent everywhere.
     *
     * - TOKEN settles (`{ token }`): a submission's OWN terminal exit
     *   (failure / stale / fence / cancel / no-agent / command routing).
     *   Ignored when a newer gesture superseded the token — an older
     *   submission dying late must never clear the newer row nor reset
     *   its latency timeline.
     * - TOKENLESS settles: authoritative session events (coalescing) and
     *   the session-switch commit (the old row dies unconditionally).
     *
     * `terminal: true` additionally RESETS the latency timeline: a dead
     * submission's baseline must not be populated by unrelated later
     * events; the next real submission arms a fresh T0.
     */
    const settleLocalSubmitAck = (reason: string, options: { token?: number; terminal?: boolean } = {}): void => {
      if (options.token !== undefined && options.token !== localSubmitAck.epoch) {
        diag.debug('submit ack terminal settle superseded', { reason, token: options.token, current: localSubmitAck.epoch })
        return
      }
      const elapsed = settleSubmitAck(localSubmitAck, { now: Date.now() })
      if (options.terminal === true) submitLatencyTracker.reset()
      if (elapsed === undefined) return
      diag.debug('submit ack settled', { reason, elapsed: `${elapsed}ms` })
      app.setSubmitPending(undefined)
    }
    /**
     * Notify one submission failure WITHOUT restoring (the task's catch
     * already restored; restoring twice would re-merge the draft). Image
     * intake/admission/capability failures are THEIR OWN actionable errors
     * ("Current model ... does not support image input") — wrapping them in
     * "could not start a session" misleads when a session already exists.
     * Diagnostics are owned by runOwned.
     */
    const notifySubmissionFailure = (error: unknown): void => {
      // NOTE: the pending submit ack is settled by the CALLER with its own
      // gesture token (an untokenized settle here would let one
      // workflow's failure clear a newer gesture's row).
      const message = safeErrorMessage(error)
      if (error instanceof ImageInputError) {
        app.notify(message, 'error')
        return
      }
      try {
        ctx.logger.error(`tui-runner: submission failed: ${message}`)
      } catch {
        // The cordis logger must not block the notice.
      }
      // A followup/steer against an EXISTING session is not a session
      // creation failure — "could not start a session" would mislead
      // (review finding).
      const prefix = liveAgent === undefined ? 'could not start a session' : 'submission failed'
      app.notify(`${prefix}: ${message}`, 'error')
    }
    /** The image submission surface (plan §13): the live attachment/llm
     * services + the CURRENT provider/model, re-read at submit time (the
     * TUI supports runtime model switching — never a startup snapshot). */
    const submitDeps: PrepareInputDeps = {
      attachments: ctx.get('attachments') as PrepareInputDeps['attachments'],
      llm: ctx.get('llm') as PrepareInputDeps['llm'],
      // Send-time `@`-file canonicalization through the Host-file port
      // (migration M1.10): the live session's workspace is the scope.
      canonicalizeMentions: (text) => backend.hostFile.canonicalizeMentions({ kind: 'session', sessionId: liveAgent?.session.id ?? '' }, text),
      sessionCwd: () => sessionCwd(),
      currentModel: () => {
        // The AUTHORITATIVE model for the next step is the mutable
        // selection's `current` (/model writes it; prompt assembly reads
        // it) — never `liveAgent.options`, which holds the agent's launch
        // configuration and does not move on /model (review finding 1).
        const current = selected.current
        if (current !== undefined) return { provider: current.provider, model: current.model }
        // No selection assembled yet (pre-/model or a sessionless start):
        // fall back to the agent's launch options as the best known pair.
        if (liveAgent === undefined) return undefined
        const { provider, model } = liveAgent.options
        return provider === undefined || model === undefined ? undefined : { provider, model }
      },
    }
    /** The session-backed dispatch: create the session lazily (the first
     * user input is the deferred trigger), then execute a registered slash
     * command or follow up. */
    const dispatchViaSession = (text: string, persistHistory: (sessionId: string | undefined) => void): void => {
      // Local submit acknowledgement (plan D): the row appears NOW —
      // before any session create / admission / command work — because
      // this gesture owns no user-visible feedback until the first
      // authoritative event lands. The TOKEN arms every terminal exit of
      // THIS workflow: a newer gesture supersedes them.
      const submitAckToken = acceptLocalSubmitAck()
      // Capture the advertised claim BEFORE any session creation: the
      // boolean must reflect the completion generation at submit time, never
      // a re-query after ensureSession (a refresh may have already revoked
      // the claim). A probed command the real session then lacks is consumed
      // with an explicit error below — it must never fall through to the
      // model as a plain user message.
      const parsedAtSubmit = parseCommand(text)
      const extensionCommandId = parsedAtSubmit === undefined
        ? undefined
        : extensionService?.commands.idFor(parsedAtSubmit.name)
      // Assigned inside the runOwned factory (invocation-time capture).
      let commandHealthRef: { slot: string; id: string; owner: string } | undefined
      // The health ref is NOT captured here: the submit-time identity can
      // be stale after the async ensureSession phase below (an HMR
      // reload in between means the REAL invocation runs the NEW owner's
      // command). It is re-captured inside the runOwned factory,
      // immediately before execute() — see below (the review's P2).
      const wasAdvertised = parsedAtSubmit !== undefined && wasAdvertisedClaim?.(parsedAtSubmit.name) === true
      // An owned workflow: the chain's outcome drives the editor draft, the
      // notices and the queue — runOwned (AGENTS.md), never a bare void.
      // Reserve the referenced drafts SYNCHRONOUSLY, in the SAME call stack
      // that left the editor (review finding): ensureSession() on a
      // deferred start is async (create/compose/resume), and the editor is
      // already cleared — an attach-time prune during session creation must
      // not delete the images this submission is about to admit. No await
      // may precede the reservation.
      // The submit-flow core owns the ordering contract (reserve →
      // run → failure-restore-before-release → release), shared with the
      // integration tests — never hand-rolled per path.
      runOwned('submit', () => runReservedSubmit({
        reserve: (t) => draftImages.pinReferenced(t),        run: async () => {
          // The deferred-start gate (history-persist.ts): the history row
          // is written AFTER the session exists, with the FINAL session
          // id — the first prompt of a deferred start creates the session
          // inside resolveSession, and a row written before creation would
          // carry no sessionId and vanish from the Ctrl+R `Current
          // session` scope. A resolution that REJECTS (session creation
          // failed) persists nothing — the submission never reached a
          // session; a resolution that resolves undefined (sessionless)
          // persists a row without a sessionId.
          await persistAfterSession(
            async () => {
              await ensureSession()
              return liveAgent?.session.id
            },
            persistHistory,
          )
          const agent = liveAgent
          if (agent === undefined) {
            // Nothing can be written (degraded resolve after a successful
            // creation): the wait ends here with NO write — the pending
            // row must not outlive the submission.
            settleLocalSubmitAck('submit resolved without an agent', { token: submitAckToken, terminal: true })
            return
          }
        // Capture THIS agent's session identity so the write below can
        // never target a session a switch already left behind (the async
        // admission below yields).
        const generation = sessionGeneration
        // TOCTOU re-validation: the session must still be the exact one the
        // identity was captured from, or the submission is aborted for a
        // retry against the new session.
        if (!sessionUnchanged({ agent, generation }, liveAgent, sessionGeneration)) {
          const merged = mergeDraft(app.getDraft(), text)
          app.setEditorText(merged)
          settleLocalSubmitAck('submit stale', { token: submitAckToken, terminal: true })
          app.notify(merged === text
            ? 'the session changed while sending — try again'
            : 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)', 'error')
          return
        }
        // From here on the CAPTURED agent is used — never the mutable
        // liveAgent: writing through a re-read closure variable could
        // target a session the identity check did not see (a switch
        // between the check and the write).
        const commands = ctx.get('commands')
        if (commands !== undefined) {
          // Bare `/plan` toggles: when plan mode is already active it exits
          // instead of re-entering (the official command needs `/plan off`).
          const parsed = parseCommand(text)
          const toggled = parsed?.name === 'plan' && parsed.rawInput.trim() === ''
            && projectedPlanActive(ctx.get('sessionProjections') as PlanProjectionLike | undefined, agent.session) === true
            ? '/plan off'
            : text
          // The command execution is itself an owned workflow: its outcome
          // decides between the fallback follow-up and a draft restore.
          // HANDSHAKE PIN (review finding): the outer task's pin releases
          // when this task returns (right after launching the command), but
          // the nested fallback pin is only established inside onResult —
          // without a synchronous handoff the referenced drafts would be
          // prunable for the whole command run. Acquire it HERE, transfer
          // it to the nested fallback, and release it on every other exit.
          const fallbackPin = draftImages.pinReferenced(text)
          // The session-transition write fence: the identity check above
          // can yield across a concurrent /new, /fork, rewind or
          // switch — once a transition is in flight, executing the command
          // would write an agent whose lock is about to be released (review
          // round 27). Refuse and restore the draft instead.
          if (transitionGate.busy) {
            fallbackPin()
            refuseByTransitionFence(text, () => app.getDraft(), (t) => app.setEditorText(t), (m, k) => app.notify(m, k))
            settleLocalSubmitAck('submit refused by transition fence', { token: submitAckToken, terminal: true })
            return
          }
          runOwned('command execution', () => {
            // RE-CAPTURE at invocation time: the runOwned factory runs
            // SYNCHRONOUSLY right before execute(), so there is no race
            // window — the ref always names the owner whose command is
            // actually about to run (a submit-time capture could name a
            // long-gone owner after an HMR reload, silently dropping the
            // new owner's real failures; the review's P2).
            const liveCommandId = parsedAtSubmit === undefined || extensionService === undefined
              ? undefined
              : extensionService.commands.idFor(parsedAtSubmit.name)
            commandHealthRef = liveCommandId === undefined
              ? undefined
              : extensionService?._recordRegistryHealthRef('command', liveCommandId)
            return commands.execute(agent as Agent, toggled, [], signal)
          }, {
            diag,
            sessionId: () => agent.session.id,
            onResult: (execution) => {
              if (commandHealthRef !== undefined && execution !== undefined) {
                extensionService?._clearRegistryError(commandHealthRef)
              }
              // A command that RAN owns its own feedback (cards, working
              // surface): the submit-ack row stands down here — never
              // before execute() resolved, so the fallback followup (a
              // plain prompt: execute → undefined) keeps its pending row.
              if (execution !== undefined) {
                settleLocalSubmitAck('submit consumed by a command', { token: submitAckToken, terminal: true })
              }
              // A command the surface advertised (e.g. from the startup
              // probe) but the real session's catalog lacks: consume the
              // slash input with an explicit error — never a plain model
              // message, never an automatic draft restore (the refreshed
              // completions already revoked the claim, and a mechanical
              // retry could ride the unadvertised fallback).
              if (shouldConsumeAdvertisedMiss(execution, wasAdvertised)) {
                app.notify(`/${parsedAtSubmit?.name ?? '?'} is not available in the created session`, 'error')
                settleLocalSubmitAck('submit consumed by an unadvertised command', { token: submitAckToken, terminal: true })
                fallbackPin()
                return
              }
              // The fallback follow-up still targets the CAPTURED agent; if
              // the session moved on while the command ran, restore the
              // draft instead of posting into a session the user has left.
              if (execution === undefined) {
                if (sessionUnchanged({ agent, generation }, liveAgent, sessionGeneration)) {
                  // The fallback is a REAL submission: prepare (admit
                  // images when present) and follow up — an owned workflow
                  // so a failed image admission restores the draft instead
                  // of silently dropping the images. This nested workflow
                  // outlives the outer task (fire-and-forget), so it
                  // consumes the handoff pin across the async admission
                  // and releases it in its own finally (review finding 1
                  // follow-up).
                  runOwned('image submit', () => runReservedSubmit({
                    // TRANSFER the handoff reservation, never a second
                    // pin: fallbackPin was acquired synchronously before
                    // commands.execute() launched (covering the outer
                    // release window); the nested flow releases it in its
                    // finally (review finding — double pinning leaked the
                    // handoff pin forever).
                    reserve: () => fallbackPin,
                    run: async () => {
                      // The WHOLE write (admission → identity check →
                      // followup) runs inside the operation barrier: a
                      // transition started while the admission awaits waits
                      // for this writer to drain, and a writer entering
                      // during a transition is refused (convergence plan
                      // phase 3).
                      try {
                        await operationBarrier.runWriter(agent.session.id, async () => {
                          const message = await prepareUserMessage(text, draftImages, submitDeps)
                          // Re-check the captured session identity AFTER the
                          // async admission (the guard-window rule, AGENTS.md).
                          if (!sessionUnchanged({ agent, generation }, liveAgent, sessionGeneration)) {
                            const merged = mergeDraft(app.getDraft(), text)
                            app.setEditorText(merged)
                            settleLocalSubmitAck('submit stale', { token: submitAckToken, terminal: true })
                            app.notify(merged === text
                              ? 'the session changed while sending — try again'
                              : 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)', 'error')
                            return
                          }
                          // T1 BEFORE the write (see the direct path above).
                          submitLatencyTracker.mark(agent.session.id, 'dispatch')
                          backend.sessionWriter.followup(agent.session.id, message)
                          // Consume ONLY the referenced drafts — a concurrent
                          // intake's newer image survives (round-5 finding 1).
                          consumeDraftImages(text, draftImages)
                        })
                      } catch (error) {
                        if (error instanceof TransitionInProgressError) {
                          fallbackPin()
                          refuseByTransitionFence(text, () => app.getDraft(), (t) => app.setEditorText(t), (m, k) => app.notify(m, k))
                          settleLocalSubmitAck('submit refused by transition fence', { token: submitAckToken, terminal: true })
                          return
                        }
                        throw error
                      }
                    },
                    restore: (t) => restoreSubmissionDraft(t),
                  }, text), {
                    diag,
                    sessionId: () => agent.session.id,
                    // The flow restored the editor; this sink settles the
                    // gesture's ack (token-scoped) and only notifies.
                    onError: (error) => {
                      settleLocalSubmitAck('failure', { token: submitAckToken, terminal: true })
                      notifySubmissionFailure(error)
                    },
                    // Cancellations route EXCLUSIVELY here (never
                    // onError): a cancelled fallback write must end the
                    // ack row the gesture armed (plan D exit enumeration;
                    // the flow already restored the draft).
                    onCancel: () => {
                      settleLocalSubmitAck('submit cancelled', { token: submitAckToken, terminal: true })
                    },
                  })
                } else {
                  fallbackPin()
                  const merged = mergeDraft(app.getDraft(), text)
                  app.setEditorText(merged)
                  settleLocalSubmitAck('submit stale', { token: submitAckToken, terminal: true })
                  app.notify(merged === text
                    ? 'the session changed while sending — try again'
                    : 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)', 'error')
                }
              } else {
                // The command COMMITTED (no image fallback): release the
                // handoff pin.
                fallbackPin()
              }
            },
            onError: (error) => {
              fallbackPin()
              settleLocalSubmitAck('command execution failed', { token: submitAckToken, terminal: true })
              if (commandHealthRef !== undefined) extensionService?._recordRegistryError(commandHealthRef, error)
              const message = safeErrorMessage(error)
              try {
                ctx.logger.error(`tui-runner: command execution failed: ${message}`)
              } catch {
                // The cordis logger must not block the user notice.
              }
              app.notify(message, 'error')
            },
            // A cancelled command runs NO other sink (runOwned routes
            // cancellations to onCancel only): without this the ack row
            // armed at the gesture would pend forever and the handoff pin
            // would leak (plan D exit enumeration).
            onCancel: () => {
              fallbackPin()
              settleLocalSubmitAck('command execution cancelled', { token: submitAckToken, terminal: true })
            },
          })
          return
        }
        // No commands service: direct follow-up on the CAPTURED agent (see
        // the note above — never a re-read closure variable). Images ride
        // the same prepared message as every other path (§13). The WHOLE
        // write runs inside the operation barrier (convergence plan
        // phase 3): a transition started during the admission waits for
        // this writer to drain; a writer entering during a transition is
        // refused.
        try {
          await operationBarrier.runWriter(agent.session.id, async () => {
            const message = await prepareUserMessage(text, draftImages, submitDeps)
            // Re-check the captured session identity AFTER the async
            // admission (the guard-window rule, AGENTS.md).
            if (!sessionUnchanged({ agent, generation }, liveAgent, sessionGeneration)) {
              const merged = mergeDraft(app.getDraft(), text)
              app.setEditorText(merged)
              settleLocalSubmitAck('submit stale', { token: submitAckToken, terminal: true })
              app.notify(merged === text
                ? 'the session changed while sending — try again'
                : 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)', 'error')
              return
            }
            // T1 BEFORE the write call: a synchronously-emitted inbox/turn
            // event (Direct in-process) must never log ahead of dispatch.
            submitLatencyTracker.mark(agent.session.id, 'dispatch')
            backend.sessionWriter.followup(agent.session.id, message)
            // Consume ONLY the referenced drafts — a concurrent intake's
            // newer image survives (round-5 finding 1).
            consumeDraftImages(text, draftImages)
          })
        } catch (error) {
          if (error instanceof TransitionInProgressError) {
            settleLocalSubmitAck('submit refused by transition fence', { token: submitAckToken, terminal: true })
            refuseByTransitionFence(text, () => app.getDraft(), (t) => app.setEditorText(t), (m, k) => app.notify(m, k))
            return
          }
          throw error
        }
        },
        restore: (t) => restoreSubmissionDraft(t),
      }, text), {
        diag,
        sessionId: () => liveAgent?.session.id,
        // The flow restored the editor; this sink settles the gesture's
        // ack (token-scoped) and only notifies.
        onError: (error) => {
          settleLocalSubmitAck('failure', { token: submitAckToken, terminal: true })
          notifySubmissionFailure(error)
        },
        // runOwned routes cancellations EXCLUSIVELY to onCancel: a
        // cancelled deferred create / image admission / barrier write
        // bypasses onError, so the ack row armed at the gesture must be
        // terminated HERE (the flow already restored the draft — plan D
        // exit enumeration).
        onCancel: () => {
          settleLocalSubmitAck('submit cancelled', { token: submitAckToken, terminal: true })
        },
      })
    }
    /**
     * Run a sessionless slash command locally — no session, no session
     * log. The input-history row still persists, sessionless (Current
     * directory / All directories, never Current session). The handler
     * comes from the commands service's global layer (in-process lookup
     * with no agent is safe: it reads the global layer only). A
     * sessionless command that failed to register falls back to the
     * session dispatch, which reports unknown commands as messages.
     */
    const runLocalCommand = (parsed: { name: string; rawInput: string }, text: string, persistHistory: (sessionId: string | undefined) => void): void => {
      // M5: a plugin-declared local command with a bridge handler routes
      // to the bridge FIRST (its rawInput is passed verbatim — never
      // re-parsed or rewritten, the skill rawInput regression gate); the
      // commands service is the fallback for core commands.
      const bridgeHandler = extensionService?.commands.handlerFor(parsed.name)
      const bridgeCommandId = extensionService?.commands.idFor(parsed.name)
      // Captured at INVOCATION START (same generation fence as the
      // session command path).
      const bridgeCommandRef = bridgeCommandId === undefined || extensionService === undefined
        ? undefined
        : extensionService._recordRegistryHealthRef('command', bridgeCommandId)
      const commands = ctx.get('commands')
      const definition = commands?.find(undefined as unknown as Agent, parsed.name)
      if (bridgeHandler === undefined && (commands === undefined || definition === undefined)) {
        // The "sessionless" command is actually unknown: it falls back to
        // a session dispatch — the history row goes through the
        // deferred-start gate (persist AFTER the session exists, with the
        // final session id), never a sessionless write here.
        dispatchViaSession(text, persistHistory)
        return
      }
      const invocation = {
        commandId: `cmd-local-${randomUUID()}`,
        agent: undefined as unknown as Agent,
        rawInput: parsed.rawInput,
        signal,
      } as CommandInvocation
      const handler = bridgeHandler ?? definition?.handler
      if (handler === undefined) {
        dispatchViaSession(text, persistHistory)
        return
      }
      // A truly local command: no session is created — the row persists
      // sessionless (Current directory / All directories, never Current
      // session).
      persistHistory(historySessionIdFor('sessionless', liveAgent?.session.id))
      // An owned workflow: the result decides the notify, the failure lands
      // in diagnostics — runOwned (AGENTS.md), never a bare void. The
      // handler may be a SYNC implementation, so the factory must run inside
      // runOwned (a sync throw would otherwise escape before the entry).
      runOwned('local command', () => handler(invocation), {
        diag,
        sessionId: () => liveAgent?.session.id,
        onResult: (result) => {
          if (result !== undefined && result.kind === 'error') {
            if (bridgeCommandRef !== undefined) extensionService?._recordRegistryError(bridgeCommandRef, new Error(result.text))
            app.notify(result.text)
          } else if (bridgeCommandRef !== undefined) {
            extensionService?._clearRegistryError(bridgeCommandRef)
          }
        },
        onError: (error) => {
          if (bridgeCommandRef !== undefined) extensionService?._recordRegistryError(bridgeCommandRef, error)
          const message = safeErrorMessage(error)
          try {
            ctx.logger.error(`tui-runner: local command failed: ${message}`)
          } catch {
            // The cordis logger must not block the user notice.
          }
          app.notify(message, 'error')
        },
      })
    }
    /**
     * Steer into the running turn with re-validation. Shared by
     * Ctrl+S (the whole queue plus a non-empty draft) and the busy-Enter
     * preference — Enter while the agent is running with busyEnter=steer
     * steers the DRAFT ONLY (web busyEnter parity): explicitly queued
     * messages stay queued until Ctrl+S or the /queue actions, because
     * already-steered input cannot be pulled back.
     * @param text - the submitted draft ('' allowed for Ctrl+S).
     * @param onlyDraft - busy-Enter mode: never read or remove the queue.
     * @param persistHistory - the call site's persist closure (with its
     * submission-time snapshot). Invoked AFTER the session exists with the
     * FINAL session id — the deferred-start gate: Ctrl+S on a deferred
     * start creates the session inside this flow, and a row written
     * before creation would carry no sessionId and vanish from the Ctrl+R
     * `Current session` scope. Absent, the steer persists nothing.
     */
    const steerNow = (text: string, onlyDraft = false, persistHistory?: (sessionId: string | undefined) => void): void => {
      // The subagent viewer is read-only: steering would send to the
      // PARENT session. Refuse with a notice and restore the draft.
      if (viewing !== undefined) {
        if (text.trim() !== '') app.setEditorText(mergeDraft(app.getDraft(), text))
        app.notify('viewing a subagent — Esc returns before steering', 'info')
        return
      }
      // Same dismissal rule as submissions: settled local cards are a live
      // view, not a record (completed `!`/`!!` runs).
      app.clearSettledLocalMessages()
      // Ctrl+S: send everything pending (kimi parity: the whole queue plus
      // a non-empty draft rides along). With queued messages the entire
      // queue is steered at once — the queue pane above the editor is the
      // primary surface; without a queue it stays the classic single-draft
      // steer. Nothing to send at all is a no-op BEFORE any session is
      // created (deferred start). Every message goes through steer(): the
      // next step boundary claims all next-step input together, so the
      // batch arrives in one shot (an idle driver starts a turn with it).
      // The payload verdict is computed ONCE here on the SERIALIZED wire
      // form and passed to steerAll (steer.ts never guesses shell/image
      // semantics): `!` / `!!` shell modes make a bare prefix a payload,
      // image placeholders make an empty-text draft a payload, whitespace
      // alone is not.
      const draftHasPayload = text.trim() !== '' || draftHasImages(text, draftImages)
      // The empty-Ctrl+S gate: nothing to steer is a clean no-op BEFORE
      // any runOwned / ensureSession work — the deferred-start contract
      // (an empty Ctrl+S must never create the session). The decision is
      // the steerHasPayload pure function (headless-pinned).
      if (!steerHasPayload(draftHasPayload, {
        onlyDraft,
        queuedCount: liveAgent === undefined ? 0 : liveAgent.inbox.nextTurn.length + liveAgent.inbox.nextStep.length,
        liveAgent: liveAgent !== undefined,
      })) return
      // Local submit acknowledgement (plan D): the row appears NOW, before
      // the awaited prepare/admission work, so an accepted Ctrl+S is never
      // a silent editor clear. The TOKEN arms every terminal exit of THIS
      // workflow.
      const steerAckToken = acceptLocalSubmitAck()
      // An owned workflow: the send's outcome drives the draft restore and
      // the notices — runOwned (AGENTS.md), never a bare void. Reserve the
      // referenced drafts SYNCHRONOUSLY (same call stack that left the
      // editor — review finding): ensureSession() is async on a deferred
      // start, and no await may precede the reservation.
      // The submit-flow core owns the ordering contract (shared with the
      // integration tests).
      runOwned('steer', () => runReservedSubmit({
        reserve: (t) => draftImages.pinReferenced(t),
        run: async () => {
        // The deferred-start gate (history-persist.ts): the steered
        // draft's history row is written AFTER the session exists, with
        // the FINAL session id — Ctrl+S on a deferred start creates the
        // session here, and a row written before creation would carry no
        // sessionId and vanish from the Ctrl+R `Current session` scope.
        // A rejected creation persists nothing (the steer never reached
        // a session).
        await persistAfterSession(
          async () => {
            await ensureSession()
            return liveAgent?.session.id
          },
          (sessionId) => persistHistory?.(sessionId),
        )
        if (liveAgent === undefined) {
          // Nothing can be sent (degraded resolve after a successful
          // creation): the ack row must not outlive the submission.
          settleLocalSubmitAck('steer resolved without an agent', { token: steerAckToken, terminal: true })
          return
        }
        // The draft message is prepared BEFORE the send: admission is
        // async I/O, and the prepared message is exactly what the send
        // delivers (§13).
        const prepared = await prepareUserMessage(text, draftImages, submitDeps)
        // T1 BEFORE the dispatch: the steer is being invoked, and any
        // synchronously-emitted event from the delivery must never log
        // ahead of it. The ACK ROW keeps waiting for the authoritative
        // event (plan D).
        submitLatencyTracker.mark(liveAgent.session.id, 'dispatch')
        // The whole send (snapshot → re-validate → confirm-and-send) lives
        // in steer.ts so the races are testable: a queue splice or session
        // switch while the delivery is in flight aborts with a retry notice
        // instead of losing messages.
        const outcome = await steerAll({
          currentAgent: () => liveAgent as unknown as SteerAgentLike,
          currentGeneration: () => sessionGeneration,
          notify: (message, kind) => app.notify(message, kind),
          restoreDraft: (draft) => {
            const merged = mergeDraft(app.getDraft(), draft)
            app.setEditorText(merged)
            return merged === draft
          },
          // The session-transition write fence: while a transition is in
          // flight (quiesce → commit) the old agent may be woken again —
          // a steer in that window would target a session whose lock is
          // about to be released (the two-writers race, review round 4).
          fence: () => transitionGate.busy,
          barrier: operationBarrier,
          fenceNotice: () => 'a session transition is in progress — try again in a moment',
          createDraft: () => prepared,
          staleNotice: () => 'the queue or session changed while sending — try again',
          mergedNotice: () => 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)',
          // The FINAL delivery goes through the session WRITE port: the
          // Direct fence/barrier orchestration above stays in the runner,
          // the port only delivers (steer/followup/dequeue).
          writer: backend.sessionWriter,
        },
        text,
        onlyDraft ? { onlyDraft: true, draftHasPayload } : { draftHasPayload },
      )
        // Only a successful send consumes the drafts: on block/stale the
        // draft was restored and the images are still referenced — removing
        // would orphan the placeholders (§14). The consumption is
        // per-reference, so a concurrent intake's newer draft survives
        // (round-5 finding 1).
        if (outcome === 'ok') {
          consumeDraftImages(text, draftImages)
          // The write landed; T1 was stamped BEFORE the dispatch call. The
          // ACK ROW keeps waiting for the authoritative event (plan D).
        }
        // Only a NON-delivered steer settles the ack row here: 'ok' waits
        // for the authoritative inbox event (plan D — an event, a failure
        // or a session switch ends the wait, never the delivery itself);
        // 'stale' wrote nothing and restored the draft, so the row must
        // not linger (a retry re-accepts).
        if (outcome !== 'ok') settleLocalSubmitAck(`steer ${outcome}`, { token: steerAckToken, terminal: true })
        },
        restore: (t) => restoreSubmissionDraft(t),
      }, text), {
        diag,
        sessionId: () => liveAgent?.session.id,
        // The flow restored the editor; this sink settles the gesture's
        // ack (token-scoped) and only notifies.
        onError: (error) => {
          settleLocalSubmitAck('failure', { token: steerAckToken, terminal: true })
          notifySubmissionFailure(error)
        },
        // runOwned routes cancellations EXCLUSIVELY to onCancel: a
        // cancelled deferred create / image admission / barrier write
        // bypasses onError, so the ack row armed at the gesture must be
        // terminated HERE (the flow already restored the draft — plan D
        // exit enumeration).
        onCancel: () => {
          settleLocalSubmitAck('steer cancelled', { token: steerAckToken, terminal: true })
        },
      })
    }
    /**
     * The newest input-history entry this process persisted (kimi's
     * `lastHistoryContent` analogue): consecutive repeats are skipped per
     * window, exactly like shell history.
     */
    let lastHistoryContent: string | undefined
    /**
     * Build the steer-persist closure for a draft (Ctrl+S, the
     * steer-draft extension action, busy-Enter steer): the submission-time
     * facts — the ts (the row must record the USER's steer time, not the
     * post-creation write time) and the image check (the editor is
     * cleared right after and the steer flow consumes the staged images
     * on success, so a late check would wrongly persist the placeholder
     * text) — are snapshotted NOW. The returned closure writes the row
     * under the session id the steer gate resolved (the FINAL id after
     * session creation on a deferred start). An empty draft (Ctrl+S with
     * only a queue) persists nothing — the queued messages were already
     * persisted when originally submitted.
     */
    const makeSteerPersist = (text: string): ((sessionId: string | undefined) => void) => {
      const trimmed = text.trim()
      const historyTs = Date.now()
      const historyHasImages = draftHasImages(text, draftImages)
      return (sessionId: string | undefined): void => {
        if (trimmed === '' || trimmed === lastHistoryContent || historyHasImages) return
        const historyCwd = sessionCwd()
        const file = historyFilePath(dshHome(process.env), historyCwd)
        runDetached('input history write', () => {
          const written = persistHistoryRecord({
            content: trimmed,
            cwd: historyCwd,
            sessionId: historySessionIdFor('agent-facing', sessionId),
            ts: historyTs,
            lastContent: lastHistoryContent,
            hasImages: historyHasImages,
            file,
          })
          if (written) lastHistoryContent = trimmed
        }, {
          diag,
          notify: (message) => app.notify(message, 'error'),
          recoverable: () => true,
        })
      }
    }
    /**
     * Dispatch one user submission end to end: the viewer guard, the input-
     * history persistence, `!` local shells, sessionless commands, the
     * busy-Enter preference, and the session dispatch. The Ctrl+Enter
     * opposite chord forces the QUEUE mode (forceQueue), web busyEnter
     * parity — the accelerated chord uses the other behavior.
     * @param text - the submitted draft.
     * @param forceQueue - the chord: never steer, queue instead.
     */
    const dispatchUserInput = (text: string, forceQueue = false): void => {
      // P0 (empty-submission semantics): an EMPTY serialized wire form is
      // a silent no-op — no history write, no session creation, no
      // followup/steer, no image admission, no queue mutation. Judged on
      // the wire form ONCE here: the editor onSubmit path already
      // swallowed `''`, but plugin-extension submissions (submitDraft via
      // the semantic action) and any future caller must not bypass it.
      // A bare `!` / `!!` shell mode serializes to a non-empty wire form
      // (handle below at the shell branches), and an image-bearing draft
      // is non-empty too (the placeholder markers are part of the text —
      // draftHasImages).
      if (text.trim() === '' && !draftHasImages(text, draftImages)) return
      // Plain `exit` quits (shell muscle memory): the exact trimmed word
      // intercepts BEFORE any session creation or submission, so typing
      // `exit` with a deferred start never births a session. `/exit` remains
      // the command form; any other prompt still goes to the model.
      if (isPlainExitPrompt(text)) {
        requestExit()
        return
      }
      // The subagent viewer is READ-ONLY: submitting while viewing would
      // silently send to the PARENT session. Refuse with a notice instead.
      if (viewing !== undefined) {
        app.setEditorText(mergeDraft(app.getDraft(), text))
        app.notify('viewing a subagent — Esc returns before submitting', 'info')
        return
      }
      // A fresh submission dismisses settled local cards (completed `!`/`!!`
      // runs): the card is a live view, not a record — the transcript row
      // (context runs) or the next input takes over. Running cards survive
      // so a live stream is never dismissed by a concurrent submit.
      app.clearSettledLocalMessages()
      // Persist the submitted line to the LIVE session's cwd input-history
      // file (kimi-style JSONL under $DSH_HOME/user-history — never the
      // settings document). Consecutive repeats are skipped like shell
      // history; a failed write is user-recoverable: notify instead of
      // dropping it. `!` shell lines persist verbatim so ↑ recall re-runs
      // the shell branch.
      const trimmed = text.trim()
      // Submission-time facts snapshotted BEFORE any async work: the
      // timestamp (the row must record the USER's submission time, not the
      // disk-write time — an agent-facing write lands after session
      // creation) and the image check (a MULTIMODAL submission is NOT
      // persisted to the plain-text history: the placeholder dies with its
      // draft on consumeDraftImages, so an ↑ recall would re-send the
      // placeholder as ORDINARY TEXT — the images would silently vanish
      // from the model input (review finding 3). A late check would miss
      // the already-consumed images. Structured attachment history (text +
      // refs, recalled on recall) is a post-v1 extension.)
      const historyTs = Date.now()
      const historyHasImages = draftHasImages(text, draftImages)
      /**
       * Persist the submitted line under the given session identity. The
       * sessionId is a PARAMETER, resolved at the CALL SITE — the
       * deferred-start gate (history-persist.ts): an agent-facing
       * submission passes the FINAL session id AFTER the session exists
       * (the first prompt of a deferred start creates the session; a row
       * written before creation would carry no sessionId and vanish from
       * the Ctrl+R `Current session` scope). Sessionless submissions pass
       * undefined and stay visible in `Current directory` / `All
       * directories`. The cwd is resolved at PERSIST time so the row
       * lands in the session's cwd file with a `cwd` field that agrees
       * with the file hash.
       */
      const persistHistory = (sessionId: string | undefined): void => {
        const historyCwd = sessionCwd()
        const file = historyFilePath(dshHome(process.env), historyCwd)
        runDetached('input history write', () => {
          const written = persistHistoryRecord({
            content: trimmed,
            cwd: historyCwd,
            sessionId,
            ts: historyTs,
            lastContent: lastHistoryContent,
            hasImages: historyHasImages,
            file,
          })
          if (written) lastHistoryContent = trimmed
        }, {
          diag,
          notify: (message) => app.notify(message, 'error'),
          recoverable: () => true,
        })
      }
      // `!` runs the command and submits the completed command+output to
      // the session (kimi parity); `!!` runs purely locally with no session
      // write (pi's excluded-from-context escape hatch). A local `!!` needs
      // no session at all; the contextual `!` creates the session first
      // (the FIRST user message is the deferred trigger).
      if (text.startsWith('!')) {
        if (text.startsWith('!!')) {
          // `!!` runs purely locally with NO session write (pi's
          // excluded-from-context escape hatch) — the row is sessionless
          // (Current directory / All directories, never Current session).
          persistHistory(historySessionIdFor('sessionless', liveAgent?.session.id))
          runLocalShell(text, undefined)
        } else if (shellCommandOf(text) !== '') {
          // Local submit acknowledgement (plan D), armed AT THE GESTURE —
          // BEFORE ensureSession: a deferred/slow session create is part
          // of the no-feedback window this row exists to cover. The
          // runLocalShell-side accept was moved here so the T0 baseline
          // is never rebased by the shell wiring. The TOKEN rides into
          // the shell flow: its terminal exits settle only while THIS
          // gesture is still the newest one.
          const shellAckToken = acceptLocalSubmitAck()
          // An owned workflow: the session creation failure restores the
          // draft (failSubmission) — runOwned (AGENTS.md), never a bare
          // void. The history row is written AFTER the session exists
          // (the deferred-start gate), so a `!` line that creates the
          // session carries its id.
          runOwned('contextual shell', () => ensureSession().then(() => {
            persistHistory(historySessionIdFor('agent-facing', liveAgent?.session.id))
            runLocalShell(text, shellAckToken)
          }), {
            diag,
            sessionId: () => liveAgent?.session.id,
            onError: (error) => {
              // The session create failed: nothing will be written — the
              // ack row armed at the gesture is TERMINAL here (plan D).
              settleLocalSubmitAck('session creation failed', { token: shellAckToken, terminal: true })
              failSubmission(text)(error)
            },
            onCancel: () => {
              // NOT wrapped in runReservedSubmit: nothing restores the
              // draft here, so a cancelled ensureSession would silently
              // lose the submitted text — merge it back first (no error
              // notice: a cancellation is not a failure), then end the
              // ack row terminally.
              app.setEditorText(mergeDraft(app.getDraft(), text))
              settleLocalSubmitAck('contextual shell cancelled', { token: shellAckToken, terminal: true })
            },
          })
        } else {
          // A bare `!` (no command) is a no-op — sessionless.
          persistHistory(historySessionIdFor('sessionless', liveAgent?.session.id))
        }
        return
      }
      // A sessionless slash command runs locally BEFORE any session exists:
      // typing /exit, /settings, /help, ... must not create one (deferred
      // start). Everything else — session-backed commands, core commands
      // like /plan, and plain prompts — creates the session lazily. M5: a
      // plugin-declared sessionless command (CommandBridge) joins the set.
      const parsed = parseCommand(text)
      // Command semantics matrix (plan §19.3): slash commands are not LLM
      // prompts — an image-bearing command line is REJECTED explicitly
      // (never a silent drop, never a stray placeholder sent to the model).
      // The draft comes back so the user can re-attach after choosing a
      // plain prompt. LOCAL commands only: agent-facing invocations —
      // plain prompts AND per-skill slash lines, including `/skill <name>
      // [image #N ...]` (`skill` is local only as the bare picker; with
      // arguments it is a loadSkill agent prompt — review finding).
      if (commandRejectsImages(parsed, text, draftImages, name => {
        if (name === 'skill' && (parsed?.rawInput.trim() ?? '') !== '') return false
        return LOCAL_COMMANDS.has(name)
          || (extensionService?.commands.isLocal(name, LOCAL_COMMANDS) ?? false)
      })) {
        app.setEditorText(mergeDraft(app.getDraft(), text))
        app.notify('Images cannot be attached to a command.', 'error')
        return
      }
      const isSessionless = parsed !== undefined && (
        SESSIONLESS_COMMANDS.has(parsed.name)
        || (extensionService?.commands.isSessionless(parsed.name, SESSIONLESS_COMMANDS) ?? false)
      )
      if (parsed !== undefined && isSessionless) {
        // A recognized sessionless command: its history row is sessionless
        // — it must NEVER appear in Current session, whether or not a
        // session exists. Without a live agent it runs locally (and
        // creates none; its fallback path goes through the deferred-start
        // gate instead, so an unknown "sessionless" command that creates a
        // session still carries the final session id). With a live agent
        // it dispatches through the session's command service, but the
        // persist closure still supplies undefined.
        if (liveAgent === undefined) {
          runLocalCommand(parsed, text, persistHistory)
        } else {
          dispatchViaSession(text, () => persistHistory(historySessionIdFor('sessionless', liveAgent?.session.id)))
        }
        return
      }
      // Busy-Enter preference (web busyEnter parity): while the agent is
      // RUNNING and the preference is 'steer', agent-facing input steers
      // into the running turn — plain prompts AND non-local commands. The
      // per-skill slash commands steer as their raw `/name` line, which the
      // host's pre-step listener resolves into the injected skill body
      // (dsh-tool-skill) — exactly like the web's `session.prompt`, which
      // has no command-execution wire for skills. TUI-owned LOCAL commands
      // (/status, /settings, ...) always execute directly; plugin-declared
      // local commands (M5 CommandBridge) join the same set; `!` shells and
      // sessionless commands returned before this gate.
      if (shouldSteerOnEnter(parsed, liveAgent?.status === 'running', tuiSettings?.get().busyEnter, forceQueue,
        // M5: the CommandBridge's effective-local check (dynamic plugin
        // local commands are local while registered).
        name => extensionService?.commands.isLocal(name, LOCAL_COMMANDS) ?? false)) {
        // An explicit `/skill <name>` invocation steers its NORMALIZED
        // `/<name> <args>` line — the harness gesture recognizes the
        // skill's own slash name and injects its body; the raw `/skill
        // <name>` form would never match (review finding 2). Image
        // placeholders ride the normalized line untouched. The history
        // row is written inside steerNow AFTER the session exists (the
        // deferred-start gate), with the FINAL session id.
        steerNow(normalizeSkillInvocation(text) ?? text, true, persistHistory)
        return
      }
      dispatchViaSession(text, persistHistory)
    }
    // M3 runner wiring (F-1): when the extension host service is mounted,
    // the TUI surface attaches a SurfaceHost over its ledger — extensions
    // (including the first-party builtins) render into the chrome. Without
    // the service the surface runs exactly as before (host fallbacks).
    extensionService = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as typeof extensionService
    if (extensionService !== undefined) {
      extensionHost = new SurfaceHost(extensionService._ledger(), () => app.requestRender())
      // Selected-plugin-theme fallback (the review's P2): when the theme
      // currently applied unloads (HMR), the host must restore the
      // builtin dark palette — the registry alone only removes the
      // record and repaints, leaving the dead plugin's palette on screen.
      // The hook is keyed on the SOURCE-QUALIFIED selectable value (the
      // same identity applyPluginPalette records — the review's P2: a
      // bare name shared the file namespace and could collide). The
      // GENERATION-LEASED release is stored so THIS runner's HMR cleanup
      // releases only its own hook (never a newer generation's).
      releaseThemeUnloadedHook = extensionService.setThemeUnloadedHook(({ selectableValue }) => {
        if (app.activePluginTheme() === selectableValue) {
          app.clearActivePluginTheme()
          app.applyTheme('dark')
          app.trackTerminalTheme(false)
        }
      })
    }
    // The durable-image loader (plan M8/M10): history images resolve through
    // `ctx.attachments.readImage` only — never the draft store. The read
    // callback is a late-bound service access (AGENTS.md: never a bare
    // property read of a non-injected service).
    const imageLoader = new ImageLoader((ref) => {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new ImageLoadError('Image attachments are unavailable in this deployment.')
      }
      return attachments.readImage(ref as never) as Promise<{ ref: unknown; data: Uint8Array }>
    })
    /** The clipboard bridge (plan M3): a bounded execFile runner with a
     * generous buffer (clipboard payloads can be multi-MB); `input` is
     * piped to the child's stdin (issue #7 — the copy helpers read their
     * payload from stdin). */
    const runClipboardCommand = createClipboardRunner()
    const clipboardEnv: ClipboardEnvironment = {
      platform: process.platform,
      env: process.env as Record<string, string | undefined>,
      // PATH-aware helper detection — a bare existsSync only checks the
      // CWD and would declare installed wl-paste/xclip "missing" (review
      // finding).
      exists: (command) => commandOnPath(command, process.env.PATH, process.platform),
    }
    /** Issue #7: the copy policy's executor — the same bounded execFile
     * runner as the paste probe, with the text payload piped to stdin. */
    const runCopyCommand: CopyExecutor = (command, args, input) =>
      runClipboardCommand(command, args, { timeoutMs: 2000, input }).then(result => ({ code: result.code }))
    /** Issue #7: the copy policy's platform facts — the paste probe's
     * environment plus the OSC 52 best-effort sink (a TTY-gated write;
     * inside tmux the sequence rides a DCS passthrough so the terminal
     * behind tmux receives it — kimi-code convention). */
    const copyEnv: CopyEnvironment = {
      platform: clipboardEnv.platform,
      env: clipboardEnv.env,
      exists: clipboardEnv.exists,
      isTTY: () => process.stdout.isTTY === true,
      writeOsc52: (text) => process.stdout.write(buildOsc52Sequence(text, (process.env.TMUX ?? '').length > 0)),
    }
    // The TUI is about to mount: the pre-mount status line must be gone
    // before the first frame (no stale scrollback line after mount).
    startupStatus.clear()
    app = startProcessTui({
      onSubmit: (text) => dispatchUserInput(text),
      // The image-only submit gate (plan §11.1): an empty-text draft with
      // staged images is a real submission.
      isImageDraft: () => draftHasImages(app.getDraft(), draftImages),
      // The in-process EDITOR history must never recall a multimodal line
      // after its drafts were consumed — the placeholders would re-send as
      // plain text (the persisted JSONL history has the same guard; review
      // finding: the memory side was missing it).
      shouldRememberInput: (text) => !draftHasImages(text, draftImages),
      // Ctrl+V (plan M3): probe the clipboard ONCE per paste — an image
      // lands as a draft placeholder, plain text as an editor insert,
      // unsupported/empty silently (a text paste must never error).
      onClipboardPaste: () => {
        // The clipboard probe is ASYNC: capture the session identity and
        // discard the result if the user switched sessions meanwhile — a
        // late paste must never stage into the NEW session's draft
        // (round-5 finding 2).
        const pasteGeneration = sessionGeneration
        runOwned('clipboard paste', () => readClipboardImage(runClipboardCommand, clipboardEnv).then((result) => {
          if (sessionGeneration !== pasteGeneration) return
          if (result.kind === 'image') {
            // Attach-time prune (review finding 2): placeholders deleted or
            // Ctrl+C-cleared since the last attach must not hold their
            // bytes until the store fills up.
            pruneUnreferencedDrafts(app.getDraft(), draftImages)
            const limits = ctx.get('attachments')?.imageLimits
            if (limits !== undefined) {
              checkImageLimits(
                { mediaType: result.mediaType, width: result.width, height: result.height },
                result.bytes.byteLength,
                limits as Parameters<typeof checkImageLimits>[2],
              )
            }
            const draft = draftImages.add({
              bytes: result.bytes,
              mediaType: result.mediaType,
              width: result.width,
              height: result.height,
              source: { type: 'clipboard' },
            })
            app.insertIntoEditor(`${draft.placeholder} `)
            app.notify(`attached ${draft.placeholder} — Enter to send`)
          } else if (result.kind === 'text' && result.text !== '') {
            app.insertIntoEditor(result.text)
          }
        }), {
          diag,
          sessionId: () => liveAgent?.session.id,
          onError: (error) => app.notify(safeErrorMessage(error), 'error'),
        })
      },
      // The Ctrl+Enter opposite chord (web busyEnter parity): force the
      // QUEUE delivery mode regardless of the busyEnter preference.
      onQueueSubmit: (input) => dispatchUserInput(input, true),
      // The owned-task entry for UI-layer one-shot flows (the external
      // editor): runOwned with the runner's diag pre-attached.
      runOwned: <T>(label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => {
        runOwned(label, task, { ...options, diag, sessionId: () => liveAgent?.session.id })
      },
      onExit: () => {
        // Ctrl+C / Ctrl+D route through the SAME exit orchestration as
        // /exit and /quit (createExitController above): flush with a hard
        // timeout, idempotent cleanup, warning, resume hint, process exit.
        requestExit()
      },
      onCancel: () => {
        // Esc cancel: abort a running `!` shell command, then interrupt the
        // live agent (busy: one Esc fires this directly; idle: double-Esc).
        // interruptAgent PRESERVES the pending queue (web Stop parity) — an
        // interrupt stops the current thinking, never the queued input.
        localShellController?.abort()
        interruptAgent(liveAgent, backend.sessionWriter)
      },
      // Conversation rewind: the TuiApp fires this only when IDLE with an
      // EMPTY editor and a fast second Esc (busy stays a cancel; overlays,
      // autocomplete and replacement editors keep their own Esc). The SAME
      // surface as `/rewind` — one implementation, two entries.
      onRewind: () => openRewindPicker(),
      // M6: execute a plugin keybinding's SEMANTIC action through the
      // host's own paths (plan §2.2 — the host never lets a plugin bypass
      // submission/session safety).
      onExtensionAction: (action) => {
        // VIEWER CAPABILITY GATE: while a subagent viewer is open (either
        // mode), semantic actions with PARENT-session side effects are
        // blocked — the viewer's input must never interrupt/steer/queue/
        // reconfigure the parent (a plugin keybinding reaching this runner
        // is the ONLY path that could, since the raw-key viewer guard
        // already consumes the parent chords). submit-draft/queue-draft
        // route to the CHILD through the viewer-aware submitDraft (a
        // one-shot viewer hard-rejects them), toggle-fullscreen is
        // surface-local; every other action is consumed as a no-op.
        if (viewing !== undefined && !viewerActionCapability(action, { mode: viewing.mode })) {
          return
        }
        switch (action) {
          case 'submit-draft': {
            // Host-owned submit path: history + notify clear + draft
            // clear, exactly like a normal Enter (round-1 P2).
            app.submitDraft(false)
            break
          }
          case 'queue-draft': {
            app.submitDraft(true)
            break
          }
          case 'steer-draft': {
            const text = app.getDraft()
            // The steered draft is an agent-facing submission: the
            // snapshot (ts + image check) happens BEFORE the draft is
            // cleared, and the row is written inside steerNow AFTER the
            // session exists (the deferred-start gate) with the FINAL
            // session id.
            const persist = makeSteerPersist(text)
            app.setDraft('')
            steerNow(text, false, persist)
            break
          }
          case 'cancel-activity': {
            localShellController?.abort()
            interruptAgent(liveAgent, backend.sessionWriter)
            break
          }
          case 'open-search': {
            app.startTranscriptSearch()
            break
          }
          case 'toggle-fullscreen': {
            app.setFullscreen(!app.isFullscreen())
            break
          }
          case 'cycle-permission': {
            if (liveAgent === undefined) break
            const permission = ctx.get('permissionPresets')
            if (permission === undefined) break
            const names = permission.names
            if (names.length === 0) break
            const current = (permission as { current(session: unknown): string }).current(liveAgent.session)
            const index = names.indexOf(current)
            const next = names[(index + 1) % names.length] ?? names[0]
            if (next === undefined || next === current) break
            permission.set(liveAgent.session, next)
            app.notify(next === 'danger-full-access'
              ? `⚠ ${next} — no approvals`
              : `permission: ${next}`,
            next === 'danger-full-access' ? 'error' : 'info')
            refreshStatusCheap()
            break
          }
        }
      },
      onSteer: (text) => {
        // Ctrl+S: the steered draft is an agent-facing submission — the
        // snapshot happens now, and the row is written inside steerNow
        // AFTER the session exists (the deferred-start gate) with the
        // FINAL session id.
        steerNow(text, false, makeSteerPersist(text))
      },
      onExtensionError: ({ slot, id, error }) => {
        try {
          const ref = extensionService?._recordRegistryHealthRef(slot, id)
          if (ref !== undefined) extensionService?._recordRegistryError(ref, error)
        } catch {}
      },
      onExtensionRecovered: ({ slot, id }) => {
        try {
          const ref = extensionService?._recordRegistryHealthRef(slot, id)
          if (ref !== undefined) extensionService?._clearRegistryError(ref)
        } catch {}
      },
      // The session presentation title changed (advanced ui.host.setTitle,
      // session/title events — the app fires it for EVERY setSessionTitle):
      // the terminal window title policy follows, so a rename/regenerate
      // refreshes the OSC title immediately.
      onTitleChanged: () => refreshTerminalTitle(),
      // Terminal focus reports (CSI ? 1004): the completion-notification
      // focus tracker observes them. The report is consumed host-side in
      // regular mode and passes through in fullscreen (the viewport
      // listener owns FOCUS_OUT's selection cleanup), so the tracker
      // only records state.
      onTerminalFocus: (focused) => {
        terminalFocusTracker.handleFocusReport(focused ? FOCUS_IN_SEQUENCE : FOCUS_OUT_SEQUENCE)
        completionController.setFocus(terminalFocusTracker.state)
      },
      // Any REAL input (not a focus report) proves the user is operating
      // the terminal: restore the tracker to 'focused' (a missed FOCUS_IN
      // must never leave an 'unfocused' tracker that would falsely notify
      // while the user watches).
      onUserInput: () => {
        terminalFocusTracker.markFocused()
        completionController.setFocus(terminalFocusTracker.state)
      },
      // Phase 4: the advanced host-state setTheme for a NON-built-in name
      // (a registered plugin theme). The runner resolves the palette
      // through the theme registry; unknown names are a no-op; a throwing
      // palette is recorded in the theme health slot. The path is
      // NAME-addressed (the documented Phase-4 contract), so the runner
      // maps the NAME to its SOURCE-QUALIFIED selectable value FIRST
      // (the review's P2: the value is what gets applied, persisted and
      // health-tracked — a bare name can never be a selection identity).
      onAdvancedSetTheme: (name) => {
        const selectable = extensionService?.themes.selectableValueForName(name)
        if (selectable === undefined) return
        const palette = extensionService?.themes.paletteForSelectable(selectable)
        if (palette === undefined) return
        // VALUE-addressed (the unified theme protocol).
        const themeRef = extensionService?._recordRegistryHealthRef('theme', selectable)
        try {
          app.applyPluginPalette(selectable, palette)
          if (themeRef !== undefined) extensionService?._clearRegistryError(themeRef)
        } catch (error) {
          if (themeRef !== undefined) extensionService?._recordRegistryError(themeRef, error)
          app.notify(`theme ${name} failed: ${safeErrorMessage(error)}`, 'error')
        }
      },
      openExternalEditor: async (draft) => {
        // $VISUAL/$EDITOR may carry arguments (`code --wait`, `vim -f`):
        // parse with a real shell-word parser, never a plain split.
        const words = parseShellWords(process.env.VISUAL ?? process.env.EDITOR ?? 'vi')
        const [editor, ...editorArgs] = words
        if (editor === undefined) throw new Error('empty editor command')
        const file = join(tmpdir(), `dsh-pi-tui-${process.pid}-${randomUUID()}.md`)
        writeFileSync(file, draft, { mode: 0o600 })
        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(editor, [...editorArgs, file], { stdio: 'inherit' })
            // A settled latch: `error` and `close` can both fire; the first
            // outcome wins, exactly like the local-shell cards.
            let settled = false
            const finish = (error?: Error): void => {
              if (settled) return
              settled = true
              if (error !== undefined) reject(error)
              else resolve()
            }
            child.on('error', (error) => finish(error))
            child.on('close', (code, childSignal) => {
              // Only a successful editor run may produce the draft: a
              // non-zero exit or a signal kill means the file is whatever
              // the editor left behind, not a deliberate edit.
              if (code === 0) {
                finish()
              } else if (childSignal !== null) {
                finish(new Error(`${editor} was killed by signal ${childSignal}`))
              } else {
                finish(new Error(`${editor} exited with code ${code}`))
              }
            })
          })
          // Read ONLY after the editor finished successfully (close, code 0).
          return readFileSync(file, 'utf8')
        } finally {
          // Cleanup runs on EVERY path, including a failed read.
          rmSync(file, { force: true })
        }
      },
      // Virtual history boundaries preserve the rendered overlap anchor;
      // paging changes only the presentation window, never the fold.
      onTranscriptMoveOlder: () => {
        const anchor = app.captureTranscriptViewportAnchor()
        const controller = activeWindow()
        if (!controller.moveOlder()) return false
        repaint(app, activeFolder(), controller)
        // Preserve the old top edge at the same rendered row in the overlap.
        if (anchor === undefined) app.scrollToBottom({ disableFollow: true })
        else app.restoreTranscriptViewportAnchor(anchor, 'top')
        return true
      },
      // Ctrl+Up / Ctrl+Down in fullscreen: single-turn prompt navigation
      // over the virtual window (the fork's OSC 133 scan finds nothing in
      // DSH transcripts — the semantic turn list lives HERE).
      onTranscriptTurnOlder: () => {
        if (!app.isFullscreen()) return false
        const controller = activeWindow()
        if (!controller.turnOlder()) return false
        repaint(app, activeFolder(), controller)
        app.scrollToBottom({ disableFollow: true })
        return true
      },
      onTranscriptTurnNewer: () => {
        if (!app.isFullscreen()) return false
        const controller = activeWindow()
        if (!controller.turnNewer()) return false
        repaint(app, activeFolder(), controller)
        app.scrollToBottom({ disableFollow: true })
        return true
      },
      onTranscriptMoveNewer: () => {
        const anchor = app.captureTranscriptViewportAnchor()
        const controller = activeWindow()
        if (!controller.moveNewer()) return false
        repaint(app, activeFolder(), controller)
        if (controller.isLatest()) app.scrollToBottom()
        else if (anchor === undefined) app.scrollToTop({ disableFollow: true })
        else app.restoreTranscriptViewportAnchor(anchor, 'bottom')
        return true
      },
      onTranscriptJumpLatest: () => {
        // Ctrl+End is a fullscreen transcript action. In regular mode it must
        // fall through so the editor retains its own Ctrl+End behavior.
        if (!app.isFullscreen()) return false
        // Ctrl+End is a semantic reset, not merely a viewport scroll. Clear
        // the search origin before closing the overlay so its close callback
        // cannot restore the historical anchor we are explicitly leaving.
        searchOrigin = undefined
        resetSearchState()
        const closedSearch = app.closeTranscriptSearch()
        const controller = activeWindow()
        const changed = controller.latest()
        if (!changed && !closedSearch && !app.isFullscreen()) return false
        repaint(app, activeFolder(), controller)
        app.scrollToBottom()
        app.setSearchResult(0, 0)
        return true
      },
      onFullscreenChange: (fullscreen) => {
        const settings = tuiSettings
        if (settings !== undefined) {
          runDetached('settings fullscreen write', () => serializeTuiSettingsMutation(
             settings,
             () => settings.replace({ ...settings.get(), footerCustomItems: userFooterCustomItemsForSave(), fullscreen: fullscreen ? 'on' : 'off' }),
           ), {
            diag,
            notify: (message) => app.notify(message, 'error'),
            recoverable: () => true,
          })
        }
      },
      // Transcript search: matches run over the FULL folded
      // transcript (lightweight indexed projection — never a full
      // materialization); each jump re-windows the view so the matched turn
      // is visible (older turns collapse above it into the summary entry).
      onSearchOpen: () => {
        const controller = activeWindow()
        searchOrigin = { controller, state: controller.state() }
      },
      onSearchQuery: (query) => {
        const folder = activeFolder()
        // Prefix refinement reuses the previous candidate set only when the
        // query EXTENDS it on the SAME folder; the folder itself also
        // requires an unchanged projection revision (a live append or group
        // reflow between queries invalidates the candidates).
        searchMatches = folder.search(query, lastSearchQuery !== '' && folder === lastSearchFolder
          ? { previousQuery: lastSearchQuery, previousMatches: searchMatches, revision: lastSearchRevision }
          : undefined)
        lastSearchQuery = query
        lastSearchRevision = folder.searchRevision()
        lastSearchFolder = folder
        searchCurrent = searchMatches.length > 0 ? 0 : -1
        app.setSearchResult(searchCurrent + 1, searchMatches.length)
        if (searchCurrent >= 0) jumpToSearchMatch()
      },
      onSearchNext: () => {
        // PR D1 P1: refresh BEFORE stepping — an empty candidate list
        // still refreshes (a match that arrived while the overlay stayed
        // open must be discoverable), and the step is computed on the
        // REFRESHED list. The policy lives in steppedSearchOverlayState,
        // shared by both handlers.
        const folder = activeFolder()
        const stepped = steppedSearchOverlayState(
          { matches: searchMatches, current: searchCurrent, query: lastSearchQuery, revision: lastSearchRevision, folder: lastSearchFolder },
          folder,
          1,
        )
        searchMatches = stepped.matches
        searchCurrent = stepped.current
        lastSearchRevision = stepped.revision
        lastSearchFolder = folder
        app.setSearchResult(searchCurrent + 1, searchMatches.length)
        if (stepped.current < 0) return
        jumpToSearchMatch()
      },
      onSearchPrev: () => {
        const folder = activeFolder()
        const stepped = steppedSearchOverlayState(
          { matches: searchMatches, current: searchCurrent, query: lastSearchQuery, revision: lastSearchRevision, folder: lastSearchFolder },
          folder,
          -1,
        )
        searchMatches = stepped.matches
        searchCurrent = stepped.current
        lastSearchRevision = stepped.revision
        lastSearchFolder = folder
        app.setSearchResult(searchCurrent + 1, searchMatches.length)
        if (stepped.current < 0) return
        jumpToSearchMatch()
      },
      onSearchClose: () => {
        resetSearchState()
        const origin = searchOrigin
        searchOrigin = undefined
        const controller = activeWindow()
        if (origin?.controller === controller && origin.state.mode === 'history' && origin.state.endTurn !== undefined) {
          controller.anchorAt(origin.state.endTurn)
        } else {
          controller.latest()
        }
        repaint(app, activeFolder(), controller)
        if (controller.isLatest()) app.scrollToBottom()
        else app.scrollToTop({ disableFollow: true })
      },
      // P7d: a single Esc with no overlay up exits the subagent viewer
      // instead of arming the double-Esc cancel.
      onSingleEscape: () => exitView(),
      // Shift+Tab: cycle the permission preset through the composed table
      // (read-only → workspace-write → danger-full-access). The switch goes
      // through the official service (sandbox + approval + preset log in one
      // call, no transcript card), with a red warning only on the no-approval
      // preset (plain switches notify in the dim info style) and an immediate
      // footer refresh.
      onCyclePermission: () => {
        if (liveAgent === undefined) return
        const permission = ctx.get('permissionPresets')
        if (permission === undefined) return
        const names = permission.names
        if (names.length === 0) return
        const current = (permission as { current(session: unknown): string }).current(liveAgent.session)
        const index = names.indexOf(current)
        const next = names[(index + 1) % names.length] ?? names[0]
        if (next === undefined || next === current) return
        permission.set(liveAgent.session, next)
        app.notify(next === 'danger-full-access'
          ? `⚠ ${next} — no approvals`
          : `permission: ${next}`,
        next === 'danger-full-access' ? 'error' : 'info')
        refreshStatusCheap()
      },
      // Alt+↑: pull every QUEUED USER message back into the editor draft
      // (pi's dequeue). Only user-origin rows are the user's own input —
      // notices, subagent-report relays, injected instructions and goal
      // messages stay in the inbox: pulling one back and resubmitting it as
      // plain text would drop its provenance and turn a background
      // notification into an editable user message. The current draft rides
      // along below the pulled-back queue.
      onDequeue: () => {
        if (liveAgent === undefined) return
        const queued = [...liveAgent.inbox.nextTurn, ...liveAgent.inbox.nextStep]
          .filter(message => isUserQueueInput(message.source as QueueNoticeSource | undefined))
        if (queued.length === 0) return
        // Multimodal queued messages (durable ImageBlocks) ARE pullable:
        // each image block becomes a RECALLED draft — a placeholder that
        // reuses the already-durable ImageAttachmentRef, so re-submitting
        // never re-uploads the bytes. The queue is spliced ONLY after the
        // drafts are staged (a failure keeps the queue intact).
        let recalledText = ''
        const staged: number[] = []
        try {
          const lines: string[] = []
          for (const message of queued) {
            const parts: string[] = []
            for (const block of message.content) {
              if (block.type === 'text') {
                parts.push(block.text)
              } else if (block.type === 'image') {
                const attachment = block.attachment as import('./image/admission.ts').ImageAttachmentRefLike
                const draft = draftImages.add({
                  mediaType: attachment.mediaType,
                  width: attachment.width,
                  height: attachment.height,
                  ...(attachment.name !== undefined ? { name: attachment.name } : {}),
                  source: { type: 'recalled' },
                  recalledRef: attachment,
                })
                staged.push(draft.id)
                parts.push(draft.placeholder)
              }
            }
            lines.push(parts.join(''))
          }
          recalledText = lines.join('\n\n')
        } catch (error) {
          // The recalled drafts could not be staged (capacity): roll back
          // the drafts staged so far and keep the queue fully intact —
          // nothing removed, no capacity leaked (follow-up finding).
          for (const id of staged) draftImages.remove(id)
          app.notify(safeErrorMessage(error), 'error')
          return
        }
        // Remove exactly the pulled-back messages (durable splice), keeping
        // any notices queued behind them.
        for (const message of queued) backend.sessionWriter.dequeue(liveAgent.session.id, message.id)
        const current = app.getDraft()
        app.setDraft([recalledText, current].filter(part => part.trim() !== '').join('\n\n'))
        refreshQueue()
      },
      // ↓ with an empty editor: the Quick Tasks browser over BOTH
      // background surfaces. Job rows (bash + background one-shot subagent
      // jobs) are status-only: the bash output read cursor belongs to the
      // model's job_output and a subagent job record carries no child
      // session id, so Enter opens the status viewer (never the output).
      // Subagent rows (live children from the subagent registry) deliver no
      // result to the parent, so Enter opens the child transcript directly:
      // continuable children always, and one-shot children while RUNNING (a
      // foreground delegation is the parent's pending tool call, so the
      // trigger would otherwise look dead). A running BACKGROUND one-shot
      // appears twice — its job row and its child row — because the two
      // records have no cross-reference to dedup; the viewable child row is
      // the more useful one. The children half enriches asynchronously:
      // listChildren may read persistence for cold children, so the picker
      // opens on the jobs half and setItems merges the rest in.
      //
      // The SAME browser is the `/tasks` surface (runner.openTasksBrowser):
      // the merged list + search is the single command-side entry, with
      // row-level `S` = confirmed Stop on capable rows (kimi's stop-on-row
      // pattern; the old /subagents SettingsList-submenu panel is gone).
      onOpenTasks: () => openTasksBrowser('quick'),
      // Enter in an INTERACTIVE (continuable) subagent viewer: deliver the
      // human prompt through the OFFICIAL ctx.subagents.prompt control
      // API — the child inbox (a distinct FIFO turn: enqueue while
      // running, wake while waiting, cold resume when absent), with Host
      // authority over the exact live parent and official user
      // provenance/requestId. NEVER `subagents.sendMessage` (the
      // Agent-authored Steer path) and never the parent's
      // submit/steer/queue path. The app already cleared the child draft;
      // a rejection restores it (merged) into the child's own draft slot.
      onSubagentSubmit: (submit) => {
        const viewerGeneration = app.getViewerGeneration()
        // The viewer editor's text becomes the prompt's content parts at
        // the client boundary (text today; image parts join with the
        // viewer's image intake).
        const request: SubagentViewerSubmitRequest = {
          parentSessionId: submit.parentSessionId,
          childSessionId: submit.childSessionId,
          content: [{ type: 'text', text: submit.text }],
        }
        runOwned('subagent prompt', () => backend.subagent.prompt(request, {
          // The caller signal owns lookup/materialization/admission only
          // until inbox acceptance (the official prompt contract): a TUI
          // cleanup / exit, OR the viewer session ending (Esc / child
          // switch / session swap — viewerSessionAbort) cancels a send
          // that has NOT been accepted yet; once accepted the child owns
          // the message and no restore happens. Never a dropped controller
          // whose signal can never fire.
          makeSignal: () => viewerSessionAbort === undefined
            ? lifecycleController.signal
            : AbortSignal.any([lifecycleController.signal, viewerSessionAbort.signal]),
          // Same `@`-file mention canonicalization as the main session's
          // submissions (the editor keeps `@src/foo.ts`, the child model
          // receives the absolute path). The scope is the VIEWED CHILD's
          // workspace when the viewer knows it (the child may have been
          // born in another directory — canonicalizing against the parent
          // cwd would rewrite the child's mentions to the wrong tree);
          // an unknown cold-child cwd falls back to the live parent.
          canonicalizeText: (text) => backend.hostFile.canonicalizeMentions(
            viewerCanonicalizeScope(viewing?.cwd, liveAgent?.session.id),
            text,
          ),
        }), {
          diag,
          sessionId: () => liveAgent?.session.id,
          onResult: (outcome) => settleSubagentSubmit(request, submit.text, outcome, viewerGeneration),
          onError: (error) => settleSubagentSubmit(
            request,
            submit.text,
            { kind: 'rejected', reason: { kind: 'error', message: safeErrorMessage(error) } },
            viewerGeneration,
          ),
        })
      },
    }, {
      // Ctrl+R input-history search: the runner owns the IO (the file-backed
      // source + the known-cwd identity map), the surface owns the panel
      // lifecycle (plan §27 — TuiApp never touches the filesystem).
      historySearchSource: new FileHistorySearchSource({
        dshHome: dshHome(process.env),
        // A RESOLVER, not a snapshot: the all-scope search must see the
        // newest known cwds (sessions created/switched after startup).
        knownCwds: () => knownHistoryCwds(),
      }),
      historySearchCwd: () => sessionCwd(),
      // The session scope's identity — a GETTER like the cwd: a session
      // switch must make the next Ctrl+R search the NEW session (the
      // panel captures it once at open time).
      historySearchSessionId: () => liveAgent?.session.id,
      // The transcript image surface (plan M8/M9): the durable loader plus
      // the dim fallback coloring.
      imageLoader,
      imageTheme: { fallbackColor: color.textDim },
      present,
      workspaceRoot: cwd,
      // The structural icon palette: read ONCE at startup from the
      // persisted document; runtime switches go through app.setIconStyle
      // (the /settings write path) — never a deep settings read per render.
      iconStyle: iconStyleOf(tuiSettings?.get().iconStyle),
      extensionHost,
      // M0: the unified status projection store (the app projects its own
      // surface state into it; the runner derives the DSH-owned sections).
      statusStore,
      // M5: a material width change refreshes the command surface (the
      // runner coalesces to its interval).
      onTerminalResize: () => footerCommandRunner?.requestRefresh(),
      // Issue #7: the fullscreen drag selection copies through the SAME
      // shared policy as /copy (tmux → platform helper → OSC 52) — a bare
      // OSC 52 write is a silent lie under tmux `set-clipboard external`.
      copySelection: (text) => copyToClipboard(text, runCopyCommand, copyEnv),
      // Fullscreen OSC 8 link clicks + the Windows right-click paste: the
      // alt screen's mouse capture swallows both native behaviors, so the
      // host opens http/https links itself and reads the clipboard through
      // the same platform-aware policy as the image paste probe.
      openExternalUrl: (url) => openExternalUrl(url),
      readClipboardText: () => readClipboardText(runClipboardCommand, clipboardEnv),
      // M7: the transcript/tool renderer registry. Renderer failures are
      // isolated per contribution (the registry catches throws and the
      // host falls back); the health sink records them for /status.
      renderers: extensionService?.renderers,
      // M9 (round-1 finding 1): the editor registry MUST reach TuiApp —
      // without it the SDK is inert (reconcileEditorWinner never fires).
      editorRegistry: extensionService?.editors,
      // M6: non-capturing plugin keybindings. The resolver reads the
      // extensionService LAZILY (it is fetched below the app construction)
      // and normalizes through the InputRouter — a plugin binding resolves
      // against normalized keys only, never raw terminal data. Reserved
      // host lifecycle keys are rejected by the registry at register time
      // and handled by the host ladder before this stage.
      pluginActionFor: (normalized) => {
        // The InputRouter has already normalized the raw input and applied
        // the reserved-key + printable guards; this resolver only maps the
        // NORMALIZED key to a plugin semantic action.
        const keybindings = extensionService?.keybindings
        if (keybindings === undefined) return undefined
        return keybindings.actionFor(normalized)
      },
      pluginActionIdFor: (normalized) => extensionService?.keybindings.idFor(normalized),
      // Phase 2: the ADVANCED normalized input capture route. The host
      // input path consults it AFTER its own capturing flows (questions,
      // approvals, overlays) and reserved lifecycle keys, and BEFORE the
      // editor and the Stable keybindings — an advanced plugin can preempt
      // ordinary editor/panel input, never a Host question/approval/overlay
      // or a fatal-recovery shortcut (session safety stays Host-owned).
      advancedInputRoute: (data) => extensionService?._advancedInputRoute(data) ?? 'passed',
      // Phase 3: the UNSTABLE raw input route — consulted BEFORE terminal
      // protocol decoding (a raw capture can see, consume or rewrite ANY
      // chunk). The emergency fail-safe is armed only while captures are
      // live and releases them all (Host recovery, not rewritable by the
      // Unstable API).
      unstableInputRoute: (data, surfaceId) => extensionService?._unstableInputRoute(data, surfaceId) ?? { action: 'pass' },
      unstableInputsLive: () => extensionService?._unstableInputsLive() ?? false,
      unstableInputsRevision: () => extensionService?._unstableInputsRevision() ?? 0,
      unstableFailSafeRelease: () => extensionService?._unstableEmergencyRelease(),
    })
    // M3: the user-orchestrable keybinding manager (the app built it with
    // the builtin defaults). Apply safe mode, the persisted user
    // overrides, and the plugin contributions — all fail-soft (a bad entry
    // is a diagnostic, never a startup failure; plan §16/§17).
    const keybindings = app.keybindingsManager()
    if (process.env.DSH_PI_TUI_SAFE_KEYBINDINGS === '1') {
      keybindings.setSafeMode(true)
      diag.info('keybindings', { safeMode: true })
    }
    const applyUserKeybindings = (): void => {
      // Fail-soft reload (review finding): a transient settings read
      // error must never abort the startup application — the failure is
      // a diagnostic. The catch is also the net for errors thrown AFTER
      // the rebuild succeeded: HostKeybindingManager.rebuild() is ordered
      // keymap-first, invalidate-last, so a throwing UI invalidation (a
      // startup-eager callback — the footerCommandRunner TDZ was exactly
      // this) leaves the NEW keymap active. The diagnostic must not claim
      // a last-known-good rollback that did not happen; /keybindings
      // reload re-applies from the document either way.
      try {
        const parsed = parseUserKeybindings(tuiSettings?.get().keybindings)
        for (const message of parsed.diagnostics) diag.warn('keybindings', { message })
        keybindings.setUserConfiguration(parsed)
      } catch (error: unknown) {
        diag.warn('keybindings', { error: String(error), message: 'keybindings startup apply failed — the error may come from the post-rebuild UI invalidation, so the keymap may already be rebuilt; /keybindings reload re-applies it' })
      }
    }
    applyUserKeybindings()
    // M3: the user keybindings reload seam is EXPLICIT — `/keybindings
    // reload` re-reads the settings document and re-validates/rebuilds the
    // keymap (plan §12/§16). There is deliberately NO automatic settings
    // watch here: a `watch(callback)` would be a Direct-only dependency —
    // the TuiSettingsConfig port is get/replace only, a future Remote
    // adapter cannot map a callback across the process boundary, and the
    // migration rule forbids callbacks across the wire (see
    // docs/client-server-migration.md). A settings edit takes effect after
    // `/keybindings reload`; the fail-soft parser above keeps the keymap's
    // last-known-good state on any read/parse error.
    // M2: the plugin contributions compile into the effective keymap at
    // the LOWEST priority (a Host action always wins). The runner syncs
    // the registry snapshot on every invalidation (the manager skips
    // unchanged rules, so the rebuild is cheap).
    const syncPluginKeybindings = (): void => {
      const registry = extensionService?.keybindings
      if (registry === undefined) return
      const snapshot = registry.snapshot()
      keybindings.setPluginRules(snapshot.bindings.map(binding => ({
        id: binding.id,
        action: binding.action,
        key: normalizedKeyToKeyId(binding.key),
      })))
    }
    syncPluginKeybindings()
    // M2 DYNAMIC LIFECYCLE (convergence finding): plugin bindings
    // registered AFTER mount — or unloaded — must resync the effective
    // keymap (the initial snapshot is not enough). Subscribe to the
    // registry's change notifications so every register/dispose
    // re-syncs; the subscription is disposed with the runner teardown.
    // The unsubscribe slot was hoisted before cleanup (TDZ guard).
    stopPluginKeybindingSync = extensionService?.keybindings?.subscribe(() => syncPluginKeybindings())
    /**
     * One follow-up send settled (plan §10/§11/§12):
     * - ACCEPTED: the child inbox owns the message — never restore the
     *   draft, never insert a fake transcript row; the child's OWN session
     *   events update the viewer transcript through the normal folding.
     *   Only a transient `sent` notice is shown, and only while the SAME
     *   child is still being viewed.
     * - REJECTED: the user's text must NEVER be lost. It is restored into
     *   the CHILD's own draft slot, merged with whatever the user typed
     *   while the request was in flight. The current surface is touched
     *   ONLY while the same child is still being viewed — a viewer
     *   closed/switched during the send restores into the OLD child's
     *   slot and never pollutes the new surface (the generation guard).
     */
    const settleSubagentSubmit = (
      request: SubagentViewerSubmitRequest,
      text: string,
      outcome: SubagentPromptOutcome,
      viewerGeneration: number,
    ): void => {
      // The viewer target is CURRENT only while the SAME child is still
      // being viewed AND the viewer generation is unchanged (a viewer
      // open/close/switch bumps it — a close → reopen of the SAME child
      // is therefore STALE) AND the parent session is still the one the
      // viewer was opened from. The shared pure decision keeps the
      // current/stale split unit-testable (test/subagent-viewer-submit).
      const settleTarget = resolveSubagentSettleTarget(request, {
        viewingChildId: viewing?.id,
        viewingLabel: viewing?.label,
        viewingParentSessionId: viewing?.parentSessionId,
        viewerGenerationAtSend: viewerGeneration,
        viewerGenerationNow: app.getViewerGeneration(),
        liveParentSessionId: liveAgent?.session.id,
      })
      if (outcome.kind === 'ok') {
        if (settleTarget.kind === 'current') {
          app.notify(`sent to ${settleTarget.label} — queued for the next turn`, 'info')
        }
        return
      }
      const reason = outcome.reason
      if (reason.kind === 'cancelled') {
        // Aborted before inbox acceptance: the message never entered the
        // child's inbox — restore. Current viewer session: visible merge;
        // stale viewer (closed/switched/reopened): map-only (never the
        // current surface).
        if (settleTarget.kind === 'current') {
          app.setEditorText(mergeDraft(app.getDraft(), text))
        } else {
          app.restoreSubagentDraft(request.childSessionId, text)
        }
        return
      }
      if (settleTarget.kind === 'stale') {
        app.restoreSubagentDraft(request.childSessionId, text)
        return
      }
      app.setEditorText(mergeDraft(app.getDraft(), text))
      app.notify(subagentPromptNotice(reason, settleTarget.label), 'error')
    }

    /** The user-facing reason for a rejected follow-up (plan §18). */
    const subagentPromptNotice = (reason: SubagentPromptReject, label: string): string => {
      switch (reason.kind) {
        case 'parent-unavailable': return 'Cannot send: parent session is no longer active'
        case 'stale-child': return 'Cannot continue this subagent'
        case 'unauthorized': return 'Cannot send: subagent ownership changed'
        case 'unavailable': return 'Subagent continuation is temporarily unavailable'
        case 'error': return `could not send to ${label}: ${reason.message}`
        case 'cancelled': return 'send cancelled — draft restored'
      }
    }

    // ↓ with an empty editor: the task browser over BOTH background
    // surfaces. Job rows (bash + background one-shot subagent jobs) are
    // status-only: the bash output read cursor belongs to the model's
    // job_output and a subagent job record carries no child session id, so
    // Enter opens the status viewer (never the output). Subagent rows (live
    // children from the subagent registry) deliver no result to the parent,
    // so Enter opens the child transcript directly: continuable children
    // always, and one-shot children while RUNNING (a foreground delegation
    // is the parent's pending tool call, so the trigger would otherwise
    // look dead). A running BACKGROUND one-shot appears twice — its job row
    // and its child row — because the two records have no cross-reference
    // to dedup; the viewable child row is the more useful one. The children
    // half enriches asynchronously: listChildren may read persistence for
    // cold children, so the picker opens on the CURRENT state and setItems
    // merges the fresh listing in.
    //
    // The SAME browser is the `/tasks` surface (runner.openTasksBrowser):
    // the merged list + search is the single command-side entry, with
    // row-level `S` = confirmed Stop on capable rows (the old /subagents
    // SettingsList submenu is gone).
    const openTasksBrowser = (viewMode: 'quick' | 'full' = 'full', restoreState?: TaskBrowserViewState): void => {
      if (liveAgent === undefined) return
      // The destructive-intent fence is captured at OPEN time: a Stop
      // confirmed later belongs to THIS surface's session. Comparing the
      // generation/session AT dispatch against values captured AT dispatch
      // (as in an earlier revision) could never fail — the intent must be
      // bound to the browser that hosted the confirmation (PR review P1).
      const browserGeneration = sessionGeneration
      const browserSession = liveAgent
      let jobSnapshots: ReturnType<NonNullable<typeof jobs>['list']> = []
      if (jobs !== undefined) {
        try {
          jobSnapshots = jobs.list(liveAgent)
        } catch {
          // The registry read is best-effort; the jobs half stays empty.
        }
      }
      // The trigger only fires while something is ACTIVE (jobs or live
      // children), so an empty jobs half is NOT an empty browser: the
      // children half enriches below. Never early-return on row count —
      // a children-only session would never open the browser. The row
      // identity source is the RUNNER-level `taskBrowserRows` (kept fresh
      // by every coordinator commit), so the select/action paths below
      // never contradict a runtime refresh that already repainted.
      //
      // FIRST FRAME: seed from the coordinator's CURRENT state instead of
      // flashing a jobs-only list — refreshRuntime() is synchronous, never
      // touches persistence, reuses the cached catalog and re-reads the
      // current jobs + registry statuses (activeTaskBrowser is not set
      // yet, so it only seeds taskBrowserRows + the badge). The badge and
      // the panel therefore agree from the first frame, and a FAILED fresh
      // listing below cannot leave a panel that contradicts the badge.
      // Without the runtime (no subagents service) the jobs-only fallback
      // applies.
      const runtime = taskRuntime
      if (runtime !== undefined) {
        runtime.refreshRuntime()
        taskBrowserRows = [...runtime.rows()]
      } else {
        taskBrowserRows = buildTaskRows(jobSnapshots, [])
      }
      const selectRow = (value: string): void => {
        const row = taskBrowserRows.find(candidate => candidate.value === value)
        if (row === undefined) return
        if (row.kind === 'subagent') {
          // The viewer target carries the row's OWN parent (plan §6.10:
          // childId + parentId + depth + mode + activity — never just
          // childId + mode). A nested row's durable parent is the exact
          // direct parent recorded by DSH; only a direct child falls back
          // to the browser root (the live main session).
          const parentSessionId = row.parentId !== '' ? row.parentId as SessionId : liveAgent?.session.id
          if (parentSessionId === undefined) return
          // The row carries the catalog MODE + projected activity + DEPTH:
          // the viewer target is pinned to them (continuable → interactive
          // editor only at depth 1, one-shot → read-only, depth > 1 →
          // nested read-only), and the follow-up write path to the exact
          // parent.
          runOwned('subagent view from tasks', () => enterView(
            row.childId as SessionId, row.label, row.mode, parentSessionId, row.activity, row.depth,
          ), {
            diag,
            sessionId: () => liveAgent?.session.id,
            onError: (error) => app.notify(`could not open the subagent view: ${safeErrorMessage(error)}`, 'error'),
          })
          return
        }
        openJobView(row.jobId)
      }
      const actionRow = (value: string, action: 'stop' | 'interrupt'): void => {
        // `interrupt` is accepted only for pre-refactor embedders. The
        // production panel emits `stop` after its confirmation dialog.
        if (action !== 'stop' && action !== 'interrupt') return
        const row = taskBrowserRows.find(candidate => candidate.value === value)
        if (row === undefined) return
        // The SURFACE fence: the user's destructive intent is bound to the
        // session that owned this browser when it opened. A session that
        // switched after the browser opened (or while a confirmation was
        // pending) must never be stopped by the stale confirmation — the
        // captured browser values, not the dispatch-time values, are the
        // comparison side that can actually fail.
        if (sessionGeneration !== browserGeneration || liveAgent !== browserSession) return
        if (row.kind === 'subagent') {
          if (!isSubagentRowInterruptible(row)) return
          // Re-read the live driver at confirmation time; the panel row is
          // only a snapshot and may have become idle since it was rendered.
          if (agents?.get(row.childId as SessionId)?.status !== 'running') return
          const service = ctx.get('subagents')
          if (service === undefined) {
            app.notify('subagent service unavailable', 'error')
            return
          }
          // The interrupt authority names the child's DURABLE DIRECT parent;
          // deep descendants must not be addressed through the main root.
          const interruptParent = subagentInterruptParent(row, browserSession.session.id) as SessionId
          try {
            service.interrupt(row.childId as SessionId, { kind: 'user', parentSessionId: interruptParent })
            app.notify(`stopping ${row.label}`, 'info')
          } catch (error) {
            app.notify(`could not stop ${row.label}: ${safeErrorMessage(error)}`, 'error')
          }
          return
        }
        // Job stop is capability-gated to an actually active current record.
        // Pass the live caller to the public registry API; no output/read
        // cursor is touched by the UI.
        if (jobs === undefined || !isActiveJobStatus(row.status)) return
        try {
          const current = jobs.get(row.jobId as JobId, browserSession)
          if (current === undefined || !isActiveJobStatus(current.status)) return
          const result = jobs.kill(row.jobId as JobId, browserSession, 'stopped from Task Center')
          app.notify(result === 'already-finished' ? `${row.label} already finished` : `stopping ${row.label}`, 'info')
        } catch (error) {
          app.notify(`could not stop ${row.label}: ${safeErrorMessage(error)}`, 'error')
        }
      }
      const initialScope = restoreState?.scope ?? (viewMode === 'quick' ? 'active' : 'all')
      const initialQuery = restoreState?.searchQuery ?? ''
      const initialSelected = restoreState?.selectedId === 'task:view-all' ? undefined : restoreState?.selectedId ?? undefined
      const initialPreferred = initialSelected
        ?? taskBrowserRows.find(row => row.kind === 'subagent' && row.activity === 'running')?.value
        ?? taskBrowserRows.find(row => row.kind === 'job' && isActiveJobStatus(row.status))?.value
      const handle = app.openTaskBrowser(
        taskPanelItems(taskBrowserRows),
        // Selection closes the overlay (the app closes it before invoking the
        // callback): drop the active-handle reference so a later runtime
        // refresh cannot repaint a closed browser.
        (value) => { activeTaskBrowser = undefined; selectRow(value) },
        () => {
          const current = activeTaskBrowser?.getViewState?.()
          activeTaskBrowser = undefined
          if (viewMode === 'full' && restoreState !== undefined) {
            // Esc from a promoted full view returns to Quick with the latest
            // shared context, not the state from the promotion moment.
            const state = current ?? quickTaskState ?? restoreState
            openTasksBrowser('quick', state)
          }
        },
        {
          header: 'Tasks',
          enableSearch: true,
          mode: viewMode,
          openedFrom: viewMode === 'full' && restoreState !== undefined ? 'quick' : 'command',
          scope: initialScope,
          typeFilter: restoreState?.typeFilter,
          initialQuery,
          initialSearchMode: restoreState?.searchMode,
          expandedIds: [...(restoreState?.expandedIds ?? [])],
          collapsedIds: [...(restoreState?.collapsedIds ?? [])],
          selectedId: initialSelected,
          preferredValue: initialPreferred,
          maxVisible: viewMode === 'quick' ? 8 : 18,
          loading: runtime !== undefined && taskBrowserRows.length === 0,
          groupLabels: true,
          onRefresh: () => {
            if (runtime === undefined) {
              refreshTasks()
              return
            }
            // Refresh state is SINGLE-OWNER: only the coordinator's
            // commitRefreshState (fenced by session key + request epoch)
            // may set loading/ready/stale on the presentation. The runner
            // must never touch setRefreshState directly — an unfenced
            // onError here could mark a NEW session's browser as failed
            // when the OLD session's listing rejects (PR review P1).
            runOwned('task browser descendants', () => runtime.refreshCatalog(), {
              diag,
              sessionId: () => liveAgent?.session.id,
            })
          },
          onViewFull: state => {
            activeTaskBrowser = undefined
            quickTaskState = state
            openTasksBrowser('full', state)
          },
          onStop: value => actionRow(value, 'stop'),
        },
      )
      activeTaskBrowser = handle
      if (runtime !== undefined) {
        // Opening either view acknowledges only failure rows the user can
        // ACTUALLY see: the open viewport (scroll window), never the whole
        // projection. A failure below the fold is not "seen" and keeps its
        // footer attention until the user scrolls it into view (PR review
        // M1). Quick's Active scope leaves terminal failures pending while
        // live work is present, so its badge remains useful.
        const visibleFailures = handle.viewportItems?.()
          .filter(item => item.attention === true)
          .map(item => item.value) ?? []
        if (visibleFailures.length > 0) runtime.acknowledge(visibleFailures)
      }
      // The open triggers a CATALOG refresh (membership may have drifted
      // since the last listing): the coordinator fences it against a
      // session switch and commits through the ACTIVE handle — a browser
      // closed while the listing is in flight is never repainted. The
      // body above is synchronous, so the `runtime` captured for the
      // first-frame seed is still the current coordinator. Refresh state
      // is single-owner: the coordinator's fenced commitRefreshState is
      // the ONLY path that sets loading/ready/stale (an unfenced onError
      // here could mark a new session's browser failed when an old
      // session's listing rejects — PR review P1).
      if (runtime !== undefined) {
        runOwned('task browser descendants', () => runtime.refreshCatalog(), {
          diag,
          sessionId: () => liveAgent?.session.id,
        })
      }
    }

    // M3: attach the extension host to the surface chrome once per
    // generation (F-1): the header/dock/footer merge extension content, and
    // the service's capability set + state bridge become live.
    if (extensionHost !== undefined && extensionService !== undefined) {
      // M7 (round-1 finding 3): renderer failures land in the extension
      // health ledger — observable via /status diagnostics, never
      // swallowed. Safe single-line message (no stack traces, hostile
      // toString handled — the plan's error policy §18).
      app.setRendererErrorSink(({ id, error, slot, owner }) => {
        const message = safeErrorMessage(error).replace(/\s+/g, ' ').slice(0, 200)
        const healthSlot = slot === 'tool' ? 'transcript.tool.renderer' : 'transcript.message.renderer'
        extensionService._ledger().recordError(healthSlot, id, owner, message)
      })
      // M7 (P1-08): a renderer that renders successfully after a failure
      // RECOVERS — clear its health record (the next failure starts a NEW
      // error generation).
      app.setRendererRecoveredSink(({ id, slot, owner }) => {
        const healthSlot = slot === 'tool' ? 'transcript.tool.renderer' : 'transcript.message.renderer'
        extensionService._ledger().clearError(healthSlot, id, owner)
      })
      // M8: the managed-overlay mount seam (plan §13.3) — the plugin
      // supplies an ExtensionView; the host compiles + mounts it through
      // its overlay broker (modal stacking, focus, migration, teardown).
      // The seam is SURFACE-scoped (P1-4): bound to THIS attachment's
      // surfaceId so a stale old-generation detach never unbinds a newer
      // surface's seam.
      extensionService.setOverlayMount(extensionHost.surfaceId, (view, options) => app.showExtensionOverlay(view, options))
      // Phase 2: the ADVANCED seams (plan §4/§8/§9) — interactive overlay
      // mounts and editor controls, both SURFACE-scoped like the stable
      // overlay seam (a stale old-generation detach never unbinds a newer
      // surface's seam).
      extensionService.setAdvancedOverlayMount(extensionHost.surfaceId, (component, options) =>
        app.showAdvancedInteractiveOverlay(component, options))
      extensionService.setAdvancedEditorSeam(extensionHost.surfaceId, app.advancedEditorControls())
      // Phase 4: the ADVANCED imperative UI seam (plan §4A/§4B) — the
      // broker reuses the host's own picker/question/notify infrastructure.
      extensionService.setAdvancedUiSeam(extensionHost.surfaceId, app.advancedUiBroker())
      // Phase 4: the ADVANCED host-state seam (plan §4D). The seam
      // DELEGATES to the app's host-state facade (single source of
      // truth); the app fires onAdvancedSetTheme for non-built-in theme
      // names and THIS handler resolves the palette through the theme
      // registry (a registered plugin theme; unknown names are a no-op).
      extensionService.setAdvancedHostSeam(extensionHost.surfaceId, {
        getTheme: () => app.advancedHostState().getTheme(),
        setTheme: (name) => app.advancedHostState().setTheme(name),
        setTitle: (title) => app.advancedHostState().setTitle(title),
        setWorkingMessage: (message) => app.advancedHostState().setWorkingMessage(message),
        setToolsExpanded: (expanded) => app.advancedHostState().setToolsExpanded(expanded),
      })
      // Phase 3: the UNSTABLE low-level surface seam (plan §10) — the
      // selected host surface capabilities for low-level plugins (never
      // TuiApp/screens/terminal). SURFACE-scoped like the other seams.
      extensionService.setUnstableSurfaceSeam(extensionHost.surfaceId, app.unstableSurfaceHandle())
      extensionHost.attach(
        { header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) },
        {
          surfaceId: extensionHost.surfaceId,
          generation: app.getSurfaceGeneration(),
          width: process.stdout.columns ?? 80,
          height: process.stdout.rows ?? 24,
          fullscreen: false,
          focusedSeat: 'editor',
          themeId: 'dark',
          themeRevision: 0,
        },
      )
      app.refreshChrome()
      const attached = extensionHost
      // P1-1: attach the surface's RENDER SINK to the extension service —
      // registry invalidations (register/unload/replace on commands,
      // themes, autocomplete, settings, keybindings, renderers, editors
      // and the ledger slots) flush through the service batcher into THIS
      // surface's render path, so a dynamic registration repaints without
      // any user input. The stale-detach lease protects a newer surface.
      extensionService.attachSurface(
        { subscribe: (listener) => attached.subscribeState(listener as never) },
        extensionHost.capabilitiesOf() as ReadonlySet<string>,
        // The attachment lease (P1): a stale detachSurface from an older
        // generation must not tear down THIS surface's bridge.
        attached.surfaceId,
        (force) => {
          // M2: registry invalidations (including plugin keybinding
          // register/unload) flush through the batcher into this callback
          // — sync the plugin rules into the effective keymap (a no-op
          // when unchanged), then repaint.
          syncPluginKeybindings()
          app.requestRender(force)
        },
      )
    }
    // (new installs default to 'on' — alt screen by default): boot applies
    // it FIRST so the alt screen owns the terminal input handler before any
    // theme query below targets "the active screen" — a query sent while the
    // main screen still owned input would have its reply swallowed by the
    // alt screen's OSC 11 consumer and time out, silently disabling `auto`.
    // Focus Mode's TUI projection is a persisted visual preference like
    // Home/End/fullscreen/theme: the app must reflect the RESTORED state
    // before the first frame — otherwise the system prompt would tell the
    // model the user cannot see the process while the UI still shows it in
    // full (review blocker: the two halves of Focus would split).
    app.setFocusMode(focusState.enabled)
    // Terminal focus reporting (CSI ? 1004) for the completion
    // notification policy: enabled at TUI mount, disabled in cleanup so
    // the mode never leaks into the shell after exit. The app already
    // passes the ESC[I/ESC[O reports through to the runner's tracker.
    // The guarded writer swallows a broken-stream error; a synchronous
    // throw is contained so a dead stdout can never fail the TUI mount.
    try {
      notificationWriter.write(ENABLE_FOCUS_REPORTING)
    } catch {
      // A broken stdout degrades the notification capability silently.
    }
    // Issue #9: the Home/End navigation preset is applied BEFORE the first
    // fullscreen frame so the first frame and later behavior agree (plan
    // §4.8); an invalid persisted value falls back to `viewport`.
    applyHomeEndKeyMode(homeEndKeysModeOf(tuiSettings?.get().homeEndKeys))
    // The wheel step is a constructor-time alt-screen option: hand the
    // preference to the app BEFORE the first fullscreen entry, or the
    // first alt screen would still scroll 1 line per wheel event (the
    // order matters — never apply after setFullscreen).
    app.setWheelScrollLines(wheelScrollLinesOf(tuiSettings?.get().wheelScrollLines))
    if (tuiSettings?.get().fullscreen === 'on') app.setFullscreen(true)
    const storedTheme = tuiSettings?.get().theme
    if (storedTheme === 'auto') {
      // Follow the terminal: query once at boot, then track scheme reports.
      // The boot query is detached: a terminal that never answers (or a
      // failure) must not crash the runner. The settled result applies only
      // while the preference is STILL auto — a boot-time detection must
      // never override a theme the user chose while the query was in flight.
      runDetached('theme autodetect', () => app.autoDetectTheme({
        shouldApply: () => tuiSettings?.get().theme === 'auto',
      }), { diag })
      app.onTerminalThemeChange((theme) => {
        if (tuiSettings?.get().theme === 'auto') app.applyTheme(theme)
      })
      // Ask for DSR 996 once: xterm-class terminals only start reporting
      // scheme changes after being queried.
      app.trackTerminalTheme(true)
    } else if (storedTheme === 'dark' || storedTheme === 'light') {
      app.applyTheme(storedTheme)
      app.trackTerminalTheme(false)
    } else if (storedTheme !== undefined && storedTheme !== '') {
      // Any non-builtin persisted theme. SOURCE-QUALIFIED resolution (the
      // review's P2): the persisted value is the identity — `file:<name>`
      // resolves the file, `plugin:<owner>/<id>` resolves the registry,
      // and the legacy `custom:<name>` / bare-name forms normalize to
      // `file:<name>` (existing documents keep working). A selection
      // whose source is gone (an unloaded plugin / deleted file) resolves
      // undefined and falls back to the built-in dark palette — never
      // silently to a same-named file (the M5 gate: selected theme unload
      // → built-in fallback).
      const qualified = normalizePersistedTheme(storedTheme)
      const selection = resolveThemeSelection(qualified, extensionService?.themes)
      // VALUE-addressed (the unified theme protocol).
      const themeRef = extensionService?._recordRegistryHealthRef('theme', qualified)
      if (selection !== undefined) {
        try {
          // A PLUGIN palette records the selection (the unload fallback
          // restores builtin dark when it disappears); a custom FILE
          // clears it.
          if (selection.kind === 'plugin') app.applyPluginPalette(selection.value, selection.palette)
          else {
            app.clearActivePluginTheme()
            app.applyPalette(selection.palette)
          }
          if (selection.kind === 'plugin' && themeRef !== undefined) extensionService?._clearRegistryError(themeRef)
        } catch (error) {
          if (themeRef !== undefined) extensionService?._recordRegistryError(themeRef, error)
          app.notify(`theme ${storedTheme} failed: ${safeErrorMessage(error)}`, 'error')
        }
      } else {
        // Neither a plugin theme nor a custom file: the selection is gone
        // (unloaded plugin) — fall back to the built-in dark palette. The
        // plugin selection is cleared TOO: a stale record must never
        // trigger a fallback when some unrelated theme unloads later
        // (the review's P2).
        app.clearActivePluginTheme()
        app.applyTheme('dark')
      }
      app.trackTerminalTheme(false)
    }
    // M2: apply the persisted footer mode + layout to the app. `full` and
    // `default` map to the builtin default layout, `compact` to the
    // compact layout, `custom` parses footerLayout (fail-soft: an invalid
    // config warns ONCE and falls back to the default — the TUI always
    // starts). Never writes the document back on a read-only migration.
    // M5: `command` arms the trusted command surface (the trust gate reads
    // the USER layer only — a project-supplied config is refused).
    let footerWarningShown = false
    let customFooterWarningShown = false
    // PR D: the one-shot trust diagnostic latch — a layout reference to a
    // command definition that only exists in a non-USER layer is reported
    // ONCE (bounded), never per repaint.
    let footerCommandItemWarningShown = false
    // footerCommandRunner / footerCommandUnsubscribe are hoisted ABOVE
    // cleanup (TDZ guard — the startup-eager onTerminalResize callback
    // reads the runner before this block can run); only the warning
    // latch lives here.
    const disableFooterCommand = (): void => {
      footerCommandUnsubscribe?.()
      footerCommandUnsubscribe = undefined
      footerCommandRunner?.dispose()
      footerCommandRunner = undefined
      app.setFooterCommandRows(undefined)
    }
    const applyFooterSettings = (
      doc: { footer: string; footerLayout?: unknown; footerCustomItems?: unknown } | undefined,
      savedCustomItems?: readonly FooterCustomItemSettings[],
    ): void => {
      if (doc === undefined) return
      // The merged document's footerCustomItems field is pass-through storage
      // only. Normal startup/reload/settings reads use the ConfigPort's
      // USER-layer semantic resolver; the optional second argument is supplied
      // only by the validated /footer save after its write succeeds, so the
      // just-committed draft is applied without trusting merged project data.
      const customResult = savedCustomItems === undefined
        ? backend.config.footerCustomItems.get()
        : { items: savedCustomItems, invalidCount: 0 }
      app.setFooterCustomItems(customResult.items)
      if (customResult.invalidCount > 0 && !customFooterWarningShown) {
        customFooterWarningShown = true
        app.notify(`${customResult.invalidCount} custom footer item${customResult.invalidCount === 1 ? '' : 's'} invalid — skipped`, 'error')
      }
      // The USER-layer footer trust read (mode + command + layout): the
      // adapter owns the settings descriptor access — a Remote adapter
      // replays the same facts from the wire.
      const trust = backend.config.footerCommandTrust
      // PR D: arm the per-item command runners for the EXECUTABLE ids —
      // USER trusted definitions ∩ USER-authorized activation ids ∩
      // currently rendered layout ids. The runtime receives ONLY the
      // USER-layer trusted definitions (never the merged/project value);
      // the authorized ids come from the ConfigPort's mode-gated
      // projection (a stale leftover USER layout under footer:
      // default/compact authorizes nothing); the rendered intersection
      // stops a command hidden by the merged layout from running in the
      // background. The one-shot diagnostic covers the §11.2 attack
      // shape: a RENDERED layout reference to a command definition that
      // only exists in a non-USER layer renders unavailable, with ONE
      // bounded notice.
      const syncDynamicCommandItems = (authorizedIds: ReadonlySet<string>): void => {
        const trustedCommands = customResult.items
          .filter((item): item is FooterCustomCommandItemSettings => item.kind === 'command')
        if (footerDynamicItemRuntime === undefined) {
          footerDynamicItemRuntime = new FooterDynamicItemRuntime({
            snapshot: () => statusStore.snapshot(),
            width: () => app.getTerminalWidth(),
            height: () => app.getTerminalHeight(),
            signal,
            onValue: (id, value) => app.setFooterCommandItemValue(id, value),
            onNotifyOnce: (message) => app.notify(message, 'error'),
          })
        }
        const executableIds = executableCommandItemIds(
          trustedCommands,
          authorizedIds,
          app.getEffectiveFooterLayout(),
        )
        footerDynamicItemRuntime.sync(trustedCommands, executableIds)
        if (!footerCommandItemWarningShown) {
          const mergedCommands = parseFooterCustomItems(doc.footerCustomItems).items
            .filter((item): item is FooterCustomCommandItemSettings => item.kind === 'command')
          const trustedIds = new Set(trustedCommands.map(item => item.id))
          // The diagnostic watches the RENDERED layout (what the user
          // sees), not the executable set: a rendered ref to a command
          // definition that only exists in a non-USER layer is
          // unavailable and reported once.
          const renderedIds = activeFooterItemIds(app.getEffectiveFooterLayout())
          const untrustedReferenced = mergedCommands.some(item => renderedIds.has(item.id) && !trustedIds.has(item.id))
          if (untrustedReferenced) {
            footerCommandItemWarningShown = true
            app.notify('a custom command item is not user-configured — not running it', 'error')
          }
        }
      }
      if (doc.footer === 'command') {
        // The native FALLBACK layout must be established from the
        // PERSISTED document, never from whatever the memory happens to
        // hold: at STARTUP the memory is still the builtin default. The
        // fallback MODE comes from footerFallbackMode — the `footer`
        // field itself is overwritten by 'command', so the user's last
        // native mode is persisted separately (a compact user's fallback
        // must survive a restart as compact, never silently become the
        // full default — the review's P2). The switch is COMPLETE:
        // 'default' and an invalid custom layout explicitly restore the
        // builtin default, so a runtime reload with a changed document
        // never falls back to whatever the memory happened to hold.
        const fallback = resolveCommandFooterFallback(doc)
        if (fallback.mode === 'compact') {
          app.setFooterPreset('compact')
          app.setFooterLayout(undefined)
        } else {
          app.setFooterPreset('full')
          app.setFooterLayout(fallback.mode === 'custom' ? fallback.layout : undefined)
        }
        // The trust gate: the COMMAND must live in the USER layer of the
        // settings descriptor (never the merged/project value), AND the
        // command MODE must be user-layer-owned — a project flipping the
        // merged `footer: command` must never silently trigger the user's
        // command (plan §17.4). The trust read goes through the CONFIG
        // PORT (the adapter owns the settings descriptor access — a
        // Remote adapter replays the same facts from the wire).
        const config = trust.command
        const userMode = trust.userFooterMode
        if (config === undefined || userMode !== 'command') {
          disableFooterCommand()
          if (!footerWarningShown) {
            footerWarningShown = true
            app.notify('footer command is not user-configured — using the native layout', 'error')
          }
          // The native layout is the user's own (default/compact/custom):
          // never reset it — the command surface overrides the composer
          // only while commandRows is set, and the M5 fallback contract
          // restores the LAST native layout on failure. The fallback
          // layout IS visible, but the authorization follows the USER's
          // CURRENT mode: only a USER who opted into command mode
          // (userMode === 'command') may fall back per their own
          // footerFallbackMode (the fallback property itself is fully
          // gated — empty for any other mode); a USER whose current mode
          // is custom authorizes per their current layout, and a
          // default/compact USER authorizes NOTHING — a PROJECT forcing
          // the merged command mode can never turn stale fallback
          // metadata into execution authorization.
          const authorizedIds = userMode === 'command'
            ? trust.userCommandItemFallbackActivationIds
            : trust.userCommandItemActivationIds
          syncDynamicCommandItems(authorizedIds)
          return
        }
        if (footerCommandRunner === undefined) {
          footerCommandRunner = new FooterCommandRunner({
            config,
            snapshot: () => statusStore.snapshot(),
            width: () => app.getTerminalWidth(),
            height: () => app.getTerminalHeight(),
            onOutput: (rows) => app.setFooterCommandRows(rows),
            onNotifyOnce: (message) => app.notify(message, 'error'),
            signal,
          })
          // Status changes refresh the command (coalesced to its interval).
          footerCommandUnsubscribe = statusStore.subscribe(() => footerCommandRunner?.requestRefresh())
        } else {
          footerCommandRunner.setConfig(config)
        }
        // The native layout stays untouched while command mode is armed:
        // a failed command (undefined rows) falls back to the user's OWN
        // default/compact/custom layout, never the builtin default.
        footerCommandRunner.requestRefresh()
        // The whole-footer command surface covers the native items:
        // per-item command runners must not keep spawning in the
        // background (plan §7.2 — suspend/dispose).
        footerDynamicItemRuntime?.sync([], new Set<string>())
        return
      }
      disableFooterCommand()
      if (doc.footer === 'compact') {
        app.setFooterPreset('compact')
        app.setFooterLayout(undefined)
        syncDynamicCommandItems(trust.userCommandItemActivationIds)
        return
      }
      if (doc.footer === 'custom') {
        const parsed = parseFooterLayout(doc.footerLayout)
        if (!isFooterLayout(parsed)) {
          if (!footerWarningShown) {
            footerWarningShown = true
            app.notify(`footer layout invalid (${parsed.message}) — using the default layout`, 'error')
          }
          app.setFooterPreset('full')
          app.setFooterLayout(undefined)
          // The merged custom layout is invalid: the rendered footer is
          // the builtin default, and only the USER layer's own
          // current-mode authorization may activate custom command items.
          syncDynamicCommandItems(trust.userCommandItemActivationIds)
          return
        }
        app.setFooterPreset('full')
        app.setFooterLayout(parsed)
        // PR D activation trust: a /footer save's validated layout is the
        // trusted activation; every other path uses the USER layer's
        // declared layout — a PROJECT merged layout can render user:*
        // ids, but it can never activate a dormant USER command.
        syncDynamicCommandItems(savedCustomItems !== undefined
          ? activeFooterItemIds(parsed)
          : trust.userCommandItemActivationIds)
        return
      }
      // 'full' | 'default' | unknown → the builtin default layout.
      app.setFooterPreset('full')
      app.setFooterLayout(undefined)
      syncDynamicCommandItems(trust.userCommandItemActivationIds)
    }
    const storedFooter = tuiSettings?.get().footer
    applyFooterSettings(tuiSettings?.get())
    // One-time migration: per-cwd input history used to live inside this
    // settings namespace. Move it to the JSONL history files (oldest-first
    // file order; the stored arrays are newest-first) and drop the stale
    // key from the stored section (the cleanup below deletes it explicitly —
    // schemastery's z.object does NOT strip unknown keys, so a spread of the
    // resolved doc would otherwise write the key right back).
    let legacyHistory: Record<string, readonly string[]> | undefined
    try {
      const descriptor = ctx.get('settings')?.describe()
        .find(d => d.ns === 'dsh-pi-tui')
      const user = descriptor?.user as Record<string, unknown> | undefined
      const value = user?.history
      if (typeof value === 'object' && value !== null) {
        legacyHistory = value as Record<string, readonly string[]>
      }
    } catch {
      // Best-effort; an unreadable settings document skips migration.
    }
    if (legacyHistory !== undefined) {
      const home = dshHome(process.env)
      for (const [cwd, entries] of Object.entries(legacyHistory)) {
        if (!Array.isArray(entries) || entries.length === 0) continue
        const file = historyFilePath(home, cwd)
        // Idempotency: an existing file means this cwd was already migrated
        // (a crash mid-migration leaves the file in place and the settings
        // key intact, so the next boot resumes from the unwritten cwds and
        // only deletes the key once every file exists).
        if (existsSync(file)) continue
        for (const entry of entries.slice().reverse()) {
          try { appendHistoryLine(file, entry, undefined) } catch { /* best effort */ }
        }
      }
      if (tuiSettings !== undefined) {
        // Only drop the stale key once every legacy cwd has a file: a crash
        // between the file writes and this cleanup would otherwise lose the
        // unwritten entries on the next boot (the key would be gone).
        const allMigrated = Object.entries(legacyHistory).every(([cwd, entries]) => {
          if (!Array.isArray(entries) || entries.length === 0) return true
          return existsSync(historyFilePath(home, cwd))
        })
        if (allMigrated) {
          // The schema does NOT strip unknown keys (schemastery z.object keeps
          // them), so the resolved doc still carries `history`: delete it
          // explicitly, or the replace would write it right back.
          runDetached('settings history cleanup', () => {
            return serializeTuiSettingsMutation(tuiSettings, () => {
              const doc = { ...tuiSettings.get() } as Record<string, unknown>
              // This is a whole-document write from the merged settings view;
              // keep the raw USER custom definitions out of the project layer.
              doc.footerCustomItems = userFooterCustomItemsForSave()
              delete doc.history
              return tuiSettings.replace(doc)
            })
          }, {
            diag,
            notify: (message) => app.notify(message, 'error'),
            recoverable: () => true,
          })
        }
      }
    }
    // Input history is loaded PER SESSION by initLiveSession (keyed on the
    // live session's cwd), never once at boot: a session switch to another
    // workspace must replace the recall history, not keep the old one. With
    // a DEFERRED start no session exists yet, so initLiveSession has not
    // run: seed the recall history from the LAUNCH cwd now, so ↑ works
    // immediately in a fresh window (the per-session reseed replaces it
    // when the first session is born).
    const bootHistoryEntries = loadHistoryFile(historyFilePath(dshHome(process.env), cwd))
    lastHistoryContent = bootHistoryEntries.at(-1)
    // File order is oldest-first; TuiApp's recall API takes newest-first.
    app.resetInputHistory([...bootHistoryEntries].reverse())
    // Fresh/deferred startup title: no session yet — cwd identity only.
    refreshTerminalTitle()

    // The TUI-owned slash commands are registered by registerCommands()
    // inside initLiveSession, exactly once after the first session exists.
    // The initial status projection is committed after session hydration (or
    // in the deferred branch below), so a resumed session never paints a
    // temporary empty stats projection.
    // The persistent dock's task lines + the footer badge follow the
    // background-job registry: every change refreshes the active-task
    // snapshot (no polling). `refreshTasks` is hoisted so the task browser
    // (openJobView, defined earlier in this closure) can refresh the badge
    // after stop/close.
    let refreshTasks: () => void = () => {}
    // The subagent half of the dock badge + the open task browser. Two
    // refresh modes, both hoisted like refreshTasks (the browser is
    // defined earlier in this closure):
    // - `refreshAgents` — a CATALOG refresh (listDescendants + commit):
    //   subagent lifecycle events, subagent tool calls and jobs changes;
    // - `refreshAgentRuntimeOnly` — a RUNTIME-only refresh (no listing):
    //   the `agent/status` handler re-projects the cached catalog.
    let refreshAgents: () => void = () => {}
    let refreshAgentRuntimeOnly: () => void = () => {}
    // The ACTIVE task-browser overlay handle (one at a time — the ↓
    // trigger and /tasks share the same surface) and the row-identity
    // source the open browser's select/action paths read. Tracked at
    // runner scope so the runtime refresh repaints the OPEN panel and a
    // session switch closes it (see bumpSessionGeneration).
    let activeTaskBrowser: TaskBrowserHandle | undefined
    let taskBrowserRows: TaskBrowserRow[] = []
    let taskRuntime: TaskBrowserRuntime | undefined
    /** Context retained only while the full center was promoted from Quick. */
    let quickTaskState: TaskBrowserViewState | undefined
    const jobs = ctx.get('jobs')
    if (jobs !== undefined) {
      refreshTasks = (): void => {
        let tasks: { id: string; label: string; status: string; kind?: string; startedAt?: number; finishedAt?: number }[] = []
        try {
          // Keep terminal records in the catalog. Active/total separation is
          // a presentation fact; dropping completed/failed jobs here made
          // Full Task Center history and failure attention impossible.
          tasks = jobs.list(liveAgent).map(job => ({
            id: job.id,
            label: job.label,
            status: job.status,
            kind: job.kind,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
          }))
        } catch {
          // The registry read is best-effort; the dock line just stays stale.
        }
        app.setTasks(tasks)
      }
      // A jobs change usually means a delegation settled; the subagent half
      // of the dock may have changed with it.
      jobs.onJobsChanged(() => { refreshTasks(); refreshAgents() })
      refreshTasks()
    }
    // Continuable children and foreground one-shot children never register
    // jobs records (AGENTS.md), so the dock badge and the task browser need
    // their own channel into the subagent registry. The
    // TaskBrowserRuntime coordinator owns the split:
    // - `refreshAgents` (CATALOG): event-driven — subagent lifecycle events
    //   (start/end), subagent tool calls in the live session, and every
    //   jobs change (a one-shot settlement implies membership may have
    //   moved). listDescendants is async and may read persistence for
    //   cold children, so the commit is session-key fenced and never lands
    //   on a newer session.
    // - `refreshAgentRuntimeOnly` (RUNTIME): the `agent/status` handler —
    //   NEVER re-lists. The catalog's store-presence `activity` is not an
    //   execution state: an idle continuable child stays live in the
    //   session store and would otherwise keep the row and the badge stuck
    //   on `running` forever. Every child's `running`/`inactive` is
    //   re-projected from the Agent registry (`ctx.agents.get(id)?.status`)
    //   AT COMMIT TIME, so a slow catalog response can never overwrite a
    //   newer runtime state (plan §7.3). The badge counts every RUNNING
    //   descendant (plan §6.13) — the user cares that a deep agent is
    //   still working — while durable inactive children never keep it
    //   permanently armed.
    const subagents = ctx.get('subagents')
    if (subagents !== undefined) {
      taskRuntime = new TaskBrowserRuntime({
        // The session fence key: generation + session id, captured when a
        // refresh starts and re-checked after the async listing.
        currentKey: () => liveAgent === undefined ? undefined : `${sessionGeneration}:${liveAgent.session.id}`,
        listDescendants: () => {
          const sessionId = liveAgent?.session.id
          return sessionId === undefined ? Promise.resolve([]) : subagents.listDescendants(sessionId)
        },
        // The merged rows re-read the CURRENT jobs snapshot at every
        // commit, so a job settlement repaints an open browser too.
        readJobs: () => {
          if (jobs === undefined || liveAgent === undefined) return []
          try {
            return jobs.list(liveAgent)
          } catch {
            // The registry read is best-effort; the jobs half stays empty.
            return []
          }
        },
        // The LIVE runtime fact, read at COMMIT time: the Agent registry,
        // never the catalog's store-presence activity.
        agentStatusOf: (childId) => agents?.get(childId as SessionId)?.status,
        commitRows: (rows, preferred) => {
          // The row-identity source for the open browser's select path
          // always reflects the latest commit (a runtime refresh that
          // repainted the panel is never contradicted by a stale local
          // snapshot), and the repaint targets ONLY the open handle.
          taskBrowserRows = [...rows]
          activeTaskBrowser?.setItems(taskPanelItems(rows), preferred)
        },
        commitBadge: (running) => app.setAgents(running.map(entry => ({
          id: entry.id,
          label: entry.label,
          activity: 'running',
        }))),
        commitSummary: (summary) => app.setTaskSummary(summary),
        commitRefreshState: (state, error) => activeTaskBrowser?.setRefreshState?.(state, error),
      })
      // Seed the summary synchronously from jobs before the durable catalog
      // listing lands; this prevents a terminal/jobs-only first frame from
      // claiming every record is still running.
      taskRuntime.refreshRuntime()
      refreshAgents = (): void => {
        if (liveAgent === undefined) {
          app.setAgents([])
          return
        }
        runOwned('task browser agents refresh', () => taskRuntime!.refreshCatalog(), {
          diag,
          sessionId: () => liveAgent?.session.id,
        })
      }
      refreshAgentRuntimeOnly = (): void => {
        if (liveAgent === undefined) {
          app.setAgents([])
          return
        }
        taskRuntime!.refreshRuntime()
      }
      refreshAgents()
    }
    /**
     * Open one job from the task browser: a bash job shows a STATUS viewer
     * (never the output — the job's single read cursor belongs to the agent's
     * job_output; consuming it from the UI would leave the model an
     * incomplete result and could swallow the completion notice); a subagent
     * job shows the status viewer with a /tasks hint. The job record
     * carries no child session id, so label/order/time heuristics cannot
     * distinguish a background child from a same-label foreground one-shot;
     * the task browser therefore never opens a transcript by guess.
     * `jobs` and `refreshTasks` are declared later in this closure; the
     * browser only fires on user input, by which time both are initialized.
     */
    const openJobView = (jobId: string): void => {
      if (jobs === undefined || liveAgent === undefined) return
      const owner = liveAgent
      let snapshot: ReturnType<NonNullable<typeof jobs>['get']>
      try {
        snapshot = jobs.get(jobId as JobId, owner)
      } catch {
        return
      }
      if (snapshot.kind === 'subagent') {
        const childSessionId = subagentJobTranscriptId(snapshot)
        if (childSessionId !== undefined) {
          // The jobs registry's `subagent` kind IS the reliable contract
          // for a background ONE-SHOT delegation (the registry never
          // records continuable children): the transcript viewer opens
          // read-only. The parent is the job owner.
          runOwned('subagent view from tasks', () => enterView(
            childSessionId as SessionId, snapshot.label, 'one-shot', owner.session.id, 'inactive',
          ), {
            diag,
            sessionId: () => owner.session.id,
            onError: (error) => app.notify(`could not open the subagent view: ${safeErrorMessage(error)}`, 'error'),
          })
          return
        }
        // Current JobSnapshot has no stable child id. Use the reliable status
        // fallback and let /tasks (which owns child identities through
        // the merged browser) perform
        // transcript selection; never substitute label/order/time matching.
        openJobStatusViewer(jobId, `subagent ${snapshot.id} · ${snapshot.label}`, snapshot)
        return
      }
      openJobStatusViewer(jobId, `${snapshot.kind} ${snapshot.id} · ${snapshot.label}`, snapshot)
    }
    /**
     * Status-only viewer for one job (never touches the read cursor). The
     * subagent variant appends the /tasks hint because a transcript
     * cannot always be matched; the bash variant is pure status.
     */
    const openJobStatusViewer = (
      jobId: string,
      title: string,
      snapshot: {
        readonly kind?: string
        readonly id: string
        readonly label: string
        readonly status: string
        readonly detail?: string
      },
    ): void => {
      app.openOutputViewer({
        title,
        initial: snapshot.kind === 'subagent'
          ? subagentJobViewHint(snapshot.status, snapshot.detail)
          : jobStatusHint(snapshot.status, snapshot.detail),
        refresh: () => {
          if (jobs === undefined || liveAgent === undefined) return ''
          try {
            const current = jobs.get(jobId as JobId, liveAgent)
            return current.kind === 'subagent'
              ? subagentJobViewHint(current.status, current.detail)
              : jobStatusHint(current.status, current.detail)
          } catch {
            // The job left the registry (or the session switched): freeze.
            return ''
          }
        },
        onStop: () => {
          if (jobs === undefined || liveAgent === undefined) return
          try {
            jobs.kill(jobId as JobId, liveAgent, 'stopped from the task browser')
          } catch {
            // Already finished: nothing to stop.
          }
          refreshTasks()
        },
        onClose: () => refreshTasks(),
      })
    }
    /** One-line viewer hint for a job state (never touches the read cursor). */
    const jobStatusHint = (status: string, detail: string | undefined): string => {
      const tail = status === 'running' || status === 'stopping'
        ? ' — output is delivered to the agent via job_output; viewing never consumes the job\u2019s read cursor'
        : ` — final output: ask the agent to run job_output in the conversation${detail === undefined ? '' : ` (${detail})`}`
      return `${status}${tail}`
    }
    // The queue pane mirrors the agent's durable inbox: next-turn followups
    // first, then next-step steers, in delivery order. The inbox is public on
    // the agent, and every mutation commits an agent/inbox/spliced session
    // event, so the pane refreshes event-driven with no polling. The mirror
    // is a USER-INPUT surface: a background-subagent settlement notice (the
    // runtime's account of a child ending) is dropped from it — the task
    // browser (job rows / inactive child rows /subagents) is its surface —
    // and a FAILED settlement additionally surfaces once as a transient
    // error notify, so the failure is announced without polluting the queue.
    const notifiedSubagentNotices = new Set<string>()
    const refreshQueue = (): void => {
      if (liveAgent === undefined) {
        app.setQueueItems([])
        return
      }
      const turn = foldQueueRows(liveAgent.inbox.nextTurn as unknown as QueueInboxMessage[], 'followup', notifiedSubagentNotices)
      const step = foldQueueRows(liveAgent.inbox.nextStep as unknown as QueueInboxMessage[], 'steer', notifiedSubagentNotices)
      for (const summary of [...turn.failures, ...step.failures]) app.notify(summary, 'error')
      app.setQueueItems([...turn.rows, ...step.rows])
    }
    refreshQueue()
    // The TUI-owned slash commands are registered as soon as the runner
    // surface exists — the commands service's GLOBAL layer needs no agent,
    // so the whole command surface (and the editor's tab completion) is
    // available before the first session (deferred start). Session-backed
    // handlers call runner.ensureSession() themselves; the runner surface
    // re-reads the live agent on every access, so a session swap
    // mid-flight is always reflected. Defined after ensureSession below
    // (the runner object closes over it).
    /**
     * Rebuild every live-session surface after resume, create, or swap.
     * The surface catalog is NOT touched here: the initial owner's catalog
     * came from the pre-mount prefetch/probe, and the first deferred create
     * plus every switch await the coordinator refresh themselves.
     */
    const initLiveSession = async (agent: Agent): Promise<void> => {
      // Setup installs this before publication; the idempotent call also
      // covers test/direct adapters that hand an already-live Agent back to
      // the runner. Its fold is the resume source of truth.
      modelSelections.installForAgent(agent)
      // The session's own workspace joins the known-cwd set (Rule 2 for
      // the all-directory search): a legacy-only history file in this cwd
      // becomes recoverable immediately, even if it predates this process.
      rememberHistoryCwd(agent.session.header.cwd ?? '')
      const events = agent.session.snapshotEvents()
      // This is the single cold-hydration path for a live session. Do not
      // pre-apply the same event log during runner wiring: a resumed session
      // otherwise pays for two full transcript and stats replays before its
      // first usable frame.
      const hydrated = hydrateSessionUi(events)
      folder = hydrated.folder
       windowController.setTurns(folder.groupedTurns())
      statsFolder = hydrated.statsFolder
      diag.debug('session bootstrap scan', {
        scan: 'transcript',
        eventCount: events.length,
        elapsedMs: Number(hydrated.scanTimings.transcriptMs.toFixed(3)),
      })
      diag.debug('session bootstrap scan', {
        scan: 'stats',
        eventCount: events.length,
        elapsedMs: Number(hydrated.scanTimings.statsMs.toFixed(3)),
      })
      goalText = timedBootstrapScan(diag, 'goal', events.length, () => foldGoal(events))
      const working = timedBootstrapScan(diag, 'working', events.length, () => workingFromLog(events))
      const planMode = timedBootstrapScan(diag, 'plan', events.length, () => projectedPlanActive(ctx.get('sessionProjections') as PlanProjectionLike | undefined, agent.session) ?? false)
      const title = timedBootstrapScan(diag, 'title', events.length, () => foldSessionTitle(events)?.title)
      app.setPlanMode(planMode)
      app.setWorking(working)
      app.setBusy(working)
      app.setSessionTitle(title)
      // Session-local bootstrap state must not leak across a switch. Fold the
      // latest todo snapshot once from the same log (an empty log clears it).
      const todos = timedBootstrapScan(diag, 'todo', events.length, () => {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]
          if (event?.type === 'todo/write') return event.data.todos
        }
        return []
      })
      app.setTodoSummary(todos)
      // A resumed session may be mid-compaction. Reset the old phase first;
      // then re-arm only the newest live bracket, matching the log fold.
      const resumedCompaction = timedBootstrapScan(diag, 'compaction', events.length, () => compactingFromLog(events))
      compactingId = resumedCompaction.id
      app.setCompactionPhase(resumedCompaction.active ? 'summarizing' : 'idle')
      if (resumedCompaction.active) {
        app.setBusy(true)
        app.setWorking(true)
      }
      app.clearLocalMessages()
      app.clearNotify() // a notice from the previous session is stale here
      // Issue #8: a stale armed exit chord must not exit the NEW session.
      app.clearCtrlCExit()
      // The subagent-notice notify guard is per-session: a new session's
      // settlements must notify again.
      notifiedSubagentNotices.clear()
      repaint(app, folder, windowController)
      // PR D2: the first usable frame paints with the cached measurement
      // (or none); the context measure is deferred one event-loop turn so
      // cold resume never blocks first paint on a long-session scan.
      refreshStatusCheap()
      refreshQueue()
      scheduleInitialContextMeasure(agent)
      // Repaint both background channels: the dock/badge are owner-fenced,
      // and a session switch must not leave the previous session's tasks
      // or subagents on screen until the next registry event.
      refreshTasks()
      refreshAgents()
      // The recall history is per-workspace AND per-session: REPLACE it
      // with the live session's rows ONLY (the CWD file's rows filtered to
      // this sessionId — session-scoped editor recall), so ↑/↓ in a live
      // session never recalls another session's inputs from the same cwd.
      // The CANONICAL last row stays the cwd file's actual last row (the
      // persistence dedupe anchor stays cwd-scoped — docs/input-history.md);
      // only the EDITOR's recall is the session projection.
      const historyCwd = sessionCwd()
      const historyFile = historyFilePath(dshHome(process.env), historyCwd)
      const historyRecords = loadHistoryRecords(historyFile)
      lastHistoryContent = historyRecords.at(-1)?.content
      // File order is oldest-first; TuiApp's recall API takes newest-first,
      // so the session-filtered projection is reversed at the seed.
      const sessionRecall = recallHistoryForSession(historyRecords, agent.session.id)
      app.resetInputHistory([...sessionRecall].reverse())
      refreshTerminalTitle()
      updateWelcomeCard()
      registerCommands({ snapshot: initialSnapshot, skills: initialSkills })
    }
    /**
     * Create the first session lazily — the FIRST user message triggers it
     * (deferred session creation). Opening the TUI with no --session carries
     * zero session side-effects: no agent, no log, no persistence.
     */
    let creating: Promise<void> | undefined
    const ensureSession = async (): Promise<void> => {
      if (liveAgent !== undefined) return
      if (creating !== undefined) return creating
      // The first-session creation is a session transition too: it runs
      // inside the single-writer gate so it can never interleave with a
      // /new, /fork, rewind or switch that is already in flight.
      creating = transitionGate.run(() => operationBarrier.runTransition(async () => {
        const launched = await launchComposition()
        if (launched.failure !== undefined) resumeFailure = launched.failure
        // The first-session creation follows the SAME target-before-DSH
        // rule as every other transition: the id is pre-generated and its
        // lease is acquired BEFORE the create publishes the session — a
        // refusal aborts with zero side effects, and a create failure
        // PINNS the target (never a release, never a second fresh
        // fallback).
        const createWithLock = async (composition: { agentPreset?: string; setup: (agentCtx: Context) => Promise<void> | void }): Promise<SessionHandle> => {
          const sessionId = SessionId(`session-${randomUUID()}`)
          const lock = acquireOpenLock(String(sessionId), { cwd: process.cwd() })
          if (lock.kind === 'refused') throw new Error(lock.message)
          if (lock.kind === 'unavailable') throw new Error(`cannot lock the fresh session before creating it (${lock.reason})`)
          // The DSH boundary: from here on this lease is touched — a
          // failure PINNS it (never released, never retried, never a
          // second fresh fallback; the first DSH call may have left a
          // hidden lifecycle, so a same-ID retry cannot clear the
          // uncertainty).
          leaseManager.markTouched(String(sessionId))
          try {
            // Read the sessionless facade at the actual create boundary so a
            // `/model` choice made while composition was loading is used by
            // the first deferred Session. The intent and its generation are
            // captured HERE: the save may settle while the create awaits,
            // and the seed decision below must know whether the choice was
            // still pending or failed at this boundary.
            const creationSelection = selected.current ?? defaultModel.currentSelection()
            const creationIntent = activeDefaultIntent?.selection
            return await backend.sessionLifecycle.create({
              sessionId: String(sessionId),
              meta: { cwd: process.cwd(), ...withPresetMeta(composition) },
              provider: creationSelection?.provider,
              model: creationSelection?.model,
              agentPreset: composition.agentPreset,
            }).then(created => {
              // A sessionless /model choice must seed the first Session's own
              // selection: the create options carry it, but the installed ref
              // would otherwise fall back to the global default while the
              // default save is still in flight (or after it failed). Seed
              // the NEWEST still-pending intent (a newer /model during the
              // create wait wins), or the captured choice when its save
              // FAILED — a successfully settled save leaves the blank Session
              // observing the persisted default dynamically.
              const newestPending = activeDefaultIntent?.selection
              if (newestPending !== undefined) {
                modelSelections.selectForNextRequest(created.direct!.agent as Agent, newestPending)
              } else if (creationIntent !== undefined && defaultIntentOutcome === 'failed') {
                modelSelections.selectForNextRequest(created.direct!.agent as Agent, creationIntent)
              }
              return created
            })
          } catch (error) {
            leaseManager.pin(String(sessionId), `first-session creation failed: ${safeErrorMessage(error)}`)
            diag.warn('session lease pinned', { session: String(sessionId), reason: 'first-session creation failed' })
            throw error
          }
        }
        let created: SessionHandle
        try {
          created = await createWithLock(launched.composition)
        } catch (error) {
          // Once the DSH boundary was crossed, NO second fresh fallback may
          // run (convergence plan phase 4): the failed session is pinned
          // (inside createWithLock) and the surface stays sessionless — the
          // next user input starts a NEW attempt. Preset mount failures are
          // no longer auto-replaced; the resolve-level fallback (requested →
          // default) already happened inside launchComposition, BEFORE any
          // DSH call.
          const message = safeErrorMessage(error)
          ctx.logger.warn(`tui-runner: failed to create the first session: ${message}`)
          diag.warn('first session creation failed', { error: message })
          resumeFailure = `could not create the first session: ${message}`
          throw error
        }
        // A successful Direct create always yields the live agent (the
        // port contract: direct.agent is present on Direct backends).
        const createdAgent = created.direct!.agent as Agent
        liveHandle = created.direct!.ownerHandle as AgentHandle
        liveAgent = createdAgent
        // First-session commit: the notification controller resets with
        // the new live identity (a fresh agent must be observed running
        // before it can ever notify).
        completionController.setLiveAgent(createdAgent.id)
        leaseManager.markActive(createdAgent.session.id)
        // The open-time lock was acquired BEFORE the create (above — the
        // createWithLock helper REQUIRED an acquired result, so this record
        // is an idempotent no-op). This is a plain PHYSICAL re-record of
        // the already-ACTIVE lease — NOT an activation, so reserveFor
        // Activation must not be used (it would invalidate the brand-new
        // lifecycle's epoch).
        leaseManager.reserve({ id: liveAgent.session.id, header: liveAgent.session.header })
        // Post-create initialization is best-effort: the child is committed
        // and locked, so failures are recorded, never a fallback (the same
        // retire-warn-only semantics as every other transition).
        try {
          await liveAgent.whenIdle()
        } catch (error) {
          diag.warn('first session whenIdle failed', { error: safeErrorMessage(error) })
        }
        bumpSessionGeneration()
        try {
          await initLiveSession(liveAgent)
        } catch (error) {
          diag.warn('first session surface rebuild failed', { error: safeErrorMessage(error) })
        }
        // The first real session's catalog comes from the REAL agent:
        // await the coordinator refresh so the first submission rides the
        // live scope (the probe snapshot is never execution
        // authorization). Provider issues degrade fields inside the
        // snapshot; a failed attempt is warned, never fatal.
        try {
          await refreshLiveCatalog(liveAgent)
        } catch (error) {
          diag.warn('first session catalog refresh failed', { error: safeErrorMessage(error) })
        }
        if (resumeFailure !== undefined) {
          app.notify(resumeFailure, 'error')
          resumeFailure = undefined
        }
      })).finally(() => { creating = undefined })
      return creating
    }
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
        const target = liveAgent === undefined
          ? { kind: 'preset', presetId: pendingPreset ?? launchPreset } as const
          : { kind: 'agent', key: sessionGeneration } as const
        return refresh({
          source: 'invalidation',
          target,
          ...target.kind === 'agent' ? { agent: liveAgent } : {},
        })
      }, {
        diag,
        sessionId: () => liveAgent?.session.id,
        onResult: (outcome) => {
          // NOTIFY BEFORE settled(): if app.notify throws, runOwned routes
          // to onError, whose settled() is then the ONLY settle — a dirty
          // follow-up cannot be double-settled (a second settle would clear
          // the follow-up's in-flight flag while it is still running).
          if (outcome !== undefined && outcome.kind === 'applied' && outcome.notice !== undefined) {
            app.notify(outcome.notice, 'error')
          }
          skillsChangeGate.settled()
        },
        onCancel: () => { skillsChangeGate.settled() },
        onError: (error) => {
          skillsChangeGate.settled()
          app.notify(`skill catalog refresh failed: ${safeErrorMessage(error)}`, 'error')
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
        backend.catalog.skills.onSkillsChange(() => skillsChangeGate.notify())
        skillsChangeSubscribed = true
      } catch (error) {
        diag.warn('skills/change subscription unavailable', { error: safeErrorMessage(error) })
      }
    }
    /** The UNIFIED Focus setter (plan §7): the runtime state and the TUI
     * surface mutate IMMEDIATELY (a persistence failure must never leave
     * the UI on the old state); the settings write is detached and
     * best-effort — a failure notifies and the next boot may restore the
     * old value. Every mutation path (/focus, /settings) goes through
     * this — there is exactly one authoritative state (plan §5). */
    const setFocusMode = (enabled: boolean): void => {
      focusState.enabled = enabled
      app.setFocusMode(enabled)
      // The footer's focus-mode item reads the store: repaint it right
      // away (no session event is guaranteed to follow an idle toggle).
      refreshStatusCheap()
      const settings = tuiSettings
      if (settings !== undefined) {
        runDetached('settings focus write', () => serializeTuiSettingsMutation(
           settings,
           () => settings.replace({ ...settings.get(), footerCustomItems: userFooterCustomItemsForSave(), focusMode: enabled ? 'on' : 'off' }),
         ), {
          diag,
          notify: (message) => app.notify(`focus mode persistence failed: ${message}`, 'error'),
          recoverable: () => true,
        })
      }
    }
    // The per-TUI draft image registry (plan §5.2): staged clipboard/file
    // bytes for the current run. Cleared on submit/session-switch/dispose —
    // never touches durable attachments the harness already accepted.
    const draftImages = new DraftImageStore()
    /**
     * The conversation rewind picker (the ONE entry shared by the idle
     * empty-editor double-Esc and `/rewind` — plan §22). Lists the completed
     * user turns of the live session; a selection commits through
     * `commitRewind` (create → commit → prompt restore) as an OWNED task with
     * the stale-generation gates. Sessionless (deferred start) it notifies
     * and never creates a session.
     */
    function openRewindPicker(): void {
      const source = liveAgent
      if (source === undefined) {
        app.notify('no conversation to rewind', 'info')
        return
      }
      // Rewind only from an EMPTY editor: the restored prompt must be a
      // deliberate, clean draft — never merged into (or over) the user's
      // current draft. The `/rewind` command gets the same guard, so both
      // entries can never drop staged input (plan §30).
      if (app.getDraft().trim() !== '') {
        app.notify('clear the current draft before rewinding', 'info')
        return
      }
      const candidates = collectRewindCandidates(source.session.snapshotEvents())
      if (candidates.length === 0) {
        app.notify('no completed user turn to rewind', 'info')
        return
      }
      // The source identity captured at OPEN time: the selection commits
      // only while the same session still owns the surface (stale gates
      // inside commitRewind).
      const sourceId = source.session.id
      const sourceGeneration = sessionGeneration
      const commitHost: RewindCommitHost = {
        sessionCwd: () => sessionCwd(),
        sessionPreset: (session) => session.id === sourceId
          ? currentPreset()
          : sessionPresetOf(ctx, session),
        compose,
        agents: backend.sessionLifecycle,
        liveIdentity: () => ({ sessionId: liveAgent?.session.id, generation: sessionGeneration }),
        // The unified transaction: the old session is flushed BEFORE the
        // child is created (a stale rewind is detected before anything is
        // published; a flush failure leaves zero side effects), the commit
        // is a synchronous critical section, and nothing after the create
        // is ever "rolled back" (dispose cannot delete a persisted child).
        transitionTo: (steps) => transitionTo(steps),
        replaceDraft: (text) => app.setDraft(text),
      }
      app.openPicker(
        candidates.map(rewindPickerItem),
        (value) => {
          const candidate = candidates.find(item => String(item.turnStartSeq) === value)
          if (candidate === undefined) return
          runOwned('conversation rewind', () => {
            // The WHOLE commit — gate 1 → create → commit → restore — runs
            // inside the session-transition gate: no other transition can
            // interleave, so a stale rewind is detected BEFORE the child is
            // created (never a published-and-disposed durable ghost), and
            // the commit can never be overwritten by a concurrent switch.
            return transitionGate.run(() => operationBarrier.runTransition(() => commitRewind(commitHost, source, candidate, {
              sessionId: sourceId,
              generation: sourceGeneration,
            })))
          }, {
            diag,
            sessionId: () => sourceId,
            onResult: (outcome) => {
              if (outcome.kind === 'stale') {
                // The stale gate runs BEFORE any create (inside the gate a
                // switch cannot interleave): the picker's selection is
                // refused while the surface is still the source — no child
                // was created, nothing to dispose (review round 8).
                app.notify('session changed — rewind cancelled', 'info')
                return
              }
              if (outcome.kind === 'failed') {
                app.notify(outcome.message, 'error')
                return
              }
              // The swap COMMITTED: staged drafts are per-session UI state —
              // drop the UNPINNED ones now, exactly like /new and /fork (a
              // historic attachment is never silently re-staged).
              draftImages.clearUnpinned()
              if (outcome.hasNonTextContent) {
                app.notify(`rewound to turn ${outcome.turn}; original attachments were not re-staged — reattach them before sending`, 'error')
              } else {
                app.notify(`rewound to turn ${outcome.turn}`, 'info')
              }
            },
            onError: (error) => {
              // Failed compose/create keeps the CURRENT session, the picker
              // is closed, the editor draft is untouched (commitRewind never
              // writes it before the transaction commits).
              app.notify(safeErrorMessage(error), 'error')
            },
          })
        },
        () => {},
        {
          header: 'Rewind conversation · workspace unchanged',
          enableSearch: true,
          noMatchText: 'No matching turn',
          width: 72,
          maxHeight: 24,
          showHint: true,
        },
      )
    }
    const runner: TuiCommandRunner = {
      ctx,
      app,
      diag,
      get liveAgent() { return liveAgent },
      // Completion-notification preference setters (the /settings panel
      // writes): the controller applies the parsed value immediately and
      // the panel persists the raw string through the config port.
      setNotificationMode: (mode) => completionController.setMode(parseNotificationMode(mode)),
      setNotificationMethod: (method) => completionController.setMethod(parseNotificationMethod(method)),
      ensureSession,
      get selected() { return selected },
      // The default selection a NEW Session should observe: the latest
      // explicit default intent (a /model commit this run), falling back to
      // the persisted global default.
      defaultSelection: (): ModelSelection | undefined =>
        activeDefaultIntent?.selection ?? (defaultModel.currentSelection() as ModelSelection | undefined),
      get defaultIntent() { return activeDefaultIntent?.selection },
      get defaultIntentRecord() { return activeDefaultIntent },
      setDefaultIntent,
      settleIntent,
      get tuiSettings() { return tuiSettings as unknown as TuiCommandRunner['tuiSettings'] },
      // /new and /fork create through the session lifecycle port (semantic
      // requests — the Direct adapter resolves the preset composition).
      agents: {
        create: (options) => backend.sessionLifecycle.create(options),
        resume: (options) => backend.sessionLifecycle.resume(options),
      },
// M2: apply the persisted footer mode + layout (shared by /settings,
      // /reload and the startup path).
      applyFooterSettings,
      // The session READ port (migration M1.3): /sessions, /resume, /search,
      // the title batches, the context measurement and the export read go
      // through the port, never ctx directly.
      sessionReader: backend.sessionReader,
      // PR D2: the /status explicit force — measure NOW through the
      // coordinator (mark dirty + semantic reader), repaint the footer
      // cheaply, and return the fresh (or last-good) value for the panel.
      // Panel and footer share ONE cached measurement: no duplicate reads
      // against the coordinator's cache, no stale footer after an explicit
      // status (round-8 finding).
      forceContextMeasurement,
      // The session WRITE port (migration M1.4): follow-up delivery, steer,
      // queue pull-back, cancel and title ops go through the port.
      sessionWriter: backend.sessionWriter,
      // The interaction port (migration M1.6): approval/question authority.
      interaction: backend.interaction,
      // The catalog port (migration M1.8): models/providers, presets and
      // skills — commands read Host catalogs through semantic DTOs.
      catalog: backend.catalog,
      // The config port (migration M1.9): settings, provider profiles,
      // credentials, authorization, permissions and the preset default.
      config: backend.config,
      // The Host-file port (migration M1.10): `@`-mention discovery and
      // send-time canonicalization against the Host filesystem.
      hostFile: backend.hostFile,
      // The minimal commands registry for the TUI's OWN registrations
      // (migration M1.11) — the runner assembly dependency, never a Host
      // capability exposed to command handlers.
      commandRegistry: ctx.get('commands') as import('./commands.ts').CommandRegistryLike | undefined,
      cwd,
      imageStore: draftImages,
      // Issue #7: /copy shares the fullscreen selection's clipboard policy.
      copyToClipboard: (text) => copyToClipboard(text, runCopyCommand, copyEnv),
      // The deployment image policy, re-read dynamically so a runtime
      // reconfiguration is picked up (plan §10.1: never a cached copy).
      imageLimits: () => ctx.get('attachments')?.imageLimits as import('./image/intake.ts').ImageLimitsLike | undefined,
      insertIntoEditor: (text) => app.insertIntoEditor(text),
      // The shared prepared-input pipeline (skills build their message
      // through this — review finding 4).
      prepareDraftMessage: (text) => prepareUserMessage(text, draftImages, submitDeps),
      // M5: the extension registries (commands/themes/settings/autocomplete/
      // keybindings), when the extension service is mounted. The /settings
      // and /theme pickers read them; undefined degrades to the host-only
      // panel.
      get extensions() {
        return extensionService === undefined ? undefined : {
          commands: extensionService.commands,
          themes: extensionService.themes,
          settings: extensionService.settings,
          autocomplete: extensionService.autocomplete,
          keybindings: extensionService.keybindings,
          renderers: extensionService.renderers,
          editors: extensionService.editors,
          api: () => extensionService.api(),
          // P1-08: the live contribution-health snapshot (failed/shadowed
          // states + lastError across every registry incl. renderers).
          health: () => extensionService._ledger().healthSnapshot(),
        }
      },
      recordExtensionError: (ref, error) => extensionService?._recordRegistryError(ref, error),
      clearExtensionError: (ref) => extensionService?._clearRegistryError(ref),
      /** The live session's workspace cwd (header), falling back to the
       * process cwd before any session exists; the footer/welcome/
       * completions/history follow it so a session switch updates the
       * whole surface. */
      sessionCwd,
      signal,
      get sessionGeneration() { return sessionGeneration },
      /** Focus Mode surface (plan §32.1): the /focus and /settings commands
       * read the runtime state and mutate it through the ONE setter. */
      focusEnabled: () => focusState.enabled,
      setFocusMode,
      get pendingPreset() { return pendingPreset },
      set pendingPreset(id: string | undefined) { pendingPreset = id },
      /** The effective preset id for COLD (sessionless) reads: the run-local
       * pending override ahead of the launch-time --preset (the SAME
       * precedence ensureSession uses); undefined = the saved/default
       * preset applies. */
      get effectivePresetId() { return pendingPreset ?? launchPreset },
      refreshCatalog: (request) => {
        const refresh = catalogRefreshRequest
        return refresh === undefined
          ? Promise.resolve({ kind: 'failed', error: 'catalog refresh unavailable' })
          : refresh(request)
      },
      switchSession,
      transitionTo,
      currentPreset,
      recomposeBlank: (id) => recomposeBlank(ctx, liveAgent as Agent, id),
      // PR D2: the command surface's generic refresh is UI-only (a
      // measurement-triggering command uses refreshContextMeasurement or
      // the /status port call directly).
      refreshStatus: refreshStatusCheap,
      updateWelcomeCard,
      openJobView,
      openTasksBrowser,
      openRewindPicker,
      // The transition write fence: agent-write entry points (plain
      // submits, steers, skill invocations, shell submits) refuse while a
      // transition is in flight (quiesce → commit) — the old agent may be
      // woken again between whenIdle and the lock handover.
      sessionTransitionPending: () => transitionGate.busy,
      // The single-writer session-transition gate: /new, /fork and the
      // command-side switches run their create AND commit inside one
      // exclusive section via this seam (rewind goes through
      // openRewindPicker's own gate wrapper).
      withSessionTransition: <T>(task: () => Promise<T> | T) =>
        transitionGate.run(() => operationBarrier.runTransition(async () => task())),
      withSessionWriter: <T>(sessionId: string, task: () => Promise<T> | T) =>
        operationBarrier.runWriter(sessionId, async () => task()),
      enterView,
      requestExit,
      exit,
    }
    const registerCommands = (initial?: InitialCommandCatalog): void => {
      if (commandsRegistered) return
      const commands = ctx.get('commands')
      if (commands === undefined) return
      commandsRegistered = true
      try {
        const installed = registerTuiCommands(runner, initial)
        wasAdvertisedClaim = installed.wasAdvertised
        // The coordinator's surface hooks point INTO the command surface;
        // the runner's refreshCatalog routes every post-mount refresh here.
        catalogCoordinator = new CatalogRefreshCoordinator({
          readAgent: (agent, readSignal) => readSurfaceCatalog(agent, readSignal, ctx as unknown as SurfaceCatalogContext),
          // The sessionless (preset) target reads the STANDING skill catalog
          // through the catalog capability (migration M1.8) — the
          // capability-gated cold path (standing key → global → degraded
          // global with a notice), never an Agent probe: probes emit
          // durable session events in this deployment (see
          // docs/surface-catalog.md).
          readStanding: (presetId, readSignal) =>
            backend.catalog.skills.standing(presetId, process.cwd(), readSignal),
          installSnapshot: (next) => installed.installSnapshot(next),
          enterCatalogTransition: () => installed.enterTransition(),
        }, lifecycleController.signal, diag)
        catalogRefreshRequest = (request) => catalogCoordinator!.refresh(request)
        subscribeSkillsChangeEvents()
      } catch (error) {
        // A failed registration must not lock the surface forever (a locked
        // flag would leave every later command resolving to a plain message
        // silently): reset the flag for a later retry and surface the
        // failure visibly instead of swallowing it.
        commandsRegistered = false
        const message = safeErrorMessage(error)
        ctx.logger.error(`tui-runner: command registration failed: ${message}`)
        diag.error('command registration failed', { error: message })
        app.notify(`command registration failed: ${message}`, 'error')
      }
    }
    /** Await one live-owner catalog refresh through the coordinator (the
     * first deferred create and every session switch): the refresh attempt
     * settles before the caller continues, and its outcome is an outcome —
     * provider issues degrade fields, failures warn, the submission or the
     * switch proceeds either way. */
    const refreshLiveCatalog = async (agent: Agent): Promise<void> => {
      const refresh = catalogRefreshRequest
      if (refresh === undefined) return
      await refresh({
        source: 'live-session',
        target: { kind: 'agent', key: sessionGeneration },
        agent,
      })
    }
    // The startup surface: a resumed session initializes everything; the
    // deferred path shows the pre-session invitation until the first message.
    if (liveAgent !== undefined) {
      // The initial owner's catalog was prefetched before mount: no
      // duplicate refresh.
      await initLiveSession(liveAgent)
    } else {
      app.setWelcomeIdle(true)
      refreshStatusCheap()
      refreshTerminalTitle()
    }
    // Command registration is sessionless: it must run on BOTH startup
    // surfaces (resume path registers inside initLiveSession; the deferred
    // path registers here so /exit /settings /help work before any message).
    // The pre-mount snapshot installs SYNCHRONOUSLY inside registration —
    // the first terminal input cannot arrive before this call stack unwinds.
    registerCommands({ snapshot: initialSnapshot, skills: initialSkills })
    if (surfaceNotice !== undefined) {
      app.notify(surfaceNotice, 'error')
      surfaceNotice = undefined
    }
    if (resumeFailure !== undefined) {
      app.notify(resumeFailure, 'error')
      resumeFailure = undefined
    }
    ctx.on('session/event', (session, event) => {
      // The subagent viewer follows its own session's events; everything
      // else routes to the live agent's folder as before. Without a live
      // session (deferred start) there is nothing to route to.
      if (liveAgent === undefined) return
      if (viewing !== undefined) {
        if (session.id === viewing.id) {
          viewing.folder.apply([event])
          viewing.stats.apply([event])
          // The store-activity snapshot moves with the child's own
          // lifecycle: a turn starting means the child is live again
          // (cold resume), a turn ending parks it. The footer's activity
          // field follows, so an inactive child that cold-resumes shows
          // running while it streams.
          if (event.type === 'turn/start') viewing.activity = 'running'
          else if (event.type === 'turn/end') viewing.activity = 'inactive'
          schedulePaint()
          // The child's turn/step/stats counters move at step boundaries
          // (the stats fold counts at step/end) — the footer follows then,
          // never on every streaming delta. A turn START also refreshes so
          // the activity flips to running the moment a cold resume begins.
          if (event.type === 'turn/start' || event.type === 'step/end' || event.type === 'turn/end') refreshViewerFooter()
          if (event.type === 'turn/end') paintNow()
          return
        }
        // Any OTHER session's events (the live agent's) keep routing to the
        // main folder below — the viewer never starves the main transcript.
      }
      if (session.id !== liveAgent.session.id) return
      // Keep the Direct owner in sync with durable model intent and consume a
      // pending choice only when the exact raw request header was recorded.
      // The structural check keeps this next-version event compatible with
      // older public dsh-session declarations.
      const selectionEvent = event as unknown as { type?: unknown; data?: unknown }
      if (selectionEvent.type === 'model/selection') {
        modelSelections.observeSelectionEvent(liveAgent, selectionEvent)
      } else if (event.type === 'request/header') {
        // Consume a pending choice only when the exact raw request header was
        // recorded. The pure helper validates the structural shape, so a
        // malformed header (or a malformed event data payload) can never
        // throw inside the event firehose.
        const data = event.data as unknown
        const header = typeof data === 'object' && data !== null
          ? (data as { header?: unknown }).header
          : undefined
        const raw = rawSelectionFromRequestHeader(header)
        if (raw !== undefined) {
          modelSelections.consumeSelection(liveAgent, raw.provider, raw.model, raw.reasoningEffort)
        }
      }
      // Pair approval previews: remember each tool call's arguments by callId.
      if (event.type === 'tool/call') {
        callArgs.set(event.data.callId, typeof event.data.arguments === 'string'
          ? event.data.arguments
          : JSON.stringify(event.data.arguments))
        // Continuable children never register jobs, and their lifecycle
        // events are scoped by the delegating parent — an UNTAGGED
        // listener (this runner) receives them all, so the tool's own
        // call is a REDUNDANT badge-arming signal that stays as a
        // defensive net (it also fires when the lifecycle events are
        // suppressed upstream).
        if (typeof event.data.name === 'string' && event.data.name.startsWith('subagent')) {
          refreshAgents()
          // Remember the pending delegation: the viewer matches one of these
          // by description when the user opens a child transcript, so the
          // child's tool/result can pop the viewer back automatically.
          let description = ''
          try {
            const parsed = JSON.parse(event.data.arguments)
            if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { description?: unknown }).description === 'string') {
              description = (parsed as { description: string }).description
            }
          } catch {
            // A non-JSON arguments payload carries no matchable description.
          }
          pendingSubagentCalls.push({ callId: event.data.callId, description })
        }
      } else if (event.type === 'tool/result') {
        const callId = event.data.message.content[0]?.toolCallId
        callArgs.delete(callId ?? ('' as ToolCallId))
        // The delegation settled: drop it from the pending list and remember
        // whether the user is viewing the child this call spawned, so after
        // the event lands in the main folder we can pop back to the main
        // transcript (the result is visible there).
        const callIndex = pendingSubagentCalls.findIndex(call => call.callId === callId)
        if (callIndex !== -1) pendingSubagentCalls.splice(callIndex, 1)
        const childId = callId === undefined ? undefined : viewCallToChild.get(callId)
        if (childId !== undefined) viewCallToChild.delete(callId)
        const popAfterApply = childId !== undefined && viewing !== undefined && viewing.id === childId
        if (popAfterApply) {
          // The event below lands in the main folder FIRST so the pop shows
          // the settled card, not the running one.
          folder.apply([event])
          statsFolder.apply([event])
          exitView()
          return
        }
      }
      folder.apply([event])
      statsFolder.apply([event])
      // The goal badge folds incrementally: the newest goal/change event
      // decides, so one event is enough (clear/completed hide the badge).
      if (event.type === 'goal/change') goalText = foldGoal([event])
      // Permission knob events (preset/policy/mode) carry no transcript
      // content, so they must not schedule a repaint: the repaint would call
      // setTranscript and wipe an in-flight notify (e.g. the
      // "permission: …" notice) ~REPAINT_FLUSH_MS after the switch, making
      // it flash. The footer badge refresh below repaints the status line
      // instead, and the next real session event repaints the transcript.
      const isKnob = event.type === 'permission/preset' || event.type === 'approval/policy' || event.type === 'sandbox/mode'
      if (!isKnob) schedulePaint()
      if (event.type === 'todo/write') app.setTodoSummary(event.data.todos)
      if (event.type === 'plan/mode') app.setPlanMode(event.data.active)
      if (event.type === 'session/title') app.setSessionTitle(foldSessionTitle([event])?.title)
      // A permission switch (command, Shift+Tab, settings panel) lands as
      // knob events between turns: refresh the footer mode badge right away
      // instead of waiting for the next step/turn boundary.
      if (isKnob) {
        // Knob events are UI-only: the permission badge repaints from
        // cached facts — never a context measurement.
        refreshStatusCheap()
      }
      // Every durable inbox mutation (followup, steer, splice) commits
      // an agent/inbox/spliced event. The upstream Inbox commits the event
      // BEFORE its live projection mutates (synchronous observers see the
      // pre-splice lists), so the pane must read the inbox on the next
      // microtask — after the splice has actually landed. This is also the
      // FIRST authoritative signal a submission reached the session: the
      // local ack row and the latency timeline settle here.
      if (event.type === 'agent/inbox/spliced') {
        settleLocalSubmitAck('inbox inserted')
        submitLatencyTracker.mark(liveAgent.session.id, 'inbox.inserted')
        queueMicrotask(refreshQueue)
      }
      // The user message committing to the session is the ack row's
      // AUTHORITATIVE clear (the host pre-step can delay it well past the
      // inbox insert); the first assistant chunk stamps the provider's
      // first-token latency once per turn.
      if (event.type === 'user/message') {
        settleLocalSubmitAck('user message')
        submitLatencyTracker.mark(liveAgent.session.id, 'user.message')
      }
      if (event.type === 'assistant/chunk') {
        submitLatencyTracker.mark(liveAgent.session.id, 'assistant.first')
      }
      // Compaction lifecycle (dsh-compaction is not a peer — the event
      // data is read structurally): the working row advertises the
      // compaction phase (summarizing → applying), the busy flag covers
      // the single-Esc cancel (pi parity), and the settle notifies. The
      // compactionId pairs start/end so a stale end can never clear a
      // NEWER compaction's state (foldCompactionEvent).
      const compacted = foldCompactionEvent({ id: compactingId }, event as never)
      compactingId = compacted.id
      if (compacted.phase === 'summarizing') {
        app.setCompactionPhase('summarizing')
        // Busy while compacting: a single Esc cancels the compaction (pi
        // parity — compaction rides the turn signal).
        app.setBusy(true)
      }
      if (compacted.phase === 'applying') {
        app.setCompactionPhase('applying')
      }
      if (compacted.clear) {
        // The compacted replacement has committed to the live session
        // surface: re-measure context immediately so the footer reflects
        // the new surface without waiting for the next step/start or
        // turn/end. The working row hands back to the turn state: a
        // turn-enclosed compaction keeps the turn animation, a standalone
        // one clears.
        // Compaction rewrites the model-visible surface: re-measure NOW
        // (the footer would otherwise show stale pressure until the next
        // step/start or turn/end).
        settleCompactionSurface(app, () => { markContextDirty(); refreshContextMeasurement('compaction-end') }, workingFromLog(liveAgent.session.snapshotEvents()))
      }
      if (compacted.notify !== undefined) app.notify(compacted.notify.text, compacted.notify.kind)
      // PR D2: route the context re-measure decision through the single
      // classifier (test seam). compaction/end is NOT routed here — its
      // re-measure is driven by the MATCHED compaction fold above (a stale
      // compaction/end must never re-measure).
      const eventType = String(event.type)
      if (eventType !== 'compaction/end' && contextRefreshKind(eventType) === 'measure') {
        markContextDirty()
        refreshContextMeasurement(eventType === 'turn/end' ? 'turn-end' : 'step-start')
      }
      // Persist each completed turn so a crash loses at most the live turn.
      // The busy indicator follows turn boundaries: on from the moment a
      // turn starts (model wait + tool calls), off when it ends.
      if (event.type === 'turn/start') {
        // The turn is live: the Working row takes over the feedback surface
        // and the submit timeline stamps the turn boundary.
        settleLocalSubmitAck('turn started')
        submitLatencyTracker.mark(liveAgent.session.id, 'turn.start')
        app.setWorking(true)
        app.setBusy(true)
      } else if (event.type === 'turn/end') {
        app.setWorking(false)
        // NOTE: the submit-latency timeline is deliberately NOT reset on
        // turn/end — a submission accepted while this turn was running
        // (busy/queue) is processed by the NEXT turn, and resetting here
        // would erase exactly the T1→T4/T4→T5 journey Phase E exists to
        // measure. The baseline ends only on: the next accept (rebase),
        // the assistant.first auto-complete, a terminal non-delivery exit
        // (token-scoped settle) or a session switch.
        // A turn end must not clear the busy flag while a compaction is
        // still in flight (an interrupted turn can close before its
        // compaction settles) — the single-Esc cancel stays armed.
        app.setBusy(busyAfterTurnBoundary('turn/end', compactingId !== undefined))
        paintNow()
        // Persist each completed turn so a crash loses at most the live
        // turn. Detached: a flush rejection must never surface as an
        // unhandled rejection in the event firehose. An ENOENT flush (the
        // log was removed externally) is user-recoverable: notify with the
        // actionable hint — the session keeps working in memory, but
        // persistence cannot resume until restart.
        const flushed = liveAgent.session
        runDetached('turn flush', () => sessions.flush(flushed), {
          diag,
          sessionId: () => flushed.id,
          notify: (message) => app.notify(
            `session persistence failed: ${message} — the session log was removed externally; this session can no longer be persisted (restart to recover)`,
            'error',
          ),
          recoverable: (error) => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
        })
      }
    })
    // Subagent lifecycle events drive the continuable-children half of the
    // dock badge (they never register jobs). The events are scoped by the
    // delegating parent, but an UNTAGGED listener (this runner) receives
    // every agent-scoped event — including nested descendants' — so no
    // reachability caveat applies; the tool/call fallback above stays as
    // a redundant safety net. These are CATALOG events: membership/tree
    // may have changed, so they re-list.
    ctx.on('subagent/start', () => refreshAgents())
    ctx.on('subagent/end', () => refreshAgents())
    // `agent/status` is the LIVE runtime channel: a child's driver
    // transition (running ↔ idle) must repaint the task browser and the
    // badge WITHOUT a re-listing — membership changes come only from the
    // lifecycle events above, and `listDescendants().activity` is
    // store-presence, never execution state (an idle continuable child
    // stays live in the session store and would otherwise read as
    // `running` forever). The membership gate keeps this cheap and safe:
    // only flips of children in the CACHED catalog refresh the surface —
    // the MAIN agent's own per-turn flips (and any stale post-switch
    // event) never repaint, and the coordinator re-projects every child
    // from the Agent registry at commit time. The MAIN agent's
    // transitions feed the completion-notification controller instead
    // (the authoritative settled boundary — running → idle on the SAME
    // live agent; children never notify).
    ctx.on('agent/status', ({ agent, status }) => {
      if (liveAgent === undefined) return
      if (agent.id === liveAgent.id) {
        completionController.onAgentStatus(agent.id, status)
        return
      }
      if (taskRuntime?.has(agent.id) !== true) return
      refreshAgentRuntimeOnly()
    })
    // Provider-topology and credential events refresh the footer model row
    // and the welcome card: a /login /logout /add-provider (or an external
    // settings.yaml / .credentials.yaml edit) changes the live provider /
    // model surface, and the status line must not keep showing a stale
    // selection. All three events are capability-optional: an absent llm /
    // settings / credentials service never mounts them, and a throwing
    // listener is contained by the event bus (the refresh is best-effort).
    // The credential update surface has reference and durable-record events;
    // both change the same footer/welcome state, so they share one refresh
    // callback.
    ctx.on('llm/adapters-updated', () => { refreshStatusCheap(); updateWelcomeCard() })
    ctx.on('settings/document-updated', (ns) => {
      if (ns === 'llm-pi-ai' || ns === 'llm-deepseek') {
        refreshStatusCheap()
        updateWelcomeCard()
      }
    })
    const refreshCredentialSurface = (): void => { refreshStatusCheap(); updateWelcomeCard() }
    // The credential event wiring is the config port's (migration M1.9):
    // reference- and record-updated both change the same surface. The
    // subscription is DISPOSED on teardown — a remount/HMR must never
    // accumulate duplicate Host listeners (review finding).
    const disposeCredentialSubscription = backend.config.credentials.onChanged(refreshCredentialSurface)
    lifecycleController.signal.addEventListener('abort', disposeCredentialSubscription, { once: true })
    // Plan, busy, title, compaction, and todo bootstrap state are installed by
    // initLiveSession together with the two hydrated projections. Keeping all
    // session-owned bootstrap work there avoids a second full-log scan on
    // resume and also makes session switches restore the same state.

    // The interactive answerer: every approval ask becomes a dialog. An
    // already-aborted request settles cancelled synchronously; otherwise the
    // prompt's own abort signal withdraws it (turn cancel). P7c: the dialog
    // previews the paired tool call's arguments and flags dangerous commands.
    backend.interaction.onApprovalRequest((req, next) => {
      if (req.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')
      const args = req.callId === undefined ? undefined : callArgs.get(req.callId as never)
      return app.showApprovalPrompt({
        toolName: req.toolName,
        reason: req.reason,
        signal: req.signal,
        ...args === undefined ? {} : { arguments: args },
        ...args !== undefined && req.toolName === 'bash' && dangerCommand(args) ? { danger: true } : {},
      })
    })
    // The interactive question answerer: ask_user_question tool calls become
    // dialog flows; the tool receives the structured answers.
    backend.interaction.registerQuestionProvider(async (request) => {
      const answers = await app.askQuestions(request.questions.map(question => ({
        id: question.id,
        question: question.question,
        ...question.header !== undefined ? { header: question.header } : {},
        ...question.detail !== undefined ? { detail: question.detail } : {},
        ...question.options !== undefined ? { options: question.options } : {},
        ...question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {},
        ...question.intent !== undefined ? { intent: question.intent } : {},
      })), request.signal)
      return {
        answers: answers.map(answer => ({
          id: answer.id,
          selected: answer.selected,
          ...answer.custom !== undefined ? { custom: answer.custom } : {},
        })),
      }
    })
  })().catch((error: unknown) => {
    // Terminal-total final catch of the startup lifecycle root: error
    // observation, logging, abort, dispose and exit are each individually
    // protected, so a hostile rejection or a throwing dependency can never
    // skip the teardown or leak a rejection from this discarded chain.
    const message = safeErrorMessage(error)
    try {
      ctx.logger.error(`tui-runner: ${message}`)
    } catch {
      // The cordis logger must not block the teardown.
    }
    try {
      diag.error('fatal', { error: message })
    } catch {
      // A throwing diagnostics channel must not block the teardown.
    }
    // Startup failure: cancel every in-flight lifecycle load, then tear
    // down. (The runner-internal cleanup() never ran — the body threw.)
    // The pre-mount status line is cleared by the lifecycle abort
    // listener registered at startup (idempotent).
    // Terminal focus reporting (CSI ? 1004) may already be enabled when
    // the body threw AFTER the TUI mount — disable it here so the mode
    // never leaks into the shell on the startup-failure path either
    // (idempotent when the mount never ran; the guarded writer swallows
    // broken-stream errors, a synchronous throw is contained).
    try {
      notificationWriter.write(DISABLE_FOCUS_REPORTING)
    } catch {
      // The stream may already be gone during the fatal path.
    }
    try {
      lifecycleController.abort()
    } catch {
      // The abort must not block dispose/exit.
    }
    try {
      diag.dispose()
    } catch {
      // The dispose must not block the process exit.
    }
    try {
      exit(1)
    } catch {
      // The last step; there is no lower sink.
    }
  })
}
