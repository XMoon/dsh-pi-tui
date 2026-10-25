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
import { chartContentBlocks, chartFactFromArgs, type ChartArgs } from '../../src/domain/visual/chart.ts'
import { svgContentBlocks, svgDigest, svgFactFromArgs } from '../../src/domain/visual/svg.ts'
import { visualReference, visualReferenceLine } from '../../src/domain/visual/reference.ts'
import {
  collectPublishedVisuals,
  collectVisualSources,
  decidePublication,
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

  const duplicated = decidePublication({ ...base, refs: [ref, ref] })
  assert.equal(duplicated.ok, false)
  assert.match(duplicated.ok ? '' : duplicated.reason, /same visual ref twice/u)

  const unknown = decidePublication({ ...base, refs: ['sv1_00000000000000000000'] })
  assert.equal(unknown.ok, false)
  assert.match(unknown.ok ? '' : unknown.reason, /unknown visual ref/u)

  const noCall = decidePublication({ ...base, callId: 'not-a-real-call', refs: [ref] })
  assert.equal(noCall.ok, false)
  assert.match(noCall.ok ? '' : noCall.reason, /no unique committed present_visual call/u)

  const empty = decidePublication({ ...base, refs: [] })
  assert.equal(empty.ok, false)
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

test('the human projection drops only the official tail machine blocks', () => {
  const blocks: ContentBlock[] = [
    { type: 'text', text: 'Request latency (ms)\np50  42 ms' },
    { type: 'text', text: visualReferenceLine('sv1_0123456789abcdef0123') },
    { type: 'text', text: 'visual-v1:{"type":"chart"}' },
  ]
  const chart = humanFacingVisualResult({
    toolName: 'dsh_pi_tui_chart', blocks, text: '', status: 'ok',
  })
  assert.equal(chart.text, 'Request latency (ms)\np50  42 ms')
  assert.deepEqual(chart.blocks, [{ type: 'text', text: 'Request latency (ms)\np50  42 ms' }])

  // A machine-looking line INSIDE the human body stays.
  const insideBody = humanFacingVisualResult({
    toolName: 'dsh_pi_tui_chart',
    blocks: [
      { type: 'text', text: 'title: visual-v1: CPU usage' },
      { type: 'text', text: visualReferenceLine('sv1_0123456789abcdef0123') },
      { type: 'text', text: 'visual-v1:{"type":"chart"}' },
    ],
    text: '',
    status: 'ok',
  })
  assert.equal(insideBody.text, 'title: visual-v1: CPU usage')
})

test('the human projection never touches another tool’s similar text', () => {
  const blocks: ContentBlock[] = [
    { type: 'text', text: 'output' },
    { type: 'text', text: 'visual-v1:{"type":"chart"}' },
  ]
  const bash = humanFacingVisualResult({ toolName: 'bash', blocks, text: '', status: 'ok' })
  assert.deepEqual(bash.blocks, blocks)
  assert.equal(bash.text, '')

  // A flat-text result of the visual tool loses its machine tail too.
  const flat = humanFacingVisualResult({
    toolName: 'present_visual',
    blocks: undefined,
    text: `Selected 2 visuals for presentation.\n${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 1, published: [] })}`,
    status: 'ok',
  })
  assert.equal(flat.text, 'Selected 2 visuals for presentation.')
})

test('the human projection keeps a failed visual result’s readable reason', () => {
  const human = humanFacingVisualResult({
    toolName: 'present_visual',
    blocks: [{ type: 'text', text: 'unknown visual ref sv1_0123456789abcdef0123' }],
    text: 'unknown visual ref sv1_0123456789abcdef0123',
    status: 'error',
  })
  assert.equal(human.text, 'unknown visual ref sv1_0123456789abcdef0123')
})
