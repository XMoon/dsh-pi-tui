/**
 * Supporting composition-unit tests (no L1–L6 level) for the Remote
 * session-facts composition (M3-4 PR4 Step 3 / plan §3.3/§3.4/§3.6): whole-log
 * totals from the official projections (never the bounded window), recent
 * performance from the bounded window via the shared fold, bounded loadOlder
 * paging for both stats and lastAssistantText, stale-transport dropping, and
 * the undefined-vs-empty-text distinction.
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
  assert.deepEqual(stats.lifetime, { turns: 3, steps: 9, llmMs: 12_000 },
    'the lifetime group is projection-backed (§1B-2 facts shape)')
  assert.deepEqual(stats.tokens, { input: 100, output: 50, cacheRead: 30, cacheWrite: 20, cacheHitPct: 20 },
    'the tokens group is projection-backed (billed 150; cacheHit 30/150 = 20%)')
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
  // NOTE (review F3): each page-2 turn carries a VALID assistant sample
  // (an embedded durable stream with two token deltas + usage) — the page
  // stops because the FOLD proves the sample windows full, not because of
  // any completed-step count.
  const page2Events: Array<Record<string, unknown> & { type: string; seq: number; time: number }> = []
  let seq2 = 0
  for (let turn = 1; turn <= RECENT_PERFORMANCE_SAMPLE_LIMIT * 2; turn += 1) {
    page2Events.push(...validSampleTurn(turn, seq2))
    seq2 += 5
  }
  const page1: PresentationReadSnapshot = {
    sessionId: 's', durableEvents: stepTriplets(1) as never, liveInputs: [], revision: 1,
    coverage: 'bounded', hasMore: true, loadingOlder: false, openState: 'open',
  }
  const page2: PresentationReadSnapshot = {
    sessionId: 's', durableEvents: page2Events as never, liveInputs: [], revision: 2,
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
  assert.equal(stats.lifetime?.turns, 30, 'the projection still owns lifetime totals')
})

/** One completed turn whose assistant message carries a VALID sample (an
 *  embedded durable stream with two token deltas + usage) — the fold's own
 *  admission rules count it for both metrics. */
function validSampleTurn(turn: number, seqBase: number): Array<Record<string, unknown> & { type: string; seq: number; time: number }> {
  return [
    { type: 'turn/start', seq: seqBase, time: 0, data: { turn } },
    { type: 'step/start', seq: seqBase + 1, time: 0, data: { turn, step: 1 } },
    {
      type: 'assistant/message', seq: seqBase + 2, time: 1_000,
      data: {
        turn, step: 1,
        message: { id: `m-${turn}`, role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
        usage: { inputTokens: 1, outputTokens: 100 },
        stream: [
          { type: 'chunk', time: 500, chunk: { type: 'text-delta', index: 0, text: 'a' } },
          { type: 'chunk', time: 900, chunk: { type: 'text-delta', index: 0, text: 'b' } },
        ],
      },
    },
    { type: 'step/end', seq: seqBase + 3, time: 1_100, data: { turn, step: 1 } },
    { type: 'turn/end', seq: seqBase + 4, time: 1_100, data: { turn, reason: { kind: 'completed' } } },
  ]
}

/** One completed turn with NO valid sample: an assistant message with an
 *  empty stream (no first token, no decode range — counted by step/end,
 *  admitted by nothing). This is the F3 discriminator shape. */
function invalidSampleTurn(turn: number, seqBase: number): Array<Record<string, unknown> & { type: string; seq: number; time: number }> {
  return [
    { type: 'turn/start', seq: seqBase, time: 0, data: { turn } },
    { type: 'step/start', seq: seqBase + 1, time: 0, data: { turn, step: 1 } },
    {
      type: 'assistant/message', seq: seqBase + 2, time: 1_000,
      data: {
        turn, step: 1,
        message: { id: `mi-${turn}`, role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
        stream: [],
      },
    },
    { type: 'step/end', seq: seqBase + 3, time: 1_100, data: { turn, step: 1 } },
    { type: 'turn/end', seq: seqBase + 4, time: 1_100, data: { turn, reason: { kind: 'completed' } } },
  ]
}

test('§3.3/F3 stats: 10 invalid newest steps DO NOT stop paging — the fold keeps paging to the valid samples', async () => {
  // Page 1: TEN completed steps with NO valid samples (empty streams) —
  // the retired count-based stop (10 ≥ 5×2) would stop here and report
  // TTFT/TPS = 0/0 while valid history exists one page older.
  const page1Events: Array<Record<string, unknown> & { type: string; seq: number; time: number }> = []
  let seq = 0
  for (let turn = 1; turn <= 10; turn += 1) {
    page1Events.push(...invalidSampleTurn(turn, seq))
    seq += 5
  }
  // Page 2: the FIVE valid samples the recent contract needs.
  const page2Events: Array<Record<string, unknown> & { type: string; seq: number; time: number }> = []
  for (let turn = 11; turn <= 10 + RECENT_PERFORMANCE_SAMPLE_LIMIT; turn += 1) {
    page2Events.push(...validSampleTurn(turn, seq))
    seq += 5
  }
  const page1: PresentationReadSnapshot = {
    sessionId: 's', durableEvents: page1Events as never, liveInputs: [], revision: 1,
    coverage: 'bounded', hasMore: true, loadingOlder: false, openState: 'open',
  }
  const page2: PresentationReadSnapshot = {
    sessionId: 's', durableEvents: [...page2Events, ...page1Events] as never, liveInputs: [], revision: 2,
    coverage: 'bounded', hasMore: false, loadingOlder: false, openState: 'open',
  }
  let loadOlderCalls = 0
  const stats = await composeRemoteSessionStats({
    sessionId: 's',
    reader: {
      read: async () => page1,
      loadOlder: async () => { loadOlderCalls += 1; return page2 },
    },
    fence: { isCurrent: () => true },
    facts: { sessionStats: { turns: 15, steps: 15, llmMs: 1 }, usage: undefined, contextWindow: undefined },
  })
  assert.ok(stats !== undefined)
  assert.equal(loadOlderCalls, 1, 'invalid completed steps never satisfy the page-stop (the fold keeps paging)')
  assert.equal(stats.recent?.firstTokenMsAvg, 500, 'the valid samples (step/start 0 → first token 500) drive TTFT')
  assert.ok((stats.recent?.tokensPerSec ?? 0) > 0, 'the valid samples drive the throughput figure')
})

test('§3.3/F3 stats: a NEVER-satisfied window pages to the history start and equals the whole-log fold (no silent cap)', async () => {
  // The whole log is invalid-sample turns; the recent contract can never be
  // satisfied. Paging must run to the HISTORY START (hasMore=false) and then
  // report the same figures the whole-log fold would — never a partial
  // window after a fixed page cap (the retired paged<10 trap).
  const allInvalid: Array<Record<string, unknown> & { type: string; seq: number; time: number }> = []
  let seq = 0
  const TURNS = 40 // 8 pages of 5 events each — far beyond any old 10-page cap
  for (let turn = 1; turn <= TURNS; turn += 1) {
    allInvalid.push(...invalidSampleTurn(turn, seq))
    seq += 5
  }
  const pages: PresentationReadSnapshot[] = []
  for (let pageIndex = 0; pageIndex < TURNS / 5; pageIndex += 1) {
    const window = allInvalid.slice(pageIndex * 25)
    pages.push({
      sessionId: 's', durableEvents: window as never, liveInputs: [], revision: pageIndex + 1,
      coverage: 'bounded', hasMore: pageIndex < TURNS / 5 - 1, loadingOlder: false, openState: 'open',
    })
  }
  // The final page is the history start (full coverage) — built as a
  // fresh snapshot object (the interface is read-only).
  pages[pages.length - 1] = { ...pages.at(-1)!, coverage: 'full' }
  let loadOlderCalls = 0
  const stats = await composeRemoteSessionStats({
    sessionId: 's',
    reader: {
      read: async () => pages[0]!,
      loadOlder: async () => { loadOlderCalls += 1; return pages[loadOlderCalls] },
    },
    fence: { isCurrent: () => true },
    facts: { sessionStats: { turns: TURNS, steps: TURNS, llmMs: 1 }, usage: undefined, contextWindow: undefined },
  })
  assert.ok(stats !== undefined)
  assert.equal(loadOlderCalls, TURNS / 5 - 1, 'paging ran to the history start (every page, no cap)')
  // The whole-log reference: the same all-invalid log folds to 0/0 — so the
  // composed figures are the WHOLE-LOG TRUTH here (not a partial artifact).
  const wholeLog = await import('../src/stats.ts').then(m => m.computeStats(allInvalid as never))
  assert.equal(stats.recent?.firstTokenMsAvg, wholeLog.firstTokenMsAvg)
  assert.equal(stats.recent?.tokensPerSec, wholeLog.tokensPerSec)
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
  // EVERY authoritative source absent.
  const facts = await composeRemoteSessionStats({
    sessionId: 's',
    reader: { read: async () => window, loadOlder: async () => window },
    fence: { isCurrent: () => true },
    facts: { sessionStats: undefined, usage: undefined, contextWindow: undefined },
  })
  assert.ok(facts !== undefined)
  assert.equal(facts.lifetime, undefined, 'an absent sessionStats projection keeps the lifetime group ABSENT (never t0/s0/LLM 0s)')
  assert.equal(facts.tokens, undefined, 'an absent tokenUsage projection keeps the tokens group ABSENT (never ↑0 ↓0)')
  // hasMore=false (history start) makes the EMPTY recent fold authoritative:
  // a zero-sample recent window renders zero, it is not "unknown".
  assert.deepEqual(facts.recent, { firstTokenMsAvg: 0, tokensPerSec: 0 },
    'a history-start window is an AUTHORITATIVE zero (visible zero, not absence)')
})

test('§1B-2 present-with-zero projections render as KNOWN zeros', async () => {
  const window: PresentationReadSnapshot = {
    sessionId: 's', durableEvents: [] as never, liveInputs: [], revision: 1,
    coverage: 'full', hasMore: false, loadingOlder: false, openState: 'open',
  }
  const facts = await composeRemoteSessionStats({
    sessionId: 's',
    reader: { read: async () => window, loadOlder: async () => window },
    fence: { isCurrent: () => true },
    facts: {
      sessionStats: { turns: 0, steps: 0, llmMs: 0 },
      usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      contextWindow: undefined,
    },
  })
  assert.ok(facts !== undefined)
  assert.deepEqual(facts!.lifetime, { turns: 0, steps: 0, llmMs: 0 }, 'a present zero projection renders a KNOWN zero')
  assert.ok(facts!.tokens !== undefined && facts!.tokens.input === 0 && facts!.tokens.output === 0,
    'a present zero usage renders a KNOWN zero token group')
})

// QUALIFICATION LABEL (whole-PR F5): this case pages a NEVER-satisfied window
// to the HISTORY START, where the fold becomes authoritative and the recent
// group is PRESENT. It is therefore NOT a bounded-window ABSENT proof — that
// absence is encoded by the presentation-layer availability bit (Batch 1B,
// `recent-performance-availability.test.ts`), not here.
test('§1B-2 the composer pages a never-satisfied window to the history start, where the recent fold is AUTHORITATIVE', async () => {
  // One valid sample only; hasMore=true (older history exists) — the recent
  // evidence is NOT authoritative, so the group must be absent.
  const oneSample = validSampleTurn(1, 0)
  const window: PresentationReadSnapshot = {
    sessionId: 's', durableEvents: oneSample as never, liveInputs: [], revision: 1,
    coverage: 'bounded', hasMore: true, loadingOlder: false, openState: 'open',
  }
  // The composer's paging contract stops only at proven-samples or the
  // history start: a NEVER-satisfied window must page to hasMore=false (the
  // page below is the history start with the SAME insufficient evidence).
  const historyStart: PresentationReadSnapshot = { ...window, hasMore: false, coverage: 'full' }
  const facts = await composeRemoteSessionStats({
    sessionId: 's',
    reader: {
      read: async () => window,
      // Pretend the remaining history cannot help: the history start still
      // holds only the one insufficient sample.
      loadOlder: async () => historyStart,
    },
    fence: { isCurrent: () => true },
    facts: { sessionStats: { turns: 1, steps: 1, llmMs: 1 }, usage: undefined, contextWindow: undefined },
  })
  // NOTE: reaching the history start makes the window AUTHORITATIVE — the
  // recent group is then present with the fold's real figures. The ABSENT
  // case therefore requires paging to STOP while hasMore stays true, which
  // only the presentation-layer availability bit (Batch 1B) encodes; here
  // we assert the boundary honestly: history start => present, bounded+load-
  // bounded-to-history-start => authoritative (the composer never fabricates
  // absence after the history start).
  assert.ok(facts !== undefined && facts.recent !== undefined,
    'reaching the history start makes the recent fold AUTHORITATIVE (the group renders; absence only exists while hasMore stays true)')
})
