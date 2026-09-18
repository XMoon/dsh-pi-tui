/**
 * Remote implementation of the semantic PendingInputReader port (D2.2),
 * migrated to the alpha2 durable inbox projection.
 *
 * DSH 0.1.6-alpha.2 removed `SessionSnapshot.queue`: pending durable input is
 * only reachable through the standard projection face,
 * `session.projections.faceOf('inbox')`, whose value is the official
 * `InboxState { 'next-turn': UserMessage[]; 'next-step': UserMessage[] }`
 * reconstructed from durable inbox splices (so it also survives a reconnect or
 * a restart re-materialization). This adapter maps that projection into the
 * existing transport-neutral port; it never inspects Direct inbox collection
 * names and never derives placement from `running`.
 *
 * The read is synchronous because the official Client keeps projection values
 * in a subscribed store; no RPC runs here. A Connection generation is required
 * so a lost Connection never becomes an authoritative empty inbox, and a
 * replacement generation observed during the read is reported as unavailable
 * rather than as stale data.
 *
 * Absence and violation are different things: `undefined` is the official
 * projection store's ONLY "no value" (capability or baseline not arrived yet)
 * and reads as an empty inbox, while a PRESENT value that violates the
 * published `InboxState` shape is a wire-contract violation and fails loudly.
 * Silently reporting an empty queue for it would hide durable input the Host
 * may still execute.
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

/** The official observable Session snapshot subset consumed here. */
export interface RemotePendingSessionSnapshot {
  readonly running: boolean
}

/** The official Session projection face (`faceOf`): its value type is
 * deliberately `unknown` so no Client projection type crosses this boundary. */
export interface RemotePendingProjectionFace {
  getSnapshot(): unknown
}

/** The official Session face read face (`getSnapshot` + projections). */
export interface RemotePendingSessionFace {
  getSnapshot(): RemotePendingSessionSnapshot
  readonly projections: {
    faceOf(key: string): RemotePendingProjectionFace
  }
}

/** The official `SessionBinding` subset needed for one pending-input read. */
export interface RemotePendingBinding {
  readonly session: RemotePendingSessionFace
}

/** The official `ClientSessions` borrow-only identity face. */
export interface RemotePendingSessionsSource {
  binding(sessionId: string): RemotePendingBinding | undefined
}

/** The official projection key carrying durable pending input. */
const INBOX_PROJECTION_KEY = 'inbox'

/** One present inbox value violated the published `InboxState` shape. */
function inboxShapeError(what: string): Error {
  return new Error(`the official inbox projection is malformed: ${what} does not match the published InboxState shape`)
}

/** A structurally-read wire record (never an array, null, or a primitive). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/** Detach one inbox message's content before it crosses the port. */
function detachedContent(content: readonly unknown[]): readonly unknown[] {
  const clone = structuredClone(content) as unknown[]
  return freezePlainTree(clone)
}

/** Read the `source` field off one structurally-read inbox message. */
function messageSource(message: unknown): unknown {
  return typeof message === 'object' && message !== null
    ? (message as { readonly source?: unknown }).source
    : undefined
}

function isUserSource(source: unknown): boolean {
  return typeof source === 'object'
    && source !== null
    && (source as { readonly kind?: unknown }).kind === 'user'
}

/** The plain correlation identity of a user-origin inbox message. Only a
 * string `rpcId` crosses the port; the `source` object itself never does.
 * The rule is exactly the port's `source.kind === 'user' && typeof rpcId ===
 * 'string'` — the Direct adapter and the plan use the same one, so an empty
 * string is preserved rather than treated as absent. */
function userRpcIdOf(source: unknown): string | undefined {
  if (!isUserSource(source)) return undefined
  const rpcId = (source as { readonly rpcId?: unknown }).rpcId
  return typeof rpcId === 'string' ? rpcId : undefined
}

/**
 * Detach one inbox message into the semantic item. The projection crosses a
 * wire boundary, so its value is read structurally — and a row that does not
 * match the published `UserMessage` shape is a contract violation, never a row
 * to silently drop: dropping it would hide durable input the Host may still
 * execute.
 */
function itemOf(message: unknown, placement: PendingInputPlacement): PendingInputItem {
  if (!isRecord(message)) throw inboxShapeError('an inbox message')
  if (typeof message.id !== 'string' || message.id === '') throw inboxShapeError('an inbox message id')
  if (!Array.isArray(message.content)) throw inboxShapeError('an inbox message content')
  const rpcId = userRpcIdOf(message.source)
  return {
    id: message.id,
    placement,
    content: detachedContent(message.content),
    ...(rpcId === undefined ? {} : { rpcId }),
  }
}

/**
 * Read the two official inbox lists off one projection value.
 *
 * `undefined` is the official projection store's only absence value ("absence
 * is an `undefined` snapshot"): the capability or its baseline has not arrived,
 * so there is genuinely no pending input to show. Any other value must be the
 * published `InboxState`, and a present value that is not fails loudly — as
 * does its absence from `undefined`, reusing the "session unavailable" meaning
 * would mislabel a live session, and reporting an empty queue would hide input
 * the Host may still execute.
 */
function inboxLists(inbox: unknown): { readonly queued: readonly unknown[]; readonly nextStep: readonly unknown[] } {
  if (inbox === undefined) return { queued: [], nextStep: [] }
  if (!isRecord(inbox)) throw inboxShapeError('the inbox projection value')
  const queued = inbox['next-turn']
  const nextStep = inbox['next-step']
  if (!Array.isArray(queued)) throw inboxShapeError("the inbox 'next-turn' list")
  if (!Array.isArray(nextStep)) throw inboxShapeError("the inbox 'next-step' list")
  return { queued, nextStep }
}

function generationMatches(
  generation: RemoteConnectionGenerationSource,
  captured: RemoteConnectionGeneration,
): boolean {
  return Object.is(captured, generation.getSnapshot())
}

/**
 * Maps the official durable Client inbox projection to the semantic
 * pending-input projection, preserving the official order and applying the
 * shared placement vocabulary: every `next-turn` message is queued, a
 * user-origin `next-step` message is steering, and any other `next-step`
 * message is context.
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
    const running = binding.session.getSnapshot().running
    const inbox = binding.session.projections.faceOf(INBOX_PROJECTION_KEY).getSnapshot()
    if (!generationMatches(this.generation, captured)) return undefined
    const { queued, nextStep } = inboxLists(inbox)
    const items: PendingInputItem[] = []
    for (const message of queued) items.push(itemOf(message, 'queued'))
    for (const message of nextStep) {
      items.push(itemOf(message, isUserSource(messageSource(message)) ? 'steering' : 'context'))
    }
    return { running, items }
  }
}
