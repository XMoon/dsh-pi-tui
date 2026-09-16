/**
 * The official subagent model-selection allowlist picker (`/settings` →
 * "Subagent allowed models"). One provider-grouped, searchable flat list of
 * every discovered provider/model route rendered INSIDE the SettingsList's
 * submenu slot (the fork's `SettingItem.submenu` mechanism) — no second
 * overlay is ever mounted. Enter toggles one `(provider, model)` route in the
 * OFFICIAL `subagent-model-selection` allowlist; the whole section is written
 * through the config port on every toggle (the Host owns the setting; the TUI
 * never keeps a parallel copy beyond the open panel's working snapshot).
 *
 * The provider catalog is the provider-DISCOVERY capability
 * (`listProviders()` + `listModels(providerId)`), NOT the `/model` directory
 * read: the two are distinct semantic capabilities and the allowlist must not
 * depend on (or reverse-fill from) the Session model directory. Provider
 * loads settle PARTIALLY — one provider's failure never blocks editing the
 * others; a failed provider becomes an inert `Unavailable` row.
 *
 * The official rule "enabled requires at least one allowed model" is
 * enforced client-side too: removing the LAST route while the section is
 * enabled is refused with a notice (the Host would reject the write anyway —
 * failing fast keeps the markers truthful).
 *
 * Async cancellation follows the picker contract: the component owns a
 * `disposed` latch and routes every provider load through the injected
 * `runOwned`; a model list that settles after the user left is dropped.
 * @module @xmoon76/dsh-pi-tui/subagent-model-menu
 */

import {
  type Component,
  type Focusable,
  type RowBudgetAware,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import type { OwnedTaskOptions } from './detached.ts'
import type { SubagentAllowedModelRoute, SubagentModelSelectionConfig } from './runtime/config-port.ts'
import { SearchablePicker, type SearchablePickerItem } from './searchable-picker.ts'
import { selectListTheme } from './theme.ts'

/** One provider row of the provider-discovery catalog. */
export interface AllowlistProvider {
  readonly id: string
  readonly name?: string
}

/** One discovered model row of a provider. */
export interface AllowlistModel {
  readonly id: string
  readonly name?: string
}

/** The provider-discovery surface the allowlist picker needs (the runtime's
 *  model catalog port, read off the live backend). */
export interface AllowlistCatalogServices {
  listProviders(): readonly AllowlistProvider[]
  listModels(providerId: string): Promise<readonly AllowlistModel[]>
}

export interface SubagentAllowlistPickerDeps {
  /** The official settings sub-domain (read + whole-section writes). */
  selection: SubagentModelSelectionConfig
  /** The provider/model discovery catalog for the picker rows. */
  catalog: AllowlistCatalogServices
  /** Surface notice for refused toggles (never a bare console write). */
  notify(message: string, kind: 'info' | 'error'): void
  /** Request a frame so a progressive load or optimistic marker renders. */
  requestRender(): void
  /** Close this submenu (Esc; `selected` rewrites the outer row). */
  done(selected?: string): void
  /**
   * Converge the OUTER settings row after the submenu has ALREADY closed.
   * The fork rejects a `done` callback from a closed submenu (its submenu
   * generation guard), so a write that settles after close must update the
   * row's displayed summary through this narrow seam instead — it never
   * re-opens the submenu or moves the cursor.
   */
  summarize(value: string): void
  /** The owned-task entry (runOwned shape): async loads route through it
   *  instead of a bare `void promise` (AGENTS.md hard rule). */
  runOwned<T>(
    label: string,
    task: () => T | Promise<T>,
    options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>,
  ): void
}

/** Format the outer settings row's value for one allowlist state. */
export function allowlistSummary(routes: readonly SubagentAllowedModelRoute[]): string {
  return routes.length === 1 ? '1 route' : `${routes.length} routes`
}

/** Whether toggling `route` would violate the official "enabled requires
 *  at least one route" rule (removing the last route while enabled). */
export function lastRouteWhileEnabled(
  enabled: boolean,
  routes: readonly SubagentAllowedModelRoute[],
  route: SubagentAllowedModelRoute,
): boolean {
  return enabled
    && routes.length === 1
    && routes[0]!.provider === route.provider
    && routes[0]!.model === route.model
}

/** One flattened, identity-complete model presentation row. */
export interface SubagentAllowlistModelRow {
  readonly providerId: string
  readonly providerName: string
  readonly modelId: string
  readonly modelName?: string
  readonly allowed: boolean
}

/** One provider whose discovery failed; inert in the list. */
export interface SubagentAllowlistFailureRow {
  readonly providerId: string
  readonly providerName: string
  readonly message: string
}

export interface SubagentAllowlistProjection {
  readonly models: readonly SubagentAllowlistModelRow[]
  readonly failures: readonly SubagentAllowlistFailureRow[]
}

/** Full logical identity of an allowlist route. Model ids are not globally
 *  unique, so `(provider, model)` is the only safe key. */
export function allowlistRouteKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`
}

const FAILURE_PREFIX = '\u0000unavailable\u0000'
/** One shared group key for EVERY failed provider, so all failures collapse
 *  into a single private `Unavailable` section (a real provider's own
 *  `groupKey` is its id and can never collide with this NUL-prefixed key). */
const FAILURE_GROUP_KEY = '\u0000unavailable'

/**
 * Project the discovered catalog into identity-complete presentation rows in
 * CATALOG ORDER (provider order × model order), independent of the order in
 * which providers finish loading. A provider that has neither models nor a
 * failure yet contributes nothing (still loading). Pure — unit testable.
 */
export function projectSubagentAllowlist(input: {
  providers: readonly AllowlistProvider[]
  models: ReadonlyMap<string, readonly AllowlistModel[]>
  failures: ReadonlyMap<string, string>
  allowed: readonly SubagentAllowedModelRoute[]
}): SubagentAllowlistProjection {
  const models: SubagentAllowlistModelRow[] = []
  const failures: SubagentAllowlistFailureRow[] = []
  for (const provider of input.providers) {
    const displayName = provider.name === undefined || provider.name === '' ? provider.id : provider.name
    const failure = input.failures.get(provider.id)
    if (failure !== undefined) {
      failures.push({ providerId: provider.id, providerName: displayName, message: failure })
      continue
    }
    const loaded = input.models.get(provider.id)
    if (loaded === undefined) continue
    for (const model of loaded) {
      models.push({
        providerId: provider.id,
        providerName: displayName,
        modelId: model.id,
        ...(model.name === undefined || model.name === '' ? {} : { modelName: model.name }),
        // Full (provider, model) identity: a same-id model under another
        // provider must never inherit the allowed marker.
        allowed: input.allowed.some(route => route.provider === provider.id && route.model === model.id),
      })
    }
  }
  return { models, failures }
}

/**
 * The provider-grouped, searchable, multi-toggle allowlist picker. Mounted by
 * the `/settings` overlay as an in-place submenu component (never a second
 * overlay); Esc returns to `/settings` in one step.
 */
export class SubagentModelAllowlistPicker implements Component, Focusable, RowBudgetAware {
  private readonly deps: SubagentAllowlistPickerDeps
  private readonly enabled: boolean
  private allowed: readonly SubagentAllowedModelRoute[]
  private readonly providers: readonly AllowlistProvider[]
  private readonly modelsByProvider = new Map<string, readonly AllowlistModel[]>()
  private readonly failures = new Map<string, string>()
  private readonly picker: SearchablePicker
  /** value → route for the SELECTABLE model rows (failure/loading rows are absent). */
  private readonly modelRoutes = new Map<string, SubagentAllowedModelRoute>()
  /** Provider loads still in flight; the cursor is placed once they all settle. */
  private pendingLoads: number
  private cursorPlaced = false
  /** Any real user interaction with the list (arrow/wheel move, toggle, or a
   *  filter-query edit) cancels the one-shot initial-cursor placement, so a
   *  late provider load can never move the user's cursor. */
  private userInteracted = false
  private rowGrant = Number.POSITIVE_INFINITY
  private _focused = false
  /** Latched by every close/dispose path; late settles must not act after. */
  private disposed = false
  /** Serialized whole-section writes: every toggle commits in order, so a
   *  slow earlier write can never land after a newer one. */
  private mutationChain: Promise<void> = Promise.resolve()

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.picker.focused = value
  }

  /** Host row-budget seam: the outer SettingsList forwards its grant here. */
  setMaxRows(rows: number): void {
    this.rowGrant = rows
    this.picker.setMaxRows(rows)
  }

  constructor(deps: SubagentAllowlistPickerDeps) {
    this.deps = deps
    const current = deps.selection.get()
    this.allowed = current.allowedModels.map(route => ({ ...route }))
    this.enabled = current.enabled
    this.providers = deps.catalog.listProviders()
    this.picker = new SearchablePicker([], 8, selectListTheme, {}, {
      enableSearch: true,
      showHint: true,
      header: 'Subagent allowed models',
      hint: '↑↓ move · enter toggle · esc back',
      noMatchText: this.providers.length === 0 ? '  no providers configured' : '  Loading models…',
      descriptionMode: 'selected-below',
    })
    this.picker.onSelect = (item) => { this.toggleValue(item.value) }
    this.picker.onCancel = () => { this.close() }
    this.picker.onSelectionChange = () => { this.userInteracted = true }
    this.pendingLoads = this.providers.length
    for (const provider of this.providers) {
      const displayName = provider.name === undefined || provider.name === '' ? provider.id : provider.name
      // A rejection landing after the panel closed is a cancellation
      // (disposed classifier → debug), not a stale failure.
      deps.runOwned(`subagent allowlist models ${provider.id}`, () => deps.catalog.listModels(provider.id), {
        isCancellation: () => this.disposed,
        onResult: (models) => {
          if (this.disposed) return
          this.modelsByProvider.set(provider.id, models)
          this.afterLoad()
        },
        onError: (error) => {
          if (this.disposed) return
          this.failures.set(provider.id, error instanceof Error ? error.message : String(error))
          this.afterLoad()
        },
      })
    }
    this.rebuild()
    this.setMaxRows(this.rowGrant)
  }

  private afterLoad(): void {
    this.pendingLoads = Math.max(0, this.pendingLoads - 1)
    this.rebuild()
    this.deps.requestRender()
  }

  /** Re-derive the picker rows from the working copy + progressive load
   *  state. `setItems` preserves the selected row by VALUE, so an optimistic
   *  toggle or a late provider load never snaps the cursor away. */
  private rebuild(): void {
    const projection = projectSubagentAllowlist({
      providers: this.providers,
      models: this.modelsByProvider,
      failures: this.failures,
      allowed: this.allowed,
    })
    this.modelRoutes.clear()
    const items: SearchablePickerItem[] = projection.models.map((row) => {
      const value = allowlistRouteKey(row.providerId, row.modelId)
      this.modelRoutes.set(value, { provider: row.providerId, model: row.modelId })
      const label = row.modelName ?? row.modelId
      return {
        value,
        label,
        ...(row.modelName === undefined || row.modelName === row.modelId ? {} : { description: row.modelId }),
        group: row.providerName,
        groupKey: row.providerId,
        ...(row.allowed ? { badge: 'allowed' } : {}),
        searchText: `${row.providerId} ${row.modelId} ${row.providerName} ${row.modelName ?? ''}`,
      }
    })
    for (const failure of projection.failures) {
      items.push({
        value: `${FAILURE_PREFIX}${failure.providerId}`,
        label: failure.providerName,
        description: failure.message,
        group: 'Unavailable',
        // ALL failures share one private group key → a single `Unavailable`
        // section (a real provider named "Unavailable" keeps its own id key).
        groupKey: FAILURE_GROUP_KEY,
        badge: 'unavailable',
        searchText: `${failure.providerId} ${failure.providerName}`,
      })
    }
    this.picker.setItems(items)
    this.picker.setMaxRows(this.rowGrant)
    // The empty state depends on the LOAD state, not just on the filter: a
    // still-loading progressive fill, a settled-but-empty catalog, and a
    // zero-match search are three different messages.
    this.picker.setNoMatchText(this.providers.length === 0
      ? '  no providers configured'
      : this.pendingLoads > 0 && items.length === 0
        ? '  Loading models…'
        : items.length === 0 ? '  no models available' : '  No matching models')
    // Initial cursor (plan §12): once every load has settled and before ANY
    // real interaction, prefer the first allowed route in catalog order, else
    // the first model row. Never lands on a failure/loading row.
    if (!this.cursorPlaced && !this.userInteracted && this.pendingLoads === 0) {
      const preferred = projection.models.find(row => row.allowed) ?? projection.models[0]
      if (preferred !== undefined) this.picker.setSelectedValue(allowlistRouteKey(preferred.providerId, preferred.modelId))
      this.cursorPlaced = true
    }
  }

  /** A failure/loading row is not a selectable model route: Enter on it is a
   *  no-op (it can never toggle the allowlist). Any such press is still a
   *  user interaction that must cancel the initial-cursor placement. */
  private toggleValue(value: string): void {
    if (this.disposed) return
    this.userInteracted = true
    const route = this.modelRoutes.get(value)
    if (route === undefined) return
    this.toggle(route)
  }

  private toggle(route: SubagentAllowedModelRoute): void {
    if (this.disposed) return
    const present = this.allowed.some(existing =>
      existing.provider === route.provider && existing.model === route.model)
    if (present) {
      // Removing the LAST route while enabled would leave the official
      // section invalid; the Host would reject the write, so the toggle is
      // refused before it — the panel's markers stay truthful.
      if (lastRouteWhileEnabled(this.enabled, this.allowed, route)) {
        this.deps.notify('disable subagent model selection before removing the last route', 'error')
        return
      }
      this.allowed = this.allowed.filter(existing =>
        !(existing.provider === route.provider && existing.model === route.model))
    } else {
      this.allowed = [...this.allowed, route]
    }
    // Optimistic marker for THIS row (and every other marker stays put):
    // rebuild from the working copy; the payload is captured NOW (the
    // toggle's intent), and the write is SERIALIZED so a slow earlier write
    // can never land after a newer one. Every settle re-syncs the working
    // copy and ALL markers from the committed section.
    this.rebuild()
    this.deps.requestRender()
    const payload = this.allowed.map(existing => ({ ...existing }))
    this.mutationChain = this.mutationChain
      .then(() => this.deps.selection.set({ enabled: this.enabled, allowedModels: payload }))
      .then(
        () => { this.syncFromSection() },
        (error: unknown) => {
          this.syncFromSection()
          // A failure settling AFTER the picker closed is silent: the outer
          // row already converged to the committed summary, and a late toast
          // would only describe a panel the user left.
          if (!this.disposed) {
            this.deps.notify(`allowlist write failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
          }
        },
      )
  }

  /** Re-read the committed section and re-derive the working copy plus every
   *  visible marker. When the picker is already CLOSED, the outer /settings
   *  row must still converge to the COMMITTED summary — the fork rejects a
   *  `done` from a closed submenu, so the post-close convergence goes through
   *  `summarize` (a row-display update, never navigation), and the late
   *  failure keeps its no-toast contract. */
  private syncFromSection(): void {
    const committed = this.deps.selection.get().allowedModels
    this.allowed = committed.map(existing => ({ ...existing }))
    if (this.disposed) {
      this.deps.summarize(allowlistSummary(this.allowed))
      return
    }
    this.rebuild()
    this.deps.requestRender()
  }

  private close(): void {
    if (this.disposed) return
    this.disposed = true
    this.deps.done(allowlistSummary(this.allowed))
  }

  /** Latch the picker as closed from OUTSIDE (the /settings overlay teardown
   *  calls this — a write pending when the whole panel closes must not
   *  repaint or toast after the panel is gone). Idempotent; does NOT report
   *  a summary (the panel is closing, not the submenu). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
  }

  handleInput(data: string): void {
    // The SearchablePicker owns navigation/confirm/cancel; Esc (cancel)
    // returns to /settings in ONE step through onCancel. A filter-query edit
    // is a real interaction too (it re-selects the filtered list), so latch it
    // and never let a late provider load override the user's cursor.
    if (this.disposed) return
    const before = this.picker.getFilter()
    this.picker.handleInput(data)
    if (this.picker.getFilter() !== before) this.userInteracted = true
  }

  /** Transparent mouse forwarding: the picker owns row hit-testing and its
   *  own last-painted-geometry fence (a resize that has not repainted must
   *  never toggle a stale row). */
  handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    // ANY pointer interaction cancels the one-shot initial-cursor placement,
    // including a left PRESS on the already-selected row — that press changes
    // no selection and so never fires `onSelectionChange`, yet the user's
    // gesture must not be overridden by a late provider load.
    this.userInteracted = true
    return this.picker.handleMouse(event)
  }

  invalidate(): void {
    this.picker.invalidate()
  }

  render(width: number): string[] {
    return this.picker.render(width)
  }
}
