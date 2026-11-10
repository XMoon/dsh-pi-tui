import { SupersededReadError } from '../read-error.ts'
import type { HostShellCompletionOutcome, HostShellCompletionPort, HostShellCompletionRequest } from '../host-shell-completion-port.ts'
import { parseHostShellCompletionOutcome, type PiTuiHostUserShellNamespace } from './pi-tui-host-user-shell-contract.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'

/** One read-only completion call through the same authenticated Host namespace as Shell execution. */
export class RemoteHostShellCompletionPort implements HostShellCompletionPort {
  readonly pathAuthority = 'host' as const
  private readonly namespace: PiTuiHostUserShellNamespace
  private readonly generation: RemoteConnectionGenerationSource

  constructor(namespace: PiTuiHostUserShellNamespace, generation: RemoteConnectionGenerationSource) {
    this.namespace = namespace
    this.generation = generation
  }

  async complete(input: {
    readonly sessionId?: string
    readonly request: HostShellCompletionRequest
    readonly signal: AbortSignal
  }): Promise<HostShellCompletionOutcome> {
    input.signal.throwIfAborted()
    if (input.sessionId === undefined) {
      return { kind: 'unavailable', reason: 'Host shell completion requires a live Session' }
    }
    const captured = this.generation.getSnapshot()
    if (captured === undefined) return { kind: 'unavailable', reason: 'the Client is not connected to a Host' }
    const current = (): boolean => Object.is(captured, this.generation.getSnapshot())
    let result
    try {
      result = await this.namespace.complete(input.sessionId, input.request, input.signal)
    } catch (error) {
      if (!current()) throw new SupersededReadError('Host shell completion superseded')
      throw error
    }
    input.signal.throwIfAborted()
    if (!current()) throw new SupersededReadError('Host shell completion superseded')
    if (!result.ok) return { kind: 'unavailable', reason: result.error.message }
    return parseHostShellCompletionOutcome(result.value)
  }
}
