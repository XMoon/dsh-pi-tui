/**
 * The pending-input read projection (D2.1): a transport-neutral snapshot of
 * Host-owned pending user input. Consumers use stable occurrence identities and
 * semantic placement; Direct inbox collection names never leave the adapter.
 *
 * The snapshot is synchronous because it reads an already-materialized local
 * projection. A future Remote adapter must keep the same shape in its
 * subscribed SessionSnapshot cache rather than performing RPC from this
 * method.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/pending-input-reader-port
 */

/** The official queue placement vocabulary. */
export type PendingInputPlacement = 'queued' | 'steering' | 'context'

/** One immutable pending-input occurrence. `content` remains structural so
 * the semantic port does not expose a DSH package type. */
export interface PendingInputItem {
  readonly id: string
  readonly placement: PendingInputPlacement
  readonly content: readonly unknown[]
  /** The plain correlation identity of a user-origin occurrence (the official
   * prompt `requestId` / Host message `source.rpcId`). Only a correlation
   * string crosses the port — never the raw `source` object. Absent for an
   * occurrence with no user request identity. */
  readonly rpcId?: string
}

/** One coherent read of pending input and session activity. */
export interface PendingInputSnapshot {
  readonly running: boolean
  readonly items: readonly PendingInputItem[]
}

/** The semantic read seam for Host-owned pending input. */
export interface PendingInputReader {
  /**
   * Return the current local projection for an already-live session.
   *
   * `undefined` means that session is not available to this backend — never an
   * authoritative empty queue. The read is synchronous and total for every
   * shape the backend's own contract can produce; a backend that reads a
   * wire-shaped projection fails loudly when a PRESENT value violates its
   * published shape, because a shape violation is a contract bug and reporting
   * it as "no pending input" would hide durable input the Host may still run.
   */
  snapshot(sessionId: string): PendingInputSnapshot | undefined
}
