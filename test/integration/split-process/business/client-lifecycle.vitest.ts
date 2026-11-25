import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type SplitProcessClient,
  type SplitProcessHostHandle,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

type WorkEvent = Record<string, any>
const fixtureHelpers = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-fixtures.mjs')).href
) as {
  readC1WorkEvents(root: string): WorkEvent[]
  waitForC1WorkEvent(root: string, predicate: (event: WorkEvent) => boolean, label: string, timeoutMs?: number): Promise<WorkEvent>
}
const sessionHelpers = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-sessions.mjs')).href
) as {
  hostUserTexts(events: WorkEvent[]): string[]
  hostAssistantHasText(events: WorkEvent[], text: string): boolean
}

function scopeScratch(scene: SplitProcessScene): string[] {
  return readdirSync(scene.scopeDir).filter(name => name.startsWith('host-scratch-')).sort()
}

function clientDirectories(scene: SplitProcessScene, label: string): { home: string; cwd: string } {
  const root = join(scene.workDir, 'clients', label)
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  return { home, cwd }
}

/**
 * The active Host Loader rows whose live fiber is the continuity fact. A
 * Client-only Surface revision must not re-mount any of them; comparing row
 * ids alone would accept a replaced fiber.
 */
const PROTECTED_HOST_ROWS = [
  'agent',
  'session',
  'job-controller',
  'typert-gateway',
  'split-host-connection',
  'split-host-api-remotes',
  'split-host-file-upload',
  'split-host-session-stats',
  'split-host-turn-outline',
  'split-host-session-controller',
  'split-host-settings-controller',
  'deepseek-account',
  'split-host-session-log-download',
  'split-host-pi-tui-runtime',
  'pi-tui-performance-host',
  'pi-tui-visual-tools',
]

type ProtectedHostRow = { state: string; fiberUid: number }

async function protectedHostRows(
  scene: SplitProcessScene,
  host: SplitProcessHostHandle,
): Promise<Map<string, ProtectedHostRow>> {
  const status = await scene.hostStatus(host)
  const rows = new Map<string, ProtectedHostRow>()
  for (const entry of status.entries ?? []) {
    if (!PROTECTED_HOST_ROWS.includes(entry.id)) continue
    rows.set(entry.id, { state: entry.state, fiberUid: entry.fiberUid })
  }
  return rows
}

function expectHostRowsKept(
  before: Map<string, ProtectedHostRow>,
  after: Map<string, ProtectedHostRow>,
  label: string,
): void {
  expect(before.size, `${label}: not every protected Host row was active before HMR`).toBe(PROTECTED_HOST_ROWS.length)
  for (const id of PROTECTED_HOST_ROWS) {
    const expected = before.get(id)
    const actual = after.get(id)
    expect(expected, `${label}: row ${id} was not active before HMR`).toBeDefined()
    expect(expected?.state, `${label}: row ${id} was not active before HMR`).toBe('active')
    expect(Number.isInteger(expected?.fiberUid), `${label}: row ${id} had no live fiber UID`).toBe(true)
    expect(actual, `${label}: row ${id} left the active inventory`).toBeDefined()
    expect(actual?.state, `${label}: row ${id} left active state`).toBe('active')
    expect(actual?.fiberUid, `${label}: row ${id} was re-mounted`).toBe(expected?.fiberUid)
  }
}

async function frame(client: SplitProcessClient): Promise<string> {
  return await client.text()
}

async function waitFrame(client: SplitProcessClient, text: string, label: string, timeoutMs = 120_000): Promise<string> {
  const started = Date.now()
  for (;;) {
    const current = await frame(client)
    if (current.includes(text)) return current
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: frame never showed ${JSON.stringify(text)}; frame=${JSON.stringify(current.slice(-2000))}`)
    }
    await sleep(50)
  }
}

async function waitFrameGone(client: SplitProcessClient, text: string, label: string, timeoutMs = 120_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (!(await frame(client)).includes(text)) return
    if (Date.now() - started >= timeoutMs) throw new Error(`${label}: ${JSON.stringify(text)} stayed on the frame`)
    await sleep(50)
  }
}

function releaseFile(path: string | null | undefined, label: string): void {
  if (typeof path !== 'string' || path === '') throw new Error(`${label}: no Supervisor-owned release path`)
  writeFileSync(path, 'release\n', { mode: 0o600, flag: 'wx' })
}

async function settleInitialPrompt(
  scene: SplitProcessScene,
  client: SplitProcessClient,
  host: SplitProcessHostHandle,
  prompt: string,
  holdEvent: 'long-turn-held' | 'job-event' | undefined,
  label: string,
): Promise<string> {
  const before = new Set(await scene.sessionIds())
  await client.submit(prompt)
  const sessionId = await scene.waitForNewSessionId(before, `${label} Session`)
  if (holdEvent === 'long-turn-held') {
    await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!, event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
      `${label} held Turn`)
    releaseFile(host.holdReleasePath, `${label} long-turn release`)
    await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/end', `${label} settled Turn`)
  } else if (holdEvent === 'job-event') {
    await fixtureHelpers.waitForC1WorkEvent(host.jobWorkRoot!, event => event.kind === 'job-event' && event.event === 'registered',
      `${label} running Job`)
  }
  return sessionId
}

/**
 * Portable terminal-state observation for a recorded PID. An absent process
 * and a zombie are both terminal; an unreadable or permission-denied record is
 * NOT terminal and must fail the negative control.
 */
function processState(pid: number): 'gone' | 'terminal' | 'live' | 'unknown' {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown'
  try {
    process.kill(pid, 0)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'gone'
    if (code === 'EPERM') return 'live'
    return 'unknown'
  }
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
      const end = stat.lastIndexOf(')')
      const state = stat.slice(end + 2, end + 3)
      return state === 'Z' || state === 'X' ? 'terminal' : 'live'
    }
    if (process.platform === 'darwin') {
      const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
      if (state === '') return 'gone'
      return state.startsWith('Z') ? 'terminal' : 'live'
    }
    return 'unknown'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ESRCH' ? 'gone' : 'unknown'
  }
}

/** A recorded POSIX process group is terminal only when the kernel no longer owns it. */
function processGroupState(pgid: number): 'gone' | 'live' | 'unknown' {
  if (!Number.isInteger(pgid) || pgid <= 0) return 'unknown'
  try {
    process.kill(-pgid, 0)
    return 'live'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'gone'
    if (code === 'EPERM') return 'live'
    return 'unknown'
  }
}

async function disposeScene(scene: SplitProcessScene, primary: unknown, label: string): Promise<void> {
  try {
    await scene.dispose()
  } catch (cleanupError) {
    if (primary !== undefined) throw new AggregateError([primary, cleanupError], `${label} failed and its Scene cleanup also failed`)
    throw cleanupError
  }
}

async function exitChat(client: SplitProcessClient, label: string, expectedCode = 0): Promise<void> {
  if (client.closed) return
  await client.exitGracefully()
  const facts = await client.close()
  expect(facts.code, `${label} exit code`).toBe(expectedCode)
  expect(facts.signal, `${label} exit signal`).toBeNull()
}

async function closeHost(scene: SplitProcessScene, host: SplitProcessHostHandle): Promise<void> {
  if (host.exited) return
  await scene.stopHost(host)
}

test.skipIf(process.platform !== 'linux')(
  'loses the terminal owner without stopping the Host and reconnects a fresh Client',
  async () => {
    const scene = await createSplitProcessScene()
    let host: SplitProcessHostHandle | undefined
    let ownerClient: SplitProcessClient | undefined
    let fresh: SplitProcessClient | undefined
    let primary: unknown
    try {
      host = await scene.startHost()
      const hostBefore = await scene.hostStatus(host)
      const directories = clientDirectories(scene, 'terminal-owner-loss')
      ownerClient = await scene.startClient({ label: 'terminal-owner-loss', ...directories, terminal: 'terminal-owner-loss' })
      expect(ownerClient.ready.surfaceMounted).toBe(true)
      expect(ownerClient.ready.hostPid).toBe(hostBefore.localHost.hostPid)
      const businessPid = ownerClient.ready.businessPid
      expect(Number.isInteger(businessPid)).toBe(true)
      const terminal = await ownerClient.loseTerminalOwner()
      expect(terminal.kind).toBe('owner-loss')
      expect(terminal.ownerExit).toEqual({ code: null, signal: 'SIGKILL' })
      expect(['gone', 'terminal']).toContain(processState(businessPid))
      expect(terminal.hostPid).toBe(hostBefore.localHost.hostPid)
      const after = await scene.hostStatus(host)
      expect(after.localHost.hostPid).toBe(hostBefore.localHost.hostPid)
      expect(after.localHost.instanceId).toBe(hostBefore.localHost.instanceId)
      const freshDirs = clientDirectories(scene, 'terminal-owner-loss-reuse')
      fresh = await scene.startClient({ label: 'terminal-owner-loss-reuse', ...freshDirs })
      expect(fresh.ready.hostPid).toBe(hostBefore.localHost.hostPid)
      expect(fresh.ready.surfaceMounted).toBe(true)
      await expect(fresh.loseTerminalOwner()).rejects.toThrow(/declared the terminal-owner-loss|not declare/)
      await exitChat(fresh, 'terminal-owner-loss reuse Client')
      await closeHost(scene, host)
    } catch (error) {
      primary = error
      throw error
    } finally {
      try {
        await scene.dispose()
      } catch (cleanupError) {
        if (primary !== undefined) {
          throw new AggregateError([primary, cleanupError], 'the terminal-owner-loss test failed and its Scene cleanup also failed')
        }
        throw cleanupError
      }
    }
  },
)

test('replaces the settled Client surface without changing the Host and submits through the new surface', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'long-turn' })
    client = await scene.startClient({ label: 'hmr-settled', ...clientDirectories(scene, 'hmr-settled'), hmr: 'replace' })
    const sessionId = await settleInitialPrompt(scene, client, host, 't57 initial prompt', 'long-turn-held', 'T57')
    await waitFrame(client, 'long-turn answer 1', 'T57 initial answer')
    const before = await client.waitForSurfaceStatus(
      record => record.surfaceMounted === true && record.sessionOpen === true && record.openSessionId === sessionId,
      'T57 initial surface',
    )
    expect(before.surfaceRevision).toBeTypeOf('number')
    const hostBefore = await scene.hostStatus(host)
    const rowsBefore = await protectedHostRows(scene, host)
    await client.signal('SIGUSR2')
    const start = await client.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T57 HMR start')
    const retired = await client.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T57 HMR retired')
    const ready = await client.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready', 'T57 HMR ready')
    const after = await client.waitForSurfaceStatus(
      record => record.surfaceRevision === ready.revision && record.surfaceMounted === true,
      'T57 new surface',
    )
    expect(start.revision).not.toBe(before.surfaceRevision)
    expect(retired.revision).toBe(before.surfaceRevision)
    expect(ready.pid).toBe(before.pid)
    expect(after.pid).toBe(before.pid)
    expect(after.rootFiberUid).toBe(before.rootFiberUid)
    expect(after.generationId).toBe(before.generationId)
    expect(after.surfaceRevision).not.toBe(before.surfaceRevision)
    expect(after.surfaceFiberUid).not.toBe(before.surfaceFiberUid)
    expect(after.sessionOpen).toBe(true)
    expect(after.openSessionId).toBe(sessionId)
    expect(after.owners).toMatchObject({ typert: 1, connection: 1, remote: 1, fileUpload: 1, sessions: 1, jobs: 1 })
    expect(after.privateNamespaces).toBe(3)
    const rowsAfter = await protectedHostRows(scene, host)
    expectHostRowsKept(rowsBefore, rowsAfter, 'T57')
    for (const operation of ['hmr-revision-start', 'hmr-revision-retired', 'hmr-revision-ready']) {
      expect(client.readRecords().filter(record => record.m4b2s === 'qualification' && record.op === operation)).toHaveLength(1)
    }
    await waitFrame(client, 'long-turn answer', 'T57 new surface paint')
    const beforeSecondTurn = scene.sessionEvents(sessionId)?.length ?? 0
    await client.submit('t57 post-hmr prompt')
    await scene.waitForSessionEvent(sessionId, beforeSecondTurn,
      event => event.type === 'turn/start' && event.data?.turn === 2, 'T57 post-HMR turn/start')
    await scene.waitForSessionEvent(sessionId, beforeSecondTurn,
      event => event.type === 'turn/end' && event.data?.turn === 2, 'T57 post-HMR turn/end')
    await waitFrame(client, 'long-turn answer 2', 'T57 post-HMR answer')
    await waitFrame(client, 't57 post-hmr prompt', 'T57 post-HMR prompt readback')
    const hostAfter = await scene.hostStatus(host)
    expect(hostAfter.localHost.hostPid).toBe(hostBefore.localHost.hostPid)
    expect(hostAfter.localHost.instanceId).toBe(hostBefore.localHost.instanceId)
    expectHostRowsKept(rowsBefore, await protectedHostRows(scene, host), 'T57 post-HMR Host')
    await exitChat(client, 'T57 Client')
    await closeHost(scene, host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'T57')
  }
})

test('keeps a real Host Job running across HMR and observes its settlement after HMR', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'job' })
    const directories = clientDirectories(scene, 'hmr-job')
    directories.cwd = scene.installation.profileDir
    client = await scene.startClient({ label: 'hmr-job', ...directories, hmr: 'replace' })
    const sessionId = await settleInitialPrompt(scene, client, host, 't58 prompt', 'job-event', 'T58')
    const job = await fixtureHelpers.waitForC1WorkEvent(host.jobWorkRoot!, event => event.kind === 'job-event' && event.event === 'registered',
      'T58 running Job')
    expect(job.status).toBe('running')
    const before = await client.waitForSurfaceStatus(record => record.sessionOpen === true && record.openSessionId === sessionId,
      'T58 initial surface')
    const hostBefore = await scene.hostStatus(host)
    const rowsBefore = await protectedHostRows(scene, host)
    const jobOwner = job.owner
    await client.signal('SIGUSR2')
    await client.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T58 HMR start')
    await client.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T58 HMR retired')
    const ready = await client.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready', 'T58 HMR ready')
    const after = await client.waitForSurfaceStatus(record => record.surfaceRevision === ready.revision && record.sessionOpen === true
      && record.openSessionId === sessionId, 'T58 new surface Session')
    expect(after.pid).toBe(before.pid)
    expect(after.generationId).toBe(before.generationId)
    expect(after.openSessionId).toBe(sessionId)
    expect(after.owners).toMatchObject({ sessions: 1, jobs: 1 })
    expect(after.privateNamespaces).toBe(3)
    const hostAfter = await scene.hostStatus(host)
    expect(hostAfter.localHost.hostPid).toBe(hostBefore.localHost.hostPid)
    expect(hostAfter.localHost.instanceId).toBe(hostBefore.localHost.instanceId)
    expectHostRowsKept(rowsBefore, await protectedHostRows(scene, host), 'T58 Host')
    expect(fixtureHelpers.readC1WorkEvents(host.jobWorkRoot!)).not.toContainEqual(
      expect.objectContaining({ kind: 'job-event', jobId: job.jobId, event: 'settled' }),
    )
    releaseFile(join(host.jobWorkRoot!, 'job.release'), 'T58 job release')
    const settled = await fixtureHelpers.waitForC1WorkEvent(host.jobWorkRoot!,
      event => event.kind === 'job-event' && event.jobId === job.jobId && event.event === 'settled',
      'T58 settled Job', 120_000)
    expect(settled.status).toBe('completed')
    expect(settled.owner).toBe(jobOwner)
    await exitChat(client, 'T58 Client')
    await closeHost(scene, host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'T58')
  }
})

test('fails HMR closed and stops during HMR without publishing a forged Ready', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let failure: SplitProcessClient | undefined
  let hold: SplitProcessClient | undefined
  let reuse: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'job' })
    failure = await scene.startClient({
      label: 'hmr-failure',
      ...clientDirectories(scene, 'hmr-failure'),
      hmr: 'mount-failure',
      terminal: 'hmr-failure',
    })
    await failure.signal('SIGUSR2')
    await failure.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T59 failure start')
    await failure.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T59 failure retired')
    await failure.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-failure', 'T59 failure')
    const failureExit = await failure.waitForExit(120_000)
    expect(failureExit).toMatchObject({ code: 1, signal: null })
    const failureFacts = await failure.close()
    expect(failureFacts.code).toBe(1)
    for (const operation of ['hmr-revision-start', 'hmr-revision-retired', 'hmr-revision-failure']) {
      expect(failure.readRecords().filter(record => record.m4b2s === 'qualification' && record.op === operation)).toHaveLength(1)
    }
    expect((await scene.hostStatus(host)).localHost.hostPid).toBe(host.ready.localHost.hostPid)
    reuse = await scene.startClient({ label: 'hmr-failure-reuse', ...clientDirectories(scene, 'hmr-failure-reuse') })
    await exitChat(reuse, 'T59 reuse Client')
    await closeHost(scene, host)

    host = await scene.startHost({ scenario: 'job' })
    hold = await scene.startClient({
      label: 'hmr-hold-stop',
      ...clientDirectories(scene, 'hmr-hold-stop'),
      hmr: 'hold',
    })
    expect(hold.holdBarrierPath).not.toBeNull()
    await hold.signal('SIGUSR2')
    await hold.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T59 hold start')
    await hold.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T59 hold retired')
    await hold.signal('SIGTERM')
    await hold.waitForRecord(record => record.m4a0 === 'signal' && record.signal === 'SIGTERM', 'T59 stop signal')
    hold.releaseHmrHold()
    const stopExit = await hold.waitForExit(120_000)
    expect(stopExit).toMatchObject({ code: 0, signal: null })
    await hold.close()
    for (const operation of ['hmr-revision-start', 'hmr-revision-retired']) {
      expect(hold.readRecords().filter(record => record.m4b2s === 'qualification' && record.op === operation)).toHaveLength(1)
    }
    expect(hold.readRecords().filter(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready')).toHaveLength(0)
    expect(hold.readRecords().some(record => record.m4a0 === 'cleanup-failure')).toBe(false)
    expect((await scene.hostStatus(host)).localHost.hostPid).toBe(host.ready.localHost.hostPid)
    await closeHost(scene, host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'T59')
  }
})

test('rejects an HMR mount failure left on the ordinary terminal contract and retains the failed Scene', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  try {
    host = await scene.startHost({ scenario: 'job' })
    client = await scene.startClient({
      label: 'hmr-mount-negative',
      ...clientDirectories(scene, 'hmr-mount-negative'),
      hmr: 'mount-failure',
    })
    await client.signal('SIGUSR2')
    await client.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-failure', 'negative HMR failure')
    const exit = await client.waitForExit(120_000)
    expect(exit).toMatchObject({ code: 1, signal: null })
    await expect(client.close()).rejects.toThrow(/declared normal path requires code 0|exited/)
    await expect(scene.dispose()).rejects.toThrow()
    const supervisorExit = await scene.waitSupervisorExit(120_000)
    expect(supervisorExit).toEqual({ code: 1, signal: null })
    const receipt = await scene.readSupervisorReceipt()
    expect(receipt.phase).toBe('NOT_QUIESCED')
    const failed = receipt.processClients?.find(value => value.label === 'hmr-mount-negative')
    expect(failed?.terminal).toBe('normal')
    expect(failed?.exited).toBe(true)
    expect(failed?.exitCode).toBe(1)
    expect(failed?.verifiedTerminal ?? null).toBeNull()
    expect(receipt.compensation?.attempted).toBe(true)
    expect(receipt.compensation?.completed).toBe(true)
    expect(receipt.cleanup?.hostsExited).toBe(true)
    expect(receipt.cleanup?.hostSeatFree).toBe(true)
    expect(receipt.cleanup?.qualificationSeatFree).toBe(true)
    expect(receipt.cleanup?.sceneRootRemoved).toBe(false)
    for (const hostRecord of receipt.hosts ?? []) {
      expect(Number.isInteger(hostRecord.pid) && hostRecord.pid > 0, 'retained Host has no real PID').toBe(true)
      expect(['gone', 'terminal']).toContain(processState(hostRecord.pid))
      if (Number.isInteger(hostRecord.pgid) && hostRecord.pgid > 0) {
        expect(processGroupState(hostRecord.pgid), `retained Host group ${String(hostRecord.pgid)} is live`).toBe('gone')
      }
    }
    expect(Number.isInteger(failed?.shellPid) && failed!.shellPid! > 0, 'retained Client has no real shell PID').toBe(true)
    expect(['gone', 'terminal']).toContain(processState(failed!.shellPid!))
    for (const business of failed?.businessIdentities ?? []) {
      expect(Number.isInteger(business.pid) && business.pid! > 0, 'retained Client has no real business PID').toBe(true)
      expect(['gone', 'terminal']).toContain(processState(business.pid!))
    }
    expect(existsSync(scene.workDir)).toBe(true)
    rmSync(scene.workDir, { recursive: true, force: true })
  } finally {
    if (client !== undefined && !client.closed) await client.close().catch(() => undefined)
    if (host !== undefined && !host.exited) await closeHost(scene, host).catch(() => undefined)
    await scene.dispose().catch(() => undefined)
  }
})

test('delivers a real SIGINT to the business PID with code 130 and keeps Host history', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let reader: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost()
    client = await scene.startClient({ label: 'sigint', ...clientDirectories(scene, 'sigint'), terminal: 'sigint' })
    const before = new Set(await scene.sessionIds())
    await client.submit('t62 prompt')
    const sessionId = await scene.waitForNewSessionId(before, 'T62 Session')
    await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/end', 'T62 settled Turn')
    const businessPid = client.ready.businessPid
    await client.signal('SIGINT')
    const admitted = await client.waitForRecord(record => record.m4a0 === 'signal' && record.signal === 'SIGINT', 'T62 SIGINT admission')
    expect(admitted.pid).toBe(businessPid)
    const exit = await client.waitForExit(120_000)
    expect(exit).toMatchObject({ code: 130, signal: null })
    await client.close()
    expect((await scene.hostStatus(host)).localHost.hostPid).toBe(host.ready.localHost.hostPid)
    reader = await scene.startClient({ label: 'sigint-reader', ...clientDirectories(scene, 'sigint-reader'), sessionId })
    await waitFrame(reader, 't62 prompt', 'T62 history readback')
    await exitChat(reader, 'T62 reader')
    await closeHost(scene, host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'T62')
  }
})

test('exits only on the second real Ctrl+C/Ctrl+D chord and preserves the Session', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let ctrlC: SplitProcessClient | undefined
  let ctrlD: SplitProcessClient | undefined
  let recovered: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost()
    ctrlC = await scene.startClient({ label: 'ctrl-c', ...clientDirectories(scene, 'ctrl-c') })
    const before = new Set(await scene.sessionIds())
    await ctrlC.submit('t63 prompt')
    const sessionId = await scene.waitForNewSessionId(before, 'T63 Session')
    await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/end', 'T63 settled Turn')
    await waitFrame(ctrlC, 't63 prompt', 'T63 settled surface')
    await ctrlC.press('Ctrl+C')
    await waitFrame(ctrlC, 'again to exit', 'T63 Ctrl+C armed')
    await waitFrameGone(ctrlC, 'again to exit', 'T63 Ctrl+C expired')
    expect((await ctrlC.state()).exited).toBe(false)
    await ctrlC.press('Ctrl+C')
    await waitFrame(ctrlC, 'again to exit', 'T63 Ctrl+C re-armed')
    await ctrlC.press('Ctrl+C')
    const cExit = await ctrlC.waitForExit(120_000)
    expect(cExit).toMatchObject({ code: 0, signal: null })
    await ctrlC.close()

    ctrlD = await scene.startClient({ label: 'ctrl-d', ...clientDirectories(scene, 'ctrl-d'), sessionId })
    await waitFrame(ctrlD, 't63 prompt', 'T63 Ctrl+D history')
    await ctrlD.press('Ctrl+D')
    await waitFrame(ctrlD, 'again to exit', 'T63 Ctrl+D armed')
    await waitFrameGone(ctrlD, 'again to exit', 'T63 Ctrl+D expired')
    expect((await ctrlD.state()).exited).toBe(false)
    await ctrlD.press('Ctrl+D')
    await waitFrame(ctrlD, 'again to exit', 'T63 Ctrl+D re-armed')
    await ctrlD.press('Ctrl+D')
    const dExit = await ctrlD.waitForExit(120_000)
    expect(dExit).toMatchObject({ code: 0, signal: null })
    await ctrlD.close()

    recovered = await scene.startClient({ label: 'ctrl-recovered', ...clientDirectories(scene, 'ctrl-recovered'), sessionId })
    await waitFrame(recovered, 't63 prompt', 'T63 history after both exits')
    expect((await scene.hostStatus(host)).localHost.hostPid).toBe(host.ready.localHost.hostPid)
    await exitChat(recovered, 'T63 recovery')
    await closeHost(scene, host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'T63')
  }
})

test('treats a Host SIGHUP as carrier loss and discovers a new Host for the next Client', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let fresh: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'long-turn', crashSignal: 'SIGHUP' })
    const initialScratch = scopeScratch(scene)
    client = await scene.startClient({ label: 'host-hup', ...clientDirectories(scene, 'host-hup') })
    const before = new Set(await scene.sessionIds())
    await client.submit('t64 prompt')
    const sessionId = await scene.waitForNewSessionId(before, 'T64 Session')
    await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!, event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
      'T64 held Turn')
    await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/start', 'T64 turn/start')
    const hostBefore = await scene.hostStatus(host)
    await scene.signalEntry(host, 'SIGHUP')
    const terminal = await scene.finishEntry(host)
    expect(terminal.exit).toEqual({ code: null, signal: 'SIGHUP' })
    const lost = await client.waitForSurfaceStatus(record => record.transport !== 'connected', 'T64 carrier loss')
    expect(['disconnected', 'connecting']).toContain(lost.transport)
    const events = scene.sessionEvents(sessionId) ?? []
    expect(events.some(event => event.type === 'turn/end')).toBe(false)
    expect(sessionHelpers.hostAssistantHasText(events, 'long-turn answer')).toBe(false)
    expect((await frame(client)).includes('long-turn answer')).toBe(false)
    expect((await client.state()).exited).toBe(false)
    await client.signal('SIGTERM')
    await client.waitForExit(120_000)
    await client.close()
    fresh = await scene.startClient({ label: 'host-hup-fresh', ...clientDirectories(scene, 'host-hup-fresh'), recoverFromHostId: host.hostId })
    expect(fresh.ready.hostPid).not.toBe(hostBefore.localHost.hostPid)
    expect(fresh.ready.instanceId).not.toBe(hostBefore.localHost.instanceId)
    expect(fresh.ready.sessionOpen).toBe(false)
    await expect(scene.startHost()).rejects.toThrow(/discovered Host PID .* has not been normally reclaimed/)
    const recoveredHostPid = fresh.ready.hostPid
    const recoveredInstanceId = fresh.ready.instanceId
    await exitChat(fresh, 'T64 fresh Client')
    const stop = await scene.reclaimDiscoveredHost(fresh)
    expect(stop.pid).toBe(recoveredHostPid)
    expect(stop.reclaimed).toBe(true)
    expect(stop.normalStop).toBe(true)
    expect(stop.registryRemoved).toBe(true)
    expect(stop.scratchEntries).toEqual(initialScratch)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 'the Host SIGHUP test failed and its Scene cleanup also failed')
      throw cleanupError
    }
  }
})
