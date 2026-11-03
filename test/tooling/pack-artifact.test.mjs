/**
 * The single-pack contract: `pack:artifact` must stay a pure pack, and the
 * local `pack:release` / `verify:release` orchestration must keep every
 * explicit stage.
 *
 * The lifecycle-negative case is REAL: a temporary package defines
 * `prepack`/`prepare`/`postpack` sentinels, and the same `pnpm pack
 * --config.ignore-scripts=true` flags the repository uses must execute none
 * of them. The positive control runs the same fixture WITHOUT the flag and
 * proves the sentinels are live, so the negative case cannot pass because the
 * fixture was inert.
 *
 * @module pack-artifact.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { pnpmExecutable } from '../../scripts/lib/process.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PNPM = pnpmExecutable()

function assertOrder(text, parts) {
  let cursor = -1
  for (const part of parts) {
    const next = text.indexOf(part, cursor + 1)
    assert.ok(next > cursor, `'${part}' is missing or out of order in: ${text}`)
    cursor = next
  }
}

test('the root package has ONE lifecycle-free pack entry and no implicit hooks', () => {
  const scripts = PACKAGE.scripts
  assert.equal(scripts.prepack, undefined, 'a prepack lifecycle hook must not come back')
  assert.equal(scripts.postpack, undefined, 'a postpack lifecycle hook must not come back')
  assert.equal(scripts.prepare, undefined, 'the husky prepare lifecycle hook must not come back')
  assert.match(scripts['pack:artifact'], /^rm -f xmoon76-dsh-pi-tui-\*\.tgz && pnpm pack --config\.ignore-scripts=true --pack-destination \.$/u)
  assert.equal(scripts['smoke:release'], 'node scripts/qualify-tarball.mjs')
})

test('pack:release is the explicit full order and never delegates to a second builder', () => {
  assertOrder(PACKAGE.scripts['pack:release'], [
    'pnpm clean',
    'pnpm clean:fork',
    'pnpm build',
    'pnpm typecheck:bundle',
    'pnpm test:product',
    'pnpm pack:artifact',
    'pnpm smoke:release',
  ])
})

test('verify:release retains every former pre-push gate and ends in pack:release', () => {
  assertOrder(PACKAGE.scripts['verify:release'], [
    'pnpm typecheck:fork',
    'pnpm typecheck:bench',
    'pnpm test:fork',
    'pnpm test:tmux',
    'pnpm test:tooling',
    'pnpm gate:installation-doc',
    'pnpm gate:pi-divergence-ledger',
    'pnpm gate:pi-vendor-diff --strict',
    'node scripts/naming-gate.mjs',
    'node scripts/check-no-session-events.mjs',
    'pnpm gate:boundary',
    'pnpm gate:architecture',
    'pnpm gate:production-reads',
    'pnpm gate:keybindings',
    'pnpm audit --prod --audit-level high',
    'pnpm pack:release',
  ])
})

test('the lifecycle-free pack flags execute NONE of prepack/prepare/postpack', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('pack-artifact-lifecycle-')
  const sentinels = ['prepack-ran', 'prepare-ran', 'postpack-ran']
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
    name: 'pack-artifact-fixture',
    version: '1.0.0',
    scripts: Object.fromEntries([
      ['prepack', "node -e \"require('fs').writeFileSync('prepack-ran','yes')\""],
      ['prepare', "node -e \"require('fs').writeFileSync('prepare-ran','yes')\""],
      ['postpack', "node -e \"require('fs').writeFileSync('postpack-ran','yes')\""],
    ]),
  }, null, 2)}\n`)

  const packed = spawnSync(PNPM, ['pack', '--config.ignore-scripts=true', '--pack-destination', '.'], {
    cwd: directory,
    encoding: 'utf8',
  })
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`)
  assert.equal(readdirSync(directory).filter(name => name.endsWith('.tgz')).length, 1)
  for (const sentinel of sentinels) {
    assert.equal(existsSync(join(directory, sentinel)), false, `${sentinel} must not run under --config.ignore-scripts=true`)
  }

  // Positive control: the SAME fixture without the flag runs all three hooks.
  for (const name of readdirSync(directory)) {
    if (name.endsWith('.tgz')) rmSync(join(directory, name))
  }
  const ordinary = spawnSync(PNPM, ['pack', '--pack-destination', '.'], {
    cwd: directory,
    encoding: 'utf8',
  })
  assert.equal(ordinary.status, 0, `${ordinary.stdout}\n${ordinary.stderr}`)
  for (const sentinel of sentinels) {
    assert.equal(existsSync(join(directory, sentinel)), true, `${sentinel} must run without the flag (the fixture must be live)`)
  }
})
