/**
 * The `agent-preset/selected` session event, declared locally.
 *
 * The official package declares this augmentation in its `session.ts`, but
 * the published `@deepseek-ai/dsh-agent-presets` exports map does not expose
 * that subpath, so the TUI cannot import it. Interface merging makes this
 * declaration compatible with the official one whenever both are in scope.
 * @module @xmoon76/tui-app/preset-events
 */

import type {} from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's agent preset was chosen after creation, while the session
     * was still blank. Log-only: it records the composition later turns ran
     * under, so a resumed or forked session rebuilds the same one instead of
     * the header's creation-time value.
     */
    'agent-preset/selected': { agentPreset: string }
  }
}

export {}
