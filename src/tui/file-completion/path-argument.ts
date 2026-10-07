/**
 * The TUI path-argument completion adapter (TS8-B, moved out of the
 * historical root mentions module): the `/attach` + `/image` command argument
 * completion. It is CLIENT-local by contract — the Client cwd, the
 * Client-local discovery driver and the Client path-query environment — and
 * never consults `HostFilePort` or the session/Host cwd.
 *
 * It owns the argument-level grammar on top of the neutral completion engine
 * in `./local-path-completion.ts`: leading separator whitespace preservation,
 * the quoted-open-token form, closed-quote refusal, unquoted embedded-space
 * refusal, and reattaching the leading separator to the completed value so the
 * fork's whole-argument apply never glues the path to the command.
 * @module @xmoon76/dsh-pi-tui/tui/file-completion/path-argument
 */

import type { AutocompleteItem } from '@xmoon76/pi-tui'
import { completePath } from './local-path-completion.ts'
import type { PathQueryEnvironment } from '../../domain/file-completion/query.ts'
import type { LocalDiscoveryDriver } from '../../domain/file-completion/discovery-policy.ts'
import {
  ClientLocalDiscoveryDriver,
  clientPathQueryEnvironment,
} from '../../client/file-completion/local-discovery.ts'

/**
 * Complete one command argument text through the LOCALITY discovery driver the
 * caller chose. The caller supplies the explicit Client cwd, environment facts
 * and abort signal; no HostFilePort is involved.
 * @param argument - the raw argument text (including leftover separator
 *   whitespace).
 * @param cwd - the Client cwd completion base.
 * @param driver - the locality's discovery boundary.
 * @param environment - the locality owner's explicit path-query facts.
 * @param signal - the editor's request abort.
 * @param options - `allowEmpty` is true for the editor/provider path (an empty
 *   argument lists the cwd) and false for the command-descriptor hook (an
 *   empty argument completes nothing).
 * @returns the presented items with the leading separator reattached, or null.
 */
export async function completePathArgument(
  argument: string,
  cwd: string,
  driver: LocalDiscoveryDriver,
  environment: PathQueryEnvironment,
  signal: AbortSignal,
  options: { readonly allowEmpty: boolean },
): Promise<AutocompleteItem[] | null> {
  const leading = argument.match(/^[ \t]+/)?.[0] ?? ''
  let token = argument.slice(leading.length)
  if (token === '' && !options.allowEmpty) return null
  let quoted = false
  if (token.startsWith('"')) {
    quoted = true
    token = token.slice(1)
    const close = token.indexOf('"')
    if (close !== -1) {
      // A closed quote is already a complete token. Replacing the whole
      // command argument would otherwise delete text after that quote.
      return null
    }
  } else if (token.includes(' ') || token.includes('\t')) {
    // The fork's argument apply replaces one contiguous argument range, so an
    // unquoted later word must not cause the earlier word to be clobbered.
    return null
  }
  const items = await completePath(token, cwd, driver, environment, signal, { at: false, quoted })
  return items === null ? null : items.map(item => ({ ...item, value: `${leading}${item.value}` }))
}

/**
 * Slash-command PATH-argument compatibility completion (`/image <path>`).
 * It is awaitable because the shared engine's fuzzy fallback is asynchronous
 * and cancellable; the production editor normally reaches the provider-level
 * `/image` branch, but the command descriptor can use this same source when
 * the vendored provider calls its argument hook directly.
 *
 * The empty argument remains quiet in this legacy helper. The editor-level
 * `/image ` context owns the explicit cwd listing, while preserving the old
 * command-hook contract for callers that used an empty argument as "no
 * completion".
 */
export async function suggestPathArgument(
  argumentText: string,
  cwd: string,
  localFdPath: string | null | undefined = undefined,
): Promise<AutocompleteItem[] | null> {
  const driver = new ClientLocalDiscoveryDriver(localFdPath)
  return completePathArgument(
    argumentText,
    cwd,
    driver,
    clientPathQueryEnvironment(),
    new AbortController().signal,
    { allowEmpty: false },
  )
}
