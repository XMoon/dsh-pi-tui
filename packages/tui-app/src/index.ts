/**
 * @dsh-pi-tui/tui-app — the bundle's runner plugin. Waits for the startup
 * service (the parsed `dsh --profile pi-tui` flags) and Loader settlement,
 * creates or resumes an Agent through the core registry, renders its session
 * log into the TUI transcript, and routes editor submissions back through
 * `agent.followup`. Streaming arrives through the `session/event` firehose;
 * a persistent `TranscriptFolder` folds appended events incrementally and a
 * coalesced repaint flushes the windowed transcript (older turns collapse
 * into a summary), so long sessions never re-scan the whole log per event.
 * @module @dsh-pi-tui/tui-app
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
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
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title'
// P5e merges: shell capability for `!` mode and credentials for /login.
import type {} from '@deepseek-ai/dsh-shell'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { TUI_STARTUP_SERVICE } from './startup.ts'
import { TranscriptFolder } from './transcript.ts'
import { computeStats, formatStats } from './stats.ts'
import { Text, type SettingItem } from '@dsh-pi-tui/pi-tui'
import { color, resolveCustomTheme, type ColorPalette, type CustomThemeFile } from './theme.ts'
import { startProcessTui, type TuiApp } from './tui-app.ts'
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
 * The bundle's own version, read from package.json at runtime so the welcome
 * card never drifts from the shipped version.
 * @returns the version string, or a fallback when the file is unreadable.
 */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
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

/**
 * The active goal badge text from the session log, or undefined. The latest
 * `goal/change` wins; a clear or completed goal hides the badge.
 * @param events - the session log.
 * @returns e.g. `goal ● fix the build`, or undefined.
 */
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

/**
 * A balanced completed-turn prefix for forking: the log up to (and including)
 * the last `turn/end`. Undefined when no turn has completed yet.
 * @param events - the session log.
 * @returns the fork seed events, or undefined.
 */
function forkSeed(events: readonly SessionEvent[]): readonly SessionEvent[] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/end') return events.slice(0, index + 1)
  }
  return undefined
}

/** Custom-theme directory convention: `~/.dsh-pi-tui/themes/*.json`. */
function customThemesDir(): string {
  return join(homedir(), '.dsh-pi-tui', 'themes')
}

/** Names of the custom theme files (basename without the extension). */
function customThemeNames(): string[] {
  try {
    return readdirSync(customThemesDir())
      .filter(file => file.endsWith('.json'))
      .map(file => file.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

/** Load and resolve one custom theme file, or undefined when missing/broken. */
function loadCustomTheme(name: string): ColorPalette | undefined {
  try {
    const raw = readFileSync(join(customThemesDir(), `${name}.json`), 'utf8')
    const file = JSON.parse(raw) as CustomThemeFile
    return resolveCustomTheme(file)
  } catch {
    return undefined
  }
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
  // The patch row carries a static config; the real session id comes from the
  // startup service (no `!!js` expression, so loader hot-reloads cannot race
  // the service's availability while evaluating the row).
  const sessionId = config.sessionId !== undefined && config.sessionId !== '' ? config.sessionId : startup.sessionId

  void (async () => {
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
    // Same composition as dsh-headless: this bundle composes no preset roster,
    // so the model-facing rows sit in the host plane.
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    const setup = (agentCtx: Context): void => {
      installModelSelection(agentCtx, selected)
    }

    // A stale --session id must not kill the TUI: resume falls back to a
    // fresh session and the failure is surfaced as a notify line.
    let resumeFailure: string | undefined
    let handle: Awaited<ReturnType<typeof agents.resume>>
    if (sessionId !== undefined) {
      try {
        handle = await agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions, setup })
      } catch (error) {
        ctx.logger.warn(`tui-runner: resume ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
        resumeFailure = `session ${sessionId} could not be resumed; started a fresh session`
        handle = await agents.create({
          sessionId: SessionId(`session-${randomUUID()}`),
          meta: { cwd: process.cwd() },
          agentOptions,
          setup,
        })
      }
    } else {
      handle = await agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      })
    }
    let liveHandle = handle
    let liveAgent = handle.agent
    await liveAgent.whenIdle()
    // Stop the TUI when this fiber is disposed (a loader hot-reload unloads
    // the row; the reloaded row starts its own instance in the same process).
    ctx.effect(function* () {
      yield () => {
        app?.stop()
      }
    })
    // Incremental fold state for the live session's log; reset on switch.
    let folder = new TranscriptFolder()
    folder.apply(liveAgent.session.events)

    /** Swap the live agent to a new handle, repainting for its session. */
    const swapTo = async (next: Awaited<ReturnType<typeof agents.resume>>): Promise<string | undefined> => {
      try {
        await sessions.flush(liveAgent.session)
        await liveHandle.dispose()
        liveHandle = next
        liveAgent = next.agent
        await liveAgent.whenIdle()
      } catch (error) {
        process.stderr.write(`[tui] swap failed: ${error instanceof Error ? error.message : String(error)}\n`)
        return `swap failed: ${error instanceof Error ? error.message : String(error)}`
      }
      folder = new TranscriptFolder()
      folder.apply(liveAgent.session.events)
      app.clearLocalMessages()
      repaint(app, folder)
      refreshStatus()
      setTerminalTitle(`dsh-pi-tui · ${shortCwd(cwd)} · ${liveAgent.session.id}`)
      app.setWelcomeCard({
        cwd,
        sessionId: liveAgent.session.id,
        model: `${liveAgent.options.provider}/${liveAgent.options.model}`,
        version: packageVersion(),
      })
      return undefined
    }

    /** Hand the TUI over to another persisted session. */
    const switchSession = async (sessionId: string): Promise<string | undefined> => {
      const next = await agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions: { provider: liveAgent.options.provider, model: liveAgent.options.model },
        setup,
      })
      return swapTo(next)
    }

    // Footer state: model label, cwd, git branch, turn/step counters, and
    // the stats line (LLM timing, tokens, context pressure).
    const cwd = process.cwd()
    const refreshStatus = (): void => {
      const stats = computeStats(liveAgent.session.events)
      let contextTokens: number | undefined
      const meter = ctx.get('tokenMeter')
      if (meter !== undefined) {
        try {
          contextTokens = meter.measure(liveAgent.session).totalTokens
        } catch {
          // Measurement is best-effort; the footer falls back to no context.
        }
      }
      app.setStatus({
        model: `${liveAgent.options.provider}/${liveAgent.options.model}`,
        cwd: shortCwd(cwd),
        branch: gitBranch(cwd),
        goal: foldGoal(liveAgent.session.events),
        turns: stats.turns,
        steps: stats.steps,
        statsLine: formatStats(stats),
        ...contextTokens !== undefined ? { contextTokens, contextWindow: stats.contextWindow } : {},
      })
    }

    let app: TuiApp
    // Aborts an in-flight command execution when the TUI quits.
    const signal = new AbortController().signal
    // Abort handle for the currently running `!` shell command.
    let localShellController: AbortController | undefined

    /** Run a `!` command locally; the output renders as a local card. */
    const runLocalShell = (text: string): void => {
      // `!!` includes the command in the model context; `!` stays local.
      const includeInContext = text.startsWith('!!')
      const command = text.replace(/^!+/, '').trim()
      if (command === '') return
      if (includeInContext) {
        liveAgent.followup(createUserMessage({
          content: [{ type: 'text', text: command }],
          source: { kind: 'user' },
        }))
        return
      }
      localShellController?.abort()
      localShellController = new AbortController()
      const localSignal = localShellController.signal
      app.pushLocalMessage({
        kind: 'tool',
        turn: Number.POSITIVE_INFINITY,
        name: 'shell',
        args: command,
        result: '',
        status: 'running',
      })
      const settle = (result: string, status: 'ok' | 'error'): void => {
        app.updateLastLocalMessage({
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
        void shell.run(spec).then((result) => {
          if (localSignal.aborted) {
            settle('aborted', 'error')
            return
          }
          const output = [result.stdout.text.trim(), result.stderr.text.trim()].filter(Boolean).join('\n')
          const exit = result.exitCode !== null ? `exit ${result.exitCode}` : `signal ${result.signal ?? '?'}`
          settle(output === '' ? exit : `${output}\n[${exit}]`, result.exitCode === 0 ? 'ok' : 'error')
        }).catch((error: unknown) => {
          settle(`failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
        })
        return
      }
      const child = spawn(command, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      localSignal.addEventListener('abort', () => child.kill(), { once: true })
      child.on('error', (error) => settle(`failed: ${error.message}`, 'error'))
      child.on('close', (code, childSignal) => {
        localShellController = undefined
        if (localSignal.aborted) {
          settle('aborted', 'error')
          return
        }
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
        const exit = code !== null ? `exit ${code}` : `signal ${childSignal ?? '?'}`
        settle(output === '' ? exit : `${output}\n[${exit}]`, code === 0 ? 'ok' : 'error')
      })
    }
    // Coalesced repaint: streaming events fold into the folder immediately
    // (cheap) but the view rebuild flushes at most every REPAINT_FLUSH_MS,
    // and immediately on turn/end.
    let repaintTimer: NodeJS.Timeout | undefined
    const paintNow = (): void => {
      if (repaintTimer !== undefined) {
        clearTimeout(repaintTimer)
        repaintTimer = undefined
      }
      repaint(app, folder)
    }
    const schedulePaint = (): void => {
      if (repaintTimer !== undefined) return
      repaintTimer = setTimeout(() => {
        repaintTimer = undefined
        repaint(app, folder)
      }, REPAINT_FLUSH_MS)
    }
    app = startProcessTui({
      onSubmit: (text) => {
        // Persist the (newest-first) input history for this cwd; the editor
        // already recorded the line through TuiApp's submit hook.
        const history = app.getInputHistory()
        if (history.length > 0) {
          void tuiSettings?.replace({ ...tuiSettings.get(), history: { ...tuiSettings.get().history, [cwd]: history } })
        }
        // `!` commands run locally through the shell (or into context for `!!`)
        // without a model turn; everything else dispatches as before.
        if (text.startsWith('!')) {
          runLocalShell(text)
          return
        }
        // A registered slash command dispatches without a model turn; anything
        // else is a follow-up prompt. The command lifecycle lands in the
        // session log (command/run + command/done) and re-folds into the
        // transcript through the session/event listener below.
        const commands = ctx.get('commands')
        if (commands !== undefined) {
          // Bare `/plan` toggles: when plan mode is already active it exits
          // instead of re-entering (the official command needs `/plan off`).
          const parsed = parseCommand(text)
          const toggled = parsed?.name === 'plan' && parsed.rawInput.trim() === ''
            && foldPlanMode(liveAgent.session.events)
            ? '/plan off'
            : text
          void commands.execute(liveAgent, toggled, signal).then((execution) => {
            if (execution === undefined) {
              liveAgent.followup(createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'user' },
              }))
            }
          }).catch((error: unknown) => {
            ctx.logger.error(`tui-runner: command execution failed: ${error instanceof Error ? error.message : String(error)}`)
            app.notify(error instanceof Error ? error.message : String(error))
          })
          return
        }
        liveAgent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
      },
      onExit: () => {
        void (async () => {
          await sessions.flush(liveAgent.session)
          app.stop()
          exit(0)
        })()
      },
      onCancel: () => {
        // Double-Esc: abort a running `!` shell command, then the live turn.
        localShellController?.abort()
        liveAgent.cancel({ kind: 'user' })
      },
      onSteer: (text) => {
        // Ctrl+S: inject the draft into the running turn; an idle agent
        // just starts a regular turn with it.
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
        if (liveAgent.status === 'running') {
          liveAgent.steer(message)
        } else {
          liveAgent.followup(message)
        }
      },
      openExternalEditor: async (draft) => {
        const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi'
        const file = join(tmpdir(), `dsh-pi-tui-${process.pid}-${randomUUID()}.md`)
        writeFileSync(file, draft)
        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(editor, [file], { stdio: 'inherit' })
            child.on('error', reject)
            child.on('close', () => resolve())
          })
          return readFileSync(file, 'utf8')
        } finally {
          rmSync(file, { force: true })
        }
      },
    })
    paintNow()
    setTerminalTitle(`dsh-pi-tui · ${shortCwd(cwd)} · ${liveAgent.session.id}`)
    app.setWelcomeCard({
      cwd,
      sessionId: liveAgent.session.id,
      model: `${liveAgent.options.provider}/${liveAgent.options.model}`,
      version: packageVersion(),
    })
    if (resumeFailure !== undefined) app.notify(resumeFailure)
    // Persisted TUI preferences: register the namespace and restore the
    // theme + footer preset. `history` holds per-cwd input history for ↑/↓
    // recall across restarts. Theme values: auto | dark | light | custom:<name>.
    const tuiSettings = ctx.get('settings')?.register(
      settingsNamespace('dsh-pi-tui'),
      z.object({
        theme: z.string(),
        footer: z.string(),
        history: z.dict(z.array(z.string())),
      }),
      { base: { theme: 'auto', footer: 'full', history: {} } },
    )
    const storedTheme = tuiSettings?.get().theme
    if (storedTheme === 'auto') {
      // Follow the terminal: query once at boot, then track scheme reports.
      void app.autoDetectTheme()
      app.onTerminalThemeChange((theme) => {
        if (tuiSettings?.get().theme === 'auto') app.applyTheme(theme)
      })
    } else if (storedTheme === 'dark' || storedTheme === 'light') {
      app.applyTheme(storedTheme)
    } else if (storedTheme?.startsWith('custom:')) {
      const palette = loadCustomTheme(storedTheme.slice('custom:'.length))
      if (palette !== undefined) app.applyPalette(palette)
    }
    const storedFooter = tuiSettings?.get().footer
    if (storedFooter === 'compact') app.setFooterPreset('compact')
    const storedHistory = tuiSettings?.get().history[cwd]
    if (storedHistory !== undefined && storedHistory.length > 0) {
      app.seedInputHistory(storedHistory)
    }

    const commands = ctx.get('commands')
    if (commands !== undefined) {
      // Refresh completions after every registration below so TUI-owned
      // commands (/exit /settings /skill /model) appear in the tab list.
      const refreshCompletions = (): void => {
        app.setCommandCompletions(
          commands.list(liveAgent).map(command => ({
            name: command.name,
            description: command.description,
            argumentHint: command.input?.hint,
          })),
          cwd,
        )
      }
      refreshCompletions()
      commands.register({
        name: 'exit',
        description: 'Quit the terminal UI (flush and exit)',
        handler: () => {
          app.stop()
          void sessions.flush(liveAgent.session).then(() => exit(0))
          return { kind: 'success' }
        },
      })
      commands.register({
        name: 'settings',
        description: 'Open the TUI settings panel',
        handler: () => {
          const theme = tuiSettings?.get().theme ?? 'auto'
          const themeValue = theme.startsWith('custom:') ? theme.slice('custom:'.length) : theme
          app.openSettings(
            [
              {
                id: 'approval',
                label: 'Approval policy',
                description: 'How tool approvals are handled in this session',
                currentValue: effectiveApprovalPolicy(liveAgent.session.events) ?? 'ask',
                values: ['ask', 'never'],
              },
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
              // ── read-only session facts ─────────────────────────────
              {
                id: 'separator',
                label: color.border('─'.repeat(34)),
                currentValue: '',
              },
              {
                id: 'session',
                label: color.textDim('Session'),
                description: color.textDim(liveAgent.session.id),
                currentValue: color.textDim(liveAgent.session.id.length > 28 ? `${liveAgent.session.id.slice(0, 28)}…` : liveAgent.session.id),
              },
              {
                id: 'model',
                label: color.textDim('Model'),
                description: color.textDim('Provider and model routing this session'),
                currentValue: color.textDim(`${liveAgent.options.provider}/${liveAgent.options.model}`),
              },
              {
                id: 'cwd',
                label: color.textDim('Working directory'),
                description: color.textDim('Where this session runs'),
                currentValue: color.textDim(cwd),
              },
            ],
            (id, value) => {
              if (id === 'approval') {
                if (value === 'ask' || value === 'never') ctx.get('approval')?.setPolicy(liveAgent, value)
              } else if (id === 'theme') {
                if (value === 'auto' || value === 'dark' || value === 'light' || customThemeNames().includes(value)) {
                  if (value === 'auto') {
                    void app.autoDetectTheme()
                  } else if (value === 'dark' || value === 'light') {
                    app.applyTheme(value)
                  } else {
                    const palette = loadCustomTheme(value)
                    if (palette !== undefined) {
                      app.applyPalette(palette)
                    } else {
                      app.notify(`theme ${value} not found`)
                      return
                    }
                  }
                  // Spread the current doc: a replace is wholesale, so the
                  // persisted input history must ride along.
                  void tuiSettings?.replace({ ...tuiSettings.get(), theme: value === 'auto' || value === 'dark' || value === 'light' ? value : `custom:${value}` })
                }
              } else if (id === 'expand') {
                app.setToolOutputExpanded(value === 'expanded')
              } else if (id === 'thinking') {
                if ((value === 'shown') === app.isThinkingHidden()) app.toggleThinkingHidden()
              } else if (id === 'footer') {
                if (value === 'full' || value === 'compact') {
                  app.setFooterPreset(value)
                  void tuiSettings?.replace({ ...tuiSettings.get(), footer: value })
                }
              }
            },
            () => {},
          )
          return { kind: 'success' }
        },
      })
      commands.register({
        name: 'sessions',
        description: 'List persisted sessions and switch to one',
        handler: async () => {
          const persistence = ctx.get('sessionPersistence')
          if (persistence === undefined) return { kind: 'error', text: 'session persistence unavailable' }
          const headers = await persistence.list()
          if (headers.length === 0) return { kind: 'error', text: 'no persisted sessions' }
          const now = Date.now()
          app.openPicker(
            headers
              .sort((a, b) => b.createdAt - a.createdAt)
              .map(header => {
                const age = Math.max(0, Math.floor((now - header.createdAt) / 1000))
                const ageText = age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`
                const current = header.id === liveAgent.session.id ? ' ← current' : ''
                return {
                  value: header.id,
                  label: header.id.length > 26 ? `${header.id.slice(0, 26)}…` : header.id,
                  description: `${ageText} ago${header.cwd === undefined ? '' : ` · ${header.cwd}`}${current}`,
                }
              }),
            (id) => {
              if (id === liveAgent.session.id) return
              void switchSession(id).then(error => {
                if (error !== undefined) app.notify(error)
              })
            },
            () => {},
          )
          return { kind: 'success' }
        },
      })
      commands.register({
        name: 'skill',
        description: 'Load a skill into the session context',
        input: { hint: '<name>' },
        handler: async (invocation) => {
          const skills = ctx.get('skills')
          if (skills === undefined) return { kind: 'error', text: 'skill service unavailable' }
          const load = async (name: string): Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }> => {
            const skill = await skills.get(name, { cwd })
            if (skill === undefined) return { kind: 'error', text: `unknown skill "${name}"` }
            liveAgent.inject(createUserMessage({
              content: [{ type: 'text', text: `Skill loaded by the user: **${skill.name}**\n\n${skill.content ?? skill.description}` }],
              source: { kind: 'plugin', plugin: 'tui-skill' },
            }))
            return { kind: 'success', text: `skill ${name} loaded` }
          }
          const name = invocation.rawInput.trim()
          if (name !== '') return load(name)
          // No argument: pick from the catalog.
          const catalog = await skills.list({ cwd })
          if (catalog.length === 0) return { kind: 'error', text: 'no skills available' }
          // SettingsList rows: Enter cycles the `✓` value, which fires onChange.
          app.openSettings(
            catalog.map(skill => ({
              id: skill.name,
              label: skill.name,
              description: skill.description,
              currentValue: '',
              values: ['✓'],
            })),
            (id) => {
              void load(id).then(result => { if (result.kind === 'error') app.notify(result.text) })
            },
            () => {},
          )
          return { kind: 'success' }
        },
      })
      commands.register({
        name: 'model',
        description: 'Switch the model for this session',
        handler: async () => {
          const llm = ctx.get('llm')
          const defaultModel = ctx.get('agentDefaultModel')
          if (llm === undefined || defaultModel === undefined) return { kind: 'error', text: 'model service unavailable' }
          const providers = llm.listProviders()
          const current = defaultModel.currentSelection()
          app.openSettings(
            providers.map(provider => ({
              id: provider.id,
              label: provider.name,
              currentValue: current.provider === provider.id ? current.model : '',
              submenu: (value, done) => {
                const models = new Text('Loading models…', 0, 0)
                void llm.listModels(provider.id).then(list => {
                  done(undefined)
                  app.openSettings(
                    list.map(model => ({
                      id: model.id,
                      label: model.id,
                      description: value === model.id ? '← current' : undefined,
                      currentValue: value === model.id ? '← current' : '',
                      values: ['✓'],
                    })),
                    (modelId) => {
                      void defaultModel.saveSelection({ provider: provider.id, model: modelId })
                      selected.current = { provider: provider.id, model: modelId }
                      refreshStatus()
                    },
                    () => {},
                  )
                })
                return models
              },
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
          const next = await agents.create({
            sessionId: SessionId(`session-${randomUUID()}`),
            meta: { cwd: process.cwd() },
            agentOptions: { provider: liveAgent.options.provider, model: liveAgent.options.model },
            setup,
          })
          const error = await swapTo(next)
          if (error !== undefined) app.notify(error)
          return { kind: 'success', text: 'started a fresh session' }
        },
      })
      commands.register({
        name: 'tasks',
        description: 'List background jobs for this session',
        handler: () => {
          const jobs = ctx.get('jobs')
          if (jobs === undefined) return { kind: 'error', text: 'jobs service unavailable' }
          const snapshots = jobs.list(liveAgent)
          if (snapshots.length === 0) return { kind: 'error', text: 'no background jobs' }
          const now = Date.now()
          app.openPicker(
            snapshots.map(job => ({
              value: job.id,
              label: `${job.kind} · ${job.label}`,
              description: `${job.status}${job.detail === undefined ? '' : ` — ${job.detail}`} · ${Math.max(0, Math.floor((now - job.startedAt) / 1000))}s`,
            })),
            () => {},
            () => {},
          )
          return { kind: 'success' }
        },
      })
      // `/permission` is NOT registered here: dsh-permission-presets in the
      // base layer already registers it (text form: `/permission` shows the
      // current preset, `/permission <name>` switches). Registering it again
      // would throw "command already registered" and kill the TUI.
      commands.register({
        name: 'title',
        description: 'Set or show the session title',
        input: { hint: '<title>' },
        handler: (invocation) => {
          const titles = ctx.get('sessionTitle')
          if (titles === undefined) return { kind: 'error', text: 'session title service unavailable' }
          const name = invocation.rawInput.trim()
          if (name === '') {
            const current = titles.get(liveAgent.session)
            return { kind: 'success', text: current === undefined ? 'no title set' : `title: ${current.title}` }
          }
          titles.rename(liveAgent.session, name)
          return { kind: 'success', text: `title set: ${name}` }
        },
      })
      commands.register({
        name: 'copy',
        description: 'Copy the last assistant message (OSC 52 clipboard)',
        handler: () => {
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
        name: 'fork',
        description: 'Fork this session at the last completed turn',
        handler: async () => {
          const seed = forkSeed(liveAgent.session.events)
          if (seed === undefined) return { kind: 'error', text: 'no completed turn to fork from' }
          const next = await agents.create({
            sessionId: SessionId(`session-${randomUUID()}`),
            meta: { cwd, parentSession: liveAgent.session.id, seedLength: seed.length },
            agentOptions: { provider: liveAgent.options.provider, model: liveAgent.options.model },
            setup,
            seed,
          })
          const error = await swapTo(next)
          if (error !== undefined) app.notify(error)
          return { kind: 'success', text: `forked as ${next.agent.session.id}` }
        },
      })
      commands.register({
        name: 'session',
        description: 'Show session stats and identity',
        handler: () => {
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
                currentValue: color.textDim(liveAgent.session.id.length > 28 ? `${liveAgent.session.id.slice(0, 28)}…` : liveAgent.session.id),
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
        description: 'Set an API key credential for a provider (default DEEPSEEK_API_KEY)',
        input: { hint: '[<env-var>]' },
        handler: async (invocation) => {
          const credentials = ctx.get('credentials')
          if (credentials === undefined) return { kind: 'error', text: 'credentials service unavailable' }
          const ref = (invocation.rawInput.trim() || 'DEEPSEEK_API_KEY').toUpperCase()
          try {
            const answers = await app.askQuestions([
              { id: 'key', question: `Paste the API key for ${ref}:` },
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
        description: 'Clear a stored API key credential (default DEEPSEEK_API_KEY)',
        input: { hint: '[<env-var>]' },
        handler: async (invocation) => {
          const credentials = ctx.get('credentials')
          if (credentials === undefined) return { kind: 'error', text: 'credentials service unavailable' }
          const ref = (invocation.rawInput.trim() || 'DEEPSEEK_API_KEY').toUpperCase()
          await credentials.unset(ref as CredentialRef)
          return { kind: 'success', text: `${ref} cleared` }
        },
      })
      commands.register({
        name: 'help',
        description: 'Show keybindings and available commands',
        handler: () => {
          const rows: SettingItem[] = [
            { id: 'k-enter', label: 'Enter', description: 'Submit (slash commands dispatch without a model turn)', currentValue: '' },
            { id: 'k-exit', label: 'Ctrl+C', description: 'Quit the TUI', currentValue: '' },
            { id: 'k-cancel', label: 'Double-Esc', description: 'Cancel the active turn / tool / shell command', currentValue: '' },
            { id: 'k-fold', label: 'Ctrl+O', description: 'Expand/collapse recent tool output and thinking', currentValue: '' },
            { id: 'k-todo', label: 'Ctrl+T', description: 'Toggle the todo panel', currentValue: '' },
            { id: 'k-think', label: 'Alt+T', description: 'Hide/show thinking blocks', currentValue: '' },
            { id: 'k-steer', label: 'Ctrl+S', description: 'Steer the running turn with the draft', currentValue: '' },
            { id: 'k-editor', label: 'Ctrl+G', description: 'Edit the draft in $VISUAL/$EDITOR', currentValue: '' },
            { id: 'k-full', label: 'Ctrl+F', description: 'Toggle fullscreen (alt screen)', currentValue: '' },
            { id: 'k-tab', label: 'Tab', description: 'Autocomplete slash commands and file paths', currentValue: '' },
            { id: 'k-hist', label: '↑/↓', description: 'Recall input history on an empty line', currentValue: '' },
            { id: 'k-bang', label: '! cmd', description: 'Run a shell command locally; !! sends it to the model', currentValue: '' },
            { id: 'sep-help', label: color.border('─'.repeat(34)), currentValue: '' },
            ...commands.list(liveAgent).map(command => ({
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
      // All TUI commands are registered now; include them in completion.
      refreshCompletions()
    }
    refreshStatus()

    ctx.on('session/event', (session, event) => {
      if (session.id !== liveAgent.session.id) return
      folder.apply([event])
      schedulePaint()
      if (event.type === 'todo/write') app.setTodoSummary(event.data.todos)
      if (event.type === 'plan/mode') app.setPlanMode(event.data.active)
      // Persist each completed turn so a crash loses at most the live turn.
      if (event.type === 'turn/end') {
        paintNow()
        refreshStatus()
        void sessions.flush(liveAgent.session)
      } else if (event.type === 'step/start') {
        refreshStatus()
      }
    })
    // Initial plan badge from the log.
    app.setPlanMode(foldPlanMode(liveAgent.session.events))
    // Initial todo state: the last todo/write snapshot in the log.
    for (let index = liveAgent.session.events.length - 1; index >= 0; index -= 1) {
      const event = liveAgent.session.events[index]
      if (event.type === 'todo/write') {
        app.setTodoSummary(event.data.todos)
        break
      }
    }

    // The interactive answerer: every approval ask becomes a dialog. An
    // already-aborted request settles cancelled synchronously; otherwise the
    // prompt's own abort signal withdraws it (turn cancel).
    ctx.on('approval/request', (req, next) => {
      if (req.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')
      return app.showApprovalPrompt({ toolName: req.toolName, reason: req.reason, signal: req.signal })
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
            ...question.options !== undefined ? { options: question.options } : {},
            ...question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {},
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
    ctx.logger.error(`tui-runner: ${error instanceof Error ? error.message : String(error)}`)
    exit(1)
  })
}
