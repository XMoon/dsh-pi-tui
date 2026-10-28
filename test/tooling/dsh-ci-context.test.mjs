import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  CI_CONFIG_DEFAULTS,
  resolveCiConfig,
  resolveDshContext,
  resolveDshMode,
} from '../../scripts/dsh-ci-context.mjs'

const expectedNpmDshVersion = Object.entries(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).devDependencies ?? {})
  .find(([name]) => name.startsWith('@deepseek-ai/dsh'))?.[1]
const expectedNpmTarget = process.env.DSH_NPM_VERIFY_TARGET ?? expectedNpmDshVersion
// The tracked source pin is the expectation for forced-source resolutions:
// read it instead of duplicating the ref/version a second time here.
const trackedSourceConfig = JSON.parse(readFileSync(new URL('../compat/dsh-source.json', import.meta.url), 'utf8'))

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
  assert.equal(forcedSource.version, trackedSourceConfig.expectedVersion)
  assert.equal(forcedSource.sourceRef, trackedSourceConfig.ref)
  assert.equal(forcedSource.sourceExpectedVersion, trackedSourceConfig.expectedVersion)
})


// ---------------------------------------------------------------------------
// The accelerated DAG's SHAPE.
//
// The three dimensions are not interchangeable, and the cost of confusing
// them is silent: a run that says "4 shards, concurrency 8" and actually ran
// one shard at Node's default still produces a complete-looking report. So
// each variable is resolved ONCE here, validated, and handed to the matrix,
// the runner and the aggregate as one record.
// ---------------------------------------------------------------------------

test('an ABSENT or EMPTY variable is the measured default, not zero', () => {
  // Actions renders an unset `vars` entry as an empty string; treating that
  // as 0 shards would produce an empty matrix that no job ever reports on.
  assert.deepEqual(resolveCiConfig({}), { shardTotal: 4, shards: [1, 2, 3, 4], maxParallel: 4, testConcurrency: 'default' })
  assert.deepEqual(resolveCiConfig({ shards: '', maxParallel: '', testConcurrency: '' }),
    { shardTotal: 4, shards: [1, 2, 3, 4], maxParallel: 4, testConcurrency: 'default' })
  assert.deepEqual(CI_CONFIG_DEFAULTS, { shards: 4, maxParallel: 4, testConcurrency: 'default' })
})

test('explicit integers are carried through EXACTLY', () => {
  assert.deepEqual(resolveCiConfig({ shards: '1' }), { shardTotal: 1, shards: [1], maxParallel: 4, testConcurrency: 'default' })
  assert.deepEqual(resolveCiConfig({ shards: '2', maxParallel: '2', testConcurrency: '8' }),
    { shardTotal: 2, shards: [1, 2], maxParallel: 2, testConcurrency: '8' })
  assert.deepEqual(resolveCiConfig({ shards: '3', maxParallel: '1', testConcurrency: '1' }),
    { shardTotal: 3, shards: [1, 2, 3], maxParallel: 1, testConcurrency: '1' })
})

test('the MAX PARALLEL cap does not change the partition', () => {
  // The cap is a scheduler knob: the same shards, fewer at once. Deriving the
  // shard list from the cap (or the cap from the list) would silently change
  // what "all shards" means.
  const wide = resolveCiConfig({ shards: '4', maxParallel: '4' })
  const narrow = resolveCiConfig({ shards: '4', maxParallel: '1' })
  assert.deepEqual(narrow.shards, wide.shards)
  assert.equal(narrow.shardTotal, wide.shardTotal)
  assert.notEqual(narrow.maxParallel, wide.maxParallel)
})

test('a NONEMPTY INVALID value FAILS instead of defaulting', () => {
  // A typo that quietly becomes the default is a run that reports a shape
  // nobody asked for. Each of these must be an explicit error.
  for (const [name, value] of [
    ['CI_PRODUCT_SHARDS', '0'],
    ['CI_PRODUCT_SHARDS', '5'],
    ['CI_PRODUCT_SHARDS', 'two'],
    ['CI_PRODUCT_SHARDS', '-1'],
    ['CI_PRODUCT_MAX_PARALLEL', '0'],
    ['CI_PRODUCT_MAX_PARALLEL', '9'],
    ['CI_PRODUCT_MAX_PARALLEL', '4.5'],
    ['CI_PRODUCT_TEST_CONCURRENCY', '0'],
    ['CI_PRODUCT_TEST_CONCURRENCY', '9'],
    ['CI_PRODUCT_TEST_CONCURRENCY', 'fast'],
  ]) {
    const key = name === 'CI_PRODUCT_SHARDS' ? 'shards' : name === 'CI_PRODUCT_MAX_PARALLEL' ? 'maxParallel' : 'testConcurrency'
    assert.throws(() => resolveCiConfig({ [key]: value }), new RegExp(name, 'u'),
      `${name}=${value} must fail the context, not default`)
  }
})

test('the context refuses an invalid shape BEFORE anything is built', (t) => {
  // The context job is the only place the shape is decided: an invalid value
  // that got past it would reach the matrix as a number nobody chose.
  assert.throws(
    () => resolveDshContext({ eventName: 'push', ref: 'refs/heads/main', ciConfig: { shards: '9' } }),
    /CI_PRODUCT_SHARDS/u,
  )
  const { path } = tempModeConfig('npm', testLifecycle(t))
  const context = resolveDshContext({
    eventName: 'push',
    ref: 'refs/heads/next',
    modeConfigPath: path,
    ciConfig: { shards: '2', maxParallel: '1', testConcurrency: '3' },
  })
  assert.deepEqual(context.ci, { shardTotal: 2, shards: [1, 2], maxParallel: 1, testConcurrency: '3' })
})
