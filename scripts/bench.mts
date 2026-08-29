#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/bench — non-default performance benchmark
 * (run explicitly: `node --import tsx/esm scripts/bench.mts`; never part of the test suite).
 *
 * Builds synthetic session logs (markdown, diffs, consecutive reads, tool
 * calls, CJK/emoji) and measures, across widths and themes:
 *
 *   - long-session folds: reasoning-heavy, adjacent-read, and 700k-like
 *     TranscriptFolder/StatsFolder apply and snapshot timings;
 *   - ingest: TranscriptFolder.apply() time per event count;
 *   - projection: messages() p50/p95/p99 (the incremental read-grouping);
 *   - rebuild: TuiApp.setTranscript cold (full markdown parse) vs warm
 *     (the stage-J per-message render cache) p50/p95/p99, including the
 *     20 Hz streaming case (one message's text replaced per frame);
 *   - theme switch cost;
 *   - heap: growth per warm rebuild and the settled working set.
 *
 * Output is a plain baseline table; run twice to compare. Requires a
 * Node version with native TypeScript stripping (>=22.6 with
 * --experimental-strip-types, or 24+).
 * @module bench
 */

import xterm from '@xterm/headless'
import { TuiApp } from '../src/tui-app.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import { StatsFolder } from '../src/stats.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TranscriptMessage } from '../src/transcript.ts'

const XtermTerminal = xterm.Terminal

/** A minimal headless terminal for TuiApp (render target only). */
class BenchTerminal {
  private readonly xterm: InstanceType<typeof XtermTerminal>
  constructor(columns: number, rows: number) {
    this.xterm = new XtermTerminal({ cols: columns, rows, disableStdin: true, allowProposedApi: true })
  }
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.xterm.write(data) }
  get columns(): number { return this.xterm.cols }
  get rows(): number { return this.xterm.rows }
  get kittyProtocolActive(): boolean { return false }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

// --- synthetic session content ---------------------------------------------
// NOTE: the CJK strings below are FUNCTIONAL benchmark fixtures, not
// user-facing copy: the wide-grapheme samples exercise the CJK width
// paths (get-east-asian-width, wrap + emoji) whose cost this script
// measures. The English-only rule applies to user-facing strings and
// comments; these samples are deliberately CJK — an English-only fixture
// would silently drop the wide-character code path from the benchmark.

const MARKDOWN_BLOCKS = [
  '## Findings\n\nThe **cache** now hits for unchanged messages, so `markdown` is not re-parsed every frame.\n\n```ts\nconst hit = cached.text === message.text\n```\n\n- one\n- two\n- three',
  '## Steps\n\n1. ingest events\n2. fold the projection\n3. render the tail\n\n> Only the visible window pays the expensive conversions.',
  '## 结论（CJK + emoji）\n\n缓存命中后 🐋🐳 单帧成本不再随完整历史线性增长。`宽度 40/80/160` 与主题切换均按 key 失效。',
]

const DIFF_BODY = 'diff --git a/src/a.ts b/src/a.ts\nindex 111..222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n const a = 1\n+const b = 2\n-const old = 3\n // tail'

/** Build `turns` turns of events; each turn is about 16 events. */
function buildEvents(turns: number): SessionEvent[] {
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 0; turn < turns; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, time: turn * 1000, data: { turn } } as SessionEvent)
    events.push({
      type: 'user/message', seq: seq++, time: turn * 1000 + 1, data: {
        content: [{ type: 'text', text: `user prompt ${turn} with CJK 你好 and emoji 🐋` }],
        source: { kind: 'user' },
      },
    } as SessionEvent)
    for (let chunk = 0; chunk < 8; chunk += 1) {
      events.push({
        type: 'assistant/chunk', seq: seq++, time: turn * 1000 + 2 + chunk, data: {
          turn, step: 0, index: chunk,
          chunk: { type: 'text-delta', index: chunk, text: MARKDOWN_BLOCKS[turn % 3]!.slice(chunk * 40, chunk * 40 + 40) },
        },
      } as SessionEvent)
    }
    events.push({
      type: 'assistant/message', seq: seq++, time: turn * 1000 + 11, data: {
        turn, step: 0,
        message: { id: `msg-${turn}`, role: 'assistant', content: [{ type: 'text', text: MARKDOWN_BLOCKS[turn % 3]! }], source: { kind: 'assistant' } },
      },
    } as SessionEvent)
    events.push({
      type: 'tool/call', seq: seq++, time: turn * 1000 + 12, data: {
        turn, step: 0, callId: `r${turn}`, name: 'read', arguments: JSON.stringify({ file: `src/file-${turn}.ts` }),
      },
    } as SessionEvent)
    events.push({
      type: 'tool/result', seq: seq++, time: turn * 1000 + 13, data: {
        turn, step: 0, message: {
          id: `m-${turn}`, role: 'user',
          content: [{ type: 'tool-result', toolCallId: `r${turn}`, content: [{ type: 'text', text: DIFF_BODY }] }],
          source: { kind: 'tool', callId: `r${turn}` },
        },
      },
    } as SessionEvent)
    events.push({
      type: 'tool/call', seq: seq++, time: turn * 1000 + 14, data: {
        turn, step: 0, callId: `b${turn}`, name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }),
      },
    } as SessionEvent)
    events.push({
      type: 'tool/result', seq: seq++, time: turn * 1000 + 15, data: {
        turn, step: 0, message: {
          id: `bm-${turn}`, role: 'user',
          content: [{ type: 'tool-result', toolCallId: `b${turn}`, content: [{ type: 'text', text: 'total 8\ndrwxr-xr-x 2 user user 4096 Aug 15 00:00 .\n-rw-r--r-- 1 user user 123 src/a.ts' }] }],
          source: { kind: 'tool', callId: `b${turn}` },
        },
      },
    } as SessionEvent)
    events.push({ type: 'turn/end', seq: seq++, time: turn * 1000 + 16, data: { turn, reason: { kind: 'completed' } } } as SessionEvent)
  }
  return events
}

/** Append a synthetic event while keeping fixture construction readable. */
function pushEvent(events: SessionEvent[], type: string, data: unknown): void {
  const seq = events.length
  events.push({ type, seq, time: seq, data } as SessionEvent)
}

/** Build reasoning-heavy history: every turn opens a reasoning entry before it settles. */
function buildReasoningHeavyEvents(turns: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    pushEvent(events, 'turn/start', { turn })
    pushEvent(events, 'step/start', { turn, step: 0 })
    for (let delta = 0; delta < 4; delta += 1) {
      pushEvent(events, 'assistant/chunk', {
        turn,
        step: 0,
        chunk: { type: 'reasoning-delta', index: delta, text: `reasoning ${turn}/${delta}` },
      })
    }
    pushEvent(events, 'assistant/message', {
      turn,
      step: 0,
      message: {
        id: `reasoning-message-${turn}`,
        role: 'assistant',
        content: [{ type: 'text', text: `answer ${turn}` }],
        source: { kind: 'model', provider: 'bench', model: 'bench' },
      },
      usage: { inputTokens: 100, outputTokens: 40 },
    })
    pushEvent(events, 'step/end', { turn, step: 0 })
    pushEvent(events, 'turn/end', { turn, reason: { kind: 'completed' } })
  }
  return events
}

/** Build a run of adjacent settled reads to exercise historical grouping. */
function buildReadHeavyEvents(turns: number, readsPerTurn: number): SessionEvent[] {
  const events: SessionEvent[] = []
  let call = 0
  for (let turn = 0; turn < turns; turn += 1) {
    pushEvent(events, 'turn/start', { turn })
    for (let read = 0; read < readsPerTurn; read += 1) {
      const callId = `read-${call++}`
      pushEvent(events, 'tool/call', {
        turn,
        step: 0,
        callId,
        name: 'read',
        arguments: JSON.stringify({ file: `src/file-${callId}.ts` }),
      })
      pushEvent(events, 'tool/result', {
        turn,
        step: 0,
        message: {
          id: `read-message-${callId}`,
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: `file ${callId}` }] }],
          source: { kind: 'tool', callId },
        },
      })
    }
    pushEvent(events, 'turn/end', { turn, reason: { kind: 'completed' } })
  }
  return events
}

const TEXT_HEAVY_BLOCK = 'The long-session fixture keeps a large assistant response and a large tool result in the folded history. '

function repeatedText(length: number): string {
  return TEXT_HEAVY_BLOCK.repeat(Math.ceil(length / TEXT_HEAVY_BLOCK.length)).slice(0, length)
}

/** Build a moderate-size text-heavy log without requiring real tokenization. */
function buildTextHeavyEvents(turns: number, assistantChars: number, resultChars: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    pushEvent(events, 'turn/start', { turn })
    pushEvent(events, 'user/message', {
      id: `text-heavy-user-${turn}`,
      role: 'user',
      content: [{ type: 'text', text: `summarize fixture ${turn}` }],
      source: { kind: 'user' },
    })
    pushEvent(events, 'step/start', { turn, step: 0 })
    pushEvent(events, 'assistant/message', {
      turn,
      step: 0,
      message: {
        id: `text-heavy-assistant-${turn}`,
        role: 'assistant',
        content: [{ type: 'text', text: repeatedText(assistantChars) }],
        source: { kind: 'model', provider: 'bench', model: 'bench' },
      },
      usage: { inputTokens: assistantChars, outputTokens: assistantChars },
    })
    pushEvent(events, 'step/end', { turn, step: 0 })
    const callId = `text-heavy-tool-${turn}`
    pushEvent(events, 'tool/call', {
      turn,
      step: 0,
      callId,
      name: 'bash',
      arguments: JSON.stringify({ command: 'cat large-output.txt' }),
    })
    pushEvent(events, 'tool/result', {
      turn,
      step: 0,
      message: {
        id: `text-heavy-result-${turn}`,
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: repeatedText(resultChars) }] }],
        source: { kind: 'tool', callId },
      },
    })
    pushEvent(events, 'turn/end', { turn, reason: { kind: 'completed' } })
  }
  return events
}

// --- measurement helpers ----------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]!
}

function stats(samples: number[]): { p50: number; p95: number; p99: number; mean: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length),
  }
}

function fmt(st: { p50: number; p95: number; p99: number; mean: number }): string {
  return `p50 ${st.p50.toFixed(2)}ms · p95 ${st.p95.toFixed(2)}ms · p99 ${st.p99.toFixed(2)}ms · mean ${st.mean.toFixed(2)}ms`
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(2)}ms`
}

/** Keep sub-millisecond projection timings visible in the report. */
function fmtDuration(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(2)}µs` : fmtMs(ms)
}

/** Run a callback `n` times and return per-call wall times. */
function timeIt(n: number, run: () => void): number[] {
  const samples: number[] = []
  for (let i = 0; i < n; i += 1) {
    const started = performance.now()
    run()
    samples.push(performance.now() - started)
  }
  return samples
}

/** Iteration counts; BENCH_FAST=1 shrinks them for quick before/after sweeps. */
const FAST = process.env.BENCH_FAST === '1'
const PROJ_SAMPLES = FAST ? 50 : 200
const WARM_SAMPLES = FAST ? 50 : 200
const STREAM_SAMPLES = FAST ? 50 : 200
const FULL_SAMPLES = FAST ? 20 : 50
const HEAP_REBUILDS = FAST ? 300 : 2000

/** Warm one callback, then report its median measured sample. */
function warmedP50(n: number, run: () => void): number {
  run()
  return stats(timeIt(n, run)).p50
}

/** Long-session projection timings are intentionally separate from renderer timings. */
interface LongSessionMetrics {
  transcriptApply: number
  statsApply: number
  snapshot: number
  messages: number
}

function measureLongSession(events: readonly SessionEvent[]): LongSessionMetrics {
  const samples = FAST ? 3 : 5
  const transcriptApply = warmedP50(samples, () => {
    const folder = new TranscriptFolder()
    folder.apply(events)
  })
  const statsApply = warmedP50(samples, () => {
    const folder = new StatsFolder()
    folder.apply(events)
  })
  const transcript = new TranscriptFolder()
  transcript.apply(events)
  const statsFolder = new StatsFolder()
  statsFolder.apply(events)
  // Snapshot is deliberately sampled repeatedly: the A2 regression was an
  // allocation-free scalar read, not a fold over every historical sample.
  const snapshot = timeIt(FAST ? 20 : 50, () => { statsFolder.snapshot() })
  return {
    transcriptApply,
    statsApply,
    snapshot: stats(snapshot).p50,
    messages: transcript.messages().length,
  }
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(0)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

// --- the benchmark ----------------------------------------------------------

async function main(): Promise<void> {
  const rows: string[] = []
  const row = (label: string, value: string): void => { rows.push(`${label.padEnd(58)} ${value}`) }

  row('scenario', 'value')

  // 1. ingest + projection
  for (const turns of [111, 1111, 5555]) {
    const events = buildEvents(turns)
    // Each timing sample gets a fresh folder. Re-applying the same log to a
    // stateful folder would benchmark duplicated history, not ingestion.
    const ingest = warmedP50(FAST ? 3 : 5, () => {
      const candidate = new TranscriptFolder()
      candidate.apply(events)
    })
    const folder = new TranscriptFolder()
    folder.apply(events)
    const projection = timeIt(PROJ_SAMPLES, () => folder.messages())
    const st = stats(projection)
    row(`ingest ${events.length} events (${turns} turns)`, fmtMs(ingest))
    row(`  messages() ×${PROJ_SAMPLES} (${folder.messages().length} messages)`, fmt(st))
  }

  // 1a. PR A long-session projection fixtures. These are intentionally
  // separate from the renderer benchmark so replay/fold regressions remain
  // visible even when the TUI cache masks them.
  for (const turns of [100, 500, 1000]) {
    const events = buildReasoningHeavyEvents(turns)
    const metrics = measureLongSession(events)
    const memory = process.memoryUsage()
    row(`reasoning-heavy ${events.length} events (${turns} turns)`, `${metrics.messages} messages`)
    row('  TranscriptFolder.apply', fmtMs(metrics.transcriptApply))
    row('  StatsFolder.apply', fmtMs(metrics.statsApply))
    row(`  StatsFolder.snapshot ×${FAST ? 20 : 50}`, fmtDuration(metrics.snapshot))
    row('  memory heapUsed/rss', `${fmtBytes(memory.heapUsed)} / ${fmtBytes(memory.rss)}`)
  }
  {
    const turns = 1
    const reads = 1000
    const events = buildReadHeavyEvents(turns, reads)
    const metrics = measureLongSession(events)
    const memory = process.memoryUsage()
    row(`read-heavy ${events.length} events (${reads} adjacent reads)`, `${metrics.messages} messages`)
    row('  TranscriptFolder.apply', fmtMs(metrics.transcriptApply))
    row('  StatsFolder.apply', fmtMs(metrics.statsApply))
    row(`  StatsFolder.snapshot ×${FAST ? 20 : 50}`, fmtDuration(metrics.snapshot))
    row('  memory heapUsed/rss', `${fmtBytes(memory.heapUsed)} / ${fmtBytes(memory.rss)}`)
  }
  {
    const turns = 20
    const events = buildTextHeavyEvents(turns, 18_000, 17_000)
    const metrics = measureLongSession(events)
    const memory = process.memoryUsage()
    row(`700k-like ${events.length} events (${turns} turns, ${turns * (18_000 + 17_000)} chars)`, `${metrics.messages} messages`)
    row('  TranscriptFolder.apply', fmtMs(metrics.transcriptApply))
    row('  StatsFolder.apply', fmtMs(metrics.statsApply))
    row(`  StatsFolder.snapshot ×${FAST ? 20 : 50}`, fmtDuration(metrics.snapshot))
    row('  memory heapUsed/rss', `${fmtBytes(memory.heapUsed)} / ${fmtBytes(memory.rss)}`)
  }

  // 2. rebuild (cold vs warm) across widths, plus the streaming case
  const turns = 555
  const folder = new TranscriptFolder()
  folder.apply(buildEvents(turns))
  const messages = folder.messages()
  for (const width of [40, 80, 160]) {
    // True cold: a fresh app whose FIRST setTranscript parses every message.
    const coldApp = new TuiApp(new BenchTerminal(width, 24) as never, { onSubmit: () => {}, onExit: () => {} })
    coldApp.start()
    const cold = timeIt(1, () => coldApp.setTranscript(messages))
    coldApp.stop()
    const terminal = new BenchTerminal(width, 24)
    const app = new TuiApp(terminal as never, { onSubmit: () => {}, onExit: () => {} })
    app.start()
    app.setTranscript(messages)
    const warm = timeIt(WARM_SAMPLES, () => app.setTranscript(messages))
    row(`rebuild ${messages.length} messages @${width} cols (cold, fresh app)`, fmtMs(cold[0]!))
    row(`  same content (warm cache)`, fmt(stats(warm)))
    // 20 Hz streaming: one assistant message's text replaced per frame.
    // Clone only the target card so the baseline fixture remains immutable for
    // the fullscreen and heap scenarios below; each frame keeps a fixed-size
    // replacement instead of appending an ever-growing suffix.
    const target = messages.findIndex(message => message.kind === 'assistant')
    const streaming = messages.map((message, index) => {
      if (index !== target || message.kind !== 'assistant') return message
      return { ...message }
    })
    const streamEntry = streaming[target]
    const streamBase = streamEntry?.kind === 'assistant' ? streamEntry.text : ''
    const streamPrefix = streamBase.slice(0, Math.max(0, streamBase.length - 8))
    let streamFrame = 0
    const warmStream = timeIt(STREAM_SAMPLES, () => {
      if (streamEntry !== undefined && streamEntry.kind === 'assistant') {
        streamEntry.text = `${streamPrefix}frame-${String(streamFrame++ % 100).padStart(2, '0')}`
      }
      app.setTranscript(streaming)
    })
    row(`  streaming 1 message/frame @${width}`, fmt(stats(warmStream)))
    // Theme switch cost: alternate palettes so every sample is a real switch.
    let themeFrame = 0
    const theme = timeIt(5, () => {
      app.applyTheme(themeFrame++ % 2 === 0 ? 'light' : 'dark')
    })
    row(`  theme dark↔light @${width}`, fmt(stats(theme)))
    app.stop()
  }

  // 3. fullscreen rebuild
  {
    const terminal = new BenchTerminal(120, 24)
    const app = new TuiApp(terminal as never, { onSubmit: () => {}, onExit: () => {} })
    app.start()
    app.setTranscript(messages)
    app.setFullscreen(true)
    const full = timeIt(FULL_SAMPLES, () => app.setTranscript(messages))
    row(`fullscreen rebuild ${messages.length} messages @120`, fmt(stats(full)))
    app.stop()
  }

  // 4. heap (requires --expose-gc)
  if (globalThis.gc !== undefined) {
    const terminal = new BenchTerminal(120, 24)
    const app = new TuiApp(terminal as never, { onSubmit: () => {}, onExit: () => {} })
    app.start()
    app.setTranscript(messages)
    const gc = globalThis.gc as () => void
    gc()
    const before = process.memoryUsage().heapUsed
    for (let i = 0; i < HEAP_REBUILDS; i += 1) app.setTranscript(messages)
    gc()
    const after = process.memoryUsage().heapUsed
    row(`heap growth per warm rebuild (${HEAP_REBUILDS}×, gc)`, `${((after - before) / Math.max(1, HEAP_REBUILDS)).toFixed(1)} B/rebuild`)
    gc()
    const settled = process.memoryUsage().heapUsed
    row(`settled heap for ${messages.length} messages @120`, `${(settled / 1024 / 1024).toFixed(1)} MiB`)
    app.stop()
  } else {
    row('heap (rerun with --expose-gc)', 'skipped')
  }

  // 5. extension plugin overhead (M11, plan §23): the frame cost with N
  //    widget/list contributions — no-plugin baseline vs 10 vs 50 — and a
  //    streaming-invalidation case (the batcher must coalesce bursts).
  const { ExtensionLedger } = await import('../src/extension/internal/ledger.ts')
  const { SurfaceHost } = await import('../src/extension/internal/surface-host.ts')
  const { WidgetOutlet } = await import('../src/extension/internal/widget-outlet.ts')
  for (const count of [0, 10, 50]) {
    const ledger = new ExtensionLedger()
    const host = new SurfaceHost(ledger, () => {})
    let renders = 0
    const outlet = new WidgetOutlet(ledger, { requestRender: () => { renders += 1 } }, 'input.widget.below')
    for (let index = 0; index < count; index++) {
      ledger.register('input.widget.below', { id: `w${index}`, order: index }, {
        view: { kind: 'text', spans: [{ text: `widget ${index}` }] },
        importance: index,
        maxHeight: 1,
      }, `owner-${index}`)
    }
    const t0 = process.hrtime.bigint()
    for (let frame = 0; frame < 200; frame += 1) outlet.refresh(0, 120, 4)
    const elapsed = Number(process.hrtime.bigint() - t0) / 200
    row(`widget outlet refresh ×${count} contributions (200 frames)`, `${elapsed.toFixed(0)} ns/frame`)
    void host
  }
  // Invalidation coalescing: 100 replaces in one tick → ONE flush.
  const { InvalidateBatcher } = await import('../src/extension/internal/batcher.ts')
  let flushCount = 0
  const batcher = new InvalidateBatcher({ requestRender: () => { flushCount += 1 } })
  for (let index = 0; index < 100; index += 1) batcher.invalidate()
  await Promise.resolve()
  row('invalidation burst coalescing (100 in one tick)', `${flushCount} flush(es)`)

  console.log(rows.join('\n'))
}

// Round-1 finding 2 (fixed in round 2 — the previous attempt silently
// failed to write): main() is async — dynamic imports and awaited stages
// reject ASYNCHRONOUSLY. A try/catch cannot observe a rejection; catch
// the PROMISE explicitly so any async failure exits non-zero (never an
// unhandled rejection with a zero exit code).
main().catch((error) => {
  console.error(`bench: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
