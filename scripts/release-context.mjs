#!/usr/bin/env node
/**
 * Parse the repository's release-channel tag once and expose the result to CI.
 *
 * Stable tags are `v<stable-semver>` and publish `latest`. Prerelease tags are
 * `next-v<prerelease-semver>` and publish `next`. The `next-` prefix is a
 * release-channel marker, not part of package.json's version.
 *
 * @module release-context
 */

import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

/**
 * Parse and validate one release tag.
 * @param {string} tag
 * @returns {{channel: 'stable'|'next', version: string, npmTag: 'latest'|'next', isPrerelease: boolean, requiredBranch: 'main'|'next'}}
 */
export function parseReleaseTag(tag) {
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new Error('release tag is required')
  }

  let channel
  let version
  if (tag.startsWith('next-')) {
    channel = 'next'
    version = tag.slice('next-v'.length)
  } else if (tag.startsWith('v')) {
    channel = 'stable'
    version = tag.slice(1)
  } else {
    throw new Error(`unsupported release tag ${tag}; expected v<version> or next-v<prerelease>`)
  }

  const match = SEMVER.exec(version)
  if (match === null) throw new Error(`release tag ${tag} does not contain a valid SemVer version`)
  const isPrerelease = match[4] !== undefined

  if (channel === 'next' && !isPrerelease) {
    throw new Error(`next release tag ${tag} must contain a prerelease SemVer`)
  }
  if (channel === 'stable' && isPrerelease) {
    throw new Error(`stable release tag ${tag} must contain a stable SemVer`)
  }

  return {
    channel,
    version,
    npmTag: channel === 'next' ? 'next' : 'latest',
    isPrerelease,
    requiredBranch: channel === 'next' ? 'next' : 'main',
  }
}

function writeGitHubOutput(context) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (typeof outputPath !== 'string' || outputPath === '') return
  const lines = [
    ['channel', context.channel],
    ['version', context.version],
    ['npm_tag', context.npmTag],
    ['is_prerelease', String(context.isPrerelease)],
    ['required_branch', context.requiredBranch],
  ]
  appendFileSync(outputPath, lines.map(([key, value]) => `${key}=${value}`).join('\n') + '\n')
}

/** Run as a CI helper: print key/value outputs and append GITHUB_OUTPUT. */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const context = parseReleaseTag(process.argv[2])
    for (const [key, value] of Object.entries({
      channel: context.channel,
      version: context.version,
      npm_tag: context.npmTag,
      is_prerelease: String(context.isPrerelease),
      required_branch: context.requiredBranch,
    })) console.log(`${key}=${value}`)
    writeGitHubOutput(context)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
