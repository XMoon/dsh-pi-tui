/**
 * M4-C2-D split-process upgrade smoke wiring guard.
 *
 * The real dual-artifact lane is `scripts/split-process-upgrade-smoke.mjs`.
 * It needs two genuinely packaged `.tgz` payloads and a real DSH rc.4
 * installation, so it stays an explicit manual qualification lane. This test
 * only prevents its argument contract and package wiring from rotting; it is
 * NOT evidence that U02–U06 passed.
 *
 * @module split-process-upgrade-smoke-wiring.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseUpgradeArguments } from '../../scripts/split-process-upgrade-smoke.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'split-process-upgrade-smoke.mjs')

test('the upgrade smoke is a package script and parses as ESM', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts?.['smoke:split-upgrade'], 'node scripts/split-process-upgrade-smoke.mjs')
  const result = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('the upgrade smoke requires two different old/new artifact paths', () => {
  const oldPath = join(ROOT, 'temp', 'old.tgz')
  const newPath = join(ROOT, 'temp', 'new.tgz')
  assert.deepEqual(
    (() => {
      const parsed = parseUpgradeArguments(['--', '--old', oldPath, '--new', newPath])
      return { old: parsed.old, new: parsed.new, evidence: parsed.evidence }
    })(),
    { old: oldPath, new: newPath, evidence: undefined },
  )
  assert.throws(() => parseUpgradeArguments(['--old', 'old.tgz']), /both --old <tgz> and --new <tgz> are required/u)
  assert.throws(() => parseUpgradeArguments(['--old', 'same.tgz', '--new', 'same.tgz']), /must name different artifacts/u)
  assert.throws(() => parseUpgradeArguments(['--old', 'old.tgz', '--new', 'new.tgz', '--bogus']), /unknown argument/u)
  assert.throws(() => parseUpgradeArguments(['--old', '--new', 'new.tgz']), /--old requires a path/u)
})

test('the upgrade smoke proves cross-build compatibility instead of a build refusal', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.match(source, /oldArtifact\.sha256 === newArtifact\.sha256/u)
  assert.match(source, /newBuildId !== oldBuildId/u)
  // U02 uses the real qualification control on the new Client and reads its
  // structured RPC proof; it must not treat a build refusal as the outcome.
  assert.match(source, /qualification-host-foundation/u)
  assert.match(source, /host-rpc-proof/u)
  assert.match(source, /assertIdentityKept\(clientBAuth\.host, hostABefore/u)
  assert.match(source, /clientBAuth\.host\.buildId === oldBuildId/u)
  // U04 must be the real PTY surface resuming the running old Session.
  assert.match(source, /SurfaceEntryProcess/u)
  assert.match(source, /SPLIT_PROCESS_CLIENT_SESSION: sessionId/u)
  assert.match(source, /sessionOpen === true && record\.openSessionId === sessionId/u)
  assert.match(source, /waitForScreen\('c2d-upgrade-hold'/u)
  assert.match(source, /crossBuildClient/u)
  assert.match(source, /crossBuildSurface/u)
  assert.match(source, /cross-build-compatible/u)
  assert.match(source, /SPLIT_UPGRADE_SMOKE_PASS/u)
  assert.match(source, /SPLIT_UPGRADE_KEEP/u)
  assert.doesNotMatch(source, /HOST_BUILD_INCOMPATIBLE/u,
    'the upgrade lane must not present a cross-build refusal as its success path')
  // The lane must never derive the old artifact by mutating the new one.
  assert.doesNotMatch(source, /writeFileSync\(.*newArtifact\.path/u)
})

test('both Client peer owners are real and every upgrade root is isolated', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  // The work root is a real OS temp root outside the checkout; a repo-local
  // split-upgrade-* root would borrow the checkout's node_modules (issue #476).
  assert.match(source, /const workRoot = [A-Za-z]+Sync\(join\(tmpdir\(\), 'dsh-split-upgrade-'\)\)/u)
  assert.match(source, /relative\(realpathSync\(PACKAGE_ROOT\), realpathSync\(workRoot\)\)/u)
  assert.match(source, /workRootFromCheckout\.startsWith\(`\.\.\$\{sep\}`\)/u)
  assert.doesNotMatch(source, /join\(PACKAGE_ROOT, 'temp', 'split-upgrade-'\)/u)
  assert.doesNotMatch(source, /mkdirSync\(join\(PACKAGE_ROOT, 'temp'\)/u)

  // The active profile owns the exact Client peer set and installs it before
  // the old bundle; the harness is only the DSH CLI anchor.
  const profileStoreInstall = source.indexOf(
    'installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`, harnessDir, env, false)',
  )
  const zustandInstall = source.indexOf("installPlugin(dsh, 'zustand@4.5.7', harnessDir, env, false)")
  const immerInstall = source.indexOf("installPlugin(dsh, 'immer@10.2.0', harnessDir, env, false)")
  const oldInstall = source.indexOf('installPlugin(dsh, oldArtifact.path, harnessDir, env, false)')
  assert.ok(profileStoreInstall >= 0, 'the active profile must install the Client store through the official CLI')
  assert.ok(zustandInstall > profileStoreInstall && immerInstall > zustandInstall,
    'the published store\'s zustand/immer engine peers must follow the store install')
  assert.ok(oldInstall > immerInstall, 'the active profile peer set must be installed before the old bundle')
  const harnessManifest = source.slice(
    source.indexOf("name: 'dsh-split-upgrade-harness'"),
    source.indexOf('runPnpmInstall(harnessDir, env, distribution)'),
  )
  assert.doesNotMatch(harnessManifest, /dsh-client-store|zustand|immer/u,
    'the isolated harness must not pretend to own the Client peer set')
  assert.match(source, /assertProfileClientPeers\(profileDir, targetDshVersion, 'old profile install'\)/u)
  assert.match(source, /assertProfileClientPeers\(profileDir, targetDshVersion, 'upgraded profile install'\)/u)
  assert.match(source, /manifest\.dependencies\?\.\[name\] === version/u)
  assert.match(source, /realpathSync\(createRequireFrom\(join\(profileDir, 'package\.json'\)\)\.resolve\(name\)\)/u)

  // The side-build is a sibling profile project with its own exact peer
  // closure, never a child of the active profile and never a second DSH or
  // Cordis family.
  assert.match(source, /const sideBuildDir = join\(dshHome, 'profiles', 'split-upgrade-side-build'\)/u)
  assert.match(source, /function installSideBuild\(dir, tarball, env, targetDshVersion\)/u)
  assert.match(source, /installSideBuild\(sideBuildDir, newArtifact\.path, env, targetDshVersion\)/u)
  const sideBuildSource = source.slice(
    source.indexOf('function installSideBuild'),
    source.indexOf('function killProcessGroup'),
  )
  assert.match(sideBuildSource, /'@deepseek-ai\/dsh-client-store': targetDshVersion/u)
  assert.match(sideBuildSource, /zustand: '4\.5\.7'/u)
  assert.match(sideBuildSource, /immer: '10\.2\.0'/u)
  assert.doesNotMatch(sideBuildSource, /@deepseek-ai\/cordis|'@deepseek-ai\/dsh':/u,
    'the side-build must not copy the DSH family or a second Cordis')
  assert.match(source, /the side-by-side \$\{name\} resolves outside its own package/u)
})
