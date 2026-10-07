/**
 * Durable image loading for the transcript (plan M8, §16).
 *
 * History images come ONLY from the official attachment read — never from the
 * draft store (§16). The loader is the async bridge a render component consults
 * synchronously:
 *
 * - `get(ref, scope)` returns the CURRENT state (idle/loading/ready/error)
 *   without awaiting — render methods cannot await (plan §16.1);
 * - `load(ref, scope)` fires the underlying read ONCE per (scope, attachment id),
 *   deduping concurrent loads from multiple components (§16.2);
 * - subscribers are notified after every settle so components can
 *   invalidate and repaint with the resolved bytes.
 *
 * SCOPE OWNERSHIP (M3-5 PR2 review, P1): the read AUTHORITY belongs to the
 * attachment ref's OWNING PRESENTATION, not to whichever Session happens to be on
 * screen when the read runs. The caller therefore passes an explicit, IMMUTABLE
 * scope (`ImageThumbnail` captures it at construction from the presentation being
 * rendered; the renderer never re-resolves it), and EVERY piece of read state —
 * the resolved bytes, the in-flight read, the recorded failure AND the subscribers
 * — is keyed by that scope plus the attachment id. The loader never resolves or
 * guesses the subject itself.
 *
 * Why the scope is not the attachment id alone: the official Client authorizes
 * `session/attachment` per Session (`referencedImage(source.events, attachmentId)`)
 * and the official Web client scopes its own history-image cache by
 * `SessionBinding`. Identical content-addressed bytes therefore never mean the
 * authorization may be shared: a child transcript's image must be read through
 * the CHILD Session's bound face, and a stale component of a replaced presentation
 * must fail closed against ITS OWN (possibly released) binding instead of asking
 * whoever is displayed now.
 * @module @xmoon76/dsh-pi-tui/image/loader
 */

import { ImageLoadError } from '../domain/media/errors.ts'
import type { ImageAttachmentRefLike } from '../domain/media/types.ts'
import { ImageCache } from './cache.ts'

/** Cap on retained failure records (round-2 finding 3): failures are
 * diagnostic, never a growing leak on long transcripts. */
const MAX_ERROR_ENTRIES = 64

/** One durable ref's load state, as a render component sees it. */
export type ImageLoadState =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly bytes: Uint8Array; readonly base64: string }
  | { readonly state: 'error'; readonly error: Error }

/** The read seam. `context` is the caller's immutable presentation scope; the
 *  composition owner interprets it (it decides which Session face may read). */
export type ReadImage = (
  ref: ImageAttachmentRefLike,
  context?: unknown,
) => Promise<{ ref: unknown; data: Uint8Array }>

/** Structural subset of `ctx.attachments.readImage`. */
export interface ReadImageLike {
  readImage(ref: ImageAttachmentRefLike, signal?: AbortSignal): Promise<{ ref: unknown; data: Uint8Array }>
}

/**
 * One presentation lifetime's read state. Never shared across scopes: the bytes,
 * the in-flight read, the recorded failure and the subscribers all belong to the
 * presentation whose authorization produced them.
 */
interface LoaderScope {
  readonly cache: ImageCache
  readonly inflight: Map<string, Promise<{ data: Uint8Array }>>
  readonly errors: Map<string, Error>
  /** Per-attachment listeners OF THIS SCOPE: another scope's settle never wakes
   *  this presentation's components. */
  readonly listeners: Map<string, Set<() => void>>
}

function emptyScope(cache: ImageCache = new ImageCache()): LoaderScope {
  return { cache, inflight: new Map(), errors: new Map(), listeners: new Map() }
}

/** The async image loader with per-scope dedupe + subscriber notify. */
export class ImageLoader {
  private readonly read: ReadImage
  /** Object scopes are held weakly: the renderer keeps only the presentation it
   *  is currently building, so a retired presentation's state (bytes, failures and
   *  subscribers) is collectable instead of accumulating. */
  private readonly objectScopes = new WeakMap<object, LoaderScope>()
  /** Primitive/absent scopes share one state per value. */
  private readonly valueScopes = new Map<unknown, LoaderScope>()
  private readonly defaultScope: LoaderScope
  /**
   * Weakly-held registry of every live scope, so the GLOBAL operations
   * (`clear`, `invalidate`, `listenerCount`) reach the ACTIVE presentation scopes
   * too — the per-object map cannot be enumerated, and enumerating it with strong
   * references would keep every retired presentation (and its bytes) alive. Dead
   * references are compacted away on each sweep.
   */
  private readonly liveScopes: WeakRef<LoaderScope>[] = []
  /**
   * Invalidation generations (review finding 3): `invalidate(id)` bumps
   * ONLY that attachment's local generation, so a settle of an unrelated
   * in-flight read is never discarded. `clear()` bumps the GLOBAL
   * generation AND resets the per-id map — every in-flight settle is stale
   * after a session switch, including ones that had been locally
   * invalidated before (a per-id override must never let a pre-clear read
   * pass the global check; review finding: composite-single-number epochs
   * were unsound).
   */
  private globalEpoch = 0
  private readonly perIdEpoch = new Map<string, number>()

  constructor(
    read: ReadImage,
    cache: ImageCache = new ImageCache(),
  ) {
    // Explicit fields (Node strip-only mode rejects parameter properties).
    this.read = read
    this.defaultScope = this.registerScope(emptyScope(cache))
  }

  /** Track one scope for the global operations without owning it. */
  private registerScope(scope: LoaderScope): LoaderScope {
    this.liveScopes.push(new WeakRef(scope))
    return scope
  }

  /** Every scope that is still alive, compacting dead registry entries. */
  private liveScopesNow(): LoaderScope[] {
    const live: LoaderScope[] = []
    let write = 0
    for (const reference of this.liveScopes) {
      const scope = reference.deref()
      if (scope === undefined) continue
      live.push(scope)
      this.liveScopes[write] = reference
      write += 1
    }
    this.liveScopes.length = write
    return live
  }

  /** Resolve (or create) the read-state scope of one caller-supplied identity. */
  private scopeOf(scope: unknown): LoaderScope {
    if (scope === undefined) return this.defaultScope
    if (typeof scope === 'object' && scope !== null) {
      let resolved = this.objectScopes.get(scope)
      if (resolved === undefined) {
        resolved = this.registerScope(emptyScope())
        this.objectScopes.set(scope, resolved)
      }
      return resolved
    }
    let resolved = this.valueScopes.get(scope)
    if (resolved === undefined) {
      resolved = this.registerScope(emptyScope())
      this.valueScopes.set(scope, resolved)
    }
    return resolved
  }

  /** The epoch one read must match at settle time (a binary snapshot). */
  private epochOf(id: string): { global: number; local: number } {
    return {
      global: this.globalEpoch,
      local: this.perIdEpoch.get(id) ?? 0,
    }
  }

  /** Whether a settle with the captured epoch is still current. */
  private epochCurrent(id: string, captured: { global: number; local: number }): boolean {
    return this.globalEpoch === captured.global
      && (this.perIdEpoch.get(id) ?? 0) === captured.local
  }

  /** The synchronous state view for one ref in one presentation scope. */
  get(ref: ImageAttachmentRefLike, scope?: unknown): ImageLoadState {
    const resolved = this.scopeOf(scope)
    const id = ref.attachmentId
    const cached = resolved.cache.get(id)
    if (cached !== undefined) {
      if (cached.state === 'ready') {
        return { state: 'ready', bytes: cached.bytes, base64: cached.base64 }
      }
      return { state: 'error', error: cached.error }
    }
    const failed = resolved.errors.get(id)
    if (failed !== undefined) return { state: 'error', error: failed }
    if (resolved.inflight.has(id)) return { state: 'loading' }
    return { state: 'idle' }
  }

  /** Whether a ref is fully resolved for one presentation scope (cache hit). */
  isReady(ref: ImageAttachmentRefLike, scope?: unknown): boolean {
    return this.scopeOf(scope).cache.has(ref.attachmentId)
  }

  /**
   * Fire the async load for a ref (no-op when already loading/ready). One
   * underlying `readImage` per (scope, attachment id): concurrent callers of the
   * SAME presentation share the in-flight promise; a different presentation starts
   * its own read under its own authorization. On settle, that scope's cache/error
   * state updates and its subscribers for the attachment are notified.
   */
  load(ref: ImageAttachmentRefLike, scope?: unknown): void {
    const resolved = this.scopeOf(scope)
    const id = ref.attachmentId
    if (resolved.cache.has(id) || resolved.inflight.has(id)) return
    const epoch = this.epochOf(id)
    // `Promise.resolve().then(...)` defers the read call: a SYNCHRONOUS
    // throw from `read` becomes a rejection instead of escaping into a
    // render() call stack (round-2 finding 1). The caller's IMMUTABLE scope
    // travels with the ref, so the deferred read can never be re-routed to
    // whichever presentation is current by then.
    const pending = Promise.resolve().then(() => this.read(ref, scope)).then((stored) => {
      // A stale settlement (the attachment was invalidated, or the whole
      // cache cleared) is dropped — it must not repopulate the cache
      // (round-4 finding 4; per-id generations, review finding 3). The bytes are
      // authorized for THIS scope only, so they land in this scope's cache.
      if (!this.epochCurrent(id, epoch)) return stored
      const data = stored.data
      resolved.cache.set(id, {
        state: 'ready',
        bytes: data,
        base64: bytesToBase64(data),
        byteLength: data.byteLength,
      })
      resolved.errors.delete(id)
      return stored
    }).catch((error: unknown) => {
      if (!this.epochCurrent(id, epoch)) return { data: new Uint8Array(0) }
      // The failure belongs to the ASKING scope: a read replaced by a newer
      // request of the same scope must not publish its failure for it.
      if (resolved.inflight.get(id) !== pending) return { data: new Uint8Array(0) }
      this.recordError(resolved, id, error instanceof Error ? error : new ImageLoadError(String(error)))
      return { data: new Uint8Array(0) }
    }).finally(() => {
      // Only the CURRENT entry is cleared (a newer request of the same scope may
      // already have replaced this read).
      if (resolved.inflight.get(id) === pending) resolved.inflight.delete(id)
      // Settle fan-out is per-(scope, attachment): only the components of THIS
      // presentation watching THIS id repaint (review finding 8).
      this.notify(resolved, id)
    })
    resolved.inflight.set(id, pending)
  }

  /** Record one load failure, bounding the error map (round-2 finding 3). */
  private recordError(scope: LoaderScope, id: string, error: Error): void {
    scope.errors.set(id, error)
    if (scope.errors.size > MAX_ERROR_ENTRIES) {
      const oldest = scope.errors.keys().next().value as string | undefined
      if (oldest !== undefined) scope.errors.delete(oldest)
    }
  }

  /**
   * Subscribe to one attachment's settles WITHIN one presentation scope; returns
   * the unsubscribe function. A settle notifies only its own scope's listeners, so
   * another Session's settle for the same content id never wakes this
   * presentation's components. `clear()` broadcasts to every reachable subscriber.
   */
  subscribe(attachmentId: string, listener: () => void, scope?: unknown): () => void {
    const resolved = this.scopeOf(scope)
    let set = resolved.listeners.get(attachmentId)
    if (set === undefined) {
      set = new Set()
      resolved.listeners.set(attachmentId, set)
    }
    set.add(listener)
    return () => {
      const owned = resolved.listeners.get(attachmentId)
      if (owned === undefined) return
      owned.delete(listener)
      if (owned.size === 0) resolved.listeners.delete(attachmentId)
    }
  }

  /** Drop one attachment's cached state (transcript trim). In-flight reads
   * for THIS attachment settle into the void (its per-id generation bumps);
   * unrelated in-flight reads keep their generations and settle normally
   * (review finding 3). A retired presentation scope is unreachable and
   * collects with its own state. */
  invalidate(attachmentId: string): void {
    this.perIdEpoch.set(attachmentId, this.epochOf(attachmentId).local + 1)
    for (const scope of this.liveScopesNow()) {
      scope.cache.delete(attachmentId)
      scope.errors.delete(attachmentId)
    }
  }

  /** Drop everything (session switch / dispose): the GLOBAL generation
   * bumps AND the per-id map resets — a pre-clear local invalidation can
   * never mask the global invalidation for a later settle (review
   * finding), and the map cannot grow unboundedly. Every reachable
   * subscriber hears the global invalidation and repaints once. Retired
   * object scopes are dropped by the renderer building a new presentation,
   * not enumerated here. */
  clear(): void {
    this.globalEpoch += 1
    this.perIdEpoch.clear()
    for (const scope of this.liveScopesNow()) {
      scope.cache.clear()
      scope.errors.clear()
    }
    this.notifyAll()
  }

  /** Current cache size of one scope (observability/tests). */
  cacheSize(scope?: unknown): number {
    return this.scopeOf(scope).cache.size()
  }

  /** Current subscriber count across every LIVE scope, including the active
   *  presentation scopes (observability/tests). */
  listenerCount(): number {
    let total = 0
    for (const scope of this.liveScopesNow()) {
      for (const set of scope.listeners.values()) total += set.size
    }
    return total
  }

  /** Notify ONE scope's listeners of one attachment (settle fan-out). */
  private notify(scope: LoaderScope, attachmentId: string): void {
    const set = scope.listeners.get(attachmentId)
    if (set === undefined) return
    for (const listener of set) {
      try {
        listener()
      } catch {
        // A throwing subscriber must not break the settle fan-out.
      }
    }
  }

  /** Notify every reachable subscriber (global invalidation). */
  private notifyAll(): void {
    for (const scope of this.liveScopesNow()) {
      for (const set of scope.listeners.values()) {
        for (const listener of set) {
          try {
            listener()
          } catch {
            // A throwing subscriber must not break the fan-out.
          }
        }
      }
    }
  }
}

/** Base64 of a byte buffer (the pi-tui Image component's input). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}
