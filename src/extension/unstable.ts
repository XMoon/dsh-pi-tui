/**
 * The UNSTABLE extension tier entry: `@xmoon76/dsh-pi-tui/extensions/unstable`.
 *
 * Phase-3 surface (plan §1–§15): the first usable Unstable tier — raw
 * input interception (observe/consume/rewrite, exclusive raw ownership),
 * the Host emergency fail-safe, and a selected low-level surface seam.
 * The Unstable tier carries NO compatibility guarantee: implementation
 * may change at any time, and a broken plugin can disrupt Host behavior
 * (shortcuts, input, terminal state). The ONLY Host-owned recovery is
 * the emergency fail-safe (triple-Esc), which the Unstable API cannot
 * rewrite.
 *
 * The facade is a capability facade over the SAME `piTuiExtensions`
 * Cordis service (plan §4): `unstable(service)` returns the Unstable
 * facade without extending the Stable service interface. All resources
 * stay caller-fiber-owned and surface-generation-scoped through the
 * shared Extension Runtime.
 *
 * Third-party plugins import ONLY this entry (and the stable/advanced
 * siblings) — never the stable `./extensions` entry's internals, `TuiApp`,
 * `TuiMainScreen`, `TuiAltScreen` or repository-relative paths.
 * @module @xmoon76/dsh-pi-tui/extensions/unstable
 */

import type {
  UnstableFacade,
  UnstableRawInputSpec,
  UnstableServiceHost,
} from './unstable-types.ts'

export { UNSTABLE_API_LEVEL } from './unstable-types.ts'
export type {
  UnstableFacade,
  UnstableInputFacade,
  UnstableMountedComponent,
  UnstableMountLease,
  UnstableRawCaptureMode,
  UnstableRawInputEvent,
  UnstableRawInputHandle,
  UnstableRawInputResult,
  UnstableRawInputSpec,
  UnstableServiceHost,
  UnstableSurfaceFacade,
  UnstableSurfaceHandle,
} from './unstable-types.ts'
export type { ExtensionTier } from './public-types.ts'

/** The seam members the facade requires at runtime (the concrete service
 * implements them; the public `PiTuiExtensionService` interface does not
 * declare them). */
type UnstableSeam = Required<Pick<
  UnstableServiceHost,
  '_unstableCaptureRaw' | '_unstableSurfaceHandle'
>>

/**
 * Build the UNSTABLE facade over the shared `piTuiExtensions` service
 * (plan §4). The facade is a thin capability view: every resource it
 * creates is caller-fiber-owned and surface-generation-scoped through the
 * service's shared Extension Runtime — never a second plugin system.
 *
 * The parameter is the structural {@link UnstableServiceHost}: a plain
 * `PiTuiExtensionService` value is accepted (the seam members are
 * optional in the type), and the facade throws loudly when the host does
 * not implement the seam (a host/plugin version mismatch).
 * @param service - the `piTuiExtensions` service (from `ctx.get(...)`).
 * @returns the Unstable facade.
 */
export function unstable(service: UnstableServiceHost): UnstableFacade {
  const host = service as UnstableServiceHost & UnstableSeam
  if (host._unstableCaptureRaw === undefined || host._unstableSurfaceHandle === undefined) {
    throw new Error(
      'this piTuiExtensions host does not implement the unstable seam ' +
      '(host/plugin version mismatch? upgrade the host bundle)',
    )
  }
  return {
    input: {
      captureRaw: (spec: UnstableRawInputSpec) => host._unstableCaptureRaw(spec),
    },
    surface: {
      // A GETTER: the handle follows the CURRENT surface attachment (a
      // stale facade keeps working across surface recreate; the handle is
      // inert when no surface is live).
      get handle() {
        return host._unstableSurfaceHandle()
      },
    },
  }
}
