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
 * @module @xmoon76/dsh-pi-tui/test/tooling/production-reads-gate.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const GATE = join(ROOT, 'scripts', 'check-production-reads.mjs')

/** Run the gate and report its outcome. */
function runGate() {
  const result = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

test('the gate is green on the real tree', () => {
  const result = runGate()
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /reads naming a file that does NOT exist: 0/u)
  assert.match(result.output, /reads that could NOT be resolved statically: 0/u)
})

test('the gate FAILS when a test reads a production file that does not exist', (t) => {
  const probe = 'tooling/synthetic-missing-read.test.mjs'
  const path = join(ROOT, 'test', probe)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, [
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
  t.after(() => rmSync(path, { force: true }))
  const result = runGate()
  assert.notEqual(result.status, 0, 'a read of a non-existent production file must fail the gate')
  assert.match(result.output, /does NOT exist/u)
})

test('the gate FAILS when a production read cannot be resolved statically', (t) => {
  // The fail-closed case: a NEW read form the resolver does not understand
  // must not be counted as covered. A green gate must mean "every
  // production read was checked".
  const probe = 'tooling/synthetic-unresolved-read.test.mjs'
  const path = join(ROOT, 'test', probe)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, [
    "import test from 'node:test'",
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    '',
    "test('synthetic read through an unresolvable base', () => {",
    '  const root = someUnknownBase()',
    "  readFileSync(join(root, 'src', 'app', 'runtime.ts'), 'utf8')",
    '})',
    '',
  ].join('\n'))
  t.after(() => rmSync(path, { force: true }))
  const result = runGate()
  assert.notEqual(result.status, 0, 'an unresolvable production read must fail the gate')
  assert.match(result.output, /could NOT be resolved statically/u)
})
