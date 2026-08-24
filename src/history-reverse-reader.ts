/**
 * Reverse JSONL batch reader — reads an append-only JSONL file from EOF
 * backwards in fixed-size chunks, yielding complete physical lines newest
 * first. The reader owns ONLY the byte→line direction: query, cwd proof,
 * dedupe, sorting and the global scan budget live in history-search.ts.
 *
 * Contract:
 * - Lines are materialized on 0x0A boundaries over raw bytes; a line may
 *   span any number of chunks (including 256KiB+ rows) and UTF-8 code
 *   points are only decoded after the full physical line is assembled, so
 *   a chunk boundary can never split a code point.
 * - A batch returns at most `maxRows` complete lines; when it stops
 *   mid-line or mid-chunk, `nextCursor` records the exact resume position
 *   (`nextByteEnd`) so the next batch continues without re-reading the
 *   already-covered suffix and without gaps or duplicates.
 * - The cursor is bound to the file revision (size + mtimeMs): a file that
 *   changed while a cursor was held throws {@link ReverseJsonlRevisionError}
 *   instead of blindly reusing a stale byte position.
 * - The first batch snapshots the file size and never reads past it, so a
 *   concurrent append during the scan is naturally excluded.
 * - Abort: the signal is checked before the stat and before every chunk
 *   read; an abort throws an `AbortError`-named error.
 * - A vanished/shrunk file degrades: stat/open/read failures propagate to
 *   the caller (the search source skips the file); a short read (file
 *   truncated between stat and read) stops the scan at the new EOF.
 * @module @xmoon76/dsh-pi-tui/history-reverse-reader
 */

import { open, stat } from 'node:fs/promises'

/** The resume state of a reverse scan, bound to the file revision it was
 * created against. */
export interface ReverseJsonlCursor {
  /** Byte offset where the next batch's read window ENDS (exclusive). */
  nextByteEnd: number
  /** Bytes of the current (incomplete) line already materialized, in file
   * order, starting at `nextByteEnd`. Carried across batches so a line
   * spanning a batch boundary is never re-read or truncated. */
  pending: Buffer
  /** The file revision this cursor was created against. */
  revision: {
    size: number
    mtimeMs: number
  }
}

/** One complete physical line, newest first, with its byte range in the
 * file (the range excludes the trailing `\n`). */
export interface ReverseJsonlLine {
  text: string
  byteStart: number
  byteEnd: number
}

/** One bounded batch of reverse lines plus the resume state. */
export interface ReverseJsonlBatch {
  lines: ReverseJsonlLine[]
  /** Present iff `eof` is false: pass it back to continue the scan. */
  nextCursor?: ReverseJsonlCursor
  /** True when the whole file has been scanned (no more lines exist). */
  eof: boolean
  /** Bytes actually read from disk for this batch. */
  bytesRead: number
}

/** Thrown when a cursor is reused against a file whose revision (size or
 * mtime) changed — the byte position can no longer be trusted. */
export class ReverseJsonlRevisionError extends Error {
  constructor(
    file: string,
    expected: { size: number; mtimeMs: number },
    actual: { size: number; mtimeMs: number },
  ) {
    super(
      `history file changed while a reverse-read cursor was held: ${file} `
      + `(expected size ${expected.size} mtime ${expected.mtimeMs}, `
      + `got size ${actual.size} mtime ${actual.mtimeMs})`,
    )
    this.name = 'ReverseJsonlRevisionError'
  }
}

/** Read options for {@link readJsonlReverseBatch}. */
export interface ReverseJsonlBatchOptions {
  /** Resume state from a previous batch; absent starts a fresh scan from
   * the file's EOF. */
  cursor?: ReverseJsonlCursor
  /** Upper bound of complete lines this batch returns (>= 1). */
  maxRows: number
  /** Fixed read-window size in bytes (>= 1). */
  chunkBytes: number
  signal?: AbortSignal
}

/**
 * Read one bounded batch of complete JSONL lines from the file's tail,
 * newest first. See the module doc for the full contract.
 * @param file - the JSONL history file path.
 */
export async function readJsonlReverseBatch(
  file: string,
  options: ReverseJsonlBatchOptions,
): Promise<ReverseJsonlBatch> {
  const maxRows = Number.isFinite(options.maxRows) ? Math.max(1, Math.floor(options.maxRows)) : 1
  const chunkBytes = Number.isFinite(options.chunkBytes) ? Math.max(1, Math.floor(options.chunkBytes)) : 1
  if (options.signal?.aborted) throw abortError()
  const fileStat = await stat(file)
  if (options.cursor !== undefined) {
    const cursor = options.cursor
    if (cursor.revision.size !== fileStat.size || cursor.revision.mtimeMs !== fileStat.mtimeMs) {
      throw new ReverseJsonlRevisionError(
        file,
        cursor.revision,
        { size: fileStat.size, mtimeMs: fileStat.mtimeMs },
      )
    }
  }
  const revision = { size: fileStat.size, mtimeMs: fileStat.mtimeMs }
  // The scan boundary: the first batch snapshots the size and only ever
  // moves backwards, so appends during the scan are naturally excluded.
  let position = options.cursor !== undefined ? options.cursor.nextByteEnd : fileStat.size
  // Bytes of the current (incomplete) line already materialized, in file
  // order; `pendingStart` is its first byte's file offset. A cursor may
  // carry pending bytes from a previous batch (they start at
  // `cursor.nextByteEnd` and are never re-read).
  let pending = options.cursor?.pending ?? Buffer.alloc(0)
  let pendingStart = options.cursor?.nextByteEnd ?? 0
  // Where the next batch's read window must end. Updated on every stop:
  // - mid-line: the pending bytes' START (they ride in the cursor, so the
  //   next window must not re-read them);
  // - mid-chunk at a line boundary: just past the `\n` at the start of the
  //   last emitted line;
  // - chunk boundary: the window start.
  let resumeByteEnd = position
  // A chunk is "done" when every byte of it was consumed (either into
  // emitted lines or into pending). EOF is only true when the file start
  // was reached AND the last chunk was fully consumed AND nothing is
  // pending — a maxRows stop mid-chunk must NOT report EOF.
  let chunkDone = position === 0
  const lines: ReverseJsonlLine[] = []
  let bytesRead = 0
  const handle = await open(file, 'r')
  try {
    while (position > 0 && lines.length < maxRows) {
      if (options.signal?.aborted) throw abortError()
      const windowEnd = position
      const start = Math.max(0, position - chunkBytes)
      const buf = Buffer.allocUnsafe(position - start)
      const { bytesRead: n } = await handle.read(buf, 0, buf.length, start)
      bytesRead += n
      if (n === 0) {
        // The file shrank between stat and read: stop at the new EOF.
        position = 0
        chunkDone = true
        break
      }
      position = start
      chunkDone = false
      const actual = n === buf.length ? buf : buf.subarray(0, n)
      const nl = actual.lastIndexOf(0x0A)
      if (nl === -1) {
        // The whole window is part of the current (incomplete) line.
        pending = Buffer.concat([actual, pending])
        pendingStart = start
        resumeByteEnd = position
        chunkDone = true
        continue
      }
      const tail = actual.subarray(nl + 1)
      if (tail.length > 0 || pending.length > 0) {
        // The line whose head is in this window and whose tail was pending
        // from later windows (or a plain tail line at a chunk boundary).
        lines.push({
          text: Buffer.concat([tail, pending]).toString('utf8'),
          byteStart: start + nl + 1,
          byteEnd: windowEnd + pending.length,
        })
        pending = Buffer.alloc(0)
        resumeByteEnd = start + nl + 1
        if (lines.length >= maxRows) break
      }
      let scan = nl
      while (lines.length < maxRows) {
        if (scan === 0) {
          // The `\n` at index 0 terminates the line whose head lives in the
          // previous window (already held as pending) — nothing before it
          // remains in this window. NOTE: `lastIndexOf(0x0A, -1)` would
          // wrap to the buffer END (negative starts count from the tail),
          // re-scanning the window forever — the explicit guard is the fix.
          pending = Buffer.alloc(0)
          pendingStart = start
          resumeByteEnd = position
          chunkDone = true
          break
        }
        const prev = actual.lastIndexOf(0x0A, scan - 1)
        if (prev === -1) {
          // The bytes before `scan` start a line that continues into the
          // previous window: hold them as pending (they ride in the cursor
          // if the batch stops here).
          pending = Buffer.from(actual.subarray(0, scan))
          pendingStart = start
          resumeByteEnd = position
          chunkDone = true
          break
        }
        lines.push({
          text: actual.toString('utf8', prev + 1, scan),
          byteStart: start + prev + 1,
          byteEnd: start + scan,
        })
        // Resume just past the `\n` at the START of the emitted line
        // (`prev`), so the next window re-finds it as the last `\n` and
        // continues backwards — never re-emitting this line.
        resumeByteEnd = start + prev + 1
        scan = prev
      }
    }
    if (position === 0 && pending.length > 0 && lines.length < maxRows) {
      // The first line of the file (no leading `\n`).
      lines.push({
        text: pending.toString('utf8'),
        byteStart: pendingStart,
        byteEnd: pendingStart + pending.length,
      })
      pending = Buffer.alloc(0)
    }
  } finally {
    await handle.close()
  }
  const eof = position === 0 && pending.length === 0 && chunkDone
  return {
    lines,
    nextCursor: eof ? undefined : { nextByteEnd: resumeByteEnd, pending, revision },
    eof,
    bytesRead,
  }
}

/** An `AbortError`-named error (the search source treats it as cancellation). */
function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}
