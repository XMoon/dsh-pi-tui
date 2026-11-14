/**
 * The Client's narrow ACP server control port.
 *
 * ONE semantic surface for the local Host ACP v1 Unix socket listener, served by
 * each backend's own adapter:
 *
 * ```text
 * Direct   truthful unavailable (the local ACP listener is a Split Host
 *          capability; the Direct process owns no such listener)
 * Remote   the private `piTuiAcpAccess` Host service over the ONE mounted
 *          official Client contribution
 * ```
 *
 * The port owns NO ACP state: every call reaches the Host authority (the single
 * Host-entry-owned runtime controller) and returns what the Host actually
 * reached. The persisted next-launch preference `autoStart` is a DIFFERENT
 * authority and is served by the ConfigPort, never by this port; saving the
 * preference never enables or disables the running listener.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/acp-access-port
 */

/**
 * The availability of the local ACP listener on the Host, as the Client port
 * reports it. It is a SEMANTIC DTO — deliberately independent of the package's
 * private wire module, so the public command-runner declaration does not pull the
 * private Typert contract (and its protocol augmentation) into the published root
 * types. The Host service and the Remote adapter speak their own structurally
 * identical vocabulary at their own layers.
 *
 * `disabled` — no listener is bound and no bind/close is in flight. `enabled` —
 * the owned `net.Server` is listening and its own socket inode is still valid.
 * `changing` — one serialized bind/close is still running. `unavailable` — the
 * listener handle exists but cannot be proven healthy, or the Host is shutting
 * down; `reason` is a fixed, redacted category, never a socket pathname, launch
 * token, cookie or profile path.
 */
export type AcpAccessStatus =
  | { readonly state: 'disabled' }
  | { readonly state: 'enabled' }
  | { readonly state: 'changing' }
  | { readonly state: 'unavailable'; readonly reason: string }

/** The ONE Client-side control surface of the Host's local ACP listener. */
export interface AcpAccessPort {
  /** The Host's current listener state, read live on every call. */
  getStatus(): Promise<AcpAccessStatus>
  /** Enable or disable the local ACP listener on THIS Host. */
  setEnabled(enabled: boolean): Promise<AcpAccessStatus>
}
