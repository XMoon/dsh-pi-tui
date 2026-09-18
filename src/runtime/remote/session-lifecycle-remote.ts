/**
 * Experimental Remote implementation of the semantic SessionLifecycle port
 * (D2.3–D2.4).
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
 * Host-owned fork maps to the official `ClientSessions.fork()` exactly once;
 * no seed payload or child identity crosses this adapter. A create error is
 * operation-specific: a post-publication error is never reported as
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

import type {
  CreateOutcome,
  CreateResult,
  CreateSessionRequest,
  ForkResult,
  ForkSessionRequest,
  OpenResult,
  OpenSessionRequest,
  SessionLifecycle,
} from '../session-lifecycle-port.ts'
import type { OperationOwnership } from '../write-outcome.ts'
import { GATEWAY_PRE_INVOCATION_CODES } from '../write-outcome.ts'
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

/** The official `ClientSessions` subset the lifecycle needs. The generated
 * RemoteResult is already unwrapped by ClientSessions.create/fork; only the
 * generated session namespace below exposes RemoteResultLike values. */
export interface RemoteLifecycleSessions {
  create(opts: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<string>
  fork(opts: { readonly sessionId: string; readonly atSeq?: number }): Promise<string>
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

/** Exact `session.create` refusal codes the pinned Host proves happen BEFORE a
 *  new ordinary Session is published (v2 §0.7.3). `session/conflict` and
 *  `agent-preset/conflict` name an EXISTING/adopted identity — a rejection, but
 *  never new-publication evidence. `gateway/internal` is deliberately absent:
 *  it is too broad to prove no publication. */
const CREATE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'gateway/bad-request',
  'workspace/not-found',
  'agent-preset/not-found',
  'agent-preset/invalid',
  'agent-preset/conflict',
  'session/conflict',
  'session/agent-busy',
])

function requestCwd(request: CreateSessionRequest): string | undefined {
  return request.cwd
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
  // The official Client carrier may nest the generated Remote failure.
  return remoteFailureCode((error as { readonly rpcError?: unknown }).rpcError)
}

/**
 * Classify one failed create WITHOUT losing the settlement (v2 §0.7.3). Only a
 * PROVEN published identity becomes `published-with-error`; only an exact
 * pre-publication refusal code becomes `rejected`; everything else is
 * `indeterminate` with the requested id as CORRELATION ONLY.
 */
function classifyCreateFailure(error: unknown, requestedSessionId: string): CreateOutcome {
  const code = errorCode(error)
  const published = publishedSessionId(error)
  if (published !== undefined) {
    return {
      kind: 'published-with-error',
      sessionId: published,
      error: { code: code ?? 'session/workspace-attach-failed', message: remoteFailureMessage(error) },
    }
  }
  if (code !== undefined && (CREATE_REFUSAL_CODES.has(code) || GATEWAY_PRE_INVOCATION_CODES.has(code))) {
    return { kind: 'rejected', error: { code, message: remoteFailureMessage(error) } }
  }
  return {
    kind: 'indeterminate',
    error: { code: code ?? 'session/create-indeterminate', message: remoteFailureMessage(error) },
    requestedSessionId,
  }
}

const FORK_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'gateway/bad-request',
  'session/not-found',
  'session/fork-unavailable',
])

function classifyForkFailure(error: unknown): ForkResult['outcome'] {
  const code = errorCode(error)
  const published = publishedSessionId(error)
  if (published !== undefined) {
    return {
      kind: 'published-with-error',
      sessionId: published,
      error: { code: code ?? 'session/workspace-attach-failed', message: remoteFailureMessage(error) },
    }
  }
  if (code !== undefined && (FORK_REFUSAL_CODES.has(code) || GATEWAY_PRE_INVOCATION_CODES.has(code))) {
    return { kind: 'rejected', error: { code, message: remoteFailureMessage(error) } }
  }
  return {
    kind: 'indeterminate',
    error: { code: code ?? 'session/fork-indeterminate', message: remoteFailureMessage(error) },
  }
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

  async create(request: CreateSessionRequest): Promise<CreateResult> {
    // A provable PRE-dispatch cancellation is `cancelled` (never a throw).
    if (request.signal?.aborted === true) return { ownership: 'current', outcome: { kind: 'cancelled' } }
    const cwd = requestCwd(request)
    const captured = this.generation.getSnapshot()
    // A disconnected client must not dispatch through stale/queued state.
    if (captured === undefined) return { ownership: 'current', outcome: { kind: 'cancelled' } }
    // Ownership is a SEPARATE axis (v2 §0.2.1): a reconnect or a post-dispatch
    // abort means this result no longer owns the surface — it does NOT prove
    // the Host did not create the Session.
    const ownership = (): OperationOwnership =>
      !Object.is(captured, this.generation.getSnapshot()) || request.signal?.aborted === true
        ? 'superseded'
        : 'current'
    if (request.agentPreset !== undefined) {
      // Guaranteed-fresh TUI create with an explicit preset: one Host mutation
      // (`session.create` with the preset) preserves creation-time atomicity.
      // The official generated Remote THROWS on transport/envelope failure;
      // normalize it so a post-dispatch failure is `indeterminate` with the
      // requested id as correlation (v2 §0.7.3), never a rejected Promise.
      const result = await this.session.create({
        sessionId: request.sessionId,
        ...cwd === undefined ? {} : { cwd },
        agentPreset: request.agentPreset,
      }).catch((error: unknown) => ({ ok: false as const, error }))
      if (!result.ok) return { ownership: ownership(), outcome: classifyCreateFailure(result.error, request.sessionId) }
      const publishedId = result.value.sessionId
      // The connection envelope parser does not validate the nested payload:
      // a malformed success must not fake a created Session identity.
      if (typeof publishedId !== 'string' || publishedId === '') {
        return {
          ownership: ownership(),
          outcome: {
            kind: 'indeterminate',
            error: { code: 'session/create-result-invalid', message: 'the Host returned an unusable Session id' },
            requestedSessionId: request.sessionId,
          },
        }
      }
      const handle = { session: { id: publishedId } }
      // Classify FIRST, then ownership: a Host success after a reconnect is
      // `created + superseded`, never a downgraded indeterminate.
      if (ownership() === 'superseded') return { ownership: 'superseded', outcome: { kind: 'created', handle } }
      // Reconcile the official Client object layer so the Session is visible
      // and addressable synchronously. A reconciliation failure is
      // POST-PUBLICATION: it preserves the published identity.
      try {
        this.sessions.handleSessionAdded({
          sessionId: publishedId,
          updatedAt: Date.now(),
          running: false,
          blank: true,
          ...cwd === undefined ? {} : { cwd },
        })
      } catch (error) {
        return {
          ownership: 'current',
          outcome: {
            kind: 'published-with-error',
            sessionId: publishedId,
            error: { code: 'session/reconcile-failed', message: `the created Session could not be reconciled into Client state: ${remoteFailureMessage(error)}` },
          },
        }
      }
      if (this.sessions.binding(publishedId) === undefined) {
        return {
          ownership: 'current',
          outcome: {
            kind: 'published-with-error',
            sessionId: publishedId,
            error: { code: 'session/created-not-addressable', message: 'the created Session is not addressable in Client state' },
          },
        }
      }
      // A caller abort observed during the SYNCHRONOUS reconciliation cannot
      // un-publish the Session, but it does mean this result no longer owns the
      // surface: recompute ownership so it is `created + superseded`.
      return { ownership: ownership(), outcome: { kind: 'created', handle } }
    }
    let id: string
    try {
      id = String(await this.sessions.create({
        sessionId: request.sessionId,
        ...cwd === undefined ? {} : { cwd },
      }))
    } catch (error) {
      return { ownership: ownership(), outcome: classifyCreateFailure(error, request.sessionId) }
    }
    return { ownership: ownership(), outcome: { kind: 'created', handle: { session: { id } } } }
  }

  async open(request: OpenSessionRequest): Promise<OpenResult> {
    if (request.signal?.aborted === true) return { ownership: 'current', outcome: { kind: 'cancelled' } }
    // v2 §0.5: open is Client-local selection, but it still requires a valid
    // current Client generation; a disconnected Client cannot select.
    const captured = this.generation.getSnapshot()
    if (captured === undefined) {
      return { ownership: 'current', outcome: { kind: 'unavailable', message: `session "${request.sessionId}" cannot be opened: the remote connection is not connected` } }
    }
    // Fail closed when the id is not an addressable Client Session — before
    // mutating the Client's current selection.
    if (this.sessions.binding(request.sessionId) === undefined) {
      return { ownership: 'current', outcome: { kind: 'unavailable', message: `session "${request.sessionId}" is not available in Client state` } }
    }
    this.sessions.open(request.sessionId)
    if (this.sessions.binding(request.sessionId) === undefined) {
      return { ownership: 'current', outcome: { kind: 'unavailable', message: `session "${request.sessionId}" could not be opened in Client state` } }
    }
    // The local selection is only this operation's result while the Client
    // generation that owned it is still current.
    const ownershipNow: OperationOwnership = Object.is(captured, this.generation.getSnapshot()) ? 'current' : 'superseded'
    return { ownership: ownershipNow, outcome: { kind: 'opened', handle: { session: { id: request.sessionId } } } }
  }

  async fork(request: ForkSessionRequest): Promise<ForkResult> {
    // The semantic port accepts only canonical event sequence anchors; the
    // official Client performs its own flooring for lower-level callers, but
    // this adapter must not create a Remote-only normalization rule.
    if (request.atSeq !== undefined
      && (!Number.isSafeInteger(request.atSeq) || request.atSeq < 0)) {
      return { ownership: 'current', outcome: { kind: 'rejected', error: { code: 'gateway/bad-request', message: 'atSeq must be a non-negative safe integer' } } }
    }
    const captured = this.generation.getSnapshot()
    if (captured === undefined) {
      return { ownership: 'current', outcome: { kind: 'rejected', error: { code: 'session/fork-unavailable', message: 'the remote connection is not connected' } } }
    }
    const ownership = (): OperationOwnership =>
      Object.is(captured, this.generation.getSnapshot()) ? 'current' : 'superseded'
    let childId: string
    try {
      // The official ClientSessions fork owns Host dispatch, child identity,
      // cut, lineage, workspace and Client-state reconciliation. This is one
      // call only; no retry is legal for any failure below.
      childId = String(await this.sessions.fork({
        sessionId: request.sourceSessionId,
        ...request.atSeq === undefined ? {} : { atSeq: request.atSeq },
      }))
    } catch (error) {
      return { ownership: ownership(), outcome: classifyForkFailure(error) }
    }
    if (childId === '') {
      return {
        ownership: ownership(),
        outcome: { kind: 'indeterminate', error: { code: 'session/fork-result-invalid', message: 'the Host returned an unusable fork Session id' } },
      }
    }
    const handle = { session: { id: childId } }
    // A reconnect after dispatch does not turn a known Host success into an
    // error; the child is real, but the old Client navigation no longer owns it.
    if (ownership() === 'superseded') return { ownership: 'superseded', outcome: { kind: 'forked', handle } }
    if (this.sessions.binding(childId) === undefined) {
      return {
        ownership: 'current',
        outcome: {
          kind: 'published-with-error',
          sessionId: childId,
          error: { code: 'session/fork-not-addressable', message: 'the forked Session is not addressable in Client state' },
        },
      }
    }
    return { ownership: 'current', outcome: { kind: 'forked', handle } }
  }
}
