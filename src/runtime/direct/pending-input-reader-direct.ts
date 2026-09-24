/**
 * The Direct pending-input reader (D2.1): normalize the live Agent inbox
 * into the official queued/steering/context placement projection. This is the
 * only pending-input read path that knows Direct's `nextTurn` / `nextStep`
 * collection names and message sources; consumers use `PendingInputReader`
 * instead.
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

function isUserSource(source: unknown): boolean {
  return typeof source === 'object'
    && source !== null
    && (source as { readonly kind?: unknown }).kind === 'user'
}

/** The plain correlation identity of a user-origin message. Only a string
 * `rpcId` crosses the port; the `source` object itself never does. */
function userRpcIdOf(source: unknown): string | undefined {
  if (!isUserSource(source)) return undefined
  const rpcId = (source as { readonly rpcId?: unknown }).rpcId
  return typeof rpcId === 'string' ? rpcId : undefined
}

const itemOf = (
  message: DirectPendingMessageLike,
  placement: PendingInputItem['placement'],
): PendingInputItem => {
  const rpcId = userRpcIdOf(message.source)
  return {
    id: message.id,
    placement,
    content: message.content,
    ...(rpcId === undefined ? {} : { rpcId }),
  }
}

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
        ...agent.inbox.nextStep.map(message => itemOf(message, isUserSource(message.source) ? 'steering' : 'context')),
      ],
    }
  }
}
