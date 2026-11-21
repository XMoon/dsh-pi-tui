/**
 * The canonical profile-owned TUI preference row
 * (`@xmoon76/dsh-pi-tui/preferences`).
 *
 * This row owns ONE durable fact set — the 20 live TUI preferences plus the
 * Host migration marker — and publishes it as the `piTuiPreferences` Cordis
 * service. It is a CONFIG-ONLY carrier: it starts no TUI, Agent, Session,
 * Gateway, timer or watcher. Direct, a Split Host and (through their own
 * profile read) every Remote Client read the SAME canonical row, so the
 * profile patch is the only persistence authority.
 *
 * The `.volatile()` fields are what the official Settings service projects as
 * the `pi-tui-preferences` form section, so `/settings` (and the Remote
 * settings wire) persists them through the ordinary revision-checked user
 * patch and the Loader commits saved values into the running references
 * without remounting. The row is deliberately NOT gated on `tuiStartup`: a
 * Direct process, a Host-only process and even `--help` load the profile and
 * need the canonical authority to settle before any surface reads it.
 *
 * The row hides its AUTO-GENERATED settings page (it would expose the
 * internal migration marker) but keeps `Settings.describe()`/`mutate()`
 * fully readable and writable — `configure({ auto: false })` is presentation
 * policy, not an access control.
 *
 * @module @xmoon76/dsh-pi-tui/app/config/preferences
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreferencesConfig } from './schema.ts'

/** Stable Cordis plugin name (the Loader row id in `cordis.patch.yml`). */
export const name = 'pi-tui-preferences'

/** The profile-wide canonical preference document (also the Settings namespace). */
export { PreferencesConfig as Config } from './schema.ts'

/** The canonical service key every consumer injects. */
export const PI_TUI_PREFERENCES_SERVICE = 'piTuiPreferences'

/**
 * Publish the live preference references and hide the row's auto page.
 *
 * @param ctx - the Host/Direct context this row is mounted in.
 * @param config - the resolved preference document (live volatile references).
 */
export function apply(ctx: Context, config: PreferencesConfig): void {
  ctx.provide(PI_TUI_PREFERENCES_SERVICE, config)
  // The TUI ships its own /settings surface; an auto-generated page would
  // also expose the internal migration marker. This is presentation policy
  // only: describe()/mutate() keep addressing the canonical row.
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
