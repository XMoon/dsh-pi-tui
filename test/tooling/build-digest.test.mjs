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
 * They run against a FIXTURE tree, not this checkout: the digest is what the
 * gates consume, and whether this job happened to run a build is not part of
 * the contract. Which directories are covered is asserted as a constant, so
 * removing one is caught even though the fixture is built from the list.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/build-digest.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { BUILD_DIRECTORIES, buildDigest } from '../../scripts/build-digest.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'build-digest.mjs')

/** Run the CLI against `root` and return its exit code and output. */
function cli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * A tree with one file in every build output directory.
 *
 * @param {import('node:test').TestContext} t - the case context.
 * @returns {string} the fixture root.
 */
function fixture(t) {
  const root = testLifecycle(t).tempDir('dsh-build-digest-')
  for (const directory of BUILD_DIRECTORIES) {
    mkdirSync(join(root, directory), { recursive: true })
    writeFileSync(join(root, directory, 'file.js'), `// ${directory}\n`)
  }
  return root
}

test('the digest covers the root bundle, the fork build AND the generated presets', () => {
  // `packages/pi-tui/dist` is a BUILD INPUT to the root bundle and to the
  // tests. A digest over `dist` alone would let a shard run against a stale
  // fork build while every file it checks looks right.
  assert.deepEqual(BUILD_DIRECTORIES, ['dist', 'packages/pi-tui/dist', 'generated'])
})

test('the build digest is stable across two reads of the same tree', (t) => {
  // A digest that changes between two identical reads cannot identify a
  // build: every consumer would disagree with the producer for no reason.
  const root = fixture(t)
  const first = buildDigest({ root })
  const second = buildDigest({ root })
  assert.equal(first.digest, second.digest)
  assert.equal(first.fileCount, BUILD_DIRECTORIES.length, 'every directory contributes a file')
  assert.deepEqual(first.files, [...first.files].sort(), 'the file list is sorted, so order is not an input')
  for (const directory of BUILD_DIRECTORIES) {
    assert.ok(first.files.some(file => file.startsWith(`${directory}/`)), `${directory} is covered`)
  }
})

test('a byte change in ANY covered directory changes the digest', (t) => {
  const root = fixture(t)
  const before = buildDigest({ root })
  writeFileSync(join(root, 'packages', 'pi-tui', 'dist', 'file.js'), '// changed\n')
  const after = buildDigest({ root })
  assert.notEqual(after.digest, before.digest,
    'a stale fork build must not share an identity with the build it replaces')
})

test('a written identity verifies against the tree it was taken from', (t) => {
  const root = fixture(t)
  const file = join(root, 'identity.json')
  const written = cli(['--write', file, '--root', root])
  assert.equal(written.status, 0, written.stderr)
  const verified = cli(['--verify', file, '--root', root])
  assert.equal(verified.status, 0, verified.stderr)
  assert.match(verified.stdout, /matches/u)
})

test('a MISMATCHED identity FAILS the verify, rather than warning', (t) => {
  // The defect this protects: `actions/download-artifact` reports a digest
  // mismatch as a warning and keeps going. A consumer that does the same
  // would qualify a build nobody produced.
  const root = fixture(t)
  const file = join(root, 'identity.json')
  const identity = JSON.parse(JSON.stringify(buildDigest({ root })))
  identity.digest = '0'.repeat(64)
  writeFileSync(file, `${JSON.stringify(identity)}\n`)
  const verified = cli(['--verify', file, '--root', root])
  assert.equal(verified.status, 1, 'a mismatched digest must exit non-zero')
  assert.match(verified.stderr, /not the expected/u)
})

test('a MISSING file is named in the failure, so the difference is diagnosable', (t) => {
  const root = fixture(t)
  const file = join(root, 'identity.json')
  const identity = JSON.parse(JSON.stringify(buildDigest({ root })))
  identity.files = [...identity.files, 'dist/this-file-does-not-exist.js'].sort()
  identity.digest = '0'.repeat(64)
  writeFileSync(file, `${JSON.stringify(identity)}\n`)
  const verified = cli(['--verify', file, '--root', root])
  assert.equal(verified.status, 1)
  assert.match(verified.stderr, /missing: .*this-file-does-not-exist/u,
    'the failure must name the file, not only report that the run is invalid')
})

test('a build output that is absent is an ERROR, never an empty identity', (t) => {
  // An identity computed over nothing would match another identity computed
  // over nothing, so two builds that both failed would "agree".
  const root = testLifecycle(t).tempDir('dsh-build-digest-empty-')
  assert.throws(() => buildDigest({ root }), /is missing: the build did not run/u)
  mkdirSync(join(root, 'dist'), { recursive: true })
  assert.throws(() => buildDigest({ root }), /is empty: a build that produced nothing cannot identify a run/u)
})

test('the identity records WHICH directories it covered', (t) => {
  // A reader of the written identity must not have to infer the scope from
  // the script's source; the file says it.
  const root = fixture(t)
  const file = join(root, 'identity.json')
  assert.equal(cli(['--write', file, '--root', root]).status, 0)
  const identity = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(identity.directories, BUILD_DIRECTORIES)
  assert.ok(identity.fileCount > 0)
})
