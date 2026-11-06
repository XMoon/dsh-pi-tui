/**
 * The PURE published-pairing selector for the pi2dsh ecosystem probe.
 *
 * Inputs are already-fetched npm registry metadata; this module performs no
 * I/O, keeps no cache and does not know the candidate artifact's tarball. The
 * caller freezes the returned exact versions for the rest of its run.
 *
 * Semantics (the npm/node-semver rules the ecosystem actually observes):
 *
 * - every declared `@deepseek-ai/dsh*` peer range on BOTH the published bridge
 *   and the candidate TUI must be valid semver, and the selected DSH version
 *   must satisfy each of them with npm's PRERELEASE rule;
 * - a candidate `engines.dsh` range is applied with the official
 *   `includePrerelease: true` semantics, exactly like the product's own
 *   engines check;
 * - the highest published DSH version satisfying every constraint wins;
 * - a valid-but-lagging `@xmoon76/dsh-pi-tui` consumer peer is reported as
 *   `tuiPeerDrift` (a warning), never used to reject a runnable DSH;
 * - a missing or invalid TUI peer is broken consumer metadata, not drift.
 *
 * `investigativeForcePeers` skips ONLY the bridge's DSH peer constraints (the
 * explicit manual investigation path); the candidate TUI constraints still
 * apply. The result is never a published compatibility claim.
 *
 * @module pi2dsh-compat-selection
 */

import semver from 'semver'

const EXPECTED_TUI_PACKAGE_NAME = '@xmoon76/dsh-pi-tui'
const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'
const DSH_PACKAGE_PREFIX = `${DSH_PACKAGE_NAME}-`

function isDshPeerName(name) {
  return name === DSH_PACKAGE_NAME || name.startsWith(DSH_PACKAGE_PREFIX)
}

function assertExactVersion(label, value) {
  if (typeof value !== 'string' || semver.valid(value) !== value) {
    throw new Error(`${label} ${JSON.stringify(value)} is not an exact semver version`)
  }
}

function assertRange(label, name, range) {
  if (typeof range !== 'string' || range.trim() === '' || semver.validRange(range) === null) {
    throw new Error(`${label} ${name} declares an invalid semver range ${JSON.stringify(range)}`)
  }
}

/**
 * The declared DSH peers of one package. A DSH-ish key with a malformed range
 * is broken metadata, not a peer that simply did not match: it throws.
 */
function dshPeerEntries(packageJson, label) {
  const peers = Object.entries(packageJson.peerDependencies ?? {})
  return peers
    .filter(([name]) => isDshPeerName(name))
    .map(([name, range]) => {
      assertRange(label, name, range)
      return [name, range]
    })
}

function publishedVersionList(publishedDshVersions) {
  if (!Array.isArray(publishedDshVersions) || publishedDshVersions.length === 0) {
    throw new Error('the published @deepseek-ai/dsh version list is empty or not an array')
  }
  for (const version of publishedDshVersions) assertExactVersion('published @deepseek-ai/dsh version', version)
  return [...new Set(publishedDshVersions)].sort(semver.rcompare)
}

function publishedRangeSummary(versions) {
  if (versions.length === 0) return '(none)'
  return versions.length === 1 ? versions[0] : `${versions.at(-1)} … ${versions[0]} (${versions.length} versions)`
}

function describePeerEntries(entries) {
  return entries.length === 0 ? '  (none declared)' : entries.map(([name, range]) => `  ${name}: ${range}`).join('\n')
}

function noIntersectionError({ consumerPackage, candidatePackage, publishedDshVersions, bridgeDshPeers, candidateDshPeers, candidateEnginesDsh, investigativeForcePeers }) {
  return new Error([
    `${consumerPackage.name}@${consumerPackage.version} and ${candidatePackage.name}@${candidatePackage.version} have no installable published DSH intersection.`,
    `candidate engines.dsh: ${candidateEnginesDsh ?? '(none)'}`,
    'bridge declared DSH peers:',
    describePeerEntries(bridgeDshPeers),
    ...(investigativeForcePeers ? ['(bridge DSH peers are skipped in investigative mode)'] : []),
    'candidate declared DSH peers:',
    describePeerEntries(candidateDshPeers),
    `published @deepseek-ai/dsh versions: ${publishedRangeSummary(publishedDshVersions)}`,
  ].join('\n'))
}

/**
 * Select the exact (pi2dsh, DSH) pair for one run.
 *
 * @param {{
 *   consumerPackage: object,
 *   candidatePackage: object,
 *   publishedDshVersions: string[],
 *   investigativeForcePeers?: boolean,
 * }} input
 * @returns {{pi2dshVersion: string, dshVersion: string, tuiPeerDrift: boolean}}
 */
export function selectPublishedPi2dshPairing({
  consumerPackage,
  candidatePackage,
  publishedDshVersions,
  investigativeForcePeers = false,
}) {
  if (consumerPackage === null || typeof consumerPackage !== 'object' || Array.isArray(consumerPackage)) {
    throw new Error('published pi2dsh metadata is not a package object')
  }
  if (consumerPackage.name !== 'pi2dsh') {
    throw new Error(`published consumer is ${JSON.stringify(consumerPackage.name)}, not 'pi2dsh'`)
  }
  assertExactVersion('published pi2dsh version', consumerPackage.version)
  if (consumerPackage.peerDependencies !== undefined
    && (consumerPackage.peerDependencies === null || typeof consumerPackage.peerDependencies !== 'object' || Array.isArray(consumerPackage.peerDependencies))) {
    throw new Error('published pi2dsh peerDependencies is not an object')
  }
  if (candidatePackage === null || typeof candidatePackage !== 'object' || Array.isArray(candidatePackage)) {
    throw new Error('candidate TUI metadata is not a package object')
  }
  assertExactVersion('candidate TUI version', candidatePackage.version)
  if (candidatePackage.peerDependencies !== undefined
    && (candidatePackage.peerDependencies === null || typeof candidatePackage.peerDependencies !== 'object' || Array.isArray(candidatePackage.peerDependencies))) {
    throw new Error('candidate TUI peerDependencies is not an object')
  }
  if (candidatePackage.engines !== undefined
    && (candidatePackage.engines === null || typeof candidatePackage.engines !== 'object' || Array.isArray(candidatePackage.engines))) {
    throw new Error('candidate TUI engines is not an object')
  }

  const tuiPeer = consumerPackage.peerDependencies?.[EXPECTED_TUI_PACKAGE_NAME]
  if (typeof tuiPeer !== 'string' || tuiPeer.trim() === '') {
    throw new Error(`published pi2dsh metadata does not declare a ${EXPECTED_TUI_PACKAGE_NAME} peer`)
  }
  assertRange('published pi2dsh peer', EXPECTED_TUI_PACKAGE_NAME, tuiPeer)

  const bridgeDshPeers = dshPeerEntries(consumerPackage, 'published pi2dsh')
  const candidateDshPeers = dshPeerEntries(candidatePackage, 'candidate TUI')
  const candidateEnginesDsh = candidatePackage.engines?.dsh
  if (candidateEnginesDsh !== undefined) assertRange('candidate TUI engines', 'dsh', candidateEnginesDsh)

  const versions = publishedVersionList(publishedDshVersions)
  const selected = versions.find(version =>
    (investigativeForcePeers || bridgeDshPeers.every(([, range]) => semver.satisfies(version, range)))
    && candidateDshPeers.every(([, range]) => semver.satisfies(version, range))
    && (candidateEnginesDsh === undefined || semver.satisfies(version, candidateEnginesDsh, { includePrerelease: true })))

  if (selected === undefined) {
    throw noIntersectionError({
      consumerPackage,
      candidatePackage,
      publishedDshVersions: versions,
      bridgeDshPeers,
      candidateDshPeers,
      candidateEnginesDsh,
      investigativeForcePeers,
    })
  }
  return {
    pi2dshVersion: consumerPackage.version,
    dshVersion: selected,
    tuiPeerDrift: !semver.satisfies(candidatePackage.version, tuiPeer),
  }
}
