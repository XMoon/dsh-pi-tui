/**
 * macOS launchd LaunchAgent adapter: plist identity, atomic installation,
 * bounded `launchctl` parsing/error taxonomy and the real native job lifecycle.
 *
 * Evidence level: structural tests prove the product-owned file/identity and
 * command-construction contracts. The native test (macOS only) drives a REAL
 * `/bin/launchctl` bootstrap/kickstart/bootout against a private probe label and
 * a real foreground child; it never touches the real pi-tui profile or another
 * LaunchAgent.
 *
 * @module @xmoon76/dsh-pi-tui/local-host-launchd.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  buildLaunchdLabel,
  inspectLaunchdService,
  inspectOwnedLaunchdUnit,
  installLaunchdUnit,
  launchdLogPaths,
  launchdPlistName,
  launchdServiceMatches,
  parseLaunchctlPrint,
  renderLaunchdPlist,
  startLaunchdService,
  stopLaunchdService,
  uninstallLaunchdUnit,
  type LaunchctlResult,
  type LaunchctlRunner,
  type LaunchdAdapterDeps,
  type LaunchdLoadedService,
  type LaunchdUnitFacts,
  type OwnedLaunchdUnit,
} from '../../src/app/remote-process/local-host-launchd.ts'
import { collectUnitFacts, profileIdentityDigest, startManagedHostCandidate } from '../../src/app/remote-process/local-host-manager.ts'
import {
  inspectInstalledProfileScope,
  LocalScopeError,
  scopeFromInstalledProfile,
  type LocalScope,
} from '../../src/app/remote-process/local-scope.ts'

const UID = process.getuid?.() ?? 501
const DSH_VERSION = '0.2.2-rc.3'

function exited(code: number, stdout = '', stderr = ''): LaunchctlResult {
  return { kind: 'exited', code, stdout, stderr }
}

interface Fixture {
  readonly root: string
  readonly accountHome: string
  readonly dshHome: string
  readonly profileDir: string
  readonly packageRoot: string
  readonly anchor: string
  readonly scope: LocalScope
  readonly facts: LaunchdUnitFacts
}

function fixture(t: TestContext): Fixture {
  const root = testLifecycle(t).tempDir('launchd-adapter-')
  const accountHome = join(root, 'account-home')
  const dshHome = join(root, 'dsh-home')
  const profileDir = join(root, 'profiles', 'pi-tui')
  const packageRoot = join(root, 'package')
  const anchorDir = join(root, 'dsh')
  mkdirSync(accountHome, { recursive: true, mode: 0o700 })
  mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  mkdirSync(join(packageRoot, 'dist'), { recursive: true, mode: 0o700 })
  mkdirSync(anchorDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version: '0.5.7' })}\n`)
  writeFileSync(join(packageRoot, 'dist', 'local-host.mjs'), 'process.exit(0)\n')
  const anchor = join(anchorDir, 'package.json')
  writeFileSync(anchor, `${JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_VERSION })}\n`, { mode: 0o644 })
  const scope = inspectInstalledProfileScope({ dshHome, profileDir, packageRoot, dshVersion: DSH_VERSION })
  mkdirSync(scope.dir, { recursive: true, mode: 0o700 })
  const base = collectUnitFacts({
    scope,
    hostEntryPath: join(packageRoot, 'dist', 'local-host.mjs'),
    dshAnchor: anchor,
    profile: 'pi-tui',
  })
  const facts: LaunchdUnitFacts = {
    ...base,
    scopeDir: scope.dir,
    profileIdentity: profileIdentityDigest(scope.profileRealpath),
  }
  return { root, accountHome, dshHome, profileDir, packageRoot, anchor, scope, facts }
}

function depsOf(fx: Fixture, overrides: Partial<LaunchdAdapterDeps> = {}): LaunchdAdapterDeps {
  return { accountHome: fx.accountHome, uid: UID, ...overrides }
}

function plistPathOf(fx: Fixture): string {
  return join(fx.accountHome, 'Library', 'LaunchAgents', launchdPlistName(fx.facts.scopeId))
}

function ownedUnitOf(fx: Fixture, deps: LaunchdAdapterDeps): OwnedLaunchdUnit {
  const inspected = inspectOwnedLaunchdUnit(fx.facts, deps)
  assert.equal(inspected.kind, 'owned')
  return (inspected as { readonly kind: 'owned'; readonly unit: OwnedLaunchdUnit }).unit
}

interface FakeJob {
  loaded: boolean
  state: string
  pid?: number
  path: string
  program: string
  arguments: readonly string[]
  workingDirectory: string
  stdoutPath: string
  stderrPath: string
  environment: Readonly<Record<string, string>>
}

/** Render one real-format `launchctl print` answer (two-tab block entries). */
function printOutput(job: FakeJob, label: string): string {
  const args = job.arguments.map(value => `\t\t${value}`).join('\n')
  const env = Object.entries(job.environment).map(([key, value]) => `\t\t${key} => ${value}`).join('\n')
  return [
    `gui/${String(UID)}/${label} = {`,
    '\tactive count = 1',
    `\tpath = ${job.path}`,
    '\ttype = LaunchAgent',
    `\tstate = ${job.state}`,
    '',
    `\tprogram = ${job.program}`,
    '\targuments = {',
    args,
    '\t}',
    '',
    `\tworking directory = ${job.workingDirectory}`,
    '',
    `\tstdout path = ${job.stdoutPath}`,
    `\tstderr path = ${job.stderrPath}`,
    '',
    '\tenvironment = {',
    env,
    '\t}',
    '',
    ...(job.pid === undefined ? [] : [`\tpid = ${String(job.pid)}`]),
    '\truns = 1',
    '\tlast exit code = (never exited)',
    '\tproperties = partial import | inferred program',
    '}',
    '',
  ].join('\n')
}

function fakeJobOf(fx: Fixture, overrides: Partial<FakeJob> = {}): FakeJob {
  const logs = launchdLogPaths(fx.facts.scopeDir)
  return {
    loaded: true,
    state: 'running',
    pid: 4242,
    path: plistPathOf(fx),
    program: fx.facts.nodePath,
    arguments: [fx.facts.nodePath, fx.facts.hostEntryPath],
    workingDirectory: fx.facts.profileRealpath,
    stdoutPath: logs.stdout,
    stderrPath: logs.stderr,
    environment: {
      DSH_HOME: fx.facts.dshHome,
      SPLIT_PROCESS_DSH_ANCHOR: fx.facts.dshAnchor,
      SPLIT_PROCESS_PROFILE: fx.facts.profile,
    },
    ...overrides,
  }
}

interface FakeLaunchctl {
  readonly run: LaunchctlRunner
  readonly calls: string[][]
  readonly job: FakeJob
}

function fakeLaunchctl(fx: Fixture, initial: Partial<FakeJob> = {}): FakeLaunchctl {
  const job = fakeJobOf(fx, initial)
  const calls: string[][] = []
  const label = buildLaunchdLabel(fx.facts.scopeId)
  const run: LaunchctlRunner = async args => {
    calls.push([...args])
    if (args[0] === 'print' && args[1] === `gui/${String(UID)}`) return exited(0, `gui/${String(UID)} = {\n}\n`)
    if (args[0] === 'print' && args[1] === `gui/${String(UID)}/${label}`) {
      return job.loaded ? exited(0, printOutput(job, label)) : exited(113, '', `Could not find service "${label}"`)
    }
    if (args[0] === 'bootstrap') {
      job.loaded = true
      job.state = 'not running'
      delete job.pid
      return exited(0)
    }
    if (args[0] === 'kickstart') {
      job.loaded = true
      job.state = 'running'
      job.pid = 4242
      return exited(0)
    }
    if (args[0] === 'bootout') {
      if (!job.loaded) return exited(3, '', 'No such process')
      job.loaded = false
      job.state = 'not running'
      delete job.pid
      return exited(0)
    }
    return exited(2, '', 'unexpected launchctl verb')
  }
  return { run, calls, job }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

// ── deterministic identity and plist rendering ─────────────────────────────

test('the launchd label uses one fixed prefix and the first 40 scope characters', t => {
  const fx = fixture(t)
  assert.equal(buildLaunchdLabel(fx.facts.scopeId), `com.xmoon.dsh-pi-tui.${fx.facts.scopeId.slice(0, 40)}`)
  assert.equal(launchdPlistName(fx.facts.scopeId), `${buildLaunchdLabel(fx.facts.scopeId)}.plist`)
})

test('the rendered plist fixes the no-login/no-keepalive contract and the exact private env', t => {
  const fx = fixture(t)
  const content = renderLaunchdPlist(fx.facts)
  assert.match(content, /<key>RunAtLoad<\/key>\n\s*<false\/>/u)
  assert.match(content, /<key>KeepAlive<\/key>\n\s*<false\/>/u)
  assert.match(content, /<key>Umask<\/key>\n\s*<integer>63<\/integer>/u)
  assert.match(
    content,
    new RegExp(
      `<key>ProgramArguments</key>\\s*<array>\\s*<string>${escapeRegExp(fx.facts.nodePath)}</string>\\s*<string>${escapeRegExp(fx.facts.hostEntryPath)}</string>\\s*</array>`,
      'u',
    ),
  )
  assert.match(content, new RegExp(`<key>WorkingDirectory</key>\\s*<string>${escapeRegExp(fx.facts.profileRealpath)}</string>`, 'u'))
  const logs = launchdLogPaths(fx.facts.scopeDir)
  assert.match(content, new RegExp(`<key>StandardOutPath</key>\\s*<string>${escapeRegExp(logs.stdout)}</string>`, 'u'))
  assert.match(content, new RegExp(`<key>StandardErrorPath</key>\\s*<string>${escapeRegExp(logs.stderr)}</string>`, 'u'))
  assert.notEqual(logs.stdout, logs.stderr)
  const envStart = content.indexOf('<key>EnvironmentVariables</key>')
  const env = content.slice(envStart, content.indexOf('\n  </dict>', envStart))
  assert.match(env, /<key>DSH_HOME<\/key>/u)
  assert.match(env, /<key>SPLIT_PROCESS_DSH_ANCHOR<\/key>/u)
  assert.match(env, /<key>SPLIT_PROCESS_PROFILE<\/key>/u)
  assert.equal((env.match(/^    <key>/gmu) ?? []).length, 3, 'the LaunchAgent environment carries exactly the three official anchors')
  assert.match(content, /<key>X-DshPiTuiOwner<\/key>\s*<string>local-host-launchd-v1<\/string>/u)
  assert.match(content, new RegExp(`<key>X-DshPiTuiScopeId</key>\\s*<string>${fx.facts.scopeId}</string>`, 'u'))
  assert.match(content, new RegExp(`<key>X-DshPiTuiInstallBuild</key>\\s*<string>${fx.facts.buildId}</string>`, 'u'))
  assert.doesNotMatch(content, /daemonize|--daemon|\/bin\/sh|dsh-pi-tui daemon start/iu)
})

test('plist values are XML-escaped and control characters are refused', t => {
  const fx = fixture(t)
  const content = renderLaunchdPlist({ ...fx.facts, dshHome: `${fx.facts.dshHome}&"<'>` })
  assert.match(content, /&amp;&quot;&lt;&apos;&gt;/u)
  assert.throws(
    () => renderLaunchdPlist({ ...fx.facts, profile: 'pi\n-tui' }),
    (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_UNIT_CONFLICT',
  )
})

// ── bounded launchctl parsing ──────────────────────────────────────────────

test('launchctl print parsing keeps only the fixed job facts from the real format', t => {
  const fx = fixture(t)
  const job = fakeJobOf(fx)
  const parsed = parseLaunchctlPrint(printOutput(job, buildLaunchdLabel(fx.facts.scopeId)))
  assert.notEqual(parsed, undefined)
  const service = parsed as LaunchdLoadedService
  assert.equal(service.type, 'LaunchAgent')
  assert.equal(service.path, job.path)
  assert.equal(service.state, 'running')
  assert.equal(service.pid, 4242)
  assert.deepEqual(service.arguments, [...job.arguments])
  assert.equal(service.environment.DSH_HOME, fx.facts.dshHome)
  assert.equal(service.environment.SPLIT_PROCESS_PROFILE, 'pi-tui')
})

test('launchctl print parsing fails closed when a required block is missing or ambiguous', t => {
  const fx = fixture(t)
  const label = buildLaunchdLabel(fx.facts.scopeId)
  const valid = printOutput(fakeJobOf(fx), label)
  assert.notEqual(parseLaunchctlPrint(valid), undefined)
  const missingArguments = valid.replace(/\targuments = \{\n(\t\t.*\n)+\t\}\n/u, '')
  assert.equal(parseLaunchctlPrint(missingArguments), undefined)
  const duplicateEnvironment = valid.replace(/\t\tDSH_HOME => (.*)\n/u, '\t\tDSH_HOME => $1\n\t\tDSH_HOME => $1\n')
  assert.equal(parseLaunchctlPrint(duplicateEnvironment), undefined)
  const badPid = valid.replace(/\tpid = 4242/u, '\tpid = not-a-pid')
  assert.equal(parseLaunchctlPrint(badPid), undefined)
  const nonAgent = valid.replace(/\ttype = LaunchAgent/u, '\ttype = LaunchDaemon')
  assert.equal(parseLaunchctlPrint(nonAgent), undefined)
})

test('service matching requires the exact file, program, argv, cwd, sinks and anchors', t => {
  const fx = fixture(t)
  const deps = depsOf(fx)
  assert.equal(inspectOwnedLaunchdUnit(fx.facts, deps).kind, 'none')
  mkdirSync(join(fx.accountHome, 'Library', 'LaunchAgents'), { recursive: true, mode: 0o700 })
  writeFileSync(plistPathOf(fx), renderLaunchdPlist(fx.facts), { mode: 0o600 })
  const unit = ownedUnitOf(fx, deps)
  const service = parseLaunchctlPrint(printOutput(fakeJobOf(fx), unit.label)) as LaunchdLoadedService
  assert.equal(launchdServiceMatches(fx.facts, unit, service), true)
  const mismatches: Array<[string, LaunchdLoadedService]> = [
    ['source path', { ...service, path: `${service.path}.other` }],
    ['program', { ...service, program: `${service.program}-other` }],
    ['arguments', { ...service, arguments: [service.program] }],
    ['working directory', { ...service, workingDirectory: `${service.workingDirectory}-other` }],
    ['stdout path', { ...service, stdoutPath: `${service.stdoutPath}-other` }],
    ['environment', { ...service, environment: { ...service.environment, SPLIT_PROCESS_PROFILE: 'other' } }],
  ]
  for (const [label, value] of mismatches) {
    assert.equal(launchdServiceMatches(fx.facts, unit, value), false, `${label} mismatch must not match`)
  }
})

// ── file identity and atomic installation ──────────────────────────────────

test('inspect with no LaunchAgents chain is a side-effect-free none', t => {
  const fx = fixture(t)
  const inspection = inspectOwnedLaunchdUnit(fx.facts, depsOf(fx))
  assert.equal(inspection.kind, 'none')
  assert.equal(existsSync(join(fx.accountHome, 'Library')), false, 'inspection must not create directories')
})

test('install writes one 0600 plist without bootstrap, kickstart or bootout', async t => {
  const fx = fixture(t)
  const launchctl = fakeLaunchctl(fx, { loaded: false })
  const result = await installLaunchdUnit(fx.facts, depsOf(fx, { launchctl: launchctl.run }))
  assert.equal(result.created, true)
  assert.equal(result.filePath, plistPathOf(fx))
  assert.equal(statSync(result.filePath).mode & 0o777, 0o600)
  assert.equal(readFileSync(result.filePath, 'utf8'), renderLaunchdPlist(fx.facts))
  assert.deepEqual(launchctl.calls, [
    ['print', `gui/${String(UID)}`],
    ['print', `gui/${String(UID)}/${buildLaunchdLabel(fx.facts.scopeId)}`],
  ], 'install checks the domain and same-label source but never starts/stops a job')
})

test('install is idempotent and never rewrites a same-identity user plist', async t => {
  const fx = fixture(t)
  const launchctl = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: launchctl.run })
  const first = await installLaunchdUnit(fx.facts, deps)
  assert.equal(first.created, true)
  const edited = `${readFileSync(first.filePath, 'utf8')}\n<!-- user runtime edit -->\n`
  writeFileSync(first.filePath, edited, { mode: 0o600 })
  const second = await installLaunchdUnit(fx.facts, deps)
  assert.equal(second.created, false)
  assert.equal(readFileSync(first.filePath, 'utf8'), edited, 'an existing same-owner plist is never rewritten')
})

test('install refuses a foreign file, a symlink and another installed build without overwriting', async t => {
  const fx = fixture(t)
  const dir = join(fx.accountHome, 'Library', 'LaunchAgents')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = plistPathOf(fx)
  const launchctl = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: launchctl.run })

  writeFileSync(path, renderLaunchdPlist({ ...fx.facts, scopeId: 'd'.repeat(64) }), { mode: 0o600 })
  const foreign = readFileSync(path, 'utf8')
  await assert.rejects(installLaunchdUnit(fx.facts, deps), (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_UNIT_CONFLICT')
  assert.equal(readFileSync(path, 'utf8'), foreign, 'a foreign scope plist is never overwritten')
  unlinkSync(path)

  const target = join(fx.root, 'real.plist')
  writeFileSync(target, renderLaunchdPlist(fx.facts), { mode: 0o600 })
  symlinkSync(target, path)
  await assert.rejects(installLaunchdUnit(fx.facts, deps), (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_UNIT_CONFLICT')
  assert.equal(existsSync(path), true, 'a symlink at the profile path is preserved')
  unlinkSync(path)

  writeFileSync(path, renderLaunchdPlist({ ...fx.facts, buildId: 'e'.repeat(64) }), { mode: 0o600 })
  const otherBuild = readFileSync(path, 'utf8')
  await assert.rejects(installLaunchdUnit(fx.facts, deps), (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_UNIT_CONFLICT')
  assert.equal(readFileSync(path, 'utf8'), otherBuild, 'a plist from another build is never overwritten')
})

test('install refuses a same-label job loaded from another source and writes nothing', async t => {
  const fx = fixture(t)
  const foreignPath = join(fx.root, 'foreign', 'foreign.plist')
  mkdirSync(join(fx.root, 'foreign'), { recursive: true, mode: 0o700 })
  writeFileSync(foreignPath, '<?xml?><plist/>', { mode: 0o600 })
  const launchctl = fakeLaunchctl(fx, { loaded: true, path: foreignPath })
  await assert.rejects(
    installLaunchdUnit(fx.facts, depsOf(fx, { launchctl: launchctl.run })),
    (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_UNIT_CONFLICT',
  )
  assert.equal(existsSync(plistPathOf(fx)), false, 'no plist may be written while a foreign job owns the label')
})

test('install refuses a same-path loaded job when the owned plist is absent', async t => {
  const fx = fixture(t)
  const launchctl = fakeLaunchctl(fx, { loaded: true })
  await assert.rejects(
    installLaunchdUnit(fx.facts, depsOf(fx, { launchctl: launchctl.run })),
    (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_UNIT_CONFLICT',
  )
  assert.equal(existsSync(plistPathOf(fx)), false, 'a loaded job whose source file is gone must not receive a new unproven plist')
})

test('install fails closed when the user GUI domain is unavailable', async t => {
  const fx = fixture(t)
  const run: LaunchctlRunner = async args => {
    if (args[0] === 'print' && args[1] === `gui/${String(UID)}`) return exited(112, '', 'Could not find domain')
    return exited(2)
  }
  await assert.rejects(
    installLaunchdUnit(fx.facts, depsOf(fx, { launchctl: run })),
    (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_ERROR',
  )
  assert.equal(existsSync(join(fx.accountHome, 'Library')), false, 'a manager-domain refusal writes nothing')
})

// ── start / stop / uninstall ownership ─────────────────────────────────────

test('start bootstraps then kickstarts exactly once and prepares private 0600 logs', async t => {
  const fx = fixture(t)
  const logs = launchdLogPaths(fx.facts.scopeDir)
  writeFileSync(logs.stdout, 'previous stdout\n', { mode: 0o600 })
  const launchctl = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: launchctl.run })
  const installed = await installLaunchdUnit(fx.facts, deps)
  const unit = ownedUnitOf(fx, deps)
  launchctl.calls.length = 0
  await startLaunchdService(fx.facts, unit, deps)
  assert.deepEqual(launchctl.calls, [
    ['print', `gui/${String(UID)}/${unit.label}`],
    ['bootstrap', `gui/${String(UID)}`, installed.filePath],
    ['print', `gui/${String(UID)}/${unit.label}`],
    ['kickstart', `gui/${String(UID)}/${unit.label}`],
  ])
  assert.equal(statSync(logs.stdout).mode & 0o777, 0o600)
  assert.equal(statSync(logs.stderr).mode & 0o777, 0o600)
  assert.equal(readFileSync(logs.stdout, 'utf8'), 'previous stdout\n', 'starting never truncates existing private logs')
})

test('start reuses a running job without bootstrap or kickstart', async t => {
  const fx = fixture(t)
  const launchctl = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: launchctl.run })
  await installLaunchdUnit(fx.facts, deps)
  launchctl.job.loaded = true
  launchctl.job.state = 'running'
  launchctl.job.pid = 4242
  const unit = ownedUnitOf(fx, deps)
  launchctl.calls.length = 0
  await startLaunchdService(fx.facts, unit, deps)
  assert.deepEqual(launchctl.calls, [['print', `gui/${String(UID)}/${unit.label}`]])
})

test('start refuses a loaded job whose fixed facts differ from the installed plist', async t => {
  const fx = fixture(t)
  const launchctl = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: launchctl.run })
  await installLaunchdUnit(fx.facts, deps)
  launchctl.job.loaded = true
  launchctl.job.state = 'not running'
  delete launchctl.job.pid
  launchctl.job.program = '/usr/bin/other'
  const unit = ownedUnitOf(fx, deps)
  launchctl.calls.length = 0
  await assert.rejects(
    startLaunchdService(fx.facts, unit, deps),
    (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_UNIT_CONFLICT',
  )
  assert.deepEqual(launchctl.calls, [['print', `gui/${String(UID)}/${unit.label}`]], 'a stale definition is never kickstarted')
})

test('start re-proves the plist identity after the async inspection and before bootstrap', async t => {
  const fx = fixture(t)
  const base = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: base.run })
  const installed = await installLaunchdUnit(fx.facts, deps)
  const unit = ownedUnitOf(fx, deps)
  const changed = `${readFileSync(installed.filePath, 'utf8')}\n<!-- changed during start inspection -->\n`
  let changedNow = false
  const launchctl: LaunchctlRunner = async args => {
    if (args[0] === 'print' && !changedNow) {
      changedNow = true
      writeFileSync(installed.filePath, changed, { mode: 0o600 })
    }
    return await base.run(args)
  }
  base.calls.length = 0
  await assert.rejects(
    startLaunchdService(fx.facts, unit, depsOf(fx, { launchctl })),
    (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_UNIT_CONFLICT',
  )
  assert.equal(base.calls.some(args => args[0] === 'bootstrap' || args[0] === 'kickstart'), false, 'a plist changed after inspection is never bootstrapped')
})

test('stop boots out only a matched job, verifies removal and never signals twice', async t => {
  const fx = fixture(t)
  const launchctl = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: launchctl.run })
  await installLaunchdUnit(fx.facts, deps)
  launchctl.job.loaded = true
  launchctl.job.state = 'running'
  launchctl.job.pid = 4242
  const unit = ownedUnitOf(fx, deps)
  launchctl.calls.length = 0
  const result = await stopLaunchdService(fx.facts, unit, { ...deps, sleep: async () => {}, now: () => 0 })
  assert.equal(result.stopped, true)
  assert.deepEqual(launchctl.calls, [
    ['print', `gui/${String(UID)}/${unit.label}`],
    ['bootout', `gui/${String(UID)}/${unit.label}`],
    ['print', `gui/${String(UID)}/${unit.label}`],
  ])
  launchctl.calls.length = 0
  const second = await stopLaunchdService(fx.facts, unit, deps)
  assert.equal(second.stopped, false)
  assert.deepEqual(launchctl.calls, [['print', `gui/${String(UID)}/${unit.label}`]], 'an already removed job is an idempotent no-op')
})

test('stop refuses to boot out a foreign or mismatched loaded job', async t => {
  const fx = fixture(t)
  const launchctl = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: launchctl.run })
  await installLaunchdUnit(fx.facts, deps)
  launchctl.job.loaded = true
  launchctl.job.state = 'running'
  launchctl.job.pid = 4242
  launchctl.job.environment = { DSH_HOME: '/other', SPLIT_PROCESS_DSH_ANCHOR: '/other', SPLIT_PROCESS_PROFILE: 'other' }
  const unit = ownedUnitOf(fx, deps)
  launchctl.calls.length = 0
  await assert.rejects(
    stopLaunchdService(fx.facts, unit, deps),
    (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_UNIT_CONFLICT',
  )
  assert.equal(launchctl.calls.some(args => args[0] === 'bootout'), false, 'a mismatched job is never booted out')
})

test('stop refuses a loaded job whose real PID changed before bootout', async t => {
  const fx = fixture(t)
  const launchctl = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: launchctl.run })
  await installLaunchdUnit(fx.facts, deps)
  launchctl.job.loaded = true
  launchctl.job.state = 'running'
  launchctl.job.pid = 4242
  const unit = ownedUnitOf(fx, deps)
  launchctl.calls.length = 0
  await assert.rejects(
    stopLaunchdService(fx.facts, unit, { ...deps, sleep: async () => {}, now: () => 0 }, 5151),
    (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_UNIT_CONFLICT',
  )
  assert.deepEqual(launchctl.calls, [['print', `gui/${String(UID)}/${unit.label}`]], 'a changed real PID is never booted out')
})

test('stop re-proves the plist identity after the async inspection and before bootout', async t => {
  const fx = fixture(t)
  const base = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: base.run })
  const installed = await installLaunchdUnit(fx.facts, deps)
  base.job.loaded = true
  base.job.state = 'running'
  base.job.pid = 4242
  const unit = ownedUnitOf(fx, deps)
  const changed = `${readFileSync(installed.filePath, 'utf8')}\n<!-- changed during stop inspection -->\n`
  let changedNow = false
  const launchctl: LaunchctlRunner = async args => {
    if (args[0] === 'print' && !changedNow) {
      changedNow = true
      writeFileSync(installed.filePath, changed, { mode: 0o600 })
    }
    return await base.run(args)
  }
  base.calls.length = 0
  await assert.rejects(
    stopLaunchdService(fx.facts, unit, depsOf(fx, { launchctl, sleep: async () => {}, now: () => 0 }), 4242),
    (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_UNIT_CONFLICT',
  )
  assert.equal(base.calls.some(args => args[0] === 'bootout'), false, 'a plist changed after inspection is never booted out')
})

test('uninstall removes only the verified plist and leaves the private logs', async t => {
  const fx = fixture(t)
  const launchctl = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: launchctl.run })
  const installed = await installLaunchdUnit(fx.facts, deps)
  launchctl.job.loaded = true
  launchctl.job.state = 'running'
  launchctl.job.pid = 4242
  const logs = launchdLogPaths(fx.facts.scopeDir)
  writeFileSync(logs.stdout, 'stdout retained\n', { mode: 0o600 })
  writeFileSync(logs.stderr, 'stderr retained\n', { mode: 0o600 })
  const unit = ownedUnitOf(fx, deps)
  launchctl.calls.length = 0
  await uninstallLaunchdUnit(fx.facts, unit, { ...deps, sleep: async () => {}, now: () => 0 })
  assert.equal(existsSync(installed.filePath), false)
  assert.equal(launchctl.calls.some(args => args[0] === 'bootout'), true)
  assert.equal(readFileSync(logs.stdout, 'utf8'), 'stdout retained\n')
  assert.equal(readFileSync(logs.stderr, 'utf8'), 'stderr retained\n')
})

test('uninstall refuses a plist whose captured identity changed and keeps the file', async t => {
  const fx = fixture(t)
  const launchctl = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: launchctl.run })
  const installed = await installLaunchdUnit(fx.facts, deps)
  const unit = ownedUnitOf(fx, deps)
  writeFileSync(installed.filePath, `${readFileSync(installed.filePath, 'utf8')}\n<!-- changed -->\n`, { mode: 0o600 })
  await assert.rejects(
    uninstallLaunchdUnit(fx.facts, unit, deps),
    (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_UNIT_CONFLICT',
  )
  assert.equal(existsSync(installed.filePath), true, 'a changed plist is never removed')
})

test('uninstall re-proves the plist identity after inspection and before any bootout', async t => {
  const fx = fixture(t)
  const base = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: base.run })
  const installed = await installLaunchdUnit(fx.facts, deps)
  base.job.loaded = true
  base.job.state = 'running'
  base.job.pid = 4242
  const unit = ownedUnitOf(fx, deps)
  const changed = `${readFileSync(installed.filePath, 'utf8')}\n<!-- changed during uninstall inspection -->\n`
  let changedNow = false
  const launchctl: LaunchctlRunner = async args => {
    if (args[0] === 'print' && !changedNow) {
      changedNow = true
      writeFileSync(installed.filePath, changed, { mode: 0o600 })
    }
    return await base.run(args)
  }
  base.calls.length = 0
  await assert.rejects(
    uninstallLaunchdUnit(fx.facts, unit, depsOf(fx, { launchctl, sleep: async () => {}, now: () => 0 }), 4242),
    (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_UNIT_CONFLICT',
  )
  assert.equal(base.calls.some(args => args[0] === 'bootout'), false, 'a changed plist is never booted out first')
  assert.equal(existsSync(installed.filePath), true)
  assert.equal(readFileSync(installed.filePath, 'utf8'), changed)
})

test('uninstall refuses a loaded job that becomes running with a different PID before bootout', async t => {
  const fx = fixture(t)
  const base = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: base.run })
  const installed = await installLaunchdUnit(fx.facts, deps)
  base.job.loaded = true
  base.job.state = 'not running'
  delete base.job.pid
  const unit = ownedUnitOf(fx, deps)
  let labelPrints = 0
  const launchctl: LaunchctlRunner = async args => {
    if (args[0] === 'print' && args[1] === `gui/${String(UID)}/${unit.label}`) {
      labelPrints += 1
      // Uninstall's own inspection is print #1; the stop path's re-inspection
      // is print #2. An external kickstart makes the job running only there.
      if (labelPrints === 2) {
        base.job.state = 'running'
        base.job.pid = 5151
      }
    }
    return await base.run(args)
  }
  base.calls.length = 0
  await assert.rejects(
    uninstallLaunchdUnit(fx.facts, unit, depsOf(fx, { launchctl, sleep: async () => {}, now: () => 0 }), 4242),
    (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_MANAGER_UNIT_CONFLICT',
  )
  assert.equal(base.calls.some(args => args[0] === 'bootout'), false, 'a job that became running with another PID is never booted out')
  assert.equal(existsSync(installed.filePath), true, 'a refused uninstall keeps the plist')
})

// ── the public-start wiring ────────────────────────────────────────────────

test('a public managed start uses the installed LaunchAgent instead of the detached process', { skip: process.platform !== 'darwin' ? 'the launchd public-start route requires macOS' : false }, async t => {
  const fx = fixture(t)
  const launchctl = fakeLaunchctl(fx, { loaded: false })
  const deps = depsOf(fx, { launchctl: launchctl.run })
  await installLaunchdUnit(fx.facts, deps)
  const scope = scopeFromInstalledProfile({
    dshHome: fx.dshHome,
    profileDir: fx.profileDir,
    packageRoot: fx.packageRoot,
    dshVersion: DSH_VERSION,
  })
  launchctl.calls.length = 0
  // A public cold start must dispatch the verified plist through launchd; it
  // must never fall back to spawning a detached Host beside the installed job.
  const observation = await startManagedHostCandidate(
    {
      scope,
      hostEntryPath: join(fx.packageRoot, 'dist', 'local-host.mjs'),
      dshAnchor: realpathSync(fx.anchor),
      profile: 'pi-tui',
      hostStartPolicy: 'public',
    },
    { launchd: deps },
  )
  assert.equal(observation(), undefined)
  assert.deepEqual(launchctl.calls, [
    ['print', `gui/${String(UID)}/${buildLaunchdLabel(scope.scopeId)}`],
    ['bootstrap', `gui/${String(UID)}`, plistPathOf(fx)],
    ['print', `gui/${String(UID)}/${buildLaunchdLabel(scope.scopeId)}`],
    ['kickstart', `gui/${String(UID)}/${buildLaunchdLabel(scope.scopeId)}`],
  ])
  assert.equal(existsSync(join(scope.dir, 'host.log')), false, 'the managed public start must never spawn the detached Host fallback')
})

// ── native launchd (macOS only) ────────────────────────────────────────────

/** A real GUI domain is required for the native lifecycle; otherwise the test
 *  is BLOCKED_ENV and never fabricates a PASS. */
function nativeDomainAvailable(): boolean {
  if (process.platform !== 'darwin') return false
  const outcome = spawnSync('/bin/launchctl', ['print', `gui/${String(UID)}`], { encoding: 'utf8', timeout: 10_000 })
  return outcome.status === 0
}

test('native launchd bootstrap/kickstart/bootout runs the real foreground entry', { skip: process.platform !== 'darwin' ? 'the native launchd lifecycle requires macOS' : (nativeDomainAvailable() ? false : 'BLOCKED_ENV: the user GUI launchd domain is unavailable') }, async t => {
  const fx = fixture(t)
  const marker = join(fx.root, 'native-child.marker')
  const child = join(fx.root, 'native-child.mjs')
  writeFileSync(child, [
    "import { appendFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(marker)}, String(process.pid) + '\\n', { mode: 0o600 })`,
    "process.stdout.write('native-child stdout\\n')",
    "process.stderr.write('native-child stderr\\n')",
    'setInterval(() => {}, 60_000)',
    '',
  ].join('\n'), { mode: 0o600 })
  const facts: LaunchdUnitFacts = { ...fx.facts, hostEntryPath: child }
  const deps = depsOf(fx)
  let cleanupPid: number | undefined
  t.after(async () => {
    // Only this test's private label and process are cleaned up.
    try {
      const inspected = inspectOwnedLaunchdUnit(facts, deps)
      if (inspected.kind === 'owned') {
        // Real bounded timers for native cleanup: a removed job settles on the
        // first observation, and a genuinely stuck job fails within the window.
        await stopLaunchdService(facts, inspected.unit, deps)
        unlinkSync(inspected.unit.filePath)
      }
    } catch { /* already removed or never loaded */ }
    if (cleanupPid !== undefined) {
      try { process.kill(cleanupPid, 'SIGKILL') } catch { /* already gone */ }
    }
  })
  const installed = await installLaunchdUnit(facts, deps)
  assert.equal(installed.created, true)
  const unit = ownedUnitOf(fx, deps)
  await startLaunchdService(facts, unit, deps)
  const deadline = Date.now() + 15_000
  let pid: number | undefined
  while (Date.now() < deadline) {
    if (existsSync(marker)) {
      const lines = readFileSync(marker, 'utf8').split('\n').filter(line => line !== '')
      if (lines.length > 0) { pid = Number(lines[0]); break }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(pid !== undefined && Number.isSafeInteger(pid) && pid > 0, 'the launchd job never started the foreground child')
  cleanupPid = pid
  const observed = await inspectLaunchdService(unit, deps)
  assert.equal(observed.kind, 'loaded')
  assert.equal(observed.kind === 'loaded' ? observed.service.pid : undefined, pid)
  assert.equal(launchdServiceMatches(facts, unit, (observed as { readonly kind: 'loaded'; readonly service: LaunchdLoadedService }).service), true)
  const logs = launchdLogPaths(facts.scopeDir)
  assert.equal(statSync(logs.stdout).mode & 0o777, 0o600)
  assert.equal(statSync(logs.stderr).mode & 0o777, 0o600)
  await stopLaunchdService(facts, unit, deps)
  const goneDeadline = Date.now() + 10_000
  while (Date.now() < goneDeadline) {
    try { process.kill(pid as number, 0) } catch { break }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.throws(() => process.kill(pid as number, 0), 'the booted-out child process must really exit')
  assert.equal((await inspectLaunchdService(unit, deps)).kind, 'not-loaded')
  await uninstallLaunchdUnit(facts, unit, deps)
  assert.equal(existsSync(installed.filePath), false)
})
