/**
 * M4-B1 local scope / discovery contracts.
 *
 * These tests cover the parts that do not need a full DSH boot: the canonical
 * per-profile scope, the private 0700/0600 file boundary, symlink rejection,
 * kernel process seats, the Linux starttime identity, the installed-build
 * fingerprint and the fail-closed discovery refusals. Real two-process
 * authentication lives in the tarball split-process smoke.
 *
 * @module @xmoon76/dsh-pi-tui/local-discovery.test
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import type { AddressInfo } from 'node:net'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  bindProcessSeat,
  bindProfileKernelSeat,
  computeBuildId,
  darwinHostProfileSeatDir,
  inspectInstalledProfileScope,
  LocalScopeError,
  LOCAL_PROTOCOL,
  parseProcessStat,
  parseProcessStatStarttime,
  processSeatPath,
  readLinuxStarttime,
  removeOwnedScratch,
  readProcessStarttime,
  scopeFromInstalledProfile,
  type LocalScope,
} from '../../src/app/remote-process/local-scope.ts'
import {
  classifyDarwinReadOutcome,
  DARWIN_BSDINFO_BYTES,
  DARWIN_UNIQINFO_BYTES,
} from '../../src/runtime/native-process/darwin.ts'
import {
  listKernelGroupMembers,
  readKernelProcess,
  sameKernelProcess,
  type DarwinKernelProcessIdentity,
  type KernelObservation,
  type KernelProcessIdentity,
} from '../../src/runtime/native-process/identity.ts'
import {
  assertClientHostCompatible,
  assertHostPublicationIdentity,
  assertRecordedHostKernelIdentityCurrent,
  authenticateLocalHost,
  buildHostInstanceRecord,
  ensureLocalHost,
  inspectHostProcess,
  readLaunchMaterial,
  readLocalRecord,
  sameLocalInstanceRecord,
  writeLaunchMaterial,
  writeLocalRecord,
  type DarwinLocalInstanceRecord,
  type LinuxLocalInstanceRecord,
  type LocalInstanceRecord,
} from '../../src/app/remote-process/local-discovery.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface Fixture {
  readonly root: string
  readonly home: string
  readonly profile: string
  readonly packageRoot: string
}

/** One installed-package + profile fixture under a fresh 0700 temp root. */
function fixture(t: TestContext, version = '0.5.4', dshVersion = '0.2.1-rc.4'): Fixture {
  const root = testLifecycle(t).tempDir('dsh-m4-b1-test-')
  const home = join(root, 'dsh-home')
  const profile = join(root, 'profiles', 'pi-tui')
  const packageRoot = join(root, 'package')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  mkdirSync(join(packageRoot, 'dist'), { recursive: true, mode: 0o700 })
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version })}\n`)
  writeFileSync(join(packageRoot, 'dist', 'index.mjs'), 'export const value = 1\n')
  return { root, home, profile, packageRoot }
}

function scopeFor(value: Fixture, dshVersion = '0.2.1-rc.4'): LocalScope {
  return scopeFromInstalledProfile({
    dshHome: value.home,
    profileDir: value.profile,
    packageRoot: value.packageRoot,
    dshVersion,
  })
}

/** The frozen Linux schema fixture (Linux-only tests). */
function linuxRecordFor(scope: LocalScope, overrides: Partial<LinuxLocalInstanceRecord> = {}): LinuxLocalInstanceRecord {
  return {
    schema: 1,
    scopeId: scope.scopeId,
    profileRealpath: scope.profileRealpath,
    instanceId: randomUUID(),
    hostPid: process.pid,
    hostStarttime: readLinuxStarttime(),
    origin: 'http://127.0.0.1:41001',
    protocol: LOCAL_PROTOCOL,
    bundleVersion: scope.bundleVersion,
    dshVersion: scope.dshVersion,
    buildId: scope.buildId,
    ...overrides,
  }
}

/** The exact Darwin identity of this process, or a well-formed synthetic
 *  identity for a deliberately absent pid (so the liveness branch is real). */
function darwinIdentityFor(pid: number): DarwinKernelProcessIdentity {
  if (pid === process.pid) {
    const self = readKernelProcess(pid)
    if (self.kind === 'alive' && self.identity.platform === 'darwin') return self.identity
  }
  return {
    platform: 'darwin',
    pid,
    bootUUID: 'B24345D0-493C-461C-AB45-C3E6F55A40B5',
    uniqueId: '328530',
    parentUniqueId: '328529',
    processUUID: '0270d61394183ae9a1b1634739e39157',
    startSec: '1794876639',
    startUsec: '168170',
    ppid: 1,
    pgid: pid,
    sid: pid,
    uid: process.getuid?.() ?? 501,
    state: 2,
  }
}

/** One published record in the CURRENT platform's schema. */
function recordFor(scope: LocalScope, overrides: Record<string, unknown> = {}): LocalInstanceRecord {
  const {
    schema: _schema,
    hostStarttime: hostStarttimeOverride,
    hostKernelIdentity: kernelOverride,
    ...sharedOverrides
  } = overrides
  const shared = {
    scopeId: scope.scopeId,
    profileRealpath: scope.profileRealpath,
    instanceId: randomUUID(),
    hostPid: process.pid,
    origin: 'http://127.0.0.1:41001',
    protocol: LOCAL_PROTOCOL as typeof LOCAL_PROTOCOL,
    bundleVersion: scope.bundleVersion,
    dshVersion: scope.dshVersion,
    buildId: scope.buildId,
    ...sharedOverrides,
  }
  if (process.platform === 'linux') {
    return {
      schema: 1,
      ...shared,
      hostStarttime: typeof hostStarttimeOverride === 'string' ? hostStarttimeOverride : readLinuxStarttime(),
    }
  }
  return {
    schema: 2,
    ...shared,
    hostKernelIdentity: (kernelOverride as DarwinKernelProcessIdentity | undefined)
      ?? darwinIdentityFor(shared.hostPid as number),
  }
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

/** A TCP port that was just released by the kernel. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

test('one canonical profile yields one scope across DSH homes, symlinked spellings and package builds', t => {
  const first = fixture(t)
  const second = fixture(t, '0.5.5')
  try {
    // Both homes point at the same real profile directory; the scope id must
    // follow the canonical profile, not the caller's DSH home, cwd or build.
    const sharedProfile = join(first.root, 'shared-profile')
    mkdirSync(sharedProfile, { recursive: true, mode: 0o700 })
    const link = join(first.root, 'profile-link')
    symlinkSync(sharedProfile, link)
    const fromFirst = scopeFromInstalledProfile({
      dshHome: first.home,
      profileDir: sharedProfile,
      packageRoot: first.packageRoot,
      dshVersion: '0.2.1-rc.4',
    })
    const fromSecond = scopeFromInstalledProfile({
      dshHome: second.home,
      profileDir: link,
      packageRoot: second.packageRoot,
      dshVersion: '0.2.1-rc.4',
    })
    assert.notEqual(fromFirst.buildId, fromSecond.buildId, 'the two fixtures must carry different build fingerprints')
    assert.notEqual(fromFirst.bundleVersion, fromSecond.bundleVersion, 'the two fixtures must carry different bundle versions')
    assert.equal(fromFirst.scopeId, fromSecond.scopeId)
    assert.equal(fromFirst.profileRealpath, fromSecond.profileRealpath)
    assert.notEqual(fromFirst.dir, fromSecond.dir)

    // The scope algorithm is anchored independently, not only to its shape.
    const uid = process.getuid?.()
    assert.equal(typeof uid, 'number', 'this suite requires a Linux uid')
    const canonicalProfile = realpathSync(sharedProfile)
    const expectedScopeId = createHash('sha256')
      .update(`dsh-pi-tui/local-scope/1\0${String(uid)}\0${canonicalProfile}`)
      .digest('hex')
    assert.equal(fromFirst.scopeId, expectedScopeId)
    assert.match(fromFirst.scopeId, /^[0-9a-f]{64}$/u)
    assert.equal(fromFirst.hostSocketName, `\0dsh-pi-tui-h-${expectedScopeId.slice(0, 40)}`)
    assert.equal(fromFirst.clientSeatSocketName, `\0dsh-pi-tui-c-${expectedScopeId.slice(0, 40)}`)
    const unpublishedLegacyDomain = createHash('sha256')
      .update(`dsh-pi-tui/m4-b1\0${String(uid)}\0${canonicalProfile}`)
      .digest('hex')
    assert.notEqual(fromFirst.scopeId, unpublishedLegacyDomain, 'the retired internal scope domain must not be live')

    const other = fixture(t)
    try {
      const otherScope = scopeFor({ ...other, profile: other.profile })
      assert.notEqual(otherScope.scopeId, fromFirst.scopeId)
    } finally {
      cleanup(other.root)
    }
  } finally {
    cleanup(first.root)
    cleanup(second.root)
  }
})

test('read-only scope inspection creates no run directory and preserves the official DSH home', t => {
  const value = fixture(t)
  try {
    const inspected = inspectInstalledProfileScope({
      dshHome: value.home,
      profileDir: value.profile,
      packageRoot: value.packageRoot,
      dshVersion: '0.2.1-rc.4',
    })
    assert.equal(existsSync(join(value.home, 'run')), false, 'the read-only inspection must not create the run directory')
    const realHome = realpathSync(value.home)
    assert.equal(inspected.dshHome, realHome)
    assert.equal(inspected.dir, join(realHome, 'run', 'dsh-pi-tui', inspected.scopeId))
    assert.equal(existsSync(inspected.dir), false, 'the inspected .dir is only the expected path, not a created one')
    // The mutating form composes the SAME identity and creates the 0700 directory.
    const scope = scopeFromInstalledProfile({
      dshHome: value.home,
      profileDir: value.profile,
      packageRoot: value.packageRoot,
      dshVersion: '0.2.1-rc.4',
    })
    assert.equal(scope.scopeId, inspected.scopeId)
    assert.equal(scope.dshHome, inspected.dshHome)
    assert.equal(scope.dir, inspected.dir)
    assert.equal(lstatSync(scope.dir).mode & 0o777, 0o700)
    assert.equal(existsSync(scope.dir), true)
  } finally {
    cleanup(value.root)
  }
})

test('the run directory is 0700 and registry/launch files are 0600', t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    assert.equal(lstatSync(scope.dir).mode & 0o777, 0o700)
    const record = recordFor(scope)
    writeLocalRecord(scope, record)
    writeLaunchMaterial(scope, record, {
      schema: 1,
      instanceId: record.instanceId,
      connectUrl: `${record.origin}/connect?token=fixture-token`,
    })
    assert.equal(lstatSync(join(scope.dir, 'instance.json')).mode & 0o777, 0o600)
    assert.equal(lstatSync(join(scope.dir, 'launch.json')).mode & 0o777, 0o600)
    assert.deepEqual(readLocalRecord(scope), record)
    assert.equal(readLaunchMaterial(scope, record).instanceId, record.instanceId)
  } finally {
    cleanup(value.root)
  }
})

test('existing registry/launch modes are not part of the read policy while new writes stay private', t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const record = recordFor(scope)
    writeLocalRecord(scope, record)
    writeLaunchMaterial(scope, record, {
      schema: 1,
      instanceId: record.instanceId,
      connectUrl: `${record.origin}/connect?token=fixture-token`,
    })
    // A user-chosen mode on an EXISTING managed file is not a product policy:
    // the records stay readable while the real JSON/schema/instance checks run.
    chmodSync(join(scope.dir, 'instance.json'), 0o644)
    chmodSync(join(scope.dir, 'launch.json'), 0o644)
    assert.deepEqual(readLocalRecord(scope), record)
    assert.equal(readLaunchMaterial(scope, record).instanceId, record.instanceId)
    // A NEW write still creates a private 0600 file at the private 0700 scope.
    writeLocalRecord(scope, record)
    assert.equal(lstatSync(join(scope.dir, 'instance.json')).mode & 0o777, 0o600)
    assert.equal(lstatSync(join(scope.dir, 'launch.json')).mode & 0o777, 0o644, 'an existing user mode is never chmodded')
  } finally {
    cleanup(value.root)
  }
})

test('a final registry symlink is rejected while a symlinked run chain is accepted', t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const record = recordFor(scope)
    writeLocalRecord(scope, record)
    const target = join(value.root, 'attacker-record.json')
    writeFileSync(target, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    const registry = join(scope.dir, 'instance.json')
    rmSync(registry)
    symlinkSync(target, registry)
    // The internal managed file never follows its FINAL symlink.
    assert.throws(
      () => readLocalRecord(scope),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'LOCAL_FILE_UNSAFE',
    )

    const symlinked = fixture(t)
    try {
      const outside = join(symlinked.root, 'outside-run')
      mkdirSync(outside, { recursive: true, mode: 0o700 })
      symlinkSync(outside, join(symlinked.home, 'run'))
      // A legal symlink in the user's existing layout is followed; the private
      // scope directory is created through it.
      const linkedScope = scopeFor(symlinked)
      assert.equal(existsSync(join(outside, 'dsh-pi-tui', linkedScope.scopeId)), true)
      assert.equal(lstatSync(linkedScope.dir).mode & 0o777, 0o700)
    } finally {
      cleanup(symlinked.root)
    }
  } finally {
    cleanup(value.root)
  }
})

test('Linux process starttime identifies the live Host and rejects PID reuse', { skip: process.platform !== 'linux' ? 'Linux /proc starttime is the frozen Linux-only contract' : false }, t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const live = linuxRecordFor(scope, { hostPid: process.pid, hostStarttime: readLinuxStarttime() })
    assert.equal(readLinuxStarttime(process.pid), readProcessStarttime(process.pid))
    assert.equal(inspectHostProcess(live), 'alive')
    assert.equal(inspectHostProcess({ ...live, hostStarttime: `${live.hostStarttime}0` }), 'dead')
    assert.equal(inspectHostProcess({ ...live, hostPid: 999_999_999 }), 'dead')
  } finally {
    cleanup(value.root)
  }
})

test('the installed-build fingerprint changes with payload, bundle version and DSH version', t => {
  const value = fixture(t)
  try {
    const base = computeBuildId(value.packageRoot, '0.2.1-rc.4')
    assert.equal(base, computeBuildId(value.packageRoot, '0.2.1-rc.4'))
    writeFileSync(join(value.packageRoot, 'dist', 'index.mjs'), 'export const value = 2\n')
    const payloadChanged = computeBuildId(value.packageRoot, '0.2.1-rc.4')
    assert.notEqual(payloadChanged, base)
    writeFileSync(join(value.packageRoot, 'dist', 'extra.mjs'), 'export const extra = 1\n')
    const fileAdded = computeBuildId(value.packageRoot, '0.2.1-rc.4')
    assert.notEqual(fileAdded, payloadChanged)
    writeFileSync(
      join(value.packageRoot, 'package.json'),
      `${JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version: '0.5.5' })}\n`,
    )
    const bundleChanged = computeBuildId(value.packageRoot, '0.2.1-rc.4')
    assert.notEqual(bundleChanged, fileAdded)
    assert.notEqual(computeBuildId(value.packageRoot, '0.2.1-rc.5'), bundleChanged)
  } finally {
    cleanup(value.root)
  }
})

test('the installed-build fingerprint follows shared-store dist and .mjs symlinks', t => {
  const value = fixture(t)
  try {
    const plain = computeBuildId(value.packageRoot, '0.2.1-rc.4')
    const dist = join(value.packageRoot, 'dist')
    const realDist = join(value.root, 'dist-real')
    rmSync(dist, { recursive: true })
    mkdirSync(realDist, { recursive: true })
    writeFileSync(join(realDist, 'index.mjs'), 'export const value = 1\n')
    symlinkSync(realDist, dist)
    assert.equal(computeBuildId(value.packageRoot, '0.2.1-rc.4'), plain, 'an identical dist symlink keeps the same build identity')

    // A symlinked .mjs contributes the SAME relative path + actual target bytes.
    const shared = join(value.root, 'shared-module.mjs')
    writeFileSync(shared, 'export const shared = 1\n')
    symlinkSync(shared, join(dist, 'shared.mjs'))
    const withLink = computeBuildId(value.packageRoot, '0.2.1-rc.4')
    const twin = fixture(t)
    try {
      writeFileSync(join(twin.packageRoot, 'dist', 'shared.mjs'), 'export const shared = 1\n')
      assert.equal(withLink, computeBuildId(twin.packageRoot, '0.2.1-rc.4'), 'a symlink and a regular file with the same bytes must fingerprint identically')
    } finally {
      cleanup(twin.root)
    }
    writeFileSync(shared, 'export const shared = 2\n')
    assert.notEqual(computeBuildId(value.packageRoot, '0.2.1-rc.4'), withLink, 'the target bytes are part of the build identity')
  } finally {
    cleanup(value.root)
  }
})

test('the installed-build fingerprint refuses dangling and cyclic symlinks instead of skipping them', t => {
  const value = fixture(t)
  try {
    const dist = join(value.packageRoot, 'dist')
    symlinkSync(join(value.root, 'missing-target.mjs'), join(dist, 'dangling.mjs'))
    assert.throws(
      () => computeBuildId(value.packageRoot, '0.2.1-rc.4'),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'SCOPE_DIRECTORY_UNSAFE',
    )
    rmSync(join(dist, 'dangling.mjs'))
    symlinkSync(dist, join(dist, 'loop'))
    assert.throws(
      () => computeBuildId(value.packageRoot, '0.2.1-rc.4'),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'SCOPE_DIRECTORY_UNSAFE',
    )
  } finally {
    cleanup(value.root)
  }
})

test('Client admission accepts one protocol and DSH runtime across package builds', t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const record = recordFor(scope)
    assert.doesNotThrow(() => assertClientHostCompatible(record, scope))
    assert.doesNotThrow(() => assertClientHostCompatible(
      { ...record, buildId: 'a'.repeat(64), bundleVersion: '9.9.9' },
      scope,
    ), 'a different installed build must not block Client admission')
    assert.doesNotThrow(() => assertHostPublicationIdentity(record, scope))
    for (const [field, changed] of [
      ['protocol', { protocol: 'dsh-pi-tui/local/2' as typeof LOCAL_PROTOCOL }],
      ['bundleVersion', { bundleVersion: '9.9.9' }],
      ['dshVersion', { dshVersion: '0.2.1-rc.5' }],
      ['buildId', { buildId: 'a'.repeat(64) }],
    ] as const) {
      assert.throws(
        () => assertHostPublicationIdentity({ ...record, ...changed }, scope),
        (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_BUILD_INCOMPATIBLE',
        `Host publication accepted a mismatched ${field}`,
      )
    }
  } finally {
    cleanup(value.root)
  }
})

test('Client admission refuses another protocol, the retired protocol name and another DSH runtime', t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const record = recordFor(scope)
    for (const [label, changed] of [
      ['a future protocol major', { protocol: 'dsh-pi-tui/local/2' as typeof LOCAL_PROTOCOL }],
      ['the retired internal protocol name', { protocol: 'm4-b1/1' as typeof LOCAL_PROTOCOL }],
      ['another DSH runtime', { dshVersion: '0.2.1-rc.5' }],
    ] as const) {
      assert.throws(
        () => assertClientHostCompatible({ ...record, ...changed }, scope),
        (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_PROTOCOL_INCOMPATIBLE',
        `${label} was admitted`,
      )
    }
  } finally {
    cleanup(value.root)
  }
})

test('Host publication rejects an identity that differs from its own installed build without rewriting files', t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const record = recordFor(scope)
    writeLocalRecord(scope, record)
    writeLaunchMaterial(scope, record, {
      schema: 1,
      instanceId: record.instanceId,
      connectUrl: `${record.origin}/connect?token=fixture-token`,
    })
    const registryPath = join(scope.dir, 'instance.json')
    const launchPath = join(scope.dir, 'launch.json')
    const registryBefore = { bytes: readFileSync(registryPath), mode: lstatSync(registryPath).mode & 0o777 }
    const launchBefore = { bytes: readFileSync(launchPath), mode: lstatSync(launchPath).mode & 0o777 }
    assert.throws(
      () => writeLocalRecord(scope, { ...record, buildId: 'a'.repeat(64) }),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_BUILD_INCOMPATIBLE',
    )
    assert.deepEqual(readFileSync(registryPath), registryBefore.bytes, 'a rejected publication rewrote the registry')
    assert.equal(lstatSync(registryPath).mode & 0o777, registryBefore.mode, 'a rejected publication changed the registry mode')
    assert.throws(
      () => writeLaunchMaterial(scope, { ...record, bundleVersion: '9.9.9' }, {
        schema: 1,
        instanceId: record.instanceId,
        connectUrl: `${record.origin}/connect?token=fixture-token`,
      }),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_BUILD_INCOMPATIBLE',
    )
    assert.deepEqual(readFileSync(launchPath), launchBefore.bytes, 'a rejected publication rewrote the launch material')
    assert.equal(lstatSync(launchPath).mode & 0o777, launchBefore.mode, 'a rejected publication changed the launch mode')
  } finally {
    cleanup(value.root)
  }
})

test('registry token injection, wrong origin and a launch naming another instance are rejected', t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const record = recordFor(scope)
    const registry = join(scope.dir, 'instance.json')
    writeFileSync(registry, `${JSON.stringify({ ...record, token: 'not-allowed' })}\n`, { mode: 0o600 })
    assert.throws(
      () => readLocalRecord(scope),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'LOCAL_FILE_UNSAFE',
    )
    writeFileSync(registry, `${JSON.stringify({ ...record, origin: 'http://localhost:41001' })}\n`, { mode: 0o600 })
    assert.throws(
      () => readLocalRecord(scope),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'LOCAL_FILE_UNSAFE',
    )
    writeLocalRecord(scope, record)
    writeFileSync(join(scope.dir, 'launch.json'), `${JSON.stringify({
      schema: 1,
      instanceId: randomUUID(),
      connectUrl: `${record.origin}/connect?token=fixture-token`,
    })}\n`, { mode: 0o600 })
    assert.throws(
      () => readLaunchMaterial(scope, record),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_IDENTITY_MISMATCH',
    )
  } finally {
    cleanup(value.root)
  }
})

test('an existing 0755/0775 run chain is accepted without chmodding and new components are 0700', t => {
  const value = fixture(t)
  try {
    const runRoot = join(value.home, 'run')
    mkdirSync(runRoot, { mode: 0o755 })
    chmodSync(runRoot, 0o755)
    const scope = scopeFor(value)
    assert.equal(lstatSync(runRoot).mode & 0o777, 0o755, 'existing user directory modes are never rewritten')
    assert.equal(lstatSync(join(runRoot, 'dsh-pi-tui')).mode & 0o777, 0o700, 'a new scope root is private')
    assert.equal(lstatSync(scope.dir).mode & 0o777, 0o700, 'a new scope directory is private')

    const second = fixture(t)
    try {
      const secondRun = join(second.home, 'run')
      mkdirSync(secondRun, { mode: 0o775 })
      chmodSync(secondRun, 0o775)
      const scopeRoot = join(secondRun, 'dsh-pi-tui')
      mkdirSync(scopeRoot, { mode: 0o775 })
      chmodSync(scopeRoot, 0o775)
      const value2 = scopeFor(second)
      assert.equal(lstatSync(scopeRoot).mode & 0o777, 0o775)
      assert.equal(lstatSync(value2.dir).mode & 0o777, 0o700)
    } finally {
      cleanup(second.root)
    }
  } finally {
    cleanup(value.root)
  }
})

test('an official DSH home outside the current uid is accepted for read-only inspection', t => {
  const rootInfo = lstatSync('/tmp')
  if (rootInfo.uid === process.getuid?.()) {
    t.skip('no root-owned system directory is available')
    return
  }
  const value = fixture(t)
  try {
    // The read-only inspection judges accessibility/type, not ownership: a
    // root-owned official DSH home (a system install layout) is a legal input.
    const inspected = inspectInstalledProfileScope({
      dshHome: '/tmp',
      profileDir: value.profile,
      packageRoot: value.packageRoot,
      dshVersion: '0.2.1-rc.4',
    })
    assert.equal(inspected.dshHome, realpathSync('/tmp'))
    assert.equal(existsSync(join(inspected.dir)), false, 'read-only inspection must create nothing')
  } finally {
    cleanup(value.root)
  }
})

test('the /proc stat parser keeps the long-lived local-scope behavior', () => {
  // The comm field may contain spaces and parentheses; everything after the
  // LAST ')' is the fixed positional tail. Field 3 (state) and field 22
  // (starttime) are the only facts local-scope's parser exposes.
  const stat = '4321 (a (weird) comm) S 4300 4310 4300 34816 4310 4194560 100 0 0 0 1 2 4 0 20 0 1 0 98765 123456789 800 18446744073709551615'
  assert.deepEqual(parseProcessStat(stat), { state: 'S', starttime: '98765' })
  assert.equal(parseProcessStatStarttime(stat), '98765')
  assert.equal(parseProcessStat('no-paren stat'), undefined)
  assert.equal(parseProcessStat('1 (x) ? 1 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 not-a-tick'), undefined)
  assert.equal(parseProcessStatStarttime(''), undefined)
})

test('sameKernelProcess classifies reuse, absence and unverifiable reads without guessing', () => {
  const linux: KernelProcessIdentity = {
    platform: 'linux', pid: 4321, startTicks: '98765', ppid: 4300, pgid: 4321, sid: 4321, state: 'S',
  }
  const linuxObserved = (overrides: Partial<KernelProcessIdentity> = {}): { kind: 'alive'; identity: KernelProcessIdentity } => ({
    kind: 'alive',
    identity: { ...linux, ...overrides } as KernelProcessIdentity,
  })
  assert.equal(sameKernelProcess(linux, linuxObserved()), 'same')
  // A reused pid carries a different starttime.
  assert.equal(sameKernelProcess(linux, linuxObserved({ startTicks: '98766' })), 'different')
  // A changed state (e.g. zombie) is the SAME process: state is not identity.
  assert.equal(sameKernelProcess(linux, linuxObserved({ state: 'Z' })), 'same')
  assert.equal(sameKernelProcess(linux, linuxObserved({ pid: 4322 })), 'different')
  assert.equal(sameKernelProcess(linux, { kind: 'gone' }), 'gone')
  assert.equal(sameKernelProcess(linux, { kind: 'unknown', code: 'ACCESS_DENIED' }), 'unknown')
  assert.equal(sameKernelProcess(linux, { kind: 'unknown', code: 'READ_FAILED' }), 'unknown')

  const darwin: KernelProcessIdentity = {
    platform: 'darwin', pid: 77, bootUUID: 'B24345D0-493C-461C-AB45-C3E6F55A40B5',
    uniqueId: '328530', parentUniqueId: '328529', processUUID: '0270d61394183ae9a1b1634739e39157',
    startSec: '1794876639', startUsec: '168170', ppid: 10, pgid: 77, sid: 77, uid: 501, state: 2,
  }
  const darwinObserved = (overrides: Partial<KernelProcessIdentity> = {}): { kind: 'alive'; identity: KernelProcessIdentity } => ({
    kind: 'alive',
    identity: { ...darwin, ...overrides } as KernelProcessIdentity,
  })
  assert.equal(sameKernelProcess(darwin, darwinObserved()), 'same')
  assert.equal(sameKernelProcess(darwin, darwinObserved({ uniqueId: '328531' })), 'different')
  assert.equal(sameKernelProcess(darwin, darwinObserved({ bootUUID: '00000000-0000-0000-0000-000000000000' })), 'different')
  assert.equal(sameKernelProcess(darwin, darwinObserved({ startUsec: '168171' })), 'different')
  assert.equal(sameKernelProcess(darwin, darwinObserved({ processUUID: 'ff'.repeat(16) })), 'different')
  // A platform mismatch can never be the same process.
  assert.equal(sameKernelProcess(darwin, linuxObserved()), 'different')
})

test('the Darwin native read classifier refuses every truncated or unverifiable ABI reply', () => {
  assert.deepEqual(classifyDarwinReadOutcome(DARWIN_BSDINFO_BYTES, DARWIN_BSDINFO_BYTES, 0), { kind: 'ok' })
  assert.deepEqual(classifyDarwinReadOutcome(DARWIN_UNIQINFO_BYTES, DARWIN_UNIQINFO_BYTES, 0), { kind: 'ok' })
  // The historical 40-byte flavor-17 reply must never be accepted as a
  // truncated identity, and a larger surprise is no better.
  assert.deepEqual(classifyDarwinReadOutcome(DARWIN_UNIQINFO_BYTES, 40, 0), { kind: 'unknown', code: 'ABI_UNSUPPORTED' })
  assert.deepEqual(classifyDarwinReadOutcome(DARWIN_BSDINFO_BYTES, DARWIN_BSDINFO_BYTES + 8, 0), { kind: 'unknown', code: 'ABI_UNSUPPORTED' })
  assert.deepEqual(classifyDarwinReadOutcome(DARWIN_BSDINFO_BYTES, 0, 3), { kind: 'gone' })
  assert.deepEqual(classifyDarwinReadOutcome(DARWIN_BSDINFO_BYTES, 0, 1), { kind: 'unknown', code: 'ACCESS_DENIED' })
  assert.deepEqual(classifyDarwinReadOutcome(DARWIN_BSDINFO_BYTES, 0, 13), { kind: 'unknown', code: 'ACCESS_DENIED' })
  assert.deepEqual(classifyDarwinReadOutcome(DARWIN_BSDINFO_BYTES, 0, 22), { kind: 'unknown', code: 'ABI_UNSUPPORTED' })
  assert.deepEqual(classifyDarwinReadOutcome(DARWIN_BSDINFO_BYTES, 0, 0), { kind: 'unknown', code: 'READ_FAILED' })
})

test('readKernelProcess returns the current platform identity and a definitive absence', () => {
  const self = readKernelProcess(process.pid)
  assert.equal(self.kind, 'alive')
  if (self.kind !== 'alive') return
  assert.equal(self.identity.pid, process.pid)
  if (process.platform === 'linux') {
    assert.equal(self.identity.platform, 'linux')
    assert.match((self.identity as { readonly startTicks: string }).startTicks, /^\d+$/u)
  } else if (process.platform === 'darwin') {
    assert.equal(self.identity.platform, 'darwin')
    const darwin = self.identity as Extract<KernelProcessIdentity, { platform: 'darwin' }>
    assert.match(darwin.bootUUID, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/iu)
    assert.match(darwin.uniqueId, /^\d+$/u)
    assert.match(darwin.startSec, /^\d+$/u)
    assert.equal(darwin.sid, self.identity.sid)
    // The SAME pid read twice is the same process; a stranger's identity is not.
    assert.equal(sameKernelProcess(self.identity, readKernelProcess(process.pid)), 'same')
    assert.equal(sameKernelProcess(self.identity, { kind: 'alive', identity: { ...self.identity, uniqueId: '0' } }), 'different')
  }
  // 2^22 is far beyond any configured pid_max/OS pid space in this environment;
  // a missing pid is a definitive absence, not an unknown read.
  assert.deepEqual(readKernelProcess(4_194_304), { kind: 'gone' })
  // A group that does not exist has no verifiable member.
  const members = listKernelGroupMembers(4_194_304)
  assert.ok(Array.isArray(members), `a missing group scan must not be unknown: ${JSON.stringify(members)}`)
  assert.deepEqual(members, [])
})

test('a definite missing PID is dead, while unreadable or malformed proc data is unavailable', { skip: process.platform !== 'linux' ? 'Linux /proc classification requires Linux' : false }, t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const record = linuxRecordFor(scope)
    const procRoot = join(value.root, 'fake-proc')
    mkdirSync(procRoot, { recursive: true, mode: 0o700 })
    assert.equal(inspectHostProcess(record, procRoot), 'dead', 'a missing proc entry is a definite dead PID')
    const pidDir = join(procRoot, String(record.hostPid))
    mkdirSync(pidDir, { mode: 0o700 })
    const statPath = join(pidDir, 'stat')
    writeFileSync(statPath, 'not-a-stat')
    assert.throws(
      () => inspectHostProcess(record, procRoot),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'PROCESS_STARTTIME_UNAVAILABLE',
    )
    const realStat = readFileSync('/proc/self/stat', 'utf8')
    const realStart = parseProcessStatStarttime(realStat)
    assert.ok(realStart !== undefined, 'the host test process must expose a real starttime')
    writeFileSync(statPath, realStat)
    assert.equal(inspectHostProcess({ ...record, hostStarttime: realStart }, procRoot), 'alive')
    assert.equal(inspectHostProcess({ ...record, hostStarttime: '0' }, procRoot), 'dead')
    const liveStat = parseProcessStat(realStat)
    assert.ok(liveStat !== undefined, 'the live stat must expose state and starttime')
    const close = realStat.lastIndexOf(')')
    const zombieStat = `${realStat.slice(0, close + 2)}Z${realStat.slice(close + 3)}`
    writeFileSync(statPath, zombieStat)
    assert.equal(
      inspectHostProcess({ ...record, hostStarttime: liveStat.starttime }, procRoot),
      'dead',
      'a matching-starttime zombie is dead, not a live Host',
    )
    chmodSync(statPath, 0o000)
    assert.throws(
      () => inspectHostProcess(record, procRoot),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'PROCESS_STARTTIME_UNAVAILABLE',
    )
    chmodSync(statPath, 0o600)
  } finally {
    cleanup(value.root)
  }
})

test('a real unreaped child zombie is dead and the kernel Host seat is claimable', { skip: process.platform !== 'linux' ? 'Linux /proc zombie and abstract-seat contract requires Linux' : false }, async t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const holder = spawn('sh', ['-c', 'sleep 60 & echo $!; exec sleep 60'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    try {
      const pid = await new Promise<number>((resolve, reject) => {
        // bounded deadline: the holder must print its child pid promptly.
        const timer = setTimeout(() => reject(new Error('the zombie holder did not print a child pid')), 5_000)
        holder.stdout!.once('data', (chunk: Buffer) => {
          clearTimeout(timer)
          const line = chunk.toString('utf8').split('\n')[0].trim()
          const parsed = Number(line)
          if (!Number.isInteger(parsed) || parsed <= 0) reject(new Error(`bad zombie child pid: ${line}`))
          else resolve(parsed)
        })
      })
      const before = parseProcessStat(readFileSync(`/proc/${String(pid)}/stat`, 'utf8'))
      assert.ok(before !== undefined, 'the killed child has no parseable stat')
      process.kill(pid, 'SIGKILL')
      let zombie
      for (let attempt = 0; attempt < 500; attempt += 1) {
        try {
          zombie = parseProcessStat(readFileSync(`/proc/${String(pid)}/stat`, 'utf8'))
        } catch {
          zombie = undefined
        }
        if (zombie?.state === 'Z') break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(zombie?.state, 'Z', 'the killed child never became an OS zombie')
      assert.equal(zombie.starttime, before.starttime, 'the zombie starttime changed')
      assert.equal(
        inspectHostProcess(linuxRecordFor(scope, { hostPid: pid, hostStarttime: before.starttime })),
        'dead',
        'the real zombie was classified alive',
      )
      // The zombie holds no socket: the one kernel Host seat is free for a new Host.
      const seat = await bindProcessSeat(scope.hostSocketName, 'HOST_ALREADY_OWNED')
      await seat.close()
    } finally {
      holder.kill('SIGKILL')
      await new Promise<void>(resolve => holder.once('exit', () => resolve()))
    }
  } finally {
    cleanup(value.root)
  }
})

test('scratch removal is containment-scoped', t => {
  const root = testLifecycle(t).tempDir('dsh-m4-b1-scratch-')
  const scopeDir = join(root, 'scope')
  mkdirSync(scopeDir, { mode: 0o700 })
  const owned = join(scopeDir, 'host-scratch-owned')
  mkdirSync(owned, { mode: 0o700 })
  removeOwnedScratch(scopeDir, owned)
  assert.equal(existsSync(owned), false, 'an owned host-scratch child must be removed')

  const foreignParent = join(root, 'host-scratch-foreign')
  mkdirSync(foreignParent, { mode: 0o700 })
  removeOwnedScratch(scopeDir, foreignParent)
  assert.equal(existsSync(foreignParent), true, 'a scratch outside the scope must not be removed')

  const foreignName = join(scopeDir, 'not-a-host-scratch')
  mkdirSync(foreignName, { mode: 0o700 })
  removeOwnedScratch(scopeDir, foreignName)
  assert.equal(existsSync(foreignName), true, 'a non-host-scratch child must not be removed')
})

test('concurrent first scope creation converges without an unsafe-directory refusal', async t => {
  const value = fixture(t)
  try {
    const moduleUrl = pathToFileURL(join(ROOT, 'src', 'app', 'remote-process', 'local-scope.ts')).href
    const accountHome = join(value.root, 'account-home')
    mkdirSync(accountHome, { mode: 0o700 })
    const childPath = join(value.root, 'concurrent-scope.mts')
    writeFileSync(childPath, [
      `import { scopeFromInstalledProfile, bindProfileKernelSeat } from ${JSON.stringify(moduleUrl)}`,
      `const facts = ${JSON.stringify({
        dshHome: value.home,
        profileDir: value.profile,
        packageRoot: value.packageRoot,
        dshVersion: '0.2.1-rc.4',
      })}`,
      'try {',
      '  const scope = scopeFromInstalledProfile(facts)',
      '  try {',
      '    const seat = await bindProfileKernelSeat(scope, \'host\', \'HOST_ALREADY_OWNED\', { accountHome: process.env.TEST_ACCOUNT_HOME })',
      '    console.log(JSON.stringify({ result: \'won\' }))',
      '    // reason: hold the winning kernel seat for a bounded window so every concurrent contender reaches its seat attempt.',
      '    await new Promise(resolve => setTimeout(resolve, 1000))',
      '    await seat.close()',
      '  } catch (error) {',
      '    console.log(JSON.stringify({ result: error.code ?? error.message }))',
      '  }',
      '} catch (error) {',
      '  console.log(JSON.stringify({ result: error.code ?? error.message }))',
      '}',
      '',
    ].join('\n'))
    const children = Array.from({ length: 8 }, () => spawn(
      process.execPath,
      ['--import', 'tsx/esm', childPath],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEST_ACCOUNT_HOME: accountHome } },
    ))
    const results = await Promise.all(children.map(child => new Promise<{ result: string }>((resolveChild, rejectChild) => {
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('close', code => {
        if (code !== 0) {
          rejectChild(new Error(`concurrent scope child exited ${String(code)}: ${stderr.slice(-2000)}`))
          return
        }
        const lines = stdout.trim().split('\n').filter(Boolean)
        try {
          resolveChild(JSON.parse(lines[lines.length - 1] ?? '{}') as { result: string })
        } catch (error) {
          rejectChild(new Error(`concurrent scope child produced invalid JSON: ${stdout.slice(-1000)}`, { cause: error }))
        }
      })
    })))
    const outcomes = results.map(result => result.result)
    assert.equal(outcomes.includes('SCOPE_DIRECTORY_UNSAFE'), false, `a concurrent mkdir race surfaced as SCOPE_DIRECTORY_UNSAFE: ${JSON.stringify(outcomes)}`)
    assert.equal(outcomes.includes('LOCAL_FILE_UNSAFE'), false, `a concurrent mkdir race surfaced as LOCAL_FILE_UNSAFE: ${JSON.stringify(outcomes)}`)
    assert.ok(outcomes.includes('won'), `no concurrent contender won the seat: ${JSON.stringify(outcomes)}`)
    assert.ok(outcomes.includes('HOST_ALREADY_OWNED'), `no concurrent contender reached the kernel seat conflict: ${JSON.stringify(outcomes)}`)
  } finally {
    cleanup(value.root)
  }
})

test('the kernel seat is exclusive and becomes reusable after close', { skip: process.platform !== 'linux' ? 'Linux abstract seats require Linux; the macOS file seat has its own dispatch test' : false }, async () => {
  const name = `\0dsh-m4-b1-test-${String(process.pid)}-${randomUUID()}`
  const first = await bindProcessSeat(name, 'HOST_ALREADY_OWNED')
  try {
    // The live holder can prove its own kernel claim; a closed seat cannot.
    first.assertCurrent()
    await assert.rejects(
      bindProcessSeat(name, 'HOST_ALREADY_OWNED'),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_ALREADY_OWNED',
    )
    await assert.rejects(
      bindProcessSeat(name, 'CLIENT_ALREADY_ACTIVE'),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'CLIENT_ALREADY_ACTIVE',
    )
  } finally {
    await first.close()
  }
  assert.throws(
    () => first.assertCurrent(),
    (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_IDENTITY_MISMATCH',
  )
  const second = await bindProcessSeat(name, 'HOST_ALREADY_OWNED')
  second.assertCurrent()
  await second.close()
})

test('an unreachable or rejecting /connect is an explicit refusal, not a ready Host', async t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const deadPort = await closedPort()
    const unreachable = recordFor(scope, { origin: `http://127.0.0.1:${String(deadPort)}` })
    writeLocalRecord(scope, unreachable)
    writeLaunchMaterial(scope, unreachable, {
      schema: 1,
      instanceId: unreachable.instanceId,
      connectUrl: `${unreachable.origin}/connect?token=fixture-token`,
    })
    await assert.rejects(
      authenticateLocalHost(unreachable, scope),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_UNRESPONSIVE',
    )

    const rejecting = createHttpServer((_request, response) => {
      response.writeHead(401, { 'cache-control': 'no-store' })
      response.end('unauthorized')
    })
    await new Promise<void>((resolve, reject) => {
      rejecting.once('error', reject)
      rejecting.listen(0, '127.0.0.1', () => resolve())
    })
    try {
      const port = (rejecting.address() as AddressInfo).port
      const denied = recordFor(scope, { origin: `http://127.0.0.1:${String(port)}` })
      writeLocalRecord(scope, denied)
      writeLaunchMaterial(scope, denied, {
        schema: 1,
        instanceId: denied.instanceId,
        connectUrl: `${denied.origin}/connect?token=fixture-token`,
      })
      await assert.rejects(
        authenticateLocalHost(denied, scope),
        (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_AUTH_FAILED',
      )
    } finally {
      await new Promise<void>(resolve => rejecting.close(() => resolve()))
    }
  } finally {
    cleanup(value.root)
  }
})

test('a self-consistent Host build is admitted while a registry/identity build difference stays a mismatch', async t => {
  const value = fixture(t)
  let identity: LocalInstanceRecord | undefined
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/connect') {
      response.writeHead(302, {
        location: '/api/remote.mux',
        'cache-control': 'no-store',
        'set-cookie': 'dsh_session=fixture-cookie; Path=/; HttpOnly',
      })
      response.end()
      return
    }
    if (url.pathname === '/api/pi-tui.local-host') {
      if (request.headers.cookie !== 'dsh_session=fixture-cookie' || identity === undefined) {
        response.writeHead(401, { 'cache-control': 'no-store' })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(`${JSON.stringify(identity)}\n`)
      return
    }
    response.writeHead(404)
    response.end()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const scope = scopeFor(value)
    // This file fixture plays the Host's registry: it may carry a build that
    // differs from this Client's scope, but its authenticated echo must equal
    // the registry field by field.
    const hostRecord = recordFor(scope, { origin, buildId: 'c'.repeat(64), bundleVersion: '9.9.9' })
    identity = hostRecord
    assert.doesNotThrow(() => assertClientHostCompatible(hostRecord, scope))
    writeFileSync(join(scope.dir, 'instance.json'), `${JSON.stringify(hostRecord)}\n`, { mode: 0o600 })
    writeFileSync(join(scope.dir, 'launch.json'), `${JSON.stringify({
      schema: 1,
      instanceId: hostRecord.instanceId,
      connectUrl: `${origin}/connect?token=fixture-token`,
    })}\n`, { mode: 0o600 })
    const verified = await authenticateLocalHost(hostRecord, scope)
    assert.equal(verified.identity.buildId, hostRecord.buildId)
    assert.equal(verified.identity.bundleVersion, hostRecord.bundleVersion)
    assert.notEqual(verified.identity.buildId, scope.buildId, 'the Host echo must carry a different installed build')

    identity = { ...hostRecord, buildId: 'd'.repeat(64) }
    await assert.rejects(
      authenticateLocalHost(hostRecord, scope),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_IDENTITY_MISMATCH',
    )
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    cleanup(value.root)
  }
})

test('expected-instance handoff attaches only the exact authenticated Host and never spawns a Host', async t => {
  const value = fixture(t)
  let identity: LocalInstanceRecord | undefined
  let connectRequests = 0
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/connect') {
      connectRequests += 1
      response.writeHead(302, {
        location: '/api/remote.mux',
        'cache-control': 'no-store',
        'set-cookie': 'dsh_session=fixture-cookie; Path=/; HttpOnly',
      })
      response.end()
      return
    }
    if (url.pathname === '/api/pi-tui.local-host') {
      if (request.headers.cookie !== 'dsh_session=fixture-cookie' || identity === undefined) {
        response.writeHead(401, { 'cache-control': 'no-store' })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(`${JSON.stringify(identity)}\n`)
      return
    }
    response.writeHead(404)
    response.end()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const scope = scopeFor(value)
    const hostRecord = recordFor(scope, { origin })
    const registryPath = join(scope.dir, 'instance.json')
    const launchPath = join(scope.dir, 'launch.json')
    const options = {
      scope,
      // Deliberately absent: a handoff expectation that spawned a Host would
      // fail loudly instead of silently succeeding through the ordinary path.
      hostEntryPath: join(value.packageRoot, 'dist', 'local-host.mjs'),
      dshAnchor: join(value.root, 'missing-dsh', 'package.json'),
      profile: 'pi-tui',
    }
    const writeHost = (record: LocalInstanceRecord): void => {
      writeFileSync(registryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      writeFileSync(launchPath, `${JSON.stringify({
        schema: 1,
        instanceId: record.instanceId,
        connectUrl: `${record.origin}/connect?token=fixture-token`,
      })}\n`, { mode: 0o600 })
    }

    // Positive: the expected live/authenticated Host is attached.
    identity = hostRecord
    writeHost(hostRecord)
    const registryBefore = readFileSync(registryPath)
    const launchBefore = readFileSync(launchPath)
    const verified = await ensureLocalHost({ ...options, expectedInstanceId: hostRecord.instanceId })
    assert.equal(verified.identity.instanceId, hostRecord.instanceId)
    assert.equal(connectRequests, 1, 'the expected Host must authenticate through the official /connect')

    // The expected branch keeps the PR2 rule: a DIFFERENT installed build of
    // the same protocol/DSH runtime is still the expected Host.
    const crossBuild = { ...hostRecord, bundleVersion: '9.9.9', buildId: 'c'.repeat(64) }
    identity = crossBuild
    writeHost(crossBuild)
    const crossBuildVerified = await ensureLocalHost({ ...options, expectedInstanceId: crossBuild.instanceId })
    assert.equal(crossBuildVerified.identity.buildId, 'c'.repeat(64))
    assert.notEqual(crossBuildVerified.identity.buildId, scope.buildId)
    assert.equal(connectRequests, 2)
    identity = hostRecord
    writeHost(hostRecord)

    // Negative: another healthy Host is present but is not the expected instance.
    await assert.rejects(
      ensureLocalHost({ ...options, expectedInstanceId: randomUUID() }),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_IDENTITY_MISMATCH',
    )
    assert.equal(connectRequests, 2, 'an expected-instance mismatch must refuse BEFORE /connect')
    assert.deepEqual(readFileSync(registryPath), registryBefore, 'a refused handoff rewrote the registry')
    assert.deepEqual(readFileSync(launchPath), launchBefore, 'a refused handoff rewrote the launch material')

    // Negative: no registry at all is a handoff refusal, never a Host spawn.
    rmSync(registryPath)
    await assert.rejects(
      ensureLocalHost({ ...options, expectedInstanceId: hostRecord.instanceId }),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_HANDOFF_UNAVAILABLE',
    )
    assert.equal(connectRequests, 2, 'a missing expected Host must not authenticate another candidate')

    // Negative: a dead expected Host is a refusal, never an automatic spawn.
    const dead = recordFor(scope, { origin, hostPid: 999_999_999 })
    writeHost(dead)
    await assert.rejects(
      ensureLocalHost({ ...options, expectedInstanceId: dead.instanceId }),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_HANDOFF_UNAVAILABLE',
    )
    assert.equal(connectRequests, 2, 'a dead expected Host must not authenticate anything')
    assert.deepEqual(readFileSync(registryPath), Buffer.from(`${JSON.stringify(dead)}\n`),
      'a refused handoff rewrote the dead registry record')

    // Negative: authenticated echo differs from the registry for the expected instance.
    identity = { ...hostRecord, buildId: 'd'.repeat(64) }
    writeHost(hostRecord)
    await assert.rejects(
      ensureLocalHost({ ...options, expectedInstanceId: hostRecord.instanceId }),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_IDENTITY_MISMATCH',
    )
    assert.equal(connectRequests, 3, 'the expected identity was authenticated before its echo mismatch')

    // Negative: a protocol/DSH mismatch stays the existing refusal and no /connect happens.
    identity = hostRecord
    const foreign = { ...hostRecord, protocol: 'dsh-pi-tui/local/2' as typeof LOCAL_PROTOCOL }
    writeHost(foreign)
    await assert.rejects(
      ensureLocalHost({ ...options, expectedInstanceId: foreign.instanceId }),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_PROTOCOL_INCOMPATIBLE',
    )
    assert.equal(connectRequests, 3, 'an incompatible expected Host must not authenticate')

    // The ordinary ensure path is unchanged: a live Host is authenticated...
    writeHost(hostRecord)
    identity = hostRecord
    const ordinary = await ensureLocalHost(options)
    assert.equal(ordinary.identity.instanceId, hostRecord.instanceId)
    assert.equal(connectRequests, 4)
    // ...and a missing registry still enters the ORIGINAL spawn path.
    rmSync(registryPath)
    await assert.rejects(
      ensureLocalHost(options),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_START_FAILED',
    )
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('macOS publishes and re-proves the complete schema 2 kernel identity', { skip: process.platform !== 'darwin' ? 'Darwin libproc identity requires macOS' : false }, t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const record = recordFor(scope)
    assert.equal(record.schema, 2)
    if (record.schema !== 2) return
    assert.equal(record.hostKernelIdentity.pid, record.hostPid)
    assert.equal(record.hostKernelIdentity.platform, 'darwin')
    writeLocalRecord(scope, record)
    writeLaunchMaterial(scope, record, {
      schema: 1,
      instanceId: record.instanceId,
      connectUrl: `${record.origin}/connect?token=fixture-token`,
    })
    assert.deepEqual(readLocalRecord(scope), record)
    assert.equal(inspectHostProcess(record), 'alive')
    assert.doesNotThrow(() => assertRecordedHostKernelIdentityCurrent(record))

    // PID reuse / another live process is a STALE CANDIDATE, never a kill permit.
    const reused = { ...record, hostKernelIdentity: { ...record.hostKernelIdentity, uniqueId: '1' } }
    assert.equal(inspectHostProcess(reused), 'dead')
    assert.throws(
      () => assertRecordedHostKernelIdentityCurrent(reused),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_IDENTITY_MISMATCH',
    )
    assert.equal(inspectHostProcess(recordFor(scope, { hostPid: 999_999_999 })), 'dead')

    // An UNVERIFIABLE kernel read is a hard failure, never "dead" or "alive".
    const unknown: KernelObservation = { kind: 'unknown', code: 'ACCESS_DENIED' }
    assert.throws(
      () => inspectHostProcess(record, '/proc', () => unknown),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'PROCESS_STARTTIME_UNAVAILABLE',
    )
    assert.throws(
      () => assertRecordedHostKernelIdentityCurrent(record, () => unknown),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'PROCESS_STARTTIME_UNAVAILABLE',
    )

    // Strict parsing: an identity pid mismatch, an extra identity key and an
    // unknown schema are refused before any liveness decision.
    const registryPath = join(scope.dir, 'instance.json')
    const mismatchedPid: DarwinLocalInstanceRecord = {
      ...record,
      hostKernelIdentity: { ...record.hostKernelIdentity, pid: record.hostPid + 1 },
    }
    writeFileSync(registryPath, `${JSON.stringify(mismatchedPid)}\n`, { mode: 0o600 })
    assert.throws(
      () => readLocalRecord(scope),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'LOCAL_FILE_UNSAFE',
    )
    writeFileSync(registryPath, `${JSON.stringify({
      ...record,
      hostKernelIdentity: { ...record.hostKernelIdentity, surprise: 'x' },
    })}\n`, { mode: 0o600 })
    assert.throws(
      () => readLocalRecord(scope),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'LOCAL_FILE_UNSAFE',
    )
    writeFileSync(registryPath, `${JSON.stringify({ ...record, schema: 3 })}\n`, { mode: 0o600 })
    assert.throws(
      () => readLocalRecord(scope),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'LOCAL_FILE_UNSAFE',
    )

    // A Linux schema 1 record is not a macOS publication: publishing,
    // authenticating or classifying it fails closed with the protocol refusal.
    const linuxRecord: LinuxLocalInstanceRecord = {
      schema: 1,
      scopeId: scope.scopeId,
      profileRealpath: scope.profileRealpath,
      instanceId: randomUUID(),
      hostPid: process.pid,
      hostStarttime: '12345',
      origin: 'http://127.0.0.1:41001',
      protocol: LOCAL_PROTOCOL as typeof LOCAL_PROTOCOL,
      bundleVersion: scope.bundleVersion,
      dshVersion: scope.dshVersion,
      buildId: scope.buildId,
    }
    assert.throws(
      () => writeLocalRecord(scope, linuxRecord),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_PROTOCOL_INCOMPATIBLE',
    )
    assert.throws(
      () => inspectHostProcess(linuxRecord),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_PROTOCOL_INCOMPATIBLE',
    )
    assert.throws(
      () => assertRecordedHostKernelIdentityCurrent(linuxRecord),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_PROTOCOL_INCOMPATIBLE',
    )
    assert.equal(sameLocalInstanceRecord(record, { ...record }), true)
    assert.equal(sameLocalInstanceRecord(record, reused), false)
  } finally {
    cleanup(value.root)
  }
})

test('macOS dispatches one exclusive kernel seat per profile scope', { skip: process.platform !== 'darwin' ? 'Darwin file seats require macOS' : false }, async t => {
  const first = fixture(t)
  const second = fixture(t)
  try {
    const scopeA = scopeFor(first)
    const scopeB = scopeFor(second)
    const accountHome = join(first.root, 'account-home')
    mkdirSync(accountHome, { mode: 0o700 })
    assert.notEqual(scopeA.scopeId, scopeB.scopeId, 'independent profiles must not share a scope')
    const host = await bindProfileKernelSeat(scopeA, 'host', 'HOST_ALREADY_OWNED', { accountHome })
    try {
      host.assertCurrent()
      await assert.rejects(
        bindProfileKernelSeat(scopeA, 'host', 'HOST_ALREADY_OWNED', { accountHome }),
        (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_ALREADY_OWNED',
      )
      // The qualification-only Client purpose owns its OWN seat and never
      // conflicts with the Host singleton.
      const qualification = await bindProfileKernelSeat(scopeA, 'qualification-client', 'CLIENT_ALREADY_ACTIVE')
      try {
        await assert.rejects(
          bindProfileKernelSeat(scopeA, 'qualification-client', 'CLIENT_ALREADY_ACTIVE'),
          (error: unknown) => error instanceof LocalScopeError && error.code === 'CLIENT_ALREADY_ACTIVE',
        )
      } finally {
        await qualification.close()
      }
      // Profile B is a different seat object and wins independently.
      const otherHost = await bindProfileKernelSeat(scopeB, 'host', 'HOST_ALREADY_OWNED', { accountHome })
      await otherHost.close()
      // Replacing the claimed path's inode behind the held descriptor is not
      // ownership: Ready must stop instead of publishing.
      const seatPath = processSeatPath(darwinHostProfileSeatDir(scopeA.scopeId, accountHome), scopeA.scopeId, 'host')
      rmSync(seatPath)
      writeFileSync(seatPath, '', { mode: 0o600 })
      assert.throws(
        () => host.assertCurrent(),
        (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_IDENTITY_MISMATCH',
      )
    } finally {
      await host.close()
    }
    // An existing over-permissive seat file is refused BEFORE the open, not
    // silently repaired.
    const tamperedScope = scopeFor(fixture(t))
    const tamperedPath = processSeatPath(darwinHostProfileSeatDir(tamperedScope.scopeId, accountHome), tamperedScope.scopeId, 'host')
    writeFileSync(tamperedPath, '', { mode: 0o644 })
    await assert.rejects(
      bindProfileKernelSeat(tamperedScope, 'host', 'HOST_ALREADY_OWNED', { accountHome }),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'SCOPE_DIRECTORY_UNSAFE',
    )
  } finally {
    cleanup(first.root)
    cleanup(second.root)
  }
})

test('the schema 1 publication builder keeps the frozen key order', t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const fields = {
      scopeId: scope.scopeId,
      profileRealpath: scope.profileRealpath,
      instanceId: randomUUID(),
      hostPid: process.pid,
      origin: 'http://127.0.0.1:41001',
      protocol: LOCAL_PROTOCOL as typeof LOCAL_PROTOCOL,
      bundleVersion: scope.bundleVersion,
      dshVersion: scope.dshVersion,
      buildId: scope.buildId,
    }
    const expected = [
      'schema',
      'scopeId',
      'profileRealpath',
      'instanceId',
      'hostPid',
      'hostStarttime',
      'origin',
      'protocol',
      'bundleVersion',
      'dshVersion',
      'buildId',
    ]
    const echo = buildHostInstanceRecord(fields, { schema: 1, hostStarttime: '12345' })
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(echo))), expected, 'the authenticated echo order is canonical')
  } finally {
    cleanup(value.root)
  }
})

test('the schema 1 registry persists the frozen key order', { skip: process.platform !== 'linux' ? 'Linux schema 1 is the frozen Linux-only bytes contract' : false }, t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const echo = buildHostInstanceRecord({
      scopeId: scope.scopeId,
      profileRealpath: scope.profileRealpath,
      instanceId: randomUUID(),
      hostPid: process.pid,
      origin: 'http://127.0.0.1:41001',
      protocol: LOCAL_PROTOCOL as typeof LOCAL_PROTOCOL,
      bundleVersion: scope.bundleVersion,
      dshVersion: scope.dshVersion,
      buildId: scope.buildId,
    }, { schema: 1, hostStarttime: '12345' })
    writeLocalRecord(scope, echo)
    const registryKeys = Object.keys(JSON.parse(readFileSync(join(scope.dir, 'instance.json'), 'utf8')))
    assert.deepEqual(registryKeys, [
      'schema',
      'scopeId',
      'profileRealpath',
      'instanceId',
      'hostPid',
      'hostStarttime',
      'origin',
      'protocol',
      'bundleVersion',
      'dshVersion',
      'buildId',
    ], 'the persisted registry order is the frozen schema 1 order')
  } finally {
    cleanup(value.root)
  }
})

test('the schema 2 publication keeps the canonical Darwin key order', { skip: process.platform !== 'darwin' ? 'Darwin schema 2 requires the real libproc identity' : false }, t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const liveIdentity = recordFor(scope)
    assert.equal(liveIdentity.schema, 2)
    if (liveIdentity.schema !== 2) return
    const expected = [
      'schema',
      'scopeId',
      'profileRealpath',
      'instanceId',
      'hostPid',
      'hostKernelIdentity',
      'origin',
      'protocol',
      'bundleVersion',
      'dshVersion',
      'buildId',
    ]
    const record = buildHostInstanceRecord({
      scopeId: scope.scopeId,
      profileRealpath: scope.profileRealpath,
      instanceId: randomUUID(),
      hostPid: process.pid,
      origin: 'http://127.0.0.1:41001',
      protocol: LOCAL_PROTOCOL as typeof LOCAL_PROTOCOL,
      bundleVersion: scope.bundleVersion,
      dshVersion: scope.dshVersion,
      buildId: scope.buildId,
    }, { schema: 2, hostKernelIdentity: liveIdentity.hostKernelIdentity })
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(record))), expected)
    writeLocalRecord(scope, record)
    const registryKeys = Object.keys(JSON.parse(readFileSync(join(scope.dir, 'instance.json'), 'utf8')))
    assert.deepEqual(registryKeys, expected)
  } finally {
    cleanup(value.root)
  }
})

test('two DSH homes aliasing one canonical profile share ONE global Darwin Host seat', { skip: process.platform !== 'darwin' ? 'Darwin file seats require macOS' : false }, async t => {
  const root = testLifecycle(t).tempDir('dsh-cross-home-')
  const packageRoot = join(root, 'package')
  mkdirSync(join(packageRoot, 'dist'), { recursive: true, mode: 0o700 })
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version: '0.5.7' })}\n`)
  writeFileSync(join(packageRoot, 'dist', 'index.mjs'), 'export const value = 1\n')
  const profile = join(root, 'shared-profile')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  const accountHome = join(root, 'account-home')
  mkdirSync(accountHome, { mode: 0o700 })
  const homeA = join(root, 'home-a')
  mkdirSync(join(homeA, 'profiles'), { recursive: true, mode: 0o700 })
  symlinkSync(profile, join(homeA, 'profiles', 'pi-tui'))
  const homeB = join(root, 'home-b')
  mkdirSync(join(homeB, 'profiles'), { recursive: true, mode: 0o700 })
  symlinkSync(profile, join(homeB, 'profiles', 'pi-tui'))
  const first = scopeFromInstalledProfile({
    dshHome: homeA,
    profileDir: join(homeA, 'profiles', 'pi-tui'),
    packageRoot,
    dshVersion: '0.2.2-rc.3',
  })
  const second = scopeFromInstalledProfile({
    dshHome: homeB,
    profileDir: join(homeB, 'profiles', 'pi-tui'),
    packageRoot,
    dshVersion: '0.2.2-rc.3',
  })
  assert.equal(first.scopeId, second.scopeId, 'one canonical profile is one scope')
  assert.notEqual(first.dir, second.dir, 'the per-DSH-home registry directories stay distinct')
  const host = await bindProfileKernelSeat(first, 'host', 'HOST_ALREADY_OWNED', { accountHome })
  try {
    await assert.rejects(
      bindProfileKernelSeat(second, 'host', 'HOST_ALREADY_OWNED', { accountHome }),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_ALREADY_OWNED',
      'the second DSH home must never start a second Host for the same canonical profile',
    )
    assert.equal(darwinHostProfileSeatDir(first.scopeId, accountHome), darwinHostProfileSeatDir(second.scopeId, accountHome),
      'the Host seat is keyed only by the canonical-profile scope id')
  } finally {
    await host.close()
  }
  const afterRelease = await bindProfileKernelSeat(second, 'host', 'HOST_ALREADY_OWNED', { accountHome })
  await afterRelease.close()
})

test('the global Darwin Host seat refuses unsafe account-home chains', { skip: process.platform !== 'darwin' ? 'Darwin file seats require macOS' : false }, async t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    // A pre-existing user-owned 0755 account directory (the real machine has
    // `~/.dsh-pi-tui/themes`) is a safe read-only parent; only group/other
    // WRITE would let another account replace the private chain.
    const readableRoot = join(value.root, 'readable-home')
    mkdirSync(readableRoot, { mode: 0o700 })
    mkdirSync(join(readableRoot, '.dsh-pi-tui'), { mode: 0o755 })
    const readableSeat = await bindProfileKernelSeat(scope, 'host', 'HOST_ALREADY_OWNED', { accountHome: readableRoot })
    await readableSeat.close()
    const writableRoot = join(value.root, 'writable-home')
    mkdirSync(writableRoot, { mode: 0o700 })
    mkdirSync(join(writableRoot, '.dsh-pi-tui'), { mode: 0o700 })
    chmodSync(join(writableRoot, '.dsh-pi-tui'), 0o777)
    await assert.rejects(
      bindProfileKernelSeat(scope, 'host', 'HOST_ALREADY_OWNED', { accountHome: writableRoot }),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'SCOPE_DIRECTORY_UNSAFE',
    )
    const linkedRoot = join(value.root, 'linked-home')
    mkdirSync(linkedRoot, { mode: 0o700 })
    const target = join(value.root, 'outside-seat-root')
    mkdirSync(target, { mode: 0o700 })
    symlinkSync(target, join(linkedRoot, '.dsh-pi-tui'))
    await assert.rejects(
      bindProfileKernelSeat(scope, 'host', 'HOST_ALREADY_OWNED', { accountHome: linkedRoot }),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'SCOPE_DIRECTORY_UNSAFE',
    )
  } finally {
    cleanup(value.root)
  }
})

test('a SIGKILLed global Darwin Host-seat holder releases the kernel claim', { skip: process.platform !== 'darwin' ? 'Darwin file seats require macOS' : false, timeout: 60_000 }, async t => {
  const value = fixture(t)
  const accountHome = join(value.root, 'account-home')
  mkdirSync(accountHome, { mode: 0o700 })
  const scope = scopeFor(value)
  const moduleUrl = pathToFileURL(join(ROOT, 'src', 'app', 'remote-process', 'local-scope.ts')).href
  const worker = join(value.root, 'global-seat-worker.mjs')
  writeFileSync(worker, [
    `import { bindProfileKernelSeat } from ${JSON.stringify(moduleUrl)}`,
    'const [accountHome, scopeId] = process.argv.slice(2)',
    "const seat = await bindProfileKernelSeat({ scopeId }, 'host', 'HOST_ALREADY_OWNED', { accountHome })",
    'void seat',
    "console.log('held')",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  const child = spawn(process.execPath, ['--import', 'tsx/esm', worker, accountHome, scope.scopeId], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  try {
    await new Promise<void>((resolveChild, rejectChild) => {
      // reason: bounded external-child startup window; the holder must boot and report its held seat before SIGKILL recovery.
      const timer = setTimeout(() => rejectChild(new Error('the global seat holder did not report held')), 15_000)
      child.stdout.setEncoding('utf8')
      child.stdout.once('data', chunk => {
        clearTimeout(timer)
        if (String(chunk).includes('held')) resolveChild()
        else rejectChild(new Error(`unexpected seat worker output: ${String(chunk)}`))
      })
      child.once('exit', code => {
        clearTimeout(timer)
        rejectChild(new Error(`the global seat holder exited before holding the seat: ${String(code)}`))
      })
    })
    assert.equal(child.kill('SIGKILL'), true)
    await new Promise<void>(resolveChild => { child.once('exit', () => resolveChild()) })
    const next = await bindProfileKernelSeat(scope, 'host', 'HOST_ALREADY_OWNED', { accountHome })
    await next.close()
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    cleanup(value.root)
  }
})
