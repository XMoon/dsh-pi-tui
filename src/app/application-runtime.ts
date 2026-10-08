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
import type { TerminalProgressOutcome } from '../domain/terminal-progress/settings.ts'
import type { SubmissionPresentationSource } from './submission/presentation.ts'
import type { Backend, BackendKind } from '../runtime/backend.ts'
import type { SessionOwnerAccess, SessionOwnerRetirement } from './session/owner-access.ts'
import type { PiTuiExtensionService } from '../extensions.ts'

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
  /**
   * The Client-local UI startup facts (M3-6 PR1): the detached
   * `sessionId`/`presetId` data the Remote application's Client UI subtree
   * (extension host + first-party builtins on the official Client Context)
   * mounts under. Data facts ONLY — the Host-only `markSurfaceMounted`
   * readiness callback never crosses into the Client Context.
   */
  readonly clientUiStartup: ClientUiStartupFacts
}

/**
 * The detached startup facts the Remote Client-local UI subtree consumes
 * (M3-6 PR1 D2): plain data only. It must never contain
 * `markSurfaceMounted`, `appExit`, a Host Context, a Loader,
 * `profileContext`, Host services or callbacks — the Client Context gets a
 * frozen copy of exactly these two optional fields.
 */
export interface ClientUiStartupFacts {
  readonly sessionId?: string
  readonly presetId?: string
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
  /** The commands-only, generation-fenced metadata read (PR4 §2.2). */
  readCommands(sessionId: string, signal?: AbortSignal): Promise<import('../runtime/surface-authority-port.ts').SurfaceAuthoritySnapshot['commands'] | undefined>
  /** The §2.2/§16 admission transport identity (generation + exact
   *  binding), captured ONCE before the provider reads. */
  captureTransportToken(sessionId: string): unknown
  /** Whether the captured transport identity is still live (the COMBINED
   *  multi-provider settle re-checks this after every await). */
  isTransportTokenCurrent(sessionId: string, token: unknown): boolean
  /** Current official Connection generation; undefined while disconnected
   *  (M3-6 PR2). Direct delegation only — the SAME official snapshot
   *  object by identity, never a cached/normalized copy. */
  connectionGeneration(): unknown | undefined
  /** Subscribe the official Connection generation observable (M3-6 PR2):
   *  the invalidation hint the Client-local CommandSurface consumes. The
   *  returned unsubscribe is the official one, unchanged. */
  subscribeConnectionGeneration(listener: () => void): () => void
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
  /** The M3-5 PR2 Task Center read source (descendant catalog + Job roster). */
  readonly task: RemoteTaskApplicationSource
  /** The M3-5 PR2 child-view source (retained child reference + read/ingress). */
  readonly childView: import('./surface/viewer-runtime.ts').ViewerChildSource<import('./surface/session-presentation.ts').SessionPresentationEvent>
  /** The M3-5 PR2 durable image read of the OWNING presentation's retained
   *  Session (exact scoped lifetime, never an ambient "currently displayed"
   *  subject). */
  readonly attachments: RemoteAttachmentSource
  /** The R2 Remote terminal-progress Host evidence stream (the ONLY main
   *  terminal-outcome authority on this branch). */
  readonly terminalProgress: RemoteTerminalProgressSource
}

/**
 * The exact display-subject lifetime a durable attachment read is authorized
 * under: the Connection generation at capture time plus the EXACT SessionBinding
 * object the owning presentation was created with. A same-binding Connection
 * generation rollover is the official ADOPTION (the retained binding survives),
 * while a DIFFERENT binding retires the presentation.
 */
export interface RemoteTransportLifetime {
  readonly generation: unknown
  readonly binding: unknown
}

/**
 * One authorized Remote main-Agent progress fact (R2 §7.1/§7.2): the Host
 * already classified the outcome with the shared interval fold, so the Client
 * only carries the proven `(running, outcome)` pair. `kind` distinguishes the
 * opening authoritative SNAPSHOT (display truth only, NEVER completion
 * evidence) from a real Host `update` edge.
 */
export interface RemoteMainProgressFact {
  readonly kind: 'snapshot' | 'update'
  readonly running: boolean
  /** The SAME settled-outcome vocabulary the Direct adapter uses (declared
   *  once in `domain/terminal-progress/settings.ts`). */
  readonly outcome: TerminalProgressOutcome
}

/**
 * The neutral Remote terminal-progress source (R2 §7.1): the ONE Host evidence
 * stream of the current main session, fenced by the exact transport identity.
 * The CALLER owns the iteration, so cancellation and failure ownership stay
 * with the bootstrap (the same shape as the live-ingress subscription).
 */
export interface RemoteTerminalProgressSource {
  /**
   * Open the Host evidence stream of one session.
   * @throws when the session has no retained binding, when a frame violates the
   * private contract, or when the transport identity moved mid-stream.
   */
  open(sessionId: string, signal: AbortSignal): AsyncIterable<RemoteMainProgressFact>
}

/**
 * The neutral Remote durable-image read face (M3-5 PR2 Step 9): resolve one
 * attachment through the EXACT retained binding the OWNING presentation was
 * authorized under. There is no Host attachment shortcut and no cold retain on
 * this path. `expectedLifetime` is REQUIRED — the seam itself expresses the
 * owning-presentation invariant, so there is no "read through whatever binding
 * the Session has now" path: a missing/malformed lifetime, a different binding,
 * or a missing binding fails closed BEFORE the Session is touched.
 */
export interface RemoteAttachmentSource {
  readDurableImage(
    sessionId: string,
    attachmentId: string,
    expectedLifetime: RemoteTransportLifetime,
  ): Promise<{ ref: unknown; data: Uint8Array }>
}

/**
 * The neutral Remote Task Center source face (M3-5 PR2): the semantic Task
 * descendant read plus the official Client model's roster/activity reads and
 * invalidation subscriptions. Declared structurally here so the composition
 * root consumes it without any static `app/remote/**` edge.
 */
export interface RemoteTaskApplicationSource {
  /** The full descendant catalog + root Job roster read. */
  readDescendants(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<import('../runtime/task-read-port.ts').TaskReadSnapshot | undefined>
  /** The CURRENT official Job roster of one root session. */
  jobs(sessionId: string): readonly import('../runtime/task-read-port.ts').TaskJobEntry[]
  /**
   * The CURRENT official activity of one descendant, read from the Session-list
   * fact (`byId.running`) WITHOUT borrowing or retaining a binding — the Task
   * listing deliberately retains no descendant. `undefined` = the Client does
   * not know the Session.
   */
  activityOf(childSessionId: string): 'running' | 'inactive' | undefined
  /** Subscribe the official Job state changes (roster/status invalidation). */
  subscribeJobs(listener: () => void): () => void
  /** Subscribe the official Session-list changes (catalog/activity
   * availability invalidation). */
  subscribeSessions(listener: () => void): () => void
  /** Release the retained roster watch and invalidate every in-flight read.
   *  Idempotent; must run before the Client Context is disposed. */
  dispose(): void
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
      /** Older history prepended to the window front (an official
       * `loadOlder` by any consumer): re-fold the presentation from the
       * widened window. */
      onWindowPrepended: (sessionId: string) => void
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
 *  graph), its presentation source bundle, and the SELECTED Client-local
 *  extension service from that same aggregate (M3-6 PR1: the Remote branch's
 *  UI extension authority — the Client Context's `piTuiExtensions`, never a
 *  Host-context lookup). The selection seam re-uses the aggregate's selected
 *  core instead of constructing a second Remote graph; internal/test paths
 *  only. The override carries the narrow service object, NOT the Client
 *  Context or plugin fibers; only the selected PiTuiExtensionService
 *  capability crosses the in-process composition seam. */
export interface RemoteApplicationOverride {
  readonly selected: SelectedApplicationRuntime
  readonly presentation: RemoteApplicationSources
  readonly extensionService: PiTuiExtensionService
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
