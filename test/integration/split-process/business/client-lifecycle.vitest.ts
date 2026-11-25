import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function clientDirectories(scene: SplitProcessScene, label: string): { home: string; cwd: string } {
  const root = join(scene.workDir, 'clients', label)
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  return { home, cwd }
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

async function exitChat(client: SplitProcessClient, label: string, expectedCode = 0): Promise<void> {
  if (client.closed) return
  await client.press('Ctrl+U').catch(() => undefined)
  await client.submit('/exit').catch(() => undefined)
  const started = Date.now()
  for (;;) {
    const state = await client.state().catch(() => undefined)
    if (state !== undefined && state.exited === true) break
    const text = await frame(client).catch(() => '')
    if (text.includes('Disconnect from dsh-pi-tui') && text.includes('Keep working and disconnect')) {
      await client.press('Enter').catch(() => undefined)
    }
    if (Date.now() - started >= 120_000) throw new Error(`${label}: Client did not exit through /exit`)
    await sleep(50)
  }
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
    try {
      host = await scene.startHost()
      const hostBefore = await scene.hostStatus(host)
      const directories = clientDirectories(scene, 'terminal-owner-loss')
      ownerClient = await scene.startClient({ label: 'terminal-owner-loss', ...directories, terminal: 'terminal-owner-loss' })
      expect(ownerClient.ready.surfaceMounted).toBe(true)
      expect(ownerClient.ready.hostPid).toBe(hostBefore.localHost.hostPid)
      const terminal = await ownerClient.loseTerminalOwner()
      expect(terminal.kind).toBe('owner-loss')
      expect(terminal.ownerExit).toEqual({ code: null, signal: 'SIGKILL' })
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
    } finally {
      if (ownerClient !== undefined && !ownerClient.closed) {
        await ownerClient.loseTerminalOwner().catch(() => undefined)
      }
      if (fresh !== undefined && !fresh.closed) await exitChat(fresh, 'terminal-owner-loss cleanup').catch(() => undefined)
      if (host !== undefined) await closeHost(scene, host).catch(() => undefined)
      await scene.dispose()
    }
  },
)

test('replaces the settled Client surface without changing the Host and submits through the new surface', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  try {
    host = await scene.startHost({ scenario: 'long-turn' })
    client = await scene.startClient({ label: 'hmr-settled', ...clientDirectories(scene, 'hmr-settled'), hmr: 'replace' })
    const sessionId = await settleInitialPrompt(scene, client, host, 't57 initial prompt', 'long-turn-held', 'T57')
    const before = await client.waitForSurfaceStatus(
      record => record.surfaceMounted === true && record.sessionOpen === true && record.openSessionId === sessionId,
      'T57 initial surface',
    )
    expect(before.surfaceRevision).toBeTypeOf('number')
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
    for (const operation of ['hmr-revision-start', 'hmr-revision-retired', 'hmr-revision-ready']) {
      expect(client.readRecords().filter(record => record.m4b2s === 'qualification' && record.op === operation)).toHaveLength(1)
    }
    await waitFrame(client, 'long-turn answer', 'T57 new surface paint')
    const beforeSecondTurn = scene.sessionEvents(sessionId)?.length ?? 0
    await client.submit('t57 post-hmr prompt')
    await scene.waitForSessionEvent(sessionId, beforeSecondTurn, event => event.type === 'turn/end', 'T57 post-HMR settle')
    await waitFrame(client, 'long-turn answer', 'T57 post-HMR paint')
    const hostAfter = await scene.hostStatus(host)
    expect(hostAfter.localHost.hostPid).toBe(host.ready.localHost.hostPid)
    expect(hostAfter.localHost.instanceId).toBe(host.ready.localHost.instanceId)
    await exitChat(client, 'T57 Client')
    await closeHost(scene, host)
  } finally {
    if (client !== undefined && !client.closed) await exitChat(client, 'T57 cleanup').catch(() => undefined)
    if (host !== undefined) await closeHost(scene, host).catch(() => undefined)
    await scene.dispose()
  }
})

test('keeps a real Host Job running across HMR and reads its settlement from the new surface', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
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
    await client.signal('SIGUSR2')
    await client.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T58 HMR start')
    await client.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T58 HMR retired')
    const ready = await client.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready', 'T58 HMR ready')
    const after = await client.waitForSurfaceStatus(record => record.surfaceRevision === ready.revision && record.sessionOpen === true
      && record.openSessionId === sessionId, 'T58 new surface Session')
    expect(after.pid).toBe(before.pid)
    expect(after.generationId).toBe(before.generationId)
    expect(fixtureHelpers.readC1WorkEvents(host.jobWorkRoot!)).not.toContainEqual(
      expect.objectContaining({ kind: 'job-event', jobId: job.jobId, event: 'settled' }),
    )
    releaseFile(join(host.jobWorkRoot!, 'job.release'), 'T58 job release')
    const settled = await fixtureHelpers.waitForC1WorkEvent(host.jobWorkRoot!,
      event => event.kind === 'job-event' && event.jobId === job.jobId && event.event === 'settled',
      'T58 settled Job', 120_000)
    expect(settled.status).toBe('completed')
    await waitFrame(client, 'job accepted', 'T58 new surface readback')
    await exitChat(client, 'T58 Client')
    await closeHost(scene, host)
  } finally {
    if (client !== undefined && !client.closed) await exitChat(client, 'T58 cleanup').catch(() => undefined)
    if (host !== undefined) await closeHost(scene, host).catch(() => undefined)
    await scene.dispose()
  }
})

test('fails HMR closed and stops during HMR without publishing a forged Ready', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let failure: SplitProcessClient | undefined
  let hold: SplitProcessClient | undefined
  let reuse: SplitProcessClient | undefined
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
    expect(hold.readRecords().filter(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready')).toHaveLength(0)
    expect(hold.readRecords().some(record => record.m4a0 === 'cleanup-failure')).toBe(false)
    expect((await scene.hostStatus(host)).localHost.hostPid).toBe(host.ready.localHost.hostPid)
    await closeHost(scene, host)
  } finally {
    if (failure !== undefined && !failure.closed) await failure.close().catch(() => undefined)
    if (hold !== undefined && !hold.closed) await hold.close().catch(() => undefined)
    if (reuse !== undefined && !reuse.closed) await exitChat(reuse, 'T59 cleanup').catch(() => undefined)
    if (host !== undefined) await closeHost(scene, host).catch(() => undefined)
    await scene.dispose()
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
    expect(supervisorExit.code).not.toBe(0)
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
  } finally {
    if (client !== undefined && !client.closed) await client.close().catch(() => undefined)
    if (reader !== undefined && !reader.closed) await exitChat(reader, 'T62 cleanup').catch(() => undefined)
    if (host !== undefined) await closeHost(scene, host).catch(() => undefined)
    await scene.dispose()
  }
})

test('exits only on the second real Ctrl+C/Ctrl+D chord and preserves the Session', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let ctrlC: SplitProcessClient | undefined
  let ctrlD: SplitProcessClient | undefined
  let recovered: SplitProcessClient | undefined
  try {
    host = await scene.startHost()
    ctrlC = await scene.startClient({ label: 'ctrl-c', ...clientDirectories(scene, 'ctrl-c') })
    const before = new Set(await scene.sessionIds())
    await ctrlC.submit('t63 prompt')
    const sessionId = await scene.waitForNewSessionId(before, 'T63 Session')
    await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/end', 'T63 settled Turn')
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
  } finally {
    if (ctrlC !== undefined && !ctrlC.closed) await ctrlC.close().catch(() => undefined)
    if (ctrlD !== undefined && !ctrlD.closed) await ctrlD.close().catch(() => undefined)
    if (recovered !== undefined && !recovered.closed) await exitChat(recovered, 'T63 cleanup').catch(() => undefined)
    if (host !== undefined) await closeHost(scene, host).catch(() => undefined)
    await scene.dispose()
  }
})

test('treats a Host SIGHUP as carrier loss and discovers a new Host for the next Client', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let fresh: SplitProcessClient | undefined
  try {
    host = await scene.startHost({ scenario: 'long-turn', crashSignal: 'SIGHUP' })
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
    const recoveredHostPid = fresh.ready.hostPid
    const recoveredInstanceId = fresh.ready.instanceId
    await exitChat(fresh, 'T64 fresh Client')
    const stop = await scene.reclaimDiscoveredHost(fresh)
    expect(stop.pid).toBe(recoveredHostPid)
    expect(stop.reclaimed).toBe(true)
    expect(stop.normalStop).toBe(true)
    expect(stop.registryRemoved).toBe(true)
  } finally {
    if (client !== undefined && !client.closed) await client.close().catch(() => undefined)
    if (fresh !== undefined && !fresh.closed) await exitChat(fresh, 'T64 cleanup').catch(() => undefined)
    if (host !== undefined && !host.exited) await closeHost(scene, host).catch(() => undefined)
    await scene.dispose().catch(() => undefined)
  }
})
