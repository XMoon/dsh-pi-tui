/**
 * The session LIFECYCLE domain port (D2.1 contract convergence, D2.3
 * semantic convergence): the transport-neutral semantic boundary for
 * creating a fresh Session and opening an existing Session.
 *
 * D2.3 removed the ordinary `provider`/`model` semantic inputs. The official
 * create/open contracts own only current Client/Host concepts (session id,
 * location/preset metadata) and derive the activation model from the Host
 * global default; a Direct adapter that still needs in-process activation
 * options resolves them from the Host default service itself, never from the
 * cross-backend request.
 *
 * Open is the official Client semantic `select/open this Session` — not
 * `resume a Host Agent`. The Direct adapter still calls `agents.resume()`
 * internally so the in-process TUI has a live Agent; a Remote adapter maps
 * the same operation to `ClientSessions.open()/binding()`.
 *
 * `meta` still carries the Direct session-header metadata (cwd, parent session
 * and the seeded marker); `seed`/`inheritedEventCount` remain Direct D2.4
 * fork/rewind inputs and must not be described as an already Remote-ready wire
 * payload. The DIRECT adapter still supports them (fork/rewind rely on it); the
 * REMOTE adapter fails closed on a seeded create until D2.4 owns Host fork.
 *
 * Requests carry serializable data plus the explicitly client-local lifecycle
 * signal. The signal is never serialized; a Remote adapter maps it to its own
 * client/connection cancellation. Results carry Session identity and, only
 * for Direct, the ownership escape needed by the current runner.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/session-lifecycle-port
 */

import type { OperationOwnership, WriteError } from './write-outcome.ts'

/** Create one fresh session (the /new and first-session paths). The identity,
 * cwd-like metadata and preset are semantic intent. The seed, inherited count
 * and parent metadata are current Direct fork/rewind creation inputs; D2.4
 * owns their Host-fork convergence. `signal` is client-local and never
 * serialized. */
export interface CreateSessionRequest {
  /** The pre-generated session identity (the TUI owns the id). */
  sessionId: string
  /** Durable session metadata (currently includes cwd, parent session and the
   * Direct seeded-session marker). D2.4 owns convergence of fork metadata. */
  meta: Record<string, unknown>
  /** Semantic preset intent; the Direct adapter resolves its setup. */
  agentPreset?: string
  /** Current Direct fork/rewind seed; D2.4 owns Host fork convergence. */
  seed?: readonly unknown[]
  /** Current Direct fork/rewind inherited prefix length. */
  inheritedEventCount?: number
  /** Client-local creation cancellation; never serialized. */
  signal?: AbortSignal
}

/** Open a persisted session (the ordinary Client semantic:
 * `select/open this Session`, NOT `resume a Host Agent`). The Direct adapter
 * resolves the persisted preset and activation fallback internally. */
export interface OpenSessionRequest {
  /** The persisted Session identity to open. */
  sessionId: string
  /** Client-local open cancellation; never serialized. */
  signal?: AbortSignal
}

/** The lightweight outcome of a lifecycle operation — the cross-backend
 * session identity. Direct backends additionally carry the ownership escape:
 * the live Agent and real AgentHandle. Remote backends leave `direct`
 * undefined; the client runtime owns the Session there. */
export interface SessionHandle {
  readonly session: { readonly id: string }
  /** Direct-only ownership escape. The runner disposes the real owner handle
   * on retirement; a Remote backend leaves it undefined. */
  readonly direct?: {
    readonly agent: unknown
    readonly ownerHandle: unknown
  }
}

/** The session LIFECYCLE domain port. */
export interface SessionLifecycle {
  create(request: CreateSessionRequest): Promise<CreateResult>
  open(request: OpenSessionRequest): Promise<OpenResult>
}

/**
 * The CREATE settlement (v2 §0.3.4/§0.7.3): a lifecycle-specific outcome, NOT a
 * plain `WriteOutcome<void>`. `published-with-error` preserves the identity the
 * Host published even though a later step failed; `indeterminate` keeps the
 * requested id as CORRELATION ONLY (`requestedSessionId` is never publication
 * evidence).
 */
export type CreateOutcome =
  | { readonly kind: 'created'; readonly handle: SessionHandle }
  | { readonly kind: 'rejected'; readonly error: WriteError }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'published-with-error'; readonly sessionId: string; readonly error: WriteError }
  | { readonly kind: 'indeterminate'; readonly error: WriteError; readonly requestedSessionId?: string }

/** The OPEN settlement (v2 §0.3.5/§0.7.4): Client-local selection, never an
 *  indeterminate Host write. */
export type OpenOutcome =
  | { readonly kind: 'opened'; readonly handle: SessionHandle }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'cancelled' }

/** A lifecycle settlement paired with its local ownership (v2 §0.2.1). The
 *  axes are independent: `created + superseded` and `rejected + superseded`
 *  are both real and legal. */
export interface CreateResult {
  readonly ownership: OperationOwnership
  readonly outcome: CreateOutcome
}

/** A lifecycle open result paired with its local ownership. */
export interface OpenResult {
  readonly ownership: OperationOwnership
  readonly outcome: OpenOutcome
}

/** Every settlement a lifecycle error can carry (machine-readable, never a
 *  bare message). */
export type LifecycleSettlement = CreateOutcome['kind'] | OpenOutcome['kind'] | 'superseded'

/** A lifecycle outcome that must ABORT the caller's transition, carrying the
 *  two independent axes so a Remote caller never has to parse a string. */
export class LifecycleError extends Error {
  readonly settlement: LifecycleSettlement
  readonly ownership: OperationOwnership
  readonly publishedSessionId: string | undefined
  /** CORRELATION ONLY for an indeterminate create — never publication proof. */
  readonly requestedSessionId: string | undefined

  constructor(
    settlement: LifecycleSettlement,
    ownership: OperationOwnership,
    message: string,
    publishedSessionId?: string,
    requestedSessionId?: string,
  ) {
    super(message)
    this.name = 'LifecycleError'
    this.settlement = settlement
    this.ownership = ownership
    this.publishedSessionId = publishedSessionId
    this.requestedSessionId = requestedSessionId
  }
}

/** Unwrap a CREATE result for the runner's transition: a `created` result that
 *  still owns the surface yields the handle; everything else aborts with a
 *  machine-readable `LifecycleError` (a superseded create is NOT committed to
 *  the local surface, though its identity stays available). */
export function requireCreated(result: CreateResult): SessionHandle {
  const { ownership, outcome } = result
  switch (outcome.kind) {
    case 'created':
      if (ownership === 'superseded') {
        throw new LifecycleError('superseded', ownership,
          'the Session was created but the local surface was superseded', outcome.handle.session.id)
      }
      return outcome.handle
    case 'published-with-error':
      throw new LifecycleError(outcome.kind, ownership,
        `the Session may already have been published: ${outcome.error.message} (${outcome.error.code})`,
        outcome.sessionId)
    case 'indeterminate':
      throw new LifecycleError(outcome.kind, ownership,
        `the create is indeterminate — do not retry: ${outcome.error.message} (${outcome.error.code})`,
        undefined, outcome.requestedSessionId)
    case 'rejected':
      throw new LifecycleError(outcome.kind, ownership, `${outcome.error.message} (${outcome.error.code})`, undefined)
    case 'cancelled':
      throw new LifecycleError('cancelled', ownership, 'the Session creation was cancelled before dispatch', undefined)
  }
}

/** Unwrap an OPEN result for the runner's transition. */
export function requireOpened(result: OpenResult): SessionHandle {
  const { ownership, outcome } = result
  switch (outcome.kind) {
    case 'opened':
      if (ownership === 'superseded') {
        throw new LifecycleError('superseded', ownership,
          'the Session was opened but the local surface was superseded', outcome.handle.session.id)
      }
      return outcome.handle
    case 'unavailable':
      throw new LifecycleError('unavailable', ownership, outcome.message, undefined)
    case 'cancelled':
      throw new LifecycleError('cancelled', ownership, 'the Session open was cancelled before selection', undefined)
  }
}

/** Extract the Direct ownership handle (the real AgentHandle with
 * `dispose()`) from a lifecycle result. Accepts both the converged
 * SessionHandle and a legacy AgentHandle so transition code cannot lose the
 * ownership capability. Remote handles lack `direct` and yield undefined. */
export function ownerHandleOf(next: unknown): unknown {
  const handle = next as { dispose?: unknown; direct?: { ownerHandle?: unknown } }
  if (handle.direct?.ownerHandle !== undefined) return handle.direct.ownerHandle
  if (typeof handle.dispose === 'function') return handle
  return undefined
}

/** Extract the live in-process agent from a lifecycle result (the Direct
 * SessionHandle via `direct.agent`, or a legacy AgentHandle's `agent`).
 * Remote handles yield undefined. */
export function directAgentOf(next: unknown): unknown {
  const handle = next as { agent?: unknown; direct?: { agent?: unknown } }
  return handle.direct?.agent ?? handle.agent
}
