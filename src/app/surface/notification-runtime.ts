/**
 * The surface-owned completion-notification LIFECYCLE (TS3 §31, TS5 §14.3).
 *
 * This owner holds the ONE `CompletionNotificationController` for the mounted
 * surface and coordinates the completion-owner identity, the authoritative
 * `agent/status` feed, the persisted mode/method policy and the focus policy.
 * It does NOT hold the terminal facts: the `TerminalFocusTracker`, the
 * `TerminalNotifier` and the focus-reporting `CSI ? 1004` writes live in the
 * injected structural presentation (`tui/notification/**`), which the
 * composition zone selects and passes in.
 *
 * It is constructed once by `createSurfaceRuntime()` and lives for the surface's
 * lifetime; nothing here is released by a teardown step (the presentation is
 * process-end state, exactly as before the split).
 *
 * Preserved rules:
 *
 * - a notification failure is Client-local UX and must NEVER crash the TUI (the
 *   presentation contains its own synchronous throws);
 * - the controller consumes the AUTHORITATIVE `agent/status` runtime fact through
 *   the single `onAgentStatus` / `setCompletionOwner` seam — never `turn/end`,
 *   timers or debounces;
 * - a focus report only records presentation state; any REAL user input restores
 *   'focused' so a missed FOCUS_IN can never falsely notify;
 * - the focus-reporting write goes through the injected guarded writer inside the
 *   presentation and every failure is contained (a broken stdout may not fail the
 *   TUI mount or leak the CSI mode into the shell).
 *
 * @module @xmoon76/dsh-pi-tui/app/surface/notification-runtime
 */

import { CompletionNotificationController } from '../../domain/notification/controller.ts'
import { parseNotificationMethod, parseNotificationMode, type NotificationMethod } from '../../domain/notification/settings.ts'
import type { TerminalFocusState } from '../../domain/notification/types.ts'

/** One completion status fact (the controller's parameter type). */
export type AgentLifecycleStatus = Parameters<CompletionNotificationController['onAgentStatus']>[1]

/**
 * The structural terminal presentation this owner consumes (TS5 §14.3). The
 * composition zone selects the concrete `tui/notification/**` implementation
 * and injects it, so this application module declares the port it needs and
 * never imports a terminal module.
 */
export interface TerminalNotificationPresentation {
  /** Feed one terminal focus report (CSI ? 1004, already classified). */
  handleFocusReport(focused: boolean): void
  /** Any REAL input proves the terminal is focused (a missed FOCUS_IN must
   *  never leave the tracker believing the terminal is unfocused). */
  markFocused(): void
  /** The current neutral focus state the completion policy reads. */
  focusState(): TerminalFocusState
  /** Emit one completion notification through the guarded writer. */
  notify(method: NotificationMethod, title: string, body: string): void
  /** Enable focus reporting at mount (CSI ? 1004 h). */
  enableFocusReporting(): void
  /** Disable focus reporting on every exit path (idempotent). */
  disableFocusReporting(): void
}

/** The notification presentation inputs; one cohesive lifetime. */
export interface NotificationRuntimeOptions {
  /**
   * The concrete terminal presentation (TS5 §14.3): the composition zone
   * selects it, so this application owner never imports a `tui/**` module. It
   * owns the focus tracker, the focus-reporting mode writes and the OSC/bell
   * notifier.
   */
  readonly presentation: TerminalNotificationPresentation
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
  // debounces. The presentation contains its own writer failures so a
  // notification failure can never crash the TUI.
  const presentation = options.presentation
  const completionController = new CompletionNotificationController(
    (method, title, body) => presentation.notify(method, title, body),
  )
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
      presentation.handleFocusReport(focused)
      completionController.setFocus(presentation.focusState())
    },
    noteUserInput() {
      presentation.markFocused()
      completionController.setFocus(presentation.focusState())
    },
    enableFocusReporting() {
      presentation.enableFocusReporting()
    },
    disableFocusReporting() {
      presentation.disableFocusReporting()
    },
  }
}
