/** Regression tests for the single cold-session UI hydration adapter. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { computeStats } from '../src/stats.ts'
import { hydrateSessionUi } from '../src/session-ui-hydrate.ts'
import { foldTranscript } from '../src/transcript.ts'

function event<K extends string>(
  type: K,
  data: (K extends SessionEvent['type'] ? SessionEvent<K>['data'] : Record<string, unknown>) & Record<string, unknown>,
  seq: number,
): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq * 1000, data } as SessionEvent
}

test('hydrates transcript and stats projections from the same event log', () => {
  const events = [
    event('turn/start', { turn: 0 }, 0),
    event('user/message', {
      id: MessageId('hydrate-user'),
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }, 1),
    event('step/start', { turn: 0, step: 0 }, 2),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('hydrate-assistant'),
        role: 'assistant',
        content: [{ type: 'text', text: 'world' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 2 },
      stream: [],
    }, 3),
    event('step/end', { turn: 0, step: 0 }, 4),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5),
  ]
  const hydrated = hydrateSessionUi(events)
  assert.deepEqual(hydrated.folder.messages(), foldTranscript(events))
  assert.deepEqual(hydrated.statsFolder.snapshot(), computeStats(events))

  const transcript = hydrated.folder.messages()
  const stats = hydrated.statsFolder.snapshot()
  hydrated.folder.apply([event('user/message', {
    id: MessageId('hydrate-user-2'),
    role: 'user',
    content: [{ type: 'text', text: 'again' }],
    source: { kind: 'user' },
  }, 6)])
  hydrated.statsFolder.apply([event('request/context', {
    provider: 'p',
    model: 'm',
    contextWindow: 1000,
  }, 7)])
  const nextTranscript = hydrated.folder.messages()
  assert.equal(nextTranscript.some(message => message.kind === 'user' && message.text === 'again'), true)
  assert.notDeepEqual(nextTranscript, transcript)
  const nextStats = hydrated.statsFolder.snapshot()
  assert.equal(nextStats.contextWindow, 1000)
  assert.notDeepEqual(nextStats, stats)
})
