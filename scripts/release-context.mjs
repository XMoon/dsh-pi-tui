#!/usr/bin/env node
/**
 * Parse the repository's release tag once and expose the result to CI.
 *
 * The tag prefix is the sole publication-channel authority: `v<semver>` tags
 * publish `latest` and `next-v<semver>` tags publish `next`. SemVer maturity
 * (prerelease suffix or not) is an independent dimension that never selects
 * the channel. The `next-` prefix is a release-channel marker, not part of
 * package.json's version.
 *
 * @module release-context
 */

import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Strict SemVer 2.0.0: numeric identifiers (core or numeric prerelease
// identifiers) carry no leading zeroes; build-metadata identifiers may.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

/**
 * Parse and validate one release tag.
 * @param {string} tag
 * @returns {{channel: 'latest'|'next', version: string, npmTag: 'latest'|'next', isPrerelease: boolean}}
 */
export function parseReleaseTag(tag) {
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new Error('release tag is required')
  }

  let channel
  let version
  if (tag.startsWith('next-v')) {
    channel = 'next'
    version = tag.slice('next-v'.length)
  } else if (tag.startsWith('v')) {
    channel = 'latest'
    version = tag.slice(1)
  } else {
    throw new Error(`unsupported release tag ${tag}; expected v<version> or next-v<version>`)
  }

  const match = SEMVER.exec(version)
  if (match === null) throw new Error(`release tag ${tag} does not contain a valid SemVer version`)
  const isPrerelease = match[4] !== undefined

  return {
    channel,
    version,
    npmTag: channel,
    isPrerelease,
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
    })) console.log(`${key}=${value}`)
    writeGitHubOutput(context)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
