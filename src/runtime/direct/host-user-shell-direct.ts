/**
 * The Direct Host user-shell adapter (shell amendment, M3-4 PR3): the
 * in-process deployment of the SAME Host-owned one-shot execution authority as
 * the split Host. Both policies run the raw `['bash', '-c', command]` argv
 * through the installed official `ctx.subprocess` provider; `sandbox` first
 * resolves the exact live Session's policy and confines the raw argv exactly
 * once through the official `ctx.sandbox` provider, requiring full enforcement
 * before the one spawn.
 *
 * A composition without the required official capabilities fails closed with a
 * visible `policy-unavailable` admission — it NEVER downgrades to unsandboxed
 * execution and never invents a second process owner.
 *
 * Full contract: docs/architecture/host-client.md (user shell section).
 * @module @xmoon76/dsh-pi-tui/runtime/direct/host-user-shell-direct
 */

import {
  executeHostShellOnce,
  HostShellExecutionVeto,
  type HostSessionLike,
  type SandboxPolicyServiceLike,
  type SandboxServiceLike,
  type SubprocessServiceLike,
} from '../host-user-shell-execution.ts'
import {
  HostUserShellSandboxRunnerError,
  type HostUserShellOutcome,
  type HostUserShellPort,
  type HostUserShellRequest,
} from '../host-user-shell-port.ts'

/** The official Host capabilities the Direct adapter executes through. */
export interface DirectHostUserShellDeps {
  readonly subprocess: () => SubprocessServiceLike | undefined
  readonly sandbox: () => SandboxServiceLike | undefined
  readonly sandboxPolicy: () => SandboxPolicyServiceLike | undefined
  /** The exact live Session for one id, or undefined when not mounted. */
  readonly sessionFor: (sessionId: string) => HostSessionLike | undefined
}

/**
 * The Direct backend's Host user-shell port: the in-process deployment of the
 * one official one-shot execution core.
 */
export class DirectHostUserShellPort implements HostUserShellPort {
  private readonly deps: DirectHostUserShellDeps

  constructor(deps: DirectHostUserShellDeps) {
    this.deps = deps
  }

  get availability(): { readonly supported: boolean; readonly policies: readonly ('bypass' | 'sandbox')[] } {
    if (this.deps.subprocess() === undefined) return { supported: false, policies: [] }
    return this.deps.sandbox() !== undefined && this.deps.sandboxPolicy() !== undefined
      ? { supported: true, policies: ['bypass', 'sandbox'] }
      : { supported: true, policies: ['bypass'] }
  }

  async execute(request: HostUserShellRequest): Promise<HostUserShellOutcome> {
    request.signal.throwIfAborted()
    const subprocess = this.deps.subprocess()
    if (subprocess === undefined) {
      return unavailable('the Host subprocess provider is unavailable in this composition — nothing was executed')
    }
    const session = this.deps.sessionFor(request.sessionId)
    if (session === undefined || session.id !== request.sessionId) {
      return unavailable('the live Host Session is unavailable — nothing was executed')
    }
    if (request.policy === 'sandbox'
      && (this.deps.sandbox() === undefined || this.deps.sandboxPolicy() === undefined)) {
      return unavailable('user shell sandbox policy is unavailable in this composition — nothing was executed')
    }

    let outcome
    try {
      outcome = await executeHostShellOnce({
        command: request.command,
        cwd: request.cwd,
        policy: request.policy,
        signal: request.signal,
        subprocess,
        session,
        sandboxPolicy: this.deps.sandboxPolicy(),
        sandbox: this.deps.sandbox(),
        beforeSpawn: () => {
          // The final Direct gate: the caller signal and the exact live
          // Session identity are rechecked synchronously after preparation and
          // immediately before the one spawn.
          request.signal.throwIfAborted()
          if (this.deps.sessionFor(request.sessionId) !== session) {
            throw new HostShellExecutionVeto('scope-unavailable', 'the live Host Session changed during shell preparation')
          }
        },
      })
    } catch (error) {
      if (error instanceof HostShellExecutionVeto) return unavailable(error.message)
      throw error
    }
    if (outcome.kind === 'settled') return { kind: 'settled', result: outcome.result }
    if (outcome.kind === 'refused') return unavailable(outcome.message)
    if (outcome.phase === 'sandbox-runner') throw new HostUserShellSandboxRunnerError(outcome.message)
    throw new Error(outcome.message)
  }
}

function unavailable(message: string): HostUserShellOutcome {
  return { kind: 'unavailable', reason: { reason: 'policy-unavailable', message } }
}
