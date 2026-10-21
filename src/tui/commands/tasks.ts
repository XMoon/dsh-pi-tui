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

import type { RegisterTuiCommand, TuiCommandRunner } from '../../commands.ts'

/** The runner operations the task entry commands consume. */
type TasksCommandRunner = Pick<
  TuiCommandRunner,
  'requireLiveSessionScope' | 'openTasksBrowser' | 'openPluginManager'
>

export interface TasksCommandDeps {
  runner: Pick<TasksCommandRunner, 'requireLiveSessionScope' | 'openTasksBrowser'>
  registerTuiCommand: RegisterTuiCommand
}

export interface PluginsCommandDeps {
  runner: Pick<TasksCommandRunner, 'openPluginManager'>
  registerTuiCommand: RegisterTuiCommand
}

/** `/tasks` (`/subagents`) — the merged Task Center browser behind the
 *  full surface (jobs + subagents in one searchable list, row-level
 *  confirmed Stop on capable rows). */
export function registerTasksCommand({ runner, registerTuiCommand }: TasksCommandDeps): void {
  registerTuiCommand({
    name: 'tasks',
    description: 'Open the full Task Center for this session (scope, type, search, and tree controls)',
    aliases: ['subagents'],
    handler: async () => {
      // The merged browser: jobs + subagents in one searchable list, with
      // row-level confirmed Stop on capable rows — the full surface behind
      // `/tasks` (runner.openTasksBrowser). Completed jobs and finished
      // one-shot children are reachable exactly through this path.
      await runner.requireLiveSessionScope()
      runner.openTasksBrowser()
      return { kind: 'success' }
    },
  })
}

/** `/plugins` (P1-A): the canonical sessionless entry into the shared
 *  profile-wide Plugin Manager surface. It never creates or switches a
 *  Session; the runner facade owns the controller/panel. */
export function registerPluginsCommand({ runner, registerTuiCommand }: PluginsCommandDeps): void {
  registerTuiCommand({
    name: 'plugins',
    description: 'Inspect and manage DSH plugins and TUI extensions for this profile',
    handler: () => {
      runner.openPluginManager()
      return { kind: 'success' }
    },
  })
}
