/**
 * Unit tests for the raw-persistence coupling gate (Stage A A10.4): the
 * normal TUI runtime must never re-couple to physical session artifacts
 * (`readRaw`, `locate`, `session.jsonl` / `session.vN` filename guessing)
 * — every session read goes through the semantic session-query seam on the
 * master baseline. A text scan — no aliasing, scoping, or computed access
 * can evade a token check; comments and strings are flagged too (the
 * documented cost of the syntactic check).
 * @module @xmoon76/dsh-pi-tui/raw-persistence-coupling-gate.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { scanSource, scanTree } from '../scripts/raw-persistence-coupling-gate.mjs'

test('readRaw is a violation', () => {
  const violations = scanSource(
    'src/example.ts',
    `const events = await persistence.readRaw(id)\n`,
  )
  assert.equal(violations.length, 1)
  assert.equal(violations[0].file, 'src/example.ts')
  assert.equal(violations[0].line, 1)
  assert.equal(violations[0].token, 'readRaw')
})

test('locate() is a violation', () => {
  const violations = scanSource(
    'src/example.ts',
    `const artifact = persistence.locate({ id })\n`,
  )
  assert.equal(violations.length, 1)
  assert.equal(violations[0].token, '.locate(')
})

test('session.jsonl filename guessing is a violation', () => {
  const violations = scanSource(
    'src/example.ts',
    `const path = join(dir, 'session.jsonl')\n`,
  )
  assert.equal(violations.length, 1)
  assert.equal(violations[0].token, 'session.jsonl')
})

test('session.vN generation-suffixed filename guessing is a violation', () => {
  const violations = scanSource(
    'src/example.ts',
    `const path = join(dir, 'session.v2.jsonl')\n`,
  )
  assert.equal(violations.length, 1)
  assert.equal(violations[0].token, 'session.vN')
})

test('a file without the tokens is clean', () => {
  const source = [
    `import { DirectSessionReader } from './runtime/direct/session-direct.ts'`,
    `const rows = await reader.list(undefined)`,
    `const projections = await reader.projectionBatch(rows)`,
  ].join('\n')
  assert.deepEqual(scanSource('src/clean.ts', source), [])
})

test('comments and strings mentioning the tokens are flagged (documented text-scan behavior)', () => {
  const source = [
    '// legacy: persistence.readRaw(id) was the old fallback',
    'const doc = "never guess session.jsonl paths"',
  ].join('\n')
  const violations = scanSource('src/comment.ts', source)
  assert.equal(violations.length, 2, 'the text scan flags every token occurrence, including comments')
})

test('the real src tree is clean', () => {
  const violations = scanTree(join(import.meta.dirname, '..', 'src'))
  assert.deepEqual(violations, [], 'the normal TUI runtime must not re-couple to physical session artifacts')
})
