/**
 * Canonical transcript display presets and their layered disclosure policy.
 *
 * DisplayPreset is the one runtime vocabulary for presentation state. Every
 * preset whose projection exists in this build is available; the availability
 * gate exists so a future preset can never be claimed by another preset's
 * renderer before its own projection ships.
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

/** Every preset whose projection exists in this build ships as available. */
export function isDisplayPresetAvailable(preset: DisplayPreset): boolean {
  return preset === 'focus' || preset === 'compact' || preset === 'full'
}

/** Whether a preset enables the model-facing Focus behavioral policy. */
export function isFocusDisplayPreset(preset: DisplayPreset): boolean {
  return displayPolicyFor(preset).focusBehavior
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

/**
 * Resolve the canonical field before the legacy Focus field. Every recognized
 * preset (Compact included) is canonical as of PR3 and is never rewritten; an
 * unrecognized value falls back to Full.
 */
export function resolveDisplayPreset(input: PersistedDisplayInput): DisplayPresetResolution {
  if (input.displayPreset !== undefined) {
    if (isDisplayPreset(input.displayPreset)) {
      return { preset: input.displayPreset, canonicalize: false, source: 'canonical' }
    }
    return { preset: 'full', canonicalize: true, source: 'invalid-canonical' }
  }
  if (input.focusMode === 'on') {
    return { preset: 'focus', canonicalize: true, source: 'legacy-focus' }
  }
  return { preset: 'full', canonicalize: true, source: 'legacy-full' }
}
