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

/** The internal application runtime-selection seam input (M3-4 PR1): which
 *  branch to select and HOW to construct it. Both branches take FACTORIES,
 *  never pre-built runtimes: a Remote selection must not have a Direct
 *  runtime already constructed (plan §10.2 "no Direct factory invoked"), and
 *  a Direct selection must not even load the Remote module. */
export interface ApplicationRuntimeSelection {
  readonly kind: BackendKind
  /** Construct the Direct application runtime (the Direct branch's source). */
  readonly createDirect: () => {
    readonly backend: Backend
    readonly owners: SessionOwnerAccess
    readonly retirement: SessionOwnerRetirement
  }
  /** Lazily construct the Remote application runtime (internal/test M3-4). */
  readonly createRemote: (() => Promise<SelectedApplicationRuntime>) | undefined
}
