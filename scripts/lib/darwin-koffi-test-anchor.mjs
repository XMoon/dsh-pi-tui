#!/usr/bin/env node
/**
 * Test/tool-only DSH anchor for the kernel process-identity seam.
 *
 * The product TUI always derives Koffi from the installed DSH anchor. Standalone
 * development scripts (`run-test-lane.mjs`, `run-with-temp-root.mjs`) are plain
 * Node processes whose `argv[1]` is not a DSH launcher and which receive no
 * `SPLIT_PROCESS_DSH_ANCHOR` from a Split parent. They still use the shared
 * kernel-identity seam for process-group ownership, so they install this
 * explicit test-owned DSH installation fixture before the first read.
 *
 * This module is under scripts/ and is never part of the published package.
 * It does not read NODE_PATH and never guesses a module; the fixture owns the
 * official package names and the real devDependency Koffi package.
 *
 * @module scripts/lib/darwin-koffi-test-anchor
 */

import { cpSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestTempRoot } from './test-temp-root.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
let installed = false

/** Install the fixture once per process, only on Darwin and only when the
 * process did not already receive a trusted anchor. */
export function installDarwinKoffiTestAnchor() {
  if (installed || process.platform !== 'darwin') return
  if (process.env.SPLIT_PROCESS_DSH_ANCHOR !== undefined && process.env.SPLIT_PROCESS_DSH_ANCHOR !== '') {
    installed = true
    return
  }
  const root = createTestTempRoot(ROOT)
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
  const requireFromScript = createRequire(import.meta.url)
  const koffiEntry = requireFromScript.resolve('koffi')
  cpSync(dirname(koffiEntry), join(root, 'node_modules', 'koffi'), { recursive: true, dereference: true })
  const platformName = `@koromix/koffi-darwin-${process.arch}`
  const platformRoot = dirname(realpathSync(createRequire(koffiEntry).resolve(`${platformName}/package.json`)))
  cpSync(platformRoot, join(root, 'node_modules', '@koromix', `koffi-darwin-${process.arch}`), { recursive: true, dereference: true })
  process.env.SPLIT_PROCESS_DSH_ANCHOR = join(dshDir, 'package.json')
  process.once('exit', () => rmSync(root, { recursive: true, force: true }))
  installed = true
}
