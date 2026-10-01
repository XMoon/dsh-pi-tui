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
 *   binding is unchanged, so the handle ADOPTS the new generation, forgets the
 *   dead generation's revision fence, and lets the next authoritative
 *   publication continue (a `replace` rehydrates the new window, an `append`
 *   routes the new entries). Detaching here would leave the surface dead;
 * no second assistant-stream tracker exists beside this ingress.
 * ```
 *
 * The ingress owns NO presentation state: every accepted input is handed to
 * the injected sinks (the bootstrap maps them onto the existing surface
 * routing + presentation owner), so the canonical pipeline stays the ONE
 * join.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/live-ingress
 */

import type { AssistantLiveChunk, AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import type {
  PresentationDurableEvent,
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
  /** The window was REPLACED (reconnect/gap repair): re-hydrate the whole
   *  presentation from the authoritative new window. */
  readonly onWindowReplaced: (sessionId: string) => void
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
   * `onWindowReplaced` (the authoritative re-hydrate) instead of being
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
      const subscriptionRevision = binding.eventSource.getSnapshot().revision
      let lastRevision = subscriptionRevision
      // The hydrate→subscribe gap: events that landed after the caller's cold
      // snapshot but before this subscription will never arrive as changes.
      // The honest recovery is the authoritative window re-hydrate (the same
      // path a reconnect takes), delivered AFTER the subscription is armed so
      // no subsequent event can be lost either.
      const missedHydrationEvents = hydrateRevision !== undefined && subscriptionRevision > hydrateRevision

      /** The exact retained binding is the ONLY retirement condition: a
       *  same-id rollover replaces the binding object, so its subscription
       *  must detach. */
      const isBindingReplaced = (): boolean =>
        disposed || sessions.binding(sessionId) !== binding

      /** Adopt the current Connection generation. A generation ROLLOVER
       *  (reconnect, network loss) does NOT retire the retained binding — it
       *  invalidates the OLD generation's async results and must drive the
       *  authoritative re-hydrate. Detaching here instead would leave the
       *  Remote surface permanently dead after any reconnect, because nothing
       *  re-establishes this subscription for an unchanged subject. */
      let fencedGeneration: RemoteConnectionGeneration | undefined = capturedGeneration
      const adoptGeneration = (): 'same' | 'replaced' => {
        const current = generation.getSnapshot()
        if (Object.is(fencedGeneration, current)) return 'same'
        fencedGeneration = current
        return 'replaced'
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
          // detach silently (the new owner's own subscription or re-hydrate
          // owns the surface from here).
          dispose()
          return
        }
        if (adoptGeneration() === 'replaced') {
          // The Connection generation changed under this exact binding: the
          // old generation's window proof is VOID. The new generation re-opens
          // the session and republishes its AUTHORITATIVE baseline, so forget
          // the old revision (its numbers belong to the dead generation) and
          // process the very next publication: a `replace` drives the
          // authoritative re-hydrate through the normal path, an `append`
          // routes the new durable entries — never swallowed as a duplicate
          // revision, and never a premature re-hydrate of the dead window.
          lastRevision = -1
        }
        const window = binding.eventSource.getSnapshot()
        if (window.revision === lastRevision) return
        lastRevision = window.revision
        // The eventSource exposes the WHOLE window + its latest `change`.
        // Re-derive from the change when present (the normal live path);
        // a revision jump without a usable change falls back to a full
        // re-hydrate through the reader (the honest recovery).
        const change = (window as { readonly change?: RemoteWindowChange }).change
        if (change === undefined) {
          sinks.onWindowReplaced(sessionId)
          return
        }
        switch (change.kind) {
          case 'append': {
            const { durable, live } = partitionChange(change.entries)
            for (const input of live) sinks.onLiveInput(input)
            for (const event of durable) sinks.onDurableEvent(sessionId, event)
            return
          }
          case 'prepend': {
            // Older history joined the window front (loadOlder/jump): the
            // append-only fold cannot take it incrementally. The surface's
            // history extension owns the re-hydrate; nothing to route live.
            return
          }
          case 'replace': {
            // Reconnect / gap repair: the new window is authoritative. The
            // tuple memory re-seeds from the NEW baseline (the re-hydrate
            // synthesizes those starts again).
            startedTuples.clear()
            seedTuplesFromWindow(binding.eventSource.getSnapshot().entries)
            sinks.onWindowReplaced(sessionId)
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
            return
          }
        }
      }

      const dispose = (): void => {
        if (disposed) return
        disposed = true
        unsubscribe?.()
        unsubscribe = undefined
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
      // Lost-wakeup fence: publication may have happened between the
      // subscription and this return; run one synchronous pass.
      publish()
      void lastSnapshotChange
      if (!disposed && missedHydrationEvents && lastRevision === subscriptionRevision) {
        sinks.onWindowReplaced(sessionId)
      }
      return { dispose }
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
