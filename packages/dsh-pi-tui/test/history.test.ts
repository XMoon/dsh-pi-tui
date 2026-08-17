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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HISTORY_LIMIT,
  appendHistoryLine,
  historyFilePath,
  loadHistoryFile,
  parseHistoryLines,
} from '../src/history.ts'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'pi-tui-history-'))
}

test('historyFilePath derives a stable md5(cwd) JSONL path under the home', () => {
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

test('parseHistoryLines skips blank and corrupt lines, keeps escaped multi-line content', () => {
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

test('loadHistoryFile returns [] for an absent file and never throws', () => {
  const home = tempHome()
  try {
    assert.deepEqual(loadHistoryFile(historyFilePath(home, '/no/such/cwd')), [])
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

test('loadHistoryFile trims the file to HISTORY_LIMIT entries, keeping the tail', () => {
  const home = tempHome()
  try {
    const file = historyFilePath(home, '/work/big')
    for (let index = 0; index < HISTORY_LIMIT + 20; index += 1) {
      appendHistoryLine(file, `entry ${index}`, undefined)
    }
    const loaded = loadHistoryFile(file)
    assert.equal(loaded.length, HISTORY_LIMIT)
    assert.equal(loaded[0], 'entry 20')
    assert.equal(loaded[loaded.length - 1], `entry ${HISTORY_LIMIT + 19}`)
    // The trim rewrote the file to the kept set.
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, HISTORY_LIMIT)
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