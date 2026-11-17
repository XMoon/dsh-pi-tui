/**
 * Contract tests for the Client-local launch-cwd / Host-directory equivalence
 * classifier (M6-1/F5-B §4.5): the ONLY evidence that may auto-adopt a Client
 * launch directory as a Host Workspace candidate.
 *
 * Linux positive/negative cases run against the REAL `/proc`. macOS cases use
 * the real libproc kernel identity plus a controlled authenticated Host
 * observation; they prove the classifier CONTRACT and fail-closed mapping.
 * The real Owner-only route over the installed Host/Client wire is the packed
 * macOS L6 smoke's evidence, never this unit contract.
 *
 * NOTE: a true cross-mount-namespace fixture (the same pathname resolving to
 * different directory objects in two REAL namespaces) is the packed OS lane's
 * evidence, not this unit contract.
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
  type DirectoryObject,
  type LaunchWorkspaceTransport,
} from '../../src/app/remote-process/local-workspace-equivalence.ts'
import { LOCAL_PROTOCOL, readProcessStarttime, type LocalScope } from '../../src/app/remote-process/local-scope.ts'
import {
  readKernelProcess,
  type DarwinKernelProcessIdentity,
  type KernelObservation,
} from '../../src/runtime/native-process/identity.ts'
import {
  type DarwinLocalInstanceRecord,
  type LinuxLocalInstanceRecord,
  type LocalInstanceRecord,
} from '../../src/app/remote-process/local-discovery.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const LINUX_ONLY = { skip: process.platform !== 'linux' ? 'the Linux classifier reads the real /proc root view' : false }
const DARWIN_ONLY = { skip: process.platform !== 'darwin' ? 'the macOS classifier requires the real libproc identity' : false }

/** The `(dev, ino)` a caller would capture at CLIENT LAUNCH for this path. */
function launchObjectOf(path: string): DirectoryObject {
  const stat = statSync(path, { bigint: true })
  return { device: stat.dev.toString(), inode: stat.ino.toString() }
}

function linuxIdentity(overrides: Partial<LinuxLocalInstanceRecord> = {}): LinuxLocalInstanceRecord {
  return {
    schema: 1,
    scopeId: 'a'.repeat(64),
    profileRealpath: '/fixture/profile',
    instanceId: 'instance-test',
    hostPid: process.pid,
    hostStarttime: readProcessStarttime(process.pid) ?? '0',
    origin: 'http://127.0.0.1:41001',
    protocol: LOCAL_PROTOCOL,
    bundleVersion: '0.5.7',
    dshVersion: '0.2.2-rc.3',
    buildId: 'b'.repeat(64),
    ...overrides,
  }
}

function darwinIdentity(overrides: Partial<DarwinLocalInstanceRecord> = {}): DarwinLocalInstanceRecord {
  const self = readKernelProcess(process.pid)
  assert.equal(self.kind, 'alive', 'the test process must expose a real Darwin identity')
  const identity = (self as { readonly kind: 'alive'; readonly identity: DarwinKernelProcessIdentity }).identity
  assert.equal(identity.platform, 'darwin')
  return {
    schema: 2,
    scopeId: 'a'.repeat(64),
    profileRealpath: '/fixture/profile',
    instanceId: '11111111-1111-4111-8111-111111111111',
    hostPid: process.pid,
    hostKernelIdentity: identity,
    origin: 'http://127.0.0.1:41001',
    protocol: LOCAL_PROTOCOL,
    bundleVersion: '0.5.7',
    dshVersion: '0.2.2-rc.3',
    buildId: 'b'.repeat(64),
    ...overrides,
  }
}

/** A controlled authenticated transport whose Host object answer is injected. */
function transportOf(
  object: () => { readonly device: string; readonly inode: string } | undefined,
  generation = 7,
): LaunchWorkspaceTransport & { readonly calls: Array<{ readonly url: string; readonly body: unknown }>; generationId: number | undefined } {
  const calls: Array<{ readonly url: string; readonly body: unknown }> = []
  const transport = {
    generationId: generation as number | undefined,
    calls,
    status() {
      return transport.generationId === undefined
        ? { transport: 'disconnected' as const }
        : { transport: 'connected' as const, generationId: transport.generationId }
    },
    async authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as unknown })
      const value = object()
      if (value === undefined) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
      return Response.json(
        { schema: 1, instanceId: '11111111-1111-4111-8111-111111111111', device: value.device, inode: value.inode },
        { headers: { 'cache-control': 'no-store' } },
      )
    },
  }
  return transport
}

function scopeOf(record: LocalInstanceRecord): LocalScope {
  return {
    scopeId: record.scopeId,
    dshHome: '/fixture/dsh-home',
    profileRealpath: record.profileRealpath,
    dir: '/fixture/run',
    hostSocketName: '',
    clientSeatSocketName: '',
    buildId: record.buildId,
    bundleVersion: record.bundleVersion,
    dshVersion: record.dshVersion,
  } as unknown as LocalScope
}

test('the REAL Linux /proc proves the Client launch directory is the Host directory', LINUX_ONLY, async t => {
  const life: TestLifecycle = testLifecycle(t)
  const root = life.tempDir('dsh-f5b-equivalence-')
  const launchCwd = realpathSync(root)
  const launchObject = launchObjectOf(launchCwd)
  const verdict = await classifyLaunchWorkspace(linuxIdentity(), launchCwd, { launchObject })
  assert.equal(verdict.kind, 'verified', JSON.stringify(verdict))
  if (verdict.kind !== 'verified') return
  assert.equal(verdict.launchCwd, launchCwd)
  assert.equal(verdict.hostPid, process.pid)
  assert.match(verdict.device, /^\d+$/u)
  assert.match(verdict.inode, /^\d+$/u)
  assert.equal(await verdict.revalidate(), true, 'the same live evidence revalidates')
})

test('a mismatched Host starttime is unverified (PID reuse is never evidence)', LINUX_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const launchCwd = realpathSync(root)
  const verdict = await classifyLaunchWorkspace(
    linuxIdentity({ hostStarttime: '1' }),
    launchCwd,
    { launchObject: launchObjectOf(launchCwd) },
  )
  assert.equal(verdict.kind, 'unverified')
  assert.match(verdict.kind === 'unverified' ? verdict.reason : '', /starttime/u)
})

test('an unreadable /proc/<pid>/stat is unverified, never a guess', LINUX_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const launchCwd = realpathSync(root)
  const verdict = await classifyLaunchWorkspace(
    linuxIdentity({ hostPid: 999_999_999, hostStarttime: '12345' }),
    launchCwd,
    { launchObject: launchObjectOf(launchCwd) },
  )
  assert.equal(verdict.kind, 'unverified')
  assert.match(verdict.kind === 'unverified' ? verdict.reason : '', /not readable/u)
})

test('the same pathname under a DIFFERENT Host root object is unverified', LINUX_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const identity = linuxIdentity()
  const launchCwd = `${root}/work`
  mkdirSync(launchCwd)
  const realLaunch = realpathSync(launchCwd)
  // A fabricated proc root: `<procRoot>/<pid>/stat` carries the authenticated
  // starttime, while `<procRoot>/<pid>/root/<launchCwd>` names a DIFFERENT
  // directory object at the SAME pathname (the mount-view mismatch shape).
  const procRoot = `${root}/proc`
  mkdirSync(procRoot)
  const pidDir = `${procRoot}/${String(identity.hostPid)}`
  mkdirSync(pidDir)
  writeFileSync(join(pidDir, 'stat'), `1 (host) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${identity.hostStarttime} 0 0\n`)
  const hostView = join(pidDir, 'root')
  mkdirSync(hostView)
  mkdirSync(join(hostView, realLaunch.slice(1)), { recursive: true })
  const verdict = await classifyLaunchWorkspace(identity, realLaunch, { procRoot, launchObject: launchObjectOf(realLaunch) })
  assert.equal(verdict.kind, 'unverified')
  assert.match(verdict.kind === 'unverified' ? verdict.reason : '', /different directory objects/u)
})

test('a launch cwd that is not a directory is unverified', LINUX_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const file = join(root, 'not-a-dir.txt')
  writeFileSync(file, 'x')
  assert.equal((await classifyLaunchWorkspace(linuxIdentity(), file, { launchObject: launchObjectOf(file) })).kind, 'unverified')
})

test('a symlinked Client view resolves to the SAME object on this same-root Host', LINUX_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const real = join(root, 'real')
  mkdirSync(real)
  const link = join(root, 'link')
  symlinkSync(real, link)
  const realPath = realpathSync(real)
  assert.equal((await classifyLaunchWorkspace(linuxIdentity(), realPath, { launchObject: launchObjectOf(realPath) })).kind, 'verified')
  // `stat` follows the link, so on a same-root Host the link is the SAME
  // directory object — the (dev, ino) comparison, not the spelling, decides.
  assert.equal((await classifyLaunchWorkspace(linuxIdentity(), link, { launchObject: launchObjectOf(link) })).kind, 'verified')
})

test('a Linux launch proof is unverified on the macOS platform branch', LINUX_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const launchCwd = realpathSync(root)
  const verdict = await classifyLaunchWorkspace(linuxIdentity(), launchCwd, {
    platform: 'darwin',
    launchObject: launchObjectOf(launchCwd),
  })
  assert.equal(verdict.kind, 'unverified')
  assert.match(verdict.kind === 'unverified' ? verdict.reason : '', /schema 2/u)
})

test('a missing authenticated Host identity is unverified', LINUX_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const launchCwd = realpathSync(root)
  assert.equal((await classifyLaunchWorkspace(undefined, launchCwd, { launchObject: launchObjectOf(launchCwd) })).kind, 'unverified')
})

test('the shared official parser reads a real /proc/<pid>/stat and rejects a fabricated one', LINUX_ONLY, () => {
  assert.equal(readProcessStarttimeAt(process.pid), readProcessStarttime(process.pid))
  assert.equal(readProcessStarttimeAt(999_999_999), undefined)
})

test('revalidate fails closed when the Host identity changes INSIDE its observation window', LINUX_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const identity = linuxIdentity()
  const launchCwd = realpathSync(root)
  // The injected reader replays the exact race: classify's two reads match,
  // revalidate's first read matches, then the Host PID restarts (a different
  // starttime) BETWEEN revalidate's first check and its post-stats check.
  const matching = identity.hostStarttime
  let reads = 0
  const verdict = await classifyLaunchWorkspace(identity, launchCwd, {
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
  assert.equal(verdict.kind === 'verified' ? await verdict.revalidate() : true, false,
    'a Host restart inside the revalidation window revokes the proof')
})

test('revalidate still proves unchanged identity across its full window', LINUX_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const launchCwd = realpathSync(root)
  const verdict = await classifyLaunchWorkspace(linuxIdentity(), launchCwd, { launchObject: launchObjectOf(launchCwd) })
  assert.equal(verdict.kind, 'verified')
  assert.equal(verdict.kind === 'verified' ? await verdict.revalidate() : false, true)
})

test('a rename-and-recreate of the launch path is NOT the launch directory (real OS negative)', LINUX_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const work = join(root, 'project')
  mkdirSync(work)
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
  const verdict = await classifyLaunchWorkspace(linuxIdentity(), work, { launchObject: startup })
  assert.equal(verdict.kind, 'unverified')
  assert.match(verdict.kind === 'unverified' ? verdict.reason : '', /renamed or recreated/u)

  // POSITIVE CONTROL: without the replacement the same call verifies.
  const stable = join(root, 'stable')
  mkdirSync(stable)
  assert.equal((await classifyLaunchWorkspace(linuxIdentity(), stable, { launchObject: launchObjectOf(stable) })).kind, 'verified')
})

test('revalidate also refuses a launch path replaced after the first classification', LINUX_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const work = join(root, 'project')
  mkdirSync(work)
  const startup = launchObjectOf(work)
  const verdict = await classifyLaunchWorkspace(linuxIdentity(), work, { launchObject: startup })
  assert.equal(verdict.kind, 'verified')
  if (verdict.kind !== 'verified') return
  renameSync(work, join(root, 'project.old'))
  mkdirSync(work)
  assert.equal(await verdict.revalidate(), false,
    'a path recreation after classification revokes the proof even though path and Host view agree')
})

const scopeForDarwin = (record: DarwinLocalInstanceRecord): LocalScope => scopeOf(record)

test('macOS verifies the launch directory through the authenticated Host object route', DARWIN_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const record = darwinIdentity()
  const launchObject = launchObjectOf(root)
  const transport = transportOf(() => launchObject)
  const scope = scopeForDarwin(record)
  const verdict = await classifyLaunchWorkspace(record, root, {
    launchObject,
    transport,
    scope,
    readRecord: () => record,
    readKernel: () => ({ kind: 'alive', identity: record.hostKernelIdentity }),
  })
  assert.equal(verdict.kind, 'verified', JSON.stringify(verdict))
  if (verdict.kind !== 'verified') return
  assert.equal(verdict.device, launchObject.device)
  assert.equal(verdict.inode, launchObject.inode)
  assert.equal(await verdict.revalidate(), true)
  // The Host was asked exactly once per proof, through the exact route.
  assert.equal(transport.calls.length, 2)
  assert.match(transport.calls[0].url, /\/api\/pi-tui\.workspace-object$/u)
  assert.equal((transport.calls[0].body as { readonly instanceId?: string }).instanceId, record.instanceId)
  assert.equal((transport.calls[0].body as { readonly path?: string }).path, root)
})

test('macOS is unverified for a different Host object, missing generation or changed publication', DARWIN_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const record = darwinIdentity()
  const launchObject = launchObjectOf(root)
  const readKernel = (): KernelObservation => ({ kind: 'alive', identity: record.hostKernelIdentity })

  const different = await classifyLaunchWorkspace(record, root, {
    launchObject,
    transport: transportOf(() => ({ device: launchObject.device, inode: '9' })),
    scope: scopeForDarwin(record),
    readRecord: () => record,
    readKernel,
  })
  assert.equal(different.kind, 'unverified')
  assert.match(different.kind === 'unverified' ? different.reason : '', /different directory objects/u)

  const noGeneration = transportOf(() => launchObject)
  noGeneration.generationId = undefined
  const disconnected = await classifyLaunchWorkspace(record, root, {
    launchObject,
    transport: noGeneration,
    scope: scopeForDarwin(record),
    readRecord: () => record,
    readKernel,
  })
  assert.equal(disconnected.kind, 'unverified')
  assert.match(disconnected.kind === 'unverified' ? disconnected.reason : '', /generation/u)

  const changedRecord = darwinIdentity({ instanceId: '22222222-2222-4222-8222-222222222222' })
  const changed = await classifyLaunchWorkspace(record, root, {
    launchObject,
    transport: transportOf(() => launchObject),
    scope: scopeForDarwin(record),
    readRecord: () => changedRecord,
    readKernel,
  })
  assert.equal(changed.kind, 'unverified')
  assert.match(changed.kind === 'unverified' ? changed.reason : '', /current Host publication/u)
})

test('macOS revalidate revokes on a renamed launch path, generation rollover or kernel change', DARWIN_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const work = join(root, 'project')
  mkdirSync(work)
  const record = darwinIdentity()
  const launchObject = launchObjectOf(work)
  const transport = transportOf(() => launchObject)
  const scope = scopeForDarwin(record)
  let kernel: KernelObservation = { kind: 'alive', identity: record.hostKernelIdentity }
  const verdict = await classifyLaunchWorkspace(record, work, {
    launchObject,
    transport,
    scope,
    readRecord: () => record,
    readKernel: () => kernel,
  })
  assert.equal(verdict.kind, 'verified')
  if (verdict.kind !== 'verified') return

  // Generation rollover: the old proof must never authorize a new generation.
  transport.generationId = 8
  assert.equal(await verdict.revalidate(), false, 'a new Connection generation revokes the proof')
  transport.generationId = 7

  // Kernel identity change (Host restart/replacement).
  kernel = { kind: 'alive', identity: { ...record.hostKernelIdentity, uniqueId: '1' } }
  assert.equal(await verdict.revalidate(), false, 'a changed Host kernel identity revokes the proof')
  kernel = { kind: 'alive', identity: record.hostKernelIdentity }

  // Rename + recreate at the SAME spelling is a different launch object.
  renameSync(work, join(root, 'project.old'))
  mkdirSync(work)
  assert.equal(await verdict.revalidate(), false, 'a recreated launch path revokes the proof')
})

test('macOS rejects a Host object response whose launch path changed while the response was in flight', DARWIN_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const work = join(root, 'project')
  mkdirSync(work)
  const record = darwinIdentity()
  const launchObject = launchObjectOf(work)
  let entered!: () => void
  const enteredResponse = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const responseGate = new Promise<void>(resolve => { release = resolve })
  const transport: LaunchWorkspaceTransport = {
    status: () => ({ transport: 'connected', generationId: 7 }),
    async authenticatedFetch(): Promise<Response> {
      entered()
      await responseGate
      // The Host observed the OLD object before the rename; this late response
      // is exactly the stale observation the Client must refuse.
      return Response.json(
        { schema: 1, instanceId: record.instanceId, device: launchObject.device, inode: launchObject.inode },
        { headers: { 'cache-control': 'no-store' } },
      )
    },
  }
  const pending = classifyLaunchWorkspace(record, work, {
    launchObject,
    transport,
    scope: scopeOf(record),
    readRecord: () => record,
    readKernel: () => ({ kind: 'alive', identity: record.hostKernelIdentity }),
  })
  await enteredResponse
  renameSync(work, `${work}.old`)
  mkdirSync(work)
  release()
  const verdict = await pending
  assert.equal(verdict.kind, 'unverified', JSON.stringify(verdict))
  assert.match(verdict.kind === 'unverified' ? verdict.reason : '', /changed while the Host object was observed/u)
})

test('macOS revalidate rejects a late Host observation after the launch path was recreated', DARWIN_ONLY, async t => {
  const root = testLifecycle(t).tempDir('dsh-f5b-equivalence-')
  const work = join(root, 'project')
  mkdirSync(work)
  const record = darwinIdentity()
  const launchObject = launchObjectOf(work)
  let defer = false
  let entered!: () => void
  let enteredResponse = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  let responseGate = new Promise<void>(resolve => { release = resolve })
  const oldObjectResponse = (): Response => Response.json(
    { schema: 1, instanceId: record.instanceId, device: launchObject.device, inode: launchObject.inode },
    { headers: { 'cache-control': 'no-store' } },
  )
  const transport: LaunchWorkspaceTransport = {
    status: () => ({ transport: 'connected', generationId: 7 }),
    async authenticatedFetch(): Promise<Response> {
      if (!defer) return oldObjectResponse()
      entered()
      await responseGate
      return oldObjectResponse()
    },
  }
  const verdict = await classifyLaunchWorkspace(record, work, {
    launchObject,
    transport,
    scope: scopeOf(record),
    readRecord: () => record,
    readKernel: () => ({ kind: 'alive', identity: record.hostKernelIdentity }),
  })
  assert.equal(verdict.kind, 'verified')
  if (verdict.kind !== 'verified') return
  defer = true
  const pending = verdict.revalidate()
  await enteredResponse
  renameSync(work, `${work}.old`)
  mkdirSync(work)
  release()
  assert.equal(await pending, false,
    'a Host observation that names the pre-rename object is stale once the launch path was recreated')
})
