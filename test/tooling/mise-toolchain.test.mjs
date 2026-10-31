/**
 * The mise toolchain contract: the project tools, their lock/sidecar, the
 * task mapping, and the two task entry scripts' safety boundaries.
 *
 * This is a CONFIGURATION guard, not proof that a DSH CLI installs natively on
 * a given machine; the CI mise-toolchain job performs the real install and
 * version check.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/mise-toolchain.test
 */

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'

import { testLifecycle } from '../support/temp-lifecycle.ts'
import { REQUIRED_PHASES } from '../../scripts/ci-verdict.mjs'
import { DSH_REPOSITORY } from '../../scripts/dsh-dev-context.mjs'
import { _test as setupTest, runMiseSetup } from '../../scripts/mise-setup.mjs'
import { _test as profileTest, runMiseDevProfile } from '../../scripts/mise-dev-profile.mjs'
import { runMiseDevDsh } from '../../scripts/mise-dev-dsh.mjs'
import { _test as sourceModeTest } from '../../scripts/mise-source-mode.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MISE_TOML = readFileSync(join(ROOT, 'mise.toml'), 'utf8')
const MISE_LOCK = readFileSync(join(ROOT, 'mise.lock'), 'utf8')
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const matrix = JSON.parse(readFileSync(join(ROOT, 'src', 'dsh-compat-matrix.json'), 'utf8'))

function taskBody(task) {
  const header = task.includes(':') ? `[tasks."${task}"]` : `[tasks.${task}]`
  const start = MISE_TOML.indexOf(`${header}\n`)
  assert.notEqual(start, -1, `mise.toml must declare ${header}`)
  const next = MISE_TOML.indexOf('\n[', start + header.length)
  return MISE_TOML.slice(start, next === -1 ? undefined : next)
}

function taskRun(task) {
  const match = /^run = "(.*)"$/mu.exec(taskBody(task))
  assert.notEqual(match, null, `${task} must declare a run command`)
  return match[1]
}

function taskEnv(task) {
  const match = /^env = \{ (.*) \}$/mu.exec(taskBody(task))
  if (match === null) return {}
  return Object.fromEntries([...match[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/gu)].map(([, key, value]) => [key, value]))
}


function writeNpmFixture(root, { mode = 'npm', source = false } = {}) {
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'mise-worktree-fixture',
    private: true,
    packageManager: 'pnpm@12.11.2',
  }, null, 2)}\n`)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  mkdirSync(join(root, 'test', 'compat'), { recursive: true })
  writeFileSync(join(root, 'test', 'compat', 'dsh-mode.json'), `${JSON.stringify({ schemaVersion: 1, mode })}\n`)
  if (source) {
    writeFileSync(join(root, 'test', 'compat', 'dsh-source.json'), `${JSON.stringify({
      schemaVersion: 1,
      repository: DSH_REPOSITORY,
      ref: 'a'.repeat(40),
      expectedVersion: '0.2.1-rc.4',
    })}\n`)
  }
}

function writeMaterializedState(root, { mode = 'source', stateRoot = root, ...overrides } = {}) {
  const state = {
    schemaVersion: 1,
    mode,
    node: '24',
    pnpm: '12.11.2',
    root: stateRoot,
    packageJsonHash: 'a'.repeat(64),
    lockfileHash: 'b'.repeat(64),
    ...overrides,
  }
  if (mode === 'source') {
    Object.assign(state, {
      repository: DSH_REPOSITORY,
      ref: 'a'.repeat(40),
      expectedVersion: '0.2.1-rc.4',
      distribution: join(root, 'source-pack'),
      ...overrides,
    })
  }
  writeFileSync(join(root, '.dsh-dev-state.json'), `${JSON.stringify(state, null, 2)}\n`)
}

function fakeCommand(root, name, record) {
  const directory = join(root, 'bin')
  mkdirSync(directory, { recursive: true })
  const command = join(directory, name)
  writeFileSync(command, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + String.fromCharCode(10))
`)
  chmodSync(command, 0o755)
  return command
}

function allowBuildsFromMatrix() {
  const match = /--allow-scripts=(?<list>[^ ]+)/u.exec(matrix.current.upgradeCommand)
  assert.notEqual(match, null, 'the matrix upgrade command must carry the native-script allow list')
  return match.groups.list.split(',')
}

test('the mise tool pins take their versions from the single package.json authority', () => {
  assert.match(MISE_TOML, /^pnpm = "\{\{ read_json\(path='package\.json'\)\['packageManager'\] \| split\(pat='@'\) \| last \}\}"$/mu,
    'pnpm must be templated from packageManager, not a second hand-maintained pin')
  assert.match(MISE_TOML,
    /^"npm:@deepseek-ai\/dsh" = \{ version = "\{\{ read_json\(path='package\.json'\)\['devDependencies'\]\['@deepseek-ai\/dsh-agent'\] \}\}", allow_builds = \[[^\]]*\] \}$/mu,
    'the DSH CLI version must be templated from the exact dsh-agent devDependency')
  assert.match(packageJson.devDependencies['@deepseek-ai/dsh-agent'], /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
    'the dsh-agent devDependency must remain the exact version authority')

  const line = MISE_TOML.split('\n').find(candidate => candidate.startsWith('"npm:@deepseek-ai/dsh"'))
  const allowMatch = /allow_builds = \[(.*)\]/u.exec(line)
  assert.notEqual(allowMatch, null, 'the DSH tool must declare allow_builds')
  const allowBuilds = JSON.parse(`[${allowMatch[1]}]`)
  assert.deepEqual(allowBuilds, allowBuildsFromMatrix(),
    'mise allow_builds must stay the same native-script allow list the published upgrade command names')
})

test('mise.lock records the resolved tools and the npm sidecar exists', () => {
  const dshSection = /\[\[tools\."npm:@deepseek-ai\/dsh"\]\]\nversion = "(?<version>[^"]+)"/u.exec(MISE_LOCK)
  assert.notEqual(dshSection, null, 'mise.lock must record the npm DSH tool')
  assert.equal(dshSection.groups.version, packageJson.devDependencies['@deepseek-ai/dsh-agent'])
  const expectedPnpm = packageJson.packageManager.split('@').pop()
  assert.match(MISE_LOCK, /\[\[tools\.node\]\]\nversion = "24\./u)
  assert.ok(MISE_LOCK.includes(`[[tools.pnpm]]\nversion = "${expectedPnpm}"`), 'mise.lock must record the packageManager pnpm version')

  const sidecar = /aube = \{ path = "(?<path>[^"]+)", digest = "sha256:[0-9a-f]{64}" \}/u.exec(MISE_LOCK)
  assert.notEqual(sidecar, null, 'mise.lock must reference the aube sidecar with a digest')
  const sidecarRoot = join(ROOT, sidecar.groups.path)
  assert.equal(existsSync(join(sidecarRoot, 'aube-lock.yaml')), true, 'the referenced aube lock must be committed')
  assert.equal(existsSync(join(sidecarRoot, 'package.json')), true, 'the sidecar package manifest must be committed')
  const sidecarPackage = JSON.parse(readFileSync(join(sidecarRoot, 'package.json'), 'utf8'))
  assert.equal(sidecarPackage.dependencies['@deepseek-ai/dsh'], packageJson.devDependencies['@deepseek-ai/dsh-agent'])
})

test('the mise task map mirrors the existing pnpm entry points without adding gates', () => {
  assert.equal(taskRun('setup'), 'node scripts/mise-setup.mjs')
  assert.equal(taskRun('build'), 'pnpm build')
  assert.equal(taskRun('typecheck'), 'pnpm typecheck')
  assert.equal(taskRun('test:fork'), 'pnpm test:fork')
  assert.equal(taskRun('test:product'), 'pnpm test:product')
  assert.equal(taskRun('test:tooling'), 'pnpm test:tooling')
  assert.equal(taskRun('test:tmux'), 'pnpm test:tmux')
  assert.equal(taskRun('test'), 'pnpm test')
  assert.equal(taskRun('verify:release'), 'pnpm verify:release')
  assert.equal(taskRun('dev:profile'), 'node scripts/mise-dev-profile.mjs')
  assert.equal(taskRun('dev:dsh'), 'node scripts/mise-dev-dsh.mjs')
  assert.equal(taskRun('source:doctor'), 'node scripts/dev-doctor.mjs --mode source')
  assert.equal(taskRun('source:bootstrap'), 'node scripts/dev-bootstrap.mjs --mode source')
  assert.equal(taskRun('source:profile'), 'node scripts/mise-source-mode.mjs profile')
  assert.equal(taskRun('source:dsh'), 'node scripts/mise-source-mode.mjs dsh')
  for (const task of ['source:doctor', 'source:bootstrap', 'source:profile', 'source:dsh']) {
    assert.equal(taskEnv(task).DSH_MODE, 'source', `${task} must select source mode explicitly`)
  }
  for (const task of ['source:profile', 'source:dsh']) {
    assert.match(taskEnv(task).DSH_HOME, /\/temp\/source-dsh-home$/u, `${task} must use the isolated source home`)
  }
  assert.doesNotMatch(MISE_TOML, /^\[tasks\."(smoke|gate):/mu, 'mise must not mirror smoke/gate lanes')
  assert.doesNotMatch(MISE_TOML, /^\[env\]/mu, 'mise must not set a global development environment')
})

test('mise run setup runs the frozen npm install in this checkout', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-mise-setup-')
  const record = join(root, 'pnpm-record.json')
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'mise-setup-fixture',
    private: true,
    packageManager: 'pnpm@12.11.2',
  }, null, 2)}\n`)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  mkdirSync(join(root, 'test', 'compat'), { recursive: true })
  writeFileSync(join(root, 'test', 'compat', 'dsh-mode.json'), `${JSON.stringify({ schemaVersion: 1, mode: 'npm' })}\n`)
  const fakePnpm = join(root, 'pnpm-fixture')
  writeFileSync(fakePnpm, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))
`)
  chmodSync(fakePnpm, 0o755)
  runMiseSetup({ root, environment: { PATH: process.env.PATH, XDG_CACHE_HOME: join(root, 'cache'), PNPM_EXECUTABLE: fakePnpm } })
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), {
    args: ['install', '--frozen-lockfile'],
    cwd: root,
  })
})

test('mise run setup refuses a source-mode worktree before spawning pnpm', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-mise-setup-source-')
  const record = join(root, 'pnpm-record.json')
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'mise-setup-fixture',
    private: true,
    packageManager: 'pnpm@12.11.2',
  }, null, 2)}\n`)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  mkdirSync(join(root, 'test', 'compat'), { recursive: true })
  writeFileSync(join(root, 'test', 'compat', 'dsh-mode.json'), `${JSON.stringify({ schemaVersion: 1, mode: 'source' })}\n`)
  writeFileSync(join(root, 'test', 'compat', 'dsh-source.json'), `${JSON.stringify({
    schemaVersion: 1,
    repository: DSH_REPOSITORY,
    ref: 'a'.repeat(40),
    expectedVersion: '0.2.1-rc.4',
  })}\n`)
  const fakePnpm = join(root, 'pnpm-fixture')
  writeFileSync(fakePnpm, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(record)}, 'spawned')
`)
  chmodSync(fakePnpm, 0o755)
  assert.throws(
    () => runMiseSetup({ root, environment: { PATH: process.env.PATH, XDG_CACHE_HOME: join(root, 'cache'), PNPM_EXECUTABLE: fakePnpm } }),
    /refuses the tracked source mode/u,
  )
  assert.throws(
    () => runMiseSetup({ root, environment: { PATH: process.env.PATH, XDG_CACHE_HOME: join(root, 'cache'), PNPM_EXECUTABLE: fakePnpm, DSH_MODE: 'npm' } }),
    /refuses the tracked source mode/u,
    'a DSH_MODE override must not turn a tracked source worktree into a plain npm install',
  )
  assert.equal(existsSync(record), false, 'the source-mode guard must fail before pnpm install starts')
})

test('the CI mise-toolchain job is a required, mode-aware contract lane', () => {
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
  const job = workflow.jobs['mise-toolchain']
  assert.notEqual(job, undefined, 'ci.yml must define the mise-toolchain job')
  assert.match(job.env.MISE_ENABLE_TOOLS, /mode == 'source' && 'node,pnpm' \|\| 'node,pnpm,npm:@deepseek-ai\/dsh'/u)
  const setup = (job.steps ?? []).find(step => typeof step.uses === 'string' && step.uses.startsWith('jdx/mise-action@'))
  assert.notEqual(setup, undefined, 'the job must use the official mise action')
  assert.match(setup.uses, /@[0-9a-f]{40}$/u, 'the third-party action must be pinned to a full commit SHA')
  assert.equal(setup.with.install, true)
  assert.equal(setup.with.install_args, '--locked', 'the CI install must require the committed lockfile')

  const npmSetup = (job.steps ?? []).find(step => step.run === 'mise run setup')
  assert.notEqual(npmSetup, undefined, 'the npm-mode setup step must exist')
  assert.match(npmSetup.if, /mode == 'npm'/u, 'mise run setup must be limited to npm mode')
  const npmVersion = (job.steps ?? []).find(step => typeof step.run === 'string' && step.run.includes('mise exec -- dsh --version'))
  assert.notEqual(npmVersion, undefined, 'the npm CLI version check must exist')
  assert.match(npmVersion.if, /mode == 'npm'/u, 'the npm CLI check must be limited to npm mode')
  const sourceCheck = (job.steps ?? []).find(step => step.name === 'Verify Source toolchain contract')
  assert.notEqual(sourceCheck, undefined, 'the source-mode contract step must exist')
  assert.match(sourceCheck.if, /mode == 'source'/u, 'the source contract must be limited to source mode')
  assert.doesNotMatch(sourceCheck.run, /mise run setup/u, 'source mode must never run the npm setup task')
  assert.match((job.steps ?? []).map(step => step.run).filter(Boolean).join('\n'), /missing committed mise sidecar/u)
  assert.ok(REQUIRED_PHASES.includes('mise-toolchain'), 'the contract lane must block qualification')
})

test('the source-mode helper accepts only a CLI inside this worktree', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-mise-source-')
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
  mkdirSync(join(root, 'node_modules', '.pnpm', 'source-dsh', 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  const cli = join(root, 'node_modules', '.bin', 'dsh')
  symlinkSync(join(root, 'node_modules', '.pnpm', 'source-dsh', 'node_modules', '@deepseek-ai', 'dsh'), cli, 'dir')
  assert.equal(sourceModeTest.sourceCliPath(root), join(root, 'node_modules', '.pnpm', 'source-dsh', 'node_modules', '@deepseek-ai', 'dsh'))
  const outsideRoot = life.tempDir('dsh-mise-source-outside-')
  const outside = join(outsideRoot, 'outside-dsh')
  mkdirSync(outside)
  mkdirSync(join(outsideRoot, 'node_modules', '.bin'), { recursive: true })
  symlinkSync(outside, join(outsideRoot, 'node_modules', '.bin', 'dsh'), 'dir')
  assert.throws(() => sourceModeTest.sourceCliPath(outsideRoot), /outside this worktree/u)
})

test('the development profile refuses the real DSH home and an unbuilt checkout', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-mise-profile-')
  assert.throws(() => profileTest.assertIsolatedHome({}), /DSH_HOME is not set/u)
  assert.throws(() => profileTest.assertIsolatedHome({ DSH_HOME: join(homedir(), '.dsh') }), /refusing to install/u)
  assert.throws(() => profileTest.assertIsolatedHome({ DSH_HOME: join(homedir(), '.dsh', 'profiles') }), /refusing to install/u)
  profileTest.assertIsolatedHome({ DSH_HOME: join(root, 'temp', 'mise-dsh-home') }, 'mise run dev:profile', root)
  assert.throws(() => profileTest.assertBuildOutput(root), /run `mise run build` first/u)
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'dist', 'index.mjs'), 'export {}\n')
  profileTest.assertBuildOutput(root)
  assert.equal(setupTest.INSTALL_ARGUMENTS.join(' '), 'install --frozen-lockfile')
})


test('mise run setup refuses a committed Source materialization even without DSH_MODE', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-mise-setup-materialized-')
  writeNpmFixture(root)
  writeMaterializedState(root)
  const record = join(root, 'pnpm-record.json')
  const fakePnpm = fakeCommand(root, 'pnpm-fixture', record)
  const environment = { PATH: `${join(root, 'bin')}:${process.env.PATH}`, XDG_CACHE_HOME: join(root, 'cache'), PNPM_EXECUTABLE: fakePnpm }
  assert.throws(() => runMiseSetup({ root, environment }), /records a Source materialization/u)
  assert.throws(() => runMiseSetup({ root, environment: { ...environment, DSH_MODE: 'npm' } }), /records a Source materialization/u)
  assert.equal(existsSync(record), false, 'the Source-materialization guard must fail before pnpm')
  assert.equal(JSON.parse(readFileSync(join(root, '.dsh-dev-state.json'), 'utf8')).mode, 'source')
})

test('mise run setup rejects stale, malformed and foreign materialization state', (t) => {
  const life = testLifecycle(t)
  for (const [name, mutate] of [
    ['stale hash', root => writeMaterializedState(root, { packageJsonHash: '0'.repeat(64) })],
    ['foreign root', root => writeMaterializedState(root, { stateRoot: join(root, 'other-worktree') })],
    ['malformed json', root => writeFileSync(join(root, '.dsh-dev-state.json'), '{not-json\n')],
    ['dangling symlink', root => {
      writeMaterializedState(root, { mode: 'npm' })
      unlinkSync(join(root, '.dsh-dev-state.json'))
      symlinkSync(join(root, 'missing-state-target.json'), join(root, '.dsh-dev-state.json'))
    }],
    ['symlink state', root => {
      writeMaterializedState(root, { mode: 'npm' })
      const target = join(root, 'real-state.json')
      writeFileSync(target, readFileSync(join(root, '.dsh-dev-state.json')))
      unlinkSync(join(root, '.dsh-dev-state.json'))
      symlinkSync(target, join(root, '.dsh-dev-state.json'))
    }],
  ]) {
    const root = life.tempDir(`dsh-mise-setup-${name.replaceAll(' ', '-')}-`)
    writeNpmFixture(root)
    mutate(root)
    const record = join(root, 'pnpm-record.json')
    const fakePnpm = fakeCommand(root, 'pnpm-fixture', record)
    assert.throws(
      () => runMiseSetup({ root, environment: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, PNPM_EXECUTABLE: fakePnpm } }),
      /dsh-dev-state|belongs to|regular file/u,
      `${name} must fail closed`,
    )
    assert.equal(existsSync(record), false, `${name} must not spawn pnpm`)
  }
})

test('mise run setup rejects an npm state with malformed writer hashes', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-mise-setup-malformed-npm-')
  writeNpmFixture(root)
  writeMaterializedState(root, { mode: 'npm', packageJsonHash: 'garbage', lockfileHash: 'garbage' })
  const record = join(root, 'pnpm-record.json')
  const fakePnpm = fakeCommand(root, 'pnpm-fixture', record)
  assert.throws(
    () => runMiseSetup({ root, environment: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, PNPM_EXECUTABLE: fakePnpm } }),
    /packageJsonHash/u,
  )
  assert.equal(existsSync(record), false, 'a malformed npm state must not spawn pnpm')
})

test('mise run setup rejects a dangling state symlink before spawning pnpm', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-mise-setup-dangling-')
  writeNpmFixture(root)
  writeMaterializedState(root, { mode: 'npm' })
  unlinkSync(join(root, '.dsh-dev-state.json'))
  symlinkSync(join(root, 'missing-state-target.json'), join(root, '.dsh-dev-state.json'))
  const record = join(root, 'pnpm-record.json')
  const fakePnpm = fakeCommand(root, 'pnpm-fixture', record)
  assert.throws(
    () => runMiseSetup({ root, environment: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, PNPM_EXECUTABLE: fakePnpm } }),
    /regular file/u,
  )
  assert.equal(existsSync(record), false, 'a dangling state symlink must not spawn pnpm')
})

test('npm profile and dev:dsh reject a Source-materialized worktree before spawning dsh', (t) => {
  const life = testLifecycle(t)
  const make = (name, stateMode) => {
    const root = life.tempDir(`dsh-mise-entry-${name}-`)
    writeNpmFixture(root, { mode: 'npm' })
    if (stateMode !== undefined) writeMaterializedState(root, { mode: stateMode })
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'index.mjs'), 'export {}\n')
    const record = join(root, 'dsh-record.json')
    fakeCommand(root, 'dsh', record)
    const environment = { PATH: `${join(root, 'bin')}:${process.env.PATH}`, DSH_HOME: join(root, 'temp', 'mise-dsh-home') }
    return { root, record, environment }
  }
  for (const entry of ['profile', 'dsh']) {
    const source = make(`source-${entry}`, 'source')
    const run = entry === 'profile' ? runMiseDevProfile : runMiseDevDsh
    assert.throws(() => run({ root: source.root, environment: source.environment }), /records a Source materialization/u)
    assert.equal(existsSync(source.record), false, `${entry} must not spawn dsh for a Source worktree`)

    const tracked = make(`tracked-${entry}`, undefined)
    writeNpmFixture(tracked.root, { mode: 'source', source: true })
    assert.throws(() => run({ root: tracked.root, environment: tracked.environment }), /tracked source mode/u)
    assert.equal(existsSync(tracked.record), false, `${entry} must not spawn dsh for a tracked Source worktree`)
  }
})

test('npm profile and dev:dsh still start on a clean npm worktree', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-mise-entry-npm-')
  writeNpmFixture(root)
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'dist', 'index.mjs'), 'export {}\n')
  const record = join(root, 'dsh-record.json')
  fakeCommand(root, 'dsh', record)
  const environment = { PATH: `${join(root, 'bin')}:${process.env.PATH}`, DSH_HOME: join(root, 'temp', 'mise-dsh-home') }
  runMiseDevProfile({ root, environment })
  runMiseDevDsh({ root, environment, args: [] })
  const calls = readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls[0].args, ['plugin', '--profile', 'pi-tui-dev', '--', 'add', 'link:.'])
  assert.deepEqual(calls[1].args, ['--profile', 'pi-tui-dev'])
})

test('the canonical DSH_HOME guard rejects symlinks into the real home and foreign worktrees', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-mise-home-root-')
  const otherRoot = life.tempDir('dsh-mise-home-other-')
  const fakeHome = life.tempDir('dsh-mise-home-fake-')
  mkdirSync(join(fakeHome, '.dsh'))
  mkdirSync(join(root, 'temp'))
  mkdirSync(join(otherRoot, 'temp', 'mise-dsh-home'), { recursive: true })
  const previousHome = process.env.HOME
  process.env.HOME = fakeHome
  try {
    profileTest.assertIsolatedHome({ DSH_HOME: join(root, 'temp', 'mise-dsh-home') }, 'test', root)
    assert.throws(
      () => profileTest.assertIsolatedHome({ DSH_HOME: join(otherRoot, 'temp', 'mise-dsh-home') }, 'test', root),
      /outside this worktree/u,
    )
    symlinkSync(join(fakeHome, '.dsh'), join(root, 'temp', 'linked-home'), 'dir')
    assert.throws(
      () => profileTest.assertIsolatedHome({ DSH_HOME: join(root, 'temp', 'linked-home', 'nested') }, 'test', root),
      /real ~\/\.dsh/u,
    )
    symlinkSync(join(fakeHome, '.dsh'), join(root, 'temp', 'target-home'))
    assert.throws(
      () => profileTest.assertIsolatedHome({ DSH_HOME: join(root, 'temp', 'target-home') }, 'test', root),
      /real ~\/\.dsh/u,
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})


test('development docs distinguish setup from legacy doctor state', () => {
  const guide = readFileSync(join(ROOT, 'docs', 'guides', 'development.md'), 'utf8')
  assert.match(guide, /`mise run setup` is an INSTALL action, not a doctor or\s+state writer/u)
  assert.match(guide, /legacy\s+`pnpm dev:doctor` may report `MISSING`/u)
  assert.match(guide, /source-materialized even when its tracked mode is `npm`/u)
})
