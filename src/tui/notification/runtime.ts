/**
 * The concrete terminal notification presentation (TS5 §14.2/§14.3): the ONE
 * object the composition zone selects and injects into the application owners.
 * It owns the terminal focus tracker, the focus-reporting mode writes and the
 * OSC/bell notifier — everything that knows about terminal sequences.
 *
 * The application owner keeps the lifecycle and DECLARES the structural port it
 * consumes (`app/surface/notification-runtime.ts`); the composition zone wires
 * this factory to it, so no application module imports a `tui/**` path. This
 * module only turns those decisions into terminal facts, and contains a writer
 * failure (a notification is Client-local UX and must never crash the TUI). Its
 * returned shape stays STRUCTURAL: the composition zone's injection into the
 * application port is what pins the two sides together.
 * @module @xmoon76/dsh-pi-tui/tui/notification/runtime
 */

import type { NotificationMethod } from '../../domain/notification/settings.ts'
import {
  DISABLE_FOCUS_REPORTING,
  ENABLE_FOCUS_REPORTING,
  FOCUS_IN_SEQUENCE,
  FOCUS_OUT_SEQUENCE,
  TerminalFocusTracker,
} from './terminal-focus.ts'
import { TerminalNotifier, type TerminalNotifierWriter } from './terminal-notifier.ts'

/** The presentation's construction options. */
export interface TerminalNotificationPresentationOptions {
  /** The guarded terminal sink (the runner's fatal-path focus disable shares
   *  it; the sink is stateless, both writers emit the same sequences). */
  readonly writer: TerminalNotifierWriter
}

/** Create the terminal notification presentation for one process surface. */
export function createTerminalNotificationPresentation(
  options: TerminalNotificationPresentationOptions,
) {
  const terminalNotifier = new TerminalNotifier(options.writer)
  const terminalFocusTracker = new TerminalFocusTracker()
  return {
    handleFocusReport(focused: boolean) {
      terminalFocusTracker.handleFocusReport(focused ? FOCUS_IN_SEQUENCE : FOCUS_OUT_SEQUENCE)
    },
    markFocused() {
      terminalFocusTracker.markFocused()
    },
    focusState() {
      return terminalFocusTracker.state
    },
    notify(method: NotificationMethod, title: string, body: string) {
      // A notification failure is Client-local UX: never crash the TUI.
      try {
        terminalNotifier.notify(method, title, body)
      } catch {
        // A broken stdout degrades the notification capability silently.
      }
    },
    enableFocusReporting() {
      // The guarded writer swallows a broken-stream error; a synchronous throw
      // is contained so a dead stdout can never fail the TUI mount.
      try {
        options.writer.write(ENABLE_FOCUS_REPORTING)
      } catch {
        // A broken stdout degrades the notification capability silently.
      }
    },
    disableFocusReporting() {
      // Disable terminal focus reporting on every exit path so the mode can
      // never leak into the shell; idempotent (a startup failure that never
      // enabled it writes a harmless no-op).
      try {
        options.writer.write(DISABLE_FOCUS_REPORTING)
      } catch {
        // The stream may already be gone during teardown; best effort.
      }
    },
  }
}
