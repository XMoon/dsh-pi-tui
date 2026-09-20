/**
 * Canonical transcript display presets and their PR2 foundation policy.
 *
 * DisplayPreset is the one runtime vocabulary for presentation state. Compact
 * is intentionally part of the type and policy table before its renderer is
 * available; the availability gate keeps PR2 from claiming a Full renderer is
 * Compact.
 * @module @xmoon76/dsh-pi-tui/display-preset
 */

/** The complete display vocabulary. */
export type DisplayPreset = 'focus' | 'compact' | 'full'

/** The shared mutable display authority passed between the runner, prompt and UI. */
export interface DisplayState {
  preset: DisplayPreset
}

/** Default disclosure depth and behavioral policy for one preset. */
export interface DisplayDisclosurePolicy {
  readonly turnLayer: 'collapsed' | 'open'
  readonly processLayer: 'collapsed' | 'expanded'
  readonly focusBehavior: boolean
}

/** The outcome of attempting to apply one display preset to a surface. */
export type DisplayPresetApplyResult =
  | { readonly kind: 'applied'; readonly preset: DisplayPreset }
  | { readonly kind: 'unchanged'; readonly preset: DisplayPreset }
  | { readonly kind: 'unsupported'; readonly preset: DisplayPreset }

/** The persisted fields used by the one-time legacy migration. */
export interface PersistedDisplayInput {
  readonly displayPreset?: string
  readonly focusMode?: string
}

export type DisplayPresetResolutionSource =
  | 'canonical'
  | 'legacy-focus'
  | 'legacy-full'
  | 'invalid-canonical'
  | 'unsupported-canonical'

/** The resolved runtime preset and whether the canonical field needs writing. */
export interface DisplayPresetResolution {
  readonly preset: DisplayPreset
  readonly canonicalize: boolean
  readonly source: DisplayPresetResolutionSource
}

/** Whether a value is one of the complete display preset names. */
export function isDisplayPreset(value: unknown): value is DisplayPreset {
  return value === 'focus' || value === 'compact' || value === 'full'
}

/** PR2 exposes only presets whose projections already exist. */
export function isDisplayPresetAvailable(preset: DisplayPreset): boolean {
  return preset === 'focus' || preset === 'full'
}

/** Whether a preset enables the model-facing Focus behavioral policy. */
export function isFocusDisplayPreset(preset: DisplayPreset): boolean {
  return preset === 'focus'
}

/** The layered disclosure contract future projections will consume. */
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

/**
 * Resolve the canonical field before the legacy Focus field. A recognized but
 * unavailable Compact value is intentionally pinned to Full rather than kept
 * as a hidden request that could activate after a later upgrade.
 */
export function resolveDisplayPreset(input: PersistedDisplayInput): DisplayPresetResolution {
  if (input.displayPreset !== undefined) {
    switch (input.displayPreset) {
      case 'focus':
      case 'full':
        return { preset: input.displayPreset, canonicalize: false, source: 'canonical' }
      case 'compact':
        return { preset: 'full', canonicalize: true, source: 'unsupported-canonical' }
      default:
        return { preset: 'full', canonicalize: true, source: 'invalid-canonical' }
    }
  }
  if (input.focusMode === 'on') {
    return { preset: 'focus', canonicalize: true, source: 'legacy-focus' }
  }
  return { preset: 'full', canonicalize: true, source: 'legacy-full' }
}
