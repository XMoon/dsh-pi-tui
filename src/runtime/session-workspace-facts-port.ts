/**
 * The UI-neutral read-authority port (M5-U-A): the ONE semantic seam that
 * answers, for an already-listed Session roster, what the Host really knows
 * about each Session's activity, pending interactions and Workspace
 * membership.
 *
 * This port is READ-ONLY by contract. It submits no answer, approval, cancel,
 * open, retain or create; it holds no Client workspace store, no question or
 * approval store and no cross-session answerability cache. `SessionReader`
 * remains the ONE listing authority: every read consumes exactly the main rows
 * the caller obtained from the roster, so this port can never enumerate an
 * alternative Session corpus.
 *
 * Two activity consumers exist and they are NOT interchangeable:
 *
 * - {@link SessionWorkspaceFactsPort.observeActivity} is the ONE per-open
 *   incremental observation the Session Browser runs. It schedules bounded
 *   per-id exact reads from the caller's roster, publishes provisional
 *   unknowns immediately and commits each measured row as it lands. It never
 *   blocks a roster publication on a whole-corpus sample.
 * - {@link SessionWorkspaceFactsPort.readActivity} keeps the EXACT precise
 *   sample semantics for the qualification probe and focused reads: one
 *   complete, fenced answer for an explicit row list.
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

/** How one per-open Workspace follow treats a lost physical carrier.
 *
 *  - `single-generation`: ONE Host/Connection generation only. A replaced
 *    generation or a lost carrier ends the observation; a caller that pairs
 *    this baseline with another read (the `-c` membership ∩ roster decision)
 *    must then refuse the pair. This is the historical one-shot contract.
 *  - `recovering`: the official Gateway retry lifecycle owns carrier
 *    replacement. A carrier loss invalidates the current membership
 *    immediately (see {@link WorkspaceInvalidatedFrame}) and a fresh baseline
 *    follows on the new physical generation, in the SAME open handle. It never
 *    retries the same generation and never opens a second logical stream while
 *    one is waiting. */
export type WorkspaceFollowMode = 'single-generation' | 'recovering'

/** Why the current Workspace generation stopped being current. */
export type WorkspaceInvalidatedReason = 'reconnecting' | 'replaced'

/** The membership of the current generation is no longer proven. The consumer
 *  drops membership proof but keeps its open handle and panel: the next
 *  `baseline`/`replace` frame restores it. */
export interface WorkspaceInvalidatedFrame {
  readonly type: 'invalidated'
  readonly reason: WorkspaceInvalidatedReason
}

/** One per-open Workspace follow frame (the official frame subset U-A forwards). */
export type WorkspaceFactsFrame =
  | { readonly type: 'baseline' | 'replace'; readonly items: readonly SessionWorkspaceFact[] }
  | { readonly type: 'upsert'; readonly workspace: SessionWorkspaceFact }
  | { readonly type: 'remove'; readonly workspaceId: string }
  | { readonly type: 'order'; readonly workspaceIds: readonly string[] }
  | WorkspaceInvalidatedFrame

/** One caller-owned per-open Workspace observation. */
export interface WorkspaceFactsHandle extends AsyncIterable<WorkspaceFactsFrame> {
  /**
   * Whether the observation's Host/Connection generation is STILL current.
   * A caller that pairs this baseline with another read (the `-c` Workspace
   * membership ∩ roster decision) must check this after the second read: a
   * superseded generation makes the baseline unusable, never an empty or
   * stale membership.
   */
  isCurrent(): boolean
  /** The official Connection generation of the handle's LAST physical attempt
   *  (the real `$stream` open). The owner uses it to distinguish a terminal
   *  failure on the generation actually attempted from a failure after a
   *  replacement already exists: only a defined live identity DIFFERENT from
   *  this one may open one new logical handle. Undefined when no real physical
   *  attempt could start (e.g. the opening was disconnected). */
  attemptedGeneration?(): unknown
  /** Release this open generation exactly once. Async SDK quiescence is
   *  initiated and observed inside the handle (never a bare floating promise). */
  dispose(): void
}

/** One observation snapshot, fenced by the roster revision it was measured on
 *  and its own monotone Activity revision.
 *
 *  `facts` carries at most one fact per authorized main Session, in the roster
 *  order of the matching `rosterRevision`. A row that has not been measured yet
 *  is present with unknown facts — never absent-and-therefore-idle, never a
 *  fabricated `none`. An empty `facts` list belongs to an empty roster only.
 *
 *  `revision` advances on EVERY published change (provisional roster commit,
 *  one measured row, an invalidation, an error) and is INDEPENDENT of
 *  `rosterRevision`: an Activity update never relabels itself as a new roster.
 *
 *  `error` is a whole-observation failure (the source generation is gone or the
 *  observation cannot produce facts at all). A single row's read failure lives
 *  in its own `attentionSourceState`; it is never promoted to this field. */
export interface ActivityObservationSnapshot {
  readonly rosterRevision: number
  readonly revision: number
  readonly facts: readonly SessionActivityFact[]
  readonly error?: string
}

/**
 * The ONE per-open incremental Activity observation.
 *
 * The handle owns its scheduling (bounded exact reads, priority lane and
 * background discovery) and its lifecycle. Its single caller-owned input is the
 * roster: `setRoster` commits identity/epoch changes BEFORE emitting any
 * callback, a removed id loses every fact and every queued/in-flight read
 * immediately, and an unrelated roster update never invalidates unrelated rows.
 */
export interface ActivityObservation {
  /** Commit one accepted roster revision. `rows` are the caller's main-Session
   *  rows in display order; `currentSessionId` only raises the current
   *  Session's read priority (it grants no fact). Identity/epoch changes are
   *  committed before listeners run. */
  setRoster(
    rows: readonly SessionSummary[],
    rosterRevision: number,
    currentSessionId: string | undefined,
  ): void
  /** The current root answer-eligibility ids: a scheduling hint ONLY. It never
   *  authorizes a Needs row and it never classifies a pending kind. */
  setPriorityIds(ids: ReadonlySet<string>): void
  getSnapshot(): ActivityObservationSnapshot
  /** Coalesced invalidation callback; the scheduling boundary is the owner's. */
  subscribe(listener: () => void): () => void
  /** Mark disposed before any callback, unsubscribe, abort requests and clear
   *  timers/queues exactly once. */
  dispose(): void
}

/** The UI-neutral read-authority port. */
export interface SessionWorkspaceFactsPort {
  /** Read the current facts of already-authorized main Session rows.
   *
   *  This is the EXACT precise sample: one complete fenced answer for an
   *  explicit row list. The Session Browser does NOT call it for its ordinary
   *  roster; it drives {@link observeActivity} instead.
   *
   *  - the caller supplies a `SessionReader.list()` main-row roster; this port
   *    never enumerates an alternative corpus and never queries an extra id;
   *  - a row whose read fails keeps an in-row Unknown/Denied, never a zero fact;
   *  - a superseded generation or an aborted read rejects the WHOLE sample
   *    (`SupersededReadError` / abort) instead of returning a stale one.
   */
  readActivity(rows: readonly SessionSummary[], signal?: AbortSignal): Promise<readonly SessionActivityFact[]>
  /** Open ONE per-open incremental Activity observation. The caller owns the
   *  returned handle and must dispose it; it performs no Host write, retains no
   *  Session and holds no cross-open answerability cache. */
  observeActivity(signal: AbortSignal): ActivityObservation
  /** Open ONE per-open Workspace observation. The caller owns the returned
   *  generation and must dispose it; the publisher only forwards the official
   *  baseline and increments. `mode` defaults to the historical
   *  `single-generation` contract. */
  followWorkspaces(signal?: AbortSignal, mode?: WorkspaceFollowMode): WorkspaceFactsHandle
  /** Observe official Connection generation changes, for the ONE legal reopen
   *  of a per-open Workspace handle whose `recovering` stream ended terminally:
   *  a NEW generation may establish ONE new logical handle; the same generation
   *  is never retried. Remote forwards its ONE existing generation
   *  subscription; a backend with no reconnecting transport (Direct) omits it
   *  and keeps its own registry-handle lifetime. This exposes no Host fact and
   *  never creates a second transport. */
  observeConnectionGeneration?(listener: () => void): () => void
  /** The LIVE Connection generation identity, for comparing a failed handle's
   *  adopted generation with the current one. Omitted by backends with no
   *  reconnecting transport (Direct). */
  connectionGeneration?(): unknown
}
