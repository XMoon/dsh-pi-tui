/**
 * In-place submenu components for `/model`: the model list and the
 * reasoning-effort list render INSIDE the SettingsList's submenu slot
 * (the fork's `SettingItem.submenu` mechanism), so no second overlay is
 * ever mounted. A nested `openSettings` would leave the outer panel
 * mounted beneath the inner one and layered Esc handling — the ghost
 * overlay the `/subagents` flow warns about. Each level's Esc returns to
 * the level above; selecting a model or effort applies it immediately.
 *
 * Async cancellation: the model list and the effort info load as promises
 * that can settle AFTER the user pressed Esc. Each submenu therefore owns
 * a `disposed` latch and an AbortController: every close path funnels
 * through the wrapped `done` callback, which latches disposed, aborts the
 * in-flight load, and only then closes. Every `.then`/`.catch` checks the
 * latch, so a late resolve can never apply a model the user cancelled, a
 * late reject never surfaces a stale error, and a closed menu never
 * triggers a repaint. Providers that ignore the abort signal are still
 * covered by the latch check.
 * @module @xmoon76/dsh-pi-tui/model-menu
 */

import { SettingsList, Text, matchesKey, type Component } from '@xmoon76/pi-tui'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { settingsListTheme } from './theme.ts'

/** The model-service surface `/model` needs, read off the live context. */
export interface ModelMenuServices {
  listModels(providerId: string): Promise<readonly { id: string }[]>
  resolveModelInfo(
    providerId: string,
    modelId: string,
  ): Promise<{ reasoning?: { efforts?: readonly { id: string; name: string; description?: string }[] } }>
}

/** Shared deps threaded through both submenu levels. */
interface SubmenuDeps extends ModelMenuServices {
  /** Commit a selection (model, optional effort) and refresh the footer. */
  apply(selection: ModelSelection): void
  /** Request a frame so the swapped-in list renders. */
  requestRender(): void
  /** Close this submenu level (Esc, or after an applied selection). */
  done(selected?: string): void
  /** Debug diagnostics for late rejections after the menu closed (optional). */
  logDebug?(message: string, fields?: Record<string, unknown>): void
}

/**
 * Wrap a loading/error child so Esc still returns to the parent list while
 * the real content is pending.
 */
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

/**
 * The reasoning-effort picker for one model; applies on selection. Esc or a
 * parent close latches `disposed` and aborts the info load; a resolve or
 * reject that settles afterwards is ignored (debug diagnostics only).
 */
class EffortSubmenu implements Component {
  private inner: Component
  private readonly requestRender: () => void
  /** Latched by every close path; late async results must not act after. */
  private disposed = false
  private readonly abort = new AbortController()
  private readonly logDebug: (message: string, fields?: Record<string, unknown>) => void

  constructor(providerId: string, modelId: string, currentEffort: string | undefined, deps: SubmenuDeps) {
    // Every close path funnels through done(); wrapping it lets the submenu
    // know it is no longer the current flow and abort in-flight loads.
    const close = (selected?: string): void => {
      if (this.disposed) return
      this.disposed = true
      this.abort.abort()
      deps.done(selected)
    }
    const applyAndClose = (effortId: string | undefined): void => {
      // Only a still-current selection flow may commit the model: a late
      // "no effort options" must not override what the user did after Esc.
      if (this.disposed) return
      deps.apply(effortId === undefined || effortId === '__default'
        ? { provider: providerId, model: modelId }
        : { provider: providerId, model: modelId, reasoningEffort: ReasoningEffortId(effortId) })
      close(effortId)
    }
    this.logDebug = deps.logDebug ?? (() => {})
    this.inner = new EscDismiss(new Text('Loading model info…', 0, 0), () => close())
    this.requestRender = deps.requestRender
    void deps.resolveModelInfo(providerId, modelId).then(info => {
      if (this.disposed) return
      const efforts = info.reasoning?.efforts
      if (efforts === undefined || efforts.length === 0) {
        // No effort choice: apply the model directly and return to the list.
        applyAndClose(undefined)
        return
      }
      this.inner = new SettingsList(
        [
          {
            id: '__default',
            label: 'Default',
            description: 'Provider default reasoning effort',
            currentValue: currentEffort === undefined ? '← current' : '',
            values: ['✓'],
          },
          ...efforts.map(effort => ({
            id: effort.id,
            label: effort.name,
            description: effort.description,
            currentValue: currentEffort === effort.id ? '← current' : '',
            values: ['✓'],
          })),
        ],
        6,
        settingsListTheme(),
        (effortId) => applyAndClose(effortId),
        () => close(),
        {},
      )
      this.requestRender()
    }).catch((error: unknown) => {
      // A rejection after the user cancelled is noise, not a user error.
      if (this.disposed) {
        this.logDebug('model info rejected after menu close', {
          provider: providerId,
          model: modelId,
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      // Show the failure in the CURRENT menu; never apply the model on an
      // info error (an error is not "no effort options").
      this.inner = new EscDismiss(new Text('model info unavailable', 0, 0), () => close())
      this.requestRender()
    })
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

/**
 * The model picker for one provider; the `/model` submenu entry. Same
 * cancellation discipline as {@link EffortSubmenu}: a late model list must
 * neither repaint a closed menu nor swap in stale content.
 */
export class ModelSubmenu implements Component {
  private inner: Component
  private readonly requestRender: () => void
  /** Latched by every close path; late async results must not act after. */
  private disposed = false
  private readonly abort = new AbortController()
  private readonly logDebug: (message: string, fields?: Record<string, unknown>) => void

  constructor(providerId: string, currentModel: string, currentEffort: string | undefined, deps: SubmenuDeps) {
    const close = (selected?: string): void => {
      if (this.disposed) return
      this.disposed = true
      this.abort.abort()
      deps.done(selected)
    }
    this.logDebug = deps.logDebug ?? (() => {})
    this.inner = new EscDismiss(new Text('Loading models…', 0, 0), () => close())
    this.requestRender = deps.requestRender
    void deps.listModels(providerId).then(list => {
      if (this.disposed) return
      this.inner = new SettingsList(
        list.map(model => ({
          id: model.id,
          label: model.id,
          description: model.id === currentModel ? '← current' : undefined,
          currentValue: model.id === currentModel ? '← current' : '',
          submenu: (value, done) => new EffortSubmenu(providerId, model.id, currentEffort, { ...deps, done }),
        })),
        6,
        settingsListTheme(),
        () => {},
        () => close(),
        { enableSearch: true },
      )
      this.requestRender()
    }).catch((error: unknown) => {
      // A rejection after the user cancelled is noise, not a user error.
      if (this.disposed) {
        this.logDebug('model list rejected after menu close', {
          provider: providerId,
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      this.inner = new EscDismiss(new Text('models unavailable', 0, 0), () => close())
      this.requestRender()
    })
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
