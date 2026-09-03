import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { testLifecycle } from './support/temp-lifecycle.ts'
import {
  DSH_REPOSITORY,
  DEV_STATE_FILE,
  cacheRoot,
  hashFile,
  loadSourceConfig,
  requiredDshPackages,
  resolveDshDevContext,
  sourceEnvironment,
} from '../scripts/dsh-dev-context.mjs'
import { diagnoseDevelopmentEnvironment, inspectNpmResolution, _test as doctorTest } from '../scripts/dev-doctor.mjs'
import { bootstrapDevelopmentEnvironment, _test as bootstrapTest } from '../scripts/dev-bootstrap.mjs'
import { _test as shellTest } from '../scripts/dev-shell.mjs'
import { installEnvironment } from '../scripts/prepare-dsh-test-environment.mjs'
import { assertNoSourceLeak, assertSourcePackageResolution, validateSourceDistribution, validateSourceIdentity } from '../scripts/lib/dsh-distribution.mjs'
import {
  assertSourceIdentityUnchanged,
  officialCommandEnvironment,
  validateSourcePackOutput,
  _test as sourcePackTest,
} from '../scripts/dsh-source-pack.mjs'

const SHA = 'a'.repeat(40)
const VERSION = '0.1.2-alpha.1'

// Git repository-local environment variables. When this test file runs
// inside a git-invoked context (a pre-push hook) or a CI job that exports
// them, they leak into EVERY spawned `git` command — including the ones
// scripts/ spawn internally and the worker subprocesses — and redirect
// them to the OUTER repository instead of the fixture. The fixture must
// be hermetic: strip them process-wide so `git -C <fixture>` always
// operates on the fixture alone.
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

function packageJson() {
  return {
    name: 'dev-environment-fixture',
    private: true,
    packageManager: 'pnpm@11.7.0',
    devDependencies: {
      '@deepseek-ai/dsh-agent': `^${VERSION}`,
      '@deepseek-ai/dsh-tools': `^${VERSION}`,
      chalk: '^5.0.0',
    },
  }
}

function fixture(life, { source = false, mode } = {}) {
  const root = life.tempDir('dsh-dev-environment-test-')
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(packageJson(), null, 2)}\n`)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  if (source) {
    writeFileSync(join(root, 'test-compat-dsh-source.json'), `${JSON.stringify({
      schemaVersion: 1,
      repository: DSH_REPOSITORY,
      ref: SHA,
      expectedVersion: VERSION,
    })}\n`)
  }
  if (mode !== undefined) {
    // The resolver reads the mode policy at its tracked default path
    // (test/compat/dsh-mode.json), unlike the source config which the
    // tests pass explicitly.
    mkdirSync(join(root, 'test', 'compat'), { recursive: true })
    writeFileSync(join(root, 'test', 'compat', 'dsh-mode.json'), `${JSON.stringify({
      schemaVersion: 1,
      mode,
    })}\n`)
  }
  return root
}

function git(cwd, args) {
  const env = { ...process.env }
  for (const name of GIT_REPO_LOCAL_ENV) delete env[name]
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env })
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function fakeNpmPackage(root, name, version) {
  const packageDirectory = join(root, 'node_modules', '.pnpm', `${name.replaceAll('/', '+')}@${version}`, 'node_modules', ...name.split('/'))
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name, version }))
  const link = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(packageDirectory, link, 'dir')
}

test('development context defaults to npm without a source policy', (t) => {
  const life = testLifecycle(t)
  const root = fixture(life)
  const context = resolveDshDevContext({ root, environment: { XDG_CACHE_HOME: join(root, 'cache') } })
  assert.equal(context.mode, 'npm')
  assert.equal(context.source, undefined)
  assert.equal(context.sourcePack, undefined)
  assert.equal(context.packageManager.declared, 'pnpm@11.7.0')
  assert.deepEqual(context.requiredDshPackages, [
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-tools',
  ])
  assert.equal(cacheRoot({ XDG_CACHE_HOME: join(root, 'cache') }), join(root, 'cache', 'dsh-pi-tui'))
})

test('root dependency verification warns while source environments override it', (t) => {
  const life = testLifecycle(t)
  const workspace = readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8')
  assert.match(workspace, /verifyDepsBeforeRun:\s*warn/u)
  const environment = sourceEnvironment({})
  assert.equal(environment.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN, 'false')
  assert.equal(environment.pnpm_config_verify_deps_before_run, 'false')
  const official = officialCommandEnvironment({ pnpm_config_verify_deps_before_run: 'warn' })
  assert.equal(official.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN, 'false')
  assert.equal(official.pnpm_config_verify_deps_before_run, 'false')

  const root = fixture(life)
  const context = resolveDshDevContext({ root, mode: 'npm', environment: {} })
  bootstrapTest.writeDevelopmentEnvironment(context)
  const generated = readFileSync(context.envPath, 'utf8')
  assert.match(generated, /export DSH_DEV_ROOT=/u)
  assert.match(generated, /unset PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN/u)
  assert.match(generated, /unset pnpm_config_verify_deps_before_run/u)
  assert.doesNotMatch(generated, /export PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN/u)

  const inheritedSource = {
    DSH_DEV_MODE: 'source',
    DSH_MODE: 'source',
    DSH_SOURCE_CONFIG: '/tmp/source.json',
    DSH_SOURCE_DISTRIBUTION: '/tmp/source-pack',
    DSH_DEV_EPHEMERAL: '1',
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
    pnpm_config_verify_deps_before_run: 'false',
    TARBALL_SMOKE_SKIP_INSTALL: '1',
  }
  const sourceInstall = installEnvironment('source', { pnpm_config_verify_deps_before_run: 'warn' })
  assert.equal(sourceInstall.DSH_DEV_MODE, 'source')
  assert.equal(sourceInstall.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN, 'false')
  assert.equal(sourceInstall.pnpm_config_verify_deps_before_run, 'false')

  const npmInstall = installEnvironment('npm', inheritedSource)
  assert.equal(npmInstall.DSH_DEV_MODE, 'npm')
  for (const name of ['DSH_MODE', 'DSH_SOURCE_CONFIG', 'DSH_SOURCE_DISTRIBUTION', 'DSH_DEV_EPHEMERAL',
    'PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN', 'pnpm_config_verify_deps_before_run', 'TARBALL_SMOKE_SKIP_INSTALL']) {
    assert.equal(npmInstall[name], undefined, name)
  }

  const npmCommand = bootstrapTest.commandEnvironment('npm', { baseEnvironment: inheritedSource })
  assert.equal(npmCommand.DSH_DEV_MODE, 'npm')
  for (const name of ['DSH_MODE', 'DSH_SOURCE_CONFIG', 'DSH_SOURCE_DISTRIBUTION', 'DSH_DEV_EPHEMERAL',
    'PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN', 'pnpm_config_verify_deps_before_run', 'TARBALL_SMOKE_SKIP_INSTALL']) {
    assert.equal(npmCommand[name], undefined, name)
  }

  const npmShell = shellTest.npmEnvironment(inheritedSource, root)
  assert.equal(npmShell.DSH_DEV_ROOT, root)
  assert.equal(npmShell.DSH_DEV_MODE, 'npm')
  for (const name of ['DSH_MODE', 'DSH_SOURCE_CONFIG', 'DSH_SOURCE_DISTRIBUTION', 'DSH_DEV_EPHEMERAL',
    'PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN', 'pnpm_config_verify_deps_before_run', 'TARBALL_SMOKE_SKIP_INSTALL']) {
    assert.equal(npmShell[name], undefined, name)
  }
})

test('source mode is selected by an exact source config and can be explicitly overridden', (t) => {
  const life = testLifecycle(t)
  const root = fixture(life, { source: true })
  const config = join(root, 'test-compat-dsh-source.json')
  const source = resolveDshDevContext({ root, config, environment: { XDG_CACHE_HOME: join(root, 'cache') } })
  assert.equal(source.mode, 'source')
  assert.equal(source.source.repository, DSH_REPOSITORY)
  assert.equal(source.source.ref, SHA)
  assert.equal(source.source.expectedVersion, VERSION)
  assert.equal(source.sourcePack, join(root, 'cache', 'dsh-pi-tui', 'source-packs', SHA))

  const npm = resolveDshDevContext({ root, mode: 'npm', config: join(root, 'missing.json'), environment: {} })
  assert.equal(npm.mode, 'npm')
  assert.equal(npm.source, undefined)

  const manual = resolveDshDevContext({
    root,
    environment: { DSH_DEV_MODE: 'source', DSH_SOURCE_CONFIG: config },
  })
  assert.equal(manual.mode, 'source')
  assert.equal(manual.sourceConfigPath, config)
})

test('the tracked mode policy beats a generated DSH_DEV_MODE (branch flip self-heals)', (t) => {
  const life = testLifecycle(t)
  // A worktree whose bootstrap previously materialized SOURCE state
  // (DSH_DEV_MODE=source in .dsh-dev-env) after the branch flipped its
  // tracked policy to npm: the generated state must NOT override the
  // policy, or doctor/bootstrap would keep re-materializing the stale
  // source mode forever.
  const root = fixture(life, { source: true, mode: 'npm' })
  const config = join(root, 'test-compat-dsh-source.json')
  const generated = {
    DSH_DEV_ROOT: root,
    DSH_DEV_MODE: 'source',
    DSH_SOURCE_CONFIG: config,
  }
  const context = resolveDshDevContext({ root, environment: generated })
  assert.equal(context.mode, 'npm', 'the tracked npm policy must win over the generated source state')
  assert.equal(context.source, undefined)

  // The reverse flip: policy says source, generated state says npm.
  const sourceRoot = fixture(life, { source: true, mode: 'source' })
  const sourceConfig = join(sourceRoot, 'test-compat-dsh-source.json')
  const source = resolveDshDevContext({
    root: sourceRoot,
    environment: { DSH_DEV_ROOT: sourceRoot, DSH_DEV_MODE: 'npm', DSH_SOURCE_CONFIG: sourceConfig },
  })
  assert.equal(source.mode, 'source', 'the tracked source policy must win over the generated npm state')
  assert.equal(source.source.ref, SHA)

  // A USER override (DSH_MODE) still beats the tracked policy.
  const overridden = resolveDshDevContext({
    root,
    environment: { ...generated, DSH_MODE: 'source' },
  })
  assert.equal(overridden.mode, 'source', 'DSH_MODE is a user override and stays authoritative')
})

test('DSH_DEV_MODE still works as the legacy fallback without a mode policy', (t) => {
  const life = testLifecycle(t)
  // Older checkouts / main have no dsh-mode.json: the generated
  // DSH_DEV_MODE keeps its historical meaning.
  const root = fixture(life, { source: true })
  const config = join(root, 'test-compat-dsh-source.json')
  const context = resolveDshDevContext({
    root,
    environment: { DSH_DEV_ROOT: root, DSH_DEV_MODE: 'source', DSH_SOURCE_CONFIG: config },
  })
  assert.equal(context.mode, 'source', 'without a mode policy the generated state remains the fallback')
})

test('generated source environment variables cannot cross worktrees', (t) => {
  const life = testLifecycle(t)
  const mainRoot = fixture(life)
  const nextRoot = fixture(life, { source: true })
  const nextConfig = join(nextRoot, 'test-compat-dsh-source.json')
  const next = resolveDshDevContext({
    root: nextRoot,
    config: nextConfig,
    environment: { XDG_CACHE_HOME: join(nextRoot, 'cache') },
  })
  // The inherited ephemeral generation must actually exist: a shell whose
  // generation was reclaimed by another bootstrap self-heals instead of
  // hard-loading the stale path (see the stale-distribution test below).
  mkdirSync(next.sourcePack, { recursive: true })
  const generated = {
    DSH_DEV_ROOT: nextRoot,
    DSH_DEV_MODE: 'source',
    DSH_SOURCE_CONFIG: nextConfig,
    DSH_SOURCE_DISTRIBUTION: next.sourcePack,
    DSH_DEV_EPHEMERAL: '1',
  }

  const main = resolveDshDevContext({
    root: mainRoot,
    environment: { ...generated, XDG_CACHE_HOME: join(mainRoot, 'cache') },
  })
  assert.equal(main.mode, 'npm')
  assert.equal(main.source, undefined)
  assert.equal(main.distribution, undefined)
  assert.equal(main.sourceConfigPath, join(mainRoot, 'test', 'compat', 'dsh-source.json'))

  const owned = resolveDshDevContext({
    root: nextRoot,
    environment: { ...generated, XDG_CACHE_HOME: join(nextRoot, 'cache') },
  })
  assert.equal(owned.mode, 'source')
  assert.equal(owned.sourceConfigPath, nextConfig)
  assert.equal(owned.distribution, next.sourcePack)
})

test('a stale inherited ephemeral distribution self-heals to normal resolution', (t) => {
  const life = testLifecycle(t)
  const root = fixture(life, { source: true })
  const config = join(root, 'test-compat-dsh-source.json')
  const cacheHome = join(root, 'cache')
  const base = {
    XDG_CACHE_HOME: cacheHome,
    DSH_DEV_ROOT: root,
    DSH_DEV_MODE: 'source',
    DSH_SOURCE_CONFIG: config,
    DSH_DEV_EPHEMERAL: '1',
  }
  // A long-lived shell still exports the generation another shell's
  // bootstrap reclaimed: the stale path must be dropped (falling back to
  // the committed state / canonical cache) instead of being hard-loaded.
  const stalePath = join(cacheHome, 'gone-generation', 'pack')
  const stale = resolveDshDevContext({
    root,
    config,
    environment: { ...base, DSH_SOURCE_DISTRIBUTION: stalePath },
  })
  assert.equal(stale.distribution, undefined, 'a reclaimed ephemeral generation must not be hard-loaded')
  assert.equal(stale.sourcePack, join(cacheHome, 'dsh-pi-tui', 'source-packs', SHA))

  // An explicit --distribution argument stays authoritative even when the
  // path does not exist — the operator asked for exactly that path.
  const explicit = resolveDshDevContext({
    root,
    config,
    distribution: stalePath,
    environment: { XDG_CACHE_HOME: cacheHome },
  })
  assert.equal(explicit.distribution, stalePath)

  // An inherited ephemeral generation that still exists stays provided.
  const liveRoot = join(cacheHome, 'live-generation')
  mkdirSync(liveRoot, { recursive: true })
  const live = resolveDshDevContext({
    root,
    config,
    environment: { ...base, DSH_SOURCE_DISTRIBUTION: liveRoot },
  })
  assert.equal(live.distribution, liveRoot)
})

test('generated durable source environments keep the canonical cache durable', (t) => {
  const life = testLifecycle(t)
  const root = fixture(life, { source: true })
  const config = join(root, 'test-compat-dsh-source.json')
  const cacheHome = join(root, 'cache')
  const context = resolveDshDevContext({ root, config, environment: { XDG_CACHE_HOME: cacheHome } })
  bootstrapTest.writeDevelopmentEnvironment(context, context.sourcePack, { ephemeral: false })
  const generated = readFileSync(context.envPath, 'utf8')
  assert.match(generated, /export DSH_DEV_ROOT=/u)
  assert.match(generated, /export DSH_DEV_EPHEMERAL='0'/u)
  assert.match(generated, /export DSH_SOURCE_DISTRIBUTION=/u)

  const loaded = resolveDshDevContext({
    root,
    config,
    environment: {
      XDG_CACHE_HOME: cacheHome,
      DSH_DEV_ROOT: root,
      DSH_DEV_MODE: 'source',
      DSH_SOURCE_CONFIG: config,
      DSH_SOURCE_DISTRIBUTION: context.sourcePack,
      DSH_DEV_EPHEMERAL: '0',
    },
  })
  assert.equal(loaded.distribution, undefined)
  assert.equal(loaded.sourcePack, context.sourcePack)

  // An ephemeral-flagged environment keeps its distribution provided — but
  // only while that generation actually exists on disk.
  mkdirSync(context.sourcePack, { recursive: true })
  const explicit = resolveDshDevContext({
    root,
    config,
    environment: {
      XDG_CACHE_HOME: cacheHome,
      DSH_DEV_ROOT: root,
      DSH_DEV_MODE: 'source',
      DSH_SOURCE_CONFIG: config,
      DSH_SOURCE_DISTRIBUTION: context.sourcePack,
      DSH_DEV_EPHEMERAL: '1',
    },
  })
  assert.equal(explicit.distribution, context.sourcePack)

  const shell = shellTest.sourceShellEnvironment(context, { DSH_DEV_EPHEMERAL: '1' })
  assert.equal(shell.DSH_DEV_ROOT, root)
  assert.equal(shell.DSH_DEV_EPHEMERAL, '0')
  assert.equal(shell.DSH_SOURCE_DISTRIBUTION, context.sourcePack)
  const loadedFromShell = resolveDshDevContext({
    root,
    config,
    environment: { ...shell, XDG_CACHE_HOME: cacheHome },
  })
  assert.equal(loadedFromShell.distribution, undefined)

  const state = {
    schemaVersion: 1,
    mode: 'source',
    node: String(process.versions.node.split('.')[0]),
    pnpm: '11.7.0',
    root: loaded.root,
    packageJsonHash: hashFile(loaded.packageJsonPath),
    lockfileHash: hashFile(join(root, 'pnpm-lock.yaml')),
    repository: DSH_REPOSITORY,
    ref: SHA,
    expectedVersion: VERSION,
    distribution: loaded.sourcePack,
    ephemeral: false,
  }
  assert.equal(doctorTest.stateMatches(loadedFromShell, state, loadedFromShell.sourcePack, '11.7.0'), undefined)
})

test('source config validation rejects non-pinned identities', (t) => {
  const life = testLifecycle(t)
  const root = fixture(life)
  const path = join(root, 'invalid.json')
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    repository: 'deepseek-ai/not-harness',
    ref: 'main',
    expectedVersion: VERSION,
  }))
  assert.throws(() => loadSourceConfig(path), /repository/u)
})

test('source identity rejects a checkout from the wrong repository', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-source-identity-test-')
  mkdirSync(join(root, 'apps', 'cli'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: VERSION }))
  writeFileSync(join(root, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }))
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'test@example.invalid'])
  git(root, ['config', 'user.name', 'test'])
  git(root, ['add', '.'])
  git(root, ['commit', '-q', '-m', 'fixture'])
  git(root, ['remote', 'add', 'origin', 'https://github.com/example/not-deepseek-harness.git'])
  const ref = git(root, ['rev-parse', 'HEAD'])
  assert.throws(() => validateSourceIdentity(root, {
    repository: DSH_REPOSITORY,
    ref,
    expectedVersion: VERSION,
  }), /repository remote mismatch/u)
})

test('source identity rejects an incorrect root package name', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-source-root-test-')
  mkdirSync(join(root, 'apps', 'cli'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/not-harness', version: VERSION }))
  writeFileSync(join(root, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }))
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'test@example.invalid'])
  git(root, ['config', 'user.name', 'test'])
  git(root, ['add', '.'])
  git(root, ['commit', '-q', '-m', 'fixture'])
  git(root, ['remote', 'add', 'origin', 'https://github.com/deepseek-ai/deepseek-harness.git'])
  const ref = git(root, ['rev-parse', 'HEAD'])
  assert.throws(() => validateSourceIdentity(root, {
    repository: DSH_REPOSITORY,
    ref,
    expectedVersion: VERSION,
  }), /root package name mismatch/u)
})

test('doctor is read-only and reports an unmaterialized npm worktree', async (t) => {
  const life = testLifecycle(t)
  const root = fixture(life)
  const packageBefore = readFileSync(join(root, 'package.json'), 'utf8')
  const lockBefore = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
  const { context, details } = await diagnoseDevelopmentEnvironment({
    root,
    mode: 'npm',
    environment: { XDG_CACHE_HOME: join(root, 'cache') },
  })
  assert.equal(context.mode, 'npm')
  assert.notEqual(details.status, 'READY')
  assert.match(details.diagnostics.map(item => item.message).join('\n'), /node_modules|state/u)
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), packageBefore)
  assert.equal(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), lockBefore)
  assert.equal(details.diagnostics.some(item => item.message.includes(DEV_STATE_FILE)), true)
})

test('doctor rejects a partial local state instead of treating it as ready', async (t) => {
  const life = testLifecycle(t)
  const root = fixture(life)
  const packageRoot = join(root, 'node_modules', '@deepseek-ai')
  mkdirSync(packageRoot, { recursive: true })
  for (const name of ['dsh-agent', 'dsh-tools']) {
    const directory = join(packageRoot, name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: VERSION }))
  }
  writeFileSync(join(root, DEV_STATE_FILE), JSON.stringify({ schemaVersion: 1, mode: 'npm' }))
  const { details } = await diagnoseDevelopmentEnvironment({ root, mode: 'npm' })
  assert.equal(details.status, 'BROKEN')
  assert.match(details.diagnostics.map(item => item.message).join('\n'), /missing required fields/u)
})

test('source environment is a warning independent from materialization status', (t) => {
  const life = testLifecycle(t)
  const root = fixture(life, { source: true })
  const context = resolveDshDevContext({ root, config: join(root, 'test-compat-dsh-source.json'), environment: {} })
  const environment = doctorTest.sourceEnvironmentStatus(context, {})
  assert.equal(environment.ok, false)
  assert.match(environment.message, /not loaded/u)
  assert.equal(doctorTest.bestStatus([]), 'READY')
})

test('source state marked ephemeral is never accepted as durable READY state', (t) => {
  const life = testLifecycle(t)
  const root = fixture(life, { source: true })
  const context = resolveDshDevContext({ root, config: join(root, 'test-compat-dsh-source.json'), environment: {} })
  const state = {
    schemaVersion: 1,
    mode: 'source',
    node: String(process.versions.node.split('.')[0]),
    pnpm: '11.7.0',
    root,
    packageJsonHash: hashFile(join(root, 'package.json')),
    lockfileHash: hashFile(join(root, 'pnpm-lock.yaml')),
    repository: DSH_REPOSITORY,
    ref: SHA,
    expectedVersion: VERSION,
    distribution: context.sourcePack,
    ephemeral: true,
  }
  const result = doctorTest.stateMatches(context, state, context.sourcePack, '11.7.0')
  assert.equal(result.status, 'STALE')
  assert.match(result.message, /ephemeral/u)

  const external = join(root, 'provided-source-pack')
  const forged = { ...state, distribution: external, ephemeral: false }
  const externalResult = doctorTest.stateMatches(context, forged, external, '11.7.0')
  assert.equal(externalResult.status, 'STALE')
  assert.match(externalResult.message, /canonical SHA cache/u)

  const explicitContext = resolveDshDevContext({
    root,
    config: join(root, 'test-compat-dsh-source.json'),
    distribution: context.sourcePack,
    environment: {},
  })
  const explicitResult = doctorTest.stateMatches(explicitContext, { ...state, ephemeral: false }, context.sourcePack, '11.7.0')
  assert.equal(explicitResult.status, 'STALE')
  assert.match(explicitResult.message, /must remain ephemeral/u)
})

test('an explicitly supplied canonical source pack remains provided and ephemeral', async (t) => {
  const life = testLifecycle(t)
  const root = fixture(life, { source: true })
  const sourcePack = join(root, 'cache', 'dsh-pi-tui', 'source-packs', SHA)
  const context = {
    root,
    sourcePack,
    sourceConfigPath: join(root, 'test-compat-dsh-source.json'),
    source: { repository: DSH_REPOSITORY, ref: SHA, expectedVersion: VERSION },
    packageJsonPath: join(root, 'package.json'),
    packageJson: packageJson(),
    cacheRoot: join(root, 'cache'),
  }
  const helper = {
    loadDshDistribution() {
      return { kind: 'source-pack', dirty: false, reproducible: true }
    },
  }
  const selected = await bootstrapTest.sourceDistribution(helper, context, { distribution: sourcePack })
  assert.equal(selected.path, sourcePack)
  assert.equal(selected.provided, true)
  assert.equal(selected.cacheHit, false)
})

test('doctor checks the reachable source package set, not every packed package', () => {
  const calls = []
  const helper = {
    sourceInstallPackages() {
      return ['required']
    },
    assertSourcePackageResolution(_root, _distribution, name) {
      calls.push(name)
    },
  }
  const result = doctorTest.inspectSourceResolution(helper, { root: '/tmp/workspace', packageJson: packageJson() }, {
    packages: new Map([['required', {}], ['unused', {}]]),
  })
  assert.deepEqual(calls, ['required'])
  assert.equal(result.count, 1)
  assert.equal(result.problems.length, 0)
})

test('installed npm DSH versions must satisfy declared ranges', (t) => {
  const life = testLifecycle(t)
  const root = fixture(life)
  // Isolated environment: a CI source-mode job exports DSH_MODE=source, which
  // must never leak into this npm-mode fixture's context resolution.
  const context = resolveDshDevContext({ root, environment: {} })
  for (const name of ['dsh-agent', 'dsh-tools']) fakeNpmPackage(root, `@deepseek-ai/${name}`, '9.9.9')
  const result = inspectNpmResolution(context)
  assert.equal(result.problems.length, 2)
  assert.ok(result.problems.every(item => item.status === 'STALE' && /does not satisfy/u.test(item.message)))
})

test('npm resolution rejects a package symlink outside pnpm virtual store', (t) => {
  const life = testLifecycle(t)
  const root = fixture(life)
  const packageRoot = join(root, 'node_modules', '@deepseek-ai')
  const outside = join(root, 'outside', 'dsh-agent')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-agent', version: VERSION }))
  mkdirSync(packageRoot, { recursive: true })
  symlinkSync(outside, join(packageRoot, 'dsh-agent'), 'dir')
  fakeNpmPackage(root, '@deepseek-ai/dsh-tools', VERSION)
  const result = inspectNpmResolution(resolveDshDevContext({ root, environment: {} }))
  assert.ok(result.problems.some(item => /pnpm virtual-store/u.test(item.message)))
})

test('source resolution rejects a fake path that only spoofs the tarball basename', (t) => {
  const life = testLifecycle(t)
  const root = fixture(life)
  const fakePackage = join(root, 'fake-dsh-agent.tgz', 'node_modules', '@deepseek-ai', 'dsh-agent')
  mkdirSync(fakePackage, { recursive: true })
  writeFileSync(join(fakePackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-agent', version: VERSION }))
  const virtualStore = join(root, 'node_modules', '.pnpm')
  mkdirSync(virtualStore, { recursive: true })
  const installed = join(root, 'node_modules', '@deepseek-ai', 'dsh-agent')
  mkdirSync(dirname(installed), { recursive: true })
  symlinkSync(fakePackage, installed, 'dir')
  const distribution = {
    kind: 'source-pack',
    version: VERSION,
    packages: new Map([['@deepseek-ai/dsh-agent', { fileName: 'dsh-agent.tgz', path: join(root, 'dsh-agent.tgz') }]]),
  }
  assert.throws(() => assertSourcePackageResolution(root, distribution, '@deepseek-ai/dsh-agent'), /outside pnpm's virtual store/u)
})

test('source pack rejects source identity changes after the build', () => {
  const before = { directory: '/source', head: SHA, expectedVersion: VERSION, dirty: false, reproducible: true }
  const after = { ...before, dirty: true, reproducible: false }
  assert.throws(() => assertSourceIdentityUnchanged(before, after), /identity changed/u)
  assert.equal(assertSourceIdentityUnchanged(before, before), before)
})

test('source pack staging is created beside the final output', (t) => {
  const life = testLifecycle(t)
  const parent = life.tempDir('dsh-source-stage-test-')
  const staging = sourcePackTest.sourcePackStaging(parent)
  assert.equal(dirname(staging), parent)
})

test('source pack output keeps known auxiliary files and rejects unknown entries', (t) => {
  const life = testLifecycle(t)
  const parent = life.tempDir('dsh-source-output-test-')
  const allowed = join(parent, 'allowed')
  mkdirSync(allowed)
  writeFileSync(join(allowed, 'publish-order.txt'), 'dsh\n')
  writeFileSync(join(allowed, 'package.tgz'), 'tarball\n')
  sourcePackTest.cleanPackOutput(allowed)
  assert.equal(existsSync(join(allowed, 'publish-order.txt')), false)
  assert.equal(existsSync(join(allowed, 'package.tgz')), true)

  const unknown = join(parent, 'unknown')
  mkdirSync(unknown)
  writeFileSync(join(unknown, 'unexpected.log'), 'unexpected\n')
  assert.throws(() => sourcePackTest.cleanPackOutput(unknown), /unknown entry/u)
})

test('source pack refuses to overwrite an existing final output', (t) => {
  const life = testLifecycle(t)
  const source = fixture(life)
  const parent = life.tempDir('dsh-source-final-test-')
  const output = join(parent, 'pack')
  mkdirSync(output)
  assert.throws(() => validateSourcePackOutput(output, source), /already exists/u)

  const dangling = join(parent, 'dangling-pack')
  symlinkSync(join(parent, 'missing-pack'), dangling, 'dir')
  assert.throws(() => validateSourcePackOutput(dangling, source), /already exists/u)
})

test('source pack cache rejects a dangling symlink as an existing cache path', (t) => {
  const life = testLifecycle(t)
  const root = fixture(life)
  const dangling = join(root, 'cache')
  symlinkSync(join(root, 'missing-cache'), dangling, 'dir')
  assert.throws(() => bootstrapTest.existingCachePath(dangling), /must not be a symlink/u)
})

test('Harness repository and worktree creation reject dangling symlinks', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-harness-path-test-')
  const cacheRoot = join(root, 'cache')
  mkdirSync(cacheRoot)
  const repositoryPath = join(cacheRoot, 'deepseek-harness.git')
  symlinkSync(join(root, 'missing-repository'), repositoryPath, 'dir')
  await assert.rejects(() => bootstrapTest.ensureHarnessRepository({
    root,
    harnessRepository: repositoryPath,
    source: { repository: DSH_REPOSITORY },
  }, {}), /real directory/u)

  const realRepository = join(cacheRoot, 'real.git')
  git(root, ['init', '--bare', realRepository])
  const worktreeRoot = join(cacheRoot, 'worktrees')
  mkdirSync(worktreeRoot)
  const worktreePath = join(worktreeRoot, SHA)
  symlinkSync(join(root, 'missing-worktree'), worktreePath, 'dir')
  await assert.rejects(() => bootstrapTest.ensureHarnessWorktree({
    root,
    harnessRepository: realRepository,
    harnessWorktreeRoot: worktreeRoot,
    harnessCheckout: worktreePath,
    source: { ref: SHA, repository: DSH_REPOSITORY },
  }, {}), /real directory/u)
})

test('dirty provided checkouts forward the explicit allow-dirty source-pack flag', () => {
  assert.deepEqual(bootstrapTest.sourcePackCommandArgs('/root/dsh-source-pack.mjs', '/tmp/harness', '/tmp/source.json', '/tmp/output', true), [
    '/root/dsh-source-pack.mjs',
    '--dsh-dir', '/tmp/harness',
    '--config', '/tmp/source.json',
    '--out', '/tmp/output',
    '--allow-dirty',
  ])
  assert.deepEqual(bootstrapTest.sourcePackCommandArgs('/root/dsh-source-pack.mjs', '/tmp/harness', '/tmp/source.json', '/tmp/output', false).includes('--allow-dirty'), false)
})

test('dirty provided distributions are explicitly allowed only for ephemeral preparation', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-dirty-prepare-test-')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'minimal-source-fixture', private: true, packageManager: 'pnpm@11.7.0' }))
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n- packages/*\n')
  const config = join(root, 'source.json')
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, repository: DSH_REPOSITORY, ref: SHA, expectedVersion: VERSION }))
  const staging = join(root, 'staging', 'package')
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(staging, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }))
  const distribution = join(root, 'distribution')
  mkdirSync(distribution)
  const tarball = join(distribution, 'dsh.tgz')
  const packed = spawnSync('tar', ['-czf', tarball, '-C', join(root, 'staging'), 'package'], { encoding: 'utf8' })
  assert.equal(packed.status, 0, packed.stderr)
  writeFileSync(join(distribution, 'dsh-source-distribution.json'), JSON.stringify({
    schemaVersion: 1,
    mode: 'source-pack',
    repository: DSH_REPOSITORY,
    sourceRef: SHA,
    sourceSha: SHA,
    version: VERSION,
    dirty: true,
    reproducible: false,
    packages: { '@deepseek-ai/dsh': 'dsh.tgz' },
  }))
  const pnpm = join(root, 'fake-pnpm.mjs')
  writeFileSync(pnpm, `#!/usr/bin/env node
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
if (process.argv.includes('install')) {
  const packageDirectory = join(process.cwd(), 'node_modules', '.pnpm', '@deepseek-ai+dsh@file+distribution+dsh.tgz', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '${VERSION}' }))
  const link = join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(packageDirectory, link, 'dir')
  mkdirSync(join(process.cwd(), 'node_modules', '.pnpm'), { recursive: true })
  writeFileSync(join(process.cwd(), 'node_modules', '.pnpm', 'lock.yaml'), "lockfileVersion: '9.0'\\nimporters:\\n  .:\\n    devDependencies:\\n      '@deepseek-ai/dsh':\\n        specifier: file:distribution/dsh.tgz\\n        version: file:distribution/dsh.tgz\\n")
} else if (process.argv.includes('--version')) {
  console.log('11.7.0')
} else {
  process.exitCode = 1
}
`)
  chmodSync(pnpm, 0o755)
  const worker = join(process.cwd(), 'test', 'dev-environment-prepare-worker.mjs')
  const run = allowDirty => new Promise(resolve => {
    const child = spawn(process.execPath, [worker, root, config, distribution, pnpm, String(allowDirty)], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('exit', (status, signal) => resolve({ status, signal, stdout, stderr }))
  })
  const accepted = await run(true)
  assert.equal(accepted.status, 0, accepted.stderr)
  const rejected = await run(false)
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /dirty or non-reproducible/u)
})

test('source distribution requires a positive reproducibility attestation', (t) => {
  const life = testLifecycle(t)
  const root = fixture(life, { source: true })
  const directory = join(root, 'distribution')
  mkdirSync(directory)
  const manifest = {
    schemaVersion: 1,
    mode: 'source-pack',
    repository: DSH_REPOSITORY,
    sourceRef: SHA,
    sourceSha: SHA,
    version: VERSION,
    packages: {},
  }
  assert.throws(() => validateSourceDistribution({ manifest, directory, requiredPackages: [] }), /positively attest/u)
})

test('source distribution rejects source-only dependency specs in package metadata', (t) => {
  const life = testLifecycle(t)
  const root = fixture(life)
  const staging = join(root, 'staging')
  const packageDirectory = join(staging, 'package')
  mkdirSync(packageDirectory, { recursive: true })
  const packageJsonPath = join(packageDirectory, 'package.json')
  writeFileSync(packageJsonPath, JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: VERSION,
    dependencies: { safe: '^1.0.0' },
  }))
  writeFileSync(join(packageDirectory, 'README.md'), `Documentation may mention ${root}/packages/client without being a source leak.\n`)
  const pack = join(root, 'pack')
  mkdirSync(pack)
  const tarball = join(pack, 'unsafe.tgz')
  const result = spawnSync('tar', ['-czf', tarball, '-C', staging, 'package'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotThrow(() => assertNoSourceLeak(tarball, { sourcePaths: [root] }))
  writeFileSync(packageJsonPath, JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: VERSION,
    dependencies: { hidden: 'file:/secret/source' },
  }))
  const unsafe = spawnSync('tar', ['-czf', tarball, '-C', staging, 'package'], { encoding: 'utf8' })
  assert.equal(unsafe.status, 0, unsafe.stderr)
  assert.throws(() => assertNoSourceLeak(tarball), /source leak/u)
  assert.throws(() => validateSourceDistribution({
    manifest: {
      schemaVersion: 1,
      mode: 'source-pack',
      repository: DSH_REPOSITORY,
      sourceRef: SHA,
      sourceSha: SHA,
      version: VERSION,
      dirty: false,
      reproducible: true,
      packages: { '@deepseek-ai/dsh': 'unsafe.tgz' },
    },
    directory: pack,
    requiredPackages: [],
  }), /source leak/u)
})

test('source-pack lock waiters reuse a pack completed by the lock owner', async (t) => {
  const life = testLifecycle(t)
  const root = fixture(life, { source: true })
  const config = join(root, 'test-compat-dsh-source.json')
  const context = resolveDshDevContext({ root, config, environment: { XDG_CACHE_HOME: join(root, 'cache') } })
  const helper = {
    loadDshDistribution({ manifest }) {
      if (!existsSync(manifest)) throw new Error('missing test cache')
      return {
        kind: 'source-pack',
        repository: DSH_REPOSITORY,
        sourceSha: SHA,
        version: VERSION,
        dirty: false,
        reproducible: true,
        packages: new Map([['@deepseek-ai/dsh-agent', { fileName: 'dsh-agent.tgz' }]]),
      }
    },
  }
  const first = await bootstrapTest.acquireSourceLock(helper, context)
  assert.equal(first.acquired, true)
  const secondPromise = bootstrapTest.acquireSourceLock(helper, context)
  setTimeout(() => {
    mkdirSync(context.sourcePack, { recursive: true })
    bootstrapTest.releaseSourceLock(first)
  }, 20).unref()
  const second = await secondPromise
  assert.equal(second.acquired, false)
  assert.equal(second.distribution.sourceSha, SHA)
})

test('different source SHAs have independent locks and worktree paths', async (t) => {
  const life = testLifecycle(t)
  const root = fixture(life)
  const cache = join(root, 'cache')
  const configA = join(root, 'source-a.json')
  const configB = join(root, 'source-b.json')
  writeFileSync(configA, JSON.stringify({ schemaVersion: 1, repository: DSH_REPOSITORY, ref: 'a'.repeat(40), expectedVersion: VERSION }))
  writeFileSync(configB, JSON.stringify({ schemaVersion: 1, repository: DSH_REPOSITORY, ref: 'b'.repeat(40), expectedVersion: VERSION }))
  const contextA = resolveDshDevContext({ root, config: configA, environment: { XDG_CACHE_HOME: cache } })
  const contextB = resolveDshDevContext({ root, config: configB, environment: { XDG_CACHE_HOME: cache } })
  const [lockA, lockB] = await Promise.all([
    bootstrapTest.acquireSourceLock({}, contextA),
    bootstrapTest.acquireSourceLock({}, contextB),
  ])
  try {
    assert.equal(lockA.acquired, true)
    assert.equal(lockB.acquired, true)
    assert.notEqual(lockA.lockPath, lockB.lockPath)
    assert.notEqual(contextA.harnessCheckout, contextB.harnessCheckout)
    assert.equal(contextA.harnessRepository, contextB.harnessRepository)
  } finally {
    bootstrapTest.releaseSourceLock(lockA)
    bootstrapTest.releaseSourceLock(lockB)
  }
})

test('different SHA source locks remain independent across processes', async (t) => {
  const life = testLifecycle(t)
  const root = fixture(life)
  const cache = join(root, 'cache')
  const configA = join(root, 'source-a.json')
  const configB = join(root, 'source-b.json')
  writeFileSync(configA, JSON.stringify({ schemaVersion: 1, repository: DSH_REPOSITORY, ref: 'c'.repeat(40), expectedVersion: VERSION }))
  writeFileSync(configB, JSON.stringify({ schemaVersion: 1, repository: DSH_REPOSITORY, ref: 'd'.repeat(40), expectedVersion: VERSION }))
  const worker = join(process.cwd(), 'test', 'dev-environment-lock-worker.mjs')
  const run = config => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, root, config, cache, '120'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (status, signal) => {
      if (status !== 0) reject(new Error(`lock worker failed: ${status ?? signal}: ${stderr}`))
      else resolve(JSON.parse(stdout.trim()))
    })
  })
  const [resultA, resultB] = await Promise.all([run(configA), run(configB)])
  assert.equal(resultA.acquired, true)
  assert.equal(resultB.acquired, true)
  assert.notEqual(resultA.lockPath, resultB.lockPath)
  assert.notEqual(resultA.harnessCheckout, resultB.harnessCheckout)
  assert.equal(resultA.harnessRepository, resultB.harnessRepository)
})

test('different SHA workers create independent exact Git worktrees', async (t) => {
  const life = testLifecycle(t)
  const root = fixture(life)
  const seed = join(root, 'harness-seed')
  mkdirSync(seed)
  git(seed, ['init', '-q'])
  git(seed, ['config', 'user.email', 'test@example.invalid'])
  git(seed, ['config', 'user.name', 'test'])
  mkdirSync(join(seed, 'apps', 'cli'), { recursive: true })
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: VERSION, private: true }))
  writeFileSync(join(seed, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }))
  git(seed, ['add', '.'])
  git(seed, ['commit', '-q', '-m', 'first'])
  const refA = git(seed, ['rev-parse', 'HEAD'])
  writeFileSync(join(seed, 'marker.txt'), 'second\n')
  git(seed, ['add', 'marker.txt'])
  git(seed, ['commit', '-q', '-m', 'second'])
  const refB = git(seed, ['rev-parse', 'HEAD'])
  const cache = join(root, 'cache')
  const contextRoot = join(cache, 'dsh-pi-tui')
  mkdirSync(contextRoot, { recursive: true })
  const repository = join(contextRoot, 'deepseek-harness.git')
  git(root, ['clone', '-q', '--bare', seed, repository])
  git(repository, ['remote', 'set-url', 'origin', 'https://github.com/deepseek-ai/deepseek-harness'])
  const configA = join(root, 'source-a.json')
  const configB = join(root, 'source-b.json')
  writeFileSync(configA, JSON.stringify({ schemaVersion: 1, repository: DSH_REPOSITORY, ref: refA, expectedVersion: VERSION }))
  writeFileSync(configB, JSON.stringify({ schemaVersion: 1, repository: DSH_REPOSITORY, ref: refB, expectedVersion: VERSION }))
  const worker = join(process.cwd(), 'test', 'dev-environment-worktree-worker.mjs')
  const run = config => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, root, config, cache], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (status, signal) => {
      if (status !== 0) reject(new Error(`worktree worker failed: ${status ?? signal}: ${stderr}`))
      else resolve(JSON.parse(stdout.trim().split(/\r?\n/u).at(-1)))
    })
  })
  const [resultA, resultB] = await Promise.all([run(configA), run(configB)])
  assert.notEqual(resultA.checkout, resultB.checkout)
  assert.equal(resultA.repository, repository)
  assert.equal(git(resultA.checkout, ['rev-parse', 'HEAD']), refA)
  assert.equal(git(resultB.checkout, ['rev-parse', 'HEAD']), refB)
})

test('bootstrap timeout waits through the descendant-kill grace period', async () => {
  const started = Date.now()
  await assert.rejects(
    bootstrapTest.runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 20, label: 'timeout regression' }),
    error => error.code === 'ETIMEDOUT',
  )
  assert.ok(Date.now() - started >= 900)
})

test('shared source-pack cache rejects a dirty or non-reproducible manifest', (t) => {
  const life = testLifecycle(t)
  const root = fixture(life, { source: true })
  const config = join(root, 'test-compat-dsh-source.json')
  const context = resolveDshDevContext({ root, config, environment: { XDG_CACHE_HOME: join(root, 'cache') } })
  mkdirSync(context.sourcePack, { recursive: true })
  const helper = {
    loadDshDistribution() {
      return { dirty: true, reproducible: false }
    },
  }
  const cached = bootstrapTest.tryCachedDistribution(helper, context, context.sourcePack, { requireReproducible: true })
  assert.equal(cached.distribution, undefined)
  assert.match(cached.error.message, /clean and reproducible/u)
})

test('npm bootstrap repairs a missing package despite matching state hashes', async (t) => {
  const life = testLifecycle(t)
  const root = fixture(life)
  fakeNpmPackage(root, '@deepseek-ai/dsh-agent', VERSION)
  const pnpmScript = join(root, 'fake-pnpm.mjs')
  writeFileSync(pnpmScript, `#!/usr/bin/env node
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
if (process.argv.includes('--version')) {
  console.log('11.7.0')
} else if (process.argv.includes('install')) {
  const directory = join(process.cwd(), 'node_modules', '.pnpm', '@deepseek-ai+dsh-tools@0.1.2-alpha.1', 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.1.2-alpha.1' }))
  const link = join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(directory, link, 'dir')
} else {
  process.exitCode = 1
}
`)
  chmodSync(pnpmScript, 0o755)
  const state = {
    schemaVersion: 1,
    mode: 'npm',
    node: String(process.versions.node.split('.')[0]),
    pnpm: '11.7.0',
    root,
    packageJsonHash: hashFile(join(root, 'package.json')),
    lockfileHash: hashFile(join(root, 'pnpm-lock.yaml')),
  }
  writeFileSync(join(root, DEV_STATE_FILE), `${JSON.stringify(state)}\n`)
  const previous = process.env.PNPM_EXECUTABLE
  process.env.PNPM_EXECUTABLE = pnpmScript
  try {
    await bootstrapDevelopmentEnvironment({ root, mode: 'npm' })
  } finally {
    if (previous === undefined) delete process.env.PNPM_EXECUTABLE
    else process.env.PNPM_EXECUTABLE = previous
  }
  assert.equal(existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')), true)
})
