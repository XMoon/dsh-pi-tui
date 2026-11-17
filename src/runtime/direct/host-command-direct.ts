/**
 * The Direct Host command adapter (D2.1): resolve the live Agent by session
 * id at call time and invoke the official `commands.execute` service. Claim
 * classification, line precedence, TUI-local commands and skill wrappers stay
 * in the runner; this adapter passes the selected line and prepared wire
 * through unchanged.
 *
 * `stageFileReceipt` is Direct's ONE official receipt seam: it resolves the
 * Host `fileUploads` service (registered by the official file-upload row, whose
 * receipt resolver `commands.execute` consumes) and streams the Client file
 * snapshot into that Session's staged receipt. It never falls back to the
 * plain prompt attachment store: a durable attachment reference is not a
 * command receipt.
 *
 * Full contract: docs/architecture/host-client.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/host-command-direct
 */

import { safeErrorMessage } from '../process/errors.ts'
import type {
  HostCommandExecution,
  HostCommandFileStageRequest,
  HostCommandOutcome,
  HostCommandPort,
  HostCommandRequest,
} from '../host-command-port.ts'
import type { WriteError } from '../write-outcome.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the service resolves from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The live Agent scope required by the Direct command service. */
export interface LiveAgentLike {
  readonly session: {
    readonly id: string
    /** The real pinned Session's log offset; absent on older stand-ins. */
    readonly seq?: number
    /** The real pinned Session's immutable event read; absent on stand-ins. */
    eventAt?(seq: number): { readonly type: string; readonly data: unknown } | undefined
  }
}

/** The read-only Session log window used by the ONE official-compaction
 * ordering proof. `seq` is the log offset captured BEFORE the dispatch; the
 * caller reads the live offset after it. Both members come from the real pinned
 * Session; a structural stand-in without them never opens the window. */
export interface SessionLogWindowLike {
  readonly seq: number
  eventAt(seq: number): { readonly type: string; readonly data: unknown } | undefined
}

/** The official argument-free manual-compaction definition identity. */
const OFFICIAL_COMPACT_DEFINITION_ID = '@deepseek-ai/dsh-command-compact'
const OFFICIAL_COMPACT_NAME = 'compact'

/** The official Direct command service shape needed by this adapter. */
export interface CommandsServiceLike {
  execute(
    agent: unknown,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<HostCommandExecution | undefined>
  /** The effective (scoped-aware) definition lookup. Absent on older
   * structural stand-ins, which therefore never open the ordering window. */
  find?(agent: unknown, name: string): { readonly definitionId?: string } | undefined
}

/** The official Host file-upload service shape needed by this adapter. */
export interface FileUploadsServiceLike {
  uploadStream(request: {
    readonly sessionId: string
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<{ readonly receiptId: string }>
}

function rejected(code: string, message: string): { kind: 'rejected'; error: WriteError } {
  return { kind: 'rejected', error: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The real Session's log window, or `undefined` when this Agent's Session
 * cannot prove the pairing (an older structural stand-in).
 */
function sessionLogWindow(session: LiveAgentLike['session']): SessionLogWindowLike | undefined {
  const { seq, eventAt } = session
  if (typeof seq !== 'number' || eventAt === undefined) return undefined
  return {
    seq,
    // Keep the REAL Session receiver: `eventAt` reads that Session's own log.
    eventAt: value => eventAt.call(session, value),
  }
}

/**
 * Whether THIS command invocation synchronously entered the official manual
 * compaction transaction. Only the events appended inside the ONE
 * `commands.execute` call are scanned (`startSeq`..`endSeq`): the caller's
 * `command/run` must be followed by a `compaction/start` citing its exact
 * `commandId` with `turn: null`. A `command/run` alone, a foreign compaction
 * id, or a turn-owned (automatic) bracket never qualifies.
 */
function officialCompactEntered(window: SessionLogWindowLike, startSeq: number, endSeq: number): boolean {
  let commandId: unknown
  for (let seq = startSeq; seq < endSeq; seq += 1) {
    const event = window.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'command/run') {
      const data = event.data
      if (isRecord(data) && data.name === OFFICIAL_COMPACT_NAME
        && isRecord(data.source) && data.source.kind === 'user') {
        commandId = data.commandId
      }
      continue
    }
    if (event.type !== 'compaction/start') continue
    const data = event.data
    if (commandId !== undefined && isRecord(data)
      && data.sourceCommandId === commandId && data.turn === null) return true
  }
  return false
}

function indeterminate(error: unknown): Extract<HostCommandOutcome, { readonly kind: 'indeterminate' }> {
  return {
    kind: 'indeterminate',
    error: {
      code: 'session/write-indeterminate',
      message: safeErrorMessage(error),
    },
  }
}

/** The Direct backend's Host command port. */
export class DirectHostCommandPort implements HostCommandPort {
  private readonly ctx: HostContextLike
  private readonly agentFor: (sessionId: string) => LiveAgentLike | undefined

  constructor(ctx: HostContextLike, agentFor: (sessionId: string) => LiveAgentLike | undefined) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  async stageFileReceipt(request: HostCommandFileStageRequest): Promise<{ readonly receiptId: string }> {
    request.signal.throwIfAborted()
    if (request.file.source.kind !== 'client-stream') {
      throw new Error(`stored file "${request.file.name}" cannot be re-uploaded by this Client`)
    }
    const uploads = this.ctx.get('fileUploads') as FileUploadsServiceLike | undefined
    if (uploads === undefined) throw new Error('fileUploads service unavailable')
    // The receiving Session must be the exact live Agent this adapter would
    // dispatch the command to; a disposed/replaced Agent fails closed before
    // any bytes are stored.
    if (this.agentFor(request.sessionId) === undefined) {
      throw new Error(`session "${request.sessionId}" is not available`)
    }
    const uploaded = await uploads.uploadStream({
      sessionId: request.sessionId,
      data: request.file.source.open(request.signal),
      signal: request.signal,
      name: request.file.name,
    })
    request.signal.throwIfAborted()
    if (typeof uploaded.receiptId !== 'string' || uploaded.receiptId === '') {
      throw new Error('file upload returned no receipt')
    }
    return { receiptId: uploaded.receiptId }
  }

  async execute(request: HostCommandRequest): Promise<HostCommandOutcome> {
    const commands = this.ctx.get('commands') as CommandsServiceLike | undefined
    if (commands === undefined) return rejected('service/unavailable', 'commands service unavailable')
    const agent = this.agentFor(request.sessionId)
    if (agent === undefined) return rejected('session/not-found', `session "${request.sessionId}" is not available`)
    // The caller-owned lifecycle signal is forwarded unchanged; do not mint a
    // replacement that could outlive the TUI surface.
    if (request.signal.aborted) return { kind: 'cancelled' }
    // Once the Host command is dispatched, a cancellation-shaped throw is NOT
    // proof that nothing happened: the pinned executor appends `command/run`
    // before the handler and `command/done` after it, so an aborted handler may
    // already have run (and side-effected). Such a failure is therefore
    // indeterminate, never a known `cancelled`.
    //
    // The ONE ordering proof: the bare official manual-compaction line whose
    // EFFECTIVE definition for THIS exact Agent is the official definition. The
    // window is opened only by the evidence below, never by the line, the
    // handler's eventual result, the Agent status or a Remote round trip.
    try {
      // The identity read stays INSIDE the outcome taxonomy: a service failure
      // here must be the same classified failure as any other dispatch failure,
      // never a rejected port promise.
      const officialCompact = request.line.trim() === '/compact'
        && request.attachments.length === 0
        && commands.find?.(agent, 'compact')?.definitionId === OFFICIAL_COMPACT_DEFINITION_ID
      const window = officialCompact ? sessionLogWindow(agent.session) : undefined
      const startSeq = window?.seq
      // NO await may separate this dispatch from the pairing scan: the pinned
      // official executor appends `command/run`, invokes the handler (which
      // synchronously claims maintenance and appends `compaction/start`) and
      // only then yields to summarization.
      const pending = commands.execute(agent, request.line, request.attachments, request.signal)
      // The window's END is the live log offset AFTER the dispatch returned:
      // `sessionLogWindow` captured the START before it. Both reads are part of
      // this one synchronous stack.
      const endSeq = agent.session.seq
      if (window !== undefined && startSeq !== undefined && endSeq !== undefined
        && Number.isSafeInteger(startSeq) && Number.isSafeInteger(endSeq)
        && officialCompactEntered(window, startSeq, endSeq)) {
        request.onOfficialCompactEntered?.()
      }
      const execution = await pending
      if (execution === undefined) return { kind: 'committed', matched: false }
      return { kind: 'committed', matched: true, execution }
    } catch (error) {
      return indeterminate(error)
    }
  }
}
