/**
 * Built-in command definitions for the Task Center / Plugin Manager entry
 * domain (`/tasks`, `/plugins`).
 *
 * Registration is explicit: the coordinator (`src/commands.ts`) calls each
 * registrar at its frozen position in the built-in registration sequence.
 * No Task/Plugin business runtime lives here — the handlers call the existing
 * runner/surface entrypoints.
 * @module @xmoon76/dsh-pi-tui/commands/tasks
 */

import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { RegisterTuiCommand, TuiCommandRunner } from '../../commands.ts'

/** The runner operations the task entry commands consume. */
type TasksCommandRunner = Pick<TuiCommandRunner, 'requireLiveSessionScope' | 'openTasksBrowser'>

export interface TasksCommandDeps {
  runner: Pick<TasksCommandRunner, 'requireLiveSessionScope' | 'openTasksBrowser'>
  registerTuiCommand: RegisterTuiCommand
}

export interface PluginsCommandDeps {
  /** The `/plugins` entry: the SAME Settings workspace lease, landing on the
   *  Plugin List. It never creates or switches a Session. */
  openPluginsWorkspace: () => CommandResult
  registerTuiCommand: RegisterTuiCommand
}

/** `/tasks` (`/subagents`) — the merged Task Center browser behind the
 *  full surface (jobs + subagents in one searchable list). The Task Runtime's
 *  own business layer implements row-level confirmed Stop on the PiTui
 *  renderer; the TSP Work Hub behind the same command is read-only. */
export function registerTasksCommand({ runner, registerTuiCommand }: TasksCommandDeps): void {
  registerTuiCommand({
    name: 'tasks',
    description: 'Browse tasks, subagents and jobs for the current session',
    aliases: ['subagents'],
    handler: async () => {
      // The merged browser: jobs + subagents in one searchable list — the full
      // surface behind `/tasks` (runner.openTasksBrowser). Completed jobs and
      // finished one-shot children are reachable exactly through this path.
      // The renderer decides what the surface offers: the PiTui Task Center
      // keeps its row-level confirmed Stop, and the TSP Work Hub reads only.
      // This handler holds NO renderer branch — the registered command, its
      // alias and the business entry stay ONE path.
      await runner.requireLiveSessionScope()
      runner.openTasksBrowser()
      return { kind: 'success' }
    },
  })
}

/** `/plugins` (P1-A / PR2): the canonical sessionless deep link into
 *  `Settings → Plugins`. It leases the ONE Settings workspace screen (never a
 *  second Plugin screen) and lands on the Plugin List. */
export function registerPluginsCommand({ openPluginsWorkspace, registerTuiCommand }: PluginsCommandDeps): void {
  registerTuiCommand({
    name: 'plugins',
    description: 'Inspect and manage DSH plugins and TUI extensions for this profile',
    handler: () => openPluginsWorkspace(),
  })
}
