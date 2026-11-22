/**
 * The packed-artifact gate must not treat a MISSING internal Client entry as
 * "a synthetic fixture". A published bundle that declares `dsh.bundle.patch`
 * is a real candidate and must carry both process entries; synthetic fixtures
 * are identified by their manifest shape, never by a required file being
 * absent.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { testLifecycle } from '../support/temp-lifecycle.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SMOKE = join(ROOT, 'scripts', 'tarball-smoke.mjs')

test('a published bundle missing dist/local-client.mjs is rejected, not skipped', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('tarball-smoke-published-entry-')
  const staging = join(root, 'stage')
  const packageDir = join(staging, 'package')
  mkdirSync(join(packageDir, 'dist'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: '@xmoon76/dsh-pi-tui',
    version: '0.5.8',
    type: 'module',
    main: 'dist/index.mjs',
    exports: { '.': './dist/index.mjs' },
    dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
  }, null, 2)}\n`)
  writeFileSync(join(packageDir, 'dist', 'index.mjs'), 'export const probe = true\n')
  writeFileSync(join(packageDir, 'cordis.patch.yml'), 'patch: []\n')
  const tarball = join(root, 'xmoon76-dsh-pi-tui-0.5.8.tgz')
  const tar = spawnSync('tar', ['-czf', tarball, '-C', staging, 'package'], { encoding: 'utf8' })
  assert.equal(tar.status, 0, tar.stderr)
  const result = spawnSync(process.execPath, [SMOKE, tarball], {
    cwd: ROOT,
    env: { ...process.env, TARBALL_SMOKE_SKIP_INSTALL: '1' },
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0, 'a published bundle missing its Client entry must fail the smoke')
  assert.match(result.stdout, /FAIL published bundle carries the internal Host\/Client process entries — local-client=false/u)
})
