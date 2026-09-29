import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseReleaseTag } from '../scripts/release-context.mjs'

test('parses v tags to latest regardless of SemVer maturity', () => {
  for (const [tag, version, isPrerelease] of [
    ['v1.2.3', '1.2.3', false],
    ['v1.2.3-alpha.1', '1.2.3-alpha.1', true],
    ['v1.2.3-beta.2', '1.2.3-beta.2', true],
    ['v1.2.3-rc.1', '1.2.3-rc.1', true],
  ]) {
    assert.deepEqual(parseReleaseTag(tag), {
      channel: 'latest',
      version,
      npmTag: 'latest',
      isPrerelease,
    })
  }
})

test('parses next-v tags to next regardless of SemVer maturity', () => {
  for (const [tag, version, isPrerelease] of [
    ['next-v1.2.3', '1.2.3', false],
    ['next-v1.2.3-alpha.1', '1.2.3-alpha.1', true],
    ['next-v1.2.3-beta.2', '1.2.3-beta.2', true],
    ['next-v1.2.3-rc.1', '1.2.3-rc.1', true],
  ]) {
    assert.deepEqual(parseReleaseTag(tag), {
      channel: 'next',
      version,
      npmTag: 'next',
      isPrerelease,
    })
  }
})

test('rejects malformed tags', () => {
  for (const tag of ['1.2.3', 'release-v1.2.3', 'next-foo', 'next-v', 'next-vinvalid', 'vinvalid', 'v1.2.3-01', 'next-v1.2.3-alpha.01']) {
    assert.throws(() => parseReleaseTag(tag), /release tag|SemVer/)
  }
})

test('keeps build-metadata leading zeroes legal (SemVer 2.0.0)', () => {
  assert.deepEqual(parseReleaseTag('v1.2.3+build.01'), {
    channel: 'latest',
    version: '1.2.3+build.01',
    npmTag: 'latest',
    isPrerelease: false,
  })
})

test('CLI emits the channel outputs and never required_branch', () => {
  const result = spawnSync(
    process.execPath,
    [resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'release-context.mjs'), 'v1.2.3-rc.1'],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, [
    'channel=latest',
    'version=1.2.3-rc.1',
    'npm_tag=latest',
    'is_prerelease=true',
    '',
  ].join('\n'))
  assert.doesNotMatch(result.stdout, /required_branch/u)

  const output = join(tmpdir(), `release-context-github-output-${process.pid}`)
  try {
    const env = { ...process.env, GITHUB_OUTPUT: output }
    const gh = spawnSync(
      process.execPath,
      [resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'release-context.mjs'), 'next-v1.2.3'],
      { encoding: 'utf8', env },
    )
    assert.equal(gh.status, 0, gh.stderr)
    assert.equal(readFileSync(output, 'utf8'), [
      'channel=next',
      'version=1.2.3',
      'npm_tag=next',
      'is_prerelease=false',
      '',
    ].join('\n'))
  } finally {
    rmSync(output, { force: true })
  }
})
