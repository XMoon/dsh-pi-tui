/**
 * Experimental Remote implementation of the semantic SessionLifecycle port
 * (D2.3).
 *
 * Ordinary create maps to the official `ClientSessions.create()` (which
 * guarantees that, on resolution, the created Session is in the Client list
 * and its binding resolves). A guaranteed-fresh TUI create carrying an
 * explicit preset uses the generated official `session.create({sessionId, cwd,
 * agentPreset})` — one Host mutation preserving creation-time atomicity — and
 * reconciles the official Client object layer so `binding(sessionId)`
 * resolves. The `create()` + `agentPresets.select()` emulation is deliberately
 * NOT used.
 *
 * Open is the official Client semantic `select/open this Session`:
 * `ClientSessions.open()` / `binding()`. No Host `resume` RPC is invented.
 *
 * Seeded/fork creates fail closed: D2.4 owns Host fork, and the legacy Direct
 * seed payload must never be serialized as a new Remote contract. A create
 * error is operation-specific: a post-publication error is never reported as
 * "the Session was never created", its published identity is machine-readable,
 * a Connection generation replaced mid-RPC is indeterminate, and no same-id
 * retry happens.
 *
 * The explicit-preset path's Client-state reconciliation (`handleSessionAdded`)
 * is a SYNCHRONOUS local list insert with no await, and it runs AFTER the Host
 * create has already committed. A caller abort observed during that local
 * insert cannot retroactively un-publish the Session, so the create still
 * settles `created` — reporting it as failed would lie about durable Host
 * state. (The async fences cover everything up to and including the Host
 * round-trip.)
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/session-lifecycle-remote
 */

import type { CreateSessionRequest, OpenSessionRequest, SessionHandle, SessionLifecycle } from '../session-lifecycle-port.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'
import { remoteFailureCode, remoteFailureMessage } from './write-failure.ts'

/** One official Client Session list summary synthesized by reconciliation. */
export interface RemoteLifecycleSessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly cwd?: string
}

/** The official `ClientSessions` subset the lifecycle needs. */
export interface RemoteLifecycleSessions {
  create(opts: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<string>
  open(id: string): void
  binding(id: string): { readonly sessionId?: string } | undefined
  handleSessionAdded(summary: RemoteLifecycleSessionSummary): void
}

/** The official generated `session` Remote create face. */
export interface RemoteLifecycleSessionRemotes {
  create(request: {
    readonly sessionId: string
    readonly cwd?: string
    readonly agentPreset?: string
  }): Promise<RemoteResultLike<{ readonly sessionId: string; readonly agentPreset?: string }>>
}

/** A create failure carrying the code and any published Session identity. */
export class RemoteCreateError extends Error {
  override readonly name = 'RemoteCreateError'
  readonly code: string
  /** The Session the Host may already have published (post-publication error
   *  or reconciliation ambiguity), or undefined when the create proved no
   *  publication. */
  readonly publishedSessionId: string | undefined

  constructor(code: string, message: string, publishedSessionId: string | undefined) {
    super(publishedSessionId === undefined
      ? `session create failed (${code}): ${message}`
      : `session create failed (${code}): ${message} — session "${publishedSessionId}" may already have been published`)
    this.code = code
    this.publishedSessionId = publishedSessionId
  }
}

/** Whether the request carries the Direct D2.4 fork/rewind legacy payload. */
function isSeededCreate(request: CreateSessionRequest): boolean {
  return request.seed !== undefined || request.meta.isSeeded === true
}

function requestCwd(request: CreateSessionRequest): string | undefined {
  const cwd = request.meta.cwd
  return typeof cwd === 'string' ? cwd : undefined
}

/**
 * Read a PROVEN published Session identity off an official create error.
 * Only the official post-publication `session/workspace-attach-failed` code
 * (or an explicit `publishedSessionId` field) proves publication: the Client
 * error's `requestedSessionId` is the REQUESTED id, and `session/conflict` /
 * `agent-preset/conflict` details name a conflicting id — neither proves a new
 * Session was published, so they are never reported as such.
 */
function publishedSessionId(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as {
    readonly code?: unknown
    readonly publishedSessionId?: unknown
    readonly details?: unknown
    readonly rpcError?: unknown
  }
  if (typeof record.publishedSessionId === 'string') return record.publishedSessionId
  if (record.code === 'session/workspace-attach-failed'
    && typeof record.details === 'object' && record.details !== null) {
    const detailId = (record.details as { readonly sessionId?: unknown }).sessionId
    if (typeof detailId === 'string') return detailId
  }
  if (record.rpcError !== undefined) return publishedSessionId(record.rpcError)
  return undefined
}

/** A refusal code preserved across the generated Remote and the Client error. */
function errorCode(error: unknown): string | undefined {
  const direct = remoteFailureCode(error)
  if (direct !== undefined) return direct
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as { readonly rpcError?: unknown; readonly code?: unknown }
  if (typeof record.code === 'string' && record.code !== '') return record.code
  return remoteFailureCode(record.rpcError)
}

/**
 * Turn one failed create into an identity-preserving error. Only a PROVEN
 * published identity is exposed so a later reconciliation (D2.4) can finish
 * the settlement; the caller never retries the same id.
 */
function createFailureError(error: unknown): RemoteCreateError {
  const code = errorCode(error) ?? 'session/create-failed'
  const message = remoteFailureMessage(error)
  return new RemoteCreateError(code, message, publishedSessionId(error))
}

/** The experimental Remote session lifecycle. */
export class RemoteSessionLifecycle implements SessionLifecycle {
  private readonly sessions: RemoteLifecycleSessions
  private readonly session: RemoteLifecycleSessionRemotes
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    sessions: RemoteLifecycleSessions,
    session: RemoteLifecycleSessionRemotes,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.sessions = sessions
    this.session = session
    this.generation = generation
  }

  async create(request: CreateSessionRequest): Promise<SessionHandle> {
    request.signal?.throwIfAborted()
    if (isSeededCreate(request)) {
      // Never serialize the legacy Direct seed payload as a Remote contract.
      throw new Error('the Remote ordinary create path cannot create a seeded/forked Session; D2.4 owns Host fork')
    }
    const cwd = requestCwd(request)
    const captured = this.generation.getSnapshot()
    // A disconnected client must not dispatch through stale/queued state.
    if (captured === undefined) {
      throw new RemoteCreateError('session/create-unavailable', 'the remote connection is not connected', undefined)
    }
    const generationChanged = (): boolean => !Object.is(captured, this.generation.getSnapshot())
    /** Whether a dispatched create is no longer provable against the live
     *  Client: a reconnect or a post-dispatch cancellation. */
    const ambiguousAfterDispatch = (): boolean => generationChanged() || request.signal?.aborted === true
    /** The ambiguous post-dispatch error (checked BEFORE any success/failure
     *  classification, so a Host refusal after a reconnect is NOT reported as
     *  a pre-publication refusal). */
    const ambiguousError = (publishedId: string | undefined): RemoteCreateError =>
      request.signal?.aborted === true
        ? new RemoteCreateError('session/create-aborted-after-dispatch', 'the create was cancelled after dispatch', publishedId)
        : new RemoteCreateError('session/create-indeterminate', 'the Host connection changed during the create', publishedId)
    if (request.agentPreset !== undefined) {
      // Guaranteed-fresh TUI create with an explicit preset: one Host mutation
      // (`session.create` with the preset) preserves creation-time atomicity.
      const result = await this.session.create({
        sessionId: request.sessionId,
        ...cwd === undefined ? {} : { cwd },
        agentPreset: request.agentPreset,
      })
      // Fence BEFORE classification: a reconnect/cancellation during the RPC
      // makes BOTH a refusal and a success unprovable, and a post-publication
      // refusal identity is preserved.
      if (ambiguousAfterDispatch()) {
        throw ambiguousError(result.ok ? result.value.sessionId : publishedSessionId(result.error))
      }
      if (!result.ok) throw createFailureError(result.error)
      // The Host-returned identity is authoritative (it may differ from the
      // requested one); never reconcile the wrong id.
      const publishedId = result.value.sessionId
      // Reconcile the official Client object layer so the Session is visible
      // and addressable synchronously (the same guarantee ClientSessions.create
      // gives the no-preset path). A reconciliation throw is a POST-PUBLICATION
      // failure: it must preserve the published identity and never look like a
      // pre-publication refusal.
      try {
        this.sessions.handleSessionAdded({
          sessionId: publishedId,
          updatedAt: Date.now(),
          running: false,
          blank: true,
          ...cwd === undefined ? {} : { cwd },
        })
      } catch (error) {
        throw new RemoteCreateError(
          'session/reconcile-failed',
          `the created Session could not be reconciled into Client state: ${remoteFailureMessage(error)}`,
          publishedId,
        )
      }
      if (this.sessions.binding(publishedId) === undefined) {
        throw new RemoteCreateError('session/created-not-addressable', 'the created Session is not addressable in Client state', publishedId)
      }
      return { session: { id: publishedId } }
    }
    let id: string
    try {
      id = String(await this.sessions.create({
        sessionId: request.sessionId,
        ...cwd === undefined ? {} : { cwd },
      }))
    } catch (error) {
      // A reconnect/cancellation during the failing RPC makes the refusal
      // unprovable; preserve any post-publication identity from the error.
      if (ambiguousAfterDispatch()) throw ambiguousError(publishedSessionId(error))
      throw createFailureError(error)
    }
    if (ambiguousAfterDispatch()) throw ambiguousError(id)
    return { session: { id } }
  }

  async open(request: OpenSessionRequest): Promise<SessionHandle> {
    request.signal?.throwIfAborted()
    // v2 §0.5: open is Client-local selection, but it still requires a valid
    // current Client generation; a disconnected Client cannot select.
    const captured = this.generation.getSnapshot()
    if (captured === undefined) {
      throw new Error(`session "${request.sessionId}" cannot be opened: the remote connection is not connected`)
    }
    // Fail closed when the id is not an addressable Client Session — before
    // mutating the Client's current selection.
    if (this.sessions.binding(request.sessionId) === undefined) {
      throw new Error(`session "${request.sessionId}" is not available in Client state`)
    }
    this.sessions.open(request.sessionId)
    if (this.sessions.binding(request.sessionId) === undefined) {
      throw new Error(`session "${request.sessionId}" could not be opened in Client state`)
    }
    // The local selection is only this operation's result while the Client
    // generation that owned it is still current.
    if (!Object.is(captured, this.generation.getSnapshot())) {
      throw new Error(`session "${request.sessionId}" open was superseded by a connection change`)
    }
    return { session: { id: request.sessionId } }
  }
}
