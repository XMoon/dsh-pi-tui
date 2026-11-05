/**
 * The narrow `/web` presentation contract (M5-W PR-C).
 *
 * The command retains EVERY read, write and currentness owner: it reads the
 * Host status through the {@link WebAccessPort}, performs the Host mutation,
 * re-reads the authoritative state and decides what the menu shows. A presenter
 * holds only the local rendering/keyboard/mouse state of the ONE short menu and
 * reports the user's explicit intent back through {@link WebAccessRequest}.
 *
 * Two renderers present the SAME request: the default PiTui short Settings
 * overlay and the experimental TSP native picker. Neither presenter may reach a
 * Host service, open a second Connection, or keep a cached Web state — a
 * presenter without a live intent does nothing.
 *
 * @module app/command/web-access-presentation
 */

import type { WebAccessStatus } from '../../runtime/web-access-port.ts'
import type { OwnedTaskOptions } from '../../runtime/process/tasks.ts'

/**
 * One status read as the command's read owner reports it.
 *
 * `status` is the Host's OWN vocabulary. `unavailable` is the CLIENT-side
 * failure to read it (a disconnected Client, a superseded generation): the menu
 * must say the state is unreadable instead of presenting the last-known value
 * or guessing `disabled`.
 */
export type WebAccessReadOutcome =
  | { readonly kind: 'status'; readonly status: WebAccessStatus }
  | { readonly kind: 'unavailable'; readonly message: string }

/**
 * The explicit user intents a menu produces. They are PRESENTATION ids only:
 * the command maps each one onto the ONE Host/api action it owns.
 */
export type WebAccessActionId = 'enable' | 'disable' | 'open-browser' | 'copy-link'

/** The command-owned request ONE menu presents. */
export interface WebAccessRequest {
  /**
   * Recheck the command's presentation token: the same fence a stale menu uses
   * before touching anything. A presenter whose request is no longer current
   * must not read, act or repaint.
   */
  isCurrent(): boolean
  /**
   * The ONE Host status read (the command's read owner). A presenter calls this
   * once per menu entry and on no other occasion; there is no polling.
   */
  readStatus(): Promise<WebAccessReadOutcome>
  /**
   * Run ONE explicit user intent. The command closes the current menu, performs
   * the Host call, re-reads the status and reopens the same menu with the real
   * result; the presenter never performs the write itself.
   */
  act(action: WebAccessActionId): void
  /** The owned-task entry (the runner's diag/session wiring pre-attached). */
  runOwned<T>(
    label: string,
    task: () => T | Promise<T>,
    options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>,
  ): void
}

/** One menu instance. Closing retires the presentation only — never a Host write. */
export interface WebAccessMenuHandle {
  /** Enter the loading state (the menu was just opened; the read is running). */
  setLoading(): void
  /**
   * Present ONE admitted action while it is running. The menu shows the honest
   * progress statement and offers no write until the command reports the
   * settled read back through {@link setStatus}.
   */
  setPending(message: string): void
  /** Present one settled read outcome (a Host status or an unreadable state). */
  setStatus(outcome: WebAccessReadOutcome): void
  isDisposed(): boolean
  /** Retire this menu; it cancels no admitted business operation. */
  close(): void
}

export interface WebAccessPresentation {
  open(request: WebAccessRequest): WebAccessMenuHandle
  /** The renderer-neutral notice sink (an opener request, a copy result). */
  notify(message: string, kind?: 'info' | 'error'): void
}
