/**
 * The short-lived, Client-local SVG raster cache.
 *
 * One entry per admitted source digest: the PNG is a DISPLAY derivative, never
 * a durable fact. The loader dedupes concurrent requests, drops settled results
 * after a `clear()` (session swap / renderer retirement), and notifies the
 * mounted component so a repaint can replace the placeholder. A failed raster
 * keeps the text path; it never retries the same digest in the same epoch.
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
  state: SvgRasterState
  controller?: AbortController
}

/** Keep at most this many ready/error entries (oldest evicted first). */
const MAX_ENTRIES = 12

/** The async raster cache with per-source dedupe and a global epoch fence. */
export class SvgRasterLoader {
  private readonly rasterize: SvgRasterize
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private epoch = 0

  constructor(rasterize: SvgRasterize) {
    this.rasterize = rasterize
  }

  /** The current display state; a render call never awaits. */
  get(digest: string): SvgRasterState {
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
   * Fire one raster request for a digest that has no state yet. The caller
   * (the component) owns the source; the loader only stores the derivative.
   * @param digest - the admitted source digest (the cache identity).
   * @param source - the admitted SVG text.
   * @param targetWidth - the requested raster width in pixels.
   */
  load(digest: string, source: string, targetWidth: number): void {
    if (this.entries.has(digest)) return
    const controller = new AbortController()
    const epoch = this.epoch
    this.entries.set(digest, { state: { state: 'loading' }, controller })
    this.evict()
    this.rasterize(source, { targetWidth, signal: controller.signal }).then(result => {
      if (epoch !== this.epoch) return
      this.entries.set(digest, {
        state: { state: 'ready', base64: result.base64, widthPx: result.widthPx, heightPx: result.heightPx },
      })
      this.notify(digest)
    }, (error: unknown) => {
      if (epoch !== this.epoch) return
      this.entries.set(digest, {
        state: { state: 'error', error: error instanceof Error ? error : new Error(String(error)) },
      })
      this.notify(digest)
    })
  }

  /** Drop every entry and abort in-flight children (session/theme epoch swap). */
  clear(): void {
    this.epoch += 1
    for (const entry of this.entries.values()) entry.controller?.abort()
    this.entries.clear()
  }

  /** Release every subscription and in-flight child (renderer retirement). */
  dispose(): void {
    this.clear()
    this.listeners.clear()
  }

  private notify(digest: string): void {
    for (const listener of this.listeners.get(digest) ?? []) listener()
  }

  private evict(): void {
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) return
      const entry = this.entries.get(oldest)
      entry?.controller?.abort()
      this.entries.delete(oldest)
    }
  }
}
