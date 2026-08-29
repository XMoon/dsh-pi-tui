import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  DshDistributionError,
  validateDshSourceConfig,
  validateSourceIdentity,
} from '../scripts/lib/dsh-distribution.mjs'
import { officialCommandEnvironment, validateSourcePackOutput } from '../scripts/dsh-source-pack.mjs'
import { resolveSourceVerifyPaths } from '../scripts/dsh-source-verify.mjs'

const VERSION = '0.1.2-alpha.1'

function git(directory, ...args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function sourceCheckout() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-identity-test-'))
  mkdirSync(join(directory, 'apps', 'cli'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: VERSION }))
  writeFileSync(join(directory, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }))
  git(directory, 'init', '-q')
  git(directory, 'config', 'user.email', 'test@example.invalid')
  git(directory, 'config', 'user.name', 'Test')
  git(directory, 'add', '.')
  git(directory, 'commit', '-qm', 'fixture')
  return directory
}

function config(ref) {
  return validateDshSourceConfig({
    schemaVersion: 1,
    repository: 'deepseek-ai/deepseek-harness',
    ref,
    expectedVersion: VERSION,
  })
}

test('source verification delegates packing to the dedicated pack script', () => {
  const sourceVerify = readFileSync(new URL('../scripts/dsh-source-verify.mjs', import.meta.url), 'utf8')
  assert.match(sourceVerify, /const SOURCE_PACK_SCRIPT = fileURLToPath\(new URL\('\.\/dsh-source-pack\.mjs', import\.meta\.url\)\)/u)
  assert.match(sourceVerify, /const args = \[SOURCE_PACK_SCRIPT, '--dsh-dir'/u)
  assert.doesNotMatch(sourceVerify, /const args = \[SCRIPT_PATH, '--dsh-dir'/u)
})

test('source verification fails once for a missing checkout instead of recursively spawning', () => {
  const script = fileURLToPath(new URL('../scripts/dsh-source-verify.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--dsh-dir', join(tmpdir(), 'missing-dsh-checkout')], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  assert.equal(result.status, 1, result.stderr)
  const output = `${result.stdout}${result.stderr}`
  assert.equal((output.match(/official DSH source pack/gu) ?? []).length, 2)
  assert.match(output, /DSH source checkout is missing/u)
})

test('distribution-only source verification does not require a checkout argument', () => {
  const script = fileURLToPath(new URL('../scripts/dsh-source-verify.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--distribution', join(tmpdir(), 'missing-dsh-distribution')], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  assert.equal(result.status, 1, result.stderr)
  assert.match(`${result.stdout}${result.stderr}`, /DSH distribution manifest is missing/u)
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /--dsh-dir is required/u)
})

test('source verify resolves relative paths before invoking child workspaces', () => {
  const invocation = mkdtempSync(join(tmpdir(), 'dsh-source-verify-cwd-test-'))
  try {
    const paths = resolveSourceVerifyPaths({
      config: 'config/dsh-source.json',
      'dsh-dir': '../deepseek-harness',
      distribution: 'artifacts/source-pack',
      out: 'artifacts/next-pack',
    }, invocation)
    assert.equal(paths.config, resolve(invocation, 'config/dsh-source.json'))
    assert.equal(paths['dsh-dir'], resolve(invocation, '../deepseek-harness'))
    assert.equal(paths.distribution, resolve(invocation, 'artifacts/source-pack'))
    assert.equal(paths.out, resolve(invocation, 'artifacts/next-pack'))
  } finally {
    rmSync(invocation, { recursive: true, force: true })
  }
})

test('official source commands disable pnpm verification and self-management', () => {
  const env = officialCommandEnvironment({ CI: 'false', DSH_TEST_SENTINEL: 'kept' })
  assert.equal(env.CI, 'false')
  assert.equal(env.DSH_TEST_SENTINEL, 'kept')
  assert.equal(env.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN, 'false')
  assert.equal(env.PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS, 'false')
})

test('source pack refuses destructive output directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-output-test-'))
  const checkout = join(root, 'checkout')
  const arbitrary = join(root, 'arbitrary')
  const prior = join(root, 'prior-pack')
  try {
    mkdirSync(checkout)
    mkdirSync(arbitrary)
    writeFileSync(join(arbitrary, 'sentinel.txt'), 'do not delete')
    assert.throws(() => validateSourcePackOutput(arbitrary, checkout), /refusing to remove/u)
    assert.throws(() => validateSourcePackOutput(fileURLToPath(new URL('../', import.meta.url)), checkout), /TUI checkout/u)
    symlinkSync(checkout, join(root, 'checkout-link'), 'dir')
    assert.throws(() => validateSourcePackOutput(join(root, 'checkout-link', 'out'), checkout), /DSH checkout/u)
    assert.doesNotThrow(() => validateSourcePackOutput(join(root, 'new-pack'), checkout))

    mkdirSync(prior)
    writeFileSync(join(prior, 'dsh-source-distribution.json'), JSON.stringify({ schemaVersion: 1, mode: 'source-pack' }))
    assert.throws(() => validateSourcePackOutput(prior, checkout), /invalid source-pack directory/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('source identity validates exact checkout SHA and both package versions', () => {
  const directory = sourceCheckout()
  try {
    const head = git(directory, 'rev-parse', 'HEAD')
    const result = validateSourceIdentity(directory, config(head), { ci: true })
    assert.equal(result.head, head)
    assert.equal(result.dirty, false)
    assert.equal(result.reproducible, true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('source identity rejects a branch/short/mismatched ref and version mismatch', () => {
  const directory = sourceCheckout()
  try {
    const head = git(directory, 'rev-parse', 'HEAD')
    assert.throws(() => config('master'), /full 40-character/u)
    assert.throws(() => validateSourceIdentity(directory, config('b'.repeat(40)), { ci: true }), /SHA mismatch/u)
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.1.3' }))
    assert.throws(() => validateSourceIdentity(directory, config(head), { ci: true }), /root version mismatch/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('dirty source is a warning locally but a CI failure', () => {
  const directory = sourceCheckout()
  try {
    const head = git(directory, 'rev-parse', 'HEAD')
    writeFileSync(join(directory, 'local-build.log'), 'dirty')
    assert.throws(() => validateSourceIdentity(directory, config(head), { ci: true }), error => error instanceof DshDistributionError && /dirty/u.test(error.message))
    const local = validateSourceIdentity(directory, config(head), { ci: false })
    assert.equal(local.dirty, true)
    assert.equal(local.reproducible, false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
