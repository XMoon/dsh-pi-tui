/**
 * Shared candidate preflight and isolated profile installation for the two
 * split-process smoke lanes.
 *
 * `inspectSplitCandidate()` qualifies the packaged input (identity, SHA256 and
 * the exact DSH runtime pin) BEFORE anything is created on disk.
 * `createSplitSmokeProfile()` installs the ONE isolated `pi-tui` profile that
 * both the full lane and a selected case run: the exact DSH family, the
 * profile-owned Client peers, the candidate bundle and the test-only offline
 * LLM row. It returns facts only; the CALLER owns the work root and its
 * cleanup, so a failure halfway through installation still has a known root to
 * clean and a live DSH_HOME to scan.
 *
 * Importing this module performs no I/O, installs nothing and creates no root.
 *
 * @module split-smoke-profile
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'

import {
  dshInvocation,
  installPlugin,
  isolatedEnvironment,
  resolveTarball,
  runDsh,
  runPnpmInstall,
  validateCandidateTarball,
} from './dsh-smoke-harness.mjs'
import { loadDshDistribution, npmDshVersion, PACKAGE_ROOT } from './dsh-distribution.mjs'
import { requireExactSmokeDshPin, smokeArtifactIdentity, SplitSmokeAssertionError } from './split-smoke-diagnostics.mjs'
import { writeSurfaceLlmFixture } from './split-smoke-fixtures.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function entryPaths(profilePackage) {
  return {
    host: join(profilePackage, 'dist', 'local-host.mjs'),
    client: join(profilePackage, 'dist', 'local-client.mjs'),
  }
}

/**
 * Resolve, hash and pin-qualify the candidate tarball. Every rejection happens
 * before a work root, a distribution load, an install or a process exists; the
 * caller keeps the ONE diagnostics/input report boundary.
 */
export function inspectSplitCandidate(explicitPath) {
  const tarball = resolveTarball(explicitPath)
  const manifest = validateCandidateTarball(tarball)
  const candidateSha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  const targetDshVersion = npmDshVersion()
  // The identity is already fully validated here; carrying it on the pin error
  // keeps the refused-pairing report as traceable as the pre-extraction one
  // (role, name, version, SHA256 and both exact pins) without raw manifest text.
  requireExactSmokeDshPin('candidate', manifest, targetDshVersion, {
    artifact: smokeArtifactIdentity('candidate', manifest, candidateSha256),
  })
  return { tarball, manifest, candidateSha256, targetDshVersion }
}

/**
 * Install the ONE isolated profile both entry modes run. The caller creates
 * `workDir` (and therefore owns `KEEP`/cleanup); this function only fills it.
 */
export function createSplitSmokeProfile({ tarball, targetDshVersion, workDir }) {
  const distribution = loadDshDistribution({ mode: 'npm', version: targetDshVersion })
  const home = join(workDir, 'home')
  const dshHome = join(workDir, 'dsh-home')
  const harnessDir = join(workDir, 'harness')
  const scratch = join(workDir, 'scratch')
  for (const directory of [home, dshHome, harnessDir, scratch]) mkdirSync(directory, { recursive: true })
  writeFileSync(join(workDir, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
  const env = isolatedEnvironment(workDir, home, dshHome, join(workDir, 'evidence.json'))
  // The qualification work dir must be a real OS temp root outside this
  // checkout: an ancestor `node_modules` would otherwise lend the Client
  // peer set that the isolated installation must supply itself (issue #476).
  const workDirFromCheckout = relative(realpathSync(PACKAGE_ROOT), realpathSync(workDir))
  assert(workDirFromCheckout === '..' || workDirFromCheckout.startsWith(`..${sep}`),
    `the split-process work dir must be outside the checkout: ${workDir}`)
  writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
    name: 'dsh-split-process-harness',
    private: true,
    type: 'module',
    dependencies: {
      '@deepseek-ai/dsh': targetDshVersion,
    },
  }, null, 2) + '\n', 'utf8')
  runPnpmInstall(harnessDir, env, distribution)
  const dsh = dshInvocation(harnessDir)
  const version = runDsh(dsh, ['--version'], harnessDir, env)
  assert(version.status === 0, `installed DSH --version failed: ${version.stderr}`)
  assert(version.stdout.trim() === targetDshVersion, `installed DSH version ${version.stdout.trim()} != ${targetDshVersion}`)
  // The Client's static platform peer set belongs to the profile that will
  // run it, exactly like a production profile dependency; the harness only
  // anchors the DSH CLI installation (issue #476). The published store
  // declares its zustand/immer engine imports only as devDependencies, so
  // the profile must own those two as well.
  const profileDir = join(dshHome, 'profiles', 'pi-tui')
  const clientPeers = [
    ['@deepseek-ai/dsh-client-store', targetDshVersion],
    ['zustand', '4.5.7'],
    ['immer', '10.2.0'],
  ]
  installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`, harnessDir, env, false)
  installPlugin(dsh, 'zustand@4.5.7', harnessDir, env, false)
  installPlugin(dsh, 'immer@10.2.0', harnessDir, env, false)
  installPlugin(dsh, tarball, harnessDir, env, false)
  const profileManifest = readJson(join(profileDir, 'package.json'))
  for (const [name, version] of clientPeers) {
    assert(profileManifest.dependencies?.[name] === version,
      `the active profile does not declare the exact Client peer ${name}@${version}`)
    assert(!(profileManifest.dsh?.profile?.bundles ?? []).includes(name),
      `the plain Client peer ${name} must not become a profile bundle`)
    const peerDir = realpathSync(join(profileDir, 'node_modules', name))
    assert(readJson(join(peerDir, 'package.json')).version === version,
      `the active profile installed a different ${name} version`)
    const resolvedPeer = realpathSync(createRequire(join(profileDir, 'package.json')).resolve(name))
    const peerRelative = relative(peerDir, resolvedPeer)
    assert(peerRelative !== '' && peerRelative !== '..' && !peerRelative.startsWith(`..${sep}`),
      `the active profile ${name} resolves outside its own package: ${resolvedPeer}`)
  }
  assert((profileManifest.dsh?.profile?.bundles ?? []).includes('@xmoon76/dsh-pi-tui'),
    'the candidate bundle row disappeared from the active profile')
  const profilePackage = join(profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui')
  assert(existsSync(join(profilePackage, 'dist', 'local-host.mjs')), 'candidate host entry missing from profile install')
  assert(existsSync(join(profilePackage, 'dist', 'local-client.mjs')), 'candidate client entry missing from profile install')
  const entries = entryPaths(profilePackage)
  const manifest = readJson(join(profilePackage, 'package.json'))
  assert(manifest.bin === undefined, 'the candidate must not add a package bin')
  assert(!Object.keys(manifest.exports ?? {}).some(name => /local-(host|client)/u.test(name)), 'the internal entries must stay unexported')
  assert(manifest.dependencies?.ws === '8.21.3', 'the installed package must declare ws@8.21.3')
  const anchor = realpathSync(join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  // The test-only offline Host LLM row is part of the isolated profile for
  // this whole run: the link lanes never prompt, and the surface lanes need a
  // real Host-side model route to prove a committed prompt round trip.
  const surfaceLlm = writeSurfaceLlmFixture(profileDir, workDir)
  const base = {
    cwd: profileDir,
    env: {
      ...env,
      SPLIT_PROCESS_EXTRA_PATCH: surfaceLlm.patchPath,
      SPLIT_PROCESS_PROMPT_EVIDENCE: surfaceLlm.promptEvidencePath,
    },
    anchor,
    profile: 'pi-tui',
    scratch,
  }
  return {
    workDir,
    home,
    dshHome,
    harnessDir,
    scratch,
    env,
    profileDir,
    profilePackage,
    manifest,
    entries,
    anchor,
    base,
    surfaceLlm,
    clientPeers,
    dshInvocation: dsh,
  }
}
