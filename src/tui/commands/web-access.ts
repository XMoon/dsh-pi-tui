/**
 * The `/web` command (M5-W PR-C): the ONE Client control entry of the Split
 * Host's official Web frontend.
 *
 * The command owns EVERY read and write:
 *
 * ```text
 * /web → presentation.open(request)
 *      → request.readStatus()            one Host status read (no polling)
 *      → request.act(action)             one explicit user intent
 *          Enable/Disable                SAME Host piTuiWebAccess.setEnabled
 *          Open Browser / Copy Link      official authenticated URL, Client-local
 *                                        opener/clipboard ONLY
 *      → one authoritative status re-read → the menu is reprojected
 * ```
 *
 * It is a SESSIONLESS, LOCAL command: typing `/web` never creates a Session,
 * never submits a prompt, never starts a second Host and never changes the
 * default backend. The presenters (default PiTui short menu, experimental TSP
 * native picker) hold only their own local UI state and receive the SAME
 * request, so there is exactly one business authority for both renderers.
 *
 * @module tui/commands/web-access
 */

import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {
  WebAccessActionId,
  WebAccessMenuHandle,
  WebAccessPresentation,
  WebAccessReadOutcome,
  WebAccessRequest,
} from '../../app/command/web-access-presentation.ts'
import type { RegisterOne, TuiCommandRunner } from '../../commands.ts'
import { openExternalUrl } from '../../client/url/open.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { runOwned } from '../../runtime/process/tasks.ts'
import type { TuiApp } from '../../tui-app.ts'
import { pituiWebAccessPresentation } from '../pickers/web-access-presentation-pitui.ts'

/** The exact Direct/unavailable statement (the command's own product copy). */
const DIRECT_UNSUPPORTED = 'Web frontend controls are available only in a Split Client.'

/**
 * The command's OWN runner face: only the members `/web` really uses, so the
 * handler can never reach another backend capability and a test drives the
 * command without a full runner.
 */
export interface WebAccessCommandRunner {
  readonly backendKind: TuiCommandRunner['backendKind']
  readonly webAccess: TuiCommandRunner['webAccess']
  readonly copyToClipboard: TuiCommandRunner['copyToClipboard']
  readonly diag: TuiCommandRunner['diag']
  readonly currentSessionId: TuiCommandRunner['currentSessionId']
}

export interface WebAccessCommandDeps {
  readonly runner: WebAccessCommandRunner
  /** The mounted PiTui surface, or `undefined` on a non-PiTui renderer. */
  readonly app: TuiApp | undefined
  /** The renderer-neutral notice sink (the same one the other commands use). */
  readonly notify: (text: string, kind?: 'info' | 'error') => void
  readonly registerOne: RegisterOne
  /** The TSP native presenter (absent on a PiTui/headless mount). */
  readonly webPresentation?: WebAccessPresentation | undefined
  /** The Client-local URL opener (production: the platform opener). */
  readonly openUrl?: (url: string) => void
}

export interface WebAccessCommands {
  registerWeb(): void
}

/** The visible progress statement of one admitted action. */
function pendingLabel(action: WebAccessActionId): string {
  switch (action) {
    case 'enable': return 'Enabling Web…'
    case 'disable': return 'Disabling Web…'
    case 'open-browser': return 'Opening browser…'
    case 'copy-link': return 'Copying link…'
  }
}

export function createWebAccessCommands(deps: WebAccessCommandDeps): WebAccessCommands {
  const { runner, registerOne } = deps
  /** The current menu authority: a newer `/web` supersedes the previous one. */
  let menuToken = 0
  let menu: WebAccessMenuHandle | undefined

  const registerWeb = (): void => {
    registerOne({
      name: 'web',
      description: 'Control the Split Host Web frontend (status, enable/disable, open, copy link)',
      handler: (): CommandResult => {
        if (runner.backendKind !== 'remote') {
          deps.notify(DIRECT_UNSUPPORTED, 'error')
          return { kind: 'error', text: DIRECT_UNSUPPORTED }
        }
        const presentation: WebAccessPresentation | undefined = deps.webPresentation
          ?? (deps.app === undefined ? undefined : pituiWebAccessPresentation(deps.app))
        if (presentation === undefined) {
          const text = 'the Web frontend controls are unavailable in this renderer'
          deps.notify(text, 'error')
          return { kind: 'error', text }
        }
        openMenu(presentation)
        return { kind: 'success' }
      },
    })
  }

  /** The ONE Host status read; a transport failure is an unreadable state. */
  const readStatus = async (): Promise<WebAccessReadOutcome> => {
    try {
      return { kind: 'status', status: await runner.webAccess.getStatus() }
    } catch (error) {
      return { kind: 'unavailable', message: safeErrorMessage(error) }
    }
  }

  /** Mount ONE menu on a fresh authority token (the previous one is retired). */
  const openMenu = (presentation: WebAccessPresentation): void => {
    const token = ++menuToken
    const previous = menu
    menu = undefined
    previous?.close()
    const request: WebAccessRequest = {
      isCurrent: () => token === menuToken,
      readStatus,
      act: (action) => {
        if (token !== menuToken) return
        dispatch(presentation, action)
      },
      runOwned: (label, task, options) => {
        runOwned(label, task, { ...options, diag: runner.diag, sessionId: () => runner.currentSessionId })
      },
    }
    menu = presentation.open(request)
  }

  /** Re-read the authoritative status and reproject the SAME menu. */
  const refreshMenu = (handle: WebAccessMenuHandle): void => {
    runOwned('web status', readStatus, {
      diag: runner.diag,
      sessionId: () => runner.currentSessionId,
      isCancellation: () => handle.isDisposed(),
      onResult: (outcome) => {
        if (handle.isDisposed()) return
        handle.setStatus(outcome)
      },
    })
  }

  /**
   * Run ONE user intent through the Host port. The menu is a LOADING/pending
   * projection while the request runs; the settled status (or the failure
   * notice) is always the Host's own answer, never the requested boolean.
   */
  const dispatch = (presentation: WebAccessPresentation, action: WebAccessActionId): void => {
    const handle = menu
    if (handle === undefined || handle.isDisposed()) return
    handle.setPending(pendingLabel(action))
    const openUrl = deps.openUrl ?? openExternalUrl
    runOwned(`web ${action}`, async (): Promise<WebAccessReadOutcome> => {
      switch (action) {
        case 'enable':
          await runner.webAccess.setEnabled(true)
          break
        case 'disable':
          await runner.webAccess.setEnabled(false)
          break
        case 'open-browser': {
          const { url } = await runner.webAccess.getAuthenticatedUrl()
          // Client-local opener only: the Host never runs a browser opener.
          openUrl(url)
          presentation.notify('Opening browser… (use Copy Link if it does not open)', 'info')
          break
        }
        case 'copy-link': {
          const { url } = await runner.webAccess.getAuthenticatedUrl()
          const copied = await runner.copyToClipboard(url)
          // Only the boolean acknowledgement counts; the URL never becomes a
          // notice/transcript fallback.
          presentation.notify(copied ? 'Link copied' : 'Clipboard unavailable', copied ? 'info' : 'error')
          break
        }
      }
      // One authoritative re-read AFTER the action: the menu presents the
      // Host's own settled state instead of the requested one.
      return readStatus()
    }, {
      diag: runner.diag,
      sessionId: () => runner.currentSessionId,
      isCancellation: () => handle.isDisposed(),
      onResult: (outcome) => {
        if (handle.isDisposed()) return
        handle.setStatus(outcome)
      },
      onError: (error) => {
        presentation.notify(`web ${action}: ${safeErrorMessage(error)}`, 'error')
        // The Host may have settled the request and failed only the read; the
        // ONE authoritative status re-read is what the menu shows either way.
        if (!handle.isDisposed()) refreshMenu(handle)
      },
    })
  }

  return { registerWeb }
}
