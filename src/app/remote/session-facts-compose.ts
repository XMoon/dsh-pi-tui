/**
 * The Remote branch's session-facts composition (M3-4 PR4 §3.3/§3.6/§12.4):
 * whole-log truth from the OFFICIAL projections, recent-window truth from
 * the exact retained binding's bounded event window, paged only as far as
 * the recent-sample contract requires.
 *
 * Ownership rules (frozen):
 * - lifetime turns/steps/llmMs come from the `sessionStats` projection —
 *   NEVER computed from the bounded window;
 * - token totals come from the `tokenUsage` projection; the context window
 *   from the context projection; cache-hit percentage derives from those
 *   totals with the same formula as the fold;
 * - recent TTFT/TPS derive from the binding's durable+transient window via
 *   the shared `recentPerformanceOf` helper (the same
 *   RECENT_PERFORMANCE_SAMPLE_LIMIT window and formula the Direct fold
 *   uses), paging `loadOlder()` only while the window may still be missing
 *   the latest completed steps;
 * - lastAssistantText scans the window newest-first and pages `loadOlder()`
 *   until the newest durable assistant/message is inside the window (or the
 *   history start is reached): `undefined` = no assistant message yet, `''`
 *   = the message carries no text;
 * - every await re-checks the SAME Connection generation and the caller's
 *   scope currency; a superseded operation settles as stale/undefined and
 *   NEVER retargets to a replacement binding.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/session-facts-compose
 */

import type { PresentationDurableEvent, PresentationReadSnapshot } from '../../runtime/presentation-read-port.ts'
import type { SessionStatusProjection } from '../../runtime/session-reader-port.ts'
import type { SessionStats } from '../../stats.ts'
import { recentPerformanceOf, RECENT_PERFORMANCE_SAMPLE_LIMIT } from '../../stats.ts'

/** The whole-log projection facts the composition consumes (detached). */
export interface RemoteStatsProjectionFacts {
  /** The official whole-log `sessionStats` projection value (unknown-shaped
   *  until narrowed; a foreign shape reads unmeasured). */
  readonly sessionStats: unknown
  /** The official `tokenUsage` projection of the SessionStatus facts. */
  readonly usage: SessionStatusProjection['usage']
  /** The official context-window capacity of the status facts. */
  readonly contextWindow: number | undefined
}

/** The reader face the composition pages through (the shared adapter). */
export interface RemoteFactsReader {
  read(sessionId: string, signal?: AbortSignal): Promise<PresentationReadSnapshot | undefined>
  loadOlder(sessionId: string, signal?: AbortSignal): Promise<PresentationReadSnapshot | undefined>
}

/** The currentness fence the composition re-checks after every await. */
export interface RemoteFactsFence {
  /** Whether the captured Connection generation and binding are still the
   *  live identity for this session. */
  isCurrent(): boolean
}

/** Narrow the official sessionStats projection to its numeric fields. */
function numericTotalsOf(value: unknown): Partial<Record<'turns' | 'steps' | 'llmMs', number>> {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Readonly<Record<string, unknown>>
  const out: Partial<Record<'turns' | 'steps' | 'llmMs', number>> = {}
  for (const key of ['turns', 'steps', 'llmMs'] as const) {
    const entry = record[key]
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry
  }
  return out
}

/** The newest durable assistant/message text of a window, newest-first. */
function lastAssistantTextOfWindow(events: readonly PresentationDurableEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type !== 'assistant/message') continue
    const data = event.data as { readonly message?: { readonly content?: readonly unknown[] } }
    const blocks = data.message?.content ?? []
    const text = blocks
      .filter((block): block is { readonly type: 'text'; readonly text: string } =>
        typeof block === 'object' && block !== null && (block as { readonly type?: unknown }).type === 'text')
      .map(block => block.text)
      .join('')
    return text
  }
  return undefined
}

/** Whether the recent-sample window may still be missing the latest steps.
 *  The candidate buffer is twice the derived window, so paging continues
 *  while the window proves fewer completed steps than the worst case the
 *  recent contract may still need (the derived metric pools only the
 *  latest `RECENT_PERFORMANCE_SAMPLE_LIMIT` VALID samples). */
function recentSamplesIncomplete(events: readonly PresentationDurableEvent[]): boolean {
  // Count the completed steps the window itself proves (step/end events of
  // distinct steps). While the window carries fewer than the sample-limit's
  // worst case AND more history exists, the latest completed steps may still
  // be beyond the window front — page once more.
  let steps = 0
  const seen = new Set<string>()
  for (const event of events) {
    if (event.type !== 'step/end') continue
    const data = event.data as { readonly turn?: unknown; readonly step?: unknown }
    if (typeof data.turn !== 'number' || typeof data.step !== 'number') continue
    const key = `${data.turn}/${data.step}`
    if (seen.has(key)) continue
    seen.add(key)
    steps += 1
  }
  return steps < RECENT_PERFORMANCE_SAMPLE_LIMIT * 2
}

/**
 * Compose the Remote whole-log + recent stats for one session (§3.3).
 * Superseded (generation/binding/scope replaced) settles `undefined`, never
 * a partial or stale figure.
 */
export async function composeRemoteSessionStats(input: {
  readonly sessionId: string
  readonly reader: RemoteFactsReader
  readonly fence: RemoteFactsFence
  readonly facts: RemoteStatsProjectionFacts
  readonly signal?: AbortSignal
}): Promise<SessionStats | undefined> {
  const { sessionId, reader, fence, facts, signal } = input
  signal?.throwIfAborted()
  // 1. The whole-log projection facts (turns/steps/llmMs + usage + window).
  const totals = numericTotalsOf(facts.sessionStats)
  // 2. The recent-window figures off the EXACT binding, paged only while the
  //    latest completed steps may still be missing.
  let snapshot = await reader.read(sessionId, signal)
  if (snapshot === undefined || !fence.isCurrent()) return undefined
  let paged = 0
  while (
    snapshot.coverage === 'bounded'
    && snapshot.hasMore
    && !snapshot.loadingOlder
    && recentSamplesIncomplete(snapshot.durableEvents)
    && paged < 10
  ) {
    signal?.throwIfAborted()
    const next = await reader.loadOlder(sessionId, signal)
    if (next === undefined || !fence.isCurrent()) return undefined
    snapshot = next
    paged += 1
  }
  if (!fence.isCurrent()) return undefined
  const recent = recentPerformanceOf(snapshot.durableEvents as never[])
  // 3. Token totals + cache-hit from the official usage projection.
  const usage = facts.usage
  const inputTokens = usage?.uncachedInputTokens ?? 0
  const outputTokens = usage?.outputTokens ?? 0
  const cacheReadTokens = usage?.cacheReadTokens ?? 0
  const cacheWriteTokens = usage?.cacheWriteTokens ?? 0
  const billedInput = inputTokens + cacheReadTokens + cacheWriteTokens
  return {
    turns: totals.turns ?? 0,
    steps: totals.steps ?? 0,
    llmMs: totals.llmMs ?? 0,
    firstTokenMsAvg: recent.firstTokenMsAvg,
    tokensPerSec: recent.tokensPerSec,
    cacheHitPct: billedInput > 0 ? (cacheReadTokens * 100) / billedInput : 0,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(facts.contextWindow === undefined ? {} : { contextWindow: facts.contextWindow }),
  }
}

/**
 * Compose the Remote last assistant text for one session (§3.6): scan the
 * current window newest-first; page `loadOlder` until the newest durable
 * assistant message is inside the window or the history start is reached.
 */
export async function composeRemoteLastAssistantText(input: {
  readonly sessionId: string
  readonly reader: RemoteFactsReader
  readonly fence: RemoteFactsFence
  readonly signal?: AbortSignal
}): Promise<string | undefined> {
  const { sessionId, reader, fence, signal } = input
  signal?.throwIfAborted()
  let snapshot = await reader.read(sessionId, signal)
  while (snapshot !== undefined && fence.isCurrent()) {
    const text = lastAssistantTextOfWindow(snapshot.durableEvents)
    if (text !== undefined) return text
    if (snapshot.coverage === 'full' || !snapshot.hasMore || snapshot.loadingOlder) return undefined
    signal?.throwIfAborted()
    const next = await reader.loadOlder(sessionId, signal)
    if (next === undefined || !fence.isCurrent()) return undefined
    snapshot = next
  }
  return undefined
}
