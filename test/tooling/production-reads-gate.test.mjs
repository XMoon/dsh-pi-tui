/**
 * The production-read GUARD's contract: it must fail on a read that names a
 * production file that DOES NOT EXIST, and on a read it could not resolve
 * at all.
 *
 * The second case matters: a resolver that misses a FORM would let a
 * source lock silently point at a different file, and a green gate must
 * never mean "the reads that could not be understood were quietly
 * skipped".
 *
 * The negative cases are verified against a DISPOSABLE test root. A
 * synthetic test file in the REAL test tree would be discovered by a
 * CONCURRENT runner (the product lane, the benchmark, this guard itself)
 * and would pollute the test set it discovers — and the cleanup that
 * removes the file later cannot undo another process's discovery.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/production-reads-gate.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkProductionReads, formatReport, passes } from '../../scripts/check-production-reads.mjs'

const REPO_ROOT = join(import.meta.dirname, '..', '..')

/** A disposable test root with one test file in it. */
function fixtureRoot(name, source) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reads-gate-'))
  mkdirSync(join(root, 'tooling'), { recursive: true })
  writeFileSync(join(root, 'tooling', `${name}.test.mjs`), source)
  return root
}

test('the gate is green on the real tree', () => {
  const result = checkProductionReads(join(REPO_ROOT, 'test'))
  assert.equal(passes(result), true, formatReport(result))
  assert.match(formatReport(result), /reads naming a file that does NOT exist: 0/u)
  assert.match(formatReport(result), /reads that could NOT be resolved statically: 0/u)
})

test('the gate FAILS when a test reads a production file that does not exist', (t) => {
  const root = fixtureRoot('synthetic-missing-read', [
    "import test from 'node:test'",
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    '',
    "test('synthetic read of a production file that does not exist', () => {",
    "  const root = join(process.cwd(), 'src')",
    "  readFileSync(join(root, 'app', 'does-not-exist.ts'), 'utf8')",
    '})',
    '',
  ].join('\n'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const result = checkProductionReads(root, REPO_ROOT)
  assert.equal(passes(result), false, 'a read of a non-existent production file must fail the gate')
  assert.match(formatReport(result), /does NOT exist: 1/u)
})

test('the gate FAILS when a production read cannot be resolved statically', (t) => {
  // The fail-closed case: a NEW read form the resolver does not understand
  // must not be counted as covered. A green gate must mean "every
  // production read was checked".
  const root = fixtureRoot('synthetic-unresolved-read', [
    "import test from 'node:test'",
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    '',
    "const root = someUnknownBase()",
    "const count = (file: string): number => readFileSync(join(root, file), 'utf8').length",
    '',
    "test('synthetic read through an unresolvable base', () => {",
    "  count('src/app/runtime.ts')",
    '})',
    '',
  ].join('\n'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const result = checkProductionReads(root, REPO_ROOT)
  assert.equal(passes(result), false, 'an unresolvable production read must fail the gate')
  assert.match(formatReport(result), /could NOT be resolved statically: 1/u)
})
