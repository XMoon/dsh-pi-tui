import { cancellationError } from '../process/tasks.ts'
import {
  HostUserShellOutcomeUnknownError,
  HostUserShellSandboxRunnerError,
  type HostUserShellOutcome,
  type HostUserShellPort,
  type HostUserShellRequest,
} from '../host-user-shell-port.ts'
import type { PiTuiHostUserShellNamespace } from './pi-tui-host-user-shell-contract.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'

/** Remote execution is one authenticated one-shot Host invocation; no raw
 *  frame stream, acknowledgement window or replay exists on this path. */
export class RemoteHostUserShellPort implements HostUserShellPort {
  readonly availability = { supported: true, policies: ['bypass', 'sandbox'] as const }
  private readonly namespace: PiTuiHostUserShellNamespace
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    namespace: PiTuiHostUserShellNamespace,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.namespace = namespace
    this.generation = generation
  }

  async execute(request: HostUserShellRequest): Promise<HostUserShellOutcome> {
    if (request.sessionId === '') throw new TypeError('HostUserShellPort requires a non-empty Session id')
    request.signal.throwIfAborted()
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) {
      return {
        kind: 'unavailable',
        reason: { reason: 'carrier-gap', message: 'Host user-shell execution is unavailable while disconnected — nothing was executed' },
      }
    }

    let call
    try {
      call = await this.namespace.run(request.sessionId, request.cwd, request.command, request.policy, request.signal)
    } catch (error) {
      if (request.signal.aborted) throw cancellationError('Host shell execution cancelled')
      if (!Object.is(capturedGeneration, this.generation.getSnapshot())) {
        throw new HostUserShellOutcomeUnknownError('Host shell execution belonged to a stale Connection generation')
      }
      throw new HostUserShellOutcomeUnknownError(
        `Host shell execution could not be verified (${error instanceof Error ? error.message : 'wire failure'})`,
      )
    }
    request.signal.throwIfAborted()
    // The reply must belong to the generation that STARTED the run. A mux
    // drop/reconnect during the unary call does not abort that call, so a
    // late settled reply (typically the Host's transport-triggered `aborted`
    // termination) would otherwise be accepted as authoritative. After the
    // generation is replaced the terminal fact is lost: it is UNKNOWN.
    if (!Object.is(capturedGeneration, this.generation.getSnapshot())) {
      throw new HostUserShellOutcomeUnknownError('Host shell execution belonged to a stale Connection generation')
    }
    if (!call.ok) {
      throw new HostUserShellOutcomeUnknownError(`Host shell execution could not be verified (${call.error.message})`)
    }

    const outcome = call.value
    if (outcome.kind === 'refused') {
      return {
        kind: 'unavailable',
        reason: {
          reason: outcome.reason === 'policy-unavailable' ? 'policy-unavailable' : 'carrier-gap',
          message: outcome.message,
        },
      }
    }
    if (outcome.kind === 'failed') {
      if (outcome.phase === 'sandbox-runner') throw new HostUserShellSandboxRunnerError(outcome.message)
      throw new HostUserShellOutcomeUnknownError(`Host shell infrastructure failed after start: ${outcome.message}`)
    }
    return { kind: 'settled', result: outcome.result }
  }
}
