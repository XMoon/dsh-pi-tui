/**
 * The Direct pending-input reader (D2.1): normalize the live Agent inbox
 * into the official queued/steering placement projection. This is the only
 * pending-input read path that knows Direct's `nextTurn` / `nextStep`
 * collection names; consumers use `PendingInputReader` instead.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/pending-input-reader-direct
 */

import type {
  PendingInputItem,
  PendingInputReader,
  PendingInputSnapshot,
} from '../pending-input-reader-port.ts'

/** The structural message shape needed to detach one Direct inbox row. */
interface DirectPendingMessageLike {
  readonly id: string
  readonly content: readonly unknown[]
  readonly source?: unknown
}

/** The minimal live Agent shape for this Direct adapter. */
interface DirectPendingAgentLike {
  readonly status: string
  readonly session: { readonly id: string }
  readonly inbox: {
    readonly nextTurn: readonly DirectPendingMessageLike[]
    readonly nextStep: readonly DirectPendingMessageLike[]
  }
}

const itemOf = (
  message: DirectPendingMessageLike,
  placement: PendingInputItem['placement'],
): PendingInputItem => ({
  id: message.id,
  placement,
  content: message.content,
  source: message.source,
})

/** Normalize one live Direct Agent into the semantic pending-input snapshot. */
export class DirectPendingInputReader implements PendingInputReader {
  private readonly agentFor: (sessionId: string) => DirectPendingAgentLike | undefined

  constructor(agentFor: (sessionId: string) => DirectPendingAgentLike | undefined) {
    this.agentFor = agentFor
  }

  snapshot(sessionId: string): PendingInputSnapshot | undefined {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return undefined
    return {
      running: agent.status === 'running',
      items: [
        ...agent.inbox.nextTurn.map(message => itemOf(message, 'queued')),
        ...agent.inbox.nextStep.map(message => itemOf(message, 'steering')),
      ],
    }
  }
}
