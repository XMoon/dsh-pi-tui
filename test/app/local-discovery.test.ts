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
  computeBuildId,
  LocalScopeError,
  LOCAL_PROTOCOL,
  parseProcessStat,
  parseProcessStatStarttime,
  readLinuxStarttime,
  removeOwnedScratch,
  readProcessStarttime,
  scopeFromInstalledProfile,
  type LocalScope,
} from '../../src/app/remote-process/local-scope.ts'
import {
  assertClientHostCompatible,
  assertHostPublicationIdentity,
  authenticateLocalHost,
  inspectHostProcess,
  readLaunchMaterial,
  readLocalRecord,
  writeLaunchMaterial,
  writeLocalRecord,
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

function recordFor(scope: LocalScope, overrides: Partial<LocalInstanceRecord> = {}): LocalInstanceRecord {
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

test('an unsafe registry/launch permission is rejected', t => {
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
    chmodSync(join(scope.dir, 'instance.json'), 0o644)
    assert.throws(
      () => readLocalRecord(scope),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'LOCAL_FILE_UNSAFE',
    )
    chmodSync(join(scope.dir, 'launch.json'), 0o644)
    assert.throws(
      () => readLaunchMaterial(scope, record),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'LOCAL_FILE_UNSAFE',
    )
  } finally {
    cleanup(value.root)
  }
})

test('a symlinked registry or scope directory is rejected without changing permissions', t => {
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
    assert.throws(
      () => readLocalRecord(scope),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'LOCAL_FILE_UNSAFE',
    )

    const symlinked = fixture(t)
    try {
      const outside = join(symlinked.root, 'outside-run')
      mkdirSync(outside, { recursive: true, mode: 0o700 })
      symlinkSync(outside, join(symlinked.home, 'run'))
      assert.throws(
        () => scopeFor(symlinked),
        (error: unknown) => error instanceof LocalScopeError && error.code === 'SCOPE_DIRECTORY_UNSAFE',
      )
      assert.deepEqual(readdirSync(outside), [], 'the rejected symlinked run directory must not be written through')
    } finally {
      cleanup(symlinked.root)
    }
  } finally {
    cleanup(value.root)
  }
})

test('Linux process starttime identifies the live Host and rejects PID reuse', t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const live = recordFor(scope, { hostPid: process.pid, hostStarttime: readLinuxStarttime() })
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

test('an existing group/other-accessible run chain is rejected without creating a child', t => {
  const value = fixture(t)
  try {
    const runRoot = join(value.home, 'run')
    mkdirSync(runRoot, { mode: 0o700 })
    chmodSync(runRoot, 0o755)
    assert.throws(
      () => scopeFor(value),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'SCOPE_DIRECTORY_UNSAFE',
    )
    assert.equal(existsSync(join(runRoot, 'dsh-pi-tui')), false, 'a permissive run directory must not receive B1 children')

    chmodSync(runRoot, 0o700)
    const scopeRoot = join(runRoot, 'dsh-pi-tui')
    mkdirSync(scopeRoot, { mode: 0o700 })
    chmodSync(scopeRoot, 0o755)
    assert.throws(
      () => scopeFor(value),
      (error: unknown) => error instanceof LocalScopeError && error.code === 'SCOPE_DIRECTORY_UNSAFE',
    )
    assert.equal(readdirSync(scopeRoot).length, 0, 'a permissive scope root must not receive B1 children')
  } finally {
    cleanup(value.root)
  }
})

test('a definite missing PID is dead, while unreadable or malformed proc data is unavailable', t => {
  const value = fixture(t)
  try {
    const scope = scopeFor(value)
    const record = recordFor(scope)
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

test('a real unreaped child zombie is dead and the kernel Host seat is claimable', async t => {
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
        inspectHostProcess(recordFor(scope, { hostPid: pid, hostStarttime: before.starttime })),
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
    const childPath = join(value.root, 'concurrent-scope.mts')
    writeFileSync(childPath, [
      `import { scopeFromInstalledProfile, bindProcessSeat } from ${JSON.stringify(moduleUrl)}`,
      `const facts = ${JSON.stringify({
        dshHome: value.home,
        profileDir: value.profile,
        packageRoot: value.packageRoot,
        dshVersion: '0.2.1-rc.4',
      })}`,
      'try {',
      '  const scope = scopeFromInstalledProfile(facts)',
      '  try {',
      '    const seat = await bindProcessSeat(scope.hostSocketName, \'HOST_ALREADY_OWNED\')',
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
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
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

test('the kernel seat is exclusive and becomes reusable after close', async () => {
  const name = `\0dsh-m4-b1-test-${String(process.pid)}-${randomUUID()}`
  const first = await bindProcessSeat(name, 'HOST_ALREADY_OWNED')
  try {
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
  const second = await bindProcessSeat(name, 'HOST_ALREADY_OWNED')
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
