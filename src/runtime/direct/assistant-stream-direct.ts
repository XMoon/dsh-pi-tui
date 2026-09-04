/**
 * The Direct live assistant stream adapter (Session v2) — maps the official
 * process-local `agent/assistant-stream` frames onto the TUI-neutral
 * `AssistantLiveInput` ingress.
 *
 * The adapter is the ONLY module in the live-stream path that touches the
 * DSH event surface. It verifies the emitting agent is still the current
 * live agent for its session (the runner injects the identity check — a
 * stale stream from a retired agent must never reach the presentation),
 * then maps the official frame to the neutral input. Durable settlement is
 * NOT synthesized here: `assistant/message` / `assistant/attempt` continue
 * to arrive through the ordinary `session/event` plane.
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

/** The official frame surface (structural subset of `AssistantStreamFrame`
 * from `@deepseek-ai/dsh-agent` — the adapter narrows at the boundary). */
export type AssistantStreamFrameLike =
  | {
    readonly type: 'start'
    readonly attemptId: unknown
    readonly turn: number
    readonly step: number
  }
  | {
    readonly type: 'chunk'
    readonly attemptId: unknown
    readonly turn: number
    readonly step: number
    readonly time: number
    readonly chunk: unknown
  }
  | {
    readonly type: 'end'
    readonly attemptId: unknown
    readonly turn: number
    readonly step: number
    readonly outcome: { readonly kind: 'committed' | 'abandoned' }
  }

/** The agent surface the adapter reads the session identity from. */
export interface AssistantStreamAgentLike {
  readonly session: { readonly id: unknown }
}

/** The adapter's dependencies. */
export interface AssistantStreamDirectDeps {
  /** The Host event surface (`ctx`). */
  readonly ctx: HostEventSurface
  /** Whether the emitting agent is still the current live agent for its
   * session (the runner's generation/identity fence — a stale stream must
   * never reach the presentation). */
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

/** Install the Direct live-stream listener. Returns the uninstall function
 * (the runner binds it to the lifecycle controller). */
export function installAssistantStreamDirect(deps: AssistantStreamDirectDeps): () => void {
  const handler = (payload: unknown): void => {
    const envelope = payload as { agent?: unknown; frame?: unknown } | undefined
    if (envelope === undefined || envelope.agent === undefined || envelope.frame === undefined) return
    // Identity fence FIRST: a stale stream from a retired agent must never
    // reach the presentation (the runner's check re-reads the live surface).
    if (!deps.isCurrentAgent(envelope.agent)) return
    const agent = envelope.agent as AssistantStreamAgentLike
    const sessionId = agent.session?.id
    if (typeof sessionId !== 'string') return
    const frame = envelope.frame as AssistantStreamFrameLike
    switch (frame.type) {
      case 'start':
        deps.onInput({
          kind: 'start',
          sessionId,
          attemptId: String(frame.attemptId),
          turn: frame.turn,
          step: frame.step,
        })
        break
      case 'chunk': {
        const chunk = toLiveChunk(frame.chunk)
        if (chunk === undefined) return
        deps.onInput({
          kind: 'chunk',
          sessionId,
          attemptId: String(frame.attemptId),
          turn: frame.turn,
          step: frame.step,
          time: frame.time,
          chunk,
        })
        break
      }
      case 'end':
        deps.onInput({
          kind: 'end',
          sessionId,
          attemptId: String(frame.attemptId),
          turn: frame.turn,
          step: frame.step,
          status: frame.outcome?.kind === 'committed' ? 'committed' : 'abandoned',
        })
        break
    }
  }
  const dispose = deps.ctx.on('agent/assistant-stream', handler)
  return () => {
    dispose()
  }
}
