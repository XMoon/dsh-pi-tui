/**
 * The Remote Host-side bridge for the private `piTuiFileReferences` endpoints
 * (TS8-HF1; M6-1/F5-B adds the sessionless Workspace verb): a
 * CONSTRUCTION/ADAPTATION seam ONLY.
 *
 * - `list` binds the SAME Host-scoped Session authority the Direct adapter
 *   uses (`runtime/direct/host-file-augmentation-direct.ts` + the Direct Host
 *   discovery driver) — unchanged by F5-B.
 * - `listWorkspace` binds the sessionless Host Workspace discovery through the
 *   SAME classifier/helper the Direct Workspace route uses: after the Host
 *   `workspaceRegistry` resolves the confirmed `workspaceId` to its canonical
 *   root, a BARE query is answered by the published
 *   `@deepseek-ai/dsh-file-reference-local/search` `WorkspaceFileSearch`
 *   (official defaults/ranking/exclusions), an EXPLICIT path scope by the
 *   shared Host scanner anchored at that same root. It never creates an
 *   Agent/Session, never reads a Client fact and never falls back to a Client
 *   filesystem.
 *
 * It owns NO Cordis service, NO Typert registration and NO lifecycle policy —
 * the Cordis service, its Owner-invocation gate, its Typert contribution
 * registration and its disposal remain with the built-in PiTui Host Runtime
 * (`app/host/features/file-reference.ts`). The dependency direction is
 * therefore `app/host/features/** -> runtime/remote/** -> runtime/direct/**`,
 * never `app/host/** -> runtime/direct/**`.
 *
 * The bridge lives in `runtime/remote/**` because that layer may consume the
 * Direct Host implementation; the composition layer may not.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-file-reference-host-bridge
 */

import { accessSync, constants, statSync } from 'node:fs'
import {
  DirectHostDiscoveryDriver,
  hostPathQueryEnvironment,
} from '../direct/file-completion/host-discovery.ts'
import { OfficialWorkspaceSearchPool } from '../direct/file-completion/official-workspace-search.ts'
import {
  isExplicitHostFileQuery,
  listPiTuiExplicitHostFileReferences,
  listPiTuiHostFileReferences,
  type FileReferencesServiceLike,
  type LiveAgentLike,
  type WorkingDirectoryServiceLike,
} from '../direct/host-file-augmentation-direct.ts'
import type { HostFileListResult } from '../host-file-port.ts'

export type { FileReferencesServiceLike, LiveAgentLike, WorkingDirectoryServiceLike } from '../direct/host-file-augmentation-direct.ts'

/** The official Host `workspaceRegistry` subset this bridge consults: the ONLY
 *  Workspace identity/path authority (no local shadow registry). */
export interface WorkspaceRegistryPort {
  get(id: string): { readonly path: string } | undefined
}

/** The Host facts the bridge answers with. The composition supplies them from
 * the running Host Context; no Client fact participates. */
export interface PiTuiHostFileReferenceBridgeDeps {
  /** The exact live Host Agent for one Session identity (undefined when gone). */
  readonly agentFor: (sessionId: string) => LiveAgentLike | undefined
  /** The official Host file-reference provider (undefined while unmounted). */
  readonly official: () => FileReferencesServiceLike | undefined
  /** The Host's fd/fdfind executable for the scoped discovery: `undefined`
   *  probes the Host PATH, `null` forces the bounded fallback (deterministic
   *  tests), a string pins one finder. */
  readonly fdPath?: string | null | undefined
  /** The Host Session directory owner (`ctx.workingDirectory`): the scoped
   *  discovery resolves the Host Agent's EFFECTIVE directory through it.
   *  Absent = the immutable header cwd remains the scope read. */
  readonly workingDirectory?: () => WorkingDirectoryServiceLike | undefined
  /** The official Host Workspace registry: the sessionless discovery's ONLY
   *  identity/path authority (resolved PER REQUEST). */
  readonly workspaces: () => WorkspaceRegistryPort | undefined
}

/** The private Remote methods' Host-side implementation. */
export interface PiTuiHostFileReferenceRuntime {
  list(sessionId: string, query: string, signal: AbortSignal): Promise<HostFileListResult>
  listWorkspace(workspaceId: string, query: string, signal: AbortSignal): Promise<HostFileListResult>
  /** Mark every resident official workspace index stale (Host tool/result). */
  invalidateWorkspaceSearches(): void
  /** Release every resident official workspace index (service disposal). */
  dispose(): void
}

/**
 * Bind the private Remote methods to the Host-scoped completion authority.
 * The Host finder is resolved ONCE for the runtime's lifetime (it is a pure
 * PATH pin; a later PATH change is not a Host completion fact).
 */
export function createPiTuiHostFileReferenceRuntime(
  deps: PiTuiHostFileReferenceBridgeDeps,
): PiTuiHostFileReferenceRuntime {
  const driver = new DirectHostDiscoveryDriver(deps.fdPath)
  const environment = hostPathQueryEnvironment()
  const workspaceSearch = new OfficialWorkspaceSearchPool()
  return {
    async list(sessionId, query, signal) {
      signal.throwIfAborted()
      const agent = deps.agentFor(sessionId)
      if (agent === undefined) {
        return { kind: 'unavailable', reason: 'the requested Session has no live Host Agent' }
      }
      return await listPiTuiHostFileReferences(agent, query, signal, {
        official: deps.official(),
        driver,
        environment,
        workingDirectory: deps.workingDirectory?.(),
      })
    },
    async listWorkspace(workspaceId, query, signal) {
      signal.throwIfAborted()
      if (workspaceId === '') {
        return { kind: 'unavailable', reason: 'the requested Host Workspace id is empty' }
      }
      const registry = deps.workspaces()
      if (registry === undefined) {
        return { kind: 'unavailable', reason: 'the Host Workspace registry is unavailable' }
      }
      // The registry is re-read per request: it stays the authority, the cache
      // below is only an index of the SAME id/root pair.
      const workspace = registry.get(workspaceId)
      if (workspace === undefined) {
        return { kind: 'unavailable', reason: `Workspace "${workspaceId}" is not registered on the Host` }
      }
      if (!isReadableDirectory(workspace.path)) {
        return { kind: 'unavailable', reason: 'the Host Workspace directory is unreadable' }
      }
      // The SAME Host-dialect classifier the Direct Workspace route uses: a
      // BARE query stays the official `WorkspaceFileSearch` (index, ranking,
      // bounds, exclusions, cache), an EXPLICIT path scope enumerates the scope
      // the user typed — `..`/absolute OUTSIDE the registered root included —
      // through the shared Host scanner anchored at THIS request's registry
      // root. The root, the driver and the OS environment are the HOST's only.
      const answer: HostFileListResult = isExplicitHostFileQuery(query, environment)
        ? await listPiTuiExplicitHostFileReferences(workspace.path, query, signal, { driver, environment })
        : {
            kind: 'ok',
            items: [...await workspaceSearch.list({ workspaceId, path: workspace.path }, query, signal)],
          }
      signal.throwIfAborted()
      // A registry replacement/removal during the scan retires the old answer:
      // the candidate list must belong to the CURRENT id AND the same path.
      const current = registry.get(workspaceId)
      if (current === undefined || current.path !== workspace.path) {
        return { kind: 'unavailable', reason: 'the Host Workspace changed during discovery' }
      }
      return answer
    },
    invalidateWorkspaceSearches() {
      workspaceSearch.invalidateAll()
    },
    dispose() {
      workspaceSearch.dispose()
    },
  }
}

/** The Host Workspace root must be a readable directory BEFORE an official
 *  search runs: an unreadable root is an unavailable capability, never the
 *  authoritative empty `ok([])` of a successful enumeration. */
function isReadableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory() && accessSync(path, constants.R_OK | constants.X_OK) === undefined
  } catch {
    return false
  }
}
