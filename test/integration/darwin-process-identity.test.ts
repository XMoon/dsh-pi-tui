/**
 * REAL Darwin kernel-process-identity qualification (MAC-02B).
 *
 * Every case here runs against the live kernel and only against processes this
 * test created itself plus two safe negatives (`pid 1`, a never-used pid). The
 * independent C reader (`test/fixtures/darwin-identity/pid_identity_dump.c`)
 * reads the SAME pids through its own libproc code, so the TypeScript bridge is
 * cross-checked against a second implementation instead of against itself.
 *
 * The x64 struct ABI is NOT covered here: this run is arm64 only, and the plan
 * records it as `NOT_VERIFIED_X64` (MAC-10 owns the second architecture).
 *
 * On non-Darwin hosts the whole suite is skipped with an explicit reason; the
 * portable classifier tests live in `test/app/local-discovery.test.ts`.
 *
 * @module @xmoon76/dsh-pi-tui/darwin-process-identity.test
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  listKernelGroupMembers,
  readKernelProcess,
  sameKernelProcess,
  type DarwinKernelProcessIdentity,
  type KernelObservation,
} from '../../src/runtime/native-process/identity.ts'

const DARWIN_ONLY = process.platform !== 'darwin' ? 'Darwin kernel process identity requires macOS' : false
const DUMP_SOURCE = fileURLToPath(new URL('../fixtures/darwin-identity/pid_identity_dump.c', import.meta.url))

/** Poll `check` until it returns a non-undefined value or the deadline expires. */
async function waitUntil<T>(check: () => T | undefined, deadlineMs: number, label: string): Promise<T> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const value = check()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function startDetached(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  assert.ok(child.pid !== undefined, `${command} must spawn`)
  return child
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  try { child.kill('SIGKILL') } catch { /* already gone */ }
  await exited
}

function pidOf(child: ChildProcess): number {
  const pid = child.pid
  assert.ok(pid !== undefined, 'the child must have a pid')
  return pid
}

function darwinIdentity(pid: number): DarwinKernelProcessIdentity {
  const observation = readKernelProcess(pid)
  assert.equal(observation.kind, 'alive', `pid ${pid} must be observed alive: ${JSON.stringify(observation)}`)
  assert.equal(observation.identity.platform, 'darwin')
  return observation.identity as DarwinKernelProcessIdentity
}

test('the TypeScript bridge agrees with an independent C libproc reader', { skip: DARWIN_ONLY, timeout: 60_000 }, async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('darwin-identity-c-')
  const binary = join(dir, 'pid_identity_dump')
  const compiled = spawnSync('cc', ['-O0', '-o', binary, DUMP_SOURCE], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, `the independent C reader must compile:\n${compiled.stderr ?? ''}`)

  const child = startDetached(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'])
  try {
    const childPid = pidOf(child)
    const dumped = execFileSync(binary, [String(process.pid), String(childPid)], { encoding: 'utf8' }).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const bootstrap = dumped[0]!
    const kernelBootUuid = execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' }).trim()
    assert.equal(bootstrap['bootUuid'], kernelBootUuid, 'kern.bootsessionuuid must match the independent sysctl read')

    for (const pid of [process.pid, childPid]) {
      const identity = darwinIdentity(pid)
      const independent = dumped.find(entry => entry['pid'] === pid)
      assert.ok(independent !== undefined, `the C reader must report pid ${pid}`)
      assert.equal(identity.bootUUID, kernelBootUuid)
      assert.equal(identity.ppid, independent['ppid'])
      assert.equal(identity.pgid, independent['pgid'])
      assert.equal(identity.sid, independent['sid'])
      assert.equal(identity.uid, independent['uid'])
      assert.equal(identity.startSec, String(independent['startSec']))
      assert.equal(identity.startUsec, String(independent['startUsec']))
      assert.equal(identity.uniqueId, String(independent['uniqueId']))
      assert.equal(identity.parentUniqueId, String(independent['parentUniqueId']))
      assert.equal(identity.processUUID, independent['uuidHex'])
    }
    // The child is a different process under this test process.
    assert.notEqual(darwinIdentity(process.pid).uniqueId, darwinIdentity(childPid).uniqueId)
    assert.equal(darwinIdentity(childPid).ppid, process.pid)
    assert.equal(sameKernelProcess(darwinIdentity(process.pid), readKernelProcess(childPid)), 'different')
  } finally {
    await stopChild(child)
  }
})

test('a live child identity is bracketed, stable and distinct; a reaped child reads as gone', { skip: DARWIN_ONLY, timeout: 30_000 }, async (t) => {
  const life = testLifecycle(t)
  life.tempDir('darwin-identity-live-')
  const child = startDetached('/bin/sh', ['-c', 'sleep 60'])
  const pid = pidOf(child)
  try {
    await waitUntil(() => (readKernelProcess(pid).kind === 'alive' ? true : undefined), 5_000, `live pid ${pid}`)
    const first = darwinIdentity(pid)
    const second = darwinIdentity(pid)
    assert.deepEqual(second, first, 'a live process identity must be stable across reads')
    assert.equal(first.pid, pid)
    assert.equal(first.pgid, pid, 'a detached child leads its own process group')
    assert.equal(first.sid, pid, 'a detached child leads its own session')
    assert.equal(first.ppid, process.pid)
    assert.match(first.startSec, /^\d+$/u)
    assert.match(first.startUsec, /^\d+$/u)
    assert.ok(Number(first.startUsec) < 1_000_000, 'start microseconds must stay inside one second')
  } finally {
    await stopChild(child)
  }
  // The process was reaped: its pid must read as a definitive absence, never as
  // an identity (a reused numeric pid is caught by the identity comparison).
  await waitUntil(() => {
    const observation = readKernelProcess(pid)
    if (observation.kind === 'unknown') throw new Error(`a reaped child must not be unverifiable: ${JSON.stringify(observation)}`)
    return observation.kind === 'gone' ? true : undefined
  }, 5_000, `reaped pid ${pid}`)
})

test('permission, absence and out-of-group negatives are classified, never guessed', { skip: DARWIN_ONLY, timeout: 30_000 }, async (t) => {
  const life = testLifecycle(t)
  life.tempDir('darwin-identity-neg-')
  // pid 1 exists but this user may not inspect it: `unknown/ACCESS_DENIED`
  // must never be treated as dead or as an identity.
  assert.deepEqual(readKernelProcess(1), { kind: 'unknown', code: 'ACCESS_DENIED' })
  // A pid the kernel never allocated is a definitive absence.
  assert.deepEqual(readKernelProcess(4_194_304), { kind: 'gone' })
  // A member scan of a group that does not exist yields no members, not an
  // unverifiable scan.
  assert.deepEqual(listKernelGroupMembers(4_194_304), [])
})

test('group membership is bracketed by pgid and sid and disappears with the group', { skip: DARWIN_ONLY, timeout: 30_000 }, async (t) => {
  const life = testLifecycle(t)
  life.tempDir('darwin-identity-group-')
  // The leader is the session/group leader; both descendants stay in it.
  const child = startDetached('/bin/sh', ['-c', 'sleep 60 & sleep 60 & wait'])
  const group = pidOf(child)
  try {
    const members = await waitUntil(() => {
      const listed = listKernelGroupMembers(group)
      if (!Array.isArray(listed)) return undefined
      return listed.length === 3 ? listed : undefined
    }, 10_000, `three members in group ${group}`)
    const identities = members.map(member => {
      assert.equal(member.kind, 'alive')
      return (member as { readonly kind: 'alive'; readonly identity: DarwinKernelProcessIdentity }).identity
    })
    assert.ok(identities.some(identity => identity.pid === group), 'the leader is a verified member')
    for (const identity of identities) {
      assert.equal(identity.pgid, group)
      assert.equal(identity.sid, group)
    }
    // The scan returns the SAME process identities on a second call.
    const again = listKernelGroupMembers(group)
    assert.ok(Array.isArray(again), `the second scan must be verifiable: ${JSON.stringify(again)}`)
    const alivePids = (listed: readonly KernelObservation[]): number[] =>
      listed.flatMap(observation => observation.kind === 'alive' ? [observation.identity.pid] : []).sort((left, right) => left - right)
    assert.deepEqual(alivePids(again), identities.map(identity => identity.pid).sort((left, right) => left - right))
  } finally {
    try { process.kill(-group, 'SIGKILL') } catch { /* already gone */ }
    await stopChild(child)
  }
  await waitUntil(() => {
    const listed = listKernelGroupMembers(group)
    if (!Array.isArray(listed)) return undefined
    return listed.length === 0 ? true : undefined
  }, 5_000, `empty group ${group}`)
})
