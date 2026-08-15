/**
 * Bounded accumulation of local-shell output: the UI card only ever holds
 * the TAIL of the stream (byte- and line-capped), so a runaway `yes` or
 * `find /` cannot grow memory without bound — including a stream that never
 * emits a newline (the unterminated tail is capped and UTF-8-safe too).
 * Totals are tracked separately so the card can state exactly how much was
 * received and dropped. A companion {@link createFileCapture} bounds the
 * full-output disk capture the same way, so /tmp cannot be filled either.
 * @module @xmoon76/dsh-pi-tui/bounded-output
 */

import { closeSync, openSync, rmSync, writeSync } from 'node:fs'

/** Default byte cap for the retained tail (~256 KiB of UTF-8). */
export const SHELL_OUTPUT_CAP_BYTES = 256 * 1024
/** Default line cap for the retained tail. */
export const SHELL_OUTPUT_CAP_LINES = 4000
/** Default hard cap for the full-output disk capture (~8 MiB). */
export const SHELL_OUTPUT_DISK_CAP_BYTES = 8 * 1024 * 1024

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

/** The last `maxBytes` of `text` cut at a UTF-8 character boundary. */
export function utf8Tail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  // Slice the tail and skip leading continuation bytes (10xxxxxx), so a
  // multi-byte character cut in half is dropped whole, never mangled.
  const sliced = buffer.subarray(buffer.length - maxBytes)
  let start = 0
  while (start < sliced.length && (sliced[start]! & 0xc0) === 0x80) start += 1
  return sliced.subarray(start).toString('utf8')
}

/**
 * Create a bounded output accumulator. Capping is line-granular: whole
 * lines are dropped from the front once the retained tail exceeds the byte
 * or line cap, so a single gigantic line can still exceed the byte cap
 * (splitting it would corrupt the tail's meaning). The unterminated tail
 * (`pendingPartial`) is bounded the same way: when it alone exceeds the
 * byte cap, every completed line is dropped and the visible tail becomes
 * the UTF-8-safe suffix of the partial — a newline arriving later can never
 * re-introduce the discarded prefix. `totalBytes` counts the UTF-8 bytes of
 * EVERY chunk, including dropped content.
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
  // Incremental byte counts (recomputing from the strings per append would
  // be O(n) per chunk — O(n²) over a stream). The counts include the '\n'
  // SEPARATORS of the visible tail (`tailLines.join('\n')`), so the byte
  // cap is a hard limit on the actual UTF-8 size of `tail`, not just on
  // the line payloads.
  let tailBytesCount = 0
  let partialBytesCount = 0
  const pushTailLine = (line: string): void => {
    tailLines.push(line)
    // The separator before this line exists once a second line is present.
    tailBytesCount += Buffer.byteLength(line, 'utf8') + (tailLines.length > 1 ? 1 : 0)
  }
  const shiftTailLine = (): void => {
    const line = tailLines.shift()!
    // Dropping the first line also drops its following separator when
    // another line remains.
    tailBytesCount -= Buffer.byteLength(line, 'utf8') + (tailLines.length >= 1 ? 1 : 0)
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
          partialBytesCount = 0
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
          partialBytesCount = 0
        }
      } else {
        pendingPartial = pendingPartial === undefined ? last : pendingPartial + last
        partialBytesCount += Buffer.byteLength(last, 'utf8')
        // An unterminated stream must stay bounded too: once the partial
        // alone exceeds the byte cap, the visible tail is its UTF-8-safe
        // suffix and every older completed line is dropped (the partial is
        // newer than all of them). A newline later never brings the
        // discarded prefix back.
        if (partialBytesCount > capBytes) {
          tailLines.length = 0
          tailBytesCount = 0
          pendingPartial = utf8Tail(pendingPartial, capBytes)
          partialBytesCount = Buffer.byteLength(pendingPartial, 'utf8')
          truncated = true
        }
      }
      while ((tailLines.length > capLines || tailBytesCount + partialBytesCount + (pendingPartial !== undefined ? 1 : 0) > capBytes) && tailLines.length > 0) {
        shiftTailLine()
        truncated = true
      }
    },
  }
}

/**
 * A bounded full-output disk capture: writes every chunk to a 0600 temp
 * file until `capBytes` are written, then stops (never fills /tmp). Write
 * failures deactivate the capture and remove the file, so a broken capture
 * is never advertised. {@link close} closes the fd and keeps the file;
 * {@link dispose} deletes the file; both are idempotent.
 */
export interface FileCapture {
  /** The temp file path (may not exist when creation failed). */
  readonly path: string
  /** Whether the capture is live (file open, cap not reached). */
  readonly active: boolean
  /** Whether the file is present on disk (closed and capped files keep it). */
  readonly exists: boolean
  /** Whether the disk cap was reached (file holds the first capBytes). */
  readonly truncated: boolean
  /** Append raw bytes; no-op when inactive. */
  append(chunk: Buffer): void
  /** Close the file (keeps it). */
  close(): void
  /** Close and delete the file; idempotent. */
  dispose(): void
}

/**
 * Create the bounded full-output capture. On open failure the capture is
 * inactive and nothing exists (append/close/dispose are safe no-ops) —
 * callers must check {@link FileCapture.exists} before advertising the path.
 * @param path - the temp file path.
 * @param capBytes - hard disk cap; 0 or negative disables the cap.
 */
export function createFileCapture(path: string, capBytes: number = SHELL_OUTPUT_DISK_CAP_BYTES): FileCapture {
  let fd: number | undefined
  let active = false
  let fileExists = false
  let truncated = false
  let written = 0
  try {
    fd = openSync(path, 'w', 0o600)
    active = true
    fileExists = true
  } catch {
    fd = undefined
  }
  const closeFd = (): void => {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Best effort.
      }
      fd = undefined
    }
  }
  return {
    path,
    get active() {
      return active
    },
    get exists() {
      return fileExists
    },
    get truncated() {
      return truncated
    },
    append(chunk: Buffer): void {
      if (fd === undefined || !active) return
      try {
        if (capBytes > 0 && written + chunk.length > capBytes) {
          const remaining = capBytes - written
          if (remaining > 0) writeSync(fd, chunk.subarray(0, remaining))
          written = capBytes
          truncated = true
          closeFd()
          active = false
          return
        }
        writeSync(fd, chunk)
        written += chunk.length
      } catch {
        // A failed write must not take the run down: drop the capture and
        // remove the (possibly partial) file so it is never advertised.
        active = false
        fileExists = false
        closeFd()
        try {
          rmSync(path, { force: true })
        } catch {
          // Best effort.
        }
      }
    },
    close(): void {
      active = false
      closeFd()
    },
    dispose(): void {
      active = false
      fileExists = false
      closeFd()
      try {
        rmSync(path, { force: true })
      } catch {
        // Best effort.
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
