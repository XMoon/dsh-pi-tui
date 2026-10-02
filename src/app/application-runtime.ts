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

import type { PresentationReader } from '../runtime/presentation-read-port.ts'
import type { SessionReader } from '../runtime/session-reader-port.ts'
import type { SubmissionPresentationSource } from '../submission-presentation.ts'
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

/**
 * The Remote branch's application presentation sources (M3-4 PR2/PR4),
 * declared STRUCTURALLY here so the composition root (`app/bootstrap.ts`)
 * consumes the bundle without any static `app/remote/**` edge — the real
 * bundle is assembled inside `app/remote/presentation-source.ts` from the
 * ONE aggregate and satisfies these shapes by construction.
 */
/**
 * The Remote branch's branch-specific command authority read (PR4 §D1):
 * Host command + human-skill metadata behind one generation-fenced
 * snapshot, declared STRUCTURALLY so the composition root stays
 * transport-clean. The real bundle is assembled inside
 * .
 */
export interface RemoteCommandSourceFace {
  read(sessionId: string, signal?: AbortSignal): Promise<import('../runtime/surface-authority-port.ts').SurfaceAuthoritySnapshot | undefined>
}

export interface RemoteApplicationSources {
  /** The ONE shared presentation reader (the M3-3A Remote adapter). */
  readonly presentationReader: PresentationReader
  /** The official pending-submissions optimistic echo source. */
  readonly submissionPresentation: SubmissionPresentationSource
  /** The eventSource live-ingress subscription factory. */
  readonly liveIngress: RemoteLiveIngressFactory
  /** The official Session-scoped facts (sessionStatus/plan/running). */
  readonly sessionFacts: RemoteSessionFactsSource
  /** The branch-specific command authority read (PR4). */
  readonly commandSource: RemoteCommandSourceFace
}

/** The neutral live-ingress factory face (see `app/remote/live-ingress.ts`
 *  for the official-contract documentation; this structural mirror keeps
 *  the bootstrap transport-clean). */
export interface RemoteLiveIngressFactory {
  subscribe(
    sessionId: string,
    sinks: {
      onDurableEvent: (sessionId: string, event: { readonly type: string; readonly seq: number; readonly time: number }) => void
      onLiveInput: (input: import('../runtime/assistant-stream-port.ts').AssistantLiveInput) => void
      onWindowReplaced: (sessionId: string) => void
      onSessionSnapshotChanged: (sessionId: string) => void
      /** The official PROJECTION store changed: the only channel carrying
       *  projection-owned current values (the Session snapshot never does). */
      onProjectionsChanged: (sessionId: string) => void
    },
    /** The cold-hydration snapshot revision: a higher subscription-time
     *  revision means events landed in the hydrate→subscribe gap and the
     *  ingress recovers through `onWindowReplaced` (never a lost event). */
    hydrateRevision?: number,
  ): { dispose(): void } | undefined
}

/** The pre-composed Remote application input for the internal L6
 *  composition entry (M3-4 PR2): the aggregate the caller already built
 *  through `createRemoteApplicationRuntime` (ONE Host/Client/Backend/owner
 *  graph), plus its presentation source bundle. The selection seam re-uses
 *  the aggregate's selected core instead of constructing a second Remote
 *  graph; internal/test paths only. */
export interface RemoteApplicationOverride {
  readonly selected: SelectedApplicationRuntime
  readonly presentation: RemoteApplicationSources
}

/** The neutral Session-scoped facts face. */
export interface RemoteSessionFactsSource {
  sessionStatus: SessionReader['sessionStatus']
  plan(sessionId: string): { readonly active: boolean; readonly pending: boolean } | undefined
  running(sessionId: string): boolean | undefined
  /** The §6.5 transport identity capture/compare pair (Connection
   *  generation + exact binding object; see the owning module). */
  captureTransportToken(sessionId: string): unknown
  isTransportTokenCurrent(sessionId: string, token: unknown): boolean
  /** The official whole-log `sessionStats` projection value off the exact
   *  retained binding (PR4 §3.3; unknown-shaped — the composer narrows it;
   * an absent capability reads undefined, never a window-fold substitute). */
  sessionStatsProjection(sessionId: string): unknown
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
  /**
   * A pre-built selected core the seam adopts VERBATIM (M3-4 PR2 internal
   * L6 composition): the caller already constructed the ONE Remote
   * application aggregate through the canonical path; the seam constructs
   * nothing and returns this core by identity. Internal/test paths only —
   * the production `apply()` selection never supplies it.
   */
  readonly preselected?: SelectedApplicationRuntime
}
