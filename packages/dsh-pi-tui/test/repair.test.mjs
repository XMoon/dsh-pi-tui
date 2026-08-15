/**
 * Tests for the session-log repair logic: duplicate-seq renumbering with
 * cross-reference remap, gap/unparsable truncation, healthy no-ops, and the
 * Zstandard frame walk/decompress round trip. Plain JS (.mjs) so it runs
 * under `node --test` without type stripping.
 * @module repair.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { decodeStorageRecord } from '@deepseek-ai/dsh-session'
import {
  compressLog,
  decompressFrames,
  encodeLog,
  repairEvents,
  scanEvents,
  scanZstdFrames,
  scanZstdLayout,
} from '../scripts/repair-core.mjs'

const HEADER = '{"type":"session","version":0,"id":"session-test","createdAt":1,"cwd":"/work","delegationDepth":0,"agentPreset":"standard"}'

/** Build events for a small log; seqs may be overridden for corruption. */
function buildEvents(seqs) {
  return seqs.map((seq, index) => ({
    type: index === 0 ? 'permission/preset' : 'user/message',
    seq,
    time: 1000 + index,
    data: { preset: 'workspace-write' },
  }))
}

test('healthy log: scan finds no issue and repair is a no-op', () => {
  const text = encodeLog(HEADER, buildEvents([0, 1, 2, 3]))
  const { events, issue } = scanEvents(text, decodeStorageRecord)
  assert.equal(issue, undefined)
  assert.equal(events.length, 4)
  const plan = repairEvents(events, issue)
  assert.equal(plan.action, 'none')
  // Re-encoded text re-scans clean.
  const again = scanEvents(encodeLog(HEADER, plan.events), decodeStorageRecord)
  assert.equal(again.issue, undefined)
})

test('duplicate seq: renumbers from the collision and remaps references', () => {
  const events = buildEvents([0, 1, 2, 2, 3, 4])
  // Collision at index 3: the event's old seq 2 duplicates the pre-collision
  // event at index 2.
  events[1].data = { sourceEventSeqs: [0] } // pre-collision ref → unchanged
  events[3].data = { sourceEventSeqs: [2] } // ref to pre-collision seq 2 → unchanged (ambiguous dup resolved to the pre-collision event)
  events[4].data = { message: { sourceEventSeqs: [3] }, messageSeqs: [4] } // post-collision refs → remapped
  const text = encodeLog(HEADER, events)
  const { issue } = scanEvents(text, decodeStorageRecord)
  assert.ok(issue !== undefined)
  assert.equal(issue.kind, 'duplicate')
  assert.equal(issue.index, 3)
  assert.equal(issue.got, 2)

  const plan = repairEvents(events, issue)
  assert.equal(plan.action, 'renumber')
  assert.equal(plan.delta, 1)
  assert.equal(plan.changed, 3) // indices 3..5
  // Every event's seq equals its index again.
  plan.events.forEach((event, index) => assert.equal(event.seq, index, `event ${index} seq`))
  // References below the collision index are untouched; references at or
  // above it follow the old→new mapping (2→3, 3→4, 4→5).
  assert.deepEqual(plan.events[1].data.sourceEventSeqs, [0])
  assert.deepEqual(plan.events[3].data.sourceEventSeqs, [2])
  assert.deepEqual(plan.events[4].data.message.sourceEventSeqs, [4])
  assert.deepEqual(plan.events[4].data.messageSeqs, [5])

  // The repaired log must pass the storage-format scan.
  const again = scanEvents(encodeLog(HEADER, plan.events), decodeStorageRecord)
  assert.equal(again.issue, undefined)
  assert.equal(again.events.length, 6)
})

test('duplicate seq with a larger renumber delta', () => {
  // Collision at index 3 with got 0: delta 3 (the 3347115f shape).
  const events = buildEvents([0, 1, 2, 0, 1, 2, 3])
  const text = encodeLog(HEADER, events)
  const { issue } = scanEvents(text, decodeStorageRecord)
  assert.ok(issue !== undefined)
  assert.equal(issue.index, 3)
  assert.equal(issue.got, 0)
  const plan = repairEvents(events, issue)
  assert.equal(plan.delta, 3)
  plan.events.forEach((event, index) => assert.equal(event.seq, index))
  assert.equal(scanEvents(encodeLog(HEADER, plan.events), decodeStorageRecord).issue, undefined)
})

test('gap: truncates at the missing seq and reports the loss', () => {
  const events = buildEvents([0, 1, 2, 4, 5])
  const text = encodeLog(HEADER, events)
  const { issue } = scanEvents(text, decodeStorageRecord)
  assert.ok(issue !== undefined)
  assert.equal(issue.kind, 'gap')
  assert.equal(issue.index, 3)
  const plan = repairEvents(events, issue)
  assert.equal(plan.action, 'truncate')
  assert.equal(plan.events.length, 3)
  assert.equal(plan.changed, 2)
  assert.equal(scanEvents(encodeLog(HEADER, plan.events), decodeStorageRecord).issue, undefined)
})

test('unparsable row: truncates at the broken row', () => {
  const lines = [HEADER, JSON.stringify(buildEvents([0])[0]), 'this is not json', JSON.stringify(buildEvents([1, 2])[1])]
  const { issue } = scanEvents(`${lines.join('\n')}\n`, decodeStorageRecord)
  assert.ok(issue !== undefined)
  assert.equal(issue.kind, 'unparsable')
  assert.equal(issue.index, 1)
  const plan = repairEvents(buildEvents([0, 1, 2]), issue)
  assert.equal(plan.action, 'truncate')
  assert.equal(plan.events.length, 1)
})

test('zstd frame walk + decompress round-trips concatenated frames', () => {
  const text = encodeLog(HEADER, buildEvents([0, 1, 2, 3]))
  // Simulate the write-behind shape: several independent frames.
  const rows = text.trimEnd().split('\n')
  const frames = [
    zstdCompressSync(Buffer.from(`${rows.slice(0, 3).join('\n')}\n`, 'utf8')),
    zstdCompressSync(Buffer.from(`${rows.slice(3).join('\n')}\n`, 'utf8')),
  ]
  const buffer = Buffer.concat(frames)
  const scanned = scanZstdFrames(buffer)
  assert.equal(scanned.frames.length, 2)
  const { text: restored } = decompressFrames(buffer, zstdDecompressSync)
  assert.equal(restored, text)
})

test('compressLog emits the dsh frame layout: header line alone in frame one', () => {
  const text = encodeLog(HEADER, buildEvents([0, 1, 2]))
  const buffer = compressLog(text, zstdCompressSync)
  const { text: restored, frames } = decompressFrames(buffer, zstdDecompressSync)
  assert.equal(restored, text)
  // Header frame + one chunk frame for the 3 small events.
  assert.equal(frames, 2)
  // The first frame must decode to EXACTLY one newline-terminated header line
  // (the harness's assertZstdHeaderFrame) — a whole-log single frame is
  // rejected by dsh as corrupt.
  const scanned = scanZstdFrames(buffer)
  const first = zstdDecompressSync(buffer.subarray(scanned.frames[0].start, scanned.frames[0].end))
  assert.equal(first.toString('utf8'), `${HEADER}\n`)
  // The repaired bytes pass the layout validation the reader performs.
  assert.deepEqual(scanZstdLayout(buffer, zstdDecompressSync), { ok: true })
})

test('compressLog chunks large logs into bounded frames, all but the first carrying whole records', () => {
  const events = buildEvents(Array.from({ length: 2000 }, (_, index) => index))
  const text = encodeLog(HEADER, events)
  const buffer = compressLog(text, zstdCompressSync)
  const { text: restored, frames } = decompressFrames(buffer, zstdDecompressSync)
  assert.equal(restored, text)
  assert.ok(frames >= 2)
  assert.ok(frames < 20, `expected a handful of chunk frames, got ${frames}`)
  // Every frame boundary falls on a JSONL record boundary: each frame's
  // plaintext must start at a line start and end with exactly one newline.
  const scanned = scanZstdFrames(buffer)
  for (const frame of scanned.frames) {
    const plain = zstdDecompressSync(buffer.subarray(frame.start, frame.end))
    assert.ok(plain.length > 0)
    assert.equal(plain[plain.length - 1], 0x0a)
  }
  assert.deepEqual(scanZstdLayout(buffer, zstdDecompressSync), { ok: true })
})

test('scanZstdLayout flags a whole-log single frame as layout-damaged', () => {
  const text = encodeLog(HEADER, buildEvents([0, 1, 2]))
  const singleFrame = zstdCompressSync(Buffer.from(text, 'utf8'))
  const layout = scanZstdLayout(singleFrame, zstdDecompressSync)
  assert.equal(layout.ok, false)
  assert.match(layout.issue, /first frame is not exactly one header line/)
  // Re-framing with compressLog makes the same content pass layout validation.
  const repaired = compressLog(text, zstdCompressSync)
  assert.deepEqual(scanZstdLayout(repaired, zstdDecompressSync), { ok: true })
  assert.equal(decompressFrames(repaired, zstdDecompressSync).text, text)
})

test('scanZstdLayout rejects an empty/header-less artifact', () => {
  assert.equal(scanZstdLayout(Buffer.alloc(0), zstdDecompressSync).ok, false)
  assert.equal(scanZstdLayout(zstdCompressSync(Buffer.alloc(0)), zstdDecompressSync).ok, false)
})
