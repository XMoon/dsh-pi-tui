import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  discoverForQuery,
  type LocalDiscoveryDriver,
} from '../../domain/file-completion/discovery-policy.ts'
import {
  hostPathQueryEnvironment,
  DirectHostDiscoveryDriver,
} from '../direct/file-completion/host-discovery.ts'
import {
  reattachDisplayBase,
  resolvePathQuery,
  separatorOfRaw,
  type PathQueryEnvironment,
} from '../../domain/file-completion/query.ts'
import { rankPathCandidates } from '../../domain/file-completion/ranking.ts'
import type { HostShellCompletionOutcome } from '../host-shell-completion-port.ts'

const MAX_SHELL_CANDIDATES = 50

export interface HostShellPathCompletionBridge {
  complete(cwd: string, prefix: string, signal: AbortSignal): Promise<HostShellCompletionOutcome>
}

function isReadableDirectory(path: string): boolean {
  if (!isAbsolute(path)) return false
  try {
    return statSync(path).isDirectory() && accessSync(path, fsConstants.R_OK | fsConstants.X_OK) === undefined
  } catch {
    return false
  }
}

function displayValue(path: string, kind: 'file' | 'directory', separator: '/' | '\\'): string {
  return kind === 'directory' ? `${path}${separator}` : path
}

/** Host filesystem adapter for the shared path query/ranking policy. */
export function createHostShellPathCompletionBridge(options: {
  readonly driver?: LocalDiscoveryDriver
  readonly environment?: PathQueryEnvironment
} = {}): HostShellPathCompletionBridge {
  const driver = options.driver ?? new DirectHostDiscoveryDriver()
  const environment = options.environment ?? hostPathQueryEnvironment()
  return {
    async complete(cwd, prefix, signal) {
      signal.throwIfAborted()
      if (environment.windowsHost) {
        return { kind: 'unavailable', reason: 'Host Bash path completion is unsupported on Windows in this version' }
      }
      // The Client already decoded the shell token: `prefix` IS the semantic
      // filename bytes, so leading whitespace or a leading quote is part of
      // the queried path and must not be re-parsed here.
      const query = resolvePathQuery(prefix, cwd, environment)
      if (!isReadableDirectory(query.searchBase)) {
        return { kind: 'unavailable', reason: 'the Host path scope is unavailable' }
      }
      try {
        const discovered = await discoverForQuery(query, driver, signal)
        signal.throwIfAborted()
        const ranked = rankPathCandidates(
          discovered.map(candidate => reattachDisplayBase(candidate, query)),
          query.searchTerm,
        )
        const separator = separatorOfRaw(prefix, query.winAbsolute || prefix.includes('\\'))
        const candidates = ranked.slice(0, MAX_SHELL_CANDIDATES)
          .map(candidate => displayValue(candidate.path, candidate.kind, separator))
        return { kind: 'ok', candidates }
      } catch (error) {
        signal.throwIfAborted()
        return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
