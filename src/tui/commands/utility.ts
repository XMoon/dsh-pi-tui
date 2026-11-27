/**
 * Built-in command definitions for the utility domain (`/exit`, `/reload-client`).
 *
 * Registration is explicit: the coordinator (`src/commands.ts`) calls each
 * registrar at its frozen position in the built-in registration sequence and
 * owns catalog/provenance/disposal state. This module only defines commands.
 * @module @xmoon76/dsh-pi-tui/commands/utility
 */

import type { ClientReloadRefusalReason, RegisterTuiCommand, TuiCommandRunner } from '../../commands.ts'

/** The runner operations the utility commands consume. */
type UtilityCommandRunner = Pick<TuiCommandRunner, 'requestExit' | 'requestClientReload'>

export interface ExitCommandDeps {
  runner: Pick<UtilityCommandRunner, 'requestExit'>
  registerTuiCommand: RegisterTuiCommand
}

/** The ONE fixed user notice of every Client reload decision (English). */
export const CLIENT_RELOAD_REFUSAL_NOTICES: Readonly<Record<ClientReloadRefusalReason, string>> = {
  'unsupported-platform': 'Client reload is not available on Windows. The current Client is kept. Exit with /exit and relaunch to use an updated build.',
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
    description: 'Exit this TUI (the daemon Host keeps running; stop current work only by choosing it)',
    aliases: ['quit'],
    handler: exitHandler,
  })
}
