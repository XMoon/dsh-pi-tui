/**
 * Remote implementation of the semantic PendingInputReader port (D2.2).
 *
 * The official Client `SessionFace` snapshot owns the authoritative queue
 * (`SessionSnapshot.queue`), already projected into the official
 * `queued`/`steering`/`context` placement vocabulary with occurrence identity
 * and the optional prompt `rpcId`. This adapter maps that snapshot into the
 * existing transport-neutral port; it never inspects Direct inbox collection
 * names and never derives placement from `running`.
 *
 * The snapshot is synchronous because the official Client keeps the queue in a
 * subscribed snapshot cache; no RPC runs here. A Connection generation is
 * required so a lost Connection never becomes an authoritative empty queue, and
 * a replacement generation observed during the read is reported as unavailable
 * rather than as stale data.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pending-input-reader-remote
 */

import type {
  PendingInputItem,
  PendingInputPlacement,
  PendingInputReader,
  PendingInputSnapshot,
} from '../pending-input-reader-port.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from './session-reader-remote.ts'

/** One authoritative queue occurrence retained on the official Session snapshot. */
export interface RemoteQueuedOccurrence {
  readonly id: string
  readonly placement: PendingInputPlacement
  readonly rpcId?: string
  readonly content: readonly unknown[]
}

/** The official observable Session snapshot subset consumed here. */
export interface RemotePendingSessionSnapshot {
  readonly queue: readonly RemoteQueuedOccurrence[]
  readonly running: boolean
}

/** The official Session face read face (`getSnapshot`). */
export interface RemotePendingSessionFace {
  getSnapshot(): RemotePendingSessionSnapshot
}

/** The official `SessionBinding` subset needed for one pending-input read. */
export interface RemotePendingBinding {
  readonly session: RemotePendingSessionFace
}

/** The official `ClientSessions` write/read identity face. */
export interface RemotePendingSessionsSource {
  binding(sessionId: string): RemotePendingBinding | undefined
}

/** Freeze JSON-shaped wire data so Client-owned nested values never escape. */
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

/** Detach one occurrence's content before it crosses the port. */
function detachedContent(content: readonly unknown[]): readonly unknown[] {
  const clone = structuredClone(content) as unknown[]
  return freezePlainTree(clone)
}

function itemOf(occurrence: RemoteQueuedOccurrence): PendingInputItem {
  return {
    id: occurrence.id,
    placement: occurrence.placement,
    content: detachedContent(occurrence.content),
    ...(typeof occurrence.rpcId === 'string' && occurrence.rpcId !== ''
      ? { rpcId: occurrence.rpcId }
      : {}),
  }
}

function generationMatches(
  generation: RemoteConnectionGenerationSource,
  captured: RemoteConnectionGeneration,
): boolean {
  return Object.is(captured, generation.getSnapshot())
}

/**
 * Maps the official Client Session queue snapshot to the semantic pending-input
 * projection, preserving the official order and placement verbatim.
 */
export class RemotePendingInputReader implements PendingInputReader {
  private readonly sessions: RemotePendingSessionsSource
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    sessions: RemotePendingSessionsSource,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.sessions = sessions
    this.generation = generation
  }

  snapshot(sessionId: string): PendingInputSnapshot | undefined {
    const captured = this.generation.getSnapshot()
    if (captured === undefined) return undefined
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) return undefined
    const snapshot = binding.session.getSnapshot()
    if (!generationMatches(this.generation, captured)) return undefined
    return {
      running: snapshot.running,
      items: snapshot.queue.map(itemOf),
    }
  }
}
