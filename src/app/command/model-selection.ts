/**
 * ModelSelectionOwner (A5b-3, plan §A5b-3): the ONE owner of the model-selection
 * presentation state — the sessionless global-default intent tracker, its
 * write barrier, the in-flight "selecting" marker and the TUI-only selection
 * facade.
 *
 * The module is deliberately neutral: it imports no Host agent/session package
 * and performs no Host lookup. The selection type is a generic parameter
 * bounded by the repository's structural `ModelSelectionValue`, and the exact
 * Direct reads/writes (the live Agent, the persisted Host default, the
 * per-Agent selection ref) arrive as narrow injected capabilities, so the
 * composition root instantiates this owner with the Host `ModelSelection` type.
 * @module @xmoon76/dsh-pi-tui/app/command/model-selection
 */

import { DefaultIntentTracker } from '../../default-intent.ts'
import { DefaultWriteBarrier } from '../../default-write-barrier.ts'
import { sameModelSelection, type ModelSelectionValue } from '../../model-selection.ts'

/** The TUI-only selection facade shape (structurally the Host
 *  `ModelSelectionRef`, never imported). */
export interface SelectionRef<Selection> {
  current: Selection | undefined
  assembled: undefined
}

/** The narrow capabilities the model-selection owner consumes. */
export interface ModelSelectionDeps<Selection extends ModelSelectionValue> {
  /** The live agent of the current owner, or undefined (sessionless surface). */
  readonly liveAgent: () => unknown
  /** The current ownership generation (the marker fence). */
  readonly generation: () => number
  /** The persisted Host default selection (the sessionless base read). */
  readonly currentDefault: () => Selection | undefined
  /** The exact live Agent's selection (the live base read). */
  readonly currentOf: (agent: unknown) => Selection | undefined
  /** Write one live Agent's selection (the facade write path). */
  readonly setCurrentOf: (agent: unknown, next: Selection | undefined) => void
}

/** The model-selection owner as the rest of the application consumes it. */
export interface ModelSelectionOwner<Selection extends ModelSelectionValue> {
  /** The TUI-only selection facade (never installed into an Agent context). */
  readonly selected: SelectionRef<Selection>
  /** The sessionless global-default intent tracker. */
  readonly defaultIntent: DefaultIntentTracker<Selection>
  /** Record one sessionless default intent. */
  setDefaultIntent(next: Selection | undefined): void
  /** Settle one intent operation. */
  settleIntent(id: number, outcome: 'committed' | 'failed' | 'unresolved'): void
  /** Reconcile an unresolved intent against an authoritative Host read. */
  reconcileDefaultIntent(persisted: ModelSelectionValue | undefined): void
  /** The in-flight Session selection marker (live sessions). */
  setPending(selection: Selection | undefined, token?: number, status?: 'pending' | 'unresolved'): void
  /** The owned in-flight marker for the CURRENT generation. */
  currentMarker(): { readonly selection: Selection; readonly status: 'pending' | 'unresolved' } | undefined
  /** Track one in-flight sessionless default write. */
  trackDefaultWrite(write: Promise<unknown>): void
  /** Wait for every in-flight sessionless default write. */
  awaitPendingDefaultWrite(signal?: AbortSignal): Promise<void>
  /** The persisted default selection (the sessionless base). */
  currentDefault(): Selection | undefined
  /** The exact live Agent's selection. */
  currentOf(agent: unknown): Selection | undefined
}

/** Create the model-selection owner (plan §A5b-3). */
export function createModelSelectionOwner<Selection extends ModelSelectionValue>(
  deps: ModelSelectionDeps<Selection>,
): ModelSelectionOwner<Selection> {
  // The latest SESSIONLESS /model global-default intent (a live Session write
  // is NOT recorded here: the official `session.selectModel` best-effort
  // default save is a Host side effect, so the tracker is sessionless-only).
  // It is TRANSIENT: a committed save clears it (the next /new reads the
  // persisted default dynamically), an ambiguous save stays UNRESOLVED until
  // an authoritative Host read reconciles it, and a failed save walks the
  // operation ancestry back to the nearest still-pending ancestor.
  //
  // The intent is a small OPERATION CHAIN state machine (the pure
  // `DefaultIntentTracker`): each operation carries its own save status and
  // links the operation that owned the intent before it. A settle reports
  // ONLY the operation id and outcome; the machine decides whether the intent
  // clears (committed), restores the nearest pending ancestor, retains the
  // nearest unresolved ancestor, or clears as failed when none remains.
  // An optimistic intent is NOT a committed save — the semantic settlement
  // still awaits the Host write.
  
  const defaultIntent = new DefaultIntentTracker<Selection>()

  const setDefaultIntent = (next: Selection | undefined): void => { defaultIntent.set(next) }

  const settleIntent = (id: number, outcome: 'committed' | 'failed' | 'unresolved'): void => { defaultIntent.settle(id, outcome) }

  /** Reconcile an UNRESOLVED sessionless default intent against an
   *  authoritative Host read (v2 §0.3.2): the persisted default either
   *  carries the choice (committed) or proves it did not land (clear). */
  
  const reconcileDefaultIntent = (persisted: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined): void => {
    // Only an AUTHORITATIVE snapshot reconciles; an unavailable read is not
    // proof. The tracker itself walks the whole unresolved ancestry with the
    // SAME snapshot (a matching ancestor commits; non-matching ones fail). The
    // sessionless footer marker is DERIVED from the tracker, so a restored
    // pending ancestor is shown again with no separate marker bookkeeping.
    if (persisted === undefined) return
    defaultIntent.reconcile(selection => sameModelSelection(persisted as Selection, selection))
  }

  /** TUI-only facade; this ref is NEVER installed into an Agent context. */
  
  const selected: SelectionRef<Selection> = {
    get current(): Selection | undefined {
      return deps.liveAgent() === undefined
        ? defaultIntent.intent ?? (deps.currentDefault() as Selection | undefined | undefined)
        : deps.currentOf(deps.liveAgent())
    },
    set current(next: Selection | undefined) {
      // The facade write path: a live Session routes to its own selection
      // (in-memory; the durable commit belongs to the catalog port), a
      // sessionless surface records the default intent. /model uses the
      // runner's explicit setDefaultIntent for the durable path.
      if (deps.liveAgent() === undefined) {
        setDefaultIntent(next)
        return
      }
      deps.setCurrentOf(deps.liveAgent(), next)
    },
    assembled: undefined,
  }

  // Monotonic session generation: bumped on EVERY session swap (switch,
  // resume, deferred creation). Late async work (the skill command
  // catalog refresh, title folds) captures the
  // generation it was issued for and refuses to commit state once a newer
  // session owns the surface. Bumping also tears down old-session-only
  // state: tool-call preview args, search results, and per-message
  // expansion overrides. Pending question/approval dialogs settle through
  // their own abort signals — the disposed agent aborts them — so they
  // need no explicit teardown here.
  /** EVERY in-flight sessionless `/model` global-default write (the pure
   *  `DefaultWriteBarrier`): the Direct adapter intentionally allows
   *  overlapping writes, so an older write can still be settling — and
   *  re-asserting the newest committed value — after a newer one resolved. A
   *  fresh create waits for ALL of them before reading the persisted Host
   *  default. */
  
  const defaultWriteBarrier = new DefaultWriteBarrier()

  const trackDefaultWrite = (write: Promise<unknown>): void => { defaultWriteBarrier.track(write) }

  const awaitPendingDefaultWrite = (signal?: AbortSignal): Promise<void> => defaultWriteBarrier.wait(signal)

  /** The in-flight Session model selection the footer reports as
   *  `selecting`; the display itself always follows the authoritative
   *  Session selection, never this request. */
  
  let pendingModelSelection: { readonly generation: number; readonly selection: Selection; readonly token: number; readonly status: 'pending' | 'unresolved' } | undefined

  const setModelSelectionPending = (selection: Selection | undefined, token?: number, status: 'pending' | 'unresolved' = 'pending'): void => {
    if (selection === undefined) {
      // Only the operation that OWNS the marker may clear it: an older
      // completion must never wipe a newer operation's `(selecting…)`.
      if (token !== undefined && pendingModelSelection !== undefined && pendingModelSelection.token !== token) return
      pendingModelSelection = undefined
      return
    }
    pendingModelSelection = { generation: deps.generation(), selection, token: token ?? 0, status }
  }

  /** The owned in-flight marker for the CURRENT generation (status included),
   *  so the footer can distinguish `selecting…` from an explicit `unconfirmed`
   *  unresolved state (v2 §0.3.2).
   *
   *  LIVE Session writes use the explicit `pendingModelSelection` marker. A
   *  SESSIONLESS write has no live Session, so its marker is DERIVED from the
   *  single `DefaultIntentTracker` source — pending `(selecting…)` while the
   *  default write is in flight, `(unconfirmed)` while unresolved. There is
   *  no second marker to diverge from the tracker. */
  
  const currentModelSelectionMarker = ():
    { readonly selection: Selection; readonly status: 'pending' | 'unresolved' } | undefined => {
    if (deps.liveAgent() !== undefined) {
      return pendingModelSelection !== undefined && pendingModelSelection.generation === deps.generation()
        ? { selection: pendingModelSelection.selection, status: pendingModelSelection.status }
        : undefined
    }
    const selection = defaultIntent.intent
    if (selection === undefined) return undefined
    return { selection, status: defaultIntent.outcome === 'unresolved' ? 'unresolved' : 'pending' }
  }


  return {
    selected,
    defaultIntent,
    setDefaultIntent,
    settleIntent,
    reconcileDefaultIntent,
    setPending: setModelSelectionPending,
    currentMarker: currentModelSelectionMarker,
    trackDefaultWrite,
    awaitPendingDefaultWrite,
    currentDefault: () => deps.currentDefault(),
    currentOf: (agent) => deps.currentOf(agent),
  }
}
