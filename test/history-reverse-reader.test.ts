/**
 * Headless tests for the reverse JSONL batch reader (history-reverse-reader.ts):
 * newest-first ordering, chunk-boundary correctness (cross-chunk rows, UTF-8
 * splits, oversized rows), cursor continuation without gaps/duplicates,
 * abort, and revision-bound cursor invalidation. Pure filesystem — no
 * terminal, no dsh services.
 * @module @xmoon76/dsh-pi-tui/history-reverse-reader.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonlReverseBatch, ReverseJsonlRevisionError } from '../src/history-reverse-reader.ts'
import type { ReverseJsonlCursor, ReverseJsonlLine } from '../src/history-reverse-reader.ts'

function tempFile(content: string | Buffer): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tui-reverse-jsonl-'))
  const file = join(dir, 'h.jsonl')
  writeFileSync(file, content)
  return { file, dir }
}

/** Read the whole file newest-first via repeated batches. */
async function readAll(
  file: string,
  opts: { chunkBytes?: number; maxRows?: number } = {},
): Promise<ReverseJsonlLine[]> {
  const lines: ReverseJsonlLine[] = []
  let cursor: ReverseJsonlCursor | undefined
  for (;;) {
    const batch = await readJsonlReverseBatch(file, {
      cursor,
      maxRows: opts.maxRows ?? 128,
      chunkBytes: opts.chunkBytes ?? 64 * 1024,
    })
    lines.push(...batch.lines)
    if (batch.eof) return lines
    cursor = batch.nextCursor
  }
}

test('newest-first: lines come back in reverse file order', async () => {
  const { file, dir } = tempFile('a\nb\nc\n')
  try {
    const lines = await readAll(file)
    assert.deepEqual(lines.map(line => line.text), ['c', 'b', 'a'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('with and without a final newline', async () => {
  const withNl = tempFile('a\nb\n')
  const withoutNl = tempFile('a\nb')
  try {
    assert.deepEqual((await readAll(withNl.file)).map(line => line.text), ['b', 'a'])
    assert.deepEqual((await readAll(withoutNl.file)).map(line => line.text), ['b', 'a'])
  } finally {
    rmSync(withNl.dir, { recursive: true, force: true })
    rmSync(withoutNl.dir, { recursive: true, force: true })
  }
})

test('a single row spanning multiple chunks is reassembled with exact byte ranges', async () => {
  // 'x'*200 + '\n' + 'tail\n': the big row is bytes [0,200), 'tail' is [201,205).
  const { file, dir } = tempFile('x'.repeat(200) + '\n' + 'tail\n')
  try {
    const lines = await readAll(file, { chunkBytes: 64 })
    assert.deepEqual(lines.map(line => line.text), ['tail', 'x'.repeat(200)])
    const tail = lines[0]!
    assert.equal(tail.byteStart, 201)
    assert.equal(tail.byteEnd, 205)
    const big = lines[1]!
    assert.equal(big.byteStart, 0)
    assert.equal(big.byteEnd, 200)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('UTF-8/CJK code points split by a chunk boundary decode intact', async () => {
  // Each 你 is 3 bytes; a 5-byte chunk boundary cuts code points mid-sequence.
  const content = '你'.repeat(100) + '\n'
  const { file, dir } = tempFile(content)
  try {
    const lines = await readAll(file, { chunkBytes: 5 })
    assert.deepEqual(lines.map(line => line.text), ['你'.repeat(100)])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('JSON-escaped multiline content stays one physical line', async () => {
  const row = JSON.stringify({ content: 'line one\nline two\nline three' })
  const { file, dir } = tempFile(row + '\n')
  try {
    const lines = await readAll(file)
    assert.deepEqual(lines.map(line => line.text), [row])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corrupt rows are returned verbatim (the parser decides to skip them)', async () => {
  const { file, dir } = tempFile('not json\n{"content":"ok"}\n')
  try {
    const lines = await readAll(file)
    assert.deepEqual(lines.map(line => line.text), ['{"content":"ok"}', 'not json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a 256KiB+ oversized row is read fully across many chunks', async () => {
  const big = 'x'.repeat(300 * 1024)
  const { file, dir } = tempFile(big + '\n')
  try {
    const lines = await readAll(file, { chunkBytes: 64 * 1024 })
    assert.deepEqual(lines.map(line => line.text), [big])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cursor continuation: no gaps, no duplicates, contiguous byte coverage', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => `line-${i}`)
  const { file, dir } = tempFile(rows.join('\n') + '\n')
  try {
    const lines = await readAll(file, { chunkBytes: 64, maxRows: 37 })
    assert.equal(lines.length, 1000)
    // Newest first, exactly once each.
    assert.deepEqual(lines.map(line => line.text), [...rows].reverse())
    // The byte ranges tile the file's content: each line's range is
    // followed by exactly its terminating `\n` (the file ends with one),
    // so byteEnd + 1 == the next line's byteStart, and the oldest line
    // starts at byte 0 — no overlap, no gap, no lost byte.
    const size = Buffer.byteLength(rows.join('\n') + '\n')
    let expectedEnd = size
    for (const line of lines) {
      assert.equal(line.byteEnd + 1, expectedEnd, `byteEnd of ${line.text}`)
      expectedEnd = line.byteStart
    }
    assert.equal(expectedEnd, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('maxRows=1 walks the file one line per batch without loss', async () => {
  const { file, dir } = tempFile('a\nb\nc\nd\n')
  try {
    const lines = await readAll(file, { maxRows: 1 })
    assert.deepEqual(lines.map(line => line.text), ['d', 'c', 'b', 'a'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty file is exhausted immediately', async () => {
  const { file, dir } = tempFile('')
  try {
    const batch = await readJsonlReverseBatch(file, { maxRows: 10, chunkBytes: 64 })
    assert.equal(batch.eof, true)
    assert.deepEqual(batch.lines, [])
    assert.equal(batch.nextCursor, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('blank lines survive chunk boundaries (the scan===0 empty-line case)', async () => {
  // 'a\n\nb': the empty line between the two newlines spans the chunk
  // boundary at byte 2 — it must not be lost.
  const { file, dir } = tempFile('a\n\nb')
  try {
    const lines = await readAll(file, { chunkBytes: 2 })
    assert.deepEqual(lines.map(line => line.text), ['b', '', 'a'])
    const blank = lines[1]!
    assert.equal(blank.byteStart, 2)
    assert.equal(blank.byteEnd, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a newlines-only file yields its blank lines', async () => {
  const { file, dir } = tempFile('\n\n')
  try {
    const lines = await readAll(file)
    assert.deepEqual(lines.map(line => line.text), ['', ''])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('intra-search batches tolerate a concurrent append (snapshot semantics)', async () => {
  const { file, dir } = tempFile('a\nb\nc\n')
  try {
    const first = await readJsonlReverseBatch(file, { maxRows: 1, chunkBytes: 64 })
    assert.equal(first.eof, false)
    // A concurrent append between batches of the SAME search: the scan
    // continues from the snapshot boundary and the appended row is simply
    // not part of this generation (verifyRevision is false intra-search).
    writeFileSync(file, 'a\nb\nc\nd\n')
    const second = await readJsonlReverseBatch(file, {
      cursor: first.nextCursor,
      maxRows: 1,
      chunkBytes: 64,
      verifyRevision: false,
    })
    assert.equal(second.lines.length, 1)
    assert.equal(second.lines[0]?.text, 'b')
    const third = await readJsonlReverseBatch(file, {
      cursor: second.nextCursor,
      maxRows: 1,
      chunkBytes: 64,
      verifyRevision: false,
    })
    assert.equal(third.lines[0]?.text, 'a')
    assert.equal(third.eof, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('abort stops the scan with an AbortError', async () => {
  const rows = Array.from({ length: 2000 }, (_, i) => `row-${i}`)
  const { file, dir } = tempFile(rows.join('\n') + '\n')
  try {
    const controller = new AbortController()
    const first = await readJsonlReverseBatch(file, {
      maxRows: 10,
      chunkBytes: 64,
      signal: controller.signal,
    })
    assert.equal(first.lines.length, 10)
    assert.equal(first.eof, false)
    controller.abort()
    await assert.rejects(
      readJsonlReverseBatch(file, {
        cursor: first.nextCursor,
        maxRows: 10,
        chunkBytes: 64,
        signal: controller.signal,
      }),
      (error: unknown) => (error as Error).name === 'AbortError',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a cursor is invalidated when the file size changes', async () => {
  const { file, dir } = tempFile('a\nb\nc\n')
  try {
    const first = await readJsonlReverseBatch(file, { maxRows: 1, chunkBytes: 64 })
    assert.equal(first.eof, false)
    // Append: the revision (size) changed — the old cursor must not be reused.
    writeFileSync(file, 'a\nb\nc\nd\n')
    await assert.rejects(
      readJsonlReverseBatch(file, { cursor: first.nextCursor, maxRows: 1, chunkBytes: 64 }),
      (error: unknown) => error instanceof ReverseJsonlRevisionError,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a cursor is invalidated when the mtime changes', async () => {
  const { file, dir } = tempFile('a\nb\nc\n')
  try {
    const first = await readJsonlReverseBatch(file, { maxRows: 1, chunkBytes: 64 })
    assert.equal(first.eof, false)
    // Touch the file (same content, new mtime): the revision changed.
    const future = new Date(Date.now() + 60_000)
    const { utimesSync } = await import('node:fs')
    utimesSync(file, future, future)
    await assert.rejects(
      readJsonlReverseBatch(file, { cursor: first.nextCursor, maxRows: 1, chunkBytes: 64 }),
      (error: unknown) => error instanceof ReverseJsonlRevisionError,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
