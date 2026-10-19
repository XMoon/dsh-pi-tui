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
  readonly onWindowRefoldRequired: (sessionId: string, reason?: RemoteRefoldReason) => void
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
  /**
   * Whether a window read at `revision` may be COMMITTED by the fold owner. It
   * is `false` while the window still belongs to the generation that rolled
   * over (the upstream journal stream retains the previous window until the new
   * generation's opening page arrives), so the owner must check it BEFORE it
   * replaces its fold — acknowledging afterwards would be too late.
   */
  refoldEligible(revision: number): boolean
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
    hydrate?: RemoteLiveIngressHydrate,
  ): RemoteLiveIngressHandle
}

/**
 * The caller's hydrate/read baseline: the revision it committed plus the EXACT
 * transport identity it was fenced under (`{ generation, binding }`, the same
 * token the presentation source captures). A rollover, a replaced binding or an
 * event that landed between the read and this subscription makes the baseline
 * unusable as an incremental start, so the handle recovers instead of trusting
 * it.
 */
export interface RemoteLiveIngressHydrate {
  /** The window revision the caller's cold hydrate/read committed. */
  readonly revision: number
  /** The transport identity that read was fenced under (opaque here; the
   *  presentation source produced it). */
  readonly transportToken?: unknown
}

/**
 * Create the ingress factory.
 *
 * LIFETIME CONTRACT: the factory installs exactly ONE process-lifetime watch —
 * a listener on the official Connection generation source, used to remember that
 * a rollover happened even while no handle exists (a surface rebuild must then
 * treat its cold attach as verify-first). That watch is NOT owned by a handle
 * and is never explicitly released: its lifetime is the owning presentation
 * bundle / Client runtime — the official generation source belongs to the same
 * Client context and stops delivering when that context is disposed, and the
 * presentation source (`src/app/remote/presentation-source.ts`) is created once
 * per aggregate with no separate disposer. Each `subscribe` handle additionally
 * owns exactly one eventSource subscription plus the current-fact projection
 * faces, and detaches on an exact BINDING replacement or an explicit `dispose` —
 * never on a Connection generation rollover, which it adopts (see the module
 * contract above).
 */
export function createRemoteLiveIngress(
  sessions: RemoteLiveIngressSessions,
  generation: RemoteConnectionGenerationSource,
  /** The current-fact projection keys this ingress follows (the official
   *  feature contract has per-key faces only). */
  projectionKeys: readonly string[] = [],
): RemoteLiveIngress {
  /**
   * Whether this process observed a Connection rollover. A COLD attach that
   * happens after one may be hydrating the retained PREVIOUS-generation window
   * (the upstream journal stream keeps it until the opening page is republished)
   * and the official faces carry no window-generation marker, so such a handle
   * starts in verify-first mode: the first publication reconciles the window
   * instead of being trusted as an incremental delta.
   */
  let observedRollover = false
  let lastSeenGeneration = generation.getSnapshot()
  const trackRollover = (): void => {
    const current = generation.getSnapshot()
    if (current !== undefined && current !== lastSeenGeneration) observedRollover = true
    lastSeenGeneration = current
  }
  const unsubscribeFactoryRollover = generation.subscribe(trackRollover)
  void unsubscribeFactoryRollover
  return {
    subscribe(sessionId, sinks, hydrate) {
      // The handle EXISTS from the start. A transport that is momentarily
      // unavailable (a disconnect during the caller's read/commit) leaves the
      // surface in an explicit PENDING state that the OFFICIAL generation
      // channel later completes — never a silently missing ingress that no
      // reconnect can wake (plan §2.2/§2.5: no polling, no fabricated recovery).
      let disposed = false
      let attached: {
        readonly binding: RemoteLiveIngressBinding
        readonly detach: () => void
      } | undefined
      let startedTuples = new Set<string>()
      /** The revision of the last increment DELIVERED — or the revision one
       *  acknowledged recovery committed. Delivery bookkeeping only. */
      let lastDeliveredRevision = -1
      /** `recovering` = the incremental sequence is untrustworthy; the owner
       *  must re-fold the official window and acknowledge the revision. */
      let mode: 'incremental' | 'recovering' = 'incremental'
      /** The FULL identity the last wakeup was issued for: a NEW generation,
       *  binding, revision or open state re-arms it. Comparing revisions alone
       *  would swallow a mid-re-fold rollover whose read is already doomed by
       *  the transport fence — the handle would stay recovering with no future
       *  wakeup. */
      let notified:
        | {
          readonly generation: unknown
          readonly binding: unknown
          readonly revision: number
          readonly open: boolean
        }
        | undefined
      let notifyQueued = false
      /** The Connection generation the delivered sequence belongs to. */
      let fencedGeneration: RemoteConnectionGeneration | undefined = generation.getSnapshot()
      /**
       * The window revision the OLD generation had published when a rollover was
       * detected. The upstream RemoteJournalStream KEEPS the old published
       * window after a reconnect until the new generation's opening page
       * arrives (`packages/api/gateway/src/client/journal-stream.ts`), so a
       * re-fold performed in that gap reads a window that is still the DEAD
       * generation's — its revision and open state look perfectly current. Until
       * the new generation republishes (a new revision / `replace`), no
       * acknowledgement may claim that window, otherwise the opening page then
       * arrives as an ordinary append and the original missing rows return.
       */
      let rolloverBaselineRevision: number | undefined

      const seedTuplesFromWindow = (entries: readonly RemotePresentationEventEntry[]): void => {
        for (const entry of entries) {
          if (entry.type !== 'transient') continue
          startedTuples.add(`${entry.event.data.attemptId}:${entry.event.data.turn}:${entry.event.data.step}`)
        }
      }

      const detach = (): void => {
        const current = attached
        if (current === undefined) return
        attached = undefined
        current.detach()
      }

      const dispose = (): void => {
        if (disposed) return
        disposed = true
        unsubscribeGeneration()
        detach()
      }

      /** Ask the fold OWNER to reconcile the CURRENT official window. Intent
       *  only, coalesced, deferred by exactly one microtask so the caller's
       *  `handle = subscribe(...)` assignment always completes first. Every
       *  later revision, the loading→open transition and any change of the
       *  generation/binding identity re-arm it. */
      /** The reason of the pending (coalesced) wakeup: a recovery anywhere in the
       *  window escalates a paging wakeup, never the other way round. */
      let pendingRefoldReason: RemoteRefoldReason = 'recovery'
      const requireRefold = (reason: RemoteRefoldReason = 'recovery'): void => {
        if (disposed) return
        const current = attached
        if (current === undefined) return
        if (reason === 'recovery') pendingRefoldReason = 'recovery'
        else if (!notifyQueued && notified === undefined) pendingRefoldReason = 'paging'
        mode = 'recovering'
        const window = current.binding.eventSource.getSnapshot()
        const open = current.binding.session.getSnapshot().openState === 'open'
        if (notified !== undefined
          && Object.is(notified.generation, fencedGeneration)
          && Object.is(notified.binding, current.binding)
          && notified.revision === window.revision
          && notified.open === open) return
        notified = {
          generation: fencedGeneration,
          binding: current.binding,
          revision: window.revision,
          open,
        }
        if (notifyQueued) return
        notifyQueued = true
        queueMicrotask(() => {
          notifyQueued = false
          if (disposed || mode !== 'recovering') return
          const still = attached
          if (still === undefined || sessions.binding(sessionId) !== still.binding) return
          sinks.onWindowRefoldRequired(sessionId, pendingRefoldReason)
          pendingRefoldReason = 'recovery'
        })
      }

      /** Acknowledge one committed re-fold (see the interface contract). The
       *  proof is re-validated against the LIVE official state here. */
      const acknowledgeWindowRefold = (proof: PresentationWindowRefoldProof): boolean => {
        if (disposed) return false
        const current = attached
        if (current === undefined) return false
        if (!Object.is(proof.binding, current.binding)) return false
        const liveGeneration = generation.getSnapshot()
        if (!Object.is(proof.generation, liveGeneration)) return false
        const window = current.binding.eventSource.getSnapshot()
        if (window.revision !== proof.revision) return false
        if (current.binding.session.getSnapshot().openState !== 'open') return false
        if (!refoldEligible(proof.revision)) {
          // The window is still the one the DEAD generation published: the new
          // generation has not republished yet, so this fold cannot be the
          // authoritative baseline. Stay recovering; the opening page will move
          // the revision and re-arm the wakeup.
          return false
        }
        // The committed fold IS the official window as of `proof.revision`:
        // resume from there and re-seed the transient tuple memory from the
        // window the owner just folded.
        fencedGeneration = liveGeneration
        startedTuples = new Set<string>()
        seedTuplesFromWindow(window.entries)
        lastDeliveredRevision = proof.revision
        rolloverBaselineRevision = undefined
        mode = 'incremental'
        notified = undefined
        return true
      }

      /** One attachment: the receiver over this EXACT binding's official
       *  channels. A replaced same-id binding retires it (the owner's commit
       *  path installs the next one). */
      const attach = (capturedGeneration: RemoteConnectionGeneration, binding: RemoteLiveIngressBinding): void => {
        startedTuples = new Set<string>()
        seedTuplesFromWindow(binding.eventSource.getSnapshot().entries)
        const subscriptionRevision = binding.eventSource.getSnapshot().revision
        lastDeliveredRevision = subscriptionRevision
        mode = 'incremental'
        notified = undefined
        let lastSnapshotChange = 0

        const isBindingReplaced = (): boolean =>
          disposed || sessions.binding(sessionId) !== binding

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
            // A same-id binding rollover no longer owns this subscription.
            dispose()
            return
          }
          const liveGeneration = generation.getSnapshot()
          if (!Object.is(fencedGeneration, liveGeneration)) {
            // A Connection rollover invalidates the delivered sequence; the new
            // generation re-opens the session and may republish its whole
            // window (its numbering restarts), so cross-generation revision
            // comparison is meaningless. The currently retained window still
            // belongs to the DEAD generation until that republish arrives.
            fencedGeneration = liveGeneration
            rolloverBaselineRevision = binding.eventSource.getSnapshot().revision
            requireRefold()
          }
          if (mode === 'recovering') {
            requireRefold()
            return
          }
          const window = binding.eventSource.getSnapshot()
          if (window.revision === lastDeliveredRevision) return
          const change = (window as { readonly change?: RemoteWindowChange }).change
          if (change !== undefined && change.kind === 'prepend') {
            // Older history joined the front: no new model-visible event arrived,
            // so this reconcile must not re-measure the context.
            requireRefold('paging')
            return
          }
          if (change === undefined || change.kind === 'replace') {
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
              if (change.entry !== undefined) {
                sinks.onDurableEvent(sessionId, change.entry.event as PresentationDurableEvent)
              }
              for (const key of startedTuples) {
                if (key.startsWith(`${change.attemptId}:`)) startedTuples.delete(key)
              }
              lastDeliveredRevision = window.revision
              return
            }
          }
        }

        const onSnapshot = (): void => {
          if (isBindingReplaced()) {
            dispose()
            return
          }
          lastSnapshotChange += 1
          sinks.onSessionSnapshotChanged(sessionId)
          // The Session snapshot also carries the open state: a loading→open
          // transition is a REAL wakeup for an unsettled recovery.
          if (mode === 'recovering') requireRefold()
        }

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

        const unsubscribeSnapshot = binding.session.subscribe(onSnapshot)
        const offs = projectionKeys.map(key => binding.session.projections.faceOf(key).subscribe(onProjections))
        const unsubscribeEvent = binding.eventSource.subscribe(publish)
        attached = {
          binding,
          detach: () => {
            unsubscribeEvent()
            unsubscribeSnapshot()
            for (const off of offs) off()
          },
        }
        void lastSnapshotChange

        // The hydrate→subscribe fence: the caller's baseline is usable ONLY
        // when it was committed under this exact transport identity AND its
        // revision is still the current one. A rollover, a replaced binding or
        // events that landed in between make it another generation's window.
        const hydrateToken = hydrate?.transportToken as { generation?: unknown; binding?: unknown } | undefined
        const identityCurrent = hydrate === undefined
          || (Object.is(hydrateToken?.binding, binding) && Object.is(hydrateToken?.generation, capturedGeneration))
        if (!identityCurrent) {
          // The hydrate window was committed under ANOTHER transport identity:
          // the window currently retained may still be that dead generation's
          // one, so the acknowledge must wait for the republish.
          rolloverBaselineRevision = subscriptionRevision
          requireRefold()
        } else if (hydrate !== undefined && hydrate.revision !== subscriptionRevision) {
          // Same identity, but events landed between the read and this
          // subscription: the current window is the honest source.
          requireRefold()
        }
        // Lost-wakeup fence: a publication may have landed between the
        // subscription and this point.
        publish()
      }

      /** Attach as soon as BOTH official inputs exist. Driven only by the
       *  official generation channel (the bootstrap/viewer calls this once on
       *  entry); never a timer. */
      const tryAttach = (): void => {
        if (disposed || attached !== undefined) return
        const liveGeneration = generation.getSnapshot()
        if (liveGeneration === undefined) return
        const binding = sessions.binding(sessionId)
        if (binding === undefined) return
        fencedGeneration = liveGeneration
        attach(liveGeneration, binding)
      }

      const onGeneration = (): void => {
        if (disposed) return
        if (attached === undefined) {
          // The transport became available: attach and (via the hydrate fence
          // inside `attach`) reconcile the window the surface hydrated from.
          tryAttach()
          return
        }
        const liveGeneration = generation.getSnapshot()
        if (Object.is(fencedGeneration, liveGeneration)) return
        const current = attached
        fencedGeneration = liveGeneration
        rolloverBaselineRevision = current === undefined
          ? undefined
          : current.binding.eventSource.getSnapshot().revision
        requireRefold()
      }

      const refoldEligible = (revision: number): boolean =>
        !(rolloverBaselineRevision !== undefined && revision === rolloverBaselineRevision)

      const unsubscribeGeneration = generation.subscribe(() => {
        trackRollover()
        onGeneration()
      })
      const verifyFirst = observedRollover
      tryAttach()
      if (verifyFirst && attached !== undefined) {
        // Cold attach after a rollover: do not trust the attached revision as an
        // incremental baseline. Reconcile on the FIRST later publication (no
        // immediate wakeup: the fold was just hydrated from this same window).
        mode = 'recovering'
        const window = attached.binding.eventSource.getSnapshot()
        notified = {
          generation: fencedGeneration,
          binding: attached.binding,
          revision: window.revision,
          open: attached.binding.session.getSnapshot().openState === 'open',
        }
      }
      return { dispose, acknowledgeWindowRefold, refoldEligible }
    },
  }
}

/** Structural mirror of the official `SessionEventChange` discriminator. */
/**
 * WHY a window reconcile was requested: ordinary history paging (`loadOlder`
 * joins older events at the front — no new model-visible event arrived) versus a
 * recovery (rollover, replace, revision discontinuity, hydrate gap) where the
 * window may carry events the surface never saw.
 */
export type RemoteRefoldReason = 'paging' | 'recovery'

type RemoteWindowChange =
  | { readonly kind: 'replace'; readonly entries: readonly RemotePresentationEventEntry[] }
  | { readonly kind: 'prepend'; readonly entries: readonly RemotePresentationEventEntry[] }
  | { readonly kind: 'append'; readonly entries: readonly RemotePresentationEventEntry[] }
  | {
    readonly kind: 'settle-assistant'
    readonly attemptId: string
    readonly entry?: { readonly type: 'event'; readonly event: unknown }
  }
