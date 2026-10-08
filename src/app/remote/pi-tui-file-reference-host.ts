/**
 * The private `piTuiFileReferences` Host service (TS8-HF1) — the Cordis row the
 * Remote Host composition mounts, owning:
 *
 * ```text
 * the Host service key + wire namespace (piTuiFileReferences)
 * the `list` implementation behind the private endpoint
 * the row's lifetime
 * ```
 *
 * The Typert CONTRIBUTION (the descriptor the Gateway dispatches on) is owned
 * by the composition, not by this row: rc.2 admits exactly one contribution per
 * package identity, so all of this package's private invocations are registered
 * together in `runtime/remote/pi-tui-remote-contribution.ts`.
 *
 * The actual completion semantics live behind the transport-neutral bridge
 * (`runtime/remote/pi-tui-file-reference-host-bridge.ts`): the SAME Host-scoped
 * authority the Direct adapter uses — a bare query delegates the official
 * `ctx.fileReferences` provider, an explicit path scope runs the Host's own
 * scoped discovery. No Agent object, no Client cwd and no Client filesystem
 * fact crosses the wire.
 *
 * LAYER NOTE: this service lives in `app/remote/**` (composition owns the row
 * and its lifecycle) and reaches the Direct Host implementation only through
 * `runtime/remote/**`, which is the direction the architecture gate permits.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/pi-tui-file-reference-host
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  createPiTuiHostFileReferenceRuntime,
  type PiTuiHostFileReferenceBridgeDeps,
  type PiTuiHostFileReferenceRuntime,
} from '../../runtime/remote/pi-tui-file-reference-host-bridge.ts'
import { PI_TUI_FILE_REFERENCES_NAMESPACE } from '../../runtime/remote/pi-tui-file-reference-contract.ts'
import type { HostFileListResult } from '../../runtime/host-file-port.ts'

export type {
  FileReferencesServiceLike,
  LiveAgentLike,
  PiTuiHostFileReferenceBridgeDeps,
} from '../../runtime/remote/pi-tui-file-reference-host-bridge.ts'

/** The Host facts the composition resolves for the row. */
export type PiTuiFileReferenceHostDeps = PiTuiHostFileReferenceBridgeDeps

/**
 * The Host endpoint of the private augmentation. One instance per Remote Host
 * composition; the descriptor leaves with the owning fiber.
 */
export class PiTuiFileReferenceHostService extends TypertRemoteService {
  /** The Typert registry owns the explicit invocation definitions. */
  static readonly inject = ['typert']
  private readonly runtime: PiTuiHostFileReferenceRuntime

  /**
   * @param ctx - the Host context this row is mounted in.
   * @param deps - the narrow Host facts the composition resolved.
   */
  constructor(ctx: Context, deps: PiTuiFileReferenceHostDeps) {
    super(ctx, PI_TUI_FILE_REFERENCES_NAMESPACE)
    this.runtime = createPiTuiHostFileReferenceRuntime(deps)
  }

  /**
   * The private Remote method (`piTuiFileReferences/list`, see
   * `pi-tui-file-reference-contract.ts`). Cancellation outranks every outcome.
   */
  list(sessionId: string, query: string, signal: AbortSignal): Promise<HostFileListResult> {
    return this.runtime.list(sessionId, query, signal)
  }
}
