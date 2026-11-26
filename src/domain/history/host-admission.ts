/**
 * Pure Host-admission fold for the private Host accepted-input history search.
 *
 * The DSH Session log is the only durable authority for a prompt that the Host
 * actually accepted. This module turns raw rc.5 Session events into the
 * occurrence identity the Host derives:
 *
 * ```text
 * agent/inbox/spliced.inserted[]  or  user/message
 *   -> official source.kind === 'user'
 *   -> first event per message.id is ONE accepted occurrence
 *   -> event-time effective cwd folded from SessionHeader.cwd and
 *      working-directory/change
 * ```
 *
 * `source.kind` alone is the producer authority: request correlation (`rpcId`),
 * principal, time zone and presentation metadata never decide admission. An
 * unreadable required payload of an explicit user message fails the source
 * read instead of being silently dropped; a non-user producer is excluded
 * before its body is parsed.
 *
 * It is transport/UI/Cordis-neutral: no Host Context, no TUI and no storage
 * access. Later queue edit/consume/remove/steer events never rewrite or delete
 * the first accepted occurrence; a later same-id event with different content
 * only increments the edit diagnostic. Fork-inherited events are folded for
 * cwd but never create a child occurrence.
 *
 * @module @xmoon76/dsh-pi-tui/domain/history/host-admission
 */

import { isAbsolute, normalize } from 'node:path'

/** One raw Session event in the minimal structural shape this fold reads. */
export interface HostAdmissionEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** One content block's structural text discriminator. */
interface ContentBlockLike {
  readonly type: string
  readonly text?: string
}

/** One accepted user message's structural shape (never a Host/Client object). */
interface HostAdmissionMessageLike {
  readonly id: string
  readonly content: readonly ContentBlockLike[]
}

/** One accepted prompt occurrence as the Host derives it. */
export interface HostAdmissionOccurrence {
  readonly sessionId: string
  readonly messageId: string
  /** First event seq that proved acceptance (internal tie-break/audit). */
  readonly firstEventSeq: number
  /** First accepted text projection (text blocks joined by a newline). */
  readonly content: string
  /** Host first-admission event time (Unix epoch milliseconds). */
  readonly acceptedAt: number
  /** Effective event-time cwd; `null` when no directory fact was known. */
  readonly cwd: string | null
  /** Whether the accepted message carried any non-text content block. */
  readonly hasNonText: boolean
}

/** The immutable result of folding one Session. */
export interface HostAdmissionSnapshot {
  readonly occurrences: readonly HostAdmissionOccurrence[]
  /** Later same-id events whose content differs from the first acceptance. */
  readonly editedOccurrences: number
}

/** One incremental fold step's newly observed evidence. */
export interface HostAdmissionDelta {
  readonly occurrences: readonly HostAdmissionOccurrence[]
  readonly editedOccurrences: number
}

export interface HostAdmissionFoldOptions {
  readonly sessionId: string
  /** Initial effective directory fact; absent or `null` means unknown. */
  readonly initialCwd?: string | null
  /** Exact fork-inherited event count: events before this seq never accept a prompt. */
  readonly inheritedEventCount: number
  /**
   * Last sequence already committed by the caller, or `-1` for a fresh fold.
   * Events at or before this seq are ignored so a live/persisted merge can
   * safely re-apply an overlap.
   */
  readonly startSeq?: number
}

/**
 * An official event of a recognized accepted-input shape carried a required
 * payload the fold cannot project (`user/message` or inbox insertion). The
 * whole source read must fail closed: silently skipping it would report a
 * complete corpus that omitted accepted input.
 */
class HostAdmissionPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostAdmissionPayloadError'
  }
}

/** Normalize one event-time cwd for storage/aggregation (never realpath). */
export function normalizeHistoryCwd(cwd: string | null | undefined): string | null {
  if (typeof cwd !== 'string' || cwd === '') return null
  return normalize(cwd)
}

/** Mutable per-occurrence evidence (first acceptance only). */
interface MutableOccurrence {
  readonly sessionId: string
  readonly messageId: string
  readonly firstEventSeq: number
  readonly content: string
  readonly contentSignature: string
  readonly acceptedAt: number
  readonly cwd: string | null
  readonly hasNonText: boolean
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Read one explicit user message; a non-user producer (including a missing or
 * future source kind) returns `undefined` BEFORE its body is parsed. A
 * malformed required payload of an explicit user source throws.
 */
function readUserMessage(value: unknown): HostAdmissionMessageLike | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const source = recordOf(record.source)
  if (source?.kind !== 'user') return undefined
  const id = record.id
  if (typeof id !== 'string' || id === '') {
    throw new HostAdmissionPayloadError('an accepted user message has no message id')
  }
  const content = record.content
  if (!Array.isArray(content)) {
    throw new HostAdmissionPayloadError(`accepted user message ${id} has no content array`)
  }
  const blocks: ContentBlockLike[] = []
  for (const candidate of content) {
    const block = recordOf(candidate)
    if (block === undefined || typeof block.type !== 'string') {
      throw new HostAdmissionPayloadError(`accepted user message ${id} has a malformed content block`)
    }
    if (block.type === 'text' && typeof block.text !== 'string') {
      throw new HostAdmissionPayloadError(`accepted user message ${id} has a text block without text`)
    }
    blocks.push({ type: block.type, ...(typeof block.text === 'string' ? { text: block.text } : {}) })
  }
  return { id, content: blocks }
}

/** Text projection: every text block, in order, joined by one newline. */
function textOfBlocks(blocks: readonly ContentBlockLike[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/** Whether the message carried any block that is not searchable text. */
function hasNonTextBlock(blocks: readonly ContentBlockLike[]): boolean {
  return blocks.some(block => block.type !== 'text')
}

/** Public projection of one mutable occurrence (drops the edit signature). */
function occurrenceOf(occurrence: MutableOccurrence): HostAdmissionOccurrence {
  return {
    sessionId: occurrence.sessionId,
    messageId: occurrence.messageId,
    firstEventSeq: occurrence.firstEventSeq,
    content: occurrence.content,
    acceptedAt: occurrence.acceptedAt,
    cwd: occurrence.cwd,
    hasNonText: occurrence.hasNonText,
  }
}

/**
 * Fold one Session's events into accepted occurrences.
 *
 * Events must be in ascending seq order, as the Session log guarantees. A
 * repeated seq is ignored, so a live/persisted merge can safely re-apply an
 * overlap. All events (including fork-inherited ones) fold `working-directory`
 * changes; only events at/after `inheritedEventCount` may accept a prompt.
 */
export class HostAdmissionFold {
  readonly sessionId: string
  readonly inheritedEventCount: number
  private readonly occurrences = new Map<string, MutableOccurrence>()
  private readonly newOccurrences: MutableOccurrence[] = []
  private currentCwdValue: string | null
  private lastAppliedSeq: number
  private edits = 0

  constructor(options: HostAdmissionFoldOptions) {
    if (!Number.isSafeInteger(options.inheritedEventCount) || options.inheritedEventCount < 0) {
      throw new TypeError('host-admission: inheritedEventCount must be a non-negative safe integer')
    }
    const startSeq = options.startSeq ?? -1
    if (!Number.isSafeInteger(startSeq) || startSeq < -1) {
      throw new TypeError('host-admission: startSeq must be a safe integer >= -1')
    }
    this.sessionId = options.sessionId
    this.inheritedEventCount = options.inheritedEventCount
    this.currentCwdValue = normalizeHistoryCwd(options.initialCwd)
    this.lastAppliedSeq = startSeq
  }

  /** Last applied event seq, or the initial start seq before any event. */
  get lastSeq(): number {
    return this.lastAppliedSeq
  }

  /** Effective cwd after the events applied so far. */
  get currentCwd(): string | null {
    return this.currentCwdValue
  }

  apply(events: readonly HostAdmissionEventLike[]): void {
    for (const event of events) {
      if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
        throw new TypeError('host-admission: every Session event needs a non-negative safe integer seq')
      }
      if (!Number.isSafeInteger(event.time) || event.time < 0) {
        throw new TypeError('host-admission: every Session event needs a non-negative safe integer time')
      }
      if (event.seq <= this.lastAppliedSeq) continue
      this.lastAppliedSeq = event.seq
      if (event.type === 'working-directory/change') {
        this.currentCwdValue = appliedCwdOf(event.data)
        continue
      }
      if (event.seq < this.inheritedEventCount) continue
      if (event.type === 'agent/inbox/spliced') {
        const data = recordOf(event.data)
        const inserted = data?.inserted
        if (!Array.isArray(inserted)) {
          throw new HostAdmissionPayloadError('an inbox insertion has no inserted array')
        }
        for (const candidate of inserted) {
          if (recordOf(candidate) === undefined) {
            throw new HostAdmissionPayloadError('an inbox insertion contains a non-message element')
          }
          const message = readUserMessage(candidate)
          if (message !== undefined) this.accept(message, event.time, event.seq)
        }
        continue
      }
      if (event.type === 'user/message') {
        const message = readUserMessage(event.data)
        if (message !== undefined) this.accept(message, event.time, event.seq)
      }
    }
  }

  /**
   * Return and clear the evidence observed since the previous drain. The
   * accepted occurrences are only FIRST acceptances seen by this fold; a
   * caller that persists them must still apply its own first-wins identity
   * constraint.
   */
  drainEvidence(): HostAdmissionDelta {
    const delta: HostAdmissionDelta = {
      occurrences: this.newOccurrences.splice(0).map(occurrenceOf),
      editedOccurrences: this.edits,
    }
    this.edits = 0
    return delta
  }

  snapshot(): HostAdmissionSnapshot {
    return {
      occurrences: [...this.occurrences.values()].map(occurrenceOf),
      editedOccurrences: this.edits,
    }
  }

  private accept(message: HostAdmissionMessageLike, time: number, seq: number): void {
    const existing = this.occurrences.get(message.id)
    const content = textOfBlocks(message.content)
    const signature = JSON.stringify(message.content)
    if (existing !== undefined) {
      if (existing.contentSignature !== signature) this.edits += 1
      return
    }
    const occurrence: MutableOccurrence = {
      sessionId: this.sessionId,
      messageId: message.id,
      firstEventSeq: seq,
      content,
      contentSignature: signature,
      acceptedAt: time,
      cwd: this.currentCwdValue,
      hasNonText: hasNonTextBlock(message.content),
    }
    this.occurrences.set(message.id, occurrence)
    this.newOccurrences.push(occurrence)
  }
}

/**
 * The directory fact of ONE `working-directory/change`: exactly an absolute
 * Host path is usable, normalized lexically (never realpath/stat). Any other
 * value is the explicit unknown `null`; the previous directory is not reused.
 */
function appliedCwdOf(data: unknown): string | null {
  const cwd = recordOf(data)?.cwd
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null
  return normalize(cwd)
}

/** One-shot fold helper for pure tests and small callers. */
export function classifyHostAdmission(
  options: HostAdmissionFoldOptions,
  events: readonly HostAdmissionEventLike[],
): HostAdmissionSnapshot {
  const fold = new HostAdmissionFold(options)
  fold.apply(events)
  return fold.snapshot()
}
