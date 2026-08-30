/** Regression tests for the movable transcript-window state and projection. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../src/transcript.ts'
import { TranscriptWindowController } from '../src/transcript-window.ts'

function longSession(turnCount: number): SessionEvent[] {
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 1; turn <= turnCount; turn += 1) {
    events.push({ type: 'turn/start', seq, time: 1_700_000_000_000 + seq, data: { turn } } as SessionEvent)
    seq += 1
    events.push({
      type: 'user/message',
      seq,
      time: 1_700_000_000_000 + seq,
      data: {
        id: MessageId(`message-${turn}`),
        role: 'user',
        content: [{ type: 'text', text: `turn ${turn}` }],
        source: { kind: 'user' },
      },
    } as SessionEvent)
    seq += 1
  }
  return events
}

function userTurns(folder: TranscriptFolder, options: { maxTurns: number; endTurn?: number }): number[] {
  return folder.window(options).messages
    .filter((message): message is Extract<typeof message, { kind: 'user' }> => message.kind === 'user')
    .map(message => message.turn)
}

test('indexed windows expose latest and anchored turn bounds', () => {
  const folder = new TranscriptFolder()
  folder.hydrate(longSession(100))

  const latest = folder.window({ maxTurns: 20 })
  assert.deepEqual(userTurns(folder, { maxTurns: 20 }), Array.from({ length: 20 }, (_, index) => index + 81))
  assert.equal(latest.firstTurn, 81)
  assert.equal(latest.lastTurn, 100)
  assert.equal(latest.hasOlder, true)
  assert.equal(latest.hasNewer, false)

  const anchored = folder.window({ maxTurns: 20, endTurn: 50 })
  assert.deepEqual(userTurns(folder, { maxTurns: 20, endTurn: 50 }), Array.from({ length: 20 }, (_, index) => index + 31))
  assert.equal(anchored.firstTurn, 31)
  assert.equal(anchored.lastTurn, 50)
  assert.equal(anchored.hasOlder, true)
  assert.equal(anchored.hasNewer, true)
  assert.match(anchored.messages[0]?.kind === 'summary' ? anchored.messages[0].text : '', /50 newer turns/)
})

test('controller pages by grouped-output turns across a cross-turn read card', () => {
  const folder = new TranscriptFolder()
  const pair = (turn: number, call: string, seq: number): SessionEvent[] => {
    const callId = ToolCallId(call)
    return [
      {
        type: 'tool/call',
        seq,
        time: 1_700_000_000_000 + seq,
        data: { turn, step: 0, callId, name: 'read', arguments: '{}' },
      } as SessionEvent,
      {
        type: 'tool/result',
        seq: seq + 1,
        time: 1_700_000_000_000 + seq + 1,
        data: {
          turn,
          step: 0,
          message: {
            id: MessageId(`cross-turn-${call}`),
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: call }] }],
            source: { kind: 'tool', callId },
          },
        },
      } as SessionEvent,
    ]
  }
  folder.apply([
    ...pair(0, 'r0', 0),
    ...pair(1, 'r1', 2),
    {
      type: 'assistant/message',
      seq: 4,
      time: 1_700_000_000_004,
      data: {
        turn: 2,
        step: 0,
        message: {
          id: MessageId('cross-turn-tail'),
          role: 'assistant',
          content: [{ type: 'text', text: 'tail' }],
          source: { kind: 'model', provider: 'test', model: 'test' },
        },
      },
    } as SessionEvent,
  ])

  assert.deepEqual(folder.turns(), [0, 1, 2])
  assert.deepEqual(folder.groupedTurns(), [1, 2])
  const controller = new TranscriptWindowController({ windowTurns: 1, stepTurns: 2, turns: folder.groupedTurns() })
  assert.equal(controller.moveOlder(), true)
  assert.equal(controller.endTurn(), 1)
  const projection = folder.window({ maxTurns: 1, endTurn: controller.endTurn() })
  assert.equal(projection.lastTurn, 1)
  assert.equal(projection.messages.some(message => message.kind === 'tool' && message.args === '2 files'), true)
  assert.equal(controller.moveOlder(), false)
})

test('window controller moves by overlapping pages and returns to live tail', () => {
  const folder = new TranscriptFolder()
  folder.hydrate(longSession(100))
  const controller = new TranscriptWindowController({ windowTurns: 20, stepTurns: 10, turns: folder.turns() })

  assert.equal(controller.isLatest(), true)
  assert.equal(controller.moveOlder(), true)
  assert.deepEqual(controller.snapshot(), {
    mode: 'history',
    endTurn: 90,
    firstTurn: 71,
    lastTurn: 90,
    hasOlder: true,
    hasNewer: true,
  })
  assert.deepEqual(userTurns(folder, { maxTurns: 20, endTurn: controller.endTurn() }), Array.from({ length: 20 }, (_, index) => index + 71))

  assert.equal(controller.moveNewer(), true)
  assert.equal(controller.isLatest(), true)
  assert.equal(controller.moveNewer(), false)
  assert.equal(controller.snapshot().hasNewer, false)
})

test('controller navigates non-monotonic indexes with the safe fallback', () => {
  const turns = [1, 3, 2]
  const controller = new TranscriptWindowController({ windowTurns: 1, stepTurns: 1, turns })

  assert.equal(controller.moveOlder(), true)
  assert.equal(controller.endTurn(), 3)
  assert.equal(controller.moveOlder(), true)
  assert.equal(controller.endTurn(), 1)
  assert.equal(controller.moveNewer(), true)
  assert.equal(controller.endTurn(), 3)

  turns.push(4, 0)
  assert.equal(controller.anchorAt(0), true, 'an appended out-of-order turn must use linear lookup')
  assert.equal(controller.endTurn(), 0)
})

test('history projection remains stable while new turns append', () => {
  const folder = new TranscriptFolder()
  folder.hydrate(longSession(100))
  const controller = new TranscriptWindowController({ turns: folder.turns() })
  controller.anchorAt(50)
  const before = folder.window({ maxTurns: controller.windowTurns, endTurn: controller.endTurn() })
  assert.equal(before.hasNewer, true)

  folder.apply(longSession(101).slice(-2))
  const after = folder.window({ maxTurns: controller.windowTurns, endTurn: controller.endTurn() })
  assert.deepEqual(userTurns(folder, { maxTurns: controller.windowTurns, endTurn: controller.endTurn() }), userTurns(folder, { maxTurns: 20, endTurn: 50 }))
  assert.equal(after.lastTurn, 50)
  assert.equal(after.hasNewer, true)
})
