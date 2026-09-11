/**
 * The TUI-neutral live assistant stream input (Session v2) — the
 * presentation ingress for process-local model output.
 *
 * DSH master keeps live model output on a TRANSIENT plane
 * (`agent/assistant-stream` frames) and durable settlement on the Session
 * log (`assistant/message` / `assistant/attempt` with embedded compact
 * streams). The TUI presentation (Transcript / Focus / Stats / streaming
 * tool previews) consumes ONLY this neutral input for the live plane, so a
 * future Remote adapter can map the official Client transient events onto
 * the same ingress without touching the UI domain.
 *
 * The port deliberately carries only what presentation needs — session
 * identity, attempt identity, turn/step, timing, and the chunk surface —
 * and never imports DSH internal types. The chunk union is a structural
 * subset of the official `StreamChunk`; the Direct adapter narrows the
 * official frame at the boundary.
 * @module @xmoon76/dsh-pi-tui/runtime/assistant-stream-port
 */

/** Structural content-block mirror used by the live boundary. The final
 * catch-all preserves merge-extensible DSH block kinds without discarding
 * fields that this TUI does not render. */
interface AssistantLiveContentBlockBase {
  readonly type: string
  readonly id?: string
  readonly name?: string
  readonly [key: string]: unknown
}

export type AssistantLiveContentBlock = AssistantLiveContentBlockBase & (
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: unknown }
  | { readonly type: 'file'; readonly attachment: unknown }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }
  | { readonly type: 'tool-result'; readonly toolCallId: string; readonly content: readonly AssistantLiveContentBlock[]; readonly isError?: boolean }
  | { readonly type: string }
)

/** Structural finish-reason mirror; provider-specific fields remain intact. */
export interface AssistantLiveFinishReason {
  readonly kind: string
  readonly [key: string]: unknown
}

/** Structural usage mirror. Accounting uses the four token fields while the
 * transport preserves the richer official usage payload. */
export interface AssistantLiveUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly [key: string]: unknown
}

/** The chunk surface the TUI presentation consumes (structural mirror of the
 * official `StreamChunk` — never a package dependency). */
export type AssistantLiveChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: string }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | {
    readonly type: 'tool-call-delta'
    readonly index: number
    readonly id: string
    readonly name?: string
    readonly argumentsDelta: string
  }
  | { readonly type: 'block-end'; readonly index: number; readonly block: AssistantLiveContentBlock }
  | { readonly type: 'usage'; readonly usage: AssistantLiveUsage }
  | {
    readonly type: 'finish'
    readonly reason: AssistantLiveFinishReason
    readonly replayState?: unknown
    readonly [key: string]: unknown
  }

/** One live assistant stream input, transport-neutral. */
export type AssistantLiveInput =
  /** The attempt opened: a new model attempt for one turn/step. */
  | { readonly kind: 'start'; readonly sessionId: string; readonly attemptId: string; readonly turn: number; readonly step: number }
  /** One delivered chunk of the attempt (deltas, block controls, usage, or finish). */
  | { readonly kind: 'chunk'; readonly sessionId: string; readonly attemptId: string; readonly turn: number; readonly step: number; readonly time: number; readonly chunk: AssistantLiveChunk }
  /** The attempt settled: `committed` = a durable event was committed
   * before this notification (`settlement` names it — an
   * `assistant/attempt` settlement remains transient attempt evidence until
   * retry or turn end, while `assistant/message` owns the normal surface);
   * `abandoned` = no durable settlement exists (stream error). */
  | {
    readonly kind: 'end'
    readonly sessionId: string
    readonly attemptId: string
    readonly turn: number
    readonly step: number
    readonly status: 'committed' | 'abandoned'
    readonly settlement?: 'message' | 'attempt'
  }

/** The live-stream sink the runner installs (routes by session id to the
 * main folder, the subagent viewer, stats, and tool previews). */
export type AssistantLiveSink = (input: AssistantLiveInput) => void
