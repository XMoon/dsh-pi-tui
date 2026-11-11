/**
 * The private `piTuiFileReferences` Host service (TS8-HF1; M6-1/F5-B adds the
 * sessionless Workspace verb) — one of the internal business rows the built-in
 * PiTui Host Runtime mounts, owning:
 *
 * ```text
 * the Host service key + wire namespace (piTuiFileReferences)
 * the `list` implementation behind the private Session endpoint
 * the `listWorkspace` implementation behind the private Workspace endpoint
 * the row's lifetime (resident official workspace indexes included)
 * ```
 *
 * The Typert CONTRIBUTION (the descriptors the Gateway dispatches on) is owned
 * by the built-in Host Runtime, not by this row: rc.2 admits exactly one
 * contribution per package identity, so all of this package's private
 * invocations are registered together in
 * `runtime/remote/pi-tui-remote-contribution.ts`.
 *
 * The actual completion semantics live behind the transport-neutral bridge
 * (`runtime/remote/pi-tui-file-reference-host-bridge.ts`): the SAME Host-scoped
 * Session authority the Direct adapter uses — a bare query delegates the
 * official `ctx.fileReferences` provider, an explicit path scope runs the
 * Host's own scoped discovery — plus the OFFICIAL Workspace search for the
 * sessionless `workspaceId` verb. No Agent object, no Client cwd and no Client
 * filesystem fact crosses the wire.
 *
 * `listWorkspace` is OWNER-ONLY: the Host verifies the live Owner invocation
 * (and its peer/lifecycle signals) BEFORE any registry lookup or file read,
 * re-reads the registry per request and re-checks the same identity after the
 * scan. The official `WorkspaceId` is a target identity, never a file-access
 * credential; the Owner peer is.
 *
 * LAYER NOTE: this service lives in `app/host/features/**` (the built-in Host
 * Runtime owns the row and its lifecycle) and reaches the Direct Host
 * implementation only through `runtime/remote/**`, which is the direction the
 * architecture gate permits.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/features/file-reference
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import {
  createPiTuiHostFileReferenceRuntime,
  type PiTuiHostFileReferenceBridgeDeps,
  type PiTuiHostFileReferenceRuntime,
  type WorkspaceRegistryPort,
  type WorkingDirectoryServiceLike,
} from '../../../runtime/remote/pi-tui-file-reference-host-bridge.ts'
import { PI_TUI_FILE_REFERENCES_NAMESPACE } from '../../../runtime/remote/pi-tui-file-reference-contract.ts'
import type { HostFileListResult } from '../../../runtime/host-file-port.ts'

export type {
  FileReferencesServiceLike,
  LiveAgentLike,
  PiTuiHostFileReferenceBridgeDeps,
  WorkingDirectoryServiceLike,
  WorkspaceRegistryPort,
} from '../../../runtime/remote/pi-tui-file-reference-host-bridge.ts'

/** The Host facts the built-in Host Runtime resolves for the row. */
export type PiTuiFileReferenceHostDeps = PiTuiHostFileReferenceBridgeDeps

/**
 * The Host endpoint of the private augmentation. One instance per built-in
 * Host Runtime; the descriptor leaves with the owning fiber.
 */
export class PiTuiFileReferenceHostService extends TypertRemoteService {
  /** The Typert registry owns the explicit invocation definitions. */
  static readonly inject = ['typert']
  private readonly runtime: PiTuiHostFileReferenceRuntime
  /** The row lifetime: aborts an in-flight sessionless scan when the service
   *  is disposed (Host unload/HMR). */
  private readonly lifecycle = new AbortController()
  private disposed = false
  private disposal: Promise<void> | undefined

  /**
   * @param ctx - the Host context this row is mounted in.
   * @param deps - the narrow Host facts the built-in Host Runtime resolved.
   */
  constructor(ctx: Context, deps: PiTuiFileReferenceHostDeps) {
    super(ctx, PI_TUI_FILE_REFERENCES_NAMESPACE)
    // The Host plane owns the Session directory read: the private Remote
    // method answers the Host's OWN effective directory, never the Client's.
    this.runtime = createPiTuiHostFileReferenceRuntime({
      ...deps,
      workingDirectory: () => ctx.get('workingDirectory') as WorkingDirectoryServiceLike | undefined,
    })
    // The official bare-index freshness hook: a Host tool result may have
    // changed the tree, so the resident workspace indexes are marked stale.
    // This is the existing `session/event` plane, not a second file watcher.
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/result') this.runtime.invalidateWorkspaceSearches()
    }, { global: true })
    ctx.effect(() => () => this.dispose(), 'pi-tui-file-reference-workspace-indexes')
  }

  /**
   * The private Remote method (`piTuiFileReferences/list`, see
   * `pi-tui-file-reference-contract.ts`). Cancellation outranks every outcome.
   */
  list(sessionId: string, query: string, signal: AbortSignal): Promise<HostFileListResult> {
    return this.runtime.list(sessionId, query, signal)
  }

  /**
   * The sessionless private Remote method
   * (`piTuiFileReferences/listWorkspace`). OWNER-ONLY and fail-closed: no
   * invocation/peer identity, a non-Owner principal, an ended invocation or a
   * disposed service refuse BEFORE any Workspace lookup or file read. The
   * official search runs inside the combined invocation/peer/lifecycle signal
   * and the same identity is re-checked before the answer is returned.
   */
  async listWorkspace(
    workspaceId: string,
    query: string,
    signal: AbortSignal,
  ): Promise<HostFileListResult> {
    signal.throwIfAborted()
    const invocation = this.ctx.invocation
    if (!this.isOwnerInvocation(invocation)) {
      return { kind: 'unavailable', reason: 'Host workspace file discovery is restricted to the authenticated Owner peer' }
    }
    if (this.disposed || this.lifecycle.signal.aborted) {
      return { kind: 'unavailable', reason: 'the Host file reference service is stopping' }
    }
    const runSignal = AbortSignal.any([signal, invocation.signal, invocation.peer.signal, this.lifecycle.signal])
    const result = await this.runtime.listWorkspace(workspaceId, query, runSignal)
    runSignal.throwIfAborted()
    if (!this.isOwnerInvocation(this.ctx.invocation)) {
      return { kind: 'unavailable', reason: 'the Owner invocation ended during Host workspace discovery' }
    }
    return result
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.lifecycle.abort()
    this.runtime.dispose()
    this.disposal = Promise.resolve()
    return this.disposal
  }

  private isOwnerInvocation(invocation: RemoteInvocation | undefined): invocation is RemoteInvocation {
    return invocation !== undefined
      && invocation.peer.principal.kind === 'owner'
      && !invocation.signal.aborted
      && !invocation.peer.signal.aborted
  }
}
