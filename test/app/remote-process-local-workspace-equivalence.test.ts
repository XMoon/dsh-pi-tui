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
import { mkdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyLaunchWorkspace,
  readProcessStarttimeAt,
} from '../../src/app/remote-process/local-workspace-equivalence.ts'
import { readProcessStarttime } from '../../src/app/remote-process/local-scope.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

/** The `(dev, ino)` a caller would capture at CLIENT LAUNCH for this path. */
function launchObjectOf(path: string): { readonly device: number; readonly inode: number } {
  const stat = statSync(path)
  return { device: stat.dev, inode: stat.ino }
}

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
  const launchObject = launchObjectOf(launchCwd)
  const verdict = classifyLaunchWorkspace(selfIdentity(), launchCwd, { launchObject })
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
  const launchCwd = realpathSync(root)
  const verdict = classifyLaunchWorkspace(
    { ...selfIdentity(), hostStarttime: '1' },
    launchCwd,
    { launchObject: launchObjectOf(launchCwd) },
  )
  assert.equal(verdict.kind, 'unverified')
  assert.match(verdict.kind === 'unverified' ? verdict.reason : '', /starttime/u)
})

test('an unreadable /proc/<pid>/stat is unverified, never a guess', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const launchCwd = realpathSync(root)
  const verdict = classifyLaunchWorkspace(
    { instanceId: 'i', hostPid: 999_999_999, hostStarttime: '12345' },
    launchCwd,
    { launchObject: launchObjectOf(launchCwd) },
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
  const verdict = classifyLaunchWorkspace(identity, realLaunch, { procRoot, launchObject: launchObjectOf(realLaunch) })
  assert.equal(verdict.kind, 'unverified')
  assert.match(verdict.kind === 'unverified' ? verdict.reason : '', /different directory objects/u)
})

test('a launch cwd that is not a directory is unverified', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const file = join(root, 'not-a-dir.txt')
  writeFileSync(file, 'x')
  assert.equal(classifyLaunchWorkspace(selfIdentity(), file, { launchObject: launchObjectOf(file) }).kind, 'unverified')
})

test('a symlinked Client view resolves to the SAME object on this same-root Host', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const real = mkdir(root, 'real')
  const link = join(root, 'link')
  symlinkSync(real, link)
  const realPath = realpathSync(real)
  assert.equal(classifyLaunchWorkspace(selfIdentity(), realPath, { launchObject: launchObjectOf(realPath) }).kind, 'verified')
  // `stat` follows the link, so on a same-root Host the link is the SAME
  // directory object — the (dev, ino) comparison, not the spelling, decides.
  assert.equal(classifyLaunchWorkspace(selfIdentity(), link, { launchObject: launchObjectOf(link) }).kind, 'verified')
})

test('non-Linux platforms are unverified (the /proc root view is Linux-only)', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const launchCwd = realpathSync(root)
  const verdict = classifyLaunchWorkspace(selfIdentity(), launchCwd, { platform: 'darwin', launchObject: launchObjectOf(launchCwd) })
  assert.equal(verdict.kind, 'unverified')
  assert.match(verdict.kind === 'unverified' ? verdict.reason : '', /Linux/u)
})

test('a missing authenticated Host identity is unverified', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const launchCwd = realpathSync(root)
  assert.equal(classifyLaunchWorkspace(undefined, launchCwd, { launchObject: launchObjectOf(launchCwd) }).kind, 'unverified')
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
    launchObject: launchObjectOf(launchCwd),
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
  const launchCwd = realpathSync(root)
  const verdict = classifyLaunchWorkspace(selfIdentity(), launchCwd, { launchObject: launchObjectOf(launchCwd) })
  assert.equal(verdict.kind, 'verified')
  assert.equal(verdict.kind === 'verified' ? verdict.revalidate() : false, true)
})

test('a rename-and-recreate of the launch path is NOT the launch directory (real OS negative)', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const work = mkdir(root, 'project')
  writeFileSync(join(work, 'real.txt'), 'x')
  // The Client starts in `project`: capture its object BEFORE anything moves.
  const startup = launchObjectOf(work)
  // Rename the original away and put a NEW directory at the SAME spelling.
  renameSync(work, join(root, 'project.old'))
  mkdirSync(work)
  writeFileSync(join(work, 'impostor.txt'), 'x')
  const now = launchObjectOf(work)
  assert.notEqual(now.inode, startup.inode, 'the fixture really replaced the directory object')

  // Path and Host view now agree with EACH OTHER — but not with the launch.
  const verdict = classifyLaunchWorkspace(selfIdentity(), work, { launchObject: startup })
  assert.equal(verdict.kind, 'unverified')
  assert.match(verdict.kind === 'unverified' ? verdict.reason : '', /renamed or recreated/u)

  // POSITIVE CONTROL: without the replacement the same call verifies.
  const stable = mkdir(root, 'stable')
  const stableObject = launchObjectOf(stable)
  assert.equal(classifyLaunchWorkspace(selfIdentity(), stable, { launchObject: stableObject }).kind, 'verified')
})

test('revalidate also refuses a launch path replaced after the first classification', (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const work = mkdir(root, 'project')
  const startup = launchObjectOf(work)
  const verdict = classifyLaunchWorkspace(selfIdentity(), work, { launchObject: startup })
  assert.equal(verdict.kind, 'verified')
  if (verdict.kind !== 'verified') return
  renameSync(work, join(root, 'project.old'))
  mkdirSync(work)
  assert.equal(verdict.revalidate(), false,
    'a path recreation after classification revokes the proof even though path and Host view agree')
})
