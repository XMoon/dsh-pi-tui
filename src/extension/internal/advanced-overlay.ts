/**
 * The AdvancedOverlayComponent (Phase 2, plan §6/§8): the Host-side wrapper
 * that turns a plugin's {@link AdvancedInteractiveComponent} into a
 * mountable pi-tui component. The wrapper is the ONLY bridge between the
 * plugin's interactive state and the physical overlay — the plugin never
 * touches a private component, screen or terminal.
 *
 * Contract:
 * - render() compiles the plugin's render() output through the M4
 *   component kit (Host-owned layout, ANSI, width/wrapping);
 * - handleInput() normalizes raw terminal data through the shared Host
 *   decoder and forwards a SEMANTIC event to the plugin (never raw bytes);
 * - the `focused` setter (the fork's Focusable protocol) fires the
 *   plugin's onFocus/onBlur;
 * - invalidate() recompiles the plugin's render() output (state changes
 *   and terminal resizes reach the screen);
 * - every plugin callback is isolated: a throw is reported (health) and
 *   never escapes into the Host's render/input path.
 * @module @xmoon76/dsh-pi-tui/extension/advanced-overlay
 */

import { Container, type Component, type Focusable } from '@xmoon76/pi-tui'
import type { AdvancedInteractiveComponent, AdvancedRenderContext } from '../advanced-types.ts'
import { compileView } from './component-compiler.ts'
import { normalizeInputEvent } from './input-events.ts'

/** A bounded, whitespace-collapsed error message (the plan's error policy:
 * no stack traces ever reach diagnostics). */
function safeMessage(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200)
  } catch {
    return 'unknown advanced overlay error'
  }
}

/**
 * The mountable wrapper around one plugin interactive component. One
 * instance per physical mount; a fullscreen screen swap re-creates it
 * (the raw handle dies with the old screen).
 */
export class AdvancedOverlayComponent implements Component, Focusable {
  private readonly plugin: AdvancedInteractiveComponent
  /** The live surface context (surfaceId/generation/geometry). */
  private readonly baseContext: () => Omit<AdvancedRenderContext, 'focused'>
  /** Health/diagnostics sink (a throwing plugin callback is reported). */
  private readonly onError: (message: string) => void
  private compiled: { component: Component; isEmpty: boolean }
  private _focused = false
  private disposed = false

  constructor(
    plugin: AdvancedInteractiveComponent,
    baseContext: () => Omit<AdvancedRenderContext, 'focused'>,
    onError: (message: string) => void,
  ) {
    this.plugin = plugin
    this.baseContext = baseContext
    this.onError = onError
    this.compiled = this.compile()
  }

  /** The live render context (focused reflects THIS wrapper's focus). */
  private context(): AdvancedRenderContext {
    return { ...this.baseContext(), focused: this._focused }
  }

  /** Compile the plugin's current render() output (isolated). */
  private compile(): { component: Component; isEmpty: boolean } {
    try {
      return compileView(this.plugin.render(this.context()))
    } catch (error) {
      this.onError(safeMessage(error))
      return { component: new Container(), isEmpty: true }
    }
  }

  /** The fork's Focusable protocol: the TUI sets this on focus changes. */
  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    if (this._focused === value) return
    this._focused = value
    try {
      if (value) this.plugin.onFocus?.()
      else this.plugin.onBlur?.()
    } catch (error) {
      this.onError(safeMessage(error))
    }
  }

  render(width: number): string[] {
    return this.compiled.component.render(width)
  }

  handleInput(data: string): void {
    if (this.disposed) return
    const event = normalizeInputEvent(data)
    if (event === undefined) return
    try {
      this.plugin.handleInput?.(event)
    } catch (error) {
      this.onError(safeMessage(error))
    }
  }

  /** Recompile the plugin's render() output (state change / resize). */
  invalidate(): void {
    if (this.disposed) return
    this.compiled = this.compile()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.plugin.dispose?.()
    } catch (error) {
      this.onError(safeMessage(error))
    }
  }
}
