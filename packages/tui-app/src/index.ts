/**
 * @dsh-pi-tui/tui-app — the bundle's runner plugin. Waits for the startup
 * service (the parsed `dsh --profile pi-tui` flags) and Loader settlement,
 * creates or resumes an Agent through the core registry, renders its session
 * log into the TUI transcript, and routes editor submissions back through
 * `agent.followup`. Streaming arrives through the `session/event` firehose;
 * the transcript view re-folds the log per event (small logs keep this
 * simple and always consistent).
 * @module @dsh-pi-tui/tui-app
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
import type {} from '@deepseek-ai/dsh-commands'
// The skill registry merge for the /skill command.
import type {} from '@deepseek-ai/dsh-skill'
// The settings service merge for persisting TUI preferences.
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
// The plan-mode fold for the header badge.
import { foldPlanMode } from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-plan-mode'
// The persistence service for the session picker.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-settings'
import { TUI_STARTUP_SERVICE } from './startup.ts'
import { foldTranscript } from './transcript.ts'
import { computeStats, formatStats } from './stats.ts'
import { Text } from '@dsh-pi-tui/pi-tui'
import { color } from './theme.ts'
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

/**
 * Re-fold and repaint the transcript from the session log.
 * @param app - the TUI surface.
 * @param events - the session log snapshot.
 */
function repaint(app: TuiApp, events: readonly SessionEvent[]): void {
  app.setTranscript(foldTranscript(events))
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

    const handle = config.sessionId !== undefined
      ? await agents.resume({ resumeSessionId: SessionId(config.sessionId), agentOptions, setup })
      : await agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      })
    let liveHandle = handle
    let liveAgent = handle.agent
    await liveAgent.whenIdle()

    /** Hand the TUI over to another persisted session, disposing the old agent. */
    const switchSession = async (sessionId: string): Promise<string | undefined> => {
      try {
        await sessions.flush(liveAgent.session)
        await liveHandle.dispose()
        const next = await agents.resume({
          resumeSessionId: SessionId(sessionId),
          agentOptions: { provider: liveAgent.options.provider, model: liveAgent.options.model },
          setup,
        })
        liveHandle = next
        liveAgent = next.agent
        await liveAgent.whenIdle()
      } catch (error) {
        process.stderr.write(`[tui] switch failed: ${error instanceof Error ? error.message : String(error)}\n`)
        return `switch failed: ${error instanceof Error ? error.message : String(error)}`
      }
      repaint(app, liveAgent.session.events)
      refreshStatus()
      app.setWelcomeCard({
        cwd,
        sessionId: liveAgent.session.id,
        model: `${liveAgent.options.provider}/${liveAgent.options.model}`,
        version: '0.1.0',
      })
      return undefined
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
        turns: stats.turns,
        steps: stats.steps,
        statsLine: formatStats(stats),
        ...contextTokens !== undefined ? { contextTokens, contextWindow: stats.contextWindow } : {},
      })
    }

    let app: TuiApp
    // Aborts an in-flight command execution when the TUI quits.
    const signal = new AbortController().signal
    app = startProcessTui({
      onSubmit: (text) => {
        // A registered slash command dispatches without a model turn; anything
        // else is a follow-up prompt. The command lifecycle lands in the
        // session log (command/run + command/done) and re-folds into the
        // transcript through the session/event listener below.
        const commands = ctx.get('commands')
        if (commands !== undefined) {
          void commands.execute(liveAgent, text, signal).then((execution) => {
            if (execution === undefined) {
              liveAgent.followup(createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'user' },
              }))
            }
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
        // Double-Esc: abort the active turn or tool run.
        liveAgent.cancel({ kind: 'user' })
      },
    })
    repaint(app, liveAgent.session.events)
    app.setWelcomeCard({
      cwd,
      sessionId: liveAgent.session.id,
      model: `${liveAgent.options.provider}/${liveAgent.options.model}`,
      version: '0.1.0',
    })
    // Persisted TUI preferences: register the namespace and restore the theme.
    const tuiSettings = ctx.get('settings')?.register(
      settingsNamespace('dsh-pi-tui'),
      z.object({ theme: z.string() }),
      { base: { theme: 'dark' } },
    )
    const storedTheme = tuiSettings?.get().theme
    if (storedTheme === 'light' || storedTheme === 'dark') {
      app.applyTheme(storedTheme)
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
          const theme = tuiSettings?.get().theme === 'light' ? 'light' : 'dark'
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
                description: 'Color palette, persisted across restarts',
                currentValue: theme,
                values: ['dark', 'light'],
              },
              {
                id: 'expand',
                label: 'Tool output',
                description: 'Whether thinking/tool entries start expanded',
                currentValue: app.isToolOutputExpanded() ? 'expanded' : 'collapsed',
                values: ['collapsed', 'expanded'],
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
                if (value === 'dark' || value === 'light') {
                  app.applyTheme(value)
                  void tuiSettings?.replace({ theme: value })
                }
              } else if (id === 'expand') {
                app.setToolOutputExpanded(value === 'expanded')
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
      // All TUI commands are registered now; include them in completion.
      refreshCompletions()
    }
    refreshStatus()

    ctx.on('session/event', (session, event) => {
      if (session.id !== liveAgent.session.id) return
      repaint(app, liveAgent.session.events)
      if (event.type === 'todo/write') app.setTodoSummary(event.data.todos)
      if (event.type === 'plan/mode') app.setPlanMode(event.data.active)
      // Persist each completed turn so a crash loses at most the live turn.
      if (event.type === 'turn/end') {
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
  })().catch((error: unknown) => {
    ctx.logger.error(`tui-runner: ${error instanceof Error ? error.message : String(error)}`)
    exit(1)
  })
}
