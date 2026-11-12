/**
 * T2 Stage 4 / PR3 — SYNTHETIC CLIENT LOAD subject.
 *
 * This is NOT the production Direct composition and says so in its own ledger:
 * it takes no Host Session claim, never touches a Direct Writer, and cannot
 * prove a production end-to-end claim. What it DOES exercise is the real shipped
 * SDK Surface (`connect` → one `mode:'inline'` Surface → real frames/ACK/gone)
 * driven by the PRODUCTION projection: `TranscriptFolder` →
 * `describeTranscriptMainBlocksForPreset` → `ContinuousMainJournal`. The input
 * history is the canonical deterministic fixture the PR2 benchmark uses.
 *
 * The flow writes `load-case.json` into the run directory BEFORE launching:
 *   { "payload": "plain"|"mixed", "turns": 100|1000|5000, "preset": "full"|"compact"|"focus" }
 *
 * Every measurement is appended to `events.jsonl`; the flow reads the client's
 * own tree/`stats`/`perf` for the client-side facts.
 * @module scripts/tern-pane-continuous-reading-load-subject
 */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { connect, ui, type SessionInput, type TspEvent } from '@stencil-hq/tern'
import { TranscriptFolder } from '../src/domain/transcript/folder.ts'
import type { TranscriptMessage } from '../src/domain/transcript/types.ts'
import { ContinuousMainJournal, emptyTranscriptMain } from '../src/tui/tsp/continuous-main.ts'
import {
  TranscriptNodeKeys,
  describeTranscriptMainBlocksForPreset,
  type TranscriptPresetViewOptions,
} from '../src/tui/tsp/transcript-view.ts'
import { buildMixedEvents, buildPlainEvents } from './support/tern-continuous-main-fixture.mts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const paneRoot = process.env.TERN_PANE_DIR
if (paneRoot === undefined) throw new Error('TERN_PANE_DIR is required by the continuous reading load subject')

const caseInput = JSON.parse(readFileSync(`${paneRoot}/load-case.json`, 'utf8')) as {
  readonly payload: 'plain' | 'mixed'
  readonly turns: number
  readonly preset: 'full' | 'compact' | 'focus'
}
const eventsPath = `${paneRoot}/events.jsonl`
// The shipped SDK records its wire only when this variable names a file. The
// pane environment is NOT inherited from `tern serve` (measured), so the subject
// sets it itself before `connect()`.
process.env.TERN_TSP_RECORD = `${paneRoot}/sdk-wire.jsonl`
const casePath = `${paneRoot}/case.json`
const caseResultPath = `${paneRoot}/case-result.json`
const note = (event: Record<string, unknown>): void => appendFileSync(eventsPath, `${JSON.stringify(event)}\n`)

const SCOPE = 's1-'
const LATEST_WINDOW = { mode: 'latest', hasNewer: false } as const
const VIEW_OPTIONS: TranscriptPresetViewOptions = {
  preset: caseInput.preset,
  scopePrefix: SCOPE,
  window: LATEST_WINDOW,
}
const eventsFor = (payload: 'plain' | 'mixed', turns: number): SessionEvent[] =>
  payload === 'plain' ? buildPlainEvents(turns) : buildMixedEvents(turns)

/** One deterministic appended tail turn: the same shape the bench uses. */
function tailEvents (turn: number): SessionEvent[] {
  const base = 1_000_000 + turn * 1000
  return [
    { type: 'turn/start', seq: 2_000_000 + turn * 10 - 1, time: base, data: { turn } },
    {
      type: 'user/message',
      seq: 2_000_000 + turn * 10,
      time: base + 1,
      data: {
        id: `load-tail-user-${turn}`,
        role: 'user',
        content: [{ type: 'text', text: `LOAD-TAIL-${String(turn).padStart(6, '0')} appended synthetic turn` }],
        source: { kind: 'user' },
      },
    },
    {
      type: 'assistant/message',
      seq: 2_000_001 + turn * 10,
      time: base + 2,
      data: {
        turn,
        step: 0,
        message: {
          id: `load-tail-msg-${turn}`,
          role: 'assistant',
          content: [{ type: 'text', text: `LOAD-TAIL-${String(turn).padStart(6, '0')} synthetic reply with CJK 尾部` }],
          source: { kind: 'assistant' },
        },
      },
    },
    { type: 'turn/end', seq: 2_000_002 + turn * 10, time: base + 3, data: { turn, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]
}

const session = await connect({ app: 'tern-reading-load', timeout: 3000 })
if (!session) throw new Error('the synthetic load subject must run inside a real Tern pane')
const surface = session.open({ mode: 'inline', title: 'continuous reading load' })

const folder = new TranscriptFolder()
const keys = new TranscriptNodeKeys()
/** The turns whose official `turn/end` the fixture already supplied. */
const completedTurns = new Set<number>()
const journal = new ContinuousMainJournal(surface)
const messagesOf = (): readonly TranscriptMessage[] => folder.messages()

const dock = (): ReturnType<typeof ui.col> => ui.col({ key: 'dock' },
  ui.text(`synthetic client load: ${caseInput.payload} × ${caseInput.turns} × ${caseInput.preset}`),
  ui.text('CLIENT_STRESS_SYNTHETIC'),
)
const renderBase = (): void => { surface.render({ main: emptyTranscriptMain(), dock: dock() }) }

/**
 * Mirrors the renderer's ONE settle whitelist (`src/tui/tsp/session.ts`
 * `settleImmutableUserRows`): only a top-level, attached, PURE User row whose
 * owning turn is PROVEN ended may be settled. This lane has no Session, so the
 * proof comes from the fixture's own `turn/end` events; every other kind stays
 * unsettled on purpose. Returns how many roots were settled.
 */
function settleFinalizedUserRows (blocks: readonly { readonly key: string; readonly owners: readonly TranscriptMessage[] }[]): number {
  const eligible: string[] = []
  for (const block of blocks) {
    if (block.owners.length !== 1) continue
    const message = block.owners[0]!
    if (message.kind !== 'user') continue
    if (!completedTurns.has(message.turn as number)) continue
    const content = (message as { readonly content?: readonly { readonly type: string }[] }).content
    if (content !== undefined && content.some(entry => entry.type === 'image')) continue
    if (!journal.isAttached(block.key)) continue
    eligible.push(block.key)
  }
  if (eligible.length > 0) journal.settle(eligible)
  return eligible.length
}

const trackTurns = (events: readonly SessionEvent[]): void => {
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const turn = (event.data as { readonly turn?: number }).turn
    if (typeof turn === 'number') completedTurns.add(turn)
  }
}

/** One measured commit on the production projection path. */
function commitTick (label: string): {
  readonly label: string
  readonly messages: number
  readonly materialized: number
  readonly ops: number
  readonly folderMs: number
  readonly descriptorMs: number
  readonly commitMs: number
  readonly totalMs: number
} {
  const start = performance.now()
  const messages = messagesOf()
  const folderMs = performance.now() - start
  const t1 = performance.now()
  const blocks = describeTranscriptMainBlocksForPreset(messages, keys, VIEW_OPTIONS)
  const descriptorMs = performance.now() - t1
  const t2 = performance.now()
  const stats = journal.commit(blocks)
  const settled = settleFinalizedUserRows(blocks)
  const commitMs = performance.now() - t2
  const sample = {
    label,
    messages: messages.length,
    materialized: stats.materialized.length,
    ops: stats.ops,
    settled,
    folderMs,
    descriptorMs,
    commitMs,
    totalMs: performance.now() - start,
  }
  note({ kind: 'load.tick', ...sample })
  return sample
}

// ── cold attach: fold the whole fixture, then materialize every block ──
renderBase()
const coldStart = performance.now()
const coldEvents = eventsFor(caseInput.payload, caseInput.turns)
trackTurns(coldEvents)
folder.apply(coldEvents)
const foldMs = performance.now() - coldStart
const cold = commitTick('cold')
note({
  kind: 'load.ready',
  payload: caseInput.payload,
  turns: caseInput.turns,
  preset: caseInput.preset,
  foldMs,
  cold,
  heapUsed: process.memoryUsage().heapUsed,
  rss: process.memoryUsage().rss,
  evidenceTier: 'CLIENT_STRESS_SYNTHETIC',
})
console.log('continuous reading load subject ready')

// ── command channel + the client's own events ──
let nextTailTurn = caseInput.turns
let lastCommandSeq = 0
const applyCommand = (): void => {
  let command: { readonly seq?: number; readonly kind?: string; readonly turns?: number }
  try {
    command = JSON.parse(readFileSync(casePath, 'utf8'))
  } catch {
    return
  }
  if (typeof command.seq !== 'number' || command.seq <= lastCommandSeq) return
  lastCommandSeq = command.seq
  if (command.kind !== 'append-tail' || typeof command.turns !== 'number') {
    throw new Error(`the synthetic load subject accepts only append-tail, got ${String(command.kind)}`)
  }
  const samples = []
  for (let index = 0; index < command.turns; index += 1) {
    nextTailTurn += 1
    const tail = tailEvents(nextTailTurn)
    trackTurns(tail)
    folder.apply(tail)
    samples.push(commitTick(`tail-${nextTailTurn}`))
  }
  const result = {
    seq: command.seq,
    status: 'ok',
    appended: command.turns,
    firstTailTurn: nextTailTurn - command.turns + 1,
    lastTailTurn: nextTailTurn,
    samples,
    heapUsed: process.memoryUsage().heapUsed,
    rss: process.memoryUsage().rss,
  }
  const temp = `${caseResultPath}.tmp`
  writeFileSync(temp, `${JSON.stringify(result)}\n`)
  renameSync(temp, caseResultPath)
  note({ kind: 'load.append.done', seq: command.seq, appended: command.turns, lastTailTurn: nextTailTurn })
}

const timer = setInterval(applyCommand, 100)
let stopping = false
const stop = async (): Promise<void> => {
  if (stopping) return
  stopping = true
  clearInterval(timer)
  note({ kind: 'load.final', payload: caseInput.payload, turns: caseInput.turns, preset: caseInput.preset, tailTurn: nextTailTurn })
  await surface.close({ keep: false })
  await session.close()
}
process.once('SIGTERM', () => { void stop() })
process.once('SIGINT', () => { void stop() })

for await (const input of session as AsyncIterable<SessionInput>) {
  if (input.type === 'key' && input.key.name === 'f10') break
  if (input.type !== 'event') continue
  const event = input.event as TspEvent
  if (event.ev === 'gone') {
    // The client's bounded retention: the production renderer retires exactly
    // these roots and never re-adds one without a real stamp change.
    const retired = journal.retireGone(event.ids)
    note({ kind: 'load.gone', frame: event.s ?? null, ids: event.ids, retired })
    if (retired.length > 0) renderBase()
    continue
  }
  if (event.ev === 'resize' && event.sf === surface.id) renderBase()
  if (event.ev === 'error') note({ kind: 'load.client.error', msg: event.msg, sf: event.sf ?? null, op: event.op ?? null })
}
await stop()
