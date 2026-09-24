/**
 * Plugin Manager controller (P1-A/A2/A3, v2): the owner of TUI operation and
 * ephemeral presentation state — selection, open detail, per-action busy
 * identity, the install request identity/phase, a bounded log tail, the
 * remove confirmation and the entry host (`/plugins` vs the `/settings`
 * submenu). It owns NO installed-package database, no enabled truth, no
 * compatibility evaluation and no final success: every mutation is followed
 * by a fresh official inventory read, and only that refreshed truth is
 * rendered.
 *
 * TWO local policies live here, both NARROWING only:
 *  - Current-TUI surface safety: the bundle providing this surface and its
 *    rows can never be disabled/removed through it, enforced at dispatch as
 *    well as in the UI (never by forging Host `readOnlyReason`/`removable`).
 *  - Exact + unique extension-owner association for presentation
 *    classification (ambiguous identity falls back to DSH Plugin).
 *
 * The controller OUTLIVES the panel (plan §17): closing the surface never
 * cancels an active install, and reopening resumes the same operation.
 *
 * @module @xmoon76/dsh-pi-tui/plugin-manager/controller
 */

import type {
  PluginChangeFact,
  PluginInstallEvent,
  PluginManagerPort,
  PluginManagerSnapshot,
  PluginSpecInspectionFact,
} from '../runtime/plugin-manager-port.ts'
import { runDetached } from '../detached.ts'
import type { Diag } from '../diag.ts'
import { classifyPluginPackages, type PluginClassificationInput, type PluginPresentationRole } from './classify.ts'
import type { TuiExtensionObservation } from './extension-inventory.ts'
import {
  PLUGIN_ACTION,
  buildPluginManagerModel,
  bundleValue,
  cardDetailRows,
  changeSummary,
  entryValue,
  pluginManagerListRows,
  rowToggleEntryId,
  type PluginCardView,
  type PluginManagerModel,
  type PluginManagerRow,
} from './model.ts'

/** Which host opened the shared surface (navigation differs only). */
export type PluginManagerEntryHost = 'direct-command' | 'settings-submenu'

/** The panel-local view the controller drives. */
export type PluginManagerMode = 'list' | 'detail' | 'confirm-remove' | 'install'

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
  /** Ask the owning host to close the surface (`/plugins` root or submenu). */
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
}

const EMPTY_MODEL: PluginManagerModel = Object.freeze({
  currentTui: Object.freeze([]),
  tuiExtensions: Object.freeze([]),
  dshPlugins: Object.freeze([]),
  registries: Object.freeze({ registry: null, fallbackRegistries: Object.freeze([]), resolved: null }),
  exemptions: Object.freeze([]),
  exemptionWarnings: Object.freeze([]),
})

/** The Plugin Manager operation/presentation owner. */
export class PluginManagerController {
  private readonly port: PluginManagerPort
  private readonly hooks: PluginManagerControllerHooks
  private readonly observationSource: (() => readonly TuiExtensionObservation[]) | undefined
  private snapshot: PluginManagerSnapshot | undefined
  private model: PluginManagerModel = EMPTY_MODEL
  private state: 'loading' | 'ready' | 'error' = 'loading'
  private error: string | undefined
  /** The exact notice text of the last failed inventory read, so a later
   * successful read can clear it without clobbering an operation message. */
  private refreshErrorMessage: string | undefined
  private entryHost: PluginManagerEntryHost = 'direct-command'
  private mode: PluginManagerMode = 'list'
  private selected = 0
  private detailValue: string | undefined
  private confirming: { readonly value: string; readonly name: string; readonly epoch: number } | undefined
  private busy: string | undefined
  private message: string | undefined
  private readEpoch = 0
  private committedEpoch = 0
  private mutationToken = 0
  private install: ActiveInstall | undefined
  private installEpoch = 0
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(port: PluginManagerPort, hooks: PluginManagerControllerHooks, options?: PluginManagerControllerOptions) {
    this.port = port
    this.hooks = hooks
    this.observationSource = options?.observations
    this.unsubscribe = port.subscribeInstall(event => this.onInstallEvent(event))
  }

  /** One owned detached task (AGENTS.md: never a bare `void` promise chain). */
  private run(label: string, task: () => Promise<unknown>): void {
    runDetached(label, task, { diag: this.hooks.diag })
  }

  /** Open the shared surface from one host: read once and show the right view. */
  open(host: PluginManagerEntryHost): void {
    if (this.disposed) return
    this.entryHost = host
    // Only a DISPATCHED install reopens as the same operation (plan §10.5).
    // An un-dispatched dialog (editing/inspecting/confirm) is not an active
    // Host operation, so reopening the surface starts at the list.
    const phase = this.install?.phase
    const dispatched = phase === 'starting' || phase === 'installing' || phase === 'applying' || phase === 'cancelling'
    this.mode = dispatched ? 'install' : 'list'
    this.selected = 0
    this.detailValue = undefined
    this.confirming = undefined
    this.message = undefined
    this.run('plugin manager read', () => this.read())
  }

  /** Explicit Refresh: read the official inventory again. `read()` owns the
   * notice clearing (it removes only a previous read-failure notice, so a
   * just-shown operation outcome survives a refresh). */
  refresh(): void {
    if (this.disposed) return
    this.run('plugin manager read', () => this.read())
  }

  /** Release the install-event subscription (runner teardown). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
  }

  /** Current rendered rows for the panel. */
  rows(): readonly PluginManagerRow[] {
    if (this.mode === 'detail') {
      const card = this.selectedCard()
      if (card !== undefined) return cardDetailRows(card, this.model.exemptions)
      return pluginManagerListRows(this.model, this.busy)
    }
    if (this.mode === 'confirm-remove') {
      const name = this.confirming?.name ?? ''
      const card = this.confirmingCard()
      const stale = card === undefined
      return [
        {
          value: 'info:confirm',
          kind: 'info',
          label: `Remove ${name}?`,
          secondary: 'unloads the bundle, then removes the dependency',
          tone: 'warning',
          selectable: false,
        },
        { value: PLUGIN_ACTION.confirmRemove, kind: 'action', label: 'Remove', tone: 'warning', selectable: true },
        { value: PLUGIN_ACTION.cancelRemove, kind: 'action', label: 'Cancel', tone: 'normal', selectable: true },
        ...(stale ? [{
          value: 'info:stale',
          kind: 'info' as const,
          label: 'This bundle changed since the confirmation opened; re-open it from the list.',
          tone: 'error' as const,
          selectable: false,
        }] : []),
      ]
    }
    return pluginManagerListRows(this.model, this.busy)
  }

  /** The stable identity of the currently selected selectable row. */
  selectedValue(): string | undefined {
    const selectable = this.rows().filter(row => row.selectable)
    if (selectable.length === 0) return undefined
    return selectable[Math.min(this.selected, selectable.length - 1)]?.value
  }

  /** The one-line footer hint for the current mode. */
  hint(): string {
    if (this.mode === 'install') return this.installHint()
    if (this.mode === 'confirm-remove') return 'Enter confirm · Esc cancel'
    if (this.mode === 'detail') return 'Enter action · Esc back · R refresh'
    return this.entryHost === 'settings-submenu'
      ? 'Enter open/act · R refresh · I install · Esc back'
      : 'Enter open/act · R refresh · I install · Esc close'
  }

  /** The panel title. */
  title(): string {
    if (this.mode === 'install') return 'Plugin Manager · install'
    if (this.mode === 'detail') {
      const card = this.selectedCard()
      if (card !== undefined) return `Plugin Manager · ${card.name}`
    }
    return 'Plugin Manager'
  }

  /** The transient notice line (an outcome or a stale-confirmation warning). */
  notice(): string | undefined {
    return this.message
  }

  /** The load/error state for the panel's empty frame. */
  status(): { readonly state: 'loading' | 'ready' | 'error'; readonly error?: string } {
    return { state: this.state, ...(this.error === undefined ? {} : { error: this.error }) }
  }

  /** The install dialog view, when the panel is in install mode. */
  installView(): PluginInstallView | undefined {
    if (this.mode !== 'install' || this.install === undefined) return undefined
    const active = this.install
    return {
      phase: active.phase,
      spec: active.spec,
      registry: active.registry,
      ...(active.inspection === undefined ? {} : { inspection: active.inspection }),
      log: active.log,
      ...(active.outcome === undefined ? {} : { outcome: active.outcome }),
      ...(active.message === undefined ? {} : { message: active.message }),
      cancellable: active.phase === 'installing' || active.phase === 'starting' || active.phase === 'cancelling',
      ...(active.phase === 'editing' || active.phase === 'inspecting' || active.phase === 'confirm'
        ? {}
        : { requestId: active.requestId }),
    }
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

  /** Move the selection among the current mode's selectable rows. */
  move(delta: number): void {
    const count = this.rows().filter(row => row.selectable).length
    if (count === 0) return
    const next = Math.min(count - 1, Math.max(0, this.selected + delta))
    if (next === this.selected) return
    this.selected = next
    this.hooks.requestRender()
  }

  /** Activate the selected row. */
  activate(): void {
    const selectable = this.rows().filter(row => row.selectable)
    const row = selectable[Math.min(this.selected, Math.max(0, selectable.length - 1))]
    if (row === undefined) return
    if (row.kind === 'card') {
      this.detailValue = row.value
      this.mode = 'detail'
      this.selected = 0
      this.message = undefined
      this.hooks.requestRender()
      return
    }
    const toggleEntryId = rowToggleEntryId(row.value)
    if (toggleEntryId !== undefined) {
      this.run('plugin manager row toggle', () => this.runToggleRow(toggleEntryId))
      return
    }
    switch (row.value) {
      case PLUGIN_ACTION.back:
        this.mode = 'list'
        this.detailValue = undefined
        this.selected = 0
        this.hooks.requestRender()
        return
      case PLUGIN_ACTION.refresh:
        this.run('plugin manager read', () => this.read())
        return
      case PLUGIN_ACTION.close:
        this.hooks.requestClose()
        return
      case PLUGIN_ACTION.install:
        this.openInstall()
        return
      case PLUGIN_ACTION.toggle:
        this.run('plugin manager toggle', () => this.toggleSelectedCard())
        return
      case PLUGIN_ACTION.remove:
        this.requestRemoveSelected()
        return
      case PLUGIN_ACTION.confirmRemove:
        this.run('plugin manager remove', () => this.runRemove())
        return
      case PLUGIN_ACTION.cancelRemove:
        this.mode = 'detail'
        this.confirming = undefined
        this.selected = 0
        this.hooks.requestRender()
        return
      default:
        return
    }
  }

  /** Esc semantics: leave the innermost view; close only from the list. */
  back(): void {
    if (this.mode === 'install') {
      const phase = this.install?.phase
      if (phase === 'confirm' || phase === 'inspecting') {
        this.editInstall()
        return
      }
      this.closeInstall()
      return
    }
    if (this.mode === 'confirm-remove') {
      this.mode = 'detail'
      this.confirming = undefined
      this.selected = 0
      this.hooks.requestRender()
      return
    }
    if (this.mode === 'detail') {
      this.mode = 'list'
      this.detailValue = undefined
      this.selected = 0
      this.hooks.requestRender()
      return
    }
    this.hooks.requestClose()
  }

  // ── install lifecycle ────────────────────────────────────────────────────

  /** Open the install dialog; an active operation is reopened, never restarted. */
  openInstall(): void {
    const active = this.install
    if (active !== undefined && active.phase !== 'done' && active.phase !== 'failed' && active.phase !== 'unknown') {
      this.mode = 'install'
      this.selected = 0
      this.hooks.requestRender()
      return
    }
    this.installEpoch += 1
    this.install = {
      requestId: nextInstallRequestId(),
      spec: '',
      registry: null,
      phase: 'editing',
      log: [],
    }
    this.mode = 'install'
    this.selected = 0
    this.message = undefined
    this.hooks.requestRender()
  }

  /** Inspect one spec against the Host before offering installation. */
  inspect(spec: string, registry: string | null): void {
    const active = this.install
    if (active === undefined || this.mode !== 'install') return
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
    if (active === undefined || this.mode !== 'install') return
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
      // ONLY the dispatch is the failure domain: a throw from SETTLEMENT is a
      // programming error, never an indeterminate Host outcome.
      outcome = await this.port.startInstall({
        requestId,
        spec: active.spec,
        registry: active.registry,
        enabled: true,
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
        // Host cleanup has completed: the operation is terminal.
        current.phase = 'done'
        current.message = 'cancelled — profile files restored'
      } else if (cancellation.status === 'too-late') {
        // The Host already started applying: the operation is still running.
        current.phase = 'applying'
        current.message = 'too late to cancel: the bundle is being applied'
      } else {
        // No active request with this id: the dispatch already settled (or is
        // about to). Never claim success; reconcile with an explicit check.
        current.phase = 'unknown'
        current.message = 'the installation already settled; the outcome will reconcile'
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

  /** Leave the install dialog without touching the Host operation. */
  closeInstall(): void {
    if (this.install?.phase === 'inspecting') {
      this.install.inspectAbort?.abort()
      this.install.inspectAbort = undefined
      this.installEpoch += 1
      this.install.phase = 'editing'
    }
    this.mode = 'list'
    this.selected = 0
    this.hooks.requestRender()
  }

  // ── mutations ────────────────────────────────────────────────────────────

  /**
   * Toggle the selected card through the official authority. Public because
   * it is the operation the panel's action row dispatches; it re-checks the
   * EFFECTIVE capability, so a Current-TUI card can never be mutated here
   * even if a future UI accidentally exposes the action.
   */
  async toggleSelectedCard(): Promise<void> {
    const card = this.activeCard()
    if (card === undefined) return
    // Effective capability only: the host fact AND the local surface-safety
    // policy. A Current-TUI card can never dispatch a mutation here even if a
    // future UI accidentally exposes the action.
    if (!card.canToggle) {
      this.message = card.isSelf
        ? selfRefusal(card.name, card.role)
        : `cannot change ${card.name}: ${card.readOnlyReason ?? 'read-only'}`
      this.hooks.requestRender()
      return
    }
    const token = ++this.mutationToken
    this.busy = card.value
    this.message = undefined
    this.hooks.requestRender()
    try {
      const change = card.source === 'bundle'
        ? await this.port.setBundleEnabled(card.name, !card.enabled)
        : await this.port.setPluginEnabled(card.rows[0]!.entryId, !card.enabled)
      if (this.disposed || token !== this.mutationToken) return
      this.message = changeSummary(change)
    } catch (error) {
      if (this.disposed || token !== this.mutationToken) return
      this.message = `enable/disable failed: ${errorMessage(error)}`
    } finally {
      if (!this.disposed && token === this.mutationToken) this.busy = undefined
    }
    await this.read()
  }

  private async runToggleRow(entryId: string): Promise<void> {
    const card = this.activeCard()
    const row = card?.rows.find(candidate => candidate.entryId === entryId)
    if (row === undefined) return
    if (!row.canToggle) {
      this.message = `cannot change ${entryId}: ${row.readOnlyReason ?? 'not addressable'}`
      this.hooks.requestRender()
      return
    }
    const token = ++this.mutationToken
    this.busy = rowToggleValueBusy(entryId)
    this.message = undefined
    this.hooks.requestRender()
    try {
      const change = await this.port.setPluginEnabled(entryId, !row.enabled)
      if (this.disposed || token !== this.mutationToken) return
      this.message = changeSummary(change)
    } catch (error) {
      if (this.disposed || token !== this.mutationToken) return
      this.message = `enable/disable failed: ${errorMessage(error)}`
    } finally {
      if (!this.disposed && token === this.mutationToken) this.busy = undefined
    }
    await this.read()
  }

  /**
   * Open the destructive confirmation for the selected bundle. Public for the
   * same reason as {@link toggleSelectedCard}: it re-checks the effective
   * capability before a confirmation is ever shown.
   */
  requestRemoveSelected(): void {
    const card = this.activeCard()
    if (card === undefined || card.source !== 'bundle') return
    // Destructive + destructive-forbidden cases never open a confirmation.
    if (!card.canRemove) {
      this.message = card.isSelf
        ? selfRefusal(card.name, card.role)
        : `cannot remove ${card.name}: ${card.readOnlyReason ?? 'not removable'}`
      this.hooks.requestRender()
      return
    }
    this.confirming = { value: card.value, name: card.name, epoch: this.readEpoch }
    this.mode = 'confirm-remove'
    this.selected = 0
    this.message = undefined
    this.hooks.requestRender()
  }

  private async runRemove(): Promise<void> {
    const confirmation = this.confirming
    if (confirmation === undefined) return
    // Exact logical identity, re-validated against the CURRENT inventory: a
    // refresh that replaced/removed the row makes the confirmation stale, and
    // the self-protection guard is re-checked before the port is touched.
    const card = this.confirmingCard()
    if (card === undefined || card.isSelf || !card.canRemove) {
      this.mode = 'detail'
      this.confirming = undefined
      this.selected = 0
      this.message = card?.isSelf === true
        ? selfRefusal(confirmation.name, card?.role ?? 'dsh-plugin')
        : 'the bundle changed since the confirmation opened; nothing was removed'
      this.hooks.requestRender()
      return
    }
    const token = ++this.mutationToken
    this.busy = confirmation.value
    this.mode = 'detail'
    this.confirming = undefined
    this.selected = 0
    this.hooks.requestRender()
    try {
      const change = await this.port.removeBundle(confirmation.name)
      if (this.disposed || token !== this.mutationToken) return
      this.message = changeSummary(change)
      if (change.error !== undefined) this.detailValue = undefined
    } catch (error) {
      if (this.disposed || token !== this.mutationToken) return
      this.message = `remove failed: ${errorMessage(error)}`
    } finally {
      if (!this.disposed && token === this.mutationToken) this.busy = undefined
    }
    await this.read()
  }

  // ── internal ─────────────────────────────────────────────────────────────

  private allCards(): readonly PluginCardView[] {
    return [...this.model.currentTui, ...this.model.tuiExtensions, ...this.model.dshPlugins]
  }

  /** The card of the open detail view (detail mode only). */
  private selectedCard(): PluginCardView | undefined {
    if (this.detailValue === undefined) return undefined
    return this.allCards().find(card => card.value === this.detailValue)
  }

  /**
   * The card a mutation targets: the open detail card, else the selected list
   * row's card. Resolving from the SELECTED ROW (never an index) keeps the
   * dispatch guard reachable even when the action row is not rendered.
   */
  private activeCard(): PluginCardView | undefined {
    if (this.mode === 'detail') return this.selectedCard()
    const selectable = this.rows().filter(row => row.selectable)
    if (selectable.length === 0) return undefined
    const value = selectable[Math.min(this.selected, selectable.length - 1)]?.value
    if (value === undefined) return undefined
    return this.allCards().find(card => card.value === value)
  }

  private confirmingCard(): PluginCardView | undefined {
    const confirmation = this.confirming
    if (confirmation === undefined) return undefined
    if (confirmation.epoch !== this.readEpoch) return undefined
    return this.allCards().find(card => card.value === confirmation.value)
  }

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
    const epoch = ++this.readEpoch
    this.state = 'loading'
    this.hooks.requestRender()
    try {
      const snapshot = await this.port.snapshot()
      if (this.disposed || epoch < this.committedEpoch) return
      this.committedEpoch = epoch
      this.snapshot = snapshot
      this.model = this.buildModel(snapshot)
      this.state = 'ready'
      this.error = undefined
      // Clear only the read-failure notice (never an operation outcome the
      // caller just set), so a successful read — refresh key OR action row —
      // never leaves a stale "refresh failed: …" on screen.
      if (this.message === this.refreshErrorMessage) this.message = undefined
      this.refreshErrorMessage = undefined
      this.clampSelection()
      this.hooks.requestRender()
    } catch (error) {
      if (this.disposed || epoch < this.committedEpoch) return
      this.committedEpoch = epoch
      // A failed refresh keeps the last good snapshot (plan §A1.6).
      this.state = 'error'
      this.error = errorMessage(error)
      this.refreshErrorMessage = `refresh failed: ${this.error}`
      this.message = this.refreshErrorMessage
      this.hooks.requestRender()
    }
  }

  private clampSelection(): void {
    const count = this.rows().filter(row => row.selectable).length
    this.selected = count === 0 ? 0 : Math.min(this.selected, count - 1)
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

  private installHint(): string {
    const active = this.install
    if (active === undefined) return 'Enter inspect · Esc close'
    if (active.phase === 'editing') return 'Enter inspect · Esc close'
    if (active.phase === 'inspecting') return 'inspecting…'
    if (active.phase === 'confirm') {
      return active.inspection?.status === 'accepted' ? 'Enter install · Esc edit' : 'Esc edit'
    }
    if (active.phase === 'done' || active.phase === 'failed' || active.phase === 'unknown') return 'Esc close dialog'
    const cancellable = active.phase === 'installing' || active.phase === 'starting' || active.phase === 'cancelling'
    return cancellable ? 'Esc hide · C cancel' : 'Esc hide'
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
