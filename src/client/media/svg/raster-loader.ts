/**
 * The short-lived, Client-local SVG raster cache.
 *
 * One entry per admitted source digest: the PNG is a DISPLAY derivative, never
 * a durable fact. The loader owns a SINGLE global worker lane — different
 * digests never spawn native children concurrently — and dedupes a repeated
 * digest. A settlement commits only for the exact entry/epoch that produced it,
 * so an evicted or replaced request can never resurrect a cache entry or
 * overwrite a newer request. A failed raster keeps the text path; it is not
 * retried in the same epoch.
 * @module @xmoon76/dsh-pi-tui/client/media/svg/raster-loader
 */

import type { SvgRasterize } from './rasterize.ts'

/** One source's display state as a render component sees it. */
export type SvgRasterState =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly base64: string; readonly widthPx: number; readonly heightPx: number }
  | { readonly state: 'error'; readonly error: Error }

interface Entry {
  readonly controller: AbortController
  readonly state: SvgRasterState
}

interface Queued {
  readonly digest: string
  readonly source: string
  readonly targetWidth: number
  readonly entry: Entry
}

/** Keep at most this many entries (oldest evicted first). */
const MAX_ENTRIES = 12
/** Keep the terminal eviction explanation bounded as the session grows. */
const MAX_EVICTED = 64

/** The async raster cache with one global worker lane and an epoch fence. */
export class SvgRasterLoader {
  private readonly rasterize: SvgRasterize
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly queue: Queued[] = []
  /** Digests whose live entries were evicted: a terminal, non-retrying state. */
  private readonly evicted = new Set<string>()
  private active: Queued | undefined
  private epoch = 0

  constructor(rasterize: SvgRasterize) {
    this.rasterize = rasterize
  }

  /** The current display state; a render call never awaits. */
  get(digest: string): SvgRasterState {
    if (this.evicted.has(digest)) {
      return { state: 'error', error: new Error('the SVG image was evicted from the display cache') }
    }
    return this.entries.get(digest)?.state ?? { state: 'idle' }
  }

  /** Subscribe to one digest's settles; returns an idempotent unsubscribe. */
  subscribe(digest: string, listener: () => void): () => void {
    const existing = this.listeners.get(digest)
    if (existing !== undefined) {
      existing.add(listener)
    } else {
      this.listeners.set(digest, new Set([listener]))
    }
    return () => {
      const listeners = this.listeners.get(digest)
      if (listeners === undefined) return
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(digest)
    }
  }

  /**
   * Queue one raster request for a digest that has no state yet. The caller
   * (the component) owns the source; the loader only stores the derivative.
   * @param digest - the admitted source digest (the cache identity).
   * @param source - the admitted SVG text.
   * @param targetWidth - the requested raster width in pixels.
   */
  load(digest: string, source: string, targetWidth: number): void {
    // An evicted digest is terminal for this epoch; re-requesting it would
    // immediately evict another visible image and thrash the cache.
    if (this.evicted.has(digest) || this.entries.has(digest)) return
    const entry: Entry = { controller: new AbortController(), state: { state: 'loading' } }
    this.entries.set(digest, entry)
    this.queue.push({ digest, source, targetWidth, entry })
    this.evict()
    this.pump()
  }

  /** Drop every entry and abort the active/queued children (session epoch swap). */
  clear(): void {
    this.epoch += 1
    // The active lane stays claimed until its rasterizer promise settles (the
    // real child closes). A new load after clear must queue behind it, never
    // start a second native child early.
    this.active?.entry.controller.abort()
    for (const item of this.queue) item.entry.controller.abort()
    this.queue.length = 0
    this.entries.clear()
    this.evicted.clear()
  }

  /** Release every subscription and in-flight child (renderer retirement). */
  dispose(): void {
    this.clear()
    this.listeners.clear()
  }

  /** Start the next queued request; the loader never runs two at once. */
  private pump(): void {
    if (this.active !== undefined) return
    while (this.queue.length > 0) {
      const next = this.queue.shift() as Queued
      // A queued entry may have been evicted or cleared while waiting.
      if (this.entries.get(next.digest) !== next.entry) {
        next.entry.controller.abort()
        continue
      }
      this.active = next
      const epoch = this.epoch
      this.rasterize(next.source, { targetWidth: next.targetWidth, signal: next.entry.controller.signal }).then((result) => {
        this.settle(next, epoch, {
          state: 'ready', base64: result.base64, widthPx: result.widthPx, heightPx: result.heightPx,
        })
      }, (error: unknown) => {
        this.settle(next, epoch, {
          state: 'error', error: error instanceof Error ? error : new Error(String(error)),
        })
      })
      return
    }
  }

  /** Commit only the exact request that produced this result. */
  private settle(request: Queued, epoch: number, state: SvgRasterState): void {
    if (this.active === request) this.active = undefined
    if (epoch === this.epoch && this.entries.get(request.digest) === request.entry) {
      this.entries.set(request.digest, { controller: request.entry.controller, state })
      this.notify(request.digest)
    }
    this.pump()
  }

  private notify(digest: string): void {
    for (const listener of this.listeners.get(digest) ?? []) listener()
  }

  private evict(): void {
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) return
      const entry = this.entries.get(oldest)
      this.entries.delete(oldest)
      // The component subscribed to this digest must leave the loading line:
      // publish a terminal eviction state and notify exactly once. A ready
      // thumbnail keeps its own last image (SvgThumbnail.lastReady), so this
      // notification cannot trigger a re-request storm.
      this.evicted.add(oldest)
      if (this.evicted.size > MAX_EVICTED) {
        const first = this.evicted.values().next().value
        if (first !== undefined) this.evicted.delete(first)
      }
      entry?.controller.abort()
      this.notify(oldest)
      if (this.active?.digest === oldest) {
        // The active settle sees the entry-identity mismatch and drops it;
        // pump() starts the next queued request after that abort settles.
        continue
      }
      const index = this.queue.findIndex(item => item.digest === oldest)
      if (index >= 0) this.queue.splice(index, 1)
    }
  }
}
