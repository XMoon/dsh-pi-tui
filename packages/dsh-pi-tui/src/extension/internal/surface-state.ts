/**
 * The SurfaceStateStore (M2): immutable, selector-aware surface/session/
 * activity snapshots with batched delivery. TuiApp's setters write into the
 * store; outlets subscribe to the slices they render and rebuild only when
 * their slice actually changes.
 *
 * Contract (plan §7):
 * - snapshots are deeply readonly/frozen;
 * - selectors pick a slice; subscribers fire only when the slice CHANGES
 *   (identity-compared against the last delivered value);
 * - delivery is batched on a microtask (N state writes in one tick → one
 *   notification per subscriber + one render request);
 * - secrets/credentials/raw Context/live Agent never enter a snapshot;
 * - a stale surface generation's late write is dropped by the caller (the
 *   host guards writes with the generation check).
 * @module @xmoon76/dsh-pi-tui/extension/surface-state
 */

import type { ActivitySnapshot, SessionSnapshot, SurfaceSnapshot } from '../public-types.ts'

/** The store's three named slices. */
export interface SurfaceStateValues {
  readonly surface: SurfaceSnapshot
  readonly session: SessionSnapshot
  readonly activity: ActivitySnapshot
}

/** Mutable builder inputs; the store freezes every published snapshot. */
export interface SurfaceStateInputs {
  surface: SurfaceSnapshot
  session: SessionSnapshot
  activity: ActivitySnapshot
}

/** Batched notification sink (the SurfaceHost wires the active screen). */
export interface StateNotifySink {
  /** Request one render of the active screen (coalesced by the batcher). */
  requestRender(): void
}

/** A subscription disposer; idempotent. */
export type StateDisposable = () => void

/** One slice subscription: fires when the selected slice changes. */
export interface StateSelector<T> {
  /** The slice to watch; may return a fresh object each call — the store
   * compares it against the LAST DELIVERED value (identity), so selectors
   * that derive new objects must memoize or use stable slices. */
  select(state: SurfaceStateValues): T
  /** Called with the new slice when it differs from the last delivered. */
  notify(value: T): void
}

/** Shallow field equality for one slice (all fields are primitives or
 * short readonly lists; identity is enough for the lists). */
function shallowEqual<T extends object>(next: T, current: T): boolean {
  const nextKeys = Object.keys(next) as (keyof T)[]
  for (const key of nextKeys) {
    if ((next as Record<keyof T, unknown>)[key] !== (current as Record<keyof T, unknown>)[key]) return false
  }
  return true
}

/** The immutable surface state store. */
export class SurfaceStateStore {
  private values: SurfaceStateValues
  /** Subscription → last delivered slice (identity comparison). */
  private readonly lastDelivered = new Map<StateSelector<unknown>, unknown>()
  private readonly subscribers = new Set<StateSelector<unknown>>()
  private readonly sink: StateNotifySink
  private scheduled = false

  constructor(sink: StateNotifySink) {
    this.sink = sink
    // Initial snapshots: a surface always exists (the store is created by
    // the host when the surface attaches); session/activity start empty.
    this.values = {
      surface: Object.freeze({
        surfaceId: '',
        generation: 0,
        width: 0,
        height: 0,
        fullscreen: false,
        focusedSeat: 'none',
        themeId: 'dark',
        themeRevision: 0,
      }),
      session: Object.freeze({
        workspaceRoot: '',
        cwd: '',
        planMode: false,
        busy: false,
        viewerMode: false,
      }),
      activity: Object.freeze({
        working: false,
        queuedCount: 0,
        taskCount: 0,
        childAgentCount: 0,
        todoCount: 0,
      }),
    }
  }

  /** The current immutable snapshot values (never mutate them). */
  get(): SurfaceStateValues {
    return this.values
  }

  /** Replace one or more slices. Every published snapshot is deep-frozen;
   * a slice whose fields are ALL unchanged is a no-op (the old frozen
   * object stays current, so subscribers comparing identities see no
   * change). */
  set(next: Partial<SurfaceStateInputs>): void {
    let changed = false
    const merged = { ...this.values }
    if (next.surface !== undefined && !shallowEqual(next.surface, this.values.surface)) {
      merged.surface = Object.freeze({ ...next.surface })
      changed = true
    }
    if (next.session !== undefined && !shallowEqual(next.session, this.values.session)) {
      merged.session = Object.freeze({ ...next.session })
      changed = true
    }
    if (next.activity !== undefined && !shallowEqual(next.activity, this.values.activity)) {
      merged.activity = Object.freeze({ ...next.activity })
      changed = true
    }
    if (!changed) return
    this.values = merged
    this.schedule()
  }

  /** Subscribe to a slice. The FIRST notification is synchronous with the
   * current slice (outlets render immediately); later ones are batched on a
   * microtask and fire only when the slice changed since the last delivery. */
  subscribe<T>(selector: StateSelector<T>): StateDisposable {
    const wrapped = selector as StateSelector<unknown>
    this.subscribers.add(wrapped)
    const initial = wrapped.select(this.values)
    this.lastDelivered.set(wrapped, initial)
    wrapped.notify(initial)
    return () => {
      this.subscribers.delete(wrapped)
      this.lastDelivered.delete(wrapped)
    }
  }

  /** Drop every subscription (surface dispose). */
  clearSubscribers(): void {
    this.subscribers.clear()
    this.lastDelivered.clear()
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      const values = this.values
      let anyChanged = false
      for (const subscriber of [...this.subscribers]) {
        const next = subscriber.select(values)
        const last = this.lastDelivered.get(subscriber)
        if (next === last) continue
        this.lastDelivered.set(subscriber, next)
        subscriber.notify(next)
        anyChanged = true
      }
      if (anyChanged) this.sink.requestRender()
    })
  }
}
