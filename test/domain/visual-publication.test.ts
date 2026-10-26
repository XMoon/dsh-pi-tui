/**
 * The visual publication authority over one committed Session log.
 *
 * These cases use HAND-BUILT durable event samples (never a second production
 * parser) and assert the two layers the Host tool body and cold replay share:
 * which generating occurrences are publishable sources, and which
 * `present_visual` occurrences actually published something.
 *
 * The identity rules under test are the load-bearing ones: a bare `callId` is
 * not an identity, the tool NAME must come from the durable `tool/call`, a
 * source in the publisher's own step is refused even when it committed first,
 * and any replaced/failed/duplicated/out-of-order occurrence publishes nothing.
 * @module @xmoon76/dsh-pi-tui/domain/visual-publication.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { chartArgsProblem, chartContentBlocks, chartFactFromArgs, type ChartArgs } from '../../src/domain/visual/chart.ts'
import { svgArgsProblem, svgContentBlocks, svgDigest, svgFactFromArgs } from '../../src/domain/visual/svg.ts'
import { visualReference, visualReferenceLine } from '../../src/domain/visual/reference.ts'
import { CHART_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME, SVG_TOOL_NAME } from '../../src/domain/visual/tools.ts'
import {
  collectPublishedVisuals,
  collectVisualSources,
  decidePublication,
  parsePresentVisualArguments,
  humanFacingVisualResult,
  parsePublicationReceipt,
  VISUAL_PUBLISHED_PREFIX,
  type VisualSessionEvent,
} from '../../src/domain/visual/publication.ts'

const SESSION = 'session-under-test'

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/><text x="4" y="20" font-size="12">Gateway</text></svg>'

const CHART_ARGS: ChartArgs = {
  kind: 'bars',
  title: 'Request latency',
  unit: 'ms',
  series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
}

const SVG_ARGS = { title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }

/** The identity tuple of one generating occurrence, mirroring the projection. */
interface Tuple {
  readonly turn: number
  readonly stepStartSeq: number
  readonly callId: string
}

/**
 * A hand-built committed log: one turn per `turn`, one step per entry, and the
 * events of each entry appended in order with contiguous seqs.
 */
class LogBuilder {
  private readonly log: VisualSessionEvent[] = []
  private seq = 0

  private push(event: Omit<VisualSessionEvent, 'seq'> & { type: VisualSessionEvent['type'] }): number {
    const seq = this.seq
    this.seq += 1
    this.log.push({ ...event, seq } as VisualSessionEvent)
    return seq
  }

  /** Append one raw event (used for shapes the builder has no dedicated verb for). */
  appendRaw(event: { readonly type: string; readonly data: unknown; readonly surfaceOp?: unknown }): number {
    const seq = this.seq
    this.seq += 1
    this.log.push({ ...event, seq } as unknown as VisualSessionEvent)
    return seq
  }

  turnStart(turn: number): this {
    this.push({ type: 'turn/start', data: { turn } })
    return this
  }

  turnEnd(turn: number): this {
    this.push({ type: 'turn/end', data: { turn } })
    return this
  }

  stepStart(turn: number, step: number): number {
    return this.push({ type: 'step/start', data: { turn, step } })
  }

  stepEnd(turn: number, step: number): this {
    this.push({ type: 'step/end', data: { turn, step } })
    return this
  }

  /** Append one tool call INSIDE the currently open step frame. */
  callInOpenStep(turn: number, step: number, callId: string, name: string, args: unknown): this {
    this.push({
      type: 'tool/call',
      data: { turn, step, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
    })
    return this
  }

  /** Open a step and append one tool call; returns the owning step's identity. */
  call(turn: number, step: number, callId: string, name: string, args: unknown): Tuple {
    const stepStartSeq = this.stepStart(turn, step)
    this.callInOpenStep(turn, step, callId, name, args)
    return { turn, stepStartSeq, callId }
  }

  /** The identity of the step frame opened by the most recent `stepStart`. */
  lastStepStartSeq(): number {
    return this.seq - 1
  }

  result(turn: number, step: number, callId: string, content: readonly ContentBlock[], isError = false): this {
    this.push({ type: 'tool/result', data: { turn, step, message: { toolCallId: callId, content, isError } } })
    return this
  }

  /** Append a generating tool call + its successful result, with the ref block. */
  generate(turn: number, step: number, callId: string, kind: 'chart' | 'svg'): { tuple: Tuple; ref: string } {
    const tuple = this.call(turn, step, callId, kind === 'chart' ? 'dsh_pi_tui_chart' : 'dsh_pi_tui_svg',
      kind === 'chart' ? CHART_ARGS : SVG_ARGS)
    const ref = visualReference({ sessionId: SESSION, ...tuple })
    const fact = kind === 'chart' ? chartContentBlocks(chartFactFromArgs(CHART_ARGS)) : svgContentBlocks(svgFactFromArgs(SVG_ARGS))
    this.result(turn, step, callId, [
      ...fact.slice(0, -1),
      { type: 'text', text: visualReferenceLine(ref) },
      fact[fact.length - 1] as ContentBlock,
    ])
    return { tuple, ref }
  }

  /** Append a `present_visual` call + its receipt result. */
  publish(turn: number, step: number, callId: string, refs: readonly string[]): { tuple: Tuple; receipt: string } {
    const tuple = this.call(turn, step, callId, 'present_visual', { visuals: refs.map(ref => ({ ref })) })
    const receipt = { version: 1, published: refs.map(ref => ({ ref })) }
    this.result(turn, step, callId, [
      { type: 'text', text: `Selected ${refs.length} visual${refs.length === 1 ? '' : 's'} for presentation.` },
      { type: 'text', text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify(receipt)}` },
    ])
    return { tuple, receipt: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify(receipt)}` }
  }

  events(): readonly VisualSessionEvent[] {
    return this.log
  }
}

/** One turn with a chart in step 0 and a publication in step 1. */
function publishedTurn(): { log: LogBuilder; ref: string } {
  const log = new LogBuilder().turnStart(1)
  const { ref } = log.generate(1, 0, 'call-chart', 'chart')
  log.stepEnd(1, 0)
  log.publish(1, 1, 'call-present', [ref])
  log.stepEnd(1, 1).turnEnd(1)
  return { log, ref }
}

// ── the reference algorithm ────────────────────────────────────────────────

test('the reference is a stable golden value for one fixed identity tuple', () => {
  assert.equal(
    visualReference({ sessionId: 's', turn: 1, stepStartSeq: 4, callId: 'c' }),
    visualReference({ sessionId: 's', turn: 1, stepStartSeq: 4, callId: 'c' }),
  )
  assert.match(visualReference({ sessionId: 's', turn: 1, stepStartSeq: 4, callId: 'c' }), /^sv1_[0-9a-f]{20}$/u)
  // Every tuple field participates.
  const base = { sessionId: 's', turn: 1, stepStartSeq: 4, callId: 'c' }
  assert.notEqual(visualReference(base), visualReference({ ...base, sessionId: 's2' }))
  assert.notEqual(visualReference(base), visualReference({ ...base, turn: 2 }))
  assert.notEqual(visualReference(base), visualReference({ ...base, stepStartSeq: 5 }))
  assert.notEqual(visualReference(base), visualReference({ ...base, callId: 'c2' }))
})

test('the same figure title and call id in another step or turn is a different reference', () => {
  const first = new LogBuilder().turnStart(1)
  first.generate(1, 0, 'same', 'chart')
  first.turnEnd(1)
  first.turnStart(2)
  first.generate(2, 0, 'same', 'chart')
  const refs = collectVisualSources(SESSION, first.events()).map(source => source.ref)
  assert.equal(refs.length, 2, 'both occurrences are sources')
  assert.notEqual(refs[0], refs[1], 'the reused call id does not collapse the two identities')
})

// ── sources ────────────────────────────────────────────────────────────────

test('a successful chart/SVG result with its projected reference becomes a source', () => {
  const log = new LogBuilder().turnStart(1)
  const chart = log.generate(1, 0, 'call-chart', 'chart')
  const svg = log.generate(1, 1, 'call-svg', 'svg')
  log.turnEnd(1)
  const sources = collectVisualSources(SESSION, log.events())
  assert.deepEqual(sources.map(source => source.ref), [chart.ref, svg.ref])
  assert.deepEqual(sources.map(source => source.type), ['chart', 'svg'])
  const svgSource = sources[1]
  assert.ok(svgSource !== undefined)
  assert.equal(svgSource.svgSource, SVG_SOURCE, 'the admitted durable call source is carried')
  assert.equal(svgSource.svg?.digest, svgDigest(SVG_SOURCE))
})

test('a missing, mismatched or malformed reference block never becomes a source', () => {
  // No ref block at all.
  const withoutRef = new LogBuilder().turnStart(1)
  withoutRef.call(1, 0, 'c1', 'dsh_pi_tui_chart', CHART_ARGS)
  withoutRef.result(1, 0, 'c1', chartContentBlocks(chartFactFromArgs(CHART_ARGS)))
  withoutRef.turnEnd(1)
  assert.deepEqual(collectVisualSources(SESSION, withoutRef.events()), [])

  // A ref block derived from a DIFFERENT tuple.
  const wrongRef = new LogBuilder().turnStart(1)
  wrongRef.call(1, 0, 'c1', 'dsh_pi_tui_chart', CHART_ARGS)
  const chartBlocks = chartContentBlocks(chartFactFromArgs(CHART_ARGS))
  wrongRef.result(1, 0, 'c1', [
    chartBlocks[0] as ContentBlock,
    { type: 'text', text: visualReferenceLine(visualReference({ sessionId: SESSION, turn: 1, stepStartSeq: 0, callId: 'other' })) },
    chartBlocks[1] as ContentBlock,
  ])
  wrongRef.turnEnd(1)
  assert.deepEqual(collectVisualSources(SESSION, wrongRef.events()), [])

  // A malformed reference line.
  const malformed = new LogBuilder().turnStart(1)
  malformed.call(1, 0, 'c1', 'dsh_pi_tui_chart', CHART_ARGS)
  malformed.result(1, 0, 'c1', [
    chartBlocks[0] as ContentBlock,
    { type: 'text', text: 'visual-ref-v1:sv1_NOT_LOWERCASE_HEX00' },
    chartBlocks[1] as ContentBlock,
  ])
  malformed.turnEnd(1)
  assert.deepEqual(collectVisualSources(SESSION, malformed.events()), [])
})

test('a reference block in the wrong POSITION is not a projected reference', () => {
  const blocks = chartContentBlocks(chartFactFromArgs(CHART_ARGS))
  const tuple = new LogBuilder().turnStart(1).call(1, 0, 'c1', 'dsh_pi_tui_chart', CHART_ARGS)
  const ref = visualReference({ sessionId: SESSION, ...tuple })
  // The ref text is present but NOT immediately before the fact: it sits before
  // the human block instead. Position, not presence, is the contract.
  const log = new LogBuilder().turnStart(1)
  log.call(1, 0, 'c1', 'dsh_pi_tui_chart', CHART_ARGS)
  log.result(1, 0, 'c1', [
    { type: 'text', text: visualReferenceLine(ref) },
    blocks[0] as ContentBlock,
    blocks[1] as ContentBlock,
  ])
  log.turnEnd(1)
  assert.deepEqual(collectVisualSources(SESSION, log.events()), [],
    'a reference block that is not the one immediately before the fact is not projected')

  // A reference block AFTER the fact is likewise not a projected reference.
  const after = new LogBuilder().turnStart(1)
  after.call(1, 0, 'c1', 'dsh_pi_tui_chart', CHART_ARGS)
  after.result(1, 0, 'c1', [
    blocks[0] as ContentBlock,
    blocks[1] as ContentBlock,
    { type: 'text', text: visualReferenceLine(ref) },
  ])
  after.turnEnd(1)
  assert.deepEqual(collectVisualSources(SESSION, after.events()), [])
})

test('a failed result, a mismatched fact type or a replaced credential never becomes a source', () => {
  // isError result.
  const failed = new LogBuilder().turnStart(1)
  const tuple = failed.call(1, 0, 'c1', 'dsh_pi_tui_chart', CHART_ARGS)
  const ref = visualReference({ sessionId: SESSION, ...tuple })
  const blocks = chartContentBlocks(chartFactFromArgs(CHART_ARGS))
  failed.result(1, 0, 'c1', [
    blocks[0] as ContentBlock,
    { type: 'text', text: visualReferenceLine(ref) },
    blocks[1] as ContentBlock,
  ], true)
  failed.turnEnd(1)
  assert.deepEqual(collectVisualSources(SESSION, failed.events()), [])

  // A chart tool whose final fact is an SVG credential: the type must match.
  const mismatched = new LogBuilder().turnStart(1)
  const t2 = mismatched.call(1, 0, 'c2', 'dsh_pi_tui_chart', CHART_ARGS)
  const ref2 = visualReference({ sessionId: SESSION, ...t2 })
  const svgBlocks = svgContentBlocks(svgFactFromArgs(SVG_ARGS))
  mismatched.result(1, 0, 'c2', [
    svgBlocks[0] as ContentBlock,
    { type: 'text', text: visualReferenceLine(ref2) },
    svgBlocks[1] as ContentBlock,
  ])
  mismatched.turnEnd(1)
  assert.deepEqual(collectVisualSources(SESSION, mismatched.events()), [])

  // An SVG credential whose digest does not match the durable call source.
  const tampered = new LogBuilder().turnStart(1)
  const t3 = tampered.call(1, 0, 'c3', 'dsh_pi_tui_svg', SVG_ARGS)
  const ref3 = visualReference({ sessionId: SESSION, ...t3 })
  const replaced = svgContentBlocks(svgFactFromArgs({ ...SVG_ARGS, svg: `${SVG_SOURCE}<!-- replaced -->` }))
  tampered.result(1, 0, 'c3', [
    replaced[0] as ContentBlock,
    { type: 'text', text: visualReferenceLine(ref3) },
    replaced[1] as ContentBlock,
  ])
  tampered.turnEnd(1)
  assert.deepEqual(collectVisualSources(SESSION, tampered.events()), [])
})

test('a bare call id reused across turns does not merge two occurrences', () => {
  const log = new LogBuilder().turnStart(1)
  log.generate(1, 0, 'same-id', 'chart')
  log.stepEnd(1, 0).turnEnd(1)
  log.turnStart(2)
  log.generate(2, 0, 'same-id', 'svg')
  log.stepEnd(2, 0).turnEnd(2)
  const sources = collectVisualSources(SESSION, log.events())
  assert.equal(sources.length, 2)
  assert.deepEqual(sources.map(source => source.turn), [1, 2])
})

test('a duplicated call identity or a second result makes the occurrence unpublishable', () => {
  const duplicateCall = new LogBuilder().turnStart(1)
  duplicateCall.generate(1, 0, 'dup', 'chart')
  duplicateCall.stepEnd(1, 0)
  // The SAME composite identity `(turn 1, step 0, callId dup)` is logged a
  // second time (a re-opened step frame with the same step number).
  duplicateCall.stepStart(1, 0)
  duplicateCall.callInOpenStep(1, 0, 'dup', 'dsh_pi_tui_chart', CHART_ARGS)
  duplicateCall.turnEnd(1)
  assert.deepEqual(collectVisualSources(SESSION, duplicateCall.events()), [],
    'a duplicated (turn, step, callId) is ambiguous')

  const twoResults = new LogBuilder().turnStart(1)
  const { tuple } = twoResults.generate(1, 0, 'twice', 'chart')
  const ref = visualReference({ sessionId: SESSION, ...tuple })
  const blocks = chartContentBlocks(chartFactFromArgs(CHART_ARGS))
  const content: ContentBlock[] = [
    blocks[0] as ContentBlock,
    { type: 'text', text: visualReferenceLine(ref) },
    blocks[1] as ContentBlock,
  ]
  twoResults.result(1, 0, 'twice', content)
  twoResults.turnEnd(1)
  assert.deepEqual(collectVisualSources(SESSION, twoResults.events()), [], 'a second result is ambiguous')
})

test('a call outside an open step frame never becomes a source', () => {
  const log = new LogBuilder().turnStart(1)
  log.stepStart(1, 0)
  log.stepEnd(1, 0)
  // No open step: the call has no durable step identity, so it is not indexed.
  log.callInOpenStep(1, 1, 'orphan', 'dsh_pi_tui_chart', CHART_ARGS)
  const ref = visualReference({ sessionId: SESSION, turn: 1, stepStartSeq: 0, callId: 'orphan' })
  const blocks = chartContentBlocks(chartFactFromArgs(CHART_ARGS))
  log.result(1, 1, 'orphan', [
    blocks[0] as ContentBlock,
    { type: 'text', text: visualReferenceLine(ref) },
    blocks[1] as ContentBlock,
  ])
  log.turnEnd(1)
  assert.deepEqual(collectVisualSources(SESSION, log.events()), [])
})

// ── publications ───────────────────────────────────────────────────────────

test('a real present_visual call/result pair publishes its reference once', () => {
  const { log, ref } = publishedTurn()
  const published = collectPublishedVisuals(SESSION, log.events())
  assert.equal(published.length, 1)
  assert.equal(published[0]?.ref, ref)
  assert.equal(published[0]?.source.type, 'chart')
  assert.equal(published[0]?.callId, 'call-present')
})

test('a non-visual tool whose RESULT text claims the chart shape is not a source', () => {
  // The durable call owns the tool identity. This `bash` result satisfies EVERY
  // other qualifier — the exact projected reference block plus a valid final
  // chart fact — so only the real `tool/call` name can refuse it.
  const log = new LogBuilder().turnStart(1)
  const tuple = log.call(1, 0, 'call-bash', 'bash', { command: 'cat chart.json' })
  const ref = visualReference({ sessionId: SESSION, ...tuple })
  const blocks = chartContentBlocks(chartFactFromArgs(CHART_ARGS))
  log.result(1, 0, 'call-bash', [
    blocks[0] as ContentBlock,
    { type: 'text', text: visualReferenceLine(ref) },
    blocks[1] as ContentBlock,
  ])
  log.turnEnd(1)
  const events = log.events()
  // Control: the very same result shape under the REAL chart name IS a source,
  // so this case cannot pass merely because the shape is unqualified.
  const control = new LogBuilder().turnStart(1)
  const controlTuple = control.call(1, 0, 'call-chart', 'dsh_pi_tui_chart', CHART_ARGS)
  const controlRef = visualReference({ sessionId: SESSION, ...controlTuple })
  control.result(1, 0, 'call-chart', [
    blocks[0] as ContentBlock,
    { type: 'text', text: visualReferenceLine(controlRef) },
    blocks[1] as ContentBlock,
  ])
  control.turnEnd(1)
  assert.equal(collectVisualSources(SESSION, control.events()).length, 1, 'the shape alone qualifies under the real name')
  assert.deepEqual(collectVisualSources(SESSION, events), [],
    'the durable tool/call name, not the result text, decides the tool')
})

test('a fabricated receipt from another tool publishes nothing', () => {
  const log = new LogBuilder().turnStart(1)
  const { ref } = log.generate(1, 0, 'call-chart', 'chart')
  log.stepEnd(1, 0)
  // A `bash` call whose RESULT happens to carry a valid-looking receipt.
  log.call(1, 1, 'call-bash', 'bash', { command: 'echo hi' })
  log.result(1, 1, 'call-bash', [
    { type: 'text', text: `Selected 1 visual for presentation.` },
    { type: 'text', text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 1, published: [{ ref }] })}` },
  ])
  log.turnEnd(1)
  assert.deepEqual(collectPublishedVisuals(SESSION, log.events()), [])
})

test('an orphan publication result with no durable call publishes nothing', () => {
  const log = new LogBuilder().turnStart(1)
  const { ref } = log.generate(1, 0, 'call-chart', 'chart')
  log.stepEnd(1, 0).stepStart(1, 1)
  log.result(1, 1, 'call-present', [
    { type: 'text', text: 'Selected 1 visual for presentation.' },
    { type: 'text', text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 1, published: [{ ref }] })}` },
  ])
  log.turnEnd(1)
  assert.deepEqual(collectPublishedVisuals(SESSION, log.events()), [])
})

test('a receipt whose refs differ from the model arguments publishes nothing', () => {
  const log = new LogBuilder().turnStart(1)
  const first = log.generate(1, 0, 'chart-a', 'chart')
  const second = log.generate(1, 1, 'chart-b', 'chart')
  log.stepEnd(1, 1)
  // The call asks for the FIRST ref, the receipt claims the SECOND.
  log.call(1, 2, 'call-present', 'present_visual', { visuals: [{ ref: first.ref }] })
  log.result(1, 2, 'call-present', [
    { type: 'text', text: 'Selected 1 visual for presentation.' },
    { type: 'text', text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 1, published: [{ ref: second.ref }] })}` },
  ])
  log.turnEnd(1)
  assert.deepEqual(collectPublishedVisuals(SESSION, log.events()), [])
})

test('a source published from the publisher’s own step is refused', () => {
  const log = new LogBuilder().turnStart(1)
  log.stepStart(1, 0)
  // The chart call and the publication call both live in step 0.
  log.call(1, 0, 'chart-same-step', 'dsh_pi_tui_chart', CHART_ARGS)
  const stepStartSeq = 0
  const ref = visualReference({ sessionId: SESSION, turn: 1, stepStartSeq, callId: 'chart-same-step' })
  const blocks = chartContentBlocks(chartFactFromArgs(CHART_ARGS))
  log.result(1, 0, 'chart-same-step', [
    blocks[0] as ContentBlock,
    { type: 'text', text: visualReferenceLine(ref) },
    blocks[1] as ContentBlock,
  ])
  // The same step. The chart committed FIRST, and that is still not enough.
  log.call(1, 0, 'present-same-step', 'present_visual', { visuals: [{ ref }] })
  log.result(1, 0, 'present-same-step', [
    { type: 'text', text: 'Selected 1 visual for presentation.' },
    { type: 'text', text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 1, published: [{ ref }] })}` },
  ])
  log.turnEnd(1)
  assert.deepEqual(collectPublishedVisuals(SESSION, log.events()), [],
    'a source in the publisher own step is refused even after committing first')
})

test('a cross-turn reference publishes nothing', () => {
  const log = new LogBuilder().turnStart(1)
  const { ref } = log.generate(1, 0, 'chart-turn-1', 'chart')
  log.stepEnd(1, 0).turnEnd(1)
  log.turnStart(2)
  log.publish(2, 0, 'present-turn-2', [ref])
  log.stepEnd(2, 0).turnEnd(2)
  assert.deepEqual(collectPublishedVisuals(SESSION, log.events()), [])
})

test('a failed publication result publishes nothing even with a valid receipt body', () => {
  const { log, ref } = publishedTurn()
  // Rewrite the publication result as a FAILED result carrying the receipt.
  const events = [...log.events()]
  const index = events.findIndex(event => event.type === 'tool/result')
  const original = events[index] as Extract<VisualSessionEvent, { type: 'tool/result' }>
  events[index] = {
    ...original,
    data: { ...original.data, message: { ...original.data.message, isError: true } },
  }
  void ref
  assert.deepEqual(collectPublishedVisuals(SESSION, events), [])
})

test('repeated publications keep the FIRST successful occurrence of one reference', () => {
  const log = new LogBuilder().turnStart(1)
  const { ref } = log.generate(1, 0, 'chart', 'chart')
  log.stepEnd(1, 0)
  log.publish(1, 1, 'present-1', [ref])
  log.stepEnd(1, 1)
  log.publish(1, 2, 'present-2', [ref])
  log.stepEnd(1, 2).turnEnd(1)
  const published = collectPublishedVisuals(SESSION, log.events())
  assert.equal(published.length, 1)
  assert.equal(published[0]?.callId, 'present-1')
})

// ── model-only surface replacements (the compaction pruner) ────────────────

/**
 * Extend the builder with one MODEL-ONLY `tool/result` replacement: the exact
 * shape the official `ToolResultPruner` appends (`...event.data`, marked
 * `surfaceOp: { op: 'replace' }`, citing the shadowed node).
 */
function appendReplacement(
  log: LogBuilder,
  turn: number,
  step: number,
  callId: string,
  content: readonly ContentBlock[],
): void {
  log.appendRaw({
    type: 'tool/result',
    data: { turn, step, message: { toolCallId: callId, content, isError: false } },
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } as never,
  })
}

test('a model-only pruner replacement never retracts an accepted publication', () => {
  const log = new LogBuilder().turnStart(1)
  const { ref } = log.generate(1, 0, 'call-chart', 'chart')
  log.stepEnd(1, 0)
  log.publish(1, 1, 'call-present', [ref])
  log.stepEnd(1, 1)
  // The compaction pruner rewrites the MODEL-facing copy of the chart result:
  // same turn/step/callId, marked as a surface replacement.
  appendReplacement(log, 1, 0, 'call-chart', [
    { type: 'text', text: 'Request latency (ms)\np50  42 ms\n[pruned]' },
  ])
  log.turnEnd(1)
  const events = log.events()
  // The append-origin source is still the authority.
  const sources = collectVisualSources(SESSION, events)
  assert.equal(sources.length, 1, 'the replacement is NOT a second durable result')
  assert.equal(sources[0]?.ref, ref)
  // The already-accepted publication still replays.
  const published = collectPublishedVisuals(SESSION, events)
  assert.equal(published.length, 1, 'a pruner rewrite never retracts a publication')
  assert.equal(published[0]?.ref, ref)
})

test('a replacement-only log still yields no source, and an unmarked duplicate is still ambiguous', () => {
  // A replacement whose append-origin result was never observed proves nothing:
  // the replacement copy alone must not become a source.
  const replacedOnly = new LogBuilder().turnStart(1)
  const replacedTuple = replacedOnly.call(1, 0, 'call-chart', 'dsh_pi_tui_chart', CHART_ARGS)
  const replacedRef = visualReference({ sessionId: SESSION, ...replacedTuple })
  const replacedBlocks = chartContentBlocks(chartFactFromArgs(CHART_ARGS))
  // Only the MODEL-ONLY copy is present, carrying a perfectly valid fact and
  // reference. If the skip were wrong, this would read as a real source.
  appendReplacement(replacedOnly, 1, 0, 'call-chart', [
    replacedBlocks[0] as ContentBlock,
    { type: 'text', text: visualReferenceLine(replacedRef) },
    replacedBlocks[1] as ContentBlock,
  ])
  replacedOnly.turnEnd(1)
  assert.deepEqual(collectVisualSources(SESSION, replacedOnly.events()), [],
    'a replacement copy is never a source in its own right')

  // An UNMARKED second result is not a replacement marker and stays ambiguous.
  const unmarked = new LogBuilder().turnStart(1)
  const generated = unmarked.generate(1, 0, 'dup', 'chart')
  const blocks = chartContentBlocks(chartFactFromArgs(CHART_ARGS))
  unmarked.result(1, 0, 'dup', [
    blocks[0] as ContentBlock,
    { type: 'text', text: visualReferenceLine(generated.ref) },
    blocks[1] as ContentBlock,
  ])
  unmarked.turnEnd(1)
  assert.deepEqual(collectVisualSources(SESSION, unmarked.events()), [],
    'absence of the replacement marker is never treated as a rewrite')
})

// ── the live decision ──────────────────────────────────────────────────────

test('the live decision accepts an earlier-step committed source', () => {
  const log = new LogBuilder().turnStart(1)
  const { ref } = log.generate(1, 0, 'call-chart', 'chart')
  log.stepEnd(1, 0)
  const { tuple } = log.publish(1, 1, 'call-present', [ref])
  const decision = decidePublication({
    sessionId: SESSION,
    events: log.events(),
    refs: [ref],
    turn: tuple.turn,
    stepStartSeq: tuple.stepStartSeq,
    callId: tuple.callId,
  })
  assert.equal(decision.ok, true, decision.ok ? '' : decision.reason)
  if (!decision.ok) return
  assert.deepEqual(decision.receipt, { version: 1, published: [{ ref }] })
  assert.equal(decision.summary, 'Selected 1 visual for presentation.')
})

test('the live decision names the same-step and not-yet-committed refusals', () => {
  const sameStep = new LogBuilder().turnStart(1)
  const generated = sameStep.generate(1, 0, 'chart', 'chart')
  const { ref } = generated
  // The publication call lands INSIDE the same step frame as the chart.
  sameStep.callInOpenStep(1, 0, 'present', 'present_visual', { visuals: [{ ref }] })
  const present = { turn: 1, stepStartSeq: generated.tuple.stepStartSeq, callId: 'present' }
  sameStep.stepEnd(1, 0).turnEnd(1)
  const sameStepDecision = decidePublication({
    sessionId: SESSION,
    events: sameStep.events(),
    refs: [ref],
    turn: present.turn,
    stepStartSeq: present.stepStartSeq,
    callId: present.callId,
  })
  assert.equal(sameStepDecision.ok, false)
  assert.match(sameStepDecision.ok ? '' : sameStepDecision.reason, /later model step/u)

  // The generating call is committed, its result is NOT yet.
  const pending = new LogBuilder().turnStart(1)
  const tuple = pending.call(1, 0, 'chart', 'dsh_pi_tui_chart', CHART_ARGS)
  const pendingRef = visualReference({ sessionId: SESSION, ...tuple })
  pending.stepEnd(1, 0)
  const publisher = pending.call(1, 1, 'present', 'present_visual', { visuals: [{ ref: pendingRef }] })
  const pendingDecision = decidePublication({
    sessionId: SESSION,
    events: pending.events(),
    refs: [pendingRef],
    turn: publisher.turn,
    stepStartSeq: publisher.stepStartSeq,
    callId: publisher.callId,
  })
  assert.equal(pendingDecision.ok, false)
  assert.match(pendingDecision.ok ? '' : pendingDecision.reason, /not committed yet/u)
})

test('the live decision refuses duplicated refs, an unknown ref and a missing publisher call', () => {
  const log = new LogBuilder().turnStart(1)
  const { ref } = log.generate(1, 0, 'chart', 'chart')
  log.stepEnd(1, 0)
  const { tuple } = log.publish(1, 1, 'present', [ref])
  const base = { sessionId: SESSION, events: log.events(), turn: tuple.turn, stepStartSeq: tuple.stepStartSeq, callId: tuple.callId }

  // A caller-supplied list that disagrees with the DURABLE arguments is refused
  // before any identity work: the log owns what was requested.
  const duplicated = decidePublication({ ...base, refs: [ref, ref] })
  assert.equal(duplicated.ok, false)
  assert.match(duplicated.ok ? '' : duplicated.reason, /disagree with the durable/u)

  // An UNKNOWN ref is a ref the durable call really requested but no committed
  // source owns: the durable arguments carry it, so the identity check runs.
  const unknownLog = new LogBuilder().turnStart(1)
  unknownLog.generate(1, 0, 'chart', 'chart')
  unknownLog.stepEnd(1, 0)
  const unknownTuple = unknownLog.publish(1, 1, 'present', ['sv1_00000000000000000000'])
  const unknown = decidePublication({
    sessionId: SESSION,
    events: unknownLog.events(),
    refs: ['sv1_00000000000000000000'],
    turn: unknownTuple.tuple.turn,
    stepStartSeq: unknownTuple.tuple.stepStartSeq,
    callId: unknownTuple.tuple.callId,
  })
  assert.equal(unknown.ok, false)
  assert.match(unknown.ok ? '' : unknown.reason, /unknown visual ref/u)

  const noCall = decidePublication({ ...base, callId: 'not-a-real-call', refs: [ref] })
  assert.equal(noCall.ok, false)
  assert.match(noCall.ok ? '' : noCall.reason, /no unique committed present_visual call/u)

  const empty = decidePublication({ ...base, refs: [] })
  assert.equal(empty.ok, false)
})

// ── the ONE argument contract (live and replay) ────────────────────────────

test('the shared argument contract refuses every non-official document', () => {
  const ok = 'sv1_0123456789abcdef0123'
  assert.deepEqual(parsePresentVisualArguments({ visuals: [{ ref: ok }] }), { ok: true, refs: [ok] })
  const rejected: readonly unknown[] = [
    {},
    { visuals: [] },
    { visuals: [{ ref: ok }], extra: 1 },
    { visuals: [{ ref: ok, note: 'diagram' }] },
    { visuals: [{ ref: ok }, { ref: ok }] },
    { visuals: [{ ref: 'not-a-ref' }] },
    { visuals: [{ ref: ok.toUpperCase() }] },
    { visuals: [ok] },
    { visuals: Array.from({ length: 9 }, (_, index) => ({ ref: `sv1_${String(index).padStart(20, '0')}` })) },
    [{ visuals: [{ ref: ok }] }],
    null,
  ]
  for (const document of rejected) {
    const decision = parsePresentVisualArguments(document)
    assert.equal(decision.ok, false, `must refuse: ${JSON.stringify(document)}`)
  }
})

test('a successful live receipt always parses back from its DURABLE arguments', () => {
  // The durable arguments are the authority: a body that accepted a document
  // the replay parser would reject cannot exist, because both call the same
  // function. This case pins the round trip on a real accepted publication.
  const log = new LogBuilder().turnStart(1)
  const { ref } = log.generate(1, 0, 'chart', 'chart')
  log.stepEnd(1, 0)
  const { tuple } = log.publish(1, 1, 'present', [ref])
  log.turnEnd(1)
  const events = log.events()
  const call = events.find((event): event is Extract<VisualSessionEvent, { type: 'tool/call' }> =>
    event.type === 'tool/call' && event.data.callId === 'present')
  assert.ok(call !== undefined)
  const parsed = parsePresentVisualArguments(JSON.parse(call.data.arguments))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.ok ? [...parsed.refs] : [], [ref])
  const decision = decidePublication({
    sessionId: SESSION,
    events,
    refs: [ref],
    turn: tuple.turn,
    stepStartSeq: tuple.stepStartSeq,
    callId: tuple.callId,
  })
  assert.equal(decision.ok, true, decision.ok ? '' : decision.reason)
  // And the REPLAY of the same log reports exactly that publication.
  assert.equal(collectPublishedVisuals(SESSION, events).length, 1)
})

test('a duplicated publisher callId is refused by the LIVE path exactly as replay does', () => {
  // Two `present_visual` calls share one composite identity in the same step.
  // Replay already skips ambiguous calls, so the live decision must refuse too.
  const log = new LogBuilder().turnStart(1)
  const { ref } = log.generate(1, 0, 'chart', 'chart')
  log.stepEnd(1, 0)
  log.stepStart(1, 1)
  log.callInOpenStep(1, 1, 'present', 'present_visual', { visuals: [{ ref }] })
  log.result(1, 1, 'present', [
    { type: 'text', text: 'Selected 1 visual for presentation.' },
    { type: 'text', text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 1, published: [{ ref }] })}` },
  ])
  // The SAME composite identity appears again.
  log.callInOpenStep(1, 1, 'present', 'present_visual', { visuals: [{ ref }] })
  log.turnEnd(1)
  const events = log.events()
  const stepStartSeq = events.find((event): event is Extract<VisualSessionEvent, { type: 'step/start' }> =>
    event.type === 'step/start' && event.data.step === 1)!.seq

  const live = decidePublication({
    sessionId: SESSION,
    events,
    refs: [ref],
    turn: 1,
    stepStartSeq,
    callId: 'present',
  })
  assert.equal(live.ok, false, 'the live path must refuse an ambiguous publisher')
  assert.match(live.ok ? '' : live.reason, /no unique committed present_visual call/u)
  // And replay agrees: nothing was published.
  assert.deepEqual(collectPublishedVisuals(SESSION, events), [])
})

// ── the receipt parser ─────────────────────────────────────────────────────

test('the receipt parser accepts only the exact version-1 shape', () => {
  const ref = 'sv1_0123456789abcdef0123'
  const ok = parsePublicationReceipt([
    { type: 'text', text: 'Selected 1 visual for presentation.' },
    { type: 'text', text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 1, published: [{ ref }] })}` },
  ], false)
  assert.ok(ok !== undefined)
  assert.equal(ok.humanText, 'Selected 1 visual for presentation.')

  const wrongVersion = parsePublicationReceipt([
    { type: 'text', text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 2, published: [{ ref }] })}` },
  ], false)
  assert.equal(wrongVersion, undefined)

  const extraField = parsePublicationReceipt([
    { type: 'text', text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 1, published: [{ ref }], turn: 1 })}` },
  ], false)
  assert.equal(extraField, undefined)

  const extraEntryField = parsePublicationReceipt([
    { type: 'text', text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 1, published: [{ ref, title: 'x' }] })}` },
  ], false)
  assert.equal(extraEntryField, undefined)

  const duplicated = parsePublicationReceipt([
    { type: 'text', text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 1, published: [{ ref }, { ref }] })}` },
  ], false)
  assert.equal(duplicated, undefined)

  const onError = parsePublicationReceipt([
    { type: 'text', text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 1, published: [{ ref }] })}` },
  ], true)
  assert.equal(onError, undefined)
})

// ── the human-facing projection ────────────────────────────────────────────

test('the human projection drops only VALID official tail machine blocks', () => {
  const fact = chartContentBlocks(chartFactFromArgs(CHART_ARGS))[1] as Extract<ContentBlock, { type: 'text' }>
  const blocks: ContentBlock[] = [
    { type: 'text', text: 'Request latency (ms)\np50  42 ms' },
    { type: 'text', text: visualReferenceLine('sv1_0123456789abcdef0123') },
    fact,
  ]
  const chart = humanFacingVisualResult({
    toolName: 'dsh_pi_tui_chart', blocks, text: '',
  })
  assert.equal(chart.text, 'Request latency (ms)\np50  42 ms')
  assert.deepEqual(chart.blocks, [{ type: 'text', text: 'Request latency (ms)\np50  42 ms' }])

  // A machine-looking line INSIDE the human body stays.
  const insideBody = humanFacingVisualResult({
    toolName: 'dsh_pi_tui_chart',
    blocks: [
      { type: 'text', text: 'title: visual-v1: CPU usage' },
      { type: 'text', text: visualReferenceLine('sv1_0123456789abcdef0123') },
      fact,
    ],
    text: '',
  })
  assert.equal(insideBody.text, 'title: visual-v1: CPU usage')
})

test('the human projection keeps an official tool’s ordinary PROSE that only looks like a machine block', () => {
  // A policy replacement inside an official visual tool can end with plain
  // human text that happens to start with a recognized prefix. It is NOT an
  // official machine block, so a human surface must keep it.
  const prose: ContentBlock[] = [
    { type: 'text', text: 'the chart was redacted by policy' },
    { type: 'text', text: 'visual-v1:{"type":"chart"}' },
  ]
  const replaced = humanFacingVisualResult({ toolName: 'dsh_pi_tui_chart', blocks: prose, text: '' })
  assert.equal(replaced.blocks.length, 2, 'an invalid fact body is human text, never stripped')
  assert.match(replaced.text, /redacted by policy/u)
  assert.match(replaced.text, /visual-v1:\{"type":"chart"\}/u)

  const refProse: ContentBlock[] = [
    { type: 'text', text: 'selected refs were visual-ref-v1: see the log' },
    { type: 'text', text: 'visual-ref-v1:not-a-reference' },
  ]
  const refReplaced = humanFacingVisualResult({ toolName: PRESENT_VISUAL_TOOL_NAME, blocks: refProse, text: '' })
  assert.equal(refReplaced.blocks.length, 2, 'a malformed reference line is human text')

  const receiptProse: ContentBlock[] = [
    { type: 'text', text: 'the receipt was visual-published-v1: in the log' },
    { type: 'text', text: 'visual-published-v1:{"version":1,"published":[]}' },
  ]
  const receiptReplaced = humanFacingVisualResult({ toolName: PRESENT_VISUAL_TOOL_NAME, blocks: receiptProse, text: '' })
  assert.equal(receiptReplaced.blocks.length, 2, 'an empty publication body is human text')
})

test('a flat-text visual result keeps prose that only looks like a machine line', () => {
  const fact = chartContentBlocks(chartFactFromArgs(CHART_ARGS))[1] as Extract<ContentBlock, { type: 'text' }>
  const flat = humanFacingVisualResult({
    toolName: CHART_TOOL_NAME,
    blocks: undefined,
    text: `the chart was replaced\nvisual-v1:{"type":"chart"}\n${fact.text}`,
  })
  assert.match(flat.text, /the chart was replaced/u)
  assert.match(flat.text, /visual-v1:\{"type":"chart"\}/u, 'the invalid fact body survives')
  assert.doesNotMatch(flat.text, /"series"/u, 'the VALID official fact line is still stripped')
})

test('a fact-SHAPED line that the official serializer could not produce stays human text', () => {
  // Each line has the right KEYS and version but violates the official value
  // rules, so it cannot be a machine block: a policy-replaced official result
  // ending with such prose must keep it.
  const malformed: readonly string[] = [
    // chart: bad kind enum
    'visual-v1:{"version":1,"type":"chart","kind":"pie","title":"t","series":[{"label":"a","value":1},{"label":"b","value":2}]}',
    // chart: too few points
    'visual-v1:{"version":1,"type":"chart","kind":"bars","title":"t","series":[{"label":"a","value":1}]}',
    // chart: too many points
    `visual-v1:{"version":1,"type":"chart","kind":"bars","title":"t","series":${JSON.stringify(Array.from({ length: 13 }, (_, index) => ({ label: `p${String(index)}`, value: index })))}}`,
    // chart: empty title
    'visual-v1:{"version":1,"type":"chart","kind":"bars","title":"   ","series":[{"label":"a","value":1},{"label":"b","value":2}]}',
    // chart: non-finite value
    'visual-v1:{"version":1,"type":"chart","kind":"bars","title":"t","series":[{"label":"a","value":1e999},{"label":"b","value":2}]}',
    // chart: string value
    'visual-v1:{"version":1,"type":"chart","kind":"bars","title":"t","series":[{"label":"a","value":"1"},{"label":"b","value":2}]}',
    // chart: extra key
    'visual-v1:{"version":1,"type":"chart","kind":"bars","title":"t","note":"x","series":[{"label":"a","value":1},{"label":"b","value":2}]}',
    // chart: over-budget title
    `visual-v1:{"version":1,"type":"chart","kind":"bars","title":"${'x'.repeat(101)}","series":[{"label":"a","value":1},{"label":"b","value":2}]}`,
    // chart: missing series
    'visual-v1:{"version":1,"type":"chart","kind":"bars","title":"t"}',
    // svg: short digest
    'visual-v1:{"version":1,"type":"svg","title":"t","description":"d","digest":"abc","bytes":10}',
    // svg: missing digest
    'visual-v1:{"version":1,"type":"svg","title":"t","description":"d","bytes":10}',
    // svg: missing title
    `visual-v1:{"version":1,"type":"svg","description":"d","digest":"${'a'.repeat(64)}","bytes":10}`,
    // svg: over-budget bytes
    `visual-v1:{"version":1,"type":"svg","title":"t","description":"d","digest":"${'a'.repeat(64)}","bytes":${String(128 * 1024 + 1)}}`,
    // svg: negative bytes
    `visual-v1:{"version":1,"type":"svg","title":"t","description":"d","digest":"${'a'.repeat(64)}","bytes":-1}`,
    // svg: non-integer bytes
    `visual-v1:{"version":1,"type":"svg","title":"t","description":"d","digest":"${'a'.repeat(64)}","bytes":1.5}`,
    // unknown type
    'visual-v1:{"version":1,"type":"heatmap","title":"t"}',
    // wrong version
    'visual-v1:{"version":2,"type":"chart","kind":"bars","title":"t","series":[{"label":"a","value":1},{"label":"b","value":2}]}',
  ]
  for (const line of malformed) {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'the fact was written by a human here' },
      { type: 'text', text: line },
    ]
    const chart = humanFacingVisualResult({ toolName: CHART_TOOL_NAME, blocks, text: '' })
    assert.equal(chart.blocks.length, 2, `a malformed fact line must stay human text: ${line}`)
    assert.match(chart.text, /the fact was written by a human here/u, line)
    const svg = humanFacingVisualResult({ toolName: SVG_TOOL_NAME, blocks, text: '' })
    assert.equal(svg.blocks.length, 2, `a malformed fact line must stay human text for SVG too: ${line}`)
  }

  // Control: the SAME shape with valid values IS stripped, so the cases above
  // cannot pass merely because nothing is ever stripped.
  const valid = chartContentBlocks(chartFactFromArgs(CHART_ARGS))[1] as Extract<ContentBlock, { type: 'text' }>
  const control = humanFacingVisualResult({
    toolName: CHART_TOOL_NAME,
    blocks: [{ type: 'text', text: 'the chart was here' }, valid],
    text: '',
  })
  assert.equal(control.blocks.length, 1, 'a VALID official fact line is still stripped')
  assert.equal(control.text, 'the chart was here')
})

test('a VALID fact line for the WRONG tool stays human text', () => {
  // Both lines are fully valid official facts, but each belongs to the OTHER
  // tool. The tool-to-fact pairing is part of the identity, so neither may be
  // stripped from the tool that cannot have produced it.
  const chartFact = chartContentBlocks(chartFactFromArgs(CHART_ARGS))[1] as Extract<ContentBlock, { type: 'text' }>
  const svgFact = svgContentBlocks(svgFactFromArgs(SVG_ARGS))[1] as Extract<ContentBlock, { type: 'text' }>

  const chartOnSvg = humanFacingVisualResult({
    toolName: SVG_TOOL_NAME,
    blocks: [{ type: 'text', text: 'the svg body' }, chartFact],
    text: '',
  })
  assert.equal(chartOnSvg.blocks.length, 2, 'a chart fact is never an SVG machine block')
  assert.match(chartOnSvg.text, /the svg body/u)

  const svgOnChart = humanFacingVisualResult({
    toolName: CHART_TOOL_NAME,
    blocks: [{ type: 'text', text: 'the chart body' }, svgFact],
    text: '',
  })
  assert.equal(svgOnChart.blocks.length, 2, 'an SVG fact is never a chart machine block')

  // A receipt belongs only to the publication tool.
  const receipt = 'visual-published-v1:{"version":1,"published":[{"ref":"sv1_0123456789abcdef0123"}]}'
  for (const toolName of [CHART_TOOL_NAME, SVG_TOOL_NAME]) {
    const onGenerator = humanFacingVisualResult({
      toolName,
      blocks: [{ type: 'text', text: `a receipt written by policy: ${toolName}` }, { type: 'text', text: receipt }],
      text: '',
    })
    assert.equal(onGenerator.blocks.length, 2, `a receipt is not a ${toolName} machine block`)
  }
  // Control: the receipt on its OWN tool is stripped.
  const ownReceipt = humanFacingVisualResult({
    toolName: PRESENT_VISUAL_TOOL_NAME,
    blocks: [{ type: 'text', text: 'Selected 1 visual for presentation.' }, { type: 'text', text: receipt }],
    text: '',
  })
  assert.equal(ownReceipt.blocks.length, 1)
  assert.equal(ownReceipt.text, 'Selected 1 visual for presentation.')
})

test('only the OFFICIAL tail COMPOSITION is stripped, never a merely machine-looking suffix', () => {
  const chartFact = chartContentBlocks(chartFactFromArgs(CHART_ARGS))[1] as Extract<ContentBlock, { type: 'text' }>
  const svgFact = svgContentBlocks(svgFactFromArgs(SVG_ARGS))[1] as Extract<ContentBlock, { type: 'text' }>
  const ref = visualReferenceLine('sv1_0123456789abcdef0123')
  const ref2 = visualReferenceLine('sv1_0123456789abcdef0124')
  const receipt = 'visual-published-v1:{"version":1,"published":[{"ref":"sv1_0123456789abcdef0123"}]}'

  const human = (text: string): ContentBlock[] => [{ type: 'text', text }]

  // 1. WRONG ORDER: ref AFTER the fact is not the projected composition.
  const refAfterFact = humanFacingVisualResult({
    toolName: CHART_TOOL_NAME,
    blocks: [...human('body'), chartFact, { type: 'text', text: ref }],
    text: '',
  })
  assert.equal(refAfterFact.blocks.length, 3, 'a reference after the fact is NOT the official tail')
  assert.match(refAfterFact.text, /body/u)

  // 2. TWO valid refs before the fact: the official generator emits at most one.
  const twoRefs = humanFacingVisualResult({
    toolName: CHART_TOOL_NAME,
    blocks: [...human('body'), { type: 'text', text: ref }, { type: 'text', text: ref2 }, chartFact],
    text: '',
  })
  assert.equal(twoRefs.blocks.length, 4, 'a second reference breaks the official tail')
  assert.match(twoRefs.text, /body/u)

  // 3. TWO valid facts: only the last one may be the single official fact, and
  //    then the block before it is a FACT, not a reference, so nothing strips.
  const twoFacts = humanFacingVisualResult({
    toolName: CHART_TOOL_NAME,
    blocks: [...human('body'), chartFact, chartFact],
    text: '',
  })
  assert.equal(twoFacts.blocks.length, 3, 'a duplicated fact is not the official tail')

  // 4. Reference WITHOUT a fact after it: no official composition.
  const refOnly = humanFacingVisualResult({
    toolName: CHART_TOOL_NAME,
    blocks: [...human('body'), { type: 'text', text: ref }],
    text: '',
  })
  assert.equal(refOnly.blocks.length, 2, 'a lone reference is not an official tail')

  // 5. TWO receipts on the publication tool: at most one is official.
  const twoReceipts = humanFacingVisualResult({
    toolName: PRESENT_VISUAL_TOOL_NAME,
    blocks: [...human('Selected 1 visual for presentation.'), { type: 'text', text: receipt }, { type: 'text', text: receipt }],
    text: '',
  })
  assert.equal(twoReceipts.blocks.length, 3, 'a duplicated receipt is not the official tail')

  // 6. A machine-looking TEXT block followed by an IMAGE block: the official
  //    tail is the END of the result, so a trailing non-text block protects the
  //    text before it.
  const trailingImage = humanFacingVisualResult({
    toolName: SVG_TOOL_NAME,
    blocks: [
      ...human('body'),
      svgFact,
      { type: 'image', attachment: { attachmentId: 'a'.repeat(64), name: 'x.png', width: 1, height: 1, mimeType: 'image/png' } } as never,
    ],
    text: '',
  })
  assert.equal(trailingImage.blocks.length, 3, 'a trailing non-text block is never stripped')

  // Controls: every OFFICIAL composition IS stripped.
  const factOnly = humanFacingVisualResult({
    toolName: CHART_TOOL_NAME,
    blocks: [...human('body'), chartFact],
    text: '',
  })
  assert.equal(factOnly.text, 'body', 'the fact alone is the legal no-reference composition')
  const refThenFact = humanFacingVisualResult({
    toolName: CHART_TOOL_NAME,
    blocks: [...human('body'), { type: 'text', text: ref }, chartFact],
    text: '',
  })
  assert.equal(refThenFact.text, 'body', 'ref immediately before the fact is the legal composition')
  const singleReceipt = humanFacingVisualResult({
    toolName: PRESENT_VISUAL_TOOL_NAME,
    blocks: [...human('Selected'), { type: 'text', text: receipt }],
    text: '',
  })
  assert.equal(singleReceipt.text, 'Selected')
})

test('the human projection never touches another tool’s similar text', () => {
  const blocks: ContentBlock[] = [
    { type: 'text', text: 'output' },
    { type: 'text', text: chartContentBlocks(chartFactFromArgs(CHART_ARGS))[1] as never },
  ]
  const bash = humanFacingVisualResult({ toolName: 'bash', blocks, text: '' })
  assert.deepEqual(bash.blocks, blocks)
  assert.equal(bash.text, '')

  // A flat-text result of the visual tool loses its machine tail too.
  const flat = humanFacingVisualResult({
    toolName: PRESENT_VISUAL_TOOL_NAME,
    blocks: undefined,
    text: `Selected 2 visuals for presentation.\n${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 1, published: [{ ref: 'sv1_0123456789abcdef0123' }, { ref: 'sv1_0123456789abcdef0124' }] })}`,
  })
  assert.equal(flat.text, 'Selected 2 visuals for presentation.')
})

test('the human projection keeps a failed visual result’s readable reason', () => {
  const human = humanFacingVisualResult({
    toolName: 'present_visual',
    blocks: [{ type: 'text', text: 'unknown visual ref sv1_0123456789abcdef0123' }],
    text: 'unknown visual ref sv1_0123456789abcdef0123',
  })
  assert.equal(human.text, 'unknown visual ref sv1_0123456789abcdef0123')
})

test('the readable filter recognises EVERY fact the official serializer can emit', () => {
  // The filter must never be STRICTER than the serializer: a fact the tools
  // really produced has to be recognised, or its machine lines leak into the
  // folded preview, search and the readable export.
  const accepted: readonly ChartArgs[] = [
    // whitespace-only unit: the official rule is `unit !== ''`.
    { kind: 'bars', title: 'A', unit: ' ', series: [{ label: 'p', value: 1 }, { label: 'q', value: 2 }] },
    // whitespace-only label: the official rule is `label !== ''`.
    { kind: 'spark', title: 'B', series: [{ label: ' ', value: 1 }, { label: '  ', value: -2 }] },
    // A title that is meaningful but padded (the official check trims it).
    { kind: 'bars', title: '  padded  ', series: [{ label: 'a', value: 0 }, { label: 'b', value: 0 }] },
    // The exact minimum and maximum point counts.
    { kind: 'bars', title: 'min', series: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] },
    {
      kind: 'spark',
      title: 'max',
      series: Array.from({ length: 12 }, (_, index) => ({ label: `p${String(index)}`, value: index })),
    },
    // Negative and zero values.
    { kind: 'bars', title: 'neg', series: [{ label: 'a', value: -1 }, { label: 'b', value: 0 }] },
  ]
  for (const args of accepted) {
    // The OFFICIAL validator must accept it...
    assert.equal(chartArgsProblem(args), undefined, `the official validator rejects ${JSON.stringify(args)}`)
    // ...and so must the filter.
    const fact = chartFactFromArgs(args)
    const blocks = chartContentBlocks(fact)
    const projected = humanFacingVisualResult({
      toolName: CHART_TOOL_NAME,
      blocks: [
        blocks[0] as ContentBlock,
        { type: 'text', text: visualReferenceLine('sv1_0123456789abcdef0123') },
        blocks[1] as ContentBlock,
      ],
      text: '',
    })
    assert.equal(projected.blocks.length, 1, `the filter failed to recognise ${JSON.stringify(args)}`)
    assert.doesNotMatch(projected.text, /visual-(?:ref|v1):/u, `machine text leaked for ${JSON.stringify(args)}`)
  }

  // The SVG side: whitespace-padded but meaningful title/description.
  const svgArgs = { title: ' T ', description: ' D ', svg: SVG_SOURCE }
  assert.equal(svgArgsProblem(svgArgs), undefined, 'the official validator accepts padded text')
  const svgBlocks = svgContentBlocks(svgFactFromArgs(svgArgs))
  const svgProjected = humanFacingVisualResult({
    toolName: SVG_TOOL_NAME,
    blocks: [
      svgBlocks[0] as ContentBlock,
      { type: 'text', text: visualReferenceLine('sv1_0123456789abcdef0123') },
      svgBlocks[1] as ContentBlock,
    ],
    text: '',
  })
  assert.equal(svgProjected.blocks.length, 1, 'the filter recognises the padded SVG credential')
})
