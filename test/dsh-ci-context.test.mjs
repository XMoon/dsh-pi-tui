import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { testLifecycle } from './support/temp-lifecycle.ts'
import {
  resolveDshContext,
  resolveDshMode,
} from '../scripts/dsh-ci-context.mjs'

const nextSha = 'ddefc45fbc7f8e46dd73185e68295696d1297887'
const expectedNpmDshVersion = Object.entries(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).devDependencies ?? {})
  .find(([name]) => name.startsWith('@deepseek-ai/dsh'))?.[1]
const expectedNpmTarget = process.env.DSH_NPM_VERIFY_TARGET ?? '0.1.6-alpha.2'

/** A temp mode-config file with the given mode (the tracked policy is
 * injectable so the source branch of the resolver is testable without
 * mutating the repository). The directory is owned by the TEST LIFECYCLE
 * (temp-hygiene gate: no direct temp-dir creation in test files — the
 * owning test disposes the directory at teardown). */
function tempModeConfig(mode, life) {
  const dir = life.tempDir('dsh-mode-test-')
  const path = join(dir, 'dsh-mode.json')
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, mode }))
  return { dir, path }
}

test('DSH mode resolver follows the tracked policy for next, npm elsewhere', () => {
  // The tracked test/compat/dsh-mode.json routes next events to the published
  // npm family; unrelated branches and release behavior remain npm.
  assert.equal(resolveDshMode({ eventName: 'push', ref: 'refs/heads/next' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'pull_request', ref: 'refs/pull/1/merge', baseRef: 'next' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'push', ref: 'refs/heads/main' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'pull_request', ref: 'refs/pull/2/merge', baseRef: 'main' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'push', ref: 'refs/heads/feature/next' }), 'npm')
  // Manual/scheduled runs remain npm unless the workflow explicitly supplies
  // the source mode context; only push and next-targeted PRs follow the policy.
  assert.equal(resolveDshMode({ eventName: 'workflow_dispatch', ref: 'refs/heads/next' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'schedule', ref: 'refs/heads/next' }), 'npm')
})

test('a tracked source policy flips next to source mode (one-line branch switch)', (t) => {
  const life = testLifecycle(t)
  const { path } = tempModeConfig('source', life)
  assert.equal(resolveDshMode({ eventName: 'push', ref: 'refs/heads/next', modeConfigPath: path }), 'source')
  assert.equal(
    resolveDshMode({ eventName: 'pull_request', ref: 'refs/pull/1/merge', baseRef: 'next', modeConfigPath: path }),
    'source',
  )
  // Non-next branches ignore the policy.
  assert.equal(resolveDshMode({ eventName: 'push', ref: 'refs/heads/main', modeConfigPath: path }), 'npm')
})

test('a missing or malformed mode policy is an explicit error on next', (t) => {
  const life = testLifecycle(t)
  const { dir, path } = tempModeConfig('npm', life)
  assert.throws(() => resolveDshMode({ eventName: 'push', ref: 'refs/heads/next', modeConfigPath: join(dir, 'missing.json') }), /missing/u)
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, mode: 'bogus' }))
  assert.throws(() => resolveDshMode({ eventName: 'push', ref: 'refs/heads/next', modeConfigPath: path }), /unsupported DSH mode/u)
})

test('all release tags force npm mode, including next-v tags', () => {
  for (const ref of ['refs/tags/next-v0.4.0-alpha.1', 'refs/tags/v0.4.0']) {
    assert.equal(resolveDshMode({ eventName: 'push', ref }), 'npm')
    assert.throws(() => resolveDshMode({ eventName: 'push', ref, forcedMode: 'source' }), /release tag/u)
  }
})

test('context uses the current DSH target in every mode and exposes the source pin only in source mode', (t) => {
  assert.equal(expectedNpmDshVersion, expectedNpmTarget, 'the package must keep the declared npm target')
  const life = testLifecycle(t)
  const main = resolveDshContext({ eventName: 'push', ref: 'refs/heads/main' })
  assert.equal(main.mode, 'npm')
  assert.equal(main.version, expectedNpmDshVersion)
  assert.equal(main.sourceRef, '')
  assert.equal(main.sourceExpectedVersion, '')

  // The tracked policy now routes next to the published npm distribution; the
  // root package's npm metadata is the target for both main and next.
  const next = resolveDshContext({ eventName: 'push', ref: 'refs/heads/next' })
  assert.equal(next.mode, 'npm')
  assert.equal(next.version, expectedNpmDshVersion)
  assert.equal(next.sourceRef, '')
  assert.equal(next.sourceExpectedVersion, '')

  // A PR targeting next resolves the same npm context.
  const pr = resolveDshContext({ eventName: 'pull_request', ref: 'refs/pull/94/merge', baseRef: 'next' })
  assert.equal(pr.mode, 'npm')
  assert.equal(pr.version, expectedNpmDshVersion)
  assert.equal(pr.sourceRef, '')
  assert.equal(pr.sourceExpectedVersion, '')

  // The injectable policy still overrides for other branches and exposes the
  // tracked source identity.
  const { path } = tempModeConfig('source', life)
  const forcedSource = resolveDshContext({ eventName: 'push', ref: 'refs/heads/next', modeConfigPath: path })
  assert.equal(forcedSource.mode, 'source')
  assert.equal(forcedSource.version, '0.1.6-alpha.2')
  assert.equal(forcedSource.sourceRef, nextSha)
  assert.equal(forcedSource.sourceExpectedVersion, '0.1.6-alpha.2')
})
