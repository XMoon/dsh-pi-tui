/**
 * The Direct Session Markdown adapter (S5-PR3 official Markdown export): the
 * ONLY Direct Host Markdown adapter. It delegates to the public DSH Host
 * primitives — the official `sessionQuery.readSession` complete committed
 * logical snapshot, the optional `sessionPersistence.stat` artifact path and
 * the official `formatSessionMarkdown` formatter — and never reproduces them
 * Client-side.
 *
 * Locality: the Markdown CONTENT is Host-owned; the Client only writes the
 * returned bytes to a Client-selected file. No Agent is created or retained,
 * no Session is made live, and no output is written here. Absent official
 * services answer `unavailable`; an official not-found code is `none`; every
 * other failure rejects.
 *
 * Full contract: docs/architecture/host-client.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-markdown-direct
 */

import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { formatSessionMarkdown } from '@deepseek-ai/dsh-session-log-export'
import type { SessionMarkdownReadResult, SessionMarkdownPort } from '../session-markdown-port.ts'

/** The structural host context the adapter reads (the same narrow seam as the
 * other Direct adapters; the official service objects converge to the
 * structural faces below only at this adapter boundary). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The official `sessionQuery.readSession` face this adapter consumes. */
interface SessionQueryLike {
  readSession(sessionId: SessionId): Promise<{ readonly events: readonly SessionEvent[] }>
}

/** The official `sessionPersistence.stat` face this adapter consumes (only
 * the optional materialized artifact path reaches the formatter). */
interface SessionPersistenceLike {
  stat(
    sessionId: SessionId,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly location?: { readonly path?: string } } | undefined>
}

/** The official stable Session Query not-found machine code. */
const SESSION_QUERY_SESSION_NOT_FOUND = 'SESSION_QUERY_SESSION_NOT_FOUND'

/** The Direct `SessionMarkdownPort` adapter: official Host Markdown read. */
export class DirectSessionMarkdown implements SessionMarkdownPort {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  async read(sessionId: string, signal?: AbortSignal): Promise<SessionMarkdownReadResult> {
    signal?.throwIfAborted()
    // The official route's own order: no session-query service means the
    // official Markdown capability is unavailable, never an empty transcript.
    const query = this.ctx.get('sessionQuery') as SessionQueryLike | undefined
    if (query === undefined) return { kind: 'unavailable' }
    const id = SessionId(sessionId)
    try {
      // `readSession` has no cancellation parameter; abort is observed
      // before and after the awaited read exactly like the official route.
      const snapshot = await query.readSession(id)
      signal?.throwIfAborted()
      const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
      const stat = await persistence?.stat(id, { signal })
      signal?.throwIfAborted()
      return {
        kind: 'ready',
        markdown: formatSessionMarkdown(snapshot.events, stat?.location?.path),
      }
    } catch (error) {
      signal?.throwIfAborted()
      // Only the official stable machine code proves the Session absent; any
      // other failure stays a real rejection.
      if (error instanceof Error && 'code' in error
        && error.code === SESSION_QUERY_SESSION_NOT_FOUND) {
        return { kind: 'none' }
      }
      throw error
    }
  }
}
