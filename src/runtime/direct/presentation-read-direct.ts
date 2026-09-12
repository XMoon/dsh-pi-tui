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
  PresentationReadInput,
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
  // Direct's durable log and live baseline have no shared sequence face, so
  // this local snapshot order is only a deterministic fallback. The parity
  // shadow aligns Direct payloads to the Remote source order before folding.
  const orderedInputs: PresentationReadInput[] = []
  for (const event of durableEvents) orderedInputs.push(Object.freeze({ kind: 'durable', event }))
  for (const input of baseline) orderedInputs.push(Object.freeze({ kind: 'live', input }))
  return Object.freeze({
    sessionId,
    durableEvents: Object.freeze(durableEvents),
    liveInputs: Object.freeze(baseline),
    orderedInputs: Object.freeze(orderedInputs),
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
