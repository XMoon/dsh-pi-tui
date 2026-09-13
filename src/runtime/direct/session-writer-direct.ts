/**
 * The Direct session writer (D2.1 contract convergence) — the in-process
 * implementation of `SessionWriter` over live Agent objects and the dsh
 * `sessionTitle` service. The adapter resolves the live agent from the
 * session id at call time; it never captures a stale Agent at construction.
 *
 * Queue mutations are occurrence-level: the adapter applies the official
 * `edit` / `remove` / `steer` action to the Host-owned message. Multi-message
 * gestures are client orchestration over this single-operation contract, not
 * SessionWriter batch verbs.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-writer-direct
 */

import { isCancellation } from '../../detached.ts'
import type { QueueAction, SessionWriter, WriteOutcome } from '../session-writer-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The live-agent surface the Direct adapter drives (structural). */
export interface LiveAgentLike {
  readonly session: { readonly id: string }
  readonly status: string
  followup(message: unknown): void
  steer(message: unknown): void
  cancel(reason: { kind: 'user' }, options: { keepInbox: boolean }): void
  readonly inbox: {
    readonly nextTurn: readonly { readonly id: string; readonly role?: string; readonly content?: readonly unknown[]; readonly source?: unknown }[]
    readonly nextStep: readonly { readonly id: string; readonly role?: string; readonly content?: readonly unknown[]; readonly source?: unknown }[]
    replace(id: string, message: unknown): boolean
    remove(id: string): boolean
  }
}

/** The structural `sessionTitle` service surface. */
export interface SessionTitleServiceLike {
  rename(session: unknown, title: string): { readonly title: string }
  refresh(session: unknown, signal: AbortSignal): Promise<{ readonly title: string } | undefined>
}

interface FileUploadsLike {
  retirePrompt(agent: LiveAgentLike, requestId: string): void
}

function sessionNotFound<T>(sessionId: string): WriteOutcome<T> {
  return {
    kind: 'rejected',
    error: { code: 'session/not-found', message: `session "${sessionId}" is not available` },
  }
}

function queueItemNotFound<T>(itemId: string): WriteOutcome<T> {
  return {
    kind: 'rejected',
    error: { code: 'session/queue-item-not-found', message: `queued item "${itemId}" is no longer pending` },
  }
}

function steerUnavailable<T>(itemId: string): WriteOutcome<T> {
  return {
    kind: 'rejected',
    error: { code: 'session/steer-unavailable', message: `queued item "${itemId}" cannot be steered while the session is not running` },
  }
}

function indeterminate(error: unknown): WriteOutcome {
  return {
    kind: 'indeterminate',
    error: {
      code: 'session/write-indeterminate',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

function mutationFailure(error: unknown): WriteOutcome {
  return isCancellation(error) ? { kind: 'cancelled' } : indeterminate(error)
}

function serviceUnavailable<T>(service: string): WriteOutcome<T> {
  return {
    kind: 'rejected',
    error: { code: 'service/unavailable', message: `${service} service unavailable` },
  }
}

/** The Direct backend's session writer: identity-based operations over the
 * live agents and the `ctx.sessionTitle` service. */
export class DirectSessionWriter implements SessionWriter {
  private readonly ctx: HostContextLike
  /** Ordinary session verbs stay on the caller-authorized resolver. */
  private readonly agentFor: (sessionId: string) => LiveAgentLike | undefined
  /** Queue mutations may address the currently viewed continuable child through
   * a separately fenced resolver; this never widens prompt authority. */
  private readonly queueAgentFor: (sessionId: string) => LiveAgentLike | undefined

  constructor(
    ctx: HostContextLike,
    agentFor: (sessionId: string) => LiveAgentLike | undefined,
    queueAgentFor: (sessionId: string) => LiveAgentLike | undefined = agentFor,
  ) {
    this.ctx = ctx
    this.agentFor = agentFor
    this.queueAgentFor = queueAgentFor
  }

  async prompt(sessionId: string, message: unknown, mode: 'queue' | 'steer'): Promise<WriteOutcome> {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return sessionNotFound(sessionId)
    if (mode === 'queue') agent.followup(message)
    else agent.steer(message)
    return { kind: 'committed', value: undefined }
  }

  /** Apply one official queue mutation to an exact pending occurrence. A
   * boolean miss is a typed not-found; non-cancellation mutation exceptions
   * are indeterminate. */
  async updateQueue(sessionId: string, itemId: string, action: QueueAction): Promise<WriteOutcome> {
    // Match the official Host boundary: edit validation happens before Agent
    // resolution and does not alter the caller's content bytes.
    if (action.kind === 'edit') {
      const nonText = action.content.some(block => {
        if (typeof block !== 'object' || block === null || !('type' in block)) return true
        return block.type !== 'text'
      })
      if (nonText) {
        return {
          kind: 'rejected',
          error: {
            code: 'session/attachment-invalid',
            message: 'queue edits accept text content only',
            details: { reason: 'QUEUE_EDIT_NON_TEXT' },
          },
        }
      }
      const hasText = action.content.some(block => {
        if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text') return false
        return 'text' in block && typeof block.text === 'string' && block.text.trim().length > 0
      })
      if (!hasText) {
        return {
          kind: 'rejected',
          error: { code: 'gateway/bad-request', message: 'queue edit content must include non-whitespace text' },
        }
      }
    }

    const agent = this.queueAgentFor(sessionId)
    if (agent === undefined) return queueItemNotFound(itemId)

    const nextTurn = agent.inbox.nextTurn.find(item => item.id === itemId)
    const nextStep = agent.inbox.nextStep.find(item => item.id === itemId)
    const located = nextTurn === undefined
      ? nextStep === undefined ? undefined : { target: 'next-step' as const, message: nextStep }
      : { target: 'next-turn' as const, message: nextTurn }
    if (located === undefined) return queueItemNotFound(itemId)
    const { target, message } = located
    if (action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
      return steerUnavailable(itemId)
    }

    if (action.kind === 'edit') {
      try {
        const replaced = agent.inbox.replace(itemId, { ...message, content: [...action.content] })
        return replaced ? { kind: 'committed', value: undefined } : queueItemNotFound(itemId)
      } catch (error) {
        return mutationFailure(error)
      }
    }

    if (action.kind === 'remove') {
      let removed: boolean
      try {
        removed = agent.inbox.remove(itemId)
      } catch (error) {
        return mutationFailure(error)
      }
      if (!removed) return queueItemNotFound(itemId)
      try {
        const source = message.source
        if (typeof source === 'object' && source !== null
          && 'kind' in source && source.kind === 'user'
          && 'rpcId' in source && typeof source.rpcId === 'string') {
          const fileUploads = this.ctx.get('fileUploads') as FileUploadsLike | undefined
          if (fileUploads === undefined) {
            return indeterminate(new Error('file upload service unavailable while retiring queue prompt'))
          }
          fileUploads.retirePrompt(agent, source.rpcId)
        }
      } catch (error) {
        // The queue occurrence was removed; an upload-retirement failure is
        // therefore indeterminate even when the failure is cancellation-shaped.
        return indeterminate(error)
      }
      return { kind: 'committed', value: undefined }
    }

    let removed = false
    try {
      const didRemove = agent.inbox.remove(itemId)
      if (!didRemove) return queueItemNotFound(itemId)
      removed = true
      agent.steer(message)
    } catch (error) {
      // Removal may have happened before either the exception or steering;
      // the caller must not restore and automatically replay this occurrence.
      return removed ? indeterminate(error) : mutationFailure(error)
    }
    return { kind: 'committed', value: undefined }
  }

  async cancel(sessionId: string): Promise<WriteOutcome> {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return sessionNotFound(sessionId)
    // The TUI semantic is always a user cancel that preserves pending inbox
    // work; Direct Agent implementation knobs do not cross the port.
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { kind: 'committed', value: undefined }
  }

  async rename(sessionId: string, title: string): Promise<WriteOutcome<{ readonly title: string }>> {
    const titles = this.ctx.get('sessionTitle') as SessionTitleServiceLike | undefined
    if (titles === undefined) return serviceUnavailable('session title')
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return sessionNotFound(sessionId)
    const snapshot = titles.rename(agent.session, title)
    return { kind: 'committed', value: { title: snapshot.title } }
  }

  async refreshTitle(sessionId: string, signal: AbortSignal): Promise<
    | { readonly kind: 'ok'; readonly title: string | undefined }
    | { readonly kind: 'unsupported'; readonly reason: string }
  > {
    const titles = this.ctx.get('sessionTitle') as SessionTitleServiceLike | undefined
    if (titles === undefined) return { kind: 'unsupported', reason: 'session title service unavailable' }
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return { kind: 'unsupported', reason: 'session is not available' }
    const regenerated = await titles.refresh(agent.session, signal)
    return { kind: 'ok', title: regenerated?.title }
  }
}
