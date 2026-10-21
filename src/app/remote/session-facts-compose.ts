/**
 * The Remote branch's session-facts composition (M3-4 PR4 §3.3/§3.6/§12.4):
 * whole-log truth from the OFFICIAL projections and the measured performance
 * truth from the Session's own Host `piTuiPerformance` projection. The
 * bounded event window is folded ONLY for `lastAssistantText`, which keeps
 * its own `loadOlder()` paging.
 *
 * Ownership rules (frozen, TPS plan PR-2):
 * - lifetime turns/steps/llmMs come from the `sessionStats` projection —
 *   NEVER computed from the bounded window;
 * - token totals come from the `tokenUsage` projection; the context window
 *   from the context projection; cache-hit percentage derives from those
 *   totals with the same formula as the fold;
 * - the measured performance values (R5 rate + recent first-token + All
 *   rate) come from the Session's OWN Host `piTuiPerformance` projection,
 *   which the caller passes in as `facts.performance`. The bounded event
 *   window is NOT folded and `loadOlder()` is NOT paged for performance: the
 *   Host projection is complete by construction, so no amount of local
 *   history proves it better;
 * - lastAssistantText scans the window newest-first and pages `loadOlder()`
 *   until the newest durable assistant/message is inside the window (or the
 *   history start is reached): `undefined` = no assistant message yet, `''`
 *   = the message carries no text;
 * - the currentness fence is re-checked; a superseded operation settles as
 *   stale/undefined and NEVER retargets to a replacement binding.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/session-facts-compose
 */

import type { PresentationDurableEvent, PresentationReadSnapshot } from '../../runtime/presentation-read-port.ts'
import type { SessionStatusProjection } from '../../runtime/session-reader-port.ts'
import type { SessionStatsFacts } from '../../domain/status/stats.ts'
import { derivePerformance } from '../../domain/status/performance-view.ts'

/** The whole-log projection facts the composition consumes (detached). */
export interface RemoteStatsProjectionFacts {
  /** The official whole-log `sessionStats` projection value (unknown-shaped
   *  until narrowed; a foreign shape reads unmeasured). */
  readonly sessionStats: unknown
  /** The official `tokenUsage` projection of the SessionStatus facts. */
  readonly usage: SessionStatusProjection['usage']
  /** The official context-window capacity of the status facts. */
  readonly contextWindow: number | undefined
  /** THIS Session's own Host `piTuiPerformance` projection (the status facts'
   *  own field) — the ONE performance authority on this branch. */
  readonly performance: SessionStatusProjection['performance']
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

/**
 * Compose the Remote whole-log + performance stats for one session (§3.3) as
 * AUTHORITY-GROUPED facts (PR5 v2 §1B-2, TPS plan PR-2): the `sessionStats`
 * projection owns `lifetime`, the `tokenUsage` projection owns `tokens`, and
 * THIS Session's Host `piTuiPerformance` projection owns `recent` +
 * `sessionPerformance` (each field present only when its own scope can
 * answer). An absent group means the source cannot answer — never a zero
 * stand-in, and never a bounded-window fold. A superseded
 * (generation/binding/scope replaced) operation settles `undefined`, never a
 * partial or stale figure.
 */
export async function composeRemoteSessionStats(input: {
  readonly sessionId: string
  readonly fence: RemoteFactsFence
  readonly facts: RemoteStatsProjectionFacts
  readonly signal?: AbortSignal
}): Promise<SessionStatsFacts | undefined> {
  const { fence, facts, signal } = input
  signal?.throwIfAborted()
  // The composition is synchronous over facts the caller already read from the
  // exact retained binding; the fence is still checked so a superseded
  // transport/scope settles `undefined` instead of a stale figure. There is
  // deliberately NO reader capability on this input: the bounded event window
  // cannot influence a performance fact at all.
  if (!fence.isCurrent()) return undefined
  const totals = numericTotalsOf(facts.sessionStats)
  const usage = facts.usage
  // ONE derivation, straight off THIS Session's Host projection: no bounded
  // window fold, no `loadOlder()`, no local sample ring.
  const performance = derivePerformance(facts.performance)
  return {
    ...(Object.keys(totals).length > 0 ? { lifetime: { ...totals } } : {}),
    ...(usage === undefined ? {} : {
      tokens: {
        input: usage.uncachedInputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens,
        cacheHitPct: (usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) > 0
          ? (usage.cacheReadTokens * 100) / (usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)
          : 0,
      },
    }),
    ...(performance.firstTokenMs === undefined && performance.tokensPerSec === undefined
      ? {}
      : {
          recent: {
            ...(performance.firstTokenMs === undefined ? {} : { firstTokenMsAvg: performance.firstTokenMs }),
            ...(performance.tokensPerSec === undefined ? {} : { tokensPerSec: performance.tokensPerSec }),
          },
        }),
    ...(performance.sessionTokensPerSec === undefined
      ? {}
      : { sessionPerformance: { tokensPerSec: performance.sessionTokensPerSec } }),
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
