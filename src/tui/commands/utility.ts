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
import { color } from '../theme/runtime.ts'
import type { ClientReloadRefusalReason, RegisterOne, RegisterTuiCommand, TuiCommandRunner } from '../../commands.ts'

/** The runner operations the utility commands consume. */
type UtilityCommandRunner = Pick<TuiCommandRunner, 'requestExit' | 'listScopedCommands' | 'app' | 'requestClientReload'>

export interface ExitCommandDeps {
  runner: Pick<UtilityCommandRunner, 'requestExit'>
  registerTuiCommand: RegisterTuiCommand
}

export interface HelpCommandDeps {
  runner: Pick<UtilityCommandRunner, 'listScopedCommands' | 'app'>
  registerOne: RegisterOne
}

/** The ONE fixed user notice of every Client reload decision (English). */
export const CLIENT_RELOAD_REFUSAL_NOTICES: Readonly<Record<ClientReloadRefusalReason, string>> = {
  unavailable: 'Client reload is available only in the split Client.',
  'not-ready': 'Client reload is unavailable until the current Client is connected and ready.',
  'draft-text': 'Client reload blocked: finish or clear the editor draft first.',
  attachments: 'Client reload blocked: remove or submit the staged attachments first.',
  submission: 'Client reload blocked: wait for the pending submission to settle.',
  interaction: 'Client reload blocked: finish the current Question or Approval first.',
  transition: 'Client reload blocked: wait for the current session operation to settle.',
  'already-current': 'Client reload skipped: this Client already runs the installed build.',
  'target-invalid': 'Client reload failed: the installed replacement Client is unavailable or incompatible.',
  stopping: 'Client reload is unavailable because this Client is stopping.',
}

export interface ReloadClientCommandDeps {
  runner: Pick<UtilityCommandRunner, 'requestClientReload'>
  registerTuiCommand: RegisterTuiCommand
  /** Record this command's draft disposition (the command line is never
   *  restored into the editor on a refusal). */
  recordCommandDraftDisposition: (commandId: string | undefined, disposition: 'restored' | 'suppressed') => void
}

/**
 * M4 PR4 `/reload-client` — the manual split-Client process reload.
 *
 * It is a BARE Client-local command: no alias, no `input` schema, no
 * keybinding. The handler performs no wait and starts nothing itself; the
 * composed implementation (the runner's `requestClientReload`) makes the
 * Client-local safety decision and, only when safe, asks the process entry's
 * ONE-shot reexec handler in the SAME synchronous stack. A refusal returns its
 * fixed notice here; `runLocalCommand`/the card-less submission route is the
 * notice owner, and an accepted request never publishes a second message
 * because the process is about to replace the old TUI.
 */
export function registerReloadClientCommand({ runner, registerTuiCommand, recordCommandDraftDisposition }: ReloadClientCommandDeps): void {
  registerTuiCommand({
    name: 'reload-client',
    description: 'Reload this split Client process from the installed build (the Host and session stay)',
    handler: (invocation) => {
      // The command line is UI control, not user text: never restore it.
      recordCommandDraftDisposition(invocation.commandId, 'suppressed')
      const request = runner.requestClientReload
      if (request === undefined) return { kind: 'error', text: CLIENT_RELOAD_REFUSAL_NOTICES.unavailable }
      const result = request()
      if (result.kind === 'accepted') return { kind: 'success' }
      return { kind: 'error', text: CLIENT_RELOAD_REFUSAL_NOTICES[result.reason] }
    },
  })
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
      // PR3-A: /help's keymap labels are PiTui chrome; explicit unavailability
      // on a non-PiTui renderer instead of a crash.
      if (app === undefined) return { kind: 'error', text: 'keymap labels are unavailable in this renderer' }
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
      if (app === undefined) return { kind: 'error', text: 'the settings panel is unavailable in this renderer' }
      app.openSettings(rows, () => {}, () => {})
      return { kind: 'success' }
    },
  })
}
