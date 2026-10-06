/**
 * The surface-owned completion-notification and terminal-focus presentation
 * (TS3 §31).
 *
 * This owner holds the ONE `CompletionNotificationController`, the ONE
 * `TerminalFocusTracker` and the ONE `TerminalNotifier` for the mounted surface,
 * plus the terminal focus-reporting enable/disable writes. It is constructed
 * once by `createSurfaceRuntime()` and lives for the surface's lifetime; nothing
 * here is released by a teardown step (the presentation is process-end state,
 * exactly as before the split).
 *
 * Preserved rules:
 *
 * - a notification failure is Client-local UX and must NEVER crash the TUI (the
 *   sink wrapper contains synchronous throws);
 * - the controller consumes the AUTHORITATIVE `agent/status` runtime fact through
 *   the single `onAgentStatus` / `setCompletionOwner` seam — never `turn/end`,
 *   timers or debounces;
 * - a focus report only records tracker state; any REAL user input restores
 *   'focused' so a missed FOCUS_IN can never falsely notify;
 * - the focus-reporting write goes through the injected guarded writer and every
 *   failure is contained (a broken stdout may not fail the TUI mount or leak the
 *   CSI mode into the shell).
 *
 * @module @xmoon76/dsh-pi-tui/app/surface/notification-runtime
 */

import { CompletionNotificationController } from '../../notification/controller.ts'
import { parseNotificationMethod, parseNotificationMode } from '../../notification/settings.ts'
import {
  DISABLE_FOCUS_REPORTING,
  ENABLE_FOCUS_REPORTING,
  FOCUS_IN_SEQUENCE,
  FOCUS_OUT_SEQUENCE,
  TerminalFocusTracker,
} from '../../notification/terminal-focus.ts'
import { TerminalNotifier, type TerminalNotifierWriter } from '../../notification/terminal-notifier.ts'

/** One completion status fact (the controller's parameter type). */
export type AgentLifecycleStatus = Parameters<CompletionNotificationController['onAgentStatus']>[1]

/** The notification presentation inputs; one cohesive lifetime. */
export interface NotificationRuntimeOptions {
  /** The guarded terminal sink shared with the runner's fatal-path focus
   *  disable (the sink is stateless; both writers emit the same sequences). */
  readonly notificationWriter: TerminalNotifierWriter
  /** The persisted notification settings at startup (parsed by this owner). */
  readonly notificationMode: string | undefined
  readonly notificationMethod: string | undefined
}

/** The surface notification/focus owner `createSurfaceRuntime()` consumes. */
export interface NotificationRuntime {
  /**
   * The completion-owner fence (A2 seam): the notification controller fences by
   * the EXACT Direct `Agent.id` — a late `agent/status` from a retired agent
   * must never notify. `undefined` on the teardown path.
   */
  setCompletionOwner(identity: string | undefined): void
  /** The ONLY completion-controller status feed (the `agent/status` handler). */
  onAgentStatus(agentId: string, status: AgentLifecycleStatus): void
  /** The notification settings write path (`/notify`, `agent/status` policy). */
  setMode(mode: string): void
  setMethod(method: string): void
  /** A terminal focus report (CSI ? 1004): the tracker only records state. */
  handleTerminalFocus(focused: boolean): void
  /** Any REAL input proves the user is operating the terminal (restores
   *  'focused' so a missed FOCUS_IN never falsely notifies). */
  noteUserInput(): void
  /** Enable focus reporting at mount (CSI ? 1004). */
  enableFocusReporting(): void
  /** Disable focus reporting on every exit path (idempotent). */
  disableFocusReporting(): void
}

/** Create the surface notification/focus owner. */
export function createNotificationRuntime(options: NotificationRuntimeOptions): NotificationRuntime {
  // Completion notifications (A4-4): settled detection, focus detection,
  // terminal output and settings parsing stay separate modules, never a blob.
  // The controller consumes the AUTHORITATIVE `agent/status` runtime fact (same
  // live main agent, observed running -> idle) — never `turn/end`, timers or
  // debounces. The sink wrapper contains synchronous throws so a notification
  // failure can never crash the TUI.
  const terminalNotifier = new TerminalNotifier(options.notificationWriter)
  const completionController = new CompletionNotificationController((method, title, body) => {
    try {
      terminalNotifier.notify(method, title, body)
    } catch {
      // A notification failure is Client-local UX: never crash the TUI.
    }
  })
  const terminalFocusTracker = new TerminalFocusTracker()
  completionController.setMode(parseNotificationMode(options.notificationMode))
  completionController.setMethod(parseNotificationMethod(options.notificationMethod))

  return {
    setCompletionOwner(identity) {
      completionController.setLiveAgent(identity)
    },
    onAgentStatus(agentId, status) {
      completionController.onAgentStatus(agentId, status)
    },
    setMode(mode) {
      completionController.setMode(parseNotificationMode(mode))
    },
    setMethod(method) {
      completionController.setMethod(parseNotificationMethod(method))
    },
    handleTerminalFocus(focused) {
      terminalFocusTracker.handleFocusReport(focused ? FOCUS_IN_SEQUENCE : FOCUS_OUT_SEQUENCE)
      completionController.setFocus(terminalFocusTracker.state)
    },
    noteUserInput() {
      terminalFocusTracker.markFocused()
      completionController.setFocus(terminalFocusTracker.state)
    },
    enableFocusReporting() {
      // The guarded writer swallows a broken-stream error; a synchronous throw
      // is contained so a dead stdout can never fail the TUI mount.
      try {
        options.notificationWriter.write(ENABLE_FOCUS_REPORTING)
      } catch {
        // A broken stdout degrades the notification capability silently.
      }
    },
    disableFocusReporting() {
      // Disable terminal focus reporting on every exit path so the mode can
      // never leak into the shell; idempotent (a startup failure that never
      // enabled it writes a harmless no-op).
      try {
        options.notificationWriter.write(DISABLE_FOCUS_REPORTING)
      } catch {
        // The stream may already be gone during teardown; best effort.
      }
    },
  }
}
