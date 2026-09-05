/**
 * The Direct live assistant stream adapter (Session v2) — maps the official
 * process-local `agent/assistant-stream` frames onto the TUI-neutral
 * `AssistantLiveInput` ingress.
 *
 * The adapter is the ONLY module in the live-stream path that touches the
 * DSH event surface. Official frames carry turn/step ONLY on `start`; a
 * chunk or end frame names its attempt, so the adapter keeps one attempt
 * record per emitting Agent (the master `AssistantStreamAttempt` contract)
 * and resolves turn/step from it. Upstream `revision` (monotone within one
 * attached Agent lifecycle) and the dense per-attempt `index` guard against
 * stale or reordered frames: anything older than the last accepted frame is
 * dropped at the boundary. The runner injects the identity check — a frame
 * whose emitting Agent is not the exact current Agent object never reaches
 * the presentation (master's own headless consumer compares `subject !==
 * agent` the same way). Durable settlement is NOT synthesized here:
 * `assistant/message` / `assistant/attempt` continue to arrive through the
 * ordinary `session/event` plane.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/assistant-stream-direct
 */

import type { AssistantLiveChunk, AssistantLiveInput } from '../assistant-stream-port.ts'

/** The minimal Host event surface the adapter needs (structural — never a
 * package dependency; the service resolves from the dsh installation).
 * Cordis's `on` returns the disposer that removes the listener. */
export interface HostEventSurface {
  on(event: string, listener: (payload: unknown) => void): () => void
}

/** The official frame surface — the EXACT upstream `AssistantStreamFrame`
 * shape (from `@deepseek-ai/dsh-agent`), read structurally at the unknown
 * boundary. Only `start` carries turn/step; chunk/end name their attempt
 * plus the upstream monotone revision and the dense per-attempt index. */
export type AssistantStreamFrameLike =
  | {
    readonly type: 'start'
    readonly attemptId: unknown
    readonly revision: number
    readonly turn: number
    readonly step: number
  }
  | {
    readonly type: 'chunk'
    readonly attemptId: unknown
    readonly revision: number
    readonly index: number
    readonly time: number
    readonly chunk: unknown
  }
  | {
    readonly type: 'end'
    readonly attemptId: unknown
    readonly revision: number
    readonly index: number
    readonly outcome:
      | {
        readonly kind: 'committed'
        readonly eventType: 'assistant/message' | 'assistant/attempt'
        readonly seq: unknown
      }
      | { readonly kind: 'abandoned' }
  }

/** The emitting-agent surface the adapter reads identity from. Only the
 * Agent OBJECT is compared — never a re-derived session id. */
export type AssistantStreamAgentLike = object

/** One accepted in-flight attempt: the durable turn/step owning the
 * request plus the upstream ordering guard state. */
interface AttemptRecord {
  readonly attemptId: string
  readonly turn: number
  readonly step: number
  /** Revision of the last ACCEPTED frame (upstream monotone). */
  lastRevision: number
  /** Number of accepted chunk frames (the dense index must match). */
  chunkCount: number
}

/** The adapter's dependencies. */
export interface AssistantStreamDirectDeps {
  /** The Host event surface (`ctx`). */
  readonly ctx: HostEventSurface
  /** Whether the emitting agent IS the current live Agent OBJECT for the
   * surface it would reach (exact identity — a stale stream from a
   * retired agent must never reach the presentation). */
  readonly isCurrentAgent: (agent: unknown) => boolean
  /** The TUI-neutral sink (the runner routes by session id). */
  readonly onInput: (input: AssistantLiveInput) => void
}

/** Narrow an official frame chunk to the presentation chunk surface. The
 * official `StreamChunk` is structurally compatible; unknown chunk kinds
 * are dropped (the presentation has nothing to do with them). */
function toLiveChunk(chunk: unknown): AssistantLiveChunk | undefined {
  if (typeof chunk !== 'object' || chunk === null) return undefined
  const value = chunk as { type?: unknown; index?: unknown; text?: unknown; id?: unknown; name?: unknown; argumentsDelta?: unknown; block?: unknown; blockType?: unknown; usage?: unknown; reason?: unknown }
  switch (value.type) {
    case 'text-delta':
      if (typeof value.index === 'number' && typeof value.text === 'string') {
        return { type: 'text-delta', index: value.index, text: value.text }
      }
      return undefined
    case 'reasoning-delta':
      if (typeof value.index === 'number' && typeof value.text === 'string') {
        return { type: 'reasoning-delta', index: value.index, text: value.text }
      }
      return undefined
    case 'tool-call-delta': {
      if (typeof value.index !== 'number' || typeof value.id !== 'string' || typeof value.argumentsDelta !== 'string') {
        return undefined
      }
      return {
        type: 'tool-call-delta',
        index: value.index,
        id: value.id,
        ...typeof value.name === 'string' ? { name: value.name } : {},
        argumentsDelta: value.argumentsDelta,
      }
    }
    case 'block-end': {
      const block = value.block as { type?: unknown; id?: unknown; name?: unknown } | undefined
      if (typeof value.index !== 'number' || typeof block?.type !== 'string') return undefined
      return {
        type: 'block-end',
        index: value.index,
        block: {
          type: block.type,
          ...typeof block.id === 'string' ? { id: block.id } : {},
          ...typeof block.name === 'string' ? { name: block.name } : {},
        },
      }
    }
    case 'usage': {
      const usage = value.usage as { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown } | undefined
      if (typeof usage?.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return undefined
      return {
        type: 'usage',
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...typeof usage.cacheReadTokens === 'number' ? { cacheReadTokens: usage.cacheReadTokens } : {},
          ...typeof usage.cacheWriteTokens === 'number' ? { cacheWriteTokens: usage.cacheWriteTokens } : {},
        },
      }
    }
    default:
      // Chunk kinds the presentation does not consume (block-start, finish,
      // unknown future kinds) are dropped at the boundary.
      return undefined
  }
}

/**
 * Install the Direct live-stream listener. Returns the uninstall function
 * (the runner binds it to the lifecycle controller). Attempt state is kept
 * PER EMITTING AGENT OBJECT: the official `start` frame carries the only
 * turn/step, and every chunk/end resolves its turn/step through the
 * attempt record. A chunk/end without a matching open attempt (protocol
 * violation or a replay after the terminal frame) is dropped, as is any
 * frame whose upstream revision is not strictly newer than the last
 * accepted one or whose chunk index is not the next dense position.
 */
export function installAssistantStreamDirect(deps: AssistantStreamDirectDeps): () => void {
  /** Agent object → attemptId → open attempt. Bounded: an entry lives only
   * between its `start` and terminal `end`; the cap is a safety net for a
   * lost terminal frame (an agent dying mid-attempt). */
  const attemptsByAgent = new Map<object, Map<string, AttemptRecord>>()
  const AGENT_ATTEMPT_CAP = 64

  const recordFor = (agent: object, attemptId: string): AttemptRecord | undefined => {
    return attemptsByAgent.get(agent)?.get(attemptId)
  }

  const openAttempt = (agent: object, record: AttemptRecord): void => {
    let attempts = attemptsByAgent.get(agent)
    if (attempts === undefined) {
      attempts = new Map()
      attemptsByAgent.set(agent, attempts)
    }
    if (attempts.size >= AGENT_ATTEMPT_CAP && !attempts.has(record.attemptId)) {
      // Safety net: evict the oldest open attempt (its terminal frame was
      // lost). Maps preserve insertion order.
      const oldest = attempts.keys().next().value
      if (oldest !== undefined) attempts.delete(oldest)
    }
    attempts.set(record.attemptId, record)
  }

  const closeAttempt = (agent: object, attemptId: string): void => {
    const attempts = attemptsByAgent.get(agent)
    if (attempts === undefined) return
    attempts.delete(attemptId)
    if (attempts.size === 0) attemptsByAgent.delete(agent)
  }

  const handler = (payload: unknown): void => {
    const envelope = payload as { agent?: unknown; frame?: unknown } | undefined
    if (envelope === undefined || typeof envelope.agent !== 'object' || envelope.agent === null || envelope.frame === undefined) return
    // Identity fence FIRST (exact Agent object identity): a stale stream
    // from a retired agent must never reach the presentation.
    if (!deps.isCurrentAgent(envelope.agent)) return
    const agent = envelope.agent
    const frame = envelope.frame as AssistantStreamFrameLike
    if (typeof frame !== 'object' || frame === null || typeof frame.revision !== 'number') return
    switch (frame.type) {
      case 'start': {
        if (typeof frame.turn !== 'number' || typeof frame.step !== 'number') return
        const attemptId = String(frame.attemptId)
        if (attemptId === '') return
        const existing = recordFor(agent, attemptId)
        // A duplicate start for the same attempt is a protocol violation;
        // a strictly newer revision wins (upstream revision is monotone).
        if (existing !== undefined && frame.revision <= existing.lastRevision) return
        openAttempt(agent, {
          attemptId,
          turn: frame.turn,
          step: frame.step,
          lastRevision: frame.revision,
          chunkCount: 0,
        })
        deps.onInput({
          kind: 'start',
          sessionId: String((agent as { session?: { id?: unknown } }).session?.id ?? ''),
          attemptId,
          turn: frame.turn,
          step: frame.step,
        })
        break
      }
      case 'chunk': {
        if (typeof frame.index !== 'number' || typeof frame.time !== 'number') return
        const attemptId = String(frame.attemptId)
        const record = recordFor(agent, attemptId)
        if (record === undefined) return
        // Ordering guards: the upstream revision is monotone within the
        // agent lifecycle, and chunk index is dense within the attempt.
        // The dense position advances for EVERY delivered frame — kinds
        // the presentation does not consume (block-start, finish, ...)
        // still occupy an index slot upstream.
        if (frame.revision <= record.lastRevision) return
        if (frame.index !== record.chunkCount) return
        record.lastRevision = frame.revision
        record.chunkCount += 1
        const chunk = toLiveChunk(frame.chunk)
        if (chunk === undefined) return
        deps.onInput({
          kind: 'chunk',
          sessionId: String((agent as { session?: { id?: unknown } }).session?.id ?? ''),
          attemptId,
          turn: record.turn,
          step: record.step,
          time: frame.time,
          chunk,
        })
        break
      }
      case 'end': {
        if (typeof frame.index !== 'number') return
        const attemptId = String(frame.attemptId)
        const record = recordFor(agent, attemptId)
        if (record === undefined) return
        if (frame.revision <= record.lastRevision) return
        const outcome = frame.outcome
        if (typeof outcome !== 'object' || outcome === null) return
        const committed = outcome.kind === 'committed'
        const settlement: 'message' | 'attempt' | undefined = committed
          ? outcome.eventType === 'assistant/message' ? 'message'
            : outcome.eventType === 'assistant/attempt' ? 'attempt' : undefined
          : undefined
        closeAttempt(agent, attemptId)
        deps.onInput({
          kind: 'end',
          sessionId: String((agent as { session?: { id?: unknown } }).session?.id ?? ''),
          attemptId,
          turn: record.turn,
          step: record.step,
          status: committed ? 'committed' : 'abandoned',
          ...(settlement === undefined ? {} : { settlement }),
        })
        break
      }
    }
  }
  const dispose = deps.ctx.on('agent/assistant-stream', handler)
  return () => {
    dispose()
  }
}
