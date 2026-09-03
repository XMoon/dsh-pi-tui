/**
 * In-place submenu for the official subagent model-selection allowlist
 * (`/settings` → "Subagent allowed models"): a two-level picker rendered
 * INSIDE the SettingsList's submenu slot (the fork's `SettingItem.submenu`
 * mechanism, the `/model` pattern) — no second overlay is ever mounted.
 *
 * Level 1 lists the available providers (the catalog port); Enter opens a
 * provider's models. Level 2 toggles one provider/model route in the
 * OFFICIAL `subagent-model-selection` allowlist, writing the whole
 * section through the config port on every toggle (the Host owns the
 * setting; the TUI never keeps a parallel copy beyond the open panel's
 * snapshot). Rows carry the `← allowed` marker for routes already in the
 * allowlist; Esc returns one level up.
 *
 * The official rule "enabled requires at least one allowed model" is
 * enforced client-side too: removing the LAST route while the section is
 * enabled is refused with a notice (the Host would reject the write
 * anyway — failing fast keeps the panel's markers truthful).
 *
 * Async cancellation follows the model-menu contract: every submenu owns
 * a `disposed` latch and an AbortController; a model list that settles
 * after the user left is dropped.
 * @module @xmoon76/dsh-pi-tui/subagent-model-menu
 */

import { SettingsList, Text, matchesKey, type Component, type RowBudgetAware } from '@xmoon76/pi-tui'
import type { OwnedTaskOptions } from './detached.ts'
import type { SubagentAllowedModelRoute, SubagentModelSelectionConfig } from './runtime/config-port.ts'
import { settingsListTheme } from './theme.ts'

/** The catalog surface the allowlist picker needs (the runtime's model
 * catalog port, read off the live backend). */
export interface AllowlistCatalogServices {
  listProviders(): readonly { id: string; name?: string }[]
  listModels(providerId: string): Promise<readonly { id: string }[]>
}

export interface AllowlistSubmenuDeps {
  /** The official settings sub-domain (read + whole-section writes). */
  selection: SubagentModelSelectionConfig
  /** The provider/model catalog for the picker rows. */
  catalog: AllowlistCatalogServices
  /** Surface notice for refused toggles (never a bare console write). */
  notify(message: string, kind: 'info' | 'error'): void
  /** Request a frame so the swapped-in list renders. */
  requestRender(): void
  /** Close this submenu level (Esc; `selected` rewrites the outer row). */
  done(selected?: string): void
  /** The owned-task entry (runOwned shape): async loads route through it
   * instead of a bare `void promise` (AGENTS.md hard rule). */
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
 * at least one route" rule (removing the last route while enabled). */
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

/** The two-level allowlist picker. */
export class SubagentModelAllowlistSubmenu implements Component {
  private inner: Component
  private readonly requestRender: () => void
  /** Latched by every close path; late async results must not act after. */
  private disposed = false
  private readonly abort = new AbortController()
  /** The working copy of the official allowlist (committed on each
   * toggle; re-synchronized from the section on read). */
  private allowed: readonly SubagentAllowedModelRoute[]
  private readonly enabled: boolean
  /** The live model list (level 2) whose `← allowed` markers are kept in
   * sync through updateValue after each toggle. */
  private modelList: { updateValue(id: string, value: string): void } | undefined
  /** The provider whose models the live list shows (marker re-derivation). */
  private modelListProvider: string | undefined
  /** The model ids of the live list (marker re-derivation). */
  private modelListIds: readonly string[] = []
  /** Serialized whole-section writes: every toggle commits in order, so a
   * slow earlier write can never land after a newer one (the review's
   * concurrent-toggle race). */
  private mutationChain: Promise<void> = Promise.resolve()
  /** The last host row grant, re-applied to each swapped-in inner list. */
  private rowGrant = Number.POSITIVE_INFINITY

  /** Host row-budget seam: keep the grant and forward it to the inner
   * list, so a list swapped in asynchronously after a resize still
   * reflows (the outer SettingsList forwards through this seam). */
  setMaxRows(rows: number): void {
    this.rowGrant = rows
    const inner = this.inner as RowBudgetAware
    inner.setMaxRows?.(rows)
  }

  constructor(deps: AllowlistSubmenuDeps) {
    const current = deps.selection.get()
    this.allowed = current.allowedModels.map(route => ({ ...route }))
    this.enabled = current.enabled
    this.requestRender = deps.requestRender
    const close = (selected?: string): void => {
      if (this.disposed) return
      this.disposed = true
      this.abort.abort()
      deps.done(selected)
    }
    this.inner = this.providerList(deps, close)
    this.setMaxRows(this.rowGrant)
  }

  private providerList(deps: AllowlistSubmenuDeps, close: (selected?: string) => void): Component {
    const providers = deps.catalog.listProviders()
    if (providers.length === 0) {
      return new EscDismissText('no providers configured', close)
    }
    return new SettingsList(
      providers.map(provider => {
        const count = this.allowed.filter(route => route.provider === provider.id).length
        return {
          id: provider.id,
          label: provider.name === undefined || provider.name === '' ? provider.id : provider.name,
          description: provider.id,
          currentValue: count === 0 ? '' : `${count} allowed`,
          // Enter must FIRE (the fork's SettingsList only activates rows
          // that carry values or a submenu); a single inert value keeps the
          // row's display untouched while making Enter open the models.
          values: [''],
        }
      }),
      6,
      settingsListTheme(),
      (providerId) => { this.openProvider(deps, providerId, close) },
      () => close(allowlistSummary(this.allowed)),
      {},
    )
  }

  private openProvider(deps: AllowlistSubmenuDeps, providerId: string, close: (selected?: string) => void): void {
    if (this.disposed) return
    const backToProviders = (): void => {
      if (this.disposed) return
      this.modelList = undefined
      this.modelListProvider = undefined
      this.modelListIds = []
      this.inner = this.providerList(deps, close)
      this.setMaxRows(this.rowGrant)
      this.requestRender()
    }
    this.inner = new EscDismissText('Loading models…', backToProviders)
    deps.runOwned('subagent allowlist models', () => deps.catalog.listModels(providerId), {
      isCancellation: () => this.disposed,
      onResult: (models) => {
        if (this.disposed) return
        if (this.abort.signal.aborted) return
        const list = new SettingsList(
          models.map(model => {
            const allowed = this.allowed.some(route => route.provider === providerId && route.model === model.id)
            return {
              id: model.id,
              label: model.id,
              currentValue: allowed ? '← allowed' : '',
              // Same activation contract as the provider rows: the cycle
              // value is immediately rewritten by the toggle's marker
              // update, so the display stays owned by the allowlist state.
              values: [''],
            }
          }),
          6,
          settingsListTheme(),
          (modelId) => { this.toggle(deps, { provider: providerId, model: modelId }) },
          () => backToProviders(),
          {},
        )
        this.modelList = list
        this.modelListProvider = providerId
        this.modelListIds = models.map(model => model.id)
        this.inner = list
        // The async list lands AFTER any resize: re-apply the last grant.
        this.setMaxRows(this.rowGrant)
        this.requestRender()
      },
      onError: () => {
        if (this.disposed) return
        this.inner = new EscDismissText('models unavailable', backToProviders)
        this.requestRender()
      },
    })
  }

  private toggle(deps: AllowlistSubmenuDeps, route: SubagentAllowedModelRoute): void {
    if (this.disposed) return
    const present = this.allowed.some(existing =>
      existing.provider === route.provider && existing.model === route.model)
    if (present) {
      // Removing the LAST route while enabled would leave the official
      // section invalid; the Host would reject the write, so the toggle is
      // refused before it — the panel's markers stay truthful.
      if (lastRouteWhileEnabled(this.enabled, this.allowed, route)) {
        deps.notify('disable subagent model selection before removing the last route', 'error')
        return
      }
      this.allowed = this.allowed.filter(existing =>
        !(existing.provider === route.provider && existing.model === route.model))
    } else {
      this.allowed = [...this.allowed, route]
    }
    // Optimistic marker for THIS row; the payload is captured NOW (the
    // toggle's intent), and the write is SERIALIZED so a slow earlier
    // write can never land after a newer one. Every settle re-syncs the
    // working copy and ALL visible markers from the committed section, so
    // a rejected write can never leave stale rows behind.
    this.modelList?.updateValue(route.model, present ? '' : '← allowed')
    const payload = this.allowed.map(existing => ({ ...existing }))
    this.mutationChain = this.mutationChain
      .then(() => deps.selection.set({ enabled: this.enabled, allowedModels: payload }))
      .then(
        () => { this.syncFromSection(deps) },
        (error: unknown) => {
          this.syncFromSection(deps)
          // A failure settling AFTER the submenu closed is silent: the
          // outer row already converged to the committed summary, and a
          // late toast would only describe a panel the user left.
          if (!this.disposed) {
            deps.notify(`allowlist write failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
          }
        },
      )
  }

  /** Re-read the committed section and re-derive the working copy plus
   * EVERY visible marker (the current model list and the provider counts
   * rebuild on the next level change). When the submenu is already CLOSED,
   * the outer /settings row must still converge to the COMMITTED summary —
   * the fork's `done()` updates the row without re-opening anything, so a
   * write settling after close can never leave an optimistic count. */
  private syncFromSection(deps: AllowlistSubmenuDeps): void {
    const committed = deps.selection.get().allowedModels
    this.allowed = committed.map(existing => ({ ...existing }))
    if (this.disposed) {
      deps.done(allowlistSummary(this.allowed))
      return
    }
    const provider = this.modelListProvider
    if (provider !== undefined) {
      for (const modelId of this.modelListIds) {
        const allowed = this.allowed.some(route => route.provider === provider && route.model === modelId)
        this.modelList?.updateValue(modelId, allowed ? '← allowed' : '')
      }
    }
    deps.requestRender()
  }

  /** Latch the submenu as closed from OUTSIDE (the /settings overlay
   * teardown calls this — a write pending when the whole panel closes
   * must not repaint or toast after the panel is gone). Idempotent; does
   * NOT report a summary (the panel is closing, not the submenu). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      // Esc on the provider list closes the submenu; a SettingsList inner
      // handles its own Esc (cancel → back one level) before this sees it.
      this.inner.handleInput?.(data)
      return
    }
    this.inner.handleInput?.(data)
  }

  invalidate(): void {
    this.inner.invalidate?.()
  }

  render(width: number): string[] {
    return this.inner.render(width)
  }
}

/** A one-line dismissible message (loading / unavailable states). */
class EscDismissText implements Component {
  private readonly inner: Component

  constructor(message: string, onEsc: () => void) {
    this.inner = new EscDismiss(new Text(message, 0, 0), onEsc)
  }

  handleInput(data: string): void {
    this.inner.handleInput?.(data)
  }

  invalidate(): void {
    this.inner.invalidate?.()
  }

  render(width: number): string[] {
    return this.inner.render(width)
  }
}

/** Wrap a child so Esc returns to the level above while content is pending. */
class EscDismiss implements Component {
  private readonly child: Component
  private readonly onEsc: () => void

  constructor(child: Component, onEsc: () => void) {
    this.child = child
    this.onEsc = onEsc
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.onEsc()
      return
    }
    this.child.handleInput?.(data)
  }

  invalidate(): void {
    this.child.invalidate?.()
  }

  render(width: number): string[] {
    return this.child.render(width)
  }
}
