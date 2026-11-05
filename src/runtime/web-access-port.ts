/**
 * The Client's narrow Web frontend control port (M5-W PR-C).
 *
 * ONE semantic surface for `/web`, served by each backend's own adapter:
 *
 * ```text
 * Direct   truthful unavailable (the official Web frontend is a Split Host
 *          capability; the Direct process owns no such toggle)
 * Remote   the private `piTuiWebAccess` Host service over the ONE mounted
 *          official Client contribution
 * ```
 *
 * The port owns NO Web state: every call reaches the Host authority and returns
 * what the Host actually reached. `getAuthenticatedUrl()` intentionally returns
 * the official launch URL verbatim — it carries the Host's launch token, so it
 * is only ever requested by an explicit user action and is never stored in a
 * status object, a diagnostic, a trace or the transcript.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/web-access-port
 */

import type {
  PiTuiWebAccessAuthenticatedUrl,
  PiTuiWebAccessStatus,
} from './remote/pi-tui-web-access-contract.ts'

/** The ONE Client-side control surface of the Host's official Web frontend. */
export interface WebAccessPort {
  /** The Host's current state, read live on every call. */
  getStatus(): Promise<PiTuiWebAccessStatus>
  /** Enable or disable the official Web frontend on THIS Host. */
  setEnabled(enabled: boolean): Promise<PiTuiWebAccessStatus>
  /** The official authenticated launch URL; only meaningful while `enabled`. */
  getAuthenticatedUrl(): Promise<PiTuiWebAccessAuthenticatedUrl>
}
