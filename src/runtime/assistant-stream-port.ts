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

/** The chunk surface the TUI presentation consumes (structural subset of
 * the official `StreamChunk` — never a package dependency). Unknown chunk
 * kinds are ignored by consumers; the union is deliberately open-ended via
 * the `finish`/`block-start` members the presentation may need later. */
export type AssistantLiveChunk =
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | {
    readonly type: 'tool-call-delta'
    readonly index: number
    readonly id: string
    readonly name?: string
    readonly argumentsDelta: string
  }
  | { readonly type: 'block-end'; readonly index: number; readonly block: { readonly type: string; readonly id?: string; readonly name?: string } }
  | {
    readonly type: 'usage'
    readonly usage: {
      readonly inputTokens: number
      readonly outputTokens: number
      readonly cacheReadTokens?: number
      readonly cacheWriteTokens?: number
    }
  }

/** One live assistant stream input, transport-neutral. */
export type AssistantLiveInput =
  /** The attempt opened: a new model attempt for one turn/step. */
  | { readonly kind: 'start'; readonly sessionId: string; readonly attemptId: string; readonly turn: number; readonly step: number }
  /** One delivered chunk of the attempt (text/reasoning/tool-call/usage). */
  | { readonly kind: 'chunk'; readonly sessionId: string; readonly attemptId: string; readonly turn: number; readonly step: number; readonly time: number; readonly chunk: AssistantLiveChunk }
  /** The attempt settled: `committed` = a durable `assistant/message` or
   * `assistant/attempt` event was committed before this notification;
   * `abandoned` = no durable settlement exists (stream error). */
  | { readonly kind: 'end'; readonly sessionId: string; readonly attemptId: string; readonly turn: number; readonly step: number; readonly status: 'committed' | 'abandoned' }

/** The live-stream sink the runner installs (routes by session id to the
 * main folder, the subagent viewer, stats, and tool previews). */
export type AssistantLiveSink = (input: AssistantLiveInput) => void
