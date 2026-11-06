/**
 * Plugin Manager controller (S4-D1): the owner of the profile-wide official
 * inventory read, the install request identity/phase, a bounded log tail and
 * the mutation dispatch guards. Selection, search/filter, focus, scroll and
 * view mode are per-open WORKSPACE state and live in the workspace panel.
 *
 * It owns NO installed-package database, no enabled truth, no compatibility
 * evaluation and no final success: every mutation is followed by a fresh
 * official inventory read, and only that refreshed truth is rendered.
 *
 * TWO local policies live here, both NARROWING only:
 *  - Current-TUI surface safety: the bundle providing this surface and its
 *    rows can never be disabled/removed through it, enforced at dispatch as
 *    well as in the UI (never by forging Host `readOnlyReason`/`removable`).
 *  - Exact + unique extension-owner association for presentation
 *    classification (ambiguous identity falls back to DSH Plugin).
 *
 * The controller OUTLIVES the panel (plan §3): closing the surface never
 * cancels an active install, and reopening resumes the same operation.
 *
 * @module @xmoon76/dsh-pi-tui/app/plugin-manager/controller
 */

import { PluginManagerStaleResultError } from '../../runtime/plugin-manager-port.ts'
import type {
  PluginChangeFact,
  PluginInstallCancellationFact,
  PluginInstallEvent,
  PluginInstallPhaseFact,
  PluginManagerPort,
  PluginManagerSnapshot,
  PluginSpecInspectionFact,
  PluginUpdateProgressFact,
  PluginUpdateResultFact,
  PluginVersionFact,
  PluginVersionListFact,
} from '../../runtime/plugin-manager-port.ts'
import { runDetached } from '../../runtime/process/tasks.ts'
import { runSyncDisposalSteps } from '../../runtime/process/disposal.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { classifyPluginPackages, type PluginClassificationInput, type PluginPresentationRole } from './classify.ts'
import type { TuiExtensionObservation } from './extension-inventory.ts'
import {
  AUTO_REVIEW_BUNDLE,
  buildPluginManagerModel,
  bundleValue,
  changeSummary,
  entryValue,
  isSelectableUpdateVersion,
  type PluginCardView,
  type PluginManagerModel,
  type PluginManagerSectionView,
  updateVersionBlocker,
} from './model.ts'

/** The exact confirmation target classes. `remove` keeps the D1 behavior; the
 *  two Auto kinds are the B03 safety gate (no other overlay/manager). */
export type PluginConfirmationKind = 'remove' | 'auto-disable-bundle' | 'auto-disable-row'

/** The install dialog phases (TUI-only; mapped from official events/results). */
export type PluginInstallPhase =
  | 'editing'
  | 'inspecting'
  | 'confirm'
  | 'starting'
  | 'installing'
  | 'applying'
  | 'cancelling'
  | 'done'
  | 'failed'
  | 'unknown'

/** The install dialog's presentation state. */
export interface PluginInstallView {
  readonly phase: PluginInstallPhase
  readonly spec: string
  readonly registry: string | null
  /** The official catalog bundle this install was started from, if any. */
  readonly officialName?: string
  /** `pendingBuilds` approved for THIS attempt (a new explicit install). */
  readonly approvedBuilds?: readonly string[]
  readonly inspection?: PluginSpecInspectionFact
  readonly log: readonly string[]
  readonly outcome?: PluginChangeFact
  readonly message?: string
  readonly cancellable: boolean
  readonly requestId?: string
}

/** The official version-update lifecycle phases owned by this Controller. */
export type PluginUpdatePhase = 'checking' | 'selecting' | 'confirm' | 'running' | 'done' | 'unknown'

/**
 * The one Update page's presentation state. `versions` is the Host's own
 * answer to `listVersions`; `result` is the official `updateBundle` settlement;
 * `lastObservedVersion` is the AUTHORITATIVE inventory's answer to what is
 * installed now. They are intentionally separate facts.
 */
export interface PluginUpdateView {
  readonly phase: PluginUpdatePhase
  readonly cardValue: string
  readonly name: string
  /** The installed version this update was started from. */
  readonly sourceInstalled: string
  readonly versions?: PluginVersionListFact
  readonly selectedExactVersion?: string
  readonly registry?: string | null
  readonly requestId?: string
  readonly hostStep?: PluginUpdateProgressFact['step']
  readonly announcedSteps: readonly PluginUpdateProgressFact['step'][]
  readonly matchedInstallPhase?: PluginInstallPhaseFact['phase']
  readonly log: readonly string[]
  readonly result?: PluginUpdateResultFact
  readonly cancelStatus?: PluginInstallCancellationFact['status']
  readonly message?: string
  /** The authoritative inventory's installed version after the update reread. */
  readonly lastObservedVersion?: string
  readonly readback: 'pending' | 'ready' | 'error'
  /** The official result is in but the authoritative reread has not settled;
   *  the update is still running/blocking writes. */
  readonly settling: boolean
  /** True only in the legal target-installation cancellation window. */
  readonly canStopTargetInstall: boolean
  /** Whether the user explicitly released an indeterminate update. */
  readonly acknowledged: boolean
}

/** The hooks the owning runner wires. */
export interface PluginManagerControllerHooks {
  /** Repaint an open panel (no-op when closed). */
  requestRender(): void
  /** Report an out-of-panel notice (a settled install while closed). */
  notify(message: string, kind: 'info' | 'error'): void
  /** Whether the panel is currently open. */
  isOpen(): boolean
  /** The runner's diagnostics channel for the owned async tasks. */
  diag: Diag
}

/** Optional dependencies (test seams / the live extension runtime read). */
export interface PluginManagerControllerOptions {
  /** The read-only TUI extension observation source (defaults to none). */
  readonly observations?: () => readonly TuiExtensionObservation[]
}

const LOG_MAX_LINES = 40
const LOG_MAX_CHARS = 4000

let requestCounter = 0

/** One user install attempt owns exactly one id. */
function nextInstallRequestId(): string {
  requestCounter += 1
  return `plugin-install-${Date.now().toString(36)}-${requestCounter}`
}

interface ActiveInstall {
  requestId: string
  spec: string
  registry: string | null
  phase: PluginInstallPhase
  log: string[]
  message?: string
  inspection?: PluginSpecInspectionFact
  outcome?: PluginChangeFact
  inspectAbort?: AbortController
  officialName?: string
  /** The exact Host target spec that made `officialName` true. */
  officialSpec?: string
  approvedBuilds?: readonly string[]
}

/** The ONE in-flight update lifecycle (never a second manager or store). */
interface ActiveUpdate {
  cardValue: string
  name: string
  sourceInstalled: string
  sourceReadGeneration: number
  phase: PluginUpdatePhase
  versions?: PluginVersionListFact
  selectedExactVersion?: string
  registry?: string | null
  requestId?: string
  hostStep?: PluginUpdateProgressFact['step']
  announcedSteps: PluginUpdateProgressFact['step'][]
  matchedInstallPhase?: PluginInstallPhaseFact['phase']
  log: string[]
  result?: PluginUpdateResultFact
  cancelStatus?: PluginInstallCancellationFact['status']
  message?: string
  lastObservedVersion?: string
  readback: 'pending' | 'ready' | 'error'
  /** The official result arrived but the authoritative reread has not settled:
   *  the update is NOT terminal yet (plan §6.6(9), §7). */
  settling: boolean
  checkAbort?: AbortController
  checkEpoch: number
  mutationToken?: number
  cancelPending: boolean
  acknowledged: boolean
}

interface PluginConfirmation {
  readonly kind: PluginConfirmationKind
  readonly value: string
  readonly name: string
  readonly epoch: number
  /** The addressable B03 row a `auto-disable-row` confirmation targets. */
  readonly entryId?: string
}

const EMPTY_SECTION_CARDS: readonly PluginCardView[] = Object.freeze([])

/**
 * One mutation-failure notice. A result from a superseded currentness context
 * is an INDETERMINATE outcome, never a definite failure: the write may have
 * been applied, and the authoritative inventory reread (which always follows
 * this notice) decides the visible truth. The notice stays backend-neutral.
 */
function mutationFailureText(operation: string, error: unknown): string {
  if (error instanceof PluginManagerStaleResultError) {
    return 'the plugin change result arrived after its currentness context was superseded; '
      + 'the authoritative inventory reread decides the outcome'
  }
  return `${operation} failed: ${errorMessage(error)}`
}

const EMPTY_MODEL: PluginManagerModel = Object.freeze({
  sections: Object.freeze([
    { id: 'tui' as const, label: 'TUI & Extensions', cards: EMPTY_SECTION_CARDS },
    { id: 'official' as const, label: 'Official DSH', cards: EMPTY_SECTION_CARDS },
    { id: 'third-party' as const, label: 'Third-party', cards: EMPTY_SECTION_CARDS },
    { id: 'experimental' as const, label: 'Experimental', cards: EMPTY_SECTION_CARDS },
  ]),
  cards: EMPTY_SECTION_CARDS,
  registries: Object.freeze({ registry: null, fallbackRegistries: Object.freeze([]), resolved: null }),
  exemptions: Object.freeze([]),
  exemptionWarnings: Object.freeze([]),
})

/** The Plugin Manager operation/inventory owner. */
export class PluginManagerController {
  private readonly port: PluginManagerPort
  private readonly hooks: PluginManagerControllerHooks
  private readonly observationSource: (() => readonly TuiExtensionObservation[]) | undefined
  private snapshot: PluginManagerSnapshot | undefined
  private modelValue: PluginManagerModel = EMPTY_MODEL
  private state: 'loading' | 'ready' | 'error' = 'loading'
  private error: string | undefined
  /** The exact notice text of the last failed inventory read, so a later
   * successful read can clear it without clobbering an operation message. */
  private refreshErrorMessage: string | undefined
  private confirming: PluginConfirmation | undefined
  private busyValue: string | undefined
  private message: string | undefined
  private readEpoch = 0
  /** Monotonic count of REAL semantic transitions (a read started, a phase or
   *  notice or status or model change). It exists so a UI gesture fence can see
   *  "the Controller changed and changed back" — the same phase value can return
   *  (installing -> applying -> installing) while no comparable value differs. */
  private semanticTransitions = 0
  private mutationToken = 0
  private install: ActiveInstall | undefined
  private installEpoch = 0
  private update: ActiveUpdate | undefined
  private readonly unsubscribe: () => void
  private readonly unsubscribeUpdate: () => void
  private readonly unsubscribeInvalidation!: () => void
  private disposed = false

  constructor(port: PluginManagerPort, hooks: PluginManagerControllerHooks, options?: PluginManagerControllerOptions) {
    this.port = port
    this.hooks = hooks
    this.observationSource = options?.observations
    this.unsubscribe = port.subscribeInstall(event => this.onInstallEvent(event))
    try {
      this.unsubscribeUpdate = port.subscribeUpdate(progress => this.onUpdateEvent(progress))
      try {
        this.unsubscribeInvalidation = port.subscribeInvalidation(() => this.onInvalidation())
      } catch (error) {
        // Transactional acquisition: a synchronously throwing THIRD subscription
        // must not leave the first two owned by a controller the caller never
        // receives.
        this.unsubscribeUpdate()
        throw error
      }
    } catch (error) {
      this.unsubscribe()
      throw error
    }
  }

  /** One owned detached task (AGENTS.md: never a bare `void` promise chain). */
  private run(label: string, task: () => Promise<unknown>): void {
    runDetached(label, task, { diag: this.hooks.diag })
  }

  /** Mount the ONE embedded page: read the official inventory once. */
  open(): void {
    if (this.disposed) return
    this.confirming = undefined
    this.message = undefined
    this.run('plugin manager read', () => this.read())
  }

  /** Explicit Refresh: read the official inventory again. */
  refresh(): void {
    if (this.disposed) return
    this.run('plugin manager read', () => this.read())
  }

  /**
   * One transport-neutral invalidation hint arrived. Demand-aware: the
   * controller is profile-global and outlives a panel, so an invalidation
   * while no surface is showing the inventory starts NO background read.
   */
  private onInvalidation(): void {
    if (this.disposed) return
    // A new inventory invalidates a version list that has not been confirmed
    // yet (the Host may have changed what is installed); a running update keeps
    // its request id and is never re-dispatched.
    this.invalidateUpdatePreview()
    if (!this.hooks.isOpen()) return
    this.run('plugin manager read', () => this.read())
  }

  /** Release the install/update/invalidation subscriptions (runner teardown). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    runSyncDisposalSteps('plugin manager disposal', [
      () => this.install?.inspectAbort?.abort(),
      () => this.update?.checkAbort?.abort(),
      () => this.unsubscribe(),
      () => this.unsubscribeUpdate(),
      () => this.unsubscribeInvalidation(),
    ])
  }

  // ── inventory / presentation facts ───────────────────────────────────────

  /** The classified model the workspace paints. */
  model(): PluginManagerModel {
    return this.modelValue
  }

  /** The four frozen sections (Experimental always last). */
  sections(): readonly PluginManagerSectionView[] {
    return this.modelValue.sections
  }

  /** Every card in section order. */
  cards(): readonly PluginCardView[] {
    return this.modelValue.cards
  }

  /** One card by its stable value. */
  card(value: string): PluginCardView | undefined {
    return this.modelValue.cards.find(candidate => candidate.value === value)
  }

  /**
   * The monotonic inventory-read generation. It advances when ANY read starts
   * (an explicit refresh or a Host invalidation), before the new facts land, so
   * a painted action can tell "the Host asked me to re-read" from "the re-read
   * returned the same facts" — §3.4 requires a press held across a Host
   * invalidate to be refused even when the inventory is byte-identical.
   */
  readGeneration(): number {
    return this.readEpoch
  }

  /** See {@link semanticTransitions}: monotonic, never reset, pure read. */
  semanticTransitionsCount(): number {
    return this.semanticTransitions
  }

  /** Advance the monotonic transition count. Called by every write that really
   *  changes what the page presents; a bare repaint request does not. */
  private touchSemantic(): void {
    this.semanticTransitions += 1
  }

  /** The ONE presentation notification: every Controller write that changes what
   *  the page presents ends here, so the monotonic transition count is advanced
   *  exactly once per real change (this class never requests a bare repaint). */
  private notifyChanged(): void {
    this.touchSemantic()
    this.hooks.requestRender()
  }

  /** The load/error state for the panel's empty frame. */
  status(): { readonly state: 'loading' | 'ready' | 'error'; readonly error?: string } {
    return { state: this.state, ...(this.error === undefined ? {} : { error: this.error }) }
  }

  /** The transient notice line (an outcome or a read failure). */
  notice(): string | undefined {
    return this.message
  }

  /** Explain a refused/disabled affordance without touching Host state. */
  explain(message: string): void {
    this.message = message
    this.notifyChanged()
  }

  /** The card currently marked busy by an in-flight mutation. */
  busy(): string | undefined {
    return this.busyValue
  }

  // ── install view ─────────────────────────────────────────────────────────

  /** Whether a dispatched Host install still owns a request id. */
  hasDispatchedInstall(): boolean {
    const phase = this.install?.phase
    return phase === 'starting' || phase === 'installing' || phase === 'applying' || phase === 'cancelling'
  }

  /**
   * Whether the current attempt has a result/request worth reopening on a new
   * page. Failed/unknown outcomes carry pending-build approval, diagnostics and
   * the original request id; a recently done install carries its result. A
   * merely editing/inspecting/confirming draft is restored by `i` instead.
   */
  hasResumableInstall(): boolean {
    const phase = this.install?.phase
    return phase === 'done' || phase === 'failed' || phase === 'unknown' || this.hasDispatchedInstall()
  }

  /** The install dialog view, when an attempt exists. */
  installView(): PluginInstallView | undefined {
    const active = this.install
    if (active === undefined) return undefined
    return {
      phase: active.phase,
      spec: active.spec,
      registry: active.registry,
      ...(active.officialName === undefined ? {} : { officialName: active.officialName }),
      ...(active.approvedBuilds === undefined ? {} : { approvedBuilds: active.approvedBuilds }),
      ...(active.inspection === undefined ? {} : { inspection: active.inspection }),
      log: active.log,
      ...(active.outcome === undefined ? {} : { outcome: active.outcome }),
      ...(active.message === undefined ? {} : { message: active.message }),
      cancellable: active.phase === 'installing' || active.phase === 'starting',
      ...(active.phase === 'editing' || active.phase === 'inspecting' || active.phase === 'confirm'
        ? {}
        : { requestId: active.requestId }),
    }
  }

  /** Whether the install view has an explicit action to reconcile an unknown
   * or failed result. */
  canReconcileInstall(): boolean {
    const active = this.install
    return active !== undefined
      && (active.phase === 'unknown' || active.phase === 'failed')
      && active.requestId !== ''
  }

  /** Whether the failed attempt has a real Host-reported pending build set. */
  approvableBuilds(): readonly string[] | undefined {
    const active = this.install
    if (active === undefined || active.phase !== 'failed') return undefined
    const pending = active.outcome?.pendingBuilds
    return pending === undefined || pending.length === 0 ? undefined : pending
  }

  /** The Host-offered registries for the install dialog (Host facts + null). */
  registryOptions(): readonly { readonly value: string | null; readonly label: string }[] {
    const registries = this.snapshot?.registries
    const options: { value: string | null; label: string }[] = []
    options.push({ value: null, label: 'pnpm configuration default' })
    if (registries !== undefined) {
      if (registries.registry !== null) options.push({ value: registries.registry, label: registries.registry })
      for (const fallback of registries.fallbackRegistries) {
        if (fallback !== registries.registry) options.push({ value: fallback, label: fallback })
      }
    }
    return options
  }

  // ── install lifecycle ────────────────────────────────────────────────────

  /**
   * Explicitly start a fresh manual editor. The UI only calls this when no
   * attempt exists, or from the explicit New-install action on a terminal
   * result; reopening an existing attempt must not reach this method.
   */
  beginManualInstall(): boolean {
    if (this.disposed) return false
    if (this.refuseWhileUpdating()) return false
    const active = this.install
    if (active?.phase === 'unknown') {
      this.message = 'the previous install outcome is unknown; check its status before starting a new install'
      this.notifyChanged()
      return false
    }
    if (active !== undefined && active.phase !== 'done' && active.phase !== 'failed') {
      return false
    }
    // A replaced attempt must not leave an old inspect running; its late result
    // is already fenced by installEpoch, but the request itself is dropped.
    active?.inspectAbort?.abort()
    this.installEpoch += 1
    this.install = {
      requestId: nextInstallRequestId(),
      spec: '',
      registry: null,
      phase: 'editing',
      log: [],
    }
    this.message = undefined
    this.notifyChanged()
    return true
  }

  /**
   * Begin installing one OFFICIAL missing card from its Host-provided
   * `installTarget.spec`: a new explicit request id, then the official
   * `inspect` before any install dispatch. Never toggles the missing bundle.
   */
  beginOfficialInstall(value: string): boolean {
    if (this.disposed) return false
    if (this.refuseWhileUpdating()) return false
    const active = this.install
    if (active !== undefined
      && (active.phase === 'done' || active.phase === 'failed' || active.phase === 'unknown')) {
      this.message = 'an install result is still open; reopen it, then use New install to replace it'
      this.notifyChanged()
      return false
    }
    if (this.hasDispatchedInstall()) return false
    const card = this.card(value)
    if (card === undefined) {
      this.message = 'the inventory changed; refresh and try again'
      this.notifyChanged()
      return false
    }
    if (card.availability !== 'missing' || !card.canInstall || card.installTarget === undefined) {
      this.message = card.installBlockedReason ?? `${card.name} has no official install target`
      this.notifyChanged()
      return false
    }
    this.install?.inspectAbort?.abort()
    this.installEpoch += 1
    this.install = {
      requestId: nextInstallRequestId(),
      spec: card.installTarget.spec,
      registry: null,
      phase: 'editing',
      log: [],
      officialName: card.name,
      officialSpec: card.installTarget.spec,
    }
    this.message = undefined
    this.inspect(card.installTarget.spec, null)
    return true
  }

  /** Inspect one spec against the Host before offering installation. */
  inspect(spec: string, registry: string | null): void {
    const active = this.install
    if (active === undefined) return
    const trimmed = spec.trim()
    if (trimmed === '') {
      active.message = 'Enter a package spec first'
      this.notifyChanged()
      return
    }
    // A custom registry is real external input: validate the boundary before
    // dispatching, and never let the Host receive a malformed URL.
    if (registry !== null && !/^https?:\/\/\S+$/i.test(registry)) {
      active.message = 'registry must be an http(s) URL'
      this.notifyChanged()
      return
    }
    // A user-edited spec is no longer the official catalog target: drop the
    // catalog context instead of labelling a manual local/registry install as
    // an install of the card it was started from.
    if (active.officialSpec !== undefined && trimmed !== active.officialSpec) {
      active.officialName = undefined
      active.officialSpec = undefined
    }
    const epoch = ++this.installEpoch
    active.inspectAbort?.abort()
    const abort = new AbortController()
    active.inspectAbort = abort
    active.spec = trimmed
    active.registry = registry
    active.phase = 'inspecting'
    active.message = undefined
    active.inspection = undefined
    this.notifyChanged()
    this.run('plugin manager inspect', () => this.performInspect(trimmed, registry, epoch, abort))
  }

  private async performInspect(spec: string, registry: string | null, epoch: number, abort: AbortController): Promise<void> {
    try {
      const inspection = await this.port.inspect(spec, registry, abort.signal)
      if (this.disposed || this.installEpoch !== epoch) return
      const current = this.install
      if (current === undefined) return
      current.inspection = inspection
      current.phase = 'confirm'
      current.message = inspection.status === 'refused'
        ? `refused: ${inspection.problem} — ${inspection.reason}`
        : undefined
      this.notifyChanged()
    } catch (error) {
      if (this.disposed || this.installEpoch !== epoch) return
      const current = this.install
      if (current === undefined) return
      current.phase = 'editing'
      current.inspection = undefined
      current.message = error instanceof PluginManagerStaleResultError
        // The inspection facts belong to a superseded connection generation:
        // never present them as this generation's accepted confirmation.
        ? 'the inspection result arrived after its currentness context was superseded; inspect again'
        : `inspect failed: ${errorMessage(error)}`
      this.notifyChanged()
    }
  }

  /** Return to spec entry from the confirm/inspecting step (aborts an inspect). */
  editInstall(): void {
    const active = this.install
    if (active === undefined) return
    active.inspectAbort?.abort()
    active.inspectAbort = undefined
    this.installEpoch += 1
    active.phase = 'editing'
    active.message = undefined
    this.notifyChanged()
  }

  /** Dispatch the official install after an accepted inspection. */
  confirmInstall(): void {
    const active = this.install
    if (active === undefined || active.phase !== 'confirm') return
    if (active.inspection?.status !== 'accepted') return
    if (this.refuseWhileUpdating()) return
    active.phase = 'starting'
    active.message = undefined
    this.notifyChanged()
    const requestId = active.requestId
    this.run('plugin manager install', () => this.performInstall(requestId))
  }

  /** Dispatch installBundle and settle it; an indeterminate failure recovers
   * through the official waitForInstall and NEVER retries the install. */
  private async performInstall(requestId: string): Promise<void> {
    const active = this.install
    if (active === undefined || active.requestId !== requestId) return
    let outcome: PluginChangeFact
    try {
      outcome = await this.port.startInstall({
        requestId,
        spec: active.spec,
        registry: active.registry,
        // A non-bundle package has no bundle layer to activate. `null` (the
        // spec form does not say) keeps the official default activation.
        enabled: active.inspection?.status === 'accepted' && active.inspection.bundle === false ? false : true,
        ...(active.approvedBuilds === undefined ? {} : { approvedBuilds: [...active.approvedBuilds] }),
      })
    } catch (error) {
      if (this.disposed) return
      // The Host may already have accepted the request: recover through the
      // official waitForInstall before deciding, and NEVER retry installBundle.
      let recovered: PluginChangeFact | null = null
      try {
        recovered = await this.port.waitForInstall(requestId)
      } catch {
        recovered = null
      }
      if (this.disposed) return
      const current = this.install
      if (current === undefined || current.requestId !== requestId) return
      if (recovered !== null) {
        this.settleInstall(requestId, recovered)
        return
      }
      current.phase = 'unknown'
      current.message = `install outcome unknown: ${errorMessage(error)} — check the inventory below; not retried automatically`
      this.run('plugin manager read', () => this.read())
      this.notifyChanged()
      if (!this.hooks.isOpen()) this.hooks.notify('plugin install outcome unknown; inventory refreshed', 'error')
      return
    }
    if (this.disposed) return
    this.settleInstall(requestId, outcome)
  }

  /** Stop an active installation; only valid before the Host starts applying. */
  cancelInstall(): void {
    const active = this.install
    if (active === undefined) return
    if (active.phase !== 'installing' && active.phase !== 'starting') return
    active.phase = 'cancelling'
    active.message = undefined
    this.notifyChanged()
    this.run('plugin manager cancel install', () => this.performCancel(active.requestId))
  }

  private async performCancel(requestId: string): Promise<void> {
    try {
      const cancellation = await this.port.cancelInstall(requestId)
      if (this.disposed) return
      const current = this.install
      if (current === undefined || current.requestId !== requestId) return
      if (cancellation.status === 'cancelled') {
        current.phase = 'done'
        current.message = 'cancelled — profile files restored'
        // The Host restored the profile files; the visible inventory must be
        // the authoritative post-restore read, not the previous snapshot.
        this.run('plugin manager read', () => this.read())
      } else if (cancellation.status === 'too-late') {
        current.phase = 'applying'
        current.message = 'too late to cancel: the bundle is being applied'
      } else {
        current.phase = 'unknown'
        current.message = 'the installation already settled; check the installation status'
        this.run('plugin manager read', () => this.read())
      }
      this.notifyChanged()
    } catch (error) {
      if (this.disposed) return
      const current = this.install
      if (current === undefined || current.requestId !== requestId) return
      if (error instanceof PluginManagerStaleResultError) {
        // The cancellation belongs to a superseded currentness context: the
        // Host may still be installing. This is INDETERMINATE, never a fake
        // cancelled or a definite failure; reconcile the authoritative truth.
        current.phase = 'unknown'
        current.message = 'the cancellation result belongs to a superseded currentness context; check the installation status'
        this.run('plugin manager read', () => this.read())
      } else {
        current.phase = 'installing'
        current.message = `cancel failed: ${errorMessage(error)}`
      }
      this.notifyChanged()
    }
  }

  /** Leave the install view without touching the Host operation. */
  hideInstall(): void {
    if (this.install?.phase === 'inspecting') {
      this.install.inspectAbort?.abort()
      this.install.inspectAbort = undefined
      this.installEpoch += 1
      this.install.phase = 'editing'
    }
    this.notifyChanged()
  }

  /**
   * Retry the FAILED installation with the EXACT pending package set the Host
   * reported, under a NEW request id. Only an explicit user action reaches
   * this; an unconfirmed package set can never be approved here.
   */
  approvePendingBuilds(): void {
    if (this.refuseWhileUpdating()) return
    const active = this.install
    if (active === undefined || active.phase !== 'failed') return
    const pending = active.outcome?.pendingBuilds
    if (pending === undefined || pending.length === 0) return
    const requestId = nextInstallRequestId()
    this.installEpoch += 1
    active.requestId = requestId
    active.approvedBuilds = Object.freeze([...pending])
    active.phase = 'starting'
    active.log = []
    active.outcome = undefined
    active.message = `approved build scripts for ${pending.join(', ')}; installing again`
    this.notifyChanged()
    this.run('plugin manager install', () => this.performInstall(requestId))
  }

  /**
   * Reconcile an unknown/failed result through the official
   * `waitForInstall` and an authoritative inventory reread. This never
   * re-dispatches the install.
   */
  reconcileInstall(): void {
    const active = this.install
    if (active === undefined) return
    const requestId = active.requestId
    active.message = 'checking the official installation status…'
    this.notifyChanged()
    this.run('plugin manager reconcile install', () => this.performReconcile(requestId))
  }

  private async performReconcile(requestId: string): Promise<void> {
    let recovered: PluginChangeFact | null
    let stale = false
    try {
      recovered = await this.port.waitForInstall(requestId)
    } catch (error) {
      recovered = null
      stale = error instanceof PluginManagerStaleResultError
      if (!this.disposed && !stale) {
        const current = this.install
        if (current !== undefined && current.requestId === requestId) {
          current.message = `installation status check failed: ${errorMessage(error)}`
          this.notifyChanged()
        }
      }
    }
    if (this.disposed) return
    const current = this.install
    if (current === undefined || current.requestId !== requestId) return
    if (recovered !== null) {
      this.settleInstall(requestId, recovered)
      return
    }
    current.message = stale
      ? 'the status check belongs to a superseded currentness context; the authoritative inventory reread below decides the outcome'
      : 'no active Host request carries this id; inventory reread below'
    this.run('plugin manager read', () => this.read())
    this.notifyChanged()
  }

  // ── update lifecycle ─────────────────────────────────────────────────────

  /** The ONE current update lifecycle, or undefined when none exists. */
  updateView(): PluginUpdateView | undefined {
    const active = this.update
    if (active === undefined) return undefined
    return {
      phase: active.phase,
      cardValue: active.cardValue,
      name: active.name,
      sourceInstalled: active.sourceInstalled,
      ...(active.versions === undefined ? {} : { versions: active.versions }),
      ...(active.selectedExactVersion === undefined ? {} : { selectedExactVersion: active.selectedExactVersion }),
      ...(active.registry === undefined ? {} : { registry: active.registry }),
      ...(active.requestId === undefined ? {} : { requestId: active.requestId }),
      ...(active.hostStep === undefined ? {} : { hostStep: active.hostStep }),
      announcedSteps: active.announcedSteps,
      ...(active.matchedInstallPhase === undefined ? {} : { matchedInstallPhase: active.matchedInstallPhase }),
      log: active.log,
      ...(active.result === undefined ? {} : { result: active.result }),
      ...(active.cancelStatus === undefined ? {} : { cancelStatus: active.cancelStatus }),
      ...(active.message === undefined ? {} : { message: active.message }),
      ...(active.lastObservedVersion === undefined ? {} : { lastObservedVersion: active.lastObservedVersion }),
      readback: active.readback,
      settling: active.settling,
      canStopTargetInstall: canStopTargetInstall(active),
      acknowledged: active.acknowledged,
    }
  }

  /** Whether an existing update still owns the write path. A terminal `done`
   *  update is only evidence; an unacknowledged `unknown` outcome keeps the
   *  lock because the Host may still be writing. */
  private updateBlocksWrites(): boolean {
    const active = this.update
    if (active === undefined) return false
    if (active.phase === 'done') return false
    return !(active.phase === 'unknown' && active.acknowledged)
  }

  /** Refuse an old write entry point while the ONE update still owns the path. */
  private refuseWhileUpdating(): boolean {
    if (!this.updateBlocksWrites()) return false
    this.message = this.update?.phase === 'unknown'
      ? 'the previous update outcome is unknown; acknowledge it before changing plugins'
      : 'another plugin change is still in progress; wait for it to settle'
    this.notifyChanged()
    return true
  }

  /**
   * Enter the ONE Update page for a Host-updatable bundle, or reuse the
   * existing lifecycle for the same bundle (a completed list/result is never
   * re-queried implicitly). A terminal `done` update for ANOTHER bundle may be
   * replaced; an indeterminate outcome must be acknowledged first.
   */
  beginUpdate(cardValue: string): void {
    if (this.disposed) return
    const existing = this.update
    if (existing !== undefined) {
      if (existing.phase === 'running') {
        this.message = 'another plugin change is still in progress; wait for it to settle'
        this.notifyChanged()
        return
      }
      if (existing.cardValue === cardValue) {
        // Re-entry: reuse the SAME list/result. Only an acknowledged
        // indeterminate outcome may start a NEW check for this same bundle.
        if (existing.phase !== 'unknown') return
        if (!existing.acknowledged) {
          this.message = 'the previous update outcome is unknown; acknowledge it before checking again'
          this.notifyChanged()
          return
        }
      } else if (existing.phase !== 'done' && !(existing.phase === 'unknown' && existing.acknowledged)) {
        this.message = 'another plugin change is still in progress; wait for it to settle'
        this.notifyChanged()
        return
      }
    }
    if (this.refuseWhileMutating()) return
    if (this.hasDispatchedInstall()) {
      this.message = 'another plugin change is still in progress; wait for it to settle'
      this.notifyChanged()
      return
    }
    const card = this.card(cardValue)
    if (card === undefined) {
      this.message = 'the inventory changed; refresh and try again'
      this.notifyChanged()
      return
    }
    if (card.target !== 'bundle' || card.isSelf || !card.updatable) {
      this.message = `${card.name} does not support Host updates`
      this.notifyChanged()
      return
    }
    if (card.version === undefined) {
      this.message = `${card.name} declares no installed version the Host can update`
      this.notifyChanged()
      return
    }
    // A replaced lifecycle must not leave a previous version read running.
    existing?.checkAbort?.abort()
    const active: ActiveUpdate = {
      cardValue: card.value,
      name: card.name,
      sourceInstalled: card.version,
      sourceReadGeneration: this.readEpoch,
      phase: 'checking',
      announcedSteps: [],
      log: [],
      readback: 'pending',
      settling: false,
      checkEpoch: 0,
      cancelPending: false,
      acknowledged: false,
    }
    this.update = active
    this.message = undefined
    this.startUpdateCheck(active)
  }

  /**
   * Explicit `r`: re-read the official version list. This is the ONLY path
   * that repeats a registry query; hiding/reopening the page reuses the
   * current answer.
   */
  retryUpdateCheck(): void {
    const active = this.update
    if (this.disposed || active === undefined || active.phase !== 'selecting') return
    // The update itself owns the version read; only another write refuses it.
    if (this.busyValue !== undefined || this.hasDispatchedInstall()) {
      this.message = 'another plugin change is still in progress; wait for it to settle'
      this.notifyChanged()
      return
    }
    const card = this.card(active.cardValue)
    if (card === undefined || card.target !== 'bundle' || card.isSelf || !card.updatable || card.version === undefined) {
      this.markUpdatePreviewInvalid(active)
      return
    }
    active.sourceInstalled = card.version
    active.sourceReadGeneration = this.readEpoch
    this.startUpdateCheck(active)
  }

  private startUpdateCheck(active: ActiveUpdate): void {
    const epoch = ++active.checkEpoch
    active.checkAbort?.abort()
    const abort = new AbortController()
    active.checkAbort = abort
    active.phase = 'checking'
    active.versions = undefined
    active.selectedExactVersion = undefined
    active.registry = undefined
    active.message = undefined
    this.notifyChanged()
    this.run('plugin manager versions', () => this.performUpdateCheck(active, epoch, abort))
  }

  private async performUpdateCheck(active: ActiveUpdate, epoch: number, abort: AbortController): Promise<void> {
    let list: PluginVersionListFact
    try {
      list = await this.port.listVersions(active.name, abort.signal)
    } catch (error) {
      if (this.disposed || this.update !== active || active.checkEpoch !== epoch) return
      active.checkAbort = undefined
      active.phase = 'selecting'
      active.versions = undefined
      active.message = error instanceof PluginManagerStaleResultError
        ? 'the version list belongs to a superseded currentness context; check versions again'
        : `version check failed: ${errorMessage(error)}`
      this.notifyChanged()
      return
    }
    if (this.disposed || this.update !== active || active.checkEpoch !== epoch || active.phase !== 'checking') return
    // A snapshot read (refresh or Host invalidation) since the check started
    // changes the installed-version premise this list was computed from.
    const card = this.card(active.cardValue)
    if (this.readEpoch !== active.sourceReadGeneration
      || card === undefined
      || card.target !== 'bundle'
      || card.isSelf
      || !card.updatable
      || card.version !== active.sourceInstalled) {
      this.markUpdatePreviewInvalid(active)
      return
    }
    active.checkAbort = undefined
    active.versions = list
    active.phase = 'selecting'
    if (list.status === 'listed') {
      // The Host answered which registry an update installs from; the Client
      // never infers it from the install dialog.
      active.registry = list.registry
      // Prefer the first eligible STABLE version. A list of only eligible
      // prereleases starts with NO selection: the user must choose one.
      active.selectedExactVersion = list.versions
        .find(version => !version.prerelease && isSelectableUpdateVersion(version))?.version
    }
    active.message = undefined
    this.notifyChanged()
  }

  /** Select one exact version from the CURRENT Host list. No Host write. */
  selectUpdateVersion(exactVersion: string): void {
    const active = this.update
    if (this.disposed || active === undefined || active.phase !== 'selecting') return
    const list = active.versions
    if (list === undefined || list.status !== 'listed') return
    const version = list.versions.find(candidate => candidate.version === exactVersion)
    if (version === undefined) {
      this.message = "that version is not in the Host's current list; check versions again"
      this.notifyChanged()
      return
    }
    const blocked = updateVersionBlocker(version)
    if (blocked !== undefined) {
      this.message = blocked
      this.notifyChanged()
      return
    }
    active.selectedExactVersion = version.version
    active.message = undefined
    this.notifyChanged()
  }

  /** selecting -> confirm. Never writes to the Host. */
  confirmUpdateVersion(): void {
    const active = this.update
    if (this.disposed || active === undefined || active.phase !== 'selecting') return
    const list = active.versions
    const selected = active.selectedExactVersion
    if (list === undefined || list.status !== 'listed' || selected === undefined) return
    const version = list.versions.find(candidate => candidate.version === selected)
    if (version === undefined || !isSelectableUpdateVersion(version)) {
      this.markUpdatePreviewInvalid(active)
      return
    }
    const card = this.card(active.cardValue)
    if (this.readEpoch !== active.sourceReadGeneration
      || card === undefined
      || card.target !== 'bundle'
      || card.isSelf
      || !card.updatable
      || card.version !== active.sourceInstalled) {
      this.markUpdatePreviewInvalid(active)
      return
    }
    active.registry = list.registry
    active.phase = 'confirm'
    active.message = undefined
    this.notifyChanged()
  }

  /** confirm -> selecting. No Host call and no request id. */
  cancelUpdateConfirmation(): void {
    const active = this.update
    if (this.disposed || active === undefined || active.phase !== 'confirm') return
    active.phase = 'selecting'
    active.message = undefined
    this.notifyChanged()
  }

  /** confirm -> running: the ONE Host write for this update lifecycle. */
  executeUpdate(): void {
    const active = this.update
    if (this.disposed || active === undefined || active.phase !== 'confirm') return
    const selected = active.selectedExactVersion
    const list = active.versions
    if (selected === undefined || list === undefined || list.status !== 'listed') return
    // The update itself is in `confirm`, not writing; only ANOTHER in-flight
    // write may refuse this dispatch.
    if (this.busyValue !== undefined) {
      this.message = 'another plugin change is still in progress; wait for it to settle'
      this.notifyChanged()
      return
    }
    if (this.hasDispatchedInstall()) {
      this.message = 'another plugin change is still in progress; wait for it to settle'
      this.notifyChanged()
      return
    }
    // Never dispatch a selection whose authoritative premise changed since the
    // confirmation opened.
    const card = this.card(active.cardValue)
    if (this.readEpoch !== active.sourceReadGeneration
      || card === undefined
      || card.target !== 'bundle'
      || card.isSelf
      || !card.updatable
      || card.version !== active.sourceInstalled) {
      this.markUpdatePreviewInvalid(active)
      return
    }
    const requestId = nextInstallRequestId()
    active.requestId = requestId
    active.registry = list.registry
    active.phase = 'running'
    active.hostStep = undefined
    active.announcedSteps = []
    active.log = []
    active.result = undefined
    active.cancelStatus = undefined
    active.matchedInstallPhase = undefined
    active.readback = 'pending'
    active.settling = false
    active.cancelPending = false
    active.acknowledged = false
    const token = ++this.mutationToken
    active.mutationToken = token
    this.busyValue = active.cardValue
    this.message = undefined
    this.notifyChanged()
    this.run('plugin manager update', () => this.performUpdate(active, token))
  }

  private async performUpdate(active: ActiveUpdate, token: number): Promise<void> {
    const requestId = active.requestId
    const selected = active.selectedExactVersion
    if (requestId === undefined || selected === undefined) return
    let result: PluginUpdateResultFact
    try {
      result = await this.port.updateBundle(active.name, selected, active.registry ?? null, requestId)
    } catch (error) {
      if (this.disposed || token !== this.mutationToken || this.update !== active) return
      // The write may have reached the Host and may still be running: this is
      // indeterminate, never failure/success/cancellation, and is never retried.
      active.phase = 'unknown'
      active.result = undefined
      active.readback = 'pending'
      active.cancelPending = false
      active.message = `update outcome unknown: ${errorMessage(error)} — the Host may still be applying it; not retried automatically`
      this.notifyChanged()
      await this.read()
      if (this.disposed || token !== this.mutationToken || this.update !== active) return
      this.notifyChanged()
      if (!this.hooks.isOpen()) {
        this.hooks.notify('plugin update outcome unknown; authoritative inventory reread', 'error')
      }
      return
    }
    if (this.disposed || token !== this.mutationToken || this.update !== active) return
    // The operation's result is NOT the current inventory. The update stays
    // `running` (write lock held, no terminal result painted) until the
    // authoritative reread settles; `read` then commits `done` with
    // readback ready/error in ONE step (plan §6.6(9), §7 rows 336-343).
    active.result = result
    active.settling = true
    active.cancelPending = false
    active.message = 'Reading the authoritative inventory…'
    active.readback = 'pending'
    this.notifyChanged()
    await this.read()
  }

  /** Stop ONLY the target installation, in the official window. The update
   *  promise (including the Host's automatic restore) still decides the end. */
  stopUpdateTargetInstall(): void {
    const active = this.update
    if (this.disposed || active === undefined || active.phase !== 'running') return
    if (!canStopTargetInstall(active)) return
    const requestId = active.requestId
    if (requestId === undefined) return
    active.cancelPending = true
    active.message = 'stopping the target installation…'
    this.notifyChanged()
    this.run('plugin manager stop update install', () => this.performStopUpdateInstall(active, requestId))
  }

  private async performStopUpdateInstall(active: ActiveUpdate, requestId: string): Promise<void> {
    let cancellation: PluginInstallCancellationFact
    try {
      cancellation = await this.port.cancelInstall(requestId)
    } catch (error) {
      if (this.disposed || this.update !== active || active.requestId !== requestId) return
      active.cancelPending = false
      active.message = error instanceof PluginManagerStaleResultError
        ? 'the cancellation result belongs to a superseded currentness context; the Host update result decides the outcome'
        : `cancel failed: ${errorMessage(error)}`
      this.notifyChanged()
      return
    }
    if (this.disposed || this.update !== active || active.requestId !== requestId) return
    active.cancelPending = false
    active.cancelStatus = cancellation.status
    // None of these statuses ends the update: only its own promise/Host restore does.
    active.message = cancellation.status === 'cancelled'
      ? 'Target installation cancelled; awaiting Host restoration/result'
      : cancellation.status === 'too-late'
        ? 'Too late; update may apply/restart'
        : 'No active target install; awaiting update result'
    this.notifyChanged()
  }

  /** Release an indeterminate update's local write lock: only after a
   *  successful authoritative reread AND an explicit user acknowledgment. */
  acknowledgeUpdateUncertainty(): void {
    const active = this.update
    if (this.disposed || active === undefined || active.phase !== 'unknown') return
    if (active.readback !== 'ready') {
      this.message = 'an authoritative inventory reread must succeed before the update lock can be released'
      this.notifyChanged()
      return
    }
    active.acknowledged = true
    active.message = 'uncertainty acknowledged; the Host may still be finishing this update in the background'
    this.busyValue = undefined
    this.notifyChanged()
  }

  /** Hide the Update view. The panel owns the view change; this never cancels
   *  or re-dispatches anything at the Host. */
  hideUpdate(): void {
    if (this.disposed) return
  }

  private onUpdateEvent(progress: PluginUpdateProgressFact): void {
    if (this.disposed) return
    const active = this.update
    if (active === undefined || active.requestId === undefined) return
    if (active.requestId !== progress.requestId) return
    if (active.phase !== 'running') return
    if (active.hostStep === progress.step) return
    active.hostStep = progress.step
    active.announcedSteps = [...active.announcedSteps, progress.step]
    this.notifyChanged()
  }

  /** A new authoritative inventory invalidates an unconfirmed version list. */
  private invalidateUpdatePreview(): void {
    const active = this.update
    if (active === undefined) return
    if (active.phase !== 'checking' && active.phase !== 'selecting' && active.phase !== 'confirm') return
    if (active.phase === 'selecting' && active.versions === undefined && active.checkAbort === undefined) return
    this.markUpdatePreviewInvalid(active)
  }

  /** The confirmed list no longer describes the authoritative inventory. */
  private markUpdatePreviewInvalid(active: ActiveUpdate): void {
    active.checkAbort?.abort()
    active.checkAbort = undefined
    active.checkEpoch += 1
    active.phase = 'selecting'
    active.versions = undefined
    active.selectedExactVersion = undefined
    active.registry = undefined
    active.message = 'Bundle changed; check versions again'
    this.notifyChanged()
  }

  /** A successful/failed authoritative read while an update result is waiting
   *  for inventory truth settles the readback it reports. */
  private settleUpdateReadback(outcome: 'ready' | 'error', snapshot?: PluginManagerSnapshot): void {
    const active = this.update
    if (active === undefined) return
    const settling = active.settling && active.phase === 'running'
    if (!settling && active.phase !== 'done' && active.phase !== 'unknown') return
    // A successful reread also recovers a previously failed one (explicit `r reread`).
    if (active.readback === 'ready') return
    if (outcome === 'error' && active.readback === 'error') return
    active.readback = outcome
    if (outcome === 'ready' && snapshot !== undefined) {
      active.lastObservedVersion = snapshot.bundles.find(bundle => bundle.name === active.name)?.version
    }
    if (!settling) return
    // `done` is committed ONLY here: the official result plus the authoritative
    // inventory reread have both settled. A failed reread is `done` with
    // readback:error, never a fabricated current version.
    active.settling = false
    active.phase = 'done'
    active.message = undefined
    active.cancelPending = false
    if (active.mutationToken === this.mutationToken) this.busyValue = undefined
    if (!this.hooks.isOpen()) {
      const application = active.result?.result.application ?? 'unknown'
      this.hooks.notify(`plugin update ${application}: ${active.name}`, application === 'failed' ? 'error' : 'info')
    }
  }

  // ── mutations ────────────────────────────────────────────────────────────

  /**
   * ONE mutation in flight at a time. The official Host serializes profile
   * writes itself, but a second UI dispatch would let a NEWER request settle
   * first and leave the older Host write's result without a final
   * authoritative reread. Refuse the second dispatch instead of silently
   * overwriting the busy identity/token.
   */
  private refuseWhileMutating(): boolean {
    if (this.busyValue !== undefined) {
      this.message = 'another plugin change is still in progress; wait for it to settle'
      this.notifyChanged()
      return true
    }
    if (this.updateBlocksWrites()) {
      this.message = this.update?.phase === 'unknown'
        ? 'the previous update outcome is unknown; acknowledge it before changing plugins'
        : 'another plugin change is still in progress; wait for it to settle'
      this.notifyChanged()
      return true
    }
    if (this.state === 'loading') {
      this.message = 'the plugin inventory is refreshing; wait for it to settle'
      this.notifyChanged()
      return true
    }
    if (this.state === 'error') {
      this.message = 'the plugin inventory is stale after a failed refresh; refresh before changing plugins'
      this.notifyChanged()
      return true
    }
    return false
  }

  /**
   * The write is not settled until the authoritative inventory has been read
   * back. Keep `busyValue` set across that read so no second write can be
   * admitted from the pre-write snapshot; a failed read leaves `state:'error'`
   * and `refuseWhileMutating()` keeps rejecting stale-state writes until a
   * successful refresh.
   */
  private async finishMutation(token: number): Promise<void> {
    if (this.disposed || token !== this.mutationToken) return
    try {
      await this.read()
    } finally {
      if (!this.disposed && token === this.mutationToken) this.busyValue = undefined
      this.notifyChanged()
    }
  }

  /**
   * Toggle one card through the official authority. Re-resolves the card by
   * stable value against the CURRENT inventory and re-checks the effective
   * capability before dispatch.
   *
   * Returns true only when the B03 safety confirmation was opened instead of
   * dispatching the write (the exact Auto Review bundle, currently enabled).
   */
  toggleCard(value: string): boolean {
    if (this.refuseWhileMutating()) return false
    const card = this.card(value)
    if (card !== undefined && card.name === AUTO_REVIEW_BUNDLE && card.enabled) {
      return this.requestAutoDisable(value)
    }
    this.run('plugin manager toggle', () => this.performToggleCard(value))
    return false
  }

  private async performToggleCard(value: string): Promise<void> {
    if (this.refuseWhileMutating()) return
    const card = this.card(value)
    if (card === undefined) {
      this.message = 'the plugin inventory changed; refresh and try again'
      this.notifyChanged()
      return
    }
    // Defense in depth: a direct semantic caller that bypassed the synchronous
    // gate above still cannot disable the enabled B03 bundle without the one
    // shared confirmation. No Host call happens here.
    if (card.name === AUTO_REVIEW_BUNDLE && card.enabled) {
      this.requestAutoDisable(card.value)
      return
    }
    if (card.availability === 'missing' && !card.enabled) {
      this.message = card.canInstall
        ? `${card.name} is not installed; use Install… from its detail`
        : card.installBlockedReason ?? `${card.name} is not installed`
      this.notifyChanged()
      return
    }
    if (!card.canToggle) {
      this.message = card.toggleBlockedReason ?? `cannot change ${card.name}`
      this.notifyChanged()
      return
    }
    const token = ++this.mutationToken
    this.busyValue = card.value
    this.message = undefined
    this.notifyChanged()
    try {
      const change = card.target === 'bundle'
        ? await this.port.setBundleEnabled(card.name, !card.enabled)
        : await this.port.setPluginEnabled(card.rows[0]!.entryId, !card.enabled)
      if (this.disposed || token !== this.mutationToken) return
      this.message = changeSummary(change)
    } catch (error) {
      if (this.disposed || token !== this.mutationToken) return
      this.message = mutationFailureText('enable/disable', error)
    }
    await this.finishMutation(token)
  }

  /**
   * Toggle one addressable row of the card identified by stable value.
   * Returns true only when the B03 row confirmation opened (no write).
   */
  toggleRow(cardValue: string, entryId: string): boolean {
    if (this.refuseWhileMutating()) return false
    const card = this.card(cardValue)
    const row = card?.rows.find(candidate => candidate.entryId === entryId)
    if (card !== undefined && card.name === AUTO_REVIEW_BUNDLE && row?.enabled === true) {
      return this.requestAutoDisable(cardValue, entryId)
    }
    this.run('plugin manager row toggle', () => this.performToggleRow(cardValue, entryId))
    return false
  }

  private async performToggleRow(cardValue: string, entryId: string): Promise<void> {
    if (this.refuseWhileMutating()) return
    const card = this.card(cardValue)
    const row = card?.rows.find(candidate => candidate.entryId === entryId)
    if (card !== undefined && card.name === AUTO_REVIEW_BUNDLE && row?.enabled === true) {
      this.requestAutoDisable(cardValue, entryId)
      return
    }
    if (card === undefined || row === undefined) {
      this.message = 'the plugin inventory changed; refresh and try again'
      this.notifyChanged()
      return
    }
    if (!row.canToggle) {
      this.message = row.selfProtected
        ? `${entryId} is controlled by the Current TUI composition and cannot be changed from here`
        : `cannot change ${entryId}: ${row.readOnlyReason ?? 'not addressable'}`
      this.notifyChanged()
      return
    }
    const token = ++this.mutationToken
    this.busyValue = rowToggleValueBusy(entryId)
    this.message = undefined
    this.notifyChanged()
    try {
      const change = await this.port.setPluginEnabled(entryId, !row.enabled)
      if (this.disposed || token !== this.mutationToken) return
      this.message = changeSummary(change)
    } catch (error) {
      if (this.disposed || token !== this.mutationToken) return
      this.message = mutationFailureText('enable/disable', error)
    }
    await this.finishMutation(token)
  }

  /** Open the destructive confirmation for one bundle. Returns whether it opened. */
  requestRemove(value: string): boolean {
    if (this.refuseWhileMutating()) return false
    const card = this.card(value)
    if (card === undefined || card.target !== 'bundle') return false
    if (!card.canRemove) {
      this.message = card.removeBlockedReason ?? `cannot remove ${card.name}`
      this.notifyChanged()
      return false
    }
    this.confirming = { kind: 'remove', value: card.value, name: card.name, epoch: this.readEpoch }
    this.message = undefined
    this.notifyChanged()
    return true
  }

  /**
   * Open the ONE shared safety confirmation before disabling the enabled B03
   * bundle (or one of its addressable rows). Returns false when the current
   * authoritative card does not prove that exact target. No Host mutation is
   * dispatched here.
   */
  requestAutoDisable(value: string, entryId?: string): boolean {
    if (this.refuseWhileMutating()) return false
    const card = this.card(value)
    if (card === undefined || card.name !== AUTO_REVIEW_BUNDLE || !card.enabled) return false
    if (entryId === undefined) {
      if (card.target !== 'bundle' || !card.canToggle) {
        this.message = card.toggleBlockedReason ?? `cannot disable ${card.name}`
        this.notifyChanged()
        return false
      }
      this.confirming = { kind: 'auto-disable-bundle', value: card.value, name: card.name, epoch: this.readEpoch }
    } else {
      const row = card.rows.find(candidate => candidate.entryId === entryId)
      if (row === undefined || !row.enabled || !row.canToggle) {
        this.message = row?.selfProtected === true
          ? `${entryId} is controlled by the Current TUI composition and cannot be changed from here`
          : `cannot disable ${entryId}: ${row?.readOnlyReason ?? 'not addressable'}`
        this.notifyChanged()
        return false
      }
      const exactEntryId = row.entryId
      this.confirming = {
        kind: 'auto-disable-row',
        value: card.value,
        name: card.name,
        epoch: this.readEpoch,
        entryId: exactEntryId,
      }
    }
    this.message = undefined
    this.notifyChanged()
    return true
  }

  /** The exact confirmation class currently open (never inferred by a view). */
  confirmationKind(): PluginConfirmationKind | undefined {
    return this.confirming?.kind
  }

  /** The exact B03 row a row confirmation targets. */
  confirmationEntryId(): string | undefined {
    return this.confirming?.entryId
  }

  /** The card named by the CURRENT remove confirmation, or undefined when the
   * inventory/epoch no longer proves the same target. */
  confirmingCard(): PluginCardView | undefined {
    const confirmation = this.confirming
    if (confirmation === undefined) return undefined
    if (confirmation.epoch !== this.readEpoch) return undefined
    return this.card(confirmation.value)
  }

  /** The exact name the confirmation must display. */
  confirmingName(): string | undefined {
    return this.confirming?.name
  }

  /** Abandon the open confirmation without touching the Host. */
  cancelConfirmation(): void {
    if (this.confirming === undefined) return
    this.confirming = undefined
    this.notifyChanged()
  }

  /** D1-compatible removal cancel: only a `remove` confirmation is cancelled. */
  cancelRemove(): void {
    if (this.confirming?.kind !== 'remove') return
    this.cancelConfirmation()
  }

  /** Dispatch the confirmed removal against the CURRENT authoritative card. */
  confirmRemove(): void {
    if (this.confirming?.kind !== 'remove') return
    this.run('plugin manager remove', () => this.performConfirmRemove())
  }

  /** Dispatch the confirmed B03 disable through the official Host mutation. */
  confirmAutoDisable(): void {
    if (this.confirming === undefined || this.confirming.kind === 'remove') return
    this.run('plugin manager auto-review disable', () => this.performConfirmAutoDisable())
  }

  private async performConfirmAutoDisable(): Promise<void> {
    if (this.refuseWhileMutating()) return
    const confirmation = this.confirming
    if (confirmation === undefined || confirmation.kind === 'remove') return
    const card = this.confirmingCard()
    const row = confirmation.kind === 'auto-disable-row'
      ? card?.rows.find(candidate => candidate.entryId === confirmation.entryId)
      : undefined
    const stillProven = card !== undefined
      && card.name === AUTO_REVIEW_BUNDLE
      && card.enabled
      && (confirmation.kind === 'auto-disable-bundle'
        ? card.target === 'bundle' && card.canToggle
        : row !== undefined && row.enabled && row.canToggle)
    if (!stillProven) {
      this.confirming = undefined
      this.message = 'Auto Review changed since the confirmation opened; nothing was changed'
      this.notifyChanged()
      return
    }
    const token = ++this.mutationToken
    this.busyValue = confirmation.kind === 'auto-disable-row' && confirmation.entryId !== undefined
      ? rowToggleValueBusy(confirmation.entryId)
      : confirmation.value
    this.confirming = undefined
    this.message = undefined
    this.notifyChanged()
    try {
      const change = confirmation.kind === 'auto-disable-bundle'
        ? await this.port.setBundleEnabled(confirmation.name, false)
        : await this.port.setPluginEnabled(confirmation.entryId!, false)
      if (this.disposed || token !== this.mutationToken) return
      this.message = changeSummary(change)
    } catch (error) {
      if (this.disposed || token !== this.mutationToken) return
      this.message = mutationFailureText('disable', error)
    }
    await this.finishMutation(token)
  }

  private async performConfirmRemove(): Promise<void> {
    if (this.refuseWhileMutating()) return
    const confirmation = this.confirming
    if (confirmation === undefined || confirmation.kind !== 'remove') return
    const card = this.confirmingCard()
    if (card === undefined || card.isSelf || !card.canRemove) {
      this.confirming = undefined
      this.message = card?.isSelf === true
        ? selfRefusal(confirmation.name, card.role)
        : 'the bundle changed since the confirmation opened; nothing was removed'
      this.notifyChanged()
      return
    }
    const token = ++this.mutationToken
    this.busyValue = confirmation.value
    this.confirming = undefined
    this.message = undefined
    this.notifyChanged()
    try {
      const change = await this.port.removeBundle(confirmation.name)
      if (this.disposed || token !== this.mutationToken) return
      this.message = changeSummary(change)
    } catch (error) {
      if (this.disposed || token !== this.mutationToken) return
      this.message = mutationFailureText('remove', error)
    }
    await this.finishMutation(token)
  }

  // ── internal ─────────────────────────────────────────────────────────────

  private buildModel(snapshot: PluginManagerSnapshot): PluginManagerModel {
    const observations = this.observationSource?.() ?? []
    const inputs: PluginClassificationInput[] = []
    const bundledEntryIds = new Set<string>()
    for (const bundle of snapshot.bundles) {
      for (const row of bundle.rows) {
        if (row.entryId !== undefined) bundledEntryIds.add(String(row.entryId))
      }
      inputs.push({
        key: bundleValue(bundle.name),
        bundleName: bundle.name,
        // ONLY proven Loader entry ids: a module specifier is not ownership
        // proof and must never satisfy the association.
        entryIds: bundle.rows.flatMap(row => row.entryId === undefined ? [] : [String(row.entryId)]),
        official: bundle.official,
        availability: bundle.availability,
        installed: bundle.installed,
        ...(bundle.source === undefined ? {} : { source: bundle.source }),
      })
    }
    for (const entry of snapshot.plugins) {
      if (bundledEntryIds.has(entry.entryId)) continue
      inputs.push({ key: entryValue(entry.entryId), entryIds: [entry.entryId] })
    }
    const claims = classifyPluginPackages(inputs, observations)
    return buildPluginManagerModel(snapshot, claims)
  }

  private async read(): Promise<void> {
    if (this.disposed) return
    // Any new authoritative inventory invalidates an unconfirmed version
    // preview; a running/terminal update keeps its own lifecycle.
    this.invalidateUpdatePreview()
    // Latest-started read wins: starting a newer read invalidates EVERY older
    // in-flight read, so an older read can neither repaint stale inventory
    // after it started nor clear a newer failure.
    const epoch = ++this.readEpoch
    this.state = 'loading'
    this.notifyChanged()
    try {
      const snapshot = await this.port.snapshot()
      if (this.disposed || epoch !== this.readEpoch) return
      this.snapshot = snapshot
      this.modelValue = this.buildModel(snapshot)
      this.state = 'ready'
      this.error = undefined
      // Clear only the read-failure notice (never an operation outcome the
      // caller just set).
      if (this.message === this.refreshErrorMessage) this.message = undefined
      this.refreshErrorMessage = undefined
      this.settleUpdateReadback('ready', snapshot)
      this.notifyChanged()
    } catch (error) {
      if (this.disposed || epoch !== this.readEpoch) return
      // A failed refresh keeps the last good snapshot.
      this.state = 'error'
      this.error = errorMessage(error)
      this.refreshErrorMessage = `refresh failed: ${this.error}`
      this.message = this.refreshErrorMessage
      this.settleUpdateReadback('error')
      this.notifyChanged()
    }
  }

  private settleInstall(requestId: string, outcome: PluginChangeFact): void {
    const current = this.install
    if (current === undefined || current.requestId !== requestId) return
    current.outcome = outcome
    if (outcome.application === 'failed') {
      current.phase = 'failed'
      current.message = changeSummary(outcome)
    } else if (outcome.application === 'cancelled') {
      current.phase = 'done'
      current.message = 'cancelled — profile files restored'
    } else {
      current.phase = 'done'
      current.message = changeSummary(outcome)
    }
    this.notifyChanged()
    this.run('plugin manager read', () => this.read())
    if (!this.hooks.isOpen()) {
      this.hooks.notify(
        `plugin install ${outcome.application}: ${outcome.target}`,
        outcome.application === 'failed' ? 'error' : 'info',
      )
    }
  }

  private onInstallEvent(event: PluginInstallEvent): void {
    if (this.disposed) return
    // Only the operation that OWNS this exact request id may consume the
    // event. The update and the install are independent lifecycles: their
    // logs and phases must never cross over.
    const updating = this.update
    if (updating !== undefined
      && updating.phase === 'running'
      && updating.requestId !== undefined
      && eventRequestId(event) === updating.requestId) {
      if (event.kind === 'phase') {
        updating.matchedInstallPhase = event.phase.phase
        this.notifyChanged()
        return
      }
      if (this.appendLog(updating, event.log.stream, event.log.text)) this.notifyChanged()
      return
    }
    const active = this.install
    if (active === undefined) return
    if (event.kind === 'phase') {
      if (event.phase.requestId !== active.requestId) return
      if (event.phase.phase === 'installing') active.phase = 'installing'
      else if (event.phase.phase === 'applying') active.phase = 'applying'
      else if (event.phase.phase === 'cancelling') active.phase = 'cancelling'
      if (event.phase.attempt !== undefined) {
        active.message = `installing from ${event.phase.attempt.registry ?? 'pnpm default'} (${event.phase.attempt.index}/${event.phase.attempt.total})`
      }
      this.notifyChanged()
      return
    }
    if (event.log.requestId !== active.requestId) return
    if (!this.appendLog(active, event.log.stream, event.log.text)) return
    this.notifyChanged()
  }

  /** Append one Host log chunk to ONE bounded log owner. Returns whether the
   *  bounded log really changed: an empty/blank chunk is NOT a presentation
   *  change, so the caller must not notify (a no-op notification would advance
   *  the monotonic transition count and revoke a legitimate held gesture). */
  private appendLog(target: { log: string[] }, stream: 'stdout' | 'stderr', text: string): boolean {
    if (text === '') return false
    let appended = false
    for (const line of text.split('\n')) {
      if (line === '') continue
      target.log.push(stream === 'stderr' ? `! ${line}` : line)
      appended = true
    }
    if (!appended) return false
    if (target.log.length > LOG_MAX_LINES) target.log.splice(0, target.log.length - LOG_MAX_LINES)
    let total = target.log.reduce((sum, line) => sum + line.length + 1, 0)
    while (total > LOG_MAX_CHARS && target.log.length > 1) {
      total -= (target.log.shift()!.length + 1)
    }
    return true
  }
}

/** The busy key for one row-level toggle (never the card row's identity). */
function rowToggleValueBusy(entryId: string): string {
  return `action:toggle-row:${entryId}`
}

/** The request id one install event names (logs may omit it). */
function eventRequestId(event: PluginInstallEvent): string | undefined {
  return event.kind === 'phase' ? event.phase.requestId : event.log.requestId
}

/** `s stop target install` is legal ONLY while the Host is really installing
 *  the update's target and before it starts restoring the former version. */
function canStopTargetInstall(active: ActiveUpdate): boolean {
  return active.phase === 'running'
    && !active.settling
    && !active.cancelPending
    && active.hostStep === 'installing'
    && active.matchedInstallPhase === 'installing'
}

/** The refusal text for a self-protected target: the whole TUI bundle vs one of
 * its modules (a protected standalone entry is not "the current TUI" itself). */
function selfRefusal(name: string, role: PluginPresentationRole): string {
  return role === 'current-tui'
    ? `${name} provides the current TUI and cannot be changed from here`
    : `${name} is controlled by the Current TUI composition and cannot be changed from here`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
