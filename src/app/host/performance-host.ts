/**
 * The bundle's own Host performance projection row:
 * `@xmoon76/dsh-pi-tui/performance-host`.
 *
 * This is a HOST-plane Cordis plugin, not a TUI module: it registers the
 * `piTuiPerformance` unit on the official session-projection seam and then
 * publishes an empty readiness gate, so a surface that needs the performance
 * authority can declare the ordering dependency instead of silently degrading
 * to a Client-side estimate (plan §3.1 / §4).
 *
 * It imports NO TUI/UI code and no application composition — the Loader row
 * may load it before the surface exists, and `--help` never mounts it.
 *
 * The row is mounted ONCE PER HOST CONTEXT: the Direct profile adds it through
 * `cordis.patch.yml`, and the experimental Remote composition mounts it on its
 * own Host Context (`app/remote/host-runtime.ts`). Registering twice on the
 * SAME Host Context would share one unit (the seam counts registrations) —
 * that is not a supported composition.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/performance-host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { piTuiPerformanceDefinition } from './performance-projection.ts'

/** Stable Cordis plugin name (the Loader row id in `cordis.patch.yml`). */
export const name = 'pi-tui-performance-host'

/** The projection registry is this plugin's whole purpose: without it the fiber stays pending. */
export const inject = ['sessionProjections']

/**
 * The readiness gate this row publishes after the unit is registered. It
 * carries NO data — it is not a second performance authority, only the
 * ordering proof that the Host projection exists before the TUI mounts.
 */
export const PI_TUI_PERFORMANCE_READY_SERVICE = 'piTuiPerformanceReady'

/**
 * Register the `piTuiPerformance` unit and publish the readiness gate.
 *
 * The registry is resolved through the context's reflection layer, the
 * documented Host-plane idiom of this repository (`app/remote/host-runtime.ts`
 * and `app/remote/pi-tui-file-reference-host.ts` do the same): this module IS
 * the Host plane, so its Host-service read is not Client-side coupling and the
 * client-boundary inventory stays unchanged. `inject` above is what guarantees
 * the service is present and active here.
 *
 * @param ctx - the Host context that owns this row's fiber.
 */
export function apply(ctx: Context): void {
  const projections = ctx.reflect.get('sessionProjections') as SessionProjectionRegistry
  projections.register(piTuiPerformanceDefinition)
  ctx.provide(PI_TUI_PERFORMANCE_READY_SERVICE, {})
}
