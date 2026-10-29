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
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import test from 'node:test'

import { SMOKE_SCRIPTS, runQualification, selectCandidate } from '../../scripts/qualify-tarball.mjs'
import { pnpmExecutable } from '../../scripts/lib/process.mjs'
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

test('the real pnpm CLI separator reaches the runner, not its usage guard', () => {
  // pnpm 12 forwards the `--` separator to the script. The CI command
  // `pnpm smoke:release -- "$CANDIDATE"` must therefore fail on the candidate
  // path (here: absent) and never on a two-argument usage error.
  const result = spawnSync(pnpmExecutable(), ['smoke:release', '--', '/no/such/xmoon76-dsh-pi-tui-0.5.4.tgz'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const output = `${result.stdout}\n${result.stderr}`
  assert.notEqual(result.status, 0, output)
  assert.match(output, /does not exist/u)
  assert.doesNotMatch(output, /usage: node scripts\/qualify-tarball\.mjs/u)
})

test('the first non-zero smoke stops the run, and every child receives the same exact tarball', () => {
  const candidate = '/tmp/xmoon76-dsh-pi-tui-0.5.4.tgz'
  const calls = []
  assert.throws(() => runQualification(candidate, {
    scripts: ['smoke-a.mjs', 'smoke-b.mjs', 'smoke-c.mjs'],
    root: '/tmp',
    spawn(_command, args, options) {
      calls.push({ args, options })
      return { status: calls.length === 2 ? 7 : 0, signal: null }
    },
  }), /2\/3 smoke-b failed \(exit 7\)/u)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.args[1]), [candidate, candidate])
  assert.deepEqual(calls.map(call => call.args[0]), ['/tmp/smoke-a.mjs', '/tmp/smoke-b.mjs'])
  for (const call of calls) assert.equal(call.options.cwd, '/tmp')
})
