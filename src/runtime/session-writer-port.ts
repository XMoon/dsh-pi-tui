/**
 * The session WRITE domain port (M1.4, contract-reviewed round 2) — the
 * semantic contract between the TUI and session writes (follow-up
 * delivery, queue pull-back, cancel, title rename/refresh). The contract
 * is IDENTITY-BASED: every operation addresses a session by id, never by
 * a live agent object. A Direct adapter resolves the agent internally; a
 * Remote adapter maps the session id to the official DSH API.
 *
 * Steer is deliberately NOT part of the port: Ctrl+S steer is Direct-mode
 * orchestration (divergence guard, transition fence, operation barrier —
 * the whole steerAll seam in src/steer.ts). A Remote backend steers
 * through its own wire capability; the runner keeps the Direct
 * orchestration on the direct path.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/session-writer-port
 */

/** One prepared user message (the runner's image/admission pipeline
 * produced it; the port only delivers). */
export type PreparedMessage = unknown

/** The session WRITE domain port. Addresses sessions by id only. */
export interface SessionWriter {
  /** Deliver a prepared user message to the session's agent. */
  followup(sessionId: string, message: PreparedMessage): void
  /** Steer the queued messages + draft into the session's next step (the
   * FINAL delivery of a steer — the Direct guard/fence/barrier
   * orchestration lives in the runner's steerAll, which calls this for
   * the actual delivery). */
  steer(sessionId: string, messages: readonly PreparedMessage[]): void
  /** Remove one queued message (pull-back; by id, never a clear). */
  dequeue(sessionId: string, messageId: string): void
  /** Cancel the session's current run. `reason` is opaque (the runner's
   * `{ kind: 'user' }` in Direct mode); `keepInbox` preserves the queue. */
  cancel(sessionId: string, reason: unknown, options: { keepInbox: boolean }): void
  /** Pin the session title (explicit user rename). `false` = the title
   * service is unavailable. */
  rename(sessionId: string, name: string): boolean
  /** Regenerate the title from the conversation. `unavailable` = the title
   * service is absent; `ok` with `title: undefined` = no conversation yet
   * (the title is left as-is). */
  refreshTitle(sessionId: string, signal: AbortSignal): Promise<
    | { kind: 'unavailable' }
    | { kind: 'ok'; title: string | undefined }
  >
}