/**
 * The Client-local `piTuiPromptPresence` owner (M6 PR-C C3).
 *
 * A Split Client's display preset and its currently viewed Session are
 * CLIENT-LOCAL facts — the Host must never read a Client's terminal or its
 * local preference file. This owner is the ONE place a Client declares those
 * facts to the Host, so the Host's per-Turn Focus decision can be sampled from
 * authenticated presence instead of guessed.
 *
 * What it owns:
 *
 * ```text
 * a monotonic Client revision (never reset within one owner lifetime)
 * the last COMMITTED view (applied ACK only; a lost/stale ACK is unconfirmed)
 * one serialized, coalesced sync chain, so two rapid local changes cannot
 * reorder, and a superseded desired view is never replayed
 * ```
 *
 * Semantics:
 *
 * - The local desired view is COALESCED: when the chain finishes a call it
 *   sends the LATEST desired view and drops the intermediate ones. Presence is
 *   a projection of the current fact, never a replay log. A stale late ACK
 *   never marks the current revision accepted (the ACK's revision must match
 *   the dispatch that produced it), and an ACK carried by a SUPERSEDED
 *   transport generation/binding is `unconfirmed` — the record lives on the
 *   connection it was acknowledged on. An unconfirmed outcome retires the
 *   local commitment.
 * - The committed view is only what the Host acknowledged. A refused call
 *   leaves the DESIRED view intact for the next attempt but never claims it
 *   committed.
 * - `ackCurrentView()` is the submission prerequisite: it dispatches the
 *   CURRENT local view and confirms only when the committed view IS the
 *   current local view — a display change or navigation during the await
 *   re-syncs (bounded) before the Client submits its own new Turn. Every
 *   submission re-projects presence onto the CURRENT connection, so a silent
 *   transport reconnect self-heals. Staleness of the submission's own scope
 *   stays the ordinary fence's business. Nothing is ever replayed.
 * - The resolved Session id is always the exact durable id the Client actually
 *   shows, or `null`. An empty string is never sent: the two are distinct wire
 *   facts.
 * - A withdraw (`null` view) is what a closed surface sends. On teardown the
 *   withdraw is BEST-EFFORT: the authoritative removal is the old Peer's
 *   `peer.signal` abort on the Host.
 *
 * The capability is the ONE narrow structural Remote seam
 * (`RemoteApplicationOverride.promptPresence`); this owner never touches the
 * transport, the Client Context or a Host service directly.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/prompt-presence-client
 */

import type { DisplayPreset } from '../../domain/display/preset.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { runDetached } from '../../runtime/process/tasks.ts'
import type {
  RemotePromptPresenceAck,
  RemotePromptPresenceCapability,
} from '../application-runtime.ts'

/** The closed refusal vocabulary the wire ACK carries (structural mirror). */
export type PromptPresenceRefusal = Extract<
  RemotePromptPresenceAck,
  { readonly kind: 'refused' }
>['reason']

/** The committed/unconfirmed outcome of one Client-side sync attempt. */
export type PromptPresenceSyncOutcome =
  /** The Host committed the exact latest view at this revision. */
  | { readonly kind: 'applied'; readonly revision: number }
  /** The Host refused BEFORE committing (a definite pre-commit answer). */
  | { readonly kind: 'refused'; readonly reason: PromptPresenceRefusal }
  /**
   * The call was dispatched and its authoritative answer never arrived or was
   * invalidated (a lost ACK, cancellation, transport failure or a superseded
   * transport generation/binding). The Host may or may not have committed the
   * view: this Client must NOT claim it did.
   */
  | { readonly kind: 'unconfirmed' }

/** What the Client currently shows, observed at call time. */
export interface PromptPresenceLocalView {
  /** The exact Session the surface shows, or `null` when it shows none. */
  readonly viewedSessionId: string | null
  /** The live display preset (Client-local authority). */
  readonly displayPreset: DisplayPreset
}

/** The submission-gate answer of one `ackCurrentView` prerequisite. */
export type PromptPresenceAckOutcome =
  /** The current view's revision is Host-ACKed on this connection. */
  | { readonly kind: 'confirmed' }
  /** The Host refused the presence: the submission must not be sent. */
  | { readonly kind: 'refused' }
  /** No ACK evidence: the submission must not be sent (unknown outcome). */
  | { readonly kind: 'unconfirmed' }

/**
 * The transport identity probe (the existing `sessionFacts` capture/compare
 * pair): an ACK carried by a superseded Connection generation or a replaced
 * binding must never confirm presence.
 */
export interface PromptPresenceTransportProbe {
  /** The transport identity of the CURRENT connection for one Session. */
  capture(sessionId: string): unknown
  /** Whether the captured identity is still the current one. */
  isCurrent(sessionId: string, token: unknown): boolean
}

export interface PromptPresenceClientOptions {
  /** The mounted private presence capability (never undefined here). */
  readonly capability: RemotePromptPresenceCapability
  /** The CURRENT local view, read at each sync (never captured once). */
  readonly localView: () => PromptPresenceLocalView
  /** The owner lifetime (the runner lifecycle). */
  readonly signal: AbortSignal
  /** The transport identity probe (absent = no generation fencing). */
  readonly transport?: PromptPresenceTransportProbe
  /** The runner diagnostics channel (the owned-task sink). */
  readonly diag: Diag
}

/** One latest-wins presence owner over the private wire capability. */
export interface PromptPresenceClient {
  /** The last Host-committed view, or `undefined` before any applied ACK. */
  committed(): (PromptPresenceLocalView & { readonly revision: number }) | undefined
  /** The highest revision this owner has ever dispatched. */
  revision(): number
  /**
   * Declare the CURRENT local view to the Host. Coalesced: concurrent calls
   * share one chain and the last desired view always wins.
   */
  sync(): Promise<PromptPresenceSyncOutcome>
  /** Withdraw this Client's presence (a closed surface carries no view). */
  withdraw(): Promise<PromptPresenceSyncOutcome>
  /**
   * The submission prerequisite: dispatch the CURRENT view and await the
   * authoritative ACK for the exact currently committed Session before this
   * Client submits its own new Turn. A local change during the await re-syncs
   * (bounded); nothing is ever replayed automatically.
   */
  ackCurrentView(): Promise<PromptPresenceAckOutcome>
  /**
   * Re-project the CURRENT view after a synchronous local change (a
   * navigation commit or a display mutation). Owned fire-and-forget: the
   * dispatch never throws, and any unconfirmed outcome is re-projected at the
   * next `ackCurrentView` gate.
   */
  resample(): void
  /** Whether a sync is currently in flight (the reload/exit gate reads it). */
  inFlight(): boolean
  /** Dispose: stop the chain and never dispatch again. */
  dispose(): void
}

/** The bounded settle of one `ackCurrentView` (a rapidly-changing view is
 *  reported unconfirmed instead of spinning). */
const ACK_SETTLE_ROUNDS = 3

/**
 * Build the Client-local presence owner over the mounted capability.
 */
export function createPromptPresenceClient(options: PromptPresenceClientOptions): PromptPresenceClient {
  const { capability, localView, signal, transport, diag } = options
  const lifetime = new AbortController()
  let nextRevision = 1
  let committed: (PromptPresenceLocalView & { revision: number }) | undefined
  /** The coalesced desired view; `undefined` = nothing pending. */
  let desired: PromptPresenceLocalView | undefined
  /** One chain step awaiting its start; concurrent enqueues coalesce into it. */
  let queued = false
  let chain: Promise<unknown> = Promise.resolve()
  let queuedAttempt: Promise<PromptPresenceSyncOutcome> | undefined
  let disposed = false
  let active = 0

  /** The transport identity of one view's connection (absent when sessionless). */
  const tokenFor = (view: PromptPresenceLocalView): { sessionId: string; token: unknown } | undefined => {
    if (transport === undefined || view.viewedSessionId === null) return undefined
    return { sessionId: view.viewedSessionId, token: transport.capture(view.viewedSessionId) }
  }

  /** Make ONE dispatch for one exact view (never throws). */
  const dispatch = async (view: PromptPresenceLocalView): Promise<PromptPresenceSyncOutcome> => {
    const revision = nextRevision
    nextRevision += 1
    active += 1
    const captured = tokenFor(view)
    try {
      let answer: Awaited<ReturnType<RemotePromptPresenceCapability['syncView']>>
      try {
        answer = await capability.syncView(view.viewedSessionId, view.displayPreset, revision, lifetime.signal)
      } catch {
        // A transport failure, cancellation or thrown boundary validation:
        // no ACK evidence exists, so the outcome is the truthful UNKNOWN.
        committed = undefined
        return { kind: 'unconfirmed' }
      }
      if (answer.ok === false) {
        committed = undefined
        return { kind: 'unconfirmed' }
      }
      const value = answer.value
      if (value.kind === 'refused') return { kind: 'refused', reason: value.reason }
      // The ACK carries the Host's committed revision; it must be the one this
      // call sent, otherwise the wire answered about another call (a stale late
      // ACK must never mark the current revision accepted).
      if (value.revision !== revision) {
        committed = undefined
        return { kind: 'unconfirmed' }
      }
      // The record lives on the connection that acknowledged it: an ACK carried
      // by a superseded Connection generation or a replaced binding is UNKNOWN.
      if (captured !== undefined && transport !== undefined && !transport.isCurrent(captured.sessionId, captured.token)) {
        committed = undefined
        return { kind: 'unconfirmed' }
      }
      committed = { viewedSessionId: view.viewedSessionId, displayPreset: view.displayPreset, revision }
      return { kind: 'applied', revision }
    } finally {
      active -= 1
    }
  }

  /**
   * The coalescing chain: dispatch the LATEST desired view and drop the
   * intermediate ones. A waiter's promise resolves with the outcome of the
   * dispatch that carried its own or a SUPERSEDING view — never a stale one.
   * New enqueues during a dispatch chain ONE serialized step after it, so two
   * local changes can never reorder on the wire.
   */
  const enqueue = (view: PromptPresenceLocalView): Promise<PromptPresenceSyncOutcome> => {
    desired = view
    if (queued && queuedAttempt !== undefined) return queuedAttempt
    queued = true
    const attempt = chain.then(() => {
      queued = false
      const next = desired
      desired = undefined
      if (next === undefined || disposed || lifetime.signal.aborted) return { kind: 'unconfirmed' } as const
      return dispatch(next)
    })
    chain = attempt.then(() => undefined, () => undefined)
    queuedAttempt = attempt
    return attempt
  }

  /** Stop the chain and never dispatch again (idempotent). */
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    desired = undefined
    lifetime.abort()
    signal.removeEventListener('abort', retire)
  }

  /** The teardown sequence: best-effort withdraw, then the local retirement. */
  function retire(): void {
    runDetached('prompt presence withdraw', async () => {
      try {
        await enqueue({ viewedSessionId: null, displayPreset: localView().displayPreset })
      } finally {
        dispose()
      }
    }, { diag })
  }
  if (signal.aborted) retire()
  else signal.addEventListener('abort', retire, { once: true })

  return {
    committed: () => committed,
    revision: () => nextRevision - 1,
    sync: () => enqueue(localView()),
    withdraw: () => enqueue({ viewedSessionId: null, displayPreset: localView().displayPreset }),
    ackCurrentView: async (): Promise<PromptPresenceAckOutcome> => {
      for (let round = 0; round < ACK_SETTLE_ROUNDS; round += 1) {
        const outcome = await enqueue(localView())
        if (outcome.kind === 'refused') return { kind: 'refused' }
        if (outcome.kind === 'unconfirmed') return { kind: 'unconfirmed' }
        // Applied: confirm only when the committed view IS the current local
        // view — a display change or navigation during the await re-syncs
        // before this Client submits its own new Turn.
        const now = localView()
        if (committed !== undefined
          && committed.viewedSessionId === now.viewedSessionId
          && committed.displayPreset === now.displayPreset) {
          return { kind: 'confirmed' }
        }
      }
      return { kind: 'unconfirmed' }
    },
    resample: () => {
      runDetached('prompt presence resample', () => enqueue(localView()).then(() => undefined), { diag })
    },
    inFlight: () => active > 0,
    dispose,
  }
}
