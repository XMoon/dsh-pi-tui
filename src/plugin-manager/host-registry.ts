/**
 * Token-owned active-surface registry for the Plugin Manager (P1-A).
 *
 * ONE manager surface owns the manager at a time across its two entries
 * (`/plugins` and `/settings → Plugins`). The token distinguishes a NORMAL
 * user close (the Close action, or Esc at the root) from an EXTERNAL teardown
 * (the Settings parent overlay being hidden/disposed, which disposes the
 * submenu WITHOUT invoking its `done()`): an external teardown must release
 * the owner but never fake a user close — otherwise a later `/plugins` would
 * wrongly believe the manager is still open and refuse to open.
 *
 * @module @xmoon76/dsh-pi-tui/plugin-manager/host-registry
 */

/** The active-surface claim for one host. */
export interface PluginManagerHostClaim {
  readonly token: object
  /** Release the owner and run the user close path. */
  closeNormally(): void
  /** Release the owner only: the surface was torn down externally. */
  releaseExternally(): void
}

/** Token-owned active-host registry (see the module header). */
export class PluginManagerHostRegistry {
  private active: { readonly token: object; readonly close: () => void } | undefined

  /** Whether any Plugin Manager surface currently owns the manager. */
  isOpen(): boolean {
    return this.active !== undefined
  }

  /** Invoke the ACTIVE surface's user close path (no-op when closed). */
  closeActive(): void {
    this.active?.close()
  }

  /**
   * Claim the manager for one surface. `close` is the surface's user close
   * path (what {@link closeActive} calls); `onNormalClose` runs ONLY for a
   * normal close. A later claim nests over — and restores — the previous owner.
   */
  claim(close: () => void, onNormalClose: () => void = () => {}): PluginManagerHostClaim {
    const token = {}
    const previous = this.active
    this.active = { token, close }
    const restore = (): boolean => {
      if (this.active?.token !== token) return false
      this.active = previous
      return true
    }
    return {
      token,
      closeNormally: () => { if (restore()) onNormalClose() },
      releaseExternally: () => { restore() },
    }
  }
}
