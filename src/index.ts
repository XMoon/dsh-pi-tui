/**
 * @xmoon76/dsh-pi-tui — the bundle's runner plugin. Waits for the startup
 * service (the parsed `dsh --profile pi-tui` flags) and Loader settlement,
 * creates or resumes an Agent through the core registry, renders its session
 * log into the TUI transcript, and routes editor submissions back through
 * `agent.followup`. Streaming arrives through the `session/event` firehose;
 * a persistent `TranscriptFolder` folds appended events incrementally and a
 * coalesced repaint flushes the windowed transcript (older turns collapse
 * into a summary), so long sessions never re-scan the whole log per event.
 * @module @xmoon76/dsh-pi-tui
 */

import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CallId, ContentBlock } from '@deepseek-ai/dsh-llm'
// P7d: the subagent registry merge for ctx.subagents (listChildren/interrupt).
import type {} from '@deepseek-ai/dsh-subagent'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
// P6: the agent-preset roster — ctx.agentPresets, the session preset
// resolver, and the `agent-preset/selected` session event map.
import type {} from '@deepseek-ai/dsh-agent-presets'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type {} from './preset-events.ts'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
// The approval/request waterfall merge: the TUI is the interactive answerer.
import type {} from '@deepseek-ai/dsh-user-approval'
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
// The commands service merge: ctx.commands typing for execute()/register().
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-commands'
// The skill registry merge for the /skill command.
import type {} from '@deepseek-ai/dsh-skill'
// The settings service merge for persisting TUI preferences.
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
// The user-questions service merge: ctx.userQuestions for ask_user_question.
import type {} from '@deepseek-ai/dsh-user-questions'
// The plan-mode fold for the header badge.
import { foldPlanMode } from '@deepseek-ai/dsh-plan-mode'
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
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
// P5e merges: shell capability for `!` mode and credentials for /login.
import type {} from '@deepseek-ai/dsh-shell'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { TUI_STARTUP_SERVICE } from './startup.ts'
import { toolPresenterFrom, type ToolDefinitionLike } from './present.ts'
import { childOwnEvents, textOf, TranscriptFolder } from './transcript.ts'
import type { TranscriptMessage } from './transcript.ts'
import { focusModeOf, installFocusPrompt, type FocusState } from './focus.ts'
import { formatStats, StatsFolder } from './stats.ts'
import { color, loadCustomTheme, resolveCustomTheme, type ColorPalette, type CustomThemeFile } from './theme.ts'
import { startProcessTui, type CompactionPhase, type QueueItem, type TuiApp } from './tui-app.ts'
import { Text } from '@xmoon76/pi-tui'
import { SurfaceHost } from './extension/internal/surface-host.ts'
import { PI_TUI_EXTENSIONS_SERVICE, type PiTuiExtensionService } from './extensions.ts'
import { buildTaskRows, rowGroup, taskRowLabel, type TaskBrowserRow } from './tasks-browser.ts'
import type { TaskPanelItem } from './task-panel.ts'
import { registerTuiCommands, type InitialCommandCatalog, type TuiCommandRunner } from './commands.ts'
import { customThemeNames } from './theme.ts'
import { diagFromEnv, dshHome, type Diag } from './diag.ts'
import { runDetached, runOwned, isCancellation, type OwnedTaskOptions } from './detached.ts'
import { appendHistoryLine, historyFilePath, loadHistoryFile } from './history.ts'
import { safeErrorMessage } from './error-boundary.ts'
import { DraftImageStore } from './image/draft-store.ts'
import { ImageInputError } from './image/errors.ts'
import { clipboardBackendOf, commandOnPath, createClipboardRunner, readClipboardImage, type ClipboardEnvironment } from './image/clipboard.ts'
import { buildOsc52Sequence, copyToClipboard, type CopyEnvironment, type CopyExecutor } from './clipboard.ts'
import { applyHomeEndKeyMode, homeEndKeysModeOf } from './home-end-keys.ts'
import { checkImageLimits } from './image/intake.ts'
import { ImageLoadError } from './image/errors.ts'
import { ImageLoader } from './image/loader.ts'
import { consumeDraftImages, draftHasImages, prepareUserMessage, pruneUnreferencedDrafts, type PrepareInputDeps } from './image/submit.ts'
import { runReservedSubmit } from './image/submit-flow.ts'
import { dshVersion } from './dsh-version.ts'
import { createExitController, type ExitSessionLike } from './exit.ts'
import { mergeDraft, steerAll, sessionUnchanged, type SteerAgentLike } from './steer.ts'
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
  subscribeSkillsChange,
  type HumanSkillCatalog,
  type SkillCatalogContext,
} from './skill-catalog.ts'
import {
  checkDivergence,
  draftFingerprint,
  forceTokenAllows,
  freshGuardState,
  mintForceToken,
  type GuardAction,
  type GuardForceToken,
  type GuardPersistenceLike,
  type GuardSessionLike,
  type GuardState,
} from './guard.ts'
import {
  acquireSessionLock,
  swapFailureLockRepair,
  type SessionLockInfo,
  type SessionLockPersistence,
} from './session-lock.ts'
import { createProcProbe, parseProcStat } from './session-lock-proc.ts'
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
}

export const Config: z<Config> = z.object({
  sessionId: z.string(),
})

/**
 * Wire the credential surface refresh to the dsh 0.1.1-rc.1 credential
 * events. The rc.1 release split the credential update event into the
 * reference half and the durable-record half; both change what the footer
 * model row and the welcome card show (a /login /logout, an external
 * .credentials.yaml edit, or an authorization flow committing a record), so
 * they share one best-effort callback. The callback must not read secrets
 * or mutate providers — it only re-reads describe-level state.
 */
export function registerCredentialSurfaceRefresh(ctx: Context, refresh: () => void): void {
  ctx.on('credentials/reference-updated', refresh)
  ctx.on('credentials/record-updated', refresh)
}

/** The launcher's bounded exit request; the TUI asks for it on Ctrl+C. */
interface AppExit {
  (code: number): void
}

/** Display window in turns; older turns collapse into a summary entry. */
const WINDOW_TURNS = 15
/** Coalesced repaint interval for streaming events, in ms. */
const REPAINT_FLUSH_MS = 50

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
  'exit', 'focus', 'settings', 'help', 'image', 'login', 'logout', 'model', 'reload',
  'sessions', 'resume', 'search', 'new', 'fork', 'preset',
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
  'copy', 'exit', 'export', 'focus', 'fork', 'help', 'image', 'kill', 'login', 'logout',
  'model', 'new', 'preset', 'quit', 'reload', 'rename', 'resume',
  'search', 'sessions', 'settings', 'skill', 'status', 'subagents', 'tasks',
  'title', 'yolo',
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
  const raw = parsed.rawInput.trim()
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
  readonly status: string
  cancel(cause: { kind: 'user' }, options?: { keepInbox?: boolean }): void
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
export function interruptAgent(agent: InterruptAgentLike | undefined): void {
  if (agent === undefined) return
  agent.cancel({ kind: 'user' }, { keepInbox: true })
}

/** One unsettled subagent delegation, in tool/call order. */
export interface PendingSubagentCall {
  readonly callId: string
  readonly description: string
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
}

export async function resolveInitialCatalog(options: ResolveInitialCatalogOptions): Promise<InitialCatalogResolution> {
  const { liveAgent, presetId, signal, ctx, diag } = options
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
 * Repaint the transcript from a folder's windowed message list.
 * @param app - the TUI surface.
 * @param folder - the incremental fold state for the live session.
 */
function repaint(app: TuiApp, folder: TranscriptFolder): void {
  // Messages AND the turn activities come from the SAME fold state: a
  // repaint must never show a stale Thought header against fresh rows
  // (plan §19).
  app.setTranscript(folder.messages({ maxTurns: WINDOW_TURNS }), folder.turnActivities())
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

/** Short cwd for the footer: last two path segments. */
function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || cwd
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

/** Divergence-guard notices (user-facing, English like the rest of the TUI). */
const GUARD_BLOCKED_NOTIFY = (action: GuardAction): string =>
  `This session may be open in another dsh process (TUI/web); send blocked. Press ${action === 'submit' ? 'Enter' : 'Ctrl+S'} again to force (may corrupt the session log)`
const GUARD_TAIL_MISMATCH_NOTIFY = (action: GuardAction): string =>
  `This session file was rewritten by another process (same event count, different content); send blocked. Press ${action === 'submit' ? 'Enter' : 'Ctrl+S'} again to force (may corrupt the session log)`
const GUARD_FORCED_NOTIFY = 'Forced send — the session may be written by another process; the log may be damaged'
const GUARD_REMOVED_NOTIFY = (action: GuardAction): string =>
  `This session's log was removed externally — it can no longer be persisted. Press ${action === 'submit' ? 'Enter' : 'Ctrl+S'} again to continue without persistence (restart to recover)`

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
 * @param selected - the mutable model selection every setup installs.
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
  selected: ModelSelectionRef,
  presetId?: string,
  focusState?: { enabled: boolean },
  diag?: Diag,
): Promise<AgentComposition> {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) {
    return {
      setup: (agentCtx: Context): void => {
        installModelSelection(agentCtx, selected)
        // Focus is a TUI surface policy: install it only when the runner
        // supplied the shared state (other callers — the headless tests —
        // keep the plain composition).
        if (focusState !== undefined) installFocusPrompt(agentCtx, focusState, diag)
      },
    }
  }
  const resolvedId = (await presets.resolve(presetId)).id
  return {
    agentPreset: resolvedId,
    setup: async (agentCtx: Context): Promise<void> => {
      installModelSelection(agentCtx, selected)
      await presets.mount(agentCtx, resolvedId)
      // Focus is a TUI surface policy, installed AFTER the preset mount so
      // it exists consistently across every preset (standard/code/minimal/
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
 * The preset a persisted session actually runs, from its log (newest
 * selection winning), or undefined when persistence is absent, the session is
 * unknown, or its log predates the roster.
 * @param ctx - the runner context.
 * @param sessionId - the persisted session id.
 * @returns the recorded preset id, or undefined to compose the default.
 */
export async function recordedPreset(ctx: Context, sessionId: string): Promise<string | undefined> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return undefined
  let header: SessionHeader | undefined
  try {
    header = (await persistence.list()).find(candidate => candidate.id === sessionId)
  } catch {
    return undefined
  }
  if (header === undefined) return undefined
  let events: readonly SessionEvent[] = []
  try {
    events = (await persistence.inspect(SessionId(sessionId))).events
  } catch {
    // Header-only fallback: an unreadable log still resumes under the
    // creation-time preset rather than the deployment default.
  }
  return resolveSessionPreset({ header, events })
}

/** The session surface {@link recomposeBlank} needs: its log and the append seam. */
export interface RecomposableSession {
  readonly id: string
  readonly events: readonly SessionEvent[]
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
  if (agent.session.events.some(event => event.type === 'turn/start')) return { kind: 'locked' }
  const preset = await presets.recompose(agent.ctx, id)
  agent.session.append('agent-preset/selected', { agentPreset: preset.id })
  return { kind: 'switched', preset: preset.id }
}

/** Set the terminal window title (OSC 0); a no-op without a TTY. */
function setTerminalTitle(title: string): void {
  if (process.stdout.isTTY === true) process.stdout.write(`\x1b]0;${title}\x07`)
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
  // shell) or generation checks (guard tokens, menu latches).
  const lifecycleController = new AbortController()

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
      settingsNamespace('dsh-pi-tui'),
      z.object({
        theme: z.string(),
        footer: z.string(),
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
        // Home/End navigation behavior (issue #9): 'viewport' (default)
        // keeps Home/End scrolling the fullscreen conversation; 'input'
        // makes Home/End move within the input (Ctrl+Home/End scroll).
        homeEndKeys: z.string(),
        // Focus Mode: 'on' collapses turn-intermediate activity into a
        // live Thought block (default 'off' — Focus OFF == current UI).
        focusMode: z.string(),
      }),
      // `history` used to live here (a per-cwd map in the settings
      // document). It moved to $DSH_HOME/user-history/*.jsonl (see
      // history.ts); the schema deliberately no longer carries it, so the
      // stored section drops the key on the next settings write.
      { base: { theme: 'auto', footer: 'full', fullscreen: 'on', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', focusMode: 'off' } },
    )
    // The ONE authoritative Focus runtime state (plan §5): restored from
    // the persisted document BEFORE the first compose/resume below, mutated
    // only through the runner's unified setFocusMode. The system-prompt
    // section and the TUI projection both read THIS object.
    const focusState: FocusState = { enabled: focusModeOf(tuiSettings?.get().focusMode) === 'on' }

    const selection = defaultModel.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    // P6: compose one preset per session when the roster is mounted; with no
    // roster this is exactly the headless shape (model-facing rows in the
    // host plane). The `selected` ref stays process-wide like before.
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    const compose = (presetId?: string): Promise<AgentComposition> => composeAgent(ctx, selected, presetId, focusState, diag)
    const withPresetMeta = (composition: AgentComposition): { agentPreset?: string } =>
      composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }

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
      // consumes. Each one degrades locally when absent (divergence guard →
      // unavailable, presets → default composition, commands → plain
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
    // (acquired at resume/switch, released on switch-away and at exit).
    // `undefined` means either no session yet (deferred start) or no lock
    // (deployment cannot lock — the guard still protects the write path).
    let heldLock: { sessionId: string; release: () => void } | undefined
    // The /proc probe for stale-lock takeover, created once per mount.
    const lockProc = createProcProbe()
    /** Try to take the open-time lock for a session. Returns the refusal text
     * when the session is held by another live dsh process (or unverifiable);
     * undefined when the lock is now ours (or the deployment cannot lock —
     * proceed as before). Never throws. */
    const acquireOpenLock = (sessionId: string, header?: { cwd?: string }): string | undefined => {
      const persistence = ctx.get('sessionPersistence') as SessionLockPersistence | undefined
      const outcome = acquireSessionLock(
        {
          persistence,
          fs: {
            readFileSync: (path) => readFileSync(path, 'utf8'),
            writeFileSync: (path, content, options) => writeFileSync(path, content, options),
            unlinkSync,
          },
          proc: lockProc,
        },
        { id: sessionId, header },
        selfLockInfo(),
      )
      switch (outcome.kind) {
        case 'acquired':
        case 'taken-over-stale':
          heldLock = { sessionId, release: outcome.release }
          if (outcome.kind === 'taken-over-stale') {
            diag.warn('session lock stale taken over', { session: sessionId })
          }
          return undefined
        case 'held':
          diag.warn('session lock held', { session: sessionId, pid: outcome.owner.pid })
          return lockHeldNotice(sessionId, outcome.owner)
        case 'unverifiable':
          diag.warn('session lock unverifiable', { session: sessionId, pid: outcome.owner?.pid })
          return outcome.owner === undefined
            ? `Session ${sessionId} has an unreadable or malformed lock file; refusing to open it here. If no other dsh process is using it, delete the owner.lock file next to the session log and retry.`
            : `Session ${sessionId} has a lock file whose owner (pid ${outcome.owner.pid}) cannot be verified; refusing to open it here. If that process is gone, delete the owner.lock file next to the session log and retry.`
        case 'unavailable':
          // No persistence/artifact/write access: proceed without a lock
          // (the divergence guard remains the write-path backstop).
          return undefined
      }
    }
    /** Release the open-time lock for a session (idempotent). */
    const releaseOpenLock = (sessionId: string): void => {
      if (heldLock === undefined || heldLock.sessionId !== sessionId) return
      heldLock.release()
      heldLock = undefined
    }
    /** Re-take the lock for the still-live current session after a failed
     * switch (refusal, resume failure, or an internal swap failure). The
     * lock was released before the target acquire, so another process may
     * have taken it in the window — the re-take result is checked and a
     * failed re-take surfaces as a notice (the write-path guard remains the
     * backstop, but the user must know the session is no longer locked by
     * this TUI). */
    const reacquireCurrentLock = (from: string | undefined, fromHeader?: { cwd?: string }): void => {
      if (from === undefined) return
      // The header determines the lock path: prefer the caller-supplied
      // from-header (correct even after `liveAgent` was reassigned), falling
      // back to the live header (the switchSession refusal/failure paths run
      // before any reassignment, so the live header is still from's).
      const refusal = acquireOpenLock(from, fromHeader ?? liveAgent?.session.header)
      if (refusal !== undefined) {
        const message = `the current session ${from} is no longer locked by this TUI (${refusal})`
        ctx.logger.warn(`tui-runner: ${message}`)
        diag.warn('session lock lost on failed switch', { session: from })
        app?.notify(message, 'error')
      }
    }

    // A stale --session id must not kill the TUI: resume falls back to a
    // fresh session and the failure is surfaced as a notify line.
    let resumeFailure: string | undefined
    let handle: Awaited<ReturnType<typeof agents.resume>> | undefined
    if (sessionId !== undefined) {
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
        // Refuse to resume a session another live dsh process holds: the
        // second open makes persistence synthesize interrupted-turn closers
        // into the shared log while the first process keeps appending from
        // its own in-memory seq — the classic seq-collision corruption the
        // write-path guard cannot catch (the second opener's memory matches
        // the file). Refusing here avoids the collision entirely.
        const lockRefusal = acquireOpenLock(sessionId, lockHeader)
        if (lockRefusal !== undefined) {
          throw new SessionLockRefusedError(lockRefusal)
        }
        // The stored session's recorded preset wins (resolved from the log,
        // not the header): a session that switched while blank ran every turn
        // under the newer composition, and rebuilding it differently would
        // replay tool calls the model can no longer make.
        const recorded = await recordedPreset(ctx, sessionId)
        const composition = await compose(recorded)
        handle = await agents.resume({
          resumeSessionId: SessionId(sessionId),
          agentOptions,
          setup: composition.setup,
        })
        diag.info('resume ok', {
          session: sessionId,
          seq: handle.agent.session.events.length,
          preset: recorded ?? 'default',
        })
        // A launch-time preset may still apply while the session is blank;
        // the blank check lives inside recomposeBlank (shared with /preset).
        if (launchPreset !== undefined && launchPreset !== recorded) {
          try {
            const outcome = await recomposeBlank(ctx, handle.agent, launchPreset)
            if (outcome.kind === 'locked') {
              const message = `session ${sessionId} has started; its agent preset ${recorded} is fixed, ignoring --preset ${launchPreset}`
              ctx.logger.warn(`tui-runner: ${message}`)
              diag.warn('preset ignored on resume', { session: sessionId, preset: launchPreset })
            }
          } catch (error) {
            const message = `--preset ${launchPreset} not applied on resume: ${safeErrorMessage(error)}`
            ctx.logger.warn(`tui-runner: ${message}`)
            diag.warn('preset not applied on resume', { session: sessionId, preset: launchPreset, error: message })
          }
        }
      } catch (error) {
        // A lock refusal is NOT recoverable by falling back to a fresh
        // session: the user asked for a specific held session. Re-throw so
        // the runner exits with the refusal as the message.
        if (error instanceof SessionLockRefusedError) {
          throw error
        }
        const message = safeErrorMessage(error)
        ctx.logger.warn(`tui-runner: resume ${sessionId} failed: ${message}`)
        diag.error('resume failed', { session: sessionId, error: message })
        resumeFailure = `session ${sessionId} could not be resumed; started a fresh session`
        // The failed target's lock (if we took one) must not leak: we are
        // about to hand the surface to a different session.
        releaseOpenLock(sessionId)
        const launched = await launchComposition()
        if (launched.failure !== undefined) resumeFailure = launched.failure
        handle = await agents.create({
          sessionId: SessionId(`session-${randomUUID()}`),
          meta: { cwd: process.cwd(), ...withPresetMeta(launched.composition) },
          agentOptions,
          setup: launched.composition.setup,
        })
        // The fallback session is now a real persisted artifact: take its
        // open lock like any other created session.
        acquireOpenLock(handle.agent.session.id, handle.agent.session.header)
      }
    } else {
      // Deferred session creation: without --session the TUI opens with NO
      // session at all — zero agent, zero log, zero persistence — and the
      // first user message creates it (see ensureSession below).
    }
    let liveHandle = handle
    let liveAgent = handle?.agent
    if (liveAgent !== undefined) await liveAgent.whenIdle()
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
        diag.warn('preset resolution failed at startup', { error: safeErrorMessage(error) })
      }
      const resolution = await resolveInitialCatalog({
        liveAgent,
        presetId: effectivePresetId,
        signal: lifecycleController.signal,
        ctx: ctx as unknown as SurfaceCatalogContext,
        diag,
      })
      initialSnapshot = resolution.snapshot
      initialSkills = resolution.skills
      surfaceNotice = resolution.notice
    }
    // Cross-process divergence guard state for the live session; reset on
    // every session switch (the cursor is per-session).
    let guardState: GuardState = freshGuardState()
    // One-time force-override token (replaces the never-reliable boolean):
    // a blocked submission mints it binding session/revision/action/draft;
    // the second identical operation consumes it and forces through. Cleared
    // by every event that could invalidate it: a clean guard read (new file
    // revision), session switch, turn boundaries, cancel, and TUI exit.
    let guardToken: GuardForceToken | undefined
    /** The guard verdict for one submission: proceed (ok/unavailable), force
     * through (forced), or refuse with the specific divergence kind. */
    type GuardVerdict =
      | { kind: 'ok' }
      | { kind: 'forced' }
      | { kind: 'unavailable' }
      | { kind: 'blocked'; reason: 'diverged' | 'tail-mismatch' | 'unreadable' | 'removed' }
    /**
     * Run the divergence guard before a session-writing submission. Returns
     * 'ok' to proceed, 'blocked' to refuse (the caller restores the draft),
     * 'forced' when the user overrode a still-bad state, and 'unavailable'
     * when the deployment cannot guard (proceed). `action` distinguishes
     * Enter submit from Ctrl+S save; `draft` feeds the fingerprint so an
     * edited draft can never ride an old token.
     */
    const guardSend = async (action: GuardAction, draft: string): Promise<GuardVerdict> => {
      if (liveAgent === undefined) return { kind: 'ok' }
      const session: GuardSessionLike = {
        id: liveAgent.session.id,
        header: liveAgent.session.header,
        events: liveAgent.session.events,
      }
      const persistence = ctx.get('sessionPersistence') as GuardPersistenceLike | undefined
      const outcome = await checkDivergence(persistence, session, (path) => statSync(path), guardState)
      const candidate = {
        sessionId: session.id,
        revision: outcome.revision,
        action,
        draftFingerprint: draftFingerprint(draft),
      }
      const forceOrBlock = (reason: 'diverged' | 'tail-mismatch' | 'unreadable' | 'removed'): GuardVerdict => {
        const token = guardToken
        if (forceTokenAllows(token, candidate)) {
          const fromRevision = token.revision
          guardToken = undefined
          diag.info('guard forced', { session: session.id, action, fromRevision, toRevision: outcome.revision })
          return { kind: 'forced' }
        }
        guardToken = mintForceToken(candidate)
        return { kind: 'blocked', reason }
      }
      switch (outcome.kind) {
        case 'ok':
          // A clean read observed a (possibly new) file revision: any older
          // token is stale by construction.
          guardToken = undefined
          diag.debug('guard ok', { session: session.id, fileEvents: outcome.fileEvents ?? 0, memoryEvents: session.events.length })
          return { kind: 'ok' }
        case 'diverged':
          diag.warn('guard diverged', {
            session: session.id,
            fileEvents: outcome.fileEvents,
            memoryEvents: outcome.memoryEvents,
          })
          return forceOrBlock('diverged')
        case 'tail-mismatch':
          diag.warn('guard tail mismatch', {
            session: session.id,
            fileEvents: outcome.fileEvents,
            memoryEvents: outcome.memoryEvents,
            fileTail: outcome.fileTail,
            memoryTail: outcome.memoryTail,
          })
          return forceOrBlock('tail-mismatch')
        case 'removed':
          // The log was deleted externally while this process held it: the
          // next append would ENOENT. Block with a dedicated notice; the
          // second identical Enter can still force (may lose persistence).
          diag.warn('guard removed', { session: session.id, revision: outcome.revision })
          return forceOrBlock('removed')
        case 'unreadable':
          diag.error('guard unreadable', { session: session.id, error: outcome.error })
          return forceOrBlock('unreadable')
        case 'unavailable':
          guardToken = undefined
          return { kind: 'unavailable' }
      }
    }
    /** The preset the live agent runs on, when the deployment composes one. */
    const currentPreset = (): string | undefined => {
      if (liveAgent === undefined) return undefined
      return ctx.get('agentPresets')?.composedPreset(liveAgent.ctx) ?? resolveSessionPreset(liveAgent.session)
    }
    // Incremental fold state for the live session's log; reset on switch. The
    // folder/stats/goal stay empty until a session exists (deferred start).
    let folder = new TranscriptFolder()
    let statsFolder = new StatsFolder()
    let goalText: string | undefined
    if (liveAgent !== undefined) {
      folder.apply(liveAgent.session.events)
      statsFolder.apply(liveAgent.session.events)
      goalText = foldGoal(liveAgent.session.events)
    }

    /** Repaint the welcome card from the live agent's current facts. Re-read
     * on every call so a still-blank session's preset switch shows up. */
    const updateWelcomeCard = (): void => {
      if (liveAgent === undefined) {
        app.setWelcomeIdle(true)
        return
      }
      app.setWelcomeCard({
        cwd: sessionCwd(),
        sessionId: liveAgent.session.id,
        model: `${liveAgent.options.provider}/${liveAgent.options.model}`,
        version: packageVersion(),
        ...currentPreset() === undefined ? {} : { preset: currentPreset() },
      })
    }

    /** Swap the live agent to a new handle, repainting for its session. */
    const swapTo = async (next: Awaited<ReturnType<typeof agents.resume>>): Promise<string | undefined> => {
      const from = liveAgent?.session.id
      // The from-session's header, captured BEFORE the swap: the repair path
      // must re-acquire from's lock with FROM's cwd even when the failure
      // happens after `liveAgent` was reassigned to the incoming session
      // (a whenIdle throw) — the live header would then be the wrong one for
      // a cross-cwd switch.
      const fromHeader = liveAgent?.session.header
      try {
        if (liveAgent !== undefined) {
          // Flush BEFORE releasing the old session's open lock: the lock must
          // cover the old session's last durable write, so a racing opener
          // cannot resume the session while our flush is still appending from
          // our in-memory seq (dsh's prepare would synthesize closers into
          // the shared log and collide with our flush — the exact corruption
          // the lock exists to prevent).
          await sessions.flush(liveAgent.session)
          await liveHandle?.dispose()
        }
        liveHandle = next
        liveAgent = next.agent
        await liveAgent.whenIdle()
      } catch (error) {
        const message = safeErrorMessage(error)
        diag.error('swap failed', { from, error: message })
        // Repair the lock tracker after an internal swap failure — the
        // decision matrix lives in swapFailureLockRepair (pure, headless-
        // tested) so the three shapes (/new-/fork holding from, switchSession
        // holding the target, switchSession with an unavailable target
        // acquire) cannot silently regress.
        const repair = swapFailureLockRepair(heldLock, from)
        if (repair.release !== undefined) releaseOpenLock(repair.release)
        if (repair.reacquire !== undefined) reacquireCurrentLock(repair.reacquire, fromHeader)
        return `swap failed: ${message}`
      }
      // The old session is now fully flushed: release its lock. (A switch
      // that never acquired one is a no-op; a switch that already released
      // via switchSession is idempotent by session id.)
      if (from !== undefined) releaseOpenLock(from)
      // The new session is now ours: take its open lock. This covers EVERY
      // swapTo caller — /resume, /sessions, /new and /fork — so a session
      // created or resumed by this TUI always carries a lock. A caller that
      // already acquired it (switchSession) hits the same-process shortcut
      // and is a no-op. A refusal here is defensive-only (a fresh UUID or a
      // pre-checked switch cannot be held); the write-path guard still
      // protects the session.
      const swapLockRefusal = acquireOpenLock(next.agent.session.id, next.agent.session.header)
      if (swapLockRefusal !== undefined) {
        ctx.logger.warn(`tui-runner: lock refused on swap to ${next.agent.session.id}: ${swapLockRefusal}`)
        diag.warn('session lock refused on swap', { session: next.agent.session.id })
      }
      guardState = freshGuardState()
      guardToken = undefined
      // A new session owns the surface: bump the generation so late async
      // work from the old session cannot commit, and clear old-session state.
      bumpSessionGeneration()
      await initLiveSession(next.agent)
      // The new owner's catalog refresh is AWAITED before the switch is
      // reported: the old wrappers became revalidating transitions at the
      // target change, and the report must not precede the new catalog (a
      // failed attempt still returns a successful switch — the coordinator
      // warns and the transition commands keep re-validating).
      await refreshLiveCatalog(next.agent)
      diag.info('switch ok', { from: from ?? '(none)', to: next.agent.session.id, seq: next.agent.session.events.length })
      return undefined
    }

    /** Hand the TUI over to another persisted session. Never throws: every
     * failure (unknown session, broken log, preset mount) returns an error
     * string so callers' `.then(error => ...)` need no rejection path. */
    const switchSession = async (sessionId: string): Promise<string | undefined> => {
      // Draft cleanup happens ONLY after the switch committed (swapTo
      // returned success): a refused/failed switch keeps the CURRENT
      // session and its staged drafts intact — clearing up front would
      // orphan the editor's placeholders on every failed switch (review
      // finding 2).
      try {
        // The tracker is a single slot: acquiring the target first would
        // overwrite it, leaving the current session's lock leaked for the
        // whole TUI lifetime (swapTo's release-by-id would then be a no-op).
        // So release the current lock BEFORE taking the target's. If the
        // target is refused, re-take the current lock — the current session
        // stays live and must stay protected. (Flushing happens inside
        // swapTo, which runs after this acquire.)
        const from = liveAgent?.session.id
        if (from !== undefined) releaseOpenLock(from)
        // Refuse to switch into a session another live dsh process holds —
        // same corruption risk as the --session launch path.
        let lockHeader: { cwd?: string } | undefined
        try {
          const persistence = ctx.get('sessionPersistence')
          lockHeader = (await persistence?.list())?.find(candidate => candidate.id === sessionId)
        } catch {
          // Best-effort; the resume path reports failures.
        }
        const lockRefusal = acquireOpenLock(sessionId, lockHeader)
        if (lockRefusal !== undefined) {
          ctx.logger.warn(`tui-runner: switch to ${sessionId} refused: ${lockRefusal}`)
          diag.warn('session lock held on switch', { session: sessionId })
          // The switch did not happen: the current session is still live and
          // must keep its lock (best-effort — an unavailable deployment has
          // no lock to re-take and the guard still protects the write path).
          reacquireCurrentLock(from)
          return lockRefusal
        }
        // The target session's recorded preset, exactly like the resume path.
        const composition = await compose(await recordedPreset(ctx, sessionId))
        const next = await agents.resume({
          resumeSessionId: SessionId(sessionId),
          agentOptions: {
            provider: liveAgent?.options.provider ?? selection.provider,
            model: liveAgent?.options.model ?? selection.model,
          },
          setup: composition.setup,
        })
        const error = await swapTo(next)
        // The switch COMMITTED: staged drafts are per-session UI state —
        // drop the UNPINNED ones now (never durable attachments, plan
        // §14). In-flight submissions keep their pinned drafts so a stale
        // submission can still restore its text with a live backing draft
        // (review finding: clear() would orphan the restored placeholders).
        if (error === undefined) draftImages.clearUnpinned()
        return error
      } catch (error) {
        const message = safeErrorMessage(error)
        ctx.logger.warn(`tui-runner: switch to ${sessionId} failed: ${message}`)
        diag.error('switch failed', { session: sessionId, error: message })
        // If the resume failed after we took the target's lock, release it so
        // the target session is not left locked for a session we never
        // entered. The CURRENT session is still live (the switch failed):
        // re-take its lock, which was released before the target acquire.
        releaseOpenLock(sessionId)
        reacquireCurrentLock(liveAgent?.session.id)
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
    const refreshStatus = (): void => {
      const stats = statsFolder.snapshot()
      let contextTokens: number | undefined
      const meter = ctx.get('tokenMeter')
      if (meter !== undefined && liveAgent !== undefined) {
        try {
          contextTokens = meter.measure(liveAgent.session).totalTokens
        } catch {
          // Measurement is best-effort; the footer falls back to no context.
        }
      }
      // The footer's [yolo]/[workspace-write]/[read-only]/[custom] mode badge
      // rides the effective preset (derived from the sandbox+approval knob
      // folds).
      const permission = ctx.get('permissionPresets')
      const liveCwd = sessionCwd()
      app.setStatus({
        model: modelLabel(),
        cwd: shortCwd(liveCwd),
        branch: gitBranch(liveCwd),
        goal: goalText,
        turns: stats.turns,
        steps: stats.steps,
        statsLine: formatStats(stats),
        ...permission === undefined || liveAgent === undefined
          ? {}
          : { permission: permission.current(liveAgent.session.events) },
        ...contextTokens !== undefined ? { contextTokens, contextWindow: stats.contextWindow } : {},
      })
    }

    let app: TuiApp
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
      _recordRegistryError(slot: string, id: string, error: unknown): void
      _clearRegistryError(slot: string, id: string): void
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
    // Idempotent teardown: abort lifecycle loads, stop the TUI, close diag.
    // Shared by /exit, the effect cleanup, and the startup-failure path.
    let cleanedUp = false
    const cleanup = (): void => {
      if (cleanedUp) return
      cleanedUp = true
      // A pending force token is stale once the process tears down.
      guardToken = undefined
      // Release the open-time lock for the session we hold: a clean exit
      // must leave the session openable immediately. (A crash skips this —
      // the stale-lock takeover on the next open handles that.)
      if (heldLock !== undefined) {
        heldLock.release()
        heldLock = undefined
      }
      lifecycleController.abort()
      // Abort any in-flight catalog refresh: its late result must never
      // register commands or repaint after the app is gone.
      catalogCoordinator?.dispose()
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
      // Detach the extension service's surface bridge (its capability set
      // and state listeners die with the surface). The surfaceId lease
      // makes a stale detach a no-op (P1).
      extensionService?.detachSurface(extensionHost?.surfaceId)
      extensionHost = undefined
      diag.dispose()
    }
    // The ONE exit orchestration, shared by every exit entry (Ctrl+C, Ctrl+D,
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
     * guarded user message (kimi parity: the model sees both on the next
     * turn; the result wakes a turn but is never steered into a running
     * one); `!!` (local mode) runs purely off-session — the card is the
     * only record (pi's excluded-from-context escape hatch).
     */
    const runLocalShell = (text: string): void => {
      const includeInContext = shellModeOf(text) === 'context'
      const command = shellCommandOf(text)
      if (command === '') return
      // The generation the run STARTED under: a session switch while the
      // command runs must not post the output into the new session (the
      // switch already cleared the card; the notify explains what happened).
      const generationAtRun = sessionGeneration
      localShellController?.abort()
      localShellController = new AbortController()
      const localSignal = localShellController.signal
      // The card reference this run owns: settling by identity keeps a
      // settled old run from overwriting a newer run's card (updateLastLocal
      // Message would hit whatever card is newest at settle time).
      const card = app.pushLocalMessage({
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
       * Submit the completed run to the session (context mode only): guard
       * → re-validate → followup. Blocked keeps the card (the output stays
       * visible; the identical `!` re-run forces through its one-time guard
       * token); accepted clears the settled card — the transcript's user
       * row becomes the record. An owned workflow: the outcome drives the
       * notify and the card — runOwned (AGENTS.md), never a bare void.
       */
      const submitResult = (result: string): void => {
        // A session switch while the command ran: the output must not be
        // posted into a session the user has left (the switch already
        // cleared the card; the notify explains what happened). The
        // guard-window switch (between the guard read and the followup) is
        // caught by submitShellResult's own re-validation.
        if (sessionGeneration !== generationAtRun) {
          app.notify('the session changed while the command ran — the output was not submitted', 'error')
          return
        }
        const submitted = formatShellSubmitText(command, result)
        runOwned('shell submit', () => submitShellResult({
          currentAgent: () => liveAgent as unknown as ShellSubmitAgentLike | undefined,
          currentGeneration: () => sessionGeneration,
          guard: {
            run: async (identity) => {
              const verdict = await guardSend('submit', identity)
              if (verdict.kind === 'blocked') {
                return { kind: 'blocked', reason: verdict.reason }
              }
              return { kind: verdict.kind === 'forced' ? 'forced' : 'ok' }
            },
          },
          notify: (message, kind) => app.notify(message, kind),
          blockedNotice: (reason) => reason === 'removed'
            ? `This session's log was removed externally — the command output was not submitted (it stays on the card). Run the same ! command again to force`
            : reason === 'tail-mismatch'
              ? 'This session file was rewritten by another process (same event count, different content) — the command output was not submitted (it stays on the card). Run the same ! command again to force (may corrupt the session log)'
              : reason === 'unreadable'
                ? "This session's log could not be read (locked or corrupt) — the command output was not submitted (it stays on the card). Run the same ! command again to force (may corrupt the session log)"
                : 'This session may be open in another dsh process (TUI/web) — the command output was not submitted (it stays on the card). Run the same ! command again to force (may corrupt the session log)',
          forcedNotice: () => GUARD_FORCED_NOTIFY,
          staleNotice: () => 'the session changed while the submission was being checked — the output was not submitted',
          createMessage: (text) => createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }),
          onSubmitted: () => app.clearSettledLocalMessages(),
        }, submitted), {
          diag,
          sessionId: () => liveAgent?.session.id,
          onError: (error) => {
            // The submission failed before the guard ran: keep the card
            // (the output is not lost) and surface the reason.
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
        // run was cancelled; the partial output is noise).
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
        const spec = shell.resolve({ command, workdir: sessionCwd(), signal: localSignal })
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
          onCancel: () => {
            // An abort-triggered rejection is a cancellation: settle the
            // card as aborted like the resolved path does.
            releaseController()
            settle('aborted', 'error')
          },
          onError: (error) => {
            releaseController()
            const message = safeErrorMessage(error)
            settle(`failed: ${message}`, 'error')
          },
        })
        return
      }
      const child = spawn(command, { cwd: sessionCwd(), stdio: ['ignore', 'pipe', 'pipe'], shell: true })
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
      const onData = (decoder: StringDecoder, chunk: Buffer): void => {
        // The wire byte count rides along: an incomplete multi-byte
        // sequence buffered by the decoder produces no text yet, but its
        // bytes are real and must count toward the totals.
        bounded.append(decoder.write(chunk), chunk.length)
        full.append(chunk)
      }
      child.stdout.on('data', (chunk) => onData(stdoutDecoder, chunk))
      child.stderr.on('data', (chunk) => onData(stderrDecoder, chunk))
      localSignal.addEventListener('abort', () => child.kill(), { once: true })
      child.on('error', (error) => {
        releaseController()
        // A spawn failure leaves nothing worth keeping: drop the capture.
        full.dispose()
        shellTempFiles.delete(fullPath)
        settle(`failed: ${error.message}`, 'error')
      })
      child.on('close', (code, childSignal) => {
        releaseController()
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
    // session's log read-only and Esc returns to the parent session.
    let viewing: { id: SessionId; folder: TranscriptFolder } | undefined
    // Unsettled subagent delegations in the live session, in tool/call order.
    // The viewer matches one of these by description when the user opens a
    // child transcript, so the child's tool/result can pop the viewer back.
    const pendingSubagentCalls: { callId: string; description: string }[] = []
    // callId → child session id, established when the user opens a child's
    // transcript (see enterView). Consumed on the matching tool/result.
    const viewCallToChild = new Map<string, SessionId>()
    const activeFolder = (): TranscriptFolder => viewing?.folder ?? folder
    const paintNow = (): void => {
      if (repaintTimer !== undefined) {
        clearTimeout(repaintTimer)
        repaintTimer = undefined
      }
      repaint(app, activeFolder())
    }
    const schedulePaint = (): void => {
      if (repaintTimer !== undefined) return
      repaintTimer = setTimeout(() => {
        repaintTimer = undefined
        repaint(app, activeFolder())
      }, REPAINT_FLUSH_MS)
    }
    // Tool-call arguments by callId, for the approval-preview dialog.
    const callArgs = new Map<CallId, string>()
    // The in-flight compaction's id (paired start/end in the firehose): a
    // stale end must never clear a NEWER compaction's footer/busy state.
    let compactingId: string | undefined
    // Transcript-search state (see the onSearch* events below).
    let searchMatches: TranscriptMessage[] = []
    let searchCurrent = -1
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
      searchMatches = []
      searchCurrent = -1
      app.setSearchResult(0, 0)
      app.clearSessionOverrides()
      return sessionGeneration
    }
    const jumpToSearchMatch = (): void => {
      const match = searchMatches[searchCurrent]
      if (match === undefined) return
      const turn = 'turn' in match ? match.turn : undefined
      // ONE fold snapshot: the anchored message window and the activities
      // come from the same folder call (plan §19 — a jump must never
      // combine a fresh window with stale activity data).
      const folder = activeFolder()
      app.setTranscript(folder.messages({
        maxTurns: WINDOW_TURNS,
        ...turn === undefined ? {} : { endTurn: turn },
      }), folder.turnActivities())
      // Focus Mode: the search hits the FULL transcript (hidden process
      // rows included — plan §23), so a jump into a collapsed turn must
      // open its Thought for the hit to be visible. The disclosure is not
      // reverted when search closes.
      if (turn !== undefined && app.isFocusModeEnabled()) {
        app.expandFocusTurn(turn)
      }
      app.setSearchResult(searchCurrent + 1, searchMatches.length)
    }
    /** Enter the read-only subagent viewer for one session (live or persisted). */
    const enterView = async (childId: SessionId, label?: string): Promise<void> => {
      const childFolder = new TranscriptFolder()
      // Only the child's OWN events enter the viewer: a fork provider seeds
      // the child with the parent's completed-turn history (session/end-seed
      // boundary), and the parent's records — its subagent completion
      // notices included — must never render as the child's transcript.
      const child = sessions.get(childId)
      if (child !== undefined) {
        childFolder.apply(childOwnEvents(child.events))
      } else {
        // An inactive child is no longer in the live store; load its log.
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined) {
          try {
            childFolder.apply(childOwnEvents((await persistence.inspect(childId)).events))
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
      const matched = matchPendingSubagentCall(pendingSubagentCalls, label)
      if (matched !== undefined) viewCallToChild.set(matched.callId, childId)
      viewing = { id: childId, folder: childFolder }
      // The child's turn numbers are its OWN namespace: the parent's Focus
      // disclosures must not leak into the child transcript (plan §26).
      app.enterFocusViewerScope()
      repaint(app, childFolder)
      // The viewer bar covers the editor (read-only placeholder, accent
      // border) and the header badges the mode — the transient notify is
      // no longer the only "you are elsewhere" signal.
      app.setViewerMode({ id: childId, label: label ?? childId })
    }
    /** Leave the subagent viewer (single Esc). Returns whether it exited. */
    const exitView = (): boolean => {
      if (viewing === undefined) return false
      viewing = undefined
      app.clearLocalMessages()
      app.clearNotify() // a viewer notify (if any) is stale now
      app.setViewerMode(undefined)
      // Restore the parent's Focus disclosures BEFORE the repaint so the
      // projection uses them (plan §26).
      app.exitFocusViewerScope()
      repaint(app, folder)
      // The main transcript may have grown while the viewer covered it (the
      // child's result, the parent's streaming): anchor the view to the end
      // so the pop lands on the latest content, not a stale scroll position.
      app.scrollToBottom()
      refreshStatus()
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
    /**
     * Notify one submission failure WITHOUT restoring (the task's catch
     * already restored; restoring twice would re-merge the draft). Image
     * intake/admission/capability failures are THEIR OWN actionable errors
     * ("Current model ... does not support image input") — wrapping them in
     * "could not start a session" misleads when a session already exists.
     * Diagnostics are owned by runOwned.
     */
    const notifySubmissionFailure = (error: unknown): void => {
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
     * user input is the deferred trigger), guard against cross-process
     * divergence, then execute a registered slash command or follow up. */
    const dispatchViaSession = (text: string): void => {
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
        reserve: (t) => draftImages.pinReferenced(t),
        run: async () => {
        await ensureSession()
        const agent = liveAgent
        if (agent === undefined) return
        // The guard checks THIS agent's session; capture the identity so
        // the write below can never target a session the guard did not see
        // (a session switch while the file read is in flight).
        const generation = sessionGeneration
        // Divergence guard: another dsh process may be writing this session.
        // Blocked submissions restore the draft so a second identical Enter
        // forces through (the user's explicit override, logged and warned).
        const verdict = await guardSend('submit', text)
        if (verdict.kind === 'blocked') {
          const merged = mergeDraft(app.getDraft(), text)
          app.setEditorText(merged)
          app.notify(merged === text
            ? (verdict.reason === 'removed'
              ? GUARD_REMOVED_NOTIFY('submit')
              : verdict.reason === 'tail-mismatch'
                ? GUARD_TAIL_MISMATCH_NOTIFY('submit')
                : GUARD_BLOCKED_NOTIFY('submit'))
            : 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)', 'error')
          return
        }
        // TOCTOU re-validation: the session must be the exact one the
        // guard checked, or the submission is aborted for a retry against
        // the new session (which needs its own guard).
        if (!sessionUnchanged({ agent, generation }, liveAgent, sessionGeneration)) {
          const merged = mergeDraft(app.getDraft(), text)
          app.setEditorText(merged)
          app.notify(merged === text
            ? 'the session changed while sending — try again'
            : 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)', 'error')
          return
        }
        if (verdict.kind === 'forced') {
          app.notify(GUARD_FORCED_NOTIFY, 'error')
        }
        // From here on the CAPTURED agent is used — never the mutable
        // liveAgent: the guard verified THIS agent's session, and writing
        // through a re-read closure variable could target a session the
        // guard never saw (a switch between the check and the write).
        const commands = ctx.get('commands')
        if (commands !== undefined) {
          // Bare `/plan` toggles: when plan mode is already active it exits
          // instead of re-entering (the official command needs `/plan off`).
          const parsed = parseCommand(text)
          const toggled = parsed?.name === 'plan' && parsed.rawInput.trim() === ''
            && foldPlanMode(agent.session.events ?? [])
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
          runOwned('command execution', () => commands.execute(agent as Agent, toggled, [], signal), {
            diag,
            sessionId: () => agent.session.id,
            onResult: (execution) => {
              if (extensionCommandId !== undefined && execution !== undefined) {
                extensionService?._clearRegistryError('command', extensionCommandId)
              }
              // A command the surface advertised (e.g. from the startup
              // probe) but the real session's catalog lacks: consume the
              // slash input with an explicit error — never a plain model
              // message, never an automatic draft restore (the refreshed
              // completions already revoked the claim, and a mechanical
              // retry could ride the unadvertised fallback).
              if (shouldConsumeAdvertisedMiss(execution, wasAdvertised)) {
                app.notify(`/${parsedAtSubmit?.name ?? '?'} is not available in the created session`, 'error')
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
                      const message = await prepareUserMessage(text, draftImages, submitDeps)
                      // Re-check the captured session identity AFTER the
                      // async admission (the guard-window rule, AGENTS.md).
                      if (!sessionUnchanged({ agent, generation }, liveAgent, sessionGeneration)) {
                        const merged = mergeDraft(app.getDraft(), text)
                        app.setEditorText(merged)
                        app.notify(merged === text
                          ? 'the session changed while sending — try again'
                          : 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)', 'error')
                        return
                      }
                      agent.followup(message)
                      // Consume ONLY the referenced drafts — a concurrent
                      // intake's newer image survives (round-5 finding 1).
                      consumeDraftImages(text, draftImages)
                    },
                    restore: (t) => restoreSubmissionDraft(t),
                  }, text), {
                    diag,
                    sessionId: () => agent.session.id,
                    // The flow restored the editor; this sink only
                    // notifies.
                    onError: notifySubmissionFailure,
                  })
                } else {
                  fallbackPin()
                  const merged = mergeDraft(app.getDraft(), text)
                  app.setEditorText(merged)
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
              if (extensionCommandId !== undefined) extensionService?._recordRegistryError('command', extensionCommandId, error)
              const message = safeErrorMessage(error)
              try {
                ctx.logger.error(`tui-runner: command execution failed: ${message}`)
              } catch {
                // The cordis logger must not block the user notice.
              }
              app.notify(message, 'error')
            },
          })
          return
        }
        // No commands service: plain follow-up on the CAPTURED agent (see
        // the note above — never a re-read closure variable). Images ride
        // the same prepared message as every other path (§13).
        const message = await prepareUserMessage(text, draftImages, submitDeps)
        // Re-check the captured session identity AFTER the async admission
        // (the guard-window rule, AGENTS.md).
        if (!sessionUnchanged({ agent, generation }, liveAgent, sessionGeneration)) {
          const merged = mergeDraft(app.getDraft(), text)
          app.setEditorText(merged)
          app.notify(merged === text
            ? 'the session changed while sending — try again'
            : 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)', 'error')
          return
        }
        agent.followup(message)
        // Consume ONLY the referenced drafts — a concurrent intake's newer
        // image survives (round-5 finding 1).
        consumeDraftImages(text, draftImages)
        },
        restore: (t) => restoreSubmissionDraft(t),
      }, text), {
        diag,
        sessionId: () => liveAgent?.session.id,
        // The flow restored the editor; this sink only notifies.
        onError: notifySubmissionFailure,
      })
    }
    /**
     * Run a sessionless slash command locally — no session, no log, no
     * persistence. The handler comes from the commands service's global
     * layer (in-process lookup with no agent is safe: it reads the global
     * layer only). A sessionless command that failed to register falls back
     * to the session dispatch, which reports unknown commands as messages.
     */
    const runLocalCommand = (parsed: { name: string; rawInput: string }, text: string): void => {
      // M5: a plugin-declared local command with a bridge handler routes
      // to the bridge FIRST (its rawInput is passed verbatim — never
      // re-parsed or rewritten, the skill rawInput regression gate); the
      // commands service is the fallback for core commands.
      const bridgeHandler = extensionService?.commands.handlerFor(parsed.name)
      const bridgeCommandId = extensionService?.commands.idFor(parsed.name)
      const commands = ctx.get('commands')
      const definition = commands?.find(undefined as unknown as Agent, parsed.name)
      if (bridgeHandler === undefined && (commands === undefined || definition === undefined)) {
        dispatchViaSession(text)
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
        dispatchViaSession(text)
        return
      }
      // An owned workflow: the result decides the notify, the failure lands
      // in diagnostics — runOwned (AGENTS.md), never a bare void. The
      // handler may be a SYNC implementation, so the factory must run inside
      // runOwned (a sync throw would otherwise escape before the entry).
      runOwned('local command', () => handler(invocation), {
        diag,
        sessionId: () => liveAgent?.session.id,
        onResult: (result) => {
          if (result !== undefined && result.kind === 'error') {
            if (bridgeCommandId !== undefined) extensionService?._recordRegistryError('command', bridgeCommandId, new Error(result.text))
            app.notify(result.text)
          } else if (bridgeCommandId !== undefined) {
            extensionService?._clearRegistryError('command', bridgeCommandId)
          }
        },
        onError: (error) => {
          if (bridgeCommandId !== undefined) extensionService?._recordRegistryError('command', bridgeCommandId, error)
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
     * Steer into the running turn with guard re-validation. Shared by
     * Ctrl+S (the whole queue plus a non-empty draft) and the busy-Enter
     * preference — Enter while the agent is running with busyEnter=steer
     * steers the DRAFT ONLY (web busyEnter parity): explicitly queued
     * messages stay queued until Ctrl+S or the /queue actions, because
     * already-steered input cannot be pulled back.
     * @param text - the submitted draft ('' allowed for Ctrl+S).
     * @param onlyDraft - busy-Enter mode: never read or remove the queue.
     */
    const steerNow = (text: string, onlyDraft = false): void => {
      // The guard action is deliberately the Ctrl+S 'save' action (not
      // 'submit'): the busy-Enter steer writes the session like Ctrl+S,
      // and the one-time force token embeds the payload identity, so an
      // Enter-steer token can never cross-match a followup's token.
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
      if (onlyDraft) {
        if (text.trim() === '' && !draftHasImages(text, draftImages)) return
      } else if (liveAgent !== undefined) {
        const queued = [...liveAgent.inbox.nextTurn, ...liveAgent.inbox.nextStep]
        if (queued.length === 0 && text.trim() === '' && !draftHasImages(text, draftImages)) return
      } else if (text.trim() === '' && !draftHasImages(text, draftImages)) {
        return
      }
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
        await ensureSession()
        if (liveAgent === undefined) return
        // The draft message is prepared BEFORE the guard: admission is
        // async I/O, and the guard's identity is the draft text (which
        // carries the placeholders), so a guard run after admission
        // covers everything the send will write (§13).
        const prepared = await prepareUserMessage(text, draftImages, submitDeps)
        // The whole send (snapshot → guard → re-validate → confirm-and-
        // send) lives in steer.ts so the races are testable: a queue
        // splice or session switch while the guard reads the file aborts
        // with a retry notice instead of losing messages or writing to a
        // session the guard never checked.
        const outcome = await steerAll({
          currentAgent: () => liveAgent as unknown as SteerAgentLike,
          currentGeneration: () => sessionGeneration,
          guard: {
            run: async (identity) => {
              const verdict = await guardSend('save', identity)
              if (verdict.kind === 'blocked') {
                return { kind: 'blocked', reason: verdict.reason }
              }
              return { kind: verdict.kind === 'forced' ? 'forced' : 'ok' }
            },
          },
          notify: (message, kind) => app.notify(message, kind),
          restoreDraft: (draft) => {
            const merged = mergeDraft(app.getDraft(), draft)
            app.setEditorText(merged)
            return merged === draft
          },
          createDraft: () => prepared,
          blockedNotice: (reason) => reason === 'removed'
            ? GUARD_REMOVED_NOTIFY('save')
            : reason === 'tail-mismatch'
              ? GUARD_TAIL_MISMATCH_NOTIFY('save')
              : GUARD_BLOCKED_NOTIFY('save'),
          forcedNotice: () => GUARD_FORCED_NOTIFY,
          staleNotice: () => 'the queue or session changed while sending — try again',
          mergedNotice: () => 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)',
        }, text, onlyDraft ? { onlyDraft: true } : undefined)
        // Only a successful send consumes the drafts: on block/stale the
        // draft was restored and the images are still referenced — removing
        // would orphan the placeholders (§14). The consumption is
        // per-reference, so a concurrent intake's newer draft survives
        // (round-5 finding 1).
        if (outcome === 'ok') consumeDraftImages(text, draftImages)
        },
        restore: (t) => restoreSubmissionDraft(t),
      }, text), {
        diag,
        sessionId: () => liveAgent?.session.id,
        // The flow restored the editor; this sink only notifies.
        onError: notifySubmissionFailure,
      })
    }
    /**
     * The newest input-history entry this process persisted (kimi's
     * `lastHistoryContent` analogue): consecutive repeats are skipped per
     * window, exactly like shell history.
     */
    let lastHistoryContent: string | undefined
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
      // A MULTIMODAL submission (draft text referencing staged images) is
      // NOT persisted to the plain-text history: the placeholder dies with
      // its draft on consumeDraftImages, so an ↑ recall would re-send the
      // placeholder as ORDINARY TEXT — the images would silently vanish
      // from the model input (review finding 3). Structured attachment
      // history (text + refs, recalled on recall) is a post-v1 extension.
      if (trimmed !== '' && trimmed !== lastHistoryContent && !draftHasImages(text, draftImages)) {
        const file = historyFilePath(dshHome(process.env), sessionCwd())
        runDetached('input history write', () => {
          appendHistoryLine(file, trimmed, lastHistoryContent)
          lastHistoryContent = trimmed
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
          runLocalShell(text)
        } else if (shellCommandOf(text) !== '') {
          // An owned workflow: the session creation failure restores the
          // draft (failSubmission) — runOwned (AGENTS.md), never a bare
          // void.
          runOwned('contextual shell', () => ensureSession().then(() => runLocalShell(text)), {
            diag,
            sessionId: () => liveAgent?.session.id,
            onError: failSubmission(text),
          })
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
      if (parsed !== undefined && liveAgent === undefined && isSessionless) {
        runLocalCommand(parsed, text)
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
        // placeholders ride the normalized line untouched.
        steerNow(normalizeSkillInvocation(text) ?? text, true)
        return
      }
      dispatchViaSession(text)
    }
    // M3 runner wiring (F-1): when the extension host service is mounted,
    // the TUI surface attaches a SurfaceHost over its ledger — extensions
    // (including the first-party builtins) render into the chrome. Without
    // the service the surface runs exactly as before (host fallbacks).
    extensionService = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as typeof extensionService
    if (extensionService !== undefined) {
      extensionHost = new SurfaceHost(extensionService._ledger(), () => app.requestRender())
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
        // interrupt stops the current thinking, never the queued input. The
        // cancel also invalidates any pending force token (the guard state
        // may change while the turn is being torn down).
        guardToken = undefined
        localShellController?.abort()
        interruptAgent(liveAgent)
      },
      // M6: execute a plugin keybinding's SEMANTIC action through the
      // host's own paths (plan §2.2 — the host never lets a plugin bypass
      // submission/session safety).
      onExtensionAction: (action) => {
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
            app.setDraft('')
            steerNow(text)
            break
          }
          case 'cancel-activity': {
            guardToken = undefined
            localShellController?.abort()
            interruptAgent(liveAgent)
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
            const current = permission.current(liveAgent.session.events)
            const index = names.indexOf(current)
            const next = names[(index + 1) % names.length] ?? names[0]
            if (next === undefined || next === current) break
            permission.set(liveAgent.session, next)
            app.notify(next === 'danger-full-access'
              ? `⚠ ${next} — no approvals`
              : `permission: ${next}`,
            next === 'danger-full-access' ? 'error' : 'info')
            refreshStatus()
            break
          }
        }
      },
      onSteer: (text) => steerNow(text),
      onExtensionError: ({ slot, id, error }) => {
        try { extensionService?._recordRegistryError(slot, id, error) } catch {}
      },
      onExtensionRecovered: ({ slot, id }) => {
        try { extensionService?._clearRegistryError(slot, id) } catch {}
      },
      // Phase 4: the advanced host-state setTheme for a NON-built-in name
      // (a registered plugin theme). The runner resolves the palette
      // through the theme registry; unknown names are a no-op; a throwing
      // palette is recorded in the theme health slot.
      onAdvancedSetTheme: (name) => {
        const palette = extensionService?.themes.paletteFor(name)
        if (palette === undefined) return
        try {
          app.applyPalette(palette)
          extensionService?._clearRegistryError('theme', name)
        } catch (error) {
          extensionService?._recordRegistryError('theme', name, error)
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
      // Persist the Ctrl+F toggle (the settings panel writes the same field
      // itself); `tuiSettings` is declared later, so the closure reads it
      // lazily at toggle time. A failed write is user-recoverable.
      onFullscreenChange: (fullscreen) => {
        const settings = tuiSettings
        if (settings !== undefined) {
          runDetached('settings fullscreen write', () => settings.replace({ ...settings.get(), fullscreen: fullscreen ? 'on' : 'off' }), {
            diag,
            notify: (message) => app.notify(message, 'error'),
            recoverable: () => true,
          })
        }
      },
      // Transcript search (Ctrl+Shift+F): matches run over the FULL folded
      // transcript; each jump re-windows the view so the matched turn is
      // visible (older turns collapse above it into the summary entry).
      onSearchQuery: (query) => {
        const needle = query.trim().toLowerCase()
        const searchable = (message: TranscriptMessage): string =>
          message.kind === 'tool' ? `${message.name} ${message.args} ${message.result}` : message.text
        const full = folder.messages()
        searchMatches = needle === '' ? [] : full.filter(message => searchable(message).toLowerCase().includes(needle))
        searchCurrent = searchMatches.length > 0 ? 0 : -1
        app.setSearchResult(searchCurrent + 1, searchMatches.length)
        if (searchCurrent >= 0) jumpToSearchMatch()
      },
      onSearchNext: () => {
        if (searchMatches.length === 0) return
        searchCurrent = (searchCurrent + 1) % searchMatches.length
        jumpToSearchMatch()
      },
      onSearchPrev: () => {
        if (searchMatches.length === 0) return
        searchCurrent = (searchCurrent - 1 + searchMatches.length) % searchMatches.length
        jumpToSearchMatch()
      },
      onSearchClose: () => {
        searchMatches = []
        searchCurrent = -1
        repaint(app, activeFolder())
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
        const current = permission.current(liveAgent.session.events)
        const index = names.indexOf(current)
        const next = names[(index + 1) % names.length] ?? names[0]
        if (next === undefined || next === current) return
        permission.set(liveAgent.session, next)
        app.notify(next === 'danger-full-access'
          ? `⚠ ${next} — no approvals`
          : `permission: ${next}`,
        next === 'danger-full-access' ? 'error' : 'info')
        refreshStatus()
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
        for (const message of queued) liveAgent.inbox.remove(message.id)
        const current = app.getDraft()
        app.setDraft([recalledText, current].filter(part => part.trim() !== '').join('\n\n'))
        refreshQueue()
      },
      // ↓ / Ctrl+J with an empty editor: the task browser over BOTH
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
      // row-level `i` = interrupt on subagent rows (kimi's stop-on-row
      // pattern; the old /subagents SettingsList-submenu panel is gone).
      onOpenTasks: () => openTasksBrowser(),
    }, {
      // The transcript image surface (plan M8/M9): the durable loader plus
      // the dim fallback coloring.
      imageLoader,
      imageTheme: { fallbackColor: color.textDim },
      present,
      workspaceRoot: cwd,
      extensionHost,
      // Issue #7: the fullscreen drag selection copies through the SAME
      // shared policy as /copy (tmux → platform helper → OSC 52) — a bare
      // OSC 52 write is a silent lie under tmux `set-clipboard external`.
      copySelection: (text) => copyToClipboard(text, runCopyCommand, copyEnv),
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
    // cold children, so the picker opens on the jobs half and setItems
    // merges the rest in.
    //
    // The SAME browser is the `/tasks` surface (runner.openTasksBrowser):
    // the merged list + search is the single command-side entry, with
    // row-level `i` = interrupt on subagent rows (kimi's stop-on-row
    // pattern; the old /subagents SettingsList-submenu panel is gone).
    const openTasksBrowser = (): void => {
      if (liveAgent === undefined) return
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
      // a children-only session would never open the browser.
      let rows: TaskBrowserRow[] = buildTaskRows(jobSnapshots, [])
      const selectRow = (value: string): void => {
        const row = rows.find(candidate => candidate.value === value)
        if (row === undefined) return
        if (row.kind === 'subagent') {
          runOwned('subagent view from tasks', () => enterView(row.childId as SessionId, row.label), {
            diag,
            sessionId: () => liveAgent?.session.id,
            onError: (error) => app.notify(`could not open the subagent view: ${safeErrorMessage(error)}`, 'error'),
          })
          return
        }
        openJobView(row.jobId)
      }
      const actionRow = (value: string, action: 'interrupt'): void => {
        const row = rows.find(candidate => candidate.value === value)
        if (row === undefined || row.kind !== 'subagent') return
        const service = ctx.get('subagents')
        if (service === undefined || liveAgent === undefined) {
          app.notify('subagent service unavailable', 'error')
          return
        }
        service.interrupt(row.childId as SessionId, { kind: 'user', parentSessionId: liveAgent.session.id })
        app.notify(`interrupting ${row.label}`, 'info')
      }
      const taskPanelItems = (target: readonly TaskBrowserRow[]): TaskPanelItem[] =>
        target.map(row => row.kind === 'job'
          ? {
              value: row.value,
              label: taskRowLabel(row),
              status: row.status,
              detail: row.detail,
              startedAt: row.startedAt,
              group: rowGroup(row),
              // The Tab type filter: job rows filter by their job kind.
              type: row.jobKind,
            }
          : {
              value: row.value,
              label: taskRowLabel(row),
              status: row.activity,
              detail: row.hasChildren ? 'has children' : undefined,
              group: rowGroup(row),
              type: 'subagent',
            })
      const handle = app.openTaskBrowser(
        taskPanelItems(rows),
        selectRow,
        () => {},
        { header: 'tasks · subagents', enableSearch: true, onAction: actionRow },
      )
      if (subagents !== undefined) {
        const sessionId = liveAgent.session.id
        const generation = sessionGeneration
        runOwned('task browser children', () => subagents.listChildren(sessionId), {
          diag,
          sessionId: () => liveAgent?.session.id,
          onResult: (entries) => {
            // The browser belongs to the session it was opened for; a
            // switch while the listing was in flight must not repaint it.
            if (sessionGeneration !== generation || liveAgent?.session.id !== sessionId) return
            rows = buildTaskRows(jobSnapshots, entries)
            handle.setItems(taskPanelItems(rows))
          },
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
      app.setRendererErrorSink(({ id, error, slot }) => {
        const message = safeErrorMessage(error).replace(/\s+/g, ' ').slice(0, 200)
        const healthSlot = slot === 'tool' ? 'transcript.tool.renderer' : 'transcript.message.renderer'
        extensionService._ledger().recordError(healthSlot, id, message)
      })
      // M7 (P1-08): a renderer that renders successfully after a failure
      // RECOVERS — clear its health record (the next failure starts a NEW
      // error generation).
      app.setRendererRecoveredSink(({ id, slot }) => {
        const healthSlot = slot === 'tool' ? 'transcript.tool.renderer' : 'transcript.message.renderer'
        extensionService._ledger().clearError(healthSlot, id)
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
        (force) => app.requestRender(force),
      )
    }
    // Fullscreen is a persisted preference like the theme and the footer
    // (new installs default to 'on' — alt screen by default): boot applies
    // it FIRST so the alt screen owns the terminal input handler before any
    // theme query below targets "the active screen" — a query sent while the
    // main screen still owned input would have its reply swallowed by the
    // alt screen's OSC 11 consumer and time out, silently disabling `auto`.
    // Issue #9: the Home/End navigation preset is applied BEFORE the first
    // fullscreen frame so the first frame and later behavior agree (plan
    // §4.8); an invalid persisted value falls back to `viewport`.
    applyHomeEndKeyMode(homeEndKeysModeOf(tuiSettings?.get().homeEndKeys))
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
    } else if (storedTheme?.startsWith('custom:')) {
      const name = storedTheme.slice('custom:'.length)
      // M5: a plugin-registered theme resolves through the ThemeRegistry
      // FIRST; custom files are the fallback. A selected plugin theme whose
      // owner unloaded resolves undefined and falls back to the built-in
      // palette (the M5 gate: selected theme unload → built-in fallback).
      const pluginPalette = extensionService?.themes.paletteFor(name)
      const customPalette = loadCustomTheme(name)
      const palette = pluginPalette ?? customPalette
      if (palette !== undefined) {
        try {
          app.applyPalette(palette)
          if (pluginPalette !== undefined) extensionService?._clearRegistryError('theme', name)
        } catch (error) {
          if (pluginPalette !== undefined) extensionService?._recordRegistryError('theme', name, error)
          app.notify(`theme ${name} failed: ${safeErrorMessage(error)}`, 'error')
        }
      } else {
        // Neither a plugin theme nor a custom file: the selection is gone
        // (unloaded plugin) — fall back to the built-in dark palette.
        app.applyTheme('dark')
      }
      app.trackTerminalTheme(false)
    }
    const storedFooter = tuiSettings?.get().footer
    if (storedFooter === 'compact') app.setFooterPreset('compact')
    // One-time migration: per-cwd input history used to live inside this
    // settings namespace. Move it to the JSONL history files (oldest-first
    // file order; the stored arrays are newest-first) and drop the stale
    // key from the stored section (the cleanup below deletes it explicitly —
    // schemastery's z.object does NOT strip unknown keys, so a spread of the
    // resolved doc would otherwise write the key right back).
    let legacyHistory: Record<string, readonly string[]> | undefined
    try {
      const descriptor = ctx.get('settings')?.describe()
        .find(d => d.ns === settingsNamespace('dsh-pi-tui'))
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
            const doc = { ...tuiSettings.get() } as Record<string, unknown>
            delete doc.history
            tuiSettings.replace(doc)
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

    // The TUI-owned slash commands are registered by registerCommands()
    // inside initLiveSession, exactly once after the first session exists.
    refreshStatus()
    // The persistent dock's task lines + the footer badge follow the
    // background-job registry: every change refreshes the active-task
    // snapshot (no polling). `refreshTasks` is hoisted so the task browser
    // (openJobView, defined earlier in this closure) can refresh the badge
    // after stop/close.
    let refreshTasks: () => void = () => {}
    let refreshAgents: () => void = () => {}
    const jobs = ctx.get('jobs')
    if (jobs !== undefined) {
      refreshTasks = (): void => {
        let tasks: { id: string; label: string; status: string; kind?: string }[] = []
        try {
          tasks = jobs.list(liveAgent)
            .filter(job => job.status === 'running' || job.status === 'stopping')
            .map(job => ({ id: job.id, label: job.label, status: job.status, kind: job.kind }))
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
    // their own channel into the subagent registry. `refreshAgents` is
    // event-driven: subagent lifecycle events (start/end), subagent tool
    // calls in the live session (the scope-filtered lifecycle events may
    // not reach this context), and every jobs change (a one-shot settlement
    // implies a child may have gone inactive). listChildren is async and
    // may read persistence for cold children, so the commit is
    // generation-guarded and never lands on a newer session.
    const subagents = ctx.get('subagents')
    if (subagents !== undefined) {
      refreshAgents = (): void => {
        if (liveAgent === undefined) {
          app.setAgents([])
          return
        }
        const sessionId = liveAgent.session.id
        const generation = sessionGeneration
        runOwned('task browser agents refresh', () => subagents.listChildren(sessionId), {
          diag,
          sessionId: () => liveAgent?.session.id,
          onResult: (entries) => {
            if (sessionGeneration !== generation || liveAgent?.session.id !== sessionId) return
            // Live child subagents arm the badge/trigger: every continuable
            // child plus RUNNING one-shot children (a foreground delegation
            // is the parent's pending tool call and registers no job row).
            // Finished one-shot children drop off — their surface is
            // /subagents.
            app.setAgents(entries
              .filter((entry): entry is Extract<SubagentListEntry, { kind: 'child' }> =>
                entry.kind === 'child' && entry.activity === 'running')
              .map(entry => ({ id: entry.id, label: entry.label ?? entry.id, activity: entry.activity })))
          },
        })
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
          runOwned('subagent view from tasks', () => enterView(childSessionId as SessionId, snapshot.label), {
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
      folder = new TranscriptFolder()
      folder.apply(agent.session.events)
      statsFolder = new StatsFolder()
      statsFolder.apply(agent.session.events)
      goalText = foldGoal(agent.session.events)
      app.setWorking(workingFromLog(agent.session.events))
      app.setSessionTitle(foldSessionTitle(agent.session.events)?.title)
      app.clearLocalMessages()
      app.clearNotify() // a notice from the previous session is stale here
      // Issue #8: a stale armed exit chord must not exit the NEW session.
      app.clearCtrlCExit()
      // The subagent-notice notify guard is per-session: a new session's
      // settlements must notify again.
      notifiedSubagentNotices.clear()
      repaint(app, folder)
      refreshStatus()
      refreshQueue()
      // Repaint both background channels: the dock/badge are owner-fenced,
      // and a session switch must not leave the previous session's tasks
      // or subagents on screen until the next registry event.
      refreshTasks()
      refreshAgents()
      // The recall history is per-workspace: REPLACE it with the live
      // session's persisted entries from the cwd's JSONL history file
      // (editor history AND the persistence mirror), so switching sessions
      // never recalls the old workspace's inputs nor writes them back
      // under the new cwd. The file is oldest-first; TuiApp's recall API
      // takes newest-first, so the loaded entries are reversed here.
      const historyCwd = sessionCwd()
      const historyEntries = loadHistoryFile(historyFilePath(dshHome(process.env), historyCwd))
      lastHistoryContent = historyEntries.at(-1)
      app.resetInputHistory([...historyEntries].reverse())
      setTerminalTitle(`dsh-pi-tui · ${shortCwd(sessionCwd())} · ${agent.session.id}`)
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
      creating = (async () => {
        const launched = await launchComposition()
        if (launched.failure !== undefined) resumeFailure = launched.failure
        try {
          const created = await agents.create({
            sessionId: SessionId(`session-${randomUUID()}`),
            meta: { cwd: process.cwd(), ...withPresetMeta(launched.composition) },
            agentOptions,
            setup: launched.composition.setup,
          })
          liveHandle = created
          liveAgent = created.agent
          // A freshly created session is now a real persisted artifact: take
          // the open-time lock so another dsh process cannot open it while we
          // hold it. The lock is best-effort (unavailable deployments skip it
          // and rely on the write-path guard). A refusal cannot happen here:
          // the id is a brand-new UUID, so no other process can hold it —
          // the return value is deliberately ignored (it is not a fatal path).
          acquireOpenLock(liveAgent.session.id, liveAgent.session.header)
          await liveAgent.whenIdle()
          bumpSessionGeneration()
          await initLiveSession(liveAgent)
          // The first real session's catalog comes from the REAL agent:
          // await the coordinator refresh so the first submission rides the
          // live scope (the probe snapshot is never execution
          // authorization). Provider issues degrade fields inside the
          // snapshot; a failed attempt is warned, never fatal.
          await refreshLiveCatalog(liveAgent)
        } catch (error) {
          // A preset that resolves but fails to MOUNT (e.g. a row waiting for
          // a host service) rejects inside the agent-factory setup. Surface it
          // and fall back to the default rather than killing the TUI.
          const message = safeErrorMessage(error)
          ctx.logger.warn(`tui-runner: failed to start with preset "${launchPreset ?? 'default'}": ${message}`)
          diag.warn('preset mount failed', { preset: launchPreset ?? 'default', error: message })
          resumeFailure = `failed to start with preset "${launchPreset ?? 'default'}": ${message}`
          const fallback = await compose()
          const created = await agents.create({
            sessionId: SessionId(`session-${randomUUID()}`),
            meta: { cwd: process.cwd(), ...withPresetMeta(fallback) },
            agentOptions,
            setup: fallback.setup,
          })
          liveHandle = created
          liveAgent = created.agent
          // A freshly created session is now a real persisted artifact: take
          // the open-time lock so another dsh process cannot open it while we
          // hold it. The lock is best-effort (unavailable deployments skip it
          // and rely on the write-path guard). A refusal cannot happen here:
          // the id is a brand-new UUID, so no other process can hold it —
          // the return value is deliberately ignored (it is not a fatal path).
          acquireOpenLock(liveAgent.session.id, liveAgent.session.header)
          await liveAgent.whenIdle()
          bumpSessionGeneration()
          await initLiveSession(liveAgent)
          await refreshLiveCatalog(liveAgent)
        }
        if (resumeFailure !== undefined) {
          app.notify(resumeFailure, 'error')
          resumeFailure = undefined
        }
      })().finally(() => { creating = undefined })
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
     * registerCommands once the surface hooks exist. */
    let catalogRefreshRequest: ((request: CatalogRefreshRequest) => Promise<CatalogRefreshOutcome>) | undefined
    let catalogCoordinator: CatalogRefreshCoordinator | undefined
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
     * the single-point adapter (plan appendix B.1). The event carries no
     * scope or cwd, so the refresh target follows the CURRENT ownership; an
     * unavailable or throwing subscription degrades to no subscription —
     * owner switches and /reload still refresh. The flag is set only after
     * a successful subscribe, so a throwing subscribe can retry on a later
     * registration attempt. */
    const subscribeSkillsChangeEvents = (): void => {
      if (skillsChangeSubscribed) return
      try {
        subscribeSkillsChange(ctx as never, () => skillsChangeGate.notify())
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
      const settings = tuiSettings
      if (settings !== undefined) {
        runDetached('settings focus write', () => settings.replace({ ...settings.get(), focusMode: enabled ? 'on' : 'off' }) as Promise<unknown>, {
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
    const runner: TuiCommandRunner = {
      ctx,
      app,
      diag,
      get liveAgent() { return liveAgent },
      ensureSession,
      get selected() { return selected },
      get tuiSettings() { return tuiSettings as unknown as TuiCommandRunner['tuiSettings'] },
      agents: agents as unknown as TuiCommandRunner['agents'],
      sessions: { flush: (session) => sessions.flush(session as Parameters<typeof sessions.flush>[0]) },
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
      recordExtensionError: (slot, id, error) => extensionService?._recordRegistryError(slot, id, error),
      clearExtensionError: (slot, id) => extensionService?._clearRegistryError(slot, id),
      /** The live session's workspace cwd (header), falling back to the
       * process cwd before any session exists; the footer/welcome/
       * completions/history follow it so a session switch updates the
       * whole surface. */
      sessionCwd,
      signal,
      get sessionGeneration() { return sessionGeneration },
      compose,
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
      swapTo: (next) => swapTo(next as Awaited<ReturnType<typeof agents.resume>>),
      currentPreset,
      recomposeBlank: (id) => recomposeBlank(ctx, liveAgent as Agent, id),
      refreshStatus,
      updateWelcomeCard,
      openJobView,
      openTasksBrowser,
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
          // — the capability-gated cold path (standing key → global →
          // degraded global with a notice), never an Agent probe: probes
          // emit durable session events in this deployment (see
          // docs/surface-catalog.md).
          readStanding: async (presetId, readSignal) => {
            const target = await resolveColdSkillTarget(ctx as unknown as SkillCatalogContext, presetId, process.cwd())
            if (target.target === undefined) throw new Error('skill service unavailable')
            const catalog = await readHumanSkillCatalog(target.target.registry, {
              cwd: target.target.cwd,
              scope: target.target.scope,
              signal: readSignal,
            })
            return { catalog, ...target.degraded === undefined ? {} : { notice: target.degraded } }
          },
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
      refreshStatus()
      setTerminalTitle(`dsh-pi-tui · ${shortCwd(sessionCwd())}`)
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
          schedulePaint()
          if (event.type === 'turn/end') paintNow()
          return
        }
        // Any OTHER session's events (the live agent's) keep routing to the
        // main folder below — the viewer never starves the main transcript.
      }
      if (session.id !== liveAgent.session.id) return
      // Pair approval previews: remember each tool call's arguments by callId.
      if (event.type === 'tool/call') {
        callArgs.set(event.data.callId, typeof event.data.arguments === 'string'
          ? event.data.arguments
          : JSON.stringify(event.data.arguments))
        // Continuable children never register jobs, and their lifecycle
        // events are scope-filtered (may not reach this context), so the
        // subagent tool's own call in the live session is the reliable
        // badge-arming signal.
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
        callArgs.delete(callId ?? ('' as CallId))
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
        refreshStatus()
      }
      // Every durable inbox mutation (followup, steer, splice) commits
      // an agent/inbox/spliced event. The upstream Inbox commits the event
      // BEFORE its live projection mutates (synchronous observers see the
      // pre-splice lists), so the pane must read the inbox on the next
      // microtask — after the splice has actually landed. A splice also
      // invalidates any pending save force token: the token binds the queue
      // payload at block time, and a changed queue must re-block.
      if (event.type === 'agent/inbox/spliced') {
        guardToken = undefined
        queueMicrotask(refreshQueue)
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
        settleCompactionSurface(app, refreshStatus, workingFromLog(liveAgent.session.events))
      }
      if (compacted.notify !== undefined) app.notify(compacted.notify.text, compacted.notify.kind)
      // Persist each completed turn so a crash loses at most the live turn.
      // The busy indicator follows turn boundaries: on from the moment a
      // turn starts (model wait + tool calls), off when it ends.
      if (event.type === 'turn/start') {
        // Turn boundaries invalidate any pending force token: the guard
        // state must reflect the file at the NEXT submission, not the one
        // blocked before the turn ran.
        guardToken = undefined
        app.setWorking(true)
        app.setBusy(true)
      } else if (event.type === 'turn/end') {
        guardToken = undefined
        app.setWorking(false)
        // A turn end must not clear the busy flag while a compaction is
        // still in flight (an interrupted turn can close before its
        // compaction settles) — the single-Esc cancel stays armed.
        app.setBusy(busyAfterTurnBoundary('turn/end', compactingId !== undefined))
        paintNow()
        refreshStatus()
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
      } else if (event.type === 'step/start') {
        refreshStatus()
      }
    })
    // Subagent lifecycle events drive the continuable-children half of the
    // dock badge (they never register jobs). Scope-filtered by the
    // delegating parent — when they do not reach this context, the
    // tool/call fallback above still arms the badge.
    ctx.on('subagent/start', () => refreshAgents())
    ctx.on('subagent/end', () => refreshAgents())
    // Provider-topology and credential events refresh the footer model row
    // and the welcome card: a /login /logout /add-provider (or an external
    // settings.yaml / .credentials.yaml edit) changes the live provider /
    // model surface, and the status line must not keep showing a stale
    // selection. All three events are capability-optional: an absent llm /
    // settings / credentials service never mounts them, and a throwing
    // listener is contained by the event bus (the refresh is best-effort).
    // dsh 0.1.1-rc.1 split the credential update event into the reference
    // half and the durable-record half; both change the same surface, so
    // they share one refresh callback.
    ctx.on('llm/adapters-updated', () => { refreshStatus(); updateWelcomeCard() })
    ctx.on('settings/document-updated', (ns) => {
      if (ns === settingsNamespace('llm-pi-ai') || ns === settingsNamespace('llm-deepseek')) {
        refreshStatus()
        updateWelcomeCard()
      }
    })
    const refreshCredentialSurface = (): void => { refreshStatus(); updateWelcomeCard() }
    registerCredentialSurfaceRefresh(ctx, refreshCredentialSurface)
    // Initial plan badge, busy indicator, and auto title from the log (a
    // resumed session may be persisted mid-turn). Without a session the
    // surfaces stay at their idle defaults.
    if (liveAgent !== undefined) {
      app.setPlanMode(foldPlanMode(liveAgent.session.events))
      app.setWorking(workingFromLog(liveAgent.session.events))
      app.setBusy(workingFromLog(liveAgent.session.events))
      app.setSessionTitle(foldSessionTitle(liveAgent.session.events)?.title)
      // Initial compaction state: a resumed session may be persisted
      // MID-compaction (compaction/start without a matching end) — the
      // working row shows the unified label and the busy flag keeps the
      // single-Esc cancel armed. A session/end-seed boundary makes any
      // EARLIER unmatched start stale (upstream invariant), so only a
      // bracket in the LIVE part of the log re-arms the surface. The log
      // holds no summary/end yet, so the safest phase inference is
      // 'summarizing' (in progress).
      const resumedCompaction = compactingFromLog(liveAgent.session.events)
      if (resumedCompaction.active) {
        compactingId = resumedCompaction.id
        app.setCompactionPhase('summarizing')
        app.setBusy(true)
        app.setWorking(true)
      }
      // Initial todo state: the last todo/write snapshot in the log.
      for (let index = liveAgent.session.events.length - 1; index >= 0; index -= 1) {
        const event = liveAgent.session.events[index]
        if (event.type === 'todo/write') {
          app.setTodoSummary(event.data.todos)
          break
        }
      }
    }

    // The interactive answerer: every approval ask becomes a dialog. An
    // already-aborted request settles cancelled synchronously; otherwise the
    // prompt's own abort signal withdraws it (turn cancel). P7c: the dialog
    // previews the paired tool call's arguments and flags dangerous commands.
    ctx.on('approval/request', (req, next) => {
      if (req.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')
      const args = req.callId === undefined ? undefined : callArgs.get(req.callId)
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
    const userQuestions = ctx.get('userQuestions')
    if (userQuestions !== undefined) {
      userQuestions.registerProvider({
        ask: async (request) => {
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
        },
      })
    }
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
