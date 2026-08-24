/**
 * The session WRITE domain port (M1.4) — the semantic contract between the
 * TUI and session writes (follow-up delivery, steer, queue pull-back,
 * cancel, title rename/refresh), implemented by `src/runtime/direct/`
 * (Direct) today and by a Remote adapter in a later milestone. The port
 * wraps the RAW agent/session operations; the runner keeps the Direct-mode
 * orchestration (divergence guard, transition fence, operation barrier,
 * lease/cooling) around the port calls.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/session-writer-port
 */

import type { SteerAllOptions, SteerDeps, SteerOutcome } from '../steer.ts'

/** The minimal live-agent surface the writer needs (structural). */
export interface AgentLike {
  readonly session: { readonly id: string }
  /** Deliver one prepared user message (the ONLY prompt path). */
  followup(message: unknown): void
  /** The pending queue (pull-back removes by id, never a clear). */
  readonly inbox: { remove(id: string): void }
}

/** The minimal cancel surface (the interrupt helper's agent is narrower
 * than the full writer agent). */
export interface CancelAgentLike {
  cancel(reason: unknown, options: { keepInbox: boolean }): void
}

/** The minimal session surface the title ops need (structural). */
export interface SessionLike {
  readonly id: string
}

/** The session WRITE domain port. */
export interface SessionWriter {
  /** Deliver a prepared user message to the agent. */
  followup(agent: AgentLike, message: unknown): void
  /** Steer the queued messages + optional draft into the next step. The
   * Direct adapter runs the guard-orchestrated steerAll seam; a Remote
   * adapter implements the wire steer. */
  steer(deps: SteerDeps, text: string, options?: SteerAllOptions): Promise<SteerOutcome>
  /** Remove one queued message (pull-back). */
  dequeue(agent: AgentLike, messageId: string): void
  /** Cancel the agent's current run. */
  cancel(agent: CancelAgentLike, reason: unknown, options: { keepInbox: boolean }): void
  /** Pin the session title (explicit user rename). `false` = the title
   * service is unavailable. */
  rename(session: SessionLike, name: string): boolean
  /** Regenerate the title from the conversation. `unavailable` = the title
   * service is absent; `ok` with `title: undefined` = no conversation yet
   * (the title is left as-is). */
  refreshTitle(session: SessionLike, signal: AbortSignal): Promise<
    | { kind: 'unavailable' }
    | { kind: 'ok'; title: string | undefined }
  >
}
