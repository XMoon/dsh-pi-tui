/**
 * @dsh-pi-tui/tui-app — the bundle's runtime glue plugin. Waits for the
 * startup service (the parsed `dsh --profile tui` flags), then starts the
 * TUI surface on the process terminal. Session wiring (input → session
 * events, approvals, commands) lands in later milestones; today the surface
 * is a self-contained echo loop.
 * @module @dsh-pi-tui/tui-app
 */

import type { Context } from '@deepseek-ai/cordis'
import { TUI_STARTUP_SERVICE } from './startup.ts'
import { startProcessTui } from './tui-app.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-app'

/** Services required before the TUI can start. */
export const inject = [TUI_STARTUP_SERVICE]

/**
 * Start the TUI on the process terminal. The application is intentionally
 * minimal in this milestone: it renders and echoes submitted lines back to
 * the editor area. The exit path mirrors headless's process shutdown: the
 * caller owns process exit, so the bundle only stops the surface.
 * @param ctx - plugin context carrying the tuiStartup service.
 */
export function apply(ctx: Context): void {
  const startup = ctx.get(TUI_STARTUP_SERVICE)
  if (startup === undefined) return
  const app = startProcessTui({
    onSubmit: (text) => {
      ctx.logger.info(`submitted: ${text}`)
    },
    onExit: () => {
      app.stop()
    },
  })
}
