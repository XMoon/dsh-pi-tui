/**
 * @xmoon76/dsh-pi-tui/scripts/repair-core — pure session-log repair logic.
 *
 * dsh persists one session as a JSONL artifact where every event's `seq`
 * must equal its position (`event.seq === index`), wrapped in concatenated
 * Zstandard frames (one frame per write-behind flush). Two dsh processes
 * writing one session concurrently can mint the same seq (each numbers from
 * its own in-memory log length), which makes the artifact unreadable —
 * `SessionLogScanner` throws `corrupt session log: seq gap in committed
 * region`. This module repairs such logs:
 *
 * - duplicate seq (`got < expected`) — renumbers every event from the first
 *   collision onward so `seq === index` again, remapping cross-references
 *   (`sourceEventSeqs`, `messageSeqs`, `sourceEventSeq`) through the
 *   old→new mapping;
 * - missing seq / unparsable row (`got > expected` or unparsable JSON) —
 *   truncates at the first broken event (the missing events cannot be
 *   recreated) and reports the loss;
 * - wrong frame layout (first frame is not exactly the header line, e.g. a
 *   whole-log single frame) — re-frames the log into the dsh layout:
 *   header line alone in the first frame, then one frame per line;
 * - otherwise — no-op.
 *
 * The chunk packing rows (`*-chunks` with `seq0`) are expanded by
 * `decodeStorageRecord` on read; the repaired log writes one event per line
 * (no packing), which the same reader accepts.
 *
 * The decoder (`decodeStorageRecord`) and encoder (`packChunkRuns`) come
 * from the installed dsh (`@deepseek-ai/dsh-session`) and are injected so
 * the logic stays testable. The frame walker is vendored from
 * `dsh-session-persistence-jsonl` (upstream commit 0ba0dcbd4d39) so the
 * script needs no runtime import for it.
 * @module repair-core
 */

import { constants } from 'node:zlib'

/** Zstandard frame magic, little-endian (`\x28\xB5\x2F\xFD`). */
export const ZSTD_MAGIC = 0xfd2fb528

/**
 * Compress with the same content-checksum flag the harness writer uses
 * (`dsh-session-persistence-jsonl`'s `compressZstdFrame` passes
 * `ZSTD_c_checksumFlag: 1`).
 */
const CHECKSUMMED_OPTIONS = {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
}

/**
 * Walk concatenated Zstandard frames and return each frame's byte range.
 * Vendored from `dsh-session-persistence-jsonl/lib/index.js`
 * (`scanZstdFrames`): parses the frame header (content-size flags) and block
 * headers to find frame boundaries without trusting content sizes.
 * @param buffer - the raw artifact bytes.
 * @returns `{ frames, tornStart }` — `tornStart` when the tail is truncated.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Decompress a complete concatenated-frame artifact into its JSONL text.
 * @param buffer - raw artifact bytes.
 * @param zstdDecompressSync - `node:zlib` zstd decompressor (one frame per call).
 * @returns `{ text, frames }`.
 */
export function decompressFrames(buffer, zstdDecompressSync) {
  const { frames } = scanZstdFrames(buffer)
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
  const parts = []
  for (const frame of frames) {
    parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: frames.length }
}

/**
 * Validate the frame layout the dsh reader requires: the first frame must
 * decompress to EXACTLY one newline-terminated header line (the harness's
 * `assertZstdHeaderFrame`). The harness appends ONE zstd frame per flush
 * batch, so a whole-log single-frame artifact is structurally valid zstd but
 * rejected by dsh (`corrupt Zstandard session log: first frame is not
 * exactly one header line`) — `session.list`, `load`, and `readFrom` all
 * fail on it.
 * @param buffer - raw artifact bytes.
 * @param zstdDecompressSync - `node:zlib` zstd decompressor (one frame per call).
 * @returns `{ ok: true }` or `{ ok: false, issue }`.
 */
export function scanZstdLayout(buffer, zstdDecompressSync) {
  const { frames } = scanZstdFrames(buffer)
  if (frames.length === 0) return { ok: false, issue: 'empty or header-less Zstandard session log' }
  let plaintext
  try {
    plaintext = zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end))
  } catch (error) {
    return { ok: false, issue: `corrupt Zstandard session log: header frame failed validation (${error instanceof Error ? error.message : String(error)})` }
  }
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
    return { ok: false, issue: 'corrupt Zstandard session log: first frame is not exactly one header line' }
  }
  return { ok: true }
}

/**
 * Compress a repaired log in the dsh frame layout: the header line alone in
 * the first frame, then the remaining lines chunked into ~16 KiB plaintext
 * frames. The harness reader requires the first frame to decode to exactly
 * one header line, and appends one frame per flush batch; writing the whole
 * log as one frame is the layout bug that made repaired logs unreadable.
 * Chunking keeps the file near its original size (one frame per event
 * balloons ~10x from per-frame zstd overhead) while keeping torn-tail
 * recovery at sub-KiB-of-events granularity.
 */
export function compressLog(text, zstdCompressSync) {
  const lines = text.split('\n')
  const frames = []
  // Frame one: exactly the header line (the reader's assertZstdHeaderFrame).
  if (lines.length > 0 && lines[0] !== '') {
    frames.push(zstdCompressSync(Buffer.from(`${lines[0]}\n`, 'utf8'), CHECKSUMMED_OPTIONS))
  }
  let chunk = []
  let chunkBytes = 0
  const flushChunk = () => {
    if (chunk.length === 0) return
    frames.push(zstdCompressSync(Buffer.from(`${chunk.join('\n')}\n`, 'utf8'), CHECKSUMMED_OPTIONS))
    chunk = []
    chunkBytes = 0
  }
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '' && index === lines.length - 1) continue // trailing newline of the last record
    chunk.push(line)
    chunkBytes += line.length + 1
    if (chunkBytes >= 16 * 1024) flushChunk()
  }
  flushChunk()
  return frames.length > 0 ? Buffer.concat(frames) : zstdCompressSync(Buffer.alloc(0), CHECKSUMMED_OPTIONS)
}

/**
 * Scan a JSONL session text with the storage-format reader semantics:
 * header on line 0, every following line decodes (possibly expanding packed
 * chunk rows) into events that must be contiguous (`event.seq === index`).
 * Unlike the real scanner, ALL events are retained (renumber repair needs
 * the tail) and every row is examined; the FIRST issue is reported.
 * @param text - decompressed JSONL session text.
 * @param decodeStorageRecord - `@deepseek-ai/dsh-session` row decoder.
 * @returns `{ header, events, issue }`.
 */
export function scanEvents(text, decodeStorageRecord) {
  const lines = text.split('\n')
  const header = lines[0] ?? ''
  const events = []
  let issue
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex]
    if (raw === '') continue
    let decoded
    try {
      decoded = decodeStorageRecord(JSON.parse(raw))
    } catch {
      issue ??= {
        kind: 'unparsable',
        index: events.length,
        line: lineIndex + 1,
        message: `corrupt session log: unparsable committed event at line ${lineIndex + 1}`,
      }
      continue
    }
    for (const event of decoded) {
      if (event.seq !== events.length) {
        issue ??= {
          kind: event.seq < events.length ? 'duplicate' : 'gap',
          index: events.length,
          line: lineIndex + 1,
          expected: events.length,
          got: event.seq,
          message: `corrupt session log: seq gap in committed region at line ${lineIndex + 1} (expected ${events.length}, got ${event.seq})`,
        }
      }
      events.push(event)
    }
  }
  return { header, events, issue }
}

/** Keys whose array values are seq references in event `data`. */
const SEQ_REF_ARRAY_KEYS = new Set(['sourceEventSeqs', 'messageSeqs'])

/**
 * Remap seq cross-references inside one event's `data` through the
 * old→new mapping. Only values `>= threshold` are remapped: everything
 * below the first collision is a pre-collision event whose seq is
 * unchanged. Returns the number of remapped references.
 */
function remapReferences(event, threshold, map) {
  let changed = 0
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    for (const key of Object.keys(node)) {
      const value = node[key]
      if (SEQ_REF_ARRAY_KEYS.has(key) && Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
          const ref = value[i]
          if (typeof ref === 'number' && ref >= threshold && map.has(ref)) {
            value[i] = map.get(ref)
            changed += 1
          }
        }
      } else if (key === 'sourceEventSeq' && typeof value === 'number' && value >= threshold && map.has(value)) {
        node[key] = map.get(value)
        changed += 1
      } else {
        walk(value)
      }
    }
  }
  walk(event.data)
  return changed
}

/**
 * Repair the scanned log. Mutates the events array's `seq` fields and the
 * reference fields it remaps.
 * @param events - events from {@link scanEvents}.
 * @param issue - the first issue from {@link scanEvents}, if any.
 * @returns the action taken, the renumber delta, and counts.
 */
export function repairEvents(events, issue) {
  if (issue === undefined) {
    return { events, action: 'none', fromIndex: -1, delta: 0, changed: 0, refsChanged: 0 }
  }
  if (issue.kind !== 'duplicate') {
    const kept = events.slice(0, issue.index)
    return {
      events: kept,
      action: 'truncate',
      fromIndex: issue.index,
      delta: 0,
      changed: events.length - kept.length,
      refsChanged: 0,
      message: issue.message,
    }
  }
  // Duplicate seq: renumber every event from the first collision onward so
  // `seq === index` again. The old→new map resolves cross-references: values
  // below the collision index name pre-collision events (unchanged); values
  // at or above it can only name post-collision events (renumbered).
  const repaired = events
  const map = new Map()
  for (let index = issue.index; index < repaired.length; index += 1) {
    const event = repaired[index]
    map.set(event.seq, index)
    event.seq = index
  }
  let refsChanged = 0
  for (const event of repaired) {
    refsChanged += remapReferences(event, issue.index, map)
  }
  return {
    events: repaired,
    action: 'renumber',
    fromIndex: issue.index,
    delta: issue.index - issue.got,
    changed: repaired.length - issue.index,
    refsChanged,
    message: issue.message,
  }
}

/**
 * Encode the repaired log: the original header line verbatim, then one JSON
 * row per event (packed chunk rows are expanded — the standard reader
 * accepts unpacked rows).
 */
export function encodeLog(header, events) {
  const lines = [header]
  for (const event of events) lines.push(JSON.stringify(event))
  return `${lines.join('\n')}\n`
}
