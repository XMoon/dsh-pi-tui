/**
 * Remote implementation of the semantic `HostFilePort` (M3-3A; TS8-HF1 routes
 * the SESSION scope through the private `piTuiFileReferences` endpoint; M6-1/
 * F5-B adds the sessionless WORKSPACE verb).
 *
 * The SESSION scope maps to the PRIVATE Host augmentation Remote
 * (`piTuiFileReferences/list(sessionId, query, signal)`): the Host owns the
 * Session/Agent lookup AND the bare-vs-explicit `@` route — a bare query
 * delegates the official `ctx.fileReferences` provider, an explicit path scope
 * runs the Host's own scoped discovery. The WORKSPACE scope maps to
 * `piTuiFileReferences/listWorkspace(workspaceId, query, signal)`: the Host
 * owns the official Workspace discovery for the confirmed, Host-issued
 * `workspaceId`. The Client sends only the exact Session identity OR the exact
 * Workspace identity, the official query form and its cancellation; it never
 * discovers a file itself (no cwd/home guess, no local file source, no stat
 * probes) and never re-ranks or re-slices what the Host returned. The Client's
 * `selectionRevision` is currentness bookkeeping and never reaches the wire.
 *
 * An UNSELECTED workspace scope (no `workspaceId`) answers `unavailable`
 * WITHOUT dispatching anything. Explicitly unsupported (requalified through
 * 0.2.0-rc.2): existence probing (no public existence verb —
 * `piTuiFileReferences/list` and `listWorkspace` are discovery only). It is
 * returned as `unavailable` with a reason, never as an authoritative empty
 * list or a proven `missing`. Submitted mentions stay literal — which is not a
 * fallback at all but the official client contract itself.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/host-file-remote
 */

import { remoteFailureMessage } from './write-failure.ts'
import type {
  HostFileCandidate,
  HostFileListResult,
  HostFilePort,
  HostFileResolveResult,
  HostFileScope,
} from '../host-file-port.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
  RemoteReadResult,
} from './session-reader-remote.ts'

/** The private Host augmentation Remote namespace (`piTuiFileReferences`).
 *  Its values are the Host router's own `HostFileListResult`: an `unavailable`
 *  business value (an unresolvable Session/Workspace) is NOT a transport
 *  failure. */
export interface RemotePiTuiFileReferenceRemotes {
  list(
    sessionId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<RemoteReadResult<HostFileListResult>>
  listWorkspace(
    workspaceId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<RemoteReadResult<HostFileListResult>>
}

/** The Remote Host-file port: the private discovery only. */
export class RemoteHostFilePort implements HostFilePort {
  private readonly fileReferences: RemotePiTuiFileReferenceRemotes
  private readonly generation: RemoteConnectionGenerationSource

  constructor(fileReferences: RemotePiTuiFileReferenceRemotes, generation: RemoteConnectionGenerationSource) {
    this.fileReferences = fileReferences
    this.generation = generation
  }

  async listReferences(
    scope: HostFileScope,
    query: string,
    options?: { signal?: AbortSignal },
  ): Promise<HostFileListResult> {
    // Cancellation wins over EVERY other outcome — including the
    // unselected/unresolvable workspace scope below (an aborted request
    // rejects, the M3-3A failure vocabulary).
    const signal = options?.signal
    signal?.throwIfAborted()
    if (scope.kind === 'workspace') {
      if (scope.workspaceId === undefined) {
        // No Host Workspace has been selected: ZERO dispatch, never a Client
        // fs scan and never a fake empty success.
        return { kind: 'unavailable', reason: 'Choose a Host workspace first' }
      }
      const workspaceId = scope.workspaceId
      return await this.settle(captured => this.fileReferences.listWorkspace(workspaceId, query, captured), signal)
    }
    return await this.settle(captured => this.fileReferences.list(scope.sessionId, query, captured), signal)
  }

  /**
   * The ONE settle path both scopes share: capture the Connection generation,
   * dispatch the private call with the SAME signal, and turn a replaced
   * connection into an unavailable answer (never the new generation's failure).
   * A Host-business unavailable crosses as the port outcome; its candidates are
   * copied into detached path-only DTOs.
   */
  private async settle(
    dispatch: (signal: AbortSignal | undefined) => Promise<RemoteReadResult<HostFileListResult>>,
    signal: AbortSignal | undefined,
  ): Promise<HostFileListResult> {
    const capturedGeneration: RemoteConnectionGeneration | undefined = this.generation.getSnapshot()
    if (capturedGeneration === undefined) {
      return { kind: 'unavailable', reason: 'the Remote connection is not connected' }
    }
    let result: RemoteReadResult<HostFileListResult>
    try {
      result = await dispatch(signal)
      signal?.throwIfAborted()
    } catch (error) {
      signal?.throwIfAborted()
      // A lost/replaced Connection is an unavailable answer, never the new
      // generation's failure.
      if (!Object.is(capturedGeneration, this.generation.getSnapshot())) {
        return { kind: 'unavailable', reason: 'the Remote connection was replaced during discovery' }
      }
      throw error
    }
    if (!Object.is(capturedGeneration, this.generation.getSnapshot())) {
      return { kind: 'unavailable', reason: 'the Remote connection was replaced during discovery' }
    }
    if (!result.ok) throw new Error(`piTuiFileReferences discovery failed: ${remoteFailureMessage(result.error)}`)
    // A Host-business unavailable (an unresolvable Session/Workspace) crosses
    // as the same port outcome; the Host's own candidates are detached
    // path-only DTOs.
    if (result.value.kind === 'unavailable') {
      return { kind: 'unavailable', reason: result.value.reason }
    }
    const items: HostFileCandidate[] = result.value.items.map(candidate => ({
      path: candidate.path,
      kind: candidate.kind,
    }))
    return { kind: 'ok', items }
  }

  async resolveReference(
    _scope: HostFileScope,
    _path: string,
    options?: { signal?: AbortSignal },
  ): Promise<HostFileResolveResult> {
    // A cancelled probe rejects even though the capability answer is
    // synchronous — cancellation wins over the unavailable below (M3-3A
    // failure vocabulary).
    options?.signal?.throwIfAborted()
    // No public existence/canonicalization verb exists: unavailable, never
    // `missing` (which would assert the Host checked and the path is gone).
    return {
      kind: 'unavailable',
      reason: 'Host file existence probing has no Remote carrier',
    }
  }

  async canonicalizeMentions(_scope: HostFileScope, text: string): Promise<string> {
    // The OFFICIAL mention semantics (not merely a missing-carrier
    // fallback): the selected reference is literal prompt text and the
    // Host's FILE_REFERENCE_PROMPT owns its resolution. Direct answers
    // verbatim too — the two backends send the SAME bytes.
    return text
  }
}
