import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { messageText, test } from '../support/split-vitest-fixture.ts'

test('two real Clients share one Host Session and a Ctrl+S-steered queued prompt is claimed exactly once', async ({ candidateScene: scene }) => {
  const releaseBarrier = join(scene.workDir, 'long-turn.release')
  const host = await scene.startHost('long-turn', { C1_HOLD_LONG_TURN: releaseBarrier })
  const sessionsBefore = new Set(await scene.sessionIds())

  const clientA = await scene.startClient('a')
  await clientA.waitForVisibleText('dsh-pi-tui', 'A painted the sessionless welcome')
  await clientA.submit('s0-seed-a')
  await clientA.waitForText('s0-seed-a', 'A painted its submitted prompt')

  const sessionId = await scene.waitForNewSessionId(sessionsBefore, 'A created Session X')
  const held = await scene.waitForC1WorkEvent(
    host.workRoot,
    event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
    'the Host held the long Turn',
  )
  assert.equal(held.agentStatus, 'running', 'the Host Agent was not running while the Turn was held')
  await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/start', 'Session X turn/start')

  const clientB = await scene.startClient('b', { sessionId })
  await clientA.waitForText('long-turn started', 'A saw the running Host stream')
  await clientB.waitForText('long-turn started', 'B saw the shared running Host stream')

  const queueBoundary = (await scene.sessionEvents(sessionId))?.length ?? 0
  await clientB.submit('s0-b-queued')
  await clientA.waitForText('s0-b-queued', "A saw B's Host-owned pending occurrence")
  const queueEvent = await scene.waitForSessionEvent(
    sessionId,
    queueBoundary,
    event => event.type === 'agent/inbox/spliced'
      && event.data?.target === 'next-turn'
      && (event.data.inserted ?? []).some((message: Record<string, any>) => messageText(message) === 's0-b-queued'),
    'B queued s0-b-queued in the shared Host inbox',
  )
  const queuedItem = (queueEvent.data?.inserted ?? [])
    .find((message: Record<string, any>) => messageText(message) === 's0-b-queued')
  assert.equal(typeof queuedItem?.id, 'string', 'the queued Host occurrence carries no identity')
  assert.notEqual(queuedItem.id, '', 'the queued Host occurrence identity is empty')

  const steerBoundary = (await scene.sessionEvents(sessionId))?.length ?? 0
  await clientA.press('Ctrl+S')
  await scene.waitForSessionEvent(
    sessionId,
    steerBoundary,
    event => event.type === 'agent/inbox/spliced'
      && event.data?.target === 'next-turn'
      && event.data?.removedCount === 1
      && (event.data.inserted ?? []).length === 0,
    'Ctrl+S removed the queued occurrence from next-turn',
  )
  const steered = await scene.waitForSessionEvent(
    sessionId,
    steerBoundary,
    event => event.type === 'agent/inbox/spliced'
      && event.data?.target === 'next-step'
      && (event.data.inserted ?? []).some((message: Record<string, any>) => message?.id === queuedItem.id),
    'Ctrl+S steered the exact Host occurrence identity into next-step',
  )
  assert.equal(
    (steered.data?.inserted ?? []).filter((message: Record<string, any>) => message?.id === queuedItem.id).length,
    1,
    'the steer path duplicated the Host occurrence',
  )
  const beforeRelease = await scene.sessionEvents(sessionId)
  assert.equal(
    (beforeRelease ?? []).some(event => event.type === 'user/message'
      && event.data?.id === queuedItem.id),
    false,
    'the steered occurrence was committed before the held Turn settled',
  )

  writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
  const claimed = await scene.waitForSessionEvent(
    sessionId,
    steerBoundary,
    event => event.type === 'user/message' && event.data?.id === queuedItem.id,
    'the steered occurrence was claimed exactly once',
  )
  assert.equal(messageText(claimed.data), 's0-b-queued', 'the steered occurrence changed content')
  await scene.waitForSessionEvent(
    sessionId,
    steerBoundary,
    event => event.type === 'turn/end',
    'the shared Turn settled',
  )

  const events = (await scene.sessionEvents(sessionId)) ?? []
  const committed = events.filter(event => event.type === 'user/message' && event.data?.id === queuedItem.id)
  assert.equal(committed.length, 1, 'the steered occurrence was committed more than once')
  const userTexts = sessionsUserTexts(events)
  assert.equal(userTexts.filter(text => text === 's0-b-queued').length, 1,
    'the Host durable user input did not carry s0-b-queued exactly once')
  const answers = events
    .slice(steerBoundary)
    .filter(event => event.type === 'assistant/message')
    .map(event => messageText(event.data?.message))
    .filter(text => text !== '')
  assert.ok(answers.length >= 2, `the shared Turn produced ${String(answers.length)} durable answer(s)`)
  for (const answer of answers) {
    await clientA.waitForText(answer, 'A read the Host answer')
    await clientB.waitForText(answer, 'B read the Host answer')
  }

  await scene.exitClient(clientA)
  await scene.exitClient(clientB)
  await scene.shutdownHost(host)
})

function sessionsUserTexts(events: Array<{ type?: string; data?: Record<string, any> }>): string[] {
  return events
    .filter(event => event.type === 'user/message' && Array.isArray(event.data?.content))
    .map(event => (event.data?.content as Array<Record<string, any>>)
      .map(part => (typeof part?.text === 'string' ? part.text : ''))
      .join(''))
}

test('the first real Question answer settles once while the loser late option key stays in its editor', async ({ candidateScene: scene }) => {
  const host = await scene.startHost('question')
  const sessionsBefore = new Set(await scene.sessionIds())

  const clientA = await scene.startClient('a')
  await clientA.waitForVisibleText('dsh-pi-tui', 'A painted the sessionless welcome')
  await clientA.submit('/new')
  // An idle Session materializes lazily: its first durable write is what gives
  // the test its real Host Session identity. A user title write is metadata,
  // not a prompt, so the Session stays conversation-empty until B attaches.
  await clientA.submit('/title s0-empty-session')
  const sessionId = await scene.waitForNewSessionId(sessionsBefore, 'A created empty Session X')

  const clientB = await scene.startClient('b', { sessionId })
  const beforeTrigger = (await scene.sessionEvents(sessionId)) ?? []
  assert.equal(
    beforeTrigger.some(event => event.type === 'turn/start' || event.type === 'tool/call'
      || event.type === 'approval/asked'),
    false,
    'Session X carried Host activity before the trigger',
  )

  const triggerBoundary = beforeTrigger.length
  await clientA.submit('s0-question-trigger')
  const call = await scene.waitForSessionEvent(
    sessionId,
    triggerBoundary,
    event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
    'the Host emitted the ask_user_question tool call',
  )
  assert.equal(typeof call.data?.callId, 'string', 'the question tool call carries no callId')
  const callId = String(call.data?.callId)
  assert.notEqual(callId, '', 'the question tool call id is empty')

  await clientA.waitForVisibleText('Continue the C1 test?', 'A saw the real question modal')
  await clientB.waitForVisibleText('Continue the C1 test?', 'B saw the same real question modal')
  await clientA.waitForVisibleText('[1] Proceed', 'A saw the question option')
  await clientB.waitForVisibleText('[1] Proceed', 'B saw the question option')

  if (process.env.S0_PROBE_FAIL_AFTER_TWO_CLIENTS === '1') {
    throw new Error('S0_INTENTIONAL_FAILURE: injected while both Clients hold the unanswered Question')
  }

  await clientA.press('1')
  await clientA.waitForVisibleText('Review your answer before submit', 'A reached the question review page')
  const answerBoundary = (await scene.sessionEvents(sessionId))?.length ?? 0
  await clientA.press('Enter')
  const result = await scene.waitForSessionEvent(
    sessionId,
    answerBoundary,
    event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
    'the Host committed the question tool result',
  )
  assert.notEqual(result.data?.message?.isError, true, 'the answered question failed at the Host')
  assert.match(JSON.stringify(result.data?.message ?? {}), /Proceed/u,
    'the Host question result did not carry the selected Proceed answer')
  await scene.waitForSessionEvent(
    sessionId,
    answerBoundary,
    event => event.type === 'turn/end',
    'the question Turn settled',
  )
  await clientA.waitForText('question answered', 'A read the Host settlement')
  await clientB.waitForText('question answered', 'B read the Host settlement')
  await clientB.waitForVisibleTextGone('[1] Proceed', 'B question modal was withdrawn')

  const lateBoundary = (await scene.sessionEvents(sessionId))?.length ?? 0
  await clientB.press('2')
  await clientB.type('-late-editor')
  await clientB.waitForVisibleText('2-late-editor', 'the late option key became ordinary editor text')
  await clientB.press('Ctrl+U')
  await clientB.waitForVisibleTextGone('2-late-editor', 'B cleared the late editor text')

  await scene.exitClient(clientB)
  assert.equal(await clientA.isAlive(), true, 'Client A died when Client B exited')
  await scene.hostStatus(host)

  const afterExitBoundary = (await scene.sessionEvents(sessionId))?.length ?? 0
  await clientA.submit('s0-a-after-b-exit')
  await clientA.waitForText('s0-a-after-b-exit', 'A painted its post-exit prompt')
  await scene.waitForSessionEvent(
    sessionId,
    afterExitBoundary,
    event => event.type === 'user/message' && sessionsUserTexts([event]).includes('s0-a-after-b-exit'),
    'A wrote Session X after B exited',
  )
  await scene.waitForSessionEvent(
    sessionId,
    afterExitBoundary,
    event => event.type === 'turn/end',
    'A post-exit Turn settled',
  )

  await scene.exitClient(clientA)
  await scene.shutdownHost(host)

  const finalEvents = (await scene.sessionEvents(sessionId)) ?? []
  assert.equal(
    finalEvents.filter(event => event.type === 'tool/call'
      && event.data?.name === 'ask_user_question').length,
    1,
    'the Host asked more than once for one question tool call',
  )
  assert.equal(
    finalEvents.filter(event => event.type === 'tool/result'
      && String(event.data?.message?.toolCallId) === callId).length,
    1,
    'the Host wrote more than one tool result for the question call',
  )
  assert.equal(
    finalEvents.slice(lateBoundary).some(event => event.type === 'tool/call'
      || event.type === 'tool/result'),
    false,
    'a late loser key produced Host tool activity',
  )
  assert.equal(sessionsUserTexts(finalEvents).filter(text => text === 's0-question-trigger').length, 1,
    'the question trigger was not committed exactly once')
  assert.equal(sessionsUserTexts(finalEvents).filter(text => text === 's0-a-after-b-exit').length, 1,
    'the post-exit prompt was not committed exactly once')
})
