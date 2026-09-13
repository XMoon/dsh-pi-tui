/**
 * The Direct Host command adapter (D2.1): resolve the live Agent by session
 * id at call time and invoke the official `commands.execute` service. Claim
 * classification, line precedence, TUI-local commands and skill wrappers stay
 * in the runner; this adapter passes the selected line and attachments
 * through unchanged.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/host-command-direct
 */

import type {
  HostCommandExecution,
  HostCommandOutcome,
  HostCommandPort,
  HostCommandRequest,
} from '../host-command-port.ts'
import type { WriteError } from '../write-outcome.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the service resolves from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The live Agent scope required by the Direct command service. */
export interface LiveAgentLike {
  readonly session: { readonly id: string }
}

/** The official Direct command service shape needed by this adapter. */
export interface CommandsServiceLike {
  execute(
    agent: unknown,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<HostCommandExecution | undefined>
}

function rejected(code: string, message: string): { kind: 'rejected'; error: WriteError } {
  return { kind: 'rejected', error: { code, message } }
}

/** The Direct backend's Host command port. */
export class DirectHostCommandPort implements HostCommandPort {
  private readonly ctx: HostContextLike
  private readonly agentFor: (sessionId: string) => LiveAgentLike | undefined

  constructor(ctx: HostContextLike, agentFor: (sessionId: string) => LiveAgentLike | undefined) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  async execute(request: HostCommandRequest): Promise<HostCommandOutcome> {
    const commands = this.ctx.get('commands') as CommandsServiceLike | undefined
    if (commands === undefined) return rejected('service/unavailable', 'commands service unavailable')
    const agent = this.agentFor(request.sessionId)
    if (agent === undefined) return rejected('session/not-found', `session "${request.sessionId}" is not available`)
    // The caller-owned lifecycle signal is forwarded unchanged; do not mint a
    // replacement that could outlive the TUI surface.
    const execution = await commands.execute(agent, request.line, request.attachments, request.signal)
    if (execution === undefined) return { kind: 'committed', matched: false }
    return { kind: 'committed', matched: true, execution }
  }
}
