/**
 * The profile-owned Web startup preference row
 * (`@xmoon76/dsh-pi-tui/web-preferences`).
 *
 * This row owns ONE durable fact: whether a NEW Split Host should enable the
 * official Web frontend while it boots. It is a Host CONFIGURATION entry, not a
 * runtime Web state: the live `enabled/disabled/changing/unavailable` authority
 * stays `PiTuiWebAccessHostService` (PR-B), and this preference never writes it.
 *
 * The `.volatile()` `autoStart` field is what the official Settings service
 * projects as the `pi-tui-web-preferences` form section, so `/settings` can
 * persist it through the ordinary revision-checked user patch and
 * `local-host-entry.ts` can read it back BEFORE the Host becomes Ready. The row
 * itself performs no work: it publishes no service, watches nothing, starts no
 * timer and — by contract — never enables or disables the Web frontend. The
 * only consumer is the Host cold-boot sequence.
 *
 * The row is deliberately NOT gated on `tuiStartup`: a Direct process loads the
 * same profile and must be able to edit the preference for the Split Host it
 * may later start, so the section must exist in every composition.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/web-preferences
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name (the Loader row id in `cordis.patch.yml`). */
export const name = 'pi-tui-web-preferences'

/**
 * The row's profile-wide preference document.
 *
 * `autoStart` is the NEXT Split Host's cold-boot behavior; it is independent of
 * the CURRENT Host's Web state and is never a second runtime authority. The
 * field is volatile so the official Settings form can project it and the
 * Loader commits a saved value into the running reference.
 */
export interface Config {
  /** Enable the official Web frontend while a new Split Host boots. */
  autoStart: boolean
}

/** The Config schema the Loader resolves (default OFF, live form field). */
export const Config: z<Config> = z.object({
  autoStart: z.boolean().default(false).volatile(),
}) as unknown as z<Config>

/**
 * No execution: the preference is read only by the Host cold-boot sequence.
 *
 * @param ctx - the Host context this row is mounted in (unused by contract).
 * @param config - the resolved preference document (unused by contract).
 */
export function apply(ctx: Context, config: Config): void {
  void ctx
  void config
}
