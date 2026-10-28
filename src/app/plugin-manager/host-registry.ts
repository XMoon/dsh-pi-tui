/**
 * Token-owned active-page registry for the Plugin Manager (P1-A / PR2).
 *
 * The Plugin Manager is hosted by exactly ONE place: the `Settings → Plugins`
 * embedded page inside the Settings workspace lease. This registry fences that
 * single ownership: the Settings root claims the controller when it mounts the
 * page and releases the claim in the page's `onDispose` — never on a focus
 * yield back to the Categories rail (the page keeps its query/selection/scroll
 * and the controller keeps its install request id).
 *
 * The token makes a late release inert: an old page can never release the
 * claim of a newer one. A second claim while a page is still alive is a
 * programming error (the Settings root itself never builds a second page), so
 * it throws synchronously instead of nesting owners.
 *
 * @module @xmoon76/dsh-pi-tui/app/plugin-manager/host-registry
 */

/** The single active-page claim. */
export interface PluginManagerHostClaim {
  /** Release the owner. Idempotent; a stale token never releases a newer claim. */
  release(): void
}

/** Token-owned single-owner registry (see the module header). */
export class PluginManagerHostRegistry {
  private active: object | undefined

  /** Whether the embedded Plugin page currently owns the controller. */
  isOpen(): boolean {
    return this.active !== undefined
  }

  /**
   * Claim the controller for the ONE embedded page. Throws synchronously when
   * a page already owns it: the product allows exactly one owner.
   */
  claim(): PluginManagerHostClaim {
    if (this.active !== undefined) throw new Error('the Plugin Manager already has an owning page')
    const token = {}
    this.active = token
    return {
      release: () => {
        if (this.active === token) this.active = undefined
      },
    }
  }
}
