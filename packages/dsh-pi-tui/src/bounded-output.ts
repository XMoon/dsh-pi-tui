/**
 * Bounded accumulation of local-shell output: the UI card only ever holds
 * the TAIL of the stream (byte- and line-capped), so a runaway `yes` or
 * `find /` cannot grow memory without bound. Totals are tracked separately
 * so the card can state exactly how much was received and dropped.
 * @module @xmoon76/dsh-pi-tui/bounded-output
 */

/** Default byte cap for the retained tail (~256 KiB of UTF-8). */
export const SHELL_OUTPUT_CAP_BYTES = 256 * 1024
/** Default line cap for the retained tail. */
export const SHELL_OUTPUT_CAP_LINES = 4000

export interface BoundedOutput {
  /** The retained tail text (line- and byte-capped). */
  readonly tail: string
  /** Total bytes received (UTF-8), before any cap. */
  readonly totalBytes: number
  /** Total lines received. */
  readonly totalLines: number
  /** Whether any content was dropped to enforce the caps. */
  readonly truncated: boolean
  /** Append a chunk; drops whole leading lines once a cap is exceeded. */
  append(chunk: string): void
}

/**
 * Create a bounded output accumulator. Capping is line-granular: whole
 * lines are dropped from the front once the retained tail exceeds the byte
 * or line cap, so a single gigantic line can still exceed the byte cap
 * (splitting it would corrupt the tail's meaning). `totalBytes` counts the
 * UTF-8 bytes of EVERY chunk, including dropped content.
 */
export function createBoundedOutput(
  capBytes: number = SHELL_OUTPUT_CAP_BYTES,
  capLines: number = SHELL_OUTPUT_CAP_LINES,
): BoundedOutput {
  const tailLines: string[] = []
  let totalBytes = 0
  let totalLines = 0
  let truncated = false
  /** A line whose terminating newline has not arrived yet (spans chunks). */
  let pendingPartial: string | undefined
  // Incremental byte count of the retained tail: recomputing it from
  // `tailLines` on every append is O(n) per chunk (O(n²) over a stream),
  // and the cap check runs once per dropped line.
  let tailBytesCount = 0
  const pushTailLine = (line: string): void => {
    tailLines.push(line)
    tailBytesCount += Buffer.byteLength(line, 'utf8')
  }
  const shiftTailLine = (): void => {
    tailBytesCount -= Buffer.byteLength(tailLines.shift()!, 'utf8')
  }
  return {
    get tail() {
      // The pending partial (a line whose newline has not arrived) is part
      // of the visible tail even though it is not counted as a line yet.
      return pendingPartial === undefined ? tailLines.join('\n') : [...tailLines, pendingPartial].join('\n')
    },
    get totalBytes() {
      return totalBytes
    },
    get totalLines() {
      return totalLines
    },
    get truncated() {
      return truncated
    },
    append(chunk: string): void {
      if (chunk === '') return
      totalBytes += Buffer.byteLength(chunk, 'utf8')
      const parts = chunk.split('\n')
      // Every part except the last is a newline-terminated line; the last
      // part is '' when the chunk ends with a newline, otherwise a partial
      // line that may continue across chunks.
      for (let index = 0; index < parts.length - 1; index += 1) {
        if (pendingPartial !== undefined) {
          pushTailLine(pendingPartial + parts[index]!)
          pendingPartial = undefined
        } else {
          pushTailLine(parts[index]!)
        }
        totalLines += 1
      }
      const last = parts[parts.length - 1]!
      if (chunk.endsWith('\n')) {
        // A bare trailing newline completes a pending partial as its own
        // line; otherwise the trailing '' is just the end-of-line marker.
        if (pendingPartial !== undefined) {
          pushTailLine(pendingPartial)
          totalLines += 1
          pendingPartial = undefined
        }
      } else {
        pendingPartial = pendingPartial === undefined ? last : pendingPartial + last
      }
      while ((tailLines.length > capLines || tailBytesCount > capBytes) && tailLines.length > 0) {
        shiftTailLine()
        truncated = true
      }
    },
  }
}

/** Human-readable byte count (e.g. `256.0 KiB`, `12.3 MiB`). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
