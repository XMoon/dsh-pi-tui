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
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import {
  dshInvocation,
  installPlugin,
  isolatedEnvironment,
  resolveTarball,
  runDsh,
  runPnpmInstall,
  validateCandidateTarball,
} from './dsh-smoke-harness.mjs'
import { DSH_AGENT_PACKAGE, loadDshDistribution, npmDshVersion, PACKAGE_ROOT } from './dsh-distribution.mjs'
import { requireExactSmokeDshPin, smokeArtifactIdentity, SplitSmokeAssertionError, SplitSmokeInputError } from './split-smoke-diagnostics.mjs'
import { LEGACY_OFFLINE_LLM_IDENTITY, SPLIT_OFFLINE_LLM_IDENTITY, writeSurfaceLlmFixture } from './split-smoke-fixtures.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/**
 * The immutable-input refusal. The code stays on the error object and in the
 * message; the new Process lane surfaces it through the Supervisor IPC rather
 * than the smoke-lane report projection, so the historical lane error-code
 * registry is deliberately not extended.
 */
function inputRefusal(code, message) {
  return new SplitSmokeInputError(
    code,
    `INPUT_UNQUALIFIED: ${code} (INVALID_TEST_INPUT, not a product regression): ${message}`,
  )
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
 * The immutable single-package input preflight for the split-process business
 * Project.
 *
 * Unlike the historical lanes, this input is never discovered by filename: the
 * caller supplies one explicit, canonical, read-only path OUTSIDE this
 * checkout. The function proves the real bytes it returns are the bytes the
 * candidate preflight qualified: lstat identity (dev/ino/size/mode/nlink) is
 * read before and after the single content read, and the existing
 * `inspectSplitCandidate` manifest/name/version/exact-pin/SHA qualification
 * must agree with that content hash. A changed or replaced input is refused,
 * never retried.
 */
export function inspectImmutableSplitCandidate(explicitPath) {
  const refuse = (code, message) => {
    throw inputRefusal(code, message)
  }
  if (typeof explicitPath !== 'string' || explicitPath === '') {
    refuse('INPUT_CANDIDATE_PATH_UNQUALIFIED', 'the candidate tarball must be an explicit absolute path')
  }
  if (!isAbsolute(explicitPath)) {
    refuse('INPUT_CANDIDATE_PATH_UNQUALIFIED', 'the candidate tarball must be an absolute path')
  }
  if (!explicitPath.endsWith('.tgz')) {
    refuse('INPUT_CANDIDATE_SUFFIX_UNQUALIFIED', 'the candidate tarball must end in .tgz')
  }
  let before
  try {
    before = lstatSync(explicitPath)
  } catch (error) {
    refuse('INPUT_CANDIDATE_PATH_UNQUALIFIED',
      `the candidate tarball does not exist or is unreadable (${String(error?.code ?? error?.name ?? 'unknown')})`)
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    refuse('INPUT_CANDIDATE_FILE_UNQUALIFIED', 'the candidate must be a regular file, not a symlink or special file')
  }
  if (before.nlink !== 1) {
    refuse('INPUT_CANDIDATE_HARDLINK_UNQUALIFIED', 'the candidate must have exactly one hard link')
  }
  if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
    refuse('INPUT_CANDIDATE_OWNER_UNQUALIFIED', 'the candidate must be owned by the current user')
  }
  if ((before.mode & 0o222) !== 0) {
    refuse('INPUT_CANDIDATE_WRITABLE_UNQUALIFIED', 'the candidate must be read-only (0444)')
  }
  if ((before.mode & 0o444) === 0) {
    refuse('INPUT_CANDIDATE_UNREADABLE_UNQUALIFIED', 'the candidate must be readable')
  }
  let real
  try {
    real = realpathSync(explicitPath)
  } catch (error) {
    refuse('INPUT_CANDIDATE_PATH_UNQUALIFIED',
      `the candidate tarball cannot be canonicalized (${String(error?.code ?? error?.name ?? 'unknown')})`)
  }
  if (real !== explicitPath) {
    refuse('INPUT_CANDIDATE_PATH_NOT_CANONICAL', `the candidate path must already be canonical (${real})`)
  }
  const outside = relative(realpathSync(PACKAGE_ROOT), dirname(real))
  if (outside !== '..' && !outside.startsWith(`..${sep}`)) {
    refuse('INPUT_CANDIDATE_INSIDE_CHECKOUT', 'the candidate tarball must live outside this checkout')
  }
  const identityOf = stats => ({ dev: stats.dev, ino: stats.ino, size: stats.size, mode: stats.mode, nlink: stats.nlink })
  const statBefore = identityOf(before)
  let bytes
  try {
    bytes = readFileSync(real)
  } catch (error) {
    refuse('INPUT_CANDIDATE_UNREADABLE_UNQUALIFIED',
      `the candidate tarball cannot be read (${String(error?.code ?? error?.name ?? 'unknown')})`)
  }
  const candidateSha256 = createHash('sha256').update(bytes).digest('hex')
  // Independent post-read identity: canonical path, regular-file shape, single
  // owner link and the stat identity captured before the read must all still
  // describe the same immutable file.
  let afterReal
  try {
    afterReal = realpathSync(real)
  } catch (error) {
    refuse('INPUT_CANDIDATE_CHANGED',
      `the candidate path cannot be canonicalized after its bytes were read (${String(error?.code ?? error?.name ?? 'unknown')})`)
  }
  if (afterReal !== real) {
    refuse('INPUT_CANDIDATE_CHANGED', 'the candidate path was replaced while its bytes were being read')
  }
  const after = lstatSync(real)
  if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1
    || (typeof process.getuid === 'function' && after.uid !== before.uid)) {
    refuse('INPUT_CANDIDATE_CHANGED', 'the candidate file shape changed while its bytes were being read')
  }
  const statAfter = identityOf(after)
  if (statAfter.dev !== statBefore.dev || statAfter.ino !== statBefore.ino
    || statAfter.size !== statBefore.size || statAfter.mode !== statBefore.mode
    || statAfter.nlink !== statBefore.nlink) {
    refuse('INPUT_CANDIDATE_CHANGED', 'the candidate tarball changed while its bytes were being read')
  }
  const qualified = inspectSplitCandidate(real)
  if (qualified.tarball !== real || qualified.candidateSha256 !== candidateSha256) {
    refuse('INPUT_CANDIDATE_CHANGED', 'the candidate bytes changed between the content read and the candidate preflight')
  }
  return {
    tarball: real,
    manifest: qualified.manifest,
    manifestPin: qualified.manifest?.devDependencies?.[DSH_AGENT_PACKAGE],
    candidateSha256,
    targetDshVersion: qualified.targetDshVersion,
    stat: statBefore,
  }
}

/**
 * Re-read the immutable input after an installation and refuse any replaced or
 * rewritten candidate. The caller compares SHA and stat identity with the
 * preflight facts it holds; a change is an input error, never a product one.
 */
export function assertImmutableSplitCandidateUnchanged(candidate) {
  const fresh = inspectImmutableSplitCandidate(candidate.tarball)
  if (fresh.candidateSha256 !== candidate.candidateSha256
    || fresh.stat.dev !== candidate.stat.dev
    || fresh.stat.ino !== candidate.stat.ino
    || fresh.stat.size !== candidate.stat.size
    || fresh.stat.mode !== candidate.stat.mode) {
    throw inputRefusal('INPUT_CANDIDATE_CHANGED', 'the candidate tarball changed after its installation')
  }
  return fresh
}

/**
 * Install the ONE isolated profile both entry modes run. The caller creates
 * `workDir` (and therefore owns `KEEP`/cleanup); this function only fills it.
 *
 * `clientPlatformProvisioning` is a TEST-HARNESS mode, not a product option:
 *   - `legacy-preseed` (default): the historical Split lanes install the three
 *     Client platform packages into the profile before the candidate. Their
 *     green result proves the Host/Client lifecycle only, never a single-package
 *     user install.
 *   - `bundled`: the new Fresh gate installs ONLY the candidate tarball; the
 *     Client Store/Zustand/Immer closure is embedded in the candidate's Client
 *     chunk. No three packages may appear in the profile manifest or
 *     node_modules.
 */
export function createSplitSmokeProfile({ tarball, targetDshVersion, workDir, clientPlatformProvisioning = 'legacy-preseed', seedBuildPolicy = true }) {
  if (clientPlatformProvisioning !== 'legacy-preseed' && clientPlatformProvisioning !== 'bundled') {
    throw new SplitSmokeAssertionError(`unknown clientPlatformProvisioning mode: ${String(clientPlatformProvisioning)}`)
  }
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
  if (clientPlatformProvisioning === 'legacy-preseed') {
    installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`, harnessDir, env, false)
    installPlugin(dsh, 'zustand@4.5.7', harnessDir, env, false)
    installPlugin(dsh, 'immer@10.2.0', harnessDir, env, false)
  }
  installPlugin(dsh, tarball, harnessDir, env, false, { seedBuildPolicy })
  const profileManifest = readJson(join(profileDir, 'package.json'))
  if (clientPlatformProvisioning === 'legacy-preseed') {
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
  } else {
    const dependencies = profileManifest.dependencies ?? {}
    for (const [name] of clientPeers) {
      assert(!Object.hasOwn(dependencies, name),
        `the bundled profile must not declare ${name} at its root`)
      assert(!existsSync(join(profileDir, 'node_modules', ...name.split('/'))),
        `the bundled profile must not install ${name}`)
    }
    assert(Object.keys(dependencies).every(name => name === '@xmoon76/dsh-pi-tui'),
      `the bundled profile installed unexpected root dependencies: ${JSON.stringify(Object.keys(dependencies))}`)
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
  const surfaceLlm = writeSurfaceLlmFixture(
    profileDir,
    workDir,
    clientPlatformProvisioning === 'bundled' ? SPLIT_OFFLINE_LLM_IDENTITY : LEGACY_OFFLINE_LLM_IDENTITY,
  )
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
    clientPeers: clientPlatformProvisioning === 'legacy-preseed' ? clientPeers : [],
    clientPlatformProvisioning,
    buildPolicyPreseeded: seedBuildPolicy !== false,
    dshInvocation: dsh,
  }
}
