import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'vitest'

import { readOfficialClientRecords } from '../../../support/split-process-client.ts'
import {
  createSplitProcessScene,
  type SessionEvent,
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

function clientDirectories(scene: SplitProcessScene, label: string): { home: string; cwd: string } {
  const home = join(scene.workDir, 'clients', label, 'home')
  // Distinct Client homes, one shared Host workspace: both Sessions must be
  // browsable from the same Session Workspace tree.
  const cwd = join(scene.workDir, 'client-workspace')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  return { home, cwd }
}

function shortSessionId(id: string): string {
  return id.replace(/^session[-_]/i, '').slice(0, 8)
}

/** Supervisor admission: client labels must be lowercase path-safe components. */
function clientLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/(^-+|-+$)/gu, '')
}

/** Fence a prompt commit on the painted draft and the exact durable occurrence. */
async function submitAuthoredPrompt(
  scene: SplitProcessScene,
  client: SplitProcessClient,
  sessionId: string,
  prompt: string,
  label: string,
): Promise<number> {
  const cut = durableEvents(scene, sessionId).length
  await client.type(prompt)
  // Long drafts are painted with a trailing ellipsis; only a stable prefix is
  // observable. The exact committed text is proven by the durable occurrence.
  await waitForComposerPrefix(client, prompt.slice(0, 8), `${label}: authored prompt in the composer`)
  await client.press('Enter')
  await scene.waitForSessionEvent(sessionId, cut,
    event => event.type === 'user/message' && Array.isArray(event.data?.content)
      && event.data.content.some((part: Record<string, any>) => part?.text === prompt),
    `${label}: exact authored occurrence`)
  return cut
}

async function waitFrame(client: SplitProcessClient, text: string, label: string, timeoutMs = 120_000): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (frame.includes(text)) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: ${JSON.stringify(text)} was not painted; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(25)
  }
}

async function waitFrameGone(client: SplitProcessClient, text: string, label: string, timeoutMs = 120_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (!(await client.text()).includes(text)) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: ${JSON.stringify(text)} remained painted; frame=${JSON.stringify((await client.text()).slice(-2000))}`)
    }
    await sleep(25)
  }
}

function composerDraft(frame: string): string | undefined {
  const lines = frame.split('\n')
  const marker = lines.findLastIndex(line => line.trimStart().startsWith('❯'))
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

async function waitForComposerPrefix(
  client: SplitProcessClient,
  prefix: string,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    const draft = composerDraft(await client.text())
    if (draft?.includes(prefix) === true) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: composer draft ${JSON.stringify(draft)} never carried ${JSON.stringify(prefix)}`)
    }
    await sleep(25)
  }
}

/** Empty means the real composer marker is painted with an empty value or its `……` placeholder. */
async function waitForEmptyComposer(client: SplitProcessClient, label: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    const draft = composerDraft(await client.text())
    // `undefined` means no composer marker (overlay/transition), never empty.
    if (typeof draft === 'string' && (draft === '' || /^…{1,2}$/u.test(draft))) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: no painted empty composer; draft=${JSON.stringify(draft)}`)
    }
    await sleep(25)
  }
}

function lastSurfaceStatus(client: SplitProcessClient): Record<string, any> | undefined {
  return readOfficialClientRecords(client.recordFile, client.label, { allowIncompleteTail: true })
    .filter(record => record.m4b2s === 'surface-status').at(-1)
}

function workEvents(host: SplitProcessHostHandle): WorkEvent[] {
  expect(host.workloadRoot, 'the Host has no registered workload root').toBeTypeOf('string')
  return fixtureHelpers.readC1WorkEvents(host.workloadRoot!)
}

async function waitForWorkAfter(
  host: SplitProcessHostHandle,
  afterIndex: number,
  predicate: (event: WorkEvent) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<WorkEvent> {
  const started = Date.now()
  for (;;) {
    const event = workEvents(host).slice(afterIndex).find(predicate)
    if (event !== undefined) return event
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: no fresh matching Host fixture event`)
    }
    await sleep(25)
  }
}

function releaseFile(path: string | null | undefined, label: string): void {
  if (typeof path !== 'string' || path === '') throw new Error(`${label}: no Supervisor-owned release path`)
  writeFileSync(path, 'release\n', { mode: 0o600, flag: 'wx' })
}

function durableEvents(scene: SplitProcessScene, sessionId: string): SessionEvent[] {
  return scene.sessionEvents(sessionId) ?? []
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

async function exitClientNormally(client: SplitProcessClient, label: string): Promise<void> {
  await client.press('Ctrl+U')
  await waitForEmptyComposer(client, `${label}: draft cleared before exit`)
  await client.exitGracefully()
  const exit = await client.close()
  expect(exit.code, `${label}: native exit code`).toBe(0)
  expect(exit.signal, `${label}: native exit signal`).toBeNull()
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

async function openEmptySession(scene: SplitProcessScene, client: SplitProcessClient, label: string): Promise<string> {
  const before = new Set(await scene.sessionIds())
  await client.submit('/new')
  const status = await client.waitForSurfaceStatus(
    record => record.sessionOpen === true && record.transport === 'connected'
      && record.surfaceMounted === true && typeof record.openSessionId === 'string'
      && !before.has(record.openSessionId),
    `${label}: empty Session committed`,
  )
  const sessionId = String(status.openSessionId)
  await scene.waitForHostSessionHeader(sessionId, `${label}: Session header`)
  expect(durableEvents(scene, sessionId).some(event =>
    event.type === 'user/message' || event.type === 'turn/start'),
  `${label}: the supposedly empty Session has authored work`).toBe(false)
  return sessionId
}

async function resumeSession(client: SplitProcessClient, sessionId: string, label: string): Promise<void> {
  await client.press('Ctrl+U')
  await waitForEmptyComposer(client, `${label}: command draft cleared`)
  await client.submit(`/resume ${sessionId}`)
  await client.waitForSurfaceStatus(
    record => record.sessionOpen === true && record.openSessionId === sessionId
      && record.transport === 'connected' && record.surfaceMounted === true,
    `${label}: resume committed`,
  )
}

async function enterNavigationHold(client: SplitProcessClient, modalText: string, label: string): Promise<void> {
  // The product's key identity is lower-case `alt+w`; a native modifier case
  // variant and raw ESC injection both miss it. Press the declared key itself.
  await client.press('alt+w')
  await waitFrame(client, 'Sessions ·', `${label}: Session Workspace opened`, 30_000)
  await waitFrameGone(client, modalText, `${label}: answerable modal withdrawn by the hold`, 30_000)
}

async function searchAndCommit(client: SplitProcessClient, sessionId: string, label: string): Promise<void> {
  await client.press('/')
  await waitFrame(client, 'Search all workspaces', `${label}: search entered`, 30_000)
  await client.type(sessionId)
  // The panel's two-step contract: the FIRST Enter only moves focus from the
  // search editor to the first result row; no resume intent is emitted yet.
  await client.press('Enter')
  await waitFrame(client, `> ${shortSessionId(sessionId)}`, `${label}: result row focused`, 60_000)
  // The SECOND Enter resumes the painted result row once and commits the
  // Session. Never repeat it on a guess, and never inject a resume directly.
  await client.press('Enter')
  await client.waitForSurfaceStatus(
    record => record.sessionOpen === true && record.openSessionId === sessionId,
    `${label}: selected Session committed`,
  )
}

async function startSharedQuestion(
  scene: SplitProcessScene,
  label: string,
): Promise<{
  host: SplitProcessHostHandle
  clientA: SplitProcessClient
  clientB: SplitProcessClient
  sessionX: string
  sessionY: string
  callId: string
}> {
  const host = await scene.startHost({ scenario: 'question' })
  const aLabel = clientLabel(`${label}-a`)
  const bLabel = clientLabel(`${label}-b`)
  const clientA = await scene.startClient({ label: aLabel, ...clientDirectories(scene, aLabel) })
  const sessionY = await openEmptySession(scene, clientA, `${label}: A empty Session`)
  const clientB = await scene.startClient({ label: bLabel, ...clientDirectories(scene, bLabel) })
  const sessionX = await openEmptySession(scene, clientB, `${label}: B own Session`)
  const cut = await submitAuthoredPrompt(scene, clientB, sessionX, `${label} question seed`, label)
  const call = await scene.waitForSessionEvent(sessionX, cut,
    event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
    `${label}: question tool/call`)
  const callId = String(call.data?.callId)
  expect(callId, `${label}: question call identity`).not.toBe('')
  await waitForWork(host, event => event.kind === 'question-request' && event.sessionId === sessionX,
    `${label}: pending Host Question`)
  await waitFrame(clientB, '[1] Proceed', `${label}: B paints the pending Question`)
  await resumeSession(clientA, sessionX, `${label}: A enters the pending Session`)
  await waitFrame(clientA, '[1] Proceed', `${label}: A is offered the same Question`)
  expect(durableEvents(scene, sessionX).filter(event =>
    event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId),
  `${label}: the pending Question already has a result`).toHaveLength(0)
  return { host, clientA, clientB, sessionX, sessionY, callId }
}

async function startSharedApproval(
  scene: SplitProcessScene,
  label: string,
  options: { cancelAgent?: true } = {},
): Promise<{
  host: SplitProcessHostHandle
  clientA: SplitProcessClient
  clientB: SplitProcessClient
  sessionX: string
  sessionY: string
  requestId: string
  toolCallId: string
}> {
  const host = await scene.startHost({
    scenario: 'approval-allow',
    ...(options.cancelAgent === true ? { cancelAgent: true as const } : {}),
  })
  const aLabel = clientLabel(`${label}-a`)
  const bLabel = clientLabel(`${label}-b`)
  const clientA = await scene.startClient({ label: aLabel, ...clientDirectories(scene, aLabel) })
  const sessionY = await openEmptySession(scene, clientA, `${label}: A empty Session`)
  const clientB = await scene.startClient({ label: bLabel, ...clientDirectories(scene, bLabel) })
  const sessionX = await openEmptySession(scene, clientB, `${label}: B own Session`)
  const cut = await submitAuthoredPrompt(scene, clientB, sessionX, `${label} approval seed`, label)
  const asked = await scene.waitForSessionEvent(sessionX, cut,
    event => event.type === 'approval/asked', `${label}: approval/asked`)
  const requestId = String(asked.data?.id)
  expect(requestId, `${label}: approval request identity`).not.toBe('')
  const request = await waitForWork(host,
    event => event.kind === 'approval-request' && event.sessionId === sessionX,
    `${label}: pending Host Approval`)
  const toolCallId = String(request.callId)
  await waitFrame(clientB, '[y] Allow once', `${label}: B paints the pending Approval`)
  await resumeSession(clientA, sessionX, `${label}: A enters the pending Session`)
  await waitFrame(clientA, '[y] Allow once', `${label}: A is offered the same Approval`)
  return { host, clientA, clientB, sessionX, sessionY, requestId, toolCallId }
}

async function waitForWork(
  host: SplitProcessHostHandle,
  predicate: (event: WorkEvent) => boolean,
  label: string,
): Promise<WorkEvent> {
  expect(host.workloadRoot, 'the Host has no registered workload root').toBeTypeOf('string')
  return await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!, predicate, label)
}

function expectNoQuestionSettlement(
  scene: SplitProcessScene,
  host: SplitProcessHostHandle,
  sessionId: string,
  workIndex: number,
  eventIndex: number,
  callId: string,
  label: string,
): void {
  expect(workEvents(host).slice(workIndex).some(event =>
    (event.kind === 'question-settled' || event.kind === 'question-failed') && event.sessionId === sessionId),
  `${label}: navigation settled or failed the Host Question`).toBe(false)
  expect(durableEvents(scene, sessionId).slice(eventIndex).some(event =>
    event.type === 'turn/end'
    || (event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId)),
  `${label}: navigation produced Host result activity`).toBe(false)
}

async function answerQuestion(
  scene: SplitProcessScene,
  host: SplitProcessHostHandle,
  client: SplitProcessClient,
  sessionId: string,
  callId: string,
  workIndex: number,
  eventIndex: number,
  label: string,
): Promise<void> {
  await client.type('1')
  await waitFrame(client, 'Review your answer before submit', `${label}: answer review`, 30_000)
  await client.press('Enter')
  const settled = await waitForWorkAfter(host, workIndex,
    event => event.kind === 'question-settled' && event.sessionId === sessionId,
    `${label}: Host Question settlement`)
  expect(settled.answers?.[0]?.selected?.[0], `${label}: answer received at the Host`).toBe('Proceed')
  const result = await scene.waitForSessionEvent(sessionId, eventIndex,
    event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
    `${label}: exact Question tool result`)
  expect(result.data?.message?.isError, `${label}: answered Question failed`).not.toBe(true)
  await scene.waitForSessionEvent(sessionId, eventIndex,
    event => event.type === 'turn/end', `${label}: Question Turn end`)
  expect(workEvents(host).slice(workIndex).filter(event =>
    event.kind === 'question-settled' && event.sessionId === sessionId),
  `${label}: more than one Question settlement`).toHaveLength(1)
  expect(durableEvents(scene, sessionId).slice(eventIndex).filter(event =>
    event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId),
  `${label}: more than one exact Question result`).toHaveLength(1)
}

async function answerApproval(
  scene: SplitProcessScene,
  host: SplitProcessHostHandle,
  client: SplitProcessClient,
  sessionId: string,
  requestId: string,
  toolCallId: string,
  workIndex: number,
  eventIndex: number,
  label: string,
): Promise<void> {
  await client.type('y')
  const decided = await scene.waitForSessionEvent(sessionId, eventIndex,
    event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
    `${label}: exact approval decision`)
  expect(decided.data?.outcome, `${label}: approval outcome`).toBe('allowed-once')
  await waitForWorkAfter(host, workIndex,
    event => event.kind === 'approval-settled' && String(event.callId) === toolCallId
      && event.outcome === 'allowed-once',
    `${label}: Host Approval settlement`)
  const marker = join(host.workloadRoot!, 'approval-allow.marker')
  expect(existsSync(marker), `${label}: allowed command did not run`).toBe(true)
  expect(readFileSync(marker, 'utf8'), `${label}: allowed command marker`).toBe('c1-approval-allow')
  const result = await scene.waitForSessionEvent(sessionId, eventIndex,
    event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolCallId,
    `${label}: Approval tool result`)
  expect(result.data?.message?.isError, `${label}: approved command failed`).not.toBe(true)
  await scene.waitForSessionEvent(sessionId, eventIndex,
    event => event.type === 'turn/end', `${label}: Approval Turn end`)
  expect(durableEvents(scene, sessionId).filter(event =>
    event.type === 'approval/decided' && String(event.data?.id) === requestId),
  `${label}: more than one Approval decision`).toHaveLength(1)
}

// Crosswalk: admitting a Question that arrives while another Session is
// selected is owned by `session-workspace.vitest.ts` ("keeps Session Workspace
// read-only through activity refresh until a Session is opened"), which carries
// the complete pre-arrival hold / selection / no-answer control. Not duplicated
// here; ordinary first-winner and late-editor-key proof stays with its own owner.

test('reoffers the same Question after navigating away without answering', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const { host, clientA, clientB, sessionX, sessionY, callId } =
      await startSharedQuestion(scene, 'question navigation reoffer')
    const workIndex = workEvents(host).length
    const eventIndex = durableEvents(scene, sessionX).length

    await enterNavigationHold(clientA, '[1] Proceed', 'A leaves the pending Question')
    await searchAndCommit(clientA, sessionY, 'A commits the empty Session')
    await waitFrameGone(clientA, '[1] Proceed', 'A committed Session paints no held Question')
    expect(lastSurfaceStatus(clientA)?.openSessionId, 'A did not commit the empty Session').toBe(sessionY)
    expectNoQuestionSettlement(scene, host, sessionX, workIndex, eventIndex, callId,
      'navigating away from the Question')

    // A stale answer key on the other Session stays plain editor text.
    await clientA.type('1')
    await waitForComposerDraft(clientA, '1', 'stale answer key reached the composer')
    await clientA.press('Ctrl+E', 'Ctrl+U')
    await waitForEmptyComposer(clientA, 'stale answer key cleared')
    expect(workEvents(host).slice(workIndex).some(event =>
      event.kind === 'question-request' && event.sessionId === sessionY),
    'the stale key started a Question on the empty Session').toBe(false)
    expectNoQuestionSettlement(scene, host, sessionX, workIndex, eventIndex, callId,
      'stale answer key while another Session is current')

    // Return to X first: only its answerable seat admits Alt+W. Leaving the
    // re-offered presentation again then proves withdrawal before the same
    // live request is genuinely answered.
    await resumeSession(clientA, sessionX, 'A re-enters the pending Session before withdrawal')
    await waitFrame(clientA, '[1] Proceed', 'the same Question is re-offered before withdrawal')
    await enterNavigationHold(clientA, '[1] Proceed', 'A leaves the re-offered Question')
    await searchAndCommit(clientA, sessionY, 'A navigates away again before answering')
    await waitFrameGone(clientA, '[1] Proceed', 'the re-offered Question was withdrawn again')
    await resumeSession(clientA, sessionX, 'A re-enters the pending Session after withdrawal')
    await waitFrame(clientA, '[1] Proceed', 'the same Question is re-offered')
    expect(lastSurfaceStatus(clientA)?.openSessionId, 'A did not re-enter the pending Session').toBe(sessionX)
    expectNoQuestionSettlement(scene, host, sessionX, workIndex, eventIndex, callId,
      'navigation before answering')

    const hostBefore = await hostIdentity(scene, host)
    await answerQuestion(scene, host, clientA, sessionX, callId, workIndex, eventIndex,
      'navigation reoffer answer')
    await waitFrameGone(clientB, '[1] Proceed', 'the other Client lost the one delivery')
    await expectHostIdentityKept(scene, host, hostBefore, 'Question navigation reoffer')
    await exitClientNormally(clientB, 'reoffer B')
    await exitClientNormally(clientA, 'reoffer A')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'Question navigation reoffer')
  }
})

test('reoffers the same Approval after navigating away without deciding it', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const { host, clientA, clientB, sessionX, sessionY, requestId, toolCallId } =
      await startSharedApproval(scene, 'approval navigation reoffer')
    const workIndex = workEvents(host).length
    const eventIndex = durableEvents(scene, sessionX).length
    const yEventsBeforeNavigation = durableEvents(scene, sessionY)
    const marker = join(host.workloadRoot!, 'approval-allow.marker')

    await enterNavigationHold(clientA, '[y] Allow once', 'A leaves the pending Approval')
    await searchAndCommit(clientA, sessionY, 'A commits the empty Session')
    expect(lastSurfaceStatus(clientA)?.openSessionId, 'A did not commit the empty Session').toBe(sessionY)
    await waitFrameGone(clientA, '[y] Allow once', 'A committed Session paints no held Approval')
    expect(durableEvents(scene, sessionX).slice(eventIndex).some(event =>
      event.type === 'approval/decided' && String(event.data?.id) === requestId),
    'navigating away decided the Host Approval').toBe(false)
    expect(durableEvents(scene, sessionX).slice(eventIndex).some(event =>
      event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolCallId),
    'navigating away produced an Approval result').toBe(false)
    expect(existsSync(marker), 'the approved command ran before the human decision').toBe(false)
    expect(durableEvents(scene, sessionY), 'navigating to Y changed its durable log').toEqual(yEventsBeforeNavigation)

    await resumeSession(clientA, sessionX, 'A re-enters the pending Session')
    await waitFrame(clientA, '[y] Allow once', 'the same Approval is re-offered')
    const hostBefore = await hostIdentity(scene, host)
    await answerApproval(scene, host, clientA, sessionX, requestId, toolCallId, workIndex, eventIndex,
      'navigation approval reoffer')
    await waitFrameGone(clientB, '[y] Allow once', 'the other Client lost the one Approval delivery')
    await expectHostIdentityKept(scene, host, hostBefore, 'Approval navigation reoffer')
    await exitClientNormally(clientB, 'approval reoffer B')
    await exitClientNormally(clientA, 'approval reoffer A')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'Approval navigation reoffer')
  }
})

test('does not resurrect a Question settled by the other Client during navigation hold', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const { host, clientA, clientB, sessionX, callId } =
      await startSharedQuestion(scene, 'question peer winner')
    const workIndex = workEvents(host).length
    const eventIndex = durableEvents(scene, sessionX).length

    await enterNavigationHold(clientA, '[1] Proceed', 'A holds navigation on the Question')
    expect(lastSurfaceStatus(clientA)?.openSessionId, 'the hold switched A away from the Session').toBe(sessionX)
    const hostBefore = await hostIdentity(scene, host)
    await answerQuestion(scene, host, clientB, sessionX, callId, workIndex, eventIndex,
      'peer winner while A holds')

    await clientA.press('Escape')
    await waitFrameGone(clientA, 'Sessions ·', 'A released the navigation hold')
    // The persisted authored prompt in A's transcript is the positive control:
    // the absence of an answerable modal below is not an unread frame.
    await waitFrame(clientA, 'question peer winner question seed', 'A reads the settled Session transcript')
    await waitFrameGone(clientA, '[1] Proceed', 'the settled Question did not resurrect')
    expect(lastSurfaceStatus(clientA)?.openSessionId, 'releasing the hold switched A').toBe(sessionX)
    await clientA.type('1')
    await waitForComposerDraft(clientA, '1', 'late answer key reached the composer')
    await clientA.press('Ctrl+E', 'Ctrl+U')
    await waitForEmptyComposer(clientA, 'late answer key cleared')
    expect(workEvents(host).slice(workIndex).filter(event =>
      event.kind === 'question-settled' && event.sessionId === sessionX),
    'A produced a second Question settlement').toHaveLength(1)
    expect(durableEvents(scene, sessionX).filter(event =>
      event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId),
    'A produced a second Question result').toHaveLength(1)
    await expectHostIdentityKept(scene, host, hostBefore, 'Question navigation hold winner')
    await exitClientNormally(clientA, 'question hold loser')
    await exitClientNormally(clientB, 'question hold winner')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'Question navigation hold winner')
  }
})

test('leaves a held navigation Question answerable by the surviving Client after exit', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const { host, clientA, clientB, sessionX, callId } =
      await startSharedQuestion(scene, 'question hold exit')
    const workIndex = workEvents(host).length
    const eventIndex = durableEvents(scene, sessionX).length

    await enterNavigationHold(clientA, '[1] Proceed', 'A exits inside the navigation hold')
    const hostBefore = await hostIdentity(scene, host)
    const signalCut = clientA.readRecords().length
    await clientA.signal('SIGTERM')
    await clientA.waitForRecord(record => record.m4a0 === 'signal' && record.signal === 'SIGTERM',
      'A published the ordinary termination signal')
    expect(clientA.readRecords().slice(signalCut).filter(record =>
      record.m4a0 === 'signal' && record.signal === 'SIGTERM')).toHaveLength(1)
    expect(await clientA.waitForExit()).toMatchObject({ code: 0, signal: null })
    await clientA.close()

    await expectHostIdentityKept(scene, host, hostBefore, 'Question navigation hold exit')
    expectNoQuestionSettlement(scene, host, sessionX, workIndex, eventIndex, callId,
      'Client exit during a navigation hold')
    await waitFrame(clientB, '[1] Proceed', 'the surviving Client still owns the answerable Question')
    await answerQuestion(scene, host, clientB, sessionX, callId, workIndex, eventIndex,
      'surviving Client answer')
    await exitClientNormally(clientB, 'question hold survivor')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'Question navigation hold exit')
  }
})

test('does not reoffer a cancelled Approval when navigation hold is released', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const { host, clientA, clientB, sessionX, requestId } =
      await startSharedApproval(scene, 'approval cancellation hold', { cancelAgent: true })
    const workIndex = workEvents(host).length
    const eventIndex = durableEvents(scene, sessionX).length
    const marker = join(host.workloadRoot!, 'approval-allow.marker')

    await enterNavigationHold(clientA, '[y] Allow once', 'A holds navigation on the Approval')
    releaseFile(host.cancelAgentBarrierPath, 'official Agent cancel during the hold')
    await waitForWorkAfter(host, workIndex,
      event => event.kind === 'agent-cancel-requested', 'Host Agent cancel request')
    const decided = await scene.waitForSessionEvent(sessionX, eventIndex,
      event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
      'cancelled approval/decided')
    expect(decided.data?.outcome, 'cancelled Approval outcome').toBe('cancelled')

    await clientA.press('Escape')
    await waitFrameGone(clientA, 'Sessions ·', 'A released the navigation hold')
    await waitFrameGone(clientA, '[y] Allow once', 'the cancelled Approval did not return')
    await waitFrameGone(clientB, '[y] Allow once', 'the other Client lost the withdrawn sheet')
    await clientA.type('y')
    await waitForComposerDraft(clientA, 'y', 'late allow key reached the composer')
    await clientA.press('Ctrl+E', 'Ctrl+U')
    await waitForEmptyComposer(clientA, 'late allow key cleared')
    expect(existsSync(marker), 'a stale key executed the approved command').toBe(false)
    expect(durableEvents(scene, sessionX).filter(event =>
      event.type === 'approval/decided' && String(event.data?.id) === requestId),
    'the cancelled Approval was decided more than once').toHaveLength(1)
    await exitClientNormally(clientA, 'cancelled approval hold')
    await exitClientNormally(clientB, 'cancelled approval peer')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'Approval cancellation hold')
  }
})
