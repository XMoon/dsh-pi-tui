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
import { TUI_STARTUP_SERVICE } from './startup.ts'
import { foldTranscript, renderTranscript } from './transcript.ts'
import { startProcessTui, type TuiApp } from './tui-app.ts'

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
  app.setTranscript(renderTranscript(foldTranscript(events)))
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
    const setup = (agentCtx: Context): void => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
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
    const { agent } = handle
    await agent.whenIdle()

    let app: TuiApp
    app = startProcessTui({
      onSubmit: (text) => {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
      },
      onExit: () => {
        void (async () => {
          await sessions.flush(agent.session)
          app.stop()
          exit(0)
        })()
      },
    })
    repaint(app, agent.session.events)

    ctx.on('session/event', (session, event) => {
      if (session.id !== agent.session.id) return
      repaint(app, agent.session.events)
      // Persist each completed turn so a crash loses at most the live turn.
      if (event.type === 'turn/end') void sessions.flush(agent.session)
    })
  })().catch((error: unknown) => {
    ctx.logger.error(`tui-runner: ${error instanceof Error ? error.message : String(error)}`)
    exit(1)
  })
}
