/**
 * Host process lifecycle contracts.
 *
 * These are L1-L3 unit tests for the ONE Host-process management boundary: the
 * profile unit name/content encoder (including the real `systemd-analyze`
 * parser check), the atomic no-overwrite unit install, the explicit
 * `installProfileHostUnit` flow (manager UnitPath gate, idempotent install,
 * foreign/build conflict) and the public start orchestration (no unit means an
 * immediate detached Host with NO systemctl call; an installed loaded unit
 * starts through systemd without a fallback). A real systemd user-manager L6
 * run lives in the split-process smoke, not here.
 *
 * @module @xmoon76/dsh-pi-tui/m6-2b-managed-host.test
 */

import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { LocalScopeError, scopeFromInstalledProfile, type LocalScope } from '../../src/app/remote-process/local-scope.ts'
import {
  buildUnitName,
  encodeUnitPath,
  encodeUnitValue,
  ensureOwnedUnitDir,
  installProfileHostUnit,
  installProfileUnit,
  inspectOwnedProfileUnit,
  inspectTrustedDshAnchor,
  inspectTrustedExecutable,
  profileIdentityDigest,
  profileUnitSlug,
  renderUnitContent,
  spawnHostCandidate,
  startManagedHostCandidate,
  startPublicHostCandidate,
  stopOwnedProfileUnit,
  uninstallOwnedProfileUnit,
  type SystemctlResult,
  type UnitFacts,
} from '../../src/app/remote-process/local-host-manager.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DSH_VERSION = '0.2.2-rc.3'

function exited(code: number, stdout = '', stderr = ''): SystemctlResult {
  return { kind: 'exited', code, stdout, stderr }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof LocalScopeError && error.code === code
}


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
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_VERSION }), { mode: 0o644 })
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

// ── Installed-fact trust and directory policy ────────────────────────────────

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

test('the DSH install anchor is trusted by identity/version, not by uid or writability', t => {
  // A root-owned readable regular file is accepted (no uid rule).
  const rootOwned = ['/usr/bin/systemctl', '/bin/sh', '/usr/bin/env'].find(probe => {
    try {
      const real = realpathSync(probe)
      const info = lstatSync(real)
      return info.isFile() && info.uid !== process.getuid?.()
    } catch {
      return false
    }
  })
  if (rootOwned !== undefined) assert.doesNotThrow(() => inspectTrustedDshAnchor(rootOwned), 'a root-owned DSH anchor must be accepted')
  const dir = testLifecycle(t).tempDir('m62b-dsh-anchor-')
  const good = join(dir, 'anchor.json')
  writeFileSync(good, JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_VERSION }), { mode: 0o644 })
  assert.doesNotThrow(() => inspectTrustedDshAnchor(good))
  // The user's existing mode is not a product policy; identity/version is.
  const writable = join(dir, 'writable.json')
  writeFileSync(writable, '{}')
  chmodSync(writable, 0o666)
  assert.doesNotThrow(() => inspectTrustedDshAnchor(writable))
  // A directory or missing anchor is still a hard failure.
  assert.throws(() => inspectTrustedDshAnchor(dir), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
  assert.throws(() => inspectTrustedDshAnchor(join(dir, 'missing.json')), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
})

test('the user unit directory chain accepts existing 0755/0775 dirs and symlinks without chmodding', t => {
  const life = testLifecycle(t)
  const good = life.tempDir('m62b-home-good-')
  assert.doesNotThrow(() => ensureOwnedUnitDir(good))
  assert.equal(lstatSync(join(good, '.config')).mode & 0o777, 0o700, 'a missing component must be created 0700')

  const existing = life.tempDir('m62b-home-existing-')
  mkdirSync(join(existing, '.config'), { mode: 0o755 })
  mkdirSync(join(existing, '.config', 'systemd'), { mode: 0o775 })
  const resolved = ensureOwnedUnitDir(existing)
  assert.equal(resolved, join(existing, '.config', 'systemd', 'user'))
  assert.equal(lstatSync(join(existing, '.config')).mode & 0o777, 0o755, 'existing modes are never rewritten')

  const linked = life.tempDir('m62b-home-linked-')
  const realConfig = life.tempDir('m62b-real-config-')
  symlinkSync(realConfig, join(linked, '.config'))
  assert.equal(ensureOwnedUnitDir(linked), join(linked, '.config', 'systemd', 'user'))
  assert.equal(existsSync(join(realConfig, 'systemd', 'user')), true)

  const broken = life.tempDir('m62b-home-broken-')
  writeFileSync(join(broken, '.config'), 'not a directory')
  assert.throws(() => ensureOwnedUnitDir(broken), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
})

// ── Atomic owner-checked installation ───────────────────────────────────────

function unitDirFor(t: TestContext): string {
  return testLifecycle(t).tempDir('m62b-unit-')
}

test('a first install creates a 0600 unit and an identical second install converges', t => {
  const dir = unitDirFor(t)
  const first = installProfileUnit({ unitDir: dir, unitName: 'dsh-pi-tui@pi-tui-aaaaaaaaaaaaaaaa.service', content: 'hello\n' })
  assert.equal(first.created, true)
  const finalPath = join(dir, 'dsh-pi-tui@pi-tui-aaaaaaaaaaaaaaaa.service')
  assert.equal(lstatSync(finalPath).mode & 0o777, 0o600)
  assert.equal(readFileSync(finalPath, 'utf8'), 'hello\n')
  const second = installProfileUnit({ unitDir: dir, unitName: 'dsh-pi-tui@pi-tui-aaaaaaaaaaaaaaaa.service', content: 'hello\n' })
  assert.equal(second.created, false)
})

test('an existing user unit or configuration link is never overwritten by installation', t => {
  const dir = unitDirFor(t)
  const name = 'dsh-pi-tui@pi-tui-aaaaaaaaaaaaaaaa.service'
  const target = join(dir, 'user-source.service')
  writeFileSync(target, 'user configuration\n', { mode: 0o644 })
  symlinkSync(target, join(dir, name))
  assert.equal(installProfileUnit({ unitDir: dir, unitName: name, content: 'defaults\n' }).created, false)
  assert.equal(lstatSync(join(dir, name)).isSymbolicLink(), true)
  assert.equal(readFileSync(target, 'utf8'), 'user configuration\n')
})

test('concurrent identical installs converge to exactly one creator and one intact file', async t => {
  const dir = unitDirFor(t)
  const name = 'dsh-pi-tui@pi-tui-dddddddddddddddd.service'
  const content = renderUnitContent(unitFacts())
  const moduleUrl = pathToFileURL(join(ROOT, 'src', 'app', 'remote-process', 'local-host-manager.ts')).href
  const childPath = join(dir, 'concurrent-caller.mts')
  writeFileSync(childPath, [
    `import { installProfileUnit } from ${JSON.stringify(moduleUrl)}`,
    `try {`,
    `  const r = installProfileUnit({ unitDir: ${JSON.stringify(dir)}, unitName: ${JSON.stringify(name)}, content: ${JSON.stringify(content)} })`,
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

// ── Explicit install and public start orchestration ─────────────────────────

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
  writeFileSync(anchor, `${JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_VERSION })}\n`, { mode: 0o644 })
  const scope = scopeFromInstalledProfile({ dshHome: home, profileDir: profile, packageRoot, dshVersion: DSH_VERSION })
  return { scope, entry: join(packageRoot, 'dist', 'local-host.mjs'), anchor, markerPath }
}

/**
 * A fake `systemctl` for the explicit install/start flows. It answers the real
 * `UnitPath` query, the unit `show` query and `daemon-reload`, and records every
 * invocation so a test can prove which systemd calls were (not) made.
 */
function fakeManager(options: {
  readonly unitPath?: string
  readonly finalPath: string
  readonly loaded?: boolean
  readonly activeState?: string
  readonly mainPid?: number
  readonly fragmentPath?: string
  readonly reloadResult?: SystemctlResult
  /** The reload succeeds but the manager never loads the unit (search path miss). */
  readonly staysUnloaded?: boolean
  readonly startResult?: SystemctlResult
  readonly unitPathResult?: SystemctlResult
}) {
  const calls: string[][] = []
  let loaded = options.loaded ?? false
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    calls.push([...args])
    if (args.includes('UnitPath')) {
      return options.unitPathResult ?? exited(0, options.unitPath ?? '')
    }
    if (args.includes('daemon-reload')) {
      if (options.reloadResult !== undefined) return options.reloadResult
      // `staysUnloaded` models a manager whose real search path does not
      // include the target directory: the reload succeeds but `show` keeps
      // answering not-found.
      if (!options.staysUnloaded) loaded = true
      return exited(0)
    }
    if (args.includes('start')) return options.startResult ?? exited(0)
    if (args.includes('stop')) return exited(0)
    if (args.includes('show')) {
      const fragment = options.fragmentPath ?? options.finalPath
      return exited(0, [
        `LoadState=${loaded ? 'loaded' : 'not-found'}`,
        `ActiveState=${options.activeState ?? 'inactive'}`,
        `FragmentPath=${loaded ? fragment : ''}`,
        'DropInPaths=',
        `MainPID=${String(options.mainPid ?? 0)}`,
        'UnitFileState=disabled',
        '',
      ].join('\n'))
    }
    return exited(0)
  }
  return { run, calls, get loaded() { return loaded } }
}

function writeUnit(fx: ManagedFixture, dir: string, content?: string): { readonly path: string; readonly content: string } {
  const text = content ?? renderUnitContent({
    dshHome: fx.scope.dshHome,
    profileRealpath: fx.scope.profileRealpath,
    profile: 'pi-tui',
    scopeId: fx.scope.scopeId,
    buildId: fx.scope.buildId,
    nodePath: process.execPath,
    hostEntryPath: fx.entry,
    dshAnchor: fx.anchor,
  })
  const path = join(dir, buildUnitName('pi-tui', fx.scope.scopeId))
  writeFileSync(path, text, { mode: 0o600 })
  return { path, content: text }
}

function hostOptions(fx: ManagedFixture, overrides: { hostEntryPath?: string; dshAnchor?: string } = {}) {
  return {
    scope: fx.scope,
    hostEntryPath: overrides.hostEntryPath ?? fx.entry,
    dshAnchor: overrides.dshAnchor ?? fx.anchor,
    profile: 'pi-tui',
  }
}

test('install accepts a reachable manager that omits the still-empty target directory from UnitPath', async t => {
  const fx = managedFixture(t)
  const root = testLifecycle(t).tempDir('m62b-install-empty-unitpath-')
  const unitDir = join(root, '.config', 'systemd', 'user')
  const unitName = buildUnitName('pi-tui', fx.scope.scopeId)
  // systemd omits still-empty directories from `show -p UnitPath --value`, so an
  // empty/default-only UnitPath must NOT block a clean account's first install.
  const systemctl = fakeManager({ finalPath: join(unitDir, unitName), unitPath: '/usr/lib/systemd/user /etc/systemd/user' })
  const result = await installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: systemctl.run })
  assert.equal(result.created, true)
  assert.equal(result.reloaded, true)
  assert.equal(existsSync(unitDir), true)
  assert.equal(existsSync(join(unitDir, unitName)), true)
  assert.equal(systemctl.calls.filter(args => args.includes('daemon-reload')).length, 1)
})

test('install refuses an unusable user manager instead of writing or falling back', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-nomanager-')
  const systemctl = fakeManager({
    finalPath: join(unitDir, buildUnitName('pi-tui', fx.scope.scopeId)),
    unitPathResult: exited(1, '', 'Failed to connect to bus: No such file or directory'),
  })
  await assert.rejects(
    installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: systemctl.run }),
    error => isCode(error, 'HOST_MANAGER_ERROR'),
  )
  assert.deepEqual(readdirSync(unitDir), [])
})

test('install queries the real manager BEFORE creating a missing user unit directory', async t => {
  const fx = managedFixture(t)
  const root = testLifecycle(t).tempDir('m62b-install-order-')
  const unitDir = join(root, 'nested', 'user')
  const unitName = buildUnitName('pi-tui', fx.scope.scopeId)
  const base = fakeManager({ finalPath: join(unitDir, unitName), unitPath: unitDir })
  let existedAtQuery: boolean | undefined
  const failingManager = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('UnitPath')) {
      existedAtQuery = existsSync(unitDir)
      return exited(1, '', 'manager unavailable')
    }
    return await base.run(args)
  }
  await assert.rejects(
    installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: failingManager }),
    error => isCode(error, 'HOST_MANAGER_ERROR'),
  )
  assert.equal(existedAtQuery, false, 'the manager gate must run before any directory write')
  assert.equal(existsSync(unitDir), false, 'an unusable manager must not create the user unit directory')

  let existedAtQuery2: boolean | undefined
  const workingManager = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('UnitPath')) {
      existedAtQuery2 = existsSync(unitDir)
      return exited(0, unitDir)
    }
    return await base.run(args)
  }
  const result = await installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: workingManager })
  assert.equal(existedAtQuery2, false, 'the gate still runs before creation')
  assert.equal(result.created, true)
  assert.equal(existsSync(unitDir), true)
})

test('install creates one unit, reloads once and never starts or enables it', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-fresh-')
  const unitName = buildUnitName('pi-tui', fx.scope.scopeId)
  const finalPath = join(unitDir, unitName)
  const systemctl = fakeManager({ finalPath, unitPath: unitDir })
  const result = await installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: systemctl.run })
  assert.equal(result.created, true)
  assert.equal(result.reloaded, true)
  assert.equal(result.unitName, unitName)
  assert.equal(result.unitPath, finalPath)
  assert.match(readFileSync(finalPath, 'utf8'), new RegExp(`^X-DshPiTuiScopeId=${fx.scope.scopeId}$`, 'mu'))
  const flattened = systemctl.calls.map(args => args.join(' '))
  assert.equal(flattened.filter(call => call.includes('daemon-reload')).length, 1, 'a fresh unit needs exactly one reload')
  assert.equal(flattened.some(call => /\bstart\b/u.test(call)), false, 'install must never start the unit')
  assert.equal(flattened.some(call => /\benable\b/u.test(call)), false, 'install must never enable the unit')
})

test('install reloads a freshly created unit even when the manager still reports a cached loaded definition', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-stale-cache-')
  const finalPath = join(unitDir, buildUnitName('pi-tui', fx.scope.scopeId))
  // systemd may still cache a previously removed unit at the SAME FragmentPath.
  // The file does not exist yet, but `show` already reports it loaded.
  const systemctl = fakeManager({ finalPath, unitPath: unitDir, loaded: true })
  const result = await installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: systemctl.run })
  assert.equal(result.created, true)
  assert.equal(result.reloaded, true, 'a fresh unit must force one daemon-reload even when LoadState=loaded is cached')
  assert.equal(systemctl.calls.filter(args => args.includes('daemon-reload')).length, 1)
})

test('repeat install is fully idempotent once the manager has loaded the unit', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-repeat-')
  const finalPath = join(unitDir, buildUnitName('pi-tui', fx.scope.scopeId))
  const systemctl = fakeManager({ finalPath, unitPath: unitDir })
  const first = await installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: systemctl.run })
  assert.equal(first.created, true)
  const second = await installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: systemctl.run })
  assert.equal(second.created, false)
  assert.equal(second.reloaded, false, 'an already loaded unit is not reloaded again')
  assert.equal(systemctl.calls.filter(args => args.includes('daemon-reload')).length, 1)
})

test('a freshly created unit reloads before verifying a cached different FragmentPath', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-old-fragment-')
  const unitName = buildUnitName('pi-tui', fx.scope.scopeId)
  const finalPath = join(unitDir, unitName)
  let reloaded = false
  const calls: string[][] = []
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    calls.push([...args])
    if (args.includes('UnitPath')) return exited(0, unitDir)
    if (args.includes('daemon-reload')) { reloaded = true; return exited(0) }
    if (args.includes('show')) {
      return exited(0, [
        'LoadState=loaded',
        'ActiveState=inactive',
        `FragmentPath=${reloaded ? finalPath : join(unitDir, 'stale.service')}`,
        'DropInPaths=',
        'MainPID=0',
        'UnitFileState=disabled',
        '',
      ].join('\n'))
    }
    return exited(0)
  }
  const result = await installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: run })
  assert.equal(result.created, true)
  assert.equal(result.reloaded, true, 'a fresh unit must reload before checking the cached FragmentPath')
  assert.equal(calls.filter(args => args.includes('daemon-reload')).length, 1)
})

test('install refuses to shadow a manager-loaded foreign unit of the same name before any write', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-shadow-')
  const unitName = buildUnitName('pi-tui', fx.scope.scopeId)
  const foreignSource = join(unitDir, 'foreign-source.service')
  writeFileSync(foreignSource, '[Unit]\nDescription=foreign loaded service\n', { mode: 0o644 })
  let reloaded = false
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('daemon-reload')) { reloaded = true; return exited(0) }
    if (args.includes('show')) {
      return exited(0, [
        'LoadState=loaded',
        'ActiveState=active',
        `FragmentPath=${foreignSource}`,
        'DropInPaths=',
        'MainPID=4242',
        'UnitFileState=enabled',
        '',
      ].join('\n'))
    }
    return exited(0)
  }
  await assert.rejects(
    installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: run }),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT') && /shadow a foreign service/u.test(String(error)),
  )
  assert.equal(existsSync(join(unitDir, unitName)), false, 'a shadowing install must write no unit file')
  assert.equal(reloaded, false, 'a shadowing install must issue no reload')
  assert.equal(readFileSync(foreignSource, 'utf8').startsWith('[Unit]'), true, 'the foreign loaded definition must be untouched')
})

test('a running foreign unit whose source file is gone is not shadowed', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-active-gone-')
  const unitName = buildUnitName('pi-tui', fx.scope.scopeId)
  const finalPath = join(unitDir, unitName)
  let reloads = 0
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('daemon-reload')) { reloads += 1; return exited(0) }
    if (args.includes('show')) {
      return exited(0, [
        'LoadState=loaded',
        'ActiveState=active',
        `FragmentPath=${join(unitDir, 'gone.service')}`,
        'DropInPaths=',
        'MainPID=4242',
        'UnitFileState=enabled',
        '',
      ].join('\n'))
    }
    return exited(0)
  }
  await assert.rejects(
    installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: run }),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT') && /possibly running foreign service/u.test(String(error)),
  )
  assert.equal(reloads, 0, 'a running foreign unit must not be reloaded')
  assert.equal(existsSync(finalPath), false, 'a running foreign unit must not be shadowed')
})

test('a not-found unit still reported active is not treated as unused', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-notfound-active-')
  const unitName = buildUnitName('pi-tui', fx.scope.scopeId)
  const finalPath = join(unitDir, unitName)
  let reloads = 0
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('daemon-reload')) { reloads += 1; return exited(0) }
    if (args.includes('show')) {
      return exited(0, [
        'LoadState=not-found',
        'ActiveState=active',
        'FragmentPath=',
        'DropInPaths=',
        'MainPID=4242',
        'UnitFileState=',
        '',
      ].join('\n'))
    }
    return exited(0)
  }
  await assert.rejects(
    installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: run }),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT') && /not loaded/u.test(String(error)),
  )
  assert.equal(reloads, 0, 'an active not-found name must not be reloaded')
  assert.equal(existsSync(finalPath), false, 'an active not-found name must not be shadowed')
})

test('install still recovers when the manager only caches a removed same-name unit', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-stale-only-')
  const unitName = buildUnitName('pi-tui', fx.scope.scopeId)
  const finalPath = join(unitDir, unitName)
  // The cached FragmentPath no longer exists: only a stale cache, safe to
  // replace. A successful reload then points the name at our fresh file.
  const gone = join(unitDir, 'gone.service')
  let reloadedFromStale = false
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('daemon-reload')) { reloadedFromStale = true; return exited(0) }
    if (args.includes('show')) {
      return exited(0, [
        `LoadState=${reloadedFromStale ? 'loaded' : 'loaded'}`,
        'ActiveState=inactive',
        `FragmentPath=${reloadedFromStale ? finalPath : gone}`,
        'DropInPaths=',
        'MainPID=0',
        'UnitFileState=disabled',
        '',
      ].join('\n'))
    }
    return exited(0)
  }
  const result = await installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: run })
  assert.equal(result.created, true)
  assert.equal(result.reloaded, true)
  assert.equal(existsSync(finalPath), true)
})

test('a failed reload of a fresh unit is rolled back so a retry reloads again', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-retry-')
  const unitName = buildUnitName('pi-tui', fx.scope.scopeId)
  const finalPath = join(unitDir, unitName)
  const failing = fakeManager({ finalPath, unitPath: unitDir, reloadResult: exited(1, '', 'reload failed') })
  await assert.rejects(
    installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: failing.run }),
    error => isCode(error, 'HOST_MANAGER_START_FAILED'),
  )
  assert.equal(failing.calls.filter(args => args.includes('daemon-reload')).length, 1)
  assert.equal(existsSync(finalPath), false, 'a failed fresh install must roll its unit file back')

  const stale = fakeManager({ finalPath, unitPath: unitDir, loaded: true })
  const retry = await installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: stale.run })
  assert.equal(retry.created, true, 'the retry must create the unit again')
  assert.equal(retry.reloaded, true, 'the retry must reload instead of trusting the stale cached LoadState')
  assert.equal(stale.calls.filter(args => args.includes('daemon-reload')).length, 1)
})

test('install preserves an existing same-identity customized unit and never rewrites it', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-existing-')
  const path = join(unitDir, buildUnitName('pi-tui', fx.scope.scopeId))
  const customized = renderUnitContent({
    dshHome: fx.scope.dshHome,
    profileRealpath: fx.scope.profileRealpath,
    profile: 'pi-tui',
    scopeId: fx.scope.scopeId,
    buildId: fx.scope.buildId,
    nodePath: process.execPath,
    hostEntryPath: fx.entry,
    dshAnchor: fx.anchor,
  }).replace('Restart=on-failure', 'Restart=no').replace(/^ExecStart=.*$/mu, 'ExecStart=/bin/false')
  writeFileSync(path, customized, { mode: 0o644 })
  chmodSync(path, 0o644)
  const systemctl = fakeManager({ finalPath: path, unitPath: unitDir, loaded: true })
  const result = await installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: systemctl.run })
  assert.equal(result.created, false)
  assert.equal(result.reloaded, false)
  assert.equal(readFileSync(path, 'utf8'), customized, 'user runtime directives must stay byte-for-byte intact')
})

test('install explicitly reloads an existing but not-loaded unit and verifies FragmentPath', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-notloaded-')
  const unit = writeUnit(fx, unitDir)
  const systemctl = fakeManager({ finalPath: unit.path, unitPath: unitDir, loaded: false })
  const result = await installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: systemctl.run })
  assert.equal(result.created, false)
  assert.equal(result.reloaded, true)
  assert.equal(systemctl.calls.filter(args => args.includes('daemon-reload')).length, 1)
})

test('install refuses a foreign unit, another build and a wrong DSH anchor without overwriting', async t => {
  const fx = managedFixture(t)
  const foreignDir = testLifecycle(t).tempDir('m62b-install-foreign-')
  const foreign = writeUnit(fx, foreignDir, renderUnitContent({
    dshHome: fx.scope.dshHome, profileRealpath: fx.scope.profileRealpath, profile: 'pi-tui', scopeId: fx.scope.scopeId,
    buildId: fx.scope.buildId, nodePath: process.execPath, hostEntryPath: fx.entry, dshAnchor: fx.anchor,
  }).replace('X-DshPiTuiOwner=local-host-manager-v1', 'X-DshPiTuiOwner=someone-else'))
  await assert.rejects(
    installProfileHostUnit(hostOptions(fx), {
      unitDir: () => foreignDir,
      systemctl: fakeManager({ finalPath: foreign.path, unitPath: foreignDir }).run,
    }),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'),
  )
  assert.equal(readFileSync(foreign.path, 'utf8'), foreign.content)

  const oldBuildDir = testLifecycle(t).tempDir('m62b-install-oldbuild-')
  const oldBuild = writeUnit(fx, oldBuildDir, renderUnitContent({
    dshHome: fx.scope.dshHome, profileRealpath: fx.scope.profileRealpath, profile: 'pi-tui', scopeId: fx.scope.scopeId,
    buildId: 'c'.repeat(64), nodePath: process.execPath, hostEntryPath: fx.entry, dshAnchor: fx.anchor,
  }))
  await assert.rejects(
    installProfileHostUnit(hostOptions(fx), {
      unitDir: () => oldBuildDir,
      systemctl: fakeManager({ finalPath: oldBuild.path, unitPath: oldBuildDir, loaded: true }).run,
    }),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'),
  )
  assert.equal(readFileSync(oldBuild.path, 'utf8'), oldBuild.content)

  const wrongDir = testLifecycle(t).tempDir('m62b-install-wronganchor-')
  const wrongAnchor = join(dirname(fx.anchor), 'wrong.json')
  writeFileSync(wrongAnchor, `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.4' })}\n`, { mode: 0o644 })
  await assert.rejects(
    installProfileHostUnit(hostOptions(fx, { dshAnchor: wrongAnchor }), {
      unitDir: () => wrongDir,
      systemctl: fakeManager({ finalPath: join(wrongDir, buildUnitName('pi-tui', fx.scope.scopeId)), unitPath: wrongDir }).run,
    }),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'),
  )
  assert.deepEqual(readdirSync(wrongDir), [])
})

test('a reachable manager that never loads the fresh unit rolls the file back and leaves the basic daemon free', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-neverloaded-')
  const unitName = buildUnitName('pi-tui', fx.scope.scopeId)
  const finalPath = join(unitDir, unitName)
  // Reload succeeds but the manager's real search path does not include the
  // target directory: show keeps answering not-found.
  const neverLoaded = fakeManager({ finalPath, unitPath: unitDir, loaded: false, staysUnloaded: true })
  await assert.rejects(
    installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: neverLoaded.run }),
    error => isCode(error, 'HOST_MANAGER_START_FAILED'),
  )
  assert.equal(existsSync(finalPath), false, 'an unloadable fresh install must not leave a poisoned unit file')
  // The profile is back to the no-unit state, so the public start must use the
  // basic detached Host without touching the manager.
  const startCalls: string[][] = []
  const startSystemctl = async (args: readonly string[]): Promise<SystemctlResult> => { startCalls.push([...args]); return exited(1, '', 'no manager needed') }
  const observation = await startPublicHostCandidate(hostOptions(fx), { unitDir: () => unitDir, systemctl: startSystemctl })
  assert.equal(observation(), undefined)
  const deadline = Date.now() + 10_000
  while (!existsSync(fx.markerPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(existsSync(fx.markerPath), true, 'the basic daemon must cold start after a failed install')
  assert.deepEqual(startCalls, [], 'the recovered basic start must not query the manager at all')
})

test('a post-reload FragmentPath mismatch rolls the fresh file back after a real reload', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-wrong-fragment-')
  const unitName = buildUnitName('pi-tui', fx.scope.scopeId)
  const finalPath = join(unitDir, unitName)
  const elsewhere = join(unitDir, 'elsewhere.service')
  writeFileSync(elsewhere, '[Unit]\n', { mode: 0o644 })
  let reloaded = false
  const calls: string[][] = []
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    calls.push([...args])
    if (args.includes('daemon-reload')) { reloaded = true; return exited(0) }
    if (args.includes('show')) {
      return exited(0, [
        `LoadState=${reloaded ? 'loaded' : 'not-found'}`,
        'ActiveState=inactive',
        `FragmentPath=${reloaded ? elsewhere : ''}`,
        'DropInPaths=',
        'MainPID=0',
        'UnitFileState=disabled',
        '',
      ].join('\n'))
    }
    return exited(0)
  }
  await assert.rejects(
    installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: run }),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'),
  )
  assert.equal(reloaded, true, 'the install must actually reload before the adoption check')
  assert.equal(existsSync(finalPath), false, 'a non-adopted fresh unit must be rolled back')
  assert.equal(readFileSync(elsewhere, 'utf8'), '[Unit]\n', 'the manager-loaded definition is never modified')
})

test('an unresolvable loaded source other than a missing file stays refused', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-eloop-')
  const unitName = buildUnitName('pi-tui', fx.scope.scopeId)
  const finalPath = join(unitDir, unitName)
  const looping = join(unitDir, 'loop.service')
  symlinkSync(looping, looping)
  // Discriminability precondition: the loaded source must FAIL realpath with a
  // non-ENOENT code, or this regression would be satisfied by the plain
  // foreign-file refusal instead of the errno boundary.
  assert.throws(
    () => realpathSync(looping),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ELOOP',
  )
  let reloads = 0
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('daemon-reload')) { reloads += 1; return exited(0) }
    if (args.includes('show')) {
      return exited(0, [
        'LoadState=loaded',
        'ActiveState=active',
        `FragmentPath=${looping}`,
        'DropInPaths=',
        'MainPID=4242',
        'UnitFileState=enabled',
        '',
      ].join('\n'))
    }
    return exited(0)
  }
  await assert.rejects(
    installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: run }),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT') && /cannot be verified/u.test(String(error)),
  )
  assert.equal(reloads, 0, 'an unverifiable loaded source must not be reloaded')
  assert.equal(existsSync(finalPath), false, 'no unit file may be written')
})

test('a post-reload query failure rolls the fresh file back instead of leaving it', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-queryfail-')
  const unitName = buildUnitName('pi-tui', fx.scope.scopeId)
  const finalPath = join(unitDir, unitName)
  let reloaded = false
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('daemon-reload')) { reloaded = true; return exited(0) }
    if (args.includes('show')) {
      if (!reloaded) return exited(0, 'LoadState=not-found\nActiveState=inactive\nFragmentPath=\nDropInPaths=\nMainPID=0\nUnitFileState=disabled\n')
      // After the reload the manager's own query fails (bus/timeout class).
      return exited(1, '', 'Failed to connect to bus')
    }
    return exited(0)
  }
  await assert.rejects(
    installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: run }),
    error => isCode(error, 'HOST_MANAGER_START_FAILED'),
  )
  assert.equal(reloaded, true, 'the reload must have been committed before the failed verification')
  assert.equal(existsSync(finalPath), false, 'an unverifiable fresh unit must be rolled back')
})

test('install reports a failed daemon-reload instead of claiming the unit is loaded', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-install-reloadfail-')
  const finalPath = join(unitDir, buildUnitName('pi-tui', fx.scope.scopeId))
  const systemctl = fakeManager({ finalPath, unitPath: unitDir, reloadResult: exited(1, '', 'reload failed') })
  await assert.rejects(
    installProfileHostUnit(hostOptions(fx), { unitDir: () => unitDir, systemctl: systemctl.run }),
    error => isCode(error, 'HOST_MANAGER_START_FAILED'),
  )
  assert.equal(existsSync(finalPath), false, 'the failed fresh install must remove its unverified unit file')
})

test('a public start with no installed unit spawns detached without any systemctl call', async t => {
  const fx = managedFixture(t)
  const emptyUnitDir = testLifecycle(t).tempDir('m62b-no-unit-')
  const systemctl = fakeManager({ finalPath: join(emptyUnitDir, 'unused.service'), unitPath: emptyUnitDir, unitPathResult: exited(1, '', 'no manager') })
  const observation = await startPublicHostCandidate(hostOptions(fx), { unitDir: () => emptyUnitDir, systemctl: systemctl.run })
  assert.equal(observation(), undefined)
  const deadline = Date.now() + 10_000
  while (!existsSync(fx.markerPath) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(existsSync(fx.markerPath), true, 'the basic daemon must be spawned as a detached Host')
  assert.deepEqual(systemctl.calls, [], 'no installed unit means NO user-manager access at all')
  assert.deepEqual(readdirSync(emptyUnitDir), [], 'a public start must never create a unit')
})

test('a public start with an installed unit starts it once through systemd and never rewrites it', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-start-unit-')
  const unit = writeUnit(fx, unitDir)
  const systemctl = fakeManager({ finalPath: unit.path, unitPath: unitDir, loaded: true })
  const observation = await startPublicHostCandidate(hostOptions(fx), { unitDir: () => unitDir, systemctl: systemctl.run })
  assert.equal(observation(), undefined)
  assert.equal(readFileSync(unit.path, 'utf8'), unit.content, 'a loaded unit is never rewritten by start')
  const flattened = systemctl.calls.map(args => args.join(' '))
  assert.equal(flattened.filter(call => /\bstart\b/u.test(call)).length, 1)
  assert.equal(flattened.some(call => call.includes('daemon-reload')), false, 'a loaded unit is not reloaded by start')
})

test('a public start with a different FragmentPath refuses to start and never falls back', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-start-fragment-')
  const unit = writeUnit(fx, unitDir)
  const systemctl = fakeManager({ finalPath: unit.path, unitPath: unitDir, loaded: true, fragmentPath: fx.anchor })
  await assert.rejects(
    startPublicHostCandidate(hostOptions(fx), { unitDir: () => unitDir, systemctl: systemctl.run }),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'),
  )
  assert.equal(systemctl.calls.some(args => args.includes('start')), false, 'a conflicting unit is never started')
})

test('a public start with a broken manager or an unloaded unit never falls back to a process', async t => {
  const fx = managedFixture(t)
  const brokenDir = testLifecycle(t).tempDir('m62b-start-broken-')
  const brokenUnit = writeUnit(fx, brokenDir)
  const broken = fakeManager({ finalPath: brokenUnit.path, unitPath: brokenDir, loaded: true })
  const brokenRun = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('show')) return exited(1, '', 'Failed to connect to bus: Permission denied')
    return await broken.run(args)
  }
  await assert.rejects(
    startPublicHostCandidate(hostOptions(fx), { unitDir: () => brokenDir, systemctl: brokenRun }),
    error => isCode(error, 'HOST_MANAGER_START_FAILED'),
  )
  assert.equal(existsSync(fx.markerPath), false, 'a manager failure must never spawn a detached Host')

  const unloadedDir = testLifecycle(t).tempDir('m62b-start-unloaded-')
  const unloadedUnit = writeUnit(fx, unloadedDir)
  const unloaded = fakeManager({ finalPath: unloadedUnit.path, unitPath: unloadedDir, loaded: false })
  await assert.rejects(
    startPublicHostCandidate(hostOptions(fx), { unitDir: () => unloadedDir, systemctl: unloaded.run }),
    error => isCode(error, 'HOST_MANAGER_START_FAILED'),
  )
  assert.equal(existsSync(fx.markerPath), false)
})

test('a public start refuses an installed unit from another build', async t => {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-start-oldbuild-')
  const unit = writeUnit(fx, unitDir, renderUnitContent({
    dshHome: fx.scope.dshHome, profileRealpath: fx.scope.profileRealpath, profile: 'pi-tui', scopeId: fx.scope.scopeId,
    buildId: 'c'.repeat(64), nodePath: process.execPath, hostEntryPath: fx.entry, dshAnchor: fx.anchor,
  }))
  const systemctl = fakeManager({ finalPath: unit.path, unitPath: unitDir, loaded: true })
  await assert.rejects(
    startPublicHostCandidate(hostOptions(fx), { unitDir: () => unitDir, systemctl: systemctl.run }),
    error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'),
  )
  assert.equal(systemctl.calls.some(args => args.includes('start')), false)
})

test('a detached Host entry under an external dist symlink locates its package root', async t => {
  const root = testLifecycle(t).tempDir('m62b-host-symlink-')
  const home = join(root, 'dsh-home')
  const profileDir = join(root, 'profiles', 'pi-tui')
  const packageRoot = join(root, 'package')
  const sharedDist = join(root, 'shared-dist')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  mkdirSync(packageRoot, { recursive: true })
  mkdirSync(sharedDist, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version: '0.5.7' })}\n`)
  const proofPath = join(root, 'proof.json')
  const helperUrl = pathToFileURL(join(ROOT, 'src', 'app', 'remote-process', 'local-scope.ts')).href
  writeFileSync(join(sharedDist, 'local-host.mjs'), [
    `import { installedPackageRootFromEntry } from ${JSON.stringify(helperUrl)}`,
    `import { pathToFileURL } from 'node:url'`,
    `import { writeFileSync } from 'node:fs'`,
    `writeFileSync(process.env.SPLIT_PROCESS_HOST_PROOF, JSON.stringify({ argv: process.argv[1], root: installedPackageRootFromEntry(pathToFileURL(process.argv[1]).href) }))`,
    '',
  ].join('\n'))
  symlinkSync(sharedDist, join(packageRoot, 'dist'))
  const anchor = join(root, 'dsh', 'package.json')
  mkdirSync(join(root, 'dsh'), { recursive: true })
  writeFileSync(anchor, `${JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_VERSION })}\n`, { mode: 0o644 })
  const scope = scopeFromInstalledProfile({ dshHome: home, profileDir, packageRoot, dshVersion: DSH_VERSION })

  const previousNodeOptions = process.env.NODE_OPTIONS
  const previousProof = process.env.SPLIT_PROCESS_HOST_PROOF
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
  process.env.NODE_OPTIONS = [previousNodeOptions, '--import', tsxLoader].filter(Boolean).join(' ')
  process.env.SPLIT_PROCESS_HOST_PROOF = proofPath
  try {
    const observation = spawnHostCandidate({
      scope,
      hostEntryPath: join(packageRoot, 'dist', 'local-host.mjs'),
      dshAnchor: anchor,
      profile: 'pi-tui',
    })
    assert.equal(observation(), undefined)
    const deadline = Date.now() + 15_000
    while (!existsSync(proofPath) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  } finally {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previousNodeOptions
    if (previousProof === undefined) delete process.env.SPLIT_PROCESS_HOST_PROOF
    else process.env.SPLIT_PROCESS_HOST_PROOF = previousProof
  }
  assert.equal(existsSync(proofPath), true, 'the detached Host probe never wrote its proof')
  const proof = JSON.parse(readFileSync(proofPath, 'utf8')) as { readonly argv: string; readonly root: string }
  assert.equal(proof.argv, join(packageRoot, 'dist', 'local-host.mjs'), 'the Host must run the NAMED symlinked entry')
  assert.equal(realpathSync(proof.root), realpathSync(packageRoot), 'the Host must locate THIS package root')
})

test('macOS public-managed start uses the detached fallback without a user manager', { skip: process.platform !== 'darwin' ? 'the real Darwin detached fallback requires macOS' : false }, async t => {
  const fx = managedFixture(t)
  const forbidden = (): never => { throw new Error('macOS must not consult a systemd unit directory or systemctl') }
  const observation = await startManagedHostCandidate(
    { scope: fx.scope, hostEntryPath: fx.entry, dshAnchor: fx.anchor, profile: 'pi-tui' },
    { unitDir: forbidden as never, systemctl: forbidden as never },
  )
  assert.equal(observation(), undefined)
  const deadline = Date.now() + 10_000
  while (!existsSync(fx.markerPath) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(existsSync(fx.markerPath), true, 'the real Darwin public-managed path must spawn the Host entry')
})

// ── Shared read-only unit inspection and narrow actions ─────────────────────

interface ControlUnitFixture extends ManagedFixture {
  readonly unitDir: string
  readonly unitPath: string
  readonly content: string
}

function controlledUnitFixture(t: TestContext, buildId?: string): ControlUnitFixture {
  const fx = managedFixture(t)
  const unitDir = testLifecycle(t).tempDir('m62b-control-unit-')
  const content = renderUnitContent({
    dshHome: fx.scope.dshHome,
    profileRealpath: fx.scope.profileRealpath,
    profile: 'pi-tui',
    scopeId: fx.scope.scopeId,
    buildId: buildId ?? fx.scope.buildId,
    nodePath: process.execPath,
    hostEntryPath: fx.entry,
    dshAnchor: fx.anchor,
  })
  const unitPath = join(unitDir, buildUnitName('pi-tui', fx.scope.scopeId))
  writeFileSync(unitPath, content, { mode: 0o600 })
  return { ...fx, unitDir, unitPath, content }
}

function managerState(path: string, activeState: string, mainPid: number) {
  const calls: string[][] = []
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    calls.push([...args])
    if (args.includes('stop')) return exited(0)
    if (args.includes('show')) {
      return exited(0, [`LoadState=loaded`, `ActiveState=${activeState}`, `FragmentPath=${path}`, 'DropInPaths=', `MainPID=${String(mainPid)}`, 'UnitFileState=disabled', ''].join('\n'))
    }
    return exited(0)
  }
  return { run, calls }
}

test('inspectOwnedProfileUnit reports none for an empty unit directory without creating anything', t => {
  const fx = controlledUnitFixture(t)
  const emptyDir = testLifecycle(t).tempDir('m62b-empty-units-')
  const result = inspectOwnedProfileUnit(fx.scope, 'pi-tui', emptyDir)
  assert.deepEqual(result, { kind: 'none' })
  assert.equal(existsSync(emptyDir), true)
})

test('inspectOwnedProfileUnit accepts the exact owned definition and reports its install build', t => {
  const fx = controlledUnitFixture(t)
  const result = inspectOwnedProfileUnit(fx.scope, 'pi-tui', fx.unitDir)
  assert.equal(result.kind, 'owned')
  if (result.kind === 'owned') {
    assert.equal(result.unitName, buildUnitName('pi-tui', fx.scope.scopeId))
    assert.equal(result.installBuild, fx.scope.buildId)
    assert.equal(result.content, fx.content)
  }
})

test('unit inspection refuses foreign, wrong-scope, wrong-Profile, invalid and duplicate metadata', t => {
  const fx = controlledUnitFixture(t)
  for (const content of [
    fx.content.replace('X-DshPiTuiOwner=local-host-manager-v1', 'X-DshPiTuiOwner=other'),
    fx.content.replace(`X-DshPiTuiScopeId=${fx.scope.scopeId}`, `X-DshPiTuiScopeId=${'0'.repeat(64)}`),
    fx.content.replace(`X-DshPiTuiProfileIdentity=${profileIdentityDigest(fx.scope.profileRealpath)}`, `X-DshPiTuiProfileIdentity=${'0'.repeat(64)}`),
    fx.content.replace(`X-DshPiTuiInstallBuild=${fx.scope.buildId}`, 'X-DshPiTuiInstallBuild=unknown'),
    `${fx.content}X-DshPiTuiOwner=local-host-manager-v1\n`,
  ]) {
    writeFileSync(fx.unitPath, content, { mode: 0o600 })
    assert.throws(() => inspectOwnedProfileUnit(fx.scope, 'pi-tui', fx.unitDir), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
  }
})

test('user runtime directives, 0644 units and linked configuration retain Profile identity', t => {
  const fx = controlledUnitFixture(t)
  const content = fx.content.replace('Restart=on-failure', 'Restart=no').replace(/^ExecStart=.*$/mu, 'ExecStart=/bin/false')
    + 'ExecStartPre=/usr/bin/true\nExecStop=/usr/bin/true\nEnvironment="MY_CUSTOM_FLAG=1"\nRestartSec=5\n'
  writeFileSync(fx.unitPath, content, { mode: 0o600 })
  chmodSync(fx.unitPath, 0o644)
  const observed = inspectOwnedProfileUnit(fx.scope, 'pi-tui', fx.unitDir)
  assert.equal(observed.kind, 'owned')
  const source = join(fx.unitDir, 'source.service')
  renameSync(fx.unitPath, source)
  symlinkSync(source, fx.unitPath)
  const linked = inspectOwnedProfileUnit(fx.scope, 'pi-tui', fx.unitDir)
  if (linked.kind !== 'owned') return assert.fail('expected linked owned unit')
  assert.equal(linked.resolvedPath, realpathSync(source))
  uninstallOwnedProfileUnit(linked, fx.scope, 'pi-tui')
  assert.equal(existsSync(fx.unitPath), false)
  assert.equal(readFileSync(source, 'utf8'), content, 'uninstall removes only the link, never its configuration source')
})

test('a named unit changed after inspection is refused before stop or unlink', async t => {
  const fx = controlledUnitFixture(t)
  const unit = inspectOwnedProfileUnit(fx.scope, 'pi-tui', fx.unitDir)
  if (unit.kind !== 'owned') return assert.fail('expected owned unit')
  const replacement = `${fx.unitPath}.replacement`
  writeFileSync(replacement, fx.content, { mode: 0o644 })
  renameSync(replacement, fx.unitPath)
  const manager = managerState(fx.unitPath, 'active', 4242)
  await assert.rejects(() => stopOwnedProfileUnit(unit, undefined, manager.run), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
  assert.equal(manager.calls.some(args => args.includes('stop')), false)
  assert.throws(() => uninstallOwnedProfileUnit(unit, fx.scope, 'pi-tui'), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
  assert.equal(existsSync(fx.unitPath), true)
})

test('dangling/non-file links fail identity inspection, and a retargeted link cannot be uninstalled', t => {
  const fx = controlledUnitFixture(t)
  const source = join(fx.unitDir, 'source.service')
  renameSync(fx.unitPath, source)
  symlinkSync(source, fx.unitPath)
  const unit = inspectOwnedProfileUnit(fx.scope, 'pi-tui', fx.unitDir)
  if (unit.kind !== 'owned') return assert.fail('expected linked unit')
  unlinkSync(fx.unitPath)
  symlinkSync(fx.unitDir, fx.unitPath)
  assert.throws(() => inspectOwnedProfileUnit(fx.scope, 'pi-tui', fx.unitDir), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
  assert.throws(() => uninstallOwnedProfileUnit(unit, fx.scope, 'pi-tui'), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
  unlinkSync(fx.unitPath)
  symlinkSync(join(fx.unitDir, 'missing.service'), fx.unitPath)
  assert.throws(() => inspectOwnedProfileUnit(fx.scope, 'pi-tui', fx.unitDir), error => isCode(error, 'HOST_MANAGER_UNIT_CONFLICT'))
  assert.equal(readFileSync(source, 'utf8'), fx.content)
})

test('stopOwnedProfileUnit is a no-op for an inactive unit and never issues stop', async t => {
  const fx = controlledUnitFixture(t)
  const unit = inspectOwnedProfileUnit(fx.scope, 'pi-tui', fx.unitDir)
  assert.equal(unit.kind, 'owned')
  if (unit.kind !== 'owned') return
  const fake = managerState(fx.unitPath, 'inactive', 0)
  const result = await stopOwnedProfileUnit(unit, undefined, fake.run)
  assert.equal(result.alreadyInactive, true)
  assert.equal(fake.calls.some(args => args.includes('stop')), false)
})

test('stopOwnedProfileUnit stops an active unit and returns its original MainPID', async t => {
  const fx = controlledUnitFixture(t)
  const unit = inspectOwnedProfileUnit(fx.scope, 'pi-tui', fx.unitDir)
  if (unit.kind !== 'owned') return assert.fail('expected an owned unit')
  let active = 'active'
  let mainPid = 4242
  const calls: string[][] = []
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    calls.push([...args])
    if (args.includes('stop')) {
      active = 'inactive'
      mainPid = 0
      return exited(0)
    }
    return exited(0, [`LoadState=loaded`, `ActiveState=${active}`, `FragmentPath=${fx.unitPath}`, 'DropInPaths=', `MainPID=${String(mainPid)}`, 'UnitFileState=disabled', ''].join('\n'))
  }
  const result = await stopOwnedProfileUnit(unit, undefined, run)
  assert.equal(result.stopped, true)
  assert.equal(result.mainPid, 4242)
  assert.equal(calls.some(args => args.includes('stop')), true)
})

test('an activating unit with no MainPID still goes through systemctl stop', async t => {
  const fx = controlledUnitFixture(t)
  const unit = inspectOwnedProfileUnit(fx.scope, 'pi-tui', fx.unitDir)
  if (unit.kind !== 'owned') return assert.fail('expected an owned unit')
  let state = { active: 'activating', mainPid: 0 }
  const calls: string[][] = []
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    calls.push([...args])
    if (args.includes('stop')) {
      state = { active: 'inactive', mainPid: 0 }
      return exited(0)
    }
    return exited(0, [`LoadState=loaded`, `ActiveState=${state.active}`, `FragmentPath=${fx.unitPath}`, 'DropInPaths=', `MainPID=${String(state.mainPid)}`, `UnitFileState=disabled`, ''].join('\n'))
  }
  const result = await stopOwnedProfileUnit(unit, undefined, run)
  assert.equal(result.stopped, true, 'an activating unit must be stopped through the manager, not treated as already inactive')
  assert.equal(result.alreadyInactive, false)
  assert.equal(calls.some(args => args.includes('stop')), true, 'systemctl stop must be issued for an activating unit')
})

test('an unrecognized unit state is refused instead of claimed as stopped', async t => {
  const fx = controlledUnitFixture(t)
  const unit = inspectOwnedProfileUnit(fx.scope, 'pi-tui', fx.unitDir)
  if (unit.kind !== 'owned') return assert.fail('expected an owned unit')
  const calls: string[][] = []
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    calls.push([...args])
    return exited(0, ['LoadState=loaded', 'ActiveState=maintenance', `FragmentPath=${fx.unitPath}`, 'DropInPaths=', 'MainPID=0', 'UnitFileState=disabled', ''].join('\n'))
  }
  await assert.rejects(
    () => stopOwnedProfileUnit(unit, undefined, run),
    error => isCode(error, 'HOST_MANAGER_START_FAILED'),
  )
  assert.equal(calls.some(args => args.includes('stop')), false, 'an unrecognized state must not be silently stopped or claimed')
})

test('a stop that never leaves the active state is HOST_STOP_TIMEOUT, never success', async t => {
  const fx = controlledUnitFixture(t)
  const unit = inspectOwnedProfileUnit(fx.scope, 'pi-tui', fx.unitDir)
  if (unit.kind !== 'owned') return assert.fail('expected an owned unit')
  const fake = managerState(fx.unitPath, 'active', 4242)
  await assert.rejects(() => stopOwnedProfileUnit(unit, undefined, fake.run, 50), error => isCode(error, 'HOST_STOP_TIMEOUT'))
})

test('uninstallOwnedProfileUnit removes only the verified profile unit file', t => {
  const fx = controlledUnitFixture(t)
  const unit = inspectOwnedProfileUnit(fx.scope, 'pi-tui', fx.unitDir)
  if (unit.kind !== 'owned') return assert.fail('expected an owned unit')
  uninstallOwnedProfileUnit(unit, fx.scope, 'pi-tui')
  assert.equal(existsSync(fx.unitPath), false)
  assert.equal(existsSync(join(fx.scope.dir, 'instance.json')), false)
})
