/**
 * Remote implementation of the semantic `HostFilePort` (M3-3A).
 *
 * The SESSION scope maps to the official Session-scoped
 * `fileReferences/list(agentId, query, signal)` Remote — the Host owns the
 * Session/Agent lookup, so the exact `sessionId` (including a viewed child
 * Session) is the only locality fact that crosses. The adapter performs no
 * Client-filesystem discovery of its own (no cwd/home guess, no local file
 * source, no stat probes).
 *
 * Explicitly unsupported (docs/m3-entry-contract.md §10, requalified
 * through 0.2.0-rc.2): the WORKSPACE/sessionless scope (every file endpoint is
 * Session-scoped) and existence probing (no public existence verb —
 * `fileReferences/list` is discovery only). Both are returned as
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

/** One wire candidate of the official `fileReferences/list` value (the
 * upstream `FileReferenceCandidate` shape: path + kind). */
export interface RemoteFileReferenceCandidate {
  readonly path: string
  readonly kind: 'file' | 'directory'
}

/** The official generated `fileReferences` Remote namespace. */
export interface RemoteHostFileRemotes {
  list(
    agentId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<RemoteReadResult<readonly RemoteFileReferenceCandidate[]>>
}

/** The Remote Host-file port: official Session-scoped discovery only. */
export class RemoteHostFilePort implements HostFilePort {
  private readonly fileReferences: RemoteHostFileRemotes
  private readonly generation: RemoteConnectionGenerationSource

  constructor(fileReferences: RemoteHostFileRemotes, generation: RemoteConnectionGenerationSource) {
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
      // No official workspace/sessionless carrier exists: an explicit
      // unavailable, never a Client fs scan and never a fake empty success.
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
    // fact: the Host endpoint owns the Session/Agent lookup semantics.
    let result: RemoteReadResult<readonly RemoteFileReferenceCandidate[]>
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
    if (!result.ok) throw new Error(`fileReferences/list failed: ${remoteFailureMessage(result.error)}`)
    // Detached path-only candidates: the Client presentation (ranking,
    // quoting, the `@`-insertion value) is this side's own policy.
    const items: HostFileCandidate[] = result.value.map(candidate => ({
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
      reason: 'Host file existence probing has no official Remote carrier',
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
