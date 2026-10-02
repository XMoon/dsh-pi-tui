/**
 * L3 contract tests for the Remote session-facts composition (M3-4 PR4
 * Step 3 / plan §3.3/§3.4/§3.6): whole-log totals from the official
 * projections (never the bounded window), recent performance from the
 * bounded window via the shared fold, bounded loadOlder paging for both
 * stats and lastAssistantText, stale-transport dropping, and the
 * undefined-vs-empty-text distinction.
 * @module @xmoon76/dsh-pi-tui/remote-session-facts-compose.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composeRemoteLastAssistantText,
  composeRemoteSessionStats,
  type RemoteFactsReader,
} from '../src/app/remote/session-facts-compose.ts'
import type { PresentationReadSnapshot } from '../src/runtime/presentation-read-port.ts'
import { RECENT_PERFORMANCE_SAMPLE_LIMIT } from '../src/stats.ts'

/** One window event builder (durable entries only). */
function events(...specs: Array<[string, unknown]>): Array<Record<string, unknown> & { type: string; seq: number; time: number }> {
  let seq = 0
  return specs.map(([type, data]) => ({ type, seq: seq++, time: 1_700_000_000_000 + seq, data }))
}

function assistantMessage(seq: number, text: string) {
  return {
    type: 'assistant/message',
    seq,
    time: 1_700_000_000_000 + seq,
    data: { message: { content: text === '' ? [] : [{ type: 'text', text }] } },
  }
}

test('§3.3 stats: lifetime totals come from the projections, not the window', async () => {
  // The window carries only ONE old turn; the projections report THREE.
  const window: PresentationReadSnapshot = {
    sessionId: 's',
    durableEvents: events(
      ['turn/start', { turn: 1 }],
      ['step/start', { turn: 1, step: 1 }],
      ['assistant/message', { message: { content: [] } }],
      ['step/end', { turn: 1, step: 1 }],
      ['turn/end', { reason: { kind: 'completed' } }],
    ) as never,
    liveInputs: [],
    revision: 1,
    coverage: 'full',
    hasMore: false,
    loadingOlder: false,
    openState: 'open',
  }
  const stats = await composeRemoteSessionStats({
    sessionId: 's',
    reader: { read: async () => window, loadOlder: async () => window },
    fence: { isCurrent: () => true },
    facts: {
      sessionStats: { turns: 3, steps: 9, llmMs: 12_000 },
      usage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 20 },
      contextWindow: 128_000,
    },
  })
  assert.ok(stats !== undefined)
  assert.equal(stats.turns, 3, 'lifetime turns are projection-backed')
  assert.equal(stats.steps, 9, 'lifetime steps are projection-backed')
  assert.equal(stats.llmMs, 12_000, 'lifetime llmMs is projection-backed')
  assert.equal(stats.inputTokens, 100)
  assert.equal(stats.outputTokens, 50)
  assert.equal(stats.cacheReadTokens, 30)
  assert.equal(stats.cacheWriteTokens, 20)
  // billed = 100 + 30 + 20 = 150; cacheHit = 30/150 = 20%
  assert.equal(stats.cacheHitPct, 20)
  assert.equal(stats.contextWindow, 128_000)
})

test('§3.3 stats: a superseded transport never commits (undefined)', async () => {
  let windowReads = 0
  const window: PresentationReadSnapshot = {
    sessionId: 's', durableEvents: [], liveInputs: [], revision: 1,
    coverage: 'full', hasMore: false, loadingOlder: false, openState: 'open',
  }
  const stats = await composeRemoteSessionStats({
    sessionId: 's',
    reader: {
      read: async () => { windowReads += 1; return window },
      loadOlder: async () => window,
    },
    // The transport flips DURING the read await: the FIRST fence check
    // (after the read settles) sees the replaced identity and must drop.
    fence: { isCurrent: () => windowReads < 1 },
    facts: { sessionStats: { turns: 1, steps: 1, llmMs: 0 }, usage: undefined, contextWindow: undefined },
  })
  assert.equal(stats, undefined, 'a replaced Connection/binding settles as superseded, never a partial figure')
})

test('§3.3 stats: bounded paging stops once enough recent samples are loaded', async () => {
  // Page 1: a truncated window with too few completed steps.
  // Page 2: a window with more than 2× the sample limit — paging stops there.
  const stepTriplets = (turns: number) => {
    const out: Array<Record<string, unknown> & { type: string; seq: number; time: number }> = []
    let seq = 0
    for (let turn = 1; turn <= turns; turn += 1) {
      out.push({ type: 'turn/start', seq: seq++, time: 1, data: { turn } })
      out.push({ type: 'step/start', seq: seq++, time: 1, data: { turn, step: 1 } })
      out.push({ type: 'step/end', seq: seq++, time: 1_000, data: { turn, step: 1 } })
      out.push({ type: 'turn/end', seq: seq++, time: 1_000, data: { turn, reason: { kind: 'completed' } } })
    }
    return out
  }
  const page1: PresentationReadSnapshot = {
    sessionId: 's', durableEvents: stepTriplets(1) as never, liveInputs: [], revision: 1,
    coverage: 'bounded', hasMore: true, loadingOlder: false, openState: 'open',
  }
  const page2: PresentationReadSnapshot = {
    sessionId: 's', durableEvents: stepTriplets(RECENT_PERFORMANCE_SAMPLE_LIMIT * 2) as never, liveInputs: [], revision: 2,
    coverage: 'bounded', hasMore: true, loadingOlder: false, openState: 'open',
  }
  let loadOlderCalls = 0
  const stats = await composeRemoteSessionStats({
    sessionId: 's',
    reader: {
      read: async () => page1,
      loadOlder: async () => { loadOlderCalls += 1; return page2 },
    },
    fence: { isCurrent: () => true },
    facts: { sessionStats: { turns: 30, steps: 30, llmMs: 1 }, usage: undefined, contextWindow: undefined },
  })
  assert.ok(stats !== undefined)
  assert.equal(loadOlderCalls, 1, 'paging stops once the recent-sample window is complete (never loads the whole log)')
  assert.equal(stats.turns, 30, 'the projection still owns lifetime totals')
})

test('§3.6 lastAssistantText: newest message inside the window returns verbatim', async () => {
  const window: PresentationReadSnapshot = {
    sessionId: 's',
    durableEvents: [
      assistantMessage(0, 'older reply'),
      assistantMessage(1, 'newest reply'),
    ] as never,
    liveInputs: [], revision: 1, coverage: 'bounded', hasMore: true, loadingOlder: false, openState: 'open',
  }
  const text = await composeRemoteLastAssistantText({
    sessionId: 's',
    reader: { read: async () => window, loadOlder: async () => window },
    fence: { isCurrent: () => true },
  })
  assert.equal(text, 'newest reply')
})

test('§3.6 lastAssistantText: a message older than the window pages loadOlder exactly to it', async () => {
  const olderPage: PresentationReadSnapshot = {
    sessionId: 's',
    durableEvents: [
      assistantMessage(0, 'ancient reply'),
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 9 } },
    ] as never,
    liveInputs: [], revision: 1, coverage: 'bounded', hasMore: false, loadingOlder: false, openState: 'open',
  }
  const freshPage: PresentationReadSnapshot = {
    sessionId: 's', durableEvents: [] as never, liveInputs: [], revision: 2,
    coverage: 'bounded', hasMore: true, loadingOlder: false, openState: 'open',
  }
  let loadOlderCalls = 0
  const text = await composeRemoteLastAssistantText({
    sessionId: 's',
    reader: {
      read: async () => freshPage,
      loadOlder: async () => { loadOlderCalls += 1; return olderPage },
    },
    fence: { isCurrent: () => true },
  })
  assert.equal(text, 'ancient reply')
  assert.equal(loadOlderCalls, 1)
})

test('§3.6 lastAssistantText: history start reached with no assistant message is undefined; empty text stays empty-string', async () => {
  const noAssistant: PresentationReadSnapshot = {
    sessionId: 's', durableEvents: [] as never, liveInputs: [], revision: 1,
    coverage: 'full', hasMore: false, loadingOlder: false, openState: 'open',
  }
  assert.equal(await composeRemoteLastAssistantText({
    sessionId: 's',
    reader: { read: async () => noAssistant, loadOlder: async () => noAssistant },
    fence: { isCurrent: () => true },
  }), undefined, 'undefined = no assistant message yet')

  const emptyText: PresentationReadSnapshot = {
    sessionId: 's',
    durableEvents: [assistantMessage(0, '')] as never,
    liveInputs: [], revision: 1, coverage: 'full', hasMore: false, loadingOlder: false, openState: 'open',
  }
  assert.equal(await composeRemoteLastAssistantText({
    sessionId: 's',
    reader: { read: async () => emptyText, loadOlder: async () => emptyText },
    fence: { isCurrent: () => true },
  }), '', "'' = the message carries no text")
})

test('§3.6 lastAssistantText: a superseded paging result is dropped (undefined)', async () => {
  let reads = 0
  const page: PresentationReadSnapshot = {
    sessionId: 's', durableEvents: [] as never, liveInputs: [], revision: 1,
    coverage: 'bounded', hasMore: true, loadingOlder: false, openState: 'open',
  }
  const older: PresentationReadSnapshot = {
    sessionId: 's',
    durableEvents: [assistantMessage(0, 'stale page reply')] as never,
    liveInputs: [], revision: 1, coverage: 'bounded', hasMore: false, loadingOlder: false, openState: 'open',
  }
  const text = await composeRemoteLastAssistantText({
    sessionId: 's',
    reader: {
      read: async () => { reads += 1; return page },
      loadOlder: async () => older,
    },
    // The transport flips DURING the loadOlder await: the fence check after
    // the page settles must drop the paged result.
    fence: { isCurrent: () => reads < 1 },
  })
  assert.equal(text, undefined, 'a stale paging settle never presents its page')
})
