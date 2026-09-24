/**
 * Fullscreen Focus replay harness (investigation tooling, NOT production code).
 * See `docs/focus-replay-harness.md` for the full contract: valid-run
 * preconditions, every switch, the recorded evidence, the known false positives
 * and the acceptance procedure.
 *
 * It replays a recorded assistant stream through the real production path
 * (`TranscriptFolder.applyLiveInput` -> Focus projection -> `TuiApp.setTranscript`
 * -> `TuiAltScreen.doRender` -> `Terminal.write`) at the original arrival timing,
 * and records read-only evidence per paint, per flush and per transcript block.
 *
 * Sources:      REPLAY_SOURCE=trace (bundled capture) | session (exported JSONL;
 *               `REPLAY_TURN`/`REPLAY_STEP`/`REPLAY_HISTORY`, and
 *               `REPLAY_TURN_MODE=interleaved` for a whole turn's step timeline).
 * Cadences:     exact | wallclock (absolute arrival targets, required by
 *               `interleaved`) | immediate | batched.
 * Fidelity:     REPLAY_FLUSH=coalesced mirrors the runner's 50 ms `schedulePaint()`;
 *               `perevent` is NOT production-timing-faithful.
 * Terminal:     REPLAY_TERMINAL=1 drives a real `ProcessTerminal`.
 *
 * Cadence controls ONLY the input arrival schedule; render completion is always
 * observed through the `TuiAltScreen.doRender` boundary and the
 * `Terminal.write` recorder — never waited on with a sleep.
 *
 * Usage:
 *   PROBE_LABEL=REPRO REPLAY_CADENCE=exact node --import tsx/esm scripts/focus-replay-probe.mts
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import xterm from '@xterm/headless'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ProcessTerminal, TuiAltScreen } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import { TranscriptWindowController } from '../src/transcript-window.ts'
import type { AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'
import { VirtualTerminal } from '../test/virtual-terminal.ts'

const XtermTerminal = xterm.Terminal

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const LABEL = process.env.PROBE_LABEL ?? 'unlabeled'
const CADENCE = process.env.REPLAY_CADENCE ?? 'exact'
const COLUMNS = Number(process.env.REPLAY_COLUMNS ?? 22)
const ROWS = Number(process.env.REPLAY_ROWS ?? 29)
const TRACE_PATH = process.env.REPLAY_TRACE ?? join(REPO_ROOT, 'artifacts', 'focus-replay', 'trace-C.json')
const SOURCE = process.env.REPLAY_SOURCE ?? 'trace'
const SESSION_PATH = process.env.REPLAY_SESSION ?? '/tmp/sexp/session.v3.jsonl'
const SESSION_TURN = Number(process.env.REPLAY_TURN ?? 0)
const SESSION_STEP = Number(process.env.REPLAY_STEP ?? 0)
const PREFIX_REPLAY = process.env.REPLAY_PREFIX === '1'
/**
 * Real-terminal mode (diagnostic only): drive a real ProcessTerminal instead of
 * the xterm-headless VirtualTerminal. Nothing about production output changes
 * except the optional ?2026 diagnostic below.
 */
const REAL_TERMINAL = process.env.REPLAY_TERMINAL === '1'
/** Diagnostic ONLY: strip the synchronized-output markers so the terminal
 * applies each frame progressively. Never a production fix. */
const SYNC_OFF = process.env.REPLAY_SYNC === 'off'
/** Loop one heavy repaint window, e.g. REPLAY_WINDOW=374-393 REPLAY_LOOPS=6. */
const WINDOW = process.env.REPLAY_WINDOW ?? ''
const LOOPS = Number(process.env.REPLAY_LOOPS ?? 1)
const SETTLE_EACH = process.env.REPLAY_SETTLE_EACH === '1'
/** Speed multiplier for arrival timing (1.0 = original). */
const SPEED = Number(process.env.REPLAY_SPEED ?? 1)
/** Per-paint presentation/scroll reads are expensive; allow disabling them so
 * the replay can keep up with real arrival pressure. */
const PAINT_DETAIL = process.env.REPLAY_PAINT_DETAIL !== '0'
/** Per-block paint-time facts (heights + padding attachment). Read-only. */
const PAINT_BLOCKS = process.env.REPLAY_PAINT_BLOCKS === '1'
/**
 * Production scheduling fidelity. Production NEVER flushes the transcript per
 * delta: `onInput` applies the fold immediately and calls `schedulePaint()`,
 * which coalesces into one `repaint()` (= window + setTranscript) per
 * REPAINT_FLUSH_MS. `perevent` (harness default) hoists that flush into the
 * per-delta hot path and is therefore NOT timing-faithful.
 */
const FLUSH_MODE = process.env.REPLAY_FLUSH ?? 'coalesced'
const REPAINT_FLUSH_MS = 50
/** DIAGNOSTIC ONLY: override the production flush interval to probe whether a
 * more aggressive flush cadence makes the reflow pressure visible. 50 is the
 * production value; anything else is not production semantics. */
const FLUSH_MS = Number(process.env.REPLAY_FLUSH_MS ?? REPAINT_FLUSH_MS)
/** Visible freeze (ms) between the disclosure precondition and the stream, so
 * the operator can tell the automated expansion phase apart from the streaming
 * phase they are asked to judge. Not a synchronisation mechanism. */
const TURN_MODE = process.env.REPLAY_TURN_MODE ?? 'singlestep'
/** The turn the live stream belongs to (trace fixtures stream turn 1). */
const LIVE_TURN = (process.env.REPLAY_SOURCE ?? 'trace') === 'session'
  ? Number(process.env.REPLAY_TURN ?? 0)
  : 1
const SETTLE_BEFORE_STREAM_MS = Number(process.env.REPLAY_SETTLE_BEFORE_STREAM ?? 0)
const PRESSURE_DIR = join(REPO_ROOT, 'artifacts', 'focus-markdown-finalize-pressure')
const BEGIN_SYNC_MARKER = '\x1b[?2026h'
const END_SYNC_MARKER = '\x1b[?2026l'
const OUT_DIR = join(REPO_ROOT, 'artifacts', 'focus-replay')

const T0 = 1_700_000_000_000
const OLD_SENTINEL = 'OLD_SENTINEL_456'
const BEGIN_SYNC = '\x1b[?2026h'
const END_SYNC = '\x1b[?2026l'

/** Live-body markers taken from the REAL captured answer (never synthetic). */
const LIVE_BODY = /排序算法|bubbleSort|冒泡排序通过/
const OLD_BODY = /OLD_SENTINEL_456|HIST-\d\d/

const TOKEN_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b[@-Z\\-_]|[^\x1b]+|\x1b/g

function tokenize(data: string): string[] {
  return data.match(TOKEN_PATTERN) ?? []
}

function classifyToken(token: string): string {
  if (token === BEGIN_SYNC) return 'BEGIN_SYNC'
  if (token === END_SYNC) return 'END_SYNC'
  if (token.includes('\x1b[2J')) return 'CLEAR_SCREEN'
  if (token.includes('\x1b[2K')) return 'ERASE_LINE'
  if (/^\x1b\[\d+;1H$/.test(token)) return 'CURSOR_ROW'
  if (token.startsWith('\x1b]')) return 'OSC'
  if (token.startsWith('\x1b[')) return 'CSI'
  if (token.startsWith('\x1b')) return 'ESC'
  return 'TEXT'
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[sorted.length >> 1]!
}

function hash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

function countRows(rows: readonly string[], pattern: RegExp): number {
  return rows.reduce((total, row) => total + (pattern.test(row) ? 1 : 0), 0)
}

interface TraceEvent {
  readonly seq: number
  readonly kind: 'reasoning-delta' | 'text-delta'
  readonly blockIndex: number
  readonly delta: string
  readonly tOffsetMs: number
}

interface Trace {
  readonly source: string
  readonly model: string
  readonly prompt: string
  readonly text: string
  readonly reasoning: string
  readonly events: readonly TraceEvent[]
}

function loadTrace(): Trace {
  if (!existsSync(TRACE_PATH)) throw new Error(`trace not found: ${TRACE_PATH}`)
  return JSON.parse(readFileSync(TRACE_PATH, 'utf8')) as Trace
}

/**
 * One exported `assistant/message` stream, expanded with the Harness's own
 * `expandAssistantStream()` — every original delta boundary and timestamp is
 * preserved (lossless compact `text-chunks` / `reasoning-chunks` /
 * `tool-call-chunks` records plus raw control chunks).
 */
async function sessionInputs(): Promise<{
  inputs: Array<{ event: TraceEvent; input: AssistantLiveInput }>
  timeline: Array<Record<string, unknown>>
  settlement: Array<Record<string, unknown>>
  history: Array<Record<string, unknown>>
  answerMarkers: string[]
  meta: Record<string, unknown>
}> {
  const { expandAssistantStream } = await import('@deepseek-ai/dsh-llm/assistant-stream')
  const events: Array<Record<string, unknown>> = []
  for (const line of readFileSync(SESSION_PATH, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    events.push(JSON.parse(line))
  }
  globalThis.__sessionEvents = events
  const durableSteps = new Set(
    events.filter(event => event.type === 'assistant/message' && (event.data as any).turn === SESSION_TURN)
      .map(event => (event.data as any).step as number),
  )
  const lastStep = Math.max(0, ...durableSteps)
  if (TURN_MODE === 'interleaved') {
    const turnEvents = events
      .filter(candidate => (candidate.data as any)?.turn === SESSION_TURN)
      .sort((left, right) => (left.seq as number) - (right.seq as number))
    const origin = Math.min(...turnEvents.map(event => event.time as number))
    const timeline: Array<Record<string, unknown>> = []
    let chunkCount = 0
    for (const event of turnEvents) {
      const stream = (event.data as any).stream ?? []
      if (event.type === 'assistant/message' && stream.length > 0) {
        const expanded = expandAssistantStream(stream)
        chunkCount += expanded.length
        expanded.forEach((entry, index) => {
          const chunk = entry.chunk as Record<string, unknown> & { type: string }
          timeline.push({
            at: entry.time - origin,
            kind: 'live',
            entry: {
              event: {
                seq: index,
                kind: chunk.type === 'reasoning-delta' ? 'reasoning-delta' : 'text-delta',
                blockIndex: typeof chunk.index === 'number' ? chunk.index : -1,
                delta: chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'
                  ? String(chunk.text ?? '') : '',
                tOffsetMs: entry.time - origin,
              },
              input: {
                kind: 'chunk', sessionId: 'session-replay', attemptId: 'a',
                turn: SESSION_TURN, step: (event.data as any).step,
                time: entry.time, chunk,
              } as AssistantLiveInput,
            },
          })
        })
      }
      timeline.push({ at: (event.time as number) - origin, kind: 'durable', event })
    }
    // The live attempt's explicit start (production always opens one), so the
    // disclosure precondition can act on the live turn before its first chunk.
    const firstStep = (turnEvents.find(event => event.type === 'assistant/message')?.data as any)?.step ?? 1
    timeline.push({
      at: -1,
      kind: 'live',
      entry: {
        event: { seq: -1, kind: 'text-delta', blockIndex: -1, delta: '', tOffsetMs: 0 },
        input: { kind: 'start', sessionId: 'session-replay', attemptId: 'a', turn: SESSION_TURN, step: firstStep },
      },
    })
    timeline.sort((left, right) => (left.at as number) - (right.at as number))
    // Real history turns (REPLAY_HISTORY) applied durably before the stream —
    // the whole-turn replay must use the exported transcript, never the
    // synthetic OLD_SENTINEL fixture.
    const interleavedHistoryTurns = (process.env.REPLAY_HISTORY ?? '')
      .split(',').map(part => Number(part.trim())).filter(value => Number.isFinite(value) && value > 0)
    const interleavedHistory = interleavedHistoryTurns.length === 0 ? [] : events
      .filter(candidate => {
        const data = candidate.data as any
        return typeof data?.turn === 'number' && interleavedHistoryTurns.includes(data.turn)
      })
      .sort((left, right) => (left.seq as number) - (right.seq as number))
    // Answer sentinels from the turn's FINAL text step, so a one-frame absence of
    // the streaming answer itself is detectable (not just a slot proxy).
    const finalText = turnEvents
      .filter(event => event.type === 'assistant/message')
      .map(event => ((event.data as any).message?.content ?? [])
        .filter((block: any) => block.type === 'text').map((block: any) => block.text as string).join('\n'))
      .filter((text: string) => text.length > 0).at(-1) ?? ''
    const answerMarkers: string[] = []
    for (const piece of finalText.split(/[\s\n]+/)) {
      const clean = piece.replace(/[`*|>#-]/g, '')
      if (clean.length >= 6 && clean.length <= 12 && !answerMarkers.includes(clean)) answerMarkers.push(clean)
      if (answerMarkers.length >= 6) break
    }
    return {
      inputs: [], timeline, settlement: [], history: interleavedHistory, answerMarkers,
      meta: {
        source: `exported session ${SESSION_PATH}`, mode: 'interleaved', turn: SESSION_TURN,
        timelineItems: timeline.length, liveChunks: chunkCount,
        historyTurns: interleavedHistoryTurns,
        steps: turnEvents.filter(event => event.type === 'assistant/message').length,
      },
    }
  }
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    if ((event.data as any).turn !== SESSION_TURN) continue
    if (SESSION_STEP !== 0 && (event.data as any).step !== SESSION_STEP) continue
    const stream = (event.data as any).stream ?? []
    const expanded = expandAssistantStream(stream)
    const time0 = expanded[0]!.time
    const inputs: Array<{ event: TraceEvent; input: AssistantLiveInput }> = []
    inputs.push({
      event: { seq: -1, kind: 'text-delta', blockIndex: -1, delta: '', tOffsetMs: 0 },
      input: { kind: 'start', sessionId: 'session-replay', attemptId: 'a', turn: SESSION_TURN, step: event.data.step },
    })
    expanded.forEach((entry, index) => {
      const chunk = entry.chunk as Record<string, unknown> & { type: string }
      const blockIndex = typeof chunk.index === 'number' ? chunk.index : -1
      const delta = chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'
        ? String(chunk.text ?? '')
        : chunk.type === 'tool-call-delta' ? String(chunk.argumentsDelta ?? '') : ''
      inputs.push({
        event: {
          seq: index,
          kind: chunk.type === 'reasoning-delta' ? 'reasoning-delta' : 'text-delta',
          blockIndex,
          delta,
          tOffsetMs: entry.time - time0,
        },
        input: {
          kind: 'chunk',
          sessionId: 'session-replay',
          attemptId: 'a',
          turn: SESSION_TURN,
          step: event.data.step,
          time: entry.time,
          chunk,
        } as AssistantLiveInput,
      })
    })
    inputs.push({
      event: { seq: expanded.length, kind: 'text-delta', blockIndex: -1, delta: '', tOffsetMs: expanded.at(-1)!.time - time0 },
      input: { kind: 'end', sessionId: 'session-replay', attemptId: 'a', turn: SESSION_TURN, step: event.data.step, status: 'committed', settlement: 'message' },
    })
    // The durable settlement that follows the live attempt: this is the moment
    // the final message is published to the transcript.
    const settlement: Array<Record<string, unknown>> = []
    if (process.env.REPLAY_SETTLE !== '0') {
      const step = (event.data as any).step as number
      settlement.push(event)
      for (const candidate of events) {
        const type = candidate.type as string
        const data = candidate.data as any
        if (type === 'step/end' && data.turn === SESSION_TURN && data.step === step) settlement.push(candidate)
        if (type === 'turn/end' && data.turn === SESSION_TURN && step === lastStep) settlement.push(candidate)
      }
    }
    const answerText = ((event.data as any).message?.content ?? [])
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text as string)
      .join('\n')
    // Short unique substrings of the FINAL answer: the terminal-level sentinel
    // for "the final message is visible".
    const answerMarkers: string[] = []
    for (const chunk of answerText.split(/[\s\n]+/)) {
      const clean = chunk.replace(/[`*|>#-]/g, '')
      if (clean.length >= 6 && clean.length <= 12 && !answerMarkers.includes(clean)) answerMarkers.push(clean)
      if (answerMarkers.length >= 6) break
    }
    // Real historical turns applied durably BEFORE the live stream, so the
    // transcript has multiple Thought roots that must all be expanded.
    const historyTurns = (process.env.REPLAY_HISTORY ?? '')
      .split(',').map(part => Number(part.trim())).filter(value => Number.isFinite(value) && value > 0)
    const history = historyTurns.length === 0 ? [] : events
      .filter(candidate => {
        const data = candidate.data as any
        return typeof data?.turn === 'number' && historyTurns.includes(data.turn)
      })
      .sort((left, right) => (left.seq as number) - (right.seq as number))

    return {
      inputs,
      timeline,
      settlement,
      history,
      answerMarkers,
      meta: {
        source: `exported session ${SESSION_PATH}`,
        turn: SESSION_TURN,
        step: (event.data as any).step,
        chunks: expanded.length,
        settlementEvents: settlement.map(entry => entry.type),
        answerMarkers,
      },
    }
  }
  throw new Error(`no assistant/message for turn ${SESSION_TURN} step ${SESSION_STEP} in ${SESSION_PATH}`)
}

/** Real deltas -> AssistantLiveInput, preserving order; block-start is emitted once. */
function toLiveInputs(trace: Trace): Array<{ event: TraceEvent; input: AssistantLiveInput }> {
  const inputs: Array<{ event: TraceEvent; input: AssistantLiveInput }> = []
  const opened = new Set<number>()
  let step = 1
  inputs.push({
    event: { seq: -1, kind: 'text-delta', blockIndex: -1, delta: '', tOffsetMs: 0 },
    input: { kind: 'start', sessionId: 'replay', attemptId: 'a', turn: 1, step },
  })
  for (const event of trace.events) {
    if (!opened.has(event.blockIndex)) {
      opened.add(event.blockIndex)
      inputs.push({
        event,
        input: {
          kind: 'chunk',
          sessionId: 'replay',
          attemptId: 'a',
          turn: 1,
          step,
          time: T0 + event.tOffsetMs,
          chunk: {
            type: 'block-start',
            index: event.blockIndex,
            blockType: event.kind === 'reasoning-delta' ? 'reasoning' : 'text',
          },
        },
      })
    }
    inputs.push({
      event,
      input: {
        kind: 'chunk',
        sessionId: 'replay',
        attemptId: 'a',
        turn: 1,
        step,
        time: T0 + event.tOffsetMs,
        chunk: {
          type: event.kind,
          index: event.blockIndex,
          text: event.delta,
        },
      },
    })
  }
  inputs.push({
    event: { seq: trace.events.length, kind: 'text-delta', blockIndex: -1, delta: '', tOffsetMs: trace.events.at(-1)?.tOffsetMs ?? 0 },
    input: { kind: 'end', sessionId: 'replay', attemptId: 'a', turn: 1, step, status: 'committed', settlement: 'message' },
  })
  return inputs
}

/**
 * Label the append-only delta by the Markdown structure it can complete. This is
 * a LABEL for correlation only — never a parser and never used for rendering.
 */
function structuralKind(delta: string): string | null {
  if (delta.includes('```')) return 'fence-delimiter'
  if (/^\|?\s*-{3,}/.test(delta) || delta.includes('---')) return 'table-delimiter-or-rule'
  if (delta.includes('|')) return 'table-cell'
  if (delta.includes('\n')) return 'line-break'
  if (delta.includes('- ') && delta.startsWith('-')) return 'list'
  if (delta.includes('#')) return 'heading'
  return null
}

function maskAnimatedGlyph(row: string): string {
  return row.includes('Working...') ? row.replace(/^\S+/, 'WORKING') : row
}

function findTransientRuns(presence: readonly boolean[], target: boolean, skipFirstRun = false): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = []
  let index = 0
  let seen = false
  while (index < presence.length) {
    if (presence[index] !== target) {
      index += 1
      continue
    }
    let end = index
    while (end + 1 < presence.length && presence[end + 1] === target) end += 1
    const before = index > 0 ? presence[index - 1] : undefined
    const after = end + 1 < presence.length ? presence[end + 1] : undefined
    if (before === !target && after === !target) {
      if (!(skipFirstRun && !seen)) result.push({ start: index, end })
      seen = true
    }
    index = end + 1
  }
  return result
}

function terminalEnv(): Record<string, unknown> {
  const env = process.env
  return {
    TERM: env.TERM ?? null,
    TERM_PROGRAM: env.TERM_PROGRAM ?? null,
    TERM_PROGRAM_VERSION: env.TERM_PROGRAM_VERSION ?? null,
    COLORTERM: env.COLORTERM ?? null,
    WT_SESSION: env.WT_SESSION ?? null,
    TMUX: env.TMUX ?? null,
    ZELLIJ: env.ZELLIJ ?? null,
    STY: env.STY ?? null,
    tty: REAL_TERMINAL ? 'process-terminal' : 'xterm-headless',
    columns: REAL_TERMINAL ? terminalColumns() : COLUMNS,
    rows: REAL_TERMINAL ? terminalRows() : ROWS,
    syncOutput: SYNC_OFF ? 'off (diagnostic)' : 'on',
  }
}

function terminalColumns(): number {
  return process.stdout.columns ?? Number(process.env.COLUMNS_OVERRIDE ?? COLUMNS)
}
function terminalRows(): number {
  return process.stdout.rows ?? Number(process.env.ROWS_OVERRIDE ?? ROWS)
}

const LOG_PATH = process.env.REPLAY_LOG ?? ''
if (REAL_TERMINAL && LOG_PATH !== '') {
  const { appendFileSync } = await import('node:fs')
  const write = (line: string): void => { appendFileSync(LOG_PATH, `${line}\n`) }
  console.log = (...args: unknown[]): void => { write(args.map(String).join(' ')) }
  console.error = (...args: unknown[]): void => { write(args.map(String).join(' ')) }
  process.on('uncaughtException', error => { write(`UNCAUGHT ${String(error?.stack ?? error)}`); process.exit(1) })
}

async function main(): Promise<void> {
  // F22: the numeric switches are user input, so their DOMAIN is validated here
  // (the combination checks below only compare values). An unvalidated SPEED of
  // 0/negative/NaN would make every paced wait a divide-by-zero, a negative
  // setTimeout or a NaN while the artifact still records `metrics.speed`.
  if (!Number.isFinite(SPEED) || SPEED <= 0) {
    throw new Error(`REPLAY_SPEED must be a finite number > 0 (got ${process.env.REPLAY_SPEED})`)
  }
  if (!Number.isInteger(LOOPS) || LOOPS < 1) {
    throw new Error(`REPLAY_LOOPS must be an integer >= 1 (got ${process.env.REPLAY_LOOPS})`)
  }
  if (!Number.isFinite(FLUSH_MS) || FLUSH_MS < 0) {
    throw new Error(`REPLAY_FLUSH_MS must be a finite number >= 0 (got ${process.env.REPLAY_FLUSH_MS})`)
  }
  if (!Number.isFinite(SETTLE_BEFORE_STREAM_MS) || SETTLE_BEFORE_STREAM_MS < 0) {
    throw new Error('REPLAY_SETTLE_BEFORE_STREAM must be a finite number >= 0'
      + ` (got ${process.env.REPLAY_SETTLE_BEFORE_STREAM})`)
  }
  if (SOURCE === 'session' && (!Number.isInteger(SESSION_TURN) || SESSION_TURN < 1)) {
    throw new Error(`REPLAY_SOURCE=session requires REPLAY_TURN to be a positive integer (got ${process.env.REPLAY_TURN})`)
  }
  if (process.env.REPLAY_STEP !== undefined && (!Number.isInteger(SESSION_STEP) || SESSION_STEP < 1)) {
    throw new Error(`REPLAY_STEP must be a positive integer (got ${process.env.REPLAY_STEP})`)
  }
  // F23: a malformed, reversed or non-matching REPLAY_WINDOW would dispatch zero
  // heavy events while the artifact still carries the precondition screens, so
  // the oracle could report a clean run that tested nothing. Validate the range
  // here and require it to match events before any replay work.
  let validatedWindow: [number, number] | null = null
  if (WINDOW !== '') {
    const parts = WINDOW.split('-').map(part => Number(part.trim()))
    if (parts.length !== 2 || !parts.every(part => Number.isInteger(part))
      || parts[0]! < 0 || parts[0]! > parts[1]!) {
      throw new Error(`REPLAY_WINDOW must be "<from>-<to>" with integers 0 <= from <= to (got ${WINDOW})`)
    }
    validatedWindow = [parts[0]!, parts[1]!]
  }
  // F9: an invalid switch combination must fail loudly. `interleaved` needs the
  // exported session's compact stream records; with REPLAY_SOURCE=trace there is
  // no timeline and the wallclock branch would silently replay a single stream.
  if (TURN_MODE === 'interleaved' && SOURCE !== 'session') {
    throw new Error('REPLAY_TURN_MODE=interleaved requires REPLAY_SOURCE=session'
      + ' (only an exported session carries the compact whole-turn stream timeline)')
  }
  // F14: the interleaved timeline dispatches the whole turn exactly once. These
  // two switches would be silently ignored on that path, so they are rejected.
  if (TURN_MODE === 'interleaved' && WINDOW !== '') {
    throw new Error('REPLAY_WINDOW is not supported with REPLAY_TURN_MODE=interleaved'
      + ' (the window path dispatches the single-stream input list)')
  }
  if (TURN_MODE === 'interleaved' && LOOPS > 1) {
    throw new Error('REPLAY_LOOPS is not supported with REPLAY_TURN_MODE=interleaved'
      + ' (the whole-turn timeline is dispatched exactly once)')
  }
  // F17/F18/F19: every switch that a mode would otherwise SILENTLY ignore is
  // rejected here, so the documented applicability matrix cannot drift from the
  // code without a loud failure.
  if (SPEED !== 1 && CADENCE !== 'wallclock' && WINDOW === '') {
    throw new Error(`REPLAY_SPEED=${SPEED} is honoured by the REPLAY_WINDOW loop and by`
      + ` REPLAY_CADENCE=wallclock (got ${CADENCE} without REPLAY_WINDOW; SPEED is`
      + ' intentionally not implemented for exact, and immediate/batched have no absolute schedule)')
  }
  if (LOOPS > 1 && WINDOW === '' && (CADENCE === 'immediate' || CADENCE === 'batched')) {
    throw new Error(`REPLAY_LOOPS=${LOOPS} is not supported by REPLAY_CADENCE=${CADENCE}`
      + ' without REPLAY_WINDOW (use exact or wallclock, or loop a REPLAY_WINDOW)')
  }
  if (SETTLE_EACH && WINDOW === '') {
    throw new Error('REPLAY_SETTLE_EACH=1 only applies inside the REPLAY_WINDOW loop')
  }
  if (process.env.REPLAY_SETTLE === '0' && SOURCE !== 'session') {
    console.log('[replay] warning: REPLAY_SETTLE has no effect for REPLAY_SOURCE=trace'
      + ' (a trace fixture carries no session settlement)')
  }
  if (REAL_TERMINAL) {
    console.log(`[replay] real terminal: ${JSON.stringify(terminalEnv())}`)
    console.log(`[replay] window=${WINDOW || 'full'} loops=${LOOPS} sync=${SYNC_OFF ? 'off (diagnostic)' : 'on'}`)
    console.log('[replay] Thought roots are expanded programmatically (same op as clicking each header);')
    console.log('[replay] Thinking detail is left at its default; the app never sends Ctrl+O.')
  }
  const trace = SOURCE === 'session' ? null : loadTrace()
  const session = SOURCE === 'session' ? await sessionInputs() : null
  const inputs = session !== null ? session.inputs : toLiveInputs(trace!)
  // F23 (continued): an in-range window that matches no input would also test
  // nothing, so refuse it before the precondition work renders any screens.
  if (validatedWindow !== null) {
    const [from, to] = validatedWindow
    const matched = inputs.filter(entry => entry.event.seq >= from && entry.event.seq <= to).length
    if (matched === 0) {
      throw new Error(`REPLAY_WINDOW=${WINDOW} matches no replay events`
        + ' (the run would test nothing); pick a range inside the stream')
    }
  }
  const terminal = REAL_TERMINAL ? new ProcessTerminal() : new VirtualTerminal(COLUMNS, ROWS)
  const originalWrite = terminal.write.bind(terminal)
  const vt = terminal as unknown as VirtualTerminal
  const xtermInstance = REAL_TERMINAL
    ? null
    : (vt as unknown as { xterm: InstanceType<typeof XtermTerminal> }).xterm

  const writes: Array<{ seq: number; chunkSeq: number; data: string }> = []
  const writeSnapshots: Array<string[] | null> = []
  let chunkSeq = -1
  ;(vt as unknown as { write(data: string): void }).write = (data: string): void => {
    const seq = writes.length
    const raw = SYNC_OFF
      ? data.split(BEGIN_SYNC_MARKER).join('').split(END_SYNC_MARKER).join('')
      : data
    writes.push({ seq, chunkSeq, data: raw })
    writeSnapshots.push(null)
    if (xtermInstance !== null) {
      xtermInstance.write(raw, () => {
        const buffer = xtermInstance.buffer.active
        writeSnapshots[seq] = Array.from(
          { length: ROWS },
          (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '',
        )
      })
    } else {
      originalWrite(raw)
    }
  }

  const prototype = TuiAltScreen.prototype as unknown as { doRender: () => void }
  const originalDoRender = prototype.doRender
  const paintEvents: Array<Record<string, unknown>> = []
  // Per-paint PRESENTATION read (component level): identifies the live assistant
  // block by identity instead of by fragile text markers. This is the same
  // read-only `messagesView.render()` the phase-1/2 probes already performed.
  const readPresentation = (): Record<string, unknown> => {
    const host = app as unknown as {
      messagesView: {
        render(width: number): string[]
        children: readonly { render(width: number): string[]; constructor: { name: string } }[]
      }
    }
    const children = host.messagesView.children
    const blocks = children.map((child, index) => {
      const rows = child.render(COLUMNS).map(row => maskAnimatedGlyph(row).replace(/\s+$/, ''))
      return { index, type: child.constructor.name, rows: rows.length, first: rows[0] ?? null, last: rows.at(-1) ?? null }
    })
    const gutters = blocks.filter(block => block.type === 'TranscriptGutterComponent')
    const live = gutters.at(-1)
    return {
      presentationRows: blocks.reduce((total, block) => total + block.rows, 0),
      gutterCount: gutters.length,
      gutterRows: gutters.map(block => block.rows),
      gutterFirsts: gutters.map(block => (block.first ?? '').slice(0, 28)),
      blockTypes: blocks.map(block => block.type),
      live: live === undefined ? null : {
        rows: live.rows,
        first: live.first,
        last: live.last,
        blank: live.rows === 0 || (live.first ?? '').trim() === '',
      },
    }
  }
  const readScroll = (): Record<string, unknown> | null => {
    const scroll = app.fullscreenScrollForTest()
    return scroll === undefined ? null : { ...scroll }
  }
  prototype.doRender = function wrapped(this: unknown): void {
    const start = performance.now()
    originalDoRender.call(this)
    const end = performance.now()
    paintEvents.push({
      paintSeq: paintEvents.length,
      chunkSeq,
      startMs: start,
      endMs: end,
      durationMs: end - start,
      at: end,
      presentation: PAINT_DETAIL ? readPresentation() : null,
      L3: PAINT_DETAIL ? readScroll() : null,
    })
  }

  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  // Production lifecycle: the main screen starts first, THEN fullscreen takes
  // over. Phase-1/2 used the same startApp() helper; omitting start() left the
  // host wiring (input/scheme/geometry registration) incomplete.
  app.start()
  const folder = new TranscriptFolder()
  if (session !== null && session.history.length > 0) {
    folder.apply(session.history as unknown as SessionEvent[])
  } else {
    folder.apply([
      { type: 'turn/start', seq: 1, time: T0 + 1, data: { turn: 1 } } as SessionEvent,
      {
        type: 'user/message',
        seq: 2,
        time: T0 + 2,
        data: {
          id: MessageId('replay-user'),
          role: 'user',
          content: [{ type: 'text', text: [OLD_SENTINEL, 'HIST-02', 'HIST-03', 'HIST-04'].join('\n') }],
          source: { kind: 'user' },
        },
      } as SessionEvent,
    ])
  }
  // Mirror the production `repaint()`: a BOUNDED transcript window (default 20
  // turns), not the whole fold. Without this the harness re-projects every turn
  // on every delta, which is far heavier than production and destroys arrival
  // pressure fidelity.
  const windowController = new TranscriptWindowController()
  const show = (): void => {
    windowController.setTurns(folder.groupedTurns())
    const endTurn = windowController.endTurn()
    const projection = folder.window({
      maxTurns: windowController.windowTurns,
      ...(endTurn === undefined ? {} : { endTurn }),
    })
    app.setTranscript(projection.messages, folder.turnActivities(), {
      ...windowController.state(),
      firstTurn: projection.firstTurn,
      lastTurn: projection.lastTurn,
      hasNewer: projection.hasNewer,
    }, [])
  }
  const settle = async (): Promise<void> => {
    if (REAL_TERMINAL) {
      // ProcessTerminal has no waitForRender: the observable frame boundary is
      // the doRender wrapper. Wait for a paint (bounded), never a bare sleep.
      const mark = paintEvents.length
      const deadline = performance.now() + 250
      while (paintEvents.length === mark && performance.now() < deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 4))
      }
      await new Promise<void>(resolve => setImmediate(resolve))
      return
    }
    await vt.waitForRender()
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  const answerPattern = session !== null && session.answerMarkers.length > 0
    ? new RegExp(session.answerMarkers.map(marker => marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))
    : null
  const shape = (rows: readonly string[]): Record<string, unknown> => ({
    liveRows: countRows(rows, LIVE_BODY),
    oldRows: countRows(rows, OLD_BODY),
    answerRows: answerPattern === null ? 0 : countRows(rows, answerPattern),
  })

  const screenText = (): string[] => REAL_TERMINAL
    ? []
    : vt.getViewport().map(row => maskAnimatedGlyph(row).replace(/\s+$/, ''))
  /** SGR mouse click; `findRow` is 0-based viewport, SGR y is 1-based. */
  const click = (x: number, y: number): void => {
    vt.sendInput(`\x1b[<0;${x};${y}M`)
    vt.sendInput(`\x1b[<0;${x};${y}m`)
  }

  /**
   * Expand EVERY visible outer Focus Thought root by CLICKING each collapsed
   * `🐋 Thought` header (fullscreen Focus: Ctrl+O is a bulk action that only
   * opens the most recent EXPAND_RECENT_TURNS or collapses everything, so it
   * cannot establish the precondition). Scrolls older turns into view and
   * repeats until no collapsed root remains in the test range.
   */
  const expandAllThoughtRoots = async (): Promise<Record<string, unknown>> => {
    if (REAL_TERMINAL) {
      // Same operation the header click performs; a real ProcessTerminal has no
      // readable screen buffer, so expand every known turn programmatically and
      // report the resulting set.
      for (const turn of folder.groupedTurns()) {
        if (!app.focusExpandedTurnsForTest().has(turn)) app.toggleFocusTurn(turn)
      }
      await settle()
      return {
        mode: 'programmatic (real terminal)',
        expandedTurns: [...app.focusExpandedTurnsForTest()],
        turnCount: folder.groupedTurns().length,
        allExpanded: folder.groupedTurns().every(turn => app.focusExpandedTurnsForTest().has(turn)),
      }
    }
    let clicked = 0
    let passes = 0
    let stalledScrolls = 0
    const expandedHeaders: string[] = []
    for (passes = 0; passes < 200; passes += 1) {
      const rows = screenText()
      const collapsed = rows
        .map((row, index) => ({ row, index }))
        .filter(entry => entry.row.includes('🐋 Thought'))
      if (collapsed.length === 0) {
        const before = rows.slice(0, 3).join('|')
        for (let step = 0; step < 6; step += 1) {
          vt.sendInput('\x1b[<64;3;12M')
          await settle()
        }
        const after = screenText().slice(0, 3).join('|')
        if (after === before) break
        stalledScrolls += 1
        continue
      }
      const target = collapsed[0]!
      const before = screenText().filter(row => row.includes('🐋 Thought')).length
      click(3, target.index + 1)
      await settle()
      const after = screenText().filter(row => row.includes('🐋 Thought')).length
      clicked += 1
      if (after >= before) {
        // The click did not collapse a root (layout moved, or hit area missed).
        stalledScrolls += 1
        if (stalledScrolls > 8) break
        continue
      }
      expandedHeaders.push(target.row.trim())
    }
    const finalRows = screenText()
    return {
      clicked,
      passes,
      stalled: stalledScrolls > 8,
      expandedHeaders,
      remainingCollapsedInViewport: finalRows.filter(row => row.includes('🐋 Thought')).length,
      expandedHeadersInViewport: finalRows.filter(row => row.includes('🐳 Thought')).length,
    }
  }

  const eventPaintCounts: Record<string, unknown>[] = []
  const paintMarks: Array<{ chunkSeq: number; count: number }> = []
  // Phase markers: the EARLY phase (startup -> fullscreen -> Thought expansion
  // -> first stream flush) is where the reported visual flash lives, so the
  // recording baseline must start before it.
  const phaseLog: Array<{ phase: string; paintIndex: number; atMs: number }> = []
  const markPhase = (phase: string): void => {
    phaseLog.push({ phase, paintIndex: paintEvents.length, atMs: performance.now() })
  }
  markPhase('startup')

  try {
    app.setFocusMode(true)
    app.setFullscreen(true)
    app.setWorking(true)
    show()
    await settle()
    if (process.env.REPLAY_THINKING === '1') app.setThinkingExpanded(true)
    markPhase('focus-fullscreen')
    const disclosure = await expandAllThoughtRoots()
    markPhase('expanded')
    // Any turn the click sweep could not reach (a large exported history makes
    // the scroll sweep stall) is expanded through exactly the operation a header
    // click performs. The click sweep stays the primary path; this fallback only
    // covers what it cannot reach, and the gate below still verifies the result.
    const unreachedTurns = folder.groupedTurns()
      .filter(turn => !app.focusExpandedTurnsForTest().has(turn))
    for (const turn of unreachedTurns) app.toggleFocusTurn(turn)
    // The live turn's root may only exist once its first chunk lands, so make
    // sure THE LIVE TURN is expanded too — independent of which source produced
    // the stream.
    if (!app.focusExpandedTurnsForTest().has(LIVE_TURN)) app.toggleFocusTurn(LIVE_TURN)
    ;(disclosure as Record<string, unknown>).programmaticFallbackTurns = unreachedTurns
    app.scrollToBottom()
    await settle()
    await settle()
    // Re-measure the FINAL viewport after the fallback: the gate must judge the
    // state the stream actually starts from.
    const finalViewport = screenText()
    ;(disclosure as Record<string, unknown>).remainingCollapsedInViewport =
      finalViewport.filter(row => row.includes('🐋 Thought')).length
    ;(disclosure as { expandedTurns?: number[] }).expandedTurns = [...app.focusExpandedTurnsForTest()]
    const preconditionScroll = app.fullscreenScrollForTest()
    ;(disclosure as Record<string, unknown>).thinkingDetail = process.env.REPLAY_THINKING === '1' ? 'expanded' : 'compact'
    ;(disclosure as Record<string, unknown>).followingEnd = preconditionScroll?.isFollowingEnd ?? null
    ;(disclosure as Record<string, unknown>).scrollTop = preconditionScroll?.scrollTop ?? null
    ;(disclosure as Record<string, unknown>).viewportHeight = preconditionScroll?.viewportHeight ?? null
    ;(disclosure as Record<string, unknown>).contentHeight = preconditionScroll?.contentHeight ?? null
    ;(disclosure as Record<string, unknown>).liveTurn = LIVE_TURN
    ;(disclosure as Record<string, unknown>).allExpanded = folder.groupedTurns()
      .every(turn => app.focusExpandedTurnsForTest().has(turn))
    console.log(`disclosure precondition: ${JSON.stringify(disclosure)}`)
    // Hard gate: an unqualified run is NOT evidence. The probe refuses to
    // continue rather than emit metrics/oracle output for an invalid setup.
    const preconditionOk = (disclosure as { allExpanded?: boolean }).allExpanded === true
      && (disclosure as { remainingCollapsedInViewport?: number }).remainingCollapsedInViewport === 0
    if (!preconditionOk) {
      throw new Error(`replay precondition not satisfied (run is invalid): ${JSON.stringify(disclosure)}`)
    }

    markPhase('precondition-expanded')
    const paintsBefore = 0
    const writesBefore = 0
    let flushTimer: NodeJS.Timeout | undefined
    let flushCount = 0
    // ---- finalize-handoff instrumentation (step 1, read-only) --------------
    const activityIds = new WeakMap<object, number>()
    let nextActivityId = 1
    const activityId = (value: object | undefined): number | null => {
      if (value === undefined) return null
      const existing = activityIds.get(value)
      if (existing !== undefined) return existing
      const id = nextActivityId++
      activityIds.set(value, id)
      return id
    }
    const blockLog: Record<string, unknown>[] = []
    const heightLog: Record<string, unknown>[] = []
    const containerLog: Record<string, unknown>[] = []
    const instanceIds = new WeakMap<object, number>()
    let nextInstanceId = 1
    const iid = (value: unknown): number | null => {
      if (value === null || typeof value !== 'object') return null
      const existing = instanceIds.get(value as object)
      if (existing !== undefined) return existing
      const id = nextInstanceId++
      instanceIds.set(value as object, id)
      return id
    }
    const instrumentContainer = (value: unknown): void => {
      const container = value as { children?: unknown[]; clear?: () => void; addChild?: (child: unknown) => void; removeChild?: (child: unknown) => void; __probePatched?: boolean }
      if (container === null || typeof container !== 'object' || container.__probePatched === true) return
      if (container.clear === undefined && container.addChild === undefined) return
      container.__probePatched = true
      const id = iid(container)
      const originalClear = container.clear?.bind(container)
      const originalAdd = container.addChild?.bind(container)
      const originalRemove = container.removeChild?.bind(container)
      if (originalClear !== undefined) {
        container.clear = (): void => {
          const before = container.children?.length ?? 0
          if (before >= 3) containerLog.push({ at: Number(performance.now().toFixed(1)), id, op: 'clear', before })
          originalClear()
        }
      }
      if (originalAdd !== undefined) {
        container.addChild = (child: unknown): void => {
          originalAdd(child as never)
          const after = container.children?.length ?? 0
          if (after >= 3) containerLog.push({ at: Number(performance.now().toFixed(1)), id, op: 'addChild', after })
        }
      }
      if (originalRemove !== undefined) {
        container.removeChild = (child: unknown): void => {
          const before = container.children?.length ?? 0
          if (before >= 3) containerLog.push({ at: Number(performance.now().toFixed(1)), id, op: 'removeChild', before })
          originalRemove(child as never)
        }
      }
    }
    if (PAINT_BLOCKS) {
      const appAny = app as unknown as Record<string, unknown>
      const originalHeight = (appAny.normalTranscriptBlockHeight as (...args: unknown[]) => number).bind(app)
      const originalPadding = (appAny.focusLivePaddingFor as (...args: unknown[]) => ReadonlyMap<number, number>).bind(app)
      // Log ONLY the production height calls — re-measuring here would warm the
      // component cache and hide the very transient we are chasing.
      appAny.normalTranscriptBlockHeight = (entry: unknown, index: number, total: number): number => {
        const height = originalHeight(entry, index, total)
        const component = (entry as { component?: { constructor?: { name?: string } } })?.component
        heightLog.push({
          at: Number(performance.now().toFixed(1)),
          index,
          total,
          height,
          component: component?.constructor?.name ?? null,
        })
        if (heightLog.length > 8000) heightLog.splice(0, 4000)
        return height
      }
      appAny.focusLivePaddingFor = (...args: unknown[]): ReadonlyMap<number, number> => {
        const result = originalPadding(...args)
        const blocks = args[0] as Array<{ block: Record<string, unknown> }>
        const expanded = args[1] as ReadonlySet<number>
        const width = args[2] as number
        const rows = blocks.map((entry, index) => {
          const block = entry.block
          const message = block.message as Record<string, unknown> | undefined
          const activity = block.activity as Record<string, unknown> | undefined
          return {
            i: index,
            kind: block.kind,
            turn: block.kind === 'activity' ? (activity?.turn ?? null) : (message?.turn ?? null),
            msgKind: block.kind === 'message' ? (message?.kind ?? null) : null,
            textLen: block.kind === 'message' && typeof message?.text === 'string' ? message.text.length : null,
            processRow: block.kind === 'message' && block.collapseFocusOwnerOnClick !== undefined,
            height: null,
            padding: result.get(index) ?? 0,
          }
        })
        instrumentContainer((blocks[6] as { component?: unknown } | undefined)?.component)
        for (const entry of blocks) instrumentContainer((entry as { component?: unknown }).component)
        const mounted = (app as unknown as { messagesView: { children: Array<{ constructor: { name: string }; child?: unknown }> } })
          .messagesView.children.filter(child => child.constructor.name === 'TranscriptGutterComponent')
        blockLog.push({
          at: Number(performance.now().toFixed(1)),
          expanded: [...expanded],
          width,
          total: rows.reduce((sum, row) => sum + row.height + row.padding, 0),
          projectionComponentIds: blocks.map(entry => iid((entry as { component?: unknown }).component)),
          mountedChildIds: mounted.map(child => iid(child.child)),
          rows,
        })
        if (blockLog.length > 4000) blockLog.splice(0, 2000)
        return result
      }
    }
    const flushLog: Record<string, unknown>[] = []
    let lastItem: Record<string, unknown> = {}
    const sampleFlush = (): void => {
      const host = app as unknown as {
        messagesView: { render(width: number): string[] }
        focusLiveHeightStates: Map<number, { activity: object; expanded: boolean; width: number; height: number }>
      }
      const activity = folder.turnActivity(SESSION_TURN)
      const state = host.focusLiveHeightStates?.get(SESSION_TURN)
      flushLog.push({
        flushSeq: flushCount,
        at: Number(performance.now().toFixed(1)),
        lastItem: { ...lastItem },
        activity: activity === undefined ? null : {
          id: activityId(activity as unknown as object),
          revision: activity.revision,
          completed: activity.completed,
          assistantMessages: activity.assistantMessages,
          lastAssistantVisible: activity.lastAssistantVisible ?? null,
          thinkLen: activity.think?.text.length ?? null,
          messageLen: activity.message?.text.length ?? null,
        },
        heightState: state === undefined ? null : {
          activityId: activityId(state.activity),
          expanded: state.expanded,
          width: state.width,
          height: state.height,
        },
        presentationRows: host.messagesView.render(COLUMNS).length,
        L3: app.fullscreenScrollForTest() ?? null,
      })
    }
    const flushNow = (): void => {
      if (flushTimer !== undefined) { clearTimeout(flushTimer); flushTimer = undefined }
      flushCount += 1
      show()
      sampleFlush()
    }
    /** Mirror production `schedulePaint()`: coalesce into one flush. */
    const scheduleFlush = (): void => {
      if (flushTimer !== undefined) return
      flushTimer = setTimeout(() => { flushTimer = undefined; flushCount += 1; show(); sampleFlush() }, FLUSH_MS)
    }
    const apply = (entry: { event: TraceEvent; input: AssistantLiveInput }): void => {
      chunkSeq = entry.event.seq
      folder.applyLiveInput(entry.input)
      if (FLUSH_MODE === 'coalesced') scheduleFlush()
      else { flushCount += 1; show() }
    }

    const applyDurable = (event: Record<string, unknown>): void => {
      chunkSeq = event.seq as number
      folder.apply([event as unknown as SessionEvent])
      // Production delivers durable events on the session/event firehose, which
      // calls schedulePaint() (50 ms coalesced) — never an immediate rebuild.
      if (FLUSH_MODE === 'coalesced') scheduleFlush()
      else { flushCount += 1; show() }
    }
    const settlementItems = (session?.settlement ?? []).map(event => ({
      at: ((event.time as number) - (inputs[1]?.input as { time?: number })?.time! + (inputs[1]?.event.tOffsetMs ?? 0)),
      event,
    }))

    if (SETTLE_BEFORE_STREAM_MS > 0) {
      console.log(`[replay] freeze ${SETTLE_BEFORE_STREAM_MS}ms before streaming (operator delimiter)`)
      await new Promise<void>(resolve => setTimeout(resolve, SETTLE_BEFORE_STREAM_MS))
    }
    const STREAM_MARK = `[replay] ${new Date().getTime()} streaming-start`
    console.log(STREAM_MARK)
    const windowRange = validatedWindow
    if (windowRange !== null) {
      const [from, to] = windowRange
      const prime = inputs.filter(entry => entry.event.seq >= 0 && entry.event.seq < from)
      const heavy = inputs.filter(entry => entry.event.seq >= from && entry.event.seq <= to)
      for (const entry of prime) apply(entry)
      await settle()
      for (let loop = 0; loop < LOOPS; loop += 1) {
        let previous = heavy[0]?.event.tOffsetMs ?? 0
        for (const entry of heavy) {
          const gap = Math.max(0, (entry.event.tOffsetMs - previous) / SPEED)
          previous = entry.event.tOffsetMs
          if (gap > 0) await new Promise<void>(resolve => setTimeout(resolve, gap))
          apply(entry)
          if (SETTLE_EACH) await settle()
        }
      }
      for (const item of settlementItems) applyDurable(item.event)
      await settle()
    } else if (CADENCE === 'wallclock') {
      // TRUE arrival pressure: every event is dispatched at its original
      // monotonic target. A slow event-loop never delays the NEXT arrival —
      // the backlog simply dispatches immediately, which is exactly what the
      // production renderer/coalescer faces.
      const clock = performance.now()
      const timeline = (session?.timeline ?? []) as Array<Record<string, unknown>>
      if (timeline.length > 0) {
        for (const item of timeline) {
          const target = clock + (item.at as number) / SPEED
          const wait = target - performance.now()
          if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait))
          const entry = item.entry as { event: TraceEvent; input: AssistantLiveInput } | undefined
          const durable = item.event as Record<string, unknown> | undefined
          lastItem = item.kind === 'live'
            ? { kind: 'live', seq: entry?.event.seq, step: (entry?.input as { step?: number })?.step,
                chunk: (entry?.input as { chunk?: { type?: string } })?.chunk?.type }
            : { kind: 'durable', seq: durable?.seq, type: durable?.type,
                step: (durable?.data as { step?: number } | undefined)?.step }
          if (item.kind === 'live') apply(entry!)
          else applyDurable(durable!)
        }
        flushNow()
        await settle()
        console.log(`[replay] wallclock(interleaved): items=${timeline.length} elapsed=${(performance.now() - clock).toFixed(0)}ms speed=${SPEED}`)
        ;(globalThis as Record<string, unknown>).__dispatchLog = []
        ;(globalThis as Record<string, unknown>).__interleavedDone = true
      }
      if ((globalThis as Record<string, unknown>).__interleavedDone === true) {
        // timeline already dispatched above
      } else {
      const startEntry = inputs.find(entry => entry.event.seq < 0)
      if (startEntry !== undefined) apply(startEntry)
      // Optional full-stream repetition: the real answer ends with a closed
      // fence, so re-appending the WHOLE stream keeps markdown balanced (unlike
      // looping a half-open window) and multiplies the number of viewport
      // shifts, i.e. the whole-viewport rewrite count, at real timing.
      const chunkInputs = inputs.filter(entry => entry.event.seq >= 0)
      const loopSpan = (chunkInputs.at(-1)?.event.tOffsetMs ?? 0) + 120
      const stream: Array<{ event: TraceEvent; input: AssistantLiveInput }> = []
      for (let loop = 0; loop < Math.max(1, LOOPS); loop += 1) {
        for (const entry of chunkInputs) {
          stream.push({ event: { ...entry.event, tOffsetMs: entry.event.tOffsetMs + loop * loopSpan }, input: entry.input })
        }
      }
      const dispatchLog: Record<string, unknown>[] = []
      for (const entry of stream) {
        if (entry.event.seq < 0) continue
        const target = clock + entry.event.tOffsetMs / SPEED
        const wait = target - performance.now()
        if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait))
        const before = paintEvents.length
        const actual = performance.now()
        apply(entry)
        dispatchLog.push({
          eventSeq: entry.event.seq,
          delta: entry.event.delta,
          originalOffsetMs: entry.event.tOffsetMs,
          targetDispatchMs: target - clock,
          actualDispatchMs: actual - clock,
          dispatchLagMs: actual - target,
          paintSeqBefore: before,
          paintSeqAfter: paintEvents.length,
          structural: structuralKind(entry.event.delta),
        })
      }
      flushNow()
      await settle()
      ;(globalThis as Record<string, unknown>).__dispatchLog = dispatchLog
      console.log(`[replay] wallclock: events=${dispatchLog.length}`
        + ` lagP50=${median(dispatchLog.map(entry => entry.dispatchLagMs as number)).toFixed(1)}`
        + ` lagMax=${Math.max(...dispatchLog.map(entry => entry.dispatchLagMs as number)).toFixed(1)}`
        + ` elapsed=${(performance.now() - clock).toFixed(0)}ms speed=${SPEED}`)
      }
    } else if (CADENCE === 'immediate') {
      for (const entry of inputs) apply(entry)
      flushNow()
      for (const item of settlementItems) applyDurable(item.event)
      flushNow()
      await settle()
    } else if (CADENCE === 'batched') {
      const WINDOW_MS = 5
      let bucket: typeof inputs = []
      let bucketStart = inputs[0]?.event.tOffsetMs ?? 0
      const flush = async (): Promise<void> => {
        if (bucket.length === 0) return
        for (const entry of bucket) apply(entry)
        await new Promise<void>(resolve => setImmediate(resolve))
        bucket = []
      }
      for (const entry of inputs) {
        if (entry.event.tOffsetMs - bucketStart > WINDOW_MS && bucket.length > 0) {
          await flush()
          bucketStart = entry.event.tOffsetMs
        }
        bucket.push(entry)
      }
      await flush()
      flushNow()
      for (const item of settlementItems) applyDurable(item.event)
      flushNow()
      await settle()
    } else {
      // exact: schedule each delta at its ORIGINAL relative arrival offset.
      // The timer reproduces input arrival only; no timer is used to decide
      // that a render completed.
      const startAt = performance.now()
      // Full-stream loop: repeat the WHOLE final-output stream, which keeps the
      // markdown structurally balanced (the real answer ends with a closed
      // fence), unlike looping a half-open window.
      const startEntry = inputs.find(entry => entry.event.seq < 0)
      const chunkEntries = inputs.filter(entry => entry.event.seq >= 0)
      const duration = (chunkEntries.at(-1)?.event.tOffsetMs ?? 0) + 120
      const scheduledInputs = LOOPS > 1
        ? (() => {
          if (startEntry !== undefined) apply(startEntry)
          return Array.from({ length: LOOPS }, (_, loop) =>
            chunkEntries.map(entry => ({
              at: loop * duration + entry.event.tOffsetMs,
              apply: () => apply(entry),
            })),
          ).flat()
        })()
        : inputs.map(entry => ({ at: entry.event.tOffsetMs, apply: () => apply(entry) }))
      const schedule = [
        ...scheduledInputs,
        ...settlementItems.map(item => ({ at: item.at, apply: () => applyDurable(item.event) })),
      ].sort((left, right) => left.at - right.at)
      for (const item of schedule) {
        const delay = Math.max(0, startAt + item.at - performance.now())
        await new Promise<void>(resolve => setTimeout(resolve, delay))
        item.apply()
      }
      flushNow()
      await settle()
    }

    console.log(`[replay] ${new Date().getTime()} streaming-end`)
    for (let index = paintsBefore; index < paintEvents.length; index += 1) {
      paintMarks.push({ chunkSeq: paintEvents[index]!.chunkSeq as number, count: 1 })
    }
    for (const entry of inputs) {
      eventPaintCounts.push({
        seq: entry.event.seq,
        delta: entry.event.delta,
        tOffsetMs: entry.event.tOffsetMs,
        paints: paintEvents.slice(paintsBefore).filter(paint => paint.chunkSeq === entry.event.seq).length,
        presentationLiveRows: paintEvents
          .slice(paintsBefore)
          .filter(paint => paint.chunkSeq === entry.event.seq)
          .map(paint => ((paint.presentation as { live?: { rows: number } } | undefined)?.live?.rows) ?? null),
      })
    }

    // ---- paint records ----
    const paintRecords: Record<string, unknown>[] = []
    for (let seq = writesBefore; seq < writes.length; seq += 1) {
      const record = writes[seq]!
      if (!record.data.includes(BEGIN_SYNC)) continue
      const snapshot = writeSnapshots[seq] ?? []
      const touchedRows = [...record.data.matchAll(/\x1b\[(\d+);1H/g)].map(match => Number(match[1]) - 1)
      const event = paintEvents[paintsBefore + paintRecords.length]
      paintRecords.push({
        paintSeq: paintRecords.length,
        phase: [...phaseLog].reverse().find(entry => entry.paintIndex <= paintRecords.length)?.phase ?? 'startup',
        presentation: event?.presentation ?? null,
        L3: event?.L3 ?? null,
        presentationLiveRows: ((event?.presentation as { live?: { rows: number } } | undefined)?.live?.rows) ?? null,
        presentationLiveBlank: ((event?.presentation as { live?: { blank: boolean } } | undefined)?.live?.blank) ?? null,
        at: event?.at ?? null,
        chunkSeq: record.chunkSeq,
        writeSeq: seq,
        byteLength: record.data.length,
        rowWriteCount: touchedRows.length,
        touchedTranscriptRows: touchedRows.filter(row => row < ROWS - 7),
        fullRedraw: record.data.includes('\x1b[2J'),
        endsInSameWrite: record.data.includes(END_SYNC),
        transcriptHash: hash(snapshot.slice(0, ROWS - 7).map(maskAnimatedGlyph).join('\n')),
        texts: snapshot,
        ...shape(snapshot),
      })
    }

    // ---- byte-prefix replay (transition-compressed) ----
    const scratch = PREFIX_REPLAY ? new XtermTerminal({ cols: COLUMNS, rows: ROWS, disableStdin: true, allowProposedApi: true }) : null
    const scratchRows = (): string[] => {
      const buffer = scratch!.buffer.active
      return Array.from({ length: ROWS }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
    }
    const transactions: Array<{ begin: number; end: number }> = []
    const stream = writes.map(record => record.data).join('')
    let cursor = 0
    while (cursor < stream.length) {
      const begin = stream.indexOf(BEGIN_SYNC, cursor)
      if (begin === -1) break
      const end = stream.indexOf(END_SYNC, begin + BEGIN_SYNC.length)
      if (end === -1) {
        transactions.push({ begin, end: stream.length })
        break
      }
      transactions.push({ begin, end: end + END_SYNC.length })
      cursor = end + END_SYNC.length
    }
    const transactionOf = (offset: number): number => {
      let owner = -1
      for (let index = 0; index < transactions.length; index += 1) {
        if (transactions[index]!.begin <= offset) owner = index
        else break
      }
      return owner
    }

    const prefixRecords: Array<Record<string, unknown>> = []
    let absoluteOffset = 0
    let previousKey = ''
    let tokenIndex = 0
    for (let seq = writesBefore; PREFIX_REPLAY && seq < writes.length; seq += 1) {
      for (const token of tokenize(writes[seq]!.data)) {
        await new Promise<void>(resolve => scratch.write(token, () => resolve()))
        const rows = scratchRows()
        const state = shape(rows)
        const screenHash = hash(rows.join('\n'))
        const key = `${state.liveRows}|${state.oldRows}|${screenHash}`
        if (prefixRecords.length === 0 || key !== previousKey) {
          const paintIndex = transactionOf(absoluteOffset)
          prefixRecords.push({
            tokenIndex,
            writeSeq: seq,
            chunkSeq: writes[seq]!.chunkSeq,
            kind: classifyToken(token),
            paintIndex,
            inPaint: paintIndex >= 0 && absoluteOffset < transactions[paintIndex]!.end,
            screenHash,
            ...state,
          })
          previousKey = key
        }
        absoluteOffset += token.length
        tokenIndex += 1
      }
    }

    // ---- detectors ----
    const oscillations = findTransientRuns(prefixRecords.map(r => (r.liveRows as number) > 0), false)
    const oldFlashbacks = findTransientRuns(prefixRecords.map(r => (r.oldRows as number) > 0), true, true)
    const liveDisappearancePaints = paintRecords
      .map((record, index) => ({ record, previous: paintRecords[index - 1], next: paintRecords[index + 1] }))
      .filter(({ record, previous, next }) =>
        (record.liveRows as number) === 0
        && previous !== undefined && (previous.liveRows as number) >= 2
        && next !== undefined && (next.liveRows as number) >= 2)
    const oldReappearancePaints = paintRecords
      .map((record, index) => ({ record, index, previous: paintRecords[index - 1] }))
      .filter(({ record, index, previous }) =>
        previous !== undefined && (previous.oldRows as number) === 0 && (record.oldRows as number) > 0
        && paintRecords.slice(index + 1).some(later => (later.oldRows as number) === 0))
    const rowShiftPaints = paintRecords
      .map((record, index) => ({ record, previous: paintRecords[index - 1], next: paintRecords[index + 1] }))
      .filter(({ record, previous, next }) => {
        if (previous === undefined || next === undefined) return false
        const before = previous.texts as string[]
        const current = record.texts as string[]
        const after = next.texts as string[]
        return current.some((row, rowIndex) =>
          (before[rowIndex] ?? '').trim() !== '' && row.trim() === '' && (after[rowIndex] ?? '').trim() !== '')
      })
    // L2-level invariant: the live assistant block component renders zero rows
    // (or only blank rows) while its neighbours render it — a genuine
    // "live block vanished" frame, independent of any text marker.
    const liveBlockMissingPaints = paintRecords
      .map((record, index) => ({ record, previous: paintRecords[index - 1], next: paintRecords[index + 1] }))
      .filter(({ record, previous, next }) =>
        record.presentationLiveBlank === true
        && ((previous?.presentationLiveRows as number | null) ?? 0) > 0
        && ((next?.presentationLiveRows as number | null) ?? 0) > 0)

    const answerDisappearancePaints = paintRecords
      .map((record, index) => ({ record, previous: paintRecords[index - 1], next: paintRecords[index + 1] }))
      .filter(({ record, previous, next }) =>
        (record.answerRows as number) === 0
        && ((previous?.answerRows as number | undefined) ?? 0) > 0
        && ((next?.answerRows as number | undefined) ?? 0) > 0)

    const intraPaintWindows: Array<Record<string, unknown>> = []
    transactions.forEach((transaction, paintIndex) => {
      const inside = prefixRecords.filter(record => record.inPaint === true && record.paintIndex === paintIndex)
      if (inside.length < 2) return
      if ((inside[0]!.liveRows as number) === 0 || (inside[inside.length - 1]!.liveRows as number) === 0) return
      if (inside.some(record => (record.liveRows as number) === 0)) {
        intraPaintWindows.push({
          paintIndex,
          chunkSeq: inside[0]!.chunkSeq,
          minLiveRows: Math.min(...inside.map(record => record.liveRows as number)),
          maxOldRows: Math.max(...inside.map(record => record.oldRows as number)),
        })
      }
    })

    const dispatchLog = ((globalThis as Record<string, unknown>).__dispatchLog ?? []) as Record<string, unknown>[]
    const streamingMs = (performance.now() - (paintEvents[paintsBefore]?.startMs ?? performance.now()))
    const payload = {
      probe: 'replay',
      label: LABEL,
      cadence: CADENCE,
      source: SOURCE,
      trace: session !== null
        ? session.meta
        : { source: trace!.source, model: trace!.model, eventCount: trace!.events.length, textChars: trace!.text.length },
      terminal: REAL_TERMINAL
        ? terminalEnv()
        : { columns: COLUMNS, rows: ROWS, syncOutput: SYNC_OFF ? 'off (diagnostic)' : 'on' },
      window: windowRange === null ? null : { from: windowRange[0], to: windowRange[1], loops: LOOPS },
      disclosure,
      phaseLog,
      flushLog,
      blockLog,
      heightLog,
      containerLog,
      dispatchLog,
      metrics: {
        flushMode: FLUSH_MODE,
        flushMs: FLUSH_MS,
        flushCount,
        flushesPerSecond: Number((flushCount / Math.max(0.001, streamingMs / 1000)).toFixed(1)),
        speed: SPEED,
        streamingMs: Number(streamingMs.toFixed(1)),
        events: ((): number => {
          const timeline = (session?.timeline ?? []) as Array<Record<string, unknown>>
          return timeline.length > 0 ? timeline.length : Math.max(0, inputs.length - 2)
        })(),
        dispatchedItems: (((session?.timeline ?? []) as Array<Record<string, unknown>>).length > 0
          ? ((session?.timeline ?? []) as Array<Record<string, unknown>>).filter(item => item.kind === 'live').length
            + ((session?.timeline ?? []) as Array<Record<string, unknown>>).filter(item => item.kind === 'durable').length
          : Math.max(0, inputs.length - 2)),
        paints: paintRecords.length,
        paintsWithTranscriptRows: paintRecords.filter(r => (r.touchedTranscriptRows as number[]).length > 0).length,
        noopPaints: paintRecords.filter(r => r.rowWriteCount === 0).length,
        transactions: transactions.length,
        allPaintsEndInSameWrite: paintRecords.every(r => r.endsInSameWrite === true),
        fullRedrawPaints: paintRecords.filter(r => r.fullRedraw === true).length,
        bigReflowPaints: paintRecords.filter(r => (r.rowWriteCount as number) >= 10).length,
        maxRowWrites: Math.max(...paintRecords.map(r => r.rowWriteCount as number), 0),
        eventsWithZeroPaints: eventPaintCounts.filter(e => (e.paints as number) === 0).length,
        eventsWithTwoPlusPaints: eventPaintCounts.filter(e => (e.paints as number) >= 2).length,
        osculationRuns: oscillations.length,
        oldFlashbackRuns: oldFlashbacks.length,
        paintDetail: PAINT_DETAIL,
        liveDisappearancePaints: PAINT_DETAIL ? liveDisappearancePaints.length : null,
        oldReappearancePaints: PAINT_DETAIL ? oldReappearancePaints.length : null,
        intraPaintWindows: intraPaintWindows.length,
        rowShiftPaints: rowShiftPaints.length,
        liveBlockMissingPaints: PAINT_DETAIL ? liveBlockMissingPaints.length : null,
        answerDisappearancePaints: answerDisappearancePaints.length,
        prefixRecords: prefixRecords.length,
        totalPaintMs: Number(paintEvents.slice(paintsBefore).reduce((sum, event) => sum + ((event.endMs as number) - (event.startMs as number)), 0).toFixed(1)),
        maxPaintMs: Number(Math.max(0, ...paintEvents.slice(paintsBefore).map(event => (event.endMs as number) - (event.startMs as number))).toFixed(1)),
        followEndPaints: PAINT_DETAIL
          ? paintRecords.filter(record => (record.L3 as { isFollowingEnd?: boolean } | null)?.isFollowingEnd === true).length
          : null,
        followFreePaints: PAINT_DETAIL
          ? paintRecords.filter(record => (record.L3 as { isFollowingEnd?: boolean } | null)?.isFollowingEnd === false).length
          : null,
      },
      eventPaintCounts,
      paintRecords: paintRecords.map(({ texts, ...rest }) => rest),
      prefixRecords,
      oscillations,
      oldFlashbacks,
      intraPaintWindows,
      critical: {
        liveDisappearance: liveDisappearancePaints.map(({ record }) => ({ paintSeq: record.paintSeq, chunkSeq: record.chunkSeq })),
        liveBlockMissing: liveBlockMissingPaints.map(({ record }) => ({ paintSeq: record.paintSeq, chunkSeq: record.chunkSeq })),
        answerDisappearance: answerDisappearancePaints.map(({ record }) => ({ paintSeq: record.paintSeq, chunkSeq: record.chunkSeq })),
        oldReappearance: oldReappearancePaints.map(({ record }) => ({ paintSeq: record.paintSeq, chunkSeq: record.chunkSeq })),
      },
      screens: paintRecords.map(record => ({ paintSeq: record.paintSeq, chunkSeq: record.chunkSeq, texts: record.texts })),
    }
    mkdirSync(OUT_DIR, { recursive: true })
    const name = SOURCE === 'session' ? `${LABEL}-session-t${SESSION_TURN}-${CADENCE}` : `${LABEL}-replay-${CADENCE}`
    writeFileSync(join(OUT_DIR, `${name}.json`), `${JSON.stringify(payload, null, 1)}\n`)
    console.log(`${name}: ${JSON.stringify(payload.metrics)}`)
    if (REAL_TERMINAL) {
      const bytes = writes.reduce((total, record) => total + record.data.length, 0)
      const begins = writes.filter(record => record.data.includes('\x1b[?2026h')).length
      const ends = writes.filter(record => record.data.includes('\x1b[?2026l')).length
      console.log(`[replay] summary: writes=${writes.length} bytes=${bytes} syncBegin=${begins} syncEnd=${ends}`
        + ` sync=${SYNC_OFF ? 'off (diagnostic)' : 'on'} window=${WINDOW || 'full'} loops=${LOOPS}`)
      console.log('[replay] report: 1) current Markdown/assistant area vanishing as a block? 2) old already-scrolled-out'
        + ' content briefly visible? 3) recovery on the next frame? (ordinary 1-row follow-end scroll / table reflow'
        + ' / Thinking card movement does NOT count)')
    }
  } finally {
    prototype.doRender = originalDoRender
    if (!app.isDisposed()) app.dispose()
  }
}

await main()
