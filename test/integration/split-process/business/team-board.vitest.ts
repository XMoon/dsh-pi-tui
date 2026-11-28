import { mkdirSync } from 'node:fs'
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

// Byte-exact prompt and subject literals owned by scripts/fixtures/split-process-host-work.mjs.
// Its legacy constants FR8_TEAM_CREATE / FR8_TEAM_UPDATE / FR8_BOARD_TASK are
// the existing fixture consumers; their values stay unchanged and carry
// business names here. The task id and revision come only from official results.
const createTaskMarker = 'FR8_TEAM_CREATE'
const updateTaskMarker = 'FR8_TEAM_UPDATE'
const boardTaskSubject = 'FR8_BOARD_TASK'

const fixtureHelpers = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-fixtures.mjs')).href
) as {
  readC1WorkEvents(root: string): WorkEvent[]
  waitForC1WorkEvent(root: string, predicate: (event: WorkEvent) => boolean, label: string, timeoutMs?: number): Promise<WorkEvent>
}

function clientDirectories(scene: SplitProcessScene, label: string): { home: string; cwd: string } {
  const root = join(scene.workDir, 'clients', label)
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  return { home, cwd }
}

async function waitFrame(
  client: SplitProcessClient,
  needles: string | readonly string[],
  label: string,
  timeoutMs = 120_000,
): Promise<string> {
  const wanted = typeof needles === 'string' ? [needles] : needles
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (wanted.some(needle => frame.includes(needle))) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: ${JSON.stringify(wanted)} was not painted; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(25)
  }
}

async function waitFrameGone(client: SplitProcessClient, text: string, label: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (!(await client.text()).includes(text)) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: ${JSON.stringify(text)} stayed painted`)
    }
    await sleep(25)
  }
}

async function waitFrameChange(client: SplitProcessClient, previous: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (!frame.includes('Tasks ·') || frame !== previous) return
    if (Date.now() - started >= timeoutMs) return
    await sleep(25)
  }
}

function messageText(message: Record<string, any> | undefined): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => typeof part?.text === 'string' ? part.text : '').join('')
}

function lastTeamModeEnabled(events: SessionEvent[]): unknown {
  return events.filter(event => event.type === 'team/mode').at(-1)?.data?.enabled
}

async function waitTeamTaskRow(client: SplitProcessClient, label: string): Promise<string> {
  const started = Date.now()
  for (;;) {
    const row = (await client.text()).split('\n').find(line => line.includes('│')
      && line.includes(boardTaskSubject) && line.includes('in_progress') && line.includes('· lead'))
    if (row !== undefined) return row
    if (Date.now() - started >= 120_000) {
      throw new Error(`${label}: no single painted Team row carried subject, status and owner`)
    }
    await sleep(25)
  }
}

async function openSeededSession(
  scene: SplitProcessScene,
  client: SplitProcessClient,
  prompt: string,
  label: string,
): Promise<string> {
  const before = new Set(await scene.sessionIds())
  await client.submit(prompt)
  const sessionId = await scene.waitForNewSessionId(before, `${label}: Session creation`)
  await scene.waitForHostSessionHeader(sessionId, `${label}: Session header`)
  await client.waitForSurfaceStatus(
    record => record.sessionOpen === true && record.openSessionId === sessionId,
    `${label}: exact Session surface`,
  )
  await scene.waitForSessionEvent(sessionId, 0,
    event => event.type === 'turn/end', `${label}: seed Turn end`)
  return sessionId
}

async function disposeScene(scene: SplitProcessScene, primary: unknown): Promise<void> {
  try {
    await scene.dispose()
  } catch (cleanupError) {
    if (primary !== undefined) {
      throw new AggregateError([primary, cleanupError], 'team board failed and Scene cleanup also failed')
    }
    throw cleanupError
  }
}

test('projects an updated Team task through the read-only board', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  try {
    host = await scene.startHost({ scenario: 'team-board' })
    client = await scene.startClient({
      label: 'team-board-projection',
      ...clientDirectories(scene, 'team-board-projection'),
    })
    const sessionId = await openSeededSession(scene, client, 'team board seed turn', 'team board')
    const initialEvents = scene.sessionEvents(sessionId) ?? []
    expect(initialEvents.filter(event => event.type === 'team/mode'),
      'team board: no durable Team mode before the user gesture').toHaveLength(0)

    // The real /model Team zone; no seeded mode and no internal write route.
    await client.submit('/model')
    await waitFrame(client, ['Agent Team', 'Tab Team'], 'team board: /model Team row')
    await client.press('Tab')
    await waitFrame(client, 'Toggle [Enter]', 'team board: painted Team zone')
    await client.press('Enter')
    await scene.waitForSessionEvent(sessionId, 0,
      event => event.type === 'team/mode' && event.data?.enabled === true,
      'team board: durable Team enablement')
    await waitFrame(client, '[On]', 'team board: saved On is read back')
    await client.press('Escape')
    await waitFrame(client, 'Tab Team', 'team board: back to the model list')
    await client.press('Escape')
    await waitFrameGone(client, 'Tab Team', 'team board: model picker closed')

    const createCut = scene.sessionEvents(sessionId)?.length ?? 0
    await client.submit(`Create the shared task ${createTaskMarker}`)
    const createCall = await scene.waitForSessionEvent(sessionId, createCut,
      event => event.type === 'tool/call' && event.data?.name === 'team_task_create',
      'team board: official team_task_create call')
    const createCallId = String(createCall.data?.callId)
    const createdEvent = await scene.waitForSessionEvent(sessionId, createCut,
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === createCallId,
      'team board: official team_task_create result')
    expect(createdEvent.data?.message?.isError, 'team board: create succeeded').not.toBe(true)
    const created = JSON.parse(messageText(createdEvent.data?.message))
    expect(created.id, 'team board: created task carries an official id').toBeTypeOf('string')
    expect(created.id, 'team board: created task id is nonempty').not.toBe('')
    expect(created.subject, 'team board: authored task subject').toBe(boardTaskSubject)
    expect(created.status, 'team board: new task starts pending').toBe('pending')
    expect(created.revision, 'team board: new task starts at revision 1').toBe(1)

    const updateCut = scene.sessionEvents(sessionId)?.length ?? 0
    await client.submit(`Reassign the shared task ${updateTaskMarker}`)
    const updateCall = await scene.waitForSessionEvent(sessionId, updateCut,
      event => event.type === 'tool/call' && event.data?.name === 'team_task_update',
      'team board: official team_task_update call')
    const updateArguments = JSON.parse(String(updateCall.data?.arguments ?? ''))
    expect(updateArguments.task_id, 'team board: update addresses the created task').toBe(created.id)
    expect(updateArguments.expected_revision, 'team board: update uses the official revision')
      .toBe(created.revision)
    expect(updateArguments.action, 'team board: official reassign action').toBe('reassign')
    expect(updateArguments.owner, 'team board: official owner name').toBe('lead')
    const updateCallId = String(updateCall.data?.callId)
    const updatedEvent = await scene.waitForSessionEvent(sessionId, updateCut,
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === updateCallId,
      'team board: official team_task_update result')
    expect(updatedEvent.data?.message?.isError, 'team board: update succeeded').not.toBe(true)
    const updated = JSON.parse(messageText(updatedEvent.data?.message))
    expect(updated.id, 'team board: the same task was updated').toBe(created.id)
    expect(updated.revision, 'team board: the official revision advanced exactly once')
      .toBe(created.revision + 1)
    expect(updated.status, 'team board: reassigned task is in progress').toBe('in_progress')
    expect(updated.owner, 'team board: reassigned task owner').toBe('lead')

    // The fixture only observes the official agentTeam projection after a Team
    // write; the durable tool results above remain the write authority.
    expect(host.workloadRoot, 'team board: Host has no workload root').toBeTypeOf('string')
    const projected = await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!,
      event => event.kind === 'team-projection' && event.sessionId === sessionId
        && event.tasks?.some((task: WorkEvent) => task.id === updated.id
          && task.revision === updated.revision),
      'team board: official projection carries the updated task')
    const projectedTask = (projected.tasks as WorkEvent[]).find(task => task.id === updated.id)!
    expect(projectedTask.subject, 'team board: projection subject').toBe(boardTaskSubject)
    expect(projectedTask.status, 'team board: projection status').toBe('in_progress')
    expect(projectedTask.ownerName, 'team board: projection owner').toBe('lead')

    const boardCut = scene.sessionEvents(sessionId)?.length ?? 0
    await client.submit('/tasks')
    await waitFrame(client, 'Tasks · [Work]', 'team board: Tasks Work tab')
    await client.press('Tab')
    await waitFrame(client, 'Tasks · Work  [Team]', 'team board: Tasks Team tab')
    await waitFrame(client, 'Agent Team: On (read-only)', 'team board: own read-only Team page')
    await waitTeamTaskRow(client, 'team board')
    const page = await client.text()
    const panelRows = page.split('\n').filter(line => line.includes('│')).join('\n')
    expect(panelRows, 'team board: no invented internal revision column').not.toMatch(/\brev\b/u)
    expect(panelRows, 'team board: no claim/assign/complete write verb')
      .not.toMatch(/\b(claim|assign|complete)\b/iu)
    expect(page, 'team board: the current Team page reads On').toContain('Agent Team: On (read-only)')
    await client.press('Escape')
    await waitFrameGone(client, 'Tasks ·', 'team board: Tasks panel closed')
    expect((scene.sessionEvents(sessionId) ?? []).slice(boardCut).some(event =>
      event.type === 'team/task' || event.type === 'team/mode' || event.type === 'tool/call'),
    'team board: opening and closing the board wrote no Host fact').toBe(false)

    // A fresh independent Session on the SAME Client carries its own board.
    const beforeSecond = new Set(await scene.sessionIds())
    await client.submit('/new')
    const secondSession = await scene.waitForNewSessionId(beforeSecond, 'team board: second Session creation')
    expect(secondSession, 'team board: second Session has a distinct identity').not.toBe(sessionId)
    await scene.waitForHostSessionHeader(secondSession, 'team board: second Session header')
    await client.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === secondSession,
      'team board: exact second Session surface',
    )
    await client.submit('team board second session seed')
    await scene.waitForSessionEvent(secondSession, 0,
      event => event.type === 'turn/end', 'team board: second Session seed Turn end')
    await client.submit('/tasks')
    await waitFrame(client, 'Tasks · [Work]', 'team board: second Session Work tab')
    await client.press('Tab')
    await waitFrame(client, 'Tasks · Work  [Team]', 'team board: second Session Team tab')
    await waitFrame(client, 'Team is Off · Enable it from /model',
      'team board: second Session paints its own Off board')
    const secondPage = await client.text()
    expect(secondPage, 'team board: the shared task never leaks into the second Session')
      .not.toContain(boardTaskSubject)
    expect(secondPage, 'team board: no shared status row in the second Session')
      .not.toContain('in_progress')

    // The projection observer records only on a Team write, so an absent or
    // empty projection does NOT prove global Team emptiness; it must not
    // contradict the painted board of this exact Session.
    const secondProjection = fixtureHelpers.readC1WorkEvents(host.workloadRoot!)
      .filter(event => event.kind === 'team-projection' && event.sessionId === secondSession).at(-1)
    expect(secondProjection === undefined || secondProjection.tasks.length === 0,
      'team board: second Session projection carries no shared task').toBe(true)
    const secondEvents = scene.sessionEvents(secondSession) ?? []
    expect(secondEvents.filter(event => event.type === 'team/mode'),
      'team board: no Team mode write on the second Session').toHaveLength(0)
    expect(secondEvents.filter(event => event.type === 'tool/call'
      && (event.data?.name === 'team_task_create' || event.data?.name === 'team_task_update')),
    'team board: no Team task write on the second Session').toHaveLength(0)
    const firstEvents = scene.sessionEvents(sessionId) ?? []
    expect(lastTeamModeEnabled(firstEvents), 'team board: the first Session stays Team On').toBe(true)
    expect(firstEvents.filter(event => event.type === 'tool/result'
      && String(event.data?.message?.toolCallId) === updateCallId),
    'team board: the first Session keeps one update result').toHaveLength(1)

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const frame = await client.text()
      if (!frame.includes('Tasks ·')) break
      await client.press('Escape')
      await waitFrameChange(client, frame)
    }
    expect((await client.text()).includes('Tasks ·'),
      'team board: the second Tasks panel closed before exit').toBe(false)

    await client.exitGracefully()
    const exit = await client.close()
    expect(exit.code, 'team board: native Client exit code').toBe(0)
    expect(exit.signal, 'team board: native Client exit signal').toBeNull()
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary)
  }
})
