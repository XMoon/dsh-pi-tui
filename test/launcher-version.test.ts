/**
 * Client-local launcher version reads (TS8-F2 review P2): the bundle's own
 * manifest must resolve from the SOURCE layout (`src/client/launcher/**`,
 * the depth the F2 move introduced) as well as from the packed flat
 * `dist/**` layout, so a source-run TUI reports the repository version
 * instead of the `0.0.0` fallback. The displayed version keeps preferring an
 * installed dsh version, while `bundleVersion` stays the TUI's own patch
 * level.
 * @module @xmoon76/dsh-pi-tui/launcher-version.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleVersion, dshVersion, packageVersion } from '../src/client/launcher/version.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

/** The repository's own shipped version (the source-mode expectation). */
function repositoryVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  return manifest.version
}

test('bundleVersion reads the repository manifest from the SOURCE layout', () => {
  assert.equal(bundleVersion(), repositoryVersion(),
    'a source-run bundle must report the repository version, never the 0.0.0 fallback')
})

test('packageVersion prefers the installed dsh version, bundleVersion never does', (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-launcher-version-')
  const dshRoot = join(home, 'node_modules', '@deepseek-ai', 'dsh')
  const bin = join(dshRoot, 'bin', 'dsh')
  mkdirSync(join(dshRoot, 'bin'), { recursive: true })
  writeFileSync(bin, '#!/usr/bin/env node\n')
  writeFileSync(join(dshRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.4.7-review.1' }))
  const previousArgv = process.argv[1]
  process.argv[1] = bin
  life.defer(() => { process.argv[1] = previousArgv })

  assert.equal(dshVersion(), '0.4.7-review.1', 'the launcher realpath walk finds the installed harness manifest')
  assert.equal(packageVersion(), '0.4.7-review.1', 'the DISPLAYED version prefers the harness')
  assert.equal(bundleVersion(), repositoryVersion(), 'the TUI version never reports the harness version')
})

test('packageVersion falls back to the bundle version without a readable launcher manifest', (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-launcher-nodsh-')
  const bin = join(home, 'bin', 'dsh')
  mkdirSync(join(home, 'bin'), { recursive: true })
  writeFileSync(bin, '#!/usr/bin/env node\n')
  const previousArgv = process.argv[1]
  process.argv[1] = bin
  life.defer(() => { process.argv[1] = previousArgv })

  assert.equal(dshVersion(), undefined)
  assert.equal(packageVersion(), repositoryVersion(), 'no harness manifest: the bundle version is the fallback')
})
