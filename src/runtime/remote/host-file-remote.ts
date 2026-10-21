/**
 * Remote implementation of the semantic `HostFilePort` (M3-3A; TS8-HF1 routes
 * the SESSION scope through the private `piTuiFileReferences` endpoint).
 *
 * The SESSION scope maps to the PRIVATE Host augmentation Remote
 * (`piTuiFileReferences/list(sessionId, query, signal)`, see
 * `runtime/remote/pi-tui-file-reference-contract.ts`): the Host owns the
 * Session/Agent lookup AND the bare-vs-explicit `@` route — a bare query
 * delegates the official `ctx.fileReferences` provider, an explicit path scope
 * runs the Host's own scoped discovery. The Client sends only the exact
 * `sessionId` (including a viewed child Session), the official query form and
 * its cancellation; it never discovers a file itself (no cwd/home guess, no
 * local file source, no stat probes) and never re-ranks or re-slices what the
 * Host returned.
 *
 * Explicitly unsupported (requalified through 0.2.0-rc.2): the
 * WORKSPACE/sessionless scope (every private endpoint is Session-scoped) and
 * existence probing (no public existence verb —
 * `piTuiFileReferences/list` is discovery only). Both are returned as
 * `unavailable` with a reason, never as an authoritative empty list or a
 * proven `missing`. Submitted mentions stay literal — which is not a
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
 *  Its value is the Host router's own `HostFileListResult`: an `unavailable`
 *  business value (an unresolvable Session) is NOT a transport failure. */
export interface RemotePiTuiFileReferenceRemotes {
  list(
    sessionId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<RemoteReadResult<HostFileListResult>>
}

/** The Remote Host-file port: the private Session-scoped discovery only. */
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
    // unsupported workspace scope below (an aborted request rejects, the
    // M3-3A failure vocabulary).
    const signal = options?.signal
    signal?.throwIfAborted()
    if (scope.kind !== 'session') {
      // No sessionless carrier exists: an explicit unavailable, never a
      // Client fs scan and never a fake empty success.
      return {
        kind: 'unavailable',
        reason: 'workspace-scoped Host file discovery has no official Remote carrier',
      }
    }
    const capturedGeneration: RemoteConnectionGeneration | undefined = this.generation.getSnapshot()
    if (capturedGeneration === undefined) {
      return { kind: 'unavailable', reason: 'the Remote connection is not connected' }
    }
    // The exact sessionId (a viewed child included) is the only locality
    // fact: the Host endpoint owns the Session/Agent lookup semantics AND the
    // bare-vs-explicit route decision for the query.
    let result: RemoteReadResult<HostFileListResult>
    try {
      result = await this.fileReferences.list(scope.sessionId, query, signal)
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
    if (!result.ok) throw new Error(`piTuiFileReferences/list failed: ${remoteFailureMessage(result.error)}`)
    // A Host-business unavailable (an unresolvable Session) crosses as the
    // same port outcome; the Host's own candidates are detached path-only DTOs.
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
