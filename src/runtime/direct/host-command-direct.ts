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
  /**
   * The official synchronous Session-event observation seam (`session/event`),
   * used ONLY to prove that one dispatch synchronously entered its official
   * compaction transaction. Absent on an older structural stand-in, which then
   * never opens the ordering window.
   */
  on?(
    name: 'session/event',
    listener: (session: unknown, event: { readonly type?: unknown; readonly data?: unknown }) => void,
  ): (() => boolean) | void
}

/** The live Agent scope required by the Direct command service. */
export interface LiveAgentLike {
  readonly session: { readonly id: string }
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

/** One Session event observed inside the dispatch's synchronous window. */
interface ObservedSessionEvent {
  readonly type: string
  readonly data: unknown
}

/**
 * Whether THIS command invocation synchronously entered the official manual
 * compaction transaction. Only the events observed inside the ONE
 * `commands.execute` call are considered: the caller's `command/run` must be
 * followed by a `compaction/start` citing its exact `commandId` with
 * `turn: null`. A `command/run` alone, a foreign compaction id, or a
 * turn-owned (automatic) bracket never qualifies. Observation comes from the
 * official synchronous `session/event` publication, never from a deprecated
 * history reader.
 */
function officialCompactEntered(observed: readonly ObservedSessionEvent[]): boolean {
  let commandId: unknown
  for (const event of observed) {
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
      const observed: ObservedSessionEvent[] = []
      const stopObserving = officialCompact ? this.observeSessionEvents(agent.session, observed) : undefined
      try {
        // NO await may separate this dispatch from the observation window: the
        // pinned official executor appends `command/run`, invokes the handler
        // (which synchronously claims maintenance and appends
        // `compaction/start`) and only then yields to summarization.
        const pending = commands.execute(agent, request.line, request.attachments, request.signal)
        // The synchronous prefix has completed; stop observing before the first
        // await and decide on the events it published.
        stopObserving?.()
        if (officialCompactEntered(observed)) request.onOfficialCompactEntered?.()
        const execution = await pending
        if (execution === undefined) return { kind: 'committed', matched: false }
        return { kind: 'committed', matched: true, execution }
      } finally {
        stopObserving?.()
      }
    } catch (error) {
      return indeterminate(error)
    }
  }

  /**
   * Subscribe to the official synchronous `session/event` publication for ONE
   * dispatch window. Returns the disposer, or `undefined` when this Host context
   * exposes no event seam (an older structural stand-in never opens the window).
   * Events of any other Session are ignored by identity.
   */
  private observeSessionEvents(
    session: LiveAgentLike['session'],
    sink: ObservedSessionEvent[],
  ): (() => void) | undefined {
    const on = this.ctx.on
    if (on === undefined) return undefined
    const dispose = on.call(this.ctx, 'session/event', (eventSession, event) => {
      if (eventSession !== session) return
      sink.push({ type: typeof event.type === 'string' ? event.type : '', data: event.data })
    })
    return typeof dispose === 'function' ? () => { dispose() } : undefined
  }
}
