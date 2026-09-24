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
}
