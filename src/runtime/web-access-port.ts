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

/**
 * The availability of the official Web frontend on the Host, as the Client
 * port reports it. It is a SEMANTIC DTO — deliberately independent of the
 * package's private wire module, so the public command-runner declaration does
 * not pull the private Typert contract (and its protocol augmentation) into the
 * published root types. The Host service and the Remote adapter speak their own
 * structurally identical vocabulary at their own layers.
 */
export type WebAccessStatus =
  | { readonly state: 'disabled' }
  | { readonly state: 'enabled' }
  | { readonly state: 'changing' }
  | { readonly state: 'unavailable'; readonly reason: string }

/**
 * The official authenticated launch URL of the Host's Web frontend. The value
 * carries the official launch token, so it is only requested by an explicit
 * user action and is never stored, logged or attached to a status object.
 */
export interface WebAccessUrl {
  readonly url: string
}

/** The ONE Client-side control surface of the Host's official Web frontend. */
export interface WebAccessPort {
  /** The Host's current state, read live on every call. */
  getStatus(): Promise<WebAccessStatus>
  /** Enable or disable the official Web frontend on THIS Host. */
  setEnabled(enabled: boolean): Promise<WebAccessStatus>
  /** The official authenticated launch URL; only meaningful while `enabled`. */
  getAuthenticatedUrl(): Promise<WebAccessUrl>
}
