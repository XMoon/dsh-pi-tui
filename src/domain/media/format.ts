/**
 * Human byte-size formatting for media limit messages (1024-based).
 * @module @xmoon76/dsh-pi-tui/domain/media/format
 */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
