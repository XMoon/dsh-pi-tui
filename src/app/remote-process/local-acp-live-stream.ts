/**
 * The ONE transient assistant-stream projection of an ACP prompt flight.
 *
 * The official `agent/assistant-stream` frames are the ONLY provisional output
 * source of an ACP `session/prompt`: `start` opens one attempt on a durable
 * turn, `chunk` frames carry the model's dense, revision-fenced deltas, and
 * `end` names the durable settlement the attempt committed (or its
 * abandonment). The durable `assistant/message` event stays the ONLY committed
 * source: this module never persists model text, never opens a second text
 * store and never reorders frames — it validates the official framing, keeps
 * the small per-block preview an attempt needs to prove that what it already
 * sent matches the durable message, and decides whether a durable message may
 * be joined to (instead of re-sent after) the provisional text.
 *
 * ACP v1 `agent_message_chunk` is append-only: provisional bytes already handed
 * to a client cannot be retracted. The join decision therefore fails closed
 * (`divergence`) whenever the preview cannot prove that the durable content is
 * exactly what was already delivered; it never "re-sends a correction".
 *
 * @module app/remote-process/local-acp-live-stream
 */

/** One text/reasoning block as the ACP wire names it. */
export interface AcpStreamBlock {
  /** `message` is committed assistant text, `thought` is committed reasoning. */
  readonly kind: 'message' | 'thought'
  readonly text: string
}

/** The transient delta a chunk frame contributes, if any. */
export interface AcpStreamDelta {
  readonly kind: 'message' | 'thought'
  readonly text: string
}

/** The official terminal fact of one attempt. */
export type AcpStreamEnd =
  | {
    readonly kind: 'committed'
    readonly eventType: 'assistant/message' | 'assistant/attempt'
    readonly seq: number
  }
  | { readonly kind: 'abandoned' }

/** One structurally validated frame; every field is read at the unknown boundary. */
export type AcpAssistantStreamFrame =
  | {
    readonly type: 'start'
    readonly attemptId: string
    readonly revision: number
    readonly turn: number
    readonly step: number
  }
  | {
    readonly type: 'chunk'
    readonly attemptId: string
    readonly revision: number
    readonly index: number
    readonly chunk: unknown
  }
  | {
    readonly type: 'end'
    readonly attemptId: string
    readonly revision: number
    readonly index: number
    readonly outcome: AcpStreamEnd
  }

/** What one accepted chunk frame asks the caller to do. */
export type AcpChunkAction =
  /** A non-empty delta to hand to the transport in frame order. */
  | { readonly kind: 'delta'; readonly delta: AcpStreamDelta }
  /** A legal control frame that advances the attempt but carries no output. */
  | { readonly kind: 'control' }
  /** Order/shape violation: this attempt must stop sending deltas. */
  | { readonly kind: 'broken' }

/** The join verdict of one durable `assistant/message` against the preview. */
export type AcpStreamJoin =
  /** Nothing was sent: the durable message is the whole committed projection. */
  | { readonly kind: 'unstreamed' }
  /** Every durable text/thought block was already sent: only residual blocks remain. */
  | { readonly kind: 'joined' }
  /** The durable content cannot be proven identical to what was already sent. */
  | { readonly kind: 'divergence' }

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One per-index preview entry, mirroring the official block assembly order. */
interface PreviewBlock {
  /** Whether this block is a streamed text/thought block or an opaque one. */
  readonly kind: 'text' | 'reasoning' | 'other'
  text: string
  closed: boolean
}

/**
 * Read one official `agent/assistant-stream` payload frame structurally.
 * A frame that does not match the documented shape is `undefined`: the caller
 * must ignore it rather than trust a partial attempt identity.
 */
export function readAssistantStreamFrame(frame: unknown): AcpAssistantStreamFrame | undefined {
  if (!isRecord(frame)) return undefined
  const attemptId = frame['attemptId']
  const revision = frame['revision']
  if (typeof attemptId !== 'string' || attemptId === '') return undefined
  if (!isNonnegativeSafeInteger(revision)) return undefined
  switch (frame['type']) {
    case 'start': {
      const turn = frame['turn']
      const step = frame['step']
      if (!isNonnegativeSafeInteger(turn) || !isNonnegativeSafeInteger(step)) return undefined
      return { type: 'start', attemptId, revision, turn, step }
    }
    case 'chunk': {
      const index = frame['index']
      if (!isNonnegativeSafeInteger(index)) return undefined
      return { type: 'chunk', attemptId, revision, index, chunk: frame['chunk'] }
    }
    case 'end': {
      const index = frame['index']
      if (!isNonnegativeSafeInteger(index)) return undefined
      const outcome = readOutcome(frame['outcome'])
      if (outcome === undefined) return undefined
      return { type: 'end', attemptId, revision, index, outcome }
    }
    default:
      return undefined
  }
}

/** Read the official settled/abandoned terminal outcome. */
function readOutcome(value: unknown): AcpStreamEnd | undefined {
  if (!isRecord(value)) return undefined
  if (value['kind'] === 'abandoned') return { kind: 'abandoned' }
  if (value['kind'] !== 'committed') return undefined
  const eventType = value['eventType']
  const seq = value['seq']
  if (eventType !== 'assistant/message' && eventType !== 'assistant/attempt') return undefined
  if (!isNonnegativeSafeInteger(seq)) return undefined
  return { kind: 'committed', eventType, seq }
}

/**
 * One open attempt of ONE prompt flight.
 *
 * The attempt belongs to the flight, not to the Agent: it dies with its
 * `end` frame, its flight settlement or a framing violation, and it never
 * survives as a second cross-flight text store. `revision` is the official
 * Agent-lifecycle revision (dense across attempts); `nextIndex` is the dense
 * per-attempt chunk position. Both must advance by exactly one per accepted
 * frame — including control frames — or the attempt stops sending.
 */
export class AcpAssistantStream {
  /** The official attempt identity every later chunk/end frame is resolved by. */
  readonly attemptId: string
  /** The stable ACP message id every chunk (and any residual durable block) uses. */
  readonly messageId: string
  /** The durable turn/step this attempt started on. */
  readonly turn: number
  readonly step: number
  private expectedIndex = 0
  private revision: number
  private readonly previews = new Map<number, PreviewBlock>()
  private sent = false
  private broken = false
  /**
   * Permanently closed because the attempt's terminal can never be observed.
   * Unlike `broken` (a framing violation whose REAL `end` is still a true
   * fact), a closed attempt ignores every later frame completely.
   */
  private closed = false
  /** The terminal fact, once the official `end` frame arrived. */
  private terminal?: AcpStreamEnd
  /** Resolves once the terminal fact is known — or forever unknowable. */
  private readonly terminalWait = Promise.withResolvers<AcpStreamEnd | undefined>()

  /**
   * @param frame - the validated `start` frame.
   * @param messageId - the opaque ACP message id this attempt's chunks share.
   */
  constructor(frame: Extract<AcpAssistantStreamFrame, { type: 'start' }>, messageId: string) {
    this.attemptId = frame.attemptId
    this.messageId = messageId
    this.turn = frame.turn
    this.step = frame.step
    this.revision = frame.revision
  }

  /**
   * The attempt's terminal fact, or `undefined` when it became unknowable (the
   * durable `turn/end` arrived, the flight stopped its output, or a newer
   * attempt replaced this one before its own `end` frame).
   */
  get terminalFact(): Promise<AcpStreamEnd | undefined> {
    return this.terminalWait.promise
  }

  /**
   * Whether a REAL terminal fact was recorded. A permanently closed attempt
   * never records one, so a late `end` frame leaves this false; a merely
   * framing-broken attempt still records its own real `end` (the join may then
   * still find the preview matching the committed message).
   */
  get hasTerminal(): boolean {
    return this.terminal !== undefined
  }

  /**
   * Declare that this attempt's terminal frame can never be observed.
   *
   * The attempt is then PERMANENTLY closed: it keeps whatever it already
   * delivered (ACP v1 output is append-only) and the join may still compare that
   * preview, but no late chunk may be accepted and no late `end` may claim it.
   * This is the intrinsic guarantee behind "a frame of an already-terminal turn
   * is inert" — it must not depend on the surrounding output-tail ordering.
   */
  endWithoutTerminal(): void {
    this.closed = true
    this.broken = true
    this.terminalWait.resolve(undefined)
  }

  /** Whether any non-empty delta of this attempt was handed to the transport. */
  hasSent(): boolean {
    return this.sent
  }

  /** Whether this attempt may still produce deltas. */
  isOpen(): boolean {
    return !this.closed && !this.broken && this.terminal === undefined
  }

  /**
   * Accept one `chunk` frame of this attempt.
   * @param frame - the validated chunk frame.
   * @returns the delta to send, `control` for a legal non-output frame, or
   *   `broken` when the frame breaks the dense revision/index contract or
   *   carries an unrecognized chunk kind.
   */
  acceptChunk(frame: Extract<AcpAssistantStreamFrame, { type: 'chunk' }>): AcpChunkAction {
    if (this.closed || this.broken) return { kind: 'broken' }
    if (this.terminal !== undefined) return { kind: 'broken' }
    if (frame.revision !== this.revision + 1) return this.breakStream()
    this.revision = frame.revision
    if (frame.index !== this.expectedIndex) return this.breakStream()
    this.expectedIndex += 1
    return this.acceptChunkBody(frame.chunk)
  }

  /**
   * Accept the `end` frame of this attempt.
   * @param frame - the validated terminal frame.
   * @returns whether the frame belonged to this attempt and matched its dense
   *   chunk count. A mismatch breaks the attempt and keeps the terminal fact.
   */
  acceptEnd(frame: Extract<AcpAssistantStreamFrame, { type: 'end' }>): boolean {
    // A permanently closed attempt (its terminal became unobservable) treats a
    // late `end` as a complete no-op: it may not even record an outcome, so the
    // unknowable terminal fact stays unknowable.
    if (this.closed || this.terminal !== undefined) return false
    if (this.broken) {
      // A framing-broken attempt still records its REAL terminal fact: the join
      // must know that no durable message of this attempt can be re-sent.
      this.terminal = frame.outcome
      this.terminalWait.resolve(frame.outcome)
      return false
    }
    if (frame.revision !== this.revision + 1 || frame.index !== this.expectedIndex) {
      this.broken = true
      this.terminal = frame.outcome
      this.terminalWait.resolve(frame.outcome)
      return false
    }
    this.terminal = frame.outcome
    this.terminalWait.resolve(frame.outcome)
    return true
  }

  /** The ordered text/thought preview of everything this attempt assembled. */
  streamedBlocks(): readonly AcpStreamBlock[] {
    const blocks: AcpStreamBlock[] = []
    for (const preview of this.previews.values()) {
      if (preview.kind === 'other') continue
      blocks.push({ kind: preview.kind === 'text' ? 'message' : 'thought', text: preview.text })
    }
    return blocks
  }

  private breakStream(): AcpChunkAction {
    this.broken = true
    return { kind: 'broken' }
  }

  private acceptChunkBody(chunk: unknown): AcpChunkAction {
    if (!isRecord(chunk)) return this.breakStream()
    switch (chunk['type']) {
      case 'block-start': {
        const index = chunk['index']
        const blockType = chunk['blockType']
        if (!isNonnegativeSafeInteger(index) || typeof blockType !== 'string' || blockType === '') {
          return this.breakStream()
        }
        if (!this.previews.has(index)) {
          this.previews.set(index, { kind: previewKind(blockType), text: '', closed: false })
        }
        return { kind: 'control' }
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const index = chunk['index']
        const text = chunk['text']
        const kind = chunk['type'] === 'text-delta' ? 'text' : 'reasoning'
        if (!isNonnegativeSafeInteger(index) || typeof text !== 'string') return this.breakStream()
        const preview = this.previewFor(index, kind)
        if (preview.closed) return { kind: 'control' }
        if (preview.kind !== kind) return this.breakStream()
        preview.text += text
        if (text === '') return { kind: 'control' }
        this.sent = true
        return { kind: 'delta', delta: { kind: kind === 'text' ? 'message' : 'thought', text } }
      }
      case 'tool-call-delta': {
        const index = chunk['index']
        if (!isNonnegativeSafeInteger(index) || typeof chunk['id'] !== 'string'
          || typeof chunk['argumentsDelta'] !== 'string') {
          return this.breakStream()
        }
        if (!this.previews.has(index)) {
          this.previews.set(index, { kind: 'other', text: '', closed: false })
        }
        return { kind: 'control' }
      }
      case 'block-end': {
        const index = chunk['index']
        const block = chunk['block']
        if (!isNonnegativeSafeInteger(index) || !isRecord(block) || typeof block['type'] !== 'string') {
          return this.breakStream()
        }
        const preview = this.previewFor(index, previewKind(block['type']))
        // The first close wins exactly like the official assembler; a re-close
        // straggler changes nothing.
        if (preview.closed) return { kind: 'control' }
        if (preview.kind !== 'other') {
          // The assembled block is authoritative: if it disagrees with the
          // deltas already handed to the client, this attempt can never prove
          // its durable message was fully delivered.
          if (block['text'] !== preview.text) return this.breakStream()
        }
        preview.closed = true
        return { kind: 'control' }
      }
      case 'usage': {
        if (!isRecord(chunk['usage'])) return this.breakStream()
        return { kind: 'control' }
      }
      case 'finish': {
        if (!isRecord(chunk['reason'])) return this.breakStream()
        return { kind: 'control' }
      }
      default:
        // An unknown chunk kind is not part of the accepted master contract;
        // it can neither be displayed nor allowed to advance the attempt.
        return this.breakStream()
    }
  }

  private previewFor(index: number, kind: PreviewBlock['kind']): PreviewBlock {
    let preview = this.previews.get(index)
    if (preview === undefined) {
      preview = { kind, text: '', closed: false }
      this.previews.set(index, preview)
    }
    return preview
  }
}

function previewKind(blockType: string): PreviewBlock['kind'] {
  return blockType === 'text' ? 'text' : blockType === 'reasoning' ? 'reasoning' : 'other'
}

/**
 * Decide how one durable `assistant/message` relates to the provisional text
 * this flight already delivered.
 *
 * The durable message is never suppressed: its non-text blocks (images) are
 * still projected by the caller. Only the text/thought blocks that were
 * already delivered are not sent again, and only when the comparison can prove
 * that the durable content is exactly those bytes.
 *
 * @param streamed - the attempt's ordered text/thought preview.
 * @param committed - the durable message's ordered text/thought blocks.
 * @param options - `sent` whether any delta was delivered; `interrupted` the
 *   official partial-message flag (its committed prefix drops whitespace-only
 *   blocks by contract).
 * @returns the join verdict; `divergence` must fail the flight closed.
 */
export function joinStreamedMessage(
  streamed: readonly AcpStreamBlock[],
  committed: readonly AcpStreamBlock[],
  options: { readonly sent: boolean; readonly interrupted: boolean },
): AcpStreamJoin {
  if (!options.sent) return { kind: 'unstreamed' }
  const preview = options.interrupted ? streamed.filter(block => block.text.trim() !== '') : streamed
  if (preview.length !== committed.length) return { kind: 'divergence' }
  for (let index = 0; index < preview.length; index += 1) {
    const left = preview[index]
    const right = committed[index]
    if (left.kind !== right.kind || left.text !== right.text) return { kind: 'divergence' }
  }
  return { kind: 'joined' }
}
