/**
 * Tests for the tarball smoke's absolute-path leak detection: the dynamic
 * checkout-path check (this repo's realpath, wherever it lives) and the
 * generic absolute-path patterns (Unix home, macOS Users, CI workspaces,
 * Windows drives). Plain JS (.mjs) so it runs under `node --test` without
 * type stripping.
 * @module tarball-smoke.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testLifecycle } from './support/temp-lifecycle.ts'

const SMOKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'tarball-smoke.mjs')
// The repository root IS the package root after the root-package migration:
// scripts/ sits directly under it, so two `..` from the smoke file.
const ROOT = join(SMOKE, '..', '..')

/** Build a minimal tarball whose dist/index.mjs carries `leakText`. */
function leakTarball(life, leakText) {
  const dir = life.tempDir('smoke-leak-')
  const pkgDir = join(dir, 'package')
  mkdirSync(join(pkgDir, 'dist'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: '@xmoon76/dsh-pi-tui',
    version: '0.0.0-test',
    private: false,
  }))
  writeFileSync(join(pkgDir, 'dist', 'index.mjs'), `// leak: ${leakText}\nexport const x = 1\n`)
  writeFileSync(join(pkgDir, 'README.md'), 'readme\n')
  const tarball = join(dir, 'leak.tgz')
  const tar = spawnSync('tar', ['-czf', tarball, '-C', dir, 'package'])
  assert.equal(tar.status, 0, tar.stderr)
  return { dir, tarball }
}

function runSmoke(tarball) {
  const env = { ...process.env, TARBALL_SMOKE_SKIP_INSTALL: '1' }
  // These tests exercise the standalone offline smoke path. Do not let a
  // caller's source-mode shell redirect the child into DSH distribution
  // validation before the tarball leak checks run.
  delete env.DSH_SOURCE_DISTRIBUTION
  return spawnSync(process.execPath, [SMOKE, tarball], {
    env,
    encoding: 'utf8',
  })
}

test("tarball smoke flags THIS checkout's realpath wherever it lives", (t) => {
  const life = testLifecycle(t)
  const { tarball } = leakTarball(life, realpathSync(ROOT))
  const result = runSmoke(tarball)
  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stdout, /FAIL no workspace absolute paths in packaged files/)
})

test('tarball smoke flags another machine\'s Unix home path (never seen on this host)', (t) => {
  const life = testLifecycle(t)
  const { tarball } = leakTarball(life, 'see /home/someone/else/file for details')
  const result = runSmoke(tarball)
  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stdout, /FAIL no workspace absolute paths in packaged files/)
})

test('tarball smoke flags a CI workspace path', (t) => {
  const life = testLifecycle(t)
  const { tarball } = leakTarball(life, '/home/runner/work/dsh-pi-tui/dsh-pi-tui/dist/index.mjs')
  const result = runSmoke(tarball)
  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stdout, /FAIL no workspace absolute paths in packaged files/)
})

test('tarball smoke flags a Windows drive path', (t) => {
  const life = testLifecycle(t)
  const { tarball } = leakTarball(life, 'C:\\Users\\dev\\project\\dist\\index.mjs')
  const result = runSmoke(tarball)
  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stdout, /FAIL no workspace absolute paths in packaged files/)
})
