/**
 * M6-2B managed Host manager contracts.
 *
 * These are L1-L3 unit tests for the ONE Host-process management boundary: the
 * three-state user-manager classifier, the profile unit name/content encoder
 * (including the real `systemd-analyze` parser check), the atomic owner-checked
 * unit install, and the managed-start orchestration (strict-absence process
 * fallback, error propagation and the available-manager unit path). A real
 * systemd user-manager L6 run lives in the split-process smoke, not here.
 *
 * @module @xmoon76/dsh-pi-tui/m6-2b-managed-host.test
 */

import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { LocalScopeError, scopeFromInstalledProfile, type LocalScope } from '../../src/app/remote-process/local-scope.ts'
import {
  buildUnitName,
  classifyUserManagerProbe,
  encodeUnitPath,
  encodeUnitValue,
  ensureOwnedUnitDir,
  installProfileUnit,
  inspectTrustedExecutable,
  probeUserManager,
  profileIdentityDigest,
  profileUnitSlug,
  renderUnitContent,
  startManagedHostCandidate,
  type SystemctlResult,
  type UnitFacts,
  type UserManagerProbe,
  type UserManagerProbeFacts,
} from '../../src/app/remote-process/local-host-manager.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DSH_VERSION = '0.2.2-rc.3'

function exited(code: number, stdout = '', stderr = ''): SystemctlResult {
  return { kind: 'exited', code, stdout, stderr }
}

function probeFacts(overrides: Partial<UserManagerProbeFacts> = {}): UserManagerProbeFacts {
  return {
    systemctl: exited(1, '', 'Failed to connect to bus: No such file or directory'),
    managerPrivatePresent: false,
    userBusPresent: false,
    systemdUserServiceState: 'inactive',
    ...overrides,
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof LocalScopeError && error.code === code
}

// ── The three-state classifier ──────────────────────────────────────────────

test('a successful show-environment request classifies the user manager as available', () => {
  assert.deepEqual(classifyUserManagerProbe(probeFacts({ systemctl: exited(0, 'HOME=/home/u\n') })), { kind: 'available' })
})

test('an explicit no-user-bus with absent endpoints and an inactive user service is a strict absence', () => {
  assert.deepEqual(classifyUserManagerProbe(probeFacts()), { kind: 'absent' })
  const notFound = probeFacts({ systemctl: exited(1, '', 'Failed to connect to bus: No such file or directory') })
  assert.deepEqual(classifyUserManagerProbe(notFound), { kind: 'absent' })
})

test('a present but refusing manager is an error, never an absence', () => {
  const result = classifyUserManagerProbe(probeFacts({
    systemctl: exited(1, '', 'Failed to connect to bus: Connection refused'),
    userBusPresent: true,
  }))
  assert.equal(result.kind, 'error')
})

test('a no-bus error is an error when a live manager endpoint still exists', () => {
  assert.equal(classifyUserManagerProbe(probeFacts({ managerPrivatePresent: true })).kind, 'error')
  assert.equal(classifyUserManagerProbe(probeFacts({ userBusPresent: true })).kind, 'error')
})

test('a no-bus error is an error when the system manager reports an active user service', () => {
  assert.equal(classifyUserManagerProbe(probeFacts({ systemdUserServiceState: 'active' })).kind, 'error')
})

test('a no-bus error is an error when the user service state cannot be confirmed', () => {
  assert.equal(classifyUserManagerProbe(probeFacts({ systemdUserServiceState: 'unknown' })).kind, 'error')
})

test('a probe timeout or output overflow is a stable error, not an absence', () => {
  assert.equal(classifyUserManagerProbe(probeFacts({ systemctl: { kind: 'timeout' } })).kind, 'error')
  assert.equal(classifyUserManagerProbe(probeFacts({ systemctl: { kind: 'output-overflow' } })).kind, 'error')
})

test('a permission-denied or generic non-zero failure is an error, never an absence', () => {
  assert.equal(classifyUserManagerProbe(probeFacts({ systemctl: exited(1, '', 'Access denied') })).kind, 'error')
  assert.equal(classifyUserManagerProbe(probeFacts({ systemctl: exited(1, '', 'Failed: something else') })).kind, 'error')
})

test('a missing systemctl executable is absent only when the channel is corroborated absent', () => {
  const spawnError: SystemctlResult = { kind: 'spawn-error', error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  assert.deepEqual(classifyUserManagerProbe(probeFacts({ systemctl: spawnError })), { kind: 'absent' })
  assert.equal(classifyUserManagerProbe(probeFacts({ systemctl: spawnError, userBusPresent: true })).kind, 'error')
})

test('a probe error reason never leaks an absolute private path', () => {
  const result = classifyUserManagerProbe(probeFacts({
    systemctl: exited(1, '', '/home/secret/private: permission denied'),
    systemdUserServiceState: 'unknown',
  }))
  assert.equal(result.kind, 'error')
  assert.doesNotMatch((result as { reason: string }).reason, /\/home\/secret/u)
})

test('a missing systemctl binary with no live endpoint is an absent manager even without a system state', () => {
  const enoent: SystemctlResult = { kind: 'spawn-error', error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  assert.deepEqual(classifyUserManagerProbe(probeFacts({ systemctl: enoent, systemdUserServiceState: 'unknown' })), { kind: 'absent' })
  assert.equal(classifyUserManagerProbe(probeFacts({ systemctl: enoent, systemdUserServiceState: 'unknown', userBusPresent: true })).kind, 'error')
})

test('systemd not being the init system with no live endpoint is a definitive absence', () => {
  const init = exited(1, '', 'System has not been booted with systemd as init system (PID 1). Can\'t operate.')
  assert.deepEqual(classifyUserManagerProbe(probeFacts({ systemctl: init, systemdUserServiceState: 'unknown' })), { kind: 'absent' })
})

test('a user-scope-bus refusal or permission error is never treated as absence', () => {
  assert.equal(classifyUserManagerProbe(probeFacts({ systemctl: exited(1, '', 'Failed to connect to user scope bus: Permission denied') })).kind, 'error')
  assert.equal(classifyUserManagerProbe(probeFacts({ systemctl: exited(1, '', 'Failed to connect to user scope bus: Connection refused') })).kind, 'error')
})

test('the two-step probe classifies a genuinely absent (no systemctl) host as absent', async () => {
  const enoent: SystemctlResult = { kind: 'spawn-error', error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  const result = await probeUserManager({ systemctl: async () => enoent, pathExists: () => false })
  assert.deepEqual(result, { kind: 'absent' })
})

test('the two-step probe reports available on a successful show-environment', async () => {
  const result = await probeUserManager({
    systemctl: async args => (args.includes('show-environment') ? exited(0, 'HOME=/home/u\n') : exited(1)),
    pathExists: () => true,
  })
  assert.deepEqual(result, { kind: 'available' })
})

// ── Unit naming ──────────────────────────────────────────────────────────────

test('the profile slug is ASCII-safe, bounded, and never empty or leading-unsafe', () => {
  assert.equal(profileUnitSlug('pi-tui'), 'pi-tui')
  assert.equal(profileUnitSlug(''), 'profile')
  assert.equal(profileUnitSlug('9abc'), '9abc')
  assert.equal(profileUnitSlug('-abc'), 'p-abc')
  assert.equal(profileUnitSlug('üñî'), 'p___')
  assert.equal(profileUnitSlug('a/b c'), 'a_b_c')
  assert.equal(profileUnitSlug('a'.repeat(40)).length, 32)
  // Boundary: a 32-char unsafe-leading slug is normalized FIRST, then bounded,
  // so it never grows past the fixed 32-character limit.
  const unsafeLeading = profileUnitSlug('-'.repeat(32))
  assert.equal(unsafeLeading.length, 32, 'the prefixed slug must still be bounded to 32 characters')
  assert.equal(unsafeLeading[0], 'p', 'the leading character must be normalized before the bound')
  assert.equal(profileUnitSlug('a'.repeat(32)), 'a'.repeat(32))
})

test('the unit name uses the slug plus a bounded scope prefix, not the whole scope id', () => {
  const scopeId = 'a'.repeat(64)
  assert.equal(buildUnitName('pi-tui', scopeId), `dsh-pi-tui@pi-tui-${'a'.repeat(16)}.service`)
  // Two different full scope ids sharing one 16-hex prefix collide on the NAME;
  // ownership is decided by the file bytes (full scopeId), never the name.
  assert.equal(buildUnitName('pi-tui', `${'a'.repeat(16)}${'b'.repeat(48)}`), buildUnitName('pi-tui', `${'a'.repeat(16)}${'c'.repeat(48)}`))
})

// ── Unit content encoding ────────────────────────────────────────────────────

function unitFacts(overrides: Partial<UnitFacts> = {}): UnitFacts {
  return {
    dshHome: '/home/u/.dsh',
    profileRealpath: '/home/u/.dsh/profiles/pi-tui',
    profile: 'pi-tui',
    scopeId: 'a'.repeat(64),
    buildId: 'b'.repeat(64),
    nodePath: '/usr/bin/node',
    hostEntryPath: '/opt/pkg/dist/local-host.mjs',
    dshAnchor: '/opt/dsh/package.json',
    ...overrides,
  }
}

test('ExecStart escapes dollar, percent, quote and backslash; Environment keeps a literal dollar', () => {
  assert.equal(encodeUnitValue('a $b %c "d" \\e', 'x', true), '"a $$b %%c \\"d\\" \\\\e"')
  assert.equal(encodeUnitValue('a $b %c "d" \\e', 'x', false), '"a $b %%c \\"d\\" \\\\e"')
  // WorkingDirectory is a raw path: no surrounding quotes, specifier/backslash escaped.
  assert.equal(encodeUnitPath('/a b/%c/\\d$e', 'wd'), '/a b/%%c/\\\\d$e')
  assert.throws(() => encodeUnitPath('/a"b', 'wd'), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
})

test('a control character or newline in a unit value fails closed', () => {
  assert.throws(() => renderUnitContent(unitFacts({ profileRealpath: '/a\nb' })), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
  assert.throws(() => renderUnitContent(unitFacts({ dshHome: '/a\tb' })), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
  assert.throws(() => renderUnitContent(unitFacts({ profile: 'a\u0000b' })), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
})

test('the unit carries only owner metadata and the minimal startup facts, with no secret or enable', () => {
  const content = renderUnitContent(unitFacts())
  assert.match(content, /^X-DshPiTuiOwner=local-host-manager-v1$/mu)
  assert.match(content, new RegExp(`^X-DshPiTuiScopeId=${'a'.repeat(64)}$`, 'mu'))
  assert.match(content, new RegExp(`^X-DshPiTuiProfileIdentity=${profileIdentityDigest('/home/u/.dsh/profiles/pi-tui')}$`, 'mu'))
  assert.match(content, new RegExp(`^X-DshPiTuiInstallBuild=${'b'.repeat(64)}$`, 'mu'))
  assert.match(content, /^WorkingDirectory=\/home\/u\/\.dsh\/profiles\/pi-tui$/mu)
  assert.match(content, /^Environment="DSH_HOME=\/home\/u\/\.dsh"$/mu)
  assert.match(content, /^Environment="SPLIT_PROCESS_DSH_ANCHOR=\/opt\/dsh\/package\.json"$/mu)
  assert.match(content, /^Environment="SPLIT_PROCESS_PROFILE=pi-tui"$/mu)
  assert.match(content, /^Type=exec$/mu)
  assert.match(content, /^Restart=on-failure$/mu)
  for (const forbidden of ['WantedBy', 'enable', 'DSH_PI_TUI_BACKEND', 'SPLIT_PROCESS_EXTRA_PATCH', 'EnvironmentFile', 'Type=notify', 'ExecStop', 'token', 'cookie']) {
    assert.equal(content.includes(forbidden), false, `the unit must not carry ${forbidden}`)
  }
})

function hasSystemdAnalyze(): boolean {
  try {
    execFileSync('systemd-analyze', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('the real systemd parser accepts the rendered unit with space, percent, dollar, backslash and non-ASCII paths', t => {
  if (!hasSystemdAnalyze()) {
    t.skip('systemd-analyze is unavailable on this host')
    return
  }
  const root = testLifecycle(t).tempDir('m62b-verify-')
  const entry = join(root, 'local-host.mjs')
  writeFileSync(entry, 'process.exit(0)\n')
  const anchor = join(root, 'dsh-package.json')
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_VERSION }))
  for (const [label, sub] of [
    ['normal', 'wd_normal'],
    ['space', 'weird one'],
    ['percent', 'weird%one'],
    ['dollar', 'weird$one'],
    ['backslash', 'weird\\one'],
    ['nonascii', 'weirdünï'],
  ] as const) {
    const path = join(root, sub)
    mkdirSync(path, { recursive: true })
    const unitPath = join(root, `verify-${label}.service`)
    writeFileSync(unitPath, renderUnitContent(unitFacts({
      dshHome: path,
      profileRealpath: path,
      nodePath: process.execPath,
      hostEntryPath: entry,
      dshAnchor: anchor,
    })))
    assert.doesNotThrow(
      () => execFileSync('systemd-analyze', ['verify', '--man=no', unitPath], { stdio: 'pipe' }),
      `systemd-analyze rejected the ${label} path encoding`,
    )
  }
})

// ── Installed-fact trust and directory permission ────────────────────────────

test('the node interpreter is trusted by executability, not by uid ownership', t => {
  const uid = process.getuid?.()
  // A root-owned system executable must be accepted for the node interpreter.
  const candidate = ['/usr/bin/systemctl', '/bin/sh', '/usr/bin/env', '/bin/ls'].find(probe => {
    try {
      const real = realpathSync(probe)
      const info = lstatSync(real)
      return info.isFile() && (info.mode & 0o111) !== 0 && info.uid !== uid
    } catch {
      return false
    }
  })
  if (candidate === undefined) {
    t.skip('no root-owned system executable is available on this host')
    return
  }
  assert.doesNotThrow(() => inspectTrustedExecutable(candidate, 'node executable'), 'a root-owned executable must be accepted')
  const dir = testLifecycle(t).tempDir('m62b-trust-')
  const nonExec = join(dir, 'plain-file')
  writeFileSync(nonExec, 'x')
  assert.equal(lstatSync(nonExec).mode & 0o111, 0, 'the probe file must not be executable')
  assert.throws(() => inspectTrustedExecutable(nonExec, 'node executable'), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
  assert.throws(() => inspectTrustedExecutable(dir, 'node executable'), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
})

test('a group/other-writable unit directory is refused while a 0700 chain is accepted', t => {
  const uid = process.getuid?.() as number
  const good = testLifecycle(t).tempDir('m62b-home-good-')
  assert.doesNotThrow(() => ensureOwnedUnitDir(good, uid))
  const bad = testLifecycle(t).tempDir('m62b-home-bad-')
  mkdirSync(join(bad, '.config'), { mode: 0o700 })
  chmodSync(join(bad, '.config'), 0o770)
  assert.throws(() => ensureOwnedUnitDir(bad, uid), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
})

// ── Atomic owner-checked installation ───────────────────────────────────────

function unitDirFor(t: TestContext): string {
  return testLifecycle(t).tempDir('m62b-unit-')
}

test('a first install creates a 0600 unit and an identical second install converges', t => {
  const dir = unitDirFor(t)
  const uid = process.getuid?.() as number
  const first = installProfileUnit({ unitDir: dir, unitName: 'dsh-pi-tui@pi-tui-aaaaaaaaaaaaaaaa.service', content: 'hello\n', uid })
  assert.equal(first.created, true)
  const finalPath = join(dir, 'dsh-pi-tui@pi-tui-aaaaaaaaaaaaaaaa.service')
  assert.equal(lstatSync(finalPath).mode & 0o777, 0o600)
  assert.equal(readFileSync(finalPath, 'utf8'), 'hello\n')
  const second = installProfileUnit({ unitDir: dir, unitName: 'dsh-pi-tui@pi-tui-aaaaaaaaaaaaaaaa.service', content: 'hello\n', uid })
  assert.equal(second.created, false)
})

test('a pre-existing unit with different content is a conflict and is never overwritten', t => {
  const dir = unitDirFor(t)
  const uid = process.getuid?.() as number
  const name = 'dsh-pi-tui@pi-tui-aaaaaaaaaaaaaaaa.service'
  installProfileUnit({ unitDir: dir, unitName: name, content: 'old-build\n', uid })
  assert.throws(
    () => installProfileUnit({ unitDir: dir, unitName: name, content: 'new-build\n', uid }),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'),
  )
  assert.equal(readFileSync(join(dir, name), 'utf8'), 'old-build\n')
})

test('a symlinked or wrongly-permissioned target unit is refused', t => {
  const dir = unitDirFor(t)
  const uid = process.getuid?.() as number
  const name = 'dsh-pi-tui@pi-tui-bbbbbbbbbbbbbbbb.service'
  const target = join(dir, 'elsewhere')
  writeFileSync(target, 'x', { mode: 0o600 })
  symlinkSync(target, join(dir, name))
  assert.throws(
    () => installProfileUnit({ unitDir: dir, unitName: name, content: 'x', uid }),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'),
  )
  // A real but wrongly-permissioned file is refused too.
  const name2 = 'dsh-pi-tui@pi-tui-cccccccccccccccc.service'
  writeFileSync(join(dir, name2), 'x', { mode: 0o644 })
  chmodSync(join(dir, name2), 0o644)
  assert.throws(
    () => installProfileUnit({ unitDir: dir, unitName: name2, content: 'x', uid }),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'),
  )
})

test('concurrent identical installs converge to exactly one creator and one intact file', async t => {
  const dir = unitDirFor(t)
  const uid = process.getuid?.() as number
  const name = 'dsh-pi-tui@pi-tui-dddddddddddddddd.service'
  const content = renderUnitContent(unitFacts())
  const moduleUrl = pathToFileURL(join(ROOT, 'src', 'app', 'remote-process', 'local-host-manager.ts')).href
  const childPath = join(dir, 'concurrent-caller.mts')
  writeFileSync(childPath, [
    `import { installProfileUnit } from ${JSON.stringify(moduleUrl)}`,
    `try {`,
    `  const r = installProfileUnit({ unitDir: ${JSON.stringify(dir)}, unitName: ${JSON.stringify(name)}, content: ${JSON.stringify(content)}, uid: ${uid} })`,
    `  console.log(JSON.stringify({ created: r.created }))`,
    `} catch (error) {`,
    `  console.log(JSON.stringify({ created: false, error: error?.code ?? error?.message }))`,
    `}`,
    '',
  ].join('\n'))
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, ['--import', 'tsx/esm', childPath], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
  const results = await Promise.all(children.map(child => new Promise<{ created: boolean }>((resolveChild, rejectChild) => {
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => {
      if (code !== 0) {
        rejectChild(new Error(`concurrent install child exited ${String(code)}: ${stderr.slice(-2000)}`))
        return
      }
      const lines = stdout.trim().split('\n').filter(Boolean)
      try {
        resolveChild(JSON.parse(lines[lines.length - 1] ?? '{}') as { created: boolean })
      } catch (error) {
        rejectChild(new Error(`concurrent install child produced invalid JSON: ${stdout.slice(-1000)}`, { cause: error }))
      }
    })
  })))
  assert.equal(results.filter(r => r.created).length, 1, `exactly one concurrent install must create the unit: ${JSON.stringify(results)}`)
  assert.equal(readFileSync(join(dir, name), 'utf8'), content, 'the winning unit must be byte-identical to the rendered content')
})

// ── Managed-start orchestration ──────────────────────────────────────────────

interface ManagedFixture {
  readonly scope: LocalScope
  readonly entry: string
  readonly anchor: string
  readonly markerPath: string
}

function managedFixture(t: TestContext): ManagedFixture {
  const root = testLifecycle(t).tempDir('m62b-managed-')
  const home = join(root, 'dsh-home')
  const profile = join(root, 'profiles', 'pi-tui')
  const packageRoot = join(root, 'package')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  mkdirSync(join(packageRoot, 'dist'), { recursive: true, mode: 0o700 })
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version: '0.5.7' })}\n`)
  writeFileSync(join(packageRoot, 'dist', 'index.mjs'), 'export const value = 1\n')
  const markerPath = join(root, 'spawned.marker')
  writeFileSync(join(packageRoot, 'dist', 'local-host.mjs'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(markerPath)}, 'spawned')\n`)
  const anchorDir = join(root, 'dsh')
  mkdirSync(anchorDir, { recursive: true })
  const anchor = join(anchorDir, 'package.json')
  writeFileSync(anchor, `${JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_VERSION })}\n`)
  const scope = scopeFromInstalledProfile({ dshHome: home, profileDir: profile, packageRoot, dshVersion: DSH_VERSION })
  return { scope, entry: join(packageRoot, 'dist', 'local-host.mjs'), anchor, markerPath }
}

/** A fake `systemctl` that emulates one acceptable managed-host start. */
function fakeSystemctl(finalPath: string) {
  let loaded = false
  const calls: string[] = []
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    calls.push(args.join(' '))
    if (args.includes('daemon-reload')) {
      loaded = true
      return exited(0)
    }
    if (args.includes('show')) {
      const body = loaded
        ? `LoadState=loaded\nActiveState=inactive\nFragmentPath=${finalPath}\nDropInPaths=\n`
        : 'LoadState=not-found\nActiveState=inactive\nFragmentPath=\nDropInPaths=\n'
      return exited(0, body)
    }
    return exited(0)
  }
  return { run, calls, get loaded() { return loaded } }
}

test('a probe error propagates as HOST_MANAGER_ERROR and never falls back', async t => {
  const fx = managedFixture(t)
  await assert.rejects(
    startManagedHostCandidate(
      { scope: fx.scope, hostEntryPath: fx.entry, dshAnchor: fx.anchor, profile: 'pi-tui' },
      { probe: async (): Promise<UserManagerProbe> => ({ kind: 'error', reason: 'boom' }) },
    ),
    error => isCode(error, 'HOST_MANAGER_ERROR'),
  )
})

test('a strict absence falls back to the detached process spawn and creates no unit', async t => {
  const fx = managedFixture(t)
  const emptyUnitDir = testLifecycle(t).tempDir('m62b-should-stay-empty-')
  const observation = await startManagedHostCandidate(
    { scope: fx.scope, hostEntryPath: fx.entry, dshAnchor: fx.anchor, profile: 'pi-tui' },
    {
      probe: async (): Promise<UserManagerProbe> => ({ kind: 'absent' }),
      unitDir: () => emptyUnitDir,
      systemctl: async () => exited(0),
    },
  )
  assert.equal(observation(), undefined)
  const deadline = Date.now() + 10_000
  while (!existsSync(fx.markerPath) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(existsSync(fx.markerPath), true, 'the detached fallback must have spawned the Host entry')
  assert.deepEqual(readdirSync(emptyUnitDir), [], 'an absence must not install any unit')
})

test('an absence with a missing Host entry surfaces the process-start failure, not a unit', async t => {
  const fx = managedFixture(t)
  await assert.rejects(
    startManagedHostCandidate(
      { scope: fx.scope, hostEntryPath: join(dirname(fx.entry), 'missing-host.mjs'), dshAnchor: fx.anchor, profile: 'pi-tui' },
      { probe: async (): Promise<UserManagerProbe> => ({ kind: 'absent' }), unitDir: () => testLifecycle(t).tempDir('m62b-x-'), systemctl: async () => exited(0) },
    ),
    error => isCode(error, 'HOST_START_FAILED'),
  )
})

test('an available manager installs, verifies FragmentPath/LoadState and starts the unit once', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-avail-')
  const unitName = buildUnitName('pi-tui', fx.scope.scopeId)
  const finalPath = join(unitDir, unitName)
  const fake = fakeSystemctl(finalPath)
  const observation = await startManagedHostCandidate(
    { scope: fx.scope, hostEntryPath: fx.entry, dshAnchor: fx.anchor, profile: 'pi-tui' },
    {
      probe: async (): Promise<UserManagerProbe> => ({ kind: 'available' }),
      unitDir: () => unitDir,
      systemctl: fake.run,
    },
  )
  assert.equal(observation(), undefined)
  assert.equal(existsSync(finalPath), true, 'the managed path must have installed the unit file')
  assert.match(readFileSync(finalPath, 'utf8'), new RegExp(`^X-DshPiTuiScopeId=${fx.scope.scopeId}$`, 'mu'))
  assert.ok(fake.calls.some(call => call.includes('daemon-reload')), 'a new unit install must reload the manager')
  assert.ok(fake.calls.some(call => call.includes('start')), 'the managed path must start the unit')
})

test('a manager reporting a different FragmentPath is a unit conflict', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-conflict-')
  const otherFile = fx.anchor
  const systemctl = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('daemon-reload')) return exited(0)
    if (args.includes('show')) return exited(0, `LoadState=loaded\nActiveState=inactive\nFragmentPath=${otherFile}\nDropInPaths=\n`)
    return exited(0)
  }
  await assert.rejects(
    startManagedHostCandidate(
      { scope: fx.scope, hostEntryPath: fx.entry, dshAnchor: fx.anchor, profile: 'pi-tui' },
      { probe: async (): Promise<UserManagerProbe> => ({ kind: 'available' }), unitDir: () => unitDir, systemctl },
    ),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'),
  )
})

test('a loaded drop-in override is a unit conflict even when the FragmentPath is our file', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-dropin-')
  const finalPath = join(unitDir, buildUnitName('pi-tui', fx.scope.scopeId))
  const fake = fakeSystemctl(finalPath)
  const withDropIn = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('show')) {
      // Our owned file is the FragmentPath, but a same-named drop-in would
      // override ExecStart/Environment/Restart — this must fail closed.
      return exited(0, `LoadState=loaded\nActiveState=inactive\nFragmentPath=${finalPath}\nDropInPaths=/etc/systemd/user/${buildUnitName('pi-tui', fx.scope.scopeId)}.d/override.conf\n`)
    }
    return fake.run(args)
  }
  await assert.rejects(
    startManagedHostCandidate(
      { scope: fx.scope, hostEntryPath: fx.entry, dshAnchor: fx.anchor, profile: 'pi-tui' },
      { probe: async (): Promise<UserManagerProbe> => ({ kind: 'available' }), unitDir: () => unitDir, systemctl: withDropIn },
    ),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'),
  )
})

test('a failed daemon-reload or start is HOST_MANAGER_START_FAILED, never a fallback', async t => {
  const fx = managedFixture(t)
  const reloadDir = testLifecycle(t).tempDir('m62b-reload-')
  const reloadFinal = join(reloadDir, buildUnitName('pi-tui', fx.scope.scopeId))
  const reloadFails = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('daemon-reload')) return exited(1, '', 'reload failed')
    if (args.includes('show')) return exited(0, `LoadState=loaded\nActiveState=inactive\nFragmentPath=${reloadFinal}\n`)
    return exited(0)
  }
  await assert.rejects(
    startManagedHostCandidate(
      { scope: fx.scope, hostEntryPath: fx.entry, dshAnchor: fx.anchor, profile: 'pi-tui' },
      { probe: async (): Promise<UserManagerProbe> => ({ kind: 'available' }), unitDir: () => reloadDir, systemctl: reloadFails },
    ),
    error => isCode(error, 'HOST_MANAGER_START_FAILED'),
  )
  const startDir = testLifecycle(t).tempDir('m62b-startfail-')
  const startFinal = join(startDir, buildUnitName('pi-tui', fx.scope.scopeId))
  const startFails = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('daemon-reload')) return exited(0)
    if (args.includes('show')) return exited(0, `LoadState=loaded\nActiveState=inactive\nFragmentPath=${startFinal}\n`)
    if (args.includes('start')) return exited(1, '', 'start failed')
    return exited(0)
  }
  await assert.rejects(
    startManagedHostCandidate(
      { scope: fx.scope, hostEntryPath: fx.entry, dshAnchor: fx.anchor, profile: 'pi-tui' },
      { probe: async (): Promise<UserManagerProbe> => ({ kind: 'available' }), unitDir: () => startDir, systemctl: startFails },
    ),
    error => isCode(error, 'HOST_MANAGER_START_FAILED'),
  )
})

test('a DSH anchor pinned to a different runtime is refused before any unit is written', async t => {
  const fx = managedFixture(t)
  const wrongAnchor = join(dirname(fx.anchor), 'wrong.json')
  writeFileSync(wrongAnchor, `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.4' })}\n`)
  const unitDir = testLifecycle(t).tempDir('m62b-wronganchor-')
  await assert.rejects(
    startManagedHostCandidate(
      { scope: fx.scope, hostEntryPath: fx.entry, dshAnchor: wrongAnchor, profile: 'pi-tui' },
      { probe: async (): Promise<UserManagerProbe> => ({ kind: 'available' }), unitDir: () => unitDir, systemctl: async () => exited(0) },
    ),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'),
  )
  assert.deepEqual(readdirSync(unitDir), [])
})
