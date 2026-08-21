/**
 * Invalidation batching: many `handle.invalidate()` calls in one tick
 * coalesce into ONE render request on the active screen (the fork's render
 * pipeline is per-frame; a burst of invalidates must not schedule a frame
 * per call).
 *
 * The batch is flushed on a microtask: `invalidate()` during a synchronous
 * render pass (e.g. a contribution's own render) joins the SAME batch as
 * the calls that preceded it, so a full repaint pass produces at most one
 * extra frame request.
 * @module @xmoon76/dsh-pi-tui/extension/batcher
 */

export interface RenderRequestSink {
  /** Request one render of the active screen (coalesced by the caller). */
  requestRender(force?: boolean): void
}

/** Coalescing invalidate dispatcher. `flush()` is idempotent per tick. */
export class InvalidateBatcher {
  private readonly sink: RenderRequestSink
  private scheduled = false
  private forced = false

  constructor(sink: RenderRequestSink) {
    this.sink = sink
  }

  /** Coalesce one invalidation into the pending batch. */
  invalidate(force = false): void {
    if (force) this.forced = true
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      const forced = this.forced
      this.forced = false
      if (forced) {
        this.sink.requestRender(true)
      } else {
        this.sink.requestRender()
      }
    })
  }

  /** Whether a batch is currently pending (test hook). */
  isPending(): boolean {
    return this.scheduled
  }
}
