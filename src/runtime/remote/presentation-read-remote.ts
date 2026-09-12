/**
 * Read-only presentation adapter over an official Client Session binding.
 *
 * The Client owns reconnect, event-window continuity, paging, and transient
 * settlement. This adapter consumes only the binding's current snapshots and
 * reconstructs the separate durable history and live inputs needed by the
 * existing TUI fold; it is not another history or assistant-stream state
 * machine.
 * @module @xmoon76/dsh-pi-tui/runtime/remote/presentation-read-remote
 */

import type { AssistantLiveChunk, AssistantLiveInput } from '../assistant-stream-port.ts'
import type {
  PresentationDurableEvent,
  PresentationReader,
  PresentationReadSnapshot,
} from '../presentation-read-port.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from './session-reader-remote.ts'

/** Structural durable entry exposed by the official Client event source. */
export interface RemotePresentationDurableEntry {
  readonly type: 'event'
  readonly event: unknown
}

/** Structural transient entry exposed by the official Client event source. */
export interface RemotePresentationTransientEntry {
  readonly type: 'transient'
  readonly event: {
    readonly type: 'assistant/live-chunk'
    readonly time: number
    readonly data: {
      readonly attemptId: string
      readonly turn: number
      readonly step: number
      readonly chunk: unknown
    }
  }
}

export type RemotePresentationEventEntry =
  | RemotePresentationDurableEntry
  | RemotePresentationTransientEntry

/** Current event-window snapshot from `SessionBinding.eventSource`. */
export interface RemotePresentationEventWindow {
  readonly entries: readonly RemotePresentationEventEntry[]
  readonly hasMore: boolean
  readonly revision: number
}

/** Existing Client Session face needed for read and history paging. */
export interface RemotePresentationSession {
  getSnapshot(): {
    readonly openState: 'cold' | 'loading' | 'open' | 'error'
    readonly loadingOlder: boolean
  }
  loadOlder(): Promise<void>
}

/** Existing Client binding face; no binding is retained in the result. */
export interface RemotePresentationBinding {
  readonly session: RemotePresentationSession
  readonly eventSource: {
    getSnapshot(): RemotePresentationEventWindow
  }
}

/** Structural subset of official `ClientSessions`. */
export interface RemotePresentationSessionsSource {
  binding(sessionId: string): RemotePresentationBinding | undefined
}

function generationMatches(
  generation: RemoteConnectionGenerationSource,
  captured: RemoteConnectionGeneration,
): boolean {
  return Object.is(captured, generation.getSnapshot())
}

/** Clone wire data before freezing so Client-owned nested values never escape. */
function detachedClone<T>(value: T): T {
  const clone = structuredClone(value)
  return freezePlainTree(clone)
}

/** Freeze JSON-shaped event data without assuming anything about host classes. */
function freezePlainTree<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    for (const item of value) freezePlainTree(item)
    return Object.freeze(value)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  for (const child of Object.values(value as Record<string, unknown>)) freezePlainTree(child)
  return Object.freeze(value)
}

function durableEventOf(value: unknown): PresentationDurableEvent {
  return detachedClone(value as PresentationDurableEvent)
}

/**
 * Partition one eventSource window while retaining source order within each
 * plane. Cross-plane chronology is deliberately not exported: the shared
 * fresh projection hydrates its durable cut before replaying its live baseline.
 */
function liveInputsOf(
  sessionId: string,
  entries: readonly RemotePresentationEventEntry[],
): {
  readonly liveInputs: readonly AssistantLiveInput[]
  readonly durableEvents: readonly PresentationDurableEvent[]
} {
  const liveInputs: AssistantLiveInput[] = []
  const durableEvents: PresentationDurableEvent[] = []
  const started = new Set<string>()

  for (const entry of entries) {
    if (entry.type === 'event') {
      durableEvents.push(durableEventOf(entry.event))
      continue
    }

    const { attemptId, turn, step, chunk } = entry.event.data
    const key = JSON.stringify([attemptId, turn, step])
    if (!started.has(key)) {
      started.add(key)
      const start = Object.freeze({
        kind: 'start' as const,
        sessionId,
        attemptId,
        turn,
        step,
      })
      liveInputs.push(start)
    }
    const liveChunk = Object.freeze({
      kind: 'chunk' as const,
      sessionId,
      attemptId,
      turn,
      step,
      time: entry.event.time,
      chunk: detachedClone(chunk as AssistantLiveChunk),
    })
    liveInputs.push(liveChunk)
  }

  return {
    liveInputs: Object.freeze(liveInputs),
    durableEvents: Object.freeze(durableEvents),
  }
}

function snapshotOf(
  sessionId: string,
  binding: RemotePresentationBinding,
): PresentationReadSnapshot {
  const session = binding.session.getSnapshot()
  const window = binding.eventSource.getSnapshot()
  const inputs = liveInputsOf(sessionId, window.entries)
  return Object.freeze({
    sessionId,
    durableEvents: inputs.durableEvents,
    liveInputs: inputs.liveInputs,
    revision: window.revision,
    coverage: 'bounded',
    hasMore: window.hasMore,
    loadingOlder: session.loadingOlder,
    openState: session.openState,
  })
}

/** Read an existing Client binding, or page it through the official Session face. */
export class RemotePresentationReader implements PresentationReader {
  private readonly sessions: RemotePresentationSessionsSource
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    sessions: RemotePresentationSessionsSource,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.sessions = sessions
    this.generation = generation
  }

  async read(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<PresentationReadSnapshot | undefined> {
    signal?.throwIfAborted()
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return undefined
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) return undefined
    if (!generationMatches(this.generation, capturedGeneration)) return undefined
    return snapshotOf(sessionId, binding)
  }

  async loadOlder(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<PresentationReadSnapshot | undefined> {
    signal?.throwIfAborted()
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return undefined
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) return undefined
    if (!generationMatches(this.generation, capturedGeneration)) return undefined

    const current = snapshotOf(sessionId, binding)
    if (current.openState !== 'open' || !current.hasMore || current.loadingOlder) return current

    try {
      await binding.session.loadOlder()
    } catch (error) {
      signal?.throwIfAborted()
      if (!generationMatches(this.generation, capturedGeneration)) return undefined
      throw error
    }
    signal?.throwIfAborted()
    if (!generationMatches(this.generation, capturedGeneration)) return undefined
    return snapshotOf(sessionId, binding)
  }
}
