/**
 * In-place submenu components for `/model`: the model list and the
 * reasoning-effort list render INSIDE the SettingsList's submenu slot
 * (the fork's `SettingItem.submenu` mechanism), so no second overlay is
 * ever mounted. A nested `openSettings` would leave the outer panel
 * mounted beneath the inner one and layered Esc handling — the ghost
 * overlay the `/subagents` flow warns about. Each level's Esc returns to
 * the level above; selecting a model or effort applies it immediately.
 * @module @xmoon76/tui-app/model-menu
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

/** The reasoning-effort picker for one model; applies on selection. */
class EffortSubmenu implements Component {
  private inner: Component
  private readonly requestRender: () => void

  constructor(providerId: string, modelId: string, currentEffort: string | undefined, deps: SubmenuDeps) {
    const applyAndClose = (effortId: string | undefined): void => {
      deps.apply(effortId === undefined || effortId === '__default'
        ? { provider: providerId, model: modelId }
        : { provider: providerId, model: modelId, reasoningEffort: ReasoningEffortId(effortId) })
      deps.done(effortId)
    }
    this.inner = new EscDismiss(new Text('Loading model info…', 0, 0), () => deps.done())
    this.requestRender = deps.requestRender
    void deps.resolveModelInfo(providerId, modelId).then(info => {
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
        settingsListTheme,
        (effortId) => applyAndClose(effortId),
        () => deps.done(),
        {},
      )
      this.requestRender()
    }).catch(() => {
      // Info unavailable: fall back to the plain model selection.
      applyAndClose(undefined)
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

/** The model picker for one provider; the `/model` submenu entry. */
export class ModelSubmenu implements Component {
  private inner: Component
  private readonly requestRender: () => void

  constructor(providerId: string, currentModel: string, currentEffort: string | undefined, deps: SubmenuDeps) {
    this.inner = new EscDismiss(new Text('Loading models…', 0, 0), () => deps.done())
    this.requestRender = deps.requestRender
    void deps.listModels(providerId).then(list => {
      this.inner = new SettingsList(
        list.map(model => ({
          id: model.id,
          label: model.id,
          description: model.id === currentModel ? '← current' : undefined,
          currentValue: model.id === currentModel ? '← current' : '',
          submenu: (value, done) => new EffortSubmenu(providerId, model.id, currentEffort, { ...deps, done }),
        })),
        6,
        settingsListTheme,
        () => {},
        () => deps.done(),
        { enableSearch: true },
      )
      this.requestRender()
    }).catch(() => {
      this.inner = new EscDismiss(new Text('models unavailable', 0, 0), () => deps.done())
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
