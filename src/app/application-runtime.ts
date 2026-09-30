/**
 * The transport-neutral application-composition result (M3-4 PR1): what the
 * application composition root (`app/bootstrap.ts`) needs from whichever
 * backend application runtime the internal selection seam picked — the
 * semantic `Backend` plus the Session owner pair the transport-neutral session
 * runtime consumes, and the LATE transport disposal slot.
 *
 * This is NOT a new Backend SDK: it only groups the already-required
 * application composition ownership. Direct-only helpers (compose/agentFor/
 * queueAgentFor/modelSelections/...) stay on `DirectApplicationRuntime`;
 * later M3-4 PRs replace their individual Direct assumptions through their
 * owning domains, never through a speculative neutral facade here.
 *
 * `disposeTransport()` disposes adapter/transport composition AFTER the
 * application/session owners have completed their own retirement; for Direct
 * it is a no-op (the Direct backend owns no transport graph). It must never
 * retire the currently selected Session — that remains `app/session`
 * ownership.
 *
 * Transport-neutral by contract: this module must not import
 * `@deepseek-ai/dsh-agent`, `app/remote/**` or `runtime/remote/**`.
 * @module @xmoon76/dsh-pi-tui/app/application-runtime
 */

import type { Backend, BackendKind } from '../runtime/backend.ts'
import type { SessionOwnerAccess, SessionOwnerRetirement } from './session/owner-access.ts'

/**
 * The one selected application runtime core: the common inputs the bootstrap
 * binds into the session runtime (`owners`/`retirement`/`lifecycle` via
 * `backend.sessionLifecycle`) plus the selected-runtime teardown hook.
 */
export interface SelectedApplicationRuntime {
  readonly kind: BackendKind
  readonly backend: Backend
  readonly owners: SessionOwnerAccess
  readonly retirement: SessionOwnerRetirement

  /**
   * Dispose adapter/transport composition after application/session owners
   * have completed their own retirement. Idempotent; error-preserving (a
   * step's failure never skips the remaining steps).
   */
  disposeTransport(): Promise<void>
}

/**
 * The Remote application-runtime composition input for the selection seam
 * (M3-4 PR1): exactly the arguments the Remote aggregate needs. The seam owns
 * the LOADING (`runtime/backend-loader.ts` — the sole sanctioned dynamic
 * boundary into the Remote composition); the composition input itself stays
 * transport-descriptive, so this module imports no Remote code.
 */
export interface RemoteApplicationSelection {
  /** The already-running ordinary Host Context (never disposed by the graph). */
  readonly hostContext: object
  /** Host bootstrap prerequisite barrier owned by the caller (M3-0 ordering
   *  contract: the Remote composition must not race the Host-local
   *  legacy-settings migration). */
  readonly waitForHostPrerequisites: () => Promise<void>
  /** Lifecycle signal observed between the Host prerequisite and composition. */
  readonly signal?: AbortSignal
  /**
   * The application-owned prompt serializer (the D2.2 writer dependency).
   * PR1 supplies a real one only in composition tests; the production
   * serializer is completed in the M3-4 submission PR. There is deliberately
   * NO default here: a missing serializer is a composition error, never a
   * fabricated partial Remote writer.
   */
  readonly promptSerializer: object
}

/** The internal application runtime-selection seam input (M3-4 PR1): which
 *  branch to select and HOW to construct it. The Direct branch takes a
 *  FACTORY, never a pre-built runtime; the Remote branch takes the
 *  composition INPUT — the seam itself reaches the Remote aggregate through
 *  the lazy `runtime/backend-loader.ts` boundary, making this seam the sole
 *  product-level Remote application runtime construction owner (plan §5). */
export interface ApplicationRuntimeSelection {
  readonly kind: BackendKind
  /** Construct the Direct application runtime (the Direct branch's source). */
  readonly createDirect: () => {
    readonly backend: Backend
    readonly owners: SessionOwnerAccess
    readonly retirement: SessionOwnerRetirement
  }
  /** The Remote composition input (internal/test M3-4 paths only). */
  readonly remote: RemoteApplicationSelection | undefined
}
