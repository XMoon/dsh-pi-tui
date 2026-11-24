/**
 * The Direct read-authority adapter (M5-U-A): the in-process implementation of
 * `SessionWorkspaceFactsPort` over the SAME official Host services the Direct
 * session reader and session lifecycle already read.
 *
 * It adds no registry, store or event fold: `running` comes from the exact
 * live Agent's official status, and Workspace facts come from the official
 * `workspaceRegistry` re-read after its `domain/changed` writes. Direct owns no
 * Gateway forwarded-event truth for another Session, so this adapter never
 * fabricates cross-Session pending facts — the attention answer is `unknown`,
 * and the existing in-process Question/Approval modal remains its own surface.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-workspace-facts-direct
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionSummary } from '../session-reader-port.ts'
import {
  directWorkspaceRegistry,
  type WorkspaceFactEntityLike,
} from './session-lifecycle-direct.ts'
import type {
  ActivityObservation,
  ActivityObservationSnapshot,
  SessionActivityFact,
  SessionWorkspaceFact,
  SessionWorkspaceFactsPort,
  WorkspaceFactsFrame,
  WorkspaceFactsHandle,
  WorkspaceFollowMode,
} from '../session-workspace-facts-port.ts'

/** The minimal Host context surface this adapter needs (structural — never a
 *  package dependency; the services resolve from the running installation). */
export interface DirectFactsContextLike {
  get(name: string): unknown
  on: Context['on']
}

/** The live Agent status the official Host registry exposes (`AgentStatus`). */
export interface DirectFactsAgentLike {
  readonly status: string
}

/** The read-only registry subset: `list()` is the ONE Workspace authority. */
export interface DirectWorkspaceRegistryFactsLike {
  list(): readonly WorkspaceFactEntityLike[]
}

const WORKSPACE_DOMAIN = 'workspace'

function workspaceFactOf(entity: WorkspaceFactEntityLike): SessionWorkspaceFact {
  return {
    workspaceId: String(entity.id),
    path: entity.path,
    // A Host Workspace can exist without a display title (a fresh create);
    // the TUI fact carries display text, so an absent title is empty and the
    // projection applies its own ONE fallback label.
    title: entity.title ?? '',
    sessionIds: entity.sessionIds.map(String),
  }
}

/** The official `AgentStatus` is `'idle' | 'running'`; anything else is not a
 *  proven running fact (`undefined`), never a guessed idle. */
export function directRunningOf(status: string | undefined): boolean | undefined {
  if (status === 'running') return true
  if (status === 'idle') return false
  return undefined
}

/** The narrow Agent identity carried by the official lifecycle events. */
interface DirectFactsAgentEventLike {
  readonly agent: { readonly id: unknown }
}

/**
 * One per-open Direct Activity observation.
 *
 * Every fact is a SYNCHRONOUS read of the exact live Agent (`agentFor`), so the
 * roster commit publishes measured rows in the same frame and there is no read
 * queue, no timer and no second status registry. The official `agent/status`,
 * `agent/created` and `agent/disposed` events only INVALIDATE one id: the fact
 * is re-derived from the live Agent, never from the event payload alone.
 * Direct owns no cross-Session Gateway pending truth, so the attention fact
 * stays the truthful `unknown`.
 */
class DirectActivityObservation implements ActivityObservation {
  private readonly ctx: DirectFactsContextLike
  private readonly agentFor: (sessionId: string) => DirectFactsAgentLike | undefined
  private readonly listeners = new Set<() => void>()
  private readonly offs: Array<() => void> = []
  private readonly abortCleanup: (() => void) | undefined
  private facts: readonly SessionActivityFact[] = []
  private rosterRevision = 0
  private revision = 0
  private disposed = false

  constructor(
    ctx: DirectFactsContextLike,
    agentFor: (sessionId: string) => DirectFactsAgentLike | undefined,
    signal: AbortSignal,
  ) {
    this.ctx = ctx
    this.agentFor = agentFor
    const invalidate = (event: DirectFactsAgentEventLike): undefined => {
      this.invalidate(String(event.agent.id))
      return undefined
    }
    this.offs.push(ctx.on('agent/status', invalidate, { global: true }))
    this.offs.push(ctx.on('agent/created', invalidate, { global: true }))
    this.offs.push(ctx.on('agent/disposed', invalidate, { global: true }))
    const onAbort = (): void => { this.dispose() }
    signal.addEventListener('abort', onAbort, { once: true })
    this.abortCleanup = () => { signal.removeEventListener('abort', onAbort) }
  }

  private factOf(sessionId: string): SessionActivityFact {
    const agent = this.agentFor(sessionId)
    return {
      sessionId,
      running: directRunningOf(agent?.status),
      // Direct owns no cross-Session Gateway forwarded-event read, and its
      // in-process Question/Approval modal is not a fact source for another
      // Session. Recording `unknown` is the truthful answer; a guessed
      // `none`/`question` would be fabricated attention.
      pendingKinds: undefined,
      continuedQuestionCallIds: undefined,
      attention: 'unknown',
      attentionSourceState: 'unknown',
    }
  }

  /** Re-derive ONE id after an official Agent lifecycle event. A row outside
   *  this observation's roster is inert; a value-identical fact publishes
   *  nothing. */
  private invalidate(sessionId: string): void {
    if (this.disposed) return
    const index = this.facts.findIndex(fact => fact.sessionId === sessionId)
    if (index < 0) return
    const next = this.factOf(sessionId)
    if (next.running === this.facts[index].running) return
    const facts = [...this.facts]
    facts[index] = next
    this.facts = facts
    this.revision += 1
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  setRoster(
    rows: readonly SessionSummary[],
    rosterRevision: number,
    currentSessionId: string | undefined,
  ): void {
    if (this.disposed) return
    // `currentSessionId` only raises a read priority; Direct reads are
    // synchronous, so there is no queue whose order it could change.
    void currentSessionId
    // Commit identity/epoch state BEFORE any listener runs.
    this.rosterRevision = rosterRevision
    this.facts = rows
      .filter(row => row.origin !== 'subagent')
      .map(row => this.factOf(row.id))
    this.revision += 1
    this.emit()
  }

  setPriorityIds(): void {
    // No read queue exists on the Direct path: every fact is already a
    // synchronous live-Agent read, so eligibility cannot reorder any work.
  }

  getSnapshot(): ActivityObservationSnapshot {
    return {
      rosterRevision: this.rosterRevision,
      revision: this.revision,
      facts: this.facts,
    }
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    let active = true
    return (): void => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    for (const off of this.offs.splice(0)) off()
    this.abortCleanup?.()
  }
}

/**
 * One per-open Direct Workspace observation: the official registry baseline
 * plus one replacement per committed Workspace domain change. The Registry
 * itself stays the only table; this handle holds no second Workspace cache.
 */
class DirectWorkspaceFactsHandle implements WorkspaceFactsHandle {
  private readonly ctx: DirectFactsContextLike
  private readonly queue: WorkspaceFactsFrame[] = []
  private readonly waiters: Array<(frame: WorkspaceFactsFrame | undefined) => void> = []
  private readonly abortCleanup: (() => void) | undefined
  private readonly off: () => void
  private ended = false
  private disposed = false

  constructor(ctx: DirectFactsContextLike, signal: AbortSignal | undefined) {
    this.ctx = ctx
    const registry = this.registry()
    if (registry === undefined) {
      throw new Error('the Host Workspace registry is unavailable')
    }
    this.queue.push({ type: 'baseline', items: registry.list().map(workspaceFactOf) })
    this.off = ctx.on('domain/changed', change => {
      if (change.domain !== WORKSPACE_DOMAIN) return
      if (this.ended) return
      // Re-read the ONE official registry: an increment is never derived from
      // the event payload, and an unmounted registry ends the generation
      // instead of publishing an empty Workspace set.
      const current = this.registry()
      if (current === undefined) {
        this.finish()
        return
      }
      this.push({ type: 'replace', items: current.list().map(workspaceFactOf) })
    })
    if (signal === undefined) {
      this.abortCleanup = undefined
    } else {
      const onAbort = (): void => { this.dispose() }
      signal.addEventListener('abort', onAbort, { once: true })
      this.abortCleanup = () => { signal.removeEventListener('abort', onAbort) }
    }
  }

  private registry(): DirectWorkspaceRegistryFactsLike | undefined {
    return directWorkspaceRegistry(this.ctx)
  }

  private push(frame: WorkspaceFactsFrame): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter(frame)
      return
    }
    this.queue.push(frame)
  }

  private finish(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }

  private next(): Promise<WorkspaceFactsFrame | undefined> {
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.ended) return Promise.resolve(undefined)
    return new Promise(resolve => { this.waiters.push(resolve) })
  }

  /** The in-process registry is the observation's generation: it stays
   *  current while this handle is open AND the official registry is mounted. */
  isCurrent(): boolean {
    return !this.disposed && this.registry() !== undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // A disposed observation owns no fact any more: queued frames are dropped
    // with the subscription instead of draining into a caller that is gone.
    this.queue.length = 0
    this.off()
    this.abortCleanup?.()
    this.finish()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<WorkspaceFactsFrame> {
    try {
      for (;;) {
        const frame = await this.next()
        if (frame === undefined) return
        yield frame
      }
    } finally {
      this.dispose()
    }
  }
}

/** The Direct read-authority adapter over the live Host services. */
export class DirectSessionWorkspaceFacts implements SessionWorkspaceFactsPort {
  private readonly ctx: DirectFactsContextLike
  private readonly agentFor: (sessionId: string) => DirectFactsAgentLike | undefined

  constructor(
    ctx: DirectFactsContextLike,
    agentFor: (sessionId: string) => DirectFactsAgentLike | undefined,
  ) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  async readActivity(
    rows: readonly SessionSummary[],
    signal?: AbortSignal,
  ): Promise<readonly SessionActivityFact[]> {
    signal?.throwIfAborted()
    const facts = rows
      .filter(row => row.origin !== 'subagent')
      .map((row): SessionActivityFact => {
        const agent = this.agentFor(row.id)
        return {
          sessionId: row.id,
          running: directRunningOf(agent?.status),
          // Direct owns no cross-Session Gateway forwarded-event read, and its
          // in-process Question/Approval modal is not a fact source for another
          // Session. Recording `unknown` is the truthful answer; a guessed
          // `none`/`question` would be fabricated attention.
          pendingKinds: undefined,
          continuedQuestionCallIds: undefined,
          attention: 'unknown',
          attentionSourceState: 'unknown',
        }
      })
    signal?.throwIfAborted()
    return facts
  }

  observeActivity(signal: AbortSignal): ActivityObservation {
    // An already-aborted caller never gets a live observation: Node does not
    // fire a late abort listener, so opening the handle would subscribe for a
    // generation nobody can consume.
    signal.throwIfAborted()
    return new DirectActivityObservation(this.ctx, this.agentFor, signal)
  }

  followWorkspaces(signal?: AbortSignal, mode: WorkspaceFollowMode = 'single-generation'): WorkspaceFactsHandle {
    // An already-aborted caller never gets a live subscription: Node does not
    // fire a late abort listener, so opening the handle would subscribe for a
    // generation nobody can consume.
    signal?.throwIfAborted()
    // Direct owns ONE in-process registry, not a reconnecting transport: both
    // modes are the SAME registry observation. A registry that unmounts ends
    // the generation in either mode; there is no carrier to recover.
    void mode
    return new DirectWorkspaceFactsHandle(this.ctx, signal)
  }
}
