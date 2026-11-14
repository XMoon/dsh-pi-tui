/**
 * The ONE cross-backend READ-ONLY Agent Team board semantic port (FR2).
 *
 * The durable Team task board is a Root-Session `agentTeam` projection owned by
 * the official Host. This port only ever READS it (a `snapshot` + a change
 * feed); it exposes NO create/update/claim/complete write. The FR1
 * `TeamModePort` is a different contract (Root-only Team MODE read + the single
 * `setEnabled` write) and must never be reused for this board: its availability
 * rule also requires a write namespace and the `modelSelection` history, which
 * would falsely mark a legal, readable Team board unavailable.
 *
 * `TeamBoardSnapshot` never collapses a failure into an empty board:
 * - `ready` is a real successful projection read (`enabled:false` is a
 *   legitimate ready board whose retained tasks are still shown);
 * - `stale` is a generation/binding change or an unreadable projection — the
 *   caller shows an explicit error page, never fabricated empty tasks;
 * - `unavailable` names the ONE concrete reason the board cannot be read.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/team-board-read-port
 */

/** One detached, read-only shared Team task. */
export interface TeamBoardTask {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: 'pending' | 'in_progress' | 'completed'
  readonly ownerId?: string
  readonly ownerName?: string
  readonly ready: boolean
  readonly blockedBy: readonly string[]
  readonly writeScopes: readonly string[]
  readonly writeScopeWarnings: readonly string[]
}

/** The currentness/unavailability outcome of one board read. */
export type TeamBoardSnapshot =
  | {
    readonly kind: 'ready'
    readonly enabled: boolean
    readonly tasks: readonly TeamBoardTask[]
    readonly failure?: string
  }
  | { readonly kind: 'stale'; readonly reason: string }
  | {
    readonly kind: 'unavailable'
    readonly cause: 'not-root' | 'session-missing' | 'authority-missing'
    readonly reason: string
  }

/**
 * The single Team board read entry point. Callers pass the exact captured Root
 * Session id; the adapter re-resolves the live identity on every call. The
 * listener carries no value: the caller re-reads. The returned disposer is
 * idempotent and MUST be released when the view closes or its Session stops
 * being current.
 */
export interface TeamBoardReadPort {
  read(sessionId: string): TeamBoardSnapshot
  subscribe(sessionId: string, listener: () => void): () => void
}
