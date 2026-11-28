import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type SessionEvent,
  type SplitProcessClient,
  type SplitProcessHostHandle,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

type WorkEvent = Record<string, any>
type ProbeRecord = Record<string, any>

const fixtureHelpers = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-fixtures.mjs')).href
) as {
  readC1WorkEvents(root: string): WorkEvent[]
  waitForC1WorkEvent(
    root: string,
    predicate: (event: WorkEvent) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<WorkEvent>
}

function clientDirectories(scene: SplitProcessScene, label: string): { home: string; cwd: string } {
  const root = join(scene.workDir, 'clients', label)
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  return { home, cwd }
}

function messageText(message: Record<string, any> | undefined): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => typeof part?.text === 'string' ? part.text : '').join('')
}

function composerDraft(frame: string): string | undefined {
  const lines = frame.split('\n')
  const marker = lines.findLastIndex(line => line.trimStart().startsWith('❯')
    && !line.includes('[connection]'))
  if (marker < 0) return undefined
  const at = lines[marker]!.indexOf('❯')
  return lines[marker]!.slice(at + '❯'.length).trim()
}

async function waitForComposerDraft(
  client: SplitProcessClient,
  expected: string,
  label: string,
  timeoutMs = 120_000,
): Promise<void> {
  const started = Date.now()
  let last: string | undefined
  for (;;) {
    last = composerDraft(await client.text())
    if (expected === '') {
      // A defined marker is the positive current-editor-seat control: `undefined`
      // means an overlay/transition, while `……` is the painted empty placeholder.
      if (typeof last === 'string' && (last === '' || /^…{1,2}$/u.test(last))) {
        const seat = await client.waitForSurfaceStatus(record => record.transport === 'connected'
          && record.surfaceMounted === true, `${label}: current editor seat`,
        Math.max(1, timeoutMs - (Date.now() - started)))
        expect(seat.transport, `${label}: current seat transport`).toBe('connected')
        expect(seat.surfaceMounted, `${label}: current surface is not mounted`).toBe(true)
        last = composerDraft(await client.text())
        if (typeof last === 'string' && (last === '' || /^…{1,2}$/u.test(last))) return
        continue
      }
    } else if (last === expected) {
      return
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: the composer did not hold ${JSON.stringify(expected)} (observed ${JSON.stringify(last)})`)
    }
    await sleep(25)
  }
}

async function submitKnown(client: SplitProcessClient, text: string, label: string): Promise<void> {
  await waitForComposerDraft(client, '', `${label}: editor seat is ready`)
  await client.submit(text)
}

async function waitFrame(client: SplitProcessClient, text: string, label: string, timeoutMs = 120_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if ((await client.text()).includes(text)) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: ${JSON.stringify(text)} was not painted`)
    }
    await sleep(25)
  }
}

async function waitFrameGone(client: SplitProcessClient, text: string, label: string, timeoutMs = 120_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (!(await client.text()).includes(text)) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: ${JSON.stringify(text)} remained painted`)
    }
    await sleep(25)
  }
}

function workRoot(host: SplitProcessHostHandle, label: string): string {
  expect(host.workloadRoot, `${label}: the Host registered no workload root`).toBeTypeOf('string')
  return host.workloadRoot!
}

async function waitWork(
  host: SplitProcessHostHandle,
  predicate: (event: WorkEvent) => boolean,
  label: string,
): Promise<WorkEvent> {
  return await fixtureHelpers.waitForC1WorkEvent(workRoot(host, label), predicate, label)
}

function readWork(host: SplitProcessHostHandle, label: string): WorkEvent[] {
  return fixtureHelpers.readC1WorkEvents(workRoot(host, label))
}

function eventCount(scene: SplitProcessScene, sessionId: string): number {
  return scene.sessionEvents(sessionId)?.length ?? 0
}

function expectNoNewHostEvents(
  scene: SplitProcessScene,
  sessionId: string,
  boundary: number,
  label: string,
): void {
  const events = scene.sessionEvents(sessionId) ?? []
  expect(events.length, `${label}: the read wrote durable Host events ${JSON.stringify(events.slice(boundary).map(event => event.type))}`).toBe(boundary)
}

function factOf(record: ProbeRecord, sessionId: string, label: string): ProbeRecord {
  const fact = (record.facts ?? []).find((entry: ProbeRecord) => entry.sessionId === sessionId)
  expect(fact, `${label}: no read fact for the target Session`).toBeDefined()
  return fact
}

function rowOf(record: ProbeRecord, sessionId: string, label: string): ProbeRecord {
  const row = (record.rows ?? []).find((entry: ProbeRecord) => entry.id === sessionId)
  expect(row, `${label}: the listed roster has no row for the target Session`).toBeDefined()
  return row
}

function retentionCount(row: ProbeRecord, label: string): number {
  expect(row.retainedBy, `${label}: the official row has no retention authority`).toBeTypeOf('object')
  const value = (row.retainedBy as ProbeRecord).tuiMainView
  // `retainedBy` is a sparse count map: an absent key inside the authoritative
  // object means zero, while an absent object is unknown and must fail above.
  if (value !== undefined) expect(Number.isFinite(value), `${label}: tuiMainView is not finite`).toBe(true)
  return value ?? 0
}

function expectNotRetained(record: ProbeRecord, sessionId: string, label: string): void {
  expect(retentionCount(rowOf(record, sessionId, label), label),
    `${label}: the passive read retained another Session`).toBe(0)
}

async function waitProbe(
  client: SplitProcessClient,
  nonce: string,
  phase: string,
  label: string,
  predicate: (record: ProbeRecord) => boolean = () => true,
  timeoutMs = 120_000,
): Promise<ProbeRecord> {
  return await client.waitForRecord(record => record.m4b2s === 'qualification'
    && record.op === 'read-authority-proof'
    && record.nonce === nonce
    && record.phase === phase
    && predicate(record), label, timeoutMs)
}

async function waitProbePhases(
  client: SplitProcessClient,
  nonce: string,
  phases: readonly string[],
  label: string,
  timeoutMs = 120_000,
): Promise<ProbeRecord> {
  return await client.waitForRecord(record => record.m4b2s === 'qualification'
    && record.op === 'read-authority-proof'
    && record.nonce === nonce
    && phases.includes(String(record.phase)), label, timeoutMs)
}

async function probe(
  client: SplitProcessClient,
  request: Parameters<SplitProcessClient['readAuthority']>[0],
  phase: string,
  label: string,
  timeoutMs = 120_000,
): Promise<ProbeRecord> {
  const dispatched = await client.readAuthority(request)
  expect(dispatched.op, `${label}: the Supervisor dispatched another operation`).toBe(request.op)
  return await waitProbe(client, dispatched.nonce, phase, label, () => true, timeoutMs)
}

async function readFacts(client: SplitProcessClient, label: string): Promise<ProbeRecord> {
  return await probe(client, { op: 'read' }, 'facts', label)
}

async function readFactsUntil(
  client: SplitProcessClient,
  predicate: (record: ProbeRecord) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<ProbeRecord> {
  const started = Date.now()
  let last: ProbeRecord | undefined
  while (Date.now() - started < timeoutMs) {
    last = await readFacts(client, label)
    if (predicate(last)) return last
    // The continued projection settles after the durable timed tool result;
    // each iteration is a real port read, not a readiness sleep.
    await sleep(200)
  }
  throw new Error(`${label}: no official read satisfied the predicate; last=${JSON.stringify(last?.facts)}`)
}

async function releaseOnce(path: string | null | undefined, label: string): Promise<void> {
  expect(path, `${label}: the Host registered no release barrier`).toBeTypeOf('string')
  writeFileSync(path!, 'release\n', { mode: 0o600, flag: 'wx' })
}

async function exitNormally(client: SplitProcessClient, label: string): Promise<void> {
  // A settlement key (for example the loser's late `n`) can remain in the
  // composer as ordinary draft text; exitGracefully() appends `/exit` to it.
  // An idle editor paints `……`, which is not real draft text.
  const draft = composerDraft(await client.text())
  if (draft !== undefined && draft !== '' && !/^…{1,2}$/u.test(draft)) {
    await client.press('Ctrl+U')
  }
  await client.exitGracefully()
  const exit = await client.close()
  expect(exit.code, `${label}: Client exit code`).toBe(0)
  expect(exit.signal, `${label}: Client exit signal`).toBeNull()
  expect(client.closed, `${label}: Supervisor close settlement`).toBe(true)
}

async function exitByDeclaredSignal(client: SplitProcessClient, label: string): Promise<void> {
  await client.signal('SIGTERM')
  const exit = await client.waitForExit(60_000)
  expect(exit, `${label}: native SIGTERM exit`).toMatchObject({ code: 0, signal: null })
  await client.close()
}

async function disposeScene(scene: SplitProcessScene, primary: unknown, label: string): Promise<void> {
  try {
    await scene.dispose()
  } catch (cleanupError) {
    if (primary !== undefined) {
      throw new AggregateError([primary, cleanupError], `${label}: test failure and Scene cleanup failure`)
    }
    throw cleanupError
  }
}

async function openEmptySession(
  scene: SplitProcessScene,
  client: SplitProcessClient,
  label: string,
): Promise<string> {
  const before = new Set(await scene.sessionIds())
  await submitKnown(client, '/new', label)
  const sessionId = await scene.waitForNewSessionId(before, `${label}: Session materialization`)
  const opened = await client.waitForSurfaceStatus(record => record.sessionOpen === true
    && record.openSessionId === sessionId && record.transport === 'connected'
    && record.surfaceMounted === true, `${label}: navigation commit`)
  expect(opened.openSessionId, `${label}: a different Session was committed`).toBe(sessionId)
  return sessionId
}

async function triggerQuestion(
  scene: SplitProcessScene,
  host: SplitProcessHostHandle,
  client: SplitProcessClient,
  label: string,
): Promise<{ sessionId: string; callId: string }> {
  const before = new Set(await scene.sessionIds())
  await submitKnown(client, `${label}-question-trigger`, label)
  const sessionId = await scene.waitForNewSessionId(before, `${label}: Session creation`)
  const call = await scene.waitForSessionEvent(sessionId, 0,
    event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
    `${label}: question tool/call`)
  const callId = call.data?.callId
  expect(callId, `${label}: the tool/call carries no callId`).toBeTypeOf('string')
  expect(callId, `${label}: the callId is empty`).not.toBe('')
  await waitWork(host,
    event => event.kind === 'question-request' && event.sessionId === sessionId,
    `${label}: fixture question request`)
  return { sessionId, callId: callId as string }
}

test('reads another Session without retaining it or admitting its Question', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'question' })
    const clientA = await scene.startClient({
      label: 'read-question-a', ...clientDirectories(scene, 'read-question-a'), readAuthorityProof: true,
    })
    const sessionY = await openEmptySession(scene, clientA, 'A opens an empty Session')
    const clientB = await scene.startClient({ label: 'read-question-b', ...clientDirectories(scene, 'read-question-b') })
    const { sessionId: sessionX, callId } = await triggerQuestion(scene, host, clientB, 'read-authority-question')
    await waitFrame(clientB, '[1] Proceed', 'B paints the live Question')

    const writeBoundary = eventCount(scene, sessionX)
    const yWriteBoundary = eventCount(scene, sessionY)
    const sessionIdsBefore = await scene.sessionIds()
    await expect(scene.request('PROCESS_CLIENT_READ_AUTHORITY', {
      clientId: clientA.clientId, request: { op: 'write' },
    })).rejects.toThrow(/INPUT_UNQUALIFIED.*unknown op/u)
    for (const inheritedOp of ['constructor', '__proto__']) {
      await expect(scene.request('PROCESS_CLIENT_READ_AUTHORITY', {
        clientId: clientA.clientId, request: { op: inheritedOp },
      })).rejects.toThrow(/INPUT_UNQUALIFIED.*unknown op/u)
    }
    await expect(scene.request('PROCESS_CLIENT_READ_AUTHORITY', {
      clientId: clientA.clientId, request: { op: 'read', invalidField: 1 },
    })).rejects.toThrow(/INPUT_UNQUALIFIED/u)
    await expect(scene.request('PROCESS_CLIENT_READ_AUTHORITY', {
      clientId: clientA.clientId, request: { op: 'activity', window: 'unbounded' },
    })).rejects.toThrow(/activity window/u)
    for (const inheritedWindow of ['constructor', '__proto__']) {
      await expect(scene.request('PROCESS_CLIENT_READ_AUTHORITY', {
        clientId: clientA.clientId, request: { op: 'activity', window: inheritedWindow },
      })).rejects.toThrow(/activity window/u)
      await expect(scene.request('PROCESS_CLIENT_READ_AUTHORITY', {
        clientId: clientA.clientId, request: { op: 'workspaces', window: inheritedWindow },
      })).rejects.toThrow(/workspaces window/u)
    }
    const ordinaryRecords = clientB.readRecords().length
    await expect(clientB.readAuthority({ op: 'read' })).rejects.toThrow(/does not declare the ordinary read-authority contract/u)
    expect(clientB.readRecords().slice(ordinaryRecords).some(record => record.op === 'read-authority-proof'),
      'an undeclared Client published a read probe record').toBe(false)
    await expect(scene.startClient({
      label: 'read-invalid-workspace', ...clientDirectories(scene, 'read-invalid-workspace'),
      readAuthorityProof: true, invalidWorkspacePath: true,
    })).rejects.toThrow(/read authority excludes invalid Workspace/u)
    await expect(scene.startClient({
      label: 'read-recovery', ...clientDirectories(scene, 'read-recovery'),
      readAuthorityProof: true, recoverFromHostId: 'missing-host',
    })).rejects.toThrow(/read authority excludes recovery and attach/u)
    await expect(scene.startClient({
      label: 'read-attach', ...clientDirectories(scene, 'read-attach'),
      readAuthorityProof: true, attachRecoveredHostId: 'missing-client',
    })).rejects.toThrow(/read authority excludes recovery and attach/u)
    const read = await readFacts(clientA, 'A reads the pending Session from Y')
    expect(read.openSessionId, 'A was no longer on Y').toBe(sessionY)
    expect(read.sessionOpen, 'A had no open Session').toBe(true)
    expectNotRetained(read, sessionX, 'A reads the pending Question')
    const rowX = rowOf(read, sessionX, 'pending Session row')
    expect(rowX.live, 'the listed row was not conservatively detached').toBe(false)
    const factX = factOf(read, sessionX, 'pending Question fact')
    expect(factX.attention, 'pending Question attention').toBe('question')
    expect(factX.attentionSourceState, 'pending Question authority state').toBe('known')
    expect(factX.running, 'pending Session running state').toBe(true)
    expect(factX.pendingKinds, 'Gateway pending kinds').toContain('question')
    const factY = factOf(read, sessionY, 'idle Session fact')
    expect(factY.running, 'idle Session running state').toBe(false)
    expect(factY.attention, 'idle Session attention').toBe('none')
    expect((read.rows ?? []).every((row: ProbeRecord) => row.origin === undefined),
      'the two-Session corpus unexpectedly contained a child row').toBe(true)
    expect((await clientA.text()).includes('[1] Proceed'), 'A admitted another Session\'s Question').toBe(false)
    expectNoNewHostEvents(scene, sessionX, writeBoundary, 'read of the pending Question')
    expectNoNewHostEvents(scene, sessionY, yWriteBoundary, 'read of the pending Question left Y untouched')
    expect(await scene.sessionIds(), 'the read created a Session').toEqual(sessionIdsBefore)

    const activityDispatched = await clientA.readAuthority({ op: 'activity', window: 'warm' })
    expect(activityDispatched.op, 'wrong activity dispatch').toBe('activity')
    const activity = await waitProbe(clientA, activityDispatched.nonce, 'activity-result',
      'incremental Activity result')
    const counters = activity.counters ?? {}
    expect(counters.state, 'the observation never sampled the current Session').toBeGreaterThanOrEqual(1)
    expect(counters.projections, 'the observation never discovered an ordinary row').toBeGreaterThanOrEqual(1)
    expect(counters.peak, 'the unary request capacity was exceeded').toBeLessThanOrEqual(4)
    expect(counters.state, 'the whole stable 2-row roster was sampled').toBeLessThanOrEqual(4)
    expect(counters.projections, 'more projections than listed rows').toBeLessThanOrEqual(activity.rows + 1)
    const snapshots: ProbeRecord[] = activity.snapshots ?? []
    expect(snapshots.length, 'no incremental snapshot was published').toBeGreaterThanOrEqual(1)
    const latest = snapshots.at(-1)!
    expect((latest.facts ?? []).length, 'not one fact per authorized row').toBeGreaterThanOrEqual(2)
    expect(snapshots.map(snapshot => (snapshot.facts ?? []).find((fact: ProbeRecord) => fact.sessionId === sessionX))
      .filter(fact => fact !== undefined)
      .some(fact => fact.attention === 'question' && fact.attentionSourceState === 'known'),
    'the incremental observation never discovered the real Question').toBe(true)
    expect(latest.rosterRevision, 'no separate roster revision').toBeTypeOf('number')
    expect(latest.revision, 'no separate Activity revision').toBeTypeOf('number')
    expectNoNewHostEvents(scene, sessionX, writeBoundary, 'incremental Activity observation')
    expectNoNewHostEvents(scene, sessionY, yWriteBoundary, 'incremental Activity observation left Y untouched')

    const readAgain = await readFacts(clientA, 'A reads again after the observation')
    expectNotRetained(readAgain, sessionX, 'second read')
    expect(readAgain.generationId, 'the observation changed the Connection generation').toBe(read.generationId)
    expect(readAgain.openSessionId, 'A left Y').toBe(sessionY)
    expectNoNewHostEvents(scene, sessionX, writeBoundary, 'second read')
    expectNoNewHostEvents(scene, sessionY, yWriteBoundary, 'second read left Y untouched')

    const navigateBoundary = eventCount(scene, sessionX)
    await submitKnown(clientA, `/resume ${sessionX}`, 'A navigates to the pending Session')
    await clientA.waitForSurfaceStatus(record => record.sessionOpen === true
      && record.openSessionId === sessionX, 'A committed the navigation')
    expect(scene.sessionEvents(sessionX)!.slice(navigateBoundary).some(event => event.type === 'tool/result'
      || event.type === 'turn/end'), 'navigation settled the Host Question').toBe(false)
    await waitFrame(clientA, '[1] Proceed', 'A now paints the Question')
    const answerBoundary = eventCount(scene, sessionX)
    await clientA.type('1')
    await waitFrame(clientA, 'Review your answer before submit', 'A Question review', 30_000)
    await clientA.press('Enter')
    const settled = await waitWork(host,
      event => event.kind === 'question-settled' && event.sessionId === sessionX, 'Host Question settlement')
    expect(settled.answers?.[0]?.selected?.[0], 'the Host received another answer').toBe('Proceed')
    const result = await scene.waitForSessionEvent(sessionX, answerBoundary,
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
      'exact Question tool result')
    expect(result.data?.message?.isError, 'the answered Question failed').not.toBe(true)
    await scene.waitForSessionEvent(sessionX, answerBoundary,
      event => event.type === 'turn/end', 'Question Turn end')
    await waitFrameGone(clientB, '[1] Proceed', 'B Question withdrawn')

    const lateBoundary = eventCount(scene, sessionX)
    await clientB.type('2')
    await waitForComposerDraft(clientB, '2', 'B late option became ordinary draft', 30_000)
    await clientB.press('Ctrl+U')
    await waitForComposerDraft(clientB, '', 'B late draft cleared', 30_000)
    expect(scene.sessionEvents(sessionX)!.slice(lateBoundary).some(event => event.type === 'tool/call'
      || event.type === 'tool/result' || event.type === 'turn/start' || event.type === 'turn/end'),
    'a late loser key produced Host activity').toBe(false)

    const readAfter = await readFacts(clientA, 'A reads the settled Session')
    expect(factOf(readAfter, sessionX, 'settled fact').pendingKinds, 'a pending Question survived').not.toContain('question')
    expect(factOf(readAfter, sessionX, 'settled attention').attention, 'Question attention survived').not.toBe('question')
    const finalEvents = scene.sessionEvents(sessionX) ?? []
    expect(finalEvents.filter(event => event.type === 'tool/result'
      && String(event.data?.message?.toolCallId) === callId), 'a second Host result').toHaveLength(1)
    const proofs = readWork(host, 'final Question proofs')
    expect(proofs.filter(event => event.kind === 'question-request' && event.sessionId === sessionX),
      'Question request count').toHaveLength(1)
    expect(proofs.filter(event => event.kind === 'question-settled' && event.sessionId === sessionX),
      'Question settlement count').toHaveLength(1)

    await exitNormally(clientB, 'B question')
    await exitNormally(clientA, 'A question')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'read Question')
  }
})

test('reads another Session\'s Approval without retaining it and settles only after navigation', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'approval-allow' })
    const clientA = await scene.startClient({
      label: 'read-approval-a', ...clientDirectories(scene, 'read-approval-a'), readAuthorityProof: true,
    })
    const sessionY = await openEmptySession(scene, clientA, 'A opens an empty Session')
    const clientB = await scene.startClient({ label: 'read-approval-b', ...clientDirectories(scene, 'read-approval-b') })
    const before = new Set(await scene.sessionIds())
    await submitKnown(clientB, 'read-authority-approval-trigger', 'B triggers the Host Approval')
    const sessionX = await scene.waitForNewSessionId(before, 'Approval Session creation')
    const toolCall = await scene.waitForSessionEvent(sessionX, 0,
      event => event.type === 'tool/call' && event.data?.name === 'bash', 'Approval tool/call')
    const toolCallId = toolCall.data?.callId
    expect(toolCallId, 'the tool/call carries no callId').toBeTypeOf('string')
    const asked = await scene.waitForSessionEvent(sessionX, 0,
      event => event.type === 'approval/asked', 'Host approval/asked')
    const requestId = asked.data?.id
    expect(requestId, 'the Host request carries no id').toBeTypeOf('string')
    await waitWork(host,
      event => event.kind === 'approval-request' && event.sessionId === sessionX, 'fixture Approval request')
    await waitFrame(clientB, '[y] Allow once', 'B paints the Approval')

    const writeBoundary = eventCount(scene, sessionX)
    const read = await readFacts(clientA, 'A reads the pending Approval from Y')
    expect(read.openSessionId, 'A was no longer on Y').toBe(sessionY)
    expectNotRetained(read, sessionX, 'A reads another Session\'s Approval')
    const factX = factOf(read, sessionX, 'pending Approval fact')
    expect(factX.attention, 'Approval attention').toBe('approval')
    expect(factX.attentionSourceState, 'Approval authority state').toBe('known')
    expect(factX.pendingKinds, 'Gateway pending kinds').toContain('approval')
    expect((await clientA.text()).includes('[y] Allow once'), 'A admitted another Session\'s Approval').toBe(false)
    expectNoNewHostEvents(scene, sessionX, writeBoundary, 'read of the pending Approval')

    const navigateBoundary = eventCount(scene, sessionX)
    await submitKnown(clientA, `/resume ${sessionX}`, 'A navigates to the Approval Session')
    await clientA.waitForSurfaceStatus(record => record.sessionOpen === true
      && record.openSessionId === sessionX, 'A committed the Approval navigation')
    expect(scene.sessionEvents(sessionX)!.slice(navigateBoundary).some(event => event.type === 'approval/decided'
      || event.type === 'tool/result'), 'navigation decided the Host Approval').toBe(false)
    await waitFrame(clientA, '[y] Allow once', 'A paints the live Approval')
    const decisionBoundary = eventCount(scene, sessionX)
    await clientA.press('y')
    const decided = await scene.waitForSessionEvent(sessionX, decisionBoundary,
      event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
      'exact Host Approval decision')
    expect(decided.data?.outcome, 'the Host Approval outcome').toBe('allowed-once')
    const settled = await waitWork(host,
      event => event.kind === 'approval-settled' && event.outcome === 'allowed-once',
      'allowed-once settlement')
    expect(String(settled.callId), 'the settlement named another tool call').toBe(toolCallId as string)
    await scene.waitForSessionEvent(sessionX, decisionBoundary,
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolCallId,
      'Approval tool result')
    await scene.waitForSessionEvent(sessionX, decisionBoundary,
      event => event.type === 'turn/end', 'Approval Turn end')
    const marker = join(workRoot(host, 'Approval marker'), 'approval-allow.marker')
    expect(existsSync(marker), 'the allowed harmless command never ran').toBe(true)
    await waitFrameGone(clientB, '[y] Allow once', 'B Approval withdrawn')

    const lateBoundary = eventCount(scene, sessionX)
    await clientB.press('n')
    await clientA.press('y')
    await waitForComposerDraft(clientB, 'n', 'B late key became ordinary draft', 30_000)
    const decisions = (scene.sessionEvents(sessionX) ?? []).slice(lateBoundary)
      .filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId)
    expect(decisions, 'a repeated decision was admitted').toHaveLength(0)
    expect((scene.sessionEvents(sessionX) ?? []).filter(event => event.type === 'approval/decided'
      && String(event.data?.id) === requestId), 'a second Host decision').toHaveLength(1)

    const readAfter = await readFacts(clientA, 'A reads the settled Approval')
    expect(factOf(readAfter, sessionX, 'settled Approval fact').pendingKinds,
      'a pending Approval survived').not.toContain('approval')
    expect(readAfter.openSessionId, 'the settled read did not run on the navigated Session').toBe(sessionX)
    expectNotRetained(readAfter, sessionY, 'read after the Approval')
    expect(retentionCount(rowOf(readAfter, sessionX, 'navigated Approval Session row'), 'navigated Approval Session row'),
      'the current Session lost its own view').toBeGreaterThanOrEqual(1)

    await exitNormally(clientB, 'B approval')
    await exitNormally(clientA, 'A approval')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'read Approval')
  }
})

test('queues a continued Question reply for an unopened Session exactly once', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'question', timedQuestion: true })
    const clientA = await scene.startClient({
      label: 'continued-answer-a', ...clientDirectories(scene, 'continued-answer-a'), readAuthorityProof: true,
    })
    const sessionY = await openEmptySession(scene, clientA, 'A opens an unopened-observer Session')
    const clientB = await scene.startClient({
      label: 'continued-answer-b', ...clientDirectories(scene, 'continued-answer-b'),
    })
    const { sessionId: sessionX, callId } = await triggerQuestion(scene, host, clientB, 'read-authority-timed')
    await waitWork(host,
      event => event.kind === 'question-failed' && event.sessionId === sessionX, 'timed foreground ended')
    await scene.waitForSessionEvent(sessionX, 0,
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
      'timed Question result')
    await waitWork(host,
      event => event.kind === 'after-timed-held' && event.sessionId === sessionX, 'continued Turn held')

    const heldBoundary = eventCount(scene, sessionX)
    const heldBoundaryY = eventCount(scene, sessionY)
    const read = await readFactsUntil(clientA, record => {
      const fact = (record.facts ?? []).find((entry: ProbeRecord) => entry.sessionId === sessionX)
      return fact !== undefined && Array.isArray(fact.continuedQuestionCallIds)
        && fact.continuedQuestionCallIds.includes(callId)
    }, 'A reads the unanswered continued Question')
    expect(read.openSessionId, 'A opened the continued Session').toBe(sessionY)
    expectNotRetained(read, sessionX, 'A reads the continued Question')
    const factX = factOf(read, sessionX, 'continued Question fact')
    expect(factX.attention, 'continued Question attention').toBe('question')
    expect(factX.attentionSourceState, 'continued Question authority state').toBe('known')
    expect(factX.pendingKinds, 'the timed-out Question still reports a Gateway pending').not.toContain('question')
    expect(factX.continuedQuestionCallIds, 'the successful facts read did not publish the continued callId').toContain(callId)
    expectNoNewHostEvents(scene, sessionX, heldBoundary, 'read of the continued Question')

    const answerDispatched = await clientA.readAuthority({
      op: 'answer-continued', sessionId: sessionX, callId,
    })
    expect(answerDispatched.op, 'wrong continued answer dispatch').toBe('answer-continued')
    const answer = await waitProbePhases(clientA, answerDispatched.nonce,
      ['continued-answer', 'failed'], 'official continued answer')
    expect(answer.phase, 'the continued answer failed').toBe('continued-answer')
    expect(answer.outcome, 'the continued reply was not queued').toBe('queued')
    expect(String(answer.sessionId), 'the reply addressed another Session').toBe(sessionX)
    expect(String(answer.callId), 'the reply addressed another Question').toBe(callId)

    const suppressed = await readFactsUntil(clientA, record => {
      const fact = (record.facts ?? []).find((entry: ProbeRecord) => entry.sessionId === sessionX)
      return fact !== undefined && Array.isArray(fact.continuedQuestionCallIds)
        && !fact.continuedQuestionCallIds.includes(callId)
    }, 'queued reply withdraws the continued candidate', 20_000)
    const suppressedFact = factOf(suppressed, sessionX, 'queued reply fact')
    expect(suppressedFact.attention, 'a queued reply still reports an answerable candidate').not.toBe('question')
    expect(suppressedFact.attention, 'a queued reply still reports a review candidate').not.toBe('plan-review')

    await releaseOnce(host.timedAfterBarrierPath, 'continued Turn release')
    const reply = await scene.waitForSessionEvent(sessionX, heldBoundary,
      event => event.type === 'user/message'
        && event.data?.source?.kind === 'user-question-reply'
        && String(event.data?.source?.callId) === callId,
      'durable continued reply')
    expect(messageText(reply.data), 'the durable reply lost the Proceed answer').toContain('Proceed')
    expectNoNewHostEvents(scene, sessionY, heldBoundaryY, 'continued reply left Y untouched')

    const replyBoundary = eventCount(scene, sessionX)
    const repeatDispatched = await clientA.readAuthority({
      op: 'answer-continued', sessionId: sessionX, callId,
    })
    const repeat = await waitProbePhases(clientA, repeatDispatched.nonce,
      ['continued-answer', 'failed'], 'repeated continued answer')
    expect(repeat.phase === 'failed'
      || (repeat.phase === 'continued-answer' && repeat.outcome === 'not-continued'),
    'the repeated late answer was accepted again').toBe(true)
    await readFacts(clientA, 'A reads after the repeated reply')
    expect((scene.sessionEvents(sessionX) ?? []).slice(replyBoundary).filter(event => event.type === 'user/message'
      && event.data?.source?.kind === 'user-question-reply'
      && String(event.data?.source?.callId) === callId), 'a second durable reply').toHaveLength(0)
    expect((scene.sessionEvents(sessionX) ?? []).filter(event => event.type === 'user/message'
      && event.data?.source?.kind === 'user-question-reply'
      && String(event.data?.source?.callId) === callId), 'the continued reply was not claimed once').toHaveLength(1)

    await exitByDeclaredSignal(clientB, 'B continued Question')
    await exitByDeclaredSignal(clientA, 'A continued reply')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'continued Question reply')
  }
})

test('reads an unanswered continued Question after a clean Host restart without opening it', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'question', timedQuestion: true })
    const clientB = await scene.startClient({
      label: 'cold-continued-b', ...clientDirectories(scene, 'cold-continued-b'),
    })
    const { sessionId: sessionX, callId } = await triggerQuestion(scene, host, clientB, 'cold-continued-question')
    await waitWork(host,
      event => event.kind === 'after-timed-held' && event.sessionId === sessionX, 'continued Turn held before restart')
    await scene.waitForSessionEvent(sessionX, 0,
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
      'timed Question result')
    const beforeRelease = eventCount(scene, sessionX)
    await releaseOnce(host.timedAfterBarrierPath, 'continued Turn release before a clean restart')
    await scene.waitForSessionEvent(sessionX, beforeRelease,
      event => event.type === 'turn/end', 'continued Turn normal end')
    await exitByDeclaredSignal(clientB, 'B before the clean restart')
    const oldHostPid = host.ready.hostPid ?? host.ready.localHost?.hostPid
    const oldInstanceId = host.ready.localHost?.instanceId
    await scene.stopHost(host)
    const originalEvents = scene.sessionEvents(sessionX) ?? []
    const originalCall = originalEvents.find(event => event.type === 'tool/call'
      && String(event.data?.callId) === callId)
    expect(originalCall, 'the clean predecessor lost the original Question call').toBeDefined()
    const originalTurn = originalCall!.data?.turn
    expect(originalTurn, 'the original Question call has no Turn identity').toBeTypeOf('number')
    expect(originalEvents.filter(event => event.type === 'tool/result'
      && String(event.data?.message?.toolCallId) === callId), 'original Question result count').toHaveLength(1)
    expect(originalEvents.filter(event => event.type === 'turn/end'
      && event.data?.turn === originalTurn), 'original Question Turn end count').toHaveLength(1)

    const coldHost = await scene.startHost({ scenario: 'question' })
    expect(coldHost.ready.hostPid ?? coldHost.ready.localHost?.hostPid,
      'the clean restart reused the old Host PID').not.toBe(oldHostPid)
    expect(coldHost.ready.localHost?.instanceId, 'the clean restart reused the old Host instance').not.toBe(oldInstanceId)
    const cold = await scene.startClient({
      label: 'cold-continued-reader',
      ...clientDirectories(scene, 'cold-continued-reader'),
      readAuthorityProof: true,
    })
    expect(cold.ready.sessionOpen, 'the cold reader opened a Session at startup').toBe(false)
    // Locate the persisted Session through the restarted Host's real roster and
    // durable call identity, then require that its identity did not migrate.
    const started = Date.now()
    let persistedSessionId: string | undefined
    while (Date.now() - started < 30_000) {
      persistedSessionId = (await scene.sessionIds()).find(id => (scene.sessionEvents(id) ?? []).some(
        event => event.type === 'tool/call' && String(event.data?.callId) === callId))
      if (persistedSessionId !== undefined) break
      await sleep(200)
    }
    expect(persistedSessionId, 'the restarted Host did not list the persisted continued Session').toBeTypeOf('string')
    expect(persistedSessionId, 'the persisted Session identity changed across a clean Host restart').toBe(sessionX)
    const coldReadBoundary = eventCount(scene, sessionX)

    const read = await readFactsUntil(cold, record => {
      const fact = (record.facts ?? []).find((entry: ProbeRecord) => entry.sessionId === sessionX)
      return fact !== undefined && Array.isArray(fact.continuedQuestionCallIds)
        && fact.continuedQuestionCallIds.includes(callId)
    }, 'cold read of the persisted continued Question', 120_000)
    rowOf(read, sessionX, 'cold persisted Session row')
    const fact = factOf(read, sessionX, 'cold persisted continued fact')
    expect(fact.attention, 'cold continued attention').toBe('question')
    expect(fact.attentionSourceState, 'cold continued authority state').toBe('known')
    expect(fact.pendingKinds, 'the cold timed-out Question still reports a Gateway pending').not.toContain('question')
    expectNotRetained(read, sessionX, 'cold read of the persisted Question')

    const activityDispatched = await cold.readAuthority({ op: 'activity', window: 'cold' })
    expect(activityDispatched.op, 'wrong cold activity dispatch').toBe('activity')
    const activity = await waitProbe(cold, activityDispatched.nonce, 'activity-result', 'cold Activity result')
    const snapshot = (activity.snapshots ?? []).find((entry: ProbeRecord) =>
      (entry.facts ?? []).some((item: ProbeRecord) => item.sessionId === sessionX
        && Array.isArray(item.continuedQuestionCallIds) && item.continuedQuestionCallIds.includes(callId)))
    expect(snapshot, 'cold Activity never published the continued fact').toBeDefined()
    expect(snapshot.rosterRevision, 'cold Activity carries no roster revision').toBeTypeOf('number')
    expect(snapshot.revision, 'cold Activity carries no Activity revision').toBeTypeOf('number')
    expectNoNewHostEvents(scene, sessionX, coldReadBoundary, 'cold read and Activity observation')
    const coldEvents = scene.sessionEvents(sessionX) ?? []
    expect(coldEvents, 'cold startup, read or Activity rewrote the original Session history').toEqual(originalEvents)
    expect(coldEvents.filter(event => event.type === 'tool/call'
      && String(event.data?.callId) === callId), 'the cold Session was migrated or re-triggered').toHaveLength(1)
    expect(coldEvents.filter(event => event.type === 'tool/result'
      && String(event.data?.message?.toolCallId) === callId), 'the cold Question result was rewritten').toHaveLength(1)
    expect(coldEvents.filter(event => event.type === 'turn/end'
      && event.data?.turn === originalTurn), 'the cold Question Turn terminal was rewritten').toHaveLength(1)

    await exitByDeclaredSignal(cold, 'cold reader')
    await scene.stopHost(coldHost)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'cold continued Question')
  }
})

test('follows Host Workspace membership across a replaced carrier without adopting Client paths', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'question' })
    const clientA = await scene.startClient({
      label: 'workspace-stream-a', ...clientDirectories(scene, 'workspace-stream-a'), readAuthorityProof: true,
    })
    const sessionY = await openEmptySession(scene, clientA, 'A opens a Host Workspace Session')
    const peer = clientDirectories(scene, 'workspace-peer-b')
    const clientB = await scene.startClient({
      label: 'workspace-peer-b', ...peer, readAuthorityProof: true,
    })
    expect(clientB.ready.sessionOpen, 'the peer opened a Session of its own').toBe(false)

    const streamYBoundary = eventCount(scene, sessionY)
    const streamDispatched = await clientA.readAuthority({ op: 'workspaces', window: 'stream' })
    expect(streamDispatched.op, 'wrong membership stream dispatch').toBe('workspaces')
    await waitProbe(clientA, streamDispatched.nonce, 'workspaces-open', 'Host Workspace stream opened')
    const baseline = await waitProbe(clientA, streamDispatched.nonce, 'workspaces-frame',
      'Host Workspace baseline', record => record.type === 'baseline')
    const member = (baseline.items ?? []).find((item: ProbeRecord) =>
      Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionY))
    expect(member, 'A\'s Session was absent from the Host Workspace baseline').toBeDefined()
    expect(member.workspaceId, 'baseline Workspace has no Host identity').toBeTypeOf('string')
    expect(member.path, 'baseline Workspace has no Host path').toBeTypeOf('string')
    expect(member.title, 'baseline Workspace has no Host title').toBeTypeOf('string')

    const peerDispatched = await clientB.readAuthority({ op: 'workspaces', window: 'peer-baseline' })
    await waitProbe(clientB, peerDispatched.nonce, 'workspaces-open', 'peer Workspace stream opened')
    const peerBaseline = await waitProbe(clientB, peerDispatched.nonce, 'workspaces-frame',
      'peer Workspace baseline', record => record.type === 'baseline')
    const peerMember = (peerBaseline.items ?? []).find((item: ProbeRecord) =>
      Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionY))
    expect(peerMember, 'the peer did not read the Host Workspace').toBeDefined()
    expect(peerMember.workspaceId, 'Workspace identity changed across Clients').toBe(member.workspaceId)
    expect(peerMember.path, 'Workspace path changed across Clients').toBe(member.path)
    expect(peerMember.title, 'Workspace title changed across Clients').toBe(member.title)
    expect(peerMember.path, 'the peer adopted its own launch directory').not.toBe(peer.cwd)
    await waitProbe(clientB, peerDispatched.nonce, 'workspaces-ended', 'peer Workspace stream ended')

    await expect(scene.request('PROCESS_CLIENT_READ_AUTHORITY', {
      clientId: clientA.clientId, request: { op: 'read' },
    })).rejects.toThrow(/unsettled workspaces request/u)

    const sessionX = await openEmptySession(scene, clientA, 'A creates a new Host Workspace member')
    expect(sessionX, 'A reused its old Session').not.toBe(sessionY)
    const increment = await waitProbe(clientA, streamDispatched.nonce, 'workspaces-frame',
      'Host Workspace membership increment',
      record => (record.type === 'upsert' || record.type === 'replace')
        && JSON.stringify(record).includes(sessionX), 120_000)
    if (increment.type === 'upsert') {
      expect(increment.workspace?.workspaceId, 'the increment named another Workspace').toBe(member.workspaceId)
      expect(increment.workspace?.sessionIds, 'the increment lost the new member').toContain(sessionX)
    } else {
      const updated = (increment.items ?? []).find((item: ProbeRecord) => item.workspaceId === member.workspaceId)
      expect(updated, 'the replacement lost the original Workspace').toBeDefined()
      expect(updated.sessionIds, 'the replacement lost the new member').toContain(sessionX)
    }
    // A newly created Session emits its own permission/sandbox/approval policy
    // projections asynchronously. Wait for those authoritative initialization
    // facts before measuring whether the stream/read writes anything else.
    await scene.waitForSessionEvent(sessionX, 0, event => event.type === 'permission/preset',
      'new Session permission preset initialized')
    await scene.waitForSessionEvent(sessionX, 0, event => event.type === 'sandbox/mode',
      'new Session sandbox mode initialized')
    await scene.waitForSessionEvent(sessionX, 0, event => event.type === 'approval/policy',
      'new Session approval policy initialized')
    const streamXBoundary = eventCount(scene, sessionX)
    await waitProbe(clientA, streamDispatched.nonce, 'workspaces-ended', 'Host Workspace stream ended',
      () => true, 150_000)

    const afterStream = await readFacts(clientA, 'A reads after the stream settled')
    expect(afterStream.openSessionId, 'A left the Session it created during the stream').toBe(sessionX)
    expectNotRetained(afterStream, sessionY, 'read after the Workspace stream')
    // X is A's own committed Session after the in-stream `/new`: retaining it is
    // the product's current-surface contract, not an effect of the read probe.
    expect(retentionCount(rowOf(afterStream, sessionX, 'current Session row'), 'current Session row'),
      'A did not retain its own current Session').toBeGreaterThanOrEqual(1)
    expectNoNewHostEvents(scene, sessionY, streamYBoundary, 'membership stream and read left Y untouched')
    expectNoNewHostEvents(scene, sessionX, streamXBoundary,
      'membership stream and read added no X event after Workspace membership increment')

    const recoveringYBoundary = eventCount(scene, sessionY)
    const recoveringXBoundary = eventCount(scene, sessionX)
    const recoveringDispatched = await clientA.readAuthority({ op: 'workspaces', window: 'recovering' })
    await waitProbe(clientA, recoveringDispatched.nonce, 'workspaces-open', 'recovering stream opened')
    const recoveringBaseline = await waitProbe(clientA, recoveringDispatched.nonce, 'workspaces-frame',
      'recovering Workspace baseline', record => record.type === 'baseline')
    expect((recoveringBaseline.items ?? []).some((item: ProbeRecord) =>
      Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionY)),
    'the recovering baseline lost the original member').toBe(true)

    const beforeDrop = await clientA.waitForSurfaceStatus(record => record.transport === 'connected'
      && typeof record.generationId === 'number', 'A had a connected generation before the carrier drop')
    await clientA.signal('SIGUSR1')
    const reconnected = await clientA.waitForSurfaceStatus(record => record.transport === 'connected'
      && typeof record.generationId === 'number' && record.generationId !== beforeDrop.generationId,
    'A reconnected on a new generation')
    const invalidated = await waitProbe(clientA, recoveringDispatched.nonce, 'workspaces-frame',
      'membership invalidated by the carrier drop', record => record.type === 'invalidated')
    const freshBaseline = await waitProbe(clientA, recoveringDispatched.nonce, 'workspaces-frame',
      'fresh baseline after the carrier drop', record => record.type === 'baseline'
        && typeof record.seq === 'number' && record.seq > invalidated.seq)
    const freshY = (freshBaseline.items ?? []).find((item: ProbeRecord) =>
      Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionY))
    const freshX = (freshBaseline.items ?? []).find((item: ProbeRecord) =>
      Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionX))
    expect(freshY, 'the fresh baseline lost the original member').toBeDefined()
    expect(freshY.workspaceId, 'the fresh baseline changed Workspace identity').toBe(member.workspaceId)
    expect(freshY.path, 'the fresh baseline adopted a Client path').toBe(member.path)
    expect(freshX, 'the fresh baseline lost the newly created member').toBeDefined()
    expect(freshX.workspaceId, 'the fresh baseline split one Host Workspace').toBe(member.workspaceId)

    expect(invalidated.handle, 'the invalidated frame carries no logical handle').toBeTypeOf('number')
    expect(freshBaseline.handle, 'the fresh frame carries no logical handle').toBeTypeOf('number')
    await waitProbe(clientA, recoveringDispatched.nonce, 'workspaces-ended', 'recovering stream ended',
      () => true, 150_000)
    // Classify from the COMPLETE correlated stream after its terminal record;
    // absence is never inferred from a short observation timeout.
    const streamRecords = clientA.readRecords().filter(record => record.m4b2s === 'qualification'
      && record.op === 'read-authority-proof' && record.nonce === recoveringDispatched.nonce)
    const terminals = streamRecords.filter(record => record.phase === 'workspaces-terminal')
    const replacements = streamRecords.filter(record => record.phase === 'workspaces-handle')
    const framesAfterInvalidation = streamRecords.filter(record => record.phase === 'workspaces-frame'
      && typeof record.seq === 'number' && record.seq > invalidated.seq)
    if (terminals.length > 0) {
      expect(terminals, 'more than one terminal provenance record was emitted').toHaveLength(1)
      const terminal = terminals[0]
      expect(terminal.handle, 'the terminal record named another logical handle').toBe(invalidated.handle)
      expect(terminal.attemptKnown, 'no authoritative attempt generation').toBe(true)
      expect(terminal.liveDefined, 'no defined live generation at failure').toBe(true)
      expect(terminal.attemptIsLive, 'a live attempt was treated as replaced').toBe(false)
      expect(terminal.replacedInTime, 'the replacement was not established in time').toBe(true)
      expect(terminal.errorName, 'the terminal record carries no actual error class').toBeTypeOf('string')
      expect(replacements.map(record => record.handle),
        'replacement did not create exactly one new logical handle').toEqual([invalidated.handle + 1])
      expect(framesAfterInvalidation.every(record =>
        record.handle === invalidated.handle || record.handle === invalidated.handle + 1),
      'a frame used a handle outside the old-or-one-replacement set').toBe(true)
      const replacementIndex = streamRecords.findIndex(record => record.phase === 'workspaces-handle')
      expect(streamRecords.slice(replacementIndex + 1)
        .filter(record => record.phase === 'workspaces-frame')
        .every(record => record.handle === invalidated.handle + 1),
      'old and replacement handles overlapped after replacement').toBe(true)
      expect(freshBaseline.handle, 'more than one legal replacement handle').toBe(invalidated.handle + 1)
    } else {
      expect(replacements, 'the retryable carrier branch created a replacement handle').toHaveLength(0)
      expect(framesAfterInvalidation.every(record => record.handle === invalidated.handle),
        'the retryable carrier branch changed logical handle').toBe(true)
      expect(freshBaseline.handle, 'the retryable carrier branch changed the logical handle').toBe(invalidated.handle)
    }

    const afterReconnect = await readFacts(clientA, 'A reads on the new carrier generation')
    expect(afterReconnect.generationId, 'the post-reconnect read ran on the old generation').toBe(reconnected.generationId)
    expect(factOf(afterReconnect, sessionX, 'post-reconnect Session fact').attentionSourceState,
      'the post-reconnect read published no fact state').toBeDefined()
    expectNoNewHostEvents(scene, sessionY, recoveringYBoundary, 'recovering stream and read left Y untouched')
    expectNoNewHostEvents(scene, sessionX, recoveringXBoundary, 'recovering stream and read added no X event')

    await exitNormally(clientB, 'peer Workspace reader')
    await exitNormally(clientA, 'A Workspace reader')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'Host Workspace membership')
  }
})
