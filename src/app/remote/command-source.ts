/**
 * M3-4 PR4 Remote command source (plan §D1/§12.2): the branch-specific
 * application read bundle the command surface consumes when the internal
 * selection seam picked the Remote runtime.
 *
 * Composition rule (§D1): assembled from the SAME existing Remote aggregate
 * — the `RemoteSurfaceAuthorityReader` (metadata-only), the shared sessions
 * service + Connection generation, and nothing else. No second Connection,
 * no second Client Context, no second Sessions service, and the authority
 * reader is NEVER widened to carry callbacks/functions.
 *
 * The bundle exposes exactly the branch-specific facts the command owner
 * needs that are NOT already available through `Backend.sessionReader` /
 * `PresentationReader` / the presentation sessionFacts / `Backend.config`:
 * here that is the Host command catalog metadata read (commands/list) plus
 * the human skill metadata read (skills/list) behind one generation-fenced
 * snapshot — the shape `CatalogRefreshCoordinator`'s agent-target read
 * consumes on the Remote branch.
 *
 * No public package export; reached only inside `app/remote/**` and handed
 * to the bootstrap through the presentation-source bundle.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/command-source
 */

import { RemoteSurfaceAuthorityReader, type RemoteSurfaceAuthoritySource } from '../../runtime/remote/surface-authority-remote.ts'
import type { SurfaceAuthoritySnapshot } from '../../runtime/surface-authority-port.ts'
import type { RemoteConnectionGenerationSource } from '../../runtime/remote/session-reader-remote.ts'

/** The official command+skill metadata read the Remote command surface
 *  consumes (the `SurfaceAuthorityReader` contract, unchanged). */
export type RemoteCommandCatalogRead = SurfaceAuthoritySnapshot

/** The Remote command source: the ONE branch-specific command authority
 *  bundle. `read` is metadata-only and generation-fenced by the underlying
 *  `RemoteSurfaceAuthorityReader`. */
export interface RemoteCommandSource {
  /** Read the Host command + human-skill metadata for one session's exact
   *  Connection generation. `undefined` = the read was superseded by a
   *  Connection rollover (never an empty success). */
  read(sessionId: string, signal?: AbortSignal): Promise<RemoteCommandCatalogRead | undefined>
  /** Read ONLY the Host command metadata (§2.2): the coordinator maps the
   *  command provider here and the skill provider through the semantic skill
   *  capability, so one failing provider degrades alone. */
  readCommands(sessionId: string, signal?: AbortSignal): ReturnType<RemoteSurfaceAuthorityReader['readCommands']>
  /** Capture the §2.2/§16 admission transport identity (Connection
   *  generation + exact binding) for one session's catalog operation. */
  captureTransportToken(sessionId: string): unknown
  /** Whether the captured transport identity is still live for the
   *  session (a same-id binding rollover or Connection replacement reads
   *  stale — the COMBINED settle of a multi-provider read re-checks this). */
  isTransportTokenCurrent(sessionId: string, token: unknown): boolean
}

/** The narrow one-source face this bundle consumes: the SAME shared sessions
 *  service + generated Remote namespaces the M3-3A assembly owns. */
export interface RemoteCommandSourceInputs {
  /** The official generated commands + skills namespaces (metadata reads). */
  readonly authority: RemoteSurfaceAuthoritySource
  /** The ONE shared Connection generation source (fence owner). */
  readonly generation: RemoteConnectionGenerationSource
  /** The ONE shared sessions service — the §16 exact-binding fence source
   *  (a same-id release/re-retain must invalidate a settled metadata read). */
  readonly bindings: {
    binding(id: string): unknown
  }
}

/** Assemble the Remote command source from the ONE aggregate's shared
 *  faces. The `RemoteSurfaceAuthorityReader` is constructed here (per §D1,
 *  outside `Backend`) and never re-created per read. */
export function createRemoteCommandSource(inputs: RemoteCommandSourceInputs): RemoteCommandSource {
  const reader = new RemoteSurfaceAuthorityReader(inputs.authority, inputs.generation, inputs.bindings as never)
  // The §2.2/§16 transport identity the COMBINED catalog read re-checks
  // after every settle (the SAME generation + exact-binding pair the
  // sessionFacts fence exposes; sourced from this bundle's own inputs).
  const transportOf = (sessionId: string): unknown => ({
    generation: inputs.generation.getSnapshot(),
    binding: inputs.bindings.binding(sessionId),
  })
  return {
    read: (sessionId, signal) => reader.read(sessionId, signal),
    readCommands: (sessionId, signal) => reader.readCommands(sessionId, signal),
    captureTransportToken: transportOf,
    isTransportTokenCurrent: (sessionId, token) => {
      const captured = token as { generation?: unknown; binding?: unknown } | undefined
      if (captured === undefined || typeof captured !== 'object') return false
      if (!Object.is(captured.generation, inputs.generation.getSnapshot())) return false
      return inputs.bindings.binding(sessionId) === captured.binding
    },
  }
}
