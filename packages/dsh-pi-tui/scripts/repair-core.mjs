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
 * Adapted from `dsh-session-persistence-jsonl/lib/index.js`
 * (`scanZstdFrames`): parses the frame header (content-size flags) and block
 * headers to find frame boundaries without trusting content sizes.
 *
 * Divergence from the upstream walker: instead of throwing on an invalid
 * frame, the walk STOPS and reports where the tail became unreadable —
 * `tornStart` when a frame merely ran out of bytes (truncated tail),
 * `garbageStart` when the bytes do not parse as a frame (e.g. random bytes
 * appended after the last complete frame). The complete frames collected
 * before the damage point are always a safe salvageable prefix, which is
 * what the repair path truncates to.
 * @param buffer - the raw artifact bytes.
 * @returns `{ frames, tornStart?, garbageStart? }`.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, garbageStart: start }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return { frames, garbageStart: start }
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
      if (blockType === 3) return { frames, garbageStart: start }
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
 * Lay out the damage diagnosis for a damaged tail, with byte accounting.
 * @param kind - `'torn'` (truncated mid-frame) or `'garbage'` (non-frame bytes).
 * @param offset - byte offset where the damage starts.
 * @param totalBytes - file size.
 * @param completeBytes - bytes of the complete frames before the damage.
 */
function tailIssue(kind, offset, totalBytes, completeBytes) {
  return kind === 'torn'
    ? `corrupt Zstandard session log: torn tail — an incomplete frame starts at byte ${offset} of ${totalBytes}; ${completeBytes} complete byte(s) are salvageable`
    : `corrupt Zstandard session log: trailing garbage — bytes that are not a valid frame start at byte ${offset} of ${totalBytes}; ${completeBytes} complete byte(s) are salvageable`
}

/**
 * Full frame-layout diagnosis of an artifact. Unlike the old boolean
 * `scanZstdLayout`, the status is explicit:
 *
 * - `healthy` — every frame is complete, the first frame decodes to exactly
 *   one header line, and every complete frame ends on a JSONL record
 *   boundary;
 * - `torn-tail` — the tail is truncated or garbage; the complete prefix is
 *   still laid out correctly (when there is any);
 * - `invalid-first-frame` — the first frame does not decode to exactly one
 *   header line (e.g. a whole-log single frame);
 * - `invalid-jsonl-boundary` — a complete frame does not end on a JSONL
 *   record boundary;
 * - `decode-failure` — a complete frame cannot be decompressed;
 * - `empty` — no frames and no damage (zero-length or header-less artifact).
 *
 * The result carries `tornStart`/`garbageStart` offsets plus
 * `totalBytes`/`completeBytes` so `--scan` can report exactly what a repair
 * would keep and drop.
 * @param buffer - raw artifact bytes.
 * @param zstdDecompressSync - `node:zlib` zstd decompressor (one frame per call).
 */
export function scanFrameLayout(buffer, zstdDecompressSync) {
  const totalBytes = buffer.length
  const { frames, tornStart, garbageStart } = scanZstdFrames(buffer)
  const completeBytes = frames.length === 0 ? 0 : frames[frames.length - 1].end
  const damage = tornStart ?? garbageStart
  const damageKind = tornStart !== undefined ? 'torn' : garbageStart !== undefined ? 'garbage' : undefined
  const withDamage = (status, issue) => ({ status, frames, tornStart, garbageStart, totalBytes, completeBytes, issue })

  if (frames.length === 0) {
    if (damage === undefined) return withDamage('empty', 'empty or header-less Zstandard session log')
    return withDamage('torn-tail', tailIssue(damageKind, damage, totalBytes, completeBytes))
  }
  let plaintext
  try {
    plaintext = zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end))
  } catch (error) {
    return withDamage('decode-failure', `corrupt Zstandard session log: header frame failed validation (${error instanceof Error ? error.message : String(error)})`)
  }
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
    return withDamage('invalid-first-frame', 'corrupt Zstandard session log: first frame is not exactly one header line')
  }
  // Every complete frame must end on a JSONL record boundary: the harness
  // appends whole records per flush frame, so a frame ending mid-record
  // means corruption the reader will trip over later.
  for (let index = 1; index < frames.length; index += 1) {
    let frameText
    try {
      frameText = zstdDecompressSync(buffer.subarray(frames[index].start, frames[index].end))
    } catch (error) {
      return withDamage('decode-failure', `corrupt Zstandard session log: frame ${index + 1} failed validation (${error instanceof Error ? error.message : String(error)})`)
    }
    if (frameText.length === 0 || frameText[frameText.length - 1] !== 0x0A) {
      return withDamage('invalid-jsonl-boundary', `corrupt Zstandard session log: frame ${index + 1} does not end on a JSONL record boundary`)
    }
  }
  if (damage !== undefined) return withDamage('torn-tail', tailIssue(damageKind, damage, totalBytes, completeBytes))
  return { status: 'healthy', frames, totalBytes, completeBytes }
}

/**
 * Validate the frame layout the dsh reader requires: the first frame must
 * decompress to EXACTLY one newline-terminated header line (the harness's
 * `assertZstdHeaderFrame`). The harness appends ONE zstd frame per flush
 * batch, so a whole-log single-frame artifact is structurally valid zstd but
 * rejected by dsh (`corrupt Zstandard session log: first frame is not
 * exactly one header line`) — `session.list`, `load`, and `readFrom` all
 * fail on it. A torn tail is NEVER reported as ok, even when the complete
 * prefix is laid out correctly.
 * @param buffer - raw artifact bytes.
 * @param zstdDecompressSync - `node:zlib` zstd decompressor (one frame per call).
 * @returns `{ ok: true }` or `{ ok: false, issue }`.
 */
export function scanZstdLayout(buffer, zstdDecompressSync) {
  const scan = scanFrameLayout(buffer, zstdDecompressSync)
  return scan.status === 'healthy' ? { ok: true } : { ok: false, issue: scan.issue }
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
 * @param frames - optional per-frame `{ startLine, endLine }` ranges (1-based,
 * endLine exclusive) for writer-segment resolution; undefined disables.
 * @returns `{ header, events, issue }`.
 */
export function scanEvents(text, decodeStorageRecord, frames) {
  const lines = text.split('\n')
  const header = lines[0] ?? ''
  const events = []
  let issue
  const frameOfLine = (line) => {
    if (frames === undefined) return -1
    for (let frame = 0; frame < frames.length; frame += 1) {
      if (line >= frames[frame].startLine && line < frames[frame].endLine) return frame
    }
    return -1
  }
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
    const frame = frameOfLine(lineIndex + 1)
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
      // Non-enumerable tags: encodeLog must never serialize them into the
      // repaired artifact. `frame` is the writer segment (flush frame) the
      // row arrived in; -1 when frame info is unavailable.
      Object.defineProperty(event, 'line', { value: lineIndex + 1, enumerable: false, configurable: true })
      Object.defineProperty(event, 'frame', { value: frame, enumerable: false, configurable: true })
      events.push(event)
    }
  }
  return { header, events, issue }
}

/**
 * Decompress each complete frame of an artifact separately and return the
 * 1-based JSONL line range it covers (`endLine` exclusive). Together with
 * {@link scanEvents} this attributes events to the flush frame (writer
 * segment) they arrived in, which duplicate-seq reference resolution uses.
 */
export function frameLineRanges(buffer, zstdDecompressSync) {
  const { frames } = scanZstdFrames(buffer)
  const ranges = []
  let line = 1
  for (const frame of frames) {
    const plain = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    const startLine = line
    line += plain.split('\n').length - 1
    ranges.push({ startLine, endLine: line })
  }
  return ranges
}

/** Keys whose array values are seq references in event `data`. */
const SEQ_REF_ARRAY_KEYS = new Set(['sourceEventSeqs', 'messageSeqs'])

/**
 * Visit every seq cross-reference inside one event's `data`: the
 * `sourceEventSeqs`/`messageSeqs` array values and the `sourceEventSeq`
 * scalar, at any nesting depth.
 * @param event - a session event.
 * @param visit - `(container, key, index, value) => void`; `index` is the
 * array position for array references and undefined for the scalar, so the
 * caller can write the replacement precisely (never by value — a remapped
 * reference could equal another reference's old value).
 */
function eachSeqRef(event, visit) {
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    for (const key of Object.keys(node)) {
      const value = node[key]
      if (SEQ_REF_ARRAY_KEYS.has(key) && Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          if (typeof value[index] === 'number') visit(node, key, index, value[index])
        }
      } else if (key === 'sourceEventSeq' && typeof value === 'number') {
        visit(node, key, undefined, value)
      } else {
        walk(value)
      }
    }
  }
  walk(event.data)
}

/**
 * Resolve one seq reference through the old→new map, honoring a duplicate
 * strategy for values that occur more than once:
 * - `first` — bind to the FIRST occurrence (the reference stays unchanged);
 * - `last` — bind to the LAST occurrence (remapped through the map);
 * - `segment` — bind to the UNIQUE occurrence in the same writer segment
 *   (flush frame) as the referencing event. A single same-frame candidate
 *   resolves to that occurrence's index (after renumbering `seq === index`),
 *   NEVER to the global last occurrence (`map`), which may live in a
 *   different frame when the seq repeats three or more times across frames.
 *   Multiple same-frame candidates are ambiguous — the caller refuses.
 *   No same-frame candidate falls back to `first` (documented); without
 *   frame metadata the strategy degrades to `first`.
 * @param value - the referenced (old) seq.
 * @param strategy - the duplicate-reference strategy, or undefined.
 * @param fromEvent - the referencing event (for the segment strategy).
 * @param map - old→new mapping (last occurrence wins per value).
 * @param occurrences - seq value → array of event indices.
 * @param events - the scanned events (for occurrence frame lookup).
 * @returns `{ kind: 'resolved', seq }` — write this seq;
 *          `{ kind: 'keep' }` — leave the reference unchanged (first);
 *          `{ kind: 'ambiguous', candidates }` — same-frame binding not
 *          unique (only possible under `segment`).
 */
function resolveReference(value, strategy, fromEvent, map, occurrences, events) {
  if (strategy === 'last') return { kind: 'resolved', seq: map.get(value) }
  if (strategy === 'segment' && fromEvent.frame >= 0) {
    const candidates = occurrences.get(value) ?? []
    const sameFrame = candidates.filter(index => events[index]?.frame === fromEvent.frame)
    if (sameFrame.length === 1) {
      // The occurrence index IS the new seq after renumbering.
      return { kind: 'resolved', seq: sameFrame[0] }
    }
    if (sameFrame.length > 1) return { kind: 'ambiguous', candidates: sameFrame }
    // No same-frame occurrence: fall back to first (documented).
    return { kind: 'keep' }
  }
  // 'first' and the segment fallback: the first occurrence keeps its seq.
  return { kind: 'keep' }
}

/**
 * Remap seq cross-references inside one event's `data` through the
 * old→new mapping. Only values `>= threshold` are remapped: everything
 * below the first collision is a pre-collision event whose seq is
 * unchanged. Returns the number of remapped references and — for the
 * `segment` strategy — the first same-frame-ambiguous reference, if any
 * (pre-checked by repairEvents, so this is defensive).
 */
function remapReferences(event, eventIndex, threshold, map, occurrences, strategy, events) {
  let changed = 0
  let ambiguous = undefined
  eachSeqRef(event, (container, key, index, ref) => {
    let next
    if (strategy !== undefined && (occurrences.get(ref)?.length ?? 0) > 1) {
      const outcome = resolveReference(ref, strategy, event, map, occurrences, events)
      if (outcome.kind === 'ambiguous') {
        ambiguous ??= {
          seq: ref,
          key,
          eventIndex,
          line: event.line,
          frame: event.frame,
          candidates: outcome.candidates,
          sameFrameConflict: true,
        }
        return
      }
      next = outcome.kind === 'resolved' ? outcome.seq : undefined
    } else if (ref >= threshold && map.has(ref)) {
      next = map.get(ref)
    }
    if (next !== undefined && next !== ref) {
      if (index === undefined) container[key] = next
      else container[key][index] = next
      changed += 1
    }
  })
  return { changed, ambiguous }
}

/** The duplicate-seq reference resolution strategies (CLI: --duplicate-reference). */
export const DUPLICATE_REFERENCE_STRATEGIES = ['first', 'last', 'segment']

/**
 * Repair the scanned log. Mutates the events array's `seq` fields and the
 * reference fields it remaps.
 *
 * Duplicate-seq semantics (stage C): a reference to a seq value that occurs
 * MORE THAN ONCE in the log cannot be uniquely attributed — it may name the
 * pre-collision event or one of the collision writer's events. When such
 * ambiguous references exist, the default is to REFUSE (`action: 'refuse'`)
 * with a full report ({@link AmbiguousReference} entries: conflict seq,
 * referencing event, candidates, line/frame) so the user can pick a
 * `duplicateReference` strategy. Only when every reference is uniquely
 * resolvable does the repair renumber and remap automatically.
 *
 * The reference-mapping rule for unambiguous values: values below the
 * collision index name pre-collision events (unchanged); values at or above
 * it can only name post-collision events (renumbered through the map).
 * @param events - events from {@link scanEvents}.
 * @param issue - the first issue from {@link scanEvents}, if any.
 * @param options - `{ duplicateReference?: 'first' | 'last' | 'segment' }`.
 * @returns the action taken, the renumber delta, counts, and — for a
 * refused ambiguous log — the ambiguity report.
 */
export function repairEvents(events, issue, options = {}) {
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
  // Occurrence table: which old seq values repeat, and where.
  const occurrences = new Map()
  events.forEach((event, index) => {
    const list = occurrences.get(event.seq)
    if (list === undefined) occurrences.set(event.seq, [index])
    else list.push(index)
  })
  const duplicated = new Set()
  for (const [value, indices] of occurrences) {
    if (indices.length > 1) duplicated.add(value)
  }
  // Ambiguity analysis: references from events at/after the first collision
  // to a duplicated value cannot be attributed. Pre-collision events can
  // only reference pre-collision events (backward), and pre-collision seqs
  // are all unique, so their references are never ambiguous.
  const ambiguous = []
  for (let index = issue.index; index < events.length; index += 1) {
    const event = events[index]
    eachSeqRef(event, (container, key, position, ref) => {
      if (duplicated.has(ref)) {
        ambiguous.push({
          seq: ref,
          key,
          eventIndex: index,
          line: event.line,
          frame: event.frame,
          candidates: occurrences.get(ref),
        })
      }
    })
  }
  // The `segment` strategy adds a stricter rule: the same-frame binding must
  // be UNIQUE. A seq that repeats three or more times can place several
  // occurrences in the referencing event's own frame — those references are
  // ambiguous even with a strategy, and the repair refuses rather than
  // picking one silently.
  if (options.duplicateReference === 'segment') {
    for (let index = issue.index; index < events.length; index += 1) {
      const event = events[index]
      if (!(event.frame >= 0)) continue
      eachSeqRef(event, (container, key, position, ref) => {
        if (!duplicated.has(ref)) return
        const sameFrame = (occurrences.get(ref) ?? []).filter(candidate => events[candidate]?.frame === event.frame)
        if (sameFrame.length > 1) {
          ambiguous.push({
            seq: ref,
            key,
            eventIndex: index,
            line: event.line,
            frame: event.frame,
            candidates: sameFrame,
            sameFrameConflict: true,
          })
        }
      })
    }
  }
  const frameConflicts = ambiguous.filter(entry => entry.sameFrameConflict === true)
  if (options.duplicateReference === undefined && ambiguous.length > 0) {
    return {
      events,
      action: 'refuse',
      fromIndex: issue.index,
      delta: issue.index - issue.got,
      changed: 0,
      refsChanged: 0,
      ambiguous,
      message: `${ambiguous.length} ambiguous seq reference(s) to duplicated value(s); refusing automatic repair (pass --duplicate-reference=first|last|segment)`,
    }
  }
  if (options.duplicateReference === 'segment' && frameConflicts.length > 0) {
    return {
      events,
      action: 'refuse',
      fromIndex: issue.index,
      delta: issue.index - issue.got,
      changed: 0,
      refsChanged: 0,
      ambiguous: frameConflicts,
      message: `${frameConflicts.length} ambiguous seq reference(s): multiple candidate occurrences in the referencing event's frame; refusing (a segment binding must be unique)`,
    }
  }
  // Duplicate seq: renumber every event from the first collision onward so
  // `seq === index` again.
  const repaired = events
  const map = new Map()
  for (let index = issue.index; index < repaired.length; index += 1) {
    const event = repaired[index]
    map.set(event.seq, index)
    event.seq = index
  }
  let refsChanged = 0
  for (let index = 0; index < repaired.length; index += 1) {
    const event = repaired[index]
    // The duplicate strategy only applies to post-collision events: a
    // pre-collision reference points backward and can never mean a
    // post-collision event, so it must never be remapped by a strategy.
    const remapped = remapReferences(event, index, issue.index, map, occurrences, index >= issue.index ? options.duplicateReference : undefined, events)
    refsChanged += remapped.changed
    if (remapped.ambiguous !== undefined) {
      // Defensive: the pre-check above should have caught every same-frame
      // conflict already; if one slips through, refuse rather than write.
      ambiguous.push(remapped.ambiguous)
    }
  }
  if (ambiguous.some(entry => entry.sameFrameConflict === true)) {
    const frameConflicts = ambiguous.filter(entry => entry.sameFrameConflict === true)
    return {
      events: repaired,
      action: 'refuse',
      fromIndex: issue.index,
      delta: issue.index - issue.got,
      changed: 0,
      refsChanged: 0,
      ambiguous: frameConflicts,
      message: `${frameConflicts.length} ambiguous seq reference(s): multiple candidate occurrences in the referencing event's frame; refusing (a segment binding must be unique)`,
    }
  }
  return {
    events: repaired,
    action: 'renumber',
    fromIndex: issue.index,
    delta: issue.index - issue.got,
    changed: repaired.length - issue.index,
    refsChanged,
    ambiguous: ambiguous.length === 0 ? undefined : ambiguous,
    resolvedStrategy: ambiguous.length === 0 ? undefined : options.duplicateReference,
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
