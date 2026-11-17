/**
 * The isolated-profile build-script policy.
 *
 * `koffi` is this package's one native runtime dependency. pnpm 12 hard-fails
 * an UNDECIDED dependency build script (`ERR_PNPM_IGNORED_BUILDS`), so every
 * isolated qualification profile must record the SAME explicit decision the
 * repository root already makes: deny the build script, use the prebuilt
 * platform binaries. The seed must never override a decision the profile owner
 * already made.
 *
 * @module @xmoon76/dsh-pi-tui/tooling/dsh-profile-build-policy.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

import { testLifecycle } from '../support/temp-lifecycle.ts'
import { PROFILE_ALLOW_BUILDS, seedProfileBuildPolicy } from '../../scripts/lib/dsh-profile-build-policy.mjs'

test('a fresh isolated profile gets the base fields and the explicit koffi denial', (t) => {
  const life = testLifecycle(t)
  const dshHome = life.tempDir('dsh-policy-fresh-')
  seedProfileBuildPolicy(dshHome, 'pi-tui')
  const document = parse(readFileSync(join(dshHome, 'profiles', 'pi-tui', 'pnpm-workspace.yaml'), 'utf8'))
  assert.deepEqual(document.packages, ['.'])
  assert.equal(document.nodeLinker, 'hoisted')
  assert.equal(document.autoInstallPeers, false)
  assert.deepEqual(document.allowBuilds, { koffi: false })
  assert.deepEqual(PROFILE_ALLOW_BUILDS, { koffi: false })
})

test('an existing profile keeps every field and every decision it already has', (t) => {
  const life = testLifecycle(t)
  const dshHome = life.tempDir('dsh-policy-existing-')
  const directory = join(dshHome, 'profiles', 'pi-tui')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - .',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    'allowBuilds:',
    '  koffi: true',
    '  esbuild: false',
    '',
  ].join('\n'))
  seedProfileBuildPolicy(dshHome, 'pi-tui')
  const document = parse(readFileSync(join(directory, 'pnpm-workspace.yaml'), 'utf8'))
  // An explicit approval is the profile owner's decision and is NEVER
  // overridden by the seed; other entries survive untouched.
  assert.deepEqual(document.allowBuilds, { koffi: true, esbuild: false })
  assert.equal(document.nodeLinker, 'hoisted')
})

test('the seed is idempotent: a second call changes no byte', (t) => {
  const life = testLifecycle(t)
  const dshHome = life.tempDir('dsh-policy-idempotent-')
  seedProfileBuildPolicy(dshHome, 'pi-tui')
  const path = join(dshHome, 'profiles', 'pi-tui', 'pnpm-workspace.yaml')
  const first = readFileSync(path, 'utf8')
  seedProfileBuildPolicy(dshHome, 'pi-tui')
  assert.equal(readFileSync(path, 'utf8'), first)
})
