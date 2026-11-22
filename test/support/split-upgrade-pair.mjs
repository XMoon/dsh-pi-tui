/**
 * The ONE pure two-artifact preflight for the Split Upgrade scenes.
 *
 * This module performs no I/O beyond reading the two explicitly named `.tgz`
 * files and their `package/package.json` entries. It creates no work root,
 * starts no install and never touches a Supervisor, so an invalid pairing is
 * rejected before any Scene exists.
 *
 * The returned facts contain only validated values: real package paths,
 * package versions, SHA256 digests and the exact DSH pins. Raw manifest text,
 * environment secrets and unvalidated user strings are never carried.
 *
 * @module split-upgrade-pair
 */

import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import semver from 'semver'

import { readCandidatePackageData, sha256 } from '../../scripts/lib/dsh-smoke-harness.mjs'
import { npmDshVersion } from '../../scripts/lib/dsh-distribution.mjs'
import {
  requireExactSmokeDshPin,
  SplitSmokeInputError,
  smokeArtifactIdentity,
} from '../../scripts/lib/split-smoke-diagnostics.mjs'

export const UPGRADE_PACKAGE_NAME = '@xmoon76/dsh-pi-tui'
export const OLD_TARBALL_ENV = 'SPLIT_VITEST_UPGRADE_OLD_TGZ'
export const NEW_TARBALL_ENV = 'SPLIT_VITEST_UPGRADE_NEW_TGZ'

export const UPGRADE_PAIR_POLICIES = Object.freeze(['default', 'native'])

function inputError(code, message, facts = {}, cause) {
  const error = new SplitSmokeInputError(code, `INPUT_UNQUALIFIED: ${code} (INVALID_TEST_PAIRING, not a product regression): ${message}`, facts)
  if (cause !== undefined) error.cause = cause
  return error
}

/**
 * Validate one explicitly supplied `.tgz` path without creating anything.
 * Both inputs must be absolute, single hard-linked regular files (not
 * symlinks) ending in `.tgz`, and their canonical paths must differ.
 */
function inspectTarballPath(rawPath, role) {
  if (typeof rawPath !== 'string' || rawPath === '' || !isAbsolute(rawPath)) {
    throw inputError('INPUT_TARBALL_PATH_UNQUALIFIED', `the ${role} tarball must be an absolute path`, { role })
  }
  let info
  try {
    info = lstatSync(rawPath)
  } catch (error) {
    throw inputError('INPUT_TARBALL_PATH_UNQUALIFIED', `the ${role} tarball does not exist: ${rawPath}`, { role }, error)
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw inputError('INPUT_TARBALL_FILE_UNQUALIFIED', `the ${role} tarball must be a regular file, not a symlink or special file: ${rawPath}`, { role })
  }
  if (info.nlink !== 1) {
    throw inputError('INPUT_TARBALL_HARDLINK_UNQUALIFIED', `the ${role} tarball must have exactly one hard link: ${rawPath}`, { role })
  }
  if (!rawPath.endsWith('.tgz')) {
    throw inputError('INPUT_TARBALL_EXTENSION_UNQUALIFIED', `the ${role} tarball must end in .tgz: ${rawPath}`, { role })
  }
  let real
  try {
    real = realpathSync(rawPath)
  } catch (error) {
    throw inputError('INPUT_TARBALL_PATH_UNQUALIFIED', `the ${role} tarball is not readable: ${rawPath}`, { role }, error)
  }
  return real
}

function readManifest(realPath, role, targetDshVersion) {
  let manifest
  try {
    manifest = readCandidatePackageData(realPath)
  } catch (error) {
    // `readCandidatePackageData` is shared with the historical single-candidate
    // lanes and raises `CompatFailure` there. At this real input boundary the
    // same malformed-tar condition is a test-pairing input error; preserve the
    // original cause for diagnosis without rewriting the shared consumer.
    throw inputError('INPUT_TARBALL_MANIFEST_INVALID', `the ${role} tarball has no readable package/package.json`, {
      role,
      targetDshVersion,
    }, error)
  }
  if (manifest?.name !== UPGRADE_PACKAGE_NAME) {
    throw inputError('INPUT_PACKAGE_NAME_MISMATCH', `the ${role} tarball must be ${UPGRADE_PACKAGE_NAME}`, {
      role,
      targetDshVersion,
      artifact: smokeArtifactIdentity(role, manifest, undefined),
    })
  }
  if (typeof manifest.version !== 'string' || semver.valid(manifest.version) === null) {
    throw inputError('INPUT_PACKAGE_VERSION_INVALID', `the ${role} tarball declares no valid SemVer version`, {
      role,
      targetDshVersion,
      artifact: smokeArtifactIdentity(role, manifest, undefined),
    })
  }
  const manifestPin = requireExactSmokeDshPin(role, manifest, targetDshVersion, {
    artifact: smokeArtifactIdentity(role, manifest, undefined),
  })
  return { manifest, manifestPin }
}

function inspectOne(rawPath, role, targetDshVersion) {
  const path = inspectTarballPath(rawPath, role)
  const { manifest, manifestPin } = readManifest(path, role, targetDshVersion)
  return {
    path,
    version: manifest.version,
    sha256: sha256(path),
    manifestPin,
  }
}

/**
 * Qualify the exact old/new pair. `policy='default'` requires two different
 * package versions; the trusted `native` project may pair two same-SemVer
 * builds whose real production build ids differ (checked at install time).
 */
export function inspectSplitUpgradePair(oldTgz, newTgz, options = {}) {
  const policy = options.policy ?? 'default'
  if (!UPGRADE_PAIR_POLICIES.includes(policy)) {
    throw inputError('INPUT_PAIR_POLICY_INVALID', `the upgrade pair policy must be default or native, got ${String(policy)}`)
  }
  const targetDshVersion = npmDshVersion()
  const old = inspectOne(oldTgz, 'old', targetDshVersion)
  const newArtifact = inspectOne(newTgz, 'new', targetDshVersion)
  if (old.path === newArtifact.path) {
    throw inputError('INPUT_PAIR_SAME_PATH', 'the old and new artifacts must resolve to different paths', {
      role: 'old',
      targetDshVersion,
      artifact: null,
    })
  }
  if (old.sha256 === newArtifact.sha256) {
    throw inputError('INPUT_PAIR_SAME_SHA', 'the old and new artifacts must have different SHA256 digests', {
      role: 'old',
      targetDshVersion,
    })
  }
  if (policy === 'default' && old.version === newArtifact.version) {
    throw inputError('INPUT_PAIR_SAME_VERSION', 'the default upgrade project requires different old/new package versions', {
      role: 'old',
      targetDshVersion,
    })
  }
  return {
    old,
    new: newArtifact,
    targetDshVersion,
    policy,
  }
}

/** Read the two required absolute environment inputs; no implicit file search. */
export function readSplitUpgradePairEnvironment() {
  const oldTgz = process.env[OLD_TARBALL_ENV]
  const newTgz = process.env[NEW_TARBALL_ENV]
  if (typeof oldTgz !== 'string' || oldTgz === '' || !isAbsolute(oldTgz)) {
    throw inputError('INPUT_TARBALL_PATH_UNQUALIFIED', `${OLD_TARBALL_ENV} must be an absolute path`, { role: 'old' })
  }
  if (typeof newTgz !== 'string' || newTgz === '' || !isAbsolute(newTgz)) {
    throw inputError('INPUT_TARBALL_PATH_UNQUALIFIED', `${NEW_TARBALL_ENV} must be an absolute path`, { role: 'new' })
  }
  return { oldTgz, newTgz }
}

/**
 * Re-read the actual package bytes and compare them with the facts captured by
 * the Worker. A replaced/symlinked/changed tarball is an input error, never a
 * Host or Client product failure.
 */
export function assertSplitUpgradePairStillQualified(pair) {
  const fresh = inspectSplitUpgradePair(pair.old.path, pair.new.path, { policy: pair.policy })
  const changed = fresh.old.sha256 !== pair.old.sha256
    || fresh.new.sha256 !== pair.new.sha256
    || fresh.old.version !== pair.old.version
    || fresh.new.version !== pair.new.version
    || fresh.old.manifestPin !== pair.old.manifestPin
    || fresh.new.manifestPin !== pair.new.manifestPin
  if (changed) {
    throw inputError('INPUT_PAIR_CHANGED', 'the old/new artifacts changed after the initial preflight', {
      role: 'old',
      targetDshVersion: pair.targetDshVersion,
    })
  }
  return fresh
}
