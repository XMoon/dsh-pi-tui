import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import { testLifecycle } from './support/temp-lifecycle.ts'
import {
  DshDistributionError,
  requiredDshPackages,
  validateDshSourceConfig,
  validateSourceIdentity,
} from '../scripts/lib/dsh-distribution.mjs'
import {
  officialCommandEnvironment,
  sourcePackPlatformSupported,
  validateSourcePackOutput,
} from '../scripts/dsh-source-pack.mjs'
import {
  currentValidatedDshVersion,
  sourceConfigForArgs,
} from '../scripts/official-presets-smoke.mjs'
import { installEnvironment } from '../scripts/prepare-dsh-test-environment.mjs'
import {
  candidateTarball as sourceVerifyCandidateTarball,
  removeTemporaryWorkspace,
  resolveSourceVerifyPaths,
  temporaryWorkspaceOwner,
} from '../scripts/dsh-source-verify.mjs'

const VERSION = '0.1.2-alpha.1'

// Git repository-local environment variables. When this test file runs
// inside a git-invoked context (a pre-push hook) or a CI job that exports
// them, they leak into every spawned `git` command and redirect it to the
// OUTER repository instead of the fixture. The fixture must be hermetic:
// strip them process-wide so `git -C <fixture>` always operates on the
// fixture alone.
const GIT_REPO_LOCAL_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_PREFIX',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_COMMON_DIR',
]
for (const name of GIT_REPO_LOCAL_ENV) delete process.env[name]

function git(directory, ...args) {
  const env = { ...process.env }
  for (const name of GIT_REPO_LOCAL_ENV) delete env[name]
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', env })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function sourceCheckout(life) {
  const directory = life.tempDir('dsh-identity-test-')
  mkdirSync(join(directory, 'apps', 'cli'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: VERSION }))
  writeFileSync(join(directory, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }))
  git(directory, 'init', '-q')
  git(directory, 'config', 'user.email', 'test@example.invalid')
  git(directory, 'config', 'user.name', 'Test')
  git(directory, 'add', '.')
  git(directory, 'commit', '-qm', 'fixture')
  git(directory, 'remote', 'add', 'origin', 'https://github.com/deepseek-ai/deepseek-harness.git')
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

const SOURCE_PACK_SCRIPT = fileURLToPath(new URL('../scripts/dsh-source-pack.mjs', import.meta.url))
const TUI_PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const REQUIRED_PACKAGES = requiredDshPackages(TUI_PACKAGE)

function fakePnpmScript() {
  return `#!/usr/bin/env node
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'

const args = process.argv.slice(2)
const command = args[0]
const trace = process.env.DSH_FAKE_TRACE
if (trace !== undefined) appendFileSync(trace, JSON.stringify({ command, args }) + '\\n')
if (command !== 'release:pack') process.exit(0)
const output = args[args.indexOf('--out') + 1]
if (output === undefined) process.exit(2)
mkdirSync(output, { recursive: true })
if (process.env.DSH_FAKE_REPLACE_STAGING === '1') {
  const stagingRoot = join(output, '..')
  renameSync(stagingRoot, stagingRoot + '.moved')
  mkdirSync(stagingRoot)
  writeFileSync(join(stagingRoot, 'sentinel.txt'), 'replacement staging must survive')
  process.exit(1)
}
if (process.env.DSH_FAKE_REPLACE_OUTPUT_PARENT === '1') {
  const outputParent = join(output, '..', '..')
  const stagingRoot = join(output, '..')
  const movedParent = outputParent + '.moved'
  renameSync(outputParent, movedParent)
  mkdirSync(outputParent)
  cpSync(join(movedParent, basename(stagingRoot)), stagingRoot, { recursive: true })
}
if (process.env.DSH_FAKE_INVALID === '1') {
  writeFileSync(join(output, 'unexpected.log'), 'invalid pack')
  process.exit(0)
}
for (const name of JSON.parse(process.env.DSH_FAKE_PACKAGES)) {
  // Stage BESIDE the final output (like the real dsh-source-pack.mjs), so
  // even a crashed child only ever leaves files inside the test-owned
  // fixture root — never scattered dsh-* directories in the system /tmp.
  const temporary = mkdtempSync(join(dirname(output), '.dsh-source-pack-fixture-'))
  const packageDirectory = join(temporary, 'package')
  mkdirSync(packageDirectory)
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name, version: process.env.DSH_FAKE_VERSION }))
  const fileName = name.replace(/^@/u, '').replaceAll('/', '-') + '.tgz'
  const packed = spawnSync('tar', ['-czf', join(output, fileName), '-C', temporary, 'package'], { encoding: 'utf8' })
  rmSync(temporary, { recursive: true, force: true })
  if (packed.status !== 0) process.exit(packed.status ?? 1)
}
writeFileSync(join(output, 'publish-order.txt'), 'fixture\\n')
if (process.env.DSH_FAKE_CREATE_FINAL !== undefined) {
  mkdirSync(process.env.DSH_FAKE_CREATE_FINAL)
  writeFileSync(join(process.env.DSH_FAKE_CREATE_FINAL, 'sentinel.txt'), 'raced output must survive')
}
`
}

function runSourcePackFixture(life, { invalid = false, outputAppears = false, replaceStaging = false, replaceOutputParent = false } = {}) {
  const source = sourceCheckout(life)
  const root = life.tempDir('dsh-source-pack-main-test-')
  const configPath = join(root, 'source.json')
  const outputParent = join(root, 'final')
  const output = join(outputParent, 'pack')
  const fakePnpm = join(root, 'fake-pnpm.mjs')
  const trace = join(root, 'trace.jsonl')
  mkdirSync(outputParent)
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    repository: 'deepseek-ai/deepseek-harness',
    ref: git(source, 'rev-parse', 'HEAD'),
    expectedVersion: VERSION,
  }))
  writeFileSync(fakePnpm, fakePnpmScript())
  chmodSync(fakePnpm, 0o755)
  const result = spawnSync(process.execPath, [SOURCE_PACK_SCRIPT, '--dsh-dir', source, '--config', configPath, '--out', output], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      CI: 'false',
      PNPM_EXECUTABLE: fakePnpm,
      DSH_FAKE_PACKAGES: JSON.stringify(REQUIRED_PACKAGES),
      DSH_FAKE_TRACE: trace,
      DSH_FAKE_VERSION: VERSION,
      ...(invalid ? { DSH_FAKE_INVALID: '1' } : {}),
      ...(outputAppears ? { DSH_FAKE_CREATE_FINAL: output } : {}),
      ...(replaceStaging ? { DSH_FAKE_REPLACE_STAGING: '1' } : {}),
      ...(replaceOutputParent ? { DSH_FAKE_REPLACE_OUTPUT_PARENT: '1' } : {}),
    },
  })
  return { result, root, source, output, outputParent, trace }
}

test('source pack main validates in same-filesystem staging before atomic publish', (t) => {
  const life = testLifecycle(t)
  const fixture = runSourcePackFixture(life)
  assert.equal(fixture.result.status, 0, fixture.result.stderr)
  assert.equal(existsSync(fixture.output), true)
  const manifest = JSON.parse(readFileSync(join(fixture.output, 'dsh-source-distribution.json'), 'utf8'))
  assert.equal(Object.keys(manifest.packages).length, REQUIRED_PACKAGES.length)
  assert.equal(manifest.mode, 'source-pack')
  const release = readFileSync(fixture.trace, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line))
    .find(entry => entry.command === 'release:pack')
  assert.ok(release)
  assert.equal(dirname(dirname(release.args[release.args.indexOf('--out') + 1])), fixture.outputParent)
  assert.equal(readdirSync(fixture.outputParent).some(name => name.startsWith('.dsh-source-pack-')), false)

  const sourcePack = readFileSync(SOURCE_PACK_SCRIPT, 'utf8')
  assert.match(sourcePack, /const staging = sourcePackStaging\(dirname\(output\)\)/u)
  assert.match(sourcePack, /renameSync\(stageOutput, output\)/u)
  assert.doesNotMatch(sourcePack, /claimSourcePack|copyOwnedFile|outputOwner|openDirectoryHandle|birthtime/u)
})

test('source pack failure leaves final output absent and only cleans staging', (t) => {
  const life = testLifecycle(t)
  const fixture = runSourcePackFixture(life, { invalid: true })
  assert.notEqual(fixture.result.status, 0)
  assert.match(fixture.result.stderr, /unknown entry/u)
  assert.equal(existsSync(fixture.output), false)
  assert.equal(readdirSync(fixture.outputParent).some(name => name.startsWith('.dsh-source-pack-')), false)
})

test('source pack cleanup leaves a replaced staging directory intact', (t) => {
  const life = testLifecycle(t)
  const fixture = runSourcePackFixture(life, { replaceStaging: true })
  assert.notEqual(fixture.result.status, 0)
  const release = readFileSync(fixture.trace, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line))
    .find(entry => entry.command === 'release:pack')
  assert.ok(release)
  const stageOutput = release.args[release.args.indexOf('--out') + 1]
  assert.equal(readFileSync(join(dirname(stageOutput), 'sentinel.txt'), 'utf8'), 'replacement staging must survive')
  assert.equal(existsSync(fixture.output), false)
})

test('source pack refuses an output parent replacement before publication', (t) => {
  const life = testLifecycle(t)
  const fixture = runSourcePackFixture(life, { replaceOutputParent: true })
  assert.notEqual(fixture.result.status, 0)
  assert.match(fixture.result.stderr, /output parent changed before atomic publish/u)
  const replacementParent = lstatSync(fixture.outputParent)
  assert.equal(replacementParent.isDirectory(), true)
  assert.equal(replacementParent.isSymbolicLink(), false)
  assert.equal(existsSync(fixture.output), false)
})

test('source pack refuses a final path that appears before publication', (t) => {
  const life = testLifecycle(t)
  const fixture = runSourcePackFixture(life, { outputAppears: true })
  assert.notEqual(fixture.result.status, 0)
  assert.match(fixture.result.stderr, /appeared before atomic publish/u)
  assert.equal(readFileSync(join(fixture.output, 'sentinel.txt'), 'utf8'), 'raced output must survive')
  assert.equal(readdirSync(fixture.outputParent).some(name => name.startsWith('.dsh-source-pack-')), false)
})

test('source verification delegates packing to the dedicated pack script', () => {
  const sourceVerify = readFileSync(new URL('../scripts/dsh-source-verify.mjs', import.meta.url), 'utf8')
  assert.match(sourceVerify, /const SOURCE_PACK_SCRIPT = fileURLToPath\(new URL\('\.\/dsh-source-pack\.mjs', import\.meta\.url\)\)/u)
  assert.match(sourceVerify, /const args = \[SOURCE_PACK_SCRIPT, '--dsh-dir'/u)
  assert.match(sourceVerify, /'--ref', effective\.ref/u)
  assert.match(sourceVerify, /'--expected-version', effective\.expectedVersion/u)
  assert.match(sourceVerify, /const sourceFreshSmokeEnv = \{ \.\.\.sourcePnpmEnv, TARBALL_SMOKE_SKIP_INSTALL: '0' \}/u)
  const freshSmoke = sourceVerify.indexOf("join(workspace, 'scripts', 'tarball-smoke.mjs')")
  const officialPresets = sourceVerify.indexOf("'official DSH preset matrix'")
  assert.ok(freshSmoke >= 0 && freshSmoke < officialPresets, 'fresh source smoke must precede official preset checks')
  const freshInvocation = sourceVerify.slice(freshSmoke, officialPresets)
  assert.match(freshInvocation, /candidate/u)
  assert.match(freshInvocation, /'--dsh-distribution', distributionDir/u)
  assert.match(sourceVerify, /official DSH preset matrix/u)
  assert.match(sourceVerify, /distributionPaths: \[distributionDir\],\n      scanArchive: false/u)
  const packCompletion = sourceVerify.indexOf('await runSourcePack(values, effective)')
  const ownerCapture = sourceVerify.indexOf('generatedOwner = generatedDistributionOwner(distributionDir)')
  const manifestLoad = sourceVerify.indexOf('const distribution = loadDshDistributionManifest(distributionDir')
  assert.ok(packCompletion >= 0 && packCompletion < ownerCapture && ownerCapture < manifestLoad, 'generated ownership must be captured before manifest loading')
  assert.doesNotMatch(sourceVerify, /const args = \[SCRIPT_PATH, '--dsh-dir'/u)
})

test('official preset npm target uses the current validated DSH version', () => {
  assert.equal(currentValidatedDshVersion(), '0.1.3-alpha.1')
})

test('official preset source args retain effective source overrides', () => {
  const ref = 'c'.repeat(40)
  const config = sourceConfigForArgs([
    '/tmp/candidate.tgz',
    '--distribution', '/tmp/source-pack',
    '--ref', ref,
    '--expected-version', VERSION,
  ])
  assert.equal(config.ref, ref)
  assert.equal(config.expectedVersion, VERSION)
  assert.throws(
    () => sourceConfigForArgs(['/tmp/candidate.tgz', '--ref', ref]),
    /require --distribution/u,
  )
})

test('source dependency preparation disables pnpm verification and self-management before install', () => {
  const environment = installEnvironment('source', {
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'true',
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'true',
    DSH_TEST_SENTINEL: 'preserved',
  })
  assert.equal(environment.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN, 'false')
  assert.equal(environment.PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS, 'false')
  assert.equal(environment.DSH_TEST_SENTINEL, 'preserved')
})

test('source verification rejects a symlinked candidate tarball', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('dsh-source-candidate-test-')
  const target = join(directory, 'external.tgz')
  const candidate = join(directory, 'xmoon76-dsh-pi-tui-0.4.0.tgz')
  writeFileSync(target, 'not a tarball')
  symlinkSync(target, candidate)
  assert.throws(() => sourceVerifyCandidateTarball(directory), /expected one TUI candidate/u)
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

test('source verification removes a generated pack after official packing fails', (t) => {
  const life = testLifecycle(t)
  const checkout = sourceCheckout(life)
  const container = life.tempDir('dsh-source-pack-failure-test-')
  const output = join(container, 'pack')
  const script = fileURLToPath(new URL('../scripts/dsh-source-verify.mjs', import.meta.url))
  const configPath = fileURLToPath(new URL('../test/compat/dsh-source.json', import.meta.url))
  const head = git(checkout, 'rev-parse', 'HEAD')
  const result = spawnSync(process.execPath, [
    script,
    '--dsh-dir', checkout,
    '--ref', head,
    '--expected-version', VERSION,
    '--config', configPath,
    '--out', output,
  ], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 1, result.stderr)
  assert.match(`${result.stdout}${result.stderr}`, /official DSH source pack/u)
  assert.equal(existsSync(output), false)
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

test('source verify resolves relative paths before invoking child workspaces', (t) => {
  const life = testLifecycle(t)
  const invocation = life.tempDir('dsh-source-verify-cwd-test-')
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
})

test('official source commands disable pnpm verification and self-management', () => {
  const env = officialCommandEnvironment({ CI: 'false', DSH_TEST_SENTINEL: 'kept' })
  assert.equal(env.CI, 'false')
  assert.equal(env.DSH_TEST_SENTINEL, 'kept')
  assert.equal(env.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN, 'false')
  assert.equal(env.PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS, 'false')
  assert.equal(env.pnpm_config_manage_package_manager_versions, 'false')
})

test('source pack refuses destructive output directories', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-output-test-')
  const checkout = join(root, 'checkout')
  const arbitrary = join(root, 'arbitrary')
  const prior = join(root, 'prior-pack')
  mkdirSync(checkout)
  mkdirSync(arbitrary)
  writeFileSync(join(arbitrary, 'sentinel.txt'), 'do not delete')
  assert.throws(() => validateSourcePackOutput(arbitrary, checkout), /already exists/u)
  assert.equal(readFileSync(join(arbitrary, 'sentinel.txt'), 'utf8'), 'do not delete')
  const empty = join(root, 'empty')
  mkdirSync(empty)
  assert.throws(() => validateSourcePackOutput(empty, checkout), /already exists/u)
  assert.throws(() => validateSourcePackOutput(join(fileURLToPath(new URL('../', import.meta.url)), 'dsh-source-pack-test-output'), checkout), /TUI checkout/u)
  symlinkSync(checkout, join(root, 'checkout-link'), 'dir')
  assert.throws(() => validateSourcePackOutput(join(root, 'checkout-link', 'out'), checkout), /DSH checkout/u)
  assert.doesNotThrow(() => validateSourcePackOutput(join(root, 'new-pack'), checkout))

  mkdirSync(prior)
  writeFileSync(join(prior, 'dsh-source-distribution.json'), JSON.stringify({ schemaVersion: 1, mode: 'source-pack' }))
  assert.throws(() => validateSourcePackOutput(prior, checkout), /already exists/u)
})

test('source verification workspace cleanup preserves a replaced root', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-source-workspace-owner-test-')
  const owner = temporaryWorkspaceOwner(root)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root)
  writeFileSync(join(root, 'sentinel.txt'), 'replacement must survive')
  assert.equal(removeTemporaryWorkspace(owner), false)
  assert.equal(readFileSync(join(root, 'sentinel.txt'), 'utf8'), 'replacement must survive')
})

test('source verification cleanup refuses a parent replacement before quarantine rename', (t) => {
  const life = testLifecycle(t)
  const container = life.tempDir('dsh-source-workspace-parent-race-test-')
  const parent = join(container, 'parent')
  const movedParent = join(container, 'moved-parent')
  const root = join(parent, 'workspace')
  mkdirSync(root, { recursive: true })
  const owner = temporaryWorkspaceOwner(root)
  assert.equal(removeTemporaryWorkspace(owner, {
    afterParentValidation() {
      renameSync(parent, movedParent)
      mkdirSync(parent)
    },
  }), false)
  assert.equal(existsSync(join(movedParent, 'workspace')), true)
  assert.equal(existsSync(join(parent, 'workspace')), false)
})

test('source verification cleanup leaves a post-validation quarantine replacement intact', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-source-workspace-quarantine-test-')
  const owner = temporaryWorkspaceOwner(root)
  let replacement
  assert.equal(removeTemporaryWorkspace(owner, {
    afterQuarantineValidation(quarantine) {
      replacement = quarantine
      rmSync(quarantine, { recursive: true, force: true })
      mkdirSync(quarantine)
      writeFileSync(join(quarantine, 'sentinel.txt'), 'replacement must survive')
    },
  }), false)
  assert.ok(replacement)
  assert.equal(readFileSync(join(replacement, 'sentinel.txt'), 'utf8'), 'replacement must survive')
})

test('source pack declares its Windows publication boundary', () => {
  assert.equal(sourcePackPlatformSupported('win32'), false)
  assert.equal(sourcePackPlatformSupported('linux'), true)
  assert.equal(sourcePackPlatformSupported('darwin'), true)
})

test('source identity validates exact checkout SHA and both package versions', (t) => {
  const life = testLifecycle(t)
  const directory = sourceCheckout(life)
  const head = git(directory, 'rev-parse', 'HEAD')
  const result = validateSourceIdentity(directory, config(head), { ci: true })
  assert.equal(result.head, head)
  assert.equal(result.dirty, false)
  assert.equal(result.reproducible, true)
})

test('source identity rejects a branch/short/mismatched ref and version mismatch', (t) => {
  const life = testLifecycle(t)
  const directory = sourceCheckout(life)
  const head = git(directory, 'rev-parse', 'HEAD')
  assert.throws(() => config('master'), /full 40-character/u)
  assert.throws(() => validateSourceIdentity(directory, config('b'.repeat(40)), { ci: true }), /SHA mismatch/u)
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.1.3' }))
  assert.throws(() => validateSourceIdentity(directory, config(head), { ci: true }), /root version mismatch/u)
})

test('dirty source is a warning locally but a CI failure', (t) => {
  const life = testLifecycle(t)
  const directory = sourceCheckout(life)
  const head = git(directory, 'rev-parse', 'HEAD')
  writeFileSync(join(directory, 'local-build.log'), 'dirty')
  assert.throws(() => validateSourceIdentity(directory, config(head), { ci: true }), error => error instanceof DshDistributionError && /dirty/u.test(error.message))
  const previousCi = process.env.CI
  const previousActions = process.env.GITHUB_ACTIONS
  delete process.env.CI
  delete process.env.GITHUB_ACTIONS
  let local
  try {
    local = validateSourceIdentity(directory, config(head), { ci: false })
  } finally {
    if (previousCi === undefined) delete process.env.CI
    else process.env.CI = previousCi
    if (previousActions === undefined) delete process.env.GITHUB_ACTIONS
    else process.env.GITHUB_ACTIONS = previousActions
  }
  assert.equal(local.dirty, true)
  assert.equal(local.reproducible, false)
})
