/**
 * The narrow `/acp` presentation contract (PO-5E).
 *
 * The command retains EVERY read, write and currentness owner: it reads the
 * Host listener through the existing {@link AcpAccessPort}, performs the ONE
 * explicit mutation with the generation captured by that read, re-reads the
 * authoritative state and decides what the menu shows. A presenter holds only
 * the local rendering/keyboard/mouse state of the ONE short menu and reports the
 * user's explicit intent back through {@link AcpAccessRequest}.
 *
 * Two renderers present the SAME request: the default PiTui short Settings
 * overlay and the experimental TSP native picker. Neither presenter may reach a
 * Host service, open a second Connection, or keep a cached ACP state — a
 * presenter without a live intent does nothing.
 *
 * These types are transient Client presentation only: they are not a public
 * extension API and they do not change `runtime/acp-access-port.ts`.
 *
 * @module app/command/acp-access-presentation
 */

import type { AcpAccessStatus } from '../../runtime/acp-access-port.ts'
import type { OwnedTaskOptions } from '../../runtime/process/tasks.ts'

/**
 * One status read as the command's read owner reports it.
 *
 * `status` is the Host's OWN vocabulary. `unavailable` is the CLIENT-side
 * failure to read it (a disconnected Client, a superseded generation): the menu
 * must say the state is unreadable instead of presenting the last-known value
 * or guessing `disabled`.
 */
export type AcpAccessReadOutcome =
  | { readonly kind: 'status'; readonly status: AcpAccessStatus }
  | { readonly kind: 'unavailable'; readonly message: string }

/**
 * The explicit user intents a menu produces. They are PRESENTATION ids only:
 * the command maps each one onto the ONE Host/api action it owns.
 */
export type AcpAccessActionId = 'enable' | 'disable'

/** The command-owned request ONE menu presents. */
export interface AcpAccessRequest {
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
  readStatus(): Promise<AcpAccessReadOutcome>
  /**
   * Run ONE explicit user intent. The command marks the menu pending, performs
   * the ONE Host call with the generation bound to the current read, re-reads
   * the status and reprojects the real result; the presenter never performs the
   * write itself.
   */
  act(action: AcpAccessActionId): void
  /** The owned-task entry (the runner's diag/session wiring pre-attached). */
  runOwned<T>(
    label: string,
    task: () => T | Promise<T>,
    options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>,
  ): void
}

/** One transient result line the menu can paint (the same text `notify` sends). */
export interface AcpAccessNotice {
  readonly message: string
  readonly kind: 'info' | 'error'
}

/** One menu instance. Closing retires the presentation only — never a Host write. */
export interface AcpAccessMenuHandle {
  /** Enter the loading state (the menu was just opened; the read is running). */
  setLoading(): void
  /**
   * Present ONE admitted action while it is running. The menu shows the honest
   * progress statement and offers no write until the command reports the
   * settled read back through {@link setStatus}.
   */
  setPending(message: string): void
  /**
   * Present one settled read outcome (a Host status or an unreadable state)
   * plus the optional action result. The notice is painted INSIDE the menu as
   * well as sent through {@link AcpAccessPresentation.notify}, because a menu
   * overlay can cover the base surface's notice line.
   */
  setStatus(outcome: AcpAccessReadOutcome, notice?: AcpAccessNotice): void
  isDisposed(): boolean
  /** Retire this menu; it cancels no admitted business operation. */
  close(): void
}

export interface AcpAccessPresentation {
  open(request: AcpAccessRequest): AcpAccessMenuHandle
  /** The renderer-neutral notice sink. */
  notify(message: string, kind?: 'info' | 'error'): void
}
