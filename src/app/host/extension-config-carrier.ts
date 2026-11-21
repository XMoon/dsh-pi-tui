/**
 * The profile-owned Config-only carrier row
 * (`@xmoon76/dsh-pi-tui/extension-config`).
 *
 * A third-party npm bundle cannot ship a Settings row that persists a
 * per-package configuration document without also shipping executable Host
 * code: the official Loader row must name a module, and the official Settings
 * service only projects a row whose `Config` schema the running fiber itself
 * declared. This carrier is that ONE trusted module. Every opted-in package
 * declares its own row in its own `dsh.bundle.patch` and points that row at
 * this subpath; the row id is derived from the package name, so two packages
 * mount the same module under two distinct Loader entries and each fiber owns
 * its own `.volatile()` reference.
 *
 * The module owns ONE fact per row: the non-secret JSON `data` document the
 * package chose to persist. It performs no work — it publishes no service,
 * watches nothing, starts no timer, imports no TUI/Agent/Session module and by
 * contract never runs third-party code — so mounting it cannot change native
 * DSH execution semantics or import a package's `./tui` entry.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/extension-config-carrier
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. The Loader row ID is the per-package hash, never this name. */
export const name = 'pi-tui-extension-config'

/** The row's per-package configuration document. */
export interface Config {
  /** Non-secret JSON the owning package persists through the official Settings service. */
  data: unknown
}

/**
 * The Config schema the Loader resolves.
 *
 * `data` is volatile so the official Settings service projects it as a live
 * form field and the Loader commits a saved value into the running reference
 * without remounting the row. No default, no secret role and no business
 * validation: this row is a storage carrier, not a feature schema.
 */
export const Config: z<Config> = z.object({
  data: z.any().volatile(),
}) as unknown as z<Config>

/**
 * No execution: the carrier exists only to give each package's row a Config.
 *
 * @param ctx - the Host context this row is mounted in (unused by contract).
 * @param config - the resolved per-package document (unused by contract).
 */
export function apply(ctx: Context, config: Config): void {
  void ctx
  void config
}
