/**
 * Pure DSH-official-fact → standard ACP v1 projection rules.
 *
 * Every function here is a synchronous, stateless conversion or a strict
 * request/cursor rule. This module owns NO cache, NO service, NO IO and NO
 * lifecycle: the View that observes a Session owns the seq/capability fences,
 * the ordered output tail and every Attachment Store read, and the Host access
 * elsewhere owns the official Session/Controller/Query authority.
 *
 * The projected facts are exactly the durable ones the ACP v1 schema can
 * represent losslessly:
 *
 * - `user/message` with the official HUMAN `source.kind:'user'` discriminant,
 * - `assistant/message` ordered text/thought/image/file blocks,
 * - `tool/call` and `tool/result` ordered text/image/file content,
 * - `todo/write` as the complete plan replacement,
 * - `compaction/start|summary|end` keyed by their durable `compactionId`.
 *
 * Any other durable event type is Host-internal and is never projected; a
 * committed block that has no standard ACP v1 form fails the whole projection
 * closed rather than being silently dropped (a partial replay must never be
 * reported as complete).
 *
 * @module app/remote-process/local-acp-projections
 */

import { constants as bufferConstants } from 'node:buffer'
import type { PlanEntry, PlanEntryStatus, SessionUpdate } from '@agentclientprotocol/sdk'
import type { AcpStoredFileRef, AcpStoredImageRef } from './local-acp-session-view.ts'

/** The fixed context-window occupancy a `usage_update` needs from the official projections. */
export interface AcpContextPressureFacts {
  readonly projectedTokens?: unknown
  readonly pressureTokens?: unknown
  readonly contextWindow?: unknown
}

/** One authorized Session-list row read from the official Host corpus. */
export interface AcpSessionReadRow {
  readonly sessionId: string
  /** The official absolute Session cwd; a row without one is never projected. */
  readonly cwd?: string
  /** Official last-activity milliseconds (`SessionSummary.updatedAt`). */
  readonly updatedAt: number
  /** The official durable title fold, when the Host could prove one. */
  readonly title?: string
  /** The official subagent classification; such a Session is never a root row. */
  readonly origin?: 'subagent'
}

/** One detached durable Session event read from the official canonical log. */
export interface AcpHistoryEvent {
  readonly seq: number
  readonly type: string
  readonly data: unknown
  /** The event's own durable time (epoch ms), when the log recorded one. */
  readonly time?: number
}

/** The official header facts a loaded Session carries. */
export interface AcpHistoryHeader {
  readonly sessionId: string
  readonly cwd?: string
  readonly origin?: 'subagent'
  readonly parentSessionId?: string
}

/** One valid canonical Session history, already replay-validated by the official query. */
export interface AcpSessionHistory {
  readonly header: AcpHistoryHeader
  readonly events: readonly AcpHistoryEvent[]
}

/** The client capabilities this connection froze at `initialize`. */
export interface AcpNegotiatedCapabilities {
  readonly plan: boolean
  readonly compaction: boolean
  readonly subagents: boolean
  readonly notices: boolean
  /**
   * Whether this connection advertised support for boolean session config
   * options (`clientCapabilities.session.configOptions.boolean`). Only such a
   * connection is ever offered the Agent Team boolean row or may write it.
   */
  readonly booleanConfigOptions: boolean
}

/** One image the ordered tail must read through the official Attachment Store. */
export interface AcpHistoryImage {
  readonly messageId: string
  readonly sessionUpdate: 'user_message_chunk' | 'agent_message_chunk'
  readonly ref: AcpStoredImageRef
}

/**
 * One committed generic file the ordered tail must read through the official
 * Attachment Store before it can become the standard ACP `resource` block.
 */
export interface AcpHistoryFile {
  readonly messageId: string
  readonly sessionUpdate: 'user_message_chunk' | 'agent_message_chunk'
  readonly ref: AcpStoredFileRef
}

/** One tool result whose ordered content may still need verified images/files. */
export interface AcpHistoryToolResult {
  readonly toolCallId: string
  readonly status: 'completed' | 'failed'
  readonly content: readonly (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly ref: AcpStoredImageRef }
    | { readonly type: 'file'; readonly ref: AcpStoredFileRef }
  )[]
}

/**
 * One atomic replay step. Direct updates are already complete; image/file steps
 * are resolved through the official Store INSIDE the caller's ordered tail, so
 * the converted event keeps its place in the FIFO.
 */
export type AcpHistoryUnit =
  | { readonly kind: 'update'; readonly update: SessionUpdate }
  | { readonly kind: 'image'; readonly image: AcpHistoryImage }
  | { readonly kind: 'file'; readonly file: AcpHistoryFile }
  | { readonly kind: 'tool-result'; readonly result: AcpHistoryToolResult }
  | { readonly kind: 'session-message'; readonly message: AcpHistoryAgentMessage }
  /**
   * The official `turn/start` reset of the standing `todos` projection. The
   * View removes an ALREADY announced plan; an empty one has nothing to remove
   * (the official null means "no active plan", not "unavailable").
   */
  | { readonly kind: 'plan-reset' }

/** One durable inter-agent message replayed as a standard `session_message`. */
export interface AcpHistoryAgentMessage {
  readonly messageId: string
  /** The official durable author Session id. */
  readonly senderSessionId: string
  readonly content: readonly (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly ref: AcpStoredImageRef }
    | { readonly type: 'file'; readonly ref: AcpStoredFileRef }
  )[]
}

/** The stable projection classifications (mapped onto the View error boundary). */
export type AcpProjectionErrorCode =
  /** The canonical log's seq order was not strictly increasing. */
  | 'LOCAL_ACP_LOAD_INVALID_HISTORY'
  /** A committed block has no standard ACP v1 form (never truncated). */
  | 'LOCAL_ACP_LOAD_UNSUPPORTED_CONTENT'
  /**
   * One event's generic-file Base64 budget exceeds the connection's frozen
   * output frame budget, or no valid budget is bound for a file-bearing event.
   * This is an adapter materialization refusal, never a transport write.
   */
  | 'LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE'

/** One classified projection refusal; it never carries content or a path. */
export class AcpProjectionError extends Error {
  readonly code: AcpProjectionErrorCode

  constructor(code: AcpProjectionErrorCode, message: string) {
    super(message)
    this.name = 'AcpProjectionError'
    this.code = code
  }
}

/** The fixed presentation priority of one ACP plan entry (DSH records none). */
const PLAN_ENTRY_PRIORITY = 'medium' as const
/** One page of `session/list` results. */
export const ACP_SESSION_LIST_PAGE_SIZE = 50
/** The longest accepted opaque list cursor, in characters. */
export const ACP_SESSION_LIST_CURSOR_MAX = 768

/** One strictly validated `session/list` request. */
export interface AcpSessionListRequest {
  readonly cwd?: string
  readonly cursor?: string
}

/** One emitted `session/list` page. */
export interface AcpSessionListPage {
  readonly sessions: readonly {
    readonly sessionId: string
    readonly cwd: string
    readonly title?: string
    readonly updatedAt: string
  }[]
  readonly nextCursor?: string
}

/** One decoded list cursor: the keyset position AND the filter it was bound to. */
interface SessionListCursor {
  readonly updatedAt: number
  readonly sessionId: string
  readonly cwd: string
}

/** One validated plan entry from the official whole-list `todo/write` snapshot. */
interface TodoFacts {
  readonly content: string
  readonly status: PlanEntryStatus
}

/**
 * Project one canonical Session log into standard ACP v1 replay steps.
 *
 * The complete log is validated and converted BEFORE the caller sends any
 * notification: a strictly increasing seq order is required, and a committed
 * block with no standard v1 form refuses the whole history instead of
 * producing a partial replay. Every event that carries generic file content is
 * bounded as ONE event (`maxOutputFrameBytes` is the connection's frozen
 * single-frame budget), BEFORE the caller starts any Store read.
 * `inheritedEventCount` is not consumed here — the official `readSession`
 * already returns the complete replay-validated log.
 *
 * @param events - the official canonical events in ascending seq order.
 * @param capabilities - the capabilities frozen at `initialize`.
 * @param sessionId - the exact Session the replayed plan id is bound to.
 * @param maxOutputFrameBytes - the connection's frozen single-frame budget.
 * @returns the ordered replay steps.
 * @throws {AcpProjectionError} when the seq order is invalid, a committed
 *   block has no standard ACP v1 projection, or an event's file content cannot
 *   fit this connection's materialization budget.
 */
export function projectSessionHistory(
  events: readonly AcpHistoryEvent[],
  capabilities: AcpNegotiatedCapabilities,
  sessionId = '',
  maxOutputFrameBytes?: number,
): readonly AcpHistoryUnit[] {
  const units: AcpHistoryUnit[] = []
  let previousSeq = -1
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq <= previousSeq) {
      throw new AcpProjectionError(
        'LOCAL_ACP_LOAD_INVALID_HISTORY',
        'the canonical Session log is not in strictly increasing seq order',
      )
    }
    previousSeq = event.seq
    projectHistoryEvent(event, capabilities, sessionId, units, maxOutputFrameBytes)
  }
  return units
}

/** Convert ONE durable event into its ordered steps (or nothing). */
function projectHistoryEvent(
  event: AcpHistoryEvent,
  capabilities: AcpNegotiatedCapabilities,
  sessionId: string,
  units: AcpHistoryUnit[],
  maxOutputFrameBytes: number | undefined,
): void {
  const files: AcpStoredFileRef[] = []
  const firstUnit = units.length
  switch (event.type) {
    case 'user/message':
      projectUserMessage(event.data, capabilities, units, files)
      break
    case 'assistant/message':
      projectAssistantMessage(event.data, units, files)
      break
    case 'tool/call':
      projectToolCall(event.data, units)
      break
    case 'tool/result':
      projectToolResult(event.data, units, files)
      break
    case 'turn/start':
      // The official `todos` fold resets to null at every turn start; the View
      // owns whether a plan was announced and therefore needs removal.
      units.push({ kind: 'plan-reset' })
      break
    case 'todo/write': {
      const entries = planEntriesOf(event.data)
      if (entries === undefined) throw unsupportedBlock()
      units.push({ kind: 'update', update: planUpdate(entries, capabilities.plan, sessionId) })
      break
    }
    case 'compaction/start':
    case 'compaction/summary':
    case 'compaction/end': {
      if (!capabilities.compaction) break
      const update = compactionUpdate(event)
      units.push({ kind: 'update', update })
      break
    }
    default:
      // Host-internal durable records (turns, steps, request headers, system
      // prompts, developer tool changes, titles, attempts, seed markers,
      // projections and plugin records) never carry ACP-visible message
      // content and are never projected as one.
      break
  }
  // ONE event equals ONE budget: every file occurrence of this event, in wire
  // order, counts (a repeated reference is two payload occurrences). Tool
  // results and inter-agent messages become ONE ACP update, so their blobs must
  // also fit one JS string; message-chunk events remain separate frames.
  const singleFrame = units.slice(firstUnit).some(unit =>
    unit.kind === 'tool-result' || unit.kind === 'session-message')
  assertFileBudget(files, maxOutputFrameBytes, singleFrame)
}

/**
 * Project one durable `user/message`. Its event data IS the official message
 * (id/source/content).
 *
 * - ONLY the official HUMAN discriminant is a user utterance: every Host/plugin
 *   injection (`time-context`, `skill-invocation`, …) is context and a
 *   `user-question-reply` is a continued action, so neither becomes a new user
 *   prompt.
 * - A durable `agent-message` is an inter-agent message: it replays as the
 *   standard `session_message` with its real author, exactly like the live
 *   projection, and only for a client that negotiated the `subagents`
 *   capability. The runtime's `subagent-settled` account is never child words.
 * - Every other source kind is Host-internal context and projects nothing.
 */
function projectUserMessage(
  data: unknown,
  capabilities: AcpNegotiatedCapabilities,
  units: AcpHistoryUnit[],
  files: AcpStoredFileRef[],
): void {
  const message = bareMessageOf(data)
  if (message === undefined) throw unsupportedBlock()
  if (message.source?.kind === 'user') {
    projectMessageBlocks(message, units, 'user_message_chunk', false, files)
    return
  }
  if (!capabilities.subagents) return
  const agentMessage = durableAgentMessageOf(data)
  if (agentMessage === undefined) return
  // An inter-agent message's files are NOT charged here: the View first has to
  // prove the author from official headers. An unproven message must produce
  // no diagnostic and no Store read regardless of its file size; a proven one
  // is charged by the shared session-message path before its association and
  // first read.
  units.push({ kind: 'session-message', message: agentMessage })
}

/**
 * The official `agent-message` facts of one durable user message, or `undefined`
 * when this message is not an inter-agent message. Unsupported content throws
 * the same fail-closed projection error the rest of the history conversion uses.
 */
export function durableAgentMessageOf(data: unknown): AcpHistoryAgentMessage | undefined {
  const message = bareMessageOf(data)
  if (message === undefined) throw unsupportedBlock()
  const senderSessionId = message.source?.senderSessionId
  if (message.source?.kind !== 'agent-message' || typeof senderSessionId !== 'string') return undefined
  return agentMessageOf(message, senderSessionId)
}

/** The official `agent-message` facts of one durable user message. */
function agentMessageOf(
  message: { readonly id: string; readonly content: readonly unknown[] },
  senderSessionId: string,
): AcpHistoryAgentMessage {
  const content: (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly ref: AcpStoredImageRef }
    | { readonly type: 'file'; readonly ref: AcpStoredFileRef }
  )[] = []
  for (const block of message.content) {
    const type = (block as { readonly type?: unknown } | null)?.type
    if (type === 'text') {
      const text = (block as { readonly text?: unknown } | null)?.text
      if (typeof text !== 'string') throw unsupportedBlock()
      if (text.length > 0) content.push({ type: 'text', text })
      continue
    }
    if (type === 'image') {
      content.push({ type: 'image', ref: imageRef(block) })
      continue
    }
    if (type === 'file') {
      content.push({ type: 'file', ref: fileRef(block) })
      continue
    }
    throw unsupportedBlock()
  }
  return { messageId: message.id, senderSessionId, content }
}

/** The official message-shaped event data (`user/message` carries it directly). */
function bareMessageOf(data: unknown): {
  readonly id: string
  readonly source?: { readonly kind?: unknown; readonly senderSessionId?: unknown }
  readonly content: readonly unknown[]
} | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const id = (data as { readonly id?: unknown }).id
  const content = (data as { readonly content?: unknown }).content
  if (typeof id !== 'string' || id.length === 0 || !Array.isArray(content)) return undefined
  const source = (data as { readonly source?: { readonly kind?: unknown } }).source
  return { id, ...(source === undefined ? {} : { source }), content }
}

/** Project one durable `assistant/message` (its data WRAPS the message) in committed block order. */
function projectAssistantMessage(data: unknown, units: AcpHistoryUnit[], files: AcpStoredFileRef[]): void {
  // `assistant/message` data carries turn/step/message/stream/usage; only the
  // nested message is model-visible content.
  const message = messageOf(data)
  if (message === undefined) throw unsupportedBlock()
  projectMessageBlocks(message, units, 'agent_message_chunk', true, files)
}

/** One durable message with a nonempty id, an optional source tag and content blocks. */
function messageOf(data: unknown): {
  readonly id: string
  readonly source?: { readonly kind?: unknown }
  readonly content: readonly unknown[]
} | undefined {
  const message = (data as { readonly message?: unknown } | null)?.message
  if (message === null || typeof message !== 'object') return undefined
  const id = (message as { readonly id?: unknown }).id
  const content = (message as { readonly content?: unknown }).content
  if (typeof id !== 'string' || id.length === 0 || !Array.isArray(content)) return undefined
  const source = (message as { readonly source?: { readonly kind?: unknown } }).source
  return { id, ...(source === undefined ? {} : { source }), content }
}

/**
 * Convert one message's committed blocks. Empty text/thought blocks project
 * nothing (they are not visible content); a `tool-call` block is skipped
 * because the dedicated durable `tool/call` event is the projection source;
 * image and generic file blocks are deferred to the official Store; every
 * other block type has no standard ACP v1 form and fails closed.
 */
function projectMessageBlocks(
  message: { readonly id: string; readonly content: readonly unknown[] },
  units: AcpHistoryUnit[],
  textKind: 'user_message_chunk' | 'agent_message_chunk',
  allowThought: boolean,
  files: AcpStoredFileRef[],
): void {
  for (const block of message.content) {
    const type = (block as { readonly type?: unknown } | null)?.type
    if (type === 'text' || (allowThought && type === 'reasoning')) {
      const text = (block as { readonly text?: unknown } | null)?.text
      if (typeof text !== 'string') throw unsupportedBlock()
      if (text.length === 0) continue
      units.push({
        kind: 'update',
        update: {
          sessionUpdate: type === 'text' ? textKind : 'agent_thought_chunk',
          messageId: message.id,
          content: { type: 'text', text },
        },
      })
      continue
    }
    if (type === 'image') {
      units.push({
        kind: 'image',
        image: { messageId: message.id, sessionUpdate: textKind, ref: imageRef(block) },
      })
      continue
    }
    if (type === 'file') {
      const ref = fileRef(block)
      files.push(ref)
      units.push({
        kind: 'file',
        file: { messageId: message.id, sessionUpdate: textKind, ref },
      })
      continue
    }
    if (type === 'tool-call') continue
    throw unsupportedBlock()
  }
}

/** Project one durable tool call as the standard start update. */
function projectToolCall(data: unknown, units: AcpHistoryUnit[]): void {
  const call = data as { readonly callId?: unknown; readonly name?: unknown; readonly arguments?: unknown }
  if (typeof call.callId !== 'string' || typeof call.name !== 'string') throw unsupportedBlock()
  const rawInput = typeof call.arguments === 'string' ? parseToolArguments(call.arguments) : undefined
  units.push({
    kind: 'update',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: call.callId,
      title: call.name,
      kind: 'other',
      status: 'in_progress',
      ...(rawInput === undefined ? {} : { rawInput }),
    },
  })
}

/** Project one durable tool result as ONE ordered `tool_call_update`. */
function projectToolResult(data: unknown, units: AcpHistoryUnit[], files: AcpStoredFileRef[]): void {
  const message = (data as {
    readonly message?: {
      readonly toolCallId?: unknown
      readonly isError?: unknown
      readonly content?: unknown
    }
  } | null)?.message
  if (message === undefined || typeof message.toolCallId !== 'string' || !Array.isArray(message.content)) {
    throw unsupportedBlock()
  }
  const content: (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly ref: AcpStoredImageRef }
    | { readonly type: 'file'; readonly ref: AcpStoredFileRef }
  )[] = []
  for (const block of message.content as readonly unknown[]) {
    const type = (block as { readonly type?: unknown } | null)?.type
    if (type === 'text') {
      const text = (block as { readonly text?: unknown } | null)?.text
      if (typeof text !== 'string') throw unsupportedBlock()
      if (text.length > 0) content.push({ type: 'text', text })
      continue
    }
    if (type === 'image') {
      content.push({ type: 'image', ref: imageRef(block) })
      continue
    }
    if (type === 'file') {
      const ref = fileRef(block)
      files.push(ref)
      content.push({ type: 'file', ref })
      continue
    }
    throw unsupportedBlock()
  }
  units.push({
    kind: 'tool-result',
    result: {
      toolCallId: message.toolCallId,
      status: message.isError === true ? 'failed' : 'completed',
      content,
    },
  })
}

/**
 * The ACP plan for one official whole-list `todo/write` snapshot, or
 * `undefined` when the snapshot is not a valid todo list. DSH records no
 * priority, so the fixed `medium` presentation default is used and never
 * claimed to be an official priority.
 */
export function planEntriesOf(data: unknown): readonly PlanEntry[] | undefined {
  return planEntriesFromTodos((data as { readonly todos?: unknown } | null)?.todos)
}

/**
 * The ACP plan for one official `todos` projection value (the bare list).
 * `null` (no write yet) and every invalid value yield `undefined`; an empty
 * list is a real clear and yields no entries.
 *
 * @param todos - the official projection value.
 * @returns the complete entry list, or undefined when no list is provable.
 */
export function planEntriesFromTodos(todos: unknown): readonly PlanEntry[] | undefined {
  if (!Array.isArray(todos)) return undefined
  const entries: PlanEntry[] = []
  for (const todo of todos) {
    const content = (todo as { readonly content?: unknown } | null)?.content
    const status = (todo as { readonly status?: unknown } | null)?.status
    if (typeof content !== 'string' || !isPlanStatus(status)) return undefined
    entries.push({ content, status, priority: PLAN_ENTRY_PRIORITY })
  }
  return entries
}

/** The fixed three-state plan lifecycle the official todo list carries. */
function isPlanStatus(value: unknown): value is PlanEntryStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

/**
 * The one plan replacement update for one exact Session: the stable baseline
 * `plan` for a client without the `plan_update` capability, and the negotiated
 * `plan_update` (one stable planId) for a client that declared it. A REMOVAL is
 * not a `todo/write`: the official `todos` fold resets to null at every
 * `turn/start`, and `planRemoval` below is the only path that emits
 * `plan_removed` (an empty whole-list replacement for the baseline client).
 *
 * @param entries - the complete official entry list (empty is a real clear).
 * @param negotiated - whether the client froze `clientCapabilities.plan`.
 * @param sessionId - the exact Session the plan belongs to.
 * @returns the single replacement update.
 */
export function planUpdate(entries: readonly PlanEntry[], negotiated: boolean, sessionId = ''): SessionUpdate {
  if (!negotiated) return { sessionUpdate: 'plan', entries: [...entries] }
  return {
    sessionUpdate: 'plan_update',
    plan: { type: 'items', planId: planIdOf(sessionId), entries: [...entries] },
  }
}

/**
 * The removal of an ALREADY announced plan when the official `todos` projection
 * resets at the next `turn/start`. A negotiated client gets the stable
 * `plan_removed` for the exact plan id; a baseline client gets the same
 * complete replacement with zero entries (the legacy `plan` is whole-list).
 */
export function planRemoval(negotiated: boolean, sessionId = ''): SessionUpdate {
  if (!negotiated) return { sessionUpdate: 'plan', entries: [] }
  return { sessionUpdate: 'plan_removed', planId: planIdOf(sessionId) }
}

/** The stable per-Session plan identity this Host uses for `plan_update`. */
export function planIdOf(sessionId: string): string {
  return `dsh-todos:${sessionId}`
}

/**
 * Project the official `contextPressure` projection into a standard
 * `usage_update`: `used` is the current NEXT-request pressure and `size` is the
 * newest known route capacity. Both must be finite non-negative numbers with a
 * positive capacity; otherwise NO update is produced (never a fabricated 0 or
 * 100%, and never the lifetime billed token sum).
 *
 * @param value - the detached `contextPressure` projection value.
 * @returns the occupancy update, or undefined when the Host proved no value.
 */
export function usageUpdateOf(value: unknown): SessionUpdate | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const pressure = value as AcpContextPressureFacts
  const used = typeof pressure.projectedTokens === 'number'
    ? pressure.projectedTokens
    : pressure.pressureTokens
  const size = pressure.contextWindow
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return undefined
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return undefined
  return { sessionUpdate: 'usage_update', used, size }
}

/**
 * Project one durable `session/title` event into a field-level
 * `session_info_update`. The title AND its activity time come from the same
 * official durable event, so no `Date.now()` value is ever invented; when the
 * caller has no durable event time the title is sent WITHOUT a time.
 *
 * @param data - the `session/title` event data.
 * @param time - the event's own durable time in epoch milliseconds, if known.
 * @returns the info update, or undefined when the event carries no title.
 */
export function sessionInfoUpdateOf(data: unknown, time?: number): SessionUpdate | undefined {
  const title = (data as { readonly title?: unknown } | null)?.title
  if (typeof title !== 'string' || title.length === 0) return undefined
  if (time === undefined || !Number.isSafeInteger(time) || time < 0) {
    return { sessionUpdate: 'session_info_update', title }
  }
  return { sessionUpdate: 'session_info_update', title, updatedAt: new Date(time).toISOString() }
}

/** One durable compaction event's data. */
interface CompactionFacts {
  readonly compactionId: string
  readonly summary?: unknown
  readonly error?: unknown
}

/**
 * Project ONE durable `compaction/*` event into its exact `compaction_update`
 * patch. `start` opens `in_progress`, `summary` replaces the complete summary
 * content, and `end` is `failed` only when the official record carried an
 * error. No `compaction_summary_chunk` is ever produced (the Host has no
 * streaming summary producer) and a cancelled compaction has no official state.
 *
 * @param event - the durable compaction event (type + data).
 * @returns the lifecycle patch.
 */
export function compactionUpdate(event: AcpHistoryEvent): SessionUpdate {
  const data = event.data as CompactionFacts | null
  const compactionId = data?.compactionId
  if (typeof compactionId !== 'string' || compactionId.length === 0) throw unsupportedBlock()
  if (event.type === 'compaction/start') {
    return { sessionUpdate: 'compaction_update', compactionId, status: 'in_progress' }
  }
  if (event.type === 'compaction/summary') {
    return {
      sessionUpdate: 'compaction_update',
      compactionId,
      status: 'in_progress',
      summary: [...summaryBlocks(data?.summary)],
    }
  }
  const error = data?.error
  return {
    sessionUpdate: 'compaction_update',
    compactionId,
    status: typeof error === 'string' && error.length > 0 ? 'failed' : 'completed',
    ...(typeof error === 'string' && error.length > 0 ? { error } : {}),
  }
}

/** The complete replacement summary content; only text blocks are representable. */
function summaryBlocks(summary: unknown): readonly { readonly type: 'text'; readonly text: string }[] {
  if (!Array.isArray(summary)) throw unsupportedBlock()
  const blocks: { readonly type: 'text'; readonly text: string }[] = []
  for (const block of summary) {
    const type = (block as { readonly type?: unknown } | null)?.type
    if (type !== 'text') throw unsupportedBlock()
    const text = (block as { readonly text?: unknown } | null)?.text
    if (typeof text !== 'string') throw unsupportedBlock()
    if (text.length > 0) blocks.push({ type: 'text', text })
  }
  return blocks
}

/**
 * Select ONE deterministic `session/list` page from the official authorized
 * roster.
 *
 * Visibility: only ROOT Sessions (`origin !== 'subagent'`) with a standard
 * absolute cwd are emitted; a row that cannot prove an absolute cwd is never
 * represented by a fabricated entry. Ordering is `(updatedAt DESC, sessionId
 * UTF8 ASC)`, the cursor is the canonical Base64URL keyset of the SAME filter,
 * and a page carries `nextCursor` only when more authorized rows remain.
 * Pagination continues on the CURRENT roster snapshot: it is a keyset
 * continuation, not a transaction.
 *
 * @param rows - the authorized Host roster.
 * @param request - the strictly validated ACP request.
 * @returns one page (possibly empty).
 */
export function selectSessionPage(
  rows: readonly AcpSessionReadRow[],
  request: AcpSessionListRequest,
): AcpSessionListPage {
  const filterCwd = request.cwd ?? ''
  const cursor = request.cursor === undefined
    ? undefined
    : decodeSessionCursor(request.cursor, filterCwd)
  const visible = rows
    .filter(row => row.origin !== 'subagent')
    .filter(row => isAbsolutePath(row.cwd))
    .filter(row => filterCwd === '' || row.cwd === filterCwd)
    .sort(compareSessionRows)
  const start = cursor === undefined
    ? 0
    : visible.findIndex(row => compareSessionRowToCursor(row, cursor) > 0)
  const from = start === -1 ? visible.length : start
  const page = visible.slice(from, from + ACP_SESSION_LIST_PAGE_SIZE)
  const sessions = page.map(row => ({
    sessionId: row.sessionId,
    cwd: row.cwd as string,
    ...(row.title === undefined ? {} : { title: row.title }),
    updatedAt: new Date(row.updatedAt).toISOString(),
  }))
  const last = page[page.length - 1]
  const nextCursor = visible.length > from + page.length && last !== undefined
    ? encodeSessionCursor({ updatedAt: last.updatedAt, sessionId: last.sessionId, cwd: filterCwd })
    : undefined
  return { sessions, ...(nextCursor === undefined ? {} : { nextCursor }) }
}

/** `(updatedAt DESC, sessionId UTF8 ASC)` — the frozen list order. */
function compareSessionRows(left: AcpSessionReadRow, right: AcpSessionReadRow): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  return compareUtf8(left.sessionId, right.sessionId)
}

/** Whether one row sorts AFTER the keyset position (the cursor's own row is never re-emitted). */
function compareSessionRowToCursor(row: AcpSessionReadRow, cursor: SessionListCursor): number {
  if (row.updatedAt !== cursor.updatedAt) return cursor.updatedAt - row.updatedAt
  return compareUtf8(row.sessionId, cursor.sessionId)
}

/** Byte-wise UTF-8 comparison (never locale-dependent). */
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/**
 * Encode the canonical opaque keyset cursor: Base64URL of the compact JSON
 * array `[updatedAt, sessionId, cwdOrEmpty]`.
 */
export function encodeSessionCursor(cursor: SessionListCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.sessionId, cursor.cwd]), 'utf8').toString('base64url')
}

/**
 * Strictly decode one opaque cursor against the SAME request cwd filter.
 * Exactly a three-element array, a non-negative safe-integer activity time, a
 * non-empty session id, the identical filter identity, a bounded length and
 * the canonical Base64URL/JSON re-encoding are accepted; anything else is the
 * caller's `-32602` invalid request (never a silently ignored page position).
 *
 * @param raw - the client-supplied cursor.
 * @param filterCwd - the request's own cwd filter (or `''`).
 * @returns the validated keyset position.
 * @throws {Error} when the cursor is malformed or bound to another filter.
 */
function decodeSessionCursor(raw: string, filterCwd: string): SessionListCursor {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > ACP_SESSION_LIST_CURSOR_MAX) {
    throw new Error('acp session list: invalid cursor length')
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(raw)) throw new Error('acp session list: invalid cursor alphabet')
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new Error('acp session list: invalid cursor payload')
  }
  if (!Array.isArray(decoded) || decoded.length !== 3) throw new Error('acp session list: invalid cursor shape')
  const [updatedAt, sessionId, cwd] = decoded as unknown[]
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error('acp session list: invalid cursor activity time')
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('acp session list: invalid cursor session')
  if (typeof cwd !== 'string' || cwd !== filterCwd) throw new Error('acp session list: cursor filter mismatch')
  const cursor: SessionListCursor = { updatedAt, sessionId, cwd }
  // Canonical form only: a re-encoded cursor must equal the client's bytes, so
  // an accepted cursor can never be ambiguous.
  if (encodeSessionCursor(cursor) !== raw) throw new Error('acp session list: non-canonical cursor')
  return cursor
}

/**
 * Validate the `session/list` request surface: an omitted or null cwd means
 * "every authorized root", and a supplied cwd must be a standard absolute path
 * with no NUL. An omitted or null cursor means the first page.
 *
 * @param params - the SDK-typed request params.
 * @returns the validated request facts.
 * @throws {Error} when the request is not representable.
 */
export function readSessionListRequest(params: {
  readonly cwd?: string | null
  readonly cursor?: string | null
}): AcpSessionListRequest {
  const cwd = params.cwd ?? undefined
  if (cwd !== undefined && !isAbsolutePath(cwd)) throw new Error('acp session list: cwd must be an absolute path')
  const cursor = params.cursor ?? undefined
  if (cursor !== undefined && typeof cursor !== 'string') throw new Error('acp session list: cursor must be a string')
  return { ...(cwd === undefined ? {} : { cwd }), ...(cursor === undefined ? {} : { cursor }) }
}

/** A standard absolute path: non-empty, rooted and containing no NUL. */
export function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.startsWith('/') && !value.includes('\u0000')
}

/** The structural official image attachment of one committed image block. */
export function imageRef(block: unknown): AcpStoredImageRef {
  const attachment = (block as { readonly attachment?: unknown } | null)?.attachment
  if (attachment === null || typeof attachment !== 'object') throw unsupportedBlock()
  const ref = attachment as Record<string, unknown>
  if (typeof ref.attachmentId !== 'string' || ref.attachmentId.length === 0
    || typeof ref.mediaType !== 'string' || typeof ref.bytes !== 'number'
    || typeof ref.width !== 'number' || typeof ref.height !== 'number') {
    throw unsupportedBlock()
  }
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
  }
}

/**
 * The structural official `FileAttachmentRef` of one committed file block, or
 * `undefined` when the block does not carry a legal durable file reference.
 * The official Attachment Store remains the authority that verifies the exact
 * stored leaf, bytes and digest; this only validates the reference SHAPE
 * (`sha256:<64 lowercase hex>`, a non-empty display name and a non-negative
 * safe-integer byte count).
 */
export function fileAttachmentRef(block: unknown): AcpStoredFileRef | undefined {
  const attachment = (block as { readonly attachment?: unknown } | null)?.attachment
  if (attachment === null || typeof attachment !== 'object') return undefined
  const ref = attachment as Record<string, unknown>
  if (typeof ref.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(ref.attachmentId)
    || typeof ref.name !== 'string' || ref.name.length === 0
    || typeof ref.bytes !== 'number' || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
    return undefined
  }
  return { attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes }
}

/** The strict history-conversion form of one committed file reference. */
function fileRef(block: unknown): AcpStoredFileRef {
  const ref = fileAttachmentRef(block)
  if (ref === undefined) throw unsupportedBlock()
  return ref
}

/**
 * Enforce ONE event's generic-file materialization budget: the sum of every
 * file occurrence's canonical Base64 length must fit the connection's frozen
 * single-frame budget. Occurrences are counted in wire order (a repeated
 * reference costs its payload twice), and the running subtraction never
 * overflows. A file-bearing event without a valid positive budget is refused
 * instead of reading an unbounded stream.
 *
 * The budget alone is not sufficient: it derives from the official image
 * limits and may exceed Node's single-string capacity. Every raw Buffer and
 * every encoded blob must be representable, and a `singleFrame` event (one
 * tool result or one inter-agent message) serializes all its blobs into ONE
 * JSON string, so their total must be representable too. Separate
 * message-chunk frames are checked per blob and do not sum.
 *
 * @param files - every file occurrence of one event, in wire order.
 * @param maxOutputFrameBytes - the connection's frozen frame budget.
 * @param singleFrame - whether this event's file blobs share one ACP update.
 * @throws {AcpProjectionError} with `LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE`.
 */
export function assertFileBudget(
  files: readonly AcpStoredFileRef[],
  maxOutputFrameBytes: number | undefined,
  singleFrame: boolean,
): void {
  if (files.length === 0) return
  if (maxOutputFrameBytes === undefined
    || !Number.isSafeInteger(maxOutputFrameBytes) || maxOutputFrameBytes <= 0) {
    throw frameTooLarge()
  }
  let remaining = maxOutputFrameBytes
  let encodedTotal = 0
  for (const file of files) {
    const encoded = 4 * Math.ceil(file.bytes / 3)
    if (!Number.isSafeInteger(encoded) || encoded > remaining
      || file.bytes > bufferConstants.MAX_LENGTH
      || encoded > bufferConstants.MAX_STRING_LENGTH) {
      throw frameTooLarge()
    }
    remaining -= encoded
    encodedTotal += encoded
  }
  if (singleFrame && encodedTotal > bufferConstants.MAX_STRING_LENGTH) throw frameTooLarge()
}

/** Preserve malformed model tool arguments as opaque input instead of dropping them. */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

/** One stable "this committed block has no standard ACP v1 form" refusal. */
function unsupportedBlock(): AcpProjectionError {
  return new AcpProjectionError(
    'LOCAL_ACP_LOAD_UNSUPPORTED_CONTENT',
    'a committed Session block has no standard ACP v1 projection',
  )
}

/** One stable "this event's file content cannot be materialized" refusal. */
function frameTooLarge(): AcpProjectionError {
  return new AcpProjectionError(
    'LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE',
    'a committed event file payload cannot be represented in one output frame',
  )
}
