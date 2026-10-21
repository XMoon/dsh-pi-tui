/**
 * WHEN the pack-equivalence proof must run again.
 *
 * The equality between an ordinary `pnpm pack` and a lifecycle-free one is a
 * GATED PROPERTY: it holds for the packaging inputs it was measured on, and a
 * change to those inputs reopens the question. This file covers the trigger's
 * arithmetic — the part that decides whether the expensive proof runs.
 *
 * The dangerous direction is the quiet one: reporting "unchanged" for inputs
 * nobody proved. A missing record must therefore be a TRIGGER, not a pass.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/pack-equivalence-input.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { packagingInputDigest } from '../../scripts/pack-equivalence-input.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'pack-equivalence-input.mjs')

function cli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-pack-eq-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('the digest names the inputs the equality depends on', () => {
  const identity = packagingInputDigest()
  const paths = identity.inputs.map(input => input.path)
  assert.ok(paths.includes('package.json'), 'the manifest decides what is packed')
  assert.ok(paths.includes('tsdown.config.ts'), 'the bundle build decides the payload')
  assert.ok(paths.includes('scripts/generate-dsh-presets.mjs'), 'the generated presets are payload')
  for (const input of identity.inputs) {
    if (input.present) assert.match(input.sha256, /^[0-9a-f]{64}$/u)
    else assert.equal(input.sha256, null)
  }
})

test('the digest is stable across two reads', () => {
  assert.equal(packagingInputDigest().digest, packagingInputDigest().digest)
})

test('a recorded proof covers the current inputs', (t) => {
  const file = join(scratch(t), 'baseline.json')
  assert.equal(cli(['--write', file]).status, 0)
  const check = cli(['--check', file])
  assert.equal(check.status, 0, check.stdout + check.stderr)
  assert.match(check.stdout, /unchanged/u)
})

test('a MISSING record TRIGGERS the proof instead of counting as unchanged', (t) => {
  // The quiet failure this prevents: an equality nobody ever measured being
  // treated as still valid because no record contradicts it.
  const check = cli(['--check', join(scratch(t), 'absent.json')])
  assert.equal(check.status, 1)
  assert.match(check.stdout, /no recorded equivalence proof exists/u)
})

test('a record for OTHER inputs TRIGGERS the proof and names what differs', (t) => {
  const file = join(scratch(t), 'baseline.json')
  const recorded = JSON.parse(readFileSync((cli(['--write', file]), file), 'utf8'))
  // Pretend the manifest changed since the proof was taken.
  recorded.digest = '0'.repeat(64)
  recorded.inputs = recorded.inputs.map(input =>
    input.path === 'package.json' ? { ...input, sha256: '1'.repeat(64) } : input)
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const check = cli(['--check', file])
  assert.equal(check.status, 1)
  assert.match(check.stdout, /differ/u)
  assert.match(check.stdout, /package\.json/u, 'the trigger must name the input that changed')
})
