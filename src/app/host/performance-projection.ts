/**
 * The `piTuiPerformance` Host fold: the ONE statistics state machine for the
 * recent (R5) and Session-lifetime ("All") model-request output rate and for
 * the recent time-to-first-token.
 *
 * The unit is a pure synchronous fold over committed Session events (plan §3.3
 * / §3.4). The official session-projection seam owns the subscription, the
 * per-session cell, the checkpoint cache and the change feed; this module owns
 * only the computation and its plain-JSON state:
 *
 * ```text
 * step/start        open the logical step (turn, step, startTime)
 * assistant/attempt fill the step's missing first-token evidence only
 * assistant/message close it ONCE: route epoch, All pair, R5 pair, TTFB sample
 * step/end, turn/end close a step that produced no message (no accounting)
 * ```
 *
 * Every other event returns the SAME state object (zero downstream work), and
 * an internal-only transition that changes nothing observable reuses the
 * previous view object, so the seam publishes no frame for it (plan §3.3).
 *
 * Usage parsing and the observable-first-token predicate are the SHARED
 * transcript facts (`domain/transcript/usage.ts`), never a second parser; the
 * route identity is the message's `(provider, model)` pair, encoded
 * unambiguously.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/performance-projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// The merge target of the two projection tables (module augmentation below).
// The package root re-exports the same tables, so either specifier lands on
// the one shared declaration.
import type {} from '@deepseek-ai/dsh-session-projection/types'
import {
  firstTokenTimeFromAssistantStream,
  usageFromAssistantSettlement,
  type UsageLike,
} from '../../domain/transcript/usage.ts'
import {
  emptyPerformanceView,
  PI_TUI_PERFORMANCE_KEY,
  RECENT_PERFORMANCE_SAMPLE_LIMIT,
  type PerformanceCounter,
  type PerformanceRecentCounter,
  type PiTuiPerformanceProjection,
} from '../../domain/status/performance-view.ts'

/** One eligible step's paired TPS sample. */
export interface PerformanceSamplePair {
  readonly outputTokens: number
  readonly modelMs: number
}

/** The one open logical step (plan §3.3). */
export interface PerformanceOpenStep {
  readonly turn: number
  readonly step: number
  readonly startTime: number
  /** Earliest observable token time of this step's attempts, or `null`. */
  readonly firstTokenTime: number | null
}

/**
 * The unit's whole plain-JSON state. `recentSamples` and `firstTokenSamples`
 * are the two bounded rings (each at most
 * {@link RECENT_PERFORMANCE_SAMPLE_LIMIT}); `all` accumulates monotonically and
 * keeps no history. The view holds the published counters and is reused by
 * reference until a completed step changes something observable.
 */
export interface PerformanceHostState {
  readonly view: PiTuiPerformanceProjection
  readonly openStep: PerformanceOpenStep | null
  /** JSON-encoded `[provider, model]` of the last trusted route, or `null`. */
  readonly routeKey: string | null
  readonly recentSamples: readonly PerformanceSamplePair[]
  readonly firstTokenSamples: readonly number[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    piTuiPerformance: PiTuiPerformanceProjection
  }
  interface SessionProjectionStateMap {
    piTuiPerformance: PerformanceHostState
  }
}

const counterSchema = z.strictObject({
  outputTokens: z.number().nonnegative(),
  modelMs: z.number().nonnegative(),
  samples: z.number().int().nonnegative(),
})

const recentCounterSchema = z.strictObject({
  outputTokens: z.number().nonnegative(),
  modelMs: z.number().nonnegative(),
  samples: z.number().int().nonnegative(),
  firstTokenMs: z.number().nonnegative(),
  firstTokenSamples: z.number().int().nonnegative(),
})

const viewSchema = z.strictObject({
  recent: recentCounterSchema,
  all: counterSchema,
})

const stateSchema = z.strictObject({
  view: viewSchema,
  openStep: z.strictObject({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    startTime: z.number().nonnegative(),
    firstTokenTime: z.number().nonnegative().nullable(),
  }).nullable(),
  routeKey: z.string().nullable(),
  recentSamples: z.array(z.strictObject({
    outputTokens: z.number().nonnegative(),
    modelMs: z.number().nonnegative(),
  })).max(RECENT_PERFORMANCE_SAMPLE_LIMIT),
  firstTokenSamples: z.array(z.number().nonnegative()).max(RECENT_PERFORMANCE_SAMPLE_LIMIT),
})

/** The empty fold state. */
function emptyPerformanceState(): PerformanceHostState {
  return {
    view: emptyPerformanceView(),
    openStep: null,
    routeKey: null,
    recentSamples: [],
    firstTokenSamples: [],
  }
}

/** Whether a replacement-surface rewrite (compaction) carries no new evidence. */
function isReplacementSurface(event: { surfaceOp?: unknown }): boolean {
  const op = event.surfaceOp
  return typeof op === 'object' && op !== null && (op as { op?: unknown }).op === 'replace'
}

/**
 * The step's `(provider, model)` route identity. Only a message whose source is
 * a model route yields a key — a missing identity never resets the window
 * (fail-soft), it only keeps that step out of the route-scoped rings.
 */
function performanceRouteKeyOf(message: { source?: unknown }): string | undefined {
  const source = (message as { source?: { kind?: unknown; provider?: unknown; model?: unknown } }).source
  if (source?.kind !== 'model') return undefined
  if (typeof source.provider !== 'string' || typeof source.model !== 'string') return undefined
  return JSON.stringify([source.provider, source.model])
}

/**
 * One eligible TPS pair: a finite positive output count AND a finite positive
 * model wall time. Provider-boundary validation: an invalid, absent,
 * NaN/Infinity or negative value never enters the All counter or an R5 ring.
 */
function eligibleSample(outputTokens: number | undefined, modelMs: number): PerformanceSamplePair | undefined {
  if (outputTokens === undefined || !Number.isFinite(outputTokens) || outputTokens <= 0) return undefined
  if (!Number.isFinite(modelMs) || modelMs <= 0) return undefined
  return { outputTokens, modelMs }
}

/** Append to a bounded ring, dropping the oldest entries past the limit. */
function appendRing<T>(ring: readonly T[], value: T): T[] {
  const next = [...ring, value]
  return next.length > RECENT_PERFORMANCE_SAMPLE_LIMIT
    ? next.slice(next.length - RECENT_PERFORMANCE_SAMPLE_LIMIT)
    : next
}

/** Whether two published views are numerically identical. */
function sameView(left: PiTuiPerformanceProjection, right: PiTuiPerformanceProjection): boolean {
  return left.recent.outputTokens === right.recent.outputTokens
    && left.recent.modelMs === right.recent.modelMs
    && left.recent.samples === right.recent.samples
    && left.recent.firstTokenMs === right.recent.firstTokenMs
    && left.recent.firstTokenSamples === right.recent.firstTokenSamples
    && left.all.outputTokens === right.all.outputTokens
    && left.all.modelMs === right.all.modelMs
    && left.all.samples === right.all.samples
}

/**
 * Close ONE step at its `assistant/message` boundary and produce the next
 * state (plan §3.4 rules 4-7, 9, 10):
 *
 * 1. a validly declared route different from the current one clears both
 *    route-scoped rings BEFORE this step's samples join (A→B→A included);
 * 2. an eligible pair (`outputTokens > 0`, `modelMs > 0`) joins the All counter
 *    always and the R5 ring only for a route-identified step;
 * 3. a completed step with first-token evidence inside
 *    `[step/start, assistant/message]` joins the TTFB ring for a
 *    route-identified step, independent of `outputTokens`;
 * 4. the view object is recreated only when one of its numbers changed.
 */
function settleCompletedStep(
  state: PerformanceHostState,
  open: PerformanceOpenStep,
  eventTime: number,
  topLevelUsage: UsageLike | undefined,
  stream: readonly unknown[] | undefined,
  message: { source?: unknown },
): PerformanceHostState {
  const modelMs = eventTime - open.startTime
  const declaredRouteKey = performanceRouteKeyOf(message)

  let routeKey = state.routeKey
  let recentSamples = state.recentSamples
  let firstTokenSamples = state.firstTokenSamples
  if (declaredRouteKey !== undefined) {
    if (routeKey !== null && routeKey !== declaredRouteKey) {
      recentSamples = []
      firstTokenSamples = []
    }
    routeKey = declaredRouteKey
  }

  const usage = usageFromAssistantSettlement('message', topLevelUsage, stream)
  const sample = eligibleSample(usage?.outputTokens, modelMs)
  if (sample !== undefined && declaredRouteKey !== undefined) {
    recentSamples = appendRing(recentSamples, sample)
  }

  const firstTokenTime = open.firstTokenTime ?? firstTokenTimeFromAssistantStream(stream) ?? null
  if (declaredRouteKey !== undefined && firstTokenTime !== null) {
    const firstTokenMs = firstTokenTime - open.startTime
    if (Number.isFinite(firstTokenMs) && firstTokenMs >= 0 && firstTokenMs <= modelMs) {
      firstTokenSamples = appendRing(firstTokenSamples, firstTokenMs)
    }
  }

  const previousAll = state.view.all
  const all: PerformanceCounter = sample === undefined
    ? previousAll
    : {
        outputTokens: previousAll.outputTokens + sample.outputTokens,
        modelMs: previousAll.modelMs + sample.modelMs,
        samples: previousAll.samples + 1,
      }
  // The rings' totals are RECOMPUTED from their contents, so a pair evicted
  // from the ring head never keeps feeding the recent rate (plan §3.4.6).
  const recent: PerformanceRecentCounter = {
    outputTokens: recentSamples.reduce((sum, pair) => sum + pair.outputTokens, 0),
    modelMs: recentSamples.reduce((sum, pair) => sum + pair.modelMs, 0),
    samples: recentSamples.length,
    firstTokenMs: firstTokenSamples.reduce((sum, value) => sum + value, 0),
    firstTokenSamples: firstTokenSamples.length,
  }
  const nextView: PiTuiPerformanceProjection = { recent, all }
  return {
    view: sameView(state.view, nextView) ? state.view : nextView,
    openStep: null,
    routeKey,
    recentSamples,
    firstTokenSamples,
  }
}

/**
 * The registration form of the unit: `piTuiPerformance` is client-visible, so
 * the wire view is REQUIRED (`ProjectionDefinition.wire` is optional because
 * host-only units omit it).
 */
export type PiTuiPerformanceDefinition =
  Omit<ProjectionDefinition<typeof PI_TUI_PERFORMANCE_KEY>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<typeof PI_TUI_PERFORMANCE_KEY>['wire']> }

/**
 * The `piTuiPerformance` projection unit. `stateVersion` gates the persisted
 * cache: a row from another fold version is discarded and refolded, never
 * forward-applied into garbage.
 */
export const piTuiPerformanceDefinition: PiTuiPerformanceDefinition = {
  key: PI_TUI_PERFORMANCE_KEY,
  stateVersion: 1,
  stateSchema,
  init: () => emptyPerformanceState(),
  apply: (state, event) => {
    // A compaction rewrite replays model-visible history; it is not new
    // performance evidence (plan §3.4.8).
    if (isReplacementSurface(event)) return state
    switch (event.type) {
      case 'step/start': {
        // A new step supersedes a step that never settled; neither adds.
        return {
          ...state,
          openStep: {
            turn: event.data.turn,
            step: event.data.step,
            startTime: event.time,
            firstTokenTime: null,
          },
        }
      }
      case 'assistant/attempt': {
        const open = state.openStep
        if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state
        if (open.firstTokenTime !== null) return state
        const firstTokenTime = firstTokenTimeFromAssistantStream(event.data.stream)
        if (firstTokenTime === undefined || !Number.isFinite(firstTokenTime)) return state
        return { ...state, openStep: { ...open, firstTokenTime } }
      }
      case 'assistant/message': {
        const open = state.openStep
        if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state
        return settleCompletedStep(state, open, event.time, event.data.usage, event.data.stream, event.data.message)
      }
      case 'step/end':
      case 'turn/end': {
        // An interrupted step closes WITHOUT accounting (only a completed
        // assistant/message is evidence).
        return state.openStep === null ? state : { ...state, openStep: null }
      }
      default: {
        // `llm/retry`, `llm/retry-started`, tool events, surface previews and
        // the rest never open, close, or sample a step.
        return state
      }
    }
  },
  wire: {
    viewSchema,
    view: state => state.view,
  },
}
