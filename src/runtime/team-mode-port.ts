/**
 * The ONE cross-backend Agent Team semantic port: the current Root Session's
 * saved Team mode, its model-request history, and the single official Team
 * mode write.
 *
 * Authority stays with the official Host: the `agentTeam` Session projection
 * owns the saved selection and the `modelSelection` projection owns the
 * "a model request has already run" fact. This port never mirrors an enabled
 * value, never appends a Session event and never guesses a Root identity.
 * Direct and Remote adapters serve the SAME contract; the `/model` picker is
 * the only consumer.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/team-mode-port
 */

/**
 * One synchronous Team state read for one exact Session.
 *
 * `ready` means the caller IS the approved Root of that Session and both
 * official projections are readable. `stale`/`unavailable` never collapse into
 * a default value: a missing `modelSelection` projection is NOT "no request
 * has run".
 */
export type TeamModeSnapshot =
  | { readonly kind: 'ready'; readonly enabled: boolean; readonly modelRequestHistory: 'none' | 'recorded' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'stale'; readonly reason: string }

/**
 * The semantic settlement of one Team mode write. `committed` only states that
 * the Host confirmed the write; the displayed value still comes from a fresh
 * {@link TeamModePort.read}.
 */
export type TeamModeWriteOutcome =
  | { readonly kind: 'committed' }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'cancelled'; readonly reason: string }
  | { readonly kind: 'indeterminate'; readonly reason: string }

/**
 * The single Team mode entry point. Callers pass the exact Session id they
 * captured from their own live scope; the adapter re-resolves that Session's
 * live Root on every call, so a recycled id or a moved surface can never write
 * another owner.
 */
export interface TeamModePort {
  /** The current projection snapshot for one exact Session. */
  read(sessionId: string): TeamModeSnapshot
  /**
   * Observe the current projection of one exact Session. The listener carries
   * no value: the caller re-reads. The returned disposer is idempotent and
   * must be called when the view closes or its Session stops being current.
   */
  subscribe(sessionId: string, listener: () => void): () => void
  /**
   * Write the Team selection of one exact Root Session. The write is
   * serialized by the caller's Session writer barrier; this port only forwards
   * the official Host operation and classifies its settlement.
   */
  setEnabled(sessionId: string, enabled: boolean, signal: AbortSignal): Promise<TeamModeWriteOutcome>
}
