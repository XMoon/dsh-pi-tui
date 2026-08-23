/**
 * Headless tests for the per-cwd input-history store (history.ts): the
 * md5(cwd) JSONL file layout, corrupt-line tolerance, the HISTORY_LIMIT
 * trim, and the append rules (empty/duplicate skip, multi-line escaping).
 * The runner wiring (file load on session init, append on submit, legacy
 * settings migration) lives in index.ts and is exercised end-to-end by the
 * tmux suite; these tests pin the pure storage contract.
 * @module @xmoon76/dsh-pi-tui/history.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HISTORY_RECALL_LIMIT,
  appendHistoryLine,
  appendHistoryRecord,
  historyFilePath,
  historyFilePathFromHash,
  loadHistoryFile,
  loadHistoryRecords,
  loadRecallHistory,
  parseHistoryLines,
  parseHistoryRecords,
} from '../src/history.ts'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'pi-tui-history-'))
}

test('historyFilePath derives a stable md5(cwd) JSON-lines path under the home', () => {
  const home = '/dsh-data'
  const a = historyFilePath(home, '/work/alpha')
  assert.ok(a.startsWith(join(home, 'user-history', '')), a)
  assert.ok(a.endsWith('.jsonl'), a)
  // Deterministic and cwd-scoped: the same cwd maps to one file, a
  // different cwd to another.
  assert.equal(historyFilePath(home, '/work/alpha'), a)
  assert.notEqual(historyFilePath(home, '/work/beta'), a)
  // The hash keeps the filename free of path separators.
  assert.ok(!a.split('/').pop()!.includes('/'), a)
})

test('historyFilePathFromHash round-trips the hash of a canonical path', () => {
  const home = '/dsh-data'
  const cwd = '/work/alpha'
  const file = historyFilePath(home, cwd)
  const hash = file.split('/').pop()!.replace(/\.jsonl$/, '')
  assert.equal(historyFilePathFromHash(home, hash), file)
})

test('parseHistoryLines keeps v1 contents: skips blank and corrupt lines, keeps escaped multi-line content', () => {
  const text = [
    '{"content": "hello"}',
    '',
    'not json at all',
    '{"content": 42}',
    '{"content": "multi\\nline paste"}',
  ].join('\n')
  // The file stores a multi-line paste as ONE JSON line (newline escaped),
  // so the line split survives it; JSON.parse restores the real newline.
  assert.deepEqual(parseHistoryLines(text), ['hello', 'multi\nline paste'])
})

test('parseHistoryRecords reads v1 rows with null metadata', () => {
  const records = parseHistoryRecords('{"content":"hello"}\n{"content":"again"}')
  assert.deepEqual(records, [
    { content: 'hello', cwd: null, ts: null, version: 1 },
    { content: 'again', cwd: null, ts: null, version: 1 },
  ])
})

test('parseHistoryRecords keeps v2 metadata and tolerates unknown future fields', () => {
  const records = parseHistoryRecords('{"v":2,"content":"a","cwd":"/a","ts":100,"future":123}')
  assert.deepEqual(records, [{ content: 'a', cwd: '/a', ts: 100, version: 2 }])
})

test('parseHistoryRecords degrades invalid v2 metadata instead of dropping the row', () => {
  // Missing/non-string cwd and non-number ts: content stays, metadata is
  // not trusted (never fabricated).
  const records = parseHistoryRecords(
    '{"v":2,"content":"no cwd","ts":100}\n{"v":2,"content":"no ts","cwd":"/a"}\n{"v":2,"content":"bad ts","cwd":"/a","ts":"soon"}',
  )
  assert.deepEqual(records, [
    { content: 'no cwd', cwd: null, ts: 100, version: 2 },
    { content: 'no ts', cwd: '/a', ts: null, version: 2 },
    { content: 'bad ts', cwd: '/a', ts: null, version: 2 },
  ])
})

test('parseHistoryRecords skips corrupt rows without aborting the file', () => {
  const records = parseHistoryRecords('not json\n{"content":"ok"}\n{"content": 42}\n{"v":3,"content":"?"}')
  // v3 (or any unknown version) is treated as legacy content-only — future
  // schemas must not poison the parse.
  assert.deepEqual(records.map(record => record.content), ['ok', '?'])
})

test('loadHistoryFile returns [] for an absent file and never throws', () => {
  const home = tempHome()
  try {
    assert.deepEqual(loadHistoryFile(historyFilePath(home, '/no/such/cwd')), [])
    assert.deepEqual(loadHistoryRecords(historyFilePath(home, '/no/such/cwd')), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('appendHistoryRecord and loadHistoryRecords round-trip v2 metadata in file order', () => {
  const home = tempHome()
  try {
    const file = historyFilePath(home, '/work/alpha')
    assert.equal(appendHistoryRecord(file, { v: 2, content: 'first', cwd: '/work/alpha', ts: 42 }, undefined), true)
    assert.equal(appendHistoryRecord(file, { v: 2, content: 'second', cwd: '/work/alpha', ts: 43, sessionId: 'ses_1' }, 'first'), true)
    // Empty and consecutive repeats are skipped.
    assert.equal(appendHistoryRecord(file, { v: 2, content: '   ', cwd: '/work/alpha', ts: 44 }, 'second'), false)
    assert.equal(appendHistoryRecord(file, { v: 2, content: 'second', cwd: '/work/alpha', ts: 45 }, 'second'), false)
    // Non-consecutive repeats are legal history.
    assert.equal(appendHistoryRecord(file, { v: 2, content: 'first', cwd: '/work/alpha', ts: 46 }, 'second'), true)
    const records = loadHistoryRecords(file)
    assert.deepEqual(records, [
      { content: 'first', cwd: '/work/alpha', ts: 42, version: 2 },
      { content: 'second', cwd: '/work/alpha', ts: 43, sessionId: 'ses_1', version: 2 },
      { content: 'first', cwd: '/work/alpha', ts: 46, version: 2 },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadHistoryFile reads v2 rows as recall content and never rewrites the file', () => {
  const home = tempHome()
  try {
    const file = historyFilePath(home, '/work/alpha')
    appendHistoryRecord(file, { v: 2, content: 'v2 row', cwd: '/work/alpha', ts: 42 }, undefined)
    appendHistoryLine(file, 'legacy row', undefined)
    assert.deepEqual(loadHistoryFile(file), ['v2 row', 'legacy row'])
    // The file still holds BOTH rows (v2 + v1) — reading never rewrites.
    assert.equal(loadHistoryRecords(file).length, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('appendHistoryLine and loadHistoryFile round-trip in file order', () => {
  const home = tempHome()
  try {
    const file = historyFilePath(home, '/work/alpha')
    assert.equal(appendHistoryLine(file, 'first', undefined), true)
    assert.equal(appendHistoryLine(file, 'second', 'first'), true)
    // Empty and consecutive repeats are skipped.
    assert.equal(appendHistoryLine(file, '   ', 'second'), false)
    assert.equal(appendHistoryLine(file, 'second', 'second'), false)
    // Non-consecutive repeats are legal history.
    assert.equal(appendHistoryLine(file, 'first', 'second'), true)
    assert.deepEqual(loadHistoryFile(file), ['first', 'second', 'first'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('read over HISTORY_RECALL_LIMIT caps the recall to the newest entries WITHOUT truncating the file', () => {
  const home = tempHome()
  try {
    const file = join(home, 'user-history', 'big.jsonl')
    for (let index = 0; index < HISTORY_RECALL_LIMIT + 20; index += 1) {
      appendHistoryLine(file, `entry ${index}`, undefined)
    }
    const recalled = loadRecallHistory(file)
    assert.equal(recalled.length, HISTORY_RECALL_LIMIT)
    // Empty-query recall is newest-first for the editor's reverse; the
    // store itself returns oldest-first of the KEPT tail.
    assert.equal(recalled[0], 'entry 20')
    assert.equal(recalled[recalled.length - 1], `entry ${HISTORY_RECALL_LIMIT + 19}`)
    // The canonical file still holds EVERY row — a read must never trim
    // it (that trim used to destroy the >100-rows a Ctrl+R search needs).
    const lines = loadHistoryRecords(file)
    assert.equal(lines.length, HISTORY_RECALL_LIMIT + 20)
    assert.equal(lines[0]?.content, 'entry 0')
    const statBefore = statSync(file)
    // And a second read leaves the file byte-identical (no rewrite at all).
    loadHistoryFile(file)
    const statAfter = statSync(file)
    assert.equal(statAfter.size, statBefore.size)
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('appendHistoryLine creates the user-history directory on demand', () => {
  const home = tempHome()
  try {
    const file = historyFilePath(home, '/fresh/cwd')
    assert.ok(!existsSync(file))
    assert.equal(appendHistoryLine(file, 'first', undefined), true)
    assert.ok(existsSync(file), 'file must be materialized by the append')
    assert.deepEqual(loadHistoryFile(file), ['first'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})