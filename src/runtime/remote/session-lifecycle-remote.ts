/**
 * Experimental Remote implementation of the semantic SessionLifecycle port
 * (D2.3–D2.4, aligned to the published DSH 0.2.1-rc.2 Client contract).
 *
 * The published Client contract keeps Session lifetime as explicit reference
 * ownership: `retain()` owns one exact generation, `binding()` only borrows, `create()`
 * and `fork()` publish a catalogued identity WITHOUT guaranteeing a binding,
 * and the Client's own current-selection slot is gone (navigation belongs to
 * the view owner). Three consequences shape this adapter:
 *
 * 1. Create maps to ONE official `ClientSessions.create()` for ordinary and
 *    explicit-preset creates alike: rc.2 takes `{sessionId, cwd, agentPreset}`
 *    and records the published catalog row itself, so there is no raw
 *    `session.create` path, no `sessions.refresh()` reconciliation and no
 *    `create()` + `agentPresets.select()` emulation. The adapter then RETAINS
 *    the returned id for the TUI's visible main surface. A locally superseded
 *    navigation still reports the real publication but takes no ownership.
 * 2. Open is the official Client semantic `select/open this Session`, now
 *    expressed as `sessions.retain(id, { source: 'tuiMainView' })`. `ready` is
 *    never awaited: official Web navigation commits the new owner before the
 *    initial history open settles.
 * 3. Host-owned fork maps to the official `ClientSessions.fork()` exactly once
 *    with `allowMigration:false`, so deriving a child never silently migrates
 *    the source record; the user's explicit open/resume remains the only path
 *    that may trigger the official migration. No seed payload or child identity
 *    crosses this adapter.
 *
 * Fork resolution means only "the child is catalogued" — it is NOT a binding
 * and it does NOT retain: publication is deliberately independent from
 * navigation adoption, so a superseded fork leaves a real child that the TUI
 * must not select. Adoption happens on the caller's navigation path through
 * `open()` above.
 *
 * A create error is operation-specific: a post-publication error is never
 * reported as "the Session was never created", its published identity is
 * machine-readable, a Connection generation replaced mid-RPC is indeterminate,
 * and no same-id retry happens.
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
  SessionHandle,
  SessionLifecycle,
} from '../session-lifecycle-port.ts'
import type { OperationOwnership } from '../write-outcome.ts'
import { GATEWAY_PRE_INVOCATION_CODES } from '../write-outcome.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import {
  acquireMainSurfaceReference,
  type MainSurfaceReference,
  type RemoteSessionReferenceLike,
  type RemoteSessionTarget,
  type TuiSessionReferenceSource,
} from './session-reference.ts'
import { remoteFailureCode, remoteFailureMessage } from './write-failure.ts'

/** The official `ClientSessions` subset the lifecycle needs. The generated
 * RemoteResult is already unwrapped by ClientSessions.create/fork, so only the
 * returned identity crosses this boundary. */
export interface RemoteLifecycleSessions {
  /** The official rc.2 `create()`: ordinary and explicit-preset creates are
   * the SAME call — `agentPreset` is a creation-time input the Host consumes
   * atomically, and the Client records the published catalog row before
   * resolving. The optional argument shape mirrors the published `ISessions`. */
  create(opts?: {
    workspaceId?: string
    cwd?: string
    sessionId?: string
    agentPreset?: string
  }): Promise<string>
  /** The official rc.2 `fork()`. `allowMigration:false` refuses source
   * migration; omission preserves the Host default (which may migrate). */
  fork(opts: {
    readonly sessionId: string
    readonly atSeq?: number
    readonly allowMigration?: boolean
  }): Promise<string>
  retain(
    target: RemoteSessionTarget,
    options: { readonly source: TuiSessionReferenceSource; readonly signal?: AbortSignal },
  ): RemoteSessionReferenceLike
}

/** Read the caller's cancellation state. Kept behind a call so a re-read after
 * an await is not narrowed away by the pre-dispatch check. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
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
  // rc.2 refuses `allowMigration:false` for a source that needs migration.
  // That is a PROVEN business refusal (no child was produced), so it must
  // never be downgraded to `indeterminate` or retried.
  'session/migration-required',
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
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    sessions: RemoteLifecycleSessions,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.sessions = sessions
    this.generation = generation
  }

  async create(request: CreateSessionRequest): Promise<CreateResult> {
    // A provable PRE-dispatch cancellation is `cancelled` (never a throw).
    if (isAborted(request.signal)) return { ownership: 'current', outcome: { kind: 'cancelled' } }
    const cwd = request.cwd
    const captured = this.generation.getSnapshot()
    // A disconnected client must not dispatch through stale/queued state.
    if (captured === undefined) return { ownership: 'current', outcome: { kind: 'cancelled' } }
    // Ownership is a SEPARATE axis (v2 §0.2.1): a reconnect or a post-dispatch
    // abort means this result no longer owns the surface — it does NOT prove
    // the Host did not create the Session.
    const ownership = (): OperationOwnership =>
      !Object.is(captured, this.generation.getSnapshot()) || isAborted(request.signal)
        ? 'superseded'
        : 'current'
    // ONE official Client create for every create: rc.2 `ClientSessions.create`
    // accepts `agentPreset` as a creation-time input and records the published
    // catalog row before resolving, so `retain()` below is immediately valid.
    let id: unknown
    try {
      id = await this.sessions.create({
        ...cwd === undefined ? {} : { cwd },
        sessionId: request.sessionId,
        ...request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset },
      })
    } catch (error) {
      return { ownership: ownership(), outcome: classifyCreateFailure(error, request.sessionId) }
    }
    // The wire envelope parser does not validate the nested payload: a
    // malformed success must not fake a created Session identity.
    if (typeof id !== 'string' || id === '') {
      return {
        ownership: ownership(),
        outcome: {
          kind: 'indeterminate',
          error: { code: 'session/create-result-invalid', message: 'the Host returned an unusable Session id' },
          requestedSessionId: request.sessionId,
        },
      }
    }
    const handle: SessionHandle = { session: { id } }
    // The Host success is the authoritative publication. A navigation that was
    // superseded while the create was in flight must NOT take Client ownership:
    // the child stays real and catalogued for a later explicit open.
    if (ownership() === 'superseded') return { ownership: 'superseded', outcome: { kind: 'created', handle } }
    return this.ownPublishedSession(id, ownership, request.signal)
  }

  /**
   * Take Client generation ownership of a just-published Session.
   *
   * A retain failure is POST-PUBLICATION: the identity stays authoritative and
   * creation must never be retried, so it settles `published-with-error`
   * carrying the published id rather than pretending nothing was created.
   *
   * `retain` publishes reference counts and can synchronously notify a
   * subscriber that cancels/supersedes the navigation, so ownership is re-read
   * AFTER acquisition on BOTH paths: a superseded create must release the new
   * generation instead of handing it to a caller that will discard it (a leak),
   * and an acquisition refused by an already-aborted signal is `superseded`,
   * never a fabricated `current`.
   */
  private ownPublishedSession(
    id: string,
    ownership: () => OperationOwnership,
    signal: AbortSignal | undefined,
  ): CreateResult {
    let owner: MainSurfaceReference
    try {
      owner = acquireMainSurfaceReference(this.sessions, id, signal)
    } catch (error) {
      return {
        ownership: ownership(),
        outcome: {
          kind: 'published-with-error',
          sessionId: id,
          error: { code: 'session/reconcile-failed', message: `the created Session could not be retained in Client state: ${remoteFailureMessage(error)}` },
        },
      }
    }
    if (ownership() === 'superseded') {
      owner.release()
      return { ownership: 'superseded', outcome: { kind: 'created', handle: { session: { id } } } }
    }
    return { ownership: 'current', outcome: { kind: 'created', handle: { session: { id }, client: owner } } }
  }

  async open(request: OpenSessionRequest): Promise<OpenResult> {
    if (isAborted(request.signal)) return { ownership: 'current', outcome: { kind: 'cancelled' } }
    // v2 §0.5: open is Client-local selection, but it still requires a valid
    // current Client generation; a disconnected Client cannot select.
    const captured = this.generation.getSnapshot()
    if (captured === undefined) {
      return { ownership: 'current', outcome: { kind: 'unavailable', message: `session "${request.sessionId}" cannot be opened: the remote connection is not connected` } }
    }
    // published acquisition IS `retain`: it materializes the exact generation
    // (and starts its initial history open) without moving any Client-global
    // selection. An unknown identity throws instead of silently succeeding.
    let owner: MainSurfaceReference
    try {
      owner = acquireMainSurfaceReference(this.sessions, request.sessionId, request.signal)
    } catch (error) {
      // A mid-acquisition abort is a client-local cancellation; anything else
      // is an unavailable identity (never a fabricated Host outcome).
      if (isAborted(request.signal)) return { ownership: 'current', outcome: { kind: 'cancelled' } }
      return { ownership: 'current', outcome: { kind: 'unavailable', message: `session "${request.sessionId}" is not available in Client state: ${remoteFailureMessage(error)}` } }
    }
    // `retain` publishes local reference counts and can synchronously notify
    // subscribers, so a navigation cancelled from that notification is a real
    // post-acquisition supersession: never leak the new generation's ownership.
    if (!Object.is(captured, this.generation.getSnapshot()) || isAborted(request.signal)) {
      owner.release()
      return { ownership: 'superseded', outcome: { kind: 'cancelled' } }
    }
    return {
      ownership: 'current',
      outcome: { kind: 'opened', handle: { session: { id: request.sessionId }, client: owner } },
    }
  }

  async fork(request: ForkSessionRequest): Promise<ForkResult> {
    // The semantic port accepts only canonical event sequences; the official
    // Host treats an explicit `atSeq` as the EXACT inclusive event cut
    // and rejects a nonexistent one, so this adapter must not create a
    // Remote-only normalization rule on top of it.
    if (request.atSeq !== undefined
      && (!Number.isSafeInteger(request.atSeq) || request.atSeq < 0)) {
      return { ownership: 'current', outcome: { kind: 'rejected', error: { code: 'gateway/bad-request', message: 'atSeq must be a non-negative safe integer' } } }
    }
    const captured = this.generation.getSnapshot()
    if (captured === undefined) {
      // CLIENT-LOCAL pre-dispatch refusal: nothing was dispatched, so there is
      // no Host settlement. `session/fork-unavailable` is a PROVEN Host
      // business refusal (no legal fork boundary) and must never be reused for
      // "this client is not connected".
      return { ownership: 'current', outcome: { kind: 'unavailable', message: 'the remote connection is not connected' } }
    }
    const ownership = (): OperationOwnership =>
      Object.is(captured, this.generation.getSnapshot()) ? 'current' : 'superseded'
    let childId: string
    try {
      // The official ClientSessions fork owns Host dispatch, child identity,
      // cut, lineage, workspace and Client-state reconciliation. This is one
      // call only; no retry is legal for any failure below. `allowMigration:
      // false` is always explicit: deriving a child must never silently migrate
      // the source record — only the user's explicit open/resume may.
      childId = String(await this.sessions.fork({
        sessionId: request.sourceSessionId,
        ...request.atSeq === undefined ? {} : { atSeq: request.atSeq },
        allowMigration: false,
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
    // Publication only (D2.4): a resolved child is catalogued, NOT retained and
    // NOT guaranteed to have a binding. A reconnect after dispatch does not
    // turn a known Host success into an error; the child is real, but the old
    // Client navigation no longer owns it. Retention happens when the caller's
    // navigation adopts the child through `open()`.
    return { ownership: ownership(), outcome: { kind: 'forked', handle: { session: { id: childId } } } }
  }
}
