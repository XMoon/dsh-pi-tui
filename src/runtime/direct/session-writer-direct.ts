/**
 * The Direct session writer (D2.1 contract convergence) — the in-process
 * implementation of `SessionWriter` over live Agent objects and the dsh
 * `sessionTitle` service. The adapter resolves the live agent from the
 * session id at call time; it never captures a stale Agent at construction.
 *
 * Queue steering is occurrence-level: the adapter finds the Host-owned queued
 * message, removes that exact occurrence and hands the same message to the
 * Agent's steer operation. Multi-message gestures are client orchestration over
 * this single-operation contract, not SessionWriter batch verbs.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-writer-direct
 */

import type { SessionWriter, WriteOutcome } from '../session-writer-port.ts'

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
    readonly nextTurn: readonly { readonly id: string }[]
    readonly nextStep: readonly { readonly id: string }[]
    remove(id: string): void
  }
}

/** The structural `sessionTitle` service surface. */
export interface SessionTitleServiceLike {
  rename(session: unknown, title: string): { readonly title: string }
  refresh(session: unknown, signal: AbortSignal): Promise<{ readonly title: string } | undefined>
}

function sessionNotFound<T>(sessionId: string): WriteOutcome<T> {
  return {
    kind: 'rejected',
    error: { code: 'session/not-found', message: `session "${sessionId}" is not available` },
  }
}

function queueItemNotFound<T>(messageId: string): WriteOutcome<T> {
  return {
    kind: 'rejected',
    error: { code: 'session/queue-item-not-found', message: `queued item "${messageId}" is no longer pending` },
  }
}

function steerUnavailable<T>(messageId: string): WriteOutcome<T> {
  return {
    kind: 'rejected',
    error: { code: 'session/steer-unavailable', message: `queued item "${messageId}" cannot be steered while the session is not running` },
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
  private readonly agentFor: (sessionId: string) => LiveAgentLike | undefined

  constructor(ctx: HostContextLike, agentFor: (sessionId: string) => LiveAgentLike | undefined) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  async prompt(sessionId: string, message: unknown, mode: 'queue' | 'steer'): Promise<WriteOutcome> {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return sessionNotFound(sessionId)
    if (mode === 'queue') agent.followup(message)
    else agent.steer(message)
    return { kind: 'committed', value: undefined }
  }

  /** Steer one exact next-turn occurrence, matching the official
   * `updateQueue(id, { kind: 'steer' })` operation. */
  async steerQueued(sessionId: string, messageId: string): Promise<WriteOutcome> {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return sessionNotFound(sessionId)
    const message = agent.inbox.nextTurn.find(item => item.id === messageId)
    if (message === undefined) return queueItemNotFound(messageId)
    if (agent.status !== 'running') return steerUnavailable(messageId)
    try {
      agent.inbox.remove(messageId)
      agent.steer(message)
    } catch (error) {
      // Removal or steering may have happened before the exception; the
      // caller must not restore and automatically replay this occurrence.
      return indeterminate(error)
    }
    return { kind: 'committed', value: undefined }
  }

  /** Remove one exact pending occurrence, including an already-steered
   * next-step user message, matching the official queue mutation operation. */
  async removeQueued(sessionId: string, messageId: string): Promise<WriteOutcome> {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return sessionNotFound(sessionId)
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(item => item.id === messageId)
    if (!pending) return queueItemNotFound(messageId)
    agent.inbox.remove(messageId)
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
