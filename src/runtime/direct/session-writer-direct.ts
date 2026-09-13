/**
 * The Direct session writer (D2.1 contract convergence) — the in-process
 * implementation of `SessionWriter` over live Agent objects and the dsh
 * `sessionTitle` service. The adapter resolves the live agent from the
 * session id at call time; it never captures a stale Agent at construction.
 *
 * Steer orchestration (fence, barrier, queue snapshot and revalidation) stays
 * in the runner. This adapter owns only Direct delivery and the Direct-only
 * Agent knobs hidden by the semantic port.
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
  followup(message: unknown): void
  steer(message: unknown): void
  cancel(reason: { kind: 'user' }, options: { keepInbox: boolean }): void
  readonly inbox: { remove(id: string): void }
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

  async steerBatch(
    sessionId: string,
    messages: readonly unknown[],
    removeQueuedIds: readonly string[] = [],
  ): Promise<WriteOutcome> {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return sessionNotFound(sessionId)
    // This synchronous Direct operation is the semantic remove-and-deliver
    // batch used by Ctrl+S. The caller receives one settlement, so a wire
    // adapter can implement the same move atomically rather than exposing
    // partial queue-removal results.
    for (const messageId of removeQueuedIds) agent.inbox.remove(messageId)
    for (const message of messages) agent.steer(message)
    return { kind: 'committed', value: undefined }
  }

  async removeQueued(sessionId: string, messageId: string): Promise<WriteOutcome> {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return sessionNotFound(sessionId)
    agent.inbox.remove(messageId)
    return { kind: 'committed', value: undefined }
  }

  async removeQueuedBatch(sessionId: string, messageIds: readonly string[]): Promise<WriteOutcome> {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return sessionNotFound(sessionId)
    for (const messageId of messageIds) agent.inbox.remove(messageId)
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
