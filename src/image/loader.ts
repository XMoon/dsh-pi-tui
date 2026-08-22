/**
 * Durable image loading for the transcript (plan M8, §16).
 *
 * History images come ONLY from `ctx.attachments.readImage(ref)` — never
 * from the draft store (§16). The loader is the async bridge a render
 * component consults synchronously:
 *
 * - `get(ref)` returns the CURRENT state (idle/loading/ready/error) without
 *   awaiting — render methods cannot await (plan §16.1);
 * - `load(ref)` fires the underlying read ONCE per attachment id, deduping
 *   concurrent loads from multiple components (§16.2);
 * - subscribers are notified after every settle so components can
 *   invalidate and repaint with the resolved bytes.
 * @module @xmoon76/dsh-pi-tui/image/loader
 */

import { ImageLoadError } from './errors.ts'
import { ImageCache } from './cache.ts'
import type { ImageAttachmentRefLike } from './admission.ts'

/** Cap on retained failure records (round-2 finding 3): failures are
 * diagnostic, never a growing leak on long transcripts. */
const MAX_ERROR_ENTRIES = 64

/** One durable ref's load state, as a render component sees it. */
export type ImageLoadState =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly bytes: Uint8Array; readonly base64: string }
  | { readonly state: 'error'; readonly error: Error }

/** Structural subset of `ctx.attachments.readImage`. */
export interface ReadImageLike {
  readImage(ref: ImageAttachmentRefLike, signal?: AbortSignal): Promise<{ ref: unknown; data: Uint8Array }>
}

/** The async image loader with concurrent-load dedupe + subscriber notify. */
export class ImageLoader {
  private readonly cache: ImageCache
  private readonly inflight = new Map<string, Promise<{ data: Uint8Array }>>()
  private readonly errors = new Map<string, Error>()
  /** Per-attachment listeners: a settle notifies ONLY the attachments that
   * care, so N thumbnails loading in parallel never invalidate each other
   * (review finding 8 — no O(N²) repaint churn). */
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly read: (ref: ImageAttachmentRefLike) => Promise<{ ref: unknown; data: Uint8Array }>
  /**
   * Invalidation epoch (round-4 finding 4): every invalidate/clear bumps it;
   * settlements belonging to an older epoch are dropped, so a read started
   * before an invalidation can never repopulate the cache afterwards.
   */
  private epoch = 0

  constructor(
    read: (ref: ImageAttachmentRefLike) => Promise<{ ref: unknown; data: Uint8Array }>,
    cache: ImageCache = new ImageCache(),
  ) {
    // Explicit fields (Node strip-only mode rejects parameter properties).
    this.read = read
    this.cache = cache
  }

  /** The synchronous state view for one ref (never awaits). */
  get(ref: ImageAttachmentRefLike): ImageLoadState {
    const id = ref.attachmentId
    const cached = this.cache.get(id)
    if (cached !== undefined) {
      if (cached.state === 'ready') {
        return { state: 'ready', bytes: cached.bytes, base64: cached.base64 }
      }
      return { state: 'error', error: cached.error }
    }
    const failed = this.errors.get(id)
    if (failed !== undefined) return { state: 'error', error: failed }
    if (this.inflight.has(id)) return { state: 'loading' }
    return { state: 'idle' }
  }

  /** Whether a ref is fully resolved (cache hit). */
  isReady(ref: ImageAttachmentRefLike): boolean {
    return this.cache.has(ref.attachmentId)
  }

  /**
   * Fire the async load for a ref (no-op when already loading/ready). One
   * underlying `readImage` per attachment id: concurrent callers share the
   * in-flight promise. On settle, the cache/error maps update and every
   * subscriber is notified.
   */
  load(ref: ImageAttachmentRefLike): void {
    const id = ref.attachmentId
    if (this.cache.has(id) || this.inflight.has(id)) return
    const epoch = this.epoch
    // `Promise.resolve().then(...)` defers the read call: a SYNCHRONOUS
    // throw from `read` becomes a rejection instead of escaping into a
    // render() call stack (round-2 finding 1).
    const pending = Promise.resolve().then(() => this.read(ref)).then((stored) => {
      // A stale settlement (an invalidate/clear happened meanwhile) is
      // dropped — it must not repopulate the cache (round-4 finding 4).
      if (this.epoch !== epoch) return stored
      const data = stored.data
      this.cache.set(id, {
        state: 'ready',
        bytes: data,
        base64: bytesToBase64(data),
        byteLength: data.byteLength,
      })
      this.errors.delete(id)
      return stored
    }).catch((error: unknown) => {
      if (this.epoch !== epoch) return { data: new Uint8Array(0) }
      this.recordError(id, error instanceof Error ? error : new ImageLoadError(String(error)))
      return { data: new Uint8Array(0) }
    }).finally(() => {
      this.inflight.delete(id)
      // Settle fan-out is per-attachment: only the components watching
      // THIS id repaint (review finding 8).
      this.notify(id)
    })
    this.inflight.set(id, pending)
  }

  /** Record one load failure, bounding the error map (round-2 finding 3). */
  private recordError(id: string, error: Error): void {
    this.errors.set(id, error)
    if (this.errors.size > MAX_ERROR_ENTRIES) {
      const oldest = this.errors.keys().next().value as string | undefined
      if (oldest !== undefined) this.errors.delete(oldest)
    }
  }

  /**
   * Subscribe to one attachment's settles; returns the unsubscribe
   * function. A settle notifies ONLY its attachment's listeners — N
   * thumbnails loading in parallel never invalidate each other (review
   * finding 8). `clear()` still broadcasts to every subscriber.
   */
  subscribe(attachmentId: string, listener: () => void): () => void {
    let set = this.listeners.get(attachmentId)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(attachmentId, set)
    }
    set.add(listener)
    return () => {
      const owned = this.listeners.get(attachmentId)
      if (owned === undefined) return
      owned.delete(listener)
      if (owned.size === 0) this.listeners.delete(attachmentId)
    }
  }

  /** Drop one attachment's cached state (transcript trim). In-flight reads
   * for it settle into the void (the epoch bumps, round-4 finding 4). */
  invalidate(attachmentId: string): void {
    this.epoch += 1
    this.cache.delete(attachmentId)
    this.errors.delete(attachmentId)
  }

  /** Drop everything (session switch / dispose); every subscriber hears
   * the global invalidation and repaints once. */
  clear(): void {
    this.epoch += 1
    this.cache.clear()
    this.errors.clear()
    this.notifyAll()
  }

  /** Current cache size (observability/tests). */
  cacheSize(): number {
    return this.cache.size()
  }

  /** Current subscriber count (observability/tests). */
  listenerCount(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }

  /** Notify the listeners of ONE attachment (settle fan-out). */
  private notify(attachmentId: string): void {
    const set = this.listeners.get(attachmentId)
    if (set === undefined) return
    for (const listener of set) {
      try {
        listener()
      } catch {
        // A throwing subscriber must not break the settle fan-out.
      }
    }
  }

  /** Notify every subscriber (global invalidation). */
  private notifyAll(): void {
    for (const set of this.listeners.values()) {
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

/** Base64 of a byte buffer (the pi-tui Image component's input). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}
