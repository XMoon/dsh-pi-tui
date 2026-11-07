/**
 * The Schedule workspace composition entry (S5-PR4): the ONE place that joins
 * the selected backend's Host Schedule port and Session reader with the
 * mounted PiTui surface's screen lease.
 *
 * The controller is created PER OPEN (`/schedule` → one controller → one
 * `TuiApp.openScheduleWorkspace` lease) and disposed when that lease closes.
 * The panel is opened FIRST and the first Host read starts after it, so the
 * workspace paints its loading state instead of waiting on a Host list. No
 * Session is created, no prompt is submitted and no Host write happens before
 * an explicit user intent.
 *
 * @module @xmoon76/dsh-pi-tui/app/schedule/runtime
 */

import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SchedulePort } from '../../runtime/schedule-port.ts'
import type { SessionReader } from '../../runtime/session-reader-port.ts'
import type { TuiApp } from '../../tui-app.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { ScheduleWorkspaceController, type ScheduleOwnedRunner } from './workspace-controller.ts'

/** The composition inputs of ONE `/schedule` open. */
export interface ScheduleWorkspaceOpenDeps {
  readonly port: SchedulePort
  readonly sessionReader: SessionReader
  /** The mounted PiTui surface, or `undefined` while another renderer owns the terminal. */
  readonly app: () => TuiApp | undefined
  /** The app-owned owned-task entry (its diagnostics stay attached). */
  readonly runOwned: ScheduleOwnedRunner
}

/** The ONE statement of the renderer gap. */
const RENDERER_UNAVAILABLE = 'The schedule workspace is available in the Pi-TUI renderer only.'

/**
 * Open one Schedule workspace over the selected backend. The command handler
 * returns a REAL error when no PiTui surface is mounted (TSP reaches its own
 * capability refusal earlier), and success once the loading panel is leased.
 */
export function openScheduleWorkspace(deps: ScheduleWorkspaceOpenDeps): CommandResult {
  const app = deps.app()
  if (app === undefined) return { kind: 'error', text: RENDERER_UNAVAILABLE }
  const controller = new ScheduleWorkspaceController({
    port: deps.port,
    sessionReader: deps.sessionReader,
    runOwned: deps.runOwned,
  })
  try {
    const handle = app.openScheduleWorkspace({
      snapshot: () => controller.snapshot(),
      dispatch: intent => controller.dispatch(intent),
      // The lease is gone for ANY reason (user Esc, blocking owner, session
      // switch, app teardown): the controller stops publishing and drops its
      // subscriptions. A dispatched Host write is never cancelled here.
      onClose: () => { controller.dispose() },
    })
    // The subscription is owned by this open; `controller.dispose()` (from the
    // lease's onClose) clears every listener, so it cannot outlive the screen.
    controller.subscribe(() => handle.update(controller.snapshot()))
  } catch (error) {
    // A refused lease (another workspace owns the terminal, a blocking modal is
    // open) is a real, displayable refusal: the panel never mounted.
    controller.dispose()
    return { kind: 'error', text: safeErrorMessage(error) }
  }
  // The panel is leased and paints its loading state; the first authoritative
  // read starts only now.
  controller.open()
  return { kind: 'success' }
}
