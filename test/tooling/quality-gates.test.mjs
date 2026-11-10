/**
 * Real-subprocess tests for the shared quality-gate executor.
 *
 * These drive `runQualityGates()` with actual temporary Node gate scripts:
 * successful execution and argument passing, a real child failure with
 * fail-fast, a real spawn failure, and the release-only skip policy. They do
 * not re-test any atomic gate's own rules and do not parse CI/package text.
 * @module quality-gates.test
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { localPreflightGates, runQualityGates } from '../../scripts/run-quality-gates.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

function gateScript(directory, name, source) {
  const path = join(directory, name)
  writeFileSync(path, source)
  return path
}

test('runs each gate through a real child and passes its arguments', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('quality-gates-')
  const marker = join(directory, 'marker.log')
  const gate = gateScript(directory, 'gate.mjs',
    "import { appendFileSync } from 'node:fs'\n"
    + "appendFileSync(process.argv[2], process.argv.slice(3).join('|') + '\\n')\n")
  const status = runQualityGates({
    gates: [
      { id: 'gate:first', runner: 'node', script: gate, args: [marker, 'first', '--flag'] },
      { id: 'gate:second', runner: 'node', script: gate, args: [marker, 'second'] },
    ],
    log: () => {},
  })
  assert.equal(status, 0)
  assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), ['first|--flag', 'second'])
})

test('propagates a real child failure and stops the chain', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('quality-gates-')
  const marker = join(directory, 'ran.log')
  const failing = gateScript(directory, 'fail.mjs', 'process.exit(7)\n')
  const passing = gateScript(directory, 'pass.mjs',
    "import { appendFileSync } from 'node:fs'\n"
    + "appendFileSync(process.argv[2], 'ran\\n')\n")
  const lines = []
  const status = runQualityGates({
    gates: [
      { id: 'gate:fail', runner: 'node', script: failing },
      { id: 'gate:pass', runner: 'node', script: passing, args: [marker] },
    ],
    log: line => lines.push(line),
  })
  assert.equal(status, 1)
  assert.equal(existsSync(marker), false, 'a later gate must not run after the failure')
  assert.match(lines.join('\n'), /gate:fail.*FAIL.*remaining gates were not run/u)
})

test('reports a real spawn failure as a failure', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('quality-gates-')
  const previous = process.env.PNPM_EXECUTABLE
  process.env.PNPM_EXECUTABLE = join(directory, 'missing-pnpm')
  try {
    const lines = []
    const status = runQualityGates({
      gates: [{ id: 'gate:missing', runner: 'pnpm', script: 'not-a-real-script' }],
      log: line => lines.push(line),
    })
    assert.equal(status, 1)
    assert.match(lines.join('\n'), /gate:missing.*FAIL/u)
  } finally {
    if (previous === undefined) delete process.env.PNPM_EXECUTABLE
    else process.env.PNPM_EXECUTABLE = previous
  }
})

test('skips only the release-covered product gate', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('quality-gates-')
  const marker = join(directory, 'ran.log')
  const gate = gateScript(directory, 'gate.mjs',
    "import { appendFileSync } from 'node:fs'\n"
    + "appendFileSync(process.argv[2], process.argv[3] + '\\n')\n")
  const status = runQualityGates({
    gates: [
      { id: 'gate:pi-surface-compat', runner: 'node', script: gate, args: [marker, 'skipped'] },
      { id: 'gate:kept', runner: 'node', script: gate, args: [marker, 'kept'] },
    ],
    skip: new Set(['gate:pi-surface-compat']),
    log: () => {},
  })
  assert.equal(status, 0)
  assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), ['kept'])
})

test('rejects a skip for any other gate', () => {
  const other = localPreflightGates().find(gate => gate.id !== 'gate:pi-surface-compat')
  assert.ok(other !== undefined)
  assert.throws(
    () => runQualityGates({ gates: [], skip: new Set([other.id]), log: () => {} }),
    /not release-skippable/u,
  )
})
