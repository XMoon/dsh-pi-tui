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

import type {
  PluginChangeFact,
  PluginInstallEvent,
  PluginManagerPort,
  PluginManagerSnapshot,
  PluginSpecInspectionFact,
} from '../../runtime/plugin-manager-port.ts'
import { runDetached } from '../../runtime/process/tasks.ts'
import { runSyncDisposalSteps } from '../../runtime/process/disposal.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { classifyPluginPackages, type PluginClassificationInput, type PluginPresentationRole } from './classify.ts'
import type { TuiExtensionObservation } from './extension-inventory.ts'
import {
  buildPluginManagerModel,
  bundleValue,
  changeSummary,
  entryValue,
  type PluginCardView,
  type PluginManagerModel,
  type PluginManagerSectionView,
} from './model.ts'

/** Which host opened the shared surface (navigation wording differs only). */
export type PluginManagerEntryHost = 'direct-command' | 'settings-entry'

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

/** The hooks the owning runner wires. */
export interface PluginManagerControllerHooks {
  /** Repaint an open panel (no-op when closed). */
  requestRender(): void
  /** Ask the owning host to close the surface (`/plugins` root or Settings). */
  requestClose(): void
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

interface RemoveConfirmation {
  readonly value: string
  readonly name: string
  readonly epoch: number
}

const EMPTY_SECTION_CARDS: readonly PluginCardView[] = Object.freeze([])

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
  private entryHost: PluginManagerEntryHost = 'direct-command'
  private confirming: RemoveConfirmation | undefined
  private busyValue: string | undefined
  private message: string | undefined
  private readEpoch = 0
  private mutationToken = 0
  private install: ActiveInstall | undefined
  private installEpoch = 0
  private readonly unsubscribe: () => void
  private readonly unsubscribeInvalidation!: () => void
  private disposed = false

  constructor(port: PluginManagerPort, hooks: PluginManagerControllerHooks, options?: PluginManagerControllerOptions) {
    this.port = port
    this.hooks = hooks
    this.observationSource = options?.observations
    this.unsubscribe = port.subscribeInstall(event => this.onInstallEvent(event))
    try {
      this.unsubscribeInvalidation = port.subscribeInvalidation(() => this.onInvalidation())
    } catch (error) {
      // Transactional acquisition, symmetric with the adapters: a synchronously
      // throwing SECOND subscription must not leave the install subscription
      // owned by a controller the caller never receives.
      this.unsubscribe()
      throw error
    }
  }

  /** One owned detached task (AGENTS.md: never a bare `void` promise chain). */
  private run(label: string, task: () => Promise<unknown>): void {
    runDetached(label, task, { diag: this.hooks.diag })
  }

  /** Open the shared surface from one host: read once. */
  open(host: PluginManagerEntryHost): void {
    if (this.disposed) return
    this.entryHost = host
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
    if (!this.hooks.isOpen()) return
    this.run('plugin manager read', () => this.read())
  }

  /** Release the install-event and invalidation subscriptions (runner teardown). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    runSyncDisposalSteps('plugin manager disposal', [
      () => this.install?.inspectAbort?.abort(),
      () => this.unsubscribe(),
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
    this.hooks.requestRender()
  }

  /** The host that opened the surface. */
  host(): PluginManagerEntryHost {
    return this.entryHost
  }

  /** The card currently marked busy by an in-flight mutation. */
  busy(): string | undefined {
    return this.busyValue
  }

  /** Ask the owning host to close the surface (normal user close). */
  requestClose(): void {
    this.hooks.requestClose()
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
    const active = this.install
    if (active !== undefined && active.phase !== 'done' && active.phase !== 'failed' && active.phase !== 'unknown') {
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
    this.hooks.requestRender()
    return true
  }

  /**
   * Begin installing one OFFICIAL missing card from its Host-provided
   * `installTarget.spec`: a new explicit request id, then the official
   * `inspect` before any install dispatch. Never toggles the missing bundle.
   */
  beginOfficialInstall(value: string): boolean {
    if (this.disposed) return false
    if (this.hasDispatchedInstall()) return false
    const card = this.card(value)
    if (card === undefined) {
      this.message = 'the inventory changed; refresh and try again'
      this.hooks.requestRender()
      return false
    }
    if (card.availability !== 'missing' || !card.canInstall || card.installTarget === undefined) {
      this.message = card.installBlockedReason ?? `${card.name} has no official install target`
      this.hooks.requestRender()
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
      this.hooks.requestRender()
      return
    }
    // A custom registry is real external input: validate the boundary before
    // dispatching, and never let the Host receive a malformed URL.
    if (registry !== null && !/^https?:\/\/\S+$/i.test(registry)) {
      active.message = 'registry must be an http(s) URL'
      this.hooks.requestRender()
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
    this.hooks.requestRender()
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
      this.hooks.requestRender()
    } catch (error) {
      if (this.disposed || this.installEpoch !== epoch) return
      const current = this.install
      if (current === undefined) return
      current.phase = 'editing'
      current.message = `inspect failed: ${errorMessage(error)}`
      this.hooks.requestRender()
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
    this.hooks.requestRender()
  }

  /** Dispatch the official install after an accepted inspection. */
  confirmInstall(): void {
    const active = this.install
    if (active === undefined || active.phase !== 'confirm') return
    if (active.inspection?.status !== 'accepted') return
    active.phase = 'starting'
    active.message = undefined
    this.hooks.requestRender()
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
      this.hooks.requestRender()
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
    this.hooks.requestRender()
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
      this.hooks.requestRender()
    } catch (error) {
      if (this.disposed) return
      const current = this.install
      if (current === undefined || current.requestId !== requestId) return
      current.phase = 'installing'
      current.message = `cancel failed: ${errorMessage(error)}`
      this.hooks.requestRender()
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
    this.hooks.requestRender()
  }

  /**
   * Retry the FAILED installation with the EXACT pending package set the Host
   * reported, under a NEW request id. Only an explicit user action reaches
   * this; an unconfirmed package set can never be approved here.
   */
  approvePendingBuilds(): void {
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
    this.hooks.requestRender()
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
    this.hooks.requestRender()
    this.run('plugin manager reconcile install', () => this.performReconcile(requestId))
  }

  private async performReconcile(requestId: string): Promise<void> {
    let recovered: PluginChangeFact | null
    try {
      recovered = await this.port.waitForInstall(requestId)
    } catch (error) {
      recovered = null
      if (!this.disposed) {
        const current = this.install
        if (current !== undefined && current.requestId === requestId) {
          current.message = `installation status check failed: ${errorMessage(error)}`
          this.hooks.requestRender()
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
    current.message = 'no active Host request carries this id; inventory reread below'
    this.run('plugin manager read', () => this.read())
    this.hooks.requestRender()
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
      this.hooks.requestRender()
      return true
    }
    if (this.state === 'loading') {
      this.message = 'the plugin inventory is refreshing; wait for it to settle'
      this.hooks.requestRender()
      return true
    }
    if (this.state === 'error') {
      this.message = 'the plugin inventory is stale after a failed refresh; refresh before changing plugins'
      this.hooks.requestRender()
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
      this.hooks.requestRender()
    }
  }

  /**
   * Toggle one card through the official authority. Re-resolves the card by
   * stable value against the CURRENT inventory and re-checks the effective
   * capability before dispatch.
   */
  toggleCard(value: string): void {
    this.run('plugin manager toggle', () => this.performToggleCard(value))
  }

  private async performToggleCard(value: string): Promise<void> {
    if (this.refuseWhileMutating()) return
    const card = this.card(value)
    if (card === undefined) {
      this.message = 'the plugin inventory changed; refresh and try again'
      this.hooks.requestRender()
      return
    }
    if (card.availability === 'missing') {
      this.message = card.canInstall
        ? `${card.name} is not installed; use Install… from its detail`
        : card.installBlockedReason ?? `${card.name} is not installed`
      this.hooks.requestRender()
      return
    }
    if (!card.canToggle) {
      this.message = card.toggleBlockedReason ?? `cannot change ${card.name}`
      this.hooks.requestRender()
      return
    }
    const token = ++this.mutationToken
    this.busyValue = card.value
    this.message = undefined
    this.hooks.requestRender()
    try {
      const change = card.target === 'bundle'
        ? await this.port.setBundleEnabled(card.name, !card.enabled)
        : await this.port.setPluginEnabled(card.rows[0]!.entryId, !card.enabled)
      if (this.disposed || token !== this.mutationToken) return
      this.message = changeSummary(change)
    } catch (error) {
      if (this.disposed || token !== this.mutationToken) return
      this.message = `enable/disable failed: ${errorMessage(error)}`
    }
    await this.finishMutation(token)
  }

  /** Toggle one addressable row of the card identified by stable value. */
  toggleRow(cardValue: string, entryId: string): void {
    this.run('plugin manager row toggle', () => this.performToggleRow(cardValue, entryId))
  }

  private async performToggleRow(cardValue: string, entryId: string): Promise<void> {
    if (this.refuseWhileMutating()) return
    const card = this.card(cardValue)
    const row = card?.rows.find(candidate => candidate.entryId === entryId)
    if (card === undefined || row === undefined) {
      this.message = 'the plugin inventory changed; refresh and try again'
      this.hooks.requestRender()
      return
    }
    if (!row.canToggle) {
      this.message = row.selfProtected
        ? `${entryId} is controlled by the Current TUI composition and cannot be changed from here`
        : `cannot change ${entryId}: ${row.readOnlyReason ?? 'not addressable'}`
      this.hooks.requestRender()
      return
    }
    const token = ++this.mutationToken
    this.busyValue = rowToggleValueBusy(entryId)
    this.message = undefined
    this.hooks.requestRender()
    try {
      const change = await this.port.setPluginEnabled(entryId, !row.enabled)
      if (this.disposed || token !== this.mutationToken) return
      this.message = changeSummary(change)
    } catch (error) {
      if (this.disposed || token !== this.mutationToken) return
      this.message = `enable/disable failed: ${errorMessage(error)}`
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
      this.hooks.requestRender()
      return false
    }
    this.confirming = { value: card.value, name: card.name, epoch: this.readEpoch }
    this.message = undefined
    this.hooks.requestRender()
    return true
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

  /** Abandon the confirmation without touching the Host. */
  cancelRemove(): void {
    if (this.confirming === undefined) return
    this.confirming = undefined
    this.hooks.requestRender()
  }

  /** Dispatch the confirmed removal against the CURRENT authoritative card. */
  confirmRemove(): void {
    this.run('plugin manager remove', () => this.performConfirmRemove())
  }

  private async performConfirmRemove(): Promise<void> {
    if (this.refuseWhileMutating()) return
    const confirmation = this.confirming
    if (confirmation === undefined) return
    const card = this.confirmingCard()
    if (card === undefined || card.isSelf || !card.canRemove) {
      this.confirming = undefined
      this.message = card?.isSelf === true
        ? selfRefusal(confirmation.name, card.role)
        : 'the bundle changed since the confirmation opened; nothing was removed'
      this.hooks.requestRender()
      return
    }
    const token = ++this.mutationToken
    this.busyValue = confirmation.value
    this.confirming = undefined
    this.message = undefined
    this.hooks.requestRender()
    try {
      const change = await this.port.removeBundle(confirmation.name)
      if (this.disposed || token !== this.mutationToken) return
      this.message = changeSummary(change)
    } catch (error) {
      if (this.disposed || token !== this.mutationToken) return
      this.message = `remove failed: ${errorMessage(error)}`
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
    // Latest-started read wins: starting a newer read invalidates EVERY older
    // in-flight read, so an older read can neither repaint stale inventory
    // after it started nor clear a newer failure.
    const epoch = ++this.readEpoch
    this.state = 'loading'
    this.hooks.requestRender()
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
      this.hooks.requestRender()
    } catch (error) {
      if (this.disposed || epoch !== this.readEpoch) return
      // A failed refresh keeps the last good snapshot.
      this.state = 'error'
      this.error = errorMessage(error)
      this.refreshErrorMessage = `refresh failed: ${this.error}`
      this.message = this.refreshErrorMessage
      this.hooks.requestRender()
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
    this.hooks.requestRender()
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
      this.hooks.requestRender()
      return
    }
    if (event.log.requestId !== active.requestId) return
    this.appendLog(active, event.log.stream, event.log.text)
    this.hooks.requestRender()
  }

  private appendLog(active: ActiveInstall, stream: 'stdout' | 'stderr', text: string): void {
    if (text === '') return
    for (const line of text.split('\n')) {
      if (line === '') continue
      active.log.push(stream === 'stderr' ? `! ${line}` : line)
    }
    if (active.log.length > LOG_MAX_LINES) active.log.splice(0, active.log.length - LOG_MAX_LINES)
    let total = active.log.reduce((sum, line) => sum + line.length + 1, 0)
    while (total > LOG_MAX_CHARS && active.log.length > 1) {
      total -= (active.log.shift()!.length + 1)
    }
  }
}

/** The busy key for one row-level toggle (never the card row's identity). */
function rowToggleValueBusy(entryId: string): string {
  return `action:toggle-row:${entryId}`
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
