/**
 * M3-4 PR2 Remote live ingress: the ONE eventSource subscription that feeds
 * the existing session-presentation pipeline for the currently retained
 * Remote main Session — durable appends routed through the surface event
 * routing, transient `assistant/live-chunk` entries mapped onto the neutral
 * `AssistantLiveInput` plane, and whole-window replacements (reconnect /
 * gap repair) triggering the authoritative re-hydrate.
 *
 * Identity is the EXACT binding object plus the Connection generation —
 * never a sessionId alone, never an Agent object (plan §6.2/§7.6):
 *
 * ```text
 * durable and transient remain separate inputs;
 * a replaced same-id BINDING retires the handle: a stale publication from it
 *   never repaints the new owner's Session;
 * a Connection GENERATION rollover does NOT retire the handle — the retained
 *   binding is unchanged, so the handle ADOPTS the new generation;
 * delivery is a SEQUENCE contract, not a latest-change contract: the official
 *   window is the current complete contiguous window and `change` is only the
 *   LAST synchronous delta, so any generation rollover, revision
 *   discontinuity, `replace`, `prepend`, missing change or hydrate gap makes
 *   the incremental sequence untrustworthy. The handle then enters RECOVERING:
 *   it stops delivering partial increments (they would fold an incomplete
 *   transcript while the footer advanced) and asks the fold OWNER — main
 *   `session-presentation`, child `viewer-runtime` — to re-fold the current
 *   official window; the owner acknowledges the committed revision and only
 *   then does incremental delivery resume. Detaching on a rollover instead
 *   would leave the surface dead.
 * ```
 *
 * The ingress owns NO presentation state and never folds a transcript itself:
 * every accepted input is handed to the injected sinks (the bootstrap maps
 * them onto the existing surface routing + presentation owner), so the
 * canonical pipeline stays the ONE join. The recovery cursor
 * (`incremental|recovering` + last delivered revision + the exact
 * generation/binding evidence) is delivery bookkeeping, never a second
 * transcript or durable-event log authority.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/live-ingress
 */

import type { AssistantLiveChunk, AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import type {
  PresentationDurableEvent,
  PresentationWindowRefoldProof,
} from '../../runtime/presentation-read-port.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from '../../runtime/remote/session-reader-remote.ts'
import type { RemotePresentationEventEntry } from '../../runtime/remote/presentation-read-remote.ts'

/** One started attempt tuple marker for start-input synthesis. */

/** The structural official faces the ingress borrows (never retains). */
export interface RemoteLiveIngressBinding {
  readonly session: {
    getSnapshot(): { readonly openState: 'cold' | 'loading' | 'open' | 'error' }
    subscribe(listener: () => void): () => void
    /** The official push-model projection value store. The outward feature
     *  contract exposes PER-KEY faces only (no any-key channel), so the live
     *  subscription names the keys it follows. */
    readonly projections: {
      faceOf(key: string): { subscribe(listener: () => void): () => void }
    }
  }
  readonly eventSource: {
    getSnapshot(): { readonly entries: readonly RemotePresentationEventEntry[]; readonly revision: number }
    subscribe(listener: () => void): () => void
  }
}

/** Structural `ISessions` borrow face for the ingress. */
export interface RemoteLiveIngressSessions {
  binding(id: string): RemoteLiveIngressBinding | undefined
}

/** The neutral sinks the bootstrap injects (its own routing/presentation). */
export interface RemoteLiveIngressSinks {
  /** Route one durable event for the subscribed session (the existing
   *  surface event routing; the ingress does not fold it itself). */
  readonly onDurableEvent: (sessionId: string, event: PresentationDurableEvent) => void
  /** Apply one transient assistant input (start/chunk synthesized per
   *  attempt tuple, exactly the read-side partition semantics). */
  readonly onLiveInput: (input: AssistantLiveInput) => void
  /** The incremental sequence is no longer trustworthy (generation rollover,
   *  revision discontinuity, window replace/prepend, missing change, hydrate
   *  gap): the fold OWNER must re-fold the CURRENT official window and then
   *  acknowledge the committed revision through
   *  {@link RemoteLiveIngressHandle.acknowledgeWindowRefold}. This sink carries
   *  INTENT only — it must not synchronously start the async re-fold, because
   *  it can fire while the caller's `handle = subscribe(...)` assignment is
   *  still completing. Every later revision, and the Session's loading→open
   *  transition, re-fires it until the recovery is acknowledged. */
  readonly onWindowRefoldRequired: (sessionId: string) => void
  /** The Session snapshot changed (pendingSubmissions/running/etc. — the
   *  uSES channel): the pending-input presentation re-joins from the
   *  official sources. */
  readonly onSessionSnapshotChanged: (sessionId: string) => void
  /** The official PROJECTION store changed (the push channel that carries
   *  finished whole values: title/goal/todos/model/preset/usage/context...).
   *  The Session snapshot never carries projection values, so this is the ONE
   *  live channel through which a current-value change made by the Host or by
   *  another Client reaches this surface. */
  readonly onProjectionsChanged: (sessionId: string) => void
}

/** The installed ingress subscription handle. */
export interface RemoteLiveIngressHandle {
  /** Detach the subscription (idempotent). */
  dispose(): void
  /**
   * Acknowledge one COMMITTED window re-fold. Returns `true` — and only then
   * resumes incremental delivery — when this handle is still alive, still
   * bound to the EXACT binding object, the official Connection generation is
   * the same object the fold was fenced under, the official current window
   * revision still equals the committed revision, and the Session is open.
   * Session-id equality, a `revision >=` comparison, a surviving footer value
   * or the latest `change.kind` are NOT substitutes. A `false` return leaves
   * the handle recovering; the next official revision / open transition wakes
   * the owner again (never a busy loop).
   */
  acknowledgeWindowRefold(proof: PresentationWindowRefoldProof): boolean
}

/** The lazily-created ingress subscription factory the bootstrap consumes. */
export interface RemoteLiveIngress {
  /**
   * Subscribe the CURRENT retained binding of `sessionId`. Returns undefined
   * when no binding is retained (or the Connection generation is absent) —
   * the caller's next owner commit re-subscribes. Each call installs ONE
   * subscription; the caller disposes it on owner rollover (the bootstrap's
   * generation seam).
   *
   * `hydrateRevision` is the reader-snapshot revision the caller's cold
   * hydration committed. Events published between that snapshot and this
   * subscription are NOT observable as incremental changes; when the
   * subscription-time revision is higher, the gap is surfaced through
   * `onWindowRefoldRequired` (the authoritative window re-fold) instead of being
   * silently skipped — no lost-event window exists by construction.
   */
  subscribe(
    sessionId: string,
    sinks: RemoteLiveIngressSinks,
    hydrateRevision?: number,
  ): RemoteLiveIngressHandle | undefined
}

/**
 * Create the ingress factory. The factory holds no subscription state until
 * `subscribe` runs; each handle owns exactly one eventSource subscription plus
 * the current-fact projection faces, and detaches on an exact BINDING
 * replacement or an explicit dispose — never on a Connection generation
 * rollover, which it adopts (see the module contract above).
 */
export function createRemoteLiveIngress(
  sessions: RemoteLiveIngressSessions,
  generation: RemoteConnectionGenerationSource,
  /** The current-fact projection keys this ingress follows (the official
   *  feature contract has per-key faces only). */
  projectionKeys: readonly string[] = [],
): RemoteLiveIngress {
  return {
    subscribe(sessionId, sinks, hydrateRevision) {
      const capturedGeneration = generation.getSnapshot()
      if (capturedGeneration === undefined) return undefined
      const binding = sessions.binding(sessionId)
      if (binding === undefined) return undefined

      /** The transient tuples whose `start` input is ALREADY reflected in the
       *  presentation (the read-side partition rule: ONE start per
       *  attemptId+turn+step, then chunks). Seeded from the CURRENT window's
       *  transient baseline (the cold hydrate synthesized those starts), so a
       *  chunk arriving for an ALREADY-STARTED attempt never re-starts it
       *  (a re-start would reset its live blocks and drop painted transient
       *  output). Retired on settle-assistant (the attempt is durable now)
       *  and re-seeded on a window replace. */
      const startedTuples = new Set<string>()
      const seedTuplesFromWindow = (entries: readonly RemotePresentationEventEntry[]): void => {
        for (const entry of entries) {
          if (entry.type !== 'transient') continue
          startedTuples.add(`${entry.event.data.attemptId}:${entry.event.data.turn}:${entry.event.data.step}`)
        }
      }
      seedTuplesFromWindow(binding.eventSource.getSnapshot().entries)
      /** Transient chunks retained for a late subscriber baseline — NOT a
       *  second tracker: this mirrors the read-side `liveInputs` partition
       *  so a `replace` change can replay the new window's baseline through
       *  the SAME sinks. */
      let disposed = false
      let unsubscribe: (() => void) | undefined
      let unsubscribeGeneration: (() => void) | undefined
      const subscriptionRevision = binding.eventSource.getSnapshot().revision
      /** The revision of the last increment DELIVERED to the fold — or the
       *  revision one acknowledged recovery committed. Delivery bookkeeping
       *  only: never a business state or a second durable log. */
      let lastDeliveredRevision = subscriptionRevision
      /** `recovering` = the incremental sequence is untrustworthy; the owner
       *  must re-fold the official window and acknowledge the revision. */
      let mode: 'incremental' | 'recovering' = 'incremental'
      /** The (revision, open) pair the last wakeup was issued for: a later
       *  revision, or the Session's loading→open transition, re-arms it. */
      let notified: { readonly revision: number; readonly open: boolean } | undefined
      let notifyQueued = false
      // The hydrate→subscribe gap: events that landed after the caller's cold
      // snapshot but before this subscription will never arrive as changes.
      // The honest recovery is the authoritative window re-fold (the same path
      // a reconnect takes), delivered AFTER the subscription is armed so no
      // subsequent event can be lost either.
      const missedHydrationEvents = hydrateRevision !== undefined && subscriptionRevision > hydrateRevision

      /** The exact retained binding is the ONLY retirement condition: a
       *  same-id rollover replaces the binding object, so its subscription
       *  must detach. */
      const isBindingReplaced = (): boolean =>
        disposed || sessions.binding(sessionId) !== binding

      /** The current Connection generation evidence this handle delivers
       *  under. A generation ROLLOVER (reconnect, network loss) does NOT
       *  retire the retained binding — it invalidates the OLD generation's
       *  window proof, so the handle enters recovery instead of trusting the
       *  new generation's first change (its numbering starts over and its
       *  window may be a whole replacement delivered as an `append` delta). */
      let fencedGeneration: RemoteConnectionGeneration | undefined = capturedGeneration

      /** Ask the fold OWNER to reconcile the CURRENT official window. Intent
       *  only, coalesced, and deferred by exactly one microtask so the
       *  caller's `handle = subscribe(...)` assignment always completes before
       *  the owner can start an async re-fold (reentrancy); a later revision or
       *  the loading→open transition re-arms the wakeup until the recovery is
       *  acknowledged. This is not a retry loop: every wakeup is driven by a
       *  real official change. */
      const requireRefold = (): void => {
        if (disposed) return
        if (isBindingReplaced()) { dispose(); return }
        mode = 'recovering'
        const window = binding.eventSource.getSnapshot()
        const open = binding.session.getSnapshot().openState === 'open'
        if (notified !== undefined && notified.revision === window.revision && notified.open === open) return
        notified = { revision: window.revision, open }
        if (notifyQueued) return
        notifyQueued = true
        queueMicrotask(() => {
          notifyQueued = false
          if (disposed || mode !== 'recovering') return
          if (isBindingReplaced()) { dispose(); return }
          sinks.onWindowRefoldRequired(sessionId)
        })
      }

      /** Observe the official Connection generation. A rollover always enters
       *  recovery: the delivered sequence belongs to the dead generation. */
      const observeGeneration = (): void => {
        if (disposed) return
        const next = generation.getSnapshot()
        if (Object.is(fencedGeneration, next)) return
        fencedGeneration = next
        requireRefold()
      }

      /** Acknowledge one committed re-fold (see the interface contract). The
       *  proof is re-validated against the LIVE official state here. */
      const acknowledgeWindowRefold = (proof: PresentationWindowRefoldProof): boolean => {
        if (disposed) return false
        if (!Object.is(proof.binding, binding)) return false
        if (!Object.is(proof.generation, generation.getSnapshot())) return false
        const window = binding.eventSource.getSnapshot()
        if (window.revision !== proof.revision) return false
        if (binding.session.getSnapshot().openState !== 'open') return false
        // The committed fold IS the official window as of `proof.revision`:
        // resume from there, re-seeding the transient tuple memory from the
        // window the owner just folded, so an already-started attempt never
        // re-synthesizes a start (and every attempt of the old generation is
        // gone with the old tuple memory).
        startedTuples.clear()
        seedTuplesFromWindow(window.entries)
        lastDeliveredRevision = proof.revision
        mode = 'incremental'
        notified = undefined
        return true
      }

      /** Partition the CHANGE entries into durable events + live inputs
       *  (same tuple/start rule as the reader). */
      const partitionChange = (
        entries: readonly RemotePresentationEventEntry[],
      ): { durable: PresentationDurableEvent[]; live: AssistantLiveInput[] } => {
        const durable: PresentationDurableEvent[] = []
        const live: AssistantLiveInput[] = []
        for (const entry of entries) {
          if (entry.type === 'event') {
            durable.push(entry.event as PresentationDurableEvent)
            continue
          }
          const { attemptId, turn, step, chunk } = entry.event.data
          const key = `${attemptId}:${turn}:${step}`
          if (!startedTuples.has(key)) {
            startedTuples.add(key)
            live.push({ kind: 'start', sessionId, attemptId, turn, step })
          }
          live.push({
            kind: 'chunk',
            sessionId,
            attemptId,
            turn,
            step,
            time: entry.event.time,
            chunk: chunk as AssistantLiveChunk,
          })
        }
        return { durable, live }
      }

      const publish = (): void => {
        if (isBindingReplaced()) {
          // A same-id binding rollover no longer owns this subscription:
          // detach silently (the new owner's own subscription or re-fold owns
          // the surface from here).
          dispose()
          return
        }
        // A generation rollover is a recovery trigger even when it arrives
        // without an eventSource publication (the generation channel notifies
        // synchronously).
        observeGeneration()
        if (mode === 'recovering') {
          // Nothing incremental may reach the fold while recovering; a newer
          // official revision (or the loading→open transition) re-arms the
          // owner's wakeup.
          requireRefold()
          return
        }
        const window = binding.eventSource.getSnapshot()
        if (window.revision === lastDeliveredRevision) return
        // The eventSource exposes the WHOLE current window + its latest
        // `change`; the change is the LAST synchronous delta only. It is a
        // valid increment ONLY when it is contiguous with what the fold
        // already holds.
        const change = (window as { readonly change?: RemoteWindowChange }).change
        if (change === undefined || change.kind === 'replace' || change.kind === 'prepend') {
          requireRefold()
          return
        }
        if (window.revision !== lastDeliveredRevision + 1) {
          // A skipped revision: the intervening deltas are unobservable, so
          // the latest change cannot rebuild the fold.
          requireRefold()
          return
        }
        switch (change.kind) {
          case 'append': {
            const { durable, live } = partitionChange(change.entries)
            for (const input of live) sinks.onLiveInput(input)
            for (const event of durable) sinks.onDurableEvent(sessionId, event)
            lastDeliveredRevision = window.revision
            return
          }
          case 'settle-assistant': {
            // A durable assistant settlement atomically superseded one
            // attempt's transient rows. The settlement itself arrives as a
            // durable event through the normal append path; the transient
            // rows are already superseded in the window. Nothing to route
            // beyond the durable entry, when the change carries one.
            if (change.entry !== undefined) {
              sinks.onDurableEvent(sessionId, change.entry.event as PresentationDurableEvent)
            }
            // Retire the settled attempt's tuple keys (set hygiene: the set
            // must not grow for the subscription lifetime).
            for (const key of startedTuples) {
              if (key.startsWith(`${change.attemptId}:`)) startedTuples.delete(key)
            }
            lastDeliveredRevision = window.revision
            return
          }
        }
      }

      const dispose = (): void => {
        if (disposed) return
        disposed = true
        unsubscribe?.()
        unsubscribe = undefined
        unsubscribeGeneration?.()
        unsubscribeGeneration = undefined
        unsubscribeSnapshot()
        unsubscribeProjections()
      }

      // The Session snapshot channel: pendingSubmissions/running changes
      // (e.g. an official beginSubmission echo) re-join the pending pane.
      let lastSnapshotChange = 0
      const onSnapshot = (): void => {
        if (isBindingReplaced()) {
          dispose()
          return
        }
        lastSnapshotChange += 1
        sinks.onSessionSnapshotChanged(sessionId)
        // The official Session snapshot also carries the open state: a
        // loading→open transition is a REAL wakeup for an unsettled recovery
        // (the window may only become foldable now) — never a timer.
        if (mode === 'recovering') requireRefold()
      }
      const unsubscribeSnapshot = binding.session.subscribe(onSnapshot)

      // The official projection faces: the ONLY channel for projection-owned
      // current values (the Session snapshot never carries them). A change made
      // by the Host or another Client must reach the status/welcome/presentation
      // without waiting for an unrelated refresh. One Host frame can update
      // several keys, so the sink is coalesced into one microtask.
      let projectionRefreshQueued = false
      const onProjections = (): void => {
        if (isBindingReplaced()) {
          dispose()
          return
        }
        if (projectionRefreshQueued) return
        projectionRefreshQueued = true
        queueMicrotask(() => {
          projectionRefreshQueued = false
          if (disposed || isBindingReplaced()) return
          sinks.onProjectionsChanged(sessionId)
        })
      }
      const unsubscribeProjections = ((): (() => void) => {
        const offs = projectionKeys.map(key => binding.session.projections.faceOf(key).subscribe(onProjections))
        return () => { for (const off of offs) off() }
      })()

      unsubscribe = binding.eventSource.subscribe(publish)
      // The official generation channel: a rollover must enter recovery even
      // when it arrives without an eventSource publication.
      unsubscribeGeneration = generation.subscribe(observeGeneration)
      // Lost-wakeup fence: publication may have happened between the
      // subscription and this return; run one synchronous pass.
      publish()
      void lastSnapshotChange
      if (!disposed && missedHydrationEvents) {
        // Events landed between the caller's cold snapshot and this
        // subscription; they are unobservable as changes, so the window is the
        // only honest source. (Also covers a rollover observed before this
        // point: the recovery is already armed and simply coalesces.)
        requireRefold()
      }
      return { dispose, acknowledgeWindowRefold }
    },
  }
}

/** Structural mirror of the official `SessionEventChange` discriminator. */
type RemoteWindowChange =
  | { readonly kind: 'replace'; readonly entries: readonly RemotePresentationEventEntry[] }
  | { readonly kind: 'prepend'; readonly entries: readonly RemotePresentationEventEntry[] }
  | { readonly kind: 'append'; readonly entries: readonly RemotePresentationEventEntry[] }
  | {
    readonly kind: 'settle-assistant'
    readonly attemptId: string
    readonly entry?: { readonly type: 'event'; readonly event: unknown }
  }
