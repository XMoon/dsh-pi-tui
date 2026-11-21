/**
 * The `/acp` command (PO-5E): the ONE Client quick control of the Split Host's
 * local ACP v1 Unix-socket listener.
 *
 * The command owns EVERY read and write:
 *
 * ```text
 * /acp → presentation.open(request)
 *      → request.readStatus()            one Host status read (no polling)
 *      → request.act(action)             one explicit user intent
 *          Enable/Disable                SAME Host piTuiAcpAccess.setEnabled
 *                                        with the generation bound to the read
 *      → one authoritative status re-read → the menu is reprojected
 * ```
 *
 * It is a SESSIONLESS, LOCAL command: typing `/acp` never creates a Session,
 * never submits a prompt, never starts a second Host, never changes the default
 * backend and never persists the next-launch `autoStart` preference. The
 * presenters (default PiTui short menu, experimental TSP native picker) hold
 * only their own local UI state and receive the SAME request, so there is
 * exactly one business authority for both renderers.
 *
 * @module tui/commands/acp-access
 */

import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {
  AcpAccessActionId,
  AcpAccessMenuHandle,
  AcpAccessNotice,
  AcpAccessPresentation,
  AcpAccessReadOutcome,
  AcpAccessRequest,
} from '../../app/command/acp-access-presentation.ts'
import type { RegisterOne, TuiCommandRunner } from '../../commands.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { runOwned } from '../../runtime/process/tasks.ts'
import type { TuiApp } from '../../tui-app.ts'
import { pituiAcpAccessPresentation } from '../pickers/acp-access-presentation-pitui.ts'

/** The exact Direct/unavailable statement (the command's own product copy). */
const DIRECT_UNSUPPORTED = 'ACP server controls are available only in a Split Client.'

/**
 * The command's OWN runner face: only the members `/acp` really uses, so the
 * handler can never reach another backend capability and a test drives the
 * command without a full runner.
 */
export interface AcpAccessCommandRunner {
  readonly backendKind: TuiCommandRunner['backendKind']
  readonly acpAccess: TuiCommandRunner['acpAccess']
  readonly diag: TuiCommandRunner['diag']
  readonly currentSessionId: TuiCommandRunner['currentSessionId']
}

export interface AcpAccessCommandDeps {
  readonly runner: AcpAccessCommandRunner
  /** The mounted PiTui surface, or `undefined` on a non-PiTui renderer. */
  readonly app: TuiApp | undefined
  /** The renderer-neutral notice sink (the same one the other commands use). */
  readonly notify: (text: string, kind?: 'info' | 'error') => void
  readonly registerOne: RegisterOne
  /** The TSP native presenter (absent on a PiTui/headless mount). */
  readonly acpPresentation?: AcpAccessPresentation | undefined
}

export interface AcpAccessCommands {
  registerAcp(): void
}

/** The visible progress statement of one admitted action. */
function pendingLabel(action: AcpAccessActionId): string {
  switch (action) {
    case 'enable': return 'Enabling ACP…'
    case 'disable': return 'Disabling ACP…'
  }
}

/**
 * One status read as the command's read owner reports it, plus the Connection
 * generation captured BEFORE that read. A successful read binds the returned
 * state to that generation; a failed read binds nothing.
 */
interface BoundRead {
  readonly outcome: AcpAccessReadOutcome
  readonly generation: unknown
}

export function createAcpAccessCommands(deps: AcpAccessCommandDeps): AcpAccessCommands {
  const { runner, registerOne } = deps
  /** The current menu authority: a newer `/acp` supersedes the previous one. */
  let menuToken = 0
  let menu: AcpAccessMenuHandle | undefined

  const registerAcp = (): void => {
    registerOne({
      name: 'acp',
      description: 'Control the Split Host local ACP listener (status, enable/disable)',
      handler: (): CommandResult => {
        if (runner.backendKind !== 'remote') {
          deps.notify(DIRECT_UNSUPPORTED, 'error')
          return { kind: 'error', text: DIRECT_UNSUPPORTED }
        }
        const presentation: AcpAccessPresentation | undefined = deps.acpPresentation
          ?? (deps.app === undefined ? undefined : pituiAcpAccessPresentation(deps.app))
        if (presentation === undefined) {
          const text = 'the ACP server controls are unavailable in this renderer'
          deps.notify(text, 'error')
          return { kind: 'error', text }
        }
        openMenu(presentation)
        return { kind: 'success' }
      },
    })
  }

  /** ONE Host status read bound to the generation observed when it was issued. */
  const readBound = async (): Promise<BoundRead> => {
    const generation = runner.acpAccess.currentGeneration()
    try {
      return { outcome: { kind: 'status', status: await runner.acpAccess.getStatus() }, generation }
    } catch (error) {
      return { outcome: { kind: 'unavailable', message: safeErrorMessage(error) }, generation }
    }
  }

  /** Mount ONE menu on a fresh authority token (the previous one is retired). */
  const openMenu = (presentation: AcpAccessPresentation): void => {
    const token = ++menuToken
    const previous = menu
    menu = undefined
    previous?.close()
    /**
     * The generation this menu's CURRENT state fact belongs to. It is only
     * stored after an authoritative read settled; `setEnabled` is then fenced by
     * the port, so an old menu can never write to a newly connected Host. A
     * post-action re-read rebinds the menu to the then-current generation.
     */
    let observedGeneration: unknown
    const readStatus = async (): Promise<AcpAccessReadOutcome> => {
      const read = await readBound()
      if (read.outcome.kind === 'status') observedGeneration = read.generation
      return read.outcome
    }
    const request: AcpAccessRequest = {
      isCurrent: () => token === menuToken,
      readStatus,
      act: (action) => {
        if (token !== menuToken) return
        dispatch(presentation, action, observedGeneration, readStatus)
      },
      runOwned: (label, task, options) => {
        runOwned(label, task, { ...options, diag: runner.diag, sessionId: () => runner.currentSessionId })
      },
    }
    menu = presentation.open(request)
  }

  /** One settled action: the Host's status plus the visible result line. */
  interface ActionSettlement {
    readonly outcome: AcpAccessReadOutcome
    readonly notice?: AcpAccessNotice
  }

  /**
   * Run ONE user intent through the Host port. The menu is a LOADING/pending
   * projection while the request runs; the settled status (or the failure
   * notice) is always the Host's own answer, never the requested boolean. A
   * refusal is never retried automatically; the user must act explicitly again.
   */
  const dispatch = (
    presentation: AcpAccessPresentation,
    action: AcpAccessActionId,
    expectedGeneration: unknown,
    readStatus: () => Promise<AcpAccessReadOutcome>,
  ): void => {
    const handle = menu
    if (handle === undefined || handle.isDisposed()) return
    handle.setPending(pendingLabel(action))
    runOwned(`acp ${action}`, async (): Promise<ActionSettlement> => {
      let notice: AcpAccessNotice | undefined
      try {
        await runner.acpAccess.setEnabled(action === 'enable', expectedGeneration)
      } catch (error) {
        const failure = `acp ${action}: ${safeErrorMessage(error)}`
        presentation.notify(failure, 'error')
        notice = { message: failure, kind: 'error' }
      }
      // ONE authoritative re-read AFTER the action (success or refusal): the
      // menu presents the Host's own settled state, never the requested one.
      return { outcome: await readStatus(), ...(notice === undefined ? {} : { notice }) }
    }, {
      diag: runner.diag,
      sessionId: () => runner.currentSessionId,
      isCancellation: () => handle.isDisposed(),
      onResult: (settlement) => {
        if (handle.isDisposed()) return
        handle.setStatus(settlement.outcome, settlement.notice)
      },
    })
  }

  return { registerAcp }
}
