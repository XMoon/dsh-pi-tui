/**
 * M6 UX PR2 Step B: the ONE Client-local daemon administration port.
 *
 * Evidence level: structural composition seam (L2/L3). These tests prove the
 * port is a pure profile-bound wrapper over the EXISTING
 * `local-daemon-control.runDaemonControl` — same Profile facts, same verbs,
 * same stable failure taxonomy — and that constructing or idling the port never
 * reaches an OS manager. The real OS install/stop evidence stays with the
 * selectable split-process lanes (`daemon-controls-m6-2c`, macOS launchd D4L).
 * @module @xmoon76/dsh-pi-tui/m6-ux-pr2-daemon-admin-integration.test
 */

import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createProfileDaemonAdmin,
  profileDaemonAdminRun,
  resolveDirectDaemonAdminProfile,
  type ProfileDaemonAdminVerb,
} from '../../src/app/remote-process/local-profile-daemon-admin.ts'
import type { DaemonControlProfile, DaemonControlResult } from '../../src/app/remote-process/local-daemon-control.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const PROFILE_A: DaemonControlProfile = {
  name: 'profile-a',
  dir: '/fixtures/.dsh/profiles/profile-a',
  home: '/fixtures/.dsh',
  installAnchor: '/fixtures/dsh/package.json',
  packageRoot: '/fixtures/pkg',
  dshVersion: '0.2.2-rc.5',
}

const PROFILE_B: DaemonControlProfile = {
  ...PROFILE_A,
  name: 'profile-b',
  dir: '/fixtures/.dsh/profiles/profile-b',
}

const recorded = (code: number): DaemonControlResult => ({ code, stdout: '', stderr: '' })

// ── the port is a pure profile-bound wrapper ────────────────────────────────

test('the port forwards each authorized verb to the bound run seam with the SAME identity', async () => {
  const calls: Array<{ verb: ProfileDaemonAdminVerb; profile: DaemonControlProfile }> = []
  const admin = createProfileDaemonAdmin(PROFILE_A, {
    run: async (verb) => {
      calls.push({ verb, profile: PROFILE_A })
      return recorded(0)
    },
  })
  assert.equal(admin.profile, 'profile-a')
  const install = await admin.run('install')
  const stop = await admin.run('stop')
  assert.deepEqual(calls.map(call => call.verb), ['install', 'stop'])
  assert.ok(calls.every(call => call.profile === PROFILE_A), 'every call is bound to the captured Profile')
  assert.deepEqual([install.code, stop.code], [0, 0], 'the existing result is forwarded unchanged')
})

test('the port never mutates the captured Profile and exposes no extra verbs', () => {
  const admin = createProfileDaemonAdmin(PROFILE_A, { run: async () => recorded(0) })
  assert.deepEqual(Object.keys(admin).sort(), ['profile', 'run'], 'only the port surface exists')
  // The frozen profile copy cannot be redirected to another profile identity.
  assert.notEqual(admin.profile, PROFILE_B.name)
})

test('profile A and profile B ports stay distinct identities — one cannot address the other', async () => {
  const seen: string[] = []
  const adminA = createProfileDaemonAdmin(PROFILE_A, {
    run: async () => { seen.push('A'); return recorded(0) },
  })
  const adminB = createProfileDaemonAdmin(PROFILE_B, {
    run: async () => { seen.push('B'); return recorded(0) },
  })
  await adminA.run('stop')
  await adminB.run('stop')
  assert.deepEqual(seen, ['A', 'B'], 'each port drives only its own bound Profile')
})

test('the port performs NO manager IO at construction and while idle', async () => {
  let runCalls = 0
  createProfileDaemonAdmin(PROFILE_A, { run: async () => { runCalls += 1; return recorded(0) } })
  profileDaemonAdminRun(PROFILE_A, {
    platform: 'linux',
    systemctl: async () => {
      throw new Error('the manager must not be probed before an explicit user action')
    },
  })
  assert.equal(runCalls, 0, 'constructing the port and its run seam performs zero IO')
})

// ── the run seam is a lazy wrapper over runDaemonControl ────────────────────

test('the run seam reaches the existing control plane with the bound Profile and stable failure classes', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('m62c-admin-')
  const profile = {
    name: 'pi-tui',
    dir: join(root, 'profiles', 'pi-tui'),
    home: root,
    installAnchor: join(root, 'anchor', 'package.json'),
    packageRoot: root,
    dshVersion: '0.2.2-rc.5',
  }
  mkdirSync(profile.dir, { recursive: true })
  mkdirSync(join(root, 'anchor'), { recursive: true })
  writeFileSync(join(root, 'anchor', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' }))
  const run = profileDaemonAdminRun(profile, { platform: 'win32' })
  const result = await run('install')
  assert.equal(result.code, 3, 'the stable unsupported-platform class is preserved')
  assert.match(result.stderr, /UNSUPPORTED_PLATFORM/u, 'the stable reason reaches the caller unchanged')
})

test('the run seam does NOT pass an already-aborted caller signal as its own cancellation', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('m62c-abort-')
  const profile = {
    name: 'pi-tui',
    dir: join(root, 'profiles', 'pi-tui'),
    home: root,
    installAnchor: join(root, 'anchor', 'package.json'),
    packageRoot: root,
    dshVersion: '0.2.2-rc.5',
  }
  mkdirSync(profile.dir, { recursive: true })
  mkdirSync(join(root, 'anchor'), { recursive: true })
  writeFileSync(join(root, 'anchor', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' }))
  // The controller owns the admin lifetime: the surface abort signal must not
  // cancel an already-committed Host stop, so the run seam takes no signal.
  const run = profileDaemonAdminRun(profile, { platform: 'win32' })
  const result = await run('stop')
  assert.equal(result.code, 3)
  assert.match(result.stderr, /UNSUPPORTED_PLATFORM/u)
})

// ── Direct-side identity resolution reuses the official rules ──────────────

test('resolveDirectDaemonAdminProfile reuses the official package-root resolution', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('m62c-direct-')
  const profile = directProfileFixture(root, '@xmoon76/dsh-pi-tui')
  const resolved = resolveDirectDaemonAdminProfile(profile.context)
  assert.ok(resolved !== undefined, 'an installable profile proves the official bundle')
  assert.equal(resolved.name, 'pi-tui')
  assert.equal(resolved.home, root)
  assert.equal(resolved.installAnchor, profile.context.installAnchor)
  assert.equal(resolved.packageRoot, profile.packageRoot)
  assert.equal(resolved.dshVersion, '0.2.2-rc.5')
})

test('a Direct profile that cannot resolve the installed bundle fails closed with the official error', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('m62c-missing-')
  const profileDir = join(root, 'profiles', 'pi-tui')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'pi-tui' }))
  assert.throws(
    () => resolveDirectDaemonAdminProfile({
      name: 'pi-tui',
      dir: profileDir,
      home: root,
      installAnchor: join(root, 'anchor', 'package.json'),
    }),
    /does not resolve the installed @xmoon76\/dsh-pi-tui/u,
    'an unprovable identity is a hard failure, never a fallback',
  )
})

test('an installed manifest with a foreign package name fails closed', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('m62c-foreign-')
  const profile = directProfileFixture(root, 'someone-else')
  assert.throws(
    () => resolveDirectDaemonAdminProfile(profile.context),
    /resolves a different package/u,
    'a foreign bundle is never accepted as the official install',
  )
})

/** Build a profile whose `node_modules` resolves the given package name. */
function directProfileFixture(root: string, packageName: string): {
  readonly context: { name: string; dir: string; home: string; installAnchor: string }
  readonly packageRoot: string
} {
  const packageRoot = join(root, 'packages', 'bundle')
  const anchorDir = join(root, 'anchor', 'node_modules', '@deepseek-ai', 'dsh')
  const profileDir = join(root, 'profiles', 'pi-tui')
  mkdirSync(join(packageRoot, 'dist'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: packageName, version: '0.5.7' }))
  writeFileSync(join(packageRoot, 'dist', 'local-client.mjs'), 'export {}\n')
  mkdirSync(anchorDir, { recursive: true })
  writeFileSync(join(anchorDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' }))
  // The npm store layout: the profile's node_modules holds a symlink to the
  // installed bundle, so the official realpath resolution lands on packageRoot.
  const installedParent = join(profileDir, 'node_modules', '@xmoon76')
  mkdirSync(installedParent, { recursive: true })
  symlinkSync(packageRoot, join(installedParent, 'dsh-pi-tui'), 'dir')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'pi-tui' }))
  return {
    context: { name: 'pi-tui', dir: profileDir, home: root, installAnchor: join(anchorDir, 'package.json') },
    packageRoot,
  }
}
