/** Host-owned, read-only completion facts for one live Session. */
export type HostShellCompletionRequest =
  | { readonly kind: 'commands'; readonly prefix: string }
  | { readonly kind: 'variables'; readonly prefix: string }
  | { readonly kind: 'subcommands'; readonly command: string; readonly prefix: string }
  | { readonly kind: 'paths'; readonly prefix: string }

export type HostShellCompletionOutcome =
  | { readonly kind: 'ok'; readonly candidates: readonly string[] }
  | { readonly kind: 'unavailable'; readonly reason: string }

export interface HostShellCompletionPort {
  /** Direct preserves its existing fork path provider; Remote owns paths on the Host. */
  readonly pathAuthority: 'client' | 'host'
  complete(input: {
    /** Absent only for the Direct workspace compatibility path; Remote refuses it. */
    readonly sessionId?: string
    readonly request: HostShellCompletionRequest
    readonly signal: AbortSignal
  }): Promise<HostShellCompletionOutcome>
}
