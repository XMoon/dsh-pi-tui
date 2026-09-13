/**
 * The session WRITE domain port (D2.1 contract convergence): semantic
 * operations between the TUI and session writes. Every operation addresses a
 * session by id, never by a live Agent object. Direct resolves the id to its
 * live Agent; a later Remote adapter maps the same semantics to the official
 * DSH Client write contracts.
 *
 * The Direct implementation remains the production path. This port exposes
 * settlement vocabulary now so a future wire adapter never has to claim that
 * an ambiguous transport failure was committed.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/session-writer-port
 */

/** One prepared user message (the runner's image/admission pipeline produced
 * it; the port only delivers). */
export type PreparedMessage = unknown

/** The caller-resolved delivery policy for one ordinary prompt. */
export type SessionDeliveryMode = 'queue' | 'steer'

/** One official queue occurrence mutation. Content remains structural so the
 * semantic port does not expose a DSH package type. */
export type QueueAction =
  | { readonly kind: 'edit'; readonly content: readonly unknown[] }
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' }

import type { WriteError, WriteOutcome } from './write-outcome.ts'
export type { WriteError, WriteOutcome } from './write-outcome.ts'

/** The session WRITE domain port. */
export interface SessionWriter {
  /** Deliver one ordinary human prompt with the caller-resolved mode. */
  prompt(
    sessionId: string,
    message: PreparedMessage,
    mode: SessionDeliveryMode,
  ): Promise<WriteOutcome>

  /** Apply one official occurrence-level queue mutation. The adapter preserves
   * the occurrence's identity, placement, and provenance for `edit`; `steer`
   * uses the Host-owned message rather than replaying a copied payload. */
  updateQueue(
    sessionId: string,
    itemId: string,
    action: QueueAction,
  ): Promise<WriteOutcome>

  /** Cancel the current user turn while preserving pending inbox work. The
   * Direct Agent reason and keepInbox knobs are intentionally hidden here. */
  cancel(sessionId: string): Promise<WriteOutcome>

  /** Pin the session title and return the accepted normalized title. */
  rename(
    sessionId: string,
    title: string,
  ): Promise<WriteOutcome<{ readonly title: string }>>

  /** Regenerate the title where the backend supports that operation. */
  refreshTitle(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: 'ok'; readonly title: string | undefined }
    | { readonly kind: 'unsupported'; readonly reason: string }
  >
}
