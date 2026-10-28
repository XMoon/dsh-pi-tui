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
 *
 * PREVIEW DERIVATIVES (Image-6A): a Kitty surface cannot place JPEG/WebP bytes
 * directly, so each presentation scope ALSO owns a bounded cache and scheduler
 * for PNG thumbnails derived from an already-READY source read. That derivative
 * is a read-only projection of the same authorized bytes — it mints no second
 * attachment authorization, no second source cache and no session-generation
 * authority. Its jobs, cache, failures and queue entries live in the SAME
 * `LoaderScope` and are invalidated by the SAME global/per-id epochs as the raw
 * read, so a stale conversion can never repopulate another presentation.
 * @module @xmoon76/dsh-pi-tui/client/media/image/loader
 */

import { ImageLoadError } from '../../../domain/media/errors.ts'
import type { ImageAttachmentRefLike } from '../../../domain/media/types.ts'
import { ImageCache } from './cache.ts'
import {
  MAX_KITTY_THUMBNAIL_OUTPUT_BYTES,
  MAX_KITTY_THUMBNAIL_SOURCE_BYTES,
  KittyThumbnailOutputTooLargeError,
  convertKittyThumbnail,
  type KittyThumbnailConverter,
  type KittyThumbnailPng,
} from './kitty-thumbnail.ts'

/** Cap on retained failure records (round-2 finding 3): failures are
 * diagnostic, never a growing leak on long transcripts. */
const MAX_ERROR_ENTRIES = 64

/** Preview cache bounds (plan §4): per presentation scope, LRU. */
const MAX_THUMBNAIL_ENTRIES = 16
const MAX_THUMBNAIL_BYTES = 32 * 1024 * 1024
/** At most this many `sharp` conversions run for ONE loader at a time. */
const MAX_THUMBNAIL_CONCURRENCY = 2
/** Bounded FIFO of not-yet-started conversions per loader. */
const MAX_THUMBNAIL_QUEUE = 32
/** Cap on retained preview failures, mirroring the raw read failure bound. */
const MAX_THUMBNAIL_FAILURES = 64

/** One durable ref's load state, as a render component sees it. */
export type ImageLoadState =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly bytes: Uint8Array; readonly base64: string }
  | { readonly state: 'error'; readonly error: Error }

/** The bounded reasons a derived Kitty preview can be unavailable. They are
 *  safe to surface generically; the original native `Error` (when any) stays
 *  in the preview state for diagnostics only and never reaches the terminal. */
export type KittyThumbnailFailureReason =
  | 'input-too-large'
  | 'busy'
  | 'decode-failed'
  | 'output-too-large'

/** One JPEG/WebP attachment's derived-PNG state inside one presentation scope. */
export type KittyThumbnailState =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | ({ readonly state: 'ready' } & KittyThumbnailPng)
  | {
      readonly state: 'error'
      readonly reason: KittyThumbnailFailureReason
      /** The captured native error, for diagnostics only. */
      readonly error?: Error
    }

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

/** One queued/running preview conversion. It holds the owning scope, the ref
 *  (metadata only — never the source bytes) and the capture-time epoch. */
interface KittyThumbnailJob {
  readonly scope: LoaderScope
  readonly ref: ImageAttachmentRefLike
  readonly epoch: { global: number; local: number }
}

/** A recorded preview failure: the safe reason plus the untouched native error. */
interface KittyThumbnailFailure {
  readonly reason: KittyThumbnailFailureReason
  readonly error?: Error
}

/** Per-scope LRU of derived PNG payloads. Only the base64 form is retained:
 *  that IS the resident memory the pi-tui `Image` consumes (plan §4). */
class KittyThumbnailCache {
  private readonly entries = new Map<string, KittyThumbnailPng>()
  private bytesHeld = 0

  get(attachmentId: string): KittyThumbnailPng | undefined {
    const entry = this.entries.get(attachmentId)
    if (entry === undefined) return undefined
    // LRU refresh: re-insert so the entry moves to the newest slot.
    this.entries.delete(attachmentId)
    this.entries.set(attachmentId, entry)
    return entry
  }

  set(attachmentId: string, png: KittyThumbnailPng): void {
    const existing = this.entries.get(attachmentId)
    if (existing !== undefined) this.bytesHeld -= Buffer.byteLength(existing.base64, 'utf8')
    this.entries.delete(attachmentId)
    this.entries.set(attachmentId, png)
    this.bytesHeld += Buffer.byteLength(png.base64, 'utf8')
    this.evict()
  }

  delete(attachmentId: string): void {
    const entry = this.entries.get(attachmentId)
    if (entry !== undefined) {
      this.bytesHeld -= Buffer.byteLength(entry.base64, 'utf8')
      this.entries.delete(attachmentId)
    }
  }

  clear(): void {
    this.entries.clear()
    this.bytesHeld = 0
  }

  size(): number {
    return this.entries.size
  }

  bytes(): number {
    return this.bytesHeld
  }

  private evict(): void {
    while (this.entries.size > MAX_THUMBNAIL_ENTRIES || this.bytesHeld > MAX_THUMBNAIL_BYTES) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) return
      this.delete(oldest)
    }
  }
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
  /** Bounded derived-PNG LRU of THIS presentation scope (never another
   *  presentation's authorized bytes). */
  readonly kittyThumbnailReady: KittyThumbnailCache
  /** Bounded preview failure records (safe reason + captured native error). */
  readonly kittyThumbnailFailures: Map<string, KittyThumbnailFailure>
  /** Queued/running conversion per attachment id, for one-conversion dedupe.
   *  The job identity (not the id alone) guards a slot replaced by invalidation. */
  readonly kittyThumbnailPending: Map<string, KittyThumbnailJob>
}

function emptyScope(cache: ImageCache = new ImageCache()): LoaderScope {
  return {
    cache,
    inflight: new Map(),
    errors: new Map(),
    listeners: new Map(),
    kittyThumbnailReady: new KittyThumbnailCache(),
    kittyThumbnailFailures: new Map(),
    kittyThumbnailPending: new Map(),
  }
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
  /** The decoder seam (defaults to the real sharp adapter); the constructor
   *  accepts an injected converter for deterministic boundary tests. */
  private readonly convertThumbnail: KittyThumbnailConverter
  /** Loader-wide FIFO of preview conversions waiting to START (bounded). */
  private readonly kittyThumbnailQueue: KittyThumbnailJob[] = []
  /** Retained running conversions: the scheduler never discards a promise it
   *  owns (no bare `void`), and the size IS the concurrency counter. */
  private readonly kittyThumbnailActive = new Set<Promise<void>>()

  constructor(
    read: ReadImage,
    cache: ImageCache = new ImageCache(),
    convertThumbnail: KittyThumbnailConverter = convertKittyThumbnail,
  ) {
    // Explicit fields (Node strip-only mode rejects parameter properties).
    this.read = read
    this.convertThumbnail = convertThumbnail
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

  /**
   * The synchronous preview state of one JPEG/WebP ref inside one presentation
   * scope (Image-6A). Derived from the SAME immutable scope the raw read used;
   * it never re-resolves a "current" presentation.
   */
  getKittyThumbnail(ref: ImageAttachmentRefLike, scope?: unknown): KittyThumbnailState {
    const resolved = this.scopeOf(scope)
    const id = ref.attachmentId
    const ready = resolved.kittyThumbnailReady.get(id)
    if (ready !== undefined) return { state: 'ready', ...ready }
    const failed = resolved.kittyThumbnailFailures.get(id)
    if (failed !== undefined) {
      return failed.error === undefined
        ? { state: 'error', reason: failed.reason }
        : { state: 'error', reason: failed.reason, error: failed.error }
    }
    if (resolved.kittyThumbnailPending.has(id)) return { state: 'loading' }
    return { state: 'idle' }
  }

  /**
   * Schedule ONE async JPEG/WebP → PNG conversion for a READY source read in
   * the SAME presentation scope. No-op while that attachment is already
   * ready/loading/failed, or when the source bytes are not present (the
   * conversion never re-downloads: it is a projection of an existing read).
   *
   * The loader-wide FIFO is bounded; an over-capacity request records a
   * bounded `busy` failure instead of growing a task list. Only
   * {@link getKittyThumbnail}/{@link loadKittyThumbnail} belong to the
   * internal consumer interface — the raw read API above is unchanged.
   */
  loadKittyThumbnail(ref: ImageAttachmentRefLike, scope?: unknown): void {
    if (ref.mediaType !== 'image/jpeg' && ref.mediaType !== 'image/webp') return
    const resolved = this.scopeOf(scope)
    const id = ref.attachmentId
    if (
      resolved.kittyThumbnailReady.get(id) !== undefined
      || resolved.kittyThumbnailFailures.has(id)
      || resolved.kittyThumbnailPending.has(id)
    ) return
    const source = resolved.cache.get(id)
    if (source === undefined || source.state !== 'ready') return
    // The real source length, not the metadata preflight (the thumbnail already
    // refused `ref.bytes > 20 MiB` before asking for the read).
    if (source.bytes.byteLength > MAX_KITTY_THUMBNAIL_SOURCE_BYTES) {
      this.recordKittyThumbnailFailure(resolved, id, 'input-too-large')
      return
    }
    if (this.kittyThumbnailQueue.length >= MAX_THUMBNAIL_QUEUE) {
      this.recordKittyThumbnailFailure(resolved, id, 'busy')
      return
    }
    const job: KittyThumbnailJob = { scope: resolved, ref, epoch: this.epochOf(id) }
    resolved.kittyThumbnailPending.set(id, job)
    this.kittyThumbnailQueue.push(job)
    this.pumpKittyThumbnailQueue()
  }

  /** Record one preview failure and wake the EXISTING attachment subscribers.
   * The wake is deferred one microtask because scheduling failures are recorded
   * inside `render()`: the thumbnail's own render cache must finish being
   * written before its subscriber invalidates it. */
  private recordKittyThumbnailFailure(
    scope: LoaderScope,
    id: string,
    reason: KittyThumbnailFailureReason,
    error?: Error,
  ): void {
    scope.kittyThumbnailFailures.delete(id)
    scope.kittyThumbnailFailures.set(id, error === undefined ? { reason } : { reason, error })
    if (scope.kittyThumbnailFailures.size > MAX_THUMBNAIL_FAILURES) {
      const oldest = scope.kittyThumbnailFailures.keys().next().value as string | undefined
      if (oldest !== undefined) scope.kittyThumbnailFailures.delete(oldest)
    }
    queueMicrotask(() => this.notify(scope, id))
  }

  /** Start queued conversions up to the loader-wide concurrency cap. */
  private pumpKittyThumbnailQueue(): void {
    while (
      this.kittyThumbnailActive.size < MAX_THUMBNAIL_CONCURRENCY
      && this.kittyThumbnailQueue.length > 0
    ) {
      const job = this.kittyThumbnailQueue.shift()!
      const task = this.runKittyThumbnail(job).finally(() => {
        this.kittyThumbnailActive.delete(task)
        this.pumpKittyThumbnailQueue()
      })
      this.kittyThumbnailActive.add(task)
    }
  }

  /**
   * Run ONE conversion: re-read the source bytes at START time (the queue holds
   * no bytes), commit only while the captured epoch AND this job's pending slot
   * are current, and drop every stale settle silently. The terminal only hears
   * the captured {@link KittyThumbnailFailureReason}; the native Error stays in
   * the per-scope failure record for diagnostics.
   */
  private async runKittyThumbnail(job: KittyThumbnailJob): Promise<void> {
    // Yield before touching the decoder: a render() call may schedule this job,
    // and `import('sharp')`/libvips loading must NEVER run in the render stack.
    // The concurrency slot is already claimed by the synchronous pump.
    await Promise.resolve()
    const id = job.ref.attachmentId
    let png: KittyThumbnailPng | undefined
    let failure: KittyThumbnailFailure | undefined
    try {
      // The epoch is re-validated at START, not only at enqueue: invalidation
      // between queueing and starting drops the job without touching any state.
      if (!this.epochCurrent(id, job.epoch)) return
      const source = job.scope.cache.get(id)
      if (source === undefined || source.state !== 'ready') {
        // The source read was evicted while this job waited. That is a
        // TRANSIENT cache state, never a decode failure: recording it would
        // make `getKittyThumbnail` return a sticky error and
        // `loadKittyThumbnail` refuse every later request in this scope. The
        // conversion task itself still never re-reads the attachment; the job
        // ends without publishing and the notify in `finally` lets the next
        // VISIBLE render go through the normal raw-read path again.
        return
      }
      if (source.bytes.byteLength > MAX_KITTY_THUMBNAIL_SOURCE_BYTES) {
        failure = { reason: 'input-too-large' }
        return
      }
      try {
        const converted = await this.convertThumbnail(
          source.bytes,
          job.ref.mediaType as 'image/jpeg' | 'image/webp',
        )
        // The cache admission check also covers an injected converter seam
        // (the real decoder enforces the same bound itself).
        failure = converted.byteLength > MAX_KITTY_THUMBNAIL_OUTPUT_BYTES
          ? { reason: 'output-too-large' }
          : undefined
        if (failure === undefined) png = converted
      } catch (error) {
        failure = {
          reason: error instanceof KittyThumbnailOutputTooLargeError ? 'output-too-large' : 'decode-failed',
          error: error instanceof Error ? error : new Error(String(error)),
        }
      }
    } finally {
      const ownsSlot = job.scope.kittyThumbnailPending.get(id) === job
      if (ownsSlot) job.scope.kittyThumbnailPending.delete(id)
      if (ownsSlot && this.epochCurrent(id, job.epoch)) {
        if (png !== undefined) {
          job.scope.kittyThumbnailReady.set(id, png)
          job.scope.kittyThumbnailFailures.delete(id)
          this.notify(job.scope, id)
        } else if (failure !== undefined) {
          this.recordKittyThumbnailFailure(job.scope, id, failure.reason, failure.error)
        } else {
          // Dropped because the source was evicted while queued. Release the
          // slot and wake the occurrence; the normal visible render will read
          // the attachment again and may request a fresh conversion. No
          // persistent failure is recorded, so this is recoverable.
          this.notify(job.scope, id)
        }
      }
    }
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
   * (review finding 3). The SAME per-id generation also retires that
   * attachment's preview cache/error/queued slot: a running conversion may
   * finish, but it can no longer publish and a fresh request may schedule
   * again. A retired presentation scope is unreachable and collects with its
   * own state. */
  invalidate(attachmentId: string): void {
    this.perIdEpoch.set(attachmentId, this.epochOf(attachmentId).local + 1)
    for (const scope of this.liveScopesNow()) {
      scope.cache.delete(attachmentId)
      scope.errors.delete(attachmentId)
      scope.kittyThumbnailReady.delete(attachmentId)
      scope.kittyThumbnailFailures.delete(attachmentId)
      scope.kittyThumbnailPending.delete(attachmentId)
    }
    for (let index = this.kittyThumbnailQueue.length - 1; index >= 0; index -= 1) {
      if (this.kittyThumbnailQueue[index]!.ref.attachmentId === attachmentId) {
        this.kittyThumbnailQueue.splice(index, 1)
      }
    }
  }

  /** Drop everything (session switch / dispose): the GLOBAL generation
   * bumps AND the per-id map resets — a pre-clear local invalidation can
   * never mask the global invalidation for a later settle (review
   * finding), and the map cannot grow unboundedly. Every reachable
   * subscriber hears the global invalidation and repaints once. Retired
   * object scopes are dropped by the renderer building a new presentation,
   * not enumerated here. Preview state and queued conversions belong to the
   * same authority and are cleared by the same global epoch: a queued job is
   * discarded (it never notifies a retired component) and a running job's
   * settle is dropped by the generation check. */
  clear(): void {
    this.globalEpoch += 1
    this.perIdEpoch.clear()
    for (const scope of this.liveScopesNow()) {
      scope.cache.clear()
      scope.errors.clear()
      scope.kittyThumbnailReady.clear()
      scope.kittyThumbnailFailures.clear()
      scope.kittyThumbnailPending.clear()
    }
    this.kittyThumbnailQueue.length = 0
    this.notifyAll()
  }

  /** Current cache size of one scope (observability/tests). */
  cacheSize(scope?: unknown): number {
    return this.scopeOf(scope).cache.size()
  }

  /** Current derived-PNG entry count of one scope (observability/tests). */
  kittyThumbnailCacheSize(scope?: unknown): number {
    return this.scopeOf(scope).kittyThumbnailReady.size()
  }

  /** Current derived-PNG base64 resident bytes of one scope (observability/tests). */
  kittyThumbnailCacheBytes(scope?: unknown): number {
    return this.scopeOf(scope).kittyThumbnailReady.bytes()
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
