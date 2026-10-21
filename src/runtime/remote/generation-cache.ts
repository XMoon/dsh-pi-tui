/**
 * `GenerationCache` — the minimal shared cache for an official one-shot Host
 * snapshot (D2.3 v2 §0.4).
 *
 * The plan's warning against "an increasingly complicated cache" means: do not
 * preserve old synchronous Direct-shaped APIs by inventing a private business
 * model. It does NOT prohibit holding the official one-shot snapshot that a
 * synchronous projection needs. This primitive exists only because the model
 * directory and the preset roster genuinely share the same contract:
 *
 * ```text
 * generation-tagged
 * monotonic read epoch (latest read wins publication)
 * invalidate on reconnect / successful mutation
 * values detached on write AND on read (caller mutation can never reach cache)
 * a failed read never destroys a last-good same-generation value
 * a superseded read is never returned as if it were current
 * ```
 *
 * @module @xmoon76/dsh-pi-tui/generation-cache
 */

/** A generation-tagged snapshot cache with a latest-only read epoch. */
export class GenerationCache<T> {
  private value: T | undefined
  private tag: unknown
  private epoch = 0
  private readonly detach: (value: T) => T

  /** @param detach - deep-clone/freeze a value for storage or for a caller. */
  constructor(detach: (value: T) => T) {
    this.detach = detach
  }

  /** Drop the cached value and bump the epoch, so any in-flight read can
   *  neither publish its result nor be served the invalidated value. */
  invalidate(): void {
    this.epoch += 1
    this.value = undefined
    this.tag = undefined
  }

  /** Begin a read; the returned epoch identifies this read's publication
   *  ownership (a newer read or an invalidation supersedes it). */
  beginRead(): number {
    return ++this.epoch
  }

  /** Publish a successfully read value. Returns false when this read was
   *  superseded while it was in flight (the cache is left untouched). */
  publish(epoch: number, tag: unknown, value: T): boolean {
    if (epoch !== this.epoch) return false
    this.value = this.detach(value)
    this.tag = tag
    return true
  }

  /** A detached copy of the last-good value for `tag`, or undefined when the
   *  cache is empty or belongs to another generation. */
  snapshot(tag: unknown): T | undefined {
    if (this.value === undefined || !Object.is(this.tag, tag)) return undefined
    return this.detach(this.value)
  }
}
