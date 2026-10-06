/**
 * Built-in command definitions for the utility domain (`/exit`, `/help`).
 *
 * Registration is explicit: the coordinator (`src/commands.ts`) calls each
 * registrar at its frozen position in the built-in registration sequence and
 * owns catalog/provenance/disposal state. This module only defines commands.
 * @module @xmoon76/dsh-pi-tui/commands/utility
 */

import type { SettingItem } from '@xmoon76/pi-tui'
import type { AppKeybindingId } from '../keybindings/types.ts'
import { color } from '../theme.ts'
import type { RegisterOne, RegisterTuiCommand, TuiCommandRunner } from '../commands.ts'

/** The runner operations the utility commands consume. */
type UtilityCommandRunner = Pick<TuiCommandRunner, 'requestExit' | 'listScopedCommands' | 'app'>

export interface ExitCommandDeps {
  runner: Pick<UtilityCommandRunner, 'requestExit'>
  registerTuiCommand: RegisterTuiCommand
}

export interface HelpCommandDeps {
  runner: Pick<UtilityCommandRunner, 'listScopedCommands' | 'app'>
  registerOne: RegisterOne
}

/**
 * `/exit` and its `/quit` alias. The exit orchestration lives in the runner
 * (createExitController): latch once, idempotent surface cleanup, resume
 * hint, appExit (the Direct owned-session retirement runs inside the appExit
 * disposal). Handlers never stop the app or flush themselves — that kept
 * /exit diverging from Ctrl+C/Ctrl+D and could hang a stopped UI forever.
 */
export function registerExitCommand({ runner, registerTuiCommand }: ExitCommandDeps): void {
  const exitHandler = (): { kind: 'success' } => {
    runner.requestExit()
    return { kind: 'success' }
  }

  registerTuiCommand({
    name: 'exit',
    description: 'Quit the terminal UI (flush and exit)',
    aliases: ['quit'],
    handler: exitHandler,
  })
}

/** `/help` — the effective keymap plus the current scoped command list. */
export function registerHelpCommand({ runner, registerOne }: HelpCommandDeps): void {
  const app = runner.app
  registerOne({
    name: 'help',
    description: 'Show keybindings and available commands',
    handler: () => {
      // M4: the key labels come from the EFFECTIVE keymap (plan §18) — a
      // user remap updates /help automatically; the UI never hard-codes a
      // physical shortcut.
      const keybindings = app.keybindingsManager()
      const keysLabel = (action: AppKeybindingId): string => {
        // The full effective label: ALL direct keys AND ALL leader
        // sequences (a mixed `['ctrl+z', '<leader>h']` shows
        // `Ctrl+Z / Leader H`; a disabled action advertises nothing) —
        // review finding: keysFor() alone dropped the leader bindings.
        const label = keybindings.keysLabelFor(action)
        return label === '' ? '—' : label
      }
      const rows: SettingItem[] = [        { id: 'k-enter', label: keysLabel('app.input.submit'), description: 'Submit the draft; while the agent is busy, delivery follows the "Submit while busy" preference (skill commands steer too, UI commands run locally)', currentValue: '' },
        { id: 'k-queue', label: keysLabel('app.input.submitAccelerated'), description: 'Submit with the OPPOSITE of the "Submit while busy" behavior (the web accelerated-submit chord)', currentValue: '' },
        { id: 'k-exit', label: keysLabel('app.exit.request'), description: 'Quit the TUI (flushes the session)', currentValue: '' },
        { id: 'k-cancel', label: keysLabel('app.agent.interrupt'), description: 'Cancel the active turn / tool / shell command (one interrupt while the agent is busy; press the interrupt action twice while idle — with an empty editor it opens the rewind picker)', currentValue: '' },
        { id: 'k-fold', label: keysLabel('app.transcript.toggleExpand'), description: `Expand/collapse recent transcript detail; in regular Focus it reveals the recent Thought detail; in fullscreen Focus it controls the Thought-root bulk (per-card detail stays mouse-owned). Thinking detail is separate: ${keysLabel('app.transcript.toggleThinking')}`, currentValue: '' },
        { id: 'k-todo', label: keysLabel('app.todo.toggle'), description: 'Toggle the todo panel', currentValue: '' },
        { id: 'k-think', label: keysLabel('app.transcript.toggleThinking'), description: 'Expand/collapse thinking detail (detail level — blocks stay visible)', currentValue: '' },
        { id: 'k-steer', label: keysLabel('app.input.steer'), description: 'Steer the running turn with the draft', currentValue: '' },
        { id: 'k-editor', label: keysLabel('app.editor.external'), description: 'Edit the draft in $VISUAL/$EDITOR', currentValue: '' },

        { id: 'k-search', label: keysLabel('app.transcript.search'), description: `Search the transcript (${keysLabel('app.transcript.search.next')}/${keysLabel('app.transcript.search.previous')} jump, ${keysLabel('app.transcript.search.close')} closes)`, currentValue: '' },

        { id: 'k-tab', label: 'Tab', description: 'Autocomplete slash commands and file paths', currentValue: '' },
        { id: 'k-hist', label: '↑/↓', description: 'Recall input history on an empty line', currentValue: '' },
        { id: 'k-bang', label: '! cmd', description: 'Host user-shell execution is available only when the backend provides it; ! submits the completed command and its output to the Session, !! keeps the result presentation-only', currentValue: '' },
        { id: 'sep-help', label: color.border('─'.repeat(34)), currentValue: '' },
        ...runner.listScopedCommands()
          .map(command => ({
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
}
