/**
 * The Direct session lifecycle (D2.1–D2.4) — the in-process
 * implementation of `SessionLifecycle` over the dsh `agents` service.
 *
 * D2.3 moved ordinary create/open activation requirements INSIDE the adapter.
 * D2.4 does the same for fork: this adapter maps the official Host fork
 * algorithm (observation, the alpha.2 boundary contract — an explicit `atSeq`
 * is an EXACT inclusive event cut, an omitted one selects the latest completed
 * prefix —, the official `buildForkSeed` repair, lineage, preset, default model
 * and workspace attachment) without exposing those details through the
 * semantic port.
 *
 * The adapter is the only module in these lifecycle paths that touches `ctx`
 * and the preset composition. It keeps the real AgentHandle ownership escape
 * required by the current Direct runner.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-lifecycle-direct
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { recordedSessionPreset } from './session-preset-direct.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import type {
  CreateResult,
  CreateSessionRequest,
  ForkResult,
  OpenResult,
  OpenSessionRequest,
  SessionLifecycle,
} from '../session-lifecycle-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The Host default-model service the Direct activation fallback reads. */
export interface DefaultModelServiceLike {
  currentSelection(): { readonly provider: string; readonly model: string } | undefined
}

/** The preset composition the adapter resolves internally (the runner's
 * compose function satisfies this structurally). */
export interface CompositionLike {
  agentPreset?: string
  setup: (agentCtx: Context, agent: Agent) => Promise<void> | void
}

/** The structural `agents` service surface the lifecycle needs. */
export interface AgentsServiceLike {
  create(options: {
    sessionId: ReturnType<typeof SessionId>
    meta: Record<string, unknown>
    agentOptions: { provider?: string; model?: string }
    setup: (agentCtx: Context, agent: Agent) => Promise<void> | void
    seed?: readonly SessionEvent[]
    /** Exact fork-inherited prefix length when `meta.isSeeded` is set. */
    inheritedEventCount?: ReturnType<typeof SessionLogOffset>
    signal?: AbortSignal
  }): Promise<AgentHandle>
  resume(options: {
    resumeSessionId: ReturnType<typeof SessionId>
    agentOptions: { provider?: string; model?: string }
    setup: (agentCtx: Context, agent: Agent) => Promise<void> | void
    signal?: AbortSignal
  }): Promise<AgentHandle>
}

/** Structural observation used by the private Direct fork mapping. */
export interface ForkObservationLike {
  readonly header: {
    readonly id: string
    readonly cwd?: string
    readonly origin?: string
  }
  readonly events: readonly SessionEvent[]
  readonly projections: { readonly values: { readonly agentPreset?: string | null } }
  [Symbol.dispose](): void
}

/** The official DSH session-query fork subset. */
export interface ForkSessionQueryLike {
  observeSession(sessionId: ReturnType<typeof SessionId>): Promise<ForkObservationLike>
  traceSession?(sessionId: string): Promise<{
    readonly ancestors: readonly { readonly header: { readonly id: string } }[]
  }>
}

/** The official workspace subset used by the Host fork algorithm. */
export interface ForkWorkspaceLike {
  readonly id: string
  readonly sessionIds: readonly string[]
  attachSession(sessionId: ReturnType<typeof SessionId>): Promise<void>
}

export interface ForkWorkspaceRegistryLike {
  list(): readonly ForkWorkspaceLike[]
}

/** Direct-only owner handoff. The runner parks a child when navigation is
 * superseded and the adapter claims it before opening that child later. */
export interface DirectOwnerPoolLike {
  claim(sessionId: string): AgentHandle | undefined
  park(handle: AgentHandle): void
  /** Await any in-flight retirement of THIS session's owner before resuming it.
   * The persistence write claim is exclusive, so resuming a still-live handle
   * (`session "X" is already owned by an active write handle`) would fail while
   * its lease is held; a reopen must therefore follow the release.
   *
   * INVARIANTS (removing either re-creates a transition-gate/pin deadlock):
   * 1. The release must NEVER require the transition gate. The deferred `/fork`
   *    retirement is started at the command settlement, AFTER `adoptFork`
   *    released the gate; keep it that way.
   * 2. `switchSessionLocked`'s same-session no-op guard stays: the pin can only
   *    be awaited while the source is no longer current (a fork that still needs
   *    the gate has `liveAgent.session.id === sourceSessionId`, and that switch
   *    returns early exactly then). */
  waitForRelease?(sessionId: string): Promise<void>
}

/** The Direct backend's session lifecycle: the `ctx.agents` service behind
 * the semantic `SessionLifecycle` interface. The preset composition (and
 * with it the agent-setup callback) is resolved here from the request's
 * preset id — it never crosses the port contract. The activation
 * provider/model fallback is the Host global default, exactly like the
 * official `ApiSessionAgentController.agentOptions()`. */
export class DirectSessionLifecycle implements SessionLifecycle {
  private readonly ctx: HostContextLike
  private readonly compose: (presetId?: string) => Promise<CompositionLike>
  private readonly ownerPool: DirectOwnerPoolLike | undefined

  constructor(
    ctx: HostContextLike,
    compose: (presetId?: string) => Promise<CompositionLike>,
    ownerPool?: DirectOwnerPoolLike,
  ) {
    this.ctx = ctx
    this.compose = compose
    this.ownerPool = ownerPool
  }

  /** The in-process activation fallback: the Host global default, never a
   *  cross-backend request input. */
  private agentOptions(): { provider?: string; model?: string } {
    const selection = (this.ctx.get('agentDefaultModel') as DefaultModelServiceLike | undefined)?.currentSelection()
    return selection === undefined ? {} : { provider: selection.provider, model: selection.model }
  }

  async create(request: CreateSessionRequest): Promise<CreateResult> {
    if (Boolean(request.signal?.aborted)) return { ownership: 'current', outcome: { kind: 'cancelled' } }
    const agents = this.ctx.get('agents') as AgentsServiceLike | undefined
    if (agents === undefined) {
      return currentCreateRejected('session/create-unavailable', 'agents service unavailable')
    }
    // Capture the Host default at ADMISSION (v2 §0.8.3): a later sessionless
    // `/model` default write must not rewrite an already-started create.
    const agentOptions = this.agentOptions()
    try {
      // The preset composition (with its agent-setup callback) is a Direct
      // concern: resolved inside the adapter from the request's preset id.
      const composition = await this.compose(request.agentPreset)
      // The semantic `agentPreset` is the SINGLE preset authority: the adapter
      // persists the preset it actually composed in the ordinary header.
      const handle = await agents.create({
        sessionId: SessionId(request.sessionId),
        meta: {
          ...request.cwd === undefined ? {} : { cwd: request.cwd },
          ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
        },
        agentOptions,
        setup: composition.setup,
        signal: request.signal,
      })
      // Preserve both the live Agent and the real AgentHandle. The latter is
      // the ownership capability the runner disposes at retirement. The Direct
      // adapter is the only writer for its own in-process Agent, so its result
      // always owns the current surface.
      return {
        ownership: 'current',
        outcome: { kind: 'created', handle: { session: { id: String(handle.agent.session.id) }, direct: { agent: handle.agent, ownerHandle: handle } } },
      }
    } catch (error) {
      // The upstream `agents.create` signal is a PRE-PUBLICATION cancellation
      // contract: an abort mid-create provably did not publish (v2 §0.2.4), so
      // it stays `cancelled` instead of a bogus rejection.
      if (Boolean(request.signal?.aborted)) return { ownership: 'current', outcome: { kind: 'cancelled' } }
      // Any other in-process create failure is a proven pre-publication
      // rejection (there is no wire ambiguity in the Direct path).
      return currentCreateRejected('session/create-failed', safeErrorMessage(error))
    }
  }

  /**
   * Await a pending Direct owner release, honoring the caller's cancellation.
   * @returns `true` when the release settled (or there was none), `false` when
   *   the signal aborted first — the caller then settles as `cancelled`
   *   instead of staying pending behind a slow retirement.
   */
  private async waitForReleaseOrAbort(sessionId: string, signal: AbortSignal | undefined): Promise<boolean> {
    const release = this.ownerPool?.waitForRelease?.(sessionId)
    if (release === undefined) return true
    if (signal === undefined) {
      await release
      return true
    }
    if (signal.aborted) return false
    let onAbort: (() => void) | undefined
    const aborted = new Promise<false>(resolve => {
      onAbort = () => resolve(false)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([release.then(() => true), aborted])
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  async open(request: OpenSessionRequest): Promise<OpenResult> {
    if (Boolean(request.signal?.aborted)) return { ownership: 'current', outcome: { kind: 'cancelled' } }
    // A successful Direct fork whose navigation was superseded already owns a
    // live Agent and SessionWriteLease. Claim it before any cold observation or
    // `agents.resume()` so opening the parked child never creates a second
    // writer for the same Session.
    const parked = this.ownerPool?.claim(request.sessionId)
    if (parked !== undefined) {
      return {
        ownership: 'current',
        outcome: { kind: 'opened', handle: { session: { id: String(parked.agent.session.id) }, direct: { agent: parked.agent, ownerHandle: parked } } },
      }
    }
    const agents = this.ctx.get('agents') as AgentsServiceLike | undefined
    if (agents === undefined) {
      return { ownership: 'current', outcome: { kind: 'unavailable', message: 'agents service unavailable' } }
    }
    // Capture the activation fallback at admission (v2 §0.8.3) — BEFORE any
    // await, including the owner-release wait below: a global `/model` default
    // change while this open waits must not leak into this resume.
    const agentOptions = this.agentOptions()
    // A source owner whose retirement is still in flight must be released
    // before it can be resumed: the persistence write claim is exclusive, so
    // resuming the still-live handle would fail. `claim` above already handled
    // a PARKED owner; this handles the one being retired. The wait honors the
    // caller's cancellation: an aborted open must not stay pending behind a
    // slow retirement.
    if (!await this.waitForReleaseOrAbort(request.sessionId, request.signal)) {
      return { ownership: 'current', outcome: { kind: 'cancelled' } }
    }
    try {
      // The Direct adapter owns the persisted-preset lookup the official open
      // semantic needs in-process: the recorded preset wins (a session that
      // switched while blank ran every turn under the newer composition).
      const recorded = await recordedSessionPreset(this.ctx, request.sessionId, request.signal)
      const composition = await this.compose(recorded)
      // `resume` is deliberately the Direct service call; `open` is the
      // transport-neutral semantic exposed to the runner and future clients.
      const handle = await agents.resume({
        resumeSessionId: SessionId(request.sessionId),
        agentOptions,
        setup: composition.setup,
        signal: request.signal,
      })
      return {
        ownership: 'current',
        outcome: { kind: 'opened', handle: { session: { id: String(handle.agent.session.id) }, direct: { agent: handle.agent, ownerHandle: handle } } },
      }
    } catch (error) {
      // A mid-open abort is a client-local cancellation, not an unavailable
      // Session (v2 §0.2.4/§0.5).
      if (Boolean(request.signal?.aborted)) return { ownership: 'current', outcome: { kind: 'cancelled' } }
      return { ownership: 'current', outcome: { kind: 'unavailable', message: safeErrorMessage(error) } }
    }
  }

  /** Map the official alpha.2 Host fork algorithm into the Direct
   * implementation. The only raw seed construction in the repository is the
   * OFFICIAL `buildForkSeed()` called here, immediately next to
   * `agents.create`; commands and the semantic port see only the source id and
   * optional exact event cut. */
  async fork(request: { readonly sourceSessionId: string; readonly atSeq?: number }): Promise<ForkResult> {
    // The semantic port supplies a canonical event sequence; reject forged
    // non-canonical values consistently with the Remote adapter.
    const atSeq = request.atSeq
    if (atSeq !== undefined
      && (!Number.isSafeInteger(atSeq) || atSeq < 0)) {
      return currentForkRejected('gateway/bad-request', 'atSeq must be a non-negative safe integer')
    }
    const agents = this.ctx.get('agents') as AgentsServiceLike | undefined
    if (agents === undefined) return currentForkRejected('gateway/internal', 'agents service unavailable')
    const query = this.ctx.get('sessionQuery') as ForkSessionQueryLike | undefined
    if (query === undefined) return currentForkRejected('gateway/internal', 'session query service unavailable')

    let source: ForkObservationLike
    try {
      source = await query.observeSession(SessionId(request.sourceSessionId))
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined
      return currentForkRejected(
        code === 'SESSION_QUERY_SESSION_NOT_FOUND' ? 'session/not-found' : 'gateway/internal',
        `fork source unavailable: ${safeErrorMessage(error)}`,
      )
    }
    try {
      // The alpha.2 contract: an explicit `atSeq` is the EXACT inclusive cut
      // (never moved to a later `turn/end`); an omitted one selects the latest
      // completed prefix. The canonical-event proof below mirrors the official
      // STRICT `source.events[boundary]?.seq === boundary` check — no numeric
      // coercion, so a non-canonical observation seq (e.g. a forged string)
      // rejects exactly like the Host.
      const boundary = atSeq === undefined
        ? latestCompletedPrefixBoundary(source.events)
        : SessionSeq(atSeq)
      const lastSeq = source.events.at(-1)?.seq ?? -1
      if (boundary === undefined || source.events[boundary]?.seq !== boundary) {
        return currentForkRejected(
          'session/fork-unavailable',
          atSeq === undefined
            ? `session "${request.sourceSessionId}" has no completed turn to fork from`
            : `event ${String(atSeq)} does not exist in session "${request.sourceSessionId}" (last seq: ${lastSeq === -1 ? 'none' : String(lastSeq)})`,
        )
      }

      let workspace: ForkWorkspaceLike | undefined
      try {
        workspace = await this.forkWorkspace(source)
      } catch (error) {
        return currentForkRejected('gateway/internal', `failed to resolve fork workspace: ${safeErrorMessage(error)}`)
      }
      const preset = source.projections.values.agentPreset ?? undefined
      let composition: CompositionLike
      try {
        composition = await this.compose(preset)
      } catch (error) {
        // A composition failure is an in-process infrastructure failure, never
        // a Host fork refusal: `session/fork-unavailable` means "the source has
        // no legal fork boundary" and nothing else.
        return currentForkRejected('gateway/internal', `failed to compose fork session: ${safeErrorMessage(error)}`)
      }
      // Official `buildForkSeed` owns the seed: the inherited prefix
      // `[0..boundary]`, the child-owned `session/end-seed { inherited: true }`
      // marker and the synthetic fork closers for an open tail. Repair records
      // live AFTER the inherited cut, so `inheritedEventCount` stays exactly
      // `boundary + 1` even though `seed.length` may exceed it.
      const seed = buildForkSeed(source.events, boundary)
      const inheritedEventCount = SessionLogOffset(boundary + 1)
      const childMeta: Record<string, unknown> = {
        ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
        parentSession: source.header.id,
        isSeeded: true,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      }
      let handle: AgentHandle
      try {
        handle = await agents.create({
          sessionId: SessionId(`session-${randomUUID()}`),
          seed,
          inheritedEventCount,
          meta: childMeta,
          agentOptions: this.agentOptions(),
          setup: composition.setup,
        })
      } catch (error) {
        // The child was never published; an in-process `agents.create` failure
        // is a Host-internal failure, matching the official
        // `SessionCommandController.fork` mapping (there is no
        // `session/fork-failed` business code in the official taxonomy).
        return currentForkRejected('gateway/internal', `failed to fork session "${request.sourceSessionId}": ${safeErrorMessage(error)}`)
      }
      const child = { session: { id: String(handle.agent.session.id) }, direct: { agent: handle.agent, ownerHandle: handle } }
      if (workspace !== undefined) {
        try {
          await workspace.attachSession(SessionId(child.session.id))
        } catch (error) {
          return {
            ownership: 'current',
            outcome: {
              kind: 'published-with-error',
              sessionId: child.session.id,
              handle: child,
              error: {
                code: 'session/workspace-attach-failed',
                message: `Session "${child.session.id}" was forked but could not attach to workspace "${workspace.id}": ${safeErrorMessage(error)}`,
                details: { workspaceId: workspace.id },
              },
            },
          }
        }
      }
      return { ownership: 'current', outcome: { kind: 'forked', handle: child } }
    } finally {
      source[Symbol.dispose]()
    }
  }

  private async forkWorkspace(source: ForkObservationLike): Promise<ForkWorkspaceLike | undefined> {
    const registry = this.ctx.get('workspaceRegistry') as ForkWorkspaceRegistryLike | undefined
    if (registry === undefined) return undefined
    const workspaces = registry.list()
    const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.header.id))
    if (direct !== undefined || source.header.origin !== 'subagent') return direct
    const query = this.ctx.get('sessionQuery') as ForkSessionQueryLike | undefined
    if (query?.traceSession === undefined) return undefined
    const lineage = await query.traceSession(source.header.id)
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
      if (workspace !== undefined) return workspace
    }
    return undefined
  }
}

/** Resolve the omitted-`atSeq` default to the latest completed-turn prefix,
 * including standalone stable events before the next turn / queued-input
 * admission boundary. The exact alpha.2 Host selector (`latestCompletedPrefix
 * Boundary` in the official Session Controller) — omitted default cut
 * selection is Host semantics, not picker semantics, so this private mapping
 * lives immediately beside the fork adapter. */
function latestCompletedPrefixBoundary(events: readonly SessionEvent[]): ReturnType<typeof SessionSeq> | undefined {
  const lastTurnEnd = events.findLast(event => event.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined
  let boundary = Number(lastTurnEnd.seq)
  for (const next of events.slice(boundary + 1)) {
    if (next.type === 'turn/start'
      || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced') break
    boundary = Number(next.seq)
  }
  return SessionSeq(boundary)
}

/** A Direct create rejection that still owns the local surface. */
function currentCreateRejected(code: string, message: string): CreateResult {
  return { ownership: 'current', outcome: { kind: 'rejected', error: { code, message } } }
}

function currentForkRejected(code: string, message: string): ForkResult {
  return { ownership: 'current', outcome: { kind: 'rejected', error: { code, message } } }
}
