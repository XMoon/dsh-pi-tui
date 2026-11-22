/**
 * Pure Host-admission fold for the private Host accepted-input history search.
 *
 * The DSH Session log is the only durable authority for a prompt that the Host
 * actually accepted. This module turns raw rc.5 Session events into the
 * occurrence identity the Host derives:
 *
 * ```text
 * agent/inbox/spliced.inserted[]  or  user/message
 *   -> source.kind === 'user' AND a non-empty rpcId
 *   -> first event per message.id is ONE accepted occurrence
 *   -> event-time effective cwd folded from SessionHeader.cwd and
 *      working-directory/change
 * ```
 *
 * It is transport/UI/Cordis-neutral: no Host Context, no TUI and no storage
 * access. Later queue edit/consume/remove/steer events never rewrite or delete
 * the first accepted occurrence; a later same-id event with different content
 * only increments the edit diagnostic. Fork-inherited events are folded for
 * cwd but never create a child occurrence.
 *
 * @module @xmoon76/dsh-pi-tui/domain/history/host-admission
 */

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

/** One user message's structural shape (never a Host/Client object). */
export interface HostAdmissionMessageLike {
  readonly id: string
  readonly content: readonly ContentBlockLike[]
  readonly source?: {
    readonly kind?: string
    readonly rpcId?: string
  }
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
  /** Effective event-time cwd; `null` when the Session never proved one. */
  readonly cwd: string | null
  /** Whether the accepted message carried any non-text content block. */
  readonly hasNonText: boolean
}

/** The immutable result of folding one Session. */
export interface HostAdmissionSnapshot {
  readonly occurrences: readonly HostAdmissionOccurrence[]
  /** `source.kind:'user'` messages with no standard rpcId (incomplete evidence). */
  readonly unknownSourceCount: number
  /** Malformed `working-directory/change` events (incomplete evidence). */
  readonly invalidCwdCount: number
  /** Later same-id events whose content differs from the first acceptance. */
  readonly editedOccurrences: number
}

/** One incremental fold step's newly observed evidence. */
export interface HostAdmissionDelta {
  readonly occurrences: readonly HostAdmissionOccurrence[]
  readonly unknownSourceCount: number
  readonly invalidCwdCount: number
  readonly editedOccurrences: number
}

export interface HostAdmissionFoldOptions {
  readonly sessionId: string
  /** Initial effective directory from the durable Session header, when present. */
  readonly headerCwd?: string
  /** Exact fork-inherited event count: events before this seq never accept a prompt. */
  readonly inheritedEventCount: number
  /**
   * Last sequence already committed by the caller, or `-1` for a fresh fold.
   * Events at or before this seq are ignored so a live/persisted merge can
   * safely re-apply an overlap.
   */
  readonly startSeq?: number
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

/** Read one structural user message; invalid/foreign data is not a message. */
export function hostAdmissionMessageOf(value: unknown): HostAdmissionMessageLike | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const id = record.id
  const content = record.content
  if (typeof id !== 'string' || id === '' || !Array.isArray(content)) return undefined
  const blocks: ContentBlockLike[] = []
  for (const candidate of content) {
    const block = recordOf(candidate)
    if (block === undefined || typeof block.type !== 'string') return undefined
    blocks.push({ type: block.type, ...(typeof block.text === 'string' ? { text: block.text } : {}) })
  }
  const source = recordOf(record.source)
  return {
    id,
    content: blocks,
    ...(source === undefined ? {} : {
      source: {
        ...(typeof source.kind === 'string' ? { kind: source.kind } : {}),
        ...(typeof source.rpcId === 'string' ? { rpcId: source.rpcId } : {}),
      },
    }),
  }
}

/** Text projection: every text block, in order, joined by one newline. */
function textOfBlocks(blocks: readonly ContentBlockLike[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/** Whether the message carried any block that is not searchable text. */
function hasNonTextBlock(blocks: readonly ContentBlockLike[]): boolean {
  return blocks.some(block => block.type !== 'text')
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
  private unknownSources = 0
  private invalidCwds = 0
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
    this.currentCwdValue = options.headerCwd ?? null
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
      if (event.seq <= this.lastAppliedSeq) continue
      this.lastAppliedSeq = event.seq
      if (event.type === 'working-directory/change') {
        const cwd = recordOf(event.data)?.cwd
        if (typeof cwd === 'string' && cwd !== '') {
          this.currentCwdValue = cwd
        } else {
          this.invalidCwds += 1
        }
        continue
      }
      if (event.seq < this.inheritedEventCount) continue
      if (event.type === 'agent/inbox/spliced') {
        const data = recordOf(event.data)
        const inserted = data?.inserted
        if (!Array.isArray(inserted)) continue
        for (const candidate of inserted) {
          const message = hostAdmissionMessageOf(candidate)
          if (message !== undefined) this.accept(message, event.time, event.seq)
        }
        continue
      }
      if (event.type === 'user/message') {
        const message = hostAdmissionMessageOf(event.data)
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
      occurrences: this.newOccurrences.splice(0).map(occurrence => ({
        sessionId: occurrence.sessionId,
        messageId: occurrence.messageId,
        firstEventSeq: occurrence.firstEventSeq,
        content: occurrence.content,
        acceptedAt: occurrence.acceptedAt,
        cwd: occurrence.cwd,
        hasNonText: occurrence.hasNonText,
      })),
      unknownSourceCount: this.unknownSources,
      invalidCwdCount: this.invalidCwds,
      editedOccurrences: this.edits,
    }
    this.unknownSources = 0
    this.invalidCwds = 0
    this.edits = 0
    return delta
  }

  snapshot(): HostAdmissionSnapshot {
    return {
      occurrences: [...this.occurrences.values()].map(occurrence => ({
        sessionId: occurrence.sessionId,
        messageId: occurrence.messageId,
        firstEventSeq: occurrence.firstEventSeq,
        content: occurrence.content,
        acceptedAt: occurrence.acceptedAt,
        cwd: occurrence.cwd,
        hasNonText: occurrence.hasNonText,
      })),
      unknownSourceCount: this.unknownSources,
      invalidCwdCount: this.invalidCwds,
      editedOccurrences: this.edits,
    }
  }

  private accept(message: HostAdmissionMessageLike, time: number, seq: number): void {
    if (message.source?.kind !== 'user') return
    const rpcId = message.source.rpcId
    if (typeof rpcId !== 'string' || rpcId === '') {
      this.unknownSources += 1
      return
    }
    const existing = this.occurrences.get(message.id)
    const content = textOfBlocks(message.content)
    const signature = JSON.stringify(message.content)
    if (existing !== undefined) {
      if (existing.contentSignature !== signature) this.edits += 1
      return
    }
    if (!Number.isSafeInteger(time) || time < 0) {
      // A non-durable event time cannot carry an exact acceptedAt; treat the
      // source as uncertain instead of fabricating a timestamp.
      this.unknownSources += 1
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

/** One-shot fold helper for pure tests and small callers. */
export function classifyHostAdmission(
  options: HostAdmissionFoldOptions,
  events: readonly HostAdmissionEventLike[],
): HostAdmissionSnapshot {
  const fold = new HostAdmissionFold(options)
  fold.apply(events)
  return fold.snapshot()
}
