/**
 * Fresh Profile gate inputs and bundled-Closure refusals.
 *
 * The real Direct/Daemon Client starts are E2E evidence in the Fresh lane
 * itself; these cases only prove that the gate cannot be satisfied by a
 * relative path, a polluted work root, or an external Store dependency hiding
 * in the packed Client chunk.
 *
 * @module fresh-profile-install-smoke.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertBundledClientChunk,
  assertIsolatedWorkRoot,
  assertSingleHost,
  parseFreshProfileArgs,
  resolveFreshCandidate,
} from '../../scripts/fresh-profile-install-smoke.mjs'
import { pnpmExecutable } from '../../scripts/lib/process.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

function packFixture(directory) {
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
    name: '@xmoon76/dsh-pi-tui',
    version: '0.5.8',
    dependencies: {},
    peerDependencies: {},
  }, null, 2)}\n`)
  const result = spawnSync(pnpmExecutable(), ['pack', '--config.ignore-scripts=true', '--pack-destination', '.'], {
    cwd: directory,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return join(directory, 'xmoon76-dsh-pi-tui-0.5.8.tgz')
}

test('the gate accepts only the qualified DSH pins and one positional candidate', () => {
  assert.deepEqual(parseFreshProfileArgs(['--', '/tmp/candidate.tgz']), { candidate: '/tmp/candidate.tgz', dshTarget: '0.2.2-rc.5', upgradeOld: undefined })
  assert.deepEqual(parseFreshProfileArgs(['--dsh', '0.2.2-rc.4', '/tmp/candidate.tgz']), { candidate: '/tmp/candidate.tgz', dshTarget: '0.2.2-rc.4', upgradeOld: undefined })
  assert.throws(() => parseFreshProfileArgs(['--dsh', '0.2.2-rc.6', '/tmp/candidate.tgz']), /unsupported DSH target/u)
  assert.throws(() => parseFreshProfileArgs(['a.tgz', 'b.tgz']), /at most one candidate/u)
  assert.throws(() => parseFreshProfileArgs(['--unknown']), /unknown option/u)
})

test('resolveFreshCandidate refuses a relative path and records the absolute SHA', (t) => {
  const life = testLifecycle(t)
  assert.throws(() => resolveFreshCandidate('candidate.tgz'), /absolute path/u)
  const directory = life.tempDir('fresh-profile-accept-')
  const tarball = packFixture(directory)
  const result = resolveFreshCandidate(tarball)
  assert.equal(result.path, tarball)
  assert.equal(result.sha256, createHash('sha256').update(readFileSync(tarball)).digest('hex'))
})

test('the isolated work root refuses the checkout and an ancestor node_modules', (t) => {
  const life = testLifecycle(t)
  const checkout = life.tempDir('fresh-profile-checkout-')
  mkdirSync(join(checkout, 'node_modules'))
  mkdirSync(join(checkout, 'inside'))
  assert.throws(() => assertIsolatedWorkRoot(join(checkout, 'inside'), checkout), /inside the checkout/u)
  const polluted = life.tempDir('fresh-profile-polluted-')
  mkdirSync(join(polluted, 'node_modules'))
  const nested = join(polluted, 'work')
  mkdirSync(nested)
  assert.throws(() => assertIsolatedWorkRoot(nested, checkout), /ancestor node_modules/u)
})

test('the Daemon proof requires exactly one stable Host identity', () => {
  const identity = () => 'start-time'
  assert.throws(() => assertSingleHost({ host: [] }, undefined, 'empty', identity), /exactly one Daemon Host/u)
  assert.throws(() => assertSingleHost({ host: [{ pid: 1 }, { pid: 2 }] }, undefined, 'two', identity), /exactly one Daemon Host/u)
  const first = assertSingleHost({ host: [{ pid: 1 }] }, undefined, 'first', identity)
  assert.deepEqual(first, { pid: 1, start: 'start-time' })
  assert.throws(() => assertSingleHost({ host: [{ pid: 2 }] }, first, 'replaced', identity), /was replaced/u)
})

test('the bundled Client chunk must contain the Store and no external Store closure', (t) => {
  const life = testLifecycle(t)
  const profile = life.tempDir('fresh-profile-chunk-')
  const dist = join(profile, 'dist')
  mkdirSync(dist)
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: '@xmoon76/dsh-pi-tui',
    version: '0.5.8',
    dependencies: {},
    peerDependencies: {},
  }))
  writeFileSync(join(dist, 'client-bootstrap.mjs'), 'export const createSnapshotStore = 1; export const defineStore = 1;\n')
  writeFileSync(join(dist, 'local-client.mjs'), 'import "./client-bootstrap.mjs"\n')
  const facts = assertBundledClientChunk(profile)
  assert.deepEqual(facts.storeChunk, 'client-bootstrap.mjs')
  writeFileSync(join(dist, 'client-bootstrap.mjs'), 'import "zustand/vanilla";\nexport const createSnapshotStore = 1; export const defineStore = 1;\n')
  assert.throws(() => assertBundledClientChunk(profile), /external Store/u)
  writeFileSync(join(dist, 'client-bootstrap.mjs'), 'const z = require("zustand/vanilla");\nexport const createSnapshotStore = 1; export const defineStore = 1;\n')
  assert.throws(() => assertBundledClientChunk(profile), /external Store/u)
})
