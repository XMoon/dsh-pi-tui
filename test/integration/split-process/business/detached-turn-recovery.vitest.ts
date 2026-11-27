import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type QualificationClientHandle,
  type SplitProcessClient,
  type SplitProcessHostHandle,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'
import { readOfficialClientRecords } from '../../../support/split-process-client.ts'

type WorkEvent = Record<string, any>
type SessionEvent = Record<string, any>

const fixtureHelpers = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-fixtures.mjs')).href
) as {
  readC1WorkEvents(root: string): WorkEvent[]
  waitForC1WorkEvent(root: string, predicate: (event: WorkEvent) => boolean, label: string, timeoutMs?: number): Promise<WorkEvent>
}

const sessionHelpers = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-sessions.mjs')).href
) as {
  hostAssistantHasText(events: SessionEvent[], text: string): boolean
  hostUserTexts(events: SessionEvent[]): string[]
}

function clientDirectories(scene: SplitProcessScene, label: string): { home: string; cwd: string } {
  const root = join(scene.workDir, 'clients', label)
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  return { home, cwd }
}

function releaseFile(path: string | null | undefined, label: string): void {
  if (typeof path !== 'string' || path === '') throw new Error(`${label}: no Supervisor-owned release path`)
  writeFileSync(path, 'release\n', { mode: 0o600, flag: 'wx' })
}

function expectMarker(path: string, expected: string): void {
  expect(readFileSync(path, 'utf8')).toBe(expected)
}

async function waitFrame(client: SplitProcessClient, text: string, label: string, timeoutMs = 120_000): Promise<string> {
  const started = Date.now()
  for (;;) {
    const current = await client.text()
    if (current.includes(text)) return current
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: frame never showed ${JSON.stringify(text)}; frame=${JSON.stringify(current.slice(-2000))}`)
    }
    await sleep(50)
  }
}

async function waitFrameGone(client: SplitProcessClient, text: string, label: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (!(await client.text()).includes(text)) return
    if (Date.now() - started >= timeoutMs) throw new Error(`${label}: ${JSON.stringify(text)} stayed on the frame`)
    await sleep(50)
  }
}

function composerDraft(frame: string): string | undefined {
  const lines = frame.split('\n')
  const marker = lines.findLastIndex(line => line.includes('❯'))
  if (marker < 0) return undefined
  const at = lines[marker]!.indexOf('❯')
  return lines[marker]!.slice(at + '❯'.length).trim()
}

async function waitForComposerDraft(
  client: SplitProcessClient,
  expected: string,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    const draft = composerDraft(await client.text())
    if (draft === expected) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: composer draft was ${JSON.stringify(draft)}, expected ${JSON.stringify(expected)}`)
    }
    await sleep(25)
  }
}

async function waitRecordAfter(
  client: SplitProcessClient,
  afterIndex: number,
  predicate: (record: Record<string, any>) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<Record<string, any>> {
  const started = Date.now()
  for (;;) {
    const record = readOfficialClientRecords(client.recordFile, client.label, { allowIncompleteTail: true })
      .slice(afterIndex).find(predicate)
    if (record !== undefined) return record
    const state = await client.state()
    if (state.exited) throw new Error(`${label}: the Client exited before the required record`)
    if (Date.now() - started >= timeoutMs) {
      const late = readOfficialClientRecords(client.recordFile, client.label).slice(afterIndex).find(predicate)
      if (late !== undefined) return late
      throw new Error(`${label}: no after-boundary record within ${String(timeoutMs)}ms`)
    }
    await sleep(25)
  }
}

async function openSession(
  scene: SplitProcessScene,
  client: SplitProcessClient,
  prompt: string,
  label: string,
): Promise<string> {
  const before = new Set(await scene.sessionIds())
  await client.submit(prompt)
  const sessionId = await scene.waitForNewSessionId(before, `${label} Session`)
  await scene.waitForHostSessionHeader(sessionId, `${label} Session header`)
  await client.waitForSurfaceStatus(
    record => record.sessionOpen === true && record.openSessionId === sessionId,
    `${label} exact Session surface`,
  )
  return sessionId
}

async function waitLiveClient(
  workRoot: string,
  value: boolean,
  afterSequence: number,
  label: string,
): Promise<number> {
  const event = await fixtureHelpers.waitForC1WorkEvent(
    workRoot,
    candidate => candidate.kind === 'has-live-client' && candidate.value === value && candidate.sequence > afterSequence,
    label,
  )
  return event.sequence as number
}

async function hostIdentity(scene: SplitProcessScene, host: SplitProcessHostHandle): Promise<Record<string, any>> {
  return (await scene.hostStatus(host)).localHost as Record<string, any>
}

async function expectHostIdentityKept(
  scene: SplitProcessScene,
  host: SplitProcessHostHandle,
  before: Record<string, any>,
  label: string,
): Promise<void> {
  const after = await hostIdentity(scene, host)
  expect(after.hostPid, `${label}: Host PID`).toBe(before.hostPid)
  expect(after.instanceId, `${label}: Host instance`).toBe(before.instanceId)
  expect(after.hostStarttime, `${label}: Linux Host birth`).toBe(before.hostStarttime)
  expect(after.hostKernelIdentity, `${label}: native Host birth`).toEqual(before.hostKernelIdentity)
}

function expectNativeBusinessKill(exit: { code: number | null; signal: string | null }, label: string): void {
  expect(
    exit.code === null && exit.signal === 'SIGKILL' || exit.code === 137 && exit.signal === null,
    `${label}: unexpected native business-kill terminal ${JSON.stringify(exit)}`,
  ).toBe(true)
}

async function killBusinessClient(scene: SplitProcessScene, client: SplitProcessClient, label: string): Promise<void> {
  const before = await client.state()
  expect(before.exited, `${label}: Client exited before the declared kill`).toBe(false)
  expect(before.businessStates.length, `${label}: no captured business identity`).toBeGreaterThan(0)
  const sent = await client.killBusiness()
  expect(sent.signal).toBe('SIGKILL')
  expect(before.businessStates.map(value => value.pid)).toContain(sent.pid)
  expectNativeBusinessKill(await client.waitForExit(), `${label} waitForExit`)
  const closed = await client.close()
  expectNativeBusinessKill(closed, `${label} close`)
  const receipt = await scene.readSupervisorReceipt()
  const row = (receipt.processClients ?? []).find(value => value.clientId === client.clientId) as Record<string, any> | undefined
  expect(row, `${label}: Supervisor Client receipt`).toBeDefined()
  expect(row?.businessKillSent, `${label}: successful business-kill dispatch`).toBe(true)
  expect(row?.exited, `${label}: Supervisor terminal state`).toBe(true)
  expect(row?.verifiedTerminal?.kind, `${label}: verified native terminal kind`).toBe('native')
  expectNativeBusinessKill(
    { code: row?.verifiedTerminal?.code ?? null, signal: row?.verifiedTerminal?.signal ?? null },
    `${label} verified native terminal`,
  )
  expect(row?.businessIdentities).toContainEqual(expect.objectContaining({ pid: sent.pid, birth: sent.birth }))
}

async function exitClientNormally(client: SplitProcessClient, label: string): Promise<void> {
  await client.exitGracefully()
  const exit = await client.close()
  expect(exit.code, `${label}: exit code`).toBe(0)
  expect(exit.signal, `${label}: exit signal`).toBeNull()
}

async function stopPeer(scene: SplitProcessScene, peer: QualificationClientHandle): Promise<void> {
  await scene.signalEntry(peer, 'SIGTERM')
  const terminal = await scene.finishEntry(peer)
  expect(terminal.exit, 'peer terminal').toEqual({ code: 0, signal: null })
  expect(terminal.outcome, 'peer terminal outcome').toBe('signal')
}

async function startOldPeer(
  scene: SplitProcessScene,
  kind: 'question' | 'approval',
  label: string,
): Promise<QualificationClientHandle> {
  const [peer] = await scene.startQualificationClients({
    mode: kind === 'question' ? 'peer-stale-question' : 'peer-stale-approval',
  })
  const ready = await scene.waitEntryRecord(peer, { m4a0: 'ready', phase: 'peer-ready' }, 120_000)
  expect(ready.phase, `${label}: peer ready phase`).toBe('peer-ready')
  const interaction = await scene.waitEntryRecord(peer, { m4a0: 'peer-interaction' }, 120_000)
  expect(interaction.kind, `${label}: peer interaction kind`).toBe(kind)
  return peer
}

test('blocks Host quiescence for a real unowned Job and clears it after settlement', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'unowned-job', unownedJob: true })
    releaseFile(host.unownedJobArmPath, 'unowned Job arm')
    const created = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'unowned-job-created',
      'unowned Job creation',
    )
    const running = (await scene.hostStatus(host)).liveness
    expect(running.verdict).toBe('BLOCKED')
    expect(running.reasons).toContain('job-running')
    expect(running.sourceStates.jobs).toBe('ACTIVE')
    releaseFile(host.unownedJobReleasePath, 'unowned Job release')
    await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'unowned-job-released' && event.jobId === created.jobId,
      'unowned Job release witness',
    )
    await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'job-event' && event.event === 'settled' && event.jobId === created.jobId,
      'unowned Job settlement',
    )
    const settled = (await scene.hostStatus(host)).liveness
    expect(settled.reasons).not.toContain('job-running')
    expect(settled.reasons).not.toContain('job-stopping')
    expect(settled.sourceStates.jobs).toBe('IDLE')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 'unowned Job failed and Scene cleanup also failed')
      throw cleanupError
    }
  }
})

test('blocks Host quiescence for one armed Goal without starting an automatic round', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'goal-armed', goalArmed: true })
    const drivers = host.ready.entries.filter((entry: Record<string, any>) => entry.id === 'goal-round-driver')
    expect(drivers).toHaveLength(1)
    expect(drivers[0]).toMatchObject({ state: 'absent', name: '@deepseek-ai/dsh-goal-round-driver' })
    expect(host.ready.entries.some((entry: Record<string, any>) =>
      entry.id === 'goal' && entry.name === '@deepseek-ai/dsh-goal' && entry.state === 'active')).toBe(true)
    client = await scene.startClient({ label: 'goal-armed-c1', ...clientDirectories(scene, 'goal-armed-c1') })
    const sessionId = await openSession(scene, client, 'goal-armed prompt', 'goal-armed')
    const created = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'goal-created',
      'armed Goal creation',
    )
    expect(created).toMatchObject({ goalPhase: 'active', activation: 'armed' })
    const liveness = (await scene.hostStatus(host)).liveness
    expect(liveness.verdict).toBe('BLOCKED')
    expect(liveness.reasons).toContain('goal-armed')
    expect(liveness.sourceStates.goal).toBe('ACTIVE')
    expect(liveness.sourceStates.agent).not.toBe('ACTIVE')
    expect(liveness.reasons).not.toContain('agent-running')
    expect(liveness.reasons).not.toContain('agent-inbox')
    expect(liveness.sourceStates.other).toBe('UNKNOWN')
    expect(liveness.reasons).toContain('unqualified-host-source')
    const mutations = fixtureHelpers.readC1WorkEvents(host.workloadRoot!).filter(event => event.kind === 'goal-changed')
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({ goalId: created.goalId, operation: 'create' })
    await exitClientNormally(client, 'goal-armed-c1')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 'armed Goal failed and Scene cleanup also failed')
      throw cleanupError
    }
  }
})

test('reserves and blocks one real automatic Goal round at its round limit', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'goal-round' })
    const drivers = host.ready.entries.filter((entry: Record<string, any>) => entry.id === 'goal-round-driver')
    expect(drivers).toHaveLength(1)
    expect(drivers[0]).toMatchObject({ state: 'active', name: '@deepseek-ai/dsh-goal-round-driver' })
    client = await scene.startClient({ label: 'goal-round-c1', ...clientDirectories(scene, 'goal-round-c1') })
    const sessionId = await openSession(scene, client, 'goal-round prompt', 'goal-round')
    const created = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'goal-created',
      'Goal creation',
    )
    expect(created).toMatchObject({ goalPhase: 'active', activation: 'armed' })
    const round = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'goal-round-observed',
      'automatic Goal reservation',
    )
    expect(round.goalId).toBe(created.goalId)
    expect(round.revision).toBe(created.revision)
    expect(round.round).toBe(1)
    expect(round.agentStatus).toBe('idle')
    const admitted = await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'user/message' && event.data?.source?.kind === 'goal',
      'durable Goal round',
    )
    expect(admitted.data?.source).toMatchObject({
      goalId: created.goalId,
      revision: created.revision,
      round: round.round,
    })
    const blocked = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'goal-changed' && event.operation === 'block',
      'Goal round-limit block',
    )
    expect(blocked).toMatchObject({
      goalId: created.goalId,
      blockCode: 'round-limit',
      goalPhase: 'blocked',
      activation: 'disarmed',
    })
    await exitClientNormally(client, 'goal-round-c1')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 'Goal round failed and Scene cleanup also failed')
      throw cleanupError
    }
  }
})

test('reports maintenance as unknown while the real maintenance owner is running', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'maintenance', maintenance: true })
    client = await scene.startClient({ label: 'maintenance-c1', ...clientDirectories(scene, 'maintenance-c1') })
    await openSession(scene, client, 'maintenance prompt', 'maintenance')
    const running = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'maintenance' && event.phase === 'running',
      'running maintenance',
    )
    expect(running.agentStatus).toBe('idle')
    const liveness = (await scene.hostStatus(host)).liveness
    expect(liveness.verdict).toBe('UNKNOWN')
    expect(liveness.verdict).not.toBe('OBSERVED_QUIESCENT')
    expect(liveness.reasons).toContain('agent-maintenance-unproven')
    releaseFile(host.maintenanceReleasePath, 'maintenance release')
    await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'maintenance' && event.phase === 'settled',
      'maintenance settlement',
    )
    await exitClientNormally(client, 'maintenance-c1')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 'maintenance failed and Scene cleanup also failed')
      throw cleanupError
    }
  }
})

test('blocks Host quiescence for an active Schedule task and clears it after deletion', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'schedule' })
    const scheduleRows = host.ready.entries.filter((entry: Record<string, any>) => entry.id === 'pi-tui-schedule')
    expect(scheduleRows).toHaveLength(1)
    expect(scheduleRows[0].state).toBe('active')
    client = await scene.startClient({ label: 'schedule-c1', ...clientDirectories(scene, 'schedule-c1') })
    await openSession(scene, client, 'schedule prompt', 'schedule')
    const created = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'schedule-created' && event.status === 'active',
      'active Schedule task',
    )
    await exitClientNormally(client, 'schedule-c1')
    const active = (await scene.hostStatus(host)).liveness
    expect(active.verdict).toBe('BLOCKED')
    expect(active.reasons).toContain('schedule-active')
    expect(active.sourceStates.schedule).toBe('ACTIVE')
    releaseFile(host.scheduleDeletePath, 'Schedule deletion')
    const deleted = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'schedule-deleted' && event.scheduleId === created.scheduleId,
      'Schedule deletion witness',
    )
    expect(deleted.scheduleId).toBe(created.scheduleId)
    const idle = (await scene.hostStatus(host)).liveness
    expect(idle.reasons).not.toContain('schedule-active')
    expect(idle.sourceStates.schedule).toBe('IDLE')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 'Schedule failed and Scene cleanup also failed')
      throw cleanupError
    }
  }
})

test('detaches cleanly from a held Turn without cancelling or stopping the Host', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'long-turn' })
    client = await scene.startClient({ label: 't45-c1', ...clientDirectories(scene, 't45-c1') })
    const sessionId = await openSession(scene, client, 't45 prompt', 't45')
    const held = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
      't45 held Turn',
    )
    expect(held.agentStatus).toBe('running')
    await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/start', 't45 turn/start')
    const before = await hostIdentity(scene, host)
    const cut = scene.sessionEvents(sessionId)?.length ?? 0
    await exitClientNormally(client, 't45-c1')
    await expectHostIdentityKept(scene, host, before, 't45 after clean detach')
    expect((scene.sessionEvents(sessionId) ?? []).slice(cut).some(event => event.type === 'turn/end')).toBe(false)
    releaseFile(host.holdReleasePath, 't45 long-turn release')
    await scene.waitForSessionEvent(sessionId, cut, event => event.type === 'turn/end', 't45 turn/end')
    const events = scene.sessionEvents(sessionId) ?? []
    expect(sessionHelpers.hostUserTexts(events).filter(text => text === 't45 prompt')).toHaveLength(1)
    expect(sessionHelpers.hostAssistantHasText(events, 'long-turn answer')).toBe(true)

    const fresh = await scene.startClient({
      label: 't45-c2',
      ...clientDirectories(scene, 't45-c2'),
      sessionId,
    })
    await fresh.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionId,
      't45-c2 exact Session',
    )
    await waitFrame(fresh, 't45 prompt', 't45-c2 prompt readback')
    await waitFrame(fresh, 'long-turn answer', 't45-c2 answer readback')
    await exitClientNormally(fresh, 't45-c2')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 't45 failed and Scene cleanup also failed')
      throw cleanupError
    }
  }
})

test('keeps a held foreground Tool running after the Client business process dies', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'foreground-tool', holdTool: true })
    client = await scene.startClient({ label: 't46-c1', ...clientDirectories(scene, 't46-c1'), terminal: 'business-kill' })
    const sessionId = await openSession(scene, client, 't46 prompt', 't46')
    const started = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'tool-started' && String(event.token).includes(sessionId),
      't46 real Host tool start',
    )
    const call = await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'tool/call' && event.data?.name === 'c1_foreground_tool',
      't46 durable tool/call',
    )
    expect(String(call.data?.callId)).toBe(started.callId)
    const before = await hostIdentity(scene, host)
    const cut = scene.sessionEvents(sessionId)?.length ?? 0
    await killBusinessClient(scene, client, 't46-c1')
    await expectHostIdentityKept(scene, host, before, 't46 after business kill')
    expect((scene.sessionEvents(sessionId) ?? []).slice(cut).some(
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === started.callId,
    )).toBe(false)
    releaseFile(host.toolReleasePath, 't46 tool release')
    const result = await scene.waitForSessionEvent(
      sessionId,
      cut,
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === started.callId,
      't46 tool/result',
    )
    expect(result.data?.message?.isError).not.toBe(true)
    await scene.waitForSessionEvent(sessionId, cut, event => event.type === 'turn/end', 't46 turn/end')
    const settledEvents = scene.sessionEvents(sessionId) ?? []
    expect(settledEvents.filter(
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === started.callId,
    )).toHaveLength(1)
    expect(settledEvents.filter(
      event => event.type === 'tool/call' && event.data?.name === 'c1_foreground_tool',
    )).toHaveLength(1)

    const fresh = await scene.startClient({
      label: 't46-c2',
      ...clientDirectories(scene, 't46-c2'),
      sessionId,
    })
    await waitFrame(fresh, 'foreground answer', 't46-c2 readback')
    await exitClientNormally(fresh, 't46-c2')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 't46 failed and Scene cleanup also failed')
      throw cleanupError
    }
  }
})

test('keeps an owned background Job alive and observable without its Client', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'job' })
    client = await scene.startClient({ label: 't47-c1', ...clientDirectories(scene, 't47-c1'), terminal: 'business-kill' })
    const sessionId = await openSession(scene, client, 't47 prompt', 't47')
    const registered = await fixtureHelpers.waitForC1WorkEvent(
      host.jobWorkRoot!,
      event => event.kind === 'job-event' && event.event === 'registered',
      't47 running Job',
    )
    expect(registered.status).toBe('running')
    expect(registered.owner).toBe(sessionId)
    const before = await hostIdentity(scene, host)
    await killBusinessClient(scene, client, 't47-c1')
    await expectHostIdentityKept(scene, host, before, 't47 after business kill')
    expect(fixtureHelpers.readC1WorkEvents(host.jobWorkRoot!).filter(
      event => event.kind === 'job-event' && event.jobId === registered.jobId && event.event === 'settled',
    )).toHaveLength(0)
    const running = (await scene.hostStatus(host)).liveness
    expect(running.verdict).toBe('BLOCKED')
    expect(running.reasons).toContain('job-running')
    expect(running.sourceStates.jobs).toBe('ACTIVE')

    releaseFile(join(host.jobWorkRoot!, 'job.release'), 't47 Job release')
    const settled = await fixtureHelpers.waitForC1WorkEvent(
      host.jobWorkRoot!,
      event => event.kind === 'job-event' && event.jobId === registered.jobId && event.event === 'settled',
      't47 Job settlement',
    )
    expect(settled.status).toBe('completed')
    expect(settled.output).toContain('c1-job-done')
    const after = (await scene.hostStatus(host)).liveness
    expect(after.reasons).not.toContain('job-running')
    expect(after.reasons).not.toContain('job-stopping')

    const fresh = await scene.startClient({
      label: 't47-c2',
      ...clientDirectories(scene, 't47-c2'),
      sessionId,
    })
    await waitFrame(fresh, 'job accepted', 't47-c2 readback')
    await exitClientNormally(fresh, 't47-c2')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 't47 failed and Scene cleanup also failed')
      throw cleanupError
    }
  }
})

test('keeps a continuable Child alive after the Client business process dies', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'child', holdChild: true })
    client = await scene.startClient({ label: 't48-c1', ...clientDirectories(scene, 't48-c1'), terminal: 'business-kill' })
    const sessionId = await openSession(scene, client, 't48 prompt', 't48')
    const started = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'subagent-start',
      't48 subagent/start',
    )
    expect(started.childId).not.toBe(sessionId)
    await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'child-stream-held' && event.sessionId === started.childId,
      't48 held Child stream',
    )
    const before = await hostIdentity(scene, host)
    await killBusinessClient(scene, client, 't48-c1')
    await expectHostIdentityKept(scene, host, before, 't48 after business kill')
    releaseFile(host.childReleasePath, 't48 Child release')
    const ended = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'subagent-end' && event.childId === started.childId,
      't48 subagent/end',
    )
    expect(ended.runId).toBe(started.runId)
    await expect.poll(async () => (scene.sessionEvents(started.childId) ?? []).filter(
      event => event.type === 'assistant/message' && JSON.stringify(event).includes('child answer'),
    ).length, { timeout: 60_000 }).toBe(1)

    const fresh = await scene.startClient({
      label: 't48-c2',
      ...clientDirectories(scene, 't48-c2'),
      sessionId,
    })
    await waitFrame(fresh, 'child delegated', 't48 parent readback')
    await exitClientNormally(fresh, 't48-c2')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 't48 failed and Scene cleanup also failed')
      throw cleanupError
    }
  }
})

for (const mode of ['kill', 'clean'] as const) {
  test(`reoffers a pending Question after a Client ${mode === 'kill' ? 'business kill' : 'clean exit'}`, async () => {
    const scene = await createSplitProcessScene()
    let host: SplitProcessHostHandle | undefined
    let client: SplitProcessClient | undefined
    let fresh: SplitProcessClient | undefined
    let primary: unknown
    try {
      host = await scene.startHost({
        scenario: 'question',
        ...(mode === 'kill' ? { questionEligibility: true } : {}),
      })
      let liveSequence = 0
      if (mode === 'kill') {
        liveSequence = await waitLiveClient(host.workloadRoot!, false, liveSequence, `${mode} initial Gateway eligibility`)
        releaseFile(host.eligibilityBarrierPath, `${mode} non-answering Peer probe`)
        const negative = await fixtureHelpers.waitForC1WorkEvent(
          host.workloadRoot!,
          event => event.kind === 'non-answering-peer',
          `${mode} non-answering Peer negative`,
        )
        expect(negative.opened).toBe(false)
        expect(negative.code).toBe('gateway/interactions-forbidden')
        expect(negative.liveClient).toBe(false)
      }
      client = await scene.startClient({
        label: `${mode}-question-c1`,
        ...clientDirectories(scene, `${mode}-question-c1`),
        terminal: mode === 'kill' ? 'business-kill' : 'normal',
      })
      if (mode === 'kill') {
        liveSequence = await waitLiveClient(host.workloadRoot!, true, liveSequence, `${mode} attached Gateway eligibility`)
      }
      const sessionId = await openSession(scene, client, `${mode} question prompt`, mode)
      const call = await scene.waitForSessionEvent(
        sessionId,
        0,
        event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
        `${mode} question tool/call`,
      )
      const callId = String(call.data?.callId)
      await fixtureHelpers.waitForC1WorkEvent(
        host.workloadRoot!,
        event => event.kind === 'question-request' && event.sessionId === sessionId,
        `${mode} pending Question`,
      )
      await waitFrame(client, '[1] Proceed', `${mode}-c1 Question modal`)
      const before = await hostIdentity(scene, host)
      if (mode === 'kill') {
        await killBusinessClient(scene, client, `${mode}-question-c1`)
      } else {
        await client.signal('SIGTERM')
        const exit = await client.waitForExit()
        expect(exit).toMatchObject({ code: 0, signal: null })
        await client.close()
      }
      await expectHostIdentityKept(scene, host, before, `${mode} after detach`)
      if (mode === 'kill') {
        liveSequence = await waitLiveClient(host.workloadRoot!, false, liveSequence, `${mode} detached Gateway eligibility`)
      }
      const pending = (await scene.hostStatus(host)).liveness
      expect(pending.sourceStates.pending).toBe('UNKNOWN')
      expect(pending.reasons).toContain('pending-interaction-unobservable')
      expect(pending.verdict).not.toBe('OBSERVED_QUIESCENT')
      expect(fixtureHelpers.readC1WorkEvents(host.workloadRoot!).some(
        event => event.kind === 'question-failed' && event.sessionId === sessionId,
      )).toBe(false)

      fresh = await scene.startClient({
        label: `${mode}-question-c2`,
        ...clientDirectories(scene, `${mode}-question-c2`),
        sessionId,
      })
      if (mode === 'kill') {
        liveSequence = await waitLiveClient(host.workloadRoot!, true, liveSequence, `${mode} recovered Gateway eligibility`)
      }
      await waitFrame(fresh, '[1] Proceed', `${mode}-c2 redelivered Question modal`)
      await fresh.type('1')
      await waitFrame(fresh, 'Review your answer before submit', `${mode}-c2 Question review`, 30_000)
      await fresh.press('Enter')
      const settled = await fixtureHelpers.waitForC1WorkEvent(
        host.workloadRoot!,
        event => event.kind === 'question-settled' && event.sessionId === sessionId,
        `${mode} Question settlement`,
      )
      expect(settled.answers?.[0]?.selected?.[0]).toBe('Proceed')
      const result = await scene.waitForSessionEvent(
        sessionId,
        0,
        event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
        `${mode} Question result`,
      )
      expect(result.data?.message?.isError).not.toBe(true)
      await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/end', `${mode} Question turn/end`)
      const work = fixtureHelpers.readC1WorkEvents(host.workloadRoot!)
      expect(work.filter(event => event.kind === 'question-request' && event.sessionId === sessionId)).toHaveLength(1)
      expect(work.filter(event => event.kind === 'question-settled' && event.sessionId === sessionId)).toHaveLength(1)
      await exitClientNormally(fresh, `${mode}-question-c2`)
      if (mode === 'kill') {
        await waitLiveClient(host.workloadRoot!, false, liveSequence, `${mode} final Gateway eligibility`)
      }
      await scene.stopHost(host)
    } catch (error) {
      primary = error
      throw error
    } finally {
      try {
        await scene.dispose()
      } catch (cleanupError) {
        if (primary !== undefined) throw new AggregateError([primary, cleanupError], `${mode} Question failed and Scene cleanup also failed`)
        throw cleanupError
      }
    }
  })
}

test('queues one continued timed Question reply after a clean Client exit', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let fresh: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'question', timedQuestion: true })
    client = await scene.startClient({ label: 't52-c1', ...clientDirectories(scene, 't52-c1') })
    const sessionId = await openSession(scene, client, 't52 prompt', 't52')
    const call = await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
      't52 timed Question tool/call',
    )
    const callId = String(call.data?.callId)
    const request = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'question-request' && event.sessionId === sessionId,
      't52 timed Question request',
    )
    expect(request.timed).toBe(true)
    await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'question-failed' && event.sessionId === sessionId,
      't52 timed foreground end',
    )
    await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'question-projection' && event.callId === callId
        && Array.isArray(event.active) && event.active.some((item: Record<string, any>) => item?.callId === callId && item?.state === 'continued'),
      't52 continued projection',
    )
    await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
      't52 timed pending tool result',
    )
    await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'after-timed-held' && event.sessionId === sessionId,
      't52 held after timed Question',
    )
    const before = await hostIdentity(scene, host)
    await client.signal('SIGTERM')
    expect(await client.waitForExit()).toMatchObject({ code: 0, signal: null })
    await client.close()
    await expectHostIdentityKept(scene, host, before, 't52 after clean detach')

    fresh = await scene.startClient({ label: 't52-c2', ...clientDirectories(scene, 't52-c2'), sessionId })
    await waitFrame(fresh, 't52 prompt', 't52-c2 history')
    await fresh.press('Down')
    await waitFrame(fresh, 'Task Quick', 't52 Task Quick')
    await waitFrame(fresh, 'Continue the C1 test?', 't52 continued row')
    await fresh.press('Enter')
    await waitFrame(fresh, '[1] Proceed', 't52 continued Question modal')
    await fresh.type('1')
    await waitFrame(fresh, 'Review your answer before submit', 't52 continued review', 30_000)
    const boundary = fresh.readRecords().length
    await fresh.press('Enter')
    await waitRecordAfter(
      fresh,
      boundary,
      record => record.m4b2s === 'qualification' && record.op === 'question-answer-continued' && record.result === 'queued',
      't52 queued continued answer',
    )
    releaseFile(host.timedDuplicateBarrierPath, 't52 duplicate answer probe')
    const duplicate = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'answer-probe' && event.phase === 'duplicate',
      't52 duplicate answer probe',
    )
    expect(duplicate.code).toBe('REPLY_QUEUED')
    releaseFile(host.timedAfterBarrierPath, 't52 after-timed release')
    await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/end', 't52 queued reply turn/end')
    await expect.poll(async () => (scene.sessionEvents(sessionId) ?? []).filter(
      event => event.type === 'user/message' && event.data?.source?.kind === 'user-question-reply'
        && event.data?.source?.callId === callId,
    ).length, { timeout: 60_000 }).toBe(1)
    const replies = (scene.sessionEvents(sessionId) ?? []).filter(
      event => event.type === 'user/message' && event.data?.source?.kind === 'user-question-reply'
        && event.data?.source?.callId === callId,
    )
    expect(replies).toHaveLength(1)
    releaseFile(host.timedExpiredBarrierPath, 't52 expired answer probe')
    const expired = await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'answer-probe' && event.phase === 'expired',
      't52 expired answer probe',
    )
    expect(expired.value).toBe(false)
    await exitClientNormally(fresh, 't52-c2')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 't52 failed and Scene cleanup also failed')
      throw cleanupError
    }
  }
})

test('ignores a stale authenticated question peer result', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let fresh: SplitProcessClient | undefined
  let readback: SplitProcessClient | undefined
  let peer: QualificationClientHandle | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'question' })
    client = await scene.startClient({ label: 't51-c1', ...clientDirectories(scene, 't51-c1'), terminal: 'business-kill' })
    const sessionId = await openSession(scene, client, 't51 prompt', 't51')
    const call = await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
      't51 question tool/call',
    )
    const callId = String(call.data?.callId)
    await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'question-request' && event.sessionId === sessionId,
      't51 pending Question',
    )
    await waitFrame(client, '[1] Proceed', 't51-c1 Question modal')
    const before = await hostIdentity(scene, host)
    await killBusinessClient(scene, client, 't51-c1')
    await expectHostIdentityKept(scene, host, before, 't51 after business kill')
    peer = await startOldPeer(scene, 'question', 't51')

    fresh = await scene.startClient({ label: 't51-c2', ...clientDirectories(scene, 't51-c2'), sessionId })
    await waitFrame(fresh, '[1] Proceed', 't51-c2 Question modal')
    await fresh.type('1')
    await waitFrame(fresh, 'Review your answer before submit', 't51-c2 Question review', 30_000)
    await fresh.press('Enter')
    await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'question-settled' && event.sessionId === sessionId,
      't51 Question settlement',
    )
    await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/end', 't51 turn/end')
    await exitClientNormally(fresh, 't51-c2')

    const staleCut = scene.sessionEvents(sessionId)?.length ?? 0
    const stale = await scene.sendStalePeerResult(peer, 'question')
    expect(stale).toMatchObject({ kind: 'question', ok: true })
    expect(stale.eventId).not.toBe('')
    expect(stale.clientId).not.toBe('')
    await stopPeer(scene, peer)

    readback = await scene.startClient({ label: 't51-c3', ...clientDirectories(scene, 't51-c3'), sessionId })
    await waitFrame(readback, 'question answered', 't51-c3 settled transcript')
    const viewport = await readback.text()
    expect(viewport).not.toContain('○ Review')
    expect(viewport).not.toContain('✓ Review')
    const work = fixtureHelpers.readC1WorkEvents(host.workloadRoot!)
    expect(work.filter(event => event.kind === 'question-settled' && event.sessionId === sessionId)).toHaveLength(1)
    expect((scene.sessionEvents(sessionId) ?? []).filter(
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
    )).toHaveLength(1)
    expect((scene.sessionEvents(sessionId) ?? []).slice(staleCut).filter(
      event => event.type === 'tool/result',
    )).toHaveLength(0)
    await exitClientNormally(readback, 't51-c3')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 't51 failed and Scene cleanup also failed')
      throw cleanupError
    }
  }
})

for (const [scenario, decision, outcome] of [
  ['approval-allow', 'y', 'allowed-once'],
  ['approval-reject', 'n', 'rejected'],
] as const) {
  test(`reoffers a detached ${scenario === 'approval-allow' ? 'allow' : 'reject'} Approval exactly once`, async () => {
    const scene = await createSplitProcessScene()
    let host: SplitProcessHostHandle | undefined
    let client: SplitProcessClient | undefined
    let fresh: SplitProcessClient | undefined
    let primary: unknown
    try {
      host = await scene.startHost({ scenario })
      client = await scene.startClient({ label: `${scenario}-c1`, ...clientDirectories(scene, `${scenario}-c1`), terminal: 'business-kill' })
      const sessionId = await openSession(scene, client, `${scenario} prompt`, scenario)
      const asked = await scene.waitForSessionEvent(
        sessionId,
        0,
        event => event.type === 'approval/asked',
        `${scenario} approval/asked`,
      )
      const requestId = String(asked.data?.id)
      const request = await fixtureHelpers.waitForC1WorkEvent(
        host.workloadRoot!,
        event => event.kind === 'approval-request',
        `${scenario} Host Approval request`,
      )
      expect(request.toolName).toBe('bash')
      await waitFrame(client, '[y] Allow once', `${scenario}-c1 Approval sheet`)
      const before = await hostIdentity(scene, host)
      await killBusinessClient(scene, client, `${scenario}-c1`)
      await expectHostIdentityKept(scene, host, before, `${scenario} after business kill`)
      expect(fixtureHelpers.readC1WorkEvents(host.workloadRoot!).some(
        event => event.kind === 'approval-settled',
      )).toBe(false)

      fresh = await scene.startClient({
        label: `${scenario}-c2`,
        ...clientDirectories(scene, `${scenario}-c2`),
        sessionId,
      })
      await waitFrame(fresh, scenario === 'approval-allow' ? 'Allow once' : 'Reject', `${scenario}-c2 Approval sheet`)
      await fresh.type(decision)
      const decided = await scene.waitForSessionEvent(
        sessionId,
        0,
        event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
        `${scenario} approval/decided`,
      )
      expect(decided.data?.outcome).toBe(outcome)
      expect((scene.sessionEvents(sessionId) ?? []).filter(
        event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
      )).toHaveLength(1)
      const settled = await fixtureHelpers.waitForC1WorkEvent(
        host.workloadRoot!,
        event => event.kind === 'approval-settled' && event.outcome === outcome,
        `${scenario} Approval settlement`,
      )
      expect(settled.outcome).toBe(outcome)
      const marker = join(host.workloadRoot!, `${scenario}.marker`)
      const toolResult = await scene.waitForSessionEvent(
        sessionId,
        0,
        event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === String(request.callId),
        `${scenario} tool result`,
      )
      if (scenario === 'approval-allow') {
        expect(toolResult.data?.message?.isError).not.toBe(true)
        expect(existsSync(marker)).toBe(true)
        expectMarker(marker, 'c1-approval-allow')
      } else {
        expect(toolResult.data?.message?.isError).toBe(true)
        expect(existsSync(marker)).toBe(false)
      }
      await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/end', `${scenario} turn/end`)
      await exitClientNormally(fresh, `${scenario}-c2`)
      await scene.stopHost(host)
    } catch (error) {
      primary = error
      throw error
    } finally {
      try {
        await scene.dispose()
      } catch (cleanupError) {
        if (primary !== undefined) throw new AggregateError([primary, cleanupError], `${scenario} failed and Scene cleanup also failed`)
        throw cleanupError
      }
    }
  })
}

test('ignores a stale authenticated approval peer result', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let fresh: SplitProcessClient | undefined
  let peer: QualificationClientHandle | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'approval-allow' })
    client = await scene.startClient({ label: 't55a-c1', ...clientDirectories(scene, 't55a-c1'), terminal: 'business-kill' })
    const sessionId = await openSession(scene, client, 't55a prompt', 't55a')
    const asked = await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'approval/asked',
      't55a approval/asked',
    )
    const requestId = String(asked.data?.id)
    await waitFrame(client, '[y] Allow once', 't55a-c1 Approval sheet')
    const before = await hostIdentity(scene, host)
    await killBusinessClient(scene, client, 't55a-c1')
    await expectHostIdentityKept(scene, host, before, 't55a after business kill')
    peer = await startOldPeer(scene, 'approval', 't55a')

    fresh = await scene.startClient({ label: 't55a-c2', ...clientDirectories(scene, 't55a-c2'), sessionId })
    await waitFrame(fresh, 'Reject', 't55a-c2 Approval sheet')
    await fresh.type('n')
    const decided = await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
      't55a approval/decided',
    )
    expect(decided.data?.outcome).toBe('rejected')
    await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/end', 't55a rejected turn/end')
    const staleCut = scene.sessionEvents(sessionId)?.length ?? 0
    const stale = await scene.sendStalePeerResult(peer, 'approval')
    expect(stale).toMatchObject({ kind: 'approval', ok: true })
    expect(stale.eventId).not.toBe('')
    expect(stale.clientId).not.toBe('')
    const decisions = (scene.sessionEvents(sessionId) ?? []).filter(
      event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
    )
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.data?.outcome).toBe('rejected')
    expect((scene.sessionEvents(sessionId) ?? []).slice(staleCut).filter(
      event => event.type === 'approval/decided' || event.type === 'tool/result',
    )).toHaveLength(0)
    expect(existsSync(join(host.workloadRoot!, 'approval-allow.marker'))).toBe(false)
    await exitClientNormally(fresh, 't55a-c2')
    await stopPeer(scene, peer)
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 't55a failed and Scene cleanup also failed')
      throw cleanupError
    }
  }
})

test('settles a pending Approval as cancelled and ignores a late allow', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  let primary: unknown
  try {
    host = await scene.startHost({ scenario: 'approval-allow', cancelAgent: true })
    client = await scene.startClient({ label: 't55b-c1', ...clientDirectories(scene, 't55b-c1') })
    const sessionId = await openSession(scene, client, 't55b prompt', 't55b')
    const asked = await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'approval/asked',
      't55b approval/asked',
    )
    const requestId = String(asked.data?.id)
    await waitFrame(client, '[y] Allow once', 't55b Approval sheet')
    releaseFile(host.cancelAgentBarrierPath, 't55b Agent cancel')
    await fixtureHelpers.waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'agent-cancel-requested',
      't55b Agent cancel request',
    )
    const decided = await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
      't55b approval/decided',
    )
    expect(decided.data?.outcome).toBe('cancelled')
    await waitFrameGone(client, '[y] Allow once', 't55b Approval sheet withdrawal')
    // The official request is already terminal and its sheet is gone, so the
    // late allow must become ordinary editor text rather than a Host decision.
    await client.type('y')
    await waitForComposerDraft(client, 'y', 't55b late allow reached the composer')
    await client.press('Ctrl+U')
    await waitForComposerDraft(client, '', 't55b late allow cleared from the composer')
    expect(existsSync(join(host.workloadRoot!, 'approval-allow.marker'))).toBe(false)
    expect((scene.sessionEvents(sessionId) ?? []).filter(
      event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
    )).toHaveLength(1)
    await exitClientNormally(client, 't55b-c1')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 't55b failed and Scene cleanup also failed')
      throw cleanupError
    }
  }
})

test('answers the original pending interaction exactly once after HMR', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    for (const kind of ['question', 'approval'] as const) {
      const host = await scene.startHost({ scenario: kind === 'question' ? 'question' : 'approval-allow' })
      const client = await scene.startClient({
        label: `t55c-${kind}`,
        ...clientDirectories(scene, `t55c-${kind}`),
        hmr: 'replace',
      })
      const sessionId = await openSession(scene, client, `t55c ${kind} prompt`, `t55c-${kind}`)
      let requestId: string | undefined
      let approvalCallId: string | undefined
      if (kind === 'question') {
        const call = await scene.waitForSessionEvent(
          sessionId,
          0,
          event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
          't55c question tool/call',
        )
        requestId = String(call.data?.callId)
        await waitFrame(client, '[1] Proceed', 't55c initial Question modal')
      } else {
        const asked = await scene.waitForSessionEvent(
          sessionId,
          0,
          event => event.type === 'approval/asked',
          't55c approval/asked',
        )
        requestId = String(asked.data?.id)
        const request = await fixtureHelpers.waitForC1WorkEvent(
          host.workloadRoot!,
          event => event.kind === 'approval-request',
          't55c Host Approval request',
        )
        approvalCallId = String(request.callId)
        await waitFrame(client, '[y] Allow once', 't55c initial Approval')
      }
      const before = await client.waitForSurfaceStatus(
        record => record.surfaceMounted === true && record.sessionOpen === true && record.openSessionId === sessionId,
        't55c initial surface',
      )
      const hostBefore = await hostIdentity(scene, host)
      const boundary = client.readRecords().length
      await client.signal('SIGUSR2')
      const start = await waitRecordAfter(
        client,
        boundary,
        record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start',
        't55c HMR start',
      )
      const retired = await waitRecordAfter(
        client,
        boundary,
        record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired',
        't55c HMR retired',
      )
      const ready = await waitRecordAfter(
        client,
        boundary,
        record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready',
        't55c HMR ready',
      )
      expect(start.revision).not.toBe(before.surfaceRevision)
      expect(retired.revision).toBe(before.surfaceRevision)
      const after = await client.waitForSurfaceStatus(
        record => record.surfaceMounted === true && record.surfaceRevision === ready.revision,
        't55c replacement surface',
      )
      expect(after.pid).toBe(before.pid)
      expect(after.generationId).toBe(before.generationId)
      expect(after.openSessionId).toBe(sessionId)
      await expectHostIdentityKept(scene, host, hostBefore, `t55c ${kind} HMR`)
      expect(client.readRecords().filter(
        record => record.m4b2s === 'qualification' && record.op === 'interaction-startup-gate',
      )).toHaveLength(1)

      if (kind === 'question') {
        await waitFrame(client, '[1] Proceed', 't55c new Question modal')
        await client.type('1')
        await waitFrame(client, 'Review your answer before submit', 't55c new Question review', 30_000)
        await client.press('Enter')
        const settled = await fixtureHelpers.waitForC1WorkEvent(
          host.workloadRoot!,
          event => event.kind === 'question-settled' && event.sessionId === sessionId,
          't55c Question settlement',
        )
        expect(settled.answers?.[0]?.selected?.[0]).toBe('Proceed')
        const result = await scene.waitForSessionEvent(
          sessionId,
          0,
          event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === requestId,
          't55c Question result',
        )
        expect(result.data?.message?.isError).not.toBe(true)
        const work = fixtureHelpers.readC1WorkEvents(host.workloadRoot!).filter(event => event.sessionId === sessionId)
        expect(work.filter(event => event.kind === 'question-request')).toHaveLength(1)
        expect(work.filter(event => event.kind === 'question-settled')).toHaveLength(1)
        expect(work.some(event => event.kind === 'question-failed')).toBe(false)
      } else {
        await waitFrame(client, '[y] Allow once', 't55c new Approval surface')
        await client.type('y')
        const decided = await scene.waitForSessionEvent(
          sessionId,
          0,
          event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
          't55c approval/decided',
        )
        expect(decided.data?.outcome).toBe('allowed-once')
        const marker = join(host.workloadRoot!, 'approval-allow.marker')
        expect(existsSync(marker)).toBe(true)
        expectMarker(marker, 'c1-approval-allow')
        expect((scene.sessionEvents(sessionId) ?? []).filter(
          event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
        )).toHaveLength(1)
        const result = await scene.waitForSessionEvent(
          sessionId,
          0,
          event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === approvalCallId,
          't55c Approval tool result',
        )
        expect(result.data?.message?.isError).not.toBe(true)
        expect((scene.sessionEvents(sessionId) ?? []).filter(
          event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === approvalCallId,
        )).toHaveLength(1)
      }
      await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/end', `t55c ${kind} turn/end`)
      await client.type('\x15')
      await exitClientNormally(client, `t55c-${kind}`)
      await scene.stopHost(host)
    }
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 't55c failed and Scene cleanup also failed')
      throw cleanupError
    }
  }
})
