/**
 * `/queue` — the Client-local entry into the ONE per-occurrence queued-message
 * manager (PR-Q).
 *
 * The command is presentation-only: it forwards to the application-level
 * `QueueManagerController.open()` through the runner facade, creates no
 * Session, sends no text to the agent and performs no Host write itself. The
 * controller re-reads the authoritative `queued` projection and every edit or
 * remove is an explicit intent inside the panel.
 *
 * @module @xmoon76/dsh-pi-tui/tui/commands/queue
 */

import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { RegisterTuiCommand, TuiCommandRunner } from '../../commands.ts'

/** The runner operations the queue entry consumes. */
type QueueCommandRunner = Pick<TuiCommandRunner, 'openQueueManager'>

export interface QueueCommandDeps {
  readonly runner: QueueCommandRunner
  readonly registerTuiCommand: RegisterTuiCommand
}

export function registerQueueCommand({ runner, registerTuiCommand }: QueueCommandDeps): void {
  registerTuiCommand({
    name: 'queue',
    description: 'Manage queued messages',
    handler: (invocation): CommandResult => {
      // The bare line is the only claimed shape (no `input` descriptor); an
      // argued `/queue clear` is an ordinary submission, exactly like every
      // other bare-only TUI command. This guard keeps a direct headless
      // handler call honest instead of silently ignoring arguments.
      if (invocation.rawInput.trim() !== '') {
        return { kind: 'error', text: 'The /queue command does not accept arguments.' }
      }
      return runner.openQueueManager?.() ?? {
        kind: 'error',
        text: 'Queue management is unavailable on this renderer',
      }
    },
  })
}
