/** Host-owned, read-only completion facts for one live Session or one selected Host Workspace. */
export type HostShellCompletionRequest =
  | { readonly kind: 'commands'; readonly prefix: string }
  | { readonly kind: 'variables'; readonly prefix: string }
  | { readonly kind: 'subcommands'; readonly command: string; readonly prefix: string }
  | { readonly kind: 'paths'; readonly prefix: string }

/**
 * The MUTUALLY EXCLUSIVE completion target the caller resolved from its
 * CURRENT Host scope: one exact live Session, one exact Host-issued
 * Workspace id, or the explicit absence of either. There is no optional
 * sessionId+workspaceId pair, so a both/none ambiguity cannot cross the port.
 * `selectionRevision` stays a Client-local admission epoch and never becomes
 * a target here.
 */
export type HostShellCompletionTarget =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'unselected' }

export type HostShellCompletionOutcome =
  | { readonly kind: 'ok'; readonly candidates: readonly string[] }
  | { readonly kind: 'unavailable'; readonly reason: string }

export interface HostShellCompletionPort {
  /** Direct preserves its existing fork path provider; Remote owns paths on the Host. */
  readonly pathAuthority: 'client' | 'host'
  complete(input: {
    readonly target: HostShellCompletionTarget
    readonly request: HostShellCompletionRequest
    readonly signal: AbortSignal
  }): Promise<HostShellCompletionOutcome>
}
