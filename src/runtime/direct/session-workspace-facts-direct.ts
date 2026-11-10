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
  SessionActivityFact,
  SessionWorkspaceFact,
  SessionWorkspaceFactsPort,
  WorkspaceFactsFrame,
  WorkspaceFactsHandle,
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

  followWorkspaces(signal?: AbortSignal): WorkspaceFactsHandle {
    // An already-aborted caller never gets a live subscription: Node does not
    // fire a late abort listener, so opening the handle would subscribe for a
    // generation nobody can consume.
    signal?.throwIfAborted()
    return new DirectWorkspaceFactsHandle(this.ctx, signal)
  }
}
