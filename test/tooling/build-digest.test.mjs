/**
 * The BUILD IDENTITY the sharded pipeline rests on.
 *
 * A pipeline that downloads one build to four runners and packs from a
 * fifth is only sound if every consumer can PROVE it holds the build the
 * producer made. Without that proof a shard can silently test a stale or
 * partially restored tree, and the pack can ship a package the tests never
 * saw — both green.
 *
 * So these cases drive the digest itself: it must be stable across runs,
 * it must change when a byte changes, and `--verify` must FAIL (not warn)
 * when the identity differs. A check that only prints a mismatch is not a
 * gate.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/build-digest.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { buildDigest } from '../../scripts/build-digest.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'build-digest.mjs')

/** Run the CLI and return its exit code and output. */
function cli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('the build digest is stable across two reads of the same tree', () => {
  // A digest that changes between two identical reads cannot identify a
  // build: every consumer would disagree with the producer for no reason.
  const first = buildDigest()
  const second = buildDigest()
  assert.equal(first.digest, second.digest)
  assert.ok(first.fileCount > 0, 'the build outputs must contain files')
  assert.deepEqual(first.files, [...first.files].sort(), 'the file list is sorted, so order is not an input')
})

test('the digest covers the fork build and the generated presets, not only the root bundle', () => {
  // `packages/pi-tui/dist` is a BUILD INPUT to the root bundle and to the
  // tests. A digest over `dist` alone would let a shard run against a stale
  // fork build while every file it checks looks right.
  const identity = buildDigest()
  assert.ok(identity.files.some(file => file.startsWith('dist/')), 'the root bundle is covered')
  assert.ok(identity.files.some(file => file.startsWith('packages/pi-tui/dist/')), 'the fork build is covered')
  assert.ok(identity.files.some(file => file.startsWith('generated/')), 'the generated presets are covered')
})

test('a written identity verifies against the tree it was taken from', (t) => {
  const file = join(ROOT, 'temp', `build-digest-ok-${process.pid}.json`)
  try {
    const written = cli(['--write', file])
    assert.equal(written.status, 0, written.stderr)
    const verified = cli(['--verify', file])
    assert.equal(verified.status, 0, verified.stderr)
    assert.match(verified.stdout, /matches/u)
  } finally {
    rmSync(file, { force: true })
  }
})

test('a MISMATCHED identity FAILS the verify, rather than warning', (t) => {
  // The defect this protects: `actions/download-artifact` reports a digest
  // mismatch as a warning and keeps going. A consumer that does the same
  // would qualify a build nobody produced.
  const file = join(ROOT, 'temp', `build-digest-bad-${process.pid}.json`)
  try {
    const identity = JSON.parse(JSON.stringify(buildDigest()))
    identity.digest = '0'.repeat(64)
    writeFileSync(file, `${JSON.stringify(identity)}\n`)
    const verified = cli(['--verify', file])
    assert.equal(verified.status, 1, 'a mismatched digest must exit non-zero')
    assert.match(verified.stderr, /not the expected/u)
  } finally {
    rmSync(file, { force: true })
  }
})

test('a MISSING file is named in the failure, so the difference is diagnosable', (t) => {
  const file = join(ROOT, 'temp', `build-digest-missing-${process.pid}.json`)
  try {
    const identity = JSON.parse(JSON.stringify(buildDigest()))
    identity.files = [...identity.files, 'dist/this-file-does-not-exist.js'].sort()
    identity.digest = '0'.repeat(64)
    writeFileSync(file, `${JSON.stringify(identity)}\n`)
    const verified = cli(['--verify', file])
    assert.equal(verified.status, 1)
    assert.match(verified.stderr, /missing: .*this-file-does-not-exist/u,
      'the failure must name the file, not only report that the run is invalid')
  } finally {
    rmSync(file, { force: true })
  }
})

test('a build output that is absent is an ERROR, never an empty identity', () => {
  // An identity computed over nothing would match another identity computed
  // over nothing, so two builds that both failed would "agree".
  const source = readFileSync(SCRIPT, 'utf8')
  assert.match(source, /is missing: the build did not run/u,
    'a missing output must be named as a build failure')
  assert.match(source, /is empty: a build that produced nothing cannot identify a run/u,
    'an empty output must fail rather than produce a digest over no files')
})
