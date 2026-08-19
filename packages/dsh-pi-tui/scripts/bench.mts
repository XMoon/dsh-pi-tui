#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/bench — non-default performance benchmark
 * (run explicitly: `node scripts/bench.mjs`; never part of the test suite).
 *
 * Builds synthetic session logs (markdown, diffs, consecutive reads, tool
 * calls, CJK/emoji) and measures, across widths and themes:
 *
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

const MARKDOWN_BLOCKS = [
  '## Findings\n\nThe **cache** now hits for unchanged messages, so `markdown` is not re-parsed every frame.\n\n```ts\nconst hit = cached.text === message.text\n```\n\n- one\n- two\n- three',
  '## Steps\n\n1. ingest events\n2. fold the projection\n3. render the tail\n\n> Only the visible window pays the expensive conversions.',
  '## 结论（CJK + emoji）\n\n缓存命中后 🐋🐳 单帧成本不再随完整历史线性增长。`宽度 40/80/160` 与主题切换均按 key 失效。',
]

const DIFF_BODY = 'diff --git a/src/a.ts b/src/a.ts\nindex 111..222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n const a = 1\n+const b = 2\n-const old = 3\n // tail'

/** Build `turns` turns of events; each turn ≈ 9 events. */
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

// --- the benchmark ----------------------------------------------------------

async function main(): Promise<void> {
  const rows: string[] = []
  const row = (label: string, value: string): void => { rows.push(`${label.padEnd(58)} ${value}`) }

  row('scenario', 'value')

  // 1. ingest + projection
  for (const turns of [111, 1111, 5555]) {
    const events = buildEvents(turns)
    const folder = new TranscriptFolder()
    const ingest = timeIt(3, () => folder.apply(events))
    const projection = timeIt(PROJ_SAMPLES, () => folder.messages())
    const st = stats(projection)
    row(`ingest ${events.length} events (${turns} turns)`, fmtMs(ingest[0]!))
    row(`  messages() ×200 (${folder.messages().length} messages)`, fmt(st))
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
    const streaming = [...messages]
    const target = streaming.findIndex(message => message.kind === 'assistant')
    const warmStream = timeIt(STREAM_SAMPLES, () => {
      const entry = streaming[target]
      if (entry !== undefined && entry.kind === 'assistant') entry.text += ' tail'
      app.setTranscript(streaming)
    })
    row(`  streaming 1 message/frame @${width}`, fmt(stats(warmStream)))
    // Theme switch cost (once per switch).
    const theme = timeIt(5, () => app.applyTheme('light'))
    row(`  theme dark→light @${width}`, fmtMs(theme[0]!))
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
    row(`heap growth per warm rebuild (${HEAP_REBUILDS}×, gc)`, `${((after - before) / 2000).toFixed(1)} B/rebuild`)
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

try {
  main()
} catch (error) {
  console.error(`bench: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
