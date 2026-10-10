/**
 * Supporting composition-unit tests (no L1–L6 level) for the Remote
 * session-facts composition (M3-4 PR4 Step 3 / plan §3.3/§3.4/§3.6, TPS plan
 * PR-2 §5.3): whole-log totals from the official projections, the measured
 * performance facts from THIS Session's Host `piTuiPerformance` projection
 * (never the bounded window, never `loadOlder()`), bounded loadOlder paging
 * for lastAssistantText only, the currentness fence, and the
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
    fence: { isCurrent: () => true },
    facts: {
      sessionStats: { turns: 3, steps: 9, llmMs: 12_000 },
      usage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 20 },
      contextWindow: 128_000,
      // The measured performance facts ride the SAME facts object: THIS
      // Session's own Host `piTuiPerformance` projection.
      performance: {
        recent: { outputTokens: 100, modelMs: 1000, samples: 1, firstTokenMs: 500, firstTokenSamples: 1 },
        all: { outputTokens: 100, modelMs: 1000, samples: 1 },
      },
    },
  })
  assert.ok(stats !== undefined)
  assert.deepEqual(stats.lifetime, { turns: 3, steps: 9, llmMs: 12_000 },
    'the lifetime group is projection-backed (§1B-2 facts shape)')
  assert.deepEqual(stats.tokens, { input: 100, output: 50, cacheRead: 30, cacheWrite: 20, cacheHitPct: 20 },
    'the tokens group is projection-backed (billed 150; cacheHit 30/150 = 20%)')
  assert.equal(stats.contextWindow, 128_000)
  assert.deepEqual(stats.recent, { firstTokenMsAvg: 500, tokensPerSec: 100 },
    'the recent group is the Host projection derivation (500ms TTFB, 100 tok/s)')
  assert.deepEqual(stats.sessionPerformance, { tokensPerSec: 100 }, 'the All group is the Host projection derivation')
})

test('§3.3 stats: a superseded transport never commits (undefined)', async () => {
  const stale = await composeRemoteSessionStats({
    sessionId: 's',
    // A replaced Connection/binding drops at the fence, never a partial figure.
    fence: { isCurrent: () => false },
    facts: { sessionStats: { turns: 1, steps: 1, llmMs: 0 }, usage: undefined, contextWindow: undefined, performance: undefined },
  })
  assert.equal(stale, undefined, 'a replaced Connection/binding settles as superseded')

  // Retirement is structural, not a counter: the input carries NO reader
  // capability at all, so a bounded page cannot influence a performance fact
  // even by accident — the composition answers from the passed-in Host facts
  // alone (there is no reader to call, and the retired source path is gone).
  const current = await composeRemoteSessionStats({
    sessionId: 's',
    fence: { isCurrent: () => true },
    facts: {
      sessionStats: { turns: 1, steps: 1, llmMs: 0 },
      usage: undefined,
      contextWindow: undefined,
      performance: {
        recent: { outputTokens: 30, modelMs: 1000, samples: 1, firstTokenMs: 0, firstTokenSamples: 1 },
        all: { outputTokens: 30, modelMs: 1000, samples: 1 },
      },
    },
  })
  assert.deepEqual(current?.recent, { firstTokenMsAvg: 0, tokensPerSec: 30 },
    'the Host projection alone answers (a measured 0 TTFB stays a visible zero)')
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

/* ── PR5 v2 §1B-2: unknown stays unknown (never `?? 0`) ─────────────────── */

test('§1B-2 absent projections stay absent groups — never fabricated zeros', async () => {
  const window: PresentationReadSnapshot = {
    sessionId: 's', durableEvents: [] as never, liveInputs: [], revision: 1,
    coverage: 'full', hasMore: false, loadingOlder: false, openState: 'open',
  }
  // EVERY authoritative source absent, including this Session's Host
  // performance projection.
  const facts = await composeRemoteSessionStats({
    sessionId: 's',
    fence: { isCurrent: () => true },
    facts: { sessionStats: undefined, usage: undefined, contextWindow: undefined, performance: undefined },
  })
  assert.ok(facts !== undefined)
  assert.equal(facts.lifetime, undefined, 'an absent sessionStats projection keeps the lifetime group ABSENT (never t0/s0/LLM 0s)')
  assert.equal(facts.tokens, undefined, 'an absent tokenUsage projection keeps the tokens group ABSENT (never ↑0 ↓0)')
  assert.equal(facts.recent, undefined,
    'an absent Host projection keeps the recent group ABSENT (a bounded window can no longer stand in)')
  assert.equal(facts.sessionPerformance, undefined, 'an absent Host projection keeps the All group ABSENT')
})

test('§1B-2 a present Host projection renders its measured zero; a sample-less scope stays ABSENT', async () => {
  const window: PresentationReadSnapshot = {
    sessionId: 's', durableEvents: [] as never, liveInputs: [], revision: 1,
    coverage: 'full', hasMore: false, loadingOlder: false, openState: 'open',
  }
  const facts = await composeRemoteSessionStats({
    sessionId: 's',
    fence: { isCurrent: () => true },
    facts: {
      sessionStats: { turns: 0, steps: 0, llmMs: 0 },
      usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      contextWindow: undefined,
      // ONE measured first-token sample at 0 ms, but NO eligible TPS sample.
      performance: {
        recent: { outputTokens: 0, modelMs: 0, samples: 0, firstTokenMs: 0, firstTokenSamples: 1 },
        all: { outputTokens: 0, modelMs: 0, samples: 0 },
      },
    },
  })
  assert.ok(facts !== undefined)
  assert.deepEqual(facts!.lifetime, { turns: 0, steps: 0, llmMs: 0 }, 'a present zero projection renders a KNOWN zero')
  assert.ok(facts!.tokens !== undefined && facts!.tokens.input === 0 && facts!.tokens.output === 0,
    'a present zero usage renders a KNOWN zero token group')
  assert.deepEqual(facts!.recent, { firstTokenMsAvg: 0 },
    'a measured 0ms TTFB is a visible zero; the sample-less rate fields stay ABSENT, never 0')
  assert.equal(facts!.sessionPerformance, undefined, 'a sample-less All scope answers nothing')
})

// QUALIFICATION LABEL (whole-PR F5): this case pages a NEVER-satisfied window
// to the HISTORY START, where the fold becomes authoritative and the recent
// group is PRESENT. It is therefore NOT a bounded-window ABSENT proof — that
// absence is encoded by the presentation-layer availability bit (Batch 1B,
// `recent-performance-availability.test.ts`), not here.
