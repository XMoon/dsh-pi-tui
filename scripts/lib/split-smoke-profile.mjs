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
import { userInfo } from 'node:os'
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

const candidateStatIdentity = stats => ({
  dev: stats.dev,
  ino: stats.ino,
  size: stats.size,
  mode: stats.mode,
  nlink: stats.nlink,
})

/**
 * The independent post-read identity proof for one explicit candidate path:
 * the path still canonicalizes to itself, is still the same regular single-link
 * owned file, and its full stat identity equals the pre-read snapshot. A
 * disappearance or replacement is the stable changed-input refusal, never a raw
 * filesystem error.
 */
export function assertPostReadCandidateIdentity(real, before) {
  let afterReal
  try {
    afterReal = realpathSync(real)
  } catch (error) {
    throw inputRefusal('INPUT_CANDIDATE_CHANGED',
      `the candidate path cannot be canonicalized after its bytes were read (${String(error?.code ?? error?.name ?? 'unknown')})`)
  }
  if (afterReal !== real) {
    throw inputRefusal('INPUT_CANDIDATE_CHANGED', 'the candidate path was replaced while its bytes were being read')
  }
  let after
  try {
    after = lstatSync(real)
  } catch (error) {
    throw inputRefusal('INPUT_CANDIDATE_CHANGED',
      `the candidate path disappeared or became unreadable after its bytes were read (${String(error?.code ?? error?.name ?? 'unknown')})`)
  }
  if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1
    || (typeof process.getuid === 'function' && after.uid !== before.uid)) {
    throw inputRefusal('INPUT_CANDIDATE_CHANGED', 'the candidate file shape changed while its bytes were being read')
  }
  const statBefore = candidateStatIdentity(before)
  const statAfter = candidateStatIdentity(after)
  if (statAfter.dev !== statBefore.dev || statAfter.ino !== statBefore.ino
    || statAfter.size !== statBefore.size || statAfter.mode !== statBefore.mode
    || statAfter.nlink !== statBefore.nlink) {
    throw inputRefusal('INPUT_CANDIDATE_CHANGED', 'the candidate tarball changed while its bytes were being read')
  }
  return after
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
  const statBefore = candidateStatIdentity(before)
  let bytes
  try {
    bytes = readFileSync(real)
  } catch (error) {
    refuse('INPUT_CANDIDATE_UNREADABLE_UNQUALIFIED',
      `the candidate tarball cannot be read (${String(error?.code ?? error?.name ?? 'unknown')})`)
  }
  const candidateSha256 = createHash('sha256').update(bytes).digest('hex')
  assertPostReadCandidateIdentity(real, before)
  let qualified
  try {
    qualified = inspectSplitCandidate(real)
  } catch (error) {
    // A disappearance or replacement during the requalification read is still
    // the same changed input; a malformed manifest on the SAME inode keeps its
    // own classification.
    let current
    try {
      current = lstatSync(real)
    } catch {
      current = undefined
    }
    if (current === undefined || current.isSymbolicLink() || !current.isFile()
      || current.dev !== before.dev || current.ino !== before.ino
      || current.size !== before.size || current.mode !== before.mode
      || current.nlink !== before.nlink || current.uid !== before.uid
      || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) {
      refuse('INPUT_CANDIDATE_CHANGED',
        `the candidate changed while its requalification was running (${String(error?.code ?? error?.name ?? 'unknown')})`)
    }
    throw error
  }
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

const PROCESS_INSTALL_CACHE_ROOT_NAME = 'dsh-pi-tui-test'
const PROCESS_INSTALL_CACHE_ENV = Object.freeze({
  PNPM_CONFIG_PACKAGE_IMPORT_METHOD: 'copy',
  PNPM_CONFIG_VIRTUAL_STORE_TYPE: 'project',
  PNPM_CONFIG_SIDE_EFFECTS_CACHE: 'false',
})

function cacheRefusal(detail) {
  // Deliberately a plain input failure with a stable message prefix: the
  // historical lane error-code registry must not grow a new long-lived code
  // for this Process-only seam. The Supervisor reports the real message.
  throw new Error(`INPUT_UNQUALIFIED: process install cache root ${detail}`)
}

function directoryIdentity(path) {
  const stats = statSync(path)
  if (!stats.isDirectory()) cacheRefusal(`a filesystem ancestor is not a directory: ${path}`)
  return `${String(stats.dev)}:${String(stats.ino)}`
}

/**
 * The nearest existing directory and every ancestor, keyed by actual device +
 * inode. realpathSync keeps the caller's spelling for case-insensitive
 * non-symlink components, so path.relative alone cannot prove containment.
 */
function existingDirectoryChain(path) {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) cacheRefusal(`cannot resolve an existing ancestor: ${path}`)
    current = parent
  }
  const identities = new Set()
  let nearest
  for (;;) {
    const identity = directoryIdentity(current)
    if (nearest === undefined) nearest = identity
    identities.add(identity)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return { nearest, identities }
}

function directoriesOverlap(cacheRoot, forbidden) {
  const cache = existingDirectoryChain(cacheRoot)
  const target = existingDirectoryChain(forbidden)
  // The forbidden directory exists. If its identity is in the cache chain, the
  // cache root (or its nearest existing ancestor) is at/inside it.
  if (cache.identities.has(target.nearest)) return true
  // Only an existing cache root can be an ancestor of the existing forbidden
  // directory; a not-yet-created root cannot contain an existing path.
  return existsSync(cacheRoot) && target.identities.has(cache.nearest)
}

function lstatOrUndefined(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Validate one cache directory without repairing anything. An existing
 * directory must already be a canonical, current-user-owned 0700 real
 * directory; only a missing one is created (mode 0700). Existing user
 * directories are never chmod-ed, chowned or removed.
 */
function qualifiedCacheDirectory(path, label, create) {
  let stats = lstatOrUndefined(path)
  if (stats === undefined) {
    if (!create) cacheRefusal(`${label} must already exist: ${path}`)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    stats = lstatSync(path)
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    cacheRefusal(`${label} must be a real directory, not a symlink or special file: ${path}`)
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    cacheRefusal(`${label} must be owned by the current user: ${path}`)
  }
  if ((stats.mode & 0o777) !== 0o700) cacheRefusal(`${label} must have mode 0700: ${path}`)
  const real = realpathSync(path)
  if (real !== path) cacheRefusal(`${label} must be canonical: ${path} -> ${real}`)
  return real
}

function defaultCacheParent(home) {
  const parent = join(home, '.cache')
  const stats = lstatOrUndefined(parent)
  if (stats === undefined) {
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    return parent
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    cacheRefusal(`the default cache parent must be a real directory: ${parent}`)
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    cacheRefusal(`the default cache parent must be owned by the current user: ${parent}`)
  }
  if ((stats.mode & 0o022) !== 0) {
    cacheRefusal(`the default cache parent must not be group/other writable: ${parent}`)
  }
  const real = realpathSync(parent)
  if (real !== parent) cacheRefusal(`the default cache parent must be canonical: ${parent} -> ${real}`)
  return parent
}

/**
 * Prepare the account-level pnpm download cache used by the Process
 * BOOTSTRAP install. Only pnpm's content store and metadata cache are shared;
 * every Scene still creates its own HOME, DSH_HOME, profile, lockfile and
 * node_modules and runs a real install.
 *
 * The default root is `<account home>/.cache/dsh-pi-tui-test`. The explicit
 * `SPLIT_VITEST_PNPM_CACHE_ROOT` override must already be an existing,
 * canonical, current-user-owned 0700 directory outside this checkout, the
 * candidate input directory and the private Scene base. The cache is never a
 * product setting and is never removed by Scene cleanup.
 */
export function prepareProcessInstallCache({ tmpBase, override, candidateTarball }) {
  let realTmpBase
  try {
    realTmpBase = realpathSync(tmpBase)
  } catch (error) {
    cacheRefusal(`requires a canonical tmpBase: ${String(error?.code ?? error?.name ?? 'unknown')}`)
  }
  let candidateDirectory
  try {
    candidateDirectory = dirname(realpathSync(candidateTarball))
  } catch (error) {
    cacheRefusal(`requires a canonical candidate tarball: ${String(error?.code ?? error?.name ?? 'unknown')}`)
  }
  let home
  try {
    home = realpathSync(userInfo().homedir)
  } catch (error) {
    cacheRefusal(`cannot canonicalize the account home: ${String(error?.code ?? error?.name ?? 'unknown')}`)
  }
  let root
  if (override === undefined) {
    // Do not create the default .cache parent (or any cache contents) until
    // the intended root's existing ancestor chain proves separation.
    root = join(home, '.cache', PROCESS_INSTALL_CACHE_ROOT_NAME)
  } else {
    if (typeof override !== 'string' || override === '') {
      cacheRefusal('SPLIT_VITEST_PNPM_CACHE_ROOT must not be empty')
    }
    root = qualifiedCacheDirectory(override, 'SPLIT_VITEST_PNPM_CACHE_ROOT', false)
  }
  const rootExists = existsSync(root)
  const rootChain = existingDirectoryChain(root)
  if (rootExists && rootChain.nearest === directoryIdentity(home)) {
    cacheRefusal('the account home itself cannot be the cache root')
  }
  for (const [label, path] of [
    ['checkout', realpathSync(PACKAGE_ROOT)],
    ['candidate input directory', candidateDirectory],
    ['SPLIT_VITEST_TMP_BASE', realTmpBase],
  ]) {
    if (directoriesOverlap(root, path)) cacheRefusal(`must not overlap the ${label}: ${root}`)
  }
  if (override === undefined) defaultCacheParent(home)
  qualifiedCacheDirectory(root, 'cache root', true)
  qualifiedCacheDirectory(join(root, 'pnpm-store'), 'pnpm store directory', true)
  qualifiedCacheDirectory(join(root, 'pnpm-cache'), 'pnpm cache directory', true)
  return root
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
export function createSplitSmokeProfile({ tarball, targetDshVersion, workDir, clientPlatformProvisioning = 'legacy-preseed', seedBuildPolicy = true, installCacheRoot }) {
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
  // Only the two install entry points see the shared download cache. The
  // Host/Client runtime environment (base.env below) keeps its existing values.
  const installEnv = installCacheRoot === undefined
    ? env
    : {
      ...env,
      PNPM_CONFIG_STORE_DIR: join(installCacheRoot, 'pnpm-store'),
      PNPM_CONFIG_CACHE_DIR: join(installCacheRoot, 'pnpm-cache'),
      ...PROCESS_INSTALL_CACHE_ENV,
    }
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
  runPnpmInstall(harnessDir, installEnv, distribution)
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
    installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`, harnessDir, installEnv, false)
    installPlugin(dsh, 'zustand@4.5.7', harnessDir, installEnv, false)
    installPlugin(dsh, 'immer@10.2.0', harnessDir, installEnv, false)
  }
  installPlugin(dsh, tarball, harnessDir, installEnv, false, { seedBuildPolicy })
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
