/**
 * The UnstableMountedComponentAdapter (Phase 3, plan §9 option A): the
 * Host-side wrapper that turns a plugin's {@link UnstableMountedComponent}
 * into a mountable pi-tui component. The plugin renders RAW lines and
 * receives the normalized input sequence (the preHostInput contract —
 * see UnstableRawInputEvent; never raw OS bytes) — the Unstable contract
 * deliberately bypasses the Stable sanitization (the plugin author owns
 * terminal behavior). The Host still owns the physical mount, focus,
 * stacking, fullscreen migration and teardown.
 *
 * Contract:
 * - render() passes the plugin's raw lines through UNCHANGED (no ANSI
 *   sanitization — the Unstable contract; the Host's Stable surfaces keep
 *   their own sanitization and are never affected);
 * - handleInput() forwards the normalized input sequence to the plugin
 *   (never decoded further);
 * - the `focused` setter (the fork's Focusable protocol) tracks focus;
 * - every plugin callback is isolated: a throw is reported (health) and
 *   never escapes into the Host's render/input path.
 * @module @xmoon76/dsh-pi-tui/extension/unstable-mount
 */

import type { Component, Focusable } from '@xmoon76/pi-tui'
import type { UnstableMountedComponent } from '../unstable-types.ts'

/** A bounded, whitespace-collapsed error message (the plan's error policy:
 * no stack traces ever reach diagnostics). */
function safeMessage(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200)
  } catch {
    return 'unknown unstable mount error'
  }
}

/**
 * The mountable wrapper around one plugin low-level component. One
 * instance per physical mount; a fullscreen screen swap re-creates it
 * (the raw handle dies with the old screen).
 */
export class UnstableMountedComponentAdapter implements Component, Focusable {
  private readonly plugin: UnstableMountedComponent
  /** Health/diagnostics sink (a throwing plugin callback is reported). */
  private readonly onError: (message: string) => void
  private _focused = false
  private disposed = false

  constructor(plugin: UnstableMountedComponent, onError: (message: string) => void) {
    this.plugin = plugin
    this.onError = onError
  }

  /** The fork's Focusable protocol: the TUI sets this on focus changes. */
  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    if (this._focused === value) return
    this._focused = value
  }

  /** RAW render passthrough — no sanitization (the Unstable contract). */
  render(width: number): string[] {
    try {
      return this.plugin.render(width)
    } catch (error) {
      this.onError(safeMessage(error))
      return []
    }
  }

  /** Input passthrough — the normalized preHostInput sequence, never
   * decoded further (the Unstable contract). */
  handleInput(data: string): void {
    if (this.disposed) return
    try {
      this.plugin.handleInput?.(data)
    } catch (error) {
      this.onError(safeMessage(error))
    }
  }

  invalidate(): void {
    // The plugin renders fresh lines per frame; nothing is cached here.
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
