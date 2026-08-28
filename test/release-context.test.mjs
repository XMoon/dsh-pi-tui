import assert from 'node:assert/strict'
import test from 'node:test'
import { parseReleaseTag } from '../scripts/release-context.mjs'

test('parses stable tags to main/latest', () => {
  assert.deepEqual(parseReleaseTag('v0.3.6'), {
    channel: 'stable',
    version: '0.3.6',
    npmTag: 'latest',
    isPrerelease: false,
    requiredBranch: 'main',
  })
  assert.deepEqual(parseReleaseTag('v0.4.0'), {
    channel: 'stable',
    version: '0.4.0',
    npmTag: 'latest',
    isPrerelease: false,
    requiredBranch: 'main',
  })
})

test('parses next prerelease tags to next/next', () => {
  for (const tag of ['next-v0.4.0-alpha.1', 'next-v0.4.0-beta.2', 'next-v0.4.0-rc.3']) {
    assert.deepEqual(parseReleaseTag(tag), {
      channel: 'next',
      version: tag.slice('next-v'.length),
      npmTag: 'next',
      isPrerelease: true,
      requiredBranch: 'next',
    })
  }
})

test('rejects channel and semver mismatches', () => {
  for (const tag of ['next-v0.4.0', 'v0.4.0-alpha.1', 'next-foo', '0.4.0', 'next-v']) {
    assert.throws(() => parseReleaseTag(tag), /release tag|SemVer/)
  }
})
