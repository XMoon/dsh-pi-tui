/**
 * Split-process business qualification: real installed Host/Client seat
 * ownership, concurrent contenders, scratch ownership and stale recovery.
 */

import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'

import { expect, test } from 'vitest'

import {
  assertClientHostMatchesPublished,
  assertPublishedHostIdentityLive,
  assertPublishedHostIdentityTerminal,
  assertPublishedHostMatchesKernel,
  exchangeCookie,
  rawHttpRequest,
  readAuthenticatedIdentity,
  readScopeFiles,
} from '../../../support/split-process-authentication.ts'
import {
  createSplitProcessScene,
  type HostAttemptHandle,
  type QualificationClientHandle,
  type SplitProcessHostHandle,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

interface PrivateFileSnapshot {
  bytes: Buffer
  mode: number
}

function savePrivateFile(path: string): PrivateFileSnapshot {
  return { bytes: readFileSync(path), mode: statSync(path).mode & 0o777 }
}

function expectSamePrivateFile(path: string, snapshot: PrivateFileSnapshot, label: string): void {
  const current = readFileSync(path)
  expect(current.equals(snapshot.bytes), `${label}: the bytes changed`).toBe(true)
  expect(statSync(path).mode & 0o777, `${label}: the mode changed`).toBe(snapshot.mode)
}

/**
 * Prove the REAL primary Host kernel seat is currently held. Linux uses a real
 * abstract-socket bind conflict; Darwin opens the actual account-home lock
 * file with a non-blocking O_EXLOCK and expects the live claim. The qualification
 * seat file is NOT a substitute for the Host singleton.
 */
async function assertPrimaryHostSeatHeld(scene: SplitProcessScene): Promise<void> {
  const seat = scene.scope.hostSeat
  if (process.platform === 'linux') {
    expect(seat.kind).toBe('linux-abstract')
    expect(typeof seat.name).toBe('string')
    const name = String(seat.name)
    const server = createServer()
    const outcome = await new Promise<{ code?: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.close()
        reject(new Error('the abstract Host seat probe did not settle'))
      }, 10_000)
      server.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        resolve({ code: error.code })
      })
      server.listen({ path: name }, () => {
        clearTimeout(timer)
        server.close(() => resolve({}))
      })
    })
    expect(outcome.code, 'the live Host does not hold its Linux abstract seat').toBe('EADDRINUSE')
    return
  }
  expect(process.platform).toBe('darwin')
  expect(seat.kind).toBe('darwin-file')
  const seatPath = String(seat.path)
  const seatDir = dirname(seatPath)
  expect(statSync(seatDir).mode & 0o777, 'the Darwin Host seat directory is not private').toBe(0o700)
  const link = lstatSync(seatPath)
  expect(link.isSymbolicLink(), 'the Darwin Host seat file is a symlink').toBe(false)
  expect(link.isFile(), 'the Darwin Host seat is not a regular file').toBe(true)
  expect(link.mode & 0o777, 'the Darwin Host seat file is not 0600').toBe(0o600)
  if (typeof process.getuid === 'function') expect(link.uid).toBe(process.getuid())
  // An existing legal account root is accepted as-is (0755 is legal); it must be
  // this uid's real directory and not group/other writable.
  const accountRoot = join(userInfo().homedir, '.dsh-pi-tui')
  if (existsSync(accountRoot)) {
    const root = statSync(accountRoot)
    expect(root.isDirectory(), 'the Darwin account root is not a directory').toBe(true)
    if (typeof process.getuid === 'function') expect(root.uid).toBe(process.getuid())
    expect(root.mode & 0o022, 'the Darwin account root is group/other writable').toBe(0)
  }
  // O_RDWR|O_EXLOCK|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC; Node omits O_EXLOCK and
  // its type surface omits O_CLOEXEC, so both use their Darwin values.
  const flags = constants.O_RDWR | 0x20 | constants.O_NONBLOCK | constants.O_NOFOLLOW | 0x1000000
  let failure: NodeJS.ErrnoException | undefined
  try {
    closeSync(openSync(seatPath, flags, 0o600))
  } catch (error) {
    failure = error as NodeJS.ErrnoException
  }
  expect(failure?.code === 'EAGAIN' || failure?.code === 'EWOULDBLOCK',
    `the live Host does not hold its Darwin O_EXLOCK seat (${String(failure?.code ?? 'opened')})`).toBe(true)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function scopeScratchSet(dshHome: string, scopeId: string): string[] {
  const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', scopeId)
  if (!existsSync(scopeDir)) return []
  return readdirSync(scopeDir).filter(name => name.startsWith('host-scratch-')).sort()
}

/** Wait until every contender is settled and return the ONE Ready winner. */
async function waitHostRaceOutcome(
  scene: SplitProcessScene,
  attempts: HostAttemptHandle[],
): Promise<HostAttemptHandle> {
  const started = Date.now()
  for (;;) {
    const ready: HostAttemptHandle[] = []
    let liveLoser = false
    for (const attempt of attempts) {
      const facts = await scene.entryRecordFacts(attempt)
      if (facts.records.some(record => record.m4a0 === 'ready')) ready.push(attempt)
      else if (!facts.exited) liveLoser = true
    }
    if (ready.length > 1) throw new Error('more than one Host contender reached Ready on the one kernel seat')
    if (ready.length === 1 && !liveLoser) return ready[0]!
    if (Date.now() - started >= 240_000) throw new Error('the real Host contenders never settled to one Ready winner')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function waitQualificationRaceOutcome(
  scene: SplitProcessScene,
  clients: QualificationClientHandle[],
): Promise<{ winner: QualificationClientHandle; loser: QualificationClientHandle }> {
  const started = Date.now()
  for (;;) {
    const ready: QualificationClientHandle[] = []
    const failed: QualificationClientHandle[] = []
    let liveLoser = false
    for (const client of clients) {
      const facts = await scene.entryRecordFacts(client)
      if (facts.records.some(record => record.m4a0 === 'ready')) ready.push(client)
      else if (facts.records.some(record => record.m4a0 === 'failure')) failed.push(client)
      else if (!facts.exited) liveLoser = true
    }
    if (ready.length > 1) throw new Error('more than one qualification Client reached Ready on the one seat')
    if (ready.length === 1 && failed.length === 1 && !liveLoser) return { winner: ready[0]!, loser: failed[0]! }
    if (Date.now() - started >= 240_000) throw new Error('the real qualification Client contenders never settled')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function assertAuthenticatedHost(scene: SplitProcessScene, host: SplitProcessHostHandle): Promise<void> {
  const files = readScopeFiles(scene.installation.dshHome, scene.scope.scopeId)
  assertPublishedHostMatchesKernel(files.registry as never, 'the recovered registry')
  const cookie = await exchangeCookie(host.ready.localHost.origin, files.launch)
  const identity = await readAuthenticatedIdentity(host.ready.localHost.origin, cookie, 'the recovered identity')
  assertClientHostMatchesPublished(identity.identity as never, files.registry as never, 'the recovered identity')
}

test('admits exactly one Host when the same installed profile is started concurrently', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    // ONE real batch spawn: the Supervisor starts every contender synchronously
    // on the same profile/DSH home/scope, then proves at least two were really
    // alive at the batch boundary.
    const attempts = await scene.startHostAttempts({ mode: 'seat-race', count: 16 })
    expect(attempts).toHaveLength(16)
    expect(attempts.every(attempt => attempt.pid > 0 && typeof attempt.birth === 'string')).toBe(true)
    expect(new Set(attempts.map(attempt => attempt.pid)).size).toBe(16)
    expect(Number(attempts[0]!.coStarted)).toBeGreaterThanOrEqual(2)

    const winner = await waitHostRaceOutcome(scene, attempts)
    const ready = await scene.waitEntryRecord(winner, { m4a0: 'ready' })
    expect(ready.processRole).toBe('host')
    expect(ready.localHost.hostPid).toBe(winner.pid)
    expect(ready.localHost.scopeId).toBe(scene.scope.scopeId)
    expect(ready.localHost.buildId).toBe(scene.scope.buildId)
    assertPublishedHostMatchesKernel(ready.localHost as never, 'the race winner')

    for (const loser of attempts.filter(attempt => attempt !== winner)) {
      const conflict = await scene.waitEntryRecord(loser, { m4a0: 'host-seat-conflict' })
      expect(conflict.error).toBe('HOST_ALREADY_OWNED')
      const terminal = await scene.finishEntry(loser)
      expect(terminal.outcome).toBe('seat-conflict')
      expect(terminal.exit).toEqual({ code: 0, signal: null })
      const loserFacts = await scene.entryRecordFacts(loser)
      expect(loserFacts.records.some(record => record.m4a0 === 'ready')).toBe(false)
      expect(loserFacts.records.some(record => record.m4a0 === 'failure')).toBe(false)
    }

    const host = await scene.acceptHostWinner(winner)
    expect(host.ready.localHost.hostPid).toBe(winner.pid)
    expect(host.ready.localHost.instanceId).toBe(ready.localHost.instanceId)
    await assertAuthenticatedHost(scene, host)

    // The narrowed entry API refuses unsafe destructive inputs before it can
    // touch the live winner.
    await expect(scene.request('START_HOST_ATTEMPTS', {
      mode: 'seat-conflict',
      scratchTarget: join(scene.workDir, '..', 'escape'),
    })).rejects.toThrow(/must be a contained Scene path/u)
    await expect(scene.request('SIGNAL_ENTRY', { entryId: winner.entryId, signal: 'SIGUSR1' }))
      .rejects.toThrow(/unsupported signal/u)
    await expect(scene.request('WAIT_ENTRY_RECORD', {
      entryId: winner.entryId,
      match: { expected: true },
    })).rejects.toThrow(/rejects that record match shape/u)
    await expect(scene.request('FINISH_ENTRY', { entryId: winner.entryId }))
      .rejects.toThrow(/seat winner must be accepted through ACCEPT_HOST_WINNER/u)
    const registry = readScopeFiles(scene.installation.dshHome, scene.scope.scopeId).registry
    expect(registry.hostPid).toBe(winner.pid)
    const statusBefore = await scene.hostStatus(host)
    const winnerScratch = readdirSync(scene.scopeDir).filter(name => name.startsWith('host-scratch-'))
    expect(winnerScratch).toHaveLength(1)
    const winnerScratchPath = join(scene.scopeDir, winnerScratch[0]!)
    const outsideSentinel = join(scene.workDir, 'host-scratch-outside')
    mkdirSync(outsideSentinel, { recursive: true, mode: 0o700 })
    writeFileSync(join(outsideSentinel, 'sentinel'), 'owned by the Scene, not the Host\n', { mode: 0o600 })

    // Two real single-contender conflicts: one targets the live winner's own
    // scratch, the other a Scene-owned scope-outside directory. Neither loser
    // may delete either target.
    for (const target of [winnerScratchPath, outsideSentinel]) {
      const [contender] = await scene.startHostAttempts({ mode: 'seat-conflict', scratchTarget: target })
      expect(contender).toBeDefined()
      const conflict = await scene.waitEntryRecord(contender!, { m4a0: 'host-seat-conflict' })
      expect(conflict.error).toBe('HOST_ALREADY_OWNED')
      const terminal = await scene.finishEntry(contender!)
      expect(terminal.outcome).toBe('seat-conflict')
      expect(terminal.exit).toEqual({ code: 0, signal: null })
      expect(contender!.scratch).toBe(target)
      expect(existsSync(target)).toBe(true)
      const status = await scene.hostStatus(host)
      expect(status.localHost.hostPid).toBe(winner.pid)
      expect(status.localHost.instanceId).toBe(ready.localHost.instanceId)
      expect(status.rootFiberUid).toBe(statusBefore.rootFiberUid)
      expect(status.services.piTuiHostReady).toBe(true)
    }

    await scene.stopHost(host)
    expect(existsSync(winnerScratchPath)).toBe(false)
    expect(existsSync(outsideSentinel)).toBe(true)
    await scene.assertEntrySeatsFree()

    // The freed kernel seat is reusable on the same installed profile.
    const again = await scene.startHost()
    await assertAuthenticatedHost(scene, again)
    await scene.stopHost(again)
    expect(existsSync(outsideSentinel)).toBe(true)
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the Host seat-race test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the Host seat-race test passed but its Scene cleanup failed')
    }
  }
})

test('admits one qualification Client and releases its seat without stopping the Host', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    const host = await scene.startHost()
    const statusBefore = await scene.hostStatus(host)
    const clients = await scene.startQualificationClients({ mode: 'seat-race' })
    expect(clients).toHaveLength(2)
    expect(new Set(clients.map(client => client.pid)).size).toBe(2)
    const { winner, loser } = await waitQualificationRaceOutcome(scene, clients)

    const ready = await scene.waitEntryRecord(winner, { m4a0: 'ready' })
    expect(ready.processRole).toBe('client')
    expect(ready.transport).toBe('connected')
    expect(ready.surfaceMounted).toBe(false)
    expect(ready.sessionOpen).toBe(false)
    expect(Number.isInteger(ready.generationId)).toBe(true)
    expect(ready.host.hostPid).toBe(host.ready.localHost.hostPid)
    expect(ready.host.instanceId).toBe(host.ready.localHost.instanceId)
    expect(ready.host.buildId).toBe(scene.scope.buildId)
    assertClientHostMatchesPublished(ready.host as never, host.ready.localHost as never, 'the qualification Client')

    const failure = await scene.waitEntryRecord(loser, { m4a0: 'failure' })
    expect(failure.code).toBe('CLIENT_ALREADY_ACTIVE')
    const loserTerminal = await scene.finishEntry(loser)
    expect(loserTerminal.exit).toEqual({ code: 1, signal: null })
    expect(loserTerminal.outcome).toBe('startup-refusal')

    const winnerTerminal = await scene.finishEntry(winner)
    expect(winnerTerminal.exit).toEqual({ code: 0, signal: null })
    const statusAfter = await scene.hostStatus(host)
    expect(statusAfter.localHost.hostPid).toBe(host.ready.localHost.hostPid)
    expect(statusAfter.localHost.instanceId).toBe(host.ready.localHost.instanceId)
    expect(statusAfter.rootFiberUid).toBe(statusBefore.rootFiberUid)
    expect(statusAfter.services.piTuiHostReady).toBe(true)

    // The released seat supports a NEW qualification Client against the SAME
    // Host, with a different Client identity.
    const [next] = await scene.startQualificationClients({ mode: 'attach' })
    const nextReady = await scene.waitEntryRecord(next!, { m4a0: 'ready' })
    expect(nextReady.pid).not.toBe(ready.pid)
    expect(nextReady.transport).toBe('connected')
    expect(nextReady.host.hostPid).toBe(host.ready.localHost.hostPid)
    expect(nextReady.host.instanceId).toBe(host.ready.localHost.instanceId)
    const nextStatus = await scene.entryStatus(next!)
    expect(nextStatus.transport).toBe('connected')
    expect(nextStatus.sessionOpen).toBe(false)
    expect(Number.isInteger(nextStatus.generationId)).toBe(true)
    const nextTerminal = await scene.finishEntry(next!)
    expect(nextTerminal.exit).toEqual({ code: 0, signal: null })

    const finalStatus = await scene.hostStatus(host)
    expect(finalStatus.localHost.hostPid).toBe(host.ready.localHost.hostPid)
    expect(finalStatus.localHost.instanceId).toBe(host.ready.localHost.instanceId)
    expect(finalStatus.rootFiberUid).toBe(statusBefore.rootFiberUid)
    expect(finalStatus.services.piTuiHostReady).toBe(true)

    // An exit-0 seat-conflict contender is an ATTEMPT, not a generation. While
    // it is un-finished, START_HOST must refuse even though its process exited 0.
    const conflictDir = join(scene.workDir, 'conflict-scratch')
    mkdirSync(conflictDir, { recursive: true, mode: 0o700 })
    const [conflict] = await scene.startHostAttempts({ mode: 'seat-conflict', scratchTarget: conflictDir })
    await scene.waitEntryRecord(conflict!, { m4a0: 'host-seat-conflict' })
    await scene.stopHost(host)
    const conflictSettled = Date.now() + 30_000
    while (!(await scene.entryRecordFacts(conflict!)).exited) {
      if (Date.now() >= conflictSettled) throw new Error('the exit-0 seat contender never closed')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await expect(scene.startHost())
      .rejects.toThrow(/un-finished Host attempt cannot become a previous generation/u)
    const conflictTerminal = await scene.finishEntry(conflict!)
    expect(conflictTerminal.outcome).toBe('seat-conflict')
    expect(conflictTerminal.exit).toEqual({ code: 0, signal: null })
    const recovered = await scene.startHost()
    await scene.stopHost(recovered)

    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the qualification Client seat test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the qualification Client seat test passed but its Scene cleanup failed')
    }
  }
})

test('recovers a stale Host through authenticated discovery and rejects its retired credentials', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    const host = await scene.startHost()
    const oldFiles = readScopeFiles(scene.installation.dshHome, scene.scope.scopeId)
    const oldToken = new URL(oldFiles.launch.connectUrl).searchParams.get('token')
    expect(typeof oldToken).toBe('string')
    const oldCookie = await exchangeCookie(host.ready.localHost.origin, oldFiles.launch)
    const oldIdentity = await readAuthenticatedIdentity(host.ready.localHost.origin, oldCookie, 'the old identity')
    assertClientHostMatchesPublished(oldIdentity.identity as never, oldFiles.registry as never, 'the old identity')
    const oldScratch = scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)
    expect(oldScratch).toHaveLength(1)

    // A real SIGKILL leaves the authentic stale registry behind.
    await scene.request('SIGNAL_ENTRY', { entryId: host.entryId, signal: 'SIGKILL' }, 60_000)
    const crashed = await scene.finishEntry(host)
    expect(crashed.exit).toEqual({ code: null, signal: 'SIGKILL' })
    expect(existsSync(oldFiles.registryPath)).toBe(true)
    expect(existsSync(oldFiles.launchPath)).toBe(true)

    const [client] = await scene.startQualificationClients({ mode: 'discover-after-host-death' })
    const ready = await scene.waitEntryRecord(client!, { m4a0: 'ready' })
    expect(ready.transport).toBe('connected')
    const discovered = ready.host
    expect(discovered.hostPid).not.toBe(oldFiles.registry.hostPid)
    expect(discovered.instanceId).not.toBe(oldFiles.registry.instanceId)
    assertPublishedHostMatchesKernel(discovered as never, 'the discovered Host')

    const newFiles = readScopeFiles(scene.installation.dshHome, scene.scope.scopeId)
    expect(newFiles.registry.hostPid).toBe(discovered.hostPid)
    expect(newFiles.registry.instanceId).toBe(discovered.instanceId)
    const newToken = new URL(newFiles.launch.connectUrl).searchParams.get('token')
    expect(newToken === oldToken, 'the recovered Host republished the retired launch token').toBe(false)

    // Retired credentials are refused by the NEW authenticated Host.
    const oldTokenResponse = await rawHttpRequest(discovered.origin, {
      path: `/connect?token=${encodeURIComponent(String(oldToken))}&interactions=answer`,
    })
    expect(oldTokenResponse.status).toBe(401)
    const oldCookieResponse = await rawHttpRequest(discovered.origin, {
      path: '/api/pi-tui.local-host',
      headers: { cookie: oldCookie },
    })
    expect(oldCookieResponse.status).toBe(401)
    const newCookie = await exchangeCookie(discovered.origin, newFiles.launch)
    const newIdentity = await readAuthenticatedIdentity(discovered.origin, newCookie, 'the new identity')
    assertClientHostMatchesPublished(newIdentity.identity as never, newFiles.registry as never, 'the new identity')

    // The stale Host scratch and the NEW Host scratch coexist as a SET; the
    // reclaimed Host must remove only its own.
    const spawnedScratch = scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)
    expect(spawnedScratch.length).toBe(2)
    expect(spawnedScratch).toEqual(expect.arrayContaining(oldScratch))
    const hostLogPath = join(scene.scopeDir, 'host.log')
    expect(existsSync(hostLogPath)).toBe(true)
    expect(statSync(hostLogPath).mode & 0o777).toBe(0o600)
    expect(statSync(hostLogPath).size).toBeGreaterThan(0)
    expect(statSync(hostLogPath).size).toBeLessThanOrEqual(2 * 1024 * 1024)
    const hostLog = readFileSync(hostLogPath, 'utf8')
    expect(hostLog.includes(String(oldToken))).toBe(false)
    expect(hostLog.includes(newCookie)).toBe(false)

    const clientExit = await scene.finishEntry(client!)
    expect(clientExit.exit).toEqual({ code: 0, signal: null })
    assertPublishedHostIdentityLive(discovered as never, 'the discovered Host before Client exit')

    const [attached] = await scene.startQualificationClients({ mode: 'attach' })
    const attachedReady = await scene.waitEntryRecord(attached!, { m4a0: 'ready' })
    expect(attachedReady.host.hostPid).toBe(discovered.hostPid)
    expect(attachedReady.host.instanceId).toBe(discovered.instanceId)
    expect(scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)).toEqual(spawnedScratch)
    const attachedExit = await scene.finishEntry(attached!)
    expect(attachedExit.exit).toEqual({ code: 0, signal: null })
    assertPublishedHostIdentityLive(discovered as never, 'the discovered Host before Client exit')

    // The discovered fallback Host is still live even though the original
    // accepted Host is gone: installed-copy mutation admission must refuse it.
    await expect(scene.setInstallationFault('host-runtime-absent'))
      .rejects.toThrow(/discovered Host|Host attempt/u)
    const reclaimed = await scene.reclaimDiscoveredHost(client!)
    expect(reclaimed.pid).toBe(discovered.hostPid)
    expect(reclaimed.reclaimed).toBe(true)
    expect(reclaimed.registryRemoved).toBe(true)
    assertPublishedHostIdentityTerminal(discovered as never, 'the reclaimed discovered Host')
    // Only the stale scratch remains; the reclaimed Host removed its own.
    expect(scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)).toEqual(oldScratch)
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the stale Host recovery test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the stale Host recovery test passed but its Scene cleanup failed')
    }
  }
})

test('refuses cross-home discovery for the same canonical profile while the Host seat is owned', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  let client: QualificationClientHandle | undefined
  let clientFinished = false
  try {
    const host = await scene.startHost()
    const files = readScopeFiles(scene.installation.dshHome, scene.scope.scopeId)
    const registrySnapshot = savePrivateFile(files.registryPath)
    const launchSnapshot = savePrivateFile(files.launchPath)
    const hostPid = host.ready.localHost.hostPid
    const hostInstanceId = host.ready.localHost.instanceId
    const hostRootFiberUid = host.ready.rootFiberUid
    const sessionsBefore = await scene.sessionIds()
    await assertAuthenticatedHost(scene, host)
    await assertPrimaryHostSeatHeld(scene)

    const [started] = await scene.startQualificationClients({ mode: 'cross-home-seat-refusal' })
    client = started!
    const reservation = (await scene.entryRecordFacts(client)).crossHome
    expect(reservation, 'the cross-home reservation facts are missing').toBeDefined()
    expect(reservation?.aliasHome).not.toBe(scene.installation.dshHome)
    expect(reservation?.sameCanonicalProfile).toBe(true)
    expect(reservation?.sameScope).toBe(true)
    expect(reservation?.distinctDiscoveryRoots).toBe(true)

    const failure = await scene.waitEntryRecord(client, { m4a0: 'failure' }, 240_000)
    expect(failure.code).toBe('HOST_START_TIMEOUT')
    const terminal = await scene.finishEntry(client)
    clientFinished = true
    expect(terminal.outcome).toBe('startup-refusal')
    expect(terminal.exit).toEqual({ code: 1, signal: null })
    const facts = terminal.crossHome as Record<string, any> | undefined
    expect(facts, 'the cross-home terminal facts are missing').toBeDefined()
    expect(facts?.terminal).toBe('seat-conflict')
    expect(facts?.conflict).toMatchObject({
      error: 'HOST_ALREADY_OWNED',
      scopeId: scene.scope.scopeId,
    })
    expect(Number.isInteger(facts?.conflict?.pid)).toBe(true)
    expect(facts?.aliasRegistryAbsent).toBe(true)
    expect(facts?.aliasLaunchAbsent).toBe(true)
    expect(facts?.aliasSeatFree).toBe(true)
    expect(facts?.primarySeatBusy).toBe(true)
    expect(facts?.primaryPid).toBe(hostPid)
    expect(facts?.primaryInstanceId).toBe(hostInstanceId)

    // The Worker independently reads the REAL new alias Host log: exactly the
    // one product seat-conflict record, the same canonical scope, and no
    // profile boot / publication.
    const aliasScopeDir = facts?.aliasScopeDir
    expect(typeof aliasScopeDir, 'the alias scope directory is missing').toBe('string')
    const aliasScopePath = String(aliasScopeDir)
    const aliasHostLog = readFileSync(join(aliasScopePath, 'host.log'), 'utf8')
    expect(aliasHostLog.endsWith('\n'), 'the alias Host log has an incomplete trailing record').toBe(true)
    const aliasRecords = aliasHostLog.slice(0, -1).split('\n').filter(line => line !== '').map(line => JSON.parse(line))
    const aliasConflicts = aliasRecords.filter(record => record.m4a0 === 'host-seat-conflict')
    expect(aliasConflicts).toHaveLength(1)
    expect(aliasConflicts[0]).toMatchObject({
      m4a0: 'host-seat-conflict',
      processRole: 'host',
      error: 'HOST_ALREADY_OWNED',
      scopeId: scene.scope.scopeId,
    })
    expect(Number.isInteger(aliasConflicts[0].pid)).toBe(true)
    expect(aliasRecords.some(record => record.m4a0 === 'ready' || record.m4a0 === 'failure'
      || record.m4a0 === 'cleanup-failure' || record.m4a0 === 'profile-booted')).toBe(false)
    for (const path of [join(aliasScopePath, 'instance.json'), join(aliasScopePath, 'launch.json')]) {
      expect(existsSync(path), `the alias published ${path}`).toBe(false)
    }

    // The primary Host material and identity are untouched, and its real seat is
    // still held after the refusal (not only at reservation time).
    expectSamePrivateFile(files.registryPath, registrySnapshot, 'the primary registry')
    expectSamePrivateFile(files.launchPath, launchSnapshot, 'the primary launch')
    await assertPrimaryHostSeatHeld(scene)
    await assertAuthenticatedHost(scene, host)
    const statusAfter = await scene.hostStatus(host)
    expect(statusAfter.localHost.hostPid).toBe(hostPid)
    expect(statusAfter.localHost.instanceId).toBe(hostInstanceId)
    expect(statusAfter.rootFiberUid).toBe(hostRootFiberUid)
    expect(statusAfter.services.piTuiHostReady).toBe(true)
    expect(await scene.sessionIds()).toEqual(sessionsBefore)

    // The normal Host release must still consume the fixed alias obligation and
    // free both the primary and alias seats.
    await scene.stopHost(host)
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    const cleanupErrors: Error[] = []
    if (client !== undefined && !clientFinished) {
      try {
        const facts = await scene.entryRecordFacts(client)
        if (!facts.exited) await scene.waitEntryRecord(client, { m4a0: 'failure' }, 240_000)
        await scene.finishEntry(client)
        clientFinished = true
      } catch (error) {
        cleanupErrors.push(asError(error))
      }
    }
    try {
      await scene.dispose()
    } catch (cleanupError) {
      cleanupErrors.push(asError(cleanupError))
    }
    if (cleanupErrors.length > 0) {
      if (testError !== undefined) {
        throw new AggregateError([testError, ...cleanupErrors],
          'the cross-home seat refusal test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(cleanupErrors,
        'the cross-home seat refusal test passed but its Scene cleanup failed')
    }
  }
})

test.runIf(process.platform === 'linux')('treats a same-birth Linux zombie as dead and never as a signal target', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    const host = await scene.startHost()
    await assertAuthenticatedHost(scene, host)
    const files = readScopeFiles(scene.installation.dshHome, scene.scope.scopeId)
    await scene.request('SIGNAL_ENTRY', { entryId: host.entryId, signal: 'SIGKILL' }, 60_000)
    const crashed = await scene.finishEntry(host)
    expect(crashed.exit).toEqual({ code: null, signal: 'SIGKILL' })

    const witness = await scene.startIdentityWitness('linux-zombie')
    try {
      expect(witness.kind).toBe('linux-zombie')
      expect(witness.pid).toBeGreaterThan(0)
      expect(witness.starttime).not.toBe(null)
      // The stale registry now names a real killed-but-unreaped child.
      writeFileSync(files.registryPath, `${JSON.stringify({
        ...files.registry,
        hostPid: witness.pid,
        hostStarttime: witness.starttime,
      }, null, 2)}\n`, { mode: 0o600 })

      const [client] = await scene.startQualificationClients({ mode: 'discover-after-host-death' })
      const ready = await scene.waitEntryRecord(client!, { m4a0: 'ready' })
      expect(ready.transport).toBe('connected')
      const discovered = ready.host
      expect(discovered.hostPid).not.toBe(witness.pid)
      expect(discovered.hostPid).not.toBe(files.registry.hostPid)
      expect(discovered.instanceId).not.toBe(files.registry.instanceId)
      assertPublishedHostMatchesKernel(discovered as never, 'the zombie-recovered Host')
      const newFiles = readScopeFiles(scene.installation.dshHome, scene.scope.scopeId)
      const newCookie = await exchangeCookie(discovered.origin, newFiles.launch)
      const identity = await readAuthenticatedIdentity(discovered.origin, newCookie, 'the zombie-recovered identity')
      assertClientHostMatchesPublished(identity.identity as never, newFiles.registry as never, 'the zombie-recovered identity')

      const clientExit = await scene.finishEntry(client!)
      expect(clientExit.exit).toEqual({ code: 0, signal: null })
      const reclaimed = await scene.reclaimDiscoveredHost(client!)
      expect(reclaimed.pid).toBe(discovered.hostPid)
      expect(reclaimed.reclaimed).toBe(true)
    } finally {
      await scene.finishIdentityWitness(witness)
    }
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the Linux zombie test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the Linux zombie test passed but its Scene cleanup failed')
    }
  }
})
