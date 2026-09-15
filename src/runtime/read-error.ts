/**
 * A typed semantic READ failure: the read was superseded by a connection or
 * surface change, so its result must not be presented as the current Host
 * state. Remote adapters throw this instead of a generic Error so a consumer
 * can stay UI-silent (v2 §0.2.3/§0.3.1) rather than surfacing a stale failure.
 * Host-free; no I/O.
 * @module @xmoon76/dsh-pi-tui/read-error
 */

/** The read no longer owns the surface (generation change or superseded epoch). */
export class SupersededReadError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = 'SupersededReadError'
    this.reason = reason
  }
}
