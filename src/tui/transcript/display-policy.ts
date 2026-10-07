/**
 * Transcript materialization disclosure policy (TS8-D split from the legacy
 * root `src/display-preset.ts`).
 *
 * This is the backend-neutral terminal presentation policy the TuiApp
 * transcript projection consumes: the layered disclosure contract for one
 * preset. The neutral preset vocabulary/state/resolution authority is
 * `src/domain/display/preset.ts`.
 * @module @xmoon76/dsh-pi-tui/tui/transcript/display-policy
 */

import type { DisplayPreset } from '../../domain/display/preset.ts'

/** Default disclosure depth and behavioral policy for one preset. */
export interface DisplayDisclosurePolicy {
  readonly turnLayer: 'collapsed' | 'open'
  readonly processLayer: 'collapsed' | 'expanded'
  readonly focusBehavior: boolean
}

/** The layered disclosure contract every preset projection consumes. */
export function displayPolicyFor(preset: DisplayPreset): DisplayDisclosurePolicy {
  switch (preset) {
    case 'focus':
      return { turnLayer: 'collapsed', processLayer: 'collapsed', focusBehavior: true }
    case 'compact':
      return { turnLayer: 'open', processLayer: 'collapsed', focusBehavior: false }
    case 'full':
      return { turnLayer: 'open', processLayer: 'expanded', focusBehavior: false }
  }
}
