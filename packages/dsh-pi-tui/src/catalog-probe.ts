/**
 * Surface catalog probe: one short-lived, zero-event Agent composition that
 * reads the effective command and human-skill catalogs BEFORE a surface
 * mounts, then disposes. The probe exists only to make the first
 * Agent-scoped catalog visible ahead of the first input; it is never a chat
 * session, never a live owner, and never a resume target.
 *
 * Lifecycle contract (see the plan):
 * - the handle lives in a LOCAL variable only; the same function's `finally`
 *   awaits its dispose on every path (success, failure, cancellation);
 * - `agents.create`'s signal covers creation only — the handle detaches on
 *   publication — so `whenIdle` and the catalog read race the caller signal
 *   themselves;
 * - the zero-event gate is a RELEASE precondition, not a cleanup hint: a
 *   probe that emitted session events fails loudly with the event
 *   breakdown; nothing here ever deletes or hides an artifact;
 * - a dispose failure is a resource-leak risk and surfaces as a primary
 *   (or combined) failure — a success catalog is never returned over a
 *   leaked handle;
 * - no `sessions.flush()` is called: dispose's retirement contract is the
 *   boundary, and an extra flush only adds side effects.
 *
 * The probe never imports the runner or the command surface; dependencies
 * arrive as narrow injected interfaces.
 * @module @xmoon76/dsh-pi-tui/catalog-probe
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { cancellationError, isCancellation } from './detached.ts'
import type { Diag } from './diag.ts'
import { safeErrorMessage } from './error-boundary.ts'
import type { SurfaceCatalogSnapshot } from './surface-catalog.ts'

/** The composition one probe mounts: the preset id to record (absent when
 * the deployment composes no roster) and the setup that installs it. */
export interface ProbeComposition {
  readonly agentPreset?: string
  setup(agentCtx: Context): Promise<void> | void
}

/** The agents-service surface the probe creates through (the structural
 * shape of `ctx.agents`, with the creation-only signal). */
export interface ProbeAgentsService {
  create(options: {
    sessionId: SessionId
    meta: Record<string, unknown>
    agentOptions: { provider?: string; model?: string }
    setup: (agentCtx: Context) => Promise<void> | void
    signal?: AbortSignal
  }): Promise<AgentHandle>
}

/** Options for {@link probeSurfaceCatalog}. */
export interface ProbeSurfaceCatalogOptions {
  /** The agents service that creates the probe. */
  readonly agents: ProbeAgentsService
  /** The composition the probe mounts (the SAME one a next chat session
   * would mount — the probe never re-implements preset precedence). */
  readonly composition: ProbeComposition
  /** Provider/model options passed to the agent factory. */
  readonly agentOptions: { provider?: string; model?: string }
  /** The workspace cwd recorded on the probe session's header. */
  readonly cwd: string
  /** Lifecycle/refresh cancellation; aborted before create → no probe. */
  readonly signal: AbortSignal
  /** The collector — probe and live agents share one `readSurfaceCatalog`. */
  readonly readCatalog: (agent: Agent, signal: AbortSignal) => Promise<SurfaceCatalogSnapshot>
  /** The runner diagnostics channel. */
  readonly diag: Diag
}

/**
 * A probe failure classified by WHEN it happened:
 * - `create` — no handle existed; a different composition may succeed (the
 *   caller may retry with the fallback default composition);
 * - `post-create` — the probe RAN and violated a release contract (zero
 *   events, dispose, collector, whenIdle) or failed after publication; the
 *   violation is composition-independent, so retrying cannot fix it and the
 *   caller MUST propagate it (a non-zero event or leaked handle is never a
 *   soft degrade).
 * Cancellations are rethrown as-is (never wrapped): the classifier must
 * recognize them.
 */
export class CatalogProbeError extends Error {
  readonly kind: 'create' | 'post-create'
  constructor(kind: 'create' | 'post-create', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CatalogProbeError'
    this.kind = kind
  }
}

/**
 * Run one catalog probe to completion and return the detached snapshot.
 *
 * The probe's session id is a legal, globally-unique ordinary `SessionId`
 * (`session-<uuid>` — the same schema the runner uses for real sessions);
 * diagnostics distinguish the probe by the `catalog probe *` labels, never
 * by parsing the id.
 * @param options - injected dependencies (see {@link ProbeSurfaceCatalogOptions}).
 * @returns the frozen catalog snapshot.
 * @throws on creation failure (no handle to dispose), cancellation (the
 *   handle — if published — is still disposed by `finally`), a non-zero
 *   event gate violation, a collector failure, or a dispose failure.
 */
export async function probeSurfaceCatalog(options: ProbeSurfaceCatalogOptions): Promise<SurfaceCatalogSnapshot> {
  const { agents, composition, agentOptions, cwd, signal, readCatalog, diag } = options
  signal.throwIfAborted()
  const sessionId = SessionId(`session-${randomUUID()}`)
  const startedAt = Date.now()
  diag.info('catalog probe start', {
    preset: composition.agentPreset ?? 'default',
    cwd,
    session: sessionId,
  })
  let handle: AgentHandle | undefined
  let primaryFailure: unknown
  try {
    try {
      handle = await agents.create({
        sessionId,
        meta: { cwd, ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }) },
        agentOptions,
        setup: composition.setup,
        signal,
      })
    } catch (error) {
      // No handle exists: a create failure is composition-specific and the
      // caller may retry with a fallback composition (cancellations stay
      // unwrapped so the classifier recognizes them).
      if (isCancellation(error)) throw error
      throw new CatalogProbeError('create', `catalog probe create failed: ${safeErrorMessage(error)}`, { cause: error })
    }
    try {
      await whenIdleOrAbort(handle.agent, signal)
      const snapshot = await readCatalog(handle.agent, signal)
      const events = handle.agent.session.events
      if (events.length !== 0) {
        const types = [...new Set(events.map(event => event.type))].join(', ')
        diag.error('catalog probe emitted events', { count: events.length, types })
        throw new CatalogProbeError(
          'post-create',
          `catalog probe emitted ${events.length} session event(s) (${types}); ` +
          'the surface catalog is not zero-event and will not be installed',
        )
      }
      diag.info('catalog probe ready', {
        durationMs: Date.now() - startedAt,
        commands: snapshot.commands.length,
        scopedCommands: snapshot.scopedCommands.length,
        skills: snapshot.skills.length,
        events: 0,
      })
      return snapshot
    } catch (error) {
      // Post-create failures (whenIdle, collector, the zero-event gate)
      // are composition-independent: they must propagate, never look like a
      // retryable create failure. Cancellations stay unwrapped.
      if (isCancellation(error)) throw error
      if (error instanceof CatalogProbeError) throw error
      throw new CatalogProbeError('post-create', safeErrorMessage(error), { cause: error })
    }
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    if (handle !== undefined) {
      try {
        await handle.dispose()
        diag.info('catalog probe disposed', { durationMs: Date.now() - startedAt })
      } catch (error) {
        // Dispose is the ownership barrier: a failure must surface as a
        // primary (or, on an already-failing path, combined) failure — never
        // as a debug line over a returned catalog.
        const disposeMessage = `catalog probe dispose failed: ${safeErrorMessage(error)}`
        diag.error('catalog probe dispose failed', { error: safeErrorMessage(error) })
        throw new CatalogProbeError(
          'post-create',
          primaryFailure === undefined
            ? disposeMessage
            : `${disposeMessage} (while handling: ${safeErrorMessage(primaryFailure)})`,
          { cause: error },
        )
      }
    }
  }
}

/** Await the agent's quiescence, racing the caller signal: the creation
 * signal detached when the handle published, so post-create waits must
 * observe cancellation themselves and still let `finally` dispose. */
async function whenIdleOrAbort(agent: Agent, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw cancellationError('catalog probe aborted before whenIdle')
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(cancellationError('catalog probe aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    agent.whenIdle().then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
