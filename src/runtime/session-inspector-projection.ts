/**
 * The detached Session Inspector projection (Session Workspace PR2): one pure,
 * Host-import-free mapping from the official projection values of ONE exact
 * Session to the UI-neutral Inspector DTO.
 *
 * The mapper owns the numeric/derived semantics only (the fixed Inspector
 * contract): the official `sessionStats` whole-log counters with their wall
 * time averages, the four disjoint `tokenUsage` buckets, the approximate
 * `contextPressure` occupancy, and the identity/reading facts already defined
 * by {@link detachedSessionStatus}. It never recomputes a whole-log statistic
 * from a window, never reads an Agent, never falls back to another Session and
 * never coerces an unknown value into a fabricated zero.
 *
 * Full contract: docs/architecture/host-client.md.
 * @module @xmoon76/dsh-pi-tui/runtime/session-inspector-projection
 */

import { detachedSessionStatus } from './session-status-projection.ts'
import type { SessionStatusProjection, SessionStatusTodoItem } from './session-reader-port.ts'

/**
 * The fixed official projection keys one Session Inspector read requests. This
 * is the ONE key list both real adapters use; there is no second copy.
 * `sessionStats` is whole-log and summary-excluded, so it is only ever read
 * through this exact-key/observation path.
 */
export const INSPECTOR_PROJECTION_KEYS = [
  'sessionStats',
  'tokenUsage',
  'contextPressure',
  'modelSelection',
  'agentPreset',
  'title',
  'workingDirectory',
  'goal',
  'todos',
] as const

/** The whole-log activity counters of the official `sessionStats` fold. */
export interface SessionInspectorStats {
  readonly turns: number
  readonly steps: number
  readonly llmMs: number
  readonly toolMs: number
  /** `ttftMs / ttftSteps`; absent when no step recorded a first token. */
  readonly avgTtftMs?: number
  /** `decodeTokens * 1000 / decodeMs`; absent when no decode time is recorded. */
  readonly decodeTokensPerSec?: number
}

/** The four disjoint official `tokenUsage` buckets plus their derived totals. */
export interface SessionInspectorUsage {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** The sum of the four disjoint buckets. */
  readonly totalTokens: number
  /** `cacheRead / (uncachedInput + cacheRead + cacheWrite)`; absent at denominator 0. */
  readonly cacheHitPct?: number
}

/** The approximate context occupancy of the official `contextPressure` view. */
export interface SessionInspectorContext {
  readonly usedTokens?: number
  readonly windowTokens?: number
  readonly percent?: number
  /** The official pressure view is an approximation, never an exact atomic request sample. */
  readonly approximate: true
}

/** The official `todos` list reduced to its status counts (content is dropped). */
export interface SessionInspectorTodoSummary {
  readonly pending: number
  readonly inProgress: number
  readonly completed: number
}

/**
 * One detached, identity-bound Session Inspector payload.
 *
 * Every optional field is absent when its official source did not provide a
 * legal value at this cut; `undefined` is "unknown", never zero or "none".
 * `goal`/`todos` additionally preserve the official legal `null` ("no goal",
 * "no todo write yet") as a known empty answer.
 */
export interface SessionInspectorData {
  readonly sessionId: string
  /** The official exact projection cut seq (`-1` for an empty log). */
  readonly asOfSeq: number
  readonly stats?: SessionInspectorStats
  readonly usage?: SessionInspectorUsage
  readonly context?: SessionInspectorContext
  readonly model?: SessionStatusProjection['model']
  readonly preset?: string
  readonly title?: string
  /** The official `workingDirectory` projection; never the immutable header cwd. */
  readonly effectiveCwd?: string
  readonly goal?: SessionStatusProjection['goal']
  readonly todos?: SessionInspectorTodoSummary | null
}

/** One finite non-negative projection number, or `undefined` (never coerced). */
function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** One finite non-negative integer counter, or `undefined`. */
function countOf(value: unknown): number | undefined {
  const number = finiteNonNegative(value)
  return number !== undefined && Number.isInteger(number) ? number : undefined
}

/** A non-empty own object record (projection values are always JSON objects). */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Detach the official whole-log `sessionStats` unit. ALL eight fields must be
 * legal; a missing/malformed unit omits the whole group rather than presenting
 * a partial or fabricated statistic. Authoritative zero is preserved.
 */
function statsOf(value: unknown): SessionInspectorStats | undefined {
  if (!isRecord(value)) return undefined
  const turns = countOf(value.turns)
  const steps = countOf(value.steps)
  const llmMs = finiteNonNegative(value.llmMs)
  const toolMs = finiteNonNegative(value.toolMs)
  const ttftMs = finiteNonNegative(value.ttftMs)
  const ttftSteps = countOf(value.ttftSteps)
  const decodeMs = finiteNonNegative(value.decodeMs)
  const decodeTokens = countOf(value.decodeTokens)
  if (turns === undefined || steps === undefined || llmMs === undefined || toolMs === undefined
    || ttftMs === undefined || ttftSteps === undefined || decodeMs === undefined || decodeTokens === undefined) {
    return undefined
  }
  const avgTtftMs = ttftSteps > 0 ? ttftMs / ttftSteps : undefined
  const decodeTokensPerSec = decodeMs > 0 ? decodeTokens * 1000 / decodeMs : undefined
  return {
    turns,
    steps,
    llmMs,
    toolMs,
    ...(avgTtftMs !== undefined && Number.isFinite(avgTtftMs) ? { avgTtftMs } : {}),
    ...(decodeTokensPerSec !== undefined && Number.isFinite(decodeTokensPerSec) ? { decodeTokensPerSec } : {}),
  }
}

/**
 * Detach the official `tokenUsage` four-bucket projection. The buckets must all
 * be legal; the total/ratio derived values are omitted rather than emitted as
 * `Infinity`/`NaN`.
 */
function usageOf(value: unknown): SessionInspectorUsage | undefined {
  if (!isRecord(value)) return undefined
  const uncachedInputTokens = finiteNonNegative(value.uncachedInputTokens)
  const outputTokens = finiteNonNegative(value.outputTokens)
  const cacheReadTokens = finiteNonNegative(value.cacheReadTokens)
  const cacheWriteTokens = finiteNonNegative(value.cacheWriteTokens)
  if (uncachedInputTokens === undefined || outputTokens === undefined
    || cacheReadTokens === undefined || cacheWriteTokens === undefined) {
    return undefined
  }
  const totalTokens = uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  if (!Number.isFinite(totalTokens)) return undefined
  const cacheDenominator = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
  return {
    uncachedInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(cacheDenominator > 0 ? { cacheHitPct: 100 * cacheReadTokens / cacheDenominator } : {}),
  }
}

/**
 * Detach the approximate context occupancy: `projectedTokens ?? pressureTokens`
 * over the official window. A PRESENT but illegal preferred field leaves the
 * numerator unknown (never a fallback to the other field); a legal `0` stays 0.
 * Both fields are independent, so either may cross alone.
 */
function contextOf(value: unknown): SessionInspectorContext | undefined {
  if (!isRecord(value)) return undefined
  let usedTokens: number | undefined
  if (Object.prototype.hasOwnProperty.call(value, 'projectedTokens')) {
    usedTokens = finiteNonNegative(value.projectedTokens)
  } else if (Object.prototype.hasOwnProperty.call(value, 'pressureTokens')) {
    usedTokens = finiteNonNegative(value.pressureTokens)
  }
  const windowTokens = finiteNonNegative(value.contextWindow)
  const legalWindow = windowTokens !== undefined && windowTokens > 0 ? windowTokens : undefined
  if (usedTokens === undefined && legalWindow === undefined) return undefined
  const percent = usedTokens !== undefined && legalWindow !== undefined
    ? Math.min(100, Math.max(0, Math.round(100 * usedTokens / legalWindow)))
    : undefined
  return {
    ...(usedTokens === undefined ? {} : { usedTokens }),
    ...(legalWindow === undefined ? {} : { windowTokens: legalWindow }),
    ...(percent === undefined ? {} : { percent }),
    approximate: true,
  }
}

/** Reduce the official whole-list `todos` value to its status counts. */
function todosOf(todos: readonly SessionStatusTodoItem[] | null | undefined): SessionInspectorTodoSummary | null | undefined {
  if (todos === undefined || todos === null) return todos
  let pending = 0
  let inProgress = 0
  let completed = 0
  for (const todo of todos) {
    if (todo.status === 'pending') pending += 1
    else if (todo.status === 'in_progress') inProgress += 1
    else completed += 1
  }
  return { pending, inProgress, completed }
}

/**
 * Map one exact Session's official projection values to the detached Inspector
 * DTO. The caller guarantees `sessionId` is the authorized target and
 * `asOfSeq` is the official exact cut (a safe integer >= -1).
 */
export function detachSessionInspector(
  sessionId: string,
  asOfSeq: number,
  values: Readonly<Record<string, unknown>>,
): SessionInspectorData {
  // The reading/identity fields keep the ONE existing detached status mapping;
  // this mapper only selects them (the `piTuiPerformance`/usage/context/header
  // cwd projections are NOT inherited from that path).
  const status = detachedSessionStatus(sessionId, {
    modelSelection: values.modelSelection,
    agentPreset: values.agentPreset,
    title: values.title,
    goal: values.goal,
    todos: values.todos,
  }, undefined)
  const stats = statsOf(values.sessionStats)
  const usage = usageOf(values.tokenUsage)
  const context = contextOf(values.contextPressure)
  const todos = todosOf(status.todos)
  const effectiveCwd = typeof values.workingDirectory === 'string' && values.workingDirectory !== ''
    ? values.workingDirectory
    : undefined
  return {
    sessionId,
    asOfSeq,
    ...(stats === undefined ? {} : { stats }),
    ...(usage === undefined ? {} : { usage }),
    ...(context === undefined ? {} : { context }),
    ...(status.model === undefined ? {} : { model: status.model }),
    ...(status.preset === undefined ? {} : { preset: status.preset }),
    ...(status.title === undefined ? {} : { title: status.title }),
    ...(effectiveCwd === undefined ? {} : { effectiveCwd }),
    ...(status.goal === undefined ? {} : { goal: status.goal }),
    ...(todos === undefined ? {} : { todos }),
  }
}
