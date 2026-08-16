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
import { readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CallId } from '@deepseek-ai/dsh-llm'
// P7d: the subagent registry merge for ctx.subagents (listChildren/interrupt).
import type {} from '@deepseek-ai/dsh-subagent'
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
import { textOf, TranscriptFolder } from './transcript.ts'
import type { TranscriptMessage } from './transcript.ts'
import { formatStats, StatsFolder } from './stats.ts'
import { color, loadCustomTheme, resolveCustomTheme, type ColorPalette, type CustomThemeFile } from './theme.ts'
import { startProcessTui, type TuiApp } from './tui-app.ts'
import { registerTuiCommands, type TuiCommandRunner } from './commands.ts'
import { customThemeNames } from './theme.ts'
import { diagFromEnv, type Diag } from './diag.ts'
import { runDetached, runOwned, type OwnedTaskOptions } from './detached.ts'
import { safeErrorMessage } from './error-boundary.ts'
import { createExitController, type ExitSessionLike } from './exit.ts'
import { mergeDraft, steerAll, sessionUnchanged, type SteerAgentLike } from './steer.ts'
import { createBoundedOutput, createFileCapture, formatBytes, formatTruncation, SHELL_OUTPUT_CAP_BYTES, SHELL_OUTPUT_CAP_LINES, SHELL_OUTPUT_DISK_CAP_BYTES } from './bounded-output.ts'
import { parseShellWords } from './shell-words.ts'
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
 */
const SESSIONLESS_COMMANDS = new Set([
  'exit', 'settings', 'help', 'login', 'logout', 'model', 'reload',
  'sessions', 'resume', 'search', 'new', 'fork',
])

/**
 * Read an explicit child-session reference from a future/extended job record.
 * Current dsh JobSnapshot records do not expose one, so this normally returns
 * undefined. Crucially, label, registration order and timestamps are never
 * accepted as identity signals.
 */
export function subagentJobTranscriptId(snapshot: unknown): string | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined
  const childSessionId = (snapshot as { readonly childSessionId?: unknown }).childSessionId
  return typeof childSessionId === 'string' && childSessionId.trim() !== '' ? childSessionId : undefined
}

/** Viewer body for a subagent job with no uniquely matched child. */
export function subagentJobViewHint(status: string, detail: string | undefined): string {
  const tail = status === 'running' || status === 'stopping'
    ? ' — running in the background; its transcript updates live in /subagents'
    : ` — this subagent finished${detail === undefined ? '' : ` (${detail})`}`
  return [
    `status: ${status}${tail}`,
    '',
    'The job record does not carry the child session id, so this job cannot',
    'be matched to its child from the task browser (a same-label foreground',
    'run would be indistinguishable). Open /subagents and pick the child by',
    'its label to read the transcript.',
  ].join('\n')
}

/**
 * The installed dsh version (e.g. `0.1.0-rc.6`), resolved from the launcher's
 * real path: `process.argv[1]` is the `dsh` bin, whose realpath walks up to
 * the `@deepseek-ai/dsh/package.json` that owns it. The version the welcome
 * card shows is the harness the TUI runs on, not this bundle's own patch
 * level. Undefined when the launcher path is unreadable.
 * @returns the installed dsh version string, or undefined.
 */
function dshVersion(): string | undefined {
  const bin = process.argv[1]
  if (bin === undefined) return undefined
  try {
    let dir = dirname(realpathSync(bin))
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
        if (pkg.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') return pkg.version
      } catch {
        // Not a manifest directory; keep walking up.
      }
      const parent = dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  } catch {
    // Unreadable launcher path: fall back to the bundle version.
  }
  return undefined
}

/**
 * The bundle's own version, read from package.json at runtime so the welcome
 * card never drifts from the shipped version. The DISPLAYED version prefers
 * the installed dsh version (`dshVersion`), falling back to this one.
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
  app.setTranscript(folder.messages({ maxTurns: WINDOW_TURNS }))
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
 * @returns the id to record on the header (absent without a roster) and the setup callback.
 * @throws when the roster supplies no such preset.
 */
export async function composeAgent(
  ctx: Context,
  selected: ModelSelectionRef,
  presetId?: string,
): Promise<AgentComposition> {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) {
    return {
      setup: (agentCtx: Context): void => {
        installModelSelection(agentCtx, selected)
      },
    }
  }
  const resolvedId = (await presets.resolve(presetId)).id
  return {
    agentPreset: resolvedId,
    setup: async (agentCtx: Context): Promise<void> => {
      installModelSelection(agentCtx, selected)
      await presets.mount(agentCtx, resolvedId)
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

    const selection = defaultModel.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    // P6: compose one preset per session when the roster is mounted; with no
    // roster this is exactly the headless shape (model-facing rows in the
    // host plane). The `selected` ref stays process-wide like before.
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    const compose = (presetId?: string): Promise<AgentComposition> => composeAgent(ctx, selected, presetId)
    const withPresetMeta = (composition: AgentComposition): { agentPreset?: string } =>
      composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }

    // Launch-time preset entry: `--preset` wins over $DSH_PI_TUI_PRESET, and
    // both fall back to the saved default (settings `agent-presets.default`,
    // then the roster config) when absent. A fresh session starts on it; a
    // resumed BLANK session may still be re-composed onto it; a resumed
    // started session keeps its recorded preset (warned, never overridden).
    const launchPreset = startup.presetId ?? (process.env.DSH_PI_TUI_PRESET?.trim() || undefined)
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
        return { composition: await compose(launchPreset) }
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

    // A stale --session id must not kill the TUI: resume falls back to a
    // fresh session and the failure is surfaced as a notify line.
    let resumeFailure: string | undefined
    let handle: Awaited<ReturnType<typeof agents.resume>> | undefined
    if (sessionId !== undefined) {
      try {
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
        const message = safeErrorMessage(error)
        ctx.logger.warn(`tui-runner: resume ${sessionId} failed: ${message}`)
        diag.error('resume failed', { session: sessionId, error: message })
        resumeFailure = `session ${sessionId} could not be resumed; started a fresh session`
        const launched = await launchComposition()
        if (launched.failure !== undefined) resumeFailure = launched.failure
        handle = await agents.create({
          sessionId: SessionId(`session-${randomUUID()}`),
          meta: { cwd: process.cwd(), ...withPresetMeta(launched.composition) },
          agentOptions,
          setup: launched.composition.setup,
        })
      }
    } else {
      // Deferred session creation: without --session the TUI opens with NO
      // session at all — zero agent, zero log, zero persistence — and the
      // first user message creates it (see ensureSession below).
    }
    let liveHandle = handle
    let liveAgent = handle?.agent
    if (liveAgent !== undefined) await liveAgent.whenIdle()
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
      try {
        if (liveAgent !== undefined) {
          await sessions.flush(liveAgent.session)
          await liveHandle?.dispose()
        }
        liveHandle = next
        liveAgent = next.agent
        await liveAgent.whenIdle()
      } catch (error) {
        const message = safeErrorMessage(error)
        diag.error('swap failed', { from, error: message })
        return `swap failed: ${message}`
      }
      guardState = freshGuardState()
      guardToken = undefined
      // A new session owns the surface: bump the generation so late async
      // work from the old session cannot commit, and clear old-session state.
      bumpSessionGeneration()
      await initLiveSession(next.agent)
      diag.info('switch ok', { from: from ?? '(none)', to: next.agent.session.id, seq: next.agent.session.events.length })
      return undefined
    }

    /** Hand the TUI over to another persisted session. Never throws: every
     * failure (unknown session, broken log, preset mount) returns an error
     * string so callers' `.then(error => ...)` need no rejection path. */
    const switchSession = async (sessionId: string): Promise<string | undefined> => {
      try {
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
        return swapTo(next)
      } catch (error) {
        const message = safeErrorMessage(error)
        ctx.logger.warn(`tui-runner: switch to ${sessionId} failed: ${message}`)
        diag.error('switch failed', { session: sessionId, error: message })
        return `switch failed: ${message}`
      }
    }

    // Footer state: model label, cwd, git branch, turn/step counters, and
    // the stats line (LLM timing, tokens, context pressure).
    const cwd = process.cwd()
    /**
     * The LIVE session's workspace: each session carries its own header cwd
     * (fixed at creation, e.g. a session birthed by the web in another
     * directory). The footer/welcome/completions follow THIS cwd so a
     * session switch updates the whole surface; `cwd` (the process cwd)
     * stays for launch-relative concerns (`!` shell, /export paths).
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
      lifecycleController.abort()
      localShellController?.abort()
      for (const file of shellTempFiles) {
        try {
          rmSync(file, { force: true })
        } catch {
          // Best effort.
        }
      }
      shellTempFiles.clear()
      app?.stop()
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

    /** Run a `!` command locally; the output renders as a local card. */
    const runLocalShell = (text: string): void => {
      // `!!` includes the command in the model context; `!` stays local.
      const includeInContext = text.startsWith('!!')
      const command = text.replace(/^!+/, '').trim()
      if (command === '') return
      if (includeInContext) {
        if (liveAgent === undefined) return
        liveAgent.followup(createUserMessage({
          content: [{ type: 'text', text: command }],
          source: { kind: 'user' },
        }))
        return
      }
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
      }
      const shell = ctx.get('shell')
      if (shell !== undefined) {
        // The dsh shell capability (sandbox policy + DSH env) when the
        // composition provides it; completion-based like the spawn fallback.
        const spec = shell.resolve({ command, workdir: cwd, signal: localSignal })
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
      const child = spawn(command, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
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
      app.setTranscript(activeFolder().messages({
        maxTurns: WINDOW_TURNS,
        ...turn === undefined ? {} : { endTurn: turn },
      }))
      app.setSearchResult(searchCurrent + 1, searchMatches.length)
    }
    /** Enter the read-only subagent viewer for one session (live or persisted). */
    const enterView = async (childId: SessionId, label?: string): Promise<void> => {
      const childFolder = new TranscriptFolder()
      const child = sessions.get(childId)
      if (child !== undefined) {
        childFolder.apply(child.events)
      } else {
        // An inactive child is no longer in the live store; load its log.
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined) {
          try {
            childFolder.apply((await persistence.inspect(childId)).events)
          } catch {
            // No persisted log either: the view stays empty.
          }
        }
      }
      viewing = { id: childId, folder: childFolder }
      repaint(app, childFolder)
      app.notify(`viewing subagent ${label ?? childId} — Esc returns`, 'info')
    }
    /** Leave the subagent viewer (single Esc). Returns whether it exited. */
    const exitView = (): boolean => {
      if (viewing === undefined) return false
      viewing = undefined
      app.clearLocalMessages()
      app.clearNotify() // the "viewing subagent — Esc returns" notice is stale now
      repaint(app, folder)
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
      try {
        ctx.logger.error(`tui-runner: session creation failed: ${message}`)
      } catch {
        // The cordis logger must not block the notice.
      }
      app.notify(`could not start a session: ${message}`, 'error')
    }
    /** The session-backed dispatch: create the session lazily (the first
     * user input is the deferred trigger), guard against cross-process
     * divergence, then execute a registered slash command or follow up. */
    const dispatchViaSession = (text: string): void => {
      // An owned workflow: the chain's outcome drives the editor draft, the
      // notices and the queue — runOwned (AGENTS.md), never a bare void.
      runOwned('submit', () => ensureSession().then(async () => {
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
          runOwned('command execution', () => commands.execute(agent as Agent, toggled, signal), {
            diag,
            sessionId: () => agent.session.id,
            onResult: (execution) => {
              // The fallback follow-up still targets the CAPTURED agent; if
              // the session moved on while the command ran, restore the
              // draft instead of posting into a session the user has left.
              if (execution === undefined) {
                if (sessionUnchanged({ agent, generation }, liveAgent, sessionGeneration)) {
                  agent.followup(createUserMessage({
                    content: [{ type: 'text', text }],
                    source: { kind: 'user' },
                  }))
                } else {
                  const merged = mergeDraft(app.getDraft(), text)
                  app.setEditorText(merged)
                  app.notify(merged === text
                    ? 'the session changed while sending — try again'
                    : 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)', 'error')
                }
              }
            },
            onError: (error) => {
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
        // the note above — never a re-read closure variable).
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
      }), {
        diag,
        sessionId: () => liveAgent?.session.id,
        onError: failSubmission(text),
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
      const commands = ctx.get('commands')
      const definition = commands?.find(undefined as unknown as Agent, parsed.name)
      if (commands === undefined || definition === undefined) {
        dispatchViaSession(text)
        return
      }
      const invocation = {
        commandId: `cmd-local-${randomUUID()}`,
        agent: undefined as unknown as Agent,
        rawInput: parsed.rawInput,
        signal,
      } as CommandInvocation
      // An owned workflow: the result decides the notify, the failure lands
      // in diagnostics — runOwned (AGENTS.md), never a bare void. The
      // handler may be a SYNC implementation, so the factory must run inside
      // runOwned (a sync throw would otherwise escape before the entry).
      runOwned('local command', () => definition.handler(invocation), {
        diag,
        sessionId: () => liveAgent?.session.id,
        onResult: (result) => {
          if (result !== undefined && result.kind === 'error') app.notify(result.text)
        },
        onError: (error) => {
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
    app = startProcessTui({
      onSubmit: (text) => {
        // The subagent viewer is READ-ONLY: submitting while viewing would
        // silently send to the PARENT session. Refuse with a notice instead.
        if (viewing !== undefined) {
          app.setEditorText(mergeDraft(app.getDraft(), text))
          app.notify('viewing a subagent — Esc returns before submitting', 'info')
          return
        }
        // Persist the (newest-first) input history for the LIVE session's
        // cwd (the editor already recorded the line through TuiApp's submit
        // hook). A failed settings write is user-recoverable: notify instead
        // of dropping it.
        const history = app.getInputHistory()
        if (history.length > 0) {
          const settings = tuiSettings
          if (settings !== undefined) {
            runDetached('settings history write', () => settings.replace({ ...settings.get(), history: { ...settings.get().history, [sessionCwd()]: history } }), {
              diag,
              notify: (message) => app.notify(message, 'error'),
              recoverable: () => true,
            })
          }
        }
        // `!` commands run locally through the shell (or into context for
        // `!!`) without a model turn; everything else dispatches as before.
        // A local `!` needs no session at all; every other submission creates
        // the session first (the FIRST user message is the deferred trigger).
        if (text.startsWith('!')) {
          if (text.startsWith('!!')) {
            // An owned workflow: the session creation failure restores the
            // draft (failSubmission) — runOwned (AGENTS.md), never a bare
            // void.
            runOwned('contextual shell', () => ensureSession().then(() => runLocalShell(text)), {
              diag,
              sessionId: () => liveAgent?.session.id,
              onError: failSubmission(text),
            })
          } else {
            runLocalShell(text)
          }
          return
        }
        // A sessionless slash command runs locally BEFORE any session exists:
        // typing /exit, /settings, /help, ... must not create one (deferred
        // start). Everything else — session-backed commands, core commands
        // like /plan, and plain prompts — creates the session lazily.
        const parsed = parseCommand(text)
        if (parsed !== undefined && liveAgent === undefined && SESSIONLESS_COMMANDS.has(parsed.name)) {
          runLocalCommand(parsed, text)
          return
        }
        dispatchViaSession(text)
      },
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
        // Double-Esc: abort a running `!` shell command, then the live turn.
        // The cancel also invalidates any pending force token (the guard
        // state may change while the turn is being torn down).
        guardToken = undefined
        localShellController?.abort()
        liveAgent?.cancel({ kind: 'user' })
      },
      onSteer: (text) => {
        // The subagent viewer is read-only: steering would send to the
        // PARENT session. Refuse with a notice and restore the draft.
        if (viewing !== undefined) {
          if (text.trim() !== '') app.setEditorText(mergeDraft(app.getDraft(), text))
          app.notify('viewing a subagent — Esc returns before steering', 'info')
          return
        }
        // Ctrl+S: send everything pending (kimi parity: the whole queue plus
        // a non-empty draft rides along). With queued messages the entire
        // queue is steered at once — the queue pane above the editor is the
        // primary surface; without a queue it stays the classic single-draft
        // steer. Nothing to send at all is a no-op BEFORE any session is
        // created (deferred start). Every message goes through steer(): the
        // next step boundary claims all next-step input together, so the
        // batch arrives in one shot (an idle driver starts a turn with it).
        if (liveAgent !== undefined) {
          const queued = [...liveAgent.inbox.nextTurn, ...liveAgent.inbox.nextStep]
          if (queued.length === 0 && text.trim() === '') return
        } else if (text.trim() === '') {
          return
        }
        // An owned workflow: the send's outcome drives the draft restore and
        // the notices — runOwned (AGENTS.md), never a bare void.
        runOwned('steer', () => ensureSession().then(async () => {
          if (liveAgent === undefined) return
          // The whole send (snapshot → guard → re-validate → confirm-and-
          // send) lives in steer.ts so the races are testable: a queue
          // splice or session switch while the guard reads the file aborts
          // with a retry notice instead of losing messages or writing to a
          // session the guard never checked.
          await steerAll({
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
            createDraft: (draft) => createUserMessage({
              content: [{ type: 'text', text: draft }],
              source: { kind: 'user' },
            }),
            blockedNotice: (reason) => reason === 'removed'
              ? GUARD_REMOVED_NOTIFY('save')
              : reason === 'tail-mismatch'
                ? GUARD_TAIL_MISMATCH_NOTIFY('save')
                : GUARD_BLOCKED_NOTIFY('save'),
            forcedNotice: () => GUARD_FORCED_NOTIFY,
            staleNotice: () => 'the queue or session changed while sending — try again',
            mergedNotice: () => 'the draft changed while sending — review it before submitting again (the earlier text was preserved below)',
          }, text)
        }), {
          diag,
          sessionId: () => liveAgent?.session.id,
          onError: failSubmission(text),
        })
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
      // (pi's dequeue). Plugin notices (job completions etc.) are NOT
      // steerable user input: they stay in the inbox — pulling one back and
      // resubmitting it as plain text would drop its provenance and turn a
      // background notification into an editable user message. The current
      // draft rides along below the pulled-back queue.
      onDequeue: () => {
        if (liveAgent === undefined) return
        const isNotice = (message: { source?: { form?: string } }): boolean => message.source?.form === 'notice'
        const queued = [...liveAgent.inbox.nextTurn, ...liveAgent.inbox.nextStep]
          .filter(message => !isNotice(message as { source?: { form?: string } }))
        if (queued.length === 0) return
        // Remove exactly the pulled-back messages (durable splice), keeping
        // any notices queued behind them.
        for (const message of queued) liveAgent.inbox.remove(message.id)
        const queuedText = queued.map(message => textOf(message.content)).join('\n\n')
        const current = app.getDraft()
        app.setDraft([queuedText, current].filter(part => part.trim() !== '').join('\n\n'))
        refreshQueue()
      },
      // ↓ / Ctrl+J with an empty editor: the task browser over the live job
      // registry (bash + subagent jobs). Enter opens the viewer (job output
      // for bash, the child transcript for subagents).
      onOpenTasks: () => {
        if (jobs === undefined || liveAgent === undefined) return
        let snapshots: ReturnType<NonNullable<typeof jobs>['list']>
        try {
          snapshots = jobs.list(liveAgent)
        } catch {
          return
        }
        if (snapshots.length === 0) return
        const now = Date.now()
        // Active jobs first (registration order), terminal jobs last (newest
        // finish first) — kimi's tasks-browser ordering.
        const terminal = (status: string): boolean => status !== 'running' && status !== 'stopping'
        const ordered = [...snapshots].sort((a, b) => {
          const aTerminal = terminal(a.status)
          const bTerminal = terminal(b.status)
          if (aTerminal !== bTerminal) return aTerminal ? 1 : -1
          if (!aTerminal) return a.startedAt - b.startedAt
          return (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt)
        })
        app.openPicker(
          ordered.map(job => ({
            value: job.id,
            label: `${job.kind} · ${job.label}`,
            description: `${job.status}${job.detail === undefined ? '' : ` — ${job.detail}`} · ${Math.max(0, Math.floor((now - job.startedAt) / 1000))}s`,
          })),
          (jobId) => openJobView(jobId),
          () => {},
          { header: `tasks (${snapshots.length})`, enableSearch: true, showHint: true },
        )
      },
    }, {
      present,
      workspaceRoot: cwd,
    })
    // Persisted TUI preferences: register the namespace and restore the
    // theme + footer preset. `history` holds per-cwd input history for ↑/↓
    // recall across restarts. Theme values: auto | dark | light | custom:<name>.
    const tuiSettings = ctx.get('settings')?.register(
      settingsNamespace('dsh-pi-tui'),
      z.object({
        theme: z.string(),
        footer: z.string(),
        fullscreen: z.string(),
        history: z.dict(z.array(z.string())),
      }),
      { base: { theme: 'auto', footer: 'full', fullscreen: 'on', history: {} } },
    )
    // Fullscreen is a persisted preference like the theme and the footer
    // (new installs default to 'on' — alt screen by default): boot applies
    // it FIRST so the alt screen owns the terminal input handler before any
    // theme query below targets "the active screen" — a query sent while the
    // main screen still owned input would have its reply swallowed by the
    // alt screen's OSC 11 consumer and time out, silently disabling `auto`.
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
      const palette = loadCustomTheme(storedTheme.slice('custom:'.length))
      if (palette !== undefined) app.applyPalette(palette)
      app.trackTerminalTheme(false)
    }
    const storedFooter = tuiSettings?.get().footer
    if (storedFooter === 'compact') app.setFooterPreset('compact')
    // Input history is loaded PER SESSION by initLiveSession (keyed on the
    // live session's cwd), never once at boot: a session switch to another
    // workspace must replace the recall history, not keep the old one.

    // The TUI-owned slash commands are registered by registerCommands()
    // inside initLiveSession, exactly once after the first session exists.
    refreshStatus()
    // The persistent dock's task lines + the footer badge follow the
    // background-job registry: every change refreshes the active-task
    // snapshot (no polling). `refreshTasks` is hoisted so the task browser
    // (openJobView, defined earlier in this closure) can refresh the badge
    // after stop/close.
    let refreshTasks: () => void = () => {}
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
      jobs.onJobsChanged(() => refreshTasks())
      refreshTasks()
    }
    /**
     * Open one job from the task browser: a bash job shows a STATUS viewer
     * (never the output — the job's single read cursor belongs to the agent's
     * job_output; consuming it from the UI would leave the model an
     * incomplete result and could swallow the completion notice); a subagent
     * job shows the status viewer with a /subagents hint. The job record
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
        // fallback and let /subagents (which owns child identities) perform
        // transcript selection; never substitute label/order/time matching.
        openJobStatusViewer(jobId, `subagent ${snapshot.id} · ${snapshot.label}`, snapshot)
        return
      }
      openJobStatusViewer(jobId, `${snapshot.kind} ${snapshot.id} · ${snapshot.label}`, snapshot)
    }
    /**
     * Status-only viewer for one job (never touches the read cursor). The
     * subagent variant appends the /subagents hint because a transcript
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
    // event, so the pane refreshes event-driven with no polling.
    const refreshQueue = (): void => {
      if (liveAgent === undefined) {
        app.setQueueItems([])
        return
      }
      const queue = [
        ...liveAgent.inbox.nextTurn.map(message => ({
          id: message.id,
          text: textOf(message.content),
          mode: 'followup' as const,
          // Plugin notices (background-job completions, plan-mode toasts)
          // are NOT steerable user input: the queue pane marks them and
          // drops the steer hints (see QueueItem.notice).
          notice: (message as { source?: { form?: string } }).source?.form === 'notice',
        })),
        ...liveAgent.inbox.nextStep.map(message => ({
          id: message.id,
          text: textOf(message.content),
          mode: 'steer' as const,
          notice: (message as { source?: { form?: string } }).source?.form === 'notice',
        })),
      ]
      app.setQueueItems(queue)
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
    /** Rebuild every live-session surface after resume, create, or swap. */
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
      repaint(app, folder)
      refreshStatus()
      refreshQueue()
      // The recall history is per-workspace: REPLACE it with the live
      // session's persisted entries (editor history AND the persistence
      // mirror), so switching sessions never recalls the old workspace's
      // inputs nor writes them back under the new cwd.
      app.resetInputHistory(tuiSettings?.get().history[sessionCwd()] ?? [])
      setTerminalTitle(`dsh-pi-tui · ${shortCwd(sessionCwd())} · ${agent.session.id}`)
      updateWelcomeCard()
      registerCommands()
      // The per-skill slash commands are agent-scoped: they appear once the
      // first session exists and refresh on every session switch.
      refreshSkillCommands()
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
          await liveAgent.whenIdle()
          bumpSessionGeneration()
          await initLiveSession(liveAgent)
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
          await liveAgent.whenIdle()
          bumpSessionGeneration()
          await initLiveSession(liveAgent)
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
    let refreshSkills: (() => Promise<number>) | undefined
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
      /** The live session's workspace cwd (header), falling back to the
       * process cwd before any session exists; the footer/welcome/
       * completions/history follow it so a session switch updates the
       * whole surface. */
      sessionCwd,
      signal,
      get sessionGeneration() { return sessionGeneration },
      compose,
      switchSession,
      swapTo: (next) => swapTo(next as Awaited<ReturnType<typeof agents.resume>>),
      currentPreset,
      recomposeBlank: (id) => recomposeBlank(ctx, liveAgent as Agent, id),
      refreshStatus,
      updateWelcomeCard,
      openJobView,
      enterView,
      requestExit,
      exit,
    }
    const registerCommands = (): void => {
      if (commandsRegistered) return
      const commands = ctx.get('commands')
      if (commands === undefined) return
      commandsRegistered = true
      try {
        refreshSkills = registerTuiCommands(runner).refreshSkills
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
    /** Rebuild the agent-scoped per-skill commands after a session exists. */
    const refreshSkillCommands = (): void => {
      const refresh = refreshSkills
      if (refresh === undefined) return
      // Unified fire-and-forget entry: task label + live session id in the
      // diagnostics, cancellations debug-only (the runner is tearing down).
      runDetached('skill command refresh', () => refresh(), {
        diag,
        sessionId: () => liveAgent?.session.id,
      })
    }
    // The startup surface: a resumed session initializes everything; the
    // deferred path shows the pre-session invitation until the first message.
    if (liveAgent !== undefined) {
      await initLiveSession(liveAgent)
    } else {
      app.setWelcomeIdle(true)
      refreshStatus()
      setTerminalTitle(`dsh-pi-tui · ${shortCwd(sessionCwd())}`)
    }
    // Command registration is sessionless: it must run on BOTH startup
    // surfaces (resume path registers inside initLiveSession; the deferred
    // path registers here so /exit /settings /help work before any message).
    registerCommands()
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
        if (session.id !== viewing.id) return
        viewing.folder.apply([event])
        schedulePaint()
        if (event.type === 'turn/end') paintNow()
        return
      }
      if (session.id !== liveAgent.session.id) return
      // Pair approval previews: remember each tool call's arguments by callId.
      if (event.type === 'tool/call') {
        callArgs.set(event.data.callId, typeof event.data.arguments === 'string'
          ? event.data.arguments
          : JSON.stringify(event.data.arguments))
      } else if (event.type === 'tool/result') {
        callArgs.delete(event.data.message.content[0]?.toolCallId ?? ('' as CallId))
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
      // Every durable inbox mutation (followup, steer, /queue edits) commits
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
      // Persist each completed turn so a crash loses at most the live turn.
      // The busy indicator follows turn boundaries: on from the moment a
      // turn starts (model wait + tool calls), off when it ends.
      if (event.type === 'turn/start') {
        // Turn boundaries invalidate any pending force token: the guard
        // state must reflect the file at the NEXT submission, not the one
        // blocked before the turn ran.
        guardToken = undefined
        app.setWorking(true)
      } else if (event.type === 'turn/end') {
        guardToken = undefined
        app.setWorking(false)
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
    // Initial plan badge, busy indicator, and auto title from the log (a
    // resumed session may be persisted mid-turn). Without a session the
    // surfaces stay at their idle defaults.
    if (liveAgent !== undefined) {
      app.setPlanMode(foldPlanMode(liveAgent.session.events))
      app.setWorking(workingFromLog(liveAgent.session.events))
      app.setSessionTitle(foldSessionTitle(liveAgent.session.events)?.title)
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
