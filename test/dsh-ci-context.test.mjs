import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveDshContext,
  resolveDshMode,
} from '../scripts/dsh-ci-context.mjs'

const nextSha = '4e84901e6471b79ec0338099867ebb4606d12bb5'

/** A temp mode-config file with the given mode (the tracked policy is
 * injectable so the source branch of the resolver is testable without
 * mutating the repository). */
function tempModeConfig(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mode-test-'))
  const path = join(dir, 'dsh-mode.json')
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, mode }))
  return { dir, path }
}

test('DSH mode resolver follows the tracked policy for next, npm elsewhere', () => {
  // The tracked test/compat/dsh-mode.json currently says npm.
  assert.equal(resolveDshMode({ eventName: 'push', ref: 'refs/heads/next' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'pull_request', ref: 'refs/pull/1/merge', baseRef: 'next' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'push', ref: 'refs/heads/main' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'pull_request', ref: 'refs/pull/2/merge', baseRef: 'main' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'push', ref: 'refs/heads/feature/next' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'workflow_dispatch', ref: 'refs/heads/next' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'schedule', ref: 'refs/heads/next' }), 'npm')
})

test('a tracked source policy flips next to source mode (one-line branch switch)', () => {
  const { dir, path } = tempModeConfig('source')
  try {
    assert.equal(resolveDshMode({ eventName: 'push', ref: 'refs/heads/next', modeConfigPath: path }), 'source')
    assert.equal(
      resolveDshMode({ eventName: 'pull_request', ref: 'refs/pull/1/merge', baseRef: 'next', modeConfigPath: path }),
      'source',
    )
    // Non-next branches ignore the policy.
    assert.equal(resolveDshMode({ eventName: 'push', ref: 'refs/heads/main', modeConfigPath: path }), 'npm')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing or malformed mode policy is an explicit error on next', () => {
  const { dir, path } = tempModeConfig('npm')
  try {
    assert.throws(() => resolveDshMode({ eventName: 'push', ref: 'refs/heads/next', modeConfigPath: join(dir, 'missing.json') }), /missing/u)
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, mode: 'bogus' }))
    assert.throws(() => resolveDshMode({ eventName: 'push', ref: 'refs/heads/next', modeConfigPath: path }), /unsupported DSH mode/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('all release tags force npm mode, including next-v tags', () => {
  for (const ref of ['refs/tags/next-v0.4.0-alpha.1', 'refs/tags/v0.4.0']) {
    assert.equal(resolveDshMode({ eventName: 'push', ref }), 'npm')
    assert.throws(() => resolveDshMode({ eventName: 'push', ref, forcedMode: 'source' }), /release tag/u)
  }
})

test('context exposes the tracked source pin only in source mode', () => {
  const npm = resolveDshContext({ eventName: 'push', ref: 'refs/heads/next' })
  assert.equal(npm.mode, 'npm')
  assert.equal(npm.sourceRef, '')
  assert.equal(npm.sourceExpectedVersion, '')

  const main = resolveDshContext({ eventName: 'push', ref: 'refs/heads/main' })
  assert.equal(main.mode, 'npm')
  assert.equal(main.sourceRef, '')
  assert.equal(main.sourceExpectedVersion, '')

  const { dir, path } = tempModeConfig('source')
  try {
    const source = resolveDshContext({ eventName: 'push', ref: 'refs/heads/next', modeConfigPath: path })
    assert.equal(source.mode, 'source')
    assert.equal(source.sourceRef, nextSha)
    assert.equal(source.sourceExpectedVersion, '0.1.2-alpha.4')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
