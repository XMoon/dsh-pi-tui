/**
 * Direct reference reader for presentation parity.
 *
 * It reuses the exact live Agent session log and the existing Direct assistant
 * baseline callback installed by the runner. It owns no stream tracker and no
 * history state; the callback remains the owner of active attempts.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/presentation-read-direct
 */

import type {
  AssistantLiveInput,
} from '../assistant-stream-port.ts'
import type {
  PresentationDurableEvent,
  PresentationReader,
  PresentationReadSnapshot,
} from '../presentation-read-port.ts'

/** Existing Agent facts needed by the Direct reference. */
export interface DirectPresentationAgent {
  readonly session: {
    snapshotEvents(): readonly unknown[]
  }
}

/** Injected reference faces; both resolve already-live state only. */
export interface DirectPresentationReadSource {
  agentFor(sessionId: string): DirectPresentationAgent | undefined
  assistantStreamBaselineFor(agent: object): readonly AssistantLiveInput[]
}

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

function detachedClone<T>(value: T): T {
  return freezePlainTree(structuredClone(value))
}

function snapshotOf(
  sessionId: string,
  agent: DirectPresentationAgent,
  source: DirectPresentationReadSource,
): PresentationReadSnapshot {
  const durableEvents = agent.session.snapshotEvents().map(event => detachedClone(event as PresentationDurableEvent))
  const baseline = source.assistantStreamBaselineFor(agent)
    .map(input => detachedClone(input))
  // Direct exposes the same two existing faces as the production TUI: the
  // durable log and the active live baseline. They intentionally remain
  // separate because Direct has no shared cross-plane sequence; the shared
  // semantic fold hydrates durable events before replaying live inputs.
  return Object.freeze({
    sessionId,
    durableEvents: Object.freeze(durableEvents),
    liveInputs: Object.freeze(baseline),
    revision: durableEvents.length,
    coverage: 'full',
    hasMore: false,
    loadingOlder: false,
    openState: 'open',
  })
}

/** Read the current Direct Agent presentation facts without mutating them. */
export class DirectPresentationReader implements PresentationReader {
  private readonly source: DirectPresentationReadSource

  constructor(source: DirectPresentationReadSource) {
    this.source = source
  }

  async read(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<PresentationReadSnapshot | undefined> {
    signal?.throwIfAborted()
    const agent = this.source.agentFor(sessionId)
    if (agent === undefined) return undefined
    return snapshotOf(sessionId, agent, this.source)
  }

  async loadOlder(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<PresentationReadSnapshot | undefined> {
    return this.read(sessionId, signal)
  }
}
