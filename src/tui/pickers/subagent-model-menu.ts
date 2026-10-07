/**
 * The official subagent model-selection allowlist picker (`/settings` →
 * "Subagent allowed models"). One provider-grouped, searchable flat list of
 * every selectable provider/model route rendered INSIDE the SettingsList's
 * submenu slot (the fork's `SettingItem.submenu` mechanism) — no second
 * overlay is ever mounted. Enter toggles one `(provider, model)` route in the
 * OFFICIAL `subagent-model-selection` allowlist; the whole section is written
 * through the config port on every toggle (the Host owns the setting; the TUI
 * never keeps a parallel copy beyond the open panel's working snapshot).
 *
 * The catalog source is the OFFICIAL grouped model directory
 * (`ModelCatalog.loadDirectory()`, the `session.modelCatalog()` semantic):
 * provider groups in catalog order, per-provider failure isolation, and —
 * when the wire catalog is Remote — the same directory dsh-web's subagent
 * model settings consume. The historical per-provider discovery shape
 * (`listProviders()` + `listModels(provider)`) was retired: `llm.listModels`
 * has no public Remote, and the directory is the one selectable authority.
 *
 * Saved routes stay REPRESENTABLE and REMOVABLE as trailing rows (the
 * allowlist itself is their only source — the provider directory is never
 * reverse-derived from settings or the allowlist). ABSENCE, however, is a
 * claim only a SUCCESSFULLY READ directory can make: while the directory is
 * still loading, after a whole-directory read failure, or for a provider
 * whose group failed (`directory.failures` — per-provider isolation), a
 * saved route renders as a saved route WITHOUT the "not in the current
 * catalog" claim (`AllowlistCatalogState` owns that distinction).
 *
 * The official rule "enabled requires at least one allowed model" is
 * enforced client-side too: removing the LAST route while the section is
 * enabled is refused with a notice (the Host would reject the write anyway —
 * failing fast keeps the markers truthful).
 *
 * Async cancellation follows the picker contract: the component owns a
 * `disposed` latch and routes the directory load through the injected
 * `runOwned`; a result that settles after the user left is dropped.
 * @module @xmoon76/dsh-pi-tui/tui/pickers/subagent-model-menu
 */

import {
  type Component,
  type Focusable,
  type RowBudgetAware,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import type { OwnedTaskOptions } from '../../detached.ts'
import type { ModelDirectoryDto } from '../../runtime/catalog-port.ts'
import type { SubagentAllowedModelRoute, SubagentModelSelectionConfig } from '../../runtime/config-port.ts'
import { SearchablePicker, type SearchablePickerItem } from './searchable-picker.ts'
import { selectListTheme } from '../theme/runtime.ts'

/** The catalog surface the allowlist picker needs: the OFFICIAL grouped
 *  model directory (the runtime's model catalog port, read off the live
 *  backend). */
export interface AllowlistCatalogServices {
  loadDirectory(signal?: AbortSignal): Promise<ModelDirectoryDto>
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
  /** Present only when the row exists because the allowlist carries the
   *  route (still removable). `absent` = a READY directory that loaded this
   *  provider provably does not list it; the other values say the catalog
   *  authority could NOT answer — absence is never claimed from a loading,
   *  failed, or provider-failed catalog. */
  readonly savedRoute?: 'absent' | 'catalog-loading' | 'catalog-unavailable' | 'provider-unavailable'
}

/** The catalog authority state behind the rows — the distinction that keeps
 *  "not in the current catalog" a provable claim instead of a guess. */
export type AllowlistCatalogState =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly directory: ModelDirectoryDto }
  | { readonly state: 'failed'; readonly reason: string }

/** One provider whose directory group failed to load; inert in the list. */
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
 * into a single private `Unavailable` section (a real provider's own
 * `groupKey` is its id and can never collide with this NUL-prefixed key). */
const FAILURE_GROUP_KEY = '\u0000unavailable'
/** One shared group key for saved routes absent from the current catalog
 * (same collision rule: a real provider id can never be NUL-prefixed). */
const SAVED_GROUP_KEY = '\u0000saved'

/**
 * Project the official model directory into identity-complete presentation
 * rows in CATALOG ORDER (provider group order × model order), plus one
 * removable trailing row per SAVED route the directory does not list. The
 * allowlist is a saved row's only source; WHICH saved-row note it carries is
 * decided by the catalog authority state: only a READY directory that loaded
 * the route's provider can claim `absent` — a loading catalog, a failed
 * whole-directory read, or a provider-side group failure renders the route
 * as saved WITHOUT the absence claim. Pure — unit testable.
 */
export function projectSubagentAllowlist(input: {
  catalog: AllowlistCatalogState
  allowed: readonly SubagentAllowedModelRoute[]
}): SubagentAllowlistProjection {
  const models: SubagentAllowlistModelRow[] = []
  const failures: SubagentAllowlistFailureRow[] = []
  const listed = new Set<string>()
  const failedProviders = new Set<string>()
  const catalog = input.catalog
  if (catalog.state === 'failed') {
    failures.push({ providerId: 'model-directory', providerName: 'Model directory', message: catalog.reason })
  }
  if (catalog.state === 'ready') {
    for (const failure of catalog.directory.failures) {
      failedProviders.add(failure.id)
      failures.push({ providerId: failure.id, providerName: failure.name, message: failure.message })
    }
    for (const group of catalog.directory.groups) {
      for (const model of group.models) {
        listed.add(allowlistRouteKey(group.id, model.id))
        models.push({
          providerId: group.id,
          providerName: group.name === '' ? group.id : group.name,
          modelId: model.id,
          ...model.name === undefined || model.name === '' ? {} : { modelName: model.name },
          // Full (provider, model) identity: a same-id model under another
          // provider must never inherit the allowed marker.
          allowed: input.allowed.some(route => route.provider === group.id && route.model === model.id),
        })
      }
    }
  }
  for (const route of input.allowed) {
    if (listed.has(allowlistRouteKey(route.provider, route.model))) continue
    models.push({
      providerId: route.provider,
      providerName: route.provider,
      modelId: route.model,
      allowed: true,
      savedRoute: catalog.state === 'loading'
        ? 'catalog-loading'
        : catalog.state === 'failed'
          ? 'catalog-unavailable'
          : failedProviders.has(route.provider)
            ? 'provider-unavailable'
            : 'absent',
    })
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
  /** The catalog authority state: `loading` until the one official read
   *  settles, then `ready(directory)` or `failed(reason)`. */
  private catalog: AllowlistCatalogState = { state: 'loading' }
  private readonly picker: SearchablePicker
  /** value → route for the SELECTABLE model rows (failure rows are absent). */
  private readonly modelRoutes = new Map<string, SubagentAllowedModelRoute>()
  /** Whether the directory load has settled; the cursor is placed once it does. */
  private loadSettled = false
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
    this.picker = new SearchablePicker([], 8, selectListTheme, {}, {
      enableSearch: true,
      showHint: true,
      header: 'Subagent allowed models',
      hint: '↑↓ move · enter toggle · esc back',
      noMatchText: '  Loading models…',
      descriptionMode: 'selected-below',
    })
    this.picker.onSelect = (item) => { this.toggleValue(item.value) }
    this.picker.onCancel = () => { this.close() }
    this.picker.onSelectionChange = () => { this.userInteracted = true }
    // ONE official directory read owns every row (provider groups, per-
    // provider failure isolation). A rejection landing after the panel
    // closed is a cancellation (disposed classifier → debug), not a stale
    // failure.
    deps.runOwned('subagent allowlist model directory', () => deps.catalog.loadDirectory(), {
      isCancellation: () => this.disposed,
      onResult: (directory) => {
        if (this.disposed) return
        this.catalog = { state: 'ready', directory }
        this.afterLoad()
      },
      onError: (error) => {
        if (this.disposed) return
        // A whole-directory failure keeps the picker truthful and editable:
        // one inert Unavailable row carries the reason and saved routes stay
        // removable — but the catalog authority FAILED, so no route is
        // claimed absent and no catalog rows are invented.
        this.catalog = {
          state: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        }
        this.afterLoad()
      },
    })
    this.rebuild()
    this.setMaxRows(this.rowGrant)
  }

  private afterLoad(): void {
    this.loadSettled = true
    this.rebuild()
    this.deps.requestRender()
  }

  /** Re-derive the picker rows from the working copy + directory state.
   *  `setItems` preserves the selected row by VALUE, so an optimistic
   *  toggle or the directory settling never snaps the cursor away. */
  private rebuild(): void {
    const projection = projectSubagentAllowlist({
      catalog: this.catalog,
      allowed: this.allowed,
    })
    this.modelRoutes.clear()
    const items: SearchablePickerItem[] = projection.models.map((row) => {
      const value = allowlistRouteKey(row.providerId, row.modelId)
      this.modelRoutes.set(value, { provider: row.providerId, model: row.modelId })
      const label = row.modelName ?? row.modelId
      const savedNote = row.savedRoute === undefined ? undefined : row.savedRoute === 'absent'
        ? 'saved route not in the current catalog'
        : row.savedRoute === 'catalog-loading'
          ? 'saved route (catalog still loading)'
          : row.savedRoute === 'provider-unavailable'
            ? 'saved route (provider catalog unavailable)'
            : 'saved route (catalog unavailable)'
      return {
        value,
        label,
        ...(savedNote !== undefined
          ? { description: savedNote }
          : row.modelName === undefined || row.modelName === row.modelId ? {} : { description: row.modelId }),
        group: row.savedRoute === undefined ? row.providerName : 'Saved routes',
        groupKey: row.savedRoute === undefined ? row.providerId : SAVED_GROUP_KEY,
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
    // still-loading directory, a settled-but-empty catalog, and a zero-match
    // search are three different messages.
    this.picker.setNoMatchText(!this.loadSettled && items.length === 0
      ? '  Loading models…'
      : items.length === 0 ? '  no models available' : '  No matching models')
    // Initial cursor (plan §12): once the directory load has settled and
    // before ANY real interaction, prefer the first allowed route in catalog
    // order (a saved-but-absent route only when no listed route is allowed),
    // else the first model row. Never lands on a failure row.
    if (!this.cursorPlaced && !this.userInteracted && this.loadSettled) {
      const preferred = projection.models.find(row => row.allowed && row.savedRoute === undefined)
        ?? projection.models.find(row => row.allowed && row.savedRoute === 'absent')
        ?? projection.models.find(row => row.allowed)
        ?? projection.models[0]
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
