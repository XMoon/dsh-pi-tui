/**
 * The ADVANCED extension tier entry: `@xmoon76/dsh-pi-tui/extensions/advanced`.
 *
 * Phase-2 surface (plan §4–§10): the first usable Advanced tier —
 * normalized input capture, focused interactive surfaces (interactive
 * managed overlays) and advanced editor control. Advanced plugins still
 * never touch raw terminal bytes, private screens, `TuiApp`, or
 * repository internals: the Host decodes the terminal protocol and owns
 * every physical mount, focus seat and teardown.
 *
 * The facade is a capability facade over the SAME `piTuiExtensions`
 * Cordis service (plan §4): `advanced(service)` returns the Advanced
 * facade without extending the Stable service interface. All resources
 * stay caller-fiber-owned and surface-generation-scoped through the shared
 * Extension Runtime.
 *
 * Third-party plugins import ONLY this entry (and the stable/unstable
 * siblings) — never the stable `./extensions` entry's internals, `TuiApp`,
 * `TuiMainScreen`, `TuiAltScreen` or repository-relative paths.
 * @module @xmoon76/dsh-pi-tui/extensions/advanced
 */

import type {
  AdvancedFacade,
  AdvancedInputCaptureSpec,
  AdvancedInteractiveComponent,
  AdvancedServiceHost,
} from './advanced-types.ts'
import type { TuiOverlayOptions } from './public-types.ts'

export { ADVANCED_API_LEVEL } from './advanced-types.ts'
export type {
  AdvancedEditorControls,
  AdvancedFacade,
  AdvancedFocusHandle,
  AdvancedInputCaptureHandle,
  AdvancedInputCaptureMode,
  AdvancedInputCaptureSpec,
  AdvancedInputEvent,
  AdvancedInputFacade,
  AdvancedInteractiveComponent,
  AdvancedOverlayLease,
  AdvancedRenderContext,
  AdvancedServiceHost,
  AdvancedUiFacade,
} from './advanced-types.ts'
export type { ExtensionTier } from './public-types.ts'

/** The seam members the facade requires at runtime (the concrete service
 * implements them; the public `PiTuiExtensionService` interface does not
 * declare them). */
type AdvancedSeam = Required<Pick<
  AdvancedServiceHost,
  '_advancedCaptureInput' | '_advancedShowInteractiveOverlay' | '_advancedEditorControls'
>>

/**
 * Build the ADVANCED facade over the shared `piTuiExtensions` service
 * (plan §4). The facade is a thin capability view: every resource it
 * creates is caller-fiber-owned and surface-generation-scoped through the
 * service's shared Extension Runtime — never a second plugin system.
 *
 * The facade is safe to call before any surface exists: registrations
 * (input captures) are service-lifetime and attach later; leases
 * (interactive overlays) and the editor controls are inert until a
 * surface is live.
 *
 * The parameter is the structural {@link AdvancedServiceHost}: a plain
 * `PiTuiExtensionService` value is accepted (the seam members are optional
 * in the type), and the facade throws loudly when the host does not
 * implement the seam (a host/plugin version mismatch).
 * @param service - the `piTuiExtensions` service (from `ctx.get(...)`).
 * @returns the Advanced facade.
 */
export function advanced(service: AdvancedServiceHost): AdvancedFacade {
  const host = service as AdvancedServiceHost & AdvancedSeam
  if (host._advancedCaptureInput === undefined
    || host._advancedShowInteractiveOverlay === undefined
    || host._advancedEditorControls === undefined) {
    throw new Error(
      'this piTuiExtensions host does not implement the advanced seam ' +
      '(host/plugin version mismatch? upgrade the host bundle)',
    )
  }
  return {
    input: {
      capture: (spec: AdvancedInputCaptureSpec) => host._advancedCaptureInput(spec),
    },
    ui: {
      showInteractiveOverlay: (component: AdvancedInteractiveComponent, options?: TuiOverlayOptions) =>
        host._advancedShowInteractiveOverlay(component, options),
    },
    // A GETTER: the controls follow the CURRENT surface attachment (a
    // stale facade keeps working across surface recreate).
    get editor() {
      return host._advancedEditorControls()
    },
  }
}
