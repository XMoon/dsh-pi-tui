/**
 * The single test-tooling owner for account-level download caches used by the
 * isolated Split pnpm installers and the explicitly enabled standalone npm
 * smoke installers.
 *
 * The module validates the cache path against the actual checkout, the private
 * run root and every qualified candidate input, then returns either the shared
 * root (pnpm children) or the npm-only child used as npm's install cache. It
 * never installs, starts a process or creates a cache root on import, and it
 * does not take ownership of Scene cleanup.
 *
 * @module test-install-cache
 */

import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'

import { PACKAGE_ROOT } from './dsh-distribution.mjs'

const INSTALL_CACHE_ROOT_NAME = 'dsh-pi-tui-test'
const INSTALL_CACHE_ENV = Object.freeze({
  PNPM_CONFIG_PACKAGE_IMPORT_METHOD: 'copy',
  PNPM_CONFIG_VIRTUAL_STORE_TYPE: 'project',
  PNPM_CONFIG_SIDE_EFFECTS_CACHE: 'false',
})

function cacheRefusal(detail) {
  // A plain input failure with a stable message prefix: the historical lane
  // error-code registry must not grow a new long-lived code for this seam.
  throw new Error(`INPUT_UNQUALIFIED: install cache root ${detail}`)
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
 * Validate and return the shared cache root. Every forbidden root is checked
 * before a missing cache directory is created; each public entry then creates
 * only the children its installer actually needs.
 */
function prepareInstallCacheRoot({ tmpBase, override, candidateTarballs }) {
  if (!Array.isArray(candidateTarballs) || candidateTarballs.length === 0) {
    cacheRefusal('requires at least one qualified candidate tarball')
  }
  let realTmpBase
  try {
    realTmpBase = realpathSync(tmpBase)
  } catch (error) {
    cacheRefusal(`requires a canonical private cleanup root: ${String(error?.code ?? error?.name ?? 'unknown')}`)
  }
  const candidateDirectories = []
  for (const candidateTarball of candidateTarballs) {
    try {
      candidateDirectories.push(dirname(realpathSync(candidateTarball)))
    } catch (error) {
      cacheRefusal(`requires a canonical candidate tarball: ${String(error?.code ?? error?.name ?? 'unknown')}`)
    }
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
    root = join(home, '.cache', INSTALL_CACHE_ROOT_NAME)
  } else {
    if (typeof override !== 'string' || override === '') {
      cacheRefusal('the explicit install cache override must not be empty')
    }
    root = qualifiedCacheDirectory(override, 'the explicit install cache override', false)
  }
  const rootExists = existsSync(root)
  const rootChain = existingDirectoryChain(root)
  if (rootExists && rootChain.nearest === directoryIdentity(home)) {
    cacheRefusal('the account home itself cannot be the cache root')
  }
  for (const [label, path] of [
    ['checkout', realpathSync(PACKAGE_ROOT)],
    ...candidateDirectories.map((path, index) => [`candidate input directory ${String(index + 1)}`, path]),
    ['private cleanup root', realTmpBase],
  ]) {
    if (directoriesOverlap(root, path)) cacheRefusal(`must not overlap the ${label}: ${root}`)
  }
  if (override === undefined) defaultCacheParent(home)
  qualifiedCacheDirectory(root, 'cache root', true)
  return root
}

/**
 * Prepare the account-level pnpm download cache used by one isolated installer
 * scene. Only pnpm's content store and metadata cache are shared; every Scene
 * still creates its own HOME, DSH_HOME, profile, lockfile and node_modules and
 * runs a real install.
 *
 * The default root is `<account home>/.cache/dsh-pi-tui-test`. The explicit
 * override selected by the caller (the Split lanes pass
 * `SPLIT_VITEST_PNPM_CACHE_ROOT`; the standalone npm smokes pass
 * `DSH_TEST_INSTALL_CACHE_ROOT`) must already be an existing, canonical,
 * current-user-owned 0700 directory outside this checkout, every candidate
 * input directory and the private cleanup root. The cache is never a product
 * setting and is never removed by Scene cleanup.
 *
 * All forbidden roots are validated before any missing cache directory is
 * created.
 */
export function prepareInstallCache({ tmpBase, override, candidateTarballs }) {
  const root = prepareInstallCacheRoot({ tmpBase, override, candidateTarballs })
  qualifiedCacheDirectory(join(root, 'pnpm-store'), 'pnpm store directory', true)
  qualifiedCacheDirectory(join(root, 'pnpm-cache'), 'pnpm cache directory', true)
  return root
}

/**
 * Prepare only the npm download cache child for the real npm tarball smoke.
 * The shared root qualification is identical to the pnpm entry, but this
 * function never creates pnpm children and never derives an installer
 * environment: the caller passes the returned child as npm's `--cache` value.
 * An existing unsafe child is refused without being followed, repaired or
 * removed.
 */
export function prepareNpmInstallCache({ tmpBase, override, candidateTarballs }) {
  const root = prepareInstallCacheRoot({ tmpBase, override, candidateTarballs })
  return qualifiedCacheDirectory(join(root, 'npm-cache'), 'npm cache directory', true)
}

/**
 * The install-only environment for an already-qualified cache root. An
 * undefined root is the explicit no-cache path and returns the original
 * environment unchanged; the original object is never mutated.
 */
export function installCacheEnvironment(env, installCacheRoot) {
  if (installCacheRoot === undefined) return env
  return {
    ...env,
    PNPM_CONFIG_STORE_DIR: join(installCacheRoot, 'pnpm-store'),
    PNPM_CONFIG_CACHE_DIR: join(installCacheRoot, 'pnpm-cache'),
    ...INSTALL_CACHE_ENV,
  }
}
