/**
 * Built-in command definitions for the authorization/provider domain
 * (`/login`, `/logout`).
 *
 * Phase 3C / C2-MA: the commands are NAVIGATION only. They resolve the typed
 * argument through the ONE shared Auth target resolver and open the Settings
 * workspace at the resulting Models/Account destination. The final credential
 * write or clear always happens in the workspace after an explicit
 * confirmation; no picker, question flow, output viewer or credential
 * operation lives here.
 *
 * @module @xmoon76/dsh-pi-tui/tui/commands/auth
 */

import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { RegisterOne, TuiCommandRunner } from '../../commands.ts'
import {
  resolveLoginDestination,
  resolveLogoutDestination,
  type AuthDestination,
} from '../../app/command/credential-workflow.ts'

/** The runner operations the auth commands consume. */
type AuthCommandRunner = Pick<TuiCommandRunner, 'config'>

export interface AuthCommandDeps {
  runner: AuthCommandRunner
  registerOne: RegisterOne
  /** The ONE Settings-workspace navigation entry (owned by the settings
   *  command layer; it never performs a credential write itself). */
  openAuthWorkspace: (destination: AuthDestination) => CommandResult
}

export interface AuthCommandRegistrars {
  registerLogin(): void
  registerLogout(): void
}

/** Create the auth-command registrars. */
export function createAuthCommands(deps: AuthCommandDeps): AuthCommandRegistrars {
  const { runner, registerOne, openAuthWorkspace } = deps

  const registerLogin = (): void => {
    registerOne({
      name: 'login',
      description: 'Open Models to configure provider credentials or sign in to DeepSeek Account',
      input: { hint: '[<route|env-var|deepseek-account>]' },
      handler: (invocation) => {
        const options = runner.config.providers.listCredentialOptions()
        const targets = runner.config.authorization.listTargets()
        return openAuthWorkspace(resolveLoginDestination(invocation.rawInput, options, targets))
      },
    })
  }

  const registerLogout = (): void => {
    registerOne({
      name: 'logout',
      description: 'Open Models to clear a stored provider credential or sign out of DeepSeek Account',
      input: { hint: '[<route|env-var|deepseek-account>]' },
      handler: (invocation) => {
        const options = runner.config.providers.listCredentialOptions()
        const targets = runner.config.authorization.listTargets()
        return openAuthWorkspace(resolveLogoutDestination(invocation.rawInput, options, targets))
      },
    })
  }

  return { registerLogin, registerLogout }
}
