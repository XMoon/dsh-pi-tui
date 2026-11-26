import type {
  HostShellCompletionOutcome,
  HostShellCompletionPort,
  HostShellCompletionRequest,
  HostShellCompletionTarget,
  HostShellPathLiteralDialect,
} from '../host-shell-completion-port.ts'
import type { HostShellPathCompletionBridge } from '../remote/pi-tui-host-user-shell-host-bridge.ts'

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
 * compatibility cwd.
 *
 * POSIX Direct keeps its existing fork path provider (`pathAuthority:
 * 'client'`) and the Bash compgen candidate reader. A Windows Direct Host has
 * no Bash: its paths go through the SAME Host path bridge the split Host uses
 * (`pathAuthority: 'host'`, PowerShell literal presentation) and its
 * command/variable/git positions are explicitly unavailable — never a
 * compgen, Client filesystem or Bash fallback.
 */
export class DirectHostShellCompletionPort implements HostShellCompletionPort {
  get pathAuthority(): 'client' | 'host' {
    return process.platform === 'win32' ? 'host' : 'client'
  }

  get pathLiteralDialect(): HostShellPathLiteralDialect {
    return process.platform === 'win32' ? 'powershell' : 'bash'
  }

  private readonly cwdOf: () => string
  private readonly agentFor: (sessionId: string) => DirectShellAgentLike | undefined
  private readonly readCandidates: DirectShellCandidateReader
  private readonly pathCompletion: HostShellPathCompletionBridge

  constructor(
    cwdOf: () => string,
    agentFor: (sessionId: string) => DirectShellAgentLike | undefined,
    readCandidates: DirectShellCandidateReader,
    pathCompletion: HostShellPathCompletionBridge,
  ) {
    this.cwdOf = cwdOf
    this.agentFor = agentFor
    this.readCandidates = readCandidates
    this.pathCompletion = pathCompletion
  }

  async complete(input: {
    readonly target: HostShellCompletionTarget
    readonly request: HostShellCompletionRequest
    readonly signal: AbortSignal
  }): Promise<HostShellCompletionOutcome> {
    input.signal.throwIfAborted()
    if (input.target.kind === 'session') {
      const agent = this.agentFor(input.target.sessionId)
      if (agent === undefined) {
        return { kind: 'unavailable', reason: 'the requested Session has no live Direct Agent' }
      }
    }
    const cwd = this.cwdOf()
    if (process.platform === 'win32') {
      if (input.request.kind !== 'paths') {
        return {
          kind: 'unavailable',
          reason: 'Direct Windows Host command, variable and git completion is unsupported — the Host PowerShell shell has no native candidate source',
        }
      }
      return this.pathCompletion.complete(cwd, input.request.prefix, input.signal)
    }
    if (input.request.kind === 'paths') {
      return { kind: 'unavailable', reason: 'Direct shell paths use the existing path provider' }
    }
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
