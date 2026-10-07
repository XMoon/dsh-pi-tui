/**
 * The Remote Host-side bridge for the private `piTuiFileReferences` endpoint
 * (TS8-HF1): a CONSTRUCTION/ADAPTATION seam ONLY. It binds the private Remote
 * method to the SAME Host-scoped completion authority the Direct adapter uses
 * (`runtime/direct/host-file-augmentation-direct.ts` + the Direct Host
 * discovery driver) and returns a transport-neutral `list` runtime.
 *
 * It owns NO Cordis service, NO Typert registration and NO lifecycle policy —
 * the Cordis service, its Typert contribution registration and its disposal
 * remain with the Remote Host composition
 * (`app/remote/pi-tui-file-reference-host.ts`). The dependency direction is
 * therefore `app/remote/** -> runtime/remote/** -> runtime/direct/**`, never
 * `app/remote/** -> runtime/direct/**`.
 *
 * The bridge lives in `runtime/remote/**` because that layer may consume the
 * Direct Host implementation; the composition layer may not.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-file-reference-host-bridge
 */

import {
  DirectHostDiscoveryDriver,
  hostPathQueryEnvironment,
} from '../direct/file-completion/host-discovery.ts'
import {
  listPiTuiHostFileReferences,
  type FileReferencesServiceLike,
  type LiveAgentLike,
} from '../direct/host-file-augmentation-direct.ts'
import type { HostFileListResult } from '../host-file-port.ts'

export type { FileReferencesServiceLike, LiveAgentLike } from '../direct/host-file-augmentation-direct.ts'

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
}

/** The private Remote method's Host-side implementation. */
export interface PiTuiHostFileReferenceRuntime {
  list(sessionId: string, query: string, signal: AbortSignal): Promise<HostFileListResult>
}

/**
 * Bind the private Remote method to the Host-scoped completion authority.
 * The Host finder is resolved ONCE for the runtime's lifetime (it is a pure
 * PATH pin; a later PATH change is not a Host completion fact).
 */
export function createPiTuiHostFileReferenceRuntime(
  deps: PiTuiHostFileReferenceBridgeDeps,
): PiTuiHostFileReferenceRuntime {
  const driver = new DirectHostDiscoveryDriver(deps.fdPath)
  const environment = hostPathQueryEnvironment()
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
      })
    },
  }
}
