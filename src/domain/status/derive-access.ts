/**
 * Access status derivation (plan §4.2): the effective permission preset is
 * derived from the official `permissionPresets.current(session)` fold.
 *
 * M6-1 F8: the independent sandbox-mode and approval-policy facts no longer
 * live here — they arrive as PROVEN semantic facts from the ONE
 * session-policy observation owner (`app/command/session-policy-observation
 * .ts`), whose snapshots both Direct and Remote consume. This module keeps no
 * second default rule for those knobs: nothing is guessed from preset names,
 * runner names or platform names, and `custom` is a neutral unmatched
 * combination — never danger.
 *
 * Every seam is session-oriented (alpha.4): no event-log array crosses this
 * boundary, so the module stays free of Host type imports (the boundary gate)
 * while the official services own their own folds.
 * @module @xmoon76/dsh-pi-tui/domain/status/derive-access
 */

import type { AccessStatus } from './types.ts'

/** The official permission-presets service surface (structural). */
export interface PermissionPresetsLike {
  current(session: unknown): string
  optionOf(name: string): { name: string; label?: string }
  /** The composed preset names in cycle order (the `app.permission.cycle`
   *  action). Optional: a read-only derivation never needs them. */
  readonly names?: readonly string[]
  /** Apply one preset to the session (the `app.permission.cycle` action).
   * Optional for the same reason as {@link names}. */
  set?(session: unknown, name: string): void
}

/** The derivation inputs; every service is optional (capability-gated). */
export interface AccessDeriveDeps {
  permissionPresets?: PermissionPresetsLike
}

/**
 * Derive the access section's permission-preset fact from the official
 * service. Every input is optional: a missing service degrades to an absent
 * fact, never a crash. The sandbox/approval facts are NOT derived here (see
 * the module header).
 * @param deps - the service surfaces.
 * @param session - the display subject's live session (opaque; the service
 *   reads it through its own official seam).
 */
export function deriveAccessStatus(deps: AccessDeriveDeps, session?: unknown): AccessStatus {
  const status: {
    permissionPreset?: AccessStatus['permissionPreset']
    sandbox?: AccessStatus['sandbox']
    approval?: AccessStatus['approval']
  } = {}

  const presets = deps.permissionPresets
  if (presets !== undefined && session !== undefined) {
    try {
      const id = presets.current(session)
      const option = presets.optionOf(id)
      status.permissionPreset = {
        id,
        label: option.label ?? option.name,
        matched: id !== 'custom',
      }
    } catch {
      // A throwing preset service degrades to an absent fact.
    }
  }

  return status
}
