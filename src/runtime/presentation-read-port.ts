/**
 * Detached presentation-read facts shared by the D1 Remote reader and its
 * parity shadow. Durable history and the active live baseline remain separate:
 * a fresh semantic fold hydrates durable events first, then replays live inputs.
 * @module @xmoon76/dsh-pi-tui/runtime/presentation-read-port
 */

import type { AssistantLiveInput } from './assistant-stream-port.ts'

/** Structural durable event envelope consumed by the existing TUI fold. */
export type PresentationDurableEvent = Readonly<Record<string, unknown>> & {
  readonly type: string
  readonly seq: number
  readonly time: number
}

/** The identity proof of one COMMITTED window re-fold (Remote branch): the
 *  official Connection generation and exact retained binding the fold was
 *  fenced under, plus the window revision it committed. The producer is the
 *  Remote presentation source (it reads the official snapshot); the consumer is
 *  the live ingress, which re-validates every field before it resumes
 *  incremental delivery. `unknown` keeps the layers independent — the objects
 *  are compared by identity, never introspected. */
export interface PresentationWindowRefoldProof {
  readonly generation: unknown
  readonly binding: unknown
  readonly revision: number
}

/**
 * The working/busy fold derived from the SAME committed window the proof
 * describes, plus whether that window PROVES the fold (a complete window does;
 * a truncated one defers to the official `running` bit).
 */
export interface PresentationWindowWorkingFold {
  readonly fold: boolean
  readonly proven: boolean
}

/** A current official Client Session event-window observation. */
export interface PresentationReadSnapshot {
  readonly sessionId: string
  /** Durable entries in their source-window order. */
  readonly durableEvents: readonly PresentationDurableEvent[]
  /** Synthetic start/chunk inputs reconstructed from transient entries. */
  readonly liveInputs: readonly AssistantLiveInput[]
  readonly revision: number
  /** Direct exposes the complete in-process log; Client is a bounded window. */
  readonly coverage: 'full' | 'bounded'
  readonly hasMore: boolean
  readonly loadingOlder: boolean
  readonly openState: 'cold' | 'loading' | 'open' | 'error'
}

/** Read and page an already materialized Client Session binding. */
export interface PresentationReader {
  read(sessionId: string, signal?: AbortSignal): Promise<PresentationReadSnapshot | undefined>
  loadOlder(sessionId: string, signal?: AbortSignal): Promise<PresentationReadSnapshot | undefined>
  /** Jump the bounded window backwards until it covers `seq` through the
   *  OFFICIAL Client paging loop (`Session.loadThrough(seq)`) — the TUI never
   *  hand-rolls a `loadOlder()` chain. Direct already exposes full coverage,
   *  so its mapping is a cancellation check plus the current full snapshot.
   *  `undefined` = no materialized binding / connection unavailable / the
   *  settle was superseded. */
  loadThrough(sessionId: string, seq: number, signal?: AbortSignal): Promise<PresentationReadSnapshot | undefined>
}

/** One started-turn outline entry (the official `turnOutline` projection
 *  fields a navigation picker needs: the turn number, the `turn/start` seq a
 *  `loadThrough` jump targets, and the bounded previews). */
export interface TurnOutlineEntryDto {
  readonly turn: number
  readonly seq: number
  readonly prompt: string
  readonly response: string
}

/** Detach the official `turnOutline` wire view into the picker DTO — only
 *  well-formed entries cross (shared by the Direct projection read and the
 *  Remote binding projection read); a foreign-shaped value reads unknown. */
export function detachedTurnOutline(value: unknown): readonly TurnOutlineEntryDto[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: TurnOutlineEntryDto[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const record = entry as { readonly turn?: unknown; readonly seq?: unknown; readonly prompt?: unknown; readonly response?: unknown }
    if (typeof record.turn !== 'number' || typeof record.seq !== 'number') return undefined
    if (typeof record.prompt !== 'string' || typeof record.response !== 'string') return undefined
    entries.push({ turn: record.turn, seq: record.seq, prompt: record.prompt, response: record.response })
  }
  return Object.freeze(entries)
}
