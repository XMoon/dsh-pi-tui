/**
 * Explicit test-only DSH installation fixture for the Darwin Koffi bridge.
 *
 * Production resolves Koffi from the installed DSH anchor, never from this
 * checkout's node_modules. Tests that exercise the real libproc bridge
 * therefore install a tiny fake DSH installation that names the official
 * packages and points `koffi` at the checkout's pinned devDependency. Setting
 * SPLIT_PROCESS_DSH_ANCHOR is the same explicit seam the Split launcher uses;
 * no ambient NODE_PATH or repo-relative fallback is involved.
 *
 * Call {@link installDarwinKoffiFixture} before the first native read in a
 * test file. Each test process owns one fixture root, removed on process exit.
 *
 * @module @xmoon76/dsh-pi-tui/test/support/darwin-koffi-fixture
 */

import { cpSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { TestContext } from 'node:test'
import { testLifecycle } from './temp-lifecycle.ts'

let fixtureRoot: string | undefined

/** Copy the checkout's pinned Koffi package (and, on Darwin, the matching
 * platform prebuild) into a fixture `node_modules` directory. The production
 * resolver proves both live inside the fixture's module tree, so a symlink to
 * the checkout would not exercise the same path. */
export function copyKoffiPackage(nodeModules: string): void {
  const requireFromTest = createRequire(import.meta.url)
  const koffiEntry = requireFromTest.resolve('koffi')
  cpSync(dirname(koffiEntry), join(nodeModules, 'koffi'), { recursive: true, dereference: true })
  if (process.platform !== 'darwin') return
  const platformName = `@koromix/koffi-darwin-${process.arch}`
  const platformRoot = dirname(realpathSync(createRequire(koffiEntry).resolve(`${platformName}/package.json`)))
  cpSync(platformRoot, join(nodeModules, '@koromix', `koffi-darwin-${process.arch}`), { recursive: true, dereference: true })
}

/** Install (once per process) and activate the test-owned DSH anchor. Call it
 * from a top-level `before` hook so the fixture outlives every case in the
 * file. */
export function installDarwinKoffiFixture(t: TestContext): string {
  if (fixtureRoot !== undefined) return fixtureRoot
  const root = testLifecycle(t).tempDir('dsh-koffi-anchor-')
  const dshDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  const subprocessDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local')
  mkdirSync(dshDir, { recursive: true })
  mkdirSync(subprocessDir, { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '0.2.2-rc.5',
  }, null, 2)}\n`)
  writeFileSync(join(subprocessDir, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-subprocess-local',
    version: '0.2.2-rc.5',
    dependencies: { koffi: '3.1.1' },
  }, null, 2)}\n`)
  // Copy (dereference) rather than symlink: the production resolver proves the
  // package lives inside the DSH module tree, and realpath() would leave a
  // fixture that merely links to this checkout.
  copyKoffiPackage(join(root, 'node_modules'))
  process.env.SPLIT_PROCESS_DSH_ANCHOR = join(dshDir, 'package.json')
  fixtureRoot = root
  return root
}
