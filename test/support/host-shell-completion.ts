import type { HostShellCompletionPort } from '../../src/runtime/host-shell-completion-port.ts'

/** Narrow empty Direct completion capability for tests that only exercise routing/fences. */
export const EMPTY_DIRECT_SHELL_COMPLETION: HostShellCompletionPort = {
  pathAuthority: 'client',
  async complete() {
    return { kind: 'ok', candidates: [] }
  },
}


export const EMPTY_REMOTE_SHELL_COMPLETION: HostShellCompletionPort = {
  pathAuthority: 'host',
  async complete() {
    return { kind: 'unavailable', reason: 'test Host is not connected' }
  },
}
