import { mkdirSync } from 'node:fs'
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

/** Two plain Left presses must land inside the editor's frozen 600ms latch window. */
const LEFT_GESTURE_GAP_MS = 100

function clientDirectories(scene: SplitProcessScene, label: string): { home: string; cwd: string } {
  const home = join(scene.workDir, 'clients', label, 'home')
  // Distinct Client homes, one shared Host workspace: the sibling Session must
  // be a real row of the same grouped Session Workspace.
  const cwd = join(scene.workDir, 'client-workspace')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  return { home, cwd }
}

function shortSessionId(id: string): string {
  return id.replace(/^session[-_]/i, '').slice(0, 8)
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
  // Only a stable prefix survives the composer's ellipsis truncation; the exact
  // committed text is proved by the durable occurrence below.
  await waitForComposerPrefix(client, prompt.slice(0, 8), `${label}: authored prompt in the composer`)
  await client.press('Enter')
  await scene.waitForSessionEvent(sessionId, cut,
    event => event.type === 'user/message' && Array.isArray(event.data?.content)
      && event.data.content.some((part: Record<string, any>) => part?.text === prompt),
    `${label}: exact authored occurrence`)
  return cut
}

async function waitFrame(
  client: SplitProcessClient,
  text: string,
  label: string,
  timeoutMs = 120_000,
): Promise<string> {
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

async function waitFramePredicate(
  client: SplitProcessClient,
  predicate: (frame: string) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (predicate(frame)) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: no matching painted frame; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(25)
  }
}

function sessionRow(frame: string, sessionId: string): string | undefined {
  return frame.split('\n').find(line => line.includes(shortSessionId(sessionId)))
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

/** An empty editor paints its `……` placeholder, never an empty string. */
async function waitForEmptyComposer(client: SplitProcessClient, label: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    const draft = composerDraft(await client.text())
    if (draft === undefined || draft === '' || /^…{1,2}$/u.test(draft)) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: composer draft was still ${JSON.stringify(draft)}`)
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
    if (Date.now() - started >= timeoutMs) throw new Error(`${label}: no fresh matching Host fixture event`)
    await sleep(25)
  }
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

async function openWorkspace(client: SplitProcessClient, label: string): Promise<void> {
  // Alt+W is the Question/Approval seat chord, not an editor chord. The plan
  // admits the real /sessions command for the initial workspace entry.
  await client.press('Ctrl+U')
  await waitForEmptyComposer(client, `${label}: command draft cleared`)
  await client.submit('/sessions')
  await waitFrame(client, 'Sessions ·', `${label}: Session Workspace opened`, 30_000)
}

async function focusSearchResult(client: SplitProcessClient, sessionId: string, label: string): Promise<void> {
  await client.press('/')
  await waitFrame(client, 'Search all workspaces', `${label}: search entered`, 30_000)
  // Re-entering search preserves the previous query. Clear it through the real
  // editor before typing the new full id, or two visits append into `idid`.
  await client.press('Ctrl+U')
  await waitFrameGone(client, sessionId, `${label}: previous search query cleared`, 30_000)
  await client.type(sessionId)
  // The first Enter only focuses the first result row; it never resumes it.
  await client.press('Enter')
  await waitFrame(client, `> ${shortSessionId(sessionId)}`, `${label}: result row focused`, 60_000)
}

async function leaveSearchToBrowse(client: SplitProcessClient, label: string): Promise<void> {
  // The state machine has a direct, non-Esc path: from `search-results`,
  // Backspace returns focus to the Search editor (handleResultsInput); from
  // `search`, Shift+Tab calls leaveSearch() -> focus 'list'
  // (handleSearchInput). Neither key can close the Workspace, so a late-arriving
  // forwarded Question can never steal a `/sessions` command in another seat.
  await client.press('Backspace')
  await waitFramePredicate(client,
    frame => frame.includes('Search all workspaces') && frame.includes('Results [Enter]'),
    `${label}: search editor regained focus`, 30_000)
  await client.press('Shift+Tab')
  await waitFramePredicate(client,
    frame => frame.includes('Up/Down move') && frame.includes('/ search')
      && frame.includes('Close [Esc]'),
    `${label}: Shift+Tab restored the browse list`, 30_000)
}

async function triggerQuestion(
  scene: SplitProcessScene,
  host: SplitProcessHostHandle,
  client: SplitProcessClient,
  sessionId: string,
  prompt: string,
  label: string,
): Promise<string> {
  const cut = await submitAuthoredPrompt(scene, client, sessionId, prompt, label)
  const call = await scene.waitForSessionEvent(sessionId, cut,
    event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
    `${label}: question tool/call`)
  const callId = String(call.data?.callId)
  expect(callId, `${label}: question call identity`).not.toBe('')
  expect(host.workloadRoot, 'the Host has no registered workload root').toBeTypeOf('string')
  await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!,
    event => event.kind === 'question-request' && event.sessionId === sessionId,
    `${label}: pending Host Question`)
  await waitFrame(client, '[1] Proceed', `${label}: answerable Question painted`)
  return callId
}

function expectNoInteractionSettlement(
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
  `${label}: read-only observation settled the Host Question`).toBe(false)
  expect(durableEvents(scene, sessionId).slice(eventIndex).some(event =>
    event.type === 'turn/end' || event.type === 'approval/decided'
    || (event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId)),
  `${label}: read-only observation produced Host activity`).toBe(false)
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
}

test('keeps Session Workspace read-only through activity refresh until a Session is opened', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'question' })
    const clientA = await scene.startClient({ label: 'workspace-reader-a', ...clientDirectories(scene, 'workspace-reader-a') })
    const sessionY = await openEmptySession(scene, clientA, 'A empty Session')
    const clientB = await scene.startClient({ label: 'workspace-reader-b', ...clientDirectories(scene, 'workspace-reader-b') })
    const sessionX = await openEmptySession(scene, clientB, 'B own Session')

    await openWorkspace(clientA, 'A opens the Session Workspace')
    await waitFramePredicate(clientA, frame => {
      const lines = frame.split('\n')
      return sessionRow(frame, sessionX) !== undefined && sessionRow(frame, sessionY) !== undefined
        && lines.some(line => line.includes('▾') || line.includes('▸'))
    }, 'the grouped official Workspace lists both Sessions')
    await focusSearchResult(clientA, sessionX, 'A selects the sibling Session in search')
    expect(lastSurfaceStatus(clientA)?.openSessionId, 'opening the Workspace switched A').toBe(sessionY)
    const workIndex = workEvents(host).length
    const eventIndex = durableEvents(scene, sessionX).length

    // Real carrier loss while the Workspace stays open: neither the committed
    // Session nor the freshly painted cursor may be repaired by a shortcut.
    const generationBefore = lastSurfaceStatus(clientA)?.generationId
    expect(generationBefore, 'A had no connected generation before the carrier drop').toBeTypeOf('number')
    await clientA.signal('SIGUSR1')
    await clientA.waitForSurfaceStatus(record => record.transport === 'connected'
      && typeof record.generationId === 'number' && record.generationId !== generationBefore,
    'A reconnected on a new generation with the Workspace open')
    await waitFramePredicate(clientA,
      frame => frame.includes('Search all workspaces')
        && frame.includes(`> ${shortSessionId(sessionX)}`)
        && !frame.includes('Workspace membership unavailable'),
    'the recovered Workspace kept the focused result row and no revocation')
    expect(lastSurfaceStatus(clientA)?.openSessionId, 'the carrier recovery switched A').toBe(sessionY)

    // The Question arrives AFTER the selection is held and the carrier is
    // recovered: this is the admission-after-selection proof, not a re-offer.
    const callId = await triggerQuestion(scene, host, clientB, sessionX,
      'workspace activity question seed', 'late Question arrival')
    await waitFramePredicate(clientA,
      frame => frame.includes(`> ${shortSessionId(sessionX)}`) && !frame.includes('[1] Proceed'),
      'the search selection stayed on X with no answerable modal')
    // The grouped Needs fact belongs to the browse tree: use the panel's direct
    // Backspace -> Shift+Tab state transition, prove the exact X/Y rows while
    // the Workspace remains open, then refocus the same result row.
    await leaveSearchToBrowse(clientA, 'A returns to browse for the grouped fact')
    await waitFramePredicate(clientA, frame => {
      const lines = frame.split('\n')
      return sessionRow(frame, sessionX)?.includes('Needs attention') === true
        && sessionRow(frame, sessionY) !== undefined
        && lines.some(line => line.includes('▾') || line.includes('▸'))
        && !frame.includes('[1] Proceed')
    }, 'the grouped X Needs row and independent Y row stayed painted')
    await focusSearchResult(clientA, sessionX, 'A refocuses X after the grouped fact')
    expect(lastSurfaceStatus(clientA)?.openSessionId, 'the late arrival moved A off its Session').toBe(sessionY)
    expectNoInteractionSettlement(scene, host, sessionX, workIndex, eventIndex, callId,
      'late Question arrival while a different Session is selected')

    // Space pins the committed-transcript Reader to the selected row.
    await clientA.press('Space')
    await waitFrame(clientA, `Transcript · ${shortSessionId(sessionX)}`, 'pinned Reader header')
    await waitFrame(clientA, 'workspace activity question seed', 'Reader body holds X committed history')
    await waitFrame(clientA, 'Read-only', 'Reader states its read-only provenance')
    await clientA.press('Enter')
    await waitFrame(clientA, `Transcript · ${shortSessionId(sessionX)}`, 'Enter stays inert in the Reader')
    expect(lastSurfaceStatus(clientA)?.openSessionId, 'Enter resumed a Session from the Reader').toBe(sessionY)
    expectNoInteractionSettlement(scene, host, sessionX, workIndex, eventIndex, callId, 'Enter inside the Reader')
    await clientA.press('Space')
    await waitFrameGone(clientA, 'Transcript ·', 'Space closed the Reader back to the list')

    // F2 pins the read-only Inspector to the same typed row.
    await clientA.press('F2')
    await waitFrame(clientA, 'Session Inspector', 'pinned Inspector page')
    await waitFrame(clientA, shortSessionId(sessionX), 'Inspector names the same Session')
    for (const key of ['Enter', 'Space', 'F2'] as const) {
      await clientA.press(key)
      await waitFrame(clientA, 'Session Inspector', `${key} stays inert in the Inspector`)
    }
    expect(lastSurfaceStatus(clientA)?.openSessionId, 'an Inspector key resumed a Session').toBe(sessionY)
    expectNoInteractionSettlement(scene, host, sessionX, workIndex, eventIndex, callId, 'keys inside the Inspector')
    await clientA.press('Escape')
    await waitFrameGone(clientA, 'Session Inspector', 'Esc returned from the Inspector to the list')

    // Only the committed result-row Enter opens X and admits the same Question.
    await clientA.press('Enter')
    await clientA.waitForSurfaceStatus(record => record.sessionOpen === true && record.openSessionId === sessionX,
      'the selected Session was opened')
    await waitFrame(clientA, '[1] Proceed', 'the same Question is offered after the row open')
    expectNoInteractionSettlement(scene, host, sessionX, workIndex, eventIndex, callId,
      'committing the Workspace row')
    const hostBefore = await hostIdentity(scene, host)
    await answerQuestion(scene, host, clientA, sessionX, callId, workIndex, eventIndex,
      'answer after Session selection')
    await waitFrameGone(clientB, '[1] Proceed', 'the other Client lost the one delivery')
    await expectHostIdentityKept(scene, host, hostBefore, 'Workspace read-only observation')
    await exitClientNormally(clientA, 'workspace reader A')
    await exitClientNormally(clientB, 'workspace reader B')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'Workspace read-only observation')
  }
})

test('opens Session Workspace from an empty editor but preserves a nonempty draft', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const host = await scene.startHost({ scenario: 'question' })
    const clientA = await scene.startClient({ label: 'workspace-entry-a', ...clientDirectories(scene, 'workspace-entry-a') })
    const sessionY = await openEmptySession(scene, clientA, 'A empty Session')
    const clientB = await scene.startClient({ label: 'workspace-entry-b', ...clientDirectories(scene, 'workspace-entry-b') })
    const sessionX = await openEmptySession(scene, clientB, 'B own Session')
    const callId = await triggerQuestion(scene, host, clientB, sessionX,
      'workspace editor question seed', 'peer Question')

    await waitForEmptyComposer(clientA, 'A starts with a strictly empty editor draft')
    const workIndex = workEvents(host).length
    const eventIndex = durableEvents(scene, sessionX).length

    // Two distinct real Left presses, not one combined key chunk.
    await clientA.press('Left')
    await sleep(LEFT_GESTURE_GAP_MS)
    await clientA.press('Left')
    await waitFrame(clientA, 'Sessions ·', 'two Lefts opened the Session Workspace')
    await waitFramePredicate(clientA,
      frame => sessionRow(frame, sessionX)?.includes('Needs attention') === true
        && sessionRow(frame, sessionY) !== undefined && !frame.includes('[1] Proceed'),
      'the empty-editor entry shows the sibling Needs row without a modal')
    expect(lastSurfaceStatus(clientA)?.openSessionId, 'the Left gesture switched A').toBe(sessionY)

    await clientA.press('Escape')
    await waitFrameGone(clientA, 'Sessions ·', 'Esc restored the main editor')
    await waitForEmptyComposer(clientA, 'the main editor draft stayed empty')
    expect(lastSurfaceStatus(clientA)?.openSessionId, 'Esc switched A away from its Session').toBe(sessionY)
    await waitFrame(clientB, '[1] Proceed', 'the peer Question survived the Workspace open and close')

    await clientA.type('keep this draft')
    await waitForComposerDraft(clientA, 'keep this draft', 'exact nonempty draft typed into the editor')
    await clientA.press('Left')
    await sleep(LEFT_GESTURE_GAP_MS)
    await clientA.press('Left')
    await waitForComposerDraft(clientA, 'keep this draft', 'two Lefts preserved the exact draft')
    expect((await clientA.text()).includes('Sessions ·'), 'a nonempty draft opened the Workspace').toBe(false)
    // Prove the editor still owns the keyboard after the refused gesture.
    await clientA.press('End')
    await clientA.type('!')
    await waitForComposerDraft(clientA, 'keep this draft!', 'the editor still accepted typed input')
    await clientA.press('Ctrl+E', 'Ctrl+U')
    await waitForEmptyComposer(clientA, 'the draft was cleared in the editor, not submitted')

    // Liveness control: a fresh empty draft can still open the Workspace.
    await clientA.press('Left')
    await sleep(LEFT_GESTURE_GAP_MS)
    await clientA.press('Left')
    await waitFrame(clientA, 'Sessions ·', 'the cleared draft reopened the Workspace')
    await clientA.press('Escape')
    await waitFrameGone(clientA, 'Sessions ·', 'the reopened Workspace closed again')

    expectNoInteractionSettlement(scene, host, sessionX, workIndex, eventIndex, callId,
      'Workspace entry and draft controls')
    expect(durableEvents(scene, sessionY).some(event =>
      event.type === 'user/message' || event.type === 'turn/start'),
    'the draft gesture submitted a prompt').toBe(false)
    const hostBefore = await hostIdentity(scene, host)
    await answerQuestion(scene, host, clientB, sessionX, callId, workIndex, eventIndex,
      'peer answer after draft controls')
    await waitFrameGone(clientB, '[1] Proceed', 'the peer Question was withdrawn after its answer')
    expect((await clientA.text()).includes('workspace editor question seed'),
      'the other Session leaked into A\'s editor').toBe(false)
    await expectHostIdentityKept(scene, host, hostBefore, 'Workspace editor entry')
    await exitClientNormally(clientB, 'workspace entry B')
    await exitClientNormally(clientA, 'workspace entry A')
    await expectHostIdentityKept(scene, host, hostBefore, 'Workspace editor entry after exits')
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, 'Workspace editor entry')
  }
})
