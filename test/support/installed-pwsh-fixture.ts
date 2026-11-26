/**
 * A narrow structural fixture for the installed official PowerShell
 * capability: an `@deepseek-ai/dsh` anchor whose manifest declares the
 * sandbox/profile pair, an `@deepseek-ai/dsh-pwsh-sandbox` manifest that
 * declares pwsh-local as a peer, and one public ESM `@deepseek-ai/dsh-pwsh-local`
 * module exporting the two official constants.
 *
 * This reproduces only what the resolver's contract requires (installed-closure
 * anchors, peer declaration, public export shape). It does NOT prove the real
 * installed identity; the native Windows entry gate owns that proof.
 * @module @xmoon76/dsh-pi-tui/installed-pwsh-fixture
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TestLifecycle } from './temp-lifecycle.ts'

export interface InstalledPwshFixture {
  /** The exact `@deepseek-ai/dsh/package.json` path to pass as installAnchor. */
  readonly anchor: string
  /** Unique marker the fixture module exports as ENCODING_PREAMBLE. */
  readonly encodingPreamble: string
  /** Unique marker environment overrides the fixture module exports. */
  readonly envOverrides: Readonly<Record<string, string>>
  /** Two distinct fake executable paths a live shell getter can return. */
  readonly firstExecutable: string
  readonly secondExecutable: string
}

function writeManifest(directory: string, manifest: Record<string, unknown>): string {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'package.json')
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return path
}

export function writeInstalledPwshFixture(life: TestLifecycle): InstalledPwshFixture {
  const root = life.tempDir('dsh-pwsh-fixture-')
  const modules = join(root, 'node_modules')
  const dshDir = join(modules, '@deepseek-ai', 'dsh')
  const sandboxDir = join(modules, '@deepseek-ai', 'dsh-pwsh-sandbox')
  const localDir = join(modules, '@deepseek-ai', 'dsh-pwsh-local')
  const anchor = writeManifest(dshDir, {
    name: '@deepseek-ai/dsh',
    version: '0.2.2-rc.5',
    dependencies: {
      '@deepseek-ai/dsh-pwsh-local': '0.2.2-rc.5',
      '@deepseek-ai/dsh-pwsh-sandbox': '0.2.2-rc.5',
    },
  })
  writeManifest(sandboxDir, {
    name: '@deepseek-ai/dsh-pwsh-sandbox',
    version: '0.2.2-rc.5',
    peerDependencies: {
      '@deepseek-ai/dsh-pwsh-local': '0.2.2-rc.5',
    },
  })
  const encodingPreamble = '/*fixture-encoding-preamble*/ '
  const envOverrides = { FIXTURE_NO_COLOR: '1', FIXTURE_PAGER: 'cat' }
  writeManifest(localDir, {
    name: '@deepseek-ai/dsh-pwsh-local',
    version: '0.2.2-rc.5',
    type: 'module',
    main: 'index.mjs',
  })
  writeFileSync(join(localDir, 'index.mjs'), [
    `export const ENCODING_PREAMBLE = ${JSON.stringify(encodingPreamble)}`,
    `export const ENV_OVERRIDES = ${JSON.stringify(envOverrides)}`,
    'export class PwshLocalExecutor {}',
    '',
  ].join('\n'))
  return {
    anchor,
    encodingPreamble,
    envOverrides,
    firstExecutable: 'C:\\fixture\\first-pwsh.exe',
    secondExecutable: 'C:\\fixture\\second-pwsh.exe',
  }
}
