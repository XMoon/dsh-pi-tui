/**
 * The Direct display `/copy` chain: the latest official `assistant/message` is
 * qualified through the SAME Session's existing Folder and the PR1 publication
 * authority, then projected through the shared placement planner.
 *
 * Evidence level: the real `TranscriptFolder` + the real bridge over a
 * hand-built OFFICIAL event log. The model/tool execution is a stand-in; the
 * Session snapshot, folder settlement, publication replay, planner and payload
 * are production implementations. The post-await scope fence is covered by
 * `command-runtime-scope-fence.test.ts`; this file proves the identity links.
 * @module @xmoon76/dsh-pi-tui/app/visual-copy-display.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createPresentationBridge, type DirectSessionReads } from '../../src/app/bootstrap/presentation-bridge.ts'
import { chartContentBlocks, chartFactFromArgs, type ChartArgs } from '../../src/domain/visual/chart.ts'
import { visualReference, visualReferenceLine } from '../../src/domain/visual/reference.ts'
import { VISUAL_PUBLISHED_PREFIX } from '../../src/domain/transcript/visual-text.ts'
import { TranscriptFolder } from '../../src/transcript.ts'
import { SupersededReadError } from '../../src/runtime/read-error.ts'

const SESSION = 'session-display-copy'

const CHART_ARGS: ChartArgs = {
  kind: 'bars',
  title: 'Request latency',
  unit: 'ms',
  series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
}

function marker(ref: string): string {
  return `[dsh-visual-${ref}]: <#>`
}

/** One append-only builder for the official Session log used by BOTH sides. */
class Log {
  readonly events: SessionEvent[] = []

  private push(type: string, data: unknown): number {
    const seq = this.events.length
    this.events.push({ type, seq, time: seq + 1, data } as unknown as SessionEvent)
    return seq
  }

  turnStart(turn: number): this { this.push('turn/start', { turn }); return this }
  turnEnd(turn: number): this { this.push('turn/end', { turn, reason: { kind: 'completed' } }); return this }
  stepStart(turn: number, step: number): this { this.push('step/start', { turn, step }); return this }
  stepEnd(turn: number, step: number): this { this.push('step/end', { turn, step }); return this }

  assistant(turn: number, step: number, content: readonly ContentBlock[]): number {
    return this.push('assistant/message', {
      turn,
      step,
      message: {
        id: MessageId(`assistant-${turn}-${step}`),
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    })
  }

  private call(turn: number, step: number, callId: string, name: string, args: unknown): void {
    this.push('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) })
  }

  private result(turn: number, step: number, callId: string, content: readonly ContentBlock[]): number {
    return this.push('tool/result', { turn, step, message: { toolCallId: callId, content, isError: false } })
  }

  /** Append one chart generation (call + result) inside the OPEN step. */
  generateChart(turn: number, step: number, callId: string, stepStartSeq: number): string {
    this.call(turn, step, callId, 'dsh_pi_tui_chart', CHART_ARGS)
    const ref = visualReference({ sessionId: SESSION, turn, stepStartSeq, callId })
    const blocks = chartContentBlocks(chartFactFromArgs(CHART_ARGS))
    this.result(turn, step, callId, [
      ...blocks.slice(0, -1),
      { type: 'text', text: visualReferenceLine(ref) },
      blocks[blocks.length - 1] as ContentBlock,
    ])
    return ref
  }

  /** Append one `present_visual` call + accepted receipt inside the OPEN step. */
  publish(turn: number, step: number, callId: string, refs: readonly string[]): void {
    this.call(turn, step, callId, 'present_visual', { visuals: refs.map(ref => ({ ref })) })
    this.result(turn, step, callId, [
      { type: 'text', text: `Selected ${refs.length} visual${refs.length === 1 ? '' : 's'} for presentation.` },
      {
        type: 'text',
        text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 1, published: refs.map(ref => ({ ref })) })}`,
      },
    ])
  }

  get latestAssistantSeq(): number {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (this.events[index]?.type === 'assistant/message') return Number(this.events[index]!.seq)
    }
    throw new Error('the fixture has no assistant message')
  }
}

/**
 * One turn: step 0 generates the chart, step 1 publishes it, step 2 is the
 * final answer that consumes the marker.
 */
function publishedTurn(prefix: string, suffix: string): {
  log: Log
  ref: string
  finalSeq: number
  answer: string
} {
  const log = new Log().turnStart(1).stepStart(1, 0)
  const ref = log.generateChart(1, 0, 'chart-call', 1)
  log.assistant(1, 0, [{ type: 'text', text: '' }])
  log.stepEnd(1, 0)
  log.stepStart(1, 1)
  log.assistant(1, 1, [{ type: 'text', text: 'Publishing.' }])
  log.publish(1, 1, 'present-call', [ref])
  log.stepEnd(1, 1)
  log.stepStart(1, 2)
  const answer = `${prefix}${marker(ref)}${suffix}`
  const finalSeq = log.assistant(1, 2, [{ type: 'text', text: answer }])
  log.stepEnd(1, 2)
  log.turnEnd(1)
  return { log, ref, finalSeq, answer }
}

function sessionOf(events: readonly SessionEvent[]): DirectSessionReads {
  return {
    seq: events.length,
    snapshotEvents: () => events,
    eventAt: (seq: number) => events[seq],
  } as unknown as DirectSessionReads
}

function bridgeOf(options: {
  readonly events: readonly SessionEvent[]
  readonly folder?: TranscriptFolder
  readonly generation?: () => number
  readonly sessionId?: string
}): ReturnType<typeof createPresentationBridge> {
  const events = options.events
  return createPresentationBridge({
    remoteSources: undefined,
    currentSessionId: () => options.sessionId ?? SESSION,
    currentDirectAgent: () => undefined,
    assistantStreamBaselineFor: () => [],
    directSessionFor: () => sessionOf(events),
    mainFolder: () => options.folder,
    currentGeneration: options.generation ?? (() => 1),
  })
}

test('a consumed marker disappears from the Direct /copy payload while every other byte stays exact', () => {
  const { log, ref, finalSeq, answer } = publishedTurn('第一段。\r\n\r\n', '\r\n\r\n\tAfter 😀.\r\n')
  assert.match(ref, /^sv1_[0-9a-f]{20}$/u, 'the publication ref is the durable identity tuple')
  assert.ok(answer.includes(marker(ref)))
  const folder = new TranscriptFolder()
  folder.apply(log.events)
  // The one read-only accessor proves the exact settled step.
  assert.equal(folder.assistantSettlementSeq(1, 2), finalSeq)
  assert.equal(folder.assistantSettlementSeq(1, 9), undefined)

  const bridge = bridgeOf({ events: log.events, folder })
  assert.equal(
    bridge.directLastAssistantText(SESSION),
    '第一段。\r\n\r\n\r\n\r\n\tAfter 😀.\r\n',
    'only the consumed marker span is removed; CRLF/CJK/tab/emoji bytes are untouched',
  )
})

test('a marker-shaped answer with no publication returns the original text unchanged', () => {
  const answer = `Look: ${marker(`sv1_${'a'.repeat(20)}`)}`
  const log = new Log().turnStart(1).stepStart(1, 0)
  log.assistant(1, 0, [{ type: 'text', text: answer }])
  log.stepEnd(1, 0).turnEnd(1)
  const folder = new TranscriptFolder()
  folder.apply(log.events)
  const bridge = bridgeOf({ events: log.events, folder })
  assert.equal(bridge.directLastAssistantText(SESSION), answer, 'an unqualified marker is ordinary prose')
})

test('a publication whose settlement seq is not the latest official message fails closed', () => {
  const { log } = publishedTurn('Before.\n\n', '\n\nAfter.')
  // A torn fold that never applied the final assistant/message: its settlement
  // sidecar has no entry for the step, so the identity link cannot be proven.
  const folder = new TranscriptFolder()
  folder.apply(log.events.slice(0, log.events.length - 3))
  assert.equal(folder.assistantSettlementSeq(1, 2), undefined)
  const bridge = bridgeOf({ events: log.events, folder })
  assert.throws(
    () => bridge.directLastAssistantText(SESSION),
    (error: unknown) => error instanceof SupersededReadError,
    'a published marker never silently degrades to a guess',
  )
})

test('a final row whose body differs from the official event fails closed', () => {
  const { log, answer } = publishedTurn('Before.\n\n', '\n\nAfter.')
  const tampered = log.events.map(event => {
    if (event.type !== 'assistant/message' || event.data.turn !== 1 || event.data.step !== 2) return event
    return {
      ...event,
      data: {
        ...event.data,
        message: { ...event.data.message, content: [{ type: 'text', text: `${answer} ` }] },
      },
    } as SessionEvent
  })
  const folder = new TranscriptFolder()
  folder.apply(tampered)
  const bridge = bridgeOf({ events: log.events, folder })
  assert.throws(
    () => bridge.directLastAssistantText(SESSION),
    (error: unknown) => error instanceof SupersededReadError,
    'the official latest event and the eligible final row must be the same body',
  )
})

test('a superseded ownership generation fails closed after the publication read', () => {
  const { log } = publishedTurn('Before.\n\n', '\n\nAfter.')
  const folder = new TranscriptFolder()
  folder.apply(log.events)
  let generation = 1
  const bridge = bridgeOf({
    events: log.events,
    folder,
    generation: () => {
      const current = generation
      generation += 1
      return current
    },
  })
  assert.throws(
    () => bridge.directLastAssistantText(SESSION),
    (error: unknown) => error instanceof SupersededReadError,
    'a generation bump during the derivation never yields a payload',
  )
})

test('no assistant message yet returns undefined without touching the Folder', () => {
  const log = new Log().turnStart(1)
  const bridge = bridgeOf({ events: log.events })
  assert.equal(bridge.directLastAssistantText(SESSION), undefined)
})
