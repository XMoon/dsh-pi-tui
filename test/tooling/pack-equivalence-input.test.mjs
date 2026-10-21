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

test('a DIGEST alone is not a proof', (t) => {
  // The defect this replaces: the check compared only `digest`, so a record
  // with no proof at all — or a proof that said `equivalent: false` — was
  // reported as "unchanged" and the pipeline skipped the comparison while
  // still publishing. Bytes say WHICH inputs; they say nothing about whether
  // the comparison ever ran or passed.
  const file = join(scratch(t), 'baseline.json')
  assert.equal(cli(['--write', file]).status, 0)
  const check = cli(['--check', file])
  assert.equal(check.status, 1, 'a record without a passing proof must trigger the proof')
  assert.match(check.stdout, /no PASSING equivalence proof/u)
})

test('a proof that says equivalent: false triggers the proof', (t) => {
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proof = { equivalent: false, mode: 'npm', node: '24' }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const check = cli(['--check', file])
  assert.equal(check.status, 1)
  assert.match(check.stdout, /no PASSING equivalence proof/u)
})

test('a recorded proof covers the inputs it was taken at, in ITS scope', (t) => {
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proof = { equivalent: true, mode: 'npm', node: process.versions.node.split('.')[0] }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const check = cli(['--check', file])
  assert.equal(check.status, 0, check.stdout + check.stderr)
  assert.match(check.stdout, /unchanged/u)
})

test('a proof from ANOTHER mode does not cover this run', (t) => {
  // An npm proof says nothing about a source run: the dependency graph and
  // the packed payload are different.
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proof = { equivalent: true, mode: 'npm', node: process.versions.node.split('.')[0] }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const check = cli(['--check', file, '--mode', 'source'])
  assert.equal(check.status, 1)
  assert.match(check.stdout, /mode 'npm', not 'source'/u)
})

test('a proof from ANOTHER Node major does not cover this run', (t) => {
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proof = { equivalent: true, mode: 'npm', node: '24' }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const check = cli(['--check', file, '--node', '26'])
  assert.equal(check.status, 1)
  assert.match(check.stdout, /Node 24, not 26/u)
})

test('the comparator and the protocol are part of the digested inputs', () => {
  // "equivalent" is whatever the comparator measures, and the comparison is
  // between two specific commands. A change to either makes the recorded
  // proof describe a comparison the pipeline no longer performs.
  const paths = packagingInputDigest().inputs.map(input => input.path)
  assert.ok(paths.includes('scripts/compare-tarballs.mjs'), 'the comparator defines "equivalent"')
  assert.ok(paths.includes('scripts/pack-equivalence-protocol.json'), 'the protocol is the pair of commands compared')
  assert.ok(paths.includes('pnpm-lock.yaml'), 'the lockfile pins the build toolchain that produces the payload')
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
  // A valid proof, so the check proceeds to the digest comparison this case
  // is about.
  recorded.proof = { equivalent: true, mode: 'npm', node: process.versions.node.split('.')[0] }
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
