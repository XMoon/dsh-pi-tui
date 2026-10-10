/**
 * PR-1 evidence for the bundle's own Host performance projection
 * (`piTuiPerformance`): the pure fold's exact samples, the route-epoch reset,
 * the two independent rings, the checkpoint/restore replay, and the
 * registration lifetime on the REAL official projection seam.
 *
 * FIXTURE MANIFEST
 * - REAL: the installed `@deepseek-ai/dsh-session-projection` registry (the
 *   seam that drives `apply`, validates both schemas, and serves the
 *   checkpoint/restore/replay ladder), the real `assistantStream` expansion
 *   (`@deepseek-ai/dsh-llm`) behind the shared first-token predicate, and the
 *   bundle's real projection unit + Loader row module.
 * - SYNTHETIC: the committed events are hand-built envelopes carrying the
 *   exact durable payload fields the fold reads (`turn`/`step`/`time`,
 *   `assistant/message.message.source`, `usage`, the compact `stream`). No
 *   Agent loop runs here: PR-1 delivers the Host fold and its registration,
 *   not the Client wiring (PR-2) or the Footer formats (PR-3).
 * @module @xmoon76/dsh-pi-tui/performance-host-projection.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import SessionProjectionRegistry, { type ProjectionCheckpoint } from '@deepseek-ai/dsh-session-projection'
import { MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import * as performanceHost from '../src/app/host/performance-host.ts'
import {
  piTuiPerformanceDefinition,
  type PerformanceHostState,
} from '../src/app/host/performance-projection.ts'
import {
  derivePerformance,
  displayRate,
  emptyPerformanceView,
  PI_TUI_PERFORMANCE_KEY,
  rateFromTotals,
  type PiTuiPerformanceProjection,
} from '../src/domain/status/performance-view.ts'

const T0 = 1_700_000_000_000

/** One raw event before contiguous seq assignment. */
interface RawEvent {
  readonly type: string
  readonly data: Record<string, unknown>
  readonly time: number
}

/** Give a raw log contiguous seqs from 0 (the seam's restore contract). */
function seqEvents(raw: readonly RawEvent[]): SessionEvent[] {
  return raw.map((entry, index) => ({
    ...entry,
    seq: SessionSeq(index),
  }) as unknown as SessionEvent)
}

function stepStart(turn: number, step: number, time: number): RawEvent {
  return { type: 'step/start', data: { turn, step }, time }
}

function stepEnd(turn: number, step: number, time: number): RawEvent {
  return { type: 'step/end', data: { turn, step }, time }
}

function turnEnd(turn: number, time: number): RawEvent {
  return { type: 'turn/end', data: { turn, reason: { kind: 'completed' } }, time }
}

/** One visible text delta at an exact time (the compact durable stream form). */
function tokenAt(time: number, text = 'x'): Record<string, unknown> {
  return { type: 'chunk', time, chunk: { type: 'text-delta', index: 0, text } }
}

function usageAt(time: number, outputTokens: number): Record<string, unknown> {
  return { type: 'chunk', time, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens } } }
}

interface MessageSpec {
  readonly turn: number
  readonly step: number
  readonly time: number
  /** Declared model route; omitted = no trusted route identity. */
  readonly provider?: string
  readonly model?: string
  /** Top-level `usage.outputTokens`; omitted = no top-level usage. */
  readonly outputTokens?: number
  readonly stream?: readonly Record<string, unknown>[]
  readonly replacement?: boolean
}

function assistantMessage(spec: MessageSpec): RawEvent {
  const source = spec.provider === undefined
    ? { kind: 'local' }
    : { kind: 'model', provider: spec.provider, model: spec.model ?? 'm' }
  const raw: RawEvent & { surfaceOp?: unknown } = {
    type: 'assistant/message',
    time: spec.time,
    data: {
      turn: spec.turn,
      step: spec.step,
      message: {
        id: MessageId(`m-${spec.turn}-${spec.step}-${spec.time}`),
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source,
      },
      stream: spec.stream ?? [],
      ...(spec.outputTokens === undefined ? {} : { usage: { inputTokens: 1, outputTokens: spec.outputTokens } }),
    },
  }
  if (spec.replacement === true) raw.surfaceOp = { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) }
  return raw
}

function assistantAttempt(
  turn: number,
  step: number,
  time: number,
  stream: readonly Record<string, unknown>[],
): RawEvent {
  return { type: 'assistant/attempt', data: { turn, step, stream }, time }
}

/** The unreferenced-header stand-in: `init` never reads Session metadata. */
const HEADER = {} as unknown as SessionHeader

/** Fold one raw log through the REAL unit (no registry needed). */
function foldState(raw: readonly RawEvent[]): PerformanceHostState {
  let state = piTuiPerformanceDefinition.init(HEADER, SessionLogOffset(0))
  for (const event of seqEvents(raw)) state = piTuiPerformanceDefinition.apply(state, event)
  return state
}

/** The wire view of one raw log (through the unit's own `wire.view`). */
function foldView(raw: readonly RawEvent[]): PiTuiPerformanceProjection {
  return piTuiPerformanceDefinition.wire.view(foldState(raw))
}

/** A step whose model request ran `modelMs` and produced `outputTokens`. */
function completingStep(
  turn: number,
  step: number,
  startTime: number,
  modelMs: number,
  outputTokens: number,
  options: { readonly firstTokenMs?: number; readonly provider?: string } = {},
): RawEvent[] {
  const stream = options.firstTokenMs === undefined ? [] : [tokenAt(startTime + options.firstTokenMs)]
  return [
    stepStart(turn, step, startTime),
    assistantMessage({
      turn,
      step,
      time: startTime + modelMs,
      provider: options.provider ?? 'p',
      model: 'm',
      outputTokens,
      stream,
    }),
    stepEnd(turn, step, startTime + modelMs + 1),
  ]
}

// ── the pure fold: exact samples, eviction, independent rings ──────────────

test('four eligible steps produce the exact weighted R5 and All totals', () => {
  const raw = [
    ...completingStep(0, 0, T0, 1000, 1),
    ...completingStep(0, 1, T0 + 10_000, 1000, 2),
    ...completingStep(0, 2, T0 + 20_000, 1000, 3),
    ...completingStep(0, 3, T0 + 30_000, 1000, 4),
  ]
  const view = foldView(raw)
  assert.deepEqual(view.recent, { outputTokens: 10, modelMs: 4000, samples: 4, firstTokenMs: 0, firstTokenSamples: 0 })
  assert.deepEqual(view.all, { outputTokens: 10, modelMs: 4000, samples: 4 })
  assert.equal(derivePerformance(view).tokensPerSec, 2.5)
  assert.equal(derivePerformance(view).sessionTokensPerSec, 2.5)
  // No first-token evidence anywhere: TTFB is absent, never a zero average.
  assert.equal(derivePerformance(view).firstTokenMs, undefined)
})

test('the sixth eligible step evicts only the oldest R5 pair while All keeps every pair', () => {
  const raw = [1, 2, 3, 4, 5, 6].flatMap((outputTokens, index) =>
    completingStep(0, index, T0 + index * 10_000, 1000, outputTokens))
  const view = foldView(raw)
  // R5 = steps 2..6 (out 20, ms 5000); All = every step (out 21, ms 6000).
  assert.deepEqual(view.recent, { outputTokens: 20, modelMs: 5000, samples: 5, firstTokenMs: 0, firstTokenSamples: 0 })
  assert.deepEqual(view.all, { outputTokens: 21, modelMs: 6000, samples: 6 })
})

test('TTFB is its own ring: it samples without output tokens and stays out of TPS', () => {
  const raw = [
    ...completingStep(0, 0, T0, 1000, 100, { firstTokenMs: 100 }),
    ...completingStep(0, 1, T0 + 10_000, 2000, 200, { firstTokenMs: 300 }),
    // No top-level usage AND no stream usage: TPS cannot sample, TTFB still can.
    stepStart(0, 2, T0 + 20_000),
    assistantMessage({ turn: 0, step: 2, time: T0 + 30_000, provider: 'p', stream: [tokenAt(T0 + 22_000)] }),
    stepEnd(0, 2, T0 + 30_001),
  ]
  const view = foldView(raw)
  assert.deepEqual(view.recent, { outputTokens: 300, modelMs: 3000, samples: 2, firstTokenMs: 2400, firstTokenSamples: 3 })
  assert.deepEqual(view.all, { outputTokens: 300, modelMs: 3000, samples: 2 })
  const derived = derivePerformance(view)
  assert.equal(derived.tokensPerSec, 100)
  assert.equal(derived.sessionTokensPerSec, 100)
  assert.equal(derived.firstTokenMs, 800)
})

test('a single-delta burst, hidden reasoning, and a whole-step retry all sample TPS', () => {
  const burst = [
    stepStart(0, 0, T0),
    // ONE token delta at ONE timestamp, wall time 1000ms: the wall-time
    // denominator is the whole request, so the burst is observable.
    assistantMessage({ turn: 0, step: 0, time: T0 + 1000, provider: 'p', outputTokens: 50, stream: [tokenAt(T0 + 500)] }),
    stepEnd(0, 0, T0 + 1001),
  ]
  assert.equal(foldView(burst).recent.samples, 1)

  const hiddenReasoning = [
    stepStart(0, 0, T0),
    // Usage with NO visible token delta in the stream (invisible reasoning).
    assistantMessage({ turn: 0, step: 0, time: T0 + 2000, provider: 'p', outputTokens: 80, stream: [usageAt(T0 + 1900, 80)] }),
    stepEnd(0, 0, T0 + 2001),
  ]
  const hidden = foldView(hiddenReasoning)
  assert.deepEqual(hidden.recent, { outputTokens: 80, modelMs: 2000, samples: 1, firstTokenMs: 0, firstTokenSamples: 0 })

  const retried = [
    stepStart(0, 0, T0),
    // The failed attempt's stream supplies the step's first-token evidence…
    assistantAttempt(0, 0, T0 + 800, [tokenAt(T0 + 400), usageAt(T0 + 700, 9)]),
    { type: 'llm/retry', data: { turn: 0, step: 0, retry: 1, provider: 'p', mode: 'normal' }, time: T0 + 900 },
    { type: 'llm/retry-started', data: { turn: 0, step: 0, retry: 1 }, time: T0 + 1200 },
    // …and only the final message settles the step, with the WHOLE wall time
    // (including the retry wait).
    assistantMessage({ turn: 0, step: 0, time: T0 + 3000, provider: 'p', outputTokens: 40, stream: [tokenAt(T0 + 2500)] }),
    stepEnd(0, 0, T0 + 3001),
  ]
  const view = foldView(retried)
  assert.deepEqual(view.recent, { outputTokens: 40, modelMs: 3000, samples: 1, firstTokenMs: 400, firstTokenSamples: 1 })
  assert.deepEqual(view.all, { outputTokens: 40, modelMs: 3000, samples: 1 })
})

test('invalid or incomplete steps never pollute TPS, while valid TTFB still joins', () => {
  const raw = [
    // No usage record at all (neither top-level nor in the stream).
    stepStart(0, 0, T0),
    assistantMessage({ turn: 0, step: 0, time: T0 + 1000, provider: 'p' }),
    stepEnd(0, 0, T0 + 1001),
    // Top-level usage present but zero output tokens.
    ...completingStep(0, 1, T0 + 10_000, 1000, 0),
    // Non-positive wall time (message at step/start).
    stepStart(0, 2, T0 + 20_000),
    assistantMessage({ turn: 0, step: 2, time: T0 + 20_000, provider: 'p', outputTokens: 10, stream: [tokenAt(T0 + 20_000)] }),
    stepEnd(0, 2, T0 + 20_001),
    // A failed attempt alone (never settled by a message) adds nothing.
    stepStart(0, 3, T0 + 30_000),
    assistantAttempt(0, 3, T0 + 30_500, [tokenAt(T0 + 30_100), usageAt(T0 + 30_400, 77)]),
    stepEnd(0, 3, T0 + 30_600),
    // An interrupted step (turn/end with no message) adds nothing.
    stepStart(0, 4, T0 + 40_000),
    turnEnd(0, T0 + 40_500),
  ]
  const view = foldView(raw)
  assert.deepEqual(view.recent, { outputTokens: 0, modelMs: 0, samples: 0, firstTokenMs: 0, firstTokenSamples: 1 })
  assert.deepEqual(view.all, { outputTokens: 0, modelMs: 0, samples: 0 })
  const derived = derivePerformance(view)
  assert.equal(derived.tokensPerSec, undefined)
  assert.equal(derived.sessionTokensPerSec, undefined)
  // The zero-duration step still owns valid first-token evidence (0 ms).
  assert.equal(derived.firstTokenMs, 0)
})

test('a route change (A to B to A) clears both near rings before the new sample joins', () => {
  const raw = [
    ...completingStep(0, 0, T0, 1000, 100, { firstTokenMs: 100, provider: 'a' }),
    ...completingStep(0, 1, T0 + 10_000, 2000, 200, { firstTokenMs: 200, provider: 'b' }),
    ...completingStep(0, 2, T0 + 20_000, 3000, 300, { firstTokenMs: 300, provider: 'a' }),
  ]
  const state = foldState(raw)
  assert.deepEqual(state.view.recent, { outputTokens: 300, modelMs: 3000, samples: 1, firstTokenMs: 300, firstTokenSamples: 1 })
  // All accumulates across every route generation.
  assert.deepEqual(state.view.all, { outputTokens: 600, modelMs: 6000, samples: 3 })
  assert.equal(state.routeKey, JSON.stringify(['a', 'm']))
})

test('a message without a trusted route enters All only', () => {
  const raw = [
    ...completingStep(0, 0, T0, 1000, 100, { firstTokenMs: 100, provider: 'a' }),
    // No model source: All takes the pair, the route-scoped rings do not.
    stepStart(0, 1, T0 + 10_000),
    assistantMessage({ turn: 0, step: 1, time: T0 + 11_000, outputTokens: 200, stream: [tokenAt(T0 + 10_200)] }),
    stepEnd(0, 1, T0 + 11_001),
  ]
  const state = foldState(raw)
  assert.deepEqual(state.view.recent, { outputTokens: 100, modelMs: 1000, samples: 1, firstTokenMs: 100, firstTokenSamples: 1 })
  assert.deepEqual(state.view.all, { outputTokens: 300, modelMs: 2000, samples: 2 })
  assert.equal(state.routeKey, JSON.stringify(['a', 'm']))
})

test('a duplicate or superseded settlement never accounts twice', () => {
  const settled = [
    ...completingStep(0, 0, T0, 1000, 100),
    // Late duplicate of the SAME step: the unit already closed it.
    assistantMessage({ turn: 0, step: 0, time: T0 + 5000, provider: 'p', outputTokens: 999 }),
    // A new step supersedes nothing (the previous one already settled).
    ...completingStep(0, 1, T0 + 10_000, 1000, 50),
  ]
  const state = foldState(settled)
  assert.deepEqual(state.view.all, { outputTokens: 150, modelMs: 2000, samples: 2 })

  // A new step/start while the previous step is still open drops it.
  const superseded = [
    stepStart(0, 0, T0),
    stepStart(0, 1, T0 + 100),
    assistantMessage({ turn: 0, step: 1, time: T0 + 1100, provider: 'p', outputTokens: 70 }),
    stepEnd(0, 1, T0 + 1101),
  ]
  const supersededState = foldState(superseded)
  assert.deepEqual(supersededState.view.all, { outputTokens: 70, modelMs: 1000, samples: 1 })
  // A message for a step that is not the open one is ignored entirely.
  const mismatched = foldState([
    stepStart(0, 1, T0 + 100),
    assistantMessage({ turn: 0, step: 0, time: T0 + 500, provider: 'p', outputTokens: 500 }),
  ])
  assert.equal(mismatched.view.all.samples, 0)
  assert.notEqual(mismatched.openStep, null)
})

test('a replacement-surface message is never performance evidence', () => {
  const state = foldState([
    stepStart(0, 0, T0),
    assistantMessage({
      turn: 0,
      step: 0,
      time: T0 + 1000,
      provider: 'p',
      outputTokens: 500,
      stream: [tokenAt(T0 + 100)],
      replacement: true,
    }),
  ])
  assert.deepEqual(state.view.all, { outputTokens: 0, modelMs: 0, samples: 0 })
  assert.deepEqual(state.view.recent, { outputTokens: 0, modelMs: 0, samples: 0, firstTokenMs: 0, firstTokenSamples: 0 })
  // The step stays OPEN: the rewrite settled no live step.
  assert.notEqual(state.openStep, null)
})

// ── the display derivation ────────────────────────────────────────────────

test('rateFromTotals refuses an unpaired total and displayRate applies the one precision policy', () => {
  assert.equal(rateFromTotals(100, 1000), 100)
  assert.equal(rateFromTotals(0, 1000), undefined)
  assert.equal(rateFromTotals(-5, 1000), undefined)
  assert.equal(rateFromTotals(Number.NaN, 1000), undefined)
  assert.equal(rateFromTotals(Number.POSITIVE_INFINITY, 1000), undefined)
  assert.equal(rateFromTotals(100, 0), undefined)
  assert.equal(rateFromTotals(100, Number.POSITIVE_INFINITY), undefined)

  assert.equal(displayRate(42), 42)
  assert.equal(displayRate(87.5), 87.5)
  assert.equal(displayRate(99.96), 100)
  assert.equal(displayRate(100.4), 100)
  assert.equal(displayRate(123.456), 123)
})

test('derivePerformance reports absent facts, never a zero stand-in', () => {
  assert.deepEqual(derivePerformance(undefined), {})
  assert.deepEqual(derivePerformance(emptyPerformanceView()), {})
  const projection: PiTuiPerformanceProjection = {
    // R5 answers, All cannot: the two scopes are independent.
    recent: { outputTokens: 7, modelMs: 80, samples: 1, firstTokenMs: 300, firstTokenSamples: 2 },
    all: { outputTokens: 0, modelMs: 0, samples: 0 },
  }
  assert.deepEqual(derivePerformance(projection), { firstTokenMs: 150, tokensPerSec: 87.5 })

  // A ZERO-SAMPLE scope is unknown even when stray paired counters are present
  // (plan §3.2): the sample count is part of scope eligibility, so the recent
  // scope answers nothing while All still answers.
  assert.deepEqual(derivePerformance({
    recent: { outputTokens: 100, modelMs: 1000, samples: 0, firstTokenMs: 0, firstTokenSamples: 0 },
    all: { outputTokens: 200, modelMs: 1000, samples: 2 },
  }), { sessionTokensPerSec: 200 })
  // …and the mirror: a sampled recent scope with a zero-sample All scope.
  assert.deepEqual(derivePerformance({
    recent: { outputTokens: 50, modelMs: 1000, samples: 1, firstTokenMs: 0, firstTokenSamples: 0 },
    all: { outputTokens: 500, modelMs: 1000, samples: 0 },
  }), { tokensPerSec: 50 })
})

// ── the official seam: registration, checkpoint and replay ────────────────

interface Seam {
  readonly ctx: Context
  readonly registry: SessionProjectionRegistry
  readonly fiber: Fiber
}

async function mountSeam(t: { after(fn: () => Promise<void> | void): void }): Promise<Seam> {
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = ctx.plugin(performanceHost)
  await fiber
  return { ctx, registry: ctx.get('sessionProjections') as SessionProjectionRegistry, fiber }
}

test('the unit registers on the real seam and unregisters with its fiber', async (t) => {
  const seam = await mountSeam(t)
  assert.equal(performanceHost.name, 'pi-tui-performance-host')
  const view = foldView([...completingStep(0, 0, T0, 1000, 100)])
  const checkpoint = { [PI_TUI_PERFORMANCE_KEY]: { ver: 1, seq: SessionSeq(2), val: foldState([...completingStep(0, 0, T0, 1000, 100)]) } }

  assert.deepEqual(seam.registry.viewCheckpoint(checkpoint, [PI_TUI_PERFORMANCE_KEY]), {
    [PI_TUI_PERFORMANCE_KEY]: view,
  })
  assert.deepEqual(seam.ctx.get(performanceHost.PI_TUI_PERFORMANCE_READY_SERVICE), {})

  await seam.fiber.dispose()
  assert.deepEqual(seam.registry.viewCheckpoint(checkpoint, [PI_TUI_PERFORMANCE_KEY]), {})
  assert.equal(seam.ctx.get(performanceHost.PI_TUI_PERFORMANCE_READY_SERVICE), undefined)
})

test('checkpoint plus tail replay equals the full recompute, and a version mismatch refolds', async (t) => {
  const seam = await mountSeam(t)
  const raw = [
    ...completingStep(0, 0, T0, 1000, 100, { firstTokenMs: 100 }),
    ...completingStep(0, 1, T0 + 10_000, 2000, 250, { firstTokenMs: 400 }),
    ...completingStep(0, 2, T0 + 20_000, 500, 25, { firstTokenMs: 50 }),
  ]
  const events = seqEvents(raw)
  const splitIndex = 4

  const full = seam.registry.restore({}, events, SessionLogOffset(0), HEADER, SessionLogOffset(0))
  assert.deepEqual(full.snapshot.values[PI_TUI_PERFORMANCE_KEY], foldView(raw))
  assert.equal(full.snapshot.asOfSeq, events.length - 1)

  // Cache replay from a real PREFIX cut: `splitIndex` stops inside step 1
  // (right after its `step/start`), so the persisted state carries an OPEN
  // step and the tail must still settle it. A checkpoint taken at the log END
  // would make the official `restore` start its replay at `row.seq + 1`, i.e.
  // past the supplied events, and the equality below would hold vacuously.
  const cached = JSON.parse(JSON.stringify(
    seam.registry.restore({}, events.slice(0, splitIndex), SessionLogOffset(0), HEADER, SessionLogOffset(0)).checkpoint,
  )) as ProjectionCheckpoint
  const cachedState = (cached[PI_TUI_PERFORMANCE_KEY] as { val: { openStep: unknown } }).val
  assert.notEqual(cachedState.openStep, null, 'the cached cut must stop inside an OPEN step')
  const cachedView = seam.registry.viewCheckpoint(cached, [PI_TUI_PERFORMANCE_KEY])[PI_TUI_PERFORMANCE_KEY] as PiTuiPerformanceProjection
  assert.equal(cachedView.recent.samples, 1, 'the prefix cut holds only step 0')
  assert.notEqual(cachedView.recent.samples, foldView(raw).recent.samples,
    'the tail must add evidence the prefix cut cannot already hold')

  // Decisive replay witness: the registered unit is the SAME definition object,
  // so a forwarding wrapper observes every `apply` the official `restore`
  // performs. Equality alone cannot prove a replay happened (a checkpoint taken
  // at the log end already holds the final state); this count can.
  const originalApply = piTuiPerformanceDefinition.apply
  let tailApplies = 0
  piTuiPerformanceDefinition.apply = (state, event) => {
    tailApplies += 1
    return originalApply(state, event)
  }
  const tail = seam.registry.restore(cached, events.slice(splitIndex), SessionLogOffset(splitIndex), HEADER, SessionLogOffset(0))
  piTuiPerformanceDefinition.apply = originalApply
  t.after(() => { piTuiPerformanceDefinition.apply = originalApply })
  assert.equal(tailApplies, events.length - splitIndex,
    'every tail event must be replayed through the unit from the prefix checkpoint')

  assert.deepEqual(tail.snapshot, full.snapshot)
  const replayed = tail.snapshot.values[PI_TUI_PERFORMANCE_KEY] as PiTuiPerformanceProjection
  assert.equal(replayed.recent.samples, 3, 'the replay settled the open step and the remaining one')
  assert.equal(replayed.recent.firstTokenSamples, 3)

  // A row from another fold version is discarded; with baseSeq 0 the unit
  // refolds the whole log, never forward-applies stale state.
  const stale = seam.registry.restore({
    [PI_TUI_PERFORMANCE_KEY]: { ver: 99, seq: SessionSeq(events.length - 1), val: full.checkpoint[PI_TUI_PERFORMANCE_KEY].val },
  }, events, SessionLogOffset(0), HEADER, SessionLogOffset(0))
  assert.deepEqual(stale.snapshot, full.snapshot)

  // A version-mismatched row with a non-zero base cannot be soundly restored.
  assert.throws(() => seam.registry.restore({
    [PI_TUI_PERFORMANCE_KEY]: { ver: 99, seq: SessionSeq(events.length - 1), val: full.checkpoint[PI_TUI_PERFORMANCE_KEY].val },
  }, events.slice(splitIndex), SessionLogOffset(splitIndex), HEADER, SessionLogOffset(0)), /cannot restore from seq/)
})

// ── the shipped composition rows ──────────────────────────────────────────

test('the shipped Direct row registers the Host exactly once and the runner waits for its gate', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /- id: pi-tui-performance-host\r?\n\s+name: '@xmoon76\/dsh-pi-tui\/performance-host'\r?\n\s+inject: \[tuiStartup, sessionProjections\]/)
  // One Host Context registers the key once: no second Direct row.
  assert.equal((patch.match(/- id: pi-tui-performance-host\b/g) ?? []).length, 1)
  // The runner must not mount without its performance authority.
  assert.match(patch, /inject: \[tuiStartup, piTuiExtensions, authorization, workspaceRegistry, pluginManager, jobController, piTuiPerformanceReady\]/)
})

// ── the real Host plane: committed events drive the real seam ─────────────

/** Append one REAL completed durable turn through the official Session API
 *  (invariants enforced, `session/event` published, the registry driving). */
async function appendRealTurn(session: Session, turn: number, outputTokens: number): Promise<void> {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 0 })
  // A real model request takes real wall time; wait so the paired wall time is
  // positive (a zero-duration step is legitimately not a TPS sample).
  await new Promise(resolve => setTimeout(resolve, 5))
  session.append('assistant/message', {
    turn,
    step: 0,
    message: {
      id: MessageId(`real-${turn}`),
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [{ type: 'chunk', time: Date.now() - 1, chunk: { type: 'text-delta', index: 0, text: 'x' } }],
    usage: { inputTokens: 3, outputTokens },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 0 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

test('real committed Session events drive the unit through the official snapshot and change feed', async (t) => {
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(performanceHost)
  const registry = ctx.get('sessionProjections') as SessionProjectionRegistry
  const session = ctx.sessions.create(SessionId('perf-real-session'))

  const changes: Array<{ readonly value: unknown; readonly seq: number }> = []
  const off = registry.onChanged((_session, key, value, seq) => {
    if (key === PI_TUI_PERFORMANCE_KEY) changes.push({ value, seq })
  })
  t.after(() => off())

  // The empty log already carries the authoritative zero view (not undefined).
  assert.deepEqual(registry.snapshot(session, [PI_TUI_PERFORMANCE_KEY]).values[PI_TUI_PERFORMANCE_KEY], emptyPerformanceView())

  await appendRealTurn(session, 0, 120)
  await appendRealTurn(session, 1, 30)

  const view = registry.snapshot(session, [PI_TUI_PERFORMANCE_KEY]).values[PI_TUI_PERFORMANCE_KEY] as PiTuiPerformanceProjection
  assert.equal(view.all.samples, 2)
  assert.equal(view.all.outputTokens, 150)
  assert.ok(view.all.modelMs > 0, 'the real committed wall time is positive')
  assert.equal(view.recent.samples, 2)
  assert.equal(view.recent.outputTokens, 150)
  assert.equal(view.recent.modelMs, view.all.modelMs)
  assert.equal(view.recent.firstTokenSamples, 2)

  // The change feed published every real advance (the subscriber path).
  assert.ok(changes.length >= 2, `the change feed must publish each completion: ${changes.length}`)
  assert.equal((changes.at(-1)?.value as PiTuiPerformanceProjection).all.outputTokens, 150)
})

test('the readiness gate is published only after the unit registers', async (t) => {
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  // A refusing registry: the row must fail BEFORE publishing readiness, so a
  // composition that cannot register the projection never reports itself ready.
  ctx.provide('sessionProjections', {
    register: () => { throw new Error('registration refused') },
  })
  const fiber = ctx.plugin(performanceHost)
  try {
    await fiber
  } catch {
    // the refusing registry is exactly the scenario under test
  }
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(ctx.get(performanceHost.PI_TUI_PERFORMANCE_READY_SERVICE), undefined,
    'a failed registration must not publish the readiness gate')
})
