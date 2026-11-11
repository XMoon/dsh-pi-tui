/**
 * Contract tests for the Client-local launch-cwd / Host-directory equivalence
 * classifier (M6-1/F5-B §4.5): the ONLY evidence that may auto-adopt a Client
 * launch directory as a Host Workspace candidate. The positive case runs
 * against the REAL Linux `/proc`; the negatives cover every fail-closed fact
 * the classifier must never guess through.
 *
 * NOTE: a true cross-mount-namespace fixture (the same pathname resolving to
 * different directory objects in two REAL namespaces) is the packed OS lane's
 * WS-L2 evidence, not this unit contract.
 *
 * @module @xmoon76/dsh-pi-tui/remote-process-local-workspace-equivalence.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyLaunchWorkspace,
  readProcessStarttimeAt,
} from '../../src/app/remote-process/local-workspace-equivalence.ts'
import { readProcessStarttime } from '../../src/app/remote-process/local-scope.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

function selfIdentity() {
  const starttime = readProcessStarttime(process.pid)
  assert.ok(starttime !== undefined, 'the real /proc must expose this process starttime')
  return { instanceId: 'instance-test', hostPid: process.pid, hostStarttime: starttime }
}

function cat(prefix: string, name: string): string {
  return `${prefix}/${name}`
}

function mkdir(root: string, name: string): string {
  const path = cat(root, name)
  mkdirSync(path)
  return path
}

test('the REAL Linux /proc proves the Client launch directory is the Host directory', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const launchCwd = realpathSync(root)
  const verdict = classifyLaunchWorkspace(selfIdentity(), launchCwd)
  assert.equal(verdict.kind, 'verified', JSON.stringify(verdict))
  if (verdict.kind !== 'verified') return
  assert.equal(verdict.launchCwd, launchCwd)
  assert.equal(verdict.hostPid, process.pid)
  assert.equal(typeof verdict.device, 'number')
  assert.equal(typeof verdict.inode, 'number')
  assert.equal(verdict.revalidate(), true, 'the same live evidence revalidates')
})

test('a mismatched Host starttime is unverified (PID reuse is never evidence)', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const verdict = classifyLaunchWorkspace(
    { ...selfIdentity(), hostStarttime: '1' },
    realpathSync(root),
  )
  assert.equal(verdict.kind, 'unverified')
  assert.match(verdict.kind === 'unverified' ? verdict.reason : '', /starttime/u)
})

test('an unreadable /proc/<pid>/stat is unverified, never a guess', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const verdict = classifyLaunchWorkspace(
    { instanceId: 'i', hostPid: 999_999_999, hostStarttime: '12345' },
    realpathSync(root),
  )
  assert.equal(verdict.kind, 'unverified')
  assert.match(verdict.kind === 'unverified' ? verdict.reason : '', /not readable/u)
})

test('the same pathname under a DIFFERENT Host root object is unverified', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const identity = selfIdentity()
  const launchCwd = mkdir(root, 'work')
  const realLaunch = realpathSync(launchCwd)
  // A fabricated proc root: `<procRoot>/<pid>/stat` carries the authenticated
  // starttime, while `<procRoot>/<pid>/root/<launchCwd>` names a DIFFERENT
  // directory object at the SAME pathname (the mount-view mismatch shape).
  const procRoot = mkdir(root, 'proc')
  const pidDir = mkdir(procRoot, String(identity.hostPid))
  writeFileSync(join(pidDir, 'stat'), `1 (host) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${identity.hostStarttime} 0 0\n`)
  const hostView = mkdir(pidDir, 'root')
  mkdirSync(join(hostView, realLaunch.slice(1)), { recursive: true })
  const verdict = classifyLaunchWorkspace(identity, realLaunch, { procRoot })
  assert.equal(verdict.kind, 'unverified')
  assert.match(verdict.kind === 'unverified' ? verdict.reason : '', /different directory objects/u)
})

test('a launch cwd that is not a directory is unverified', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const file = join(root, 'not-a-dir.txt')
  writeFileSync(file, 'x')
  assert.equal(classifyLaunchWorkspace(selfIdentity(), file).kind, 'unverified')
})

test('a symlinked Client view resolves to the SAME object on this same-root Host', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const real = mkdir(root, 'real')
  const link = join(root, 'link')
  symlinkSync(real, link)
  assert.equal(classifyLaunchWorkspace(selfIdentity(), realpathSync(real)).kind, 'verified')
  // `stat` follows the link, so on a same-root Host the link is the SAME
  // directory object — the (dev, ino) comparison, not the spelling, decides.
  assert.equal(classifyLaunchWorkspace(selfIdentity(), link).kind, 'verified')
})

test('non-Linux platforms are unverified (the /proc root view is Linux-only)', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const verdict = classifyLaunchWorkspace(selfIdentity(), realpathSync(root), { platform: 'darwin' })
  assert.equal(verdict.kind, 'unverified')
  assert.match(verdict.kind === 'unverified' ? verdict.reason : '', /Linux/u)
})

test('a missing authenticated Host identity is unverified', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  assert.equal(classifyLaunchWorkspace(undefined, realpathSync(root)).kind, 'unverified')
})

test('the shared official parser reads a real /proc/<pid>/stat and rejects a fabricated one', () => {
  assert.equal(readProcessStarttimeAt(process.pid), readProcessStarttime(process.pid))
  assert.equal(readProcessStarttimeAt(999_999_999), undefined)
})

test('revalidate fails closed when the Host identity changes INSIDE its observation window', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const identity = selfIdentity()
  const launchCwd = realpathSync(root)
  // The injected reader replays the exact race: classify's two reads match,
  // revalidate's first read matches, then the Host PID restarts (a different
  // starttime) BETWEEN revalidate's first check and its post-stats check.
  const matching = identity.hostStarttime
  let reads = 0
  const verdict = classifyLaunchWorkspace(identity, launchCwd, {
    readStarttime: () => {
      reads += 1
      // classify: 2 reads (initial + final); revalidate: read 3 (its first
      // check) and read 4 (the post-stats check). Read 4 is the one that
      // observes the CHANGED Host identity.
      return reads === 4 ? '99999999' : matching
    },
  })
  assert.equal(verdict.kind, 'verified')
  assert.equal(verdict.kind === 'verified' ? verdict.revalidate() : true, false,
    'a Host restart inside the revalidation window revokes the proof')
})

test('revalidate still proves unchanged identity across its full window', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const verdict = classifyLaunchWorkspace(selfIdentity(), realpathSync(root))
  assert.equal(verdict.kind, 'verified')
  assert.equal(verdict.kind === 'verified' ? verdict.revalidate() : false, true)
})
