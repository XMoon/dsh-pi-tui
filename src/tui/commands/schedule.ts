/**
 * The `/schedule` command (S5-PR4): the ONE user entry of the Host Schedule
 * manager.
 *
 * It is a SESSIONLESS local command: typing `/schedule` never creates a
 * Session, never submits a prompt and never reads a model. The workspace's own
 * intents are the only path to a Host Schedule read or write, and every write
 * still passes the controller's confirmation + CAS + re-read rules.
 *
 * The command takes NO arguments: `/schedule <text>` is an explicit parameter
 * error, never a task created from the line.
 *
 * @module tui/commands/schedule
 */

import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { RegisterTuiCommand } from '../../commands.ts'

/** The command's own narrow dependency surface. */
export interface ScheduleCommandDeps {
  /** Lease the ONE Schedule workspace over the selected backend. */
  readonly openScheduleWorkspace: () => CommandResult
  readonly registerTuiCommand: RegisterTuiCommand
}

/** Register `/schedule`. */
export function registerScheduleCommand({ openScheduleWorkspace, registerTuiCommand }: ScheduleCommandDeps): void {
  registerTuiCommand({
    name: 'schedule',
    description: 'Browse and manage the Host schedule',
    handler: async invocation => {
      // The management screen has no positional grammar: an argument is a
      // user error, not a task path or an instruction.
      if (invocation.rawInput.trim() !== '') {
        return { kind: 'error', text: '/schedule does not take arguments.' }
      }
      return openScheduleWorkspace()
    },
  })
}
