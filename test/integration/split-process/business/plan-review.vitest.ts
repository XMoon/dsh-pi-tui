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

// Byte-exact prompt literals owned by scripts/fixtures/split-process-host-work.mjs.
// Its legacy constants FR8_PLAN_APPROVE / FR8_PLAN_KEEP / FR8_PLAN_NEXT_STEP and
// the plan body's FR8_PLAN_TAIL_END are the existing fixture consumers; their
// values stay unchanged and carry business names here.
const approvePlanMarker = 'FR8_PLAN_APPROVE'
const keepPlanMarker = 'FR8_PLAN_KEEP'
const nextStepPlanMarker = 'FR8_PLAN_NEXT_STEP'
const planTailMarker = 'FR8_PLAN_TAIL_END'

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
    if ((await client.text()) !== previous) return
    if (Date.now() - started >= timeoutMs) return
    await sleep(25)
  }
}

/** Return from a painted plan seat to the composer before a normal /exit. */
async function leavePlanSeat(client: SplitProcessClient, label: string): Promise<void> {
  const seatMarkers = ['Plan review ·', 'Request changes', 'Reading the submitted plan', 'Full review text']
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const frame = await client.text()
    if (!seatMarkers.some(marker => frame.includes(marker))) return
    await client.press('Escape')
    await waitFrameChange(client, frame)
  }
  const frame = await client.text()
  expect(seatMarkers.some(marker => frame.includes(marker)),
    `${label}: the plan seat is still painted before exit`).toBe(false)
}

/** Scroll the real read-only plan viewport until its authored tail is painted. */
async function revealPlanTail(client: SplitProcessClient, label: string): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const before = await client.text()
    if (before.includes(planTailMarker)) return
    await client.press('PageDown')
    // A bounded repaint observation: a clamped scroll paints an unchanged frame,
    // which means the tail is already at the viewport edge.
    const started = Date.now()
    while (Date.now() - started < 1000) {
      const current = await client.text()
      if (current.includes(planTailMarker)) return
      if (current !== before) break
      await sleep(25)
    }
  }
  throw new Error(`${label}: the reviewed plan tail was not reachable in the read-only viewport`)
}

function messageText(message: Record<string, any> | undefined): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => typeof part?.text === 'string' ? part.text : '').join('')
}

function eventIndex(events: SessionEvent[], event: SessionEvent, label: string): number {
  const seq = (event as SessionEvent & { seq?: unknown }).seq
  expect(seq, `${label}: durable event carries no sequence`).toBeTypeOf('number')
  const index = events.findIndex(candidate => (candidate as SessionEvent & { seq?: unknown }).seq === seq)
  expect(index, `${label}: durable event is missing from the cut`).toBeGreaterThanOrEqual(0)
  return index
}

function lastPlanMode(events: SessionEvent[]): unknown {
  return events.filter(event => event.type === 'plan/mode').at(-1)?.data?.active
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

async function enterPlanMode(
  scene: SplitProcessScene,
  client: SplitProcessClient,
  sessionId: string,
  label: string,
): Promise<void> {
  const before = scene.sessionEvents(sessionId)?.length ?? 0
  await client.submit('/plan')
  await scene.waitForSessionEvent(sessionId, before,
    event => event.type === 'plan/mode' && event.data?.active === true, `${label}: durable plan mode active`)
}

async function disposeScene(
  scene: SplitProcessScene,
  primary: unknown,
  client: SplitProcessClient | undefined,
): Promise<void> {
  try {
    // A failed case can leave a plan decision/feedback/reading seat painted;
    // /exit only reaches the main composer after those visible seats close.
    if (client !== undefined && !client.closed) await leavePlanSeat(client, 'cleanup')
    await scene.dispose()
  } catch (cleanupError) {
    if (primary !== undefined) {
      throw new AggregateError([primary, cleanupError], 'plan review failed and Scene cleanup also failed')
    }
    throw cleanupError
  }
}

test('approves a reviewed plan only after returning from its read-only view', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  try {
    host = await scene.startHost({ scenario: 'plan-review' })
    client = await scene.startClient({
      label: 'plan-approve-review',
      ...clientDirectories(scene, 'plan-approve-review'),
    })
    const sessionId = await openSeededSession(scene, client, 'plan review seed turn', 'plan approve')
    await enterPlanMode(scene, client, sessionId, 'plan approve')

    const reviewCut = scene.sessionEvents(sessionId)?.length ?? 0
    await client.submit(`Review the plan ${approvePlanMarker}`)
    const call = await scene.waitForSessionEvent(sessionId, reviewCut,
      event => event.type === 'tool/call' && event.data?.name === 'exit_plan_mode',
      'plan approve: official exit_plan_mode call')
    const callId = String(call.data?.callId)
    expect(callId, 'plan approve: call identity').not.toBe('')
    expect(String(call.data?.arguments ?? ''), 'plan approve: reviewed plan tail is the official argument')
      .toContain(planTailMarker)
    await waitFrame(client, 'Plan review', 'plan approve: decision seat')

    const beforeView = scene.sessionEvents(sessionId)?.length ?? 0
    const viewAction = ['> View plan', '> View review text'] as const
    await waitFrame(client, viewAction, 'plan approve: painted read-only action row')
    await client.press('Enter')
    await waitFrame(client, ['Reading the submitted plan', 'Full review text'],
      'plan approve: read-only plan viewport')
    await revealPlanTail(client, 'plan approve')
    await client.press('Escape')
    await waitFrame(client, viewAction, 'plan approve: returned to the decision list')

    const afterReading = scene.sessionEvents(sessionId) ?? []
    expect(afterReading.slice(beforeView).some(event => event.type === 'tool/result'
      && String(event.data?.message?.toolCallId) === callId),
    'plan approve: reading and Esc settled no tool result').toBe(false)
    expect(afterReading.slice(beforeView).some(event => event.type === 'plan/mode'),
    'plan approve: reading and Esc did not leave plan mode').toBe(false)

    await client.press('Down')
    await waitFrame(client, '> Keep planning', 'plan approve: painted Keep row')
    await client.press('Down')
    await waitFrame(client, '> Approve plan', 'plan approve: painted Approve row')
    await client.press('Enter')

    const result = await scene.waitForSessionEvent(sessionId, beforeView,
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
      'plan approve: official approve result')
    expect(result.data?.message?.isError, 'plan approve: approved result is not a tool error').not.toBe(true)
    expect(messageText(result.data?.message), 'plan approve: approved result content').toContain('Plan approved')

    const events = scene.sessionEvents(sessionId) ?? []
    const resultIndex = eventIndex(events, result, 'plan approve result')
    const modeOff = await scene.waitForSessionEvent(sessionId, resultIndex + 1,
      event => event.type === 'plan/mode' && event.data?.active === false,
      'plan approve: plan mode off in a later accepted pre-step')
    const afterModeOff = scene.sessionEvents(sessionId) ?? []
    const offIndex = eventIndex(afterModeOff, modeOff, 'plan approve mode-off')
    expect(afterModeOff.slice(resultIndex + 1, offIndex).some(event => event.type === 'step/end'),
      'plan approve: a step boundary separates the result from the mode write').toBe(true)
    expect(lastPlanMode(afterModeOff), 'plan approve: last durable plan mode is inactive').toBe(false)
    expect(afterModeOff.filter(event => event.type === 'tool/result'
      && String(event.data?.message?.toolCallId) === callId),
    'plan approve: the reviewed call settled exactly once').toHaveLength(1)
    await waitFrame(client, 'Plan approved', 'plan approve: settled result painted')

    await client.exitGracefully()
    const exit = await client.close()
    expect(exit.code, 'plan approve: native Client exit code').toBe(0)
    expect(exit.signal, 'plan approve: native Client exit signal').toBeNull()
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, client)
  }
})

test('returns plan feedback without leaving plan mode and accepts the next Turn', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  try {
    host = await scene.startHost({ scenario: 'plan-review' })
    client = await scene.startClient({
      label: 'plan-feedback-review',
      ...clientDirectories(scene, 'plan-feedback-review'),
    })
    const sessionId = await openSeededSession(scene, client, 'plan feedback seed turn', 'plan feedback')
    await enterPlanMode(scene, client, sessionId, 'plan feedback')

    const reviewCut = scene.sessionEvents(sessionId)?.length ?? 0
    await client.submit(`Present the plan for edits ${keepPlanMarker}`)
    const call = await scene.waitForSessionEvent(sessionId, reviewCut,
      event => event.type === 'tool/call' && event.data?.name === 'exit_plan_mode',
      'plan feedback: official exit_plan_mode call')
    const callId = String(call.data?.callId)
    expect(callId, 'plan feedback: call identity').not.toBe('')
    await waitFrame(client, 'Plan review', 'plan feedback: decision seat')

    await client.press('Down')
    await waitFrame(client, '> Keep planning', 'plan feedback: painted Keep row')
    await client.press('Enter')
    await waitFrame(client, 'Request changes', 'plan feedback: feedback step')
    await client.press('Escape')
    await waitFrame(client, '> Keep planning', 'plan feedback: local back to the decision list')
    expect((scene.sessionEvents(sessionId) ?? []).slice(reviewCut).some(event => event.type === 'tool/result'
      && String(event.data?.message?.toolCallId) === callId),
    'plan feedback: the Feedback Esc settled no tool result').toBe(false)

    await client.press('Enter')
    await waitFrame(client, 'Request changes', 'plan feedback: feedback step reopened')
    await client.type('修改第 2 步')
    await waitFrame(client, '修改第 2 步', 'plan feedback: authored feedback is in the live input')
    await client.press('Enter')
    const result = await scene.waitForSessionEvent(sessionId, reviewCut,
      event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
      'plan feedback: official tool-error feedback result')
    expect(result.data?.message?.isError, 'plan feedback: Keep returns the official tool error').toBe(true)
    expect(messageText(result.data?.message), 'plan feedback: authored CJK feedback is returned')
      .toContain('修改第 2 步')

    const keptEvents = scene.sessionEvents(sessionId) ?? []
    expect(lastPlanMode(keptEvents), 'plan feedback: plan mode stays active').toBe(true)
    expect(keptEvents.some(event => event.type === 'plan/mode' && event.data?.active === false),
      'plan feedback: no plan exit was written').toBe(false)
    expect(keptEvents.filter(event => event.type === 'tool/result'
      && String(event.data?.message?.toolCallId) === callId),
    'plan feedback: the reviewed call settled exactly once').toHaveLength(1)

    const nextCut = keptEvents.length
    await client.submit(`Continue after the feedback ${nextStepPlanMarker}`)
    const nextUser = await scene.waitForSessionEvent(sessionId, nextCut,
      event => event.type === 'user/message' && messageText(event.data).includes(nextStepPlanMarker),
      'plan feedback: genuine next Turn occurrence')
    const afterNext = scene.sessionEvents(sessionId) ?? []
    const nextIndex = eventIndex(afterNext, nextUser, 'plan feedback next occurrence')
    await scene.waitForSessionEvent(sessionId, nextIndex,
      event => event.type === 'assistant/message' && messageText(event.data?.message).includes('next-step answer'),
      'plan feedback: next Turn answer')
    await scene.waitForSessionEvent(sessionId, nextIndex,
      event => event.type === 'turn/end', 'plan feedback: next Turn end')
    const finalEvents = scene.sessionEvents(sessionId) ?? []
    expect(finalEvents.filter(event => event.type === 'user/message'
      && messageText(event.data).includes(nextStepPlanMarker)),
    'plan feedback: the next-step occurrence is claimed once').toHaveLength(1)

    await client.exitGracefully()
    const exit = await client.close()
    expect(exit.code, 'plan feedback: native Client exit code').toBe(0)
    expect(exit.signal, 'plan feedback: native Client exit signal').toBeNull()
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary, client)
  }
})
