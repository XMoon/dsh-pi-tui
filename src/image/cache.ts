/**
 * Bounded image cache for durable attachment bytes (plan M8, §16.2).
 *
 * Keys are attachment ids; entries hold the decoded bytes AND the base64
 * form (the pi-tui `Image` component consumes base64). The base64 expansion
 * (~33%) counts toward the byte budget. A fixed entry cap + a byte cap keep
 * a long transcript from pinning unbounded memory; eviction is LRU.
 * @module @xmoon76/dsh-pi-tui/image/cache
 */

/** One cached image payload (ready) or failure (error). */
export type CacheEntry =
  | { readonly state: 'ready'; readonly bytes: Uint8Array; readonly base64: string; readonly byteLength: number }
  | { readonly state: 'error'; readonly error: Error }

/** Bounded LRU image cache. */
export class ImageCache {
  private readonly entries = new Map<string, CacheEntry>()
  private bytesHeld = 0
  private readonly maxEntries: number
  private readonly maxBytes: number

  constructor(maxEntries = 32, maxBytes = 64 * 1024 * 1024) {
    // Explicit fields: Node strip-only mode rejects parameter properties.
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
  }

  /** The cached entry for an attachment id, or undefined. */
  get(attachmentId: string): CacheEntry | undefined {
    const entry = this.entries.get(attachmentId)
    if (entry === undefined) return undefined
    // LRU refresh: re-insert so the entry moves to the newest slot.
    this.entries.delete(attachmentId)
    this.entries.set(attachmentId, entry)
    return entry
  }

  /** Store one entry, evicting least-recently-used entries past the caps. */
  set(attachmentId: string, entry: CacheEntry): void {
    const existing = this.entries.get(attachmentId)
    if (existing !== undefined) this.bytesHeld -= entryBytes(existing)
    this.entries.delete(attachmentId)
    this.entries.set(attachmentId, entry)
    this.bytesHeld += entryBytes(entry)
    this.evict()
  }

  /** Whether the cache holds a ready entry for an attachment id. */
  has(attachmentId: string): boolean {
    return this.entries.has(attachmentId)
  }

  /** Drop one attachment (transcript trim / explicit invalidation). */
  delete(attachmentId: string): void {
    const entry = this.entries.get(attachmentId)
    if (entry !== undefined) {
      this.bytesHeld -= entryBytes(entry)
      this.entries.delete(attachmentId)
    }
  }

  /** Drop everything (session switch / TUI dispose). */
  clear(): void {
    this.entries.clear()
    this.bytesHeld = 0
  }

  /** Current entry count (observability/tests). */
  size(): number {
    return this.entries.size
  }

  /** Current held bytes (observability/tests). */
  bytes(): number {
    return this.bytesHeld
  }

  /** Enforce the caps from the NEWEST slot backwards. */
  private evict(): void {
    while (this.entries.size > this.maxEntries || this.bytesHeld > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) return
      const entry = this.entries.get(oldest)
      if (entry !== undefined) this.bytesHeld -= entryBytes(entry)
      this.entries.delete(oldest)
    }
  }
}

function entryBytes(entry: CacheEntry): number {
  return entry.state === 'ready' ? entry.byteLength + Math.ceil(entry.byteLength * 1.33) : 0
}
