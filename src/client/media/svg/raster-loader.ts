/**
 * The short-lived, Client-local SVG raster cache.
 *
 * One entry per admitted `(source digest, exact target width)` variant: the PNG
 * is a DISPLAY derivative, never a durable fact. The viewer's high-resolution
 * preview and the transcript thumbnail of the same SVG are DIFFERENT display
 * derivatives — a digest-only key would wrongly hand the thumbnail's small PNG
 * to the viewer as "already rendered", so the width is part of the cache
 * identity. A repeated request for the SAME variant is still deduped.
 *
 * The loader owns a SINGLE global worker lane — different digests or widths
 * never spawn native children concurrently — and a settlement commits only for
 * the exact entry/epoch that produced it, so an evicted or replaced request can
 * never resurrect a cache entry or overwrite a newer request. A failed raster
 * keeps the text path; it is not retried in the same epoch.
 *
 * `releaseUnused(digest, targetWidth)` lets the viewer cancel the exact variant
 * it no longer displays without touching a thumbnail variant other components
 * still watch; a cancelled active request keeps the lane claimed until the
 * isolated child really closes.
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
  readonly key: string
  readonly digest: string
  readonly source: string
  readonly targetWidth: number
  readonly entry: Entry
}

/** Keep at most this many variants across every SVG (oldest evicted first). */
const MAX_ENTRIES = 12

/** The cache/listener identity of one display derivative. */
function variantKey(digest: string, targetWidth: number): string {
  return `${digest}:${Math.max(1, Math.floor(targetWidth))}`
}

/** The async raster cache with one global worker lane and an epoch fence. */
export class SvgRasterLoader {
  private readonly rasterize: SvgRasterize
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly queue: Queued[] = []
  /**
   * Variants whose live subscribers saw their entry evicted: a terminal,
   * non-retrying state. This is NOT a cache-history list: an entry is added
   * only while a component is still subscribed, and the last unsubscribe
   * forgets it. Its size is therefore bounded by the live transcript/viewer
   * demand, not by an arbitrary capacity constant or the whole session history.
   */
  private readonly terminalEvictions = new Set<string>()
  private active: Queued | undefined
  private epoch = 0

  constructor(rasterize: SvgRasterize) {
    this.rasterize = rasterize
  }

  /** The current display state of one variant; a render call never awaits. */
  get(digest: string, targetWidth: number): SvgRasterState {
    const key = variantKey(digest, targetWidth)
    if (this.terminalEvictions.has(key)) {
      return { state: 'error', error: new Error('the SVG image was evicted from the display cache') }
    }
    return this.entries.get(key)?.state ?? { state: 'idle' }
  }

  /** Subscribe to one variant's settles; returns an idempotent unsubscribe. */
  subscribe(digest: string, targetWidth: number, listener: () => void): () => void {
    const key = variantKey(digest, targetWidth)
    const existing = this.listeners.get(key)
    if (existing !== undefined) {
      existing.add(listener)
    } else {
      this.listeners.set(key, new Set([listener]))
    }
    return () => {
      const listeners = this.listeners.get(key)
      if (listeners === undefined) return
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.listeners.delete(key)
        // No live demand remains for this variant: its terminal eviction state
        // is cache history now, not a user-visible obligation.
        this.terminalEvictions.delete(key)
      }
    }
  }

  /**
   * Queue one raster request for a variant that has no state yet. The caller
   * (the component) owns the source; the loader only stores the derivative.
   * @param digest - the admitted source digest.
   * @param source - the admitted SVG text.
   * @param targetWidth - the requested raster width in pixels.
   */
  load(digest: string, source: string, targetWidth: number): void {
    const width = Math.max(1, Math.floor(targetWidth))
    const key = variantKey(digest, width)
    // A live demand that saw its entry evicted is terminal for this epoch;
    // re-requesting it would immediately evict another visible image and
    // thrash the cache. Once its last subscriber leaves, the terminal state is
    // forgotten and a fresh demand may load again.
    if (this.terminalEvictions.has(key) || this.entries.has(key)) return
    const entry: Entry = { controller: new AbortController(), state: { state: 'loading' } }
    this.entries.set(key, entry)
    this.queue.push({ key, digest, source, targetWidth: width, entry })
    this.evict()
    this.pump()
  }

  /**
   * Cancel the exact variant this viewer no longer displays, but ONLY when it
   * has no live subscriber left. A thumbnail variant still watched by a Tool
   * card or another Assistant row is untouched; a shared-width variant is
   * therefore never dropped by one viewer's close. The active lane keeps its
   * claim until the child really closes, so the next request never runs a
   * second native process alongside it.
   * @param digest - the admitted source digest.
   * @param targetWidth - the exact variant width.
   */
  releaseUnused(digest: string, targetWidth: number): void {
    const key = variantKey(digest, targetWidth)
    if ((this.listeners.get(key)?.size ?? 0) > 0) return
    if (this.terminalEvictions.has(key)) this.terminalEvictions.delete(key)
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    entry.controller.abort()
    if (this.active?.key === key) {
      // The active settle sees the entry-identity mismatch and drops it;
      // pump() starts the next queued request after the child closes.
      return
    }
    const index = this.queue.findIndex(item => item.key === key)
    if (index >= 0) this.queue.splice(index, 1)
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
    this.terminalEvictions.clear()
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
      // A queued entry may have been evicted, cancelled or cleared while waiting.
      if (this.entries.get(next.key) !== next.entry) {
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
    if (epoch === this.epoch && this.entries.get(request.key) === request.entry) {
      this.entries.set(request.key, { controller: request.entry.controller, state })
      this.notify(request.key)
    }
    this.pump()
  }

  private notify(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener()
  }

  private evict(): void {
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) return
      const entry = this.entries.get(oldest)
      this.entries.delete(oldest)
      // A live subscriber must leave the loading line: publish a terminal
      // eviction state and notify exactly once. This state belongs to the
      // live demand, not to a bounded history: it persists until the last
      // subscriber unsubscribes. A ready thumbnail keeps its own last image
      // (SvgThumbnail.lastReady), so the notification cannot trigger a
      // re-request storm.
      const hasLiveDemand = (this.listeners.get(oldest)?.size ?? 0) > 0
      if (hasLiveDemand) this.terminalEvictions.add(oldest)
      entry?.controller.abort()
      if (hasLiveDemand) this.notify(oldest)
      if (this.active?.key === oldest) {
        // The active settle sees the entry-identity mismatch and drops it;
        // pump() starts the next queued request after that abort settles.
        continue
      }
      const index = this.queue.findIndex(item => item.key === oldest)
      if (index >= 0) this.queue.splice(index, 1)
    }
  }
}
