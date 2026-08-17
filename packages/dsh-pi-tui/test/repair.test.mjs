/**
 * Tests for the session-log repair logic: duplicate-seq renumbering with
 * cross-reference remap, gap/unparsable truncation, healthy no-ops, the
 * Zstandard frame walk/decompress round trip, and torn-tail detection
 * (frame matrix + --scan reporting). Plain JS (.mjs) so it runs under
 * `node --test` without type stripping.
 * @module repair.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { decodeStorageRecord } from '@deepseek-ai/dsh-session'
import {
  compressLog,
  decompressFrames,
  encodeLog,
  frameLineRanges,
  repairEvents,
  scanEvents,
  scanFrameLayout,
  scanZstdFrames,
  scanZstdLayout,
} from '../scripts/repair-core.mjs'
import { writeArtifact, verifyArtifactFile, parseArgs } from '../scripts/repair-session.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  events[3].data = { sourceEventSeqs: [2] } // ref to duplicated seq 2 → ambiguous; resolved as 'first' (pre-collision event)
  events[4].data = { message: { sourceEventSeqs: [3] }, messageSeqs: [4] } // post-collision refs → remapped
  const text = encodeLog(HEADER, events)
  const { issue } = scanEvents(text, decodeStorageRecord)
  assert.ok(issue !== undefined)
  assert.equal(issue.kind, 'duplicate')
  assert.equal(issue.index, 3)
  assert.equal(issue.got, 2)

  const plan = repairEvents(events, issue, { duplicateReference: 'first' })
  assert.equal(plan.action, 'renumber')
  assert.equal(plan.resolvedStrategy, 'first')
  assert.equal(plan.ambiguous.length, 1)
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

test('compressLog strips the trailing empty frame zstdCompressSync can emit at a 16 KiB boundary', () => {
  // Regression for the repair of session-d0a3bd9a: Node's zstdCompressSync
  // returns TWO concatenated frames for one input when the compressed output
  // lands exactly on 16384 bytes — a content frame plus a valid 13-byte
  // zero-content frame. The fixture below (a real 21-row reasoning-delta
  // chunk from that session) reproduces it deterministically. The dsh reader
  // tolerates the empty frame, but the layout gate rejects it, so a repaired
  // artifact would fail the post-write verify.
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'compresslog-empty-frame-trigger.txt')
  const plain = readFileSync(fixture, 'utf8')
  // Precondition: this fixture really triggers the two-frame output.
  const raw = zstdCompressSync(Buffer.from(plain, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
  const rawScanned = scanZstdFrames(raw)
  assert.ok(rawScanned.frames.length > 1, `fixture must trigger the empty-frame bug (got ${rawScanned.frames.length} frame(s))`)
  const emptyFrame = rawScanned.frames[rawScanned.frames.length - 1]
  assert.equal(zstdDecompressSync(raw.subarray(emptyFrame.start, emptyFrame.end)).length, 0)

  // compressLog must never emit a zero-content frame: the repaired artifact
  // passes the reader's layout gate.
  const text = encodeLog(HEADER, [{ type: 'assistant/chunk', seq: 0, time: 2000, data: { turn: 1, step: 1, text: plain.trimEnd() } }])
  const buffer = compressLog(text, zstdCompressSync)
  const scanned = scanZstdFrames(buffer)
  assert.ok(scanned.frames.length >= 2, `expected at least a header frame and one chunk frame, got ${scanned.frames.length}`)
  for (const frame of scanned.frames) {
    const payload = zstdDecompressSync(buffer.subarray(frame.start, frame.end))
    assert.ok(payload.length > 0, 'compressLog must not emit an empty frame')
    assert.equal(payload[payload.length - 1], 0x0a)
  }
  assert.deepEqual(scanZstdLayout(buffer, zstdDecompressSync), { ok: true })
  // The decompressed text round-trips (no bytes lost while stripping).
  assert.equal(decompressFrames(buffer, zstdDecompressSync).text, text)
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

// --- torn-tail detection ---

/** A checksummed zstd frame (like the harness writer and compressLog). */
function frameOf(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}

const TEXT = encodeLog(HEADER, buildEvents([0, 1, 2, 3]))

/** A multi-frame artifact with the tail truncated mid-frame. */
function tornArtifact(prefixText, tailText, cutBytes) {
  const buffer = Buffer.concat([compressLog(prefixText, zstdCompressSync), frameOf(tailText)])
  return buffer.subarray(0, buffer.length - cutBytes)
}

test('half a zstd magic is a torn tail with zero salvageable bytes', () => {
  const buffer = Buffer.from([0x28, 0xb5])
  const scan = scanFrameLayout(buffer, zstdDecompressSync)
  assert.equal(scan.status, 'torn-tail')
  assert.equal(scan.tornStart, 0)
  assert.equal(scan.completeBytes, 0)
  assert.equal(scan.totalBytes, 2)
  // Never reported as healthy.
  assert.equal(scanZstdLayout(buffer, zstdDecompressSync).ok, false)
})

test('complete magic with a truncated frame header is a torn tail', () => {
  // Take a real frame and cut it inside the frame header (after the magic).
  const full = compressLog(TEXT, zstdCompressSync)
  const buffer = full.subarray(0, 6)
  const scan = scanFrameLayout(buffer, zstdDecompressSync)
  assert.equal(scan.status, 'torn-tail')
  assert.equal(scan.tornStart, 0)
  assert.equal(scan.completeBytes, 0)
})

test('a truncated data block and a truncated checksum are torn tails', () => {
  const full = compressLog(TEXT, zstdCompressSync)
  // Cut inside the first frame's data block.
  const midBlock = full.subarray(0, full.length - 12)
  assert.equal(scanFrameLayout(midBlock, zstdDecompressSync).status, 'torn-tail')
  // Cut two bytes off the end: inside the 4-byte checksum.
  const shortChecksum = full.subarray(0, full.length - 2)
  const scan = scanFrameLayout(shortChecksum, zstdDecompressSync)
  assert.equal(scan.status, 'torn-tail')
  assert.ok(scan.issue.includes('torn tail'), scan.issue)
})

test('multi-frame log with the last frame truncated: complete prefix is preserved', () => {
  const prefixText = encodeLog(HEADER, buildEvents([0, 1, 2]))
  const torn = tornArtifact(prefixText, JSON.stringify(buildEvents([3])[0]), 7)
  const scan = scanFrameLayout(torn, zstdDecompressSync)
  assert.equal(scan.status, 'torn-tail')
  assert.ok(scan.tornStart !== undefined && scan.tornStart < scan.totalBytes)
  assert.equal(scan.completeBytes, scan.tornStart)
  // The complete prefix decompresses to exactly the salvageable text.
  assert.equal(decompressFrames(torn, zstdDecompressSync).text, prefixText)
  // The salvageable prefix is a valid contiguous log.
  assert.equal(scanEvents(decompressFrames(torn, zstdDecompressSync).text, decodeStorageRecord).issue, undefined)
})

test('garbage appended after a complete frame is a torn tail with a salvageable prefix', () => {
  const garbage = Buffer.concat([compressLog(TEXT, zstdCompressSync), Buffer.from('this is not a zstd frame')])
  const scan = scanFrameLayout(garbage, zstdDecompressSync)
  assert.equal(scan.status, 'torn-tail')
  assert.ok(scan.garbageStart !== undefined)
  assert.equal(scan.completeBytes, scan.garbageStart)
  assert.equal(decompressFrames(garbage, zstdDecompressSync).text, TEXT)
  assert.match(scan.issue, /trailing garbage/)
})

test('a damaged first frame is a decode failure, not a torn tail', () => {
  const single = frameOf(TEXT)
  const bad = Buffer.from(single)
  bad[bad.length - 10] ^= 0xff // corrupt a payload byte; the checksum catches it
  const scan = scanFrameLayout(bad, zstdDecompressSync)
  assert.equal(scan.status, 'decode-failure')
  assert.ok(scan.issue.includes('failed validation'), scan.issue)
})

test('a complete frame not ending on a JSONL boundary is flagged', () => {
  const rows = TEXT.trimEnd().split('\n')
  const buffer = Buffer.concat([
    frameOf(`${rows[0]}\n`),
    frameOf(`${rows[1]}\n${rows[2]}`), // no trailing newline: mid-record boundary
  ])
  const scan = scanFrameLayout(buffer, zstdDecompressSync)
  assert.equal(scan.status, 'invalid-jsonl-boundary')
})

// --- the repair CLI: torn-tail detection ---

const REPAIR_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'repair-session.mjs')

/** A minimal fake dsh install: a package.json named @deepseek-ai/dsh plus a
 * symlinked @deepseek-ai/dsh-session, so `--dsh-dir` resolves the real
 * storage decoder without touching the machine's dsh. */
function makeDshStub() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-stub-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0' }))
  const modules = join(dir, 'node_modules', '@deepseek-ai')
  mkdirSync(modules, { recursive: true })
  const real = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-session')))
  symlinkSync(real, join(modules, 'dsh-session'), 'dir')
  return dir
}

/** A fake dsh home with one session artifact. */
function makeFakeHome(artifactBytes) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const dir = join(home, 'sessions', 'proj', 'sess-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.jsonl.zstd'), artifactBytes)
  return home
}

function runCli(args) {
  return spawnSync(process.execPath, [REPAIR_SCRIPT, ...args], { encoding: 'utf8' })
}

test('parseArgs parses flags and positional ids without side effects', () => {
  const { flags, positional } = parseArgs(['--yes', '--duplicate-reference', 'segment', 'sess-1', '--scan'])
  assert.equal(flags.yes, true)
  assert.equal(flags.scan, true)
  assert.equal(flags.duplicateReference, 'segment')
  assert.deepEqual(positional, ['sess-1'])
  assert.equal(flags.help, false)
  assert.equal(parseArgs(['--help']).flags.help, true)
  assert.equal(parseArgs(['-h', 'sess-1']).flags.help, true)
  assert.equal(parseArgs(['--dsh-home', '/x']).flags.dshHome, '/x')
})

test('parseArgs errors clearly on missing flag values', () => {
  assert.throws(() => parseArgs(['--duplicate-reference']), /requires a value/)
  assert.throws(() => parseArgs(['--dsh-dir']), /requires a value/)
  assert.throws(() => parseArgs(['--dsh-home']), /requires a value/)
})

test('parseArgs accepts both the space and = forms of --duplicate-reference', () => {
  assert.equal(parseArgs(['--duplicate-reference', 'segment']).flags.duplicateReference, 'segment')
  assert.equal(parseArgs(['--duplicate-reference=segment']).flags.duplicateReference, 'segment')
  assert.equal(parseArgs(['--duplicate-reference=first', 'sess-1']).positional[0], 'sess-1')
  assert.throws(() => parseArgs(['--duplicate-reference=typo']), /must be one of/)
})

test('parseArgs rejects a non-enum duplicate-reference value (a typo must not silently degrade to first)', () => {
  assert.throws(() => parseArgs(['--duplicate-reference', 'frist']), /must be one of first\|last\|segment/)
  assert.throws(() => parseArgs(['--duplicate-reference', 'FIRST']), /must be one of/)
  // A flag swallowed as the value must be rejected, not consumed.
  assert.throws(() => parseArgs(['--duplicate-reference', '--scan']), /got a flag/)
  // --dsh-dir/--dsh-home must not swallow following flags either.
  assert.throws(() => parseArgs(['--dsh-dir', '--yes']), /got a flag/)
  assert.throws(() => parseArgs(['--dsh-home', '--scan']), /got a flag/)
})

test('repairEvents defensively rejects a non-enum strategy', () => {
  const events = buildEvents([0, 1, 2, 2, 3])
  events[4].data = { sourceEventSeqs: [2] }
  const { issue } = scanEvents(encodeLog(HEADER, events), decodeStorageRecord)
  assert.throws(
    () => repairEvents(events, issue, { duplicateReference: 'typo' }),
    /unknown duplicate-reference strategy/,
  )
})

test('importing repair-session with hostile argv has no side effects', () => {
  // The host argv carries --help (which used to print usage + exit) and
  // --dsh-home (which used to mutate process.env) — a plain import must
  // neither print, nor exit, nor touch the environment.
  const probe = [
    "import('" + REPAIR_SCRIPT + "')",
    ".then(m => { console.log('alive'); console.log('parseArgs=' + (m.parseArgs ? 'exported' : 'missing')); console.log('env=' + String(process.env.DSH_HOME)) })",
    ".catch(e => { console.error(e); process.exit(9) })",
  ].join('')
  // `--` separates node's own options from the HOST argv the import sees.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, '--', '--help', '--dsh-home', '/mutated'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /alive/, 'the importing process must stay alive')
  assert.match(result.stdout, /parseArgs=exported/)
  assert.ok(!result.stdout.includes('usage:'), 'import must not print the CLI usage')
  assert.ok(!result.stdout.includes('/mutated'), 'import must not mutate DSH_HOME')
})

test('CLI --help still prints usage and exits 0', () => {
  const result = runCli(['--help', '--dsh-dir', 'ignored'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /usage:/)
})

test('CLI --scan reports a torn tail with byte accounting, never healthy', () => {
  const stub = makeDshStub()
  const torn = tornArtifact(TEXT, JSON.stringify(buildEvents([4])[0]), 5)
  const home = makeFakeHome(torn)
  const result = runCli(['--scan', '--dsh-dir', stub, '--dsh-home', home])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /CORRUPT sess-1:/)
  assert.match(result.stdout, /torn tail/)
  assert.ok(result.stdout.includes(`of ${torn.length}`), `byte accounting missing: ${result.stdout}`)
  // The --scan path must never report a torn tail as healthy.
  assert.ok(!result.stdout.includes('no damaged sessions'))
})

test('CLI reports a torn tail for a single session without touching the file', () => {
  const stub = makeDshStub()
  const torn = tornArtifact(TEXT, JSON.stringify(buildEvents([4])[0]), 5)
  const home = makeFakeHome(torn)
  const path = join(home, 'sessions', 'proj', 'sess-1', 'session.jsonl.zstd')
  const before = readFileSync(path)
  const result = runCli(['sess-1', '--dsh-dir', stub, '--dsh-home', home])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /torn tail/)
  assert.match(result.stdout, /truncate the torn tail/)
  assert.ok(result.stdout.includes('dry run'), result.stdout)
  assert.deepEqual(readFileSync(path), before, 'dry run must not modify the file')
  assert.equal(readdirSync(join(home, 'sessions', 'proj', 'sess-1')).length, 1, 'no backup in a dry run')
})

// --- the repair CLI: applying a torn-tail truncation ---

/** Replicate the harness reader's readZstdPrefix + SessionLogScanner with
 * the real decodeStorageRecord: first frame must be exactly one header line,
 * every row decodes, and seqs stay contiguous. */
function readLikeHarness(path) {
  const buffer = readFileSync(path)
  const { frames } = scanZstdFrames(buffer)
  assert.ok(frames.length > 0, 'no frames')
  const first = zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)).toString('utf8')
  assert.ok(first.endsWith('\n') && first.indexOf('\n') === first.length - 1, 'first frame is not exactly one header line')
  const text = decompressFrames(buffer, zstdDecompressSync).text
  const lines = text.split('\n')
  const events = []
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '') continue
    for (const event of decodeStorageRecord(JSON.parse(lines[index]))) {
      if (event.seq !== events.length) throw new Error(`corrupt session log: seq gap in committed region (expected ${events.length}, got ${event.seq})`)
      events.push(event)
    }
  }
  return { header: JSON.parse(lines[0]), events }
}

test('CLI dry run reports keep/discard bytes and unknown loss; writes nothing', () => {
  const stub = makeDshStub()
  const torn = tornArtifact(TEXT, JSON.stringify(buildEvents([4])[0]), 5)
  const home = makeFakeHome(torn)
  const path = join(home, 'sessions', 'proj', 'sess-1', 'session.jsonl.zstd')
  const before = readFileSync(path)
  const result = runCli(['sess-1', '--dsh-dir', stub, '--dsh-home', home])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /keep \d+ of \d+ bytes/)
  assert.match(result.stdout, /events lost in the torn tail: unknown/)
  assert.match(result.stdout, /storage row\(s\)/)
  assert.deepEqual(readFileSync(path), before, 'dry run must not modify the file')
})

test('CLI --yes truncates at the complete frame boundary, backs up first, writes 0600', () => {
  const stub = makeDshStub()
  const torn = tornArtifact(TEXT, JSON.stringify(buildEvents([4])[0]), 5)
  const home = makeFakeHome(torn)
  const dir = join(home, 'sessions', 'proj', 'sess-1')
  const path = join(dir, 'session.jsonl.zstd')
  const result = runCli(['sess-1', '--yes', '--dsh-dir', stub, '--dsh-home', home])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /backup: /)
  assert.match(result.stdout, /verify: valid frame layout/)
  // A backup of the original was created first (and is byte-identical).
  const backups = readdirSync(dir).filter(name => name.startsWith('session.jsonl.zstd.bak-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(dir, backups[0])).length, torn.length)
  // Output is strictly 0600.
  assert.equal(statSync(path).mode & 0o777, 0o600)
  // The repaired artifact is a healthy multi-frame log whose first frame is
  // exactly the header line.
  const buffer = readFileSync(path)
  const layout = scanFrameLayout(buffer, zstdDecompressSync)
  assert.equal(layout.status, 'healthy')
  assert.ok(layout.frames.length >= 2, 'repaired log should be re-framed, not one blob')
  const { frames } = scanZstdFrames(buffer)
  assert.equal(zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)).toString('utf8'), `${HEADER}\n`)
  // The real reader semantics see a contiguous 4-event log (the torn 5th is gone).
  const read = readLikeHarness(path)
  assert.equal(read.header.id, 'session-test')
  assert.equal(read.events.length, 4)
  read.events.forEach((event, index) => assert.equal(event.seq, index))
  // A second scan finds nothing to repair.
  const rescan = runCli(['sess-1', '--dsh-dir', stub, '--dsh-home', home])
  assert.equal(rescan.status, 0)
  assert.match(rescan.stdout, /nothing to repair/)
})

test('CLI refuses a torn tail with no salvageable prefix (damage at byte 0)', () => {
  const stub = makeDshStub()
  const home = makeFakeHome(Buffer.from([0x28, 0xb5]))
  const path = join(home, 'sessions', 'proj', 'sess-1', 'session.jsonl.zstd')
  const result = runCli(['sess-1', '--yes', '--dsh-dir', stub, '--dsh-home', home])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no salvageable prefix/)
  assert.deepEqual(readFileSync(path), Buffer.from([0x28, 0xb5]), 'original left untouched')
  assert.equal(readdirSync(join(home, 'sessions', 'proj', 'sess-1')).length, 1, 'no backup for a refused repair')
})

test('writeArtifact verifies the tmp BEFORE the replace: a failing verify leaves the target untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repair-write-'))
  const path = join(dir, 'session.jsonl')
  const original = `${HEADER}\n`
  writeFileSync(path, original)
  const before = readFileSync(path)
  // The row parses as JSON but the row DECODER throws: scanEvents reports
  // the row as unparsable, verification fails, and the repair must refuse
  // to touch the active file.
  const badDecoder = () => { throw new Error('boom') }
  assert.throws(
    () => writeArtifact(path, 'none', `${HEADER}\n{"type":"user/message","seq":0,"time":1,"data":{}}\n`, badDecoder),
    /verification failed before replace/,
  )
  assert.deepEqual(readFileSync(path), before, 'the target must be untouched when verification fails')
  const leftovers = readdirSync(dir).filter(name => name.includes('repair-tmp'))
  assert.deepEqual(leftovers, [], 'the tmp file must be removed on failure')
})

test('writeArtifact replaces atomically on success: 0600 target, backup kept, no tmp leftovers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repair-write-'))
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, 'old content\n')
  const good = `${HEADER}\n{"type":"user/message","seq":0,"time":1,"data":{}}\n`
  const backup = writeArtifact(path, 'none', good, () => [])
  assert.equal(readFileSync(path, 'utf8'), good, 'the target holds the repaired bytes')
  assert.equal(statSync(path).mode & 0o777, 0o600, 'the target stays 0600')
  assert.equal(existsSync(backup), true, 'the durable backup exists')
  assert.equal(existsSync(path + '.bak'), false, 'backup has a timestamp suffix')
  const leftovers = readdirSync(dir).filter(name => name.includes('repair-tmp'))
  assert.deepEqual(leftovers, [], 'no tmp leftovers on success')
  // The tmp bytes were verified before the rename: the same file passes
  // verifyArtifactFile after the fact.
  assert.equal(verifyArtifactFile(path, 'none', () => []), undefined)
})

test('writeArtifact verifies the zstd layout of the tmp before the replace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repair-write-'))
  const path = join(dir, 'session.jsonl.zstd')
  const original = compressLog(encodeLog(HEADER, buildEvents([0, 1])), zstdCompressSync)
  writeFileSync(path, original)
  const before = readFileSync(path)
  // A "repaired" text that is valid JSONL but must be re-framed correctly:
  // writeArtifact compresses and the tmp verification must pass only for a
  // healthy dsh layout.
  const good = encodeLog(HEADER, buildEvents([0, 1]))
  const backup = writeArtifact(path, 'zstd', good, decodeStorageRecord)
  assert.equal(existsSync(backup), true)
  const layout = scanFrameLayout(readFileSync(path), zstdDecompressSync)
  assert.equal(layout.status, 'healthy', 'the replaced artifact must be a healthy multi-frame log')
  assert.equal(verifyArtifactFile(path, 'zstd', decodeStorageRecord), undefined)
})

test('CLI repair result passes the real dsh reader on a duplicate-seq log', () => {
  const stub = makeDshStub()
  const events = buildEvents([0, 1, 2, 2, 3])
  const buffer = compressLog(encodeLog(HEADER, events), zstdCompressSync)
  const home = makeFakeHome(buffer)
  const path = join(home, 'sessions', 'proj', 'sess-1', 'session.jsonl.zstd')
  const result = runCli(['sess-1', '--yes', '--dsh-dir', stub, '--dsh-home', home])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /renumber/)
  const read = readLikeHarness(path)
  assert.equal(read.events.length, 5)
  read.events.forEach((event, index) => assert.equal(event.seq, index))
  assert.equal(existsSync(path), true)
})

// --- duplicate-seq reference ambiguity (stage C) ---

test('ambiguous refs to a duplicated seq refuse by default with a full report', () => {
  const events = buildEvents([0, 1, 2, 2, 3, 4])
  events[4].data = { sourceEventSeqs: [2] } // 2 occurs at events 2 and 3
  const text = encodeLog(HEADER, events)
  const { issue } = scanEvents(text, decodeStorageRecord)
  const plan = repairEvents(events, issue)
  assert.equal(plan.action, 'refuse')
  assert.match(plan.message, /refusing automatic repair/)
  assert.equal(plan.ambiguous.length, 1)
  assert.equal(plan.ambiguous[0].seq, 2)
  assert.equal(plan.ambiguous[0].eventIndex, 4)
  assert.deepEqual(plan.ambiguous[0].candidates, [2, 3])
  // Refusal must not mutate anything: seqs stay as scanned.
  assert.deepEqual(events.map(event => event.seq), [0, 1, 2, 2, 3, 4])
  // The artifact is still reported damaged on a re-scan.
  assert.ok(scanEvents(encodeLog(HEADER, events), decodeStorageRecord).issue !== undefined)
})

test('first strategy binds ambiguous refs to the first occurrence', () => {
  const events = buildEvents([0, 1, 2, 2, 3, 4])
  events[4].data = { sourceEventSeqs: [2] }
  const { issue } = scanEvents(encodeLog(HEADER, events), decodeStorageRecord)
  const plan = repairEvents(events, issue, { duplicateReference: 'first' })
  assert.equal(plan.action, 'renumber')
  assert.equal(plan.resolvedStrategy, 'first')
  assert.equal(plan.events[4].data.sourceEventSeqs[0], 2) // unchanged → first occurrence
  plan.events.forEach((event, index) => assert.equal(event.seq, index))
  assert.equal(scanEvents(encodeLog(HEADER, plan.events), decodeStorageRecord).issue, undefined)
})

test('last strategy binds ambiguous refs to the post-collision event', () => {
  const events = buildEvents([0, 1, 2, 2, 3, 4])
  events[4].data = { sourceEventSeqs: [2] }
  const { issue } = scanEvents(encodeLog(HEADER, events), decodeStorageRecord)
  const plan = repairEvents(events, issue, { duplicateReference: 'last' })
  assert.equal(plan.action, 'renumber')
  assert.equal(plan.events[4].data.sourceEventSeqs[0], 3) // remapped → last occurrence
})

test('interleaved two-writer log: refs to any repeated seq are ambiguous', () => {
  const build = () => {
    const events = buildEvents([0, 1, 2, 0, 1, 2, 3])
    events[6].data = { sourceEventSeqs: [0, 1, 2] }
    return events
  }
  const { issue } = scanEvents(encodeLog(HEADER, build()), decodeStorageRecord)
  assert.equal(issue.kind, 'duplicate')
  const refused = repairEvents(build(), issue)
  assert.equal(refused.action, 'refuse')
  assert.equal(refused.ambiguous.length, 3)
  assert.deepEqual(refused.ambiguous.map(entry => entry.seq), [0, 1, 2])
  const first = repairEvents(build(), issue, { duplicateReference: 'first' })
  assert.deepEqual(first.events[6].data.sourceEventSeqs, [0, 1, 2])
  const last = repairEvents(build(), issue, { duplicateReference: 'last' })
  assert.deepEqual(last.events[6].data.sourceEventSeqs, [3, 4, 5])
  last.events.forEach((event, index) => assert.equal(event.seq, index))
})

test('the same duplicated seq referenced by several events is reported and resolved consistently', () => {
  const build = () => {
    const events = buildEvents([0, 1, 2, 2, 3])
    events[3].data = { sourceEventSeqs: [1] } // unique ref → fine
    events[4].data = { messageSeqs: [2] } // ambiguous ref
    return events
  }
  const { issue } = scanEvents(encodeLog(HEADER, build()), decodeStorageRecord)
  const refused = repairEvents(build(), issue)
  assert.equal(refused.action, 'refuse')
  assert.equal(refused.ambiguous.length, 1)
  const first = repairEvents(build(), issue, { duplicateReference: 'first' })
  assert.deepEqual(first.events[3].data.sourceEventSeqs, [1])
  assert.deepEqual(first.events[4].data.messageSeqs, [2])
})

test('segment strategy binds to the occurrence in the same flush frame', () => {
  const events = buildEvents([0, 1, 2, 2, 3])
  events[4].data = { sourceEventSeqs: [2] }
  const text = encodeLog(HEADER, events)
  // Two flush frames: frame 0 = header + events 0..2, frame 1 = events 3..4.
  const lines = text.trimEnd().split('\n')
  const buffer = Buffer.concat([
    zstdCompressSync(Buffer.from(`${lines.slice(0, 4).join('\n')}\n`, 'utf8')),
    zstdCompressSync(Buffer.from(`${lines.slice(4).join('\n')}\n`, 'utf8')),
  ])
  const ranges = frameLineRanges(buffer, zstdDecompressSync)
  const { issue, events: scanned } = scanEvents(text, decodeStorageRecord, ranges)
  assert.equal(scanned[3].frame, 1, 'collision event should sit in frame 1')
  assert.equal(scanned[4].frame, 1)
  // Event 4 references seq 2: candidates are event 2 (frame 0) and event 3
  // (frame 1, same frame as the referencer) → binds to event 3.
  const plan = repairEvents(scanned, issue, { duplicateReference: 'segment' })
  assert.equal(plan.action, 'renumber')
  assert.equal(plan.events[4].data.sourceEventSeqs[0], 3)
})

test('segment strategy without frame info degrades to first', () => {
  const events = buildEvents([0, 1, 2, 2, 3])
  events[4].data = { sourceEventSeqs: [2] }
  const { issue } = scanEvents(encodeLog(HEADER, events), decodeStorageRecord) // no frames
  const plan = repairEvents(events, issue, { duplicateReference: 'segment' })
  assert.equal(plan.action, 'renumber')
  assert.equal(plan.events[4].data.sourceEventSeqs[0], 2)
})

/** Build a multi-frame artifact: frame 0 holds the header line plus the
 * first `frameRows` array; every further array is one flush frame's JSONL
 * rows (events, header-excluded), so tests can stage any writer-segment
 * layout. The arrays must cover ALL event rows in order. */
function artifactWithFrames(events, frameRows) {
  const lines = [HEADER, ...events.map(event => JSON.stringify(event))]
  const buffer = Buffer.concat([
    zstdCompressSync(Buffer.from(`${[lines[0], ...frameRows[0]].join('\n')}\n`, 'utf8')),
    ...frameRows.slice(1).map(rows => zstdCompressSync(Buffer.from(`${rows.join('\n')}\n`, 'utf8'))),
  ])
  const ranges = frameLineRanges(buffer, zstdDecompressSync)
  const { issue, events: scanned } = scanEvents(encodeLog(HEADER, events), decodeStorageRecord, ranges)
  return { buffer, issue, events: scanned }
}

test('segment with a seq repeated across three frames resolves to the same-frame occurrence, never the global last', () => {
  // Three occurrences of seq 2: event 2 (frame 0), event 3 (frame 1),
  // event 4 (frame 2). Event 3 (frame 1) references seq 2 — the UNIQUE
  // same-frame candidate is event 3 itself, but the old→new map's last
  // value for seq 2 is event 4's renumbered index. The strategy must bind
  // to the same-frame occurrence (3), not the global last (4).
  const events = buildEvents([0, 1, 2, 2, 2])
  events[3].data = { sourceEventSeqs: [2] }
  const rows = events.map(event => JSON.stringify(event))
  const { issue, events: scanned } = artifactWithFrames(events, [
    rows.slice(0, 3), // frame 0: header + events 0..2
    rows.slice(3, 4), // frame 1: event 3
    rows.slice(4, 5), // frame 2: event 4
  ])
  assert.equal(scanned[2].frame, 0)
  assert.equal(scanned[3].frame, 1, 'the referencing occurrence sits in frame 1')
  assert.equal(scanned[4].frame, 2, 'the later occurrence sits in frame 2')
  const plan = repairEvents(scanned, issue, { duplicateReference: 'segment' })
  assert.equal(plan.action, 'renumber')
  assert.equal(plan.events[3].data.sourceEventSeqs[0], 3,
    'segment must bind to the same-frame occurrence (3), not the global last (4)')
})

test('segment refuses when two occurrences share the referencing frame', () => {
  // Two occurrences of seq 2 inside ONE flush frame (frame 1) with the
  // referencer: a same-frame binding cannot be unique, so the repair must
  // REFUSE instead of guessing the last occurrence like the old map.get
  // path did.
  const events = buildEvents([0, 1, 2, 2, 2])
  events[4].data = { sourceEventSeqs: [2] }
  const rows = events.map(event => JSON.stringify(event))
  const { issue, events: scanned } = artifactWithFrames(events, [
    rows.slice(0, 3),       // frame 0: header + events 0..2
    rows.slice(3, 5),       // frame 1: events 3..4 (two occurrences + referencer)
  ])
  assert.equal(scanned[3].frame, 1)
  assert.equal(scanned[4].frame, 1, 'both collisions sit in frame 1 with the referencer')
  const plan = repairEvents(scanned, issue, { duplicateReference: 'segment' })
  assert.equal(plan.action, 'refuse', 'a non-unique same-frame binding must refuse')
  assert.equal(plan.refsChanged, 0)
  assert.ok(plan.ambiguous.length >= 1, 'the report must name the conflict')
  assert.equal(plan.ambiguous[0].sameFrameConflict, true)
  assert.ok(plan.message.includes('segment binding must be unique'), plan.message)
  assert.equal(plan.events[4].data.sourceEventSeqs[0], 2, 'the reference must stay untouched on refusal')
})

test('explicit strategies are stable and repeatable', () => {
  const build = () => {
    const events = buildEvents([0, 1, 2, 2, 3])
    events[4].data = { sourceEventSeqs: [2] }
    return events
  }
  const first = repairEvents(build(), scanEvents(encodeLog(HEADER, build()), decodeStorageRecord).issue, { duplicateReference: 'last' })
  const second = repairEvents(build(), scanEvents(encodeLog(HEADER, build()), decodeStorageRecord).issue, { duplicateReference: 'last' })
  assert.equal(encodeLog(HEADER, first.events), encodeLog(HEADER, second.events))
})

test('CLI refuses an ambiguous duplicate-seq log by default without writing', () => {
  const stub = makeDshStub()
  const events = buildEvents([0, 1, 2, 2, 3])
  events[4].data = { sourceEventSeqs: [2] }
  const buffer = compressLog(encodeLog(HEADER, events), zstdCompressSync)
  const home = makeFakeHome(buffer)
  const path = join(home, 'sessions', 'proj', 'sess-1', 'session.jsonl.zstd')
  const before = readFileSync(path)
  const result = runCli(['sess-1', '--yes', '--dsh-dir', stub, '--dsh-home', home])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /refusing automatic repair/)
  assert.match(result.stdout, /candidates: event 2 \(seq 2\), event 3 \(seq 2\)/)
  assert.match(result.stdout, /no write was performed/)
  assert.deepEqual(readFileSync(path), before, 'an ambiguous log must never be rewritten')
  assert.equal(readdirSync(join(home, 'sessions', 'proj', 'sess-1')).length, 1, 'no backup for a refused repair')
})

test('CLI --duplicate-reference first applies the strategy and prints the plan', () => {
  const stub = makeDshStub()
  const events = buildEvents([0, 1, 2, 2, 3])
  events[4].data = { sourceEventSeqs: [2] }
  const buffer = compressLog(encodeLog(HEADER, events), zstdCompressSync)
  const home = makeFakeHome(buffer)
  const path = join(home, 'sessions', 'proj', 'sess-1', 'session.jsonl.zstd')
  const result = runCli(['sess-1', '--yes', '--duplicate-reference', 'first', '--dsh-dir', stub, '--dsh-home', home])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /resolved as first/)
  const read = readLikeHarness(path)
  assert.equal(read.events.length, 5)
  read.events.forEach((event, index) => assert.equal(event.seq, index))
  // The repaired artifact's reference still points at the first occurrence (seq 2).
  assert.deepEqual(read.events[4].data.sourceEventSeqs, [2])
  const rescan = runCli(['sess-1', '--dsh-dir', stub, '--dsh-home', home])
  assert.equal(rescan.status, 0)
  assert.match(rescan.stdout, /nothing to repair/)
})

test('CLI accepts the README = form (--duplicate-reference=first)', () => {
  const stub = makeDshStub()
  const events = buildEvents([0, 1, 2, 2, 3])
  events[4].data = { sourceEventSeqs: [2] }
  const buffer = compressLog(encodeLog(HEADER, events), zstdCompressSync)
  const home = makeFakeHome(buffer)
  const result = runCli(['sess-1', '--yes', '--duplicate-reference=first', '--dsh-dir', stub, '--dsh-home', home])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /resolved as first/)
  const read = readLikeHarness(join(home, 'sessions', 'proj', 'sess-1', 'session.jsonl.zstd'))
  assert.equal(read.events.length, 5)
})

test('CLI --duplicate-reference=segment refuses a same-frame conflict and reports it', () => {
  // compressLog produces ONE content frame: every event shares the writer
  // segment, so both occurrences of seq 2 sit in the referencing event's
  // frame — the segment binding cannot be unique and the CLI must refuse
  // with the same-frame conflict report, never guess.
  const stub = makeDshStub()
  const events = buildEvents([0, 1, 2, 2, 3])
  events[4].data = { sourceEventSeqs: [2] }
  const buffer = compressLog(encodeLog(HEADER, events), zstdCompressSync)
  const home = makeFakeHome(buffer)
  const path = join(home, 'sessions', 'proj', 'sess-1', 'session.jsonl.zstd')
  const before = readFileSync(path)
  const result = runCli(['sess-1', '--yes', '--duplicate-reference', 'segment', '--dsh-dir', stub, '--dsh-home', home])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /segment binding must be unique/)
  assert.match(result.stdout, /same-frame conflict/)
  assert.match(result.stdout, /no write was performed/)
  assert.deepEqual(readFileSync(path), before, 'a same-frame conflict must never be rewritten')
  assert.equal(readdirSync(join(home, 'sessions', 'proj', 'sess-1')).length, 1, 'no backup for a refused repair')
})
