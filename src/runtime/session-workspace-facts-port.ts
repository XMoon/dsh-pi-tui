/**
 * The UI-neutral read-authority port (M5-U-A): the ONE semantic seam that
 * answers, for an already-listed Session roster, what the Host really knows
 * about each Session's activity, pending interactions and Workspace
 * membership.
 *
 * This port is READ-ONLY by contract. It submits no answer, approval, cancel,
 * open, retain or create; it holds no Client workspace store, no question or
 * approval store and no cross-session cache. `SessionReader` remains the ONE
 * listing authority: `readActivity` consumes exactly the main rows the caller
 * obtained from `SessionReader.list()`, so this port can never enumerate an
 * alternative Session corpus.
 *
 * Every fact is tri-state where the Host cannot prove a value: `undefined` is
 * "not proven", never "idle" or "none". `FactState` names the reason a fact is
 * not `known`, and a denied or failed read of one Session never becomes an
 * empty fact for it.
 *
 * Full contract: docs/architecture/host-client.md.
 * @module @xmoon76/dsh-pi-tui/runtime/session-workspace-facts-port
 */

import type { SessionSummary } from './session-reader-port.ts'

/** The official Host pending-forwarded-event kind (`SessionPendingInput`). */
export type SessionPendingKind = 'question' | 'approval' | 'other'

/** Why a fact is not `known`. Never a value: `unknown` ≠ `unavailable` ≠ `denied`. */
export type FactState = 'known' | 'unknown' | 'unavailable' | 'denied'

/** One Session's current activity facts, projected by the backend adapter. */
export interface SessionActivityFact {
  readonly sessionId: string
  /** The official Host fact; `undefined` is "not proven", never idle. */
  readonly running: boolean | undefined
  /** The Host's sampled Gateway pending kinds; `undefined` is an unreadable state. */
  readonly pendingKinds: readonly SessionPendingKind[] | undefined
  /** Timed `continued` Questions with no same-callId queued reply: the late-answer
   *  candidates. `undefined` is an unreadable projection, never "none". */
  readonly continuedQuestionCallIds: readonly string[] | undefined
  /** The ONE coarse attention classification for this sample. */
  readonly attention: 'question' | 'approval' | 'plan-review' | 'none' | 'unknown'
  /** The fact state of the pending/answerability read; `running` is independent. */
  readonly attentionSourceState: FactState
}

/** One authoritative Workspace projection (Host `workspaceId`/path/title/members). */
export interface SessionWorkspaceFact {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
}

/** One per-open Workspace follow frame (the official frame subset U-A forwards). */
export type WorkspaceFactsFrame =
  | { readonly type: 'baseline' | 'replace'; readonly items: readonly SessionWorkspaceFact[] }
  | { readonly type: 'upsert'; readonly workspace: SessionWorkspaceFact }
  | { readonly type: 'remove'; readonly workspaceId: string }
  | { readonly type: 'order'; readonly workspaceIds: readonly string[] }

/** One caller-owned per-open Workspace observation. */
export interface WorkspaceFactsHandle extends AsyncIterable<WorkspaceFactsFrame> {
  /** Release this open generation exactly once. */
  dispose(): void
}

/** The UI-neutral read-authority port. */
export interface SessionWorkspaceFactsPort {
  /** Read the current facts of already-authorized main Session rows.
   *
   *  - the caller supplies a `SessionReader.list()` main-row roster; this port
   *    never enumerates an alternative corpus and never queries an extra id;
   *  - a row whose read fails keeps an in-row Unknown/Denied, never a zero fact;
   *  - a superseded generation or an aborted read rejects the WHOLE sample
   *    (`SupersededReadError` / abort) instead of returning a stale one.
   */
  readActivity(rows: readonly SessionSummary[], signal?: AbortSignal): Promise<readonly SessionActivityFact[]>
  /** Open ONE per-open Workspace observation. The caller owns the returned
   *  generation and must dispose it; the publisher only forwards the official
   *  baseline and increments. */
  followWorkspaces(signal?: AbortSignal): WorkspaceFactsHandle
}
