/**
 * The session LIFECYCLE domain port (M1.5) — the semantic contract between
 * the TUI and session creation/resumption, implemented by
 * `src/runtime/direct/` (Direct) today and by a Remote adapter in a later
 * milestone. The port wraps the RAW `agents.create` / `agents.resume`
 * operations; the runner keeps the Direct-mode ownership machinery
 * (owner.lock, lease/cooling, PINNED, transition gate, operation barrier)
 * around the port calls — those are M8 territory and never move here.
 *
 * Fork and rewind are NOT separate port methods: they already ride the
 * dependency-injected seams in src/session-fork.ts (ForkAgentHost) and
 * src/rewind.ts, and the runner wires their `agents` surface through this
 * port's create/resume.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/session-lifecycle-port
 */

import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

/** Create one fresh session (the /new and first-session paths). */
export interface CreateSessionOptions {
  sessionId: SessionId
  meta: Record<string, unknown>
  agentOptions: { provider?: string; model?: string }
  setup: (agentCtx: Context) => Promise<void> | void
  seed?: readonly SessionEvent[]
  /** Creation-only cancellation; the handle detaches on publication. */
  signal?: AbortSignal
}

/** Resume a persisted session (the ordinary open path). */
export interface ResumeSessionOptions {
  resumeSessionId: SessionId
  agentOptions: { provider?: string; model?: string }
  setup: (agentCtx: Context) => Promise<void> | void
}

/** The session LIFECYCLE domain port. */
export interface SessionLifecycle {
  create(options: CreateSessionOptions): Promise<AgentHandle>
  resume(options: ResumeSessionOptions): Promise<AgentHandle>
}
