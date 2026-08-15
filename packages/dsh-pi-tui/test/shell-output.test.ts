/**
 * Tests for the local-shell robustness primitives: the shell-word parser
 * for $VISUAL/$EDITOR commands and the bounded output accumulator that
 * caps card memory while tracking exact totals.
 * @module @xmoon76/dsh-pi-tui/shell-output.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseShellWords } from '../src/shell-words.ts'
import { createBoundedOutput, formatBytes, SHELL_OUTPUT_CAP_BYTES, SHELL_OUTPUT_CAP_LINES } from '../src/bounded-output.ts'

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
