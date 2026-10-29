/**
 * The packed-artifact runner's selection contract.
 *
 * Qualification must name ONE exact tarball. Zero candidates, several
 * candidates, a directory/symlink, or an explicit path to something that is
 * not this project's tarball all fail — the runner never picks "the newest".
 *
 * @module qualify-tarball.test
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import test from 'node:test'

import { SMOKE_SCRIPTS, selectCandidate } from '../../scripts/qualify-tarball.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const CANDIDATE = 'xmoon76-dsh-pi-tui-0.5.4.tgz'

function createFile(directory, name, content = 'not a real tarball') {
  const path = join(directory, name)
  writeFileSync(path, content)
  return path
}

test('the runner carries the eight packed-artifact smokes in their fixed order', () => {
  assert.deepEqual(SMOKE_SCRIPTS, [
    'scripts/tarball-smoke.mjs',
    'scripts/extension-fixture-smoke.mjs',
    'scripts/advanced-plugin-smoke.mjs',
    'scripts/phase4-plugin-smoke.mjs',
    'scripts/unstable-plugin-smoke.mjs',
    'scripts/vim-plugin-smoke.mjs',
    'scripts/examples-plugin-smoke.mjs',
    'scripts/compose-agent-compat-smoke.mjs',
  ])
  for (const script of SMOKE_SCRIPTS) {
    assert.ok(existsSync(join(ROOT, script)), `${script} must exist`)
  }
})

test('no candidate or several candidates fail instead of choosing one', (t) => {
  const life = testLifecycle(t)
  const empty = life.tempDir('qualify-empty-')
  assert.throws(() => selectCandidate(empty), /expected exactly one candidate tarball.*found 0/u)

  const several = life.tempDir('qualify-several-')
  createFile(several, CANDIDATE)
  createFile(several, 'xmoon76-dsh-pi-tui-0.5.5.tgz')
  assert.throws(() => selectCandidate(several), /expected exactly one candidate tarball.*found 2/u)
})

test('exactly one regular project tarball is accepted', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('qualify-one-')
  const candidate = createFile(directory, CANDIDATE)
  assert.equal(selectCandidate(directory), candidate)
})

test('a directory or a symlink with the tarball name is not a candidate', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('qualify-types-')
  mkdirSync(join(directory, CANDIDATE))
  assert.throws(() => selectCandidate(directory), /not a regular file/u)

  const symlinked = life.tempDir('qualify-symlink-')
  const target = createFile(symlinked, 'external.tgz')
  symlinkSync(target, join(symlinked, CANDIDATE))
  assert.throws(() => selectCandidate(symlinked), /not a regular file/u)
})

test('an explicit path must be this project\'s tarball', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('qualify-explicit-')
  const wrong = createFile(directory, 'other.tgz')
  assert.throws(() => selectCandidate(directory, wrong), /not a project tarball/u)
  // The predicate reads the BASENAME, so an absolute path to a valid file is
  // accepted only when its name is the project's.
  const valid = createFile(directory, CANDIDATE)
  assert.equal(basename(selectCandidate(directory, valid)), CANDIDATE)
})
