/**
 * Tests for the local-shell robustness primitives: the shell-word parser
 * for $VISUAL/$EDITOR commands and the bounded output accumulator that
 * caps card memory while tracking exact totals.
 * @module @xmoon76/dsh-pi-tui/shell-output.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { StringDecoder } from 'node:string_decoder'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseShellWords } from '../src/shell-words.ts'
import {
  createBoundedOutput,
  createFileCapture,
  formatBytes,
  formatTruncation,
  utf8Tail,
  SHELL_OUTPUT_CAP_BYTES,
  SHELL_OUTPUT_CAP_LINES,
} from '../src/bounded-output.ts'

// --- shell-word parsing ($VISUAL / $EDITOR) ---

test('plain commands split on whitespace', () => {
  assert.deepEqual(parseShellWords('vi'), ['vi'])
  assert.deepEqual(parseShellWords('code --wait'), ['code', '--wait'])
  assert.deepEqual(parseShellWords('  vim   -f  '), ['vim', '-f'])
})

test('quoted arguments with spaces stay one word', () => {
  assert.deepEqual(parseShellWords('"/Applications/Visual Studio Code.app/Contents/MacOS/Code" --wait'), [
    '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
    '--wait',
  ])
  assert.deepEqual(parseShellWords("'my editor' -f"), ['my editor', '-f'])
  assert.deepEqual(parseShellWords('editor "file with spaces.md"'), ['editor', 'file with spaces.md'])
})

test('single quotes are fully literal; double quotes honor backslash escapes', () => {
  assert.deepEqual(parseShellWords("echo 'a\\b'"), ['echo', 'a\\b'])
  assert.deepEqual(parseShellWords('echo "a\\"b"'), ['echo', 'a"b'])
  assert.deepEqual(parseShellWords('echo "a\\\\b"'), ['echo', 'a\\b'])
  // A backslash before a non-special char inside double quotes stays.
  assert.deepEqual(parseShellWords('echo "a\\nb"'), ['echo', 'a\\nb'])
})

test('backslash escapes outside quotes drop the backslash; trailing one is kept', () => {
  assert.deepEqual(parseShellWords('echo a\\ b'), ['echo', 'a b'])
  assert.deepEqual(parseShellWords('echo foo\\'), ['echo', 'foo\\'])
})

test('unbalanced quotes consume the rest of the line without throwing', () => {
  assert.deepEqual(parseShellWords("editor 'oops"), ['editor', 'oops'])
  assert.deepEqual(parseShellWords(''), [])
})

// --- bounded output ---

test('small output is retained whole with exact totals', () => {
  const out = createBoundedOutput()
  out.append('line one\n')
  out.append('line two\n')
  assert.equal(out.tail, 'line one\nline two')
  assert.equal(out.totalBytes, 18)
  assert.equal(out.totalLines, 2)
  assert.equal(out.truncated, false)
})

test('partial lines continue across chunks', () => {
  const out = createBoundedOutput()
  out.append('line ')
  out.append('one\nnext')
  assert.equal(out.tail, 'line one\nnext')
  assert.equal(out.totalLines, 1)
  out.append('!\n')
  assert.equal(out.tail, 'line one\nnext!')
  assert.equal(out.totalLines, 2)
})

test('the line cap bounds memory and flags truncation with accurate totals', () => {
  const out = createBoundedOutput(1024 * 1024, 10)
  for (let i = 0; i < 100; i += 1) out.append(`line ${i}\n`)
  assert.equal(out.truncated, true)
  assert.equal(out.totalLines, 100)
  assert.equal(out.tail.split('\n').length, 10, 'only the tail lines are retained')
  assert.ok(out.tail.startsWith('line 90'), 'the tail keeps the LAST lines')
  assert.ok(out.totalBytes > 500, 'totals count everything received')
})

test('the byte cap bounds memory even for huge lines', () => {
  const out = createBoundedOutput(64, 1000)
  const big = 'x'.repeat(10_000)
  out.append(`${big}\n`)
  out.append('tail\n')
  assert.equal(out.truncated, true)
  assert.ok(out.tail.length <= 1000 + 10, `tail bounded: ${out.tail.length}`)
  assert.equal(out.totalBytes, 10_006)
  assert.ok(out.tail.endsWith('tail'), 'the newest content survives')
})

test('an unbounded stream never grows the retained tail', () => {
  const out = createBoundedOutput(SHELL_OUTPUT_CAP_BYTES, SHELL_OUTPUT_CAP_LINES)
  for (let i = 0; i < 20_000; i += 1) out.append(`spam line ${i} with some padding 0123456789\n`)
  assert.equal(out.truncated, true)
  assert.ok(out.tail.length <= SHELL_OUTPUT_CAP_BYTES, `tail within the byte cap: ${out.tail.length}`)
  assert.ok(out.tail.split('\n').length <= SHELL_OUTPUT_CAP_LINES)
})

test('formatBytes renders human-readable sizes', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1.0 KiB')
  assert.equal(formatBytes(262_144), '256.0 KiB')
  assert.equal(formatBytes(12_900_000), '12.3 MiB')
})

// --- unterminated (no-newline) output must stay bounded ---

test('a stream that never emits a newline cannot grow memory beyond the byte cap', () => {
  const out = createBoundedOutput(64, 1000)
  // 10 MiB of newline-free output in chunked form (a runaway `dd` / `yes`
  // without newlines would deliver exactly this shape).
  const chunk = 'a'.repeat(4096)
  for (let i = 0; i < 2560; i += 1) out.append(chunk)
  assert.equal(out.truncated, true)
  assert.ok(out.tail.length <= 64, `unterminated tail must respect the byte cap, got ${out.tail.length} chars`)
  assert.equal(out.totalBytes, 10_485_760, 'totals still count every received byte')
})

test('an unterminated tail exceeding the cap keeps only the newest suffix', () => {
  const out = createBoundedOutput(32, 1000)
  out.append('older-line\n')
  out.append('A'.repeat(60)) // partial alone (60) > cap (32)
  assert.equal(out.truncated, true)
  assert.ok(!out.tail.includes('older-line'), 'older completed lines must be dropped once the partial alone exceeds the cap')
  assert.equal(out.tail, 'A'.repeat(32), 'the visible tail is the UTF-8-safe suffix of the partial')
  assert.ok(out.totalBytes >= 60, 'totals still count the dropped prefix')
})

test('a truncated partial followed by a newline does not re-introduce the dropped prefix', () => {
  const out = createBoundedOutput(16, 1000)
  out.append('A'.repeat(26)) // partial alone (26) > cap (16)
  assert.ok(out.truncated)
  assert.equal(out.tail, 'A'.repeat(16), 'the partial is cut to the cap')
  out.append('\nfinal-line\n') // the truncated partial completes as a line
  // The completed partial line (16 A) plus final-line exceeds the byte cap,
  // so the OLD line is dropped and only the newest content survives — the
  // discarded 10-A prefix can never come back through a later newline.
  assert.ok(!out.tail.includes('A'), 'the dropped prefix must stay gone')
  assert.equal(out.tail, 'final-line', 'the byte cap stays a hard limit across newlines')
})

test('multi-byte characters at the cap boundary are never split into invalid UTF-8', () => {
  const out = createBoundedOutput(32, 1000)
  // 40 CJK chars = 120 bytes, no newline: the tail must end on a character
  // boundary and decode cleanly.
  const cjk = '测'.repeat(40)
  out.append(cjk)
  assert.equal(out.truncated, true)
  const tail = out.tail
  assert.ok(Buffer.from(tail, 'utf8').length <= 32, `byte-capped: ${Buffer.byteLength(tail, 'utf8')}`)
  assert.equal(Buffer.from(tail, 'utf8').toString('utf8'), tail, 'tail must round-trip as valid UTF-8')
  // Emoji (ZWJ sequences) too: the cap may cut mid-sequence, but never
  // mid-code-point.
  const emoji = '🐋'.repeat(20)
  out.append(emoji)
  const emojiTail = out.tail
  assert.equal(Buffer.from(emojiTail, 'utf8').toString('utf8'), emojiTail, 'emoji tail must be valid UTF-8')
})

test('byte and line caps can trigger together; both stay enforced', () => {
  const out = createBoundedOutput(48, 3)
  for (let i = 0; i < 20; i += 1) out.append(`short line ${i}\n`)
  // 20 short lines exceed the 3-line cap but not 48 bytes; a big
  // unterminated run then forces the byte cap.
  out.append('z'.repeat(200))
  assert.equal(out.truncated, true)
  assert.ok(out.tail.split('\n').length <= 3 + 1, 'line cap still applies to completed lines')
  assert.ok(Buffer.byteLength(out.tail, 'utf8') <= 48 + 4, 'byte cap holds with the partial counted')
})

test('utf8Tail cuts at a character boundary', () => {
  assert.equal(utf8Tail('abcdef', 4), 'cdef')
  assert.equal(utf8Tail('测测测', 5), '测', 'a split code point is dropped whole')
  assert.equal(utf8Tail('abc测', 5), 'bc测')
  assert.equal(utf8Tail('abc', 100), 'abc')
  assert.equal(utf8Tail('', 10), '')
})

// --- the byte cap must cover the visible tail INCLUDING newline separators ---

test('the byte cap counts the newline separators of the visible tail', () => {
  const out = createBoundedOutput(2, 4000)
  out.append('a\nb\nc\nd\n')
  // Lines 'a','b','c','d' are 1 byte each; with separators the retained
  // tail must stay within the 2-byte cap (only 'd' fits).
  assert.equal(out.truncated, true)
  assert.equal(out.tail, 'd')
  assert.ok(Buffer.byteLength(out.tail, 'utf8') <= 2, `tail bytes: ${Buffer.byteLength(out.tail, 'utf8')}`)
  assert.equal(out.totalLines, 4)
})

test('the byte cap holds across tiny caps with empty and single-char lines', () => {
  for (const cap of [1, 2, 3]) {
    const out = createBoundedOutput(cap, 4000)
    // Mix of empty lines, single chars, and two-char lines.
    out.append('\n')
    out.append('a\n')
    out.append('\n')
    out.append('bb\n')
    out.append('c\n')
    out.append('\n')
    assert.ok(Buffer.byteLength(out.tail, 'utf8') <= cap,
      `cap ${cap}: tail ${JSON.stringify(out.tail)} is ${Buffer.byteLength(out.tail, 'utf8')} bytes`)
  }
})

test('every append keeps the visible tail within the byte cap (separators included)', () => {
  const out = createBoundedOutput(16, 4000)
  for (let i = 0; i < 500; i += 1) {
    out.append(`line ${i} padding padding padding\n`)
    assert.ok(Buffer.byteLength(out.tail, 'utf8') <= 16,
      `append ${i}: tail ${Buffer.byteLength(out.tail, 'utf8')} bytes > cap 16`)
  }
})

test('an unterminated tail with completed lines stays within the cap including the join separator', () => {
  const out = createBoundedOutput(8, 4000)
  out.append('aaaa\nbbbb\n') // 4+1+4 = 9 bytes visible → one line must go
  assert.ok(Buffer.byteLength(out.tail, 'utf8') <= 8, `tail: ${JSON.stringify(out.tail)}`)
  out.append('cc') // unterminated: tail becomes 'bbbb\ncc' → 4+1+2 = 7
  assert.ok(Buffer.byteLength(out.tail, 'utf8') <= 8, `tail: ${JSON.stringify(out.tail)}`)
  out.append('d') // 'bbbb\nccd' = 8 → still fits
  assert.ok(Buffer.byteLength(out.tail, 'utf8') <= 8, `tail: ${JSON.stringify(out.tail)}`)
  out.append('e') // 9 > 8 → the completed line must drop
  assert.equal(out.tail, 'ccde')
  assert.ok(Buffer.byteLength(out.tail, 'utf8') <= 8, `tail: ${JSON.stringify(out.tail)}`)
})

test('multi-byte characters split across Buffer chunks decode intact (StringDecoder)', () => {
  // The runner decodes stdout/stderr through a StringDecoder: a UTF-8
  // character split across two chunks must not become a replacement
  // character. Feed a 3-byte CJK char and a 4-byte emoji one byte at a time.
  const decoder = new StringDecoder('utf8')
  const out = createBoundedOutput()
  for (const char of ['测', '🐋']) {
    const bytes = Buffer.from(char, 'utf8')
    for (let i = 0; i < bytes.length; i += 1) {
      const text = decoder.write(bytes.subarray(i, i + 1))
      out.append(text, 1) // one wire byte per feed, like the runner's onData
    }
  }
  const tail = decoder.end()
  if (tail !== '') out.append(tail, 0)
  assert.ok(out.tail.includes('测'), `CJK char must survive split chunks: ${JSON.stringify(out.tail)}`)
  assert.ok(out.tail.includes('🐋'), `emoji must survive split chunks: ${JSON.stringify(out.tail)}`)
  assert.ok(!out.tail.includes('\uFFFD'), `no replacement characters:\n${JSON.stringify(out.tail)}`)
  assert.equal(out.totalWireBytes, 7, 'wire totals count the raw bytes')
  assert.equal(out.totalBytes, 7, 'display totals count the decoded text')
  assert.equal(Buffer.byteLength(out.tail, 'utf8'), 7, 'displayed bytes match the decoded content')
})

test('an incomplete trailing sequence is VISIBLE and its wire bytes count', () => {
  // stdout ends mid-character: one raw byte 0xe6 (the first byte of 测).
  // The decoder buffers it; end() surfaces U+FFFD. The byte must not be
  // silently dropped from the display NOR from the totals.
  const decoder = new StringDecoder('utf8')
  const out = createBoundedOutput()
  const partial = Buffer.from([0xe6])
  out.append(decoder.write(partial), partial.length) // no text yet, 1 wire byte
  const tail = decoder.end()
  if (tail !== '') out.append(tail, 0) // U+FFFD shown; bytes already counted
  assert.ok(out.tail.includes('\uFFFD'), `the incomplete sequence is visible, not silently dropped: ${JSON.stringify(out.tail)}`)
  assert.equal(out.totalWireBytes, 1, 'wire totals count the raw byte')
  assert.equal(out.totalBytes, Buffer.byteLength(out.tail, 'utf8'), 'display totals count the decoded text')
})

test('stdout and stderr use SEPARATE decoders: interleaved streams stay intact', () => {
  // The runner decodes each stream through its OWN StringDecoder. A CJK
  // character split across stdout chunks, with an interleaved stderr
  // write in between, must not corrupt either stream (a shared decoder
  // would merge the streams' partial sequences).
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  const out = createBoundedOutput()
  const cjk = Buffer.from('测', 'utf8') // 3 bytes
  // stdout: first byte of 测 → stderr: ASCII 'ERR' → stdout: remaining bytes.
  out.append(stdoutDecoder.write(cjk.subarray(0, 1)), 1)
  out.append(stderrDecoder.write(Buffer.from('ERR')), 3)
  out.append(stdoutDecoder.write(cjk.subarray(1, 3)), 2)
  const tailOut = stdoutDecoder.end()
  const tailErr = stderrDecoder.end()
  if (tailOut !== '') out.append(tailOut, 0)
  if (tailErr !== '') out.append(tailErr, 0)
  assert.ok(out.tail.includes('测'), `CJK char must survive interleaving: ${JSON.stringify(out.tail)}`)
  assert.ok(out.tail.includes('ERR'), `stderr must survive interleaving: ${JSON.stringify(out.tail)}`)
  assert.ok(!out.tail.includes('\uFFFD'), `no replacement characters:\n${JSON.stringify(out.tail)}`)
  assert.equal(out.totalWireBytes, 6, 'wire totals count the raw bytes (3-byte CJK + 3 ASCII)')
  assert.equal(out.totalBytes, 6, 'display totals count the decoded text')
  assert.equal(Buffer.byteLength(out.tail, 'utf8'), 6, 'displayed bytes match')
})

// --- the bounded full-output file capture ---

test('file capture writes everything up to the cap, then stops and flags truncation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-capture-'))
  const path = join(dir, 'full.log')
  const capture = createFileCapture(path, 64)
  assert.equal(capture.active, true)
  capture.append(Buffer.from('x'.repeat(40)))
  assert.equal(capture.truncated, false)
  capture.append(Buffer.from('y'.repeat(40))) // 80 more: only 24 fit
  assert.equal(capture.truncated, true, 'the disk cap must flag truncation')
  assert.equal(capture.active, false, 'the capture closes once the cap is reached')
  capture.close()
  const size = statSync(path).size
  assert.equal(size, 64, `the file holds exactly the cap: ${size}`)
  const content = readFileSync(path, 'utf8')
  assert.equal(content, 'x'.repeat(40) + 'y'.repeat(24), 'the file keeps the FIRST bytes (the head, unlike the tail)')
})

test('file capture dispose deletes the file and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-capture-'))
  const path = join(dir, 'full.log')
  const capture = createFileCapture(path)
  capture.append(Buffer.from('data'))
  capture.dispose()
  assert.equal(existsSync(path), false, 'dispose must delete the file')
  assert.equal(capture.active, false)
  capture.dispose() // idempotent: no throw
  assert.equal(readdirSync(dir).length, 0)
})

test('file capture close keeps the file for later reading', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-capture-'))
  const path = join(dir, 'full.log')
  const capture = createFileCapture(path)
  capture.append(Buffer.from('hello capture'))
  capture.close()
  assert.equal(capture.exists, true, 'close must keep the file')
  assert.equal(capture.active, false, 'close must stop the capture')
  assert.equal(existsSync(path), true, 'close must keep the file on disk')
  assert.equal(readFileSync(path, 'utf8'), 'hello capture')
  capture.dispose()
})

test('file capture open failure yields an inactive capture that is safe to call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-capture-'))
  // A path whose parent does not exist cannot be opened.
  const capture = createFileCapture(join(dir, 'missing', 'nested', 'full.log'))
  assert.equal(capture.active, false, 'an unopenable path must be inactive')
  assert.equal(capture.truncated, false)
  capture.append(Buffer.from('x')) // no-op
  capture.close() // no-op
  capture.dispose() // no-op, no throw
  assert.equal(existsSync(capture.path), false)
})

test('wire and display totals stay independent under invalid bytes (no contradictory report)', () => {
  // The review's scenario: 100k raw invalid bytes decode to 3-byte U+FFFD
  // each — the DISPLAY cap applies to the decoded text while the WIRE
  // total counts the raw input. The two must never be conflated.
  const decoder = new StringDecoder('utf8')
  const out = createBoundedOutput(256 * 1024, 4000) // display cap 256 KiB
  // 200k invalid lead bytes decode to ~100k U+FFFD (3 display bytes each),
  // so the DISPLAY (≈300 KiB) exceeds the cap while the WIRE total counts
  // the 200k raw bytes — the two must never be conflated. A single batch
  // write (StringDecoder handles it internally) keeps this millisecond-fast.
  const bytes = Buffer.alloc(200_000, 0xe6)
  const text = decoder.write(bytes)
  out.append(text, bytes.length)
  const tail = decoder.end()
  if (tail !== '') out.append(tail, 0)
  assert.equal(out.totalWireBytes, 200_000, 'wire totals count every raw byte')
  assert.ok(out.truncated, 'the display cap still applies')
  assert.ok(Buffer.byteLength(out.tail, 'utf8') <= 256 * 1024, 'the retained DISPLAY stays within the display cap')
  assert.notEqual(out.totalWireBytes, out.totalBytes, 'wire and display totals diverge under invalid bytes')
})

test('the truncation line reports ACTUAL retained values, never the caps', () => {
  // Line cap 3 with 5000 lines: retained is 3 lines / ~37 bytes, NOT the
  // configured 4000 lines / byte cap.
  const out = createBoundedOutput(1024 * 1024, 3)
  for (let i = 0; i < 5000; i += 1) out.append(`line ${i}\n`)
  const line = formatTruncation(out)
  assert.ok(line.includes('/ 3 lines'), `actual retained lines:\n${line}`)
  assert.ok(!line.includes('1.0 MiB'), 'the byte cap must never be reported as retained')
  assert.ok(line.includes('5000 lines total'), `wire total:\n${line}`)
  assert.ok(line.includes('retained'), line)
})
