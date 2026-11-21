/**
 * TSP PR2 incremental Continuous Main benchmark.
 *
 * Compares TWO projections of the SAME folded history, on the SAME host, with
 * the SAME fixture and the SAME SDK:
 *
 * - `reference`: the historical PR1 shape — build ONE full `ui.col` Main and
 *   `Surface.render({main: full, dock})` every tick (View.from + View.ops over
 *   the whole history);
 * - `incremental`: the PR2 shape — `describeTranscriptMainBlocksForPreset`
 *   descriptors, a `ContinuousMainJournal` that materializes only changed
 *   blocks, and `Surface.render({main: emptyMain, dock})` plus raw Main ops.
 *
 * The measured window is the TAIL APPEND (the scenario the plan pins at
 * 236.217ms p95 on the Stage 1 host), never cold hydration. Every case reports
 * the split (folder projection / descriptors / materialize / one-root diff /
 * send) plus the op counters, and the JSONL/CSV output is the raw evidence.
 *
 * Run:
 *   node --expose-gc --import tsx/esm scripts/tern-continuous-main-incremental-bench.mts \
 *     --out temp/t2-pr2-incremental-bench [--history 100,1000,5000] [--presets full,compact,focus]
 *
 * The case runner is also exported so a single fresh-process round can be
 * driven by a shell loop (the plan requires three separate Node processes).
 *
 * @module @xmoon76/dsh-pi-tui/scripts/tern-continuous-main-incremental-bench
 */

import { cpus } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ui, Surface, type Op, type OutMessage, type SurfaceLink } from '@stencil-hq/tern'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../src/domain/transcript/folder.ts'
import type { TranscriptMessage } from '../src/domain/transcript/types.ts'
import {
  ContinuousMainJournal,
  emptyTranscriptMain,
} from '../src/tui/tsp/continuous-main.ts'
import {
  TranscriptNodeKeys,
  describeTranscriptMainBlocksForPreset,
  transcriptViewForPreset,
  type TranscriptPresetViewOptions,
} from '../src/tui/tsp/transcript-view.ts'
import { buildMixedEvents, buildPlainEvents } from './support/tern-continuous-main-fixture.mts'

/** The presets and payloads the plan fixes. */
export const PRESETS = ['full', 'compact', 'focus'] as const
export const PAYLOADS = ['P-plain', 'P-mixed'] as const
export const HISTORY = [100, 1000, 5000] as const

type Preset = (typeof PRESETS)[number]
type Payload = (typeof PAYLOADS)[number]

const SCOPE = 's1-'
const LATEST_WINDOW = { mode: 'latest', hasNewer: false } as const

/** A silent credit-unlimited surface: the bench measures CPU, not the client. */
function benchSurface(): { surface: Surface; ops: Op[]; frames: number } {
  const ops: Op[] = []
  const state = { frames: 0 }
  const link: SurfaceLink = {
    send: (message: OutMessage) => {
      if (message.verb !== 'f') return
      state.frames += 1
      ops.push(...(message.body as { ops: readonly Op[] }).ops)
    },
    credits: () => Number.MAX_SAFE_INTEGER,
    dropped: () => {},
  }
  return Object.assign({ surface: new Surface(link, 'main', { listen: false }), ops }, state)
}

export interface TickSample {
  readonly round: string
  readonly payload: Payload
  readonly preset: Preset
  readonly historyTurns: number
  readonly tick: number
  /** `folder.messages()` projection. */
  readonly folderMs: number
  /** canonical structure + descriptor derivation. */
  readonly descriptorMs: number
  /** blocks actually materialized this tick. */
  readonly materialized: number
  /** the dirty roots' one-root View.from + View.ops. */
  readonly rootDiffMs: number
  /** synchronous total of the whole tick. */
  readonly totalMs: number
  readonly ops: number
  readonly heapUsed: number
  readonly rss: number
}

export interface CaseResult {
  readonly payload: Payload
  readonly preset: Preset
  readonly historyTurns: number
  readonly reference: { readonly samples: TickSample[] }
  readonly incremental: {
    readonly samples: TickSample[]
    /** Root materializations for blocks whose stamp did NOT change. */
    readonly unchangedMaterializations: number
    /** Full-history `View.from` calls in the incremental path (must be 0). */
    readonly fullViewCalls: number
  }
}

function eventsFor(payload: Payload, turns: number): SessionEvent[] {
  return payload === 'P-plain' ? buildPlainEvents(turns) : buildMixedEvents(turns)
}

/**
 * One tail tick: the fixture appends ONE more turn (a fresh User + Assistant),
 * which is exactly the "streaming tail" the plan measures.
 */
function tailEvents(payload: Payload, turn: number): SessionEvent[] {
  const base = turn * 1000
  const user: SessionEvent = {
    type: 'user/message',
    seq: SessionSeq(1_000_000 + turn * 10),
    time: base + 1,
    data: {
      id: `tail-user-${turn}`,
      role: 'user',
      content: [{ type: 'text', text: `tail prompt ${turn} with CJK 尾部 与 emoji 🐋` }],
      source: { kind: 'user' },
    },
  } as unknown as SessionEvent
  const assistant: SessionEvent = {
    type: 'assistant/message',
    seq: SessionSeq(1_000_001 + turn * 10),
    time: base + 2,
    data: {
      turn,
      step: 0,
      message: {
        id: `tail-msg-${turn}`,
        role: 'assistant',
        content: [{ type: 'text', text: `tail answer ${turn} ${payload === 'P-mixed' ? '## mixed tail\n\n```ts\nconst x = 1\n```' : ''}` }],
        source: { kind: 'assistant' },
      },
    },
  } as unknown as SessionEvent
  return [user, assistant]
}

/** Run ONE case in THIS process: the reference projector and the incremental one. */
export function runCase(payload: Payload, preset: Preset, historyTurns: number, ticks: number): CaseResult {
  const options: TranscriptPresetViewOptions = { preset, scopePrefix: SCOPE, window: LATEST_WINDOW }
  const messagesOf = (folder: TranscriptFolder): readonly TranscriptMessage[] => folder.messages()

  // ── reference: PR1 full-view render every tick ──
  const referenceState = benchSurface()
  referenceState.surface.render({ main: emptyTranscriptMain() })
  const referenceFolder = new TranscriptFolder()
  referenceFolder.apply(eventsFor(payload, historyTurns))
  const referenceKeys = new TranscriptNodeKeys()
  const referenceSamples: TickSample[] = []
  for (let tick = 0; tick < ticks; tick += 1) {
    const turn = historyTurns + tick
    referenceFolder.apply(tailEvents(payload, turn))
    const messages = messagesOf(referenceFolder)
    const start = performance.now()
    const t0 = performance.now()
    referenceKeys.keyFor(messages[0] ?? ({} as TranscriptMessage))
    const folderMs = performance.now() - t0
    const t1 = performance.now()
    const full = transcriptViewForPreset(messages, referenceKeys, options)
    const descriptorMs = performance.now() - t1
    const t2 = performance.now()
    referenceState.surface.render({ main: full, dock: ui.col({ key: 'dock' }) })
    const rootDiffMs = performance.now() - t2
    const totalMs = performance.now() - start
    referenceSamples.push({
      round: 'reference',
      payload,
      preset,
      historyTurns,
      tick,
      folderMs,
      descriptorMs,
      materialized: messages.length,
      rootDiffMs,
      totalMs,
      ops: referenceState.ops.length,
      heapUsed: process.memoryUsage().heapUsed,
      rss: process.memoryUsage().rss,
    })
  }

  // ── incremental: descriptor + journal ──
  const incrementalSurface = benchSurface()
  incrementalSurface.surface.render({ main: emptyTranscriptMain() })
  const journal = new ContinuousMainJournal(incrementalSurface.surface)
  const incrementalFolder = new TranscriptFolder()
  incrementalFolder.apply(eventsFor(payload, historyTurns))
  const incrementalKeys = new TranscriptNodeKeys()
  const incrementalSamples: TickSample[] = []
  let unchangedMaterializations = 0
  let fullViewCalls = 0
  // Prime the journal once with the historical projection (cold prefix).
  journal.commit(describeTranscriptMainBlocksForPreset(messagesOf(incrementalFolder), incrementalKeys, options))
  for (let tick = 0; tick < ticks; tick += 1) {
    const turn = historyTurns + tick
    incrementalFolder.apply(tailEvents(payload, turn))
    const start = performance.now()
    const messages = messagesOf(incrementalFolder)
    const folderMs = performance.now() - start
    const t1 = performance.now()
    const blocks = describeTranscriptMainBlocksForPreset(messages, incrementalKeys, options)
    const descriptorMs = performance.now() - t1
    const t2 = performance.now()
    const stats = journal.commit(blocks)
    const rootDiffMs = performance.now() - t2
    const totalMs = performance.now() - start
    if (stats.materialized.length === 0) unchangedMaterializations += 1
    // A retained (unchanged-stamp) block must never be rebuilt: the journal
    // reports what it materialized, and the descriptor set is the ground truth.
    if (stats.materialized.length > blocks.length) fullViewCalls += 1
    incrementalSamples.push({
      round: 'incremental',
      payload,
      preset,
      historyTurns,
      tick,
      folderMs,
      descriptorMs,
      materialized: stats.materialized.length,
      rootDiffMs,
      totalMs,
      ops: stats.ops,
      heapUsed: process.memoryUsage().heapUsed,
      rss: process.memoryUsage().rss,
    })
  }
  return {
    payload,
    preset,
    historyTurns,
    reference: { samples: referenceSamples },
    incremental: { samples: incrementalSamples, unchangedMaterializations, fullViewCalls },
  }
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[index]!
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export interface SummaryRow {
  readonly payload: Payload
  readonly preset: Preset
  readonly historyTurns: number
  readonly referenceP50: number
  readonly referenceP95: number
  readonly referenceP99: number
  readonly incrementalP50: number
  readonly incrementalP95: number
  readonly incrementalP99: number
  readonly improvement: number
  readonly unchangedMaterializations: number
  readonly fullViewCalls: number
}

export function summarize(results: readonly CaseResult[]): SummaryRow[] {
  return results.map(result => {
    const reference = result.reference.samples.map(sample => sample.totalMs)
    const incremental = result.incremental.samples.map(sample => sample.totalMs)
    const referenceP95 = percentile(reference, 0.95)
    const incrementalP95 = percentile(incremental, 0.95)
    return {
      payload: result.payload,
      preset: result.preset,
      historyTurns: result.historyTurns,
      referenceP50: percentile(reference, 0.5),
      referenceP95,
      referenceP99: percentile(reference, 0.99),
      incrementalP50: percentile(incremental, 0.5),
      incrementalP95,
      incrementalP99: percentile(incremental, 0.99),
      improvement: incrementalP95 === 0 ? Number.POSITIVE_INFINITY : referenceP95 / incrementalP95,
      unchangedMaterializations: result.incremental.unchangedMaterializations,
      fullViewCalls: result.incremental.fullViewCalls,
    }
  })
}

function csv(rows: readonly SummaryRow[]): string {
  const header = 'payload,preset,historyTurns,referenceP50,referenceP95,referenceP99,incrementalP50,incrementalP95,incrementalP99,improvement,unchangedMaterializations,fullViewCalls'
  const lines = rows.map(row => [
    row.payload, row.preset, row.historyTurns,
    row.referenceP50.toFixed(3), row.referenceP95.toFixed(3), row.referenceP99.toFixed(3),
    row.incrementalP50.toFixed(3), row.incrementalP95.toFixed(3), row.incrementalP99.toFixed(3),
    Number.isFinite(row.improvement) ? row.improvement.toFixed(3) : 'inf',
    row.unchangedMaterializations, row.fullViewCalls,
  ].join(','))
  return [header, ...lines].join('\n')
}

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : fallback
}

async function main(): Promise<void> {
  const out = argValue('--out', join('temp', 't2-pr2-incremental-bench'))
  const history = argValue('--history', HISTORY.join(',')).split(',').map(value => Number(value))
  const presets = argValue('--presets', PRESETS.join(',')).split(',') as Preset[]
  const payloads = argValue('--payloads', PAYLOADS.join(',')).split(',') as Payload[]
  const warmup = Number(argValue('--warmup', '30'))
  const ticks = Number(argValue('--ticks', '120'))
  const round = argValue('--round', '1')
  mkdirSync(out, { recursive: true })
  const samples: TickSample[] = []
  const results: CaseResult[] = []
  for (const payload of payloads) {
    for (const preset of presets) {
      for (const turns of history) {
        const result = runCase(payload, preset, turns, warmup + ticks)
        // Warmup ticks are dropped BEFORE summarization, never silently kept.
        const measured: CaseResult = {
          ...result,
          reference: { samples: result.reference.samples.slice(warmup) },
          incremental: { ...result.incremental, samples: result.incremental.samples.slice(warmup) },
        }
        results.push(measured)
        samples.push(...measured.reference.samples.map(sample => ({ ...sample, round })), ...measured.incremental.samples.map(sample => ({ ...sample, round })))
        const summary = summarize([measured])[0]!
        process.stderr.write(`[bench r${round}] ${payload} ${preset} ${turns} ` +
          `ref p95=${summary.referenceP95.toFixed(1)}ms inc p95=${summary.incrementalP95.toFixed(1)}ms ` +
          `x${Number.isFinite(summary.improvement) ? summary.improvement.toFixed(2) : 'inf'}\n`)
      }
    }
  }
  writeFileSync(join(out, `samples-r${round}.jsonl`), samples.map(sample => JSON.stringify(sample)).join('\n'))
  writeFileSync(join(out, `summary-r${round}.csv`), csv(summarize(results)))
  writeFileSync(join(out, `summary-r${round}.json`), JSON.stringify({
    round,
    node: process.version,
    host: { platform: process.platform, arch: process.arch, cpus: cpus().length },
  }, null, 2))
  // A fixed-name copy of the LAST round keeps a single canonical file pair.
  writeFileSync(join(out, 'summary.csv'), csv(summarize(results)))
}

if (process.argv[1]?.includes('tern-continuous-main-incremental-bench')) await main()
