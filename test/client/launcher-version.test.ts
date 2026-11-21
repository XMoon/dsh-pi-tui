/**
 * Client-local launcher version reads: the installed DSH runtime identity is
 * the Direct CLI manifest (argv walk) or, for a real Split surface Client, the
 * official Profile launcher's install anchor — never the local-client argv or
 * this bundle's own manifest. `bundleVersion` stays the TUI's own patch level.
 * @module @xmoon76/dsh-pi-tui/launcher-version.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleVersion, dshVersion } from '../../src/client/launcher/version.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

/** The repository's own shipped version (the source-mode expectation). */
function repositoryVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
  return manifest.version
}

/** Write a `@deepseek-ai/dsh` manifest and return its package.json path. */
function writeDshManifest(root: string, path: string, version: string): string {
  const manifestPath = join(root, path)
  mkdirSync(join(manifestPath, '..'), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  return manifestPath
}

/** Write a fake `dsh` bin under `root/node_modules/@deepseek-ai/dsh/bin`. */
function writeDshBin(root: string): string {
  const dshRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(dshRoot, 'bin'), { recursive: true })
  writeFileSync(join(dshRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.4.7-direct-a' }))
  const bin = join(dshRoot, 'bin', 'dsh')
  writeFileSync(bin, '#!/usr/bin/env node\n')
  return bin
}

interface EnvSnapshot {
  readonly mode: string | undefined
  readonly anchor: string | undefined
}

/** Set the Split env facts and restore them with the test lifecycle. */
function setSplitEnvironment(life: TestLifecycle, mode: string | undefined, anchor: string | undefined): void {
  const previous: EnvSnapshot = {
    mode: process.env.SPLIT_PROCESS_CLIENT_MODE,
    anchor: process.env.SPLIT_PROCESS_DSH_ANCHOR,
  }
  life.defer(() => {
    if (previous.mode === undefined) delete process.env.SPLIT_PROCESS_CLIENT_MODE
    else process.env.SPLIT_PROCESS_CLIENT_MODE = previous.mode
    if (previous.anchor === undefined) delete process.env.SPLIT_PROCESS_DSH_ANCHOR
    else process.env.SPLIT_PROCESS_DSH_ANCHOR = previous.anchor
  })
  if (mode === undefined) delete process.env.SPLIT_PROCESS_CLIENT_MODE
  else process.env.SPLIT_PROCESS_CLIENT_MODE = mode
  if (anchor === undefined) delete process.env.SPLIT_PROCESS_DSH_ANCHOR
  else process.env.SPLIT_PROCESS_DSH_ANCHOR = anchor
}

/** Point `process.argv[1]` at one fake entry and restore it afterwards. */
function setInvokedEntry(life: TestLifecycle, entry: string): void {
  const previousArgv = process.argv[1]
  process.argv[1] = entry
  life.defer(() => { process.argv[1] = previousArgv })
}

test('bundleVersion reads the repository manifest from the SOURCE layout', () => {
  assert.equal(bundleVersion(), repositoryVersion(),
    'a source-run bundle must report the repository version, never the 0.0.0 fallback')
})

test('Direct: dshVersion reads the CLI manifest through argv, not a residual anchor', (t) => {
  const life = testLifecycle(t)
  const directRoot = life.tempDir('dsh-pi-tui-launcher-version-direct-')
  const bin = writeDshBin(directRoot)
  setInvokedEntry(life, bin)
  setSplitEnvironment(life, undefined, '/residual/anchor/package.json')

  assert.equal(dshVersion(), '0.4.7-direct-a', 'the launcher realpath walk finds the Direct DSH manifest')
  assert.equal(bundleVersion(), repositoryVersion(), 'the TUI version never reports the harness version')
})

test('Split surface: dshVersion reads ONLY the injected install anchor, never argv or the bundle', (t) => {
  const life = testLifecycle(t)
  const anchorRoot = life.tempDir('dsh-pi-tui-launcher-version-anchor-')
  const anchor = writeDshManifest(anchorRoot, join('node_modules', '@deepseek-ai', 'dsh', 'package.json'), '0.2.2-anchor-b')
  // argv points at a REAL bundle-shaped tree (name @xmoon76/dsh-pi-tui) so a
  // wrong implementation that walks argv would report its version instead.
  const bundleRoot = life.tempDir('dsh-pi-tui-launcher-version-client-entry-')
  mkdirSync(join(bundleRoot, 'dist'), { recursive: true })
  writeFileSync(join(bundleRoot, 'package.json'), JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version: '9.9.9' }))
  const clientEntry = join(bundleRoot, 'dist', 'local-client.mjs')
  writeFileSync(clientEntry, '')
  setInvokedEntry(life, clientEntry)
  setSplitEnvironment(life, 'surface', anchor)

  assert.equal(dshVersion(), '0.2.2-anchor-b',
    'the surface Client reports the official install anchor version, not the argv package or bundle version')
  assert.equal(bundleVersion(), repositoryVersion(), 'bundleVersion stays the true TUI package version')
})

test('Split surface: a missing or invalid install anchor is unavailable, with no fallback', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-launcher-version-invalid-')
  const valid = writeDshManifest(root, join('valid', 'package.json'), '0.2.2-anchor-b')
  const cases: readonly { readonly name: string; readonly anchor: string | undefined }[] = [
    { name: 'missing anchor', anchor: undefined },
    { name: 'empty anchor', anchor: '' },
    { name: 'unreadable path', anchor: join(root, 'missing', 'package.json') },
    { name: 'malformed JSON', anchor: join(root, 'malformed.json') },
    { name: 'non-object JSON', anchor: join(root, 'array.json') },
    { name: 'wrong package name', anchor: join(root, 'wrong-name.json') },
    { name: 'empty version', anchor: join(root, 'empty-version.json') },
    { name: 'non-string version', anchor: join(root, 'number-version.json') },
  ]
  writeFileSync(join(root, 'malformed.json'), '{not json')
  writeFileSync(join(root, 'array.json'), '[]')
  writeFileSync(join(root, 'wrong-name.json'), JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version: '0.2.2-anchor-b' }))
  writeFileSync(join(root, 'empty-version.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '' }))
  writeFileSync(join(root, 'number-version.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: 42 }))

  const fakeBin = writeDshBin(root)
  setInvokedEntry(life, fakeBin)
  const previousMode = process.env.SPLIT_PROCESS_CLIENT_MODE
  const previousAnchor = process.env.SPLIT_PROCESS_DSH_ANCHOR
  life.defer(() => {
    if (previousMode === undefined) delete process.env.SPLIT_PROCESS_CLIENT_MODE
    else process.env.SPLIT_PROCESS_CLIENT_MODE = previousMode
    if (previousAnchor === undefined) delete process.env.SPLIT_PROCESS_DSH_ANCHOR
    else process.env.SPLIT_PROCESS_DSH_ANCHOR = previousAnchor
  })
  process.env.SPLIT_PROCESS_CLIENT_MODE = 'surface'
  for (const testCase of cases) {
    if (testCase.anchor === undefined) delete process.env.SPLIT_PROCESS_DSH_ANCHOR
    else process.env.SPLIT_PROCESS_DSH_ANCHOR = testCase.anchor
    assert.equal(dshVersion(), undefined,
      `${testCase.name}: a surface Client must not fall back to argv/bundle (anchor=${String(testCase.anchor)})`)
  }
  // A valid anchor still resolves in the same process: the failures above are
  // not a sticky module state.
  process.env.SPLIT_PROCESS_DSH_ANCHOR = valid
  assert.equal(dshVersion(), '0.2.2-anchor-b')
})

test('a non-surface residual anchor does not change the Direct argv read', (t) => {
  const life = testLifecycle(t)
  const directRoot = life.tempDir('dsh-pi-tui-launcher-version-direct-residual-')
  const bin = writeDshBin(directRoot)
  const anchorRoot = life.tempDir('dsh-pi-tui-launcher-version-residual-')
  const anchor = writeDshManifest(anchorRoot, join('dsh', 'package.json'), '9.9.9-residual')
  setInvokedEntry(life, bin)
  setSplitEnvironment(life, 'qualification', anchor)
  assert.equal(dshVersion(), '0.4.7-direct-a', 'only the exact surface mode selects the anchor branch')
})
