import type { HostShellCompletionOutcome, HostShellCompletionPort, HostShellCompletionRequest, HostShellCompletionTarget } from '../host-shell-completion-port.ts'

interface DirectShellAgentLike {
  readonly session: { readonly id: string }
}

export type DirectShellCandidateRequest =
  | { readonly kind: 'commands' }
  | { readonly kind: 'variables'; readonly prefix: string }
  | { readonly kind: 'subcommands'; readonly command: string }

export type DirectShellCandidateReader = (
  request: DirectShellCandidateRequest,
  cwd: string,
  signal: AbortSignal,
) => Promise<readonly string[]>

/**
 * The Direct adapter maps the SAME completion contract onto the in-process
 * Host environment: a `session` target keeps the exact-Agent currentness, a
 * `workspace`/`unselected` target keeps the existing sessionless in-process
 * compatibility cwd. It is a Direct mapping only — no Client cwd or PATH ever
 * becomes a Remote answer.
 */
export class DirectHostShellCompletionPort implements HostShellCompletionPort {
  readonly pathAuthority = 'client' as const
  private readonly cwdOf: () => string
  private readonly agentFor: (sessionId: string) => DirectShellAgentLike | undefined
  private readonly readCandidates: DirectShellCandidateReader

  constructor(
    cwdOf: () => string,
    agentFor: (sessionId: string) => DirectShellAgentLike | undefined,
    readCandidates: DirectShellCandidateReader,
  ) {
    this.cwdOf = cwdOf
    this.agentFor = agentFor
    this.readCandidates = readCandidates
  }

  async complete(input: {
    readonly target: HostShellCompletionTarget
    readonly request: HostShellCompletionRequest
    readonly signal: AbortSignal
  }): Promise<HostShellCompletionOutcome> {
    input.signal.throwIfAborted()
    if (input.request.kind === 'paths') {
      return { kind: 'unavailable', reason: 'Direct shell paths use the existing path provider' }
    }
    if (input.target.kind === 'session') {
      const agent = this.agentFor(input.target.sessionId)
      if (agent === undefined) {
        return { kind: 'unavailable', reason: 'the requested Session has no live Direct Agent' }
      }
    }
    const cwd = this.cwdOf()
    const request: DirectShellCandidateRequest = input.request.kind === 'commands'
      ? { kind: 'commands' }
      : input.request.kind === 'variables'
        ? { kind: 'variables', prefix: input.request.prefix }
        : { kind: 'subcommands', command: input.request.command }
    const candidates = await this.readCandidates(request, cwd, input.signal)
    input.signal.throwIfAborted()
    return { kind: 'ok', candidates }
  }
}
